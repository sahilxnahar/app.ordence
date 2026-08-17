# Batch works · the admin console, and self-serve subdomains

**Repo: `app.ordence`** · base **v1.55.0-alpha** · 275 tables · 90 migrations · 18 gates · 4,467 tests

**SQL: yes, one new migration, `0091`.** It is the *only* new SQL in this whole document, it belongs to Group A, and it goes **BEFORE the code push** like every other migration in this project. Group B (the console work) has **no SQL at all**.

---

## 0. Three real defects I found while grounding this

I read the slug code before writing the plan rather than after. These are not hypotheticals, they are in `v1.55.0-alpha` right now, and **Group A must fix them or it will ship the duplicate it is supposed to prevent.**

### 0.1 🔴 There are two reserved-word lists and they disagree, eight names in each direction

| File | Purpose |
|---|---|
| `lib/tenant.ts:30` | decides whether a hostname **resolves** to a tenant |
| `server/platform/provisioning.ts:80` | decides whether a slug can be **created** |

They were written separately and they have drifted:

| In `lib/tenant.ts` only | In `provisioning.ts` only |
|---|---|
| `logout` `assets` `ftp` `ns1` `ns2` `vercel` `clerk` `preview` | `administrator` `apps` `billing` `console` `ordence` `portal` `secure` `staff` |

**Both directions are bugs, and they fail differently.**

- Provisioning will happily mint `assets`, `ns1`, `ns2`, `ftp`, `clerk`, `preview`, `vercel`, `logout`. The workspace is created, the row exists, the operator sees success, and then `lib/tenant.ts` refuses to resolve the hostname and falls back to `{ kind: "root" }`. **The customer's workspace provisions successfully and its front door is dead.** Nothing reports this, because each half is behaving exactly as written.
- The other direction is worse in kind and less likely in practice: `lib/tenant.ts` would resolve `ordence`, `billing`, `console`, `portal`, `secure`, `staff` if any path ever minted them. `ordence.ordence.com` serving a customer's content under our certificate is the exact phishing surface the comment in `provisioning.ts` says the list exists to prevent.

**Fix: one list, exported once, imported twice, mirrored into the database.** Not two lists kept in sync by discipline. Discipline is what produced this.

### 0.2 The two files also disagree about minimum length

`provisioning.ts` requires `min(3)`. `SLUG_PATTERN` in `lib/tenant.ts` matches a **single character**. So `a.ordence.com` and `x.ordence.com` resolve as tenants if anything ever creates them, and one-character labels are precisely the ones worth squatting.

### 0.3 ⚠️ The unique index does not prevent the duplicate you actually care about

`tenants_slug_unique` is a plain unique index on the raw `slug` column. PostgreSQL compares it byte for byte.

`normaliseHost()` lowercases the Host header before matching. So **`Acme` and `acme` are two legal rows that both answer to `acme.ordence.com`**, and which one you get is whichever the query returns first. Nothing in the database prevents this. It is prevented today only by `.toLowerCase()` in one Zod schema, in one code path, and self-serve signup is about to become a second code path.

The database has to hold this, not the form.

---

## GROUP A · Self-serve subdomain claiming

Three batches. **Do them in order, they are not parallel.**

### The one principle everything else hangs off

> **The availability check is advisory. The unique index is the truth. The insert is the claim.**

Any design where the browser asks "is `acme` free?", is told yes, and then a later insert trusts that answer, is a race with a window measured in whatever the user's typing speed is. Two people signing up at the same moment both get told yes.

⭐ **The good news: `server/platform/provisioning.ts` already gets this right and should be the template.** Line 529 does `ON CONFLICT (slug) DO NOTHING`, checks the returned row count, and throws `slug_taken_race`, which surfaces to the operator as *"The slug was claimed a moment ago by someone else. Pick another."* The comment at line 469 says outright that this is what actually prevents the duplicate. **Do not invent a new mechanism for self-serve. Reuse this one.**

The screen that greys out the Continue button when a slug is taken is a **mistake guard**. It stops a typo becoming a support ticket. It is not a boundary and must never be the only refusal. The refusal happens on the server, inside the transaction, from the index.

---

### Batch 132 · Migration `0091`, the database becomes the authority on slugs

**No UI. Database only. This ships and is verified before 133 is written.**

Five things go in `SQL-FILES/0091_slug_authority.sql`:

**1. Lowercase, enforced.**

```sql
ALTER TABLE tenants
  ADD CONSTRAINT tenants_slug_lowercase CHECK (slug = lower(slug));
```

⚠️ **Run the read-only audit first.** If any existing row has an uppercase character, this `ALTER` fails and takes the whole migration with it. The audit is section 1 of the verify file described below, and it must be run and returned to me before 0091 goes anywhere near Neon.

**2. Minimum length, enforced, matching the stricter of the two code paths.**

```sql
ALTER TABLE tenants
  ADD CONSTRAINT tenants_slug_shape
  CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$');
```

That pattern is deliberately `{1,61}` rather than `{0,61}`, which makes 3 the minimum and keeps 63 the maximum. It is the DNS label rule and the product rule at the same time, in one place, in the layer neither TypeScript file can bypass.

**3. A `reserved_slugs` table, seeded with the union of both lists.**

Not a `CHECK` with a literal array. A table, because this list will grow, and growing it must be an `INSERT` an operator can do at 2am rather than a migration and a deploy. Enforce it with a `BEFORE INSERT OR UPDATE` trigger on `tenants` that raises with a clear message.

Seed it with **all 41 names** (33 from `lib/tenant.ts` and 34 from `provisioning.ts`, union). Then add the ones neither list has and both should: `smtp2go` style vendor labels are not the point, but these are: `mx`, `email`, `webmail`, `autodiscover`, `_domainkey`, `dmarc`, `spf`, `imap`, `pop`, `vpn`, `git`, `ci`, `sso`, `idp`, `oauth`, `account`, `accounts`, `pay`, `payment`, `payments`, `invoice`, `invoices`, `gst`, `verify`, `verification`, `security`, `abuse`, `postmaster`, `hostmaster`, `webmaster`.

🔴 **`postmaster`, `hostmaster`, `webmaster` and `abuse` are not tidiness.** They are the addresses certificate authorities will accept as proof of domain control. A tenant holding one of those subdomains plus its mail is a tenant who can get a certificate issued.

**4. ⭐ A confusable fold, and a second unique index on it.**

This is the one thing in Group A that does not exist anywhere in the codebase today and is the one most worth building.

```sql
ALTER TABLE tenants
  ADD COLUMN slug_fold text
  GENERATED ALWAYS AS (
    translate(replace(slug, '-', ''), '01l', 'oli')
  ) STORED;

CREATE UNIQUE INDEX tenants_slug_fold_unique ON tenants (slug_fold);
```

`0` folds to `o`, `1` and `l` fold to `i`, hyphens are removed. So `0rdence`, `ordence`, `0rdenc3`... and `acme-corp` versus `acmecorp` collapse to one namespace.

⚠️ **Name the tradeoff honestly, because it is real.** This refuses `acme-corp` when `acmecorp` already exists, and those may be two unrelated companies. That is a deliberate choice: the cost of the refusal is one support conversation, the cost of the collision is a customer being phished by a hostname that carries our certificate. **But the error message must say exactly why**, and it must name the conflicting existing slug is *not* something to reveal to an unauthenticated signup form. So: *"That name is too similar to an existing workspace. Try adding a word."* On the operator console, where the reader is staff, the message may name the conflict.

⚠️ **Existing rows may already collide under the fold.** `CREATE UNIQUE INDEX` will fail if so. Section 2 of the audit finds them. Do not resolve a collision by editing a live slug without reading batch 134 first, because changing a slug changes a hostname.

**5. `tenant_slug_history`.**

```
id · tenant_id · slug · claimed_at · released_at · release_reason
```

A row goes in on every claim and gets `released_at` set on every rename. The trigger from item 3 also refuses any slug present in this table with `released_at` inside the last **365 days**, regardless of which tenant released it.

🔴 **Why 365 days and why this matters more than it sounds.** A released slug is not a free name. It is a live hostname sitting in every bookmark, every emailed invoice link, every WhatsApp message a site engineer sent, every `From:` header, and permanently in the public certificate transparency log. Re-issuing it to a different company hands that company someone else's inbound traffic and, if mail is ever attached to tenant subdomains, someone else's mail. A year is the shortest defensible retention.

**Deliverables for 132:**

- `SQL-FILES/0091_slug_authority.sql`
- `SQL-FILES/PRE-0091-AUDIT-neon-safe.sql` , read-only, four sections: uppercase rows, fold collisions, slugs that violate the shape, and slugs currently sitting in the reserved union. **You run this and send me the four tabs before 0091 runs.**
- `SQL-FILES/VERIFY-0091-neon-safe.sql` , returns **result rows**, not `RAISE NOTICE`. Neon's editor does not show notices, which I got wrong once already on `VERIFY-0089` and will not repeat.
- Drizzle schema updated to match, `check:migrations` and `check:sql` green.
- 🔴 **No `drizzle-kit push`.** Still banned, still for the same reason: it drops RLS policies on 275 tables, silently.

---

### Batch 133 · One slug module, both callers, and the availability endpoint

**Prerequisite: 0091 applied and verified.**

**1. Delete both reserved lists and both patterns. Create `lib/slug.ts`.**

It exports `RESERVED_SLUGS`, `SLUG_PATTERN`, `isValidSlug`, `slugSchema` and `foldSlug`. `lib/tenant.ts` imports it. `server/platform/provisioning.ts` imports it. Neither file keeps a copy.

⭐ **And a test that reads `reserved_slugs` from the database and asserts the TypeScript set matches it exactly.** Two lists drifted once. A third copy in TypeScript will drift again unless something fails when it does. That test is the something.

**2. `POST /api/public/slug-available`.**

Body `{ slug }`. Returns `{ available: boolean, reason?: string, suggestions?: string[] }`.

- **`POST`, not `GET`, and never a query string.** Standing rule, and it applies here: no user-supplied identifier in a URL that lands in access logs and referer headers.
- It runs the full check in the same order the database will: shape, reserved table, history retention, exact unique, fold unique. **Same code path, same messages, same order.** An availability check that uses different logic from the insert is a check that lies, which is the exact failure mode I named in the v1.50.0 verdict: *the check is written from the same mental model as the code, so it is blind to precisely the mistakes the code makes.* Here the fix is that there is only one mental model to be blind with.
- Rate limit it hard: **10 per minute per IP, 60 per hour**, through `lib/edge/limits.ts`. ⚠️ That limiter only works if `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are set. They are still not set. Without them the limit is per-instance memory, which on a multi-instance deploy means the effective limit is the limit times the instance count.
- **Do not pretend the answer is a secret.** This endpoint tells an anonymous caller which workspaces exist. It is worth being clear-eyed that it cannot do otherwise: `acme.ordence.com` resolves in public DNS and the certificate is published in the transparency log the moment it is issued. **The rate limit exists to stop bulk enumeration, not to hide individual answers**, and nobody should later build a feature on the assumption that a tenant slug is confidential.
- Suggestions are generated from the requested slug (append a word, append a region, append a number) and **each suggestion is checked, not just generated**. A suggestion that is itself taken is worse than no suggestion.

**3. Refactor `provisionWorkspace` so the claim is a function.**

`claimSlug(tx, slug, tenantId)` , runs inside the caller's transaction, does the `ON CONFLICT DO NOTHING`, checks the row count, writes the `tenant_slug_history` row, and throws `slug_taken_race` on zero rows. The operator provisioning path and the self-serve path both call it. **One claim implementation, two callers**, same shape as the reserved list fix.

---

### Batch 134 · The self-serve claim screen, and rename

**1. Signup step: choose your address.**

A single input with `.ordence.com` rendered as a fixed suffix, so nobody types a dot. Debounced 400ms against the endpoint. Three states only: checking, available, unavailable-with-reason. Suggestions appear as clickable chips.

🔴 **The Continue button being enabled is not permission.** Submit re-runs the whole check server-side inside the transaction. When it loses the race, the user sees *"Somebody claimed that address a moment ago. Here are three that are free right now,"* with the three already re-checked. **That path must have a test that runs it.** Not a test that asserts the error message exists, a test that runs two claims concurrently and asserts exactly one wins and the loser gets that message. This is the single most important test in Group A.

**2. Rename, in the console, operator-only, for now.**

Do **not** ship self-serve rename in this batch. Rename is a hostname change and it needs the redirect and the notification to exist first.

Rename does: claim the new slug via `claimSlug`, set `released_at` on the old history row with a reason, and write to the action register. `middleware.ts` learns one new behaviour: a host whose label matches a `tenant_slug_history` row released within 365 days responds **301 to the same path on the new host**, and serves no data at all under the old name. Not a rewrite, not a fallback render. A redirect and nothing else.

**3. ⚠️ Two prerequisites I have not verified and you must, before 134 ships**

| | Check |
|---|---|
| 🔴 | **Clerk must accept arbitrary `*.ordence.com` hosts.** If the production instance is configured only for `app.ordence.com`, a customer landing on `acme.ordence.com` will authenticate into a session that is not valid there and bounce to sign-in forever. This is the same class of failure that made `admin.ordence.com` look broken for three sessions. Your own runbook is at `FINAL/reference/CLERK-PRODUCTION-DNS.md`. |
| ⚠️ | **The wildcard certificate covers one label only.** `acme.ordence.com` is covered by `*.ordence.com`. `acme.corp.ordence.com` is not. `SLUG_PATTERN` already forbids dots, so this holds, but the rule should be a comment in `lib/slug.ts` so nobody relaxes the pattern later without knowing what it costs. |

Railway already has `*.ordence.com` attached on port 8080, so the DNS and routing half is done. I confirmed that directly.

---

## GROUP B · Making the console genuinely usable

Eight batches. **These are parallel.** No SQL in any of them.

### The four rules that apply to every one of them

1. 🔴 **Every link goes through `consoleHref(canonical, isConsoleHost)`.** The console is served at two base paths, `/platform/x` on `app.ordence.com` and `/x` on `admin.ordence.com`. A hardcoded `href="/platform/..."` inside `app/platform/**` is the bug that made every nav item 404. `check:console-links` fails the build on it now. **Do not work around the gate, use the helper.**
2. 🔴 **A screen that hides a button is a mistake guard, not a boundary.** Every mutation re-checks the operator, the tier-2 guard sits one hop from the server-action export, and every platform write goes through `withPlatformScope(reason, cb)` with a reason a human would recognise in the register six months later.
3. ⚠️ **A `route.ts` may export only HTTP verbs and Next config fields.** `check:route-exports` catches it, but it exists because Railway caught it first, and Railway costs a build.
4. **Money is `bigint` minor units end to end.** No `Number`, no `toFixed`, no display helper that takes a float.

### The batches

| # | Batch | The point of it | What "interactive" means here |
|---|---|---|---|
| **125** | **Tenant 360, all eight tabs** | The screen you live in. Everything about one workspace on one page: plan, seats, storage, health, open incidents, recent actions, entitlements, billing state. | Tabs are URL state so a tab is linkable. Every panel loads independently, so a slow one does not hold the page. Inline edit on plan and seats with `useOptimistic` and a visible rollback when the server refuses. |
| **122** | **Onboarding progress** | Which new workspace stalled, while it can still be rescued. A customer stuck on step 3 for nine days is churn you can still stop. | A stalled-first list, not a chronological one. Age in days rendered as the primary number. One-click "resend invite" and "call me" that write to the register. |
| **131** | **Maintenance mode and deploy history** | Turn the product read-only, deliberately, with a banner customers actually see, and know which deploy did what. | Typed confirmation for enabling maintenance, the tenant name typed in full. A live countdown. Deploy history as a filterable table with the commit and the migration range. |
| **130** | **Access reviews** | A monthly pass over every impersonation and every staff grant. This is the thing an auditor asks for and the thing you cannot reconstruct later. | Bulk select with **server-side re-check of every single id**, never trusting the ids the browser sent. Keyboard `j`/`k`/`x` to move and select. Revoke is one action for the whole selection, in one transaction, all or nothing. |
| **127** | **Secret rotation board** | Which secret is how old, and when it was last rotated. | 🔴 **Metadata only. Never a value, never a prefix, never a masked value with the last four visible.** Age as a coloured band with a **word** on it, because roughly one in twelve Indian men is colour-blind. |
| **126** | **Provisioning and cohorts** | The operator side of Group A, plus grouping workspaces by when they joined so you can see whether onboarding is getting better or worse. | The dry-run result rendered as a diff before apply, which the code already produces and nothing currently shows. Cohort table sortable by any column, sort state in the URL. |
| **28** | **Impersonation hardening** | Entering a customer's workspace is the most dangerous thing this console can do. | Owner notified **live**, not by email later. Thirty-minute hard cap with a visible countdown. **Read-only by default**, and lifting it is a separate deliberate action that names a reason and writes to the register. A persistent banner that cannot be dismissed. |
| **43** | **The three approval policies** | They are declared in configuration and enforced by nothing. That is worse than not having them, because the config reads as a control. | Wire each one to its actual gate. Then the four-eyes queue on the dashboard becomes real, which is what the chosen design direction builds its right-hand decision stack out of. |

### Three things that make all eight feel interactive, built once

Build these in **125** and let the other seven consume them.

- **`<DataTable>` with URL state.** Sort, filter, page and selection all live in the query string. A link to a filtered view is a link somebody can send. Today none of these tables survive a refresh.
- **A command palette on `Cmd+K`.** Every nav destination, every workspace by name or slug, and every action the current page exposes. For a console with fourteen destinations across two base paths, this is the difference between navigating and hunting. It goes through `consoleHref()` like everything else.
- **`<ConfirmDestructive>`.** Types the object's own name to arm. Used by maintenance mode, revoke, impersonation escalation and rename. One component, so the standard cannot drift per screen.

⚠️ **Live data by polling, not websockets.** Refetch on an interval with `router.refresh()`, and pause when the tab is hidden. Railway behind a proxy with multiple instances is not where you want to debug a socket, and none of these screens need sub-second latency.

---

## Running order

| | |
|---|---|
| **Now, you** | Run `PRE-0091-AUDIT-neon-safe.sql` and send me the four tabs. |
| **Then** | 0091 into Neon, verify with `VERIFY-0091-neon-safe.sql`. |
| **Then** | 133 and 134 as one push. Group B batches 125, 122, 131, 130 in parallel with them, they touch nothing 0091 touches. |
| **Then** | 127, 126, 28, 43. |

**Say go and I run Group B as one wave.** Group A I would rather do myself in sequence, because it is three batches where the second cannot be written until the first is verified against your real data, and that is not a shape that parallelises.

---

## Still open from before, unchanged

| | |
|---|---|
| 🔴 | Deploy v1.55.0-alpha, and run `0086` to `0090` first if they are not already in |
| 🔴 | The four-line `rolbypassrls` query. Nine sessions now. |
| | `VAULT_ENCRYPTION_KEY` + `VAULT_BLIND_INDEX_PEPPER`, `openssl rand -hex 32`, set in Railway, **never pasted to me** |
| | `UPSTASH_REDIS_REST_URL` + `_TOKEN` , **batch 133's rate limit depends on these** |
| | Groq and Cloudflare Workers AI keys |
| | `projects.state_code` on every live project |
| | One suspended workspace to test against, for batch 24 |
