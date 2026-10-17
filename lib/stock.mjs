// Closing Stock, rebuilt from Zoho Books' "Inventory Valuation Summary" (pure functions: the report pages and the Trial Balance buckets are handed in).
//
// What the report is. Zoho's stock summary: one line per item and SKU with the stock on hand and its value (`asset_value`) at the end of the date asked for, and the
// ledger account the item is booked to (`inventory_account`: Inventory Asset, Inventories - Project Material GM, NPD Panchu Purchase ...).
//
// Checked on the real connection (probe of 17-Oct-2026, scripts/probe-stock.mjs, 31-Mar-2026):
//   * the report answers to `/reports/inventoryvaluation` with the usual date filter; 819 item lines on 5 pages of 200; the answer states `as_of_date` / `to_date`
//     and carries the totals of the whole report in `page_context.sum_columns` (quantity 11,96,037.148; value 28,64,63,270.57) and the number of lines in `page_context.total`;
//   * against the signed Closing Stock sheet: all 246 stocked lines agree one for one (name, quantity, value), the totals agree to the paisa, no negative stock;
//   * an item name can stand on several lines - an old SKU (stock 0) and the "_New" SKU, or the same name in two ledger accounts - and so it does on the signed sheet;
//   * the lines per ledger account: Inventories - Project Material GM and NPD Panchu Purchase agree exactly with the Trial Balance. Inventory Asset does not: its ledger
//     balance is 9,14,700.60 higher than its items. Its ledger (6,504 entries to 31-Mar-2026, read on 17-Oct-2026) holds NO manual journal: every line is a bill, invoice, credit note,
//     vendor credit, stock adjustment or stock transfer. Six transfers between the locations (Head Office, Panchu, Gajner) are posted with an "out" value that differs from the "in" value
//     and add 9,58,533.60 to the ledger; the other -43,833.00 fits two stock adjustments (18-Mar and 31-Mar-2026, Panchu) to the paisa (a fit, not proven). The signed sheet shows the gap at its foot as "Difference".
//
// update-19: the unit of each line comes from Zoho's item list (`GET /items`, active and inactive): the report leaves it blank on 816 of its 819 lines, the item list has it for every item,
// and the stock lines are matched to it by SKU (all 819 SKUs of the report are different; a SKU shared by two items with different units is left out, not guessed).
//
// The snapshot keeps only the lines that hold stock or value (246 of the 819), as { name, sku, unit, account, qty, value }, and the table by ledger account.

import { num, r2, inr } from './util.mjs';

/** A rupee: the Trial Balance and the report are both given to the paisa. */
export const STOCK_TOLERANCE = 1;

const normKey = (s) => String(s ?? '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');

/** Every object of the answer that is a stock line: it has an item name and a quantity or a value (the nesting of the answer does not matter). */
function itemsOf(root) {
  const found = [];
  const walk = (x) => {
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (!x || typeof x !== 'object') return;
    if (typeof x.item_name === 'string' && ('asset_value' in x || 'quantity_available' in x)) { found.push(x); return; }
    for (const [k, v] of Object.entries(x)) if (k !== 'page_context') walk(v);
  };
  walk(root);
  return found;
}

const skuKey = (s) => String(s ?? '').trim().toLowerCase();

const lineOf = (x) => ({
  name: String(x.item_name).trim(),
  sku: x.sku ?? x.item?.sku ?? null,
  unit: x.item_unit ?? x.item?.unit ?? x.unit ?? null,
  account: x.inventory_account ?? x.inventory_account_name ?? null,
  qty: num(x.quantity_available ?? x.stock_on_hand),
  value: num(x.asset_value),
});

/**
 * update-19: the pages of Zoho's item list -> { bySku: Map(sku -> unit), items, withUnit, ambiguous } (`items` = items read, `withUnit` = SKUs with a unit,
 * `ambiguous` = SKUs that two items share with different units: their unit is not used). Throws when the answer holds no item.
 */
export function itemUnitsOf(pages) {
  const bySku = new Map();
  const clash = new Set();
  let items = 0;
  for (const raw of pages ?? []) {
    for (const x of (raw?.data ?? raw)?.items ?? []) {
      items += 1;
      const sku = skuKey(x.sku);
      const unit = String(x.unit ?? '').trim();
      if (!sku || !unit) continue;
      const have = bySku.get(sku);
      if (have !== undefined && have !== unit) clash.add(sku);
      else bySku.set(sku, unit);
    }
  }
  if (items === 0) throw new Error('the item list has no items');
  for (const k of clash) bySku.delete(k);
  return { bySku, items, withUnit: bySku.size, ambiguous: clash.size };
}

/**
 * The pages of the report -> { asOf, reportTotal, reportQty, reportLines, lines[] } (every line of the report, also the ones with no stock).
 * `reportTotal` / `reportQty` / `reportLines` are what Zoho says the whole report adds up to (null when the answer does not say).
 */
export function normalizeInventoryValuation(pages) {
  const first = pages?.[0];
  if (!first) throw new Error('The inventory valuation answer is empty');
  const lines = [];
  for (const raw of pages) lines.push(...itemsOf(raw?.data ?? raw).map(lineOf));
  const pc = (first.data ?? first).page_context ?? {};
  const sum = pc.sum_columns ?? {};
  const given = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    asOf: pc.as_of_date ?? pc.to_date ?? null,
    reportTotal: given(sum.asset_value),
    reportQty: given(sum.quantity_available),
    reportLines: given(pc.total),
    inventoryJobRunning: pc.is_inv_txn_job_in_progress === true,
    lines,
  };
}

/**
 * The `stock` section of the snapshot.
 * @param {{asOf:string|null, reportTotal:number|null, reportLines:number|null, lines:object[]}} norm  normalizeInventoryValuation()
 * @param {Record<string,{accounts:object[]}>} buckets  the buckets of the statements; the stock accounts of the Trial Balance are the group `inventory`
 * @param {object[]} [alerts]
 * @param {{bySku:Map<string,string>}|null} [units]  update-19: itemUnitsOf(), the unit of each item by SKU (null: the item list was not read, the lines carry no unit)
 * @returns {object} { asOf, lines[], count, held, total, qty, byAccount[], tb, gap } or { error } (the Closing Stock tab then stays as signed)
 */
export function buildStock(norm, buckets, alerts = [], units = null) {
  const all = norm.lines;
  if (all.length === 0) return { error: 'the report has no item lines' };
  if (norm.reportLines !== null && norm.reportLines !== all.length) {
    return { error: `the report says it has ${norm.reportLines} item lines but ${all.length} were read (a page is missing)` };
  }
  const total = all.reduce((t, l) => t + l.value, 0);
  const qty = all.reduce((t, l) => t + l.qty, 0);
  if (norm.reportTotal !== null && Math.abs(total - norm.reportTotal) > STOCK_TOLERANCE) {
    return { error: `the lines add up to ${inr(r2(total), 2)} but the report's own total is ${inr(r2(norm.reportTotal), 2)} (a page is missing, or the answer has another shape)` };
  }

  // the lines that hold stock or value (a zero line is a SKU that was used up or never bought: nothing to compare)
  const held = all.filter((l) => Math.abs(l.value) >= 0.005 || Math.abs(l.qty) >= 0.0005);
  // the unit: from the item list by SKU and from nowhere else (the report's own unit is blank on 816 of 819 lines; using it for the other three would compare three rows and call that a check)
  const unitOf = (l) => units?.bySku.get(skuKey(l.sku)) ?? null;
  const lines = held.map((l) => ({ name: l.name, sku: l.sku, unit: unitOf(l), account: l.account, qty: Math.round(l.qty * 1000) / 1000, value: r2(l.value) }));

  // by ledger account: the items against the Trial Balance
  const rows = new Map();
  const row = (name) => {
    const k = normKey(name);
    if (!rows.has(k)) rows.set(k, { name: String(name ?? '(account not given)'), lines: 0, items: 0, qty: 0, tb: null });
    return rows.get(k);
  };
  for (const l of held) { const r = row(l.account); r.lines += 1; r.items += l.value; r.qty += l.qty; }
  const tbAccounts = buckets?.inventory?.accounts ?? [];
  for (const a of tbAccounts) { const r = row(a.name); r.tb = (r.tb ?? 0) + a.closing; }
  const byAccount = [...rows.values()]
    .filter((r) => Math.abs(r.items) >= 0.005 || Math.abs(r.tb ?? 0) >= 0.005)
    .map((r) => ({ name: r.name, lines: r.lines, items: r2(r.items), qty: Math.round(r.qty * 1000) / 1000, tb: r.tb === null ? null : r2(r.tb), gap: r.tb === null ? null : r2(r.tb - r.items) }))
    .sort((a, b) => Math.max(Math.abs(b.items), Math.abs(b.tb ?? 0)) - Math.max(Math.abs(a.items), Math.abs(a.tb ?? 0)));
  const tb = tbAccounts.reduce((t, a) => t + a.closing, 0);
  const gap = tb - total;

  if (Math.abs(gap) > STOCK_TOLERANCE) {
    const off = byAccount.filter((r) => r.gap !== null && Math.abs(r.gap) > STOCK_TOLERANCE);
    const items = byAccount.filter((r) => r.tb === null && Math.abs(r.items) > STOCK_TOLERANCE);
    alerts.push({
      level: 'info', code: 'STOCK_GL_GAP',
      message: `The items in Zoho's stock valuation add up to ${inr(r2(total), 2)} but the stock accounts of the Trial Balance say ${inr(r2(tb), 2)} (${inr(r2(gap), 2)} ${gap > 0 ? 'more' : 'less'})${off.length ? `: ${off.map((r) => `${r.name} ${inr(r.gap, 2)}`).join('; ')}` : ''}${items.length ? `; items booked to accounts outside the stock group: ${items.map((r) => `${r.name} ${inr(r.items, 2)}`).join('; ')}` : ''}`,
    });
  }
  return { asOf: norm.asOf, count: all.length, held: lines.length, total: r2(total), qty: Math.round(qty * 1000) / 1000, tb: r2(tb), gap: r2(gap), byAccount, lines };
}
