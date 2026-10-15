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
import { printReport } from './print.mjs';
import { loadParty } from './fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJSON = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));

const tb = normalizeTB(readJSON('fixtures/tb_fy26_nonzero.raw.json'));
const aging = normalizeARAging(readJSON('fixtures/ar_aging_2026-03-31.raw.json'));
const mapping = readJSON('config/mapping.json');
const inputs = readJSON('config/inputs.fy26.json');
const overrides = readJSON('config/overrides.fy26.json');
const audited = readJSON('config/audited.fy26.json');

const party = loadParty();
const result = computeFS({ tb, mapping, inputs, aging, overrides, party });
result.alerts.push(...checkTB(tb));
if (party) result.alerts.push(...party.gl.alerts);
else console.log('NOTE: ledger snapshots (fixtures/gl, vendors_imprest_staff) not found - supplier lines fall back to the Trial Balance and are flagged PHASE2\n');
const rec = reconcile(result, audited);

printReport({
  heading: `Trial Balance ${tb.meta.from} to ${tb.meta.to}  (${tb.meta.basis})   accounts read: ${tb.accounts.length}, with a balance: ${result.memo.mappedAccounts}`,
  rec, lines: result.lines, checks: result.checks, alerts: result.alerts,
});

if (process.argv.includes('--json')) {
  fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(root, 'reports/reconciliation.fy26.json'), JSON.stringify({ meta: tb.meta, rec, checks: result.checks, alerts: result.alerts }, null, 1));
}
const failed = rec.summary.check > 0 || result.checks.some((c) => !c.ok) || result.alerts.some((a) => a.level === 'error');
process.exit(failed ? 1 : 0);
