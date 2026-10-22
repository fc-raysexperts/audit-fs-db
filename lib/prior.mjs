// update-31: last year (31 March 2025) from Zoho Books, beside the figures the auditors signed for it.
//
//   READ  (at refresh)  buildPriorSection: Zoho's Trial Balance of 2024-25 -> the same statement engine as this year -> the line figures (a small section of the snapshot)
//   CHECK (on the page) buildPriorView:    those figures against the comparative column of the signed statements, laid out like the statements, with a result for every line
//
// The Trial Balance of 2024-25 lists the old chart of accounts (mostly uncoded). config/prior.fyYY.json says, account by account, which line each one feeds, and holds the few figures
// Zoho cannot show (the opening stock, the part of the fixed deposits that is non-current ...). Last year is audited and closed, so a difference is only ever explained, never a request to change Zoho.
//
// What it covers: the Balance Sheet and the Profit and Loss. What it does not: the party-level group (advances to suppliers, trade payables, retention money, outstanding expenses) is compared
// as one net figure - splitting it needs last year's supplier ledgers - and the notes, cash flow, fixed asset schedule, ratios and ageing of last year stay as signed.

import { normalizeTB, checkTB } from './tb.mjs';
import { mapAccounts } from './mapping.mjs';
import { computeFS, TOLERANCE } from './fsEngine.mjs';
import { AUDITED_REF } from './reconcile.mjs';
import { BS_LAYOUT, PL_LAYOUT, TOTAL_TOLERANCE } from './present.mjs';
import { r2 } from './util.mjs';

/** The lines the Trial Balance gives only as one net figure (their parts need the supplier ledgers). */
export const PARTY_KEYS = ['tp_msme', 'tp_others', 'ocl_retention', 'ocl_outstanding_expenses', 'sla_advance_suppliers_others'];

const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
// a figure for the snapshot: two decimals, and never -0 (it would not survive the trip through JSON)
const fig = (x) => r2(x) || 0;
const known = (xs) => xs.every((x) => typeof x === 'number' && Number.isFinite(x));

/**
 * Is the prior-year configuration usable? Returns the sentences that say why not (empty = fine).
 * @param {object|null} spec  config/prior.fyYY.json
 */
export function checkPriorSpec(spec) {
  const bad = [];
  if (!spec || typeof spec !== 'object') return ['there is no prior-year configuration'];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(spec.from ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(spec.to ?? '')) bad.push('`from` and `to` must be dates like 2025-03-31');
  if (!Array.isArray(spec.rules) || !spec.rules.length) bad.push('it has no account rules');
  for (const k of ['car_loan_current_maturities', 'fd_noncurrent', 'security_deposit_noncurrent', 'fines_debit_to_earlier_year_tax']) {
    if (typeof spec.inputs?.[k]?.value !== 'number') bad.push(`the input "${k}" is missing`);
  }
  return bad;
}

/**
 * READ: last year's Trial Balance -> line figures.
 * @param {object} p
 * @param {object} p.spec      config/prior.fyYY.json
 * @param {object} p.raw       Zoho's Trial Balance answer for the year ({error} when it could not be read)
 * @param {object} p.mapping   config/mapping.json (the accounts of the new chart that it claims are not repeated in the prior rules)
 * @param {object[]} p.alerts  alerts of the snapshot (a problem here is a warning, never an error: it is a detail layer)
 * @returns {{error:string}|{fy,from,to,asOf,basis,accounts,lines,checks}}
 */
export function buildPriorSection({ spec, raw, mapping, alerts }) {
  const fail = (why) => {
    alerts.push({ level: 'warn', code: 'PRIOR_UNAVAILABLE', message: `Last year (${spec?.to ?? '31 March 2025'}) could not be read from Zoho (${why}); the last-year panels stay empty and the signed figures are unchanged` });
    return { error: why };
  };
  const bad = checkPriorSpec(spec);
  if (bad.length) return fail(`config/prior is not usable: ${bad.join('; ')}`);
  if (raw?.error) return fail(raw.error.message ?? String(raw.error));
  try {
    const tb = normalizeTB(raw);
    if (tb.meta.to && tb.meta.to !== spec.to) return fail(`Zoho returned the Trial Balance up to ${tb.meta.to}, not ${spec.to}`);
    const merged = { ...mapping, rules: [...mapping.rules, ...spec.rules] };
    // last year's debtors come from the control accounts of the Trial Balance (the customer-wise ageing of last year is not read): the engine's receivables then equal the Trial Balance
    const { buckets } = mapAccounts(tb.accounts, merged);
    const receivable = buckets.ar_control?.sum ?? 0;
    const aging = { meta: { asOf: spec.to }, contacts: [{ id: 'ALL', name: 'All customers (Trial Balance)', total: receivable }], total: receivable };
    const fs = computeFS({ tb, mapping: merged, inputs: { as_of: spec.to, inputs: spec.inputs }, aging, overrides: null });
    for (const a of [...checkTB(tb), ...fs.alerts]) {
      alerts.push({ level: a.level === 'info' ? 'info' : 'warn', code: `PRIOR_${a.code}`, message: `Last year's Trial Balance: ${a.message}` });
    }
    return {
      fy: spec.fy, from: spec.from, to: spec.to, asOf: tb.meta.to ?? spec.to, basis: tb.meta.basis ?? null, accounts: tb.accounts.length,
      lines: Object.fromEntries(Object.values(fs.lines).map((l) => [l.key, fig(l.value)])),
      checks: fs.checks.map((c) => ({ key: c.key, label: c.label, ok: c.ok, value: fig(c.value) })),
    };
  } catch (e) {
    return fail(e.message);
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** Last year's figure of one row of config/notes.fyYY.json (the notes carry a `fy25` next to each audited value). */
function noteFigure(notes, rowKey) {
  let found;
  const walk = (o) => {
    if (found !== undefined || o === null || typeof o !== 'object') return;
    if (!Array.isArray(o) && o.key === rowKey && typeof o.fy25 === 'number') { found = o.fy25; return; }
    for (const v of Array.isArray(o) ? o : Object.values(o)) walk(v);
  };
  walk(notes);
  return found;
}

const leafKeys = (item) => (item.items ? item.items.flatMap(leafKeys) : [item.key]);

/**
 * CHECK: the figures read from last year's Trial Balance against the signed ones, laid out like the statements.
 * Statuses: OK (agrees within a few rupees) | EXPL (differs by the amount `explain` of config/prior says, with the reason) | DIFF (differs, nothing explains it) | NONE (no signed figure to compare).
 * @param {{section:object|null, audited:object|null, notes:object|null, spec:object|null}} p
 * @returns {null | {error:string} | object}  null = the year has no prior-year configuration
 */
export function buildPriorView({ section, audited, notes, spec }) {
  if (!spec) return null;
  if (!section) return { error: "Last year has not been read in this snapshot yet (it follows on the next refresh)." };
  if (section.error) return { error: section.error };

  const lines = section.lines ?? {};
  const explain = new Map((spec.explain ?? []).map((e) => [e.key, e]));
  const fromNotes = spec.audited_from_notes ?? {};

  // the signed figure of a line: the comparative column of the signed statements, or of the notes for the lines that live there
  const signed = (key) => {
    const ref = AUDITED_REF[key];
    if (!ref) return null;
    const [sec, k] = ref;
    if (sec === 'notes') return noteFigure(notes, fromNotes[key]) ?? null;
    const v = audited?.[sec]?.[k]?.fy25;
    return typeof v === 'number' ? v : null;
  };
  const signedBs = (key) => (typeof audited?.bs?.[key]?.fy25 === 'number' ? audited.bs[key].fy25 : null);
  const partySigned = Object.fromEntries(PARTY_KEYS.map((k) => [k, signed(k)]));
  const partyNetSigned = known(Object.values(partySigned))
    ? partySigned.sla_advance_suppliers_others - partySigned.tp_msme - partySigned.tp_others - partySigned.ocl_retention - partySigned.ocl_outstanding_expenses
    : null;

  const judge = (key, zoho, signedValue, tol) => {
    if (typeof signedValue !== 'number') return { signed: null, diff: null, status: 'NONE', text: null };
    const diff = zoho - signedValue;
    if (Math.abs(diff) <= tol) return { signed: signedValue, diff, status: 'OK', text: null };
    const ex = explain.get(key);
    if (ex && Math.abs(diff - ex.diff) <= (ex.tol ?? TOLERANCE)) return { signed: signedValue, diff, status: 'EXPL', text: ex.text };
    return { signed: signedValue, diff, status: 'DIFF', text: null };
  };
  const row = (id, kind, level, label, zoho, signedValue, tol) => ({ id, kind, level, label, zoho, ...judge(id, zoho, signedValue, tol) });

  // a total that leaves the party-level group out: the signed total less the signed party lines it holds
  const signedWithout = (total, keys) => {
    const parts = keys.filter((k) => PARTY_KEYS.includes(k)).map((k) => partySigned[k]);
    return total !== null && known(parts) ? total - parts.reduce((s, x) => s + x, 0) : null;
  };

  function side(layout) {
    const rows = [];
    let sideTotal = 0;
    const sideKeys = [];
    for (const part of layout.parts) {
      rows.push({ id: `h:${part.heading}`, kind: 'heading', level: 0, label: part.heading });
      let partTotal = 0;
      const partKeys = part.items.flatMap(leafKeys);
      for (const item of part.items) {
        if (item.items) {
          const kids = item.items.filter((k) => !PARTY_KEYS.includes(k.key));
          if (!kids.length) continue; // trade payables: only party lines
          const kidRows = kids.map((k) => row(k.key, 'sub', 2, k.label, num(lines[k.key]), signed(k.key), TOLERANCE));
          const value = kidRows.reduce((s, r) => s + r.zoho, 0);
          const own = item.auditedKey ? signedWithout(signedBs(item.auditedKey), leafKeys(item)) : null;
          const total = own ?? (known(kidRows.map((r) => r.signed)) ? kidRows.reduce((s, r) => s + r.signed, 0) : null);
          rows.push(row(item.key, 'group', 1, item.label, value, total, TOTAL_TOLERANCE), ...kidRows);
          partTotal += value;
        } else if (!PARTY_KEYS.includes(item.key)) {
          const r = row(item.key, 'line', 1, item.label, num(lines[item.key]), signed(item.key), TOLERANCE);
          rows.push(r);
          partTotal += r.zoho;
        }
      }
      rows.push(row(part.total[0], 'subtotal', 0, part.total[1], partTotal, signedWithout(signedBs(part.total[0]), partKeys), TOTAL_TOLERANCE));
      sideTotal += partTotal;
      sideKeys.push(...partKeys);
    }
    rows.push(row(layout.total[0], 'grand', 0, layout.total[1], sideTotal, signedWithout(signedBs(layout.total[0]), sideKeys), TOTAL_TOLERANCE));
    return rows;
  }

  const party = [{ id: 'h:party', kind: 'heading', level: 0, label: 'Supplier lines, as one net figure' }, row('party_net', 'line', 1, 'Advances to suppliers and others, less trade payables, retention money and outstanding expenses (net)', num(lines.party_net), partyNetSigned, TOLERANCE)];
  const pl = PL_LAYOUT.map((d) => {
    if (d.kind === 'heading') return { id: `h:${d.label}`, kind: 'heading', level: 0, label: d.label };
    const kind = d.key === 'pbt' || d.key === 'pat' ? 'grand' : d.kind === 'total' ? 'subtotal' : 'line';
    return row(d.key, kind, 1, d.label, num(lines[d.key]), signed(d.key), kind === 'line' ? TOLERANCE : TOTAL_TOLERANCE);
  });

  const bs = { liabilities: side(BS_LAYOUT.liabilities), assets: side(BS_LAYOUT.assets), party };
  const compared = [...bs.liabilities, ...bs.assets, ...party, ...pl].filter((r) => r.status);
  const count = (s) => compared.filter((r) => r.status === s).length;
  const seen = new Set();
  const explained = compared.filter((r) => r.status === 'EXPL').map((r) => ({ id: r.id, label: r.label, diff: r.diff, text: r.text }))
    .filter((e) => !seen.has(e.text) && seen.add(e.text));

  return {
    fy: section.fy, from: section.from, to: section.to, asOf: section.asOf, accounts: section.accounts,
    hasSigned: Boolean(audited),
    bs, pl, partyText: spec.party_text ?? null, explainNote: spec.explain_note ?? null,
    summary: { ok: count('OK'), expl: count('EXPL'), diff: count('DIFF'), none: count('NONE'), total: compared.length },
    explained,
    checks: section.checks ?? [],
  };
}
