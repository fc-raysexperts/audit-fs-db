// The live check of the detail sheets (lib/overlay.mjs): small made-up sheets for the rules, then the real FY26 sheets against the real FY26 data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../lib/config.mjs';
import { buildSnapshot } from '../lib/snapshot.mjs';
import { buildView } from '../lib/present.mjs';
import { buildBooks } from '../lib/books.mjs';
import { buildWorkbook, readSheet, liveOverlay } from '../lib/workbook.mjs';
import { booklet } from '../lib/server.mjs';
import { buildOverlay, buildPool, normName, parseSource, similarity, OVERLAY_TOLERANCE } from '../lib/overlay.mjs';
import { replayZoho, haveFixtures } from '../testing/fakes.mjs';

const skip = !haveFixtures();
const config = loadConfig('2025-26');
const NOW = Date.parse('2026-10-15T06:30:00+05:30');
const clone = (x) => JSON.parse(JSON.stringify(x));

// ---------- made-up data ----------

const cust = (name, receivable) => ({ id: name, name, zb_total: receivable, adjustment: 0, receivable });
const party = (name, amount, cls = 'advance') => ({ id: name, name, net: cls === 'advance' ? amount : -amount, class: cls, amount, grossUp: 0 });
/** accounts: [name, closing, group = 'b'] - the group is the balance-sheet group (bucket) the account belongs to. */
const snap = ({ customers = [], parties = [], accounts = [] } = {}) => {
  const buckets = { b: { sum: 0, accounts: [] } };
  accounts.forEach(([name, closing, g = 'b'], i) => { (buckets[g] ??= { sum: 0, accounts: [] }).accounts.push({ id: String(i), code: String(i), name, closing }); });
  return { receivables: { customers }, suppliers: { parties }, buckets };
};
/** A sheet with a heading row, a header row, the given [name, amount] lines and (optionally) a total. */
const sheet = (...rows) => ({ rows });
const live = (extra = {}) => ({ label: 0, value: 1, blocks: [{ start: 'Customer', source: 'customer', group: 'c' }], groups: { c: { source: 'customer', title: 'Customers' } }, ...extra });

// ---------- sources ----------

test('names read the same whatever the spelling of the dots, spaces, case and "&"', () => {
  assert.equal(normName('Slyds Services Pvt Ltd_x000D_'), normName('SLYDS SERVICES PVT. LTD.'));
  assert.equal(normName('Rays & Co'), normName('rays and co'));
  assert.equal(normName(null), '');
});

test('a source is an account, a customer or a list of supplier classes - anything else is refused', () => {
  assert.deepEqual(parseSource('account'), { kind: 'account', classes: null, buckets: null });
  assert.deepEqual([...parseSource('account:car_loans+cash_credit').buckets], ['car_loans', 'cash_credit']);
  assert.deepEqual([...parseSource('supplier:advance+imprest').classes], ['advance', 'imprest']);
  assert.throws(() => parseSource('vendors'), /Unknown live source/);
});

test('an account source can be limited to some balance-sheet groups, a list of sources is read together, and a wrong group name is refused', () => {
  const s = snap({ accounts: [['Interest on Car Loan', -1635501, 'finance_cost'], ['Interest Payable', -93305, 'outstanding_expenses'], ['Cash', 5, 'cash_bank']], parties: [party('R Mohnot & Co', 810000, 'outstanding')] });
  assert.deepEqual([...buildPool(s, 'account:outstanding_expenses').keys()], ['interestpayable']);
  assert.deepEqual([...buildPool(s, 'account:outstanding_expenses+cash_bank').keys()].sort(), ['cash', 'interestpayable']);
  assert.deepEqual([...buildPool(s, ['account:outstanding_expenses', 'supplier:outstanding']).keys()].sort(), ['interestpayable', 'rmohnotandco']);
  assert.equal(buildPool(s, 'account').size, 3, 'without a group name: every account of every group');
  assert.throws(() => buildPool(s, 'account:outstanding_expensez'), /no group "outstanding_expensez"/);
});

test('names are as close as the words they share: the CGST line is nearer to CGST than to SGST', () => {
  assert.equal(similarity('Quite Another Firm', 'Zed Foods'), 0);
  assert.ok(similarity('CGST Input Unclaimed (RAJ)', 'CGST Input-Unclaimed') > similarity('CGST Input Unclaimed (RAJ)', 'SGST Input-Unclaimed'));
  assert.equal(similarity('Rays Foundation', 'Rays Foundation'), 1);
});

test('the pool adds lines of the same name, uses plain amounts and keeps to the asked classes', () => {
  const s = snap({
    customers: [cust('A Ltd', 100), cust('A  LTD.', 50), cust('B', -30)],
    parties: [party('P1', 10, 'advance'), party('P2', 20, 'imprest'), party('P3', 5, 'trade_payable')],
    accounts: [['Cash', -700]],
  });
  const c = buildPool(s, 'customer');
  assert.equal(c.get(normName('A Ltd')).value, 150);
  assert.equal(c.get(normName('B')).value, 30);
  assert.deepEqual([...buildPool(s, 'supplier:advance+trade_payable').keys()].sort(), ['p1', 'p3']);
  assert.equal(buildPool(s, 'account').get('cash').value, 700);
});

// ---------- ties and the total column ----------

test('a tie compares lines of the sheet, also from two blocks, with the one balance Zoho keeps; a payable line counts against an advance line', () => {
  const s = snap({
    accounts: [['PF Payable', -700, 'st']],
    parties: [party('Insurer A', 40, 'advance'), party('Contact X', 1000, 'advance')],
  });
  const sh = sheet(['Dues', 'Amount'], ['Employee', 300], ['Employer', 400], ['Total', 700], ['Advances', 'Amount'], ['Insurer A policy 1', 100], ['Insurer A policy 2', 60], ['Contact X loan', 900], ['Contact X advance', 100]);
  const cfg = {
    label: 0, value: 1,
    blocks: [{ start: 'Dues', source: 'account:st' }, { start: 'Advances', source: 'supplier:advance', group: 'a' }],
    groups: { a: { source: 'supplier:advance', title: 'Advances' } },
    ties: [
      { title: 'PF', lines: [{ block: 'Dues', label: 'Employee' }, { block: 'Dues', label: 'Employer' }], zoho: [{ source: 'account:st', name: 'PF Payable' }] },
      { title: 'X', lines: [{ block: 'Advances', label: 'Contact X loan' }, { block: 'Advances', label: 'Contact X advance' }], zoho: [{ source: 'supplier:advance', name: 'Contact X', group: 'a' }] },
      { title: 'Insurer', lines: [{ block: 'Advances', label: 'Insurer A policy 1' }, { block: 'Advances', label: 'Insurer A policy 2', sign: -1 }], zoho: [{ source: 'supplier:advance', name: 'Insurer A', group: 'a' }] },
    ],
  };
  const o = buildOverlay(s, sh, cfg);
  assert.deepEqual(o.ties.map((t) => [t.lines, t.signed, t.live, t.ok]), [[2, 700, 700, true], [2, 1000, 1000, true], [2, 40, 40, true]]);
  assert.equal(o.byRow[1].status, 'LUMP');
  assert.equal(o.byRow[3].status, 'OK', 'the total of the block is worked out with the tied lines at their signed figure');
  assert.equal(o.summary.none, 0);
  assert.equal(o.summary.lump, 6);
  assert.equal(o.summary.extras, 0, 'the balances of the ties are used, so they are not "extras"');
  // a different Zoho balance: the tie differs and so does the block total
  const off = buildOverlay(snap({ accounts: [['PF Payable', -650, 'st']], parties: s.suppliers.parties }), sh, cfg);
  assert.deepEqual([off.ties[0].ok, off.ties[0].diff], [false, -50]);
  assert.equal(off.byRow[3].status, 'DIFF');
  assert.equal(off.byRow[3].diff, -50);
  // a balance that Zoho does not have is named, and the tie is not guessed
  const gone = buildOverlay(snap({ accounts: [['Something else', -5, 'st']], parties: s.suppliers.parties }), sh, cfg);
  assert.deepEqual([gone.ties[0].ok, gone.ties[0].missing], [false, ['PF Payable']]);
});

test('a tie is left alone when its lines found a Zoho balance of their own, and a tie that names a line the sheet does not have is reported', () => {
  const s = snap({ accounts: [['PF Payable', -700, 'st'], ['Employee', -300, 'st']] });
  const sh = sheet(['Dues', 'Amount'], ['Employee', 300], ['Employer', 400]);
  const cfg = { label: 0, value: 1, blocks: [{ start: 'Dues', source: 'account:st' }], ties: [{ title: 'PF', lines: [{ block: 'Dues', label: 'Employee' }, { block: 'Dues', label: 'Employer' }], zoho: [{ source: 'account:st', name: 'PF Payable' }] }] };
  const o = buildOverlay(s, sh, cfg);
  assert.equal(o.ties.length, 0, 'Employee has its own account: nothing to tie');
  assert.equal(o.byRow[1].status, 'OK');
  const bad = buildOverlay(s, sh, { ...cfg, ties: [{ title: 'Nope', lines: [{ block: 'Dues', label: 'Nobody' }], zoho: [] }, { title: 'No block', lines: [{ block: 'Elsewhere', label: 'x' }], zoho: [] }] });
  assert.equal(bad.problems.length, 2);
  assert.match(bad.problems[0], /"Nobody" was not found/);
  assert.match(bad.problems[1], /no live source/);
});

test('a block may keep its Total in another column than its lines', () => {
  const s = snap({ accounts: [['A', -100], ['B', -200]] });
  const sh = sheet(['Dues', 'Lines', 'Total'], ['A', 100, null], ['B', 200, null], ['Total', null, 300]);
  const o = buildOverlay(s, sh, { label: 0, value: 1, blocks: [{ start: 'Dues', source: 'account', totalValue: 2 }] });
  assert.equal(o.byRow[3].status, 'OK');
  assert.equal(o.byRow[3].live, 300);
  const without = buildOverlay(s, sh, { label: 0, value: 1, blocks: [{ start: 'Dues', source: 'account' }] });
  assert.equal(without.byRow[3], undefined, 'without totalValue the total is not looked at');
});

// ---------- lines ----------

test('a line is OK within a rupee, DIFF beyond it, NONE when Zoho has no such name', () => {
  const s = snap({ customers: [cust('Alpha', 1000), cust('Beta', 2000.9), cust('Gamma', 500)] });
  const sh = sheet(['Customer', 'Amount'], ['Alpha', 1000], ['Beta', 2000], ['Gamma', 450], ['Delta', 77]);
  const o = buildOverlay(s, sh, live());
  assert.equal(o.byRow[1].status, 'OK');
  assert.equal(o.byRow[2].status, 'OK', `within ${OVERLAY_TOLERANCE} rupee`);
  assert.equal(o.byRow[3].status, 'DIFF');
  assert.equal(o.byRow[3].diff, 50);
  assert.equal(o.byRow[4].status, 'NONE');
  assert.deepEqual(o.blocks[0].notFound, [{ label: 'Delta', signed: 77 }]);
  assert.deepEqual([o.summary.ok, o.summary.diff, o.summary.none, o.summary.lines], [2, 1, 1, 4]);
});

test('a name spelt differently is matched by amount to the closest name, and says so; a tie is not guessed', () => {
  const s = snap({ customers: [cust('Akansha Tools Engineering Works', 500), cust('Zed Foods', 900)] });
  const o = buildOverlay(s, sheet(['Customer', 'Amount'], ['Akansha Tool Engineering Work', 500]), live());
  assert.equal(o.byRow[1].status, 'NAME');
  assert.equal(o.byRow[1].zohoName, 'Akansha Tools Engineering Works');
  // the same amount on a name that shares no word is not guessed
  const none = buildOverlay(s, sheet(['Customer', 'Amount'], ['Quite Another Firm', 900]), live());
  assert.equal(none.byRow[1].status, 'NONE');
  // two sheet lines that would both fit one Zoho line: the closer name gets it, the other one is not guessed
  const rival = buildOverlay(snap({ customers: [cust('Mega Airan', 899)] }), sheet(['Customer', 'Amount'], ['Mega Airen', 899], ['Mega Airen Traders', 899]), live());
  assert.deepEqual([rival.byRow[1].status, rival.byRow[2].status], ['NAME', 'NONE']);
  assert.equal(rival.byRow[1].zohoName, 'Mega Airan');
  // equally close: neither is guessed
  const tie = buildOverlay(snap({ customers: [cust('Mega Airan', 899)] }), sheet(['Customer', 'Amount'], ['Mega Airen Alpha', 899], ['Mega Airen Beta', 899]), live());
  assert.deepEqual([tie.byRow[1].status, tie.byRow[2].status], ['NONE', 'NONE']);
});

test('several lines of one amount are paired one to one by name (five investments of the same amount; CGST and SGST), whatever their order', () => {
  const inv = [['Investment in Equity- Rays O&M Experts Private Limited', 100000], ['Investment in Equity- Rays Rooftop SPV Private Limited', 100000], ['Investment in Equity- RPE Energy Reserve Private Limited', 100000], ['Investment in Equity- RPE Technologies Private Limited', 100000], ['Investment in Equity- Rays Experts Foundation', 50000]];
  const sh = sheet(['Particulars', 'Amount'], ['RPE Technologies Private Limited', 100000], ['Rays Rooftop SPV Private Limited', 100000], ['Rays O&M Experts Private Limited', 100000], ['RPE Energy Reserve Private Limited', 100000], ['Rays Experts Foundation', 50000], ['Total', 450000]);
  const lv = { label: 0, value: 1, blocks: [{ start: 'Particulars', source: 'account' }] };
  const o = buildOverlay(snap({ accounts: inv }), sh, lv);
  assert.deepEqual([1, 2, 3, 4, 5].map((r) => o.byRow[r].status), ['NAME', 'NAME', 'NAME', 'NAME', 'NAME']);
  assert.deepEqual([1, 2, 3, 4, 5].map((r) => o.byRow[r].zohoName), [inv[3][0], inv[1][0], inv[0][0], inv[2][0], inv[4][0]]);
  assert.equal(o.byRow[6].status, 'OK', 'and the total is worked out live');
  const gst = buildOverlay(snap({ accounts: [['CGST Input-Unclaimed', -4813537.95], ['SGST Input-Unclaimed', -4813537.95]] }), sheet(['Particulars', 'Amount'], ['SGST Input Unclaimed (RAJ)', 4813538], ['CGST Input Unclaimed (RAJ)', 4813538]), lv);
  assert.deepEqual([gst.byRow[1].zohoName, gst.byRow[2].zohoName], ['SGST Input-Unclaimed', 'CGST Input-Unclaimed']);
});

test('a line can be tied to an account of another name, or to the total of a whole list, in the configuration - and a same-named account of another group is kept out', () => {
  const s = snap({
    accounts: [['Interest on Car Loan', 1635501, 'finance_cost'], ['Interest Payable', -93305, 'outstanding_expenses'], ['Outstanding Liability', -41924, 'outstanding_expenses']],
    parties: [party('R Mohnot & Co', 810000, 'outstanding'), party('Rahul', 300.4, 'imprest'), party('Nidhi', 700.2, 'imprest')],
  });
  const sh = sheet(['Particulars', 'Amount'], ['Interest on Car Loan', 93305], ['Electricity Bill Payable', 41924], ['Audit Fees Payable- R.Mohnot & Co. LLP', 810000], ['Imprest Account', 1001], ['Total', 946230]);
  const block = { start: 'Particulars', source: ['account:outstanding_expenses', 'supplier:outstanding'], aliases: { 'Electricity Bill Payable': 'Outstanding Liability' }, sums: { 'Imprest Account': 'supplier:imprest' } };
  const o = buildOverlay(s, sh, { label: 0, value: 1, blocks: [block] });
  assert.deepEqual([1, 2, 3, 4].map((r) => o.byRow[r].status), ['NAME', 'OK', 'NAME', 'OK']);
  assert.equal(o.byRow[1].live, 93305, 'the interest payable, not the expense of the same name');
  assert.equal(o.byRow[2].zohoName, 'Outstanding Liability');
  assert.equal(Math.round(o.byRow[4].live * 10) / 10, 1000.6);
  assert.match(o.byRow[4].zohoName, /Total of the 2 balances/);
  assert.equal(o.byRow[5].status, 'OK');
  // with the group left open, the expense of the same name would be taken by name - which is why the groups are named
  const loose = buildOverlay(s, sh, { label: 0, value: 1, blocks: [{ ...block, source: 'account' }] });
  assert.equal(loose.byRow[1].status, 'DIFF');
});

test('a Zoho balance is used once: the second line of the same name is not compared with it', () => {
  const s = snap({ customers: [cust('Rupa Ram', 300)] });
  const o = buildOverlay(s, sheet(['Customer', 'Amount'], ['Rupa Ram', 300], ['Rupa Ram', 79000]), live());
  assert.equal(o.byRow[1].status, 'OK');
  assert.equal(o.byRow[2].status, 'NONE');
});

test('contacts whose name could not be fetched are paired by amount, but only when as many lines as contacts have it', () => {
  const ids = ['2346113000031051049', '2346113000031051058', '2346113000031051067'];
  const parties = ids.map((id) => party(id, 137885));
  const adv = { label: 0, value: 1, blocks: [{ start: 'Advance', source: 'supplier:advance', group: 'a' }], groups: { a: { source: 'supplier:advance', title: 'Advances' } } };
  const three = sheet(['Advance'], ['Devi Singh', 137885], ['Rewant Singh', 137885], ['Shyam Singh', 137885]);
  const paired = buildOverlay(snap({ parties }), three, adv);
  assert.deepEqual([1, 2, 3].map((r) => paired.byRow[r].status), ['NAME', 'NAME', 'NAME']);
  assert.equal(paired.extras.length, 0, 'all three contacts are accounted for');
  // two lines for three contacts: nothing is guessed
  const unequal = buildOverlay(snap({ parties }), sheet(['Advance'], ['Devi Singh', 137885], ['Rewant Singh', 137885]), adv);
  assert.deepEqual([1, 2].map((r) => unequal.byRow[r].status), ['NONE', 'NONE']);
  assert.equal(unequal.extras.length, 3);
});

test('a negative figure on the sheet is compared as a plain amount', () => {
  const s = snap({ accounts: [['Fines', 1812937]] });
  const cfg = { label: 0, value: 1, blocks: [{ start: 'Detail', source: 'account' }], groups: {} };
  const o = buildOverlay(s, sheet(['Detail of x'], ['Fines', -2005840]), cfg);
  assert.equal(o.byRow[1].status, 'DIFF');
  assert.equal(Math.round(o.byRow[1].diff), -192903);
});

// ---------- totals ----------

test('a total gets a live figure only when it really is the sum of the lines above it', () => {
  const s = snap({ customers: [cust('A', 100), cust('B', 250)] });
  const good = buildOverlay(s, sheet(['Customer', 'Amount'], ['A', 100], ['B', 240], ['Total', 340]), live());
  assert.equal(good.byRow[3].kind, 'total');
  assert.equal(good.byRow[3].live, 350); // 100 + 250 live
  assert.equal(good.byRow[3].status, 'DIFF');
  assert.equal(good.byRow[3].diff, 10);
  const tied = buildOverlay(s, sheet(['Customer', 'Amount'], ['A', 100], ['B', 250], ['Total', 350]), live());
  assert.equal(tied.byRow[3].status, 'OK');
  assert.deepEqual([tied.summary.totalsOk, tied.summary.totalsBad], [1, 0]);
  // a total that is not the sum of its lines (a typed-in number) is left alone
  const odd = buildOverlay(s, sheet(['Customer', 'Amount'], ['A', 100], ['B', 250], ['Total', 999]), live());
  assert.equal(odd.byRow[3], undefined);
});

test('a figure with no label under a list is read as its total', () => {
  const s = snap({ customers: [cust('A', 100), cust('B', 250)] });
  const o = buildOverlay(s, sheet(['Customer', 'Amount'], ['A', 100], ['B', 250], [null, 350]), live());
  assert.equal(o.byRow[3].kind, 'total');
  assert.equal(o.byRow[3].status, 'OK');
});

// ---------- blocks, groups and extras ----------

test('Zoho lines that no block used are the extras; a nil balance is not worth listing; blocks of a group share what they used', () => {
  const s = snap({ customers: [cust('A', 100), cust('B', 250), cust('New Customer', 4000), cust('Dust', 0.2)] });
  const two = { label: 0, value: 1, blocks: [{ start: 'First', source: 'customer', group: 'c' }, { start: 'Second', source: 'customer', group: 'c' }], groups: { c: { source: 'customer', title: 'Customers' } } };
  const o = buildOverlay(s, sheet(['First'], ['A', 100], ['Second'], ['B', 250]), two);
  assert.deepEqual(o.extras.map((e) => [e.name, e.value]), [['New Customer', 4000]]);
  assert.equal(o.extras[0].group, 'Customers');
  assert.equal(o.blocks.length, 2);
  assert.deepEqual(o.blocks.map((b) => [b.ok, b.none]), [[1, 0], [1, 0]]);
});

test('a block with no source stays as signed and is counted, and a block that is not on the sheet is a problem', () => {
  const s = snap({ customers: [cust('A', 100)] });
  const cfg = { label: 0, value: 1, blocks: [{ start: 'Loans', source: null }, { start: 'Customer', source: 'customer' }, { start: 'Nothing like this', source: 'customer' }], groups: {} };
  const o = buildOverlay(s, sheet(['Loans as on'], ['Bank', 10], ['Customer'], ['A', 100]), cfg);
  assert.equal(o.blocks[0].signed, 1);
  assert.equal(o.byRow[1], undefined, 'a signed-only line has no live columns');
  assert.equal(o.summary.keptAsSigned, 1);
  assert.equal(o.problems.length, 1);
  assert.match(o.problems[0], /Nothing like this/);
});

test('the heading of a block is found whatever its case or double spaces', () => {
  const s = snap({ customers: [cust('A', 100)] });
  const o = buildOverlay(s, sheet(['Details  of CUSTOMERS as on 31 March'], ['A', 100]), live({ blocks: [{ start: 'details of customers', source: 'customer' }] }));
  assert.equal(o.byRow[1].status, 'OK');
  assert.deepEqual(o.problems, []);
});

// ---------- the combined balance ----------

test('lines Zoho holds as one combined balance are compared together, and the total picks up the difference once', () => {
  const lumpCfg = { label: 0, value: 1, blocks: [{ start: 'Staff', source: 'supplier:advance', group: 'a', lump: '(no contact on the entry)' }], groups: { a: { source: 'supplier:advance', title: 'Advances' } } };
  const rows = [['Staff'], ['Hemraj', 18900], ['Rohan', 110000], ['Tarachand', 25000], [null, 153900]];
  const agree = buildOverlay(snap({ parties: [party('Hemraj', 18900), party('(no contact on the entry)', 135000)] }), sheet(...rows), lumpCfg);
  assert.deepEqual([2, 3].map((r) => agree.byRow[r].status), ['LUMP', 'LUMP']);
  assert.equal(agree.blocks[0].lump.signed, 135000);
  assert.equal(agree.blocks[0].lump.ok, true);
  assert.equal(agree.byRow[4].status, 'OK');
  assert.equal(agree.extras.length, 0, 'the combined balance is accounted for');
  assert.deepEqual([agree.summary.lump, agree.summary.lumpsOk, agree.summary.lumpsBad], [2, 1, 0]);

  const differ = buildOverlay(snap({ parties: [party('Hemraj', 18900), party('(no contact on the entry)', 134000)] }), sheet(...rows), lumpCfg);
  assert.equal(differ.blocks[0].lump.ok, false);
  assert.equal(differ.blocks[0].lump.diff, -1000);
  assert.equal(differ.byRow[4].status, 'DIFF');
  assert.equal(differ.byRow[4].diff, -1000, 'counted once, not once per line');

  // no such combined balance in Zoho: the lines are simply not found
  const absent = buildOverlay(snap({ parties: [party('Hemraj', 18900)] }), sheet(...rows), lumpCfg);
  assert.deepEqual([2, 3].map((r) => absent.byRow[r].status), ['NONE', 'NONE']);
});

// ---------- the real FY26 sheets ----------

let memo;
async function world() {
  if (!memo) {
    const snapshot = await buildSnapshot({ zoho: replayZoho(), config, fy: '2025-26', now: () => NOW });
    const statements = buildView(snapshot, config.audited);
    const books = buildBooks(snapshot, config, statements);
    memo = { snapshot, statements, books, workbook: buildWorkbook(snapshot, books, config.workbook, { ...config.books, related: config.related, register: config.register, subsidiaries: config.subsidiaries }) };
  }
  return memo;
}
const overlayOf = (snapshot, id) => liveOverlay(snapshot, readSheet(config.workbook, id));

test('the eleven checked sheets are checked, every block is found on its sheet, and no check fails to run', { skip }, async () => {
  const { workbook } = await world();
  assert.equal(workbook.summary.liveSheets, 11, 'the four lists + (update-17) the Closing Stock + (update-20) CWIP + (update-27) the related parties of Note 28(A) and RPT Transaction + (update-28) FA Add, Dep.Calc. and AOC-1');
  assert.equal(workbook.summary.liveProblems, 0);
  // update-23: every counter of the live check is a number (a comment once swallowed liveNone / liveLump, and the Workbook page printed NaN)
  for (const k of ['liveLines', 'liveOk', 'liveName', 'liveDiff', 'liveNone', 'liveLump', 'liveExtras']) assert.ok(Number.isFinite(workbook.summary[k]), `${k} is a number (${workbook.summary[k]})`);
  const status = Object.fromEntries(workbook.sheets.filter((s) => s.liveCheck).map((s) => [s.id, s.status]));
  assert.deepEqual(status, { 'closing-stock': 'semi', cwip: 'semi', 'debtors-ageing': 'semi', 'creditors-ageing': 'semi', 'p-l-grouping': 'live', 'bs-grouping': 'semi', 'note-28-a': 'semi', 'rpt-transaction': 'semi', 'fa-add': 'semi', 'dep-calc': 'semi', 'aoc-1': 'semi' }, 'update-28: FA Add, Dep.Calc. and AOC-1 are checked against Zoho\'s fixed asset register and the subsidiaries\' books (part live); update-27: Closing Stock is checked line by line but its signed sheet stays (semi, it was marked fixed by mistake); the two related-party sheets are checked figure by figure');
  for (const s of workbook.sheets.filter((x) => x.liveCheck)) assert.deepEqual(s.liveCheck.problems, [], s.id);
  assert.equal(liveOverlay((await world()).snapshot, readSheet(config.workbook, 'fa-add')), null, 'a sheet without a live entry has no check');
});

test('Debtors Ageing: every customer is found, one under another spelling, and the total agrees', { skip }, async () => {
  const { snapshot } = await world();
  const o = overlayOf(snapshot, 'debtors-ageing');
  assert.deepEqual([o.summary.lines, o.summary.ok, o.summary.name, o.summary.diff, o.summary.none], [127, 126, 1, 0, 0]);
  assert.deepEqual([o.summary.totalsOk, o.summary.totalsBad, o.summary.extras], [1, 0, 0]);
});

test('Creditors Ageing: the closing balance of every vendor agrees, also the three insurance policy lines (from the insurers\' ledger entries, by account)', { skip }, async () => {
  const { snapshot } = await world();
  const o = overlayOf(snapshot, 'creditors-ageing');
  const sh = readSheet(config.workbook, 'creditors-ageing');
  assert.equal(o.summary.diff, 0);
  assert.equal(o.summary.ok + o.summary.name, 167, '164 vendors + the ICICI Lombard payable (update-15) + the two HDFC ERGO payables, Rajasthan and Delhi (update-16)');
  assert.equal(o.summary.none, 0, 'the three insurance lines are no longer "not in Zoho"');
  assert.deepEqual([o.summary.lump, o.summary.tiesOk, o.summary.tiesBad], [0, 0, 0], 'since update-16 no line of this sheet is compared together with another');
  const row = (label) => Object.entries(o.byRow).find(([r]) => sh.rows[r][0] === label)[1];
  assert.deepEqual([row('ICICI LOMBARD GENERAL INSURANCE CO LTD (Raj.)').status, row('ICICI LOMBARD GENERAL INSURANCE CO LTD (Raj.)').live], ['OK', 51514.14]);
  assert.deepEqual([row('HDFC ERGO GENERAL INSURANCE CO LTD (RAJ)').status, row('HDFC ERGO GENERAL INSURANCE CO LTD (RAJ)').live], ['OK', 12650]);
  assert.deepEqual([row('HDFC ERGO GENERAL INSURANCE CO LTD(Delhi)').status, row('HDFC ERGO GENERAL INSURANCE CO LTD(Delhi)').live], ['OK', 414242.16]);
  assert.equal(o.summary.extras, 0, 'the audit-fee accrual (outstanding expenses) is not a vendor of this sheet');
  assert.equal(o.summary.totalsBad, 0);
  // an older snapshot (no splits): the three lines are not vendors in Zoho, as before update-15
  const old = clone(snapshot);
  delete old.splits;
  const o2 = overlayOf(old, 'creditors-ageing');
  assert.equal(o2.summary.none, 3);
  assert.ok(o2.blocks[0].notFound.every((n) => /insurance/i.test(n.label)));
  assert.equal(o2.summary.diff, 0);
  assert.equal(o2.problems.length, 1);
});

test('P&L Grouping: every account agrees except the one the auditors reclassified, which is flagged', { skip }, async () => {
  const { snapshot } = await world();
  const sh = readSheet(config.workbook, 'p-l-grouping');
  const o = liveOverlay(snapshot, sh);
  assert.equal(o.summary.lines, 44);
  assert.equal(o.summary.ok, 43);
  const bad = Object.entries(o.byRow).filter(([, v]) => v.kind === 'detail' && v.status !== 'OK');
  assert.equal(bad.length, 1);
  assert.match(sh.rows[bad[0][0]][1], /Fines/);
  assert.equal(Math.round(bad[0][1].diff), -192903);
});

test('BS Grouping: customers, vendors, imprest, retention and ledger accounts agree, the staff advances agree in total, nothing differs', { skip }, async () => {
  const { snapshot } = await world();
  const o = overlayOf(snapshot, 'bs-grouping');
  assert.equal(o.summary.diff, 0, JSON.stringify(Object.values(o.byRow).filter((v) => v.status === 'DIFF')));
  assert.equal(o.summary.ok, 803, 'since update-15 the deposits, the accrued interest, the PF shares, the insurers and RPE Energy Reserve are lines of their own too; since update-16 so are the two HDFC ERGO payables');
  assert.deepEqual([o.summary.lumpsOk, o.summary.lumpsBad], [1, 0]);
  assert.equal(o.summary.lump, 13, 'the eleven staff advances Zoho holds without a contact, and the 2 lines of the one tie that remains (ESI employee / employer)');
  assert.deepEqual([o.summary.tiesOk, o.summary.tiesBad], [1, 0]);
  assert.equal(o.summary.none, 0, 'every line of the sheet that is compared at all has its Zoho balance');
  assert.equal(o.summary.extras, 0, 'and Zoho has no balance that the sheet lacks');
  assert.equal(o.summary.totalsBad, 0);
  assert.equal(o.summary.totalsOk, 23);
  assert.equal(o.summary.keptAsSigned, 1, 'one nil line; the advances from customers are read from the ledger of the advance account since update-11');
});

test('BS Grouping: loans, outstanding expenses, investments, deposits, GST, revenue-authority and income-tax blocks are live and agree', { skip }, async () => {
  const { snapshot } = await world();
  const sh = readSheet(config.workbook, 'bs-grouping');
  const o = overlayOf(snapshot, 'bs-grouping');
  const block = (t) => o.blocks.find((b) => b.title.startsWith(t));
  const shape = (b) => [b.ok, b.name, b.diff, b.none, b.lumpLines, b.totalsOk, b.totalsBad].join(',');
  assert.equal(shape(block('Detail of Borrowings')), '0,4,0,0,0,1,0', 'the four car loans, by amount');
  assert.equal(shape(block('Detail of Outstanding Expenses')), '4,2,0,0,0,1,0', 'the accounts, the audit-fee vendor and the imprest total');
  assert.equal(shape(block('Detail of Investment In Companies')), '0,5,0,0,0,1,0');
  assert.equal(shape(block('Detail of Security Deposit')), '3,0,0,0,0,1,0');
  assert.equal(shape(block('Detail of Fixed Deposit')), '6,0,0,0,0,1,0');
  assert.equal(shape(block('Detail of Accured Interest')), '6,0,0,0,0,1,0');
  assert.equal(shape(block('Detail of Balance with Revenue')), '0,3,0,0,0,1,0');
  assert.equal(shape(block('Detail of  Unclaimed GST')), '1,3,0,0,0,1,0');
  assert.equal(shape(block('Detail of  Provision for Income Tax')), '1,2,0,0,0,1,0');
  // the income-tax provision nets the advance tax and the TDS against it: 6,59,49,085
  const tax = block('Detail of  Provision for Income Tax');
  const total = Object.entries(o.byRow).find(([r, v]) => v.kind === 'total' && Number(r) > tax.start && Number(r) < tax.end);
  assert.ok(Math.abs(total[1].live - 65949085) < 1, `live ${total[1].live}`);
  assert.equal(sh.rows[total[0]][4], 65949085);
  // nothing is left as signed but the short / long-term split of the loans (columns 2 and 3 are never compared)
  assert.deepEqual(o.blocks.filter((b) => !b.source).map((b) => [b.title, b.signed]), []);
});

test('BS Grouping: the two ESI shares are compared together with the one balance Zoho keeps, the HDFC ERGO payables line by line, and the retention line has its account', { skip }, async () => {
  const { snapshot } = await world();
  const sh = readSheet(config.workbook, 'bs-grouping');
  const o = overlayOf(snapshot, 'bs-grouping');
  assert.deepEqual(o.ties.map((t) => [t.lines, Math.round(t.signed * 100) / 100, t.ok]), [[2, 9404, true]]);
  assert.ok(o.ties.every((t) => t.missing.length === 0 && Math.abs(t.diff) < 0.01));
  const row = (label, nth = 1) => Object.entries(o.byRow).filter(([r]) => sh.rows[r][1] === label)[nth - 1];
  assert.equal(row('Employee Contribution', 2)[1].zohoName.slice(0, 3), 'ESI');
  assert.deepEqual([row('HDFC ERGO GENERAL INSURANCE CO LTD (RAJ)')[1].status, row('HDFC ERGO GENERAL INSURANCE CO LTD (RAJ)')[1].live], ['OK', 12650], 'Rajasthan: the bill without a billing state');
  assert.deepEqual([row('HDFC ERGO GENERAL INSURANCE CO LTD(Delhi)')[1].status, row('HDFC ERGO GENERAL INSURANCE CO LTD(Delhi)')[1].live], ['OK', 414242.16], 'Delhi: the three bills billed to Delhi');
  assert.equal(row('Rentention Money')[1].status, 'NAME', 'the account "Retention Money Payable" of Rs 4,61,84,816');
  // Statutory Liabilities (Total in column E): the PF shares are lines of their own, the ESI shares are tied; the block still has its live total
  const stat = o.blocks.find((b) => b.title.startsWith('Detail of Statutory Liabilities'));
  assert.deepEqual([stat.totalsOk, stat.totalsBad, stat.none, stat.lumpLines], [1, 0, 0, 2]);
  // changing a Zoho balance makes the tie differ, visibly
  const changed = clone(snapshot);
  changed.buckets.statutory_dues.accounts.find((a) => a.name === 'ESI Payable').closing -= 1000;
  const o2 = overlayOf(changed, 'bs-grouping');
  assert.deepEqual([o2.summary.tiesOk, o2.summary.tiesBad], [0, 1]);
  const esi = Object.values(o2.byRow).filter((v) => v.tie === 0);
  assert.equal(esi.length, 2);
  assert.ok(esi.every((v) => v.status === 'LUMP' && v.lumpOk === false));
  const stat2 = o2.blocks.find((b) => b.title.startsWith('Detail of Statutory Liabilities'));
  assert.equal(stat2.totalsBad, 1, 'and the block total, worked out live, differs too');
});

test('BS Grouping (update-15): fixed deposits and accrued interest bank by bank, the three security deposits, the PF shares, the insurers and RPE are lines of their own', { skip }, async () => {
  const { snapshot } = await world();
  const sh = readSheet(config.workbook, 'bs-grouping');
  const o = overlayOf(snapshot, 'bs-grouping');
  const at = (label, nth = 1) => Object.entries(o.byRow).filter(([r]) => sh.rows[r][1] === label)[nth - 1][1];
  const live = (label, nth = 1) => at(label, nth).live;
  // fixed deposits (6 banks), accrued interest (6), deposits (3): found in the clean-up journals of 31-Mar-2026 by the bank in the name of the old account
  assert.deepEqual(['Axis Bank', 'State Bank of India', 'HDFC Bank', 'Kotak Bank', 'IOB', 'ICICI'].map((b) => live(b, 1)), [1010360, 5313563, 4098808.14, 250015.97, 258092782, 86532587]);
  assert.deepEqual(['Axis Bank', 'State Bank of India', 'HDFC Bank', 'Kotak Bank', 'IOB', 'ICICI'].map((b) => live(b, 2)), [32447, 231090, 78118.11, 766, 2731818, 3314540.4]);
  assert.deepEqual(['Security Deposit CDSL', 'Security Deposit NSDL', 'EMD for Tenders'].map((l) => live(l)), [14502, 18885, 1000000]);
  // PF: the employee share is the one payroll entry that says so, the employer share is the rest
  assert.deepEqual([live('Employee Contribution', 1), live('Employer Contribution', 1)], [249484, 270274]);
  // the insurers and RPE Energy Reserve: Zoho keeps one balance per contact, but the entries sit in different accounts
  assert.deepEqual([live('HDFC ERGO GENERAL INSURANCE C Ltd'), live('ICICI LOMBARD GENERAL INSURANCE COMPANY LIMITED (Guj.)'), live('ICICI LOMBARD GENERAL INSURANCE CO LTD (Raj.)')], [426901.44, 58814.74, 51514.14]);
  assert.deepEqual([live('RPE ENERGY RESERVE PRIVATE LIMITED', 1), live('RPE ENERGY RESERVE PRIVATE LIMITED', 2)], [35000, 23000000], 'the advance (in Advance to Suppliers) and the loan (in Loan Given-Others)');
  assert.equal(o.summary.extras, 0, 'a contact taken account by account is not left over as one balance of its own');
  assert.deepEqual(o.problems, []);
});

test('update-16: HDFC ERGO - a bill billed to another state shows both payables as differences; bills Zoho will not open bring back the combined check', { skip }, async () => {
  const labelRows = (o, id) => {
    const sh = readSheet(config.workbook, id);
    return Object.entries(o.byRow).filter(([r]) => /HDFC ERGO GENERAL INSURANCE CO LTD ?\((RAJ|Delhi)\)/.test(`${sh.rows[r][0]}|${sh.rows[r][1]}`));
  };
  // (a) the tag of the 1,30,109.16 bill was changed from Delhi to nothing after the sign-off
  const tag = await buildSnapshot({ zoho: replayZoho({ billState: { '2346113000026693977': '' } }), config, fy: '2025-26', now: () => NOW });
  for (const id of ['creditors-ageing', 'bs-grouping']) {
    const o = overlayOf(tag, id);
    const rows = labelRows(o, id).map(([, v]) => [v.status, Math.round(v.live * 100) / 100, Math.round(v.diff * 100) / 100]).sort();
    assert.deepEqual(rows, [['DIFF', 142759.16, 130109.16], ['DIFF', 284133, -130109.16]], id);
    assert.deepEqual([o.summary.diff, o.summary.none, o.summary.totalsBad, o.problems], [2, 0, 0, []], `${id}: a difference to look at, not a failure of the check; the block totals still agree`);
  }
  // (b) Zoho refuses the bills: the two lines are compared together with the whole payable, as before update-16
  const blind = await buildSnapshot({ zoho: replayZoho({ billsFail: 'all' }), config, fy: '2025-26', now: () => NOW });
  for (const [id, ties] of [['creditors-ageing', [[2, 426892.16, true]]], ['bs-grouping', [[2, 9404, true], [2, 426892.16, true]]]]) {
    const o = overlayOf(blind, id);
    assert.deepEqual(o.ties.map((t) => [t.lines, Math.round(t.signed * 100) / 100, t.ok]), ties, id);
    assert.deepEqual(labelRows(o, id).map(([, v]) => v.status), ['LUMP', 'LUMP'], id);
    assert.deepEqual([o.summary.diff, o.summary.none, o.summary.tiesBad, o.problems], [0, 0, 0, []], id);
  }
  assert.equal(overlayOf(blind, 'bs-grouping').summary.lump, 15);
});

test('BS Grouping (update-15): a part that Zoho gives differently shows as a difference; a snapshot without the splits falls back to the old total-wise comparison', { skip }, async () => {
  const { snapshot } = await world();
  const changed = clone(snapshot);
  changed.splits.fixed_deposits.parts.find((p) => p.name === 'Kotak Bank').amount += 5000;
  const o = overlayOf(changed, 'bs-grouping');
  const sh = readSheet(config.workbook, 'bs-grouping');
  const bad = Object.entries(o.byRow).filter(([, v]) => v.kind === 'detail' && v.status === 'DIFF');
  assert.equal(bad.length, 1);
  assert.equal(sh.rows[bad[0][0]][1], 'Kotak Bank');
  assert.equal(o.summary.totalsBad, 1, 'and the total of the list, worked out live, differs too');
  assert.equal(Math.round(bad[0][1].diff), 5000);

  // an older stored snapshot (no splits) or one whose ledger could not be read: the lines are compared in total, as before update-15
  for (const splits of [undefined, { error: 'refused' }]) {
    const old = clone(snapshot);
    if (splits === undefined) delete old.splits; else old.splits = splits;
    const o2 = overlayOf(old, 'bs-grouping');
    assert.equal(o2.summary.diff, 0);
    assert.equal(o2.summary.none, 0);
    assert.equal(o2.summary.extras, 0, 'the insurers and RPE are one balance again, and no longer claimed by their parts');
    assert.deepEqual([o2.summary.tiesOk, o2.summary.tiesBad], [4, 0]);
    assert.equal(o2.summary.lump, 37, '11 staff advances + the three deposit lists (3 + 6 + 6 lines) + the 11 lines of the four ties');
    assert.equal(o2.problems.length, 7, 'the page says, for each of the seven lists that use a split, that it is compared in total, and why');
    assert.ok(o2.problems.every((x) => /compared in total/.test(x)), o2.problems.join(' | '));
  }
});

test('a changed book shows as a difference on the sheet, but is information - it does not become a problem of the books', { skip }, async () => {
  const { snapshot, statements } = await world();
  const changed = clone(snapshot);
  const c = changed.receivables.customers.find((x) => x.receivable > 1000);
  c.receivable += 5000;
  const o = overlayOf(changed, 'debtors-ageing');
  assert.equal(o.summary.diff, 1);
  assert.equal(o.summary.totalsBad, 1, 'and the total of the sheet, worked out live, now differs');
  const out = booklet(changed, config, statements);
  assert.equal(out.workbook.summary.liveDiff >= 1, true);
  assert.equal(out.workbook.summary.liveProblems, 0);
});

test('a sheet file that cannot be read is a failed check and counts as a problem', { skip }, async () => {
  const { snapshot, books } = await world();
  const w = buildWorkbook(snapshot, books, config.workbook, { ...config.books, related: config.related, register: config.register, subsidiaries: config.subsidiaries }, () => null);
  assert.equal(w.summary.liveProblems, 11);
  assert.ok(w.sheets.filter((s) => s.liveCheck).every((s) => s.liveCheck.error));
  assert.equal(w.summary.liveLines, 0);
});

// ---------- update-20: the CWIP tab ----------

test('the cwip source is a park table of the snapshot (the total of each park in both accounts), and a block can add several columns of the sheet (valueCols)', () => {
  assert.equal(parseSource('cwip').kind, 'cwip');
  const s = { ...snap(), cwip: { complete: true, pending: 0, parks: [{ name: 'Alpha', total: 150 }, { name: 'Beta Nagar', total: -20 }, { name: 'Gamma', total: 0 }] } };
  const pool = buildPool(s, 'cwip');
  assert.deepEqual([...pool.keys()].sort(), ['alpha', 'betanagar', 'gamma']);
  const cfg = { label: 0, value: 3, blocks: [{ start: 'Remaining CWIP', source: 'cwip', group: 'p', valueCols: [1, 2, 3], title: 'Parks' }], groups: { p: { source: 'cwip', title: 'Park' } } };
  const rows = [['Remaining CWIP', 'Intangible', 'Boundary', 'Transmission'], ['Alpha', 100, null, 50], ['Beta Nagar', null, 20, null], ['Gamma', 7, null, null], ['Delta', 5, 5, 5], [null, 197, 25, 55]];
  const o = buildOverlay(s, sheet(...rows), cfg);
  assert.deepEqual([1, 2, 3, 4].map((r) => o.byRow[r].status), ['OK', 'OK', 'DIFF', 'NONE'], 'the three columns of a line are one figure; Zoho gives a pool value (its size, not its sign)');
  assert.equal(o.byRow[1].signed, 150);
  assert.equal(o.byRow[2].diff, 0, 'the sign of a pool value is left out, as for every other account');
  assert.equal(o.byRow[3].diff, -7);
  assert.deepEqual(o.problems, []);
  assert.deepEqual(o.waiting, []);
});

test('the CWIP park split that is only half read is "still loading" - said on the page, but not a problem - and a snapshot without it is a problem that leaves the table as signed', () => {
  const rows = [['Remaining CWIP', 'A', 'B', 'C'], ['Alpha', 100, null, 50]];
  const cfg = { label: 0, value: 3, blocks: [{ start: 'Remaining CWIP', source: 'cwip', group: 'p', valueCols: [1, 2, 3] }], groups: { p: { source: 'cwip', title: 'Park' } } };
  const half = buildOverlay({ ...snap(), cwip: { complete: false, pending: 37, parks: [{ name: 'Alpha', total: 150 }] } }, sheet(...rows), cfg);
  assert.deepEqual(half.problems, []);
  assert.equal(half.waiting.length, 1);
  assert.match(half.waiting[0], /37 journals and bills behind the two accounts still to be read/);
  assert.equal(half.byRow[1], undefined, 'until then the lines carry no live figure: they stay as signed');
  for (const cwip of [undefined, { error: 'the ledger could not be read' }]) {
    const none = buildOverlay({ ...snap(), cwip }, sheet(...rows), cfg);
    assert.equal(none.problems.length, 1);
    assert.match(none.problems[0], /park split of the CWIP and IAUD ledgers is not in this snapshot/);
    assert.deepEqual(none.waiting, []);
    assert.equal(none.byRow[1], undefined);
  }
});

test('CWIP: 16 of the 18 parks give the signed figure, Kolayat and Bhamatsar differ by the one bill and say so (Explained), and the total agrees', { skip }, async () => {
  const { snapshot, workbook } = await world();
  const o = overlayOf(snapshot, 'cwip');
  assert.deepEqual([o.summary.lines, o.summary.ok, o.summary.name, o.summary.diff, o.summary.expl, o.summary.none], [18, 16, 0, 0, 2, 0]);
  assert.deepEqual([o.summary.totalsOk, o.summary.totalsBad], [1, 0]);
  assert.deepEqual([o.problems, o.waiting, o.extras.length], [[], [], 0], 'the three parks that are not on the sheet are capitalised in full, so nothing is left over');
  const rows = readSheet(config.workbook, 'cwip').rows;
  const differ = Object.entries(o.byRow).filter(([, v]) => v.status === 'EXPL').map(([r, v]) => [rows[r][0], Math.round(v.diff), v.explain.entries]);
  assert.deepEqual(differ, [['Bhamatsar', -84000, ['ES2526893']], ['Kolayat', 84000, ['ES2526893']]]);
  for (const [r, v] of Object.entries(o.byRow)) if (v.status === 'OK') assert.ok(Math.abs(v.diff) <= 1, `${rows[r][0]} is within Re 1 (${v.diff})`);
  assert.ok(Math.abs(Object.values(o.byRow).find((v) => v.kind === 'total').diff) < 1, 'the total of the sheet agrees to under a rupee');
  // the two ties of the sheet (CWIP and Intangibles in the Balance Sheet) keep agreeing
  const entry = workbook.sheets.find((s) => s.id === 'cwip');
  assert.deepEqual(entry.ties.map((t) => t.status), ['OK', 'OK']);
  assert.deepEqual([entry.liveCheck.problems, entry.status], [[], 'semi']);
});

test('CWIP: a park whose line moved in Zoho is a difference of its own, the other parks are not touched', { skip }, async () => {
  const { snapshot } = await world();
  const changed = clone(snapshot);
  const dechu = changed.cwip.parks.find((p) => p.name === 'Dechu');
  dechu.total += 5000;
  const o = overlayOf(changed, 'cwip');
  assert.equal(o.summary.diff, 1);
  assert.equal(o.summary.expl, 2, 'the two parks of the documented bill are still explained');
  assert.equal(o.summary.totalsBad, 1, 'and the total of the sheet, worked out live, now differs');
  assert.equal(o.summary.ok, 15);
});

test('CWIP: a park is Explained only when it differs by exactly the documented amount - any other figure is a difference', { skip }, async () => {
  const { snapshot } = await world();
  const changed = clone(snapshot);
  changed.cwip.parks.find((p) => p.name === 'Kolayat').total += 100; // 84,100 more than the sheet: not the bill's 84,000 any more
  const o = overlayOf(changed, 'cwip');
  const rows = readSheet(config.workbook, 'cwip').rows;
  const lines = Object.entries(o.byRow).filter(([, v]) => v.kind === 'detail');
  const named = (st) => lines.filter(([, v]) => v.status === st).map(([r]) => rows[r][0]);
  assert.deepEqual(named('DIFF'), ['Kolayat']);
  assert.deepEqual(named('EXPL'), ['Bhamatsar']);
  // the documented bill is no longer in the ledger: nothing is explained, both parks differ
  const gone = clone(snapshot);
  for (const p of gone.cwip.parks) delete p.explain;
  const o2 = overlayOf(gone, 'cwip');
  assert.deepEqual([o2.summary.diff, o2.summary.expl], [2, 0]);
});
