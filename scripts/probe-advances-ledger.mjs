// Diagnostic, run on YOUR computer:   node scripts/probe-advances-ledger.mjs
//
// Can the signed list of advances from customers (BS Grouping, Rs 31.80 cr, 113 lines) be rebuilt from the Zoho ledger of the account
// "Advance from debtors" up to 31-Mar-2026, customer by customer, after the auditors' hand-netting (config/overrides.fy26.json)?
//   1. Trial Balance      -> the account and its closing balance (the ledger must add up to it)
//   2. General Ledger     -> every line of that account up to 31-Mar-2026, with the customer (journals that mix customers are opened line by line)
//   3. Receivables aging  -> the hand-netting list and the customers whose receivable is in credit
//   4. Compare with the 113 lines of the signed sheet, once before and once after the netting
// About 6 to 30 Zoho calls. Read-only. Secrets are never printed. Prints, and saves to reports/probe-advances-ledger.txt (and .json).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './envfile.mjs';
import { createZohoClient } from '../lib/zoho.mjs';
import { loadConfig } from '../lib/config.mjs';
import { readSheet } from '../lib/workbook.mjs';
import { advanceLinesOfSheet } from '../lib/advances.mjs';
import { runAdvanceLedgerProbe, formatAdvanceProbe } from '../lib/advanceProbe.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...loadEnv(path.join(root, '.env')), ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('ZOHO_'))) };
const absent = ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_REFRESH_TOKEN', 'ZOHO_ORG_ID'].filter((k) => !env[k]);
if (absent.length) { console.error(`Missing in .env: ${absent.join(', ')}`); process.exit(1); }

const period = { from: '2025-04-01', to: '2026-03-31' };
const zoho = createZohoClient({
  clientId: env.ZOHO_CLIENT_ID, clientSecret: env.ZOHO_CLIENT_SECRET, refreshToken: env.ZOHO_REFRESH_TOKEN,
  orgId: env.ZOHO_ORG_ID, dc: env.ZOHO_DC || 'in',
});

const lines = [];
const out = (s = '') => { console.log(s); lines.push(s); };
out(`probe-advances-ledger  ${new Date().toISOString()}  organization ${zoho.orgId}  balance sheet date ${period.to}`);

const config = loadConfig('2025-26');
const signed = advanceLinesOfSheet(readSheet(config.workbook, 'bs-grouping').rows);
let result;
try {
  result = await runAdvanceLedgerProbe({ zoho, config, period, signed });
} catch (e) {
  out(`\nStopped: ${e.message}`);
  fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(root, 'reports', 'probe-advances-ledger.txt'), lines.join('\n') + '\n');
  process.exit(1);
}
for (const l of formatAdvanceProbe(result)) out(l);

fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
fs.writeFileSync(path.join(root, 'reports', 'probe-advances-ledger.txt'), lines.join('\n') + '\n');
fs.writeFileSync(path.join(root, 'reports', 'probe-advances-ledger.json'), JSON.stringify({ asOf: result.asOf, account: result.account, ledgerTotal: result.led.total, model: result.model.customers, signed }, null, 1) + '\n');
out('\nSaved to reports/probe-advances-ledger.txt - please send me that file.');
