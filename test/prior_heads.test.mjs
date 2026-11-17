// update-32: (1) the heads of Notes 20 to 27 of last year, rebuilt from the Trial Balance of 31-Mar-2025, show WHERE the explained differences of the Profit and Loss sit;
// (2) the answer to "why does the code look at Zoho today?": it does not - every dated request of a finished year stops on the last day of that year;
// (3) the helpers that print the differences and the date in the column heading.
// Needs fixtures/ (real, git-ignored); the tests that read them are skipped without it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../lib/config.mjs';
import { buildSnapshot } from '../lib/snapshot.mjs';
import { buildPriorSection, buildPriorView, checkPriorSpec } from '../lib/prior.mjs';
import { normalizeTB } from '../lib/tb.mjs';
import { gapInr, rupeesText, shortDate } from '../lib/format.mjs';
import { replayZoho, haveFixtures, J } from '../testing/fakes.mjs';

const skip = !haveFixtures();
const config = loadConfig('2025-26');
const spec = config.prior;
const NOW = Date.parse('2026-10-15T06:30:00+05:30');
const clone = (x) => JSON.parse(JSON.stringify(x));
const run = (over = {}) => {
  const alerts = [];
  const section = buildPriorSection({ spec: over.spec ?? spec, raw: over.raw ?? J('fixtures/tb_fy25_nonzero.raw.json'), mapping: config.mapping, alerts });
  return { section, alerts };
};
const viewOf = (section, over = {}) => buildPriorView({ section, audited: config.audited, notes: config.books.notes, spec: over.spec ?? spec });
const headById = (view) => Object.fromEntries(view.heads.filter((r) => r.status).map((r) => [r.id, r]));

// ---------- the configuration of the heads ----------

test('config/prior.fy25.json: the heads of Notes 20, 21, 24, 25, 26 and 27, each account of the old chart under one head only', () => {
  assert.deepEqual(checkPriorSpec(spec), []);
  assert.deepEqual(spec.heads.map((g) => g.note), ['20', '21', '24', '25', '26', '27']);
  assert.deepEqual(spec.heads.map((g) => g.line), ['revenue', 'other_income', 'operating_expenses', 'employee', 'finance', 'other_expenses']);
  const ids = spec.heads.flatMap((g) => g.items.flatMap((i) => i.accounts.map((a) => a.id)));
  assert.equal(new Set(ids).size, ids.length, 'no account is under two heads');
  assert.equal(spec.heads.flatMap((g) => g.items).length, 41);
  // every head names rows of the signed notes that exist
  const rows = new Set();
  const walk = (o) => { if (o && typeof o === 'object') { if (!Array.isArray(o) && o.key && typeof o.fy25 === 'number') rows.add(o.key); for (const v of Array.isArray(o) ? o : Object.values(o)) walk(v); } };
  walk(config.books.notes);
  for (const g of spec.heads) for (const it of g.items) for (const k of it.signed) assert.ok(rows.has(k), `${it.key}: the note row ${k} has a last-year figure`);
});

test('checkPriorSpec says what is wrong with the heads', () => {
  const bad = clone(spec);
  bad.heads[0].items[1].accounts.push(bad.heads[0].items[0].accounts[0]);
  bad.heads[1].items[0].key = bad.heads[0].items[0].key;
  bad.heads[2].sign = 2;
  const why = checkPriorSpec(bad).join(' | ');
  assert.match(why, /is under two heads/);
  assert.match(why, /is listed twice/);
  assert.match(why, /heads of note 24 need note, line, sign/);
  assert.match(checkPriorSpec({ ...clone(spec), heads: [] }).join(' | '), /`heads` must be a list of notes/);
});

// ---------- the heads against the real Trial Balance of 31-Mar-2025 ----------

test('the heads of each note add up to its line of the Profit and Loss, to the paisa', { skip }, () => {
  const { section, alerts } = run();
  assert.deepEqual(alerts, []);
  assert.equal(section.headChecks.length, 6);
  for (const c of section.headChecks) {
    assert.ok(c.ok, `Note ${c.note}`);
    assert.equal(c.sum, section.lines[c.line], `Note ${c.note} adds up to ${c.line}`);
  }
  assert.equal(Object.keys(section.heads).length, 41);
  assert.deepEqual(JSON.parse(JSON.stringify(section)), section, 'the section survives a trip through JSON (no -0, no undefined)');
});

test('37 of the 41 heads agree with the signed notes within Rs 5 and the other 4 are exactly the explained ones', { skip }, () => {
  const v = viewOf(run().section);
  assert.deepEqual(v.headsSummary, { ok: 37, expl: 4, diff: 0, none: 0, total: 41 });
  const r = headById(v);
  assert.deepEqual(Object.values(r).filter((x) => x.status === 'EXPL').map((x) => [x.id, Math.round(x.diff)]), [
    ['n20_epc', 364000],
    ['n27_aud', 100000],
    ['n27_legal', -100000],
    ['n27_trav', 398515],
  ]);
  assert.deepEqual(v.headsExplained.map((e) => e.id), ['n20_epc', 'n27_aud', 'n27_legal', 'n27_trav']);
  for (const e of v.headsExplained) assert.ok(e.text.length > 30 && !/\bchange\b.*\bZoho\b/i.test(e.text), 'it explains, it never asks for a change in Zoho');
  // every other head of Note 20 agrees to the rupee: the whole revenue difference sits in EPC sales
  for (const id of ['n20_roof', 'n20_gen', 'n20_om', 'n20_cons', 'n20_rent', 'n20_scrap', 'n20_oth']) assert.equal(r[id].status, 'OK', id);
  // the two audit-fee heads cancel (the signed Note 27 moves Rs 1,00,000 from auditors' remuneration to legal and professional)
  assert.ok(Math.abs(r.n27_aud.diff + r.n27_legal.diff) <= 1);
  // the expense difference is the revenue difference plus the purchases difference: 3,64,000 + 34,517 = 3,98,517
  assert.ok(Math.abs(r.n27_trav.diff - (r.n20_epc.diff + 34517)) <= 5, 'travelling = EPC sales + the part the signed statements show under purchases');
  // the head figures are the figures behind the lines: 'Bad debts and balances written off' is two signed rows added up
  assert.equal(Math.round(r.n27_bad_wo.zoho), 65573320);
  assert.equal(Math.round(r.n27_bad_wo.signed), 65573320);
  // the heads of a note add up to the line the P&L above shows
  const lineOf = Object.fromEntries(v.pl.filter((x) => x.status).map((x) => [x.id, x]));
  const sum = (ids) => ids.reduce((t, id) => t + r[id].zoho, 0);
  assert.ok(Math.abs(sum(['n20_epc', 'n20_roof', 'n20_gen', 'n20_om', 'n20_cons', 'n20_rent', 'n20_scrap', 'n20_oth']) - lineOf.revenue.zoho) <= 1);
});

test('a head whose difference is not the explained amount is a difference, and a head with no signed figure is not compared', { skip }, () => {
  const { section } = run();
  const moved = clone(spec);
  moved.explain.find((e) => e.key === 'n27_trav').diff = 300000;
  assert.equal(headById(viewOf(section, { spec: moved })).n27_trav.status, 'DIFF', 'the explained amount no longer fits');
  assert.equal(headById(viewOf(section, { spec: moved })).n20_epc.status, 'EXPL', 'the other explanations are not touched');
  const v = buildPriorView({ section, audited: config.audited, notes: null, spec });
  assert.equal(v.headsSummary.none, v.headsSummary.total, 'no notes, no signed figures: nothing compared');
  assert.ok(v.heads.filter((r) => r.kind === 'line').every((r) => typeof r.zoho === 'number'), 'the Zoho figures still show');
});

test('an account of last year under no head is a warning that names the note; the statements are untouched', { skip }, () => {
  const raw = J('fixtures/tb_fy25_nonzero.raw.json');
  const base = run().section;
  // take the account with the biggest closing balance off its head: the head no longer adds up
  const lost = clone(spec);
  const big = lost.heads.find((g) => g.note === '27').items.find((i) => i.key === 'n27_bad_wo');
  const tb = normalizeTB(raw);
  const byId = new Map(tb.accounts.map((x) => [x.id, x]));
  big.accounts.sort((x, y) => Math.abs(byId.get(String(y.id))?.closing ?? 0) - Math.abs(byId.get(String(x.id))?.closing ?? 0));
  const gone = big.accounts.shift();
  const goneAmount = Math.abs(byId.get(String(gone.id)).closing);
  assert.ok(goneAmount > 1000, 'the account carries a real balance');
  const alerts = [];
  const section = buildPriorSection({ spec: lost, raw, mapping: config.mapping, alerts });
  const a = alerts.find((x) => x.code === 'PRIOR_HEADS_INCOMPLETE');
  assert.ok(a, 'a head that does not add up is reported');
  assert.equal(a.level, 'warn');
  assert.match(a.message, /Note 27/);
  assert.match(a.message, /not under any head/);
  assert.equal(section.headChecks.find((c) => c.note === '27').ok, false);
  assert.equal(section.headChecks.filter((c) => !c.ok).length, 1, 'only that note is reported');
  assert.equal(section.lines.other_expenses, base.lines.other_expenses, 'the line of the statement is not affected');
  assert.equal(section.error, undefined, 'a warning, not an error: the section is still there');
  const v = viewOf(section, { spec: lost });
  assert.equal(v.checks.some((c) => c.key === 'heads_27' && !c.ok), true, 'the panel is told');
  assert.deepEqual(v.summary, { ok: 45, expl: 5, diff: 0, none: 0, total: 50 }, 'the lines above are the same');
});

test('a snapshot made before update-32 has no heads: the view has none and nothing breaks', { skip }, () => {
  const { section } = run();
  delete section.heads;
  delete section.headChecks;
  const v = viewOf(section);
  assert.equal(v.heads, null);
  assert.equal(v.headsSummary, null);
  assert.deepEqual(v.headsExplained, []);
  assert.deepEqual(v.summary, { ok: 45, expl: 5, diff: 0, none: 0, total: 50 }, 'the lines are the same as before');
});

test('the refresh puts the heads in the snapshot and the page view carries them', { skip }, async () => {
  const snap = await buildSnapshot({ zoho: replayZoho(), config, fy: '2025-26', now: () => NOW });
  assert.equal(Object.keys(snap.prior.heads).length, 41);
  assert.equal(snap.prior.headChecks.every((c) => c.ok), true);
  assert.deepEqual(snap.alerts.filter((a) => /^PRIOR_/.test(a.code)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(snap.prior)), snap.prior);
  const { priorYear } = await import('../lib/server.mjs');
  const view = priorYear(snap, config);
  assert.deepEqual(view.headsSummary, { ok: 37, expl: 4, diff: 0, none: 0, total: 41 });
});

// ---------- "Zoho today" or "Zoho at 31 March 2026"? ----------

test('every dated request of the FY26 run stops on 31 March 2026: the tabs show Zoho AT the year end, never Zoho today', { skip }, async () => {
  const zoho = replayZoho();
  const snap = await buildSnapshot({ zoho, config, fy: '2025-26', now: () => NOW });
  assert.equal(snap.meta.asOf, '2026-03-31');
  const end = '2026-03-31';
  const dated = [];
  const undated = new Set();
  for (const c of zoho.calls) {
    const q = c.query ?? {};
    const dates = Object.entries(q).filter(([k, v]) => /date|from|to|as_of|period/i.test(k) && /^\d{4}-\d\d-\d\d$/.test(String(v)));
    if (dates.length) dated.push({ path: c.path.replace(/\/\d{10,}/g, '/:id'), dates });
    else undated.add(c.path.replace(/\/\d{10,}/g, '/:id'));
  }
  assert.ok(dated.length > 40, 'the run has many dated report requests');
  for (const d of dated) for (const [k, v] of d.dates) {
    if (/to|as_of/i.test(k) && !/from/i.test(k)) assert.ok(v <= end, `${d.path}: ${k}=${v} is after the year end`);
  }
  // the reports that give the balances on the tabs carry the year end itself
  for (const p of ['/reports/trialbalance', '/reports/aragingsummary', '/reports/customerbalancesummary', '/reports/generalledgerdetails', '/reports/vendorbalancesummary', '/reports/inventoryvaluation']) {
    assert.ok(dated.some((d) => d.path === p && d.dates.some(([k, v]) => /to|as_of/i.test(k) && v === end)), `${p} is asked up to ${end}`);
  }
  // the only requests without a date are reads of single records and lists of master data (bills, journals, contacts, items, fixed assets, vendors), which the refresh checks against the dated figures
  for (const p of undated) assert.match(p, /^\/(bills|journals|contacts|items|fixedassets|vendors)(\/:id(\/history)?)?$/, `${p} is a read of a record or of master data`);
});

// ---------- the helpers ----------

test('gapInr: the difference column in exact rupees with Indian digit grouping', () => {
  assert.equal(gapInr(398517.47), '3,98,517.47');
  assert.equal(gapInr(-34517.34), '−34,517.34');
  assert.equal(gapInr(363999.24), '3,63,999.24');
  assert.equal(gapInr(1.96), '1.96');
  assert.equal(gapInr(-0.4), '−0.40');
  assert.equal(gapInr(0), '0.00');
  assert.equal(gapInr(-0.0000001), '0.00', 'no -0.00');
  assert.equal(gapInr(1234567.891), '12,34,567.89');
  assert.equal(gapInr(null), '');
  assert.equal(gapInr(undefined), '');
  assert.equal(gapInr(NaN), '');
});

test('rupeesText: whole rupees for a sentence, never "0.04 crore" or a dash', () => {
  assert.equal(rupeesText(363999.24), '₹3,63,999');
  assert.equal(rupeesText(-34517.34), '₹34,517', 'the sign is left to the sentence');
  assert.equal(rupeesText(398517.47), '₹3,98,517');
  assert.equal(rupeesText(100000), '₹1,00,000');
  assert.equal(rupeesText(0), '₹0');
  assert.equal(rupeesText(12345678.5), '₹1,23,45,679');
});

test('shortDate: the date in the heading "Zoho at 31 Mar 2026"', () => {
  assert.equal(shortDate('2026-03-31'), '31 Mar 2026');
  assert.equal(shortDate('2025-10-01'), '1 Oct 2025');
  assert.equal(shortDate('2026-01-05'), '5 Jan 2026');
  assert.equal(shortDate(''), '');
  assert.equal(shortDate(null), '');
});
