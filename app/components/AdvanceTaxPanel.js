import Amt from './Amt';
import { longDate, plain } from '../../lib/format.mjs';

// update-30: under the Computation tab - the advance tax payment by payment (from the ledger of the advance tax accounts in Zoho Books) and the interest on tax worked out again.
// Information beside the computation: where the working gives another amount it says so and why; it never asks for a change in the books (they are audited and closed).

const RESULT = { OK: ['ok', 'Agrees'], EXPL: ['info', 'Explained'], DIFF: ['warn', 'Differs'], NONE: ['mute', 'Not checked'] };
const SUB = { display: 'block', color: 'var(--muted)', fontSize: 13, lineHeight: 1.35 };
const pct = (f) => (f === null || f === undefined ? '' : plain(f, 'fraction'));

export default function AdvanceTaxPanel({ advance }) {
  if (!advance) return null;
  const a = advance;
  const m = a.summary;
  return (
    <section className="sheet" aria-label="Advance tax and interest on tax">
      <div className="sheet-title"><h2>{a.panel?.title ?? 'Advance tax and interest on tax'}</h2><small>Ledger of the advance tax accounts in Zoho Books</small></div>
      {!a.available ? (
        <div className="notice warn live-problem">{a.why ?? 'The advance tax working is not available.'} The computation above is not affected; the interest stays as the auditors have it.</div>
      ) : (
        <>
          <p className="proof">
            <span className={m.diff === 0 && m.none === 0 ? 'ok' : ''}>{m.ok} of {m.lines} checks agree</span>
            {m.diff > 0 && <>; {m.diff === 1 ? '1 gives' : `${m.diff} give`} another amount, with the reason below</>}
            {m.none > 0 && <>; {m.none} could not be checked</>}.
            {' '}The interest on tax worked out again from these payments is <b><Amt v={a.worked?.total ?? null} words /></b>{a.worked && a.signed !== null && <>; the auditors have <b><Amt v={a.signed} words /></b></>}.
          </p>
          {a.problems.length > 0 && <div className="notice bad live-problem"><b>Part of this working could not run.</b> {a.problems.join(' · ')}</div>}

          <h3 className="side-title">Payments of the year</h3>
          <div className="tablewrap">
            <table className="tbl-plain">
              <thead>
                <tr><th scope="col">Paid on</th><th scope="col">Entry in Zoho</th><th scope="col" className="num">Amount</th><th scope="col" className="num">Paid so far</th><th scope="col" className="num">Share of the tax</th></tr>
              </thead>
              <tbody>
                {a.payments.map((p) => (
                  <tr key={`${p.date}-${p.entry}-${p.account}`}>
                    <th scope="row">
                      {longDate(p.date)}
                      {!p.inYear && <span style={SUB}>Outside the financial year</span>}
                    </th>
                    <td>
                      {p.entry}
                      {p.narration && <span style={SUB}>{p.narration}</span>}
                    </td>
                    <td className="num"><Amt v={p.amount} /></td>
                    <td className="num dim"><Amt v={p.cumulative} /></td>
                    <td className="num dim">{pct(p.percent)}</td>
                  </tr>
                ))}
                <tr className="last"><th scope="row">Advance tax paid in the year</th><td /><td className="num"><Amt v={a.paid} /></td><td /><td className="num">{pct(a.assessed > 0 ? a.paid / a.assessed : null)}</td></tr>
              </tbody>
            </table>
          </div>
          {a.journals.length > 0 && (
            <p className="tbl-note">
              {a.journals.map((j) => `${j.entry} (${longDate(j.date)}): ${j.narration || 'journal'}`).join('; ')}.
              {' '}Share of the tax = paid so far ÷ the tax payable for the year before advance tax, less TDS (<Amt v={a.assessed} words />).
            </p>
          )}

          <h3 className="side-title">Checks</h3>
          <div className="tablewrap">
            <table className="tbl-plain">
              <thead>
                <tr><th scope="col">Check</th><th scope="col" className="num">Computation</th><th scope="col" className="num">Zoho ledger</th><th scope="col" className="num">Difference</th><th scope="col">Result</th></tr>
              </thead>
              <tbody>
                {a.checks.map((c) => {
                  const [cls, word] = RESULT[c.status] ?? ['mute', c.status];
                  const show = (v) => (v === null || v === undefined ? '–' : c.count ? plain(v, 'shares') : <Amt v={v} />);
                  return (
                    <tr key={c.id}>
                      <th scope="row">
                        {c.title}
                        {c.text && <span style={SUB}>{c.text}</span>}
                      </th>
                      <td className="num">{show(c.signed)}</td>
                      <td className="num">{show(c.zoho)}</td>
                      <td className="num dim">{c.diff === null || c.diff === undefined || Math.abs(c.diff) < 0.005 ? '' : show(c.diff)}</td>
                      <td><span className={`chip ${cls}`}>{word}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {a.worked && (
            <>
              <h3 className="side-title">Interest on tax, worked out again</h3>
              <div className="tablewrap">
                <table className="tbl-plain">
                  <thead>
                    <tr>
                      <th scope="col">Section 234C: instalment due</th>
                      <th scope="col" className="num">Should have been paid</th>
                      <th scope="col" className="num">Paid by then</th>
                      <th scope="col" className="num">Shortfall</th>
                      <th scope="col" className="num">Interest</th>
                    </tr>
                  </thead>
                  <tbody>
                    {a.instalments.map((r) => (
                      <tr key={r.due}>
                        <th scope="row">
                          {longDate(r.due)}
                          <span style={SUB}>{pct(r.upto)} of the tax, interest for {r.months} {r.months === 1 ? 'month' : 'months'}{r.relieved ? `; no interest, because ${pct(r.relief)} had been paid` : ''}</span>
                        </th>
                        <td className="num"><Amt v={r.need} /></td>
                        <td className="num"><Amt v={r.paid} /></td>
                        <td className="num"><Amt v={r.shortfall} /></td>
                        <td className="num"><Amt v={r.interest} /></td>
                      </tr>
                    ))}
                    <tr className="last"><th scope="row">Section 234C</th><td /><td /><td /><td className="num"><Amt v={a.c234} /></td></tr>
                    <tr>
                      <th scope="row">
                        Section 234B: the whole year
                        <span style={SUB}>
                          {a.b234.applies
                            ? `${pct(a.b234.percent)} of the tax was paid by 31 March (less than 90%): 1% a month for ${a.b234.months} months on the shortfall`
                            : `${pct(a.b234.percent)} of the tax was paid by 31 March (90% or more): no interest`}
                        </span>
                      </th>
                      <td className="num"><Amt v={a.b234.assessed} /></td>
                      <td className="num"><Amt v={a.b234.paid} /></td>
                      <td className="num"><Amt v={a.b234.shortfall} /></td>
                      <td className="num"><Amt v={a.b234.interest} /></td>
                    </tr>
                    <tr className="last"><th scope="row">Interest on tax, worked out again</th><td /><td /><td /><td className="num"><Amt v={a.worked.total} /></td></tr>
                    {a.signed !== null && <tr><th scope="row">Interest in the computation (the auditors' figure)</th><td /><td /><td /><td className="num"><Amt v={a.signed} /></td></tr>}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
      {a.info?.length > 0 && (
        <div className="tbl-note"><ul className="stays">{a.info.map((x) => <li key={x}>{x}</li>)}</ul></div>
      )}
      {a.stays?.length > 0 && (
        <div className="tbl-note">
          <b>Kept as the auditors have it, because Zoho Books cannot give it:</b>
          <ul className="stays">{a.stays.map((x) => <li key={x}>{x}</li>)}</ul>
        </div>
      )}
      {a.panel?.foot && <p className="tbl-note">{a.panel.foot}</p>}
    </section>
  );
}
