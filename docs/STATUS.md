# Ordence — Status

**Version:** v0.31.0-alpha · 1 August 2026
**Tests:** 737 backend + 682 UI = **1,419 passing** (361 this morning)
**Security verifier:** all checks pass

---

## Wave A — COMPLETE

Every engine we had built was invisible. All three now have doors.

| Phase | Delivered |
|---|---|
| **26** | **Workflow builder** — visual step editor, trigger/action pickers driven from the engine's own catalogue, run history showing which step failed, approvals inbox. Publishing states plainly that it lends your identity to every future run |
| **27** | **Custom object designer** — create record types and fields from the UI, generated forms and detail pages. Dropping a table demands the exact live record count typed back |
| **28** | **Saved views everywhere** — wired onto leads, inventory, bookings, partners, contacts, companies. Additive: every page works exactly as before until a view is chosen. Calendar view built |
| **29** | **Admin console** — workspace directory with MRR and health, 8-tab tenant detail, consented time-limited impersonation, feature flags, action register |
| **31** | **Deploy hardening** — `docs/DEPLOY-CHECKLIST.md`, written for a non-technical reader, with a STOP gate |

### Three real defects found while finishing

1. ⭐ **Impersonation was inert.** The whole consent-and-audit system existed and did nothing — a session resolved to no tenant, and every action during one was unattributable. The DELETE guard installed in Phase 17 had never been armed. Now wired end to end, with tests proving an action inside a session carries the session id and one outside does not.
2. ⭐ **A support engineer could have granted themselves standing consent.** Landing the impersonation bridge removed an accidental protection: an operator with a one-hour session could have written a 90-day consent, with the audit trail showing the *customer* granting it. Gated and regression-tested.
3. ⭐ **CI never applied SQL files 0017–0022.** Tests passed because `drizzle-kit push` created the tables, but their security policies were absent. Separately, CI ran the blanket GRANT *after* the revokes, silently handing back `UPDATE on plans` — a tenant could have repriced their own subscription. Both fixed and proven from an empty database.

---

## Wave B — started

**Phase 32 — GST foundation** is built (60 tests). GSTIN registry with checksum validation, HSN/SAC masters, place-of-supply engine, tax computation reconciling exactly to the invoice total.

⭐ **The central design point:** GST rates change by notification, so rates are *dated*. A 2018 invoice keeps 12% when the master moves to 5% — enforced by four independent database defences, not by convention.

⭐ **For immovable property the place of supply is the location of the property**, not the recipient's address (Sec 12(3), IGST Act). That is the rule everyone gets wrong and it is the one that matters most for a real-estate company.

**Next:** purchase invoices → GSTR-2B reconciliation → GSTR-1/3B → TDS → Tally.

---

## Where the product stands

**64+ tables · 57+ policies · 38 composite foreign keys · 1,419 tests**

Built: foundation, CRM, contracts, accounting, portal, billing, entitlements, seats, metering, invoicing, telemetry, SecOps, backup, sales pipeline & inventory, workflow engine, runtime custom objects, saved views, admin console, GST foundation — plus a fully offline desktop build running the identical schema.

---

## Still outstanding

- **Phase 30 — desktop UI.** The offline app ships a working shell, not the full interface. Two specific blockers documented, adapters written.
- **Customer-facing consent page** — operators can request access; customers approve by manual SQL until it ships.
- `/sales/partners/[id]` and `/deals` routes referenced by navigation but never built.
- **Wave B remainder** (9 phases), **Wave C** construction (8), **Wave D** AI+MCP (6), **Waves E–F** (15).

---

## Before you serve real customers

Read `docs/DEPLOY-CHECKLIST.md`. The STOP gate is not decorative — one of the defects above meant a customer could have repriced their own subscription to zero.
