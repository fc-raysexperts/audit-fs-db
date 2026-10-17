// Test doubles (not used by the app): a fake Upstash Redis, and a Zoho client that replays the saved FY26 snapshots.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/config.mjs';
import { readSheet } from '../lib/workbook.mjs';
import { normalizeTB } from '../lib/tb.mjs';
import { normalizeARAging } from '../lib/receivables.mjs';
import { advanceLinesOfSheet } from '../lib/advances.mjs';
import { normName } from '../lib/overlay.mjs';
import { ZohoError } from '../lib/zoho.mjs';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const J = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
export const haveFixtures = () =>
  ['fixtures/tb_fy26_nonzero.raw.json', 'fixtures/ar_aging_2026-03-31.raw.json', 'fixtures/gl/raw/gl_party_p1.json', 'fixtures/gl/journals_merged.json', 'fixtures/vendors_imprest_staff.raw.json', 'fixtures/cbs_2026-03-31.raw.json', 'fixtures/cbs_2025-03-31.raw.json', 'fixtures/cbs_2025-09-30.raw.json', 'fixtures/sbc_2025-10-01_2026-03-31.raw.json', 'fixtures/sbc_2025-04-01_2025-09-30.raw.json', 'fixtures/vbs_fy26.json', 'fixtures/inventory_valuation_fy26.json', 'fixtures/cwip_fy26.json']
    .every((f) => fs.existsSync(path.join(root, f)));

export const ADVANCE_ACCOUNT_ID = '2346113000000000617'; // "Advance from debtors"

/**
 * An invented ledger of the account "Advance from debtors" for the replay (the real one is not among the saved files). It is made FROM the signed list of advances
 * (BS Grouping) and the hand-netting list, so that after the netting each customer comes out at its signed figure, and it ends with one line without a customer that
 * brings the account to its Trial Balance figure. It tests the machinery (reading, netting, matching), not the live match: that is what scripts/probe-advances-ledger.mjs
 * shows on the real books (16-Oct-2026: 61 of 113 lines agree to within Rs 1 by figure, none differs; the rest could not be named, see lib/zohoData.mjs LEDGER_COLUMNS).
 * @returns {object[]} raw ledger lines, as Zoho sends them
 */
export function syntheticAdvanceRows() {
  const config = loadConfig('2025-26');
  const tb = normalizeTB(J('fixtures/tb_fy26_nonzero.raw.json'));
  const closing = -tb.accounts.find((a) => a.id === ADVANCE_ACCOUNT_ID).closing; // credit, positive
  const aging = normalizeARAging(J('fixtures/ar_aging_2026-03-31.raw.json'));
  const signed = advanceLinesOfSheet(readSheet(config.workbook, 'bs-grouping').rows);
  const byName = new Map(aging.contacts.map((c) => [normName(c.name), c]));
  const renamed = { 'Miracle Coro Plast Pvt Ltd': 'Miracle Group Limited' }; // the auditors' list still has the old name of this contact (seen in the live probe)
  const entries = config.overrides?.entries ?? {};
  const rows = [];
  let n = 0;
  const line = (id, name, credit, debit = 0) => rows.push({
    date: '2026-02-10', account_name: 'Advance from debtors', transaction_details: name, transaction_id: `ADV${++n}`, transaction_type: 'customer_payment',
    entity_number: `RCT-${n}`, debit: debit || '', credit: credit || '', contact_id: id, contact_name: name, account_id: ADVANCE_ACCOUNT_ID,
  });
  const done = new Set();
  const emit = (id, name, ledger) => { if (ledger > 0.005) { line(id, name, ledger + 100); line(id, name, 0, 100); } };
  signed.forEach((l, i) => {
    const c = byName.get(normName(renamed[l.label] ?? l.label));
    const taken = c && done.has(c.id);
    const id = c && !taken ? c.id : `SYN${i + 1}`;
    if (c && !taken) done.add(c.id);
    const adj = entries[id]?.adjustment ?? 0;
    const credit = c && !taken ? Math.max(0, -(c.total + adj)) : 0;
    emit(id, c && !taken ? c.name : l.label, Math.max(0, l.signed - adj - credit));
  });
  for (const [id, o] of Object.entries(entries)) if (!done.has(id)) emit(id, o.name, -o.adjustment); // netted down to nothing: not on the signed list
  const have = rows.reduce((t, r) => t + (r.credit || 0) - (r.debit || 0), 0);
  const rest = closing - have;
  rows.push({ date: '2026-03-05', account_name: 'Advance from debtors', transaction_details: 'Opening balance', transaction_id: 'ADV-OB', transaction_type: 'opening_balance', entity_number: '', debit: rest < 0 ? -rest : '', credit: rest > 0 ? rest : '', contact_id: '', contact_name: '', account_id: ADVANCE_ACCOUNT_ID });
  return rows;
}

const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Upstash REST look-alike. `clock.t` is the current time in ms; move it to test expiry. */
export function fakeUpstash({ token = 'secret-token', clock = { t: 1_800_000_000_000 } } = {}) {
  const store = new Map(); // key -> { value, expiresAt }
  const log = [];
  const live = (key) => {
    const e = store.get(key);
    if (!e) return null;
    if (e.expiresAt !== null && e.expiresAt <= clock.t) { store.delete(key); return null; }
    return e;
  };
  async function fetchImpl(_url, init) {
    if (init.headers.authorization !== `Bearer ${token}`) return reply({ error: 'WRONGPASS invalid or missing auth token' }, 401);
    const args = JSON.parse(init.body);
    log.push(args);
    const [name, key, ...rest] = args;
    switch (String(name).toUpperCase()) {
      case 'GET': return reply({ result: live(key)?.value ?? null });
      case 'DEL': { const had = !!live(key); store.delete(key); return reply({ result: had ? 1 : 0 }); }
      case 'TTL': { const e = live(key); return reply({ result: !e ? -2 : e.expiresAt === null ? -1 : Math.ceil((e.expiresAt - clock.t) / 1000) }); }
      case 'SET': {
        const value = rest[0];
        const opts = rest.slice(1).map((x) => String(x).toUpperCase());
        const nx = opts.includes('NX');
        const exIdx = opts.indexOf('EX');
        if (nx && live(key)) return reply({ result: null });
        store.set(key, { value, expiresAt: exIdx >= 0 ? clock.t + Number(rest[1 + exIdx + 1]) * 1000 : null });
        return reply({ result: 'OK' });
      }
      default: return reply({ error: `ERR unknown command '${name}'` }, 400);
    }
  }
  return { fetchImpl, store, log, clock, token };
}

/**
 * A Zoho client that answers from the saved FY26 snapshots, the way the live API is expected to answer.
 * Like the live API (found on the first live run): the Trial Balance carries no opening / closing balances unless `select_columns` names them,
 * and the aging report omits journal / credit-note balances unless both include flags are 'true'.
 * options.ignoreRule      -> the ledger answers with lines of an unrelated account (filter ignored)
 * options.agingDate       -> the aging report claims this date
 * options.agingPages      -> split the aging customers over this many pages
 * options.journalNet      -> function(txnId, rawJournal) to alter a journal before it is returned
 * options.advanceRows     -> the raw ledger lines of the account "Advance from debtors" (default: syntheticAdvanceRows())
 * options.advanceIgnoreRule -> that ledger answers with lines of another account (filter ignored)
 * options.ageingFail     -> 'balances' | 'sales': that report is refused the way Zoho refuses what a token may not read (HTTP 401, code 57)
 * options.balancesDate    -> the customer balance summary claims this date
 * options.salesRange      -> the sales by customer report claims this range [from, to]
 * options.vbs              -> 'refused': the vendor balance summary is refused (HTTP 401, code 57, as the reports tool of the Zoho connector does)
 * options.vbsDate          -> the vendor balance summary claims this date
 * options.vbsIgnoreFilter  -> the vendor balance summary also lists a vendor that was not asked for (filter ignored)
 * options.vbsFlat          -> the vendor balance summary sends a flat list (the real answer has a list inside a list)
 * options.halfFail         -> the two reports of the first half of the year (balances on 30-Sep-2025, sales April-September) are refused (HTTP 401, code 57)
 * options.halfDate         -> the balances on 30-Sep-2025 claim this date
 * options.billsFail         -> 'all' | [bill ids]: those bills (update-16: the 4 bills of HDFC ERGO) are refused (HTTP 401); 'all' = every bill
 * options.billState         -> { billId: state } : answer another billing-address state for that bill
 * options.stockFail         -> 'refused': the inventory valuation report is refused (HTTP 401, code 57)
 * options.stockDate         -> the inventory valuation claims this date
 * options.stockItems        -> function(items) -> items: change the raw stock lines (update-17) before they are cut into pages; the report's own totals are worked out from what is returned
 * options.stockTotal        -> the total the report states for itself, instead of the sum of the lines (a page that went missing)
 * options.stockLedgerFail  -> 'refused': the ledger of Inventory Asset is refused (HTTP 401, code 57) (update-18)
 * options.stockLedgerRows  -> function(rows) -> rows: change the compact ledger lines [date, type, debit, credit, location, transaction id] before they are cut into pages
 * options.stockLedgerIgnoreRule -> that ledger answers with lines of another account (filter ignored)
 * options.itemsFail      -> 'refused': the item list is refused (HTTP 401, code 57) (update-19)
 * options.itemsList      -> function(items) -> items: change the item records [{ item_id, name, sku, unit, status }] before they are cut into pages
 * (the item list answers like Zoho: inactive items only when the request says filter_by=Status.All)
 * options.cwipFail      -> 'refused': the ledger of the CWIP and IAUD accounts is refused (HTTP 401, code 57) (update-20)
 * options.cwipRows      -> function(groups) -> groups: change the raw ledger lines of the two accounts [{ group_name, rows }] before they are returned
 * options.cwipIgnoreRule -> that ledger answers with a line of another account (filter ignored)
 * options.cwipJournalEdit -> function(id, raw) -> raw: change a journal behind the two accounts before it is returned
 * options.cwipJournalMissing -> ids of journals behind the two accounts that answer 404
 * options.cwipKeepBillLines -> true: the ledger of the two accounts gives every bill line on its own line (as the Zoho connector did when fixtures/cwip_fy26.json was saved). By default it answers
 *   like the REAL REST ledger report (checked on the user's connection, 17-Oct-2026): ONE line per bill and account - the lines of a bill that go to the same account are added up and the line
 *   keeps the project of only one of them (here the middle one: bill 482 of Anita Freight Carrier, three lines of 2,784 for Kolayat, Bhamatsar and Pugal, comes as 8,352 under Bhamatsar) (update-22)
 * options.cwipBillsFail -> 'all' | [ids]: those bills behind the two accounts are refused (HTTP 401, code 57)
 * options.cwipBillEdit  -> function(id, raw) -> raw: change a bill behind the two accounts before it is returned
 * (a bill behind the two accounts is answered from the saved ledger lines of that bill, with one more line of another account so that the account of each line has to be looked at)
 * options.codesRateAfter  -> a vendor card is refused (HTTP 429) from this many cards on
 * options.codesMissing    -> ids of vendor cards that answer 404
 * options.codes           -> { id: code } to answer for a vendor card instead of the saved code
 * The sales by customer report answers like the real one: only `sales` and `sales_with_tax` unless the request names `invoice_amount` in select_columns.
 * The vendor balance summary is made up (saved in fixtures/vbs_fy26.json): the year's Billed and Paid of every vendor of the Creditors Ageing are the SIGNED figures
 * (so a replay agrees the way the real run of 17-Oct-2026 did, 165 of 165), lifetime figures at 31-Mar-2025 are 100000 / 90000. A vendor that is not in that file
 * (the tests ask for ids of their own) gets: billed = 100000 + k at 31-Mar-2025 and 105000 + 2k at 31-Mar-2026, paid = 90000 and 94000 + k (k = the last three
 * digits of the id).
 */
export function replayZoho(options = {}) {
  const tb = J('fixtures/tb_fy26_nonzero.raw.json');
  const ar = J('fixtures/ar_aging_2026-03-31.raw.json');
  const vendors = J('fixtures/vendors_imprest_staff.raw.json');
  const vbsFixture = J('fixtures/vbs_fy26.json').vendors;
  const journalsNorm = J('fixtures/gl/journals_merged.json');
  const billsFx = J('fixtures/bills_fy26.json').bills; // update-16: the 4 bills of HDFC ERGO (real, 17-Oct-2026)
  const stockFx = J('fixtures/inventory_valuation_fy26.json'); // update-17: Zoho's Inventory Valuation Summary at 31-Mar-2026 (real, 17-Oct-2026): 819 item lines
  const itemsFx = J('fixtures/item_list_fy26.json'); // update-19: Zoho's item list (the unit of each item), one record per SKU of the stock summary; made up for the replay (see its _about)
  const invLedgerFx = J('fixtures/inventory_asset_ledger_fy26.json'); // update-18: the real ledger of Inventory Asset (6,504 lines, closing 2,62,02,924.62), compact
  const cwipFx = J('fixtures/cwip_fy26.json'); // update-20: the real ledgers of Capital Work in Progress and Intangible Asset Under Development (102 + 82 lines) and the 137 journals behind them (17-Oct-2026)
  const splitsFx = J('fixtures/splits_fy26.json'); // update-15: ledger rows of the four split accounts + the clean-up journals behind them (real, 17-Oct-2026)
  const dir = path.join(root, 'fixtures/gl/raw');
  const glPages = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  const calls = [];
  const stats = { calls: 0 };
  let advanceRows = null;
  let cardCalls = 0;
  const billCalls = []; // the ids of the bills asked for (update-16)

  let splitJournalCalls = 0;
  const cwipJournalCalls = []; // the ids of the CWIP / IAUD journals asked for (update-20)
  const cwipBillCalls = []; // the ids of the CWIP / IAUD bills asked for (update-22)
  const cwipBillRaw = (id) => { // a bill behind the CWIP / IAUD accounts, made from its lines in the saved ledger (update-22)
    const mine = cwipFx.groups.flatMap((g) => g.rows).filter((r) => r.transaction_id === id && r.transaction_type === 'bill');
    if (!mine.length) return null;
    const lines = mine.map((r, i) => ({ line_item_id: `${id}-${i}`, account_id: r.account_id, item_total: Number(r.debit || 0) - Number(r.credit || 0), project_name: r.project_name, location_name: r.branch?.location_name ?? '', description: `line ${i + 1} of ${mine.length}` }));
    lines.push({ line_item_id: `${id}-x`, account_id: '2346113000004482477', item_total: 111, project_name: 'LE0188_UTTAM STRIPS', location_name: 'Head Office', description: 'freight to a customer (another account)' });
    return { code: 0, message: 'success', bill: { bill_id: id, bill_number: mine[0].entity_number, notes: mine[0].description ?? '', location_name: mine[0].branch?.location_name ?? '', line_items: lines } };
  };
  const rawJournal = (id) => {
    if (cwipFx.journals[id]) { // a journal behind the CWIP / IAUD accounts (update-20)
      cwipJournalCalls.push(id);
      if ((options.cwipJournalMissing ?? []).includes(id)) return null;
      const j = cwipFx.journals[id];
      const raw = { code: 0, message: 'success', journal: { entry_number: j.entry_number, notes: j.notes, line_items: j.lines.map((l) => ({ account_id: l.account_id, account_name: l.name, customer_id: '', debit_or_credit: l.dc, amount: l.amount })) } };
      return options.cwipJournalEdit ? options.cwipJournalEdit(id, raw) : raw;
    }
    if (splitsFx.journals[id]) { // a clean-up journal behind a deposit account (update-15)
      if ((options.splitJournalMissing ?? []).includes(id)) return null;
      splitJournalCalls += 1;
      const j = splitsFx.journals[id];
      const raw = { code: 0, message: 'success', journal: { entry_number: j.entry, notes: j.notes, line_items: j.lines.map((l) => ({ account_id: l.account_id, account_name: l.name, customer_id: '', debit_or_credit: l.debit ? 'debit' : 'credit', amount: l.debit || l.credit })) } };
      return options.splitJournalEdit ? options.splitJournalEdit(id, raw) : raw;
    }
    const j = journalsNorm[id];
    if (!j) return null;
    const lines = j.lines.map((l) => ({ account_id: l.account_id, customer_id: l.contact_id, debit_or_credit: l.debit ? 'debit' : 'credit', amount: l.debit || l.credit }));
    const raw = { code: 0, message: 'success', journal: { entry_number: j.entry_number, line_items: lines } };
    return options.journalEdit ? options.journalEdit(id, raw) : raw;
  };

  async function get(p, query = {}) {
    calls.push({ path: p, query });
    stats.calls++;
    if (p === '/reports/trialbalance') {
      const raw = structuredClone(tb);
      if (!(query.select_columns ?? []).some((c) => c.field === 'closing_balance')) {
        const body = raw.data ?? raw;
        for (const g of body.trialbalance[0].account_transactions) {
          for (const r of g.account_transactions) for (const k of ['opening_balance', 'closing_balance', 'debit_total', 'credit_total', 'values']) delete r[k];
        }
      }
      return raw;
    }
    if (p === '/reports/aragingsummary') {
      const root_ = structuredClone(ar);
      const r = root_.data ?? root_;
      if (options.agingDate) r.page_context.as_of_date = r.page_context.to_date = options.agingDate;
      if (!(query.include_manual_journals === 'true' && query.include_credit_notes === 'true')) {
        const list = r.invoice.group_list[0].group_list;
        r.invoice.group_list[0].group_list = list.filter((_, i) => i % 3 !== 0); // customers whose balance sits in journals are missing
      }
      const n = options.agingPages ?? 1;
      if (n > 1) {
        const all = r.invoice.group_list[0].group_list;
        const size = Math.ceil(all.length / n);
        const page = Number(query.page ?? 1);
        r.invoice.group_list[0].group_list = all.slice((page - 1) * size, page * size);
        r.page_context.page = page;
        r.page_context.has_more_page = page < n;
      }
      return root_;
    }
    if (p === '/reports/generalledgerdetails' && (query.rule?.columns?.[0]?.value ?? []).includes(ADVANCE_ACCOUNT_ID)) {
      advanceRows ??= options.advanceRows ?? syntheticAdvanceRows();
      const rows = advanceRows.map((r) => ({ ...r, account_id: options.advanceIgnoreRule ? '999' : r.account_id }));
      return { data: { account_transactions: [{ account_transactions: rows }], page_context: { page: 1, total: rows.length, has_more_page: false, from_date: query.from_date, to_date: query.to_date } } };
    }
    if (p === '/reports/generalledgerdetails' && (query.rule?.columns?.[0]?.value ?? []).includes(invLedgerFx.account_id)) { // update-18: the ledger of Inventory Asset, in pages like the real answer
      if (options.stockLedgerFail === 'refused') throw new ZohoError('Zoho /reports/generalledgerdetails failed: You are not authorized to perform this operation (HTTP 401)', { status: 401, code: 57, path: p });
      let rows = structuredClone(invLedgerFx.rows);
      if (options.stockLedgerRows) rows = options.stockLedgerRows(rows);
      const perPage = Number(query.per_page ?? 200);
      const page = Number(query.page ?? 1);
      const lines = rows.slice((page - 1) * perPage, page * perPage).map(([date, type, debit, credit, location, txn], i) => ({
        date, account_name: invLedgerFx.account_name, transaction_details: location, transaction_id: txn ?? `${900000000 + (page - 1) * perPage + i}`, transaction_type: type, entity_number: '',
        debit: debit || '', credit: credit || '', contact_id: '-1', contact_name: 'Unassociated Transactions',
        account_id: options.stockLedgerIgnoreRule ? '999' : invLedgerFx.account_id, branch: { location_name: location },
      }));
      return {
        data: {
          account_transactions: [{ group_name: invLedgerFx.account_id, account_transactions: lines }],
          page_context: { page, per_page: perPage, total: rows.length, total_pages: Math.ceil(rows.length / perPage), has_more_page: page * perPage < rows.length, from_date: query.from_date, to_date: query.to_date },
        },
      };
    }
    if (p === '/reports/generalledgerdetails' && (query.rule?.columns?.[0]?.value ?? []).some((id) => cwipFx.groups.some((g) => g.group_name === id))) { // update-20: the ledgers of the CWIP and IAUD accounts
      if (options.cwipFail === 'refused') throw new ZohoError('Zoho /reports/generalledgerdetails failed: You are not authorized to perform this operation (HTTP 401)', { status: 401, code: 57, path: p });
      const asked = new Set((query.select_columns ?? []).map((c) => c.field));
      const ids = (query.rule.columns[0].value ?? []).map(String);
      let groups = cwipFx.groups.filter((g) => ids.includes(g.group_name)).map((g) => ({ group_name: g.group_name, rows: structuredClone(g.rows) }));
      if (!options.cwipKeepBillLines) { // like the real REST report: one line per bill and account, the project of one of the lines (update-22)
        groups = groups.map((g) => {
          const by = new Map();
          for (const r of g.rows) if (r.transaction_type === 'bill') { const k = `${r.transaction_id}|${r.account_id}`; by.set(k, [...(by.get(k) ?? []), r]); }
          const merged = new Map();
          for (const [k, rs] of by) if (rs.length > 1) {
            const keep = structuredClone(rs[Math.floor(rs.length / 2)]);
            keep.debit = rs.reduce((t, r) => t + Number(r.debit || 0), 0) || '';
            keep.credit = rs.reduce((t, r) => t + Number(r.credit || 0), 0) || '';
            merged.set(k, keep);
          }
          const seen = new Set();
          const rows = [];
          for (const r of g.rows) {
            const k = `${r.transaction_id}|${r.account_id}`;
            if (r.transaction_type === 'bill' && merged.has(k)) { if (!seen.has(k)) { seen.add(k); rows.push(merged.get(k)); } } else rows.push(r);
          }
          return { ...g, rows };
        });
      }
      if (options.cwipRows) groups = options.cwipRows(groups);
      return {
        data: {
          account_transactions: groups.map((g) => ({
            group_name: g.group_name,
            account_transactions: g.rows.map((r) => {
              const line = { ...r };
              if (!asked.has('project_name')) delete line.project_name; // like the real answer: these columns come only when they are asked for
              if (!asked.has('description')) delete line.description;
              if (!asked.has('location_name')) delete line.branch;
              if (options.cwipIgnoreRule) line.account_id = '999';
              return line;
            }),
          })),
          page_context: { page: 1, has_more_page: false, from_date: query.from_date, to_date: query.to_date },
        },
      };
    }
    if (p === '/reports/generalledgerdetails' && (query.rule?.columns?.[0]?.value ?? []).some((id) => splitsFx.ledger[id])) { // the four deposit / PF accounts (update-15)
      if (options.splitsFail === 'ledger') throw new ZohoError('Zoho /reports/generalledgerdetails failed: You are not authorized to perform this operation (HTTP 401)', { status: 401, code: 57, path: p });
      const ids = (query.rule.columns[0].value ?? []).map(String);
      const groups = ids.filter((id) => splitsFx.ledger[id]).map((id) => {
        let rows = splitsFx.ledger[id];
        if (options.splitRows) rows = options.splitRows(id, structuredClone(rows));
        return {
          group_name: id,
          account_transactions: rows.map((r) => ({
            date: r.date, account_name: 'x', transaction_details: r.text, transaction_id: r.txn, transaction_type: r.type, entity_number: r.entry,
            debit: r.debit || '', credit: r.credit || '', contact_id: '-1', contact_name: 'Unassociated Transactions', account_id: options.splitsIgnoreRule ? '999' : id,
          })),
        };
      });
      return { data: { account_transactions: groups, page_context: { page: 1, has_more_page: false, from_date: query.from_date, to_date: query.to_date } } };
    }
    if (p === '/reports/generalledgerdetails') {
      const page = Number(query.page ?? 1);
      const raw = structuredClone(glPages[page - 1]);
      if (options.ignoreRule) {
        const r = raw.data ?? raw;
        r.account_transactions[0].account_transactions[0].account_id = '999';
      }
      return raw;
    }
    if (p === '/reports/inventoryvaluation') { // update-17: pages of per_page lines, with the totals of the whole report in page_context.sum_columns (as the real answer has them)
      if (options.stockFail === 'refused') throw new ZohoError('Zoho /reports/inventoryvaluation failed: You are not authorized to perform this operation (HTTP 401)', { status: 401, code: 57, path: p });
      let items = structuredClone(stockFx.items);
      if (options.stockItems) items = options.stockItems(items);
      const perPage = Number(query.per_page ?? 200);
      const page = Number(query.page ?? 1);
      const value = items.reduce((t, x) => t + (x.asset_value ?? 0), 0);
      const qty = items.reduce((t, x) => t + (x.quantity_available ?? 0), 0);
      const date = options.stockDate ?? query.to_date;
      const total = options.stockTotal ?? value;
      return {
        code: 0, message: 'success',
        inventory_valuation: items.slice((page - 1) * perPage, page * perPage),
        page_context: {
          ...stockFx.page_context, page, per_page: perPage, total: items.length, total_pages: Math.ceil(items.length / perPage), has_more_page: page * perPage < items.length,
          as_of_date: date, to_date: date, sum_columns: { quantity_available: String(qty), asset_value: total },
        },
      };
    }
    if (p === '/items') { // update-19: the item list (the unit of each item); inactive items only when asked for, as Zoho does
      if (options.itemsFail === 'refused') throw new ZohoError('Zoho /items failed: You are not authorized to perform this operation (HTTP 401)', { status: 401, code: 57, path: p });
      let items = structuredClone(itemsFx.items);
      if (options.itemsList) items = options.itemsList(items);
      if (query.filter_by !== 'Status.All') items = items.filter((x) => x.status === 'active');
      const perPage = Number(query.per_page ?? 200);
      const page = Number(query.page ?? 1);
      return {
        code: 0, message: 'success',
        items: items.slice((page - 1) * perPage, page * perPage),
        page_context: { page, per_page: perPage, has_more_page: page * perPage < items.length, report_name: 'Items', applied_filter: query.filter_by ?? 'Status.Active', sort_column: query.sort_column ?? 'name', sort_order: 'A' },
      };
    }
    if (p.startsWith('/bills/') && !billsFx[p.slice('/bills/'.length)]) { // update-22: a bill behind the CWIP / IAUD accounts
      const id = p.slice('/bills/'.length);
      cwipBillCalls.push(id);
      if (options.cwipBillsFail === 'all' || (Array.isArray(options.cwipBillsFail) && options.cwipBillsFail.includes(id))) throw new ZohoError('Zoho /bills failed: You are not authorized to perform this operation (HTTP 401)', { status: 401, code: 57, path: p });
      const raw = cwipBillRaw(id);
      if (!raw) throw new ZohoError(`Zoho ${p} failed: The bill does not exist. (HTTP 404)`, { status: 404, code: 1002, path: p });
      return options.cwipBillEdit ? options.cwipBillEdit(id, raw) : raw;
    }
    if (p.startsWith('/bills/')) { // update-16
      const id = p.slice('/bills/'.length);
      billCalls.push(id);
      if (options.billsFail === 'all' || (Array.isArray(options.billsFail) && options.billsFail.includes(id))) throw new ZohoError('Zoho /bills failed: You are not authorized to perform this operation (HTTP 401)', { status: 401, code: 57, path: p });
      if (!billsFx[id]) throw new ZohoError(`Zoho ${p} failed: The bill does not exist. (HTTP 404)`, { status: 404, code: 1002, path: p });
      const raw = structuredClone(billsFx[id]);
      if (options.billState?.[id] !== undefined) raw.bill.billing_address = { state: options.billState[id] };
      return raw;
    }
    if (p.startsWith('/journals/')) {
      const raw = rawJournal(p.slice('/journals/'.length));
      if (!raw) { const e = new Error('Journal not found'); e.status = 404; throw e; }
      return raw;
    }
    if (p === '/vendors') return structuredClone(vendors);
    if (p.startsWith('/contacts/')) { // a vendor card (update-14: the Vendor Code); the codes are the signed ones (fixtures/vbs_fy26.json; Zoho's list of 17-Oct-2026 agreed with the sheet for every vendor of the sheet it showed)
      const id = p.slice('/contacts/'.length);
      cardCalls += 1;
      if (options.codesRateAfter !== undefined && cardCalls > options.codesRateAfter) throw new ZohoError('Zoho /contacts failed: You have reached the maximum number of requests allowed (HTTP 429)', { status: 429, code: 45, path: p });
      const f = vbsFixture[id];
      if (!f || (options.codesMissing ?? []).includes(id)) throw new ZohoError(`Zoho ${p} failed: Invalid value passed for contact_id (HTTP 404)`, { status: 404, code: 1002, path: p });
      const code = options.codes?.[id] ?? f.code ?? '';
      const hash = code ? { cf_vendor_code: code, cf_vendor_code_formatted: code, cf_vendor_code_unformatted: code } : {};
      const fields = code ? [{ api_name: 'cf_vendor_code', label: 'Vendor Code', value: code }] : [];
      return { code: 0, message: 'success', contact: { contact_id: id, contact_name: f.name, contact_type: 'vendor', custom_fields: fields, custom_field_hash: hash } };
    }
    if (p === '/reports/customerbalancesummary') {
      if (options.ageingFail === 'balances') throw new ZohoError('Zoho /reports/customerbalancesummary failed: You are not authorized to perform this operation (HTTP 401)', { status: 401, code: 57, path: p });
      if (options.halfFail && query.to_date === '2025-09-30') throw new ZohoError('Zoho /reports/customerbalancesummary failed: You are not authorized to perform this operation (HTTP 401)', { status: 401, code: 57, path: p });
      const file = { '2026-03-31': 'fixtures/cbs_2026-03-31.raw.json', '2025-03-31': 'fixtures/cbs_2025-03-31.raw.json', '2025-09-30': 'fixtures/cbs_2025-09-30.raw.json' }[query.to_date];
      if (!file) throw new Error(`replayZoho: no saved customer balance summary for ${query.to_date}`);
      const raw = J(file);
      if (options.balancesDate) raw.page_context.as_of_date = raw.page_context.to_date = options.balancesDate;
      if (options.halfDate && query.to_date === '2025-09-30') raw.page_context.as_of_date = raw.page_context.to_date = options.halfDate;
      return raw;
    }
    if (p === '/reports/salesbycustomer') {
      if (options.ageingFail === 'sales') throw new ZohoError('Zoho /reports/salesbycustomer failed: You are not authorized to perform this operation (HTTP 401)', { status: 401, code: 57, path: p });
      if (options.halfFail && query.to_date === '2025-09-30') throw new ZohoError('Zoho /reports/salesbycustomer failed: You are not authorized to perform this operation (HTTP 401)', { status: 401, code: 57, path: p });
      const file = { '2025-10-01|2026-03-31': 'fixtures/sbc_2025-10-01_2026-03-31.raw.json', '2025-04-01|2025-09-30': 'fixtures/sbc_2025-04-01_2025-09-30.raw.json' }[`${query.from_date}|${query.to_date}`];
      if (!file) throw new Error(`replayZoho: no saved sales by customer for ${query.from_date} to ${query.to_date}`);
      const raw = J(file);
      if (options.salesRange) [raw.page_context.from_date, raw.page_context.to_date] = options.salesRange;
      if (!(query.select_columns ?? []).some((c) => c.field === 'invoice_amount')) {
        // what the real report sends when the columns are not named (found on 16-Oct-2026)
        raw.sales = raw.sales.map(({ customer_name, customer_id, count, invoice_amount, creditnote_amount }) => ({ customer_name, customer_id, count, sales: (invoice_amount - creditnote_amount) / 1.18, sales_with_tax: invoice_amount - creditnote_amount }));
      }
      return raw;
    }
    if (p === '/reports/vendorbalancesummary') {
      if (options.vbs === 'refused') throw new ZohoError('Zoho /reports/vendorbalancesummary failed: You are not authorized to perform this operation (HTTP 401)', { status: 401, code: 57, path: p });
      const ids = (query.rule?.columns?.[0]?.value ?? []).map(String);
      const k = (id) => Number(String(id).slice(-3));
      const open = query.to_date === '2025-03-31';
      const rows = ids.map((id) => {
        const f = vbsFixture[id];
        const billed = f ? (open ? f.billedOpen : f.billedNow) : open ? 100000 + k(id) : 105000 + 2 * k(id);
        const paid = f ? (open ? f.paidOpen : f.paidNow) : open ? 90000 : 94000 + k(id);
        return { vendor_name: `Vendor ${id}`, vendor_id: id, currency_id: '1', billed_amount: billed, amount_paid: paid, closing_balance: billed - paid, non_default_currency_values: [], vendor: {} };
      });
      if (options.vbsIgnoreFilter) rows.push({ vendor_name: 'Somebody else', vendor_id: '1', currency_id: '1', billed_amount: 1, amount_paid: 1, closing_balance: 0, non_default_currency_values: [], vendor: {} });
      const date = options.vbsDate ?? query.to_date;
      return { code: 0, message: 'success', vendorbalancesummary: options.vbsFlat ? rows : [{ vendorbalancesummary: rows }], page_context: { page: 1, per_page: 500, has_more_page: false, as_of_date: date, to_date: date } };
    }
    throw new Error(`replayZoho: unexpected request ${p}`);
  }
  return { get, stats, calls, billCalls, cwipJournalCalls, cwipBillCalls, orgId: '60038956413', dc: 'in' };
}
