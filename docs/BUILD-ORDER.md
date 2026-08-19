# Ordence — build order

**Derived from `FEATURE-MAP-500.md`, not from enthusiasm.**

The audit says 35 built, 77 partial, 388 not started. Building 388 features in
catalogue order would be the wrong move, because the catalogue is grouped by
*theme* and the code is blocked by *dependency*. A dozen features are keystones:
each one unlocks between eight and twenty-five others, and until it exists those
others cannot be built at all.

This document orders the work by how much it unblocks.

---

## The keystones, ranked by what they release

| Keystone | Unlocks | Why it comes first |
|---|---|---|
| **Order object (371)** | 372–385, 169, retail + logistics packs | ~20 features. There is no `orders` table. Quotes cannot become invoices, nothing can ship, no pack that sells physical goods can exist. |
| **Email sync (56)** | 57–69, 138, 145, 172 | ~16 features. A CRM without the inbox is a database with opinions. Also the precondition for "auto-log everything". |
| **Inventory (251–252)** | 253–270, 372, retail + manufacturing packs | ~25 features. `units` is real-estate inventory; goods inventory is a different model entirely. |
| **Scoped API keys (410) → REST API (411)** | 412, 414, 416, 417, 418, 419 | ~7 features, and every future integration. `change_log` is already a change-data-capture feed with nowhere to go. |
| **Ticketing (171)** | 172–195 | ~24 features. An entire absent module. |
| **Telephony adapter (88)** | 76–90 | ~14 features from one integration. Exotel first for India. |
| **AI foundation (154, 155, 131)** | 132–153 | ~22 features. Build the privacy boundary and the human-approval gate *with* the first agent, never after. |
| **Custom domains + TLS (387)** | 400, agency mode, every tenant go-live | Nobody can launch on their own domain without it. |

---

## Wave 1 — Make what exists usable (2–3 weeks)

Nothing new. Surfaces for engines that are built, tested, and currently invisible.

The backends for GST, purchases, GSTR-2B, TDS, Tally and receivables are all
finished and have **no screens at all**. That is the single largest gap between
what Ordence can do and what a customer can see.

1. **GST screens** — registrations, HSN/SAC rates, returns *(schema built)*
2. **Purchases screens** — vendors, purchase invoices, ITC register *(built)*
3. **GSTR-2B reconciliation screen** — the matching engine has no UI *(built)*
4. **TDS screens** — deductees, deductions, certificates, challans *(built)*
5. **Tally screens** — connections, mappings, export batches *(built)*
6. **Receivables screens** — dunning policies, demand notices, receipts *(built)*
7. **`/sales/partners/[id]` and `/deals`** — routes the navigation links to and that do not exist
8. **Financial statements renderer** — P&L, balance sheet, cash flow off the existing ledger

> This wave adds roughly nothing to the feature count and roughly everything to
> the product. Eleven built modules become visible.

## Wave 2 — The admin panel (the three you called crucial)

1. **Tenant Command Grid** — one row per tenant: domain, TLS, plan, MRR, last-active, error rate, quota; per-row impersonate / suspend / upgrade / toggle / purge
2. **Provisioning & Domain Automation** — one screen: create → seed industry pack → subdomain live → custom-domain DNS + TLS → welcome email. Plus bulk ops and dry-run
3. **Platform Health & Revenue Observatory** — per-tenant requests/errors/latency, free-tier burn-down, feature-adoption heatmap, cohort retention, churn siren at 14 days silent

*Built against `platformStaff`, `platformTenantFlags`, `platformActionLog`,
`usageCounters`, `usageLevels`, `errorEvents`, `webVitalEvents` — all of which
already exist.*

## Wave 3 — The keystones

Order object · Inventory · API keys + REST API · Email sync

## Wave 4 — Revenue surfaces

Forms and landing pages (93, 92) · the six web-dev cross-sell moments ·
Website packages tab · agency mode (400)

## Wave 5 — Service and telephony

Ticketing (171–195) · one telephony adapter (76–90)

## Wave 6 — AI, done in the right order

154 privacy boundary → 155 human-approval gate → 153 explainability →
then 131 assistant → then the rest

## Wave 7 — Industry packs

**Agencies & Studios first (493–500)** — you are the first customer of that pack,
and dogfooding it de-risks the web-dev arm before an outside tenant sees it.
Then Education (437–444), which is closest to the existing engines: the admission
funnel *is* the lead pipeline and fee plans *are* the payment-milestone engine.

---

## What I would not build yet, and why

- **Manufacturing (286–300)** — fifteen features, no adjacent code, and no customer asking. It is a product in its own right.
- **Sandboxed code steps (220)** — arbitrary tenant code inside a shared Worker needs an isolation design before an implementation.
- **Cross-tenant benchmarks (209)** — technically easy, and exactly the feature that turns into a privacy incident if the consent gate is added afterwards.
- **Petty cash (322)** — you asked to have a conversation about this one before it gets built. Still waiting on that, deliberately.

---

## The honest headline

**35 of 500 built. 77 more within reach of a surface or a wiring job.**

Waves 1 and 2 alone move roughly 60 features from invisible to usable without
inventing anything new — because the expensive, dangerous parts (tenant
isolation, the ledger, the tax engines, the workflow engine) are already done
and tested.
