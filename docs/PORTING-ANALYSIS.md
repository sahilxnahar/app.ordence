# Porting Your CRM Into the SaaS Platform

**Analysis of `ameyacrmv15.91` against Ordence v0.21.0-alpha**
**Date:** 1 August 2026

---

## The short answer

**We can absolutely build these features into the SaaS platform. We cannot
copy the code across.**

That distinction is not pedantry — it is the whole engineering problem, and
the reason is one line in your schema:

```prisma
model Tenant {
  id    String
  name  String
  ...
  leases Lease[]     // ← a RENTAL tenant. A person who leases a flat.
}
```

In your CRM, "tenant" means a person renting a property. In the SaaS
platform, "tenant" means a paying customer whose data must be physically
incapable of touching another customer's.

Your CRM is a **single-organisation application** — correctly so, because
you built it for one organisation. Every database query in it looks like
this:

```ts
prisma.lead.findMany({ where: { status: "ACTIVE" } })
```

No customer filter, because there is only one customer. That is the right
design for what you built, and it is the single most dangerous thing that
could be pasted into a multi-tenant product. One copied query is one
customer reading another's leads.

I checked, rather than assumed: **zero of your 235 models carry a customer
identifier, and zero of your data-access functions filter by one.**

---

## What you have actually built

It is much bigger than I expected, and the numbers are worth seeing.

| | Your CRM | Ordence |
|---|---:|---:|
| Database models / tables | **235** | 46 |
| Pages | **190** | 33 |
| API routes | 62 | 12 |
| TypeScript files | **1,063** | ~150 |
| Domain logic | 33,900 lines | — |
| UI | 41,800 lines | — |
| Top-level features | **145** | 13 |
| Feature overlap | — | **4** |

**141 of your 145 features do not exist in the SaaS platform.** The four
that overlap are dashboard, portal, settings and the landing page.

To be blunt about the ratio: what you built for yourself is roughly **five
times** the product we have built together in twenty-one phases.

---

## The part that matters most

Most of a CRM is commodity. Contacts, deals, tasks, a calendar — every
competitor has them, and none of them win a customer.

**Your India and construction depth is not commodity.** This is the list I
would protect:

| Module | Why it is hard to copy |
|---|---|
| **GSTR-2B reconciliation** | Matching purchase invoices against the portal's data. Every Indian business needs it; almost no CRM does it. |
| **GST filing JSON** | Producing a return file the government portal accepts. |
| **TDS** | Section-wise deduction, certificates, returns. |
| **Tally integration** | Ledgers, vouchers, cost centres, stock. Every Indian accountant runs Tally. This is the single strongest lock-in feature in the whole list. |
| **RA bills** | Running Account bills — the way construction actually invoices. |
| **Khata vault / title chain / heir mapper** | Karnataka land records and succession. Genuinely specialist. |
| **e-Stamps, plan sanction, land conversion** | Statutory workflow nobody generic will build. |
| **Labour compliance, UAN validation, welfare log** | Construction labour law. |
| **MSME payment clock** | The 45-day rule. A legal liability if missed. |
| **Capital gains scenarios** | For landowners in joint development agreements. |

A generic CRM competitor can add contacts in a week. **None of them will
build GSTR-2B reconciliation for a construction firm in Bengaluru.** That
is the moat, and you already have it working.

---

## Why the code cannot be copied — the two blockers

### 1. Multi-tenancy is not a feature you add later

The SaaS platform has 38 tables under forced Row-Level Security, 40
policies, every one with both a read and a write clause, plus append-only
triggers on evidence tables and a deferred constraint on the ledger. Twelve
of our twenty-one phases were spent making cross-tenant access physically
impossible at the database level.

Your 235 models have none of that, and correctly so.

Porting a model is therefore not a paste. Each one needs:

- a non-nullable `tenantId`, and a foreign key
- `ENABLE` + `FORCE` row-level security
- a policy with `USING` **and** `WITH CHECK` — the second one is what stops
  a customer writing a row into someone else's account
- every query rewritten to run inside a tenant transaction
- an entitlement gate, so it belongs to a plan
- an audit path

That is roughly **half a day per model done properly**, and 235 models is
not a sprint.

### 2. Different data layer

You use Prisma; we use Drizzle with hand-written SQL for the security
layer. That is not a preference — Prisma cannot express row-level security
policies, and the policies are the product's core guarantee.

The Prisma models translate mechanically. The *queries* do not, because
ours run inside `withTenant()` transactions.

---

## What I recommend

**Treat your CRM as the specification, and retire the 148-part blueprint.**

The blueprint is aspirational — spatial computing, voice interfaces, a
WebAssembly plugin runtime. Your CRM is **proven by daily use**. Every
feature in it exists because you needed it. That is a far better source of
truth than a document written before anyone used anything, and I would
rather build from it.

Concretely, that changes the roadmap:

- **Waves 3 and 4** become "port the proven modules", not "build what the
  blueprint imagined".
- **The India/construction modules move to the front.** They are the
  differentiator and they are the hardest for a competitor to answer.
- **Several blueprint parts get deleted outright** because your CRM shows
  what real users actually needed instead.

---

## The honest sizing

At the pace of the last twenty-one phases — one substantial phase per
working session, with tests and a security run — porting all 141 features
is roughly **50–70 phases**.

That is not a reason to avoid it. It is a reason to sequence it by revenue
rather than by convenience, and to be selective: I would guess **40 of the
141 carry most of the value**, and some of the rest exist because you
needed them once.

You know which ones those are. I do not, and I would be guessing.

---

## What I need from you

I can start immediately on any cluster. What I cannot do is choose the
order for you, because the right answer depends on who you intend to sell
to first — and that is a commercial decision, not a technical one.

The clusters, roughly:

| Cluster | Features | Notes |
|---|---:|---|
| **Sales & inventory** | ~18 | Leads, units, bookings, milestones, walk-ins, channel partners, brokerage, incentives, pricing |
| **India finance** | ~22 | GST filing, GSTR-2B, TDS, Tally, cash book, vouchers, receivables, demands, MSME clock |
| **Construction delivery** | ~26 | RA bills, BOQ, programme, quality, inspections, safety, site ops, drawings, RFI, transmittals |
| **Land & legal** | ~16 | Title chain, khata, heir mapper, e-stamps, plan sanction, litigation, due diligence |
| **Leasing & facilities** | ~10 | Leases, rent schedules, maintenance, parking, commercial tenancy |
| **Workflow & comms** | ~20 | Tasks, approvals, automations, sequences, chat, inbox, calendar, reminders |
| **Admin & platform** | ~30 | Custom fields, permissions, integrations, webhooks, API tokens, branding |
| **AI** | ~8 | Ask, assistant, insights, briefing, voice notes, document scan |

---

## One thing I would flag now

Some of what is in your CRM should probably **not** go into a
multi-tenant product as-is.

`secret-cash-book` is the clearest example. In a single-organisation app
that you own, it is your business. In a SaaS product, a deliberately
concealed ledger that other users of the same workspace cannot see is a
feature with an obvious use and an obvious misuse, and it is the sort of
thing that appears in a due-diligence question or a regulatory one.

I am not refusing to build it — it may have a completely legitimate
purpose I do not know about, and you would know. But I would want to
understand what it is for before putting it in a product other companies
will run their finances on, and it should almost certainly be visible in
the audit trail even if it is hidden in the interface.

There may be others like it. That is a conversation worth having once,
early, rather than per-module.
