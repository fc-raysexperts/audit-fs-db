// Minimal Zoho Books API client (read-only use). No dependencies; uses the global fetch of Node 18+ / Vercel.
//
// Auth: Zoho "Self Client" -> one long-lived REFRESH TOKEN -> short-lived (1 hour) access tokens.
// Facts that shape this file (from Zoho / integration guides; confirm in the check script on first run):
//   * at most 10 access tokens may be generated from one refresh token in any 10 minutes -> the access token MUST be cached
//     (in memory here; pass `tokenStore` to share it through Redis on serverless hosting);
//   * the API allows ~100 calls / minute / organization and a DAILY quota by plan (shared by ALL apps using the org);
//     HTTP 429 means "slow down" -> we back off and retry a few times;
//   * errors come as HTTP 4xx with {code, message}; a few come as HTTP 200 with code != 0 -> both are treated as errors.
// Secrets (client secret, refresh token, access token) are never put into error messages or logs.

export const DATA_CENTERS = {
  in: { accounts: 'https://accounts.zoho.in', api: 'https://www.zohoapis.in/books/v3' },
  com: { accounts: 'https://accounts.zoho.com', api: 'https://www.zohoapis.com/books/v3' },
  eu: { accounts: 'https://accounts.zoho.eu', api: 'https://www.zohoapis.eu/books/v3' },
  'com.au': { accounts: 'https://accounts.zoho.com.au', api: 'https://www.zohoapis.com.au/books/v3' },
  jp: { accounts: 'https://accounts.zoho.jp', api: 'https://www.zohoapis.jp/books/v3' },
};

export class ZohoError extends Error {
  constructor(message, { status = null, code = null, stage = 'api', path = null } = {}) {
    super(message);
    this.name = 'ZohoError';
    this.status = status;
    this.code = code;
    this.stage = stage; // 'token' | 'api'
    this.path = path;
  }
}

const memoryStore = () => {
  let v = null;
  return { get: async () => v, set: async (x) => { v = x; }, clear: async () => { v = null; } };
};

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Query values: arrays/objects (e.g. report `rule`, `select_columns`) are sent as JSON; undefined/null are dropped. */
function appendQuery(url, query) {
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null) continue;
    url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
}

export function createZohoClient({
  clientId, clientSecret, refreshToken, orgId, dc = 'in',
  fetchImpl = globalThis.fetch, sleep = defaultSleep, now = Date.now, tokenStore = memoryStore(), maxRetries = 4,
}) {
  const centre = DATA_CENTERS[dc];
  if (!centre) throw new Error(`Unknown Zoho data centre "${dc}" (expected one of ${Object.keys(DATA_CENTERS).join(', ')})`);
  for (const [k, v] of Object.entries({ clientId, clientSecret, refreshToken, orgId })) {
    if (!v) throw new Error(`Zoho setting "${k}" is missing`);
  }
  const stats = { calls: 0, retries429: 0, tokenRefreshes: 0 };
  let inflight = null;

  async function refresh() {
    const body = new URLSearchParams({ refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token' });
    const res = await fetchImpl(`${centre.accounts}/oauth/v2/token`, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    const j = await res.json().catch(() => ({}));
    // Zoho answers HTTP 200 with {"error":"invalid_code"} for bad credentials
    if (!res.ok || !j.access_token) {
      throw new ZohoError(`Zoho refused to give an access token (${j.error ?? 'HTTP ' + res.status}). Check client id / secret / refresh token and the data centre (${dc}).`, { status: res.status, code: j.error ?? null, stage: 'token' });
    }
    stats.tokenRefreshes++;
    const t = { token: j.access_token, expiresAt: now() + (Number(j.expires_in) || 3600) * 1000 };
    await tokenStore.set(t);
    return t.token;
  }

  async function accessToken() {
    const cached = await tokenStore.get();
    if (cached && cached.expiresAt - now() > 60_000) return cached.token;
    if (!inflight) inflight = refresh().finally(() => { inflight = null; });
    return inflight;
  }

  async function get(path, query = {}) {
    const url = new URL(centre.api + path);
    url.searchParams.set('organization_id', orgId);
    appendQuery(url, query);
    let reauthed = false;
    for (let attempt = 0; ; attempt++) {
      const token = await accessToken();
      const res = await fetchImpl(url, { headers: { authorization: `Zoho-oauthtoken ${token}` } });
      if (res.status === 401 && !reauthed) { reauthed = true; await tokenStore.clear(); continue; }
      if (res.status === 429 && attempt < maxRetries) {
        stats.retries429++;
        await sleep(2000 * 2 ** attempt);
        continue;
      }
      stats.calls++;
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      if (!res.ok || (json && json.code !== undefined && json.code !== 0)) {
        const msg = json?.message ?? text.slice(0, 200);
        throw new ZohoError(`Zoho ${path} failed: ${msg} (HTTP ${res.status}${json?.code !== undefined ? ', code ' + json.code : ''})`, { status: res.status, code: json?.code ?? null, path });
      }
      if (json === null) throw new ZohoError(`Zoho ${path} returned something that is not JSON`, { status: res.status, path });
      return json;
    }
  }

  return { get, stats, dc, orgId };
}

/** Exchange a one-time Self Client "grant code" for tokens (done once, on your own computer). */
export async function exchangeGrantCode({ clientId, clientSecret, code, dc = 'in', fetchImpl = globalThis.fetch }) {
  const centre = DATA_CENTERS[dc];
  if (!centre) throw new Error(`Unknown Zoho data centre "${dc}"`);
  const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, client_secret: clientSecret, code });
  const res = await fetchImpl(`${centre.accounts}/oauth/v2/token`, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.refresh_token) {
    throw new ZohoError(`Zoho did not give a refresh token (${j.error ?? 'HTTP ' + res.status}). The code is single-use and expires in minutes - generate a fresh one.`, { status: res.status, code: j.error ?? null, stage: 'token' });
  }
  return { refreshToken: j.refresh_token, accessToken: j.access_token, apiDomain: j.api_domain ?? null, expiresIn: j.expires_in ?? null, scope: j.scope ?? null };
}
