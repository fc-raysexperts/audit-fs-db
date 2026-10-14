// Runs the whole pipeline on the saved FY 2025-26 snapshots. Skipped when the (git-ignored) fixtures are absent.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeTB, checkTB } from '../lib/tb.mjs';
import { normalizeARAging } from '../lib/receivables.mjs';
import { computeFS } from '../lib/fsEngine.mjs';
import { reconcile } from '../lib/reconcile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const have = fs.existsSync(path.join(root, 'fixtures/tb_fy26_nonzero.raw.json')) && fs.existsSync(path.join(root, 'fixtures/ar_aging_2026-03-31.raw.json'));
const J = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));

test('FY26 Trial Balance rebuilds the audited statements within tolerance', { skip: !have }, () => {
  const tb = normalizeTB(J('fixtures/tb_fy26_nonzero.raw.json'));
  const out = computeFS({ tb, mapping: J('config/mapping.json'), inputs: J('config/inputs.fy26.json'), aging: normalizeARAging(J('fixtures/ar_aging_2026-03-31.raw.json')), overrides: J('config/overrides.fy26.json') });
  const rec = reconcile(out, J('config/audited.fy26.json'));
  const bad = rec.rows.filter((r) => r.status === 'CHECK');
  assert.deepEqual(bad.map((r) => r.key), []);
  assert.ok(rec.summary.ok >= 40);
  assert.ok(out.checks.every((c) => c.ok), JSON.stringify(out.checks));
  assert.deepEqual(out.alerts.filter((a) => a.level === 'error'), []);
  assert.deepEqual(checkTB(tb), []);
  // headline numbers
  const v = Object.fromEntries(rec.rows.map((r) => [r.key, r.value]));
  assert.ok(Math.abs(v.pat - 475812977) <= 5);
  assert.ok(Math.abs(v.equity_total - 1507540257) <= 5);
  assert.ok(Math.abs(v.trade_receivables - 554432472) <= 1);
});

test('a missing account mapping is detected, not silently dropped', { skip: !have }, () => {
  const tb = normalizeTB(J('fixtures/tb_fy26_nonzero.raw.json'));
  const mapping = J('config/mapping.json');
  mapping.rules = mapping.rules.filter((r) => r.match.code !== '1-03' && r.match.family !== '1-03'); // drop the CWIP rule
  const out = computeFS({ tb, mapping, inputs: J('config/inputs.fy26.json'), aging: normalizeARAging(J('fixtures/ar_aging_2026-03-31.raw.json')), overrides: J('config/overrides.fy26.json') });
  assert.ok(out.alerts.some((a) => a.code === 'UNMAPPED_ACCOUNT'));
  assert.ok(out.checks.some((c) => !c.ok));
});
