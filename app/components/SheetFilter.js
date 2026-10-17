'use client';
import { useState } from 'react';

/** A search box that hides the rows of a table that do not contain the typed text. Works on the page as it is: no data is sent twice. */
export default function SheetFilter({ target, label = 'Find in this sheet' }) {
  const [q, setQ] = useState('');
  function apply(text) {
    setQ(text);
    const table = document.getElementById(target);
    if (!table) return;
    const needle = text.trim().toLowerCase();
    let shown = 0;
    for (const tr of table.tBodies[0].rows) {
      const hit = !needle || tr.textContent.toLowerCase().includes(needle);
      tr.hidden = !hit;
      if (hit) shown += 1;
    }
    const out = document.getElementById(`${target}-count`);
    if (out) out.textContent = needle ? `${shown} ${shown === 1 ? 'row matches' : 'rows match'}` : '';
  }
  return (
    <div className="filters">
      <label>{label}<input type="search" value={q} onChange={(e) => apply(e.target.value)} placeholder="Type a name, number or word" /></label>
      <span className="dim small" id={`${target}-count`} aria-live="polite" />
    </div>
  );
}
