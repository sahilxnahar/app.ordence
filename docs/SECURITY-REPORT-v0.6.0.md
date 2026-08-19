# Phase 6 Security Automation & Test Report — v0.6.0-sec

**Build:** v0.6.0-alpha · **Date:** 31 July 2026
**Scope:** Test infrastructure, cross-tenant isolation suite, financial integrity suite, audit immutability suite, CI pipeline
**Verdict:** ✅ **PASS — SEC-004 RESOLVED**

---

## 1. Test results — 69 passing, 0 failing

Executed against a **real PostgreSQL 16** instance with the full production
schema and `SQL-FILES/ALL-IN-ONE-SETUP.sql` applied. No mocks, no stubs.

| Suite | Tests | Result |
|---|---|---|
| `rls-isolation.test.ts` | 24 | ✅ all pass |
| `accounting-triggers.test.ts` | 23 | ✅ all pass |
| `audit-immutability.test.ts` | 22 | ✅ all pass |
| **Total** | **69** | ✅ **69 passed (3 files)** |

Runtime: 985 ms.

---

## 2. ⚠️ The finding that made this suite real

**The first run showed 17 failures.** The cause was not a bug in the platform —
it was a bug in the test setup, and it is the most important thing in this report:

> **The tests were connecting as `postgres`, a PostgreSQL SUPERUSER.
> Superusers bypass Row-Level Security completely.**

`FORCE ROW LEVEL SECURITY` makes policies apply to the table *owner*. It does
**not** apply to a superuser or any role with `BYPASSRLS`. A suite connecting as
one would report **green forever** — including on the day every policy was
dropped. It would have been worse than no tests at all, because it would have
manufactured false confidence.

**Fixed by:**
1. Creating a non-superuser `ameya_app` role, exactly as production uses
2. Splitting into two pools — `testPool` (app role, all assertions) and
   `adminPool` (superuser, fixtures only)
3. Adding a **startup check that aborts the suite** if the test connection is a
   superuser or has `BYPASSRLS`

**Verified firing:**
```
🚨 TEST_DATABASE_URL connects as "postgres", which is a SUPERUSER.
   Superusers bypass Row-Level Security completely.
```

The CI pipeline creates the same non-superuser role, so this cannot regress.

---

## 3. Production-database guard — 6 checks, all verified firing

The suite creates and deletes data. If it ever ran against production it would
destroy live records. Six independent checks must all pass before a single test
executes:

| # | Check | Verified |
|---|---|---|
| 1 | `.env.test` must exist — no fallback to `.env.local` | ✅ |
| 2 | `TEST_DATABASE_URL` — a **different variable name** from `DATABASE_URL` | ✅ |
| 3 | URL must contain a test marker (`test`, `localhost`, `127.0.0.1`) | ✅ **tested** |
| 4 | URL must not match a production host pattern | ✅ **tested** |
| 5 | Must not equal `DATABASE_URL` | ✅ |
| 6 | `ALLOW_DESTRUCTIVE_TESTS=true` — typed by a human | ✅ **tested** |

Three were tested by deliberately violating them:

```
Neon production URL  →  "TEST_DATABASE_URL does not look like a test database"
Missing acknowledgement → "ALLOW_DESTRUCTIVE_TESTS is not set to 'true'"
Superuser connection  →  "🚨 connects as postgres, which is a SUPERUSER"
```

All three aborted the run. **Fail-closed confirmed.**

---

## 4. What the tests actually prove

### Cross-tenant isolation (24 tests)
Tenant B, holding a valid session and a known record ID, cannot **read**,
**update** or **delete** Tenant A's deal, asset, contract, ledger or audit log.
Unfiltered `SELECT *` returns only its own rows. Aggregates return zero. JOINs
cannot pull rows in sideways. `tenant_id` cannot be forged on insert or rewritten
on update.

**With no tenant context set, all 22 tables return zero rows** — never all rows.

Two coverage tests fail if any future table with a `tenant_id` column lacks RLS
or a policy. That is the regression guard: in Phase 9, when someone adds a table
and forgets, CI catches it.

### Financial integrity (23 tests)
Unbalanced transactions rejected, including a **one-paisa** difference.
Single-leg transactions rejected. Negative amounts rejected.

The suite asserts the **timing** of both triggers, not just their existence:
- The balance check is **deferred** — a single leg inserts fine, COMMIT rejects
- The period lock is **immediate** — the INSERT itself throws

Getting either backwards breaks the system, so both are tested explicitly.

Closed-period entries rejected, including on exact boundary dates
(`2026-01-01` and `2026-03-31`), while `2026-04-01` is accepted.

Float precision proven from both directions: `0.1 + 0.2 !== 0.3` is asserted as a
*failing* case, then the BigInt path is shown exact. No drift across 10,000
additions. A ₹1 crore three-way split reconciles; the naive version loses exactly
one paisa and the test catches it.

### Audit immutability (22 tests)
UPDATE and DELETE blocked on all four evidence tables. Bulk deletes blocked.
Rows verified intact after every attack. Appending still works — append-only,
not read-only. The error code is asserted as **42501** specifically, because
application code branches on it.

---

## 5. CI pipeline

`.github/workflows/security-ci.yml` — runs on every push and PR to `main`.

| Job | Fails the build when |
|---|---|
| Type-check & Build | TypeScript errors, build failure, or a secret in the client bundle |
| Security Test Suite | Any of the 69 tests fails, or fewer than 22 tables are RLS-protected |
| Dependency Audit | High/critical advisory in **production** dependencies |
| Secret Scan | A `.env` file or live key is committed |
| Security Gate | Any of the above did not succeed |

The test job spins up **real PostgreSQL 16**, runs `drizzle-kit push`, applies
`ALL-IN-ONE-SETUP.sql`, and creates the non-superuser role. Applying the SQL is
itself a test — a syntax error or missing table fails the pipeline there.

The dependency audit deliberately checks **production only**. Failing on
dev-tool advisories would train everyone to ignore the job.

> **Requires one manual step:** branch protection on `main` requiring the
> **Security Gate** check. Without it CI reports failures but cannot block a merge.

---

## 6. Build integrity

```
npx tsc --noEmit  → ✅ 0 errors
npx next build    → ✅ compiled in 35.2s
Middleware        → 87.1 kB (8.7% of the Hobby limit)
Production deps   → {critical: 0, high: 0, moderate: 0}
```

---

## 7. A second real bug found this phase

`drizzle.config.ts` still pointed at `./db/schema.ts` — a path that stopped
existing in Phase 5 when the schema was split into `db/schema/`.

**Every `drizzle-kit push` and `generate` would have failed** with
`No schema files found`. It surfaced immediately when the test database needed
building. Fixed to `./db/schema/index.ts`.

This is precisely the class of problem the CI pipeline now catches automatically.

---

## Open items

| ID | Item | Severity | Target |
|---|---|---|---|
| SEC-001 | Run `ALL-IN-ONE-SETUP.sql` on production | **Blocking** | Now |
| SEC-002 | Nonce-based CSP | Medium | Phase 7 |
| SEC-005 | Rate limiting on search + webhook | Medium | Phase 7 |
| SEC-011 | Binary PDF output | Low | Later |
| SEC-013 | Bank reconciliation UI | Medium | Phase 7 |
| SEC-014 | Period-close UI | Medium | Phase 7 |
| SEC-015 | Permission override admin UI | Low | Phase 7 |
| **SEC-016** | **Branch protection not yet enabled** | **High** | **Manual, 2 minutes** |

**Closed this phase:** SEC-004.

---

**Signed off:** DevSecOps automated review, v0.6.0-sec
**Recommendation:** ✅ Approved. Enable branch protection (**SEC-016**) — without
it the pipeline reports but does not enforce.
