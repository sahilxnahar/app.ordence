# What to do. Short version: one query, then one of two paths.

**Repo: `app.ordence`**

---

## What your grid says

| role | superuser | bypasses RLS | |
|---|---|---|---|
| `cloud_admin` | ✅ | ✅ | Neon's own infrastructure. Leave alone. |
| `neon_service` | | ✅ | Neon's own infrastructure. Leave alone. |
| `neondb_owner` | | ✅ | **your SQL editor**, and possibly your app |
| `neon_auth` | | ❌ | Neon Auth feature role |
| **`ordence_app`** | | **❌** | ⭐ **the role the product is supposed to use** |

⭐ **The good news is bigger than the bad news: `ordence_app` exists and does not bypass RLS.** The fix is available. Nothing has to be created.

🔴 **The open question is whether `DATABASE_URL` points at `ordence_app` or at `neondb_owner`.** If it is `neondb_owner`, then all 171 `FORCE ROW LEVEL SECURITY` policies are skipped for your application, `check:rls` still passes because it reads the catalog rather than behaviour, and tenant isolation rests entirely on every code path remembering `withTenant` with no backstop underneath it.

---

## ⚠️ And do NOT just repoint it. That is the trap.

`0087_hardening_narrow_grants.sql` grants `ordence_app` privileges on a **narrow, deliberate subset** of tables, and revokes before it grants. It was never a blanket grant. The only blanket grant in the repo is inside `ALL-IN-ONE-SETUP.sql`, a legacy aggregate that is not in the run order and may never have been applied here.

**So `ordence_app` may not hold `SELECT` on tables the product reads every second.** Repointing blind would trade a silent isolation gap for a loud outage, and would teach everyone that the switch is dangerous rather than that the grants were incomplete.

---

# Run this one file

**`CAN-WE-SWITCH-TO-ordence_app-neon-safe.sql`** , read-only, four independent statements, four tabs.

### TAB 1 answers the question without anyone reading a connection string

It reads `pg_stat_activity`, which reports the role each live backend authenticated as. Your app is serving traffic, so its connections are in there. **No secret is involved and I am not asking for your connection string.**

⚠️ If the only row is your own editor session, the app's compute has scaled to zero. **Load any page on app.ordence.com, then re-run within a few seconds.**

### TABs 2 to 4 tell you whether the switch is safe

Tab 4 is one row and gives one of two verdicts. **Send me tabs 1 and 4.**

---

# Then one of two paths

## Path A , TAB 1 shows `ordence_app`

✅ **Nothing to do.** RLS has been real all along, the 171 policies are doing their job, and this whole thread was a false alarm that cost one query to close. Go straight to `/api/diag` and the deploy.

## Path B , TAB 1 shows `neondb_owner`

Then this is the highest-value fix left in the project, above every feature and above the deploy.

**If TAB 4 says `✅ YES`:**

1. Neon → **Roles** → set a password on `ordence_app` (Neon generates one; it never comes to me)
2. Build the new `DATABASE_URL` with that role, same host and database
3. Update it on the Railway **service**, redeploy
4. Re-run TAB 1 to confirm the app is now connecting as `ordence_app`
5. Re-run `VERIFY-0091` , its live probes become meaningful in a way they were not before, because RLS now actually applies to the role running them

**If TAB 4 says `🔴 NOT YET`:**

Send me **TAB 3**. It names every table the role cannot read, with whether the table is tenant-scoped and whether RLS is forced on it. I will write `0093_grant_ordence_app.sql` from that list , narrow, per-table, in the style of `0087`, not a blanket grant , and we switch after it applies.

⚠️ **In that case do not switch first and fix forward.** A half-privileged role fails mid-transaction, which is worse than failing at boot: a user believes they completed something that did not happen.

---

## ⭐ One thing I want to build regardless of the answer

**A boot-time assertion that refuses to start, or warns loudly, when the connecting role has `rolbypassrls`.**

The reason this went unnoticed for so long is that **nothing in the product could see it.** `check:rls` reads `pg_catalog` and correctly reports that the policies exist and are forced. It has no way to know that the role skipping them is the one the app uses. Every signal was green while the backstop was, potentially, absent.

That is the same defect shape as the CI floor of `if COUNT -lt 100` that `check:rls` itself was written to replace: **a check that measures the wrong thing passes confidently.**

Say the word and I will add it to `/api/diag` and the boot path, so this question is answered permanently by the product instead of by you and me reading catalogs at 2am.

---

## The list, current

| | |
|---|---|
| ✅ | 0091, 0092 applied. 74 reserved names, 6 history rows, blockers all clear |
| 🔴 | **`CAN-WE-SWITCH-TO-ordence_app` , tabs 1 and 4** |
| 🔴 | `VERIFY-0091` tabs 11 and 12 |
| 🔴 | `/api/diag` , the `missing` array |
| | Then the deploy, and the rest of `DO-THIS-NOW-EVERYTHING.md` |

**Code: v1.59.0-alpha, 15 gates green, tsc clean, 142 test files, 4,936 tests.** Nothing in the code is blocked by any of this.
