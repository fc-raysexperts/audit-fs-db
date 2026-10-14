import test from 'node:test';
import assert from 'node:assert/strict';
import { computeReceivables } from '../lib/receivables.mjs';

const aging = (asOf, list) => ({ meta: { asOf }, contacts: list.map(([id, total]) => ({ id, name: 'C' + id, total })), total: list.reduce((s, [, t]) => s + t, 0) });
const ov = { as_of: '2026-03-31', entries: { 1: { name: 'C1', zb_total: 100, adjustment: -40 }, 2: { name: 'C2', zb_total: 50, adjustment: -50 } } };

test('hand-netting is applied on its own date: receivable = max(0, zb + adjustment)', () => {
  const r = computeReceivables(aging('2026-03-31', [['1', 100], ['2', 50], ['3', 7], ['4', -20]]), ov);
  assert.equal(r.receivableTotal, 60 + 0 + 7 + 0); // credit balance (-20) counts as 0 receivable
  assert.equal(r.overridesApplied, true);
});

test('hand-netting is NOT applied to any other date', () => {
  const r = computeReceivables(aging('2026-06-30', [['1', 100], ['2', 50]]), ov);
  assert.equal(r.receivableTotal, 150);
  assert.equal(r.overridesApplied, false);
  assert.ok(r.alerts.some((a) => a.code === 'OVERRIDES_SKIPPED'));
});

test('stale override (balance moved) and missing customer both raise warnings', () => {
  const r = computeReceivables(aging('2026-03-31', [['1', 130]]), ov);
  assert.ok(r.alerts.some((a) => a.code === 'OVERRIDE_STALE'));
  assert.ok(r.alerts.some((a) => a.code === 'OVERRIDE_CUSTOMER_MISSING'));
});
