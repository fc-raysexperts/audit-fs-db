// Redis cache (Upstash, over its REST address - plain fetch, no dependency).
//
// The Upstash database "mis-dashboard-cache" is SHARED with the MIS dashboard. This file therefore:
//   * only allows the commands GET / SET / DEL / TTL (never FLUSH, KEYS, SCAN ...),
//   * refuses any key that does not start with "audit-fs:" - the MIS dashboard's keys can not be touched by mistake.
//
// What is stored (all keys start with audit-fs:):
//   snapshot:<org>:<fy>:<IST date>   the finished statements for that day               kept 7 days
//   latest:<org>:<fy>                small pointer to the newest good snapshot          kept 7 days
//   ztoken:<org>                     Zoho access token (valid 1 hour; Zoho allows only 10 new ones per 10 minutes)
//   journal:<org>:<id>               a Zoho journal, already reduced to its lines       kept 12 hours (so each morning's refresh re-reads them)
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
export const TTL = { snapshot: 7 * DAY, latest: 7 * DAY, journal: 12 * 3600 };

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
    lock: (name) => `${PREFIX}lock:${org}:${name}`,
  };

  return {
    key,
    putJSON,
    getJSON,

    /** Save the day's statements. `latest` moves to it only if it is good (or nothing good is there yet). */
    async putSnapshot(snap) {
      const { fy, istDate: date } = snap.meta;
      const k = key.snapshot(fy, date);
      const written = await putJSON(k, snap, TTL.snapshot);
      const pointer = { key: k, date, generatedAt: snap.meta.generatedAt, ok: snap.meta.ok };
      const current = await getJSON(key.latest(fy)).catch(() => null);
      const moved = snap.meta.ok || !current || current.ok === false;
      if (moved) await putJSON(key.latest(fy), pointer, TTL.latest);
      return { key: k, latestMoved: moved, ...written };
    },

    /** Today's snapshot if there is one, else the newest good one (flagged stale), else null. */
    async getSnapshot(fy, date = istDate(now())) {
      const today = await getJSON(key.snapshot(fy, date));
      if (today) return { snapshot: today, stale: false };
      const pointer = await getJSON(key.latest(fy));
      if (!pointer) return null;
      const old = await getJSON(pointer.key);
      return old ? { snapshot: old, stale: true } : null;
    },

    getJournal: (id) => getJSON(key.journal(id)),
    putJournal: (id, journal) => putJSON(key.journal(id), journal, TTL.journal),

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
