// The tabs of the workbook screen: one tab for each sheet of the audited Excel file, in the order of the file, like the sheet tabs of
// Excel. Sheets that the index lists under `tabs` share one tab (today: Note 3, Note 4-19 and Note 20-27 are one tab, "Notes 3 to 27").
// Pure functions: the index of the workbook (config/workbook.fyYY/index.json) is handed in.
//
//   { id, label, status, note, sheets: [sheet ids shown on the tab] }
//
// The first tab is always the "Index" (the list of all sheets). Without an index (a year that has no workbook folder yet) the tabs of the
// live sheets are offered, so the statements and the notes can still be opened.

export const INDEX_ID = 'index';
export const tabHref = (id) => (!id || id === INDEX_ID ? '/workbook' : `/workbook/${id}`);

const INDEX_TAB = { id: INDEX_ID, label: 'Index', status: null, note: 'Every sheet of the workbook, what it is and how much of it comes from Zoho Books', sheets: [] };

/** The live sheets, for a year whose workbook folder is not set up yet. */
const FALLBACK = {
  sheets: [
    { id: 'bs', sheet: 'BS', status: 'live', note: 'Balance Sheet.' },
    { id: 'p-l', sheet: 'P&L', status: 'live', note: 'Statement of Profit and Loss.' },
    { id: 'cf', sheet: 'CF', status: 'live', note: 'Cash Flow Statement.' },
    { id: 'note-3', sheet: 'Note 3', status: 'live', note: 'Share capital.' },
    { id: 'note-4-19', sheet: 'Note 4-19', status: 'live', note: 'Notes 4 to 19.' },
    { id: 'note-12-mfa', sheet: 'Note-12 MFA', status: 'live', note: 'Fixed-asset schedule.' },
    { id: 'note-20-27', sheet: 'Note 20-27', status: 'live', note: 'Notes 20 to 27.' },
    { id: 'note-28-a', sheet: 'Note 28(A)', status: 'live', note: 'EPS and MSME.' },
    { id: 'note-28-b', sheet: 'Note 28(B)', status: 'live', note: 'Analytical ratios.' },
    { id: 'computation', sheet: 'Computation', status: 'live', note: 'Computation of income and tax.' },
    { id: 'd-tax', sheet: 'D.Tax', status: 'live', note: 'Deferred tax working.' },
    { id: 'weighted-average-shares', sheet: 'Weighted Average Shares', status: 'live', note: 'Weighted average number of shares.' },
  ],
  tabs: [{ id: 'notes', label: 'Notes 3 to 27', sheets: ['note-3', 'note-4-19', 'note-20-27'], note: 'Notes 3 to 27.' }],
};

/**
 * @param {{sheets:{id:string, sheet:string, status:string, note?:string}[], tabs?:{id:string,label:string,sheets:string[],note?:string}[]}|null} index
 * @returns {{tabs:object[], byId:Object<string,object>, tabOfSheet:Object<string,string>}}
 */
export function buildTabs(index) {
  const src = index?.sheets?.length ? index : FALLBACK;
  const sheets = src.sheets;
  const ids = new Set(sheets.map((s) => s.id));
  const merged = new Map(); // sheet id -> merged tab
  for (const t of src.tabs ?? []) {
    if (!t.id || t.id === INDEX_ID) throw new Error(`A tab cannot be called "${t.id}"`);
    if (ids.has(t.id) && !t.sheets.includes(t.id)) throw new Error(`The tab "${t.id}" has the name of a sheet that is not on it`);
    for (const sid of t.sheets) {
      if (!ids.has(sid)) throw new Error(`The tab "${t.id}" lists a sheet that does not exist: ${sid}`);
      if (merged.has(sid)) throw new Error(`The sheet "${sid}" is on two tabs`);
      merged.set(sid, t);
    }
  }

  const tabs = [INDEX_TAB];
  const made = new Set();
  for (const s of sheets) {
    const m = merged.get(s.id);
    if (!m) { tabs.push({ id: s.id, label: s.sheet, status: s.status, note: s.note ?? '', sheets: [s.id] }); continue; }
    if (made.has(m.id)) continue; // the tab sits where its first sheet is
    made.add(m.id);
    const members = m.sheets.map((sid) => sheets.find((x) => x.id === sid));
    const statuses = new Set(members.map((x) => x.status));
    tabs.push({ id: m.id, label: m.label, status: statuses.size === 1 ? [...statuses][0] : 'semi', note: m.note ?? members.map((x) => x.note).filter(Boolean).join(' '), sheets: m.sheets });
  }

  const byId = Object.fromEntries(tabs.map((t) => [t.id, t]));
  const tabOfSheet = {};
  for (const t of tabs) for (const sid of t.sheets) tabOfSheet[sid] = t.id;
  return { tabs, byId, tabOfSheet };
}

/** "note-4-19" -> "note-4": where a sheet starts inside a tab that holds several (the notes carry anchors #note-3, #note-4 ...). */
const anchorOf = (sheetId) => { const m = /^note-(\d+)/.exec(sheetId); return m ? `#note-${m[1]}` : ''; };

/** Where a sheet is shown: its tab, and (on a tab that holds several sheets) the place inside it. null for an unknown sheet. */
export function sheetHref(model, sheetId) {
  const tid = model.tabOfSheet[sheetId];
  if (!tid) return null;
  return `${tabHref(tid)}${model.byId[tid].sheets.length > 1 ? anchorOf(sheetId) : ''}`;
}

/**
 * What a web address names: a tab, or (for old links) a sheet. A sheet that sits on a tab with others is sent to its tab.
 * @returns {{tab:object}|{redirect:string}|null}
 */
export function resolveTab(model, param) {
  const id = String(param ?? '');
  if (Object.prototype.hasOwnProperty.call(model.byId, id)) return { tab: model.byId[id] };
  if (Object.prototype.hasOwnProperty.call(model.tabOfSheet, id)) return { redirect: `${tabHref(model.tabOfSheet[id])}${anchorOf(id)}` };
  return null;
}
