// Turns a snapshot (lib/snapshot.mjs) into what the screens show: the Balance Sheet and Profit & Loss laid out as in the audited
// statements (Schedule III order), with subtotals, last year's audited figures and the tie-out to the audited FY figures.
// Pure functions - no file system, no network - so the layout can be tested against the real FY26 numbers.

import { previousFy } from './format.mjs';

/** Subtotals are sums of lines the audited workbook rounds one by one, so they may drift a few rupees more than a single line (5). */
export const TOTAL_TOLERANCE = 10;

const leaf = (key, label) => ({ key, label });
const group = (key, label, items, auditedKey = null) => ({ key, label, items, auditedKey });

export const BS_LAYOUT = {
  liabilities: {
    title: 'Equity and liabilities',
    parts: [
      { heading: "Shareholders' funds", total: ['equity_total', "Total shareholders' funds"],
        items: [leaf('share_capital', 'Share capital'), leaf('reserves_surplus', 'Reserves and surplus')] },
      { heading: 'Non-current liabilities', total: ['noncurrent_liabilities_total', 'Total non-current liabilities'],
        items: [leaf('lt_borrowings', 'Long-term borrowings'), leaf('dtl', 'Deferred tax liabilities (net)'), leaf('lt_provisions', 'Long-term provisions')] },
      { heading: 'Current liabilities', total: ['current_liabilities_total', 'Total current liabilities'],
        items: [
          leaf('st_borrowings', 'Short-term borrowings'),
          group('trade_payables', 'Trade payables', [leaf('tp_msme', 'Micro and small enterprises'), leaf('tp_others', 'Others')]),
          group('other_current_liabilities', 'Other current liabilities', [
            leaf('ocl_advance_customers', 'Advance from customers'), leaf('ocl_statutory', 'Statutory liabilities'),
            leaf('ocl_security_deposits', 'Security deposits taken'), leaf('ocl_unearned', 'Unearned revenue'),
            leaf('ocl_retention', 'Retention money payable'), leaf('ocl_outstanding_expenses', 'Outstanding expenses'),
          ], 'other_current_liabilities'),
          leaf('st_provisions', 'Short-term provisions'),
        ] },
    ],
    total: ['total_equity_liabilities', 'Total equity and liabilities'],
  },
  assets: {
    title: 'Assets',
    parts: [
      { heading: 'Non-current assets', total: ['noncurrent_assets_total', 'Total non-current assets'],
        items: [
          leaf('ppe', 'Property, plant and equipment'), leaf('intangibles', 'Intangible assets'), leaf('cwip', 'Capital work-in-progress'),
          leaf('iaud', 'Intangible assets under development'), leaf('nc_investments', 'Non-current investments'),
          leaf('dta', 'Deferred tax assets (net)'), leaf('other_nc_assets', 'Other non-current assets'),
        ] },
      { heading: 'Current assets', total: ['current_assets_total', 'Total current assets'],
        items: [
          leaf('inventories', 'Inventories'), leaf('trade_receivables', 'Trade receivables'), leaf('cash', 'Cash and cash equivalents'),
          group('st_loans_advances', 'Short-term loans and advances', [
            leaf('sla_prepaid', 'Prepaid expenses'), leaf('sla_revenue_authorities', 'Balances with revenue authorities'),
            leaf('sla_advance_suppliers_others', 'Advance to suppliers and others'),
          ], 'st_loans_advances'),
          leaf('other_current_assets', 'Other current assets'),
        ] },
    ],
    total: ['total_assets', 'Total assets'],
  },
};

export const PL_LAYOUT = [
  { kind: 'line', key: 'revenue', label: 'Revenue from operations' },
  { kind: 'line', key: 'other_income', label: 'Other income' },
  { kind: 'total', key: 'total_income', label: 'Total income' },
  { kind: 'heading', label: 'Expenses' },
  { kind: 'line', key: 'purchases', label: 'Purchase of stock-in-trade' },
  { kind: 'line', key: 'inventory_change', label: 'Changes in inventories' },
  { kind: 'line', key: 'operating_expenses', label: 'Operating expenses' },
  { kind: 'line', key: 'employee', label: 'Employee benefits expense' },
  { kind: 'line', key: 'finance', label: 'Finance cost' },
  { kind: 'line', key: 'dep_amort', label: 'Depreciation and amortisation' },
  { kind: 'line', key: 'other_expenses', label: 'Other expenses' },
  { kind: 'total', key: 'total_expenses', label: 'Total expenses' },
  { kind: 'total', key: 'pbt', label: 'Profit before tax' },
  { kind: 'heading', label: 'Tax' },
  { kind: 'line', key: 'current_tax', label: 'Current tax' },
  { kind: 'line', key: 'deferred_tax', label: 'Deferred tax' },
  { kind: 'line', key: 'earlier_year_tax', label: 'Income tax of earlier year' },
  { kind: 'total', key: 'pat', label: 'Profit after tax' },
];

const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
const sum = (rows, f) => rows.reduce((s, r) => s + num(f(r)), 0);
const allKnown = (xs) => xs.every((x) => typeof x === 'number');

/**
 * @param {object} snapshot  from buildSnapshot()
 * @param {object|null} audited  config/audited.fyYY.json (last year's audited figures and the audited totals), if any
 */
export function buildView(snapshot, audited = null) {
  const lines = snapshot.statements.lines;
  const recRows = new Map((snapshot.reconciliation?.rows ?? []).map((r) => [r.key, r]));
  const aud = (sec, key) => audited?.[sec]?.[key];
  const hasTie = Boolean(snapshot.reconciliation);
  const tolerance = snapshot.reconciliation?.tolerance ?? 5;

  const tie = (live, audVal, tol) => {
    if (!hasTie || audVal === undefined || audVal === null) return { audited: null, diff: null, status: null };
    const diff = live - audVal;
    return { audited: audVal, diff, status: Math.abs(diff) <= tol ? 'OK' : 'CHECK' };
  };

  // a line that comes straight from the engine
  function leafRow(def, section, level) {
    const line = lines[def.key];
    const value = num(line?.value);
    const r = recRows.get(def.key);
    const prevFromAudited = aud(section, def.key)?.fy25;
    return {
      id: def.key, kind: level > 1 ? 'sub' : 'line', level, label: def.label, value,
      prev: typeof prevFromAudited === 'number' ? prevFromAudited : null,
      audited: r?.audited ?? null, diff: r?.diff ?? null, status: r?.status === 'NOREF' ? null : (r?.status ?? null),
      missing: !line,
    };
  }

  function groupRows(def, section) {
    const kids = def.items.map((k) => leafRow(k, section, 2));
    const value = sum(kids, (r) => r.value);
    const prevAud = def.auditedKey ? aud(section, def.auditedKey) : null;
    const prev = prevAud?.fy25 ?? (allKnown(kids.map((k) => k.prev)) ? sum(kids, (k) => k.prev) : null);
    const audTotal = prevAud?.value ?? (allKnown(kids.map((k) => k.audited)) ? sum(kids, (k) => k.audited) : null);
    const head = { id: def.key, kind: 'group', level: 1, label: def.label, value, prev, ...tie(value, audTotal, TOTAL_TOLERANCE), missing: false };
    return [head, ...kids];
  }

  const totalRow = (key, label, value, kind = 'total') => {
    const a = aud('bs', key);
    return { id: key, kind, level: 0, label, value, prev: a?.fy25 ?? null, ...tie(value, a?.value, TOTAL_TOLERANCE), missing: false };
  };

  function side(layout) {
    const rows = [];
    let sideTotal = 0;
    for (const part of layout.parts) {
      rows.push({ id: `h:${part.heading}`, kind: 'heading', level: 0, label: part.heading });
      let partTotal = 0;
      for (const item of part.items) {
        if (item.items) {
          const g = groupRows(item, 'bs');
          rows.push(...g);
          partTotal += g[0].value;
        } else {
          const r = leafRow(item, 'bs', 1);
          rows.push(r);
          partTotal += r.value;
        }
      }
      rows.push(totalRow(part.total[0], part.total[1], partTotal, 'subtotal'));
      sideTotal += partTotal;
    }
    const total = totalRow(layout.total[0], layout.total[1], sideTotal, 'grand');
    rows.push(total);
    return { rows, total };
  }

  const liabilities = side(BS_LAYOUT.liabilities);
  const assets = side(BS_LAYOUT.assets);

  const pl = PL_LAYOUT.map((d) => {
    if (d.kind === 'heading') return { id: `h:${d.label}`, kind: 'heading', level: 0, label: d.label };
    const row = leafRow(d, 'pl', 1);
    return { ...row, kind: d.kind === 'total' ? 'subtotal' : 'line', ...(d.key === 'pbt' || d.key === 'pat' ? { kind: 'grand' } : {}) };
  });

  // ---- the one-glance balance sheet (Overview): section totals and the main lines, both sides ending in the same figure
  const v = (key) => num(lines[key]?.value);
  const rowValue = (rows, id) => rows.find((r) => r.id === id)?.value ?? 0;
  const left = [
    { label: "Shareholders' funds", value: rowValue(liabilities.rows, 'equity_total') },
    { label: 'Non-current liabilities', value: rowValue(liabilities.rows, 'noncurrent_liabilities_total') },
    { label: 'Short-term borrowings', value: v('st_borrowings') },
    { label: 'Trade payables', value: v('tp_msme') + v('tp_others') },
    { label: 'Other current liabilities', value: rowValue(liabilities.rows, 'other_current_liabilities') },
    { label: 'Short-term provisions', value: v('st_provisions') },
  ];
  const right = [
    { label: 'Property, plant and equipment', value: v('ppe') },
    { label: 'Intangible assets, capital work-in-progress and assets under development', value: v('intangibles') + v('cwip') + v('iaud') },
    { label: 'Investments, deferred tax and other non-current assets', value: v('nc_investments') + v('dta') + v('other_nc_assets') },
    { label: 'Inventories', value: v('inventories') },
    { label: 'Trade receivables', value: v('trade_receivables') },
    { label: 'Cash and cash equivalents', value: v('cash') },
    { label: 'Short-term loans and advances', value: rowValue(assets.rows, 'st_loans_advances') },
    { label: 'Other current assets', value: v('other_current_assets') },
  ];

  const plRow = (id) => pl.find((r) => r.id === id);
  const taxNet = v('current_tax') + v('deferred_tax') + v('earlier_year_tax');
  const plSummary = [
    { label: 'Revenue from operations', value: v('revenue'), prev: plRow('revenue')?.prev ?? null },
    { label: 'Total expenses', value: v('total_expenses'), prev: plRow('total_expenses')?.prev ?? null },
    { label: 'Profit before tax', value: v('pbt'), prev: plRow('pbt')?.prev ?? null },
    { label: 'Tax, net', value: taxNet, prev: (() => { const ps = ['current_tax', 'deferred_tax', 'earlier_year_tax'].map((k) => plRow(k)?.prev); return allKnown(ps) ? sum(ps, (x) => x) : null; })() },
    { label: 'Profit after tax', value: v('pat'), prev: plRow('pat')?.prev ?? null },
  ];

  const checks = snapshot.checks ?? [];
  const alerts = snapshot.alerts ?? [];
  const tied = snapshot.meta.reconciled;

  return {
    company: audited?.company ?? 'Rays Power Experts Limited',
    fy: snapshot.meta.fy, asOf: snapshot.meta.asOf, prevFy: previousFy(snapshot.meta.fy),
    hasPrev: Boolean(audited), hasTie,
    bs: {
      liabilities: liabilities.rows, assets: assets.rows,
      totalLiabilities: liabilities.total.value, totalAssets: assets.total.value,
      gap: assets.total.value - liabilities.total.value,
    },
    pl, overview: { left, right, plSummary },
    tie: tied ? { ...tied, tolerance, basis: snapshot.meta.audited?.basis ?? null } : null,
    health: {
      checksTotal: checks.length, checksPassed: checks.filter((c) => c.ok).length, failedChecks: checks.filter((c) => !c.ok),
      errors: alerts.filter((a) => a.level === 'error').length, warnings: alerts.filter((a) => a.level === 'warn').length,
      infos: alerts.filter((a) => a.level === 'info').length,
    },
  };
}
