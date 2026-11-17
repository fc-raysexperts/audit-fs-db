// update-33: the browser side of an update (app/components/refreshClient.js): it must wait as long as the server says, show the real reason, and never end with "Reload this page in a minute".
import test from 'node:test';
import assert from 'node:assert/strict';
import { driveRefresh, requestRefresh, readStatus } from '../app/components/refreshClient.js';

/** a fake browser fetch: /api/refresh answers from a queue, /api/status from another */
function browser({ refresh = [], status = [] } = {}) {
  const asked = { refresh: [], status: 0 };
  const json = (body, ok = true, code = 200) => ({ ok, status: code, json: async () => body });
  const fetchImpl = async (url, init) => {
    if (url === '/api/refresh') { asked.refresh.push(JSON.parse(init.body)); const next = refresh.shift(); if (next instanceof Error) throw next; return next?.http ? json(next.body, false, next.http) : json(next ?? { status: 'failed', message: 'queue empty' }); }
    asked.status += 1;
    return json(status.length > 1 ? status.shift() : status[0] ?? {});
  };
  return { fetchImpl, asked };
}
const slept = [];
const run = (b, extra = {}) => {
  const notes = [];
  const updated = [];
  return driveRefresh({ fetchImpl: b.fetchImpl, sleep: async (ms) => { slept.push(ms); }, now: () => 1_000_000, onNote: (n) => notes.push(n), onUpdated: (r) => updated.push(r), ...extra }).then((out) => ({ out, notes, updated }));
};

test('a normal load: one request, the page is told to refresh, done', async () => {
  const b = browser({ refresh: [{ status: 'refreshed', message: 'Loaded', more: false }] });
  const { out, notes, updated } = await run(b);
  assert.equal(out.done, true);
  assert.equal(updated.length, 1);
  assert.equal(notes.at(-1).kind, 'ok');
  assert.deepEqual(b.asked.refresh, [{ manual: false }]);
});

test('a load in parts: it waits as long as the server says (a minute), asks again, and does not give up', async () => {
  slept.length = 0;
  const b = browser({ refresh: [
    { status: 'partial', message: 'Part 1 is done: 90 reads were saved before this run reached its time limit.', more: true, retryInSeconds: 60 },
    { status: 'refreshed', more: true, retryInSeconds: 60 },
    { status: 'refreshed', more: false },
  ] });
  const { out, notes, updated } = await run(b);
  assert.equal(out.done, true);
  assert.equal(b.asked.refresh.length, 3);
  assert.equal(slept.filter((ms) => ms === 1000).length, 120, 'two waits of 60 one-second steps');
  assert.equal(updated.length, 2, 'the page refreshed after each saved part');
  assert.ok(notes.some((n) => n.until && /Continuing/.test(n.text)), 'with a countdown');
  assert.ok(notes.every((n) => !/Reload this page/.test(n.text ?? '')));
});

test('another update is running: it watches the status instead of giving up after 96 seconds, and ends when the statements appear', async () => {
  slept.length = 0;
  const b = browser({
    refresh: [{ status: 'busy', running: true, retryInSeconds: 15, message: 'Another update is running (started 20 s ago). The screen updates when it finishes.' }],
    status: [{ generatedAt: null, running: { forSeconds: 25 }, more: false }, { generatedAt: '2026-11-17T10:00:00Z', running: null, more: false }],
  });
  const { out, notes, updated } = await run(b, { getGeneratedAt: () => null });
  assert.equal(out.done, true);
  assert.equal(updated.length, 1);
  assert.match(notes.find((n) => n.kind === 'working' && /Another update is running/.test(n.text)).text, /started 20 s ago/);
  assert.equal(b.asked.status, 2);
});

test('an answer that is not a wait ("loaded 3 min ago") is shown as it is, and ends', async () => {
  const b = browser({ refresh: [{ status: 'recent', message: 'Loaded 3 min ago. To protect the shared Zoho quota, Refresh works again after 7 min.' }] });
  const { out, notes } = await run(b, { manual: true });
  assert.equal(out.done, true);
  assert.deepEqual([notes.at(-1).kind, notes.at(-1).text], ['info', 'Loaded 3 min ago. To protect the shared Zoho quota, Refresh works again after 7 min.']);
  assert.deepEqual(b.asked.refresh, [{ manual: true }]);
});

test("Zoho's request limit: the real reason is shown, the page waits for the time the server names and tries again; the Refresh button only reports it", async () => {
  slept.length = 0;
  const quota = { status: 'quota', retryInSeconds: 600, message: "Zoho's request limit was reached, so this update was stopped. The next try is possible at 17 Nov 2026, 3:40 pm." };
  const b = browser({ refresh: [quota, { status: 'refreshed', more: false }] });
  const { out, notes } = await run(b);
  assert.equal(out.done, true);
  assert.equal(slept.filter((ms) => ms === 1000).length, 600);
  assert.match(notes.find((n) => n.until).text, /request limit was reached.*tries again by itself in/);
  const b2 = browser({ refresh: [quota] });
  const manual = await run(b2, { manual: true });
  assert.equal(manual.out.done, false);
  assert.equal(manual.notes.at(-1).kind, 'problem');
  assert.match(manual.notes.at(-1).text, /request limit was reached/);
  assert.equal(b2.asked.refresh.length, 1, 'the button does not wait ten minutes');
});

test("a failure that waiting cannot cure is shown in the server's own words, once", async () => {
  const b = browser({ refresh: [{ status: 'failed', message: 'Zoho refused to give an access token (invalid_code). Check client id / secret / refresh token and the data centre (in).' }] });
  const { out, notes } = await run(b);
  assert.equal(out.done, false);
  assert.deepEqual([notes.at(-1).kind, notes.at(-1).text], ['problem', 'Zoho refused to give an access token (invalid_code). Check client id / secret / refresh token and the data centre (in).']);
  assert.equal(b.asked.refresh.length, 1);
});

test('the hosting stopping a request (HTTP 504 without an answer) is told as that; no network is told as that', async () => {
  const gateway = browser({ refresh: [{ http: 504, body: {} }] });
  assert.match((await requestRefresh(false, { fetchImpl: gateway.fetchImpl })).message, /HTTP 504.*took too long/);
  const offline = browser({ refresh: [new TypeError('fetch failed')] });
  assert.match((await requestRefresh(false, { fetchImpl: offline.fetchImpl })).message, /Could not reach the server/);
  assert.equal(await readStatus({ fetchImpl: async () => { throw new Error('x'); } }), null);
});

test('several banners (one per tab you open) share one request instead of starting one each', async () => {
  let n = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const fetchImpl = async () => { n += 1; await gate; return { ok: true, status: 200, json: async () => ({ status: 'refreshed', more: false }) }; };
  const a = requestRefresh(false, { fetchImpl });
  const b = requestRefresh(false, { fetchImpl });
  release();
  assert.deepEqual(await Promise.all([a, b]), [{ status: 'refreshed', more: false }, { status: 'refreshed', more: false }]);
  assert.equal(n, 1);
});

test('leaving the page ends the job at once, and a job that never finishes stops after its limit with a way forward', async () => {
  let cancelled = false;
  const b = browser({ refresh: [{ status: 'refreshed', more: true, retryInSeconds: 60 }] });
  const out = await driveRefresh({ fetchImpl: b.fetchImpl, sleep: async () => { cancelled = true; }, isCancelled: () => cancelled, onNote: () => {} });
  assert.equal(out.cancelled, true);
  const endless = browser({ refresh: Array.from({ length: 5 }, () => ({ status: 'refreshed', more: true, retryInSeconds: 1 })) });
  const notes = [];
  const done = await driveRefresh({ fetchImpl: endless.fetchImpl, sleep: async () => {}, onNote: (x) => notes.push(x), maxRuns: 3 });
  assert.equal(done.done, false);
  assert.match(notes.at(-1).text, /Open "Update status".*Try again/);
});
