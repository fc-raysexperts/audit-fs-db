import Figure from './Figure';
import Tie from './Tie';
import Made from './Made';
import { change } from '../../lib/format.mjs';

/**
 * Rows of a note, the cash flow, the ratios or a tax working. Each row: { kind, label, detail, value, fy25, status, diff, unit, made, ref }.
 * kind: heading | line | memo (a working line that is not added) | ratio | subtotal | total
 */
export default function LedgerTable({ rows, fy, prevFy, showPrev = true, showTie = false, showChange = false, valueHead, prevHead }) {
  const cols = 2 + (showPrev ? 1 : 0) + (showChange ? 1 : 0) + (showTie ? 1 : 0);
  return (
    <div className="tablewrap">
      <table className="stmt">
        <thead>
          <tr>
            <th scope="col">Particulars</th>
            <th scope="col" className="num">{valueHead ?? `FY ${fy}`}</th>
            {showPrev && <th scope="col" className="num">{prevHead ?? `FY ${prevFy}, audited`}</th>}
            {showChange && <th scope="col" className="num">Change</th>}
            {showTie && <th scope="col" className="tie-col"><span title="Compared with the audited figure for this year">Audited</span></th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) =>
            r.kind === 'heading' ? (
              <tr key={r.key ?? i} className="k-heading lv-0"><th scope="colgroup" colSpan={cols}>{r.label}</th></tr>
            ) : (
              <tr key={r.key ?? i} className={`k-${r.kind ?? 'line'}`}>
                <th scope="row" title={r.ref ? `Cell in the audited workbook: ${r.ref}` : undefined}>
                  {r.label}
                  {r.detail && <span className="detail">{r.detail}</span>}
                  {r.numerator && <span className="detail">{r.numerator} ÷ {r.denominator}</span>}
                  {r.reason && r.reason !== 'N.A.' && <span className="detail why">{r.reason}</span>}
                  {r.made?.length > 0 && <Made made={r.made} cell={r.ref} />}
                </th>
                <td className="num"><Figure v={r.value} unit={r.unit} /></td>
                {showPrev && <td className="num dim"><Figure v={r.fy25} unit={r.unit} /></td>}
                {showChange && <td className="num dim">{change(r.variance)}</td>}
                {showTie && <td className="tie-col"><Tie status={r.status} diff={r.diff} unit={r.unit} /></td>}
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}
