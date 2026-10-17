'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { requestRefresh, waitForNewer } from './refreshClient';

/**
 * Shown on every page when the day's figures are not loaded yet. On the first visit of the day (and when nothing is saved) it loads
 * from Zoho Books by itself - normally the 05:30 morning job has done that already and this never appears.
 */
export default function AutoLoad({ state, canRefresh, generatedAt, savedLabel, more = false }) {
  const router = useRouter();
  const started = useRef(false);
  const [note, setNote] = useState(null);
  const auto = canRefresh && (state === 'empty' || state === 'stale' || (state === 'fresh' && more));

  useEffect(() => {
    if (!auto || started.current) return;
    started.current = true;
    (async () => {
      setNote({ kind: 'working', text: more ? 'Finishing the CWIP tab: reading the rest of its journals and bills from Zoho Books. This takes about 30 seconds.' : 'Updating from Zoho Books. This takes about 30 seconds.' });
      const r = await requestRefresh(false);
      if (r.status === 'refreshed' || r.status === 'flawed') { router.refresh(); setNote(null); return; }
      if (r.status === 'busy' || r.status === 'recent') {
        setNote({ kind: 'working', text: 'Another update is running. This page refreshes when it finishes.' });
        const got = await waitForNewer(generatedAt ?? null);
        if (got) { router.refresh(); setNote(null); } else setNote({ kind: 'problem', text: 'The update is taking longer than usual. Reload this page in a minute.' });
        return;
      }
      setNote({ kind: 'problem', text: r.message || 'The update did not work.' });
    })();
  }, [auto, more, generatedAt, router]);

  if (state === 'fresh' && !more) return null;
  if (state === 'flawed') {
    return (
      <div className="notice bad" role="status">
        <b>Today's run found problems.</b> The figures below may be incomplete or wrong. <Link href="/checks">See the checks and alerts</Link>, or press Refresh in the side panel to try again.
      </div>
    );
  }
  return (
    <div className={`notice ${note?.kind === 'problem' ? 'bad' : 'warn'}`} role="status" aria-live="polite">
      {state === 'stale' && <><b>Showing figures {savedLabel}.</b>{' '}</>}
      {note ? note.text : !canRefresh ? 'Loading from Zoho Books is not set up, so these figures will not update.' : more ? 'The CWIP tab is only partly loaded: the rest of its journals and bills are read from Zoho Books.' : 'Updating from Zoho Books.'}
    </div>
  );
}
