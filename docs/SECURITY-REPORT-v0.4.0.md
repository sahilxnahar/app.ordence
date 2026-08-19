# Phase 4 Security, Financial Integrity & Build Report — v0.4.0-sec

**Build:** v0.4.0-alpha
**Date:** 31 July 2026
**Scope:** Grid persistence (SEC-009), CLM schema, double-entry accounting, BullMQ workers, document assembly
**Verdict:** ✅ **PASS — cleared for deployment**

---

## 1. Double-entry financial integrity ⭐

The highest-stakes requirement in this phase. A trust ledger that can hold an
unbalanced entry is not an accounting system — it is a liability.

### 1a. Executed arithmetic test — **7/7 correct**

```
PASS  Simple balanced transfer                D=1500.00     C=1500.00     diff=0.00
PASS  Split credit balances                   D=1000.00     C=1000.00     diff=0.00
PASS  Off by one paisa (must FAIL)            D=1000.00     C=999.99      diff=0.01
PASS  Float-trap: 0.10 + 0.20 = 0.30          D=0.30        C=0.30        diff=0.00
PASS  Large: 1 crore split 3 ways             D=10000000.00 C=10000000.00 diff=0.00
PASS  Rounding drift accumulates (must FAIL)  D=10000000.00 C=9999999.99  diff=0.01
PASS  Retention split                         D=2980000.00  C=2980000.00  diff=0.00
```

**Why this test exists.** Executed in the same run:

```
JS float:  0.1 + 0.2 = 0.30000000000000004   (=== 0.3? false)
Our math:  0.10 + 0.20 = 0.30                (exact)
```

Money is never a JavaScript `number` in this codebase. Amounts are decimal
strings, summed as `BigInt` paise. The "1 crore split 3 ways" cases matter
because that is exactly where naive rounding produces a one-paisa hole that
compounds silently across a year of entries.

### 1b. Three enforcement layers

| Layer | Mechanism | Survives |
|---|---|---|
| Zod schema | `superRefine` sums legs in `BigInt`, rejects imbalance with the exact difference | Gives the user a usable error |
| Server action | Ledger ownership, currency match, active-status checks before write | Business-rule violations |
| **Database** | `CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED` | **Any application bug, raw SQL, or future service** |

**Why the trigger must be DEFERRED, not row-level:** saving a transaction inserts
several rows, one per leg. A row-level trigger would fire on the first insert —
when only one side exists — and reject every transaction ever attempted.
`DEFERRABLE INITIALLY DEFERRED` moves the check to COMMIT, once all legs are
present. This is the single detail that makes the constraint workable.

### 1c. Supporting financial guarantees

| Control | Implementation |
|---|---|
| Amounts always positive | `CHECK (amount > 0)`; direction carried by `entry_type`, never a minus sign |
| Journal is append-only | `BEFORE UPDATE`/`BEFORE DELETE` triggers raise `insufficient_privilege` |
| Corrections leave a trail | `reverseTransaction()` posts a mirror entry; both rows remain visible |
| Cross-tenant posting blocked | `assert_journal_entry_tenant()` verifies ledger AND transaction tenancy |
| Currency mixing blocked | All ledgers in a transaction must share the transaction's currency |
| Cached balance verifiable | Check 5 in the SQL file reconciles `ledgers.current_balance` against `SUM(journal_entries)` |
| Minimum two legs | Rejected at both Zod and trigger level — one entry can never balance |

**A deliberate design decision:** `entry_type` + positive amount, rather than
signed amounts. Signed amounts plus a direction flag give two ways to express the
same fact, and therefore two ways to disagree with each other.

---

## 2. BullMQ worker endpoint authentication

`/api/workers` executes background work. An unauthenticated version of this route
would let an attacker drain another tenant's queue, or force expensive
aggregations repeatedly to burn the Vercel quota — a financial denial-of-service,
since Vercel bills on usage past the free tier.

**10/10 checks pass:**

| Check | Result |
|---|---|
| Fail-closed when no auth method configured (503) | ✅ |
| QStash `Receiver` cryptographic signature verification | ✅ |
| Raw body read **before** auth, preserving signature integrity | ✅ |
| `timingSafeEqual` for the bearer secret | ✅ |
| No plain `===` comparison on any secret | ✅ |
| Jobs per invocation bounded (5) | ✅ |
| Time budget 7.5s, under the 10s Hobby cap | ✅ |
| `assertJobTenant()` on every job before database access | ✅ |
| Queue name validated against an allowlist | ✅ |
| GET (queue depth) authenticated too | ✅ |

**Why `timingSafeEqual` and not `===`:** a plain comparison returns as soon as it
finds a differing byte, so response time reveals how many leading characters were
correct. Given enough requests an attacker recovers the secret one character at a
time. This is a demonstrated attack, not a theoretical one.

**Queue tenant isolation:** background jobs run with no HTTP request and no Clerk
session. Every payload carries `tenantId`, and processors call `withTenant()` to
pin RLS context. A job missing a valid tenant is rejected loudly rather than
running with a NULL context.

---

## 3. SEC-009 — RESOLVED

Phase 3 shipped the grid's optimistic UI wired to a stub that resolved a timer.
Edits appeared to save and reverted on refresh. **Now closed:** `handleCellEdit`
calls `updateAssetCell()`, and throws on failure — which is what triggers the
optimistic rollback, so a rejected save visibly reverts rather than appearing to
have worked.

### The specific hazard, and the 12 controls applied

The grid sends `columnId` values like `"dynamicAttributes.pricing.allInPrice"` —
a **client-supplied path into a JSONB blob**. Written naively that is a direct
route to overwriting arbitrary keys.

**12/12 checks pass:**

| Control | Result |
|---|---|
| JSONB column name checked against allowlist (never interpolated) | ✅ |
| Scalar column checked against allowlist | ✅ |
| Every path segment matched against `^[a-zA-Z0-9_]+$` | ✅ |
| `__proto__` / `constructor` / `prototype` rejected | ✅ |
| Nested writes build `Object.create(null)` objects | ✅ |
| Path depth capped at 4 | ✅ |
| Total key count capped at 200 | ✅ |
| Enum columns validated against `enumValues` | ✅ |
| Custom fields must exist in `custom_field_definitions` | ✅ |
| Full record re-validated via `validateRecordData` | ✅ |
| `tenantId` absent from the input schema entirely | ✅ |
| Every edit written to `audit_logs` | ✅ |

---

## 4. Contract integrity

`contract_versions` is append-only (trigger-enforced) and forms a **hash chain**:
each version stores a SHA-256 of its body plus its parent's hash.

`verifyContractIntegrity()` walks the chain and recomputes every hash. If a
version were altered at the storage layer — a restored backup, a direct database
edit — its hash no longer matches and its child's `previousVersionHash` breaks
too. Tampering becomes detectable rather than silent.

**Additional protections:** signed and executed contracts reject further
assembly; `legalHold` blocks modification entirely; unresolved `{{merge_fields}}`
are left **visible** rather than blanked — a contract reading "Payment of  shall
be due" looks executed, while "Payment of {{amount}} shall be due" is obviously
unfinished.

---

## 5. Row-Level Security — Phase 4 tables

Six new tables, all now covered: `contracts`, `contract_versions`,
`clause_library`, `ledgers`, `transactions`, `journal_entries`.

**Total protected tables: 20.** All policies consolidated into
`db/migrations/ALL-IN-ONE-SETUP.sql`.

Cross-tenant reference guards added for `contract.asset_id`,
`contract.contact_id`, `contract.company_id` and `contract_version.contract_id`.

> **SEC-001 (Phase 4):** run `ALL-IN-ONE-SETUP.sql` after `drizzle-kit push`.
> Until then the six new tables — including the trust ledger — have no
> database-level isolation.

---

## 6. Build integrity

```
npx tsc --noEmit    → ✅ 0 errors (strict, noUncheckedIndexedAccess)
npx next build      → ✅ Compiled successfully
```

| Route | Type | Size |
|---|---|---|
| `/api/workers` | Dynamic (Node) | 134 B |
| `/assets` | Dynamic | 14.3 kB → 143 kB |
| Middleware | Edge | **87.1 kB** (8.7% of 1 MB limit) |

Shared JS unchanged at **102 kB** — BullMQ and ioredis are server-only and never
enter the client bundle.

---

## 7. Serverless safety

| Concern | Assessment |
|---|---|
| 10s timeout | Worker capped at 7.5s budget, 5 jobs max, `maxDuration = 10` |
| Redis connection leak | Single cached `IORedis` instance; `connectTimeout: 5s` fails fast |
| Memory | Job payloads are small; no accumulating in-process state |
| Upstash free-tier quota | `removeOnComplete: {age: 3600, count: 100}` bounds queue history |
| Rate burst | Worker `limiter: {max: 20, duration: 1000}` |
| Graceful degradation | No `REDIS_URL` → `enqueueJob` returns `{queued:false}`, app renders inline |

**Stated honestly:** you cannot run a BullMQ worker on Vercel. A worker needs a
long-lived process blocking on Redis; Vercel kills functions when the request
ends. The hybrid here — enqueue from Vercel, drain via an authenticated endpoint
triggered by QStash — keeps BullMQ semantics on a free tier. When you outgrow it,
`createWorker()` runs unchanged on Railway/Fly/Render.

---

## 8. PDF generation — an honest limitation

`generate_pdf` produces **print-optimised HTML**, not a binary PDF.

Real PDF rendering needs headless Chromium (~200 MB) or a native library. Neither
fits in a Vercel Hobby function; bundling Puppeteer would exceed the size limit
outright. The options are: (a) print-ready HTML, (b) a paid PDF service, (c) a
worker host with Chromium.

(a) is implemented because it works today at zero cost and produces a genuinely
usable document — correct pagination, running headers, signature blocks,
watermark. "Print → Save as PDF" gives a real PDF. The seam for (b) and (c) is
`renderContractHtml()`; swapping it changes nothing else.

---

## Open items

| ID | Item | Severity | Target |
|---|---|---|---|
| SEC-001 | Run `ALL-IN-ONE-SETUP.sql` on production | **Blocking before real data** | Phase 4 deploy |
| SEC-002 | Nonce-based Content-Security-Policy | Medium | Phase 5 |
| SEC-004 | Automated cross-tenant isolation test suite | High | Phase 5 |
| SEC-005 | Rate limiting on search + webhook | Medium | Phase 5 |
| SEC-011 | Binary PDF output (needs a worker host or paid service) | Low | Phase 5 |
| SEC-012 | Period-close locking — no mechanism yet to freeze a closed accounting period | **High** | Phase 5 |
| SEC-013 | Bank reconciliation UI (schema ready, no interface) | Medium | Phase 5 |

> **SEC-012 deserves attention before real bookkeeping.** Nothing currently
> prevents posting a back-dated entry into a period already reported. That is an
> accounting-control gap, not a security hole, but it matters once real numbers
> are filed.

---

**Signed off:** DevSecOps automated review, v0.4.0-sec
**Recommendation:** ✅ Approved to deploy. Run **SEC-001** before real data.
Address **SEC-012** before the ledger is used for actual bookkeeping.
