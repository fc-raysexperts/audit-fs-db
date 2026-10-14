# RPEL FS Dashboard

Live financial statements (Balance Sheet, P&L) for **Rays Power Experts Ltd.**, rebuilt from the Zoho Books
**Trial Balance** the same way the auditors do, and reconciled line by line against the audited FY 2025-26 statements.

> Keep this repository **private** - it contains customer-level balances and company financials.

## Status

| Step | What | State |
|---|---|---|
| 1 | Map Zoho accounts to FS lines + reconcile with audited FY26 | **done** - 42 lines tie within Rs 5 |
| 2 | Party-level layer (trade payables incl. MSME, supplier advances, retention, outstanding expenses) | next |
| 3 | Zoho API credentials + live fetch (TB, AR/AP aging) | not started |
| 4 | Redis daily cache + start-of-day pre-warm | not started |
| 5 | Front end, localhost test, git, Vercel | not started |

## Run the Step-1 check

```
npm run reconcile      # prints every line: from Zoho TB | audited | difference | OK / CHECK / PHASE2
npm test               # unit tests + the full FY26 pipeline test (needs fixtures/)
```
Node 20+, no dependencies.

## How it works

```
Zoho TB report ─► lib/tb.mjs ─► accounts ─► lib/mapping.mjs (config/mapping.json) ─► buckets ─► lib/fsEngine.mjs ─► FS lines
Zoho AR aging  ─► lib/receivables.mjs (+ config/overrides.fy26.json) ──────────────────────────┘
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
* **Layer 2** (not built): trade payables, advances to suppliers, retention, outstanding expenses need party-level data. Until then the
  engine shows the Trial Balance's own figure, flagged `PHASE2`, and checks that the *net* of the whole group ties (it does, within Rs 1).

## Data safety

`fixtures/` (raw Zoho responses) and `reports/` are git-ignored. `.env` (Zoho and Redis secrets) is git-ignored; copy `.env.example`.
