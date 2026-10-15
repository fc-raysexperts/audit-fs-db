# audit-fs-db — RPEL audited-FS live dashboard

Live financial statements (Balance Sheet, P&L) for **Rays Power Experts Ltd.**, rebuilt from the Zoho Books
**Trial Balance** the same way the auditors do, and reconciled line by line against the audited FY 2025-26 statements.

> Keep this repository **private** - it contains customer-level balances and company financials.

## Status

| Step | What | State |
|---|---|---|
| 1 | Map Zoho accounts to FS lines + reconcile with audited FY26 | **done** |
| 2 | Party-level layer (trade payables incl. MSME, supplier advances, retention, outstanding expenses) | **done** - all 47 lines tie within Rs 5 |
| 3 | Zoho API credentials + live fetch (TB, AR aging, ledger, journals, staff list) | built and tested on replayed data; **first live run pending** (`npm run live`) |
| 4 | Redis daily cache (Upstash) | built and tested with a fake Redis; first real write pending; the morning pre-warm job comes with the web layer |
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

## Live run and cache (`npm run live`)

```
npm run live                    # Redis self-test -> pull from Zoho -> build -> all checks -> compare with audited -> save to Redis -> read back
npm run live -- --no-save       # same, without saving
npm run live -- --from-cache    # show what Redis holds (no Zoho call)
```
* `lib/zohoData.mjs` - one function per Zoho report (TB, AR aging, ledger limited to the party accounts, journals, vendor group). Every answer is checked
  (dates, account filter really applied, all pages present) so a wrong guess about an undocumented parameter stops the run instead of giving wrong numbers.
* `lib/snapshot.mjs` - `buildSnapshot()` makes the whole plain-JSON snapshot (statements, receivables, suppliers, checks, alerts, audited comparison);
  `refreshSnapshot()` adds a lock so two refreshes never run together.
* `lib/cache.mjs` - Upstash over its REST address. **The database is shared with the MIS dashboard**: only GET/SET/DEL/TTL are possible and every key must
  start with `audit-fs:`. Keys: `snapshot:<org>:<fy>:<India date>` (7 days), `latest:<org>:<fy>` (pointer to the newest good one), `ztoken:<org>`
  (Zoho access token, shared between serverless runs), `journal:<org>:<id>` (12 h), `lock:<org>:refresh`. Large values are gzip-compressed and cut into
  parts under 600 KB (the free plan limits one request to about 1 MB).
* A cached journal that no longer agrees with the ledger (someone edited it in Zoho) is detected and read again automatically.
* Typical cost of one refresh: 1 TB + 1 aging + 8 ledger pages + 1 staff list + one call per merged journal (38 on the first run, then served from Redis for 12 h).
* Settings that are not secrets live in `config/settings.json` (start of the books, the known party accounts).

## Zoho credentials (read-only Self Client)

1. api-console.zoho.in -> Self Client -> copy Client ID + Client Secret into `.env` (copy `.env.example` first).
2. Generate Code with scopes `ZohoBooks.reports.READ,ZohoBooks.contacts.READ,ZohoBooks.accountants.READ,ZohoBooks.settings.READ` (10 minutes).
3. `npm run zoho:token` (paste the code) -> saves ZOHO_REFRESH_TOKEN into `.env`.
4. `npm run zoho:check` -> PASS/FAIL per endpoint, plus a comparison of the live FY26 Trial Balance with the saved snapshot.

`lib/zoho.mjs` caches the 1-hour access token (Zoho allows only 10 new tokens per 10 minutes per refresh token), backs off on HTTP 429
and never prints secrets. The Reports endpoints are not in Zoho's public docs. Confirmed live on 15-Oct-2026 with the read-only scope list above: `/reports/trialbalance`, `/reports/metadata`, `/reports/generalledgerdetails`, `/reports/aragingsummary`, `/reports/apagingsummary` and the vendor-group filter (`/vendors?cf_vendor_group=...`) work (plus contacts, chartofaccounts, journals). Not yet confirmed live: the `rule` filter and the date parameter of the ledger / aging reports, and `/journals/{id}` - `npm run live` checks them.
Zoho's API quota (100 calls/min, plan-based daily limit) is shared by every app using the organization.

## Data safety

`fixtures/` (raw Zoho responses) and `reports/` are git-ignored. `.env` (Zoho and Redis secrets) is git-ignored; copy `.env.example`.
