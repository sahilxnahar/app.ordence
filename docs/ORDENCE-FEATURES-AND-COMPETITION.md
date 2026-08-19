# Ordence — the complete feature map, and how it compares

**One CRM + ERP for the Indian real-estate and construction market.**
Universal core, industry packs, one codebase.

> **Companion documents.** `FEATURE-MAP-500.md` is the row-by-row engineering
> audit of all 500 features. This file is the *positioning* view: categorised,
> filterable, and honest about where competitors are ahead.

---

## How to read this — the filters

Every feature carries four tags. Filter by whichever question you are asking.

### Filter 1 · Build status

| Tag | Meaning |
|---|---|
| ✅ **LIVE** | Built, tested, reachable in the product |
| 🟨 **ENGINE** | Backend complete and tested, **no screen yet** |
| 🟦 **NEXT** | Scheduled, dependencies met |
| ⬜ **PLANNED** | On the roadmap, not started |

### Filter 2 · Commercial tier

| Tag | Meaning |
|---|---|
| **CORE** | Every plan, including free |
| **GROWTH** | Paid tier |
| **SCALE** | Enterprise — multi-entity, SSO, API |
| **PACK** | Industry pack, licensed separately |

### Filter 3 · Persona — who opens this screen

`SALES` · `FINANCE` · `SITE` (project/site engineer) · `OPS` · `ADMIN` ·
`CUSTOMER` (external) · `PARTNER` (broker/vendor)

### Filter 4 · Competitive position

| Tag | Meaning |
|---|---|
| 🏆 **UNIQUE** | Nobody in our segment offers this |
| ⚡ **BETTER** | Others have it; ours is materially stronger |
| ≈ **PARITY** | Comparable to the market |
| ⚠️ **BEHIND** | Competitors are ahead of us today |

---

## The one-paragraph positioning

Indian real-estate developers currently run **three** systems: a CRM
(Sell.Do, LeadSquared or Zoho), an ERP (In4Velocity, Farvision or SAP B1),
and Tally for accounts. The three do not agree with each other, so somebody
reconciles them in Excel every month. Ordence is one system where a booking
*is* a ledger entry, a demand letter *is* a receivable, and a channel
partner's commission *is* a TDS-deducted payable — computed once, in one
database, under row-level security that makes cross-tenant leakage a
physical impossibility rather than a code review promise.

---

# PART 1 — The feature catalogue by category

## 1. Sales & CRM

| Feature | Status | Tier | Persona | Position |
|---|:--:|---|---|:--:|
| Drag-drop lead pipeline with per-stage automation | ✅ | CORE | SALES | ≈ |
| Unit/tower inventory grid with live availability | ✅ | CORE | SALES | ⚡ |
| Booking → unit lock (double-sale physically impossible) | ✅ | CORE | SALES | 🏆 |
| Channel partner registry, lead lock, commission engine | ✅ | CORE | SALES/PARTNER | ⚡ |
| Cost sheets & payment milestone plans per unit | ✅ | CORE | SALES/FINANCE | ⚡ |
| Contacts, companies, deals with custom fields | ✅ | CORE | SALES | ≈ |
| Saved views, filters, kanban/table/calendar | ✅ | CORE | ALL | ≈ |
| E-signature with audit certificate | ✅ | GROWTH | SALES | ≈ |
| Contract repository + clause library | ✅ | GROWTH | SALES | ≈ |
| Quote/CPQ builder | 🟦 | GROWTH | SALES | ≈ |
| Two-way email sync (Gmail/Outlook) | ⬜ | CORE | SALES | ⚠️ |
| WhatsApp Business inbox | ⬜ | GROWTH | SALES | ⚠️ |
| Telephony (click-to-call, recording, IVR) | ⬜ | GROWTH | SALES | ⚠️ |
| Portal lead ingestion (99acres, MagicBricks, JustDial) | ⬜ | PACK | SALES | ⚠️ |
| Site-visit scheduling with geo check-in | 🟦 | PACK | SALES | ≈ |

## 2. Finance & Accounting

| Feature | Status | Tier | Persona | Position |
|---|:--:|---|---|:--:|
| Double-entry ledger enforced by database trigger | ✅ | CORE | FINANCE | 🏆 |
| Period close & lock with journal approvals | ✅ | GROWTH | FINANCE | ⚡ |
| GST registrations, HSN/SAC, **dated rate periods** | ✅ | CORE | FINANCE | 🏆 |
| Purchase invoices + ITC register | ✅ | CORE | FINANCE | ⚡ |
| **Section 17(5) blocked-credit determination** | ✅ | CORE | FINANCE | 🏆 |
| GSTR-2B reconciliation & matching engine | 🟨 | GROWTH | FINANCE | ⚡ |
| TDS: deductees, cumulative thresholds, challans, certificates | 🟨 | CORE | FINANCE | ⚡ |
| Lower-deduction certificate tracking | 🟨 | GROWTH | FINANCE | 🏆 |
| **MSME §43B(h) 45-day payment exposure** | ✅ | CORE | FINANCE | 🏆 |
| Tally two-way sync (deterministic REMOTEID) | 🟨 | CORE | FINANCE | 🏆 |
| Receivables ageing (0-30/31-60/61-90/90+) | ✅ | CORE | FINANCE | ⚡ |
| Dunning ladders + demand notices in **six languages** | ✅ | GROWTH | FINANCE | 🏆 |
| Receipt allocation, bounce handling, re-application | 🟨 | CORE | FINANCE | ⚡ |
| Invoicing, multi-currency, recurring | ✅ | CORE | FINANCE | ≈ |
| Payment links (Razorpay / Stripe) | ✅ | CORE | FINANCE | ≈ |
| GSTR-1 / 3B filing reports | ⬜ | CORE | FINANCE | ⚠️ |
| e-Invoice (IRP) & e-Way bill | ⬜ | CORE | FINANCE | ⚠️ |
| Bank feed auto-reconciliation | ⬜ | GROWTH | FINANCE | ⚠️ |
| P&L / balance sheet / cash flow statements | 🟦 | CORE | FINANCE | ⚠️ |
| Multi-entity consolidation | ⬜ | SCALE | FINANCE | ⚠️ |

## 3. Construction & Projects

| Feature | Status | Tier | Persona | Position |
|---|:--:|---|---|:--:|
| BOQ with item master and rate analysis | 🟨 | PACK | SITE | ⚡ |
| BOQ variations & revisions | 🟨 | PACK | SITE | ⚡ |
| Measurement books (MB) | 🟨 | PACK | SITE | ⚡ |
| RA bills with deductions & certifications | 🟨 | PACK | SITE/FINANCE | ⚡ |
| Contractor advances & retention ledger | 🟨 | PACK | FINANCE | ⚡ |
| **Demand letters tied to construction stages** | ✅ | PACK | FINANCE | 🏆 |
| Programme / Gantt with critical path | ⬜ | PACK | SITE | ⚠️ |
| Quality checklists & NCR/CAPA | ⬜ | PACK | SITE | ⚠️ |
| Labour compliance registers | ⬜ | PACK | SITE | ⚠️ |
| Drawings register & revision control | ⬜ | PACK | SITE | ⚠️ |

## 4. Automation & Custom Objects

| Feature | Status | Tier | Persona | Position |
|---|:--:|---|---|:--:|
| Visual workflow builder — 6 triggers, 13 actions | ✅ | GROWTH | ADMIN | ≈ |
| Versioned workflows, draft/publish | ✅ | GROWTH | ADMIN | ⚡ |
| Approval steps with delegation & human-in-the-loop | ✅ | GROWTH | ADMIN | ≈ |
| Field-change triggers with old/new values | ✅ | GROWTH | ADMIN | ⚡ |
| **Runtime custom objects that cannot exist without RLS** | ✅ | GROWTH | ADMIN | 🏆 |
| Custom fields, saved views, generalised list/kanban | ✅ | CORE | ADMIN | ≈ |
| Change-data-capture log (old row, new row, columns) | ✅ | SCALE | ADMIN | ⚡ |
| Cross-module automation | 🟦 | GROWTH | ADMIN | ≈ |
| Sandboxed code steps | ⬜ | SCALE | ADMIN | ⚠️ |
| Workflow template gallery per industry | ⬜ | GROWTH | ADMIN | ⚠️ |

## 5. Platform, Security & Multi-tenancy

| Feature | Status | Tier | Persona | Position |
|---|:--:|---|---|:--:|
| **Row-level security, ENABLED and FORCED, 90 tables** | ✅ | CORE | — | 🏆 |
| **Composite foreign keys — cross-tenant references impossible** | ✅ | CORE | — | 🏆 |
| Append-only audit log, tamper-evident by trigger | ✅ | CORE | ADMIN | 🏆 |
| RBAC: custom roles, permissions, record scope | ✅ | CORE | ADMIN | ≈ |
| **Consented impersonation** — time-limited, bannered, audited | ✅ | SCALE | ADMIN | 🏆 |
| Per-tenant feature flags & quotas | ✅ | SCALE | ADMIN | ⚡ |
| Per-tenant theming from one accent token | ✅ | GROWTH | ADMIN | ≈ |
| Platform Observatory — cross-tenant health, MRR, churn siren | ✅ | — | ADMIN | 🏆 |
| Provisioning wizard with dry-run plan | ✅ | — | ADMIN | ⚡ |
| Tenant data export (full, self-serve) | 🟨 | GROWTH | ADMIN | ≈ |
| SSO — SAML/OIDC per tenant | 🟦 | SCALE | ADMIN | ⚠️ |
| Custom domains with automatic TLS | ⬜ | SCALE | ADMIN | ⚠️ |
| Field-level encryption | ⬜ | SCALE | ADMIN | ⚠️ |
| Public REST API + webhooks | ⬜ | SCALE | ADMIN | ⚠️ |

## 6. Customer & Partner Portals

| Feature | Status | Tier | Persona | Position |
|---|:--:|---|---|:--:|
| Tokenised external portal — no account needed | ✅ | GROWTH | CUSTOMER | ⚡ |
| Document sharing with expiry and revocation | ✅ | GROWTH | CUSTOMER | ≈ |
| Buyer statement of account | 🟨 | GROWTH | CUSTOMER | ⚡ |
| Channel-partner portal with payout tracking | 🟦 | PACK | PARTNER | ⚠️ |
| Vendor portal (PO acknowledgement, ASN) | ⬜ | GROWTH | PARTNER | ⚠️ |

## 7. Not started — named honestly

**Inventory & warehouse** (20) · **Procurement beyond invoices** (12) ·
**Manufacturing** (15) · **HR & payroll** (15) · **Orders & supply chain** (15) ·
**Marketing automation** (25) · **Ticketing & service desk** (25) ·
**Telephony** (15) · **Most AI** (22) · **9 of 10 industry packs** (72)

---

# PART 2 — Where Ordence wins

These are the claims worth putting in a pitch, because they are structural
rather than cosmetic — a competitor cannot add them in a sprint.

### 1. Isolation is enforced by the database, not the application

90 tables carry row-level security with **FORCE** enabled, plus composite
foreign keys `(id, tenant_id)` so a reference to another tenant's row cannot
be created even by raw SQL. Most multi-tenant SaaS filters by `tenant_id` in
application code — one missing `WHERE` clause away from a breach.

> **How to say it:** *"If our engineers write a bug, the database refuses the
> query. Ask any competitor whether that's true of theirs."*

### 2. Double-sale of a unit is physically impossible

A partial unique index enforces one live booking per unit, and a trigger with
`FOR UPDATE` locks the row. Two salespeople clicking simultaneously: one wins,
one gets a clear error. In systems that check availability in application code,
both succeed and it surfaces at registration.

### 3. GST rates are dated, not current

Rate periods use an exclusion constraint so two rates can never both be valid
for one code on one day. An invoice raised in March 2024 keeps March 2024's
rate for ever. Systems that store "current rate" silently restate history.

### 4. Section 17(5) and §43B(h) are first-class

Blocked input tax credit is shown as its own figure, never netted off. MSME
vendors past 45 days are flagged in red. Both are *tax consequences with no
visible symptom* until assessment — which is exactly when generic ERPs are
silent.

### 5. Money is integer paise, everywhere

Every amount is a `bigint` in paise, in strings across every boundary. No
float touches money at any point. Rates are basis points. A dashboard that
disagrees with the ledger by ₹0.03 destroys trust in both.

### 6. Support access is consented, time-limited and audited

An operator entering a customer's workspace requires recorded consent, expires
automatically, shows a banner to the customer throughout, and writes to the
customer's *own* audit log. Most vendors' support staff have silent god-mode.

### 7. Demand notices in six Indian languages

Tied to construction stages, generated from the receivables engine. A buyer in
Belagavi gets Kannada, not English.

### 8. Tally sync that survives re-runs

Deterministic REMOTEID means re-exporting a voucher updates it rather than
duplicating it. Anyone who has cleaned up a duplicated Tally ledger understands
why this is a feature.

---

# PART 3 — Where competitors are ahead

Written plainly, because a sales team that meets these unprepared loses on
them.

| Gap | Who has it | Impact | Plan |
|---|---|---|---|
| **Email sync** | Everyone | Severe — a CRM without the inbox is a database with opinions | Wave 3 |
| **Telephony + call recording** | Sell.Do, LeadSquared, Freshsales | Severe for Indian pre-sales teams | Wave 5 |
| **WhatsApp Business inbox** | LeadSquared, Zoho, Sell.Do | Severe — it *is* the channel in India | Wave 4 |
| **Portal lead ingestion** (99acres, MagicBricks) | Sell.Do, In4Velocity | High — where the leads come from | Wave 4 |
| **e-Invoice / e-Way bill** | Tally, Zoho Books, ClearTax | High — statutory above ₹5 crore turnover | Wave 3 |
| **GSTR-1 / 3B filing** | Tally, ClearTax, Zoho | High | Wave 3 |
| **Payroll** | Zoho, greytHR, Keka | Medium — usually a separate purchase anyway | Wave 6 |
| **Mobile app** | Everyone | Medium-high for site teams | Wave 5 |
| **Public API / marketplace** | Zoho, Salesforce, Odoo | Medium — blocks integrations | Wave 3 |
| **Inventory & manufacturing** | Odoo, SAP B1, ERPNext | Low for real estate, blocking for retail/manufacturing packs | Wave 6 |

---

# PART 4 — Head to head

> ⚠️ **Verify before publishing.** Competitor feature sets and pricing change
> constantly. Treat this as internal positioning, and re-check any specific
> claim before it goes into a proposal or on the website.

## Against Indian real-estate CRMs — Sell.Do, LeadSquared, CRMNEXT

| | Ordence | Them |
|---|---|---|
| Lead → booking → inventory | ✅ | ✅ |
| Channel partner commissions | ✅ with TDS | Usually manual |
| Telephony & WhatsApp | ⚠️ Not yet | ✅ Strong |
| Portal lead ingestion | ⚠️ Not yet | ✅ |
| **Accounting** | ✅ Full double-entry ledger | ❌ None — exports to Tally |
| **GST / TDS / ITC** | ✅ Native | ❌ None |
| **Construction (BOQ, RA bills)** | ✅ | ❌ None |
| Data isolation | Database-enforced | Application-enforced |

**Where we win:** they stop at the booking. Everything after — collections,
tax, construction billing — happens in a different system.
**Where we lose today:** the pre-sales calling stack.

## Against Indian real-estate ERPs — In4Velocity, Farvision, Highrise

| | Ordence | Them |
|---|---|---|
| Real-estate ERP depth | ✅ Growing | ✅ Mature, decades of it |
| CRM quality | ✅ Modern | ⚠️ Usually dated |
| Deployment | Cloud-native, multi-tenant | Often on-premise or hosted single-tenant |
| Implementation time | Days | Months |
| Per-tenant customisation | Runtime custom objects | Consulting engagement |
| Pricing | SaaS subscription | Licence + AMC + implementation |
| Modern UX | ✅ | ⚠️ |

**Where we win:** time to value, and a CRM people actually want to open.
**Where we lose today:** twenty years of edge cases in their construction modules.

## Against horizontal suites — Zoho One, Odoo, SAP B1, Dynamics 365

| | Ordence | Them |
|---|---|---|
| Breadth of modules | ⚠️ Narrower | ✅ Vast |
| Real-estate fit out of the box | ✅ Native | ❌ Needs heavy customisation |
| India tax depth | ✅ Native | ✅ Zoho yes · Odoo/SAP need localisation partners |
| App ecosystem | ⚠️ None yet | ✅ Large |
| Cost at 25 users | Lower | Higher, especially SAP/Dynamics |
| Customisation model | Runtime, self-serve | Developer or partner required |

**Where we win:** a developer buying Odoo spends six months and a partner fee
turning it into a real-estate system. Ours arrives that way.
**Where we lose today:** breadth, ecosystem, and the safety of a household name.

## Against Tally

Not a competitor — **an integration**. Tally is the statutory book of record in
most Indian SMEs and will remain so. Ordence syncs to it with deterministic
IDs. The pitch is never "replace Tally"; it is *"stop typing into Tally twice."*

---

# PART 5 — Packaging

| | **Core** | **Growth** | **Scale** |
|---|---|---|---|
| Users | up to 5 | up to 25 | unlimited |
| CRM pipeline & inventory | ✅ | ✅ | ✅ |
| Accounting, GST, TDS | ✅ | ✅ | ✅ |
| Receivables & dunning | basic | ✅ full | ✅ full |
| Workflow automation | — | ✅ | ✅ |
| Custom objects & fields | fields only | ✅ | ✅ |
| Customer & partner portals | — | ✅ | ✅ |
| Construction pack (BOQ/RA) | — | add-on | ✅ |
| SSO, API, multi-entity | — | — | ✅ |
| Consented support access | ✅ | ✅ | ✅ |
| Audit log & data export | ✅ | ✅ | ✅ |

**Industry packs** are licensed per pack: Real Estate (live), then Agencies,
Education, Legal, Financial Services, Healthcare, Hospitality, Retail,
Manufacturing, Logistics.

---

# PART 6 — Roadmap by wave

| Wave | Contents | Unlocks |
|---|---|---|
| **1** | Screens for finished engines: GST ✅, purchases ✅, receivables ✅, GSTR-2B, TDS, Tally, financial statements | ~11 modules become visible |
| **2** | Master admin: Observatory ✅, provisioning ✅, command grid | Operating the fleet at scale |
| **3** | Order object · inventory · API keys + public API · **email sync** | ~60 downstream features |
| **4** | Forms & landing pages · the six web-dev cross-sell moments · agency mode | The revenue surfaces |
| **5** | Ticketing & service desk · one telephony adapter · mobile PWA | ~40 features |
| **6** | AI: privacy boundary → human-approval gate → explainability → assistant | ~22 features, in that order |
| **7** | Industry packs, Agencies first (dogfooding), then Education | 72 features |

---

## The honest headline

**35 of 500 features live · 77 more within reach of a surface or a wiring job ·
388 not started.**

What exists is the hard, unglamorous half: tenant isolation, the ledger, the
tax engines, the workflow engine — the parts that are expensive to retrofit
and dangerous to get wrong. What remains is mostly surface area, which is
faster to build and safer to be wrong about.

That is the right order to have built them in, and it is the argument for why
this becomes a serious product rather than another CRM with a nice pipeline
view.
