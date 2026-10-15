// Live pipeline: Zoho -> statements. One call builds a complete, self-checked "snapshot" of the dashboard's numbers.
//
//   Trial Balance + receivables aging + party-account ledger (+ journals, vendor group)
//     -> computeFS (fsEngine.mjs) -> checks / alerts -> comparison with the audited figures (only on the audited date)
//
// The snapshot is plain JSON (no Maps / Sets), small enough to keep in Redis and to serve to the web page as it is.

import { normalizeTB, checkTB } from './tb.mjs';
import { normalizeARAging } from './receivables.mjs';
import { mapAccounts } from './mapping.mjs';
import { partyAccounts } from './vendors.mjs';
import { normalizeGL, expandMergedRows, mergedTransactionIds } from './gl.mjs';
import { computeFS } from './fsEngine.mjs';
import { reconcile } from './reconcile.mjs';
import { fetchTrialBalance, fetchARAging, fetchLedger, fetchVendorGroup, fetchJournals, LoadError } from './zohoData.mjs';
import { fyPeriod } from './config.mjs';
import { istDate } from './cache.mjs';

export const SNAPSHOT_SCHEMA = 1;

/**
 * @param {object} p
 * @param {{get:Function, stats?:{calls:number}, orgId:string}} p.zoho
 * @param {object|null} p.cache        createCache(...) or null (then nothing is cached - journals are always fetched)
 * @param {object} p.config            loadConfig(fy)
 * @param {string} p.fy                e.g. "2025-26"
 * @param {()=>number} [p.now]
 * @param {(msg:string)=>void} [p.log]
 */
export async function buildSnapshot({ zoho, cache = null, config, fy, now = Date.now, log = () => {} }) {
  const started = now();
  const calls0 = zoho.stats?.calls ?? 0;
  const today = istDate(started);
  const period = fyPeriod(fy, today);
  const extra = []; // alerts raised here (the engine adds its own)

  log(`Trial Balance ${period.from} to ${period.to}`);
  const tb = normalizeTB(await fetchTrialBalance(zoho, period));
  if (tb.meta.to && tb.meta.to !== period.to) {
    throw new LoadError(`Zoho returned the Trial Balance up to ${tb.meta.to}, not ${period.to}`, 'TB_DATES');
  }

  // which ledger accounts to read: the party accounts of the live Trial Balance + the known ones (see config/settings.json)
  const { buckets } = mapAccounts(tb.accounts, config.mapping);
  const accountIds = [...new Set([...partyAccounts(buckets).map((a) => a.id), ...(config.settings.party_account_ids ?? [])])];

  log('Receivables aging, supplier ledger and staff list');
  const [agingPages, ledgerPages, staffGroup] = await Promise.all([
    fetchARAging(zoho, { asOf: period.to }),
    fetchLedger(zoho, { accountIds, from: config.settings.books_start, to: period.to, perPage: config.settings.ledger_page_size }),
    fetchVendorGroup(zoho, config.partyRules.staff.vendor_group),
  ]);

  const aging = normalizeARAging(agingPages);
  if (!aging.meta.asOf) {
    aging.meta.asOf = period.to;
    extra.push({ level: 'info', code: 'AGING_DATE_UNVERIFIED', message: `The receivables aging answer does not state its date; ${period.to} was assumed (its total is checked against the Trial Balance)` });
  }
  if (staffGroup.ids.size === 0) {
    extra.push({ level: 'warn', code: 'STAFF_GROUP_EMPTY', message: `Vendor group "${staffGroup.group}" has no members in Zoho; staff are recognised from the employee ledger only` });
  }

  const gl = normalizeGL(ledgerPages);
  const txnIds = mergedTransactionIds(gl.rows);
  log(`Ledger: ${gl.rows.length} lines; ${txnIds.length} journal(s) to read line by line`);
  const first = await fetchJournals(zoho, txnIds, { cache });
  const journals = { ...first.journals };
  let expanded = expandMergedRows(gl.rows, journals);
  // a cached journal that no longer matches the ledger was edited in Zoho: read it again, once
  const stale = [...new Set(expanded.alerts.filter((a) => a.code === 'GL_JOURNAL_MISMATCH' && first.fromCache.has(a.txnId)).map((a) => a.txnId))];
  let refetched = 0;
  if (stale.length) {
    const again = await fetchJournals(zoho, stale, { cache, fresh: new Set(stale) });
    Object.assign(journals, again.journals);
    refetched = stale.length;
    expanded = expandMergedRows(gl.rows, journals);
  }
  if (first.missing.length) {
    extra.push({ level: 'warn', code: 'GL_JOURNAL_NOT_FOUND', message: `${first.missing.length} journal(s) in the ledger could not be opened in Zoho (${first.missing.slice(0, 3).join(', ')}${first.missing.length > 3 ? ', ...' : ''})` });
  }

  const party = {
    gl: { rows: expanded.rows },
    rules: config.partyRules,
    overrides: config.partyOverrides,
    staffGroup: staffGroup.ids,
    extraNames: staffGroup.names,
  };

  log('Building the statements');
  const result = computeFS({ tb, mapping: config.mapping, inputs: config.inputs, aging, overrides: config.overrides, party });
  result.alerts.push(...checkTB(tb), ...expanded.alerts, ...extra);

  const audited = config.audited && config.audited.as_at === tb.meta.to ? config.audited : null;
  const rec = audited ? reconcile(result, audited) : null;

  const errors = result.alerts.filter((a) => a.level === 'error').length + result.checks.filter((c) => !c.ok).length;
  const finished = now();
  return {
    schema: SNAPSHOT_SCHEMA,
    meta: {
      org: String(zoho.orgId), fy, from: period.from, to: period.to, asOf: tb.meta.to,
      istDate: today, generatedAt: new Date(finished).toISOString(), durationMs: finished - started,
      apiCalls: (zoho.stats?.calls ?? 0) - calls0,
      ok: errors === 0, errors, warnings: result.alerts.filter((a) => a.level === 'warn').length,
      tb: { basis: tb.meta.basis, accounts: tb.accounts.length, inventoryJobRunning: tb.meta.inventoryJobRunning, zohoGeneratedAt: tb.meta.generatedAt },
      ledger: { lines: gl.rows.length, pages: gl.meta.pages, journalsRead: txnIds.length, journalsFromCache: first.fromCache.size, journalsRefetched: refetched },
      audited: audited ? { basis: audited.basis, asAt: audited.as_at } : null,
      reconciled: rec ? rec.summary : null,
    },
    statements: { lines: result.lines },
    receivables: result.receivables,
    suppliers: result.suppliers,
    buckets: result.buckets,
    memo: result.memo,
    checks: result.checks,
    alerts: result.alerts,
    reconciliation: rec,
  };
}

/**
 * Build and store (what the morning job and the "refresh" button run). A lock keeps two refreshes from running at once.
 * @returns {Promise<{busy:true}|{snapshot:object, stored:object|null}>}
 */
export async function refreshSnapshot({ zoho, cache, config, fy, now, log, lockSeconds = 600 }) {
  if (cache && !(await cache.acquireLock('refresh', lockSeconds))) return { busy: true };
  try {
    const snapshot = await buildSnapshot({ zoho, cache, config, fy, now, log });
    const stored = cache ? await cache.putSnapshot(snapshot) : null;
    return { snapshot, stored };
  } finally {
    if (cache) await cache.releaseLock('refresh').catch(() => {});
  }
}
