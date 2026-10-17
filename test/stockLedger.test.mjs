// update-18: what the ledger of Inventory Asset is made of, and the gap between the account and its items explained from it (lib/stockLedger.mjs), the sheet's own "Difference"
// checked live (lib/overlay.mjs, `stockgap`), and the refresh reading the ledger. Small made-up lines for the rules, then the real ledger of 17-Oct-2026 (fixture, 6,504 lines).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../lib/config.mjs';
import { buildSnapshot, buildStockSection } from '../lib/snapshot.mjs';
import { readSheet, liveOverlay } from '../lib/workbook.mjs';
import { stockLedgerRows, reduceStockLedger, buildStockLedger, ledgerGapMessage, MAX_UNEQUAL_KEPT } from '../lib/stockLedger.mjs';
import { buildOverlay, parseSource, sourceUnavailable, stockGapValue } from '../lib/overlay.mjs';
import { replayZoho, haveFixtures } from '../testing/fakes.mjs';

const skip = !haveFixtures();
const config = loadConfig('2025-26');
const NOW = Date.parse('2026-10-15T06:30:00+05:30');
const FY = '2025-26';
const run = (options, cfg = config) => buildSnapshot({ zoho: replayZoho(options), config: cfg, fy: FY, now: () => NOW });
const sheet = () => readSheet(config.workbook, 'closing-stock');

// ---------- the rules, on made-up lines ----------

const row = (type, debit, credit, txn = '', location = 'Head Office', date = '2026-01-10', accountId = '1') => ({ date, type, txn, debit, credit, location, accountId });

test('the lines are read from the groups of Zoho\'s answer (inside the usual `data` wrapper too): type, transaction id, amounts, location', () => {
  const line = (o) => ({ date: '2026-01-01', transaction_type: 'bill', transaction_id: '7', debit: 10, credit: '', account_id: '1', branch: { location_name: 'Panchu' }, ...o });
  const rows = stockLedgerRows([
    { data: { account_transactions: [{ group_name: 'a', account_transactions: [line({}), line({ debit: '', credit: 4, transaction_type: 'invoice', branch: undefined, transaction_details: 'Gajner' })] }] } },
    { account_transactions: [{ account_transactions: [line({ account_id: undefined })] }] },
  ]);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { date: '2026-01-01', type: 'bill', txn: '7', debit: 10, credit: 0, location: 'Panchu', accountId: '1' });
  assert.deepEqual([rows[1].credit, rows[1].location, rows[1].type], [4, 'Gajner', 'invoice'], 'the location may be the line\'s own text');
  assert.equal(rows[2].accountId, null);
  assert.deepEqual(stockLedgerRows(null), []);
});

test('a stock transfer is two lines with one transaction id; the ones whose two sides differ are listed, with what they add to the ledger', () => {
  const m = reduceStockLedger([
    row('opening_balance', 1000, 0),
    row('bill', 500, 0), row('invoice', 0, 200), row('inventory_adjustment_by_quantity', 0, 30), row('inventory_adjustment_by_value', 5, 0),
    // equal transfer
    row('transfer_order_out', 0, 400, 'T1', 'Head Office'), row('transfer_order_in', 400, 0, 'T1', 'Panchu'),
    // unequal: more comes in than went out
    row('transfer_order_out', 0, 100, 'T2', 'Head Office', '2026-02-01'), row('transfer_order_in', 130, 0, 'T2', 'Gajner', '2026-02-03'),
    // unequal: nothing went out
    row('transfer_order_out', 0, 0, 'T3', 'Panchu'), row('transfer_order_in', 70, 0, 'T3', 'Panchu'),
    // on its way: only the out side is dated before the balance sheet date
    row('transfer_order_out', 0, 25, 'T4', 'Gajner'),
    row('bundle', 0, 0), row('transfer_order', 0, 0),
  ]);
  assert.equal(m.entries, 14);
  assert.equal(m.net, 1000 + 500 - 200 - 30 + 5 + 0 + 30 + 70 - 25);
  assert.deepEqual(m.transfers.orders, 4);
  assert.deepEqual(m.transfers.unequal.map((o) => [o.id, o.diff, o.side, o.from, o.to]), [
    ['T3', 70, 'both', 'Panchu', 'Panchu'], ['T2', 30, 'both', 'Head Office', 'Gajner'], ['T4', -25, 'out only', 'Gajner', ''],
  ]);
  assert.deepEqual([m.transfers.unequalCount, m.transfers.net], [3, 75]);
  assert.deepEqual(m.manual, { count: 0, net: 0 });
  assert.deepEqual(m.byType.map((t) => [t.label, t.count]), [
    ['Opening balance', 1], ['Bills', 1], ['Invoices', 1], ['Stock adjustments', 2], ['Stock transfers between locations', 8], ['Bundles / composite items', 1],
  ]);
  const withJournal = reduceStockLedger([row('journal', 50, 0), row('journal', 0, 20), row('bill', 5, 0)]);
  assert.deepEqual(withJournal.manual, { count: 2, net: 30 });
  assert.deepEqual(withJournal.byType.map((t) => t.label), ['Bills', 'Manual journals']);
  // a transaction type nobody listed keeps its own name
  assert.equal(reduceStockLedger([row('mystery_type', 1, 0)]).byType[0].label, 'mystery_type');
  // a difference under half a paisa is no difference
  assert.equal(reduceStockLedger([row('transfer_order_out', 0, 10, 'X'), row('transfer_order_in', 10.004, 0, 'X')]).transfers.unequalCount, 0);
});

test('only the largest unequal transfers are kept in the snapshot; all of them are counted and added up', () => {
  const rows = [];
  for (let i = 1; i <= MAX_UNEQUAL_KEPT + 10; i += 1) rows.push(row('transfer_order_out', 0, 0, `T${i}`), row('transfer_order_in', i, 0, `T${i}`));
  const m = reduceStockLedger(rows);
  assert.equal(m.transfers.unequal.length, MAX_UNEQUAL_KEPT);
  assert.equal(m.transfers.unequalCount, MAX_UNEQUAL_KEPT + 10);
  assert.equal(m.transfers.net, (MAX_UNEQUAL_KEPT + 10) * (MAX_UNEQUAL_KEPT + 11) / 2);
  assert.equal(m.transfers.unequal[0].diff, MAX_UNEQUAL_KEPT + 10, 'largest first');
});

test('the ledger must add up to the account in the Trial Balance and be the account asked for; the gap is split into the transfers and the rest', () => {
  const rows = [row('opening_balance', 1000, 0), row('bill', 500, 0), row('transfer_order_out', 0, 0, 'T', 'A'), row('transfer_order_in', 200, 0, 'T', 'B')];
  const ok = buildStockLedger(rows, { name: 'Inventory Asset', id: '1', tb: 1700, items: 1450 });
  assert.deepEqual([ok.gap, ok.transfersNet, ok.otherNet, ok.entries, ok.net, ok.account, ok.id], [250, 200, 50, 4, 1700, 'Inventory Asset', '1']);
  assert.match(buildStockLedger(rows, { name: 'Inventory Asset', id: '1', tb: 1800, items: 1450 }).error, /add up to 1,700\.00 but the Trial Balance says 1,800\.00/);
  assert.match(buildStockLedger([row('bill', 5, 0, '', 'x', '2026-01-01', '999')], { name: 'Inventory Asset', id: '1', tb: 5, items: 5 }).error, /another account \(999\)/);
  assert.match(buildStockLedger([], { name: 'Inventory Asset', id: '1', tb: 0, items: 0 }).error, /has no lines/);
  // within a rupee of the Trial Balance is the same
  assert.equal(buildStockLedger(rows, { name: 'Inventory Asset', id: '1', tb: 1700.9, items: 1450 }).error, undefined);
  // the sentence for the alerts page
  assert.match(ledgerGapMessage(ok), /Inventory Asset: the Trial Balance is 250\.00 more than the items booked to it\. Its ledger \(4 lines\) has no manual journal; 1 stock transfer between locations was posted at unequal values \(\+200\.00\) and the other postings make \+50\.00/);
  assert.match(ledgerGapMessage({ ...ok, gap: -12, transfersNet: 0, otherNet: -12, manual: { count: 2, net: 5 }, transfers: { ...ok.transfers, unequalCount: 3 } }), /12\.00 less .* 2 manual journal line\(s\); 3 stock transfers between locations were posted .* -12\.00/);
});

// ---------- the real ledger of Inventory Asset (17-Oct-2026) ----------

test('the real ledger: 6,504 lines tie to the Trial Balance, hold no manual journal, and the gap of 9,14,700.60 is six unequal transfers (+9,58,533.60) and other postings (-43,833.00)', { skip }, async () => {
  const snap = await run();
  assert.equal(snap.meta.ok, true);
  assert.equal(snap.meta.warnings, 0);
  const l = snap.stock.ledger;
  assert.equal(l.error, undefined);
  assert.deepEqual([l.account, l.id, l.entries, l.net], ['Inventory Asset', '2346113000000000626', 6504, 26202924.62]);
  assert.deepEqual([l.gap, l.transfersNet, l.otherNet], [914700.6, 958533.6, -43833]);
  assert.deepEqual(l.manual, { count: 0, net: 0 }, 'not one manual journal in the account');
  assert.deepEqual(l.byType.map((t) => [t.label, t.count]), [
    ['Opening balance', 1], ['Bills', 885], ['Vendor credits', 9], ['Invoices', 271], ['Credit notes', 20], ['Stock adjustments', 583],
    ['Stock transfers between locations', 4691], ['Bundles / composite items', 44],
  ]);
  assert.equal(l.byType.reduce((t, x) => t + x.net, 0).toFixed(2), '26202924.62', 'the types add up to the account');
  assert.deepEqual([l.transfers.orders, l.transfers.unequalCount, l.transfers.net], [2313, 6, 958533.6]);
  assert.deepEqual(l.transfers.unequal.map((o) => [o.id, o.out, o.in, o.diff, o.from, o.to, o.side]), [
    ['2346113000013017539', 0, 1236700.6, 1236700.6, 'Panchu', 'Panchu', 'both'],
    ['2346113000015428149', 800000, 10, -799990, 'Gajner', 'Panchu', 'both'],
    ['2346113000014361075', 13472067, 13801027.5, 328960.5, 'Head Office', 'Panchu', 'both'],
    ['2346113000009980289', 0, 198000, 198000, 'Panchu', 'Panchu', 'both'],
    ['2346113000015620258', 42750, 38250, -4500, 'Panchu', 'Gajner', 'both'],
    ['2346113000014663300', 2687.5, 2050, -637.5, 'Gajner', 'Head Office', 'both'],
  ]);
  assert.deepEqual(l.transfers.unequal.map((o) => [o.outDate, o.inDate]).slice(0, 3), [['2025-11-19', '2025-11-19'], ['2026-01-15', '2026-01-17'], ['2025-12-18', '2025-12-18']]);
  // the account row of the by-account table and the ledger agree on the gap
  assert.equal(snap.stock.byAccount.find((r) => r.name === 'Inventory Asset').gap, l.gap);
  const a = snap.alerts.filter((x) => x.code === 'STOCK_GAP_EXPLAINED');
  assert.equal(a.length, 1);
  assert.equal(a[0].level, 'info');
  assert.match(a[0].message, /no manual journal; 6 stock transfers between locations were posted at unequal values \(\+9,58,533\.60\) and the other postings make -43,833\.00/);
  assert.equal(snap.meta.stock.ledgerLines, 6504);
  assert.deepEqual(JSON.parse(JSON.stringify(snap)), snap, 'still plain JSON');
  assert.ok(JSON.stringify(snap.stock.ledger).length < 5000, 'a few lines, not the ledger');
});

// ---------- the refresh ----------

test('the ledger is asked for by the account id of the Trial Balance, from the first day of the books, 2000 lines a page; without the setting it is not read at all', { skip }, async () => {
  const zoho = replayZoho();
  const snap = await buildSnapshot({ zoho, config, fy: FY, now: () => NOW });
  const asked = zoho.calls.filter((c) => c.path === '/reports/generalledgerdetails' && c.query.rule.columns[0].value[0] === '2346113000000000626');
  assert.equal(asked.length, 4);
  assert.deepEqual(asked.map((c) => c.query.page), [1, 2, 3, 4]);
  assert.deepEqual(asked.map((c) => c.query.rule.columns[0].value.length), [1, 1, 1, 1]);
  assert.ok(snap.stock.ledger.entries === 6504);
  const without = { ...config, settings: { ...config.settings, stock_ledger_account: undefined } };
  const z2 = replayZoho();
  const s2 = await buildSnapshot({ zoho: z2, config: without, fy: FY, now: () => NOW });
  assert.equal(s2.meta.apiCalls, snap.meta.apiCalls - 4);
  assert.equal(s2.stock.ledger, undefined);
  assert.equal(s2.alerts.filter((x) => x.code.startsWith('STOCK_')).length, 1, 'only the old note about the gap');
  assert.equal(s2.meta.ok, true);
  // an account that is not among the stock accounts of the Trial Balance: not asked for
  const other = { ...config, settings: { ...config.settings, stock_ledger_account: 'No such account' } };
  const s3 = await buildSnapshot({ zoho: replayZoho(), config: other, fy: FY, now: () => NOW });
  assert.equal(s3.stock.ledger, undefined);
  assert.equal(s3.meta.apiCalls, snap.meta.apiCalls - 4);
});

test('a ledger Zoho refuses, ignores the account of, or that does not add up leaves the gap unexplained (an info note) - the stock tab and the statements are unharmed', { skip }, async () => {
  for (const [options, why] of [
    [{ stockLedgerFail: 'refused' }, /not authorized/],
    [{ stockLedgerRows: (rows) => rows.slice(0, 5000) }, /add up to/],
    [{ stockLedgerRows: (rows) => rows.filter((r) => r[1] !== 'bill') }, /add up to/],
    [{ stockLedgerIgnoreRule: true }, /Zoho ignored the account filter/],
    [{ stockLedgerRows: () => [] }, /no lines|no line/i],
  ]) {
    const snap = await run(options);
    assert.equal(snap.meta.ok, true, JSON.stringify(Object.keys(options)));
    assert.equal(snap.meta.warnings, 0, 'an explanation that is missing is information, not a warning');
    assert.match(snap.stock.ledger.error, why);
    assert.equal(snap.stock.lines.length, 246, 'the items are still read');
    const n = snap.alerts.filter((a) => a.code === 'STOCK_LEDGER_UNAVAILABLE');
    assert.equal(n.length, 1);
    assert.equal(n[0].level, 'info');
    assert.equal(snap.alerts.filter((a) => a.code === 'STOCK_GAP_EXPLAINED').length, 0);
    assert.equal(snap.alerts.filter((a) => a.code === 'STOCK_GL_GAP').length, 1, 'the gap itself is still stated');
    const o = liveOverlay(snap, sheet());
    assert.equal(o.problems.length, 0, 'the sheet check does not depend on the ledger');
    assert.equal(o.summary.ok, 249);
  }
});

test('a stock summary that cannot be read leaves no ledger part either (nothing to explain)', { skip }, async () => {
  const snap = await run({ stockFail: 'refused' });
  assert.ok(snap.stock.error);
  assert.equal(snap.stock.ledger, undefined);
});

test('buildStockSection: the ledger part is skipped when no ledger is handed in', () => {
  const alerts = [];
  const pages = [{ code: 0, inventory_valuation: [{ item_name: 'A', inventory_account: 'Inventory Asset', quantity_available: 1, asset_value: 100 }], page_context: { page: 1, has_more_page: false, as_of_date: '2026-03-31' } }];
  const s = buildStockSection({ pages, buckets: { inventory: { accounts: [{ id: '1', name: 'Inventory Asset', closing: 100 }] } }, alerts });
  assert.equal(s.ledger, undefined);
  const withErr = buildStockSection({ pages, buckets: { inventory: { accounts: [{ id: '1', name: 'Inventory Asset', closing: 100 }] } }, alerts, ledger: { account: { id: '1', name: 'Inventory Asset', closing: 100 }, pages: { error: new Error('boom') } } });
  assert.equal(withErr.ledger.error, 'boom');
  assert.equal(alerts.at(-1).code, 'STOCK_LEDGER_UNAVAILABLE');
});

// ---------- the sheet's own Difference ----------

test('stockgap: the sheet\'s Difference is the Trial Balance less the items less the named ledger account, and it is checked against the signed 4,32,747', { skip }, async () => {
  assert.deepEqual(parseSource('stockgap:NPD Panchu Purchase'), { kind: 'stockgap', account: 'NPD Panchu Purchase' });
  const snap = await run();
  const v = stockGapValue(snap, 'NPD Panchu Purchase');
  assert.ok(Math.abs(v - 432747.6) < 0.005, String(v));
  assert.equal(stockGapValue(snap, 'npd panchu purchase'), v, 'the name is found whatever the case');
  assert.equal(stockGapValue(snap, 'No such account'), null);
  assert.equal(stockGapValue({ stock: { error: 'x' } }, 'NPD Panchu Purchase'), null);
  assert.equal(sourceUnavailable(snap, 'stockgap:NPD Panchu Purchase'), null);
  assert.match(sourceUnavailable(snap, 'stockgap:No such account'), /not among the stock accounts/);
  assert.match(sourceUnavailable({ stock: { error: 'refused' } }, 'stockgap:NPD Panchu Purchase'), /stock summary is not in this snapshot/);
  // a ledger account the snapshot does not know: that one line stays as signed, with the reason
  const live = JSON.parse(JSON.stringify(sheet().entry.live));
  live.blocks.find((b) => b.start === 'Difference').source = 'stockgap:No such account';
  const o = buildOverlay(snap, sheet(), live);
  assert.equal(o.problems.length, 1);
  assert.match(o.problems[0], /^Difference \(the auditors' working\): The ledger account "No such account"/);
  assert.equal(o.summary.ok, 248);
  assert.equal(o.summary.keptAsSigned, 1);
});
