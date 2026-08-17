# Your three answers, and one thing your Clerk page found

**Repo: `app.ordence`** · now **v1.56.1-alpha** · SQL: **`0092` is new, run it after `0091`**

---

## 1. Neon · 0091 applied

Good. **One thing still outstanding: run `VERIFY-0091-neon-safe.sql` and send me tab 8.**

"It applied without error" and "it refuses what it is supposed to refuse" are different claims, and this project has already shipped a verify file that printed `policies OK` over a real cross-tenant leak. Tab 8 is nine rows. **Row 9 is the one I care about**, because it attempts five real operations against your actual data: a legal slug that must be **accepted**, then a reserved name, a mixed-case slug, a two-character slug, and a confusable built from one of your own live slugs.

It rolls everything back and writes findings to a temp table. I ran it end to end and confirmed the tenant and history counts were unchanged afterwards.

---

## 2. Clerk · ⭐ the answer is yes, and it unblocks batch 134

**Primary domain `ordence.com`, Frontend API CNAME'd to `clerk.ordence.com`.**

That is the configuration that makes self-serve subdomains work. Because the Frontend API sits on the **same registrable domain** as the app rather than on `*.clerk.accounts.dev`, the Clerk session is scoped to `ordence.com` and is carried across every host beneath it. **`acme.ordence.com` will authenticate without a satellite domain being added for it.** That was the one prerequisite I could not verify myself and could have made batch 134 unshippable. It is fine.

`accounts.ordence.com`, `clkmail.ordence.com` and both DKIM selectors verified. Nothing to change.

### ⚠️ But this raises the stakes on the reserved list, and it is worth being explicit about why

A session scoped to the parent domain is delivered to **every** host under it. That is the mechanism that makes this work, and it also means a tenant subdomain is not merely a vanity URL: it is a host that receives the Clerk session cookie of any signed-in Ordence user who lands on it.

Every byte served there is ours, so this is not a leak. What it does mean is that **`RESERVED_SLUGS` and the confusable fold stopped being tidiness the moment this configuration was chosen**, and that an XSS on any single tenant subdomain is a session compromise across the whole zone rather than one workspace. Worth knowing before anyone proposes tenant-supplied HTML, custom scripts or an embed feature.

### 🔴 And your Clerk page found three names the reserved list was missing

`0091` seeded 71 names from first principles. It never read your actual DNS zone. Your zone has these:

| Host | Status |
|---|---|
| `clerk.ordence.com` | ✅ already reserved |
| `accounts.ordence.com` | ✅ already reserved |
| `clkmail.ordence.com` | 🔴 **`clkmail` was not reserved** |
| `clk._domainkey.ordence.com` | 🔴 **`clk` was not reserved** |
| `clk2._domainkey.ordence.com` | 🔴 **`clk2` was not reserved** |

**An explicit CNAME beats a wildcard.** `clkmail` has a real CNAME to Clerk's mail service, and Railway's `*.ordence.com` does not override it. So a tenant who claimed the slug `clkmail` would get a `tenants` row, a success message, an entitlement grant and a welcome email, and their hostname would resolve to Clerk's mail infrastructure forever. **The workspace provisions successfully and its front door is somebody else's server.**

That is the same failure shape as the two-drifted-lists incident 0091 exists for: one half succeeds, the other half was never asked, and the only symptom is a customer who cannot reach their own workspace.

`clk` and `clk2` are DKIM selectors. A tenant holding either owns the label directly above the record mail receivers use to decide whether mail claiming to be from us is genuine.

**`SQL-FILES/0092_reserve_clerk_hosts.sql` adds all three.** It also returns a row if any existing tenant already holds one, rather than refusing to apply.

⭐ **This is exactly why 0091 made the reserved list a TABLE rather than a CHECK constraint.** Three names, found by reading a DNS page, added by an `INSERT`. No `ALTER`, no lock on `tenants`, no rewrite. The design decision paid for itself the same day.

⚠️ **The rule this establishes matters more than the three names.** Every time a vendor gets a CNAME under `ordence.com`, its label is reserved in the same change. Clerk today; tomorrow a status page, a docs host, a support desk, a payment provider. The reserved list is a mirror of the zone file, and a mirror goes stale silently.

---

## 3. Environment variables · what I can and cannot tell you

**Thank you for masking the values.** That list is exactly the right shape to send me: names present, values `*******`. Nothing in it is a secret and I have not asked for one.

The codebase has its own authoritative list, in `lib/env-boot.ts`, of what must be set or the process should not start. Measured against it, **six of the eight do not appear in what you sent**:

| Required at boot | In your list |
|---|---|
| `DATABASE_URL` | ✅ |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | ✅ |
| `CLERK_SECRET_KEY` | ❌ not in the list |
| `CLERK_WEBHOOK_SIGNING_SECRET` | ❌ not in the list |
| `NEXT_PUBLIC_APP_URL` | ❌ not in the list |
| `NEXT_PUBLIC_ROOT_DOMAIN` | ❌ not in the list |
| `NEXT_PUBLIC_ZONE_DOMAIN` | ❌ not in the list |
| `PLATFORM_ADMIN_EMAILS` | ❌ not in the list |

⚠️ **I do not believe all six are actually missing, and I am not going to pretend otherwise.** The app is serving traffic, which it could not do without `CLERK_SECRET_KEY`; you showed me `NEXT_PUBLIC_ZONE_DOMAIN = ordence.com` in a Railway screenshot earlier this week; and your list is alphabetical and begins at `CRON_SECRET`, so anything sorting before it is cut off. The likeliest explanation is that the list is partial, or scrolled, or that some variables were set by a template rather than typed by you.

### ⭐ So do not audit this by eye. There is an endpoint that already answers it, with no values

```
https://app.ordence.com/api/diag
```

It reports **presence booleans only**. It used to return a character count for each variable as well, which was a truncated-paste oracle and a fingerprint of which key format was in use, handed to anyone who asked. That was removed. It returns `{ present: true | false }` and a `missing` array of **names**.

**Send me the `missing` array.** That is a definitive answer, it costs you one click, and it cannot leak anything.

### The two that matter most for what you are about to deploy

| | |
|---|---|
| 🔴 `NEXT_PUBLIC_ROOT_DOMAIN` | This is what `resolveTenantFromHost` uses to decide that `acme.ordence.com` is a tenant. Without it the code falls back to `localhost:3000` and **no tenant subdomain resolves at all.** Group A does nothing without this. |
| 🔴 `CLERK_WEBHOOK_SIGNING_SECRET` | `app/api/webhooks/clerk/route.ts` is the **sole** path that creates a `tenants` row or a `users` row for a real signup. Without the secret the route fails closed with a 500, correctly, because a missing secret must never mean "skip verification". The consequence is that nobody can ever get a workspace, and every health signal reads green. |

### ⭐ And the good news

**`UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are set.** That was the one thing batch 133 was leaning on. The rate limit on `/api/public/slug-available` is now a real control rather than a per-instance counter multiplied by the instance count.

### Advisory, not fatal, still absent

`VAULT_ENCRYPTION_KEY` and `VAULT_BLIND_INDEX_PEPPER` (no integration credential can be stored, so every tenant-configured webhook and connector is dark on arrival), `CSP_ENFORCE` (the content security policy is report-only, so it blocks nothing), and `PLATFORM_HOST` (optional, since `NEXT_PUBLIC_ZONE_DOMAIN` derives it).

🔴 **Generate the two vault values locally with `openssl rand -hex 32` and never paste them to me.**

---

## 4. ⚠️ And a defect in my own work, found while making this change

Adding three names to `lib/slug.ts` and to `0092` broke `tests/ui/slug-contract.test.ts`. Two reasons, both mine:

1. **The test read only `0091`.** So a name correctly added in a later migration looked like TypeScript drift. **It would have failed a change that was right**, which is how a test gets deleted, after which nothing catches the drift it existed for. It now reads every migration that seeds `reserved_slugs`, which also makes the shape and fold assertions stricter: `theOneStatement()` now demands exactly one definition across all migrations rather than within one file.
2. **It asserted `expect(fromSql.size).toBe(71)`.** The set-equality assertions in both directions passed at 74 and this one failed. **71 was never the property**, it was the incidental shape of the list on the afternoon 0091 shipped. It now asserts that both sides are the same size and above a floor far below the real total.

That is the **fourth** test in this codebase to have pinned a shape rather than a property, and I wrote the instruction telling the agent not to do it. Worth naming rather than quietly fixing.

---

## What to do, in order

| | |
|---|---|
| 1 | **`/api/diag`** , send me the `missing` array. Names only. |
| 2 | **`VERIFY-0091-neon-safe.sql`** , send me tab 8. |
| 3 | **`0092_reserve_clerk_hosts.sql`** in Neon. Independent of 1 and 2, safe to run now. |
| 4 | Push `ordence-v1.56.1-alpha.zip` once 1 and 2 come back clean. |

**Group B, the eight admin console batches, is ready to run and has no SQL at all.** Say go.
