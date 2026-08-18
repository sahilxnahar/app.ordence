# Everything left, in order, with the links

**Repo: `app.ordence`** · code is at **v1.58.0-alpha** · Neon is at **0091 applied, 0092 pending**

Five phases. **Phase 1 is 10 minutes and unblocks me**, so do it first even if you stop there. Nothing in phase 1 changes anything.

Your links, all verified, all specific to your project:

| | |
|---|---|
| **Neon SQL editor** | https://console.neon.tech/app/projects/round-math-92878167/branches/br-winter-surf-azcncm6b/sql-editor?database=neondb |
| **Railway variables** | https://railway.com/project/e298fdd1-7172-4011-8011-eb97630e84ed/service/be4ed0d2-3bbb-497f-a45c-333e00f61955/variables?environmentId=513c6404-7105-4161-8847-dac998c90802 |
| **Railway deployments** | https://railway.com/project/e298fdd1-7172-4011-8011-eb97630e84ed/service/be4ed0d2-3bbb-497f-a45c-333e00f61955?environmentId=513c6404-7105-4161-8847-dac998c90802 |
| **Clerk API keys** | https://dashboard.clerk.com/apps/app_3HKgI2uv7UU2OBhhLZMxvvbQ6YB/instances/ins_3HOVolZvefD6qI4MqGmOqq4TD1g/api-keys |
| **Clerk webhooks** | https://dashboard.clerk.com/apps/app_3HKgI2uv7UU2OBhhLZMxvvbQ6YB/instances/ins_3HOVolZvefD6qI4MqGmOqq4TD1g/webhooks |
| **Your diagnostic** | https://app.ordence.com/api/diag |

---

# PHASE 1 · Ten minutes. Read-only. Do this first.

## 1.1 Run the corrected `0092` in Neon

Open the **Neon SQL editor** link. Paste **`0092_reserve_clerk_hosts.sql`** whole. Run.

**Send me the SECTION 3 row.** It looks like this:

```
finding | running_as | bypasses_rls | is_superuser | tenant_count | history_rows | reserved_count | what_that_means
```

🔴 **That one row closes a question I have asked for nine sessions.** `bypasses_rls` is one of three ways row-level security can be silently ineffective. If it is `false`, every `FORCE ROW LEVEL SECURITY` in your database is real and your tenant isolation rests on something. If it is `true`, RLS is decoration for that role and the isolation rests entirely on the application never using it, which is a much weaker position and I would need to say so plainly.

`tenant_count` also tells me whether `0091`'s backfill was a real success or a no-op that never exercised the same policy.

⚠️ **If section 2 returns any row**, stop and tell me before touching it. That would mean a workspace already holds `clkmail`, `clk` or `clk2`, and renaming a slug changes a live hostname that `0091` then blocks for 365 days.

## 1.2 Run the corrected `VERIFY-0091` in Neon

Same editor. Paste **`VERIFY-0091-neon-safe.sql`** whole. Run.

**Send me TAB 8.** Nine rows, each a thing `0091` promised. **Row 9 is the one I care about**: it attempts five real operations against your actual data, one of which is a control that must be **accepted**, then four that must be **refused**. Everything rolls back and the tenant count is unchanged afterwards.

⚠️ **Use the corrected copy from the last delivery, not the earlier one.** The earlier one inserted into `tenants` without setting the platform scope, so for a role without `BYPASSRLS` every probe would have been refused by RLS rather than by the thing being tested, and rows 2 to 5 would have reported **PASS for the wrong reason**.

## 1.3 Open the diagnostic

Open **https://app.ordence.com/api/diag** in a browser.

**Send me the `missing` array.** It is a list of NAMES. It contains no values, no lengths, no prefixes. Copy the whole JSON if it is easier, it is safe.

⭐ **This is the definitive answer on your environment variables**, and it costs one click. The list you pasted me earlier was alphabetical and started at `CRON_SECRET`, so anything sorting before it was cut off. I am not going to guess from a truncated list.

---

# PHASE 2 · Environment variables

Do this **after** 1.3, because the diagnostic tells you which of these you actually need.

**Railway variables link is at the top.** ⚠️ **Set them on the SERVICE, not the project.** A project-level variable the service does not inherit is the commonest way a variable appears set and is not.

## 2.1 The eight the product refuses to boot without

`lib/env-boot.ts` names these. If `/api/diag` lists any of them as missing, it is not optional.

| Variable | Where to get it |
|---|---|
| `DATABASE_URL` | Neon → Connect. Already set. |
| `CLERK_SECRET_KEY` | **Clerk API keys** link. Starts `sk_live_`. |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Same page. Starts `pk_live_`. Already set. |
| `NEXT_PUBLIC_APP_URL` | `https://app.ordence.com` |
| `NEXT_PUBLIC_ROOT_DOMAIN` | `ordence.com` , **no scheme, no www, no trailing slash** |
| `NEXT_PUBLIC_ZONE_DOMAIN` | `ordence.com` , same rule |
| `PLATFORM_ADMIN_EMAILS` | Your own email. Comma-separated for more. |
| `CLERK_WEBHOOK_SIGNING_SECRET` | **Clerk webhooks** link → your endpoint → Signing Secret. Starts `whsec_`. |

🔴 **`NEXT_PUBLIC_ROOT_DOMAIN` is the one that silently kills the subdomain feature.** It is what `resolveTenantFromHost` uses to decide that `acme.ordence.com` is a tenant. Without it the code falls back to `localhost:3000` and **no tenant subdomain resolves at all**, while everything else looks fine.

🔴 **`CLERK_WEBHOOK_SIGNING_SECRET` is the one that silently kills signups.** `app/api/webhooks/clerk/route.ts` is the **only** path that creates a `tenants` row or a `users` row for a real signup. Without the secret the route fails closed with a 500, correctly, because a missing secret must never mean "skip verification". The consequence is that **nobody can ever get a workspace, and every health signal reads green.**

⚠️ **`NEXT_PUBLIC_` variables are compiled into the browser bundle at BUILD time.** Setting one and restarting is not enough. You must **redeploy**, which you are doing in phase 3 anyway. If you set one later, redeploy again.

## 2.2 The two vault keys

Run this on your own machine, twice:

```bash
openssl rand -hex 32
```

Set the first output as `VAULT_ENCRYPTION_KEY` and the second as `VAULT_BLIND_INDEX_PEPPER`.

🔴 **Never paste either value to me.** Tell me only that they are set.

**What they unlock:** without them the vault refuses to store anything, so every tenant-configured integration credential, webhook and connector is **dark on arrival**. It is not a crash, it is a feature that quietly does not exist.

⚠️ **Losing `VAULT_ENCRYPTION_KEY` later means losing every secret encrypted under it.** There is no recovery path and there should not be one. Put both in a password manager the moment you generate them, before you paste them into Railway.

## 2.3 Optional, and honest about it

| Variable | What you get, what you lose |
|---|---|
| `CSP_ENFORCE=1` | The content security policy currently runs report-only, which blocks **nothing**. ⚠️ Turning it on can break a page that loads something the policy did not anticipate. Set `CSP_REPORT_URI` first, watch reports for a week, then enforce. Not urgent, but it is not protecting you today and it reads as though it is. |
| `GROQ_API_KEY` | https://console.groq.com/keys , unlocks the AI features |
| `CLOUDFLARE_ACCOUNT_ID` + `CF_AI_TOKEN` | https://dash.cloudflare.com , the fallback AI provider |
| `PLATFORM_HOST` | Not needed. `NEXT_PUBLIC_ZONE_DOMAIN` derives it. Set it only if `admin.ordence.com` misbehaves after the deploy. |

---

# PHASE 3 · Deploy

## 3.1 Push

Unzip **`ordence-v1.58.0-alpha.zip`** over your working copy, commit, push. Railway builds automatically.

**SQL prerequisite: `0092` only.** Everything else is already applied.

## 3.2 Watch the build

**Railway deployments** link. Watch for `Compiled successfully`.

⚠️ **This is the step I cannot verify for you.** `next build` is OOM-killed in my container, which is exactly why two build-breaking classes reached Railway before. `check:route-exports` and `check:client-hooks` exist because of those two incidents and they are a subset of what a real build catches, not a substitute. **If it fails, send me the log and I will read it.**

## 3.3 Confirm, in this order

| Check | Expected |
|---|---|
| `https://app.ordence.com` | loads |
| `https://admin.ordence.com` | the console at the root |
| `https://admin.ordence.com/tenants` | the workspace list, **not** a 404 |
| Press `Cmd+K` anywhere in the console | the command palette opens |
| `https://app.ordence.com/platform` | **still works, unchanged** |

⭐ **That last row is the one to check deliberately.** The console living at two base paths is additive by design: if `admin.` fails for any reason, you are still not locked out.

**Six new destinations** should appear in the console nav: Onboarding, Maintenance, Access review, Secrets, Cohorts, and the rebuilt Tenant 360.

---

# PHASE 4 · Data

## 4.1 Project state codes

Run **`FIX-PROJECT-STATE-CODES-neon-safe.sql`** (attached). Section 1 is read-only and lists what is missing. Section 2 is a commented template you edit and run.

🔴 **The RLS detail that will otherwise waste your evening:** `projects` has exactly one policy and **no platform clause on either side**. `SET app.platform_scope = 'on'` does **nothing** for that table. You must `SET LOCAL app.tenant_id` to the specific tenant. The file explains this and gives you the shape.

**Why it matters:** `state_code` decides **place of supply**, which decides whether a sale is CGST+SGST or IGST. Different tax heads on the invoice, different rows in GSTR-1, different money.

🔴 **Set the state each project is actually in.** Do not batch-assign your head-office state to clear the list. A null makes the product refuse to classify, which is visible. A wrong one makes it classify confidently and incorrectly, which is not, and an assessing officer finds it later with interest.

⚠️ Two characters **including the leading zero**. `07`, never `7`.

## 4.2 One suspended workspace

Suspend any test workspace in the console. Batch 24 has never been exercised against a real suspended tenant, and suspension is the path where a customer who has stopped paying must lose access without losing data.

---

# PHASE 5 · Then tell me, and I keep going

Send me these four things and I will pick up immediately:

1. `0092` **section 3** row
2. `VERIFY-0091` **tab 8**
3. `/api/diag` **`missing`** array
4. Whether the deploy went green, and the log if not

---

## ⭐ One ask I am retiring

**The four-line `rolbypassrls` query is off the list.** I have asked for it in nine sessions and never got it, which is my fault for asking for a thing you would have to hand-write rather than building it into something you were already running. **Section 3 of `0092` answers it now**, as a by-product of a file you have to run anyway. That is how it should have been asked the first time.

---

## Where things stand, so nothing is a surprise

**Done and green:** 92 migrations, 15 gates, 142 test files, **4,936 tests**, Group A (self-serve subdomains, end to end) and Group B (all nine console batches).

**Built but not wired:** the signup claim screen. `/sign-up` is Clerk's widget today and `/onboarding` is Clerk's `CreateOrganization`; neither has an address field. The component is written and tested and waiting on a product decision about the funnel, which is yours and not mine.

**Deliberately not built:** self-serve rename. Rename changes a live hostname, and the owner notification does not exist yet.
