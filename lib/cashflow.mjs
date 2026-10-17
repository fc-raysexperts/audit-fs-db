// Cash Flow Statement (indirect method, AS-3), rebuilt live with the same formulas as the CF sheet of the signed workbook.
//
// This year's figures come from the live statement lines and the live notes; last year's balances come from the audited
// comparatives. The statement must also close: cash at the end of the year (opening cash + A + B + C) has to equal the cash
// on the Balance Sheet and Note 17 - that is the proof that nothing was left out.

import { parse, evaluate } from './expr.mjs';

export const LINE_TOLERANCE = 10;   // rupees: each line mixes several rounded Balance Sheet figures
export const TOTAL_TOLERANCE = 25;  // subtotals add up to six or more such lines

const kindTol = (kind) => (kind === 'line' ? LINE_TOLERANCE : TOTAL_TOLERANCE);

/**
 * @param {object} snapshot  from buildSnapshot()
 * @param {object} cfg       config/cashflow.fyYY.json
 * @param {object} notes     result of buildNotes()
 * @param {object|null} audited  config/audited.fyYY.json (last year's audited lines)
 */
export function buildCashFlow(snapshot, cfg, notes, audited) {
  const lines = snapshot.statements.lines;
  const hasTie = Boolean(snapshot.meta.audited);
  const all = [...cfg.rows, ...cfg.proof];
  const defs = new Map(all.filter((r) => r.kind !== 'heading').map((r) => [r.key, r]));
  const memo = new Map();
  const busy = new Set();
  const trees = new Map();
  const treeOf = (t) => { if (!trees.has(t)) trees.set(t, parse(t)); return trees.get(t); };

  const prior = (key) => {
    const v = audited?.bs?.[key]?.fy25 ?? audited?.pl?.[key]?.fy25;
    if (typeof v !== 'number') throw new Error(`Last year's audited figure "${key}" is missing`);
    return v;
  };
  const note = (key, which) => {
    const r = notes.byKey[key];
    if (!r) throw new Error(`Note row "${key}" is not available for the cash flow`);
    const v = r[which];
    if (typeof v !== 'number') throw new Error(`Note row "${key}" has no ${which === 'fy25' ? "last year's" : 'this year\'s'} figure`);
    return v;
  };
  function lookup(kind, id) {
    switch (kind) {
      case 'l': { const l = lines[id]; if (!l) throw new Error(`Statement line "${id}" is not in the snapshot`); return l.value; }
      case 'p': return prior(id);
      case 'x': return note(id, 'value');
      case 'y': return note(id, 'fy25');
      case 'c': { const v = cfg.constants?.[id]?.value; if (v === undefined) throw new Error(`Constant "${id}" is missing`); return v; }
      case 'row': return value(id);
      default: throw new Error(`Unknown reference "${kind}:" in the cash flow`);
    }
  }
  function value(key) {
    if (memo.has(key)) return memo.get(key);
    const d = defs.get(key);
    if (!d) throw new Error(`Cash flow row "${key}" does not exist`);
    if (busy.has(key)) throw new Error(`Cash flow row "${key}" refers to itself`);
    busy.add(key);
    const v = evaluate(treeOf(d.expr), lookup);
    busy.delete(key);
    memo.set(key, v);
    return v;
  }

  const out = (r) => {
    if (r.kind === 'heading') return { key: r.key, kind: 'heading', label: r.label };
    const v = value(r.key);
    const a = r.audited?.value;
    const diff = hasTie && typeof a === 'number' ? v - a : null;
    return {
      key: r.key, kind: r.kind, label: r.label, detail: r.detail ?? null, value: v,
      fy25: typeof r.fy25 === 'number' ? r.fy25 : null,
      audited: hasTie && typeof a === 'number' ? a : null, diff, ref: r.audited?.ref ?? null,
      status: diff === null ? null : Math.abs(diff) <= kindTol(r.kind) ? 'OK' : 'CHECK',
    };
  };
  const rows = cfg.rows.map(out);
  const proof = cfg.proof.map(out);

  // does the statement close?
  const close = value('cf_close');
  const checks = [];
  const add = (key, label, diff) => checks.push({ key, label, value: diff, status: Math.abs(diff) <= TOTAL_TOLERANCE ? 'OK' : 'CHECK' });
  add('close_vs_bs', 'Cash at the end of the year = cash on the Balance Sheet', close - lines.cash.value);
  add('close_vs_note17', 'Cash at the end of the year = cash and cash equivalents as per Note 17', close - value('cf_p_tot'));
  const openAud = audited?.bs?.cash?.fy25;
  if (typeof openAud === 'number') add('open_vs_audited', "Cash at the start of the year = last year's audited closing cash", value('cf_open') - openAud);

  const tied = [...rows, ...proof].filter((r) => r.status);
  return {
    fy: snapshot.meta.fy, asOf: snapshot.meta.asOf, hasTie, rows, proof, checks, notes: cfg.notes ?? [],
    summary: { lines: tied.length, ok: tied.filter((r) => r.status === 'OK').length, check: tied.filter((r) => r.status === 'CHECK').length, checksFailed: checks.filter((c) => c.status === 'CHECK').length },
  };
}

/** The six lines shown on the Overview: what came from each kind of activity, and how the cash moved. */
export const SUMMARY_KEYS = [
  ['cf_net_op', 'Net cash from operating activities'],
  ['cf_net_inv', 'Net cash from investing activities'],
  ['cf_net_fin', 'Net cash from financing activities'],
  ['cf_net', 'Increase / (decrease) in cash'],
  ['cf_open', 'Cash at the start of the year'],
  ['cf_close', 'Cash at the end of the year'],
];

/**
 * A short version of the cash flow statement for the Overview, with last year's audited figure beside each line.
 * @param {object|null} cf  result of buildCashFlow()
 * @returns {{rows:{key:string,label:string,value:number,prev:number|null}[], closes:boolean, checks:number, hasPrev:boolean}|null}
 */
export function cashFlowSummary(cf) {
  if (!cf) return null;
  const byKey = new Map(cf.rows.map((r) => [r.key, r]));
  const rows = SUMMARY_KEYS.map(([key, label]) => {
    const r = byKey.get(key);
    return r ? { key, label, value: r.value, prev: r.fy25 } : null;
  }).filter(Boolean);
  if (rows.length === 0) return null;
  return { rows, closes: cf.checks.every((c) => c.status === 'OK'), checks: cf.checks.length, hasPrev: rows.some((r) => r.prev !== null) };
}
