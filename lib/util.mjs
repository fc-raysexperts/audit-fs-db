// Small shared helpers. No dependencies.

/** Zoho sends numbers, empty strings and nulls. Always return a finite number. */
export function num(x) {
  if (x === '' || x === null || x === undefined) return 0;
  const n = typeof x === 'number' ? x : Number(x);
  return Number.isFinite(n) ? n : 0;
}

/** Round to paise (2 decimals) - only for display / comparison, never inside sums. */
export function r2(x) {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

/** Indian digit grouping, e.g. 12,34,56,789.00 */
export function inr(x, decimals = 0) {
  const neg = x < 0;
  const s = Math.abs(x).toFixed(decimals);
  const [i, d] = s.split('.');
  let out;
  if (i.length <= 3) out = i;
  else out = i.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + i.slice(-3);
  return (neg ? '-' : '') + out + (d ? '.' + d : '');
}
