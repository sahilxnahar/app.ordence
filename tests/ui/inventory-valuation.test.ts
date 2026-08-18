/**
 * Ordence — ⭐⭐⭐ INVENTORY VALUATION — Batches 85–87
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THESE TESTS ARE FOR
 * ══════════════════════════════════════════════════════════════════════
 * `valuationMethod` existed as an enum, a column, a form field and an
 * audit entry, and was read at ZERO computations. The proof that it now
 * means something is not that a function exists — it is that CHOOSING A
 * DIFFERENT METHOD CHANGES THE ANSWER. That is the first test below, and
 * if it ever goes green by both methods agreeing, the method has stopped
 * being read again.
 *
 * ⚠️ THESE ASSERT PROPERTIES, NOT SHAPES. No exact message strings, no
 * layer counts — those pin an implementation and break on a rename while
 * saying nothing about whether the accounting is right. What is asserted
 * is that the ledger foots, that the methods disagree, that rounding
 * cannot leak a paisa, and that a closed period is refused.
 */

import { describe, expect, it } from "vitest";
import {
  PeriodClosedError,
  ValuationError,
  formatQuantity,
  parseQuantity,
  runValuation,
  type ValuationMovement,
} from "@/lib/inventory/valuation";

/** 1 whole unit = 1000 thousandths. Quantities are never floats. */
const u = (whole: number): bigint => BigInt(whole) * 1000n;

const receipt = (
  id: string,
  movedAt: string,
  qtyWhole: number,
  unitCostMinor: bigint,
  batchNo?: string,
): ValuationMovement => ({
  id,
  movedAt,
  quantity: u(qtyWhole),
  unitCostMinor,
  reason: "purchase_receipt",
  batchNo: batchNo ?? null,
});

const issue = (
  id: string,
  movedAt: string,
  qtyWhole: number,
  batchNo?: string,
): ValuationMovement => ({
  id,
  movedAt,
  quantity: -u(qtyWhole),
  unitCostMinor: null,
  reason: "sales_dispatch",
  batchNo: batchNo ?? null,
});

/** opening + receipts − issues = closing, in exact paise. */
const foots = (r: {
  openingValueMinor: bigint;
  receiptsValueMinor: bigint;
  issuesValueMinor: bigint;
  closingValueMinor: bigint;
}): boolean =>
  r.openingValueMinor + r.receiptsValueMinor - r.issuesValueMinor === r.closingValueMinor;

describe("the method is actually read", () => {
  /**
   * 🔴 THE LOAD-BEARING TEST. Two receipts at different prices and one
   * issue that spans both. FIFO charges out the old price first;
   * weighted average charges the blend. If these ever agree, nothing is
   * consulting `valuationMethod` and the batch has regressed.
   */
  const movements = [
    receipt("r1", "2026-04-01T00:00:00.000Z", 100, 10_000n),
    receipt("r2", "2026-04-10T00:00:00.000Z", 100, 20_000n),
    issue("i1", "2026-04-20T00:00:00.000Z", 150),
  ];

  it("gives a different cost of sales under FIFO than under weighted average", () => {
    const fifo = runValuation({ method: "fifo", movements });
    const wavg = runValuation({ method: "weighted_average", movements });

    expect(fifo.issuesValueMinor).not.toBe(wavg.issuesValueMinor);
    /** FIFO consumes the cheap layer first, so it must be the lower COGS. */
    expect(fifo.issuesValueMinor < wavg.issuesValueMinor).toBe(true);
    /** Both methods hold the same UNITS; only the value differs. */
    expect(fifo.closingQuantity).toBe(wavg.closingQuantity);
    expect(fifo.closingValueMinor).not.toBe(wavg.closingValueMinor);
  });

  it("foots under every method it claims to implement", () => {
    for (const method of ["fifo", "weighted_average", "standard"] as const) {
      const run = runValuation({
        method,
        movements,
        standardCostMinor: 15_000n,
      });
      expect(foots(run)).toBe(true);
      expect(run.method).toBe(method);
    }
  });

  it("refuses a method it does not implement, by name, instead of defaulting", () => {
    expect(() => runValuation({ method: "lifo", movements })).toThrow(ValuationError);
    /** The refusal must name the thing refused, or it is not actionable. */
    expect(() => runValuation({ method: "lifo", movements })).toThrow(/lifo/);
  });

  it("gives the same answer every time it is run over the same movements", () => {
    const a = runValuation({ method: "fifo", movements });
    const b = runValuation({ method: "fifo", movements: [...movements].reverse() });
    /** ⭐ Order of INPUT must not matter; order of EVENTS must. */
    expect(b.issuesValueMinor).toBe(a.issuesValueMinor);
    expect(b.closingValueMinor).toBe(a.closingValueMinor);
  });
});

describe("rounding cannot leak a paisa", () => {
  /**
   * 🔴 ONE RUPEE ACROSS THREE UNITS IS 33.333 PAISE EACH AND THERE IS NO
   * SUCH COIN. Rounding the rate and multiplying it back loses a paisa
   * per line; leaving the remainder in the layer does not.
   */
  it("charges out exactly what was taken in, whatever the split", () => {
    const movements: ValuationMovement[] = [
      { ...receipt("r1", "2026-04-01T00:00:00.000Z", 3, 0n), valueMinor: 100_000n },
      issue("i1", "2026-04-02T00:00:00.000Z", 1),
      issue("i2", "2026-04-03T00:00:00.000Z", 1),
      issue("i3", "2026-04-04T00:00:00.000Z", 1),
    ];
    for (const method of ["fifo", "weighted_average"] as const) {
      const run = runValuation({ method, movements });
      expect(run.receiptsValueMinor).toBe(100_000n);
      /** Every paisa taken in has been charged out. Not "about". */
      expect(run.issuesValueMinor).toBe(100_000n);
      expect(run.closingValueMinor).toBe(0n);
      expect(foots(run)).toBe(true);
    }
  });

  it("keeps footing when many awkward issues come out of one layer", () => {
    const movements: ValuationMovement[] = [
      { ...receipt("r1", "2026-04-01T00:00:00.000Z", 7, 0n), valueMinor: 1_000_001n },
    ];
    for (let i = 0; i < 7; i += 1) {
      movements.push(issue(`i${i}`, `2026-04-0${i + 2}T00:00:00.000Z`, 1));
    }
    const run = runValuation({ method: "fifo", movements });
    expect(run.issuesValueMinor).toBe(1_000_001n);
    expect(run.closingValueMinor).toBe(0n);
    /** The sum of the per-line costs is the total — not one paisa short. */
    const lineSum = run.movements.reduce((s, m) => s + m.cogsMinor, 0n);
    expect(lineSum).toBe(run.issuesValueMinor);
  });

  it("never turns a quantity into a float on the way in or out", () => {
    expect(parseQuantity("12.5")).toBe(12_500n);
    expect(parseQuantity("-0.001")).toBe(-1n);
    expect(formatQuantity(parseQuantity("1.005"))).toBe("1.005");
  });
});

describe("negative stock — the goods left before the invoice arrived", () => {
  /**
   * 🔴 REFUSING THE ISSUE WOULD BE WRONG. The bags went into the slab.
   * The system records what happened, costs it provisionally, and
   * corrects it when the purchase invoice is entered.
   */
  it("accepts the issue and marks the shortfall provisionally", () => {
    const run = runValuation({
      method: "fifo",
      movements: [
        receipt("r1", "2026-04-01T00:00:00.000Z", 10, 10_000n),
        issue("i1", "2026-04-05T00:00:00.000Z", 15),
      ],
    });
    expect(run.closingQuantity < 0n).toBe(true);
    expect(run.warnings.some((w) => w.code === "NEGATIVE_STOCK_PROVISIONAL")).toBe(true);
    expect(foots(run)).toBe(true);
  });

  it("trues the provisional cost up when the real receipt arrives, and still foots", () => {
    const run = runValuation({
      method: "fifo",
      movements: [
        receipt("r1", "2026-04-01T00:00:00.000Z", 10, 10_000n),
        issue("i1", "2026-04-05T00:00:00.000Z", 15),
        /** The late invoice, at a HIGHER price than the one guessed. */
        receipt("r2", "2026-04-11T00:00:00.000Z", 5, 20_000n),
      ],
    });
    expect(run.closingQuantity).toBe(0n);
    expect(run.closingValueMinor).toBe(0n);
    /** Everything bought has been charged out; nothing is stranded. */
    expect(run.issuesValueMinor).toBe(run.receiptsValueMinor);
    expect(run.negativeStockTrueUpMinor).not.toBe(0n);
    expect(run.warnings.some((w) => w.code === "NEGATIVE_STOCK_TRUE_UP")).toBe(true);
    expect(foots(run)).toBe(true);
  });

  it("refuses to invent a cost when there is no evidence at all", () => {
    const run = runValuation({
      method: "weighted_average",
      movements: [issue("i1", "2026-04-05T00:00:00.000Z", 5)],
    });
    /** ⭐ A stated gap, not a plausible guess. */
    expect(run.complete).toBe(false);
    expect(run.warnings.some((w) => w.code === "NO_COST_EVIDENCE")).toBe(true);
    expect(run.issuesValueMinor).toBe(0n);
    expect(foots(run)).toBe(true);
  });

  it("does not back-compute a receipt whose cost was never recorded", () => {
    const run = runValuation({
      method: "fifo",
      movements: [
        { ...receipt("old", "2023-04-01T00:00:00.000Z", 50, 0n), unitCostMinor: null },
        receipt("r1", "2026-04-01T00:00:00.000Z", 10, 10_000n),
      ],
    });
    expect(run.complete).toBe(false);
    expect(run.warnings.some((w) => w.code === "MISSING_RECEIPT_COST")).toBe(true);
  });
});

describe("a closed period must not be revalued", () => {
  const closedPeriods = [
    { name: "March 2026", startDate: "2026-03-01", endDate: "2026-03-31" },
  ];

  it("refuses to capitalise a landed cost dated inside a closed month", () => {
    expect(() =>
      runValuation({
        method: "fifo",
        movements: [receipt("r1", "2026-03-05T00:00:00.000Z", 10, 10_000n)],
        landedCosts: [
          {
            id: "lc1",
            attachesToMovementId: "r1",
            amountMinor: 50_000n,
            atDate: "2026-03-20",
          },
        ],
        closedPeriods,
      }),
    ).toThrow(PeriodClosedError);
  });

  it("allows the same charge once it is dated in an open period", () => {
    const run = runValuation({
      method: "fifo",
      movements: [receipt("r1", "2026-03-05T00:00:00.000Z", 10, 10_000n)],
      landedCosts: [
        {
          id: "lc1",
          attachesToMovementId: "r1",
          amountMinor: 50_000n,
          atDate: "2026-04-02",
        },
      ],
      closedPeriods,
    });
    /** Nothing sold yet, so the whole charge sits in stock. */
    expect(run.landedCostToStockMinor).toBe(50_000n);
    expect(run.landedCostToCogsMinor).toBe(0n);
    expect(foots(run)).toBe(true);
  });

  it("replaying history through a closed month is not refused — only new postings are", () => {
    const run = runValuation({
      method: "fifo",
      movements: [
        receipt("r1", "2026-03-05T00:00:00.000Z", 10, 10_000n),
        issue("i1", "2026-03-09T00:00:00.000Z", 4),
      ],
      closedPeriods,
    });
    expect(run.issuesValueMinor).toBe(40_000n);
    expect(foots(run)).toBe(true);
  });
});

describe("landed cost changes the cost of a receipt after it was received", () => {
  it("splits the charge between what is left and what was already sold", () => {
    const run = runValuation({
      method: "fifo",
      movements: [
        receipt("r1", "2026-04-01T00:00:00.000Z", 10, 10_000n),
        issue("i1", "2026-04-05T00:00:00.000Z", 6),
      ],
      landedCosts: [
        {
          id: "lc1",
          attachesToMovementId: "r1",
          amountMinor: 10_000n,
          atDate: "2026-04-10",
        },
      ],
    });
    /** 4 of 10 units remain, so 40% capitalises and 60% is cost of sales. */
    expect(run.landedCostToStockMinor + run.landedCostToCogsMinor).toBe(10_000n);
    expect(run.landedCostToCogsMinor > 0n).toBe(true);
    expect(run.warnings.some((w) => w.code === "LANDED_COST_AFTER_CONSUMPTION")).toBe(true);
    expect(foots(run)).toBe(true);
  });
});

describe("specific identification and standard cost", () => {
  it("costs the exact batch that left, and refuses an issue that names none", () => {
    const movements = [
      receipt("r1", "2026-04-01T00:00:00.000Z", 10, 10_000n, "A"),
      receipt("r2", "2026-04-02T00:00:00.000Z", 10, 30_000n, "B"),
      issue("i1", "2026-04-05T00:00:00.000Z", 10, "B"),
    ];
    const run = runValuation({ method: "specific", movements });
    /** The expensive batch left, so COGS is the expensive one — not FIFO's. */
    expect(run.issuesValueMinor).toBe(300_000n);
    expect(run.issuesValueMinor).not.toBe(
      runValuation({ method: "fifo", movements }).issuesValueMinor,
    );
    expect(foots(run)).toBe(true);

    expect(() =>
      runValuation({
        method: "specific",
        movements: [
          receipt("r1", "2026-04-01T00:00:00.000Z", 10, 10_000n, "A"),
          issue("i1", "2026-04-05T00:00:00.000Z", 1),
        ],
      }),
    ).toThrow(ValuationError);
  });

  it("holds stock at standard and separates the purchase price variance", () => {
    const run = runValuation({
      method: "standard",
      standardCostMinor: 10_000n,
      movements: [
        receipt("r1", "2026-04-01T00:00:00.000Z", 10, 15_000n),
        issue("i1", "2026-04-05T00:00:00.000Z", 4),
      ],
    });
    /** Issues leave at standard, never at what the last lorry charged. */
    expect(run.issuesValueMinor).toBe(40_000n);
    expect(run.closingValueMinor).toBe(60_000n);
    /** The overspend is a variance of the period, not closing stock. */
    expect(run.purchasePriceVarianceMinor).toBe(50_000n);
    expect(foots(run)).toBe(true);
  });

  it("refuses standard costing with no standard cost rather than guessing one", () => {
    expect(() =>
      runValuation({
        method: "standard",
        movements: [receipt("r1", "2026-04-01T00:00:00.000Z", 10, 15_000n)],
      }),
    ).toThrow(ValuationError);
  });
});
