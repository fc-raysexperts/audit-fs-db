# audit-fs-db — RPEL audited-FS live dashboard

Live financial statements (Balance Sheet, P&L) for **Rays Power Experts Ltd.**, rebuilt from the Zoho Books
**Trial Balance** the same way the auditors do, and reconciled line by line against the audited FY 2025-26 statements.

> Keep this repository **private** - it contains customer-level balances and company financials.

## Status

| Step | What | State |
|---|---|---|
| 1 | Map Zoho accounts to FS lines + reconcile with audited FY26 | **done** |
| 2 | Party-level layer (trade payables incl. MSME, supplier advances, retention, outstanding expenses) | **done** - all 47 lines tie within Rs 5 |
| 3 | Zoho API credentials + live fetch (TB, AR/AP aging) | not started |
| 4 | Redis daily cache + start-of-day pre-warm | not started |
| 5 | Front end, localhost test, git, Vercel | not started |

## Run the check

```
npm run reconcile      # prints every line: from Zoho TB | audited | difference | OK / CHECK / PHASE2
npm test               # unit tests + the full FY26 pipeline test (needs fixtures/)
```
Node 20+, no dependencies.

## How it works

```
Zoho TB report ─► lib/tb.mjs ─► accounts ─► lib/mapping.mjs (config/mapping.json) ─► buckets ─► lib/fsEngine.mjs ─► FS lines
Zoho AR aging  ─► lib/receivables.mjs (+ config/overrides.fy26.json) ──────────────────────────┤
Zoho ledger of the 11 party accounts ─► lib/gl.mjs ─► lib/vendors.mjs (+ config/party_rules.json,      │
   (+ get_journal for merged rows, Imprest Staff vendor group)        config/party_overrides.fy26.json) ┘
                                                                            lib/reconcile.mjs compares with config/audited.fy26.json
```

* **Buckets, not groups.** Every account goes to one bucket by *account code* (never by Zoho's group - e.g. the deferred-tax
  asset and the bank overdraft are filed under "Liabilities"/"Assets" the wrong way round in Zoho).
  Rules: `accountId > exact code > family`. A non-zero account nobody claims, or two buckets claiming one account, raises an alert.
* **Auditors' reclassifications** are built into `fsEngine.mjs`: freight inward and CHA/logistics go to purchases; stores consumption to
  operating expenses; net FX gain to other income; the debit side of Fines & Penalties to earlier-year tax; purchases = net material cost +
  change in stock; income-tax provision shown net of advance tax and TDS; overdraft with a debit balance is cash.
* **Manual inputs** the Trial Balance cannot show: `config/inputs.fy26.json` (current maturity of car loans, non-current FDs, non-current
  security deposit, the fines reclass). Re-enter these each year-end from the auditors' schedules.
* **Customer hand-netting** (`config/overrides.fy26.json`): the auditors netted 34 customers' advances against their invoices by hand.
  The list is valid only for the 31-Mar-2026 report and is skipped for any other date.
* **Supplier / party layer** (`lib/gl.mjs`, `lib/vendors.mjs`): the auditors show every party NET, so the ledger lines of the 11 party
  accounts are read per contact. Net credit = trade payable (MSME list -> MSME), net debit = advance to suppliers & others (loans and staff
  advances included). Staff (credit balance) go to Outstanding expenses (Imprest). Three kinds of rule, kept apart:
  1. standing rules - `config/party_rules.json` (who is staff, who is MSME);
  2. the auditors' FY26 judgments - `config/party_overrides.fy26.json` (Cyrun & Gurukripa -> retention, R. Mohnot -> outstanding, three
     people kept as payables not staff, two insurers shown gross). Valid for 31-Mar-2026 only, skipped (with an alert) for any other date;
  3. arithmetic - nothing year specific.
  Safety nets: every party account's ledger total must equal the Trial Balance; the placed amounts must equal the ledger net; the party group
  must equal the Trial Balance's own net; stale / missing override entries warn.
* **Zoho quirk handled**: when one journal posts several contacts to the same account, the ledger report merges them into one row and loses the
  per-contact amounts. `mergedTransactionIds()` lists the journals to fetch with `get_journal`; `expandMergedRows()` swaps in their own lines.
  A merged row that cannot be read is kept (so the account still ties) under "untagged" with an alert.

## Data safety

`fixtures/` (raw Zoho responses) and `reports/` are git-ignored. `.env` (Zoho and Redis secrets) is git-ignored; copy `.env.example`.
