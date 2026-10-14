import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createZohoClient, exchangeGrantCode, ZohoError } from '../lib/zoho.mjs';
import { parseEnv, setEnvVar, loadEnv } from '../scripts/envfile.mjs';

const SECRETS = { clientId: 'CID', clientSecret: 'SECRET-XYZ', refreshToken: 'REFRESH-ABC', orgId: '999' };
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

/** fake Zoho: token endpoint + api endpoint driven by queues */
function fake({ api = [], token = [] } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, opts });
    if (u.includes('/oauth/v2/token')) return token.length ? token.shift() : reply(200, { access_token: 'AT' + calls.length, expires_in: 3600 });
    return api.length ? api.shift() : reply(200, { code: 0, message: 'success' });
  };
  return { fetchImpl, calls };
}
const mk = (f, extra = {}) => createZohoClient({ ...SECRETS, fetchImpl: f.fetchImpl, sleep: async () => {}, ...extra });

test('access token is fetched once and reused; calls carry org id and the Zoho auth header', async () => {
  const f = fake();
  const z = mk(f);
  await z.get('/contacts', { per_page: 1 });
  await z.get('/journals');
  assert.equal(z.stats.tokenRefreshes, 1);
  const api = f.calls.filter((c) => !c.url.includes('/oauth/'));
  assert.ok(api[0].url.startsWith('https://www.zohoapis.in/books/v3/contacts?'));
  assert.ok(api[0].url.includes('organization_id=999') && api[0].url.includes('per_page=1'));
  assert.match(api[0].opts.headers.authorization, /^Zoho-oauthtoken AT/);
  assert.ok(f.calls[0].url.startsWith('https://accounts.zoho.in/oauth/v2/token'));
});

test('token is refreshed again after it expires; two simultaneous calls share one refresh', async () => {
  let t = 0;
  const f = fake();
  const z = mk(f, { now: () => t });
  await Promise.all([z.get('/a'), z.get('/b')]);
  assert.equal(z.stats.tokenRefreshes, 1);
  t += 3600 * 1000;
  await z.get('/c');
  assert.equal(z.stats.tokenRefreshes, 2);
});

test('query: objects are sent as JSON, undefined/null dropped', async () => {
  const f = fake();
  await mk(f).get('/reports/x', { rule: { a: 1 }, skip: undefined, none: null, n: 0 });
  const url = new URL(f.calls.at(-1).url);
  assert.equal(url.searchParams.get('rule'), '{"a":1}');
  assert.equal(url.searchParams.get('n'), '0');
  assert.equal(url.searchParams.has('skip') || url.searchParams.has('none'), false);
});

test('401 once -> token refreshed and call retried; a second 401 is an error', async () => {
  const f = fake({ api: [reply(401, { code: 57, message: 'You are not authorized' }), reply(200, { code: 0, ok: 1 })] });
  const z = mk(f);
  assert.equal((await z.get('/x')).ok, 1);
  assert.equal(z.stats.tokenRefreshes, 2);
  const f2 = fake({ api: [reply(401, { code: 57, message: 'nope' }), reply(401, { code: 57, message: 'nope' })] });
  await assert.rejects(mk(f2).get('/x'), (e) => e instanceof ZohoError && e.status === 401 && e.code === 57);
});

test('429 is retried with back-off, then gives up after maxRetries', async () => {
  const slept = [];
  const f = fake({ api: [reply(429, { code: 44 }), reply(429, { code: 44 }), reply(200, { code: 0, v: 1 })] });
  const z = mk(f, { sleep: async (ms) => { slept.push(ms); } });
  assert.equal((await z.get('/x')).v, 1);
  assert.deepEqual(slept, [2000, 4000]);
  assert.equal(z.stats.retries429, 2);
  const f2 = fake({ api: Array.from({ length: 10 }, () => reply(429, { code: 44, message: 'rate' })) });
  await assert.rejects(mk(f2, { maxRetries: 2 }).get('/x'), (e) => e.status === 429);
});

test('errors: HTTP 4xx with code/message and HTTP 200 with a non-zero code both raise ZohoError', async () => {
  await assert.rejects(mk(fake({ api: [reply(404, { code: 5, message: 'Invalid URL' })] })).get('/nope'), (e) => e.code === 5 && /Invalid URL/.test(e.message));
  await assert.rejects(mk(fake({ api: [reply(200, { code: 1002, message: 'does not exist' })] })).get('/x'), (e) => e.code === 1002);
  await assert.rejects(mk(fake({ api: [reply(200, 'not json')] })).get('/x'), /not JSON/);
});

test('bad credentials: token error (stage token) - and no secret ever appears in the message', async () => {
  const f = fake({ token: [reply(200, { error: 'invalid_client' })] });
  await assert.rejects(mk(f).get('/x'), (e) => {
    assert.equal(e.stage, 'token');
    for (const s of Object.values(SECRETS)) assert.ok(!e.message.includes(s) || s === '999', `secret leaked: ${s}`);
    return true;
  });
});

test('client refuses to start with a missing setting or unknown data centre', () => {
  assert.throws(() => createZohoClient({ ...SECRETS, refreshToken: '' }), /refreshToken/);
  assert.throws(() => createZohoClient({ ...SECRETS, dc: 'xx' }), /Unknown Zoho data centre/);
});

test('exchangeGrantCode returns the refresh token, or explains that the code is single-use', async () => {
  const ok = fake({ token: [reply(200, { access_token: 'a', refresh_token: 'RT', api_domain: 'https://www.zohoapis.in', expires_in: 3600, scope: 'ZohoBooks.contacts.READ' })] });
  const r = await exchangeGrantCode({ clientId: 'c', clientSecret: 's', code: 'k', fetchImpl: ok.fetchImpl });
  assert.equal(r.refreshToken, 'RT');
  assert.ok(ok.calls[0].opts.body.toString().includes('grant_type=authorization_code'));
  const bad = fake({ token: [reply(200, { error: 'invalid_code' })] });
  await assert.rejects(exchangeGrantCode({ clientId: 'c', clientSecret: 's', code: 'k', fetchImpl: bad.fetchImpl }), /single-use/);
});

test('.env helper: parse, replace a line, append a missing one', () => {
  assert.deepEqual(parseEnv('# c\nA=1\nB = "two"\n\nC=\n'), { A: '1', B: 'two', C: '' });
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'env-')), '.env');
  fs.writeFileSync(f, 'ZOHO_DC=in\nZOHO_REFRESH_TOKEN=\n');
  setEnvVar(f, 'ZOHO_REFRESH_TOKEN', 'abc');
  setEnvVar(f, 'NEW', 'x');
  assert.deepEqual(loadEnv(f), { ZOHO_DC: 'in', ZOHO_REFRESH_TOKEN: 'abc', NEW: 'x' });
});
