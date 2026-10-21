// update-28: Zoho's fixed asset register against the sheets FA Add and Dep.Calc. (lib/register.mjs, config/register.fy26.json).
// Made-up data for the rules; the real FY26 register (fixtures/register_fy26.json: the 502 assets Zoho gave on 21-Oct-2026 and the ledger lines of Land and Development Rights) for the sheets.
// The real ones are skipped without fixtures/.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../lib/config.mjs';
import { buildSnapshot } from '../lib/snapshot.mjs';
import { buildView } from '../lib/present.mjs';
import { buildBooks } from '../lib/books.mjs';
import { buildWorkbook, readSheet, liveVerify } from '../lib/workbook.mjs';
import { buildRegisterChecks, buildRegisterSection, normalizeRegister, readDepCalc, readFaAdd, registerAccountIds, assetFigures, daysInYear } from '../lib/register.mjs';
import { fetchFixedAssets, fetchAssetHistories, normalizeAssetHistory, normalizeAssetDetail, ASSET_HISTORY_VERSION } from '../lib/zohoData.mjs';
import { registerOpen, moreToRead, decideRefresh } from '../lib/server.mjs';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { replayZoho, haveFixtures } from '../testing/fakes.mjs';

const skip = !haveFixtures();
const config = loadConfig('2025-26');
const spec = config.register;
const NOW = Date.parse('2026-10-15T06:30:00+05:30');
// update-30: the checks of Dep.Calc. - 980 cost / book value + 3 x 483 depreciation + 3 totals (2432, update-29) + 483 useful lives + 483 days + 483 residual values + 219 rates
// (the 264 fully depreciated assets have no rate on the sheet); 124 of the 219 rates are the ones the sheet works out again each year (explained), 95 are Zoho's own
const DEP_LINES = 4100;
const DEP_EXPL = 124;

// ---------- the configuration itself ----------

test('config/register.fy26.json: every group of the two sheets is placed (in the register, in a ledger, or not in the register), once', () => {
  assert.ok(spec, 'the year has its register configuration');
  const names = new Set(Object.keys(spec.ledgerAccounts));
  for (const [group, g] of Object.entries(spec.ledgerGroups)) assert.ok(names.has(g.account), `${group}: its ledger account is configured`);
  for (const k of Object.keys(spec.ledgerAccounts)) assert.match(spec.ledgerAccounts[k].id, /^\d{15,}$/, `${k}: a Zoho id`);
  assert.deepEqual(registerAccountIds(spec).sort(), ['2346113000000054793', '2346113000026785958']);
  // the groups that the sheets really have
  const fa = readFaAdd(readSheet(config.workbook, 'fa-add').rows);
  const groups = new Set(fa.flatMap((t) => t.blocks).map((b) => b.items[0]?.group));
  for (const g of groups) assert.ok(spec.types[g] || spec.ledgerGroups[g], `FA Add: the group "${g}" is placed`);
  const dc = readDepCalc(readSheet(config.workbook, 'dep-calc').rows);
  for (const g of new Set(dc.lines.map((l) => l.group))) assert.ok(spec.types[g] || spec.notInRegister.includes(g), `Dep.Calc.: the group "${g}" is placed`);
});

// ---------- reading what Zoho sent ----------

const asset = (o = {}) => ({ fixed_asset_id: o.id ?? '1', asset_number: o.code ?? 'A-1', asset_name: o.name ?? '  A  printer ', fixed_asset_type_name: o.type ?? 'Computer Equipments', status: o.status ?? 'active', asset_cost: o.cost ?? 100, current_asset_value: o.value ?? 80, asset_purchase_date: o.date ?? '2025-05-01' });
const page = (assets, more = false, key = 'fixedassets') => ({ code: 0, message: 'success', [key]: assets, page_context: { page: 1, per_page: 200, has_more_page: more } }); // Zoho names the list `fixedassets` (seen on 21-Oct-2026)

test('the register is read from its pages: every asset whatever its status, names tidied; an unfinished or doubled answer is refused', () => {
  const list = normalizeRegister([page([asset(), asset({ id: '2', code: 'A-2', status: 'draft', cost: 1234.567 })])]);
  assert.deepEqual(list.map((a) => [a.id, a.code, a.name, a.type, a.status, a.cost, a.value, a.date]),
    [['1', 'A-1', 'A printer', 'Computer Equipments', 'active', 100, 80, '2025-05-01'], ['2', 'A-2', 'A printer', 'Computer Equipments', 'draft', 1234.57, 80, '2025-05-01']]);
  assert.throws(() => normalizeRegister([page([asset()], true)]), /incomplete/);
  assert.throws(() => normalizeRegister([page([asset()]), page([asset()])]), /twice/);
  assert.throws(() => normalizeRegister([{ code: 0 }]), /unexpected shape/);
  assert.throws(() => normalizeRegister([page([])]), /no fixed assets/);
  assert.throws(() => normalizeRegister([]), /no pages/);
});

test('update-29: Zoho sends the list as `fixedassets` (update-28 looked for `fixed_assets`); both names are read, any other is refused', () => {
  assert.equal(normalizeRegister([page([asset()])])[0].code, 'A-1');
  assert.equal(normalizeRegister([page([asset()], false, 'fixed_assets')])[0].code, 'A-1');
  assert.throws(() => normalizeRegister([page([asset()], false, 'assets')]), /unexpected shape \(no fixedassets list\)/);
});

test('the register section keeps what could be read and says what could not (a detail layer: an alert, not an error)', () => {
  const alerts = [];
  const ledger = { data: { account_transactions: [{ account_transactions: [{ date: '2025-12-11', transaction_type: 'journal', entity_number: 'J-1', debit: 3388800, credit: '', account_id: '2346113000000054793', account_name: 'Land', transaction_details: 'x' }] }], page_context: { total: 1, has_more_page: false } } };
  const ok = buildRegisterSection({ spec, assets: [page([asset(), asset({ id: '2', status: 'draft', code: 'A-2' })])], ledger: [ledger], from: '2025-04-01', to: '2026-03-31', alerts });
  assert.deepEqual([ok.assets.count, ok.assets.byStatus, ok.ledger.lines.length], [2, { active: 1, draft: 1 }, 1]);
  assert.deepEqual(ok.ledger.lines[0], { account: 'land', date: '2025-12-11', type: 'journal', entry: 'J-1', debit: 3388800, credit: 0, details: 'x' });
  assert.deepEqual(alerts, []);
  const bad = buildRegisterSection({ spec, assets: { error: new Error('refused') }, ledger: null, from: '2025-04-01', to: '2026-03-31', alerts });
  assert.deepEqual([bad.assets.error, bad.ledger.error], ['refused', 'not asked for']);
  assert.deepEqual(alerts.map((a) => [a.level, a.code]), [['warn', 'REGISTER_UNAVAILABLE']]);
  // a line of another account means the filter was ignored: the whole ledger is refused
  const stray = structuredClone(ledger);
  stray.data.account_transactions[0].account_transactions[0].account_id = '999';
  const refused = buildRegisterSection({ spec, assets: null, ledger: [stray], from: '2025-04-01', to: '2026-03-31', alerts: [] });
  assert.match(refused.ledger.error, /filter was ignored/);
});

test('the fixed asset list is asked for with every status, 200 at a time, until the last page', async () => {
  const calls = [];
  const zoho = { get: async (p, q) => { calls.push([p, q]); return page([asset({ id: String(q.page) })], q.page < 3); } };
  const pages = await fetchFixedAssets(zoho);
  assert.equal(pages.length, 3);
  assert.deepEqual(calls.map(([p, q]) => [p, q.filter_by, q.per_page, q.page]), [['/fixedassets', 'Status.All', 200, 1], ['/fixedassets', 'Status.All', 200, 2], ['/fixedassets', 'Status.All', 200, 3]]);
  await assert.rejects(fetchFixedAssets({ get: async () => page([asset()], true) }, { maxPages: 2 }), /more than 2 pages/);
});

// ---------- the real FY26 register against the two sheets ----------

const run = (options) => buildSnapshot({ zoho: replayZoho(options), config, fy: '2025-26', now: () => NOW });
let memo = null;
const base = async () => (memo ??= await run({}));
const sheet = (id) => readSheet(config.workbook, id);
const check = (snapshot, side) => buildRegisterChecks({ snapshot, spec, rows: sheet(side).rows, side });

test('the refresh reads the register (all statuses, 3 pages) and the ledger of Land and Development Rights for the year', { skip }, async () => {
  const zoho = replayZoho();
  const snap = await buildSnapshot({ zoho, config, fy: '2025-26', now: () => NOW });
  assert.equal(snap.meta.ok, true);
  const fa = zoho.calls.filter((c) => c.path === '/fixedassets');
  assert.deepEqual(fa.map((c) => [c.query.filter_by, c.query.per_page, c.query.page]), [['Status.All', 200, 1], ['Status.All', 200, 2], ['Status.All', 200, 3]]);
  const led = zoho.calls.filter((c) => c.path === '/reports/generalledgerdetails' && c.query.rule.columns[0].value.includes('2346113000000054793'));
  assert.equal(led.length, 1);
  assert.deepEqual([[...led[0].query.rule.columns[0].value].sort(), led[0].query.from_date, led[0].query.to_date], [['2346113000000054793', '2346113000026785958'], '2025-04-01', '2026-03-31']);
  assert.deepEqual([snap.register.assets.count, snap.register.assets.byStatus, snap.register.ledger.lines.length], [502, { draft: 19, active: 213, fully_depreciated: 270 }, 9]);
  assert.deepEqual(snap.alerts.filter((a) => /^REGISTER/.test(a.code)), []);
});

test('FA Add: every line, block and total agrees with the register (Land and the Intangible Assets with the ledger of their own account)', { skip }, async () => {
  const r = check(await base(), 'fa-add');
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.summary, { lines: 79, ok: 79, expl: 0, diff: 0, none: 0 });
  assert.deepEqual(r.items, { ok: 70, expl: 0, diff: 0, none: 0 });
  assert.deepEqual(r.groups.map((g) => g.id), ['add', 'intangible']);
  const total = r.checks.find((c) => c.title === 'Total additions');
  assert.deepEqual([total.signed, total.status], [192656309, 'OK']);
  assert.equal(r.marks['29:4'].status, 'OK', 'a computer bought on 9 April 2025');
  assert.match(r.marks['29:4'].tip, /^Zoho: 1-01-006-0166 Lenovo V15 I3 Laptop, bought 09-Apr-2025$/);
  assert.match(r.info.join(' '), /19 draft assets in Zoho \(₹14,87,793\.66\) were bought after 31-Mar-2026/);
  assert.equal(r.panel.of, 'this sheet');
});

test('Dep.Calc.: the cost and the book value of all 483 assets agree to the paisa, and so do the group and sheet totals', { skip }, async () => {
  const r = check(await base(), 'dep-calc');
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.summary, { lines: DEP_LINES, ok: DEP_LINES - DEP_EXPL, expl: DEP_EXPL, diff: 0, none: 0 }, '2432 before update-30 (980 cost and book value + 3 depreciation figures x 483 assets + 3 totals) + the settings of the assets');
  assert.equal(r.checks.length, 17, 'six groups x (cost, book value) + the sheet totals of cost and book value + the three depreciation totals (update-29)');
  assert.equal(r.checks.find((c) => c.id === 'dep-total-cost').signed, 508282125.72);
  assert.equal(r.checks.find((c) => c.id === 'dep-total-wdv').signed, 356639167.81);
  // five codes are used by more than one line of the sheet: said once, in words
  assert.match(r.info.join(' '), /5 asset codes are used by more than one line/);
  assert.match(r.info.join(' '), /equals the 31 March 2026 figure only until the depreciation of the next year is run/);
  // Land is not in the register: its lines carry no mark, and it stays as signed
  const land = readDepCalc(sheet('dep-calc').rows).lines.filter((l) => l.group === 'Land');
  assert.ok(land.length > 0);
  for (const l of land) assert.equal(r.marks[`${l.r}:4`], undefined, 'no mark on a Land line');
});

test('FA Add: a cost that Zoho gives otherwise shows as a difference with Zoho\'s amount, in the line, the block and the total, and nothing else moves', { skip }, async () => {
  const snap = await run({ registerAssets: (l) => l.map((a) => (a.fixed_asset_type_name === 'Computer Equipments' && a.asset_purchase_date === '2025-04-09' && Math.abs(a.asset_cost - 26568) <= 1 ? { ...a, asset_cost: a.asset_cost + 500 } : a)) });
  const r = check(snap, 'fa-add');
  assert.deepEqual(r.summary, { lines: 79, ok: 76, expl: 0, diff: 3, none: 0 });
  assert.deepEqual([r.marks['29:4'].status, r.marks['29:4'].zoho, r.marks['29:4'].diff], ['DIFF', 27068, 500]);
  assert.deepEqual(r.checks.filter((c) => c.status === 'DIFF').map((c) => [c.id, Math.round(c.diff)]), [['add-5', 500], ['add-total-83', 500]]);
});

test('FA Add: a line for which Zoho has no asset says so; an asset bought in the year that the sheet does not have is listed with a signed amount of nothing', { skip }, async () => {
  const gone = await run({ registerAssets: (l) => l.filter((a) => !(a.fixed_asset_type_name === 'Computer Equipments' && a.asset_purchase_date === '2025-04-09' && Math.abs(a.asset_cost - 26568) <= 1)) });
  const r = check(gone, 'fa-add');
  assert.equal(r.marks['29:4'].zoho, null);
  assert.match(r.marks['29:4'].note, /no Computer Equipments bought on 09-Apr-2025/);
  assert.deepEqual(r.summary, { lines: 79, ok: 76, expl: 0, diff: 3, none: 0 });
  const more = await run({ registerAssets: (l) => [...l, { fixed_asset_id: '1', asset_number: 'X-1', asset_name: 'A new laptop', fixed_asset_type_name: 'Computer Equipments', status: 'active', asset_cost: 55000, current_asset_value: 50000, asset_purchase_date: '2025-11-02' }] });
  const e = check(more, 'fa-add');
  const extra = e.checks.find((c) => c.id === 'extra-X-1');
  assert.deepEqual([extra.group, extra.status, extra.signed, extra.zoho], ['extra', 'DIFF', 0, 55000]);
  assert.equal(e.summary.lines, 80);
});

test('Dep.Calc.: a book value that Zoho gives otherwise is a difference on that cell, in its group and in the sheet total; a missing asset is said to be missing; an asset not on the sheet is listed', { skip }, async () => {
  const snap0 = await base();
  const dc = readDepCalc(sheet('dep-calc').rows);
  const line = dc.lines.find((l) => l.group === 'Office Building' && snap0.register.assets.list.filter((a) => a.code === l.code).length === 1);
  const wdv = `${line.r}:${dc.cols.wdv}`;
  const cost = `${line.r}:${dc.cols.cost}`;
  const changed = check(await run({ registerAssets: (l) => l.map((a) => (a.asset_number === line.code ? { ...a, current_asset_value: a.current_asset_value + 250 } : a)) }), 'dep-calc');
  assert.deepEqual([changed.marks[wdv].status, changed.marks[wdv].diff, changed.marks[cost].status], ['DIFF', 250, 'OK']);
  assert.deepEqual(changed.checks.filter((c) => c.status === 'DIFF').map((c) => c.id), ['grp-wdv-Office Building', 'dep-total-wdv']);
  const gone = check(await run({ registerAssets: (l) => l.filter((a) => a.asset_number !== line.code) }), 'dep-calc');
  assert.equal(gone.marks[cost].zoho, null);
  assert.match(gone.marks[cost].note, /has no asset with the code 1-01-002-0001/);
  const crane = { fixed_asset_id: '2', asset_number: 'X-2', asset_name: 'An old crane', fixed_asset_type_name: 'Plant & Machinery', status: 'active', asset_cost: 100000, current_asset_value: 90000, asset_purchase_date: '2019-01-02' };
  const more = check(await run({ registerAssets: (l) => [...l, crane] }), 'dep-calc');
  assert.deepEqual(more.checks.find((c) => c.id === 'extra-X-2').zoho, 100000);
  assert.equal(more.summary.lines, DEP_LINES + 1);
});

test('a register that Zoho refuses leaves the statements and the sheets as they were: a warning, and only "not checked" (the ledger part is still checked)', { skip }, async () => {
  const snap = await run({ registerFail: 'refused' });
  assert.equal(snap.meta.ok, true);
  assert.match(snap.register.assets.error, /not authorized/);
  assert.deepEqual(snap.alerts.filter((a) => a.code === 'REGISTER_UNAVAILABLE').map((a) => a.level), ['warn']);
  const d = check(snap, 'dep-calc');
  assert.deepEqual([d.summary.ok, d.summary.none, Object.keys(d.marks).length], [0, 1, 0]);
  assert.match(d.checks[0].why, /could not be read for this snapshot/);
  const f = check(snap, 'fa-add');
  assert.ok(f.summary.none > 0 && f.summary.diff === 0);
  assert.equal(f.problems.length, 0);
});

test('a ledger that Zoho refuses stops only the Land and Intangible Assets lines; an older snapshot has no register at all, and the page says so', { skip }, async () => {
  const snap = await run({ registerLedgerFail: 'refused' });
  assert.equal(snap.meta.ok, true);
  const f = check(snap, 'fa-add');
  assert.deepEqual(f.checks.filter((c) => c.status === 'NONE').map((c) => c.id), ['add-0', 'add-total-83', 'add-7']);
  assert.equal(f.summary.diff, 0);
  assert.equal(check(snap, 'dep-calc').summary.ok, DEP_LINES - DEP_EXPL, 'Dep.Calc. does not use the ledger');
  const old = { ...(await base()) };
  delete old.register;
  const o = check(old, 'fa-add');
  assert.deepEqual([o.summary.ok, o.summary.none, Object.keys(o.marks).length, o.problems], [0, 9, 0, []]);
  assert.match(o.checks[0].why, /not in this snapshot|older copy/);
  assert.equal(check(old, 'dep-calc').summary.none, 1);
});

test('the workbook counts the two sheets: checked figure by figure, no problem, part live; a year without the configuration says so', { skip }, async () => {
  const snap = await base();
  const books = buildBooks(snap, config, buildView(snap, config.audited));
  const w = buildWorkbook(snap, books, config.workbook, { ...config.books, related: config.related, register: config.register, subsidiaries: config.subsidiaries });
  const fa = w.sheets.find((x) => x.id === 'fa-add');
  const dc = w.sheets.find((x) => x.id === 'dep-calc');
  assert.deepEqual([fa.status, dc.status], ['semi', 'semi']);
  assert.deepEqual([fa.liveCheck.lines, fa.liveCheck.ok, fa.liveCheck.diff, fa.liveCheck.problems], [79, 79, 0, []]);
  assert.deepEqual([dc.liveCheck.lines, dc.liveCheck.ok, dc.liveCheck.diff, dc.liveCheck.problems], [DEP_LINES, DEP_LINES - DEP_EXPL, 0, []]);
  assert.deepEqual(fa.liveCheck.verify, { lines: 79, ok: 79, expl: 0, diff: 0, none: 0 });
  assert.equal(fa.ties.every((t) => t.status === 'OK'), true, 'the older ties of the totals are still there and still agree');
  const bare = buildWorkbook(snap, null, config.workbook, { ...config.books, related: config.related });
  assert.match(bare.sheets.find((x) => x.id === 'fa-add').liveCheck.error, /register.*missing/);
  assert.equal(liveVerify(snap, { register: null, subsidiaries: null }, readSheet(config.workbook, 'fa-add')), null);
  assert.equal(liveVerify(snap, { register: spec }, readSheet(config.workbook, 'cwip')), null, 'a sheet without a verify entry has no such check');
});


// ---------- update-29: the entries of each asset (depreciation, asset by asset) ----------

const entries = (list) => ({ code: 0, message: 'success', asset_history: list, page_context: { page: 1, per_page: 200, has_more_page: false } });
const entry = (type, date, dep, acc) => ({ valuation_id: 'v', description: '', current_quantity: 1, valuation_date: date, depreciated_value: dep, revise_value: 0, current_value: 0, accumulated_value: acc, type, is_journal_posted: type === 'depreciation' });

test('update-29: the entries of an asset are reduced to type, date, depreciated, accumulated - sorted, an acquisition first; an answer of another shape is refused', () => {
  const got = normalizeAssetHistory(entries([entry('depreciation', '2026-03-31', 672100.094, 10133041.09), entry('acquisition', '2014-03-24', 0, 9460941)]));
  assert.deepEqual(got, [['acquisition', '2014-03-24', 0, 9460941], ['depreciation', '2026-03-31', 672100.09, 10133041.09]]);
  assert.deepEqual(normalizeAssetHistory({ data: entries([entry('acquisition', '2026-01-29', 0, 0)]) }), [['acquisition', '2026-01-29', 0, 0]], 'also inside the connector\'s `data`');
  const sameDay = normalizeAssetHistory(entries([entry('depreciation', '2026-03-31', 5, 5), entry('acquisition', '2026-03-31', 0, 0)]));
  assert.deepEqual(sameDay.map((e) => e[0]), ['acquisition', 'depreciation']);
  assert.throws(() => normalizeAssetHistory({ code: 0 }), /unexpected shape/);
  assert.throws(() => normalizeAssetHistory({ ...entries([entry('acquisition', '', 0, 0)]) }), /no date/);
  assert.throws(() => normalizeAssetHistory({ ...entries([entry('acquisition', '2020-01-01', 0, 0)]), page_context: { has_more_page: true } }), /more than one page/);
});

test('update-29: what the entries say - the depreciation before the year, in the year, and at its end; an asset bought in the year had nothing before', () => {
  const a = [['acquisition', '2014-03-24', 0, 9460941], ['depreciation', '2026-03-31', 672100.09, 10133041.09]];
  assert.deepEqual(assetFigures(a, '2025-04-01', '2026-03-31'), { open: 9460941, dep: 672100.09, close: 10133041.09 });
  const bought = [['acquisition', '2025-10-01', 0, 0], ['depreciation', '2026-03-31', 4853.98, 4853.98]];
  assert.deepEqual(assetFigures(bought, '2025-04-01', '2026-03-31'), { open: 0, dep: 4853.98, close: 4853.98 });
  const full = [['acquisition', '2014-01-27', 0, 20596]];
  assert.deepEqual(assetFigures(full, '2025-04-01', '2026-03-31'), { open: 20596, dep: 0, close: 20596 }, 'no depreciation entry: nothing in the year');
  const twoYears = [['acquisition', '2014-03-24', 0, 100], ['depreciation', '2025-03-31', 30, 130], ['depreciation', '2026-03-31', 20, 150], ['depreciation', '2027-03-31', 10, 160]];
  assert.deepEqual(assetFigures(twoYears, '2025-04-01', '2026-03-31'), { open: 130, dep: 20, close: 150 }, 'an entry of the year before or after is not counted');
});

const memoryCache = (init = {}) => {
  const box = { map: init, puts: 0 };
  return { box, getAssetHistory: async () => (Object.keys(box.map).length ? structuredClone(box.map) : null), putAssetHistory: async (m) => { box.map = structuredClone(m); box.puts += 1; } };
};
const idsOf = (n) => Array.from({ length: n }, (_, i) => String(1000 + i));
const histZoho = (log, fail = {}) => ({ get: async (p, q) => {
  log.push([p, q]);
  const id = p.split('/')[2];
  if (fail[id]) throw Object.assign(new Error(`failed ${id}`), { status: fail[id] });
  if (!p.endsWith('/history')) return { code: 0, message: 'success', fixed_asset: { fixed_asset_id: id, depreciation_percentage: 45.07, salvage_value: 5 } }; // update-30: the settings of the asset
  return entries([entry('acquisition', '2020-01-01', 0, 10), entry('depreciation', '2026-03-31', 5, 15)]);
} });

test('update-29/30: the histories (and the settings) are read per asset, at most `budget` new ones per run, kept in ONE key, and a later run reads only the rest', async () => {
  const cache = memoryCache();
  const log = [];
  const ids = idsOf(250);
  const one = await fetchAssetHistories(histZoho(log), ids, { cache, budget: 100 });
  assert.deepEqual([one.fetched, one.fromCache, one.pending.length, Object.keys(one.byId).length], [100, 0, 150, 100]);
  assert.deepEqual([one.detPending.length, Object.keys(one.det).length, log.length], [150, 100, 200], 'update-30: two calls per asset - its entries and its settings');
  assert.deepEqual(log[0], ['/fixedassets/1000/history', { per_page: 200 }]);
  assert.ok(log.some(([p]) => p === '/fixedassets/1000'), 'the settings of the asset: /fixedassets/{id}');
  assert.deepEqual(one.det['1000'], { rate: 45.07, res: 5 });
  assert.equal(cache.box.puts, 4, 'saved after every 25 assets, so a run cut short loses little');
  const two = await fetchAssetHistories(histZoho(log), ids, { cache, budget: 100 });
  assert.deepEqual([two.fetched, two.fromCache, two.pending.length], [100, 100, 50]);
  const three = await fetchAssetHistories(histZoho(log), ids, { cache, budget: 100 });
  assert.deepEqual([three.fetched, three.fromCache, three.pending.length], [50, 200, 0]);
  const calls = log.length;
  const four = await fetchAssetHistories(histZoho(log), ids, { cache, budget: 100 });
  assert.deepEqual([four.fetched, four.fromCache, four.pending.length, log.length], [0, 250, 0, calls], 'everything is in Redis: no call');
  assert.deepEqual(four.byId['1000'], [['acquisition', '2020-01-01', 0, 10], ['depreciation', '2026-03-31', 5, 15]]);
});

test('update-29: without Redis everything is read at once; a copy of an older shape or older than 30 days is read again; Zoho refusing stops the run but keeps what it has; one asset that fails is left for the next run', async () => {
  const log = [];
  const all = await fetchAssetHistories(histZoho(log), idsOf(60));
  assert.deepEqual([all.fetched, all.pending.length, log.length], [60, 0, 120], 'two calls per asset (update-30: the entries and the settings)');
  const now = () => Date.parse('2026-10-21T10:00:00Z');
  const det0 = { rate: 45.07, res: 1 };
  const stale = { '1000': { v: ASSET_HISTORY_VERSION, at: now() - 31 * 24 * 3600e3, ent: [['acquisition', '2020-01-01', 0, 1]], det: det0 }, '1001': { v: ASSET_HISTORY_VERSION - 1, at: now(), ent: [['acquisition', '2020-01-01', 0, 2]], det: det0 }, '1002': { v: ASSET_HISTORY_VERSION, at: now() - 3600e3, ent: [['acquisition', '2020-01-01', 0, 3]], det: det0 } };
  const log2 = [];
  const again = await fetchAssetHistories(histZoho(log2), idsOf(3), { cache: memoryCache(stale), now });
  assert.deepEqual(log2.filter(([p]) => p.endsWith('/history')).map(([p]) => p).sort(), ['/fixedassets/1000/history', '/fixedassets/1001/history'], 'the old one and the one of an older shape; the fresh one comes from Redis');
  assert.equal(again.fromCache, 1);
  // update-30: an entry kept by update-29 (the entries, no settings) is completed with the one call for the settings; its entries are not read again
  const log2b = [];
  const keptOld = { '1000': { v: ASSET_HISTORY_VERSION, at: now() - 3600e3, ent: [['acquisition', '2020-01-01', 0, 1]] } };
  const cache2b = memoryCache(keptOld);
  const topped = await fetchAssetHistories(histZoho(log2b), idsOf(1), { cache: cache2b, now });
  assert.deepEqual(log2b.map(([p]) => p), ['/fixedassets/1000'], 'only the settings');
  assert.deepEqual([topped.fetched, topped.detPending, topped.pending], [1, [], []]);
  assert.deepEqual(topped.byId['1000'], [['acquisition', '2020-01-01', 0, 1]], 'the entries kept are the ones used');
  assert.equal(cache2b.box.map['1000'].at, keptOld['1000'].at, 'and keep their age');
  assert.deepEqual(cache2b.box.map['1000'].det, { rate: 45.07, res: 5 });
  const log3 = [];
  const cache = memoryCache();
  const limited = await fetchAssetHistories(histZoho(log3, { 1030: 429 }), idsOf(60), { cache, concurrency: 1, chunk: 10 });
  assert.match(limited.stopped, /failed 1030/);
  assert.equal(limited.fetched, 30);
  assert.equal(limited.pending.length, 30);
  assert.equal(Object.keys(cache.box.map).length, 30, 'what was read before the refusal is kept');
  const bad = await fetchAssetHistories(histZoho([], { 1005: 404 }), idsOf(10));
  assert.deepEqual([bad.failed, bad.pending, bad.fetched, bad.stopped], [['1005'], ['1005'], 9, null]);
});

const realHistory = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../fixtures/asset_history_real_fy26.json', import.meta.url)), 'utf8')).assets;

test('update-29: Dep.Calc. - the depreciation of 14 real assets, as Zoho gave them (with its paise), agrees with the sheet; so does the sheet total', { skip }, async () => {
  const snap = await run({ historyEdit: (id, ent) => realHistory[id] ?? ent });
  const r = check(snap, 'dep-calc');
  assert.deepEqual(r.summary, { lines: DEP_LINES, ok: DEP_LINES - DEP_EXPL, expl: DEP_EXPL, diff: 0, none: 0 });
  const dc = readDepCalc(sheet('dep-calc').rows);
  let seen = 0;
  for (const id of Object.keys(realHistory)) {
    const a = snap.register.assets.list.find((x) => x.id === id);
    const tipped = Object.values(r.marks).filter((m) => m.tip?.startsWith(`Zoho: the entries of ${a.code} `) && /^dep-(acc-open|year|acc-close)$/.test(m.check));
    assert.equal(tipped.length, 3, `${a.code}: opening, year, closing`);
    for (const m of tipped) { assert.equal(m.status, 'OK', `${a.code} ${m.check}`); assert.ok(Math.abs(m.diff) <= 1, `${a.code} ${m.check} ${m.diff}`); seen += 1; }
  }
  assert.equal(seen, 42);
  for (const id of ['dep-total-open', 'dep-total-year', 'dep-total-close']) assert.equal(r.checks.find((c) => c.id === id).status, 'OK', id);
  assert.equal(r.checks.find((c) => c.id === 'dep-total-year').signed, 25872864, 'the depreciation of the year, as in the profit and loss account');
  const temple = dc.lines.find((l) => l.name === 'Temple Structure');
  assert.deepEqual([r.marks[`${temple.r}:${dc.cols.dep}`].signed, r.marks[`${temple.r}:${dc.cols.dep}`].zoho], [4854, 4853.98], 'the sheet rounds to the rupee, Zoho keeps paise');
  assert.match(r.info.join(' '), /the entries of 483 of 483 assets are read from Zoho/);
  assert.match(r.stays.join(' '), /C\.Y\.Depreciation/);
  assert.equal(snap.register.history.complete, true);
});

test('update-29: Dep.Calc. - a depreciation that Zoho gives otherwise is a difference on that asset (the year and the closing balance), and in the totals; nothing else moves', { skip }, async () => {
  const templeId = '2346113000034372835';
  const snap = await run({ historyEdit: (id, ent) => (id === templeId ? [['acquisition', '2025-10-01', 0, 0], ['depreciation', '2026-03-31', 5854, 5854]] : ent) });
  const r = check(snap, 'dep-calc');
  const dc = readDepCalc(sheet('dep-calc').rows);
  const temple = dc.lines.find((l) => l.name === 'Temple Structure');
  const m = (c) => r.marks[`${temple.r}:${c}`];
  assert.deepEqual([m(dc.cols.acc0).status, m(dc.cols.dep).status, m(dc.cols.acc1).status], ['OK', 'DIFF', 'DIFF']);
  assert.deepEqual([m(dc.cols.dep).zoho, m(dc.cols.dep).diff], [5854, 1000]);
  assert.deepEqual(r.checks.filter((c) => c.status === 'DIFF').map((c) => c.id), ['dep-total-year', 'dep-total-close']);
  assert.deepEqual(r.summary, { lines: DEP_LINES, ok: DEP_LINES - DEP_EXPL - 4, expl: DEP_EXPL, diff: 4, none: 0 }, 'two cells and two totals');
});

test('update-29: Dep.Calc. - entries that are only part read: the assets read are checked, the totals wait for the rest and say so; an asset with no entries yet gets no mark', { skip }, async () => {
  const snap = structuredClone(await base());
  const h = snap.register.history;
  const drop = Object.keys(h.byId).slice(0, 10);
  for (const id of drop) delete h.byId[id];
  Object.assign(h, { known: 473, complete: false, pending: 10, fetched: 100, fromCache: 373 });
  const r = check(snap, 'dep-calc');
  assert.equal(r.summary.diff, 0);
  assert.equal(r.summary.none, 3, 'the three totals wait');
  assert.match(r.checks.find((c) => c.id === 'dep-total-year').why, /entries of 10 of the 483 assets are not read from Zoho yet \(473 are\)/);
  assert.match(r.info.join(' '), /473 of 483 assets are read.*10 still to be read/);
  assert.equal(r.summary.lines, 980 + 3 * 473 + 3 + 1668, 'the settings of all 483 assets (useful life, days, residual value, rate) are checked: they do not need the entries');
  assert.equal(registerOpen(snap), true);
  assert.equal(moreToRead(snap), true);
  assert.deepEqual(decideRefresh({ got: { snapshot: { ...snap, meta: { generatedAt: new Date(NOW - 5000).toISOString(), ok: true } }, stale: false, flawed: false }, nowMs: NOW, manual: true }), { run: true, continuing: true });
  assert.equal(registerOpen({ ...snap, register: { ...snap.register, history: { ...h, stalled: true } } }), false, 'a run that could read no more does not start another for ever');
  assert.equal(registerOpen({ ...snap, register: { ...snap.register, history: { error: 'x' } } }), false);
  assert.equal(registerOpen({ meta: {} }), false, 'an older snapshot');
});

test('update-29: Dep.Calc. - Zoho refusing the entries stops only the depreciation columns: cost and book value are checked as before, a notice says why, no run repeats for ever', { skip }, async () => {
  const snap = await run({ historyFail: 'refused' });
  assert.equal(snap.meta.ok, true);
  assert.deepEqual([snap.register.history.complete, snap.register.history.stalled, snap.register.history.known], [false, true, 0]);
  assert.deepEqual(snap.alerts.filter((a) => /^REGISTER_HISTORY/.test(a.code)).map((a) => [a.level, a.code]), [['info', 'REGISTER_HISTORY_STALLED']]);
  assert.equal(registerOpen(snap), false);
  const r = check(snap, 'dep-calc');
  assert.deepEqual([r.summary.ok, r.summary.diff, r.summary.none], [980 + 2 * 483, 0, 3], 'update-30: the useful life and the days come from the asset list, so they are checked without the entries; the rate and the residual value need the asset itself, which was refused too');
  assert.equal(r.problems.length, 0);
  // the layer itself cannot be built from what Zoho sent: an alert of its own and a plain reason
  const alerts = [];
  const bad = buildRegisterSection({ spec, assets: null, ledger: null, history: { error: new Error('boom') }, from: '2025-04-01', to: '2026-03-31', alerts });
  assert.equal(bad.history.error, 'boom');
  assert.match(alerts[0].message, /depreciation columns of Dep\.Calc\. are not checked asset by asset/);
  const old = { ...(await base()) };
  old.register = { ...old.register, history: undefined };
  const o = check(old, 'dep-calc');
  assert.match(o.stays.join(' '), /entries of the assets are not in this snapshot/);
  assert.equal(o.summary.ok, 980 + 2 * 483);
});

test('update-29: a history with other kinds of entry is still read: they count in the closing depreciation, not in the year, and the page says so', { skip }, async () => {
  const id = '2346113000034372835';
  const snap = await run({ historyEdit: (i, ent) => (i === id ? [...ent, ['write_off', '2026-03-31', 0, 4853.98]] : ent) });
  const r = check(snap, 'dep-calc');
  assert.equal(r.summary.diff, 0);
  assert.match(r.info.join(' '), /Other kinds of entry were found \(write_off\)/);
});

// ---------- update-30: the useful life, the days, the rate and the residual value of each asset ----------

test('update-30: the list gives the useful life (months) and the day depreciation began; the days of the year are counted to the last day inclusive', () => {
  const list = normalizeRegister([page([{ ...asset(), total_life: 60, depreciation_start_date: '2025-04-01' }, { ...asset({ id: '2', code: 'A-2' }), total_life: '', depreciation_start_date: undefined }])]);
  assert.deepEqual(list.map((a) => [a.life, a.start]), [[60, '2025-04-01'], [null, '']]);
  assert.equal(daysInYear('2011-04-21', '2025-04-01', '2026-03-31'), 365, 'bought long before the year: the whole year');
  assert.equal(daysInYear('2025-04-01', '2025-04-01', '2026-03-31'), 365);
  assert.equal(daysInYear('2025-12-15', '2025-04-01', '2026-03-31'), 107, 'the MCR bought on 15-Dec-2025: 17 + 31 + 28 + 31 days, both ends counted');
  assert.equal(daysInYear('2026-03-31', '2025-04-01', '2026-03-31'), 1);
  assert.equal(daysInYear('2026-04-01', '2025-04-01', '2026-03-31'), 0);
  assert.equal(daysInYear('', '2025-04-01', '2026-03-31'), undefined);
});

test('update-30: the settings of an asset (rate in percent, salvage value) are read from /fixedassets/{id}; an answer that is no asset is refused', () => {
  assert.deepEqual(normalizeAssetDetail({ code: 0, fixed_asset: { depreciation_percentage: 45.07, salvage_value: 5188 } }), { rate: 45.07, res: 5188 });
  assert.deepEqual(normalizeAssetDetail({ data: { fixed_asset: { depreciation_percentage: '4.87', salvage_value: '' } } }), { rate: 4.87, res: null }, 'also wrapped by the connector; a blank value is nothing');
  assert.throws(() => normalizeAssetDetail({ code: 0, message: 'success' }), /no fixed_asset/);
  assert.throws(() => normalizeAssetDetail(null), /no fixed_asset/);
});

test('update-30: Dep.Calc. - useful life, days and residual value agree for all 483 assets; the rate for the 95 whose rate Zoho keeps, and the 124 the sheet works out again are explained', { skip }, async () => {
  const r = check(await base(), 'dep-calc');
  const by = {};
  for (const m of Object.values(r.marks)) by[`${m.check}:${m.status}`] = (by[`${m.check}:${m.status}`] ?? 0) + 1;
  assert.equal(by['dep-life:OK'], 483);
  assert.equal(by['dep-days:OK'], 483);
  assert.equal(by['dep-res:OK'], 483);
  assert.deepEqual([by['dep-rate:OK'], by['dep-rate:EXPL'], by['dep-rate:DIFF']], [95, 124, undefined], 'the other 264 assets are fully depreciated: no rate on the sheet, nothing to compare');
  const dc = readDepCalc(sheet('dep-calc').rows);
  const rated = dc.lines.filter((l) => l.rate > 0 && l.group !== 'Land');
  assert.equal(rated.length, 219);
  const ex = Object.entries(r.marks).find(([, m]) => m.status === 'EXPL');
  assert.match(ex[1].note, /^The sheet works the rate out again each year: 1 − \(residual .* ÷ net block .*\) \^ \(1 ÷ balance life .*\) = 0\.\d{4}\. Zoho keeps the \d+(\.\d+)?% set when the asset was entered/);
  assert.equal(ex[1].dp, 4, 'a rate keeps its four decimals on the page');
  assert.equal(dc.lines.filter((l) => !(l.rate > 0) && r.marks[`${l.r}:${dc.cols.rate}`]).length, 0, 'a fully depreciated asset has no mark on its (empty) rate');
  assert.match(r.info.join(' '), /Rate: 95 assets have the same rate on the sheet as in Zoho; 124 show another rate because the sheet works the rate out again every year/);
  assert.match(r.info.join(' '), /264 fully depreciated assets have no rate on the sheet/);
  assert.match(r.stays.join(' '), /Balance Life/);
});

test('update-30: Dep.Calc. - five real answers of Zoho (21-Oct-2026): the residual value is the salvage value; the rate is Zoho\'s where the asset is new, and the reworked rate is explained for the AC and the office', { skip }, async () => {
  const real = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../fixtures/asset_detail_real_fy26.json', import.meta.url)), 'utf8')).assets;
  const snap = await run({ detailEdit: (id, fa) => (real[id] ? { ...fa, ...real[id] } : fa) });
  const r = check(snap, 'dep-calc');
  const dc = readDepCalc(sheet('dep-calc').rows);
  const at = (code, col) => { const l = dc.lines.find((x) => x.code === code); return r.marks[`${l.r}:${dc.cols[col]}`]; };
  for (const [code, rate, status] of [['01-01-008-0120', 45.07, 'EXPL'], ['1-01-002-0003', 4.87, 'OK'], ['1-01-006-0166', 63.16, 'OK'], ['1-01-002-0001', 4.87, 'EXPL']]) {
    const m = at(code, 'rate');
    assert.equal(m.status, status, `${code}: sheet ${m.signed}, Zoho ${rate}%`);
    assert.equal(m.zoho, Math.round(rate * 100) / 10000);
  }
  assert.equal(at('01-01-008-0120', 'rate').signed, 0.4566);
  assert.equal(at('1-01-002-0001', 'rate').signed, 0.0493);
  assert.equal(at('01-01-008-0001', 'rate'), undefined, 'the fully depreciated mobile phone: the sheet shows no rate');
  for (const [code, res] of [['01-01-008-0001', 1185], ['01-01-008-0120', 5188], ['1-01-002-0003', 142196], ['1-01-006-0166', 1328], ['1-01-002-0001', 1163088]]) assert.deepEqual([at(code, 'res').status, at(code, 'res').zoho], ['OK', res], code);
  assert.deepEqual([at('1-01-002-0003', 'days').status, at('1-01-002-0003', 'days').zoho, at('1-01-006-0166', 'days').zoho], ['OK', 107, 357]);
  assert.equal(r.summary.diff, 0);
});

test('update-30: Dep.Calc. - a life, a residual value or a rate that Zoho gives otherwise is a difference on that cell and nowhere else', { skip }, async () => {
  const snap = await run({ detailEdit: (id, fa) => {
    if (fa.asset_number === '01-01-008-0120') return { ...fa, salvage_value: fa.salvage_value + 100 };       // another residual value
    if (fa.asset_number === '1-01-006-0166') return { ...fa, depreciation_percentage: 50 };                   // another rate (not the one worked at entry, not the sheet's)
    if (fa.asset_number === '1-01-002-0001') return { ...fa, depreciation_percentage: 5 };                    // the sheet reworks it, but Zoho's percentage is not the one worked at entry either
    return fa;
  }, registerAssets: (l) => l.map((a) => (a.asset_number === '1-01-002-0003' ? { ...a, total_life: 600 } : a)) });
  const r = check(snap, 'dep-calc');
  const dc = readDepCalc(sheet('dep-calc').rows);
  const at = (code, col) => { const l = dc.lines.find((x) => x.code === code); return r.marks[`${l.r}:${dc.cols[col]}`]; };
  assert.deepEqual([at('01-01-008-0120', 'res').status, at('01-01-008-0120', 'res').diff], ['DIFF', 100]);
  assert.equal(at('1-01-006-0166', 'rate').status, 'DIFF');
  assert.equal(at('1-01-002-0001', 'rate').status, 'DIFF', 'a difference is explained only when Zoho\'s percentage is the one worked out at entry');
  assert.deepEqual([at('1-01-002-0003', 'life').status, at('1-01-002-0003', 'life').signed, at('1-01-002-0003', 'life').zoho], ['DIFF', 60, 50]);
  assert.equal(at('01-01-008-0120', 'rate').status, 'DIFF', 'and with another residual value in Zoho the rate worked out at entry is another one too');
  assert.equal(r.summary.diff, 5, 'the AC (residual value and rate), the laptop and the office (rate), the MCR (life)');
  assert.match(r.info.join(' '), /3 differ without that rule explaining it/);
});

test('update-30: Dep.Calc. - the settings only part read: the assets read are checked, a notice says how many follow, the run goes on by itself', { skip }, async () => {
  const snap = JSON.parse(JSON.stringify(await base()));
  const h = snap.register.history;
  for (const id of Object.keys(h.det).slice(0, 10)) delete h.det[id];
  Object.assign(h, { complete: false, detKnown: 473, detPending: 10 });
  const r = check(snap, 'dep-calc');
  assert.equal(r.summary.diff, 0);
  assert.match(r.info.join(' '), /The settings of 10 assets are not read from Zoho yet/);
  assert.equal(registerOpen(snap), true, 'a refresh that left some settings unread is continued');
  assert.equal(registerOpen({ ...snap, register: { ...snap.register, history: { ...h, stalled: true } } }), false);
  // a whole run: the settings of a few assets fail, the rest is read; the alert names the settings
  const part = await run({ detailBroken: ['2346113000034375443'] });
  assert.equal(part.register.history.detPending, 1);
  assert.equal(part.register.history.complete, false);
  assert.equal(part.alerts.find((a) => /^REGISTER_SETTINGS/.test(a.code)).level, 'info');
  assert.match(part.alerts.find((a) => /^REGISTER_SETTINGS/.test(a.code)).message, /rate and the residual value of 482 of 483 assets/);
  // an older snapshot (update-29: entries, no settings) says so and keeps Rate and Residual Value as signed
  const old = JSON.parse(JSON.stringify(await base()));
  delete old.register.history.det;
  const o = check(old, 'dep-calc');
  assert.match(o.info.join(' '), /Rate and Residual Value of each asset are read from the detail of the asset in Zoho/);
  assert.equal(Object.values(o.marks).filter((m) => m.check === 'dep-rate' || m.check === 'dep-res').length, 0);
  assert.equal(Object.values(o.marks).filter((m) => m.check === 'dep-life').length, 483, 'but the useful life and the days need no extra call');
});
