/**
 * Ordence — 🔴🔴🔴 THE SPINE: TABLES THAT COULD NEVER RECEIVE A ROW
 * Version: v1.70.0-alpha (wave two)
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE DEFECT THESE TESTS WOULD HAVE CAUGHT
 * ══════════════════════════════════════════════════════════════════════
 * 57 tables in this product had NO writer that any screen could reach.
 * Not "no UI yet" — no path at all: the only `.insert()` for each was
 * inside a server action nothing imported. 34 of those 57 were READ by
 * screens that worked perfectly, for ever, over nothing.
 *
 * Wave two closed the spine — the ones everything downstream needs before
 * it can hold data at all:
 *
 *   `financial_periods`  the period lock reads it; empty means nothing is
 *                        ever date-locked. 8 reachable readers.
 *   `vendors`            17 reachable readers.
 *   `warehouses` `stock_items`   20 between them.
 *   `projects` `units`   43 between them.
 *   `gst_registrations` `hsn_sac_codes` `hsn_sac_rates`
 *                        the tax invoice cannot print a GSTIN without one.
 *   `purchase_invoices`  the only transaction entry nothing substitutes for.
 *   the GSTR-2B four     Rule 36(4) makes credit conditional on the match.
 *
 * ⭐ THESE ASSERT THE ROUTE, NOT THE LOGIC. Every engine behind these was
 * already built, already tested, and already correct.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, extname } from "node:path";

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(join(ROOT, dir))) return out;
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (["node_modules", ".next", ".git"].includes(e.name)) continue;
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel, out);
    else if ([".ts", ".tsx"].includes(extname(e.name))) out.push(rel);
  }
  return out;
}

/**
 * ⚠️ COMMENTS STRIPPED, for the reason the gate itself now carries: a
 * doc comment naming an action must NOT count as calling it. These very
 * files explain at length which actions had no caller, and without the
 * strip that prose would satisfy the assertion it is documenting.
 */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

const uiCode = [...walk("app"), ...walk("components")]
  .map((f) => codeOnly(readFileSync(join(ROOT, f), "utf8")))
  .join("\n");

const SPINE: { action: string; table: string; why: string }[] = [
  { action: "createFinancialPeriod", table: "financial_periods", why: "the period lock reads it on every posting" },
  { action: "upsertVendor", table: "vendors", why: "17 reachable actions read it" },
  { action: "saveWarehouse", table: "warehouses", why: "12 reachable actions read it" },
  { action: "saveStockItem", table: "stock_items", why: "8 reachable actions read it" },
  { action: "createProject", table: "projects", why: "17 reachable actions read it" },
  { action: "createUnit", table: "units", why: "26 reachable actions read it" },
  { action: "createRegistration", table: "gst_registrations", why: "a tax invoice cannot print a GSTIN without one" },
  { action: "createHsnSacCode", table: "hsn_sac_codes", why: "the rate master has no codes without it" },
  { action: "addRatePeriod", table: "hsn_sac_rates", why: "a code with no rate period charges nothing" },
  { action: "recordPurchaseInvoice", table: "purchase_invoices", why: "the only transaction entry nothing substitutes for" },
  { action: "importGstr2b", table: "gstr2b_documents", why: "Rule 36(4) makes credit conditional on the 2B match" },
  { action: "runGstr2bReconciliation", table: "gstr2b_reconciliations", why: "an imported statement nobody reconciled is a file on a shelf" },
  { action: "decideGstr2bMatch", table: "gstr2b_matches", why: "the worklist was read-only" },
  { action: "bulkDecideGstr2bMatches", table: "gstr2b_matches", why: "the worklist was read-only" },
  { action: "fileGstr2bReconciliation", table: "gstr2b_reconciliations", why: "a period that is never filed is never closed" },
  { action: "recordDataPrincipalRequest", table: "dpdp_requests", why: "nothing could get onto the DPDPA list" },
  { action: "recordPersonalDataBreach", table: "dpdp_breaches", why: "the two statutory clocks could never start" },
];

/* ================================================================== */
describe("🔴🔴🔴 every spine writer is reachable from a screen", () => {
  for (const { action, table, why } of SPINE) {
    it(`${action} — ${table}: ${why}`, () => {
      expect(uiCode).toContain(action);
    });
  }
});

/* ================================================================== */
describe("⭐ and the census records it", () => {
  const baseline = JSON.parse(
    readFileSync(join(ROOT, "scripts/action-reachability-baseline.json"), "utf8"),
  ) as { orphans: number; names: string[] };

  it("🔴 no spine writer is in the orphan baseline", () => {
    const still = SPINE.filter(({ action }) =>
      baseline.names.some((k) => k.endsWith(`#${action}`)),
    ).map((s) => s.action);
    expect(still, "spine writers still recorded as unreachable").toEqual([]);
  });

  /**
   * ⚠️ A CEILING, NOT A TARGET. The number is allowed to fall and this
   * fails if it silently climbs back past where wave two left it. It is
   * deliberately not asserted as an exact value: a legitimate new action
   * built ahead of its screen should not fail the suite, it should show
   * up in the gate's own diff.
   */
  it("⚠️ the orphan count has not climbed back above where wave two left it", () => {
    expect(baseline.orphans).toBeLessThanOrEqual(192);
  });
});

/* ================================================================== */
describe("🔴 the two shapes wave two got wrong, asserted so they stay right", () => {
  /**
   * 🔴 I ASSUMED `importGstr2b` RETURNED `{ rows }` AND IT RETURNS
   * `{ rowCount, parseStatus, issues }`. tsc caught it. The real shape is
   * better: it carries the parse issues, and a statement that parsed with
   * warnings is not the same as one that parsed clean — the difference
   * decides whether a missing invoice is the supplier's fault or the
   * file's.
   */
  it("the import panel reports parse issues rather than only a row count", () => {
    const src = readFileSync(
      join(ROOT, "components/gstr2b/import-panel.tsx"),
      "utf8",
    );
    expect(src).toContain("parseStatus");
    expect(src).toMatch(/severity === "error"/);
  });

  /**
   * 🔴 AND `runGstr2bReconciliation` RETURNS `reconciles` — the identity
   * check that matched plus unmatched equals the total on each side. A
   * run that fails it must NOT be reported as a success, because every
   * figure on the summary is then arithmetic over rows that do not add
   * up. The page already refuses to present it as anything else.
   */
  it("a reconciliation that does not balance is not reported as a success", () => {
    const src = readFileSync(
      join(ROOT, "components/gstr2b/import-panel.tsx"),
      "utf8",
    );
    expect(src).toMatch(/if \(!run\.data\.reconciles\)/);
    expect(src).toContain("identityFailures");
  });
});

/* ================================================================== */
describe("⚠️ the refusals that are the point of these screens", () => {
  const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

  it("🔴 the vendor form states the s.43B(h) consequence of the MSME box", () => {
    const src = read("components/purchases/vendor-form.tsx");
    expect(src).toContain("43B(h)");
    /** The Udyam number is mandatory with the claim, and the form says why. */
    expect(src).toMatch(/Udyam/);
  });

  it("🔴 the stock item form says the valuation method cannot be changed later", () => {
    const src = read("components/inventory/setup-forms.tsx");
    expect(src).toMatch(/cannot be changed once the item has moved/i);
    /** And negative stock is offered as a switch with its cost stated. */
    expect(src).toMatch(/catching up with the lorry/i);
  });

  it("🔴 the unit form names carpet area as the statutory basis of sale", () => {
    const src = read("components/sales/project-unit-forms.tsx");
    expect(src).toContain("s.2(k)");
    expect(src).toMatch(/built-up area cannot be smaller than the carpet area/i);
  });

  it("🔴 the rate form states the basis-points trap", () => {
    const src = read("components/gst/setup-forms.tsx");
    expect(src).toMatch(/18% is 1800/);
    expect(src).toMatch(/Typing 18\s*\n?\s*here means 0\.18%/);
  });

  it("🔴 the purchase invoice form says the rate is transcribed, not resolved", () => {
    const src = read("components/purchases/record-invoice-form.tsx");
    expect(src).toMatch(/charged in respect of such/);
    /** s.16(2)(b): no credit until the goods are received. */
    expect(src).toContain("s.16(2)(b)");
  });

  it("🔴 the GSTR-2B worklist requires a reason for anything but an accept", () => {
    const src = read("components/gstr2b/worklist-actions.tsx");
    expect(src).toMatch(/re-investigated from scratch/i);
    /** And filing is one-way, stated before the button. */
    expect(src).toMatch(/cannot be undone/i);
  });

  it("⚠️ the 2B import warns that no parser can tell the date order", () => {
    const src = read("components/gstr2b/import-panel.tsx");
    expect(src).toMatch(/no parser can tell/i);
  });
});
