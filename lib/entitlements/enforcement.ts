/**
 * Ordence — The Declared-vs-Enforced Ledger
 * Version: v1.52.0-alpha (Batch 55)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE PATTERN THIS FILE EXISTS TO STOP HAPPENING A FOURTH TIME.
 * ══════════════════════════════════════════════════════════════════════
 * Three times now a control has been found DECLARED AND ENFORCED BY
 * NOTHING: batch 43's approval policies, batch 136's `requireMfa` and idle
 * timeout, and a settings form that wrote a value no code ever read. Each
 * time, a customer believed a limit existed and it did not. Each time it
 * was found by hand, months later, by somebody grepping.
 *
 * `FEATURE_CATALOG` currently declares 71 keys. 37 of them are read at
 * a server-side decision point. 34 are read by NOTHING — they appear on
 * a plan matrix, they price a tier, and no code anywhere asks about them.
 *
 * That is not automatically a bug. Most of those 34 name a module that
 * has not been built, and a gate on a feature that does not exist is dead
 * code. Some are baseline on every tier, where a gate could never refuse.
 * ONE of them — `analytics.export` — must never be gated at all.
 *
 * ⭐ WHAT IS A BUG IS NOT KNOWING WHICH IS WHICH. So the status is DATA
 * here, one entry per catalogue key, and `tests/ui/entitlement-enforcement.test.ts`
 * checks both directions against the actual source tree:
 *
 *   • a key marked `gated` with no gate in `server/` FAILS the test — this
 *     is the "declared and enforced by nothing" case, caught the day it
 *     appears rather than in an audit two quarters later;
 *   • a key marked `declared_only` that HAS grown a gate FAILS too, which
 *     forces whoever built the module to come back here and say so.
 *
 * Adding a key to `FEATURE_CATALOG` without adding it here also fails.
 * There is no way to introduce a silently unenforced entitlement.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ `hr.payroll` IS BUILT AND IS DELIBERATELY NOT GATED.
 * ══════════════════════════════════════════════════════════════════════
 * `server/actions/payroll.ts` is real, complete, and asks no entitlement
 * question. That is a decision, not an omission: a plan change mid-month
 * would otherwise strand a half-finished salary run with PF, ESI and TDS
 * already computed against it, and the deadline for those does not move
 * because a subscription did. If payroll is ever to become a paid module,
 * the gate belongs on CREATING a run — never on approving or posting one
 * that already exists. See the statutory exemptions in `lib/billing/grace.ts`.
 */

import { FEATURE_KEYS, type FeatureKey } from "./features";

/**
 * `gated`        — read by `requireFeature()` or a guard descriptor at a
 *                  server-side decision point. The limit is real.
 * `declared_only` — priced and displayed; no code asks. Each one carries
 *                  the reason it is acceptable, or it does not belong here.
 */
export const ENFORCEMENT_STATUSES = ["gated", "declared_only"] as const;
export type EnforcementStatus = (typeof ENFORCEMENT_STATUSES)[number];

export const FEATURE_ENFORCEMENT: Readonly<Record<FeatureKey, EnforcementStatus>> =
  Object.freeze({
  "accounting.ledger": "gated",
  "accounting.period_close": "gated",
  "accounting.tally": "gated",
  "clm.esignature": "gated",
  "compliance.calendar": "gated",
  "compliance.licences": "gated",
  "construction.boq": "gated",
  "construction.ra_bills": "gated",
  "crm.bulk_import": "gated",
  "crm.custom_objects": "gated",
  "field.jobs": "gated",
  "gst.gstr2b": "gated",
  "gst.rate_master": "gated",
  "gst.registry": "gated",
  "gst.tax_invoice": "gated",
  "inventory.stock": "gated",
  "land.title": "gated",
  "metering.readings": "gated",
  "portal.external_links": "gated",
  "purchases.invoices": "gated",
  "purchases.itc": "gated",
  "purchases.vendor_ledger": "gated",
  "rates.cards": "gated",
  "sales.bookings": "gated",
  "sales.brokerage": "gated",
  "sales.channel_partners": "gated",
  "sales.inventory": "gated",
  "sales.payment_plans": "gated",
  "sales.pipeline": "gated",
  "sales.receivables": "gated",
  "scheduling.resources": "gated",
  "storage.documents": "gated",
  "tds.deductions": "gated",
  "views.saved": "gated",
  "views.shared": "gated",
  "workflows.builder": "gated",
  "workflows.webhooks": "gated",

  /** baseline on every tier — there is no plan on which a gate could refuse, so a gate would be dead code */
  "crm.contacts": "declared_only",
  /** baseline on every tier, same as crm.contacts */
  "crm.companies": "declared_only",
  /** baseline on every tier, same as crm.contacts */
  "crm.deals": "declared_only",
  /** declared in the catalogue; the feature itself is not built yet, so there is no decision point to gate */
  "scheduling.capacity": "declared_only",
  /** declared in the catalogue; the feature itself is not built yet, so there is no decision point to gate */
  "rates.dynamic": "declared_only",
  /** declared in the catalogue; the feature itself is not built yet, so there is no decision point to gate */
  "field.offline": "declared_only",
  /** declared in the catalogue; the feature itself is not built yet, so there is no decision point to gate */
  "compliance.client_book": "declared_only",
  /** declared in the catalogue; the feature itself is not built yet, so there is no decision point to gate */
  "metering.net_settlement": "declared_only",
  /** declared in the catalogue; the feature itself is not built yet, so there is no decision point to gate */
  "timesheets.entry": "declared_only",
  /** 🔴 BUILT AND UNGATED ON PURPOSE — see the note below */
  "hr.payroll": "declared_only",
  /** declared in the catalogue; the feature itself is not built yet, so there is no decision point to gate */
  "timesheets.utilisation": "declared_only",
  /** declared in the catalogue; the feature itself is not built yet, so there is no decision point to gate */
  "vault.sensitive": "declared_only",
  /** declared in the catalogue; the feature itself is not built yet, so there is no decision point to gate */
  "sales.orders": "declared_only",
  /** declared in the catalogue; the feature itself is not built yet, so there is no decision point to gate */
  "sales.fulfilment": "declared_only",
  /** declared in the catalogue; the feature itself is not built yet, so there is no decision point to gate */
  "inventory.traceability": "declared_only",
  /** declared in the catalogue; the feature itself is not built yet, so there is no decision point to gate */
  "land.approvals": "declared_only",
  /** declared in the catalogue; the feature itself is not built yet, so there is no decision point to gate */
  "workflows.scheduled": "declared_only",
  /** declared in the catalogue; the feature itself is not built yet, so there is no decision point to gate */
  "workflows.http_request": "declared_only",
  /** declared in the catalogue; the feature itself is not built yet, so there is no decision point to gate */
  "assets.catalog": "declared_only",
  /** declared in the catalogue; the feature itself is not built yet, so there is no decision point to gate */
  "assets.relationships": "declared_only",
  /** declared in the catalogue; the feature itself is not built yet, so there is no decision point to gate */
  "clm.contracts": "declared_only",
  /** declared in the catalogue; the feature itself is not built yet, so there is no decision point to gate */
  "clm.document_assembly": "declared_only",
  /** declared in the catalogue; the feature itself is not built yet, so there is no decision point to gate */
  "clm.clause_library": "declared_only",
  /** declared in the catalogue; the feature itself is not built yet, so there is no decision point to gate */
  "email.transactional": "declared_only",
  /** declared in the catalogue; the feature itself is not built yet, so there is no decision point to gate */
  "analytics.dashboard": "declared_only",
  /** 🔴 NEVER GATE — exporting your own data is not a paid feature. See lib/billing/access-state.ts */
  "analytics.export": "declared_only",
  /** declared in the catalogue; the feature itself is not built yet, so there is no decision point to gate */
  "admin.custom_roles": "declared_only",
  /** baseline on every tier; the audit trail is a compliance guarantee, not an upsell */
  "admin.audit_log": "declared_only",
  /** declared in the catalogue; the feature itself is not built yet, so there is no decision point to gate */
  "admin.api_access": "declared_only",
  /** declared in the catalogue; the feature itself is not built yet, so there is no decision point to gate */
  "admin.white_label": "declared_only",
  /** declared in the catalogue; the feature itself is not built yet, so there is no decision point to gate */
  "admin.sso": "declared_only",
  /** declared in the catalogue; the feature itself is not built yet, so there is no decision point to gate */
  "admin.data_residency": "declared_only",
  /** declared in the catalogue; the feature itself is not built yet, so there is no decision point to gate */
  "ai.copilot": "declared_only",
  /** declared in the catalogue; the feature itself is not built yet, so there is no decision point to gate */
  "ai.rag": "declared_only",
  });

/** Keys a customer could be charged for that nothing refuses. */
export function unenforcedFeatures(): FeatureKey[] {
  return FEATURE_KEYS.filter((k) => FEATURE_ENFORCEMENT[k] === "declared_only");
}

export function enforcedFeatures(): FeatureKey[] {
  return FEATURE_KEYS.filter((k) => FEATURE_ENFORCEMENT[k] === "gated");
}

/**
 * ⚠️ Returns `true` for a key that is not in the ledger at all, so a new
 * catalogue entry defaults to "nobody has decided yet" rather than to a
 * confident and wrong "this is enforced".
 */
export function isDeclaredOnly(feature: FeatureKey): boolean {
  return FEATURE_ENFORCEMENT[feature] !== "gated";
}
