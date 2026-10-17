// Advances from customers (lib/advances.mjs): the unused amounts of customer payments, customer by customer, against the signed list.
import test from 'node:test';
import assert from 'node:assert/strict';
import { unusedByCustomer, advanceLinesOfSheet, compareAdvances } from '../lib/advances.mjs';

const pay = (customer_id, customer_name, date, unused_amount, extra = {}) => ({ customer_id, customer_name, date, amount: unused_amount + 10, unused_amount, bcy_unused_amount: unused_amount, ...extra });
const page = (list, more = false) => ({ data: { code: 0, customerpayments: list, page_context: { has_more_page: more } } });

test('unused amounts are added up per customer, over all pages, up to the balance sheet date; applied payments and later payments do not count', () => {
  const pages = [
    page([pay('1', 'Alpha Ltd', '2026-03-30', 1000), pay('2', 'Beta', '2026-03-31', 0), pay('1', 'Alpha Ltd', '2026-01-02', 500.5)], true),
    page([pay('3', 'Gamma', '2026-04-01', 9999), pay('4', 'Delta', '2025-05-05', 70, { bcy_unused_amount: 5800 })]),
  ];
  const u = unusedByCustomer(pages, { asOf: '2026-03-31' });
  assert.deepEqual(u.customers.map((c) => [c.name, c.unused, c.payments]), [['Delta', 5800, 1], ['Alpha Ltd', 1500.5, 2]], 'a foreign payment counts in the books\' currency');
  assert.equal(u.total, 7300.5);
  assert.deepEqual([u.seen, u.later, u.payments], [5, 1, 3]);
  assert.throws(() => unusedByCustomer({ data: { code: 0 } }, { asOf: '2026-03-31' }), /unexpected shape/);
});

test('the lines of the signed list are read up to its Total', () => {
  const rows = [['Detail of Advance from Customer as on 31-03-2026'], ['S.No.', 'Particulars', null, null, 'Amount (Rs.)'], [1, 'Aamina', null, null, 500], [2, 'ALLIANCE  POLYSACKS PRIVATE LIMITED', null, null, 9408000], [null, 'Total', null, null, 9408500], ['Detail of Statutory Liabilities'], [null, 'Never read', null, null, 1]];
  assert.deepEqual(advanceLinesOfSheet(rows), [{ label: 'Aamina', signed: 500 }, { label: 'ALLIANCE  POLYSACKS PRIVATE LIMITED', signed: 9408000 }]);
  assert.throws(() => advanceLinesOfSheet([['Something else']]), /not found/);
});

test('the comparison says which customers agree, which differ, which are only on one side, and how much of the signed total Zoho explains', () => {
  const customers = [{ name: 'Alliance Polysacks Pvt. Ltd.', unused: 9408000.4 }, { name: 'Aamina', unused: 400 }, { name: 'Only In Zoho', unused: 77 }];
  const lines = [{ label: 'ALLIANCE  POLYSACKS PVT LTD', signed: 9408000 }, { label: 'Aamina', signed: 500 }, { label: 'Only on the sheet', signed: 1000 }];
  const c = compareAdvances(customers, lines);
  assert.deepEqual([c.same.length, c.differ.length, c.missing.length, c.extra.length], [1, 1, 1, 1]);
  assert.equal(c.differ[0].diff, -100);
  assert.equal(c.signedTotal, 9409500);
  assert.equal(Math.round(c.explained), 9408000 + 400);
  assert.equal(c.extra[0].name, 'Only In Zoho');
});

// ---------------------------------------------------------------- the ledger route (lib/advances.mjs ledgerAdvances / advanceModel, lib/advanceProbe.mjs)
import { ledgerAdvances, advanceModel } from '../lib/advances.mjs';
import { runAdvanceLedgerProbe, formatAdvanceProbe } from '../lib/advanceProbe.mjs';
import { buildSnapshot } from '../lib/snapshot.mjs';
import { loadConfig } from '../lib/config.mjs';
import { normalizeARAging } from '../lib/receivables.mjs';
import { replayZoho, haveFixtures, J, syntheticAdvanceRows } from '../testing/fakes.mjs';

const glRow = (contactId, contactName, date, net, accountId = 'ADV') => ({ txnId: 't', accountId, contactId, contactName, type: 'x', entry: '', date, net });

test('the ledger advance of a customer is its credit balance up to the balance sheet date; later lines and other accounts are left out', () => {
  const rows = [
    glRow('1', 'Alpha Ltd', '2026-01-05', -1000), glRow('1', 'Alpha Ltd', '2026-03-01', 250), // received 1000, 250 applied to an invoice
    glRow('2', 'Beta', '2026-02-02', -400), glRow('2', 'Beta', '2026-02-20', 400),             // received and applied: nothing left
    glRow('3', 'Gamma', '2026-02-03', 90),                                                    // applied more than received: a debit balance
    glRow('4', 'Delta', '2026-04-01', -777),                                                  // after the balance sheet date
    glRow('5', 'Other', '2026-01-01', -5, 'OTHER'),                                            // another account
    glRow('-1', '', '2026-03-05', -30),                                                       // no customer on the line
  ];
  const l = ledgerAdvances(rows, { asOf: '2026-03-31', accountId: 'ADV' });
  assert.deepEqual(l.customers.map((c) => [c.id, c.name, c.ledger]), [['1', 'Alpha Ltd', 750], ['-1', '', 30], ['3', 'Gamma', -90]]);
  assert.equal(l.total, 690);
  assert.equal(l.later, 1);
});

test('the advance as signed = ledger + hand-netting + the credit of a customer whose receivable is below zero; the total is the plug of the statements', () => {
  const ledger = [{ id: '1', name: 'Alpha', ledger: 1000 }, { id: '2', name: 'Beta', ledger: 300 }, { id: '9', name: 'Nine', ledger: 40 }];
  const receivables = [
    { id: '1', name: 'Alpha', zb_total: 600, adjustment: -600 },   // netted: its advance falls by 600
    { id: '3', name: 'Three', zb_total: -25, adjustment: 0 },       // in credit: shows as an advance of 25
    { id: '4', name: 'Four', zb_total: 80, adjustment: -80 },       // netted against something that is not in the ledger: a negative result
    { id: '5', name: 'Five', zb_total: 10, adjustment: 0 },         // nothing to say
  ];
  const m = advanceModel(ledger, receivables);
  assert.deepEqual(m.customers.map((c) => [c.id, c.advance]).sort(), [['1', 400], ['2', 300], ['3', 25], ['4', -80], ['9', 40]]);
  assert.equal(m.ledgerTotal, 1340);
  assert.equal(m.nettedTotal, -680);
  assert.equal(m.creditTotal, 25);
  assert.equal(m.total, 1340 - 680 + 25);
  assert.deepEqual(m.negative.map((c) => c.id), ['4']);
});

test('a sheet line and a customer with the same figure but another spelling are paired; a figure that two lines share is not guessed', () => {
  const customers = [{ name: 'Wonder Cement Limited (Phase 2)', unused: 1000500 }, { name: 'Twin One', unused: 777 }, { name: 'Twin Two', unused: 777 }];
  const lines = [{ label: 'WONDER CEMENT LTD PHASE-II', signed: 1000500 }, { label: 'Sheet Twin A', signed: 777 }, { label: 'Sheet Twin B', signed: 777 }];
  const c = compareAdvances(customers, lines);
  assert.deepEqual(c.renamed.map((x) => [x.label, x.name]), [['WONDER CEMENT LTD PHASE-II', 'Wonder Cement Limited (Phase 2)']]);
  assert.deepEqual([c.same.length, c.missing.length, c.extra.length], [0, 2, 2]);
  assert.equal(c.explained, 1000500);
});

// ---- the whole probe, on the saved FY26 books with an invented "Advance from debtors" ledger that adds up to its real Trial Balance figure
const skipFix = !haveFixtures();
const ADV_ID = '2346113000000000617';
const TB_CLOSING = 577824040.44; // credit
const advanceLedgerZoho = (base, { rows, journals = {} }) => ({
  ...base,
  async get(p, query = {}) {
    if (p === '/reports/generalledgerdetails' && (query.rule?.columns?.[0]?.value ?? []).includes(ADV_ID)) {
      base.stats.calls++;
      return { data: { account_transactions: [{ account_transactions: rows }], page_context: { page: 1, total: rows.length, has_more_page: false, from_date: query.from_date, to_date: query.to_date } } };
    }
    if (p.startsWith('/journals/') && journals[p.slice(10)]) return { data: { journal: journals[p.slice(10)] } };
    return base.get(p, query);
  },
});
const cr = (cid, name, amount, date = '2026-02-10') => ({ date, transaction_id: 'T' + cid, transaction_type: 'customer_payment', entity_number: '', debit: '', credit: amount, contact_id: cid, contact_name: name, account_id: ADV_ID, account_name: 'Advance from debtors' });

test('the ledger probe: customer by customer, the total equals the plug of the statements, and the report lists what differs', { skip: skipFix }, async () => {
  const config = loadConfig('2025-26');
  const aging = normalizeARAging(J('fixtures/ar_aging_2026-03-31.raw.json'));
  const netted = Object.entries(config.overrides.entries); // [id, {name, zb_total, adjustment}]
  const rows = [];
  for (const [id, o] of netted) rows.push(cr(id, o.name, -o.adjustment + 5000));              // each netted customer received more than was netted
  const others = aging.contacts.filter((c) => !config.overrides.entries[c.id] && c.total > 0).slice(0, 6);
  for (const c of others) rows.push(cr(c.id, c.name, 25000));
  // one journal that posts two customers to the account in one line (Zoho merges them: ids joined by a comma, amounts netted)
  const [a, b] = others;
  rows.push({ date: '2026-03-02', transaction_id: 'JMERGE', transaction_type: 'journal', entity_number: 'JV-9', debit: 0, credit: 0, contact_id: `${a.id},${b.id}`, contact_name: `${a.name}\n${b.name}`, account_id: ADV_ID, account_name: 'Advance from debtors' });
  const journals = { JMERGE: { entry_number: 'JV-9', line_items: [{ account_id: ADV_ID, customer_id: a.id, debit_or_credit: 'credit', amount: 1200 }, { account_id: ADV_ID, customer_id: b.id, debit_or_credit: 'debit', amount: 1200 }] } };
  const have = rows.reduce((t, r) => t + (r.credit || 0), 0);
  rows.push(cr('', '', TB_CLOSING - have)); // the rest has no customer on it, so that the ledger ties to the Trial Balance

  const zoho = advanceLedgerZoho(replayZoho(), { rows, journals });
  // the signed list: the model's own figures, except a respelt customer, a customer left out, one with another figure, and one only on the sheet
  const probeOnce = (signed) => runAdvanceLedgerProbe({ zoho, config, period: { from: '2025-04-01', to: '2026-03-31' }, signed });
  const first = await probeOnce([]);
  assert.equal(first.account.id, ADV_ID);
  assert.ok(Math.abs(first.led.total - TB_CLOSING) < 0.01, 'the ledger adds up to the Trial Balance');
  assert.equal(first.gl.merged, 1);

  const snap = await buildSnapshot({ zoho: replayZoho(), config, fy: '2025-26', now: () => Date.parse('2026-10-15T06:30:00+05:30') });
  assert.ok(Math.abs(first.model.total - snap.receivables.advanceFromCustomers) < 0.01, `model ${first.model.total} vs statements ${snap.receivables.advanceFromCustomers}`);
  assert.equal(first.rec.overridesApplied, true);

  const shown = first.model.customers.filter((c) => c.id !== '-1' && c.advance > 1);
  const signed = shown.map((c) => ({ label: c.name, signed: Math.round(c.advance) }));
  signed[0] = { label: 'A Different Spelling Pvt Ltd', signed: signed[0].signed };
  const dropped = signed.pop();
  signed[1] = { ...signed[1], signed: signed[1].signed + 500 };
  signed.push({ label: 'Only On The Sheet', signed: 31337 });
  const r = await probeOnce(signed);
  assert.equal(r.B.renamed.length, 1);
  assert.equal(r.B.differ.length, 1);
  assert.deepEqual(r.B.missing.map((x) => x.label), ['Only On The Sheet']);
  assert.ok(r.B.extra.some((x) => x.name === dropped.label));
  assert.ok(r.B.same.length >= shown.length - 4);
  assert.ok(r.A.same.length < r.B.same.length, 'before the netting fewer customers agree');
  const text = formatAdvanceProbe(r).join('\n');
  assert.match(text, /Ledger added up \(credit balance\): Rs 57,78,24,040\.44 {5}Trial Balance: Rs 57,78,24,040\.44 {5}difference: Rs 0\.00/);
  assert.match(text, /A\. Ledger only, before the netting/);
  assert.match(text, /B\. Ledger, after the netting/);
  assert.match(text, /A Different Spelling Pvt Ltd {2}\/ /);
});

// ---------------------------------------------------------------- update-11: the advances in the refresh and on the BS Grouping sheet
import { buildOverlay, buildPool, sourceUnavailable } from '../lib/overlay.mjs';
import { readSheet } from '../lib/workbook.mjs';

const NOW = Date.parse('2026-10-15T06:30:00+05:30');
const replaySnapshot = (options = {}) => buildSnapshot({ zoho: replayZoho(options), config: loadConfig('2025-26'), fy: '2025-26', now: () => NOW });
const bsOverlay = (snapshot) => {
  const config = loadConfig('2025-26');
  return buildOverlay(snapshot, readSheet(config.workbook, 'bs-grouping'), config.workbook.index.sheets.find((s) => s.id === 'bs-grouping').live);
};
const advBlock = (o) => o.blocks.find((b) => /^Detail of Advance from Customer/.test(b.title));

test('the refresh reads the ledger of the advance account: it ties to the Trial Balance and its total is the Advance-from-customers figure of the statements', { skip: skipFix }, async () => {
  const snap = await replaySnapshot();
  const a = snap.advances;
  assert.equal(a.asOf, '2026-03-31');
  assert.deepEqual(a.accountIds, [ADV_ID]);
  assert.equal(a.ledgerTotal, 577824040.44);
  assert.equal(a.tbClosing, 577824040.44);
  assert.equal(a.total, a.plug);
  assert.equal(a.plug, Math.round(snap.receivables.advanceFromCustomers * 100) / 100);
  assert.equal(a.netted, -262451155.62);
  assert.equal(a.credit, 2582063.9);
  assert.equal(a.customers.length, 113);
  assert.equal(a.unnamed, 0);
  assert.equal(a.untagged, -3.86, 'the line with no customer on it is not a customer, but it is in the total');
  assert.deepEqual(snap.alerts.filter((x) => /^ADVANCE/.test(x.code)), []);
  assert.equal(snap.meta.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(snap)), snap);
});

test('a customer netted by the auditors comes out lower than the ledger says, and one netted to nothing is not in the list', { skip: skipFix }, async () => {
  const { advances } = await replaySnapshot();
  const wonder2 = advances.customers.find((c) => /^Wonder Cement Limited \( Phase 2/.test(c.name));
  assert.equal(wonder2, undefined, 'its whole advance of Rs 10,01,84,832 was netted against its invoices');
  const partly = advances.customers.filter((c) => c.adjustment < 0 && c.advance > 0);
  assert.ok(partly.length > 0);
  for (const c of partly) assert.ok(Math.abs(c.ledger + c.adjustment + c.credit - c.advance) < 0.01);
});

test('BS Grouping: all 113 lines of the advances from customers have their Zoho figure (the renamed contact by amount), the total agrees and Zoho has no other customer', { skip: skipFix }, async () => {
  const o = bsOverlay(await replaySnapshot());
  const b = advBlock(o);
  assert.equal(b.source, 'advance');
  assert.deepEqual([b.ok, b.name, b.diff, b.none, b.totalsOk, b.totalsBad], [112, 1, 0, 0, 1, 0]);
  const sh = readSheet(loadConfig('2025-26').workbook, 'bs-grouping');
  const named = Object.entries(o.byRow).find(([, v]) => v.status === 'NAME' && v.zohoName === 'Miracle Group Limited');
  assert.equal(sh.rows[named[0]][1], 'Miracle Coro Plast Pvt Ltd');
  assert.deepEqual(o.extras.filter((e) => e.group === 'customer_advances'), []);
  assert.equal(o.problems.length, 0);
});

test('BS Grouping: a changed advance shows as a difference, and a new advance that is not on the sheet shows as an extra', { skip: skipFix }, async () => {
  const snap = await replaySnapshot();
  const changed = JSON.parse(JSON.stringify(snap));
  changed.advances.customers[5].advance += 700;
  changed.advances.customers.push({ id: 'NEW', name: 'Paid After Signing Ltd', ledger: 50000, adjustment: 0, credit: 0, advance: 50000 });
  const o = bsOverlay(changed);
  assert.equal(advBlock(o).diff, 1);
  assert.equal(advBlock(o).totalsBad, 1, 'and so does the total');
  const extras = o.extras.filter((e) => e.group === 'customer_advances');
  assert.deepEqual(extras.map((e) => [e.name, e.value]), [['Paid After Signing Ltd', 50000]]);
});

test('an older stored snapshot has no advances: the list stays as signed and the page says why, nothing breaks', { skip: skipFix }, async () => {
  const snap = await replaySnapshot();
  delete snap.advances;
  assert.match(sourceUnavailable(snap, 'advance'), /refresh the data/);
  assert.equal(sourceUnavailable(snap, 'customer'), null);
  const o = bsOverlay(snap);
  assert.equal(advBlock(o).source, null);
  assert.equal(advBlock(o).signed, 113);
  assert.equal(o.problems.length, 1);
  assert.match(o.problems[0], /Advance from Customer/);
  assert.equal(buildPool({ advances: { customers: [{ name: 'A', advance: 5 }, { name: 'a', advance: 6 }] } }, 'advance').get('a').value, 11);
});

test('if the advance ledger cannot be read the statements are still built, with a warning, and the list stays as signed', { skip: skipFix }, async () => {
  const snap = await replaySnapshot({ advanceIgnoreRule: true });
  assert.equal(snap.advances, null);
  assert.equal(snap.meta.ok, true);
  assert.ok(snap.alerts.some((a) => a.code === 'ADVANCES_UNAVAILABLE' && a.level === 'warn'));
  assert.equal(advBlock(bsOverlay(snap)).source, null);
});

test('if the ledger of the advance account does not add up to the Trial Balance the refresh says so', { skip: skipFix }, async () => {
  const rows = syntheticAdvanceRows();
  const snap = await replaySnapshot({ advanceRows: rows.slice(0, -1) }); // without the last line (the one with no customer, Rs 3.86): the ledger is Rs 3.86 off
  assert.ok(snap.alerts.some((a) => a.code === 'ADVANCE_LEDGER_TIE'));
});
