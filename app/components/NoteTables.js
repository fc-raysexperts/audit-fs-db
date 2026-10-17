import Figure from './Figure';
import Tie from './Tie';
import { gap } from '../../lib/format.mjs';

// A cell of a note's small table: { text } | { value, fmt?, fixed?, audited?, diff?, status? }
function Cell({ c, unit }) {
  if (c.text !== undefined) return <th scope="row">{c.text}</th>;
  const u = c.fmt === 'pct' ? 'fraction' : (unit ?? 'rupees');
  return (
    <td className={`num ${c.fixed ? 'fixed' : ''}`}>
      <Figure v={c.value} unit={u} />{c.status && <> <Tie status={c.status} diff={c.diff} unit={u === 'rupees' ? 'rupees' : 'x'} /></>}
    </td>
  );
}

/** The ageing tables and share tables that sit under some notes. Figures in grey are the auditors' own (fixed at the audit date). */
export default function NoteTables({ tables }) {
  if (!tables?.length) return null;
  return tables.map((t) => (
    <div key={t.title}>
      <h3 className="subtitle">{t.title}</h3>
      <div className="tablewrap">
        <table className="tbl-plain">
          <thead><tr>{t.columns.map((c, i) => <th key={c} scope="col" className={i ? 'num' : ''}>{c}</th>)}</tr></thead>
          <tbody>
            {t.rows.map((row, i) => (
              <tr key={i} className={i === t.rows.length - 1 && /total|end of the year/i.test(row[0].text ?? '') ? 'last' : ''}>
                {row.map((c, j) => <Cell key={j} c={c} unit={t.unit === 'rupees' ? 'rupees' : t.unit} />)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {t.ties?.length > 0 && (
        <ul className="proofs">
          {t.ties.map((x) => (
            <li key={x.label}><span className={`chip ${x.status === 'OK' ? 'ok' : 'bad'}`}>{x.status === 'OK' ? 'Agrees' : 'Differs'}</span><span>{x.label}</span><span className="d">difference ₹{gap(x.diff)}</span></li>
          ))}
        </ul>
      )}
    </div>
  ));
}
