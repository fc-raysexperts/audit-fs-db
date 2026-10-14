// Step 1 check: build the statements from the saved Zoho snapshots and compare with the audited FS.
//   node scripts/reconcile.mjs            -> prints the table, exits 1 if any line that should tie does not
//   node scripts/reconcile.mjs --json     -> also writes reports/reconciliation.fy26.json

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeTB, checkTB } from '../lib/tb.mjs';
import { normalizeARAging } from '../lib/receivables.mjs';
import { computeFS } from '../lib/fsEngine.mjs';
import { reconcile } from '../lib/reconcile.mjs';
import { inr } from '../lib/util.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJSON = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));

const tb = normalizeTB(readJSON('fixtures/tb_fy26_nonzero.raw.json'));
const aging = normalizeARAging(readJSON('fixtures/ar_aging_2026-03-31.raw.json'));
const mapping = readJSON('config/mapping.json');
const inputs = readJSON('config/inputs.fy26.json');
const overrides = readJSON('config/overrides.fy26.json');
const audited = readJSON('config/audited.fy26.json');

const result = computeFS({ tb, mapping, inputs, aging, overrides });
result.alerts.push(...checkTB(tb));
const rec = reconcile(result, audited);

const pad = (s, n) => String(s).padEnd(n).slice(0, n);
const num = (x) => (x === null ? '-'.padStart(18) : inr(x, 0).padStart(18));
const sections = [['pl', 'PROFIT & LOSS'], ['bs', 'BALANCE SHEET - lines that tie to the Trial Balance'], ['party', 'PARTY-LEVEL LINES (Layer 2, not built yet)']];
console.log(`Trial Balance ${tb.meta.from} to ${tb.meta.to}  (${tb.meta.basis})   accounts read: ${tb.accounts.length}, with a balance: ${result.memo.mappedAccounts}`);
for (const [sec, title] of sections) {
  console.log(`\n== ${title}`);
  console.log(`${pad('line', 62)}${'from Zoho TB'.padStart(18)}${'audited'.padStart(18)}${'diff'.padStart(14)}  status`);
  for (const r of rec.rows.filter((x) => x.section === sec)) {
    const d = r.diff === null ? '-' : (Math.abs(r.diff) < 0.5 ? '0' : inr(r.diff, 0));
    console.log(`${pad(r.label, 62)}${num(r.value)}${num(r.audited)}${d.padStart(14)}  ${r.status}`);
  }
}
console.log('\n== CHECKS');
for (const c of result.checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.label}  (${c.value.toFixed(2)})`);
console.log('\n== ALERTS');
if (!result.alerts.length) console.log('none');
for (const a of result.alerts) console.log(`${a.level.toUpperCase().padEnd(5)} ${a.code}: ${a.message}`);
console.log(`\nSummary: ${rec.summary.ok} lines tie (largest gap ${rec.summary.maxAbsDiffOk.toFixed(2)} rupees, tolerance ${rec.tolerance}), ${rec.summary.check} need checking, ${rec.summary.phase2} are Phase-2 lines, ${rec.summary.noref} have no audited counterpart`);

if (process.argv.includes('--json')) {
  fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(root, 'reports/reconciliation.fy26.json'), JSON.stringify({ meta: tb.meta, rec, checks: result.checks, alerts: result.alerts }, null, 1));
}
const failed = rec.summary.check > 0 || result.checks.some((c) => !c.ok) || result.alerts.some((a) => a.level === 'error');
process.exit(failed ? 1 : 0);
