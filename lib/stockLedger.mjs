// What the ledger of a stock account is made of, and what explains the gap between the account and the items booked to it (pure functions: the ledger pages are handed in).
//
// Why. Zoho's stock summary (lib/stock.mjs) values the items one by one; the Trial Balance holds the ledger account. For FY26 they agree for two accounts and not for
// Inventory Asset: ledger 2,62,02,924.62 against items 2,52,88,224.02 = 9,14,700.60. FY26 is audited and closed, so nothing in Zoho can be changed - the dashboard has to
// explain the gap from what Zoho already holds. Read on the real connection (General Ledger Details of the account, 01-Jan-2024 to 31-Mar-2026, 6,504 lines):
//   * the ledger holds NO manual journal: every line is a bill, an invoice, a credit note, a vendor credit, a stock adjustment or a stock transfer between the locations
//     (Head Office, Panchu, Gajner); the lines add up to the Trial Balance to the paisa;
//   * a transfer is posted as two lines with the same transaction id - "out" (credit, at the source location) and "in" (debit, at the destination) - which normally cancel.
//     Six do not: their "out" and "in" values differ (one is nil), and together they add 9,58,533.60 to the ledger;
//   * the rest of the gap, -43,833.00, is not tied to a single document by anything the ledger says; it is shown as "other postings", not guessed at.
//
// The ledger lines are read from Zoho's own answer (the same shape lib/zohoData.mjs fetchLedger checks): groups -> account_transactions[] with
// { date, transaction_type, transaction_id, debit, credit, branch.location_name | transaction_details }.

import { num, r2, inr } from './util.mjs';

/** A rupee: both the ledger and the report are given to the paisa. */
export const STOCK_LEDGER_TOLERANCE = 1;
/** A transfer whose two sides differ by less than this (half a paisa) counts as equal. */
const EQUAL = 0.005;
/** At most this many unequal transfers are kept in the snapshot (the rest is counted and added up). */
export const MAX_UNEQUAL_KEPT = 40;

/** What a Zoho transaction type is called on the page, in the order they are listed. A type not listed keeps its own name. */
const KINDS = [
  { key: 'opening_balance', label: 'Opening balance', types: ['opening_balance'] },
  { key: 'bill', label: 'Bills', types: ['bill'] },
  { key: 'vendor_credit', label: 'Vendor credits', types: ['vendor_credit'] },
  { key: 'invoice', label: 'Invoices', types: ['invoice'] },
  { key: 'creditnote', label: 'Credit notes', types: ['creditnote'] },
  { key: 'adjustment', label: 'Stock adjustments', types: ['inventory_adjustment_by_quantity', 'inventory_adjustment_by_value'] },
  { key: 'transfer', label: 'Stock transfers between locations', types: ['transfer_order_in', 'transfer_order_out', 'transfer_order'] },
  { key: 'bundle', label: 'Bundles / composite items', types: ['bundle'] },
  { key: 'journal', label: 'Manual journals', types: ['journal'] },
];
const kindOf = (type) => KINDS.find((k) => k.types.includes(type)) ?? { key: type, label: type || '(type not given)', types: [type] };

/** The pages of the ledger answer -> flat lines { date, type, txn, debit, credit, location, accountId }. */
export function stockLedgerRows(pages) {
  const rows = [];
  for (const raw of pages ?? []) {
    const root = raw?.data ?? raw ?? {};
    for (const g of root.account_transactions ?? []) {
      for (const r of g.account_transactions ?? []) {
        rows.push({
          date: String(r.date ?? ''),
          type: String(r.transaction_type ?? ''),
          txn: String(r.transaction_id ?? ''),
          debit: num(r.debit),
          credit: num(r.credit),
          location: String(r.branch?.location_name ?? r.transaction_details ?? '').trim(),
          accountId: r.account_id === undefined || r.account_id === null ? null : String(r.account_id),
        });
      }
    }
  }
  return rows;
}

/**
 * The lines of one account -> what they are made of.
 * @returns {{ entries, net, byType[], manual:{count,net}, transfers:{orders, unequalCount, net, unequal[]} }}
 */
export function reduceStockLedger(rows) {
  let net = 0;
  const kinds = new Map();
  const orders = new Map(); // transaction id of a transfer -> its two sides
  for (const r of rows) {
    net += r.debit - r.credit;
    const k = kindOf(r.type);
    const e = kinds.get(k.key) ?? { key: k.key, label: k.label, count: 0, debit: 0, credit: 0 };
    e.count += 1; e.debit += r.debit; e.credit += r.credit;
    kinds.set(k.key, e);
    if (r.type === 'transfer_order_in' || r.type === 'transfer_order_out') {
      const o = orders.get(r.txn) ?? { id: r.txn, out: 0, in: 0, hasOut: false, hasIn: false, outDate: null, inDate: null, from: '', to: '' };
      if (r.type === 'transfer_order_out') { o.out += r.credit - r.debit; o.hasOut = true; o.outDate = o.outDate ?? r.date; o.from = o.from || r.location; }
      else { o.in += r.debit - r.credit; o.hasIn = true; o.inDate = o.inDate ?? r.date; o.to = o.to || r.location; }
      orders.set(r.txn, o);
    }
  }
  const order = KINDS.map((k) => k.key);
  const byType = [...kinds.values()]
    .sort((a, b) => (order.indexOf(a.key) + 1 || 99) - (order.indexOf(b.key) + 1 || 99))
    .map((e) => ({ key: e.key, label: e.label, count: e.count, debit: r2(e.debit), credit: r2(e.credit), net: r2(e.debit - e.credit) }));
  const manual = kinds.get('journal') ?? { count: 0, debit: 0, credit: 0 };

  const unequalAll = [...orders.values()]
    .map((o) => ({
      id: o.id, outDate: o.outDate, inDate: o.inDate, from: o.from, to: o.to,
      out: r2(o.out), in: r2(o.in), diff: r2(o.in - o.out),
      // a transfer with one side only (the other side is dated after the balance sheet date) is stock on its way, not a posting at unequal values
      side: o.hasOut && o.hasIn ? 'both' : o.hasIn ? 'in only' : 'out only',
    }))
    .filter((o) => Math.abs(o.diff) >= EQUAL)
    .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff) || String(a.id).localeCompare(String(b.id)));
  const unequalNet = unequalAll.reduce((t, o) => t + o.diff, 0);
  return {
    entries: rows.length,
    net: r2(net),
    byType,
    manual: { count: manual.count, net: r2(manual.debit - manual.credit) },
    transfers: { orders: orders.size, unequalCount: unequalAll.length, net: r2(unequalNet), unequal: unequalAll.slice(0, MAX_UNEQUAL_KEPT) },
  };
}

/**
 * The `ledger` part of the stock section: the account's lines, tied to the Trial Balance, and the gap between the account and its items explained as far as the ledger says.
 * @param {object[]} rows  stockLedgerRows()
 * @param {{ name:string, id:string, tb:number, items:number }} account  the Trial Balance figure of the account and the value of the items booked to it
 * @returns {object} { account, id, entries, net, byType, manual, transfers, gap, transfersNet, otherNet } or { error }
 */
export function buildStockLedger(rows, account) {
  if (rows.length === 0) return { error: `the ledger of ${account.name} has no lines` };
  const stray = rows.find((r) => r.accountId !== null && r.accountId !== String(account.id));
  if (stray) return { error: `the ledger answer holds a line of another account (${stray.accountId}) - Zoho ignored the account filter` };
  const made = reduceStockLedger(rows);
  if (Math.abs(made.net - account.tb) > STOCK_LEDGER_TOLERANCE) {
    return { error: `the ${rows.length} ledger lines of ${account.name} add up to ${inr(made.net, 2)} but the Trial Balance says ${inr(r2(account.tb), 2)} (a page is missing, or the answer has another shape)` };
  }
  const gap = r2(account.tb - account.items);
  const transfersNet = made.transfers.net;
  return { account: account.name, id: String(account.id), ...made, gap, transfersNet, otherNet: r2(gap - transfersNet) };
}

/** The sentence for the alerts page: what the gap of the account is made of. */
export function ledgerGapMessage(l) {
  const sign = (x) => `${x < 0 ? '-' : '+'}${inr(Math.abs(x), 2)}`;
  const t = l.transfers;
  return `${l.account}: the Trial Balance is ${inr(Math.abs(l.gap), 2)} ${l.gap >= 0 ? 'more' : 'less'} than the items booked to it. Its ledger (${l.entries.toLocaleString('en-IN')} lines) has ${l.manual.count === 0 ? 'no manual journal' : `${l.manual.count} manual journal line(s)`}; `
    + `${t.unequalCount} stock transfer${t.unequalCount === 1 ? '' : 's'} between locations ${t.unequalCount === 1 ? 'was' : 'were'} posted at unequal values (${sign(l.transfersNet)}) and the other postings make ${sign(l.otherNet)}`;
}
