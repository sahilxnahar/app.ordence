# Ordence — The Master Plan

**Everything unfinished, sequenced. Supersedes `ROADMAP-FULL-SCOPE.md`.**
**Version:** v0.25.0-alpha · 1 August 2026

---

## Why the old roadmap needs replacing

`ROADMAP-FULL-SCOPE.md` laid out 91 phases across 11 waves. It was written
**before** two things we now know:

1. **Your personal CRM has 145 features**, and ~90 of them are India and
   construction depth that no competitor will build. That is the moat, and
   the old roadmap did not contain a single one of them.
2. **Twenty CRM is AGPLv3**, so nothing gets copied — and separately, Twenty
   has *none* of your vertical depth either. The generic-CRM race is not
   where you win.

If we simply added your CRM's 90 features to the old 91 phases we would have
a **180-phase plan — three to four years**. That is not a plan, it is a wish.

So this document does something different: it sequences by **what unlocks
money**, cuts what does not, and is explicit about where the tail becomes
optional.

---

## Where we actually are

**25 phases built. 624 tests passing. 64 tables, 57 policies.**

| Built | |
|---|---|
| Phases 1–16 | Foundation, CRM, contracts, accounting, portal, billing, entitlements, seats, metering, invoicing |
| Phases 19–21 | Telemetry, SecOps, backup & restore |
| Phase 22 | Sales pipeline & inventory — leads, units, bookings, milestones, channel partners |
| Phase 23 | Workflow engine — 6 triggers, 13 actions, versioned, run history |
| Phase 24 | Runtime custom objects — real tables, forced RLS |
| Phase 25 | Saved views — table/kanban/calendar over any object |
| Desktop | PGlite offline build, 28/28 security checks |

**Two things worth noticing.** Phases 23 and 24 were originally scheduled in
Waves 8 and 9 — phases 60 and 73, roughly two years out. We built them in a
day because they turned out to be the foundation everything else sits on.
And Phase 22 replaced the old "deals pipeline" with a *real-estate* pipeline,
which is a better product for you.

**Incomplete:** Phases 17–18 (admin console), and three engines with no user
interface at all.

---

# The plan

Eight waves. **Waves A–C are the business.** D–F are what makes it
enterprise-grade. G–H are optional and I would not start them speculatively.

---

## WAVE A — Make what exists sellable (6 phases)

**Why first: this is the cheapest money on the table.** Three complete,
tested engines are sitting behind no door. A customer cannot reach the
workflow builder, custom objects or saved views — they exist only as server
functions. Six phases turns three finished phases into three sellable
features.

| # | Phase | Size |
|---|---|---|
| 26 | **Workflow builder UI** — visual canvas, trigger/action pickers, run history, approvals inbox | XL |
| 27 | **Custom object designer** — create record types and fields from the UI, auto-generated forms and detail pages | L |
| 28 | **Views everywhere** — the saved-view bar and generic kanban wired onto every list page | L |
| 29 | **Admin console (finishes 17/18)** — tenant list, health, suspend, audited impersonation, feature flags | L |
| 30 | **Desktop UI** — the real interface inside the app; the two known blockers, then package .dmg/.exe | L |
| 31 | **Deploy hardening** — production SQL, Razorpay plans, branch protection, Clerk JWT, Wave 1+2 security run | M |

> **Milestone: everything built is usable, and you can operate the business.**

---

## WAVE B — India finance: the moat (10 phases)

**Why second: this is why a Bengaluru developer chooses you over Zoho.**

Every generic CRM can add contacts in a week. **None of them will build
GSTR-2B reconciliation for a construction firm.** This wave is the hardest
part of your product for anyone to copy, and you already know it works
because you use it daily.

⚠️ **GST and TDS rules are public law, not your CRM's intellectual
property.** We implement the statute; your CRM tells us which parts of it
actually matter in practice — which is the valuable half.

| # | Phase | What it unlocks | Size |
|---|---|---|---|
| 32 | **GST foundation** — GSTIN registry, HSN/SAC masters, place-of-supply engine, CGST/SGST/IGST determination, reverse charge | Everything below | L |
| 33 | **Purchase & vendor invoices** — ITC eligibility, blocked credits (Sec 17(5)), vendor ledger | Input side exists | L |
| 34 | ⭐ **GSTR-2B reconciliation** — match purchase invoices against the portal's data, mismatch workbench, vendor chase | **The single strongest feature in the product** | XL |
| 35 | **GSTR-1 & GSTR-3B** — return preparation, government-accepted JSON, filing history | Compliance closed | XL |
| 36 | **TDS** — 194Q/194H/194IA/206AB, threshold tracking, challans, Form 16A, quarterly returns | Legal exposure closed | XL |
| 37 | ⭐ **Tally integration** — ledgers, vouchers, cost centres, two-way sync | **The strongest lock-in feature you have.** Every Indian accountant runs Tally | XL |
| 38 | **Receivables & demand notices** — construction-linked demands, multi-language notices, ageing, dunning ladder | Collections | L |
| 39 | **Cash book & vouchers** — receipt/payment/journal/contra, bank reconciliation, day book | Daily operations | L |
| 40 | **MSME 45-day clock** — payment-due tracking under the MSMED Act, interest exposure, disclosure | A legal liability if missed | M |
| 41 | **Indian statutory reporting** — Form 26AS reconciliation, e-invoice IRN, e-way bill | Enterprise-ready | L |

> **Milestone: no competitor can answer your demo.**

---

## WAVE C — Construction delivery (8 phases)

**Why third: it doubles who you can sell to.** Wave B sells to the finance
office; this sells to the site office, and together they make you the
system of record for the whole firm.

| # | Phase | Size |
|---|---|---|
| 42 | **BOQ & rate analysis** — bills of quantity, item master, rate build-up, variations | L |
| 43 | ⭐ **RA bills** — running-account billing, measurement books, retention, deductions, certification chain | XL |
| 44 | **Programme & progress** — activity schedule, baseline vs actual, S-curve, delay analysis | L |
| 45 | **Quality & inspections** — checklists, NCRs, hold points, snag lists, closure evidence | L |
| 46 | **Site operations** — daily progress reports, labour returns, material receipts, plant log | L |
| 47 | **Drawings, RFIs & transmittals** — revision control, issue register, distribution log | L |
| 48 | **Subcontractor management** — work orders, back-charges, performance, retention release | L |
| 49 | **Labour compliance** — UAN validation, welfare log, muster, statutory registers | M |

> **Milestone: the site office runs on your product too.**

---

## WAVE D — AI agents & MCP (6 phases)

**Why here and not earlier:** you chose this capability, and it is worth
building — but AI over an empty CRM has nothing to reason about. Over three
years of a customer's GST, bookings and site data it is genuinely valuable.
It also costs money per token, which only Phase 15's metering makes safe.

| # | Phase | Size |
|---|---|---|
| 50 | **AI foundation** — provider abstraction (Anthropic/OpenAI/Gemini), per-tenant token budgets, ⚠️ prompt-injection defences, strict tenant isolation of context | L |
| 51 | **Private tenant RAG** — per-tenant vector store, ingestion, retrieval that *cannot* cross a tenant boundary | XL |
| 52 | **AI agents** — named agents with their own permissions and reusable skills, execution monitor | XL |
| 53 | ⭐ **MCP server** — expose the CRM so Claude/Cursor can operate it, per-tool permission gating | L |
| 54 | ⭐ **Domain agents** — the GST reconciler, the demand chaser, the lead scorer, the RA-bill checker. **This is where AI earns its cost** — generic chat does not | XL |
| 55 | **AI omnibar & copilot** — command palette, context-aware assistance | L |

> ⚠️ **The security work in Phase 50 is not optional.** An AI agent with
> database access and a prompt-injection hole is a cross-tenant data breach
> with a friendly interface.

---

## WAVE E — Land, legal & leasing (7 phases)

**Genuinely specialist. Karnataka land records are not something a
competitor will ever build.**

| # | Phase | Size |
|---|---|---|
| 56 | **Khata vault & title chain** — ownership history, encumbrance, mutation records | L |
| 57 | **Heir mapper & succession** — family trees, legal heirs, partition | L |
| 58 | **Statutory workflow** — e-stamps, plan sanction, land conversion, OC/CC tracking | L |
| 59 | **Litigation & due diligence** — case tracker, hearing calendar, DD checklists | L |
| 60 | **JDA & capital gains** — joint development agreements, landowner shares, capital-gains scenarios | L |
| 61 | **Leasing** — leases, rent schedules, escalations, renewals, commercial tenancy | L |
| 62 | **Facilities** — maintenance, parking, amenities, society handover | M |

---

## WAVE F — Growth & enterprise readiness (8 phases)

**Unblocks deals above roughly ₹10 lakh a year. Below that nobody asks.**

| # | Phase | Size |
|---|---|---|
| 63 | **Notification platform** — in-app, email, digest, preferences, quiet hours | L |
| 64 | **Import/export & migration** — CSV with field mapping and dry-run, full tenant export | L |
| 65 | **BI builder** — query builder, saved reports, scheduled delivery | XL |
| 66 | **Modular dashboards** — user-configurable widgets, per-role defaults | L |
| 67 | **Privacy operations (DPDP)** — DSAR workflow, consent, retention, right-to-erasure | L |
| 68 | **Accessibility (WCAG 2.1 AA)** — audit and remediation across every screen | XL |
| 69 | **Localisation** — Hindi, Kannada, Tamil, Telugu, Marathi; RTL-ready | XL |
| 70 | **SSO & SCIM** — SAML, OIDC, directory provisioning | XL |

---

## WAVE G — Platform & scale (6 phases) · *only when asked*

Onboarding & PLG · white-label completion · design tokens & theming ·
partitioning and archival · integration adapter framework · webhook
subscription platform.

**Do not start these speculatively.** Each is real work that only pays off
when a customer is actively blocked by its absence.

---

## WAVE H — The ecosystem · *probably never*

The old roadmap's Wave 10 was fifteen phases building a developer platform,
a marketplace and a revenue-share system.

**That is not a feature set, it is a second business.** It is worth about a
year on its own and only pays off if customers are already asking to extend
your product. Nobody has asked. **Cut until they do.**

---

# What I recommend cutting entirely

Being direct, because a plan that keeps everything is not a plan:

| Cut | Why |
|---|---|
| Real-time multiplayer / live cursors | Two people rarely edit one booking simultaneously. Enormous effort, no deal ever turns on it |
| OKRs, leaderboards, recognition, async standups | These are HR tools. You are selling a real-estate CRM |
| Deep work & notification shield | Same |
| Native mobile app factory | A responsive web app covers the site engineer. Revisit only if field usage demands offline mobile |
| Knowledge graph & expert discovery | Impressive, unsellable |
| Generative theming | — |
| `secret-cash-book` | ⚠️ **Needs a conversation first.** A deliberately concealed ledger in a product other companies run their finances on is a due-diligence question waiting to happen. I am not refusing — I want to understand what it is for |

That is roughly **25 phases removed** from the old plan.

---

# The honest arithmetic

| | Phases | At ~1 substantial phase per working session |
|---|---:|---|
| **Waves A + B** — sellable, with the moat | 16 | ~4 months |
| **+ Wave C** — construction | 24 | ~6 months |
| **+ Wave D** — AI & MCP | 30 | ~7 months |
| **+ Waves E + F** — specialist + enterprise | 45 | ~11 months |
| Waves G + H | 65+ | not scheduled |

**45 phases to a genuinely complete, differentiated product.**

---

## If you only build twelve

Because "everything" is how products never ship. The minimum that makes you
un-copyable:

**26, 27, 28** (make it usable) · **29, 31** (operate and deploy) ·
**32, 34, 36, 37** (GST, 2B reconciliation, TDS, Tally) ·
**38** (demands) · **43** (RA bills) · **53** (MCP)

Twelve phases. Roughly three months. At the end of it you have a CRM that
takes money, runs a construction business's finances, files its returns,
talks to Tally, bills its contractors — and that Claude can operate directly.

**No competitor in India has that combination.**

---

# How I would run it

1. **Waves A and B in parallel** where they do not collide — UI work and
   finance schema touch different files.
2. **A security run before every deploy package**, as now. Every phase that
   touches money or tenant boundaries gets an adversarial review; those have
   found real, exploitable defects in three of the last four phases.
3. **Both builds stay in step.** Every phase lands in the hosted product and
   the offline app from the same schema and the same SQL files.
4. **Re-plan after Wave B.** Once the first three customers are running GST
   returns through this, their complaints are better information than this
   document.

---

## What I need from you

1. **`secret-cash-book`** — one conversation, before Wave B.
2. **Your personal CRM zip again if you want exact parity.** I analysed it
   before but the container has been recycled since. GST and TDS I can build
   from the statute; but *your* demand-notice formats, *your* RA-bill
   certification chain and *your* khata workflows are the details that make
   it feel like the system you already trust.
3. **Nothing else.** Waves A and B can start immediately.
