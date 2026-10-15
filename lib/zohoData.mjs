// Fetches the raw data this dashboard needs from the Zoho Books API (read-only). One small function per report.
// Every function takes the Zoho client from zoho.mjs ({ get(path, query) }) so tests can hand in a replay of saved data.
//
// Paths and parameters were confirmed live where noted; the rest are guarded by checks on the response (wrong date, ignored filter,
// missing page) so a wrong guess stops with a plain message instead of producing wrong numbers.

import { normalizeVendorGroup } from './vendors.mjs';
import { normalizeJournal } from './gl.mjs';

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

/** Trial Balance for a date range - confirmed live: one response, no paging. */
export function fetchTrialBalance(zoho, { from, to }) {
  return zoho.get('/reports/trialbalance', {
    filter_by: 'TransactionDate.CustomDate', from_date: from, to_date: to, show_rows: 'non_zero', response_option: 1, usestate: 'false',
  });
}

/**
 * Receivables aging summary by customer, as of a date (all pages).
 * Zoho does not document the date parameter of this report, so the names the report itself echoes back are sent
 * (filter_by + to_date + as_of_date) and the date in the answer is checked.
 */
export async function fetchARAging(zoho, { asOf }) {
  const pages = await allPages((page) => zoho.get('/reports/aragingsummary', {
    filter_by: 'InvoiceDate.CustomDate', to_date: asOf, as_of_date: asOf,
    aging_by: 'invoicedate', report_by: 'customer', show_by: 'overdueamount', per_page: 500, page,
  }), { maxPages: 20, what: 'The receivables aging report' });
  const pc = pageContext(pages[0]);
  const got = pc.as_of_date ?? pc.to_date ?? pc.report_date ?? null;
  if (got && got !== asOf) {
    throw new LoadError(`Zoho returned the receivables aging as of ${got}, not ${asOf} - the date parameter was not accepted`, 'AGING_DATE');
  }
  return pages;
}

/**
 * General Ledger Details, limited to the party accounts, from the first day of the books to `to` (all pages).
 * Checks: the dates in the answer, and that Zoho really applied the account filter (otherwise the whole ledger would be read).
 */
export async function fetchLedger(zoho, { accountIds, from, to, perPage = 2000, maxPages = 25 }) {
  if (!accountIds.length) throw new LoadError('No party accounts to read the ledger for', 'NO_ACCOUNTS');
  const wanted = new Set(accountIds);
  const rule = { columns: [{ index: 1, field: 'account_id', value: accountIds, comparator: 'in', group: 'report' }], criteria_string: '1' };
  return allPages(async (page) => {
    const raw = await zoho.get('/reports/generalledgerdetails', {
      filter_by: 'TransactionDate.CustomDate', from_date: from, to_date: to, rule, per_page: perPage, page,
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
export async function fetchJournals(zoho, ids, { cache = null, fresh = new Set(), concurrency = 4 } = {}) {
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
      if (cache) await cache.putJournal(id, j).catch(() => {});
    } catch (e) {
      if (e?.status === 404 || e?.code === 1002) { missing.push(id); return; }
      throw e;
    }
  });
  return { journals, fromCache, missing };
}
