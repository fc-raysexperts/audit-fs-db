// The whole live pipeline, with Zoho replaced by the saved FY26 snapshots and Redis by a fake. Skipped without fixtures/.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot, refreshSnapshot } from '../lib/snapshot.mjs';
import { loadConfig } from '../lib/config.mjs';
import { liveOverlay, readSheet } from '../lib/workbook.mjs';
import { createUpstash, createCache } from '../lib/cache.mjs';
import { fetchLedger, LoadError } from '../lib/zohoData.mjs';
import { mergedTransactionIds, normalizeGL } from '../lib/gl.mjs';
import { normalizeTB } from '../lib/tb.mjs';
import { normalizeARAging } from '../lib/receivables.mjs';
import { fakeUpstash, replayZoho, haveFixtures, J } from '../testing/fakes.mjs';
import fs from 'node:fs';

const skip = !haveFixtures();
const config = loadConfig('2025-26');
const NOW = Date.parse('2026-10-15T06:30:00+05:30');
const FY = '2025-26';
const withCache = () => {
  const f = fakeUpstash({ clock: { t: NOW } });
  return { f, cache: createCache(createUpstash({ url: 'https://x.upstash.io', token: f.token, fetchImpl: f.fetchImpl }), { org: '60038956413', now: () => f.clock.t }) };
};
const journalCount = () => Object.keys(J('fixtures/gl/journals_merged.json')).length;
const STOCK_PAGES = 5; // update-17: Zoho's stock summary at 31-Mar-2026 has 819 item lines = 5 pages of 200
const STOCK_LEDGER_PAGES = 4; // update-18: the ledger of Inventory Asset has 6,504 lines = 4 pages of 2000
const ITEM_PAGES = 5; // update-19: the item list (active and inactive: the unit of each stock item) has 822 items in the replay = 5 pages of 200
const billCount = () => Object.keys(J('fixtures/bills_fy26.json').bills).length; // update-16: the four bills of HDFC ERGO
const splitJournalCount = () => Object.keys(J('fixtures/splits_fy26.json').journals).length; // update-15: the clean-up journals behind the deposit accounts
const cwipJournalCount = () => Object.keys(J('fixtures/cwip_fy26.json').journals).length; // update-20: the journals behind the CWIP and IAUD ledgers (137)
const cwipBillCount = () => new Set(Object.values(J('fixtures/cwip_fy26.json').groups).flatMap((g) => g.rows).filter((r) => r.transaction_type === 'bill').map((r) => r.transaction_id)).size; // update-22: the bills behind the two accounts (35)
const RELATED_CALLS = 3; // update-27: the related parties - Sales by Customer for 4 customers, the ledger of 10 vendor cards (bills and vendor credits), the ledgers of the 6 loan / remuneration / foreign-supplier accounts (1 page each)
const REGISTER_CALLS = 4; // update-28: Zoho's fixed asset register (502 assets = 3 pages of 200) and the ledger of Land and Development Rights (1 page)
const HISTORY_CALLS = 483 * 2; // update-29/30: the entries and the settings (rate, residual value) of every asset that is not a draft (502 assets - 19 drafts), two calls each (no Redis: all of them at once)
const HISTORY_FIRST = 2 * config.settings.register_history_budget; // update-29/30: with Redis a run reads 60 assets (register_history_budget), two calls each, the next run the next 60 ...
const TAX_CALLS = 1; // update-30: the ledger of the two advance tax accounts (1 page)
const SUBS_CALLS = 10; // update-28: the trial balance and the profit and loss of each of the 5 subsidiaries (the Rooftop SPV is refused, but the call is made)
const CWIP_BUDGET = config.settings.cwip_journal_budget; // update-20: with Redis a refresh reads at most this many journals AND bills that are not cached yet (100; update-22: the 35 bills first, so 65 journals)
const CWIP_FIRST = CWIP_BUDGET - cwipBillCount(); // update-22: the journals the first run gets to

test('live pipeline reproduces the audited FY26 statements (47 lines within Rs 5) and passes every check', { skip }, async () => {
  const zoho = replayZoho();
  const snap = await buildSnapshot({ zoho, config, fy: FY, now: () => NOW });
  assert.equal(snap.meta.ok, true, JSON.stringify(snap.alerts.filter((a) => a.level === 'error')));
  assert.equal(snap.meta.reconciled.ok, 47);
  assert.equal(snap.meta.reconciled.check, 0);
  assert.equal(snap.meta.reconciled.phase2, 0);
  assert.ok(snap.checks.every((c) => c.ok));
  assert.equal(snap.meta.asOf, '2026-03-31');
  assert.equal(snap.meta.istDate, '2026-10-15');
  // 1 trial balance + 1 aging + 8 ledger pages + 1 ledger page of the advance account + 1 staff list + 3 ageing reports + one call per journal
  // 15 + the vendor balance summary: 2 dates x 4 requests (the 166 vendors of the sheet, 50 at a time); without Redis every vendor card is read (166: the Vendor Codes)
  // + (update-15) 1 ledger page of the four deposit / PF accounts and one call per clean-up journal behind it (no Redis: all of them)
  // + (update-16) one call per bill of HDFC ERGO (the state of its billing address)
  // + (update-17) the stock summary: 819 item lines on 5 pages of 200
  // + (update-20) 1 ledger page of the CWIP and IAUD accounts and one call per journal behind it (no Redis: all of them, 137)
  // + (update-22) one call per bill behind those two accounts (35): the ledger adds up the lines of a bill, 175 ledger lines instead of the 184 postings
  // + (update-25) 1 ledger page of the two OLD accounts of the clean-up journals that name no park (their original bills)
  // + (update-27) the related parties: Sales by Customer (1 page), the ledger of the vendor cards (1 page) and of the six loan / remuneration / foreign-supplier accounts (1 page)
  assert.equal(snap.meta.apiCalls, 25 + 1 + 1 + STOCK_PAGES + STOCK_LEDGER_PAGES + ITEM_PAGES + 166 + journalCount() + splitJournalCount() + billCount() + cwipJournalCount() + cwipBillCount() + 1 + RELATED_CALLS + REGISTER_CALLS + HISTORY_CALLS + SUBS_CALLS + TAX_CALLS);
  assert.deepEqual(snap.meta.cwip, { rows: 175, oldLedgers: 2, oldOpened: 2, journals: cwipJournalCount(), journalsFromCache: 0, journalsFetched: cwipJournalCount(), journalsRefetched: 0, bills: cwipBillCount(), billsFromCache: 0, billsFetched: cwipBillCount(), billsRefetched: 0, billsFailed: 0, billsSplit: 12, pending: 0 });
  assert.equal(snap.cwip.complete, true);
  assert.deepEqual(snap.meta.bills, { read: billCount(), fromCache: 0, failed: 0 });
  assert.deepEqual(snap.meta.splits, { rows: 52, journalsRead: splitJournalCount(), journalsFromCache: 0, journalsRefetched: 0 });
  assert.equal(snap.ageing.creditors.codes.known, 166);
  assert.equal(snap.meta.ledger.pages, 8);
  assert.deepEqual(JSON.parse(JSON.stringify(snap)), snap, 'a snapshot is plain JSON');
});

test('the right questions are put to Zoho (dates, account filter, page size, staff group)', { skip }, async () => {
  const zoho = replayZoho();
  await buildSnapshot({ zoho, config, fy: FY, now: () => NOW });
  const by = (p) => zoho.calls.filter((c) => c.path === p);
  const own = by('/reports/trialbalance').filter((c) => !c.query.organization_id); // update-28: the subsidiaries' own books are asked of their own organisations
  assert.equal(own.length, 1);
  assert.deepEqual([own[0].query.from_date, own[0].query.to_date], ['2025-04-01', '2026-03-31']);
  const ar = by('/reports/aragingsummary')[0].query;
  assert.deepEqual([ar.to_date, ar.report_date, ar.include_manual_journals, ar.include_credit_notes], ['2026-03-31', '2026-03-31', 'true', 'true']);
  assert.equal(ar.as_of_date, undefined, 'as_of_date is ignored by Zoho and is not sent');
  const tbq = own[0].query;
  assert.deepEqual(tbq.select_columns.map((c) => c.field), ['account_id', 'name', 'account_code', 'opening_balance', 'debit', 'credit', 'closing_balance']);
  const all = by('/reports/generalledgerdetails');
  const gl = all.filter((c) => c.query.rule.columns[0].value.length === config.settings.party_account_ids.length); // the party accounts
  assert.equal(all.length, 16 + STOCK_LEDGER_PAGES, '(update-30: + 1 of the two advance tax accounts) 8 pages of the party ledger, 1 of the advance account, 1 of the deposit / PF accounts, 1 of the CWIP and IAUD accounts (update-20), 1 of the two old accounts of JN-Clean-112 / 225 (update-25), 1 of the related vendors\' cards and 1 of the six related accounts (update-27), 1 of the Land and Development Rights accounts (update-28) and 4 of the account Inventory Asset (update-18)');
  const inv = all.filter((c) => c.query.rule.columns[0].value[0] === '2346113000000000626');
  assert.deepEqual(inv.map((c) => c.query.page), [1, 2, 3, 4], 'the ledger of Inventory Asset, 2000 lines a page');
  assert.deepEqual([inv[0].query.rule.columns[0].value.length, inv[0].query.from_date, inv[0].query.to_date, inv[0].query.per_page], [1, '2025-03-01', '2026-03-31', 2000]);
  assert.deepEqual(gl.map((c) => c.query.page), [1, 2, 3, 4, 5, 6, 7, 8]);
  // Zoho sends the customer's name only when the column is asked for (found live, 16-Oct-2026)
  for (const c of all) assert.ok(c.query.select_columns.some((x) => x.field === 'contact_name'), 'the ledger asks for contact_name');
  const adv = all.find((c) => c.query.rule.columns[0].value.length === 1).query;
  assert.deepEqual([adv.rule.columns[0].value[0], adv.from_date, adv.to_date], ['2346113000000000617', '2025-03-01', '2026-03-31']);
  // update-15: the four accounts that Zoho keeps as one but the signed sheet lists line by line, in one request
  const dep = all.find((c) => c.query.rule.columns[0].value.length === 4).query;
  assert.deepEqual([...dep.rule.columns[0].value].sort(), ['2346113000000053659', '2346113000026786306', '2346113000026786315', '2346113000026786541']);
  assert.deepEqual([dep.from_date, dep.to_date, dep.page], ['2025-03-01', '2026-03-31', 1]);
  // update-20: the two capital work accounts, with the columns that say which park (project, description, branch)
  const cw = all.filter((c) => c.query.rule.columns[0].value.length === 2 && !c.query.rule.columns[0].value.includes('2346113000000054793') && !c.query.rule.columns[0].value.includes('2346113000013976613')).map((c) => c.query); // (the other pairs of accounts are Land and Development Rights, update-28, and the two advance tax accounts, update-30)
  const taxq = all.filter((c) => c.query.rule.columns[0].value.includes('2346113000013976613')); // update-30: the advance tax accounts, one request, from the first day of the books
  assert.equal(taxq.length, 1);
  assert.deepEqual([...taxq[0].query.rule.columns[0].value].sort(), ['2346113000013976613', '2346113000026786252']);
  assert.deepEqual([taxq[0].query.from_date, taxq[0].query.to_date, taxq[0].query.page], ['2025-03-01', '2026-03-31', 1]);
  assert.equal(cw.length, 2, 'the ledger of the two accounts, and (update-25) the ledger of the two old accounts of JN-Clean-112 / 225');
  assert.deepEqual([...cw[0].rule.columns[0].value].sort(), ['2346113000010827154', '2346113000027289098']);
  assert.deepEqual([...cw[1].rule.columns[0].value].sort(), ['2346113000025156848', '2346113000026745888']);
  assert.deepEqual([cw[1].from_date, cw[1].to_date, cw[1].page], ['2025-03-01', '2026-03-31', 1]);
  assert.ok(cw[1].select_columns.some((x) => x.field === 'project_name') && cw[1].select_columns.some((x) => x.field === 'description'), 'with the columns that say which park');
  assert.deepEqual([cw[0].from_date, cw[0].to_date, cw[0].page, cw[0].per_page], ['2025-03-01', '2026-03-31', 1, 2000]);
  for (const f of ['project_name', 'description', 'location_name', 'contact_name']) assert.ok(cw[0].select_columns.some((x) => x.field === f), `the CWIP ledger asks for ${f}`);
  assert.equal(gl[0].query.from_date, '2025-03-01');
  assert.equal(gl[0].query.per_page, 2000);
  const col = gl[0].query.rule.columns[0];
  assert.deepEqual([col.field, col.comparator], ['account_id', 'in']);
  assert.equal(col.value.length, 11);
  assert.deepEqual(by('/vendors')[0].query.cf_vendor_group, 'Imprest Staff');
  // the ageing reports: balances at the date, in the middle of the year (30-Sep) and at the day before the year began, and the sales of both halves
  const cbs = by('/reports/customerbalancesummary').map((c) => c.query);
  assert.deepEqual(cbs.map((q) => q.to_date).sort(), ['2025-03-31', '2025-09-30', '2026-03-31']);
  for (const q of cbs) assert.deepEqual([q.filter_by, q.per_page], ['TransactionDate.CustomDate', 500]);
  const sbc = by('/reports/salesbycustomer').filter((c) => !c.query.rule);
  assert.equal(sbc.length, 2);
  assert.deepEqual(sbc.map((c) => `${c.query.from_date}..${c.query.to_date}`).sort(), ['2025-04-01..2025-09-30', '2025-10-01..2026-03-31']);
  // update-27: the related parties - the sales of four customers, the bills and vendor credits of ten vendor cards, the ledgers of six accounts, all for the year
  const rsales = by('/reports/salesbycustomer').filter((c) => c.query.rule);
  assert.equal(rsales.length, 1);
  assert.deepEqual([rsales[0].query.rule.columns[0].field, [...rsales[0].query.rule.columns[0].value].sort(), rsales[0].query.from_date, rsales[0].query.to_date],
    ['customer_id', ['2346113000000193711', '2346113000000193739', '2346113000000193879', '2346113000000197141'], '2025-04-01', '2026-03-31']);
  const rcon = all.filter((c) => c.query.rule.columns[0].field === 'contact_id');
  assert.equal(rcon.length, 1);
  assert.equal(rcon[0].query.rule.columns[0].value.length, 10);
  assert.deepEqual([rcon[0].query.rule.columns[1].field, rcon[0].query.rule.columns[1].value, rcon[0].query.rule.criteria_string], ['transaction_type', ['bill', 'vendor_credit'], '(1 AND 2)']);
  assert.deepEqual([rcon[0].query.from_date, rcon[0].query.to_date], ['2025-04-01', '2026-03-31']);
  const racc = all.filter((c) => c.query.rule.columns[0].value.length === 6);
  assert.equal(racc.length, 1);
  assert.deepEqual([...racc[0].query.rule.columns[0].value].sort(), ['2346113000002528303', '2346113000009499405', '2346113000011640653', '2346113000023307603', '2346113000026786401', '2346113000026786944']);
  assert.deepEqual([racc[0].query.from_date, racc[0].query.to_date], ['2025-04-01', '2026-03-31']);
});

test('second run the same day: journals come from Redis, the rest is read again', { skip }, async () => {
  const { cache } = withCache();
  const first = await buildSnapshot({ zoho: replayZoho(), cache, config, fy: FY, now: () => NOW });
  assert.equal(first.meta.ledger.journalsFromCache, 0);
  const zoho2 = replayZoho();
  const second = await buildSnapshot({ zoho: zoho2, cache, config, fy: FY, now: () => NOW });
  assert.equal(second.meta.ledger.journalsFromCache, journalCount());
  assert.equal(second.meta.apiCalls, 27 + 1 + STOCK_PAGES + STOCK_LEDGER_PAGES + ITEM_PAGES + 40 + (cwipJournalCount() - CWIP_FIRST) + RELATED_CALLS + REGISTER_CALLS + HISTORY_FIRST + SUBS_CALLS + TAX_CALLS, '(update-29: + the entries of the next 100 assets, the first run read 100) (update-28: + the fixed asset register, the ledger of Land / Development Rights and the books of the five subsidiaries) (update-27: + the three reads of the related parties) (update-25: + the ledger of the two old accounts, once the journals are known) the 25 reports + the ledger of the deposit accounts + the ledger of the CWIP and IAUD accounts (update-20) + the stock summary (5 pages) + the ledger of Inventory Asset (4 pages) + the item list (5 pages, update-19), and the next 40 vendor cards (the first run read 40; the codes are kept in Redis), and the CWIP journals the first run did not get to (137 - 65; its 100 reads went to the 35 bills and 65 journals, update-22)');
  // update-20: the first run reads the 35 bills and the first 65 journals behind CWIP / IAUD (100 in all) and says so (the tab keeps its signed park table); the second finishes
  assert.deepEqual([first.cwip.complete, first.cwip.pending, first.meta.cwip.journalsFetched, first.meta.cwip.billsFetched], [false, cwipJournalCount() - CWIP_FIRST, CWIP_FIRST, cwipBillCount()]);
  assert.ok(first.alerts.some((a) => a.code === 'CWIP_PARTIAL'));
  assert.deepEqual(second.meta.cwip, { rows: 175, oldLedgers: 2, oldOpened: 2, journals: cwipJournalCount(), journalsFromCache: CWIP_FIRST, journalsFetched: cwipJournalCount() - CWIP_FIRST, journalsRefetched: 0, bills: cwipBillCount(), billsFromCache: cwipBillCount(), billsFetched: 0, billsRefetched: 0, billsFailed: 0, billsSplit: 12, pending: 0 });
  assert.deepEqual([second.cwip.complete, second.cwip.pending], [true, 0]);
  assert.ok(!second.alerts.some((a) => /^CWIP_/.test(a.code)), JSON.stringify(second.alerts.filter((a) => /^CWIP_/.test(a.code))));
  assert.deepEqual(second.meta.bills, { read: billCount(), fromCache: billCount(), failed: 0 }, 'the bills of HDFC ERGO come from Redis too');
  assert.deepEqual(zoho2.billCalls, []);
  assert.equal(first.meta.splits.journalsFromCache, 0);
  assert.deepEqual([second.meta.splits.journalsRead, second.meta.splits.journalsFromCache, second.meta.splits.journalsRefetched], [splitJournalCount(), splitJournalCount(), 0], 'the clean-up journals come from Redis too');
  assert.equal(first.ageing.creditors.codes.known, 40);
  assert.equal(second.ageing.creditors.codes.known, 80);
  assert.equal(second.meta.reconciled.ok, 47);
});

test('a journal edited in Zoho after it was cached is noticed and read again', { skip }, async () => {
  const { cache } = withCache();
  await buildSnapshot({ zoho: replayZoho(), cache, config, fy: FY, now: () => NOW });
  // poison one cached journal: change an amount so it no longer agrees with the ledger row
  const id = Object.keys(J('fixtures/gl/journals_merged.json'))[0];
  const cached = await cache.getJournal(id);
  cached.lines[0].debit += 500;
  await cache.putJournal(id, cached);
  const snap = await buildSnapshot({ zoho: replayZoho(), cache, config, fy: FY, now: () => NOW });
  assert.equal(snap.meta.ledger.journalsRefetched, 1);
  assert.equal(snap.alerts.filter((a) => a.code === 'GL_JOURNAL_MISMATCH').length, 0);
  assert.equal(snap.meta.reconciled.ok, 47);
  assert.deepEqual((await cache.getJournal(id)).lines, J('fixtures/gl/journals_merged.json')[id].lines, 'the fresh copy replaced the stale one in Redis');
});

test('update-15: the deposit accounts are split bank by bank from the ledger and the clean-up journals, the insurers and RPE by the account of their entries', { skip }, async () => {
  const snap = await buildSnapshot({ zoho: replayZoho(), config, fy: FY, now: () => NOW });
  const parts = (k) => snap.splits[k].parts.map((p) => [p.name, p.amount]);
  assert.deepEqual(parts('fixed_deposits'), [['Axis Bank', 1010360], ['State Bank of India', 5313563], ['HDFC Bank', 4098808.14], ['Kotak Bank', 250015.97], ['IOB', 258092782], ['ICICI', 86532587]]);
  assert.deepEqual(parts('accrued_interest_fdr'), [['Axis Bank', 32447], ['State Bank of India', 231090], ['HDFC Bank', 78118.11], ['Kotak Bank', 766], ['IOB', 2731818], ['ICICI', 3314540.4]]);
  assert.deepEqual(parts('security_deposits_given'), [['Security Deposit CDSL', 14502], ['Security Deposit NSDL', 18885], ['EMD for Tenders', 1000000]]);
  assert.deepEqual(parts('pf_payable'), [['Employee Contribution', 249484], ['Employer Contribution', 270274]]);
  assert.deepEqual(parts('hdfc_ergo'), [['HDFC ERGO - advance', 426901.44], ['HDFC ERGO - payable, Delhi', 414242.16], ['HDFC ERGO - payable, Rajasthan', 12650]], 'update-16: the payable by the billing-address state of its four bills');
  assert.deepEqual(parts('icici_lombard'), [['ICICI Lombard - advance', 58814.74], ['ICICI Lombard - payable', 51514.14]]);
  assert.deepEqual(parts('rpe_energy'), [['RPE Energy Reserve - loan', 23000000], ['RPE Energy Reserve - advance', 35000]]);
  for (const [k, v] of Object.entries(snap.splits)) assert.deepEqual([v.error, v.residual, v.unassigned.length], [undefined, 0, 0], k);
  // each split adds up to its account in the Trial Balance (the run itself checks it; here the figures)
  const tb = (id) => snap.buckets && Object.values(snap.buckets).flatMap((b) => b.accounts).find((a) => a.id === id)?.closing;
  for (const k of ['fixed_deposits', 'accrued_interest_fdr', 'security_deposits_given', 'pf_payable']) {
    assert.ok(Math.abs(Math.abs(tb(snap.splits[k].account)) - Math.abs(snap.splits[k].total)) <= 1, k);
  }
  assert.equal(snap.alerts.filter((a) => /^SPLIT/.test(a.code)).length, 0);
  assert.equal(snap.meta.ok, true);
});

test('update-15: if the ledger of the deposit accounts is refused the run goes on, and those lines are compared in total (the contacts still split)', { skip }, async () => {
  const zoho = replayZoho({ splitsFail: 'ledger' });
  const snap = await buildSnapshot({ zoho, config, fy: FY, now: () => NOW });
  assert.equal(snap.meta.ok, true);
  assert.equal(snap.meta.reconciled.ok, 47);
  assert.match(snap.splits.error, /not authorized/);
  assert.equal(snap.splits.fixed_deposits, undefined);
  assert.equal(snap.splits.hdfc_ergo.error, undefined, 'the contacts come from the party ledger, not from the deposit ledger');
  assert.deepEqual(snap.alerts.filter((a) => /^SPLIT/.test(a.code)).map((a) => [a.level, a.code]), [['warn', 'SPLITS_UNAVAILABLE']]);
  assert.equal(snap.meta.splits, null);
  assert.equal(snap.meta.apiCalls, 25 + 1 + 1 + STOCK_PAGES + STOCK_LEDGER_PAGES + ITEM_PAGES + 166 + journalCount() + billCount() + cwipJournalCount() + cwipBillCount() + 1 + RELATED_CALLS + REGISTER_CALLS + HISTORY_CALLS + SUBS_CALLS + TAX_CALLS, 'the failed call is counted; no clean-up journal of the deposit accounts is read; the four bills of HDFC ERGO still are; the CWIP journals and the ledger of the two old accounts (update-25) are');
});

test('update-15: a ledger that does not add up to the Trial Balance is not used; a clean-up journal Zoho cannot open leaves its amount for the total', { skip }, async () => {
  const fixed = '2346113000000053659';
  const mismatch = await buildSnapshot({ zoho: replayZoho({ splitRows: (id, rows) => (id === fixed ? rows.slice(1) : rows) }), config, fy: FY, now: () => NOW });
  assert.match(mismatch.splits.fixed_deposits.error, /Trial Balance says/);
  assert.equal(mismatch.splits.accrued_interest_fdr.error, undefined, 'only that account is given up');
  assert.deepEqual(mismatch.alerts.filter((a) => a.code === 'SPLIT_LEDGER_MISMATCH').length, 1);
  assert.equal(mismatch.meta.ok, true, 'a detail layer never makes the books wrong');

  const ids = Object.keys(J('fixtures/splits_fy26.json').journals);
  const gone = await buildSnapshot({ zoho: replayZoho({ splitJournalMissing: [ids[0]] }), config, fy: FY, now: () => NOW });
  assert.equal(gone.alerts.filter((a) => a.code === 'SPLIT_JOURNAL_NOT_FOUND').length, 1);
  const open = Object.values(gone.splits).filter((v) => v.unassigned?.length);
  assert.equal(open.length, 1, 'one split is left with an amount that names no bank');
  assert.ok(Math.abs(open[0].residual) > 0);
  assert.equal(gone.meta.ok, true);
});

test('update-15: a journal cached before this update has no notes and is read again, once', { skip }, async () => {
  const { cache } = withCache();
  await buildSnapshot({ zoho: replayZoho(), cache, config, fy: FY, now: () => NOW });
  const id = Object.keys(J('fixtures/splits_fy26.json').journals)[0];
  const cached = await cache.getJournal(id);
  assert.equal(typeof cached.notes, 'string');
  delete cached.notes;
  await cache.putJournal(id, cached);
  const zoho = replayZoho();
  const again = await buildSnapshot({ zoho, cache, config, fy: FY, now: () => NOW });
  assert.deepEqual([again.meta.splits.journalsRead, again.meta.splits.journalsFromCache, again.meta.splits.journalsRefetched], [34, 34, 1]);
  assert.equal(zoho.calls.filter((c) => c.path === `/journals/${id}`).length, 1);
  assert.equal(typeof (await cache.getJournal(id)).notes, 'string', 'the fresh copy replaced the old one in Redis');
  assert.equal(again.splits.fixed_deposits.unassigned.length, 0);
});

test('update-16: HDFC ERGO\'s payable is split into Delhi and Rajasthan by the billing-address state of its four bills; a bill whose tag was changed moves its amount', { skip }, async () => {
  const zoho = replayZoho();
  const snap = await buildSnapshot({ zoho, config, fy: FY, now: () => NOW });
  assert.deepEqual(zoho.billCalls.slice().sort(), Object.keys(J('fixtures/bills_fy26.json').bills).sort(), 'exactly the four bills of the contact, each once');
  assert.deepEqual(zoho.calls.filter((c) => c.path.startsWith('/bills/')).map((c) => c.path).sort(), [...zoho.billCalls, ...zoho.cwipBillCalls].map((id) => `/bills/${id}`).sort(), 'and the bills behind the CWIP and IAUD accounts (update-22)');
  assert.equal(zoho.cwipBillCalls.length, cwipBillCount());
  assert.equal(snap.alerts.filter((a) => /^SPLIT/.test(a.code)).length, 0);
  // the auditors' figures to the paisa: Delhi 4,14,242.16 (three bills), Rajasthan 12,650 (the bill with no billing state)
  assert.deepEqual(snap.splits.hdfc_ergo.parts.map((p) => [p.name, p.amount, p.rows]), [['HDFC ERGO - advance', 426901.44, 2], ['HDFC ERGO - payable, Delhi', 414242.16, 3], ['HDFC ERGO - payable, Rajasthan', 12650, 5]]);

  // one bill billed to another state in Zoho today: its amount moves, the contact still adds up
  const moved = await buildSnapshot({ zoho: replayZoho({ billState: { '2346113000026693977': '' } }), config, fy: FY, now: () => NOW });
  assert.equal(moved.meta.ok, true);
  assert.deepEqual(moved.splits.hdfc_ergo.parts.map((p) => [p.name, p.amount]), [['HDFC ERGO - advance', 426901.44], ['HDFC ERGO - payable, Delhi', 284133], ['HDFC ERGO - payable, Rajasthan', 142759.16]]);
  assert.deepEqual([moved.splits.hdfc_ergo.error, moved.splits.hdfc_ergo.residual, moved.splits.hdfc_ergo.total], [undefined, 0, 9.28]);
  assert.equal(moved.alerts.filter((a) => /^SPLIT/.test(a.code)).length, 0, 'a different tag is a difference on the sheet, not an error of the run');
});

test('update-16: bills Zoho will not open (all of them, or just one) leave the HDFC ERGO payable as one combined balance, with a warning - the run goes on', { skip }, async () => {
  for (const billsFail of ['all', ['2346113000013828469']]) {
    const snap = await buildSnapshot({ zoho: replayZoho({ billsFail }), config, fy: FY, now: () => NOW });
    const label = JSON.stringify(billsFail);
    assert.equal(snap.meta.ok, true, label);
    assert.equal(snap.meta.reconciled.ok, 47, label);
    assert.deepEqual(snap.meta.bills, { read: 4, fromCache: 0, failed: billsFail === 'all' ? 4 : 1 }, label);
    assert.deepEqual(snap.alerts.filter((a) => /^SPLIT/.test(a.code)).map((a) => [a.level, a.code]), [['warn', 'SPLIT_BILLS_UNAVAILABLE']], label);
    const h = snap.splits.hdfc_ergo;
    assert.deepEqual(h.parts.map((p) => [p.name, p.amount]), [['HDFC ERGO - advance', 426901.44]], `${label}: all or nothing - not even the bills that were read are used`);
    assert.deepEqual([h.error, h.residual, h.unassigned.length, h.total], [undefined, 426892.16, 4, 9.28], label);
  }
  assert.equal((await buildSnapshot({ zoho: replayZoho({ billsFail: 'all' }), config, fy: FY, now: () => NOW })).splits.icici_lombard.error, undefined, 'the other contacts are not touched');
});

test('update-16: the bills are kept in Redis, so the next run does not read them again; a bill cached without a billing state is read again', { skip }, async () => {
  const { cache } = withCache();
  const first = await buildSnapshot({ zoho: replayZoho(), cache, config, fy: FY, now: () => NOW });
  assert.deepEqual(first.meta.bills, { read: billCount(), fromCache: 0, failed: 0 });
  const id = Object.keys(J('fixtures/bills_fy26.json').bills)[0];
  assert.equal(typeof (await cache.getBill(id)).billingState, 'string');
  const zoho = replayZoho();
  const again = await buildSnapshot({ zoho, cache, config, fy: FY, now: () => NOW });
  assert.deepEqual(again.meta.bills, { read: billCount(), fromCache: billCount(), failed: 0 });
  assert.deepEqual(zoho.billCalls, []);
  assert.deepEqual(again.splits.hdfc_ergo.parts, first.splits.hdfc_ergo.parts);

  const stale = { ...(await cache.getBill(id)) };
  delete stale.billingState;
  await cache.putBill(id, stale);
  const z3 = replayZoho();
  const third = await buildSnapshot({ zoho: z3, cache, config, fy: FY, now: () => NOW });
  assert.deepEqual(z3.billCalls, [id], 'only that bill is read again');
  assert.deepEqual(third.meta.bills, { read: billCount(), fromCache: billCount() - 1, failed: 0 });
});

test('if Zoho ignores the account filter the run stops before reading the whole ledger', { skip }, async () => {
  const zoho = replayZoho({ ignoreRule: true });
  await assert.rejects(buildSnapshot({ zoho, config, fy: FY, now: () => NOW }), (e) => e instanceof LoadError && e.code === 'LEDGER_FILTER_IGNORED');
  assert.ok(zoho.calls.filter((c) => c.path === '/reports/generalledgerdetails' && c.query.rule.columns[0].value.length === config.settings.party_account_ids.length).length <= 1, 'the party ledger is not read on');
});

test('a ledger that is too long, or for other dates, is refused', { skip }, async () => {
  const ids = config.settings.party_account_ids;
  await assert.rejects(fetchLedger(replayZoho(), { accountIds: ids, from: '2025-03-01', to: '2026-03-31', maxPages: 3 }), /more than the 3|more than 3 pages|3 allowed/);
  await assert.rejects(fetchLedger(replayZoho(), { accountIds: ids, from: '2025-01-01', to: '2026-03-31' }), (e) => e.code === 'LEDGER_DATES');
});

test('the receivables aging is read page by page and its date is checked', { skip }, async () => {
  const zoho = replayZoho({ agingPages: 3 });
  const snap = await buildSnapshot({ zoho, config, fy: FY, now: () => NOW });
  assert.equal(zoho.calls.filter((c) => c.path === '/reports/aragingsummary').length, 3);
  assert.equal(snap.meta.ok, true);
  assert.equal(snap.meta.reconciled.ok, 47);
  await assert.rejects(buildSnapshot({ zoho: replayZoho({ agingDate: '2026-10-15' }), config, fy: FY, now: () => NOW }), (e) => e.code === 'AGING_DATE');
});

test('refresh stores the snapshot; a second refresh while one is running is turned away; the web side can read it back', { skip }, async () => {
  const { cache } = withCache();
  const out = await refreshSnapshot({ zoho: replayZoho(), cache, config, fy: FY, now: () => NOW });
  assert.equal(out.snapshot.meta.ok, true);
  assert.ok(out.stored.latestMoved);
  const got = await cache.getSnapshot(FY, '2026-10-15');
  assert.equal(got.stale, false);
  assert.equal(got.snapshot.meta.reconciled.ok, 47);
  assert.equal(got.snapshot.statements.lines.pat.value, out.snapshot.statements.lines.pat.value);

  assert.equal(await cache.acquireLock('refresh', 60), true);
  const busy = await refreshSnapshot({ zoho: replayZoho(), cache, config, fy: FY, now: () => NOW });
  assert.deepEqual(busy, { busy: true });
  await cache.releaseLock('refresh');
  // the lock is released even when the build fails
  await assert.rejects(refreshSnapshot({ zoho: replayZoho({ ignoreRule: true }), cache, config, fy: FY, now: () => NOW }));
  assert.equal(await cache.acquireLock('refresh', 60), true);
});

test('a year without its own settings file says so plainly', () => {
  assert.throws(() => loadConfig('2026-27'), /not set up yet/);
});

test('what the first live run taught: without named columns / journal options the live API gives zero amounts or a short aging list', { skip }, async () => {
  // the replay behaves like the live API: ask the old way and the answer is unusable
  const oldTB = replayZoho();
  const raw = await oldTB.get('/reports/trialbalance', { filter_by: 'TransactionDate.CustomDate', from_date: '2025-04-01', to_date: '2026-03-31', show_rows: 'non_zero' });
  assert.throws(() => normalizeTB(raw), /no closing_balance column/);

  const oldAR = replayZoho();
  const short = normalizeARAging(await oldAR.get('/reports/aragingsummary', { filter_by: 'InvoiceDate.CustomDate', to_date: '2026-03-31' }));
  const full = normalizeARAging(await oldAR.get('/reports/aragingsummary', { to_date: '2026-03-31', include_manual_journals: 'true', include_credit_notes: 'true' }));
  assert.ok(short.contacts.length < full.contacts.length);
  assert.ok(Math.abs(full.total - 814301563.66) < 1);
});

// ---------- update-20: the CWIP tab ----------

test('update-20: the park split of the CWIP and IAUD accounts - 21 parks, every line placed, nothing wrong with the books', { skip }, async () => {
  const snap = await buildSnapshot({ zoho: replayZoho(), config, fy: FY, now: () => NOW });
  assert.equal(snap.meta.ok, true);
  assert.equal(snap.cwip.complete, true);
  assert.equal(snap.cwip.parks.length, 21);
  assert.equal(snap.cwip.unnamedCount, 0);
  assert.deepEqual(snap.alerts.filter((a) => /^CWIP/.test(a.code)), [], 'no alert when all is read and placed');
  assert.deepEqual(JSON.parse(JSON.stringify(snap.cwip)), snap.cwip, 'plain JSON');
  assert.ok(JSON.stringify(snap.cwip).length < 60_000, 'a small section: the lines of the ledgers are not kept');
});

test('update-20: if Zoho refuses the ledger of the CWIP and IAUD accounts, or ignores its filter, the run goes on and the tab stays as signed', { skip }, async () => {
  const refused = await buildSnapshot({ zoho: replayZoho({ cwipFail: 'refused' }), config, fy: FY, now: () => NOW });
  assert.equal(refused.meta.ok, true);
  assert.equal(refused.meta.reconciled.ok, 47);
  assert.match(refused.cwip.error, /not authorized/);
  assert.deepEqual(refused.alerts.filter((a) => /^CWIP/.test(a.code)).map((a) => [a.level, a.code]), [['warn', 'CWIP_UNAVAILABLE']]);
  assert.equal(refused.meta.cwip, null);
  assert.equal(refused.meta.apiCalls, 25 + 1 + 1 + STOCK_PAGES + STOCK_LEDGER_PAGES + ITEM_PAGES + 166 + journalCount() + splitJournalCount() + billCount() + RELATED_CALLS + REGISTER_CALLS + HISTORY_CALLS + SUBS_CALLS + TAX_CALLS, 'the failed call is counted; no journal behind the two accounts is read');
  const o = liveOverlay(refused, readSheet(config.workbook, 'cwip'));
  assert.equal(o.problems.length, 1, 'the page says the park table stays as signed');
  assert.equal(o.summary.ok + o.summary.diff, 0);

  const ignored = await buildSnapshot({ zoho: replayZoho({ cwipIgnoreRule: true }), config, fy: FY, now: () => NOW });
  assert.match(ignored.cwip.error, /ignored the account filter/, 'the ledger reader itself refuses it');
  assert.equal(ignored.alerts.filter((a) => a.code === 'CWIP_UNAVAILABLE').length, 1);
  assert.equal(ignored.meta.ok, true);
});

test('update-20: a ledger that does not add up to the Trial Balance is not used', { skip }, async () => {
  const snap = await buildSnapshot({
    zoho: replayZoho({ cwipRows: (groups) => { groups[0].rows[0].debit = (Number(groups[0].rows[0].debit) || 0) + 1000; return groups; } }),
    config, fy: FY, now: () => NOW,
  });
  assert.match(snap.cwip.error, /the ledger adds up to .*, the Trial Balance says/);
  assert.deepEqual(snap.alerts.filter((a) => /^CWIP/.test(a.code)).map((a) => a.code), ['CWIP_LEDGER_MISMATCH']);
  assert.equal(snap.meta.ok, true, 'a detail layer never makes the books wrong');
});

test('update-20: a journal Zoho cannot open leaves its line unplaced and says so; the other parks are still given', { skip }, async () => {
  const ids = Object.keys(J('fixtures/cwip_fy26.json').journals);
  const snap = await buildSnapshot({ zoho: replayZoho({ cwipJournalMissing: [ids[0]] }), config, fy: FY, now: () => NOW });
  assert.equal(snap.alerts.filter((a) => a.code === 'CWIP_JOURNAL_NOT_FOUND').length, 1);
  assert.ok(snap.cwip.unnamedCount >= 1);
  assert.equal(snap.cwip.complete, true);
  assert.ok(snap.cwip.parks.length >= 18);
  assert.equal(snap.meta.ok, true);
});

test('update-20: a journal edited in Zoho after it was kept is noticed and read again, once; one the run could not reach yet is read on the next run', { skip }, async () => {
  const { cache } = withCache();
  const first = await buildSnapshot({ zoho: replayZoho(), cache, config, fy: FY, now: () => NOW });
  assert.equal(first.cwip.complete, false);
  const fx = J('fixtures/cwip_fy26.json').journals;
  let id = null;
  for (const k of Object.keys(fx)) { if (await cache.getJournal(k)) { id = k; break; } }
  assert.ok(id, 'a journal behind the two accounts is kept in Redis');
  const cached = await cache.getJournal(id);
  const mine = cached.lines.find((l) => l.account_id === '2346113000027289098' || l.account_id === '2346113000010827154');
  mine.debit += 500;
  await cache.putJournal(id, cached);
  const zoho = replayZoho();
  const second = await buildSnapshot({ zoho, cache, config, fy: FY, now: () => NOW });
  assert.equal(second.meta.cwip.journalsRefetched, 1);
  assert.equal(second.cwip.complete, true);
  assert.equal(second.cwip.unnamedCount, 0);
  assert.equal(zoho.cwipJournalCalls.filter((x) => x === id).length, 1, 'read once, and not again');
  assert.deepEqual((await cache.getJournal(id)).lines.find((l) => l.account_id === mine.account_id), { ...mine, debit: mine.debit - 500 }, 'the fresh copy replaced the stale one in Redis');
});

test('update-20: the journals behind CWIP / IAUD are kept a month, the others 12 hours', { skip }, async () => {
  const { f, cache } = withCache();
  await buildSnapshot({ zoho: replayZoho(), cache, config, fy: FY, now: () => NOW });
  f.clock.t += 13 * 3600 * 1000;
  const zoho = replayZoho();
  const second = await buildSnapshot({ zoho, cache, config, fy: FY, now: () => NOW });
  assert.equal(second.meta.ledger.journalsFromCache, 0, 'the journals of the ledger were kept 12 hours only');
  assert.equal(second.meta.cwip.journalsFromCache, CWIP_FIRST, 'the 65 CWIP journals of the first run are still there');
  assert.equal(second.meta.cwip.billsFromCache, cwipBillCount(), 'and so are the 35 bills');
  assert.equal(second.meta.cwip.journalsFetched, cwipJournalCount() - CWIP_FIRST, 'only the rest is read, and the tab is complete');
  assert.equal(second.cwip.complete, true);
  f.clock.t += 31 * 24 * 3600 * 1000;
  const third = await buildSnapshot({ zoho: replayZoho(), cache, config, fy: FY, now: () => NOW });
  assert.equal(third.meta.cwip.journalsFromCache, 0, 'after a month they are read again');
  assert.equal(third.meta.cwip.billsFromCache, 0, 'and so are the bills');
});

test('update-24: a bill kept in the older shape (without the Project Name field and the customer of the line) is read again; the others stay', { skip }, async () => {
  const { cache } = withCache();
  const first = await buildSnapshot({ zoho: replayZoho(), cache, config, fy: FY, now: () => NOW });
  const ids = [...new Set(Object.values(J('fixtures/cwip_fy26.json').groups).flatMap((g) => g.rows).filter((r) => r.transaction_type === 'bill').map((r) => r.transaction_id))];
  const two = ids.slice(0, 2);
  for (const id of two) { const { v, ...old } = await cache.getCwipBill(id); assert.equal(v, 2); await cache.putCwipBill(id, old); } // what update-23 kept
  const zoho = replayZoho();
  const again = await buildSnapshot({ zoho, cache, config, fy: FY, now: () => NOW });
  assert.deepEqual([again.meta.cwip.billsFromCache, again.meta.cwip.billsFetched], [cwipBillCount() - 2, 2]);
  assert.deepEqual([...zoho.cwipBillCalls].sort(), [...two].sort(), 'only those two are asked for');
  assert.deepEqual(again.cwip.billNamed.map((b) => b.entry).sort(), first.cwip.billNamed.map((b) => b.entry).sort(), 'and the lines named by their bills are the same');
});
