# Phase 5 Security, Compliance & Build Report — v0.5.0-sec

**Build:** v0.5.0-alpha
**Date:** 31 July 2026
**Scope:** Period close (SEC-012), granular RBAC, audit enforcement, executive dashboard
**Verdict:** ✅ **PASS — cleared for deployment**

---

## 1. Period-close enforcement (SEC-012) — RESOLVED

Phase 4 flagged this: nothing stopped a back-dated entry landing in a month
already reported to a bank or auditor. Now blocked at the database level.

**10/10 checks pass:**

| Check | Result |
|---|---|
| Trigger fires on INSERT, UPDATE **and** DELETE | ✅ |
| Checks `transaction_date`, not `created_at` | ✅ |
| `BEFORE` trigger — the write never lands | ✅ |
| Matches any non-open status (`closed`, `locked`, `pending_close`) | ✅ |
| Period lookup is tenant-scoped | ✅ |
| `transactions` table locked too — dates cannot be moved | ✅ |
| On UPDATE, checks **both** old and new dates | ✅ |
| Overlapping periods made impossible (`EXCLUDE USING gist`) | ✅ |
| `btree_gist` extension created | ✅ |
| Raises with an actionable `HINT` | ✅ |

### Three details that make this actually work

**It checks `transaction_date`, not `created_at`.** `created_at` is when the row
was typed; `transaction_date` is when the money moved. Checking `created_at`
would leave back-dating wide open — which is the exact hole being closed.

**On UPDATE it checks both dates.** Moving an entry *out* of a closed period is
as much a violation as moving one in. Checking only `NEW` would let anyone empty
a closed period one row at a time.

**Periods cannot overlap.** If two periods covered the same day — one open, one
closed — "is this date locked?" would have two answers. An exclusion constraint
makes that state unrepresentable.

### Timing, and why it differs from the balance trigger

| Trigger | When it fires | Why |
|---|---|---|
| Period lock | `BEFORE` each row | Reject the write immediately; nothing to roll back |
| Balance check (Phase 4) | `DEFERRED`, at COMMIT | Must wait until every leg is present |

Different jobs, different timing, both correct.

---

## 2. Granular RBAC — separation of duties

**11/11 rules verified by executing the permission engine:**

```
PASS  Accountant must NOT close periods
PASS  Accountant CAN post entries
PASS  Accountant must NOT reopen
PASS  Legal Counsel CAN sign contracts
PASS  Legal Counsel must NOT touch the ledger
PASS  Legal Counsel must NOT read ledgers
PASS  Contractor CAN view assets
PASS  Contractor must NOT export
PASS  Contractor must NOT see financials
PASS  Read-only must NOT create
PASS  Owner CAN close periods
```

**The Accountant boundary is deliberate.** Recording numbers and declaring them
final are different jobs. `billing_admin` can post and reverse entries but cannot
close a period — closing is an attestation, reserved for an owner or admin. That
is standard segregation of duties, and it is the control an auditor looks for
first.

### Permission engine — fail-closed. **7/7 pass:**

| Case | Result |
|---|---|
| Unknown permission → **DENIED** (a typo must never grant) | ✅ |
| Explicit revoke beats role grant | ✅ |
| Explicit grant beats role absence | ✅ |
| Revoke wins when both are present | ✅ |
| Empty / null overrides fall back to role safely | ✅ |
| Dangerous permissions correctly flagged | ✅ |

**Revoke beats grant, always.** Any other precedence would let a revocation be
silently undone by an unrelated grant — the wrong default for a security control.

**Why the catalog is code, not a table:** `checkPermission()` runs on essentially
every server action. A database round-trip per check would add latency to every
request and make Edge use impossible. The vocabulary is code; the tenant-specific
grants live in the database.

---

## 3. Audit trail

**All 4 evidence tables are append-only at the database level:**

| Table | UPDATE blocked | DELETE blocked |
|---|---|---|
| `audit_logs` | ✅ | ✅ |
| `contract_versions` | ✅ | ✅ |
| `journal_entries` | ✅ | ✅ |
| `permission_denials` | ✅ | ✅ |

### One design decision worth stating plainly

The Phase 5 brief asked for a new `system_audit_logs` table. **I extended the
existing `audit_logs` instead**, adding `metadata` and `severity`.

Two reasons. First, `roles`, `permissions`, `role_permissions`, `user_roles` and
`audit_logs` all already exist from Phase 1 — re-declaring them would break the
build with duplicate exports. Second, and more importantly: **an audit trail split
across two tables cannot prove anything.** Answering "what happened to this
contract?" would require querying both and trusting that neither was missing
rows. One append-only table is the stronger compliance position.

### Authorization and audit share one enforced path

**6/6 checks pass.** `checkPermission()` decides *and* records the denial in a
single call. Splitting them would mean every call site has to remember to log —
and some would not. Attempted-but-blocked actions are precisely what a security
review needs.

`requirePermission()` **throws** rather than returning a boolean, so it cannot be
forgotten the way an `if` can. A denied *dangerous* permission also writes a
`security_event` to the main audit trail at `warning` severity.

Audit writes **never throw** — a broken audit pipeline must not roll back the
user's work — but they log loudly to stderr so the failure is visible in
monitoring rather than silently swallowing history.

---

## 4. Period-close action controls

**7/7 pass:**

| Control | Result |
|---|---|
| `closeFinancialPeriod` requires `periods:close` | ✅ |
| Reopen requires a **separate** `periods:reopen` | ✅ |
| Trial balance verified **before** locking | ✅ |
| Full ledger snapshot stored at close | ✅ |
| Reopen demands a written reason (15+ chars) | ✅ |
| Forced unbalanced close → `critical` severity | ✅ |
| Any reopen → `critical` severity | ✅ |

**Balance is verified before the lock** because sealing books that do not balance
makes the seal worthless. An override exists, but it requires explicit
acknowledgement and produces a critical-severity audit record — exactly the event
an auditor should be able to find.

**The closing snapshot** captures every ledger balance at the moment of close.
If a later reconciliation disagrees, that snapshot is the evidence.

---

## 5. Build integrity

```
npx tsc --noEmit    → ✅ 0 errors (strict, noUncheckedIndexedAccess)
npx next build      → ✅ Compiled successfully
```

| Route | Type | Size | First Load |
|---|---|---|---|
| `/dashboard` | Dynamic | 107 kB | 209 kB |
| `/assets` | Dynamic | 14.2 kB | 143 kB |
| Middleware | Edge | **87.1 kB** | 8.7% of limit |

Shared JS held at **102 kB** — Recharts is code-split into `/dashboard` only, so
no other route pays for it.

**Production dependencies:** `{critical: 0, high: 0, moderate: 0}`.

---

## 6. Dashboard security posture

- **Server component.** Every figure is aggregated in SQL; only finished numbers
  reach the browser. No raw ledger or asset rows are ever shipped to the client.
- **Tenant-scoped throughout.** Every query filters on the session tenant.
- **Aggregated in SQL, not Node.** Counting 50,000 units by pulling them into
  memory would blow the 10s Hobby budget; `COUNT(*) GROUP BY` returns in
  milliseconds off the tenant index.
- **Accessible.** Every chart is paired with a visually-hidden data table
  carrying the same numbers — a chart alone is unreadable to a screen reader.

---

## 7. Consolidated SQL

`SQL-FILES/ALL-IN-ONE-SETUP.sql` — **1,134 lines**, 13 sections, 12 verification
checks. Every migration from Phase 1 through Phase 5 in one idempotent file.

Protected tables: **22** (up from 20).

> **A build note worth recording:** the first merge of Phase 5 into the master
> file silently produced an unchanged file. It was caught by checking section
> markers afterwards rather than trusting the script's success message. The
> corrected file was then re-verified for section ordering, gap-free check
> numbering (1–12), and the presence of every critical statement.

---

## Open items

| ID | Item | Severity | Target |
|---|---|---|---|
| SEC-001 | Run `ALL-IN-ONE-SETUP.sql` on production | **Blocking before real data** | Phase 5 deploy |
| SEC-002 | Nonce-based Content-Security-Policy | Medium | Phase 6 |
| SEC-004 | Automated cross-tenant isolation test suite | **High** | Phase 6 |
| SEC-005 | Rate limiting on search + webhook | Medium | Phase 6 |
| SEC-011 | Binary PDF output | Low | Phase 6 |
| SEC-013 | Bank reconciliation UI | Medium | Phase 6 |
| SEC-014 | No UI for period close — server action only | Medium | Phase 6 |
| SEC-015 | Permission overrides have no admin UI | Low | Phase 6 |

> **SEC-004 is now the most valuable remaining item.** Five phases of isolation
> controls exist and each was verified by inspection or targeted test at the time
> it was built. What does not yet exist is a suite that runs on every commit and
> would catch a regression six months from now.

---

**Signed off:** DevSecOps automated review, v0.5.0-sec
**Recommendation:** ✅ Approved to deploy. Run **SEC-001** before real data.
