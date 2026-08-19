# Project Status — Ordence

**As of:** 31 July 2026 · **Version:** v0.10.0-alpha
**Blueprint:** 148 parts · **Phases built:** 10

---

# PART 1 — WHAT IS DONE

## The honest headline

You have a **working, secure, deployable multi-tenant SaaS foundation** — about
**5–8% of the 148-part blueprint** by scope, but it is the hardest and most
load-bearing 5–8%. Isolation, financial integrity and audit trails are the things
that are ruinously expensive to retrofit. Everything above them is comparatively
ordinary product work.

| Metric | Value |
|---|---|
| Source files | 149 |
| Database tables | 26 |
| Server actions | 61 |
| Automated tests | **228, all passing** (126 security + 102 UI) |
| Tables under Row-Level Security | 25 |
| Append-only evidence tables | 5 |
| Production dependency vulnerabilities | **0** |
| Live routes | 28 |

---

## Phase 1 — Foundation (v0.1.0)

| Delivered | Detail |
|---|---|
| Multi-tenant schema | `tenants`, `users`, `roles`, `permissions`, `role_permissions`, `user_roles`, `audit_logs` |
| Row-Level Security | Every tenant table, `ENABLE` + `FORCE` |
| Edge middleware | Strips spoofable headers, verifies host matches session org |
| Serverless DB client | Neon HTTP driver, `withTenant()` transaction scoping |
| Env validation | Zod, throws if server secrets are touched in the browser |
| Security headers | HSTS, nosniff, frame-options, permissions-policy |
| Clerk Organizations | Sign-in, sign-up, onboarding, dashboard |

**Fixed during build:** Clerk 6.39 required a newer Next than pinned;
`serverComponentsExternalPackages` renamed in Next 15. Both would have failed on Vercel.

---

## Phase 2 — Vertical Core (v0.2.0)

| Delivered | Detail |
|---|---|
| Clerk webhook | Svix-verified, auto-provisions tenants, idempotent |
| CRM entities | `companies`, `contacts`, `deals` with JSONB custom fields |
| Custom object engine | `custom_object_definitions`, `custom_field_definitions`, `custom_object_records` — tenants define entities with **zero migrations**, 12 field types |
| Server actions | Full CRUD, Zod-validated, tenant-scoped from session |
| Data grid | TanStack Table v8, WCAG 2.1 AA |
| Cross-tenant FK triggers | A plain FK proves a row *exists*, not that it belongs to you |

**Fixed during build:** `"use server"` files may only export async functions —
exported Zod schemas were becoming unintended RPC endpoints.

---

## Phase 3 — Industry Routing & Assets (v0.3.0)

| Delivered | Detail |
|---|---|
| Polymorphic UI engine | Real Estate + Legal templates. Navigation, dashboard and vocabulary change from **one database field** |
| Universal asset schema | `assets` (20 types, 12 statuses) + `asset_relationships` (graph, 8 edge types) |
| Virtualized grid | TanStack Virtual — constant DOM footprint regardless of row count |
| Safe rendering | XSS-hardened JSONB display |
| Global search | 4 entities, tenant filter **first** in every query |
| Basaveshwar Nagar seeder | 194 assets, 193 relationships, cost analysis 4 levels deep |

**Two real defects found by testing rather than reading:** literal control
characters made the URL sanitizer unreliable (`java\tscript:` executes in
browsers); email validation accepted `<script>@evil.com`.

---

## Phase 4 — CLM, Accounting & Workers (v0.4.0)

| Delivered | Detail |
|---|---|
| Contract lifecycle | `contracts`, `contract_versions` (immutable, SHA-256 hash-chained), `clause_library` |
| Double-entry accounting | `ledgers`, `transactions`, `journal_entries`. Trust/escrow/retention types |
| Balance enforcement | **Deferred** constraint trigger — debits must equal credits at COMMIT |
| Exact money arithmetic | BigInt paise in the app, `NUMERIC(18,2)` in the database |
| BullMQ queue | 4 job kinds, tenant-asserted payloads, degrades gracefully without Redis |
| Worker endpoint | QStash signature / bearer secret (`timingSafeEqual`) / Vercel Cron. Fail-closed |
| Document assembly | Merge fields, version chaining, `verifyContractIntegrity()` |
| Grid persistence | **Resolved SEC-009** — inline edits now save |
| Consolidated SQL | One idempotent file, all phases |

---

## Phase 5 — Controls, RBAC & Dashboards (v0.5.0)

| Delivered | Detail |
|---|---|
| Period close | **Resolved SEC-012** — database rejects any entry dated inside a closed period |
| Non-overlapping periods | `EXCLUDE USING gist` makes overlap unrepresentable |
| Permission catalog | 50 permissions, 9 role templates |
| Permission engine | Pure, Edge-safe, fail-closed. Revoke always beats grant |
| Audit enforcement | `checkPermission` decides **and** records denials in one call |
| Executive dashboard | Recharts, polymorphic. Real estate: cost-to-completion, retainage. Legal: retainer balances, contract stages |
| Phase 5 seeder | 9 users / 8 roles, 8 ledgers, 4 periods, 50 balanced transactions, 100 audit logs |

**Separation of duties:** the Accountant role can post entries but **cannot close
a period**. Recording numbers and declaring them final are different jobs.

---

## Phase 6 — Test Automation & CI (v0.6.0)

| Delivered | Detail |
|---|---|
| Vitest configuration | Sequential execution (RLS is transaction-scoped) |
| Production-DB guard | **6 independent checks** before a single test runs |
| RLS isolation suite | **24 tests** — read, write, fail-closed, reference guards, coverage |
| Financial integrity suite | **23 tests** — balance, period lock, float precision, reconciliation |
| Audit immutability suite | **22 tests** — UPDATE/DELETE blocked on all 4 evidence tables |
| GitHub Actions CI | 5 jobs: build, security tests, dependency audit, secret scan, gate |

**Verified against a real PostgreSQL 16**, not mocks. **Resolves SEC-004.**

---

## Phase 7 — CRUD Surface & Application UI (v0.7.0)

| Delivered | Detail |
|---|---|
| Form infrastructure | `useActionForm` — Zod + server actions, server field errors mapped back onto inputs |
| Dynamic JSONB forms | `DynamicFieldSet` renders working inputs from `custom_field_definitions`. **6 input types verified by rendering** |
| Contacts & Companies | Full create/edit. Companies CRUD built from scratch |
| Assets | Create page whose Details section is generated per industry |
| Accounting page | Trial balance, journal form, period list |
| Period close/reopen | **Resolves SEC-014.** Reopening demands a 15+ character written reason |
| Settings | General / Team / Financial, as routes rather than client tab panels |
| Role management | Three anti-escalation rules, enforced server-side |
| UI test suite | **19 tests** driving real components with real keyboard input, wired into the CI gate |

**Two real defects caught by testing rather than reading.** The journal form's
running balance never updated — the accounting screen was completely unusable
while looking correct in code review. And `required` never reached any form
control, so screen readers were not told which fields were mandatory.

**A third class of defect caught by building:** seven Zod schemas were exported
from `"use server"` files, where Next.js turns every non-async export into a
public RPC endpoint. `tsc` does not catch this; only `next build` does.

---

## Phase 8 — Storage & Email (v0.8.0)

| Delivered | Detail |
|---|---|
| `documents` table | Polymorphic attachments for 5 entity types. RLS `ENABLE` + `FORCE`, plus tenant- and parent-immutability triggers |
| Direct-to-cloud uploads | Browser → Vercel Blob, bypassing the 4.5 MB serverless body limit entirely |
| Blob token issuer | Clerk session enforced; **storage path rebuilt from the session's tenant**, client path ignored |
| Private file storage | Files are not readable by URL. Downloads stream through a route that re-checks session and tenant every time |
| Document Vault | Drag-and-drop, per-file progress, virtualized list, download and delete |
| Transactional email | Resend dispatcher that never throws and degrades cleanly without a key |
| Two email templates | `ContractReadyEmail`, `LedgerAlertEmail` — HTML + text, every value escaped, `href` schemes allowlisted |
| Contract detail page | Vault mounted, version history, "Send to Client" with confirmation |

**36 new tests.** 19 prove the Blob token issuer refuses anyone without a valid
session and ignores a client-supplied path aimed at another tenant. 17 prove
`documents` is isolated by tenant against a real PostgreSQL as a non-superuser.

**The decision that matters most:** files are stored **private**, not public. A
public blob URL is readable by anyone who ever sees it, forever, with no session
and no tenant check — and RLS cannot help, because the bytes are not in Postgres.

**Caught during the build:** an `onUploadCompleted` webhook that our own
middleware would have rejected on every call, and literal control characters in
two regexes — the same defect this codebase shipped once before in Phase 3.

---

## Phase 9 — External Client Portal (v0.9.0)

| Delivered | Detail |
|---|---|
| `portal_links` | 256-bit bearer tokens stored as SHA-256 hashes. RLS + a tamper guard covering token, target, permission and expiry |
| `contract_signatures` | Append-only evidence: IP, user agent, content hash, verbatim consent text |
| Sessionless resolution | `token → resolve → tenantId → withTenant() → RLS` — the only path in the platform that starts without Clerk |
| Public portal page | Branded, read-only, no account required, no navigation into the app |
| Signature engine | Three independent layers of replay prevention |
| Portal manager | One-time link reveal, copy, revoke, revoke-all |
| Email integration | `ContractReadyEmail` now carries the portal URL, not an internal route |

**A pre-existing bug from Phase 1 found and fixed:** `withTenant()` set the
tenant with a transaction-local `set_config` but opened no transaction, so the
setting was discarded before the next query and every RLS-scoped read returned
**zero rows**. It failed closed — nothing leaked — but the function did not
work. The obvious fix (session-scoped config) was rejected after verifying it
leaks the tenant to the next borrower of the pooled connection.

**A test-quality bug found and fixed:** every tamper-guard test initially
passed because a missing `GRANT` raises the same SQLSTATE as our triggers.
Green, and proving nothing.

---

## Phase 10 — Executive Dashboards (v0.10.0)

| Delivered | Detail |
|---|---|
| Three SQL analytics views | All `security_invoker = true`; asset portfolio, 30-day ledger spine, contract pipeline |
| Streaming dashboard | Six independent `<Suspense>` boundaries — the page fills in rather than blocking on the slowest aggregate |
| Skeleton loaders | Reserve layout, so nothing jumps as panels arrive |
| Three visualisations | Financial bars, portfolio donut, virtualized activity feed |
| Quick actions | One click to journal entry, contract upload, client link |
| `npm run db:verify` | Interrogates the live database; exits non-zero if protection is missing |

**⭐ RLS does NOT cascade into SQL views.** A view runs as its OWNER, not the
caller. Measured before writing any view: a session pinned to one tenant saw
**6 tenants** through a naive view and **1** through a `security_invoker` view.
Nothing errors — the dashboard just shows the whole platform's money as yours.

**🔴 `drizzle-kit push` drops every RLS policy.** Measured: 25 policies before,
**0 after**. The app keeps working; only the tenant boundaries are gone. Mitigated
with `db:verify`, a warning on `db:push`, a CI gate, and documentation.

**Recharts does not bloat the bundle** — 1 of 33 routes, 105 kB gzipped, shared
baseline unchanged.

---

## What has been genuinely proven, not just claimed

These are executed test results, not design intentions:

- **Tenant B cannot read, update or delete Tenant A's data** — by exact record ID
- **No tenant context returns ZERO rows**, never all rows, across 22 tables
- **Unbalanced entries are rejected**, including a one-paisa difference
- **Back-dated entries into closed periods are rejected**
- **Audit logs cannot be edited or deleted** — SQLSTATE 42501
- **`0.1 + 0.2 !== 0.3`** in floats; our BigInt path is exact
- **`javascript:` URLs are blocked** — 33/33 XSS payloads
- **No server secrets in the client bundle** — grepped from compiled output
- **Unbalanced entries cannot be submitted from the UI** — 9 rendering tests
- **A JSONB key with no field definition is stripped**, not stored
- **All 16 new server actions carry a tenant guard** — verified mechanically
- **One tenant cannot read, alter or delete another's documents** — 17 tests
- **A document cannot be moved between tenants even by a SUPERUSER** — trigger, not policy
- **An upload token cannot be steered into another tenant's storage prefix**
- **33+ XSS payloads are neutralised in outbound email**
- **Portal tokens are 256-bit CSPRNG** — 0 collisions in 20,000 draws
- **Expired, revoked and unknown tokens are all refused** — with the same 404
- **A signing link works exactly once** — proven by a UNIQUE index and a compare-and-swap
- **A portal link cannot be re-aimed, upgraded or extended** — triggers, not policy
- **Aggregate views isolate by tenant** — A sees ₹5,000,000, not B's ₹9,999,999
- **A naive view demonstrably leaks** — proven side by side in a test
- **Dashboard totals reconcile exactly with the ledger** — same rows, BigInt arithmetic

---

# PART 2 — WHAT IS PENDING

## A. Open security items

| ID | Item | Severity | Notes |
|---|---|---|---|
| **SEC-001** | Run `ALL-IN-ONE-SETUP.sql` on production | **BLOCKING** | Nothing is protected until this runs |
| SEC-002 | Nonce-based Content-Security-Policy | Medium | Clerk injects inline scripts; needs nonce config |
| SEC-005 | Rate limiting on search, webhook + **upload tokens** | Medium | Upstash Ratelimit is already wired |
| **SEC-018** | **Orphaned blobs** — needs a reconciliation sweep | **Low (new)** | Storage cost, not exposure |
| SEC-019 | No virus scanning on upload | Low | Needs a paid third-party service |
| **SEC-022** | **`db:push` drops RLS policies — prefer `db:generate`** | **High (new)** | Mitigated by `db:verify` + CI |
| SEC-023 | Analytics views re-aggregate per load | Low (new) | Revisit past ~1M journal entries |
| SEC-011 | Binary PDF output | Low | Currently print-ready HTML |
| SEC-013 | Bank reconciliation UI | Medium | Schema exists, no interface |
| SEC-015 | Permission override admin UI | Low | Engine supports it, no screen |

**Closed:** SEC-004 (Phase 6), SEC-009 (Phase 4), SEC-012 (Phase 5), **SEC-014 (Phase 7)**.

---

## B. Product gaps you will hit soonest

These are not in any phase yet and will block real use:

| # | Gap | Why it matters |
|---|---|---|
| ~~1~~ | ~~No create/edit forms~~ | ✅ **Done in Phase 7** |
| ~~2~~ | ~~No companies pages~~ | ✅ **Done in Phase 7** |
| ~~3~~ | ~~No settings screens~~ | ✅ **Done in Phase 7** |
| 1 | **No deals or contracts pages** | Schema and actions exist; no UI |
| ~~2~~ | ~~No file uploads~~ | ✅ **Done in Phase 8** |
| ~~3~~ | ~~No email sending~~ | ✅ **Done in Phase 8** (notifications; invitations still to come) |
| 2 | **No billing** | Cannot charge a customer |
| ~~3~~ | ~~No e-signature~~ | ✅ **Done in Phase 9** (electronic assent, not PKI) |
| 4 | **No end-to-end test** | Each layer is tested; their composition is not |
| 5 | **No virus scanning on upload** | Risk is to whoever opens the file, not to the app |

> **My read:** the product is now demonstrable. You can sign in, create a
> company, add contacts to it, register an asset with industry-specific
> fields, post a balanced journal entry, close the period and manage who has
> access. What remains before you can *charge* for it is billing and email.

---

## C. Blueprint parts not started

Of 148 parts, roughly **127 remain**. The largest untouched blocks:

| Area | Blueprint parts | Status |
|---|---|---|
| Billing & subscriptions | 11, 46, 47, 50 | Not started |
| Super Admin command center | 7 | Not started |
| API platform & developer portal | 9, 59 | Not started |
| White-label & custom domains | 10, 51 | Schema only |
| Guest / external portals | 22 | Not started |
| Import / migration engine | 21, 28, 64 | Not started |
| AI features & RAG | 29, 48, 67 | Not started |
| Marketplace & plugins | 41, 59, 132–148 | Not started |
| Mobile / offline | 39 | Not started |
| Multi-region & data residency | 42 | Not started |
| Contact centre | 66 | Not started |
| Workflow automation builder | 30 | Not started |

---

## D. Operational items

| Item | Status |
|---|---|
| GitHub repository | ⚠️ Confirm it is **private** |
| Vercel deployment | ⚠️ Confirm environment variables are set and redeployed |
| Branch protection on `main` | ❌ Not enabled — CI cannot block a merge without it |
| Upstash Redis | ⚠️ Optional; queue degrades gracefully without it |
| `_to_delete/` folder | ⚠️ Safe to delete — stale files from earlier phases |
| Custom domain | ❌ Not configured |
| Vercel Pro upgrade | ❌ **Required before your first paying customer** (Hobby forbids commercial use) |

---

# PART 3 — WHAT I WOULD DO NEXT

**Phase 9 — commercial readiness.** Billing, subscriptions, plan gating, and the
Super Admin console. This is now the only thing standing between a working
product and revenue.

**Phase 10 — collaboration.** E-signature, team invitations by email, in-app
notifications, and the deals pipeline UI.

**Phase 10 — confidence.** An end-to-end suite driving a real browser against a
real database. Every layer is tested individually today; nothing yet tests them
working together, and Phase 7 demonstrated that a component can be individually
correct and collectively broken.

**Before any customer sees this:** run `ALL-IN-ONE-SETUP.sql`, enable branch
protection, and upgrade to Vercel Pro. The first is a security blocker, the
third is a licensing one.
