// Live check of the auditors' detail sheets.
//
// Some sheets of the signed workbook are lists - one line per customer, vendor, loan or ledger account. The same lines exist in Zoho
// Books (the Trial Balance's accounts, and the customer / supplier balances the dashboard already works out), so for such a sheet each
// line gets the figure Zoho gives today next to the figure that was signed. Everything the sheet holds beyond that balance (ageing
// buckets, short / long-term split, remarks ...) stays as signed, because Zoho's FY26 books do not carry it (see README).
//
//   OK      the line was found in Zoho and the two figures agree (within OVERLAY_TOLERANCE rupees)
//   DIFF    found, but the figures differ  -> somebody changed the books after signing, or the auditors reclassified the line
//   NAME    not found by name, but a Zoho line has the same amount and the most similar name (spelt differently). When several lines of the
//           sheet and several Zoho lines share an amount (five investments of Rs 1,00,000; CGST and SGST of the same amount), the pairs with the
//           clearest name are taken first and a pair is accepted only when nothing else fits it just as well
//   NONE    not found in Zoho at all -> stays as signed
//
// Some sheets carry more than the balance: the debtors' and creditors' ageing (invoiced, received, the age buckets ...). Where Zoho can give such a column
// too - see lib/ageing.mjs - the config lists it under `live.columns` and every matched line gets, in that column, the figure Zoho gives next to the signed one
// (agrees / differs), and the column's total is worked out again the same way. A column Zoho cannot give stays as signed.
//
// A stock list (the Closing Stock sheet) names the same item on several rows (stock bought at different rates) and Zoho's stock summary has several lines for it too
// (an old SKU and the "_New" one): a block with `perLine` pairs the rows of one item with the Zoho lines of that item - the same value first, then what is left in order
// of size - and a Zoho line that no row takes is listed under the extras (update-17).
//
// A "Total" line gets a live total only when the sheet's own total really is the sum of the lines above it.
// Zoho lines that the sheet does not have (a new customer, a vendor with a balance now) are listed as "extras".
// Pure functions: the sheet rows and the snapshot are handed in.

export const OVERLAY_TOLERANCE = 1; // rupees, per line
export const TOTAL_TOLERANCE = 5; // rupees, per total
export const COLUMN_TOLERANCE = 2; // rupees, per line of an extra live column (the ageing buckets are worked out from several Zoho figures)
const MIN_EXTRA = 1; // a Zoho line below one rupee is not worth listing

/** "Slyds Services Pvt Ltd_x000D_" and "SLYDS SERVICES PVT. LTD." read the same. */
export const normName = (s) => String(s ?? '').toLowerCase().replace(/_x000d_/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
const words = (s) => new Set(String(s ?? '').toLowerCase().replace(/_x000d_/g, '').split(/[^a-z0-9]+/).filter((w) => w.length >= 3));
/** 0 when the two names share no word, else (words in common) / (words in either): "CGST Input Unclaimed (RAJ)" is closer to "CGST Input-Unclaimed" than to "SGST Input-Unclaimed". */
export function similarity(a, b) {
  const wa = words(a);
  const wb = words(b);
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared += 1;
  return shared === 0 ? 0 : shared / (wa.size + wb.size - shared);
}

/**
 * Where the live lines come from: "account" (every ledger account of the Trial Balance) | "account:bucket+bucket" (only the accounts of those
 * balance-sheet groups of config/mapping, which keeps a profit-and-loss account of the same name out) | "customer" | "advance" (the customers' advances,
 * snapshot.advances, as the auditors' list shows them) | "supplier:class+class" | "split:<key>" (update-15: the parts of ONE Zoho ledger account that the sheet lists line by line -
 * the fixed deposits bank by bank, the three security deposits, the PF shares, and - for a contact the sheet lists twice - the insurer's advance and payable;
 * snapshot.splits[key], see lib/splits.mjs. Its pool holds one entry per part, and, if some ledger entries could not be given to a part, one entry named like the account that holds
 * that rest, which a block's `lump` compares in total. A split of a contact also takes that contact out of the group's "extras": its one balance is not a line of its own any more) |
 * "stock" (update-17: the stock lines of Zoho's Inventory Valuation Summary, snapshot.stock.lines: one pool entry per item name with its value and, as extra figures, its quantity `qty` and (update-19) its unit `unit`, a text from Zoho's item list;
 * the entry also keeps the separate lines of that name in `lines`, which a block with `perLine` pairs with the rows of the sheet) |
 * "stockgap:<ledger account>" (update-18: the auditors' own working of the Closing Stock sheet - one entry named "Difference" = the stock accounts of the Trial Balance less the items of Zoho's stock summary
 * less the named ledger account (NPD Panchu Purchase), which the sheet shows separately at its foot) |
 * "cwip" (update-20: the parks of the CWIP tab, snapshot.cwip.parks - one entry per park with the total of its lines in the ledgers of Capital Work in Progress and Intangible Asset Under Development
 * together, as booked in Zoho; lib/cwip.mjs. A block compares it with the SUM of the sheet's three columns: `valueCols`).
 */
export function parseSource(spec) {
  const [kind, rest] = String(spec).split(':');
  const list = () => new Set(String(rest ?? '').split('+').filter(Boolean));
  if (kind === 'account') return { kind, classes: null, buckets: rest ? list() : null };
  if (kind === 'customer') return { kind, classes: null };
  if (kind === 'advance') return { kind, classes: null };
  if (kind === 'supplier') return { kind, classes: list() };
  if (kind === 'split') return { kind, key: String(rest ?? '') };
  if (kind === 'stock') return { kind, classes: null };
  if (kind === 'stockgap') return { kind, account: String(rest ?? '').trim() };
  if (kind === 'cwip') return { kind, classes: null };
  throw new Error(`Unknown live source "${spec}" (expected account, account:<group>+<group>, customer, advance, supplier:<class>+<class>, split:<key>, stock, stockgap:<account> or cwip)`);
}

/** Why the stock lines of Zoho's stock summary are not in this snapshot (an older copy, or the report could not be read), or null. */
function stockUnavailable(snapshot) {
  if (Array.isArray(snapshot.stock?.lines)) return null;
  const why = snapshot.stock?.error ?? 'an older copy of the data, or the report could not be read';
  return `Zoho's stock summary is not in this snapshot (${why}): refresh the data, until then the items stay as signed`;
}

/** update-18: the sheet's "Difference" = Trial Balance (stock accounts) - items of the stock summary - the ledger account the sheet deducts; null when the snapshot cannot say. */
export function stockGapValue(snapshot, accountName) {
  const st = snapshot.stock;
  if (!st || !Array.isArray(st.byAccount) || typeof st.tb !== 'number' || typeof st.total !== 'number') return null;
  const want = normName(accountName);
  const acc = st.byAccount.find((r) => normName(r.name) === want);
  if (!acc || acc.tb === null || acc.tb === undefined) return null;
  return st.tb - st.total - acc.tb;
}

/** Why a source cannot be used with this snapshot (an older stored snapshot has no customer advances; one that could not read them has `advances: null`), or null. */
export function sourceUnavailable(snapshot, spec) {
  for (const one of Array.isArray(spec) ? spec : [spec]) {
    if (!one) continue;
    const src = parseSource(one);
    if (src.kind === 'advance' && !snapshot.advances) return 'The customer advances are not in this snapshot (an older copy, or the ledger of the advance account could not be read): refresh the data, until then the list stays as signed';
    if (src.kind === 'stock') {
      const why = stockUnavailable(snapshot);
      if (why) return why;
    }
    if (src.kind === 'stockgap') {
      const why = stockUnavailable(snapshot);
      if (why) return why;
      if (stockGapValue(snapshot, src.account) === null) return `The ledger account "${src.account}" is not among the stock accounts of this snapshot: the Difference stays as signed`;
    }
    if (src.kind === 'cwip') {
      const c = snapshot.cwip;
      if (!c || c.error || !Array.isArray(c.parks)) return `The park split of the CWIP and IAUD ledgers is not in this snapshot (${c?.error ?? 'an older copy of the data, or the ledgers could not be read'}): refresh the data, until then the park table stays as signed`;
    }
    if (src.kind === 'split') {
      const s = snapshot.splits?.[src.key];
      if (!s || s.error || !Array.isArray(s.parts)) {
        const why = s?.error ?? snapshot.splits?.error ?? 'an older copy of the data, or the ledger of the account could not be read';
        return `The split "${s?.title ?? src.key}" is not in this snapshot (${why}): refresh the data, until then its lines are compared in total`;
      }
    }
  }
  return null;
}

/**
 * Why a source is not ready YET (not a fault): the park split of the CWIP and IAUD ledgers reads the journals behind the two accounts a few at a time (`cwip_journal_budget`
 * per refresh), so on a cold cache the first refresh or two have only part of them. The next refresh reads on; until then the block stays as signed. Returns the message, or null.
 */
export function sourceWaiting(snapshot, spec) {
  for (const one of Array.isArray(spec) ? spec : [spec]) {
    if (!one) continue;
    const src = parseSource(one);
    if (src.kind === 'cwip' && snapshot.cwip && !snapshot.cwip.error && Array.isArray(snapshot.cwip.parks) && snapshot.cwip.complete === false) {
      const n = snapshot.cwip.pending ?? 0;
      return `The park split of the CWIP and IAUD ledgers is not complete yet (${n} journal${n === 1 ? '' : 's'} behind the two accounts still to be read from Zoho): the page reads them by itself in a moment, until then the park table stays as signed`;
    }
  }
  return null;
}

/**
 * Why an extra live column cannot be built from this snapshot (no ageing in an older copy; Zoho refused a report; not a year end), or null.
 * `needs` in the column's config says which part of snapshot.ageing it reads; `part` (optional) a sub-part of it that may be missing on its own (`vbs`).
 */
export function columnsUnavailable(snapshot, column) {
  const need = column.needs;
  if (!need) return null;
  if (need === 'stock') return stockUnavailable(snapshot) ? 'Stock quantities: Zoho\'s stock summary is not in this snapshot. They stay as signed' : null;
  if (need === 'stockunit') { // update-19: the unit of each stock item comes from Zoho's item list, not from the stock summary
    if (stockUnavailable(snapshot)) return 'Usage unit: Zoho\'s stock summary is not in this snapshot. It stays as signed';
    if (!(snapshot.stock?.lines ?? []).some((l) => typeof l.unit === 'string' && l.unit)) {
      return `Usage unit: ${snapshot.stock?.unitsError ? `Zoho's item list could not be used (${snapshot.stock.unitsError})` : 'Zoho\'s item list is not in this snapshot (an older copy): refresh the data'}. It stays as signed`;
    }
    return null;
  }
  const label = need === 'debtors' ? 'Debtors' : 'Creditors';
  if (!snapshot.ageing?.[need]) {
    const why = snapshot.ageing?.problems?.[need] ?? 'The ageing figures are not in this snapshot (an older copy): refresh the data';
    return `${label} ageing columns: ${why}. They stay as signed`;
  }
  // a column that rests on one more report of the same list (Billed / Paid: the Vendor Balance Summary) says so with `part`
  if (column.part && !snapshot.ageing[need][column.part]) {
    const why = snapshot.ageing.problems?.[column.part] ?? 'This part of the ageing figures is not in this snapshot (an older copy): refresh the data';
    return `${label} ageing columns: ${why}. They stay as signed`;
  }
  return null;
}

/** A source is one spec ("account") or a list of them (["account", "supplier:outstanding"]) whose lines are looked at together. */
export const specKey = (spec) => (Array.isArray(spec) ? spec.join(' | ') : String(spec));

/** The ageing figures of the snapshot by contact id (customers or vendors), or an empty map. */
const ageingIndex = (list) => new Map((list ?? []).map((x) => [x.id, x]));

/** name -> { name, value, n, cols } for one source (or a list of sources). Lines with the same name are added together (so are their extra columns). */
export function buildPool(snapshot, spec) {
  const pool = new Map();
  const add = (name, value, cols, line = false) => {
    const k = normName(name);
    if (!k) return;
    let e = pool.get(k);
    if (e) {
      e.value += value; e.n += 1;
      if (cols) { e.cols ??= {}; for (const [f, v] of Object.entries(cols)) e.cols[f] = typeof v === 'number' ? (e.cols[f] ?? 0) + v : (e.cols[f] ?? v); }
    } else { e = { key: k, name: String(name).trim(), value, n: 1, cols: cols ? { ...cols } : undefined }; pool.set(k, e); }
    if (line) (e.lines ??= []).push({ value, cols: cols ? { ...cols } : undefined }); // the separate lines of one name (a stock item with an old and a new SKU)
  };
  const debtors = ageingIndex(snapshot.ageing?.debtors?.customers);
  const creditors = ageingIndex(snapshot.ageing?.creditors?.vendors);
  for (const one of Array.isArray(spec) ? spec : [spec]) {
    const src = parseSource(one);
    if (src.kind === 'account') {
      for (const g of src.buckets ?? []) if (!(g in (snapshot.buckets ?? {}))) throw new Error(`Live source "${one}": there is no group "${g}" in the snapshot`);
      for (const [g, b] of Object.entries(snapshot.buckets ?? {})) {
        if (src.buckets && !src.buckets.has(g)) continue;
        for (const a of b.accounts ?? []) add(a.name, Math.abs(a.closing));
      }
    } else if (src.kind === 'customer') {
      for (const c of snapshot.receivables?.customers ?? []) add(c.name, Math.abs(c.receivable), debtors.get(c.id));
    } else if (src.kind === 'advance') {
      for (const c of snapshot.advances?.customers ?? []) add(c.name, c.advance);
    } else if (src.kind === 'stock') {
      for (const l of snapshot.stock?.lines ?? []) add(l.name, l.value, l.unit ? { qty: l.qty, unit: l.unit } : { qty: l.qty }, true);
    } else if (src.kind === 'cwip') {
      for (const p of snapshot.cwip?.parks ?? []) add(p.name, Math.abs(p.total));
    } else if (src.kind === 'stockgap') {
      const v = stockGapValue(snapshot, src.account);
      if (v !== null) add('Difference', Math.abs(v)); // like every other source, the amount without its sign (the tab shows the signed figures)
    } else if (src.kind === 'split') {
      const sp = snapshot.splits?.[src.key];
      for (const p of sp?.parts ?? []) add(p.name, Math.abs(p.amount));
      if (sp && Math.abs(sp.residual ?? 0) >= MIN_EXTRA) add(sp.name, Math.abs(sp.residual)); // what no part took: compared in total through the block's `lump`
    } else {
      for (const p of snapshot.suppliers?.parties ?? []) if (src.classes.has(p.class)) add(p.name, Math.abs(p.amount), creditors.get(p.id));
    }
  }
  return pool;
}

/** A Zoho contact whose name could not be fetched shows up with its 19-digit id as the name. */
const isIdOnly = (name) => /^\d{8,}$/.test(String(name).trim());

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/** Row index of the first row, from `from` on, in which a cell starts with `start` (case and double spaces ignored); -1 if none. */
function findStart(rows, start, from) {
  const want = clean(start);
  for (let i = from; i < rows.length; i += 1) {
    if (rows[i].some((c) => typeof c === 'string' && clean(c).startsWith(want))) return i;
  }
  return -1;
}

/**
 * The rows of the sheet that name one item, against the Zoho lines of that item (update-17). `rows` are the signed figures (positive), `lines` the Zoho lines { value }.
 * A row takes the Zoho line of the same value (within OVERLAY_TOLERANCE; the closest first); what is left is paired in order of size, so a figure that changed still
 * meets its own line and shows as a difference. Returns the pairs [row index, line index], the rows no line is left for, and the lines (with a value) no row took.
 */
export function pairLines(rows, lines) {
  const pairs = [];
  const usedR = new Set();
  const usedL = new Set();
  const cand = [];
  rows.forEach((v, i) => lines.forEach((l, j) => { const gap = Math.abs(l.value - v); if (gap <= OVERLAY_TOLERANCE) cand.push({ i, j, gap }); }));
  cand.sort((a, b) => a.gap - b.gap || a.i - b.i || a.j - b.j);
  for (const c of cand) if (!usedR.has(c.i) && !usedL.has(c.j)) { pairs.push([c.i, c.j]); usedR.add(c.i); usedL.add(c.j); }
  const leftR = rows.map((_, i) => i).filter((i) => !usedR.has(i)).sort((a, b) => rows[b] - rows[a] || a - b);
  const leftL = lines.map((_, j) => j).filter((j) => !usedL.has(j) && Math.abs(lines[j].value) >= MIN_EXTRA).sort((a, b) => lines[b].value - lines[a].value || a - b);
  const n = Math.min(leftR.length, leftL.length);
  for (let k = 0; k < n; k += 1) pairs.push([leftR[k], leftL[k]]);
  return { pairs, noLine: leftR.slice(n), noRow: leftL.slice(n) };
}

/**
 * @param {object} snapshot
 * @param {{rows:any[][]}} sheet                    the exported sheet
 * @param {{label:number, value:number, blocks:object[], groups?:object}} live   its entry `live` in config/workbook.fyYY/index.json
 *   blocks[]: { start, source|null, fallback?, value?, valueCols?, totalValue?, group?, title?, lump?, aliases?, sums?, inclusive?, perLine? }  - the block runs from the row that starts with `start` to the next block
 *             (that row is the block's heading; with `inclusive` it is the block's first line - the closing lines of a sheet that have no heading of their own);
 *             `perLine` = an item can stand on several rows of the sheet and on several lines of the source (the stock list): its rows are paired with its lines (see pairLines);
 *             `fallback` = the source used instead when `source` is not available in this snapshot (a `split:` source of an older copy, say);
 *             `totalValue` = the column of the block's "Total" line, when it is not the column of the lines; `source` may be a list of sources; `lump` = name of the one Zoho line that holds the block's unmatched lines together;
 *             `aliases` = { "name on the sheet": "name in Zoho" } for a line whose Zoho account is called something else (typed, so it is visible);
 *             `sums` = { "name on the sheet": "<source>" } for a line that is the total of a whole list in Zoho (the staff imprest balances, say)
 *   columns[]: { col, field, label, needs, part?, sumCols?, text?, tol?, totalTol? } - another column of the sheet that Zoho can give per line: `field` is the figure on the matched Zoho line
 *             (see buildPool: snapshot.ageing), `needs` the part of snapshot.ageing it comes from ("debtors" | "creditors"), `sumCols` the sheet columns that together
 *             make the signed figure (the three columns "1-2 years", "2-3 years", "more than 3 years" are compared as one: `col` is the first of them); `text: true` = the column holds
 *             text (the Vendor Code): the two texts are compared (case and spaces ignored) and the column has no total; `tol` / `totalTol` = the rupees (or units) two figures
 *             may differ by on a line / in a total (default COLUMN_TOLERANCE / TOTAL_TOLERANCE; a quantity is compared to 0.01 and 1)
 *   groups{}: { name: { source } } - lines of that source that no block of the group used are the "extras"
 *   ties[]:   { title, lines: [{ block, label, nth?, sign? }], zoho: [{ source, name, sign?, group? }] } - sheet lines that Zoho keeps as one balance (PF
 *             payable split into employee and employer share; one insurer's policies shown gross as payable and advance; one contact shown as a loan and an
 *             advance). The lines are looked at only when they matched nothing on their own; they agree when
 *             sum(sign x line) = sum(sign x Zoho balance) within TOTAL_TOLERANCE. `block` is the `start` of a block; `nth` the 1st, 2nd ... line of that
 *             name in the block; `group` marks the Zoho balance as used for the "extras" of that group. A tie whose Zoho balance is a `split:` that this snapshot does not have is skipped.
 */
export function buildOverlay(snapshot, sheet, live) {
  const rows = sheet.rows;
  const problems = [];
  const waiting = []; // a source that is only not ready yet (the CWIP journals are still being read): said on the page, but not a problem
  const pools = new Map();
  const poolOf = (spec) => { const k = specKey(spec); if (!pools.has(k)) pools.set(k, buildPool(snapshot, spec)); return pools.get(k); };

  // a block whose source this snapshot cannot give stays as signed (and the page says why)
  const blocksCfg = live.blocks.map((b) => {
    const why = b.source ? sourceUnavailable(snapshot, b.source) : null;
    const wait = !why && b.source ? sourceWaiting(snapshot, b.source) : null;
    if (wait) waiting.push(`${b.title ?? b.start}: ${wait}`);
    if (!why && !wait) return b;
    if (why) problems.push(`${b.title ?? b.start}: ${why}`);
    return { ...b, source: b.fallback ?? null }; // `fallback`: the source that does the job without the unavailable one (the whole account, compared in total)
  });

  // extra live columns (the ageing): the ones this snapshot can give
  const colSpecs = [];
  for (const c of live.columns ?? []) {
    const why = columnsUnavailable(snapshot, c);
    if (why) { if (!problems.includes(why)) problems.push(why); continue; }
    colSpecs.push({ col: c.col, group: c.sumCols ?? [c.col], field: c.field, label: c.label ?? c.field, text: Boolean(c.text), tol: c.tol ?? COLUMN_TOLERANCE, totalTol: c.totalTol ?? TOTAL_TOLERANCE, ok: 0, diff: 0, totalOk: 0, totalBad: 0 });
  }
  const num0 = (v) => (typeof v === 'number' ? v : 0);
  const signedOf = (sp, r) => sp.group.reduce((t, c) => t + num0(rows[r][c]), 0);

  // ---- where does each block start? ----
  const starts = [];
  let cursor = 0;
  for (const b of blocksCfg) {
    const at = findStart(rows, b.start, cursor);
    if (at < 0) { problems.push(`The block "${b.start}" was not found in the sheet`); starts.push(null); continue; }
    starts.push(at);
    cursor = at + 1;
  }
  const order = starts.map((at, i) => ({ at, i })).filter((x) => x.at !== null).sort((a, b) => a.at - b.at);

  const byRow = {};
  const blocks = [];
  const lumpRows = new Map(); // block config -> its lines that Zoho holds as one combined balance
  const settle = []; // the totals of each block, worked out once every line - and every tie across blocks - is settled
  const ctxByStart = new Map(); // block heading -> { out, detail }, for the ties
  const lineExtras = []; // update-17: Zoho stock lines of an item that no row of the sheet took
  const usedByGroup = new Map(); // group -> Set(pool key)
  const used = (g) => { if (!usedByGroup.has(g)) usedByGroup.set(g, new Set()); return usedByGroup.get(g); };

  order.forEach(({ at, i }, k) => {
    const b = blocksCfg[i];
    const end = k + 1 < order.length ? order[k + 1].at : rows.length;
    const valueCol = b.value ?? live.value;
    const out = { title: b.title ?? rows[at].find((c) => typeof c === 'string') ?? b.start, start: at, end, source: b.source ?? null, group: b.group ?? null, ok: 0, name: 0, diff: 0, none: 0, lumpLines: 0, lump: null, signed: 0, totalsOk: 0, totalsBad: 0, notFound: [] };

    // detail lines and total lines of the block
    const detail = [];
    for (let r = b.inclusive ? at : at + 1; r < end; r += 1) {
      const label = rows[r][live.label];
      // a sheet may keep its "Total" in another column than the lines (Statutory Liabilities: lines in column D, subtotals and total in E)
      let v = typeof label === 'string' && /^total\b/i.test(label.trim()) && b.totalValue !== undefined ? rows[r][b.totalValue] : rows[r][valueCol];
      // update-20: the figure of a line is the SUM of several columns (the CWIP sheet: three columns for the same park); a line with none of them numeric is no line
      if (b.valueCols) { const parts = b.valueCols.map((c) => rows[r][c]).filter((x) => typeof x === 'number'); v = parts.length ? parts.reduce((t, x) => t + x, 0) : undefined; }
      if (typeof v !== 'number') continue;
      const named = typeof label === 'string' && label.trim() !== '';
      // a figure with no label under a list is the list's total (it only becomes a live total when it really is the sum of the lines)
      if (!named && !(label === null || label === undefined || label === '')) continue;
      detail.push({ r, label: named ? label.trim() : '', signed: v, total: !named || /^total\b/i.test(label.trim()) });
    }
    if (!b.source) {
      out.signed = detail.filter((d) => !d.total).length;
      blocks.push(out);
      return;
    }
    ctxByStart.set(b.start, { out, detail });

    const pool = poolOf(b.source);
    const claimed = used(b.group ?? specKey(b.source));
    // a contact that this block takes account by account (split:<key> of a contact: an insurer's advance and payable ...) is no longer one balance of the supplier list
    for (const one of Array.isArray(b.source) ? b.source : [b.source]) {
      const sp = parseSource(one);
      const partyName = sp.kind === 'split' ? snapshot.splits?.[sp.key]?.partyName : null;
      if (partyName) claimed.add(normName(partyName));
    }
    const lines = detail.filter((d) => !d.total);

    // pass 0: the lines the configuration names itself - a total of a whole list, or an account that is called something else in Zoho
    const aliasOf = new Map(Object.entries(b.aliases ?? {}).map(([k, v]) => [normName(k), v]));
    const sumOf = new Map(Object.entries(b.sums ?? {}).map(([k, v]) => [normName(k), v]));
    const afterTyped = [];
    for (const d of lines) {
      const n = normName(d.label);
      if (sumOf.has(n)) {
        const part = poolOf(sumOf.get(n));
        const value = [...part.values()].reduce((t, e) => t + e.value, 0);
        setRow(d, { value, name: `Total of the ${part.size} balances in Zoho` }, 'named');
        continue;
      }
      const hit = aliasOf.has(n) ? pool.get(normName(aliasOf.get(n))) : null;
      if (hit && !claimed.has(hit.key)) { claimed.add(hit.key); setRow(d, hit, 'named'); } else afterTyped.push(d);
    }
    // pass 1: by name - a Zoho balance is used once, so a second line with the same name is looked at further down
    const open = [];
    if (b.perLine) {
      // an item with several rows on the sheet and several lines in Zoho: its rows are paired with its lines one by one (the value first)
      const byItem = new Map();
      for (const d of afterTyped) { const n = normName(d.label); byItem.set(n, [...(byItem.get(n) ?? []), d]); }
      for (const [n, ds] of byItem) {
        const hit = pool.get(n);
        if (!hit || claimed.has(hit.key)) { open.push(...ds); continue; }
        claimed.add(hit.key);
        const zl = hit.lines ?? [{ value: hit.value, cols: hit.cols }];
        const r = pairLines(ds.map((d) => Math.abs(d.signed)), zl);
        for (const [i, j] of r.pairs) setRow(ds[i], { ...hit, value: zl[j].value, cols: zl[j].cols }, 'exact');
        for (const i of r.noLine) open.push(ds[i]);
        for (const j of r.noRow) lineExtras.push({ group: b.group ?? null, name: hit.name, value: zl[j].value });
      }
      open.sort((x, y) => x.r - y.r);
    } else {
      for (const d of afterTyped) {
        const hit = pool.get(normName(d.label));
        if (hit && !claimed.has(hit.key)) { claimed.add(hit.key); setRow(d, hit, 'exact'); } else open.push(d);
      }
    }
    // pass 2: the unclaimed Zoho line with the same amount and the most similar name (spelt differently).
    // Where several lines share an amount, the clearest pairs go first; a pair is taken only when no other pair for the same line, or for
    // the same Zoho line, is just as good (a tie stays open rather than being guessed).
    const left = [];
    const candidates = open.filter((d) => Math.abs(d.signed) >= MIN_EXTRA); // a nil line that Zoho does not have: nothing to say
    out.signed += open.length - candidates.length;
    const free = () => [...pool.values()].filter((e) => !claimed.has(e.key) && e.value >= MIN_EXTRA);
    const freeNow = free();
    let pairs = [];
    for (const d of candidates) {
      for (const e of freeNow) {
        if (Math.abs(e.value - Math.abs(d.signed)) > OVERLAY_TOLERANCE) continue;
        const s = similarity(d.label, e.name);
        if (s > 0) pairs.push({ d, e, s });
      }
    }
    const matched = new Set();
    for (;;) {
      pairs = pairs.filter((p) => !matched.has(p.d) && !claimed.has(p.e.key));
      if (pairs.length === 0) break;
      const best = (key) => {
        const m = new Map();
        for (const p of pairs) {
          const k = p[key];
          const cur = m.get(k);
          if (!cur || p.s > cur.s) m.set(k, { s: p.s, n: 1 }); else if (p.s === cur.s) cur.n += 1;
        }
        return m;
      };
      const topD = best('d');
      const topE = best('e');
      const take = pairs.filter((p) => topD.get(p.d).s === p.s && topD.get(p.d).n === 1 && topE.get(p.e).s === p.s && topE.get(p.e).n === 1);
      if (take.length === 0) break;
      for (const p of take) { matched.add(p.d); claimed.add(p.e.key); setRow(p.d, p.e, 'amount'); }
    }
    for (const d of candidates) if (!matched.has(d)) left.push(d);
    // pass 3: Zoho contacts whose name could not be fetched (only their id is known) - paired by amount when as many lines as contacts have it
    const byAmount = (x) => String(Math.round(x));
    const idOnly = new Map();
    for (const e of free()) if (isIdOnly(e.name)) { const k = byAmount(e.value); idOnly.set(k, [...(idOnly.get(k) ?? []), e]); }
    const rest = [];
    const groups3 = new Map();
    for (const d of left) { const k = byAmount(Math.abs(d.signed)); groups3.set(k, [...(groups3.get(k) ?? []), d]); }
    for (const [k, ds] of groups3) {
      const es = idOnly.get(k) ?? [];
      if (es.length === ds.length && es.length > 0 && es.every((e) => Math.abs(e.value - Math.abs(ds[0].signed)) <= OVERLAY_TOLERANCE)) {
        ds.forEach((d, i) => { claimed.add(es[i].key); setRow(d, { ...es[i], name: `Zoho contact ${es[i].name.slice(-6)} (name not fetched)` }, 'amount'); });
      } else rest.push(...ds);
    }
    rest.sort((a, b) => a.r - b.r);
    // the block's lump: Zoho keeps the lines that matched nothing as one combined balance
    const lumpEntry = b.lump ? pool.get(normName(b.lump)) : null;
    if (lumpEntry && !claimed.has(lumpEntry.key) && rest.length) {
      claimed.add(lumpEntry.key);
      const signedSum = rest.reduce((t, d) => t + Math.abs(d.signed), 0);
      const diff = lumpEntry.value - signedSum;
      out.lump = { name: lumpEntry.name, lines: rest.length, signed: signedSum, live: lumpEntry.value, diff, ok: Math.abs(diff) <= TOTAL_TOLERANCE };
      for (const d of rest) byRow[d.r] = { kind: 'detail', status: 'LUMP', live: null, diff: null, signed: d.signed, lumpOk: out.lump.ok };
      out.lumpLines = rest.length;
      lumpRows.set(b, rest);
    } else {
      for (const d of rest) { byRow[d.r] = { kind: 'detail', status: 'NONE', live: null, diff: null, signed: d.signed }; out.none += 1; out.notFound.push({ label: d.label, signed: d.signed }); }
    }

    function setRow(d, hit, how) {
      const diff = hit.value - Math.abs(d.signed);
      const same = Math.abs(diff) <= OVERLAY_TOLERANCE;
      const status = how === 'amount' ? 'NAME' : same ? 'OK' : 'DIFF';
      byRow[d.r] = { kind: 'detail', status, live: hit.value, diff, signed: d.signed, zohoName: how === 'exact' ? undefined : hit.name };
      if (status === 'OK') out.ok += 1; else if (status === 'NAME') out.name += 1; else out.diff += 1;
      if (colSpecs.length && hit.cols) {
        const cols = {};
        for (const sp of colSpecs) {
          const lv = hit.cols[sp.field];
          if (sp.text) { // a text column (the Vendor Code): the same text, whatever the case or the spaces; no total
            if (typeof lv !== 'string') continue;
            const signed = String(rows[d.r][sp.col] ?? '').replace(/\s+/g, ' ').trim();
            const st = signed.toLowerCase() === lv.replace(/\s+/g, ' ').trim().toLowerCase() ? 'OK' : 'DIFF';
            cols[sp.col] = { live: lv, signed, diff: null, status: st, text: true };
            if (st === 'OK') sp.ok += 1; else sp.diff += 1;
            continue;
          }
          if (typeof lv !== 'number') continue;
          const signed = signedOf(sp, d.r);
          const gap = lv - signed;
          const st = Math.abs(gap) <= sp.tol ? 'OK' : 'DIFF';
          cols[sp.col] = { live: lv, signed, diff: gap, status: st, group: sp.group.length > 1 ? sp.group : undefined };
          if (st === 'OK') sp.ok += 1; else sp.diff += 1;
        }
        byRow[d.r].cols = cols;
      }
    }

    settle.push(() => {
      // totals: only where the sheet's own total is the sum of the lines above it (since the previous total)
      let signedSum = 0;
      let liveSum = 0;
      let have = 0;
      let xs = colSpecs.map(() => ({ signed: 0, live: 0 }));
      for (const d of detail) {
        if (!d.total) {
          have += 1;
          signedSum += d.signed;
          const row = byRow[d.r];
          if (row && row.status === 'LUMP' && row.tie !== undefined) {
            liveSum += d.signed + row.adjust; // a tie is compared once, at its last line
          } else if (row && row.status === 'LUMP') {
            const mine = lumpRows.get(b);
            const lastOne = mine && mine[mine.length - 1].r === d.r;
            liveSum += d.signed + (lastOne ? Math.sign(d.signed || 1) * out.lump.diff : 0); // the combined balance is compared once, at its last line
          } else {
            liveSum += row && row.live !== null && row.live !== undefined ? Math.sign(d.signed || 1) * row.live : d.signed;
          }
          colSpecs.forEach((sp, i) => { if (sp.text) return; const sg = signedOf(sp, d.r); xs[i].signed += sg; xs[i].live += row?.cols?.[sp.col]?.live ?? sg; });
          continue;
        }
        if (have > 0 && Math.abs(signedSum - d.signed) <= TOTAL_TOLERANCE) {
          const diff = liveSum - d.signed;
          const status = Math.abs(diff) <= TOTAL_TOLERANCE ? 'OK' : 'DIFF';
          byRow[d.r] = { kind: 'total', status, live: liveSum, diff, signed: d.signed };
          if (status === 'OK') out.totalsOk += 1; else out.totalsBad += 1;
        }
        // the total of each extra column, where the sheet has one and it is the sum of the lines above
        colSpecs.forEach((sp, i) => {
          if (!sp.text && have > 0 && sp.group.some((c) => typeof rows[d.r][c] === 'number')) {
            const totalSigned = signedOf(sp, d.r);
            if (Math.abs(xs[i].signed - totalSigned) <= sp.totalTol) {
              const gap = xs[i].live - totalSigned;
              const st = Math.abs(gap) <= sp.totalTol ? 'OK' : 'DIFF';
              byRow[d.r] ??= { kind: 'cols', status: 'COLS', live: null, diff: null, signed: null };
              byRow[d.r].cols = { ...(byRow[d.r].cols ?? {}), [sp.col]: { live: xs[i].live, signed: totalSigned, diff: gap, status: st, total: true, group: sp.group.length > 1 ? sp.group : undefined } };
              if (st === 'OK') sp.totalOk += 1; else sp.totalBad += 1;
            }
          }
        });
        signedSum = 0; liveSum = 0; have = 0;
        xs = colSpecs.map(() => ({ signed: 0, live: 0 }));
      }
    });
    blocks.push(out);
  });

  // ---- ties: lines of the sheet that Zoho holds as ONE balance (or the other way round), compared together - also across blocks ----
  const ties = [];
  for (const t of live.ties ?? []) {
    const picked = [];
    let broken = false;
    for (const ln of t.lines ?? []) {
      const ctx = ctxByStart.get(ln.block);
      if (!ctx) { problems.push(`The tie "${t.title}": the block "${ln.block}" has no live source`); broken = true; break; }
      const same = ctx.detail.filter((d) => !d.total && normName(d.label) === normName(ln.label));
      const d = same[(ln.nth ?? 1) - 1];
      if (!d) { problems.push(`The tie "${t.title}": the line "${ln.label}" was not found in "${ln.block}"`); broken = true; break; }
      picked.push({ d, ctx, sign: ln.sign ?? 1 });
    }
    if (broken || picked.length === 0) continue;
    if ((t.zoho ?? []).some((z) => sourceUnavailable(snapshot, z.source) || sourceWaiting(snapshot, z.source))) continue; // a tie on a split this snapshot does not have (an older copy): the block has said so, the lines stay as they are
    if (picked.some((x) => byRow[x.d.r]?.status !== 'NONE')) continue; // the lines found a Zoho balance of their own: nothing to tie
    let liveSum = 0;
    const missing = [];
    for (const z of t.zoho ?? []) {
      const e = poolOf(z.source).get(normName(z.name));
      if (!e) { missing.push(z.name); continue; }
      liveSum += (z.sign ?? 1) * e.value;
      if (z.group) used(z.group).add(e.key);
    }
    const signedSum = picked.reduce((acc, x) => acc + x.sign * x.d.signed, 0);
    const diff = liveSum - signedSum;
    const ok = missing.length === 0 && Math.abs(diff) <= TOTAL_TOLERANCE;
    picked.forEach((x, i) => {
      byRow[x.d.r] = { kind: 'detail', status: 'LUMP', live: null, diff: null, signed: x.d.signed, lumpOk: ok, zohoName: t.title, tie: ties.length, adjust: i === picked.length - 1 ? diff * x.sign : 0 };
      x.ctx.out.none -= 1;
      x.ctx.out.lumpLines += 1;
      const at = x.ctx.out.notFound.findIndex((n) => n.label === x.d.label && n.signed === x.d.signed);
      if (at >= 0) x.ctx.out.notFound.splice(at, 1);
    });
    ties.push({ title: t.title, lines: picked.length, signed: signedSum, live: liveSum, diff, ok, missing });
  }
  for (const run of settle) run();

  // ---- extras: Zoho lines that no block of the group used ----
  const extras = [];
  for (const [name, g] of Object.entries(live.groups ?? {})) {
    const claimed = usedByGroup.get(name) ?? new Set();
    for (const e of poolOf(g.source).values()) {
      if (claimed.has(e.key) || e.value < MIN_EXTRA) continue;
      extras.push({ group: g.title ?? name, name: e.name, value: e.value });
    }
  }
  for (const x of lineExtras) {
    if (x.value < MIN_EXTRA) continue;
    extras.push({ group: (x.group && live.groups?.[x.group]?.title) || x.group || 'Zoho', name: x.name, value: x.value });
  }
  extras.sort((a, b) => b.value - a.value);

  const sum = (f) => blocks.reduce((s, b) => s + f(b), 0);
  const columns = colSpecs.map((c) => ({ col: c.col, group: c.group, field: c.field, label: c.label, text: c.text || undefined, ok: c.ok, diff: c.diff, totalOk: c.totalOk, totalBad: c.totalBad }));
  return {
    byRow,
    blocks,
    columns,
    ties,
    extras,
    problems,
    waiting,
    summary: {
      lines: sum((b) => b.ok + b.name + b.diff + b.none + b.lumpLines),
      ok: sum((b) => b.ok), name: sum((b) => b.name), diff: sum((b) => b.diff), none: sum((b) => b.none), lump: sum((b) => b.lumpLines),
      lumpsOk: blocks.filter((b) => b.lump?.ok).length, lumpsBad: blocks.filter((b) => b.lump && !b.lump.ok).length,
      tiesOk: ties.filter((t) => t.ok).length, tiesBad: ties.filter((t) => !t.ok).length,
      keptAsSigned: sum((b) => b.signed),
      totalsOk: sum((b) => b.totalsOk), totalsBad: sum((b) => b.totalsBad),
      extras: extras.length, extrasValue: extras.reduce((s, e) => s + e.value, 0),
      columns,
    },
  };
}
