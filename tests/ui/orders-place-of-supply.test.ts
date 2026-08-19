/**
 * Ordence — ⭐⭐ BATCH 33: THE TAX THAT WAS DECIDED BY COMPARING TWO STRINGS
 * Version: v1.37.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT WAS ACTUALLY WRONG
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 `server/actions/orders.ts` decided CGST+SGST versus IGST with:
 *
 *      const isInterState = data.placeOfSupplyCode !== sellerStateCode
 *
 *    while `lib/gst/place-of-supply.ts` held a complete engine covering
 *    s.12(3), s.7(5)(b), s.10(1)(a), s.12(2) and the UT distinction, with
 *    a statutory reference for each. Nothing called it.
 *
 * 🔴 AND THE ORDER TABLE COULD NOT HOLD THE ENGINE'S ANSWER. Two columns:
 *    `place_of_supply_code` and `is_inter_state`. Nowhere for the site of
 *    a works contract, nowhere for the recipient being an SEZ unit,
 *    nowhere for intra-UT. So the fix is a migration, not a one-liner.
 *
 * ⭐ AND THE SAME DEFECT WAS IN THREE MORE PLACES, found by the gate this
 *    batch adds rather than by reading:
 *      • `lib/inventory/transfer.ts` — its own comment named the SEZ case
 *        four lines above the comparison that got it wrong.
 *      • `server/actions/time-billing.ts` — took `isInterState` as a
 *        CLIENT-SUPPLIED BOOLEAN and defaulted place of supply to "27".
 *      • the same file again — `isUnionTerritory: false`, hardcoded.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { determinePlaceOfSupply, taxKindFor } from "@/lib/gst/place-of-supply";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const MIGRATION = read("SQL-FILES/0080_orders_place_of_supply.sql");
const DRILL = read("SQL-FILES/DRILL-DO-NOT-RUN-IN-NEON-0080.sql");
const VERIFY = read("SQL-FILES/VERIFY-0080-neon-safe.sql");
const ORDERS = read("server/actions/orders.ts");
const TRANSFER = read("lib/inventory/transfer.ts");
const TIME_BILLING = read("server/actions/time-billing.ts");
const GATE = read("scripts/check-tax-decisions.mjs");

/**
 * ⚠️ THE PROSE TRAP, GUARDED AT SOURCE. This suite asserts on the ABSENCE
 * of code, and this file plus the files it reads all quote that code in
 * comments to explain it. Five previous tests in this repo failed on
 * their own explanations. Every absence assertion below runs against
 * comment-stripped source.
 */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
}

/* ================================================================== */
/* ① THE ENGINE GIVES THE ANSWERS THE COMPARISON COULD NOT             */
/* ================================================================== */

describe("the three cases a string comparison cannot express", () => {
  /**
   * 🔴 THE MOST EXPENSIVE ONE. Supplier in Maharashtra, site in
   * Maharashtra, buyer registered in Karnataka. s.12(3): the SITE
   * decides, so this is INTRA-state. The string compare sees 29 vs 27,
   * concludes inter-state, and charges IGST on a supply that owes
   * CGST + SGST. Recovering that is a s.77 refund application, not an
   * edit.
   */
  it("puts a works contract where the site is, not where the buyer is", () => {
    const r = determinePlaceOfSupply({
      supplierStateCode: "27",
      supplyType: "immovable_property",
      recipientRegistration: "regular",
      recipientStateCode: "29",
      propertyStateCode: "27",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.supply.placeOfSupplyCode).toBe("27");
    expect(r.supply.isInterState).toBe(false);
    expect(r.supply.taxKind).toBe("cgst_sgst");
    expect(r.supply.statutoryRef).toContain("12(3)");

    // And the comparison the old code made, for contrast.
    expect("29" !== "27").toBe(true); // would have said inter-state
  });

  /**
   * 🔴 s.7(5)(b). An SEZ unit in our OWN state is still inter-state.
   * The codes match, so the comparison says intra-state, and the IGST
   * shortfall accrues interest from the original date.
   */
  it("makes an SEZ in our own state inter-state", () => {
    const r = determinePlaceOfSupply({
      supplierStateCode: "27",
      supplyType: "services",
      recipientRegistration: "sez",
      recipientStateCode: "27",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.supply.isInterState).toBe(true);
    expect(r.supply.taxKind).toBe("igst");
    expect(r.supply.statutoryRef).toContain("7(5)(b)");

    expect("27" !== "27").toBe(false); // would have said intra-state
  });

  /**
   * ⚠️ THE SILENT ONE. Intra-UT is CGST + UTGST. The money is identical
   * to CGST + SGST, so nothing ever looked wrong — but it is a different
   * Act and a different GSTR-1 box, and a two-way boolean cannot say it.
   */
  it("distinguishes UTGST from SGST, which a boolean cannot", () => {
    expect(taxKindFor(false, "35")).toBe("cgst_utgst");
    expect(taxKindFor(false, "27")).toBe("cgst_sgst");
    expect(taxKindFor(true, "35")).toBe("igst");
  });

  /**
   * ⭐ AND IT REFUSES RATHER THAN GUESSING. The old code ended in
   * `: false`, which answered "intra-state" for every case it could not
   * decide. A refusal with a remedy is what gets the data fixed.
   */
  it("refuses a works contract with no site, and names the fix", () => {
    const r = determinePlaceOfSupply({
      supplierStateCode: "27",
      supplyType: "immovable_property",
      recipientRegistration: "regular",
      recipientStateCode: "29",
      propertyStateCode: null,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problem.remedy).toContain("12(3)");
    expect(r.problem.remedy.length).toBeGreaterThan(40);
  });
});

/* ================================================================== */
/* ② THE LIVE PATH ASKS THE ENGINE                                     */
/* ================================================================== */

describe("createOrder", () => {
  it("calls the engine and no longer compares two state codes", () => {
    const code = codeOnly(ORDERS);
    expect(code).toContain("determinePlaceOfSupply(");
    expect(code).not.toMatch(
      /isInterState\s*=[^;]*placeOfSupplyCode\s*!==\s*sellerStateCode/,
    );
  });

  /** ⭐ The determination is stored, not merely used and discarded. */
  it("stores the basis and the statutory reference", () => {
    const code = codeOnly(ORDERS);
    expect(code).toContain("placeOfSupplyBasis: supply.basis");
    expect(code).toContain("placeOfSupplyRef: supply.statutoryRef");
    expect(code).toContain("isUnionTerritory: supply.isUnionTerritory");
  });

  /**
   * 🔴 THE CALLER'S PLACE OF SUPPLY IS AN ASSERTION NOW, NOT AN INPUT.
   * It used to be written to the row unexamined, which meant a caller
   * could choose their own tax treatment. The total is identical either
   * way, so nothing on the screen would have looked wrong.
   */
  it("refuses when the caller's place of supply disagrees", () => {
    const code = codeOnly(ORDERS);
    expect(code).toContain("data.placeOfSupplyCode !== supply.placeOfSupplyCode");
    expect(code).toContain("OrderTaxRefusal");
    expect(code).toContain("placeOfSupplyCode: supply.placeOfSupplyCode");
  });

  /** And it refuses rather than defaulting when it has no registration. */
  it("refuses an order with no seller registration", () => {
    expect(codeOnly(ORDERS)).toMatch(/if\s*\(!sellerStateCode\)/);
  });
});

/* ================================================================== */
/* ③ THE THREE OTHER SITES THE GATE FOUND                              */
/* ================================================================== */

describe("the sites reading the code did not find", () => {
  /**
   * ⭐ ITS OWN COMMENT NAMED THE CASE. Four lines above the comparison,
   * "a business with an SEZ unit" is given as the example of two
   * registrations in one state. Then it compared the state codes.
   */
  it("branch transfers ask the engine", () => {
    const code = codeOnly(TRANSFER);
    expect(code).toContain("determinePlaceOfSupply(");
    expect(code).not.toMatch(/taxKind:\s*interState\s*\?/);
    // The type had to widen before the answer could be given.
    expect(code).toContain('"cgst_utgst"');
  });

  /**
   * 🔴 THE WORST OF THE FOUR. `isInterState: z.boolean()` let the caller
   * choose the tax split directly, and `?? "27"` defaulted a missing
   * place of supply to Maharashtra — so a Karnataka firm billing a
   * Karnataka client with the field blank raised an inter-state invoice
   * against a state it has no connection to.
   */
  it("time billing derives the split instead of accepting it", () => {
    const code = codeOnly(TIME_BILLING);
    expect(code).toContain("determinePlaceOfSupply(");
    expect(code).not.toMatch(/taxKind:\s*data\.isInterState\s*\?/);
    expect(code).not.toContain('data.placeOfSupplyCode ?? "27"');
    expect(code).toContain("placeOfSupplyCode: supply.placeOfSupplyCode");
  });

  /** ⚠️ And the hardcoded `isUnionTerritory: false` beside it. */
  it("time billing records the Union Territory case", () => {
    const code = codeOnly(TIME_BILLING);
    expect(code).toContain("isUnionTerritory: supply.isUnionTerritory");
    expect(code).not.toContain("isUnionTerritory: false");
    expect(code).toContain("placeOfSupplyBasis: supply.basis");
  });
});

/* ================================================================== */
/* ④ THE GATE                                                          */
/* ================================================================== */

describe("check:tax-decisions", () => {
  it("fails when the engine has no production caller", () => {
    expect(GATE).toContain("has NO production caller");
  });

  /**
   * ⭐ THE CHECK THAT WOULD HAVE CAUGHT THE ORIGINAL DEFECT. Every other
   * gate asks whether the code that exists is well formed. None asked
   * whether it is reached. The engine was perfect, tested, and imported
   * by nothing, and the suite was green.
   */
  it("requires every engine caller that persists to store the basis", () => {
    expect(GATE).toContain("placeOfSupplyBasis");
    expect(GATE).toMatch(/\\\.insert\\\(\|\\\.update\\\(/);
  });

  /**
   * ⚠️⚠️ THE PROSE TRAP, FIFTH OCCURRENCE, FIXED AS A CLASS.
   *
   * It fired twice in one run of this gate: once on a comment quoting
   * the ternary the fix had removed, and once on a comment EXPLAINING
   * why calling the engine at invoice time would be wrong — which made a
   * correct file look like a caller and would have masked a genuinely
   * uncalled engine.
   */
  it("strips comments before matching, so it cannot fail on prose", () => {
    expect(GATE).toContain("stripCommentsAndStrings");
    expect(GATE).toContain("PROSE TRAP, FIFTH OCCURRENCE");
    expect(GATE).toContain("line numbers in every failure message stay true");
  });

  /** ⚠️ And the record of the check that was too broad and was narrowed. */
  it("records the false-positive rate that forced the narrowing", () => {
    expect(GATE).toContain("FOUR OF THEM WERE FALSE");
    expect(GATE).toContain("cries wolf");
  });
});

/* ================================================================== */
/* ⑤ THE MIGRATION, THE DRILL AND THE VERIFY                           */
/* ================================================================== */

describe("0080", () => {
  it("adds every column the answer needs", () => {
    for (const col of [
      "supply_type",
      "property_state_code",
      "recipient_registration",
      "place_of_supply_basis",
      "place_of_supply_ref",
      "is_union_territory",
    ]) {
      expect(MIGRATION, col).toContain(col);
    }
  });

  /**
   * 🔴 `projects.state` IS varchar(120) HOLDING "Maharashtra". The engine
   * needs "27". Without a code column, s.12(3) cannot be answered at all.
   */
  it("gives projects a GST state code, and refuses to guess it", () => {
    expect(MIGRATION).toContain("ALTER TABLE projects");
    expect(MIGRATION).toContain("state_code varchar(2)");
    expect(MIGRATION).toContain("NOT BACKFILLED FROM `state`");
  });

  /** ⚠️ Historical orders are labelled, not re-determined. */
  it("labels legacy rows rather than restating them", () => {
    expect(MIGRATION).toContain("legacy_state_compare");
    expect(MIGRATION).toContain("WE DO NOT RE-DETERMINE HISTORICAL ORDERS");
  });

  it("ships all four constraints", () => {
    for (const c of [
      "sales_orders_immovable_property_pos",
      "sales_orders_sez_is_inter_state",
      "sales_orders_ut_is_intra_state",
      "sales_orders_pos_has_basis",
    ]) {
      expect(MIGRATION, c).toContain(c);
      expect(VERIFY, c).toContain(c);
    }
  });

  it("says to push the code first, and why", () => {
    expect(MIGRATION).toContain("RUN THIS AFTER PUSHING THE CODE, NOT BEFORE");
  });
});

describe("the drill", () => {
  it("refuses to run against anything that looks real", () => {
    expect(DRILL).toContain("DO NOT RUN THIS IN NEON");
    expect(DRILL).toContain("current_database() LIKE '%neon%'");
  });

  /**
   * ⚠️ SIX POSITIVES AGAINST FIVE REFUSALS. A drill that only showed
   * refusals could not tell "correctly constrained" from "broken", and
   * the entire risk of 0080 is that it tightens onto an order somebody
   * still needs to raise.
   */
  it("pairs six positives with five refusals", () => {
    expect((DRILL.match(/⭐ POSITIVE \d/g) ?? []).length).toBe(6);
    expect((DRILL.match(/🔴 REFUSAL \d/g) ?? []).length).toBe(5);
    expect(DRILL).toContain("should_be_six");
  });

  /**
   * ⭐ THE ONE THAT PROTECTS USABILITY. An operator who has not yet
   * chosen a buyer must still be able to save a draft. A constraint that
   * blocked that would be worked around with a default within a week.
   */
  it("proves a draft with no place of supply is still allowed", () => {
    expect(DRILL).toContain("INSERT INTO sales_orders (order_no) VALUES ('SO-10')");
  });

  /** ⚠️ And it explains why it needs no role guard, unlike 0079's drill. */
  it("says why it does not need a non-superuser", () => {
    expect(DRILL).toContain("DOES NOT NEED A NON-SUPERUSER");
    expect(DRILL).toContain("deliberate rather than forgotten");
  });
});

describe("the verify", () => {
  it("writes nothing", () => {
    expect(VERIFY).toContain("SAFE AGAINST NEON");
    expect(VERIFY).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\s/);
  });

  /**
   * 🔴 THE NUMBER THAT MATTERS. Not "did it work" but "how much was
   * decided by string comparison, and which of those could have been
   * wrong".
   */
  it("counts what was decided before the engine, and ranks the risky ones", () => {
    expect(VERIFY).toContain("legacy_state_compare");
    expect(VERIFY).toContain("works_contract");
    expect(VERIFY).toContain("registration_type = 'sez'");
  });

  it("ends with the role check", () => {
    expect(VERIFY).toContain("rolbypassrls");
  });
});
