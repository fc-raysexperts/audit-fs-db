// Diagnostic, run on YOUR computer:   node scripts/probe-splits.mjs
//
// Checks the line-by-line parts of BS Grouping (update-15) against YOUR Zoho connection:
//   1. builds the snapshot the way the dashboard does (the first run opens the 34 clean-up journals behind the deposit accounts; with Upstash in .env they are kept for 12 hours)
//   2. for each split of config/splits.fy26.json shows the parts Zoho gives (fixed deposits and accrued interest bank by bank, the three security deposits, PF employee / employer
//      share, the insurers and RPE Energy Reserve; since update-16 also HDFC ERGO's payable for Delhi and for Rajasthan, by the billing-address state of its 4 bills),
//      what is left unassigned, and whether the account / contact adds up
//   3. puts BS Grouping through the live check and shows what agrees, what differs, and which lines are still compared in total
// Read-only. Secrets are never printed. Prints, and saves to reports/probe-splits.txt (and .json).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './envfile.mjs';
import { createZohoClient } from '../lib/zoho.mjs';
import { createUpstash, createCache } from '../lib/cache.mjs';
import { buildSnapshot } from '../lib/snapshot.mjs';
import { loadConfig } from '../lib/config.mjs';
import { readSheet, liveOverlay } from '../lib/workbook.mjs';
import { cell } from '../lib/format.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...loadEnv(path.join(root, '.env')), ...Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(ZOHO|UPSTASH)_/.test(k))) };
const absent = ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_REFRESH_TOKEN', 'ZOHO_ORG_ID'].filter((k) => !env[k]);
if (absent.length) { console.error(`Missing in .env: ${absent.join(', ')}`); process.exit(1); }

const fy = '2025-26';
const lines = [];
const out = (s = '') => { console.log(s); lines.push(s); };
const save = (extra = {}) => {
  fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(root, 'reports', 'probe-splits.txt'), lines.join('\n') + '\n');
  if (Object.keys(extra).length) fs.writeFileSync(path.join(root, 'reports', 'probe-splits.json'), JSON.stringify(extra, null, 1) + '\n');
};
const R = (x) => cell(Math.round(x * 100) / 100);

let cache = null;
if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
  cache = createCache(createUpstash({ url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN }), { org: env.ZOHO_ORG_ID });
}
const zoho = createZohoClient({
  clientId: env.ZOHO_CLIENT_ID, clientSecret: env.ZOHO_CLIENT_SECRET, refreshToken: env.ZOHO_REFRESH_TOKEN,
  orgId: env.ZOHO_ORG_ID, dc: env.ZOHO_DC || 'in', ...(cache ? { tokenStore: cache.tokenStore } : {}),
});
const config = loadConfig(fy);
out(`probe-splits  ${new Date().toISOString()}  organization ${zoho.orgId}  FY ${fy}`);

let snap;
try {
  snap = await buildSnapshot({ zoho, cache, config, fy, log: (m) => console.log('  - ' + m) });
} catch (e) {
  out(`\nStopped while building the snapshot: ${e.message}`);
  save();
  process.exit(1);
}
out(`\nSnapshot built in ${(snap.meta.durationMs / 1000).toFixed(1)} s with ${snap.meta.apiCalls} Zoho calls; statements ${snap.meta.ok ? 'OK' : 'HAVE ERRORS'}.`);

// ---------------------------------------------------------------- 1. the splits
out('\n== 1. The splits ==');
const m = snap.meta.splits;
out(m ? `Ledger of the deposit / PF accounts: ${m.rows} entries; clean-up journals opened: ${m.journalsRead} (${m.journalsFromCache} from Redis, ${m.journalsRefetched} read again because the copy was old)` : 'The ledger of the deposit / PF accounts was NOT read (see the alerts below): those lines are compared in total.');
const bl = snap.meta.bills;
if (bl) out(`Bills of HDFC ERGO (billing-address state, update-16): ${bl.read} asked for, ${bl.fromCache} from Redis, ${bl.failed} could not be read`);
const report = { splits: snap.splits, bills: bl ?? null };
for (const [key, s] of Object.entries(snap.splits ?? {})) {
  if (key === 'error') { out(`\n  (all deposit accounts) not used: ${s}`); continue; }
  if (s.error) { out(`\n  ${key}: NOT USED - ${s.error}`); continue; }
  out(`\n  ${s.title}   (${s.rows} entries, total ${R(s.total)}, rest not given to a line ${R(s.residual)})`);
  for (const p of s.parts) out(`    ${p.name.padEnd(34)} ${R(p.amount).padStart(18)}   from ${p.rows} entr${p.rows === 1 ? 'y' : 'ies'}`);
  for (const u of s.unassigned) out(`    UNASSIGNED ${u.entry} ${u.date} ${R(u.amount)}  ${u.text !== undefined ? `"${String(u.text).slice(0, 60)}"  (${u.why})` : '(a bill whose billing state could not be read)'}`);
}
for (const al of snap.alerts.filter((x) => /^SPLIT/.test(x.code))) out(`  ${al.level.toUpperCase()} ${al.code}: ${al.message}`);

// ---------------------------------------------------------------- 2. BS Grouping
out('\n== 2. BS Grouping against the signed sheet ==');
const data = readSheet(config.workbook, 'bs-grouping');
const o = liveOverlay(snap, data);
for (const p of o.problems) out(`  PROBLEM: ${p}`);
const s = o.summary;
out(`  ${s.ok + s.name} of ${s.lines} lines agree (${s.name} under another name); ${s.diff} differ; ${s.none} not found in Zoho; ${s.lump} compared in total (${s.lumpsOk} list(s), ${s.tiesOk} ties agree, ${s.tiesBad + s.lumpsBad} do not); Zoho balances the sheet lacks: ${s.extras}; totals ${s.totalsOk} agree, ${s.totalsBad} differ`);
const bad = Object.entries(o.byRow).filter(([, v]) => v.kind === 'detail' && (v.status === 'DIFF' || v.status === 'NONE'));
for (const [r, v] of bad) out(`  ${v.status} ${String(data.rows[r][1]).slice(0, 48).padEnd(48)} signed ${R(v.signed)}  Zoho ${v.live === null ? '-' : R(v.live)}`);
const lump = Object.entries(o.byRow).filter(([, v]) => v.kind === 'detail' && v.status === 'LUMP');
out(`  Lines still compared in total (${lump.length}):`);
for (const [r, v] of lump) out(`    ${String(data.rows[r][1]).slice(0, 48).padEnd(48)} ${R(v.signed).padStart(14)}   ${v.lumpOk ? 'agrees' : 'DIFFERS'}${v.zohoName ? ' - ' + String(v.zohoName).slice(0, 50) : ''}`);
for (const t of o.ties) out(`  tie: ${t.title.slice(0, 70)}  signed ${R(t.signed)} / Zoho ${R(t.live)}  ${t.ok ? 'agrees' : 'DIFFERS'}`);
for (const e of o.extras) out(`  EXTRA in Zoho, not on the sheet: ${e.group} - ${e.name} ${R(e.value)}`);

save({ meta: snap.meta, ...report, bsGrouping: { summary: { ...s, columns: undefined }, ties: o.ties, problems: o.problems, lumpLines: lump.map(([r, v]) => ({ name: data.rows[r][1], signed: v.signed, ok: v.lumpOk })) } });
out('\nSaved to reports/probe-splits.txt and reports/probe-splits.json - please send me both files.');
