'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { requestRefresh, waitForNewer } from './refreshClient';

export default function RefreshButton({ canRefresh, generatedAt }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  async function go() {
    setBusy(true);
    setNote('Reading Zoho Books. About 30 seconds.');
    const r = await requestRefresh(true);
    if (r.status === 'refreshed') { setNote('Updated.'); router.refresh(); }
    else if (r.status === 'flawed') { setNote(r.message); router.refresh(); }
    else if (r.status === 'busy') {
      setNote('Another update is running. Waiting for it.');
      const got = await waitForNewer(generatedAt ?? null);
      if (got) { setNote('Updated.'); router.refresh(); } else setNote('Still running. Try again in a minute.');
    } else setNote(r.message || 'The update did not work.');
    setBusy(false);
  }

  if (!canRefresh) return <p className="btn-note">Zoho Books loading is not set up here.</p>;
  return (
    <div>
      <button type="button" className="btn" onClick={go} disabled={busy}>{busy ? 'Refreshing…' : 'Refresh from Zoho Books'}</button>
      <p className="btn-note" aria-live="polite">{note}</p>
    </div>
  );
}
