/**
 * Ordence — ⭐⭐⭐ WAVE 10: WHAT THE ORPHAN SWEEP ACTUALLY BUILT
 * Version: v1.78.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THESE TESTS EXIST SEPARATELY FROM `check:action-reach`
 * ══════════════════════════════════════════════════════════════════════
 * The gate counts. It says 119 actions are unreachable and refuses to let
 * that number climb. What it cannot say is that the SPECIFIC modules this
 * wave was about , the ones where a whole feature had been built
 * server-side and given no screen , are now reachable, and that the
 * screens reach them in the way the module intended.
 *
 * A future refactor that deletes the Tally console and leaves the actions
 * behind would move the gate's number and would not explain itself. These
 * tests name the thirteen actions and the reason each one matters.
 *
 * ⚠️ SOURCE-LEVEL ASSERTIONS, LIKE `tests/ui/export-reachability.test.ts`.
 * There is no server here to render a page against. What is being
 * asserted is a WIRING fact , this screen names that action , which is
 * exactly what source text can prove and what the whole class of defect
 * consisted of.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const exists = (p: string) => existsSync(join(ROOT, p));
const codeOnly = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

/* ================================================================== */
/* ① THE TALLY CONSOLE                                                */
/* ================================================================== */

describe("⭐ the Tally integration can be configured, not only watched", () => {
  const page = codeOnly(read("app/(crm)/tally/page.tsx"));

  /**
   * 🔴 THIRTEEN ACTIONS. Connections, mappings, cost centres, export,
   * push, delivery, import and reconciliation , the entire write half of
   * a module whose read half had a screen since v0.32.0.
   */
  const ACTIONS = [
    "upsertTallyConnection",
    "upsertTallyLedgerMapping",
    "retireTallyLedgerMapping",
    "upsertTallyCostCentreMapping",
    "getTallyCostCentreMappings",
    "getTallyTaxHeads",
    "generateTallyExport",
    "pushTallyExport",
    "markTallyExportDelivered",
    "importTallyExport",
    "getTallyImportBatches",
    "getTallyReconciliation",
    "resolveTallyReconciliationItem",
  ];

  it.each(ACTIONS.map((a) => [a] as const))("%s reaches the screen", (action) => {
    expect(page).toContain(action);
  });

  /**
   * ⚠️ THE MAPPING EDITOR MUST NOT LET BOTH IDENTITIES BE SET. A tax
   * head is identified by its key and everything else by its row; the
   * database says the same thing in
   * `tally_ledger_mappings_identity_is_singular`.
   */
  it("makes a two-identity mapping unreachable rather than refusing it after the fact", () => {
    const editor = codeOnly(read("app/(crm)/tally/tally-mapping-editor.tsx"));
    expect(editor).toContain("sourceId: isTaxHead ? null : draft.sourceId || null");
    expect(editor).toContain("sourceKey: isTaxHead ? draft.sourceKey || null : null");
  });

  /**
   * ⚠️ A GSTIN BELONGS ONLY ON A PARTY LEDGER. On a nominal one it is
   * inert, and its presence means a customer has been mapped to a
   * nominal account.
   */
  it("only offers a GSTIN on a party ledger", () => {
    const editor = read("app/(crm)/tally/tally-mapping-editor.tsx");
    expect(editor).toContain("{draft.isParty && !isTaxHead && (");
  });

  /**
   * 🔴 MARKING A BATCH DELIVERED IS NOT OPTIONAL BOOKKEEPING. The
   * REMOTEIDs are deterministic, so a batch that reached Tally and was
   * never marked makes the next export create second copies of every
   * voucher in it.
   */
  it("offers the manual delivery path as prominently as the push", () => {
    const panel = read("app/(crm)/tally/tally-export-panel.tsx");
    expect(panel).toContain("I imported it by hand");
    expect(panel).toContain("markDelivered");
    expect(panel).toMatch(/second copies of every voucher/);
  });

  /** The source picker reads under the tally permission, not three others. */
  it("gets its mappable sources from the tally module's own door", () => {
    const actions = codeOnly(read("server/actions/tally.ts"));
    expect(actions).toContain("export async function getTallyMappableSources");
    expect(actions).toContain('requirePermission("tally:read")');
  });
});

/* ================================================================== */
/* ② THE BOOKING SCREEN, AND EVERY DEMAND AGAINST IT                  */
/* ================================================================== */

describe("⭐ the bookings list finally leads somewhere", () => {
  it("the two routes exist", () => {
    expect(exists("app/(crm)/sales/bookings/[id]/page.tsx")).toBe(true);
    expect(exists("app/(crm)/sales/bookings/new/page.tsx")).toBe(true);
  });

  const detail = codeOnly(read("app/(crm)/sales/bookings/[id]/page.tsx"));

  const BOOKING_ACTIONS = [
    "getBooking",
    "advanceBooking",
    "cancelBooking",
    "generatePaymentPlan",
    "recordMilestonePayment",
    "listPlanTemplates",
  ];

  const RECEIVABLE_ACTIONS = [
    "getBookingReceivables",
    "getStatementOfAccount",
    "createDemand",
    "previewDemandNotice",
    "serveDemand",
    "withdrawDemand",
    "replaceDemand",
    "getDunningHistory",
    "recordPayment",
    "markReceiptBounced",
    "reapplyReceipt",
  ];

  it.each([...BOOKING_ACTIONS, ...RECEIVABLE_ACTIONS].map((a) => [a] as const))(
    "%s reaches the booking screen",
    (action) => {
      expect(detail).toContain(action);
    },
  );

  /**
   * 🔴 A STATEMENT WITHOUT FIGURES MUST NOT RENDER FIGURES. The action
   * withholds them when the demand ledger and the books disagree,
   * because this document leaves the building and a buyer keeps it.
   */
  it("renders the breach rather than a partial statement", () => {
    const statement = read("app/(crm)/sales/bookings/[id]/statement-of-account.tsx");
    expect(statement).toContain("No statement can be produced for this buyer today");
    expect(statement).toContain("{figures ? (");
    // The narrative lives inside `figures`, so it cannot leak on its own.
    expect(statement).toContain("figures.narrative");
  });

  /**
   * ⚠️ A `bigint` DOES NOT CROSS INTO A CLIENT COMPONENT. Every figure
   * is formatted on the server side of the boundary.
   */
  it("keeps bigint money on the server side of the boundary", () => {
    const panel = read("app/(crm)/sales/bookings/[id]/receivables-panel.tsx");
    // The panel receives strings and parses them itself.
    expect(panel).toContain("totalMinor: string");
    expect(panel).not.toMatch(/bigint\s*;/);
  });

  /** Two different "record payment" operations on one page must be told apart. */
  it("says which of the two payment operations is which", () => {
    const milestones = read("app/(crm)/sales/bookings/[id]/milestone-payments.tsx");
    expect(milestones).toContain("This marks a stage of the plan as paid");
    expect(milestones).toMatch(/recorded under Receivables below/);
  });
});

/* ================================================================== */
/* ③ THE OTHER FIVE ROUTES                                            */
/* ================================================================== */

describe("⭐ the rest of the dead links became screens", () => {
  it.each([
    ["app/(crm)/sales/inventory/[id]/page.tsx", ["holdUnit", "releaseHold", "setUnitAvailability", "updateUnit"]],
    ["app/(crm)/settings/recovery/[table]/[id]/page.tsx", ["canRestore", "restoreFromRecycleBin"]],
    ["app/(crm)/land/[id]/page.tsx", ["auditTitleChain", "saveLandParcel", "dropLandParcel"]],
    ["app/(crm)/purchases/vendors/[id]/page.tsx", ["getVendorStatement", "getVendorAgeing", "addVendorLedgerEntry", "setVendorActive"]],
    ["app/(crm)/purchases/invoices/[id]/page.tsx", ["getPurchaseInvoice", "recordItcMovement"]],
  ] as const)("%s reaches its actions", (path, actions) => {
    expect(exists(path)).toBe(true);
    const source = codeOnly(read(path));
    for (const action of actions) expect(source).toContain(action);
  });

  /**
   * ⚠️ `/sales/inventory/new` WAS REMOVED RATHER THAN BUILT. The create
   * form is already on the list page, and a second surface over the same
   * eleven fields is the duplication this codebase has paid for before.
   */
  it("points Add units at the form already on the page", () => {
    const page = read("app/(crm)/sales/inventory/page.tsx");
    expect(page).toContain('href="#add-units"');
    expect(page).not.toContain('href="/sales/inventory/new"');
    expect(page).toContain('id="add-units"');
  });

  /** The two repointed links now go somewhere that exists. */
  it("repoints the enquiry and company links at the screens that exist", () => {
    expect(read("app/(crm)/enquiries/page.tsx")).toContain("/sales/leads/${l.id}");
    expect(read("app/(crm)/companies/[id]/statement/page.tsx")).toContain(
      "/companies/${id}/edit",
    );
  });
});

/* ================================================================== */
/* ④ THE DEAD-LINK BACKLOG IS PAID OFF                                */
/* ================================================================== */

describe("⭐ check:links has no allowance left", () => {
  const gate = read("scripts/check-links.mjs");

  /**
   * 🔴 THE FILE'S OWN HEADER SAID: "THE LIST IS THE BACKLOG. When it
   * reaches zero, delete the mechanism." It has reached zero, and what
   * is deleted is the ALLOWANCE , not the check. At zero, any dead link
   * fails the build, which is the whole point of getting there.
   */
  it("is at zero with an empty list", () => {
    expect(gate).toContain("const KNOWN_DEAD_MAX = 0;");
    expect(gate).toContain("const KNOWN_DEAD = new Map([]);");
  });

  it("still refuses a new dead link", () => {
    // The comparison that fails the build is unchanged.
    expect(gate).toContain("if (dead.length > KNOWN_DEAD_MAX)");
  });
});

/* ================================================================== */
/* ⑤ THE COMPLIANCE CONSOLES                                          */
/* ================================================================== */

describe("⭐ the TDS quarter and the credit board can be acted on", () => {
  const tds = codeOnly(read("app/(crm)/tds/compliance/page.tsx"));

  it.each(
    [
      "recordChallan",
      "mapDeductionsToChallan",
      "reconcileChallansForPeriod",
      "sweepThresholdShortfalls",
      "buildQuarterlyReturn",
      "fileQuarterlyReturn",
      "buildCertificates",
      "upsertDeductee",
      "upsertLowerDeductionCertificate",
    ].map((a) => [a] as const),
  )("%s reaches the TDS compliance screen", (action) => {
    expect(tds).toContain(action);
  });

  /**
   * ⚠️ ONLY UNMAPPED DEDUCTIONS ARE OFFERED. Offering one that already
   * carries a challan invites double-mapping, which makes the challan
   * look over-utilised and the reconciliation fail for a reason nobody
   * can find.
   */
  it("only offers deductions that are not already against a challan", () => {
    expect(tds).toContain("row.challanId === null");
  });

  const credit = codeOnly(read("app/(crm)/receivables/credit/page.tsx"));

  it.each(
    [
      "getCreditPosition",
      "setCreditTerms",
      "setCreditHold",
      "placeCreditHold",
      "releaseCreditHold",
      "recordCreditHoldOverride",
      "setApprovalLimit",
      "removeApprovalLimit",
      "runDunningSweep",
    ].map((a) => [a] as const),
  )("%s reaches the credit board", (action) => {
    expect(credit).toContain(action);
  });

  /**
   * 🔴 THE OVERRIDE IS THE MOST SERIOUS CONTROL ON THAT SCREEN and its
   * validator's own sentence is repeated to the person pressing it.
   */
  it("repeats the override's reasoning rather than showing an asterisk", () => {
    const controls = read("app/(crm)/receivables/credit/credit-controls.tsx");
    expect(controls).toContain("read back if the debt goes bad");
    expect(controls).toContain("overrideReason.trim().length < 8");
  });

  /** A staff-only role must not appear on a customer's approval matrix. */
  it("keeps the platform role off the customer's approval limits", () => {
    expect(credit).toContain('role !== "platform_super_admin"');
  });
});

/* ================================================================== */
/* ⑥ THE COUNT ITSELF                                                 */
/* ================================================================== */

describe("⭐ the orphan baseline moved and can only move down", () => {
  const baseline = JSON.parse(read("scripts/action-reachability-baseline.json")) as {
    orphans: number;
    names: string[];
  };

  /**
   * 🔴 192 WHEN THIS WAVE STARTED. Every one of them is a URL the
   * browser can POST to that no screen in the product uses , which is
   * both a feature nobody can reach and an endpoint nobody is watching.
   */
  it("is well below where the wave started", () => {
    expect(baseline.orphans).toBeLessThanOrEqual(119);
    expect(baseline.names).toHaveLength(baseline.orphans);
  });

  it("no longer lists anything from the modules this wave finished", () => {
    const finished = [
      "server/actions/tally.ts#",
      "server/actions/sales-bookings.ts#",
      "server/actions/receivables.ts#",
      "server/actions/tds.ts#",
      "server/actions/credit.ts#",
      "server/actions/purchases.ts#",
      "server/actions/land.ts#",
      "server/actions/recovery.ts#",
      "server/actions/sales-inventory.ts#",
    ];
    for (const prefix of finished) {
      expect(baseline.names.filter((n) => n.startsWith(prefix))).toEqual([]);
    }
  });
});
