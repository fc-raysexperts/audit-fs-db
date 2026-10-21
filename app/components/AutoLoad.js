'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { requestRefresh, waitForNewer } from './refreshClient';

/**
 * Shown on every page when the day's figures are not loaded yet. On the first visit of the day (and when nothing is saved) it loads
 * from Zoho Books by itself - normally the 05:30 morning job has done that already and this never appears.
 */
export default function AutoLoad({ state, canRefresh, generatedAt, savedLabel, more = false, what = 'CWIP' }) {
  const router = useRouter();
  const started = useRef(false);
  const runs = useRef(0); // update-29: how many continuations this page has made (Dep.Calc. needs up to 5 runs of 100 assets on an empty cache)
  const [note, setNote] = useState(null);
  const auto = canRefresh && (state === 'empty' || state === 'stale' || (state === 'fresh' && more));

  useEffect(() => {
    if (!auto || started.current) return;
    started.current = true;
    (async () => {
      if (more && runs.current > 0) { // the next part: Zoho Books allows only so many reads a minute, so wait for a new minute (the server also keeps a 60 second gap)
        setNote({ kind: 'working', text: 'Waiting a minute, then reading the next part from Zoho Books (it allows only so many reads a minute).' });
        await new Promise((resolve) => setTimeout(resolve, 65000));
      }
      runs.current += 1;
      setNote({ kind: 'working', text: more ? (what === 'CWIP' ? 'Finishing the CWIP tab: reading the rest of its journals and bills from Zoho Books. This takes about 30 seconds.' : 'Finishing the Dep.Calc. tab: reading the depreciation of the rest of the assets from Zoho Books. This takes about 30 seconds.') : 'Updating from Zoho Books. This takes about 30 seconds.' });
      const r = await requestRefresh(false);
      if (r.status === 'refreshed' || r.status === 'flawed') { router.refresh(); setNote(null); if (more && runs.current < 8) started.current = false; return; } // still more to read: the new figures bring the next run
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
      {note ? note.text : !canRefresh ? 'Loading from Zoho Books is not set up, so these figures will not update.' : more ? (what === 'CWIP' ? 'The CWIP tab is only partly loaded: the rest of its journals and bills are read from Zoho Books.' : 'The Dep.Calc. tab is only partly checked: the depreciation of the rest of the assets is read from Zoho Books.') : 'Updating from Zoho Books.'}
    </div>
  );
}
