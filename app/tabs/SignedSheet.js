import { Fragment } from 'react';
import Link from 'next/link';
import { getContext } from '../lib/data';
import { liveOverlay } from '../../lib/workbook.mjs';
import PageHead from '../components/PageHead';
import Badge from '../components/Badge';
import Amt from '../components/Amt';
import SheetFilter from '../components/SheetFilter';
import { cell, gap, longDate, plain } from '../../lib/format.mjs';

// A sheet of the audited workbook as it was signed (config/workbook.fyYY/<id>.json), with the live check of its lines and totals where the
// index says so. Used by the tab of that sheet (and under the live figures of Note 28(A)).

const isNum = (v) => typeof v === 'number';
const isText = (v) => typeof v === 'string';

const isValue = (v) => isNum(v) || (v && typeof v === 'object' && v.d);

/**
 * Text sheets (the auditors' report, the accounting policies, the other notes ...): a marker such as "(i)" or "a)", the words, and up to
 * two figures at the end of the line (this year, last year). Anything beyond that, such as a small side table, follows in grey.
 */
function DocRows({ rows }) {
  const withFigures = rows.some((r) => r.some(isValue));
  return (
    <div className={`doc ${withFigures ? 'with-figures' : ''}`}>
      {rows.map((cells, i) => {
        const filled = cells.filter((c) => c !== null && c !== undefined);
        if (!filled.length) return null;
        let t = -1; // the main text: the longest piece of text
        filled.forEach((c, k) => { if (isText(c) && (t < 0 || c.length > filled[t].length)) t = k; });
        const lead = t < 0 ? [] : filled.slice(0, t);
        const text = t < 0 ? '' : filled[t];
        const rest = t < 0 ? filled : filled.slice(t + 1);
        const values = rest.filter(isValue);
        const slots = values.slice(0, 2);
        const side = rest.filter((c) => !slots.includes(c));
        const mark = lead.map(cell).join(' ');
        const head = !mark && !rest.length && isText(text) && text.length < 90 && !/[.;,]$/.test(text) && (text === text.toUpperCase() || /^(Note|NOTE|Report|Annexure|Basis|Key|Opinion)/.test(text));
        return (
          <div key={i} className={`doc-row ${mark ? '' : 'no-mark'} ${head ? 'head' : ''} ${slots.length ? '' : 'nofig'}`}>
            {mark ? <span className="mark">{mark}</span> : null}
            <span className="txt">{text}</span>
            {slots.length > 0 && <span className="fig">{cell(slots[0])}</span>}
            {slots.length > 0 && <span className="fig">{slots[1] !== undefined ? cell(slots[1]) : ''}</span>}
            {side.length > 0 && <span className="side">{side.map(cell).join('  ')}</span>}
          </div>
        );
      })}
    </div>
  );
}

/** The first of the opening rows that looks like a header: three or more cells, all of them words. */
function headerIndex(rows) {
  for (let i = 0; i < Math.min(rows.length, 8); i += 1) {
    const filled = rows[i].filter((c) => c !== null && c !== undefined);
    if (filled.length >= 3 && filled.every(isText)) return i;
  }
  return -1;
}

const round2 = (x) => Math.round(x * 100) / 100;

/** What each status of the live check says, in words. */
const CHECK = {
  OK: ['ok', 'Agrees', 'The figure Zoho gives today is the signed figure'],
  NAME: ['info', 'Matched by amount', 'Not found under this name: Zoho has a balance of the same amount under the closest name (shown below the chip)'],
  DIFF: ['warn', 'Differs', 'Zoho gives another figure today: the books changed after signing, or the auditors regrouped the line'],
  NONE: ['mute', 'Not in Zoho', 'No line of this name in Zoho. It stays as signed'],
  LUMP: ['info', 'Checked in total', 'Zoho holds these lines as one combined balance (or one balance for a few lines), so they are compared together: see the tables of this check'],
};

/** The live figure of an extra column (the ageing buckets ...) shown with the signed figure: a tick when they agree, Zoho's figure under it when they do not. */
function ColLive({ x }) {
  if (!x) return null;
  const together = x.group ? ' (the columns of this group are compared together: they are shown under the first of them)' : '';
  if (x.status === 'OK') return <span className="tick" title={x.text ? 'Zoho gives the same text today' : `Zoho gives the same figure today${together}`}> ✓</span>;
  if (x.text) { // a text column (the Vendor Code): Zoho's text, or that the vendor has none there
    return (
      <div className="lvx" title={`Signed ${x.signed ? `"${x.signed}"` : 'nothing'}; Zoho today ${x.live ? `"${x.live}"` : 'no code on the vendor card'}`}>
        Zoho {x.live || 'has no code'}
      </div>
    );
  }
  return (
    <div className="lvx" title={`Signed ${cell(round2(x.signed))}; Zoho today ${cell(round2(x.live))}; difference ${cell(round2(x.diff))}${together}`}>
      Zoho {cell(round2(x.live))}{x.group && <span className="dim"> (together)</span>}
    </div>
  );
}

/** The three cells added after the value column: the figure Zoho gives today, what the check found, and the difference. */
function LiveCells({ o }) {
  if (!o || o.kind === 'cols') return <><td className="lv" /><td className="lv chk" /><td className="lv num" /></>;
  if (o.kind === 'total') {
    const ok = o.status === 'OK';
    return (
      <>
        <td className="lv num">{cell(round2(o.live))}</td>
        <td className="lv chk"><span className={`chip ${ok ? 'ok' : 'warn'}`} title="The sheet's total, worked out again with the live figures of its lines">{ok ? 'Total agrees' : 'Total differs'}</span></td>
        <td className="lv num dim">{ok ? '' : cell(round2(o.diff))}</td>
      </>
    );
  }
  const [cls0, text, title] = CHECK[o.status] ?? ['mute', o.status, ''];
  const cls = o.status === 'LUMP' && o.lumpOk === false ? 'warn' : cls0; // lines compared together that do not agree are shown as a difference
  const sign = o.signed < 0 ? -1 : 1;
  const has = o.live !== null && o.live !== undefined;
  const shown = has ? sign * o.live : null;
  return (
    <>
      <td className="lv num">{has ? cell(round2(shown)) : ''}</td>
      <td className="lv chk">
        <span className={`chip ${cls}`} title={title}>{text}</span>
        {o.zohoName && <div className="dim small">{o.zohoName}</div>}
      </td>
      <td className="lv num dim">{has && Math.abs(shown - o.signed) >= 0.005 && o.status !== 'OK' ? cell(round2(shown - o.signed)) : ''}</td>
    </>
  );
}

/** Working sheets: a table, as in the workbook (empty rows and columns left out). Lines above the header are the sheet's title. With a live check, three columns follow the value column. */
function Grid({ rows, columns, id, overlay = null, valueCol = null }) {
  const h = headerIndex(rows);
  const title = h > 0 ? rows.slice(0, h) : [];
  const head = h >= 0 ? rows[h] : null;
  const body = h >= 0 ? rows.slice(h + 1) : rows;
  const base = h >= 0 ? h + 1 : 0; // position of body[0] in the whole sheet: the live check is indexed by sheet row
  const cols = Array.from({ length: columns }, (_, j) => j);
  const withLive = Boolean(overlay) && valueCol !== null;
  const colMap = new Map((withLive ? overlay.columns ?? [] : []).map((c) => [c.col, c]));
  const grouped = new Set([...colMap.values()].flatMap((c) => c.group.slice(1))); // the later columns of a group compared together
  return (
    <>
      {title.length > 0 && (
        <div className="tbl-note" style={{ borderTop: 0, paddingTop: 0 }}>
          {title.map((r, i) => <p key={i}>{r.filter((c) => c !== null && c !== undefined).map(cell).join('   ')}</p>)}
        </div>
      )}
      <div className="grid-wrap">
        <table className="grid" id={id}>
          {head && (
            <thead>
              <tr>
                {cols.map((j) => (
                  <Fragment key={j}>
                    <th scope="col" className={isNum(head[j]) ? 'num' : ''}>
                      {cell(head[j])}
                      {colMap.has(j) && <div className="lvh" title={colMap.get(j).label}>Zoho: {colMap.get(j).ok} of {colMap.get(j).ok + colMap.get(j).diff} agree{colMap.get(j).group.length > 1 ? ` (this and the next ${colMap.get(j).group.length - 1} columns together)` : ''}</div>}
                      {grouped.has(j) && <div className="lvh dim">checked together with the column to the left</div>}
                    </th>
                    {withLive && j === valueCol && <><th scope="col" className="num lv">Live (Zoho)</th><th scope="col" className="lv">Check</th><th scope="col" className="num lv">Difference</th></>}
                  </Fragment>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {body.map((r, i) => {
              const o = withLive ? overlay.byRow[base + i] : null;
              return (
                <tr key={i} className={o ? `lv-${o.status.toLowerCase()} ${o.kind === 'total' || o.kind === 'cols' ? 'lv-total' : ''}` : ''}>
                  {cols.map((j) => {
                    const c = r[j];
                    const x = o?.cols?.[j];
                    return (
                      <Fragment key={j}>
                        <td className={`${isNum(c) ? 'num' : isText(c) && c.length > 40 ? 'txt' : ''}${x?.status === 'DIFF' ? ' lvc-diff' : ''}`}>{cell(c)}<ColLive x={x} /></td>
                        {withLive && j === valueCol && <LiveCells o={o} />}
                      </Fragment>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** The result of the live check in words and numbers: how the lines came out, block by block, then what Zoho has that the sheet does not. */
function LiveCheck({ overlay, keeps }) {
  const m = overlay.summary;
  const withSource = overlay.blocks.filter((b) => b.source);
  const asSigned = overlay.blocks.filter((b) => !b.source);
  const notFound = overlay.blocks.filter((b) => b.notFound.length);
  const lumps = overlay.blocks.filter((b) => b.lump);
  const agree = m.ok + m.name;
  return (
    <>
      <section className="sheet" aria-label="Line by line against Zoho">
        <div className="sheet-title"><h2>Line by line against Zoho</h2><small>{m.lines.toLocaleString('en-IN')} lines compared</small></div>
        {m.lines === 0 && (overlay.waiting ?? []).length > 0 && <p className="proof">The figures of this sheet are still being read from Zoho Books; until they are, it stays as signed. The page loads the rest by itself.</p>}
        {!(m.lines === 0 && (overlay.waiting ?? []).length > 0) && <p className="proof">
          <span className={m.diff === 0 ? 'ok' : ''}>{agree.toLocaleString('en-IN')} of {m.lines.toLocaleString('en-IN')} lines give the same figure in Zoho today</span>
          {m.name > 0 && <>, {m.name.toLocaleString('en-IN')} of them under a slightly different name</>}
          {m.lump > 0 && <>; {m.lump} more are compared together as one combined balance</>}
          {m.diff > 0 && <>; {m.diff === 1 ? '1 gives' : `${m.diff} give`} another figure</>}
          {m.none > 0 && <>; {m.none} are not in Zoho under that name and stay as signed</>}.
          {m.totalsOk + m.totalsBad > 0 && <> {m.totalsOk} of {m.totalsOk + m.totalsBad} totals work out the same with the live figures.</>}
          {overlay.columns?.length > 0 && <> {overlay.columns.length} more {overlay.columns.length === 1 ? 'column is' : 'columns are'} worked out from Zoho too: a tick beside a signed figure means Zoho gives the same figure today, and where it does not, Zoho's figure is shown under it.</>}
        </p>}
        {overlay.problems.length > 0 && <div className="notice bad live-problem"><b>Part of this check could not run.</b> {overlay.problems.join(' · ')}</div>}
        {(overlay.waiting ?? []).length > 0 && <div className="notice warn live-wait"><b>Still loading.</b> {overlay.waiting.join(' · ')}</div>}
        {(withSource.length > 1 || lumps.length > 0) && (
          <div className="tablewrap">
            <table className="tbl-plain">
              <thead>
                <tr><th scope="col">Part of the sheet</th><th scope="col" className="num">Lines</th><th scope="col" className="num">Agree</th><th scope="col" className="num">By amount</th><th scope="col" className="num">Differ</th><th scope="col" className="num">Not in Zoho</th><th scope="col">Totals</th></tr>
              </thead>
              <tbody>
                {overlay.blocks.map((b) => {
                  const n = b.ok + b.name + b.diff + b.none + b.lumpLines;
                  return (
                    <tr key={b.start}>
                      <th scope="row">{b.title}</th>
                      {b.source ? (
                        <>
                          <td className="num">{n}</td><td className="num">{b.ok || '–'}</td><td className="num">{b.name || '–'}</td><td className="num">{b.diff || '–'}</td><td className="num">{b.none || '–'}</td>
                          <td>
                            {b.totalsOk + b.totalsBad > 0 ? <span className={`chip ${b.totalsBad === 0 ? 'ok' : 'warn'}`}>{b.totalsBad === 0 ? 'Agrees' : 'Differs'}</span> : <span className="dim">–</span>}
                            {b.lump && <> <span className={`chip ${b.lump.ok ? 'ok' : 'warn'}`} title={`${b.lump.lines} lines that matched nothing add up to ${cell(round2(b.lump.signed))} as signed; Zoho's one combined balance "${b.lump.name}" is ${cell(round2(b.lump.live))}`}>{b.lump.lines} lines together {b.lump.ok ? 'agree' : 'differ'}</span></>}
                          </td>
                        </>
                      ) : (
                        <td colSpan={6} className="dim">As signed, {b.signed} {b.signed === 1 ? 'line' : 'lines'} (no live check for this part)</td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {overlay.columns?.length > 0 && (
          <div className="tablewrap">
            <table className="tbl-plain">
              <caption className="sr-only">Columns worked out from Zoho</caption>
              <thead>
                <tr><th scope="col">Column worked out from Zoho</th><th scope="col" className="num">Lines agree</th><th scope="col" className="num">Lines differ</th><th scope="col">Column total</th></tr>
              </thead>
              <tbody>
                {overlay.columns.map((c) => (
                  <tr key={c.col}>
                    <th scope="row">{c.label}</th>
                    <td className="num">{c.ok}</td>
                    <td className="num">{c.diff || '–'}</td>
                    <td>{c.totalOk + c.totalBad > 0 ? <span className={`chip ${c.totalBad === 0 ? 'ok' : 'warn'}`}>{c.totalBad === 0 ? 'Agrees' : 'Differs'}</span> : <span className="dim">–</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {overlay.ties?.length > 0 && (
          <div className="tablewrap">
            <table className="tbl-plain">
              <caption className="sr-only">Lines compared together</caption>
              <thead>
                <tr><th scope="col">Compared together (Zoho keeps one balance for them)</th><th scope="col" className="num">Lines</th><th scope="col" className="num">As signed</th><th scope="col" className="num">Zoho today</th><th scope="col" className="num">Difference</th><th scope="col">Check</th></tr>
              </thead>
              <tbody>
                {overlay.ties.map((t) => (
                  <tr key={t.title}>
                    <th scope="row">{t.title}</th>
                    <td className="num">{t.lines}</td>
                    <td className="num">{cell(round2(t.signed))}</td>
                    <td className="num">{cell(round2(t.live))}</td>
                    <td className="num dim">{Math.abs(t.diff) >= 0.005 ? cell(round2(t.diff)) : ''}</td>
                    <td>
                      <span className={`chip ${t.ok ? 'ok' : 'warn'}`}>{t.ok ? 'Agrees' : 'Differs'}</span>
                      {t.missing.length > 0 && <div className="dim small">Not found in Zoho: {t.missing.join(', ')}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="tbl-note">
          {asSigned.length > 0 && <>A line with a different figure is information, not an error: after the ledger closed the auditors regrouped some lines, and Zoho may have changed since. </>}
          {keeps}
        </p>
      </section>

      {overlay.extras.length > 0 && (
        <section className="sheet" aria-label="In Zoho but not on this sheet">
          <div className="sheet-title"><h2>In Zoho, not on this sheet</h2><small>{overlay.extras.length} {overlay.extras.length === 1 ? 'balance' : 'balances'}, ₹{cell(Math.round(m.extrasValue))} in all</small></div>
          <div className="tablewrap">
            <table className="tbl-plain">
              <thead><tr><th scope="col">List</th><th scope="col">Name in Zoho</th><th scope="col" className="num">Balance today</th></tr></thead>
              <tbody>
                {overlay.extras.map((e, i) => (
                  <tr key={i}><td>{e.group}</td><th scope="row">{e.name}</th><td className="num"><Amt v={e.value} /></td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="tbl-note">Zoho has a balance for each of these today, but no line of the signed sheet matches it by name or by amount. A name that Zoho keeps as one balance while the sheet splits it over two lines shows up here and as "Not in Zoho" above.</p>
        </section>
      )}

      {notFound.length > 0 && (
        <section className="sheet" aria-label="On this sheet but not in Zoho">
          <div className="sheet-title"><h2>On this sheet, not in Zoho</h2><small>{m.none} {m.none === 1 ? 'line' : 'lines'}, left as signed</small></div>
          <div className="tablewrap">
            <table className="tbl-plain">
              <thead><tr><th scope="col">Part of the sheet</th><th scope="col">Line as signed</th><th scope="col" className="num">As signed</th></tr></thead>
              <tbody>
                {notFound.flatMap((b) => b.notFound.map((n, i) => (
                  <tr key={`${b.start}-${i}`}><td className="dim">{b.title}</td><th scope="row">{n.label}</th><td className="num">{cell(round2(n.signed))}</td></tr>
                )))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

/** update-17: Zoho's stock summary by ledger account against the Trial Balance (the Closing Stock tab): where the items and the ledger agree and where they do not. */
function StockByAccount({ stock }) {
  if (!stock || stock.error || !Array.isArray(stock.byAccount)) return null; // the check above says why the items could not be read
  const off = Math.abs(stock.gap) > 1;
  const inRs = (v) => `${v < 0 ? '\u2212' : ''}${plain(Math.abs(v), 'eps')}`; // rupees in the Indian grouping, like the table below (not a bare 914700.60)
  return (
    <section className="sheet" aria-label="Zoho's stock against the Trial Balance">
      <div className="sheet-title"><h2>Zoho's stock against the Trial Balance</h2><small>as at {longDate(stock.asOf)} · {stock.held.toLocaleString('en-IN')} item lines with stock</small></div>
      <div className="tablewrap">
        <table className="tbl-plain">
          <thead>
            <tr><th scope="col">Ledger account</th><th scope="col" className="num">Item lines</th><th scope="col" className="num">Items in Zoho's stock summary</th><th scope="col" className="num">Trial Balance (ledger)</th><th scope="col" className="num">Ledger less items, in ₹</th><th scope="col">Check</th></tr>
          </thead>
          <tbody>
            {stock.byAccount.map((r) => (
              <tr key={r.name}>
                <th scope="row">{r.name}</th>
                <td className="num">{r.lines}</td>
                <td className="num"><Amt v={r.items} /></td>
                <td className="num">{r.tb === null ? <span className="dim">not a stock account</span> : <Amt v={r.tb} />}</td>
                <td className="num dim">{r.gap !== null && Math.abs(r.gap) >= 0.005 ? inRs(r.gap) : ''}</td>
                <td>{r.gap === null ? <span className="chip mute">Items only</span> : Math.abs(r.gap) <= 1 ? <span className="chip ok">Agrees</span> : <span className="chip warn">{r.gap > 0 ? 'Ledger is higher' : 'Ledger is lower'}</span>}</td>
              </tr>
            ))}
            <tr className="last">
              <th scope="row">All stock accounts</th>
              <td className="num">{stock.held}</td>
              <td className="num"><Amt v={stock.total} /></td>
              <td className="num"><Amt v={stock.tb} /></td>
              <td className="num dim">{off ? inRs(stock.gap) : ''}</td>
              <td><span className={`chip ${off ? 'warn' : 'ok'}`}>{off ? 'Differs' : 'Agrees'}</span></td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="tbl-note">Items in Zoho's stock summary are the stock on hand valued item by item, with the ledger account each item is booked to. A ledger account can hold more (or less) than its items when stock moves were posted to it at other values than the items carry (for example a transfer between two locations whose 'out' and 'in' values differ): that is the difference shown, and the table below says what it is made of. The signed sheet shows its own version at its foot: Total, NPD Panchu Purchase, Difference and Value as per Trial Balance.</p>
    </section>
  );
}

/** update-18: what the gap of a stock account is made of, read from that account's ledger (lib/stockLedger.mjs): the items, the stock transfers posted at unequal values, the other postings. */
const rs = (v) => plain(v, 'eps');
const srs = (v) => `${v < 0 ? '\u2212' : '+'}${rs(Math.abs(v))}`;
const day = (iso) => (iso ? cell({ d: iso }) : '');
const SUB = { display: 'block', color: 'var(--muted)', fontSize: 13, lineHeight: 1.35 }; // the second line of a cell in these plain tables (the .detail rule belongs to the signed grid)

function StockLedger({ stock }) {
  const l = stock?.ledger;
  if (!l || l.error || Math.abs(l.gap) <= 1) return null; // no ledger read, or nothing to explain
  const acc = stock.byAccount.find((r) => String(r.name).trim().toLowerCase() === String(l.account).trim().toLowerCase());
  const t = l.transfers;
  const made = l.byType.filter((x) => x.key !== 'journal').map((x) => `${x.count.toLocaleString('en-IN')} ${x.label.toLowerCase()}`);
  const journals = l.manual.count === 0 ? 'no manual journal' : `${l.manual.count.toLocaleString('en-IN')} manual journal lines`;
  return (
    <section className="sheet" aria-label={`What the gap in ${l.account} is made of`}>
      <div className="sheet-title"><h2>What the gap in {l.account} is made of</h2><small>read from its ledger · {l.entries.toLocaleString('en-IN')} lines up to {longDate(stock.asOf)}</small></div>
      <div className="tablewrap">
        <table className="tbl-plain">
          <thead><tr><th scope="col">Part of the ledger balance</th><th scope="col" className="num">In ₹</th></tr></thead>
          <tbody>
            <tr><th scope="row">Items booked to {l.account} in Zoho's stock summary</th><td className="num">{rs(acc?.items ?? 0)}</td></tr>
            <tr><th scope="row">Stock transfers between locations posted at unequal values ({t.unequalCount})</th><td className="num">{srs(l.transfersNet)}</td></tr>
            <tr><th scope="row">Remainder: other postings, which no single document explains</th><td className="num">{srs(l.otherNet)}</td></tr>
            <tr className="last"><th scope="row">{l.account} in the Trial Balance (the ledger)</th><td className="num">{rs(acc?.tb ?? l.net)}</td></tr>
          </tbody>
        </table>
      </div>
      <p className="tbl-note">The ledger of {l.account} holds {l.entries.toLocaleString('en-IN')} lines: {made.join(', ')}, and {journals}. Its lines add up to the Trial Balance to the paisa.</p>
      {t.unequalCount > 0 && (
        <>
          <div className="sheet-title"><h2>Stock transfers posted at unequal values</h2><small>{t.unequalCount} of {t.orders.toLocaleString('en-IN')} transfers</small></div>
          <div className="tablewrap">
            <table className="tbl-plain">
              <thead>
                <tr><th scope="col">Transfer (Zoho id) and its two locations</th><th scope="col">Date</th><th scope="col" className="num">Out, ₹</th><th scope="col" className="num">In, ₹</th><th scope="col" className="num">Added to the ledger, ₹</th></tr>
              </thead>
              <tbody>
                {t.unequal.map((o) => (
                  <tr key={o.id}>
                    <th scope="row" style={{ whiteSpace: 'nowrap' }}>
                      {o.id}
                      <span className="detail" style={SUB}>{o.side === 'both' ? `${o.from || '?'} \u2192 ${o.to || '?'}` : `${o.from || o.to || '?'} (${o.side}: the other side falls after the balance sheet date)`}</span>
                    </th>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {day(o.outDate ?? o.inDate)}
                      {o.outDate && o.inDate && o.outDate !== o.inDate && <span className="detail" style={SUB}>in: {day(o.inDate)}</span>}
                    </td>
                    <td className="num">{rs(o.out)}</td>
                    <td className="num">{rs(o.in)}</td>
                    <td className="num">{srs(o.diff)}</td>
                  </tr>
                ))}
                <tr className="last"><th scope="row" colSpan={4}>{t.unequalCount > t.unequal.length ? `All ${t.unequalCount} transfers (the ${t.unequal.length} largest are listed)` : 'Total'}</th><td className="num">{srs(t.net)}</td></tr>
              </tbody>
            </table>
          </div>
        </>
      )}
      <p className="tbl-note">A transfer between two locations is posted as two lines, "out" at the source and "in" at the destination, and the two cancel when their values are equal. The transfers above are not equal: their "in" and "out" values differ, so each adds the amount shown to the ledger. The items plus these transfers give the Trial Balance except for the remainder shown above, which no single document explains. All of this is read from Zoho's own entries. The sheet's own "Difference" (see the check above) is the Trial Balance less the items less NPD Panchu Purchase; the two NPD Panchu items are already among the item rows, so the whole gap between the ledger and the items is the amount in the first table, not the smaller figure on the sheet.</p>
    </section>
  );
}

/** update-17 / update-18: the stock tab's own tables - the items by ledger account, and what the gap of an account is made of. */
function StockPanel({ stock }) {
  if (!stock || stock.error || !Array.isArray(stock.byAccount)) return null; // the check above says why the items could not be read
  return (
    <>
      <StockByAccount stock={stock} />
      <StockLedger stock={stock} />
    </>
  );
}

/**
 * update-20: the CWIP tab's own tables - the two ledger accounts against the Trial Balance, Zoho by park, what the accounts are made of, the auditors' reclass between them,
 * the lines for which Zoho's own text names no park (placed as the signed sheet places them) and the one difference of placing (lib/cwip.mjs, config/cwip.fyYY.json).
 */
const entryOf = (x) => (x.entry && x.entry !== 'NA' ? x.entry : x.type === 'journal' ? 'journal' : x.type);
const ACCOUNT_WORD = { cwip: 'Capital Work in Progress', iaud: 'Intangible Asset Under Development' };

function CwipPanel({ cwip }) {
  if (!cwip || cwip.error || !Array.isArray(cwip.parks)) return null; // the check above says why the ledgers could not be used
  if (cwip.complete === false) return null; // still being read: the check above says so
  const sum = (f) => cwip.parks.reduce((t, p) => t + f(p), 0);
  const reclassNet = (key) => cwip.reclass.reduce((t, x) => t + (x.to === key ? x.amount : 0) - (x.from === key ? x.amount : 0), 0);
  const unnamedNet = cwip.unnamedSum ?? 0;
  const allKept = cwip.unnamed.length === cwip.unnamedCount; // every unnamed line is listed, so the two columns can carry them too
  const unnamedIn = (key) => (allKept ? cwip.unnamed.filter((u) => u.account === key).reduce((t, u) => t + u.amount, 0) : 0);
  const iaud = sum((p) => p.iaud) + reclassNet('iaud') + unnamedIn('iaud');
  const cw = sum((p) => p.cwip) + reclassNet('cwip') + unnamedIn('cwip');
  const lines = sum((p) => p.lines);
  return (
    <>
      <section className="sheet" aria-label="The two ledger accounts in Zoho">
        <div className="sheet-title"><h2>The two ledger accounts in Zoho</h2><small>{cwip.rows.toLocaleString('en-IN')} ledger lines, read with their journals</small></div>
        <div className="tablewrap">
          <table className="tbl-plain">
            <thead><tr><th scope="col">Ledger account</th><th scope="col" className="num">Lines</th><th scope="col" className="num">Ledger, ₹</th><th scope="col" className="num">Trial Balance, ₹</th><th scope="col">Check</th></tr></thead>
            <tbody>
              {cwip.accounts.map((a) => (
                <tr key={a.key}>
                  <th scope="row">{a.name}</th>
                  <td className="num">{a.lines}</td>
                  <td className="num"><Amt v={a.ledger} /></td>
                  <td className="num">{a.tb === null ? <span className="dim">not in the Trial Balance</span> : <Amt v={a.tb} />}</td>
                  <td>{a.tb === null ? <span className="chip mute">No comparison</span> : Math.abs(a.ledger - a.tb) <= 1 ? <span className="chip ok">Agrees</span> : <span className="chip bad">Differs</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="tbl-note">Zoho keeps the whole of the capital work in two ledger accounts and has no park column. The park of each ledger line is read from the words Zoho holds for it: for a bill its project and narration, for a journal its notes and the name of the old ledger account that was emptied into the new one. The sheet shows the three headings (Intangible under development, Boundary wall and road, Transmission line and MCR) as the auditors grouped them; Zoho gives each park's total, not that split by heading, so each park is compared by its total.</p>
      </section>

      <section className="sheet" aria-label="Zoho by park">
        <div className="sheet-title"><h2>Zoho by park</h2><small>{cwip.parks.length} parks · {lines.toLocaleString('en-IN')} lines</small></div>
        <div className="tablewrap">
          <table className="tbl-plain">
            <thead>
              <tr><th scope="col" style={{ minWidth: 200 }}>Park</th><th scope="col" className="num">Intangibles (IAUD), ₹</th><th scope="col" className="num">CWIP, ₹</th><th scope="col" className="num">Total, ₹</th><th scope="col" className="num">Lines</th><th scope="col">Placed by</th></tr>
            </thead>
            <tbody>
              {cwip.parks.map((p) => (
                <tr key={p.name}>
                  <th scope="row">
                    {p.name}
                    {!p.onSheet && <span className="detail" style={SUB}>{p.why || 'Not a line of the signed sheet'}</span>}
                  </th>
                  <td className="num">{Math.abs(p.iaud) >= 0.005 ? rs(p.iaud) : ''}</td>
                  <td className="num">{Math.abs(p.cwip) >= 0.005 ? rs(p.cwip) : ''}</td>
                  <td className="num"><Amt v={p.total} /></td>
                  <td className="num">{p.lines}</td>
                  <td>
                    {p.named > 0 && <span className="chip ok">{p.named} named by Zoho</span>}
                    {p.allocated > 0 && <> <span className="chip warn">{p.allocated} placed as signed</span></>}
                    {!p.onSheet && <> <span className="chip mute">Not on the sheet</span></>}
                  </td>
                </tr>
              ))}
              {cwip.reclass.map((x) => (
                <tr key={x.entry}>
                  <th scope="row">
                    {x.entry}: moved between the two accounts
                    <span className="detail" style={SUB}>{day(x.date)} · in no park</span>
                  </th>
                  <td className="num">{srs(x.to === 'iaud' ? x.amount : -x.amount)}</td>
                  <td className="num">{srs(x.to === 'cwip' ? x.amount : -x.amount)}</td>
                  <td className="num">{rs(0)}</td>
                  <td className="num">{x.lines}</td>
                  <td><span className="chip mute">Auditors' journal</span></td>
                </tr>
              ))}
              {cwip.unnamedCount > 0 && (
                <tr>
                  <th scope="row">Lines that name no park<span className="detail" style={SUB}>listed below</span></th>
                  <td className="num">{allKept && Math.abs(unnamedIn('iaud')) >= 0.005 ? rs(unnamedIn('iaud')) : ''}</td>
                  <td className="num">{allKept && Math.abs(unnamedIn('cwip')) >= 0.005 ? rs(unnamedIn('cwip')) : ''}</td>
                  <td className="num"><Amt v={unnamedNet} /></td>
                  <td className="num">{cwip.unnamedCount}</td>
                  <td><span className="chip bad">Not placed</span></td>
                </tr>
              )}
              <tr className="last">
                <th scope="row">Both ledgers</th>
                <td className="num"><Amt v={iaud} /></td>
                <td className="num"><Amt v={cw} /></td>
                <td className="num"><Amt v={iaud + cw} /></td>
                <td className="num">{cwip.rows}</td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>
        <p className="tbl-note">IAUD is the Intangible Asset Under Development account, CWIP the Capital Work in Progress account. The parks add up to the two ledgers above: what moved from one account to the other is shown on its own line, because it belongs to no park. The signed sheet is compared park by park (the live column of the sheet), by the park's total in both accounts.</p>
      </section>

      <section className="sheet" aria-label="What the two accounts are made of">
        <div className="sheet-title"><h2>What the two accounts are made of</h2><small>by kind of posting</small></div>
        <div className="tablewrap">
          <table className="tbl-plain">
            <thead><tr><th scope="col">Kind of posting</th><th scope="col" className="num">Lines</th><th scope="col" className="num">Debits, ₹</th><th scope="col" className="num">Credits, ₹</th><th scope="col" className="num">Net, ₹</th></tr></thead>
            <tbody>
              {cwip.kinds.map((k) => (
                <tr key={k.key}>
                  <th scope="row">{k.label}</th>
                  <td className="num">{k.count}</td>
                  <td className="num">{rs(k.debit)}</td>
                  <td className="num">{k.credit ? rs(k.credit) : ''}</td>
                  <td className="num"><Amt v={k.net} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="tbl-note">The year-end clean-up journals (JN-Clean) emptied the old ledger accounts of each park into these two accounts on 31-Mar-2026; the old account's name is what says the park. The bills are the ones posted straight to these accounts, with the project and narration the staff entered.</p>
      </section>

      {cwip.allocations.length > 0 && (
        <section className="sheet" aria-label="Lines that Zoho does not place in a park">
          <div className="sheet-title"><h2>Lines whose own text names no park</h2><small>{cwip.allocations.length} placed as the signed sheet places them</small></div>
          <div className="tablewrap">
            <table className="tbl-plain">
              <thead><tr><th scope="col">Entry</th><th scope="col">Date</th><th scope="col">Account</th><th scope="col" className="num">Amount, ₹</th><th scope="col">Placed in</th></tr></thead>
              <tbody>
                {cwip.allocations.map((a, i) => (
                  <tr key={`${a.txn}-${i}`}>
                    <th scope="row">
                      {entryOf(a)}
                      <span className="detail" style={SUB}>{[a.who, a.text].filter(Boolean).join(' · ')}</span>
                    </th>
                    <td style={{ whiteSpace: 'nowrap' }}>{day(a.date)}</td>
                    <td>{ACCOUNT_WORD[a.account] ?? a.account}</td>
                    <td className="num">{rs(a.amount)}</td>
                    <td>
                      {a.parts.map((x) => <div key={x.park}>{x.park}{a.parts.length > 1 ? `: ${rs(x.amount)}` : ''}</div>)}
                      {a.why && <span className="detail" style={SUB}>{a.why}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="tbl-note">Zoho's text for these lines names no park, so there is nothing in Zoho to read the park from. Each is placed where the signed sheet has it; the list is typed in the configuration (config/cwip.fyYY.json) and shown here so that nothing is hidden. If one of these lines changes in Zoho it no longer matches its entry and drops out of this list into the one below.</p>
        </section>
      )}

      {cwip.elsewhere.length > 0 && (
        <section className="sheet" aria-label="Where Zoho and the signed sheet place a line differently">
          <div className="sheet-title"><h2>Where Zoho and the signed sheet place a line differently</h2><small>{cwip.elsewhere.length} line</small></div>
          <div className="tablewrap">
            <table className="tbl-plain">
              <thead><tr><th scope="col">Entry</th><th scope="col">Date</th><th scope="col" className="num">Amount, ₹</th><th scope="col">Zoho places it in</th><th scope="col">The signed sheet places it in</th><th scope="col">In Zoho today</th></tr></thead>
              <tbody>
                {cwip.elsewhere.map((e) => (
                  <tr key={e.entry}>
                    <th scope="row">
                      {e.entry}
                      <span className="detail" style={SUB}>{[e.who, e.why].filter(Boolean).join(' · ')}</span>
                    </th>
                    <td style={{ whiteSpace: 'nowrap' }}>{day(e.date)}</td>
                    <td className="num">{rs(e.amount)}</td>
                    <td>{e.zoho}</td>
                    <td>{e.sheet}</td>
                    <td>{e.found ? <span className="chip ok">Found</span> : <span className="chip warn">Not found</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="tbl-note">These two parks therefore differ on the sheet's own live check by this amount, in opposite directions; together they agree, and so does the total of the sheet.</p>
        </section>
      )}

      {cwip.unnamedCount > 0 && (
        <section className="sheet" aria-label="Lines that name no park">
          <div className="sheet-title"><h2>Lines that name no park and are not placed</h2><small>{cwip.unnamedCount} lines · net {rs(unnamedNet)}</small></div>
          <div className="tablewrap">
            <table className="tbl-plain">
              <thead><tr><th scope="col">Entry</th><th scope="col">Date</th><th scope="col">Account</th><th scope="col" className="num">Amount, ₹</th></tr></thead>
              <tbody>
                {cwip.unnamed.map((u, i) => (
                  <tr key={`${u.txn}-${i}`}>
                    <th scope="row">
                      {entryOf(u)}
                      <span className="detail" style={SUB}>{[u.who, u.text].filter(Boolean).join(' · ')}{u.ambiguous?.length > 1 ? ` · names ${u.ambiguous.join(' and ')}` : ''}</span>
                    </th>
                    <td style={{ whiteSpace: 'nowrap' }}>{day(u.date)}</td>
                    <td>{ACCOUNT_WORD[u.account] ?? u.account}</td>
                    <td className="num">{rs(u.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="tbl-note">These lines are in no park's total, so the parks do not add up to the ledgers by this amount. Nothing is guessed: a line is placed only when its own text names one park, or the configuration places it.</p>
        </section>
      )}
    </>
  );
}

/**
 * @param {{view:object, id:string, withHead?:boolean}} p
 *   withHead false: the tab already has its own heading (a sheet that has live figures above its signed part)
 */
export default function SignedSheet({ view, id, withHead = true }) {
  let data = null;
  try { data = getContext().sheet(id); } catch { data = null; }
  if (!data) return <div className="notice warn">The signed sheet "{id}" could not be read from the config folder.</div>;
  const entry = view.workbook?.sheets.find((s) => s.id === id) ?? data.entry;
  const ties = entry.ties ?? [];
  let overlay = null;
  try { overlay = liveOverlay(view.snapshot, data); } catch { overlay = null; }
  const gridId = `grid-${id}`;
  return (
    <>
      {withHead && (
        <>
          <PageHead title={entry.sheet}>
            {entry.note}{entry.page && <> <Link href={entry.page}>Live version</Link></>}
          </PageHead>
          <p style={{ marginBottom: 16 }}><Badge status={entry.status} /> <span className="dim small">As signed in the audited workbook for the year ended {longDate(view.workbook?.asAt ?? view.snapshot.meta.asOf)}.{overlay ? ' The signed figures are unchanged; the columns headed Live (Zoho), Check and Difference are added from Zoho Books.' : ''}{entry.hidden ? ' This sheet is hidden in the Excel file.' : ''}</span></p>
        </>
      )}

      {overlay && <LiveCheck overlay={overlay} keeps={entry.live?.keeps} />}
      {overlay && entry.live?.panel === 'stock' && <StockPanel stock={view.snapshot.stock} />}
      {overlay && entry.live?.panel === 'cwip' && <CwipPanel cwip={view.snapshot.cwip} />}

      {ties.length > 0 && (
        <section className="sheet" aria-label="Agreement with the live figures">
          <div className="sheet-title"><h2>Does it agree with the live figures?</h2></div>
          <div className="tablewrap">
            <table className="stmt recon">
              <thead><tr><th scope="col">Total</th><th scope="col" className="num">As signed</th><th scope="col" className="num">Live from Zoho</th><th scope="col" className="num">Difference in ₹</th><th scope="col" className="res">Result</th></tr></thead>
              <tbody>
                {ties.map((t) => (
                  <tr key={t.label}>
                    <th scope="row">{t.label}<span className="detail">Cell {t.cell}</span>{t.error && <span className="detail" style={{ color: 'var(--bad)' }}>{t.error}</span>}</th>
                    <td className="num"><Amt v={t.fixed} /></td>
                    <td className="num"><Amt v={t.live} /></td>
                    <td className="num dim">{gap(t.diff)}</td>
                    <td><span className={`chip ${t.status === 'OK' ? 'ok' : 'bad'}`}>{t.status === 'OK' ? 'Agrees' : 'Differs'}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="tbl-note">A total agrees when it is within ₹10 of the live figure, because the auditors' sheets are rounded line by line.</p>
        </section>
      )}

      <section className="sheet" aria-label={entry.sheet}>
        <div className="sheet-title"><h2>{entry.sheet}</h2><small>{withHead ? '' : 'As signed, '}{data.rows.length.toLocaleString('en-IN')} rows</small></div>
        {data.mode === 'grid' ? (
          <>
            <SheetFilter target={gridId} />
            <Grid rows={data.rows} columns={data.columns} id={gridId} overlay={overlay} valueCol={overlay ? entry.live.value : null} />
          </>
        ) : (
          <DocRows rows={data.rows} />
        )}
      </section>
    </>
  );
}
