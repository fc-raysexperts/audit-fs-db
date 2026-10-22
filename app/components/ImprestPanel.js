import Amt from './Amt';
import { longDate } from '../../lib/format.mjs';

// update-31: under the RPT Transaction sheet - the year on the imprest card of each person (from the ledger of the three imprest accounts in Zoho Books), beside the figure the sheet carries.
// Information only: where the sheet's figure is not one of Zoho's totals the panel says so and why; it never asks for a change in the books (they are audited and closed).

const SUB = { display: 'block', color: 'var(--muted)', fontSize: 13, lineHeight: 1.35 };
const RESULT = { OK: ['ok', 'Agrees'], EXPL: ['info', 'Explained'], DIFF: ['warn', 'Differs'], NONE: ['mute', 'Not checked'] };
const MAX_PAYMENTS = 40;

export default function ImprestPanel({ imprest, checks = [] }) {
  const people = imprest && !imprest.error ? Object.entries(imprest.people ?? {}) : [];
  if (!people.length) return null;
  const by = new Map(checks.map((c) => [c.id, c]));
  const signedOf = (key) => by.get(`imprest-${key}`) ?? null;
  const payments = people
    .flatMap(([key, p]) => p.payments.map((x) => ({ ...x, who: p.name, key })))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const noBalances = people.some(([, p]) => p.opening === null);

  const row = (label, f, { sub = null, strong = false, last = false } = {}) => (
    <tr className={last ? 'last' : ''} key={label}>
      <th scope="row" style={strong ? { fontWeight: 600 } : undefined}>
        {label}
        {sub && <span style={SUB}>{sub}</span>}
      </th>
      {people.map(([key, p]) => <td className="num" key={key} style={strong ? { fontWeight: 600 } : undefined}>{f(p, key)}</td>)}
    </tr>
  );

  return (
    <section className="sheet" aria-label="Imprest in the year">
      <div className="sheet-title"><h2>Imprest in the year, from the imprest accounts in Zoho Books</h2><small>1 April 2025 to 31 March 2026</small></div>
      <p className="proof">
        Each person has an imprest account in Zoho Books. The expenses booked on it are what the company owes the person; money handed over to the person takes it down, and money he gives back puts it up again.
        {' '}This is the year on each card, beside the figure that the sheet above carries in its Imprest column.
      </p>
      <div className="tablewrap">
        <table className="tbl-plain">
          <thead>
            <tr>
              <th scope="col">The imprest account</th>
              {people.map(([key, p]) => <th scope="col" className="num" key={key}>{p.name}</th>)}
            </tr>
          </thead>
          <tbody>
            {row('Owed to the person on 1 April 2025', (p) => <Amt v={p.opening} />)}
            {row('Expenses booked on the card during the year', (p) => <Amt v={p.spent} />, { sub: 'bills, expenses and journals for what the person paid on behalf of the company' })}
            {row('Money given back by the person', (p) => <Amt v={p.refunded} />)}
            {row('Imprest paid to the person (money handed over)', (p) => <Amt v={p.given} />)}
            {row('Moved to Sundry Creditors - Employees on 31 March 2026', (p) => <Amt v={p.transferred} />, { sub: 'the transfer journal that emptied the card' })}
            {row('Balance of the card on 31 March 2026', (p) => <Amt v={p.closing} />, { last: true })}
            {row('Imprest paid in the year, net of what was given back', (p) => <Amt v={p.net} />, { strong: true })}
            <tr>
              <th scope="row" style={{ fontWeight: 600 }}>Imprest in the year, as signed on the sheet</th>
              {people.map(([key]) => { const c = signedOf(key); return <td className="num" key={key} style={{ fontWeight: 600 }}>{c && c.signed !== null ? <Amt v={c.signed} /> : <span className="dim">–</span>}</td>; })}
            </tr>
            <tr>
              <th scope="row">Result</th>
              {people.map(([key]) => {
                const c = signedOf(key);
                const [cls, word] = c ? RESULT[c.status] ?? ['mute', c.status] : ['mute', 'Not checked'];
                return <td className="num" key={key}><span className={`chip ${cls}`}>{word}</span></td>;
              })}
            </tr>
          </tbody>
        </table>
      </div>

      {payments.length > 0 && (
        <>
          <h3 className="side-title">Money handed over and given back</h3>
          <div className="tablewrap">
            <table className="tbl-plain">
              <thead>
                <tr><th scope="col">Date</th><th scope="col">Person</th><th scope="col">Entry in Zoho</th><th scope="col">Paid from</th><th scope="col" className="num">Amount</th></tr>
              </thead>
              <tbody>
                {payments.slice(0, MAX_PAYMENTS).map((x, i) => (
                  <tr key={`${x.key}-${x.date}-${x.entry}-${i}`}>
                    <th scope="row" style={{ fontWeight: 500 }}>
                      {longDate(x.date)}
                      {x.kind === 'refunded' && <span style={SUB}>given back</span>}
                    </th>
                    <td>{x.who}</td>
                    <td>{x.entry || <span className="dim">–</span>}</td>
                    <td>{x.via}</td>
                    <td className="num"><Amt v={x.amount} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {payments.length > MAX_PAYMENTS && <p className="tbl-note">The first {MAX_PAYMENTS} of {payments.length} entries are shown.</p>}
        </>
      )}
      <p className="tbl-note">
        Where the sheet and Zoho give other amounts that is information, not an error: the books are closed and audited, so nothing is changed. The figure in the sheet's Imprest column is not one of the totals above; a note beside the table on the signed Note 28(A) sheet says that for imprest only the closing balance is reported, no transaction, and the balance of each card is checked under the payables.
        {noBalances && ' Zoho did not give the opening and closing balance of the cards in this snapshot, so the year\'s lines could not be checked against them.'}
      </p>
    </section>
  );
}
