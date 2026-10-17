// Diagnostic, run on YOUR computer:   node scripts/probe-advances.mjs
//
// Do the unused amounts of the customer payments in Zoho Books reproduce the signed list of advances from customers (BS Grouping, Rs 31.80 cr)?
// Reads every customer payment (about 5 to 30 Zoho calls, 200 payments each), adds the unused amounts of the payments dated up to 31-Mar-2026 customer by
// customer, and compares them with the 113 lines of the signed sheet. Prints, and saves to reports/probe-advances.txt. Read-only. Secrets are never printed.
// Zoho shows the unused amount as it is TODAY: a payment applied to an invoice after 31-Mar-2026 no longer shows, so some difference is expected.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './envfile.mjs';
import { createZohoClient } from '../lib/zoho.mjs';
import { loadConfig } from '../lib/config.mjs';
import { readSheet } from '../lib/workbook.mjs';
import { unusedByCustomer, advanceLinesOfSheet, compareAdvances } from '../lib/advances.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...loadEnv(path.join(root, '.env')), ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('ZOHO_'))) };
const absent = ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_REFRESH_TOKEN', 'ZOHO_ORG_ID'].filter((k) => !env[k]);
if (absent.length) { console.error(`Missing in .env: ${absent.join(', ')}`); process.exit(1); }

const ASOF = '2026-03-31';
const lines = [];
const out = (s = '') => { console.log(s); lines.push(s); };
const inr = (x) => x.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const zoho = createZohoClient({
  clientId: env.ZOHO_CLIENT_ID, clientSecret: env.ZOHO_CLIENT_SECRET, refreshToken: env.ZOHO_REFRESH_TOKEN,
  orgId: env.ZOHO_ORG_ID, dc: env.ZOHO_DC || 'in',
});

out(`probe-advances  ${new Date().toISOString()}  organization ${zoho.orgId}  balance sheet date ${ASOF}`);
const pages = [];
for (let page = 1; page <= 200; page += 1) {
  const raw = await zoho.get('/customerpayments', { per_page: 200, page, sort_column: 'date', sort_order: 'D' });
  pages.push(raw);
  const pc = (raw?.data ?? raw)?.page_context ?? {};
  process.stdout.write(`\rpage ${page} read`);
  if (pc.has_more_page !== true) break;
  if (page === 200) { out('\nStopped at 200 pages: something is wrong with the paging.'); process.exit(1); }
}
process.stdout.write('\n');

const u = unusedByCustomer(pages, { asOf: ASOF });
out(`\nPayments read: ${u.seen}. Dated after ${ASOF} (left out): ${u.later}. With an unused amount: ${u.payments}, for ${u.customers.length} customers.`);
out(`Unused amounts added up: Rs ${inr(u.total)}`);

const config = loadConfig('2025-26');
const sheet = readSheet(config.workbook, 'bs-grouping');
const signed = advanceLinesOfSheet(sheet.rows);
const c = compareAdvances(u.customers, signed);
out(`Signed list: ${signed.length} lines, Rs ${inr(c.signedTotal)}`);
out(`\nSame figure (within Rs 1): ${c.same.length} customers, Rs ${inr(c.same.reduce((t, x) => t + x.signed, 0))}`);
out(`Found, another figure: ${c.differ.length}`);
out(`On the sheet, no unused payment in Zoho: ${c.missing.length}, Rs ${inr(c.missing.reduce((t, x) => t + x.signed, 0))}`);
out(`In Zoho, not on the sheet: ${c.extra.length}, Rs ${inr(c.extra.reduce((t, x) => t + x.unused, 0))}`);
out(`Part of the signed total that Zoho explains: Rs ${inr(c.explained)} (${((100 * c.explained) / c.signedTotal).toFixed(1)} percent)`);
if (c.differ.length) { out('\nFound, another figure (sheet / Zoho today / difference):'); for (const x of c.differ.slice(0, 40)) out(`  ${x.label}  ${inr(x.signed)}  ${inr(x.zoho)}  ${inr(x.diff)}`); }
if (c.missing.length) { out('\nOn the sheet, nothing in Zoho:'); for (const x of c.missing.slice(0, 40)) out(`  ${x.label}  ${inr(x.signed)}`); }
if (c.extra.length) { out('\nIn Zoho, not on the sheet (largest first):'); for (const x of c.extra.slice(0, 40)) out(`  ${x.name}  ${inr(x.unused)}`); }

fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
fs.writeFileSync(path.join(root, 'reports', 'probe-advances.txt'), lines.join('\n') + '\n');
out('\nSaved to reports/probe-advances.txt - please send me that file.');
