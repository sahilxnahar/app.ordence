# ✅ RLS is real. The answer is the good one.

**Repo: `app.ordence`** · v1.60.0-alpha

---

## Your TAB 1

| connected_as | application | bypasses_rls | |
|---|---|---|---|
| `neondb_owner` | `neon-internal-sql-editor` | `t` | your SQL editor. Ignore. |
| **`ordence_app`** | **`pgbouncer`** | **`f`** | ✅ **your application** |

**`DATABASE_URL` points at `ordence_app`, through Neon's pooled endpoint, and that role does not bypass row-level security.**

So all 171 `FORCE ROW LEVEL SECURITY` policies **are** being enforced against your application. A query that forgets `withTenant` returns **zero rows**, not another tenant's rows. The database is the backstop, exactly as the architecture intended.

⭐ **`application_names = pgbouncer` is itself confirming.** That is Neon's pooler, which is what a Next.js app on Railway connects through, and the connection timestamp lines up with you using the product. This is not a stray session.

⚠️ **What it proves and what it does not.** It proves the connection serving your traffic is subject to RLS. It does not prove that *every* path uses that role , a worker on `DATABASE_URL_UNPOOLED`, or a future environment, could differ. Which is the point of what I built below.

**No switch. No grants migration. Nothing to change.** Ten sessions, and the answer is that it was right all along.

---

## 🔴 But the reason it took ten sessions is the actual defect

**Nothing in the product could see it.**

`check:rls` reads `pg_catalog`, correctly reports that 171 tables have policies and that they are forced, and is structurally blind to the one fact that decides whether any of it applies: which role the application authenticates as. Every dashboard was green the entire time. The gate was measuring the right thing about the wrong subject.

⚠️ **That is the same defect shape as the CI floor `if [ "$COUNT" -lt 100 ]` that `check:rls` was itself written to replace.** A check that measures the wrong thing passes confidently, and confidence is the damage.

---

## ⭐ So the product now reports it, permanently

**`lib/platform/rls-posture.ts`** , pure, no I/O, testable without a database. Turns `(role, rolbypassrls, rolsuper)` into a verdict with a **word**, a detail, and a remedy.

**`/api/diag`** , the operator-gated database probe already returned `current_user`. **A role name is not the fact that matters**, so the same query now also returns `rolbypassrls` and `rolsuper`, and the response carries an `rls` block:

```json
"rls": { "level": "enforced", "label": "ENFORCED", "detail": "...", "remedy": "" }
```

One extra round trip: none. Same query, two more columns.

### Three decisions inside it worth stating

🔴 **Superuser is a separate message, not a synonym.** `rolbypassrls` skips RLS and leaves triggers intact. A superuser skips triggers too , which takes out the slug guard, the closed-period guard and the append-only ledger guards. An operator reading one message must not conclude the other situation.

🔴 **A failed probe reads `unknown`, never `enforced`.** Same rule the availability endpoint follows: *"we could not check"* must never render as *"yes"*. The test suite asserts this explicitly, because it is the one direction that ships a cross-tenant read.

⚠️ **Advisory, never fatal.** It does not refuse to boot. `lib/env-boot.ts` deliberately never touches the network, because a boot assertion that can fail for an interesting reason will one day refuse a deploy at 2am for a reason nobody can reproduce. Refusing to start on a database condition also means a Neon blip takes the product down , a worse failure than a posture nobody can see.

**Eight tests.** The core one enumerates **all four** combinations of the two flags and requires `enforced` to be reachable only from false/false, so a future edit cannot quietly widen it. Asserting by example would have let that through.

---

## Where everything stands

**v1.60.0-alpha · 15 gates green · tsc clean · 143 test files · 4,944 tests**

| | |
|---|---|
| ✅ | Group A , self-serve subdomains, end to end |
| ✅ | Group B , all nine console batches |
| ✅ | 0091, 0092 applied. 74 reserved names, 6 history rows |
| ✅ | **RLS confirmed enforced, and now self-reporting** |
| 🔴 | `/api/diag` , send me the `missing` array (it now also shows the `rls` block) |
| 🔴 | Deploy v1.60.0-alpha |
| | `VERIFY-0091` tabs 11 and 12, when convenient , ⭐ **and they mean more now**, because RLS genuinely applies to the role the app uses |
| | Vault keys, AI keys, `projects.state_code`, one suspended workspace |

Everything else in `DO-THIS-NOW-EVERYTHING.md` is unchanged. **The database questions are closed.**
