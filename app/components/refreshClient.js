// Browser-side helpers for loading from Zoho. Used by the Refresh button and by the automatic load of the day.
//
// update-33: the page used to give up after one run (and after ~96 seconds of waiting for another) with "The update is taking longer than usual. Reload this page in a minute." - for every tab, again and again.
// Now ONE helper (driveRefresh) drives the whole job, for the button and for the banner alike. The server answers every request with what is the case (see lib/server.mjs refresh): finished, finished-and-more-follows,
// stopped-at-the-time-limit (the next run goes on), Zoho's request limit (and when to try again), or another run is on. This helper waits as long as the server says, shows the REAL reason, and only stops
// when there is nothing more to do or the reason is one that waiting cannot cure (Zoho settings wrong, token refused ...) - then it says so, in the server's own words.

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One request at a time per kind, whatever number of components ask (every tab you open mounts its own banner): they share the answer instead of each starting a run.
const inflight = new Map();

export function requestRefresh(manual, { fetchImpl = globalThis.fetch } = {}) {
  const key = manual ? 'manual' : 'auto';
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const res = await fetchImpl('/api/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ manual }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok && !body.status) return { status: 'failed', message: `The server answered HTTP ${res.status}${res.status === 504 || res.status === 502 ? ' (the hosting stopped the request: it took too long)' : ''}.` };
      return body;
    } catch (e) {
      return { status: 'failed', message: 'Could not reach the server. Check your connection and try again.' };
    }
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** The small status answer (lib/server.mjs status): state, generatedAt, more, running, lastAttempt. null when it cannot be read. */
export async function readStatus({ fetchImpl = globalThis.fetch } = {}) {
  try {
    const res = await fetchImpl('/api/status', { cache: 'no-store' });
    return await res.json();
  } catch { return null; }
}

/** Kept for the Refresh button of older code: ask every few seconds whether a newer snapshot has appeared. */
export async function waitForNewer(previousGeneratedAt, { tries = 24, everyMs = 4000, fetchImpl, sleep = defaultSleep } = {}) {
  for (let i = 0; i < tries; i++) {
    await sleep(everyMs);
    const s = await readStatus({ fetchImpl });
    if (s?.generatedAt && s.generatedAt !== previousGeneratedAt) return true;
  }
  return false;
}

const mmss = (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

/**
 * Do the whole job until it is done or cannot go on. `onNote({kind, text, until?})` says what is going on: kind 'working' | 'info' | 'ok' | 'problem'; `until` (ms) is when a countdown ends.
 * `onUpdated(r)` is called whenever new statements are saved (the page then refreshes itself). Returns { done, r, cancelled }.
 * @param {{manual?:boolean, onNote?:Function, onUpdated?:Function, isCancelled?:()=>boolean, getGeneratedAt?:()=>string|null, fetchImpl?:Function, sleep?:Function, now?:()=>number, maxRuns?:number, pollEverySeconds?:number}} o
 */
export async function driveRefresh({ manual = false, onNote = () => {}, onUpdated = () => {}, isCancelled = () => false, getGeneratedAt = () => null, fetchImpl = globalThis.fetch, sleep = defaultSleep, now = Date.now, maxRuns = 40, pollEverySeconds = 5 } = {}) {
  const say = (kind, text, until) => onNote({ kind, text, ...(until ? { until } : {}) });
  /** wait `seconds`, one second at a time (so that leaving the page ends it at once), with a countdown; false = cancelled */
  const wait = async (seconds, text) => {
    const until = now() + seconds * 1000;
    say('working', text, until);
    for (let left = seconds; left > 0; left -= 1) { if (isCancelled()) return false; await sleep(1000); }
    return !isCancelled();
  };
  /** while another run is on: look at the status every few seconds; true = newer statements appeared (or nothing is running any more) */
  const watch = async (seconds, text) => {
    const first = getGeneratedAt();
    say('working', text);
    for (let spent = 0; spent < seconds; spent += pollEverySeconds) {
      for (let i = 0; i < pollEverySeconds; i += 1) { if (isCancelled()) return { cancelled: true }; await sleep(1000); }
      const s = await readStatus({ fetchImpl });
      if (s?.generatedAt && s.generatedAt !== first) return { newer: true, status: s };
      if (s && s.running === null) return { idle: true, status: s };
    }
    return { status: null };
  };

  let runs = 0;
  let idle = 0;
  let quotaWaits = 0;
  while (!isCancelled() && runs < maxRuns) {
    runs += 1;
    say('working', runs === 1 ? 'Updating from Zoho Books. This takes about 30 seconds.' : `Reading the next part from Zoho Books (part ${runs}).`);
    const r = await requestRefresh(manual && runs === 1, { fetchImpl });
    if (isCancelled()) return { done: false, cancelled: true, r };
    switch (r.status) {
      case 'refreshed':
      case 'flawed':
        onUpdated(r);
        idle = 0;
        if (!r.more) { say('ok', ''); return { done: true, r }; }
        if (!(await wait(r.retryInSeconds ?? 60, 'Part of the statements is loaded. The next part is read from Zoho Books (it allows only so many reads a minute)'))) return { done: false, cancelled: true, r };
        break;
      case 'partial':
        idle = 0;
        if (!r.more) { say('problem', r.message); return { done: false, r }; }
        if (!(await wait(r.retryInSeconds ?? 60, `${r.message} Continuing`))) return { done: false, cancelled: true, r };
        break;
      case 'busy':
      case 'recent': {
        if (!r.running && !r.retryInSeconds) { say(manual ? 'info' : 'ok', r.message); return { done: true, r }; } // an answer, not a wait ("loaded 3 min ago ...", "already loaded")
        idle += 1;
        if (idle > 20) { say('problem', 'An update has been running for a long time without finishing. Open "Update status" to see what it is doing.'); return { done: false, r }; }
        const w = await watch(r.retryInSeconds ?? 20, r.message);
        if (w.cancelled) return { done: false, cancelled: true, r };
        if (w.newer) { onUpdated(w.status); idle = 0; if (!w.status.more) { say('ok', ''); return { done: true, r }; } }
        break;
      }
      case 'quota': {
        quotaWaits += 1;
        if (manual || quotaWaits > 3) { say('problem', r.message); return { done: false, r }; }
        const seconds = Math.min(900, Math.max(60, r.retryInSeconds ?? 600));
        if (!(await wait(seconds, `${r.message} This page tries again by itself in`))) return { done: false, cancelled: true, r };
        break;
      }
      default: // 'failed', 'unavailable': waiting does not cure these, the reason is the server's own
        say('problem', r.message || 'The update did not work.');
        return { done: false, r };
    }
  }
  if (!isCancelled()) say('problem', 'The page has asked many times and the statements are still being read in parts. Open "Update status" to see how far it is, or press Try again.');
  return { done: false, r: null };
}

export { mmss };
