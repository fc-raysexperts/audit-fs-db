// Puts every Trial Balance account into exactly one "bucket" (a small, named pool such as "ppe_net").
// Financial-statement lines are then simple formulas over buckets (see fsEngine.mjs).
//
// Matching, most specific first:  accountId  >  exact code  >  family (code, or code starting "<family>-").
// If two DIFFERENT buckets claim the same account at the same specificity -> alert (config mistake).
// If an account with a non-zero closing balance is claimed by nobody        -> alert (new / unmapped account).

import { r2 } from './util.mjs';

const EPS = 0.005;

export function validateMapping(mapping) {
  const problems = [];
  for (const [i, rule] of mapping.rules.entries()) {
    if (!mapping.buckets[rule.bucket]) problems.push(`rule #${i} points to unknown bucket "${rule.bucket}"`);
    const m = rule.match ?? {};
    if (!(m.accountId || m.code || m.family)) problems.push(`rule #${i} has no accountId / code / family`);
  }
  if (problems.length) throw new Error('Invalid mapping.json: ' + problems.join('; '));
}

function compile(mapping) {
  const byId = new Map();
  const byCode = new Map();
  const families = [];
  const push = (map, key, rule) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(rule);
  };
  for (const rule of mapping.rules) {
    const m = rule.match;
    if (m.accountId) push(byId, String(m.accountId), rule);
    else if (m.code) push(byCode, m.code, rule);
    else families.push({ family: m.family, rule });
  }
  return { byId, byCode, families };
}

function claim(account, idx) {
  const ids = idx.byId.get(account.id);
  if (ids) return { rank: 3, rules: ids };
  const codes = account.code ? idx.byCode.get(account.code) : null;
  if (codes) return { rank: 2, rules: codes };
  if (account.code) {
    let best = null;
    for (const f of idx.families) {
      if (account.code === f.family || account.code.startsWith(f.family + '-')) {
        if (!best || f.family.length > best.len) best = { len: f.family.length, rules: [f.rule] };
        else if (f.family.length === best.len) best.rules.push(f.rule);
      }
    }
    if (best) return { rank: 1, rules: best.rules };
  }
  return null;
}

/**
 * @returns {{ buckets: Record<string,{sum:number, opening:number, debit:number, credit:number, accounts:object[]}>,
 *            alerts: object[], mappedCount:number }}
 */
export function mapAccounts(accounts, mapping) {
  validateMapping(mapping);
  const idx = compile(mapping);
  const buckets = {};
  for (const id of Object.keys(mapping.buckets)) buckets[id] = { sum: 0, opening: 0, debit: 0, credit: 0, accounts: [] };
  const alerts = [];
  let mappedCount = 0;

  for (const a of accounts) {
    const live = Math.abs(a.closing) > EPS;
    const c = claim(a, idx);
    if (!c) {
      if (live) {
        alerts.push({
          level: 'error', code: 'UNMAPPED_ACCOUNT',
          message: `Account "${a.name}" (${a.code || 'no code'}, id ${a.id}) has a balance of ${r2(a.closing)} but is not in the mapping`,
          account: { id: a.id, code: a.code, name: a.name, closing: a.closing },
        });
      }
      continue;
    }
    const distinct = [...new Set(c.rules.map((r) => r.bucket))];
    if (distinct.length > 1 && live) {
      alerts.push({
        level: 'error', code: 'DOUBLE_CLAIMED',
        message: `Account "${a.name}" (${a.code}) is claimed by several buckets: ${distinct.join(', ')}`,
        account: { id: a.id, code: a.code, name: a.name, closing: a.closing },
      });
    }
    const bucketId = distinct[0];
    const b = buckets[bucketId];
    b.sum += a.closing;
    b.opening += a.opening;
    b.debit += a.debit;
    b.credit += a.credit;
    if (live) b.accounts.push({ id: a.id, code: a.code, name: a.name, closing: a.closing });
    if (live) mappedCount++;
  }
  return { buckets, alerts, mappedCount };
}
