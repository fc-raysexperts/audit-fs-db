// Test doubles (not used by the app): a fake Upstash Redis, and a Zoho client that replays the saved FY26 snapshots.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const J = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
export const haveFixtures = () =>
  ['fixtures/tb_fy26_nonzero.raw.json', 'fixtures/ar_aging_2026-03-31.raw.json', 'fixtures/gl/raw/gl_party_p1.json', 'fixtures/gl/journals_merged.json', 'fixtures/vendors_imprest_staff.raw.json']
    .every((f) => fs.existsSync(path.join(root, f)));

const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Upstash REST look-alike. `clock.t` is the current time in ms; move it to test expiry. */
export function fakeUpstash({ token = 'secret-token', clock = { t: 1_800_000_000_000 } } = {}) {
  const store = new Map(); // key -> { value, expiresAt }
  const log = [];
  const live = (key) => {
    const e = store.get(key);
    if (!e) return null;
    if (e.expiresAt !== null && e.expiresAt <= clock.t) { store.delete(key); return null; }
    return e;
  };
  async function fetchImpl(_url, init) {
    if (init.headers.authorization !== `Bearer ${token}`) return reply({ error: 'WRONGPASS invalid or missing auth token' }, 401);
    const args = JSON.parse(init.body);
    log.push(args);
    const [name, key, ...rest] = args;
    switch (String(name).toUpperCase()) {
      case 'GET': return reply({ result: live(key)?.value ?? null });
      case 'DEL': { const had = !!live(key); store.delete(key); return reply({ result: had ? 1 : 0 }); }
      case 'TTL': { const e = live(key); return reply({ result: !e ? -2 : e.expiresAt === null ? -1 : Math.ceil((e.expiresAt - clock.t) / 1000) }); }
      case 'SET': {
        const value = rest[0];
        const opts = rest.slice(1).map((x) => String(x).toUpperCase());
        const nx = opts.includes('NX');
        const exIdx = opts.indexOf('EX');
        if (nx && live(key)) return reply({ result: null });
        store.set(key, { value, expiresAt: exIdx >= 0 ? clock.t + Number(rest[1 + exIdx + 1]) * 1000 : null });
        return reply({ result: 'OK' });
      }
      default: return reply({ error: `ERR unknown command '${name}'` }, 400);
    }
  }
  return { fetchImpl, store, log, clock, token };
}

/**
 * A Zoho client that answers from the saved FY26 snapshots, the way the live API is expected to answer.
 * options.ignoreRule      -> the ledger answers with lines of an unrelated account (filter ignored)
 * options.agingDate       -> the aging report claims this date
 * options.agingPages      -> split the aging customers over this many pages
 * options.journalNet      -> function(txnId, rawJournal) to alter a journal before it is returned
 */
export function replayZoho(options = {}) {
  const tb = J('fixtures/tb_fy26_nonzero.raw.json');
  const ar = J('fixtures/ar_aging_2026-03-31.raw.json');
  const vendors = J('fixtures/vendors_imprest_staff.raw.json');
  const journalsNorm = J('fixtures/gl/journals_merged.json');
  const dir = path.join(root, 'fixtures/gl/raw');
  const glPages = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  const calls = [];
  const stats = { calls: 0 };

  const rawJournal = (id) => {
    const j = journalsNorm[id];
    if (!j) return null;
    const lines = j.lines.map((l) => ({ account_id: l.account_id, customer_id: l.contact_id, debit_or_credit: l.debit ? 'debit' : 'credit', amount: l.debit || l.credit }));
    const raw = { code: 0, message: 'success', journal: { entry_number: j.entry_number, line_items: lines } };
    return options.journalEdit ? options.journalEdit(id, raw) : raw;
  };

  async function get(p, query = {}) {
    calls.push({ path: p, query });
    stats.calls++;
    if (p === '/reports/trialbalance') return structuredClone(tb);
    if (p === '/reports/aragingsummary') {
      const root_ = structuredClone(ar);
      const r = root_.data ?? root_;
      if (options.agingDate) r.page_context.as_of_date = r.page_context.to_date = options.agingDate;
      const n = options.agingPages ?? 1;
      if (n > 1) {
        const all = r.invoice.group_list[0].group_list;
        const size = Math.ceil(all.length / n);
        const page = Number(query.page ?? 1);
        r.invoice.group_list[0].group_list = all.slice((page - 1) * size, page * size);
        r.page_context.page = page;
        r.page_context.has_more_page = page < n;
      }
      return root_;
    }
    if (p === '/reports/generalledgerdetails') {
      const page = Number(query.page ?? 1);
      const raw = structuredClone(glPages[page - 1]);
      if (options.ignoreRule) {
        const r = raw.data ?? raw;
        r.account_transactions[0].account_transactions[0].account_id = '999';
      }
      return raw;
    }
    if (p.startsWith('/journals/')) {
      const raw = rawJournal(p.slice('/journals/'.length));
      if (!raw) { const e = new Error('Journal not found'); e.status = 404; throw e; }
      return raw;
    }
    if (p === '/vendors') return structuredClone(vendors);
    throw new Error(`replayZoho: unexpected request ${p}`);
  }
  return { get, stats, calls, orgId: '60038956413', dc: 'in' };
}
