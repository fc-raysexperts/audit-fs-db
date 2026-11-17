import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createUpstash, createCache, CacheError, PREFIX, istDate } from '../lib/cache.mjs';
import { createZohoClient } from '../lib/zoho.mjs';
import { fakeUpstash } from '../testing/fakes.mjs';

const make = (opt = {}) => {
  const f = fakeUpstash(opt);
  const redis = createUpstash({ url: 'https://example.upstash.io/', token: f.token, fetchImpl: f.fetchImpl });
  const cache = createCache(redis, { org: '123', now: () => f.clock.t });
  return { f, redis, cache };
};

test('only audit-fs: keys and the four plain commands are allowed (the database is shared with the MIS dashboard)', async () => {
  const { redis, f } = make();
  await assert.rejects(redis.cmd(['GET', 'mis:today']), /must start with "audit-fs:"/);
  await assert.rejects(redis.cmd(['SET', 'other', 'x']), CacheError);
  for (const bad of ['FLUSHALL', 'FLUSHDB', 'KEYS', 'SCAN', 'EVAL']) await assert.rejects(redis.cmd([bad, PREFIX + 'x']), /not allowed/);
  assert.equal(f.log.length, 0, 'nothing may even reach Redis');
});

test('a wrong token gives a clear error that does not contain the token', async () => {
  const f = fakeUpstash();
  const redis = createUpstash({ url: 'https://example.upstash.io', token: 'not-the-token', fetchImpl: f.fetchImpl });
  await assert.rejects(redis.cmd(['GET', PREFIX + 'x']), (e) => e instanceof CacheError && /WRONGPASS/.test(e.message) && !e.message.includes('not-the-token'));
});

test('values round-trip: small, compressed and cut into parts', async () => {
  const { cache, f } = make();
  const small = { a: 1 };
  const medium = { rows: Array.from({ length: 3000 }, (_, i) => ({ i, name: 'Customer ' + i, amount: i * 1.5 })) };
  const huge = { blob: crypto.randomBytes(900_000).toString('base64') }; // does not compress -> must be split
  for (const [name, v] of [['small', small], ['medium', medium], ['huge', huge]]) {
    const w = await cache.putJSON(PREFIX + name, v, 100);
    assert.deepEqual(await cache.getJSON(PREFIX + name), v, name);
    if (name === 'small') assert.equal(f.store.get(PREFIX + name).value.startsWith('j:'), true);
    if (name === 'medium') assert.equal(f.store.get(PREFIX + name).value.startsWith('gz:'), true);
    if (name === 'huge') assert.ok(w.parts >= 2);
  }
  for (const [, e] of f.store) assert.ok(e.value.length <= 600_000, 'every Redis value stays under the request limit');
});

test('a part that has expired makes the value read as missing, never as half a value', async () => {
  const { cache, f } = make();
  await cache.putJSON(PREFIX + 'big', { blob: crypto.randomBytes(900_000).toString('base64') }, 100);
  f.store.delete(PREFIX + 'big#1');
  assert.equal(await cache.getJSON(PREFIX + 'big'), null);
  assert.equal(await cache.getJSON(PREFIX + 'nothing'), null);
});

test('snapshots: today first, else the newest GOOD one marked stale; a flawed run never hides a good snapshot', async () => {
  const { cache, f } = make();
  const snap = (date, ok, mark) => ({ meta: { fy: '2025-26', istDate: date, generatedAt: date + 'T00:00:00Z', ok }, mark });
  assert.equal(await cache.getSnapshot('2025-26', '2026-10-15'), null);

  // only a flawed snapshot exists: it is shown (flagged) rather than nothing
  let w = await cache.putSnapshot(snap('2026-10-14', false, 'flawed-only'));
  assert.deepEqual([w.kept, w.latestMoved], [false, false]);
  let got = await cache.getSnapshot('2025-26', '2026-10-14');
  assert.deepEqual([got.snapshot.mark, got.flawed, got.stale], ['flawed-only', true, false]);

  await cache.putSnapshot(snap('2026-10-14', true, 'yesterday'));
  got = await cache.getSnapshot('2025-26', '2026-10-15');
  assert.deepEqual([got.snapshot.mark, got.stale, got.flawed], ['yesterday', true, false]);

  await cache.putSnapshot(snap('2026-10-15', false, 'today-bad'));
  got = await cache.getSnapshot('2025-26', '2026-10-15');
  assert.equal(got.snapshot.mark, 'yesterday', "today's flawed run does not replace the last good snapshot on screen");

  await cache.putSnapshot(snap('2026-10-15', true, 'today-good'));
  got = await cache.getSnapshot('2025-26', '2026-10-15');
  assert.deepEqual([got.snapshot.mark, got.stale], ['today-good', false]);
  got = await cache.getSnapshot('2025-26', '2026-10-16');
  assert.deepEqual([got.snapshot.mark, got.stale], ['today-good', true]);

  // a later flawed run on the same day does not overwrite the good one
  w = await cache.putSnapshot(snap('2026-10-15', false, 'today-bad-again'));
  assert.deepEqual([w.kept, w.latestMoved], [true, false]);
  assert.equal((await cache.getSnapshot('2025-26', '2026-10-15')).snapshot.mark, 'today-good');

  // update-33: the daily copies live 7 days, but the page is never empty: the 400-day copy of the last good snapshot is shown (marked as an earlier day) until the new one is loaded
  f.clock.t += 8 * 24 * 3600 * 1000;
  got = await cache.getSnapshot('2025-26', '2026-10-23');
  assert.deepEqual([got.snapshot.mark, got.stale, got.flawed], ['today-good', true, false], 'a week and a day later: the last good statements, as an earlier day');
  f.clock.t += 400 * 24 * 3600 * 1000;
  assert.equal(await cache.getSnapshot('2025-26', '2027-11-26'), null, 'after more than a year nothing is left');
});

test('update-33: a damaged or expired layer is skipped for the next; only when nothing can be read the first problem is told', async () => {
  const { cache, f, redis } = make();
  const snap = (date, ok, mark) => ({ meta: { fy: '2025-26', istDate: date, generatedAt: date + 'T00:00:00Z', ok }, mark });
  await cache.putSnapshot(snap('2026-10-14', true, 'yesterday'));
  // the pointer's snapshot is damaged: the 400-day copy still answers
  await redis.cmd(['SET', cache.key.snapshot('2025-26', '2026-10-14'), 'garbage', 'EX', 1000]);
  const got = await cache.getSnapshot('2025-26', '2026-10-15');
  assert.deepEqual([got.snapshot.mark, got.stale], ['yesterday', true]);
  // Redis itself down: that is an error to tell, not an empty page
  const down = createCache(createUpstash({ url: 'https://x.upstash.io', token: 't', fetchImpl: async () => { throw new TypeError('fetch failed'); } }), { org: '123', now: () => f.clock.t });
  await assert.rejects(down.getSnapshot('2025-26', '2026-10-15'), /Cannot reach Redis/);
});

test('update-33: the record of the last attempt, and how long ago a lock was taken', async () => {
  const { cache, f } = make();
  assert.equal(await cache.getAttempt(), null);
  await cache.putAttempt({ at: 1, status: 'quota', message: 'm' });
  assert.deepEqual(await cache.getAttempt(), { at: 1, status: 'quota', message: 'm' });
  assert.equal(await cache.lockAge('refresh'), null, 'nobody holds it');
  assert.equal(await cache.acquireLock('refresh', 120), true);
  f.clock.t += 45_000;
  assert.equal(await cache.lockAge('refresh'), 45_000);
  f.clock.t += 80_000;
  assert.equal(await cache.lockAge('refresh'), null, 'it frees itself');
});

test('update-33: a Redis that does not answer ends in a plain message instead of waiting for ever', async () => {
  const slow = (url, init) => new Promise((_, reject) => { // like a real socket, the pending request keeps the process alive until the time limit cuts it
    const keep = setTimeout(() => {}, 2000);
    init.signal.addEventListener('abort', () => { clearTimeout(keep); reject(init.signal.reason); });
  });
  const redis = createUpstash({ url: 'https://x.upstash.io', token: 't', fetchImpl: slow, timeoutMs: 20 });
  await assert.rejects(redis.cmd(['GET', PREFIX + 'x']), /Redis did not answer within/);
});

test('lock: only one refresh at a time, and it frees itself', async () => {
  const { cache, f } = make();
  assert.equal(await cache.acquireLock('refresh', 60), true);
  assert.equal(await cache.acquireLock('refresh', 60), false);
  await cache.releaseLock('refresh');
  assert.equal(await cache.acquireLock('refresh', 60), true);
  f.clock.t += 61_000;
  assert.equal(await cache.acquireLock('refresh', 60), true, 'expired lock can be taken');
});

test('IST day: 18:30 UTC is already the next calendar day in India', () => {
  assert.equal(istDate(Date.parse('2026-10-14T18:29:59Z')), '2026-10-14');
  assert.equal(istDate(Date.parse('2026-10-14T18:30:00Z')), '2026-10-15');
});

test('the Zoho access token is shared through Redis: a second client does not ask Zoho for a new one', async () => {
  const { cache, f } = make();
  let tokenCalls = 0;
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes('/oauth/v2/token')) { tokenCalls++; return new Response(JSON.stringify({ access_token: 'AT', expires_in: 3600 }), { status: 200 }); }
    return new Response(JSON.stringify({ code: 0, ok: true }), { status: 200 });
  };
  const mk = () => createZohoClient({ clientId: 'c', clientSecret: 's', refreshToken: 'r', orgId: '123', fetchImpl, now: () => f.clock.t, tokenStore: cache.tokenStore });
  await mk().get('/organizations');
  await mk().get('/organizations'); // e.g. the next serverless invocation
  assert.equal(tokenCalls, 1);
  const ttl = f.store.get(cache.key.token());
  assert.ok(ttl.expiresAt - f.clock.t <= 3540_000 && ttl.expiresAt - f.clock.t >= 3500_000, 'stored for just under an hour');
  f.clock.t += 3600_000;
  await mk().get('/organizations');
  assert.equal(tokenCalls, 2, 'after an hour a new one is requested');
});
