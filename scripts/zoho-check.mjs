// Connection check, run on YOUR computer:  npm run zoho:check
// Uses the credentials in .env, calls the exact Zoho endpoints this dashboard needs and says PASS / FAIL for each,
// with a hint about the missing permission (scope) when Zoho refuses. Read-only. Secrets are never printed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './envfile.mjs';
import { createZohoClient } from '../lib/zoho.mjs';
import { normalizeTB, checkTB } from '../lib/tb.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...loadEnv(path.join(root, '.env')), ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('ZOHO_'))) };
const need = ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_REFRESH_TOKEN', 'ZOHO_ORG_ID'];
const absent = need.filter((k) => !env[k]);
if (absent.length) { console.error(`Missing in .env: ${absent.join(', ')}`); process.exit(1); }

const zoho = createZohoClient({ clientId: env.ZOHO_CLIENT_ID, clientSecret: env.ZOHO_CLIENT_SECRET, refreshToken: env.ZOHO_REFRESH_TOKEN, orgId: env.ZOHO_ORG_ID, dc: env.ZOHO_DC || 'in' });
const FY = { from: '2025-04-01', to: '2026-03-31' };
// report path is not in Zoho's public docs: we try these in order (override with ZOHO_TB_PATH)
const TB_PATHS = env.ZOHO_TB_PATH ? [env.ZOHO_TB_PATH] : ['/reports/trialbalance', '/reports/trial_balance'];

let failed = 0;
const hint = (e) => (e.status === 401 || e.code === 57 ? '  -> permission missing: add the scope named in this step when you generate the code' : e.stage === 'token' ? '  -> credentials / data centre problem' : '');
async function step(name, fn) {
  try {
    const detail = await fn();
    console.log(`PASS  ${name}${detail ? '  - ' + detail : ''}`);
    return true;
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}  - ${e.message}${hint(e)}`);
    return false;
  }
}

console.log(`Zoho data centre: ${zoho.dc}   organization: ${zoho.orgId}\n`);
await step('Sign in (access token)  [client id / secret / refresh token]', async () => { await zoho.get('/organizations'); return 'ok'; });
await step('Organization found', async () => {
  const r = await zoho.get('/organizations');
  const o = (r.organizations ?? []).find((x) => String(x.organization_id) === String(env.ZOHO_ORG_ID));
  if (!o) throw new Error(`organization ${env.ZOHO_ORG_ID} is not visible to this login (visible: ${(r.organizations ?? []).map((x) => x.name).join(', ') || 'none'})`);
  return `${o.name} (${o.currency_code}, fiscal year starts month ${o.fiscal_year_start_month ?? '?'})`;
});
await step('Contacts / vendors  [scope ZohoBooks.contacts.READ]', async () => { const r = await zoho.get('/contacts', { contact_type: 'vendor', per_page: 1 }); return `${(r.contacts ?? []).length} row read`; });
await step('Chart of accounts  [scope ZohoBooks.accountants.READ]', async () => { const r = await zoho.get('/chartofaccounts', { per_page: 1 }); return `${(r.chartofaccounts ?? []).length} row read`; });
await step('Journals  [scope ZohoBooks.accountants.READ]', async () => { const r = await zoho.get('/journals', { per_page: 1 }); return `${(r.journals ?? []).length} row read`; });
await step('Report metadata  [scope ZohoBooks.reports.READ]', async () => { await zoho.get('/reports/metadata', { entity_type: 'trial_balance' }); return 'ok'; });

let tbRaw = null;
for (const p of TB_PATHS) {
  const ok = await step(`Trial Balance FY ${FY.from} to ${FY.to}  [${p}]`, async () => {
    tbRaw = await zoho.get(p, { filter_by: 'TransactionDate.CustomDate', from_date: FY.from, to_date: FY.to, show_rows: 'non_zero', response_option: 1, usestate: 'false', per_page: 200 });
    const tb = normalizeTB(tbRaw);
    const bad = checkTB(tb).filter((a) => a.level === 'error');
    if (bad.length) throw new Error(bad.map((a) => a.message).join('; '));
    return `${tb.accounts.length} accounts, balanced`;
  });
  if (ok) break;
}

if (tbRaw) {
  const fx = path.join(root, 'fixtures/tb_fy26_nonzero.raw.json');
  if (fs.existsSync(fx)) {
    await step('Live Trial Balance equals the saved FY26 snapshot (every account within Rs 1)', async () => {
      const live = normalizeTB(tbRaw);
      const saved = new Map(normalizeTB(JSON.parse(fs.readFileSync(fx, 'utf8'))).accounts.map((a) => [a.id, a.closing]));
      const diffs = live.accounts.filter((a) => Math.abs(a.closing - (saved.get(a.id) ?? 0)) > 1);
      const missing = [...saved].filter(([id, c]) => Math.abs(c) > 1 && !live.accounts.some((a) => a.id === id));
      if (diffs.length || missing.length) throw new Error(`${diffs.length} accounts differ, ${missing.length} saved accounts missing (books changed since the snapshot? show the first: ${diffs[0]?.name ?? missing[0]?.[0]})`);
      return 'identical';
    });
  }
}

console.log(`\nAPI calls used by this check: ${zoho.stats.calls}   (Zoho Books -> Settings -> Developer & Data -> API Usage shows your daily allowance)`);
console.log(failed ? `\n${failed} step(s) failed - copy the FAIL lines above and send them to Claude (they contain no secrets).` : '\nAll good - the connection is ready.');
process.exit(failed ? 1 : 0);
