// Related parties (update-27): Note 28(A) (xii) and the RPT Transaction sheet, checked against Zoho Books figure by figure.
//
// Both sheets hold the same facts in two layouts - the RPT sheet party by party, the note nature by nature - so one list of CHECKS (config/related.fyYY.json) serves both: each check
// names the Zoho figure and, for each sheet, the cells of that sheet that must add up to it. Where Zoho can give the figure it is read like this:
//
//   sales:<contact>       Sales by Customer (the year, before GST, net of credit notes)
//   purch:<contact>       the vendor's own ledger: its bills and vendor credits of the year, before GST, on the accounts that are purchases (fixed assets, stock, cost of goods, expenses)
//   cust:<contact>        the customer's receivable on the balance-sheet date (the dashboard's own receivables list)
//   sup:<contact>:cr|dr   the vendor card's balance in the dashboard's supplier list, as a payable (cr) or as a receivable (dr)
//   acct:<account>        the closing balance of a ledger account of the Trial Balance
//   loan.given|back|net:<loan>   the year's bank entries on the OLD ledger account of a loan (the clean-up journals of 31-Mar-2026 emptied the new one), journals left out
//   narr.rem:<person>     what the narration of the directors' remuneration journal says that person got
//   fx.amount|rate|local  what the narration of the foreign supplier's exchange journal says (USD 24000@93.86= 2252640)
//   imp.net|given|refunded|spent:<person>   (update-31) the year on the person's imprest account: money handed over, refunds, and expenses booked on the card
//
// Found on the real books on 21-Oct-2026 (see README, update-27): all the sales, the purchases of every vendor but one, the rent, remuneration, CSR, investments and the closing balances
// agree with the signed sheets to the rupee. Cyrun's purchases differ by Rs 1,50,00,015 = two vendor credit notes that Zoho nets and the sheet does not (a typed `setAside`, status Explained).
// The loans' gross flows (Rs 9.4 cr lent, 7.1 cr returned) are not in Zoho at all - its ledger has the net - so that check is made on the net.
//
// Two layers, both pure:
//   READ    (at refresh)  normalise what Zoho sent into snapshot.related           buildRelatedSection()
//   CHECK   (on the page) compare it with the cells of a sheet                      buildRelatedChecks()

import { normName } from './overlay.mjs';
import { num, r2, inr } from './util.mjs';

export const RELATED_TOLERANCE = 10; // rupees: the auditors' sheets are rounded line by line (the same allowance as the totals of the other signed workings)
export const RELATED_SCHEMA = 1;

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const rupees = (x) => `₹${inr(Math.round(Math.abs(x)))}`;

/* ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ */
/* READ: what Zoho sent -> snapshot.related                                                                                                                                              */
/* ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ */

/**
 * General Ledger Details pages -> flat lines { contactId, contactName, accountId, accountName, accountType, type, entry, date, details, debit, credit }.
 * Same completeness checks as lib/gl.mjs (every page read, the row count equals the report's own). A line merged from several contacts (comma-joined ids) is kept with that id:
 * it cannot be told to one contact, and the readers leave it out.
 */
export function normalizeContactLedger(pages) {
  const list = Array.isArray(pages) ? pages : [pages];
  if (!list.length) throw new Error('Ledger: no pages given');
  const rows = [];
  let total = null;
  let last = null;
  for (const p of list) {
    const root = p?.data ?? p;
    const groups = root?.account_transactions;
    if (!Array.isArray(groups)) throw new Error('Ledger response has an unexpected shape (no account_transactions)');
    for (const g of groups) {
      for (const r of g.account_transactions ?? []) {
        rows.push({
          contactId: String(r.contact_id ?? '').trim(),
          contactName: String(r.contact_name ?? '').trim(),
          accountId: String(r.account_id ?? g.group_name ?? ''),
          accountName: r.account_name ?? '',
          accountType: r.account?.account_type ?? null,
          type: r.transaction_type ?? '',
          entry: r.entity_number ?? '',
          date: r.date ?? '',
          details: String(r.transaction_details ?? ''),
          debit: num(r.debit),
          credit: num(r.credit),
        });
      }
    }
    const pc = root.page_context ?? {};
    total = pc.total ?? total;
    last = pc;
  }
  if (last?.has_more_page === true) throw new Error('Ledger is incomplete: the last page given still says has_more_page');
  if (total !== null && rows.length !== total) throw new Error(`Ledger is incomplete: the report says ${total} rows but ${rows.length} were read (a page is missing?)`);
  return rows;
}

/** Sales by Customer pages -> { customer id: { name, value } } (the year's sales before GST, net of credit notes). */
export function normalizeRelatedSales(pages) {
  const list = Array.isArray(pages) ? pages : [pages];
  const out = {};
  for (const p of list) {
    const root = p?.data ?? p;
    if (!Array.isArray(root?.sales)) throw new Error('Sales by Customer response has an unexpected shape (no sales list)');
    for (const c of root.sales) {
      const id = String(c.customer_id ?? '').trim();
      if (!id) continue;
      if (typeof c.sales !== 'number') throw new Error(`Sales by Customer has no "sales" (the figure before GST) for "${c.customer_name ?? id}"`);
      out[id] = { name: String(c.customer_name ?? id).trim(), value: r2((out[id]?.value ?? 0) + c.sales) };
    }
  }
  return out;
}

/**
 * The purchases of each vendor from its ledger lines: the lines of the configured transaction types (bills, vendor credits) on the configured account types (fixed assets, stock, cost of goods,
 * expenses) - debit less credit, so a vendor credit is taken off. `capital` (fixed assets), `stock` and `expense` are shown separately for the reader. `setAside` (typed in the config) adds up the
 * lines of a named account that Zoho nets and the signed sheet does not, with their entry numbers.
 * @returns {{ [contactId]: {name, net, lines, capital, stock, expense, setAside: {label, value, rows[]}|null} }}
 */
export function buildPurchases(rows, p) {
  const types = new Set(p.types);
  const kinds = new Set(p.accountTypes);
  const aside = (p.setAside ?? []).map((a) => ({ ...a, types: new Set(a.types ?? p.types), accounts: new Set((a.accounts ?? []).map(normName)), ids: a.ids ? new Set(a.ids.map(String)) : null }));
  if (rows.some((r) => types.has(r.type) && r.accountType === null)) throw new Error('Zoho sent ledger lines without their account type, so purchases cannot be told from payables and GST');
  const out = {};
  for (const r of rows) {
    if (!types.has(r.type) || !kinds.has(r.accountType) || r.contactId.includes(',') || !r.contactId) continue;
    const v = r.debit - r.credit;
    const e = (out[r.contactId] ??= { name: r.contactName, net: 0, lines: 0, capital: 0, stock: 0, expense: 0, setAside: null });
    e.net += v; e.lines += 1;
    if (r.accountType === 'fixed_asset') e.capital += v; else if (r.accountType === 'stock') e.stock += v; else e.expense += v;
    for (const a of aside) {
      if (!a.types.has(r.type) || !a.accounts.has(normName(r.accountName)) || (a.ids && !a.ids.has(r.contactId))) continue;
      e.setAside ??= { label: a.label, value: 0, rows: [] };
      e.setAside.value += v;
      e.setAside.rows.push({ entry: r.entry, account: r.accountName, amount: r2(v), date: r.date });
    }
  }
  for (const e of Object.values(out)) {
    for (const k of ['net', 'capital', 'stock', 'expense']) e[k] = r2(e[k]);
    if (e.setAside) e.setAside.value = r2(e.setAside.value);
  }
  return out;
}

const parseAmount = (s) => Number(String(s).replace(/[, ]/g, ''));

/**
 * "... transferred from salary of Rahul Gupta & Nidhi Gupta Rs. 60,29,032 & 43,06,451 respectively." -> [{ name, amount }], or null when the text is not that or the parts do not add up
 * to the journal line (the narration is the only place Zoho has the person by person split: the journal is posted to the account without a contact).
 */
export function parseRemuneration(text, pattern, lineAmount) {
  const m = new RegExp(pattern, 'i').exec(String(text));
  if (!m) return null;
  const names = m[1].split('&').map((x) => x.trim()).filter(Boolean);
  const amounts = m[2].split('&').map(parseAmount);
  if (!names.length || names.length !== amounts.length || amounts.some((a) => !Number.isFinite(a))) return null;
  if (Math.abs(amounts.reduce((t, a) => t + a, 0) - lineAmount) > 1) return null;
  return names.map((name, i) => ({ name, amount: amounts[i] }));
}

/** "Being Exchange Gain Loss Booked on USD 24000@93.86= 2252640." -> { currency, amount, rate, local } or null (the amount times the rate must give the figure). */
export function parseExposure(text, pattern) {
  const m = new RegExp(pattern, 'i').exec(String(text));
  if (!m) return null;
  const [currency, amount, rate, local] = [m[1].toUpperCase(), parseAmount(m[2]), parseAmount(m[3]), parseAmount(m[4])];
  if (![amount, rate, local].every(Number.isFinite) || Math.abs(amount * rate - local) > 1) return null;
  return { currency, amount, rate, local };
}

/**
 * The account ledgers of the year -> the loans (bank entries of each OLD loan account: given = debits, back = credits, journals left out and listed), the directors' remuneration split by person
 * (from the narration of the journal) and the unhedged foreign-currency payable (from the narration of the exchange journal). A narration that cannot be read is `null`, not an error.
 */
export function buildLedgers(rows, spec) {
  const loans = {};
  for (const [key, l] of Object.entries(spec.ledgers?.loans ?? {})) {
    const skip = new Set(spec.ledgers.loanSkipTypes ?? ['journal']);
    const mine = rows.filter((r) => r.accountId === String(l.account));
    const flow = mine.filter((r) => !skip.has(r.type));
    const other = mine.filter((r) => skip.has(r.type));
    const given = flow.reduce((t, r) => t + r.debit, 0);
    const back = flow.reduce((t, r) => t + r.credit, 0);
    loans[key] = {
      name: l.name, account: String(l.account), given: r2(given), back: r2(back), net: r2(given - back), lines: flow.length,
      journals: { debit: r2(other.reduce((t, r) => t + r.debit, 0)), credit: r2(other.reduce((t, r) => t + r.credit, 0)), entries: other.map((r) => r.entry).filter(Boolean) },
    };
  }

  let remuneration = null;
  const rem = spec.ledgers?.remuneration;
  if (rem) {
    const parts = new Map();
    const entries = [];
    for (const r of rows.filter((x) => x.accountId === String(rem.account) && x.debit > 0)) {
      const got = parseRemuneration(r.details, rem.pattern, r.debit - r.credit);
      if (!got) continue;
      entries.push(r.entry);
      for (const g of got) { const k = normName(g.name); parts.set(k, { name: g.name, amount: r2((parts.get(k)?.amount ?? 0) + g.amount) }); }
    }
    if (entries.length) remuneration = { entries, parts: Object.fromEntries(parts) };
  }

  let exposure = null;
  const fx = spec.ledgers?.exposure;
  if (fx) {
    const found = new Map();
    for (const r of rows.filter((x) => x.accountId === String(fx.account))) {
      const got = parseExposure(r.details, fx.pattern);
      if (got) found.set(JSON.stringify(got), { ...got, entry: r.entry });
    }
    if (found.size === 1) exposure = [...found.values()][0]; // the same words on three journals: one figure. Two different figures: not read (the sheet cannot be told which is meant)
    else if (found.size > 1) exposure = { ambiguous: [...found.values()] };
  }
  return { loans, remuneration, exposure };
}

const money = (s) => {
  const t = String(s ?? '').replace(/[,\s]/g, '');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/**
 * update-31: the opening and the closing balance of each account of the ledger pages, as Zoho states them (credit-positive: what the company owes). Zoho gives them once per account, above the lines
 * ("As On 01/04/2025 ... 72,084.54"). `null` where the response does not carry them (the readers then work from the lines alone and say so).
 * @returns {{ [accountId]: { opening: number|null, closing: number|null } }}
 */
export function readGroupBalances(pages) {
  const out = {};
  for (const p of Array.isArray(pages) ? pages : [pages]) {
    const root = p?.data ?? p;
    for (const g of root?.account_transactions ?? []) {
      const id = String(g.group_name ?? g.account_transactions?.[0]?.account_id ?? '');
      if (!id) continue;
      const side = (b) => {
        if (!b || typeof b !== 'object') return null;
        const credit = money(b.credit);
        const debit = money(b.debit);
        if (credit === null && debit === null) return typeof b.account_credit_balance === 'number' ? b.account_credit_balance : null;
        return (credit ?? 0) - (debit ?? 0);
      };
      const o = side(g.opening_balance);
      const c = side(g.closing_balance);
      out[id] ??= { opening: null, closing: null };
      if (out[id].opening === null) out[id].opening = o;
      if (c !== null) out[id].closing = c;
    }
  }
  return out;
}

/**
 * update-31: the year on the imprest account of each person (config `ledgers.imprest`), from the account ledger. The account is a liability account: what is booked on it as an expense is what
 * the company owes the person, money handed over to him (debit) takes it down, a refund by him (type `expense_refund`) puts it back. The journal of 31-Mar-2026 that moved the balance to
 * Sundry Creditors - Employees (narration "Transfering ledger balance from old to new ledger") is left out of the flows and shown on its own, so the account ends at nil.
 *   given      = money handed over in the year (debits, the transfer left out)
 *   refunded   = money he gave back
 *   net        = given - refunded
 *   spent      = expenses and journals booked on his card (credits, the refunds left out)
 *   transferred= the transfer journal
 * opening + spent + refunded - given - transferred must equal Zoho's own closing balance: otherwise nothing is relied on (the read fails, the checks say "not checked").
 */
export function buildImprest(rows, balances, spec) {
  const im = spec.ledgers?.imprest;
  if (!im) return null;
  const transfer = new RegExp(im.transfer ?? 'transfering ledger balance', 'i');
  const refundTypes = new Set(im.refundTypes ?? ['expense_refund']);
  const people = {};
  for (const [key, p] of Object.entries(im.people ?? {})) {
    const account = String(p.account);
    const mine = rows.filter((r) => r.accountId === account);
    const bal = balances?.[account] ?? { opening: null, closing: null };
    let given = 0; let refunded = 0; let spent = 0; let transferred = 0; let spentLines = 0;
    const payments = [];
    const transferEntries = [];
    for (const r of mine) {
      if (transfer.test(r.details)) { transferred += r.debit - r.credit; if (r.entry) transferEntries.push(r.entry); continue; }
      if (refundTypes.has(r.type)) { refunded += r.credit - r.debit; payments.push({ date: r.date, entry: r.entry, kind: 'refunded', amount: r2(r.credit - r.debit), via: r.details }); continue; }
      given += r.debit;
      spent += r.credit;
      if (r.credit > 0) spentLines += 1;
      if (r.debit > 0) payments.push({ date: r.date, entry: r.entry, kind: 'paid', amount: r2(r.debit), via: r.details });
    }
    const worked = bal.opening === null ? null : bal.opening + spent + refunded - given - transferred;
    if (worked !== null && bal.closing !== null && Math.abs(worked - bal.closing) > 1) {
      throw new Error(`the imprest account of ${p.name} does not add up: Zoho's opening ${r2(bal.opening)} and the year's lines give ${r2(worked)}, Zoho's own closing is ${r2(bal.closing)}`);
    }
    people[key] = {
      name: p.name, account, lines: mine.length,
      opening: bal.opening === null ? null : r2(bal.opening),
      given: r2(given), refunded: r2(refunded), net: r2(given - refunded), spent: r2(spent), spentLines,
      transferred: r2(transferred), transferEntries,
      closing: bal.closing === null ? (worked === null ? null : r2(worked)) : r2(bal.closing),
      payments,
    };
  }
  return { people };
}

/**
 * The `related` section of the snapshot. Each of `sales`, `purchases`, `ledgers` is the raw pages Zoho sent, `{ error }` (the read failed - a detail layer, so the statements are still
 * built) or null (not asked for). A layer that cannot be used becomes { error } and an alert says so; the checks that need it are then shown as "not checked".
 */
export function buildRelatedSection({ spec, sales, purchases, ledgers, from, to, alerts = [] }) {
  const layer = (name, raw, make) => {
    if (raw === null || raw === undefined) return { error: 'not asked for' };
    if (raw.error) {
      alerts.push({ level: 'warn', code: 'RELATED_UNAVAILABLE', message: `The ${name} of the related parties could not be read from Zoho (${raw.error.message ?? raw.error}); those checks on Note 28(A) and RPT Transaction are not made` });
      return { error: raw.error.message ?? String(raw.error) };
    }
    try { return make(raw); } catch (e) {
      alerts.push({ level: 'warn', code: 'RELATED_UNAVAILABLE', message: `The ${name} of the related parties could not be used (${e.message}); those checks on Note 28(A) and RPT Transaction are not made` });
      return { error: e.message };
    }
  };
  return {
    schema: RELATED_SCHEMA, from, to,
    sales: layer('sales', sales, (pages) => ({ contacts: normalizeRelatedSales(pages) })),
    purchases: layer('purchases', purchases, (pages) => {
      const rows = normalizeContactLedger(pages);
      const setAside = (spec.purchases.setAside ?? []).map((a) => ({ ...a, ids: a.contacts ? a.contacts.map((k) => { const c = spec.contacts?.[k]; if (!c?.id) throw new Error(`the contact "${k}" of setAside is not in config/related`); return String(c.id); }) : undefined }));
      return { lines: rows.length, contacts: buildPurchases(rows, { ...spec.purchases, setAside }) };
    }),
    ledgers: layer('loan, remuneration and foreign-currency ledgers', ledgers, (pages) => {
      const rows = normalizeContactLedger(pages);
      const wanted = new Set([...Object.values(spec.ledgers?.loans ?? {}).map((l) => String(l.account)), String(spec.ledgers?.remuneration?.account), String(spec.ledgers?.exposure?.account), ...imprestAccounts(spec)]);
      const stray = rows.find((r) => !wanted.has(r.accountId));
      if (stray) throw new Error(`a line of another account came back ("${stray.accountName}") - the account filter was ignored`);
      const out = { lines: rows.length, ...buildLedgers(rows, spec) };
      if (spec.ledgers?.imprest) { // update-31: its own detail: if the imprest accounts cannot be used, the loans, the remuneration and the foreign-currency payable still are
        try { out.imprest = buildImprest(rows, readGroupBalances(pages), spec); } catch (e) {
          out.imprest = { error: e.message };
          alerts.push({ level: 'warn', code: 'RELATED_UNAVAILABLE', message: `The imprest accounts of the directors could not be used (${e.message}); the imprest of the year is not compared with the RPT Transaction sheet` });
        }
      }
      return out;
    }),
  };
}

/** update-31: the accounts of the imprest cards of the people named in config `ledgers.imprest`. */
const imprestAccounts = (spec) => Object.values(spec.ledgers?.imprest?.people ?? {}).map((p) => String(p.account));

/** The contact ids a refresh must read, from the config: [customers for sales, vendors for purchases, accounts for the ledgers]. */
export function relatedRequests(spec) {
  const id = (k) => {
    const c = spec.contacts?.[k];
    if (!c?.id) throw new Error(`related.${spec.fy ?? ''}.json: the contact "${k}" has no id`);
    return String(c.id);
  };
  return {
    salesIds: [...new Set((spec.sales?.contacts ?? []).map(id))],
    purchaseIds: [...new Set((spec.purchases?.contacts ?? []).map(id))],
    accountIds: [...new Set([...Object.values(spec.ledgers?.loans ?? {}).map((l) => String(l.account)), spec.ledgers?.remuneration?.account, spec.ledgers?.exposure?.account, ...imprestAccounts(spec)].filter(Boolean).map(String))],
  };
}

/* ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ */
/* CHECK: snapshot.related + the dashboard's own lists  <->  the cells of a sheet                                                                                                  */
/* ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ */

const NOT_IN_SNAPSHOT = 'The related-party figures are not in this snapshot (an older copy): refresh the data';

/**
 * A reading of Zoho, by reference ("sales:soltown", "sup:cyrun:cr" ...). -> { value, absent?, setAside?, label } or { unavailable: why }.
 * `absent` = Zoho has no line for that contact (a customer with nothing in the list has nothing owing): the value is 0 and the check says so.
 */
export function readRef(snapshot, spec, ref) {
  const [kind, arg = '', dir = ''] = String(ref).split(':');
  const contact = (k) => {
    const c = spec.contacts?.[k];
    if (!c?.id) throw new Error(`the contact "${k}" is not in config/related (reference "${ref}")`);
    return { id: String(c.id), name: c.name ?? k };
  };
  const rel = snapshot.related;
  const layer = (name) => {
    if (!rel) return { unavailable: NOT_IN_SNAPSHOT };
    const l = rel[name];
    if (!l || l.error) return { unavailable: `Zoho's ${name === 'ledgers' ? 'account ledgers' : name} could not be read for this snapshot (${l?.error ?? 'missing'})` };
    return { layer: l };
  };

  switch (kind) {
    case 'cust': {
      const list = snapshot.receivables?.customers;
      if (!Array.isArray(list)) return { unavailable: "The dashboard's receivables list is not in this snapshot" };
      const { id, name } = contact(arg);
      const c = list.find((x) => String(x.id) === id);
      return c ? { value: c.receivable, label: `${name}: receivable` } : { value: 0, absent: true, label: `${name}: nothing receivable` };
    }
    case 'sup': {
      const list = snapshot.suppliers?.parties;
      if (!Array.isArray(list)) return { unavailable: "The dashboard's supplier list is not in this snapshot" };
      const { id, name } = contact(arg);
      const p = list.find((x) => String(x.id) === id);
      if (!p) return { value: 0, absent: true, label: `${name}: no balance` };
      return { value: dir === 'cr' ? -p.net : p.net, label: `${name}: ${dir === 'cr' ? 'payable' : 'receivable'}` };
    }
    case 'acct': {
      const a = spec.accounts?.[arg];
      if (!a?.id) throw new Error(`the account "${arg}" is not in config/related (reference "${ref}")`);
      for (const b of Object.values(snapshot.buckets ?? {})) {
        const hit = (b.accounts ?? []).find((x) => String(x.id) === String(a.id));
        if (hit) return { value: Math.abs(hit.closing), label: a.name ?? hit.name };
      }
      return { value: 0, absent: true, label: `${a.name ?? arg}: no balance in the Trial Balance` };
    }
    case 'sales': {
      const { layer: l, unavailable } = layer('sales');
      if (unavailable) return { unavailable };
      const { id, name } = contact(arg);
      const c = l.contacts[id];
      return c ? { value: c.value, label: `${name}: sales` } : { value: 0, absent: true, label: `${name}: no sales` };
    }
    case 'purch': {
      const { layer: l, unavailable } = layer('purchases');
      if (unavailable) return { unavailable };
      const { id, name } = contact(arg);
      const c = l.contacts[id];
      return c ? { value: c.net, setAside: c.setAside, detail: { capital: c.capital, stock: c.stock, expense: c.expense, lines: c.lines }, label: `${name}: purchases` } : { value: 0, absent: true, label: `${name}: no purchases` };
    }
    default: break;
  }
  if (kind.startsWith('loan.')) {
    const { layer: l, unavailable } = layer('ledgers');
    if (unavailable) return { unavailable };
    const x = l.loans?.[arg];
    if (!x) return { unavailable: `The loan "${arg}" is not in the ledgers of this snapshot` };
    return { value: x[kind.slice(5)], label: `${x.name}: loan ${kind.slice(5)}` };
  }
  if (kind === 'narr.rem') {
    const { layer: l, unavailable } = layer('ledgers');
    if (unavailable) return { unavailable };
    if (!l.remuneration) return { unavailable: "The narration of the directors' remuneration journal could not be read (it no longer says person by person)" };
    const hit = l.remuneration.parts[normName(arg)];
    return hit ? { value: hit.amount, label: `${hit.name}: remuneration (narration of ${l.remuneration.entries.join(', ')})` } : { value: 0, absent: true, label: `${arg}: not named in the remuneration journal` };
  }
  if (kind.startsWith('subs.')) { // update-28: what a subsidiary's OWN books say (subs.loan:om = the loan from the company in the books of Rays O&M Experts)
    const sec = snapshot.subsidiaries;
    if (!sec) return { unavailable: "The subsidiaries' own books are not in this snapshot (an older copy): refresh the data" };
    const sub = sec.subs?.[arg];
    if (!sub) return { unavailable: `"${arg}" is not among the subsidiaries of this snapshot` };
    if (!sub.balance || sub.balance.error) return { unavailable: `Zoho did not give the books of ${sub.name} (${sub.balance?.error ?? 'missing'})` };
    if (sub.balance.balanced === false) return { unavailable: `The trial balance of ${sub.name} does not balance in Zoho, so its figures are not relied on` };
    const v = sub.balance[kind.slice(5)];
    if (typeof v !== 'number' || !Number.isFinite(v)) return { unavailable: `The books of ${sub.name} give no figure for "${kind.slice(5)}"` };
    return { value: v, label: `${kind.slice(5) === 'loan' ? 'the loan' : kind.slice(5)} in the own books of ${sub.name}` };
  }
  if (kind.startsWith('imp.')) { // update-31: the year on a person's imprest card (see buildImprest)
    const measure = kind.slice(4);
    if (!['net', 'given', 'refunded', 'spent'].includes(measure)) throw new Error(`unknown reading "${ref}"`);
    const { layer: l, unavailable } = layer('ledgers');
    if (unavailable) return { unavailable };
    const im = l.imprest;
    if (!im || im.error) return { unavailable: `Zoho's imprest accounts could not be used for this snapshot (${im?.error ?? 'an older copy of the data: refresh it'})` };
    const person = im.people?.[arg];
    if (!person) return { unavailable: `"${arg}" is not among the imprest accounts of this snapshot` };
    const first = person.name.split(' ')[0];
    const paid = person.given > 0 ? `${rupees(person.given)} paid to ${first}${person.refunded > 0 ? `, ${rupees(person.refunded)} refunded (net ${rupees(person.net)})` : ''}` : `nothing paid to ${first}`;
    const instruction = spec.ledgers?.imprest?.instruction;
    return {
      value: person[measure],
      label: `${person.name}: imprest ${measure === 'net' ? 'paid in the year, net of refunds' : measure === 'given' ? 'paid in the year' : measure === 'refunded' ? 'refunded in the year' : 'spent in the year'}`,
      // shown when the signed figure is not the one Zoho gives ({signed} is the signed figure)
      explain: `Zoho's imprest ledger of ${person.name} for the year: ${paid}; ${rupees(person.spent)} of expenses booked on the card. The signed {signed} is none of these totals, so it cannot be rebuilt from Zoho.${instruction ? ` A note beside the table on the signed Note 28(A) sheet says: "${instruction}"; the balance of the card is checked under the payables.` : ''}`,
    };
  }
  if (kind.startsWith('fx.')) {
    const { layer: l, unavailable } = layer('ledgers');
    if (unavailable) return { unavailable };
    if (!l.exposure || l.exposure.ambiguous) return { unavailable: l.exposure ? 'The foreign-currency journals state more than one figure' : 'No journal of the foreign supplier account states the foreign-currency payable' };
    const f = l.exposure;
    return { value: f[kind.slice(3)], label: `${f.currency} payable as stated in ${f.entry}` };
  }
  throw new Error(`unknown reading "${ref}"`);
}

/* ---------- finding the cells of a sheet ---------- */

const isNum = (v) => typeof v === 'number';
const asList = (x) => (x === undefined || x === null ? [] : Array.isArray(x) ? x : [x]);

/** Row indexes of the party rows of the RPT sheet: normalised name -> row. */
function rptRows(rows) {
  const by = new Map();
  rows.forEach((r, i) => { if (i > 0 && typeof r[1] === 'string' && !by.has(normName(r[1]))) by.set(normName(r[1]), i); });
  return by;
}

/** Note 28(A): the row of the numbered heading `name` (column 2), and the rows of its parties (up to the next heading). */
function n28Section(rows, name, from = 0) {
  const want = clean(name);
  const at = rows.findIndex((r, i) => i >= from && isNum(r[1]) && clean(r[2]) === want);
  if (at < 0) return null;
  let end = rows.length;
  for (let i = at + 1; i < rows.length; i += 1) {
    const r = rows[i];
    if (isNum(r[1]) || typeof r[0] === 'string' || (typeof r[1] === 'string' && (r[2] === null || r[2] === undefined))) { end = i; break; }
  }
  return { at, end };
}

/**
 * The cells a check names on this sheet -> { cells: [{ r, c, value, sign }], problems[] }.
 * RPT:  { party, cols: [col, ...] | "<colset>", sign? }
 * n28:  { party, col, sections: [heading, ...], sign? }  or  { all: true, col, sections }  (every party under those headings)  or  { after, label, labelCol, col, sign? }
 */
function findCells(side, rows, terms, ctx) {
  const cells = [];
  const problems = [];
  for (const t of asList(terms)) {
    const sign = t.sign ?? 1;
    if (side === 'rpt') {
      const r = ctx.rpt.get(normName(t.party));
      if (r === undefined) { problems.push(`${t.party} is not on the sheet`); continue; }
      const cols = typeof t.cols === 'string' ? ctx.spec.colsets?.[t.cols] : t.cols;
      if (!Array.isArray(cols)) { problems.push(`the column set "${t.cols}" is not in the config`); continue; }
      for (const c of cols) cells.push({ r, c, value: isNum(rows[r][c]) ? rows[r][c] : 0, sign });
    } else if (t.all) {
      for (const name of t.sections ?? []) {
        const s = n28Section(rows, name);
        if (!s) { problems.push(`the heading "${name}" is not on the sheet`); continue; }
        for (let r = s.at + 1; r < s.end; r += 1) {
          if (typeof rows[r][2] === 'string' && rows[r][2].trim()) cells.push({ r, c: t.col, value: isNum(rows[r][t.col]) ? rows[r][t.col] : 0, sign });
        }
      }
      if (!cells.length && !problems.length) problems.push(`there are no parties under ${(t.sections ?? []).join(' / ')}`);
    } else if (t.after) {
      const from = rows.findIndex((row) => row.some((x) => typeof x === 'string' && clean(x).startsWith(clean(t.after))));
      const r = from < 0 ? -1 : rows.findIndex((row, i) => i > from && clean(row[t.labelCol ?? 1]) === clean(t.label));
      if (r < 0) { problems.push(`"${t.label}" under "${t.after}" is not on the sheet`); continue; }
      cells.push({ r, c: t.col, value: isNum(rows[r][t.col]) ? rows[r][t.col] : 0, sign });
    } else {
      let found = 0;
      for (const name of t.sections ?? []) {
        const s = n28Section(rows, name);
        if (!s) { problems.push(`the heading "${name}" is not on the sheet`); continue; }
        for (let r = s.at + 1; r < s.end; r += 1) {
          if (normName(rows[r][2]) === normName(t.party)) { cells.push({ r, c: t.col, value: isNum(rows[r][t.col]) ? rows[r][t.col] : 0, sign }); found += 1; }
        }
      }
      if (!found && !problems.length) problems.push(`${t.party} is not under ${(t.sections ?? []).join(' / ')}`);
    }
  }
  return { cells, problems };
}

/**
 * @param {{snapshot:object, spec:object, rows:any[][], side:'rpt'|'n28'}} p
 * @returns {{checks:object[], marks:Object<string,object>, groups:object[], stays:string[], problems:string[], summary:{lines,ok,expl,diff,none}}}
 *   check: { id, group, title, signed, zoho, diff, status: OK|EXPL|DIFF|NONE, why?, text?, note?, cells[{r,c}], terms[{label, value, absent?}] }
 *   marks: "row:col" -> { status, check, signed, zoho, diff, together, first }
 */
export function buildRelatedChecks({ snapshot, spec, rows, side }) {
  const problems = [];
  const tol0 = spec.tolerance ?? RELATED_TOLERANCE;
  const ctx = { spec, rpt: side === 'rpt' ? rptRows(rows) : null };

  // the headers the configuration expects on the RPT sheet: a column that is not what the config thinks stops the checks that use it
  const badCols = new Set();
  if (side === 'rpt') {
    for (const [col, want] of Object.entries(spec.headers ?? {})) {
      if (!clean(rows[0]?.[Number(col)]).startsWith(clean(want))) { badCols.add(Number(col)); problems.push(`Column ${col} of RPT Transaction is "${rows[0]?.[Number(col)] ?? ''}", the configuration expects "${want}": its checks are not made`); }
    }
  }

  const seen = new Set();
  const checks = [];
  const marks = {};
  for (const def of spec.checks ?? []) {
    if (seen.has(def.id)) { problems.push(`The check "${def.id}" is listed twice`); continue; }
    seen.add(def.id);
    const terms = def[side];
    if (!terms) continue; // this check belongs to the other sheet only
    const base = { id: def.id, group: def.group, title: def.title, note: def.note ?? null };
    const found = findCells(side, rows, terms, ctx);
    if (found.problems.length) problems.push(`${def.id}: ${found.problems.join('; ')}`);
    if (found.cells.some((c) => badCols.has(c.c)) || found.problems.length || !found.cells.length) {
      checks.push({ ...base, signed: null, zoho: null, diff: null, status: 'NONE', why: found.problems.length ? `The sheet does not have it where the check looks (${found.problems.join('; ')})` : 'The columns of the sheet are not as the check expects', cells: found.cells.map(({ r, c }) => ({ r, c })), terms: [] });
      continue;
    }
    const signed = found.cells.reduce((t, c) => t + c.sign * c.value, 0);

    // what Zoho says
    const zterms = [];
    let unavailable = null;
    for (const z of asList(def.zoho)) {
      const ref = typeof z === 'string' ? z : z.ref;
      const sign = typeof z === 'string' ? 1 : (z.sign ?? 1);
      let got;
      try { got = readRef(snapshot, spec, ref); } catch (e) { problems.push(`${def.id}: ${e.message}`); got = { unavailable: e.message }; }
      if (got.unavailable) { unavailable = got.unavailable; break; }
      zterms.push({ ...got, sign, ref });
    }
    const cells = found.cells.map(({ r, c }) => ({ r, c }));
    if (unavailable) {
      checks.push({ ...base, signed: r2(signed), zoho: null, diff: null, status: 'NONE', why: unavailable, cells, terms: [] });
      continue;
    }
    const zoho = zterms.reduce((t, z) => t + z.sign * z.value, 0);
    const diff = zoho - signed;
    const tol = def.tol ?? tol0;
    let status = Math.abs(diff) <= tol ? 'OK' : 'DIFF';
    let text = null;
    // Explained: the difference is exactly the lines that Zoho nets and the signed sheet does not (a typed `setAside` of the purchases reading)
    const aside = zterms.find((z) => z.setAside)?.setAside;
    if (status === 'DIFF' && aside && Math.abs(signed - (zoho - aside.value)) <= tol) {
      status = 'EXPL';
      const entries = aside.rows.map((x) => `${x.entry} ${rupees(x.amount)}`).join(', ');
      const away = Math.abs(signed - (zoho - aside.value));
      text = `Zoho nets ${aside.label} (${entries}) against these purchases, ${rupees(aside.value)} in all, and the signed sheet does not. Before them Zoho gives ${rupees(zoho - aside.value)}, which ${away < 0.5 ? 'agrees with the sheet' : `is ${rupees(away)} from the sheet (the sheet is rounded line by line)`}.`;
    }
    const absent = zterms.filter((z) => z.absent).map((z) => z.label);
    if (status === 'DIFF' && absent.length) text = `${absent.join('; ')} in Zoho.`;
    const explain = zterms.find((z) => z.explain)?.explain; // update-31: a reading that knows why the signed figure cannot be rebuilt from it says so
    if (status === 'DIFF' && explain) text = explain.replace('{signed}', rupees(signed));
    checks.push({ ...base, signed: r2(signed), zoho: r2(zoho), diff: r2(diff), status, text, cells, terms: zterms.map((z) => ({ label: z.label, value: r2(z.value), sign: z.sign, absent: z.absent || undefined, detail: z.detail })) });
    if (def.marks !== false) cells.forEach(({ r, c }, i) => { // a check of a total over cells that other checks mark one by one (marks: false) leaves the cells to those
      marks[`${r}:${c}`] = { status, check: def.id, signed: r2(signed), own: found.cells[i].value, zoho: r2(zoho), diff: r2(diff), together: cells.length > 1, first: i === 0 };
    });
  }

  const groups = (spec.groups ?? []).map((g) => ({ ...g, checks: checks.filter((c) => c.group === g.id) }));
  for (const c of checks) if (!(spec.groups ?? []).some((g) => g.id === c.group)) problems.push(`${c.id}: the group "${c.group}" is not in the config`);
  const count = (s) => checks.filter((c) => c.status === s).length;
  return {
    checks, marks, groups: groups.filter((g) => g.checks.length), problems,
    stays: (spec.stays ?? []).filter((s) => !s.sides || s.sides.includes(side)).map((s) => s.text),
    summary: { lines: checks.length, ok: count('OK'), expl: count('EXPL'), diff: count('DIFF'), none: count('NONE') },
  };
}
