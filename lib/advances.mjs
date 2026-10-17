// Advances received from customers, customer by customer: what Zoho can say about them, and how that compares with the signed sheet.
//
// In Zoho a customer's advance is a payment that was received but not (yet) applied to an invoice: the payment keeps an "unused amount".
// (There are no retainer invoices in RPEL's books - checked live, 16-Oct-2026.) The list of payments gives that amount for every payment, so adding
// the unused amounts of the payments dated up to the balance sheet date, customer by customer, gives the advance of each customer.
// What is NOT known yet is how closely this reproduces the audited list (BS Grouping, "Detail of Advance from Customer", Rs 31.80 cr): Zoho shows the
// unused amount as it is TODAY, so a payment that was applied to an invoice after 31 March 2026 no longer shows, and the auditors netted some customers by
// hand. scripts/probe-advances.mjs runs this on your own Zoho data and prints the comparison. Pure functions: pages and sheet rows are handed in.
//
// Result of that first run (16-Oct-2026): the unused amounts of today explain only 5.5 percent of the signed list, because most advances were applied to
// invoices after 31 March 2026. The better route is the LEDGER of the account "Advance from debtors" (every payment received in advance is posted to it
// with the customer, and every application to an invoice takes it out again, each with its date), read up to the balance sheet date: ledgerAdvances().
// The auditors then netted some customers by hand (config/overrides.fy26.json, the same list that lowers Trade receivables), so the advance of such a customer
// is lower by the amount netted, and a customer whose receivable is in credit shows that credit as an advance: advanceModel().
// Both are built from the same figures as the Advance-from-customers plug of the statements, so their total agrees with it by construction;
// scripts/probe-advances-ledger.mjs shows whether the customer-by-customer split agrees with the signed list.
// Result of that run on the live books (16-Oct-2026): the ledger adds up to the Trial Balance to the paisa, and every customer that could be paired with a
// line of the signed list agreed to within Rs 1 after the netting (61 of 113; the other lines could not be named: Zoho does not send the contact's name
// unless the report is asked for it, see zohoData.mjs LEDGER_COLUMNS). So since update-11 the refresh reads this ledger (snapshot.mjs buildAdvances) and the
// BS Grouping block "Detail of Advance from Customer" is checked line by line against it (overlay source "advance").

import { normName } from './overlay.mjs';

const money = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
const pageList = (raw) => { const root = raw?.data ?? raw; return Array.isArray(root?.customerpayments) ? root.customerpayments : null; };

/**
 * @param {object|object[]} input   one answer of GET /customerpayments, or all its pages
 * @param {{asOf:string}} opt       balance sheet date, "YYYY-MM-DD": payments dated later are left out
 * @returns {{customers:{id:string,name:string,unused:number,payments:number}[], total:number, payments:number, later:number, seen:number}}
 */
export function unusedByCustomer(input, { asOf }) {
  const pages = Array.isArray(input) ? input : [input];
  const byId = new Map();
  let seen = 0;
  let later = 0;
  let used = 0;
  for (const raw of pages) {
    const list = pageList(raw);
    if (!list) throw new Error('The payments answer has an unexpected shape (no customerpayments list)');
    for (const p of list) {
      seen += 1;
      if (String(p.date ?? '') > asOf) { later += 1; continue; }
      const unused = money(p.bcy_unused_amount ?? p.unused_amount); // in the books' own currency
      if (unused < 0.005) continue;
      used += 1;
      const id = String(p.customer_id ?? p.customer_name);
      const e = byId.get(id) ?? { id, name: String(p.customer_name ?? '').trim(), unused: 0, payments: 0 };
      e.unused += unused;
      e.payments += 1;
      byId.set(id, e);
    }
  }
  const customers = [...byId.values()].sort((a, b) => b.unused - a.unused);
  return { customers, total: customers.reduce((t, c) => t + c.unused, 0), payments: used, later, seen };
}

/** The lines of "Detail of Advance from Customer" of the exported BS Grouping sheet: [{ label, signed }]. */
export function advanceLinesOfSheet(rows) {
  const at = rows.findIndex((r) => r.some((c) => typeof c === 'string' && c.trim().toLowerCase().startsWith('detail of advance from customer')));
  if (at < 0) throw new Error('"Detail of Advance from Customer" was not found in the sheet');
  const lines = [];
  for (let i = at + 1; i < rows.length; i += 1) {
    const label = rows[i][1];
    const v = rows[i][4];
    if (typeof label === 'string' && /^total\b/i.test(label.trim())) break;
    if (typeof rows[i][0] === 'string' && /^detail/i.test(rows[i][0])) break;
    if (typeof label === 'string' && label.trim() && typeof v === 'number') lines.push({ label: label.trim(), signed: v });
  }
  return lines;
}

/**
 * How the advances Zoho shows compare with the signed list.
 * @param {{name:string, unused:number}[]} customers  from unusedByCustomer
 * @param {{label:string, signed:number}[]} lines     from advanceLinesOfSheet
 */
export function compareAdvances(customers, lines, tolerance = 1) {
  const pool = new Map();
  for (const c of customers) { const k = normName(c.name); const e = pool.get(k); if (e) e.unused += c.unused; else pool.set(k, { name: c.name, unused: c.unused, src: c }); }
  const taken = new Set();
  const same = [];
  const differ = [];
  const missing = [];
  for (const l of lines) {
    const k = normName(l.label);
    const e = pool.get(k);
    if (!e || taken.has(k)) { missing.push(l); continue; }
    taken.add(k);
    const diff = e.unused - l.signed;
    (Math.abs(diff) <= tolerance ? same : differ).push({ ...l, zoho: e.unused, diff, src: e.src });
  }
  // what is left on both sides: a sheet line and a customer with the same amount, where no other leftover has that amount either, are the same
  // customer written differently (the auditors' list uses its own spelling)
  const rest = [...pool.entries()].filter(([k]) => !taken.has(k)).map(([k, e]) => ({ k, ...e }));
  const renamed = [];
  const stillMissing = [];
  const usedRest = new Set();
  for (const l of missing) {
    const hits = rest.filter((e) => !usedRest.has(e.k) && Math.abs(e.unused - l.signed) <= tolerance);
    const rivals = missing.filter((m) => m !== l && Math.abs(m.signed - l.signed) <= tolerance);
    if (hits.length === 1 && rivals.length === 0 && Math.abs(l.signed) > tolerance) {
      usedRest.add(hits[0].k);
      renamed.push({ ...l, zoho: hits[0].unused, diff: hits[0].unused - l.signed, name: hits[0].name, src: hits[0].src });
    } else stillMissing.push(l);
  }
  const extra = rest.filter((e) => !usedRest.has(e.k)).sort((a, b) => b.unused - a.unused);
  const sum = (xs, f) => xs.reduce((t, x) => t + f(x), 0);
  return {
    same, renamed, differ, missing: stillMissing, extra,
    signedTotal: sum(lines, (l) => l.signed),
    zohoTotal: sum(customers, (c) => c.unused),
    explained: sum(same, (x) => x.signed) + sum(renamed, (x) => x.signed) + sum(differ, (x) => Math.min(x.signed, x.zoho)),
  };
}

const UNTAGGED = '-1'; // Zoho's "Unassociated Transactions" contact (see gl.mjs)

/**
 * The advance of each customer at the balance sheet date, from the ledger of the "Advance from debtors" account.
 * The account is a liability: a credit (money received in advance) is an advance, a debit (applied to an invoice, refunded) takes it out again.
 * @param {{txnId:string,accountId:string,contactId:string,contactName:string,date:string,net:number}[]} rows  from normalizeGL + expandMergedRows (net = debit - credit)
 * @param {{asOf:string, accountId?:string}} opt  rows dated later than asOf are left out; with accountId only that account's rows are used
 * @returns {{customers:{id:string,name:string,ledger:number,lines:number}[], total:number, lines:number, later:number}}  ledger = credit balance (an advance is positive)
 */
export function ledgerAdvances(rows, { asOf, accountId = null }) {
  const byId = new Map();
  let later = 0;
  let lines = 0;
  for (const r of rows) {
    if (accountId && String(r.accountId) !== String(accountId)) continue;
    if (String(r.date ?? '') > asOf) { later += 1; continue; }
    lines += 1;
    const id = String(r.contactId ?? UNTAGGED);
    const e = byId.get(id) ?? { id, name: '', ledger: 0, lines: 0 };
    e.ledger -= money(r.net);
    e.lines += 1;
    if (!e.name && r.contactName && !id.includes(',')) e.name = String(r.contactName).split('\n')[0].trim();
    byId.set(id, e);
  }
  const customers = [...byId.values()].filter((e) => Math.abs(e.ledger) > 0.005).sort((a, b) => b.ledger - a.ledger);
  return { customers, total: customers.reduce((t, c) => t + c.ledger, 0), lines, later };
}

/**
 * The advance of each customer as the signed list shows it: ledger advance, less what the auditors netted against the customer's receivable by hand,
 * plus the credit of a customer whose receivable is below zero (the statements show that as an advance too - see receivables.mjs).
 *   advance_i = ledger_i + adjustment_i + max(0, -(zb_total_i + adjustment_i))        (adjustment is zero or negative)
 * Summed over all customers this is the "Advance from customers" figure of the statements.
 * @param {{id:string,name:string,ledger:number}[]} ledger        customers of ledgerAdvances()
 * @param {{id:string,name:string,zb_total:number,adjustment:number}[]} receivables  customers of the receivables engine
 * @returns {{customers:{id,name,ledger,adjustment,credit,advance}[], total:number, ledgerTotal:number, nettedTotal:number, creditTotal:number, negative:object[]}}
 */
export function advanceModel(ledger, receivables) {
  const ar = new Map(receivables.map((c) => [String(c.id), c]));
  const led = new Map(ledger.map((c) => [String(c.id), c]));
  const ids = new Set([...led.keys()]);
  for (const c of receivables) {
    const credit = Math.max(0, -(c.zb_total + c.adjustment));
    if (Math.abs(c.adjustment) > 0.005 || credit > 0.005) ids.add(String(c.id));
  }
  const customers = [];
  for (const id of ids) {
    const l = led.get(id);
    const a = ar.get(id);
    const adjustment = a ? a.adjustment : 0;
    const credit = a ? Math.max(0, -(a.zb_total + a.adjustment)) : 0;
    const ledgerAmt = l ? l.ledger : 0;
    const advance = ledgerAmt + adjustment + credit;
    if (Math.abs(advance) <= 0.005 && Math.abs(ledgerAmt) <= 0.005) continue;
    customers.push({ id, name: (a?.name || l?.name || (id === UNTAGGED ? '(no customer on the entry)' : id)).trim(), ledger: ledgerAmt, adjustment, credit, advance });
  }
  customers.sort((x, y) => y.advance - x.advance);
  const sum = (f) => customers.reduce((t, c) => t + f(c), 0);
  return {
    customers,
    total: sum((c) => c.advance),
    ledgerTotal: sum((c) => c.ledger),
    nettedTotal: sum((c) => c.adjustment),
    creditTotal: sum((c) => c.credit),
    negative: customers.filter((c) => c.advance < -0.005),
  };
}
