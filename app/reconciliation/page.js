import { getView } from '../lib/data';
import gate from '../components/Gate';
import Banner from '../components/Banner';
import PageHead from '../components/PageHead';
import Amt from '../components/Amt';
import { gap } from '../../lib/format.mjs';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Audit tie-out - RPEL' };

const SECTIONS = [['pl', 'Profit and loss'], ['bs', 'Balance sheet lines that come straight from the Trial Balance'], ['party', 'Lines built from the party ledgers (suppliers, advances, retention, outstanding expenses)']];
const CHIP = { OK: ['ok', 'Agrees'], CHECK: ['bad', 'Differs'], PHASE2: ['warn', 'Later phase'], NOREF: ['info', 'No audited line'] };

export default async function Reconciliation() {
  const view = await getView();
  const blocked = gate(view);
  if (blocked) return blocked;
  const rec = view.snapshot.reconciliation;
  return (
    <>
      <Banner view={view} />
      <PageHead title="Audit tie-out">
        Every line built from Zoho Books, set beside the figure in the audited statements.
        {rec ? ` A line agrees when the difference is within ₹${rec.tolerance}, because the audited workbook rounds each line to whole rupees.` : ''}
      </PageHead>

      {!rec ? (
        <div className="notice warn">The audited statements are for {view.snapshot.meta.audited?.asAt ?? '31 March 2026'} only, so there is nothing to compare these figures with.</div>
      ) : (
        <>
          <p className="proof">
            <span className={rec.summary.check === 0 ? 'ok' : ''} style={rec.summary.check ? { color: 'var(--bad)' } : undefined}>
              {rec.summary.ok} lines agree{rec.summary.check ? `, ${rec.summary.check} differ` : ''}.
            </span>{' '}
            The largest difference is ₹{gap(rec.summary.maxAbsDiffOk)}.
          </p>
          <p className="dim small" style={{ marginBottom: 20 }}>{view.snapshot.meta.audited?.basis}</p>
          {SECTIONS.map(([sec, title]) => {
            const rows = rec.rows.filter((r) => r.section === sec);
            if (!rows.length) return null;
            return (
              <section className="sheet" key={sec} aria-label={title}>
                <div className="sheet-title"><h2>{title}</h2></div>
                <div className="tablewrap">
                  <table className="stmt recon">
                    <thead><tr><th scope="col">Line</th><th scope="col" className="num">From Zoho Books</th><th scope="col" className="num">Audited</th><th scope="col" className="num">Difference in ₹</th><th scope="col" className="res">Result</th></tr></thead>
                    <tbody>
                      {rows.map((r) => {
                        const [cls, text] = CHIP[r.status] ?? ['info', r.status];
                        return (
                          <tr key={r.key}>
                            <th scope="row">{r.label}</th>
                            <td className="num"><Amt v={r.value} /></td>
                            <td className="num dim"><Amt v={r.audited} /></td>
                            <td className="num dim">{gap(r.diff)}</td>
                            <td><span className={`chip ${cls}`}>{text}</span></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            );
          })}
        </>
      )}
    </>
  );
}
