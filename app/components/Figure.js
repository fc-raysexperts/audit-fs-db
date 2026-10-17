import Amt from './Amt';
import { plain } from '../../lib/format.mjs';

/** A number in the right form for what it is: rupees follow the unit switch; ratios, days, per-share and share counts do not. */
export default function Figure({ v, unit = 'rupees' }) {
  if (v === null || v === undefined || Number.isNaN(v)) return <span className="dim">–</span>;
  if (unit === 'rupees') return <Amt v={v} />;
  return <>{plain(v, unit)}</>;
}
