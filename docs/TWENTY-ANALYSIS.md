# Twenty CRM — What It Is, and What We Can Legally Do With It

**Analysis of `twenty-main` (commit `0773311`, 31 July 2026) against Ordence v0.22.0-alpha**
**Date:** 1 August 2026

---

## Read this part first

**Twenty is not free to copy. It is licensed AGPLv3.**

That is one line, and it decides everything else, so here is what it
actually means in plain terms:

> If we copy Twenty's code into Ordence, then **Ordence
> becomes AGPLv3 too**. We would be legally required to hand the complete
> source code of our entire product to every customer we give it to — and
> they would be free to pass it on to anyone, including a competitor.

This is not a grey area or a technicality somebody might overlook. It is
written into their licence file explicitly:

> *"This additional permission does not apply to Twenty itself: if you
> modify Twenty, the AGPLv3, including section 13, applies to your
> modified version in full."*
> — `LICENSE`, Additional Permission clause 4

Twenty has clearly thought about this. There are **309 files** in the
repository marked `/* @license Enterprise */` — those are not open source
at all, they are commercial, and several of them are things we would
certainly want (row-level security, audit logs, SSO).

**So the request "incorporate all their features" splits into two very
different actions, and only one of them is safe:**

| | Legal? | What it costs |
|---|---|---|
| Copying their **code** | ❌ Only if we open-source everything | The company's ability to sell |
| Copying their **ideas** — the feature list, the data model, what a good workflow engine does | ✅ Completely legal | Engineering time |

Feature lists and ideas are not copyrightable. Source code is. We can
study Twenty as thoroughly as we like and build the same *capabilities*
ourselves — which is exactly what we did with your personal CRM.

---

## The honest size of it

I measured rather than guessed.

| | Twenty | Your personal CRM | Ordence |
|---|---:|---:|---:|
| Lines of TypeScript | **1,824,126** | ~76,000 | ~40,000 |
| Files | **27,169** | 1,063 | ~200 |
| Packages / apps | 20 | 1 | 1 |

**Twenty is roughly 24 times your personal CRM, and about 45 times what
we have built together in twenty-two phases.**

At our pace — one substantial phase per working session, with tests and a
security run — rebuilding Twenty feature-for-feature is not 50 phases. It
is closer to **400–600**. That is years, not months.

I am not saying this to discourage the idea. I am saying it because a
plan built on "we'll just add all of it" fails in month three, and it is
better to know now.

---

## The thing that actually matters: Twenty is empty where you are strong

This is the most useful finding in the whole analysis, and it reframes
the question.

I expected Twenty to be a superset of what we are building. It is not.
It is a **horizontal** CRM — brilliant platform engineering, deliberately
no vertical depth.

### What Twenty has that we do not

| Capability | Why it is genuinely impressive |
|---|---|
| **Runtime custom objects** | Users create new record types and fields from the UI, and it issues real `CREATE TABLE` / `ALTER TABLE` against Postgres at runtime. Our custom-object engine stores rows in a generic table; theirs makes real tables. |
| **Workflow engine** | 4 trigger types, **19 action types** including branching, loops, delays, HTTP, sandboxed code, and human-in-the-loop forms. Versioned, with full run history. |
| **AI agents + MCP** | Named agents with their own permissions, 16 reusable skills, a code interpreter, and Twenty runs as an MCP server so Claude/Cursor can drive it. Supports OpenAI, Anthropic, Gemini, Mistral, xAI, Bedrock, Azure. |
| **App platform** | A real plugin system — `defineObject`, `defineWorkflowAction`, `defineAgent`, sandboxed functions, a CLI, a marketplace. |
| **Views** | Table, Kanban and Calendar over *any* object, with filter groups, grouping, and per-view permissions. |
| **Page layouts** | 21 widget types, user-arrangeable per record type. |
| **Email & calendar sync** | Gmail, Outlook, IMAP, CalDAV — two-way, incremental, with contact auto-creation. |
| **34 languages** | Fully localised. |

### What Twenty does **not** have — at all

| Missing | Relevance to you |
|---|---|
| Quoting, price books, product catalogue | — |
| **Invoicing, payments, accounting** | We built this in Phases 11 and 16 |
| **GST, GSTR-2B, TDS, Tally** | Your entire moat |
| **Contracts and e-signature** | We built this in Phases 6–9 |
| **A Lead object** | They use Person/Company. No lead→booking conversion |
| Telephony, SMS, WhatsApp | Your demand notices need this |
| Marketing automation, sequences, lead scoring | — |
| Approval workflows | — |
| Territory, quota, forecasting, **commissions** | Your channel-partner brokerage |
| Ticketing, SLAs, customer portal | We built the portal in Phase 9 |
| **Anything property-related** | No units, no bookings, no payment milestones, no RERA, no khata, no RA bills |
| Offline mode | The thing you are asking for |

**Twenty is a superb chassis with no cargo. You have the cargo.**

Their engineering strength is precisely our weakness (platform depth,
workflow, AI, views). Our strength is precisely their gap (India finance,
real estate, construction, compliance). They are complements, not
competitors — which is why "which one wins" is the wrong question.

---

## The offline desktop app you asked for — the technical answer

You asked for an installed application with no online database and no
sync. I had this checked properly against their code rather than
guessed, and the answer was better than I expected.

**There is no fundamental blocker.** Twenty's architecture happens to
suit this unusually well: one database connection pool, no cross-process
coordination, no stored procedures, and — importantly — it does **not**
use PostgreSQL row-level security at all, so nothing depends on a
multi-user database.

The work to make it run offline, in order of size:

| Obstacle | Difficulty | Why |
|---|---|---|
| Redis is hardwired in 4 places (cache, sessions, job queue, live updates) | Moderate | In-memory replacements already exist in their code, commented out |
| Database driver must talk in-process instead of over the network | Moderate | Unavoidable adapter work; PGlite has a socket shim |
| Connection pool must collapse to 1 | Moderate | Risk of self-deadlock in a few places |
| Background worker is a second process | Moderate | They already ship an inline job driver |
| The `unaccent` text-search extension | Moderate | One function to replace |
| Runtime `CREATE TABLE`, enums, full-text search, JSON | **Trivial** | PGlite *is* real PostgreSQL 17 — all supported |

So: a desktop app with the database inside it, no cloud, no login, no
sync — **is achievable**. That is true whether we build on their code or
our own.

**And your "prepare it for online later" instinct is right.** The
architecture that makes offline work — one database, one workspace, no
network assumptions — is also the architecture that accepts sync later,
*provided* we keep two rules from day one:

1. Every record carries a globally-unique id generated locally, not a
   sequence number. Two machines must never mint the same id.
2. Every table keeps `updated_at` and a change log. You cannot
   reconstruct history you never recorded, and sync is impossible
   without it.

Both are cheap now and impossible to retrofit cleanly later.

---

## The four real options

I can implement any of these. The choice is commercial, not technical,
so it is yours.

### Option A — Build Ordence as an *app on top of* Twenty

Their licence has an explicit carve-out for this. Their SDK is **MIT**,
not AGPL, and their `defineApplication` / `defineObject` /
`defineWorkflowAction` API exists precisely so people can build
proprietary products on their platform:

> *"Developing an Application, conveying it, or making it available for
> interaction over a network does not, by itself, cause the Application
> to be governed by the AGPLv3. You may license your Application under
> terms of your choice, including proprietary terms."*

- ✅ Fully legal, our code stays ours
- ✅ We inherit their entire platform immediately — custom objects, views, workflow, AI
- ✅ Fastest route to a large product by a wide margin
- ❌ We are a passenger. Their roadmap, their pace, their breaking changes
- ❌ Row-level security is an **Enterprise (paid, closed)** feature — and our whole tenant-isolation guarantee depends on it
- ❌ Hard database constraints like "one live booking per unit" may not be expressible through their app API

### Option B — Fork Twenty, accept AGPL, sell hosting and support

- ✅ Everything, immediately
- ✅ A legitimate business model — it is what GitLab and Odoo do
- ❌ We hand our source to every customer, including the 22 phases already built
- ❌ A competitor can take the whole thing and run it
- ❌ Almost certainly kills any future acquisition or funding conversation

### Option C — Use Twenty as a specification, build our own

Same approach we took with your personal CRM.

- ✅ Legal, clean, everything stays ours
- ✅ We take only the ~15% of their feature set you actually need
- ❌ Slow. The parts most worth having (metadata engine, workflow engine) are the hardest to build
- ❌ Realistically 40–60 phases for a meaningful subset

### Option D — Ask Twenty for a commercial licence

They already sell one — that is what those 309 Enterprise-marked files
are. A paid licence could give us their code *without* the copyleft.

- ✅ Would collapse this entire problem
- ✅ Costs money, not years
- ❌ Unknown price; they may not sell to a competitor
- ⏱️ One email. Worth sending regardless of which option we choose

---

## What I recommend

**Option C for the product, with two deliberate borrowings — and send the
Option D email this week.**

Concretely:

1. **Send the licensing email now.** It costs nothing and could change
   the answer entirely. If they will license it, Option A or B becomes
   viable on our terms.

2. **Build the offline desktop app on OUR codebase**, not theirs. We
   already have the thing Twenty lacks and cannot easily add: forced
   row-level security, a double-entry ledger, GST, invoicing, and now
   bookings and inventory. Twenty would need years to reach that; we
   would need years to reach their platform. Ours is the harder half to
   copy, and it is already built.

3. **Borrow two ideas properly, as our own implementation:**
   - **Their metadata engine approach** — real `CREATE TABLE` at runtime
     instead of our generic-row custom objects. This is the single
     biggest architectural improvement available to us, and it is an
     idea, not code.
   - **Their workflow engine shape** — 4 triggers, ~19 actions,
     versioned, with run history. This is the feature customers ask for
     and it is well worth 3–4 phases.

4. **Ignore roughly 70% of what they have.** Email sync, calendar sync,
   34 languages, the app marketplace, MCP, Zapier — all excellent, none
   of it is why a Bengaluru developer buys a CRM.

---

## What I need from you

The four options lead to genuinely different products, and I should not
pick for you — the difference between them is who owns the company's
source code, which is not an engineering decision.

Tell me which, and I will start immediately.
