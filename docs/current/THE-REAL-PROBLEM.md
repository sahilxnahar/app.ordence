# 0091 only half-applied. Here is the whole picture, and the repair.

**Repo: `app.ordence`** · v1.59.0-alpha

🔴 **Your database is in a partially-applied state and has been since you ran `0091`.** That is not your doing. `0091` reported success and stopped part-way through, and my file was built so that it could.

---

## What your error actually revealed

```
ERROR: relation "public.tenant_slug_history" does not exist (SQLSTATE 42P01)
```

`tenant_slug_history` is created by `0091` section 4. `reserved_slugs` from section 2 **does** exist , we know because your first `0092` attempt was refused by its RLS policy. So sections 1 and 2 landed, and something at or after section 3 stopped the run. Sections 4 to 7 never happened: **no history table, no guard function, no trigger, no grants.**

⚠️ **Which means the slug guard has not been protecting anything.** The CHECK constraints may be there, but the reserved-word trigger, the retention rule and the history table are not.

---

## 🔴 One root cause, and I shipped it three times

**A browser SQL console sends each statement on its own connection.** Nothing session-scoped or transaction-scoped survives from one statement to the next. Every failure this week is that one fact:

| Where | What broke |
|---|---|
| `0092` v1 | plain INSERT refused by FORCE RLS |
| `0092` v2 | `SET LOCAL` reported success, then evaporated before the INSERT |
| **`0091`** | **`BEGIN;` bought no atomicity, so a mid-file failure committed half the migration and the console said it was done** |
| `VERIFY-0091` | a TEMP table created on one connection, read from another |
| my `0092` diagnostic | `SELECT count(*) FROM tenant_slug_history` , **a diagnostic that assumed the thing it was diagnosing** |
| my `STATE-OF-0091` v1 | `CASE WHEN to_regclass(...) IS NULL THEN ... ELSE (SELECT FROM missing_table)` , **the planner resolves both branches, so the guard never runs** |

**The `BEGIN;` at the top of `0091` was worse than useless.** It provided nothing and made the file look as though it did, which is why the partial state went unnoticed until a later file tripped over the missing table.

⚠️ **And `psql -f` hides all of it**, because psql sends the whole file on one connection. Every one of these applied perfectly from a terminal. **I kept testing these files the way they are not used.**

---

## ⭐ What I built so this stops happening

**A test harness that runs a SQL file the way your browser does:** split into top-level statements, each sent on its own fresh connection, as a non-superuser role without `BYPASSRLS`.

It immediately found **two more bugs I would not have found by reading**:

1. On a **re-run**, `0091`'s seed INSERT is refused, because by then `reserved_slugs` already has FORCE RLS. A file that only works on a database that has never seen it is single-use, not idempotent , and the re-run is the case that actually matters now.
2. `VERIFY-0091`'s temp table, above.

Every file below is now verified against **both** a fresh database **and** a reproduction of your exact partial state, statement by statement, on separate connections, twice for idempotence.

---

## Your files are fixed

| File | Change |
|---|---|
| **`0091`** | `BEGIN;`/`COMMIT;` removed. Every statement independently idempotent. Both seed INSERTs and the backfill wrapped in `DO` blocks that set the scope in the same statement. **Safe to re-run over your partial state.** |
| **`0092`** | Already fixed. Unchanged from the last delivery |
| **`STATE-OF-0091`** | **New.** One statement, reads only `pg_catalog` via `to_regclass`, cannot error on a missing object |
| **`VERIFY-0091`** | Probes are now a catalog-persisted function instead of a temp table |
| **`FIX-PROJECT-STATE-CODES`** | Same `SET LOCAL` defect. Rewritten as a function |

**Gate:** `check:sql-rls-writes` now also fails any migration wrapping itself in `BEGIN`/`COMMIT`, with the explanation in the message. 45 already-applied files are grandfathered by name. **`0091` is deliberately not among them** , it was grandfathered once as "already applied" and it was not. *"Already applied" is a claim about the database, not the file, and it needs evidence.*

⭐ **And `tests/ui/slug-contract.test.ts` FAILED rather than passing vacuously** when the seeds moved inside `DO` blocks. Its "did the parse find anything at all" guard caught it. That guard exists because an empty parse compared against an empty set reports perfect agreement. It earned its place today.

---

# Do this, in order

## 1. `STATE-OF-0091-neon-safe.sql`

One statement, read-only, cannot fail. **Send me the whole grid.** It tells us exactly which parts of `0091` are present and whether a re-run will hit a data blocker (uppercase slugs, bad shapes, fold collisions).

## 2. Re-run `0091_slug_authority.sql`

The corrected one. It is idempotent: it skips what exists and creates what does not.

⚠️ **If any RE-RUN BLOCKER row in step 1 is non-zero, stop and send me step 1 first.** Those are the rows that stopped it the first time and they will stop it again.

## 3. Run `0092_reserve_clerk_hosts.sql`

## 4. Run `VERIFY-0091-neon-safe.sql`

**Send me tab 8.** Nine rows. Row 9 attempts five real operations, one of which must be **accepted**.

## 5. Re-run `STATE-OF-0091-neon-safe.sql`

Everything should read `present`. **Send it to me again.**

Then `/api/diag`, then the deploy. The rest of `DO-THIS-NOW-EVERYTHING.md` is unchanged.

---

## Where the code stands

**15 gates green. `tsc` clean. 142 test files, 4,936 tests.** Group A and Group B complete. The code has never been the problem this week; the SQL delivery mechanism has, and it was mine.
