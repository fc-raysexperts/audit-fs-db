// Bank-wise (deposit-wise, share-wise) split of ONE Zoho ledger account.   (update-15)
//
// Zoho's FY26 books were rebuilt at the year end: the old ledger accounts of every fixed deposit ("IOB FD no. 015804000012280", "FDR with _ AXIS BANK", "Security
// Deposit (CDSL)" ...) were emptied by clean-up journals dated 31-Mar-2026 into ONE new account each (Fixed Deposits, Accrued Interest on FDR, Security Deposit-Given),
// and the auditors' reconcile journals (SJ-1184 ...) named the bank in their text. So the new account holds, as plain ledger rows, everything the signed sheet lists
// bank by bank - only the bank is not a column of the ledger. It is found, row by row, from words:
//
//   1. in the row's own text (the journal's notes: "Being AXIS Bank FDR Balances Reconciled ..."), else
//   2. (for a split with `legs: true`) in the journal behind the row: its notes and the NAMES of its other lines' accounts ("Icici FD no. 728513002750").
//
// A row whose words name exactly one part goes to that part. A row that names none goes to the part marked `rest` if there is one (the PF payable: the employee
// share is the one journal that says so, the employer share is what is left), otherwise it is "unassigned"; a row that names two parts is unassigned as well.
// Whatever is unassigned stays in the `residual`, which the sheet's block compares in total (so nothing is hidden or guessed).
//
// Pure functions: the ledger rows and the journals are handed in (lib/snapshot.mjs reads them from Zoho).

import { num, r2 } from './util.mjs';

/** rupees: the ledger of the account must add up to the Trial Balance's closing balance of it, or the split is not used */
export const SPLIT_TOLERANCE = 1;

/** " a b c " - lower case, every other character a space, so that a word is found as a whole word only ("sbi" is not in "sbill") */
const spaced = (s) => ` ${String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;

/** The indexes of the parts whose words are found in the text. */
export function partsIn(text, parts) {
  const t = spaced(text);
  const hits = new Set();
  parts.forEach((p, i) => { if ((p.words ?? []).some((w) => t.includes(spaced(w)))) hits.add(i); });
  return hits;
}

/**
 * Raw General Ledger Details pages (lib/zohoData.mjs fetchLedger) -> the rows the split needs.
 * @returns {{txnId,accountId,date,type,entry,text,debit,credit}[]}
 */
export function normalizeSplitLedger(pages) {
  const list = Array.isArray(pages) ? pages : [pages];
  const rows = [];
  let last = null;
  for (const p of list) {
    const root = p?.data ?? p;
    const groups = root?.account_transactions;
    if (!Array.isArray(groups)) throw new Error('The ledger of the deposit accounts has an unexpected shape (no account_transactions)');
    for (const g of groups) {
      for (const r of g.account_transactions ?? []) {
        rows.push({
          txnId: String(r.transaction_id ?? ''),
          accountId: String(r.account_id ?? g.group_name ?? ''),
          date: r.date ?? '',
          type: r.transaction_type ?? '',
          entry: r.entity_number ?? '',
          text: String(r.transaction_details ?? ''),
          debit: num(r.debit),
          credit: num(r.credit),
        });
      }
    }
    last = root.page_context ?? last;
  }
  if (last?.has_more_page === true) throw new Error('The ledger of the deposit accounts is incomplete: the last page given still says has_more_page');
  return rows;
}

const amountOf = (spec, r) => (spec.normal === 'credit' ? r.credit - r.debit : r.debit - r.credit);

/** The journals (transaction ids) a split has to open: journal rows of its account whose own text names no part - only for a split with `legs: true`. */
export function journalsNeeded(spec, rows) {
  if (!spec.legs) return [];
  return [...new Set(rows
    .filter((r) => r.accountId === spec.account && r.type === 'journal' && r.txnId && Math.abs(amountOf(spec, r)) >= 0.005 && partsIn(r.text, spec.parts).size === 0)
    .map((r) => r.txnId))];
}

/**
 * Does the journal match the ledger row, and does it carry the names? A journal cached before update-15 has no notes; one that was edited after it was cached no longer
 * adds up to the ledger row. Either way it has to be read again (`stale`).
 */
function journalFits(spec, j, ledgerNet) {
  if (!j || !('notes' in j)) return false;
  const mine = j.lines.filter((l) => l.account_id === spec.account);
  const net = mine.reduce((t, l) => t + (spec.normal === 'credit' ? l.credit - l.debit : l.debit - l.credit), 0);
  return Math.abs(net - ledgerNet) <= 0.01;
}

/**
 * @param {{account:string, name:string, normal:'debit'|'credit', legs?:boolean, parts:{name:string, words?:string[], rest?:boolean}[]}} spec
 * @param {ReturnType<typeof normalizeSplitLedger>} rows   all rows read (other accounts are ignored)
 * @param {Record<string,{notes:string, lines:{account_id:string,name?:string,debit:number,credit:number}[]}>} [journals]   by transaction id
 * @returns {{total:number, parts:{name:string,amount:number,rows:number}[], residual:number, unassigned:object[], rows:number, stale:string[]}}
 *   total = what the ledger says the account holds (in its normal direction); parts = only those that got at least one row; residual = total - sum(parts)
 */
export function buildSplit(spec, rows, journals = {}) {
  const parts = spec.parts.map((p) => ({ name: p.name, amount: 0, rows: 0 }));
  const restAt = spec.parts.findIndex((p) => p.rest);
  const unassigned = [];
  const stale = [];
  let total = 0;
  let seen = 0;
  for (const r of rows) {
    if (r.accountId !== spec.account) continue;
    seen += 1;
    const amount = amountOf(spec, r);
    total += amount;
    if (Math.abs(amount) < 0.005) continue;
    let hits = partsIn(r.text, spec.parts);
    let why = 'no bank / name in the text';
    if (hits.size === 0 && spec.legs && r.type === 'journal') {
      const j = journals[r.txnId];
      if (!journalFits(spec, j, amount)) { stale.push(r.txnId); why = j ? 'the journal does not match the ledger line' : 'the journal could not be read'; }
      else {
        hits = partsIn([j.notes, ...j.lines.filter((l) => l.account_id !== spec.account).map((l) => l.name ?? '')].join(' | '), spec.parts);
        why = 'no bank / name in the journal';
      }
    }
    if (hits.size === 1) { const k = [...hits][0]; parts[k].amount += amount; parts[k].rows += 1; }
    else if (hits.size === 0 && restAt >= 0 && !stale.includes(r.txnId)) { parts[restAt].amount += amount; parts[restAt].rows += 1; }
    else unassigned.push({ entry: r.entry, date: r.date, amount: r2(amount), text: r.text.slice(0, 120), why: hits.size > 1 ? 'two names in the same entry' : why });
  }
  const used = parts.filter((p) => p.rows > 0).map((p) => ({ name: p.name, amount: r2(p.amount), rows: p.rows }));
  return { total: r2(total), parts: used, residual: r2(total - used.reduce((t, p) => t + p.amount, 0)), unassigned, rows: seen, stale: [...new Set(stale)] };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// One CONTACT split by the ledger account its entries sit in.   (update-15)
//
// Zoho keeps one balance per contact (lib/vendors.mjs), the signed sheet lists the same party twice: an insurer as "advance" in one note and as "payable" in another,
// RPE Energy Reserve as "loan" and as "advance". The party ledger (already read, merged journals expanded) says in which ACCOUNT each entry of the contact sits - so the
// contact's entries are shared between the lines of the sheet by account: a part names the accounts it owns, the part marked `rest` takes every other account of the contact.
// Nothing is read from Zoho for this.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * update-16: Zoho's answer for ONE bill -> the few facts a split needs.  The bill carries, besides its ledger entry, the STATE of its billing address (the state the
 * bill was booked under: "Delhi") and the state of the supplier's GST registration (`source_of_supply`: "RJ" / "DL"). Only `billingState` is used for the split;
 * `supplyFrom` is kept to show what the bill says about itself.
 * @returns {{number:string, date:string, total:number, billingState:string, supplyFrom:string}}
 */
export function normalizeBill(answer) {
  const b = answer?.data?.bill ?? answer?.bill ?? null;
  if (!b || typeof b !== 'object') throw new Error('Zoho answered without a bill');
  return {
    number: String(b.bill_number ?? ''),
    date: String(b.date ?? ''),
    total: num(b.total),
    billingState: String(b.billing_address?.state ?? '').trim(),
    supplyFrom: String(b.source_of_supply ?? '').trim(),
  };
}

const stateKey = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * The bills (their transaction ids) that `party_splits` with a `bill_state` part have to read from Zoho: the bills of that contact on the part's accounts.
 * @param {Record<string,{contact:string, parts:{accounts?:string[], bill_state?:string[]}[]}>} spec
 * @param {{contactId:string, accountId:string, txnId:string, type:string, net:number}[]} rows
 */
export function billsNeeded(spec, rows) {
  const ids = new Set();
  for (const s of Object.values(spec ?? {})) {
    const byBill = (s.parts ?? []).filter((p) => (p.bill_state ?? []).length);
    if (!byBill.length) continue;
    const accounts = new Set(byBill.flatMap((p) => (p.accounts ?? []).map(String)));
    for (const r of rows) {
      if (r.contactId === String(s.contact) && r.type === 'bill' && accounts.has(r.accountId) && Math.abs(r.net) >= 0.005) ids.add(r.txnId);
    }
  }
  return [...ids];
}

/**
 * @param {{contact:string, name:string, parts:{name:string, side:'debit'|'credit', accounts?:string[], rest?:boolean, bill_state?:string[]}[]}} spec
 *   A part with `bill_state` (update-16) takes the BILLS of its accounts whose billing-address state is one of those states (the state is read from the bill itself);
 *   any other entry of its accounts (a journal, a payment) goes on to the next part.
 * @param {{contactId:string, accountId:string, txnId:string, type:string, entry:string, date:string, net:number}[]} rows   the expanded party-ledger rows (all contacts; net = debit - credit)
 * @param {Record<string,{billingState:string}>} [bills]   the bills read from Zoho, by transaction id; a bill that is not in here could not be read (then no bill of the contact is used)
 * @returns {{total:number, parts:{name:string,amount:number,rows:number}[], wrongSide:string[], rows:number, residual:number, unassigned:object[]}}
 *   amount of a part = in the direction of its `side` (an advance is a debit balance, a payable a credit balance); `total` = the contact's net (debit - credit);
 *   parts = only those that got at least one entry; wrongSide = parts whose balance is on the opposite side (then the split is not used: the sheet's line would not be that figure);
 *   unassigned / residual = the bills whose state could not be told because the bill could not be read (their amount, on the side of the part that would have taken them):
 *   the sheet then compares them in total, as before
 */
export function buildPartySplit(spec, rows, bills = {}) {
  const parts = spec.parts.map((p) => ({ name: p.name, side: p.side, amount: 0, rows: 0 }));
  const restAt = spec.parts.findIndex((p) => p.rest);
  const owns = (p, r) => (p.accounts ?? []).map(String).includes(r.accountId);
  const unassigned = [];
  let residual = 0;
  let total = 0;
  let seen = 0;
  let waitingSide = '';
  // all or nothing: if even one of the bills could not be read, none of them is used (half a split would show one line as "not found" and leave the other to look right)
  const accountsByBill = new Set(spec.parts.filter((p) => (p.bill_state ?? []).length).flatMap((p) => (p.accounts ?? []).map(String)));
  const wanted = rows.filter((r) => r.contactId === String(spec.contact) && r.type === 'bill' && accountsByBill.has(r.accountId) && Math.abs(r.net) >= 0.005);
  const known = wanted.every((r) => bills[r.txnId]) ? bills : {};
  for (const r of rows) {
    if (r.contactId !== String(spec.contact)) continue;
    seen += 1;
    total += r.net;
    if (Math.abs(r.net) < 0.005) continue;
    let k = -1;
    let waiting = -1; // the first bill_state part that would have to look at a bill we do not have
    for (let i = 0; i < spec.parts.length && k < 0; i += 1) {
      const p = spec.parts[i];
      if (p.rest || !owns(p, r)) continue;
      if (!(p.bill_state ?? []).length) { k = i; continue; }
      if (r.type !== 'bill') continue;
      const b = known[r.txnId];
      if (!b) { if (waiting < 0) waiting = i; continue; }
      if (p.bill_state.some((st) => stateKey(st) === stateKey(b.billingState))) k = i;
    }
    if (k < 0 && waiting >= 0) { // could not be told: neither in a part nor in the rest part
      waitingSide = spec.parts[waiting].side;
      residual += waitingSide === 'credit' ? -r.net : r.net;
      unassigned.push({ entry: r.entry, date: r.date, amount: r2(Math.abs(r.net)) });
      continue;
    }
    if (k < 0) k = restAt;
    if (k < 0) continue; // no part takes this account: it stays out of every part (the total still shows it)
    parts[k].amount += parts[k].side === 'credit' ? -r.net : r.net;
    parts[k].rows += 1;
  }
  // Bills left unread: what the rest part holds is only the part of the payable that does not depend on the bills (a payment, say), so on its own it says nothing
  // about its line - it joins the residual, which the sheet then compares as one combined balance
  if (unassigned.length && restAt >= 0 && waitingSide && parts[restAt].side === waitingSide) {
    residual += parts[restAt].amount;
    parts[restAt].rows = 0;
    parts[restAt].amount = 0;
  }
  const used = parts.filter((p) => p.rows > 0).map((p) => ({ name: p.name, amount: r2(p.amount), rows: p.rows, side: p.side }));
  return { total: r2(total), parts: used, wrongSide: used.filter((p) => p.amount < -SPLIT_TOLERANCE).map((p) => p.name), rows: seen, residual: r2(residual), unassigned };
}
