import { gap } from '../../lib/format.mjs';

/** A small mark: this line agrees with the audited statements (tick) or does not (cross). */
export default function Tie({ status, diff, unit = 'rupees' }) {
  if (!status) return null;
  const ok = status === 'OK';
  const d = diff === null || diff === undefined ? '' : ` (difference ${gap(diff)}${unit === 'rupees' ? ' rupees' : ''})`;
  const label = ok ? `Agrees with the audited figure${d}` : `Does not agree with the audited figure${d}`;
  return (
    <span className={`tie ${ok ? 'ok' : 'bad'}`} role="img" aria-label={label} title={label}>
      {ok ? (
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.2 6.4 4.8 9 9.8 3.2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3 3 9" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
      )}
    </span>
  );
}
