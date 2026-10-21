// The 34 sheets of the audited workbook, as the dashboard shows them.
//
//   live   rebuilt from Zoho Books on every refresh (Balance Sheet, Profit and Loss, Cash Flow, notes, fixed assets, ratios, tax)
//   semi   partly live (EPS and the MSME figures; the closing balances of the party lists), the rest as signed
//   fixed  the auditors' own working or text, shown exactly as signed. Where the working carries a total that must agree with a
//          live figure (closing stock, receivables ageing, additions to fixed assets ...) the two are compared: a "tie".
//
// The fixed sheets are exported once from the signed workbook into config/workbook.fyYY/ (one JSON file per sheet and an index.json).
// A list sheet (customers, vendors, ledger accounts) can carry a `live` entry in the index: every line is then checked against the figure
// Zoho gives today (see overlay.mjs). That check is information - it never counts as a problem of the books - because the auditors
// reclassified a few lines after the ledger closed.
// Pure functions except readSheet(), which reads one of those files (and buildWorkbook, which reads the sheets that have a `live` entry).

import { parse, evaluate } from './expr.mjs';
import { readConfigFile } from './config.mjs';
import { buildOverlay } from './overlay.mjs';
import { buildRelatedChecks } from './related.mjs';
import { buildRegisterChecks } from './register.mjs';
import { buildSubsidiaryChecks } from './subsidiaries.mjs';

export const TIE_TOLERANCE = 10; // rupees: the auditors' sheets are rounded line by line

export const GROUP_ORDER = ['Booklet', 'Statements', 'Notes', 'Tax', 'Assets', 'Parties', 'Detail', 'Litigation'];

/** Value of a tie formula: l: statement line, x: note row, c: constant, f: fixed-asset figure (f:add.land, f:ppe.net). */
function tieLookup(snapshot, books, configs) {
  const lines = snapshot.statements.lines;
  const constants = { ...(configs?.notes?.constants ?? {}), ...(configs?.tax?.constants ?? {}) };
  return (kind, id) => {
    switch (kind) {
      case 'l': { const l = lines[id]; if (!l) throw new Error(`Statement line "${id}" is not in the snapshot`); return l.value; }
      case 'x': {
        const r = books?.notes?.byKey?.[id];
        if (!r || typeof r.value !== 'number') throw new Error(`Note row "${id}" is not available`);
        return r.value;
      }
      case 'c': {
        const v = constants[id]?.value;
        if (v === undefined) throw new Error(`Constant "${id}" is missing`);
        return v;
      }
      case 'f': {
        const a = books?.assets;
        if (!a) throw new Error('The fixed-asset schedule is not available');
        const [head, field] = id.split('.');
        if (head === 'add') {
          const c = a.classes.find((k) => k.key === field);
          if (!c) throw new Error(`Asset class "${field}" is not in the schedule`);
          return c.additions;
        }
        const g = a[head];
        if (!g || typeof g[field] !== 'number') throw new Error(`Fixed-asset figure "${id}" is not available`);
        return g[field];
      }
      default: throw new Error(`Unknown reference "${kind}:" in a tie`);
    }
  };
}

/**
 * The list of all sheets with the ties of the fixed ones worked out against the live figures.
 * @param {object} snapshot
 * @param {object|null} books   buildBooks() result
 * @param {{dir:string, index:{sheets:object[], fy:string, as_at:string}}|null} workbook  config.workbook
 * @param {{notes?:object, tax?:object}} configs  config.books (their constants are used by some ties)
 * @param {(workbook:object, id:string)=>object|null} read  how an exported sheet is read (handed in by the tests)
 */
export function buildWorkbook(snapshot, books, workbook, configs = {}, read = readSheet) {
  if (!workbook) return null;
  const look = tieLookup(snapshot, books, configs);
  const sheets = workbook.index.sheets.map((s) => {
    const ties = (s.ties ?? []).map((t) => {
      try {
        const live = evaluate(parse(t.expr), look);
        const diff = t.value - live;
        return { label: t.label, cell: t.cell, fixed: t.value, live, diff, status: Math.abs(diff) <= TIE_TOLERANCE ? 'OK' : 'CHECK' };
      } catch (e) {
        return { label: t.label, cell: t.cell, fixed: t.value, live: null, diff: null, status: 'CHECK', error: e.message };
      }
    });
    // the live check of a list sheet: only its counts are kept here (the lines are worked out again when the sheet is opened)
    // update-27: a sheet with `related` ('rpt' | 'n28') also has the figure-by-figure check of the related parties (lib/related.mjs, config/related.fyYY.json); its counts are added to the others
    let liveCheck = null;
    if (s.live || s.related || s.verify) {
      try {
        const data = read(workbook, s.id);
        if (!data) throw new Error(`The sheet file ${s.file} could not be read`);
        const o = s.live ? buildOverlay(snapshot, data, s.live) : null;
        liveCheck = o
          ? { ...o.summary, problems: [...o.problems] }
          : { lines: 0, ok: 0, name: 0, diff: 0, expl: 0, none: 0, lump: 0, extras: 0, columns: [], problems: [] };
        if (s.related) {
          if (!configs.related) throw new Error('config/related.fyYY.json is missing, so the related-party figures cannot be checked');
          const rel = buildRelatedChecks({ snapshot, spec: configs.related, rows: data.rows, side: s.related });
          liveCheck.related = rel.summary;
          for (const k of ['lines', 'ok', 'diff', 'expl', 'none']) liveCheck[k] = (liveCheck[k] ?? 0) + rel.summary[k];
          liveCheck.problems.push(...rel.problems);
        }
        if (s.verify) { // update-28: FA Add and Dep.Calc. against Zoho's fixed asset register, AOC-1 against the subsidiaries' own books
          const v = liveVerify(snapshot, configs, data);
          if (!v) throw new Error(`The configuration for the check of ${s.sheet} (config/${s.verify === 'aoc-1' ? 'subsidiaries' : 'register'}.fyYY.json) is missing, so it cannot be checked`);
          liveCheck.verify = v.summary;
          for (const k of ['lines', 'ok', 'diff', 'expl', 'none']) liveCheck[k] = (liveCheck[k] ?? 0) + v.summary[k];
          liveCheck.problems.push(...v.problems);
        }
      } catch (e) {
        liveCheck = { error: e.message, problems: [e.message] };
      }
    }
    return { ...s, ties, tieStatus: ties.length === 0 ? null : ties.every((t) => t.status === 'OK') ? 'OK' : 'CHECK', liveCheck };
  });
  const tied = sheets.flatMap((s) => s.ties);
  const count = (st) => sheets.filter((s) => s.status === st).length;
  const checked = sheets.filter((s) => s.liveCheck && !s.liveCheck.error);
  const sumOf = (f) => checked.reduce((t, s) => t + f(s.liveCheck), 0);
  return {
    fy: workbook.index.fy, asAt: workbook.index.as_at,
    sheets,
    groups: GROUP_ORDER.map((g) => ({ name: g, sheets: sheets.filter((s) => s.group === g) })).filter((g) => g.sheets.length),
    summary: {
      sheets: sheets.length, live: count('live'), semi: count('semi'), fixed: count('fixed'),
      ties: tied.length, tiesOk: tied.filter((t) => t.status === 'OK').length, tiesBad: tied.filter((t) => t.status === 'CHECK').length,
      maxDiff: Math.max(0, ...tied.filter((t) => t.diff !== null).map((t) => Math.abs(t.diff))),
      // the live check of the list sheets: lines compared, how they came out, and the sheets whose check could not be done at all
      liveSheets: sheets.filter((s) => s.liveCheck).length,
      liveLines: sumOf((c) => c.lines), liveOk: sumOf((c) => c.ok), liveName: sumOf((c) => c.name), liveDiff: sumOf((c) => c.diff + (c.expl ?? 0)), liveNone: sumOf((c) => c.none), liveLump: sumOf((c) => c.lump), // update-22: a line that differs by a documented amount (EXPL) is still one of 'the other' lines that each sheet lists
      liveExtras: sumOf((c) => c.extras),
      liveProblems: sheets.reduce((t, s) => t + (s.liveCheck?.problems.length ?? 0), 0),
    },
  };
}

/** The line-by-line live check of one exported sheet (the result of readSheet), or null when the sheet has no `live` entry. */
export function liveOverlay(snapshot, data) {
  const live = data?.entry?.live;
  return live ? buildOverlay(snapshot, data, live) : null;
}

/** update-27: the figure-by-figure check of the related parties for one exported sheet (the result of readSheet), or null when the sheet has no `related` entry or the year has no config/related. */
export function liveRelated(snapshot, spec, data) {
  const side = data?.entry?.related;
  return side && spec ? buildRelatedChecks({ snapshot, spec, rows: data.rows, side }) : null;
}

/**
 * update-28: the figure-by-figure check of a sheet that is verified against a layer of Zoho other than the related parties: FA Add and Dep.Calc. against the fixed asset register
 * (`verify: 'fa-add' | 'dep-calc'`, config/register.fyYY.json) and AOC-1 against the subsidiaries' own books (`verify: 'aoc-1'`, config/subsidiaries.fyYY.json). Null when the sheet has no
 * `verify` entry or the year has no such configuration. `configs` = { register, subsidiaries }.
 */
export function liveVerify(snapshot, configs, data) {
  const kind = data?.entry?.verify;
  if (!kind) return null;
  if (kind === 'fa-add' || kind === 'dep-calc') return configs?.register ? buildRegisterChecks({ snapshot, spec: configs.register, rows: data.rows, side: kind }) : null;
  if (kind === 'aoc-1') return configs?.subsidiaries ? buildSubsidiaryChecks({ snapshot, spec: configs.subsidiaries, rows: data.rows }) : null;
  throw new Error(`unknown verify entry "${kind}"`);
}

/** One exported sheet. `id` must be one of the ids in the index (nothing else is ever read from disk). */
export function readSheet(workbook, id) {
  const entry = workbook?.index.sheets.find((s) => s.id === id);
  if (!entry || !entry.file) return null;
  return { entry, ...readConfigFile(`${workbook.dir}/${entry.file}`) };
}
