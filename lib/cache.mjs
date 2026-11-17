// Redis cache (Upstash, over its REST address - plain fetch, no dependency).
//
// The Upstash database "mis-dashboard-cache" is SHARED with the MIS dashboard. This file therefore:
//   * only allows the commands GET / SET / DEL / TTL (never FLUSH, KEYS, SCAN ...),
//   * refuses any key that does not start with "audit-fs:" - the MIS dashboard's keys can not be touched by mistake.
//
// What is stored (all keys start with audit-fs:):
//   snapshot:<org>:<fy>:<IST date>   the finished statements for that day               kept 7 days
//   latest:<org>:<fy>                small pointer to the newest GOOD snapshot          kept 7 days
//   last:<org>:<fy>                  update-33: a full copy of the newest GOOD snapshot, kept 400 days. The page can then NEVER be empty: after a long
//                                    break (or a failed update) it shows the last good statements, marked with their date, while the new ones are loaded
//   attempt:<org>                    update-33: what the last update attempt did (when, how it ended, why), so the screen can say the real reason   kept 30 days
//   ztoken:<org>                     Zoho access token (valid 1 hour; Zoho allows only 10 new ones per 10 minutes)
//   journal:<org>:<id>               a Zoho journal, already reduced to its lines       kept 12 hours (a CLOSED year: 7 days, update-33; the ledger check still reads one again when it no longer fits)
//   bill:<org>:<id>                  a Zoho bill, reduced to what the HDFC ERGO split reads   kept 12 hours (closed year: 7 days)
//   cwipbill:<org>:<id>              a bill behind the CWIP / IAUD accounts, reduced to its lines (update-22)   kept 400 days (update-33; 30 days before)
//                                    (update-20: a journal behind the CWIP / IAUD accounts - TTL.cwipJournal - is kept as long)
//   assethist:<org>                  the acquisition / depreciation entries of every fixed asset, ONE key for all (update-29)   kept 400 days (update-33; 35 before).
//                                    How old an entry may get before it is read again is a separate rule (fetchAssetHistories maxAgeMs), so a long break no longer empties it
//   lock:<org>:<name>                short "someone is refreshing" marker
//
// Values are JSON. Small ones are stored as is ("j:"), larger ones gzip-compressed + base64 ("gz:"), and anything still bigger than
// one Redis request is cut into parts ("chunks:N" + key#0, key#1 ...). The Upstash free plan limits a single request to about 1 MB.

import { gzipSync, gunzipSync } from 'node:zlib';

export const PREFIX = 'audit-fs:';
const ALLOWED = new Set(['GET', 'SET', 'DEL', 'TTL']);
const MAX_PART = 600_000; // characters per stored value
const SMALL = 1500; // characters: below this, no compression

export const DAY = 24 * 3600;
// update-33: what is read once from a CLOSED year (journals and bills behind CWIP / IAUD, the history of the assets, the vendor cards) is kept for more than a year. Before, those keys ran out after 30 / 35 days, and the first visit after a
// break of that length had to read about 1,500 things from Zoho in a row - which is what made the page say "the update is taking longer than usual". How long a kept entry is trusted is decided where it is read (maxAgeMs of
// fetchAssetHistories and fetchVendorCodes), not by Redis. journal / bill (the ledger's journals) are re-read each morning for an open year; a closed year (update-33) keeps them a week.
export const TTL = { snapshot: 7 * DAY, latest: 7 * DAY, last: 400 * DAY, attempt: 30 * DAY, journal: 12 * 3600, bill: 12 * 3600, closedDetail: 7 * DAY, vendorCodes: 400 * DAY, cwipJournal: 400 * DAY, cwipBill: 400 * DAY, assetHistory: 400 * DAY }; // cwipJournal (update-20): the journals behind CWIP / IAUD belong to a closed year and are 137 calls, so they are kept (one that no longer fits its ledger line is read again anyway)

export class CacheError extends Error {
  constructor(message) { super(message); this.name = 'CacheError'; }
}

/** Calendar date in India (the dashboard's "day"), e.g. "2026-10-15". */
export const istDate = (ms = Date.now()) => new Date(ms + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

/** Minimal Upstash REST client: one command per call. */
export function createUpstash({ url, token, fetchImpl = globalThis.fetch, timeoutMs = 10_000 }) {
  if (!url || !token) throw new CacheError('Upstash address / token missing (UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN)');
  const endpoint = String(url).replace(/\/+$/, '');
  async function cmd(args) {
    const name = String(args[0]).toUpperCase();
    if (!ALLOWED.has(name)) throw new CacheError(`Redis command ${name} is not allowed in this app`);
    if (typeof args[1] !== 'string' || !args[1].startsWith(PREFIX)) {
      throw new CacheError(`Redis key must start with "${PREFIX}" (the database is shared with the MIS dashboard)`);
    }
    let res;
    try {
      res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify([name, ...args.slice(1)]),
        signal: AbortSignal.timeout(timeoutMs), // update-33: a Redis that does not answer must not hold a page (or a refresh) for ever
      });
    } catch (e) {
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new CacheError(`Redis did not answer within ${Math.round(timeoutMs / 1000)} seconds`);
      throw new CacheError(`Cannot reach Redis (${e.message}${e.cause?.code ? ', ' + e.cause.code : ''})`);
    }
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.error) throw new CacheError(`Redis ${name} failed: ${j.error ?? 'HTTP ' + res.status}`);
    return j.result;
  }
  return { cmd };
}

function encode(value) {
  const json = JSON.stringify(value);
  if (json.length < SMALL) return { head: 'j:' + json, parts: [] };
  const gz = 'gz:' + gzipSync(json).toString('base64');
  if (gz.length <= MAX_PART) return { head: gz, parts: [] };
  const parts = [];
  for (let i = 0; i < gz.length; i += MAX_PART) parts.push(gz.slice(i, i + MAX_PART));
  return { head: `chunks:${parts.length}`, parts };
}

const decode = (text) => {
  if (text.startsWith('j:')) return JSON.parse(text.slice(2));
  if (text.startsWith('gz:')) return JSON.parse(gunzipSync(Buffer.from(text.slice(3), 'base64')).toString('utf8'));
  throw new CacheError('Unknown cache value format');
};

/**
 * @param {{cmd:Function}} redis  from createUpstash
 * @param {{org:string, now?:()=>number}} opt
 */
export function createCache(redis, { org, now = Date.now } = {}) {
  if (!org) throw new CacheError('Cache needs the organization id');

  async function putJSON(key, value, ttl) {
    const { head, parts } = encode(value);
    for (let i = 0; i < parts.length; i++) await redis.cmd(['SET', `${key}#${i}`, parts[i], 'EX', ttl]); // parts first, then the head
    await redis.cmd(['SET', key, head, 'EX', ttl]);
    return { chars: head.length + parts.reduce((s, p) => s + p.length, 0), parts: parts.length };
  }

  async function getJSON(key) {
    const head = await redis.cmd(['GET', key]);
    if (head === null || head === undefined) return null;
    if (head.startsWith('chunks:')) {
      const n = Number(head.slice(7));
      let text = '';
      for (let i = 0; i < n; i++) {
        const part = await redis.cmd(['GET', `${key}#${i}`]);
        if (part === null || part === undefined) return null; // a part has expired: treat as missing
        text += part;
      }
      return decode(text);
    }
    return decode(head);
  }

  const key = {
    snapshot: (fy, date) => `${PREFIX}snapshot:${org}:${fy}:${date}`,
    latest: (fy) => `${PREFIX}latest:${org}:${fy}`,
    last: (fy) => `${PREFIX}last:${org}:${fy}`,
    attempt: () => `${PREFIX}attempt:${org}`,
    token: () => `${PREFIX}ztoken:${org}`,
    journal: (id) => `${PREFIX}journal:${org}:${id}`,
    bill: (id) => `${PREFIX}bill:${org}:${id}`,
    cwipBill: (id) => `${PREFIX}cwipbill:${org}:${id}`,
    vendorCodes: () => `${PREFIX}vcodes:${org}`,
    assetHistory: () => `${PREFIX}assethist:${org}`,
    lock: (name) => `${PREFIX}lock:${org}:${name}`,
  };

  return {
    key,
    putJSON,
    getJSON,

    /**
     * Save the day's statements. A run with errors never replaces a good snapshot of the same day, and `latest` only ever points at a good one.
     * @returns {Promise<{key:string, kept:boolean, latestMoved:boolean, chars:number, parts:number}>}
     */
    async putSnapshot(snap) {
      const { fy, istDate: date } = snap.meta;
      const k = key.snapshot(fy, date);
      if (!snap.meta.ok) {
        const existing = await getJSON(k).catch(() => null);
        if (existing?.meta?.ok) return { key: k, kept: true, latestMoved: false, chars: 0, parts: 0 };
      }
      const written = await putJSON(k, snap, TTL.snapshot);
      let latestMoved = false;
      if (snap.meta.ok) {
        await putJSON(key.latest(fy), { key: k, date, generatedAt: snap.meta.generatedAt, ok: true }, TTL.latest);
        await putJSON(key.last(fy), snap, TTL.last).catch(() => {}); // update-33: the copy that never runs out; losing it must not lose the snapshot just saved
        latestMoved = true;
      }
      return { key: k, kept: false, latestMoved, ...written };
    },

    /**
     * What the dashboard should show for `date`: today's snapshot if it is good, else the newest good one (stale) - first through the pointer, then (update-33) through the 400-day copy `last` -
     * else today's flawed one (so something is visible), else null. A layer that cannot be read (expired part, damaged value) is skipped for the next; only when NOTHING can be read and something
     * went wrong, that first error is thrown (so "Redis is down" is told, and a damaged key never hides a good one).
     * @returns {Promise<{snapshot:object, stale:boolean, flawed:boolean}|null>}
     */
    async getSnapshot(fy, date = istDate(now())) {
      const problems = [];
      const read = async (k) => { try { return await getJSON(k); } catch (e) { problems.push(e); return null; } };
      const wrap = (snapshot) => ({ snapshot, stale: snapshot.meta.istDate !== date, flawed: !snapshot.meta.ok });
      const today = await read(key.snapshot(fy, date));
      if (today?.meta?.ok) return wrap(today);
      const pointer = await read(key.latest(fy));
      const old = pointer ? await read(pointer.key) : null;
      if (old?.meta) return wrap(old);
      const last = await read(key.last(fy));
      if (last?.meta) return wrap(last);
      if (today?.meta) return wrap(today);
      if (problems.length) throw problems[0];
      return null;
    },

    /** update-33: what the last update attempt did: { at, finishedAt, status, message, durationMs, calls, kind, retryAt? } (see server.mjs). null = none yet. */
    getAttempt: () => getJSON(key.attempt()),
    putAttempt: (rec) => putJSON(key.attempt(), rec, TTL.attempt),

    /** update-33: how long ago the lock `name` was taken, in milliseconds (the lock's value is the time it was taken), or null when nobody holds it. */
    async lockAge(name) {
      const v = await redis.cmd(['GET', key.lock(name)]);
      if (v === null || v === undefined) return null;
      const at = Number(v);
      return Number.isFinite(at) ? Math.max(0, now() - at) : 0;
    },

    getJournal: (id) => getJSON(key.journal(id)),
    putJournal: (id, journal, ttl = TTL.journal) => putJSON(key.journal(id), journal, ttl),

    /** update-16: a bill reduced to { number, date, total, billingState, supplyFrom } (lib/splits.mjs normalizeBill). */
    getBill: (id) => getJSON(key.bill(id)),
    putBill: (id, bill, ttl = TTL.bill) => putJSON(key.bill(id), bill, ttl),
    /** update-22: a bill behind the CWIP / IAUD accounts reduced to { number, notes, location, lines[] } (lib/cwip.mjs normalizeCwipBill); kept a month like their journals. */
    getCwipBill: (id) => getJSON(key.cwipBill(id)),
    putCwipBill: (id, bill, ttl = TTL.cwipBill) => putJSON(key.cwipBill(id), bill, ttl),

    /** The Vendor Code of each vendor read so far (update-14): { [contact_id]: { code, at } } in ONE key, because a vendor card is a call to Zoho and there are 166. */
    getVendorCodes: () => getJSON(key.vendorCodes()),
    putVendorCodes: (map) => putJSON(key.vendorCodes(), map, TTL.vendorCodes),

    /** update-29: the entries of every fixed asset read so far: { [asset id]: { v, at, ent: [[type, date, depreciated, accumulated], ...] } } in ONE key (483 assets = 483 calls the first time). */
    getAssetHistory: () => getJSON(key.assetHistory()),
    putAssetHistory: (map) => putJSON(key.assetHistory(), map, TTL.assetHistory),

    /** Zoho access-token store (same shape the Zoho client expects). */
    tokenStore: {
      async get() { return getJSON(key.token()).catch(() => null); },
      async set(t) {
        const ttl = Math.max(60, Math.floor((t.expiresAt - now()) / 1000) - 60);
        await putJSON(key.token(), t, ttl).catch(() => {});
      },
      async clear() { await redis.cmd(['DEL', key.token()]).catch(() => {}); },
    },

    /** true if this caller got the lock (nobody else is refreshing). */
    async acquireLock(name, ttlSeconds) {
      const r = await redis.cmd(['SET', key.lock(name), String(now()), 'NX', 'EX', ttlSeconds]);
      return r === 'OK';
    },
    async releaseLock(name) { await redis.cmd(['DEL', key.lock(name)]); },
  };
}
