// Fetches the raw data this dashboard needs from the Zoho Books API (read-only). One small function per report.
// Every function takes the Zoho client from zoho.mjs ({ get(path, query) }) so tests can hand in a replay of saved data.
//
// Paths and parameters were confirmed live where noted; the rest are guarded by checks on the response (wrong date, ignored filter,
// missing page) so a wrong guess stops with a plain message instead of producing wrong numbers.

import { normalizeVendorGroup } from './vendors.mjs';
import { normalizeJournal } from './gl.mjs';
import { normalizeBill } from './splits.mjs';
import { normalizeCwipBill, CWIP_BILL_VERSION } from './cwip.mjs';
import { ZohoError } from './zoho.mjs';

export class LoadError extends Error {
  constructor(message, code) { super(message); this.name = 'LoadError'; this.code = code; }
}

const pageContext = (raw) => (raw?.data ?? raw)?.page_context ?? {};

/** Read page 1, 2, ... until Zoho says there is no more. Refuses to run away. */
async function allPages(fetchPage, { maxPages, what }) {
  const pages = [];
  for (let page = 1; page <= maxPages; page++) {
    const raw = await fetchPage(page);
    pages.push(raw);
    if (pageContext(raw).has_more_page !== true) return pages;
  }
  throw new LoadError(`${what} has more than ${maxPages} pages - stopped (a filter was probably ignored)`, 'TOO_MANY_PAGES');
}

/**
 * Columns asked for in the Trial Balance. Found on the first live run (15-Oct-2026): without `select_columns` the live API sends only two
 * summary columns (net debit / net credit) and no opening / closing balance, so every amount would be read as zero.
 */
export const TB_COLUMNS = [
  { field: 'account_id', group: 'account' }, { field: 'name', group: 'report' }, { field: 'account_code', group: 'report' },
  { field: 'opening_balance', group: 'report' }, { field: 'debit', group: 'report' }, { field: 'credit', group: 'report' },
  { field: 'closing_balance', group: 'report' },
];

/** Trial Balance for a date range - confirmed live: one response, no paging; 952 accounts for FY26, identical to the saved copy. */
export function fetchTrialBalance(zoho, { from, to }) {
  return zoho.get('/reports/trialbalance', {
    filter_by: 'TransactionDate.CustomDate', from_date: from, to_date: to, show_rows: 'non_zero', select_columns: TB_COLUMNS,
  });
}

/**
 * Receivables aging summary by customer, as of a date (all pages).
 * Confirmed live (15-Oct-2026), all three needed to reproduce the audited 31-Mar-2026 total of 814,301,563.66 (209 customers):
 *   * the date is obeyed through `report_date` / `to_date` (`as_of_date` alone is ignored);
 *   * `include_manual_journals` and `include_credit_notes` must both be true - the Trial Balance's receivable accounts contain
 *     journal and credit-note postings; without them the report shows only 458.9 million for 133 customers.
 * The date in the answer is checked as well.
 */
export async function fetchARAging(zoho, { asOf }) {
  const pages = await allPages((page) => zoho.get('/reports/aragingsummary', {
    filter_by: 'InvoiceDate.CustomDate', to_date: asOf, report_date: asOf,
    aging_by: 'invoicedate', report_by: 'customer', show_by: 'overdueamount',
    include_manual_journals: 'true', include_credit_notes: 'true', per_page: 500, page,
  }), { maxPages: 20, what: 'The receivables aging report' });
  const pc = pageContext(pages[0]);
  const got = pc.as_of_date ?? pc.to_date ?? pc.report_date ?? null;
  if (got && got !== asOf) {
    throw new LoadError(`Zoho returned the receivables aging as of ${got}, not ${asOf} - the date parameter was not accepted`, 'AGING_DATE');
  }
  return pages;
}

/**
 * Customer Balance Summary as of a date (all pages): per customer what was invoiced and received since the books began, and the closing balance
 * (a customer in credit is negative). Seen on 16-Oct-2026 through Zoho's reports tool, which sends the same request to the same report:
 *   * `to_date` is obeyed and the answer states `as_of_date`; `from_date` is IGNORED (the totals always run from the first day of the books),
 *     so the balance at the day before the year began is read by asking for that date;
 *   * 337 customers on one page of 500 at 31-Mar-2026.
 * The date in the answer is checked.
 */
export async function fetchCustomerBalances(zoho, { asOf }) {
  const pages = await allPages((page) => zoho.get('/reports/customerbalancesummary', {
    filter_by: 'TransactionDate.CustomDate', to_date: asOf, per_page: 500, page,
  }), { maxPages: 20, what: 'The customer balance summary' });
  const pc = pageContext(pages[0]);
  const got = pc.as_of_date ?? pc.to_date ?? null;
  if (got && got !== asOf) {
    throw new LoadError(`Zoho returned the customer balance summary as of ${got}, not ${asOf} - the date parameter was not accepted`, 'CBS_DATE');
  }
  return pages;
}

/**
 * Columns asked for in Sales by Customer. Found on the first run on the real connection (16-Oct-2026): without `select_columns` the report sends only `sales`
 * and `sales_with_tax`, no `invoice_amount` / `creditnote_amount`, and the six-month buckets of the debtors ageing came out as zero for everybody.
 */
export const SALES_COLUMNS = [{ field: 'customer_name', group: 'report' }, { field: 'invoice_amount', group: 'report' }, { field: 'creditnote_amount', group: 'report' }];

/**
 * Sales by Customer for a date range (all pages): per customer the invoices (`invoice_amount`, with tax) and the credit notes (`creditnote_amount`) of those
 * days. Seen on 16-Oct-2026 through Zoho's reports tool: the range is obeyed (100 customers for 01-Oct-2025 to 31-Mar-2026). The range in the answer is checked.
 */
export async function fetchSalesByCustomer(zoho, { from, to }) {
  const pages = await allPages((page) => zoho.get('/reports/salesbycustomer', {
    filter_by: 'TransactionDate.CustomDate', from_date: from, to_date: to, select_columns: SALES_COLUMNS, per_page: 500, page,
  }), { maxPages: 20, what: 'The sales by customer report' });
  const pc = pageContext(pages[0]);
  if ((pc.from_date && pc.from_date !== from) || (pc.to_date && pc.to_date !== to)) {
    throw new LoadError(`Zoho returned the sales by customer for ${pc.from_date} to ${pc.to_date}, not ${from} to ${to}`, 'SALES_DATES');
  }
  return pages;
}

/**
 * Vendor Balance Summary for the given vendors, from `from` to `to` (all pages of every request). On the real connection (probe of 16-Oct-2026) the report
 * opens and sends, per vendor, `billed_amount`, `amount_paid` and `closing_balance` (the summary of the Zoho screen, "as of" a date: billed - paid = closing, so
 * the amounts run from the start of the books). Asking from the start of the books makes the answer the same whether Zoho reads `from_date` or ignores it.
 * The vendors are asked for by id (the report allows a filter on `vendor_id`), a few at a time, because the report lists every vendor of the books (about
 * 5,000) and the sheet needs only its own. Checks: the date in the answer, and that the filter was applied (a vendor that was not asked for stops the run).
 */
export async function fetchVendorBalances(zoho, { ids, from, to, chunk = 50 }) {
  if (!ids.length) throw new LoadError('No vendors to read the balance summary for', 'NO_VENDORS');
  const groups = [];
  for (let i = 0; i < ids.length; i += chunk) groups.push(ids.slice(i, i + chunk));
  const pages = [];
  for (const group of groups) {
    const want = new Set(group.map(String));
    const rule = { columns: [{ index: 1, field: 'vendor_id', value: group, comparator: 'in', group: 'report' }], criteria_string: '1' };
    const got = await allPages(async (page) => {
      const raw = await zoho.get('/reports/vendorbalancesummary', { filter_by: 'TransactionDate.CustomDate', from_date: from, to_date: to, rule, per_page: 500, page });
      const root = raw?.data ?? raw;
      const pc = root?.page_context ?? {};
      const stated = pc.as_of_date ?? pc.to_date ?? null;
      if (stated && stated !== to) throw new LoadError(`Zoho returned the vendor balance summary as of ${stated}, not ${to} - the date parameter was not accepted`, 'VBS_DATE');
      const seen = [];
      const walk = (x) => { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === 'object') { if (x.vendor_id !== undefined) seen.push(String(x.vendor_id)); else for (const [k, v] of Object.entries(x)) if (k !== 'page_context') walk(v); } };
      walk(root?.vendorbalancesummary);
      const stray = seen.find((id) => !want.has(id));
      if (stray !== undefined) throw new LoadError(`Zoho ignored the vendor filter on the vendor balance summary (got vendor ${stray}) - stopped before reading all vendors`, 'VBS_FILTER_IGNORED');
      return raw;
    }, { maxPages: 5, what: 'The vendor balance summary' });
    pages.push(...got);
  }
  return pages;
}

/**
 * Columns asked for in the General Ledger Details. Found on 16-Oct-2026 (live check): without `select_columns` the answer has the contact's id on every line
 * but NOT its name (`contact_name`); the only name in it is `transaction_details`, which is the contact's name on payments and bills but a description on
 * journals. So the name column is asked for by name. (The saved copies in fixtures/gl were made with exactly these columns.)
 */
export const LEDGER_COLUMNS = [
  { field: 'date', group: 'report' }, { field: 'account_name', group: 'report' }, { field: 'contact_name', group: 'report' },
  { field: 'transaction_details', group: 'report' }, { field: 'transaction_type', group: 'report' }, { field: 'entity_number', group: 'report' },
  { field: 'debit', group: 'report' }, { field: 'credit', group: 'report' },
];

/**
 * update-20: the columns asked for in the ledger of the CWIP / IAUD accounts. Besides the usual ones, the line's project (`project_name`: "NPD - Panchu - TL"), its narration
 * (`description`) and its location (`location_name`, group branch) - read on the real connection (17-Oct-2026), they are what tells the park of a bill.
 */
export const CWIP_COLUMNS = [
  ...LEDGER_COLUMNS,
  { field: 'project_name', group: 'report' }, { field: 'description', group: 'report' }, { field: 'location_name', group: 'branch' },
];

/**
 * General Ledger Details, limited to the given accounts, from the first day of the books to `to` (all pages).
 * Checks: the dates in the answer, and that Zoho really applied the account filter (otherwise the whole ledger would be read).
 * `columns` (update-20) = the columns asked for, LEDGER_COLUMNS unless the caller needs more.
 */
export async function fetchLedger(zoho, { accountIds, from, to, perPage = 2000, maxPages = 25, columns = LEDGER_COLUMNS }) {
  if (!accountIds.length) throw new LoadError('No party accounts to read the ledger for', 'NO_ACCOUNTS');
  const wanted = new Set(accountIds);
  const rule = { columns: [{ index: 1, field: 'account_id', value: accountIds, comparator: 'in', group: 'report' }], criteria_string: '1' };
  return allPages(async (page) => {
    const raw = await zoho.get('/reports/generalledgerdetails', {
      filter_by: 'TransactionDate.CustomDate', from_date: from, to_date: to, rule, select_columns: columns, per_page: perPage, page,
    });
    const root = raw?.data ?? raw;
    const pc = root.page_context ?? {};
    if ((pc.from_date && pc.from_date !== from) || (pc.to_date && pc.to_date !== to)) {
      throw new LoadError(`Zoho returned the ledger for ${pc.from_date} to ${pc.to_date}, not ${from} to ${to}`, 'LEDGER_DATES');
    }
    for (const g of root.account_transactions ?? []) {
      for (const r of g.account_transactions ?? []) {
        if (!wanted.has(String(r.account_id))) {
          throw new LoadError(`Zoho ignored the account filter on the ledger report (got a line for "${r.account_name ?? r.account_id}") - stopped before reading the whole ledger`, 'LEDGER_FILTER_IGNORED');
        }
      }
    }
    if (page === 1 && Number(pc.total_pages) > maxPages) {
      throw new LoadError(`The ledger has ${pc.total_pages} pages (more than the ${maxPages} allowed) - stopped`, 'TOO_MANY_PAGES');
    }
    return raw;
  }, { maxPages, what: 'The ledger report' });
}

/**
 * update-27: Sales by Customer for a few customers (the related parties of Note 28(A) and the RPT Transaction sheet), for a date range. `sales` is the year's sales before GST, net of
 * credit notes (checked on the real books on 21-Oct-2026: the four related customers agreed with the sheet to the rupee). The customers are asked for by id (a filter on `customer_id`),
 * and a customer that was not asked for stops the run (the filter was ignored).
 */
export async function fetchRelatedSales(zoho, { ids, from, to }) {
  if (!ids.length) throw new LoadError('No customers to read the sales for', 'NO_CUSTOMERS');
  const want = new Set(ids.map(String));
  const rule = { columns: [{ index: 1, field: 'customer_id', value: ids, comparator: 'in', group: 'report' }], criteria_string: '1' };
  return allPages(async (page) => {
    const raw = await zoho.get('/reports/salesbycustomer', { filter_by: 'TransactionDate.CustomDate', from_date: from, to_date: to, rule, per_page: 500, page });
    const root = raw?.data ?? raw;
    const pc = root?.page_context ?? {};
    if ((pc.from_date && pc.from_date !== from) || (pc.to_date && pc.to_date !== to)) {
      throw new LoadError(`Zoho returned the sales by customer for ${pc.from_date} to ${pc.to_date}, not ${from} to ${to}`, 'SALES_DATES');
    }
    const stray = (root?.sales ?? []).find((c) => !want.has(String(c.customer_id)));
    if (stray) throw new LoadError(`Zoho ignored the customer filter on the sales by customer report (got "${stray.customer_name ?? stray.customer_id}") - stopped before reading all customers`, 'SALES_FILTER_IGNORED');
    return raw;
  }, { maxPages: 3, what: 'The sales by customer report' });
}

/**
 * update-27: General Ledger Details for the given CONTACTS (the related parties' vendor cards), for a date range, limited to the given transaction types (bills and vendor credits).
 * Every line is asked for with its account (the `account` object of a line carries the account type). Checks: the dates in the answer, and that Zoho applied the contact filter
 * (a line of another contact stops the run; a line that Zoho merged from several contacts - comma-joined ids - cannot be told apart and is skipped by the reader, see lib/related.mjs).
 */
export async function fetchContactLedger(zoho, { contactIds, from, to, types = null, perPage = 2000, maxPages = 10, columns = LEDGER_COLUMNS }) {
  if (!contactIds.length) throw new LoadError('No contacts to read the ledger for', 'NO_CONTACTS');
  const wanted = new Set(contactIds.map(String));
  const cols = [{ index: 1, field: 'contact_id', value: contactIds, comparator: 'in', group: 'report' }];
  if (types?.length) cols.push({ index: 2, field: 'transaction_type', value: types, comparator: 'in', group: 'report' });
  const rule = { columns: cols, criteria_string: cols.length > 1 ? '(1 AND 2)' : '1' };
  return allPages(async (page) => {
    const raw = await zoho.get('/reports/generalledgerdetails', {
      filter_by: 'TransactionDate.CustomDate', from_date: from, to_date: to, rule, select_columns: columns, per_page: perPage, page,
    });
    const root = raw?.data ?? raw;
    const pc = root.page_context ?? {};
    if ((pc.from_date && pc.from_date !== from) || (pc.to_date && pc.to_date !== to)) {
      throw new LoadError(`Zoho returned the ledger for ${pc.from_date} to ${pc.to_date}, not ${from} to ${to}`, 'LEDGER_DATES');
    }
    for (const g of root.account_transactions ?? []) {
      for (const r of g.account_transactions ?? []) {
        const ids = String(r.contact_id ?? '').split(',').map((x) => x.trim());
        if (!ids.every((id) => wanted.has(id))) {
          throw new LoadError(`Zoho ignored the contact filter on the ledger report (got a line for "${r.contact_name ?? r.contact_id}") - stopped before reading the whole ledger`, 'LEDGER_FILTER_IGNORED');
        }
        if (types?.length && !types.includes(r.transaction_type)) {
          throw new LoadError(`Zoho ignored the transaction-type filter on the ledger report (got a ${r.transaction_type} line) - stopped`, 'LEDGER_FILTER_IGNORED');
        }
      }
    }
    return raw;
  }, { maxPages, what: 'The ledger report' });
}

/**
 * Columns asked for in the Inventory Valuation Summary and the other parameters of the request. Confirmed on the real connection (probe of 17-Oct-2026): the report answers to
 * the usual date filter (the answer states the date it is as at), 819 item lines for 31-Mar-2026 on 5 pages of 200, with these columns: the item's name, its stock on hand, the
 * value of that stock (`asset_value`) and the ledger account it is booked to. `sort_column` keeps the pages in one fixed order.
 */
export const STOCK_COLUMNS = [
  { field: 'item_name', group: 'report' }, { field: 'quantity_available', group: 'report' }, { field: 'asset_value', group: 'report' },
  { field: 'inventory_account', group: 'report' }, { field: 'sku', group: 'item' }, { field: 'unit', group: 'item' },
];

/**
 * Inventory Valuation Summary (Zoho's stock summary) at the end of the range, all pages: per item and SKU the stock on hand and its value, and the ledger account it is
 * booked to (update-17: the Closing Stock tab). The date in the answer is checked.
 */
export async function fetchInventoryValuation(zoho, { from, to }) {
  const pages = await allPages((page) => zoho.get('/reports/inventoryvaluation', {
    filter_by: 'TransactionDate.CustomDate', from_date: from, to_date: to, select_columns: STOCK_COLUMNS,
    stock_on_hand_filter: 'All', status_filter: 'All', sort_column: 'item_name', response_option: 1, per_page: 200, page,
  }), { maxPages: 30, what: 'The inventory valuation report' });
  const pc = pageContext(pages[0]);
  const got = pc.as_of_date ?? pc.to_date ?? null;
  if (got && got !== to) {
    throw new LoadError(`Zoho returned the inventory valuation as at ${got}, not ${to} - the date parameter was not accepted`, 'STOCK_DATE');
  }
  return pages;
}

/**
 * update-19: the item list (Zoho's item master, `GET /items`), active AND inactive items, all pages: the only place that holds an item's unit. The Inventory Valuation Summary
 * leaves the unit blank on 816 of its 819 lines (checked on the real connection, 17-Oct-2026), while the item list has it for every item - seen on a sample of five
 * (m-seal Kgs, POE SWITCH pcs, DOG CONDUCTOR m, PLC SYSTEM SET, 50 mm AI Ring Type Lug Packet), each the unit the signed Closing Stock sheet gives. Inactive items must be asked for:
 * the old SKUs of the stock summary (`761`, `TL-027`, `4P2P-104-IA`) are inactive. The stock lines are matched to it by SKU (lib/stock.mjs `itemUnitsOf`).
 */
export async function fetchItemList(zoho) {
  const pages = await allPages((page) => zoho.get('/items', { filter_by: 'Status.All', sort_column: 'name', per_page: 200, page }), { maxPages: 30, what: 'The item list' });
  const n = pages.reduce((t, raw) => t + ((raw?.data ?? raw)?.items?.length ?? 0), 0);
  if (n === 0) throw new LoadError('The item list is empty', 'ITEMS_EMPTY');
  return pages;
}

/** Contacts in the vendor group (custom field "Vendor Group") - confirmed live: the filter works server-side. */
export async function fetchVendorGroup(zoho, group) {
  const pages = await allPages((page) => zoho.get('/vendors', { cf_vendor_group: group, per_page: 200, page }), { maxPages: 10, what: 'The vendor list' });
  return normalizeVendorGroup(pages, group, { serverFiltered: true });
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

/**
 * Journals by transaction id, reduced to their lines (see gl.mjs normalizeJournal). Cached by id: a journal does not change
 * unless somebody edits it, and if it does the ledger-vs-journal check in gl.mjs notices and the caller refetches (`fresh`).
 * @param {{get:Function}} zoho
 * @param {string[]} ids
 * @param {{cache?:{getJournal:Function,putJournal:Function}, fresh?:Set<string>, concurrency?:number}} [opt]
 * @returns {{journals:Record<string,object>, fromCache:Set<string>, missing:string[]}}
 */
export async function fetchJournals(zoho, ids, { cache = null, fresh = new Set(), concurrency = 4, ttl = undefined } = {}) {
  const journals = {};
  const fromCache = new Set();
  const missing = [];
  await pool(ids, concurrency, async (id) => {
    if (cache && !fresh.has(id)) {
      const hit = await cache.getJournal(id).catch(() => null);
      if (hit) { journals[id] = hit; fromCache.add(id); return; }
    }
    try {
      const j = normalizeJournal(await zoho.get(`/journals/${id}`));
      journals[id] = j;
      if (cache) await cache.putJournal(id, j, ttl).catch(() => {});
    } catch (e) {
      if (e?.status === 404 || e?.code === 1002) { missing.push(id); return; }
      throw e;
    }
  });
  return { journals, fromCache, missing };
}

/**
 * update-20: like fetchJournals, but a run reads at most `budget` journals from Zoho (the ones already in the cache are free) - the CWIP tab needs 137 journals and the first
 * run on an empty cache must stay inside the time a refresh may take. What was not read is returned in `pending` (the next refresh reads on). Without a cache every journal is read.
 * @returns {{journals:Record<string,object>, fromCache:Set<string>, missing:string[], pending:string[], fetched:number}}
 */
export async function fetchJournalsBudget(zoho, ids, { cache = null, fresh = new Set(), budget = Infinity, concurrency = 4, ttl = undefined } = {}) {
  const journals = {};
  const fromCache = new Set();
  const due = [];
  if (cache) {
    await pool(ids, 8, async (id) => {
      const hit = fresh.has(id) ? null : await cache.getJournal(id).catch(() => null);
      if (hit) { journals[id] = hit; fromCache.add(id); } else due.push(id);
    });
    due.sort((a, b) => ids.indexOf(a) - ids.indexOf(b)); // the order of the ledger, whatever order the cache answered in
  } else due.push(...ids);
  const batch = due.slice(0, budget);
  const got = await fetchJournals(zoho, batch, { cache, fresh: new Set(batch), concurrency, ttl });
  Object.assign(journals, got.journals);
  return { journals, fromCache, missing: got.missing, pending: due.slice(budget), fetched: Object.keys(got.journals).length };
}

/**
 * update-16: the bills (by transaction id) that a contact split reads - the state of the billing address of each bill of HDFC ERGO. Cached by id like the journals (12 hours).
 * A bill that cannot be read is NOT an error of the run: it is listed in `failed` and its amount stays out of the split (compared in total, as before).
 * @param {{get:Function}} zoho
 * @param {string[]} ids
 * @param {{cache?:{getBill:Function,putBill:Function}, concurrency?:number}} [opt]
 * @returns {{bills:Record<string,object>, fromCache:Set<string>, failed:Record<string,string>}}
 */
export async function fetchBills(zoho, ids, { cache = null, concurrency = 4 } = {}) {
  const bills = {};
  const fromCache = new Set();
  const failed = {};
  await pool(ids, concurrency, async (id) => {
    if (cache) {
      const hit = await cache.getBill(id).catch(() => null);
      if (hit && typeof hit.billingState === 'string') { bills[id] = hit; fromCache.add(id); return; }
    }
    try {
      const b = normalizeBill(await zoho.get(`/bills/${id}`));
      bills[id] = b;
      if (cache) await cache.putBill(id, b).catch(() => {});
    } catch (e) {
      failed[id] = e?.message ?? String(e);
    }
  });
  return { bills, fromCache, failed };
}

/**
 * update-22: the bills behind the CWIP / IAUD accounts, reduced to their lines (lib/cwip.mjs normalizeCwipBill) - Zoho's ledger report adds up the lines of one bill that go to the same
 * account, so the lines come from the bill itself. Like the journals: kept by id (a month: they belong to a closed year; one that no longer adds up to its ledger line is read again),
 * and at most `budget` bills not yet in the cache are read per run (the rest is returned in `pending`). A bill that cannot be read is NOT an error of the run: it is listed in `failed`
 * and the ledger's own line stays (the tab says so).
 * @returns {{bills:Record<string,object>, fromCache:Set<string>, failed:Record<string,string>, pending:string[], fetched:number}}
 */
export async function fetchCwipBills(zoho, ids, { cache = null, fresh = new Set(), budget = Infinity, concurrency = 4, ttl = undefined } = {}) {
  const bills = {};
  const fromCache = new Set();
  const failed = {};
  const due = [];
  if (cache) {
    await pool(ids, 8, async (id) => {
      const hit = fresh.has(id) ? null : await cache.getCwipBill(id).catch(() => null);
      if (hit && Array.isArray(hit.lines) && hit.v === CWIP_BILL_VERSION) { bills[id] = hit; fromCache.add(id); } else due.push(id); // a copy of an older shape (update-22: no Project Name field, no customer) is read again
    });
    due.sort((a, b) => ids.indexOf(a) - ids.indexOf(b));
  } else due.push(...ids);
  const batch = due.slice(0, budget);
  let fetched = 0;
  await pool(batch, concurrency, async (id) => {
    try {
      const b = normalizeCwipBill(await zoho.get(`/bills/${id}`));
      bills[id] = b;
      fetched += 1;
      if (cache) await cache.putCwipBill(id, b, ttl).catch(() => {});
    } catch (e) {
      failed[id] = e?.message ?? String(e);
    }
  });
  return { bills, fromCache, failed, pending: due.slice(budget), fetched };
}

/**
 * The Vendor Code ("cf_vendor_code", a custom field) of a vendor card: `GET /contacts/{id}` gives it as `contact.cf_vendor_code`, in `contact.custom_field_hash`
 * and in the `contact.custom_fields` list - whichever is there. '' = the card has no code. null = the answer is not a vendor card.
 */
export function vendorCodeOf(answer) {
  const c = answer?.data?.contact ?? answer?.contact ?? null;
  if (!c || typeof c !== 'object') return null;
  const hit = c.cf_vendor_code ?? c.custom_field_hash?.cf_vendor_code ?? (Array.isArray(c.custom_fields) ? c.custom_fields.find((f) => f?.api_name === 'cf_vendor_code')?.value : undefined);
  return hit === undefined || hit === null ? '' : String(hit).trim();
}

/**
 * update-30: the MSME facts of a vendor card (`GET /contacts/{id}`, the same call that gives the Vendor Code): `udyam_reg_no` (the Udyam registration number) and `msme_type`
 * (micro / small / medium). Seen through Zoho's own connector on 21-Oct-2026: the cards of three of the five vendors the signed sheet shows as MSME carry a Udyam number.
 * A card that has no such field is a vendor without a Udyam number ('' and ''). null = the answer is not a vendor card.
 */
export function vendorMsmeOf(answer) {
  const c = answer?.data?.contact ?? answer?.contact ?? null;
  if (!c || typeof c !== 'object') return null;
  const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
  return { udyam: str(c.udyam_reg_no), msme: str(c.msme_type) };
}

/**
 * Vendor Codes (and, from update-30, the Udyam number and MSME type) for the Creditors Ageing, vendor by vendor from their own card (the list of vendors would be ~5,000 contacts =
 * 25 pages). They are kept in ONE Redis key; a card is read again after `maxAgeMs`, and so is a vendor kept by an older version that has a code but no Udyam entry. A run reads at
 * most `budget` cards, so a first run on an empty cache spreads over a few refreshes instead of holding up the statements. A card that fails is left for the next run; if Zoho starts
 * refusing (rate limit, token) the run stops there and keeps what it has.
 * `codes` holds every code known (also an old one that is due to be read again); `pending` the vendors with none yet; `flags` the Udyam / MSME facts known ({udyam, msme} by id);
 * `unflagged` the vendors that have a code but no Udyam entry yet.
 * @returns {{codes: Record<string,string>, flags: Record<string,{udyam:string,msme:string}>, fromCache: number, fetched: number, pending: string[], unflagged: string[], failed: string[], stopped: string|null}}
 */
export async function fetchVendorCodes(zoho, ids, { cache = null, budget = 40, concurrency = 4, maxAgeMs = 7 * 24 * 3600 * 1000, now = Date.now } = {}) {
  const kept = (cache ? await cache.getVendorCodes().catch(() => null) : null) ?? {};
  const t = now();
  const codes = {};
  const flags = {};
  const due = [];
  let fromCache = 0;
  for (const raw of ids) {
    const id = String(raw);
    const e = kept[id];
    if (e && typeof e.code === 'string') {
      codes[id] = e.code;
      const flagged = typeof e.udyam === 'string';
      if (flagged) flags[id] = { udyam: e.udyam, msme: typeof e.msme === 'string' ? e.msme : '' };
      if (flagged && t - (e.at ?? 0) <= maxAgeMs) { fromCache += 1; continue; }
    }
    due.push(id);
  }
  due.sort((a, b) => (kept[a]?.at ?? 0) - (kept[b]?.at ?? 0)); // never read first, then the oldest
  const batch = due.slice(0, budget);
  const failed = [];
  let fetched = 0;
  let stopped = null;
  await pool(batch, concurrency, async (id) => {
    if (stopped) return;
    try {
      const answer = await zoho.get(`/contacts/${id}`);
      const code = vendorCodeOf(answer);
      if (code === null) { failed.push(id); return; }
      const f = vendorMsmeOf(answer) ?? { udyam: '', msme: '' };
      codes[id] = code;
      flags[id] = f;
      kept[id] = { code, at: t, udyam: f.udyam, msme: f.msme };
      fetched += 1;
    } catch (e) {
      if ([401, 403, 429].includes(e?.status)) { stopped = e.message ?? String(e); return; }
      failed.push(id);
    }
  });
  if (cache && fetched) await cache.putVendorCodes(kept).catch(() => {});
  const pending = due.filter((id) => !(id in codes));
  const unflagged = ids.map(String).filter((id) => id in codes && !(id in flags));
  return { codes, flags, fromCache, fetched, pending, unflagged, failed, stopped };
}

/**
 * update-28: the fixed asset register (Zoho's Fixed Assets module), every asset whatever its status (all pages). Seen through Zoho's own connector on 21-Oct-2026: 502 assets
 * (213 active, 270 fully depreciated, 19 draft), each with its asset number (the asset code of the Dep.Calc. sheet), name, type, purchase date, `asset_cost` and
 * `current_asset_value` (the book value as of the last depreciation run). Needs the scope ZohoBooks.fixedasset.READ; without it Zoho refuses and the caller carries on without the register.
 */
export async function fetchFixedAssets(zoho, { perPage = 200, maxPages = 20 } = {}) {
  return allPages((page) => zoho.get('/fixedassets', { filter_by: 'Status.All', per_page: perPage, page }), { maxPages, what: 'The fixed asset register' });
}

export const ASSET_HISTORY_VERSION = 1;

/**
 * update-30: the settings of ONE fixed asset that the list does not give: `GET /fixedassets/{id}` has `depreciation_percentage` (the yearly rate, in percent: 45.07 = 45.07 %) and
 * `salvage_value` (the residual value, in rupees). Seen through Zoho's own connector on 21-Oct-2026 on five assets: the salvage value was the Residual Value of the signed Dep.Calc. sheet
 * for all five; the rate was the sheet's Rate for the assets bought in the year and for the buildings, and differed for the assets whose rate the auditors work out again each year
 * from the balance life (the page says which). null = the answer is not a fixed asset.
 */
export function normalizeAssetDetail(answer) {
  const a = answer?.data?.fixed_asset ?? answer?.fixed_asset ?? null;
  if (!a || typeof a !== 'object') throw new LoadError('The fixed asset has an unexpected shape (no fixed_asset)', 'ASSET_DETAIL_SHAPE');
  const n = (v) => { if (v === '' || v === null || v === undefined) return null; const x = Number(v); return Number.isFinite(x) ? x : null; };
  return { rate: n(a.depreciation_percentage), res: n(a.salvage_value) };
}

/**
 * update-29: the entries Zoho keeps for ONE fixed asset (`/fixedassets/{id}/history`), reduced to [type, date, depreciated, accumulated] and sorted by date (an acquisition
 * first on the same day). Seen through Zoho's own connector on 21-Oct-2026: every asset of the company has an `acquisition` entry (valuation_date = the purchase date,
 * accumulated_value = the depreciation already written off when it was entered) and, if it is not fully depreciated, one `depreciation` entry dated 31 March 2026
 * (depreciated_value = the depreciation of the year, accumulated_value = everything written off so far). The answer is one page (no more than two entries per asset were seen);
 * a second page is refused rather than half read.
 */
export function normalizeAssetHistory(answer) {
  const root = answer?.data ?? answer;
  if (!Array.isArray(root?.asset_history)) throw new LoadError('The asset history has an unexpected shape (no asset_history list)', 'ASSET_HISTORY_SHAPE');
  if (root.page_context?.has_more_page === true) throw new LoadError('The asset history has more than one page', 'ASSET_HISTORY_PAGES');
  const money = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; };
  const ent = root.asset_history.map((e) => [String(e.type ?? ''), String(e.valuation_date ?? ''), money(e.depreciated_value), money(e.accumulated_value)]);
  if (ent.some((e) => !/^\d{4}-\d{2}-\d{2}$/.test(e[1]))) throw new LoadError('An entry of the asset history has no date', 'ASSET_HISTORY_DATE');
  ent.sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : (a[0] === 'acquisition' ? -1 : 0) - (b[0] === 'acquisition' ? -1 : 0)));
  return ent;
}

/**
 * update-29: the history of every asset in `ids`, one call each (483 for FY26). The entries are kept in ONE Redis key for 35 days (the year is closed, they do not change); a run
 * reads at most `budget` assets that are not in it (a first run on an empty cache therefore spreads over a few runs, the rest is read by the continuation of server.mjs), saving
 * what it has every `chunk` assets so that a run cut short loses little. If Zoho starts refusing (401, 403, 429) the run stops there and keeps what it has.
 * update-30: and the rate and residual value of each asset (`/fixedassets/{id}`, see normalizeAssetDetail): one more call per asset, kept in the same Redis entry; an entry kept by
 * update-29 (entries only) is completed with that one call. `budget` counts assets (up to two calls each).
 * @returns {{byId: Record<string, any[]>, det: Record<string, {rate:number|null,res:number|null}>, fromCache: number, fetched: number, pending: string[], detPending: string[], failed: string[], stopped: string|null}}
 *   byId holds every asset known (also one that is due to be read again); pending = assets with no entry at all; det / detPending the same for the rate and the residual value.
 */
export async function fetchAssetHistories(zoho, ids, { cache = null, budget = Infinity, concurrency = 4, chunk = 25, maxAgeMs = 30 * 24 * 3600 * 1000, now = Date.now } = {}) {
  const kept = (cache ? await cache.getAssetHistory().catch(() => null) : null) ?? {};
  const t = now();
  const byId = {};
  const det = {};
  const due = [];
  let fromCache = 0;
  for (const raw of ids) {
    const id = String(raw);
    const e = kept[id];
    let fresh = false;
    if (e && e.v === ASSET_HISTORY_VERSION && Array.isArray(e.ent)) {
      byId[id] = e.ent;
      fresh = t - (e.at ?? 0) <= maxAgeMs;
    }
    // update-30: the rate and the residual value of the asset (one more call); an entry kept by update-29 has the entries but not these
    const hasDet = Boolean(e && e.det && typeof e.det === 'object');
    if (hasDet) det[id] = e.det;
    if (fresh && hasDet) { fromCache += 1; continue; }
    due.push(id);
  }
  due.sort((a, b) => (kept[a]?.at ?? 0) - (kept[b]?.at ?? 0)); // never read first, then the oldest
  const batch = due.slice(0, budget);
  const failed = [];
  let fetched = 0;
  let stopped = null;
  for (let i = 0; i < batch.length && !stopped; i += chunk) {
    let dirty = 0;
    await pool(batch.slice(i, i + chunk), concurrency, async (id) => {
      if (stopped) return;
      try {
        const old = kept[id];
        const histOk = Boolean(old && old.v === ASSET_HISTORY_VERSION && Array.isArray(old.ent) && t - (old.at ?? 0) <= maxAgeMs);
        if (!histOk) { // the entries first; kept at once, so that a failing second call does not lose them
          const ent = normalizeAssetHistory(await zoho.get(`/fixedassets/${id}/history`, { per_page: 200 }));
          byId[id] = ent;
          kept[id] = { v: ASSET_HISTORY_VERSION, at: t, ent, ...(det[id] ? { det: det[id] } : {}) };
          dirty += 1;
        }
        if (!det[id]) { // update-30: and the settings of the asset
          det[id] = normalizeAssetDetail(await zoho.get(`/fixedassets/${id}`));
          kept[id] = { ...kept[id], det: det[id] };
          dirty += 1;
        }
        fetched += 1;
      } catch (e) {
        if ([401, 403, 429].includes(e?.status)) { stopped = e.message ?? String(e); return; }
        failed.push(id);
      }
    });
    if (cache && dirty) await cache.putAssetHistory(kept).catch(() => {});
  }
  const pending = ids.map(String).filter((id) => !(id in byId));
  const detPending = ids.map(String).filter((id) => !(id in det));
  return { byId, det, fromCache, fetched, pending, detPending, failed, stopped };
}

/**
 * update-28: the trial balance of a SUBSIDIARY's own books, from the day it began to `to` (one response, no paging). Same report and columns as the company's own; only the organisation
 * differs (`organization_id` in the query replaces the client's). Asked from the day the subsidiary began so that every balance is the whole of its life; seen on 21-Oct-2026
 * (a later start left the income and expense lines out of the answer). The dates in the answer are checked.
 */
export async function fetchSubsidiaryTrialBalance(zoho, { org, from, to }) {
  const raw = await zoho.get('/reports/trialbalance', {
    organization_id: org, filter_by: 'TransactionDate.CustomDate', from_date: from, to_date: to, show_rows: 'non_zero', select_columns: TB_COLUMNS,
  });
  const pc = (raw?.data ?? raw)?.page_context ?? {};
  if ((pc.from_date && pc.from_date !== from) || (pc.to_date && pc.to_date !== to)) {
    throw new LoadError(`Zoho returned the subsidiary's trial balance for ${pc.from_date} to ${pc.to_date}, not ${from} to ${to}`, 'SUB_TB_DATES');
  }
  return raw;
}

/**
 * update-28: the profit and loss account of a subsidiary, for the same days. Zoho's new-flow report is asked for (`is_new_flow`, `is_response_new_flow`): it comes as a tree of
 * Operating Income, Cost of Goods Sold, Operating Expense, Non Operating Income / Expense and Net Profit/Loss, with every account under its heading (seen on 21-Oct-2026).
 */
export async function fetchSubsidiaryProfitLoss(zoho, { org, from, to }) {
  const raw = await zoho.get('/reports/profitandloss', {
    organization_id: org, filter_by: 'TransactionDate.CustomDate', from_date: from, to_date: to, is_new_flow: 'true', is_response_new_flow: 'true',
  });
  const pc = (raw?.data ?? raw)?.page_context ?? {};
  if ((pc.from_date && pc.from_date !== from) || (pc.to_date && pc.to_date !== to)) {
    throw new LoadError(`Zoho returned the subsidiary's profit and loss for ${pc.from_date} to ${pc.to_date}, not ${from} to ${to}`, 'SUB_PL_DATES');
  }
  return raw;
}

/** Both reports of one subsidiary. A refusal (the login is not a member of that organisation, the user is disabled ...) comes back as { error } for that report: the others are still read. */
export async function fetchSubsidiaryReports(zoho, { org, from, to }) {
  const soft = (e) => { if (e instanceof LoadError || e instanceof ZohoError) return { error: e }; throw e; };
  const [tb, pl] = await Promise.all([
    fetchSubsidiaryTrialBalance(zoho, { org, from, to }).catch(soft),
    fetchSubsidiaryProfitLoss(zoho, { org, from, to }).catch(soft),
  ]);
  return { tb, pl };
}
