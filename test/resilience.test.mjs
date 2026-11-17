// update-33: the site must open every day, whatever happened in between. These tests are about what used to end in "The update is taking longer than usual. Reload this page in a minute."
//   * no call to Zoho or Redis can hang; a run ends inside its time limit; Zoho's request limit stops a run at once instead of costing 30 seconds a call
//   * a run that is cut short has saved what it read, and the next run goes on (a chain of short runs finishes a cold start)
//   * the last good statements are always there; the screen can say the REAL reason; a killed run does not block everybody for 10 minutes
import test from 'node:test';
import assert from 'node:assert/strict';
import { createZohoClient, ZohoError, RunTimeUp } from '../lib/zoho.mjs';
import { createContext, decideRefresh, publicAttempt, REFRESH_LOCK_S, QUOTA_RETRY_MS, MAX_PARTIAL_CHAIN } from '../lib/server.mjs';
import { createUpstash, createCache } from '../lib/cache.mjs';
import { fetchCwipBills, fetchJournalsBudget, fetchVendorCodes, fetchAssetHistories, MIN_EACH_RUN } from '../lib/zohoData.mjs';
import { refreshSnapshot } from '../lib/snapshot.mjs';
import { loadConfig } from '../lib/config.mjs';
import { fakeUpstash, replayZoho, haveFixtures, J } from '../testing/fakes.mjs';

const skip = !haveFixtures();
const T0 = Date.parse('2026-11-17T09:00:00+05:30');
const ENV = { ZOHO_ORG_ID: '60038956413', ZOHO_CLIENT_ID: 'id', ZOHO_CLIENT_SECRET: 'secret', ZOHO_REFRESH_TOKEN: 'refresh', UPSTASH_REDIS_REST_URL: 'https://x.upstash.io' };
const SECRETS = { clientId: 'CID', clientSecret: 'SECRET-XYZ', refreshToken: 'REFRESH-ABC', orgId: '999' };
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
/** a request that never answers (like a real socket) until its time limit cuts it */
const hangs = (init) => new Promise((_, reject) => { const keep = setTimeout(() => {}, 5000); init.signal.addEventListener('abort', () => { clearTimeout(keep); reject(init.signal.reason); }); });

// ---------- the Zoho client ----------

test('update-33: a call to Zoho that does not answer ends after its time limit (one more try), in plain words - it never hangs', async () => {
  let api = 0;
  const fetchImpl = async (url, init) => {
    if (String(url).includes('/oauth/')) return reply(200, { access_token: 'AT', expires_in: 3600 });
    api += 1;
    return hangs(init);
  };
  const z = createZohoClient({ ...SECRETS, fetchImpl, sleep: async () => {}, timeoutMs: 30 });
  await assert.rejects(z.get('/reports/trialbalance'), (e) => e instanceof ZohoError && e.code === 'TIMEOUT' && e.stage === 'timeout' && /did not answer within/.test(e.message));
  assert.equal(api, 2, 'asked, then once more');
  assert.equal(z.stats.timeouts, 2);
});

test('update-33: a Zoho that is unreachable is a ZohoError with the reason, and the sign-in server has a time limit too', async () => {
  const down = createZohoClient({ ...SECRETS, fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'EAI_AGAIN' } }); }, sleep: async () => {} });
  await assert.rejects(down.get('/x'), (e) => e instanceof ZohoError && e.stage === 'token' && /EAI_AGAIN/.test(e.message));
  const slowToken = createZohoClient({ ...SECRETS, fetchImpl: (url, init) => hangs(init), sleep: async () => {}, timeoutMs: 30 });
  await assert.rejects(slowToken.get('/x'), (e) => e.stage === 'token' && /sign-in server did not answer/.test(e.message));
});

test('update-33: the hard deadline refuses further calls with RunTimeUp (not a ZohoError), the soft one only says "no new optional reads"', async () => {
  let t = 0;
  const calls = [];
  const fetchImpl = async (url) => { calls.push(String(url)); return String(url).includes('/oauth/') ? reply(200, { access_token: 'AT', expires_in: 3600 }) : reply(200, { code: 0, ok: 1 }); };
  const z = createZohoClient({ ...SECRETS, fetchImpl, sleep: async () => {}, now: () => t });
  assert.equal(z.timeLeft(), Infinity, 'without a deadline nothing is limited');
  z.setDeadline({ softMs: 35_000, hardMs: 50_000 });
  assert.equal(z.timeLeft(), 35_000);
  await z.get('/a');
  t = 36_000;
  assert.equal(z.timeLeft() <= 0, true);
  assert.equal((await z.get('/b')).ok, 1, 'after the soft deadline a call that is asked for still goes through (the statements need them)');
  t = 51_000;
  const n = calls.length;
  await assert.rejects(z.get('/c'), (e) => e instanceof RunTimeUp && !(e instanceof ZohoError) && e.code === 'RUN_TIME_UP');
  assert.equal(calls.length, n, 'and nothing was sent');
});

test('update-33: a back-off that would pass the hard deadline is not slept: the run stops at once', async () => {
  let t = 0;
  const slept = [];
  const fetchImpl = async (url) => (String(url).includes('/oauth/') ? reply(200, { access_token: 'AT', expires_in: 3600 }) : reply(429, { code: 44, message: 'rate' }));
  const z = createZohoClient({ ...SECRETS, fetchImpl, now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; } });
  z.setDeadline({ hardMs: 5_000 });
  await assert.rejects(z.get('/x'), (e) => e instanceof RunTimeUp);
  assert.deepEqual(slept, [2000], 'the 2 s back-off was slept, the 4 s one would have gone past the 5 s deadline');
});

test('update-33: when Zoho keeps refusing with 429 after the back-off, the client stops asking for the rest of the run - no 30 seconds of sleeping per call', async () => {
  let api = 0;
  const slept = [];
  const fetchImpl = async (url) => { if (String(url).includes('/oauth/')) return reply(200, { access_token: 'AT', expires_in: 3600 }); api += 1; return reply(429, { code: 44, message: 'too many requests' }); };
  const z = createZohoClient({ ...SECRETS, fetchImpl, sleep: async (ms) => { slept.push(ms); }, maxRetries: 2 });
  assert.equal(z.quotaHit(), null);
  await assert.rejects(z.get('/a'), (e) => e.status === 429 && e.stage === 'quota');
  assert.equal(api, 3, 'first try + 2 retries');
  assert.ok(z.quotaHit());
  await assert.rejects(z.get('/b'), (e) => e instanceof ZohoError && e.status === 429 && e.code === 'RATE_LIMIT' && /request limit was reached earlier in this run/.test(e.message));
  await assert.rejects(z.get('/c'), (e) => e.status === 429);
  assert.equal(api, 3, 'the later calls never left');
  assert.deepEqual(slept, [2000, 4000], 'and nothing more was slept');
});

// ---------- the optional readers stop at the soft deadline ----------

test('update-33: the CWIP, asset and vendor readers leave the rest for the next run when the soft deadline has come - after a few reads every run, so it always gets somewhere', { skip }, async () => {
  const f = fakeUpstash();
  const cache = createCache(createUpstash({ url: 'https://x.upstash.io', token: f.token, fetchImpl: f.fetchImpl }), { org: '1', now: () => f.clock.t });
  const late = (inner) => ({ ...inner, timeLeft: () => 0, quotaHit: () => null }); // the soft deadline has already passed
  // asset histories (twelve assets of the real register)
  const ids = J('fixtures/register_fy26.json').assets.slice(0, 12).map((a) => a[0]);
  const h = await fetchAssetHistories(late(replayZoho()), ids, { cache, concurrency: 1, chunk: 1 });
  assert.equal(h.timedOut, true);
  assert.equal(h.fetched, MIN_EACH_RUN, 'the minimum of every run is read');
  assert.equal(h.pending.length, 12 - MIN_EACH_RUN, 'the rest is left for the next run');
  assert.equal(h.stopped, null);
  // vendor cards
  const card = { stats: { calls: 0 }, get: async (p) => ({ code: 0, contact: { contact_id: p.split('/').pop(), contact_type: 'vendor', cf_vendor_code: `C-${p.split('/').pop()}` } }) };
  const v = await fetchVendorCodes(late(card), Array.from({ length: 10 }, (_, i) => String(100 + i)), { cache, concurrency: 1 });
  assert.deepEqual([v.timedOut, v.fetched, v.pending.length, v.stopped], [true, MIN_EACH_RUN, 10 - MIN_EACH_RUN, null], 'running out of time is not "Zoho refused"');
  // the journals behind CWIP (budgeted) and its bills
  let reads = 0;
  const journalZoho = late({ get: async () => { reads += 1; return { code: 0, journal: { entry_number: 'J', line_items: [] } }; }, stats: { calls: 0 } });
  const j = await fetchJournalsBudget(journalZoho, ['1', '2', '3', '4', '5', '6', '7', '8', '9'], { cache: null, concurrency: 1 });
  assert.equal(reads, MIN_EACH_RUN);
  assert.deepEqual(j.pending, ['7', '8', '9']);
  const billZoho = late({ get: async (p) => ({ code: 0, bill: { bill_id: p.split('/').pop(), bill_number: 'B', line_items: [] } }), stats: { calls: 0 } });
  const cb = await fetchCwipBills(billZoho, ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8'], { cache: null, concurrency: 1, budget: 100 });
  assert.equal(cb.timedOut, true);
  assert.equal(cb.fetched + Object.keys(cb.failed).length, MIN_EACH_RUN, 'six were tried (a bill the fake cannot shape counts as failed), then it stopped');
  assert.equal(cb.pending.length, 8 - MIN_EACH_RUN);
  // with time left nothing is cut
  const free = await fetchVendorCodes({ ...card, timeLeft: () => Infinity }, ['201', '202', '203', '204', '205', '206', '207', '208'], { cache: null, concurrency: 1 });
  assert.deepEqual([free.timedOut, free.fetched], [false, 8]);
});

test('update-33: RunTimeUp inside an optional reader ends that reader quietly (what was read is kept); inside the statements themselves it ends the run', async () => {
  const stopAfter = (n, extra = {}) => { let c = 0; return { stats: { calls: 0 }, get: async () => { c += 1; if (c > n) throw new RunTimeUp('hard'); return { code: 0, contact: { contact_id: 'x', cf_vendor_code: 'C' } }; }, ...extra }; };
  const v = await fetchVendorCodes(stopAfter(1), ['11', '12', '13'], { cache: null, concurrency: 1 });
  assert.deepEqual([v.fetched, v.timedOut, v.failed.length], [1, true, 0]);
});

// ---------- refreshSnapshot ----------

test('update-33: a run that reaches its hard deadline saves nothing, releases the lock and says "partial"; one that met Zoho\'s request limit saves nothing and says "quota"', async () => {
  const f = fakeUpstash();
  const cache = createCache(createUpstash({ url: 'https://x.upstash.io', token: f.token, fetchImpl: f.fetchImpl }), { org: '1', now: () => f.clock.t });
  const config = { settings: { run_soft_seconds: 35, run_hard_seconds: 50 } };
  let deadline = null;
  const late = { get: async () => { throw new RunTimeUp('too late'); }, stats: { calls: 0 }, orgId: '1', setDeadline: (d) => { deadline = d; } };
  const a = await refreshSnapshot({ zoho: late, cache, config, fy: '2025-26', now: () => f.clock.t });
  assert.equal(a.partial, true);
  assert.deepEqual(deadline, { softMs: 35_000, hardMs: 50_000 }, 'the limits come from config/settings.json');
  assert.equal(await cache.lockAge('refresh'), null, 'the lock is free again');
  assert.equal(await cache.getSnapshot('2025-26', '2026-11-17'), null, 'nothing was saved');
  const limited = { get: async () => { throw new ZohoError('Zoho /x failed: rate (HTTP 429)', { status: 429, stage: 'quota' }); }, stats: { calls: 0 }, orgId: '1' };
  const b = await refreshSnapshot({ zoho: limited, cache, config, fy: '2025-26', now: () => f.clock.t });
  assert.equal(b.quota, true);
  assert.equal(await cache.lockAge('refresh'), null);
});

// ---------- the server ----------

function setup(zohoFactory, extra = {}) {
  const clock = { t: T0 };
  const f = fakeUpstash({ clock });
  const made = [];
  const ctx = createContext({
    env: { ...ENV, UPSTASH_REDIS_REST_TOKEN: f.token }, now: () => clock.t, fetchImpl: f.fetchImpl,
    zohoFactory: () => { const z = zohoFactory(made.length); made.push(z); return z; },
    configLoader: (fy) => { const c = loadConfig(fy); return { ...c, settings: { ...c.settings, register_history_budget: extra.historyBudget ?? 1000 } }; },
  });
  return { clock, f, ctx, made };
}

/** the replay of Zoho's saved answers, but with the time limits of a real run: it is cut after `hard` calls, and the optional readers are told to stop after `soft` */
function timeLimited(hard, soft = hard - 20) {
  return () => {
    const base = replayZoho();
    let n = 0;
    return { ...base, get: async (...a) => { n += 1; if (n > hard) throw new RunTimeUp('hard deadline'); return base.get(...a); }, setDeadline() {}, timeLeft: () => (n >= soft ? 0 : Infinity), quotaHit: () => null };
  };
}

async function chain({ hard, soft, historyBudget = 120, label }) {
  const { ctx, clock, made } = setup(timeLimited(hard, soft), { historyBudget });
  const seen = [];
  let guard = 0;
  for (;;) {
    guard += 1;
    assert.ok(guard < 40, `${label}: it must finish`);
    clock.t += 61_000;
    const r = await ctx.refresh({ manual: false });
    seen.push(r.status);
    if (r.status === 'refreshed' && !r.more) break;
    assert.ok(['partial', 'refreshed'].includes(r.status), `${label}: ${r.status}: ${r.message}`);
    assert.equal(r.retryInSeconds, 60, 'it says when to come back');
  }
  return { ctx, seen, made };
}

test('update-33: a cold start on an empty Redis finishes as a chain of short runs, each saving what it read - the page is not stuck', { skip }, async () => {
  // a run of 150 calls: the statements themselves fit, the optional readers (CWIP, asset histories) are stopped by the soft deadline and go on in the next runs
  const a = await chain({ hard: 150, soft: 130, label: 'optional parts cut' });
  assert.ok(a.seen.filter((x) => x === 'refreshed').length > 2, 'several continuations of the optional parts');
  for (const x of [a]) {
    const v = await x.ctx.view();
    assert.equal(v.state, 'fresh');
    assert.equal(v.bookProblems, 0);
    assert.equal(v.snapshot.cwip.complete, true);
    assert.equal(v.snapshot.register.history.complete, true);
    const st = await x.ctx.status();
    assert.deepEqual([st.state, st.more, st.running, st.lastAttempt.status], ['fresh', false, null, 'refreshed']);
  }
  // a run of only 110 calls: even the statements themselves (about 130 reads on an empty Redis) do not fit; the first run is cut at the hard deadline ('partial') and saved what it read
  const b = await chain({ hard: 110, soft: 90, label: 'statements cut' });
  assert.ok(b.seen.includes('partial'), `the first runs were cut short: ${b.seen.join(', ')}`);
  const v = await b.ctx.view();
  assert.deepEqual([v.state, v.bookProblems, v.snapshot.cwip.complete, v.snapshot.register.history.complete], ['fresh', 0, true, true]);
});

test('update-33: Zoho\'s request limit stops the run at once; the earlier statements stay on screen; nobody asks again for 10 minutes; then it tries again', { skip }, async () => {
  const good = setup(() => replayZoho());
  await good.ctx.refresh({ manual: false });
  assert.equal((await good.ctx.view()).state, 'fresh');
  // the next morning Zoho answers 429
  good.clock.t += 24 * 3600 * 1000;
  let asked = 0;
  const limited = () => { asked += 1; return { get: async () => { throw new ZohoError('Zoho /reports/trialbalance failed: too many requests (HTTP 429)', { status: 429, stage: 'quota' }); }, stats: { calls: 0 }, orgId: '60038956413' }; };
  const ctx2 = createContext({ env: { ...ENV, UPSTASH_REDIS_REST_TOKEN: good.f.token }, now: () => good.clock.t, fetchImpl: good.f.fetchImpl, zohoFactory: limited });
  const r = await ctx2.refresh({ manual: false });
  assert.equal(r.status, 'quota');
  assert.match(r.message, /request limit was reached.*shared with every other dashboard.*statements already saved stay on screen.*next try is possible at/);
  assert.equal(r.retryInSeconds, QUOTA_RETRY_MS / 1000);
  const v = await ctx2.view();
  assert.equal(v.state, 'stale', 'the last good statements are still shown');
  assert.equal(v.lastAttempt.status, 'quota');
  assert.equal(v.closed, true, 'FY 2025-26 is over');
  // asked again soon: no call to Zoho at all, and the answer says why and until when
  good.clock.t += 3 * 60_000;
  const again = await ctx2.refresh({ manual: true });
  assert.equal(again.status, 'quota');
  assert.match(again.message, /no new update was started/);
  assert.equal(asked, 1, 'Zoho was not asked');
  assert.equal(again.retryInSeconds, 420);
  // after the 10 minutes it tries again
  good.clock.t += 8 * 60_000;
  assert.equal((await ctx2.refresh({ manual: true })).status, 'quota');
  assert.equal(asked, 2);
});

test('update-33: a failed attempt is written down with its real reason, and the page can read it (view and status)', { skip }, async () => {
  const boom = () => ({ get: async () => { throw new ZohoError('Zoho refused to give an access token (invalid_code).', { stage: 'token' }); }, stats: { calls: 0 }, orgId: '1' });
  const { ctx, clock } = setup(boom);
  const r = await ctx.refresh({ manual: false });
  assert.equal(r.status, 'failed');
  const v = await ctx.view();
  assert.equal(v.state, 'empty');
  assert.match(v.lastAttempt.message, /invalid_code/);
  assert.equal(v.lastAttempt.kind, 'auto');
  assert.deepEqual(Object.keys(v.lastAttempt).sort(), ['at', 'calls', 'chain', 'durationMs', 'finishedAt', 'kind', 'message', 'retryAt', 'status']);
  clock.t += 5_000;
  const s = await ctx.status();
  assert.match(s.lastAttempt.message, /invalid_code/);
  assert.equal(JSON.stringify(s).includes('secret'), false, 'nothing secret in the status');
});

test('update-33: a run the host killed does not keep everybody out for 10 minutes - its lock is gone after 2 minutes, and the status says an update is running while it lasts', { skip }, async () => {
  const { ctx, clock, f } = setup(() => replayZoho());
  const cache = createCache(createUpstash({ url: 'https://x.upstash.io', token: f.token, fetchImpl: f.fetchImpl }), { org: ENV.ZOHO_ORG_ID, now: () => clock.t });
  assert.equal(await cache.acquireLock('refresh', REFRESH_LOCK_S), true, 'a run started and was killed: it never released its lock');
  clock.t += 40_000;
  assert.deepEqual((await ctx.status()).running, { forSeconds: 40 });
  const busy = await ctx.refresh({ manual: false });
  assert.equal(busy.status, 'busy');
  assert.match(busy.message, /Another update is running \(started 40 s ago\)/);
  assert.equal(busy.running, true);
  clock.t += 3 * 60_000;
  assert.equal((await ctx.status()).running, null);
  const r = await ctx.refresh({ manual: false });
  assert.equal(r.status, 'refreshed', r.message);
});

test('update-33: after a long break the page shows the last good statements (an earlier day) instead of nothing, then catches up', { skip }, async () => {
  const { ctx, clock } = setup(() => replayZoho());
  await ctx.refresh({ manual: false });
  clock.t += 60 * 24 * 3600 * 1000; // two months: the daily copies and the pointer are long gone
  const v = await ctx.view();
  assert.equal(v.state, 'stale');
  assert.equal(v.snapshot.meta.istDate, '2026-11-17');
  assert.equal(v.today, '2027-01-16');
  assert.ok(v.statements && Math.abs(v.statements.bs.gap) < 0.01, 'the statements are all there');
  const r = await ctx.refresh({ manual: false });
  assert.equal(r.status, 'refreshed', r.message);
  assert.equal((await ctx.view()).state, 'fresh');
});

// ---------- the rules ----------

test('update-33: decideRefresh knows what the last attempt left behind', () => {
  const now = T0;
  const freshOpen = { snapshot: { meta: { generatedAt: new Date(now - 3600e3).toISOString(), ok: true } }, stale: false, flawed: false };
  assert.equal(decideRefresh({ got: freshOpen, nowMs: now, manual: false }).run, false, 'nothing to do');
  const partial = { status: 'partial', at: now - 70_000, finishedAt: now - 60_000, chain: 2 };
  assert.deepEqual(decideRefresh({ got: freshOpen, nowMs: now, manual: false, last: partial }), { run: true, continuing: true }, 'a cut-short run is continued, even though today is loaded');
  assert.deepEqual(decideRefresh({ got: null, nowMs: now, manual: false, last: partial }), { run: true, continuing: true });
  assert.equal(decideRefresh({ got: freshOpen, nowMs: now, manual: false, last: { ...partial, finishedAt: now - 20 * 60_000 } }).run, false, 'not after 15 minutes');
  assert.equal(decideRefresh({ got: freshOpen, nowMs: now, manual: false, last: { ...partial, chain: MAX_PARTIAL_CHAIN } }).run, false, 'and not for ever');
  const quota = { status: 'quota', at: now - 60_000, retryAt: now + 9 * 60_000 };
  const blocked = decideRefresh({ got: null, nowMs: now, manual: false, last: quota });
  assert.deepEqual([blocked.run, blocked.blocked, blocked.retryAt], [false, 'quota', quota.retryAt]);
  assert.match(blocked.message, /request limit was reached/);
  assert.equal(decideRefresh({ got: null, nowMs: now + 10 * 60_000, manual: false, last: quota }).run, true, 'after retryAt it runs again');
  assert.match(decideRefresh({ got: freshOpen, nowMs: now, manual: false, last: quota }).message, /already loaded/, "today's statements are loaded: that is the answer, not the quota");
  assert.equal(publicAttempt(null), null);
});
