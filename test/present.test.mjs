// The screens' numbers: formatting, and the Balance Sheet / P&L layout built from the FY26 snapshot.
import test from 'node:test';
import assert from 'node:assert/strict';
import { inr, gap, longDate, previousFy, istStamp, ago } from '../lib/format.mjs';
import { buildView, TOTAL_TOLERANCE } from '../lib/present.mjs';
import { buildSnapshot } from '../lib/snapshot.mjs';
import { loadConfig } from '../lib/config.mjs';
import { replayZoho, haveFixtures } from '../testing/fakes.mjs';

const skip = !haveFixtures();
const config = loadConfig('2025-26');
const NOW = Date.parse('2026-10-15T06:30:00+05:30');
const snapshot = async () => buildSnapshot({ zoho: replayZoho(), config, fy: '2025-26', now: () => NOW });

test('rupee figures use Indian grouping, brackets for negatives and a dash for nil', () => {
  assert.equal(inr(4035435703.6), '4,03,54,35,704');
  assert.equal(inr(-244713396.13), '(24,47,13,396)');
  assert.equal(inr(0), '–');
  assert.equal(inr(0.3), '–');
  assert.equal(inr(0.3, 'rupee', { dash: false }), '0');
  assert.equal(inr(99999), '99,999');
  assert.equal(inr(100000), '1,00,000');
  assert.equal(inr(4035435703.6, 'lakh'), '40,354.36');
  assert.equal(inr(4035435703.6, 'crore'), '403.54');
  assert.equal(inr(-4035435703.6, 'crore'), '(403.54)');
  assert.equal(inr(null), '');
  assert.equal(inr(12, 'nonsense'), '12', 'an unknown unit falls back to rupees');
});

test('differences, dates and ages read plainly', () => {
  assert.equal(gap(4.2799), '4.28');
  assert.equal(gap(-0.4), '-0.40');
  assert.equal(gap(0.000001), '0.00');
  assert.equal(longDate('2026-03-31'), '31 March 2026');
  assert.equal(previousFy('2025-26'), '2024-25');
  assert.equal(previousFy('2000-01'), '1999-00');
  assert.equal(istStamp('2026-10-15T01:00:00.000Z'), '15 Oct 2026, 6:30 am');
  assert.equal(ago('2026-10-15T01:00:00.000Z', Date.parse('2026-10-15T01:00:20.000Z')), 'just now');
  assert.equal(ago('2026-10-15T01:00:00.000Z', Date.parse('2026-10-15T01:12:00.000Z')), '12 min ago');
  assert.equal(ago('2026-10-15T01:00:00.000Z', Date.parse('2026-10-15T04:00:00.000Z')), '3 h ago');
  assert.equal(ago('2026-10-14T01:00:00.000Z', Date.parse('2026-10-15T01:30:00.000Z')), 'yesterday');
});

test('the Balance Sheet balances and every subtotal ties to the audited statements', { skip }, async () => {
  const snap = await snapshot();
  const v = buildView(snap, config.audited);
  assert.ok(Math.abs(v.bs.gap) < 0.01, `assets and equity+liabilities differ by ${v.bs.gap}`);
  assert.ok(Math.abs(v.bs.totalAssets - 2382395029) <= TOTAL_TOLERANCE, 'total assets = audited 23,82,39,5029');
  const money = [...v.bs.liabilities, ...v.bs.assets, ...v.pl].filter((r) => r.kind !== 'heading');
  assert.ok(money.length > 50);
  for (const r of money) {
    assert.equal(r.status, 'OK', `${r.label}: ${r.value} vs audited ${r.audited}`);
    assert.ok(Math.abs(r.diff) <= TOTAL_TOLERANCE, r.label);
    assert.ok(!r.missing, `${r.label} is missing from the snapshot`);
  }
});

test('every statement line of the snapshot appears once on the statements', { skip }, async () => {
  const snap = await snapshot();
  const v = buildView(snap, config.audited);
  const shown = new Set([...v.bs.liabilities, ...v.bs.assets, ...v.pl].map((r) => r.id));
  const notShown = Object.keys(snap.statements.lines).filter((k) => !shown.has(k));
  assert.deepEqual(notShown, ['party_net'], 'only the party-level control line is left out');
  const ids = [...v.bs.liabilities, ...v.bs.assets, ...v.pl].map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, 'no row appears twice');
});

test("last year's audited figures come with the lines; the notes-level lines have none", { skip }, async () => {
  const v = buildView(await snapshot(), config.audited);
  const row = (id) => [...v.bs.liabilities, ...v.bs.assets, ...v.pl].find((r) => r.id === id);
  assert.equal(row('share_capital').prev, 50965000);
  assert.equal(row('trade_payables').prev, 26756802 + 4867337, 'group = sum of its two lines');
  assert.equal(row('other_current_liabilities').prev, 58983670);
  assert.equal(row('total_assets').prev, 978336967);
  assert.equal(row('pat').prev, 258816467);
  assert.equal(row('ocl_retention').prev, null);
  assert.equal(v.prevFy, '2024-25');
});

test('the Overview balance sheet has equal sides', { skip }, async () => {
  const v = buildView(await snapshot(), config.audited);
  const l = v.overview.left.reduce((s, r) => s + r.value, 0);
  const r = v.overview.right.reduce((s, r) => s + r.value, 0);
  assert.ok(Math.abs(l - r) < 0.01);
  assert.ok(Math.abs(l - v.bs.totalLiabilities) < 0.01);
  assert.deepEqual(v.overview.plSummary.map((x) => x.label), ['Revenue from operations', 'Total expenses', 'Profit before tax', 'Tax, net', 'Profit after tax']);
  const [rev, exp, pbt, tax, pat] = v.overview.plSummary;
  assert.ok(Math.abs(rev.value - exp.value - pbt.value) < 0.01 + 16171539.25, 'revenue - expenses + other income = profit before tax (within other income)');
  assert.ok(Math.abs(pbt.value + tax.value - pat.value) < 0.01);
  assert.equal(v.health.checksPassed, v.health.checksTotal);
  assert.equal(v.tie.ok, 47);
});

test('without an audited comparison (another date) the statements still show, with no tie marks', { skip }, async () => {
  const snap = await snapshot();
  const plain = { ...snap, reconciliation: null, meta: { ...snap.meta, reconciled: null } };
  const v = buildView(plain, null);
  assert.equal(v.hasTie, false);
  assert.equal(v.hasPrev, false);
  assert.equal(v.tie, null);
  for (const r of [...v.bs.liabilities, ...v.bs.assets, ...v.pl].filter((x) => x.kind !== 'heading')) {
    assert.equal(r.status, null);
    assert.equal(r.prev, null);
  }
  assert.ok(Math.abs(v.bs.gap) < 0.01);
});

test('a line missing from the snapshot is flagged, not hidden', { skip }, async () => {
  const snap = await snapshot();
  const lines = { ...snap.statements.lines };
  delete lines.cash;
  const v = buildView({ ...snap, statements: { lines } }, config.audited);
  const cash = v.bs.assets.find((r) => r.id === 'cash');
  assert.equal(cash.missing, true);
  assert.equal(cash.value, 0);
});
