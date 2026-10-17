// update-20: the CWIP tab - capital work in progress and intangibles under development, park by park (lib/cwip.mjs).
// Made-up ledgers for the rules; the real FY26 ledgers (fixtures/cwip_fy26.json) for the figures. The real ones are skipped without fixtures/.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCwip, cwipBillsNeeded, cwipJournalsNeeded, cwipLedgerRows, expandBills, normalizeCwipBill, parksIn } from '../lib/cwip.mjs';
import { loadConfig } from '../lib/config.mjs';
import { buildSnapshot } from '../lib/snapshot.mjs';
import { replayZoho, haveFixtures } from '../testing/fakes.mjs';

const C = 'cw1';
const I = 'ia1';
const spec = {
  accounts: { cwip: { id: C, name: 'Capital Work in Progress' }, iaud: { id: I, name: 'Intangible Asset Under Development' } },
  cleanup_words: ['transfering ledger balance'],
  parks: [
    { name: 'Alpha', words: ['alpha'] },
    { name: 'Beta Nagar', words: ['beta nagar', 'b nagar'] },
    { name: 'Gamma', words: ['gamma', 'gama'], onSheet: false, why: 'capitalised in full' },
  ],
  allocate: [],
  elsewhere: [],
};

/** one ledger line in the shape of Zoho's General Ledger Details */
let n = 0;
const line = (o) => ({
  date: '2026-03-31', transaction_id: o.id ?? `t${++n}`, transaction_type: o.type ?? 'bill', entity_number: o.entry ?? `E${n}`, account_id: o.acc ?? C,
  debit: o.debit ?? '', credit: o.credit ?? '', contact_name: o.contact ?? '', project_name: o.project ?? '', description: o.description ?? '', branch: { location_name: o.location ?? 'Head Office' },
});
const pages = (...rows) => ({ data: { account_transactions: [{ group_name: 'x', account_transactions: rows }], page_context: { page: 1, has_more_page: false } } });
const rowsOf = (...r) => cwipLedgerRows(pages(...r));
/** a journal in the shape lib/gl.mjs normalizeJournal gives */
const journal = (id, notes, legs) => ({ entry_number: id, notes, lines: legs.map(([account_id, name, debit, credit]) => ({ account_id, name, debit, credit })) });
const tbOf = (cwip, iaud) => ({ accounts: [{ id: C, closing: cwip }, { id: I, closing: iaud }] });

test('a park is found by whole words only, in any of its spellings, and two parks in one text are both reported', () => {
  assert.deepEqual(parksIn('NPD- Alpha park - Transmission line', spec.parks), [0]);
  assert.deepEqual(parksIn('Land Lease B-Nagar', spec.parks), [1], 'punctuation is a space: "B-Nagar" is "b nagar"');
  assert.deepEqual(parksIn('Gama land', spec.parks), [2], 'a spelling the staff use');
  assert.deepEqual(parksIn('Alphabet Services', spec.parks), [], 'a longer word is not the park');
  assert.deepEqual(parksIn('from Alpha to Gamma', spec.parks), [0, 2]);
  assert.deepEqual(parksIn('', spec.parks), []);
});

test('the ledger pages are read into lines; a page that says more follows, or an unexpected shape, is refused', () => {
  const rows = cwipLedgerRows(pages(line({ id: 'a', debit: 100, project: 'Alpha' }), line({ id: 'b', acc: I, credit: 40, contact: 'Raja' })));
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].amount, rows[1].amount, rows[1].accountId, rows[1].contact, rows[0].project, rows[0].location], [100, -40, I, 'Raja', 'Alpha', 'Head Office']);
  assert.throws(() => cwipLedgerRows({ data: { account_transactions: [{ account_transactions: [] }], page_context: { has_more_page: true } } }), /incomplete/);
  assert.throws(() => cwipLedgerRows({ data: {} }), /unexpected shape/);
  assert.equal(cwipLedgerRows([pages(line({ debit: 1 })), pages(line({ debit: 2 }))]).length, 2, 'several pages are put together');
});

test('only the journals behind journal lines are needed, each once, and a line of nil is not worth a journal', () => {
  const rows = rowsOf(line({ id: 'j1', type: 'journal', debit: 10 }), line({ id: 'j1', type: 'journal', acc: I, debit: 5 }), line({ id: 'b1', debit: 7 }), line({ id: 'j2', type: 'journal', debit: 0, credit: 0 }));
  assert.deepEqual(cwipJournalsNeeded(rows), ['j1']);
});

test('a bill is placed by its project and narration first; its branch and supplier only when those name no park', () => {
  const rows = rowsOf(
    line({ debit: 100, project: 'NPD - Alpha - TL', description: 'tower', location: 'Gamma' }), // the project wins over the branch
    line({ debit: 200, project: '', description: '', contact: 'Beta Nagar Civil Works', location: 'Head Office' }), // nothing in the text: the supplier names it
    line({ debit: 300, acc: I, project: 'Hind Chemisales', description: 'land at Gamma' }),
  );
  const r = buildCwip(spec, rows, {}, tbOf(300, 300));
  const by = Object.fromEntries(r.parks.map((p) => [p.name, p]));
  assert.deepEqual([by.Alpha.cwip, by['Beta Nagar'].cwip, by.Gamma.iaud], [100, 200, 300]);
  assert.deepEqual([by.Alpha.named, by.Alpha.allocated, by.Alpha.lines], [1, 0, 1]);
  assert.equal(r.unnamedCount, 0);
  assert.equal(r.complete, true);
  assert.deepEqual(r.parks.map((p) => p.onSheet), [true, true, false], 'a park that is not on the signed sheet is still shown, with its reason');
  assert.equal(r.parks[2].why, 'capitalised in full');
});

test('a clean-up journal is placed by the name of the old ledger account it emptied, and the other journals by their notes', () => {
  const rows = rowsOf(
    line({ id: 'j1', type: 'journal', entry: 'JN-Clean-1', acc: I, debit: 500 }),
    line({ id: 'j2', type: 'journal', entry: 'SJ-1', debit: 70, credit: '' }),
    line({ id: 'j3', type: 'journal', entry: 'SJ-2', debit: '', credit: 20 }),
  );
  const js = {
    j1: journal('JN-Clean-1', 'Transfering ledger balance from old to new ledger', [[I, 'Intangible Asset Under Development', 500, 0], ['old', 'Civil Work Beta Nagar', 0, 500]]),
    j2: journal('SJ-1', 'being cost of Alpha park capitalised', [[C, 'Capital Work in Progress', 70, 0], ['x', 'Creditors', 0, 70]]),
    j3: journal('SJ-2', 'credit note', [[C, 'Capital Work in Progress', 0, 20], ['x', 'Gamma Land Lease', 20, 0]]),
  };
  const r = buildCwip(spec, rows, js, tbOf(50, 500));
  const by = Object.fromEntries(r.parks.map((p) => [p.name, p]));
  assert.deepEqual([by['Beta Nagar'].iaud, by.Alpha.cwip, by.Gamma.cwip], [500, 70, -20]);
  assert.deepEqual(r.kinds.map((k) => [k.key, k.count]), [['cleanup', 1], ['journal', 2]], 'the clean-up journals are told from the others by their notes');
});

test('a journal between the two accounts only moves money from one to the other: it is in no park and is listed on its own', () => {
  const rows = rowsOf(line({ id: 'j9', type: 'journal', entry: 'SJ-1130', acc: C, credit: 1000 }), line({ id: 'j9', type: 'journal', entry: 'SJ-1130', acc: I, debit: 1000 }), line({ debit: 50, project: 'Alpha' }));
  const js = { j9: journal('SJ-1130', 'adjustment made to boundary wall & road', [[C, 'Capital Work in Progress', 0, 1000], [I, 'Intangible Asset Under Development', 1000, 0]]) };
  const r = buildCwip(spec, rows, js, tbOf(-950, 1000));
  assert.deepEqual(r.reclass, [{ entry: 'SJ-1130', date: '2026-03-31', notes: 'adjustment made to boundary wall & road', amount: 1000, from: 'cwip', to: 'iaud', lines: 2 }]);
  assert.deepEqual(r.parks.map((p) => [p.name, p.total]), [['Alpha', 50]]);
  assert.deepEqual(r.accounts.map((a) => [a.key, a.ledger, a.tb, a.lines]), [['cwip', -950, -950, 2], ['iaud', 1000, 1000, 1]]);
});

test('a line that names no park, or two, is allocated only by a pin of the configuration that fits its entry and amount - and each pin once', () => {
  const rows = rowsOf(
    line({ entry: 'B-1', debit: 1000, description: 'no park here' }),
    line({ entry: 'B-2', debit: 400, description: 'from Alpha to Gamma' }), // two parks
    line({ entry: 'B-3', debit: 900, description: 'nothing' }), // amount differs from the pin
    line({ entry: 'B-1', debit: 1000, description: 'the same entry again' }), // the pin has been used
    line({ entry: 'B-4', debit: 600, description: 'shared' }),
  );
  const pinned = { ...spec, allocate: [
    { entry: 'B-1', amount: 1000, park: 'Alpha', why: 'the signed sheet has it there' },
    { entry: 'B-2', amount: 400, park: 'Gamma' },
    { entry: 'B-3', amount: 901, park: 'Alpha' },
    { entry: 'B-4', amount: 600, parts: [{ park: 'Alpha', amount: 150 }, { park: 'Beta Nagar', rest: true }] },
    { entry: 'B-9', amount: 5, park: 'Alpha' },
  ] };
  const r = buildCwip(pinned, rows, {}, tbOf(3900, 0));
  const by = Object.fromEntries(r.parks.map((p) => [p.name, p]));
  assert.deepEqual([by.Alpha.cwip, by.Gamma.cwip, by['Beta Nagar'].cwip], [1000 + 150, 400, 450]);
  assert.deepEqual([by.Alpha.allocated, by.Alpha.named], [2, 0]);
  assert.equal(by.Alpha.lines, 2, 'a line split over two parks counts once, in the first');
  assert.deepEqual(r.allocations.map((a) => [a.entry, a.amount, a.parts.map((p) => `${p.park}:${p.amount}`).join(',')]), [['B-1', 1000, 'Alpha:1000'], ['B-2', 400, 'Gamma:400'], ['B-4', 600, 'Alpha:150,Beta Nagar:450']]);
  assert.deepEqual(r.allocations[1].ambiguous, ['Alpha', 'Gamma'], 'the two parks it names are said');
  assert.deepEqual(r.unnamed.map((u) => [u.entry, u.amount]), [['B-3', 900], ['B-1', 1000]], 'the amount that does not fit the pin and the second use of an entry stay unnamed');
  assert.equal(r.unnamedCount, 2);
  assert.equal(r.unnamedSum, 1900);
  assert.deepEqual(r.pinsMissing, ['B-3', 'B-9'], 'the pins that found nothing');
});

test('a credit is allocated by its size, not its sign, and a pin can be keyed by the Zoho transaction id', () => {
  const rows = rowsOf(line({ id: 'zz1', entry: 'NA', credit: 300, description: 'stock back out' }));
  const r = buildCwip({ ...spec, allocate: [{ txn: 'zz1', amount: 300, park: 'Alpha' }] }, rows, {}, tbOf(-300, 0));
  assert.equal(r.parks[0].cwip, -300);
  assert.equal(r.allocations[0].amount, -300);
});

test('journals not read yet leave the section incomplete and their lines are not counted as unnamed', () => {
  const rows = rowsOf(line({ id: 'j1', type: 'journal', entry: 'SJ-1', debit: 70 }), line({ debit: 30, project: 'Alpha' }));
  const r = buildCwip(spec, rows, {}, tbOf(100, 0), { pending: ['j1'] });
  assert.deepEqual([r.complete, r.pending, r.unnamedCount], [false, 1, 0]);
  assert.equal(r.parks[0].total, 30);
  assert.equal(r.accounts[0].ledger, 100, 'the ledger is still the whole ledger');
});

test('a journal that no longer fits its ledger line (edited since it was kept) or has no notes is listed as stale, not guessed', () => {
  const rows = rowsOf(line({ id: 'j1', type: 'journal', entry: 'SJ-1', debit: 70 }), line({ id: 'j2', type: 'journal', entry: 'SJ-2', debit: 80 }));
  const js = {
    j1: journal('SJ-1', 'Alpha park', [[C, 'Capital Work in Progress', 99, 0], ['x', 'Creditors', 0, 99]]), // 99 against 70
    j2: { entry_number: 'SJ-2', lines: [{ account_id: C, name: 'Capital Work in Progress', debit: 80, credit: 0 }, { account_id: 'x', name: 'Alpha', debit: 0, credit: 80 }] }, // cached before the notes were kept
  };
  const r = buildCwip(spec, rows, js, tbOf(150, 0));
  assert.deepEqual(r.stale, ['j1', 'j2']);
  assert.equal(r.unnamedCount, 2);
  assert.match(r.unnamed[0].text, /does not match/);
  assert.equal(r.parks.length, 0);
});

test('a journal that could not be opened is said so', () => {
  const rows = rowsOf(line({ id: 'j1', type: 'journal', entry: 'SJ-1', debit: 70 }));
  const r = buildCwip(spec, rows, {}, tbOf(70, 0));
  assert.match(r.unnamed[0].text, /could not be read/);
});

test('each account has to add up to the Trial Balance, or nothing of the section is used', () => {
  const rows = rowsOf(line({ debit: 100, project: 'Alpha' }), line({ acc: I, debit: 50, project: 'Alpha' }));
  assert.equal(buildCwip(spec, rows, {}, tbOf(100, 50)).error, undefined);
  assert.equal(buildCwip(spec, rows, {}, tbOf(100.9, 50)).error, undefined, 'within Re 1');
  const bad = buildCwip(spec, rows, {}, tbOf(100, 60));
  assert.match(bad.error, /Intangible Asset Under Development: the ledger adds up to 50, the Trial Balance says 60/);
  assert.equal(buildCwip(spec, rows, {}, { accounts: [] }).accounts[0].tb, null, 'an account that is not in the Trial Balance has nothing to compare with');
  assert.equal(buildCwip(spec, rows, {}, null).error, undefined);
});

test('a difference of placing between Zoho and the signed sheet is listed with the figures of the configuration, and says whether the entry is still there', () => {
  const rows = rowsOf(line({ entry: 'ES1', debit: 84, project: 'Alpha', contact: 'Electrico' }));
  const r = buildCwip({ ...spec, elsewhere: [{ entry: 'ES1', amount: 84, zoho: 'Alpha', sheet: 'Gamma', why: 'one bill' }, { entry: 'ES9', amount: 5, zoho: 'Alpha', sheet: 'Gamma' }] }, rows, {}, tbOf(84, 0));
  assert.deepEqual(r.elsewhere.map((e) => [e.entry, e.found, e.who, e.zoho, e.sheet]), [['ES1', true, 'Electrico', 'Alpha', 'Gamma'], ['ES9', false, '', 'Alpha', 'Gamma']]);
});

test('the kinds of posting are counted and a line of another account (the filter was not applied) is left out of everything', () => {
  const rows = rowsOf(line({ debit: 100, project: 'Alpha' }), line({ type: 'inventory_adjustment', debit: 30, description: 'Alpha stock' }), line({ acc: 'other', debit: 999, project: 'Alpha' }));
  const r = buildCwip(spec, rows, {}, tbOf(130, 0));
  assert.deepEqual(r.kinds.map((k) => [k.key, k.count, k.net]), [['bill', 1, 100], ['other', 1, 30]]);
  assert.equal(r.parks[0].total, 130);
});

test('only the first 60 lines of a list are kept in the snapshot, with the true count and sum', () => {
  const rows = rowsOf(...Array.from({ length: 70 }, () => line({ debit: 10, description: 'no park' })));
  const r = buildCwip(spec, rows, {}, tbOf(700, 0));
  assert.deepEqual([r.unnamed.length, r.unnamedCount, r.unnamedSum], [60, 70, 700]);
});

// ---------- the real FY26 ledgers ----------

const skip = !haveFixtures();
const config = loadConfig('2025-26');
const NOW = Date.parse('2026-10-15T06:30:00+05:30');

test('the real FY26 ledgers: both accounts add up to the Trial Balance, every line is placed, and the parks agree with the signed sheet', { skip }, async () => {
  const snap = await buildSnapshot({ zoho: replayZoho(), config, fy: '2025-26', now: () => NOW });
  const c = snap.cwip;
  assert.equal(c.error, undefined);
  // update-22: the ledger report of the real connection gives 175 lines (one per bill and account); the 6 bills with several lines are put back into their own lines: 184 postings
  assert.deepEqual([c.complete, c.pending, c.rows, c.lines, c.unnamedCount, c.pinsMissing, c.stale, c.billsUnfit, c.billsUnread], [true, 0, 175, 184, 0, [], [], [], 0]);
  assert.deepEqual(c.accounts.map((a) => [a.key, a.lines, a.ledger, a.tb]), [['cwip', 93, 154285531.55, 154285531.55], ['iaud', 82, 254822808.18, 254822808.18]]);
  assert.deepEqual(c.kinds.map((k) => [k.key, k.count]), [['bill', 44], ['journal', 11], ['cleanup', 127], ['other', 2]]);
  assert.deepEqual(c.reclass.map((x) => [x.entry, x.amount, x.from, x.to, x.lines]), [['SJ-1130', 120137795, 'cwip', 'iaud', 2]]);
  // the parks add up to the two ledgers (the reclass moves money between the accounts, so it does not change the sum)
  const sum = c.parks.reduce((t, p) => t + p.total, 0);
  assert.ok(Math.abs(sum - (154285531.55 + 254822808.18)) < 0.05, `the parks add up to the ledgers (${sum})`);
  const by = Object.fromEntries(c.parks.map((p) => [p.name, p]));
  assert.equal(c.parks.length, 21, '18 parks of the sheet + the 3 that are not on it');
  assert.deepEqual(c.parks.filter((p) => !p.onSheet).map((p) => p.name), ['Lunkaransar', 'Siwani', 'Ramgarh']);
  for (const p of c.parks.filter((x) => !x.onSheet)) assert.ok(Math.abs(p.total) < 0.5, `${p.name} is capitalised or charged off in full (${p.total})`);
  assert.equal(c.allocations.length, 10, 'the lines of the configuration (pins) that found their ledger line');
  assert.equal(c.allocations.reduce((t, a) => t + a.parts.length, 0), 11, 'one of them is shared by two parks');
  assert.ok(Math.abs(by.Dechu.total - 220744623.15) < 0.01);
  assert.ok(Math.abs(by.Panchu.total - 1263672) < 1);
  assert.deepEqual(c.elsewhere.map((e) => [e.entry, e.amount, e.found]), [['ES2526893', 84000, true]]);
  // update-22: the park totals are the ones of the signed sheet - Pugal, Kolayat and Bhamatsar each have their own line of the 3-line freight bill 482
  assert.ok(Math.abs(by.Pugal.total - 27637835.58) < 0.01);
  assert.ok(Math.abs(by.Bhamatsar.total - 13789139) < 0.01);
  assert.ok(Math.abs(by.Kolayat.total - 42812200.14) < 0.01);
  assert.deepEqual([by.Pugal.lines, by.Bhamatsar.lines, by.Kolayat.lines], [8, 7, 15]);
  assert.deepEqual(Object.fromEntries(c.parks.filter((p) => p.explain).map((p) => [p.name, p.explain])), { Kolayat: { diff: 84000, entries: ['ES2526893'] }, Bhamatsar: { diff: -84000, entries: ['ES2526893'] } });
});

test('the real FY26 ledgers: the same parks whether the ledger gives every bill line or (as the real connection does) one line per bill and account', { skip }, async () => {
  const rest = await buildSnapshot({ zoho: replayZoho(), config, fy: '2025-26', now: () => NOW });
  const conn = await buildSnapshot({ zoho: replayZoho({ cwipKeepBillLines: true }), config, fy: '2025-26', now: () => NOW });
  assert.deepEqual([rest.cwip.rows, conn.cwip.rows, rest.cwip.lines, conn.cwip.lines], [175, 184, 184, 184]);
  const shape = (c) => c.parks.map((p) => [p.name, p.iaud, p.cwip, p.total, p.lines, p.named, p.allocated]);
  assert.deepEqual(shape(rest.cwip), shape(conn.cwip), 'every park has the same lines and the same money');
  assert.deepEqual(conn.cwip.billSplits, [], 'a ledger that already has every line needs no splitting');
  // the six bills that have several lines for one account, put back into their lines
  assert.deepEqual(rest.cwip.billSplits.map((b) => [b.entry, b.from, b.pieces, b.amount]).sort(), [['182', 1, 2, 20000], ['28', 1, 2, 236000], ['482', 1, 3, 8352], ['9/2025-26', 1, 4, 156000], ['ES2526893', 1, 2, 84000], ['TI/78', 1, 2, 66950]]);
  const b482 = rest.cwip.billSplits.find((b) => b.entry === '482');
  assert.deepEqual(b482.lines.map((l) => [l.park, l.amount]).sort(), [['Bhamatsar', 2784], ['Kolayat', 2784], ['Pugal', 2784]]);
});

test('the real FY26 ledgers: if the bills cannot be read the ledger lines stay as Zoho gives them - the three parks of bill 482 then differ, and an alert says why', { skip }, async () => {
  const snap = await buildSnapshot({ zoho: replayZoho({ cwipBillsFail: 'all' }), config, fy: '2025-26', now: () => NOW });
  const c = snap.cwip;
  assert.equal(c.error, undefined);
  assert.deepEqual([c.complete, c.rows, c.lines, c.billsUnread, c.billSplits.length], [true, 175, 175, 35, 0]);
  const by = Object.fromEntries(c.parks.map((p) => [p.name, p]));
  // what the user saw on the real connection before update-22 (CWIP - RPEL.pdf of 17-Oct-2026)
  assert.ok(Math.abs(by.Pugal.total - 27635051.58) < 0.01, 'Pugal: 2,784 less');
  assert.ok(Math.abs(by.Bhamatsar.total - 13794707) < 0.01, 'Bhamatsar: 5,568 more');
  assert.ok(Math.abs(by.Kolayat.total - 42809416.14) < 0.01, 'Kolayat: 2,784 less');
  assert.deepEqual([by.Pugal.lines, by.Bhamatsar.lines, by.Kolayat.lines, by.Panchu.lines, by.Dechu.lines, by.Lunkaransar.lines], [7, 7, 13, 34, 28, 36]);
  assert.equal(c.accounts[0].lines + c.accounts[1].lines, 175);
  const alert = snap.alerts.find((a) => a.code === 'CWIP_BILL_UNREAD');
  assert.equal(alert?.level, 'info');
  assert.match(alert.message, /35 bill\(s\)/);
});

test('a bill with several lines for one account: the ledger gives one line with the project of one of them, the bill gives each its own', () => {
  const rows = rowsOf(
    line({ id: 'b1', debit: 300, project: 'NPD Alpha', contact: 'Freight Co', entry: '482' }),
    line({ id: 'b2', debit: 50, project: 'NPD Beta Nagar', contact: 'Other Co', entry: '17' }),
  );
  assert.deepEqual(cwipBillsNeeded(rows), ['b1', 'b2']);
  const bill = normalizeCwipBill({ data: { bill: { bill_number: '482', notes: 'freight', location_name: 'Head Office', line_items: [
    { account_id: C, item_total: 100, project_name: 'NPD Alpha', description: 'freight to alpha' },
    { account_id: C, item_total: 100, project_name: 'NPD Beta Nagar', location_name: 'Beta Nagar' },
    { account_id: C, item_total: 100, project_name: 'NPD Beta Nagar' },
    { account_id: 'other', item_total: 55, project_name: 'NPD Alpha' }, // a line of another account is not part of this ledger line
  ] } } });
  assert.deepEqual([bill.number, bill.notes, bill.lines.length, bill.lines[1].location, bill.lines[2].location, bill.lines[0].text], ['482', 'freight', 4, 'Beta Nagar', 'Head Office', 'freight to alpha']);

  const x = expandBills(rows, { b1: bill });
  assert.deepEqual(x.rows.map((r) => [r.txnId, r.amount, r.project]), [['b1', 100, 'NPD Alpha'], ['b1', 100, 'NPD Beta Nagar'], ['b1', 100, 'NPD Beta Nagar'], ['b2', 50, 'NPD Beta Nagar']]);
  assert.deepEqual(x.split.map((b) => [b.entry, b.from, b.pieces, b.amount]), [['482', 1, 3, 300]]);
  assert.deepEqual(x.unfit, []);

  const without = buildCwip(spec, rows, {}, tbOf(350, 0));
  assert.deepEqual(without.parks.map((p) => [p.name, p.total, p.lines]), [['Alpha', 300, 1], ['Beta Nagar', 50, 1]], 'as the ledger gives it, all of the bill is in one park');
  const done = buildCwip(spec, rows, {}, tbOf(350, 0), { bills: { b1: bill } });
  assert.deepEqual(done.parks.map((p) => [p.name, p.total, p.lines]), [['Alpha', 100, 1], ['Beta Nagar', 250, 3]]);
  assert.deepEqual([done.rows, done.lines, done.accounts[0].lines], [2, 4, 2], 'two ledger lines, four postings');
  assert.deepEqual(done.billSplits.map((b) => [b.entry, b.who, b.lines.map((l) => [l.amount, l.park])]), [['482', 'Freight Co', [[100, 'Alpha'], [100, 'Beta Nagar'], [100, 'Beta Nagar']]]]);

  // a bill that is not read yet: the section is not complete and the lines of that bill wait; the TB check still sees them
  const waiting = buildCwip(spec, rows, {}, tbOf(350, 0), { pending: ['b1'] });
  assert.deepEqual([waiting.complete, waiting.pending, waiting.parks.map((p) => [p.name, p.total])], [false, 1, [['Beta Nagar', 50]]]);

  // a bill that no longer adds up to its ledger line (edited since it was kept): the ledger line stays and the bill is listed
  const edited = { ...bill, lines: bill.lines.map((l, i) => (i === 0 ? { ...l, amount: 90 } : l)) };
  const unfit = buildCwip(spec, rows, {}, tbOf(350, 0), { bills: { b1: edited } });
  assert.deepEqual([unfit.billsUnfit, unfit.parks.map((p) => [p.name, p.total])], [['b1'], [['Alpha', 300], ['Beta Nagar', 50]]]);

  // a bill whose lines are all in the ledger already: nothing to do
  const all = rowsOf(line({ id: 'b3', debit: 100, project: 'NPD Alpha' }), line({ id: 'b3', debit: 100, project: 'NPD Beta Nagar' }));
  const same = expandBills(all, { b3: normalizeCwipBill({ bill: { line_items: [{ account_id: C, item_total: 100, project_name: 'NPD Alpha' }, { account_id: C, item_total: 100, project_name: 'NPD Beta Nagar' }] } }) });
  assert.deepEqual([same.rows.length, same.split], [2, []]);
  assert.throws(() => normalizeCwipBill({ data: { code: 0 } }), /without a bill/);
});
