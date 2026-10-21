// update-17: the Closing Stock tab, live. Zoho's Inventory Valuation Summary (lib/stock.mjs, fetchInventoryValuation) against the signed sheet, item by item (lib/overlay.mjs, `stock`),
// and by ledger account against the Trial Balance. Small made-up data for the rules, then the real FY26 data (saved from the probe of 17-Oct-2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../lib/config.mjs';
import { buildSnapshot } from '../lib/snapshot.mjs';
import { readSheet, liveOverlay, buildWorkbook } from '../lib/workbook.mjs';
import { fetchInventoryValuation, LoadError, STOCK_COLUMNS } from '../lib/zohoData.mjs';
import { normalizeInventoryValuation, buildStock } from '../lib/stock.mjs';
import { buildOverlay, buildPool, pairLines, parseSource, sourceUnavailable } from '../lib/overlay.mjs';
import { replayZoho, haveFixtures } from '../testing/fakes.mjs';

const skip = !haveFixtures();
const config = loadConfig('2025-26');
const NOW = Date.parse('2026-10-15T06:30:00+05:30');
const FY = '2025-26';
const clone = (x) => JSON.parse(JSON.stringify(x));
const run = (options) => buildSnapshot({ zoho: replayZoho(options), config, fy: FY, now: () => NOW });
const overlayOf = (snapshot) => liveOverlay(snapshot, readSheet(config.workbook, 'closing-stock'));

// ---------- the report ----------

const item = (name, qty, value, account = 'Inventory Asset', extra = {}) => ({ item_name: name, sku: `${name}-sku`, inventory_account: account, quantity_available: qty, asset_value: value, ...extra });
const page = (items, pc = {}) => ({ code: 0, message: 'success', inventory_valuation: items, page_context: { page: 1, has_more_page: false, as_of_date: '2026-03-31', ...pc } });

test('the stock summary is read wherever the lines sit in the answer: name, SKU, unit, ledger account, quantity and value, and the totals Zoho states', () => {
  const flat = normalizeInventoryValuation([page([item('Cable', 5, 100, 'Inventory Asset', { item_unit: 'Mtr' }), item('Bolt', 0, 0)], { total: 2, sum_columns: { quantity_available: '5', asset_value: 100 } })]);
  assert.deepEqual(flat.lines[0], { name: 'Cable', sku: 'Cable-sku', unit: 'Mtr', account: 'Inventory Asset', qty: 5, value: 100 });
  assert.equal(flat.lines.length, 2);
  assert.deepEqual([flat.asOf, flat.reportTotal, flat.reportQty, flat.reportLines], ['2026-03-31', 100, 5, 2]);
  // lines inside groups, inside the usual `data` wrapper; values as text
  const grouped = normalizeInventoryValuation([{ data: { inventory_valuation: [{ group_name: 'x', items: [item('Cable', '5', '100.50')] }], page_context: { to_date: '2026-03-31' } } }]);
  assert.deepEqual([grouped.lines.length, grouped.lines[0].value, grouped.lines[0].qty, grouped.asOf, grouped.reportTotal, grouped.reportLines], [1, 100.5, 5, '2026-03-31', null, null]);
  // the unit may sit in `item.unit`; the account may be called inventory_account_name
  const alt = normalizeInventoryValuation([page([{ item_name: 'X', asset_value: 1, quantity_available: 1, item: { unit: 'Kgs', sku: 'S' }, inventory_account_name: 'Acc' }])]);
  assert.deepEqual([alt.lines[0].unit, alt.lines[0].sku, alt.lines[0].account], ['Kgs', 'S', 'Acc']);
  assert.throws(() => normalizeInventoryValuation([]), /empty/);
});

test('only the lines that hold stock or value are kept; the stock is added up by ledger account and set against the Trial Balance', () => {
  const norm = normalizeInventoryValuation([page([
    item('A', 10, 1000, 'Inventory Asset'), item('A', 0, 0, 'Inventory Asset'), item('B', 2, 500, 'Project GM'), item('C', 1, 70, 'Elsewhere'),
  ], { total: 4, sum_columns: { asset_value: 1570 } })]);
  const buckets = { inventory: { accounts: [{ id: '1', name: 'Inventory Asset', closing: 1300 }, { id: '2', name: 'project gm', closing: 500 }, { id: '3', name: 'Empty one', closing: 0 }] } };
  const alerts = [];
  const s = buildStock(norm, buckets, alerts);
  assert.deepEqual([s.count, s.held, s.total, s.qty, s.tb, s.gap], [4, 3, 1570, 13, 1800, 230]);
  assert.deepEqual(s.lines.map((l) => [l.name, l.qty, l.value]), [['A', 10, 1000], ['B', 2, 500], ['C', 1, 70]]);
  const row = (name) => s.byAccount.find((r) => r.name === name);
  assert.deepEqual([row('Inventory Asset').items, row('Inventory Asset').tb, row('Inventory Asset').gap, row('Inventory Asset').lines], [1000, 1300, 300, 1]);
  assert.deepEqual([row('Project GM').gap, row('Project GM').tb], [0, 500], 'an account is found whatever the case of its name');
  assert.deepEqual([row('Elsewhere').tb, row('Elsewhere').gap, row('Elsewhere').items], [null, null, 70], 'an item booked outside the stock group of the Trial Balance is shown, with no Trial Balance figure');
  assert.equal(s.byAccount.find((r) => r.name === 'Empty one'), undefined, 'an account with nothing in it is left out');
  assert.equal(alerts.length, 1);
  assert.deepEqual([alerts[0].level, alerts[0].code], ['info', 'STOCK_GL_GAP']);
  assert.match(alerts[0].message, /Inventory Asset 300\.00/);
  assert.match(alerts[0].message, /Elsewhere 70\.00/);
  // when the items and the ledger agree there is nothing to say
  const quiet = [];
  buildStock(normalizeInventoryValuation([page([item('A', 1, 100, 'Inventory Asset')])]), { inventory: { accounts: [{ id: '1', name: 'Inventory Asset', closing: 100.4 }] } }, quiet);
  assert.deepEqual(quiet, []);
});

test('a report whose lines do not add up to its own totals (a page missing) is not used', () => {
  const lines = [item('A', 1, 100), item('B', 1, 200)];
  const wrongCount = buildStock(normalizeInventoryValuation([page(lines, { total: 819 })]), {});
  assert.match(wrongCount.error, /819 item lines but 2 were read/);
  const wrongTotal = buildStock(normalizeInventoryValuation([page(lines, { total: 2, sum_columns: { asset_value: 28646327057 / 100 } })]), {});
  assert.match(wrongTotal.error, /add up to 300\.00 but the report's own total is 28,64,63,270\.57/);
  assert.match(buildStock({ lines: [], reportLines: null, reportTotal: null }, {}).error, /no item lines/);
  // a report that does not state its totals is believed
  assert.equal(buildStock(normalizeInventoryValuation([page(lines)]), {}).error, undefined);
});

// ---------- the question put to Zoho ----------

test('the stock summary is asked for as at the balance sheet date, 200 lines a page in a fixed order, with named columns; its date is checked', { skip }, async () => {
  const zoho = replayZoho();
  const pages = await fetchInventoryValuation(zoho, { from: '2025-04-01', to: '2026-03-31' });
  assert.equal(pages.length, 5);
  assert.equal(zoho.calls.length, 5);
  const q = zoho.calls[0].query;
  assert.equal(zoho.calls[0].path, '/reports/inventoryvaluation');
  assert.deepEqual([q.filter_by, q.from_date, q.to_date, q.per_page, q.sort_column, q.stock_on_hand_filter, q.status_filter], ['TransactionDate.CustomDate', '2025-04-01', '2026-03-31', 200, 'item_name', 'All', 'All']);
  assert.deepEqual(q.select_columns.map((c) => c.field), STOCK_COLUMNS.map((c) => c.field));
  assert.deepEqual(zoho.calls.map((c) => c.query.page), [1, 2, 3, 4, 5]);
  await assert.rejects(fetchInventoryValuation(replayZoho({ stockDate: '2026-03-30' }), { from: '2025-04-01', to: '2026-03-31' }), (e) => e instanceof LoadError && e.code === 'STOCK_DATE');
});

// ---------- the snapshot ----------

test('the snapshot carries the stock: 819 lines read, 246 with stock, the total of the signed sheet to the paisa, and the gap to the ledger in Inventory Asset alone', { skip }, async () => {
  const snap = await run();
  assert.equal(snap.meta.ok, true);
  assert.equal(snap.meta.warnings, 0);
  assert.deepEqual(snap.meta.stock, { lines: 819, held: 246, pages: 5, ledgerLines: 6504, itemPages: 5, unitLines: 246 });
  const s = snap.stock;
  assert.deepEqual([s.asOf, s.count, s.held, s.total, s.qty, s.tb, s.gap], ['2026-03-31', 819, 246, 286463270.57, 1196037.148, 287377971.17, 914700.6]);
  const by = Object.fromEntries(s.byAccount.map((r) => [r.name, r]));
  assert.deepEqual(Object.keys(by).sort(), ['Inventories - Project Material GM', 'Inventory Asset', 'NPD Panchu Purchase']);
  assert.deepEqual([by['Inventories - Project Material GM'].items, by['Inventories - Project Material GM'].gap, by['Inventories - Project Material GM'].lines], [260693093.55, 0, 160]);
  assert.deepEqual([by['NPD Panchu Purchase'].items, by['NPD Panchu Purchase'].gap, by['NPD Panchu Purchase'].lines], [481953, 0, 2]);
  assert.deepEqual([by['Inventory Asset'].items, by['Inventory Asset'].tb, by['Inventory Asset'].gap, by['Inventory Asset'].lines], [25288224.02, 26202924.62, 914700.6, 84]);
  const note = snap.alerts.filter((a) => a.code === 'STOCK_GL_GAP');
  assert.equal(note.length, 1);
  assert.equal(note[0].level, 'info');
  assert.match(note[0].message, /Inventory Asset 9,14,700\.60/);
  assert.ok(s.lines.every((l) => l.value !== 0 || l.qty !== 0));
  assert.deepEqual(JSON.parse(JSON.stringify(snap)), snap, 'still plain JSON');
});

test('a stock summary Zoho refuses, or whose pages do not add up, or whose date is wrong, leaves the tab as signed with a warning - the statements are built all the same', { skip }, async () => {
  for (const [options, why] of [
    [{ stockFail: 'refused' }, /not authorized/],
    [{ stockTotal: 123 }, /report's own total is 123\.00/],
    [{ stockDate: '2026-03-30' }, /as at 2026-03-30, not 2026-03-31/],
    [{ stockItems: () => [] }, /no item lines/],
  ]) {
    const snap = await run(options);
    assert.equal(snap.meta.ok, true, JSON.stringify(options));
    assert.equal(snap.meta.reconciled.ok, 47);
    assert.match(snap.stock.error, why);
    assert.equal(snap.meta.stock, null);
    const w = snap.alerts.filter((a) => a.code === 'STOCK_UNAVAILABLE');
    assert.equal(w.length, 1);
    assert.equal(w[0].level, 'warn');
    assert.match(w[0].message, /Closing Stock tab stays as signed/);
    assert.equal(snap.alerts.filter((a) => a.code === 'STOCK_GL_GAP').length, 0);
    // ... and the tab: the items stay as signed, with the reason; the closing lines that come from the Trial Balance are still checked
    const o = overlayOf(snap);
    assert.equal(o.blocks[0].source, null);
    assert.equal(o.problems.length, 4);
    assert.match(o.problems[0], /^Items: Zoho's stock summary is not in this snapshot/);
    assert.match(o.problems[1], /^Difference \(the auditors' working\): Zoho's stock summary is not in this snapshot/);
    assert.match(o.problems[2], /Stock quantities/);
    assert.match(o.problems[3], /^Usage unit: Zoho's stock summary is not in this snapshot/);
    assert.deepEqual([o.summary.lines, o.summary.ok, o.summary.keptAsSigned, o.summary.columns.length], [2, 2, 247, 0]);
  }
});

test('a report with lines missing against the total it states is not used', { skip }, async () => {
  const dropped = await run({ stockItems: (items) => items.slice(0, 700), stockTotal: 286463270.57 });
  assert.match(dropped.stock.error, /lines add up to/);
});

// ---------- the Closing Stock tab ----------

test('Closing Stock: all 246 signed rows and the foot of the sheet agree with Zoho today, the quantity of every row too, and the totals', { skip }, async () => {
  const snap = await run();
  const o = overlayOf(snap);
  assert.deepEqual(o.problems, []);
  assert.deepEqual([o.summary.lines, o.summary.ok, o.summary.name, o.summary.diff, o.summary.none, o.summary.lump], [249, 249, 0, 0, 0, 0], '246 items + NPD Panchu + the sheet\'s Difference + the Trial Balance value');
  assert.deepEqual([o.summary.totalsOk, o.summary.totalsBad, o.summary.extras, o.summary.keptAsSigned], [1, 0, 0, 0], 'since update-18 nothing is left as signed on the foot of the sheet');
  assert.deepEqual(o.blocks.map((b) => [b.title, b.ok]), [['Items', 246], ['NPD Panchu Purchase (ledger account)', 1], ["Difference (the auditors' working)", 1], ['Stock accounts of the Trial Balance', 1]]);
  const [qty, unit] = o.columns;
  assert.deepEqual([qty.field, qty.col, qty.ok, qty.diff, qty.totalOk, qty.totalBad], ['qty', 1, 246, 0, 1, 0]);
  assert.deepEqual([unit.field, unit.col, unit.text, unit.ok, unit.diff], ['unit', 4, true, 246, 0], 'update-19: the Usage unit of every row is the unit of that item in Zoho\'s item list');
  const sh = readSheet(config.workbook, 'closing-stock');
  const at = (label, nth = 1) => Object.entries(o.byRow).filter(([r]) => sh.rows[r][0] === label)[nth - 1]?.[1];
  assert.deepEqual([at('Total').kind, at('Total').status], ['total', 'OK']);
  assert.deepEqual([at('NPD Panchu Purchase').status, at('NPD Panchu Purchase').live], ['OK', 481953]);
  assert.equal(at('Value as Per Trial Balance').status, 'OK');
  assert.ok(Math.abs(at('Value as Per Trial Balance').live - 287377971.17) < 0.005, 'the whole Trial Balance stock group, as the foot of the sheet says');
  // the sheet's own working: Difference = the Trial Balance's stock accounts - the items of the stock summary - NPD Panchu Purchase (4,81,953 + 9,14,700.60 - 4,81,953 ... see the next line)
  assert.deepEqual([at('Difference').status, at('Difference').signed], ['OK', 432747]);
  assert.ok(Math.abs(at('Difference').live - 432747.6) < 0.005, 'Trial Balance 28,73,77,971.17 - items 28,64,63,270.57 - NPD Panchu 4,81,953 = 4,32,747.60, against 4,32,747 as signed');
  // an item on two rows of the sheet takes its own two Zoho lines: ABT meter (the NPD Panchu one and the Inventory Asset one)
  const abt = Object.entries(o.byRow).filter(([r]) => sh.rows[r][0] === 'ABT meter').map(([, x]) => [x.signed, x.live, x.status, x.cols[1].live]);
  assert.deepEqual(abt.sort((a, b) => a[0] - b[0]), [[89000, 89000, 'OK', 2], [107000, 107000, 'OK', 5]]);
  // 45 items stand on more than one row, and every one of those rows agrees
  const names = {};
  sh.rows.slice(2, 248).forEach((r) => { names[r[0]] = (names[r[0]] ?? 0) + 1; });
  assert.equal(Object.values(names).filter((n) => n > 1).length, 45);
  // the quantity (col 1) and, since update-19, the unit (col 4) are claimed live; the 'New Rate' column (col 2) is empty on the signed sheet, so there is nothing to claim
  assert.deepEqual(o.columns.map((c) => c.col), [1, 4]);
  assert.ok(sh.rows.slice(2, 248).every((r) => r[2] === null), 'New Rate is empty on all 246 rows');
});

test('Closing Stock: a figure changed in Zoho since signing is a difference on its row, in the quantity column and in the totals; an item gone or new is listed', { skip }, async () => {
  const snap = await run({
    stockItems: (items) => {
      const out = items.filter((x) => x.item_name !== 'Battery Energy Storage System'); // gone from Zoho
      const cable = out.find((x) => x.item_name === '0.75 SQMM Cable 2C' && x.asset_value > 0);
      cable.asset_value += 1500; // dearer
      cable.quantity_available -= 100; // fewer
      const abt = out.find((x) => x.item_name === 'ABT meter' && x.asset_value === 107000);
      abt.asset_value = 110000; // a figure that changed on one of an item's two lines
      out.push(item('Brand new item', 4, 4000, 'Inventories - Project Material GM')); // not on the sheet
      return out;
    },
  });
  const o = overlayOf(snap);
  const sh = readSheet(config.workbook, 'closing-stock');
  const row = (label, signed) => Object.entries(o.byRow).map(([r, x]) => ({ r, ...x })).find((x) => sh.rows[x.r][0] === label && x.signed === signed);
  const cable = row('0.75 SQMM Cable 2C', 167813);
  assert.deepEqual([cable.status, cable.live, cable.diff], ['DIFF', 169313, 1500]);
  assert.deepEqual([cable.cols[1].status, cable.cols[1].live, cable.cols[1].signed, cable.cols[1].diff], ['DIFF', 6600, 6700, -100]);
  const abt = row('ABT meter', 107000);
  assert.deepEqual([abt.status, abt.live], ['DIFF', 110000]);
  assert.equal(row('ABT meter', 89000).status, 'OK', 'the other line of the same item still agrees');
  const gone = row('Battery Energy Storage System', 108879641.34);
  assert.equal(gone.status, 'NONE');
  assert.equal(o.summary.none, 1);
  assert.deepEqual(o.blocks[0].notFound.map((n) => n.label), ['Battery Energy Storage System']);
  assert.deepEqual(o.extras, [{ group: 'Stock item', name: 'Brand new item', value: 4000 }]);
  assert.equal(o.summary.diff, 3, 'the two rows that changed + the sheet\'s Difference, which the changed items move');
  assert.equal(Object.values(o.byRow).find((x) => x.signed === 432747).status, 'DIFF');
  const total = Object.values(o.byRow).find((x) => x.kind === 'total');
  assert.equal(total.status, 'DIFF', 'the sheet total, worked out again with the live lines, no longer agrees');
  assert.equal(o.summary.totalsBad, 1);
  assert.ok(o.problems.length === 0);
  // the web page and the booklet count the sheet as one that has differences
  const w = buildWorkbook(snap, null, config.workbook, { ...config.books, related: config.related, register: config.register, subsidiaries: config.subsidiaries });
  const s = w.sheets.find((x) => x.id === 'closing-stock');
  assert.equal(s.liveCheck.diff, 3);
});

test('Closing Stock: a quantity that differs by less than 0.01 is the same quantity; by more it is not', { skip }, async () => {
  const snap = await run({ stockItems: (items) => { items.find((x) => x.item_name === 'm-seal').quantity_available += 0.004; items.find((x) => x.item_name === 'NUT,BOLT & WASHER').quantity_available += 0.5; return items; } });
  const o = overlayOf(snap);
  const [qty] = o.columns;
  assert.deepEqual([qty.ok, qty.diff], [245, 1]);
  assert.equal(o.summary.diff, 0, 'the values did not move');
});

// ---------- the rules, on a small made-up sheet ----------

const stockSnap = (lines, extra = {}) => ({ stock: { lines: lines.map(([name, qty, value]) => ({ name, sku: null, account: 'A', qty, value })) }, buckets: { inventory: { accounts: [] } }, ...extra });
const miniLive = { label: 0, value: 2, blocks: [{ start: 'Item', source: 'stock', group: 's', perLine: true }], groups: { s: { source: 'stock', title: 'Stock item' } }, columns: [{ col: 1, field: 'qty', label: 'Qty', needs: 'stock', tol: 0.01, totalTol: 1 }] };
const miniSheet = (...rows) => ({ rows: [['Item', 'Qty', 'Value'], ...rows] });

test('stock is a source of its own: one entry per item name with its lines kept apart, and it says why it is missing', () => {
  assert.deepEqual(parseSource('stock'), { kind: 'stock', classes: null });
  const pool = buildPool(stockSnap([['Cable 2C', 5, 100], ['cable 2c', 7, 250], ['Bolt', 1, 10]]), 'stock');
  const e = pool.get('cable2c');
  assert.deepEqual([e.value, e.n, e.cols.qty, e.lines.length], [350, 2, 12, 2]);
  assert.deepEqual(e.lines.map((l) => [l.value, l.cols.qty]), [[100, 5], [250, 7]]);
  assert.equal(sourceUnavailable(stockSnap([]), 'stock'), null);
  assert.match(sourceUnavailable({ stock: { error: 'Zoho said no' } }, 'stock'), /not in this snapshot \(Zoho said no\)/);
  assert.match(sourceUnavailable({}, 'stock'), /an older copy/);
});

test('the rows of an item are paired with its Zoho lines by value first, then by size; what is left over is a difference, "not in Zoho" or an extra', () => {
  assert.deepEqual(pairLines([100, 200], [{ value: 200 }, { value: 100 }]), { pairs: [[0, 1], [1, 0]], noLine: [], noRow: [] }, 'the same values meet whatever the order');
  assert.deepEqual(pairLines([100, 200], [{ value: 100 }, { value: 250 }]), { pairs: [[0, 0], [1, 1]], noLine: [], noRow: [] }, 'the figure that changed meets its own line');
  assert.deepEqual(pairLines([500, 700], [{ value: 500 }]), { pairs: [[0, 0]], noLine: [1], noRow: [] });
  assert.deepEqual(pairLines([300], [{ value: 300 }, { value: 40 }]), { pairs: [[0, 0]], noLine: [], noRow: [1] });
  assert.deepEqual(pairLines([300], [{ value: 0 }, { value: 300 }]), { pairs: [[0, 1]], noLine: [], noRow: [] });
  assert.deepEqual(pairLines([300], [{ value: 0 }]), { pairs: [], noLine: [0], noRow: [] }, 'a line with nothing in it is no line');
  assert.deepEqual(pairLines([100, 100], [{ value: 100 }]), { pairs: [[0, 0]], noLine: [1], noRow: [] });
  assert.deepEqual(pairLines([], [{ value: 5 }]), { pairs: [], noLine: [], noRow: [0] });
});

test('perLine: every row meets the line of its own item; the quantity of that line is the one compared; a stock item is used once', () => {
  const snapshot = stockSnap([['Cable', 26, 1950], ['Cable', 219, 16425], ['Gland', 3, 600], ['Gland', 1, 90], ['Fuse', 5, 1000], ['Wire 4 Sqmm Red', 10, 777], ['Only in Zoho', 2, 55]]);
  const sheet = miniSheet(['Cable', 219, 16425], ['Cable', 26, 1950], ['Gland', 3, 600], ['Fuse', 5, 900], ['Wire 4 sqmm', 10, 777], ['Not in Zoho at all', 1, 12345], ['Total', 264, 33000]);
  const o = buildOverlay(snapshot, sheet, miniLive);
  const row = (i) => o.byRow[i]; // i = the position of the row in the made-up sheet (0 is its header)
  assert.deepEqual([row(1).status, row(1).live, row(1).cols[1].live], ['OK', 16425, 219]);
  assert.deepEqual([row(2).status, row(2).live, row(2).cols[1].live], ['OK', 1950, 26]);
  assert.deepEqual([row(3).status, row(3).live], ['OK', 600]);
  assert.deepEqual([row(4).status, row(4).live, row(4).diff], ['DIFF', 1000, 100]);
  assert.deepEqual([row(5).status, row(5).zohoName], ['NAME', 'Wire 4 Sqmm Red'], 'a renamed item is still found by its value and the words of its name');
  assert.equal(row(6).status, 'NONE');
  assert.deepEqual(o.extras.map((e) => [e.group, e.name, e.value]).sort((a, b) => b[2] - a[2]), [['Stock item', 'Gland', 90], ['Stock item', 'Only in Zoho', 55]]);
  assert.deepEqual([o.summary.ok, o.summary.name, o.summary.diff, o.summary.none], [3, 1, 1, 1]);
});

test('without perLine a block of the same source works as before: the second row of an item is not found', () => {
  const snapshot = stockSnap([['Cable', 26, 1950], ['Cable', 219, 16425]]);
  const sheet = miniSheet(['Cable', 26, 1950], ['Cable', 219, 16425]);
  const o = buildOverlay(snapshot, sheet, { ...miniLive, blocks: [{ start: 'Item', source: 'stock', group: 's' }], columns: [] });
  assert.deepEqual([o.summary.ok, o.summary.diff, o.summary.none], [0, 1, 1]);
  assert.equal(o.byRow[1].status, 'DIFF', 'the combined stock of the name (18,375) is not the first row (1,950)');
});

test('the closing lines of a sheet that have no heading of their own are blocks of their own (inclusive), and a stock the snapshot lacks leaves the items as signed', () => {
  const snapshot = { buckets: { inventory: { accounts: [{ id: '1', name: 'NPD Panchu Purchase', code: '', closing: 481953 }] } } };
  const sheet = miniSheet(['Cable', 1, 100], ['Total', 1, 100], ['NPD Panchu Purchase', null, 481953], ['Difference', null, 7]);
  const live = { ...miniLive, blocks: [{ start: 'Item', source: 'stock', group: 's', perLine: true }, { start: 'NPD Panchu Purchase', source: 'account:inventory', inclusive: true }, { start: 'Difference', source: null, inclusive: true }] };
  const o = buildOverlay(snapshot, sheet, live);
  assert.equal(o.blocks[0].source, null, 'no stock in the snapshot: as signed');
  assert.equal(o.byRow[3].status, 'OK', 'the closing line that is a ledger account is still checked');
  assert.equal(o.byRow[4], undefined);
  assert.equal(o.blocks[2].signed, 1);
  assert.equal(o.problems.length, 2);
  assert.equal(o.columns.length, 0);
});
