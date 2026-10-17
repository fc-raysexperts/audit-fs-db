// The tab strip of the workbook screen: one tab for each sheet of the Excel file, the three Notes sheets 3 to 27 kept on one tab,
// old addresses sent to the right tab, and a wrong `tabs` list in index.json reported plainly.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildTabs, resolveTab, sheetHref, tabHref, INDEX_ID } from '../lib/tabs.mjs';
import { loadConfig } from '../lib/config.mjs';
import { createContext } from '../lib/server.mjs';

const config = loadConfig('2025-26');
const index = config.workbook.index;
const model = buildTabs(index);

test('one tab for each sheet of the Excel file, Index first, the Notes sheets 3 to 27 together', () => {
  assert.equal(index.sheets.length, 34);
  assert.equal(model.tabs[0].id, INDEX_ID);
  assert.equal(model.tabs.length, 33, 'Index + 34 sheets - 2 (three notes sheets share a tab)');
  const notes = model.byId.notes;
  assert.equal(notes.label, 'Notes 3 to 27');
  assert.deepEqual(notes.sheets, ['note-3', 'note-4-19', 'note-20-27']);
  assert.equal(notes.status, 'live');
  // every sheet is on exactly one tab
  const seen = model.tabs.flatMap((t) => t.sheets);
  assert.equal(seen.length, 34);
  assert.deepEqual([...seen].sort(), index.sheets.map((s) => s.id).sort());
  // the tabs that stand for one sheet carry the sheet's own name, as in Excel, and follow the order of the file
  const single = model.tabs.filter((t) => t.sheets.length === 1);
  assert.deepEqual(single.map((t) => t.label), index.sheets.filter((s) => !notes.sheets.includes(s.id)).map((s) => s.sheet));
  // Note 1-2, Note-12 MFA and Note 28 (A) (B) (C) are tabs of their own
  for (const id of ['note-1-2', 'note-12-mfa', 'note-28-a', 'note-28-b', 'note-28-c']) assert.deepEqual(model.byId[id].sheets, [id]);
});

test('the tab sits where its first sheet is in the Excel file', () => {
  const ids = model.tabs.map((t) => t.id);
  assert.ok(ids.indexOf('bs') < ids.indexOf('notes'));
  assert.ok(ids.indexOf('notes') < ids.indexOf('note-12-mfa'));
  assert.ok(ids.indexOf('note-12-mfa') < ids.indexOf('note-28-a'));
  assert.equal(ids.indexOf('note-1-2') + 1, ids.indexOf('notes'));
});

test('an address names a tab; an old address of a sheet that shares a tab goes to its place on that tab; anything else is nothing', () => {
  assert.equal(resolveTab(model, 'bs').tab.id, 'bs');
  assert.equal(resolveTab(model, 'index').tab.id, 'index');
  assert.equal(resolveTab(model, 'notes').tab.id, 'notes');
  assert.deepEqual(resolveTab(model, 'note-3'), { redirect: '/workbook/notes#note-3' });
  assert.deepEqual(resolveTab(model, 'note-4-19'), { redirect: '/workbook/notes#note-4' });
  assert.deepEqual(resolveTab(model, 'note-20-27'), { redirect: '/workbook/notes#note-20' });
  assert.equal(resolveTab(model, 'nope'), null);
  assert.equal(resolveTab(model, ''), null);
  assert.equal(resolveTab(model, undefined), null);
  for (const evil of ['constructor', '__proto__', 'toString', 'hasOwnProperty', '../config', '..%2Fmapping']) assert.equal(resolveTab(model, evil), null, evil);
});

test('where each sheet is shown', () => {
  assert.equal(tabHref('index'), '/workbook');
  assert.equal(tabHref(INDEX_ID), '/workbook');
  assert.equal(tabHref('cf'), '/workbook/cf');
  assert.equal(sheetHref(model, 'cf'), '/workbook/cf');
  assert.equal(sheetHref(model, 'note-4-19'), '/workbook/notes#note-4');
  assert.equal(sheetHref(model, 'note-12-mfa'), '/workbook/note-12-mfa', 'a tab of its own has no anchor');
  assert.equal(sheetHref(model, 'nope'), null);
});

test('a merged tab is live only when every sheet on it is; otherwise it is part live', () => {
  const sheets = [
    { id: 'a', sheet: 'A', status: 'live', note: 'one' },
    { id: 'b', sheet: 'B', status: 'fixed', note: 'two' },
    { id: 'c', sheet: 'C', status: 'live', note: 'three' },
    { id: 'd', sheet: 'D', status: 'live', note: 'four' },
  ];
  const m = buildTabs({ sheets, tabs: [{ id: 'ab', label: 'A and B', sheets: ['a', 'b'] }, { id: 'cd', label: 'C and D', sheets: ['c', 'd'] }] });
  assert.equal(m.byId.ab.status, 'semi');
  assert.equal(m.byId.cd.status, 'live');
  assert.equal(m.byId.ab.note, 'one two', 'without a note of its own the tab says what its sheets say');
  assert.deepEqual(m.tabs.map((t) => t.id), ['index', 'ab', 'cd']);
});

test('a wrong `tabs` list is refused with a plain reason', () => {
  const sheets = [{ id: 'a', sheet: 'A', status: 'live' }, { id: 'b', sheet: 'B', status: 'live' }];
  assert.throws(() => buildTabs({ sheets, tabs: [{ id: 'x', label: 'X', sheets: ['a', 'zzz'] }] }), /does not exist: zzz/);
  assert.throws(() => buildTabs({ sheets, tabs: [{ id: 'x', label: 'X', sheets: ['a'] }, { id: 'y', label: 'Y', sheets: ['a', 'b'] }] }), /"a" is on two tabs/);
  assert.throws(() => buildTabs({ sheets, tabs: [{ id: 'index', label: 'X', sheets: ['a'] }] }), /cannot be called "index"/);
  assert.throws(() => buildTabs({ sheets, tabs: [{ id: 'b', label: 'X', sheets: ['a'] }] }), /name of a sheet that is not on it/);
});

test('a year without a workbook folder still offers the live sheets, with the notes together', () => {
  const m = buildTabs(null);
  assert.equal(m.tabs[0].id, INDEX_ID);
  assert.ok(m.byId.bs && m.byId['p-l'] && m.byId.cf && m.byId.notes && m.byId['note-12-mfa'] && m.byId['note-28-b'] && m.byId.computation);
  assert.deepEqual(m.byId.notes.sheets, ['note-3', 'note-4-19', 'note-20-27']);
  assert.equal(buildTabs({ sheets: [] }).tabs.length, m.tabs.length, 'an empty index is treated as none');
  // every address the old pages redirected to exists
  for (const id of ['bs', 'cf', 'notes', 'note-12-mfa', 'note-28-b', 'computation']) assert.ok(resolveTab(m, id)?.tab, id);
});

test('the server context hands out the tabs of the year', () => {
  const ctx = createContext({ env: {} });
  const m = ctx.tabs();
  assert.equal(m.tabs.length, 33);
  assert.equal(m.byId.notes.label, 'Notes 3 to 27');
});

test('every address the old screens moved to, and every link of the booklet summary, names a tab', async () => {
  const { buildBooks } = await import('../lib/books.mjs');
  const src = fs.readFileSync(new URL('../lib/books.mjs', import.meta.url), 'utf8');
  const hrefs = [...src.matchAll(/'(\/workbook\/[a-z0-9-]+)'/g)].map((m) => m[1]);
  assert.equal(hrefs.length, 5);
  for (const h of hrefs) assert.ok(resolveTab(model, h.slice('/workbook/'.length))?.tab, h);
  assert.equal(typeof buildBooks, 'function');
});

test('every sheet without an exported file has a live view written for it', () => {
  const bodies = fs.readFileSync(new URL('../app/tabs/bodies.js', import.meta.url), 'utf8');
  const notesIds = bodies.match(/NOTE_SHEETS = \[([^\]]*)\]/)[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));
  const keys = bodies.slice(bodies.indexOf('export const BODIES')).match(/^\s+'?([a-z0-9-]+)'?:/gm).map((s) => s.trim().replace(/['":]/g, ''));
  for (const s of index.sheets.filter((x) => !x.file)) {
    assert.ok(keys.includes(s.id) || notesIds.includes(s.id), `${s.sheet} (${s.id}) has neither a signed file nor a live view`);
  }
});
