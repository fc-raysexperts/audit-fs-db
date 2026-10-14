import test from 'node:test';
import assert from 'node:assert/strict';
import { mapAccounts, validateMapping } from '../lib/mapping.mjs';

const mapping = {
  buckets: { a: { label: 'A', nature: 'asset' }, b: { label: 'B', nature: 'asset' }, c: { label: 'C', nature: 'asset' } },
  rules: [
    { match: { family: '1-01' }, bucket: 'a' },
    { match: { code: '1-01-002' }, bucket: 'b' },
    { match: { accountId: '99' }, bucket: 'c' },
  ],
};
const acc = (id, code, closing) => ({ id, code, name: 'n' + id, closing, opening: 0, debit: 0, credit: 0 });

test('most specific rule wins: accountId > exact code > family', () => {
  const r = mapAccounts([acc('1', '1-01-001', 10), acc('2', '1-01-002', 20), acc('99', '1-01-003', 30), acc('3', '1-01', 5)], mapping);
  assert.equal(r.buckets.a.sum, 15); // 1-01-001 and the parent 1-01
  assert.equal(r.buckets.b.sum, 20);
  assert.equal(r.buckets.c.sum, 30);
  assert.equal(r.alerts.length, 0);
});

test('family does not match look-alike codes (1-010 is not in family 1-01)', () => {
  const r = mapAccounts([acc('1', '1-010', 10)], mapping);
  assert.equal(r.alerts[0].code, 'UNMAPPED_ACCOUNT');
});

test('unmapped account with a balance raises an alert; zero balance does not', () => {
  const r = mapAccounts([acc('1', '9-99', 10), acc('2', '9-98', 0)], mapping);
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0].code, 'UNMAPPED_ACCOUNT');
});

test('two different buckets at the same specificity raise DOUBLE_CLAIMED', () => {
  const m = { buckets: mapping.buckets, rules: [{ match: { code: 'X' }, bucket: 'a' }, { match: { code: 'X' }, bucket: 'b' }] };
  const r = mapAccounts([acc('1', 'X', 10)], m);
  assert.equal(r.alerts[0].code, 'DOUBLE_CLAIMED');
});

test('rule pointing at a missing bucket is rejected at load time', () => {
  assert.throws(() => validateMapping({ buckets: {}, rules: [{ match: { code: '1' }, bucket: 'nope' }] }), /unknown bucket/);
});
