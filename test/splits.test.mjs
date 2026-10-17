// update-15: one Zoho ledger account / one contact split into the lines of the signed sheet (lib/splits.mjs, buildPartySplitsSection of lib/snapshot.mjs).
// Synthetic rows only: the real FY26 ledger is checked in live.test.mjs and overlay.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { partsIn, normalizeSplitLedger, journalsNeeded, buildSplit, buildPartySplit, billsNeeded, normalizeBill, SPLIT_TOLERANCE } from '../lib/splits.mjs';
import { buildPartySplitsSection } from '../lib/snapshot.mjs';

const FD = {
  account: 'FD', name: 'Fixed Deposits', normal: 'debit', legs: true,
  parts: [
    { name: 'Axis Bank', words: ['axis'] },
    { name: 'State Bank of India', words: ['sbi', 'sbbj', 'state bank'] },
    { name: 'IOB', words: ['iob', 'indian overseas'] },
  ],
};
const PF = {
  account: 'PF', name: 'PF Payable', normal: 'credit', legs: false,
  parts: [{ name: 'Employee Contribution', words: ['employees contribution', 'employee contribution'] }, { name: 'Employer Contribution', rest: true }],
};
const row = (o) => ({ txnId: 't', accountId: 'FD', date: '2026-03-31', type: 'journal', entry: 'JN-1', text: '', debit: 0, credit: 0, ...o });
const journal = (lines, notes = 'Transfering ledger balance from old to new ledger') => ({ notes, lines: lines.map((l) => ({ debit: 0, credit: 0, ...l })) });

test('partsIn: a word is found as a whole word, in any case, and a text can name two parts', () => {
  assert.deepEqual([...partsIn('Being AXIS Bank FDR Balances Reconciled', FD.parts)], [0]);
  assert.deepEqual([...partsIn('SBBJ FD no. 3', FD.parts)], [1]);
  assert.deepEqual([...partsIn('Indian Overseas Bank', FD.parts)], [2]);
  assert.deepEqual([...partsIn('Payment of SBILL', FD.parts)], [], '"sbi" is not in "sbill"');
  assert.deepEqual([...partsIn('Transfer from IOB to Axis', FD.parts)].sort(), [0, 2]);
  assert.deepEqual([...partsIn('', FD.parts)], []);
});

test('buildSplit: the bank in the text of the entry itself', () => {
  const r = buildSplit(FD, [
    row({ text: 'Being AXIS Bank FDR Balances Reconciled as per Bank Statement', debit: 1000 }),
    row({ txnId: 'u', text: 'Being SBI FDR Balances Reconciled', debit: 250, entry: 'SJ-2' }),
    row({ txnId: 'v', text: 'Interest on IOB deposit', credit: 50, entry: 'SJ-3' }), // a withdrawal reduces the part
    row({ accountId: 'OTHER', debit: 99999 }), // another account: ignored
  ]);
  assert.deepEqual(r.parts, [{ name: 'Axis Bank', amount: 1000, rows: 1 }, { name: 'State Bank of India', amount: 250, rows: 1 }, { name: 'IOB', amount: -50, rows: 1 }]);
  assert.equal(r.total, 1200);
  assert.equal(r.residual, 0);
  assert.deepEqual([r.unassigned.length, r.rows, r.stale.length], [0, 3, 0]);
});

test('buildSplit (legs): a clean-up journal names the bank only in the account on its other leg', () => {
  const rows = [row({ txnId: 'j1', debit: 500 }), row({ txnId: 'j2', debit: 700 }), row({ txnId: 'j3', text: 'Being AXIS Bank FDR Balances', debit: 10 })];
  assert.deepEqual(journalsNeeded(FD, rows), ['j1', 'j2'], 'only the entries whose own text names no bank are opened');
  const journals = {
    j1: journal([{ account_id: 'FD', debit: 500 }, { account_id: 'OLD1', name: 'IOB FD no. 015804000012280', credit: 500 }]),
    j2: journal([{ account_id: 'FD', debit: 700 }, { account_id: 'OLD2', name: 'FDR with _ AXIS BANK', credit: 700 }]),
  };
  const r = buildSplit(FD, rows, journals);
  assert.deepEqual(r.parts, [{ name: 'Axis Bank', amount: 710, rows: 2 }, { name: 'IOB', amount: 500, rows: 1 }]);
  assert.deepEqual([r.residual, r.unassigned.length, r.stale.length], [0, 0, 0]);
  // without legs the journal is not looked at: the entry stays unassigned
  const plain = buildSplit({ ...FD, legs: false }, rows, journals);
  assert.equal(plain.unassigned.length, 2);
  assert.deepEqual(journalsNeeded({ ...FD, legs: false }, rows), []);
});

test('buildSplit (legs): a journal that cannot be read, no longer fits the ledger line, or predates update-15 is "stale" and its amount stays unassigned', () => {
  const rows = [row({ txnId: 'a', debit: 100 }), row({ txnId: 'b', debit: 200 }), row({ txnId: 'c', debit: 300 })];
  const journals = {
    b: journal([{ account_id: 'FD', debit: 150 }, { account_id: 'X', name: 'IOB FD', credit: 150 }]), // edited after it was cached
    c: { lines: [{ account_id: 'FD', debit: 300, credit: 0 }, { account_id: 'X', name: 'IOB FD', debit: 0, credit: 300 }] }, // cached before update-15: no notes
  };
  const r = buildSplit(FD, rows, journals);
  assert.deepEqual(r.parts, []);
  assert.deepEqual(r.stale.sort(), ['a', 'b', 'c']);
  assert.equal(r.residual, 600, 'nothing is guessed: all of it is left for the total-wise comparison');
  assert.deepEqual(r.unassigned.map((u) => u.why), ['the journal could not be read', 'the journal does not match the ledger line', 'the journal does not match the ledger line']);
});

test('buildSplit: two banks in one entry, or no bank at all, is left unassigned - and the rest part takes whatever names nobody', () => {
  const r = buildSplit(FD, [row({ text: 'Transfer IOB to Axis', debit: 400 }), row({ type: 'bill', txnId: 'z', text: 'misc', debit: 60 })]);
  assert.deepEqual(r.unassigned.map((u) => [u.amount, u.why]), [[400, 'two names in the same entry'], [60, 'no bank / name in the text']]);
  assert.equal(r.residual, 460);

  const pf = buildSplit(PF, [
    row({ accountId: 'PF', type: 'journal', text: 'Employees Contribution of PF for March', credit: 100 }),
    row({ accountId: 'PF', type: 'journal', text: 'Salary March 2026', credit: 300 }),
    row({ accountId: 'PF', type: 'vendor_payment', text: 'EPFO challan', debit: 40 }),
  ]);
  assert.deepEqual(pf.parts, [{ name: 'Employee Contribution', amount: 100, rows: 1 }, { name: 'Employer Contribution', amount: 260, rows: 2 }]);
  assert.deepEqual([pf.total, pf.residual, pf.unassigned.length], [360, 0, 0]);
});

test('buildSplit: a part that gets no entry is left out, and the residual is what the parts do not hold', () => {
  const r = buildSplit(FD, [row({ text: 'AXIS FDR', debit: 80 }), row({ text: 'AXIS FDR', debit: 0 }), row({ txnId: 'q', type: 'bill', text: 'something', debit: 20 })]);
  assert.deepEqual(r.parts.map((p) => p.name), ['Axis Bank']);
  assert.deepEqual([r.total, r.residual], [100, 20]);
});

test('normalizeSplitLedger: reads every page, and refuses an unexpected shape or a ledger that says there is more', () => {
  const page = (rows, more = false) => ({ data: { account_transactions: [{ group_name: 'FD', account_transactions: rows }], page_context: { has_more_page: more } } });
  const one = { transaction_id: 't1', account_id: 'FD', date: '2026-03-31', transaction_type: 'journal', entity_number: 'JN-1', transaction_details: 'Being AXIS Bank FDR', debit: '1000.5', credit: '' };
  const rows = normalizeSplitLedger([page([one], true), page([{ ...one, transaction_id: 't2', debit: '', credit: 25 }])]);
  assert.deepEqual(rows.map((r) => [r.txnId, r.accountId, r.debit, r.credit, r.type, r.entry]), [['t1', 'FD', 1000.5, 0, 'journal', 'JN-1'], ['t2', 'FD', 0, 25, 'journal', 'JN-1']]);
  assert.throws(() => normalizeSplitLedger({ data: {} }), /unexpected shape/);
  assert.throws(() => normalizeSplitLedger([page([one], true)]), /incomplete/);
});

// ---- a contact by the account of its entries ----
const ADV = 'A1';
const PARTY = {
  title: 'HDFC ERGO: advance and payable', contact: 'C1', name: 'HDFC ERGO',
  parts: [{ name: 'HDFC ERGO - advance', side: 'debit', accounts: [ADV] }, { name: 'HDFC ERGO - payable', side: 'credit', rest: true }],
};
const prow = (o) => ({ contactId: 'C1', accountId: 'AP', net: 0, ...o });

test('buildPartySplit: the entries of the contact are shared by the account they sit in; a part is read in its own direction', () => {
  const r = buildPartySplit(PARTY, [
    prow({ accountId: ADV, net: 500 }), prow({ accountId: ADV, net: 100 }),
    prow({ accountId: 'AP', net: -300 }), prow({ accountId: 'SC', net: -200 }), prow({ accountId: 'AP', net: 40 }),
    prow({ contactId: 'C2', accountId: ADV, net: 9999 }), // another contact
    prow({ accountId: 'AP', net: 0 }), // a nil line is no entry of a part
  ]);
  assert.deepEqual(r.parts, [{ name: 'HDFC ERGO - advance', amount: 600, rows: 2, side: 'debit' }, { name: 'HDFC ERGO - payable', amount: 460, rows: 3, side: 'credit' }]);
  assert.deepEqual([r.total, r.rows, r.wrongSide], [140, 6, []]);
});

test('buildPartySplit: a part on the other side of the ledger is reported, and a part with no entry is left out', () => {
  const r = buildPartySplit(PARTY, [prow({ accountId: ADV, net: -50 })]);
  assert.deepEqual(r.wrongSide, ['HDFC ERGO - advance']);
  const none = buildPartySplit(PARTY, [prow({ accountId: 'AP', net: -10 })]);
  assert.deepEqual(none.parts.map((p) => p.name), ['HDFC ERGO - payable']);
  // an account that no part takes (no `rest` part) stays out of every part but is still in the total
  const strict = buildPartySplit({ ...PARTY, parts: [PARTY.parts[0]] }, [prow({ accountId: ADV, net: 70 }), prow({ accountId: 'AP', net: -20 })]);
  assert.deepEqual([strict.parts.length, strict.total], [1, 50]);
});

test('buildPartySplitsSection: the split is used only when it adds up to the contact\'s balance and every part is on its own side', () => {
  const rows = [prow({ accountId: ADV, net: 500 }), prow({ accountId: 'AP', net: -480 })];
  const parties = [{ id: 'C1', name: 'HDFC ERGO GENERAL INSURANCE COMPANY LIMITED', net: 20 }];
  const alerts = [];
  const ok = buildPartySplitsSection({ spec: { hdfc: PARTY }, rows, parties, alerts });
  assert.deepEqual([ok.hdfc.error, ok.hdfc.total, ok.hdfc.residual, ok.hdfc.contact, ok.hdfc.partyName], [undefined, 20, 0, 'C1', 'HDFC ERGO GENERAL INSURANCE COMPANY LIMITED']);
  assert.deepEqual(ok.hdfc.parts.map((p) => [p.name, p.amount]), [['HDFC ERGO - advance', 500], ['HDFC ERGO - payable', 480]]);
  assert.deepEqual(alerts, []);

  const gone = buildPartySplitsSection({ spec: { hdfc: PARTY }, rows, parties: [], alerts });
  assert.match(gone.hdfc.error, /no balance in the supplier accounts/);

  const a2 = [];
  const off = buildPartySplitsSection({ spec: { hdfc: PARTY }, rows, parties: [{ ...parties[0], net: 25 }], alerts: a2 });
  assert.match(off.hdfc.error, /adds up to 20, the supplier list says 25/);
  assert.deepEqual(a2.map((a) => [a.level, a.code]), [['warn', 'SPLIT_LEDGER_MISMATCH']]);

  const a3 = [];
  const flipped = buildPartySplitsSection({ spec: { hdfc: PARTY }, rows: [prow({ accountId: ADV, net: -500 }), prow({ accountId: 'AP', net: -480 })], parties: [{ ...parties[0], net: -980 }], alerts: a3 });
  assert.match(flipped.hdfc.error, /other side/);
  assert.deepEqual(a3.map((a) => a.code), ['SPLIT_WRONG_SIDE']);
  assert.equal(SPLIT_TOLERANCE, 1);
});

// ---------- update-16: the payable split by the billing-address state of its bills ----------

const BILLED = {
  title: 'HDFC ERGO: advance, and payable for Delhi and for Rajasthan', contact: 'C1', name: 'HDFC ERGO',
  parts: [
    { name: 'HDFC ERGO - advance', side: 'debit', accounts: [ADV] },
    { name: 'HDFC ERGO - payable, Delhi', side: 'credit', accounts: ['AP'], bill_state: ['Delhi'] },
    { name: 'HDFC ERGO - payable, Rajasthan', side: 'credit', rest: true },
  ],
};
const bill = (txnId, net, o = {}) => prow({ accountId: 'AP', type: 'bill', txnId, net, entry: `BILL-${txnId}`, ...o });
const BILL_ROWS = [
  prow({ accountId: ADV, net: 500, type: 'journal', txnId: 'j1' }),
  bill('b1', -100), bill('b2', -200), bill('b3', -50),
  prow({ accountId: 'AP', net: 30, type: 'vendor_payment', txnId: 'p1' }), // a payment is no bill: it goes on to the rest part
];

test('normalizeBill: the billing-address state is read as written (trimmed), a bill with no address has none, a wrong shape is refused', () => {
  const a = normalizeBill({ code: 0, bill: { bill_number: 'B-1', date: '2026-01-05', total: '115050.00', source_of_supply: 'RJ', billing_address: { state: ' Delhi ' } } });
  assert.deepEqual(a, { number: 'B-1', date: '2026-01-05', total: 115050, billingState: 'Delhi', supplyFrom: 'RJ' });
  assert.equal(normalizeBill({ data: { bill: { bill_number: 'B-2', total: 5 } } }).billingState, '');
  assert.throws(() => normalizeBill({ code: 0 }), /without a bill/);
});

test('billsNeeded: only the bills of that contact on the accounts of a bill_state part, nothing for a spec that has none', () => {
  const rows = [...BILL_ROWS, bill('b9', -7, { contactId: 'C2' }), bill('b8', 0), prow({ accountId: 'SC', type: 'bill', txnId: 'b7', net: -5 })];
  assert.deepEqual(billsNeeded({ hdfc: BILLED }, rows).sort(), ['b1', 'b2', 'b3']);
  assert.deepEqual(billsNeeded({ hdfc: PARTY }, rows), [], 'a split by account needs no bill');
  assert.deepEqual(billsNeeded(undefined, rows), []);
});

test('buildPartySplit (bill_state): a bill goes to the part of its billing state, any other bill and the payment go to the rest part', () => {
  const bills = { b1: { billingState: 'delhi' }, b2: { billingState: ' DELHI ' }, b3: { billingState: '' } };
  const r = buildPartySplit(BILLED, BILL_ROWS, bills);
  assert.deepEqual(r.parts.map((p) => [p.name, p.amount, p.rows]), [['HDFC ERGO - advance', 500, 1], ['HDFC ERGO - payable, Delhi', 300, 2], ['HDFC ERGO - payable, Rajasthan', 20, 2]]);
  assert.deepEqual([r.total, r.residual, r.unassigned, r.wrongSide], [180, 0, [], []], 'advance 500 - bills 350 + the payment 30');
});

test('buildPartySplit (bill_state): a bill that could not be read is left out of every part - all of the bills then, not just that one', () => {
  const r = buildPartySplit(BILLED, BILL_ROWS, { b1: { billingState: 'Delhi' }, b2: { billingState: 'Delhi' } }); // b3 is missing
  assert.deepEqual(r.parts.map((p) => p.name), ['HDFC ERGO - advance'], 'neither payable part is shown: half a split would be misleading');
  assert.equal(r.unassigned.length, 3);
  assert.equal(r.residual, 320, 'the whole payable on the credit side: the bills 350 less the payment 30 that the rest part would have held');
  assert.equal(r.total, 180, 'the parts and the residual still add up to the balance of the contact');
  const none = buildPartySplit(BILLED, BILL_ROWS);
  assert.deepEqual([none.unassigned.length, none.residual], [3, 320]);
});

test('buildPartySplitsSection: a bill_state split keeps the residual for the combined check, and is used only if the whole contact adds up', () => {
  const parties = [{ id: 'C1', name: 'HDFC ERGO GENERAL INSURANCE COMPANY LIMITED', net: 180 }];
  const bills = { b1: { billingState: 'Delhi' }, b2: { billingState: 'Delhi' }, b3: { billingState: '' } };
  const ok = buildPartySplitsSection({ spec: { hdfc: BILLED }, rows: BILL_ROWS, parties, bills, alerts: [] });
  assert.deepEqual([ok.hdfc.error, ok.hdfc.residual, ok.hdfc.unassigned], [undefined, 0, []]);
  assert.deepEqual(ok.hdfc.parts.map((p) => p.amount), [500, 300, 20]);
  const blind = buildPartySplitsSection({ spec: { hdfc: BILLED }, rows: BILL_ROWS, parties, bills: {}, alerts: [] });
  assert.equal(blind.hdfc.error, undefined);
  assert.deepEqual([blind.hdfc.residual, blind.hdfc.unassigned.length, blind.hdfc.total], [320, 3, 180]);
});
