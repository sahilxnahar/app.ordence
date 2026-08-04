# Where things stand

Written while you slept. Read the first section, act on it, then the rest.

---

## 🔴 One thing needs you: commit and push

Everything below is already sitting in
`Documents/GitHub/app.ordence` on your Mac. **It is not on GitHub and not
deployed until you push it.**

1. GitHub Desktop → **Current Repository: app.ordence**
2. Summary: `v5 middleware fix, observatory, provisioning, receivables`
3. **Commit to main** → **Push origin**

Cloudflare builds automatically. Then open
<https://app-ordence.sahil-ad6.workers.dev/api/diag> — that route is new and it
answers, in one screen, whether every setting the Worker needs is actually
reaching it. Booleans only; it never prints a key's value.

---

## What the 500 error actually was

Every URL returned a blank 500 — even `/robots.txt` and `/api/health`, a route
whose entire body is a hard-coded JSON object. Nothing was reaching them.

Your own Clerk dashboard proved it: both API keys read **"Never used."** Clerk
had never received a single request. The app was failing *before* it ever
called out.

**The cause.** Next.js replaces every literal `process.env.NEXT_PUBLIC_…` with
whatever that variable held *at build time* — including inside Clerk's own
bundled code. Cloudflare builds on one machine and runs on another, so the
build machine had no keys and `undefined` was frozen into the output. Clerk
then threw "Missing publishableKey" on every request, in the middleware,
before routing.

**The fix**, in `middleware.ts`: read the keys through a variable so the
bundler cannot inline them, and hand them to `clerkMiddleware()` explicitly.
Plus a try/catch, so a middleware that throws says *why* at `/api/diag`
instead of producing a blank 500 everywhere.

> I got this wrong twice before getting it right, and both times for the same
> reason: I tested with a stray `.env.local` on my machine quietly supplying
> the values. The verified build is now run with every environment variable
> stripped and no `.env` file present — `next build` and the full Cloudflare
> Worker bundle both complete clean.

---

## Your database is finished

I connected to Neon directly and checked rather than asking you to:

| | |
|---|---:|
| Tables | 97 |
| Tables with row-level security **enabled and forced** | 90 |
| Policies active | 90 |
| Triggers | 270 |

`FORCED` is the word that matters — without it the owner account walks straight
past every policy, and the owner account is the one your app connects as.

The missing piece was `00-CREATE-TABLES.sql`: the twelve files only apply
*security* to tables, and creating the tables had been a Terminal command in
the original plan. When we dropped the Terminal, that step silently went with
it. That was my oversight and it is fixed.

---

## Built while you slept

### `docs/FEATURE-MAP-500.md` — all 500 features, audited against the code

Not a plan. A measurement, taken by reading the schema, the routes and the
libraries.

| | Count |
|---|---:|
| ✅ Built | 35 |
| 🟡 Partial — the hard part exists, needs a surface or wiring | 77 |
| ⬜ Not started | 388 |

🟡 is the interesting column. It is where the cheap wins are, because the
expensive and dangerous parts — tenant isolation, the ledger, the tax engines,
the workflow engine — are already done and tested.

### `docs/BUILD-ORDER.md` — what to build and why that order

The catalogue is grouped by theme; the code is blocked by dependency. Twelve
keystones each unlock 8–25 other features and nothing downstream can be built
until they exist. The big ones: an **order object** (~20 features), **email
sync** (~16), **inventory** (~25), **ticketing** (~24), **one telephony
adapter** (~14).

### Master Admin Panel — two of your three

**Health & Revenue Observatory** (`/platform/observatory`) — the view
Cloudflare structurally cannot give you. Their dashboard reports on a *Worker*;
one Worker serves every tenant, so it can say "the platform is up" and nothing
else. This says which tenant is producing the errors, which is eating the
shared request budget, and which has gone quiet.

Includes the churn siren (14 days silent), the free-tier burn-down, the
adoption heatmap and cohort retention. Aggregates only — not one customer
record reaches the screen.

> The alarms panel is deliberately above the revenue total. A cockpit that
> opens on revenue trains you to feel good; one that opens on the accounts
> about to leave trains you to act.

**Provisioning & Domain Automation** (`/platform/provision`) — describe a
workspace, read exactly what will happen in numbered order, then approve. Two
steps, and the first is not skippable: provisioning is the one genuinely
irreversible operation in the platform, and a confirmation dialog would not
help because people click those. Generates the customer's DNS records and
refuses reserved slugs — `admin.app.ordence.com` under someone else's control
is phishing with a certificate we issued.

**Tenant Command Grid** was largely already built at `/platform`. What it still
lacks: TLS status per domain, purge-cache, and inline plan upgrade.

### Three screens for engines that had none

- **`/sales/partners/[id]`** — the navigation has linked here since Phase 22 and the route never existed. Commission, TDS and net payable per booking, with the payout blocker placed *above* the money.
- **`/receivables`** — Phase 38 built ageing buckets, dunning ladders, six-language demand notices and receipt allocation, and shipped zero screens. This renders the buckets and computes none of them, so the figure here always matches the figure in the bank export.
- **`/gst`** — registrations, HSN/SAC codes and today's rates. The alarm is at the top: any code with no rate period covering today cannot price an invoice, and that failure is silent until somebody is mid-bill.

### 65 specialist agents installed

From the 272 you sent, in `.claude/agents/`. The other 207 are excluded on
purpose — game engines, GIS, Solidity and regional social platforms make the
menu worse, not better. Each one kept maps to something in the feature map.
`.claude/agents/README.md` says which and why.

---

## What I would do next, in order

1. **Push, and confirm the site loads.** Everything else is theoretical until it does.
2. **Wave 1 — surfaces for finished engines.** GST, purchases, GSTR-2B, TDS and Tally all have complete tested backends and no screens at all. That is the largest gap between what Ordence can do and what a customer can see, and it invents nothing.
3. **Then the keystones**, order object first.

## Still outstanding from earlier

- Clerk **Organizations** must be enabled, or nobody can sign in
- Clerk is on a **development** instance — 100-user cap, small banner. Fine to launch on; swap to production keys before real customers
- `_to_delete/` is still in the repo. Harmless, but it can go
- **Petty cash (feature 322)** — you asked to talk before it gets built. Still untouched, deliberately
