# admin.ordence.com , why every button 404s, and the plan

**Repo: `app.ordence`**

---

## The headline: this is not a development problem. It is two environment variables.

I inventoried the console before proposing anything. **The admin panel exists and is largely built.** Seventeen pages, twelve navigation entries, and **every one of those twelve has a real page behind it.** There is exactly one dead link in the whole console, and it is a query-string variant of a page that does exist.

So the 404s are not missing screens. They are **host resolution.**

---

## What is actually happening

`middleware.ts` decides what a request is by looking at its host:

```ts
function zoneDomain()   { return readRuntimeEnv("NEXT_PUBLIC_ZONE_DOMAIN"); }
function platformHost() {
  const explicit = readRuntimeEnv("PLATFORM_HOST");
  if (explicit) return explicit;
  const zone = zoneDomain();
  return zone ? `admin.${zone}` : undefined;      // ← undefined when the zone is unset
}
```

**With `NEXT_PUBLIC_ZONE_DOMAIN` unset, `platformHost()` returns `undefined`.** The console host is then unknown, so `admin.ordence.com` is not classified as the platform, and `/platform/*` is refused. The middleware comment says exactly this, and it was written deliberately:

> *"Without it, a deployment that has not yet set `NEXT_PUBLIC_ZONE_DOMAIN` , which is every existing one , resolves no platform host, never returns the `platform` locator, and so 404s EVERY `/platform` route. That locks the operator out of their own console the moment they deploy, with no error to explain it."*

Worse, without the zone the host classifier reads `admin.ordence.com` as **a tenant subdomain called "admin"** , a workspace that does not exist. There is a test in the repo that pins this exact behaviour, `tests/ui/admin-host-routing.test.ts`, and it logs the resolution so you can see it:

```
⚠️ WITHOUT the zone/platform settings, admin. becomes a TENANT called 'admin'
      → resolves as: {"kind":"custom-domain","domain":"admin.ordence.com"}
```

⭐ **And the 404 rather than a 403 is deliberate too.** A host that does not serve the console should not confirm the console exists. Which is why this fails silently instead of telling you what is wrong.

---

## The fix, in order

### 1. Set one variable on Railway

```
NEXT_PUBLIC_ZONE_DOMAIN = ordence.com
```

That alone derives `admin.ordence.com` as the platform host, because `platformHost()` defaults to `admin.<zone>`.

Optionally, if you ever want the console somewhere else, set it explicitly and it wins:

```
PLATFORM_HOST = admin.ordence.com
```

⚠️ **`NEXT_PUBLIC_` variables are baked at build time as well as read at runtime here.** Set it, then **redeploy** rather than just restarting, so the client bundle carries the same value the server sees.

### 2. DNS

`admin.ordence.com` must resolve to the same Railway service as `app.ordence.com`. In Railway, add it as a second custom domain on the existing service , not a new service. One deployment serves both hosts; the middleware decides which is which.

### 3. Clerk

The console is behind Clerk. `admin.ordence.com` must be an allowed origin / satellite host in your Clerk instance, or sign-in will bounce even once routing is right. Your `docs` folder already has `CLERK-PRODUCTION-DNS.md` in `FINAL/reference/` , that is the file to follow.

### 4. Confirm

Once deployed, `app.ordence.com/platform` should keep working exactly as before **and** `admin.ordence.com` should serve the same console at the root. The middleware rewrites `/` to `/platform` on the console host, so `admin.ordence.com/tenants` and `app.ordence.com/platform/tenants` are the same page.

If `admin.ordence.com` still 404s after the redeploy, the variable did not reach the running build. Check it in the Railway variables list for the **service**, not the project, and confirm the deploy that picked it up is the one serving traffic.

---

## What you get once it resolves

The console already has, all built and all reachable:

| Page | What it does |
|---|---|
| `/tenants`, `/tenants/[id]`, `/tenants/[id]/configure` | the workspace list, the detail view, and configuration with provenance |
| `/users`, `/users/[id]` | platform user administration |
| `/staff` | grant and revoke platform staff without hand-written SQL |
| `/approvals` | the four-eyes queue |
| `/sessions` | impersonation sessions |
| `/log` | the platform action log |
| `/health`, `/canary`, `/incidents` | health, the cross-tenant canary probe, incidents |
| `/observatory`, `/search`, `/provision`, `/config` | observability, global search, provisioning, configuration |

---

## What is genuinely still missing, and worth building

These are real gaps, not routing. From the batch plan, in the order I would take them:

| Batch | What | Why it matters |
|---|---|---|
| **125** | **Tenant 360, all eight tabs** , overview, activity, billing, entitlements, usage, support, data, audit | `/tenants/[id]` exists but is not the full picture. This is the screen you would actually live in. |
| **122** | **Onboarding progress** | You cannot currently see which new workspace stalled on day two, while it can still be rescued. |
| **131** | **Maintenance mode and deploy history** | Take payroll offline for an hour without taking the product offline. |
| **130** | **Access reviews** | A monthly pass over every impersonation, break-glass and staff grant, recorded as evidence. |
| **127** | **Secret rotation board** | Metadata only, never a value. All secrets under ninety days. |
| **126** | **Provisioning and cohorts** | Under thirty seconds, saved segments, rate-limited bulk actions. |
| **28** | **Impersonation hardening** | Owner notified live, thirty-minute cap, read-only by default, second approval for writes. |
| **43** | **The three unwired approval policies** | `impersonate.break_glass`, `staff.elevate`, `tenant.plan_change` are declared and enforced by nothing. A decorative control is worse than none. |

That is roughly one wave of eight parallel tracks, which is the unit I was about to run when you paused it.

---

## What I would do

**Do step 1 first and tell me what happens.** It costs one variable and one redeploy, and it may turn the whole "admin panel is broken" problem into a solved one this afternoon. There is no point building Tenant 360 into a console nobody can reach.

Then, if you want it, the eight-track wave above.

⚠️ **One thing I did not verify and cannot from here:** whether `NEXT_PUBLIC_ZONE_DOMAIN` is genuinely absent on your Railway service, or set to something else. I do not read your environment variables , that is deliberate, since the list returns every secret in plaintext. **Check the variable yourself and tell me what it says.** If it already reads `ordence.com`, the cause is elsewhere and DNS or Clerk is the next place to look.
