// The steps of scripts/probe-advances-ledger.mjs, kept here so that they can be tested with a replay of Zoho (the script only reads .env and prints).
//
// Question: can the signed list of advances from customers be rebuilt from the Zoho ledger of the account "Advance from debtors", customer by customer,
// after the auditors' hand-netting? Read-only; about 6 to 30 Zoho calls.

import { normalizeTB } from './tb.mjs';
import { normalizeGL, mergedTransactionIds, expandMergedRows } from './gl.mjs';
import { normalizeARAging, computeReceivables } from './receivables.mjs';
import { fetchTrialBalance, fetchLedger, fetchARAging, fetchJournals } from './zohoData.mjs';
import { ledgerAdvances, advanceModel, compareAdvances } from './advances.mjs';

export const ADVANCE_ACCOUNT_CODE = '2-08-011'; // "Advance from debtors" in config/mapping.json

/**
 * @param {object} p
 * @param {{get:Function}} p.zoho
 * @param {object} p.config                   loadConfig(fy)
 * @param {{from:string,to:string}} p.period  the financial year; `to` is the balance sheet date
 * @param {{label:string,signed:number}[]} p.signed  the lines of the signed list
 */
export async function runAdvanceLedgerProbe({ zoho, config, period, signed }) {
  const asOf = period.to;
  const tb = normalizeTB(await fetchTrialBalance(zoho, period));
  const account = tb.accounts.find((a) => a.code === ADVANCE_ACCOUNT_CODE) ?? tb.accounts.find((a) => /^advance from debtors$/i.test(a.name));
  if (!account) throw new Error(`The account with code ${ADVANCE_ACCOUNT_CODE} (Advance from debtors) was not found in the Trial Balance`);

  const pages = await fetchLedger(zoho, { accountIds: [account.id], from: config.settings.books_start, to: asOf, perPage: config.settings.ledger_page_size });
  const gl = normalizeGL(pages);
  const txnIds = mergedTransactionIds(gl.rows);
  const fetched = await fetchJournals(zoho, txnIds);
  const expanded = expandMergedRows(gl.rows, fetched.journals);
  const led = ledgerAdvances(expanded.rows, { asOf, accountId: account.id });

  const aging = normalizeARAging(await fetchARAging(zoho, { asOf }));
  const rec = computeReceivables(aging, config.overrides);
  const model = advanceModel(led.customers, rec.customers);

  // the customers with something to show (a customer netted down to nothing, or the line with no customer on it, is not a line of the list)
  const compare = (value) => compareAdvances(model.customers.filter((c) => c.id !== '-1' && value(c) > 0.005).map((c) => ({ ...c, unused: value(c) })), signed);
  return {
    asOf, account,
    gl: { lines: gl.rows.length, pages: gl.meta.pages, merged: txnIds.length, missingJournals: fetched.missing.length, alerts: expanded.alerts.filter((a) => a.level !== 'info') },
    led, rec: { customers: rec.customers.length, overridesApplied: rec.overridesApplied, alerts: rec.alerts }, model,
    signedTotal: signed.reduce((t, l) => t + l.signed, 0), signedLines: signed.length,
    A: compare((c) => c.ledger), B: compare((c) => c.advance),
  };
}

const inr = (x) => x.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pad = (s, n) => String(s).slice(0, n).padEnd(n);

/** The report as lines of text. */
export function formatAdvanceProbe(r) {
  const out = [];
  const o = (s = '') => out.push(s);
  const { account, led, model } = r;
  o('==== 1. The account ====');
  o(`${account.name} (code ${account.code}, id ${account.id}): closing balance in the Trial Balance Rs ${inr(account.closing)} (a credit is shown as minus)`);
  o('\n==== 2. The ledger of that account ====');
  o(`${r.gl.lines} lines on ${r.gl.pages} page(s); ${r.gl.merged} journal(s) post several customers to the account in one line and are opened one by one`);
  for (const a of r.gl.alerts.slice(0, 10)) o(`  note: ${a.message}`);
  if (r.gl.missingJournals) o(`  ${r.gl.missingJournals} journal(s) could not be opened in Zoho`);
  o(`Customers with an advance in the ledger: ${led.customers.filter((c) => c.ledger > 0.005).length}; with a debit balance (applied or refunded more than received): ${led.customers.filter((c) => c.ledger < -0.005).length}`);
  o(`Ledger added up (credit balance): Rs ${inr(led.total)}     Trial Balance: Rs ${inr(-account.closing)}     difference: Rs ${inr(led.total + account.closing)}`);
  const untagged = led.customers.find((c) => c.id === '-1');
  if (untagged) o(`Lines with no customer on them: Rs ${inr(untagged.ledger)}`);

  o('\n==== 3. Receivables aging and the hand-netting ====');
  o(`${r.rec.customers} customers; hand-netting applied: ${r.rec.overridesApplied ? 'yes' : 'NO (the list is for another date)'}`);
  for (const a of r.rec.alerts.slice(0, 10)) o(`  ${a.level}: ${a.message}`);
  o(`Ledger advances Rs ${inr(model.ledgerTotal)}  +  netting Rs ${inr(model.nettedTotal)}  +  customers in credit Rs ${inr(model.creditTotal)}  =  Rs ${inr(model.total)}`);
  if (model.negative.length) {
    o(`\nNetting larger than the ledger advance (${model.negative.length} customers - the netting may be against something other than this account):`);
    for (const c of model.negative.slice(0, 30)) o(`  ${pad(c.name, 42)} ledger ${inr(c.ledger).padStart(16)}  netting ${inr(c.adjustment).padStart(16)}  credit ${inr(c.credit).padStart(14)}  result ${inr(c.advance).padStart(16)}`);
  }

  o('\n==== 4. Against the signed list (BS Grouping, Detail of Advance from Customer) ====');
  o(`Signed list: ${r.signedLines} lines, Rs ${inr(r.signedTotal)}`);
  const block = (title, c) => {
    o(`\n---- ${title} ----`);
    o(`Same name, same figure (within Rs 1): ${c.same.length}   Rs ${inr(c.same.reduce((t, x) => t + x.signed, 0))}`);
    o(`Same figure, written differently:      ${c.renamed.length}   Rs ${inr(c.renamed.reduce((t, x) => t + x.signed, 0))}`);
    o(`Found, another figure:                 ${c.differ.length}`);
    o(`On the sheet, nothing here:            ${c.missing.length}   Rs ${inr(c.missing.reduce((t, x) => t + x.signed, 0))}`);
    o(`Here, not on the sheet:                ${c.extra.length}   Rs ${inr(c.extra.reduce((t, x) => t + x.unused, 0))}`);
    o(`Part of the signed total that agrees:  Rs ${inr(c.explained)} (${c.signedTotal ? ((100 * c.explained) / c.signedTotal).toFixed(1) : '0.0'} percent)`);
  };
  block('A. Ledger only, before the netting', r.A);
  block('B. Ledger, after the netting and the customers in credit', r.B);
  const b = r.B;
  const parts = (x) => (x.src ? `ledger ${inr(x.src.ledger)}  netting ${inr(x.src.adjustment)}  credit ${inr(x.src.credit)}` : '');
  if (b.renamed.length) { o('\nSame figure, written differently (sheet name / Zoho name / figure):'); for (const x of b.renamed.slice(0, 60)) o(`  ${x.label}  /  ${x.name}  ${inr(x.signed)}`); }
  if (b.differ.length) { o('\nFound, another figure (sheet name / sheet / Zoho model / difference / parts):'); for (const x of b.differ.slice(0, 60)) o(`  ${x.label}  ${inr(x.signed)}  ${inr(x.zoho)}  ${inr(x.diff)}   ${parts(x)}`); }
  if (b.missing.length) { o('\nOn the sheet, nothing here:'); for (const x of b.missing.slice(0, 60)) o(`  ${x.label}  ${inr(x.signed)}`); }
  if (b.extra.length) { o('\nHere, not on the sheet (largest first):'); for (const x of b.extra.slice(0, 60)) o(`  ${x.name}  ${inr(x.unused)}   ${parts(x)}`); }
  return out;
}
