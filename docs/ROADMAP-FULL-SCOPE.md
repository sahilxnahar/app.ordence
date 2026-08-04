# Ordence — Full-Scope Build Roadmap

**From v0.10.0-alpha to the complete 101-capability blueprint**
**Date:** 31 July 2026

---

## The honest shape of this

**90 capabilities remain** (83 untouched + 7 partial). Sized against the pace
of Phases 1–10, that is **~80 more phases**.

| | Estimate |
|---|---|
| Remaining phases | **~80** |
| Solo, at the pace of Phases 1–10 | **2–3 years** |
| With two more senior engineers | **12–15 months** |
| Cost at Vercel Hobby → Pro → Enterprise | ₹0 → ₹1,700/mo → ₹40,000+/mo |

That is not a reason to stop. It is a reason to **sequence for revenue**, so
the thing funds itself while it is being built rather than after.

### The one structural decision in this plan

Waves 1–3 (**19 phases**) get you to a product you can sell. Everything after
that is built with customer money and customer feedback instead of guesses.

If you build in blueprint order instead, you reach the same place around
phase 60 — two years later, having built forty features nobody asked for,
and still unable to take a payment. Every part of this plan follows from that
one judgement.

---

# WAVE 1 — REVENUE (Phases 11–16)

**Why first:** You cannot charge anyone today. `plan_tier` and `seat_limit`
exist as columns nothing reads. Every day this is unbuilt is a day the
platform costs money and earns none.

| Phase | Deliverable | Blueprint | Size |
|---|---|---|---|
| **11** | **Billing foundation** — Razorpay + Stripe adapters, `subscriptions`, `plans`, `invoices` schema, webhook handling with signature verification, idempotent payment reconciliation | new | L |
| **12** | **Tiered entitlements & feature-gating engine** — a single `can(feature)` gate every route consults; plan → feature matrix; graceful degradation, never a hard crash | 46 | M |
| **13** | **Seat licensing & concurrency** — seat counting, hard/soft locks, over-seat handling that warns before it blocks | 47 | M |
| **14** | **Lockout intercepts, overages & self-serve upgrade** — the paywall UX, in-app upgrade, proration, dunning | 50 | M |
| **15** | **Usage metering** — per-tenant counters for storage, emails, portal links, API calls; the substrate AI budgeting later needs | 49 (part) | M |
| **16** | **Customer billing portal + security run** — invoices, payment methods, plan changes, GST-compliant invoicing for India | new | M |

> **Milestone: you can take money.** Stop here and sell to three customers
> before writing another line. What they complain about should reorder
> everything below.

---

# WAVE 2 — OPERABILITY (Phases 17–21)

**Why second:** At roughly your fifth tenant, running the platform from a
database console stops being viable. This is the wave that makes support
possible.

| Phase | Deliverable | Blueprint | Size |
|---|---|---|---|
| **17** | **Super Admin console I** — tenant list, health, usage, plan, suspend/reactivate, cross-tenant search (platform-staff only, fully audited) | 77 | L |
| **18** | **Super Admin console II** — audited impersonation with consent + time limit, support tooling, tenant-level feature flags | 77 | M |
| **19** | **Telemetry & observability** — error tracking, Core Web Vitals, session replay with PII redaction, per-tenant health | 65 | M |
| **20** | **SecOps & SIEM** — structured security event stream, anomaly detection, rate limiting everywhere (closes SEC-005, SEC-020), alerting | 3 | L |
| **21** | **PITR, backup & restore** — point-in-time recovery, soft-delete restore UI, tenant export, tested restore drill | 52 | L |

> **Milestone: you can operate.** Support a customer without SQL, and prove a
> restore works before you need one.

---

# WAVE 3 — COMPLETE THE CRM (Phases 22–29)

**Why third:** These are the visible holes an evaluating customer finds in
ten minutes.

| Phase | Deliverable | Blueprint | Size |
|---|---|---|---|
| **22** | **Deals pipeline & Kanban** — the `deals` table has had no UI since Phase 2. Drag-and-drop board, stages, forecasting | 15 | L |
| **23** | **CLM completion** — redlining, clause negotiation, counterparty comments, approval workflows | 8 | XL |
| **24** | **Org hierarchy & relational RBAC** — org tree, manager-of relationships, scope inheritance ("my team's records") | 35 | XL |
| **25** | **Matrix management & multi-dimensional reporting** — dotted-line reporting, cross-cutting views | 36 | L |
| **26** | **Universal context inbox** — one queue for approvals, mentions, tasks, expiring contracts | 116 | L |
| **27** | **Modular dashboard framework** — user-configurable widgets, add/remove/resize/reorder, per-role defaults | 17 | L |
| **28** | **BI builder** — real query builder over tenant data, saved reports, scheduled delivery, CSV/XLSX export | 106 | XL |
| **29** | **Import/export & migration** — CSV import with field mapping and dry-run, full tenant export | 2 (non-AI part) | L |

> **Milestone: a complete CRM.** Everything a mid-market buyer expects to
> exist, exists.

---

# WAVE 4 — GROWTH (Phases 30–34)

**Why now:** You have a sellable product; this is what makes it sell itself.

| Phase | Deliverable | Blueprint | Size |
|---|---|---|---|
| **30** | **Notification platform** — in-app, email, digest, per-user preferences, quiet hours | new (prereq) | L |
| **31** | **Intelligent onboarding & PLG** — guided setup, sample data, activation checklist, time-to-value tracking | 24 | L |
| **32** | **Marketing & retention engine** — lifecycle emails, churn signals, win-back, NPS | 58 | L |
| **33** | **GTM & adoption engineering** — in-app announcements, feature discovery, usage nudges | 22 | M |
| **34** | **Referrals & virality** — invite flows, partner/affiliate tracking | 58 (part) | M |

---

# WAVE 5 — ENTERPRISE READINESS (Phases 35–41)

**Why now:** This wave is what unblocks deals above roughly ₹10 lakh a year.
Below that nobody asks; above it, everybody does.

| Phase | Deliverable | Blueprint | Size |
|---|---|---|---|
| **35** | **Privacy operations** — DSAR workflow, consent management, retention policies, right-to-erasure with audit | 62 | L |
| **36** | **Accessibility (a11y)** — WCAG 2.1 AA audit and remediation across every screen, keyboard paths, screen-reader passes | 60 | XL |
| **37** | **Localization (i18n)** — string extraction, RTL, per-tenant locale, Indian language support | 60 | XL |
| **38** | **BYOK & secrets vault** — customer-managed keys, credential vault, rotation | 67 | L |
| **39** | **Disaster recovery & continuity** — documented RTO/RPO, failover runbook, tested drill | 6 | L |
| **40** | **Multi-region data residency** — regional pinning, India data-residency compliance | 43 | XL |
| **41** | **Global identity federation** — SAML, OIDC, SCIM provisioning, enterprise SSO | 144 | XL |

---

# WAVE 6 — FRONTEND PLATFORM (Phases 42–50)

**Why now:** This is where the product stops looking like a competent
internal tool and starts looking like a product people choose.

| Phase | Deliverable | Blueprint | Size |
|---|---|---|---|
| **42** | **Design token system & dynamic theming** | 12 | L |
| **43** | **White-label completion + programmatic domains & SSL** — Vercel API domain provisioning, per-tenant branding, theme editor | 5, 53 | XL |
| **44** | **Optimistic UI & reactive mutations** — instant feedback, rollback on failure | 13 | L |
| **45** | **Motion & view transitions** | 96, 99 | M |
| **46** | **Zero-form UX & contextual inline editing** | 100 | L |
| **47** | **Adaptive interfaces & UI morphing** | 98 | L |
| **48** | **PWA & offline platform** — offline-first, sync queue, conflict resolution, dynamic manifest | 23, 32 | XL |
| **49** | **Cross-device continuity** | 105 | M |
| **50** | **Native app factory & mobile CI/CD** | 33 | XL |

---

# WAVE 7 — AI (Phases 51–59)

**Why here and not earlier:** AI is differentiation, not survival. Built on
an empty CRM it has nothing to reason about; built on three years of a
customer's real data it is genuinely valuable. It also has a per-token cost
that only Wave 1's metering makes safe to expose.

| Phase | Deliverable | Blueprint | Size |
|---|---|---|---|
| **51** | **AI foundation** — provider abstraction, per-tenant token budgets and rate limits, prompt-injection defences, strict tenant isolation of context | 49 | L |
| **52** | **Private tenant RAG** — per-tenant vector store, ingestion, retrieval that can never cross a tenant boundary | 71 | XL |
| **53** | **Universal command palette / AI omnibar** | 10 | L |
| **54** | **Context-aware AI copilot** | 16 | XL |
| **55** | **AI data migration & field mapping** — the intelligent half of import | 2 | L |
| **56** | **Tenant-isolated ML & predictive analytics** — deal scoring, churn, forecasting | 37 | XL |
| **57** | **AI task routing & work distribution** | 39 | L |
| **58** | **Knowledge graph & expert discovery** | 124 | XL |
| **59** | **AI generative theming** | 31 | M |

---

# WAVE 8 — WORKFLOW & COLLABORATION (Phases 60–67)

| Phase | Deliverable | Blueprint | Size |
|---|---|---|---|
| **60** | **Visual workflow canvas & builder** — the automation engine; arguably belongs earlier if customers ask for automation before AI | 11 | XXL |
| **61** | **Real-time multiplayer collaboration** — presence, live cursors, CRDT editing | 14 | XXL |
| **62** | **Project-based access control & agile squads** | 38 | L |
| **63** | **OKR engine** | 118 | L |
| **64** | **Async standups & blocker resolution** | 42 | M |
| **65** | **Feedback & recognition** | 123 | M |
| **66** | **Leaderboards & incentives** | 122 | M |
| **67** | **Deep work & notification shield** | 40 | M |

---

# WAVE 9 — DATA PLATFORM (Phases 68–73)

| Phase | Deliverable | Blueprint | Size |
|---|---|---|---|
| **68** | **Massive-scale data platform** — partitioning, archival, read replicas | 70 | XL |
| **69** | **Zero-ETL synchronization** | 72 | XL |
| **70** | **Integration adapter framework** | 68 | XL |
| **71** | **Universal webhook subscription platform** | 141 | L |
| **72** | **Native bidirectional event mesh** | 136 | XL |
| **73** | **Extensible data model (BYODB)** | 145 | XXL |

---

# WAVE 10 — THE ECOSYSTEM (Phases 74–88)

**This is not a feature set. It is a second business.**

Fifteen phases building a developer platform, a marketplace, a revenue-share
system and a certification pipeline. It is worth roughly a year on its own,
and it only pays off if you already have customers asking to extend the
product. **Do not start this wave speculatively.**

| Phase | Deliverable | Blueprint |
|---|---|---|
| **74** | Instant developer sandbox | 131 |
| **75** | GraphQL/REST auto-translation layer | 132 |
| **76** | Frontend extension sandbox | 103 |
| **77** | WebAssembly edge plugin runtime | 119 |
| **78** | React micro-frontend platform | 120 |
| **79** | Plugin ecosystem foundation | 41 |
| **80** | Unified app marketplace | 133 |
| **81** | App certification & security pipeline | 140 |
| **82** | Developer monetization & revenue share | 134 |
| **83** | App analytics & developer telemetry | 139 |
| **84** | Versioning, deprecation & rollback | 143 |
| **85** | Open-source connector SDK | 137 |
| **86** | AI agent & prompt marketplace | 135 |
| **87** | Component & workflow template marketplace | 146 |
| **88** | Tenant-to-tenant sharing, headless commerce, community, bounty board | 138, 142, 147, 148 |

---

# WAVE 11 — CERTIFICATION (Phases 89–91)

Parts **1, 4, 7, 30, 34, 51, 57, 69, 76, 125** are *documents*, not software —
architecture review packages, production-readiness attestations, governance
sign-offs. They certify a finished system, so they are written last.

| Phase | Deliverable |
|---|---|
| **89** | Reference architecture & enterprise architecture review package |
| **90** | Production-readiness, operational and workforce governance certifications |
| **91** | Final delivery package & long-term sustainability plan |

---

# What I recommend you DON'T build

Six capabilities in the blueprint I would not schedule at all until a paying
customer asks by name. Each is expensive, none is differentiating for a CRM,
and one is worse than merely wasteful.

| Part | Capability | Why not |
|---|---|---|
| 19 | Spatial computing & 3D asset visualization | Months of work; a WebGL viewer is a demo, not a reason to buy. Revisit only for a real-estate customer who explicitly wants walkthroughs. |
| 29 | Voice interface & ambient computing | Voice in a CRM has repeatedly failed to find users. Very high cost, near-zero adoption. |
| 44 | IoT & hardware integration | Only meaningful with a specific device and a specific customer. Build it *for* that deal, not before. |
| **45** | **Burnout prediction & workforce optimization AI** | **Recommend dropping entirely.** Inferring employee mental state from activity data is ethically fraught, probably unlawful under DPDP as sensitive personal data processing without a lawful basis, and would be a serious liability the first time it was wrong. |
| 55 | Anti-cloning & source-code protection | Obfuscation does not stop a determined competitor and costs you debuggability. Your moat is customer data and switching cost. |
| 112 | Follow-the-sun operations | Only relevant with staff on three continents. |

That is six parts and roughly eight phases you can reclaim — but only 45 is a
recommendation I would push back on if you disagreed. The rest are timing
calls; that one is a judgement about risk.

---

# Summary

| Wave | Phases | Focus | Milestone |
|---|---|---|---|
| **1** | 11–16 | Revenue | **You can take money** |
| **2** | 17–21 | Operability | **You can support customers** |
| **3** | 22–29 | Complete CRM | **Feature-complete for mid-market** |
| **4** | 30–34 | Growth | It sells itself |
| **5** | 35–41 | Enterprise readiness | **₹10L+ deals unblocked** |
| **6** | 42–50 | Frontend platform | It looks like a product |
| **7** | 51–59 | AI | Differentiation |
| **8** | 60–67 | Workflow & collaboration | Stickiness |
| **9** | 68–73 | Data platform | Scale |
| **10** | 74–88 | Ecosystem | A second business |
| **11** | 89–91 | Certification | Enterprise sign-off |

**~80 phases. Waves 1–3 are 19 of them, and they are the ones that decide
whether the other 61 ever get funded.**

---

## How I would like to run this

Same as Phases 1–10, because it has worked:

1. You give me the phase spec.
2. I build it in full, with no placeholders.
3. I run a mandatory security verification and tell you what I found —
   including my own mistakes, as with the `withTenant` bug in Phase 9 and the
   `drizzle-kit push` finding in Phase 10.
4. You get a tarball, a deployment guide written for a non-engineer, and a
   security report.

Two things I would change going forward:

**Re-plan after Wave 1.** Once three customers are paying, their complaints
are better information than this document. I would expect Wave 3 to reorder
substantially and some of Waves 6–8 to disappear.

**Add a browser-verification step.** Ten phases in, no screen has been opened
in a real browser. Types, builds, and 228 tests all pass — but layout,
overflow and mobile behaviour have never been looked at. That gap widens with
every UI phase.

**Say the word and I'll start Phase 11.**
