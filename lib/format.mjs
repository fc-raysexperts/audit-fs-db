// Number and date formatting for the screens. Indian digit grouping (4,03,54,35,704), whole rupees by default.
// Pure functions: usable on the server and in the browser.

export const UNITS = {
  rupee: { label: 'Rupees', short: '₹', divisor: 1, digits: 0 },
  lakh: { label: 'Lakhs', short: '₹ lakh', divisor: 1e5, digits: 2 },
  crore: { label: 'Crores', short: '₹ crore', divisor: 1e7, digits: 2 },
};

const nf = (digits) => new Intl.NumberFormat('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const cache = {};
const fmt = (digits) => (cache[digits] ??= nf(digits));

/**
 * 4035435703.6 -> "4,03,54,35,704"; -24471339 -> "(2,44,71,339)"; 0 -> "–" (the audited statements show a dash for nil).
 * Negative figures are shown in brackets, as in the audited statements. A figure that rounds to zero in the chosen unit is a dash.
 */
export function inr(value, unit = 'rupee', { dash = true } = {}) {
  if (value === null || value === undefined || Number.isNaN(value)) return '';
  const u = UNITS[unit] ?? UNITS.rupee;
  const scaled = value / u.divisor;
  const rounded = Number(scaled.toFixed(u.digits));
  if (rounded === 0) return dash ? '–' : fmt(u.digits).format(0);
  const text = fmt(u.digits).format(Math.abs(rounded));
  return rounded < 0 ? `(${text})` : text;
}

/** A rupee difference to the paisa: 4.28 -> "4.28", -0.4 -> "-0.40" (used for reconciliation gaps, not for statements). */
export const gap = (value) => (value === null || value === undefined ? '' : (Math.abs(value) < 0.005 ? '0.00' : value.toFixed(2)));

const IST = { timeZone: 'Asia/Kolkata' };
/** "15 Oct 2026, 6:30 am" in India time. */
export function istStamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const date = d.toLocaleDateString('en-GB', { ...IST, day: 'numeric', month: 'short', year: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { ...IST, hour: 'numeric', minute: '2-digit' }).toLowerCase();
  return `${date}, ${time}`;
}

/** "2026-03-31" -> "31 March 2026" */
export function longDate(ymd) {
  if (!ymd) return '';
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' });
}

/** "2025-26" -> "FY 2025-26" and the year before: "FY 2024-25". */
export const fyLabel = (fy) => `FY ${fy}`;
export function previousFy(fy) {
  const y = Number(fy.slice(0, 4)) - 1;
  return `${y}-${String(y + 1).slice(-2)}`;
}

/** "3 min ago", "2 h ago", "yesterday" - relative to `nowMs`. */
export function ago(iso, nowMs = Date.now()) {
  if (!iso) return '';
  const s = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const days = Math.round(s / 86400);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/** Ratios, days, per-share and share-count figures, which are not rupee amounts: 1.79 | 42.14% | 52.79 | 5,385,500 */
export function plain(value, unit = 'times') {
  if (value === null || value === undefined || Number.isNaN(value)) return '';
  const two = (x) => new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(x);
  switch (unit) {
    case 'pct': return `${two(value)}%`;
    case 'fraction': return `${two(value * 100)}%`;
    case 'shares': return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(value);
    case 'eps': return two(value);
    default: return two(value); // times, days
  }
}

/** A change against last year as a signed percentage: 0.1226 -> "+12.26%". */
export const change = (fraction) => (fraction === null || fraction === undefined || !Number.isFinite(fraction) ? '' : `${fraction >= 0 ? '+' : '−'}${(Math.abs(fraction) * 100).toFixed(2)}%`);

/** A cell of an exported sheet: text stays text, a date is "31 Mar 2026", a whole number gets Indian grouping, a fraction keeps its decimals. */
export function cell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v.d) {
    const [y, m, d] = v.d.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) return String(v);
  const digits = Number.isInteger(v) ? 0 : Math.abs(v) >= 1 ? 2 : 4;
  const text = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: digits }).format(Math.abs(v));
  return v < 0 ? `(${text})` : text;
}
