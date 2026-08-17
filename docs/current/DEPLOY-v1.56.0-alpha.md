# DEPLOY , Ordence v1.56.0-alpha (Group A: self-serve subdomains)

**Repo: `app.ordence`**

🔴 **SQL: YES. One new migration, `0091_slug_authority.sql`, and it runs BEFORE the code push.**
🔴 **And `PRE-0091-AUDIT-neon-safe.sql` runs before THAT.** It is read-only. Send me its tab 6 first.
⚠️ **No new environment variables.** But `UPSTASH_REDIS_REST_URL` and `_TOKEN` matter more than they did yesterday, see section 7.

**18 gates green. `tsc` clean. 132 test files. 4,713 tests passing, up from 4,467.**

---

## 1. The order. Nothing here is optional and nothing here is reorderable.

| | What | Where |
|---|---|---|
| 1 | `0086` to `0090`, if not already applied | Neon |
| 2 | **`PRE-0091-AUDIT-neon-safe.sql`** , read-only, six tabs. **Send me tab 6 and stop if any row says BLOCK.** | Neon |
| 3 | `0091_slug_authority.sql` | Neon |
| 4 | **`VERIFY-0091-neon-safe.sql`** , nine verdict rows. Send me tab 8. | Neon |
| 5 | Unzip `ordence-v1.56.0-alpha.zip`, commit, push. Railway builds. | GitHub |

⚠️ **Step 2 is not a formality.** Every constraint in 0091 is hard. A single violating row rolls the whole file back and the error names one row while telling you nothing about the other four checks. The audit tells you all five at once, before anything is attempted.

---

## 2. Three live defects this fixes, all of them in v1.55.0-alpha

I read the slug code before writing any of this rather than after.

### 2.1 🔴 Two reserved-word lists that disagreed by eight names in each direction

| File | Decided |
|---|---|
| `lib/tenant.ts:30` | what **resolves** (33 names) |
| `server/platform/provisioning.ts:80` | what can be **created** (34 names) |

| In `lib/tenant.ts` only | In `provisioning.ts` only |
|---|---|
| `logout` `assets` `ftp` `ns1` `ns2` `vercel` `clerk` `preview` | `administrator` `apps` `billing` `console` `ordence` `portal` `secure` `staff` |

Provisioning would happily mint `assets`, `ns1`, `ns2`, `ftp`, `clerk`, `preview`, `vercel`, `logout`. `lib/tenant.ts` then refused to resolve them and fell back to `{ kind: "root" }`. **The workspace provisioned successfully, the operator saw success, and the customer's front door was dead.** Nothing reported it because each half behaved exactly as written.

The other direction is worse in kind: `ordence.ordence.com` serving a customer's content under our own certificate is the phishing surface the comment in `provisioning.ts` says the list exists to prevent.

### 2.2 The minimum length disagreed too

`provisioning.ts` required 3. `SLUG_PATTERN` matched a **single character**. One-letter labels are exactly the ones worth squatting.

### 2.3 ⚠️ The unique index did not prevent the duplicate that matters

`tenants_slug_unique` compares bytes. `normaliseHost()` lowercases the Host header before matching. **`Acme` and `acme` are two legal rows that both answer to `acme.ordence.com`**, and which one wins is whichever the query returns first. That was prevented only by a `.toLowerCase()` in one Zod schema, in one code path, and self-serve signup was about to become a second code path.

---

## 3. ⭐ The principle the whole design hangs off

> **The availability check is advisory. The unique index is the truth. The insert is the claim.**

Any design where a browser asks "is `acme` free?", is told yes, and a later insert **trusts** that answer is a race whose window is the user's typing speed. Two people signing up at the same moment are both told yes.

⭐ **Your existing code already got this right and it became the template.** `provisionWorkspace` line 529 does `ON CONFLICT (slug) DO NOTHING`, checks the row count, and throws `slug_taken_race`. That mechanism was **extracted**, not replaced, into `server/platform/claim-slug.ts`, and both the operator path and the new self-serve path call it.

The screen that greys out Continue is a **mistake guard**. It stops a typo becoming a support ticket. It is not a boundary and it is never the only refusal.

---

## 4. What `0091` puts in the database

| | |
|---|---|
| `tenants_slug_lowercase` | `CHECK (slug = lower(slug))` , closes 2.3 |
| `tenants_slug_shape` | 3 to 63, lowercase alphanumeric and hyphen, no leading or trailing hyphen , settles 2.2 at the stricter reading |
| `reserved_slugs` | a **table**, 71 names, seeded and enforced by trigger. A table rather than a constraint because the list will grow and growing it must be an `INSERT` an operator can do at 2am, not a migration plus a deploy |
| `tenants.slug_fold` + unique index | ⭐ the confusable fold, below |
| `tenant_slug_history` | every slug a tenant has ever held, with a 365-day retention block on release |
| `ordence_guard_tenant_slug()` | `SECURITY DEFINER`, pinned `search_path`, raises `P0091` / `P0092` / `P0093` |

### 4.1 ⭐ The confusable fold, and the bug I found in my own first draft

```
slug_fold = translate(replace(replace(replace(slug,'-',''),'rn','m'),'vv','w'), '01l','oii')
```

Hyphens vanish, `rn` folds to `m`, `vv` folds to `w`, `0` folds to `o`, `1` and `l` both fold to `i`. A unique index on it means `arnazon-traders` cannot exist alongside `amazon-traders`, and `0rdence` cannot exist alongside `ordence`.

🔴 **My first draft used `translate(x,'01l','oli')`.** That maps `1` to **`l`**, not to `i`. It read correctly, it looked correct, and `zedbui1ders` walked straight past the index next to `zed-builders`. **It was caught by executing the constraint against PostgreSQL 16 with a planted collision, not by reading it.** Every claim in this document was drilled the same way.

⚠️ **The cost is real and is accepted deliberately.** This refuses `acme-corp` when `acmecorp` already exists, and those may be two unrelated companies. The cost of the refusal is one support conversation. The cost of the collision is a customer phished under **our** certificate, checking the padlock and finding it real.

### 4.2 🔴 Four reserved names both original lists missed

`postmaster`, `hostmaster`, `webmaster`, `abuse`.

These are addresses a **certificate authority** will accept as proof of domain control. A tenant holding one of those subdomains, with mail on it, can have a certificate issued for a name under our domain. That is not a phishing risk, it is a delegation of our identity.

### 4.3 🔴 Why a released slug is blocked for 365 days

A released slug is a **live hostname**. It sits in every bookmark, every emailed invoice link, every WhatsApp message a site engineer sent, every `From:` header, and permanently in the public certificate transparency log. Re-issuing it to a different company hands that company someone else's inbound traffic.

A year is the shortest defensible figure, not a generous one. Annual business cycles mean a link sent last March is opened this March.

### 4.4 🔴 Why the guard is `SECURITY DEFINER`, proved rather than argued

**A guard that reads a table through RLS fails OPEN.** If the session cannot see the `tenant_slug_history` rows, the lookup returns zero rows, the guard concludes "not recently released", and the claim is allowed. The refusal silently becomes a permission and nothing logs it.

I proved both branches on PostgreSQL 16.13 as an `ordence_app` role with `NOBYPASSRLS`:

```
history rows visible to the caller: 0
with SECURITY DEFINER   -> ERROR: slug "acme" was released on 2026-08-12 and is retained until 2027-08-12
with SECURITY INVOKER   -> CLAIM SUCCEEDED - GUARD FAILED OPEN
```

⚠️ `SECURITY DEFINER` without a pinned `search_path` is a privilege escalation: anyone who can create a schema earlier in the path shadows `reserved_slugs` with an empty table and the guard reads that instead. `SET search_path = public, pg_temp` is the other half of the decision, not hygiene.

---

## 5. What changed in the code

| File | |
|---|---|
| **`lib/slug.ts`** (new) | The one contract. `SLUG_PATTERN`, `RESERVED_SLUGS` (71), `checkSlugShape`, `foldSlug`, `suggestSlugs`, `rejectionFromPgError`. ⚠️ **Imports nothing, not even zod**, because `middleware.ts` reaches it through `lib/tenant.ts` on every request |
| `lib/slug-schema.ts` (new) | The zod layer, in a separate file so zod never enters the Edge bundle. Calls `checkSlugShape`, re-implements no rule |
| `lib/tenant.ts` | Local list and pattern **deleted**, imported and re-exported instead. `resolveTenantFromHost` byte-identical |
| `server/platform/provisioning.ts` | Local list **deleted**. Uses `claimSlug`. Dry run now asks the database's five questions in the database's order |
| **`server/platform/claim-slug.ts`** (new) | The extracted claim. Runs in the caller's transaction, maps SQLSTATEs, never parses English |
| `app/api/public/slug-available/` | `POST`, never a query string. Same five checks in the same order as the insert |
| `components/signup/claim-subdomain.tsx` (new) | The claim screen |
| `server/platform/rename-slug.ts` + `app/api/internal/host-moved/` (new) | Operator rename, and the 301 for released hostnames |
| `db/schema/slugs.ts` (new) + `core.ts` | Drizzle mirror. `slug_fold` is absent from the insert type, so Drizzle can never write it |
| `scripts/check-rls-coverage.mjs` | `tenant_slug_history` added to `OPT_IN_PLATFORM_WRITE` |

### 5.1 ⚠️ Three things the agents found that were already wrong

1. **Drizzle 0.45 wraps driver errors** in `DrizzleQueryError` with the real `pg` error on `.cause`. Reading `err.code` off the top-level object finds nothing, so **every expected refusal would have become an unexpected 500**. Now walks the cause chain.
2. **`tx.execute()` returns two different shapes** , a bare array on `neon-http`, `{rows}` on the pool driver. The existing code indexed `[0]` directly. On the pool driver that yields `undefined`, which would have read as "slug taken" on **every** claim and "no blockers" on **every** dry run. Latent, now fixed.
3. **`tenant_slug_history` was not in `OPT_IN_PLATFORM_WRITE`.** I proved this was load-bearing by removing it and re-running the real gate against a live PostgreSQL: `❌ tenant_slug_history allows app_platform_scope() in WITH CHECK`. It would have failed CI.

### 5.2 ⚠️ And two things I got wrong in my own deliverables

- The `'oli'` fold, section 4.1. Caught by execution.
- **`VERIFY-0091` first reported "live refusals: 0 of 0 PASS".** Two defects, both mine: a `WHEN SQLSTATE 'P0001' AND SQLERRM = '...'` exception clause, which is a syntax error in PL/pgSQL; and a verdict row that printed PASS when nothing had run. **The second is the same class of defect as a CI floor of `if COUNT -lt 100`**, which is the incident `check:rls` was written for. Row 9 now fails on fewer than five attempts, and section 7 records findings in variables outside the subtransaction, because a rollback erases a temp table's rows too.

---

## 6. ⚠️ A behaviour change you should know about before you push

The reserved list went from 33 names to 71, and the minimum length from 1 to 3. **Any existing tenant whose slug is one or two characters, or is one of the 38 newly reserved names, stops resolving and falls back to root the moment this deploys.**

**Tabs 2 and 4 of the pre-audit find exactly these rows.** That is what they are for. If either tab returns anything, we deal with it before 0091 runs, not after.

---

## 7. ⚠️ `UPSTASH_REDIS_REST_URL` and `_TOKEN` matter more now

v1.56.0 puts a **public, unauthenticated endpoint** on the internet at `/api/public/slug-available`, rate limited to 10 per minute and 60 per hour per IP through `lib/edge/limits.ts`.

Without Upstash that limiter falls back to per-instance memory counters, and on a multi-instance deploy the effective limit becomes **the limit multiplied by the instance count**. On an unauthenticated endpoint that is an enumeration tool rather than a speed bump.

🔴 **Do not paste either value to me.** Set them on the Railway **service** and tell me only that they are set.

**And to be clear rather than reassuring:** this endpoint necessarily reveals which workspaces exist. It cannot do otherwise, because tenant hostnames resolve in public DNS and their certificates are published in the transparency log within minutes of issuance. The rate limit stops bulk scraping; it does not hide individual answers, and nobody should later build a feature assuming a tenant slug is confidential. That is written into the code as a comment, not just here.

---

## 8. What was verified, and how

| | |
|---|---|
| 18 gates | all green, run from the staged tree |
| `tsc --noEmit` | clean, after `rm -f tsconfig.tsbuildinfo` (a stale one makes tsc print nothing and exit 0) |
| Tests | 132 files, **4,713 passing**, 8 skipped. Was 4,467 |
| `0091` on real PostgreSQL 16.13 | applied clean, **re-ran clean** (idempotent), all ten refusal paths drilled, plus a control that must be accepted |
| The fold | TypeScript `foldSlug()` compared against the SQL generated column over 26 inputs, byte-identical |
| `check:rls` | run against a live database with 0091 applied. Green, **and proved to fail without the exemption** |
| `VERIFY-0091` | executed end to end. Nine verdict rows PASS, five live refusals, **and the tenant and history row counts unchanged afterwards** |

⚠️ **What is NOT verified: `next build`.** It is OOM-killed in this 8GB container. `check:route-exports` and `check:client-hooks` exist because that gap has broken a Railway deploy twice. They are a subset of what a real build would catch, not a substitute.

---

## 9. Still on your side

| | |
|---|---|
| 🔴 | **Run the pre-audit and send me tab 6.** This is the only hard blocker. |
| 🔴 | Clerk: production instance → Configure → Domains. Does it accept arbitrary `*.ordence.com` hosts? **Domain names only, no keys.** If it does not, batch 134's signup path will authenticate into a session that is not valid on the tenant host and bounce forever. |
| 🔴 | The four-line `rolbypassrls` query. Nine sessions. |
| | `UPSTASH_REDIS_REST_URL` + `_TOKEN` on the service |
| | `VAULT_ENCRYPTION_KEY` + `VAULT_BLIND_INDEX_PEPPER`, `openssl rand -hex 32`, **never pasted to me** |
| | Groq and Cloudflare Workers AI keys |
| | `projects.state_code` on every live project |
| | One suspended workspace to test against, for batch 24 |

---

## 10. What is NOT in this release, deliberately

- **Self-serve rename.** Operator-only for now. Rename is a hostname change and the owner notification does not exist yet.
- **The signup funnel.** `app/(marketing)/claim/page.tsx` is a **placeholder host** for the component. There is no self-serve signup step today that asks for an address: `/sign-up` is Clerk's widget and `/onboarding` is Clerk's `CreateOrganization`. The component is built, tested and ready; wiring it needs the funnel decision, which is a product call, not a code one.
- **Group B, the admin console.** Eight parallel batches, no SQL. Say go and I run it as one wave.
