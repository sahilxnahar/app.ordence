# Recovery , read this before running anything

**Repository:** `sahilxnahar/app.ordence`
**Your repo is currently broken at `e09dcd7`.** This gets it to v1.81.0-alpha.

---

## What actually happened

**My package was correct. It was extracted into the wrong directory.**

The zip was unpacked inside `components/` instead of at the repository root, so
every path landed one level too deep , `components/app/...`,
`components/server/...`, `components/lib/...` , and the **213 real component
files that were in `components/` were lost in the same operation.**

That is why the build says:

```
Module not found: Can't resolve '@/components/budgets/budget-editor'
```

`budget-editor.tsx` was in your repo and building fine at `181dfe1`. It is not
in `e09dcd7`.

⚠️ **Webpack named five missing modules. There are 305.** It stops early. Fixing
the five it named would have bought you another failed build, then another.

⚠️ **The commit is labelled "1.80.0" but `package.json` in it still says
1.65.0-alpha** , because my `package.json` also landed one level down, at
`components/package.json`. That mismatch is the quickest way to spot this class
of mistake in future.

Nothing is lost. Git still has the good state.

---

## The fix , four commands

Run these from the **root of your local clone**, on `main`, with a clean tree.

```bash
# 1. Undo the bad commit. This restores the 213 component files.
git revert --no-edit HEAD

# 2. Extract at the ROOT. Note: no `-d`, no `cd` into a subfolder.
unzip -o ordence-v1.81.0-alpha.zip

# 3. 🔴 VERIFY BEFORE YOU COMMIT. This is new, and it is the whole point.
node scripts/check-unresolved-imports.mjs

# 4. Only if step 3 printed ✅
git add -A && git commit -m "1.81.0" && git push
```

**Step 3 must print:**

```
✅ every @/ import resolves to a real file
```

If it prints a list instead, **do not commit.** Send me the list.

### How to tell it worked, before you push

```bash
node -e "console.log(require('./package.json').version)"   # 1.81.0-alpha
find components -type f | wc -l                            # 243
```

If `package.json` still says 1.65.0-alpha, the archive went somewhere else
again. `git checkout .` and try step 2 from the repository root.

---

## I rehearsed this exact sequence

Not as advice , I ran it, on a clone of your repository at `e09dcd7`:

| step | result |
|---|---|
| `git revert --no-edit HEAD` | components 451 → **213**, imports all resolve |
| `unzip -o` at the root | components 213 → **243**, version → **1.81.0-alpha** |
| `check:unresolved-imports` | ✅ **1,596 files scanned, zero unresolved** |
| diff against the tree I ran the suites on | **byte-identical** |

---

## What is new in this package beyond the last one

**Gate 26, `check:unresolved-imports`.** It is `next build`'s module resolution,
in isolation, in under a second.

Nothing in the repository would have caught this before:

- `tsc --noEmit` reads the tree on disk, so it is clean on a correct tree and
  never sees the broken commit
- the other 23 gates ask specific questions of specific files; none asks "does
  every import point at something that exists"
- the test suites only see modules that something under test imports
- `next build` does catch it , and it is the expensive last step that costs a
  failed deploy to learn from

It ships with four tests, including one that **proves the gate fails** on a tree
with a missing module. A gate nobody has watched fail is not a gate.

It runs in `npm run gates:static`, in `preflight`, and in CI.

---

## Verification on the final tree

| check | result |
|---|---|
| `check:unresolved-imports` | ✅ 1,596 files, zero unresolved |
| static CI gates | **24/24** |
| `tsc --noEmit` | clean |
| Security suite | 48 files, 1,290 tests |
| UI suite | 200 files, 6,648 tests (+4 for the new gate) |
| Dependencies vs what is running | **identical** , no new packages |

🔴 **`next build` is still unverified by me.** It OOM-kills in my container at
both 5.1 GB and 2.8 GB heap caps. Gate 26 now covers the specific failure you
just hit; it does not cover everything `next build` does. Your Railway build is
still the first place a full compile happens.

---

## After it deploys

1. Run the two SQL files that had to wait for this code:
   `0106_tds_foreign_payments_rule_26.sql`, then
   `0111_deemed_service_and_notice_authority.sql`
2. Run `WHATS-PENDING-neon-safe.sql` , expect **pending: 0**
3. Run `0128_change_log_retention.sql` , 0122 attached the change recorder to
   215 tables and nothing prunes that table yet
