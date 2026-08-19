# Blueprint Gap Analysis

**What the blueprint asks for vs. what exists at v0.10.0-alpha**
**Date:** 31 July 2026

---

## First, a correction to the headline number

The blueprint is numbered to **148 parts**. It does not contain 148 distinct
capabilities.

Extracting every `PART n —` heading across all source files and deduplicating
by title gives **101 distinct capabilities**. Parts 1–78 reappear almost
verbatim as parts 79–156 — the same numbering corruption you spotted yourself
early on ("it resets backward to PART 119"). Forty-seven titles appear two or
three times.

So the honest denominator is **101**, not 148. That changes the completion
picture materially, and every figure below uses it.

---

## Where you actually stand

| | Count | Share |
|---|---|---|
| **Built** — production-ready, tested | **8** | 8% |
| **Partial** — foundation exists, feature incomplete | **7** | 7% |
| **Not started** | **83** | 82% |
| **Not a feature** — assessments, meta-instructions | **3** | 3% |

**Roughly 15 of 101 capabilities are wholly or partly delivered.**

That number understates the position, and it is worth saying why. What is
built is the load-bearing part: tenant isolation, financial integrity, audit
evidence, and the security model. Those are the things that are ruinously
expensive to retrofit and cheap to get wrong. Most of what remains is
ordinary product work stacked on top of a foundation that already holds.

---

## ✅ BUILT (8)

| Part | Capability | What exists |
|---|---|---|
| 9 | **Immutable Audit Platform, Trust Accounting & Legal Evidence** | `audit_logs` append-only, double-entry ledger with deferred balance trigger, period close, `contract_signatures` append-only. 5 evidence tables. |
| 20 | **Industry-Specific Vertical SaaS Architecture** | Polymorphic engine — navigation, dashboard and vocabulary all driven by one `tenants.settings.industry` field. |
| 25 | **Multi-Tenant QA & Zero-Leakage Testing Strategy** | 126 security tests against real PostgreSQL as a non-superuser, plus 102 UI tests. CI gate on every push. |
| 26 | **Industry-Specific UI/UX Routing & Dynamic Rendering** | Real-estate and legal templates, industry-switchable from Settings. |
| 28 | **Product, Asset & Inventory Catalog System** | `assets` (20 types, 12 statuses), `asset_relationships` graph, custom-object engine with 12 field types and zero-migration entities. |
| 56 | **Absolute Zero-Bleed Data Architecture** | RLS `ENABLE` + `FORCE` on 25 tables, cross-tenant reference triggers, `security_invoker` analytics views, `npm run db:verify`. |
| 62 | **Privacy Operations (partial DPDP)** — *see caveat below* | Soft deletes everywhere, hard blob deletion, full audit trail, external consent capture. |
| 106 | **Enterprise BI Builder** — *reporting only* | Three tenant-scoped analytics views, streaming dashboard, exact decimal arithmetic. Not a user-facing report builder. |

> ⚠️ Parts 62 and 106 are marked built against their *core intent*, not their
> full scope. 62 lacks DSAR workflows and consent management; 106 lacks a
> query builder. Both are closer to "substantially started" than "done" — I
> would rather flag that than let two ticks flatter the count.

---

## 🟡 PARTIAL (7)

| Part | Capability | Built | Missing |
|---|---|---|---|
| 8 | **Enterprise CLM & Legal Collaboration** | Contracts, hash-chained immutable versions, clause library, document assembly, e-signature via portal | Redlining, clause negotiation, counterparty comments, approval workflows |
| 15 | **Airtable-Style Data Grid & Kanban** | TanStack grid, virtualization, inline edit with persistence | **Kanban board entirely absent** |
| 17 | **Modular Dashboard Widget Framework** | Dashboard with streaming panels | Not modular — users cannot add, remove, resize or reorder widgets |
| 35 | **Org Hierarchy & Relational RBAC** | 9 roles, 50 permissions, per-user overrides, anti-escalation rules | No org tree, no manager-of relationships, no delegated scope |
| 46 | **Tiered Entitlements & Feature Gating** | `plan_tier` and `seat_limit` columns exist | No enforcement anywhere — nothing reads them |
| 52 | **PITR & Soft Deletes** | Soft deletes across every table | No point-in-time recovery, no restore UI |
| 5 | **White-Label & Custom Domains** | Middleware resolves custom-domain hosts; branding fields in schema | No domain provisioning, no SSL automation, no theme editor |

---

## ❌ NOT STARTED (83)

Grouped by what they would unlock.

### Revenue — nothing here works yet, and nothing else earns money without it
| Part | Capability |
|---|---|
| 46 | Tiered entitlements & feature gating *(schema only)* |
| 47 | Seat licensing, concurrency & user locking |
| 49 | AI tier architecture, token budgeting & rate limiting |
| 50 | Lockout intercepts, overages & self-serve upgrade |
| 58 | Built-in marketing, PLG & retention engine |
| 22 | Go-to-market & adoption engineering |
| 24 | Intelligent onboarding & product-led growth |

### Platform administration
| Part | Capability |
|---|---|
| 77 | Tenant administration console / company control center |
| 53 | Programmatic custom domains & SSL (Vercel API) |
| 3 | Enterprise SecOps, SIEM integration & threat protection |
| 6 | Disaster recovery, business continuity & data sovereignty |
| 43 | Multi-region data residency & localization |
| 63 | Platform governance & long-term sustainability |
| 65 | Frontend telemetry, session replay & UX observability |

### AI — the single largest untouched block
| Part | Capability |
|---|---|
| 2 | AI-powered data migration, ETL & field mapping |
| 10 | Universal command palette / AI omnibar |
| 16 | Context-aware floating AI copilot |
| 29 | Voice interface & ambient computing |
| 31 | AI generative theming & brand intelligence |
| 37 | Tenant-isolated ML & predictive analytics |
| 39 | AI task routing & work distribution |
| 45 | Burnout prediction & workforce optimization |
| 71 | Private tenant RAG |
| 124 | Knowledge graph & AI expert discovery |
| 135 | AI agent & prompt marketplace |

### Developer ecosystem & marketplace (17 parts — the whole block)
Parts **41, 119, 120, 131–148**: plugin ecosystem, WebAssembly edge runtime,
micro-frontends, GraphQL/REST auto-translation, app marketplace, developer
monetization, event mesh, connector SDK, tenant-to-tenant sharing, app
analytics, certification pipeline, webhook platform, headless commerce,
versioning & rollback, identity federation, bring-your-own-database, template
marketplace, embedded community, bounty board.

### Collaboration & workforce
| Part | Capability |
|---|---|
| 14 | Real-time multiplayer collaboration |
| 36 | Matrix management & multi-dimensional reporting |
| 38 | Dynamic agile squads & project-based access control |
| 40 | Deep work platform & notification shield |
| 42 | Asynchronous standups & blocker resolution |
| 112 | Global workforce & follow-the-sun operations |
| 116 | Universal context inbox |
| 118 | Enterprise OKR engine |
| 122 | Leaderboards & incentive platform |
| 123 | Continuous feedback & recognition |

### Frontend platform & UX
| Part | Capability |
|---|---|
| 11 | Visual workflow canvas & drag-and-drop builder |
| 12 | Enterprise design token system & dynamic theming |
| 13 | Optimistic UI & reactive mutations |
| 19 | Spatial computing & 3D asset visualization |
| 23 | Progressive web app & offline platform |
| 32 | Dynamic PWA manifest & install experience |
| 33 | Native application factory & mobile CI/CD |
| 60 | Accessibility (a11y) & localization (i18n) |
| 96 | Motion design system |
| 98 | Adaptive interfaces & dynamic UI morphing |
| 99 | View transition architecture |
| 100 | Zero-form UX & contextual inline editing |
| 103 | Frontend extension sandbox |
| 105 | Cross-device continuity |

### Data & integration
| Part | Capability |
|---|---|
| 44 | IoT & hardware integration |
| 67 | BYOK & enterprise secrets vault |
| 68 | Dynamic integration injection & adapter framework |
| 70 | Massive-scale data platform |
| 72 | Zero-ETL synchronization |
| 145 | Extensible data model (bring your own database) |

### Security & IP
| Part | Capability |
|---|---|
| 55 | Anti-cloning & source-code protection |
| 144 | Global identity federation |

### Certification & governance documents
Parts **1, 4, 7, 30, 34, 51, 57, 69, 76, 125** are *certification and
governance deliverables* — architecture review packages, sign-off checklists,
production-readiness attestations. They are documents to be produced, not
software to be built, and are best done once the system they certify is
finished.

---

## What I would actually do next

The blueprint's ordering is not a build order. Three things stand between you
and a business, in this sequence:

**1. Billing and entitlements (parts 46, 47, 50).** You cannot charge anyone
today. `plan_tier` and `seat_limit` exist as columns that nothing reads. This
is the only block where "not started" costs you revenue every day it stays
that way, and it is perhaps two phases of work.

**2. Tenant admin console (part 77).** You currently have no way to see your
own customers, suspend one, or diagnose a problem without a database console.
That becomes untenable at roughly your fifth tenant.

**3. Deals pipeline + Kanban (part 15's missing half).** The `deals` table has
existed since Phase 2 with no UI at all. It is the most visible hole in the
CRM for anyone evaluating the product.

After those, the AI block (parts 10, 16, 71) is what makes the product feel
like 2026 rather than 2016 — but it is differentiation, not survival, and it
should not jump the queue ahead of getting paid.

The developer marketplace block (17 parts) is a platform business, not a
feature set. It is worth roughly a year on its own and should not be started
until the core product has customers who want to extend it.

---

## Two honest observations about the blueprint itself

**It is aspirational, not a specification.** Several parts — spatial
computing, voice interfaces, burnout prediction AI, a WebAssembly edge plugin
runtime — are individually the scope of a funded startup. Treating the 101 as
a checklist to complete would take many years. Treating it as a menu of
possibilities, ordered by what your customers actually ask for, is the way it
earns its value.

**The duplication matters practically, not just cosmetically.** Because parts
1–78 repeat as 79–156, any progress tracker built on the raw numbering will
double-count and report roughly half the true completion. Use the 101.
