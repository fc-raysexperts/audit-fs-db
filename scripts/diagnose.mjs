// "Why does the site not open / not update?"   npm run diagnose
//
// Run on YOUR computer (it reads .env). It makes at most ONE call to Zoho Books and a handful to Redis, changes nothing, prints no secret, and says in plain words which of the usual causes it is:
//   1. the settings (.env) are incomplete
//   2. Redis (Upstash) cannot be reached, refuses the token, or has used up its allowance
//   3. what is saved in Redis (the statements, how old, the "last good" copy, the record of the last attempt, any marker that "an update is running")
//   4. Zoho Books: sign-in token and one small read, so that "the request limit is reached" shows up here and not as a mystery on the page
//
//   npm run diagnose                    look only
//   npm run diagnose -- --clear-locks   also remove the "an update is running" markers (a run the hosting killed leaves one for up to 2 minutes)
//   npm run diagnose -- --clear-attempt also forget the record of the last attempt (this lifts the 10 minutes' wait after Zoho's request limit)
//   npm run diagnose -- --fy 2025-26    financial year (default 2025-26)

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './envfile.mjs';
import { createZohoClient } from '../lib/zoho.mjs';
import { createUpstash, createCache, istDate } from '../lib/cache.mjs';
import { moreToRead } from '../lib/server.mjs';
import { istStamp, longDate } from '../lib/format.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...loadEnv(path.join(root, '.env')), ...Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(ZOHO|UPSTASH|AUDIT)_/.test(k))) };
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const fy = args.includes('--fy') ? args[args.indexOf('--fy') + 1] : env.AUDIT_FY || '2025-26';

const lines = { PASS: 0, FAIL: 0, NOTE: 0 };
const say = (kind, text) => { lines[kind] += 1; console.log(`${kind.padEnd(4)}  ${text}`); };
const fix = (text) => console.log(`      -> ${text}`);

console.log(`Update diagnosis for FY ${fy}, ${new Date().toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' })} India time\n`);

// ---- 1. settings ----
const need = ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_REFRESH_TOKEN', 'ZOHO_ORG_ID', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'];
const absent = need.filter((k) => !env[k]);
if (absent.length) {
  say('FAIL', `Missing in .env: ${absent.join(', ')}`);
  fix('add them to the .env file (and, if the site runs on Vercel, to the Vercel project settings), then restart.');
} else say('PASS', 'All six settings are present (Zoho: client id, secret, refresh token, organization; Redis: address and token)');
if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN || !env.ZOHO_ORG_ID) process.exit(1);

// ---- 2. Redis ----
const redis = createUpstash({ url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN, timeoutMs: 15_000 });
const cache = createCache(redis, { org: env.ZOHO_ORG_ID });
let redisOk = false;
try {
  const t0 = Date.now();
  const k = `audit-fs:selftest:${Date.now()}`;
  await redis.cmd(['SET', k, 'ok', 'EX', 60]);
  const back = await redis.cmd(['GET', k]);
  await redis.cmd(['DEL', k]);
  if (back !== 'ok') throw new Error('Redis wrote a test value but did not give it back');
  say('PASS', `Redis (Upstash) answers: write, read and delete a test key took ${Date.now() - t0} ms`);
  redisOk = true;
} catch (e) {
  say('FAIL', `Redis does not work: ${e.message}`);
  if (/max (daily|monthly)|limit|quota/i.test(e.message)) fix("Upstash's allowance is used up. Wait for it to renew (daily / monthly) or raise the plan in the Upstash console. Until then the site cannot show anything.");
  else if (/WRONGPASS|auth|401|403/i.test(e.message)) fix('The Redis token in .env is not accepted. Copy the REST token again from the Upstash console.');
  else if (/did not answer|Cannot reach|EAI_AGAIN|ENOTFOUND|ECONN/i.test(e.message)) fix('This computer cannot reach Upstash: check the internet connection / VPN / firewall, then run this again.');
}

// ---- 3. what is saved ----
let snapshot = null;
if (redisOk) {
  try {
    const got = await cache.getSnapshot(fy, istDate());
    if (!got) say('NOTE', `Nothing is saved for FY ${fy}: the site starts empty and loads everything from Zoho Books (the first load can take several short runs, a minute apart).`);
    else {
      snapshot = got.snapshot;
      const m = got.snapshot.meta;
      say(got.stale ? 'NOTE' : 'PASS', `Statements saved: from ${longDate(m.istDate)}, loaded ${istStamp(m.generatedAt)}${got.stale ? ' - NOT today\'s (they are shown as the last good ones; an update is needed)' : ' - today\'s'}${got.flawed ? ', with errors' : ''}`);
      if (moreToRead(got.snapshot)) say('NOTE', 'Some tabs (CWIP / Dep.Calc.) are still being read in parts; the page continues them by itself.');
    }
    for (const [label, name] of [['today\'s copy', cache.key.snapshot(fy, istDate())], ['"latest good" pointer', cache.key.latest(fy)], ['"last good" copy (kept 400 days, update-33)', cache.key.last(fy)], ['asset entries', cache.key.assetHistory()], ['vendor cards', cache.key.vendorCodes()]]) {
      const ttl = await redis.cmd(['TTL', name]);
      console.log(`      ${label.padEnd(44)} ${ttl === -2 ? 'not there' : ttl === -1 ? 'kept for ever' : `there, expires in ${Math.round(ttl / 86400)} day(s)`}`);
    }
    const attempt = await cache.getAttempt().catch(() => null);
    if (!attempt) say('NOTE', 'No record of a last attempt (nothing has been tried since update-33 was installed, or the record expired).');
    else {
      say(attempt.status === 'refreshed' ? 'PASS' : attempt.status === 'failed' ? 'FAIL' : 'NOTE', `Last attempt: ${attempt.status} at ${istStamp(new Date(attempt.at).toISOString())}${attempt.durationMs ? `, ${(attempt.durationMs / 1000).toFixed(0)} s` : ''}${attempt.calls ? `, ${attempt.calls} reads` : ''}`);
      if (attempt.message) fix(attempt.message);
      if (attempt.retryAt && attempt.retryAt > Date.now()) fix(`Nothing new is started before ${istStamp(new Date(attempt.retryAt).toISOString())} (use --clear-attempt to lift this wait).`);
    }
    for (const lock of ['refresh', 'attempt', 'continue']) {
      const age = await cache.lockAge(lock).catch(() => null);
      if (age !== null) say('NOTE', `Marker "${lock}" is set (taken ${Math.round(age / 1000)} s ago): an update is running, or one was stopped without freeing it. It frees itself (refresh: 2 minutes, attempt: 2 minutes, continue: 1 minute).`);
    }
    if (flag('--clear-locks')) { for (const lock of ['refresh', 'attempt', 'continue']) await cache.releaseLock(lock); say('PASS', 'The "update is running" markers were removed.'); }
    if (flag('--clear-attempt')) { await redis.cmd(['DEL', cache.key.attempt()]); say('PASS', 'The record of the last attempt was removed.'); }
  } catch (e) {
    say('FAIL', `What is saved in Redis could not be read: ${e.message}`);
  }
}

// ---- 4. Zoho ----
if (!['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_REFRESH_TOKEN', 'ZOHO_ORG_ID'].some((k) => !env[k])) {
  const zoho = createZohoClient({
    clientId: env.ZOHO_CLIENT_ID, clientSecret: env.ZOHO_CLIENT_SECRET, refreshToken: env.ZOHO_REFRESH_TOKEN, orgId: env.ZOHO_ORG_ID, dc: env.ZOHO_DC || 'in',
    ...(redisOk ? { tokenStore: cache.tokenStore } : {}), maxRetries: 0, timeoutMs: 20_000,
  });
  try {
    const t0 = Date.now();
    await zoho.get(`/organizations/${env.ZOHO_ORG_ID}`);
    say('PASS', `Zoho Books answers (sign-in works, one small read took ${Date.now() - t0} ms; ${zoho.stats.tokenRefreshes ? 'a new access token was fetched' : 'the saved access token was used'})`);
  } catch (e) {
    say('FAIL', `Zoho Books: ${e.message}`);
    if (e.status === 429 || e.stage === 'quota') fix("Zoho's request limit is reached. It is per organization and shared by EVERY program that reads your Zoho Books (all your dashboards). The per-minute limit eases in a minute or two; the daily one starts again overnight. Nothing in this dashboard needs changing - the site keeps showing the last good statements and tries again by itself.");
    else if (e.stage === 'token') fix('Zoho refused or could not give an access token. If the message says invalid_code / invalid_client, the refresh token or client secret in .env is wrong or was revoked: run  npm run zoho:token  to make a new one. If it says it could not reach Zoho, check the internet connection.');
    else if (e.code === 'TIMEOUT' || e.stage === 'timeout') fix('Zoho did not answer in time. Try again in a few minutes.');
    else if (e.status === 401 || e.status === 403) fix('Zoho refused this login for the organization. Check ZOHO_ORG_ID and that the Self Client still has its Zoho Books scopes.');
  }
}

console.log(`\n${lines.FAIL ? `${lines.FAIL} problem(s) found - read the lines marked FAIL and the arrows under them.` : 'Nothing is wrong that this check can see.'}`);
if (!lines.FAIL && snapshot) console.log('If the page still shows a message, open  /status  on the site: it shows the same facts and what the last attempt did.');
process.exit(lines.FAIL ? 1 : 0);
