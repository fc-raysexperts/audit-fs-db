import Link from 'next/link';
import { getView, getContext } from '../lib/data';
import PageHead from '../components/PageHead';
import { istStamp, longDate, ago } from '../../lib/format.mjs';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Update status - RPEL' };

// update-33: the page to open when the figures are not what you expect. It is READ-ONLY (it asks nothing of Zoho): it says what is saved, what is running, and what the last attempt did and why.
const OUTCOME = {
  refreshed: ['ok', 'Loaded'],
  flawed: ['warn', 'Loaded, with problems'],
  partial: ['info', 'Stopped at its time limit; the next part follows'],
  quota: ['warn', "Zoho's request limit was reached"],
  failed: ['bad', 'Did not work'],
};
const KIND = { manual: 'the Refresh button', auto: 'this page (automatic load)', continue: 'the next part of a load', cron: 'the morning job' };

export default async function UpdateStatus() {
  const view = await getView();
  const st = await getContext().status();
  const snap = view.snapshot ?? null;
  const m = snap?.meta ?? null;
  const last = st.lastAttempt ?? view.lastAttempt ?? null;
  const [cls, label] = last ? OUTCOME[last.status] ?? ['info', last.status] : [null, null];
  const cwip = snap?.cwip && !snap.cwip.error ? snap.cwip : null;
  const hist = snap?.register?.history && !snap.register.history.error ? snap.register.history : null;
  return (
    <>
      <PageHead title="Update status">
        {view.state === 'error'
          ? 'The saved statements cannot be read at the moment (below).'
          : view.state === 'empty'
            ? 'Nothing is saved for this year yet.'
            : view.state === 'fresh'
              ? "Today's statements are loaded."
              : view.state === 'stale'
                ? `The statements on screen are the last good ones, from ${longDate(m.istDate)}.${view.closed ? ' This year is closed, so they do not change.' : ''}`
                : "Today's run found problems; the figures may be incomplete."}
      </PageHead>

      {view.state === 'error' && <div className="notice bad" role="status"><b>The saved statements cannot be read.</b> {view.message}</div>}

      <section className="sheet" aria-label="What is saved">
        <div className="sheet-title"><h2>What is saved</h2><small>FY {view.fy}</small></div>
        <dl className="status-grid">
          <dt>Statements on screen</dt>
          <dd>{m ? <>from <b>{longDate(m.istDate)}</b>, loaded {istStamp(m.generatedAt)} ({ago(m.generatedAt)}); as at {longDate(m.asOf)}</> : 'none saved'}</dd>
          <dt>Today</dt>
          <dd>{longDate(view.today)}{view.closed ? ' (this year is closed: its figures do not move)' : ''}</dd>
          {cwip && <><dt>CWIP tab</dt><dd>{cwip.complete ? 'complete' : `being read in parts: ${cwip.pending} journals and bills still to read`}</dd></>}
          {hist && <><dt>Dep.Calc. (asset entries)</dt><dd>{hist.complete ? `complete (${hist.known} of ${hist.total} assets)` : `being read in parts: ${hist.known} of ${hist.total} assets known${hist.stalled ? ' - the last run could read no more' : ''}`}</dd></>}
        </dl>
      </section>

      <section className="sheet" aria-label="What is running">
        <div className="sheet-title"><h2>What is running</h2><small>{st.running ? 'an update is on' : 'nothing'}</small></div>
        <dl className="status-grid">
          <dt>Update right now</dt>
          <dd>{st.running ? <>yes, started about {st.running.forSeconds} s ago. It ends by itself within about a minute; if the hosting stopped it, the marker is gone after 2 minutes.</> : 'no'}</dd>
          <dt>Last attempt</dt>
          <dd>
            {last
              ? <><span className={`chip ${cls}`}>{label}</span> {istStamp(new Date(last.at).toISOString())}, started by {KIND[last.kind] ?? last.kind}{last.durationMs >= 1000 ? `, ${(last.durationMs / 1000).toFixed(0)} s` : ''}{last.calls ? `, ${last.calls} reads from Zoho Books` : ''}</>
              : 'none recorded yet'}
          </dd>
          {last?.message && <><dt>Why</dt><dd>{last.message}</dd></>}
          {last?.retryAt && last.retryAt > Date.now() && <><dt>Next try</dt><dd>from {istStamp(new Date(last.retryAt).toISOString())}</dd></>}
          <dt>Statements still in parts</dt>
          <dd>{st.more ? 'yes: the next part is started by the page itself, a minute after the last' : 'no'}</dd>
        </dl>
      </section>

      <section className="sheet" aria-label="What it means">
        <div className="sheet-title"><h2>What the words mean</h2></div>
        <p className="tbl-note" style={{ borderTop: 0 }}>
          <b>Loaded</b> - the statements were read from Zoho Books and saved. <b>Stopped at its time limit</b> - a load reads a great deal from Zoho Books; the hosting allows about a minute for each run, so a run
          that is not finished saves what it has read and the next run goes on from there (the page does this by itself). <b>Zoho's request limit</b> - Zoho Books lets every program that reads this organisation make
          only so many requests a minute and a day, and all your dashboards share that number; the page waits and tries again later. <b>Did not work</b> - the reason is written next to it (for example the Zoho sign-in
          was refused, or Redis could not be reached); waiting does not cure those, they need a change in the settings. The last good statements stay on screen in every case.
        </p>
        <p className="tbl-note"><Link href="/">Back to the statements</Link></p>
      </section>
    </>
  );
}
