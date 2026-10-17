'use client';
import { useEffect, useState } from 'react';

const UNITS = [['rupee', 'Rupees'], ['lakh', 'Lakhs'], ['crore', 'Crores']];

/** Chooses how amounts are shown. The choice is kept in this browser only. */
export default function UnitSwitch() {
  const [unit, setUnit] = useState('rupee');
  useEffect(() => { setUnit(document.documentElement.dataset.unit || 'rupee'); }, []);
  function pick(u) {
    setUnit(u);
    document.documentElement.dataset.unit = u;
    try { localStorage.setItem('afs-unit', u); } catch { /* private window: the choice just is not remembered */ }
  }
  return (
    <div>
      <p className="rail-group-label" id="unit-label">Show amounts in</p>
      <div className="seg" role="group" aria-labelledby="unit-label">
        {UNITS.map(([u, label]) => (
          <button key={u} type="button" aria-pressed={unit === u} onClick={() => pick(u)}>{label}</button>
        ))}
      </div>
    </div>
  );
}
