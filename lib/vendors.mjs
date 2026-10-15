// Supplier / party layer ("Layer 2"): the lines of the audited balance sheet that need party-level data.
//
//   Trade payables (MSME / others)       a party whose NET balance over all party accounts is a credit
//   Advance to suppliers & others        a party whose NET balance is a debit (loans given and staff imprest advances included)
//   Retention money payable              Trial Balance retention account + parties the auditors moved there
//   Outstanding expenses                 Trial Balance accruals + staff imprest payables + parties the auditors moved there
//
// Why per party and not per account: the auditors present each party NET. A supplier with an advance in one ledger and a
// bill in another shows as one figure. A party-level balance only exists in the ledger lines (the Trial Balance has accounts,
// not parties), so the ledger is read and every account is tied back to the Trial Balance (checks below).
//
// Three kinds of rule, kept apart on purpose:
//   1. Standing rules   (config/party_rules.json)            - how staff are recognised, who is MSME. Apply to every year.
//   2. Year judgments   (config/party_overrides.fyXX.json)   - the auditors' reclassifications. Apply to ONE as-of date only.
//   3. Arithmetic       (this file)                          - nothing year-specific.

import { UNTAGGED, summarizeGL } from './gl.mjs';
import { num, r2 } from './util.mjs';

export const PARTY_BUCKETS = ['vendor_advances', 'vendor_payables', 'loans_advances_given', 'staff_advances'];
const EPS = 0.005;
const TIE_TOLERANCE = 1; // rupee, per account

/** Live Trial Balance accounts that belong to the party layer (these are the accounts to ask the ledger for). */
export function partyAccounts(buckets) {
  const out = [];
  for (const b of PARTY_BUCKETS) for (const a of buckets[b]?.accounts ?? []) out.push({ ...a, bucket: b });
  return out;
}

/**
 * Zoho vendor list (one response, or all pages of it) -> the set of contacts in custom field "Vendor Group" = group.
 * @param {object|object[]} input
 * @param {string} group
 * @param {{serverFiltered?:boolean}} [opt]  true when the list was already asked for this group only (rows without the field are then accepted)
 * @returns {{group:string, ids:Set<string>, names:Map<string,string>}}
 */
export function normalizeVendorGroup(input, group, { serverFiltered = false } = {}) {
  const pages = Array.isArray(input) ? input : [input];
  const ids = new Set();
  const names = new Map();
  let last = {};
  for (const raw of pages) {
    const root = raw?.data ?? raw;
    const contacts = root?.contacts;
    if (!Array.isArray(contacts)) throw new Error('Vendor list response has an unexpected shape (no contacts)');
    last = root.page_context ?? {};
    for (const c of contacts) {
      const field = c.cf_vendor_group ?? (c.custom_fields ?? []).find((f) => f.api_name === 'cf_vendor_group')?.value;
      if (field === undefined || field === null || field === '') { if (!serverFiltered) continue; } else if (field !== group) continue;
      ids.add(String(c.contact_id));
      names.set(String(c.contact_id), c.contact_name ?? '');
    }
  }
  if (last.has_more_page === true) throw new Error('Vendor list is incomplete: has_more_page is true (ask for a larger per_page or read the next page)');
  return { group, ids, names };
}

/**
 * @param {object} p
 * @param {{rows:object[]}} p.gl                     expanded ledger rows (gl.mjs)
 * @param {object[]} p.accounts                      from partyAccounts(buckets): live party accounts with TB closing balances
 * @param {string} p.asOf                            Trial Balance "to" date
 * @param {{staff:{employee_ledger_account_ids:string[]}, msme:{contact_ids:object}}} p.rules   standing rules
 * @param {{as_of:string, entries:object}|null} p.overrides                                    year judgments
 * @param {Set<string>|null} p.staffGroup            contact ids in the "Imprest Staff" vendor group (null = not available)
 * @param {Map<string,string>} [p.extraNames]        id -> name, used when the ledger carries no name
 */
export function computeSuppliers({ gl, accounts, asOf, rules, overrides, staffGroup, extraNames }) {
  const alerts = [];
  const checks = [];
  const { byContact, byAccount, byContactAccount, names } = summarizeGL(gl.rows);
  const nameOf = (id) => names.get(id) ?? extraNames?.get(id) ?? (id === UNTAGGED ? '(no contact on the entry)' : id);

  // ---- tie every party account to the Trial Balance ----
  const tbIds = new Set(accounts.map((a) => a.id));
  for (const a of accounts) {
    const g = byAccount.get(a.id) ?? 0;
    const diff = g - a.closing;
    const ok = Math.abs(diff) <= TIE_TOLERANCE;
    checks.push({ key: `gl_tie_${a.code || a.id}`, label: `Ledger lines add up to the Trial Balance: ${a.name}`, value: diff, expected: 0, ok });
    if (!ok) {
      alerts.push({ level: 'error', code: 'GL_VS_TB', message: `${a.name}: ledger lines total ${r2(g)} but the Trial Balance says ${r2(a.closing)} (ledger window wrong, a page missing, or an entry changed while loading)` });
    }
  }
  for (const [id, v] of byAccount) {
    if (!tbIds.has(id) && Math.abs(v) > EPS) {
      alerts.push({ level: 'error', code: 'GL_ACCOUNT_UNEXPECTED', message: `Ledger has lines for account ${id} (${r2(v)}) that is not a party account in the Trial Balance mapping` });
    }
  }

  // ---- year judgments only on their own date ----
  const useOverrides = !!overrides && overrides.as_of === asOf;
  if (overrides && !useOverrides) {
    alerts.push({
      level: 'info', code: 'PARTY_OVERRIDES_SKIPPED',
      message: `The auditors' party reclassifications are for ${overrides.as_of} only; this report is as of ${asOf}, so only the standing rules are used (retention / outstanding / MSME splits may differ from what the auditors will show)`,
    });
  }
  const ov = useOverrides ? overrides.entries : {};

  const staffLedgers = rules?.staff?.employee_ledger_account_ids ?? [];
  const msme = rules?.msme?.contact_ids ?? {};
  if (!staffGroup) {
    alerts.push({ level: 'warn', code: 'STAFF_GROUP_MISSING', message: 'Vendor group "Imprest Staff" was not loaded; staff are recognised from the employee ledger only' });
  }
  const isStaff = (id) =>
    (staffGroup?.has(id) ?? false) || staffLedgers.some((acc) => Math.abs(byContactAccount.get(`${id}|${acc}`) ?? 0) > EPS);

  // ---- classify each party ----
  const T = { tpMsme: 0, tpOthers: 0, advance: 0, retention: 0, outstanding: 0, imprest: 0 };
  const parties = [];
  const seen = new Set();
  let netSum = 0;
  for (const [id, net] of byContact) {
    if (Math.abs(net) <= EPS || id.includes(',')) continue;
    netSum += net;
    const o = ov[id];
    if (o) seen.add(id);
    let cls;
    if (id === UNTAGGED) {
      if (net > 0) cls = 'advance';
      else {
        cls = 'trade_payable';
        alerts.push({ level: 'warn', code: 'UNTAGGED_CREDIT', message: `Entries with no contact leave a CREDIT of ${r2(-net)} in the supplier accounts; shown as trade payables (others) - tag them in Zoho` });
      }
    } else if (net > 0) {
      cls = 'advance';
    } else if (o?.class) {
      cls = o.class;
    } else if (isStaff(id)) {
      cls = 'imprest';
    } else if (msme[id]) {
      cls = 'trade_payable_msme';
    } else {
      cls = 'trade_payable';
    }
    const amount = Math.abs(net);
    switch (cls) {
      case 'advance': T.advance += amount; break;
      case 'retention': T.retention += amount; break;
      case 'outstanding': T.outstanding += amount; break;
      case 'imprest': T.imprest += amount; break;
      case 'trade_payable_msme': T.tpMsme += amount; break;
      case 'trade_payable': T.tpOthers += amount; break;
      default: throw new Error(`Unknown party class "${cls}" for ${nameOf(id)}`);
    }
    let gross = 0;
    if (o?.gross_up) { gross = o.gross_up; T.advance += gross; T.tpOthers += gross; }
    parties.push({ id, name: nameOf(id), net, class: cls, amount, grossUp: gross });
  }

  if (useOverrides) {
    for (const [id, o] of Object.entries(ov)) {
      const now = byContact.get(id) ?? 0;
      if (!seen.has(id)) {
        alerts.push({ level: 'warn', code: 'PARTY_OVERRIDE_MISSING', message: `Reclassification list: ${o.name} no longer has a balance in the supplier accounts` });
      } else if (o.zb_net !== undefined && Math.abs(now - o.zb_net) > 1) {
        alerts.push({ level: 'warn', code: 'PARTY_OVERRIDE_STALE', message: `${o.name}: balance is now ${r2(now)} but the reclassification list was made at ${r2(o.zb_net)} - check this party` });
      }
      if (o.class && now > 0) {
        alerts.push({ level: 'info', code: 'PARTY_OVERRIDE_UNUSED', message: `${o.name} is listed as "${o.class}" but now has a debit balance, so it is shown as an advance` });
      }
    }
  }

  // ---- arithmetic must conserve the ledger: nothing created, nothing lost ----
  const placed = T.advance - T.tpMsme - T.tpOthers - T.retention - T.outstanding - T.imprest;
  const conserve = placed - netSum;
  checks.push({ key: 'party_conserved', label: 'Every party balance is placed on exactly one line (advances - payables - retention - outstanding = ledger net)', value: conserve, expected: 0, ok: Math.abs(conserve) <= 0.01 });
  const tbNet = accounts.reduce((s, a) => s + a.closing, 0);
  checks.push({ key: 'party_net_vs_tb', label: 'Party-level total equals the Trial Balance party accounts', value: netSum - tbNet, expected: 0, ok: Math.abs(netSum - tbNet) <= TIE_TOLERANCE * Math.max(1, accounts.length) });

  const tradePayables = T.tpMsme + T.tpOthers;
  return { totals: { ...T, tradePayables }, parties, overridesApplied: useOverrides, checks, alerts, ledgerNet: netSum };
}
