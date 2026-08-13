# v0.97.0-alpha — THE PRINTED INVOICE

**Repo: `app.ordence`** · **No SQL** · **No new Railway variables**

- **`/invoices/[id]/print`** — the document itself. A4, one sheet per
  Rule 48(1) copy (three for goods, two for services), selectable text.
- **`lib/invoicing/amount-in-words.ts`** — Indian grouping. One Lakh, not
  One Hundred Thousand. `bigint`, exact past `MAX_SAFE_INTEGER`.
- **HSN/SAC summary** built server-side, grouped by code **and** unit.
- **Rule 46(o) and 46(q) rows print blank rather than being omitted.**
- Supplier read from the **registration frozen on the invoice**, not from
  today's settings.
- **No server-side PDF engine.** The browser is the renderer; see the note
  at the top of `lib/invoicing/print.ts`.

# v0.96.0-alpha — CREDIT NOTES, ON A SCREEN

**Repo: `app.ordence`** · **No SQL** · **No new Railway variables**

- **Credit-note UI.** `raiseCreditNote` and `issueCreditNote` have worked
  since Phase 52 with nothing rendering them. A sales return could not be
  processed by a human being. Three screens close that:
  `/invoices/[id]/credit`, `/credit-notes`, `/credit-notes/[id]`.
- **🔴 The line ceiling.** `sales_credit_note_within_invoice()` compares
  DOCUMENT TOTALS, so crediting 100 units of a 10-unit line at ₹0.01 each
  passed it. `assessCreditLines()` closes that, checked at raise AND at
  issue.
- **🔴 The credit-note series counted drafts.** Five open drafts made the
  first issued note `CN/00006`. Rule 46(b) via Rule 53 requires the series
  to be consecutive. Now counts issued notes only.
- **`discardCreditNoteDraft`** — marks a draft cancelled, never deletes.
- **Stale registry comments removed** — five `404s today` notes on routes
  that have existed for versions.
- **`disableLogger` → `webpack.treeshake.removeDebugLogging`** — the
  Sentry SDK deprecated it and said so on every build.

# Changelog

## v0.88.0-alpha — a published endpoint that took the tenant as a parameter

🔴 **Security.** `createNotification` was exported from
`server/actions/notifications.ts`, a `"use server"` file. That file's own header
states the rule it was obeying:

> ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION. A "use server" file that exports
> anything else publishes it as an RPC endpoint reachable by anyone.

Every export *was* an async function. That is what made this one dangerous.
`createNotification` took `tenantId` **from its caller** and passed it to
`withTenant()`. It never called `requireTenantContext()`.

So it was a browser-reachable endpoint that accepted the tenant to write into as
a parameter. Any authenticated session could invoke it with another workspace's
uuid and:

- insert a row into that workspace's notification feed,
- with an attacker-chosen `title`, `body` and `actionUrl`,
- and at severity `critical` or `warning`, send an **Ordence-branded email to
  every active user of that workspace**, containing a link the attacker chose.

Row-level security could not catch it. RLS enforces the tenant the transaction
declares, and this function let the caller declare it. That is the one route
past it, and it was reachable from a browser.

**The fix is the boundary, not a check inside the function.** Adding
`requireTenantContext()` would have broken the two real callers —
`server/ai/background-workers.ts` and `server/mcp/dispatch.ts` — which have no
user session and legitimately act for a tenant they were handed. The function
moved to `server/notifications/create.ts`, an internal `server-only` module that
is not callable from a browser at all. `check:boundaries` enforces the
declaration.

- **new** `server/notifications/create.ts` — the function, unchanged, with the
  reasoning recorded above it
- `server/actions/notifications.ts` — export removed; a comment block explains
  why, and what shape a future UI-facing wrapper must take (derive the tenant
  from `requireTenantContext()`, never from the client)
- `server/ai/background-workers.ts`, `server/mcp/dispatch.ts` — imports repointed
- unused imports cleaned from the action file

No behaviour change for either legitimate caller. No schema change, no migration,
no new dependency.

**Not changed, deliberately:** `server/actions/assets.ts` and
`server/actions/grid.ts` write without a permission gate, but both derive the
tenant from `requireTenantContext()` and carry tenant predicates on every query —
`grid.ts` says so in a comment: *"Fetching by id alone would be the IDOR."* They
are tenant-safe. What they lack is a per-role permission, and there is no
`assets:*` permission key in the catalogue to use. Adding one is a product
decision plus a role-seeding migration; gating them blind would lock every
existing user out of assets.

## v0.87.0-alpha — a deploy you can prove landed

No behaviour changes. This release exists so that one glance at the landing page
answers "did the tree I pushed actually ship?"

For roughly eighty releases the landing page printed a hardcoded `v0.1.0-alpha`.
v0.85.0-alpha replaced it with `lib/version.ts`, which reads `package.json` at
build time. On 11 August 2026 the live site was still printing `v0.1.0-alpha`
**after** a deployment reported SUCCESS — which means the tree that was pushed
was not the tree that had the fix. The deploy was green and the artefact was
wrong, and nothing in the pipeline said so.

So this version number is deliberately one the live site has never shown. After
deploying, https://app.ordence.com must read `v0.87.0-alpha`. If it reads
anything else, the push came from the wrong folder — regardless of what Railway
says.

- `package.json` — version 0.86.0-alpha → 0.87.0-alpha
- `lib/version.ts` — stale version comment removed; it named a release the file
  does not control, which is the same drift the file exists to prevent
- `DEPLOY-VERIFY.md` — the post-deploy checks, in order, with what each proves

Deliberately NOT changed: `app/api/health/route.ts`. It documents a decision to
reveal nothing about internals — no version, no dependency status. A liveness
probe that leaks the build is a fingerprint; the landing page already carries
the version for humans, and that is the right place for it.

## v0.84.0-alpha — CI hardening: the three gates that would have caught this project's worst incidents

Every check below exists because something got through. None is hypothetical.

### Added — `scripts/check-server-boundaries.mjs` (`npm run check:boundaries`)

A recursive `sed` once stripped `import "server-only"` from **66 files**,
including `tenant-context.ts`, `billing/access.ts`, `platform/guard.ts`,
`audit.ts` and both payment providers. **Every existing gate stayed green** —
`tsc`, the build, the entire security suite. The guard has no runtime
behaviour; deleting it removes only the alarm.

Checks: every module reaching `@/db`, `next/headers`, `@clerk/nextjs/server`
or `@/lib/env` declares a boundary · no `"use client"` file imports a
`server-only` module · a `"use server"` file exports only async functions.

**Found two real gaps on its first run**, both now fixed: `lib/queue/processors.ts`
(opens `withTenant()` transactions, no guard) and `db/index.ts` (exports the
client and both scope functions — the single most important module never to
reach a browser, and the one file that did not say so). 80 → **84** guarded.

⚠️ Its first draft flagged 30+ files in `lib/` that import `@/db/schema` for
**types only**. Type imports are erased at compile time — those modules are
pure GST/interest/seat arithmetic and are correctly importable anywhere.
Demanding a boundary on them is how a check trains people to silence it. The
rule now strips type imports and ignores `@/db/schema` entirely.

### Added — `scripts/check-migrations.mjs` (`npm run check:migrations`)

Three files were numbered 0062/0072/0076 when the highest real one was 0045.
`SQL-FILES/` is applied in numeric order, so numbering **is** execution order.
Nothing in CI read SQL filenames.

Checks duplicates, gaps, and reuse of a `_superseded/` number. The two
historical gaps (0004, 0010) are allowed **by name, with reasons** — a check
that tolerates a category of fault stops catching that fault.

### Added — `scripts/check-rls-coverage.mjs` (`npm run check:rls`)

Four tenant-scoped tables shipped with no RLS at all. The existing CI step
asserts a **floor** (`count >= 100`) — adding four unprotected tables to 160
protected ones leaves the count at 160. **A floor measures what was done
right; it cannot see what was done wrong.**

This asks the opposite question, exhaustively: for *every* table with a
`tenant_id` column — RLS enabled, forced, policied on `app_current_tenant_id()`,
and no `app_platform_scope()` in `WITH CHECK`. Zero thresholds. Fails closed
when it cannot run, because "found nothing" is not "passed".

### Added — `scripts/preflight.mjs` (`npm run preflight`)

One gate, invoked identically by CI and locally. Ordered by cost: the two
static checks take milliseconds and catch the two worst incidents here, so the
common case fails in under a second instead of after a four-minute build.
Runs all checks even after one fails, and reports a table.

### Added — `scripts/neon-status.mjs` (`npm run db:status`)

`SQL-FILES/` has no migration ledger — nothing records what ran. This reads
every `CREATE TABLE` out of every numbered file and reports each as APPLIED,
PARTIAL or MISSING against a live database. Read-only. **PARTIAL is the
interesting result**: a file that failed part-way, or a `drizzle-kit push`
that dropped something, leaves a database no single file describes.

### Added — `scripts/make-release.sh` (`npm run release`)

Builds a verified archive into `~/Downloads/ORDENCE ERP - APP.ORDENCE.COM/`.
Runs preflight first and aborts on failure — a zip built from a tree that does
not compile is worse than no zip. Verifies with `unzip -t` (a truncated
archive lists its entries happily until the central directory is read),
scans for secrets with an **anchored** match, and writes a checksum and
release notes.

⚠️ The secret scan is `grep -x`, not a substring. Unanchored, it flags
`.env.test.example` — a committed template with no real values — and a check
that cries wolf on a safe file is one people learn to ignore.

### Changed — `.github/workflows/security-ci.yml`

Boundary census and migration numbering run in the `build` job before `tsc`.
Exhaustive RLS coverage runs in `security-tests` after the SQL is applied,
alongside the existing floor check rather than replacing it.

**No `TEST_DATABASE_URL` secret is required.** CI starts its own PostgreSQL 16
service container and writes `.env.test` itself, so `billing-gate.test.ts`
runs automatically under `npm run test:security`.

## v0.83.2-alpha — Security Track S1: the billing gate on core CRM writes

`tsc --noEmit` passes clean. No new dependencies.

### 🔴 S1 — `past_due` workspaces could still write core CRM records

`requireAccess()` had **17 call sites** against `requirePermission()`'s 151,
and was absent from the three most-used write paths in the product. A
workspace in `past_due` or `unpaid` is supposed to be read-only; it could
still create, edit and delete contacts and companies.

Added to all six writes, immediately after `requireTenantContext()` and
**before** `parse()`:

| File | Guarded |
|---|---|
| `server/actions/contacts.ts` | `createContact`, `updateContact`, `deleteContact` |
| `server/actions/companies.ts` | `createCompany`, `updateCompany`, `deleteCompany` |

Before validation deliberately: a read-only workspace should hear that it is
read-only, not receive a field error for a form it was never going to be
allowed to submit.

`AccessRestrictedError` is now caught **first** in each file's
`toActionError()` and surfaced with the billing wording. Folding it into
"Something went wrong. Please try again." would tell a customer whose card
expired that the software is broken — the one message guaranteed to produce
a support ticket instead of a payment.

Reads are untouched. A customer in arrears must still be able to see their
own data.

### 🔴 The MCP surface bypassed the gate entirely

`server/actions/deals.ts` needed no change — its only export is
`listDealPipeline()`, a read. Auditing *why* surfaced the real hole: the
**only** deal write in the codebase is `ordence_update_deal_stage` in
`server/mcp/dispatch.ts`, and that dispatcher checked the token, the scope
and RLS — but never whether the workspace was still paying.

So a company's own staff were correctly read-only while an AI agent holding
a `read_write` token for the same workspace kept writing. Read-only that one
caller can walk around is not read-only.

- **`server/billing/access.ts`** — added `getAccessDecisionForTenant()` and
  `requireAccessForTenant()`. The existing path resolves the tenant from a
  Clerk session; MCP has no Clerk session, only `session.tenantId`. Both new
  functions fail OPEN on their own errors, matching `getAccessDecision()` —
  a billing-table outage must not stop a customer's agent pipeline. The
  subscription read runs inside `withTenant()`, because a plain `db` read
  with no tenant context returns zero rows under RLS and would have looked
  like "no subscription" and granted everyone full access.
- **`server/mcp/dispatch.ts`** — every tool declared `scope: "read_write"`
  now passes the gate before executing. Read tools are unaffected; an agent
  answering "what do I owe?" is the call most likely to end in a payment.

### Changed

- **`server/actions/deals.ts`** — a header explaining why it has no
  `requireAccess()` call and what to do the moment a write is added. A new
  write added without the guard silently reopens this hole and nothing in
  the type system would notice.

### Removed / renamed

- **`lib/command/registry.ts`** — deleted. Dead code with zero importers;
  the working ⌘K palette is `components/layout/command-bar.tsx` and carries
  its own action list. Two lists of command destinations would drift.
- **`MASTER_PLAN.md` → `docs/BATCH-PLAN-460.md`** — renamed rather than
  deleted. It is **not** a duplicate of `docs/MASTER-PLAN.md`: that file is
  a v0.25.0-alpha product roadmap (Waves A–H, "what unlocks money") and
  contains zero mentions of the 460 batches, the seven departments or
  `ui_governance_checks`. Deleting it would have destroyed the roadmap the
  batch work runs from. The similar names were the actual problem.

### Tests

**`tests/security/billing-gate.test.ts`** — 16 assertions across five groups,
against a real throwaway Postgres.

⚠️ **It drives `unpaid` + expired grace, NOT `past_due`** — and the header
explains why at length. `tests/ui/access-state.test.tsx` already pins the
commercial rule in a test named *"⭐ past_due NEVER restricts writes, at any
failure count"*: while the provider is still retrying, cutting access loses
the customer **and** the payment. Restriction begins only once the status is
`unpaid` and its seven-day grace window has closed — roughly three weeks
after the first failure.

A suite written against `past_due` would have gone red and looked like the S1
gate was broken, inviting somebody to "fix" it by making `past_due`
restrictive — silently reversing that decision and locking customers out on
their first failed card.

Covers: writes refused · **reads still succeed** · billing and export never
blocked · healthy workspace untouched · fails **open** on a lookup fault ·
MCP `read_write` gated while read tools stay available · RLS unaffected by
billing state.

Two of the groups are **source assertions**, deliberately. Every behavioural
test above passes whether or not `contacts.ts` actually calls the gate — they
test the gate, not its callers, and that is the exact shape of the original
defect: a correct, tested `requireAccess` with 17 call sites where 151 were
needed. So the suite also reads the source and asserts each write path calls
it, that `AccessRestrictedError` is surfaced rather than swallowed, that the
dispatcher still contains the `read_write` branch, and that `deals.ts` has
gained no write function.

### Coverage

`requireAccess` / `requireAccessForTenant` call sites: **17 → 32**.

## v0.83.1-alpha — The Build Fix, the Pooling Fix, and the Missing RLS

Canonical tree: **`ordence-v55 2`**. `tsc --noEmit` passes clean.
No new dependencies — `package.json` gained nothing.

### 🔴 THE BUILD FAILURE — found and fixed

`next build` had been failing with:

    x You're importing a component that needs "server-only".
    ./server/platform/users.ts
    Import trace: ./components/platform/user-actions.tsx

`components/platform/user-actions.tsx` is a `"use client"` component and it
imported `updateUserStatus` / `updateUserRole` **straight from**
`server/platform/users.ts` — a `server-only` module that reaches
`guard.ts` → `withPlatformScope()`, the cross-tenant read escape hatch.

This is why `tsc --noEmit` always passed: TypeScript does not check bundler
boundaries. Only webpack catches it.

**The fix is the house rule already written at the top of
`server/platform/actions.ts`:** *"Every one delegates immediately to a module
that starts with `import "server-only"`."* A client calls a `"use server"`
wrapper; the wrapper delegates to the server-only implementation, which does
its own authorisation. The two wrappers for users had simply never been
written. Added `updateUserStatusAction` and `updateUserRoleAction`.

**⚠️ A `sed` had deleted `import "server-only";` from `users.ts` as an
attempted fix. That has been reverted** (restored byte-identical from the
untouched sibling). Deleting the line removes the alarm, not the fault — and
it does not even work: the same error immediately reappears in `guard.ts`,
which also imports `next/headers` and genuinely cannot exist client-side.

**Swept all 33 client components** that import `@/server/*`. This was the
only violation; the other 32 were already correct.

### 🔴 Missing row-level security

`SQL-FILES/0062`, `0072` and `0076` created four tenant-scoped tables —
`deployment_releases`, `deployment_backups`, `security_batches`,
`flow_submissions` — with **no `ENABLE`, no `FORCE`, no policy**. In this
codebase RLS *is* the tenant boundary; a `tenant_id` column with no policy
behind it is a column, not isolation.

They were also numbered 0062/0072/0076 when the highest real migration was
0045, leaving permanent gaps.

Replaced by **`0046_deployment_flows_governance.sql`** — contiguous
numbering, the same four tables plus the `ui_governance_checks` tracker the
460-batch plan referenced but never defined, all with the policy shape every
other table here uses:

    USING      (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id())

Platform scope in `USING` only — read across tenants for support, never
write. The old files moved to `SQL-FILES/_superseded/` with a README. 0046
is idempotent, so it repairs an already-migrated database rather than
duplicating.

### 🔴 The v55 notification regression

- **Every notification emailed everyone.** The severity test read
  `critical || warning || !input.severity` — the third clause meant the
  DEFAULT case emailed every active user, and `background-workers.ts`
  creates those on a schedule.
- **50 sequential awaited Resend calls** on the request path → now
  `Promise.allSettled`, one round, cannot reject.
- **Returned the literal string `"created"`** instead of the UUID its own
  return type promised. `ordence_create_reminder` was handing the word
  "created" to an AI agent.
- **The tenant-name lookup read zero rows, always** — it used the plain `db`
  client with no tenant context, so RLS matched nothing. Every email said
  "Your workspace". Folded into the tenant transaction, collapsing three
  connections per notification into one.

### ⭐ `withTenant()` no longer opens a pool per call

`db/index.ts` created a new `Pool` and called `pool.end()` on **every**
tenant-scoped query — correct for Cloudflare Workers, wrong for the
long-lived Node process Railway runs, where it meant a fresh TCP handshake
and TLS negotiation per query and a straight run at Neon's connection limit.

Now one lazily-created process-wide pool with an `error` handler so an
evicted idle client cannot kill the process. **Isolation is unaffected:**
every setting uses `set_config(..., is_local => true)` inside an explicit
transaction, so it is discarded at COMMIT before the connection is reused.

### 🔴 `ordence_create_compliance_task` could never have run

It omitted `period_start` and `period_end` (both NOT NULL) and supplied
`due_date`, whose schema comment reads *"Written by trigger. Never accept
this from a form."* A cast — `as unknown as typeof complianceTasks.$inferInsert`
— suppressed the only check that would have caught it. Now matches the
documented convention in `server/actions/compliance.ts` and is idempotent by
constraint.

### Added

- `components/layout/command-bar.tsx` — ⌘K palette on `@radix-ui/react-dialog`
  (already a dependency) rather than adding `cmdk`. Filtering is server-side
  via `globalSearch()` under RLS. 200ms debounce, because search is
  rate-limited server-side.
- `server/actions/bulk.ts` — bulk soft-delete and owner reassignment over a
  hardcoded entity allowlist. One transaction, one audit entry with a
  `batchId`, permission checked once before the first write, capped at 500.
  Soft delete only. Calls `requireAccess()`.
- `lib/documents/csv.ts` — CSV export with formula-injection neutralising
  (CWE-1236), UTF-8 BOM so ₹ and Devanagari survive Excel, CRLF per RFC 4180,
  explicit column allowlist.

### Notes

- **No `cmdk`, no `xlsx`, no `puppeteer`.** Puppeteer in particular pulls
  ~170 MB of Chromium at install on a builder that was already the fragile
  part of this project, and `lib/billing/invoice-render.ts` already emits a
  Rule-46 invoice with print styles.
- **The seven files pasted in from the previous AI session are retained and
  currently imported by zero modules** — `lib/ui/tokens.ts`,
  `lib/command/registry.ts`, `lib/flows/registry.ts`,
  `lib/security/toolkit.ts`, the two `components/ui/` wrappers, and
  `deployment-control/page.tsx`. They compile; nothing uses them yet.
  `lib/security/toolkit.ts` also duplicates token hashing that
  `server/mcp/dispatch.ts` already does — two hashing paths will diverge.
- **Still open:** `requireAccess()` has 17 call sites against
  `requirePermission()`'s 151, and is absent from `contacts.ts`,
  `companies.ts` and `deals.ts`. A `past_due` workspace is meant to be
  read-only and can still write core CRM records.
- `npm install` reports 12 vulnerabilities (6 high) and an
  `eslint@10` / `eslint-config-next@16` peer conflict against `next@15`.

## v0.21.0-alpha — PITR, Backup & Restore (1 August 2026)

**Wave 2 complete** (bar the admin-console wiring). A recycle bin, a
tenant export, a disaster-recovery runbook, and a drill that proves a
restore actually works.

### Added
- **`lib/backup/recoverable.ts`** — the catalogue of what can be restored,
  with per-entity preconditions. Deliberate omissions (users, tenants,
  payment methods) each carry a reason.
- **`server/backup/restore.ts`** — the recycle bin, with preconditions
  checked BEFORE writing and re-checked inside the transaction.
- **`server/backup/export.ts`** — a complete tenant export. Answers three
  requirements at once: disaster recovery, the DPDP right of access, and
  the ability to leave.
- **`scripts/restore-drill.ts`** (`npm run drill:restore`) — a real
  restore against a real database, refusing to run against production.
- **`docs/DISASTER-RECOVERY.md`** — four incident levels, each with a
  different response, and an explicit list of what the runbook does not
  cover.
- **`app/(crm)/settings/recovery/`** — the recycle bin and export UI.

### The decisions
- **Nothing hard-deletes on a timer.** The 30-day window governs what the
  recycle bin SHOWS, not what exists. A sweeper whose failure mode is
  unrecoverable data loss, running unattended forever, is not a feature.
- **Restore is blocked when the parent is deleted**, when a live row has
  taken a unique value, or when it falls in a closed financial period.
  Each message names the remedy, not just the status.
- **The export is an allowlist**, never a scan of `information_schema` —
  a dynamic export is one migration away from including a token table.
- **The export includes soft-deleted rows**, deliberately: "a copy of your
  data" means everything, and it is what makes the file a real backup.
- **Export is permitted at every access level**, including a hard lockout.
  Under DPDP the right of access does not lapse over an unpaid invoice.

### Found by these tests
- **Two wrong column names in my own catalogue** (`contacts.full_name`,
  `custom_object_records.object_definition_id`). Either would have made
  a whole category of the recycle bin throw and render empty — which reads
  to a customer as "gone forever". Caught by coherence tests that check
  the catalogue against the live schema.
- **The drill initially ran everything on one connection** and failed at
  "create a workspace" with an RLS violation. That was RLS working
  correctly, but it meant five reported failures that said nothing about
  whether a restore works. Split into app and admin pools, as the test
  suite already does.

### Tests
- `tests/security/recovery.test.ts` — 21 tests, including a sweep proving
  a tenant-scoped read of every exported table returns zero foreign rows.
- Totals: **361 security** (was 340), **556 UI** (unchanged).

---


## v0.16.0-alpha — Invoicing & the Billing Portal (1 August 2026)

**Wave 1 complete.** GST-compliant invoice generation, a customer billing
portal, and the constraints that stop an invoice being created wrongly.

### Added
- **`server/billing/invoice-generator.ts`** — draft → attach lines → issue,
  all in one transaction. The order is forced by the database, not by
  convention.
- **`lib/billing/invoice-lines.ts`** — pure line composition. Extra seats
  get their OWN line; prorations show credit and charge separately.
- **`lib/billing/invoice-render.ts`** — a self-contained GST tax invoice
  with every field Rule 46 requires, amount-in-words in the Indian
  numbering system, and print styles.
- **`server/actions/invoicing.ts`** — read, download, issue by hand, void.
- **`app/(crm)/settings/billing/`** — the portal, with a per-panel Suspense
  boundary so one slow query cannot blank the page a lapsed customer came
  to fix.
- **`SQL-FILES/0015_phase16_invoicing.sql`** — the duplicate-period index,
  the empty-invoice guard, REVOKE-before-GRANT, 8 verification checks.

### The constraints that matter
- **One invoice per subscription period**, by partial unique index.
  Proven by racing four concurrent attempts: exactly one wins.
- **A voided invoice frees the period** for a corrected one — the only
  supported route back from a mistaken issue.
- **An invoice cannot be issued with no lines.** The Phase 11 trigger
  prevents CHANGING an issued invoice, not issuing an empty one.
- **No DELETE on invoices.** A number that vanishes from a series is
  exactly what an auditor asks about.
- Invoice numbers are unique across the whole platform, not per tenant —
  GST requires the series consecutive across the registration.

### Fixed
- **`amountInWords` returned lowercase for amounts under one rupee.**
  Capitalisation was applied to the rupee words, which are empty below
  ₹1. Caught by sweeping a range rather than checking one value.
- **A concurrency test was asserting a property the code deliberately does
  not have.** It fired four deltas at a level starting from zero and
  expected an order-independent sum; the clamp at zero discards a negative
  delta that lands first. The clamp is correct — a negative storage level
  would hand a tenant unlimited free quota. The test was rewritten to
  assert what is true and valuable, with the clamp given its own test.
- **Two tests were mutating shared fixture state**, producing failures that
  pointed somewhere else entirely. Both made hermetic, and an implicit
  ordering dependency they had been hiding was removed.
- **Pure logic extracted out of a database-importing module for the third
  time.** The rule now stated explicitly: decision logic does not live in a
  file that imports the database.

### Tests
- `tests/ui/invoicing.test.tsx` — 35 tests: every Rule 46 field, hostile
  input in the customer's own legal name, Indian numbering.
- `tests/security/invoicing-integrity.test.ts` — 11 tests including the
  concurrency race.
- Totals: **556 UI** (was 521), **340 security** (was 328). Both stable
  across repeated runs.

---


## v0.15.0-alpha — Usage Metering, Integrated (1 August 2026)

Phase 15 wired into the running application, and the Phase 17/18 schema
brought into the barrel and the composite SQL.

### Integrated
- `usage_counters` / `usage_levels` exported, pushed and under forced RLS.
- **Storage reservation shares one transaction with the document row.** A
  row without a reservation is free storage that compounds silently; a
  reservation without a row refuses an honest customer space they are not
  using. Both are silent, so they land together or not at all.
- **Release on delete is best-effort and outside the transaction.** Rolling
  back a failed meter update would leave the blob already gone from storage
  while the row survived — a document the customer can see and never open.
  An over-count that the nightly reconcile corrects beats a dangling
  reference that nothing does.
- **Quota gate on upload only.** Never on delete, download or export — a
  customer at their limit must always be able to free space and to leave
  with their data. Asserted by test.
- Portal-link creation metered, best-effort.
- `db:verify` extended: **38 tables under forced RLS, 40 policies, 11
  append-only tables.** All checks green.

### Fixed
- **Test pool was sized exactly to demand.** `max: 4` with a concurrency
  test needing exactly 4 simultaneous connections. Any lingering connection
  starved it, and the suite then reported a CONCURRENCY test failing —
  pointing at the code under test rather than the harness. That is the worst
  shape a flake can take in a security suite. Doubled, with the reasoning
  recorded.
- **Public env values now supplied to the UI suite.** `lib/env.ts` parses
  `clientEnv` at module scope and throws, which is correct for production
  and means any module transitively importing it explodes under test. This
  surfaced twice as nineteen unrelated AUTHORISATION tests failing.
- The upload suite now mocks the quota gate (it reaches the database, and
  `getServerEnv()` correctly refuses to run under jsdom) **and asserts the
  gate is present and ordered before token issuance** — a mocked dependency
  you also rely on being present can otherwise be deleted with the suite
  still green.

### Tests
- **521 UI** (was 395), **328 security** (was 238).

---


## v0.14.0-alpha — Lockout, Dunning & Access Restriction (31 July 2026)

**Wave 1, Phase 4 of 6.** The paywall — written around one principle:
**never lock out a customer who is trying to pay you.**

### Added
- **`lib/billing/access-state.ts`** — a five-rung ladder (full → notice →
  warning → restricted → locked) with the copy for each. Pure and
  isomorphic.
- **`server/billing/access.ts`** — `requireAccess()`, `checkAccess()`,
  `getAccessBanner()`, `AccessRestrictedError`.
- Access gate wired ahead of the entitlement and permission gates on all
  twelve write paths.

### The rules
- **`past_due` NEVER restricts anything**, at any failure count. While the
  provider is still retrying, cutting access is the worst of both worlds.
- **`unpaid` still honours a 7-day grace window.** Earliest possible
  restriction is roughly three weeks after the first failure.
- **Restriction means READ-ONLY, never hidden.** Every record stays
  visible and exportable.
- **Export is permitted at every level, including a hard lock.** Retaining
  someone's data while denying them a copy is a DPDP problem, not a
  collections strategy.
- **Billing is reachable at every level** — a paywall you cannot pay
  through is just a wall. Enforced by an exempt-prefix list, tested
  against adversarial namespaces.
- **A trial does not hard-stop at midnight** — three days of read-write
  grace, because a trial that stops dead catches people mid-evaluation.
- **Cancelling keeps full access through the paid period.**
- **Administrative suspension outranks billing**, checked first, so paying
  an invoice cannot silently un-suspend a workspace suspended for abuse.
- **No collections language.** Asserted by test — no "delinquent",
  "overdue", "arrears".

### Design note — this gate FAILS OPEN
Every other gate fails closed. This one cannot: a failed subscription
query must not take every paying customer's workspace away. A few hours
of unbilled access is a smaller blast radius than a self-inflicted outage.
Administrative suspension still applies, because it is decided from the
tenant row rather than the query that failed.

### Tests
- `tests/ui/access-state.test.tsx` — 28 tests, including a sweep over every
  status × grace × trial combination asserting no state ever hides or
  blocks export of a customer's own data.
- Totals: **395 UI** (was 367), **238 security** (unchanged).

---


## v0.13.0-alpha — Seat Licensing (31 July 2026)

**Wave 1, Phase 3 of 6.** Seat counting and enforcement. No new tables, no
new dependencies, shared bundle unchanged.

### Added
- **`lib/billing/seats.ts`** — pure seat arithmetic. `occupiesSeat`,
  `computeSeatState`, `canTakeSeats`, overage and warning copy.
- **`server/billing/seats.ts`** — `countSeatsInUse`, `countSeatsPurchased`,
  `requireSeat`, `getSeatSummary`, `SeatLimitError`.
- `getSeatUsage()` action for the team page.
- Enforcement on user reactivation and on the Clerk membership webhook.

### The seat rules, stated explicitly
- **Invited users HOLD a seat.** The most commonly got-wrong rule: without
  it a 5-seat workspace can invite fifty people and someone is surprised
  on acceptance day.
- **Suspended users free a seat** — that is how a customer swaps one
  employee for another. The consequence is that *reactivating* someone
  consumes a seat and can fail, which is checked and explained.
- **`platform_super_admin` never consumes a customer's seat.** Billing
  someone for our own support engineer would be indefensible.
- **Guests never consume a seat** — closer to a portal visitor than an
  employee.
- **Nobody is auto-suspended when a workspace goes over.** Choosing six of
  eleven employees to lock out is not a decision an algorithm should make.
  Everyone keeps working; only *adding* is blocked.
- **Blocks rather than auto-charging.** Silently adding seats to an invoice
  produces a bill the admin never agreed to.

### Design notes
- Seats are counted **live**, never cached. A `seatsUsed` counter would
  need every status-changing path to remember to adjust it, and one missed
  path means a customer is blocked with seats free, or exceeds what they
  paid for.
- The Clerk webhook path **does not refuse** — a non-2xx makes Clerk retry
  forever and strands the user in the identity provider. It creates the
  user, lets the workspace go over, and writes an audit row.
- The seat rule is written twice (SQL and TypeScript).
  `tests/security/seat-licensing.test.ts` asserts they agree against a real
  database over a fixture covering every status and both exempt roles.

### Tests
- `tests/security/seat-licensing.test.ts` — 30 tests.
- Totals: **238 security** (was 208), **367 UI** (unchanged).

---


## v0.12.0-alpha — Entitlements & Feature Gating (31 July 2026)

**Wave 1, Phase 2 of 6.** One `can(feature)` gate the whole product
consults. No new dependencies; shared bundle unchanged at 102 kB.

### Added
- **`lib/entitlements/features.ts`** — 26 gateable features, each with a
  `minTier`. Pure and isomorphic so the pricing page, the navigation and
  the server gate read one matrix. Tiers are a ladder, so a higher tier is
  always a strict superset.
- **`server/entitlements.ts`** — `requireFeature()` (throws, for writes),
  `checkFeature()` / `can()` (returns, for reads), `checkFeatures()`,
  `getEntitlementSummary()`. Deduplicated per-request with React `cache()`.
- **`components/billing/feature-gate.tsx`** — `FeatureGate`,
  `UpgradePrompt`, `LockedControl`.
- Gates wired into 12 write paths across accounting, periods, storage,
  custom objects, contracts and the portal.

### Design decisions
- **Entitlement is checked BEFORE permission.** Order does not change the
  outcome, only the message — and telling a workspace owner they "lack
  permission" for something they have not bought sends them to ask an
  administrator who is themselves.
- **Reads are never gated.** A downgrade must not make the customer's own
  ledger, contracts or documents look deleted. They can look; they cannot
  write.
- **A trial is treated as Advanced**, not as the cheapest tier — a trial
  that unlocks the least impressive version sells nothing.
- **A lapsed workspace drops to Basic**, not to zero, and its message says
  "paused, your data is safe" rather than "upgrade".
- The subscription row is authoritative; `tenants.plan_tier` is only a
  fallback, because a delayed webhook would otherwise gate a customer who
  has just paid.

### Fixed (found by these tests)
- **`isFeatureKey` used the `in` operator**, so `toString`, `constructor`
  and `__proto__` all read as known features. It happened to fail closed
  through a chain of coincidences, and reported the wrong reason. Now
  `Object.hasOwn`.
- **`inert=""` rendered nothing.** React drops an empty string for
  boolean-ish attributes, so the "locked" subtree stayed fully keyboard
  focusable with no visible symptom — only a keyboard or screen-reader
  user would ever have found it. Now `inert={true}`.
- **An automated pass put three gates on `getTrialBalance` and none on
  `postTransaction`** — reads gated, writes open. Corrected, and a test
  now fails if any action whose name starts with `get`/`list`/`find` is
  ever feature-gated again.

### Tests
- `tests/ui/entitlements.test.tsx` — 29 tests including the
  superset property across every tier pair, prototype-pollution keys, and
  a source scan asserting no action compares `planTier` directly.
- Totals: **236 UI** (was 207), **171 security** (unchanged).

---


## v0.11.0-alpha — Billing Foundation (31 July 2026)

**Wave 1, Phase 1 of 6.** The machinery to charge people. No new production
dependencies; the shared client bundle is unchanged at 102 kB.

### Added
- **`db/schema/billing.ts`** — six tables: `plans` (platform catalogue, no
  tenant_id, protected by GRANT), `subscriptions`, `invoices`,
  `invoice_lines`, `payment_events` (append-only evidence), `payment_methods`
  (provider tokens only — no PAN, no CVV, no PCI scope).
- **`lib/billing/money.ts`** — exact BigInt minor-unit arithmetic, GST
  computation (CGST/SGST vs IGST), GSTIN validation with mod-36 checksum,
  second-based proration, month-end-safe interval arithmetic.
- **`lib/billing/providers/`** — Razorpay, Stripe and manual adapters behind
  one interface. HMAC verification via `node:crypto`; no SDKs.
- **`lib/billing/state-machine.ts`** — the pure subscription transition
  table, extracted so it is testable without a database.
- **`lib/billing/redact.ts`** — Luhn-checked payload redaction before
  permanent storage.
- **`server/billing/reconcile.ts`** — the single path by which a provider
  event changes state. Idempotent, transactional, order-aware.
- **`app/api/webhooks/{razorpay,stripe}/route.ts`** — public endpoints,
  Node runtime, verify-before-parse.
- **`server/actions/billing.ts`** — checkout, plan preview, cancellation,
  manual settlement, billing profile.
- **`SQL-FILES/0009_phase11_billing.sql`** — RLS on five tables, append-only
  triggers, issued-invoice immutability, invoice numbering sequence, grants.
- **`scripts/seed-plans.ts`** (`npm run seed:plans`) — idempotent upsert that
  never reprices existing customers.

### Security
- **Webhook replay protection** — UNIQUE index on
  `payment_events(provider, provider_event_id)`, global rather than
  per-tenant so one tenant cannot replay another's event.
- **Out-of-order protection** — `subscriptions.last_provider_event_at`
  high-water mark against the provider's timestamp.
- **One live subscription per tenant** — partial unique index, preventing
  double billing after a failed cancellation.
- **Issued invoices immutable** — amounts, number, tenant, tax identity and
  line items all fixed once issued; drafts remain editable.
- **🔴 Fixed: additive GRANTs were not a restriction.** The grant block only
  added privileges, so a prior blanket `GRANT ALL` would have left the
  application able to reprice its own plans and alter payment evidence. Now
  revokes first. `db:verify` asserts it.
- `db:verify` extended from 7 checks to 10.
- 30 tables now under forced RLS (was 25).

### Tests
- `tests/security/billing-isolation.test.ts` — 45 tests, real PostgreSQL 16,
  non-superuser.
- `tests/ui/billing-webhooks.test.tsx` — 60 tests: signature forgery,
  replay, tampering, secret rotation, event normalisation, redaction, and
  the full state machine.
- `tests/ui/billing-money.test.tsx` — 45 tests including property tests over
  every hour of a month.
- Totals: **171 security** (was 126), **207 UI** (was 102).

### Fixed
- A control-character detection test that itself contained literal control
  characters.
- `tgenabled::text` cast in a verification query that crashed on PG16.

### Known limitations
- **Provider plan ids are not set, so nothing can be purchased yet.**
  Fifteen minutes of Razorpay dashboard work; documented in the deployment
  guide.
- Invoice *generation* is Phase 16; proration is computed but not charged
  until Phase 14.
- No end-to-end test against a live provider sandbox.

---


Versions follow `MAJOR.MINOR.PATCH`. Every batch increments MINOR; every fix
within a batch increments PATCH. Each version passes a security run before release.

---

## [v0.10.0-alpha] — 2026-07-31 — Executive Dashboards & Financial Analytics

**Security run:** PASS ([report](docs/SECURITY-REPORT-v0.10.0.md))
**Tests:** 228 passing (126 security + 102 UI) · **Build:** clean, 28 routes · **Prod vulns:** 0

### Added
- **Three SQL analytics views**, all created `WITH (security_invoker = true)`:
  `v_asset_portfolio`, `v_ledger_daily` (30-day date spine), `v_contract_pipeline`
- **`db/schema/analytics.ts`** — Drizzle view TYPES only, via `.existing()`, so
  `drizzle-kit push` cannot recreate them without `security_invoker`
- **`server/actions/analytics.ts`** — aggregates inside `withTenant()`, summed in
  BigInt paise, never floats
- **Rebuilt dashboard** — six independent `<Suspense>` boundaries, each panel
  fetching its own data so the page streams instead of blocking on the slowest query
- **Skeleton loaders** that reserve layout, preventing content jump
- **`FinancialBarChart`**, **`AssetPipelinePieChart`**, **`RecentActivityFeed`**
  (virtualized), **`QuickActions`**
- **`npm run db:verify`** — interrogates the live database and exits non-zero if
  RLS, policies, `WITH CHECK`, `security_invoker` or integrity triggers are missing
- **13 new tests** proving RLS isolation through the views

### 🔴 Critical operational finding: `drizzle-kit push` drops every RLS policy
`push` treats anything absent from the Drizzle schema as drift. Our policies live
in `SQL-FILES/`, so it deletes them. Measured:

```
before  npm run db:push  ->  25 tables with RLS,  25 policies
after   npm run db:push  ->   0 tables with RLS,   0 policies
```

The application keeps working — every page renders, every query succeeds. The only
difference is that tenants can read each other's data.

No harm has occurred: every deployment guide runs `ALL-IN-ONE-SETUP.sql` *after*
`push`, which restores everything. But a standalone `push` would remove every
tenant boundary silently. Mitigated with `db:verify` (fails non-zero), a warning
printed by `db:push`, a CI step, and explicit documentation. **SEC-022** recommends
`db:generate` over `db:push` for production.

### ⭐ RLS does NOT cascade into SQL views
A PostgreSQL view runs as its OWNER, not the caller. Measured before writing any
view — a non-superuser session pinned to ONE tenant:

```
naive view      (no option)                ->  6 tenants visible
safe  view      (security_invoker = true)  ->  1 tenant  visible
```

Nothing errors; the dashboard renders; the numbers are the whole platform's. All
three views use `security_invoker`, the SQL refuses to run on PostgreSQL < 15, and
a test builds both kinds side by side to demonstrate the difference rather than
assert it.

### Bundle impact — Recharts does NOT bloat the app
```
Routes loading the Recharts chunk:  1 of 33  (/dashboard)
Recharts chunk:                     105 kB gzipped
Shared-by-all baseline:              98 kB gzipped  (UNCHANGED)
Public portal route:                120 kB          (UNCHANGED)
```

### Chart design
Colour was **computed, not chosen** — every hue validated against the real chart
surfaces. Three light-mode hues measured below 3:1 contrast, so every chart ships a
legend, direct value labels and a **"View as table"** toggle. Categorical hues in
fixed order, never cycled; donut capped at 5 slices with the tail folded to "Other";
no dual-axis charts; status colours reserved and always paired with a word.

### Changed
- Superseded Phase 5 dashboard (`server/dashboard.ts`, `dashboard/charts.tsx`)
  moved to `_to_delete/phase10-superseded/`

### Known limitations
- **SEC-023 (new, low):** views re-aggregate on every load. Correct and fast for a
  single tenant's row counts; revisit past ~1M journal entries.
- The dashboard has **not been rendered in a real browser** yet — data layer, types
  and build are verified; visual geometry is not.

---

## [v0.9.0-alpha] — 2026-07-31 — External Client Portal & Secure Approvals

**Security run:** PASS ([report](docs/SECURITY-REPORT-v0.9.0.md))
**Tests:** 215 passing (113 security + 102 UI) · **Build:** clean, 28 routes · **Prod vulns:** 0

### Added
- **`portal_links` table** — 256-bit bearer credentials, stored as SHA-256
  hashes. RLS `ENABLE` + `FORCE`, plus a tamper-guard trigger covering the
  token, target, permission and expiry
- **`contract_signatures` table** — append-only signature evidence with IP,
  user agent, content hash and the verbatim consent statement
- **`lib/portal/tokens.ts`** — `crypto.randomBytes` generation, hashing,
  shape validation, constant-time comparison, masking
- **`server/portal-context.ts`** — sessionless tenant resolution:
  `token → resolve → tenantId → withTenant() → RLS`
- **`/portal/[token]`** — public, branded, read-only document view requiring
  no Clerk account
- **`/portal/[token]/documents/[id]`** — token-authenticated download, separate
  from the internal route by design
- **`server/actions/signatures.ts`** — approve-and-sign with three independent
  layers of replay prevention
- **`server/actions/portal.ts`** — generate, list, revoke, revoke-all
- **`components/crm/portal-manager.tsx`** — one-time link reveal, copy, revoke
- **`ContractReadyEmail` now carries the portal URL**, so a recipient clicks
  from their inbox straight into the document instead of a sign-in page
- **48 new tests** — 25 portal isolation and token rejection, 23 token
  cryptography

### Fixed
- **🔴 `withTenant()` was silently returning zero rows.** It set
  `app.current_tenant_id` with `is_local => true` but opened no transaction, so
  the setting was discarded before the next statement and every RLS policy
  matched nothing. Present since Phase 1. It failed **closed** — nothing
  leaked — but any code path relying on it for scoping returned nothing.
  Fixed with an explicit transaction; both behaviours are now asserted in
  `tests/security/withtenant-scope.test.ts`.

  The obvious alternative (`is_local => false`) was **rejected as dangerous**:
  it sets the value for the pooled *connection*, which then returns to the pool
  still carrying that tenant. Verified — the next borrower inherits it.

- **🟠 Tamper-guard tests passed for the wrong reason.** Our triggers raise
  SQLSTATE 42501, and so does a missing `GRANT`. The test role had no
  privileges on `portal_links`, so every guard test was green while proving
  nothing. Fixed with an `expectGuard()` helper that matches the guard's
  message and explicitly rejects `permission denied for table`.

- **🟠 The portal returned 500 on a database outage**, exposing a stack trace
  to an anonymous visitor. `resolvePortalToken` now never throws — any
  unexpected failure becomes a refusal, which is the fail-closed direction.
  Verified: with the database unreachable, the portal returns a clean 404.

### Security decisions worth knowing
- **Tokens are stored hashed.** A stolen backup yields hashes, not working
  links. The cost: a link is displayable exactly once and cannot be recovered.
- **Every failure returns the same 404.** "Revoked" and "never existed" are
  indistinguishable to a visitor; the real reason is logged server-side.
- **Signing requires `contracts:approve`; viewing requires `contracts:update`.**
  Someone who cannot approve internally cannot delegate that power outward.
- **Replay is prevented three ways:** an atomic compare-and-swap that consumes
  the link *before* writing the signature, a UNIQUE index on
  `portal_link_id`, and a contract status guard.
- **A view-only link can never be upgraded to signing** — that would turn a
  read-only share into signing authority without the recipient being told.
  Downgrading is allowed.
- **`Referrer-Policy: no-referrer` and `X-Frame-Options: DENY` on `/portal`.**
  The token is in the URL, so a `Referer` leak is the realistic risk — not
  brute force against 256 bits.

### Known limitations
- **SEC-020 (new, medium):** no rate limiting on `/portal/[token]`. Not a
  guessing risk; an abuse-of-invocations risk on the Hobby plan.
- This is an **electronic record of assent, not a PKI digital signature**, and
  the signer's identity is only as strong as their inbox. Both are stated in
  the product, not buried.

---

## [v0.8.0-alpha] — 2026-07-31 — Cloud Storage, Document Assembly & Transactional Email

**Security run:** PASS ([report](docs/SECURITY-REPORT-v0.8.0.md))
**Tests:** 165 passing (86 security + 79 UI) · **Build:** clean, 26 routes · **Prod vulns:** 0

### Added
- **`documents` table** (`db/schema/storage.ts`) — polymorphic attachments for
  contracts, assets, deals, contacts and companies. RLS `ENABLE` + **`FORCE`**,
  plus two immutability triggers (tenant and parent/pathname)
- **`/api/upload`** — Vercel Blob client-token issuer. Verifies the Clerk
  session, **rebuilds the storage path from the session's tenant id**, and
  attaches the content-type allowlist, size ceiling and a 10-minute expiry to
  the token itself
- **`/api/documents/[id]/download`** — authenticated streaming download. Files
  are stored **private**; this route re-checks session and tenant on every
  request
- **`saveDocumentRecord` / `getDocuments` / `deleteDocument`** — with parent
  ownership verification standing in for the foreign key a polymorphic link
  cannot have
- **`lib/email/resend.ts`** — typed dispatcher that never throws, degrades
  cleanly without an API key, and de-duplicates via idempotency keys
- **`ContractReadyEmail` and `LedgerAlertEmail`** — HTML + plain-text, every
  interpolation escaped, `href` schemes allowlisted
- **`DocumentVault`** — drag-and-drop, per-file progress, virtualized list
- **Contract detail page** with the vault mounted and a "Send to Client" flow
- **Contracts list page**
- **36 new tests** — 17 document isolation (real PostgreSQL), 19 Blob token
  authorisation, and 41 email-safety assertions

### Security decisions worth knowing
- **Blobs are `private`, not `public`.** A public blob URL is readable by
  anyone who ever sees it, forever, with no session and no tenant check — and
  RLS cannot help, because the bytes are not in PostgreSQL. This is the single
  most consequential choice in the phase.
- **The upload path is rebuilt server-side.** The client's requested pathname
  is ignored. Honouring it would let a caller request
  `tenants/<victim>/…` and receive a valid token to write there.
- **The email recipient comes from the database, not the request.** There is no
  `to` field on `sendContractToClient`; the address is read from the contract's
  linked contact. An email cannot be recalled, so this is not a field worth
  trusting a client with.
- **Deletion is asymmetric on purpose:** the blob is hard-deleted, the row is
  soft-deleted. The bytes are the confidential part; the row is the audit trail.
  The blob is removed FIRST, so a storage failure leaves the file visible and
  retryable rather than hidden-but-present.

### Fixed / avoided during this phase
- **`onUploadCompleted` removed rather than shipped broken.** `/api/upload` is
  not a public route, so `middleware.ts` requires a session — Vercel's
  server-to-server webhook would have received a 401 on every call. It also
  never fires on localhost. The authoritative write is the server action.
- **Literal control characters in two regexes**, in `sanitizeFileName` and
  `escUrl` — the same defect this codebase shipped once before in the URL
  sanitiser. Both rewritten with explicit `\u` escapes and tested against tab
  and newline scheme-splitting payloads.
- **A stray non-English word** in a code comment, and an `access: "public"`
  that contradicted the private-storage design, both caught before build.

### Known limitation
- **SEC-018 (new, low):** if the browser tab closes between the upload
  completing and `saveDocumentRecord` committing, the object is orphaned in
  storage with no row. A storage-cost leak, not an exposure — the object is
  private and unreachable without a row. A reconciliation sweep is the fix.

---

## [v0.7.0-alpha] — 2026-07-31 — The CRUD Surface & Application UI

**Security run:** PASS ([report](docs/SECURITY-REPORT-v0.7.0.md))
**Tests:** 19 UI + 69 security = 88 passing · **Build:** clean, 22 routes · **Prod vulns:** 0

### Added
- **Form infrastructure** — `useActionForm` hook wiring Zod schemas to server
  actions, with server field errors mapped back onto the inputs they belong to
- **`DynamicFieldSet`** — renders a working form from `custom_field_definitions`
  rows; 12 field types, no migration required to add one
- **Contacts** — create and edit pages, one component serving both modes
- **Companies** — full CRUD (`server/actions/companies.ts`), list, create, edit
- **Assets** — `server/actions/assets.ts` and a create page whose Details
  section is generated from the tenant's own field definitions
- **Accounting page** — trial balance, journal entry form, period list
- **Period close/reopen dialogs** — **resolves SEC-014**. Reopening requires a
  written reason of 15+ characters, recorded in the audit log
- **Settings** — General, Team and Financial tabs as separate routes
- **Role management** (`server/actions/team.ts`) — assign roles, suspend and
  reinstate, with three anti-escalation rules enforced server-side
- **`<Toaster />`** mounted in the root layout — without it every toast in the
  application was a silent no-op
- **UI test suite** — 19 tests in jsdom driving real components with real
  keyboard input; wired into the CI security gate as a required job

### Fixed
- **`watch("legs")` did not track the field array** in the journal entry form.
  The running balance read ₹0.00 no matter what was typed, so the submit button
  could never enable — **the accounting form was completely unusable**. Replaced
  with `useWatch`. Found by the balance-gate tests, not by reading the code.
- **`required` never reached the form controls.** Every field component passed
  it to the label (for the asterisk) but not to the input, so required fields
  were not announced to screen readers and browser validation never fired.
  Fixed across all five controls.
- **Six Zod schemas exported from `"use server"` files** (`accounting.ts`,
  `periods.ts`, `documents.ts`). Next.js compiles every non-async export in such
  a file into a public RPC endpoint; the build fails once a page imports it.
  Moved to `lib/validators/`. Verified the failure mode with a probe build
  rather than assuming it.
- **`ASSIGNABLE_ROLES` exported from `server/actions/team.ts`** — the same
  defect, introduced during this phase and caught by the build.
- Removed a duplicate role-ranking table from the team UI. Two copies of a
  privilege ordering is exactly the kind of duplication that drifts apart.

### Notes
- `tsc --noEmit` does **not** catch the `"use server"` export rule. Only
  `next build` does, and only once a page imports the file. A repository-wide
  scan for the pattern is now part of the release checks.
- Settings tabs are routes, not a client `<Tabs>` panel: each loads only its own
  data and gets a real, linkable URL.

---

## [v0.6.0-alpha] — 2026-07-31 — Automated Security Tests & CI

**Security run:** PASS ([report](docs/SECURITY-REPORT-v0.6.0.md))
**Tests:** 69 passing against real PostgreSQL 16 · **Build:** clean · **Prod vulns:** 0

### Added
- **Vitest setup** with a 6-check production-database guard (3 verified firing)
- **`tests/security/rls-isolation.test.ts`** — 24 tests
- **`tests/security/accounting-triggers.test.ts`** — 23 tests
- **`tests/security/audit-immutability.test.ts`** — 22 tests
- **`.github/workflows/security-ci.yml`** — 5 jobs, real Postgres service container
- **`docs/PROJECT-STATUS.md`** — full done/pending inventory

### Fixed
- **`drizzle.config.ts` pointed at `./db/schema.ts`**, which stopped existing in
  Phase 5. Every `drizzle-kit push`/`generate` would have failed.
- **Tests were connecting as a superuser**, which bypasses RLS entirely. Every
  isolation test would have passed while proving nothing. Now uses a
  non-superuser role, with a startup check that aborts if it detects one.

### Security
- **SEC-004 RESOLVED** — isolation is now machine-verified on every commit
- Coverage tests fail if any future table with a `tenant_id` lacks RLS or a policy
- Trigger *timing* asserted, not just existence: balance check deferred, period lock immediate

### Known limitations
- **SEC-016:** branch protection not yet enabled — CI reports but cannot block

---

## [v0.5.0-alpha] — 2026-07-31 — Financial Controls, RBAC, Audit & Dashboards

**Security run:** PASS ([report](docs/SECURITY-REPORT-v0.5.0.md))
**Build:** Clean · TS strict · 0 prod vulns · 10/10 period-lock · 11/11 RBAC · 7/7 permission engine

### Added
- **Financial period close** (`financial_periods` + `enforce_period_close` trigger) —
  the database rejects any journal entry dated inside a closed period, on INSERT,
  UPDATE and DELETE. Periods cannot overlap (`EXCLUDE USING gist`). **Resolves SEC-012.**
- **Period actions** (`server/actions/periods.ts`) — create, close (with trial-balance
  verification and a ledger snapshot), reopen (separate permission, written reason,
  critical-severity audit).
- **Permission catalog** (`db/schema/auth.ts`) — 50 permissions, 9 role templates,
  `permission_denials` table for security review.
- **Permission engine** (`lib/permissions.ts`) — pure, Edge-safe, fail-closed.
  Revoke always beats grant.
- **Audit enforcement** (`server/audit.ts`) — `checkPermission` / `requirePermission`
  decide and record in one call. Dangerous denials also write a `security_event`.
- **Executive dashboard** (`app/(crm)/dashboard/`) — Recharts, polymorphic by industry.
  Real estate: cost-to-completion, retainage, unit status. Legal: retainer balances,
  contract lifecycle. Every chart paired with a screen-reader data table.
- **Phase 5 seeder** — 9 users across 8 roles, 8 ledgers, 4 periods (2 closed),
  50 balanced transactions, 100 audit logs, 18 permission denials.
- **`SQL-FILES/` folder** — all SQL in one place. `ALL-IN-ONE-SETUP.sql` is now
  1,134 lines, 13 sections, 12 verification checks, 22 protected tables.

### Changed
- `audit_logs` gained `metadata` (jsonb) and `severity` columns.
- **Did NOT create `system_audit_logs`.** The Phase 1 `audit_logs` table already
  covers it and is already append-only. A second table would fragment the trail
  across two places, so proving anything would require querying both.
- **Did NOT redeclare `user_roles` / `role_permissions`.** Both exist from Phase 1;
  duplicating them would break the build and split authorization in two.

### Security
- 4 tables now append-only: audit_logs, contract_versions, journal_entries, permission_denials.
- Separation of duties verified by executed test: the Accountant role can post
  entries but cannot close a period.
- Unknown permission strings are DENIED — a typo cannot grant access.
- 22 tables under Row-Level Security.

### Known limitations
- No UI for period close — server action only (SEC-014)
- No admin UI for permission overrides (SEC-015)
- **No automated cross-tenant isolation test suite (SEC-004)** — the most valuable
  remaining gap

---

## [v0.4.0-alpha] — 2026-07-31 — Legal CLM, Trust Accounting, Grid Persistence & Workers

**Security run:** PASS ([report](docs/SECURITY-REPORT-v0.4.0.md))
**Build:** Clean · TS strict · 0 prod vulnerabilities · 7/7 balance tests · 10/10 worker auth · 12/12 grid checks

### Added
- **Grid persistence** (`server/actions/grid.ts`) — `updateAssetCell`,
  `updateCustomRecordCell`, `bulkUpdateAssetStatus`. JSONB path allowlisting,
  prototype-pollution guards, depth/key caps, full audit trail. **Resolves SEC-009.**
- **Legal CLM** (`db/schema/clm.ts`) — `contracts`, `contract_versions`
  (immutable, SHA-256 hash-chained), `clause_library`.
- **Double-entry accounting** (`db/schema/accounting.ts`) — `ledgers`,
  `transactions`, `journal_entries`. Trust/escrow/retention ledger types.
- **Balance enforcement** — deferred constraint trigger validates debits = credits
  at COMMIT. Exact BigInt paise arithmetic in the app layer; NUMERIC(18,2) in the DB.
- **BullMQ queue** (`lib/queue/bullmq.ts`, `lib/queue/processors.ts`) — 4 job kinds,
  tenant-asserted payloads, graceful degradation when Redis is absent.
- **Worker endpoint** (`app/api/workers/route.ts`) — QStash signature, bearer secret
  (timing-safe), or Vercel Cron. Fail-closed. Bounded to 7.5s / 5 jobs.
- **Document assembly** (`server/actions/documents.ts`) — merge-field resolution,
  version chaining, `verifyContractIntegrity()`.
- **Contract renderer** (`lib/documents/render.ts`) — print-optimised HTML, fully escaped.
- **⭐ `ALL-IN-ONE-SETUP.sql`** — every migration (Phases 1–4) consolidated into one
  idempotent file with six built-in verification checks.

### Security
- Money never touches a JS float — proven in test: `0.1 + 0.2 !== 0.3`.
- Journal entries, contract versions and audit logs are all append-only at DB level.
- Cross-tenant journal posting blocked by trigger (ledger AND transaction tenancy).
- Worker secrets compared with `timingSafeEqual` — `===` leaks the prefix by timing.
- 20 tables now under Row-Level Security.

### Known limitations
- No period-close locking — back-dated entries are possible (**SEC-012**, Phase 5)
- PDF output is print-ready HTML, not binary PDF (SEC-011)
- Bank reconciliation schema exists but has no UI (SEC-013)

---

## [v0.3.0-alpha] — 2026-07-31 — Industry Routing, Asset Catalog & Virtual Grids

**Security run:** PASS ([report](docs/SECURITY-REPORT-v0.3.0.md))
**Build:** Compiles clean · TypeScript strict · 0 production vulnerabilities · 33/33 XSS checks pass

### Added
- **Industry routing engine** (`lib/industry-templates.ts`, `app/(crm)/layout.tsx`) —
  Real Estate Developer and Legal Advocate templates. Navigation, dashboard widgets
  and terminology morph from one database field. Role-filtered server-side.
- **Universal asset schema** (`db/schema/assets.ts`) — `assets` (20 asset types,
  12 statuses, JSONB attributes, GIN-indexed) and `asset_relationships` (graph edges
  with 8 relationship types).
- **Virtualized grid** (`components/crm/virtual-grid.tsx`) — TanStack Table v8 +
  TanStack Virtual. Infinite scroll, inline editing with optimistic updates,
  bulk selection, dynamic JSONB columns. Constant DOM footprint.
- **Safe rendering layer** (`lib/safe-render.ts`) — XSS-hardened JSONB display.
- **Stress-test seeder** (`scripts/seed-basaveshwar-project.ts`) — real Basaveshwar
  Nagar development: 194 assets, 193 relationships, 4-level-deep JSONB.
- **Global search** (`server/actions/search.ts`) — 4 entities, tenant-filtered first.
- **TanStack Query provider** (`app/providers.tsx`) — per-session client.
- RLS policies + cross-tenant graph triggers (`0003_phase3_rls.sql`).

### Fixed
- Literal control characters were written into `lib/safe-render.ts`, making it a
  binary file and the URL-sanitising regex unreliable. Replaced with explicit
  `\u0000-\u001F` escapes. This mattered: `java\tscript:` executes in browsers.
- Email validation allowed `<script>@evil.com` (no whitespace, one `@`). Replaced
  the permissive pattern with an RFC 5322 dot-atom allowlist.
- `onCommit` type mismatch in the dynamic column builder.

### Security
- 33/33 XSS payloads blocked by an executed test suite, not inspection.
- Tenant filter verified as the FIRST predicate in all 4 search queries by parsing source.
- Cross-tenant asset graph edges blocked at the database level.
- Self-referencing asset edges blocked (would loop tree traversal forever).
- Prototype-pollution keys blocked in JSONB path lookups.
- `QueryClient` created per session — a module-level client leaks cache across tenants during SSR.

### Known limitations
- Inline edits do not persist — `onCellEdit` is a stub pending Phase 4 (**SEC-009**)
- `/assets` caps at 1,000 rows; needs cursor pagination (SEC-010)
- No CSP yet (SEC-002); no rate limiting on search (SEC-005)

---

## [v0.2.0-alpha] — 2026-07-31 — Vertical Core, Clerk Sync & Custom Objects

**Security run:** PASS ([report](docs/SECURITY-REPORT-v0.2.0.md))
**Build:** Compiles clean · TypeScript strict · 0 production vulnerabilities · Middleware 87.1 kB

### Added
- **Clerk organization webhook** (`app/api/webhooks/clerk/route.ts`) — Svix-verified,
  handles `organization.created/updated/deleted` and `organizationMembership.created/updated/deleted`.
  Auto-provisions tenants with default branding, INR/IST settings and a 14-day trial.
- **CRM entities** (`db/schema/crm.ts`) — `companies`, `contacts`, `deals` with
  JSONB custom fields, GIN indexes, soft delete and tenant-led composite indexes.
- **Dynamic custom object engine** (`db/schema/custom-objects.ts`) —
  `custom_object_definitions`, `custom_field_definitions`, `custom_object_records`.
  Tenants define new business entities with zero migrations. 12 field types.
- **Server actions** (`server/actions/`) — full CRUD for contacts, define/read/create
  for custom objects. All Zod-validated, all tenant-scoped from the session.
- **Data grid** (`components/crm/data-grid.tsx`) — TanStack Table v8, sorting,
  pagination, search, WCAG 2.1 AA (aria-sort, keyboard rows, live regions).
  `buildDynamicColumns()` renders JSONB custom fields by declared type.
- **Schema barrel** (`db/schema/index.ts`) — single import surface.
- **Validators** (`lib/validators/crm.ts`) — schemas and pure helpers, importable by clients.
- RLS policies and cross-tenant reference triggers for all six new tables (`0002_phase2_rls.sql`).

### Fixed
- Build failure: `"use server"` files may only export async functions. Zod schemas and
  pure helpers moved to `lib/validators/crm.ts` — also removes them as unintended RPC endpoints.

### Security
- 10/10 server actions verified to derive `tenantId` from session and scope every query.
- `tenantId` is structurally impossible to supply from the client.
- Webhook ordering verified: raw body read → signature verified → only then any DB write.
- Cross-tenant FK references blocked by `assert_same_tenant()` database triggers.
- Unknown JSONB keys rejected rather than stored; `javascript:`/`data:` URLs blocked.

### Known limitations
- `updateCustomRecord` / `deleteCustomRecord` not yet implemented (SEC-007)
- `isUnique` on custom fields declared but not enforced (SEC-008)
- No CSP yet — needs nonce configuration for Clerk (SEC-002)
- Webhook endpoint is not rate-limited (SEC-005)

---

## [v0.1.0-alpha] — 2026-07-31 — Foundation

**Security run:** ✅ PASS ([report](docs/SECURITY-REPORT-v0.1.0.md))
**Build:** ✅ Compiles clean · TypeScript strict · 0 production vulnerabilities

### Added
- Next.js 15 App Router project, TypeScript strict mode (`noUncheckedIndexedAccess` on)
- Complete Drizzle schema: `tenants`, `users`, `roles`, `permissions`,
  `role_permissions`, `user_roles`, `audit_logs`
- PostgreSQL Row-Level Security policies on all six tenant tables
- Append-only `audit_logs` enforced by database triggers
- Edge multi-tenant middleware with header-spoofing defense and host/session verification
- Serverless-optimised Neon client with `withTenant()` transaction scoping
- Zod-validated environment with browser-access guard
- Tenant-namespaced Redis cache and rate limiter
- Security headers (HSTS, nosniff, frame-options, permissions-policy)
- Clerk Organizations integration — sign-in, sign-up, onboarding, dashboard
- Deployment guide, cost/upgrade guide, security report

### Security
- Pinned `postcss ^8.5.25`, `sharp ^0.35.3`, `brace-expansion ^2.0.2` via overrides
- Upgraded `drizzle-orm` → 0.45.2 (resolved HIGH advisory)
- Reduced 18 vulnerabilities → **0 in production dependencies**
- Disabled production source maps and `x-powered-by` header

### Known limitations
- Tenant rows are not auto-created yet — Clerk webhook lands in Phase 2 (SEC-003)
- No Content-Security-Policy yet — needs nonce config for Clerk (SEC-002)
- BullMQ workers cannot run on Vercel; separate host needed from Phase 3 (SEC-006)
