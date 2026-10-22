import Amt from './Amt';
import { gap, longDate } from '../../lib/format.mjs';

// update-31: under the Balance Sheet and the Profit and Loss - last year (31 March 2025) as Zoho Books gives it, line by line, beside the figures the auditors signed for it.
// Information only: a line that differs says why; the panel never asks for a change in the books (2024-25 is audited and closed).

const RESULT = { OK: ['ok', 'Agrees'], EXPL: ['info', 'Explained'], DIFF: ['warn', 'Differs'], NONE: ['mute', 'Not compared'] };

function Rows({ rows }) {
  return (
    <div className="tablewrap">
      <table className="stmt recon">
        <thead>
          <tr>
            <th scope="col">Particulars</th>
            <th scope="col" className="num">From Zoho Books</th>
            <th scope="col" className="num">As signed</th>
            <th scope="col" className="num">Difference in ₹</th>
            <th scope="col" className="res">Result</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            if (r.kind === 'heading') return <tr key={r.id} className="k-heading lv-0"><th scope="colgroup" colSpan={5}>{r.label}</th></tr>;
            const [cls, word] = RESULT[r.status] ?? ['mute', r.status];
            return (
              <tr key={r.id} className={`k-${r.kind} lv-${r.level}`}>
                <th scope="row">{r.label}</th>
                <td className="num"><Amt v={r.zoho} /></td>
                <td className="num dim"><Amt v={r.signed} /></td>
                <td className="num dim">{gap(r.diff)}</td>
                <td className="res"><span className={`chip ${cls}`}>{word}</span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * @param {{prior: object|null, kind: 'bs'|'pl'}} props  prior = view.prior (lib/prior.mjs buildPriorView); null = the year has no last-year configuration
 */
export default function PriorYearPanel({ prior, kind }) {
  if (!prior) return null;
  if (prior.error) {
    return (
      <section className="sheet" aria-label="Last year in Zoho Books">
        <div className="sheet-title"><h2>Last year in Zoho Books</h2></div>
        <div className="notice warn" style={{ margin: '0 20px 16px' }}>Last year could not be shown from Zoho Books: {prior.error} The signed figures above are unchanged.</div>
      </section>
    );
  }
  const s = prior.summary;
  const asAt = longDate(prior.to);
  const rows = kind === 'bs' ? [...prior.bs.liabilities, ...prior.bs.assets, ...prior.bs.party] : prior.pl;
  const compared = rows.filter((r) => r.status);
  const count = (st) => compared.filter((r) => r.status === st).length;
  const here = { ok: count('OK'), expl: count('EXPL'), diff: count('DIFF'), none: count('NONE') };
  const explained = prior.explained.filter((e) => compared.some((r) => r.id === e.id));
  const failed = prior.checks.filter((c) => !c.ok);

  return (
    <section className="sheet" aria-label="Last year in Zoho Books">
      <div className="sheet-title"><h2>{kind === 'bs' ? `Balance sheet of last year in Zoho Books, as at ${asAt}` : `Profit and loss of last year in Zoho Books, for the year ended ${asAt}`}</h2><small>FY {prior.fy}</small></div>
      <p className="proof">
        {!prior.hasSigned
          ? <>There are no signed figures for last year to compare with.</>
          : (
            <>
              <span className={here.diff === 0 ? 'ok' : ''} style={here.diff ? { color: 'var(--bad)' } : undefined}>
                {here.ok} of {compared.length} lines agree with the signed statements
              </span>
              {here.expl > 0 && <>, {here.expl} differ by a reclassification that is explained below</>}
              {here.diff > 0 && <>, {here.diff} differ and nothing explains it</>}
              .
            </>
          )}
      </p>
      <p className="tbl-note" style={{ borderTop: 0, paddingTop: 0 }}>
        Zoho Books&apos; Trial Balance up to {asAt} is built into the statements with the same rules as this year; the {prior.accounts} accounts of the old chart are assigned to their lines in the last-year configuration.
        {' '}The signed figures are the last-year column of the signed statements. A line agrees when the difference is within ₹5. Last year is audited and closed, so a difference is only explained here, never a request to change Zoho.
      </p>

      <Rows rows={rows} />

      {kind === 'bs' && prior.partyText && <p className="tbl-note">{prior.partyText}</p>}
      {explained.length > 0 && (
        <>
          <h3 className="side-title">Differences that are explained</h3>
          <ul className="proofs">
            {explained.map((e) => (
              <li key={e.id} style={{ display: 'block' }}><strong>{e.label}</strong>: difference <Amt v={e.diff} words />. {e.text}</li>
            ))}
          </ul>
          {prior.explainNote && <p className="tbl-note">{prior.explainNote}</p>}
        </>
      )}
      {failed.length > 0 && (
        <p className="tbl-note" style={{ color: 'var(--bad)' }}>
          {failed.map((c) => c.label).join('; ')}: this did not hold for the Trial Balance of last year, so the figures above may be incomplete. See Checks and alerts.
        </p>
      )}
      <p className="tbl-note">
        Only the {kind === 'bs' ? 'Balance Sheet' : 'Profit and Loss'} of last year is read from Zoho Books. The notes, the cash flow, the fixed asset schedule, the ratios and the ageing of last year stay as signed
        {kind === 'bs' ? ', and the subtotals above leave out the group of supplier lines on both sides' : ''}.
      </p>
    </section>
  );
}
