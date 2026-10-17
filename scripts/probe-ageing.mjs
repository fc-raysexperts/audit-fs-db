// Diagnostic, run on YOUR computer:   node scripts/probe-ageing.mjs
//
// Checks the live columns of the Debtors Ageing and Creditors Ageing tabs against YOUR Zoho connection (update-13, update-14):
//   1. builds the snapshot the way the dashboard does (about 25 Zoho calls + journals + the vendor cards; journals and Vendor Codes come from Redis when .env has Upstash)
//      - this run reads ALL the vendor cards (the dashboard reads 40 per refresh), so it also fills the Vendor Code cache
//   2. shows what the ageing reports of the debtors really answered (Customer Balance Summary now, at 30-Sep-2025 and at 31-Mar-2025, Sales by Customer for both halves of the year)
//   3. shows what Zoho's Vendor Balance Summary answered for the vendors of the Creditors Ageing, and whether it reads from_date
//   4. puts the two ageing sheets through the live check and shows, column by column, how many lines agree and which do not (the Vendor Code too)
// Read-only. Secrets are never printed. Prints, and saves to reports/probe-ageing.txt (and .json).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './envfile.mjs';
import { createZohoClient } from '../lib/zoho.mjs';
import { createUpstash, createCache } from '../lib/cache.mjs';
import { buildSnapshot, CREDITOR_CLASSES } from '../lib/snapshot.mjs';
import { loadConfig } from '../lib/config.mjs';
import { readSheet, liveOverlay } from '../lib/workbook.mjs';
import { cell } from '../lib/format.mjs';
import { fetchSalesByCustomer, fetchVendorBalances } from '../lib/zohoData.mjs';
import { normalizeSalesByCustomer, normalizeVendorBalances } from '../lib/ageing.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...loadEnv(path.join(root, '.env')), ...Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(ZOHO|UPSTASH)_/.test(k))) };
const absent = ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_REFRESH_TOKEN', 'ZOHO_ORG_ID'].filter((k) => !env[k]);
if (absent.length) { console.error(`Missing in .env: ${absent.join(', ')}`); process.exit(1); }

const fy = '2025-26';
const lines = [];
const out = (s = '') => { console.log(s); lines.push(s); };
const save = (extra = {}) => {
  fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(root, 'reports', 'probe-ageing.txt'), lines.join('\n') + '\n');
  if (Object.keys(extra).length) fs.writeFileSync(path.join(root, 'reports', 'probe-ageing.json'), JSON.stringify(extra, null, 1) + '\n');
};
const R = (x) => cell(Math.round(x));

let cache = null;
if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
  cache = createCache(createUpstash({ url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN }), { org: env.ZOHO_ORG_ID });
}
const zoho = createZohoClient({
  clientId: env.ZOHO_CLIENT_ID, clientSecret: env.ZOHO_CLIENT_SECRET, refreshToken: env.ZOHO_REFRESH_TOKEN,
  orgId: env.ZOHO_ORG_ID, dc: env.ZOHO_DC || 'in', ...(cache ? { tokenStore: cache.tokenStore } : {}),
});
const config = loadConfig(fy);
config.settings = { ...config.settings, vendor_code_budget: 300 }; // this run reads every vendor card, once
out(`probe-ageing  ${new Date().toISOString()}  organization ${zoho.orgId}  FY ${fy}`);

let snap;
try {
  snap = await buildSnapshot({ zoho, cache, config, fy, log: (m) => console.log('  - ' + m) });
} catch (e) {
  out(`\nStopped while building the snapshot: ${e.message}`);
  save();
  process.exit(1);
}
out(`\nSnapshot built in ${(snap.meta.durationMs / 1000).toFixed(1)} s with ${snap.meta.apiCalls} Zoho calls; statements ${snap.meta.ok ? 'OK' : 'HAVE ERRORS'}.`);

const a = snap.ageing;
const report = {};

// ---------------------------------------------------------------- 1. the reports
out('\n== 1. The reports ==');
out(`Dates used: balances at ${a.asOf} and at ${a.openDate}; sales from ${a.windowFrom}.`);
for (const [what, key] of [['Debtors (Customer Balance Summary x2, Sales by Customer)', 'debtors'], ['Creditors (ledger of the supplier accounts, no extra report)', 'creditors'], ['Billed and Paid (Vendor Balance Summary x2)', 'vbs']]) {
  const built = key === 'vbs' ? a.creditors?.vbs : a[key];
  out(`${what}: ${built ? 'built' : 'NOT built'}${a.problems[key] ? ` - ${a.problems[key]}` : ''}`);
}
if (a.debtors) out(`  customers aged ${a.debtors.customers.length}, not in Zoho's report ${a.debtors.missing.length}; buckets add up to ${R(a.debtors.totals.lt6 + a.debtors.totals.m6_12 + a.debtors.totals.older)} (closing ${R(a.debtors.totals.closing)})`);
if (a.debtors) out(`  the debtors are aged ${a.debtors.journals ? 'with the first half of the year, so a journal that debits a customer is aged by its date' : 'by invoices only (the first half of the year could not be read: see the alerts below)'}`);
if (a.debtors) out(`  less than 6 months ${R(a.debtors.totals.lt6)}; 6 months to 1 year ${R(a.debtors.totals.m6_12)}; older than 1 year ${R(a.debtors.totals.older)}`);
if (a.creditors) out(`  vendors aged ${a.creditors.vendors.length}; less than 1 year ${R(a.creditors.totals.lt1)}, older ${R(a.creditors.totals.older)} (closing ${R(a.creditors.totals.closing)})`);
if (a.creditors) out(`  Vendor Codes read from the vendor cards: ${a.creditors.codes ? `${a.creditors.codes.known} of ${a.creditors.codes.total} (${a.creditors.codes.fetched} from Zoho this time, ${a.creditors.codes.fromCache} from Redis)` : `none${a.problems.codes ? ` - ${a.problems.codes}` : ''}`}; vendors the age buckets leave out as retention money: ${a.creditors.vendors.filter((v) => v.retention).length}`);
if (a.creditors?.vbs) out(`  Billed for the year ${R(a.creditors.totals.yearBilled)}; Paid for the year ${R(a.creditors.totals.yearPaid)}`);
for (const al of snap.alerts.filter((x) => /^AGEING/.test(x.code))) out(`  ${al.level.toUpperCase()} ${al.code}: ${al.message}`);

// ---------------------------------------------------------------- 2. Sales by Customer, as Zoho answers it
out('\n== 2. Sales by Customer (the six months that decide "Less than 6M") ==');
try {
  const pages = await fetchSalesByCustomer(zoho, { from: a.windowFrom, to: a.asOf });
  const root_ = pages[0]?.data ?? pages[0];
  const rows = root_?.sales ?? [];
  out(`Zoho answered ${rows.length} customer line(s) on ${pages.length} page(s) for ${root_?.page_context?.from_date ?? '?'} to ${root_?.page_context?.to_date ?? '?'}; fields on the first line: ${rows[0] ? Object.keys(rows[0]).filter((k) => !/values|branch|contact|custom|currency/.test(k)).join(', ') : '-'}`);
  const w = normalizeSalesByCustomer(pages);
  const inv = Object.values(w.byId).reduce((t, x) => t + x.invoices, 0);
  const cn = Object.values(w.byId).reduce((t, x) => t + x.creditNotes, 0);
  out(`Invoices ${R(inv)}, credit notes ${R(cn)}, net ${R(inv - cn)}`);
  report.sales = { lines: rows.length, invoices: inv, creditNotes: cn };
} catch (e) { out(`Sales by Customer failed: ${e.message}`); }

// ---------------------------------------------------------------- 3. Vendor Balance Summary, as Zoho answers it
out('\n== 3. Vendor Balance Summary (Billed and Paid of the Creditors Ageing) ==');
const ids = snap.suppliers.parties.filter((p) => CREDITOR_CLASSES.includes(p.class)).map((p) => String(p.id));
try {
  const sample = ids.slice(0, 20);
  const life = normalizeVendorBalances(await fetchVendorBalances(zoho, { ids: sample, from: config.settings.books_start, to: a.asOf }));
  const range = normalizeVendorBalances(await fetchVendorBalances(zoho, { ids: sample, from: snap.meta.from, to: a.asOf }));
  const same = sample.filter((id) => Math.abs((life.byId[id]?.billed ?? 0) - (range.byId[id]?.billed ?? 0)) < 0.5 && Math.abs((life.byId[id]?.paid ?? 0) - (range.byId[id]?.paid ?? 0)) < 0.5).length;
  out(`Asked for ${sample.length} of the ${ids.length} vendors of the sheet, from the start of the books and from ${snap.meta.from}, both up to ${a.asOf}: ${life ? Object.keys(life.byId).length : 0} came back; the two answers are the same for ${same} of ${sample.length}.`);
  out(same === sample.length ? 'So Zoho does NOT read from_date on this report: the amounts run from the start of the books, and the year is the difference of two dates (that is what the dashboard does).'
    : 'So Zoho DOES read from_date on this report: the amounts depend on it. Please send me this file: the dashboard asks from the start of the books both times, which still gives the right difference, but I want to look.');
  for (const id of sample.slice(0, 3)) {
    const l = life.byId[id];
    out(`  ${String(l?.name ?? id).slice(0, 36).padEnd(36)} billed ${R(l?.billed ?? 0)}  paid ${R(l?.paid ?? 0)}  closing ${R(l?.closing ?? 0)}`);
  }
  report.vbs = { sample: sample.length, sameWithAndWithoutFrom: same, first: sample.slice(0, 3).map((id) => life.byId[id]) };
} catch (e) { out(`Vendor Balance Summary failed: ${e.message}${e.code ? ` (${e.code})` : ''}`); }
if (a.creditors?.vbs) {
  const v = a.creditors.vendors;
  // billed - paid over the year should equal the change of the closing balance when the report is a plain "since the start of the books" summary
  out(`The year, over all ${v.length} vendors of the sheet: billed ${R(a.creditors.totals.yearBilled)}, paid ${R(a.creditors.totals.yearPaid)} (signed: billed 53,13,77,285, paid 45,93,57,280).`);
}

// ---------------------------------------------------------------- 4. the two sheets
for (const [id, title] of [['debtors-ageing', 'Debtors Ageing'], ['creditors-ageing', 'Creditors Ageing']]) {
  out(`\n== 4. ${title} against the signed sheet ==`);
  const data = readSheet(config.workbook, id);
  const o = liveOverlay(snap, data);
  for (const p of o.problems) out(`  PROBLEM: ${p}`);
  out(`  closing balance: ${o.summary.ok + o.summary.name} of ${o.summary.lines} lines agree (${o.summary.diff} differ, ${o.summary.none} not in Zoho)`);
  for (const c of o.columns) out(`  ${c.label.padEnd(46)} ${String(c.ok).padStart(4)} agree  ${String(c.diff).padStart(3)} differ   column total ${c.totalOk + c.totalBad === 0 ? '-' : c.totalBad === 0 ? 'agrees' : 'DIFFERS'}`);
  const rows = Object.entries(o.byRow).filter(([, v]) => v.kind === 'detail' && v.cols && Object.values(v.cols).some((x) => x.status === 'DIFF'));
  if (rows.length) {
    out(`  lines that differ in a column (${rows.length}${rows.length > 60 ? '; the first 60 are shown here, all are in reports/probe-ageing.json' : ''}):`);
    for (const [r, v] of rows.slice(0, 60)) {
      const d = Object.entries(v.cols).filter(([, x]) => x.status === 'DIFF').map(([c, x]) => `${String(data.rows[0][c] ?? c).slice(0, 14)}: signed ${x.text ? `"${x.signed}"` : R(x.signed)} / Zoho ${x.text ? `"${x.live}"` : R(x.live)}`).join('; ');
      out(`    ${String(data.rows[r][0]).slice(0, 40).padEnd(40)} ${d}`);
    }
  }
  report[id] = { columns: o.columns, differing: rows.map(([r, v]) => ({ name: data.rows[r][0], cols: v.cols })) };
}

save({ meta: snap.meta, ageingProblems: a.problems, ...report });
out('\nSaved to reports/probe-ageing.txt and reports/probe-ageing.json - please send me both files.');
