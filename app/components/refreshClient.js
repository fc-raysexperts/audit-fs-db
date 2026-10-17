// Browser-side helpers for loading from Zoho. Used by the Refresh button and by the automatic first load of the day.

export async function requestRefresh(manual) {
  try {
    const res = await fetch('/api/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ manual }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok && !body.status) return { status: 'failed', message: `The server answered HTTP ${res.status}.` };
    return body;
  } catch (e) {
    return { status: 'failed', message: 'Could not reach the server. Check your connection and try again.' };
  }
}

/** Ask every few seconds whether a newer snapshot has appeared (another visitor, or the morning job, may be loading it). */
export async function waitForNewer(previousGeneratedAt, { tries = 24, everyMs = 4000 } = {}) {
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, everyMs));
    try {
      const s = await (await fetch('/api/status', { cache: 'no-store' })).json();
      if (s.generatedAt && s.generatedAt !== previousGeneratedAt) return true;
    } catch { /* keep trying */ }
  }
  return false;
}
