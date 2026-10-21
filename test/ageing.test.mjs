// Debtors and creditors ageing (lib/ageing.mjs) and its live columns on the two ageing tabs (lib/overlay.mjs `columns`).
// Small made-up cases for the rules, then the real FY26 sheets against the real FY26 data (saved Zoho answers, see fixtures/).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../lib/config.mjs';
import { buildSnapshot } from '../lib/snapshot.mjs';
import { readSheet, liveOverlay } from '../lib/workbook.mjs';
import { buildOverlay } from '../lib/overlay.mjs';
import { addDays, addMonths, ageingDates, normalizeCustomerBalances, normalizeSalesByCustomer, normalizeVendorBalances, debtorsAgeing, creditorsAgeing } from '../lib/ageing.mjs';
import { fetchCustomerBalances, fetchSalesByCustomer, fetchVendorBalances, fetchVendorCodes, vendorCodeOf, vendorMsmeOf, LoadError } from '../lib/zohoData.mjs';
import { replayZoho, haveFixtures } from '../testing/fakes.mjs';

const skip = !haveFixtures();
const config = loadConfig('2025-26');
const NOW = Date.parse('2026-10-16T06:30:00+05:30');

// ---------- dates ----------

test('the dates of the ageing: the day before the year, six months back, and the year-end rule', () => {
  assert.equal(addDays('2025-04-01', -1), '2025-03-31');
  assert.equal(addMonths('2026-03-31', -6), '2025-09-30', 'a day that does not exist is moved to the last day of the month');
  assert.equal(addMonths('2026-08-31', -6), '2026-02-28');
  assert.equal(addMonths('2028-08-31', -6), '2028-02-29');
  const d = ageingDates({ asOf: '2026-03-31', fyFrom: '2025-04-01' });
  assert.deepEqual([d.openDate, d.windowFrom, d.midDate, d.reason], ['2025-03-31', '2025-10-01', '2025-09-30', null]);
  const mid = ageingDates({ asOf: '2026-10-16', fyFrom: '2026-04-01' });
  assert.match(mid.reason, /year end only/);
  assert.throws(() => addDays('31/03/2026', 1), /Not a date/);
});

// ---------- the reports ----------

const cbs = (asOf, rows, more = false) => ({ code: 0, customerbalancesummary: rows.map(([id, inv, rec, clo]) => ({ customer_id: id, customer_name: `C${id}`, invoiced_amount: inv, amount_received: rec, closing_balance: clo })), page_context: { as_of_date: asOf, to_date: asOf, has_more_page: more } });
const sales = (rows) => ({ code: 0, sales: rows.map(([id, inv, cn]) => ({ customer_id: id, invoice_amount: inv, ...(cn === undefined ? {} : { creditnote_amount: cn }) })), page_context: { from_date: '2025-10-01', to_date: '2026-03-31', has_more_page: false } });

test('the customer balances and the sales are read from the answer; an unfinished answer is refused', () => {
  const b = normalizeCustomerBalances([cbs('2026-03-31', [['1', 100, 40, 60]]), { ...cbs('2026-03-31', [['2', 5, 0, 5]]), page_context: { as_of_date: '2026-03-31', has_more_page: false } }]);
  assert.equal(b.asOf, '2026-03-31');
  assert.deepEqual(b.byId['1'], { id: '1', name: 'C1', invoiced: 100, received: 40, closing: 60 });
  assert.equal(Object.keys(b.byId).length, 2);
  assert.throws(() => normalizeCustomerBalances(cbs('2026-03-31', [], true)), /incomplete/);
  assert.throws(() => normalizeCustomerBalances({ code: 0 }), /unexpected shape/);
  const s = normalizeSalesByCustomer(sales([['1', 200, 30], ['2', 50]]));
  assert.deepEqual([s.from, s.to, s.byId['1'].creditNotes, s.byId['2'].creditNotes], ['2025-10-01', '2026-03-31', 30, 0]);
  assert.throws(() => normalizeSalesByCustomer({ x: 1 }), /unexpected shape/);
});

test('a report that answers for another date is refused before it can be used', async () => {
  const wrong = { get: async () => cbs('2026-03-30', []) };
  await assert.rejects(fetchCustomerBalances(wrong, { asOf: '2026-03-31' }), (e) => e instanceof LoadError && e.code === 'CBS_DATE');
  const wrongRange = { get: async () => ({ sales: [], page_context: { from_date: '2025-09-01', to_date: '2026-03-31', has_more_page: false } }) };
  await assert.rejects(fetchSalesByCustomer(wrongRange, { from: '2025-10-01', to: '2026-03-31' }), (e) => e.code === 'SALES_DATES');
});

// ---------- debtors: the first-in first-out rule ----------

const debtors = (customers, now, open, win) => debtorsAgeing(customers, {
  now: normalizeCustomerBalances(cbs('2026-03-31', now)), open: normalizeCustomerBalances(cbs('2025-03-31', open)), window: normalizeSalesByCustomer(sales(win)),
});
const cu = (id, receivable) => ({ id, name: `C${id}`, receivable });

test('debtors: what is unpaid is the newest invoices; the opening balance is what is left after the year\'s payments, oldest first', () => {
  // invoiced 500 in the year (200 of it in the last six months), opening 100
  const rows = [['1', 600, 350, 250], ['2', 600, 0, 700], ['3', 600, 600, 0]];
  const open = [['1', 100, 0, 100], ['2', 100, 0, 100], ['3', 100, 0, 100]];
  const win = [['1', 200], ['2', 200], ['3', 200]];
  const d = debtors([cu('1', 250), cu('2', 700), cu('3', 0)], rows, open, win);
  const by = Object.fromEntries(d.customers.map((c) => [c.id, c]));
  // 1: closing 250 < invoiced 500 -> the opening balance is paid; 200 is less than 6 months, 50 is 6 to 12 months
  assert.deepEqual([by['1'].invoiced, by['1'].received, by['1'].older, by['1'].lt6, by['1'].m6_12], [500, 350, 0, 200, 50]);
  // 2: nothing paid: 100 of the opening balance is still open, all of the year's invoices as well
  assert.deepEqual([by['2'].older, by['2'].lt6, by['2'].m6_12], [100, 200, 400]);
  assert.equal(by['3'], undefined, 'a customer with nothing receivable is not on the ageing');
  assert.equal(d.totals.closing, 950);
  assert.equal(d.totals.lt6 + d.totals.m6_12 + d.totals.older, 950, 'the buckets always add up to the closing balances');
});

test('debtors: a customer who started in credit, credit notes that outweigh the invoices, a customer unknown to the report, and credit notes in the six months', () => {
  const d = debtors(
    [cu('1', 80), cu('2', 80), cu('9', 30), cu('4', 100)],
    [['1', 300, 270, 80], ['2', 50, 0, 80], ['4', 400, 300, 100]],
    [['1', 0, 50, -50], ['2', 0, 0, 500]],
    [['1', 300], ['4', 400, 150]],
  );
  const by = Object.fromEntries(d.customers.map((c) => [c.id, c]));
  assert.deepEqual([by['1'].opening, by['1'].invoiced, by['1'].received], [-50, 300, 220], 'a credit opening is taken off what was received, not off what was invoiced');
  // credit notes outweigh the invoices (2: invoiced 50 - 500 = -450): nothing of the year is left to age, the opening balance carries it
  assert.deepEqual([by['2'].invoiced, by['2'].older, by['2'].lt6, by['2'].m6_12], [-450, 80, 0, 0]);
  assert.deepEqual(d.missing, [{ id: '9', name: 'C9', receivable: 30 }]);
  assert.equal(by['4'].lt6, 100, 'invoices less credit notes of the six months (400 - 150 = 250) cover the 100 still open');
});

test('debtors (update-14): journal debits are aged by their dates, a half where credits and debits meet reads as invoices only, and without the first half the old model is used', () => {
  // balances: 31-Mar-2025 (open), 30-Sep-2025 (mid), 31-Mar-2026 (now); sales of the first half (early) and of the last six months (window)
  const open = [['1', 0, 0, 0], ['2', 0, 0, 0], ['3', 500, 0, 500], ['4', 0, 0, 0]];
  const mid = [['1', 100, 0, 100], ['2', 0, 0, 0], ['3', 520, 0, 520], ['4', 100, 0, 100]];
  const rows = [['1', 1100, 0, 1100], ['2', 300, 0, 300], ['3', 700, 0, 700], ['4', 90, 0, 90]];
  const win = [['1', 1000], ['2', 0], ['3', 180, 0], ['4', 0]];
  const early = { code: 0, sales: [{ customer_id: '1', invoice_amount: 100, creditnote_amount: 0 }, { customer_id: '3', invoice_amount: 20, creditnote_amount: 0 }, { customer_id: '4', invoice_amount: 100, creditnote_amount: 0 }], page_context: { from_date: '2025-04-01', to_date: '2025-09-30', has_more_page: false } };
  const z = (extra) => ({ now: normalizeCustomerBalances(cbs('2026-03-31', rows)), open: normalizeCustomerBalances(cbs('2025-03-31', open)), window: normalizeSalesByCustomer(sales(win)), ...extra });
  const full = z({ mid: normalizeCustomerBalances(cbs('2025-09-30', mid)), early: normalizeSalesByCustomer(early) });
  const d = debtorsAgeing([cu('1', 1100), cu('2', 300), cu('3', 700), cu('4', 90)], full);
  assert.equal(d.journals, true);
  const by = Object.fromEntries(d.customers.map((c) => [c.id, c]));
  // 1: invoices of 1000 in the last six months and 100 before: all open, nothing older
  assert.deepEqual([by['1'].lt6, by['1'].m6_12, by['1'].older], [1000, 100, 0]);
  // 2: no invoice at all, a journal of 300 in the last six months (the balance summary shows 300, Sales by Customer nothing): it is "less than 6 months"
  assert.deepEqual([by['2'].lt6, by['2'].m6_12, by['2'].older], [300, 0, 0], 'a journal debit is aged by its date');
  // 3: opening 500; the year's debits 20 + 180; closing 700 -> all of it is open, 500 older
  assert.deepEqual([by['3'].older, by['3'].lt6, by['3'].m6_12], [500, 180, 20]);
  // 4: invoices of 100 in the first half, a credit journal of 10 in the second (the balance summary shows -10, the sales 0): the half reads as invoices only (0 debits), the credit takes the oldest
  assert.deepEqual([by['4'].lt6, by['4'].m6_12, by['4'].older], [0, 90, 0]);
  assert.equal(d.totals.lt6 + d.totals.m6_12 + d.totals.older, 2190, 'the buckets always add up to the closing balances');
  // without the two reports of the first half: invoices only (customer 2's journal is then not seen)
  const old = debtorsAgeing([cu('1', 1100), cu('2', 300), cu('3', 700), cu('4', 90)], z({}));
  assert.equal(old.journals, false);
  assert.deepEqual([old.customers.find((c) => c.id === '2').lt6, old.customers.find((c) => c.id === '2').older], [0, 0], 'invoices only: a journal debit with no invoice is not "less than 6 months"');
  // one of the two alone is not enough for the new model
  assert.equal(debtorsAgeing([cu('1', 1100)], z({ mid: full.mid })).journals, false);
});

// ---------- creditors ----------

const gl = (contactId, date, net, txnId, type = 'bill') => ({ contactId, date, net, txnId, type });

test('creditors: what is older than a year is what is left of the opening balance after the year\'s payments', () => {
  const rows = [
    gl('1', '2025-03-31', -100, 'ob1', 'vendor_ob_bill'),
    gl('1', '2025-06-01', -400, 'b1'), gl('1', '2025-07-01', 450, 'p1', 'vendor_payment'),   // 1: closing 50 < billed 400 -> opening is paid
    gl('2', '2025-03-31', -100, 'ob2', 'vendor_ob_bill'), gl('2', '2025-09-01', -200, 'b2'), // 2: nothing paid: 100 stays old
  ];
  const parties = [{ id: '1', amount: 50, class: 'trade_payable' }, { id: '2', amount: 300, class: 'trade_payable_msme' }, { id: '3', amount: 10, class: 'advance' }];
  const c = creditorsAgeing(rows, parties, ['trade_payable', 'trade_payable_msme'], '2025-03-31');
  const by = Object.fromEntries(c.vendors.map((v) => [v.id, v]));
  assert.deepEqual([by['1'].opening, by['1'].billed, by['1'].older, by['1'].lt1], [100, 400, 0, 50]);
  assert.deepEqual([by['2'].opening, by['2'].billed, by['2'].older, by['2'].lt1], [100, 200, 100, 200]);
  assert.equal(by['3'], undefined, 'only the classes of the sheet');
  assert.equal(c.totals.lt1 + c.totals.older, c.totals.closing);
});

test('creditors: a journal that only moves a balance from one supplier account to another is no new billing', () => {
  const rows = [
    gl('1', '2025-03-31', -245217, 'ob', 'vendor_ob_bill'),
    gl('1', '2025-08-01', 245217, 'j1', 'journal'), gl('1', '2025-08-01', -245217, 'j1', 'journal'), // moved from Accounts Payable to Sundry Creditors
  ];
  const c = creditorsAgeing(rows, [{ id: '1', amount: 245217, class: 'trade_payable' }], ['trade_payable'], '2025-03-31');
  assert.deepEqual([c.vendors[0].billed, c.vendors[0].older, c.vendors[0].lt1], [0, 245217, 0], 'still the old opening balance');
});

test('creditors (update-14): Zoho\'s Billed Amount sets the buckets where it has the vendor; a retention vendor is on the sheet but in no age bucket', () => {
  const rows = [
    gl('1', '2025-03-31', -1558.77, 'ob1', 'vendor_ob_bill'), gl('1', '2025-08-01', -1528, 'b1'), // the ledger sees 1528 billed (a reclass entry added 1059), Zoho 469
    gl('2', '2025-03-31', -100, 'ob2', 'vendor_ob_bill'), gl('2', '2025-08-01', -50, 'b2'),
  ];
  const parties = [{ id: '1', amount: 3086.77, class: 'trade_payable' }, { id: '2', amount: 150, class: 'retention' }, { id: '4', amount: 7, class: 'trade_payable' }];
  const vbs = { now: normalizeVendorBalances(vbsAnswer([vbsRow('1', 1469, 0), vbsRow('2', 300, 150)])), open: normalizeVendorBalances(vbsAnswer([vbsRow('1', 1000, 0), vbsRow('2', 250, 150)], '2025-03-31')) };
  const ledgerOnly = creditorsAgeing(rows, parties, ['trade_payable', 'retention'], '2025-03-31');
  const withVbs = creditorsAgeing(rows, parties, ['trade_payable', 'retention'], '2025-03-31', vbs);
  const by = (c) => Object.fromEntries(c.vendors.map((v) => [v.id, v]));
  // closing 3086.77, opening 1558.77: with the ledger's billed (1528) older = 1558.77; with Zoho's billed (469) older = min(3086.77 - 469, 1558.77) = 1558.77 too, so use the second vendor's shape below
  assert.equal(by(withVbs)['1'].billed, 469, 'the Billed Amount of Zoho is the one used');
  assert.equal(by(ledgerOnly)['1'].billed, 1528, 'without the report the ledger\'s sum');
  assert.equal(by(withVbs)['4'].yearBilled, undefined, 'a vendor the report does not list keeps the ledger\'s sum and has no Billed figure of Zoho');
  const r = by(withVbs)['2'];
  assert.equal(r.retention, true);
  assert.deepEqual([r.lt1, r.older], [0, 0], 'retention money is not aged as a trade payable');
  assert.equal(by(ledgerOnly)['2'].lt1, 0);
  assert.equal(withVbs.totals.closing, 3086.77 + 150 + 7, 'but its balance is on the sheet');
  assert.equal(withVbs.totals.lt1 + withVbs.totals.older, 3086.77 + 7, 'and the buckets add up to the trade payables only');
  // Zoho's Billed in the formula, not the ledger's: closing 600, opening 400, Zoho billed 450 (the ledger 100) -> older 150; ledger -> older 400
  const rows3 = [gl('3', '2025-03-31', -400, 'ob3', 'vendor_ob_bill'), gl('3', '2025-08-01', -100, 'b3')];
  const p3 = [{ id: '3', amount: 600, class: 'trade_payable' }];
  const v3 = { now: normalizeVendorBalances(vbsAnswer([vbsRow('3', 450, 0)])), open: normalizeVendorBalances(vbsAnswer([], '2025-03-31', false)) };
  assert.deepEqual([creditorsAgeing(rows3, p3, ['trade_payable'], '2025-03-31', v3).vendors[0].older, creditorsAgeing(rows3, p3, ['trade_payable'], '2025-03-31').vendors[0].older], [150, 400]);
});

// ---------- the extra columns of the overlay ----------

const SHEET = { rows: [['Ageing'], ['Customer', 'Closing', 'Invoiced', 'New', 'Old1', 'Old2'], ['Alpha', 100, 500, 60, 30, 10], ['Beta', 50, 40, 50], ['Gamma', 70, 10, 70], ['Total', 220, 550, 180, 30, 10]] };
const COLS = [
  { col: 2, field: 'invoiced', label: 'Invoiced', needs: 'debtors' },
  { col: 3, field: 'lt6', label: 'New', needs: 'debtors' },
  { col: 4, field: 'older', label: 'Older', needs: 'debtors', sumCols: [4, 5] },
];
const LIVE = { label: 0, value: 1, blocks: [{ start: 'Customer', source: 'customer', group: 'c' }], groups: { c: { source: 'customer', title: 'Customers' } }, columns: COLS };
const withAgeing = (customers) => ({ receivables: { customers: [{ id: 'a', name: 'Alpha', receivable: 100 }, { id: 'b', name: 'Beta', receivable: 50 }, { id: 'g', name: 'Gamma', receivable: 70 }] }, buckets: {}, suppliers: { parties: [] }, ageing: { debtors: { customers }, problems: {} } });

test('extra live columns: each matched line is compared column by column, columns listed together are compared as one, and the total is worked out again', () => {
  const o = buildOverlay(withAgeing([
    { id: 'a', invoiced: 500, lt6: 60, older: 40 },   // all agree (older 40 = 30 + 10)
    { id: 'b', invoiced: 50, lt6: 50, older: 0 },    // invoiced differs by 10
    { id: 'g', invoiced: 10, lt6: 70, older: 0 },
  ]), SHEET, LIVE);
  assert.deepEqual(o.problems, []);
  assert.deepEqual(o.columns.map((c) => [c.col, c.ok, c.diff]), [[2, 2, 1], [3, 3, 0], [4, 3, 0]]);
  const alpha = o.byRow[2].cols;
  assert.equal(alpha[2].status, 'OK');
  assert.deepEqual([alpha[4].signed, alpha[4].live, alpha[4].group], [40, 40, [4, 5]]);
  assert.deepEqual([o.byRow[3].cols[2].status, o.byRow[3].cols[2].diff], ['DIFF', 10]);
  // totals: the signed total of a column is the sum of its lines, so the live total is the live lines added up
  const total = o.byRow[5].cols;
  assert.deepEqual([total[2].status, total[2].live, total[2].signed], ['DIFF', 560, 550]);
  assert.equal(total[3].status, 'OK');
  assert.equal(total[4].status, 'OK');
  assert.equal(o.byRow[5].kind, 'total', 'the closing total is still checked as before');
  assert.equal(o.summary.columns.length, 3);
});

test('extra live columns: a line Zoho does not have stays as signed, and without ageing in the snapshot the columns say why', () => {
  const s = withAgeing([{ id: 'a', invoiced: 500, lt6: 60, older: 40 }]); // Beta and Gamma are not aged
  const o = buildOverlay(s, SHEET, LIVE);
  assert.equal(o.byRow[3].cols, undefined);
  assert.equal(o.columns[0].ok, 1);
  assert.equal(o.byRow[5].cols[2].live, 550, 'a line without a Zoho figure counts as signed in the total, as in the closing column');
  const old = { ...s }; delete old.ageing;
  const none = buildOverlay(old, SHEET, LIVE);
  assert.equal(none.columns.length, 0);
  assert.equal(none.problems.length, 1, 'one sentence for all the columns of the same list');
  assert.match(none.problems[0], /Debtors ageing columns: .*older copy/);
  const refused = buildOverlay({ ...old, ageing: { debtors: null, creditors: null, problems: { debtors: 'The debtors ageing could not be read from Zoho (HTTP 401)' } } }, SHEET, LIVE);
  assert.match(refused.problems[0], /HTTP 401.*stay as signed/);
  assert.equal(refused.byRow[2].status, 'OK', 'the closing balance is checked as before');
});

// ---------- the real sheets against the saved FY26 answers ----------

const build = (options) => buildSnapshot({ zoho: replayZoho(options), config, fy: '2025-26', now: () => NOW });
const stats = (snapshot, id) => {
  const o = liveOverlay(snapshot, readSheet(config.workbook, id));
  return { o, cols: Object.fromEntries(o.columns.map((c) => [c.col, [c.ok, c.diff]])) };
};

test('Debtors Ageing, FY26: invoiced and received agree for every customer, the buckets for all but seven the auditors adjusted by hand', { skip }, async () => {
  const snapshot = await build();
  assert.equal(snapshot.meta.ok, true);
  assert.deepEqual(snapshot.ageing.problems, {});
  assert.equal(snapshot.ageing.debtors.totals.closing, 554432471.94, 'the aged customers add up to the signed trade receivables');
  const { o, cols } = stats(snapshot, 'debtors-ageing');
  assert.deepEqual(o.problems, []);
  assert.deepEqual(cols, { 1: [127, 0], 2: [127, 0], 4: [124, 3], 5: [122, 5], 6: [121, 6] });
  const ids = Object.entries(o.byRow).filter(([, v]) => v.kind === 'detail' && v.cols && Object.values(v.cols).some((x) => x.status === 'DIFF')).length;
  assert.equal(ids, 7, '7 customers differ in at least one bucket (11 before the journals were aged by their dates)');
  assert.equal(snapshot.ageing.debtors.journals, true);
  const total = o.byRow[128].cols; // the signed Total line
  assert.equal(o.byRow[128].kind, 'total');
  assert.deepEqual(total[4].status, 'DIFF', 'the bucket totals differ by the same few customers');
});

test('Creditors Ageing, FY26: every vendor agrees in every column, and so does every column total', { skip }, async () => {
  const snapshot = await build();
  const { o, cols } = stats(snapshot, 'creditors-ageing');
  assert.deepEqual(o.problems, []);
  // Billed and Paid come from the Vendor Balance Summary; the saved data has none, the replay makes one up from the SIGNED figures (fixtures/vbs_fy26.json), which is
  // what the real run of 17-Oct-2026 gave (165 of 165). Real run of that day: Less than 1 Yr 161 / older 163 of 165 before update-14, the 4 that differed are now agreed:
  // Cyrun-Infra and Gurukripa are retention money (no age bucket), Bsnl and Rajendra Prasad Gupta follow Zoho's Billed figure.
  // the Vendor Code (column 5) is read from each vendor's card in Zoho (the replay answers the signed codes: on 17-Oct-2026 Zoho's vendor list agreed with the sheet on every vendor of it that the list showed)
  assert.deepEqual(cols, { 1: [164, 0], 2: [164, 0], 3: [164, 0], 5: [164, 0], 6: [164, 0], 7: [164, 0], 10: [162, 0] }, 'MSME (column 10): update-30, 2 more are explained (see the MSME test below)');
  assert.ok(o.columns.filter((c) => !c.text).every((c) => c.totalBad === 0 && c.totalOk === 1), 'every column total agrees');
  assert.equal(o.columns.find((c) => c.col === 5).text, true, 'a text column has no total');
  assert.equal(o.columns.find((c) => c.col === 10).text, true, 'so has the MSME flag');
  const vendors = Object.fromEntries(snapshot.ageing.creditors.vendors.map((v) => [v.id, v]));
  const row = (name) => Object.entries(o.byRow).find(([r]) => String(readSheet(config.workbook, 'creditors-ageing').rows[r][0]).startsWith(name));
  for (const name of ['Cyrun-Infra', 'Gurukripa']) {
    const [r, line] = row(name);
    assert.equal(line.cols[6].status, 'OK', `${name}: the auditors show the balance as retention money, in no age bucket`);
    assert.equal(line.cols[7].status, 'OK');
    assert.equal(readSheet(config.workbook, 'creditors-ageing').rows[r][6], 0);
  }
  assert.equal(Object.values(vendors).filter((v) => v.retention).length >= 2, true, 'the vendors of class retention are flagged');
  const bsnl = row('Bsnl')[1].cols[5];
  assert.deepEqual([bsnl.status, bsnl.live === bsnl.signed, bsnl.live.length > 0], ['OK', true, true]);
  assert.equal(row('Achyutam')[1].cols[5].status, 'OK');
  assert.equal(row('Achyutam')[1].cols[7].status, 'OK', 'a journal that moved an old balance between supplier accounts does not make it new');
  assert.equal(row('Bsnl')[1].cols[6].status, 'OK', 'Zoho\'s Billed Amount (469) is in the formula, not the ledger\'s sum (1,528)');
  assert.equal(row('Rajendra Prasad Gupta Consultants')[1].cols[6].status, 'OK');
});

// ---------- Zoho refuses, answers for the wrong date, or the date is not a year end ----------

test('a report Zoho refuses leaves the statements alone: the debtors columns stay as signed, with the reason', { skip }, async () => {
  for (const ageingFail of ['balances', 'sales']) {
    const snapshot = await build({ ageingFail });
    assert.equal(snapshot.meta.ok, true, 'the statements are not affected');
    assert.equal(snapshot.ageing.debtors, null);
    assert.ok(snapshot.ageing.creditors.vendors.length > 100, 'the creditors need no extra report');
    assert.match(snapshot.ageing.problems.debtors, /not authorized/);
    const alert = snapshot.alerts.find((a) => a.code === 'AGEING_DEBTORS_UNAVAILABLE');
    assert.equal(alert.level, 'warn');
    const { o } = stats(snapshot, 'debtors-ageing');
    assert.equal(o.columns.length, 0);
    assert.match(o.problems[0], /Debtors ageing columns: .*not authorized.*stay as signed/);
    assert.equal(o.summary.ok + o.summary.name, 127, 'the closing balances are still checked');
  }
});

test('a report that answers for the wrong date is not used', { skip }, async () => {
  for (const options of [{ balancesDate: '2026-03-30' }, { salesRange: ['2025-09-01', '2026-03-31'] }]) {
    const snapshot = await build(options);
    assert.equal(snapshot.ageing.debtors, null);
    assert.match(snapshot.ageing.problems.debtors, /not accepted|not ISO|, not /);
    assert.ok(snapshot.alerts.some((a) => a.code === 'AGEING_DEBTORS_UNAVAILABLE'));
    assert.equal(snapshot.meta.ok, true);
  }
});

// ---------- Sales by Customer: the columns must be asked for by name (found on the first real run, 16-Oct-2026) ----------

test('Sales by Customer is asked for invoice_amount and creditnote_amount by name', { skip }, async () => {
  const zoho = replayZoho();
  await buildSnapshot({ zoho, config, fy: '2025-26', now: () => NOW });
  const asked = zoho.calls.filter((c) => c.path === '/reports/salesbycustomer' || c[0] === '/reports/salesbycustomer');
  assert.ok(asked.length >= 1, 'the report was asked for');
  const q = asked[0].query ?? asked[0][1];
  assert.deepEqual((q.select_columns ?? []).map((c) => c.field).sort(), ['creditnote_amount', 'customer_name', 'invoice_amount']);
});

test('an answer that comes with the default columns (sales_with_tax only) still gives the same net sales; one with neither is refused', () => {
  const dflt = { code: 0, sales: [{ customer_id: '1', customer_name: 'A', count: 3, sales: 100, sales_with_tax: 118 }, { customer_id: '2', customer_name: 'B', count: 0, sales: -50, sales_with_tax: -59 }], page_context: { has_more_page: false } };
  const w = normalizeSalesByCustomer(dflt);
  assert.equal(w.byId['1'].invoices - w.byId['1'].creditNotes, 118);
  assert.equal(w.byId['2'].invoices - w.byId['2'].creditNotes, -59, 'credit notes beyond the invoices of the window are a negative net');
  assert.throws(() => normalizeSalesByCustomer({ code: 0, sales: [{ customer_id: '1', customer_name: 'A', count: 3 }], page_context: {} }), /neither invoice_amount nor sales_with_tax/);
  assert.throws(() => normalizeSalesByCustomer({ code: 0, sales: [{ customer_name: 'A', invoice_amount: 5 }], page_context: {} }), /none carries customer_id/, 'lines without a customer id are not read as "nobody"');
  assert.doesNotThrow(() => normalizeSalesByCustomer({ code: 0, sales: [], page_context: {} }), 'a window with no sales at all is an answer');
});

// ---------- Vendor Balance Summary: Billed and Paid ----------

const vbsRow = (id, billed, paid) => ({ vendor_name: `V${id}`, vendor_id: id, currency_id: '1', billed_amount: billed, amount_paid: paid, closing_balance: billed - paid, non_default_currency_values: [], vendor: {} });
const vbsAnswer = (rows, asOf = '2026-03-31', nested = true) => ({ code: 0, message: 'success', vendorbalancesummary: nested ? [{ vendorbalancesummary: rows }] : rows, page_context: { as_of_date: asOf, has_more_page: false } });

test('the vendor balance summary is read whether Zoho nests its list (as it does) or not; a year is the difference of two dates', () => {
  const now = normalizeVendorBalances(vbsAnswer([vbsRow('1', 500, 300), vbsRow('2', 80, 80)]));
  const flat = normalizeVendorBalances(vbsAnswer([vbsRow('1', 500, 300), vbsRow('2', 80, 80)], '2026-03-31', false));
  assert.deepEqual(now, flat);
  assert.deepEqual(now.byId['1'], { id: '1', name: 'V1', billed: 500, paid: 300, closing: 200 });
  assert.equal(now.asOf, '2026-03-31');
  const open = normalizeVendorBalances(vbsAnswer([vbsRow('1', 200, 150)], '2025-03-31'));
  const parties = [{ id: '1', name: 'V1', amount: -200, class: 'trade_payable' }, { id: '2', name: 'V2', amount: 0, class: 'trade_payable' }, { id: '3', name: 'V3', amount: -5, class: 'advance' }];
  const c = creditorsAgeing([], parties, ['trade_payable'], '2025-03-31', { now, open });
  const v = Object.fromEntries(c.vendors.map((x) => [x.id, x]));
  assert.deepEqual([v['1'].yearBilled, v['1'].yearPaid], [300, 150]);
  assert.deepEqual([v['2'].yearBilled, v['2'].yearPaid], [80, 80], 'a vendor the opening report does not list had nothing before the year');
  assert.equal(v['3'], undefined, 'only the sheet\'s classes');
  assert.deepEqual([c.totals.yearBilled, c.totals.yearPaid], [380, 230]);
  assert.equal(creditorsAgeing([], parties, ['trade_payable'], '2025-03-31').vendors[0].yearBilled, undefined, 'without the report there is no figure, so the column stays as signed');
  assert.throws(() => normalizeVendorBalances({ code: 0 }), /unexpected shape/);
  assert.throws(() => normalizeVendorBalances({ code: 0, vendorbalancesummary: [{ vendorbalancesummary: [{ vendor_id: '1', vendor_name: 'x' }] }] }), /no billed_amount/);
});

test('the vendors are asked for a few at a time, by id; a wrong date or an ignored filter stops the run', async () => {
  const ids = Array.from({ length: 120 }, (_, i) => String(2000 + i));
  const asked = [];
  const zoho = { get: async (path, q) => {
    asked.push([path, q]);
    return vbsAnswer(q.rule.columns[0].value.map((id) => vbsRow(id, 10, 4)), q.to_date);
  } };
  const pages = await fetchVendorBalances(zoho, { ids, from: '2020-04-01', to: '2026-03-31' });
  assert.equal(asked.length, 3, '120 vendors, 50 at a time');
  assert.ok(asked.every(([path, q]) => path === '/reports/vendorbalancesummary' && q.rule.columns[0].field === 'vendor_id' && q.rule.columns[0].comparator === 'in' && q.rule.columns[0].value.length <= 50));
  assert.equal(Object.keys(normalizeVendorBalances(pages).byId).length, 120);
  await assert.rejects(fetchVendorBalances({ get: async () => vbsAnswer([vbsRow('2000', 1, 1)], '2026-03-30') }, { ids: ['2000'], from: '2020-04-01', to: '2026-03-31' }), (e) => e instanceof LoadError && e.code === 'VBS_DATE');
  await assert.rejects(fetchVendorBalances({ get: async () => vbsAnswer([vbsRow('2000', 1, 1), vbsRow('7', 1, 1)]) }, { ids: ['2000'], from: '2020-04-01', to: '2026-03-31' }), (e) => e.code === 'VBS_FILTER_IGNORED');
  await assert.rejects(fetchVendorBalances(zoho, { ids: [], from: '2020-04-01', to: '2026-03-31' }), (e) => e.code === 'NO_VENDORS');
});

test('Billed and Paid: a refused, misdated or filter-ignoring report leaves the rest of the ageing alone', { skip }, async () => {
  for (const options of [{ vbs: 'refused' }, { vbsDate: '2026-03-30' }, { vbsIgnoreFilter: true }]) {
    const snapshot = await build(options);
    assert.equal(snapshot.meta.ok, true, 'the statements are not affected');
    assert.ok(snapshot.ageing.debtors, 'the debtors ageing is not affected');
    assert.ok(snapshot.ageing.creditors.vendors.length > 100, 'the creditors ageing is built without the report');
    assert.equal(snapshot.ageing.creditors.vbs, null);
    assert.match(snapshot.ageing.problems.vbs, /Vendor Balance Summary/);
    const alert = snapshot.alerts.find((a) => a.code === 'AGEING_VBS_UNAVAILABLE');
    assert.equal(alert.level, 'warn');
    assert.match(alert.message, /Billed Amount and Paid Amount of the Creditors Ageing stay as signed/);
    const { o, cols } = stats(snapshot, 'creditors-ageing');
    assert.deepEqual(cols, { 1: [164, 0], 5: [164, 0], 6: [162, 2], 7: [162, 2], 10: [162, 0] }, 'Billed and Paid are not among the live columns, the others are (the ledger\'s own billed sum then: Bsnl and Rajendra Prasad Gupta differ again)');
    assert.equal(o.problems.length, 1);
    assert.match(o.problems[0], /Creditors ageing columns: Billed and Paid could not be .*Vendor Balance Summary.*stay as signed/);
    // the signed Billed and Paid are shown untouched
    assert.ok(Object.values(o.byRow).every((r) => !r.cols || (r.cols[2] === undefined && r.cols[3] === undefined)));
  }
});

test('the vendor balance summary also works when its list is not nested', { skip }, async () => {
  const snapshot = await build({ vbsFlat: true });
  assert.ok(snapshot.ageing.creditors.vbs);
  assert.equal(snapshot.ageing.problems.vbs, undefined);
});

// ---------- update-14: the first half of the year (journals aged by their dates) ----------

test('the two reports of the first half of the year are asked for: the balances of 30-Sep-2025 and the sales of April to September', { skip }, async () => {
  const zoho = replayZoho();
  await buildSnapshot({ zoho, config, fy: '2025-26', now: () => NOW });
  const balances = zoho.calls.filter((c) => c.path === '/reports/customerbalancesummary').map((c) => c.query.to_date).sort();
  assert.deepEqual(balances, ['2025-03-31', '2025-09-30', '2026-03-31']);
  const sales = zoho.calls.filter((c) => c.path === '/reports/salesbycustomer' && !c.query.rule).map((c) => `${c.query.from_date}..${c.query.to_date}`).sort();
  assert.deepEqual(sales, ['2025-04-01..2025-09-30', '2025-10-01..2026-03-31']);
});

test('without the first half of the year the debtors are aged by invoices only (as in update-13), with a warning; the rest is not touched', { skip }, async () => {
  for (const options of [{ halfFail: true }, { halfDate: '2025-09-29' }]) {
    const snapshot = await build(options);
    assert.equal(snapshot.meta.ok, true);
    assert.equal(snapshot.ageing.debtors.journals, false);
    assert.equal(snapshot.ageing.problems.debtors, undefined, 'the debtors are still built');
    assert.match(snapshot.ageing.problems.journals, /first half of the year/);
    const alert = snapshot.alerts.find((a) => a.code === 'AGEING_JOURNALS_UNAVAILABLE');
    assert.equal(alert.level, 'warn');
    assert.match(alert.message, /invoices only/);
    const { cols } = stats(snapshot, 'debtors-ageing');
    assert.deepEqual(cols, { 1: [127, 0], 2: [127, 0], 4: [121, 6], 5: [117, 10], 6: [120, 7] }, 'exactly the update-13 result');
    assert.equal(snapshot.ageing.creditors.vendors.length > 100, true);
  }
});

// ---------- update-14: the Vendor Code from each vendor's own card ----------

const memoryCodes = () => { let kept = null; return { getVendorCodes: async () => (kept ? structuredClone(kept) : null), putVendorCodes: async (m) => { kept = structuredClone(m); }, peek: () => kept }; };
const card = (fields) => ({ code: 0, message: 'success', contact: { contact_id: '1', contact_type: 'vendor', ...fields } });

test('the Vendor Code is found on a vendor card wherever Zoho puts it; a card without one gives an empty code, an answer that is no card gives none', () => {
  assert.equal(vendorCodeOf(card({ cf_vendor_code: ' 2-06-003-0001 ' })), '2-06-003-0001');
  assert.equal(vendorCodeOf(card({ custom_field_hash: { cf_vendor_code: '2-06-003-0002' } })), '2-06-003-0002');
  assert.equal(vendorCodeOf(card({ custom_fields: [{ api_name: 'cf_cleaning', value: 'Active' }, { api_name: 'cf_vendor_code', value: '2-06-003-0003' }] })), '2-06-003-0003');
  assert.equal(vendorCodeOf(card({ custom_fields: [{ api_name: 'cf_cleaning', value: 'Active' }], custom_field_hash: {} })), '', 'a vendor without a code');
  assert.equal(vendorCodeOf({ data: { contact: { cf_vendor_code: 'X-1' } } }), 'X-1', 'also when the connector wraps the answer');
  assert.equal(vendorCodeOf({ code: 0, message: 'success' }), null);
  assert.equal(vendorCodeOf(null), null);
});

test('vendor cards: at most `budget` per run, the codes kept between runs, a code read again after a week, a failing card left for the next run', async () => {
  const asked = [];
  const zoho = { get: async (p) => { asked.push(p); const id = p.split('/').pop(); if (id === '404') { const e = new Error('not found'); e.status = 404; throw e; } return card({ cf_vendor_code: `C-${id}` }); } };
  const cache = memoryCodes();
  const ids = ['1', '2', '3', '4', '404'];
  let t = Date.parse('2026-10-16T06:00:00Z');
  const run = () => fetchVendorCodes(zoho, ids, { cache, budget: 2, concurrency: 2, now: () => t });
  const a = await run();
  assert.deepEqual([a.fetched, a.fromCache, a.pending.length], [2, 0, 3], 'two cards of five');
  const b = await run();
  assert.deepEqual([b.fetched, b.fromCache, Object.keys(b.codes).length], [2, 2, 4], 'the next two; the first two come from Redis');
  const c = await run();
  assert.deepEqual([c.fetched, c.failed, c.pending], [0, ['404'], ['404']], 'the card that fails is asked again and nothing else is');
  assert.deepEqual(c.codes, { 1: 'C-1', 2: 'C-2', 3: 'C-3', 4: 'C-4' });
  assert.equal(asked.filter((p) => p === '/contacts/1').length, 1, 'a code that is kept is not asked for again');
  // eight days later every code is older than a week: the oldest are read again first (the failing card never was read), the old codes are used until their turn
  t += 8 * 24 * 3600 * 1000;
  const d = await run();
  assert.deepEqual([d.fetched, d.fromCache, d.pending], [1, 0, ['404']]);
  assert.deepEqual(Object.keys(d.codes).sort(), ['1', '2', '3', '4'], 'the codes that are due are still there');
});

test('vendor cards: Zoho refusing (rate limit) stops the run, keeps what was read, and says so; no Redis means nothing is kept', async () => {
  let n = 0;
  const zoho = { get: async (p) => { n += 1; if (n > 2) { const e = new Error('Zoho /contacts failed: too many requests (HTTP 429)'); e.status = 429; throw e; } return card({ cf_vendor_code: `C-${p.split('/').pop()}` }); } };
  const cache = memoryCodes();
  const r = await fetchVendorCodes(zoho, ['1', '2', '3', '4', '5'], { cache, budget: 10, concurrency: 1 });
  assert.deepEqual([r.fetched, r.pending.length], [2, 3]);
  assert.match(r.stopped, /429/);
  assert.deepEqual(Object.keys(cache.peek()).sort(), ['1', '2'], 'what was read is kept');
  n = 0;
  const free = await fetchVendorCodes({ get: async (p) => card({ cf_vendor_code: `C-${p.split('/').pop()}` }) }, ['1', '2', '3'], { budget: 10 });
  assert.deepEqual([free.fetched, free.fromCache, free.stopped], [3, 0, null]);
});

test('Vendor Code on the Creditors Ageing: compared as text (case and spaces ignored), a vendor without a code in Zoho or not read yet is not wrongly flagged', () => {
  const sheet = (rows) => ({ rows: [['Vendor Name', 'Opening', 'Billed', 'Paid', 'Closing', 'Vendor Code'], ...rows], columns: 6 });
  const cfg = { label: 0, value: 4, blocks: [{ start: 'Vendor Name', source: 'supplier:trade_payable', title: 'Vendors' }], groups: { pay: { source: 'supplier:trade_payable' } }, columns: [{ col: 5, field: 'code', label: 'Vendor Code', needs: 'creditors', part: 'codes', text: true }] };
  const snapshot = {
    buckets: {}, receivables: { customers: [] },
    suppliers: { parties: [1, 2, 3, 4, 5].map((i) => ({ id: String(i), name: `Vendor ${i}`, amount: 100, class: 'trade_payable' })) },
    ageing: { creditors: { vendors: [{ id: '1', code: '2-06-003-0001' }, { id: '2', code: '2-06-003-0002' }, { id: '3', code: '' }, { id: '4', code: '2-06-003-0004' }, { id: '5' }], codes: { known: 4, total: 5, pending: 1 } }, problems: {} },
  };
  const rows = [['Vendor 1', 0, 0, 0, 100, ' 2-06-003-0001 '], ['Vendor 2', 0, 0, 0, 100, '2-06-003-0003'], ['Vendor 3', 0, 0, 0, 100, '2-06-003-0009'], ['Vendor 4', 0, 0, 0, 100, '2-06-003-0004'], ['Vendor 5', 0, 0, 0, 100, '2-06-003-0005']];
  const o = buildOverlay(snapshot, { rows: sheet(rows).rows }, cfg);
  const c = (r) => o.byRow[r + 1].cols?.[5];
  assert.equal(c(0).status, 'OK', 'spaces around the signed code do not matter');
  assert.deepEqual([c(1).status, c(1).live, c(1).signed], ['DIFF', '2-06-003-0002', '2-06-003-0003']);
  assert.deepEqual([c(2).status, c(2).live], ['DIFF', ''], 'Zoho has no code on the card, the sheet has one');
  assert.equal(c(3).status, 'OK');
  assert.equal(c(4), undefined, 'a vendor whose card has not been read yet is not compared');
  assert.deepEqual([o.columns[0].ok, o.columns[0].diff, o.columns[0].text], [2, 2, true]);
  // without any code read, the column says why and stays as signed
  const none = buildOverlay({ ...snapshot, ageing: { creditors: { vendors: [] }, problems: { codes: 'No Vendor Code could be read from Zoho yet' } } }, { rows: sheet(rows).rows }, cfg);
  assert.equal(none.columns.length, 0);
  assert.ok(none.problems.some((p) => /No Vendor Code could be read/.test(p)));
});

test('Vendor Codes in a whole snapshot: Zoho refusing the cards leaves the rest of the ageing alone; stopping half way keeps the codes read', { skip }, async () => {
  const none = await build({ codesRateAfter: 0 });
  assert.equal(none.meta.ok, true);
  assert.match(none.ageing.problems.codes, /stopped answering before any Vendor Code/);
  assert.equal(none.ageing.creditors.codes, undefined);
  assert.equal(none.alerts.find((a) => a.code === 'AGEING_CODES_UNAVAILABLE').level, 'warn');
  const a = stats(none, 'creditors-ageing');
  assert.deepEqual(a.cols, { 1: [164, 0], 2: [164, 0], 3: [164, 0], 6: [164, 0], 7: [164, 0] }, 'the other columns are live as before');
  assert.ok(a.o.problems.some((p) => /Vendor Code/.test(p)), 'and the page says why the code stays as signed');
  const half = await build({ codesRateAfter: 100 });
  assert.equal(half.ageing.creditors.codes.known, 100);
  assert.equal(half.alerts.find((x) => x.code === 'AGEING_VENDOR_CODES_STOPPED').level, 'warn');
  const [codeCol] = stats(half, 'creditors-ageing').o.columns.filter((c) => c.col === 5);
  assert.equal(codeCol.diff, 0);
  assert.ok(codeCol.ok > 50 && codeCol.ok < 164, 'only the vendors whose card was read are compared');
  assert.equal(stats(half, 'creditors-ageing').cols[6][0], 164);
});

test('a card that cannot be found (404) leaves that vendor out and tells the person how many codes are known', { skip }, async () => {
  const probe = await build();
  const ids = probe.ageing.creditors.vendors.slice(0, 3).map((v) => v.id);
  const snap = await build({ codesMissing: ids });
  assert.equal(snap.ageing.creditors.codes.known, 163);
  assert.equal(snap.ageing.creditors.vendors.filter((v) => v.code === undefined).length, 3);
  const info = snap.alerts.find((x) => x.code === 'AGEING_VENDOR_CODES_PARTIAL');
  assert.equal(info.level, 'info');
  assert.match(info.message, /163 of 166/);
});

// ---------- update-30: the MSME flag from the vendor card (Udyam registration number) ----------

test('the MSME facts of a vendor card: the Udyam number and the MSME type; a card without them is a vendor without a Udyam number; no card gives none', () => {
  assert.deepEqual(vendorMsmeOf(card({ udyam_reg_no: ' UDYAM-RJ-00-0000001 ', msme_type: 'Small' })), { udyam: 'UDYAM-RJ-00-0000001', msme: 'Small' });
  assert.deepEqual(vendorMsmeOf(card({ cf_vendor_code: 'X' })), { udyam: '', msme: '' }, 'no Udyam fields = no Udyam number');
  assert.deepEqual(vendorMsmeOf(card({ udyam_reg_no: null, msme_type: null })), { udyam: '', msme: '' });
  assert.deepEqual(vendorMsmeOf({ data: { contact: { udyam_reg_no: 'U-1' } } }), { udyam: 'U-1', msme: '' }, 'also when the connector wraps the answer');
  assert.equal(vendorMsmeOf({ code: 0, message: 'success' }), null);
  assert.equal(vendorMsmeOf(null), null);
});

test('vendor cards: a vendor kept by an older version (a code, no Udyam entry) is read once more; after that its card comes from Redis', async () => {
  const asked = [];
  const zoho = { get: async (p) => { asked.push(p); const id = p.split('/').pop(); return card({ cf_vendor_code: `C-${id}`, ...(id === '2' ? { udyam_reg_no: 'U-2', msme_type: 'Micro' } : {}) }); } };
  const cache = memoryCodes();
  const t = Date.parse('2026-10-22T06:00:00Z');
  await cache.putVendorCodes({ 1: { code: 'C-1', at: t - 1000 }, 2: { code: 'C-2', at: t - 2000 } }); // the cache of update-14 .. update-29: no udyam
  const first = await fetchVendorCodes(zoho, ['1', '2', '3'], { cache, budget: 2, concurrency: 1, now: () => t });
  assert.equal(first.fetched, 2, 'the budget is 2: the vendor never read first (3), then the oldest entry (2)');
  assert.deepEqual(first.pending, [], 'vendor 3 now has its code');
  assert.deepEqual(first.unflagged, ['1'], 'vendor 1 has a code but no Udyam entry yet');
  assert.deepEqual(first.flags['2'], { udyam: 'U-2', msme: 'Micro' });
  assert.deepEqual(first.flags['3'], { udyam: '', msme: '' });
  const second = await fetchVendorCodes(zoho, ['1', '2', '3'], { cache, budget: 2, concurrency: 1, now: () => t });
  assert.deepEqual([second.fetched, second.fromCache, second.pending, second.unflagged], [1, 2, [], []], 'only vendor 1 is asked for; the other two come from Redis');
  assert.deepEqual(second.flags['1'], { udyam: '', msme: '' });
  assert.equal(asked.filter((p) => p === '/contacts/1').length, 1);
  assert.deepEqual(cache.peek()['2'], { code: 'C-2', at: t, udyam: 'U-2', msme: 'Micro' });
});

test('MSME on the Creditors Ageing: Yes = the card carries a Udyam number; the sheet\'s Yes/No is compared, the number is shown under the figure, the two retention vendors are explained, nothing else differs', { skip }, async () => {
  const snapshot = await build();
  assert.deepEqual(snapshot.ageing.creditors.msme, { known: 166, total: 166, pending: 0 });
  assert.equal(snapshot.ageing.problems.msme, undefined);
  const nameOf = Object.fromEntries(snapshot.suppliers.parties.map((p) => [p.id, p.name]));
  const byName = (n) => snapshot.ageing.creditors.vendors.find((v) => String(nameOf[v.id]).startsWith(n));
  assert.deepEqual([byName('Bharat Prefab').msme, byName('Bharat Prefab').msmeNote], ['Yes', 'Udyam UDYAM-RJ-00-0000001, Small']);
  assert.deepEqual([byName('Achyutam').msme, byName('Achyutam').msmeNote], ['No', 'no Udyam number on the vendor card']);
  const { o } = stats(snapshot, 'creditors-ageing');
  const sheetRows = readSheet(config.workbook, 'creditors-ageing').rows;
  const line = (n) => o.byRow[sheetRows.findIndex((r) => String(r[0]).startsWith(n))];
  for (const n of ['Bharat Prefab', 'Divya Associates', 'KG Solar']) assert.equal(line(n).cols[10].status, 'OK', `${n}: Yes on the sheet and a Udyam number on the card`);
  for (const n of ['Cyrun-Infra', 'Gurukripa']) {
    const x = line(n).cols[10];
    assert.deepEqual([x.status, x.signed, x.live, x.note], ['EXPL', 'Yes', 'No', 'no Udyam number on the vendor card'], n);
    assert.match(x.explain, /Retention money, shown as MSME by the auditors; Zoho's card has no Udyam number/);
  }
  assert.equal(line('Bharat Prefab').cols[10].note, 'Udyam UDYAM-RJ-00-0000001, Small');
  const col = o.columns.find((c) => c.col === 10);
  assert.deepEqual([col.ok, col.diff, col.expl, col.text], [162, 0, 2, true]);
  assert.equal(snapshot.alerts.some((a) => a.code === 'AGEING_MSME_PENDING'), false);
});

test('MSME on the Creditors Ageing: a vendor whose card and sheet differ without a written reason is a difference, with the Udyam number in words', { skip }, async () => {
  const probe = await build();
  const some = probe.ageing.creditors.vendors.find((v) => String(probe.suppliers.parties.find((p) => p.id === v.id)?.name).startsWith('Achyutam'));
  const snapshot = await build({ udyam: { [some.id]: 'UDYAM-RJ-09-0000099' } });
  const { o } = stats(snapshot, 'creditors-ageing');
  const rows = readSheet(config.workbook, 'creditors-ageing').rows;
  const x = o.byRow[rows.findIndex((r) => String(r[0]).startsWith('Achyutam'))].cols[10];
  assert.deepEqual([x.status, x.signed, x.live, x.note], ['DIFF', 'No', 'Yes', 'Udyam UDYAM-RJ-09-0000099, Small']);
  const col = o.columns.find((c) => c.col === 10);
  assert.deepEqual([col.ok, col.diff, col.expl], [161, 1, 2]);
});

test('MSME on the Creditors Ageing: a cache from before update-30 (codes only) gives no MSME column yet and says why; the codes are not affected', { skip }, async () => {
  const probe = await build();
  const kept = {};
  for (const v of probe.ageing.creditors.vendors) kept[v.id] = { code: v.code ?? '', at: NOW }; // what update-14 .. update-29 kept: a code and the time, no Udyam entry
  // a cache that knows only the vendor codes (every other key is empty and writes go nowhere); budget 0: nothing is read again in this run
  const cache = new Proxy({}, { get: (_, k) => (k === 'getVendorCodes' ? async () => structuredClone(kept) : k === 'putVendorCodes' ? async () => {} : async () => null) });
  const cfg0 = { ...config, settings: { ...config.settings, vendor_code_budget: 0 } };
  const snapshot = await buildSnapshot({ zoho: replayZoho(), config: cfg0, fy: '2025-26', now: () => NOW, cache });
  assert.equal(snapshot.ageing.creditors.msme, undefined);
  assert.match(snapshot.ageing.problems.msme, /not been read yet/);
  assert.equal(snapshot.alerts.find((a) => a.code === 'AGEING_MSME_PENDING').level, 'info');
  assert.ok(snapshot.ageing.creditors.codes.known > 100, 'the codes come from the cache');
  const { o, cols } = stats(snapshot, 'creditors-ageing');
  assert.equal(cols[10], undefined);
  assert.ok(o.problems.some((p) => /MSME flag is read from the same vendor cards/.test(p)));
});
