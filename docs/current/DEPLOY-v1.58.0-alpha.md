# DEPLOY , Ordence v1.58.0-alpha (Group B complete)

**Repo: `app.ordence`**

🔴 **SQL: NOTHING NEW.** Group B is code-only, all nine batches. The only outstanding SQL is the corrected **`0092`** from the last delivery, which you still need to run.
⚠️ **No new environment variables.**

**15 gates green. `tsc` clean. 142 test files. 4,936 tests passing, up from 4,467 when Group A started.**

---

## What landed

| Batch | What | Note |
|---|---|---|
| **primitives** | `DataTable` with full URL state, `Cmd+K` command palette, `ConfirmDestructive` | Seven batches consume these. Sort, filter, page and selection all live in the query string, so **a filtered view is now a link somebody can send**. None of the console tables survived a refresh before. |
| **28** | Impersonation hardening | Read-only by default, thirty-minute hard cap, live owner notification, non-dismissible banner |
| **43** | The three approval policies | Declared in config, enforced by nothing. Now enforced in the transaction |
| **125** | Tenant 360, eight tabs | Tabs are URL state, each panel `<Suspense>`s independently, plan and seats edit optimistically with a visible rollback |
| **122** | Onboarding progress | Stalled-first, age in days as the primary number |
| **131** | Maintenance mode and deploy history | Read-only enforcement reuses batch 28's gate rather than adding a second one |
| **130** | Access reviews | Bulk revoke, all or nothing, every id re-authorised server-side |
| **127** | Secret rotation board | Metadata only. No value, no prefix, no length |
| **126** | Provisioning and cohorts | The dry-run diff the code already computed and nothing showed |

The console went from 13 nav destinations to **19**.

---

## ⭐ Four places the agents refused to fake it

This is the part worth reading, because each one is a place the easy version would have looked better and been a lie.

**Batch 122 could not find an invite path**, so "resend invite" ships **disabled with the reason on the button**. There is no invitation table, no Clerk organisation-invitation call anywhere, and `provisionTenant` lists "invite the owner" as a human step. *A button logging a resend that delivers nothing is a lie with a receipt.*

**Batch 131 has no deployments table** and was forbidden from creating one. It built the history from `package.json`, `RAILWAY_GIT_COMMIT_SHA`, `CHANGELOG.md` and the migration files, and **every recorded row's outcome reads `UNKNOWN , not observed`**, with the page stating in prose what it cannot know. It never normalises `unchanged` into something that looks applied.

**Batch 127 shows `never recorded`, not `never rotated`.** Those are different claims and the page says so. It also **imports** the name lists from `lib/env-boot.ts` and the diagnostic rather than copying them, and a test asserts set equality both directions, because two lists kept in sync by discipline is exactly what produced migration 0091.

**Batch 125 renders Incidents as an honest "not wired" panel.** `platform_incidents` carries an unresolved `affected_filter` JSONB and `getIncidents()` takes no tenant argument. It names both gaps and links to the global board **labelled as global**, rather than listing incidents it never checked.

---

## ⚠️ Three things found while integrating

**1. A sixth shape-pinned test, and the first duplicated one.** Batch 130 extracted the owner floor out of `revokePlatformStaff` into `usableOwnersExcluding()` so a bulk revoke could be one decision instead of N. Every term survived; only the address changed. **Three assertions across TWO files failed a change that was strictly better**, and because both files pinned the same literal `ne(platformStaff.id, staffId)`, batch 130 fixing one still left the other red.

All three now assert the property: the floor is computed from the allowlist, over active owner rows, excluding the ids being revoked, without stopping at the first row. `ne(id, x)` and `notInArray(id, xs)` are accepted as the same property, because they are.

🔴 **Sixth instance. The pattern is not carelessness, it is that source-text assertions are cheap to write and silently couple to layout.** Worth a rule: an assertion that reads a slice of one function pins WHERE, and must be paired with one that reads the module and pins WHETHER.

**2. Three agents edited `CONSOLE_NAV` concurrently** and each re-read the file immediately before appending. All six entries survived. That instruction was in the prompts for a reason and it earned its place.

**3. Two agents in the first Group B wave died to API 500s** after 160+ tool calls. **Their work was on disk and passed everything** , only the final reports were lost. Later waves were scoped tighter and all six finished.

---

## Deploy

1. **SQL: run the corrected `0092` if you have not.** Nothing else.
2. Unzip, commit, push. Railway builds.
3. `admin.ordence.com` gets six new destinations. `Cmd+K` works everywhere in the console.

---

## Still on your side

| | |
|---|---|
| 🔴 | The corrected **`0092`**, and send me its section 3 diagnostic row , it answers the nine-session `rolbypassrls` question |
| 🔴 | **`VERIFY-0091`** (corrected copy), tab 8 |
| 🔴 | `https://app.ordence.com/api/diag` , the `missing` array. Names only |
| | `VAULT_ENCRYPTION_KEY` + `VAULT_BLIND_INDEX_PEPPER`, `openssl rand -hex 32`, **never pasted to me** |
| | Groq and Cloudflare Workers AI keys |
| | `projects.state_code` on every live project |
| | One suspended workspace to test, for batch 24 |

⚠️ **Still not verified: `next build`.** It is OOM-killed in this container. `check:route-exports` and `check:client-hooks` exist because that gap broke a Railway deploy twice. They are a subset of what a real build catches, not a substitute.
