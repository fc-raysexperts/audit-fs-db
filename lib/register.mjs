// update-28: the FIXED ASSET REGISTER of Zoho Books against the sheets FA Add and Dep.Calc. (config/register.fyYY.json).
//
// Two layers, like lib/related.mjs:
//   READ   Zoho's pages (fixed assets, and the ledger of the Land and the Development Rights accounts) -> the `register` section of the snapshot
//   CHECK  snapshot.register + the cells of a sheet -> a mark beside every figure it can confirm, and a short table of totals
//
// What was seen on the real books (21-Oct-2026): the register holds 502 assets; its asset number is the Asset Code of Dep.Calc.; the 483 assets that are not drafts add up to the cost
// (4,93,416,207.72) and the book value (34,17,73,249.81) of Dep.Calc. without Land, and the 66 assets bought in the year are the 66 lines of FA Add (same date, same cost to the rupee).
// Land and the Intangible Assets are not in the register: their lines are looked for in the ledger of their own accounts instead, and Land stays as signed on Dep.Calc.

import { num, r2 } from './util.mjs';
import { normalizeContactLedger } from './related.mjs';

export const REGISTER_SCHEMA = 1;
export const REGISTER_TOLERANCE = 1; // Rs per asset: the auditors' sheet is rounded to the rupee, Zoho keeps paise
export const REGISTER_TOTAL_TOLERANCE = 10; // Rs per total, as everywhere else

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const text = (v) => (typeof v === 'string' ? v.trim() : '');
const dateOf = (v) => (v && typeof v === 'object' && typeof v.d === 'string' ? v.d : null);
const inr = (x) => new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(x);
const dmy = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? ''); return m ? `${m[3]}-${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m[2]) - 1]}-${m[1]}` : String(iso ?? ''); };

/* ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ */
/* READ                                                                                                                                                                             */
/* ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ */

/** The pages of the fixed asset list -> [{ id, code, name, type, status, cost, value, date }] (every asset, whatever its status). */
export function normalizeRegister(pages) {
  const list = Array.isArray(pages) ? pages : [pages];
  if (!list.length) throw new Error('Fixed assets: no pages given');
  const out = [];
  let last = null;
  for (const p of list) {
    const root = p?.data ?? p;
    const rows = Array.isArray(root?.fixedassets) ? root.fixedassets : root?.fixed_assets; // Zoho: `fixedassets`
    if (!Array.isArray(rows)) throw new Error('The fixed asset response has an unexpected shape (no fixedassets list)');
    for (const a of rows) {
      const code = String(a.asset_number ?? '').trim();
      out.push({
        id: String(a.fixed_asset_id ?? code), code, name: String(a.asset_name ?? '').replace(/\s+/g, ' ').trim(), type: String(a.fixed_asset_type_name ?? '').trim(),
        status: String(a.status ?? '').trim(), cost: r2(num(a.asset_cost)), value: r2(num(a.current_asset_value)), date: String(a.asset_purchase_date ?? ''),
        // update-30: the useful life in months (`total_life`) and the day the asset began to be depreciated, both in the list itself
        life: a.total_life === undefined || a.total_life === null || a.total_life === '' || !Number.isFinite(Number(a.total_life)) ? null : Number(a.total_life), start: String(a.depreciation_start_date ?? ''),
      });
    }
    last = root.page_context ?? {};
  }
  if (last?.has_more_page === true) throw new Error('The fixed asset list is incomplete: the last page given still says has_more_page');
  if (!out.length) throw new Error('Zoho gave no fixed assets at all');
  const ids = new Set(out.map((a) => a.id));
  if (ids.size !== out.length) throw new Error('The fixed asset list has the same asset twice (a page was read twice)');
  return out;
}

/**
 * The `register` section of the snapshot: { schema, from, to, assets: { count, byStatus, list } | { error }, ledger: { lines } | { error } }.
 * `assets` and `ledger` are the raw pages Zoho sent, `{ error }` (the read failed) or null (not asked for). A layer that cannot be used becomes { error } and an alert says so.
 */
export function buildRegisterSection({ spec, assets, ledger, history = null, from, to, alerts = [] }) {
  const layer = (name, raw, make, effect = 'the item-by-item check of FA Add and Dep.Calc. is not made') => {
    if (raw === null || raw === undefined) return { error: 'not asked for' };
    if (raw.error) {
      alerts.push({ level: 'warn', code: 'REGISTER_UNAVAILABLE', message: `The ${name} could not be read from Zoho (${raw.error.message ?? raw.error}); ${effect}` });
      return { error: raw.error.message ?? String(raw.error) };
    }
    try { return make(raw); } catch (e) {
      alerts.push({ level: 'warn', code: 'REGISTER_UNAVAILABLE', message: `The ${name} could not be used (${e.message}); ${effect}` });
      return { error: e.message };
    }
  };
  return {
    schema: REGISTER_SCHEMA, from, to,
    // update-29: the entries of every asset ({ byId, fromCache, fetched, pending, failed, stopped } of fetchAssetHistories, `total` = the assets asked for) -> what the checks need
    history: layer('depreciation entries of the fixed assets', history, (h) => {
      const known = Object.keys(h.byId).length;
      const open = h.pending.length > 0;
      const detKnown = Object.keys(h.det ?? {}).length;
      const detOpen = (h.detPending?.length ?? 0) > 0; // update-30: the rate and the residual value of each asset (one more call)
      const more = open || detOpen;
      return { total: h.total ?? known + h.pending.length, known, complete: !more, stalled: more && h.fetched === 0, pending: h.pending.length, detKnown, detPending: h.detPending?.length ?? 0, fetched: h.fetched, fromCache: h.fromCache, failed: h.failed.length, stopped: h.stopped ?? null, byId: h.byId, det: h.det ?? {} };
    }, 'the depreciation columns of Dep.Calc. are not checked asset by asset'),
    assets: layer('fixed asset register', assets, (pages) => {
      const list = normalizeRegister(pages);
      const byStatus = {};
      for (const a of list) byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;
      return { count: list.length, byStatus, list };
    }),
    ledger: layer('ledger of the Land and Development Rights accounts', ledger, (pages) => {
      const wanted = new Map(Object.entries(spec.ledgerAccounts ?? {}).map(([k, a]) => [String(a.id), k]));
      const rows = normalizeContactLedger(pages);
      const stray = rows.find((r) => !wanted.has(r.accountId));
      if (stray) throw new Error(`a line of another account came back ("${stray.accountName}") - the account filter was ignored`);
      return { lines: rows.map((r) => ({ account: wanted.get(r.accountId), date: r.date, type: r.type, entry: r.entry, debit: r2(r.debit), credit: r2(r.credit), details: r.details })) };
    }),
  };
}

/** The account ids the register layer reads the ledger of. */
export const registerAccountIds = (spec) => Object.values(spec.ledgerAccounts ?? {}).map((a) => String(a.id));

/* ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ */
/* CHECK                                                                                                                                                                            */
/* ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ */

const NOT_IN_SNAPSHOT = "Zoho's fixed asset register is not in this snapshot (an older copy): refresh the data";

const MARK = (status, check, signed, zoho, extra = {}) => {
  const { dp = null, ...rest } = extra; // update-30: a mark of a rate or a number of years keeps `dp` decimals (the page shows them as they are)
  const rd = dp === null ? r2 : (x) => Math.round(x * 10 ** dp) / 10 ** dp;
  return { status, check, signed: rd(signed), own: signed, zoho: zoho === null ? null : rd(zoho), diff: zoho === null ? null : rd(zoho - signed), together: false, first: true, ...(dp === null ? {} : { dp }), ...rest };
};

/** The register of the snapshot, or the plain reason it cannot be used. */
function registerOf(snapshot) {
  const reg = snapshot.register;
  if (!reg) return { unavailable: NOT_IN_SNAPSHOT };
  if (!reg.assets || reg.assets.error || !Array.isArray(reg.assets.list)) return { unavailable: `Zoho's fixed asset register could not be read for this snapshot (${reg.assets?.error ?? 'missing'})` };
  return { reg };
}

const sameName = (a, b) => clean(a) === clean(b);
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/** Takes the best unclaimed candidate for one sheet line: same name first, then the closest amount. */
function claim(cands, claimed, name, amount, key = (c) => c.cost) {
  const free = cands.filter((c) => !claimed.has(c));
  if (!free.length) return null;
  free.sort((x, y) => (sameName(y.name, name) ? 1 : 0) - (sameName(x.name, name) ? 1 : 0) || Math.abs(key(x) - amount) - Math.abs(key(y) - amount));
  const hit = free[0];
  claimed.add(hit);
  return hit;
}

class Run {
  constructor(spec) {
    this.spec = spec;
    this.tol = spec.tolerance ?? REGISTER_TOLERANCE;
    this.totalTol = spec.totalTolerance ?? REGISTER_TOTAL_TOLERANCE;
    this.checks = [];
    this.marks = {};
    this.problems = [];
    this.stays = [];
    this.info = [];
    this.cellCount = { ok: 0, expl: 0, diff: 0, none: 0 };
    this.groupDefs = [];
  }

  group(id, title) { if (!this.groupDefs.some((g) => g.id === id)) this.groupDefs.push({ id, title }); }

  /** One figure beside a signed cell. `zoho` null = Zoho has nothing for it (a difference with a note), undefined = could not be checked (nothing is shown). */
  cell(r, c, check, signed, zoho, note = null, tip = null, opts = {}) {
    if (zoho === undefined) { this.cellCount.none += 1; return; }
    let status = zoho !== null && near(zoho, signed, opts.tol ?? this.tol) ? 'OK' : 'DIFF';
    if (status === 'DIFF' && zoho !== null && opts.explain) { status = 'EXPL'; note = opts.explain; } // update-30: a difference whose reason is known and written under the figure
    this.cellCount[status === 'OK' ? 'ok' : status === 'EXPL' ? 'expl' : 'diff'] += 1;
    this.marks[`${r}:${c}`] = MARK(status, check, signed, zoho, { note, tip, ...(opts.dp !== undefined ? { dp: opts.dp } : {}) });
  }

  /** A total, listed in the table: signed amount against what Zoho gives (the sum of `terms`). */
  total({ id, group, title, cells = [], signed, terms, note = null, why = null, mark = true, tol = this.totalTol }) {
    if (why) {
      this.checks.push({ id, group, title, note, signed: signed === null ? null : r2(signed), zoho: null, diff: null, status: 'NONE', why, cells, terms: [] });
      return;
    }
    const zoho = terms.reduce((t, x) => t + (x.sign ?? 1) * x.value, 0);
    const diff = zoho - signed;
    const status = Math.abs(diff) <= tol ? 'OK' : 'DIFF';
    this.checks.push({ id, group, title, note, signed: r2(signed), zoho: r2(zoho), diff: r2(diff), status, text: null, cells, terms: terms.map((x) => ({ label: x.label, value: r2(x.value), sign: x.sign ?? 1, absent: x.absent || undefined })) });
    if (mark) for (const { r, c } of cells) this.marks[`${r}:${c}`] = MARK(status, id, signed, zoho, { together: cells.length > 1 });
  }

  finish(panel) {
    const count = (s) => this.checks.filter((c) => c.status === s).length + (s === 'OK' ? this.cellCount.ok : s === 'EXPL' ? this.cellCount.expl : s === 'DIFF' ? this.cellCount.diff : s === 'NONE' ? this.cellCount.none : 0);
    const summary = { lines: 0, ok: count('OK'), expl: count('EXPL'), diff: count('DIFF'), none: count('NONE') };
    summary.lines = summary.ok + summary.expl + summary.diff + summary.none;
    const groups = this.groupDefs.map((g) => ({ ...g, checks: this.checks.filter((c) => c.group === g.id) })).filter((g) => g.checks.length);
    return { checks: this.checks, marks: this.marks, groups, stays: this.stays, info: this.info, problems: this.problems, summary, items: { ...this.cellCount }, panel };
  }
}

/* ---------- FA Add ---------- */

/** The structure of the sheet FA Add: its lines (date, group, amount) and the blocks they are added up in. */
export function readFaAdd(rows) {
  const blocks = [];
  const totals = [];
  let cur = { items: [], sub: null };
  rows.forEach((row, r) => {
    const date = dateOf(row[1]);
    const group = text(row[3]);
    if (date && group && isNum(row[4])) { cur.items.push({ r, date, name: text(row[2]), group, amount: row[4] }); return; }
    if (isNum(row[4]) && row[0] == null && row[1] == null && row[2] == null && row[3] == null) { // the subtotal under a group
      blocks.push({ ...cur, sub: r, subValue: row[4] });
      cur = { items: [], sub: null };
      return;
    }
    if (clean(row[0]) === 'total' && isNum(row[4])) { // a total: it closes the blocks above it (a block without its own subtotal line is added up by this total)
      if (cur.items.length) blocks.push({ ...cur, sub: r, subValue: row[4], isTotal: true });
      totals.push({ r, value: row[4], blocks: blocks.splice(0) });
      cur = { items: [], sub: null };
    }
  });
  return totals;
}

function faAddChecks({ snapshot, spec, rows }) {
  const run = new Run(spec);
  run.group('add', 'Additions during the year (FA Addition)');
  run.group('intangible', 'Intangible assets addition');
  run.group('extra', 'In Zoho, but not on this sheet');
  const totals = readFaAdd(rows);
  if (!totals.length) { run.problems.push('FA Add: no total line was found on the sheet'); return run.finish(PANELS['fa-add']); }

  const { reg, unavailable } = registerOf(snapshot);
  const ledger = snapshot.register?.ledger;
  const ledgerOk = Array.isArray(ledger?.lines);
  const from = reg?.from ?? snapshot.meta?.from;
  const to = reg?.to ?? snapshot.meta?.to;
  const inYear = (a) => a.date >= from && a.date <= to;
  const assets = reg ? reg.assets.list.filter((a) => a.status !== 'draft' && a.status !== 'cancelled' && inYear(a)) : [];
  const claimed = new Set();
  const claimedLines = new Set();
  const accounts = spec.ledgerAccounts ?? {};
  const blockZoho = []; // [{ block, label, value | null }]

  for (const total of totals) {
    for (const block of total.blocks) {
      const group = block.items[0]?.group ?? '';
      const lg = spec.ledgerGroups?.[group];
      const type = spec.types?.[group];
      const gid = block.isTotal ? 'intangible' : 'add';
      if (!lg && !type) { run.problems.push(`FA Add: the group "${group}" is not in config/register`); blockZoho.push({ block, value: null }); continue; }

      if (lg) { // Land, Intangible Assets: the lines of the ledger of their own account
        if (!ledgerOk) { blockZoho.push({ block, value: null, why: !snapshot.register ? NOT_IN_SNAPSHOT : `Zoho's ledger of ${accounts[lg.account]?.name ?? lg.account} could not be read for this snapshot (${ledger?.error ?? 'missing'})` }); continue; }
        const lines = ledger.lines.filter((l) => l.account === lg.account && l.debit - l.credit > 0 && l.date >= from && l.date <= to);
        let sum = 0;
        for (const it of block.items) {
          const cands = lines.filter((l) => !claimedLines.has(l) && near(l.debit - l.credit, it.amount, run.tol) && (lg.matchDate === false || l.date === it.date));
          const hit = cands[0];
          if (hit) {
            claimedLines.add(hit);
            sum += hit.debit - hit.credit;
            const other = hit.date !== it.date;
            run.cell(it.r, 4, 'fa-add-item', it.amount, hit.debit - hit.credit, null, `Zoho's ledger of ${accounts[lg.account]?.name}: ${hit.entry || hit.type} of ${dmy(hit.date)}${other ? ` (found by the amount: the entry carries another date than the ${dmy(it.date)} of the sheet)` : ''}`);
          } else {
            run.cell(it.r, 4, 'fa-add-item', it.amount, null, `Zoho's ledger of ${accounts[lg.account]?.name} has no entry of this amount in the year`);
          }
        }
        blockZoho.push({ block, value: sum, label: `${accounts[lg.account]?.name} ledger, entries of the same amounts`, ledger: true, gid });
        continue;
      }

      // a group of the register: match the lines one by one
      if (unavailable) { blockZoho.push({ block, value: null, why: unavailable }); continue; }
      const cands = assets.filter((a) => a.type === type);
      const strict = new Map();
      for (const it of block.items) { // first the lines that agree in date and cost
        const own = cands.filter((a) => !claimed.has(a) && a.date === it.date && near(a.cost, it.amount, run.tol));
        const hit = claim(own, claimed, it.name, it.amount);
        if (hit) strict.set(it, hit);
      }
      for (const it of block.items) {
        const hit = strict.get(it);
        if (hit) { run.cell(it.r, 4, 'fa-add-item', it.amount, hit.cost, null, `Zoho: ${hit.code} ${hit.name}, bought ${dmy(hit.date)}`); continue; }
        const same = cands.filter((a) => !claimed.has(a) && a.date === it.date); // the date agrees, the cost does not: show Zoho's cost
        const other = claim(same, claimed, it.name, it.amount);
        if (other) run.cell(it.r, 4, 'fa-add-item', it.amount, other.cost, null, `Zoho: ${other.code} ${other.name}, bought ${dmy(other.date)}`);
        else run.cell(it.r, 4, 'fa-add-item', it.amount, null, `Zoho's register has no ${type} bought on ${dmy(it.date)}`);
      }
      blockZoho.push({ block, value: cands.reduce((t, a) => t + a.cost, 0), label: `${type} bought in the year (${cands.length} ${cands.length === 1 ? 'asset' : 'assets'} in Zoho)`, gid });
    }
  }

  // the totals of the blocks and of the sheet, listed
  let n = 0;
  for (const total of totals) {
    const mine = blockZoho.filter((b) => total.blocks.includes(b.block));
    for (const b of mine) {
      const group = b.block.items[0]?.group ?? '';
      const cells = [{ r: b.block.sub, c: 4 }];
      if (b.value === null) {
        run.total({ id: `add-${n++}`, group: b.block.isTotal ? 'intangible' : 'add', title: `${group}: additions`, cells, signed: b.block.subValue, why: b.why ?? 'Not checked', mark: false });
        continue;
      }
      run.total({ id: `add-${n++}`, group: b.block.isTotal ? 'intangible' : 'add', title: `${group}: additions`, cells, signed: b.block.subValue, terms: [{ label: b.label, value: b.value }] });
    }
    if (mine.length && mine.every((b) => b.value !== null)) {
      const gid = mine[0].block.isTotal ? 'intangible' : 'add';
      if (!mine[0].block.isTotal) run.total({ id: `add-total-${total.r}`, group: gid, title: 'Total additions', cells: [{ r: total.r, c: 4 }], signed: total.value, terms: mine.map((b) => ({ label: `${b.block.items[0].group}`, value: b.value })) });
    } else if (mine.length && !mine[0].block.isTotal) {
      run.total({ id: `add-total-${total.r}`, group: 'add', title: 'Total additions', cells: [{ r: total.r, c: 4 }], signed: total.value, why: mine.find((b) => b.value === null)?.why ?? 'Not checked', mark: false });
    }
  }

  // what Zoho has in the year and the sheet does not
  if (reg) {
    const left = assets.filter((a) => !claimed.has(a));
    for (const a of left) run.total({ id: `extra-${a.code}`, group: 'extra', title: `${a.code} ${a.name} (${a.type}, bought ${dmy(a.date)})`, signed: 0, terms: [{ label: 'its cost in Zoho', value: a.cost }], mark: false });
    const drafts = reg.assets.list.filter((a) => a.status === 'draft');
    const now = drafts.filter((a) => inYear(a));
    for (const a of now) run.total({ id: `draft-${a.code}`, group: 'extra', title: `${a.code} ${a.name} (draft, bought ${dmy(a.date)})`, signed: 0, terms: [{ label: 'its cost in Zoho', value: a.cost }], mark: false });
    const later = drafts.filter((a) => a.date > to);
    if (later.length) run.info.push(`${later.length} draft ${later.length === 1 ? 'asset' : 'assets'} in Zoho (₹${inr(later.reduce((t, a) => t + a.cost, 0))}) were bought after ${dmy(to)}: they belong to the next year and are not part of this sheet.`);
  }
  run.stays.push('Assets deleted during the year (the FA Deletion block, nil): the register shows an asset sold or written off by its status, not by the year; this block stays as signed.');
  return run.finish(PANELS['fa-add']);
}

/** update-30: the days of the year an asset is depreciated, the last day counted: from the day depreciation began (or the first day of the year if that was earlier) to the end of the year. undefined = no start day. */
export function daysInYear(start, from, to) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start ?? '')) return undefined;
  const first = start > from ? start : from;
  if (first > to) return 0;
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86400000) + 1;
}

/** The day before an ISO date. */
const dayBefore = (iso) => new Date(Date.parse(`${iso}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);

/**
 * update-29: what the entries of one asset say ([type, date, depreciated, accumulated] sorted by date, see zohoData.normalizeAssetHistory):
 * open = the depreciation written off by the end of the day before the year began, dep = the depreciation entries dated inside the year, close = everything written off by the end of the year.
 * An asset bought during the year has nothing written off before it was bought.
 */
export function assetFigures(ent, from, to) {
  const before = dayBefore(from);
  const accAt = (day) => { let acc = 0; for (const e of ent) if (e[1] <= day) acc = e[3]; return r2(acc); };
  let dep = 0;
  for (const e of ent) if (e[0] === 'depreciation' && e[1] >= from && e[1] <= to) dep += e[2];
  return { open: accAt(before), dep: r2(dep), close: accAt(to) };
}

/* ---------- Dep.Calc. ---------- */

/** The columns of the first table of Dep.Calc. (by their headings) and its asset lines: [{ r, code, name, group, date, cost, wdv }]. */
export function readDepCalc(rows) {
  const h = rows.findIndex((row) => clean(row[1]) === 'name of asset' && clean(row[5]) === 'asset code');
  if (h < 0) return null;
  const col = (start) => rows[h].findIndex((x) => clean(x).startsWith(start));
  const c = { name: col('name of asset'), group: col('group of asset'), date: col('date of purchase'), cost: col('purchase cost'), code: col('asset code'), wdv: col('wdv books') };
  if (Object.values(c).some((i) => i < 0)) return { header: h, cols: c, lines: [], total: null, missing: true };
  // update-29: the three depreciation columns (optional: a year whose sheet has other headings simply does not get this check)
  c.acc0 = col('acc. dep. as on'); // the depreciation written off at the start of the year
  c.dep = col('depreciation as per books'); // the depreciation of the year in the books
  c.acc1 = col('accumulated depreciation'); // everything written off at the end of the year
  // update-30: the asset's settings (optional, like the three above): useful life in years, balance life, rate, days of the year, residual value and the net block at the start of the year
  c.life = col('useful life');
  c.balLife = col('balance life');
  c.rate = col('rate');
  c.days = col('no. of days');
  c.res = col('residual value');
  c.nb0 = col('net block as on');
  const lines = [];
  let total = null;
  for (let r = h + 1; r < rows.length; r += 1) {
    const row = rows[r];
    if (clean(row[c.name]) === 'total') { total = { r }; break; }
    if (isNum(row[0]) && isNum(row[c.cost])) {
      const n = (i) => (i >= 0 && isNum(row[i]) ? row[i] : 0);
      lines.push({ r, code: text(row[c.code]), name: text(row[c.name]), group: text(row[c.group]), date: dateOf(row[c.date]), cost: row[c.cost], wdv: isNum(row[c.wdv]) ? row[c.wdv] : 0, acc0: n(c.acc0), dep: n(c.dep), acc1: n(c.acc1), life: n(c.life), balLife: n(c.balLife), rate: n(c.rate), days: n(c.days), res: n(c.res), nb0: n(c.nb0) });
    }
  }
  return { header: h, cols: c, lines, total };
}

function depCalcChecks({ snapshot, spec, rows }) {
  const run = new Run(spec);
  run.group('groups', 'Cost and book value by group');
  run.group('extra', 'In Zoho, but not on this sheet');
  const sheet = readDepCalc(rows);
  if (!sheet || sheet.missing) { run.problems.push('Dep.Calc.: the columns of the asset table were not found by their headings'); return run.finish(PANELS['dep-calc']); }
  const { cols } = sheet;
  const { reg, unavailable } = registerOf(snapshot);
  const from = reg?.from ?? snapshot.meta?.from;
  const to = reg?.to ?? snapshot.meta?.to;
  const skip = new Set((spec.notInRegister ?? []).map(clean));
  const hist = reg?.history && !reg.history.error && reg.history.byId ? reg.history : null; // update-29: the entries of each asset (null = not in this snapshot / not readable)
  const histCols = cols.acc0 >= 0 && cols.dep >= 0 && cols.acc1 >= 0;

  const landLines = sheet.lines.filter((l) => skip.has(clean(l.group)));
  const lines = sheet.lines.filter((l) => !skip.has(clean(l.group)));
  if (landLines.length) run.stays.push(`${landLines.length} ${landLines.length === 1 ? 'line' : 'lines'} of ${[...new Set(landLines.map((l) => l.group))].join(' / ')} (₹${inr(landLines.reduce((t, l) => t + l.cost, 0))}): Zoho's register has no record of land, so they stay as signed. They are inside the sheet totals, which are compared with the fixed assets schedule built from the Trial Balance (the table below).`);
  if (hist && histCols) run.stays.push('The intangible assets table below the totals, the Balance Life, the depreciation as the sheet itself works it out (C.Y.Depreciation, Net Block) and the validation columns stay as signed: they are the auditors\' workings, not figures that Zoho holds. The Useful Life, No. of Days, Rate and Residual Value of each asset are checked against Zoho (below).');
  else run.stays.push(`The intangible assets table below the totals, the Balance Life and the validation columns stay as signed. The opening depreciation, the depreciation of the year and the closing depreciation of each asset ${reg?.history?.error ? `could not be checked (${reg.history.error})` : reg && !reg.history ? 'are not checked: the entries of the assets are not in this snapshot (an older copy: refresh the data)' : histCols ? 'are not checked yet' : 'are not checked: their columns were not found by their headings'}.`);

  if (unavailable) {
    run.total({ id: 'dep-all', group: 'groups', title: 'Cost and book value, asset by asset', signed: null, why: unavailable, mark: false });
    return run.finish(PANELS['dep-calc']);
  }

  const all = reg.assets.list.filter((a) => a.status !== 'draft' && a.status !== 'cancelled' && a.date <= to);
  const byCode = new Map();
  for (const a of all) byCode.set(a.code, [...(byCode.get(a.code) ?? []), a]);
  const sheetCount = new Map();
  for (const l of lines) sheetCount.set(l.code, (sheetCount.get(l.code) ?? 0) + 1);
  const claimed = new Set();
  const match = new Map();

  // 1. a code that is used by one line of the sheet and by one asset of Zoho
  for (const l of lines) {
    const own = byCode.get(l.code) ?? [];
    if (sheetCount.get(l.code) === 1 && own.length === 1 && !claimed.has(own[0])) { claimed.add(own[0]); match.set(l, { asset: own[0], how: 'code' }); }
  }
  // 2. the others (a code used by several lines, or not known to Zoho): by the date, the cost and the book value
  const typeOf = (l) => spec.types?.[l.group] ?? l.group;
  const repeated = new Map();
  for (const l of lines) {
    if (match.has(l)) continue;
    const cands = all.filter((a) => !claimed.has(a) && a.type === typeOf(l) && (!l.date || a.date === l.date) && near(a.cost, l.cost, run.tol) && near(a.value, l.wdv, run.tol));
    cands.sort((x, y) => (y.code === l.code ? 1 : 0) - (x.code === l.code ? 1 : 0) || (x.code < y.code ? -1 : 1));
    const hit = cands[0];
    if (hit) { claimed.add(hit); match.set(l, { asset: hit, how: hit.code === l.code ? 'code' : 'figures' }); }
    if ((sheetCount.get(l.code) ?? 0) > 1) repeated.set(l.code, [...(repeated.get(l.code) ?? []), l]);
  }
  if (repeated.size) {
    const parts = [...repeated].map(([code, ls]) => `${code} (${ls.length} lines: ${[...new Set(ls.map((l) => l.name))].join(' / ')})`);
    run.info.push(`${repeated.size} asset ${repeated.size === 1 ? 'code is' : 'codes are'} used by more than one line of the sheet: ${parts.join('; ')}. Zoho has these as separate assets under their own numbers, so each of those lines is matched to its asset by date, cost and book value instead of by the code.`);
  }

  // 3. every line, cost and book value
  for (const l of lines) {
    const m = match.get(l);
    if (!m) {
      const known = byCode.get(l.code)?.[0];
      const note = known ? `Zoho's ${l.code} is another asset (${known.name}, cost ${inr(known.cost)})` : `Zoho's register has no asset ${l.code ? `with the code ${l.code}` : 'for this line'}, nor one with this date, cost and book value`;
      run.cell(l.r, cols.cost, 'dep-cost', l.cost, known ? known.cost : null, note);
      run.cell(l.r, cols.wdv, 'dep-wdv', l.wdv, known ? known.value : null, null);
      continue;
    }
    const tip = `Zoho: ${m.asset.code} ${m.asset.name}, bought ${dmy(m.asset.date)}${m.how === 'figures' ? ' (matched by date, cost and book value: the code of the sheet is used twice)' : ''}`;
    run.cell(l.r, cols.cost, 'dep-cost', l.cost, m.asset.cost, null, tip);
    run.cell(l.r, cols.wdv, 'dep-wdv', l.wdv, m.asset.value, null, tip);
  }

  // 3b. update-29: the depreciation, asset by asset, from the entries Zoho keeps for each asset (opening, the year, closing)
  const figures = new Map(); // asset -> { open, dep, close } of the assets whose entries are known
  let unread = 0;
  if (hist && histCols) {
    for (const l of lines) {
      const m = match.get(l);
      if (!m) continue;
      const ent = hist.byId[m.asset.id];
      if (!ent) { unread += 1; continue; }
      const z = assetFigures(ent, from, to);
      figures.set(l, z);
      const tip = `Zoho: the entries of ${m.asset.code} ${m.asset.name}${ent.length ? ` (${ent.map((e) => `${e[0]} ${dmy(e[1])}`).join(', ')})` : ' (no entries)'}`;
      run.cell(l.r, cols.acc0, 'dep-acc-open', l.acc0, z.open, null, tip);
      run.cell(l.r, cols.dep, 'dep-year', l.dep, z.dep, null, tip);
      run.cell(l.r, cols.acc1, 'dep-acc-close', l.acc1, z.close, null, tip);
    }
  }

  // 3c. update-30: the settings of each asset. Useful Life (years) and No. of Days come from the asset list (total_life in months; the day depreciation began, inside the year); Rate and Residual
  // Value from the detail of each asset (depreciation_percentage, salvage_value), read with its entries
  const setCols = { life: cols.life >= 0, days: cols.days >= 0, rate: cols.rate >= 0, res: cols.res >= 0 };
  const det = hist?.det ?? null;
  const rateRows = { same: 0, rule: 0, other: 0, zero: 0 };
  let detUnread = 0;
  for (const l of lines) {
    const m = match.get(l);
    if (!m) continue;
    const a = m.asset;
    const tip = `Zoho: ${a.code} ${a.name}`;
    if (setCols.life) run.cell(l.r, cols.life, 'dep-life', l.life, a.life === null || a.life === undefined ? undefined : r2(a.life / 12), null, `${tip} (useful life ${a.life} months)`, { tol: 0.005, dp: 2 });
    if (setCols.days) run.cell(l.r, cols.days, 'dep-days', l.days, daysInYear(a.start, from, to), null, `${tip} (depreciation from ${dmy(a.start)}; the day the year ends is counted)`, { tol: 0, dp: 0 });
    const d = det?.[a.id];
    if (!d) { if (det && (setCols.rate || setCols.res)) detUnread += 1; continue; }
    if (setCols.res && d.res !== null) run.cell(l.r, cols.res, 'dep-res', l.res, d.res, null, `${tip} (salvage value)`);
    if (setCols.rate && d.rate !== null) {
      if (!(l.rate > 0)) { rateRows.zero += 1; continue; } // fully depreciated: the sheet shows no rate (there is nothing left to depreciate)
      const zr = Math.round(d.rate * 100) / 10000; // percent -> a fraction of four decimals, as on the sheet
      const own = l.res > 0 && l.nb0 > 0 && l.balLife > 0 ? 1 - (l.res / l.nb0) ** (1 / l.balLife) : null; // the rule the auditors' sheet follows: the rate worked out again over the balance life
      const reworked = own !== null && Math.abs(own - l.rate) <= 0.00006;
      const same = Math.abs(zr - l.rate) <= 0.00011;
      // the rate Zoho would have set when the asset was entered: the residual value over the whole life (in years)
      const atEntry = d.res !== null && a.cost > 0 && a.life > 0 && d.res > 0 ? 1 - (d.res / a.cost) ** (12 / a.life) : null;
      const kept = atEntry !== null && Math.abs(atEntry - zr) <= 0.00011; // Zoho's percentage is that rate, so it is a kept rate and not some other setting
      const explained = reworked && kept;
      if (same) rateRows.same += 1; else if (explained) rateRows.rule += 1; else rateRows.other += 1;
      const explain = explained ? `The sheet works the rate out again each year: 1 − (residual ${inr(l.res)} ÷ net block ${inr(l.nb0)}) ^ (1 ÷ balance life ${l.balLife}) = ${own.toFixed(4)}. Zoho keeps the ${d.rate}% set when the asset was entered (residual value over the whole life of ${a.life / 12} years).` : null;
      run.cell(l.r, cols.rate, 'dep-rate', l.rate, zr, null, `${tip} (rate ${d.rate}%)`, { tol: 0.00011, dp: 4, ...(explain ? { explain } : {}) });
    }
  }
  if (det && (setCols.rate || setCols.res)) {
    run.info.push(`Rate: ${rateRows.same} ${rateRows.same === 1 ? 'asset has' : 'assets have'} the same rate on the sheet as in Zoho; ${rateRows.rule} ${rateRows.rule === 1 ? 'shows' : 'show'} another rate because the sheet works the rate out again every year over the balance life of the asset (1 − (Residual Value ÷ Net Block at the start of the year) ^ (1 ÷ Balance Life)), which is the sheet's own result and is reproduced for each of them, while Zoho keeps the percentage set when the asset was entered (this is the source of the sheet's Difference column)${rateRows.other ? `; ${rateRows.other} ${rateRows.other === 1 ? 'differs' : 'differ'} without that rule explaining it` : ''}. ${rateRows.zero} fully depreciated ${rateRows.zero === 1 ? 'asset has' : 'assets have'} no rate on the sheet and are not compared.${detUnread ? ` The settings of ${detUnread} assets are not read from Zoho yet.` : ''}`);
  } else if (setCols.rate || setCols.res) {
    run.info.push(`Rate and Residual Value of each asset are read from the detail of the asset in Zoho${reg?.history?.error ? ` and could not be (${reg.history.error})` : ': they are not in this snapshot (an older copy: refresh the data)'}; they stay as signed.`);
  }

  // 4. the totals, by group and for the sheet
  const groups = [...new Set(lines.map((l) => l.group))];
  const types = [...new Set(groups.map((g) => spec.types?.[g] ?? g))];
  const sums = (type) => all.filter((a) => a.type === type).reduce((t, a) => ({ cost: t.cost + a.cost, value: t.value + a.value, n: t.n + 1 }), { cost: 0, value: 0, n: 0 });
  for (const g of groups) {
    const type = spec.types?.[g] ?? g;
    const mine = lines.filter((l) => l.group === g);
    const z = sums(type);
    const word = `${type} in Zoho's register (${z.n} ${z.n === 1 ? 'asset' : 'assets'})`;
    run.total({ id: `grp-cost-${g}`, group: 'groups', title: `${g}: cost`, cells: mine.map((l) => ({ r: l.r, c: cols.cost })), signed: mine.reduce((t, l) => t + l.cost, 0), terms: [{ label: word, value: z.cost }], mark: false });
    run.total({ id: `grp-wdv-${g}`, group: 'groups', title: `${g}: book value (WDV Books)`, cells: mine.map((l) => ({ r: l.r, c: cols.wdv })), signed: mine.reduce((t, l) => t + l.wdv, 0), terms: [{ label: word, value: z.value }], mark: false });
  }
  for (const t of [...new Set(all.map((a) => a.type))].filter((t) => !types.includes(t))) { // an asset type that the sheet has no group for
    const z = sums(t);
    run.total({ id: `type-${t}`, group: 'extra', title: `${t}: ${z.n} ${z.n === 1 ? 'asset' : 'assets'} in Zoho, no such group on the sheet`, signed: 0, terms: [{ label: 'their cost in Zoho', value: z.cost }], mark: false });
  }
  if (sheet.total) {
    const landCost = landLines.reduce((t, l) => t + l.cost, 0);
    const landWdv = landLines.reduce((t, l) => t + l.wdv, 0);
    const tot = rows[sheet.total.r];
    const zc = all.reduce((t, a) => t + a.cost, 0);
    const zv = all.reduce((t, a) => t + a.value, 0);
    if (isNum(tot[cols.cost])) run.total({ id: 'dep-total-cost', group: 'groups', title: 'Total: cost', cells: [{ r: sheet.total.r, c: cols.cost }], signed: tot[cols.cost], terms: [{ label: `all ${all.length} assets of Zoho's register`, value: zc }, ...(landLines.length ? [{ label: 'Land, as signed (not in the register)', value: landCost }] : [])] });
    if (isNum(tot[cols.wdv])) run.total({ id: 'dep-total-wdv', group: 'groups', title: 'Total: book value (WDV Books)', cells: [{ r: sheet.total.r, c: cols.wdv }], signed: tot[cols.wdv], terms: [{ label: `all ${all.length} assets of Zoho's register`, value: zv }, ...(landLines.length ? [{ label: 'Land, as signed (not in the register)', value: landWdv }] : [])] });
    if (hist && histCols) { // update-29: the three depreciation columns, for the sheet
      const known = all.filter((a) => hist.byId[a.id]);
      const sum = (key) => known.reduce((t, a) => t + assetFigures(hist.byId[a.id], from, to)[key], 0);
      const why = known.length < all.length ? `The entries of ${all.length - known.length} of the ${all.length} assets are not read from Zoho yet (${known.length} are): the totals are checked when all are` : null;
      for (const [key, col, id, title] of [['open', cols.acc0, 'dep-total-open', 'Total: depreciation written off at the start of the year'], ['dep', cols.dep, 'dep-total-year', 'Total: depreciation as per books (of the year)'], ['close', cols.acc1, 'dep-total-close', 'Total: depreciation written off at the end of the year']]) {
        if (!isNum(tot[col])) continue;
        // the depreciation of the year is rounded to the rupee for each asset on the sheet: its total may differ from Zoho's by up to half a rupee per asset
        const tol = key === 'dep' ? Math.max(run.totalTol, 0.5 * all.length) : run.totalTol;
        if (why) run.total({ id, group: 'groups', title, cells: [{ r: sheet.total.r, c: col }], signed: tot[col], why, mark: false });
        else run.total({ id, group: 'groups', title, cells: [{ r: sheet.total.r, c: col }], signed: tot[col], tol, terms: [{ label: `the entries of all ${known.length} assets in Zoho`, value: sum(key) }] });
      }
    }
  }

  // 5. what Zoho has and the sheet does not
  for (const a of all.filter((x) => !claimed.has(x))) run.total({ id: `extra-${a.code}`, group: 'extra', title: `${a.code} ${a.name} (${a.type}, bought ${dmy(a.date)})`, signed: 0, terms: [{ label: 'its cost in Zoho', value: a.cost }], mark: false });
  const drafts = reg.assets.list.filter((a) => a.status === 'draft');
  for (const a of drafts.filter((x) => x.date <= to)) run.total({ id: `draft-${a.code}`, group: 'extra', title: `${a.code} ${a.name} (draft, bought ${dmy(a.date)})`, signed: 0, terms: [{ label: 'its cost in Zoho', value: a.cost }], mark: false });
  const later = drafts.filter((a) => a.date > to);
  if (later.length) run.info.push(`${later.length} draft ${later.length === 1 ? 'asset' : 'assets'} in Zoho (₹${inr(later.reduce((t, a) => t + a.cost, 0))}) were bought after ${dmy(to)}: they belong to the next year and are not on this sheet.`);
  if (hist && histCols) {
    const odd = new Set();
    for (const ent of Object.values(hist.byId)) for (const e of ent) if (e[0] !== 'acquisition' && e[0] !== 'depreciation') odd.add(e[0]);
    run.info.push(`Depreciation: the entries of ${hist.known} of ${hist.total} assets are read from Zoho (${hist.fromCache} kept from earlier refreshes${hist.pending ? `, ${hist.pending} still to be read` : ''}${hist.failed ? `, ${hist.failed} could not be read` : ''}). Each asset has its acquisition entry (the depreciation already written off when it was entered) and the depreciation entry of the year.${odd.size ? ` Other kinds of entry were found (${[...odd].join(', ')}): they count in the closing depreciation but not in the depreciation of the year.` : ''}${unread ? ` ${unread} lines of the sheet wait for their asset's entries.` : ''}`);
  }
  run.info.push(`The register read has ${reg.assets.count} assets (${Object.entries(reg.assets.byStatus).map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}`).join(', ')}). The book value of an asset is its value after Zoho's last depreciation run, so it equals the 31 March 2026 figure only until the depreciation of the next year is run in Zoho.`);
  return run.finish(PANELS['dep-calc']);
}

const PANELS = {
  'fa-add': {
    title: 'Additions against the fixed asset register of Zoho',
    of: 'this sheet',
    foot: 'A line agrees when Zoho has an asset bought on the same day for the same cost, within ₹1 (the sheet is rounded to the rupee, Zoho keeps paise). Land and the Intangible Assets are not in the register: their lines are looked for in the ledger of their own account in Zoho, by the amount. A total agrees within ₹10. Where Zoho gives another amount that is information, not an error: the books are closed and audited, so the sheet is not changed.',
  },
  'dep-calc': {
    title: 'The asset register against Zoho',
    of: 'this sheet',
    foot: 'Each asset is found in Zoho by its asset code (the asset number of the register). Its cost and book value (WDV Books) are compared to the paisa, within ₹1; so are its depreciation at the start of the year, the depreciation of the year and the depreciation at the end of the year, which come from the entries Zoho keeps for that asset (the sheet rounds the depreciation of the year to the rupee). A group or sheet total agrees within ₹10 (the depreciation of the year: within half a rupee per asset). Where Zoho gives another amount that is information, not an error: the books are closed and audited, so the sheet is not changed.',
  },
};

/**
 * @param {{snapshot:object, spec:object, rows:any[][], side:'fa-add'|'dep-calc'}} p
 * @returns {{checks:object[], marks:Object<string,object>, groups:object[], stays:string[], info:string[], problems:string[], summary:{lines,ok,expl,diff,none}, items:object, panel:object}}
 *   mark: "row:col" -> { status, check, signed, own, zoho, diff, together, first, note?, tip? }
 */
export function buildRegisterChecks({ snapshot, spec, rows, side }) {
  if (side === 'fa-add') return faAddChecks({ snapshot, spec, rows });
  if (side === 'dep-calc') return depCalcChecks({ snapshot, spec, rows });
  throw new Error(`unknown register sheet "${side}"`);
}
