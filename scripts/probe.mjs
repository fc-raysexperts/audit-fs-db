// Diagnostic, run on YOUR computer:   node scripts/probe.mjs
//
// Asks Zoho the same two questions several ways and prints (and saves to reports/probe.txt) exactly what comes back,
// so we can see which way of asking gives the right answer:
//   1. Trial Balance with the columns the app needs (opening, debit, credit, closing) - compared with the saved FY26 copy
//   2. Receivables aging as of 31-Mar-2026 - which settings give the audited total (right answer: 814,301,563.66)
//   3. What Zoho says about that report's options (metadata)
// Read-only. About 12 Zoho calls. Secrets are never printed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './envfile.mjs';
import { createZohoClient } from '../lib/zoho.mjs';
import { normalizeTB } from '../lib/tb.mjs';
import { normalizeARAging } from '../lib/receivables.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...loadEnv(path.join(root, '.env')), ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('ZOHO_'))) };
const absent = ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_REFRESH_TOKEN', 'ZOHO_ORG_ID'].filter((k) => !env[k]);
if (absent.length) { console.error(`Missing in .env: ${absent.join(', ')}`); process.exit(1); }

const lines = [];
const out = (s = '') => { console.log(s); lines.push(s); };
const cut = (x, n = 900) => { const s = JSON.stringify(x); return s === undefined ? 'undefined' : s.length > n ? s.slice(0, n) + ' ...(cut)' : s; };
const fmt = (x) => (typeof x === 'number' ? x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(x));

const zoho = createZohoClient({
  clientId: env.ZOHO_CLIENT_ID, clientSecret: env.ZOHO_CLIENT_SECRET, refreshToken: env.ZOHO_REFRESH_TOKEN,
  orgId: env.ZOHO_ORG_ID, dc: env.ZOHO_DC || 'in',
});

const FY = { from: '2025-04-01', to: '2026-03-31' };
const ASOF = '2026-03-31';
const EXPECTED_AR = 814301563.66; // receivables aging total at 31-Mar-2026, from the saved copy

out(`probe  ${new Date().toISOString()}  node ${process.version}  organization ${zoho.orgId}`);

const readSaved = (rel) => { const f = path.join(root, rel); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; };
const nz = (x) => typeof x === 'number' && Math.abs(x) > 0.005;

// ---------------------------------------------------------------- 1. Trial Balance
out('\n==== 1. TRIAL BALANCE with the columns the app needs ====');
const TB_COLUMNS = [
  { field: 'account_id', group: 'account' }, { field: 'name', group: 'report' }, { field: 'account_code', group: 'report' },
  { field: 'opening_balance', group: 'report' }, { field: 'debit', group: 'report' }, { field: 'credit', group: 'report' }, { field: 'closing_balance', group: 'report' },
];
try {
  const raw = await zoho.get('/reports/trialbalance', {
    filter_by: 'TransactionDate.CustomDate', from_date: FY.from, to_date: FY.to, show_rows: 'non_zero', select_columns: TB_COLUMNS,
  });
  const body = raw?.data ?? raw;
  out('select_columns echoed by Zoho: ' + cut(body.page_context?.select_columns, 600));
  const rows = (body.trialbalance?.[0]?.account_transactions ?? []).flatMap((g) => g.account_transactions ?? []);
  out(`rows: ${rows.length}   with closing_balance: ${rows.filter((r) => 'closing_balance' in r).length}   with opening_balance: ${rows.filter((r) => 'opening_balance' in r).length}   non-zero closing: ${rows.filter((r) => nz(r.closing_balance)).length}`);
  out('keys of the first row: ' + Object.keys(rows[0] ?? {}).join(', '));
  const live = normalizeTB(raw);
  out(`our reader: ${live.accounts.length} accounts, ${live.accounts.filter((a) => nz(a.closing)).length} with a balance, closing balances add up to ${fmt(live.accounts.reduce((sum, a) => sum + a.closing, 0))}`);
  const savedTB = readSaved('fixtures/tb_fy26_nonzero.raw.json');
  if (savedTB) {
    const sv = normalizeTB(savedTB);
    const lm = new Map(live.accounts.map((a) => [a.id, a]));
    let bad = 0; let missing = 0; let firstBad = null;
    for (const a of sv.accounts) {
      const x = lm.get(a.id);
      if (!x) { if (nz(a.closing) || nz(a.opening)) { missing++; firstBad ??= `${a.name} missing`; } continue; }
      if (Math.abs(x.closing - a.closing) > 1 || Math.abs(x.opening - a.opening) > 1) { bad++; firstBad ??= `${a.name}: saved closing ${fmt(a.closing)} / opening ${fmt(a.opening)}, live closing ${fmt(x.closing)} / opening ${fmt(x.opening)}`; }
    }
    out(bad === 0 && missing === 0 ? 'RIGHT  every account (opening and closing) equals the saved FY26 copy within Rs 1' : `wrong  ${bad} accounts differ, ${missing} saved accounts missing in live. First: ${firstBad}`);
  } else {
    out('(no saved copy in fixtures/ to compare with)');
  }
} catch (e) {
  out('FAILED: ' + e.message);
}

// ---------------------------------------------------------------- 2. Receivables aging
out(`\n==== 2. RECEIVABLES AGING as of ${ASOF}  (the right total is ${fmt(EXPECTED_AR)}) ====`);
const CF = 'InvoiceDate.CustomDate';
const arBase = { aging_by: 'invoicedate', report_by: 'customer', show_by: 'overdueamount', per_page: 500, filter_by: CF, to_date: ASOF, report_date: ASOF };
const arVariants = [
  ['1 dates only (what the app sends today)', arBase],
  ['2 + include_manual_journals=true', { ...arBase, include_manual_journals: 'true' }],
  ['3 + include_credit_notes=true', { ...arBase, include_credit_notes: 'true' }],
  ['4 + both include_manual_journals and include_credit_notes', { ...arBase, include_manual_journals: 'true', include_credit_notes: 'true' }],
  ['5 + entity_list=invoice,credit_note,journal', { ...arBase, entity_list: 'invoice,credit_note,journal' }],
  ['6 + is_new_group_by=true', { ...arBase, is_new_group_by: 'true' }],
  ['7 like 4 + is_new_group_by=true', { ...arBase, include_manual_journals: 'true', include_credit_notes: 'true', is_new_group_by: 'true' }],
  ['8 like 4 + response_option=1, usestate=false', { ...arBase, include_manual_journals: 'true', include_credit_notes: 'true', response_option: 1, usestate: 'false' }],
];
const savedAR = readSaved('fixtures/ar_aging_2026-03-31.raw.json');
const results = [];
for (const [name, query] of arVariants) {
  try {
    const raw = await zoho.get('/reports/aragingsummary', query);
    const pc = (raw?.data ?? raw).page_context ?? {};
    const n = normalizeARAging(raw);
    const good = Math.abs(n.total - EXPECTED_AR) < 1;
    results.push({ name, n, good, gap: Math.abs(n.total - EXPECTED_AR) });
    out(`${good ? 'RIGHT' : 'wrong'}  ${name}\n       total ${fmt(n.total)}   customers ${n.contacts.length}   has_more_page ${pc.has_more_page}   as_of_date=${pc.as_of_date} to_date=${pc.to_date} applied_filter=${pc.applied_filter}`);
  } catch (e) {
    out(`FAILED  ${name}\n       ${e.message}`);
  }
}
const winners = results.filter((r) => r.good).map((r) => r.name);
out(winners.length ? `\nThese ways of asking gave the right total: ${winners.join(' | ')}` : '\nNo way of asking gave the right total (see the comparison below).');

if (savedAR && results.length) {
  const closest = [...results].sort((a, b) => a.gap - b.gap)[0];
  const sv = new Map(normalizeARAging(savedAR).contacts.map((c) => [c.id, c]));
  const lv = new Map(closest.n.contacts.map((c) => [c.id, c]));
  const diffs = [];
  let onlySaved = 0; let onlySavedSum = 0; let onlyLive = 0; let onlyLiveSum = 0; let changed = 0; let changedSum = 0;
  for (const [id, c] of sv) {
    const x = lv.get(id);
    if (!x) { onlySaved++; onlySavedSum += c.total; diffs.push({ name: c.name, d: -c.total, note: 'only in the saved copy' }); }
    else if (Math.abs(x.total - c.total) > 0.5) { changed++; changedSum += x.total - c.total; diffs.push({ name: c.name, d: x.total - c.total, note: 'amount differs' }); }
  }
  for (const [id, x] of lv) if (!sv.has(id)) { onlyLive++; onlyLiveSum += x.total; diffs.push({ name: x.name, d: x.total, note: 'only in live' }); }
  out(`\nClosest way of asking: "${closest.name}" compared with the saved 31-Mar-2026 copy`);
  out(`  customers only in the saved copy: ${onlySaved} (their total ${fmt(onlySavedSum)})`);
  out(`  customers only in live:           ${onlyLive} (their total ${fmt(onlyLiveSum)})`);
  out(`  customers in both with a different amount: ${changed} (live minus saved, in total ${fmt(changedSum)})`);
  for (const d of diffs.sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 8)) out(`  ${fmt(d.d).padStart(18)}  ${d.note.padEnd(24)} ${d.name}`);
}

// ---------------------------------------------------------------- 3. What Zoho says about the aging report's options
out('\n==== 3. OPTIONS OF THE AGING REPORT (metadata) ====');
try {
  const meta = await zoho.get('/reports/metadata', { entity_type: 'ar_aging_summary' });
  const text = JSON.stringify(meta);
  out(`metadata size ${text.length} characters; top-level keys: ${Object.keys(meta).join(', ')}`);
  const names = [...new Set((text.match(/"[A-Za-z_.]*(journal|credit_note|creditnote|include|entity|advance|opening|unapplied|payment)[A-Za-z_.]*"/gi) ?? []))];
  out('names mentioning journal / credit / include / entity / advance / opening / payment: ' + (names.slice(0, 60).join(' ') || '(none)'));
} catch (e) {
  out('FAILED: ' + e.message);
}

out(`\nZoho calls used: ${zoho.stats.calls}`);
fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
fs.writeFileSync(path.join(root, 'reports/probe.txt'), lines.join('\n') + '\n');
out('\nSaved as reports\\probe.txt - attach that file (or paste this screen) in the chat. It contains no secrets.');
