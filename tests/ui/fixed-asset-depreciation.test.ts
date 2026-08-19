/**
 * Ordence — ⭐⭐⭐ DEPRECIATION: THE PROPERTIES, NOT THE NUMBERS
 * Batch 100 · v1.53.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THIS FILE PINS NO TOTALS, NO COUNTS AND NO IDENTIFIERS
 * ══════════════════════════════════════════════════════════════════════
 * `expect(list.size).toBe(71)` has failed four correct changes in this
 * repository. So every assertion below is an INVARIANT: accumulated
 * depreciation lands exactly on cost less residual, a block never goes
 * negative without a taxable gain to account for it, the half rate
 * applies if and only if the asset was in use for under 180 days.
 *
 * The few literal figures that do appear are the ones the statute itself
 * fixes — 180 days, 5%, +50% for a double shift — and each is asserted as
 * a boundary either side of the line rather than as a magic total.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE TEST THIS BATCH EXISTS FOR IS `configuration changes the number`
 * ══════════════════════════════════════════════════════════════════════
 * Seven times in this codebase a field has been declared and enforced by
 * nothing: `valuation_method` read at zero computations, `require_mfa`
 * stored and never checked, thirty-four entitlement keys never gated.
 * The block below takes one asset, changes ONE configured value at a
 * time, and asserts the computed charge MOVES. A column that can be
 * changed without changing any number is not configuration; it is
 * decoration with a migration attached.
 */

import { describe, expect, it } from "vitest";
import {
  SCHEDULE_II,
  bookDisposal,
  companiesActCharge,
  companiesActSchedule,
  daysInUseInYear,
  depreciableBaseMinor,
  incomeTaxBlockYear,
  inclusiveDays,
  IT_RATES_BY_CLASS,
  mulDivFloor,
  isHalfRateAddition,
  residualMinor,
  shiftFactorBp,
  temporaryDifference,
  usefulLifeDays,
  wdvRateBp,
  DepreciationError,
  type FixedAssetFacts,
  type ItBlockFacts,
} from "@/lib/fixed-assets/depreciation";
import {
  FIXED_ASSET_ROLE_META,
  buildDepreciationPosting,
  buildDisposalPosting,
  fixedAssetRolesUsed,
  PostingImbalance,
} from "@/lib/accounting/sales-posting";

/* ------------------------------------------------------------------ */
/* FIXTURES                                                            */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ AN AWKWARD COST ON PURPOSE. ₹10,00,000.01 does not divide evenly by
 * anything, which is the only kind of number that can reveal a rounding
 * rule that loses paise.
 */
const PLANT: FixedAssetFacts = {
  id: "asset-1",
  assetNo: "PM-001",
  assetClass: "plant_machinery_general",
  costMinor: 100_000_001n,
  residualBp: 500,
  residualJustification: null,
  // Schedule II Part C IV(i) — fifteen years, so no justification is needed.
  usefulLifeMonths: 180,
  lifeJustification: null,
  method: "slm",
  shiftUsage: "single",
  putToUseOn: "2025-04-01",
  disposedOn: null,
  accumulatedDepreciationMinor: 0n,
};

const FY26 = { from: "2025-04-01", to: "2026-03-31" } as const;

function sumSchedule(facts: FixedAssetFacts): bigint {
  return companiesActSchedule(facts).reduce((s, l) => s + l.chargeMinor, 0n);
}

/* ================================================================== */
/* ① THE SCHEDULE TERMINATES EXACTLY, ON BOTH METHODS                  */
/* ================================================================== */

describe("a full-life schedule lands exactly on cost less residual", () => {
  /**
   * 🔴 THE PROPERTY AN AUDITOR ACTUALLY TESTS. Not "to the rupee" — to
   * the paisa. A fixed asset register that is three paise away from the
   * ledger does not tie, and a register that does not tie is not evidence
   * of anything.
   */
  it("straight line, with a cost that divides evenly by nothing", () => {
    const total = sumSchedule(PLANT);
    expect(total).toBe(depreciableBaseMinor(PLANT));
  });

  it("written-down value, where the curve only approaches the residual", () => {
    const total = sumSchedule({ ...PLANT, method: "wdv" });
    expect(total).toBe(depreciableBaseMinor({ ...PLANT, method: "wdv" }));
  });

  it("holds for an odd life and an odd residual too", () => {
    const odd: FixedAssetFacts = {
      ...PLANT,
      costMinor: 7_777_777n,
      usefulLifeMonths: 37,
      lifeJustification: "Technical assessment: the plant is on a 37-month site contract.",
      residualBp: 137,
    };
    expect(sumSchedule(odd)).toBe(depreciableBaseMinor(odd));
    expect(sumSchedule({ ...odd, method: "wdv" })).toBe(depreciableBaseMinor(odd));
  });

  it("never charges more than the depreciable base in any single period", () => {
    for (const method of ["slm", "wdv"] as const) {
      const lines = companiesActSchedule({ ...PLANT, method });
      let accumulated = 0n;
      for (const line of lines) {
        expect(line.chargeMinor >= 0n).toBe(true);
        accumulated += line.chargeMinor;
        // 🔴 THE INVARIANT: accumulated depreciation never exceeds the
        // depreciable base, at any point in the life, on either method.
        expect(accumulated <= depreciableBaseMinor(PLANT)).toBe(true);
        expect(line.closingCarryingMinor >= residualMinor(PLANT)).toBe(true);
      }
    }
  });

  it("charges nothing once the asset is at its residual value", () => {
    const spent: FixedAssetFacts = {
      ...PLANT,
      accumulatedDepreciationMinor: depreciableBaseMinor(PLANT),
    };
    expect(companiesActCharge(spent, FY26).chargeMinor).toBe(0n);
  });
});

/* ================================================================== */
/* ② 🔴 CONFIGURATION CHANGES THE NUMBER                               */
/* ================================================================== */

describe("every configured value is read at the computation", () => {
  const baseline = companiesActCharge(PLANT, FY26).chargeMinor;

  it("the METHOD changes the charge", () => {
    const wdv = companiesActCharge({ ...PLANT, method: "wdv" }, FY26).chargeMinor;
    expect(wdv).not.toBe(baseline);
  });

  it("the USEFUL LIFE changes the charge", () => {
    const shorter = companiesActCharge(
      {
        ...PLANT,
        usefulLifeMonths: 120,
        lifeJustification: "Technical advice: continuous outdoor use in coastal conditions.",
      },
      FY26,
    ).chargeMinor;
    expect(shorter).not.toBe(baseline);
    // A shorter life spreads the same base over less time.
    expect(shorter > baseline).toBe(true);
  });

  it("the RESIDUAL VALUE changes the charge", () => {
    const none = companiesActCharge({ ...PLANT, residualBp: 0 }, FY26).chargeMinor;
    expect(none).not.toBe(baseline);
    expect(none > baseline).toBe(true);
  });

  it("the SHIFT USAGE changes the charge on plant, by exactly the note 6 uplift", () => {
    const double = companiesActCharge({ ...PLANT, shiftUsage: "double" }, FY26).chargeMinor;
    const triple = companiesActCharge({ ...PLANT, shiftUsage: "triple" }, FY26).chargeMinor;
    expect(double).not.toBe(baseline);
    expect(triple).not.toBe(double);
    // Schedule II Part A note 6: +50% and +100%.
    expect(double).toBe((baseline * 15000n) / 10000n);
    expect(triple).toBe((baseline * 20000n) / 10000n);
  });

  it("the ASSET CLASS decides whether the shift uplift applies at all", () => {
    /**
     * ⭐ NESD IS DERIVED FROM THE CLASS, NOT STORED AS A FLAG. A building
     * worked three shifts does not wear out faster in the eyes of
     * Schedule II, and nobody should be able to tick a box that says it
     * does.
     */
    const building: FixedAssetFacts = {
      ...PLANT,
      assetClass: "building_rcc",
      usefulLifeMonths: SCHEDULE_II.building_rcc.usefulLifeMonths as number,
    };
    const single = companiesActCharge(building, FY26).chargeMinor;
    const triple = companiesActCharge({ ...building, shiftUsage: "triple" }, FY26).chargeMinor;
    expect(triple).toBe(single);
    expect(shiftFactorBp("building_rcc", "triple")).toBe(10000);
    expect(shiftFactorBp("plant_machinery_general", "triple")).toBe(20000);
  });

  it("the PUT-TO-USE DATE changes the charge, pro rata by days", () => {
    const halfYear = companiesActCharge({ ...PLANT, putToUseOn: "2025-10-01" }, FY26)
      .chargeMinor;
    expect(halfYear).not.toBe(baseline);
    expect(halfYear < baseline).toBe(true);
    /**
     * ⭐ AND IT IS PRO RATA BY DAYS, EXACTLY — not "about half". 1 October
     * to 31 March is 182 of the year's 365 days, so twice the charge is
     * three days short of a full year rather than equal to one. Asserting
     * "roughly half" would pass on a month-count implementation, which is
     * the thing Schedule II's pro-rata rule is not.
     */
    const days = inclusiveDays("2025-10-01", "2026-03-31");
    expect(halfYear).toBe(
      mulDivFloor(
        depreciableBaseMinor(PLANT),
        BigInt(days),
        BigInt(usefulLifeDays(PLANT)),
      ),
    );
  });

  it("the tax RATE on a block changes the allowance", () => {
    const block = (rateBp: number) =>
      incomeTaxBlockYear(
        {
          blockId: "b",
          blockName: "Plant & machinery @ rate",
          blockClass: "plant_machinery",
          rateBp,
          openingWdvMinor: 10_000_000n,
          additions: [],
          disposals: [],
          assetsRemaining: 3,
        },
        { fyStart: "2025-04-01", fyEnd: "2026-03-31" },
      ).depreciationMinor;
    expect(block(1500)).not.toBe(block(4000));
  });
});

/* ================================================================== */
/* ③ WHAT THE ENGINE REFUSES                                           */
/* ================================================================== */

describe("configuration the statute does not permit stops the computation", () => {
  it("refuses a life that departs from Schedule II with no justification", () => {
    expect(() =>
      companiesActCharge({ ...PLANT, usefulLifeMonths: 300 }, FY26),
    ).toThrow(DepreciationError);
  });

  it("accepts the same life once the justification is recorded", () => {
    const line = companiesActCharge(
      {
        ...PLANT,
        usefulLifeMonths: 300,
        lifeJustification: "Technical advice from the OEM; disclosed in note 2 to the accounts.",
      },
      FY26,
    );
    expect(line.chargeMinor > 0n).toBe(true);
  });

  it("refuses a residual above the 5% ceiling with no justification, and takes 5% itself", () => {
    expect(() => companiesActCharge({ ...PLANT, residualBp: 1000 }, FY26)).toThrow(
      DepreciationError,
    );
    // The ceiling itself is fine — the note caps at five per cent.
    expect(() => companiesActCharge({ ...PLANT, residualBp: 500 }, FY26)).not.toThrow();
  });

  it("refuses a method it does not implement rather than defaulting to one", () => {
    expect(() =>
      companiesActCharge(
        { ...PLANT, method: "sum_of_digits" as unknown as FixedAssetFacts["method"] },
        FY26,
      ),
    ).toThrow(DepreciationError);
  });

  it("refuses the reducing-balance method with a nil residual", () => {
    // 🔴 The rate is 1 − (residual ÷ cost)^(1/n), which is 100% at nil.
    expect(() =>
      companiesActCharge({ ...PLANT, method: "wdv", residualBp: 0 }, FY26),
    ).toThrow(DepreciationError);
  });

  it("refuses a period that crosses 31 March", () => {
    expect(() =>
      companiesActCharge(PLANT, { from: "2025-10-01", to: "2026-09-30" }),
    ).toThrow(DepreciationError);
  });
});

/* ================================================================== */
/* ④ THE DERIVED WDV RATE                                              */
/* ================================================================== */

describe("the written-down value rate is derived from the useful life", () => {
  /**
   * ⚠️ THESE TWO ARE THE PUBLISHED SCHEDULE II WDV RATES, and they are
   * asserted because they are the statute's own arithmetic rather than
   * this engine's choice: 1 − (5% residual)^(1/n).
   */
  it("gives 18.10% for fifteen-year plant at a 5% residual", () => {
    expect(wdvRateBp(PLANT)).toBe(1810);
  });

  it("gives 4.87% for a sixty-year building", () => {
    expect(
      wdvRateBp({
        ...PLANT,
        assetClass: "building_rcc",
        usefulLifeMonths: 720,
        method: "wdv",
      }),
    ).toBe(487);
  });

  it("charges more in the first year than in the last, which straight line does not", () => {
    const wdvYears = companiesActSchedule({ ...PLANT, method: "wdv" });
    const slmYears = companiesActSchedule(PLANT);
    expect(wdvYears[0]!.chargeMinor > wdvYears[1]!.chargeMinor).toBe(true);
    // Straight line is flat across whole years; the first two full years
    // of an asset put to use on 1 April are identical.
    expect(slmYears[0]!.chargeMinor).toBe(slmYears[1]!.chargeMinor);
  });
});

/* ================================================================== */
/* ⑤ DAY ARITHMETIC AND THE 180-DAY RULE                               */
/* ================================================================== */

describe("days are inclusive at both ends and the same count decides both statutes", () => {
  it("counts a financial year as 365 days, and a leap year as 366", () => {
    expect(inclusiveDays("2025-04-01", "2026-03-31")).toBe(365);
    expect(inclusiveDays("2023-04-01", "2024-03-31")).toBe(366);
  });

  it("gives a twelve-month life exactly one year of days", () => {
    expect(
      usefulLifeDays({ putToUseOn: "2025-04-01", usefulLifeMonths: 12 }),
    ).toBe(365);
  });

  /**
   * 🔴 THE HALF-RATE RULE APPLIES IF AND ONLY IF THE ASSET WAS IN USE FOR
   * UNDER 180 DAYS — the second proviso to s.32(1). The boundary is worth
   * a day of anybody's attention: on a 15% block it is worth 7.5% of the
   * cost of the asset.
   */
  it("puts the boundary at exactly 180 days, not at a month", () => {
    expect(daysInUseInYear("2025-10-03", "2026-03-31")).toBe(180);
    expect(isHalfRateAddition("2025-10-03", "2026-03-31")).toBe(false);
    expect(daysInUseInYear("2025-10-04", "2026-03-31")).toBe(179);
    expect(isHalfRateAddition("2025-10-04", "2026-03-31")).toBe(true);
  });

  it("halves the allowance on the half-rate side of that boundary and not on the other", () => {
    const year = (putToUseOn: string) =>
      incomeTaxBlockYear(
        {
          blockId: "b",
          blockName: "Plant & machinery @ 15%",
          blockClass: "plant_machinery",
          rateBp: 1500,
          openingWdvMinor: 0n,
          additions: [
            { assetId: "a1", assetNo: "PM-9", actualCostMinor: 10_000_000n, putToUseOn },
          ],
          disposals: [],
          assetsRemaining: 1,
        },
        { fyStart: "2025-04-01", fyEnd: "2026-03-31" },
      );

    const full = year("2025-10-03");
    const half = year("2025-10-04");
    expect(half.depreciationMinor * 2n).toBe(full.depreciationMinor);
    expect(half.halfRateAdditionsMinor > 0n).toBe(true);
    expect(full.halfRateAdditionsMinor).toBe(0n);
  });
});

/* ================================================================== */
/* ⑥ THE BLOCK OF ASSETS                                               */
/* ================================================================== */

const BLOCK: ItBlockFacts = {
  blockId: "block-pm",
  blockName: "Plant & machinery @ 15%",
  blockClass: "plant_machinery",
  rateBp: 1500,
  openingWdvMinor: 50_000_000n,
  additions: [],
  disposals: [],
  assetsRemaining: 4,
};
const FY = { fyStart: "2025-04-01", fyEnd: "2026-03-31" } as const;

describe("a block of assets behaves as section 32 says it does", () => {
  it("never closes at a negative written-down value", () => {
    const sold = incomeTaxBlockYear(
      {
        ...BLOCK,
        disposals: [
          {
            assetId: "x",
            assetNo: "PM-4",
            moneysPayableMinor: 80_000_000n,
            disposedOn: "2025-09-01",
          },
        ],
        assetsRemaining: 3,
      },
      FY,
    );
    expect(sold.closingWdvMinor >= 0n).toBe(true);
    // 🔴 AND THE EXCESS IS NOT LOST — s.50(1) makes it a taxable gain.
    expect(sold.shortTermCapitalGainMinor > 0n).toBe(true);
    expect(sold.depreciationMinor).toBe(0n);
  });

  it("allows no depreciation in a year the block is exhausted, whatever is left in it", () => {
    const exhausted = incomeTaxBlockYear(
      {
        ...BLOCK,
        disposals: [
          {
            assetId: "x",
            assetNo: "PM-4",
            moneysPayableMinor: BLOCK.openingWdvMinor + 1n,
            disposedOn: "2025-09-01",
          },
        ],
        assetsRemaining: 3,
      },
      FY,
    );
    expect(exhausted.depreciationMinor).toBe(0n);
    expect(exhausted.shortTermCapitalGainMinor).toBe(1n);
  });

  it("gives a capital loss and no depreciation when the last asset leaves", () => {
    const emptied = incomeTaxBlockYear(
      {
        ...BLOCK,
        disposals: [
          {
            assetId: "x",
            assetNo: "PM-4",
            moneysPayableMinor: 10_000_000n,
            disposedOn: "2026-01-01",
          },
        ],
        assetsRemaining: 0,
      },
      FY,
    );
    expect(emptied.blockCeases).toBe(true);
    expect(emptied.depreciationMinor).toBe(0n);
    expect(emptied.shortTermCapitalLossMinor).toBe(
      BLOCK.openingWdvMinor - 10_000_000n,
    );
    expect(emptied.closingWdvMinor).toBe(0n);
  });

  it("reduces the block by the proceeds before applying the rate", () => {
    const plain = incomeTaxBlockYear(BLOCK, FY);
    const afterSale = incomeTaxBlockYear(
      {
        ...BLOCK,
        disposals: [
          {
            assetId: "x",
            assetNo: "PM-4",
            moneysPayableMinor: 10_000_000n,
            disposedOn: "2025-06-01",
          },
        ],
        assetsRemaining: 3,
      },
      FY,
    );
    expect(afterSale.depreciationMinor < plain.depreciationMinor).toBe(true);
    expect(afterSale.closingWdvMinor).toBe(
      BLOCK.openingWdvMinor - 10_000_000n - afterSale.depreciationMinor,
    );
  });

  it("closes at exactly opening plus additions less proceeds less depreciation", () => {
    const year = incomeTaxBlockYear(
      {
        ...BLOCK,
        additions: [
          {
            assetId: "n1",
            assetNo: "PM-9",
            actualCostMinor: 12_345_679n,
            putToUseOn: "2025-05-01",
          },
          {
            assetId: "n2",
            assetNo: "PM-10",
            actualCostMinor: 7_654_321n,
            putToUseOn: "2026-02-01",
          },
        ],
        disposals: [
          {
            assetId: "x",
            assetNo: "PM-1",
            moneysPayableMinor: 3_000_000n,
            disposedOn: "2025-12-01",
          },
        ],
        assetsRemaining: 5,
      },
      FY,
    );
    const expected =
      BLOCK.openingWdvMinor +
      12_345_679n +
      7_654_321n -
      3_000_000n -
      year.depreciationMinor;
    expect(year.closingWdvMinor).toBe(expected);
  });

  it("refuses a rate that is not a percentage", () => {
    expect(() => incomeTaxBlockYear({ ...BLOCK, rateBp: 12000 }, FY)).toThrow(
      DepreciationError,
    );
  });

  /**
   * 🔴 THE BLOCK CLASS IS READ, NOT STORED AND FORGOTTEN. A block labelled
   * "furniture" carrying 40% is not a judgement somebody made — it is a
   * typo that inflates the allowance fourfold and is carried in that
   * pool's written-down value for as long as the company exists.
   */
  it("refuses a rate that appears nowhere in Appendix I for the class", () => {
    expect(() =>
      incomeTaxBlockYear(
        { ...BLOCK, blockClass: "furniture_fittings", rateBp: 4000 },
        FY,
      ),
    ).toThrow(DepreciationError);
    // 10% is the furniture rate, and it computes.
    expect(
      incomeTaxBlockYear(
        { ...BLOCK, blockClass: "furniture_fittings", rateBp: 1000 },
        FY,
      ).depreciationMinor > 0n,
    ).toBe(true);
  });

  it("permits every rate Appendix I prescribes for the class, and nothing else", () => {
    for (const [blockClass, rates] of Object.entries(IT_RATES_BY_CLASS)) {
      for (const rateBp of rates) {
        expect(() =>
          incomeTaxBlockYear(
            { ...BLOCK, blockClass: blockClass as ItBlockFacts["blockClass"], rateBp },
            FY,
          ),
        ).not.toThrow();
      }
      // One basis point off a prescribed rate is not a prescribed rate.
      expect(() =>
        incomeTaxBlockYear(
          {
            ...BLOCK,
            blockClass: blockClass as ItBlockFacts["blockClass"],
            rateBp: (rates[0] as number) + 1,
          },
          FY,
        ),
      ).toThrow(DepreciationError);
    }
  });
});

/* ================================================================== */
/* ⑦ DISPOSAL — THE TWO TREATMENTS DIVERGE, DELIBERATELY               */
/* ================================================================== */

describe("the Companies Act and the Income-tax Act disagree about a disposal", () => {
  it("books a profit at asset level while the block produces no gain at all", () => {
    const book = bookDisposal({
      costMinor: 10_000_000n,
      accumulatedMinor: 6_000_000n,
      considerationMinor: 6_000_000n,
    });
    expect(book.carryingAmountMinor).toBe(4_000_000n);
    expect(book.gainMinor).toBe(2_000_000n);
    expect(book.lossMinor).toBe(0n);

    /**
     * 🔴 THE SAME SALE, UNDER s.32. The proceeds come off the block and
     * there is no capital gain whatsoever, because other assets remain in
     * it. A product that reported one of these numbers would be wrong
     * about the other.
     */
    const tax = incomeTaxBlockYear(
      {
        ...BLOCK,
        disposals: [
          {
            assetId: "x",
            assetNo: "PM-1",
            moneysPayableMinor: 6_000_000n,
            disposedOn: "2025-12-01",
          },
        ],
        assetsRemaining: 3,
      },
      FY,
    );
    expect(tax.shortTermCapitalGainMinor).toBe(0n);
    expect(tax.shortTermCapitalLossMinor).toBe(0n);
    expect(tax.depreciationMinor > 0n).toBe(true);
  });

  it("books a loss when the consideration is below the carrying amount", () => {
    const book = bookDisposal({
      costMinor: 10_000_000n,
      accumulatedMinor: 1_000_000n,
      considerationMinor: 5_000_000n,
    });
    expect(book.lossMinor).toBe(4_000_000n);
    expect(book.gainMinor).toBe(0n);
  });

  it("charges depreciation up to the day of disposal and no further", () => {
    const line = companiesActCharge({ ...PLANT, disposedOn: "2025-09-30" }, FY26);
    expect(line.daysInUse).toBe(inclusiveDays("2025-04-01", "2025-09-30"));
    expect(line.terminal).toBe(true);
    // ⚠️ AND IT DOES NOT WRITE THE ASSET DOWN TO ITS RESIDUAL VALUE. The
    // un-recovered balance belongs in the profit or loss on sale, which is
    // a different line of the P&L.
    expect(line.closingCarryingMinor > residualMinor(PLANT)).toBe(true);
  });

  it("charges nothing in a period after the asset has gone", () => {
    const line = companiesActCharge({ ...PLANT, disposedOn: "2025-09-30" }, {
      from: "2026-04-01",
      to: "2027-03-31",
    });
    expect(line.chargeMinor).toBe(0n);
  });
});

/* ================================================================== */
/* ⑧ THE DIVERGENCE IS THE DEFERRED TAX INPUT                          */
/* ================================================================== */

describe("book and tax written-down values give the timing difference", () => {
  it("calls a faster tax write-off a deferred tax liability", () => {
    const d = temporaryDifference({
      bookCarryingMinor: 8_000_000n,
      taxWdvMinor: 6_000_000n,
    });
    expect(d.differenceMinor).toBe(2_000_000n);
    expect(d.gives).toBe("deferred_tax_liability");
  });

  it("calls the reverse a deferred tax asset, and computes no tax on either", () => {
    const d = temporaryDifference({
      bookCarryingMinor: 5_000_000n,
      taxWdvMinor: 9_000_000n,
    });
    expect(d.gives).toBe("deferred_tax_asset");
    // ⚠️ NO RATE IS APPLIED ON EITHER SIDE. Which regime a company is in
    // under s.115BAA or s.115BAB decides the rate; whether a deferred tax
    // ASSET may be recognised at all turns on reasonable certainty of
    // future taxable income. Both are judgements, so the engine states the
    // difference and stops.
    expect(d.note).toContain("reasonable certainty");
    expect(
      temporaryDifference({ bookCarryingMinor: 9n, taxWdvMinor: 5n }).note,
    ).toContain("115BAA");
  });

  it("says nothing where the two agree", () => {
    expect(
      temporaryDifference({ bookCarryingMinor: 1n, taxWdvMinor: 1n }).gives,
    ).toBe("none");
  });
});

/* ================================================================== */
/* ⑨ THE JOURNAL                                                       */
/* ================================================================== */

describe("the depreciation and disposal journals balance and name real accounts", () => {
  it("debits the expense and credits accumulated depreciation, never the asset", () => {
    const legs = buildDepreciationPosting({
      totalChargeMinor: 1_234_567n,
      periodLabel: "April 2025",
      assetCount: 12,
    });
    const debits = legs.filter((l) => l.entryType === "debit");
    const credits = legs.filter((l) => l.entryType === "credit");
    expect(debits.reduce((s, l) => s + l.amountMinor, 0n)).toBe(
      credits.reduce((s, l) => s + l.amountMinor, 0n),
    );
    expect(debits.map((l) => l.role)).toContain("depreciation_expense");
    expect(credits.map((l) => l.role)).toContain("accumulated_depreciation");
    // 🔴 Schedule III needs gross block and accumulated depreciation shown
    // separately, so the cost account must not move on a depreciation run.
    expect(legs.map((l) => l.role)).not.toContain("fixed_asset_cost");
  });

  it("refuses to write a journal for a run that charged nothing", () => {
    expect(() =>
      buildDepreciationPosting({
        totalChargeMinor: 0n,
        periodLabel: "April 2025",
        assetCount: 3,
      }),
    ).toThrow(PostingImbalance);
  });

  it("balances a disposal at a profit and at a loss", () => {
    for (const consideration of [6_000_000n, 1_000_000n, 0n]) {
      const legs = buildDisposalPosting({
        assetNo: "PM-001",
        costMinor: 10_000_000n,
        accumulatedMinor: 6_000_000n,
        considerationMinor: consideration,
        disposedOn: "2025-12-01",
      });
      const debit = legs
        .filter((l) => l.entryType === "debit")
        .reduce((s, l) => s + l.amountMinor, 0n);
      const credit = legs
        .filter((l) => l.entryType === "credit")
        .reduce((s, l) => s + l.amountMinor, 0n);
      expect(debit).toBe(credit);
      // The gross cost always leaves the block at COST, never at WDV.
      const cost = legs.find((l) => l.role === "fixed_asset_cost");
      expect(cost?.amountMinor).toBe(10_000_000n);
      expect(cost?.entryType).toBe("credit");
    }
  });

  it("has a mapping description for every role either journal can use", () => {
    const roles = new Set([
      ...fixedAssetRolesUsed(
        buildDepreciationPosting({
          totalChargeMinor: 100n,
          periodLabel: "x",
          assetCount: 1,
        }),
      ),
      ...fixedAssetRolesUsed(
        buildDisposalPosting({
          assetNo: "a",
          costMinor: 100n,
          accumulatedMinor: 10n,
          considerationMinor: 500n,
          disposedOn: "2025-12-01",
        }),
      ),
      ...fixedAssetRolesUsed(
        buildDisposalPosting({
          assetNo: "a",
          costMinor: 100n,
          accumulatedMinor: 10n,
          considerationMinor: 1n,
          disposedOn: "2025-12-01",
        }),
      ),
    ]);
    for (const role of roles) {
      const meta = FIXED_ASSET_ROLE_META[role];
      expect(meta, role).toBeDefined();
      expect(meta.label.length > 0, role).toBe(true);
      expect(meta.help.length > 0, role).toBe(true);
    }
    // ⚠️ ACCUMULATED DEPRECIATION IS A CONTRA-ASSET AND IS TYPED AS ONE.
    expect(FIXED_ASSET_ROLE_META.accumulated_depreciation.accountType).toBe("asset");
    expect(FIXED_ASSET_ROLE_META.depreciation_expense.accountType).toBe("expense");
    expect(FIXED_ASSET_ROLE_META.asset_disposal_gain.accountType).toBe("revenue");
    expect(FIXED_ASSET_ROLE_META.asset_disposal_loss.accountType).toBe("expense");
  });
});

/* ================================================================== */
/* ⑩ COMPONENT ACCOUNTING                                              */
/* ================================================================== */

describe("a component with its own life depreciates separately", () => {
  /**
   * Schedule II Part A note 4. The point of the carve-out is that the two
   * rows together depreciate exactly what the whole asset cost — no more.
   */
  it("a carved-out component and its parent together charge the whole cost", () => {
    const whole = 30_000_000n;
    const componentCost = 4_000_000n;

    const parent: FixedAssetFacts = {
      ...PLANT,
      id: "p",
      assetNo: "PM-100",
      costMinor: whole - componentCost,
    };
    const component: FixedAssetFacts = {
      ...PLANT,
      id: "c",
      assetNo: "PM-100-ENG",
      costMinor: componentCost,
      usefulLifeMonths: 60,
      lifeJustification: "The engine is replaced every five years under the maintenance contract.",
    };

    const together = sumSchedule(parent) + sumSchedule(component);
    const base = depreciableBaseMinor(parent) + depreciableBaseMinor(component);
    expect(together).toBe(base);
    // And the component reaches its residual sooner than the parent does.
    expect(companiesActSchedule(component).length).toBeLessThan(
      companiesActSchedule(parent).length,
    );
  });
});
