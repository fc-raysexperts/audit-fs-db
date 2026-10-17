// Redis cache (Upstash, over its REST address - plain fetch, no dependency).
//
// The Upstash database "mis-dashboard-cache" is SHARED with the MIS dashboard. This file therefore:
//   * only allows the commands GET / SET / DEL / TTL (never FLUSH, KEYS, SCAN ...),
//   * refuses any key that does not start with "audit-fs:" - the MIS dashboard's keys can not be touched by mistake.
//
// What is stored (all keys start with audit-fs:):
//   snapshot:<org>:<fy>:<IST date>   the finished statements for that day               kept 7 days
//   latest:<org>:<fy>                small pointer to the newest GOOD snapshot          kept 7 days
//   ztoken:<org>                     Zoho access token (valid 1 hour; Zoho allows only 10 new ones per 10 minutes)
//   journal:<org>:<id>               a Zoho journal, already reduced to its lines       kept 12 hours (so each morning's refresh re-reads them)
//   bill:<org>:<id>                  a Zoho bill, reduced to what the HDFC ERGO split reads   kept 12 hours
//   cwipbill:<org>:<id>              a bill behind the CWIP / IAUD accounts, reduced to its lines (update-22)   kept 30 days
//                                    (update-20: a journal behind the CWIP / IAUD accounts is kept 30 days - TTL.cwipJournal)
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
export const TTL = { snapshot: 7 * DAY, latest: 7 * DAY, journal: 12 * 3600, bill: 12 * 3600, vendorCodes: 30 * DAY, cwipJournal: 30 * DAY, cwipBill: 30 * DAY }; // cwipJournal (update-20): the journals behind CWIP / IAUD belong to a closed year and are 137 calls, so they are kept a month (one that no longer fits its ledger line is read again anyway)

export class CacheError extends Error {
  constructor(message) { super(message); this.name = 'CacheError'; }
}

/** Calendar date in India (the dashboard's "day"), e.g. "2026-10-15". */
export const istDate = (ms = Date.now()) => new Date(ms + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

/** Minimal Upstash REST client: one command per call. */
export function createUpstash({ url, token, fetchImpl = globalThis.fetch }) {
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
      });
    } catch (e) {
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
    token: () => `${PREFIX}ztoken:${org}`,
    journal: (id) => `${PREFIX}journal:${org}:${id}`,
    bill: (id) => `${PREFIX}bill:${org}:${id}`,
    cwipBill: (id) => `${PREFIX}cwipbill:${org}:${id}`,
    vendorCodes: () => `${PREFIX}vcodes:${org}`,
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
        latestMoved = true;
      }
      return { key: k, kept: false, latestMoved, ...written };
    },

    /**
     * What the dashboard should show for `date`: today's snapshot if it is good, else the newest good one (stale),
     * else today's flawed one (so something is visible), else null.
     * @returns {Promise<{snapshot:object, stale:boolean, flawed:boolean}|null>}
     */
    async getSnapshot(fy, date = istDate(now())) {
      const today = await getJSON(key.snapshot(fy, date));
      const wrap = (snapshot) => ({ snapshot, stale: snapshot.meta.istDate !== date, flawed: !snapshot.meta.ok });
      if (today?.meta?.ok) return wrap(today);
      const pointer = await getJSON(key.latest(fy));
      const old = pointer ? await getJSON(pointer.key) : null;
      if (old) return wrap(old);
      return today ? wrap(today) : null;
    },

    getJournal: (id) => getJSON(key.journal(id)),
    putJournal: (id, journal, ttl = TTL.journal) => putJSON(key.journal(id), journal, ttl),

    /** update-16: a bill reduced to { number, date, total, billingState, supplyFrom } (lib/splits.mjs normalizeBill). */
    getBill: (id) => getJSON(key.bill(id)),
    putBill: (id, bill) => putJSON(key.bill(id), bill, TTL.bill),
    /** update-22: a bill behind the CWIP / IAUD accounts reduced to { number, notes, location, lines[] } (lib/cwip.mjs normalizeCwipBill); kept a month like their journals. */
    getCwipBill: (id) => getJSON(key.cwipBill(id)),
    putCwipBill: (id, bill, ttl = TTL.cwipBill) => putJSON(key.cwipBill(id), bill, ttl),

    /** The Vendor Code of each vendor read so far (update-14): { [contact_id]: { code, at } } in ONE key, because a vendor card is a call to Zoho and there are 166. */
    getVendorCodes: () => getJSON(key.vendorCodes()),
    putVendorCodes: (map) => putJSON(key.vendorCodes(), map, TTL.vendorCodes),

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
