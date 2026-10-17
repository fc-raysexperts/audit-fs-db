// update-19: the Usage unit of the Closing Stock tab, live. The unit of each stock item is read from Zoho's item list (`GET /items`, active and inactive; lib/zohoData.mjs fetchItemList,
// lib/stock.mjs itemUnitsOf), matched to the lines of the stock summary by SKU, and compared with the signed sheet as text. Small made-up data for the rules, then the replay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../lib/config.mjs';
import { buildSnapshot, buildStockSection } from '../lib/snapshot.mjs';
import { readSheet, liveOverlay } from '../lib/workbook.mjs';
import { fetchItemList, LoadError } from '../lib/zohoData.mjs';
import { itemUnitsOf, normalizeInventoryValuation, buildStock } from '../lib/stock.mjs';
import { sourceUnavailable, columnsUnavailable } from '../lib/overlay.mjs';
import { replayZoho, haveFixtures } from '../testing/fakes.mjs';

const skip = !haveFixtures();
const config = loadConfig('2025-26');
const NOW = Date.parse('2026-10-15T06:30:00+05:30');
const FY = '2025-26';
const run = (options) => buildSnapshot({ zoho: replayZoho(options), config, fy: FY, now: () => NOW });
const sheet = () => readSheet(config.workbook, 'closing-stock');
const overlayOf = (snap) => liveOverlay(snap, sheet());
const unitCol = (o) => o.columns.find((c) => c.field === 'unit');

// ---------- the rules, on made-up data ----------

const it = (sku, unit, extra = {}) => ({ item_id: `id-${sku}`, name: `Item ${sku}`, sku, unit, status: 'active', ...extra });
const pageOf = (items) => ({ code: 0, message: 'success', items, page_context: { page: 1, has_more_page: false } });

test('the item list gives the unit of each SKU (the usual `data` wrapper too); a SKU shared by two items with different units, an item without SKU or without unit is not used', () => {
  const u = itemUnitsOf([
    pageOf([it('A-1', 'Kgs'), it(' b-2 ', 'Mtr'), it('C-3', ''), it('', 'Nos'), it('D-4', 'Set'), it('D-4', 'Nos'), it('E-5', 'pcs'), it('E-5', 'pcs')]),
    { data: pageOf([it('F-6', 'Packet')]) },
  ]);
  assert.deepEqual([...u.bySku.entries()].sort(), [['a-1', 'Kgs'], ['b-2', 'Mtr'], ['e-5', 'pcs'], ['f-6', 'Packet']]);
  assert.deepEqual([u.items, u.withUnit, u.ambiguous], [9, 4, 1]);
  assert.throws(() => itemUnitsOf([pageOf([])]), /no items/);
  assert.throws(() => itemUnitsOf([]), /no items/);
});

test('the stock lines take their unit from the item list by SKU (case and spaces ignored) and from nowhere else: the unit the report itself gives is not used', () => {
  const norm = normalizeInventoryValuation([{ code: 0, inventory_valuation: [
    { item_name: 'Cable', sku: 'A-1', asset_value: 100, quantity_available: 5, inventory_account: 'Inventory Asset' },
    { item_name: 'Bolt', sku: 'B-2 ', asset_value: 50, quantity_available: 2, inventory_account: 'Inventory Asset', item_unit: 'Nos' },
    { item_name: 'Nut', sku: 'Z-9', asset_value: 10, quantity_available: 1, inventory_account: 'Inventory Asset', item_unit: 'kg' },
    { item_name: 'Washer', sku: 'W-0', asset_value: 5, quantity_available: 1, inventory_account: 'Inventory Asset' },
  ], page_context: { page: 1, has_more_page: false, as_of_date: '2026-03-31' } }]);
  const units = itemUnitsOf([pageOf([it('A-1', 'Kgs'), it('b-2', 'Mtr')])]);
  const built = buildStock(norm, { inventory: { accounts: [{ id: '1', name: 'Inventory Asset', closing: 165 }] } }, [], units);
  assert.deepEqual(built.lines.map((l) => [l.name, l.unit]), [['Cable', 'Kgs'], ['Bolt', 'Mtr'], ['Nut', null], ['Washer', null]], 'the unit the report gives for Bolt (Nos) and Nut (kg) is not used');
  const none = buildStock(norm, { inventory: { accounts: [{ id: '1', name: 'Inventory Asset', closing: 165 }] } }, []);
  assert.deepEqual(none.lines.map((l) => l.unit), [null, null, null, null], 'without the item list no line carries a unit');
});

// ---------- the request ----------

test('the item list is asked for with its inactive items, 200 a page in a fixed order, until Zoho says there is no more; an empty list is refused', { skip }, async () => {
  const zoho = replayZoho();
  const pages = await fetchItemList(zoho);
  assert.equal(pages.length, 5);
  assert.deepEqual(zoho.calls.map((c) => c.path), Array(5).fill('/items'));
  const q = zoho.calls[0].query;
  assert.deepEqual([q.filter_by, q.sort_column, q.per_page], ['Status.All', 'name', 200]);
  assert.deepEqual(zoho.calls.map((c) => c.query.page), [1, 2, 3, 4, 5]);
  await assert.rejects(fetchItemList(replayZoho({ itemsList: () => [] })), (e) => e instanceof LoadError && e.code === 'ITEMS_EMPTY');
});

// ---------- the snapshot and the tab ----------

test('the snapshot gives all 246 stock lines their unit, and the tab finds the unit of every signed row the same as Zoho\'s item list', { skip }, async () => {
  const snap = await run();
  assert.equal(snap.meta.ok, true);
  assert.equal(snap.meta.warnings, 0);
  assert.deepEqual([snap.meta.stock.itemPages, snap.meta.stock.unitLines], [5, 246]);
  assert.equal(snap.stock.lines.filter((l) => l.unit).length, 246, '25 of these items are inactive in the list: they are only there because the list is asked for with Status.All');
  assert.equal(snap.alerts.filter((a) => /^STOCK_UNITS/.test(a.code)).length, 0);
  const o = overlayOf(snap);
  assert.deepEqual(o.problems, []);
  const u = unitCol(o);
  assert.deepEqual([u.col, u.label, u.text, u.ok, u.diff, u.totalOk, u.totalBad], [4, 'Usage unit', true, 246, 0, 0, 0], 'a text column: no total');
  assert.deepEqual(JSON.parse(JSON.stringify(snap)), snap, 'still plain JSON');
});

test('a unit changed in Zoho since signing is a difference on its row, with Zoho\'s unit shown; case and spaces do not count', { skip }, async () => {
  const sh = sheet();
  const row = (name, unit) => sh.rows.findIndex((r, i) => i >= 2 && r[0] === name && r[4] === unit);
  const meter = row('Wire', 'Mtr');
  assert.ok(meter > 0);
  const snap = await run({
    itemsList: (items) => items.map((x) => {
      if (x.name === 'Wire' && x.unit === 'Mtr' && x.item_type === 'inventory') return { ...x, unit: 'm' }; // another spelling
      if (x.name === 'm-seal' && x.unit === 'Kgs') return { ...x, unit: ' kgs ' }; // same unit, other case and spaces
      return x;
    }),
  });
  const o = overlayOf(snap);
  const u = unitCol(o);
  assert.deepEqual([u.ok, u.diff], [245, 1]);
  const c = o.byRow[meter].cols[4];
  assert.deepEqual([c.status, c.live, c.signed, c.text], ['DIFF', 'm', 'Mtr', true]);
  assert.equal(o.byRow[meter].status, 'OK', 'the value of the row is untouched by its unit');
  const mseal = row('m-seal', 'Kgs');
  assert.equal(o.byRow[mseal].cols[4].status, 'OK');
});

test('an item list Zoho refuses leaves the unit as signed with the reason (info alert); the stock, the statements and the other columns are untouched', { skip }, async () => {
  for (const [options, why] of [[{ itemsFail: 'refused' }, /not authorized/], [{ itemsList: () => [] }, /item list is empty/]]) {
    const snap = await run(options);
    assert.equal(snap.meta.ok, true);
    assert.equal(snap.meta.reconciled.ok, 47);
    assert.equal(snap.meta.warnings, 0, 'an info note, not a warning');
    assert.equal(snap.stock.error, undefined);
    assert.match(snap.stock.unitsError, why);
    assert.deepEqual([snap.meta.stock.itemPages, snap.meta.stock.unitLines], [null, null]);
    const a = snap.alerts.filter((x) => x.code === 'STOCK_UNITS_UNAVAILABLE');
    assert.equal(a.length, 1);
    assert.equal(a[0].level, 'info');
    assert.match(a[0].message, /Usage unit.*stays as signed/);
    const o = overlayOf(snap);
    assert.equal(o.problems.length, 1);
    assert.match(o.problems[0], /^Usage unit: Zoho's item list could not be used/);
    assert.deepEqual(o.columns.map((c) => c.field), ['qty'], 'the quantity is still compared');
    assert.deepEqual([o.summary.lines, o.summary.ok], [249, 249]);
  }
});

test('only some stock lines found in the item list: the others stay as signed and an info note says how many', { skip }, async () => {
  const snap = await run({ itemsList: (items) => items.map((x, i) => (i % 2 === 0 && x.item_type === 'inventory' ? { ...x, unit: '' } : x)) });
  const held = snap.stock.lines.length;
  const withUnit = snap.stock.lines.filter((l) => l.unit).length;
  assert.ok(withUnit > 0 && withUnit < held);
  const a = snap.alerts.filter((x) => x.code === 'STOCK_UNITS_PARTIAL');
  assert.equal(a.length, 1);
  assert.match(a[0].message, new RegExp(`${withUnit} of the ${held} stock lines`));
  const o = overlayOf(snap);
  const u = unitCol(o);
  assert.deepEqual([u.ok, u.diff], [withUnit, 0], 'a line without a unit is not compared, not a difference');
});

test('a snapshot made before update-19 (no item list in it): the unit column says so and stays as signed; buildStockSection without the list raises no alert', { skip }, async () => {
  const snap = await run();
  const old = JSON.parse(JSON.stringify(snap));
  for (const l of old.stock.lines) delete l.unit;
  const o = overlayOf(old);
  assert.equal(o.problems.length, 1);
  assert.match(o.problems[0], /^Usage unit: Zoho's item list is not in this snapshot \(an older copy\): refresh the data/);
  assert.deepEqual(o.columns.map((c) => c.field), ['qty']);
  const alerts = [];
  const section = buildStockSection({ pages: [{ code: 0, inventory_valuation: [{ item_name: 'X', sku: 'x', asset_value: 1, quantity_available: 1, inventory_account: 'A' }], page_context: { page: 1, has_more_page: false, as_of_date: '2026-03-31' } }], buckets: { inventory: { accounts: [{ id: '1', name: 'A', closing: 1 }] } }, alerts });
  assert.equal(section.error, undefined);
  assert.deepEqual(alerts.filter((a) => /^STOCK_UNITS/.test(a.code)), []);
  assert.equal(section.unitsError, undefined);
  assert.equal(columnsUnavailable(snap, { needs: 'stockunit' }), null);
  assert.match(columnsUnavailable({ stock: { error: 'x' } }, { needs: 'stockunit' }), /^Usage unit: Zoho's stock summary is not in this snapshot/);
});
