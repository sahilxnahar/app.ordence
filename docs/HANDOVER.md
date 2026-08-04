# Ordence — complete handover

> ⚠️ **A LIVE DATABASE PASSWORD USED TO BE WRITTEN OUT IN THIS FILE.**
> It has been replaced with `<YOUR-NEON-PASSWORD>`. Treat the old one as
> burned and rotate it in Neon → Roles → Reset password. A credential in a
> file inside the repository is a credential in every clone, every backup
> and every deploy tarball — the redaction below removes it going forward,
> it does not un-share it.

**Everything needed to pick this up cold.** Written 2 August 2026.

> ⚠️ **This file contains live credentials.** It lives in the private
> `app.ordence` repository and in the SAAS CRM folder. Do not paste it into a
> public issue, a support ticket, or a chat with anyone outside the company.

---

## 1. What Ordence is

An enterprise **multi-tenant SaaS CRM + ERP** for the Indian real-estate and
construction market. One codebase, one database, many customer workspaces —
isolated from each other by PostgreSQL row-level security rather than by
application code.

**Strategy:** a universal core (catalogue features 1–420) plus industry packs
(421–500) that reconfigure vocabulary, pipelines, fields and compliance per
vertical. See `docs/FEATURE-MAP-500.md` for what exists and
`docs/BUILD-ORDER.md` for what to build next.

**Architecture:** Next.js 15 App Router · TypeScript strict · Drizzle ORM ·
Neon PostgreSQL · Clerk auth · Cloudflare Workers via OpenNext · R2 storage.

---

## 2. Live addresses

| What | URL |
|---|---|
| **The CRM** | <https://app.ordence.com> |
| Worker fallback address | <https://app-ordence.sahil-ad6.workers.dev> |
| **Deployment diagnostic** | <https://app.ordence.com/api/diag> |
| Liveness probe | <https://app.ordence.com/api/health> |
| Clerk webhook receiver (POST only) | `https://app.ordence.com/api/webhooks/clerk` |
| Platform admin console | <https://app.ordence.com/platform> |
| Marketing site (Squarespace) | <https://ordence.com> |

---

## 3. Accounts and dashboards

| Service | Account | Direct link |
|---|---|---|
| **Cloudflare** | `Sahil@ordence.com` | [dashboard](https://dash.cloudflare.com/ad6dd0d6cb1513eea62c34d216c9ef66) |
| Cloudflare account ID | `ad6dd0d6cb1513eea62c34d216c9ef66` | |
| **Worker** | `app-ordence`, env `production` | [settings](https://dash.cloudflare.com/ad6dd0d6cb1513eea62c34d216c9ef66/workers/services/view/app-ordence/production/settings) · [deployments](https://dash.cloudflare.com/ad6dd0d6cb1513eea62c34d216c9ef66/workers/services/view/app-ordence/production/deployments) · [logs](https://dash.cloudflare.com/ad6dd0d6cb1513eea62c34d216c9ef66/workers/services/view/app-ordence/production/observability) · [domains](https://dash.cloudflare.com/ad6dd0d6cb1513eea62c34d216c9ef66/workers/services/view/app-ordence/production/domains) |
| **DNS** | zone `ordence.com` | [records](https://dash.cloudflare.com/ad6dd0d6cb1513eea62c34d216c9ef66/ordence.com/dns/records) · [SSL/TLS](https://dash.cloudflare.com/ad6dd0d6cb1513eea62c34d216c9ef66/ordence.com/ssl-tls) |
| **Neon** (database) | via GitHub sign-in | <https://console.neon.tech> |
| **Clerk** (auth) | app `Ordence`, Hobby plan | [dashboard](https://dashboard.clerk.com/apps/app_3HKgI2uv7UU2OBhhLZMxvvbQ6YB/instances/ins_3HKgHz2OSqRWmnbYX0v8QRchDI2) |
| Clerk app id | `app_3HKgI2uv7UU2OBhhLZMxvvbQ6YB` | |
| Clerk instance id (**development**) | `ins_3HKgHz2OSqRWmnbYX0v8QRchDI2` | |
| **GitHub** | `sahilxnahar/app.ordence` — **private** | <https://github.com/sahilxnahar/app.ordence> |
| **Squarespace** | registrar only — DNS is at Cloudflare | |
| **Google Workspace** | `Sahil@ordence.com` mail on ordence.com | |

---

## 4. Environment variables — all eight

Set at **Cloudflare → Worker `app-ordence` → Settings → Variables and secrets.**

> ⚠️ **Use `+ Add` for individual variables. Never the bulk `Edit` button** —
> saving that editor once silently deleted all four plaintext variables and
> cost several hours of debugging.
>
> ⚠️ **There is no build-variable list any more.** The code reads every
> setting at request time (see `middleware.ts` → `readRuntimeEnv`), so one
> list is enough. Earlier instructions to enter everything twice are obsolete.

| # | Name | Type | Value |
|---|---|---|---|
| 1 | `DATABASE_URL` | 🔒 Secret | `postgresql://neondb_owner:<YOUR-NEON-PASSWORD>@ep-raspy-math-azduzr7s-pooler.c-3.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require` |
| 2 | `DATABASE_URL_UNPOOLED` | 🔒 Secret | same as above **without** `-pooler` |
| 3 | `CLERK_SECRET_KEY` | 🔒 Secret | `<YOUR-CLERK-SECRET-KEY>` |
| 4 | `CLERK_WEBHOOK_SIGNING_SECRET` | 🔒 Secret | `<YOUR-CLERK-WEBHOOK-SIGNING-SECRET>` |
| 5 | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Text | `pk_test_cHJldHR5LXNocmV3LTQyLmNsZXJrLmFjY291bnRzLmRldiQ` |
| 6 | `NEXT_PUBLIC_APP_URL` | Text | `https://app.ordence.com` |
| 7 | `NEXT_PUBLIC_ROOT_DOMAIN` | Text | `app.ordence.com` |
| 8 | `PLATFORM_ADMIN_EMAILS` | Text | `Sahil@ordence.com` |

**Verify with `/api/diag`.** The expected lengths are 152, 145, 50, —, 55, 23,
15, 17. A wrong length means a truncated paste or a trailing space, which is
otherwise invisible.

### Not yet configured (optional, app degrades cleanly)

`RESEND_API_KEY` · `RESEND_FROM_EMAIL` · `RAZORPAY_KEY_ID` ·
`RAZORPAY_KEY_SECRET` · `RAZORPAY_WEBHOOK_SECRET` · `STRIPE_SECRET_KEY` ·
`STRIPE_WEBHOOK_SECRET` · `UPSTASH_REDIS_REST_URL` · `PLATFORM_GSTIN` ·
`PLATFORM_GST_STATE_CODE` · `ORDENCE_DAILY_REQUEST_BUDGET`

### Rotate these when convenient

All four secrets above have passed through a chat transcript.

- **Neon:** Console → Roles → `neondb_owner` → Reset password
- **Clerk secret key:** API keys → add new → update → delete old
- **Webhook secret:** Webhooks → endpoint → Signing Secret → Roll

Do it **after** everything works, never while debugging.

---

## 5. DNS — current, verified state

Zone `ordence.com`, nameservers `cheryl.ns.cloudflare.com` / `kipp.ns.cloudflare.com`.

| Name | Type | Content | Proxy |
|---|---|---|---|
| `app.ordence.com` | Worker | `app-ordence` | 🟠 **Proxied** — must stay |
| `ordence.com` ×4 | A | `198.49.23.144/145`, `198.185.159.144/145` | ⬜ DNS only *(Squarespace)* |
| `www.ordence.com` | CNAME | `ext-sq.squarespace.com` | ⬜ DNS only |
| `ordence.com` | MX | `smtp.google.com` (pri 1) | ⬜ DNS only |
| `ordence.com` | TXT | `v=spf1 include:_spf.google.com ~all` | ⬜ DNS only |
| `google._domainkey` | TXT | DKIM | ⬜ DNS only |
| `_domainconnect` | CNAME | Squarespace | 🟠 harmless |

> ⚠️ **Deleting the MX or SPF row silently breaks `Sahil@ordence.com`.** They
> look unremarkable in the list. Never bulk-delete on that page.
>
> ⚠️ **The Squarespace records must stay DNS only.** Proxying them produces a
> redirect loop on the marketing site.

**Never create the `app` record by hand.** It is managed by the Worker's
Domains tab; a hand-made record conflicts with it.

---

## 6. Cloudflare settings — how they should be

| Setting | Value | Why |
|---|---|---|
| Build command | `npx opennextjs-cloudflare build` | `next build` alone produces a website, not a Worker |
| Deploy command | `npx wrangler deploy` | |
| Root directory | `/` | |
| Production branch | `main` | |
| Compatibility date | `2025-03-25` | pinned in `wrangler.jsonc` |
| Compatibility flags | `nodejs_compat`, `global_fetch_strictly_public` | |
| R2 buckets | `ordence-cache`, `ordence-documents` | deploy fails without both |
| Observability logs | **Enabled**, persisted | the only way to see a server error |
| SSL/TLS mode | **Full (strict)** | |
| Always Use HTTPS | On | |
| Minimum TLS | 1.2 | |
| Compliance requirements | **both boxes unticked** | ticking both leaves almost no usable key exchange |
| Rocket Loader | **Off** | reorders JS and breaks React hydration |
| Bot Fight Mode | **Off** | would silently drop the Clerk webhook |
| Plan | Free | expect **Error 1102** under load → Workers Paid, $5/mo |

---

## 7. Clerk configuration

- Application name: **Ordence** · instance: **Development**
- **Organizations: enabled.** Not optional — one Clerk Organization = one tenant workspace
- Sign-in methods: Email + password, Google
- **Phone number: must be OFF** — Clerk's dev instance cannot SMS Indian numbers
- Webhook endpoint: `https://app.ordence.com/api/webhooks/clerk`, 8 events:
  `user.created` · `user.updated` · `organization.created` · `organization.updated` ·
  `organization.deleted` · `organizationMembership.created` ·
  `organizationMembership.updated` · `organizationMembership.deleted`

**Before real customers:** Clerk → **Go to prod** creates a *separate*
instance. You must re-create the webhook there, add `app.ordence.com` as its
domain, and swap in the resulting `pk_live_` / `sk_live_` keys. The dev
instance caps at 100 users and shows a development banner.

---

## 8. Database

Neon · project `ordence` · region `ap-southeast-1` (Singapore) · database `neondb`
· role `neondb_owner`.

| | |
|---|---:|
| Tables | 97 |
| Tables with RLS **enabled and forced** | 90 |
| Policies | 90 |
| Triggers | 270 |

`FORCED` is the word that matters — without it the owner account bypasses every
policy, and the owner account is what the app connects as.

### Setting up a fresh database

`SQL-FILES/RUN-THESE-IN-ORDER/` — thirteen files, `00` to `12`, pasted into
Neon's SQL Editor in number order.

- **`00-CREATE-TABLES-RUN-ME-FIRST.sql`** creates the 91 tables
- **`01`–`12`** apply security: RLS, policies, triggers, composite foreign keys

> ⚠️ Running only `00` produces a CRM that works perfectly and lets every
> customer read every other customer's data, with no visible symptom. Files
> 01–12 are not optional.

Verify with:

```sql
SELECT 'tables', count(*)::text FROM information_schema.tables WHERE table_schema='public'
UNION ALL SELECT 'rls_forced', count(*)::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relforcerowsecurity
UNION ALL SELECT 'policies', count(*)::text FROM pg_policies WHERE schemaname='public';
```

Expect 97 / 90 / 90.

### Current contents

One tenant (`Ordence`, slug `ordence-1785634955201783367`, active, trial) and
one user (`sahil@ordence.com`, `tenant_admin`, active). **`subscriptions` and
`roles` are both empty** — the webhook seeds neither. See §12.

---

## 9. Where the code lives

| | Path |
|---|---|
| **Git repository** (the one that deploys) | `/Users/sah/Documents/GitHub/app.ordence` |
| Working folder, packages, docs, SQL | `/Users/sah/Downloads/SAAS CRM` |
| Latest package | `ordence-deploy-v9.tar.gz` |

> ⚠️ `SAAS CRM/ordence/` is **not** a Git repository. Editing files there
> changes nothing. Also present and inert: `app.ordence-old`,
> `app.ordence-live`. Only `Documents/GitHub/app.ordence` deploys.

### Key files

| File | What it does |
|---|---|
| `middleware.ts` | Tenant resolution + Clerk gate. **Reads env at runtime — do not "simplify" `readRuntimeEnv`** |
| `db/index.ts` | `db` (HTTP, single queries) and `withTenant()` (WebSocket transaction, pins RLS). `db` is a lazy Proxy — built on first use, never at import |
| `lib/env.ts` | Zod validation, lazy. `getClerkPublishableKey()` |
| `instrumentation.ts` | `onRequestError` — makes server errors legible instead of two minified line numbers |
| `app/api/diag/route.ts` | Settings presence, database connectivity, transaction capability |
| `wrangler.jsonc` | Worker name **must** be `app-ordence` |
| `server/tenant-context.ts` | `requireTenantContext()` — the gate every CRM page passes |
| `lib/industry-templates.ts` | Industry packs |
| `SQL-FILES/` | Every migration; `RUN-THESE-IN-ORDER/` is the numbered set |

---

## 10. Deploy procedure

1. Put the new code in `Documents/GitHub/app.ordence`
2. GitHub Desktop → check **Current Repository: app.ordence** → summary → **Commit to main** → **Push origin**
3. Cloudflare builds automatically. 5–10 minutes.
4. Watch **Deployments**; then check `/api/diag`

**Changing only a variable** needs no push — edit it and click **Deploy** on
the variables panel.

### Verifying a build locally before pushing

```bash
npx tsc --noEmit                    # must be clean
npx opennextjs-cloudflare build     # must end "Worker saved in .open-next/worker.js"
```

> ⚠️ **Run the build with the environment stripped**, and make sure no
> `.env.local` exists. A stray `.env.local` silently supplied values twice
> during this project and produced a "verified" build that failed in
> production both times.
>
> To test against the real Worker runtime: create `.dev.vars` (gitignored)
> with the eight variables, then `npx wrangler dev --port 8787` and
> `curl localhost:8787/api/diag`.

---

## 11. Diagnosing a failure — in this order

1. **`/api/diag`** — settings present? database connected? transaction ok?
2. **Cloudflare → Observability → Logs** — look for `[ordence:error]`, which
   carries the real message, route and digest
3. **Clerk → Webhooks → Activity** — successes and failures with the exact
   response your Worker returned
4. **Neon → SQL Editor** — is the row actually there?

### Symptoms already met, and what they meant

| Symptom | Cause |
|---|---|
| Blank 500 on **every** URL including `/api/health` | Clerk keys inlined as `undefined` at build time — middleware threw before routing |
| `/api/webhooks/clerk` returns 500 in a browser | **Correct.** POST-only, and fails closed without its secret |
| Build fails `Failed to collect page data` | Something evaluated at import time that needs a runtime value |
| Deploy succeeds but shows "Hello world" | No successful build has replaced the stub |
| **Error 1102** | Free-plan CPU ceiling → Workers Paid |
| Landing page shown while signed in | `/` is a static marketing page and does not check the session. Go to `/dashboard` |

---

## 12. 🔴 The open issue

**`/dashboard` throws a server-side exception.** Digest `817564861`.

### Ruled out, with evidence

- Database credentials and connectivity — verified directly
- Table and policy state — 97 / 90 / 90
- The `tenants` and `users` rows — correct, `tenant_admin`, active, linked
- **The WebSocket transaction path** — probed inside real workerd against the
  live database: `transaction.ok = true`
- Environment variables — all eight present, all lengths correct

### Best remaining lead

`subscriptions` and `roles` are **both empty**. The Clerk webhook creates the
tenant and the user and seeds neither. A dashboard panel resolving entitlements
or permissions against an empty set would throw exactly like this — and would
do it for every future customer too, so it needs fixing at the webhook, not
patching at the page.

### Next step

Deploy v9, reload `/dashboard`, and read the `[ordence:error]` line in the
Worker log. It will name the file and function.

---

## 13. Build status

**35 of 500 catalogue features built · 77 partial · 388 not started.**
Full audit in `docs/FEATURE-MAP-500.md`.

**Working:** sales pipeline, inventory, bookings, channel partners · workflow
engine (6 triggers, 13 actions, approvals) · runtime custom objects · saved
views · double-entry ledger · GST · purchases and ITC · GSTR-2B reconciliation ·
TDS · Tally export · receivables and dunning · platform admin console ·
Observatory · provisioning wizard · RBAC · audit log · portals · telemetry.

**Built but with no screens:** purchases, GSTR-2B, TDS, Tally, financial
statements. *This is the largest gap between what Ordence can do and what a
customer can see* — see Wave 1 in `docs/BUILD-ORDER.md`.

**Not built:** email sync, telephony, marketing, ticketing, inventory, orders,
manufacturing, HR/payroll, most AI, and all industry packs except real estate.

---

## 14. Outstanding, not urgent

- `subscriptions` / `roles` not seeded on tenant creation *(likely §12)*
- `/` should redirect a signed-in user to `/dashboard`
- Clerk still on the development instance
- Four GitHub Actions checks fail — they need a live database and have none. Cloudflare ignores them
- `_to_delete/` still in the repository. Harmless
- Razorpay plans not created — nothing is purchasable
- Email sending not configured
- **Petty cash (feature 322)** — deliberately untouched pending a conversation
