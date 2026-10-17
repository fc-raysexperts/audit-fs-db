// A small "sheet" engine: a list of rows, each a formula (see expr.mjs) over the live snapshot, last year's audited figures
// and the live notes. Used for the analytical ratios and the tax workings, which are short lists of formulas in the workbook too.
//
//   l: this year's statement line     t: this year's statement total (e.g. t:current_assets_total)
//   p: last year's audited line/total x: / y: a note row this year / last year
//   a: / n: / r: Zoho account / group (see expr.mjs)      i: year-end input     c: constant      row: another row

import { parse, evaluate } from './expr.mjs';

export const DEFAULT_TOLERANCE = 5;

/**
 * @param {object} snapshot
 * @param {{constants?:object, rows:object[]}} cfg
 * @param {{mapping:object, inputs:object|null, audited:object|null, notes:object, notesCfg?:object, totals:Record<string,number>}} ctx
 */
export function buildSheet(snapshot, cfg, ctx) {
  const lines = snapshot.statements.lines;
  const buckets = snapshot.buckets;
  const hasTie = Boolean(snapshot.meta.audited);
  const accounts = new Map();
  for (const b of Object.values(buckets)) for (const a of b.accounts) accounts.set(String(a.id), a.closing);
  const isNatural = (b) => ['asset', 'expense'].includes(ctx.mapping.buckets[b]?.nature);
  const bucket = (b) => { if (!buckets[b]) throw new Error(`Unknown group "${b}"`); return buckets[b].sum; };

  const defs = new Map(cfg.rows.filter((r) => r.kind !== 'heading').map((r) => [r.key, r]));
  const memo = new Map();
  const busy = new Set();
  const trees = new Map();
  const treeOf = (t) => { if (!trees.has(t)) trees.set(t, parse(t)); return trees.get(t); };

  const prior = (key) => {
    const v = ctx.audited?.bs?.[key]?.fy25 ?? ctx.audited?.pl?.[key]?.fy25;
    if (typeof v !== 'number') throw new Error(`Last year's audited figure "${key}" is missing`);
    return v;
  };
  const note = (key, which) => {
    const r = ctx.notes.byKey[key];
    if (!r || typeof r[which] !== 'number') throw new Error(`Note row "${key}" has no ${which === 'fy25' ? "last year's" : "this year's"} figure`);
    return r[which];
  };

  function lookup(kind, id) {
    switch (kind) {
      case 'l': { const l = lines[id]; if (!l) throw new Error(`Statement line "${id}" is not in the snapshot`); return l.value; }
      case 't': { const v = ctx.totals[id]; if (typeof v !== 'number') throw new Error(`Statement total "${id}" is not available`); return v; }
      case 'p': return prior(id);
      case 'x': return note(id, 'value');
      case 'y': return note(id, 'fy25');
      case 'a': return accounts.has(id) ? accounts.get(id) : 0;
      case 'n': return isNatural(id) ? bucket(id) : -bucket(id);
      case 'r': return bucket(id);
      case 'i': { const v = ctx.inputs?.inputs?.[id]?.value; if (v === undefined) throw new Error(`Year-end input "${id}" is missing`); return v; }
      case 'c': {
        const v = cfg.constants?.[id]?.value ?? ctx.notesCfg?.constants?.[id]?.value;
        if (v === undefined) throw new Error(`Constant "${id}" is missing`);
        return v;
      }
      case 'row': return value(id);
      default: throw new Error(`Unknown reference "${kind}:"`);
    }
  }
  function value(key) {
    if (memo.has(key)) return memo.get(key);
    const d = defs.get(key);
    if (!d) throw new Error(`Row "${key}" does not exist`);
    if (busy.has(key)) throw new Error(`Row "${key}" refers to itself`);
    busy.add(key);
    const v = evaluate(treeOf(d.expr), lookup);
    busy.delete(key);
    memo.set(key, v);
    return v;
  }

  const rows = cfg.rows.map((r) => {
    if (r.kind === 'heading') return { key: r.key, kind: 'heading', label: r.label };
    const v = value(r.key);
    const a = r.audited?.value;
    const tol = r.tolerance ?? DEFAULT_TOLERANCE;
    const diff = hasTie && typeof a === 'number' ? v - a : null;
    const fy25 = typeof r.fy25 === 'number' ? r.fy25 : null;
    return {
      key: r.key, kind: r.kind ?? 'line', label: r.label, detail: r.detail ?? null, unit: r.unit ?? 'rupees',
      numerator: r.numerator ?? null, denominator: r.denominator ?? null, reason: r.reason ?? null,
      value: v, fy25, audited: hasTie && typeof a === 'number' ? a : null, diff, ref: r.audited?.ref ?? null,
      variance: r.variance && fy25 ? (v - fy25) / Math.abs(fy25) : null,
      status: diff === null ? null : Math.abs(diff) <= tol ? 'OK' : 'CHECK',
    };
  });

  const checks = (cfg.checks ?? []).map((c) => {
    const v = evaluate(treeOf(c.expr), lookup);
    return { key: c.key, label: c.label, value: v, status: Math.abs(v) <= (c.tolerance ?? DEFAULT_TOLERANCE) ? 'OK' : 'CHECK' };
  });

  const tied = rows.filter((r) => r.status);
  const byKey = Object.fromEntries(rows.filter((r) => r.kind !== 'heading').map((r) => [r.key, r]));
  return {
    fy: snapshot.meta.fy, asOf: snapshot.meta.asOf, hasTie, rows, checks, byKey,
    summary: { lines: tied.length, ok: tied.filter((r) => r.status === 'OK').length, check: tied.filter((r) => r.status === 'CHECK').length, checksFailed: checks.filter((c) => c.status === 'CHECK').length },
  };
}
