// The whole live pipeline, with Zoho replaced by the saved FY26 snapshots and Redis by a fake. Skipped without fixtures/.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot, refreshSnapshot } from '../lib/snapshot.mjs';
import { loadConfig } from '../lib/config.mjs';
import { createUpstash, createCache } from '../lib/cache.mjs';
import { fetchLedger, LoadError } from '../lib/zohoData.mjs';
import { mergedTransactionIds, normalizeGL } from '../lib/gl.mjs';
import { fakeUpstash, replayZoho, haveFixtures, J } from '../testing/fakes.mjs';
import fs from 'node:fs';

const skip = !haveFixtures();
const config = loadConfig('2025-26');
const NOW = Date.parse('2026-10-15T06:30:00+05:30');
const FY = '2025-26';
const withCache = () => {
  const f = fakeUpstash({ clock: { t: NOW } });
  return { f, cache: createCache(createUpstash({ url: 'https://x.upstash.io', token: f.token, fetchImpl: f.fetchImpl }), { org: '60038956413', now: () => f.clock.t }) };
};
const journalCount = () => Object.keys(J('fixtures/gl/journals_merged.json')).length;

test('live pipeline reproduces the audited FY26 statements (47 lines within Rs 5) and passes every check', { skip }, async () => {
  const zoho = replayZoho();
  const snap = await buildSnapshot({ zoho, config, fy: FY, now: () => NOW });
  assert.equal(snap.meta.ok, true, JSON.stringify(snap.alerts.filter((a) => a.level === 'error')));
  assert.equal(snap.meta.reconciled.ok, 47);
  assert.equal(snap.meta.reconciled.check, 0);
  assert.equal(snap.meta.reconciled.phase2, 0);
  assert.ok(snap.checks.every((c) => c.ok));
  assert.equal(snap.meta.asOf, '2026-03-31');
  assert.equal(snap.meta.istDate, '2026-10-15');
  // 1 trial balance + 1 aging + 8 ledger pages + 1 staff list + one call per journal
  assert.equal(snap.meta.apiCalls, 11 + journalCount());
  assert.equal(snap.meta.ledger.pages, 8);
  assert.deepEqual(JSON.parse(JSON.stringify(snap)), snap, 'a snapshot is plain JSON');
});

test('the right questions are put to Zoho (dates, account filter, page size, staff group)', { skip }, async () => {
  const zoho = replayZoho();
  await buildSnapshot({ zoho, config, fy: FY, now: () => NOW });
  const by = (p) => zoho.calls.filter((c) => c.path === p);
  assert.equal(by('/reports/trialbalance').length, 1);
  assert.deepEqual([by('/reports/trialbalance')[0].query.from_date, by('/reports/trialbalance')[0].query.to_date], ['2025-04-01', '2026-03-31']);
  assert.equal(by('/reports/aragingsummary')[0].query.to_date, '2026-03-31');
  const gl = by('/reports/generalledgerdetails');
  assert.deepEqual(gl.map((c) => c.query.page), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(gl[0].query.from_date, '2025-03-01');
  assert.equal(gl[0].query.per_page, 2000);
  const col = gl[0].query.rule.columns[0];
  assert.deepEqual([col.field, col.comparator], ['account_id', 'in']);
  assert.equal(col.value.length, 11);
  assert.deepEqual(by('/vendors')[0].query.cf_vendor_group, 'Imprest Staff');
});

test('second run the same day: journals come from Redis, the rest is read again', { skip }, async () => {
  const { cache } = withCache();
  const first = await buildSnapshot({ zoho: replayZoho(), cache, config, fy: FY, now: () => NOW });
  assert.equal(first.meta.ledger.journalsFromCache, 0);
  const zoho2 = replayZoho();
  const second = await buildSnapshot({ zoho: zoho2, cache, config, fy: FY, now: () => NOW });
  assert.equal(second.meta.ledger.journalsFromCache, journalCount());
  assert.equal(second.meta.apiCalls, 11);
  assert.equal(second.meta.reconciled.ok, 47);
});

test('a journal edited in Zoho after it was cached is noticed and read again', { skip }, async () => {
  const { cache } = withCache();
  await buildSnapshot({ zoho: replayZoho(), cache, config, fy: FY, now: () => NOW });
  // poison one cached journal: change an amount so it no longer agrees with the ledger row
  const id = Object.keys(J('fixtures/gl/journals_merged.json'))[0];
  const cached = await cache.getJournal(id);
  cached.lines[0].debit += 500;
  await cache.putJournal(id, cached);
  const snap = await buildSnapshot({ zoho: replayZoho(), cache, config, fy: FY, now: () => NOW });
  assert.equal(snap.meta.ledger.journalsRefetched, 1);
  assert.equal(snap.alerts.filter((a) => a.code === 'GL_JOURNAL_MISMATCH').length, 0);
  assert.equal(snap.meta.reconciled.ok, 47);
  assert.deepEqual((await cache.getJournal(id)).lines, J('fixtures/gl/journals_merged.json')[id].lines, 'the fresh copy replaced the stale one in Redis');
});

test('if Zoho ignores the account filter the run stops before reading the whole ledger', { skip }, async () => {
  const zoho = replayZoho({ ignoreRule: true });
  await assert.rejects(buildSnapshot({ zoho, config, fy: FY, now: () => NOW }), (e) => e instanceof LoadError && e.code === 'LEDGER_FILTER_IGNORED');
  assert.ok(zoho.calls.filter((c) => c.path === '/reports/generalledgerdetails').length <= 1);
});

test('a ledger that is too long, or for other dates, is refused', { skip }, async () => {
  const ids = config.settings.party_account_ids;
  await assert.rejects(fetchLedger(replayZoho(), { accountIds: ids, from: '2025-03-01', to: '2026-03-31', maxPages: 3 }), /more than the 3|more than 3 pages|3 allowed/);
  await assert.rejects(fetchLedger(replayZoho(), { accountIds: ids, from: '2025-01-01', to: '2026-03-31' }), (e) => e.code === 'LEDGER_DATES');
});

test('the receivables aging is read page by page and its date is checked', { skip }, async () => {
  const zoho = replayZoho({ agingPages: 3 });
  const snap = await buildSnapshot({ zoho, config, fy: FY, now: () => NOW });
  assert.equal(zoho.calls.filter((c) => c.path === '/reports/aragingsummary').length, 3);
  assert.equal(snap.meta.ok, true);
  assert.equal(snap.meta.reconciled.ok, 47);
  await assert.rejects(buildSnapshot({ zoho: replayZoho({ agingDate: '2026-10-15' }), config, fy: FY, now: () => NOW }), (e) => e.code === 'AGING_DATE');
});

test('refresh stores the snapshot; a second refresh while one is running is turned away; the web side can read it back', { skip }, async () => {
  const { cache } = withCache();
  const out = await refreshSnapshot({ zoho: replayZoho(), cache, config, fy: FY, now: () => NOW });
  assert.equal(out.snapshot.meta.ok, true);
  assert.ok(out.stored.latestMoved);
  const got = await cache.getSnapshot(FY, '2026-10-15');
  assert.equal(got.stale, false);
  assert.equal(got.snapshot.meta.reconciled.ok, 47);
  assert.equal(got.snapshot.statements.lines.pat.value, out.snapshot.statements.lines.pat.value);

  assert.equal(await cache.acquireLock('refresh', 60), true);
  const busy = await refreshSnapshot({ zoho: replayZoho(), cache, config, fy: FY, now: () => NOW });
  assert.deepEqual(busy, { busy: true });
  await cache.releaseLock('refresh');
  // the lock is released even when the build fails
  await assert.rejects(refreshSnapshot({ zoho: replayZoho({ ignoreRule: true }), cache, config, fy: FY, now: () => NOW }));
  assert.equal(await cache.acquireLock('refresh', 60), true);
});

test('a year without its own settings file says so plainly', () => {
  assert.throws(() => loadConfig('2026-27'), /not set up yet/);
});
