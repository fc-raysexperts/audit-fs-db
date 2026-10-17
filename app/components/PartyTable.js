'use client';
import { useMemo, useState } from 'react';
import Amt from './Amt';

/**
 * A searchable, sortable table of customers or suppliers.
 * columns: [{ key, label, numeric?, brackets? }]; rows: objects with those keys (+ `name`, optional `note`)
 * filters: optional select box { key, label, options: [[value, label]] } and optional check box { key, label } (rows where row[key] is truthy)
 */
export default function PartyTable({ columns, rows, select = null, check = null, totalKeys = [], nameLabel }) {
  const [q, setQ] = useState('');
  const [pick, setPick] = useState('');
  const [only, setOnly] = useState(false);
  const [sort, setSort] = useState({ key: columns.find((c) => c.numeric)?.key ?? 'name', dir: -1 });

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = rows.filter((r) => (!needle || r.name.toLowerCase().includes(needle)) && (!select || !pick || r[select.key] === pick) && (!check || !only || r[check.key]));
    const k = sort.key;
    return [...list].sort((a, b) => {
      const x = k === 'name' ? a.name.toLowerCase() : Math.abs(a[k] ?? 0);
      const y = k === 'name' ? b.name.toLowerCase() : Math.abs(b[k] ?? 0);
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
    });
  }, [rows, q, pick, only, sort, select, check]);

  const totals = Object.fromEntries(totalKeys.map((k) => [k, shown.reduce((s, r) => s + (r[k] ?? 0), 0)]));
  const flip = (key) => setSort((s) => (s.key === key ? { key, dir: -s.dir } : { key, dir: key === 'name' ? 1 : -1 }));
  const aria = (key) => (sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none');
  const arrow = (key) => (sort.key === key ? (sort.dir === 1 ? '▲' : '▼') : '');

  return (
    <>
      <div className="filters">
        <input type="search" placeholder={`Search ${nameLabel.toLowerCase()}`} aria-label={`Search ${nameLabel.toLowerCase()}`} value={q} onChange={(e) => setQ(e.target.value)} />
        {select && (
          <label>{select.label}
            <select value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">All</option>
              {select.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
        )}
        {check && <label><input type="checkbox" checked={only} onChange={(e) => setOnly(e.target.checked)} /> {check.label}</label>}
        <span className="dim small" aria-live="polite">{shown.length} of {rows.length}</span>
      </div>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th scope="col" aria-sort={aria('name')}><button type="button" className="sortbtn" onClick={() => flip('name')}>{nameLabel} {arrow('name')}</button></th>
              {columns.map((c) => (
                <th key={c.key} scope="col" className={c.numeric ? 'num' : ''} aria-sort={aria(c.key)}>
                  <button type="button" className="sortbtn" onClick={() => flip(c.key)}>{c.label} {arrow(c.key)}</button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id}>
                <th scope="row" style={{ fontWeight: 400 }}>{r.name}{r.note && <div className="dim small">{r.note}</div>}</th>
                {columns.map((c) => (
                  <td key={c.key} className={c.numeric ? 'num' : ''}>{c.numeric ? <Amt v={r[c.key]} /> : r[c.key]}</td>
                ))}
              </tr>
            ))}
            {shown.length === 0 && <tr><td colSpan={columns.length + 1} className="dim">Nothing matches.</td></tr>}
          </tbody>
          {totalKeys.length > 0 && (
            <tfoot>
              <tr className="k-subtotal">
                <th scope="row">Total of the {shown.length} shown</th>
                {columns.map((c) => <td key={c.key} className={c.numeric ? 'num' : ''}>{totalKeys.includes(c.key) ? <Amt v={totals[c.key]} /> : null}</td>)}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </>
  );
}
