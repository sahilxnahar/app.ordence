/**
 * Ordence — ⭐⭐⭐ BATCH 39: THE REVERSAL IS COMPUTED, AND SHOWS ITS WORKING
 * Version: v1.46.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT WAS WRONG
 * ══════════════════════════════════════════════════════════════════════
 * `lib/purchases/itc.ts` decides Section 17(5) clause by clause.
 * `lib/purchases/apportionment.ts` implements Rule 42 with the partition
 * asserted rather than assumed. Both were rigorous, both were tested, and
 * neither was reachable from the GSTR-3B — where the reversal figure was
 * three empty boxes and a note saying "reversals are entered, not
 * calculated". The engines were right and the return was typed.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐⭐ WHAT THESE TESTS ARE ACTUALLY DEFENDING
 * ══════════════════════════════════════════════════════════════════════
 * Not "the number is computed" — that is the easy half and the half that
 * cannot regress silently. What can regress silently is the WORKING: the
 * clause each blocked bill was blocked under, the exempt-to-total ratio,
 * and the letters of Rule 42. A computed figure with no working is worse
 * than a typed one, because the operator stops checking it, and the month
 * the ratio moves — which for a developer is the month a completed tower
 * is sold — nobody notices whether the reversal moved with it.
 *
 * So sections ② and ③ below assert on the WORKING and on the OVERRIDE
 * RULE, and section ④ recomputes a real month by hand rather than
 * re-running the implementation.
 *
 * ⚠️ ABSENCE ASSERTIONS USE COMMENT-STRIPPED SOURCE. The old sentence
 * "Reversals are entered, not calculated" is quoted in the comments of
 * the very files that removed it, and a raw `toContain` would report the
 * explanation as the thing it explains.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import {
  apportionRule42,
  apportionRule42ByHead,
  bucketRule42,
  type AttributedLine,
} from "@/lib/purchases/apportionment";
import { determineItcEligibility } from "@/lib/purchases/itc";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const codeOnly = (s: string) =>
  s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));

const PANEL_PATH = "components/gst/itc-reversal-working.tsx";
const PANEL = read(PANEL_PATH);
const BOARD = read("components/returns/gstr3b-board.tsx");
const PURCHASES = read("server/actions/purchases.ts");
const RETURNS = read("server/actions/returns.ts");
const PAGE = read("app/(crm)/gst/gstr3b/page.tsx");

/** ₹ to paise, so the expectations below read like a working paper. */
const r = (rupees: number): bigint => BigInt(Math.round(rupees * 100));

/* ================================================================== */
/* ① THE ENGINES NOW HAVE A CALLER ON THE LIVE PATH                    */
/* ================================================================== */

describe("the Section 17(5) and Rule 42 engines are reachable from the 3B", () => {
  it("the working panel exists and is a client component", () => {
    expect(existsSync(join(ROOT, PANEL_PATH))).toBe(true);
    expect(PANEL.trimStart().startsWith('"use client"')).toBe(true);
  });

  /**
   * 🔴 THE ONE THAT MATTERS. Before this batch the only callers of
   * `apportionRule42*` and `bucketRule42` outside `lib/` were a write
   * action nobody invoked and the test suite. A read-only action that a
   * screen actually calls is what makes the engine part of the product
   * rather than part of the repository.
   */
  it("a read-only action composes both engines", () => {
    const code = codeOnly(PURCHASES);
    expect(code).toContain("export async function getItcReversalWorking");
    expect(code).toContain("bucketRule42(");
    expect(code).toContain("apportionRule42ByHead(");
    expect(code).toContain("determineItcEligibility(");
    // Rule 43 is computed so the panel can say what the figure EXCLUDES.
    expect(code).toContain("apportionRule43(");
  });

  it("the panel calls the read-only action and the posting action", () => {
    const code = codeOnly(PANEL);
    expect(code).toContain("getItcReversalWorking");
    // ⭐ `runRule42ForPeriod` had no caller at all before this batch.
    expect(code).toContain("runRule42ForPeriod");
    expect(code).toContain("@/server/actions/purchases");
  });

  it("the 3B prepare form renders the panel, so the number is on the live path", () => {
    const code = codeOnly(BOARD);
    expect(code).toContain("ItcReversalWorking");
    expect(code).toContain("@/components/gst/itc-reversal-working");
    // The panel and the return must agree on the month. See the page header.
    expect(code).toContain("taxPeriod={period}");
  });

  it("the page that mounts the board says the reversal is computed", () => {
    expect(PAGE).toContain("Rule 42 reversal is computed");
  });
});

/* ================================================================== */
/* ② THE WORKING — WITHOUT IT A COMPUTED FIGURE IS WORSE THAN A TYPED  */
/*    ONE                                                              */
/* ================================================================== */

describe("the operator can check the number", () => {
  /**
   * ⚠️ COMMENT-STRIPPED. The retired sentence is quoted in this file's own
   * header and in the board's, because the reason it went is worth
   * keeping. Only its survival as RENDERED TEXT would be the bug.
   */
  it("the board no longer tells the operator to type the figure", () => {
    const code = codeOnly(BOARD);
    expect(code).not.toContain("Reversals are entered, not calculated");
    expect(code).not.toContain("turnover\n                splits Ordence does not model");
  });

  it("the working names the clause each blocked bill was blocked under", () => {
    const code = codeOnly(PURCHASES);
    // Grouped by clause, with the count and the money, over ALL lines.
    expect(code).toContain("byClause");
    expect(code).toContain("statutoryRef");
    expect(code).toContain("blockReason");
    // And bill by bill, with the vendor's own document number on each.
    expect(code).toContain("invoiceNumber");
    expect(code).toContain("blockedLines");

    const panel = codeOnly(PANEL);
    expect(panel).toContain("working.byClause");
    expect(panel).toContain("working.blockedLines");
    expect(panel).toContain("l.statutoryRef");
    expect(PANEL).toContain("Blocked under Section 17(5)");
  });

  it("the working prints the exempt-to-total ratio, not just the reversal", () => {
    expect(codeOnly(PURCHASES)).toContain("exemptRatioBps");
    const panel = codeOnly(PANEL);
    expect(panel).toContain("working.exemptRatioBps");
    expect(panel).toContain("working.exemptTurnoverMinor");
    expect(panel).toContain("working.totalTurnoverMinor");
    expect(PANEL).toContain("The ratio Rule 42 applied");
  });

  it("the working prints Rule 42 in the rule's own letters", () => {
    const panel = codeOnly(PANEL);
    for (const letter of ["c1Minor", "t1Minor", "t2Minor", "t3Minor", "c2Minor", "t4Minor", "c3Minor", "d1Minor", "d2Minor"]) {
      expect(panel).toContain(`working.${letter}`);
    }
  });

  /**
   * ⭐ THE HONEST HALF. Rule 43 on capital goods bought in earlier
   * periods is genuinely not in the computed figure, and E and F are
   * typed. A computed number that hides its own gaps is how somebody
   * stops checking — and it is also the legitimate reason an override
   * exists at all.
   */
  it("the working says what it does NOT cover", () => {
    expect(codeOnly(PURCHASES)).toContain("caveats");
    expect(codeOnly(PANEL)).toContain("working.caveats");
    expect(PURCHASES).toContain("RULE_43_USEFUL_LIFE_MONTHS");
    expect(PANEL).toContain("What this figure does not cover");
  });

  /**
   * ⚠️ A TRUNCATED LIST THAT DOES NOT ADMIT IT IS WORSE THAN NO LIST. The
   * per-clause totals are computed over every line; only the row-by-row
   * list is capped, and the remainder is counted.
   */
  it("a capped list reports how many rows it is not showing", () => {
    expect(codeOnly(PURCHASES)).toContain("linesNotListed");
    expect(codeOnly(PANEL)).toContain("working.linesNotListed");
  });
});

/* ================================================================== */
/* ③ THE OVERRIDE SURVIVES, BUT NOT SILENTLY                           */
/* ================================================================== */

describe("an override needs a written reason and records both numbers", () => {
  it("the prepare action takes the computed figure alongside the entered one", () => {
    const code = codeOnly(RETURNS);
    expect(code).toContain("itcReversalComputedIgstMinor");
    expect(code).toContain("itcReversalComputedCgstMinor");
    expect(code).toContain("itcReversalComputedSgstMinor");
    expect(code).toContain("itcReversalComputedCessMinor");
    expect(code).toContain("itcReversalOverrideReason");
  });

  it("the refusal is on the server, not only in the form", () => {
    const code = codeOnly(RETURNS);
    expect(code).toContain("describeReversal");
    expect(code).toContain("OVERRIDE_REASON_MIN");
    expect(code).toContain("reversalCheck.refusal");
  });

  /**
   * 🔴 HEAD BY HEAD, NEVER ON THE TOTAL. ₹1,000 moved from CGST to SGST
   * sums identically, files cleanly, balances, and reverses credit in the
   * wrong pool — a total-only comparison would wave it through with no
   * reason recorded.
   */
  it("the comparison is per head", () => {
    const returns = codeOnly(RETURNS);
    expect(returns).toContain("computed.some((head, i) => head !== entered[i])");
    const board = codeOnly(BOARD);
    expect(board).toContain("computedHeadsMinor.some(");
  });

  /**
   * ⭐ NOT RUNNING THE WORKING AT ALL IS ALSO AN OVERRIDE. If a non-zero
   * reversal could be typed simply by never pressing Compute, the reason
   * would be optional in practice for everyone who wanted it to be.
   */
  it("a typed reversal with no working is refused too", () => {
    expect(codeOnly(RETURNS)).toContain("enteredTotal !== 0n");
    expect(RETURNS).toContain("no Rule 42 working was run for the");
  });

  it("both numbers and the reason are stored with the return and in the audit", () => {
    const code = codeOnly(RETURNS);
    // Persisted on the return row, which is what somebody opens in
    // eighteen months to answer a notice.
    expect(code).toContain("reversalCheck.note");
    expect(code).toContain("...b.notes, reversalCheck.note");
    // And in the audit, which also keeps the figure that was NOT filed.
    expect(code).toContain("itcReversalEnteredMinor");
    expect(code).toContain("itcReversalComputedMinor");
    expect(code).toContain("itcReversalOverridden");
  });

  it("the form will not submit an unexplained difference either", () => {
    const code = codeOnly(BOARD);
    expect(code).toContain("overrides && overrideReason.trim().length < 20");
    expect(code).toContain("itcReversalOverrideReason");
    expect(BOARD).toContain("Both figures and your reason are stored with the return.");
  });

  /**
   * ⚠️ THE ENGINE APPORTIONS FOUR HEADS. A form with three boxes drops a
   * computed cess reversal on the floor — the exact silent under-reversal
   * this batch exists to stop.
   */
  it("the form has a cess reversal box", () => {
    expect(codeOnly(BOARD)).toContain('id="rev-cess"');
    expect(codeOnly(BOARD)).toContain("itcReversedCessMinor");
  });
});

/* ================================================================== */
/* ④ THE MONEY. A WORKED MONTH, RECOMPUTED BY HAND.                    */
/* ================================================================== */

/**
 * ⚠️ THESE ARE ARITHMETIC EXPECTATIONS, NOT `expect(x).toBe(compute(x))`.
 * A test that re-runs the implementation proves the implementation is
 * deterministic and nothing else. The figures below were worked out from
 * Rule 42 on paper, which is what the panel is asking the operator to be
 * able to do.
 */
describe("a developer's month, end to end", () => {
  /* ---- The month -------------------------------------------------
   * ₹1,00,000 of input tax on the period's inputs and input services,
   * in CGST+SGST only, split:
   *   ₹  5,000  exclusively non-business   (T1)
   *   ₹  7,000  exclusively exempt         (T2)
   *   ₹ 13,000  blocked by Section 17(5)   (T3)
   *   ₹ 40,000  exclusively taxable        (T4)
   *   ₹ 35,000  common                     (the rest)
   * Turnover: ₹33,00,000 exempt of ₹97,00,000 total.
   * ---------------------------------------------------------------- */

  const heads = (cgst: number, sgst: number) => ({
    cgstMinor: r(cgst),
    sgstMinor: r(sgst),
    igstMinor: 0n,
    cessMinor: 0n,
  });

  const lines: AttributedLine[] = [
    { rule42Attribution: "exclusively_non_business", heads: heads(2_500, 2_500) },
    { rule42Attribution: "exclusively_exempt", heads: heads(3_500, 3_500) },
    { rule42Attribution: "blocked", heads: heads(6_500, 6_500) },
    { rule42Attribution: "exclusively_taxable", heads: heads(20_000, 20_000) },
    { rule42Attribution: "common", heads: heads(17_500, 17_500) },
    // ⚠️ A CHILLER. Capital, common — Rule 43's subject, not Rule 42's,
    // and it must not appear in C1 at all.
    {
      rule42Attribution: "common",
      isCapitalGoods: true,
      heads: heads(30_000, 30_000),
    },
  ];

  it("⭐ capital goods are held out of C1 entirely", () => {
    const buckets = bucketRule42(lines);
    // ₹50,000 per head of inputs and input services. The ₹30,000 chiller
    // slice is NOT in it — putting it through Rule 42 would reverse in one
    // month what the law spreads over sixty.
    expect(buckets.totalCredit.cgstMinor).toBe(r(50_000));
    expect(buckets.capitalCommon.cgstMinor).toBe(r(30_000));
  });

  it("⭐⭐ the reversal is what Rule 42 says it is, to the paisa", () => {
    const buckets = bucketRule42(lines);
    const result = apportionRule42({
      totalCreditMinor: buckets.totalCredit.cgstMinor,
      nonBusinessMinor: buckets.nonBusiness.cgstMinor,
      exemptMinor: buckets.exempt.cgstMinor,
      blockedMinor: buckets.blocked.cgstMinor,
      taxableMinor: buckets.taxable.cgstMinor,
      exemptTurnoverMinor: r(33_00_000),
      totalTurnoverMinor: r(97_00_000),
    });

    // C2 = 50,000 − (2,500 + 3,500 + 6,500) = 37,500
    expect(result.c2).toBe(r(37_500));
    // C3 = 37,500 − 20,000 = 17,500  ← the common credit
    expect(result.c3).toBe(r(17_500));

    // D1 = C3 × E ÷ F = 1,750,000 × 3,300,000 ÷ 9,700,000 paise
    //    = 5,775,000,000,000 ÷ 9,700,000 = 595,360.824…  → 595,361 paise
    expect(result.d1).toBe(595_361n);
    // D2 = 5% of C3 = 87,500 paise
    expect(result.d2).toBe(r(875));
    // The reversal reported in Table 4(B)(1) for this head.
    expect(result.totalReversalMinor).toBe(595_361n + 87_500n);

    // 33 ÷ 97 = 0.340206… → 3402 bps, truncated. The ratio is REPORTED,
    // never used to compute D1 — a bps-rounded ratio applied to C3 would
    // give 595,350 paise and contradict the figure it explains.
    expect(result.exemptRatioBps).toBe(3402);

    // ⭐ And the partition still closes exactly.
    expect(
      result.t1 + result.t2 + result.t3 + result.t4 + result.d1 + result.d2 + result.eligibleCommonMinor,
    ).toBe(result.c1);
  });

  it("⚠️ four heads are run separately, because they are not in one ratio", () => {
    const buckets = bucketRule42(lines);
    const byHead = apportionRule42ByHead({
      totalCredit: buckets.totalCredit,
      nonBusiness: buckets.nonBusiness,
      exempt: buckets.exempt,
      blocked: buckets.blocked,
      taxable: buckets.taxable,
      exemptTurnoverMinor: r(33_00_000),
      totalTurnoverMinor: r(97_00_000),
    });

    expect(byHead.reversal.cgstMinor).toBe(595_361n + 87_500n);
    expect(byHead.reversal.sgstMinor).toBe(595_361n + 87_500n);
    // Nothing was charged as IGST this month, so nothing reverses there.
    // A single computation on the summed credit split back by ratio would
    // have put a figure here, and the return takes the four, not the sum.
    expect(byHead.reversal.igstMinor).toBe(0n);
    expect(byHead.reversal.cessMinor).toBe(0n);
  });

  /**
   * ⭐ THE PARTIAL RECOMPUTE THE PANEL SHOWS. Only two facts about a line
   * survive on the row — what it is and what it is for — so the working
   * asks the engine the honest question: on the face of this line, is it
   * blocked? A line stored eligible that the engine blocks is a line
   * living on a proviso somebody has to be able to evidence.
   */
  it("names the lines that are eligible only on a Section 17(5) proviso", () => {
    // A canteen bill. On its face, 17(5)(b).
    const onItsFace = determineItcEligibility({
      itcPurpose: "taxable_supply",
      expenditureNature: "food_and_beverage",
      hasValidTaxInvoice: true,
    });
    expect(onItsFace.eligibility).toBe("blocked");
    expect(onItsFace.statutoryRef).toContain("17(5)(b)");

    // The same bill where the Factories Act makes the canteen mandatory.
    // That fact is not a column, which is exactly why the panel flags it.
    const withTheProviso = determineItcEligibility({
      itcPurpose: "taxable_supply",
      expenditureNature: "food_and_beverage",
      hasValidTaxInvoice: true,
      statutoryObligationToEmployees: true,
    });
    expect(withTheProviso.eligibility).toBe("eligible");
  });

  /**
   * 🔴 THE MOST EXPENSIVE CLAUSE IN THE PRODUCT, ASSERTED ON THE PATH THE
   * PANEL USES. Own-account construction is blocked by 17(5)(d) with no
   * proviso reachable from these two facts, so the working can state the
   * clause without qualification.
   */
  it("own-account construction is blocked outright, with the clause named", () => {
    const verdict = determineItcEligibility({
      itcPurpose: "own_account_construction",
      expenditureNature: "works_contract",
      hasValidTaxInvoice: true,
    });
    expect(verdict.eligibility).toBe("blocked");
    expect(verdict.statutoryRef).toContain("17(5)(d)");
    expect(verdict.rule42Attribution).toBe("blocked");
  });
});
