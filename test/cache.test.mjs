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

test('snapshots: today first, else the newest good one marked stale; a bad run never replaces the good pointer', async () => {
  const { cache, f } = make();
  const snap = (date, ok, mark) => ({ meta: { fy: '2025-26', istDate: date, generatedAt: date + 'T00:00:00Z', ok }, mark });
  assert.equal(await cache.getSnapshot('2025-26', '2026-10-15'), null);

  await cache.putSnapshot(snap('2026-10-14', true, 'yesterday'));
  let got = await cache.getSnapshot('2025-26', '2026-10-15');
  assert.equal(got.stale, true);
  assert.equal(got.snapshot.mark, 'yesterday');

  await cache.putSnapshot(snap('2026-10-15', false, 'today-bad'));
  got = await cache.getSnapshot('2025-26', '2026-10-15');
  assert.equal(got.stale, false, "today's own (bad) run is what today shows");
  got = await cache.getSnapshot('2025-26', '2026-10-16');
  assert.equal(got.snapshot.mark, 'yesterday', 'tomorrow falls back to the last GOOD snapshot, not the bad one');

  await cache.putSnapshot(snap('2026-10-15', true, 'today-good'));
  got = await cache.getSnapshot('2025-26', '2026-10-16');
  assert.equal(got.snapshot.mark, 'today-good');
  // seven-day life
  f.clock.t += 8 * 24 * 3600 * 1000;
  assert.equal(await cache.getSnapshot('2025-26', '2026-10-23'), null);
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
