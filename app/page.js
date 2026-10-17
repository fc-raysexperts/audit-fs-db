import Link from 'next/link';
import { getView } from './lib/data';
import gate from './components/Gate';
import Banner from './components/Banner';
import PageHead from './components/PageHead';
import Amt, { UnitName } from './components/Amt';
import BookletSummary from './components/BookletSummary';
import { longDate, istStamp, gap } from '../lib/format.mjs';
import { cashFlowSummary } from '../lib/cashflow.mjs';

export const dynamic = 'force-dynamic';

export default async function Overview() {
  const view = await getView();
  const blocked = gate(view);
  if (blocked) return blocked;
  const s = view.statements;
  const m = view.snapshot.meta;
  const { left, right, plSummary } = s.overview;
  const balanced = Math.abs(s.bs.gap) < 1;
  const tie = s.tie;
  const healthy = s.health.checksPassed === s.health.checksTotal && s.health.errors === 0;
  const cf = view.books ? cashFlowSummary(view.books.cashflow) : null;

  return (
    <>
      <Banner view={view} />
      <PageHead title={`Balance sheet as at ${longDate(m.asOf)}`}>
        {s.company}, standalone. Built from the Zoho Books Trial Balance the way the auditors build it.
      </PageHead>

      <p className="proof">
        {balanced
          ? <>Both sides come to <b><Amt v={s.bs.totalAssets} words /></b>. </>
          : <span style={{ color: 'var(--bad)' }}>The two sides differ by <Amt v={s.bs.gap} />. </span>}
        {tie
          ? tie.check === 0 && tie.noref === 0
            ? <span className="ok">All {tie.ok} lines agree with the audited statements, the largest gap being ₹{gap(tie.maxAbsDiffOk)}.</span>
            : <span style={{ color: 'var(--bad)' }}>{tie.check} of {tie.ok + tie.check} lines do not agree with the audited statements. <Link href="/reconciliation">See which</Link>.</span>
          : <>There are no audited figures for this date, so nothing is compared.</>}
      </p>

      <section className="sheet" aria-label="Balance sheet">
        <div className="sheet-title"><h2>Balance sheet</h2><small>FY {view.fy}, amounts in <UnitName /></small></div>
        <div className="tsheet">
          <div className="tside">
            <h3>Equity and liabilities</h3>
            <ul>{left.map((r) => <li key={r.label}><span>{r.label}</span><span className="num"><Amt v={r.value} /></span></li>)}</ul>
            <div className="ttotal"><span>Total</span><span className="num"><Amt v={s.bs.totalLiabilities} /></span></div>
          </div>
          <div className="tside">
            <h3>Assets</h3>
            <ul>{right.map((r) => <li key={r.label}><span>{r.label}</span><span className="num"><Amt v={r.value} /></span></li>)}</ul>
            <div className="ttotal"><span>Total</span><span className="num"><Amt v={s.bs.totalAssets} /></span></div>
          </div>
        </div>
        <p className="tbl-note">The full statement with every line and last year's audited figures is on the <Link href="/workbook/bs">Balance sheet</Link> and <Link href="/workbook/p-l">Profit and loss</Link> tabs.</p>
      </section>

      <div className="two brief">
        <section className="sheet" aria-label="Profit and loss in brief">
          <div className="sheet-title"><h2>Profit and loss</h2><small>FY {view.fy} against FY {s.prevFy}, audited</small></div>
          <div className="tablewrap">
            <table className="stmt">
              <thead><tr><th scope="col">Particulars</th><th scope="col" className="num">FY {view.fy}</th>{s.hasPrev && <th scope="col" className="num">FY {s.prevFy}</th>}</tr></thead>
              <tbody>
                {plSummary.map((r, i) => (
                  <tr key={r.label} className={i === plSummary.length - 1 ? 'k-grand' : i === 2 ? 'k-subtotal' : 'k-line'}>
                    <th scope="row">{r.label}</th>
                    <td className="num"><Amt v={r.value} /></td>
                    {s.hasPrev && <td className="num dim"><Amt v={r.prev} /></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="tbl-note">Brackets are negative figures. Tax, net is current tax, deferred tax and tax of earlier years together.</p>
        </section>

        {cf && (
          <section className="sheet" aria-label="Cash flow in brief">
            <div className="sheet-title"><h2>Cash flow</h2><small>FY {view.fy}{cf.hasPrev && <> against FY {s.prevFy}, audited</>}</small></div>
            <div className="tablewrap">
              <table className="stmt">
                <thead><tr><th scope="col">Particulars</th><th scope="col" className="num">FY {view.fy}</th>{cf.hasPrev && <th scope="col" className="num">FY {s.prevFy}</th>}</tr></thead>
                <tbody>
                  {cf.rows.map((r) => (
                    <tr key={r.key} className={r.key === 'cf_close' ? 'k-grand' : r.key === 'cf_net' ? 'k-subtotal' : 'k-line'}>
                      <th scope="row">{r.label}</th>
                      <td className="num"><Amt v={r.value} /></td>
                      {cf.hasPrev && <td className="num dim"><Amt v={r.prev} /></td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="tbl-note">
              {cf.closes
                ? <span className="ok">Closes: the cash at the end of the year is the cash on the balance sheet and in Note 17.</span>
                : <span style={{ color: 'var(--bad)' }}>The cash flow does not close to the balance sheet. See the <Link href="/workbook/cf">CF tab</Link>.</span>}
              {' '}Brackets are cash going out. Every line is on the <Link href="/workbook/cf">CF tab</Link>.
            </p>
          </section>
        )}
      </div>

      <section className="sheet" aria-label="How far to trust these figures">
        <div className="sheet-title"><h2>How far to trust this</h2></div>
        <ul className="facts">
          <li><span>Checks passed</span><span className={`v ${healthy ? 'good' : 'badtxt'}`}>{s.health.checksPassed} of {s.health.checksTotal}</span></li>
          <li><span>Alerts</span><span className={`v ${s.health.errors ? 'badtxt' : ''}`}>{s.health.errors} errors, {s.health.warnings} warnings</span></li>
          <li><span>Lines agreeing with the audit</span><span className="v">{tie ? `${tie.ok} of ${tie.ok + tie.check + tie.phase2 + tie.noref}` : 'not compared'}</span></li>
          <li><span>Loaded from Zoho Books</span><span className="v">{istStamp(m.generatedAt)}</span></li>
          <li><span>Zoho calls, time taken</span><span className="v">{m.apiCalls}, {(m.durationMs / 1000).toFixed(0)} s</span></li>
          <li><span>Ledger lines read</span><span className="v">{m.ledger.lines.toLocaleString('en-IN')}</span></li>
          <li><Link href="/checks">All checks and alerts</Link><span /></li>
        </ul>
      </section>

      <BookletSummary view={view} />
    </>
  );
}
