// The rest of the audited booklet - notes, cash flow, fixed assets, ratios, tax - and the list of all 34 sheets.
// Run against the real FY26 trial balance (fixtures/), so every figure is compared with the audited workbook.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, configDir } from '../lib/config.mjs';
import { buildSnapshot } from '../lib/snapshot.mjs';
import { buildView } from '../lib/present.mjs';
import { buildBooks } from '../lib/books.mjs';
import { ROW_TOLERANCE } from '../lib/notes.mjs';
import { buildWorkbook, readSheet, GROUP_ORDER } from '../lib/workbook.mjs';
import { buildTabs } from '../lib/tabs.mjs';
import { noteRows } from '../lib/rows.mjs';
import { cashFlowSummary } from '../lib/cashflow.mjs';
import { booklet } from '../lib/server.mjs';
import { plain, change, cell } from '../lib/format.mjs';
import { parse, refsOf } from '../lib/expr.mjs';
import { replayZoho, haveFixtures } from '../testing/fakes.mjs';

const skip = !haveFixtures();
const config = loadConfig('2025-26');
const NOW = Date.parse('2026-10-15T06:30:00+05:30');
let memo;
async function world() {
  if (!memo) {
    const snapshot = await buildSnapshot({ zoho: replayZoho(), config, fy: '2025-26', now: () => NOW });
    const statements = buildView(snapshot, config.audited);
    const books = buildBooks(snapshot, config, statements);
    const workbook = buildWorkbook(snapshot, books, config.workbook, { ...config.books, related: config.related, register: config.register, subsidiaries: config.subsidiaries });
    memo = { snapshot, statements, books, workbook };
  }
  return memo;
}
const clone = (x) => JSON.parse(JSON.stringify(x));

// ---------- the notes ----------

test('every line of Notes 3 to 27 agrees with the audited notes', { skip }, async () => {
  const { books } = await world();
  const n = books.notes;
  assert.ok(n.hasTie);
  assert.equal(n.summary.notes, 25);
  assert.ok(n.summary.lines >= 150, `only ${n.summary.lines} lines were compared`);
  assert.equal(n.summary.check, 0, JSON.stringify(n.notes.flatMap((q) => noteRows(q)).filter((r) => r.status === 'CHECK').map((r) => [r.key, r.diff])));
  for (const q of n.notes) {
    assert.equal(q.status, 'OK', `Note ${q.no}`);
    assert.ok(Math.abs(q.unplaced) <= ROW_TOLERANCE, `Note ${q.no}: ${q.unplaced} of the statements is not picked up by any line`);
  }
});

test('a note total is the sum of its counted lines, and every audited line was found', { skip }, async () => {
  const { books } = await world();
  for (const q of books.notes.notes) {
    if (!q.total || q.groups.length !== 1) continue;
    const counted = q.groups[0].rows.filter((r) => r.counted);
    if (!counted.length) continue; // a note built from a formula, not from its lines
    const added = counted.reduce((s, r) => s + r.value, 0);
    assert.ok(Math.abs(added - q.total.value) < 0.01, `Note ${q.no}: lines add up to ${added}, total shows ${q.total.value}`);
  }
  const rows = books.notes.notes.flatMap(noteRows).filter((r) => r.kind !== 'heading');
  assert.ok(rows.every((r) => r.audited === null || typeof r.audited === 'number'));
  assert.ok(rows.filter((r) => typeof r.audited === 'number').length >= 120, 'note lines with an audited figure');
});

test('a wrong figure is caught: change the stock by ₹1,000 and the notes, cash flow and the stock sheet all say so', { skip }, async () => {
  const { snapshot, statements, books, workbook } = await world();
  const bad = clone(snapshot);
  bad.statements.lines.inventories.value += 1000;
  const b2 = buildBooks(bad, config, statements);
  assert.ok(b2.notes.summary.check >= 1, 'Note 15 should differ');
  assert.equal(b2.notes.notes.find((q) => q.no === '15').status, 'CHECK');
  assert.ok(b2.summary.check > books.summary.check);
  const w2 = buildWorkbook(bad, b2, config.workbook, { ...config.books, related: config.related, register: config.register, subsidiaries: config.subsidiaries });
  assert.ok(w2.summary.tiesBad >= 1, 'the closing-stock working should no longer agree');
  assert.equal(workbook.summary.tiesBad, 0);
});

// ---------- the cash flow ----------

test('the cash flow ties line by line, and closes to the Balance Sheet and Note 17', { skip }, async () => {
  const { books } = await world();
  const cf = books.cashflow;
  assert.equal(cf.summary.check, 0, JSON.stringify([...cf.rows, ...cf.proof].filter((r) => r.status === 'CHECK').map((r) => [r.key, r.diff])));
  assert.ok(cf.summary.lines >= 37);
  assert.deepEqual(cf.checks.map((c) => c.status), ['OK', 'OK', 'OK']);
  const v = Object.fromEntries(cf.rows.filter((r) => r.kind !== 'heading').map((r) => [r.key, r]));
  assert.ok(Math.abs(v.cf_net_op.value + v.cf_net_inv.value + v.cf_net_fin.value - v.cf_net.value) < 0.01, 'A + B + C = the increase in cash');
  assert.ok(Math.abs(v.cf_open.value + v.cf_net.value - v.cf_close.value) < 0.01, 'opening + increase = closing');
});

test('the Overview gets a short cash flow: three activities, the change, opening and closing cash, each with last year', { skip }, async () => {
  const { books } = await world();
  const sm = cashFlowSummary(books.cashflow);
  assert.deepEqual(sm.rows.map((r) => r.key), ['cf_net_op', 'cf_net_inv', 'cf_net_fin', 'cf_net', 'cf_open', 'cf_close']);
  assert.equal(sm.closes, true);
  assert.equal(sm.hasPrev, true);
  const v = Object.fromEntries(sm.rows.map((r) => [r.key, r]));
  assert.ok(Math.abs(v.cf_net_op.value + v.cf_net_inv.value + v.cf_net_fin.value - v.cf_net.value) < 0.01);
  assert.ok(Math.abs(v.cf_open.value + v.cf_net.value - v.cf_close.value) < 0.01);
  assert.ok(Math.abs(v.cf_open.prev + v.cf_net.prev - v.cf_close.prev) < 0.01, "last year's three columns add up too");
  assert.equal(v.cf_open.value, books.cashflow.rows.find((r) => r.key === 'cf_open').value);
  assert.equal(cashFlowSummary(null), null);
  assert.equal(cashFlowSummary({ rows: [{ key: 'other', kind: 'line', value: 1, fy25: null }], checks: [] }), null, 'nothing to show when none of the six lines exists');
  const bad = cashFlowSummary({ ...books.cashflow, checks: [{ status: 'CHECK' }] });
  assert.equal(bad.closes, false, 'a failed proof is not hidden');
});

test("last year's column of the cash flow adds up by itself", { skip }, async () => {
  const { books } = await world();
  const v = Object.fromEntries(books.cashflow.rows.filter((r) => r.kind !== 'heading').map((r) => [r.key, r.fy25]));
  assert.ok(Math.abs(v.cf_net_op + v.cf_net_inv + v.cf_net_fin - v.cf_net) <= 2, 'A + B + C');
  assert.ok(Math.abs(v.cf_open + v.cf_net - v.cf_close) <= 2, 'opening + increase = closing');
  assert.ok(Math.abs(v.cf_cfo + v.cf_tax - v.cf_net_op) <= 2, 'cash generated less tax = A');
});

// ---------- fixed assets, ratios, tax ----------

test('the fixed-asset schedule agrees with Note 12, the Balance Sheet and the depreciation in the P&L', { skip }, async () => {
  const { books } = await world();
  const a = books.assets;
  assert.equal(a.summary.check, 0);
  assert.equal(a.summary.checksFailed, 0);
  assert.equal(a.classes.length, 8);
  for (const c of a.classes) {
    assert.ok(Math.abs(c.closeGross - c.openGross - c.additions + c.disposals) < 0.01, `${c.key}: additions`);
    assert.ok(Math.abs(c.net - (c.closeGross - c.closeAccdep)) < 0.01, `${c.key}: net block`);
  }
  assert.ok(Math.abs(a.grand.net - a.ppe.net - a.intangible.net) < 0.01);
});

test('ratios, earnings per share, MSME and both tax workings agree with the audited workbook', { skip }, async () => {
  const { books } = await world();
  for (const [name, sheet] of [['ratios', books.ratios], ['computation', books.tax.computation], ['deferred', books.tax.deferred]]) {
    assert.equal(sheet.summary.check, 0, `${name}: ${JSON.stringify(sheet.rows.filter((r) => r.status === 'CHECK').map((r) => [r.key, r.value, r.audited]))}`);
    assert.equal(sheet.summary.checksFailed, 0, name);
    assert.ok(sheet.summary.lines > 0, name);
  }
  assert.ok(Math.abs(books.ratios.byKey.r_current.value - 1.79) < 0.005);
  const eps = books.ratios.rows.find((r) => r.unit === 'eps');
  assert.ok(Math.abs(eps.value - 91.19) < 0.01, 'EPS');
});

test('the gratuity add-back of the Computation is worked out from Note 7 (closing less opening provision), not typed in', { skip }, async () => {
  const { books } = await world();
  const row = books.tax.computation.byKey.c_d7;
  assert.equal(row.value, 3257954);
  assert.equal(row.status, 'OK', 'and it still agrees with the audited Computation');
  assert.equal(config.books.tax.constants.dis_gratuity, undefined, 'the typed figure is gone');
  const n = books.notes.byKey.n7_grat;
  assert.equal(row.value, n.value - n.fy25);
});

test('one summary for the Checks page: 5 parts, nothing differing', { skip }, async () => {
  const { books } = await world();
  assert.equal(books.summary.parts.length, 5);
  assert.ok(books.summary.parts.every((p) => p.ok && p.href.startsWith('/')));
  assert.equal(books.summary.check, 0);
  assert.ok(books.summary.lines > 300, `${books.summary.lines} lines`);
});

// ---------- the configuration files ----------

function formulas(obj, out = []) {
  if (Array.isArray(obj)) obj.forEach((x) => formulas(x, out));
  else if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if ((k === 'expr' || k === 'lineExpr') && typeof v === 'string') out.push(v);
      else formulas(v, out);
    }
  }
  return out;
}

test('every name used in a formula exists: no typo can quietly turn a figure into zero', { skip }, async () => {
  const { snapshot, books } = await world();
  const accounts = new Set(Object.values(snapshot.buckets).flatMap((b) => b.accounts.map((a) => String(a.id))));
  const lines = new Set(Object.keys(snapshot.statements.lines));
  const noteKeys = new Set(Object.keys(books.notes.byKey));
  const consts = new Set([...Object.keys(config.books.notes.constants), ...Object.keys(config.books.tax.constants), ...Object.keys(config.books.cashflow.constants ?? {}), ...Object.keys(config.books.ratios.constants ?? {})]);
  const prior = new Set([...Object.entries(config.audited.bs), ...Object.entries(config.audited.pl)].filter(([, v]) => typeof v.fy25 === 'number').map(([k]) => k));
  const totals = new Set(['equity_total', 'noncurrent_liabilities_total', 'current_liabilities_total', 'noncurrent_assets_total', 'current_assets_total', 'total_assets', 'total_equity_liabilities', 'total_income', 'total_expenses', 'pbt', 'pat']);
  let count = 0;
  for (const [file, cfg] of Object.entries(config.books)) {
    if (!cfg) continue;
    const rowKeys = new Set();
    (function keys(o) { if (Array.isArray(o)) o.forEach(keys); else if (o && typeof o === 'object') { if (typeof o.key === 'string') rowKeys.add(o.key); Object.values(o).forEach(keys); } })(cfg);
    for (const text of formulas(cfg)) {
      count += 1;
      for (const { kind, id } of refsOf(parse(text))) {
        const where = `${file}: "${text}" -> ${kind}:${id}`;
        switch (kind) {
          case 'a': assert.ok(accounts.has(id), `unknown Zoho account in ${where}`); break;
          case 'n': case 'r': assert.ok(config.mapping.buckets[id], `unknown group in ${where}`); break;
          case 'l': assert.ok(lines.has(id), `unknown statement line in ${where}`); break;
          case 'i': assert.ok(config.inputs.inputs[id], `unknown year-end input in ${where}`); break;
          case 'c': assert.ok(consts.has(id), `unknown constant in ${where}`); break;
          case 'row': assert.ok(rowKeys.has(id), `unknown row in ${where}`); break;
          case 'x': case 'y': assert.ok(noteKeys.has(id), `unknown note row in ${where}`); break;
          case 'p': assert.ok(prior.has(id), `no audited figure for last year in ${where}`); break;
          case 't': assert.ok(totals.has(id), `unknown statement total in ${where}`); break;
          default: assert.fail(`unknown kind in ${where}`);
        }
      }
    }
  }
  assert.ok(count > 150, `only ${count} formulas checked`);
  // the fixed-asset accounts are plain id lists
  for (const c of config.books.assets.classes) for (const id of [...c.gross, ...c.accdep]) assert.ok(accounts.has(String(id)), `${c.key}: unknown account ${id}`);
});

// ---------- the 34 sheets ----------

test('all 34 sheets of the workbook have a place, and every working that carries a total agrees with the live figure', { skip }, async () => {
  const { workbook } = await world();
  const s = workbook.summary;
  assert.equal(s.sheets, 34);
  assert.equal(s.live + s.semi + s.fixed, 34);
  assert.ok(s.ties >= 19);
  assert.equal(s.tiesBad, 0, JSON.stringify(workbook.sheets.flatMap((x) => x.ties).filter((t) => t.status === 'CHECK')));
  assert.ok(s.maxDiff <= 10);
  assert.deepEqual(workbook.groups.map((g) => g.name), GROUP_ORDER);
  const ids = workbook.sheets.map((x) => x.id);
  assert.equal(new Set(ids).size, 34, 'ids are unique');
  const tabs = buildTabs(config.workbook.index);
  for (const x of workbook.sheets) {
    assert.ok(tabs.tabOfSheet[x.id], `${x.sheet} is on no tab`);
    if (x.status === 'fixed') assert.ok(x.file, `${x.sheet} is shown as signed, so it needs its file`);
  }
});

test('only sheets listed in the index can be read, and a path trick finds nothing', () => {
  assert.equal(readSheet(config.workbook, '../mapping'), null);
  assert.equal(readSheet(config.workbook, '..%2Fmapping'), null);
  assert.equal(readSheet(config.workbook, 'index'), null);
  assert.equal(readSheet(config.workbook, 'bs'), null, 'a live sheet has no exported file');
  const d = readSheet(config.workbook, 'cwip');
  assert.equal(d.entry.sheet, 'CWIP');
  assert.ok(d.rows.length > 5);
  assert.equal(readSheet(null, 'cwip'), null);
});

test('the exported sheets carry no portal password, user id or PAN', () => {
  const dir = path.join(configDir, config.workbook.dir);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 23);
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!/[A-Z]{5}[0-9]{4}[A-Z]/.test(text), `${f}: a PAN`);
    assert.ok(!/password|user ?id|passwd/i.test(text), `${f}: a sign-in detail`);
  }
});

test('every exported sheet is rectangular and has no empty row', () => {
  for (const x of config.workbook.index.sheets.filter((s) => s.file)) {
    const d = readSheet(config.workbook, x.id);
    assert.ok(d.rows.length > 0, x.id);
    assert.ok(d.rows.every((r) => r.some((c) => c !== null)), `${x.id}: an empty row`);
    assert.ok(d.rows.every((r) => r.length <= d.columns), `${x.id}: a row wider than the sheet`);
  }
});

// ---------- small pieces ----------

test('a problem in the booklet comes back as a message and never takes the statements down', { skip }, async () => {
  const { snapshot, statements } = await world();
  const broken = { ...config, books: { ...config.books, notes: { ...config.books.notes, notes: [{ no: '99', title: 'x', section: 'liabilities', groups: [{ rows: [{ key: 'bad', label: 'bad', expr: 'a:0000' }] }] }] } } };
  const ok = booklet(snapshot, config, statements);
  assert.equal(ok.bookProblems, 0);
  assert.ok(ok.books && ok.workbook);
  const out = booklet(snapshot, broken, statements);
  assert.ok(out.booksError || out.bookProblems > 0);
});

test('a year without notes files has no booklet (and no crash)', { skip }, async () => {
  const { snapshot, statements } = await world();
  const none = { ...config, books: { notes: null, cashflow: null, assets: null, ratios: null, tax: null }, workbook: null };
  assert.equal(buildBooks(snapshot, none, statements), null);
  assert.equal(buildWorkbook(snapshot, null, null), null);
  const out = booklet(snapshot, none, statements);
  assert.equal(out.books, null);
  assert.equal(out.bookProblems, 0);
});

test('a note is laid out as headings, lines, subtotals and a total', { skip }, async () => {
  const { books } = await world();
  const rev = noteRows(books.notes.notes.find((q) => q.no === '20'));
  assert.deepEqual(rev.map((r) => r.kind), ['heading', 'line', 'line', 'line', 'subtotal', 'heading', 'line', 'line', 'subtotal', 'heading', 'line', 'line', 'line', 'subtotal', 'total']);
  const reserves = noteRows(books.notes.notes.find((q) => q.no === '4'));
  assert.ok(reserves.some((r) => r.kind === 'memo'), 'working lines that are not added are marked');
  const one = noteRows(books.notes.notes.find((q) => q.no === '27'));
  assert.ok(one.every((r) => r.kind !== 'heading'), 'a one-group note has no heading');
});

test('ratios, changes and sheet cells read plainly', () => {
  assert.equal(plain(1.7922, 'times'), '1.79');
  assert.equal(plain(42.144, 'pct'), '42.14%');
  assert.equal(plain(0.6760653, 'fraction'), '67.61%');
  assert.equal(plain(5385500, 'shares'), '53,85,500');
  assert.equal(plain(null), '');
  assert.equal(change(0.1226), '+12.26%');
  assert.equal(change(-0.5233), '−52.33%');
  assert.equal(change(null), '');
  assert.equal(cell({ d: '2026-03-31' }), '31 Mar 2026');
  assert.equal(cell(25872864), '2,58,72,864');
  assert.equal(cell(-1500), '(1,500)');
  assert.equal(cell(0.2589), '0.2589');
  assert.equal(cell(12.5), '12.5');
  assert.equal(cell('text'), 'text');
  assert.equal(cell(null), '');
});
