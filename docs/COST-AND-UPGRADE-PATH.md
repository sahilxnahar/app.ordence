# Cost & Upgrade Path

Where your money goes, when, and why. Written so you can make the call yourself.

---

## Today: what you're running on (₹0 / month)

| Service | Role | Free tier gives you | Realistically supports |
|---|---|---|---|
| **Vercel** Hobby | Hosting | 1M edge requests, 100 GB bandwidth, 100 deploys/day | Dev + demos |
| **Neon** Free | Database | 0.5 GB storage, 100 connections, 190 compute-hrs | ~10–20 small tenants |
| **Clerk** Free | Login | **10,000 monthly active users**, Organizations included | Genuinely generous |
| **Upstash** Free | Cache | 10,000 commands/day | Light caching |
| **GitHub** Free | Code | Unlimited private repos | Forever |
| **Total** | | | **₹0** |

That is a real stack, not a toy. You can build the entire product and run pilot
customers on it.

---

## ⚠️ The one hard rule

> **Vercel's Hobby plan is licensed for non-commercial, personal use only.**
>
> Building on it: fine. Demoing to prospects: fine. **Charging a customer while
> hosted on Hobby: violates the terms**, and Vercel can suspend the project.
>
> The fix is $20/month. Just don't get caught out — moving to Pro is a billing
> click, but only if you do it *before* you have paying users depending on uptime.

Everything else on this page is about performance. This one is about terms of service.

---

## The four upgrade triggers

Upgrade when you hit the trigger, not before. In order of when they'll bite:

### 1. Vercel Hobby → Pro — $20/month
**Trigger:** your first paying customer (contractual), **or** you need a team
member with dashboard access, **or** you exceed 100 GB bandwidth.

**You also get:** email support, longer log retention (1 day vs 1 hour), password-protected
preview deployments, spend caps, 40 firewall rules instead of 3.

**Do this first.** It's the cheapest and most necessary upgrade.

---

### 2. Neon Free → Launch — ~$19/month
**Trigger:** database exceeds 0.5 GB, **or** you need point-in-time recovery.

**You also get:** 10 GB storage, 7-day restore history, autoscaling.

> **Watch this one.** `audit_logs` is append-only by design — it only ever grows.
> That table will likely be what pushes you past 0.5 GB, not customer records.
> Check Neon's storage graph monthly.

---

### 3. Clerk Free → Pro — ~$25/month + $0.02/MAU
**Trigger:** 10,000 monthly active users.

Honestly, you will hit Vercel and Neon limits long before this. Clerk's free tier
is the most generous piece of the stack.

**You also get:** remove Clerk branding, SAML SSO (enterprise customers *will* ask), MFA policies.

---

### 4. Upstash Free → Pay-as-you-go — ~$0.20 per 100k commands
**Trigger:** past 10,000 commands/day.

Usage-based, so it grows in small increments rather than as a step change.

---

## Realistic cost by stage

| Stage | Monthly | What's included |
|---|---|---|
| **Now — building** | **₹0** | Everything free |
| First paying customer | **~$20** (₹1,700) | Vercel Pro only |
| ~10 paying customers | **~$40** (₹3,400) | + Neon Launch |
| ~50 customers | **~$90** (₹7,600) | + Clerk Pro, Upstash usage |
| ~200 customers | **~$300** (₹25,000) | + Neon Scale, monitoring |
| Enterprise / regulated | **$2,000+** | Dedicated clusters, SOC 2, SLAs |

Note the shape: you can serve your **first ten paying customers for under $40/month**.
Revenue arrives long before meaningful infrastructure cost. That's the whole point
of this architecture.

---

## What we built so you never have to rewrite

Each of these is a deliberate decision made in v0.1.0 to keep the upgrade path a
config change rather than a refactor:

| Decision | What it buys you |
|---|---|
| **Neon HTTP driver** | Swap to any Postgres (RDS, Cloud SQL, self-hosted) by changing `DATABASE_URL`. No code change. |
| **Drizzle ORM** | Database-agnostic. Migrations are plain SQL you own — no vendor lock-in. |
| **Clerk behind `server/tenant-context.ts`** | Replacing Clerk means rewriting one file, not the whole app. |
| **Tenant context via `set_config`** | Same isolation model works on shared DB now and dedicated clusters later. |
| **RLS at the database layer** | Isolation guarantees survive any application rewrite. |
| **Namespaced Redis keys (`tenantKey()`)** | Move to dedicated Redis per tenant without touching call sites. |
| **Edge middleware** | Works identically on Hobby, Pro, and Enterprise. |

The expensive mistake in SaaS is coupling your code to a vendor's free tier and
having to rebuild when you outgrow it. We've avoided that.

---

## Two things to be careful about

**1. Serverless is not free at scale.**
Vercel Pro includes 10M edge requests, then bills per-use. A runaway loop or a
scraper can generate a genuinely alarming invoice. **The moment you upgrade to Pro,
turn on Spend Management** (Settings → Billing → Spend Management) and set a hard cap.

**2. Background jobs cannot live on Vercel.**
BullMQ workers need a process that runs continuously. Vercel functions stop when
the request ends. When we reach Phase 3, workers go on Railway/Fly/Render
(free tiers exist). Flagging it now so it's not a surprise.

---

## What I'd actually recommend

1. **Stay entirely free** through Phases 1–3. No reason to spend anything.
2. **The week before your first paid customer signs**, upgrade Vercel to Pro. $20.
3. **Set a spend cap immediately** after upgrading.
4. **Watch Neon storage monthly** — it's the sneakiest limit because audit logs
   grow without you doing anything.
5. **Don't pre-buy capacity.** Every service here upgrades instantly. Paying for
   headroom you aren't using is money that should be going into the product.
