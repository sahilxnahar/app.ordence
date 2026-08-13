/**
 * ⭐⭐⭐ FRONT OFFICE, BATCH 5 — ORDERS, RECEIPTS AND THE PAYMENT RUN.
 *
 * 🔴 THE THREE FAILURES THIS SUITE PINS DOWN.
 *
 *   ① A real vendor billing for eleven when ten arrived, every month,
 *      for years. Nobody checks, because the vendor is real, the goods
 *      are real, and each difference is small.
 *
 *   ② A payment posted net of the withholding, which leaves the tax
 *      sitting on the vendor's ledger as if it were still owed to them,
 *      on every bill, all year.
 *
 *   ③ An MSME bill unpaid at 31 March, where the whole expense is added
 *      back to taxable income. Not delayed. Added back.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_TOLERANCE,
  MatchError,
  threeWayMatch,
  type MatchLine,
} from "@/lib/purchases/three-way-match";
import {
  MsmeError,
  addDays,
  assessMsmeBill,
  financialYearEnd,
  msmeDueDate,
  msmeInterestMinor,
  msmeScope,
} from "@/lib/purchases/msme";
import {
  AgeingError,
  allocateOldestFirst,
  bucketOf,
  buildPaymentRun,
  type PayableBill,
} from "@/lib/purchases/ageing";
import { buildVendorPaymentPosting } from "@/lib/accounting/sales-posting";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const sqlCode = (s: string) => s.replace(/--[^\n]*/g, "");
const flat = (s: string) => s.replace(/\s+/g, " ");

const SQL = read("SQL-FILES/0063_purchase_orders_payments.sql");
const MSME_LIB = read("lib/purchases/msme.ts");
const MATCH_LIB = read("lib/purchases/three-way-match.ts");
const AGEING_LIB = read("lib/purchases/ageing.ts");
const PAY_ACTIONS = read("server/actions/vendor-payments.ts");
const POSTING = read("server/accounting/post-sales.ts");
const PAGE = read("app/(crm)/purchases/payment-run/page.tsx");
const GATE = read("scripts/check-posting-coverage.mjs");
const SCHEMA = read("db/schema/procurement.ts");

const K = 1000n; // one whole unit, in thousandths

/* ================================================================== */
/* ① THE THREE-WAY MATCH                                              */
/* ================================================================== */

const LINE = (over: Partial<MatchLine> = {}): MatchLine => ({
  key: "l1",
  description: "MS plate 10mm",
  orderedQty: 10n * K,
  receivedQty: 10n * K,
  billedQty: 10n * K,
  orderedRateMinor: 5_000_00n,
  billedRateMinor: 5_000_00n,
  ...over,
});

describe("🔴 no bill passes for goods that never arrived", () => {
  it("passes when all three agree", () => {
    const v = threeWayMatch({ lines: [LINE()] });
    expect(v.passed).toBe(true);
    expect(v.problems).toEqual([]);
  });

  it("🔴 catches billing for eleven when ten arrived", () => {
    const v = threeWayMatch({ lines: [LINE({ billedQty: 11n * K })] });
    expect(v.passed).toBe(false);
    /**
     * 🔴 The order of the checks is the order of the risk: ahead of the
     * DELIVERY is reported before beyond the ORDER, because that is the
     * one that costs money and repeats.
     */
    expect(v.problems[0]?.kind).toBe("billed_more_than_received");
    expect(v.problems.map((p) => p.kind)).toContain("billed_more_than_ordered");
  });

  it("prices the discrepancy so somebody can judge it", () => {
    const v = threeWayMatch({ lines: [LINE({ billedQty: 11n * K })] });
    /** One extra unit at ₹5,000. */
    expect(v.exposureMinor).toBe(5_000_00n * 2n);
  });

  it("🔴 calls out a bill where nothing was received at all", () => {
    const v = threeWayMatch({ lines: [LINE({ receivedQty: 0n })] });
    expect(v.passed).toBe(false);
    expect(v.problems[0]?.kind).toBe("nothing_received");
    expect(v.problems[0]?.message).toMatch(/never came|never entered/i);
  });

  it("catches a price above the order even when the quantities are perfect", () => {
    const v = threeWayMatch({ lines: [LINE({ billedRateMinor: 5_500_00n })] });
    expect(v.passed).toBe(false);
    expect(v.problems[0]?.kind).toBe("price_above_order");
  });

  it("⚠️ does NOT complain about a price BELOW the order", () => {
    /** Flagging any variance trains people to click through everything. */
    const v = threeWayMatch({ lines: [LINE({ billedRateMinor: 4_000_00n })] });
    expect(v.passed).toBe(true);
    expect(v.problems).toEqual([]);
  });

  it("flags an over-receipt as tomorrow's problem, not today's", () => {
    const v = threeWayMatch({
      lines: [LINE({ receivedQty: 12n * K, billedQty: 10n * K })],
    });
    expect(v.problems[0]?.kind).toBe("received_more_than_ordered");
    expect(v.problems[0]?.message).toMatch(/next invoice/i);
  });

  it("⭐ ships with a ZERO tolerance, deliberately", () => {
    /** A tolerance nobody chose is a tolerance nobody owns. */
    expect(DEFAULT_TOLERANCE.qtyBps).toBe(0);
    expect(DEFAULT_TOLERANCE.priceBps).toBe(0);
  });

  it("🔴 REPORTS what a tolerance let through rather than swallowing it", () => {
    const v = threeWayMatch({
      lines: [LINE({ billedQty: 10n * K + 50n })],
      tolerance: { qtyBps: 100, priceBps: 0, absoluteMinor: 0n },
    });
    expect(v.passed).toBe(true);
    /** ⚠️ Passed, and still listed. */
    expect(v.tolerated.length).toBeGreaterThan(0);
    expect(v.summary).toMatch(/rather than swallowed/i);
  });

  it("refuses a negative quantity or a negative tolerance", () => {
    expect(() => threeWayMatch({ lines: [LINE({ billedQty: -1n })] })).toThrow(MatchError);
    expect(() =>
      threeWayMatch({ lines: [LINE()], tolerance: { qtyBps: -1, priceBps: 0, absoluteMinor: 0n } }),
    ).toThrow(MatchError);
  });
});

/* ================================================================== */
/* ② MSME                                                             */
/* ================================================================== */

describe("🔴 fifteen days, not forty-five, unless there is a written agreement", () => {
  it("defaults to fifteen", () => {
    const d = msmeDueDate({ acceptedOn: "2026-04-01" });
    expect(d.dueOn).toBe("2026-04-16");
    expect(d.daysAllowed).toBe(15);
    expect(d.note).toMatch(/not the default/i);
  });

  it("honours a written agreement inside the ceiling", () => {
    expect(msmeDueDate({ acceptedOn: "2026-04-01", writtenAgreementDays: 45 }).dueOn).toBe(
      "2026-05-16",
    );
  });

  it("🔴 CAPS a ninety day clause at forty-five, because the contract does not win", () => {
    const d = msmeDueDate({ acceptedOn: "2026-04-01", writtenAgreementDays: 90 });
    expect(d.daysAllowed).toBe(45);
    expect(d.note).toMatch(/void to that extent/i);
  });

  it("refuses a nonsense credit period", () => {
    expect(() => msmeDueDate({ acceptedOn: "2026-04-01", writtenAgreementDays: 0 })).toThrow(
      MsmeError,
    );
  });
});

describe("🔴 who the rule actually reaches", () => {
  it("reaches a micro manufacturer", () => {
    expect(msmeScope({ category: "micro", supplierKind: "manufacturer" }).inScope).toBe(true);
  });

  it("⚠️ does NOT reach a medium enterprise", () => {
    const s = msmeScope({ category: "medium", supplierKind: "manufacturer" });
    expect(s.inScope).toBe(false);
    expect(s.reason).toMatch(/cry wolf/i);
  });

  it("⚠️ does NOT reach a trader", () => {
    const s = msmeScope({ category: "small", supplierKind: "trader" });
    expect(s.inScope).toBe(false);
    expect(s.reason).toMatch(/lending purposes/i);
  });

  it("does not reach an unregistered vendor", () => {
    expect(
      msmeScope({ category: "not_registered", supplierKind: "manufacturer" }).inScope,
    ).toBe(false);
  });

  it("⭐ treats an unknown supplier kind as in scope, and says it is unsure", () => {
    const s = msmeScope({ category: "micro", supplierKind: "unknown" });
    expect(s.inScope).toBe(true);
    expect(s.uncertain).toBe(true);
  });
});

describe("🔴 the disallowance bites on what is unpaid at 31 March", () => {
  it("knows the Indian financial year end", () => {
    expect(financialYearEnd("2026-08-13")).toBe("2027-03-31");
    /** ⚠️ January to March belongs to the year that started last April. */
    expect(financialYearEnd("2027-01-15")).toBe("2027-03-31");
    expect(financialYearEnd("2026-03-31")).toBe("2026-03-31");
    expect(financialYearEnd("2026-04-01")).toBe("2027-03-31");
  });

  it("puts the deduction at risk when the deadline falls inside the year", () => {
    const v = assessMsmeBill({
      category: "small",
      supplierKind: "manufacturer",
      acceptedOn: "2026-06-01",
      outstandingMinor: 1_00_000_00n,
      today: "2026-08-13",
      bankRateBps: 600,
    });
    expect(v.inScope).toBe(true);
    expect(v.deductionAtRisk).toBe(true);
    expect(v.dueOn).toBe("2026-06-16");
    expect(v.daysLate).toBe(58);
    expect(v.detail).toMatch(/added back to taxable income/i);
  });

  it("🔴 shouts louder as 31 March approaches", () => {
    const near = assessMsmeBill({
      category: "small",
      supplierKind: "manufacturer",
      acceptedOn: "2027-01-01",
      outstandingMinor: 1_00_000_00n,
      today: "2027-03-10",
      bankRateBps: 600,
    });
    const far = assessMsmeBill({
      category: "small",
      supplierKind: "manufacturer",
      acceptedOn: "2026-06-01",
      outstandingMinor: 1_00_000_00n,
      today: "2026-08-13",
      bankRateBps: 600,
    });
    expect(near.priority).toBeGreaterThan(far.priority);
    expect(near.headline).toMatch(/before 31 March/i);
  });

  it("⚠️ reports an MSME bill with NO acceptance date as at risk, loudly", () => {
    const v = assessMsmeBill({
      category: "micro",
      supplierKind: "service_provider",
      acceptedOn: null,
      outstandingMinor: 50_000_00n,
      today: "2026-08-13",
      bankRateBps: 600,
    });
    /** It would otherwise never appear on the report that would save it. */
    expect(v.deductionAtRisk).toBe(true);
    expect(v.uncertain).toBe(true);
    expect(v.detail).toMatch(/never appear on the report/i);
  });

  it("says nothing at all about a vendor outside the rule", () => {
    const v = assessMsmeBill({
      category: "medium",
      supplierKind: "manufacturer",
      acceptedOn: "2026-01-01",
      outstandingMinor: 1_00_000_00n,
      today: "2026-08-13",
      bankRateBps: 600,
    });
    expect(v.inScope).toBe(false);
    expect(v.priority).toBe(0);
    expect(v.interestMinor).toBe(0n);
  });
});

describe("⚠️ section 16 interest compounds and is never deductible", () => {
  it("is zero before the due date", () => {
    expect(
      msmeInterestMinor({
        principalMinor: 1_00_000_00n,
        dueOn: "2026-06-16",
        paidOn: "2026-06-01",
        bankRateBps: 600,
      }),
    ).toBe(0n);
  });

  it("compounds monthly at three times the bank rate", () => {
    const oneMonth = msmeInterestMinor({
      principalMinor: 1_00_000_00n,
      dueOn: "2026-06-16",
      paidOn: "2026-07-16",
      bankRateBps: 600,
    });
    /** 18% a year on ₹1,00,000 for one month is ₹1,500. */
    expect(oneMonth).toBe(1_500_00n);

    const twelveMonths = msmeInterestMinor({
      principalMinor: 1_00_000_00n,
      dueOn: "2025-06-16",
      paidOn: "2026-06-16",
      bankRateBps: 600,
    });
    /** 🔴 Compounding beats simple: more than the ₹18,000 simple figure. */
    expect(twelveMonths).toBeGreaterThan(18_000_00n);
  });

  it("takes the bank rate as an argument, because a stale rate is a stale rate", () => {
    const low = msmeInterestMinor({
      principalMinor: 1_00_000_00n,
      dueOn: "2026-06-16",
      paidOn: "2026-07-16",
      bankRateBps: 300,
    });
    expect(low).toBe(750_00n);
  });

  it("refuses a negative principal or rate", () => {
    expect(() =>
      msmeInterestMinor({
        principalMinor: -1n,
        dueOn: "2026-01-01",
        paidOn: "2026-02-01",
        bankRateBps: 600,
      }),
    ).toThrow(MsmeError);
  });

  it("does month-end arithmetic without drifting", () => {
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
  });
});

/* ================================================================== */
/* ③ THE RUN                                                          */
/* ================================================================== */

const BILL = (over: Partial<PayableBill> = {}): PayableBill => ({
  id: "b1",
  vendorId: "v1",
  vendorName: "Sharma Steels",
  invoiceNumber: "PI-001",
  invoiceDate: "2026-06-01",
  dueOn: "2026-07-01",
  totalMinor: 1_00_000_00n,
  paidMinor: 0n,
  matchState: "matched",
  msmePriority: 0,
  msmeDeductionAtRisk: false,
  msmeInterestMinor: 0n,
  onHold: false,
  ...over,
});

describe("🔴 ageing runs from the due date, not the bill date", () => {
  it("does not call a not-yet-due bill overdue", () => {
    expect(bucketOf({ dueOn: "2026-09-01", today: "2026-08-13" })).toBe("not_due");
  });

  it("buckets by days past the due date", () => {
    expect(bucketOf({ dueOn: "2026-08-01", today: "2026-08-13" })).toBe("1_30");
    expect(bucketOf({ dueOn: "2026-07-01", today: "2026-08-13" })).toBe("31_60");
    expect(bucketOf({ dueOn: "2026-05-01", today: "2026-08-13" })).toBe("over_90");
  });

  it("⚠️ treats a bill with no due date as due now, not as never due", () => {
    expect(bucketOf({ dueOn: null, today: "2026-08-13" })).toBe("1_30");
  });
});

describe("🔴 a payment run over unmatched bills pays the wrong things faster", () => {
  it("blocks a bill whose three-way match failed", () => {
    const run = buildPaymentRun({
      bills: [BILL({ matchState: "unmatched" })],
      today: "2026-08-13",
    });
    expect(run.lines[0]?.payable).toBe(false);
    expect(run.lines[0]?.blockedReason).toMatch(/three-way match failed/i);
    expect(run.blockedCount).toBe(1);
  });

  it("⚠️ does NOT block a bill with no purchase order", () => {
    /**
     * Plenty of legitimate spend has no order: a utility bill, a
     * professional fee, a statutory payment. Blocking it would make the
     * run useless and teach people to raise fake orders.
     */
    const run = buildPaymentRun({
      bills: [BILL({ matchState: "no_order" })],
      today: "2026-08-13",
    });
    expect(run.lines[0]?.payable).toBe(true);
  });

  it("🔴 blocks a bill with nothing outstanding, and says why", () => {
    const run = buildPaymentRun({
      bills: [BILL({ paidMinor: 1_00_000_00n })],
      today: "2026-08-13",
    });
    expect(run.lines[0]?.payable).toBe(false);
    expect(run.lines[0]?.blockedReason).toMatch(/commonest loss/i);
  });

  it("blocks a bill on hold with its own reason", () => {
    const run = buildPaymentRun({
      bills: [BILL({ onHold: true, holdReason: "Quality dispute open" })],
      today: "2026-08-13",
    });
    expect(run.lines[0]?.blockedReason).toBe("Quality dispute open");
  });

  it("🔴 sorts BLOCKED bills to the TOP, not the bottom", () => {
    const run = buildPaymentRun({
      bills: [
        BILL({ id: "ok", invoiceNumber: "PI-OK" }),
        BILL({ id: "bad", invoiceNumber: "PI-BAD", matchState: "unmatched" }),
      ],
      today: "2026-08-13",
    });
    /** They are the ones needing a decision. */
    expect(run.lines[0]?.bill.id).toBe("bad");
  });

  it("⭐ ranks the MSME deduction above mere age", () => {
    const run = buildPaymentRun({
      bills: [
        BILL({ id: "old", invoiceNumber: "PI-OLD", dueOn: "2025-01-01" }),
        BILL({
          id: "msme",
          invoiceNumber: "PI-MSME",
          dueOn: "2026-08-01",
          msmePriority: 100,
          msmeDeductionAtRisk: true,
        }),
      ],
      today: "2026-08-13",
    });
    expect(run.lines[0]?.bill.id).toBe("msme");
  });

  it("totals what is at risk and what is blocked, separately", () => {
    const run = buildPaymentRun({
      bills: [
        BILL({ id: "a", msmeDeductionAtRisk: true, msmePriority: 80 }),
        BILL({ id: "b", invoiceNumber: "PI-B", matchState: "unmatched" }),
      ],
      today: "2026-08-13",
    });
    expect(run.deductionAtRiskMinor).toBe(1_00_000_00n);
    expect(run.deductionAtRiskCount).toBe(1);
    expect(run.blockedTotalMinor).toBe(1_00_000_00n);
  });

  it("refuses negative amounts", () => {
    expect(() =>
      buildPaymentRun({ bills: [BILL({ totalMinor: -1n })], today: "2026-08-13" }),
    ).toThrow(AgeingError);
  });
});

describe("⭐ allocation is oldest first and never over-pays", () => {
  const bills = [
    { id: "old", dueOn: "2026-01-01", outstandingMinor: 40_000_00n },
    { id: "new", dueOn: "2026-06-01", outstandingMinor: 60_000_00n },
  ];

  it("settles the oldest first", () => {
    const r = allocateOldestFirst({ amountMinor: 50_000_00n, bills });
    expect(r.allocations[0]).toEqual({ invoiceId: "old", allocatedMinor: 40_000_00n });
    expect(r.allocations[1]).toEqual({ invoiceId: "new", allocatedMinor: 10_000_00n });
    expect(r.unallocatedMinor).toBe(0n);
  });

  it("never allocates more than a bill's balance", () => {
    const r = allocateOldestFirst({ amountMinor: 1_000_000_00n, bills });
    for (const a of r.allocations) {
      const b = bills.find((x) => x.id === a.invoiceId);
      expect(a.allocatedMinor).toBeLessThanOrEqual(b?.outstandingMinor ?? 0n);
    }
  });

  it("🔴 RETURNS the remainder rather than silently absorbing it", () => {
    /** Money landing on no bill is an advance, a different ledger account. */
    const r = allocateOldestFirst({ amountMinor: 1_50_000_00n, bills });
    expect(r.unallocatedMinor).toBe(50_000_00n);
  });

  it("⚠️ treats an undated bill as oldest, not newest", () => {
    const r = allocateOldestFirst({
      amountMinor: 10_00n,
      bills: [
        { id: "dated", dueOn: "2020-01-01", outstandingMinor: 5_00n },
        { id: "undated", dueOn: null, outstandingMinor: 5_00n },
      ],
    });
    expect(r.allocations[0]?.invoiceId).toBe("undated");
  });

  it("refuses a negative payment", () => {
    expect(() => allocateOldestFirst({ amountMinor: -1n, bills })).toThrow(AgeingError);
  });
});

/* ================================================================== */
/* ④ THE POSTING                                                      */
/* ================================================================== */

describe("🔴🔴 the liability is cleared in FULL, not net of the withholding", () => {
  const legs = buildVendorPaymentPosting({
    grossMinor: 1_00_000_00n,
    tdsMinor: 10_000_00n,
    msmeInterestMinor: 0n,
    roundOffMinor: 0n,
    netMinor: 90_000_00n,
    paymentNumber: "VP-001",
    vendorName: "Sharma Steels",
    tdsSection: "194J_a",
  });

  it("debits the creditor with the GROSS", () => {
    const payable = legs.find((l) => l.role === "payable");
    expect(payable?.entryType).toBe("debit");
    /**
     * ⚠️ Debiting only the net is the common error, and it leaves ten
     * thousand sitting on the vendor's ledger as if still owed to them,
     * on every bill, all year.
     */
    expect(payable?.amountMinor).toBe(1_00_000_00n);
  });

  it("credits the bank with the NET", () => {
    const bank = legs.find((l) => l.role === "bank");
    expect(bank?.entryType).toBe("credit");
    expect(bank?.amountMinor).toBe(90_000_00n);
  });

  it("credits TDS payable with the withholding, naming the section", () => {
    const tds = legs.find((l) => l.role === "tds_payable");
    expect(tds?.entryType).toBe("credit");
    expect(tds?.amountMinor).toBe(10_000_00n);
    expect(tds?.description).toContain("194J_a");
  });

  it("balances", () => {
    const debit = legs
      .filter((l) => l.entryType === "debit")
      .reduce((s, l) => s + l.amountMinor, 0n);
    const credit = legs
      .filter((l) => l.entryType === "credit")
      .reduce((s, l) => s + l.amountMinor, 0n);
    expect(debit).toBe(credit);
  });

  it("⭐ puts MSME interest in its OWN account, debited as an expense", () => {
    const withInterest = buildVendorPaymentPosting({
      grossMinor: 1_00_000_00n,
      tdsMinor: 0n,
      msmeInterestMinor: 1_500_00n,
      roundOffMinor: 0n,
      netMinor: 1_01_500_00n,
      paymentNumber: "VP-002",
      vendorName: "X",
      tdsSection: null,
    });
    const interest = withInterest.find((l) => l.role === "msme_interest");
    /** It is never deductible, so burying it in general interest hides a cost. */
    expect(interest?.entryType).toBe("debit");
    expect(interest?.amountMinor).toBe(1_500_00n);
    expect(interest?.description).toMatch(/s\.16 MSMED/);
  });

  it("🔴 refuses withholding more than the payment itself", () => {
    expect(() =>
      buildVendorPaymentPosting({
        grossMinor: 1_000_00n,
        tdsMinor: 2_000_00n,
        msmeInterestMinor: 0n,
        roundOffMinor: 0n,
        netMinor: -1_000_00n,
        paymentNumber: "X",
        vendorName: null,
        tdsSection: "194C",
      }),
    ).toThrow(/sign error/i);
  });

  it("🔴 refuses a net that does not equal gross minus TDS plus interest", () => {
    expect(() =>
      buildVendorPaymentPosting({
        grossMinor: 1_00_000_00n,
        tdsMinor: 10_000_00n,
        msmeInterestMinor: 0n,
        roundOffMinor: 0n,
        netMinor: 1_00_000_00n,
        paymentNumber: "X",
        vendorName: null,
        tdsSection: "194J_a",
      }),
    ).toThrow(/does not add up/i);
  });
});

/* ================================================================== */
/* ⑤ THE DATABASE                                                     */
/* ================================================================== */

describe("🔴 0063 puts the rules where nothing can route around them", () => {
  const sql = sqlCode(SQL);

  it("🔴 does the payment arithmetic in the database", () => {
    expect(sql).toContain("vendor_payments_arithmetic");
    expect(flat(sql)).toMatch(
      /net_minor = gross_minor - tds_minor \+ msme_interest_minor \+ round_off_minor/,
    );
  });

  it("refuses withholding more than the payment", () => {
    expect(sql).toContain("vendor_payments_tds_within_gross");
  });

  it("refuses a deduction that does not name its section", () => {
    expect(sql).toContain("vendor_payments_tds_names_its_section");
  });

  it("🔴 refuses paying a bill twice", () => {
    expect(sql).toContain("ordence_guard_payment_allocation");
    expect(flat(sql)).toMatch(/commonest loss in accounts payable/i);
  });

  it("🔴 refuses receiving more than was ordered", () => {
    expect(sql).toContain("ordence_guard_over_receipt");
    expect(flat(sql)).toMatch(/becomes a payment on the next invoice/i);
  });

  it("refuses editing a settled payment", () => {
    expect(sql).toContain("ordence_guard_paid_payment");
    expect(flat(sql)).toMatch(/never agree again/i);
  });

  it("⭐ derives the paid figure in the database, not in application code", () => {
    expect(sql).toContain("ordence_sync_invoice_paid");
  });

  it("🔴🔴 releases the bills when a payment is VOIDED", () => {
    /**
     * ⚠️ FOUND BY THE DRILL, NOT BY THE DESIGN. The allocation trigger
     * excludes void payments from the sum, but it only fires when an
     * ALLOCATION changes — and voiding changes the PAYMENT. A voided
     * payment therefore left every bill it had settled still showing as
     * paid, so the bill would never appear on a payment run again: a
     * cheque bounces, somebody voids it correctly, and the supplier
     * simply stops being paid with no trace of why.
     */
    expect(sql).toContain("ordence_resync_on_void");
    expect(sql).toContain("AFTER UPDATE ON vendor_payments");
    /** ⚠️ Only a move into or out of `void` changes what counts as paid. */
    expect(flat(sql)).toMatch(/NEW\.status <> 'void' AND OLD\.status <> 'void'/);
    /** And the reasoning survives in the migration for the next reader. */
    expect(flat(SQL)).toMatch(/never appear on a payment run again/i);
  });

  it("🔴 caps an agreed credit period at forty-five days", () => {
    expect(sql).toContain("purchase_orders_credit_days_are_lawful");
    expect(flat(sql)).toMatch(/agreed_credit_days <= 45/);
  });

  it("requires an approver on anything past draft", () => {
    expect(sql).toContain("purchase_orders_approved_is_evidenced");
  });

  it("requires a note where a tolerance let something through", () => {
    expect(sql).toContain("purchase_invoices_tolerance_is_explained");
  });

  it("adds a due date to the payable, so it can be aged at all", () => {
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS due_date date");
  });

  it("puts RLS on every new table, with platform scope in USING only", () => {
    for (const t of [
      "purchase_orders",
      "purchase_order_lines",
      "goods_receipts",
      "goods_receipt_lines",
      "vendor_payments",
      "vendor_payment_allocations",
    ]) {
      expect(sql, t).toContain(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
      expect(sql, t).toContain(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
    }
    const withChecks = sql.match(/WITH CHECK \([^)]*\)/g) ?? [];
    for (const w of withChecks) expect(w).not.toContain("app_platform_scope");
  });
});

/* ================================================================== */
/* ⑥ THE UNPOSTED LIST SHRANK, BY DECISION                            */
/* ================================================================== */

describe("🔴🔴 tds comes off the unposted list because the payment posts", () => {
  it("no longer lists tds as outstanding", () => {
    expect(GATE).not.toMatch(/^\s*tds:\s*"TDS is deducted at PAYMENT/m);
  });

  it("names vendor-payments as the financial module instead", () => {
    expect(GATE).toContain('"vendor-payments"');
  });

  it("⭐ records WHY, so the list shrank by decision and not by neglect", () => {
    expect(flat(GATE)).toMatch(/shrinks by decision only shrinks by neglect/i);
    expect(flat(GATE)).toMatch(/input to a payment/i);
  });

  it("the payment action actually posts", () => {
    expect(code(PAY_ACTIONS)).toContain("postVendorPayment");
  });

  it("the posting is idempotent, so a retried run cannot post twice", () => {
    const c = code(POSTING);
    const fn = c.slice(c.indexOf("export async function postVendorPayment"));
    expect(fn).toContain("already_posted");
  });

  it("🔴 leaves the payment unpaid when the accounts are not mapped", () => {
    /** Marking it paid would hide that the money never reached the ledger. */
    expect(flat(code(PAY_ACTIONS))).toMatch(/has not reached the ledger/i);
  });
});

describe("🔴 the action refuses the expensive mistakes", () => {
  it("refuses withholding more than the payment", () => {
    expect(flat(code(PAY_ACTIONS))).toMatch(/sign error/i);
  });

  it("refuses a deduction with no section", () => {
    expect(flat(code(PAY_ACTIONS))).toMatch(/quarterly return cannot be built/i);
  });

  it("🔴 will not allocate to an unmatched bill even by oldest-first", () => {
    expect(code(PAY_ACTIONS)).toMatch(/matchState !== "unmatched"/);
  });

  it("⭐ does not reimplement any TDS arithmetic", () => {
    const c = code(PAY_ACTIONS);
    expect(c).not.toContain("@/lib/tds/rates");
    expect(c).not.toContain("@/lib/tds/thresholds");
  });

  it("⚠️ does not guess what a material supplier is", () => {
    expect(flat(PAY_ACTIONS)).toMatch(/IS NOT MAPPED TO MANUFACTURER/);
  });
});

describe("⭐ the screen leads with the rule", () => {
  it("says the run is not sorted by age", () => {
    expect(flat(PAGE)).toMatch(/Not sorted by age/i);
  });

  it("says added back, not delayed", () => {
    expect(flat(PAGE)).toMatch(/added back to taxable income/i);
  });

  it("cites both the old and the new section numbers", () => {
    expect(flat(PAGE)).toMatch(/43B\(h\)/);
    expect(flat(PAGE)).toMatch(/37\(2\)\(g\)/);
  });

  it("says the interest is never deductible", () => {
    expect(flat(PAGE)).toMatch(/not deductible under any section/i);
  });

  it("declares the new tables", () => {
    for (const t of [
      "purchaseOrders",
      "purchaseOrderLines",
      "goodsReceipts",
      "goodsReceiptLines",
      "vendorPayments",
      "vendorPaymentAllocations",
    ]) {
      expect(SCHEMA, t).toContain(`export const ${t} = pgTable`);
    }
  });
});

describe("⚠️ the libs stay pure", () => {
  it("read no clock and no database", () => {
    for (const [name, src] of [
      ["msme", MSME_LIB],
      ["match", MATCH_LIB],
      ["ageing", AGEING_LIB],
    ] as const) {
      const c = code(src);
      expect(c, name).not.toMatch(/Date\.now\(/);
      expect(c, name).not.toMatch(/new Date\(\)/);
      expect(c, name).not.toContain("@/db");
    }
  });
});
