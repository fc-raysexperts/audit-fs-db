// Capital work-in-progress and intangibles under development, park by park (the CWIP tab).   (update-20)
//
// Zoho Books keeps two ledger accounts for them - Capital Work in Progress (1-03-001) and Intangible Asset Under Development (1-04-001) - and neither has a park column.
// Read on the real connection (General Ledger Details of the two accounts, 17-Oct-2026): 102 + 82 lines, which add up to the Trial Balance to the paisa, and
//   * almost all of the money arrived through year-end clean-up journals (JN-Clean-n, 31-Mar-2026, "Transfering ledger balance from old to new ledger"): each empties an OLD ledger
//     account into the new one, and the old account's NAME says the park ("Land Lease Dechu", "Connectivity Charges Kolayat NPD", "Civil Work Napasar", "Panchu Purchase");
//   * the auditors' own journals (SJ-1121 ... SJ-1130, 289) say the park, or what they do, in their notes ("... Capitalised of Lunkaransar Park", "... siwani park project approval
//     fees charged to P&L"); one of them (SJ-1130, "adjustment made to boundary wall & road") only moves Rs 12,01,37,795 from CWIP to IAUD;
//   * the bills carry a project ("NPD - Panchu - TL", "NPD - Dechu- Land"), a narration and a location.
// So every line of the two ledgers is given a PARK by the words in the text Zoho holds for it (config/cwip.fyYY.json `parks`). Checked against the signed sheet, the total of a park
// (both accounts together) agrees to the rupee for 12 of the 18 parks on the sheet; the other six differ by lines that name no park (or two) or that Zoho places in another park.
// A line that names no park is allocated by an entry of `allocate` (typed, visible on the tab: "the signed sheet places it there"); a known difference of placing is described by
// `elsewhere`. Nothing is guessed: what still names no park stays in `unnamed`.
//
// update-22: Zoho's REST ledger report gives ONE line per bill and account - the lines of a bill that go to the same account are added up, and the line keeps the project of only one of them
// (found on the real connection, 17-Oct-2026: 175 lines against the 184 of the connector; bill 482 of Anita Freight Carrier, three lines of Rs 2,784 for Kolayat, Bhamatsar and Pugal, came as
// one line of Rs 8,352 under Bhamatsar). So the bills behind the two accounts are read too (`GET /bills/{id}`: every line has its own project and location) and a collapsed line is put back
// into the bill's own lines before the parks are worked out (`expandBills`) - the figures all come from Zoho.
//
// Pure functions: the ledger pages, the journals and the bills are handed in (lib/snapshot.mjs reads them from Zoho).

import { num, r2 } from './util.mjs';

/** rupees: each account's ledger must add up to the Trial Balance to this, or the section is not used */
export const CWIP_TOLERANCE = 1;
/** a pinned amount matches a ledger line within this (half a paisa) */
const SAME = 0.005;
/** at most this many lines are kept in each list of the snapshot */
export const MAX_KEPT = 60;

/** " a b c " - lower case, every other character a space, so that a word is found as a whole word only */
const spaced = (s) => ` ${String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;

/** Indexes of the parks whose words are found in the text. */
export function parksIn(text, parks) {
  const t = spaced(text);
  const hits = [];
  parks.forEach((p, i) => { if ((p.words ?? []).some((w) => t.includes(spaced(w)))) hits.push(i); });
  return hits;
}

/**
 * Raw General Ledger Details pages (lib/zohoData.mjs fetchLedger with CWIP_COLUMNS) -> the lines this section needs.
 * @returns {{txnId,accountId,date,type,entry,debit,credit,amount,contact,project,description,location}[]}
 */
export function cwipLedgerRows(pages) {
  const list = Array.isArray(pages) ? pages : [pages];
  const rows = [];
  let last = null;
  for (const p of list) {
    const root = p?.data ?? p;
    const groups = root?.account_transactions;
    if (!Array.isArray(groups)) throw new Error('The ledger of the CWIP accounts has an unexpected shape (no account_transactions)');
    for (const g of groups) {
      for (const r of g.account_transactions ?? []) {
        const debit = num(r.debit);
        const credit = num(r.credit);
        rows.push({
          txnId: String(r.transaction_id ?? ''),
          accountId: String(r.account_id ?? g.group_name ?? ''),
          date: String(r.date ?? ''),
          type: String(r.transaction_type ?? ''),
          entry: String(r.entity_number ?? '').trim(),
          debit,
          credit,
          amount: debit - credit,
          contact: String(r.contact_name ?? '').trim(),
          project: String(r.project_name ?? '').trim(),
          description: String(r.description ?? '').trim(),
          location: String(r.branch?.location_name ?? '').trim(),
        });
      }
    }
    last = root.page_context ?? last;
  }
  if (last?.has_more_page === true) throw new Error('The ledger of the CWIP accounts is incomplete: the last page given still says has_more_page');
  return rows;
}

/** The journals (transaction ids) the section has to open: every journal line of the two accounts. */
export function cwipJournalsNeeded(rows) {
  return [...new Set(rows.filter((r) => r.type === 'journal' && r.txnId && Math.abs(r.amount) >= SAME).map((r) => r.txnId))];
}

/** The bills (transaction ids) the section has to open: every bill line of the two accounts (Zoho's ledger adds up the lines of a bill, so which bills have several lines is only known from the bill). */
export function cwipBillsNeeded(rows) {
  return [...new Set(rows.filter((r) => r.type === 'bill' && r.txnId && Math.abs(r.amount) >= SAME).map((r) => r.txnId))];
}

/**
 * `GET /bills/{id}` -> what the section needs of a bill: its number, its notes (the "description" of the ledger line) and its lines (account, amount before tax, project, location, text).
 * @returns {{number:string, notes:string, location:string, lines:{accountId:string, amount:number, project:string, location:string, text:string}[]}}
 */
export function normalizeCwipBill(answer) {
  const b = answer?.data?.bill ?? answer?.bill ?? null;
  if (!b || typeof b !== 'object' || !Array.isArray(b.line_items)) throw new Error('Zoho answered without a bill');
  const location = clean(b.location_name ?? b.branch_name);
  return {
    number: String(b.bill_number ?? ''),
    notes: clean(b.notes),
    location,
    lines: b.line_items.map((l) => ({
      accountId: String(l.account_id ?? ''),
      amount: num(l.item_total),
      project: clean(l.project_name),
      location: clean(l.location_name) || location,
      text: clean(l.description).slice(0, 160),
    })),
  };
}

/**
 * Puts the lines of a bill that Zoho's ledger added up back into the bill's own lines. A group of ledger lines (one bill, one account) is replaced when the bill has MORE lines for that
 * account than the ledger shows AND they add up to the ledger's amount to the paisa; each piece takes the project and location of its bill line. Anything else stays as the ledger gave it:
 * a bill that is not at hand (not read yet, or refused), a bill whose lines are already all in the ledger, a bill that no longer adds up (edited since it was kept: `unfit`).
 * @returns {{rows:object[], split:{txnId:string, entry:string, date:string, who:string, amount:number, from:number, pieces:object[]}[], unfit:string[]}}
 */
export function expandBills(rows, bills = {}) {
  const groups = new Map();
  rows.forEach((r, i) => {
    if (r.type !== 'bill' || !r.txnId) return;
    const k = `${r.txnId}|${r.accountId}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(i);
  });
  const drop = new Set();
  const put = new Map();
  const split = [];
  const unfit = [];
  for (const idx of groups.values()) {
    const first = rows[idx[0]];
    const b = bills[first.txnId];
    if (!b) continue;
    const mine = (b.lines ?? []).filter((l) => l.accountId === first.accountId && Math.abs(l.amount) >= SAME);
    if (mine.length <= idx.length) continue;
    const net = idx.reduce((t, i) => t + rows[i].amount, 0);
    if (Math.abs(mine.reduce((t, l) => t + l.amount, 0) - net) > 0.01) { unfit.push(first.txnId); continue; }
    const pieces = mine.map((l) => ({
      ...first, debit: l.amount > 0 ? l.amount : 0, credit: l.amount < 0 ? -l.amount : 0, amount: l.amount,
      project: l.project, location: l.location || first.location, description: first.description || b.notes, part: { text: l.text },
    }));
    put.set(idx[0], pieces);
    idx.slice(1).forEach((i) => drop.add(i));
    split.push({ txnId: first.txnId, entry: first.entry, date: first.date, who: first.contact, amount: r2(net), from: idx.length, pieces: pieces.length });
  }
  const out = [];
  rows.forEach((r, i) => {
    if (drop.has(i)) return;
    if (put.has(i)) out.push(...put.get(i)); else out.push(r);
  });
  return { rows: out, split, unfit };
}

/** Does the journal carry its notes and add up to the ledger line? A journal cached before update-15 has no notes; one edited after it was cached no longer fits. */
function journalFits(j, accountId, amount) {
  if (!j || !('notes' in j)) return false;
  const net = (j.lines ?? []).filter((l) => l.account_id === accountId).reduce((t, l) => t + l.debit - l.credit, 0);
  return Math.abs(net - amount) <= 0.01;
}

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * @param {{accounts:{cwip:{id,name},iaud:{id,name}}, parks:{name,words,onSheet?,why?}[], cleanup_words?:string[], allocate?:object[], elsewhere?:object[]}} spec
 * @param {ReturnType<typeof cwipLedgerRows>} rows
 * @param {Record<string,{entry_number:string,notes:string,lines:{account_id:string,name?:string,debit:number,credit:number}[]}>} journals   by transaction id
 * @param {{accounts:{id:string,closing:number}[]}} tb
 * @param {{pending?:string[], bills?:Record<string,{notes:string,location:string,lines:object[]}>}} [opt]   pending = journals and bills not read yet (a budget per refresh): the section is then not complete;
 *   bills = the bills read (normalizeCwipBill) by transaction id
 * @returns {object} the `cwip` section of the snapshot (see the end of this function), or { error } when the ledgers do not add up to the Trial Balance
 */
export function buildCwip(spec, rowsRead, journals = {}, tb = null, { pending = [], bills = {} } = {}) {
  const ids = { cwip: String(spec.accounts.cwip.id), iaud: String(spec.accounts.iaud.id) };
  const accKey = (id) => (id === ids.cwip ? 'cwip' : id === ids.iaud ? 'iaud' : null);
  const parks = spec.parks.map((p) => ({ name: p.name, onSheet: p.onSheet !== false, why: p.why ?? null, iaud: 0, cwip: 0, lines: 0, named: 0, allocated: 0 }));
  const parkByName = new Map(parks.map((p, i) => [p.name, i]));
  const waiting = new Set(pending);
  const cleanWords = (spec.cleanup_words ?? []).map(spaced);
  const pins = (spec.allocate ?? []).map((p, i) => ({ ...p, i, used: 0 }));
  const unnamed = [];
  const reclass = [];
  const reclassSeen = new Map(); // transaction id -> its entry in `reclass` (a journal between the two accounts has a line in each)
  const allocations = [];
  const stale = [];
  const kinds = new Map();
  const ledger = { cwip: 0, iaud: 0 };
  const lineCount = { cwip: 0, iaud: 0 };
  let waitingRows = 0;

  // update-22: the lines of a bill that Zoho's ledger added up are put back into the bill's own lines (expandBills); `lineCount` stays what the ledger report gave
  for (const r of rowsRead) { const k = accKey(r.accountId); if (k) lineCount[k] += 1; }
  const expanded = expandBills(rowsRead.filter((r) => !(r.type === 'bill' && waiting.has(r.txnId) && !bills[r.txnId])), bills);
  const rows = [...expanded.rows, ...rowsRead.filter((r) => r.type === 'bill' && waiting.has(r.txnId) && !bills[r.txnId])];
  const splitSeen = new Map(); // transaction id -> its entry in `billSplits`
  const billSplits = expanded.split.map((x) => { const one = { ...x, lines: [] }; splitSeen.set(x.txnId, one); return one; });
  const placed = (r, parkName) => { // a piece of a split bill: the park it went to
    const one = r.part ? splitSeen.get(r.txnId) : null;
    if (one) one.lines.push({ amount: r2(r.amount), project: r.project, text: r.part.text, park: parkName });
  };

  const kindOf = (r, j) => {
    if (r.type === 'journal') return j && cleanWords.some((w) => spaced(j.notes).includes(w)) ? ['cleanup', 'Year-end clean-up journals (old ledger moved into the new account)'] : ['journal', "Other journals (the auditors' and manual ones)"];
    if (r.type === 'bill') return ['bill', 'Bills'];
    if (r.type === 'opening_balance') return ['opening', 'Opening balance'];
    return ['other', 'Other postings (stock adjustments ...)'];
  };

  const addTo = (parkIndex, key, amount, how, split = false) => {
    const p = parks[parkIndex];
    p[key] += amount;
    p.lines += split ? 0 : 1;
    if (how === 'named') p.named += 1; else p.allocated += 1;
  };

  for (const r of rows) {
    const key = accKey(r.accountId);
    if (!key) continue; // a line of another account (the filter was not applied): the caller checks
    ledger[key] += r.amount;
    if (Math.abs(r.amount) < SAME) continue;
    if (r.type === 'bill' && waiting.has(r.txnId) && !bills[r.txnId]) { waitingRows += 1; continue; } // the bill is not read yet: its lines are not known

    const j = r.type === 'journal' ? journals[r.txnId] : null;
    const [kindKey, kindLabel] = kindOf(r, j);
    const k = kinds.get(kindKey) ?? { key: kindKey, label: kindLabel, count: 0, debit: 0, credit: 0 };
    k.count += 1; k.debit += r.debit; k.credit += r.credit;
    kinds.set(kindKey, k);

    let tier1 = '';
    let tier2 = '';
    let who = r.contact;
    if (r.type === 'journal') {
      if (waiting.has(r.txnId) && !j) { waitingRows += 1; continue; }
      if (!journalFits(j, r.accountId, r.amount)) {
        stale.push(r.txnId);
        unnamed.push({ entry: r.entry, txn: r.txnId, date: r.date, type: r.type, account: key, amount: r2(r.amount), who: '', text: j ? 'the journal does not match the ledger line' : 'the journal could not be read' });
        continue;
      }
      const others = j.lines.filter((l) => l.account_id !== ids.cwip && l.account_id !== ids.iaud);
      if (others.length === 0) { // a journal between the two accounts only (SJ-1130): it moves money from one account to the other, not between parks
        if (!reclassSeen.has(r.txnId)) {
          const to = j.lines.find((l) => l.debit > 0);
          const from = j.lines.find((l) => l.credit > 0);
          const one = { entry: r.entry, date: r.date, notes: clean(j.notes), amount: r2(Math.max(r.debit, r.credit)), from: accKey(from?.account_id) ?? '', to: accKey(to?.account_id) ?? '', lines: 0 };
          reclassSeen.set(r.txnId, one);
          reclass.push(one);
        }
        reclassSeen.get(r.txnId).lines += 1;
        continue;
      }
      tier1 = `${j.notes} | ${others.map((l) => l.name ?? '').join(' | ')}`;
      who = others.map((l) => clean(l.name)).filter(Boolean).join(' ; ') || r.contact;
    } else {
      tier1 = `${r.project} | ${r.description}`;
      tier2 = `${r.location} | ${r.contact}`;
    }

    let hits = parksIn(tier1, spec.parks);
    if (hits.length === 0 && tier2) hits = parksIn(tier2, spec.parks);
    if (hits.length === 1) { addTo(hits[0], key, r.amount, 'named'); placed(r, parks[hits[0]].name); continue; }

    // names no park (or two): an allocation of the configuration, else it stays unnamed
    const pin = pins.find((p) => ((p.entry && p.entry === r.entry) || (p.txn && p.txn === r.txnId)) && Math.abs(p.amount - Math.abs(r.amount)) <= SAME && p.used === 0);
    if (pin) {
      pin.used += 1;
      const text = clean(r.description || (j ? j.notes : ''));
      const parts = pin.parts ?? [{ park: pin.park, rest: true }];
      let left = r.amount;
      const shown = [];
      parts.forEach((part, n) => {
        const at = parkByName.get(part.park);
        if (at === undefined) return;
        const sign = r.amount < 0 ? -1 : 1;
        const piece = part.rest || n === parts.length - 1 ? left : sign * part.amount;
        left -= piece;
        addTo(at, key, piece, 'allocated', n > 0);
        shown.push({ park: part.park, amount: r2(piece) });
      });
      placed(r, shown.map((x) => x.park).join(' + '));
      allocations.push({ entry: r.entry, txn: r.txnId, date: r.date, type: r.type, account: key, amount: r2(r.amount), who: who || r.contact, text, parts: shown, why: pin.why ?? '', ambiguous: hits.length > 1 ? hits.map((h) => parks[h].name) : [] });
      continue;
    }
    unnamed.push({ entry: r.entry, txn: r.txnId, date: r.date, type: r.type, account: key, amount: r2(r.amount), who, text: clean(r.description || (j ? j.notes : '')), ambiguous: hits.map((h) => parks[h].name) });
    placed(r, null);
  }

  // the Trial Balance must agree with each account's ledger, or none of this is trusted
  const mismatch = [];
  for (const key of ['cwip', 'iaud']) {
    const acc = tb?.accounts?.find((a) => a.id === ids[key]);
    if (!acc) continue; // not in a non-zero Trial Balance: nothing to compare with
    if (Math.abs(ledger[key] - acc.closing) > CWIP_TOLERANCE) mismatch.push(`${spec.accounts[key].name}: the ledger adds up to ${r2(ledger[key])}, the Trial Balance says ${r2(acc.closing)}`);
  }
  if (mismatch.length) return { error: mismatch.join('; ') };

  const accounts = ['cwip', 'iaud'].map((key) => {
    const acc = tb?.accounts?.find((a) => a.id === ids[key]);
    return { key, id: ids[key], name: spec.accounts[key].name, ledger: r2(ledger[key]), tb: acc ? r2(acc.closing) : null, lines: lineCount[key] };
  });

  const elsewhere = (spec.elsewhere ?? []).map((e) => {
    const mine = rows.filter((r) => r.entry === e.entry && accKey(r.accountId));
    const found = mine.reduce((t, r) => t + Math.abs(r.amount), 0);
    return { entry: e.entry, amount: e.amount, zoho: e.zoho, sheet: e.sheet, why: e.why ?? '', found: Math.abs(found - e.amount) <= 0.01, who: mine[0]?.contact ?? '', date: mine[0]?.date ?? '' };
  });

  // update-22: a park that differs from the sheet by exactly the amount of a documented line (`elsewhere`, found in Zoho today) is EXPLAINED: Zoho's total less the sheet's is + the amount
  // for the park Zoho books the line to, - the amount for the park the sheet counts it under
  const explains = new Map();
  for (const e of elsewhere.filter((x) => x.found)) {
    for (const [name, sign] of [[e.zoho, 1], [e.sheet, -1]]) {
      const cur = explains.get(name) ?? { diff: 0, entries: [] };
      cur.diff += sign * e.amount;
      cur.entries.push(e.entry);
      explains.set(name, cur);
    }
  }
  const usedParks = parks.filter((p) => p.lines > 0 || Math.abs(p.iaud) >= SAME || Math.abs(p.cwip) >= SAME)
    .map((p) => ({ name: p.name, onSheet: p.onSheet, why: p.why, iaud: r2(p.iaud), cwip: r2(p.cwip), total: r2(p.iaud + p.cwip), lines: p.lines, named: p.named, allocated: p.allocated, ...(explains.has(p.name) ? { explain: { diff: r2(explains.get(p.name).diff), entries: explains.get(p.name).entries } } : {}) }));

  const pinsMissing = pins.filter((p) => p.used === 0).map((p) => p.entry ?? p.txn);
  const unnamedSum = r2(unnamed.reduce((t, u) => t + u.amount, 0));
  return {
    title: 'CWIP and intangibles under development, park by park',
    complete: pending.length === 0 && waitingRows === 0,
    pending: pending.length,
    accounts,
    parks: usedParks,
    unnamed: unnamed.slice(0, MAX_KEPT),
    unnamedCount: unnamed.length,
    unnamedSum,
    allocations: allocations.slice(0, MAX_KEPT),
    reclass,
    elsewhere,
    billSplits: billSplits.slice(0, MAX_KEPT),
    billsUnfit: [...new Set(expanded.unfit)],
    pinsMissing,
    kinds: [...kinds.values()].map((k) => ({ key: k.key, label: k.label, count: k.count, debit: r2(k.debit), credit: r2(k.credit), net: r2(k.debit - k.credit) })),
    stale: [...new Set(stale)],
    rows: rowsRead.length,
    lines: rows.length,
  };
}
