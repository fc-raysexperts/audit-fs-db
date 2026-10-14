// Trade receivables, with the auditors' hand-netting reproduced from a fixed override list (option 1).
//
// Why this exists: in Zoho, a customer who has paid an advance AND has an open invoice appears as TWO
// separate balances. The auditors netted some of them by hand, so audited "Trade receivables" is lower than
// the gross Zoho receivable, and "Advance from customers" is lower by the same amount.
//
//   receivable_i = max(0, zb_total_i + adjustment_i)      (adjustment_i comes from overrides.fyXX.json)
//   Advance from customers = SUM(receivable_i) - (receivable control accounts - advance control account)
//
// This identity guarantees receivables - advances always equals the Trial Balance's own net figure.

import { num, r2 } from './util.mjs';

export function normalizeARAging(raw) {
  const root = raw?.data ?? raw;
  const list = root?.invoice?.group_list?.[0]?.group_list;
  if (!Array.isArray(list)) throw new Error('AR aging response has an unexpected shape (no invoice.group_list[0].group_list)');
  const contacts = list.map((c) => ({ id: String(c.id), name: (c.name ?? '').trim(), total: num(c.total) }));
  const pc = root.page_context ?? {};
  return {
    meta: { asOf: pc.as_of_date ?? pc.to_date ?? null, hasMore: pc.has_more_page === true },
    contacts,
    total: contacts.reduce((s, c) => s + c.total, 0),
  };
}

/**
 * @param {{contacts:{id,name,total}[], meta:{asOf}}} aging
 * @param {{as_of:string, entries:Record<string,{name,zb_total,adjustment,audited}>}|null} overrides
 */
export function computeReceivables(aging, overrides) {
  const alerts = [];
  const useOverrides = overrides && aging.meta.asOf === overrides.as_of;
  if (overrides && !useOverrides) {
    alerts.push({
      level: 'info', code: 'OVERRIDES_SKIPPED',
      message: `Hand-netting list is for ${overrides.as_of} only; this report is as of ${aging.meta.asOf}, so plain Zoho balances are used`,
    });
  }
  const entries = useOverrides ? overrides.entries : {};
  const seen = new Set();
  const customers = aging.contacts.map((c) => {
    const o = entries[c.id];
    if (o) seen.add(c.id);
    const adjustment = o ? o.adjustment : 0;
    if (o && Math.abs(o.zb_total - c.total) > 1) {
      alerts.push({
        level: 'warn', code: 'OVERRIDE_STALE',
        message: `${c.name}: Zoho balance is now ${r2(c.total)} but the netting list was made at ${r2(o.zb_total)} - check this customer`,
      });
    }
    return { id: c.id, name: c.name, zb_total: c.total, adjustment, receivable: Math.max(0, c.total + adjustment) };
  });
  for (const id of Object.keys(entries)) {
    if (!seen.has(id)) {
      alerts.push({ level: 'warn', code: 'OVERRIDE_CUSTOMER_MISSING', message: `Netting-list customer "${entries[id].name}" no longer appears in the Zoho aging report` });
    }
  }
  const receivableTotal = customers.reduce((s, c) => s + c.receivable, 0);
  return { receivableTotal, customers, overridesApplied: !!useOverrides, alerts };
}
