// General-ledger lines for the party (supplier / creditor / advance) accounts, per contact.
//
// Source: Zoho Books report "General Ledger Details" filtered to the party accounts (see partyAccountIds in vendors.mjs).
// Sign convention: debit +, credit -  (same as the Trial Balance).
//
// KNOWN ZOHO BEHAVIOUR (found while building Phase 2): when ONE journal posts lines for SEVERAL contacts to the SAME
// account, the report shows a single merged row - contact ids comma-joined, names joined by line breaks, and the amounts
// netted (often 0 / 0). The per-contact amounts are lost. The only reliable fix is to fetch that journal with get_journal
// and use its own lines. mergedTransactionIds() says which journals to fetch; expandMergedRows() applies them.

import { num, r2 } from './util.mjs';

export const UNTAGGED = '-1'; // Zoho's "Unassociated Transactions" contact

/**
 * @param {object|object[]} pages  one raw report response, or all pages of it
 * @returns {{rows:{txnId,accountId,accountName,contactId,contactName,type,entry,date,net}[], meta:{from,to,total,pages}}}
 */
export function normalizeGL(pages) {
  const list = Array.isArray(pages) ? pages : [pages];
  if (!list.length) throw new Error('General ledger: no pages given');
  const rows = [];
  let total = null;
  let from = null;
  let to = null;
  let last = null;
  for (const p of list) {
    const root = p?.data ?? p;
    const groups = root?.account_transactions;
    if (!Array.isArray(groups)) throw new Error('General ledger response has an unexpected shape (no account_transactions)');
    for (const g of groups) {
      for (const r of g.account_transactions ?? []) {
        const cid = String(r.contact_id ?? '').trim();
        rows.push({
          txnId: String(r.transaction_id ?? ''),
          accountId: String(r.account_id ?? g.group_name ?? ''),
          accountName: r.account_name ?? '',
          contactId: cid === '' ? UNTAGGED : cid,
          contactName: (r.contact_name ?? '').trim(),
          type: r.transaction_type ?? '',
          entry: r.entity_number ?? '',
          date: r.date ?? '',
          net: num(r.debit) - num(r.credit),
        });
      }
    }
    const pc = root.page_context ?? {};
    total = pc.total ?? total;
    from = pc.from_date ?? from;
    to = pc.to_date ?? to;
    last = pc;
  }
  if (last?.has_more_page === true) throw new Error('General ledger is incomplete: the last page given still says has_more_page');
  if (total !== null && rows.length !== total) {
    throw new Error(`General ledger is incomplete: report says ${total} rows but ${rows.length} were read (a page is missing?)`);
  }
  return { rows, meta: { from, to, total, pages: list.length } };
}

const isMerged = (r) => r.contactId.includes(',');

/** Journals (transaction ids) that must be fetched with get_journal before the lines can be attributed to contacts. */
export function mergedTransactionIds(rows) {
  return [...new Set(rows.filter(isMerged).map((r) => r.txnId))];
}

/** Zoho get_journal response -> { entry_number, lines:[{account_id, contact_id, debit, credit}] }  (all accounts) */
export function normalizeJournal(raw) {
  const j = (raw?.data ?? raw)?.journal;
  if (!j || !Array.isArray(j.line_items)) throw new Error('Journal response has an unexpected shape (no journal.line_items)');
  return {
    entry_number: j.entry_number ?? '',
    lines: j.line_items.map((l) => ({
      account_id: String(l.account_id),
      contact_id: String(l.customer_id ?? ''),
      debit: l.debit_or_credit === 'debit' ? num(l.amount) : 0,
      credit: l.debit_or_credit === 'credit' ? num(l.amount) : 0,
    })),
  };
}

/**
 * Replace every merged row by the journal's own per-contact lines (for the same account).
 * @param {object[]} rows  from normalizeGL
 * @param {Record<string,{entry_number,lines}>} journals  keyed by transaction id (normalizeJournal output)
 * @returns {{rows:object[], alerts:object[], expanded:number}}
 */
export function expandMergedRows(rows, journals = {}) {
  const alerts = [];
  const groups = new Map(); // "txn|account" -> merged rows
  for (const r of rows) if (isMerged(r)) {
    const k = `${r.txnId}|${r.accountId}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const out = [];
  const done = new Set();
  let expanded = 0;
  for (const r of rows) {
    const k = `${r.txnId}|${r.accountId}`;
    if (!groups.has(k)) { out.push(r); continue; }
    if (done.has(k)) continue;
    done.add(k);
    const merged = groups.get(k);
    const lines = journals[r.txnId]?.lines?.filter((l) => l.account_id === r.accountId) ?? [];
    const journalNet = lines.reduce((s, l) => s + l.debit - l.credit, 0);
    const mergedNet = merged.reduce((s, m) => s + m.net, 0);
    if (lines.length && Math.abs(journalNet - mergedNet) <= 0.01) {
      for (const l of lines) {
        const cid = l.contact_id === '' ? UNTAGGED : l.contact_id;
        out.push({ ...r, contactId: cid, contactName: '', net: l.debit - l.credit });
      }
      expanded++;
    } else {
      // Cannot attribute: keep the amount (so the account still ties to the Trial Balance) but under "untagged".
      const net = mergedNet;
      if (Math.abs(net) > 0.005) {
        alerts.push({
          level: 'warn', code: 'GL_MERGED_UNEXPANDED', txnId: r.txnId,
          message: `Journal ${r.entry} (${r.txnId}) posts several contacts to one account and could not be read line by line; ${r2(net)} is shown as untagged`,
        });
        out.push({ ...r, contactId: UNTAGGED, contactName: '', net });
      } else {
        alerts.push({
          level: 'info', code: 'GL_MERGED_NEUTRAL',
          message: `Journal ${r.entry} (${r.txnId}) posts several contacts to one account, nets to zero, and was not read line by line (per-contact split not checked)`,
        });
      }
      if (lines.length && Math.abs(journalNet - mergedNet) > 0.01) {
        alerts.push({
          level: 'warn', code: 'GL_JOURNAL_MISMATCH', txnId: r.txnId,
          message: `Journal ${r.entry} (${r.txnId}): its lines net to ${r2(journalNet)} but the ledger row says ${r2(mergedNet)}; journal lines ignored`,
        });
      }
    }
  }
  return { rows: out, alerts, expanded };
}

/** Per-contact and per-account totals from expanded rows. */
export function summarizeGL(rows) {
  const byContact = new Map(); // contactId -> net over all accounts
  const byAccount = new Map(); // accountId -> net
  const byContactAccount = new Map(); // `${contactId}|${accountId}` -> net
  const names = new Map();
  for (const r of rows) {
    byContact.set(r.contactId, (byContact.get(r.contactId) ?? 0) + r.net);
    byAccount.set(r.accountId, (byAccount.get(r.accountId) ?? 0) + r.net);
    const k = `${r.contactId}|${r.accountId}`;
    byContactAccount.set(k, (byContactAccount.get(k) ?? 0) + r.net);
    if (r.contactName && !r.contactName.includes('\n') && !isMerged(r) && r.contactId !== UNTAGGED) names.set(r.contactId, r.contactName);
  }
  return { byContact, byAccount, byContactAccount, names };
}
