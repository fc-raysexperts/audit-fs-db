// update-28: the subsidiaries' OWN books in Zoho against Form AOC-1 and against the loans of Note 28(A) (lib/subsidiaries.mjs, config/subsidiaries.fy26.json).
// Made-up books for the rules; the real FY26 books of four subsidiaries (fixtures/subsidiaries_fy26.json: what Zoho gave on 21-Oct-2026, compact) for the sheet. Rays Rooftop SPV is not
// there: its Zoho user is disabled (code 6018). The real ones are skipped without fixtures/.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../lib/config.mjs';
import { buildSnapshot } from '../lib/snapshot.mjs';
import { buildWorkbook, readSheet, liveVerify } from '../lib/workbook.mjs';
import { buildBooks } from '../lib/books.mjs';
import { buildView } from '../lib/present.mjs';
import { buildRelatedChecks, readRef } from '../lib/related.mjs';
import { buildSubsidiariesSection, buildSubsidiaryChecks, subBalance, subProfit } from '../lib/subsidiaries.mjs';
import { fetchSubsidiaryReports } from '../lib/zohoData.mjs';
import { replayZoho, haveFixtures, subProfitLossRaw, subTrialBalanceRaw, SPV_ORG } from '../testing/fakes.mjs';

const skip = !haveFixtures();
const config = loadConfig('2025-26');
const spec = config.subsidiaries;
const NOW = Date.parse('2026-10-15T06:30:00+05:30');
const range = { from: '2025-01-01', to: '2026-03-31' };

// ---------- the configuration itself ----------

test('config/subsidiaries.fy26.json: five subsidiaries in the columns of AOC-1, each with its organisation and the day it began; every figure names its layer and field', () => {
  assert.ok(spec, 'the year has its subsidiaries configuration');
  assert.deepEqual(Object.keys(spec.subs), ['om', 'spv', 'rper', 'rpetech', 'foundation']);
  assert.deepEqual(Object.values(spec.subs).map((s) => s.col), [2, 3, 4, 5, 6]);
  for (const s of Object.values(spec.subs)) assert.match(String(s.org), /^\d{11}$/);
  for (const s of Object.values(spec.subs)) assert.match(s.from, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(spec.figures.map((f) => f.id), ['capital', 'reserves', 'assets', 'liabilities', 'turnover', 'pbt', 'tax', 'pat']);
  for (const f of spec.figures) assert.ok(['balance', 'profit'].includes(f.layer) && f.field, f.id);
  // the sheet really has the rows and the names the configuration expects
  const rows = readSheet(config.workbook, 'aoc-1').rows;
  for (const s of Object.values(spec.subs)) assert.ok(String(rows[7][s.col]).toLowerCase().startsWith(s.name.toLowerCase()), `column ${s.col} is ${s.name}`);
  // the confirmation of the loans of Note 28(A) names subsidiaries that are configured here
  for (const c of config.related.checks.filter((x) => x.group === 'confirm')) for (const z of c.zoho) assert.ok(spec.subs[z.split(':')[1]]?.loan, `${c.id}: the loan account of ${z}`);
});

// ---------- reading a subsidiary's books ----------

// [type, id, name, code, closing (debit +, credit -), plkind]
const books = [
  ['asset', 'a1', 'Bank', '', 710, null], ['asset', 'a2', 'Deferred Tax Asset', '', 60, null],
  ['liability', 'l1', 'Loan from the company', '', -500, null], ['liability', 'l2', 'Payables', '', -150, null],
  ['equity', 'e1', 'Share Capital', '', -100, null], ['equity', 'e2', 'Drawings', '', 20, null],
  ['income', 'i1', 'Sales', '', -300, 'oi'], ['income', 'i2', 'Interest', '', -10, 'noi'],
  ['expense', 'x1', 'Purchases', '', 250, 'cogs'], ['expense', 'x2', 'Salaries', '', 40, 'oe'], ['expense', 'x3', 'Bank charges', '', 5, 'noe'], ['expense', 'x4', 'Deferred Tax', '4-07-003', -25, 'oe'],
];
const sub = { name: 'Test Ltd', org: '1', from: '2025-01-01', capital: ['e1'], loan: 'l1' };

test('the balance sheet figures: share capital, reserves (profit and other equity), assets and liabilities by the sign of each balance whatever heading Zoho puts it under, and the loan', () => {
  // profit = 300 + 10 - 250 - 40 - 5 + 25 = 40; other equity = -20 (drawings); reserves 20
  const b = subBalance(subTrialBalanceRaw(books, range), sub);
  assert.deepEqual(b, { shareCapital: 100, reserves: 20, totalAssets: 770, totalLiabilities: 650, loan: 500, balanced: true, accounts: 12 }, 'liabilities 500 + 150; the credit on the deferred tax line is part of the profit, not a liability');
  const odd = subBalance(subTrialBalanceRaw([...books, ['liability', 'l3', 'Deferred tax asset listed among liabilities', '', 30, null]], range), sub);
  assert.equal(odd.totalAssets, 800, 'a debit under Liabilities is an asset');
  assert.equal(odd.balanced, false);
  assert.throws(() => subBalance({ data: {} }, sub), /unexpected shape/);
});

test('the profit figures: turnover is Operating Income; the tax is the account with the configured code, with the sign of the signed form (a credit adds to the loss)', () => {
  const p = subProfit(subProfitLossRaw(books, range), '4-07-003');
  // net = 300 - 250 - (40 - 25) + 10 - 5 = 40; the deferred tax is a credit of 25: an expense of -25
  assert.deepEqual(p, { turnover: 300, pbt: 15, tax: 25, pat: 40 });
  assert.deepEqual(subProfit(subProfitLossRaw(books, range), null), { turnover: 300, pbt: 40, tax: 0, pat: 40 }, 'no tax code: no tax');
  assert.throws(() => subProfit({ data: { profit_and_loss: { accounts: [] } } }, null), /no "operating_income" line/);
  assert.throws(() => subProfit({}, null), /unexpected shape/);
});

test('the section keeps each subsidiary that could be read and says (as information) which could not; a trial balance that does not balance is a warning', () => {
  const alerts = [];
  const two = { subs: { a: { ...sub, name: 'A Ltd' }, b: { ...sub, name: 'B Ltd', org: '2' } }, taxCode: '4-07-003' };
  const sec = buildSubsidiariesSection({
    spec: two, to: '2026-03-31', alerts,
    reads: { a: { tb: subTrialBalanceRaw(books, range), pl: subProfitLossRaw(books, range) }, b: { tb: { error: new Error('Your account is disabled') }, pl: null } },
  });
  assert.deepEqual([sec.subs.a.balance.shareCapital, sec.subs.a.profit.pat], [100, 40]);
  assert.deepEqual([sec.subs.b.balance.error, sec.subs.b.profit.error], ['Your account is disabled', 'not asked for']);
  assert.deepEqual(alerts.map((a) => [a.level, a.code]), [['info', 'SUBSIDIARY_UNAVAILABLE']]);
  const odd = buildSubsidiariesSection({ spec: { subs: { a: sub } }, to: '2026-03-31', alerts: (alerts.length = 0, alerts), reads: { a: { tb: subTrialBalanceRaw([...books, ['asset', 'a9', 'x', '', 5, null]], range), pl: subProfitLossRaw(books, range) } } });
  assert.equal(odd.subs.a.balance.balanced, false);
  assert.deepEqual(alerts.map((a) => [a.level, a.code]), [['warn', 'SUBSIDIARY_NOT_BALANCED']]);
});

test('a subsidiary is asked for in its own organisation, from the day it began; a refusal or a report for other days comes back as an error for that report only', async () => {
  const calls = [];
  const zoho = { get: async (p, q) => { calls.push([p, q]); return p === '/reports/trialbalance' ? subTrialBalanceRaw(books, { from: q.from_date, to: q.to_date }) : subProfitLossRaw(books, { from: q.from_date, to: q.to_date }); } };
  const got = await fetchSubsidiaryReports(zoho, { org: '777', from: '2025-02-03', to: '2026-03-31' });
  assert.ok(got.tb.data && got.pl.data);
  const q = Object.fromEntries(calls.map(([p, x]) => [p, x]));
  assert.equal(q['/reports/trialbalance'].organization_id, '777');
  assert.deepEqual(q['/reports/trialbalance'].select_columns.map((c) => c.field).slice(-1), ['closing_balance']);
  assert.deepEqual([q['/reports/profitandloss'].organization_id, q['/reports/profitandloss'].is_new_flow, q['/reports/profitandloss'].is_response_new_flow], ['777', 'true', 'true']);
  assert.deepEqual([q['/reports/profitandloss'].from_date, q['/reports/profitandloss'].to_date], ['2025-02-03', '2026-03-31']);
  const other = await fetchSubsidiaryReports({ get: async (p, q) => subTrialBalanceRaw(books, { from: '2025-04-01', to: q.to_date }) }, { org: '1', from: '2025-02-03', to: '2026-03-31' });
  assert.match(other.tb.error.message, /returned the subsidiary's trial balance for 2025-04-01 to 2026-03-31, not 2025-02-03 to 2026-03-31/);
  await assert.rejects(fetchSubsidiaryReports({ get: async () => { throw new TypeError('network down'); } }, { org: '1', from: 'a', to: 'b' }), /network down/);
});

// ---------- the real books against the sheet ----------

const run = (options) => buildSnapshot({ zoho: replayZoho(options), config, fy: '2025-26', now: () => NOW });
let memo = null;
const base = async () => (memo ??= await run({}));
const aoc = () => readSheet(config.workbook, 'aoc-1');
const check = (snapshot, rows = aoc().rows) => buildSubsidiaryChecks({ snapshot, spec, rows });
const status = (r) => Object.fromEntries(r.checks.map((c) => [c.id, c.status]));

test('the refresh asks each subsidiary\'s organisation for its trial balance and profit and loss, from the day it began to the balance sheet date', { skip }, async () => {
  const zoho = replayZoho();
  const snap = await buildSnapshot({ zoho, config, fy: '2025-26', now: () => NOW });
  assert.equal(snap.meta.ok, true);
  assert.equal(zoho.subCalls.length, 10);
  assert.deepEqual([...new Set(zoho.subCalls.map((c) => c.org))].sort(), ['60039002178', '60040067911', '60045349059', '60052617054', '60073283002']);
  for (const [key, s] of Object.entries(spec.subs)) for (const c of zoho.subCalls.filter((x) => x.org === String(s.org))) assert.deepEqual([c.from, c.to], [s.from, '2026-03-31'], key);
  assert.equal(zoho.calls.filter((c) => c.path === '/reports/trialbalance' && !c.query.organization_id).length, 1, "the company's own trial balance is still asked once, for its own organisation");
  assert.deepEqual(Object.keys(snap.subsidiaries.subs), ['om', 'spv', 'rper', 'rpetech', 'foundation']);
  assert.match(snap.subsidiaries.subs.spv.balance.error, /disabled/);
  assert.deepEqual(snap.alerts.filter((a) => a.code === 'SUBSIDIARY_UNAVAILABLE').map((a) => [a.level, /Rooftop SPV/.test(a.message)]), [['info', true]]);
});

test('AOC-1: share capital, reserves, turnover, loss before tax, tax and loss after tax of four subsidiaries agree with their own books; Rays Rooftop SPV cannot be read and stays as signed', { skip }, async () => {
  const r = check(await base());
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.summary, { lines: 40, ok: 26, expl: 6, diff: 0, none: 8 });
  const st = status(r);
  for (const k of ['om', 'rper', 'rpetech', 'foundation']) for (const f of ['capital', 'reserves', 'turnover', 'pbt', 'tax', 'pat']) assert.equal(st[`${k}-${f}`], 'OK', `${k}-${f}`);
  assert.equal(st['rpetech-assets'], 'OK');
  assert.equal(st['rpetech-liabilities'], 'OK');
  for (const f of ['capital', 'reserves', 'assets', 'liabilities', 'turnover', 'pbt', 'tax', 'pat']) assert.equal(st[`spv-${f}`], 'NONE');
  assert.match(r.checks.find((c) => c.id === 'spv-capital').why, /disabled/);
  assert.match(r.info.join(' '), /Rays Rooftop SPV Private Limited: Zoho did not give the books/);
  assert.equal(r.panel.of, 'this form');
  assert.equal(r.stays.length, 2);
  // the cells carry the marks: row 11 is the share capital, column 2 Rays O&M (rows 13 and 14 are the total assets and liabilities, 16 the turnover)
  assert.deepEqual([r.marks['11:2'].status, r.marks['11:2'].zoho, r.marks['11:3']], ['OK', 100000, undefined]);
});

test('AOC-1: Rays O&M agrees within ₹1.13 (the signed sheet is rounded line by line)', { skip }, async () => {
  const r = check(await base());
  const c = (id) => r.checks.find((x) => x.id === id);
  assert.deepEqual([c('om-reserves').signed, c('om-reserves').zoho, c('om-reserves').diff], [-5727767, -5727768.13, -1.13]);
  assert.deepEqual([c('om-pat').status, c('rper-pat').diff, c('foundation-turnover').zoho], ['OK', 0, 1405000]);
});

test('AOC-1: total assets and total liabilities that are out by the SAME amount on both sides, while the capital and reserves agree, are explained as grouping - not as a difference in the books', { skip }, async () => {
  const r = check(await base());
  const st = status(r);
  assert.deepEqual(['om', 'rper', 'foundation'].map((k) => [st[`${k}-assets`], st[`${k}-liabilities`]]), [['EXPL', 'EXPL'], ['EXPL', 'EXPL'], ['EXPL', 'EXPL']]);
  const a = r.checks.find((c) => c.id === 'rper-assets');
  const l = r.checks.find((c) => c.id === 'rper-liabilities');
  assert.deepEqual([a.diff, l.diff], [1466285.84, 1466285.84]);
  assert.match(a.text, /₹14,66,285\.84 higher than the signed ones - the same amount on both sides/);
  assert.match(a.text, /how some balances are grouped or set against each other, not in what the company is worth or earned/);
  assert.match(a.text, /Zoho's books do not say which balances/);
  const f = r.checks.find((c) => c.id === 'foundation-assets');
  assert.match(f.text, /₹14,006\.\d\d lower than the signed ones/);
  assert.equal(r.marks['13:4'].status, 'EXPL');
  assert.equal(r.marks['14:4'].status, 'EXPL');
  assert.equal(r.marks['13:5'].status, 'OK', 'RPE Technologies agrees');
});

test('AOC-1: a difference that is not the same on both sides, or that comes with a different capital or profit, stays a difference - it is never smoothed over', { skip }, async () => {
  const one = await run({ subsAccounts: (k, a) => (k === 'rpetech' ? [...a, ['asset', '9', 'Extra cash', '', 500000, null], ['income', '10', 'Extra sales', '', -500000, 'oi']] : a) });
  const r = check(one);
  const st = status(r);
  assert.deepEqual(['rpetech-reserves', 'rpetech-assets', 'rpetech-turnover', 'rpetech-pbt', 'rpetech-pat'].map((k) => st[k]), ['DIFF', 'DIFF', 'DIFF', 'DIFF', 'DIFF']);
  assert.equal(st['rpetech-liabilities'], 'OK');
  assert.equal(r.checks.find((c) => c.id === 'rpetech-turnover').zoho, 500000);
  assert.equal(r.marks['16:5'].status, 'DIFF');
});

test('AOC-1: a trial balance that does not balance is not relied on (warning; its figures are "not checked"); a report for other days is refused', { skip }, async () => {
  const odd = await run({ subsAccounts: (k, a) => (k === 'foundation' ? [...a, ['asset', '9', 'Odd', '', 1000, null]] : a) });
  assert.equal(odd.meta.ok, true);
  assert.deepEqual(odd.alerts.filter((a) => a.code === 'SUBSIDIARY_NOT_BALANCED').map((a) => a.level), ['warn']);
  const r = check(odd);
  assert.equal(r.checks.filter((c) => c.id.startsWith('foundation-')).every((c) => c.status === 'NONE' && /does not balance/.test(c.why)), true);
  assert.match(r.info.join(' '), /does not balance in Zoho, so its figures are not relied on/);
  const dates = await run({ subsDates: ['2025-01-01', '2026-03-30'] });
  assert.equal(dates.meta.ok, true);
  assert.equal(check(dates).summary.none, 40);
  assert.equal(dates.alerts.filter((a) => a.code === 'SUBSIDIARY_UNAVAILABLE').length, 5);
});

test('AOC-1: when Zoho refuses every subsidiary the sheet stays as signed and says why; an older snapshot says to refresh; a moved column stops only its own checks', { skip }, async () => {
  const refused = await run({ subsFail: 'refused' });
  assert.equal(refused.meta.ok, true);
  const r = check(refused);
  assert.deepEqual([r.summary.ok, r.summary.none, Object.keys(r.marks).length], [0, 40, 0]);
  assert.match(r.info.join(' '), /Rays O&M Experts Private Limited, Rays Rooftop SPV Private Limited, RPE Energy Reserve Private Limited, RPE Technologies Private Limited and Rays Experts Foundation: Zoho did not give the books/);
  const old = { ...(await base()) };
  delete old.subsidiaries;
  const o = check(old);
  assert.equal(o.summary.none, 40);
  assert.match(o.checks[0].why, /an older copy/);
  const moved = structuredClone(aoc().rows);
  moved[7][4] = 'Somebody Else Pvt Ltd';
  const m = check(await base(), moved);
  assert.equal(m.problems.length, 1);
  assert.match(m.problems[0], /column 4 is "Somebody Else Pvt Ltd", the configuration expects "RPE Energy Reserve/);
  assert.equal(m.checks.filter((c) => c.id.startsWith('rper-')).length, 0);
  assert.equal(m.checks.filter((c) => c.id.startsWith('om-')).length, 8);
});

// ---------- the loans of Note 28(A), confirmed by the subsidiaries' own books ----------

const n28 = (snapshot) => buildRelatedChecks({ snapshot, spec: config.related, rows: readSheet(config.workbook, 'note-28-a').rows, side: 'n28' });

test('Note 28(A): the loans of ₹1,71,00,000, ₹2,30,00,000 and ₹3,00,000 are confirmed by the books of the three subsidiaries, and the cells keep the marks of the checks of their party', { skip }, async () => {
  const r = n28(await base());
  const c = r.checks.filter((x) => x.group === 'confirm');
  assert.deepEqual(c.map((x) => [x.id, x.status, x.signed, x.zoho]), [['confirm-om', 'OK', 17100000, 17100000], ['confirm-rper', 'OK', 23000000, 23000000], ['confirm-rpetech', 'OK', 300000, 300000]]);
  assert.match(c[0].terms[0].label, /the loan in the own books of Rays O&M Experts Private Limited/);
  assert.deepEqual(r.groups.map((g) => g.id).includes('confirm'), true);
  assert.deepEqual(['rec-om', 'rec-rper', 'rec-rpetech'].map((id) => Object.values(r.marks).filter((m) => m.check === id).length > 0), [true, true, true], 'the cells still belong to the receivable checks (marks: false on the new ones)');
  assert.equal(Object.values(r.marks).some((m) => /^confirm-/.test(m.check)), false);
  assert.deepEqual(r.problems, []);
});

test('Note 28(A): without the subsidiaries\' books (refused, an older snapshot, or not balanced) the three loans are "not checked", and the other checks do not move', { skip }, async () => {
  const refused = n28(await run({ subsFail: 'refused' }));
  assert.deepEqual(refused.checks.filter((x) => x.group === 'confirm').map((x) => x.status), ['NONE', 'NONE', 'NONE']);
  assert.match(refused.checks.find((x) => x.id === 'confirm-om').why, /^Zoho did not give the books of Rays O&M Experts Private Limited/);
  assert.deepEqual([refused.summary.ok, refused.summary.none], [46, 3]);
  const old = { ...(await base()) };
  delete old.subsidiaries;
  assert.match(n28(old).checks.find((x) => x.id === 'confirm-rper').why, /an older copy/);
  const odd = n28(await run({ subsAccounts: (k, a) => (k === 'om' ? [...a, ['asset', '9', 'Odd', '', 1000, null]] : a) }));
  assert.match(odd.checks.find((x) => x.id === 'confirm-om').why, /does not balance/);
  assert.equal(odd.checks.find((x) => x.id === 'confirm-rper').status, 'OK');
  assert.throws(() => readRef({ subsidiaries: { subs: {} } }, spec, 'unknown'), /unknown reading/);
  assert.match(readRef({ subsidiaries: { subs: {} } }, config.related, 'subs.loan:om').unavailable, /not among the subsidiaries/);
});

test('the workbook counts AOC-1: checked figure by figure with no problem, part live; the Note 28(A) count has the three loans in it', { skip }, async () => {
  const snap = await base();
  const w = buildWorkbook(snap, buildBooks(snap, config, buildView(snap, config.audited)), config.workbook, { ...config.books, related: config.related, register: config.register, subsidiaries: config.subsidiaries });
  const a = w.sheets.find((x) => x.id === 'aoc-1');
  assert.equal(a.status, 'semi');
  assert.deepEqual([a.liveCheck.lines, a.liveCheck.ok, a.liveCheck.expl, a.liveCheck.none, a.liveCheck.problems], [40, 26, 6, 8, []]);
  assert.deepEqual(a.liveCheck.verify, { lines: 40, ok: 26, expl: 6, diff: 0, none: 8 });
  assert.equal(w.sheets.find((x) => x.id === 'note-28-a').liveCheck.lines, 50);
  assert.equal(liveVerify(snap, { subsidiaries: spec }, readSheet(config.workbook, 'aoc-1')).summary.lines, 40);
  assert.equal(liveVerify(snap, { subsidiaries: null }, readSheet(config.workbook, 'aoc-1')), null);
  assert.deepEqual([w.summary.live, w.summary.semi, w.summary.fixed], [11, 11, 12]);
  assert.equal(w.summary.liveProblems, 0);
  assert.equal(SPV_ORG, '60039002178');
});
