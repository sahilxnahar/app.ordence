/**
 * Ordence — The Declared-vs-Enforced Ledger
 * Version: v1.68.0-alpha (Batch 0109) · first written v1.52.0-alpha (Batch 55)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE PATTERN THIS FILE EXISTS TO STOP HAPPENING AGAIN.
 * ══════════════════════════════════════════════════════════════════════
 * Repeatedly a control has been found DECLARED AND ENFORCED BY NOTHING:
 * batch 43's approval policies, batch 136's `requireMfa` and idle
 * timeout, a settings form that wrote a value no code ever read, a
 * depreciation engine no navigation reached for four batches. Each time,
 * a customer believed a limit existed and it did not. Each time it was
 * found by hand, months later, by somebody grepping.
 *
 * `FEATURE_CATALOG` declares 71 keys. This file records, for every one of
 * them, whether any server-side decision point actually asks — and
 * `tests/ui/entitlement-enforcement.test.ts` checks both directions
 * against the actual source tree:
 *
 *   • a key marked `gated` with no gate in `server/` or `app/` FAILS;
 *   • a key marked `declared_only` that HAS grown a gate FAILS too,
 *     which forces whoever built the module to come back here and say so.
 *
 * Adding a key to `FEATURE_CATALOG` without adding it here also fails.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 WHAT BATCH 0109 FOUND, AND IT WAS THE LEDGER ITSELF
 * ══════════════════════════════════════════════════════════════════════
 * Five keys were recorded here as `declared_only` with the reason "the
 * feature itself is not built yet", and all five were being refused by
 * live server code at the time it was written:
 *
 *   `sales.orders`           22 write sites across orders, invoices and
 *                            credit, through `guardSalesWrite`
 *   `sales.fulfilment`        2 write sites in `orders.ts`
 *   `workflows.scheduled`  ┐  all three passed to `requireFeature()` in
 *   `workflows.http_request`│  a loop at workflow publish time
 *   `email.transactional`  ┘  (`featuresFor()` in workflows/definitions)
 *
 * ⚠️ THE TEST DID NOT CATCH IT BECAUSE THE TEST COULD NOT SEE THEM. Its
 * matcher recognised six literal SPELLINGS of a gate. A key held in a
 * module constant named anything other than exactly `FEATURE`, or
 * collected into a set and passed to `requireFeature` in a loop, is
 * invisible to all six — so the ledger drifted in the direction nobody
 * was watching, and "declared_only" quietly stopped meaning anything.
 *
 * ⭐ THE FIX IS IN THREE PARTS AND THE THIRD ONE IS THE LOAD-BEARING ONE:
 *   1. the matcher now resolves module constants and set-collection;
 *   2. `ENFORCEMENT_EVIDENCE` below names the FILE for every gated key,
 *      and the test opens it — a ledger that says where is a ledger that
 *      can be checked;
 *   3. 🔴 a `declared_only` key may not appear as a string literal
 *      anywhere under `server/` or `app/` AT ALL. That check needs no
 *      knowledge of how a gate is spelled, so it cannot be defeated by
 *      the next spelling somebody invents. It would have caught all five.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ `hr.payroll` IS NOW GATED, AND NOT WITH `requireFeature`
 * ══════════════════════════════════════════════════════════════════════
 * The previous version of this file recorded payroll as deliberately
 * ungated, on the grounds that a plan change mid-month would strand a
 * half-finished salary run. That reasoning was right and the conclusion
 * was too broad: it made the whole module free on every tier, including
 * the free one, for a line item priced at Advanced.
 *
 * `server/payroll/entitlement.ts` keeps the reasoning and narrows the
 * conclusion. It evaluates the CONTRACTED tier rather than the
 * lapse-adjusted one, so a paying Advanced workspace whose card failed on
 * the 5th still runs payroll due on the 7th; and it sits on the writes
 * that START a commitment, never on approving or posting a run that
 * already exists. Read that file before changing this line.
 */

import { FEATURE_KEYS, type FeatureKey } from "./features";

/**
 * `gated`         — read by `requireFeature()` or a guard descriptor at a
 *                   server-side decision point. The limit is real.
 * `declared_only` — priced and displayed; no code asks. Each one carries
 *                   the reason it is acceptable, or it does not belong here.
 */
export const ENFORCEMENT_STATUSES = ["gated", "declared_only"] as const;
export type EnforcementStatus = (typeof ENFORCEMENT_STATUSES)[number];

export const FEATURE_ENFORCEMENT: Readonly<Record<FeatureKey, EnforcementStatus>> =
  Object.freeze({
  "accounting.ledger": "gated",
  "accounting.period_close": "gated",
  "accounting.tally": "gated",
  "assets.catalog": "gated",
  "ai.copilot": "gated",
  "ai.rag": "gated",
  "clm.contracts": "gated",
  "clm.document_assembly": "gated",
  "clm.esignature": "gated",
  "compliance.calendar": "gated",
  "compliance.licences": "gated",
  /**
   * ⭐ WAVE 7. Gated at the action, not only in the navigation.
   *
   * 🔴 `tsc` REFUSED THE WAVE UNTIL THIS LINE EXISTED, which is the whole
   * point of the `Record<FeatureKey, ...>` shape: a feature added to the
   * catalogue and not to this map is a feature nothing gates, and the
   * customer on the tier that does not include it sees a menu and a
   * screen that works.
   */
  "construction.drawings": "gated",
  "construction.boq": "gated",
  "construction.ra_bills": "gated",
  "crm.bulk_import": "gated",
  "crm.custom_objects": "gated",
  "email.transactional": "gated",
  "field.jobs": "gated",
  "gst.gstr2b": "gated",
  "gst.rate_master": "gated",
  "gst.registry": "gated",
  "gst.tax_invoice": "gated",
  "hr.payroll": "gated",
  "inventory.stock": "gated",
  "inventory.traceability": "gated",
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
  "sales.fulfilment": "gated",
  "sales.inventory": "gated",
  "sales.orders": "gated",
  "sales.payment_plans": "gated",
  "sales.pipeline": "gated",
  "sales.receivables": "gated",
  "scheduling.resources": "gated",
  "storage.documents": "gated",
  "tds.deductions": "gated",
  "views.saved": "gated",
  "views.shared": "gated",
  "workflows.builder": "gated",
  "workflows.http_request": "gated",
  "workflows.scheduled": "gated",
  "workflows.webhooks": "gated",

  /**
   * ⭐ GATED SINCE BRIEF C LANDED, BY THE SCHEDULER RATHER THAN BY A
   * SCREEN — and this is the first key in this ledger whose only gate is
   * unattended.
   *
   * It is baseline on every tier, so the note this entry used to carry
   * ("a gate could never refuse") was correct about every INTERACTIVE
   * path and will stay correct. The nightly `rhythms` job in
   * `server/scheduling/registry.ts` is different: it is compute we
   * perform on a workspace's behalf while nobody is looking, and a
   * lapsed subscription, or a platform override recorded with a reason,
   * is exactly the case where it should stop.
   *
   * ⚠️ READS ARE UNTOUCHED. The `/rhythms` board keeps showing the last
   * figures computed. A gate that blanked the screen would look like
   * data loss; one that stops recomputing looks like what it is.
   */
  "crm.contacts": "gated",

  /* --- and the twenty-one that nothing refuses ------------------- */
  "crm.companies": "declared_only",
  "crm.deals": "declared_only",
  "scheduling.capacity": "declared_only",
  "rates.dynamic": "declared_only",
  "field.offline": "declared_only",
  "compliance.client_book": "declared_only",
  "metering.net_settlement": "declared_only",
  "timesheets.entry": "declared_only",
  "timesheets.utilisation": "declared_only",
  "vault.sensitive": "declared_only",
  "land.approvals": "declared_only",
  "assets.relationships": "declared_only",
  "clm.clause_library": "declared_only",
  "analytics.dashboard": "declared_only",
  "analytics.export": "declared_only",
  "admin.custom_roles": "declared_only",
  "admin.audit_log": "declared_only",
  "admin.api_access": "declared_only",
  "admin.white_label": "declared_only",
  "admin.sso": "declared_only",
  "admin.data_residency": "declared_only",
  });

/* ------------------------------------------------------------------ */
/* ⭐ THE EVIDENCE — Batch 0109                                         */
/* ------------------------------------------------------------------ */

/**
 * 🔴 WHY THE STATUS ALONE WAS NOT ENOUGH.
 *
 * "gated" is a claim. Until this batch it was a claim nothing could
 * check beyond a text search over the whole tree, which is how five
 * wrong entries survived. So every entry now carries EVIDENCE, and the
 * two kinds of evidence are different in kind:
 *
 *   • a `gated` key names the FILE its gate lives in. The test opens
 *     that file and fails if the key is not in it. A gate that is moved
 *     or deleted breaks the build in the same commit rather than in an
 *     audit two quarters later.
 *
 *   • a `declared_only` key states WHY nothing refuses it, in a sentence
 *     somebody has actually thought about. The generic "not built yet"
 *     that thirty entries shared was worse than no reason at all: it
 *     read as considered and was not, and it was wrong for five of them.
 *
 * ⚠️ WHERE A KEY IS GATED IN MORE THAN ONE FILE, THIS NAMES ONE — the
 * one to read first. It is a starting point for a person, not an
 * inventory; an inventory would go stale and quietly become another
 * thing that is declared and checked by nothing.
 */
export const ENFORCEMENT_EVIDENCE: Readonly<Record<FeatureKey, string>> =
  Object.freeze({
  /* ---- gated: the file to read ---------------------------------- */
  "accounting.ledger": "server/actions/accounting.ts",
  "accounting.period_close": "server/actions/periods.ts",
  "accounting.tally": "server/actions/tally.ts",
  "assets.catalog": "server/actions/assets.ts",
  "ai.copilot": "app/api/assistant/route.ts",
  "ai.rag": "server/mcp/dispatch.ts",
  "clm.contracts": "server/actions/documents.ts",
  "clm.document_assembly": "server/actions/documents.ts",
  "clm.esignature": "server/actions/contracts.ts",
  "compliance.calendar": "server/actions/compliance.ts",
  "compliance.licences": "server/actions/compliance.ts",
  "construction.drawings": "server/actions/drawings.ts",
  "construction.boq": "server/actions/construction.ts",
  "construction.ra_bills": "server/actions/ra-bills.ts",
  "crm.bulk_import": "server/actions/import.ts",
  "crm.custom_objects": "server/actions/custom-objects.ts",
  /**
   * ⚠️ THE ONLY EVIDENCE FILE HERE THAT NO BROWSER EVER REACHES.
   * The gate is on the nightly `rhythms` job, not on a screen, so
   * grepping `app/` for this key will find nothing and that is
   * correct. See the note on the status above.
   */
  "crm.contacts": "server/scheduling/registry.ts",
  "email.transactional": "server/workflows/definitions.ts",
  "field.jobs": "server/actions/field-ops.ts",
  "gst.gstr2b": "server/actions/gstr2b.ts",
  "gst.rate_master": "server/actions/gst.ts",
  "gst.registry": "server/actions/gst.ts",
  "gst.tax_invoice": "server/actions/gst.ts",
  "hr.payroll": "server/payroll/entitlement.ts",
  "inventory.stock": "server/actions/inventory.ts",
  "inventory.traceability": "server/actions/batches.ts",
  "land.title": "server/actions/land.ts",
  "metering.readings": "server/actions/metering.ts",
  "portal.external_links": "server/actions/portal.ts",
  "purchases.invoices": "server/actions/purchases.ts",
  "purchases.itc": "server/actions/purchases.ts",
  "purchases.vendor_ledger": "server/actions/purchases.ts",
  "rates.cards": "server/actions/rates.ts",
  "sales.bookings": "server/actions/sales-bookings.ts",
  "sales.brokerage": "server/actions/sales-brokerage.ts",
  "sales.channel_partners": "server/actions/sales-partners.ts",
  "sales.fulfilment": "server/actions/orders.ts",
  "sales.inventory": "server/actions/sales-inventory.ts",
  "sales.orders": "server/actions/orders.ts",
  "sales.payment_plans": "server/actions/sales-bookings.ts",
  "sales.pipeline": "server/actions/sales-leads.ts",
  "sales.receivables": "server/actions/receivables.ts",
  "scheduling.resources": "server/actions/scheduling.ts",
  "storage.documents": "server/actions/storage.ts",
  "tds.deductions": "server/actions/tds.ts",
  "views.saved": "server/views/definitions.ts",
  "views.shared": "server/views/definitions.ts",
  "workflows.builder": "server/actions/workflows.ts",
  "workflows.http_request": "server/workflows/definitions.ts",
  "workflows.scheduled": "server/workflows/definitions.ts",
  "workflows.webhooks": "server/actions/workflows.ts",

  /* ---- declared_only: why nothing refuses ----------------------- */

  /**
   * ⚠️ THE THREE CRM BASELINES ARE NOT AS SAFE AS THE OLD REASON SAID.
   *
   * The previous wording was "baseline on every tier — there is no plan
   * on which a gate could refuse, so a gate would be dead code". The
   * first half is true: `minTier` is `basic`, every workspace resolves to
   * at least `basic` (trial rises to advanced, a lapsed one falls to
   * basic), so no TIER comparison can ever refuse these.
   *
   * 🔴 THE SECOND HALF STOPPED BEING TRUE WHEN OVERRIDES SHIPPED IN
   * v0.43.0. `evaluateFeature` checks the per-tenant override BEFORE the
   * tier, so a revoke on `crm.contacts` would refuse — and the module
   * switchboard in the admin console offers exactly that switch. Nothing
   * reads it. An operator can revoke contacts for a workspace today, the
   * console will report success, and every contact screen will carry on
   * working.
   *
   * That is left as it is rather than fixed here, deliberately: wiring it
   * means a guard on most of the CRM write surface, across files four
   * other streams are editing this week, for a switch nobody has ever
   * pulled. It is recorded as a KNOWN HOLE with a named cause instead of
   * being described as safe, which is what the old reason did.
   */
  "crm.companies":
    "Baseline: companies are on every paid tier, so no tier can refuse them. " +
    "⚠️ A revoke override would, and nothing reads one — same known hole as " +
    "crm.contacts, recorded per key so neither can be deleted by accident.",
  "crm.deals":
    "Baseline: the pipeline is on every paid tier, so no tier can refuse it. " +
    "⚠️ A revoke override would, and nothing reads one — same known hole as " +
    "crm.contacts. Note sales.pipeline IS gated; these are the records.",

  /** Verified 0109: no utilisation, overbooking-policy or waitlist code exists. */
  "scheduling.capacity":
    "Not built. `server/actions/scheduling.ts` books resources; there is no " +
    "utilisation, overbooking policy or waitlist anywhere to refuse.",

  /** Verified 0109: `rates.ts` has rate cards and no demand or occupancy input. */
  "rates.dynamic":
    "Not built. Rate cards exist and are gated as `rates.cards`; nothing " +
    "links a rate to demand or occupancy.",

  /** Verified 0109: no service worker, no local queue, no sync reconciler. */
  "field.offline":
    "Not built. Field jobs are gated as `field.jobs`; there is no offline " +
    "capture, no local queue and no sync path to refuse.",

  /** Verified 0109: the compliance tables carry no client dimension. */
  "compliance.client_book":
    "Not built. The compliance calendar tracks OUR obligations; no table " +
    "carries a client whose obligations we would be tracking on their behalf.",

  /** Verified 0109: readings exist; import/export/banked units do not. */
  "metering.net_settlement":
    "Not built. Meters and readings are gated as `metering.readings`; there " +
    "is no import/export split, no banked units and no settlement.",

  /**
   * ⭐ THIS ONE IS BUILT AND STILL CORRECTLY UNGATED, WHICH IS RARE
   * ENOUGH TO BE WORTH THE SENTENCE.
   *
   * `server/actions/timesheets.ts` says out loud that there is no
   * timesheet table in this product. The screen REPORTS time recorded as
   * a side effect of two other modules — site attendance and field
   * visits — and both of those are already refused, by `construction.boq`
   * and `field.jobs` respectively. Gating the report as well would refuse
   * a READ of data the workspace has already paid to create.
   */
  "timesheets.entry":
    "Built as a READ ONLY. There is no timesheet table; the screen reports " +
    "site attendance and field visits, whose writes are already refused by " +
    "`construction.boq` and `field.jobs`. Gating a read of paid-for data " +
    "would be the anti-pattern, not the fix.",

  /** Verified 0109: `timesheets.ts` states it cannot produce a billable-hours figure. */
  "timesheets.utilisation":
    "Not built, and blocked on a decision rather than on code: there is no " +
    "billable flag, charge rate or cost rate anywhere, so realisation and " +
    "WIP have no inputs.",

  /**
   * ⚠️ `server/vault/*` IS BUILT AND IT IS NOT THIS.
   *
   * The vault stores OUR integration secrets and a tenant's AI provider
   * keys, with purpose-bound reads and an audit trail. The catalogue
   * entry sells something else — purpose-bound access, break-glass and
   * consent for a customer's own REGULATED PERSONAL DATA — and none of
   * that exists. Gating the secret store on an Enterprise key would
   * refuse a tenant its own API credentials, which is not what was sold.
   */
  "vault.sensitive":
    "Not built as sold. `server/vault/` holds integration and AI secrets " +
    "with purpose-bound reads; the break-glass and consent surface over a " +
    "customer's regulated personal data does not exist.",

  /**
   * ⚠️ THE TABLE EXISTS AND IS READ. THAT IS NOT THE SAME AS BUILT.
   *
   * `approval_sanctions` is SELECTed once, to count pending sanctions on
   * the land dashboard. Verified 0109: nothing inserts or updates it, so
   * there is no liaison diary, no FAR deviation check and no occupancy
   * gate — and a gate on a table only ever read would refuse a number on
   * somebody's dashboard and nothing else.
   */
  "land.approvals":
    "Not built. `approval_sanctions` exists and is read for one dashboard " +
    "count; no server code writes it, so there is no authority tracking, " +
    "liaison diary or occupancy gate to refuse.",

  /** Verified 0109: `asset_relationships` is declared in Drizzle and touched by no server code. */
  "assets.relationships":
    "Not built. The `asset_relationships` edge table is declared in the " +
    "schema and no server module reads or writes it.",

  /**
   * ⚠️ READ BY ASSEMBLY, WRITTEN BY NOTHING. `assembleDocument` selects
   * from `clause_library` — so the READ is now behind
   * `clm.document_assembly` — but verified 0109 there is no insert or
   * update anywhere. A library nobody can add a clause to is not a
   * library, and gating it would price an empty table.
   */
  "clm.clause_library":
    "Not built. `assembleDocument` reads `clause_library`, and no server " +
    "code writes a clause, so there is nothing to sell or refuse yet.",

  /**
   * 🔴 BUILT, AND DELIBERATELY NOT GATED, AND THIS IS THE INTERESTING ONE.
   *
   * `server/actions/analytics.ts` and `cost-control.ts` are eight `get*`
   * functions and no writes. `server/sales/guards.ts` states the rule
   * this obeys, from an incident: an automated pass once put entitlement
   * gates on three READ functions and none of the writes, and a gate on a
   * `get*` produces the worst possible upgrade prompt — a page that will
   * not render at all, rather than one that renders and refuses.
   *
   * ⚠️ SO THE HONEST POSITION IS THAT THIS KEY PRICES A READ, and a read
   * of the workspace's own figures at that. If it is to be enforced, the
   * mechanism is `checkFeature` in the page and an upgrade panel over a
   * dimmed dashboard — a rendering decision, not a refusal. That has not
   * been done and is not silently pretended otherwise.
   */
  "analytics.dashboard":
    "Built as reads only. Refusing a `get*` produces a page that will not " +
    "render rather than one that renders and refuses — see the note in " +
    "`server/sales/guards.ts`. Enforcing it means a render-time " +
    "`checkFeature` and a dimmed panel, which has not been built.",

  /**
   * 🔴 NEVER GATE. Exporting your own data is not a paid feature.
   * `permitsExport()` returns true at EVERY access level including
   * `locked`, and the reasoning there is the reasoning here: retaining
   * somebody's records while denying them a copy is a data-protection
   * problem under DPDP, not a collections strategy.
   */
  "analytics.export":
    "🔴 MUST NEVER BE GATED. Exporting your own data is a right, not a " +
    "tier. See `permitsExport()` in `lib/billing/access-state.ts`.",

  /** Verified 0109: the nine built-in roles are a constant; nothing composes a role. */
  "admin.custom_roles":
    "Not built. Roles are the nine templates in `db/schema/auth.ts` plus " +
    "per-user permission overrides; nothing composes a new role.",

  /**
   * Baseline by decision rather than by tier. The audit trail is a
   * compliance guarantee we make to every customer, and a guarantee sold
   * by the tier is not a guarantee.
   */
  "admin.audit_log":
    "Deliberately free. The audit trail is a compliance guarantee to every " +
    "workspace; selling it by tier would make it conditional, which is not " +
    "what a guarantee is.",

  /**
   * ⚠️ NOT THE MCP ENDPOINT. `/api/mcp` is now gated, on `ai.rag` rather
   * than on this key — it is an AI protocol whose purpose is answering
   * questions from records, and it is priced with the AI tier. A general
   * programmatic API, which is what this line item sells, does not exist.
   * See the report for that boundary; it is the one place 0109 guessed.
   */
  "admin.api_access":
    "Not built. There is no general REST or GraphQL surface. `/api/mcp` " +
    "exists and is gated on `ai.rag`, not on this key — see the note above.",

  /** 🔴 Verified 0109: nothing in the tree reads a logo, a colour or a custom domain. */
  "admin.white_label":
    "🔴 SOLD AND NOT BUILT. No logo, brand colour or custom-domain setting " +
    "exists anywhere. A gate here would be dead code; the honest fix is to " +
    "stop listing it until it exists.",

  /** 🔴 Verified 0109: Clerk is the only identity path and no SAML/OIDC federation is configured. */
  "admin.sso":
    "🔴 SOLD AND NOT BUILT. Authentication is Clerk's hosted flow; there is " +
    "no SAML or OIDC federation to a customer's provider. A gate would be " +
    "dead code.",

  /** 🔴 Verified 0109: one Neon region, no region column, no routing. */
  "admin.data_residency":
    "🔴 SOLD AND NOT BUILT. There is one database in one region and nothing " +
    "records or routes by region. A gate would be dead code.",
  });

/* ------------------------------------------------------------------ */
/* QUERIES                                                             */
/* ------------------------------------------------------------------ */

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

/**
 * Where the gate is, or why there isn't one.
 *
 * ⚠️ Returns `null` rather than a reassuring empty string for a key with
 * no entry. An empty string reads as "no reason needed"; null is a
 * question the test turns into a build failure.
 */
export function enforcementEvidence(feature: FeatureKey): string | null {
  return ENFORCEMENT_EVIDENCE[feature] ?? null;
}
