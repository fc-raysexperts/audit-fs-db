import { getView } from '../lib/data';
import gate from '../components/Gate';
import Banner from '../components/Banner';
import PageHead from '../components/PageHead';
import PartyTable from '../components/PartyTable';
import Amt, { UnitName } from '../components/Amt';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Customers and suppliers - RPEL' };

const CLASS = {
  trade_payable: 'Trade payable',
  trade_payable_msme: 'Trade payable, micro and small',
  advance: 'Advance to supplier or party',
  retention: 'Retention money payable',
  outstanding: 'Outstanding expense',
  imprest: 'Outstanding expense, staff imprest',
};

export default async function Parties() {
  const view = await getView();
  const blocked = gate(view);
  if (blocked) return blocked;
  const { receivables: rc, suppliers: sp } = view.snapshot;

  const customers = rc.customers.map((c) => ({
    id: c.id, name: c.name, zb: c.zb_total, adj: c.adjustment, rec: c.receivable, netted: Boolean(c.adjustment),
  }));
  const parties = sp.parties.map((p) => ({
    id: p.id, name: p.name, cls: p.class, clsLabel: CLASS[p.class] ?? p.class, net: p.net, amount: p.amount,
    note: p.grossUp ? 'Shown gross by the auditors, with the matching amount in payables' : '',
  }));
  const t = sp.totals;

  return (
    <>
      <Banner view={view} />
      <PageHead title="Customers and suppliers">
        The people and companies behind the receivable, payable and advance lines. Amounts in <UnitName />. Brackets are credit balances.
      </PageHead>

      <section className="sheet" aria-label="Customers" id="customers">
        <div className="sheet-title"><h2>Customers: trade receivables</h2><small>{customers.length} customers in Zoho Books</small></div>
        <div className="cards">
          <div><div className="k">Trade receivables on the balance sheet</div><div className="n"><Amt v={rc.total} /></div></div>
          <div><div className="k">Advance from customers</div><div className="n"><Amt v={rc.advanceFromCustomers} /></div></div>
          <div><div className="k">Customers the auditors netted by hand</div><div className="n">{customers.filter((c) => c.netted).length}</div></div>
        </div>
        <PartyTable
          nameLabel="Customer"
          rows={customers}
          columns={[
            { key: 'zb', label: 'Balance in Zoho Books', numeric: true },
            { key: 'adj', label: "Auditors' netting of advances", numeric: true },
            { key: 'rec', label: 'On the balance sheet', numeric: true },
          ]}
          check={{ key: 'netted', label: 'Only customers the auditors netted' }}
          totalKeys={['zb', 'adj', 'rec']}
        />
        <p className="tbl-note">A customer with an advance and an invoice open at the same time is shown net by the auditors. {rc.overridesApplied ? 'The netting list is the auditors’ own for 31 March 2026.' : 'No netting list applies to this date, so Zoho Books balances are shown as they are.'}</p>
      </section>

      <section className="sheet" aria-label="Suppliers" id="suppliers">
        <div className="sheet-title"><h2>Suppliers and other parties</h2><small>{parties.length} parties with a balance</small></div>
        <div className="cards">
          <div><div className="k">Trade payables, micro and small</div><div className="n"><Amt v={t.tpMsme} /></div></div>
          <div><div className="k">Trade payables, others</div><div className="n"><Amt v={t.tpOthers} /></div></div>
          <div><div className="k">Advances to suppliers and others</div><div className="n"><Amt v={t.advance} /></div></div>
          <div><div className="k">Retention money payable</div><div className="n"><Amt v={t.retention} /></div></div>
          <div><div className="k">Outstanding expenses</div><div className="n"><Amt v={t.outstanding + t.imprest} /></div></div>
        </div>
        <PartyTable
          nameLabel="Party"
          rows={parties}
          columns={[
            { key: 'clsLabel', label: 'Shown under' },
            { key: 'net', label: 'Net balance in the ledger', numeric: true },
            { key: 'amount', label: 'Amount on the statement', numeric: true },
          ]}
          select={{ key: 'cls', label: 'Shown under', options: Object.entries(CLASS) }}
        />
        <p className="tbl-note">Each party’s ledger lines are netted. A net credit is a payable, a net debit is an advance. Staff with a credit balance sit in outstanding expenses (imprest).</p>
      </section>
    </>
  );
}
