// The rest of the audited booklet, rebuilt live from the same snapshot as the Balance Sheet and Profit & Loss:
// notes, cash flow, fixed assets, ratios / EPS and the tax workings. Pure functions - nothing here touches Zoho, Redis or files.
//
// Nothing needs a second round of Zoho calls: the snapshot already holds every account balance (by group) and the statement lines.

import { buildNotes } from './notes.mjs';
import { buildCashFlow } from './cashflow.mjs';
import { buildAssets } from './assets.mjs';
import { buildSheet } from './calc.mjs';

/** Statement totals by id (current_assets_total, equity_total, ...) taken from the laid-out Balance Sheet. */
export function totalsOf(statements) {
  const t = {};
  for (const r of [...statements.bs.liabilities, ...statements.bs.assets]) if (r.kind !== 'heading') t[r.id] = r.value;
  for (const r of statements.pl) if (r.kind !== 'heading') t[r.id] = r.value;
  return t;
}

/**
 * @param {object} snapshot
 * @param {object} config   loadConfig(fy)
 * @param {object} statements  buildView(snapshot, audited)
 * @returns {object|null}  null when the year has no notes file
 */
export function buildBooks(snapshot, config, statements) {
  const b = config.books;
  if (!b?.notes) return null;
  const ctxBase = { mapping: config.mapping, inputs: config.inputs, audited: config.audited };
  const notes = buildNotes(snapshot, b.notes, ctxBase);
  const ctx = { ...ctxBase, notes, notesCfg: b.notes, totals: totalsOf(statements) };

  const out = { notes };
  if (b.cashflow) out.cashflow = buildCashFlow(snapshot, b.cashflow, notes, config.audited);
  if (b.assets) out.assets = buildAssets(snapshot, b.assets);
  if (b.ratios) out.ratios = buildSheet(snapshot, b.ratios, ctx);
  if (b.tax) {
    out.tax = {
      note: b.tax.note,
      computation: buildSheet(snapshot, { constants: b.tax.constants, ...b.tax.computation }, ctx),
      deferred: buildSheet(snapshot, { constants: b.tax.constants, ...b.tax.deferred }, ctx),
    };
  }

  // one line for the Checks page and the Overview
  const parts = [
    ['Notes 3 to 27', out.notes.summary.lines, out.notes.summary.check, 0, '/workbook/notes'],
    out.cashflow && ['Cash flow statement', out.cashflow.summary.lines, out.cashflow.summary.check, out.cashflow.summary.checksFailed, '/workbook/cf'],
    out.assets && ['Fixed assets (Note 12)', out.assets.summary.lines, out.assets.summary.check, out.assets.summary.checksFailed, '/workbook/note-12-mfa'],
    out.ratios && ['Ratios, EPS and MSME', out.ratios.summary.lines, out.ratios.summary.check, out.ratios.summary.checksFailed, '/workbook/note-28-b'],
    out.tax && ['Tax computation and deferred tax', out.tax.computation.summary.lines + out.tax.deferred.summary.lines,
      out.tax.computation.summary.check + out.tax.deferred.summary.check, out.tax.computation.summary.checksFailed + out.tax.deferred.summary.checksFailed, '/workbook/computation'],
  ].filter(Boolean);
  out.summary = {
    hasTie: notes.hasTie,
    parts: parts.map(([name, lines, check, checks, href]) => ({ name, href, lines, check, checks, ok: check === 0 && checks === 0 })),
    lines: parts.reduce((s, p) => s + p[1], 0),
    check: parts.reduce((s, p) => s + p[2], 0),
    checksFailed: parts.reduce((s, p) => s + p[3], 0),
  };
  return out;
}
