'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { driveRefresh, mmss } from './refreshClient';

/**
 * The Refresh button. update-33: it drives the whole job like the banner does (several short runs, waiting as long as the server says) and shows what is really happening, instead of
 * stopping after one run or "Still running. Try again in a minute."
 */
export default function RefreshButton({ canRefresh, generatedAt }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  const [clock, setClock] = useState(Date.now());
  const gen = useRef(generatedAt);
  gen.current = generatedAt;
  const cancelled = useRef(false);
  useEffect(() => () => { cancelled.current = true; }, []);
  useEffect(() => {
    if (!note?.until) return undefined;
    const t = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(t);
  }, [note?.until]);

  async function go() {
    setBusy(true);
    setNote({ kind: 'working', text: 'Reading Zoho Books. About 30 seconds.' });
    await driveRefresh({
      manual: true,
      isCancelled: () => cancelled.current,
      onNote: (n) => { if (!cancelled.current) setNote(n.kind === 'ok' ? { kind: 'ok', text: 'Updated.' } : n); },
      onUpdated: () => { if (!cancelled.current) router.refresh(); },
      getGeneratedAt: () => gen.current ?? null,
    });
    if (!cancelled.current) setBusy(false);
  }

  if (!canRefresh) return <p className="btn-note">Zoho Books loading is not set up here.</p>;
  const left = note?.until ? Math.max(0, Math.round((note.until - clock) / 1000)) : null;
  return (
    <div>
      <button type="button" className="btn" onClick={go} disabled={busy}>{busy ? 'Refreshing…' : 'Refresh from Zoho Books'}</button>
      <p className="btn-note" aria-live="polite">
        {note?.text}{left !== null && left > 0 ? ` ${mmss(left)}` : ''}
        {' '}<Link href="/status" className="rail-link">Update status</Link>
      </p>
    </div>
  );
}
