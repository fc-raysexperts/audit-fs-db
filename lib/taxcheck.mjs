// update-30: the ADVANCE TAX of the year, payment by payment, and the interest on tax (sections 234B and 234C) re-worked from those payments - beside the Computation tab
// (config/tax.fyYY.json, block "advance").
//
// Two layers, like lib/related.mjs and lib/register.mjs:
//   READ   the ledger of the advance-tax accounts (the account of the assessment year and the one the balance was moved to) -> the `tax` section of the snapshot
//   CHECK  snapshot.tax + the built Computation sheet -> a table of the dated payments, three checks and the interest worked out again
//
// What was seen on the real books (21-Oct-2026): seven bank payments, 6 Dec 2025 to 28 Mar 2026, together Rs 10,61,00,000 on the account "Advance Tax ( Ay 26-27 )"; on 31 March 2026
// the journal JN-Clean-3 moved the whole balance to "Advance Tax- F.Y. 2025-26". Worked out again from those dates (shortfalls rounded down to Rs 100 as section 288B says, interest at 1%
// a month), section 234C gives Rs 69,47,948 and section 234B, for 6 months, Rs 33,39,684: together Rs 1,02,87,632, the figure the auditors have in Computation!J53 to the rupee.
//
// Nothing here tells anyone to change anything in Zoho: the books are audited and closed. Where the re-working gives another amount it is shown as information, with the reason
// (the auditors' figure is a year-end input and stays in the computation).

import { num, r2 } from './util.mjs';

export const TAX_SCHEMA = 1;
export const TAX_TOLERANCE = 25; // Rs, as for the other checks of the tax sheets

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const inr = (x) => new Intl.NumberFormat('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(Math.round(x));
const dmy = (ymd) => {
  const [y, m, d] = String(ymd).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' });
};
/** Section 288B: an amount of tax or interest is rounded DOWN to a multiple of Rs 100 before the interest is worked out. */
export const down100 = (x) => (x > 0 ? Math.floor(x / 100 + 1e-9) * 100 : 0);

/* ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ */
/* READ                                                                                                                                                                             */
/* ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ */

/**
 * The ledger pages of the advance-tax accounts -> { payments, journals, accounts, closing }.
 *   payment  = a line that is not a journal: a debit is money paid (positive), a credit is money given back (negative)
 *   journal  = grouped by entry number: what it took out of one account and put into the other (a transfer of the balance to a new ledger account)
 *   accounts = the closing balance of each account asked for (debit positive)
 */
export function readAdvanceLedger(pages, spec) {
  const list = Array.isArray(pages) ? pages : [pages];
  if (!list.length) throw new Error('Advance tax ledger: no pages given');
  const asked = new Map((spec.accounts ?? []).map((a) => [String(a.id), a.name]));
  const lines = [];
  let total = null;
  let last = null;
  for (const p of list) {
    const root = p?.data ?? p;
    const groups = root?.account_transactions;
    if (!Array.isArray(groups)) throw new Error('The advance tax ledger has an unexpected shape (no account_transactions)');
    for (const g of groups) for (const r of g.account_transactions ?? []) {
      lines.push({
        id: String(r.transaction_id ?? ''), account: String(r.account_id ?? g.group_name ?? ''), accountName: r.account_name ?? '',
        type: r.transaction_type ?? '', entry: r.entity_number ?? '', date: r.date ?? '', narration: String(r.transaction_details ?? '').replace(/\s+/g, ' ').trim(),
        net: num(r.debit) - num(r.credit),
      });
    }
    const pc = root.page_context ?? {};
    total = pc.total ?? total;
    last = pc;
  }
  if (last?.has_more_page === true) throw new Error('The advance tax ledger is incomplete: the last page still says has_more_page');
  if (total !== null && lines.length !== total) throw new Error(`The advance tax ledger is incomplete: the report says ${total} lines but ${lines.length} were read`);
  for (const l of lines) if (!asked.has(l.account)) throw new Error(`The advance tax ledger has a line of another account ("${l.accountName || l.account}")`);

  const payments = lines.filter((l) => l.type !== 'journal')
    .map((l) => ({ date: l.date, amount: r2(l.net), entry: l.entry, type: l.type, narration: l.narration, account: l.account }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.entry.localeCompare(b.entry));
  const byEntry = new Map();
  for (const l of lines.filter((x) => x.type === 'journal')) {
    const j = byEntry.get(l.entry) ?? { entry: l.entry, date: l.date, narration: l.narration, out: 0, into: 0, lines: [] };
    if (l.net < 0) j.out += -l.net; else j.into += l.net;
    j.lines.push({ account: l.account, net: r2(l.net) });
    byEntry.set(l.entry, j);
  }
  const journals = [...byEntry.values()].map((j) => ({ ...j, out: r2(j.out), into: r2(j.into), net: r2(j.into - j.out) })).sort((a, b) => a.date.localeCompare(b.date));
  const accounts = [...asked].map(([id, name]) => ({ id, name, closing: r2(lines.filter((l) => l.account === id).reduce((t, l) => t + l.net, 0)) }));
  return { payments, journals, accounts, closing: r2(accounts.reduce((t, a) => t + a.closing, 0)) };
}

/**
 * The `tax` section of the snapshot: { schema, to, payments, journals, accounts, closing } or { schema, to, error } when Zoho could not give the ledger.
 * `pages` = the raw ledger pages, `{ error }` (Zoho refused or stopped) or null (not asked for).
 */
export function buildTaxSection({ spec, pages, to, alerts = [] }) {
  if (!spec) return null;
  if (pages === null || pages === undefined) return { schema: TAX_SCHEMA, to, error: 'not asked for' };
  const fail = (why) => {
    alerts.push({ level: 'info', code: 'TAX_UNAVAILABLE', message: `The ledger of the advance tax accounts could not be read from Zoho (${why}); the Computation tab shows the interest as the auditors have it and does not re-work it` });
    return { schema: TAX_SCHEMA, to, error: why };
  };
  if (pages.error) return fail(pages.error.message ?? String(pages.error));
  try {
    return { schema: TAX_SCHEMA, to, ...readAdvanceLedger(pages, spec) };
  } catch (e) {
    return fail(e.message);
  }
}

/* ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ */
/* CHECK                                                                                                                                                                            */
/* ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ */

/**
 * Sections 234C and 234B from dated payments.
 *   assessed   tax on the total income (tax + surcharge + cess) less the TDS / TCS credit
 *   234C       for each instalment: what had to be paid by its due date (a share of the assessed tax) less what was paid by then; the shortfall (rounded down to Rs 100) bears 1% a month
 *              for 3 months (1 month for the last); no interest on the first two instalments if at least 12% / 36% had been paid by then
 *   234B       if less than 90% of the assessed tax was paid by 31 March: 1% a month on the whole shortfall (rounded down to Rs 100) for the months from April to the date of the return
 * @param {{assessed:number, payments:{date:string,amount:number}[], instalments:object[], months234b:number, threshold234b?:number, yearEnd:string}} p
 */
export function workInterest({ assessed, payments, instalments, months234b, threshold234b = 0.9, yearEnd }) {
  const paidBy = (d) => r2(payments.filter((p) => p.date <= d).reduce((t, p) => t + p.amount, 0));
  const rows = instalments.map((it) => {
    const need = r2(assessed * it.upto);
    const paid = paidBy(it.due);
    const shortfall = Math.max(0, r2(need - paid));
    const relieved = shortfall > 0 && it.relief !== null && it.relief !== undefined && paid >= assessed * it.relief - 0.005; // a shortfall that bears no interest because enough had been paid
    const interest = relieved ? 0 : r2(down100(shortfall) * 0.01 * it.months);
    return { due: it.due, upto: it.upto, relief: it.relief ?? null, months: it.months, need, paid, shortfall, relieved, interest };
  });
  const c234 = r2(rows.reduce((t, r) => t + r.interest, 0));
  const paidYear = paidBy(yearEnd);
  const short = Math.max(0, r2(assessed - paidYear));
  const applies = paidYear < assessed * threshold234b - 0.005;
  const b234 = { assessed: r2(assessed), paid: paidYear, shortfall: short, percent: assessed > 0 ? paidYear / assessed : null, months: months234b, applies, interest: applies ? r2(down100(short) * 0.01 * months234b) : 0 };
  return { rows, c234, b234, total: r2(c234 + b234.interest) };
}

const NOT_IN_SNAPSHOT = 'The advance tax ledger is not in this snapshot (an older copy): refresh the data';

/**
 * @param {{snapshot:object, spec:object, sheet:object}} p   sheet = the built Computation sheet (lib/calc.mjs buildSheet), with `byKey`
 * @returns {object|null}  null when the year has no "advance" block; otherwise { available, why, payments, checks, instalments, b234, ..., summary, panel }
 */
export function buildAdvanceTaxChecks({ snapshot, spec, sheet }) {
  if (!spec) return null;
  const sec = snapshot?.tax ?? null;
  const tol = spec.tolerance ?? TAX_TOLERANCE;
  const problems = [];
  const info = [];
  const checks = [];
  const panel = {
    title: 'Advance tax and interest on tax',
    foot: "The payments are read from the ledger of the advance tax accounts in Zoho Books: the account of the assessment year and the account the balance was moved to on 31 March 2026. The interest is worked out again here from the dates of those payments (section 234C for each instalment, section 234B for the whole year; each shortfall is rounded down to ₹100 and bears 1% a month). The auditors' figure is a year-end input of the computation and stays as it is; this working is information beside it.",
  };
  const out = { available: false, why: null, payments: [], journals: [], accounts: [], checks, instalments: [], b234: null, c234: null, worked: null, signed: null, assessed: null, problems, info, stays: (spec.stays ?? []).map((s) => s.text ?? s), summary: { lines: 0, ok: 0, expl: 0, diff: 0, none: 0 }, panel };

  const rowValue = (key) => { const r = sheet?.byKey?.[key]; return r && isNum(r.value) ? r.value : null; };
  const [tax, sur, cess, tds, adv, int] = ['c_tax', 'c_sur', 'c_cess', 'c_tds', 'c_adv', 'c_int'].map(rowValue);
  if ([tax, sur, cess, tds].some((v) => v === null)) { out.why = 'The computation does not have the tax or the TDS line, so nothing can be worked out again'; return out; }
  const assessed = r2(tax + sur + cess - tds);
  out.assessed = assessed;
  out.signed = int;
  if (!sec) { out.why = NOT_IN_SNAPSHOT; return out; }
  if (sec.error) { out.why = `Zoho did not give the ledger of the advance tax accounts (${sec.error})`; return out; }

  out.available = true;
  const from = snapshot.meta?.from ?? `${String(snapshot.meta?.fy ?? '').slice(0, 4)}-04-01`;
  const yearEnd = snapshot.meta?.to ?? sec.to;
  let cum = 0;
  out.payments = sec.payments.map((p) => {
    cum = r2(cum + p.amount);
    return { ...p, inYear: p.date >= from && p.date <= yearEnd, cumulative: cum, percent: assessed > 0 ? cum / assessed : null };
  });
  out.journals = sec.journals;
  out.accounts = sec.accounts;
  const paid = r2(sec.payments.reduce((t, p) => t + p.amount, 0));
  out.paid = paid;

  // 1. the dated payments add up to the Advance tax line of the computation (which is the Zoho balance of the advance tax group)
  if (adv !== null) {
    const diff = r2(paid - adv);
    checks.push({ id: 'paid', title: 'The dated payments add up to the Advance tax line', signed: r2(adv), zoho: paid, diff, status: Math.abs(diff) <= tol ? 'OK' : 'DIFF', text: Math.abs(diff) <= tol ? null : `The payments on the advance tax accounts total ₹${inr(paid)}; the line is ₹${inr(adv)}.` });
  }
  // 2. nothing else sits on these accounts: after the transfer journal one account holds the whole amount and the other nothing
  const closing = sec.closing;
  const moved = sec.journals.filter((j) => Math.abs(j.net) <= 0.005 && j.out > 0);
  const oneHolds = sec.accounts.filter((a) => Math.abs(a.closing) > 0.005);
  {
    const diff = r2(closing - paid);
    const ok = Math.abs(diff) <= tol;
    let text = null;
    if (!ok) text = `The accounts hold ₹${inr(closing)} on ${dmy(yearEnd)} against payments of ₹${inr(paid)}: other entries sit on them.`;
    else if (moved.length) text = `${moved.map((j) => `${j.entry} (${dmy(j.date)}) moved ₹${inr(j.out)} from one account to the other`).join('; ')}; ${oneHolds.length === 1 ? `the whole amount is now on "${oneHolds[0].name}"` : 'the balance is now on the accounts below'}.`;
    checks.push({ id: 'closing', title: 'The advance tax accounts hold exactly what was paid', signed: r2(paid), zoho: r2(closing), diff, status: ok ? 'OK' : 'DIFF', text });
  }
  // 3. every payment falls in the year
  {
    const outside = out.payments.filter((p) => !p.inYear);
    checks.push({
      id: 'dates', title: 'Every payment is dated within the financial year', signed: out.payments.length, zoho: out.payments.length - outside.length, diff: -outside.length,
      status: outside.length ? 'DIFF' : 'OK', count: true,
      text: outside.length ? `${outside.map((p) => `${dmy(p.date)} (₹${inr(p.amount)})`).join(', ')} falls outside ${dmy(from)} to ${dmy(yearEnd)}.` : null,
    });
  }
  // 4. the interest on tax, worked out again
  const months = spec.months_234b?.value;
  if (!isNum(months)) { problems.push('The number of months for section 234B is missing from the configuration: the interest is not worked out again'); }
  else if (int === null) { problems.push("The computation has no interest line: the interest is not worked out again"); }
  else {
    const w = workInterest({ assessed, payments: sec.payments, instalments: spec.instalments ?? [], months234b: months, threshold234b: spec.threshold_234b ?? 0.9, yearEnd });
    out.worked = w;
    out.instalments = w.rows;
    out.b234 = w.b234;
    out.c234 = w.c234;
    const diff = r2(w.total - int);
    const ok = Math.abs(diff) <= tol;
    checks.push({
      id: 'interest', title: 'Interest on tax (sections 234B and 234C) worked out again', signed: r2(int), zoho: w.total, diff, status: ok ? 'OK' : 'DIFF',
      text: ok
        ? `Section 234C ₹${inr(w.c234)} plus section 234B ₹${inr(w.b234.interest)} (${months} months) is ₹${inr(w.total)}, the auditors' figure.`
        : `Worked out again from the dates above, section 234C gives ₹${inr(w.c234)} and section 234B ₹${inr(w.b234.interest)} (${months} months), together ₹${inr(w.total)}; the auditors have ₹${inr(int)}. The auditors' figure stays in the computation (it is a year-end input). The usual reasons for a different amount are the number of months of section 234B (it runs to the date of the return) and a payment the auditors counted on another date.`,
    });
  }

  const firstDue = spec.instalments?.[0]?.due;
  const firstPaid = out.payments[0]?.date;
  if (firstDue && firstPaid && firstPaid > firstDue) info.push(`The first payment was made on ${dmy(firstPaid)}; the first instalment was due on ${dmy(firstDue)}. That is why section 234C interest arises on the instalments before it.`);
  const count = (s) => checks.filter((c) => c.status === s).length;
  out.summary = { lines: checks.length, ok: count('OK'), expl: count('EXPL'), diff: count('DIFF'), none: count('NONE') };
  return out;
}
