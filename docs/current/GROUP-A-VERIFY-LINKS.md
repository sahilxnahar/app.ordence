# Group A · the exact links, and what to look for at each one

**Repo: `app.ordence`** · Railway project `app.ordence` · service `app.ordence` · environment `production`

Four things to verify. Three are links. One is the SQL audit, which is the only hard blocker.

---

## 1. 🔴 THE BLOCKER · run the audit in Neon

**Link:** https://console.neon.tech

Open your project, open the **SQL Editor**, paste **`PRE-0091-AUDIT-neon-safe.sql`** whole, and run it.

**It is read only.** No `CREATE`, no `ALTER`, no `INSERT`, no `UPDATE`, no `DELETE`, no DDL of any kind. It cannot change anything.

You get **six result tabs**. **Send me all six.** Tab 6 is the verdict, one row per constraint `0091` will add.

| If tab 6 says | Then |
|---|---|
| every row `PASS` | 0091 applies cleanly, I push it |
| any row `BLOCK` | **stop**, send me tabs 1 to 5, those rows need a decision before the migration can run |

⚠️ **Why this is not optional.** Every constraint in 0091 is a hard one. If a single existing row violates any of them, the `ALTER` fails, the transaction rolls back, and you get an error message that names one row and tells you nothing about the other four checks. The audit tells you all five at once, before anything is attempted.

⭐ **I proved this file runs.** I stood up PostgreSQL 16.13 in this container, built a fixture table with ten rows carrying every defect the audit looks for, and executed the file. All six tabs returned. Tab 6 correctly flagged 1 case violation, 3 shape violations, 4 fold collisions and 2 reserved names in use. There are **no `\echo` commands and no `RAISE NOTICE`** in it, which is what broke `VERIFY-0089` in your editor. Everything comes back as a result row.

---

## 2. 🔴 Clerk · does it accept arbitrary `*.ordence.com` hosts

**Link:** https://dashboard.clerk.com

**Production instance → Configure → Domains.**

**What I need to know, in one line each:**

| Question | Why it decides whether batch 134 ships |
|---|---|
| What is the **primary domain**? | If it is `app.ordence.com` and nothing else is listed, a customer landing on `acme.ordence.com` gets a session that is not valid there and bounces to sign-in forever. |
| Are there **satellite domains**, and is `admin.ordence.com` one of them? | This is the same configuration that made the console look broken for three sessions. |
| Is there a **wildcard or multi-domain** entry? | If Clerk cannot be pointed at `*.ordence.com`, self-serve subdomains need a different auth topology and I need to know that before writing the signup screen, not after. |

⚠️ **Do not paste any Clerk key, secret or JWKS value.** I need the domain list only. Names, not credentials.

Your own runbook is at `FINAL/reference/CLERK-PRODUCTION-DNS.md`.

🔴 **This is the single thing most likely to make Group A look broken after it ships correctly.** The routing will be right, the slug will be claimed, the row will exist, and the customer will sit in a sign-in loop. It is worth ten minutes now.

---

## 3. ✅ Railway domains · already correct, I checked directly

**Link:** https://railway.com/project/e298fdd1-7172-4011-8011-eb97630e84ed/service/be4ed0d2-3bbb-497f-a45c-333e00f61955/settings/domains?environmentId=513c6404-7105-4161-8847-dac998c90802

I read this myself just now, metadata only. **Nothing to do here.**

| Domain | Port | State |
|---|---|---|
| `app.ordence.com` | 8080 | attached |
| `*.ordence.com` | 8080 | attached ⭐ **this is what makes self-serve subdomains possible at all** |
| `admin.ordence.com` | 8080 | attached |
| `appordence-production.up.railway.app` | , | Railway's own |

⚠️ **One rule that follows from the wildcard and must not be relaxed later.** `*.ordence.com` covers **one label only**. `acme.ordence.com` is covered. `acme.corp.ordence.com` is **not**, and would serve a certificate error. `SLUG_PATTERN` forbids dots, so this holds today. It is going into `lib/slug.ts` as a comment so nobody widens the pattern later without knowing what it costs.

---

## 4. ⚠️ Railway variables · two that batch 133 depends on

**Link:** https://railway.com/project/e298fdd1-7172-4011-8011-eb97630e84ed/service/be4ed0d2-3bbb-497f-a45c-333e00f61955/variables?environmentId=513c6404-7105-4161-8847-dac998c90802

I have **not** opened this list and will not, because it returns every value in plaintext. So I am asking rather than checking.

```
UPSTASH_REDIS_REST_URL    = <from your Upstash console>
UPSTASH_REDIS_REST_TOKEN  = <from your Upstash console>
```

🔴 **Do not paste either value to me.** Set them in Railway, tell me only that they are set.

**Why they matter specifically to Group A**, more than they did before: batch 133 puts a public, unauthenticated endpoint on the internet at `/api/public/slug-available`. Its rate limit runs through `lib/edge/limits.ts`. Without Upstash that limiter falls back to per-instance memory counters, which on a multi-instance deploy makes the effective limit *the limit multiplied by the instance count*. An unauthenticated endpoint with a limit that does not hold is an enumeration tool.

⚠️ **Set on the SERVICE, not the project.** A project-level variable the service does not inherit is the commonest way this appears set and is not.

---

## While you do that, I am building

I am not waiting on any of the four to start. The order I am working in:

| | |
|---|---|
| now | `SQL-FILES/0091_slug_authority.sql` and `VERIFY-0091-neon-safe.sql`, proved against real PostgreSQL 16 by planting each violation and confirming the constraint refuses it |
| now | `lib/slug.ts`, the one module that replaces both drifted reserved lists |
| then | six parallel tracks: Drizzle schema, availability endpoint, `claimSlug()`, the signup claim screen, the middleware 301 for released slugs, and the test suite |
| then | all eighteen gates, full test run, zip and deploy document |

**The only thing that actually blocks is tab 6 of the audit.** Everything else I can build against, and adjust if Clerk turns out to need a different topology.
