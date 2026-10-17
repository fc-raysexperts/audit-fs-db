import Amt from './Amt';

/** "Made up of": the Zoho Books accounts or statement lines behind a figure, folded away until asked for. */
export default function Made({ made, cell }) {
  if (!made?.length && !cell) return null;
  return (
    <details className="made">
      <summary>{made?.length ? `made up of ${made.length} ${made.length === 1 ? 'item' : 'items'}` : 'source'}</summary>
      {made?.length > 0 && (
        <ul>
          {made.map((m, i) => (
            <li key={i} className={m.items ? 'has-items' : ''}>
              <span>{m.label}</span><span className="num"><Amt v={m.value} /></span>
              {m.items && (
                <ul className="accounts">
                  {m.items.map((a, j) => <li key={j}><span>{a.label}</span><span className="num"><Amt v={a.value} /></span></li>)}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
      {cell && <p className="small dim">Cell in the audited workbook: {cell}</p>}
    </details>
  );
}
