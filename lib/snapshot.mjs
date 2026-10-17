// Live pipeline: Zoho -> statements. One call builds a complete, self-checked "snapshot" of the dashboard's numbers.
//
//   Trial Balance + receivables aging + party-account ledger (+ journals, vendor group)
//     -> computeFS (fsEngine.mjs) -> checks / alerts -> comparison with the audited figures (only on the audited date)
//
// The snapshot is plain JSON (no Maps / Sets), small enough to keep in Redis and to serve to the web page as it is.

import { normalizeTB, checkTB } from './tb.mjs';
import { normalizeARAging } from './receivables.mjs';
import { mapAccounts } from './mapping.mjs';
import { partyAccounts } from './vendors.mjs';
import { normalizeGL, expandMergedRows, mergedTransactionIds, UNTAGGED } from './gl.mjs';
import { ledgerAdvances, advanceModel } from './advances.mjs';
import { r2 } from './util.mjs';
import { computeFS } from './fsEngine.mjs';
import { reconcile } from './reconcile.mjs';
import { fetchTrialBalance, fetchARAging, fetchLedger, fetchVendorGroup, fetchJournals, fetchBills, fetchCustomerBalances, fetchSalesByCustomer, fetchVendorBalances, fetchVendorCodes, fetchInventoryValuation, fetchItemList, fetchJournalsBudget, fetchCwipBills, CWIP_COLUMNS, LoadError } from './zohoData.mjs';
import { ZohoError } from './zoho.mjs';
import { normalizeSplitLedger, journalsNeeded, buildSplit, buildPartySplit, billsNeeded, SPLIT_TOLERANCE } from './splits.mjs';
import { ageingDates, addDays, normalizeCustomerBalances, normalizeSalesByCustomer, normalizeVendorBalances, debtorsAgeing, creditorsAgeing } from './ageing.mjs';
import { normalizeInventoryValuation, buildStock, itemUnitsOf } from './stock.mjs';
import { stockLedgerRows, buildStockLedger, ledgerGapMessage } from './stockLedger.mjs';
import { cwipLedgerRows, cwipJournalsNeeded, cwipBillsNeeded, buildCwip } from './cwip.mjs';
import { fyPeriod } from './config.mjs';
import { istDate, TTL } from './cache.mjs';

export const SNAPSHOT_SCHEMA = 1;

/**
 * Ledger lines -> lines with the right contact. A journal that posts several contacts to one account comes as ONE merged line: it is read journal by journal.
 * A cached journal that no longer matches the ledger was edited in Zoho: it is read again, once.
 */
async function expandLedger(zoho, cache, rows, extra) {
  const txnIds = mergedTransactionIds(rows);
  const first = await fetchJournals(zoho, txnIds, { cache });
  const journals = { ...first.journals };
  let expanded = expandMergedRows(rows, journals);
  const stale = [...new Set(expanded.alerts.filter((a) => a.code === 'GL_JOURNAL_MISMATCH' && first.fromCache.has(a.txnId)).map((a) => a.txnId))];
  let refetched = 0;
  if (stale.length) {
    const again = await fetchJournals(zoho, stale, { cache, fresh: new Set(stale) });
    Object.assign(journals, again.journals);
    refetched = stale.length;
    expanded = expandMergedRows(rows, journals);
  }
  if (first.missing.length) {
    extra.push({ level: 'warn', code: 'GL_JOURNAL_NOT_FOUND', message: `${first.missing.length} journal(s) in the ledger could not be opened in Zoho (${first.missing.slice(0, 3).join(', ')}${first.missing.length > 3 ? ', ...' : ''})` });
  }
  return { expanded, txnIds, first, refetched };
}

/**
 * @param {object} p
 * @param {{get:Function, stats?:{calls:number}, orgId:string}} p.zoho
 * @param {object|null} p.cache        createCache(...) or null (then nothing is cached - journals are always fetched)
 * @param {object} p.config            loadConfig(fy)
 * @param {string} p.fy                e.g. "2025-26"
 * @param {()=>number} [p.now]
 * @param {(msg:string)=>void} [p.log]
 */
export async function buildSnapshot({ zoho, cache = null, config, fy, now = Date.now, log = () => {} }) {
  const started = now();
  const calls0 = zoho.stats?.calls ?? 0;
  const today = istDate(started);
  const period = fyPeriod(fy, today);
  const extra = []; // alerts raised here (the engine adds its own)

  log(`Trial Balance ${period.from} to ${period.to}`);
  const tb = normalizeTB(await fetchTrialBalance(zoho, period));
  if (tb.meta.to && tb.meta.to !== period.to) {
    throw new LoadError(`Zoho returned the Trial Balance up to ${tb.meta.to}, not ${period.to}`, 'TB_DATES');
  }

  // which ledger accounts to read: the party accounts of the live Trial Balance + the known ones (see config/settings.json)
  const { buckets } = mapAccounts(tb.accounts, config.mapping);
  const accountIds = [...new Set([...partyAccounts(buckets).map((a) => a.id), ...(config.settings.party_account_ids ?? [])])];

  // the account(s) of "Advance from debtors": its ledger says, customer by customer, who has paid in advance (see advances.mjs). It is a detail layer: if it
  // cannot be read the statements are still built, and the list of advances then stays as signed on the workbook sheet.
  const advanceAccountIds = (buckets.advance_from_customers?.accounts ?? []).map((a) => a.id);
  const advanceFailed = (e) => { if (e instanceof LoadError) return { error: e }; throw e; };
  // the ageing columns of the Debtors / Creditors Ageing tabs are a detail layer too: a report Zoho refuses (or a date it does not obey) must not stop the statements
  const ageDates = ageingDates({ asOf: period.to, fyFrom: period.from });
  const ageFailed = (e) => { if (e instanceof LoadError || e instanceof ZohoError) return { error: e }; throw e; };
  const ageFetch = (fn) => (ageDates.reason ? Promise.resolve(null) : fn().catch(ageFailed));

  // update-15: the accounts Zoho keeps as one but the signed sheet lists line by line (fixed deposits per bank ...): their ledger, read like the others. A detail layer too.
  const splitIds = config.splits ? [...new Set(Object.values(config.splits.splits ?? {}).map((x) => String(x.account)))] : [];
  const splitFailed = (e) => { if (e instanceof LoadError || e instanceof ZohoError) return { error: e }; throw e; };

  // update-17: the stock summary (Zoho's Inventory Valuation Summary) for the Closing Stock tab - a detail layer too: if it cannot be read, the tab stays as signed
  const stockFailed = (e) => { if (e instanceof LoadError || e instanceof ZohoError) return { error: e }; throw e; };

  // update-18: the ledger of the stock account that does not agree with its items (config/settings.json `stock_ledger_account`, Inventory Asset): what its lines are made of explains the gap
  // (lib/stockLedger.mjs). It is read in step with the stock summary, from the Trial Balance's own account id, and is a detail layer too.
  const stockLedgerName = config.settings.stock_ledger_account ?? null;
  const stockLedgerAccount = stockLedgerName
    ? (buckets.inventory?.accounts ?? []).find((a) => String(a.name).trim().toLowerCase() === String(stockLedgerName).trim().toLowerCase()) ?? null
    : null;

  // update-20: the CWIP tab (park by park) reads the ledger of the two accounts Capital Work in Progress and Intangible Asset Under Development (config/cwip.fyYY.json), and the
  // journals behind it. A detail layer too: if it cannot be read, the tab keeps the signed park table.
  const cwipSpec = config.cwip ?? null;
  const cwipFailed = (e) => { if (e instanceof LoadError || e instanceof ZohoError) return { error: e }; throw e; };

  log('Receivables aging, supplier ledger, customer advances, staff list, the ageing reports and the stock summary');
  const [agingPages, ledgerPages, staffGroup, advancePages, ageNow, ageOpen, ageSales, ageMid, ageEarly, splitPages, stockPages, stockLedgerPages, itemPages, cwipPages] = await Promise.all([
    fetchARAging(zoho, { asOf: period.to }),
    fetchLedger(zoho, { accountIds, from: config.settings.books_start, to: period.to, perPage: config.settings.ledger_page_size }),
    fetchVendorGroup(zoho, config.partyRules.staff.vendor_group),
    advanceAccountIds.length
      ? fetchLedger(zoho, { accountIds: advanceAccountIds, from: config.settings.books_start, to: period.to, perPage: config.settings.ledger_page_size }).catch(advanceFailed)
      : Promise.resolve(null),
    ageFetch(() => fetchCustomerBalances(zoho, { asOf: period.to })),
    ageFetch(() => fetchCustomerBalances(zoho, { asOf: ageDates.openDate })),
    ageFetch(() => fetchSalesByCustomer(zoho, { from: ageDates.windowFrom, to: period.to })),
    // update-14: the first half of the year too (balances on its last day, sales of its days): the journals of each half are told from these (lib/ageing.mjs)
    ageFetch(() => fetchCustomerBalances(zoho, { asOf: ageDates.midDate })),
    ageFetch(() => fetchSalesByCustomer(zoho, { from: addDays(ageDates.openDate, 1), to: ageDates.midDate })),
    splitIds.length
      ? fetchLedger(zoho, { accountIds: splitIds, from: config.settings.books_start, to: period.to, perPage: config.settings.ledger_page_size }).catch(splitFailed)
      : Promise.resolve(null),
    fetchInventoryValuation(zoho, { from: period.from, to: period.to }).catch(stockFailed),
    stockLedgerAccount
      ? fetchLedger(zoho, { accountIds: [String(stockLedgerAccount.id)], from: config.settings.books_start, to: period.to, perPage: config.settings.ledger_page_size }).catch(stockFailed)
      : Promise.resolve(null),
    // update-19: the item list (the unit of each stock item), read in step with the stock summary; a detail layer too
    fetchItemList(zoho).catch(stockFailed),
    // update-20: the ledger of the CWIP and IAUD accounts, with the project / narration / location of each line
    cwipSpec
      ? fetchLedger(zoho, { accountIds: [String(cwipSpec.accounts.cwip.id), String(cwipSpec.accounts.iaud.id)], from: config.settings.books_start, to: period.to, perPage: config.settings.ledger_page_size, columns: CWIP_COLUMNS }).catch(cwipFailed)
      : Promise.resolve(null),
  ]);

  const aging = normalizeARAging(agingPages);
  if (!aging.meta.asOf) {
    aging.meta.asOf = period.to;
    extra.push({ level: 'info', code: 'AGING_DATE_UNVERIFIED', message: `The receivables aging answer does not state its date; ${period.to} was assumed (its total is checked against the Trial Balance)` });
  }
  if (staffGroup.ids.size === 0) {
    extra.push({ level: 'warn', code: 'STAFF_GROUP_EMPTY', message: `Vendor group "${staffGroup.group}" has no members in Zoho; staff are recognised from the employee ledger only` });
  }

  const gl = normalizeGL(ledgerPages);
  const { expanded, txnIds, first, refetched } = await expandLedger(zoho, cache, gl.rows, extra);
  log(`Ledger: ${gl.rows.length} lines; ${txnIds.length} journal(s) read line by line`);

  const party = {
    gl: { rows: expanded.rows },
    rules: config.partyRules,
    overrides: config.partyOverrides,
    staffGroup: staffGroup.ids,
    extraNames: staffGroup.names,
  };

  log('Building the statements');
  const result = computeFS({ tb, mapping: config.mapping, inputs: config.inputs, aging, overrides: config.overrides, party });
  result.alerts.push(...checkTB(tb), ...expanded.alerts, ...extra);

  // update-17: the stock summary, item by item (the Closing Stock tab) and by ledger account against the Trial Balance
  const stock = buildStockSection({ pages: stockPages, items: itemPages, buckets: result.buckets, alerts: result.alerts, ledger: stockLedgerAccount ? { account: stockLedgerAccount, pages: stockLedgerPages } : null });

  // customer advances: ledger of the advance account up to the balance sheet date, less the hand-netting (same list as the receivables)
  let advances = null;
  if (advancePages?.error) {
    result.alerts.push({ level: 'warn', code: 'ADVANCES_UNAVAILABLE', message: `The customer advances could not be read from the ledger (${advancePages.error.message}); the list stays as signed` });
  } else {
    const ag = advancePages ? normalizeGL(advancePages) : { rows: [], meta: { pages: 0 } };
    const adv = advancePages ? await expandLedger(zoho, cache, ag.rows, result.alerts) : { expanded: { rows: [], alerts: [] } };
    result.alerts.push(...adv.expanded.alerts);
    advances = buildAdvances({ rows: adv.expanded.rows, lines: ag.rows.length, receivables: result.receivables, accountIds: advanceAccountIds, buckets: result.buckets, asOf: period.to, alerts: result.alerts });
  }

  // update-15: the split of the deposit accounts (bank by bank ...); like the advances it is a detail layer - if it cannot be read, the sheet compares those lines in total, as before
  const splitRun = splitPages ? await buildSplitsSection({ zoho, cache, spec: config.splits.splits, pages: splitPages, tb, alerts: result.alerts }) : null;
  // ... and the contacts the sheet lists twice (an insurer as advance and as payable ...), split by the ledger account of their entries - from the party ledger already read
  // update-16: an insurer's payable is told apart by the billing-address state of each BILL (HDFC ERGO: Rajasthan / Delhi) - those few bills are read from Zoho (kept 12 hours)
  const billIds = config.splits?.party_splits ? billsNeeded(config.splits.party_splits, expanded.rows) : [];
  const billRun = billIds.length ? await fetchBills(zoho, billIds, { cache }) : null;
  const billsFailed = billRun ? Object.keys(billRun.failed) : [];
  if (billsFailed.length) {
    result.alerts.push({ level: 'warn', code: 'SPLIT_BILLS_UNAVAILABLE', message: `${billsFailed.length} of ${billIds.length} bill(s) could not be read from Zoho (${billRun.failed[billsFailed[0]]}); the payable they make up is compared in total, as before` });
  }
  const partyRun = config.splits?.party_splits ? buildPartySplitsSection({ spec: config.splits.party_splits, rows: expanded.rows, parties: result.suppliers.parties, bills: billRun?.bills ?? {}, alerts: result.alerts }) : null;
  const splits = splitRun || partyRun ? { ...(splitRun?.splits ?? {}), ...(partyRun ?? {}) } : null;

  // update-20: CWIP and IAUD, park by park (lib/cwip.mjs) - the clean-up journals behind the two accounts are read (kept 12 hours, at most `cwip_journal_budget` new ones per run)
  const cwipRun = cwipPages ? await buildCwipSection({ zoho, cache, spec: cwipSpec, pages: cwipPages, tb, alerts: result.alerts, budget: cache ? (config.settings.cwip_journal_budget ?? 100) : Infinity }) : null;

  // Billed / Paid of the Creditors Ageing: Zoho's Vendor Balance Summary for the vendors of that sheet (their ids are known now that the party ledger is read),
  // to the balance sheet date and to the day before the year began; the year is the difference (see lib/ageing.mjs)
  const creditorIds = result.suppliers.parties.filter((p) => CREDITOR_CLASSES.includes(p.class)).map((p) => String(p.id));
  const [vbsNow, vbsOpen] = creditorIds.length
    ? await Promise.all([
      ageFetch(() => fetchVendorBalances(zoho, { ids: creditorIds, from: config.settings.books_start, to: period.to })),
      ageFetch(() => fetchVendorBalances(zoho, { ids: creditorIds, from: config.settings.books_start, to: ageDates.openDate })),
    ])
    : [null, null];

  // update-14: the Vendor Code of each of those vendors, from the vendor's own card (kept in Redis, 40 cards per run until all are known; without Redis every run reads all of them)
  const vendorCodes = creditorIds.length ? await ageFetch(() => fetchVendorCodes(zoho, creditorIds, { cache, now, budget: config.settings.vendor_code_budget ?? (cache ? 40 : 250) })) : null;

  const ageing = buildAgeing({ dates: ageDates, now: ageNow, open: ageOpen, sales: ageSales, mid: ageMid, early: ageEarly, vbsNow, vbsOpen, vendorCodes, receivables: result.receivables, rows: expanded.rows, suppliers: result.suppliers, alerts: result.alerts });

  const audited = config.audited && config.audited.as_at === tb.meta.to ? config.audited : null;
  const rec = audited ? reconcile(result, audited) : null;

  const errors = result.alerts.filter((a) => a.level === 'error').length + result.checks.filter((c) => !c.ok).length;
  const finished = now();
  return {
    schema: SNAPSHOT_SCHEMA,
    meta: {
      org: String(zoho.orgId), fy, from: period.from, to: period.to, asOf: tb.meta.to,
      istDate: today, generatedAt: new Date(finished).toISOString(), durationMs: finished - started,
      apiCalls: (zoho.stats?.calls ?? 0) - calls0,
      ok: errors === 0, errors, warnings: result.alerts.filter((a) => a.level === 'warn').length,
      tb: { basis: tb.meta.basis, accounts: tb.accounts.length, inventoryJobRunning: tb.meta.inventoryJobRunning, zohoGeneratedAt: tb.meta.generatedAt },
      ledger: { lines: gl.rows.length, pages: gl.meta.pages, journalsRead: txnIds.length, journalsFromCache: first.fromCache.size, journalsRefetched: refetched },
      splits: splitRun?.stats ?? null,
      bills: billRun ? { read: billIds.length, fromCache: billRun.fromCache.size, failed: billsFailed.length } : null,
      cwip: cwipRun?.stats ?? null,
      stock: stock.error ? null : { lines: stock.count, held: stock.held, pages: stockPages.length, ledgerLines: stock.ledger?.entries ?? null, itemPages: Array.isArray(itemPages) ? itemPages.length : null, unitLines: stock.unitLines ?? null },
      audited: audited ? { basis: audited.basis, asAt: audited.as_at } : null,
      reconciled: rec ? rec.summary : null,
    },
    statements: { lines: result.lines },
    receivables: result.receivables,
    advances,
    splits,
    cwip: cwipRun?.section ?? null,
    stock,
    ageing,
    suppliers: result.suppliers,
    buckets: result.buckets,
    memo: result.memo,
    checks: result.checks,
    alerts: result.alerts,
    reconciliation: rec,
  };
}

/**
 * The `splits` section of the snapshot (lib/splits.mjs says how): per account of config/splits.fyYY.json its parts - the bank-wise fixed deposits, the three security deposits,
 * the employee / employer share of the PF payable. Each entry is { title, account, name, normal, total, residual, parts[], unassigned[], rows } or { error } (that account's
 * split is then not used and the sheet compares its lines in total). The journals behind the clean-up entries are read (and cached like every journal).
 */
async function buildSplitsSection({ zoho, cache, spec, pages, tb, alerts }) {
  if (pages?.error) {
    alerts.push({ level: 'warn', code: 'SPLITS_UNAVAILABLE', message: `The ledger of the deposit accounts could not be read from Zoho (${pages.error.message}); the lines of BS Grouping that Zoho keeps in one account (fixed deposits, accrued interest, security deposits, PF) are compared in total` });
    return { splits: { error: pages.error.message }, stats: null };
  }
  let rows;
  try { rows = normalizeSplitLedger(pages); } catch (e) {
    alerts.push({ level: 'warn', code: 'SPLITS_UNAVAILABLE', message: `The ledger of the deposit accounts could not be read (${e.message}); those lines of BS Grouping are compared in total` });
    return { splits: { error: e.message }, stats: null };
  }
  // the journals behind the rows that name no bank themselves (the clean-up entries); one read of each, cached like the others
  const ids = [...new Set(Object.values(spec).flatMap((s) => journalsNeeded(s, rows)))];
  let journals = {};
  let fromCache = new Set();
  let missing = [];
  if (ids.length) {
    try {
      const first = await fetchJournals(zoho, ids, { cache });
      journals = { ...first.journals }; fromCache = first.fromCache; missing = first.missing;
    } catch (e) {
      if (!(e instanceof ZohoError)) throw e;
      alerts.push({ level: 'warn', code: 'SPLITS_UNAVAILABLE', message: `The journals behind the deposit accounts could not be read from Zoho (${e.message}); those lines of BS Grouping are compared in total` });
      return { splits: { error: e.message }, stats: null };
    }
  }
  const out = {};
  let refetched = 0;
  for (const [key, s] of Object.entries(spec)) {
    let r = buildSplit(s, rows, journals);
    const old = r.stale.filter((id) => fromCache.has(id)); // cached before update-15 or edited since: read again, once
    if (old.length) {
      try {
        const again = await fetchJournals(zoho, old, { cache, fresh: new Set(old) });
        Object.assign(journals, again.journals);
        refetched += old.length;
        r = buildSplit(s, rows, journals);
      } catch (e) { if (!(e instanceof ZohoError)) throw e; }
    }
    const acc = tb.accounts.find((a) => a.id === String(s.account));
    const tbValue = acc ? Math.abs(acc.closing) : 0;
    if (Math.abs(Math.abs(r.total) - tbValue) > SPLIT_TOLERANCE) {
      out[key] = { error: `the ledger adds up to ${r2(Math.abs(r.total))}, the Trial Balance says ${r2(tbValue)}` };
      alerts.push({ level: 'warn', code: 'SPLIT_LEDGER_MISMATCH', message: `${s.title ?? s.name}: the ledger of the account adds up to ${r2(Math.abs(r.total))} but the Trial Balance says ${r2(tbValue)}; its lines are compared in total` });
      continue;
    }
    out[key] = { title: s.title ?? s.name, account: String(s.account), name: s.name, normal: s.normal, total: r.total, residual: r.residual, parts: r.parts, unassigned: r.unassigned, rows: r.rows };
    if (r.unassigned.length) {
      const sum = r.unassigned.reduce((t, u) => t + Math.abs(u.amount), 0);
      alerts.push({ level: 'info', code: 'SPLIT_UNASSIGNED', message: `${s.title ?? s.name}: ${r.unassigned.length} ledger entr${r.unassigned.length === 1 ? 'y' : 'ies'} (${r2(sum)}) name no bank / line (${r.unassigned.slice(0, 3).map((u) => u.entry).join(', ')}${r.unassigned.length > 3 ? ', ...' : ''}); ${r.unassigned.length === 1 ? 'it is' : 'they are'} compared in total with the lines that matched nothing` });
    }
  }
  if (missing.length) alerts.push({ level: 'warn', code: 'SPLIT_JOURNAL_NOT_FOUND', message: `${missing.length} journal(s) behind the deposit accounts could not be opened in Zoho (${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ', ...' : ''}); their amounts are compared in total` });
  return { splits: out, stats: { rows: rows.length, journalsRead: ids.length, journalsFromCache: ids.filter((id) => fromCache.has(id)).length, journalsRefetched: refetched } };
}

/**
 * update-20: the `cwip` section of the snapshot (lib/cwip.mjs says how): the ledger of Capital Work in Progress and Intangible Asset Under Development, every line given its park
 * from the words of its journal (the old ledger it was moved from) or of its bill (project, narration, location). A detail layer: if the ledger cannot be read, or does not add up to
 * the Trial Balance, the section is { error } and the CWIP tab keeps the signed park table. A run reads at most `budget` journals and bills that are not in the cache; until all are known the
 * section says so (`complete: false`) and the tab does not use it.
 * update-22: Zoho's ledger report adds up the lines of one bill that go to the same account, so the bills are read too (first, they are few: a line of the bill carries its own project) and a
 * collapsed ledger line is put back into the bill's own lines. A bill that cannot be read is not an error: its ledger line stays as the ledger gives it (and an alert says so).
 */
async function buildCwipSection({ zoho, cache, spec, pages, tb, alerts, budget }) {
  const off = (message, why) => {
    alerts.push({ level: 'warn', code: 'CWIP_UNAVAILABLE', message });
    return { section: { error: why }, stats: null };
  };
  if (pages?.error) return off(`The ledger of the CWIP and IAUD accounts could not be read from Zoho (${pages.error.message}); the CWIP tab stays as signed`, pages.error.message);
  let rows;
  try { rows = cwipLedgerRows(pages); } catch (e) { return off(`The ledger of the CWIP and IAUD accounts could not be used (${e.message}); the CWIP tab stays as signed`, e.message); }
  const wanted = new Set([String(spec.accounts.cwip.id), String(spec.accounts.iaud.id)]);
  const stray = rows.find((r) => !wanted.has(r.accountId));
  if (stray) return off('Zoho ignored the account filter on the ledger of the CWIP and IAUD accounts (a line of another account came back); the CWIP tab stays as signed', 'the account filter was ignored');

  // the bills first (a bill with several lines for one account is only known from the bill itself), then the journals with what is left of the budget
  const billIds = cwipBillsNeeded(rows);
  const billRun = await fetchCwipBills(zoho, billIds, { cache, budget, ttl: TTL.cwipBill });
  const bills = { ...billRun.bills };
  const failedBills = { ...billRun.failed };

  const ids = cwipJournalsNeeded(rows);
  let first;
  try { first = await fetchJournalsBudget(zoho, ids, { cache, budget: budget - billRun.fetched, ttl: TTL.cwipJournal }); } catch (e) {
    if (!(e instanceof ZohoError)) throw e;
    return off(`The journals behind the CWIP and IAUD accounts could not be read from Zoho (${e.message}); the CWIP tab stays as signed`, e.message);
  }
  const journals = { ...first.journals };
  const build = (more = []) => buildCwip(spec, rows, journals, tb, { pending: [...billRun.pending, ...first.pending, ...more], bills });
  let r = build();
  // a cached journal that was edited since (or cached before its notes were kept) no longer fits its ledger line, and a cached bill that no longer adds up to its ledger line is out of date too: read again, once
  const old = (r.stale ?? []).filter((id) => first.fromCache.has(id));
  const oldBills = (r.billsUnfit ?? []).filter((id) => billRun.fromCache.has(id));
  let refetched = 0;
  let billsRefetched = 0;
  let againPending = [];
  if (oldBills.length) {
    const again = await fetchCwipBills(zoho, oldBills, { cache, fresh: new Set(oldBills), ttl: TTL.cwipBill });
    Object.assign(bills, again.bills);
    Object.assign(failedBills, again.failed);
    billsRefetched = again.fetched;
  }
  if (old.length) {
    try {
      const again = await fetchJournalsBudget(zoho, old, { cache, fresh: new Set(old), budget, ttl: TTL.cwipJournal });
      Object.assign(journals, again.journals);
      refetched = Object.keys(again.journals).length;
      againPending = again.pending;
    } catch (e) { if (!(e instanceof ZohoError)) throw e; }
  }
  if (oldBills.length || old.length) r = build(againPending);
  if (r.error) {
    alerts.push({ level: 'warn', code: 'CWIP_LEDGER_MISMATCH', message: `CWIP / IAUD: ${r.error}; the CWIP tab stays as signed` });
    return { section: { error: r.error }, stats: null };
  }
  const nFailed = Object.keys(failedBills).length;
  if (first.missing.length) alerts.push({ level: 'warn', code: 'CWIP_JOURNAL_NOT_FOUND', message: `${first.missing.length} journal(s) behind the CWIP and IAUD accounts could not be opened in Zoho (${first.missing.slice(0, 3).join(', ')}${first.missing.length > 3 ? ', ...' : ''}); their lines are left out of the parks` });
  if (nFailed > 0 && !r.pending) alerts.push({ level: 'info', code: 'CWIP_BILL_UNREAD', message: `CWIP tab: ${nFailed} bill(s) behind the CWIP and IAUD accounts could not be read from Zoho (${Object.values(failedBills)[0]}); their lines stay as Zoho's ledger gives them, one line per bill and account, so a bill for several parks is placed by one project only` });
  if (r.billsUnfit.length > 0 && !r.pending) alerts.push({ level: 'info', code: 'CWIP_BILL_UNFIT', message: `CWIP tab: ${r.billsUnfit.length} bill(s) have lines that no longer add up to their ledger line (${r.billsUnfit.slice(0, 3).join(', ')}); their ledger lines stay as they are` });
  if (r.pending > 0) alerts.push({ level: 'info', code: 'CWIP_PARTIAL', message: `CWIP tab: ${ids.length + billIds.length - r.pending} of ${ids.length + billIds.length} journals and bills behind the two accounts read so far; the rest follow on the next refresh (until then the park table stays as signed)` });
  if (r.unnamedCount > 0) alerts.push({ level: 'info', code: 'CWIP_UNNAMED', message: `CWIP tab: ${r.unnamedCount} ledger line(s) (net ${r.unnamedSum}) name no park in Zoho and are in no park's total` });
  if (r.pinsMissing.length && !r.pending) alerts.push({ level: 'info', code: 'CWIP_ALLOCATION_NOT_FOUND', message: `CWIP tab: ${r.pinsMissing.length} allocation(s) of config/cwip.fyYY.json found no ledger line (${r.pinsMissing.slice(0, 3).join(', ')}): the ledger changed since they were written` });
  return {
    section: { ...r, billsUnread: nFailed },
    stats: {
      rows: rows.length, journals: ids.length, journalsFromCache: ids.filter((id) => first.fromCache.has(id)).length, journalsFetched: first.fetched, journalsRefetched: refetched,
      bills: billIds.length, billsFromCache: billIds.filter((id) => billRun.fromCache.has(id)).length, billsFetched: billRun.fetched, billsRefetched, billsFailed: nFailed, billsSplit: r.billSplits.length,
      pending: r.pending,
    },
  };
}

/**
 * update-17: the `stock` section of the snapshot (lib/stock.mjs says how): Zoho's Inventory Valuation Summary item by item, and by ledger account against the Trial Balance.
 * A detail layer: if the report cannot be read (or its pages do not add up to its own total) the section is { error } and the Closing Stock tab stays as signed.
 */
export function buildStockSection({ pages, items = undefined, buckets, alerts, ledger = null }) {
  const fail = (why) => {
    alerts.push({ level: 'warn', code: 'STOCK_UNAVAILABLE', message: `Zoho's stock summary could not be used (${why}); the Closing Stock tab stays as signed` });
    return { error: why };
  };
  if (pages?.error) return fail(pages.error.message);
  // update-19: the unit of each item, from Zoho's item list (`items` undefined = the list was not asked for, as in a copy made before update-19: no alert, the column stays as signed)
  let units = null;
  let unitsError = null;
  if (items?.error) unitsError = items.error.message;
  else if (items) { try { units = itemUnitsOf(items); } catch (e) { unitsError = e.message; } }
  let built;
  try {
    built = buildStock(normalizeInventoryValuation(pages), buckets, alerts, units);
  } catch (e) { return fail(e.message); }
  if (built.error) return fail(built.error);
  if (units) {
    built.unitLines = built.lines.filter((l) => l.unit).length;
    if (built.unitLines < built.lines.length) {
      alerts.push({ level: 'info', code: 'STOCK_UNITS_PARTIAL', message: `Zoho's item list gives a unit for ${built.unitLines} of the ${built.lines.length} stock lines; the Usage unit of the others stays as signed` });
    }
  } else if (unitsError) {
    built.unitsError = unitsError;
    alerts.push({ level: 'info', code: 'STOCK_UNITS_UNAVAILABLE', message: `Zoho's item list could not be used for the Usage unit (${unitsError}); that column of the Closing Stock tab stays as signed` });
  }
  // update-18: what the ledger of the account that disagrees with its items is made of. A detail layer: without it the tab shows the gap, not what it is made of.
  if (ledger) built.ledger = buildLedgerPart({ built, ledger, alerts });
  return built;
}

/** update-18: the `ledger` part of the stock section ({ error } when the ledger could not be read or does not add up to the Trial Balance; the alert says why). */
function buildLedgerPart({ built, ledger, alerts }) {
  const name = ledger.account.name;
  const lose = (why) => {
    alerts.push({ level: 'info', code: 'STOCK_LEDGER_UNAVAILABLE', message: `The ledger of ${name} could not be used to explain the stock gap (${why})` });
    return { error: why };
  };
  if (ledger.pages?.error) return lose(ledger.pages.error.message);
  try {
    const row = built.byAccount.find((r) => String(r.name).trim().toLowerCase() === String(name).trim().toLowerCase());
    const tb = Number(ledger.account.closing);
    const items = row?.items ?? 0;
    const made = buildStockLedger(stockLedgerRows(ledger.pages), { name, id: ledger.account.id, tb: row?.tb ?? tb, items });
    if (made.error) return lose(made.error);
    if (Math.abs(made.gap) > 1) alerts.push({ level: 'info', code: 'STOCK_GAP_EXPLAINED', message: ledgerGapMessage(made) });
    return made;
  } catch (e) { return lose(e.message); }
}

/**
 * update-15: the contacts of config/splits.fyYY.json `party_splits` (HDFC ERGO, ICICI Lombard, RPE Energy Reserve), each split by the ledger account of its entries (lib/splits.mjs).
 * update-16: HDFC ERGO's payable is split again by the billing-address state of its bills (`bills` = the bills read from Zoho, see fetchBills); a bill that could not be read stays in `residual`.
 * Same shape as the other splits - { title, contact, name, total, residual, parts[], unassigned[], rows } or { error } (the sheet then compares the contact's one balance, as before).
 */
export function buildPartySplitsSection({ spec, rows, parties, bills = {}, alerts }) {
  const out = {};
  for (const [key, s] of Object.entries(spec)) {
    const title = s.title ?? s.name;
    const party = parties.find((p) => String(p.id) === String(s.contact));
    if (!party) { out[key] = { error: `${s.name} has no balance in the supplier accounts` }; continue; }
    const r = buildPartySplit(s, rows, bills);
    if (Math.abs(r.total - party.net) > SPLIT_TOLERANCE) {
      out[key] = { error: `the ledger of the contact adds up to ${r2(r.total)}, the supplier list says ${r2(party.net)}` };
      alerts.push({ level: 'warn', code: 'SPLIT_LEDGER_MISMATCH', message: `${title}: the entries of ${s.name} add up to ${r2(r.total)} but its balance is ${r2(party.net)}; its lines are compared in total` });
      continue;
    }
    if (r.wrongSide.length) {
      out[key] = { error: `${r.wrongSide.join(', ')} is on the other side of the ledger than the sheet shows it` };
      alerts.push({ level: 'info', code: 'SPLIT_WRONG_SIDE', message: `${title}: ${r.wrongSide.join(', ')} is on the other side of the ledger than the sheet shows it; the lines of ${s.name} are compared in total` });
      continue;
    }
    out[key] = { title, contact: String(s.contact), partyName: party.name, name: s.name, total: r.total, residual: r.residual, parts: r.parts, unassigned: r.unassigned, rows: r.rows };
  }
  return out;
}

/** The vendors of the Creditors Ageing sheet: the supplier classes it lists (see config/workbook.fyYY/index.json, sheet creditors-ageing). */
export const CREDITOR_CLASSES = ['trade_payable', 'trade_payable_msme', 'retention'];

/**
 * The `ageing` section of the snapshot (lib/ageing.mjs says how): per customer and per vendor the figures the ageing sheets hold, worked out from Zoho.
 * `problems.debtors` / `problems.creditors` say why a part is missing; the tab then keeps its signed figures and shows that sentence.
 */
function buildAgeing({ dates, now, open, sales, mid, early, vbsNow, vbsOpen, vendorCodes, receivables, rows, suppliers, alerts }) {
  const out = { asOf: dates.asOf, openDate: dates.openDate, windowFrom: dates.windowFrom, debtors: null, creditors: null, problems: {} };
  if (dates.reason) {
    out.problems.debtors = dates.reason;
    out.problems.creditors = dates.reason;
    alerts.push({ level: 'info', code: 'AGEING_YEAR_END_ONLY', message: dates.reason });
    return out;
  }
  const staysAsSigned = { debtors: 'the Debtors Ageing columns that need it stay as signed', creditors: 'the Creditors Ageing columns that need it stay as signed', vbs: 'Billed Amount and Paid Amount of the Creditors Ageing stay as signed', codes: 'the Vendor Code column of the Creditors Ageing stays as signed' };
  const fail = (which, why, level = 'warn') => {
    out.problems[which] = why;
    alerts.push({ level, code: `AGEING_${which.toUpperCase()}_UNAVAILABLE`, message: `${why}; ${staysAsSigned[which]}` });
  };
  // Billed / Paid: the Vendor Balance Summary at both ends of the year (null = not asked for: no vendors)
  let vbs = null;
  const badVbs = [vbsNow, vbsOpen].find((x) => x?.error);
  if (badVbs) fail('vbs', `Billed and Paid could not be read from Zoho's Vendor Balance Summary (${badVbs.error.message})`);
  else if (vbsNow && vbsOpen) {
    try {
      const z = { now: normalizeVendorBalances(vbsNow), open: normalizeVendorBalances(vbsOpen) };
      if (z.now.asOf && z.now.asOf !== dates.asOf) throw new Error(`the vendor balances are as of ${z.now.asOf}, not ${dates.asOf}`);
      if (z.open.asOf && z.open.asOf !== dates.openDate) throw new Error(`the opening vendor balances are as of ${z.open.asOf}, not ${dates.openDate}`);
      vbs = z;
    } catch (e) { fail('vbs', `Billed and Paid could not be worked out from Zoho's Vendor Balance Summary (${e.message})`); }
  }
  // creditors: the party ledger is already read
  try {
    out.creditors = { ...creditorsAgeing(rows, suppliers.parties, CREDITOR_CLASSES, dates.openDate, vbs), openDate: dates.openDate, vbs: vbs ? { asOf: dates.asOf, openDate: dates.openDate } : null };
  } catch (e) { fail('creditors', `The creditors ageing could not be worked out (${e.message})`); }
  // the Vendor Code of each vendor (a vendor whose card has not been read yet has none: its code is simply not compared)
  if (out.creditors && vendorCodes) {
    if (vendorCodes.error) fail('codes', `The Vendor Codes could not be read from Zoho (${vendorCodes.error.message})`);
    else {
      let known = 0;
      for (const v of out.creditors.vendors) if (typeof vendorCodes.codes[v.id] === 'string') { v.code = vendorCodes.codes[v.id]; known += 1; }
      const total = out.creditors.vendors.length;
      if (known) out.creditors.codes = { known, total, fetched: vendorCodes.fetched, fromCache: vendorCodes.fromCache, pending: vendorCodes.pending.length };
      else fail('codes', vendorCodes.stopped ? `Zoho stopped answering before any Vendor Code was read (${vendorCodes.stopped})` : 'No Vendor Code could be read from Zoho yet');
      if (vendorCodes.stopped && known) alerts.push({ level: 'warn', code: 'AGEING_VENDOR_CODES_STOPPED', message: `Zoho stopped answering while the Vendor Codes were read (${vendorCodes.stopped}); ${known} of ${total} vendors have their code, the rest follow on the next refresh` });
      else if (known && (vendorCodes.pending.length || vendorCodes.failed.length)) alerts.push({ level: 'info', code: 'AGEING_VENDOR_CODES_PARTIAL', message: `Vendor Codes: ${known} of ${total} vendors read from their cards in Zoho so far (${vendorCodes.fetched} this time); the rest follow on the next refreshes` });
    }
  }
  // debtors: three reports
  const bad = [now, open, sales].find((x) => x?.error);
  if (bad) { fail('debtors', `The debtors ageing could not be read from Zoho (${bad.error.message})`); return out; }
  // update-14: the first half of the year, which tells the journal debits apart (without it the debtors are aged by invoices only; the statements are not touched)
  let half = {};
  const badHalf = [mid, early].find((x) => x?.error);
  const noJournals = (why) => {
    out.problems.journals = why;
    alerts.push({ level: 'warn', code: 'AGEING_JOURNALS_UNAVAILABLE', message: `${why}; the debtors are aged by invoices only, so a manual journal that debits a customer is not told from the invoices (Less than 6M, 6 Month to 1 Year and the older columns may differ for such customers)` });
  };
  if (badHalf) noJournals(`The first half of the year could not be read from Zoho (${badHalf.error.message})`);
  else if (mid && early) {
    try {
      const h = { mid: normalizeCustomerBalances(mid), early: normalizeSalesByCustomer(early) };
      if (h.mid.asOf && h.mid.asOf !== dates.midDate) throw new Error(`the balances are as of ${h.mid.asOf}, not ${dates.midDate}`);
      half = h;
    } catch (e) { noJournals(`The first half of the year could not be worked out from Zoho's reports (${e.message})`); }
  }
  try {
    const z = { now: normalizeCustomerBalances(now), open: normalizeCustomerBalances(open), window: normalizeSalesByCustomer(sales), ...half };
    if (z.now.asOf && z.now.asOf !== dates.asOf) throw new Error(`the customer balances are as of ${z.now.asOf}, not ${dates.asOf}`);
    if (z.open.asOf && z.open.asOf !== dates.openDate) throw new Error(`the opening balances are as of ${z.open.asOf}, not ${dates.openDate}`);
    const d = debtorsAgeing(receivables.customers ?? [], z);
    const lost = d.missing.reduce((t, m) => t + m.receivable, 0);
    if (d.missing.length) {
      alerts.push({ level: 'warn', code: 'AGEING_CUSTOMER_MISSING', message: `${d.missing.length} customer(s) with a receivable (${r2(lost)}) are not in Zoho's customer balance summary and are left out of the ageing (${d.missing.slice(0, 3).map((m) => m.name).join('; ')}${d.missing.length > 3 ? '; ...' : ''})` });
    }
    out.debtors = { customers: d.customers, missing: d.missing, totals: d.totals, openDate: dates.openDate, windowFrom: dates.windowFrom, journals: d.journals };
  } catch (e) { fail('debtors', `The debtors ageing could not be worked out (${e.message})`); }
  return out;
}

/** The `advances` section of the snapshot: one line per customer with an advance, and the checks that tie it to the Trial Balance and to the statements. */
function buildAdvances({ rows, lines, receivables, accountIds, buckets, asOf, alerts }) {
  const led = ledgerAdvances(rows, { asOf });
  const model = advanceModel(led.customers, receivables.customers ?? []);
  const tbClosing = -(buckets.advance_from_customers?.accounts ?? []).reduce((t, a) => t + a.closing, 0); // a credit is negative in the Trial Balance
  const plug = receivables.advanceFromCustomers;
  if (accountIds.length && Math.abs(led.total - tbClosing) > 1) {
    alerts.push({ level: 'warn', code: 'ADVANCE_LEDGER_TIE', message: `The ledger of the advance account adds up to ${r2(led.total)} but the Trial Balance says ${r2(tbClosing)}; the customer list may be incomplete` });
  }
  if (Math.abs(model.total - plug) > 5) {
    alerts.push({ level: 'warn', code: 'ADVANCE_TOTAL', message: `Advances customer by customer add up to ${r2(model.total)} but the statements show ${r2(plug)}` });
  }
  const real = model.customers.filter((c) => c.id !== UNTAGGED);
  const negative = model.negative.filter((c) => c.id !== UNTAGGED);
  if (negative.length) {
    alerts.push({ level: 'warn', code: 'ADVANCE_NEGATIVE', message: `${negative.length} customer(s) have more hand-netting than advance (${negative.slice(0, 3).map((c) => `${c.name} ${r2(c.advance)}`).join('; ')}${negative.length > 3 ? '; ...' : ''})` });
  }
  const customers = real.filter((c) => c.advance > 0.005).map((c) => ({ id: c.id, name: c.name, ledger: r2(c.ledger), adjustment: r2(c.adjustment), credit: r2(c.credit), advance: r2(c.advance) }));
  return {
    asOf, accountIds, ledgerLines: lines,
    ledgerTotal: r2(led.total), tbClosing: r2(tbClosing), total: r2(model.total), plug: r2(plug),
    netted: r2(model.nettedTotal), credit: r2(model.creditTotal),
    untagged: r2(model.customers.filter((c) => c.id === UNTAGGED).reduce((t, c) => t + c.advance, 0)),
    unnamed: customers.filter((c) => c.name === c.id).length,
    customers,
  };
}

/**
 * Build and store (what the morning job and the "refresh" button run). A lock keeps two refreshes from running at once.
 * @returns {Promise<{busy:true}|{snapshot:object, stored:object|null}>}
 */
export async function refreshSnapshot({ zoho, cache, config, fy, now, log, lockSeconds = 600 }) {
  if (cache && !(await cache.acquireLock('refresh', lockSeconds))) return { busy: true };
  try {
    const snapshot = await buildSnapshot({ zoho, cache, config, fy, now, log });
    const stored = cache ? await cache.putSnapshot(snapshot) : null;
    return { snapshot, stored };
  } finally {
    if (cache) await cache.releaseLock('refresh').catch(() => {});
  }
}
