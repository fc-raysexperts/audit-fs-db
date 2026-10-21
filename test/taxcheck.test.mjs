// update-30: the advance tax of the year, payment by payment, and the interest on tax (sections 234B / 234C) worked out again (lib/taxcheck.mjs, config/tax.fy26.json "advance").
// The real ledger of the two advance tax accounts (fixtures/advance_tax_fy26.json: what Zoho gave on 21-Oct-2026) and the real FY26 books (skipped without fixtures/).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../lib/config.mjs';
import { buildSnapshot } from '../lib/snapshot.mjs';
import { buildBooks } from '../lib/books.mjs';
import { buildView } from '../lib/present.mjs';
import { readAdvanceLedger, buildTaxSection, buildAdvanceTaxChecks, workInterest, down100 } from '../lib/taxcheck.mjs';
import { replayZoho, haveFixtures, J } from '../testing/fakes.mjs';

const skip = !haveFixtures();
const config = loadConfig('2025-26');
const spec = config.books.tax.advance;
const fx = J('fixtures/advance_tax_fy26.json');
const page = (groups) => ({ data: { account_transactions: groups, page_context: { page: 1, total: groups.reduce((t, g) => t + g.account_transactions.length, 0), has_more_page: false } } });
const NOW = Date.parse('2026-10-15T06:30:00+05:30');
const OLD = '2346113000013976613';
const NEW = '2346113000026786252';

// ---------- the configuration itself ----------

test('config/tax.fy26.json: the two advance tax accounts, the four instalments of section 234C and the number of months of section 234B', () => {
  assert.deepEqual(spec.accounts.map((a) => a.id), [OLD, NEW]);
  assert.deepEqual(spec.instalments.map((i) => [i.due, i.upto, i.relief, i.months]), [
    ['2025-06-15', 0.15, 0.12, 3], ['2025-09-15', 0.45, 0.36, 3], ['2025-12-15', 0.75, null, 3], ['2026-03-15', 1, null, 1],
  ]);
  assert.equal(spec.months_234b.value, 6);
  assert.equal(spec.threshold_234b, 0.9);
  assert.ok(spec.stays.length >= 2, 'what Zoho cannot give is written down');
});

// ---------- reading the ledger ----------

test('the real ledger: seven payments, 6 Dec 2025 to 28 Mar 2026, Rs 10,61,00,000, and the journal that moved the whole balance to the new account', () => {
  const r = readAdvanceLedger(page(fx.groups), spec);
  assert.deepEqual(r.payments.map((p) => [p.date, p.amount, p.entry]), [
    ['2025-12-06', 10000000, 'S11231058'], ['2025-12-12', 2000000, 'S74596381'], ['2025-12-27', 2600000, 'S94019779'], ['2026-01-27', 15600000, '2162'],
    ['2026-02-17', 25900000, '2318'], ['2026-03-14', 30000000, '2462'], ['2026-03-28', 20000000, '2621'],
  ]);
  assert.equal(r.payments.reduce((t, p) => t + p.amount, 0), 106100000);
  assert.ok(r.payments.every((p) => p.type === 'expense'));
  assert.equal(r.journals.length, 1);
  assert.deepEqual([r.journals[0].entry, r.journals[0].date, r.journals[0].out, r.journals[0].into, r.journals[0].net], ['JN-Clean-3', '2026-03-31', 106100000, 106100000, 0]);
  assert.match(r.journals[0].narration, /old to new ledger/);
  assert.deepEqual(r.accounts.map((a) => [a.id, a.closing]), [[OLD, 0], [NEW, 106100000]]);
  assert.equal(r.closing, 106100000);
});

test('a ledger that is not what was asked for is refused, not used: another account, a missing page, an unexpected shape', () => {
  const stray = structuredClone(fx.groups);
  stray[0].account_transactions[0].account_id = '999';
  assert.throws(() => readAdvanceLedger(page(stray), spec), /line of another account/);
  const short = page(fx.groups);
  short.data.page_context.total = 12;
  assert.throws(() => readAdvanceLedger(short, spec), /says 12 lines but 9 were read/);
  const more = page(fx.groups);
  more.data.page_context.has_more_page = true;
  assert.throws(() => readAdvanceLedger(more, spec), /has_more_page/);
  assert.throws(() => readAdvanceLedger({ data: {} }, spec), /unexpected shape/);
});

test('the section: a refusal or a broken answer comes back as an error with an information line; no configuration means no section', () => {
  const alerts = [];
  const ok = buildTaxSection({ spec, pages: [page(fx.groups)], to: '2026-03-31', alerts });
  assert.equal(ok.payments.length, 7);
  assert.equal(alerts.length, 0);
  const refused = buildTaxSection({ spec, pages: { error: new Error('Not authorized') }, to: '2026-03-31', alerts });
  assert.deepEqual([refused.error, refused.payments], ['Not authorized', undefined]);
  const broken = buildTaxSection({ spec, pages: [{ data: {} }], to: '2026-03-31', alerts });
  assert.match(broken.error, /unexpected shape/);
  assert.deepEqual(alerts.map((a) => [a.level, a.code]), [['info', 'TAX_UNAVAILABLE'], ['info', 'TAX_UNAVAILABLE']]);
  assert.match(alerts[0].message, /does not re-work it/);
  assert.equal(buildTaxSection({ spec: null, pages: null, to: '2026-03-31' }), null);
  assert.equal(buildTaxSection({ spec, pages: null, to: '2026-03-31' }).error, 'not asked for');
});

// ---------- the interest, worked out again ----------

const REAL = {
  assessed: 153982922 + 15398292.2 + 6775248.57 - 14395010, // tax + surcharge + cess - TDS = 16,17,61,452.77
  payments: readAdvanceLedger(page(fx.groups), spec).payments,
  instalments: spec.instalments, months234b: 6, yearEnd: '2026-03-31',
};

test('section 288B: a shortfall is rounded down to a multiple of Rs 100', () => {
  assert.deepEqual([down100(24264218.28), down100(100), down100(99.99), down100(0), down100(-5)], [24264200, 100, 0, 0, 0]);
});

test("worked out from the seven payments the interest is the auditors' Rs 1,02,87,632 to the rupee: section 234C Rs 69,47,948 and section 234B (6 months) Rs 33,39,684", () => {
  const w = workInterest(REAL);
  assert.deepEqual(w.rows.map((r) => [r.due, r.paid, r.interest]), [
    ['2025-06-15', 0, 727926], ['2025-09-15', 0, 2183778], ['2025-12-15', 12000000, 3279630], ['2026-03-15', 86100000, 756614],
  ]);
  assert.equal(w.c234, 6947948);
  assert.deepEqual([w.b234.paid, w.b234.months, w.b234.applies, w.b234.interest], [106100000, 6, true, 3339684]);
  assert.equal(w.b234.shortfall, 55661452.77);
  assert.equal(w.total, 10287632);
  assert.ok(w.rows.every((r) => !r.relieved));
});

test('a payment made on the due date counts for that instalment; the one made after it does not', () => {
  const pay = (date, amount) => ({ date, amount });
  const base = { assessed: 1000000, instalments: spec.instalments, months234b: 0, yearEnd: '2026-03-31' };
  const on = workInterest({ ...base, payments: [pay('2025-06-15', 150000), pay('2025-09-15', 300000), pay('2025-12-15', 300000), pay('2026-03-15', 250000)] });
  assert.equal(on.c234, 0, 'every instalment paid on its due date in full');
  const after = workInterest({ ...base, payments: [pay('2025-06-16', 150000), pay('2025-09-15', 300000), pay('2025-12-15', 300000), pay('2026-03-15', 250000)] });
  assert.deepEqual([after.rows[0].paid, after.rows[0].shortfall, after.rows[0].interest], [0, 150000, 4500], 'one day late: the whole first instalment is short');
  assert.equal(after.rows[1].paid, 450000);
});

test('the 12% and 36% reliefs: a shortfall bears no interest on the first two instalments if at least that share had been paid; one rupee less and the interest comes', () => {
  const base = { assessed: 1000000, instalments: spec.instalments, months234b: 0, yearEnd: '2026-03-31' };
  const pay = (date, amount) => ({ date, amount });
  const a = workInterest({ ...base, payments: [pay('2025-06-15', 120000), pay('2025-09-15', 240000), pay('2025-12-15', 390000), pay('2026-03-15', 250000)] });
  assert.deepEqual(a.rows.map((r) => [r.shortfall, r.relieved, r.interest]), [[30000, true, 0], [90000, true, 0], [0, false, 0], [0, false, 0]], '12% paid by 15 June and 36% by 15 September: the shortfalls bear no interest');
  const b = workInterest({ ...base, payments: [pay('2025-06-15', 119999), pay('2025-09-15', 240000), pay('2025-12-15', 390001), pay('2026-03-15', 250000)] });
  assert.deepEqual(b.rows.map((r) => [r.relieved, r.interest]), [[false, 900], [false, 2700], [false, 0], [false, 0]], 'one rupee under 12% and under 36%: 1% a month for 3 months on the shortfall rounded down to Rs 100');
});

test('section 234B applies only below 90% of the assessed tax; at 90% or more there is none, and the months are an input', () => {
  const base = { assessed: 1000000, instalments: [], yearEnd: '2026-03-31' };
  const at90 = workInterest({ ...base, months234b: 6, payments: [{ date: '2026-03-31', amount: 900000 }] });
  assert.deepEqual([at90.b234.applies, at90.b234.interest], [false, 0]);
  const below = workInterest({ ...base, months234b: 6, payments: [{ date: '2026-03-31', amount: 899900 }] });
  assert.deepEqual([below.b234.applies, below.b234.shortfall, below.b234.interest], [true, 100100, 6006]);
  const late = workInterest({ ...base, months234b: 6, payments: [{ date: '2026-04-01', amount: 900000 }] });
  assert.equal(late.b234.paid, 0, 'a payment after the year end is not advance tax of the year');
  assert.equal(workInterest({ ...REAL, months234b: 5 }).total, 9731018, 'one month less');
  assert.equal(workInterest({ ...REAL, months234b: 7 }).total, 10844246, 'one month more');
});

// ---------- on the real books ----------

const run = (options) => buildSnapshot({ zoho: replayZoho(options), config, fy: '2025-26', now: () => NOW });
let memo = null;
const base = async () => (memo ??= await run({}));
const advance = (snap, cfg = config) => buildBooks(snap, cfg, buildView(snap, cfg.audited)).tax.advance;
const status = (a) => Object.fromEntries(a.checks.map((c) => [c.id, c.status]));

test('the refresh reads the ledger of the two advance tax accounts into the snapshot', { skip }, async () => {
  const snap = await base();
  assert.equal(snap.tax.schema, 1);
  assert.equal(snap.tax.payments.length, 7);
  assert.equal(snap.tax.closing, 106100000);
  assert.equal(snap.tax.error, undefined);
  assert.ok(!snap.alerts.some((a) => a.code === 'TAX_UNAVAILABLE'));
});

test('on the real books: the payments add up to the Advance tax line, the accounts hold exactly that, every payment is in the year, and the interest agrees with the auditors', { skip }, async () => {
  const a = advance(await base());
  assert.equal(a.available, true, a.why);
  assert.deepEqual(status(a), { paid: 'OK', closing: 'OK', dates: 'OK', interest: 'OK' });
  assert.deepEqual(a.summary, { lines: 4, ok: 4, expl: 0, diff: 0, none: 0 });
  assert.equal(a.paid, 106100000);
  assert.equal(a.signed, 10287632);
  assert.ok(Math.abs(a.assessed - 161761452.77) < 1, `assessed ${a.assessed}`); // (the TDS line is Zoho's, to the paisa)
  assert.deepEqual(a.payments.map((p) => [p.date, p.cumulative]), [
    ['2025-12-06', 10000000], ['2025-12-12', 12000000], ['2025-12-27', 14600000], ['2026-01-27', 30200000], ['2026-02-17', 56100000], ['2026-03-14', 86100000], ['2026-03-28', 106100000],
  ]);
  assert.ok(a.payments.every((p) => p.inYear));
  assert.ok(Math.abs(a.payments.at(-1).percent - 106100000 / a.assessed) < 1e-9);
  assert.deepEqual([a.c234, a.b234.interest, a.worked.total], [6947948, 3339684, 10287632]);
  assert.equal(a.instalments.length, 4);
  const interest = a.checks.find((c) => c.id === 'interest');
  assert.match(interest.text, /1,02,87,632/);
  assert.match(interest.text, /the auditors' figure/);
  const closing = a.checks.find((c) => c.id === 'closing');
  assert.match(closing.text, /JN-Clean-3 \(31 March 2026\) moved ₹10,61,00,000 from one account to the other/);
  assert.match(closing.text, /"Advance Tax- F\.Y\. 2025-26"/);
  assert.equal(a.info.length, 1);
  assert.match(a.info[0], /first payment was made on 6 December 2025/);
  assert.equal(a.problems.length, 0);
  assert.equal(a.stays.length, 2);
});

test('the computation itself is untouched: every line still agrees with the audited computation and the interest line is still the auditors\' input', { skip }, async () => {
  const snap = await base();
  const tax = buildBooks(snap, config, buildView(snap, config.audited)).tax;
  assert.equal(tax.computation.summary.check, 0);
  assert.equal(tax.computation.summary.checksFailed, 0);
  assert.equal(tax.computation.byKey.c_int.value, 10287632);
});

test('a different amount is information with its reason, never an instruction: seven months of section 234B gives another interest; the auditors\' figure stays', { skip }, async () => {
  const snap = await base();
  const cfg = structuredClone(config);
  cfg.books.tax.advance.months_234b.value = 7;
  const a = advance(snap, cfg);
  assert.equal(status(a).interest, 'DIFF');
  const i = a.checks.find((c) => c.id === 'interest');
  assert.equal(i.diff, 556614, 'one more month of 234B on the shortfall of Rs 5,56,61,400');
  assert.match(i.text, /The auditors' figure stays in the computation/);
  assert.match(i.text, /number of months of section 234B/);
  assert.ok(!/(please|should|must) (change|correct|fix|post|pass)/i.test(i.text), 'it does not tell anyone to change the books');
  assert.equal(a.summary.diff, 1);
});

test('payments that do not add up to the line, an entry that does not belong, a payment outside the year: each is a difference with the amounts in words', { skip }, async () => {
  const snap = structuredClone(await base());
  snap.tax.payments.push({ date: '2026-04-05', amount: 500000, entry: 'X1', type: 'expense', narration: 'late', account: OLD });
  snap.tax.closing = 106100000;
  const a = advance(snap);
  assert.deepEqual(status(a), { paid: 'DIFF', closing: 'DIFF', dates: 'DIFF', interest: 'OK' });
  assert.match(a.checks.find((c) => c.id === 'paid').text, /total ₹10,66,00,000; the line is ₹10,61,00,000/);
  assert.match(a.checks.find((c) => c.id === 'dates').text, /5 April 2026 \(₹5,00,000\) falls outside 1 April 2025 to 31 March 2026/);
  assert.equal(a.payments.at(-1).inYear, false);
  assert.equal(a.b234.paid, 106100000, 'a payment after the year end is not counted for section 234B');
});

test('Zoho refuses the ledger, ignores the account filter or the snapshot is an older copy: the sheet and the rest keep working and the panel says why nothing was worked out', { skip }, async () => {
  const refused = await run({ taxFail: 'refused' });
  assert.match(refused.tax.error, /not authorized/i);
  assert.ok(refused.alerts.some((x) => x.code === 'TAX_UNAVAILABLE' && x.level === 'info'));
  const a = advance(refused);
  assert.equal(a.available, false);
  assert.match(a.why, /did not give the ledger of the advance tax accounts/);
  assert.deepEqual(a.checks, []);
  const books = buildBooks(refused, config, buildView(refused, config.audited));
  assert.equal(books.tax.computation.summary.check, 0, 'the computation does not depend on it');
  assert.equal(refused.meta.errors, 0, 'it is a detail layer: the run is not failed by it');

  const stray = await run({ taxIgnoreRule: true });
  assert.match(stray.tax.error, /ignored the account filter/);

  const old = structuredClone(await base());
  delete old.tax;
  const o = advance(old);
  assert.equal(o.available, false);
  assert.match(o.why, /not in this snapshot \(an older copy\): refresh the data/);
});

test('a year without the "advance" block has no panel, and a fault inside the working never takes the tax sheet down', { skip }, async () => {
  const snap = await base();
  const none = structuredClone(config);
  delete none.books.tax.advance;
  const t = buildBooks(snap, none, buildView(snap, none.audited)).tax;
  assert.equal(t.advance, undefined);
  assert.equal(buildAdvanceTaxChecks({ snapshot: snap, spec: null, sheet: t.computation }), null);
  const broken = structuredClone(config);
  broken.books.tax.advance.instalments = 7;
  const b = buildBooks(snap, broken, buildView(snap, broken.audited)).tax;
  assert.equal(b.advance.available, false);
  assert.match(b.advance.why, /could not be made/);
  assert.ok(b.computation.rows.length > 10, 'the computation is still there');
  const noMonths = structuredClone(config);
  delete noMonths.books.tax.advance.months_234b;
  const n = advance(snap, noMonths);
  assert.deepEqual(status(n), { paid: 'OK', closing: 'OK', dates: 'OK' });
  assert.match(n.problems[0], /number of months for section 234B is missing/);
});
