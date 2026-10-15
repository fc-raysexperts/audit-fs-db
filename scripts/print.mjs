// Prints a statement report on the screen (used by `npm run reconcile` and `npm run live`).
import { inr } from '../lib/util.mjs';

const pad = (s, n) => String(s).padEnd(n).slice(0, n);
const amount = (x) => (x === null || x === undefined ? '-'.padStart(18) : inr(x, 0).padStart(18));
const SECTIONS = [['pl', 'PROFIT & LOSS'], ['bs', 'BALANCE SHEET - lines that tie to the Trial Balance'], ['party', 'PARTY-LEVEL LINES (suppliers, advances, retention, outstanding expenses)']];

/**
 * @param {{heading:string, rec:object|null, lines:object, checks:object[], alerts:object[]}} p
 *   rec = reconcile() output (audited comparison) or null when the date is not the audited one
 */
export function printReport({ heading, rec, lines, checks, alerts }) {
  console.log(heading);
  for (const [sec, title] of SECTIONS) {
    console.log(`\n== ${title}`);
    if (rec) {
      console.log(`${pad('line', 62)}${'from Zoho'.padStart(18)}${'audited'.padStart(18)}${'diff'.padStart(14)}  status`);
      for (const r of rec.rows.filter((x) => x.section === sec)) {
        const d = r.diff === null ? '-' : (Math.abs(r.diff) < 0.5 ? '0' : inr(r.diff, 0));
        console.log(`${pad(r.label, 62)}${amount(r.value)}${amount(r.audited)}${d.padStart(14)}  ${r.status}`);
      }
    } else {
      console.log(`${pad('line', 62)}${'from Zoho'.padStart(18)}`);
      for (const l of Object.values(lines).filter((x) => x.section === sec)) console.log(`${pad(l.label, 62)}${amount(l.value)}`);
    }
  }
  console.log('\n== CHECKS');
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.label}  (${c.value.toFixed(2)})`);
  console.log('\n== ALERTS');
  if (!alerts.length) console.log('none');
  for (const a of alerts) console.log(`${a.level.toUpperCase().padEnd(5)} ${a.code}: ${a.message}`);
  if (rec) {
    const s = rec.summary;
    console.log(`\nSummary: ${s.ok} lines tie (largest gap ${s.maxAbsDiffOk.toFixed(2)} rupees, tolerance ${rec.tolerance}), ${s.check} need checking, ${s.phase2} are Phase-2 lines, ${s.noref} have no audited counterpart`);
  } else {
    console.log('\nNo audited figures exist for this date, so there is nothing to compare with - the checks above are the control.');
  }
}
