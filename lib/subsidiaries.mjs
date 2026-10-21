// update-28: the SUBSIDIARIES' OWN BOOKS in Zoho against Form AOC-1 (config/subsidiaries.fyYY.json) - and the loan each of them owes the company, for Note 28(A).
//
// Two layers, like lib/related.mjs:
//   READ   the trial balance and the profit and loss account of each subsidiary organisation -> the `subsidiaries` section of the snapshot
//   CHECK  snapshot.subsidiaries + the cells of AOC-1 -> a mark beside every figure it can confirm
//
// What was seen on the real books (21-Oct-2026): for four of the five subsidiaries Zoho's own books give the share capital, the reserves, the turnover, the loss before tax, the tax and
// the loss after tax of the signed Form AOC-1 to the rupee (Rays O&M by Rs 1.13 at most). The total assets and total liabilities differ from the signed ones by the SAME amount on
// both sides (Rays O&M 6,99,792, RPE Energy Reserve 14,66,285.84, Rays Experts Foundation 14,006; RPE Technologies agrees), which is told apart from a real difference below.
// Rays Rooftop SPV: the Zoho user of that organisation is disabled, Zoho gives nothing: it stays as signed.

import { normalizeTB } from './tb.mjs';
import { num, r2 } from './util.mjs';

export const SUBSIDIARIES_SCHEMA = 1;
export const SUBSIDIARY_TOLERANCE = 10; // Rs, as everywhere else
export const SAME_BOTH_SIDES = 5; // Rs: the two sides of a presentation difference may differ by the rounding of the signed sheet

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const names = (list) => (list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list.at(-1)}` : list[0] ?? '');
const inr = (x) => new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(x);

/* ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ */
/* READ                                                                                                                                                                             */
/* ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ */

/**
 * A subsidiary's trial balance (from the day it began, so every balance is the whole of its life; debit positive, credit negative) -> the balance sheet figures of Form AOC-1:
 * share capital (the capital accounts named in the configuration), reserves (the profit of the years plus any other equity account), total assets and total liabilities (a balance
 * is an asset when it is a debit and a liability when it is a credit, whatever the heading Zoho puts the account under: a deferred tax asset is listed among the liabilities),
 * and the loan from the company (the account named in the configuration).
 */
export function subBalance(raw, sub) {
  const tb = normalizeTB(raw);
  const capital = new Set((sub.capital ?? []).map(String));
  const kind = (a) => String(a.accountType ?? '').toLowerCase();
  const sheet = tb.accounts.filter((a) => ['asset', 'liability'].includes(kind(a)));
  const closing = (ids) => tb.accounts.filter((a) => ids.has(a.id)).reduce((t, a) => t + a.closing, 0);
  const profit = -tb.accounts.filter((a) => ['income', 'expense'].includes(kind(a))).reduce((t, a) => t + a.closing, 0);
  const otherEquity = -tb.accounts.filter((a) => kind(a) === 'equity' && !capital.has(a.id)).reduce((t, a) => t + a.closing, 0);
  return {
    shareCapital: r2(-closing(capital)),
    reserves: r2(profit + otherEquity),
    totalAssets: r2(sheet.filter((a) => a.closing > 0).reduce((t, a) => t + a.closing, 0)),
    totalLiabilities: r2(-sheet.filter((a) => a.closing < 0).reduce((t, a) => t + a.closing, 0)),
    loan: sub.loan ? r2(-closing(new Set([String(sub.loan)]))) : null,
    balanced: Math.abs(tb.accounts.reduce((t, a) => t + a.closing, 0)) <= 1,
    accounts: tb.accounts.length,
  };
}

/** The accounts of the profit and loss tree, whatever their depth. */
function* accountsOf(node) {
  for (const a of node?.accounts ?? []) {
    if (a.type === 'account' || a.account_id) yield a;
    yield* accountsOf(a);
  }
}

/**
 * A subsidiary's profit and loss account (Zoho's new-flow tree) -> turnover (Operating Income), the profit before tax, the tax and the profit after tax of Form AOC-1.
 * The tax is the account with the code `taxCode` (Deferred Tax Expense); its sign is the one of the signed form: a credit (a deferred tax asset created) is positive, it adds to the loss.
 */
export function subProfit(raw, taxCode) {
  const root = raw?.data ?? raw;
  const pl = root?.profit_and_loss;
  if (!pl || !Array.isArray(pl.accounts)) throw new Error('The profit and loss response has an unexpected shape (no profit_and_loss tree)');
  const node = (name) => pl.accounts.find((n) => n.node_name === name);
  const value = (x) => num(x?.values?.[0]?.total_sub_account ?? x?.values?.[0]?.total);
  for (const need of ['operating_income', 'net_profit_loss']) if (!node(need)) throw new Error(`The profit and loss response has no "${need}" line`);
  const net = value(node('net_profit_loss'));
  let taxExpense = 0;
  if (taxCode) for (const a of accountsOf(pl)) if (String(a.account_code ?? '').trim() === taxCode) taxExpense += num(a.values?.[0]?.total ?? a.values?.[0]?.total_sub_account);
  return { turnover: r2(value(node('operating_income'))), pbt: r2(net + taxExpense), tax: r2(-taxExpense), pat: r2(net) };
}

/**
 * The `subsidiaries` section of the snapshot: { schema, to, subs: { key: { name, org, from, balance: {...} | { error }, profit: {...} | { error } } } }.
 * `reads` = { key: { tb, pl } } - raw responses, `{ error }` (Zoho refused, e.g. the login is not a user of that organisation) or null (not asked for). A subsidiary that cannot
 * be read keeps its signed figures; an information line in the alerts says why.
 */
export function buildSubsidiariesSection({ spec, reads, to, alerts = [] }) {
  const subs = {};
  for (const [key, sub] of Object.entries(spec.subs ?? {})) {
    const got = reads?.[key] ?? { tb: null, pl: null };
    const part = (name, raw, make) => {
      if (raw === null || raw === undefined) return { error: 'not asked for' };
      if (raw.error) return { error: raw.error.message ?? String(raw.error) };
      try { return make(raw); } catch (e) { return { error: e.message }; }
    };
    const balance = part('trial balance', got.tb, (raw) => subBalance(raw, sub));
    const profit = part('profit and loss', got.pl, (raw) => subProfit(raw, spec.taxCode));
    subs[key] = { name: sub.name, org: String(sub.org), from: sub.from, balance, profit };
    const failed = [balance.error && `trial balance: ${balance.error}`, profit.error && `profit and loss: ${profit.error}`].filter(Boolean);
    if (failed.length) alerts.push({ level: 'info', code: 'SUBSIDIARY_UNAVAILABLE', message: `The books of ${sub.name} could not be read from Zoho (${failed.join('; ')}); its column of Form AOC-1 stays as signed` });
    else if (!balance.balanced) alerts.push({ level: 'warn', code: 'SUBSIDIARY_NOT_BALANCED', message: `The trial balance of ${sub.name} does not balance; its figures are shown but not relied on` });
  }
  return { schema: SUBSIDIARIES_SCHEMA, to, subs };
}

/* ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ */
/* CHECK                                                                                                                                                                            */
/* ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ */

const NOT_IN_SNAPSHOT = "The subsidiaries' own books are not in this snapshot (an older copy): refresh the data";

/**
 * @param {{snapshot:object, spec:object, rows:any[][]}} p   rows = the cells of the sheet AOC-1
 * @returns {{checks:object[], marks:Object<string,object>, groups:object[], stays:string[], info:string[], problems:string[], summary:{lines,ok,expl,diff,none}, panel:object}}
 */
export function buildSubsidiaryChecks({ snapshot, spec, rows }) {
  const tol = spec.tolerance ?? SUBSIDIARY_TOLERANCE;
  const problems = [];
  const info = [];
  const checks = [];
  const marks = {};
  const sec = snapshot.subsidiaries;

  // the rows of the form, by their words in column 1; the column of each subsidiary, confirmed by its name in the heading
  const rowOf = (label) => rows.findIndex((r) => clean(r[1]).startsWith(clean(label)));
  const head = rowOf('Name of the Subsidiary');
  const figures = (spec.figures ?? []).map((f) => ({ ...f, r: rowOf(f.label) }));
  for (const f of figures) if (f.r < 0) problems.push(`AOC-1: the row "${f.label}" was not found on the sheet: its figures are not checked`);

  const groups = [];
  for (const [key, sub] of Object.entries(spec.subs ?? {})) {
    const group = { id: key, title: sub.name, checks: [] };
    groups.push(group);
    if (head < 0 || !clean(rows[head]?.[sub.col]).startsWith(clean(sub.name))) {
      problems.push(`AOC-1: column ${sub.col} is "${rows[head]?.[sub.col] ?? ''}", the configuration expects "${sub.name}": its checks are not made`);
      continue;
    }
    const read = sec?.subs?.[key];
    const mine = [];
    for (const f of figures) {
      if (f.r < 0) continue;
      const signed = rows[f.r][sub.col];
      if (!isNum(signed)) continue;
      const base = { id: `${key}-${f.id}`, group: key, title: f.title ?? f.label, note: null };
      const layer = read?.[f.layer];
      const why = !sec ? NOT_IN_SNAPSHOT : !read ? `${sub.name} is not in this snapshot` : read.balance?.balanced === false ? `The trial balance of ${sub.name} does not balance in Zoho, so its figures are not relied on` : layer?.error ? `Zoho did not give the ${f.layer === 'balance' ? 'trial balance' : 'profit and loss account'} of ${sub.name} (${layer.error})` : !isNum(layer?.[f.field]) ? 'Zoho gives no figure for it' : null;
      const cells = [{ r: f.r, c: sub.col }];
      if (why) { checks.push({ ...base, signed: r2(signed), zoho: null, diff: null, status: 'NONE', why, cells, terms: [] }); group.checks.push(checks.at(-1)); continue; }
      const zoho = layer[f.field];
      const diff = zoho - signed;
      const c = { ...base, signed: r2(signed), zoho: r2(zoho), diff: r2(diff), status: Math.abs(diff) <= tol ? 'OK' : 'DIFF', text: null, cells, terms: [] };
      checks.push(c);
      group.checks.push(c);
      mine.push({ f, c });
    }
    // total assets and total liabilities that differ by the SAME amount: capital, reserves and profit agree, so it is how balances are grouped, not a difference in the books
    const a = mine.find((x) => x.f.id === 'assets')?.c;
    const l = mine.find((x) => x.f.id === 'liabilities')?.c;
    if (a && l && a.status === 'DIFF' && l.status === 'DIFF' && Math.abs(a.diff - l.diff) <= SAME_BOTH_SIDES) {
      const agree = mine.filter((x) => ['capital', 'reserves'].includes(x.f.id)).every((x) => x.c.status === 'OK');
      if (agree) {
        const text = `Zoho's total assets and total liabilities are both ₹${inr(Math.abs((a.diff + l.diff) / 2))} ${a.diff > 0 ? 'higher' : 'lower'} than the signed ones - the same amount on both sides - while the share capital and the reserves agree. The two sides differ equally, so the difference is in how some balances are grouped or set against each other, not in what the company is worth or earned. Zoho's books do not say which balances.`;
        for (const c of [a, l]) { c.status = 'EXPL'; c.text = text; }
      }
    }
  }

  for (const c of checks) {
    if (c.status === 'NONE') continue;
    for (const { r, c: col } of c.cells) marks[`${r}:${col}`] = { status: c.status, check: c.id, signed: c.signed, own: c.signed, zoho: c.zoho, diff: c.diff, together: false, first: true };
  }
  if (sec) {
    const gone = Object.values(sec.subs ?? {}).filter((s) => s.balance?.error && s.profit?.error);
    if (gone.length) info.push(`${names(gone.map((s) => s.name))}: Zoho did not give the books (${gone[0].balance.error}). A subsidiary can be read only when the Zoho login of this dashboard is a user of its organisation and that user is active; until then ${gone.length === 1 ? 'its column stays' : 'their columns stay'} as signed.`);
    const odd = Object.values(sec.subs ?? {}).filter((s) => s.balance && !s.balance.error && s.balance.balanced === false);
    if (odd.length) info.push(`The trial balance of ${names(odd.map((s) => s.name))} does not balance in Zoho, so ${odd.length === 1 ? 'its figures are' : 'their figures are'} not relied on.`);
  }

  const count = (s) => checks.filter((c) => c.status === s).length;
  const summary = { lines: checks.length, ok: count('OK'), expl: count('EXPL'), diff: count('DIFF'), none: count('NONE') };
  return {
    checks, marks, groups: groups.filter((g) => g.checks.length), problems, info,
    stays: (spec.stays ?? []).map((s) => s.text ?? s),
    summary, items: {},
    panel: {
      title: "The subsidiaries' own books in Zoho against Form AOC-1",
      of: 'this form',
      foot: "Each figure is read from the subsidiary's own organisation in Zoho Books: the trial balance (share capital, reserves, total assets and liabilities) and the profit and loss account (turnover, loss before tax, tax, loss after tax), from the day it began to 31 March 2026. A figure agrees within ₹10. Where Zoho gives another amount that is information, not an error: the books are closed and audited, so the sheet is not changed.",
    },
  };
}
