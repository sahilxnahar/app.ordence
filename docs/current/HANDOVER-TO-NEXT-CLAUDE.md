# Ordence · handover to the next Claude

**Give this document to the new account first, before anything else, along with `ordence-v1.55.0-alpha.zip`.** It is written to be read cold, with no prior context.

---

# 0. What this is, in one paragraph

**Ordence** is a multi-tenant ERP and CRM for Indian SMBs , contractors, real-estate developers, manufacturers, traders. One owner, Sahil, no engineering team. The product is at **v1.55.0-alpha**: 275 tables, 90 SQL migrations, 128 test files, **4,467 passing tests**, and **fifteen automated gates** that must all stay green.

**Repo: `app.ordence`.** Next.js 15.5 App Router · TypeScript strict · Drizzle ORM · Neon PostgreSQL · Clerk auth · deployed to Railway from GitHub. A separate repo holds the marketing website `ordence.com`.

**Three hosts, one deployment:**

| Host | What it serves |
|---|---|
| `app.ordence.com` | the customer product |
| `<slug>.ordence.com` | tenant subdomains |
| `admin.ordence.com` | the staff console (Sahil only) |

---

# 1. 🔴 The five things that will bite you

Read these before writing a line. Every one has already cost something real.

### 1. RLS is the only tenant isolation there is

There is no `WHERE tenant_id = ?` safety net. PostgreSQL row level security is the whole boundary.

```ts
await withTenant(tenantId, async (tx) => { /* every tenant read and write */ });
await withPlatformScope("why you are reading across tenants", async (db) => { /* … */ });
```

Both set the GUC inside a real transaction so it cannot leak on a pooled connection. **Code that touches `db` directly bypasses the boundary.**

🔴 **Three ways RLS is silently bypassed, all three hit here:** a role with `rolbypassrls` (`neondb_owner` has it, `ordence_app` does not); a superuser regardless of `FORCE`; and **a table's owner is exempt from its own policies unless the table has `FORCE ROW LEVEL SECURITY`** , that one has no tell. Every new table gets `ENABLE` **and** `FORCE`.

### 2. `drizzle-kit push` is banned, in those words

It drops RLS policies on 275 tables. The npm script blocks it. **Nothing looks broken afterwards** , every table, every column, every query still works, and tenant isolation is simply gone. A previous agent reached for it to reseed a test database.

### 3. Money is `bigint` paise and never becomes a `Number`

```ts
Math.round(Number("1.005") * 100)   // 100, not 101
0.1 + 0.2 !== 0.3                   // why quantities are integer thousandths
BigInt(30.5)                        // RangeError, not a rounding
```

Display formatting is string surgery on the bigint. A float anywhere in a money path is a defect regardless of how it tests.

### 4. `"use server"` publishes every export to the internet

Every export in such a file is a browser-reachable RPC endpoint needing a tier-2 guard **one hop from the export** , `check:guards` walks exactly one hop. A screen that hides a button is a mistake guard, not a boundary; curl goes straight through it.

### 5. Two build-breaking classes that no test catches

Both shipped past every gate and broke production. Both now have their own gate.

- **A `route.ts` may export only HTTP verbs and Next's config fields.** Anything else is a build error enforced by types Next *generates* during `next build`, so `tsc` never sees it. → `check:route-exports`
- **A file without `"use client"` may not call a `use*` hook from a file with it.** This was in the root layout and returned **500 on every route in the product** while `/api/health` stayed 200 and the deploy looked healthy. → `check:client-hooks`

---

# 2. The fifteen gates are the contract

```
npx tsc --noEmit           npm run -s check:posting
npm run -s check:boundaries      npm run -s check:reachability
npm run -s check:guards          npm run -s check:tax-decisions
npm run -s check:migrations      npm run -s check:links
npm run -s check:sql             npm run -s check:tenant-isolation
npm run -s check:sql-executes    npm run -s check:route-exports
npm run -s check:rls-writes      npm run -s check:client-hooks
npm run -s check:console-links   npm run -s test:ui
```

**Nothing merges that turns any of them red.** They are readable Node scripts in `scripts/check-*.mjs`. If a gate is wrong, fix the gate and write down why in the gate's own comments. **Never make a check quiet by widening what it was written to narrow.**

⚠️ `check:links` carries a `KNOWN_DEAD_MAX` budget that **may only decrease**.

---

# 3. 🔴 THE ONE RULE THAT MATTERS MOST

> **Assert the outcome, never the shape.**

A previous agent produced three separate green reports that hid real defects:

| It shipped | It missed |
|---|---|
| a payroll "fix" that floored a half day | **underpaid every employee** with a half-day absence |
| a verifier that printed `policies OK` | **one tenant could read another tenant's rows** , the verifier checked the `WITH CHECK` clause and never the `USING` clause that caused the leak |
| "15/15 gates green" | one gate was red |

Every artifact looked like diligence. **None of them tried to break the thing.**

So: **a boundary is proven by trying to cross it, as the role that would cross it, and getting nothing back.** For anything touching RLS: create two tenants' rows, connect **as `ordence_app`** (never the owner, never a superuser , both bypass what you are testing), set tenant A's context, and assert the row count is exactly tenant A's. That is fifteen lines of SQL and it has found two real leaks.

And: **never report a check you did not run in that session.** If you say the gates are green, paste the output.

---

# 4. Where the work stands

**29 of 128 batches complete. Mega-wave 1 is finished.** The full enumerated list lives in `docs/current/122-WHERE-EVERYTHING-STANDS.md` in the zip.

⚠️ **Enumerate from the files, never from memory.** The running total was wrong four separate times, always the same way.

## Pending, by mega-wave

### Mega-wave 2 · Supportable , **17 left. Do this one next.**
This is the wave that makes the product operable by Sahil rather than merely usable by a customer.

- **Consent and staff:** 28 impersonation hardening (owner notified live, 30-minute cap, read-only default) · 43 the three unwired approval policies
- **Evidence:** 130 access reviews · 131 maintenance mode and deploy history · 122 onboarding progress · 127 secret rotation board
- **Lifecycle:** 125 tenant 360 (all eight tabs) · 126 provisioning and cohorts · 24 suspension lockout *(needs a suspended workspace)* · 119 vertical regression pack
- **Enforcement:** 48 refund caps and step-up re-auth · 136 `requireMfa` and idle timeout actually enforced · 135 notification preferences out of localStorage · 134 SPF/DKIM/DMARC and a trust page · 142 dark mode
- **Resilience:** 143 encrypted immutable backups with a measured restore drill · 32 vault rotation *(blocked on two keys)*

### Mega-wave 3 · Revenue , 19 left
The caged AI agent (62, 63, 64, 140) *(blocked on API keys)* · Razorpay subscriptions and drift reconciliation (53, 54, 124) · entitlements and metering (55, 56) · comms and support (132, 133, 121, 120, 123) · HR complete: overtime, gratuity, full and final, Form 16, ECR/ESI/PT returns, reimbursements and loans (103–108)

### Mega-wave 4 · Depth , 27 left
Quote to cash (77, 79–82) · procurement (78, 83, 84, 88, 92) · **valuation methods that actually read `valuationMethod`, which nothing reads today** (85, 86, 87) · warehouse and fulfilment (89–95) · fixed assets, multi-currency, bank reconciliation, inter-company (66, 67, 69, 70, 102) · documents (110–112)

### Mega-wave 5 · Markets , 19 left
GST complete: 2B reconciliation, TDS rates and 26Q, e-invoicing and IRN, e-way bill, GSTR-9/9C, TCS 206C (61, 71–75) · construction (113, 114) · real estate and legal (115, 116) · land and field service (117, 118) · **mobile breakpoints, which exist nowhere today** (60) · manufacturing (96–101)

### Mega-wave 6 · Enterprise , 17 left
Security centre and incidents (128, 129, 139, 146) · SAML, SCIM, i18n (141, 144) · public API v1 and idempotency (138, 145) · the agent crew (147–152) *(blocked on API keys)* · load, E2E and chaos proof (154–156)

---

# 5. What to build in the admin console

**`admin.ordence.com` works as of v1.55.0.** Do not "fix" it before checking , the last two sessions were spent on two real defects there, both now closed:

- every page 500'd (a client hook called from the root layout)
- every link 404'd (the console is served at two base paths and links assumed one)

⚠️ **The console is served at `/platform/x` on `app.` and at `/x` on `admin.`** because middleware rewrites. **All console links must go through `consoleHref()`** in `lib/platform/console-href.ts`. `check:console-links` enforces this. In a client component use a **relative** href , it cannot read the host.

Seventeen console pages already exist and are reachable. What is genuinely missing, in the order I would build it:

| Batch | What | Why |
|---|---|---|
| **125** | **Tenant 360, all eight tabs** , overview, activity, billing, entitlements, usage, support, data, audit | `/platform/tenants/[id]` exists but is not the full picture. This is the screen you would live in. |
| **122** | **Onboarding progress** | You cannot see which new workspace stalled on day two, while it can still be rescued. |
| **131** | **Maintenance mode and deploy history** | Take payroll offline for an hour without taking the product offline. |
| **130** | **Access reviews** | A monthly pass over every impersonation, break-glass and staff grant, recorded as evidence. |
| **127** | **Secret rotation board** | Metadata only, never a value. All secrets under ninety days. |
| **126** | **Provisioning and cohorts** | Under thirty seconds, saved segments, rate-limited bulk actions. |
| **28** | **Impersonation hardening** | Owner notified live, 30-minute cap enforced server-side per request, read-only by default, second approval for writes. |
| **43** | **The three unwired approval policies** | `impersonate.break_glass`, `staff.elevate`, `tenant.plan_change` are declared and enforced by nothing. A decorative control is worse than none. |

**Console design principles:** three people use it. It should be the plainest of the three surfaces , dense, fast, no marketing polish. Everything one search away. Every destructive action shows who approved it and when. **Never show a customer's business data unless the reason is recorded**; the consent machinery exists, and the UI should make using it the easy path.

---

# 6. The UI work

Two documents in the zip carry the full brief: **`docs/current/UI-BRIEF-FOR-MANUS.md`** (the spec) and **`docs/current/DESIGN-DIRECTION-VERDICT.md`** (the chosen direction). Read both. The essentials:

## The users

1. **The owner**, 45, contracting or real estate, ₹8–80 crore turnover. On a phone, twice a day, to approve something or ask where his money is.
2. **The accountant.** The heaviest user. Wants **density, keyboard, no surprises**. Came from Tally and Tally is fast.
3. **The site engineer.** Dusty site, one bar, gloves off for thirty seconds. Three fields and a big button.
4. **The HR person.** Runs payroll monthly and is terrified of getting it wrong.
5. **The auditor.** Turns up once a year and needs evidence, not a dashboard.

⚠️ **2 and 3 want opposite things.** Resolve by surface , dense tables on desktop, three-field forms on mobile , never by compromise.

## Non-negotiables, because they are domain facts

- **`₹12,34,567`**, Indian lakh/crore grouping. Never `₹1,234,567`. Never `Rs.` or `INR`.
- **`12 Aug 2026`**, never `MM/DD`. Everything Asia/Kolkata, never `toISOString()`.
- **FY 2026-27**, 1 April to 31 March. Never calendar year.
- **Right-align money, tabular numerals, unit in the header once.**
- Use the statutory words: GSTIN, HSN, TDS, PF, ESI, PT, RA bill, retention, muster roll, challan, GRN, godown. **Never invent a synonym for a statutory term.**
- Base font 14px, rows 36–40px. **This is an ERP, not a marketing site.**

## The four states every screen needs

Loading (skeleton) · Empty (what this is for + the one button) · Error (**the server's own words, verbatim**) · and:

🔴 **Refused.** Some screens deliberately show **no number** when two independent computations disagree (`lib/reconciliation/gate.ts`, `lib/accounting/cash-flow.ts`). **Do not design this away.** Do not show the probably-right figure with an asterisk. A correct number under a heading that just failed its own check reads as verification.

## Priorities, in order

1. **Audit which of the 31 UX items are actually shipped and wired** versus declared and dead. Several were reported shipped; one took the whole product down. Establish truth first.
2. The four states on every existing screen.
3. Money, date and number formatting, one helper, applied everywhere.
4. Table quality: sticky headers, URL-persisted filters, real row counts.
5. Mobile: four flows only , approve, record a GRN, look up a balance, mark attendance.
6. Keyboard and accessibility.
7. `ordence.com` rebuild (separate repo, can run in parallel).

**Chosen direction: "Midnight Command", with three changes** , ship it **light-first** with dark as a preference (sunlight, eight-hour numeric reading, printing); design at **high-signal density**; violet is brand and selection, **not the primary action colour on a money screen**.

---

# 7. What Sahil must do , the owner queue

| | What | Blocks |
|---|---|---|
| 🔴 | **Deploy v1.55.0-alpha** | the console being usable at all |
| 🔴 | **Run SQL `0086` → `0090`**, in order, before the code push. `SQL-FILES/CHECK-EVERYTHING-neon-safe.sql` says exactly which are outstanding. | the leave, credit, budget and appraisal screens |
| 🔴 | **The four lines**, unanswered for eight sessions | conditionally everything |
| | `VAULT_ENCRYPTION_KEY` + `VAULT_BLIND_INDEX_PEPPER` (`openssl rand -hex 32`, set on Railway, **never pasted to Claude**) | batch 32 |
| | A Groq key and a Cloudflare Workers AI key | 11 batches |
| | `UPSTASH_REDIS_REST_URL` + `_TOKEN` | the rate limiter is a speed bump without them |
| | `projects.state_code` on every live project | correct place of supply on immovable property |
| | A suspended workspace to test | batch 24 |

```sql
SELECT current_user, rolsuper, rolbypassrls
  FROM pg_roles WHERE rolname = current_user;
```

---

# 8. Migrations

Numbered SQL files in `SQL-FILES/`, run by a human. **There is no migrations ledger table.** Next free number is **0091**. Retired: 0062, 0072, 0076 , `check:migrations` refuses them.

Every migration ships **three** files: the migration (one transaction, every statement guarded, re-runnable), a read-only `VERIFY-00NN-neon-safe.sql`, and a `DRILL-DO-NOT-RUN-IN-NEON-00NN.sql`.

🔴 **The drill name is the warning and it is not decoration.** Same for `scripts/harness/*.sql` and `HARNESS_DATABASE_URL`.

**Every migration header states BEFORE or AFTER the code push, and why.** Both are correct in different cases. *After* is right when the migration adds CHECK constraints that refuse rows the **old** code produces (0080). *Before* is urgent when the failure would be **silent** , 0083 reads credit-hold tables on every order confirmation, and code-first would degrade the gate to "no hold row found, therefore no hold".

⚠️ **Two read-only files are safe on production and worth knowing:** `CHECK-EVERYTHING-neon-safe.sql` (migration status, what to run, gaps, tenant isolation, connection flags , five tabs, one query each) and `RLS-CENSUS-neon-safe.sql`. Both are pure SQL with **no psql meta-commands**, because the Neon editor is not psql , `\echo` broke an earlier verifier, and `RAISE NOTICE` output is invisible in that editor, which is worse.

---

# 9. How to work

**The unit is a wave: eight file-disjoint tracks built in parallel by subagents, then one integration pass by you.** Each subagent owns a disjoint file list and returns; you compile, run all fifteen gates, run the suite, resolve collisions, bump the version, package, and write the deploy document. This produced eight batches per run in v1.46 and v1.47.

**Every wave delivers four things:** the zip, the SQL with VERIFY and DRILL and a stated run order, a deploy document naming the repo and the SQL order, and an honest pending list enumerated from the files.

**Never:** touch the database, push to GitHub, or trigger Railway. Sahil does all three.

## The staging trap , it has caught me nine times

There is a source tree and a staged tree with `node_modules`. **Edit the source, run the gates from the stage, and sync between.** Every one of the nine incidents was the same: editing the stage and having the sync overwrite it, or running `tsc` from the source and getting phantom errors.

🔴 **Delete `tsconfig.tsbuildinfo` before trusting any `tsc --noEmit` run.** A stale one makes tsc print nothing and exit 0 without doing any work, which reads exactly like success.

⚠️ **`next build` is OOM-killed on a normal dev box.** That is why the two build-breaking classes shipped. `tsc` is not a substitute , the two gates above exist to cover the gap.

---

# 10. The five known defects that are found, documented and NOT fixed

| # | What | Where |
|---|---|---|
| 1 | **Impersonation records our staff's actions under the customer's own employee's name.** `ctx.operatorEmail` is on the context and never persisted. Partly fixed in v1.48; the writer is still wrong in places. | `server/audit.ts` |
| 2 | **`recordPlatformAudit()` writes outside the 0081 hash chain**, so every staff-access row is unsealed , exactly the rows the customer audit page exists for. | `server/platform/guard.ts` |
| 3 | **A generic `Error` becomes "Something went wrong. Please try again."**, so carefully written server refusals never reach the user. | `server/sales/guards.ts:306` |
| 4 | **`payroll_runs` has no date of payment.** The entire Payment of Wages Act is about that day. | schema |
| 5 | **13 security tests fail on the baseline** , impersonation wiring, TDS 194H threshold, accounting triggers, change-log coverage, telemetry and secops isolation. Pre-existing, not regressions. | `tests/security/` |

---

# 11. The first thing to do

1. **Read `docs/current/FOR-MANUS-HOUSE-RULES.md`** in the zip. It is not agent-specific; it is the house rules.
2. **Confirm the state yourself.** Unzip, `npm install`, delete `tsconfig.tsbuildinfo`, run `tsc --noEmit`, run all fifteen gates, run `test:ui`. **Paste the output.** Do not take this document's numbers on trust , that is the whole lesson of the last four sessions.
3. **Ask Sahil for the output of `CHECK-EVERYTHING-neon-safe.sql`** so you know what the database actually has, rather than assuming.
4. Then start **Mega-wave 2, wave A**: batches 28, 43, 130, 131.
