# Ordence — Deploy Guide

**Version:** v0.83.0-alpha · Railway · GitHub · Cloudflare DNS

This is the single file you need to deploy Ordence from a fresh clone to a
live site at `app.ordence.com`. Follow it top to bottom. Each section says
how long it takes and what you need.

---

## 0. What you need before you start

| Thing | Where | Notes |
|---|---|---|
| A GitHub account | github.com | The repo is `sahilxnahar/app.ordence` (private) |
| A Railway account | railway.com | Sign in with GitHub |
| A Neon database | console.neon.tech | Free tier is fine. Region: `ap-southeast-1` (Singapore) |
| A Clerk account | dashboard.clerk.com | Free Hobby plan. App name: "Ordence" |
| A Cloudflare account | dash.cloudflare.com | You already have this — DNS for `ordence.com` |
| GitHub Desktop | desktop.github.com | Optional but recommended — no terminal needed |

Total time from zero to live: **about 45 minutes**.

---

## 1. Push the code to GitHub (5 min)

```bash
# If you already have the repo cloned:
cd app.ordence
git add .
git commit -m "v0.76.0-alpha — AI agent layer (Session 1)"
git push origin main
```

Or with GitHub Desktop:
1. Open the `app.ordence` repository
2. Type a summary in the summary field
3. Click **Commit to main**
4. Click **Push origin**

Railway watches this repo. The moment you push, it starts building.

---

## 2. Set up the database in Neon (10 min)

1. Go to <https://console.neon.tech> and sign in with GitHub.
2. Create a project named **`ordence`**, region **`ap-southeast-1`** (Singapore).
3. Once created, click **Connect**.
4. **Turn ON** "Connection pooling" — the string must contain `-pooler`.
5. Copy the pooled string. This is your **`DATABASE_URL`**.
6. Toggle to "Direct connection" (pooled OFF). Copy that too. This is your
   **`DATABASE_URL_UNPOOLED`** (used only for migrations).

### Run the SQL migrations

1. In Neon, open the **SQL Editor**.
2. Open `SQL-FILES/0001_rls_and_audit_guard.sql` from this repo.
3. Paste it into the SQL Editor and click **Run**.
4. Repeat for every file in `SQL-FILES/` in numeric order:
   `0001` through `0044`.

> ⚠️ **Do not run `npx drizzle-kit push` in production.** It drops RLS
> policies on every table. The numbered SQL files are the only safe path.
> The `db:push` script itself refuses to run when `NODE_ENV=production`.

> The last file (`0044_tenant_patterns.sql`) creates the AI pattern memory
> table. It is new in this version. If you are upgrading from an earlier
> version, just run `0044` — the rest are already applied.

### Verify the database

Paste this into the SQL Editor:

```sql
SELECT 'tables', count(*)::text FROM information_schema.tables WHERE table_schema='public'
UNION ALL SELECT 'rls_forced', count(*)::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relforcerowsecurity
UNION ALL SELECT 'policies', count(*)::text FROM pg_policies WHERE schemaname='public';
```

You should see 150+ tables, 150+ RLS-forced, 150+ policies. The exact
count grows with each version.

---

## 3. Set up Clerk authentication (10 min)

1. Go to <https://dashboard.clerk.com> and create an app named **Ordence**.
2. **Sign-in methods:** enable Email + password and Google.
3. **Phone number: OFF** — Clerk's dev instance cannot SMS Indian numbers.
4. **Organizations: ON** — this is not optional. One Clerk Organization
   equals one tenant workspace.
5. Go to **API Keys**:
   - Copy the **Publishable key** (`pk_test_...`) → this is
     `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
   - Create a **new** Secret key (don't use "default") → this is
     `CLERK_SECRET_KEY`
6. Go to **Webhooks** → **Add Endpoint**:
   - URL: `https://app.ordence.com/api/webhooks/clerk`
   - Events (8): `user.created`, `user.updated`, `organization.created`,
     `organization.updated`, `organization.deleted`,
     `organizationMembership.created`, `organizationMembership.updated`,
     `organizationMembership.deleted`
   - Copy the **Signing Secret** → this is `CLERK_WEBHOOK_SIGNING_SECRET`

> ⚠️ Before real customers: Clerk → **Go to prod** creates a separate
> production instance. Re-create the webhook there, add `app.ordence.com`
> as its domain, and swap in the resulting `pk_live_` / `sk_live_` keys.

---

## 4. Set up Railway (15 min)

### 4a. Create the project and connect the repo

1. Go to <https://railway.com> and sign in with GitHub.
2. Click **New Project** → **Deploy from GitHub repo**.
3. Select `sahilxnahar/app.ordence`.
4. Railway creates a service and starts a build. Let it run — it will
   fail because no variables are set yet. That is expected.

### 4b. Set the environment variables

1. Click the service → **Variables** tab.
2. Click **Raw Editor** (top right).
3. Open the file `RAILWAY-VARIABLES-FINAL.txt` from the `ERP/app.ordence/`
   folder in this project.
4. **Delete** everything in the Raw Editor box.
5. **Paste** the whole block.
6. Replace the three `PASTE_HERE` values:
   - `DATABASE_URL` → the pooled Neon string from Step 2
   - `CLERK_SECRET_KEY` → the new Clerk secret key from Step 3
   - `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` → the Clerk publishable key
7. Click **Update Variables**.

> ⚠️ **Never put these values in a file you push to GitHub.** Railway's
> Variables tab is the only place they belong.

### 4c. Optional: AI provider keys

The AI assistant feature needs at least one provider key. For the
quickest setup:

- **`GROQ_API_KEY`** — go to <https://console.groq.com/keys>, sign up
  with email, create a key. Free, no card, 30 requests/minute. This
  powers the "open lane" (drafting, summaries, no tenant data).

- **`CF_AI_TOKEN`** + **`CLOUDFLARE_ACCOUNT_ID`** — go to
  <https://dash.cloudflare.com/profile/api-tokens>, create a token with
  Workers AI permission. Your account ID is on the Cloudflare dashboard
  right sidebar. This powers the "confidential lane" (anything touching
  real tenant data — names, numbers, contracts).

Without these, the app runs perfectly — the AI assistant is simply not
available. Add them in the Variables tab any time; no redeploy needed.

### 4d. Generate a test domain

1. Settings tab → **Networking** → **Public Networking**.
2. Click **Generate Domain**. Railway gives you something like
   `app-ordence-production.up.railway.app`.
3. Open `https://app-ordence-production.up.railway.app/api/health` in
   your browser. You should see a health response.
4. Open `https://app-ordence-production.up.railway.app/api/diag` to
   verify all settings are detected.

---

## 5. Point `app.ordence.com` at Railway (5 min)

1. Railway → Settings → Networking → **Custom Domain**.
2. Type `app.ordence.com`.
3. Railway shows you a **CNAME** record.
4. Go to Cloudflare → DNS for `ordence.com` → **Add record**:

   | Field | Value |
   |---|---|
   | Type | CNAME |
   | Name | `app` |
   | Target | *(the value Railway showed you)* |
   | Proxy status | **DNS only** (grey cloud) |

5. Wait 5 minutes. Railway shows a green tick when the domain is verified.
6. Open `https://app.ordence.com/api/health` — you should see the health
   response on your real domain.

> ⚠️ **The grey cloud matters.** With the orange cloud on, Cloudflare
> and Railway both try to terminate the SSL certificate and the site
> answers with an SSL error that looks like a Railway fault.

### Also add the admin subdomain

1. Railway → Settings → Networking → **Custom Domain** → `admin.ordence.com`.
2. Cloudflare → DNS → **Add record**:

   | Field | Value |
   |---|---|
   | Type | CNAME |
   | Name | `admin` |
   | Target | *(same Railway target as `app`)* |
   | Proxy status | **DNS only** (grey cloud) |

---

## 6. Your ongoing deploy routine (2 min per update)

From now on, every time you want to update the site:

1. Make your code changes.
2. `git add . && git commit -m "description of what changed" && git push origin main`
3. Wait 4–5 minutes. Railway builds automatically.
4. Check `https://app.ordence.com/api/health`.
5. If something is wrong, check `https://app.ordence.com/api/diag` and
   the Railway **Deployments** tab → click the deploy → read the log.

No terminal needed if you use GitHub Desktop:
1. Open the repo in GitHub Desktop.
2. Type a summary → **Commit to main** → **Push origin**.
3. Wait 5 minutes. Check `/api/health`.

---

## 7. Verifying the AI assistant (after deploy)

Once at least one AI provider key is set:

1. Open `https://app.ordence.com/api/diag` — it should show the provider
   as configured.
2. In the CRM, go to an MCP token management page and create a
   `read_only` token.
3. Use the token to call the MCP endpoint:

```bash
curl -X POST https://app.ordence.com/api/mcp \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

You should see all 24 tools (8 original + 16 new from Session 1).

---

## 8. What to do if something breaks

| Symptom | Likely cause | Fix |
|---|---|---|
| Build fails immediately | Railway can't see the repo | Settings → Source → check repo connection |
| Build succeeds, page errors | A required variable is missing | Check `/api/diag`, fill in the variable |
| "Application failed to respond" | App crashed on startup — usually `DATABASE_URL` | Deployments → click deploy → read log red lines |
| SSL error on app.ordence.com | Cloudflare proxy is on (orange cloud) | DNS → set the CNAME to grey cloud |
| `/api/diag` shows 0 providers | No AI provider keys set | Add `GROQ_API_KEY` in Variables |
| Dashboard throws an error | Empty `subscriptions`/`roles` tables | Run the seed scripts or create a plan |

**Do not start changing settings at random.** That turns one known
problem into two unknown ones. Read the log first.

---

## 9. What was built in this version (v0.77.0-alpha, Sessions 1 + 2)

### Session 1 — Agent infrastructure

| Layer | What | Files |
|---|---|---|
| **MCP tools** | 16 new read tools for every module (GST, purchases, ITC, receivables, compliance, inventory, scheduling, field ops, TDS) | `lib/mcp/registry.ts`, `server/mcp/dispatch.ts` |
| **Agent registry** | 7 business AI agents with system prompts and tool whitelists | `lib/ai/agents/registry.ts` |
| **AI client** | OpenAI-compatible HTTP client with budget-aware failover and circuit breakers | `lib/ai/client.ts` |
| **Agent runner** | Orchestration loop that runs agent conversations with tool calling through MCP dispatch | `server/ai/agent-runner.ts` |
| **Pattern memory** | Per-tenant learned business facts for agent context | `db/schema/ai-patterns.ts`, `lib/ai/patterns.ts`, `SQL-FILES/0044_tenant_patterns.sql` |

### Session 2 — Chat UI, goal planner, background workers

| Layer | What | Files |
|---|---|---|
| **Assistant chat UI** | In-CRM chat with agent picker, tool call indicators, conversation history | `app/(crm)/assistant/page.tsx`, `chat-client.tsx`, `assistant-tabs.tsx` |
| **Assistant API** | Authenticates via Clerk, constructs read-only McpSession, calls agent runner | `app/api/assistant/route.ts` |
| **Goal planner** | Natural language to workflow draft — AI generates a validated workflow program | `lib/ai/goal-planner.ts`, `app/api/assistant/goal-planner/route.ts`, `goal-planner-client.tsx` |
| **Background workers** | 6 scheduled intelligence monitors (GST deadlines, receivables, reconciliation, inventory, compliance, site labour) | `server/ai/background-workers.ts`, `app/api/workers/ai-monitors/route.ts` |
| **Navigation** | Assistant link in sidebar for all industries | `lib/industry-templates.ts`, `lib/modules/registry.ts` |

**Typecheck:** clean. **Tests:** 946/946 pass.


### Session 3-4 — Industry verticals

| Layer | What | Files |
|---|---|---|
| **Construction vertical** | Complete navigation: Portfolio, Sales, Delivery, Compliance, Finance, Documents (8 sections) | `lib/industry-templates.ts`, `lib/modules/registry.ts` |
| **All 13 verticals** | Finance + Documents sections added to all verticals (except small business, intentionally minimal) | `lib/industry-templates.ts` |
| **New modules** | gstr2b, tally, land, stock registered in module registry | `lib/modules/registry.ts` |


### Session 5 — Platform admin portal

| Layer | What | Files |
|---|---|---|
| **User directory** | Platform-wide user listing, grouped by Clerk identity, with search and filters | `app/platform/users/page.tsx`, `server/platform/users.ts` |
| **User detail** | Per-user detail showing all workspace memberships, roles, activity, with activate/suspend/offboard and role-change controls | `app/platform/users/[id]/page.tsx`, `components/platform/user-actions.tsx` |
| **Admin subdomain** | `admin.ordence.com` routing already built in middleware — set `NEXT_PUBLIC_ZONE_DOMAIN=ordence.com` | `middleware.ts` |
| **Platform nav** | "Users" link added to platform console navigation | `app/platform/layout.tsx` |


## 11. Setting up the admin portal (admin.ordence.com)

The platform admin console is accessible at `admin.ordence.com` once
`NEXT_PUBLIC_ZONE_DOMAIN` is set.

### DNS

1. In Cloudflare, add a CNAME record:
   - **Name:** `admin`
   - **Target:** your Railway domain (e.g., `app-ordence.up.railway.app`)
   - **Proxy:** grey cloud (DNS only)

2. In Railway, add `admin.ordence.com` as a custom domain on your service.

### Environment variable

Set `NEXT_PUBLIC_ZONE_DOMAIN=ordence.com` in Railway variables. This
activates:
- `admin.ordence.com` → platform console (rewrites to `/platform`)
- `acme.ordence.com` → tenant workspace for "acme"
- `app.ordence.com` → the CRM app

### What the admin portal does

| Section | Purpose |
|---|---|
| **Workspaces** | Directory of all tenants with health, plan, MRR, seats, storage |
| **Users** | Every person across all workspaces, grouped by identity |
| **Needs attention** | Tenants with health warnings or approaching limits |
| **Observatory** | Churn alarms, security events, platform health |
| **Provision** | Create a new workspace with industry selection |
| **Configure** | Per-tenant: toggle features, change plan limits, switch industry |
| **Sessions** | Impersonation session management |
| **Search** | Cross-tenant search (scoped, audited) |
| **Action register** | Platform-wide audit log |
| **Staff access** | Platform staff management and grading |


## 10. Setting up the AI background workers (optional, after deploy)

The 6 background intelligence workers run on a cron schedule. They are
called via the `/api/workers/ai-monitors` endpoint, which is protected
by `WORKER_API_SECRET`.

### Option A: Railway Cron

Add a cron job in Railway:

1. Go to your Railway project → your service → **Settings** → **Cron**.
2. Add a cron schedule. For a daily 9am run:
   ```
   0 9 * * *
   ```
3. Set the command to:
   ```bash
   curl -X POST https://app.ordence.com/api/workers/ai-monitors \
     -H "Authorization: Bearer $WORKER_API_SECRET" \
     -H "Content-Type: application/json" \
     -d '{"mode":"sweep"}'
   ```

### Option B: External cron (any server)

```bash
# Daily at 9am IST
0 9 * * * curl -X POST https://app.ordence.com/api/workers/ai-monitors \
  -H "Authorization: Bearer YOUR_WORKER_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"mode":"sweep"}'
```

### Testing manually

```bash
# List available workers
curl https://app.ordence.com/api/workers/ai-monitors \
  -H "Authorization: Bearer YOUR_WORKER_API_SECRET"

# Run one worker for one tenant
curl -X POST https://app.ordence.com/api/workers/ai-monitors \
  -H "Authorization: Bearer YOUR_WORKER_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"tenantId":"YOUR_TENANT_ID","workerId":"gst_deadline_watcher"}'
```
