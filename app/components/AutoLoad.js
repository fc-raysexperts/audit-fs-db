'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { driveRefresh, mmss } from './refreshClient';

/**
 * Shown on every page when the day's figures are not loaded yet (or only partly). It loads from Zoho Books by itself - normally the 05:30 morning job has done that already and this never appears.
 *
 * update-33: it no longer gives up with "Reload this page in a minute". It does the whole job (driveRefresh: several short runs if need be, waiting as long as the server says), shows what is REALLY going on,
 * and when something cannot go on it says why in the server's own words, with a "Try again" button and a link to the status page. Figures from an earlier day stay on screen the whole time; for a
 * closed year (FY over) they are not a warning at all: nothing in them changes.
 */
export default function AutoLoad({ state, canRefresh, generatedAt, savedLabel, more = false, what = 'CWIP', closed = false, lastAttempt = null }) {
  const router = useRouter();
  const gen = useRef(generatedAt);
  gen.current = generatedAt;
  const [note, setNote] = useState(null);
  const [attempt, setAttempt] = useState(0); // "Try again" starts the job again
  const [clock, setClock] = useState(Date.now());
  const auto = canRefresh && (state === 'empty' || state === 'stale' || (state === 'fresh' && more));

  useEffect(() => {
    if (!auto) return undefined;
    let cancelled = false;
    setNote(null);
    driveRefresh({
      manual: false,
      isCancelled: () => cancelled,
      onNote: (n) => { if (!cancelled) setNote(n.kind === 'ok' ? null : n); },
      onUpdated: () => { if (!cancelled) router.refresh(); },
      getGeneratedAt: () => gen.current ?? null,
    });
    return () => { cancelled = true; };
  }, [auto, attempt, router]);

  useEffect(() => { // the countdown of a wait
    if (!note?.until) return undefined;
    const t = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(t);
  }, [note?.until]);

  if (state === 'fresh' && !more) return null;
  if (state === 'flawed') {
    return (
      <div className="notice bad" role="status">
        <b>Today's run found problems.</b> The figures below may be incomplete or wrong. <Link href="/checks">See the checks and alerts</Link>, or press Refresh in the side panel to try again.
      </div>
    );
  }

  const left = note?.until ? Math.max(0, Math.round((note.until - clock) / 1000)) : null;
  const problem = note?.kind === 'problem';
  const cls = problem ? 'bad' : note?.kind === 'info' ? '' : state === 'stale' && closed ? '' : 'warn';
  const earlier = state === 'stale'
    ? (problem
      ? <><b>Showing the statements saved {savedLabel}.</b>{closed ? ' This year is closed, so they do not change. ' : ' '}</>
      : closed
        ? <><b>Showing the statements saved {savedLabel}.</b> This year is closed, so they do not change; the page is checking Zoho Books for corrections.{' '}</>
        : <><b>Showing figures {savedLabel}.</b>{' '}</>)
    : null;
  const idle = !canRefresh
    ? 'Loading from Zoho Books is not set up, so these figures will not update.'
    : state === 'empty'
      ? 'Nothing is saved yet. Loading from Zoho Books.'
      : more
        ? (what === 'CWIP' ? 'The CWIP tab is only partly loaded: the rest of its journals and bills are read from Zoho Books.' : 'The Dep.Calc. tab is only partly checked: the depreciation of the rest of the assets is read from Zoho Books.')
        : 'Updating from Zoho Books.';
  const reason = !note && lastAttempt && ['failed', 'quota'].includes(lastAttempt.status) ? lastAttempt.message : null;

  return (
    <div className={`notice ${cls}`} role="status" aria-live="polite">
      {earlier}
      {problem && state !== 'empty' && <b>The newest update did not finish: </b>}
      {note ? <>{note.text}{left !== null && left > 0 ? <> <b>{mmss(left)}</b></> : null}</> : idle}
      {reason && <span className="dim small"> Last attempt: {reason}</span>}
      {problem && canRefresh && (
        <> <button type="button" className="btn-link" onClick={() => setAttempt((n) => n + 1)}>Try again</button></>
      )}
      {(problem || reason) && <> <Link href="/status">Update status</Link></>}
    </div>
  );
}
