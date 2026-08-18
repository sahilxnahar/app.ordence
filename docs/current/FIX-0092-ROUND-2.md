# 0092, round two , and this time I reproduced it before writing the fix

**Repo: `app.ordence`** · v1.58.1-alpha · 🔴 **Re-run `0092` (attached). Nothing else changes.**

---

## What your three tabs told me

```
1: BEGIN   executed successfully
2: SET     executed successfully
3: ERROR
```

⚠️⚠️ **`SET LOCAL` succeeded and then evaporated.** The Neon SQL editor sends each statement **separately**, so the setting was scoped to a transaction on a connection the INSERT never used. The `SET` tab is telling the truth about a setting that was already gone by the time statement 3 ran.

**I reproduced it exactly**, by sending each statement on its own connection as a non-superuser role without `BYPASSRLS`:

```
BEGIN;                                  -> BEGIN
SET LOCAL app.platform_scope = 'on';    -> SET
INSERT INTO reserved_slugs ...          -> ERROR: new row violates row-level security policy
```

Three statements, three connections, and the identical failure.

---

## 🔴 My mistake, and it is the same one twice

Last round I proved the fix with `psql -f`. **psql sends the whole file on ONE connection**, so `BEGIN` / `SET LOCAL` / `INSERT` shared a transaction and it applied perfectly. The browser does not work that way.

**I tested the file the way it is not used, and called it verified.** That is precisely the criticism I made of the first version an hour earlier, when I drilled it as a superuser and a superuser bypasses RLS. Same shape, different privilege: **the reproduction has to match the situation, not just the file.**

Every migration in this project is pasted into a browser. From now on that is how I test them, and there is now a gate that enforces it rather than a resolution.

---

## ⭐ The fix: the scope and the write are one statement

```sql
DO $reserve$
BEGIN
    PERFORM set_config('app.platform_scope', 'on', true);
    INSERT INTO public.reserved_slugs (...) VALUES (...) ON CONFLICT (slug) DO NOTHING;
END
$reserve$;
```

A `DO` block is **one statement**, therefore one connection and one transaction by construction. There is no gap for the setting to be lost in. No `BEGIN`, no `COMMIT`, no `SET LOCAL` anywhere in the file, so a failure also cannot strand your editor in "ROLLBACK required".

**Verified the way it will actually be run:** the file split into its five top-level statements, each sent on its own fresh connection, as a non-superuser role without `BYPASSRLS`. All five succeed, and statement 5 returns `PASS`.

---

## ⭐ And the diagnostic now runs FIRST

Section 1 is a read that cannot fail. **If section 3 refuses again, you still get the answer that matters.**

A file whose most valuable output sits behind its least certain operation teaches you nothing on the day it breaks , which is exactly what happened to you twice.

You now get five result tabs:

| Tab | What |
|---|---|
| **1** | 🔴 **The diagnostic.** `bypasses_rls`, `is_superuser`, `tenant_count`. **Send me this one.** |
| 2 | Any existing tenant holding `clkmail` / `clk` / `clk2`. Expect zero rows |
| 3 | The insert. Reports how many rows it added |
| 4 | The three names, confirmed present |
| **5** | 🔴 **The verdict.** `PASS` or `FAIL`. **Send me this one too.** |

---

## ⭐ The gate now rejects the shape I shipped

`npm run check:sql-rls-writes` already refused a plain write to a FORCE-RLS table. It now **also refuses `SET LOCAL app.platform_scope` as the only scope mechanism**, with the console explanation in the failure message.

**Proved load-bearing by reintroducing the exact defect**, not by assertion:

```
0092_reserve_clerk_hosts.sql , uses `SET LOCAL app.platform_scope` as its only
scope mechanism. That succeeds and then evaporates in a browser SQL console...
```

Restored, and all 15 gates are green.

---

## Everything else in the checklist is unchanged

`DO-THIS-NOW-EVERYTHING.md` still stands. Only phase 1.1 changes, and only in that you re-run `0092` and send me **tab 1 and tab 5** instead of "the section 3 row".

Still waiting on:

1. `0092` **tab 1** and **tab 5**
2. `VERIFY-0091` **tab 8**
3. `/api/diag` **`missing`** array
4. Whether the deploy goes green
