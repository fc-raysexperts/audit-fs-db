import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSuppliers, normalizeVendorGroup, partyAccounts } from '../lib/vendors.mjs';

const EMP = 'EMP';
const rows = (list) => list.map(([contactId, accountId, net]) => ({ txnId: 't', accountId, contactId, contactName: 'N' + contactId, net, entry: '' }));
const accounts = (list) => list.map(([id, closing]) => ({ id, code: id, name: id, closing }));
const rules = { staff: { employee_ledger_account_ids: [EMP] }, msme: { contact_ids: { m1: 'MSME Co' } } };
const run = (list, accts, extra = {}) =>
  computeSuppliers({ gl: { rows: rows(list) }, accounts: accounts(accts), asOf: '2026-03-31', rules, overrides: null, staffGroup: new Set(), ...extra });

test('credit balance = trade payable, debit balance = advance, MSME split, untagged debit = advance', () => {
  const r = run([['a', 'X', -100], ['m1', 'X', -40], ['b', 'X', 70], ['-1', 'X', 5]], [['X', -65]]);
  assert.deepEqual([r.totals.tpOthers, r.totals.tpMsme, r.totals.advance], [100, 40, 75]);
  assert.ok(r.checks.every((c) => c.ok), JSON.stringify(r.checks));
});

test('a party is netted across accounts (advance in one ledger, bill in another)', () => {
  const r = run([['a', 'X', 300], ['a', 'Y', -120]], [['X', 300], ['Y', -120]]);
  assert.deepEqual([r.totals.advance, r.totals.tpOthers], [180, 0]);
});

test('staff: vendor-group member or employee-ledger balance -> imprest; staff debit -> advance', () => {
  const r = run([['g', 'X', -10], ['e', EMP, -20], ['s', EMP, 30], ['p', 'X', -5]], [['X', -15], [EMP, 10]], { staffGroup: new Set(['g']) });
  assert.equal(r.totals.imprest, 30);
  assert.equal(r.totals.advance, 30);
  assert.equal(r.totals.tpOthers, 5);
});

test('missing staff group warns but still works from the employee ledger', () => {
  const r = run([['e', EMP, -20]], [[EMP, -20]], { staffGroup: null });
  assert.equal(r.totals.imprest, 20);
  assert.ok(r.alerts.some((a) => a.code === 'STAFF_GROUP_MISSING'));
});

const ov = { as_of: '2026-03-31', entries: {
  r: { name: 'Ret Co', zb_net: -50, class: 'retention' },
  o: { name: 'Out Co', zb_net: -30, class: 'outstanding' },
  e: { name: 'Not staff', zb_net: -20, class: 'trade_payable' },
  h: { name: 'Insurer', zb_net: 4, gross_up: 100 } } };
const list = [['r', 'X', -50], ['o', 'X', -30], ['e', EMP, -20], ['h', 'X', 4]];

test("year judgments: retention / outstanding / 'not staff' / gross-up are applied on their own date", () => {
  const r = run(list, [['X', -76], [EMP, -20]], { overrides: ov });
  const t = r.totals;
  assert.deepEqual([t.retention, t.outstanding, t.imprest, t.tpOthers, t.advance], [50, 30, 0, 120, 104]);
  assert.ok(r.checks.every((c) => c.ok), JSON.stringify(r.checks)); // gross-up cancels out: still conserved
  assert.equal(r.overridesApplied, true);
});

test('year judgments are NOT applied on another date', () => {
  const r = run(list, [['X', -76], [EMP, -20]], { overrides: ov, asOf: '2026-06-30' });
  assert.equal(r.overridesApplied, false);
  assert.deepEqual([r.totals.retention, r.totals.outstanding, r.totals.imprest, r.totals.tpOthers], [0, 0, 20, 80]);
  assert.ok(r.alerts.some((a) => a.code === 'PARTY_OVERRIDES_SKIPPED'));
});

test('stale and missing override entries warn', () => {
  const r = run([['r', 'X', -60]], [['X', -60]], { overrides: { as_of: '2026-03-31', entries: { r: { name: 'Ret Co', zb_net: -50, class: 'retention' }, gone: { name: 'Gone', zb_net: -9, class: 'retention' } } } });
  assert.ok(r.alerts.some((a) => a.code === 'PARTY_OVERRIDE_STALE'));
  assert.ok(r.alerts.some((a) => a.code === 'PARTY_OVERRIDE_MISSING'));
});

test('ledger that does not add up to the Trial Balance is an error (and an unexpected account too)', () => {
  const r = run([['a', 'X', -100]], [['X', -90]]);
  assert.ok(r.alerts.some((a) => a.code === 'GL_VS_TB' && a.level === 'error'));
  assert.ok(r.checks.some((c) => !c.ok));
  const r2 = run([['a', 'X', -100], ['a', 'Z', 7]], [['X', -100]]);
  assert.ok(r2.alerts.some((a) => a.code === 'GL_ACCOUNT_UNEXPECTED'));
});

test('untagged credit is not hidden: shown as payable with a warning', () => {
  const r = run([['-1', 'X', -8]], [['X', -8]]);
  assert.equal(r.totals.tpOthers, 8);
  assert.ok(r.alerts.some((a) => a.code === 'UNTAGGED_CREDIT'));
});

test('normalizeVendorGroup keeps only members of the group and refuses a partial list', () => {
  const raw = { data: { contacts: [
    { contact_id: '1', contact_name: 'A', cf_vendor_group: 'Imprest Staff' },
    { contact_id: '2', contact_name: 'B', custom_fields: [{ api_name: 'cf_vendor_group', value: 'Others' }] },
    { contact_id: '3', contact_name: 'C', custom_fields: [{ api_name: 'cf_vendor_group', value: 'Imprest Staff' }] }], page_context: { has_more_page: false } } };
  assert.deepEqual([...normalizeVendorGroup(raw, 'Imprest Staff').ids], ['1', '3']);
  raw.data.page_context.has_more_page = true;
  assert.throws(() => normalizeVendorGroup(raw, 'Imprest Staff'), /incomplete/);
});

test('partyAccounts collects the live accounts of the four party buckets', () => {
  const b = { vendor_advances: { accounts: [{ id: '1' }] }, vendor_payables: { accounts: [{ id: '2' }, { id: '3' }] }, loans_advances_given: { accounts: [] }, staff_advances: { accounts: [{ id: '4' }] }, other: { accounts: [{ id: '9' }] } };
  assert.deepEqual(partyAccounts(b).map((a) => a.id), ['1', '2', '3', '4']);
});
