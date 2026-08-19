/**
 * Ordence — ⭐⭐⭐ REAL ESTATE COMPLETION
 * Version: v1.25.0-alpha · Batch 17
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 TWO STATUTORY DEFECTS ARE UNDER TEST HERE, AND BOTH WERE LIVE
 * ══════════════════════════════════════════════════════════════════════
 * ① 194H has been 2% since 1 October 2024 and this codebase deducted 5%.
 * ② The ₹20,000 threshold is `aggregate_whole` — the product's own TDS
 *    section table says so — and the arithmetic treated it as per
 *    payment.
 *
 * ⚠️ SO THE ASSERTIONS ARE WORKED EXAMPLES WITH REAL NUMBERS. A test
 * that re-runs the implementation proves the implementation is
 * deterministic and nothing else, and neither of these defects would
 * have failed such a test.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  computeCommission,
  computeTds,
  resolve194hRateBps,
  resolve194hThresholdMinor,
  rateChangedDuring,
  TDS_194H_RATE_HISTORY,
  TDS_194H_THRESHOLD_HISTORY,
  TDS_NO_PAN_BPS,
} from "@/lib/sales/commission";
import {
  cancellationProblem,
  creditNoteWindowCloses,
  creditNoteWindowClosed,
  forfeitureWarning,
  irrecoverableTaxMinor,
  FORFEITURE_GUIDANCE,
  type CancellationFacts,
} from "@/lib/sales/cancellation";
import {
  assertPropertyBalances,
  buildBrokeragePosting,
  buildCancellationPosting,
  buildPartnerPaymentPosting,
  buildRefundPaymentPosting,
  propertyRolesUsed,
  PROPERTY_ROLE_META,
} from "@/lib/accounting/sales-posting";
import { financialYearWindow } from "@/lib/gst/constants";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/* ================================================================== */
/* 🔴 SECTION 194H — THE RATE                                          */
/* ================================================================== */

describe("194H · the rate is effective-dated", () => {
  it("is 2% for a credit made today, not 5%", () => {
    expect(resolve194hRateBps("2026-08-14")).toBe(200);
  });

  it("is 2% from the day the change took effect", () => {
    expect(resolve194hRateBps("2024-10-01")).toBe(200);
  });

  it("is still 5% on the day before it", () => {
    expect(resolve194hRateBps("2024-09-30")).toBe(500);
  });

  /**
   * ⚠️ THE ORDERING OF THE HISTORY IS LOAD-BEARING. `resolve` takes the
   * first entry whose `from` is on or before the date, so a newest-last
   * array would answer every question with the 2007 rate. Asserting the
   * order rather than trusting the comment above it.
   */
  it("keeps the rate history newest first", () => {
    for (let i = 1; i < TDS_194H_RATE_HISTORY.length; i += 1) {
      expect(TDS_194H_RATE_HISTORY[i - 1]!.from > TDS_194H_RATE_HISTORY[i]!.from).toBe(true);
    }
  });

  it("keeps the threshold history newest first", () => {
    for (let i = 1; i < TDS_194H_THRESHOLD_HISTORY.length; i += 1) {
      expect(
        TDS_194H_THRESHOLD_HISTORY[i - 1]!.from > TDS_194H_THRESHOLD_HISTORY[i]!.from,
      ).toBe(true);
    }
  });

  it("resolves the ₹20,000 threshold for this year and ₹15,000 before April 2025", () => {
    expect(resolve194hThresholdMinor("2026-08-14")).toBe(2_000_000n);
    expect(resolve194hThresholdMinor("2025-03-31")).toBe(1_500_000n);
  });

  it("knows when a span straddles the rate change", () => {
    expect(rateChangedDuring("2024-06-01", "2024-12-01")).toBe(true);
    expect(rateChangedDuring("2025-06-01", "2025-12-01")).toBe(false);
  });

  /**
   * 🔴 THE REGRESSION GUARD FOR DEFECT ①. If somebody restores the
   * literal 500 to the current rate, this fails with a sentence naming
   * the date it changed.
   */
  it("the file no longer carries 5% as the current rate", () => {
    const source = read("lib/sales/commission.ts");
    expect(source).toContain("TDS_194H_BPS = 200");
    expect(source).toContain("2024-10-01");
  });
});

/* ================================================================== */
/* 🔴🔴 SECTION 194H — `aggregate_whole`                               */
/* ================================================================== */

describe("194H · the threshold is on the year, and once crossed on all of it", () => {
  const day = "2026-08-14";

  it("deducts nothing below the annual threshold", () => {
    const r = computeTds({ grossMinor: 1_500_000n, hasPan: true, onDate: day });
    expect(r.applicable).toBe(false);
    expect(r.tdsMinor).toBe(0n);
  });

  /**
   * ⭐⭐⭐ THE WORKED EXAMPLE THAT WOULD HAVE CAUGHT DEFECT ②.
   *
   * ₹15,000 in April carried no deduction. ₹10,000 in July crosses the
   * ₹20,000 line, so the chargeable base is the whole ₹25,000 credited
   * this year — not the ₹10,000 on this bill.
   *
   *   correct:  2% of ₹25,000 = ₹500, less ₹0 already deducted = ₹500
   *   old code: 2% of ₹10,000 = ₹200
   *
   * The ₹300 gap carries interest at 1% a month under s.201(1A) and
   * disallows 30% of the expense under s.40(a)(ia).
   */
  it("catches up on the earlier tranches when the threshold is crossed", () => {
    const r = computeTds({
      grossMinor: 1_000_000n,
      hasPan: true,
      onDate: day,
      ytdGrossMinor: 1_500_000n,
      ytdTdsMinor: 0n,
    });
    expect(r.applicable).toBe(true);
    expect(r.chargeableBaseMinor).toBe(2_500_000n);
    expect(r.tdsMinor).toBe(50_000n); // ₹500, not ₹200
    expect(r.explanation).toContain("whole");
  });

  /**
   * ⚠️ AND THE NEXT BILL MUST NOT PAY THE CATCH-UP AGAIN. Without
   * `ytdTdsMinor` the running base would be re-charged in full on every
   * later tranche, and a partner would watch their payout shrink with
   * each booking they won.
   */
  it("does not re-charge the catch-up on the following tranche", () => {
    const r = computeTds({
      grossMinor: 1_000_000n,
      hasPan: true,
      onDate: day,
      ytdGrossMinor: 2_500_000n,
      ytdTdsMinor: 50_000n,
    });
    expect(r.chargeableBaseMinor).toBe(3_500_000n);
    expect(r.tdsMinor).toBe(20_000n); // 2% of this ₹10,000 only
  });

  it("never returns a negative deduction when earlier bills over-deducted", () => {
    const r = computeTds({
      grossMinor: 100_000n,
      hasPan: true,
      onDate: day,
      ytdGrossMinor: 3_000_000n,
      ytdTdsMinor: 500_000n,
    });
    expect(r.tdsMinor).toBe(0n);
  });

  it("applies 20% under section 206AA when there is no PAN", () => {
    const r = computeTds({ grossMinor: 10_000_000n, hasPan: false, onDate: day });
    expect(r.rateBps).toBe(TDS_NO_PAN_BPS);
    expect(r.tdsMinor).toBe(2_000_000n);
    expect(r.explanation).toContain("206AA");
  });

  it("warns when the year straddles the October 2024 rate change", () => {
    const r = computeTds({
      grossMinor: 1_000_000n,
      hasPan: true,
      onDate: "2024-11-15",
      ytdGrossMinor: 2_000_000n,
      ytdTdsMinor: 100_000n,
      ytdEarliestDate: "2024-05-01",
    });
    expect(r.caution).not.toBeNull();
    expect(r.caution).toContain("changed");
  });

  it("says nothing when the year does not straddle a change", () => {
    const r = computeTds({
      grossMinor: 1_000_000n,
      hasPan: true,
      onDate: "2026-01-15",
      ytdGrossMinor: 2_000_000n,
      ytdTdsMinor: 40_000n,
      ytdEarliestDate: "2025-05-01",
    });
    expect(r.caution).toBeNull();
  });

  it("deducts nothing on a nil or negative bill", () => {
    expect(computeTds({ grossMinor: 0n, hasPan: true, onDate: day }).tdsMinor).toBe(0n);
    expect(computeTds({ grossMinor: -100n, hasPan: true, onDate: day }).applicable).toBe(false);
  });
});

/* ================================================================== */
/* THE FINANCIAL-YEAR WINDOW                                           */
/* ================================================================== */

describe("the financial-year window", () => {
  it("runs 1 April to the following 1 April, half-open", () => {
    const w = financialYearWindow("2026-08-14");
    expect(w.start).toBe("2026-04-01");
    expect(w.end).toBe("2027-04-01");
    expect(w.financialYear).toBe("2026-27");
  });

  it("puts March in the year that began the previous April", () => {
    const w = financialYearWindow("2026-03-31");
    expect(w.start).toBe("2025-04-01");
    expect(w.end).toBe("2026-04-01");
  });

  /**
   * ⚠️ THE WHOLE REASON THE END IS EXCLUSIVE. An inclusive "2026-03-31"
   * drops everything timestamped during 31 March, which for a year-end
   * threshold is the busiest day in it.
   */
  it("excludes the first instant of the next year", () => {
    const w = financialYearWindow("2026-06-01");
    expect("2027-04-01" < w.end).toBe(false);
    expect("2027-03-31" < w.end).toBe(true);
  });
});

/* ================================================================== */
/* ⭐⭐ COMMISSION — THE THREE BASES                                    */
/* ================================================================== */

describe("commission across the three bases", () => {
  it("takes a percentage of the agreement value", () => {
    const r = computeCommission({
      basis: "percent_of_sale",
      rateBps: 200,
      agreementValueMinor: 800_000_000n, // ₹80,00,000
    });
    expect(r.grossMinor).toBe(16_000_000n); // ₹1,60,000
    expect(r.problem).toBeNull();
  });

  it("converts months of rent without losing a factor of a hundred", () => {
    const r = computeCommission({
      basis: "months_of_rent",
      rateBps: 0,
      monthsCentis: 150,
      monthlyRentMinor: 4_500_000n, // ₹45,000
    });
    expect(r.grossMinor).toBe(6_750_000n); // ₹67,500, not ₹675
  });

  it("returns a problem rather than throwing on a half-configured partner", () => {
    const r = computeCommission({ basis: "percent_of_sale", rateBps: 200 });
    expect(r.grossMinor).toBe(0n);
    expect(r.problem).not.toBeNull();
  });
});

/* ================================================================== */
/* 🔴🔴🔴 THE CANCELLATION                                             */
/* ================================================================== */

/**
 * A consistent booking, used as the base for the cases below.
 *
 *   Demands raised   ₹10,00,000 principal + ₹50,000 tax = ₹10,50,000
 *   Receipts          ₹8,50,000
 *   So unpaid demands are ₹2,00,000 and the advance is ₹10,00,000.
 *   advance + tax − receivable = 10,00,000 + 50,000 − 2,00,000 = 8,50,000 ✓
 */
const BASE: CancellationFacts = {
  advanceMinor: 100_000_000n,
  receivableMinor: 20_000_000n,
  outputTaxMinor: 5_000_000n,
  cashPaidMinor: 85_000_000n,
  forfeitMinor: 25_000_000n,
  refundMinor: 60_000_000n,
  reversedCgstMinor: 2_500_000n,
  reversedSgstMinor: 2_500_000n,
  reversedIgstMinor: 0n,
};

describe("the cancellation refuses before it computes", () => {
  it("accepts a consistent booking", () => {
    expect(cancellationProblem(BASE)).toBeNull();
  });

  /**
   * 🔴 THE RULE THAT UPGRADED FROM `<=` TO `=`. A smaller total is the
   * quiet failure: some of the buyer's money is neither kept nor
   * returned, and the entry balances anyway.
   */
  it("refuses when forfeit plus refund is LESS than what was paid", () => {
    const problem = cancellationProblem({ ...BASE, refundMinor: 50_000_000n });
    expect(problem).not.toBeNull();
    expect(problem).toContain("unaccounted for");
  });

  it("refuses when forfeit plus refund is MORE than what was paid", () => {
    const problem = cancellationProblem({ ...BASE, refundMinor: 70_000_000n });
    expect(problem).toContain("more than");
  });

  it("refuses a credit note larger than the tax ever charged", () => {
    const problem = cancellationProblem({ ...BASE, reversedCgstMinor: 9_000_000n });
    expect(problem).toContain("cannot take back more");
  });

  /**
   * ⭐ THE LEDGER IDENTITY. Without this check a stray ₹2,00,000 receipt
   * posts as ₹2,00,000 of "irrecoverable tax" — a plausible-looking
   * expense nobody would ever question.
   */
  it("refuses when the booking's own balances do not imply the cash collected", () => {
    const problem = cancellationProblem({
      ...BASE,
      cashPaidMinor: 87_000_000n,
      refundMinor: 62_000_000n,
    });
    expect(problem).toContain("does not agree with its receipts");
  });

  it("refuses negative figures by name", () => {
    const problem = cancellationProblem({ ...BASE, forfeitMinor: -1n });
    expect(problem).toContain("negative");
  });
});

describe("the cancellation posting", () => {
  it("balances and clears every balance the booking carried", () => {
    const legs = buildCancellationPosting({
      advanceMinor: BASE.advanceMinor,
      receivableMinor: BASE.receivableMinor,
      forfeitMinor: BASE.forfeitMinor,
      refundMinor: BASE.refundMinor,
      reversedCgstMinor: BASE.reversedCgstMinor,
      reversedSgstMinor: BASE.reversedSgstMinor,
      reversedIgstMinor: BASE.reversedIgstMinor,
      irrecoverableTaxMinor: irrecoverableTaxMinor(BASE),
      bookingReference: "BKG-0001",
      unitLabel: "A-1204",
      buyerName: "R Iyer",
      creditNoteNumber: "CN-14",
    });

    expect(() => assertPropertyBalances(legs)).not.toThrow();

    const debit = legs
      .filter((l) => l.entryType === "debit")
      .reduce((s, l) => s + l.amountMinor, 0n);
    expect(debit).toBe(BASE.advanceMinor + BASE.outputTaxMinor);

    const roles = propertyRolesUsed(legs);
    expect(roles).toContain("customer_advance");
    expect(roles).toContain("forfeiture_income");
    expect(roles).toContain("buyer_refund_payable");
    expect(roles).toContain("booking_receivable");
  });

  /**
   * ⭐⭐⭐ THE LEG NOBODY EXPECTS. When the section 34 window has closed,
   * the tax cannot be reversed — and the entry still has to balance.
   */
  it("debits irrecoverable tax for whatever the credit note could not reverse", () => {
    const closed: CancellationFacts = {
      ...BASE,
      reversedCgstMinor: 0n,
      reversedSgstMinor: 0n,
      reversedIgstMinor: 0n,
    };
    expect(cancellationProblem(closed)).toBeNull();
    expect(irrecoverableTaxMinor(closed)).toBe(5_000_000n);

    const legs = buildCancellationPosting({
      advanceMinor: closed.advanceMinor,
      receivableMinor: closed.receivableMinor,
      forfeitMinor: closed.forfeitMinor,
      refundMinor: closed.refundMinor,
      reversedCgstMinor: 0n,
      reversedSgstMinor: 0n,
      reversedIgstMinor: 0n,
      irrecoverableTaxMinor: irrecoverableTaxMinor(closed),
      bookingReference: "BKG-0002",
      unitLabel: null,
      buyerName: null,
      creditNoteNumber: null,
    });

    expect(() => assertPropertyBalances(legs)).not.toThrow();
    const stranded = legs.find((l) => l.role === "irrecoverable_output_tax");
    expect(stranded?.amountMinor).toBe(5_000_000n);
    expect(stranded?.entryType).toBe("debit");
  });

  /** ⚠️ Zero legs are dropped, so a fully-reversed cancellation never sees it. */
  it("has no irrecoverable-tax leg when the whole credit note lands", () => {
    const legs = buildCancellationPosting({
      advanceMinor: BASE.advanceMinor,
      receivableMinor: BASE.receivableMinor,
      forfeitMinor: BASE.forfeitMinor,
      refundMinor: BASE.refundMinor,
      reversedCgstMinor: 2_500_000n,
      reversedSgstMinor: 2_500_000n,
      reversedIgstMinor: 0n,
      irrecoverableTaxMinor: 0n,
      bookingReference: "BKG-0003",
      unitLabel: null,
      buyerName: null,
      creditNoteNumber: "CN-9",
    });
    expect(legs.some((l) => l.role === "irrecoverable_output_tax")).toBe(false);
    expect(legs.some((l) => l.role === "output_igst")).toBe(false);
  });

  it("posts the refund against the payable and not against the advance", () => {
    const legs = buildRefundPaymentPosting({
      amountMinor: 60_000_000n,
      bookingReference: "BKG-0001",
      buyerName: "R Iyer",
      paymentReference: "UTR-778",
    });
    expect(() => assertPropertyBalances(legs)).not.toThrow();
    expect(propertyRolesUsed(legs).sort()).toEqual(["bank", "buyer_refund_payable"]);
  });
});

/* ================================================================== */
/* THE FORFEITURE CAP                                                  */
/* ================================================================== */

describe("the forfeiture cap warns rather than refuses", () => {
  it("says nothing at or below ten percent of the consideration", () => {
    expect(
      forfeitureWarning({ forfeitMinor: 80_000_00n, considerationMinor: 800_000_000n }),
    ).toBeNull();
  });

  /**
   * ⚠️ THE CAP IS ON THE CONSIDERATION, NOT ON WHAT WAS COLLECTED. This
   * is the case that gets it backwards: a buyer who has paid ₹40,00,000
   * of an ₹80,00,000 flat has the same ₹8,00,000 cap as one who paid
   * ₹4,00,000, and forfeiting their whole payment is five times what can
   * be defended.
   */
  it("warns when the forfeit exceeds ten percent of the consideration", () => {
    const w = forfeitureWarning({
      forfeitMinor: 400_000_000n,
      considerationMinor: 800_000_000n,
    });
    expect(w).not.toBeNull();
    expect(w).toContain("unfair trade practice");
  });

  it("says so when there is no agreement value to check against", () => {
    const w = forfeitureWarning({ forfeitMinor: 100_000n, considerationMinor: null });
    expect(w).toContain("no agreement value");
  });

  it("stays quiet when nothing is being forfeited and there is no value", () => {
    expect(forfeitureWarning({ forfeitMinor: 0n, considerationMinor: null })).toBeNull();
  });

  it("keeps the cap as data rather than a buried comparison", () => {
    expect(FORFEITURE_GUIDANCE.capBps).toBe(1000);
    const w = forfeitureWarning({
      forfeitMinor: 300_000_000n,
      considerationMinor: 800_000_000n,
      capBps: 5000,
    });
    expect(w).toBeNull();
  });
});

/* ================================================================== */
/* ⭐⭐ THE SECTION 34 CREDIT-NOTE WINDOW                               */
/* ================================================================== */

describe("the section 34 credit-note window", () => {
  it("closes on 30 November after the financial year of the supply", () => {
    expect(creditNoteWindowCloses("2025-06-15")).toBe("2026-11-30");
  });

  /** ⚠️ A February supply is in the year that ENDED that March. */
  it("puts a February supply in the year ending that March", () => {
    expect(creditNoteWindowCloses("2026-02-10")).toBe("2026-11-30");
  });

  it("puts an April supply in the following year's window", () => {
    expect(creditNoteWindowCloses("2026-04-01")).toBe("2027-11-30");
  });

  it("is open on the closing day and shut the day after", () => {
    expect(creditNoteWindowClosed("2025-06-15", "2026-11-30")).toBe(false);
    expect(creditNoteWindowClosed("2025-06-15", "2026-12-01")).toBe(true);
  });

  /**
   * ⭐ THE CASE THIS EXISTS FOR. A developer's demands run for three
   * years, so a cancellation in year three cannot reverse the tax
   * charged in year one.
   */
  it("is shut on a three-year-old demand", () => {
    expect(creditNoteWindowClosed("2023-05-01", "2026-08-14")).toBe(true);
  });
});

/* ================================================================== */
/* ⭐⭐⭐ BROKERAGE POSTING                                             */
/* ================================================================== */

describe("the brokerage posting", () => {
  const base = {
    grossMinor: 16_000_000n, // ₹1,60,000
    cgstMinor: 1_440_000n, // 9%
    sgstMinor: 1_440_000n,
    igstMinor: 0n,
    tdsMinor: 320_000n, // 2%
    reference: "BRK-0001",
    partnerName: "Nandi Realty",
    bookingReference: "BKG-0001",
  };

  /**
   * 🔴 THE EXPENSE IS THE GROSS. The wrong version debits what was
   * actually transferred, which understates the selling cost by every
   * rupee withheld and makes the 194H liability appear from nowhere.
   */
  it("debits the gross brokerage, never the net", () => {
    const legs = buildBrokeragePosting({ ...base, itcEligible: true });
    expect(() => assertPropertyBalances(legs)).not.toThrow();
    const expense = legs.find((l) => l.role === "brokerage_expense");
    expect(expense?.amountMinor).toBe(16_000_000n);
    expect(expense?.entryType).toBe("debit");
  });

  it("credits the partner with gross plus tax less the deduction", () => {
    const legs = buildBrokeragePosting({ ...base, itcEligible: true });
    const payable = legs.find((l) => l.role === "partner_payable");
    expect(payable?.amountMinor).toBe(16_000_000n + 2_880_000n - 320_000n);
  });

  it("takes input credit when the project allows it", () => {
    const legs = buildBrokeragePosting({ ...base, itcEligible: true });
    expect(legs.some((l) => l.role === "input_cgst")).toBe(true);
    expect(legs.some((l) => l.role === "input_sgst")).toBe(true);
  });

  /**
   * ⭐⭐⭐ THE 1%/5% SCHEME. Notification 3/2019 allows NO input credit
   * on a concessional-rate residential project, so the broker's GST is
   * part of what the brokerage cost — exactly how Section 17(5) blocked
   * credit is treated everywhere else in this file.
   */
  it("adds the tax to the expense when no credit is available", () => {
    const legs = buildBrokeragePosting({ ...base, itcEligible: false });
    expect(() => assertPropertyBalances(legs)).not.toThrow();
    expect(legs.some((l) => l.role.startsWith("input_"))).toBe(false);
    const expense = legs.find((l) => l.role === "brokerage_expense");
    expect(expense?.amountMinor).toBe(16_000_000n + 2_880_000n);
    expect(expense?.description).toContain("no input credit");
  });

  /** ⚠️ The payable is the same either way — only where the cost sits moves. */
  it("pays the partner the same amount whichever way the credit falls", () => {
    const eligible = buildBrokeragePosting({ ...base, itcEligible: true });
    const blocked = buildBrokeragePosting({ ...base, itcEligible: false });
    const of = (legs: typeof eligible) =>
      legs.find((l) => l.role === "partner_payable")?.amountMinor;
    expect(of(eligible)).toBe(of(blocked));
  });

  it("balances on an inter-State bill", () => {
    const legs = buildBrokeragePosting({
      ...base,
      cgstMinor: 0n,
      sgstMinor: 0n,
      igstMinor: 2_880_000n,
      itcEligible: true,
    });
    expect(() => assertPropertyBalances(legs)).not.toThrow();
    expect(legs.some((l) => l.role === "input_igst")).toBe(true);
  });

  it("balances with no GST at all — an unregistered broker", () => {
    const legs = buildBrokeragePosting({
      ...base,
      cgstMinor: 0n,
      sgstMinor: 0n,
      igstMinor: 0n,
      itcEligible: false,
    });
    expect(() => assertPropertyBalances(legs)).not.toThrow();
    const payable = legs.find((l) => l.role === "partner_payable");
    expect(payable?.amountMinor).toBe(16_000_000n - 320_000n);
  });

  it("balances when no tax is withheld at all", () => {
    const legs = buildBrokeragePosting({ ...base, tdsMinor: 0n, itcEligible: true });
    expect(() => assertPropertyBalances(legs)).not.toThrow();
    expect(legs.some((l) => l.role === "tds_payable")).toBe(false);
  });

  /**
   * 🔴 THE PAYMENT LEAVES THE TDS ALONE. That liability is discharged by
   * a challan to the Government, and netting the two is how a TDS
   * payable balance reaches zero without a challan ever being paid.
   */
  it("clears only the payable when the partner is paid", () => {
    const legs = buildPartnerPaymentPosting({
      amountMinor: 18_560_000n,
      reference: "BRK-0001",
      partnerName: "Nandi Realty",
    });
    expect(() => assertPropertyBalances(legs)).not.toThrow();
    expect(propertyRolesUsed(legs).sort()).toEqual(["bank", "partner_payable"]);
  });
});

/* ================================================================== */
/* THE ROLE METADATA                                                   */
/* ================================================================== */

describe("every new role is described for the mapping screen", () => {
  const added = [
    "buyer_refund_payable",
    "irrecoverable_output_tax",
    "brokerage_expense",
    "partner_payable",
  ] as const;

  for (const role of added) {
    it(`describes ${role}`, () => {
      const meta = PROPERTY_ROLE_META[role];
      expect(meta).toBeDefined();
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.tallyGroup.length).toBeGreaterThan(0);
      /** ⚠️ The help is what a tenant maps against. An empty one is a guess. */
      expect(meta.help.length).toBeGreaterThan(40);
    });
  }

  it("puts the refund payable on the liability side and the brokerage on the expense side", () => {
    expect(PROPERTY_ROLE_META.buyer_refund_payable.accountType).toBe("liability");
    expect(PROPERTY_ROLE_META.partner_payable.accountType).toBe("liability");
    expect(PROPERTY_ROLE_META.brokerage_expense.accountType).toBe("expense");
    expect(PROPERTY_ROLE_META.irrecoverable_output_tax.accountType).toBe("expense");
  });
});

/* ================================================================== */
/* 🔴 REACHABILITY — READ FROM THE SOURCE, NOT FROM MEMORY             */
/* ================================================================== */

/**
 * ⚠️ THESE READ THE SOURCE TREE ON PURPOSE. Registry and gate edits have
 * gone into the BUILD STAGING COPY three times in this project, where
 * `tsc` stays green because staging holds the change and the next sync
 * silently discards it. A test that reads the file is the only thing
 * that has ever caught it.
 */
describe("the engines are actually reachable now", () => {
  it("sales-bookings posts the cancellation", () => {
    const source = read("server/actions/sales-bookings.ts");
    expect(source).toContain("@/server/accounting/post-sales");
    expect(source).toContain("postBookingCancellation");
    expect(source).toContain("recordBuyerRefund");
  });

  it("a brokerage action module exists and posts", () => {
    const source = read("server/actions/sales-brokerage.ts");
    expect(source).toContain("computeCommission");
    expect(source).toContain("computeTds");
    expect(source).toContain("postBrokerage");
    expect(source).toContain("postPartnerPayment");
  });

  it("both screens exist and are registered", () => {
    const registry = read("lib/modules/registry.ts");
    expect(registry).toContain("/sales/brokerage");
    expect(registry).toContain("/sales/cancellations");
    expect(read("app/(crm)/sales/brokerage/page.tsx")).toContain("BrokerageBoard");
    expect(read("app/(crm)/sales/cancellations/page.tsx")).toContain("CancellationBoard");
  });

  /**
   * ⭐ THE DEBT LIST HAS TO SHRINK BY DECISION. `sales-bookings` sat on
   * KNOWN_UNPOSTED for eleven sessions; the entry is deleted, not
   * reworded, and `sales-brokerage` is added to the module list so the
   * answer stays checkable.
   */
  it("sales-bookings is off the unposted list and brokerage is on the financial list", () => {
    const gate = read("scripts/check-posting-coverage.mjs");
    const unposted = gate.slice(
      gate.indexOf("const KNOWN_UNPOSTED"),
      gate.indexOf("const POSTING_MARKERS"),
    );
    expect(unposted).not.toContain('"sales-bookings":');
    const modules = gate.slice(
      gate.indexOf("const FINANCIAL_MODULES"),
      gate.indexOf("const KNOWN_UNPOSTED"),
    );
    expect(modules).toContain('"sales-brokerage"');
  });

  it("the migration ships RLS on the new table", () => {
    const sql = read("SQL-FILES/0078_real_estate_completion.sql");
    expect(sql).toContain("ALTER TABLE channel_partner_commissions ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("ALTER TABLE channel_partner_commissions FORCE  ROW LEVEL SECURITY");
    /** 🔴 `app_platform_scope()` in USING and NEVER in WITH CHECK. */
    expect(sql).toContain("USING      (tenant_id = app_current_tenant_id() OR app_platform_scope())");
    expect(sql).toContain("WITH CHECK (tenant_id = app_current_tenant_id())");
  });

  it("the migration freezes a posted cancellation and ratchets the brokerage bill", () => {
    const sql = read("SQL-FILES/0078_real_estate_completion.sql");
    expect(sql).toContain("ordence_guard_posted_cancellation");
    expect(sql).toContain("ordence_guard_commission_status");
    expect(sql).toContain("cp_commissions_adds_up");
    expect(sql).toContain("cp_commissions_tax_shape");
  });
});
