import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGL, mergedTransactionIds, expandMergedRows, normalizeJournal, summarizeGL, UNTAGGED } from '../lib/gl.mjs';

const row = (o) => ({ transaction_id: 't1', account_id: 'A', contact_id: 'c1', contact_name: 'C1', transaction_type: 'journal', entity_number: 'SJ-1', date: '2026-01-01', debit: '', credit: '', ...o });
const page = (rows, pc = {}) => ({ data: { account_transactions: [{ account_transactions: rows, group_name: 'A' }], page_context: { total: rows.length, has_more_page: false, ...pc } } });

test('normalizeGL: debit +, credit -, blank contact becomes untagged', () => {
  const g = normalizeGL(page([row({ debit: 100 }), row({ credit: 30, contact_id: '' }), row({ debit: '', credit: '' })]));
  assert.deepEqual(g.rows.map((r) => r.net), [100, -30, 0]);
  assert.equal(g.rows[1].contactId, UNTAGGED);
});

test('normalizeGL refuses an incomplete ledger (missing page / has_more_page)', () => {
  assert.throws(() => normalizeGL(page([row({ debit: 1 })], { total: 5 })), /incomplete/);
  assert.throws(() => normalizeGL(page([row({ debit: 1 })], { has_more_page: true })), /incomplete/);
});

const merged = () => normalizeGL(page([
  row({ transaction_id: 'J1', contact_id: 'c1,c2', contact_name: 'C1\nC2' }), // merged, nets to 0
  row({ transaction_id: 'B1', debit: 50 }),
])).rows;
const journal = { J1: { entry_number: 'SJ-1', lines: [
  { account_id: 'A', contact_id: 'c1', debit: 70, credit: 0 },
  { account_id: 'A', contact_id: 'c2', debit: 0, credit: 70 },
  { account_id: 'OTHER', contact_id: 'zz', debit: 5, credit: 0 }] } };

test('merged rows are listed for fetching, then replaced by the journal lines of the same account only', () => {
  assert.deepEqual(mergedTransactionIds(merged()), ['J1']);
  const x = expandMergedRows(merged(), journal);
  assert.equal(x.expanded, 1);
  assert.deepEqual(x.rows.filter((r) => r.txnId === 'J1').map((r) => [r.contactId, r.net]), [['c1', 70], ['c2', -70]]);
  assert.equal(x.alerts.length, 0);
});

test('merged row without its journal: zero net is flagged info, non-zero net is kept as untagged with a warning', () => {
  const x = expandMergedRows(merged(), {});
  assert.equal(x.rows.filter((r) => r.txnId === 'J1').length, 0);
  assert.equal(x.alerts[0].code, 'GL_MERGED_NEUTRAL');
  const rows = normalizeGL(page([row({ transaction_id: 'J2', contact_id: 'c1,c2', debit: 40 })])).rows;
  const y = expandMergedRows(rows, {});
  assert.deepEqual(y.rows.map((r) => [r.contactId, r.net]), [[UNTAGGED, 40]]);
  assert.equal(y.alerts[0].code, 'GL_MERGED_UNEXPANDED');
});

test('journal that disagrees with the ledger row is ignored with a warning (never silently trusted)', () => {
  const rows = normalizeGL(page([row({ transaction_id: 'J1', contact_id: 'c1,c2', debit: 10 })])).rows;
  const x = expandMergedRows(rows, journal); // journal nets to 0 on account A, row says 10
  assert.ok(x.alerts.some((a) => a.code === 'GL_JOURNAL_MISMATCH'));
  assert.equal(summarizeGL(x.rows).byAccount.get('A'), 10); // account total unchanged
});

test('normalizeJournal reads Zoho get_journal lines', () => {
  const j = normalizeJournal({ data: { journal: { entry_number: 'SJ-9', line_items: [
    { account_id: 'A', customer_id: 'c1', debit_or_credit: 'debit', amount: 12.5 },
    { account_id: 'A', customer_id: '', debit_or_credit: 'credit', amount: 2 }] } } });
  assert.deepEqual(j.lines, [{ account_id: 'A', contact_id: 'c1', debit: 12.5, credit: 0 }, { account_id: 'A', contact_id: '', debit: 0, credit: 2 }]);
});

test('summarizeGL totals by contact, account and contact+account', () => {
  const rows = normalizeGL(page([row({ debit: 100 }), row({ credit: 40 }), row({ account_id: 'B', credit: 5, contact_id: 'c2', contact_name: 'C2' })])).rows;
  const s = summarizeGL(rows);
  assert.equal(s.byContact.get('c1'), 60);
  assert.equal(s.byAccount.get('B'), -5);
  assert.equal(s.byContactAccount.get('c2|B'), -5);
  assert.equal(s.names.get('c2'), 'C2');
});
