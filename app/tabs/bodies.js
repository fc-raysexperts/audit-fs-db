import booksGate from '../components/BooksGate';
import PageHead from '../components/PageHead';
import LedgerTable from '../components/LedgerTable';
import NoteTables from '../components/NoteTables';
import StatementTable from '../components/StatementTable';
import Amt, { UnitName } from '../components/Amt';
import Tie from '../components/Tie';
import { longDate, previousFy, gap } from '../../lib/format.mjs';
import { noteRows } from '../../lib/rows.mjs';

// What each LIVE sheet shows on its own tab. Every body gets `view` (the page's data) and returns its own heading and sections. The signed
// part of a sheet is SignedSheet.js. A sheet whose notes/cash flow/... are not set up for the year shows the reason instead of figures.

const Checks = ({ list, rupee = true }) => (list?.length ? (
  <ul className="proofs">
    {list.map((c) => (
      <li key={c.key}><span className={`chip ${c.status === 'OK' ? 'ok' : 'bad'}`}>{c.status === 'OK' ? 'Pass' : 'Fail'}</span><span>{c.label}</span><span className="d">difference {rupee ? '₹' : ''}{gap(c.value)}</span></li>
    ))}
  </ul>
) : null);

/** The "agrees with the audited workbook" sentence for a set of rows that carry a status. */
function TieProof({ rows, what = 'figures', hasTie }) {
  const tied = rows.filter((r) => r.status);
  const bad = tied.filter((r) => r.status === 'CHECK').length;
  if (!hasTie) return <p className="proof">There are no audited figures for this date, so nothing is compared.</p>;
  return (
    <p className="proof">
      {bad === 0
        ? <span className="ok">All {tied.length} {what} agree with the audited workbook.</span>
        : <span style={{ color: 'var(--bad)' }}>{bad} of {tied.length} {what} differ from the audited workbook.</span>}
    </p>
  );
}

/** A reason to show instead of a book sheet: not set up, or could not be built. */
function Unavailable({ view, title, what }) {
  const bad = booksGate(view);
  return <><PageHead title={title} />{bad ?? <div className="notice warn">There is no {what} set up for FY {view.fy}.</div>}</>;
}

// ---------- the statements ----------

export function BalanceSheetTab({ view }) {
  const s = view.statements;
  const opts = { fy: view.fy, prevFy: s.prevFy, showPrev: s.hasPrev, showTie: s.hasTie };
  const asOf = longDate(view.snapshot.meta.asOf);
  return (
    <>
      <PageHead title="Balance sheet">
        In the order of the audited statements. {s.hasTie ? 'A tick means the line agrees with the audited figure. ' : ''}Amounts in <UnitName />.
      </PageHead>
      <section className="sheet" aria-label="Balance sheet">
        <div className="sheet-title"><h2>Balance sheet as at {asOf}</h2></div>
        <h3 className="side-title">Equity and liabilities</h3>
        <StatementTable rows={s.bs.liabilities} {...opts} />
        <h3 className="side-title">Assets</h3>
        <StatementTable rows={s.bs.assets} {...opts} />
        <p className="tbl-note">Last year's figures are the audited ones. Lines under a heading that are indented (advance from customers, retention money and so on) are the notes behind the line above; last year's audited statements do not split them out.</p>
      </section>
    </>
  );
}

export function ProfitLossTab({ view }) {
  const s = view.statements;
  const opts = { fy: view.fy, prevFy: s.prevFy, showPrev: s.hasPrev, showTie: s.hasTie };
  const asOf = longDate(view.snapshot.meta.asOf);
  return (
    <>
      <PageHead title="Statement of profit and loss">
        In the order of the audited statements. {s.hasTie ? 'A tick means the line agrees with the audited figure. ' : ''}Amounts in <UnitName />.
      </PageHead>
      <section className="sheet" aria-label="Profit and loss">
        <div className="sheet-title"><h2>Profit and loss for the year ended {asOf}</h2></div>
        <StatementTable rows={s.pl} {...opts} />
        <p className="tbl-note">Brackets are negative figures. In expenses, a bracket is a reduction (stock built up during the year). Tax lines carry their sign: a bracket reduces profit.</p>
      </section>
    </>
  );
}

export function CashFlowTab({ view }) {
  const bad = booksGate(view);
  const cf = view.books?.cashflow;
  if (bad || !cf) return <Unavailable view={view} title="Cash flow statement" what="cash flow statement" />;
  const prevFy = previousFy(view.fy);
  const closes = cf.checks.every((c) => c.status === 'OK');
  const s = cf.summary;
  return (
    <>
      <PageHead title="Cash flow statement">
        For the year ended {longDate(view.snapshot.meta.asOf)}, indirect method (Accounting Standard 3), worked out from the live Balance Sheet and Profit and Loss with the same formulas as the CF sheet of the audited workbook.
        {cf.hasTie ? ' A tick means the line agrees with the audited cash flow. ' : ' '}Amounts in <UnitName />.
      </PageHead>

      <p className="proof">
        {closes
          ? <span className="ok">The statement closes: cash at the end of the year, <Amt v={cf.rows.find((r) => r.key === 'cf_close')?.value} words />, is the same as on the Balance Sheet and in Note 17.</span>
          : <span style={{ color: 'var(--bad)' }}>The statement does not close. See the proof below.</span>}
        {cf.hasTie && (s.check === 0
          ? <> <span className="ok">All {s.ok} lines agree with the audited cash flow.</span></>
          : <span style={{ color: 'var(--bad)' }}> {s.check} of {s.ok + s.check} lines differ from the audited cash flow.</span>)}
      </p>

      <section className="sheet" aria-label="Cash flow statement">
        <div className="sheet-title"><h2>Cash flow statement for FY {view.fy}</h2><small>Brackets are cash going out</small></div>
        <LedgerTable rows={cf.rows} fy={view.fy} prevFy={prevFy} showTie={cf.hasTie} />
      </section>

      <section className="sheet" aria-label="Cash and cash equivalents, as per Note 17">
        <div className="sheet-title"><h2>Cash and cash equivalents</h2><small>As per Note 17</small></div>
        <LedgerTable rows={cf.proof} fy={view.fy} prevFy={prevFy} showTie={cf.hasTie} />
      </section>

      <section className="sheet" aria-label="Proof">
        <div className="sheet-title"><h2>Does it close?</h2></div>
        <Checks list={cf.checks} />
        {cf.notes.length > 0 && <div className="tbl-note">{cf.notes.map((n) => <p key={n}>{n}</p>)}</div>}
      </section>
    </>
  );
}

// ---------- the notes (3 to 27 together) ----------

/** The numbers of the notes a note sheet of the workbook holds: "note-3" -> [3, 3], "note-4-19" -> [4, 19]. */
function noteRange(sheetId) {
  const m = /^note-(\d+)(?:-(\d+))?$/.exec(sheetId);
  return m ? [Number(m[1]), Number(m[2] ?? m[1])] : null;
}

/** `sheets`: the ids of the note sheets on this tab (note-3, note-4-19, note-20-27). All three: the whole of Notes 3 to 27, as before. */
export function NotesTab({ view, sheets = [] }) {
  const bad = booksGate(view);
  if (bad || !view.books?.notes) return <Unavailable view={view} title="Notes to the accounts" what="notes" />;
  const n = view.books.notes;
  const ranges = sheets.map(noteRange).filter(Boolean);
  const all = ranges.length === 0 || (['note-3', 'note-4-19', 'note-20-27'].every((id) => sheets.includes(id)));
  const shown = all ? n.notes : n.notes.filter((q) => { const no = parseInt(q.no, 10); return ranges.some(([lo, hi]) => no >= lo && no <= hi); });
  const prevFy = previousFy(view.fy);
  const s = n.summary;
  return (
    <>
      <PageHead title="Notes to the accounts">
        {all ? 'Notes 3 to 27' : 'Notes'} of the audited statements, rebuilt from the Zoho Books accounts. Open <em>made up of</em> under a line to see the accounts behind it.
        {n.hasTie ? ' A tick means the line agrees with the audited note. ' : ' '}Amounts in <UnitName />.
      </PageHead>

      {all && (
        <p className="proof">
          {n.hasTie
            ? s.check === 0
              ? <span className="ok">All {s.ok} lines of the {s.notes} notes agree with the audited notes.</span>
              : <span style={{ color: 'var(--bad)' }}>{s.check} of {s.ok + s.check} lines differ from the audited notes.</span>
            : <>There are no audited notes for this date, so nothing is compared.</>}
        </p>
      )}

      <nav className="sheet" aria-label="Jump to a note">
        <div className="sheet-title"><h2>Jump to a note</h2></div>
        <div className="chips">
          {shown.map((q) => <a key={q.no} href={`#note-${q.no}`} className={q.status === 'CHECK' ? 'bad' : ''} title={q.title}>{q.no}</a>)}
        </div>
      </nav>

      {shown.map((q) => (
        <section className="sheet" id={`note-${q.no}`} key={q.no} aria-label={`Note ${q.no}`}>
          <div className="sheet-title">
            <h2>Note {q.no}: {q.title}</h2>
            {q.status && <span className={`chip ${q.status === 'OK' ? 'ok' : 'bad'}`}>{q.status === 'OK' ? 'Agrees' : 'Differs'}</span>}
          </div>
          <LedgerTable rows={noteRows(q)} fy={view.fy} prevFy={prevFy} showTie={n.hasTie} />
          {q.unplaced !== 0 && Math.abs(q.unplaced) > 0.5 && (
            <p className="tbl-note" style={{ color: 'var(--bad)' }}>
              Zoho Books has <Amt v={q.unplaced} words /> in this part of the statements that no line of the note picks up. Add the account to the note, or to the account mapping.
            </p>
          )}
          <NoteTables tables={q.tables} />
          <Checks list={q.checks} />
        </section>
      ))}
    </>
  );
}

// ---------- Note 12 ----------

const FIELDS = ['openGross', 'additions', 'disposals', 'closeGross', 'openAccdep', 'charge', 'writeback', 'closeAccdep', 'net', 'prevNet'];

/** One tick for a whole row: it agrees only when every audited figure of the row agrees. */
function rowTie(c) {
  if (!c.tie) return { status: null, diff: null };
  const parts = Object.entries(c.tie).filter(([, t]) => t.status);
  if (!parts.length) return { status: null, diff: null };
  const worst = parts.reduce((m, [, t]) => (Math.abs(t.diff) > Math.abs(m) ? t.diff : m), 0);
  return { status: parts.every(([, t]) => t.status === 'OK') ? 'OK' : 'CHECK', diff: worst };
}

function AssetRow({ c, kind, tie }) {
  const t = c.tie ? rowTie(c) : { status: null };
  return (
    <tr className={`k-${kind}`}>
      <th scope="row">{c.label}</th>
      {FIELDS.map((f) => <td key={f} className={`num ${f === 'prevNet' ? 'dim' : ''}`}><Amt v={c[f]} /></td>)}
      {tie && <td className="tie-col"><Tie status={t.status} diff={t.diff} /></td>}
    </tr>
  );
}

export function FixedAssetsTab({ view }) {
  const bad = booksGate(view);
  const a = view.books?.assets;
  if (bad || !a) return <Unavailable view={view} title="Fixed assets" what="fixed-asset schedule" />;
  const prevFy = previousFy(view.fy);
  const ppe = a.classes.filter((c) => c.section === 'ppe');
  const intang = a.classes.filter((c) => c.section === 'intangible');
  const s = a.summary;
  const allOk = s.check === 0 && s.checksFailed === 0;
  return (
    <>
      <PageHead title="Fixed assets (Note 12)">
        Property, plant and equipment, intangible assets, capital work-in-progress and intangibles under development. The closing figures are read from the Zoho Books accounts; the opening figures are last year's audited closing figures. Additions and depreciation are the difference.
        {' '}Amounts in <UnitName />.
      </PageHead>

      <p className="proof">
        {a.hasTie
          ? allOk
            ? <span className="ok">All {s.ok} figures agree with the audited Note 12, and the totals agree with the Balance Sheet and the Profit and Loss.</span>
            : <span style={{ color: 'var(--bad)' }}>{s.check} figures differ from the audited Note 12{s.checksFailed ? `, and ${s.checksFailed} total check fails` : ''}.</span>
          : <>There are no audited figures for this date, so nothing is compared.</>}
      </p>

      <section className="sheet" aria-label="Fixed-asset schedule">
        <div className="sheet-title"><h2>Schedule of fixed assets for FY {view.fy}</h2><small>As at {longDate(view.snapshot.meta.asOf)}</small></div>
        <div className="tablewrap">
          <table className="stmt assets">
            <thead>
              <tr>
                <th scope="col" rowSpan={2}>Class of asset</th>
                <th scope="colgroup" colSpan={4} className="grp">Gross block</th>
                <th scope="colgroup" colSpan={4} className="grp">Accumulated depreciation</th>
                <th scope="colgroup" colSpan={2} className="grp">Net block</th>
                {a.hasTie && <th scope="col" rowSpan={2} className="tie-col"><span title="Every figure of the row compared with the audited Note 12">Audited</span></th>}
              </tr>
              <tr>
                {['Opening', 'Additions', 'Sold or discarded', 'Closing', 'Opening', 'Charge for the year', 'Written back', 'Closing', `FY ${view.fy}`, `FY ${prevFy}`].map((h, i) => <th key={h + i} scope="col" className="num">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              <tr className="k-heading lv-0"><th scope="colgroup" colSpan={12}>Property, plant and equipment</th></tr>
              {ppe.map((c) => <AssetRow key={c.key} c={c} kind="line" tie={a.hasTie} />)}
              <AssetRow c={a.ppe} kind="subtotal" tie={a.hasTie} />
              <tr className="k-heading lv-0"><th scope="colgroup" colSpan={12}>Intangible assets</th></tr>
              {intang.map((c) => <AssetRow key={c.key} c={c} kind="line" tie={a.hasTie} />)}
              <AssetRow c={a.intangible} kind="subtotal" tie={a.hasTie} />
              <AssetRow c={a.grand} kind="grand" tie={a.hasTie} />
              <AssetRow c={a.previousYear} kind="line" tie={a.hasTie} />
            </tbody>
          </table>
        </div>
        <p className="tbl-note">Additions = closing gross block − opening gross block + assets sold or discarded. Charge = closing accumulated depreciation − opening accumulated depreciation + depreciation written back on assets sold. Land is not depreciated.</p>
      </section>

      <section className="sheet" aria-label="Does the schedule agree with the statements?">
        <div className="sheet-title"><h2>Does it agree with the statements?</h2></div>
        <Checks list={a.checks} />
      </section>

      <section className="sheet" aria-label="Work in progress">
        <div className="sheet-title"><h2>Capital work-in-progress and intangibles under development</h2></div>
        <div className="tablewrap">
          <table className="tbl-plain">
            <thead><tr><th scope="col">Particulars</th><th scope="col" className="num">FY {view.fy}</th><th scope="col" className="num">FY {prevFy}, audited</th>{a.hasTie && <th scope="col" className="tie-col">Audited</th>}</tr></thead>
            <tbody>
              {[a.cwip, a.iaud].map((w) => (
                <tr key={w.key}><th scope="row">{w.label}</th><td className="num"><Amt v={w.value} /></td><td className="num dim"><Amt v={w.fy25} /></td>{a.hasTie && <td className="tie-col"><Tie status={w.status} diff={w.diff} /></td>}</tr>
              ))}
            </tbody>
          </table>
        </div>
        {a.ageing.map((g) => (
          <div key={g.key}>
            <h3 className="subtitle">{g.title}</h3>
            <div className="tablewrap">
              <table className="tbl-plain">
                <thead><tr><th scope="col">Outstanding for</th><th scope="col" className="num">FY {view.fy}</th><th scope="col" className="num">FY {prevFy}, audited</th>{a.hasTie && <th scope="col" className="tie-col">Audited</th>}</tr></thead>
                <tbody>
                  {g.rows.map((r) => (
                    <tr key={r.label}><th scope="row">{r.label}</th><td className={`num ${r.fixed ? 'fixed' : ''}`}><Amt v={r.value} /></td><td className="num dim"><Amt v={r.fy25} /></td>{a.hasTie && <td className="tie-col"><Tie status={r.status} diff={r.diff} /></td>}</tr>
                  ))}
                  <tr className="last"><th scope="row">Total</th><td className="num"><Amt v={g.total.value} /></td><td className="num dim"><Amt v={g.total.fy25} /></td>{a.hasTie && <td />}</tr>
                </tbody>
              </table>
            </div>
          </div>
        ))}
        <div className="tbl-note">
          {a.statements.map((t) => <p key={t}>{t}</p>)}
          <p>The ageing is by year of capitalisation as in the audited Note 12. Rows in grey are the auditors' own figures for projects that did not move during the year; the first row takes whatever is left of the live balance.</p>
        </div>
      </section>
    </>
  );
}

// ---------- Note 28 and the weighted average shares (the rows of ratios.fyYY.json, one block per sheet) ----------

/** The rows of the ratios file split by their headings: before the first heading = the analytical ratios; then one block per heading. */
function ratioBlocks(rows) {
  const out = { ratios: [], blocks: {} };
  let cur = null;
  for (const r of rows) {
    if (r.kind === 'heading') { cur = []; out.blocks[r.key] = cur; cur.push(r); continue; }
    (cur ?? out.ratios).push(r);
  }
  return out;
}

export function Ratios28BTab({ view }) {
  const bad = booksGate(view);
  const r = view.books?.ratios;
  if (bad || !r) return <Unavailable view={view} title="Analytical ratios" what="ratios" />;
  const { ratios } = ratioBlocks(r.rows);
  return (
    <>
      <PageHead title="Analytical ratios (Note 28(B))">
        The ratios of Note 28(B), worked out from the live figures with the same formulas as the audited workbook. Amounts in <UnitName />.
      </PageHead>
      <TieProof rows={ratios} what="ratios" hasTie={r.hasTie} />
      <section className="sheet" aria-label="Analytical ratios">
        <div className="sheet-title"><h2>Analytical ratios</h2><small>Change is against last year</small></div>
        <LedgerTable rows={ratios} fy={view.fy} prevFy={previousFy(view.fy)} showTie={r.hasTie} showChange />
        <p className="tbl-note">The reason under a ratio is the one the company gave in the audited notes (Schedule III asks for a reason when a ratio moves by more than 25%). Read it again whenever the figures move.</p>
      </section>
      {r.checks.length > 0 && <section className="sheet" aria-label="Checks"><div className="sheet-title"><h2>Checks</h2></div><Checks list={r.checks} rupee={false} /></section>}
    </>
  );
}

export function WeightedSharesTab({ view }) {
  const bad = booksGate(view);
  const r = view.books?.ratios;
  if (bad || !r) return <Unavailable view={view} title="Weighted average shares" what="share working" />;
  const eps = ratioBlocks(r.rows).blocks.h_eps ?? [];
  return (
    <>
      <PageHead title="Weighted average shares and earnings per share">
        The weighted average number of equity shares (the shares issued during the year count from the day of allotment) and the basic and diluted earnings per share that follow from it. Amounts in <UnitName />.
      </PageHead>
      <TieProof rows={eps} what="figures" hasTie={r.hasTie} />
      <section className="sheet" aria-label="Weighted average shares and earnings per share">
        <div className="sheet-title"><h2>Earnings per share</h2></div>
        <LedgerTable rows={eps.filter((x) => x.kind !== 'heading')} fy={view.fy} prevFy={previousFy(view.fy)} showTie={r.hasTie} />
      </section>
    </>
  );
}

/** The live part of Note 28(A): earnings per share and the amounts due to micro and small enterprises. The rest of the note is SignedSheet. */
export function Note28ATab({ view }) {
  const bad = booksGate(view);
  const r = view.books?.ratios;
  if (bad || !r) return <Unavailable view={view} title="Note 28(A)" what="EPS and MSME working" />;
  const { blocks } = ratioBlocks(r.rows);
  const rows = [...(blocks.h_eps ?? []), ...(blocks.h_msme ?? [])];
  return (
    <>
      <PageHead title="Other notes (Note 28(A))">
        Earnings per share and the amounts due to micro and small enterprises are rebuilt from the live figures; the other items of the note (contingent liabilities, CSR, foreign currency, related parties) are as signed, below. Amounts in <UnitName />.
      </PageHead>
      <TieProof rows={rows} what="figures" hasTie={r.hasTie} />
      <section className="sheet" aria-label="Earnings per share and MSME">
        <div className="sheet-title"><h2>Live from Zoho Books</h2><small>Earnings per share, and micro and small enterprises</small></div>
        <LedgerTable rows={rows} fy={view.fy} prevFy={previousFy(view.fy)} showTie={r.hasTie} />
        <p className="tbl-note">Which vendors count as micro or small enterprises comes from the list kept in the party rules, which is reviewed once a year.</p>
      </section>
    </>
  );
}

// ---------- the tax workings ----------

const showPrev = (sheet) => sheet.rows.some((r) => r.fy25 !== null && r.fy25 !== undefined);

export function ComputationTab({ view }) {
  const bad = booksGate(view);
  const t = view.books?.tax;
  if (bad || !t) return <Unavailable view={view} title="Computation of income and tax" what="tax working" />;
  const c = t.computation;
  const bads = c.summary.check + c.summary.checksFailed;
  return (
    <>
      <PageHead title="Computation of income and tax">
        The computation of income and tax. {t.note} Amounts in <UnitName />.
      </PageHead>
      <p className="proof">
        {c.hasTie
          ? bads === 0
            ? <span className="ok">All {c.summary.ok} lines agree with the audited computation.</span>
            : <span style={{ color: 'var(--bad)' }}>{c.summary.check} lines differ from the audited computation.</span>
          : <>There are no audited figures for this date, so nothing is compared.</>}
      </p>
      <section className="sheet" aria-label="Computation of income and tax">
        <div className="sheet-title"><h2>Computation of income and tax</h2><small>Sheet "Computation"</small></div>
        <LedgerTable rows={c.rows} fy={view.fy} prevFy={previousFy(view.fy)} showPrev={showPrev(c)} showTie={c.hasTie} />
        <Checks list={c.checks} />
      </section>
    </>
  );
}

export function DeferredTaxTab({ view }) {
  const bad = booksGate(view);
  const t = view.books?.tax;
  if (bad || !t) return <Unavailable view={view} title="Deferred tax" what="tax working" />;
  const d = t.deferred;
  const bads = d.summary.check + d.summary.checksFailed;
  return (
    <>
      <PageHead title="Deferred tax working">
        The deferred tax asset on depreciation and on the provisions for employee benefits. {t.note} Amounts in <UnitName />.
      </PageHead>
      <p className="proof">
        {d.hasTie
          ? bads === 0
            ? <span className="ok">All {d.summary.ok} lines agree with the audited deferred tax working.</span>
            : <span style={{ color: 'var(--bad)' }}>{d.summary.check} lines differ from the audited working.</span>
          : <>There are no audited figures for this date, so nothing is compared.</>}
      </p>
      <section className="sheet" aria-label="Deferred tax">
        <div className="sheet-title"><h2>Deferred tax working</h2><small>Sheet "D.Tax"</small></div>
        <LedgerTable rows={d.rows} fy={view.fy} prevFy={previousFy(view.fy)} showPrev={showPrev(d)} showTie={d.hasTie} />
        <Checks list={d.checks} />
      </section>
    </>
  );
}

/** Sheet id -> the component that shows its live figures. The three note sheets are drawn together by NotesTab (see NOTE_SHEETS). */
export const NOTE_SHEETS = ['note-3', 'note-4-19', 'note-20-27'];
export const BODIES = {
  bs: BalanceSheetTab,
  'p-l': ProfitLossTab,
  cf: CashFlowTab,
  'note-12-mfa': FixedAssetsTab,
  'note-28-a': Note28ATab,
  'note-28-b': Ratios28BTab,
  computation: ComputationTab,
  'd-tax': DeferredTaxTab,
  'weighted-average-shares': WeightedSharesTab,
};
