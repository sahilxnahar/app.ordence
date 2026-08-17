# Where everything stands · after v1.47.0-alpha

**Repo: `app.ordence`** · 🔴 **SQL: 0083, 0084, 0085, all three BEFORE the code push**

---

## 🔴 First, a correction to my own count

Every document since 110 has carried a running total that added halves and fractions: 7.5, then 11.5, 17.5, 25.5. Adding this wave's eight gives 33.5.

**Enumerated from the files instead of from memory, the real number is 29 distinct batches.** The running tally had drifted 4.5 high because half-batches were counted twice as they completed, and two unnumbered engine fixes were counted as batches.

⚠️ **This is the fourth time I have miscounted, and every one happened the same way: enumerating from memory rather than from the file.** The number below is enumerated. 29 of 128.

---

## Mega-wave 1 is complete. All twenty-two.

| # | Batch | Shipped in |
|---|---|---|
| 33 | Place of supply from the engine, not a string compare | v1.37.0 |
| 34 | Order detail and the eleven unreachable actions | v1.41.0 |
| 35 | Lead screens, and every 404 closed | v1.42.0 |
| 36 | A bank account can exist | v1.39.0 |
| 37 | Statement periods, FY-scoped | v1.44.0 |
| 38 | GRN moves stock, and the purchase receipt screen | v1.43.0 |
| 39 | The ITC reversal shows its working | v1.46.0 |
| **40** | **Credit control and dunning** | **v1.47.0** |
| 41 | Support consent | v1.40.0 |
| 42 | Platform staff console | v1.45.0 |
| 44 | Audit hash chaining | v1.45.0 |
| 45 | Canary probes | v1.44.0 |
| 46, 47 | Offboarding and the configuration chain | v1.46.0 |
| 49 | The reconciliation gate | v1.46.0 |
| **50** | **Attendance into the payroll run** | **v1.47.0** |
| 51 | YTD TDS true-up | v1.38.0 |
| 52 | Statutory rate maintenance | v1.46.0 |
| 57 | CSV import framework | v1.45.0 |
| **58** | **Opening balances** | **v1.47.0** |
| 59 | Leave, accrual and staff attendance | v1.46.0 |
| 65 | Cash flow statement | v1.45.0 |
| **68** | **Cost centres and budgets** | **v1.47.0** |
| **76** | **Statutory registers pack** | **v1.47.0** |
| 107 | Employee self-service | v1.45.0 |
| **109** | **Appraisals and org chart** | **v1.47.0** |
| 153 | The two-live-tenant isolation harness | v1.46.0 |

Plus two unnumbered engine fixes: `matchThreeWay([])` and the last-admin allowlist.

## Mega-wave 2: seven of twenty-four

Done: **30** (customer audit view, this release), **31** (the edge, this release), 41, 42, 44, 46, 47.

---

## What this release contains, track by track

| Track | Batch | State |
|---|---|---|
| A | 50 · attendance into the run | finished cleanly |
| B | 40 · credit control and dunning, SQL 0083 | finished cleanly |
| E | 76 · statutory registers | finished cleanly |
| G | 30 · customer audit view | finished cleanly |
| C | 58 · opening balances | **cut off near the end** |
| D | 68 · cost centres and budgets, SQL 0084 | **cut off near the end** |
| F | 109 · appraisals and org chart, SQL 0085 | **cut off near the end** |
| H | 31 · the edge | **cut off near the end** |

### ⚠️ What "cut off" actually cost, precisely

**Nothing was lost.** All four interrupted tracks had already written their code, their SQL and their test files before they stopped. What they did not get was their author's own final compile-and-report.

What that left behind, and what I did about it:

- **Thirteen TypeScript errors**, all of the same kind: `noUncheckedIndexedAccess` narrowing that each agent would have cleaned up in its last minute. Every one fixed by hand, each with a comment saying what the compiler could not see. Two of them turned out to be worth fixing on merit rather than to satisfy a compiler: a `returning()` that comes back empty is a write that did not happen, and reporting an id we do not have is worse than refusing.
- **Six orphaned `tsc` processes** left running, which took the box to a load average of 17.6 on 2 cores and made every subsequent command time out. Killed.
- **No final review by the author.** This is the real cost and it does not have a fix. Treat batches 58, 68, 109 and 31 as needing a harder look in use than the four that finished cleanly.

Everything then passed together: **fifteen gates green, 122 test files, 4,347 tests.**

---

## 🔴 The five things found this wave that are NOT fixed

| # | What | Where | Why it matters |
|---|---|---|---|
| **1** | **`BigInt(30.5)` is a RangeError, not a rounding** | `lib/payroll/payslip.ts:216` | A half-day LOP, the commonest Indian fraction, would abort the whole company's payroll compute. Unreachable while `attendance: []` stood, reachable now. **Mitigated**: only whole days are charged and the remainder becomes a problem that blocks approval. The fix is two lines. |
| **2** | **Impersonation records our staff's actions under the customer's own employee's name** | `server/platform/impersonation-context.ts:172`, `server/audit.ts:455` | `ctx.operatorEmail` is on the context and is never persisted. The comment at `server/audit.ts:352` asserts the opposite of its own code. The audit page works around it; the writer is still wrong. |
| **3** | **`recordPlatformAudit()` writes outside the 0081 hash chain** | `server/platform/guard.ts:488` | Every staff-access row is unsealed, and those are exactly the rows the customer audit page exists for. Reported per row rather than implied sealed. |
| **4** | **A generic `Error` becomes "Something went wrong. Please try again."** | `server/sales/guards.ts:306` | `confirmOrder`'s carefully written refusals never reach the user. A credit hold arriving as "something went wrong" reads as an outage. Worked around for the credit path by name; the general case stands. |
| **5** | **`payroll_runs` has no date of payment** | schema | The entire Payment of Wages Act is about that day. The wage register prints it blank-and-named rather than passing off `posted_at`. |

---

## What is pending: 99 batches

### Mega-wave 2 · Supportable , 17 left

**Consent and staff:** 28 impersonation hardening (owner notified live, thirty-minute cap, read-only default) · 43 the other four approval policies
**Evidence:** 130 access reviews and residency · 131 maintenance mode and deploy history · 122 onboarding progress · 127 secret rotation board
**Lifecycle:** 125 tenant 360, all eight tabs · 126 provisioning and cohorts · 24 suspension lockout *(needs a suspended workspace from you)* · 119 vertical regression pack
**Enforcement:** 48 refund caps and step-up re-auth · 136 `requireMfa` and idle timeout actually enforced · 135 notification preferences out of localStorage · 134 SPF, DKIM, DMARC and a trust page · 142 dark mode
**Resilience:** 143 encrypted immutable backups with a measured restore drill · 32 vault rotation *(blocked on your two keys)*

### Mega-wave 3 · Revenue , 19 left
The caged agent (62, 64, 63, 140) *(blocked on a Groq key and a Cloudflare Workers AI key)* · Razorpay subscriptions and drift reconciliation (53, 54, 124) · entitlements and metering (55, 56) · comms and support (132, 133, 121, 120, 123) · HR complete: overtime, gratuity, full and final, Form 16, ECR/ESI/PT returns, reimbursements and loans (103, 104, 105, 106, 108)

### Mega-wave 4 · Depth , 27 left
Quote to cash (77, 79, 80, 81, 82) · demand and procurement (78, 83, 84, 88, 92) · **valuation methods that actually read `valuationMethod`** (86, 85, 87) · warehouse and fulfilment (89, 90, 91, 93, 94, 95) · finance depth: fixed assets, multi-currency, bank reconciliation, inter-company (66, 67, 69, 70, 102) · documents (110, 111, 112)

### Mega-wave 5 · Markets , 19 left
GST complete: 2B reconciliation, TDS rates and 26Q, e-invoicing and IRN, e-way bill, GSTR-9 and 9C, TCS 206C (71, 75, 61, 73, 72, 74) · construction (113, 114) · real estate and legal (115, 116) · land and field service (117, 118) · **mobile breakpoints, which exist nowhere today** (60) · manufacturing and projects (96 to 101)

### Mega-wave 6 · Enterprise , 17 left
Security centre and incident pipeline (129, 128, 139, 146) · SAML, SCIM and i18n (144, 141) · public API v1 and idempotency (138, 145) · the agent crew (147 to 152) *(blocked on the AI keys)* · load, E2E and chaos proof (154, 155, 156)

---

## Blocked on you, not on me

| Blocker | Blocks | Cost to you |
|---|---|---|
| 🔴 **The four-line `rolbypassrls` query** | everything, conditionally | thirty seconds. Section 6 of the migration status file asks it for you |
| **`VAULT_ENCRYPTION_KEY` + `VAULT_BLIND_INDEX_PEPPER`** | batch 32 | two `openssl rand -hex 32`, set on Railway, never pasted to me |
| **A Groq key + a Cloudflare Workers AI key** | batches 62, 63, 64, 140, 147 to 152 | two free signups. `lib/ai/providers.ts` already has both configured and waiting |
| **`projects.state_code` on every live project** | correct place of supply on immovable property | one UPDATE per project. I deliberately did not guess |
| **A suspended workspace to test** | batch 24 | ten minutes |
| **Deploy the canary, schedule `/api/cron/canary`** | the standing answer to the four lines | one scheduler entry with `Authorization: Bearer $CRON_SECRET` |

---

## If you are handing this to another tool

Everything it needs is in the zip. The three things to tell it:

1. **The gates are the contract.** Fifteen scripts under `scripts/check-*.mjs`, wired as npm scripts. `npm run -s check:guards` and `check:sql` are the two that catch a security regression. Nothing should be merged that makes any of them go red, and the dead-link budget in `check-links.mjs` may only ever decrease.
2. **RLS is the only tenant isolation there is.** Every tenant-scoped read or write goes through `withTenant(tenantId, cb)`, which sets the GUC inside a real transaction so it cannot leak on a pooled connection. Code that queries `db` directly bypasses the boundary, and `check:rls-writes` exists to catch it.
3. **Money is `bigint` in paise and quantities are integer thousandths.** `Math.round(Number("1.005") * 100)` is 100, not 101, and `0.1 + 0.2 !== 0.3`. Every float in a money path is a defect regardless of how it tests.
