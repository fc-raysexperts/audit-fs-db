// Turns the raw Zoho Books "Trial Balance" report response into a flat, predictable list of accounts.
// Sign convention (same as Zoho): debit = positive, credit = negative.
//
// Raw shape (verified against the live report, FY 2025-26):
//   data.trialbalance[0].account_transactions[group].account_transactions[row]
//   group.name in {Assets, Liabilities, Equities, Income, Expense}
//   row: account_id, name, account_code, opening_balance, debit_total, credit_total, closing_balance, ...
// Income / Expense rows carry no opening_balance: their closing_balance is the movement for the period.

import { num } from './util.mjs';

export function normalizeTB(raw) {
  const root = raw?.data ?? raw;
  const tb = root?.trialbalance?.[0];
  if (!tb || !Array.isArray(tb.account_transactions)) {
    throw new Error('Trial Balance response has an unexpected shape (no trialbalance[0].account_transactions)');
  }
  const pc = root.page_context ?? {};
  const accounts = [];
  let withClosing = 0;
  for (const grp of tb.account_transactions) {
    for (const r of grp.account_transactions ?? []) {
      if ('closing_balance' in r) withClosing++;
      accounts.push({
        id: String(r.account_id),
        code: (r.account_code ?? '').trim(),
        name: (r.name ?? '').trim(),
        group: grp.name,
        accountType: grp.account_type,
        opening: num(r.opening_balance),
        debit: num(r.debit_total),
        credit: num(r.credit_total),
        closing: num(r.closing_balance),
        isRetainedEarnings: r.is_retained_earnings === true,
      });
    }
  }
  if (accounts.length > 0 && withClosing === 0) {
    throw new Error('Trial Balance response has no closing_balance column (the request must name its columns with select_columns) - every amount would read as zero');
  }
  const meta = {
    from: pc.from_date ?? null,
    to: pc.to_date ?? null,
    basis: pc.report_basis ?? null,
    showRows: pc.show_rows ?? null,
    // true while Zoho is still recalculating inventory (FIFO) - figures may still move
    inventoryJobRunning: pc.is_inv_txn_job_in_progress === true,
    fifoStatus: pc.fifo_scheduler_status ?? null,
    generatedAt: pc.last_accessed_time_formatted ?? null,
    reportDebitTotal: num(tb.debit_total),
    reportCreditTotal: num(tb.credit_total),
  };
  return { meta, accounts };
}

/** Sanity checks on the TB itself. Returns a list of alerts (empty = all good). */
export function checkTB({ meta, accounts }) {
  const alerts = [];
  const sum = accounts.reduce((s, a) => s + a.closing, 0);
  if (Math.abs(sum) > 1) {
    alerts.push({ level: 'error', code: 'TB_NOT_BALANCED', message: `Closing balances do not sum to zero (off by ${sum.toFixed(2)})` });
  }
  if (Math.abs(meta.reportDebitTotal - meta.reportCreditTotal) > 1) {
    alerts.push({ level: 'error', code: 'TB_TOTALS_DIFFER', message: 'Zoho report debit total and credit total differ' });
  }
  if (meta.inventoryJobRunning) {
    alerts.push({ level: 'warn', code: 'FIFO_RUNNING', message: 'Zoho is still recalculating inventory - cost of goods and stock may change shortly' });
  }
  if (meta.basis && meta.basis !== 'Accrual') {
    alerts.push({ level: 'error', code: 'NOT_ACCRUAL', message: `Report basis is ${meta.basis}, expected Accrual` });
  }
  return alerts;
}
