import Amt from './Amt';
import Tie from './Tie';

/** A statement as the audited workbook lays it out: headings, lines, indented note lines, subtotals, double-ruled grand totals. */
export default function StatementTable({ rows, fy, prevFy, showPrev, showTie }) {
  const cols = 2 + (showPrev ? 1 : 0) + (showTie ? 1 : 0);
  return (
    <div className="tablewrap">
      <table className="stmt">
        <thead>
          <tr>
            <th scope="col">Particulars</th>
            <th scope="col" className="num">FY {fy}</th>
            {showPrev && <th scope="col" className="num">FY {prevFy}, audited</th>}
            {showTie && <th scope="col" className="tie-col"><span title="Compared with the audited figure for this year">Audited</span></th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) =>
            r.kind === 'heading' ? (
              <tr key={r.id} className="k-heading lv-0"><th scope="colgroup" colSpan={cols}>{r.label}</th></tr>
            ) : (
              <tr key={r.id} className={`k-${r.kind} lv-${r.level}`}>
                <th scope="row">{r.label}{r.missing && <span className="chip bad" style={{ marginLeft: 8 }}>not in snapshot</span>}</th>
                <td className="num"><Amt v={r.value} /></td>
                {showPrev && <td className="num dim"><Amt v={r.prev} /></td>}
                {showTie && <td className="tie-col"><Tie status={r.status} diff={r.diff} /></td>}
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}
