// update-31: last year (31 March 2025) read from Zoho Books beside the signed figures (lib/prior.mjs, config/prior.fy25.json).
// The configuration and the rules need no files; the real Trial Balance of 31-Mar-2025 (fixtures/tb_fy25_nonzero.raw.json, what Zoho gave on 21-Oct-2026) is skipped without fixtures/.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../lib/config.mjs';
import { buildSnapshot } from '../lib/snapshot.mjs';
import { buildPriorSection, buildPriorView, checkPriorSpec, PARTY_KEYS } from '../lib/prior.mjs';
import { priorYear } from '../lib/server.mjs';
import { computeFS } from '../lib/fsEngine.mjs';
import { normalizeTB } from '../lib/tb.mjs';
import { replayZoho, haveFixtures, J } from '../testing/fakes.mjs';

const skip = !haveFixtures();
const config = loadConfig('2025-26');
const spec = config.prior;
const NOW = Date.parse('2026-10-15T06:30:00+05:30');
const clone = (x) => JSON.parse(JSON.stringify(x));
const run = (over = {}) => {
  const alerts = [];
  const section = buildPriorSection({ spec: over.spec ?? spec, raw: over.raw ?? J('fixtures/tb_fy25_nonzero.raw.json'), mapping: config.mapping, alerts });
  return { section, alerts };
};
const viewOf = (section, over = {}) => buildPriorView({ section, audited: 'audited' in over ? over.audited : config.audited, notes: 'notes' in over ? over.notes : config.books.notes, spec: over.spec ?? spec });
const byId = (view) => Object.fromEntries([...view.bs.liabilities, ...view.bs.assets, ...view.bs.party, ...view.pl].filter((r) => r.status).map((r) => [r.id, r]));

// ---------- the configuration itself ----------

test('config/prior.fy25.json: the year, the inputs and one rule per old account, once', () => {
  assert.ok(spec, 'the year before FY26 has its configuration (loadConfig names it after the year before)');
  assert.deepEqual([spec.fy, spec.from, spec.to], ['2024-25', '2024-04-01', '2025-03-31']);
  assert.deepEqual(checkPriorSpec(spec), []);
  const ids = spec.rules.map((r) => r.match.accountId);
  assert.equal(ids.length, 472);
  assert.equal(new Set(ids).size, ids.length, 'no account is claimed twice');
  const known = new Set(Object.keys(config.mapping.buckets));
  for (const r of spec.rules) assert.ok(known.has(r.bucket), `${r.name}: bucket ${r.bucket} exists`);
  // the accounts the main mapping claims by id are not repeated here (two buckets at one specificity would raise an alert)
  const main = new Set(config.mapping.rules.map((r) => r.match?.accountId).filter(Boolean));
  assert.deepEqual(ids.filter((i) => main.has(i)), []);
  for (const [k, v] of Object.entries(spec.inputs)) assert.ok(typeof v.value === 'number' && v.ref && v.meaning, `input ${k} has a value, a reference and a meaning`);
  assert.equal(spec.inputs.opening_stock.value, 29877665);
  // the party-level lines read their signed figure from rows of the notes
  for (const key of Object.keys(spec.audited_from_notes)) assert.ok(PARTY_KEYS.includes(key) || key.startsWith('ocl_') || key.startsWith('sla_'), key);
});

test('checkPriorSpec says what is wrong with a configuration', () => {
  assert.deepEqual(checkPriorSpec(null), ['there is no prior-year configuration']);
  const bad = clone(spec);
  bad.rules = [];
  delete bad.inputs.fd_noncurrent;
  bad.to = 'March 2025';
  const why = checkPriorSpec(bad).join(' | ');
  assert.match(why, /`from` and `to` must be dates/);
  assert.match(why, /no account rules/);
  assert.match(why, /"fd_noncurrent" is missing/);
});

test('a year without a prior configuration has no last-year panel', () => {
  assert.equal(buildPriorView({ section: null, audited: config.audited, notes: config.books.notes, spec: null }), null);
  assert.equal(priorYear({}, { audited: null, books: {}, prior: null }), null);
  const waiting = buildPriorView({ section: null, audited: config.audited, notes: config.books.notes, spec });
  assert.match(waiting.error, /not been read in this snapshot yet/, 'a snapshot made before update-31 says so, it does not fail');
});

// ---------- the real Trial Balance of 31-Mar-2025 ----------

test('Zoho\'s Trial Balance of 31-Mar-2025 rebuilds the signed statements: 45 lines agree within a few rupees and 5 differ by the explained reclassification', { skip }, () => {
  const { section, alerts } = run();
  assert.deepEqual(alerts, [], 'every one of the accounts is claimed, the Trial Balance balances');
  assert.equal(section.accounts, 513);
  assert.deepEqual([section.asOf, section.basis], ['2025-03-31', 'Accrual']);
  assert.ok(section.checks.every((c) => c.ok), JSON.stringify(section.checks));
  assert.equal(Object.keys(section.lines).length, 45);
  const v = viewOf(section);
  assert.deepEqual(v.summary, { ok: 45, expl: 5, diff: 0, none: 0, total: 50 });
  const r = byId(v);
  // the explained ones, by amount
  assert.deepEqual(Object.values(r).filter((x) => x.status === 'EXPL').map((x) => [x.id, Math.round(x.diff)]), [['revenue', 363999], ['total_income', 363999], ['purchases', -34517], ['other_expenses', 398517], ['total_expenses', 364002]]);
  assert.deepEqual(v.explained.map((e) => e.label), ['Revenue from operations', 'Total income', 'Purchase of stock-in-trade', 'Other expenses', 'Total expenses']);
  for (const e of v.explained) assert.ok(e.text.length > 20 && !/\bchange\b.*\bZoho\b/i.test(e.text), 'it explains, it never asks for a change in Zoho');
  // profit agrees although the lines above differ
  assert.ok(Math.abs(r.pbt.diff) <= 5 && r.pbt.status === 'OK');
  assert.ok(Math.abs(r.pat.diff) <= 5 && r.pat.status === 'OK');
  assert.equal(Math.round(r.pat.zoho), 258816465);
  assert.equal(Math.round(r.pat.signed), 258816467);
  // headline balance sheet lines
  assert.equal(Math.round(r.share_capital.zoho), 50965000);
  assert.equal(Math.round(r.trade_receivables.zoho), 409808138);
  assert.equal(Math.round(r.ppe.zoho), 189855719);
  // the party-level group is compared as one net figure; its parts are not in the table
  assert.equal(Math.round(r.party_net.zoho), -5697086);
  assert.equal(Math.round(r.party_net.signed), -5697083);
  for (const k of PARTY_KEYS) assert.equal(r[k], undefined, `${k} is not shown on its own`);
  assert.equal(r.trade_payables, undefined, 'a group made only of party lines is left out');
});

test('the totals leave the party-level group out on both sides, so the two sides differ by exactly its net', { skip }, () => {
  const r = byId(viewOf(run().section));
  assert.equal(Math.round(r.total_assets.signed), 945672787, 'the signed total assets, less the advances to suppliers and others');
  assert.equal(Math.round(r.total_equity_liabilities.signed), 939975704, 'the signed total equity and liabilities, less payables, retention money and outstanding expenses');
  assert.equal(Math.round(r.total_assets.zoho), 945672785);
  assert.equal(Math.round(r.total_equity_liabilities.zoho), 939975699);
  // assets before the group less liabilities before the group is the group's net (a net payable of 56.97 lakh is a negative net advance)
  assert.ok(Math.abs((r.total_assets.zoho - r.total_equity_liabilities.zoho) + r.party_net.zoho) <= 5);
  for (const id of ['total_assets', 'total_equity_liabilities', 'noncurrent_liabilities_total', 'current_liabilities_total', 'current_assets_total', 'noncurrent_assets_total', 'equity_total']) assert.equal(r[id].status, 'OK', id);
});

test('without the opening stock of the year the change in inventories is wrong - that is why it is an input', { skip }, () => {
  const without = clone(spec);
  delete without.inputs.opening_stock;
  const { section } = run({ spec: without });
  const v = viewOf(section, { spec: without });
  const r = byId(v);
  assert.equal(r.inventory_change.status, 'DIFF', 'the stock accounts opened with nothing on 1-Apr-2024');
  assert.ok(Math.abs(r.inventory_change.diff) > 1_000_000);
  assert.equal(r.purchases.status, 'DIFF', 'and the purchases (they follow from it) are off by the same amount');
});

test('the engine takes the opening stock from the Trial Balance unless the year gives it as an input (this year does not)', { skip }, () => {
  const tb = normalizeTB(J('fixtures/tb_fy26_nonzero.raw.json'));
  const inputs = J('config/inputs.fy26.json');
  assert.equal(inputs.inputs.opening_stock, undefined);
  const aging = { meta: { asOf: '2026-03-31' }, contacts: [], total: 0 };
  const a = computeFS({ tb, mapping: config.mapping, inputs, aging, overrides: null });
  const b = computeFS({ tb, mapping: config.mapping, inputs: { ...inputs, inputs: { ...inputs.inputs, opening_stock: { value: 1 } } }, aging, overrides: null });
  assert.equal(a.memo.openingStock, a.buckets.inventory.opening);
  assert.equal(b.memo.openingStock, 1);
  assert.ok(Math.abs((b.lines.inventory_change.value - a.lines.inventory_change.value) - (1 - a.buckets.inventory.opening)) < 0.01);
});

// ---------- the figures read from the notes and the explained differences ----------

test('a difference that nothing explains is a difference: an amount other than the explained one, or a changed signed figure', { skip }, () => {
  const { section } = run();
  // the explained amount no longer fits
  const moved = clone(spec);
  moved.explain.find((e) => e.key === 'revenue').diff = 100000;
  const r1 = byId(viewOf(section, { spec: moved }));
  assert.equal(r1.revenue.status, 'DIFF');
  assert.equal(r1.total_income.status, 'EXPL', 'the other explained lines are not touched');
  // the signed figure changes by 500 rupees
  const audited = clone(config.audited);
  audited.bs.ppe.fy25 += 500;
  const r2 = byId(viewOf(section, { audited }));
  assert.equal(r2.ppe.status, 'DIFF');
  assert.equal(Math.round(r2.ppe.diff), -500);
  // and a few rupees of rounding are not a difference
  audited.bs.ppe.fy25 = config.audited.bs.ppe.fy25 + 4;
  assert.equal(byId(viewOf(section, { audited })).ppe.status, 'OK');
});

test('without the signed comparatives nothing is compared, and the figures still show', { skip }, () => {
  const { section } = run();
  const v = viewOf(section, { audited: null, notes: null });
  assert.equal(v.hasSigned, false);
  assert.deepEqual([v.summary.ok, v.summary.expl, v.summary.diff], [0, 0, 0]);
  assert.equal(v.summary.none, v.summary.total);
  const r = byId(v);
  assert.equal(r.ppe.signed, null);
  assert.equal(Math.round(r.ppe.zoho), 189855719);
});

// ---------- what can go wrong with the Trial Balance of last year ----------

test('an account nobody claims is reported as a warning, never as an error that stops the statements', { skip }, () => {
  const raw = J('fixtures/tb_fy25_nonzero.raw.json');
  const body = raw.data ?? raw;
  const grp = body.trialbalance[0].account_transactions.find((g) => g.name === 'Expense');
  grp.account_transactions.push({ account_id: '9990000000000001', name: 'Made-up expense', account_code: '', debit_total: 1000, credit_total: 0, closing_balance: 1000 });
  const { section, alerts } = run({ raw });
  assert.ok(alerts.length >= 1);
  assert.ok(alerts.every((a) => a.level !== 'error'), JSON.stringify(alerts));
  assert.ok(alerts.some((a) => a.code === 'PRIOR_UNMAPPED_ACCOUNT' && /Last year's Trial Balance/.test(a.message)));
  assert.equal(section.checks.find((c) => c.key === 'all_mapped').ok, false);
});

test('a Trial Balance up to another date, an unreadable one and a broken configuration are each said plainly, as a warning', { skip }, () => {
  const raw = J('fixtures/tb_fy25_nonzero.raw.json');
  (raw.data ?? raw).page_context.to_date = '2025-03-30';
  let r = run({ raw });
  assert.match(r.section.error, /up to 2025-03-30, not 2025-03-31/);
  assert.equal(r.alerts[0].level, 'warn');
  assert.equal(r.alerts[0].code, 'PRIOR_UNAVAILABLE');

  const alerts = [];
  const s = buildPriorSection({ spec, raw: { error: new Error('Zoho /reports/trialbalance failed: You are not authorized (HTTP 401)') }, mapping: config.mapping, alerts });
  assert.match(s.error, /not authorized/);
  assert.match(alerts[0].message, /could not be read from Zoho.*signed figures are unchanged/);

  const alerts2 = [];
  const s2 = buildPriorSection({ spec: { ...spec, rules: [] }, raw: J('fixtures/tb_fy25_nonzero.raw.json'), mapping: config.mapping, alerts: alerts2 });
  assert.match(s2.error, /config\/prior is not usable: it has no account rules/);

  const alerts3 = [];
  const s3 = buildPriorSection({ spec, raw: { data: { trialbalance: [] } }, mapping: config.mapping, alerts: alerts3 });
  assert.match(s3.error, /unexpected shape/);
});

// ---------- in the snapshot ----------

test('the refresh asks Zoho for last year once, puts the lines in the snapshot, and the snapshot survives a trip through JSON', { skip }, async () => {
  const zoho = replayZoho();
  const snap = await buildSnapshot({ zoho, config, fy: '2025-26', now: () => NOW });
  const asked = zoho.calls.filter((c) => c.path === '/reports/trialbalance' && !c.query.organization_id && c.query.from_date === '2024-04-01');
  assert.equal(asked.length, 1);
  assert.equal(asked[0].query.to_date, '2025-03-31');
  assert.equal(asked[0].query.show_rows, 'non_zero');
  assert.equal(snap.meta.ok, true);
  assert.ok(snap.prior && !snap.prior.error);
  assert.equal(snap.prior.to, '2025-03-31');
  assert.equal(Math.round(snap.prior.lines.pat), 258816465);
  assert.deepEqual(JSON.parse(JSON.stringify(snap.prior)), snap.prior, 'no -0, no undefined');
  assert.deepEqual(snap.alerts.filter((a) => /^PRIOR_/.test(a.code)), []);
  // this year's statements are the same as before: the statements of 2025-26 still tie to the signed ones
  assert.equal(snap.meta.reconciled.check, 0);
  // the panel data, made the way the page makes it
  const view = priorYear(snap, config);
  assert.deepEqual(view.summary, { ok: 45, expl: 5, diff: 0, none: 0, total: 50 });
});

test('if Zoho refuses last year\'s Trial Balance the run goes on: the statements are untouched and the panel says why', { skip }, async () => {
  const snap = await buildSnapshot({ zoho: replayZoho({ priorFail: 'refused' }), config, fy: '2025-26', now: () => NOW });
  assert.equal(snap.meta.ok, true, 'a detail layer: a warning, not an error');
  assert.match(snap.prior.error, /not authorized/);
  const a = snap.alerts.find((x) => x.code === 'PRIOR_UNAVAILABLE');
  assert.equal(a.level, 'warn');
  assert.match(a.message, /Last year \(2025-03-31\) could not be read from Zoho/);
  assert.equal(snap.meta.reconciled.check, 0, 'this year is not affected');
  assert.match(priorYear(snap, config).error, /not authorized/);
});

test('a Trial Balance that stops on another day is refused by the refresh with the dates in the sentence', { skip }, async () => {
  const snap = await buildSnapshot({ zoho: replayZoho({ priorDate: '2025-03-30' }), config, fy: '2025-26', now: () => NOW });
  assert.match(snap.prior.error, /up to 2025-03-30, not 2025-03-31/);
  assert.equal(snap.meta.ok, true);
});

test('a year without the configuration makes no extra call and carries no section', { skip }, async () => {
  const zoho = replayZoho();
  const snap = await buildSnapshot({ zoho, config: { ...config, prior: null }, fy: '2025-26', now: () => NOW });
  assert.equal(snap.prior, null);
  assert.equal(zoho.calls.filter((c) => c.path === '/reports/trialbalance' && !c.query.organization_id).length, 1);
});
