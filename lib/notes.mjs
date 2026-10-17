// Notes 3-27 of the audited statements, rebuilt live from the Zoho snapshot.
//
// config/notes.fyYY.json lists every note head as a formula (see expr.mjs) over Zoho accounts, groups of accounts ("buckets"),
// statement lines and a few year-end inputs. For each head this file computes
//   * the live figure,
//   * last year's figure (fixed, from the signed audited workbook),
//   * the audited figure of this year (fixed) and the difference - so every head is checked against the signed accounts,
//   * what the figure is made of (accounts), which is the workbook's "BS Grouping" / "P&L Grouping" detail, live.
// Each note is also checked against its statement line: if a new Zoho account is not part of any head, the gap shows as
// "not yet placed in a head" instead of silently disappearing.

import { parse, evaluate, additiveTerms } from './expr.mjs';

export const ROW_TOLERANCE = 5;    // rupees - the audited notes are typed in rounded to the rupee, line by line
export const TOTAL_TOLERANCE = 10; // sums of rounded lines may drift a little more
const SHOW_GAP_ABOVE = 5;          // a statement-line gap bigger than this is shown as its own row
const MAX_ACCOUNTS_SHOWN = 20;

const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);

function tieOf(live, audited, tol, hasTie) {
  if (!hasTie || audited === undefined || audited === null) return { audited: null, diff: null, status: null };
  const diff = live - audited;
  return { audited, diff, status: Math.abs(diff) <= tol ? 'OK' : 'CHECK' };
}

/**
 * @param {object} snapshot   from buildSnapshot()
 * @param {object} cfg        config/notes.fyYY.json
 * @param {{mapping:object, inputs:object|null}} ctx   config.mapping (bucket natures and labels) and config.inputs
 */
export function buildNotes(snapshot, cfg, { mapping, inputs }) {
  const lines = snapshot.statements.lines;
  const buckets = snapshot.buckets;
  const hasTie = Boolean(snapshot.meta.audited);

  const accounts = new Map();
  for (const [bucket, b] of Object.entries(buckets)) {
    for (const a of b.accounts) accounts.set(String(a.id), { ...a, bucket });
  }
  const nature = (b) => mapping.buckets[b]?.nature;
  const isNatural = (b) => ['asset', 'expense'].includes(nature(b));
  const bucketRaw = (b) => {
    if (!buckets[b]) throw new Error(`Unknown group "${b}" in a note formula`);
    return buckets[b].sum;
  };
  const bucketNat = (b) => (isNatural(b) ? bucketRaw(b) : -bucketRaw(b));

  const rowDefs = new Map();
  for (const n of cfg.notes) for (const g of n.groups) for (const r of g.rows) rowDefs.set(r.key, r);
  const rowMemo = new Map();
  const rowBusy = new Set();
  const trees = new Map();
  const treeOf = (text) => { if (!trees.has(text)) trees.set(text, parse(text)); return trees.get(text); };

  function lookup(kind, id) {
    switch (kind) {
      case 'a': return accounts.has(id) ? accounts.get(id).closing : 0; // accounts with a nil balance are not in the Trial Balance
      case 'n': return bucketNat(id);
      case 'r': return bucketRaw(id);
      case 'l': {
        const l = lines[id];
        if (!l) throw new Error(`Statement line "${id}" is not in the snapshot`);
        return l.value;
      }
      case 'i': {
        const v = inputs?.inputs?.[id]?.value;
        if (v === undefined) throw new Error(`Year-end input "${id}" is missing`);
        return v;
      }
      case 'c': {
        const v = cfg.constants?.[id]?.value;
        if (v === undefined) throw new Error(`Constant "${id}" is missing in the notes file`);
        return v;
      }
      case 'row': return rowValue(id);
      default: throw new Error(`Unknown reference type "${kind}:" in a note formula`);
    }
  }
  function rowValue(key) {
    if (rowMemo.has(key)) return rowMemo.get(key);
    const def = rowDefs.get(key);
    if (!def) throw new Error(`Note row "${key}" does not exist`);
    if (rowBusy.has(key)) throw new Error(`Note row "${key}" refers to itself`);
    rowBusy.add(key);
    const v = evaluate(treeOf(def.expr), lookup);
    rowBusy.delete(key);
    rowMemo.set(key, v);
    return v;
  }
  const calc = (text) => evaluate(treeOf(text), lookup);

  // ---- "made up of": the top-level terms of a formula, accounts of a group opened up
  function labelOf(kind, id) {
    switch (kind) {
      case 'a': return accounts.get(id)?.name ?? `Account ${id} (nil balance)`;
      case 'n': case 'r': return mapping.buckets[id]?.label ?? id;
      case 'l': return lines[id]?.label ?? id;
      case 'i': return inputs?.inputs?.[id]?.meaning ?? id;
      case 'c': return cfg.constants?.[id]?.meaning ?? id;
      case 'row': return rowDefs.get(id)?.label ?? id;
      default: return id;
    }
  }
  function madeOf(def) {
    const terms = additiveTerms(treeOf(def.expr));
    const out = [];
    for (const t of terms) {
      const node = t.tree;
      if ('num' in node && node.num === 0) continue;
      const value = t.sign * evaluate(node, lookup);
      if ('ref' in node) {
        const item = { label: labelOf(node.ref, node.id), kind: node.ref, value };
        if ((node.ref === 'n' || node.ref === 'r') && buckets[node.id]?.accounts.length > 1 && buckets[node.id].accounts.length <= MAX_ACCOUNTS_SHOWN) {
          const flip = t.sign * (node.ref === 'n' && !isNatural(node.id) ? -1 : 1);
          item.items = buckets[node.id].accounts.map((a) => ({ label: a.name, value: flip * a.closing }));
        }
        out.push(item);
      } else {
        out.push({ label: 'calculation', kind: 'calc', value });
      }
    }
    return out;
  }

  const outRow = (r) => {
    const value = rowValue(r.key);
    const made = madeOf(r);
    return {
      key: r.key, label: r.label, detail: r.detail ?? null, counted: r.count !== false,
      value, fy25: typeof r.fy25 === 'number' ? r.fy25 : null,
      ...tieOf(value, r.audited?.value, ROW_TOLERANCE, hasTie), ref: r.audited?.ref ?? null,
      made: made.length === 1 && made[0].kind === 'row' ? [] : made,
    };
  };

  const stats = { lines: 0, ok: 0, check: 0 };
  const count = (t) => { if (t.status) { stats.lines++; if (t.status === 'OK') stats.ok++; else stats.check++; } };

  const notes = cfg.notes.map((n) => {
    const groups = n.groups.map((g) => {
      const rows = g.rows.map(outRow);
      rows.forEach(count);
      let total = null;
      if (g.total) {
        const value = g.total.expr ? calc(g.total.expr) : rows.filter((r) => r.counted).reduce((s, r) => s + r.value, 0);
        total = { label: g.total.label, value, fy25: g.total.fy25 ?? null, ...tieOf(value, g.total.audited?.value, TOTAL_TOLERANCE, hasTie), ref: g.total.audited?.ref ?? null };
        count(total);
      }
      return { label: g.label, rows, total };
    });

    let total = null;
    let unplaced = 0;
    let line = null;
    // a note adds up its groups (a group with its own total counts as that total, otherwise as the sum of its counted rows)
    const summed = groups.reduce((s, g) => s + (g.total ? g.total.value : g.rows.filter((r) => r.counted).reduce((a, r) => a + r.value, 0)), 0);
    if (n.total) {
      const value = n.total.expr ? calc(n.total.expr) : summed;
      total = { label: n.total.label, value, fy25: n.total.fy25 ?? null, ...tieOf(value, n.total.audited?.value, TOTAL_TOLERANCE, hasTie), ref: n.total.audited?.ref ?? null };
      count(total);
      if (n.lineExpr) {
        const lineValue = calc(n.lineExpr);
        const gap = value - lineValue;
        unplaced = Math.abs(gap) > 0.5 ? -gap : 0; // what the statement has that the heads do not
        line = { value: lineValue, gap, status: Math.abs(gap) <= TOTAL_TOLERANCE ? 'OK' : 'CHECK', showGap: Math.abs(gap) > SHOW_GAP_ABOVE };
      }
    }

    const tables = (n.tables ?? []).map((t) => {
      const rows = t.rows.map((row) => row.map((c) => {
        if (c && typeof c === 'object') {
          if ('expr' in c) {
            const value = calc(c.expr);
            const tol = c.fmt === 'pct' ? 0.0005 : ROW_TOLERANCE;
            const tie = tieOf(value, c.audited, tol, hasTie);
            return { value, fmt: c.fmt ?? null, ...tie };
          }
          return { value: c.static, fmt: c.fmt ?? null, fixed: true };
        }
        return typeof c === 'number' ? { value: c, fixed: true } : { text: String(c) };
      }));
      rows.forEach((r) => r.forEach(count));
      const ties = (t.ties ?? []).map((tie) => {
        const left = rows[tie.cell[0]][tie.cell[1]].value;
        const right = calc(tie.expr);
        const diff = left - right;
        const t2 = { label: tie.label, left, right, diff, status: Math.abs(diff) <= TOTAL_TOLERANCE ? 'OK' : 'CHECK' };
        stats.lines++; if (t2.status === 'OK') stats.ok++; else stats.check++;
        return t2;
      });
      return { title: t.title, unit: t.unit ?? 'rupees', columns: t.columns, rows, ties };
    });

    const checks = (n.checks ?? []).map((c, i) => {
      const value = calc(c.expr);
      const status = Math.abs(value) <= (c.tolerance ?? ROW_TOLERANCE) ? 'OK' : 'CHECK';
      stats.lines++; if (status === 'OK') stats.ok++; else stats.check++;
      return { key: c.key ?? `n${n.no}_check${i + 1}`, label: c.label, value, status };
    });

    if (line) { stats.lines++; if (line.status === 'OK') stats.ok++; else stats.check++; }
    const bad = [...groups.flatMap((g) => [...g.rows, g.total]), total, ...tables.flatMap((t) => [...t.rows.flat(), ...t.ties]), ...checks, line]
      .some((x) => x && x.status === 'CHECK');
    return {
      no: n.no, title: n.title, section: n.section, groups, total, line, unplaced, tables, checks,
      status: !hasTie ? null : bad ? 'CHECK' : 'OK',
    };
  });

  // lookup for other statements (cash flow, ratios): row value and last year's figure by key
  const byKey = {};
  for (const n of notes) {
    for (const g of n.groups) for (const r of g.rows) byKey[r.key] = { value: r.value, fy25: r.fy25 };
    if (n.total) byKey[`note${n.no}`] = { value: n.total.value, fy25: n.total.fy25 };
  }

  return { fy: snapshot.meta.fy, asOf: snapshot.meta.asOf, hasTie, notes, byKey, summary: { ...stats, notes: notes.length, notesBad: notes.filter((n) => n.status === 'CHECK').length } };
}
