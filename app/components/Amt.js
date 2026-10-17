import { inr } from '../../lib/format.mjs';

/** An amount in all three units; globals.css shows the one chosen in the side panel (rupees, lakhs or crores). */
/** With `words`, the unit is spelled out for use in a sentence: ₹2,38,23,95,030 | ₹23,823.95 lakh | ₹238.24 crore. */
export default function Amt({ v, dash = true, words = false }) {
  if (v === null || v === undefined || Number.isNaN(v)) return <span className="dim">–</span>;
  return (
    <>
      <span className="u-r">{words && '₹'}{inr(v, 'rupee', { dash })}</span>
      <span className="u-l">{words && '₹'}{inr(v, 'lakh', { dash })}{words && ' lakh'}</span>
      <span className="u-c">{words && '₹'}{inr(v, 'crore', { dash })}{words && ' crore'}</span>
    </>
  );
}

/** The name of the chosen unit, for sentences like "Amounts in rupees." */
export function UnitName() {
  return (
    <>
      <span className="u-r">rupees</span>
      <span className="u-l">₹ lakh</span>
      <span className="u-c">₹ crore</span>
    </>
  );
}
