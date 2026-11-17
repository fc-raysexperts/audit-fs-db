// Minimal Zoho Books API client (read-only use). No dependencies; uses the global fetch of Node 18+ / Vercel.
//
// Auth: Zoho "Self Client" -> one long-lived REFRESH TOKEN -> short-lived (1 hour) access tokens.
// Facts that shape this file (from Zoho / integration guides; confirm in the check script on first run):
//   * at most 10 access tokens may be generated from one refresh token in any 10 minutes -> the access token MUST be cached
//     (in memory here; pass `tokenStore` to share it through Redis on serverless hosting);
//   * the API allows ~100 calls / minute / organization and a DAILY quota by plan (shared by ALL apps using the org);
//     HTTP 429 means "slow down" -> we back off and retry a few times;
//   * errors come as HTTP 4xx with {code, message}; a few come as HTTP 200 with code != 0 -> both are treated as errors.
//   * update-33: no call may hang. Every request has a time limit (`timeoutMs`), a run can be given a SOFT deadline (the optional readers stop starting new calls,
//     see timeLeft) and a HARD one (any further call is refused with RunTimeUp, so a run ends inside the hosting time limit and can carry on in the next one),
//     and when Zoho keeps answering 429 after the back-off the client stops asking for the rest of the run (`quotaHit`) instead of sleeping 30 seconds on every call.
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

/** update-33: the run has used up its time (set by setDeadline). It is NOT a ZohoError on purpose: the "detail layer" readers turn a ZohoError into "this layer could not be read" and carry on; running out of time must stop the run instead. */
export class RunTimeUp extends Error {
  constructor(message = 'The run reached its time limit') {
    super(message);
    this.name = 'RunTimeUp';
    this.code = 'RUN_TIME_UP';
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
  fetchImpl = globalThis.fetch, sleep = defaultSleep, now = Date.now, tokenStore = memoryStore(), maxRetries = 4, timeoutMs = 25_000,
}) {
  const centre = DATA_CENTERS[dc];
  if (!centre) throw new Error(`Unknown Zoho data centre "${dc}" (expected one of ${Object.keys(DATA_CENTERS).join(', ')})`);
  for (const [k, v] of Object.entries({ clientId, clientSecret, refreshToken, orgId })) {
    if (!v) throw new Error(`Zoho setting "${k}" is missing`);
  }
  const stats = { calls: 0, retries429: 0, tokenRefreshes: 0, timeouts: 0 };
  let inflight = null;
  let limits = { soft: Infinity, hard: Infinity }; // absolute times (ms on `now`); see setDeadline
  let quota = null; // set when Zoho kept answering 429 after the back-off: { at, path }

  const softLeft = () => limits.soft - now();
  const hardLeft = () => limits.hard - now();
  const isTimeout = (e) => e?.name === 'TimeoutError' || e?.name === 'AbortError';

  /** One HTTP request that can neither hang nor outlive the hard deadline. A timeout caused by the deadline is RunTimeUp; one caused by Zoho being slow is a ZohoError (stage 'timeout'). */
  async function send(url, init, { what, stage }) {
    const left = hardLeft();
    if (left <= 0) throw new RunTimeUp(`The run reached its time limit before ${what}`);
    const ms = Math.max(1000, Math.min(timeoutMs, left));
    try {
      return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(ms) });
    } catch (e) {
      if (isTimeout(e)) {
        if (left < timeoutMs) throw new RunTimeUp(`The run reached its time limit while waiting for ${what}`);
        stats.timeouts++;
        throw new ZohoError(`${what} did not answer within ${Math.round(ms / 1000)} seconds`, { stage: stage === 'token' ? 'token' : 'timeout', code: 'TIMEOUT' });
      }
      throw new ZohoError(`Could not reach ${what} (${e?.message ?? e}${e?.cause?.code ? ', ' + e.cause.code : ''})`, { stage: stage === 'token' ? 'token' : 'network', code: 'NETWORK' });
    }
  }

  async function refresh() {
    const body = new URLSearchParams({ refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token' });
    const res = await send(`${centre.accounts}/oauth/v2/token`, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } }, { what: "Zoho's sign-in server", stage: 'token' });
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
    // update-33: Zoho has already refused this run (429 after every back-off): asking again only wastes the time of the run
    if (quota) throw new ZohoError(`Zoho ${path} not asked: Zoho's request limit was reached earlier in this run (HTTP 429)`, { status: 429, code: 'RATE_LIMIT', stage: 'quota', path });
    let reauthed = false;
    let slowOnce = false;
    for (let attempt = 0; ; attempt++) {
      const token = await accessToken();
      let res;
      try {
        res = await send(url, { headers: { authorization: `Zoho-oauthtoken ${token}` } }, { what: `Zoho Books (${path})`, stage: 'api' });
      } catch (e) {
        if (e instanceof ZohoError && e.code === 'TIMEOUT' && !slowOnce) { slowOnce = true; continue; } // a read does not change anything in Zoho: ask once more when it did not answer in time
        throw e;
      }
      if (res.status === 401 && !reauthed) { reauthed = true; await tokenStore.clear(); continue; }
      if (res.status === 429 && attempt < maxRetries) {
        stats.retries429++;
        const wait = 2000 * 2 ** attempt;
        if (wait >= hardLeft()) throw new RunTimeUp(`The run reached its time limit while waiting for Zoho's request limit to ease (${path})`);
        await sleep(wait);
        continue;
      }
      if (res.status === 429) quota = { at: now(), path };
      stats.calls++;
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      if (!res.ok || (json && json.code !== undefined && json.code !== 0)) {
        const msg = json?.message ?? text.slice(0, 200);
        throw new ZohoError(`Zoho ${path} failed: ${msg} (HTTP ${res.status}${json?.code !== undefined ? ', code ' + json.code : ''})`, { status: res.status, code: json?.code ?? null, path, stage: res.status === 429 ? 'quota' : 'api' });
      }
      if (json === null) throw new ZohoError(`Zoho ${path} returned something that is not JSON`, { status: res.status, path });
      return json;
    }
  }

  return {
    get, stats, dc, orgId,
    /**
     * update-33: give the coming calls a time budget, in milliseconds from now. After `softMs` the optional readers (CWIP journals, asset histories, vendor cards) start no new call
     * (timeLeft() <= 0); after `hardMs` every call is refused with RunTimeUp. Without it nothing is limited (tests, `npm run live`).
     */
    setDeadline({ softMs = Infinity, hardMs = Infinity } = {}) { limits = { soft: now() + softMs, hard: now() + hardMs }; },
    /** milliseconds until the soft deadline (Infinity without one) */
    timeLeft: softLeft,
    hardLeft,
    /** { at, path } once Zoho has refused this run's calls with 429 after the back-off, else null */
    quotaHit: () => quota,
  };
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
