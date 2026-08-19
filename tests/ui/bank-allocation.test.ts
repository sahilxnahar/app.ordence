/**
 * Ordence — 🔴🔴🔴 ONE RECEIPT AGAINST THREE INVOICES, AND THE RESIDUE
 * THAT MUST NOT VANISH · Batch 0110
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE DEFECT THESE TESTS WOULD HAVE CAUGHT
 * ══════════════════════════════════════════════════════════════════════
 * `0070` made bank matching strictly 1:1 with two unique indexes, and its
 * own comment says why: without an amount per row, one receipt can
 * explain two statement lines and the residue still comes to zero,
 * because the same rupees are counted on both sides.
 *
 * 🔴 THE DANGEROUS HALF-FIX IS TO ADD `allocated_minor`, BOUND THE SUMS,
 *    AND STOP THERE. Bounding the sums at `≤` stops over-explaining. It
 *    does NOT stop UNDER-explaining, and under-explaining is the one that
 *    silently loses money: a ₹10,000 line carrying ₹6,000 of allocations
 *    is no longer unmatched, so it drops off the outstanding list, and the
 *    ₹4,000 reappears at the bottom of the statement as an "unexplained
 *    difference" with nothing saying which line it came from.
 *
 * ⭐ SO THE TEST THAT MATTERS IS NOT "over-allocation is refused". It is
 *    `every paisa is either allocated to a document or printed on the
 *    statement as an outstanding item`, asserted as a property over
 *    generated inputs rather than checked on one worked example.
 *
 * ⚠️ AND NOTHING HERE PINS A COUNT, AN ID, A SUFFIX OR AN INCIDENTAL
 *    TOTAL. Pinned counts have now failed five correct changes in this
 *    codebase. Every assertion below is an invariant.
 */

import { describe, expect, it } from "vitest";
import {
  allocationRefusal,
  isFullyAllocated,
  journalAllocationRefusal,
  magnitude,
  remainingOf,
  residueOf,
  sumAllocated,
  type AllocationRow,
  type AllocationTarget,
} from "@/lib/banking/allocation";
import {
  buildBrs,
  printableBrs,
  type BrsInput,
  type ResidualItem,
} from "@/lib/banking/reconciliation";

/* ------------------------------------------------------------------ */
/* HELPERS                                                             */
/* ------------------------------------------------------------------ */

function row(id: string, allocatedMinor: bigint, matchedKind = "customer_receipt"): AllocationRow {
  return {
    id,
    statementLineId: "line-1",
    matchedKind,
    matchedId: `doc-${id}`,
    allocatedMinor,
  };
}

function target(amountMinor: bigint): AllocationTarget {
  return { id: "t", amountMinor, label: "This bank line" };
}

/* ================================================================== */
/* ① THE ARITHMETIC OF AN ALLOCATION                                   */
/* ================================================================== */

describe("allocation arithmetic", () => {
  /**
   * ⭐ THE CASE `0070` COULD NOT REPRESENT AT ALL. Three invoices, one
   * NEFT, and the line is fully explained only once all three are on it.
   */
  it("lets several documents together explain one line exactly", () => {
    const line = target(10_000_00n);
    const rows = [row("a", 4_000_00n), row("b", 3_500_00n), row("c", 2_500_00n)];

    expect(sumAllocated(rows)).toBe(line.amountMinor);
    expect(residueOf(line, rows)).toBe(0n);
    expect(isFullyAllocated(line, rows)).toBe(true);
  });

  /**
   * 🔴 AND UNTIL THEY ARE ALL ON IT, THE LINE IS PARTLY EXPLAINED AND THE
   * REMAINDER IS A NUMBER. Not a boolean, not "unmatched", a number.
   */
  it("reports the remainder while a line is only partly explained", () => {
    const line = target(10_000_00n);
    expect(residueOf(line, [row("a", 4_000_00n)])).toBe(6_000_00n);
    expect(isFullyAllocated(line, [row("a", 4_000_00n)])).toBe(false);
    expect(remainingOf(line, [row("a", 4_000_00n)])).toBe(6_000_00n);
  });

  /**
   * ⚠️ THE RESIDUE CARRIES THE SIGN OF THE THING IT BELONGS TO, so a
   * payment out and a receipt in cannot be confused by whatever reads it.
   */
  it("keeps the direction of a money-out line", () => {
    const payment = target(-25_000_00n);
    expect(residueOf(payment, [row("a", -10_000_00n)])).toBe(-15_000_00n);
    expect(remainingOf(payment, [row("a", -10_000_00n)])).toBe(-15_000_00n);
  });

  /** ⚠️ `-x` on a bigint is exact. `Math.abs` must never touch money. */
  it("takes magnitudes without leaving bigint", () => {
    expect(magnitude(-9_007_199_254_740_993n)).toBe(9_007_199_254_740_993n);
    expect(typeof magnitude(1n)).toBe("bigint");
  });
});

/* ================================================================== */
/* ② THE REFUSALS                                                      */
/* ================================================================== */

describe("what an allocation may not do", () => {
  const line = target(10_000_00n);

  const refuse = (existing: AllocationRow[], proposedMinor: bigint) =>
    allocationRefusal({ side: "line", target: line, existing, proposedMinor });

  it("permits an allocation that fits, including the last paisa of one", () => {
    expect(refuse([], 10_000_00n)).toBeNull();
    expect(refuse([row("a", 9_999_99n)], 1n)).toBeNull();
  });

  /**
   * 🔴 ONE PAISA OF OVER-ALLOCATION IS THE WHOLE DEFECT. If this passes,
   * the reconciliation can balance while being false.
   */
  it("refuses over-allocating a line by a single paisa", () => {
    expect(refuse([row("a", 10_000_00n)], 1n)).not.toBeNull();
    expect(refuse([], 10_000_01n)).not.toBeNull();
  });

  /**
   * ⚠️ AND THE REFUSAL SAYS HOW MUCH IS ACTUALLY LEFT. A refusal an
   * operator cannot act on sends them to the database.
   */
  it("names the room that remains", () => {
    const message = refuse([row("a", 6_000_00n)], 5_000_00n);
    expect(message).toContain((10_000_00n - 6_000_00n).toString());
  });

  /**
   * 🔴 AN ALLOCATION POINTING THE OTHER WAY LETS TWO ROWS CANCEL TO
   * NOTHING WHILE BOTH CLAIM TO EXPLAIN MONEY THAT MOVED.
   */
  it("refuses an allocation whose direction disagrees with the line", () => {
    expect(refuse([], -1_000_00n)).not.toBeNull();
    expect(
      allocationRefusal({
        side: "line",
        target: target(-10_000_00n),
        existing: [],
        proposedMinor: 1_000_00n,
      }),
    ).not.toBeNull();
  });

  it("refuses an allocation of nothing", () => {
    expect(refuse([], 0n)).not.toBeNull();
  });

  /**
   * ⭐ `excludeMatchId` IS HOW AN EDIT WORKS, and the property is that
   * re-checking a stored row against a total that excludes it always
   * fits. Counting a row twice refuses the one change somebody makes
   * after getting it wrong: shrinking it.
   */
  it("lets a stored allocation be re-checked and reduced", () => {
    const stored = row("a", 10_000_00n);
    // The row under test is excluded from `existing`, which is the contract.
    expect(refuse([], stored.allocatedMinor)).toBeNull();
    expect(refuse([], 4_000_00n)).toBeNull();
  });

  /**
   * 🔴 A JOURNAL WRITTEN UP FROM A LINE IS FOR THE WHOLE LINE BY
   * CONSTRUCTION. A partial allocation to one leaves a residue on the BRS
   * that no document can ever close, because a journal cannot be topped
   * up — only reversed.
   */
  it("refuses a partial or duplicate allocation to a journal", () => {
    const args = {
      matchedKind: "journal_entry",
      lineAmountMinor: -1_180_00n,
      existingRowCount: 0,
    };
    expect(journalAllocationRefusal({ ...args, proposedMinor: -1_180_00n })).toBeNull();
    expect(journalAllocationRefusal({ ...args, proposedMinor: -500_00n })).not.toBeNull();
    expect(
      journalAllocationRefusal({
        ...args,
        proposedMinor: -1_180_00n,
        existingRowCount: 1,
      }),
    ).not.toBeNull();
  });

  /** ⚠️ And it has no opinion about anything that is not a journal. */
  it("says nothing about a receipt or a payment", () => {
    for (const kind of ["customer_receipt", "vendor_payment"]) {
      expect(
        journalAllocationRefusal({
          matchedKind: kind,
          lineAmountMinor: 10_000_00n,
          proposedMinor: 1n,
          existingRowCount: 3,
        }),
      ).toBeNull();
    }
  });
});

/* ================================================================== */
/* ③ 🔴🔴🔴 THE RESIDUE REACHES THE STATEMENT                          */
/* ================================================================== */

describe("a partly explained line on the reconciliation statement", () => {
  const residual = (
    residueMinor: bigint,
    side: "bank" | "books" = "bank",
  ): ResidualItem => ({
    sourceId: `src-${residueMinor}-${side}`,
    sourceKind: side === "bank" ? null : "customer_receipt",
    side,
    occurredOn: "2026-05-10",
    residueMinor,
    description: "Still outstanding",
  });

  /**
   * 🔴🔴🔴 THE TEST THAT WOULD HAVE CAUGHT THE HALF-FIX.
   *
   * A ₹10,000 line with ₹6,000 allocated is not unmatched, so it appears
   * in NEITHER unmatched list. If `buildBrs` did not take the residue, the
   * missing ₹4,000 would land in `differenceMinor` — the statement would
   * still foot, and it would be lying about WHERE the gap is.
   */
  it("puts the residue in an outstanding category, never in the difference", () => {
    // ⚠️ ₹4,000 SITTING IN THE BANK AND NOT IN THE BOOKS MEANS THE BANK
    //    READS HIGH BY EXACTLY THAT. A direct credit not in the books is a
    //    SUBTRACT on the way from the bank balance to the book balance,
    //    so these are the balances that reconcile.
    const facts = {
      bankBalanceMinor: 4_000_00n,
      bookBalanceMinor: 0n,
      unmatchedInBank: [],
      unmatchedInLedger: [],
      toleranceMinor: 0n,
    } as const;

    const withResidue = buildBrs({
      ...facts,
      partlyExplained: [residual(4_000_00n)],
    });

    expect(withResidue.differenceMinor).toBe(0n);
    expect(withResidue.reconcilesExactly).toBe(true);
    expect(withResidue.totals.directCreditsMinor).toBe(4_000_00n);

    // 🔴 THE SAME FACTS WITH THE RESIDUE DROPPED. This is what shipping
    //    the half-fix would have produced: the account no longer
    //    reconciles, and the gap has no name and no line to point at.
    const dropped = buildBrs({ ...facts, partlyExplained: [] });
    expect(dropped.differenceMinor).not.toBe(0n);
    expect(dropped.totals.directCreditsMinor).toBe(0n);
  });

  /**
   * ⭐ THE RESIDUE IS CATEGORISED BY THE SAME RULE AS EVERYTHING ELSE.
   * It is not a fifth category: ₹4,000 still outstanding on a line that
   * brought money in is a direct credit not in the books, exactly as the
   * whole line would have been.
   */
  it("categorises a residue by its side and its sign, like any other item", () => {
    for (const side of ["bank", "books"] as const) {
      for (const amount of [7_777n, -7_777n]) {
        const brs = buildBrs({
          bankBalanceMinor: 0n,
          bookBalanceMinor: 0n,
          unmatchedInBank: [],
          unmatchedInLedger: [],
          partlyExplained: [residual(amount, side)],
          toleranceMinor: 0n,
        });
        const item = brs.items.find((i) => i.amountMinor === amount);
        expect(item).toBeDefined();
        expect(item!.side).toBe(side);
      }
    }
  });

  /**
   * ⚠️ A ZERO RESIDUE MEANS FULLY EXPLAINED AND MUST NOT BECOME AN ITEM.
   * `bank_reconciliation_items` has a CHECK forbidding an amount of zero,
   * so one here would make sign-off fail with a constraint error rather
   * than simply not printing a line that says nothing.
   */
  it("never emits an item for a residue of zero", () => {
    const brs = buildBrs({
      bankBalanceMinor: 0n,
      bookBalanceMinor: 0n,
      unmatchedInBank: [],
      unmatchedInLedger: [],
      partlyExplained: [residual(0n), residual(0n, "books")],
      toleranceMinor: 0n,
    });
    expect(brs.items.every((i) => i.amountMinor !== 0n)).toBe(true);
  });

  /** ⭐ And the operator is told these are remainders, not fresh items. */
  it("says on the statement that some items are remainders", () => {
    const brs = buildBrs({
      bankBalanceMinor: 4_000_00n,
      bookBalanceMinor: 0n,
      unmatchedInBank: [],
      unmatchedInLedger: [],
      partlyExplained: [residual(4_000_00n)],
      toleranceMinor: 0n,
    });
    expect(brs.notes.join(" ")).toMatch(/partly explained/i);
  });
});

/* ================================================================== */
/* ④ 🔴 THE IDENTITY STILL HOLDS, EXACTLY, IN MINOR UNITS              */
/* ================================================================== */

describe("the BRS identity with allocation in play", () => {
  /**
   * ⭐ GENERATED RATHER THAN HAND-PICKED, AND DETERMINISTIC. A seeded
   * generator explores shapes nobody would write by hand — mixed signs,
   * residues larger than their line, both sides at once — while still
   * failing identically on every run.
   *
   * ⚠️ NO CLOCK AND NO `Math.random()`. A test that is different every
   * run is a test that cannot be bisected.
   */
  function* generated(): Generator<BrsInput> {
    let seed = 20260819;
    const next = (bound: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % bound;
    };

    for (let caseIndex = 0; caseIndex < 200; caseIndex += 1) {
      const partlyExplained: ResidualItem[] = [];
      const howMany = next(5);
      for (let i = 0; i < howMany; i += 1) {
        const magnitudeMinor = BigInt(next(9_999_999) + 1);
        const negative = next(2) === 0;
        partlyExplained.push({
          sourceId: `g-${caseIndex}-${i}`,
          sourceKind: next(2) === 0 ? null : "customer_receipt",
          side: next(2) === 0 ? "bank" : "books",
          occurredOn: "2026-05-10",
          residueMinor: negative ? -magnitudeMinor : magnitudeMinor,
          description: `generated ${caseIndex}-${i}`,
        });
      }

      yield {
        bankBalanceMinor: BigInt(next(99_999_999)) - 50_000_000n,
        bookBalanceMinor: BigInt(next(99_999_999)) - 50_000_000n,
        unmatchedInBank: [],
        unmatchedInLedger: [],
        partlyExplained,
        toleranceMinor: BigInt(next(100)),
      };
    }
  }

  /**
   * 🔴 bank − cheques + deposits + charges − credits + difference = book,
   *    EXACTLY, for every input including nonsensical ones.
   *
   * ⚠️ THIS IS THE ONE THAT MUST NOT BREAK. `0102` guarantees it and 0110
   * adds a whole new source of items to the statement; if allocation can
   * make the identity drift by a paisa, the reconciliation is worthless.
   */
  it("foots to the paisa for every generated case", () => {
    let checked = 0;
    for (const input of generated()) {
      const brs = buildBrs(input);
      const rebuilt =
        brs.bankBalanceMinor -
        brs.totals.chequesNotPresentedMinor +
        brs.totals.depositsNotCreditedMinor +
        brs.totals.bankChargesMinor -
        brs.totals.directCreditsMinor +
        brs.differenceMinor;

      expect(rebuilt).toBe(brs.bookBalanceMinor);
      checked += 1;
    }
    // ⚠️ A property test that silently exercised nothing is the failure
    //    mode of property tests. Asserting the loop ran is not a pinned
    //    count: it is the difference between "passed" and "did not run".
    expect(checked).toBeGreaterThan(0);
  });

  /** ⭐ AND THE PRINTED FORM FOOTS FROM ITS OWN LINES, IN ITS OWN ORDER. */
  it("prints lines that foot for every generated case", () => {
    for (const input of generated()) {
      const lines = printableBrs(buildBrs(input));
      const opening = lines.find((l) => l.effect === "opening");
      const total = lines.find((l) => l.effect === "total");
      expect(opening).toBeDefined();
      expect(total).toBeDefined();

      let running = opening!.amountMinor;
      for (const line of lines) {
        if (line.effect === "add") running += line.amountMinor;
        if (line.effect === "subtract") running -= line.amountMinor;
      }
      expect(running).toBe(total!.amountMinor);
    }
  });

  /**
   * 🔴🔴 AND THE CONSERVATION PROPERTY, WHICH IS THE REAL CLAIM OF THIS
   *    BATCH: every paisa of every residue reaches one of the four
   *    category totals. Nothing is allowed to fall between them.
   */
  it("routes every paisa of every residue into a category total", () => {
    for (const input of generated()) {
      const brs = buildBrs(input);

      const expected = input.partlyExplained.reduce(
        (sum, r) => sum + (r.residueMinor < 0n ? -r.residueMinor : r.residueMinor),
        0n,
      );
      const inTotals =
        brs.totals.chequesNotPresentedMinor +
        brs.totals.depositsNotCreditedMinor +
        brs.totals.bankChargesMinor +
        brs.totals.directCreditsMinor;

      expect(inTotals).toBe(expected);
    }
  });
});
