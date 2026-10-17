// Ageing of debtors and creditors, rebuilt from Zoho Books (pure functions: the report answers and the ledger lines are handed in).
//
// Why a model is needed. The auditors' Debtors Ageing and Creditors Ageing sheets age every balance by invoice date, first-in first-out: the oldest
// invoices are taken as paid first, so what is still open is the NEWEST invoices. Zoho's own aging report cannot give that for this company's books
// (the opening balances were loaded as invoices dated 31-Mar-2025, and clean-up journals sit in the aging buckets), so the buckets are worked out from
// figures Zoho does give exactly:
//
//   DEBTORS  (per customer)                                    source in Zoho
//     opening   the balance at the day before the year began    Customer Balance Summary, as of that day (credit openings included)
//     invoiced  invoiced this year  = invoiced to date - opening (if it was a debit)         Customer Balance Summary, as of the balance sheet date
//     received  received this year  = received to date - opening (if it was a credit)        the same report
//     i6        invoiced in the last six months, less credit notes                           Sales by Customer, for those six months
//     closing   the receivable as the dashboard works it out (after the auditors' hand-netting)
//
//     older  = what is left of the opening balance after the payments of the year, oldest first = min( max(closing - invoiced, 0), max(opening, 0) )
//     lt6    = the newest invoices: min( closing - older, i6 )                                 (Less than 6 months)
//     m6_12  = the rest of the year's invoices still open                                     (6 months to 1 year)
//     "older" is what the sheet shows as 1-2 years + 2-3 years + more than 3 years: Zoho cannot split it further, so only the three together are compared.
//
//     Update-14 (17-Oct-2026): the auditors age every DEBIT by its date - manual journals too (RAYS O&M: journal SJ-1273 of Rs 50,40,001 dated 31-Mar-2026 is "less
//     than 6 months"; Tulsi Palace: journal SJ-68 of Rs 2,62,500 dated 24-Apr-2025 is "6 months to 1 year") - and apply every credit (receipts, TDS journals) to the
//     oldest first. Sales by Customer sees invoices and credit notes only. The Customer Balance Summary's "invoiced" figure sees journals too, but nets journal
//     credits (TDS) into it. So per half of the year (April-September, October-March) the debits are taken as the larger of the two:
//         d1 = max( i1, c1 )   d2 = max( i2, c2 )     i = invoices less credit notes (Sales by Customer of that half), c = the change of the Customer Balance Summary's
//                                                    "invoiced" over that half (balances at 31-Mar-2025, 30-Sep-2025, 31-Mar-2026)
//         older = min( max(closing - (d1 + d2), 0), max(opening, 0) )     lt6 = min( closing - older, d2 )     m6_12 = the rest
//     A half where journal debits and journal credits meet (c below i) is read as invoices only: where a credit was netted against the other half's invoices by
//     hand, the auditors' figure cannot be told from here (Aashirvad Pipes, Hemkund Classic). On the saved FY26 data this agrees for 122 / 120 / 119 of 125 matched
//     customers against 119 / 114 / 118 for the invoices-only model. Without the two extra reports the invoices-only model above is used.
//
//   CREDITORS (per vendor), from the ledger lines of the party accounts
//     opening = the credit balance on the day before the year began; billed = what the year's transactions added to the vendor's credit
//     (each transaction taken net over all the supplier accounts, so a journal that only moves a balance from one account to another adds nothing)
//     older  = min( max(closing - billed, 0), max(opening, 0) )     (older than one year)
//     lt1    = closing - older                                      (Less than 1 year)
//     The sheet's Billed Amount / Paid Amount are Zoho's own Vendor Balance Summary for the year: the report is read up to the balance sheet date and up to
//     the day before the year began (from the start of the books both times) and the second is taken from the first (`yearBilled`, `yearPaid`).
//     Update-14 (17-Oct-2026): `billed` in the two formulas above is that Billed Amount when the Vendor Balance Summary has the vendor (the ledger's own sum only
//     where it has not). Checked on the signed sheet itself: all 166 vendor lines follow older = min(max(closing - billed, 0), opening) with the signed Billed
//     figure, and Zoho's Billed agrees with the signed one for 165 of 165 vendors - the ledger's sum differed for Bsnl and Rajendra Prasad Gupta (a reclass / debit entry).
//     A vendor of class `retention` (the auditors show its balance as retention money, not as a trade payable: config/party_overrides.fyYY.json - Cyrun-Infra,
//     Gurukripa) is on the sheet with its closing balance but in NO age bucket: lt1 = older = 0, flagged `retention`.
//
// All of this holds at a year end only: the opening balance is then at least a year old and the rest of the year's invoices are 6 to 12 months old.
// For a date inside the year (the dashboard's year-to-date run) nothing is built and the reason is given.
//
// Checked on 16-Oct-2026 against the signed sheets (31-Mar-2026): debtors 114 of 127 customers agree on all three buckets (120 / 115 / 118 per bucket),
// creditors 159 of 164 vendors on both. The few that differ are the auditors' own adjustments or typed figures: they show up as "Differs" on the tab.
// First run on the real connection (16-Oct-2026): Invoiced, Received, older-than-a-year and the creditors agreed as on the saved data; the six-month buckets did not,
// because Sales by Customer sends only sales / sales_with_tax unless its columns are named (fixed in update-13, see zohoData.mjs SALES_COLUMNS).

import { r2 } from './util.mjs';

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const parse = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
  if (!m) throw new Error(`Not a date (YYYY-MM-DD expected): ${s}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
};

export const addDays = (s, n) => { const d = parse(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };

/** Same day n months on (31-Mar-2026 minus 6 months = 30-Sep-2025: a day that does not exist in the month is moved to the month's last day). */
export function addMonths(s, n) {
  const d = parse(s);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return iso(d);
}

/**
 * The dates the ageing is built from.
 *   openDate    the day before the year began (the opening balances are the balances at the end of that day)
 *   windowFrom  first day of the last six months (31-Mar-2026 -> 01-Oct-2025): invoices from that day on are "less than 6 months"
 *   midDate     the day before that (30-Sep-2025): the end of the first half of the year (update-14: the journals of each half are told by the balances on that day)
 * `reason` is set when the date is not a year end: the model does not apply then.
 */
export function ageingDates({ asOf, fyFrom }) {
  const openDate = addDays(fyFrom, -1);
  const windowFrom = addDays(addMonths(asOf, -6), 1);
  const midDate = addDays(windowFrom, -1); // the last day of the first half of the year: 30-Sep-2025
  const reason = asOf >= addMonths(openDate, 12) ? null
    : `The ageing is built at a year end only (the opening balance of ${openDate} must be a year old at ${asOf}); this run is for ${asOf}`;
  return { asOf, openDate, windowFrom, midDate, reason };
}

const money = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
const pagesOf = (input) => (Array.isArray(input) ? input : [input]);
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * The rows of a report answer that carry `idKey` (customer_id / vendor_id), wherever they sit: Zoho sends some reports as a flat list and some as a list
 * with one more list inside it (the Vendor Balance Summary, seen on 16-Oct-2026). A list that has entries but no row with the id is refused instead of being
 * read as "nobody": that would give zeros for everybody without a word.
 */
export function rowsWithId(node, idKey, what) {
  const out = [];
  const walk = (x) => {
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (!x || typeof x !== 'object') return;
    if (x[idKey] !== undefined) { out.push(x); return; }
    for (const [k, v] of Object.entries(x)) if (k !== 'page_context') walk(v);
  };
  walk(node);
  const entries = Array.isArray(node) ? node.length : 0;
  if (entries > 0 && out.length === 0) throw new Error(`${what} has ${entries} entries but none carries ${idKey}`);
  return out;
}

/**
 * Customer Balance Summary (all pages) -> { asOf, byId: { id: { id, name, invoiced, received, closing } } }
 * `invoiced` and `received` are totals since the books began; `closing` is the balance on the date (a credit is negative).
 */
export function normalizeCustomerBalances(input) {
  const byId = {};
  let asOf = null;
  let last = {};
  for (const raw of pagesOf(input)) {
    const root = raw?.data ?? raw;
    const list = root?.customerbalancesummary;
    if (!Array.isArray(list)) throw new Error('Customer Balance Summary response has an unexpected shape (no customerbalancesummary list)');
    for (const c of rowsWithId(list, 'customer_id', 'The customer balance summary')) {
      const id = String(c.customer_id ?? '');
      if (!id) continue;
      const e = byId[id] ?? { id, name: '', invoiced: 0, received: 0, closing: 0 };
      e.name = String(c.customer_name ?? e.name).trim();
      e.invoiced += money(c.invoiced_amount);
      e.received += money(c.amount_received);
      e.closing += money(c.closing_balance);
      byId[id] = e;
    }
    last = root.page_context ?? {};
    asOf = last.as_of_date ?? last.to_date ?? asOf;
  }
  if (last.has_more_page === true) throw new Error('Customer Balance Summary is incomplete: the last page given still says has_more_page');
  return { asOf, byId };
}

/**
 * Sales by Customer (all pages) -> { from, to, byId: { id: { invoices, creditNotes } } }
 * `invoices` is the invoice total with tax, `creditNotes` the credit notes of the same window. Only the NET of the two is used (invoices less credit notes).
 * Found on the first run on the real connection (16-Oct-2026): without `select_columns` Zoho sends `sales` and `sales_with_tax` (= invoices less credit notes,
 * with tax) and no `invoice_amount`: the loader asks for the two amounts by name, and if an answer comes without them the net is read from `sales_with_tax`.
 * An answer with neither is refused (zero for everybody would pass for "no sales").
 */
export function normalizeSalesByCustomer(input) {
  const byId = {};
  let from = null;
  let to = null;
  let last = {};
  for (const raw of pagesOf(input)) {
    const root = raw?.data ?? raw;
    const list = root?.sales;
    if (!Array.isArray(list)) throw new Error('Sales by Customer response has an unexpected shape (no sales list)');
    const rows = rowsWithId(list, 'customer_id', 'The sales by customer report');
    if (rows.length && !rows.some((c) => isNum(c.invoice_amount) || isNum(c.sales_with_tax))) {
      throw new Error('Sales by Customer has neither invoice_amount nor sales_with_tax on its lines (the columns asked for were not given)');
    }
    for (const c of rows) {
      const id = String(c.customer_id ?? '');
      if (!id) continue;
      const e = byId[id] ?? { id, invoices: 0, creditNotes: 0 };
      if (isNum(c.invoice_amount)) { e.invoices += c.invoice_amount; e.creditNotes += money(c.creditnote_amount); } else e.invoices += money(c.sales_with_tax);
      byId[id] = e;
    }
    last = root.page_context ?? {};
    from = last.from_date ?? from;
    to = last.to_date ?? to;
  }
  if (last.has_more_page === true) throw new Error('Sales by Customer is incomplete: the last page given still says has_more_page');
  return { from, to, byId };
}

/**
 * Vendor Balance Summary (all pages of all requests) -> { asOf, byId: { id: { id, name, billed, paid, closing } } }
 * Seen on the real connection on 16-Oct-2026: the vendors are one list inside another list (`vendorbalancesummary: [ { vendorbalancesummary: [...] } ]`), each with
 * `vendor_id`, `billed_amount`, `amount_paid` and `closing_balance`. The amounts run from the start of the books to the date asked (the report's total at 31-Mar-2026
 * is billed - paid = closing), so a year is the difference of two dates. A vendor that the report does not list has done nothing: zero.
 */
export function normalizeVendorBalances(input) {
  const byId = {};
  let asOf = null;
  for (const raw of pagesOf(input)) {
    const root = raw?.data ?? raw;
    const list = root?.vendorbalancesummary;
    if (!Array.isArray(list)) throw new Error('Vendor Balance Summary response has an unexpected shape (no vendorbalancesummary list)');
    const rows = rowsWithId(list, 'vendor_id', 'The vendor balance summary');
    if (rows.length && !rows.every((v) => isNum(v.billed_amount) && isNum(v.amount_paid))) {
      throw new Error('Vendor Balance Summary lines have no billed_amount / amount_paid');
    }
    for (const v of rows) {
      const id = String(v.vendor_id ?? '');
      if (!id) continue;
      const e = byId[id] ?? { id, name: '', billed: 0, paid: 0, closing: 0 };
      e.name = String(v.vendor_name ?? e.name).trim();
      e.billed += v.billed_amount;
      e.paid += v.amount_paid;
      e.closing += money(v.closing_balance);
      byId[id] = e;
    }
    const pc = root.page_context ?? {};
    asOf = pc.as_of_date ?? pc.to_date ?? asOf;
  }
  return { asOf, byId };
}

/**
 * Debtors ageing, customer by customer.
 * @param {{id:string,name:string,receivable:number}[]} customers   snapshot.receivables.customers (the receivable after the hand-netting)
 * @param {{now:object, open:object, window:object, mid?:object|null, early?:object|null}} z   the normalized reports: balances at the date, balances at the opening day,
 *        last six months' sales (`window`) and - update-14 - the balances at the end of the first half (`mid`) and the sales of the first half (`early`); with
 *        both of the last two the debits are aged by their dates, journals included (see the top of this file), without them invoices only
 * @returns {{customers:object[], missing:object[], totals:object, journals:boolean}}
 */
export function debtorsAgeing(customers, { now, open, window, mid = null, early = null }) {
  const gross = Boolean(mid && early);
  const net = (w) => (w ? (w.invoices ?? 0) - (w.creditNotes ?? 0) : 0);
  const out = [];
  const missing = [];
  const t = { closing: 0, lt6: 0, m6_12: 0, older: 0 };
  for (const c of customers) {
    const closing = Math.max(money(c.receivable), 0);
    if (closing < 0.005) continue; // nothing receivable: not on the ageing
    const n = now.byId[c.id];
    if (!n) { missing.push({ id: c.id, name: c.name, receivable: r2(closing) }); continue; }
    const ob = open.byId[c.id]?.closing ?? 0;
    const invoiced = n.invoiced - Math.max(ob, 0);
    const received = n.received - Math.max(-ob, 0);
    const w = window.byId[c.id];
    let older;
    let sixMonths;
    if (gross) {
      // the debits of each half: invoices less credit notes, or - where the balance summary shows more - invoices and journal debits (see the top of this file)
      const iOpen = open.byId[c.id]?.invoiced ?? 0;
      const iMid = mid.byId[c.id]?.invoiced ?? iOpen;
      const d1 = Math.max(net(early.byId[c.id]), iMid - iOpen, 0);
      const d2 = Math.max(net(w), n.invoiced - iMid, 0);
      older = Math.min(Math.max(closing - (d1 + d2), 0), Math.max(ob, 0));
      sixMonths = d2;
    } else {
      // credit notes can outweigh a year's invoices (invoiced < 0): then nothing of the year is left to age, and the opening balance carries the closing balance
      const yearInvoices = Math.max(invoiced, 0);
      sixMonths = Math.max(Math.min(net(w), yearInvoices), 0);
      older = Math.min(Math.max(closing - yearInvoices, 0), Math.max(ob, 0));
    }
    const rest = closing - older;
    const lt6 = Math.max(Math.min(rest, sixMonths), 0);
    const m6_12 = rest - lt6;
    out.push({ id: c.id, opening: r2(ob), invoiced: r2(invoiced), received: r2(received), lt6: r2(lt6), m6_12: r2(m6_12), older: r2(older) });
    t.closing += closing; t.lt6 += lt6; t.m6_12 += m6_12; t.older += older;
  }
  return { customers: out, missing, totals: { closing: r2(t.closing), lt6: r2(t.lt6), m6_12: r2(t.m6_12), older: r2(t.older) }, journals: gross };
}

/**
 * Creditors ageing, vendor by vendor, from the ledger lines of the party accounts.
 * @param {{contactId:string, date:string, net:number}[]} rows    expanded ledger lines (gl.mjs): net = debit - credit
 * @param {{id:string, amount:number, class:string}[]} parties    snapshot.suppliers.parties
 * @param {Set<string>|string[]} classes                          which classes are the sheet's vendors (trade_payable, trade_payable_msme, retention)
 * @param {string} openDate                                       the day before the year began
 * @param {{now:object, open:object}|null} [vbs]                  the Vendor Balance Summary at the balance sheet date and at `openDate` (normalizeVendorBalances); gives yearBilled / yearPaid
 */
export function creditorsAgeing(rows, parties, classes, openDate, vbs = null) {
  const want = new Set(classes);
  const ids = new Set(parties.filter((p) => want.has(p.class)).map((p) => p.id));
  const opening = new Map();
  const yearTxn = new Map(); // vendor|transaction -> net credit of that transaction over all the party accounts
  rows.forEach((r, i) => {
    const id = String(r.contactId);
    if (!ids.has(id)) return;
    if (r.date <= openDate) { opening.set(id, (opening.get(id) ?? 0) - r.net); return; }
    // a journal that only moves a balance from one supplier account to another (credit in one, debit in the other) is no new billing: transactions are taken net
    const k = `${id}|${r.txnId || `#${i}`}`;
    yearTxn.set(k, (yearTxn.get(k) ?? 0) - r.net);
  });
  const billed = new Map();
  for (const [k, credit] of yearTxn) {
    if (credit <= 0) continue;
    const id = k.slice(0, k.indexOf('|'));
    billed.set(id, (billed.get(id) ?? 0) + credit);
  }
  const vendors = [];
  const t = { closing: 0, lt1: 0, older: 0, yearBilled: 0, yearPaid: 0 };
  for (const p of parties) {
    if (!ids.has(p.id)) continue;
    const closing = Math.abs(p.amount);
    const ob = opening.get(p.id) ?? 0;
    const a = vbs?.now.byId[p.id];
    const b = vbs?.open.byId[p.id];
    const inVbs = Boolean(a || b); // Zoho's own Billed Amount for the year, where the Vendor Balance Summary has the vendor
    const yearBilled = inVbs ? r2((a?.billed ?? 0) - (b?.billed ?? 0)) : null;
    const bill = yearBilled ?? billed.get(p.id) ?? 0;
    const retention = p.class === 'retention';
    const older = retention ? 0 : Math.min(Math.max(closing - bill, 0), Math.max(ob, 0));
    const lt1 = retention ? 0 : closing - older;
    const v = { id: p.id, opening: r2(ob), billed: r2(bill), lt1: r2(lt1), older: r2(older) };
    if (retention) v.retention = true;
    if (inVbs) {
      v.yearBilled = yearBilled;
      v.yearPaid = r2((a?.paid ?? 0) - (b?.paid ?? 0));
      t.yearBilled += v.yearBilled; t.yearPaid += v.yearPaid;
    }
    vendors.push(v);
    t.closing += closing; t.lt1 += lt1; t.older += older;
  }
  const totals = { closing: r2(t.closing), lt1: r2(t.lt1), older: r2(t.older) };
  if (vbs) { totals.yearBilled = r2(t.yearBilled); totals.yearPaid = r2(t.yearPaid); }
  return { vendors, totals };
}
