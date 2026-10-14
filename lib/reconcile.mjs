// Compares each line built from the Trial Balance with the audited figure and says OK / CHECK / PHASE2.

import { TOLERANCE } from './fsEngine.mjs';

// our line key -> where the audited figure lives in audited.fyXX.json  [section, key]  (or a function for composites)
export const AUDITED_REF = {
  revenue: ['pl', 'revenue'], other_income: ['pl', 'other_income'], total_income: ['pl', 'total_income'],
  purchases: ['pl', 'purchases'], inventory_change: ['pl', 'inventory_change'], operating_expenses: ['pl', 'operating_expenses'],
  employee: ['pl', 'employee'], finance: ['pl', 'finance'], dep_amort: ['pl', 'dep_amort'], other_expenses: ['pl', 'other_expenses'],
  total_expenses: ['pl', 'total_expenses'], pbt: ['pl', 'pbt'], current_tax: ['pl', 'current_tax'], deferred_tax: ['pl', 'deferred_tax'],
  earlier_year_tax: ['pl', 'earlier_year_tax'], pat: ['pl', 'pat'],

  share_capital: ['bs', 'share_capital'], reserves_surplus: ['bs', 'reserves_surplus'], equity_total: ['bs', 'equity_total'],
  lt_borrowings: ['bs', 'lt_borrowings'], dtl: ['bs', 'dtl'], lt_provisions: ['bs', 'lt_provisions'], st_borrowings: ['bs', 'st_borrowings'],
  ocl_advance_customers: ['notes', 'ocl_advance_customers'], ocl_statutory: ['notes', 'ocl_statutory'],
  ocl_security_deposits: ['notes', 'ocl_security_deposits'], ocl_unearned: ['notes', 'ocl_unearned'],
  st_provisions: ['bs', 'st_provisions'],

  ppe: ['bs', 'ppe'], intangibles: ['bs', 'intangibles'], cwip: ['bs', 'cwip'], iaud: ['bs', 'iaud'],
  nc_investments: ['bs', 'nc_investments'], dta: ['bs', 'dta'], other_nc_assets: ['bs', 'other_nc_assets'],
  inventories: ['bs', 'inventories'], trade_receivables: ['bs', 'trade_receivables'], cash: ['bs', 'cash'],
  sla_prepaid: ['notes', 'sla_prepaid'], sla_revenue_authorities: ['notes', 'sla_revenue_authorities'],
  other_current_assets: ['bs', 'other_current_assets'],

  ocl_retention: ['notes', 'ocl_retention'], ocl_outstanding_expenses: ['notes', 'ocl_outstanding_expenses'],
  tp_msme: ['bs', 'tp_msme'], tp_others: ['bs', 'tp_others'],
  sla_advance_suppliers_others: ['notes', 'sla_advance_suppliers_others'],
};

const get = (aud, [sec, key]) => aud[sec]?.[key]?.value;

/** Audited value of the party-level group (advances to suppliers & others - payables - retention - outstanding expenses). */
function auditedPartyNet(aud) {
  const n = (k) => aud.notes[k].value;
  const b = (k) => aud.bs[k].value;
  return n('sla_advance_suppliers_others') - b('tp_msme') - b('tp_others') - n('ocl_retention') - n('ocl_outstanding_expenses');
}

export function reconcile(fs, audited, tolerance = TOLERANCE) {
  const rows = [];
  for (const line of Object.values(fs.lines)) {
    let aud;
    if (line.key === 'party_net') aud = auditedPartyNet(audited);
    else if (line.key === 'vendor_net_debit') aud = undefined; // no audited counterpart on its own
    else aud = get(audited, AUDITED_REF[line.key] ?? []);
    if (aud === undefined || aud === null) {
      rows.push({ ...line, audited: null, diff: null, status: 'NOREF' });
      continue;
    }
    const diff = line.value - aud;
    let status;
    if (Math.abs(diff) <= tolerance) status = 'OK';
    else status = line.phase2 ? 'PHASE2' : 'CHECK';
    rows.push({ key: line.key, section: line.section, label: line.label, value: line.value, audited: aud, diff, status });
  }
  const summary = {
    ok: rows.filter((r) => r.status === 'OK').length,
    check: rows.filter((r) => r.status === 'CHECK').length,
    phase2: rows.filter((r) => r.status === 'PHASE2').length,
    noref: rows.filter((r) => r.status === 'NOREF').length,
    maxAbsDiffOk: Math.max(0, ...rows.filter((r) => r.status === 'OK').map((r) => Math.abs(r.diff))),
  };
  return { rows, summary, tolerance };
}
