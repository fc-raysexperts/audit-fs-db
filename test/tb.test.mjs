import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTB } from '../lib/tb.mjs';

const row = (extra) => ({ account_id: '1', name: 'Cash', account_code: '1-01-001', ...extra });
const wrap = (rows) => ({ code: 0, message: 'success', trialbalance: [{ account_transactions: [{ name: 'Assets', account_transactions: rows }] }], page_context: { from_date: '2025-04-01', to_date: '2026-03-31', report_basis: 'Accrual' } });

test('a Trial Balance with the named columns is read', () => {
  const tb = normalizeTB(wrap([row({ opening_balance: 10, debit_total: 5, credit_total: 2, closing_balance: 13 })]));
  assert.deepEqual([tb.accounts[0].opening, tb.accounts[0].closing], [10, 13]);
});

test('the default live answer (net debit / net credit only) is refused instead of being read as zeros', () => {
  const live = wrap([row({ net_debit_total: 13, net_credit_total: '' }), row({ account_id: '2', net_debit_total: '', net_credit_total: 7 })]);
  assert.throws(() => normalizeTB(live), /no closing_balance column/);
});

test('an empty Trial Balance is still readable (nothing to refuse)', () => {
  assert.deepEqual(normalizeTB(wrap([])).accounts, []);
});
