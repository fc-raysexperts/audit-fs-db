// Diagnostic, run on YOUR computer:   node scripts/probe-stock.mjs
//
// Can the "Closing Stock" tab be made live from Zoho Books?  This reads Zoho's "Inventory Valuation Summary" (the stock summary: per item the stock on hand and
// the inventory asset value) as at 31-Mar-2026 on YOUR connection and shows:
//   1. which way of asking the report works (the dates, the columns), what the answer looks like and how many items it holds;
//   2. account by account against the stock accounts of the Trial Balance (Inventories - Project Material GM, Inventory Asset, NPD Panchu Purchase) - the report's total holds all three;
//   3. item by item against the signed sheet (config/workbook.fy26/closing-stock.json): same value, different value, only in Zoho, only on the sheet;
//   4. the items with negative stock or value in Zoho.
// Read-only: it only asks for reports (3 to 12 calls). Secrets are never printed. Prints, and saves to reports/probe-stock.txt and reports/probe-stock.json
// (the json also holds the first part of the raw answer, so the shape of the report can be read from it).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './envfile.mjs';
import { createZohoClient } from '../lib/zoho.mjs';
import { createUpstash, createCache } from '../lib/cache.mjs';
import { fetchTrialBalance } from '../lib/zohoData.mjs';
import { normalizeTB } from '../lib/tb.mjs';
import { normName } from '../lib/overlay.mjs';
import { cell } from '../lib/format.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...loadEnv(path.join(root, '.env')), ...Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(ZOHO|UPSTASH)_/.test(k))) };
const absent = ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_REFRESH_TOKEN', 'ZOHO_ORG_ID'].filter((k) => !env[k]);
if (absent.length) { console.error(`Missing in .env: ${absent.join(', ')}`); process.exit(1); }

const FROM = '2025-04-01';
const TO = '2026-03-31';
const lines = [];
const out = (s = '') => { console.log(s); lines.push(s); };
const R = (x) => cell(Math.round(x * 100) / 100);
const n = (x) => { const v = Number(String(x ?? '').replace(/,/g, '')); return Number.isFinite(v) ? v : 0; };
const save = (extra = {}) => {
  fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(root, 'reports', 'probe-stock.txt'), lines.join('\n') + '\n');
  if (Object.keys(extra).length) fs.writeFileSync(path.join(root, 'reports', 'probe-stock.json'), JSON.stringify(extra, null, 1) + '\n');
};

let cache = null;
if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
  cache = createCache(createUpstash({ url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN }), { org: env.ZOHO_ORG_ID });
}
const zoho = createZohoClient({
  clientId: env.ZOHO_CLIENT_ID, clientSecret: env.ZOHO_CLIENT_SECRET, refreshToken: env.ZOHO_REFRESH_TOKEN,
  orgId: env.ZOHO_ORG_ID, dc: env.ZOHO_DC || 'in', ...(cache ? { tokenStore: cache.tokenStore } : {}),
});
out(`probe-stock  ${new Date().toISOString()}  organization ${zoho.orgId}  as at ${TO}`);

// ---------------------------------------------------------------- 1. the report
const COLUMNS = [
  { field: 'item_name', group: 'report' }, { field: 'quantity_available', group: 'report' }, { field: 'asset_value', group: 'report' },
  { field: 'inventory_account', group: 'report' }, { field: 'sku', group: 'item' }, { field: 'unit', group: 'item' },
];
const BASE = { stock_on_hand_filter: 'All', status_filter: 'All', sort_column: 'item_name', response_option: 1, per_page: 200 };
const ATTEMPTS = [
  { label: 'dates from 01-Apr-2025 to 31-Mar-2026, columns named', query: { ...BASE, filter_by: 'TransactionDate.CustomDate', from_date: FROM, to_date: TO, select_columns: COLUMNS } },
  { label: 'dates from 01-Apr-2025 to 31-Mar-2026, default columns', query: { ...BASE, filter_by: 'TransactionDate.CustomDate', from_date: FROM, to_date: TO } },
  { label: 'the single day 31-Mar-2026, default columns', query: { ...BASE, filter_by: 'TransactionDate.CustomDate', from_date: TO, to_date: TO } },
];
const PATH = '/reports/inventoryvaluation';

/** Every object in the answer that looks like a stock line: it has an item name and a stock quantity or an asset value. */
function itemsOf(raw) {
  const found = [];
  const walk = (x) => {
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (!x || typeof x !== 'object') return;
    if (typeof x.item_name === 'string' && ('asset_value' in x || 'quantity_available' in x)) { found.push(x); return; }
    for (const [k, v] of Object.entries(x)) if (k !== 'page_context') walk(v);
  };
  walk(raw?.data ?? raw);
  return found;
}
const ctxOf = (raw) => (raw?.data ?? raw)?.page_context ?? {};

async function readAll(query) {
  const pages = [];
  for (let page = 1; page <= 30; page += 1) {
    const raw = await zoho.get(PATH, { ...query, page });
    pages.push(raw);
    if (ctxOf(raw).has_more_page !== true) return pages;
  }
  throw new Error('more than 30 pages - stopped');
}

out(`\n== 1. The report (${PATH}) ==`);
let used = null;
const attemptsLog = [];
for (const a of ATTEMPTS) {
  try {
    const pages = await readAll(a.query);
    const items = pages.flatMap(itemsOf);
    const pc = ctxOf(pages[0]);
    const stated = pc.as_of_date ?? pc.to_date ?? null;
    attemptsLog.push({ label: a.label, pages: pages.length, items: items.length, stated, keys: Object.keys(pages[0]?.data ?? pages[0] ?? {}) });
    out(`  - ${a.label}: ${pages.length} page(s), ${items.length} item line(s), the answer says the date is ${stated ?? '(not stated)'}`);
    if (items.length && !used && (!stated || stated === TO)) used = { ...a, pages, items };
  } catch (e) {
    attemptsLog.push({ label: a.label, error: e.message });
    out(`  - ${a.label}: REFUSED - ${e.message}`);
  }
}
if (!used) {
  out('\nNo way of asking gave item lines for 31-Mar-2026. Send reports/probe-stock.txt and reports/probe-stock.json back.');
  save({ attempts: attemptsLog });
  process.exit(1);
}
out(`\nUsing: ${used.label}.`);
const rows = used.items.map((x) => ({
  name: String(x.item_name).trim(), sku: x.sku ?? null, unit: x.item_unit ?? x.item?.unit ?? x.unit ?? null, account: x.inventory_account ?? x.inventory_account_name ?? null,
  qty: n(x.quantity_available ?? x.stock_on_hand), value: n(x.asset_value),
}));
const total = rows.reduce((s, r) => s + r.value, 0);
out(`Zoho: ${rows.length} item lines (${rows.filter((r) => Math.abs(r.value) >= 0.005).length} with a value), asset value in total ${R(total)}`);
const byAccount = new Map();
for (const r of rows) byAccount.set(r.account ?? '(account not given)', (byAccount.get(r.account ?? '(account not given)') ?? 0) + r.value);
if (byAccount.size > 1 || !byAccount.has('(account not given)')) for (const [k, v] of byAccount) out(`    ${String(k).padEnd(48)} ${R(v).padStart(18)}`);

// ---------------------------------------------------------------- 2. the Trial Balance
out('\n== 2. Against the Trial Balance ==');
let tbStock = null;
try {
  const tb = normalizeTB(await fetchTrialBalance(zoho, { from: FROM, to: TO }));
  const pick = (id) => tb.accounts.find((a) => a.id === id)?.closing ?? 0;
  const accounts = [['Inventories - Project Material GM', '2346113000026786021'], ['Inventory Asset', '2346113000000000626'], ['NPD Panchu Purchase', '2346113000007638003']];
  out(`  ${'Ledger account'.padEnd(36)} ${'items in the report'.padStart(20)} ${'Trial Balance'.padStart(18)} ${'difference'.padStart(16)}`);
  tbStock = 0;
  for (const [name, id] of accounts) {
    const items = rows.filter((r) => normName(r.account ?? '') === normName(name)).reduce((s, r) => s + r.value, 0);
    const led = pick(id);
    tbStock += led;
    out(`  ${name.padEnd(36)} ${R(items).padStart(20)} ${R(led).padStart(18)} ${R(led - items).padStart(16)} ${Math.abs(led - items) <= 1 ? '(agrees)' : ''}`);
  }
  out(`  ${'All three'.padEnd(36)} ${R(total).padStart(20)} ${R(tbStock).padStart(18)} ${R(tbStock - total).padStart(16)}`);
} catch (e) {
  out(`  The Trial Balance could not be read: ${e.message}`);
}

// ---------------------------------------------------------------- 3. against the signed sheet
out('\n== 3. Item by item against the signed Closing Stock sheet ==');
const sheet = JSON.parse(fs.readFileSync(path.join(root, 'config', 'workbook.fy26', 'closing-stock.json'), 'utf8')).rows;
const signed = [];
for (const r of sheet.slice(2)) {
  if (r[0] === 'Total') break;
  if (r[0] != null && r[3] != null) signed.push({ name: String(r[0]).trim(), qty: n(r[1]), value: n(r[3]), unit: r[4] ?? null });
}
const sheetTotal = signed.reduce((s, r) => s + r.value, 0);
// the same item can stand on several rows of the sheet (stock bought at different rates): they are added up per item name before the comparison
const sByName = new Map();
for (const r of signed) {
  const k = normName(r.name);
  const e = sByName.get(k) ?? { name: r.name, qty: 0, value: 0, rows: 0, unit: r.unit };
  e.qty += r.qty; e.value += r.value; e.rows += 1;
  sByName.set(k, e);
}
out(`  Sheet: ${signed.length} rows = ${sByName.size} different items, value in total ${R(sheetTotal)} (the sheet itself shows 2,86,463,271 + NPD Panchu 4,81,953, "Difference" 4,32,747)`);
const multi = [...sByName.values()].filter((e) => e.rows > 1);
if (multi.length) out(`  (${multi.length} item(s) stand on more than one row of the sheet; their rows were added up)`);
const zByName = new Map();
for (const r of rows) {
  const k = normName(r.name);
  const e = zByName.get(k) ?? { name: r.name, qty: 0, value: 0, lines: 0, unit: r.unit };
  e.qty += r.qty; e.value += r.value; e.lines += 1;
  zByName.set(k, e);
}
const used2 = new Set();
const same = []; const differ = []; const onlySheet = [];
for (const [k, s] of sByName) {
  const z = zByName.get(k);
  if (!z) { onlySheet.push(s); continue; }
  used2.add(k);
  (Math.abs(z.value - s.value) <= 1 ? same : differ).push({ s, z, diff: z.value - s.value });
}
const onlyZoho = [...zByName].filter(([k, z]) => !used2.has(k) && Math.abs(z.value) >= 0.005).map(([, z]) => z);
out(`  ${same.length} of ${sByName.size} sheet items give the same value in Zoho (within Rs 1); ${differ.length} give another value; ${onlySheet.length} are not in Zoho under that name; ${onlyZoho.length} items with a value are in Zoho only`);
const dups = [...zByName.values()].filter((z) => z.lines > 1);
if (dups.length) out(`  (${dups.length} name(s) appear on more than one Zoho line; their values were added)`);
const show = (title, list, f, limit = 25) => {
  if (!list.length) return;
  out(`\n  ${title} (${list.length}${list.length > limit ? `, the ${limit} largest` : ''}):`);
  for (const x of list.slice(0, limit)) out('    ' + f(x));
};
differ.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
show('Same item, another value', differ, (x) => `${x.s.name.slice(0, 44).padEnd(44)} sheet ${R(x.s.value).padStart(14)} qty ${String(Math.round(x.s.qty * 1000) / 1000).padStart(9)}   Zoho ${R(x.z.value).padStart(14)} qty ${String(Math.round(x.z.qty * 1000) / 1000).padStart(9)}   diff ${R(x.diff)}`);
onlySheet.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
show('On the sheet, not found in Zoho', onlySheet, (x) => `${x.name.slice(0, 50).padEnd(50)} sheet ${R(x.value).padStart(14)} qty ${x.qty}`);
onlyZoho.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
show('In Zoho with a value, not on the sheet', onlyZoho, (x) => `${x.name.slice(0, 50).padEnd(50)} Zoho ${R(x.value).padStart(14)} qty ${x.qty}`);
const gap = total - sheetTotal;
out(`\n  Zoho total ${R(total)} less sheet items ${R(sheetTotal)} = ${R(gap)}`
  + `   (differing items ${R(differ.reduce((s, x) => s + x.diff, 0))}; only in Zoho ${R(onlyZoho.reduce((s, x) => s + x.value, 0))}; only on the sheet ${R(-onlySheet.reduce((s, x) => s + x.value, 0))})`);

// ---------------------------------------------------------------- 4. negative stock
out('\n== 4. Negative stock or value in Zoho ==');
const neg = rows.filter((r) => r.qty < 0 || r.value < -0.005);
out(`  ${neg.length} item line(s), value ${R(neg.reduce((s, r) => s + r.value, 0))}`);
for (const r of neg.sort((a, b) => a.value - b.value).slice(0, 15)) out(`    ${r.name.slice(0, 50).padEnd(50)} qty ${String(r.qty).padStart(9)}  value ${R(r.value).padStart(14)}`);

save({
  attempts: attemptsLog, used: used.label, total, tbStock, sheetTotal,
  counts: { zoho: rows.length, sheetRows: signed.length, sheetItems: sByName.size, same: same.length, differ: differ.length, onlySheet: onlySheet.length, onlyZoho: onlyZoho.length, negative: neg.length },
  differ: differ.map((x) => ({ name: x.s.name, sheet: x.s.value, zoho: x.z.value })),
  onlySheet, onlyZoho: onlyZoho.map((z) => ({ name: z.name, value: z.value, qty: z.qty })),
  items: rows,
  rawFirstItems: used.items.slice(0, 3), rawKeys: Object.keys(used.pages[0]?.data ?? used.pages[0] ?? {}), pageContext: ctxOf(used.pages[0]),
});
out('\nSaved reports/probe-stock.txt and reports/probe-stock.json');
