// The web app's server side, with Zoho and Redis replaced by fakes: first load, refresh rules, next-day behaviour, errors.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createContext, decideRefresh, stateOf, cronAllowed, readSettings, cwipOpen, MIN_REFRESH_MS, RETRY_AFTER_ERROR_MS } from '../lib/server.mjs';
import { createUpstash, createCache } from '../lib/cache.mjs';
import { buildSnapshot } from '../lib/snapshot.mjs';
import { loadConfig } from '../lib/config.mjs';
import { fakeUpstash, replayZoho, haveFixtures } from '../testing/fakes.mjs';

const skip = !haveFixtures();
const T0 = Date.parse('2026-10-15T06:30:00+05:30');
const ENV = {
  ZOHO_ORG_ID: '60038956413', ZOHO_CLIENT_ID: 'id', ZOHO_CLIENT_SECRET: 'secret', ZOHO_REFRESH_TOKEN: 'refresh',
  UPSTASH_REDIS_REST_URL: 'https://x.upstash.io',
};
function setup(extra = {}) {
  const clock = { t: T0 };
  const f = fakeUpstash({ clock });
  const clients = [];
  const ctx = createContext({
    env: { ...ENV, UPSTASH_REDIS_REST_TOKEN: f.token, ...(extra.env ?? {}) }, now: () => clock.t, fetchImpl: f.fetchImpl,
    zohoFactory: extra.zohoFactory ?? (() => { const z = replayZoho(); clients.push(z); return z; }),
    // update-29: with Redis a run reads only `register_history_budget` (100) assets' entries; these tests are about other things, so they read all 483 at once (the chain of runs has its own test below)
    configLoader: (fy) => { const c = loadConfig(fy); return { ...c, settings: { ...c.settings, register_history_budget: extra.historyBudget ?? 1000 } }; },
  });
  return { clock, f, ctx, clients };
}
const snap = (over = {}) => ({ meta: { generatedAt: new Date(T0).toISOString(), ok: true, ...over } });

test('refresh rules: protect the shared Zoho quota', () => {
  const good = (ageMs) => ({ snapshot: snap({ generatedAt: new Date(T0 - ageMs).toISOString() }), stale: false, flawed: false });
  assert.deepEqual(decideRefresh({ got: null, nowMs: T0, manual: false }), { run: true }, 'nothing saved yet: load');
  assert.equal(decideRefresh({ got: good(60_000), nowMs: T0, manual: false }).run, false, "today's good snapshot: the automatic load does nothing");
  const soon = decideRefresh({ got: good(60_000), nowMs: T0, manual: true });
  assert.equal(soon.run, false);
  assert.match(soon.message, /Loaded 1 min ago.*works again after 9 min/);
  assert.equal(decideRefresh({ got: good(MIN_REFRESH_MS + 1000), nowMs: T0, manual: true }).run, true, 'the button works again after 10 minutes');
  const old = { snapshot: snap({ generatedAt: new Date(T0 - 20 * 3600e3).toISOString() }), stale: true, flawed: false };
  assert.equal(decideRefresh({ got: old, nowMs: T0, manual: false }).run, true, "an earlier day's snapshot: load");
  const flawed = (ageMs) => ({ snapshot: snap({ ok: false, generatedAt: new Date(T0 - ageMs).toISOString() }), stale: false, flawed: true });
  assert.equal(decideRefresh({ got: flawed(30_000), nowMs: T0, manual: true }).run, false, 'a failing run is not repeated at once');
  assert.equal(decideRefresh({ got: flawed(RETRY_AFTER_ERROR_MS + 1000), nowMs: T0, manual: false }).run, true);
});

test('update-20: a CWIP tab that is only part read is finished at once, by a continuation, whatever the 10 minutes of Refresh say', () => {
  const withCwip = (cwip, ageMs = 5_000, over = {}) => ({ snapshot: { ...snap({ generatedAt: new Date(T0 - ageMs).toISOString() }), cwip }, stale: false, flawed: false, ...over });
  const open = { complete: false, pending: 37, parks: [] };
  assert.equal(cwipOpen(withCwip(open).snapshot), true);
  assert.equal(cwipOpen(withCwip({ complete: true, pending: 0, parks: [] }).snapshot), false);
  assert.equal(cwipOpen(withCwip({ error: 'x' }).snapshot), false, 'a section that could not be built is not "still loading"');
  assert.equal(cwipOpen(snap()), false, 'an older snapshot without the section');
  for (const manual of [false, true]) assert.deepEqual(decideRefresh({ got: withCwip(open), nowMs: T0, manual }), { run: true, continuing: true }, `manual ${manual}`);
  assert.equal(decideRefresh({ got: withCwip({ complete: true, pending: 0, parks: [] }), nowMs: T0, manual: true }).run, false, 'complete: the 10 minutes apply again');
  assert.equal(decideRefresh({ got: withCwip({ error: 'x' }), nowMs: T0, manual: false }).run, false);
  const stale = decideRefresh({ got: withCwip(open, 20 * 3600e3, { stale: true }), nowMs: T0, manual: false });
  assert.deepEqual(stale, { run: true }, 'an earlier day is an ordinary refresh, not a continuation');
  const flawed = decideRefresh({ got: withCwip(open, 5_000, { flawed: true, snapshot: { ...snap({ ok: false, generatedAt: new Date(T0 - 5_000).toISOString() }), cwip: open } }), nowMs: T0, manual: true });
  assert.equal(flawed.run, false, 'a failing run is still not repeated at once');
});

test('states and who may start the morning job', () => {
  assert.equal(stateOf(null), 'empty');
  assert.equal(stateOf({ stale: false, flawed: false }), 'fresh');
  assert.equal(stateOf({ stale: true, flawed: false }), 'stale');
  assert.equal(stateOf({ stale: false, flawed: true }), 'flawed');
  assert.equal(stateOf({ stale: true, flawed: true }), 'flawed');
  assert.equal(cronAllowed({ authorization: 'Bearer abc', secret: 'abc', production: true }), true);
  assert.equal(cronAllowed({ authorization: 'Bearer nope', secret: 'abc', production: true }), false);
  assert.equal(cronAllowed({ authorization: undefined, secret: 'abc', production: false }), false, 'with a secret set it is always required');
  assert.equal(cronAllowed({ authorization: undefined, secret: '', production: true }), false, 'on the web, no secret = closed');
  assert.equal(cronAllowed({ authorization: undefined, secret: '', production: false }), true, 'on your own computer it can be tried by hand');
});

test('settings are read from the environment; missing ones are noticed', () => {
  const s = readSettings({ ZOHO_ORG_ID: '1' });
  assert.equal(s.fy, '2025-26');
  assert.equal(s.zoho, null);
  assert.equal(s.redis, null);
  assert.equal(readSettings({ ...ENV, UPSTASH_REDIS_REST_TOKEN: 't', AUDIT_FY: '2026-27' }).fy, '2026-27');
});

test('first load of the day: empty -> refresh from Zoho -> fresh statements that balance and tie', { skip }, async () => {
  const { ctx, clients } = setup();
  assert.equal((await ctx.view()).state, 'empty');
  const r = await ctx.refresh({ manual: false });
  assert.equal(r.status, 'refreshed', r.message);
  assert.equal(clients.length, 1);
  const v = await ctx.view();
  assert.equal(v.state, 'fresh');
  assert.ok(Math.abs(v.statements.bs.gap) < 0.01);
  assert.equal(v.statements.tie.ok, 47);
  assert.equal(v.snapshot.meta.istDate, '2026-10-15');
  assert.deepEqual(Object.keys(await ctx.status()).sort(), ['canRefresh', 'generatedAt', 'ok', 'state']);
});

test('Refresh pressed twice: the second is refused; after 10 minutes it runs again using the journal cache', { skip }, async () => {
  const { ctx, clock, clients } = setup();
  await ctx.refresh({ manual: false });
  // update-20: on an empty cache the first load reads 100 of the 172 journals and bills behind CWIP / IAUD (update-22: the 35 bills first); the rest follows at once, not after 10 minutes
  assert.equal((await ctx.view()).snapshot.cwip.complete, false);
  const more = await ctx.refresh({ manual: false });
  assert.deepEqual([more.status, more.continued], ['refreshed', true], more.message);
  assert.equal((await ctx.view()).snapshot.cwip.complete, true);
  assert.equal(clients.length, 2);
  const again = await ctx.refresh({ manual: true });
  assert.equal(again.status, 'recent');
  assert.equal(clients.length, 2, 'Zoho was not called');
  clock.t += 11 * 60 * 1000;
  const later = await ctx.refresh({ manual: true });
  assert.equal(later.status, 'refreshed', later.message);
  assert.equal(later.continued, undefined);
  assert.equal(clients[2].stats.calls, 27 + 1 + 5 + 4 + 5 + 40 + 3 + 4 + 10 + 1 + 1, '(update-31: + the Trial Balance of last year) (update-30: + 1 ledger page of the two advance tax accounts) (update-28: + the fixed asset register (3 pages) and the ledger of Land / Development Rights, and the trial balance and profit and loss of the five subsidiaries) (update-27: + the three reads of the related parties: their sales, the ledger of their vendor cards and of six accounts) (update-25: + 1 ledger page of the two old accounts of JN-Clean-112 / 225) 1 trial balance + 1 aging + 8 ledger pages + 1 ledger page of the advance account + 1 ledger page of the deposit / PF accounts (update-15) + 1 ledger page of the CWIP and IAUD accounts (update-20) + 5 pages of the stock summary (update-17) + 4 ledger pages of Inventory Asset (update-18) + 5 pages of the item list (update-19) + 1 staff list + 5 ageing reports + 8 vendor balance summaries (2 dates x 4 requests of 50 vendors) + 40 vendor cards (the next 40 Vendor Codes); every journal comes from Redis');
});

test('update-20: the continuation reads only the journals still missing, finishes the CWIP tab, and two at the same moment make one run', { skip }, async () => {
  const { ctx, clients } = setup();
  await ctx.refresh({ manual: false });
  const [a, b] = await Promise.all([ctx.refresh({ manual: false }), ctx.refresh({ manual: false })]);
  assert.deepEqual([a.status, b.status].sort(), ['recent', 'refreshed'], 'one of the two runs, the other is told to wait');
  assert.equal(clients.length, 2);
  assert.equal(clients[1].cwipJournalCalls.length, 72, 'the 65 read before (after the 35 bills, update-22) are in Redis');
  assert.equal(clients[1].cwipBillCalls.length, 0, 'and so are the bills');
  const v = await ctx.view();
  assert.deepEqual([v.snapshot.cwip.complete, v.snapshot.cwip.pending, v.snapshot.meta.cwip.journalsFromCache, v.snapshot.meta.cwip.billsFromCache], [true, 0, 65, 35]);
  assert.equal(v.bookProblems, 0);
  const after = await ctx.refresh({ manual: false });
  assert.equal(after.status, 'recent', 'nothing left to continue: the ordinary rules apply');
  assert.equal(clients.length, 2);
});

test('the next morning the old snapshot is shown as "stale" until the new one is loaded', { skip }, async () => {
  const { ctx, clock } = setup();
  await ctx.refresh({ manual: false });
  clock.t += 24 * 3600 * 1000;
  const v = await ctx.view();
  assert.equal(v.state, 'stale');
  assert.equal(v.snapshot.meta.istDate, '2026-10-15');
  assert.equal(v.today, '2026-10-16');
  const r = await ctx.refresh({ manual: false });
  assert.equal(r.status, 'refreshed', r.message);
  assert.equal((await ctx.view()).state, 'fresh');
});

test('a failing Zoho call is reported plainly and is not retried at once', { skip }, async () => {
  const boom = { get: async () => { throw new Error('Zoho /reports/trialbalance failed: Invalid OAuth token (HTTP 401)'); }, stats: { calls: 0 }, orgId: '60038956413' };
  let created = 0;
  const { ctx, clock } = setup({ zohoFactory: () => { created++; return boom; } });
  const first = await ctx.refresh({ manual: true });
  assert.equal(first.status, 'failed');
  assert.match(first.message, /Invalid OAuth token/);
  const second = await ctx.refresh({ manual: true });
  assert.equal(second.status, 'recent');
  assert.equal(created, 1);
  clock.t += 3 * 60 * 1000;
  assert.equal((await ctx.refresh({ manual: true })).status, 'failed', 'after the cooldown it tries again');
  assert.equal((await ctx.view()).state, 'empty');
});

test('a snapshot with errors is shown, flagged, and a refresh is allowed after the cooldown', { skip }, async () => {
  const { ctx, clock, f } = setup();
  const good = await buildSnapshot({ zoho: replayZoho(), config: loadConfig('2025-26'), fy: '2025-26', now: () => clock.t });
  const cache = createCache(createUpstash({ url: ENV.UPSTASH_REDIS_REST_URL, token: f.token, fetchImpl: f.fetchImpl }), { org: ENV.ZOHO_ORG_ID, now: () => clock.t });
  await cache.putSnapshot({ ...good, meta: { ...good.meta, ok: false, errors: 2 } });
  assert.equal((await ctx.view()).state, 'flawed');
  assert.equal((await ctx.refresh({ manual: true })).status, 'recent');
  clock.t += 3 * 60 * 1000;
  const r = await ctx.refresh({ manual: true });
  assert.equal(r.status, 'refreshed', r.message);
  assert.equal((await ctx.view()).state, 'fresh');
});

test('without Redis the screen explains what to add; a saved file can still be viewed', { skip }, async () => {
  const none = createContext({ env: { ZOHO_ORG_ID: '1' } });
  const v = await none.view();
  assert.equal(v.state, 'error');
  assert.match(v.message, /UPSTASH_REDIS_REST_URL/);
  assert.equal((await none.refresh()).status, 'unavailable');

  const s = await buildSnapshot({ zoho: replayZoho(), config: loadConfig('2025-26'), fy: '2025-26', now: () => T0 });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'afs-')), 'snap.json');
  fs.writeFileSync(file, JSON.stringify(s));
  const viewer = createContext({ env: { ZOHO_ORG_ID: '1', AUDIT_FS_SNAPSHOT_FILE: file }, now: () => T0 });
  const fv = await viewer.view();
  assert.equal(fv.state, 'fresh');
  assert.equal(fv.canRefresh, false);
  assert.equal((await viewer.refresh()).status, 'unavailable');
});

test('Redis trouble becomes a message, not a crash', { skip }, async () => {
  const ctx = createContext({ env: { ...ENV, UPSTASH_REDIS_REST_TOKEN: 't' }, fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  const v = await ctx.view();
  assert.equal(v.state, 'error');
  assert.match(v.message, /Cannot reach Redis/);
  assert.equal((await ctx.status()).state, 'error');
});

test('the view carries the whole booklet and the 34 sheets, and a single sheet can be read by its id', { skip }, async () => {
  const { ctx } = setup();
  await ctx.refresh({ manual: false });
  const v = await ctx.view();
  assert.equal(v.state, 'fresh');
  assert.ok(v.books, v.booksError);
  assert.equal(v.books.notes.summary.check, 0);
  assert.equal(v.books.cashflow.checks.every((c) => c.status === 'OK'), true);
  assert.equal(v.workbook.summary.sheets, 34);
  assert.equal(v.bookProblems, 0);
  assert.equal(ctx.sheet('closing-stock').entry.sheet, 'Closing Stock');
  assert.equal(ctx.sheet('../mapping'), null);
});


test('update-29: the entries of the 483 assets are read 100 at a time: the first load, then continuations (a minute apart) until Dep.Calc. is complete, then the ordinary rules', { skip }, async () => {
  const { ctx, clock, clients } = setup({ historyBudget: 100 });
  const known = async () => (await ctx.view()).snapshot.register.history;
  await ctx.refresh({ manual: false });
  assert.deepEqual([(await known()).known, (await known()).complete], [100, false]);
  assert.equal((await ctx.view()).snapshot.cwip.complete, false, 'the CWIP tab is read in the same runs');
  const seen = [];
  for (let i = 0; i < 6; i += 1) {
    clock.t += 61_000; // the lock of a continuation lasts 60 seconds
    const r = await ctx.refresh({ manual: false });
    if (r.status !== 'refreshed') { seen.push(r.status); break; }
    assert.equal(r.continued, true, 'a continuation, not an ordinary refresh');
    seen.push((await known()).known);
  }
  assert.deepEqual(seen, [200, 300, 400, 483, 'recent'], 'four continuations, then nothing left to continue');
  const v = await ctx.view();
  assert.deepEqual([v.snapshot.register.history.complete, v.snapshot.cwip.complete, v.bookProblems], [true, true, 0]);
  assert.equal(clients.length, 5);
  assert.deepEqual(clients.map((c) => c.historyCalls.length), [100, 100, 100, 100, 83]);
  assert.equal(new Set(clients.flatMap((c) => c.historyCalls)).size, 483, 'no asset was read twice');
  assert.ok(v.snapshot.alerts.every((a) => a.code !== 'REGISTER_HISTORY_PARTIAL'), 'the notice is gone when all are read');
});
