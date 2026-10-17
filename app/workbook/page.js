import Link from 'next/link';
import { getView, getContext } from '../lib/data';
import gate from '../components/Gate';
import Banner from '../components/Banner';
import PageHead from '../components/PageHead';
import Badge from '../components/Badge';
import SheetTabs from '../components/SheetTabs';
import { longDate } from '../../lib/format.mjs';
import { INDEX_ID, sheetHref } from '../../lib/tabs.mjs';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Workbook - RPEL' };

/** The first tab, like the cover of the Excel file: every sheet, how much of it is live, and a link to its tab. */
export default async function Workbook() {
  const view = await getView();
  const blocked = gate(view);
  if (blocked) return blocked;
  let model = null;
  let tabsError = null;
  try { model = getContext().tabs(); } catch (e) { tabsError = e.message; }
  const w = view.workbook;
  const strip = model && <SheetTabs tabs={model.tabs} active={INDEX_ID} />;
  if (!w) {
    return (
      <>
        <Banner view={view} />
        {strip}
        <PageHead title="Workbook" />
        {view.booksError
          ? <div className="notice bad"><b>This page could not be built.</b> The reason: {view.booksError}</div>
          : <div className="notice warn">The list of sheets is not set up for FY {view.fy} yet (config/workbook.fy{view.fy.slice(-2)}).</div>}
      </>
    );
  }
  const s = w.summary;
  return (
    <>
      <Banner view={view} />
      {strip}
      {tabsError && <div className="notice bad"><b>The tabs could not be set up.</b> The reason: {tabsError}</div>}
      <PageHead title="All sheets of the audited workbook">
        Every one of the {s.sheets} sheets of the signed workbook has its own tab above, in the order of the Excel file (the three Notes sheets 3 to 27 are kept together on one tab). {s.live} are rebuilt from Zoho Books at every refresh, {s.semi} partly, and {s.fixed} are the auditors' own working or text, shown as signed.
        {s.ties > 0 && ' Where a signed working carries a total that must agree with a live figure, the two are compared.'}
      </PageHead>

      <p className="proof">
        {s.tiesBad === 0
          ? <span className="ok">All {s.ties} totals in the signed workings agree with the live figures, the largest gap being ₹{s.maxDiff.toFixed(2)}.</span>
          : <span style={{ color: 'var(--bad)' }}>{s.tiesBad} of {s.ties} totals in the signed workings do not agree with the live figures.</span>}
        {s.liveSheets > 0 && (
          <> On the {s.liveSheets} customer, vendor and account lists, {(s.liveOk + s.liveName + s.liveLump).toLocaleString('en-IN')} of {s.liveLines.toLocaleString('en-IN')} lines give the same figure in Zoho today
            {s.liveDiff + s.liveNone > 0 && <>; the other {(s.liveDiff + s.liveNone).toLocaleString('en-IN')} are listed on each sheet</>}.</>
        )}
      </p>

      {w.groups.map((g) => (
        <section className="sheet" key={g.name} aria-label={g.name}>
          <div className="sheet-title"><h2>{g.name}</h2><small>{g.sheets.length} {g.sheets.length === 1 ? 'sheet' : 'sheets'}</small></div>
          <div className="tablewrap">
            <table className="registry">
              <thead><tr><th scope="col">Sheet</th><th scope="col">Status</th><th scope="col">What it is</th><th scope="col">Open</th></tr></thead>
              <tbody>
                {g.sheets.map((x) => {
                  const href = model ? sheetHref(model, x.id) : null;
                  return (
                    <tr key={x.id}>
                      <th scope="row" style={{ fontWeight: 500 }}>{x.sheet}{x.hidden && <span className="dim small"> (hidden in the file)</span>}</th>
                      <td><Badge status={x.status} /></td>
                      <td className="what">
                        {x.note}
                        {x.liveCheck && !x.liveCheck.error && (
                          <div style={{ marginTop: 4 }}>
                            <span className={`chip ${x.liveCheck.diff === 0 && x.liveCheck.none === 0 ? 'ok' : 'info'}`}>Checked line by line</span>
                            <span className="dim small"> {(x.liveCheck.ok + x.liveCheck.name + x.liveCheck.lump).toLocaleString('en-IN')} of {x.liveCheck.lines.toLocaleString('en-IN')} lines agree{x.liveCheck.diff + x.liveCheck.none > 0 && <>, {x.liveCheck.diff + x.liveCheck.none} to look at</>}</span>
                            {x.liveCheck.columns?.length > 0 && <div className="dim small" style={{ marginTop: 2 }}>{x.liveCheck.columns.length} more columns checked: {x.liveCheck.columns.map((c) => `${c.label.replace(/ \(.*\)$/, '')} ${c.ok} of ${c.ok + c.diff}`).join(' · ')}</div>}
                          </div>
                        )}
                        {x.liveCheck?.error && <div style={{ marginTop: 4 }}><span className="chip bad">Line check failed</span> <span className="dim small">{x.liveCheck.error}</span></div>}
                        {x.ties.length > 0 && (
                          <div style={{ marginTop: 4 }}>
                            <span className={`chip ${x.tieStatus === 'OK' ? 'ok' : 'bad'}`}>{x.tieStatus === 'OK' ? 'Agrees with the live figures' : 'Differs from the live figures'}</span>
                            <span className="dim small"> {x.ties.filter((t) => t.status === 'OK').length} of {x.ties.length} totals</span>
                          </div>
                        )}
                      </td>
                      <td className="links">{href && <Link href={href}>Open tab</Link>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ))}
      <p className="dim small">Sheets shown as signed are exported from the audited file for the year ended {longDate(w.asAt)}. The tax-portal sign-in details and the company's PAN that appear in the file are left out.</p>
    </>
  );
}
