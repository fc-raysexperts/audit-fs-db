// Note 12: Property, plant and equipment and intangible assets - the fixed-asset schedule, rebuilt live.
//
// Per class the closing gross block and the closing accumulated depreciation are read from the Zoho accounts. The opening
// balances are last year's audited closing balances (fixed). So
//     additions     = closing gross block - opening gross block + assets sold / discarded
//     charge        = closing accumulated depreciation - opening + depreciation written back
// and the totals must agree with the Balance Sheet lines and the depreciation in the profit and loss account.

export const ROW_TOLERANCE = 5;
export const TOTAL_TOLERANCE = 10;

const sum = (xs) => xs.reduce((s, x) => s + x, 0);

/**
 * @param {object} snapshot
 * @param {object} cfg  config/assets.fyYY.json
 */
export function buildAssets(snapshot, cfg) {
  const lines = snapshot.statements.lines;
  const hasTie = Boolean(snapshot.meta.audited);
  const closing = new Map();
  for (const b of Object.values(snapshot.buckets)) for (const a of b.accounts) closing.set(String(a.id), a.closing);
  const bal = (ids) => sum(ids.map((id) => closing.get(id) ?? 0));

  const tie = (live, audited, tol = ROW_TOLERANCE) => {
    if (!hasTie || typeof audited !== 'number') return { audited: null, diff: null, status: null };
    const diff = live - audited;
    return { audited, diff, status: Math.abs(diff) <= tol ? 'OK' : 'CHECK' };
  };

  const classes = cfg.classes.map((c) => {
    const closeGross = bal(c.gross);
    const closeAccdep = -bal(c.accdep); // accumulated depreciation is a credit balance in Zoho
    const additions = closeGross - c.opening.gross + c.opening.disposals;
    const charge = closeAccdep - c.opening.accdep + c.opening.writeback;
    const net = closeGross - closeAccdep;
    return {
      key: c.key, label: c.label, section: c.section,
      openGross: c.opening.gross, additions, disposals: c.opening.disposals, closeGross,
      openAccdep: c.opening.accdep, charge, writeback: c.opening.writeback, closeAccdep,
      net, prevNet: c.prevNet,
      tie: {
        additions: tie(additions, c.audited.additions), closeGross: tie(closeGross, c.audited.closeGross), charge: tie(charge, c.audited.charge),
        closeAccdep: tie(closeAccdep, c.audited.closeAccdep), net: tie(net, c.audited.net),
      },
    };
  });

  const total = (items, key) => {
    const t = { key, label: '', };
    for (const f of ['openGross', 'additions', 'disposals', 'closeGross', 'openAccdep', 'charge', 'writeback', 'closeAccdep', 'net', 'prevNet']) t[f] = sum(items.map((c) => c[f]));
    return t;
  };
  const ppe = { ...total(classes.filter((c) => c.section === 'ppe'), 'ppe'), label: 'Total: property, plant and equipment' };
  const intang = { ...total(classes.filter((c) => c.section === 'intangible'), 'intangible'), label: 'Total: intangible assets' };
  const grand = { ...total(classes, 'grand'), label: 'Grand total' };
  const prevTotal = { key: 'prev', label: 'Previous year total', ...cfg.previousYearTotal };

  // the totals must agree with the statements
  const checks = [];
  const check = (key, label, diff, tol = TOTAL_TOLERANCE) => checks.push({ key, label, value: diff, status: Math.abs(diff) <= tol ? 'OK' : 'CHECK' });
  check('ppe_vs_bs', 'Net block of property, plant and equipment = Balance Sheet line', ppe.net - lines.ppe.value);
  check('intang_vs_bs', 'Net block of intangible assets = Balance Sheet line', intang.net - lines.intangibles.value);
  check('dep_vs_pl', 'Depreciation charge of the year = depreciation in the profit and loss account', grand.charge - lines.dep_amort.value);
  check('open_vs_prev', "Opening net block = last year's audited net block", grand.openGross - grand.openAccdep - grand.prevNet);

  const wip = (key, line, label) => {
    const live = lines[line].value;
    const c = cfg[key];
    return { key, label, value: live, fy25: c.fy25, ...tie(live, c.audited) };
  };
  const cwip = wip('cwip', 'cwip', 'Capital work-in-progress');
  const iaud = wip('iaud', 'iaud', 'Intangible assets under development');

  const ageing = Object.entries(cfg.ageing).map(([k, a]) => {
    const total = k === 'cwip' ? cwip.value : iaud.value;
    const fixedSum = sum(a.rows.filter((r) => r.fixed !== undefined).map((r) => r.fixed));
    const rows = a.rows.map((r) => {
      const value = r.live === 'rest' ? total - fixedSum : r.fixed;
      return { label: r.label, value, fy25: r.fy25, fixed: r.fixed !== undefined, ...tie(value, r.audited) };
    });
    return { key: k, title: a.title, rows, total: { value: sum(rows.map((r) => r.value)), fy25: sum(rows.map((r) => r.fy25)) } };
  });

  const tied = [
    ...classes.flatMap((c) => Object.values(c.tie)), cwip, iaud, ...ageing.flatMap((a) => a.rows),
  ].filter((x) => x.status);
  return {
    fy: snapshot.meta.fy, asOf: snapshot.meta.asOf, hasTie, classes, ppe, intangible: intang, grand, previousYear: prevTotal,
    cwip, iaud, ageing, checks, statements: cfg.statements ?? [],
    summary: { lines: tied.length, ok: tied.filter((x) => x.status === 'OK').length, check: tied.filter((x) => x.status === 'CHECK').length, checksFailed: checks.filter((c) => c.status === 'CHECK').length },
  };
}
