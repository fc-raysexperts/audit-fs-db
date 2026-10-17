// The live run, on YOUR computer:   npm run live
//
//   1. checks that Redis (Upstash) can be written to and read from
//   2. pulls the Trial Balance, receivables, supplier ledger and journals from Zoho (read-only)
//   3. builds the statements, runs every check and compares with the audited figures
//   4. saves the finished snapshot in Redis (under audit-fs:...) and reads it back
//
//   npm run live -- --no-save          do everything except step 4
//   npm run live -- --from-cache       only show what is saved in Redis (no Zoho call at all)
//   npm run live -- --fy 2025-26       financial year (default 2025-26)
// Secrets come from .env and are never printed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './envfile.mjs';
import { createZohoClient } from '../lib/zoho.mjs';
import { createUpstash, createCache, istDate } from '../lib/cache.mjs';
import { buildSnapshot } from '../lib/snapshot.mjs';
import { loadConfig } from '../lib/config.mjs';
import { printReport } from './print.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...loadEnv(path.join(root, '.env')), ...Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(ZOHO|UPSTASH)_/.test(k))) };
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const fy = args.includes('--fy') ? args[args.indexOf('--fy') + 1] : '2025-26';

const show = (snap, note) => {
  console.log(note);
  printReport({
    heading: `Statements for FY ${snap.meta.fy}, as of ${snap.meta.asOf}   (${snap.meta.tb.accounts} Trial Balance accounts, ledger ${snap.meta.ledger.lines} lines)`,
    rec: snap.reconciliation, lines: snap.statements.lines, checks: snap.checks, alerts: snap.alerts,
  });
};

try {
  const absent = ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_REFRESH_TOKEN', 'ZOHO_ORG_ID'].filter((k) => !env[k]);
  if (absent.length && !flag('--from-cache')) throw new Error(`Missing in .env: ${absent.join(', ')}`);

  // ---- Redis ----
  let cache = null;
  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
    const redis = createUpstash({ url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN });
    cache = createCache(redis, { org: env.ZOHO_ORG_ID });
    const k = `audit-fs:selftest:${Date.now()}`;
    await redis.cmd(['SET', k, 'ok', 'EX', 60]);
    const back = await redis.cmd(['GET', k]);
    await redis.cmd(['DEL', k]);
    if (back !== 'ok') throw new Error('Redis wrote a test value but did not give it back');
    console.log('PASS  Redis (Upstash): write, read and delete a test key');
  } else {
    console.log('NOTE  Redis is not set up (UPSTASH_REDIS_REST_URL / _TOKEN missing in .env): running without the cache');
  }

  if (flag('--from-cache')) {
    if (!cache) throw new Error('--from-cache needs Redis');
    const got = await cache.getSnapshot(fy);
    if (!got) { console.log(`Nothing saved for FY ${fy} yet. Run:  npm run live`); process.exit(0); }
    show(got.snapshot, `Saved snapshot made ${got.snapshot.meta.generatedAt} (India date ${got.snapshot.meta.istDate})${got.stale ? '  - NOT from today' : ''}${got.flawed ? '  - HAS ERRORS' : ''}`);
    process.exit(0);
  }

  // ---- Zoho ----
  const zoho = createZohoClient({
    clientId: env.ZOHO_CLIENT_ID, clientSecret: env.ZOHO_CLIENT_SECRET, refreshToken: env.ZOHO_REFRESH_TOKEN,
    orgId: env.ZOHO_ORG_ID, dc: env.ZOHO_DC || 'in', ...(cache ? { tokenStore: cache.tokenStore } : {}),
  });
  const config = loadConfig(fy);
  console.log(`\nReading Zoho Books (organization ${zoho.orgId}, FY ${fy}) ...`);
  const snap = await buildSnapshot({ zoho, cache, config, fy, log: (m) => console.log('  - ' + m) });
  show(snap, `\nDone in ${(snap.meta.durationMs / 1000).toFixed(1)} s, ${snap.meta.apiCalls} Zoho calls (journals read from cache: ${snap.meta.ledger.journalsFromCache} of ${snap.meta.ledger.journalsRead}).`);

  fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(root, `reports/live_${fy}.json`), JSON.stringify(snap));
  console.log(`\nA copy of the snapshot is in reports/live_${fy}.json`);

  // ---- save ----
  if (cache && !flag('--no-save')) {
    const stored = await cache.putSnapshot(snap);
    if (stored.kept) {
      console.log('NOTE  This run had errors, so it was NOT saved: a good snapshot for today is already in Redis and was kept');
    } else {
      const back = await cache.getSnapshot(fy, snap.meta.istDate);
      if (!back || back.snapshot.meta.generatedAt !== snap.meta.generatedAt) throw new Error('The snapshot was saved but could not be read back from Redis');
      console.log(`PASS  Saved in Redis and read back (${Math.round(stored.chars / 1024)} KB in ${stored.parts || 1} piece(s)); the dashboard will show it instantly all day (India date ${snap.meta.istDate})`);
      if (!stored.latestMoved) console.log('NOTE  This run had errors, so the "latest good" pointer was NOT moved to it');
    }
  } else if (cache) {
    console.log('(not saved: --no-save)');
  }
  process.exit(snap.meta.ok ? 0 : 1);
} catch (e) {
  console.error(`\nSTOPPED: ${e.message}`);
  if (e.code) console.error(`(code: ${e.code})`);
  if (e.cause?.code) console.error(`(network: ${e.cause.code} - check the internet connection / firewall)`);
  console.error('Copy this message to Claude - it contains no secrets.');
  process.exit(1);
}
