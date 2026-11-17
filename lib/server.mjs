// What the web app needs on the server, in one place (no framework code, so it can be tested):
//   * reading the day's snapshot from Redis and deciding if it is fresh, from an earlier day, or has errors
//   * running a refresh from Zoho - with rules that protect the shared Zoho quota (see decideRefresh)
//   * who may start the morning job
// Everything outside (clock, Zoho, Redis, files) can be handed in, which is how the tests run it.

import fs from 'node:fs';
import { createZohoClient } from './zoho.mjs';
import { createUpstash, createCache, istDate } from './cache.mjs';
import { refreshSnapshot } from './snapshot.mjs';
import { loadConfig, fyPeriod } from './config.mjs';
import { istStamp } from './format.mjs';
import { buildView } from './present.mjs';
import { buildBooks } from './books.mjs';
import { buildWorkbook, readSheet } from './workbook.mjs';
import { buildTabs } from './tabs.mjs';
import { buildPriorView } from './prior.mjs';

export const DEFAULT_FY = '2025-26';
export const MIN_REFRESH_MS = 10 * 60 * 1000; // "Refresh" is refused if the day's good snapshot is younger than this
export const RETRY_AFTER_ERROR_MS = 2 * 60 * 1000;
export const ATTEMPT_COOLDOWN_S = 120; // after any attempt, nobody starts another for this long (stops a failing refresh from being hammered)
export const CONTINUE_COOLDOWN_S = 60; // update-20: after a continuation (below), nobody starts another for this long
export const REFRESH_LOCK_S = 120; // update-33: how long "a refresh is running" is believed. A run ends by itself inside ~55 s (snapshot.mjs); if the host kills one, the others wait 2 minutes, no longer 10
export const QUOTA_RETRY_MS = 10 * 60 * 1000; // update-33: after Zoho refused a run with 429 (its request limit), nobody asks again for this long
export const PARTIAL_RESUME_MS = 15 * 60 * 1000; // update-33: a run that stopped at its time limit is continued, if it was not longer ago than this
export const MAX_PARTIAL_CHAIN = 12; // update-33: ... and at most this many runs in a row (a Zoho that never lets one finish is left to the next morning job or the Refresh button)

/** update-20: today's good snapshot has the CWIP tab only part read (a refresh reads at most `cwip_journal_budget` new journals): the rest is read by a continuation. */
export const cwipOpen = (snapshot) => Boolean(snapshot?.cwip && !snapshot.cwip.error && snapshot.cwip.complete === false);

/**
 * update-29: the same for Dep.Calc.: the entries of the fixed assets are one call each (483 for FY26) and a refresh reads at most `register_history_budget` new ones, so on an empty Redis
 * the rest is read by continuations. Not open when the last run made no progress (`stalled`: Zoho refused or every read failed), otherwise it would repeat for ever.
 */
export const registerOpen = (snapshot) => {
  const h = snapshot?.register?.history;
  return Boolean(h && !h.error && h.complete === false && h.stalled !== true);
};

/** Either part still being read. */
export const moreToRead = (snapshot) => cwipOpen(snapshot) || registerOpen(snapshot);

/** Settings from the environment (.env locally, Project Settings on Vercel). */
export function readSettings(env = process.env) {
  const has = (...keys) => keys.every((k) => env[k]);
  return {
    fy: env.AUDIT_FY || DEFAULT_FY,
    org: env.ZOHO_ORG_ID || '',
    zoho: has('ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_REFRESH_TOKEN', 'ZOHO_ORG_ID')
      ? { clientId: env.ZOHO_CLIENT_ID, clientSecret: env.ZOHO_CLIENT_SECRET, refreshToken: env.ZOHO_REFRESH_TOKEN, orgId: env.ZOHO_ORG_ID, dc: env.ZOHO_DC || 'in' }
      : null,
    redis: has('UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN') ? { url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN } : null,
    snapshotFile: env.AUDIT_FS_SNAPSHOT_FILE || '', // a saved snapshot to show without Redis (viewing only)
    cronSecret: env.CRON_SECRET || '',
  };
}

/**
 * Should a refresh from Zoho run now?
 * @param {{got: {snapshot:object, stale:boolean, flawed:boolean}|null, nowMs:number, manual:boolean}} p
 *   manual = somebody pressed Refresh; otherwise it is the morning job or the automatic first load of the day
 * @returns {{run:true, continuing?:true}|{run:false, message:string}}
 *   continuing: today's good snapshot is only missing the rest of the CWIP journals (cwipOpen) or of the entries of the fixed assets (registerOpen, update-29). That is not a refresh the user asked for but the second half of the first one:
 *   it runs at once, manual or not (the 10 minutes of "Refresh" do not apply), under a lock of its own (CONTINUE_COOLDOWN_S). It always makes progress (the journals read stay in
 *   Redis) and ends after one more run, so it cannot repeat for ever.
 */
function decideBase({ got, nowMs, manual }) {
  if (!got) return { run: true };
  const age = nowMs - Date.parse(got.snapshot.meta.generatedAt);
  const minutes = (ms) => Math.max(1, Math.ceil(ms / 60000));
  if (got.stale) return { run: true }; // the newest good snapshot is from an earlier day
  if (got.flawed) {
    return age < RETRY_AFTER_ERROR_MS
      ? { run: false, message: `The last attempt a moment ago found errors. Try again in ${minutes(RETRY_AFTER_ERROR_MS - age)} min.` }
      : { run: true };
  }
  if (moreToRead(got.snapshot)) return { run: true, continuing: true };
  if (!manual) return { run: false, message: "Today's statements are already loaded." };
  return age < MIN_REFRESH_MS
    ? { run: false, message: `Loaded ${minutes(age)} min ago. To protect the shared Zoho quota, Refresh works again after ${minutes(MIN_REFRESH_MS - age)} min.` }
    : { run: true };
}

/**
 * update-33: the rules above, plus what the LAST attempt left behind (`last`, the record of cache.getAttempt):
 *   * it ended 'partial' (it ran out of its time limit after saving what it had read): the next run is its continuation - at once, whatever the rules above say, up to MAX_PARTIAL_CHAIN runs in a row;
 *   * it ended 'quota' (Zoho refused with 429): nobody asks again before `retryAt` - the answer says when, in words the screen can show.
 * @returns {{run:true, continuing?:true}|{run:false, message:string, blocked?:'quota', retryAt?:number}}
 */
export function decideRefresh({ got, nowMs, manual, last = null }) {
  const quotaBlock = last?.status === 'quota' && Number(last.retryAt) > nowMs;
  const resume = last?.status === 'partial' && (last.chain ?? 1) < MAX_PARTIAL_CHAIN && nowMs - (last.finishedAt ?? last.at ?? 0) < PARTIAL_RESUME_MS;
  if (resume && !quotaBlock) return { run: true, continuing: true };
  const base = decideBase({ got, nowMs, manual });
  if (!base.run || !quotaBlock) return base;
  return {
    run: false, blocked: 'quota', retryAt: last.retryAt,
    message: `Zoho's request limit was reached at ${istStamp(new Date(last.at).toISOString())}, so no new update was started. The limit is shared with every other dashboard that reads this Zoho organisation. The next try is possible at ${istStamp(new Date(last.retryAt).toISOString())}.`,
  };
}

/** update-33: the record of an attempt, as the screen may see it (nothing secret in it). */
export const publicAttempt = (a) => (a ? { at: a.at, finishedAt: a.finishedAt ?? null, status: a.status, message: a.message ?? '', durationMs: a.durationMs ?? null, calls: a.calls ?? null, kind: a.kind ?? null, retryAt: a.retryAt ?? null, chain: a.chain ?? null } : null);

/** 'fresh' = today's, no errors | 'stale' = newest good one is from an earlier day | 'flawed' = has errors | 'empty' = nothing saved yet */
export function stateOf(got) {
  if (!got) return 'empty';
  if (got.flawed) return 'flawed';
  return got.stale ? 'stale' : 'fresh';
}

/** The morning job is called by Vercel with "Authorization: Bearer <CRON_SECRET>". Without a secret it only works outside production. */
export function cronAllowed({ authorization, secret, production }) {
  if (secret) return authorization === `Bearer ${secret}`;
  return !production;
}

/**
 * The rest of the audited booklet (notes, cash flow, fixed assets, ratios, tax) and the list of all sheets.
 * A problem here must never take the Balance Sheet and Profit and Loss down with it, so it comes back as `booksError`.
 */
export function booklet(snapshot, cfg, statements) {
  try {
    const books = buildBooks(snapshot, cfg, statements);
    const workbook = buildWorkbook(snapshot, books, cfg.workbook, { ...cfg.books, related: cfg.related, register: cfg.register, subsidiaries: cfg.subsidiaries });
    const sum = books?.summary;
    // a difference between a list sheet and Zoho is information (the auditors reclassified some lines); only a check that could not run is a problem
    const problems = (sum ? sum.check + sum.checksFailed : 0) + (workbook ? workbook.summary.tiesBad + workbook.summary.liveProblems : 0);
    return { books, workbook, bookProblems: problems };
  } catch (e) {
    return { books: null, workbook: null, bookProblems: 1, booksError: e.message };
  }
}

/**
 * update-31: last year (31 March 2025) as Zoho gives it, against the signed figures, for the last-year panels of the Balance Sheet and Profit and Loss tabs.
 * null = the year has no prior-year configuration; {error} = it could not be built (the statements are not affected).
 */
export function priorYear(snapshot, cfg) {
  try {
    return buildPriorView({ section: snapshot.prior ?? null, audited: cfg.audited, notes: cfg.books?.notes ?? null, spec: cfg.prior ?? null });
  } catch (e) {
    return { error: e.message };
  }
}

export function createContext({ env = process.env, now = Date.now, fetchImpl = globalThis.fetch, zohoFactory = null, cache: givenCache = null, configLoader = loadConfig } = {}) {
  const s = readSettings(env);
  const cache = givenCache ?? (s.redis ? createCache(createUpstash({ ...s.redis, fetchImpl }), { org: s.org || 'unknown', now }) : null);
  let configMemo = null;
  const config = () => (configMemo ??= configLoader(s.fy));
  const makeZoho = () => (zohoFactory ? zohoFactory(cache) : createZohoClient({ ...s.zoho, tokenStore: cache?.tokenStore, fetchImpl }));
  const canRefresh = Boolean(cache && (s.zoho || zohoFactory));

  /** update-33: the year is over (its last day is past): its figures do not move, so an older day's statements are not a warning. */
  function closedYear() {
    try { const p = fyPeriod(s.fy, istDate(now())); return istDate(now()) > p.end; } catch { return false; }
  }

  async function read() {
    if (cache) return cache.getSnapshot(s.fy, istDate(now()));
    if (s.snapshotFile) {
      const snapshot = JSON.parse(fs.readFileSync(s.snapshotFile, 'utf8'));
      return { snapshot, stale: snapshot.meta.istDate !== istDate(now()), flawed: !snapshot.meta.ok };
    }
    return null;
  }

  return {
    settings: s, canRefresh, hasStore: Boolean(cache || s.snapshotFile),

    /** Everything a page needs. Never throws: a problem becomes state 'error' with a plain message. */
    async view() {
      const base = { fy: s.fy, canRefresh, today: istDate(now()), closed: closedYear() };
      if (!cache && !s.snapshotFile) {
        return { ...base, state: 'error', message: 'Redis is not set up. Add UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN to the .env file (or the Vercel settings) and restart.' };
      }
      try {
        const got = await read();
        const state = stateOf(got);
        const lastAttempt = cache ? publicAttempt(await cache.getAttempt().catch(() => null)) : null; // update-33: what the last attempt did, so an empty or old page can say WHY
        if (!got) return { ...base, state, lastAttempt };
        const cfg = config();
        const statements = buildView(got.snapshot, cfg.audited);
        return { ...base, state, lastAttempt, snapshot: got.snapshot, generatedAt: got.snapshot.meta.generatedAt, statements, ...booklet(got.snapshot, cfg, statements), prior: priorYear(got.snapshot, cfg) };
      } catch (e) {
        return { ...base, state: 'error', message: e.message };
      }
    },

    /** One of the sheets shown as signed (config/workbook.fyYY/<id>.json), or null. */
    sheet(id) {
      return readSheet(config().workbook, String(id));
    },

    /** update-27: the related parties' checks (contacts, accounts and the list of figure checks), or null when the year has none. */
    related() {
      return config().related ?? null;
    },

    /** update-28: the configuration of the checks against Zoho's fixed asset register and the subsidiaries' own books (null where the year has none). */
    verify() {
      const c = config();
      return { register: c.register ?? null, subsidiaries: c.subsidiaries ?? null };
    },

    /** The tabs of the workbook screen, in the order of the Excel file (see lib/tabs.mjs). Throws when the `tabs` of the index are wrong. */
    tabs() {
      return buildTabs(config().workbook?.index ?? null);
    },

    /**
     * Small answer for the page's "is it ready yet?" polling (and for the status page). update-33: it also says whether an update is running right now and for how long,
     * what the last attempt did and why, and whether the statements are still being read in parts (`more`).
     */
    async status() {
      try {
        const got = await read();
        const [last, runAge] = cache ? await Promise.all([cache.getAttempt().catch(() => null), cache.lockAge('refresh').catch(() => null)]) : [null, null];
        return {
          state: stateOf(got), generatedAt: got?.snapshot.meta.generatedAt ?? null, ok: got ? got.snapshot.meta.ok : null, canRefresh,
          more: got ? moreToRead(got.snapshot) : false,
          running: runAge === null ? null : { forSeconds: Math.round(runAge / 1000) },
          lastAttempt: publicAttempt(last),
          closed: closedYear(), fy: s.fy,
        };
      } catch (e) {
        return { state: 'error', message: e.message, canRefresh };
      }
    },

    /**
     * Pull everything from Zoho and save the new snapshot.
     * @returns {Promise<{status:'refreshed'|'flawed'|'partial'|'quota'|'recent'|'busy'|'unavailable'|'failed', message:string, generatedAt?:string, errors?:number, more?:boolean, retryInSeconds?:number, running?:boolean, retryAt?:number}>}
     *   update-33: every answer that is not the end of the work says when to ask again (`retryInSeconds`) and whether more is left (`more`), so the page never has to guess or give up with "reload in a minute":
     *   partial = the run reached its time limit after saving what it had read (the next run continues); quota = Zoho's request limit (retryAt); recent / busy = another run is on, or one just ended.
     */
    async refresh({ manual = false } = {}) {
      if (!canRefresh) {
        return { status: 'unavailable', message: cache ? 'Zoho settings are missing (ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN, ZOHO_ORG_ID).' : 'Redis is not set up, so there is nowhere to save a refresh.' };
      }
      const started = now();
      let kind = manual ? 'manual' : 'auto';
      let last = null;
      const secs = (ms) => `${Math.max(1, Math.round(ms / 1000))} s`;
      const record = async (rec) => { await cache.putAttempt({ at: started, finishedAt: now(), durationMs: now() - started, kind, ...rec }).catch(() => {}); }; // the record is a help for the screen: losing it never loses the run
      try {
        last = await cache.getAttempt().catch(() => null);
        const got = await cache.getSnapshot(s.fy, istDate(now())).catch(() => null);
        const d = decideRefresh({ got, nowMs: now(), manual, last });
        if (!d.run) {
          const run = await cache.lockAge('refresh').catch(() => null);
          return {
            status: d.blocked === 'quota' ? 'quota' : 'recent', message: d.message, generatedAt: got?.snapshot.meta.generatedAt,
            ...(d.retryAt ? { retryAt: d.retryAt, retryInSeconds: Math.max(1, Math.ceil((d.retryAt - now()) / 1000)) } : {}),
            ...(run !== null ? { running: true, retryInSeconds: 15 } : {}),
          };
        }
        kind = d.continuing ? 'continue' : kind;
        if (!(await cache.acquireLock(d.continuing ? 'continue' : 'attempt', d.continuing ? CONTINUE_COOLDOWN_S : ATTEMPT_COOLDOWN_S))) {
          const run = await cache.lockAge('refresh').catch(() => null);
          return run !== null
            ? { status: 'recent', running: true, retryInSeconds: 15, message: `An update is running (started ${secs(run)} ago). The page refreshes when it finishes.` }
            : { status: 'recent', retryInSeconds: 30, message: 'A refresh was started a moment ago. Give it a minute.' };
        }
        const out = await refreshSnapshot({ zoho: makeZoho(), cache, config: config(), fy: s.fy, now, lockSeconds: REFRESH_LOCK_S });
        if (out.busy) {
          const run = await cache.lockAge('refresh').catch(() => null);
          return { status: 'busy', running: true, retryInSeconds: 15, message: run !== null ? `Another update is running (started ${secs(run)} ago). The screen updates when it finishes.` : 'Another refresh is running. The screen updates when it finishes.' };
        }
        if (out.partial) {
          const chain = last?.status === 'partial' ? (last.chain ?? 1) + 1 : 1;
          const more = chain < MAX_PARTIAL_CHAIN;
          const message = more
            ? `Part ${chain} is done: ${out.calls} reads from Zoho Books were saved before this run reached its time limit. The next part follows by itself.`
            : `This run reached its time limit again (${out.calls} reads from Zoho Books were saved). It will go on at the next morning job, or when Refresh is pressed.`;
          await record({ status: 'partial', chain, message, calls: out.calls });
          return { status: 'partial', message, more, retryInSeconds: CONTINUE_COOLDOWN_S };
        }
        if (out.quota) {
          const retryAt = now() + QUOTA_RETRY_MS;
          const message = `Zoho's request limit was reached, so this update was stopped. The limit is shared with every other dashboard that reads this Zoho organisation (the daily one starts again overnight). ${got ? "The statements already saved stay on screen." : ''} The next try is possible at ${istStamp(new Date(retryAt).toISOString())}.`.replace(/\s+/g, ' ');
          await record({ status: 'quota', message, calls: out.calls, retryAt });
          return { status: 'quota', message, retryAt, retryInSeconds: Math.ceil(QUOTA_RETRY_MS / 1000) };
        }
        const m = out.snapshot.meta;
        const more = moreToRead(out.snapshot);
        if (m.ok) {
          const message = `Loaded from Zoho Books in ${(m.durationMs / 1000).toFixed(0)} s.`;
          await record({ status: 'refreshed', message, calls: out.calls, generatedAt: m.generatedAt });
          return { status: 'refreshed', message, generatedAt: m.generatedAt, errors: 0, more, ...(more ? { retryInSeconds: CONTINUE_COOLDOWN_S } : {}), ...(d.continuing ? { continued: true } : {}) };
        }
        const message = out.stored?.kept ? `The new run found ${m.errors} problem(s), so the earlier good result of today was kept.` : `The new run found ${m.errors} problem(s). See Checks and alerts.`;
        await record({ status: 'flawed', message, calls: out.calls, generatedAt: m.generatedAt });
        return { status: 'flawed', generatedAt: m.generatedAt, errors: m.errors, message, more: false };
      } catch (e) {
        await record({ status: 'failed', message: e.message });
        return { status: 'failed', message: e.message, retryInSeconds: ATTEMPT_COOLDOWN_S };
      }
    },
  };
}
