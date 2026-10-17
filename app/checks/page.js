import { getView } from '../lib/data';
import gate from '../components/Gate';
import Banner from '../components/Banner';
import PageHead from '../components/PageHead';
import BookletSummary from '../components/BookletSummary';
import { istStamp, longDate, gap } from '../../lib/format.mjs';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Checks and alerts - RPEL' };

const LEVEL = { error: ['bad', 'Error'], warn: ['warn', 'Warning'], info: ['info', 'Note'] };

export default async function Checks() {
  const view = await getView();
  const blocked = gate(view);
  if (blocked) return blocked;
  const snap = view.snapshot;
  const m = snap.meta;
  const failed = snap.checks.filter((c) => !c.ok);
  return (
    <>
      <Banner view={view} />
      <PageHead title="Checks and alerts">
        {failed.length === 0 && m.errors === 0
          ? `All ${snap.checks.length} checks pass. Each one proves a total from a different direction, so a wrong figure cannot hide.`
          : `${failed.length} of ${snap.checks.length} checks fail. Do not rely on the figures until these are explained.`}
      </PageHead>

      <section className="sheet" aria-label="Alerts">
        <div className="sheet-title"><h2>Alerts</h2><small>{snap.alerts.length === 0 ? 'none' : `${snap.alerts.length} raised`}</small></div>
        {snap.alerts.length === 0 ? (
          <p className="tbl-note" style={{ borderTop: 0 }}>Nothing needs attention. Alerts appear here when an account has no home on the statements, a journal changed after it was cached, or a figure needed a judgment the auditors made for another date.</p>
        ) : (
          <div className="tablewrap"><table><thead><tr><th scope="col">Level</th><th scope="col">What happened</th></tr></thead><tbody>
            {snap.alerts.map((a, i) => { const [cls, t] = LEVEL[a.level] ?? ['info', a.level]; return (
              <tr key={i}><td><span className={`chip ${cls}`}>{t}</span></td><td>{a.message}<div className="dim small">{a.code}</div></td></tr>
            ); })}
          </tbody></table></div>
        )}
      </section>

      <section className="sheet" aria-label="Checks">
        <div className="sheet-title"><h2>Checks</h2><small>{snap.checks.length - failed.length} of {snap.checks.length} pass</small></div>
        <div className="tablewrap">
          <table>
            <thead><tr><th scope="col">Check</th><th scope="col" className="num">Difference in ₹</th><th scope="col">Result</th></tr></thead>
            <tbody>
              {snap.checks.map((c) => (
                <tr key={c.key}>
                  <th scope="row" style={{ fontWeight: 400 }}>{c.label}</th>
                  <td className="num dim">{gap(c.value)}</td>
                  <td><span className={`chip ${c.ok ? 'ok' : 'bad'}`}>{c.ok ? 'Pass' : 'Fail'}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <BookletSummary view={view} />

      <section className="sheet" aria-label="About this load">
        <div className="sheet-title"><h2>About this load</h2></div>
        <ul className="facts">
          <li><span>Financial year, as at</span><span className="v">FY {m.fy}, {longDate(m.asOf)}</span></li>
          <li><span>Loaded from Zoho Books</span><span className="v">{istStamp(m.generatedAt)}</span></li>
          <li><span>Time taken, Zoho calls</span><span className="v">{(m.durationMs / 1000).toFixed(1)} s, {m.apiCalls}</span></li>
          <li><span>Trial Balance</span><span className="v">{m.tb.accounts} accounts, {m.tb.basis.toLowerCase()} basis</span></li>
          <li><span>Trial Balance made by Zoho at</span><span className="v">{m.tb.zohoGeneratedAt}</span></li>
          <li><span>Supplier ledger</span><span className="v">{m.ledger.lines.toLocaleString('en-IN')} lines, {m.ledger.pages} pages</span></li>
          <li><span>Journals read line by line</span><span className="v">{m.ledger.journalsRead} ({m.ledger.journalsFromCache} from the cache, {m.ledger.journalsRefetched} read again)</span></li>
          <li><span>Compared with</span><span className="v">{m.audited ? m.audited.basis : 'nothing (no audited figures for this date)'}</span></li>
        </ul>
        {m.tb.inventoryJobRunning && <p className="tbl-note">Zoho was still recalculating inventory when the Trial Balance was made, so stock figures may move on the next load.</p>}
      </section>
    </>
  );
}
