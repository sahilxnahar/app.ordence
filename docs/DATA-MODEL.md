# Ordence — the data model, honestly

**Version:** written for `1.81.0-alpha`, wave 15 (Track C); **numbers re-measured
in wave 17** against the assembled tree.
**Every number in this document was read out of a live PostgreSQL 16 database**
built from `SQL-FILES/` and `db/schema/`, not counted by hand and not taken from
another document. The commands are in `TRACK-REPORT.md`.

🔴 **WHICH TREE THE NUMBERS COME FROM, BECAUSE IT IS NOT THE WHOLE ONE.**
`1.81.0-alpha` + Track C `0136`–`0142` + Track B `0133`–`0135` + Track E
`0146`–`0150` + Track F `0151`–`0158` + Track G `0159` — **146 numbered
migrations.** Absent when this was measured: **Track A's `0129`–`0132`** and
**Track D's pending-number file**. Integration's full assembly is 151 files and
reports **319** tables row-level-security protected where this document says
**313**; the six-table difference is those five files. Every count below is
therefore a floor on the assembled tree and exact on the tree named here.

This file answers four questions: which tables are tenant-scoped, which are
global, which are append-only, and for each exception, why. It exists because
those four answers have been reconstructed from scratch in at least four
separate waves, and each reconstruction was wrong in a different way.

---

## 0. The one sentence everything else depends on

**Tenant isolation in this product is PostgreSQL row-level security and nothing
else.** There is no application-level tenant filter to fall back on. Every data
path goes through `withTenant(tenantId, cb)` or, rarely and deliberately,
`withPlatformScope(reason, cb)`.

### 🔴 And row-level security is a property of the connecting ROLE, not of the table

This is the correction wave 15 exists for, and it reverses a sentence that has
been repeated in briefs, migrations and reports:

| setting | who it binds |
|---|---|
| `ENABLE ROW LEVEL SECURITY` | everyone **except** the table's owner |
| `FORCE ROW LEVEL SECURITY` | …and the owner as well |
| a role with `rolbypassrls` | **exempt from every policy on every table.** `FORCE` does not reach it. |
| a role with `rolsuper` | the same, under a different word |

Measured on PostgreSQL 16.13 (`DRILL-DO-NOT-RUN-IN-NEON-0137.sql` reproduces
it), on a table with `relrowsecurity = t`, `relforcerowsecurity = t` and a
correct `tenant_id = app_current_tenant_id()` policy, owned by a NON-superuser
role holding `BYPASSRLS`:

```
tenant selected         : A
BYPASSRLS owner sees    : 2 rows   ← tenant A's AND tenant B's
NOBYPASSRLS role sees   : 1 row
```

`SQL-FILES/WHO-DOES-THE-APP-CONNECT-AS-neon-safe.sql` and
`SQL-FILES/CAN-WE-SWITCH-TO-ordence_app-neon-safe.sql` both record
`neondb_owner has rolbypassrls = true` on this Neon project.

⚠️ **So "313 tables are FORCED" is a true sentence that guarantees nothing on
its own.** The guarantee is: *313 tables are FORCED **and** `DATABASE_URL` names
a role with `rolbypassrls = false`.* Run `SELECT * FROM isolation_posture()`
(added by `0137`) against the real database to check the second half. It is not
a migration's job to fix and no migration can: it is a connection-string
decision.

---

## 1. The census

| | wave 15 | wave 17 (146 files) | integration (151 files) |
|---|---|---|---|
| base tables in `public` | 322 | **326** | — |
| …tenant-scoped (carry a `tenant_id` column) | 303 | **306** | — |
| …global (no `tenant_id`) | 19 | **20** | — |
| views | 22 | 27 | — |
| RLS policies | 314 | **318** | — |
| functions in `public`, excluding extension-owned | 491 | **268** | — |
| **any** table with RLS **enabled** | 309 | **313** | **319** |
| **any** table with RLS **forced** | 309 | **313** | **319** |
| enabled but NOT forced | 0 | **0** | — |
| forced but NOT enabled | 0 | **0** | — |
| tenant tables enabled / forced / policied | 303 | **306 / 306 / 306** | — |
| policies carrying `app_platform_scope()` in `USING` | 123 | 127 | — |

⭐ **THE TWO NUMBERS THAT MATTER ARE THE SAME NUMBER.** `enabled` and `forced`
are 313 and 313, and both cross-checks are zero. `forced but NOT enabled` is the
one nobody thinks to look at: `ALTER TABLE … FORCE ROW LEVEL SECURITY` on a
table whose row security is *disabled* is accepted by PostgreSQL and does
nothing, after which the catalog says `force = true` and the engine applies no
policy at all.

⚠️ **The function count fell from 491 to 268 and nothing was deleted.**
Wave 17 excluded extension-owned functions from the census and from the schema
contract: `btree_gist` contributes 188, `citext` 47, and
`0158_perf_slow_query_visibility.sql`'s `pg_stat_statements` 3. They are
extension internals, they change with the server version, and they were making
the contract report differences nobody could act on.

The criterion for "tenant-scoped" is **the table carries a `tenant_id` column**,
and it is deliberately the same criterion `scripts/check-rls-coverage.mjs`,
`tenant_table_drift()` and `tenant_tables_missing_force()` all use. Four
hand-maintained lists of tenant tables have existed in this repository and every
one of them was wrong; a list is a thing that goes stale, and a column is a
fact.

---

## 2. Tenant-scoped tables — what "protected" means here

A tenant-scoped table is expected to satisfy **five** properties. They are
checked continuously by `tenant_table_drift()` (`0140`), which returns one row
per missing property and zero rows on a clean database, and by
`scripts/check-rls-coverage.mjs`, which fails the build on any of them.

1. **`relrowsecurity`** — row security is switched on.
2. **`relforcerowsecurity`** — and forced, because the application owns the
   tables.
3. **a policy whose `USING` clause names `app_current_tenant_id()`.** "Has a
   policy" is not the test: RLS with no policy denies everything (fails closed,
   breaks the table), and RLS with a policy that filters on something else may
   permit everything.
4. **a trigger executing `record_change()`** — or the write is absent from the
   edit history and can never reach a second machine. 16 tables are excluded
   (15 at wave 15; Track B's `0134` added one), with a written reason each, in
   `change_log_exclusions`.
5. **a trigger executing `refuse_delete_under_impersonation()`** — or an Ordence
   engineer inside an impersonation session can delete the row. 13 tables are
   excluded, with a reason each, in `impersonation_guard_exclusions`.

⚠️ **The exclusions live in tables, not in this document.** Three of the five
properties were once documented in prose and enforced by a floor, and the floor
printed `PASS` at 48 of 303. A row in `change_log_exclusions` carries
`table_name`, `reason`, `category` and `declared_in`; adding one is a visible
act with a name attached to it.

### The two tables `check-rls-coverage.mjs` excludes from the RLS rules

| table | why |
|---|---|
| `tenants` | the tenant list itself. Read across tenants by design; it has its own policy with a platform branch, which is what lets every per-tenant retention sweep read the list at all. |
| `plans` | the global price list. Read by every workspace; `ALL-IN-ONE-SETUP.sql` revokes `UPDATE` on it so a tenant cannot reprice itself. |

---

## 3. The 20 global tables, one line each

No `tenant_id`, so no tenant policy applies. Whether RLS is on is a separate
question from whether the table is tenant-scoped, and both answers are given.

| table | RLS / FORCE | what it is |
|---|---|---|
| `tenants` | ✅ / ✅ | the workspace list. Its policy carries a platform branch by design. |
| `plans` | ✗ / ✗ | the global price list. Readable by everyone; `UPDATE` revoked from the app. |
| `permissions` | ✗ / ✗ | the permission catalogue — a static list of capability names. |
| `installation` | ✗ / ✗ | one row describing this deployment. |
| `schema_migrations` | ✗ / ✗ | which numbered files have been applied (`0120`). |
| `reserved_slugs` | ✅ / ✅ | hostnames nobody may claim (Clerk, Resend, `www`…). |
| `currency_units` | ✅ / ✅ | minor-unit exponents per ISO currency. Global reference data. |
| `fx_reference_rates` | ✅ / ✅ | published reference rates. Not a tenant's own rate table. |
| `rate_limit_counters` | ✗ / ✗ | short-lived counters keyed by IP and route (`0119`). |
| `platform_action_log` | ✅ / ✅ | what Ordence staff did. Platform evidence. |
| `platform_staff` | ✅ / ✅ | who Ordence staff are. |
| `platform_incidents` | ✗ / ✗ | platform-side incident records. |
| `platform_approval_queue` | ✗ / ✗ | platform actions awaiting a second pair of eyes. |
| `change_log_exclusions` | ✗ / ✗ | the declared exemptions from property 4, one reason per row (`0122`). |
| `impersonation_guard_exclusions` | ✗ / ✗ | the same for property 5 (`0125`). |
| `updated_at_exclusions` | ✗ / ✗ | tables that deliberately have no `updated_at` trigger (`0126`). |
| `updated_at_consolidation_audit` | ✗ / ✗ | the before/after coverage census `0138` compares against. |
| `siem_export_cursors` | ✗ / ✗ | wave-17 addition (Track B, `0134`): where the SIEM export got to. Platform data about the export, not about a tenant. |
| `isolation_posture_log` | ✗ / ✗ | dated readings of which roles row security actually applies to (`0137`). |
| `schema_contract_snapshots` | ✗ / ✗ | captured fingerprints of the security shape (`0139`). |

⚠️ **A global table with RLS off is a deliberate decision and not an oversight,
but only for these nineteen.** Any *new* table without a `tenant_id` is
invisible to `tenant_table_drift()`, because that function keys on the column.
If a new global table holds anything a tenant should not read, it needs its own
policy and its own line in this table.

🔴 **The four platform-metadata tables added by this wave** —
`isolation_posture_log`, `schema_contract_snapshots`,
`updated_at_consolidation_audit` and (from `0126`) `updated_at_exclusions` — are
readable by the maintenance role and **not** by `ordence_app`. A tenant session
has no product reason to hold a list of which roles can see everything, or the
full text of every isolation policy in the database.

---

## 4. Append-only tables

A table is append-only when a `BEFORE UPDATE` / `BEFORE DELETE` trigger refuses
the mutation outright. Five tables carry the unconditional guard
(`block_mutation_append_only()`):

| table | why it is append-only |
|---|---|
| `journal_entries` | the general ledger. An edited posting is an unauditable one. |
| `contract_versions` | each version is the record of what was signed at a moment. |
| `lead_activities` | the contact history a dispute is reconstructed from. |
| `permission_denials` | the record of what the product refused. |
| `employee_advance_recoveries` | each recovery is applied against a payslip that has already been issued. |

⚠️ **Do not confuse these with tables that have a CONDITIONAL guard.**
`gstr2b_documents`, `hsn_sac_rates`, `workflow_versions` and `sales_orders` all
carry triggers that raise on *some* updates — a filed period, a superseded rate,
a published version, an illegal status transition. They are ordinary updatable
tables with a rule.

🔴 **This distinction has already produced a wrong census once.** `0126`'s first
draft classified a table as append-only if any of its `BEFORE UPDATE` trigger
functions contained the text `RAISE EXCEPTION`, which matches a conditional
guard as readily as an unconditional refusal, and it left `sales_orders` with a
dead `updated_at`. The test that replaced it is a fact rather than a heuristic:
**the application role holds no `UPDATE` privilege on any column of the table.**
If nothing may update the row, no `BEFORE UPDATE` trigger there could ever fire.

By that test exactly one table with an `updated_at` column is excluded today:
`plans`. It is in `updated_at_exclusions` with the reason recorded.

### Evidence tables that are append-only by privilege rather than by trigger

`audit_logs`, `security_events` and `payment_events` are protected on the
privilege layer as well: `scripts/sealed-grants.json` seals `DELETE` and
`UPDATE` on `security_events` and `DELETE` on `audit_log` against `ordence_app`,
and `check:sealed-grants` fails the build if any `.sql` file grants them back.
That seal exists because 0087 re-granted `EXECUTE` on
`prune_security_events()` seventy-five files after 0012 refused it in a comment.

---

## 5. `updated_at`

One function: **`set_updated_at()`**. One trigger name:
**`<table>_set_updated_at`**.

Before wave 15 there were two functions doing the identical job —
`set_updated_at()` on 159 tables and `ordence_touch_updated_at()` on 19 — and
two naming conventions, because `0028` named its triggers `trg_touch_<table>`.
That cost a wrong census twice: once when a sweep that knew one function
attached a second trigger to twelve tables, and permanently for any census keyed
on the trigger *name*, which calls `sales_orders` uncovered.
`0138_updated_at_consolidation.sql` rewrote the 19 and dropped the second
function; the before/after coverage numbers are in
`updated_at_consolidation_audit`.

**179 of 179** tables that carry an `updated_at` column and are not excluded now
have a trigger maintaining it (177 of 177 at wave 15; the two new ones arrived
covered).

---

## 6. The platform read scope

**123 policies** carry `app_platform_scope()` in their `USING` clause. That is
not a leak: it is the deliberate scope `0014_phase17_platform.sql` §6 introduced
so support can read the tables holding the **commercial relationship** with a
customer, and about a dozen module files have extended it since.

⚠️ **An allowlist is the wrong shape for 123 tables** — it would produce 123
copied sentences and one gate nobody adopts. What is written down instead is the
**refusals**: 14 tables that two files state in prose must never acquire the
marker, encoded in `PLATFORM_READ_REFUSED` in
`scripts/check-rls-coverage.mjs`:

- **`0022`, the admin console** — `usage_counters`, `usage_levels`, `audit_logs`,
  `security_events`. "One query would read every customer's metered usage /
  audit trail / security events."
- **`0014` §6, customer content held as a processor** — `contacts`, `companies`,
  `deals`, `custom_object_records`, `assets`, `contracts`, `contract_versions`.
  These hold data about the *customer's own customers*, third parties who never
  had a relationship with Ordence. "Reading it for our own convenience is
  processing with no lawful basis; 'it made the ticket faster' is not a purpose."
- **`0014` §6, the general ledger** — `journal_entries`, `transactions`,
  `ledgers`.

🔴 **One of the fourteen is a recorded exception.** `security_events` acquired
`OR app_platform_scope()` in its `USING` clause in `0079`, 57 files after `0022`
refused exactly that, while fixing a genuine and unrelated write bug — the
policy had been discarding every attributed row. It is left in place rather than
reverted, because `server/security/anomalies.ts` now depends on the cross-tenant
read for its perimeter sweep, and reverting it would trade a *recorded widening*
for a *silent blindness*. It is marked `accepted` in `PLATFORM_READ_REFUSED`, and
the gate now also fails if it is ever quietly removed.

### The write side is narrower than the read side, and deliberately so

`app_platform_scope()` in a `WITH CHECK` clause permits a **cross-tenant write**.
Ten tables are allowed it, by name, in `OPT_IN_PLATFORM_WRITE`: they are platform
evidence written into a workspace on the platform's own behalf
(`tenant_slug_history`, `login_lockouts`, `error_events`,
`platform_entitlement_history`, `platform_impersonation_sessions`,
`platform_tenant_flags`, `security_events`, `tenant_health_events`,
`web_vital_events`). Anything else with the marker in `WITH CHECK` fails the
build, unless it uses the one recognised safe idiom:

```sql
tenant_id = app_current_tenant_id()
OR (tenant_id IS NULL AND app_platform_scope())
```

— the marker conjoined with `tenant_id IS NULL`, which can write only a **global**
row and never another tenant's. `email_suppressions` uses exactly that.

### Two tables no tenant may read at all

`platform_entitlement_history` and `tenant_health_events` carry a `tenant_id` and
a policy whose `USING` clause is `app_current_tenant_id() IS NULL OR
app_platform_scope()` — platform evidence **about** a workspace, deliberately not
visible **to** it. The cross-tenant probe recognises this class from the policy
(no `USING` clause mentions the `tenant_id` column) rather than from a list, and
asserts that *both* tenants see zero.

---

## 6a. Money

Money is `bigint` **minor units** throughout. Minor units are not universally two
decimals: JPY is 0; KWD, BHD, OMR, JOD, TND, LYD and IQD are 3; CLF and UYW are
4. `currency_units` is the global table that records the exponent per currency,
and `ordence_currency_exponent(text)` is the function that reads it.

🔴 **`journal_entry_fill_minor()`, a `BEFORE INSERT` trigger on
`journal_entries`, calls `ordence_currency_exponent()` and is NOT `SECURITY
DEFINER`.** So the application role's `EXECUTE` privilege on that function is
load-bearing for every ledger write in the product. See `TRACK-REPORT.md` §4,
finding 3 — re-running `0087` takes it away and the general ledger becomes
unwritable.

---

## 7. Retention

Three functions, all `SECURITY DEFINER`, all dry-run by default, none of them
scheduled — there is no scheduler attached to this product yet.

| function | window | floor |
|---|---|---|
| `prune_change_log(days, dry_run)` | 180 days | refuses under 30 |
| `prune_security_events(days, include_critical, dry_run)` | 180 days | refuses under 30 |
| `prune_usage_counters(interval, dry_run)` | 25 months | refuses under 13 months |

⚠️ **All three sweep one tenant at a time, and that is not a style choice.** A
single unscoped `DELETE FROM <tenant table>` inside a `SECURITY DEFINER`
function, on a table with `FORCE ROW LEVEL SECURITY` owned by a non-superuser,
matches **zero rows** — `app_current_tenant_id()` is `NULL`, so the predicate is
`NULL` for every row. The function returns 0 and exits cleanly. Measured, with
two rows five years past a two-year window:

```
rows before                        : 2
prune_usage_counters() reports     : 0
rows after                         : 2
```

`DRILL-DO-NOT-RUN-IN-NEON-0141.sql` reproduces it and then shows the per-tenant
version removing both. It survived every test it was ever put through because a
throwaway PostgreSQL owns the function as `postgres`, a superuser, which
bypasses row security — the bug is invisible in the one place it was exercised.

🔴 **Do not "fix" a retention job by widening a policy.** The tempting change is
`OR app_platform_scope()` on `usage_counters`, which would widen the read
boundary on every customer's metered usage — the exact widening `0022` refuses
and the gate fails on.

Each function raises rather than returning 0 if it sees **zero tenants**, because
a sweep that cannot read the tenant list is broken, not finished.

---

## 8. The schema contract

`0139` fingerprints the security shape: every tenant table with its RLS flags,
every policy (normalised), every trigger keyed on the **function it executes**,
and every function that is not owned by an extension. **1,884 objects** on the
wave-17 tree, fingerprint `55df4fd596df0294…`.

```sql
SELECT schema_contract_fingerprint();     -- one sha256
SELECT * FROM diff_schema_contract();     -- live vs the last capture
SELECT * FROM capture_schema_contract('why this change was intended');
```

Columns and indexes are deliberately **out** of the fingerprint: they change on
every ordinary feature commit, and a check that is red every day is a check that
gets ignored.

This exists for one failure. `drizzle-kit push` treats anything absent from
`db/schema/*.ts` as drift and removes it, and policies, triggers and functions
are all absent from `db/schema/*.ts`. Measured in Phase 10: **before push, 25
tables with RLS; after push, 0.** Today that would be 303 tables and 314
policies, and the application would keep working perfectly.

🔴 **WAVE 17 RESHAPED WHAT COUNTS AS A FAILURE, AND THE REASON IS WORTH
KNOWING.** Wave 15 failed on any difference at all, on the assumption that
`0142` — a capture and nothing else — would be the last file in the sequence.
Six tracks then numbered above it and the diff came back with **22 rows, every
one of them ADDED**, none of them wrong. No number a track can hold is ever
"last".

So the rule is shaped to the thing it detects instead:

| | |
|---|---|
| **REMOVED** | a policy, trigger or function that was there is gone. This is the `drizzle-kit push` signature — it takes away, it has never added anything. **FAIL.** |
| **CHANGED** | a policy's `USING` text is different, or a trigger executes a different function. A rewritten isolation boundary nobody recorded. **FAIL.** |
| **ADDED** | forward progress. Printed in full, counted, not fatal. |

⚠️ The weakening is smaller than it looks: an added table with no row security
is caught three other ways in the same run — the catalog check, the drift
detector and the cross-tenant probe. Measured against a deliberately unprotected
table, the gate produces seven findings and the contract is one of them.

`capture_schema_contract()` refuses an empty reason so that re-baselining cannot
be done silently to make a red gate green. **Integration recaptures after
assembly**; any track may also capture at the end of its own batch.

---

## 9. How a database is built, and the two ways it comes out different

```
drizzle-kit push          creates ~308 tables from db/schema/*.ts
ALL-IN-ONE-SETUP.sql      the phase 1–5 security baseline
SQL-FILES/NNNN_*.sql      in numeric order
```

`drizzle-kit push` is **banned** everywhere except building a throwaway test
database, and `npm run db:push` carries a production guard. It creates tables; it
knows nothing about policies.

🔴 **Until wave 15, a database built from the numbered files ALONE was missing
the entire phase-4 security layer.** `ALL-IN-ONE-SETUP.sql`'s header says it
combines phases 1–5 including "0004 CLM + double-entry accounting" — and **0004
does not exist and never did**. `scripts/check-migrations.mjs` records the number
as "never written — phase merged into 0005", which is true about the file and
false about the content. Six tables (`clause_library`, `contracts`,
`contract_versions`, `ledgers`, `transactions`, `journal_entries`), three
functions and nine triggers — including the deferred constraint trigger that
refuses an unbalanced journal — existed only in the combined file.

`0136_phase4_clm_and_ledger_isolation.sql` closes it. Verified: the two builds
now agree on **2,086 security objects, 322 table ACLs and 491 function ACLs**,
with identical fingerprints. `DRILL-DO-NOT-RUN-IN-NEON-0136.sql` is how you check
it again.

---

## 10. What is still not proven

Honesty about coverage is worth more than a bigger number.

- **44 of 306 tenant tables are not covered by the cross-tenant probe** (41 of
  303 at wave 15 — three of the new tables refuse the seed too). The
  probe seeds a real row for tenant A in every tenant table and tries to read it
  as tenant B; 41 tables refuse the seed on a `CHECK` constraint the probe cannot
  satisfy (`receipt_allocations_legs_balance`,
  `gst_registrations_gstin_checksum`, `staff_attendance_status_fraction_coherent`
  and 41 more). They are **printed by name on every run**. They are not counted
  as passing, and a rise in that number means coverage fell.
- **The probe cannot exercise `FORCE` itself.** It reads as `ordence_app`, which
  does not own the tables, so the policies would bind it even without `FORCE`.
  The catalog assertion covers `FORCE`; `DRILL-DO-NOT-RUN-IN-NEON-0137.sql`
  covers it behaviourally with a non-superuser owner.
- **Nothing here has been run against Neon.** Every number in this document
  comes from a local PostgreSQL 16 built from the repository. The one question
  that can only be answered on the real database is the role posture — run
  `SELECT * FROM isolation_posture()` there.
