// Lays a note out as the rows of a statement table: group headings, the lines, group subtotals and the note total.
// (Kept here, away from the screens, so the layout can be tested.)

/**
 * @param {object} note  one entry of buildNotes().notes
 * @returns {object[]}  rows with kind heading | line | memo | subtotal | total
 */
export function noteRows(note) {
  const rows = [];
  const single = note.groups.length === 1 && !note.groups[0].label;
  for (const g of note.groups) {
    if (g.label && !single) rows.push({ key: `${note.no}:${g.label}`, kind: 'heading', label: g.label });
    for (const r of g.rows) rows.push({ ...r, kind: r.counted ? 'line' : 'memo' });
    if (g.total && !single) rows.push({ ...g.total, key: `${note.no}:${g.label}:total`, kind: 'subtotal', label: g.total.label ?? `Total ${g.label}` });
  }
  if (note.total) rows.push({ ...note.total, key: `${note.no}:total`, kind: 'total', label: note.total.label ?? 'Total' });
  return rows;
}
