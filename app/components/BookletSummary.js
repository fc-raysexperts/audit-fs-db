import Link from 'next/link';

/** One table: every part of the booklet beyond the two statements, how many lines were compared with the audit, and whether they agree. */
export default function BookletSummary({ view }) {
  const b = view.books;
  const w = view.workbook;
  if (!b && !w && !view.booksError) return null;
  if (view.booksError) {
    return (
      <section className="sheet" aria-label="The rest of the booklet">
        <div className="sheet-title"><h2>Notes, cash flow and other workings</h2></div>
        <p className="tbl-note" style={{ borderTop: 0, color: 'var(--bad)' }}>They could not be built: {view.booksError}</p>
      </section>
    );
  }
  const parts = b?.summary.parts ?? [];
  const hasTie = b?.summary.hasTie;
  return (
    <section className="sheet" aria-label="The rest of the booklet">
      <div className="sheet-title"><h2>Notes, cash flow and other workings</h2><small>Rebuilt live, compared with the audited workbook</small></div>
      <div className="tablewrap">
        <table className="tbl-plain">
          <thead><tr><th scope="col">Part</th><th scope="col" className="num">Lines compared</th><th scope="col" className="num">Differing</th><th scope="col">Result</th></tr></thead>
          <tbody>
            {parts.map((p) => (
              <tr key={p.name}>
                <th scope="row"><Link href={p.href}>{p.name}</Link></th>
                <td className="num">{hasTie ? p.lines : '–'}</td>
                <td className="num">{hasTie ? p.check + p.checks : '–'}</td>
                <td><span className={`chip ${p.ok ? 'ok' : 'bad'}`}>{p.ok ? 'Agrees' : 'Differs'}</span></td>
              </tr>
            ))}
            {w && w.summary.liveSheets > 0 && (
              <tr>
                <th scope="row"><Link href="/workbook">Customer, vendor and account lists ({w.summary.liveSheets} sheets), line by line</Link></th>
                <td className="num">{w.summary.liveLines.toLocaleString('en-IN')}</td>
                <td className="num">{(w.summary.liveDiff + w.summary.liveNone).toLocaleString('en-IN')}</td>
                <td>
                  <span className={`chip ${w.summary.liveDiff + w.summary.liveNone === 0 ? 'ok' : 'info'}`} title="A line that differs is information: the auditors regrouped some lines after the ledger closed">
                    {w.summary.liveDiff + w.summary.liveNone === 0 ? 'Agrees' : `${(w.summary.liveOk + w.summary.liveName + w.summary.liveLump).toLocaleString('en-IN')} agree`}
                  </span>
                </td>
              </tr>
            )}
            {w && (
              <tr>
                <th scope="row"><Link href="/workbook">Auditors' signed workings ({w.summary.fixed + w.summary.semi} sheets)</Link></th>
                <td className="num">{w.summary.ties}</td>
                <td className="num">{w.summary.tiesBad}</td>
                <td><span className={`chip ${w.summary.tiesBad === 0 ? 'ok' : 'bad'}`}>{w.summary.tiesBad === 0 ? 'Agrees' : 'Differs'}</span></td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="tbl-note">Every sheet of the audited workbook has its own tab under <Link href="/workbook">Workbook</Link>.</p>
    </section>
  );
}
