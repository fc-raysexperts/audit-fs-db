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
  ['fixtures/tb_fy26_nonzero.raw.json', 'fixtures/tb_fy25_nonzero.raw.json', 'fixtures/tb_fy25_nonzero.raw.json', 'fixtures/ar_aging_2026-03-31.raw.json', 'fixtures/gl/raw/gl_party_p1.json', 'fixtures/gl/journals_merged.json', 'fixtures/vendors_imprest_staff.raw.json', 'fixtures/cbs_2026-03-31.raw.json', 'fixtures/cbs_2025-03-31.raw.json', 'fixtures/cbs_2025-09-30.raw.json', 'fixtures/sbc_2025-10-01_2026-03-31.raw.json', 'fixtures/sbc_2025-04-01_2025-09-30.raw.json', 'fixtures/vbs_fy26.json', 'fixtures/inventory_valuation_fy26.json', 'fixtures/cwip_fy26.json']
    .every((f) => fs.existsSync(path.join(root, f)));

export const ADVANCE_ACCOUNT_ID = '2346113000000000617'; // "Advance from debtors"

export const COMPANY_ORG = '60038956413';
export const SPV_ORG = '60039002178'; // Rays Rooftop SPV: its Zoho user is disabled (code 6018), as on the real books on 21-Oct-2026

/**
 * update-28: a subsidiary's trial balance as Zoho's report sends it, made from the compact accounts of fixtures/subsidiaries_fy26.json
 * ([type, id, name, code, closing (debit +, credit -), plkind]). Income and expense lines carry the movement of the whole life as their closing balance, like the real report.
 */
export function subTrialBalanceRaw(accounts, { from, to }) {
  const groups = [['asset', 'Assets'], ['liability', 'Liabilities'], ['equity', 'Equities'], ['income', 'Income'], ['expense', 'Expense']];
  const row = ([, id, name, code, closing]) => ({
    account_id: id, name, account_code: code ?? '', depth: 0, is_child_present: false,
    opening_balance: 0, debit_total: closing > 0 ? closing : 0, credit_total: closing < 0 ? -closing : 0, closing_balance: closing,
  });
  const debit = accounts.reduce((t, a) => t + (a[4] > 0 ? a[4] : 0), 0);
  const credit = accounts.reduce((t, a) => t + (a[4] < 0 ? -a[4] : 0), 0);
  return {
    status: 'success',
    data: {
      code: 0, message: 'success',
      trialbalance: [{
        name: 'Total', debit_total: debit, credit_total: credit,
        account_transactions: groups.map(([type, name]) => ({ account_type: type, name, account_transactions: accounts.filter((a) => a[0] === type).map(row) })),
      }],
      page_context: { report_basis: 'Accrual', from_date: from, to_date: to, show_rows: 'non_zero', is_inv_txn_job_in_progress: false },
    },
  };
}

/** update-28: a subsidiary's profit and loss as the new-flow report sends it (a tree of headings with the accounts under them). Income is shown positive, expense positive. */
export function subProfitLossRaw(accounts, { from, to }) {
  const kinds = { oi: 'operating_income', cogs: 'cost_of_goods_sold', oe: 'operating_expense', noi: 'non_operating_income', noe: 'non_operating_expense' };
  const sign = { oi: -1, cogs: 1, oe: 1, noi: -1, noe: 1 };
  const sum = {};
  const node = (name, total, rows = []) => ({ node_name: name, name, type: 'group', values: [{ total, total_sub_account: total }], accounts: rows });
  const tree = [];
  for (const [kind, name] of Object.entries(kinds)) {
    const mine = accounts.filter((a) => a[5] === kind);
    const rows = mine.map((a) => ({ type: 'account', account_id: a[1], account_code: a[3] ?? '', name: a[2], values: [{ total: sign[kind] * a[4], total_sub_account: sign[kind] * a[4] }], accounts: [] }));
    sum[kind] = rows.reduce((t, r) => t + r.values[0].total, 0);
    tree.push(node(name, sum[kind], rows));
  }
  const gross = sum.oi - sum.cogs;
  const operating = gross - sum.oe;
  const net = operating + sum.noi - sum.noe;
  const order = ['operating_income', 'cost_of_goods_sold', 'gross_profit', 'operating_expense', 'operating_profit', 'non_operating_income', 'non_operating_expense', 'net_profit_loss', 'other_comprehensive_income'];
  const by = Object.fromEntries(tree.map((n) => [n.node_name, n]));
  by.gross_profit = node('gross_profit', gross);
  by.operating_profit = node('operating_profit', operating);
  by.net_profit_loss = node('net_profit_loss', net);
  by.other_comprehensive_income = node('other_comprehensive_income', 0);
  return { code: 0, message: 'success', data: { profit_and_loss: { accounts: order.map((k) => by[k]) }, page_context: { report_basis: 'Accrual', from_date: from, to_date: to } } };
}

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
 * options.cwipOldFail    -> 'refused': the ledger of the OLD accounts behind two clean-up journals is refused (update-25); cwipOldRows(groups) edits it, cwipOldIgnoreRule: the account filter is ignored
 * options.cwipBillsFail -> 'all' | [ids]: those bills behind the two accounts are refused (HTTP 401, code 57)
 * options.cwipBillEdit  -> function(id, raw) -> raw: change a bill behind the two accounts before it is returned
 * (a bill behind the two accounts is answered from the saved ledger lines of that bill, with one more line of another account so that the account of each line has to be looked at)
 * options.relatedSalesFail      -> 'refused': the sales by customer of the related customers is refused (HTTP 401, code 57) (update-27); relatedSalesIgnoreRule: it also lists a customer that was not asked for; relatedSalesRange: [from, to] it claims; relatedSales(sales) edits the lines
 * options.relatedPurchasesFail   -> 'refused': the ledger of the related vendors' cards is refused (update-27); relatedPurchasesRows(id, rows) edits the compact lines [date, type, entry, account, account type, debit, credit] of a vendor card; relatedPurchasesIgnoreContact / relatedPurchasesIgnoreTypes: the filter is ignored
 * options.relatedLedgersFail     -> 'refused': the ledgers of the loan, remuneration and foreign-supplier accounts are refused (update-27); relatedLedgersRows(id, rows) edits the compact lines of an account; relatedLedgersIgnoreRule: the filter is ignored
 * options.priorFail      -> 'refused': last year's Trial Balance (from 1-Apr-2024) is refused (HTTP 401, code 57) (update-31); priorDate: it claims to end on this date; priorEdit(raw) edits the raw answer
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
  const tb25 = J('fixtures/tb_fy25_nonzero.raw.json');
  const ar = J('fixtures/ar_aging_2026-03-31.raw.json');
  const vendors = J('fixtures/vendors_imprest_staff.raw.json');
  const vbsFixture = J('fixtures/vbs_fy26.json').vendors;
  const journalsNorm = J('fixtures/gl/journals_merged.json');
  const billsFx = J('fixtures/bills_fy26.json').bills; // update-16: the 4 bills of HDFC ERGO (real, 17-Oct-2026)
  const stockFx = J('fixtures/inventory_valuation_fy26.json'); // update-17: Zoho's Inventory Valuation Summary at 31-Mar-2026 (real, 17-Oct-2026): 819 item lines
  const itemsFx = J('fixtures/item_list_fy26.json'); // update-19: Zoho's item list (the unit of each item), one record per SKU of the stock summary; made up for the replay (see its _about)
  const invLedgerFx = J('fixtures/inventory_asset_ledger_fy26.json'); // update-18: the real ledger of Inventory Asset (6,504 lines, closing 2,62,02,924.62), compact
  const cwipBillsFx = J('fixtures/cwip_bills_fy26.json'); // update-23: the lines of the 12 bills with several lines to one account, as Zoho's own bills give them (the saved ledger is the connector's, which added up lines of one project)
  const cwipOldFx = J('fixtures/cwip_old_ledgers_fy26.json'); // update-25: two OLD ledger accounts (the ones of JN-Clean-112 and JN-Clean-225) with their original bills, as Zoho gave them on 19-Oct-2026
  const cwipFx = J('fixtures/cwip_fy26.json'); // update-20: the real ledgers of Capital Work in Progress and Intangible Asset Under Development (102 + 82 lines) and the 137 journals behind them (17-Oct-2026)
  const relFx = J('fixtures/related_fy26.json'); // update-27: what Zoho gave on 21-Oct-2026 for the related parties (sales of 4 customers, the purchase lines of 10 vendor cards, 6 account ledgers), cut down
  const subsFx = J('fixtures/subsidiaries_fy26.json').subs; // update-28: the trial balances and profit and loss lines of four subsidiaries (real, 21-Oct-2026); the Rooftop SPV is not there
  const taxFx = J('fixtures/advance_tax_fy26.json'); // update-30: the real ledger of the two advance tax accounts (seven payments and the journal JN-Clean-3 that moved the balance), 21-Oct-2026
  const regFx = J('fixtures/register_fy26.json'); // update-28: Zoho's fixed asset register (502 assets) and the ledger lines of the Land and Development Rights accounts (real, 21-Oct-2026)
  const splitsFx = J('fixtures/splits_fy26.json'); // update-15: ledger rows of the four split accounts + the clean-up journals behind them (real, 17-Oct-2026)
  const dir = path.join(root, 'fixtures/gl/raw');
  const glPages = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  const calls = [];
  const stats = { calls: 0 };
  let advanceRows = null;
  let cardCalls = 0;
  const billCalls = []; // the ids of the bills asked for (update-16)
  const subCalls = []; // the reports asked of a subsidiary's organisation (update-28)
  const historyCalls = []; // the assets whose entries were asked for (update-29)
  let sheetHist = null;
  const histMemo = new Map();
  const rowMemo = new Map(); // update-30: the sheet line each asset was given (its Residual Value is the fake's salvage value)
  const detailCalls = []; // the assets whose settings were asked for (update-30)
  /** update-29: the entries of one asset, newest last: [type, date, depreciated, accumulated]. From the Dep.Calc. sheet: the line with the asset's code (the closest cost when a code is used twice). */
  const historyOf = (id) => {
    if (histMemo.has(id)) return histMemo.get(id);
    const ent = historyMake(id);
    histMemo.set(id, ent);
    return ent;
  };
  const historyMake = (id) => {
    if (!sheetHist) {
      const rows = readSheet(loadConfig('2025-26').workbook, 'dep-calc').rows.filter((r) => typeof r[0] === 'number' && r[5] && typeof r[4] === 'number');
      sheetHist = { rows, used: new Set() };
    }
    const a = regFx.assets.find((x) => x[0] === id);
    if (!a) return [];
    const [, code, , , , cost, value, date] = a;
    const free = sheetHist.rows.filter((r) => !sheetHist.used.has(r));
    let cands = free.filter((r) => String(r[5]).trim() === code).sort((x, y) => Math.abs(x[4] - cost) - Math.abs(y[4] - cost));
    if (!cands.length) cands = free.filter((r) => r[3]?.d === date && Math.abs(r[4] - cost) <= 1 && Math.abs((typeof r[16] === 'number' ? r[16] : 0) - value) <= 1); // a code the sheet uses for another asset: by date, cost and book value
    const row = cands[0];
    if (!row) return [['acquisition', date, 0, 0]];
    sheetHist.used.add(row);
    rowMemo.set(id, row);
    const n = (v) => (typeof v === 'number' ? v : 0);
    const before = date < '2025-04-01' ? n(row[7]) : 0;
    const ent = [['acquisition', date, 0, before]];
    if (n(row[18]) !== 0 || n(row[17]) !== before) ent.push(['depreciation', '2026-03-31', n(row[18]), n(row[17])]);
    return ent;
  };

  let splitJournalCalls = 0;
  const cwipJournalCalls = []; // the ids of the CWIP / IAUD journals asked for (update-20)
  const cwipBillCalls = []; // the ids of the CWIP / IAUD bills asked for (update-22)
  const cwipBillRaw = (id) => { // a bill behind the CWIP / IAUD accounts, made from its lines in the saved ledger (update-22)
    const mine = cwipFx.groups.flatMap((g) => g.rows).filter((r) => r.transaction_id === id && r.transaction_type === 'bill');
    if (!mine.length) return null;
    let lines = mine.map((r, i) => ({ line_item_id: `${id}-${i}`, account_id: r.account_id, item_total: Number(r.debit || 0) - Number(r.credit || 0), project_name: r.project_name, location_name: r.branch?.location_name ?? '', description: `line ${i + 1} of ${mine.length}` }));
    const real = cwipBillsFx[mine[0].entity_number]; // the bills the live tab showed with all their lines (update-23): the lines of Zoho's own bill, with the customer of each line and the Project Name field of the bill
    if (real && Math.abs(real.lines.reduce((t, x) => t + x[0], 0) - lines.reduce((t, l) => t + l.item_total, 0)) < 0.01) {
      const place = (project) => (mine.find((r) => r.project_name === project) ?? mine[0]).branch?.location_name ?? '';
      lines = real.lines.map(([amount, project, text, customer], i) => ({ line_item_id: `${id}-${i}`, account_id: mine[0].account_id, item_total: amount, project_name: project, location_name: place(project), description: text, customer_name: customer ?? '' }));
    }
    lines.push({ line_item_id: `${id}-x`, account_id: '2346113000004482477', item_total: 111, project_name: 'LE0188_UTTAM STRIPS', location_name: 'Head Office', description: 'freight to a customer (another account)' });
    const field = real?.project ? { custom_fields: [{ api_name: 'cf_project_name', label: 'Project Name :-', value: real.project }], custom_field_hash: { cf_project_name: real.project } } : {};
    return { code: 0, message: 'success', bill: { bill_id: id, bill_number: mine[0].entity_number, notes: mine[0].description ?? '', location_name: mine[0].branch?.location_name ?? '', ...field, line_items: lines } };
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
    if (query.organization_id && String(query.organization_id) !== COMPANY_ORG && (p === '/reports/trialbalance' || p === '/reports/profitandloss')) { // update-28: the books of a subsidiary
      const org = String(query.organization_id);
      const key = Object.keys(subsFx).find((k) => subsFx[k].org === org);
      subCalls.push({ org, path: p, from: query.from_date, to: query.to_date });
      if (org === SPV_ORG) throw new ZohoError(`Zoho ${p} failed: Your account is disabled in this organisation (HTTP 401)`, { status: 401, code: 6018, path: p });
      if (options.subsFail === 'refused' || (Array.isArray(options.subsFail) && options.subsFail.includes(key))) throw new ZohoError(`Zoho ${p} failed: You are not authorized to perform this operation (HTTP 401)`, { status: 401, code: 57, path: p });
      if (!key) throw new Error(`replayZoho: unknown organisation ${org}`);
      let accounts = structuredClone(subsFx[key].accounts);
      if (options.subsAccounts) accounts = options.subsAccounts(key, accounts);
      const range = { from: options.subsDates?.[0] ?? query.from_date, to: options.subsDates?.[1] ?? query.to_date };
      const raw = p === '/reports/trialbalance' ? subTrialBalanceRaw(accounts, range) : subProfitLossRaw(accounts, range);
      return options.subsEdit ? options.subsEdit(key, p, raw) : raw;
    }
    if (p === '/fixedassets') { // update-28: the fixed asset register, in pages like the real answer (every status when asked for)
      if (options.registerFail === 'refused') throw new ZohoError('Zoho /fixedassets failed: You are not authorized to perform this operation (HTTP 401)', { status: 401, code: 57, path: p });
      let list = regFx.assets.map(([fixed_asset_id, asset_number, asset_name, fixed_asset_type_name, status, asset_cost, current_asset_value, asset_purchase_date, total_life, depreciation_start_date]) => ({ fixed_asset_id, asset_number, asset_name, fixed_asset_type_name, status, asset_cost, current_asset_value, asset_purchase_date, ...(total_life === null || total_life === undefined ? {} : { total_life }), depreciation_start_date }));
      if (options.registerAssets) list = options.registerAssets(structuredClone(list));
      const perPage = Number(query.per_page ?? 200);
      const page = Number(query.page ?? 1);
      return { code: 0, message: 'success', [options.registerOldKey ? 'fixed_assets' : 'fixedassets']: list.slice((page - 1) * perPage, page * perPage), page_context: { page, per_page: perPage, has_more_page: page * perPage < list.length, applied_filter: query.filter_by ?? 'Status.Active' } };
    }
    const dm = /^\/fixedassets\/([^/]+)$/.exec(p);
    if (dm) { // update-30: the settings of one asset. MADE UP for the replay from five real answers of 21-Oct-2026: salvage_value = the Residual Value of the sheet line, depreciation_percentage = 100 x (1 - (salvage / cost) ^ (12 / life in months)), two decimals (the five real answers all follow that rule)
      detailCalls.push(dm[1]);
      if (options.detailFail === 'refused') throw new ZohoError('Zoho /fixedassets failed: You are not authorized to perform this operation (HTTP 401)', { status: 401, code: 57, path: p });
      if (options.detailRateLimit && detailCalls.length > options.detailRateLimit) throw new ZohoError('Zoho /fixedassets failed: too many requests (HTTP 429)', { status: 429, code: 45, path: p });
      if ((options.detailBroken ?? []).includes(dm[1])) throw new ZohoError('Zoho /fixedassets failed: not found (HTTP 404)', { status: 404, code: 1002, path: p });
      const a = regFx.assets.find((x) => x[0] === dm[1]);
      if (!a) throw new ZohoError('Zoho /fixedassets failed: not found (HTTP 404)', { status: 404, code: 1002, path: p });
      historyOf(dm[1]); // gives the asset its sheet line
      const row = rowMemo.get(dm[1]);
      const life = a[8] ?? 60;
      const salvage = row && typeof row[6] === 'number' ? row[6] : Math.round(a[5] * 0.05);
      let fixed_asset = { fixed_asset_id: dm[1], asset_number: a[1], asset_name: a[2], total_life: life, total_life_basis: 'months', depreciation_method: 'declining_method', depreciation_percentage: a[5] > 0 && salvage > 0 ? Math.round(100 * (1 - (salvage / a[5]) ** (12 / life)) * 100) / 100 : 0, asset_cost: a[5], salvage_value: salvage, depreciation_start_date: a[9] };
      if (options.detailEdit) fixed_asset = options.detailEdit(dm[1], structuredClone(fixed_asset));
      return { code: 0, message: 'success', fixed_asset };
    }
    const hm = /^\/fixedassets\/([^/]+)\/history$/.exec(p);
    if (hm) { // update-29: the entries of one asset, as Zoho sends them (14 real ones were compared with the sheet on 21-Oct-2026: acquisition + the depreciation entry of 31-03-2026); made from the Dep.Calc. sheet
      historyCalls.push(hm[1]);
      if (options.historyFail === 'refused') throw new ZohoError('Zoho /fixedassets history failed: You are not authorized to perform this operation (HTTP 401)', { status: 401, code: 57, path: p });
      if (options.historyRateLimit && historyCalls.length > options.historyRateLimit) throw new ZohoError('Zoho /fixedassets history failed: too many requests (HTTP 429)', { status: 429, code: 45, path: p });
      if ((options.historyBroken ?? []).includes(hm[1])) throw new ZohoError('Zoho /fixedassets history failed: not found (HTTP 404)', { status: 404, code: 1002, path: p });
      let ent = historyOf(hm[1]);
      if (options.historyEdit) ent = options.historyEdit(hm[1], structuredClone(ent));
      const asset_history = ent.map(([type, valuation_date, depreciated_value, accumulated_value], i) => ({ valuation_id: `${hm[1]}-${i}`, description: '', current_quantity: 1, valuation_date, depreciated_value, revise_value: type === 'depreciation' ? -depreciated_value : 0, current_value: 0, accumulated_value, type, is_journal_posted: type === 'depreciation' }));
      return { code: 0, message: 'success', asset_history, page_context: { page: 1, per_page: Number(query.per_page ?? 10), has_more_page: false } };
    }
    if (p === '/reports/generalledgerdetails' && query.rule?.columns?.[0]?.field === 'account_id' && (query.rule.columns[0].value ?? []).length && query.rule.columns[0].value.every((id) => taxFx.accounts[id])) { // update-30: the advance tax accounts
      if (options.taxFail === 'refused') throw new ZohoError('Zoho /reports/generalledgerdetails failed: You are not authorized to perform this operation (HTTP 401)', { status: 401, code: 57, path: p });
      const ids = (query.rule.columns[0].value ?? []).map(String);
      let groups = taxFx.groups.filter((g) => ids.includes(g.group_name)).map((g) => structuredClone(g));
      if (options.taxGroups) groups = options.taxGroups(groups);
      if (options.taxIgnoreRule) groups[0].account_transactions[0].account_id = '999';
      const total = groups.reduce((t, g) => t + g.account_transactions.length, 0);
      return { data: { account_transactions: groups, page_context: { page: 1, per_page: Number(query.per_page ?? 2000), total, total_pages: 1, has_more_page: false, from_date: query.from_date, to_date: query.to_date } } };
    }
    if (p === '/reports/generalledgerdetails' && query.rule?.columns?.[0]?.field === 'account_id' && (query.rule.columns[0].value ?? []).length && query.rule.columns[0].value.every((id) => regFx.ledger[id])) { // update-28: the Land and Development Rights accounts
      if (options.registerLedgerFail === 'refused') throw new ZohoError('Zoho /reports/generalledgerdetails failed: You are not authorized to perform this operation (HTTP 401)', { status: 401, code: 57, path: p });
      const ids = (query.rule.columns[0].value ?? []).map(String);
      const groups = ids.map((id) => {
        let rows = regFx.ledger[id].rows;
        if (options.registerLedgerRows) rows = options.registerLedgerRows(id, structuredClone(rows));
        return {
          group_name: id,
          account_transactions: rows.map(([date, type, entry, debit, credit, details], i) => ({
            date, account_name: regFx.ledger[id].name, transaction_details: details, transaction_id: `${id}-${i}`, transaction_type: type, entity_number: entry, debit: debit || '', credit: credit || '',
            contact_id: '-1', contact_name: 'Unassociated Transactions', account_id: options.registerLedgerIgnoreRule && i === 0 ? '999' : id, currency_code: 'INR', account: { account_group: 'asset', account_type: regFx.ledger[id].type },
          })),
        };
      });
      const total = groups.reduce((t, g) => t + g.account_transactions.length, 0);
      return { data: { account_transactions: groups, page_context: { page: 1, per_page: Number(query.per_page ?? 2000), total, total_pages: 1, has_more_page: false, from_date: query.from_date, to_date: query.to_date } } };
    }
    if (p === '/reports/trialbalance') {
      const lastYear = query.from_date === '2024-04-01'; // update-31: the year before (the real Trial Balance of 31-Mar-2025, saved 21-Oct-2026)
      if (lastYear && options.priorFail === 'refused') throw new ZohoError('Zoho /reports/trialbalance failed: You are not authorized to perform this operation (HTTP 401)', { status: 401, code: 57, path: p });
      const raw = structuredClone(lastYear ? tb25 : tb);
      if (lastYear && options.priorDate) (raw.data ?? raw).page_context.to_date = options.priorDate;
      if (lastYear && options.priorEdit) return options.priorEdit(raw);
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
    if (p === '/reports/salesbycustomer' && query.rule?.columns?.[0]?.field === 'customer_id') { // update-27: the related customers
      if (options.relatedSalesFail === 'refused') throw new ZohoError('Zoho /reports/salesbycustomer failed: You are not authorized to perform this operation (HTTP 401)', { status: 401, code: 57, path: p });
      const ids = (query.rule.columns[0].value ?? []).map(String);
      let sales = relFx.sales.filter(([id]) => ids.includes(id)).map(([customer_id, customer_name, sold, withTax]) => ({ customer_name, customer_id, count: 1, sales: sold, sales_with_tax: withTax, currency_code: 'INR' }));
      if (options.relatedSalesIgnoreRule) sales.push({ customer_name: 'Somebody else', customer_id: '1', count: 1, sales: 1, sales_with_tax: 1, currency_code: 'INR' });
      if (options.relatedSales) sales = options.relatedSales(sales);
      const [from, to] = options.relatedSalesRange ?? [query.from_date, query.to_date];
      return { code: 0, message: 'success', sales, page_context: { page: 1, per_page: 500, total: sales.length, total_pages: 1, has_more_page: false, from_date: from, to_date: to } };
    }
    if (p === '/reports/generalledgerdetails' && query.rule?.columns?.[0]?.field === 'contact_id') { // update-27: the ledger of the related vendors' cards, bills and vendor credits
      if (options.relatedPurchasesFail === 'refused') throw new ZohoError('Zoho /reports/generalledgerdetails failed: You are not authorized to perform this operation (HTTP 401)', { status: 401, code: 57, path: p });
      const ids = (query.rule.columns[0].value ?? []).map(String);
      const types = query.rule.columns.find((c) => c.field === 'transaction_type')?.value ?? null;
      const lines = [];
      const line = (cid, date, type, entry, account, at, debit, credit) => ({
        date, account_name: account, account_id: `acct-${normName(account)}`, transaction_details: '', transaction_id: `${cid}-${entry}-${lines.length}`, transaction_type: type, entity_number: entry,
        debit: debit || '', credit: credit || '', contact_id: cid, currency_code: 'INR', account: { account_group: at === 'accounts_payable' ? 'liability' : 'expense', account_type: at },
      });
      for (const id of ids) {
        let rows = relFx.purchases[id] ?? [];
        if (options.relatedPurchasesRows) rows = options.relatedPurchasesRows(id, structuredClone(rows));
        const seen = new Set();
        for (const [date, type, entry, account, at, debit, credit] of rows) {
          if (types && !types.includes(type)) continue;
          lines.push(line(id, date, type, entry, account, at, debit, credit));
          const key = `${type}|${entry}`;
          if (!seen.has(key)) { // beside the purchase lines Zoho sends the payable and the GST of the same bill, which are not purchases
            seen.add(key);
            const net = rows.filter((x) => x[1] === type && x[2] === entry).reduce((t, x) => t + (x[5] ?? 0) - (x[6] ?? 0), 0);
            lines.push(line(id, date, type, entry, 'Accounts Payable', 'accounts_payable', net < 0 ? -net : 0, net > 0 ? net : 0));
            lines.push(line(id, date, type, entry, 'Input CGST', 'other_current_asset', net > 0 ? 1 : 0, net < 0 ? 1 : 0));
          }
        }
      }
      if (options.relatedPurchasesIgnoreContact) lines.push(line('1', '2025-05-01', 'bill', 'X-1', 'Office Expenses', 'expense', 5, 0));
      if (options.relatedPurchasesIgnoreTypes) lines.push(line(ids[0], '2025-05-01', 'journal', 'J-1', 'Office Expenses', 'expense', 5, 0));
      return { data: { account_transactions: [{ account_transactions: lines }], page_context: { page: 1, per_page: Number(query.per_page ?? 2000), total: lines.length, total_pages: 1, has_more_page: false, from_date: query.from_date, to_date: query.to_date } } };
    }
    if (p === '/reports/generalledgerdetails' && query.rule?.columns?.[0]?.field === 'account_id' && (query.rule.columns[0].value ?? []).length && query.rule.columns[0].value.every((id) => relFx.ledgers[id])) { // update-27: the loan, remuneration and foreign-supplier accounts (and only these: the party ledger asks for these among a thousand others)
      if (options.relatedLedgersFail === 'refused') throw new ZohoError('Zoho /reports/generalledgerdetails failed: You are not authorized to perform this operation (HTTP 401)', { status: 401, code: 57, path: p });
      const ids = (query.rule.columns[0].value ?? []).map(String).filter((id) => relFx.ledgers[id]);
      const groups = ids.map((id) => {
        let rows = relFx.ledgers[id].rows;
        if (options.relatedLedgersRows) rows = options.relatedLedgersRows(id, structuredClone(rows));
        const fx = relFx.ledgers[id];
        const shown = (v) => (v === 0 ? '0.00' : Math.abs(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
        const bal = (name, date, v) => ({ date, name, debit: v < 0 ? shown(v) : '', credit: v < 0 ? '' : shown(v), account_credit_balance: v }); // credit-positive, like Zoho's own group lines (update-31)
        const opening = options.relatedOpening ? options.relatedOpening(id, fx.opening) : fx.opening;
        const closing = options.relatedClosing ? options.relatedClosing(id, fx.closing) : fx.closing;
        return {
          group_name: id,
          ...(fx.opening !== undefined && !options.relatedNoBalances ? { opening_balance: bal('Opening Balance', `As On 01/04/2025`, opening), closing_balance: bal('Closing Balance', `As On 31/03/2026`, closing) } : {}),
          account_transactions: rows.map(([date, type, entry, debit, credit, details, cid, cname], i) => ({
            date, account_name: relFx.ledgers[id].name, transaction_details: details, transaction_id: `${id}-${i}`, transaction_type: type, entity_number: entry, debit: debit || '', credit: credit || '',
            contact_id: cid, contact_name: cname, account_id: options.relatedLedgersIgnoreRule && i === 0 ? '999' : id, currency_code: 'INR', account: { account_group: 'asset', account_type: relFx.ledgers[id].type },
          })),
        };
      });
      const total = groups.reduce((t, g) => t + g.account_transactions.length, 0);
      return { data: { account_transactions: groups, page_context: { page: 1, per_page: Number(query.per_page ?? 2000), total, total_pages: 1, has_more_page: false, from_date: query.from_date, to_date: query.to_date } } };
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
    if (p === '/reports/generalledgerdetails' && (query.rule?.columns?.[0]?.value ?? []).some((id) => cwipOldFx.groups.some((g) => g.group_name === id))) { // update-25: the ledger of old accounts emptied by clean-up journals
      if (options.cwipOldFail === 'refused') throw new ZohoError('Zoho /reports/generalledgerdetails failed: You are not authorized to perform this operation (HTTP 401)', { status: 401, code: 57, path: p });
      const ids = (query.rule.columns[0].value ?? []).map(String);
      let groups = cwipOldFx.groups.filter((g) => ids.includes(g.group_name)).map((g) => ({ group_name: g.group_name, rows: structuredClone(g.rows) }));
      if (options.cwipOldRows) groups = options.cwipOldRows(groups);
      return {
        data: {
          account_transactions: groups.map((g) => ({ group_name: g.group_name, account_transactions: g.rows.map((r) => ({ ...r, ...(options.cwipOldIgnoreRule ? { account_id: '999' } : {}) })) })),
          page_context: { page: 1, has_more_page: false, from_date: query.from_date, to_date: query.to_date },
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
      const udyam = options.udyam && id in options.udyam ? options.udyam[id] : (f.udyam ?? ''); // update-30: the Udyam number of the card (only some cards have one)
      const msmeType = udyam ? (f.msmeType ?? 'Small') : '';
      return { code: 0, message: 'success', contact: { contact_id: id, contact_name: f.name, contact_type: 'vendor', custom_fields: fields, custom_field_hash: hash, ...(udyam ? { udyam_reg_no: udyam, msme_type: msmeType, is_valid_udyam_no: true } : {}) } };
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
  return { get, stats, calls, billCalls, cwipJournalCalls, cwipBillCalls, subCalls, historyCalls, detailCalls, orgId: COMPANY_ORG, dc: 'in' };
}
