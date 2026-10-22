// Builds the financial statements (Schedule III layout, as in the audited FS) from the mapped Trial Balance.
//
// Everything is a formula over buckets (mapping.mjs). Sign convention inside buckets: debit +, credit -.
// `nat(bucket)` returns the "natural" figure: assets/expenses as they are, liabilities/equity/income flipped to positive.
//
// Layer 1 (this file, tied to the audited FS): P&L, equity, borrowings, provisions, fixed assets, inventory,
//   receivables, cash, deposits, GST, tax balances.
// Layer 2 (vendors.mjs, built from the party-account ledger lines): trade payables (with MSME split), advances to suppliers,
//   retention, outstanding expenses. When no ledger lines are supplied (`party` is omitted) these lines fall back to the
//   Trial Balance's own net figure and are flagged PHASE2.

import { mapAccounts } from './mapping.mjs';
import { computeReceivables } from './receivables.mjs';
import { computeSuppliers, partyAccounts } from './vendors.mjs';
import { r2 } from './util.mjs';

export const TOLERANCE = 5; // rupees. Audited figures are rounded line by line, so up to a few rupees of drift is normal.

/**
 * @param {{tb:{meta,accounts}, mapping:object, inputs:object, aging:object, overrides:object|null,
 *          party?:{gl:{rows:object[]}, rules:object, overrides:object|null, staffGroup:Set<string>|null, extraNames?:Map}}} p
 *   `party` = ledger lines of the party accounts plus the rules for classifying them (see vendors.mjs). Optional.
 */
export function computeFS({ tb, mapping, inputs, aging, overrides, party }) {
  const { buckets: bk, alerts: mapAlerts, mappedCount } = mapAccounts(tb.accounts, mapping);
  const alerts = [...mapAlerts];
  const inp = (k) => {
    const v = inputs?.inputs?.[k]?.value;
    if (v === undefined) throw new Error(`Missing manual input "${k}"`);
    return v;
  };

  const raw = (b) => bk[b].sum; // debit +
  const nat = (b) => (['asset', 'expense'].includes(mapping.buckets[b].nature) ? bk[b].sum : -bk[b].sum);

  // ---------- receivables (with hand-netting) ----------
  const rec = computeReceivables(aging, overrides);
  alerts.push(...rec.alerts);
  const arControlNet = raw('ar_control') + raw('advance_from_customers'); // debit +  (receivables net of advances)
  const advanceFromCustomers = rec.receivableTotal - arControlNet;
  if (Math.abs(aging.total - raw('ar_control')) > 1) {
    alerts.push({ level: 'error', code: 'AR_AGING_VS_TB', message: `AR aging total (${r2(aging.total)}) does not equal receivable control accounts in the Trial Balance (${r2(raw('ar_control'))})` });
  }

  // ---------- P&L ----------
  const currentMaturities = inp('car_loan_current_maturities');
  const finesToEarlierTax = inp('fines_debit_to_earlier_year_tax');

  // update-31: the opening stock is the Trial Balance's opening balance of the stock accounts, unless the year gives the auditors' figure as the input `opening_stock`
  // (31-Mar-2025: the stock accounts opened with nothing in Zoho, the opening stock of 2024-25 was brought in during the year).
  const openingStock = inputs?.inputs?.opening_stock?.value ?? bk.inventory.opening;
  const closingStock = raw('inventory');
  const netMaterialCost = raw('materials_cost') + raw('freight_inward') + raw('cha_logistics');
  const inventoryChange = openingStock - closingStock; // negative when stock builds up
  const purchases = netMaterialCost - inventoryChange;

  const revenue = nat('revenue');
  const otherIncome = nat('other_income') - raw('fx_net'); // net FX gain is shown as income
  const totalIncome = revenue + otherIncome;
  const operatingExpenses = raw('project_expenses') + raw('stores_consumption');
  const employee = raw('employee_cost');
  const finance = raw('finance_cost');
  const depAmort = raw('dep_amort');
  const otherExpenses = raw('other_expenses') + raw('fines_penalties') - finesToEarlierTax;
  const totalExpenses = purchases + inventoryChange + operatingExpenses + employee + finance + depAmort + otherExpenses;
  const pbt = totalIncome - totalExpenses;
  const currentTax = -raw('tax_current');
  const deferredTax = -raw('tax_deferred');
  const earlierYearTax = -(raw('tax_earlier') + finesToEarlierTax);
  const pat = pbt + currentTax + deferredTax + earlierYearTax;

  // ---------- equity and borrowings ----------
  const shareCapital = nat('share_capital');
  const reservesSurplus = nat('securities_premium') + nat('retained_earnings') + pat;
  const equityTotal = shareCapital + reservesSurplus;

  const od = raw('od_accounts'); // debit = cash, credit = borrowing
  const borrowingsGross = nat('car_loans') + nat('other_borrowings');
  const ltBorrowings = borrowingsGross - currentMaturities;
  const stBorrowings = nat('cash_credit') + currentMaturities + Math.max(0, -od);
  const ltProvisions = nat('employee_provisions');

  const dtn = raw('deferred_tax_net');
  const dta = Math.max(0, dtn);
  const dtl = Math.max(0, -dtn);

  // income-tax provision is shown net of advance tax and TDS/TCS
  const taxNet = nat('income_tax_provision') - raw('advance_tax') - raw('tds_tcs_receivable');
  const stProvisions = Math.max(0, taxNet);
  const taxRecoverable = Math.max(0, -taxNet); // advance tax exceeds provision -> becomes an asset

  // ---------- assets ----------
  const fdNonCurrent = inp('fd_noncurrent');
  const secDepNonCurrent = inp('security_deposit_noncurrent');
  const otherNcAssets = fdNonCurrent + secDepNonCurrent;
  const cash = raw('cash_bank') + Math.max(0, od);
  const revenueAuthorities = raw('gst_balances') + taxRecoverable;
  const otherCurrentAssets =
    raw('fixed_deposits') + raw('accrued_interest_fdr') - fdNonCurrent +
    raw('security_deposits_given') - secDepNonCurrent +
    raw('unbilled_revenue') + raw('other_receivables');

  // ---------- Layer 2: party-level group (net presentation) ----------
  // Audited: advance to suppliers & others - trade payables - retention - outstanding expenses
  // Trial Balance: supplier control accounts (net) + loans given + staff advances - retention - outstanding expenses
  const vendorNetDebit = raw('vendor_advances') + raw('vendor_payables');
  const partyNetTB =
    vendorNetDebit + raw('loans_advances_given') + raw('staff_advances') -
    nat('retention_payable') - nat('outstanding_expenses') - nat('rounding_suspense');

  let sup = null;
  if (party) {
    sup = computeSuppliers({ ...party, accounts: partyAccounts(bk), asOf: tb.meta.to });
    alerts.push(...sup.alerts);
  }
  const retentionTotal = nat('retention_payable') + (sup ? sup.totals.retention : 0);
  const outstandingTotal = nat('outstanding_expenses') + nat('rounding_suspense') + (sup ? sup.totals.outstanding + sup.totals.imprest : 0);
  const partyNet = sup ? sup.totals.advance - sup.totals.tradePayables - retentionTotal - outstandingTotal : partyNetTB;

  // ---------- assemble lines ----------
  const L = {};
  const add = (key, section, label, value, extra = {}) => { L[key] = { key, section, label, value, ...extra }; };

  add('revenue', 'pl', 'Revenue from operations', revenue);
  add('other_income', 'pl', 'Other income', otherIncome);
  add('total_income', 'pl', 'Total income', totalIncome);
  add('purchases', 'pl', 'Purchase of stock-in-trade', purchases);
  add('inventory_change', 'pl', 'Changes in inventories', inventoryChange);
  add('operating_expenses', 'pl', 'Operating expenses', operatingExpenses);
  add('employee', 'pl', 'Employee benefits expense', employee);
  add('finance', 'pl', 'Finance cost', finance);
  add('dep_amort', 'pl', 'Depreciation and amortisation', depAmort);
  add('other_expenses', 'pl', 'Other expenses', otherExpenses);
  add('total_expenses', 'pl', 'Total expenses', totalExpenses);
  add('pbt', 'pl', 'Profit before tax', pbt);
  add('current_tax', 'pl', 'Current tax', currentTax);
  add('deferred_tax', 'pl', 'Deferred tax', deferredTax);
  add('earlier_year_tax', 'pl', 'Income tax of earlier year', earlierYearTax);
  add('pat', 'pl', 'Profit after tax', pat);

  add('share_capital', 'bs', 'Share capital', shareCapital);
  add('reserves_surplus', 'bs', 'Reserves and surplus', reservesSurplus);
  add('equity_total', 'bs', "Total shareholders' funds", equityTotal);
  add('lt_borrowings', 'bs', 'Long-term borrowings', ltBorrowings);
  add('dtl', 'bs', 'Deferred tax liabilities (net)', dtl);
  add('lt_provisions', 'bs', 'Long-term provisions', ltProvisions);
  add('st_borrowings', 'bs', 'Short-term borrowings', stBorrowings);
  add('ocl_advance_customers', 'bs', 'Other current liabilities: advance from customers', advanceFromCustomers);
  add('ocl_statutory', 'bs', 'Other current liabilities: statutory liabilities', nat('statutory_dues'));
  add('ocl_security_deposits', 'bs', 'Other current liabilities: security deposits taken', nat('security_deposits_taken'));
  add('ocl_unearned', 'bs', 'Other current liabilities: unearned revenue', nat('unearned_revenue'));
  add('st_provisions', 'bs', 'Short-term provisions', stProvisions);

  add('ppe', 'bs', 'Property, plant and equipment', raw('ppe_net'));
  add('intangibles', 'bs', 'Intangible assets', raw('intangibles_net'));
  add('cwip', 'bs', 'Capital work-in-progress', raw('cwip'));
  add('iaud', 'bs', 'Intangible assets under development', raw('iaud'));
  add('nc_investments', 'bs', 'Non-current investments', raw('investments_nc'));
  add('dta', 'bs', 'Deferred tax assets (net)', dta);
  add('other_nc_assets', 'bs', 'Other non-current assets', otherNcAssets);
  add('inventories', 'bs', 'Inventories', closingStock);
  add('trade_receivables', 'bs', 'Trade receivables', rec.receivableTotal);
  add('cash', 'bs', 'Cash and cash equivalents', cash);
  add('sla_prepaid', 'bs', 'Short-term loans and advances: prepaid expenses', raw('prepaid'));
  add('sla_revenue_authorities', 'bs', 'Short-term loans and advances: balances with revenue authorities', revenueAuthorities);
  add('other_current_assets', 'bs', 'Other current assets', otherCurrentAssets);

  // Layer 2 lines
  if (sup) {
    add('tp_msme', 'party', 'Trade payables - MSME', sup.totals.tpMsme);
    add('tp_others', 'party', 'Trade payables - others', sup.totals.tpOthers);
    add('sla_advance_suppliers_others', 'party', 'Short-term loans and advances: advance to suppliers and others', sup.totals.advance);
    add('ocl_retention', 'party', 'Other current liabilities: retention money payable', retentionTotal);
    add('ocl_outstanding_expenses', 'party', 'Other current liabilities: outstanding expenses', outstandingTotal);
  } else {
    // no ledger lines: Trial Balance gross figure shown, flagged PHASE2
    add('ocl_retention', 'party', 'Retention money payable (TB figure, before party-level grossing-up)', nat('retention_payable'), { phase2: true });
    add('ocl_outstanding_expenses', 'party', 'Outstanding expenses (TB figure, before party-level grossing-up)', nat('outstanding_expenses') + nat('rounding_suspense'), { phase2: true });
    add('vendor_net_debit', 'party', 'Supplier accounts, net (advances less payables)', vendorNetDebit, { phase2: true });
  }
  add('party_net', 'party', 'Party-level group, net: advances to suppliers & others - trade payables - retention - outstanding expenses', partyNet);

  // ---------- grand checks ----------
  const checks = [];
  const tbSum = tb.accounts.reduce((s, a) => s + a.closing, 0);
  checks.push({ key: 'tb_balances', label: 'Trial Balance debits = credits', value: tbSum, expected: 0, ok: Math.abs(tbSum) <= 1 });
  // Balance-sheet identity: every bucket must feed some line. If a formula edit ever drops a bucket, this fails.
  const assetsLayer1 = raw('ppe_net') + raw('intangibles_net') + raw('cwip') + raw('iaud') + dta + raw('investments_nc') + otherNcAssets +
    closingStock + rec.receivableTotal + cash + raw('prepaid') + revenueAuthorities + otherCurrentAssets;
  const liabilitiesLayer1 = equityTotal + ltBorrowings + dtl + ltProvisions + stBorrowings + advanceFromCustomers +
    nat('statutory_dues') + nat('security_deposits_taken') + nat('unearned_revenue') + stProvisions;
  const identityGap = assetsLayer1 + partyNetTB - liabilitiesLayer1;
  checks.push({ key: 'bs_identity', label: 'Balance-sheet identity: assets (incl. party-level net) = equity + liabilities', value: identityGap, expected: 0, ok: Math.abs(identityGap) <= 0.01 });
  if (sup) {
    checks.push(...sup.checks);
    // the party lines built from the ledger must equal what the Trial Balance alone says
    const gap = partyNet - partyNetTB;
    checks.push({ key: 'party_vs_tb_net', label: 'Party-level group built from ledger lines = Trial Balance net', value: gap, expected: 0, ok: Math.abs(gap) <= 1 });
  }
  const bucketSum = Object.values(bk).reduce((s, b) => s + b.sum, 0);
  checks.push({ key: 'all_mapped', label: 'Every account with a balance is mapped (buckets add to zero)', value: bucketSum, expected: 0, ok: Math.abs(bucketSum) <= 1 && !alerts.some((a) => a.code === 'UNMAPPED_ACCOUNT') });

  return {
    lines: L,
    buckets: Object.fromEntries(Object.entries(bk).map(([k, v]) => [k, { sum: v.sum, opening: v.opening, accounts: v.accounts }])),
    receivables: { total: rec.receivableTotal, advanceFromCustomers, controlNet: arControlNet, overridesApplied: rec.overridesApplied, customers: rec.customers },
    memo: { openingStock, closingStock, netMaterialCost, borrowingsGross, taxNet, mappedAccounts: mappedCount },
    suppliers: sup ? { totals: sup.totals, parties: sup.parties, overridesApplied: sup.overridesApplied } : null,
    checks,
    alerts,
  };
}
