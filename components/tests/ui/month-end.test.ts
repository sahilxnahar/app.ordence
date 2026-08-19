/**
 * Ordence — ⭐⭐⭐ THE MONTH-END PAIR
 * Version: v1.18.0-alpha
 *
 * ⚠️ The two controls these tests exist to protect are the blind count
 * and the refusal to auto-match. Both are the kind of rule that a later
 * "improvement" removes for entirely reasonable-sounding reasons, and
 * neither failure is visible afterwards: a sighted count simply reports
 * no variances, and a confident wrong match reconciles to zero.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assessCount,
  fromMilliunits,
  movementsFor,
  sheetFor,
  toMilliunits,
  varianceOf,
  type CountLine,
} from "@/lib/inventory/counting";
import {
  AMBIGUOUS_WITHIN,
  fingerprintOf,
  findDuplicates,
  normaliseReference,
  proposalsFor,
  reconcile,
  scoreCandidate,
  type LedgerCandidate,
  type StatementLine,
} from "@/lib/banking/match";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");
const NOW = new Date("2026-04-30T10:00:00Z");

function line(over: Partial<CountLine> = {}): CountLine {
  return {
    lineId: "l1",
    stockItemId: "i1",
    itemName: "Bearing 6204",
    itemCode: "BRG-6204",
    batchNo: null,
    uom: "nos",
    expectedQuantity: "100.000",
    countedQuantity: null,
    varianceNote: null,
    unitCostMinor: 10_000n,
    ...over,
  };
}

/* ================================================================== */
/* THE BLIND COUNT                                                     */
/* ================================================================== */

describe("the counter is not shown what the system expects", () => {
  it("strips the expected quantity from the sheet entirely", () => {
    const sheet = sheetFor([line({ expectedQuantity: "412.000" })]);
    const asText = JSON.stringify(sheet);
    expect(asText).not.toContain("412");
    expect(asText).not.toContain("expected");
  });

  it("keeps only what a person needs to find the thing and write a number", () => {
    const [row] = sheetFor([line()]);
    expect(Object.keys(row!).sort()).toEqual([
      "batchNo",
      "countedQuantity",
      "itemCode",
      "itemName",
      "lineId",
      "uom",
    ]);
  });

  /**
   * 🔴 THE FILTERING HAPPENS ON THE SERVER. Doing it in the component
   * would leave the expected figure in the payload the browser already
   * received, one devtools tab away from the person counting.
   */
  it("is applied by the server action, not by a component", () => {
    const action = read("server/actions/stock-counts.ts");
    expect(action).toContain("sheetFor(lines)");
    const component = read("components/inventory/count-manager.tsx");
    expect(component).not.toContain("expectedQuantity");
  });

  /** ⚠️ Recording a figure must not tell the counter what it differed from. */
  it("does not return a variance when a figure is recorded", () => {
    const action = read("server/actions/stock-counts.ts");
    const recordFn = action.slice(
      action.indexOf("export async function recordCount"),
      action.indexOf("export async function getCountReview"),
    );
    expect(recordFn).not.toContain("varianceOf");
    expect(recordFn).not.toContain("assessCount");
  });
});

/* ================================================================== */
/* THE ARITHMETIC                                                      */
/* ================================================================== */

describe("quantities do not drift", () => {
  it("adds thirds without a floating point error", () => {
    // ⚠️ 0.1 + 0.2 !== 0.3 in IEEE 754. A warehouse in kilograms to
    // three places accumulates this into a permanent phantom variance.
    const total = toMilliunits("0.100") + toMilliunits("0.200");
    expect(fromMilliunits(total)).toBe("0.300");
  });

  it("refuses more precision than the column holds", () => {
    expect(() => toMilliunits("1.2345")).toThrow(/three decimal places/);
  });

  it("round-trips a negative", () => {
    expect(fromMilliunits(toMilliunits("-12.500"))).toBe("-12.500");
  });
});

describe("severity is by value, never by percentage", () => {
  /**
   * ⭐ THE POINT: a huge percentage of something cheap is not the
   * problem, and ranking by percentage buries the thing worth
   * investigating under a pile of washers.
   */
  it("treats a large percentage of a cheap item as minor", () => {
    // 50 units missing at ₹1.00 each = ₹50.
    const v = varianceOf(
      line({ expectedQuantity: "100.000", countedQuantity: "50.000", unitCostMinor: 100n }),
      NOW,
    );
    expect(v!.severity).toBe("minor");
  });

  it("treats a small percentage of an expensive item as serious", () => {
    // 2 units missing at ₹9,000 each = ₹18,000.
    const v = varianceOf(
      line({
        expectedQuantity: "100.000",
        countedQuantity: "98.000",
        unitCostMinor: 900_000n,
      }),
      NOW,
    );
    expect(v!.severity).toBe("serious");
  });

  it("signs the difference so extra stock is positive", () => {
    const v = varianceOf(
      line({ expectedQuantity: "10.000", countedQuantity: "12.000" }),
      NOW,
    );
    expect(v!.differenceQuantity).toBe("2.000");
    expect(v!.differenceValueMinor).toBe(20_000n);
  });
});

/* ================================================================== */
/* WHAT BLOCKS A POSTING                                               */
/* ================================================================== */

describe("a count is not posted until it is finished and explained", () => {
  it("refuses while any line is uncounted, because a blank is not a zero", () => {
    const a = assessCount(
      [
        line({ lineId: "a", countedQuantity: "100.000" }),
        line({ lineId: "b", countedQuantity: null }),
      ],
      NOW,
    );
    expect(a.mayPost).toBe(false);
    expect(a.blockers.join(" ")).toContain("not the same as finding none");
  });

  it("refuses a difference with no explanation written against it", () => {
    const a = assessCount(
      [line({ lineId: "a", countedQuantity: "97.000", varianceNote: null })],
      NOW,
    );
    expect(a.mayPost).toBe(false);
    expect(a.blockers.join(" ")).toContain("no explanation");
  });

  it("demands a note for a tiny difference too", () => {
    // 🔴 The small unexplained ones are the ones that turn out, a year
    // later, to have been the same person taking the same thing weekly.
    const v = varianceOf(
      line({ expectedQuantity: "100.000", countedQuantity: "99.999", unitCostMinor: 1n }),
      NOW,
    );
    expect(v!.needsNote).toBe(true);
  });

  it("allows a clean, complete count", () => {
    const a = assessCount([line({ countedQuantity: "100.000" })], NOW);
    expect(a.mayPost).toBe(true);
  });
});

describe("gains and losses are never netted for judgement", () => {
  it("reports both halves and remarks on the offset", () => {
    const a = assessCount(
      [
        line({ lineId: "a", countedQuantity: "110.000", varianceNote: "found in bay 4" }),
        line({ lineId: "b", countedQuantity: "90.000", varianceNote: "short" }),
      ],
      NOW,
    );
    expect(a.gainValueMinor).toBe(100_000n);
    expect(a.lossValueMinor).toBe(100_000n);
    // ⚠️ Nets to zero, and must not therefore look like a clean month.
    expect(a.netValueMinor).toBe(0n);
    expect(a.remarks.join(" ")).toContain("both missing and extra");
  });

  it("says so when a large sheet comes back perfect", () => {
    const lines = Array.from({ length: 30 }, (_, i) =>
      line({ lineId: `l${i}`, countedQuantity: "100.000" }),
    );
    const a = assessCount(lines, NOW);
    expect(a.remarks.join(" ")).toContain("unusual");
  });
});

describe("posting writes movements, never a balance", () => {
  it("skips zero-variance lines", () => {
    const lines = [
      line({ lineId: "a", countedQuantity: "100.000" }),
      line({ lineId: "b", countedQuantity: "95.000", varianceNote: "damaged" }),
    ];
    const moves = movementsFor(assessCount(lines, NOW), lines);
    expect(moves).toHaveLength(1);
    expect(moves[0]!.quantity).toBe("-5.000");
  });

  it("the action never updates stock_balances directly", () => {
    const action = read("server/actions/stock-counts.ts");
    // ⚠️ It may READ balances to snapshot them. It must never write.
    expect(action).not.toMatch(/\.update\(stockBalances\)/);
    expect(action).toContain(".insert(stockMovements)");
  });

  it("posts to the ledger in the same transaction", () => {
    const action = read("server/actions/stock-counts.ts");
    expect(action).toContain("postStockCount");
  });
});

/* ================================================================== */
/* THE BANK                                                            */
/* ================================================================== */

function stmt(over: Partial<StatementLine> = {}): StatementLine {
  return {
    id: "s1",
    valueDate: "2026-04-10",
    amountMinor: -4_500_000n,
    narration: "NEFT DR RAMESH TRADERS N123456789",
    bankReference: null,
    ...over,
  };
}

function cand(over: Partial<LedgerCandidate> = {}): LedgerCandidate {
  return {
    id: "c1",
    kind: "vendor_payment",
    occurredOn: "2026-04-08",
    amountMinor: -4_500_000n,
    reference: null,
    counterpartyName: null,
    documentNo: "VP-0001",
    ...over,
  };
}

describe("a different amount is not a weak match, it is not a match", () => {
  it("scores zero rather than partially", () => {
    const s = scoreCandidate(stmt(), cand({ amountMinor: -4_400_000n }));
    expect(s.score).toBe(0);
    expect(s.reasons.join(" ")).toContain("cannot be the same event");
  });
});

describe("an amount alone never reaches strong", () => {
  /**
   * 🔴 THE TRAP THE WHOLE MODULE IS ARRANGED AROUND. In a business with
   * regular payments several will be for identical amounts, and
   * amount-only matching pairs them at random. It reconciles perfectly
   * and leaves two accounts wrong.
   */
  it("stays below strong with nothing else agreeing", () => {
    const s = scoreCandidate(
      stmt({ valueDate: "2026-06-30", narration: "no clue" }),
      cand({ occurredOn: "2026-01-01", reference: null }),
    );
    expect(s.confidence).not.toBe("strong");
  });

  it("reaches strong once the reference agrees as well", () => {
    const s = scoreCandidate(stmt(), cand({ reference: "N123456789" }));
    expect(s.confidence).toBe("strong");
  });
});

describe("ambiguity is reported rather than resolved", () => {
  it("flags two candidates that fit equally well", () => {
    const p = proposalsFor(stmt(), [
      cand({ id: "a", documentNo: "VP-0001" }),
      cand({ id: "b", documentNo: "VP-0002" }),
    ]);
    expect(p.ambiguous).toBe(true);
    expect(p.headline).toContain("guess");
  });

  it("does not flag a clear winner", () => {
    const p = proposalsFor(stmt(), [
      cand({ id: "a", reference: "N123456789" }),
      cand({ id: "b", occurredOn: "2026-02-01" }),
    ]);
    expect(p.ambiguous).toBe(false);
  });

  it("says money arrived unrecorded when nothing fits", () => {
    const p = proposalsFor(stmt({ amountMinor: 12_500n }), []);
    expect(p.headline).toContain("not recorded anywhere");
  });

  it("keeps the ambiguity threshold small enough to be meaningful", () => {
    expect(AMBIGUOUS_WITHIN).toBeGreaterThan(0);
    expect(AMBIGUOUS_WITHIN).toBeLessThan(25);
  });
});

describe("references survive how humans and banks write them", () => {
  it("matches a cheque number across formatting and leading zeros", () => {
    expect(normaliseReference("CHQ 000123")).toBe(normaliseReference("chq-123"));
  });

  it("returns null for something with no content", () => {
    expect(normaliseReference("  --  ")).toBeNull();
  });
});

describe("the reconciliation arithmetic", () => {
  it("reconciles when both lists explain the gap exactly", () => {
    const r = reconcile({
      ledgerClosingMinor: 1_000_000n,
      // Bank is higher by an unrecorded deposit of 50,000...
      statementClosingMinor: 1_020_000n,
      unmatchedInBank: [stmt({ amountMinor: 50_000n })],
      // ...and lower by an unpresented cheque of 30,000.
      unmatchedInLedger: [cand({ amountMinor: 30_000n })],
    });
    expect(r.unexplainedMinor).toBe(0n);
    expect(r.reconciles).toBe(true);
  });

  it("reports a residue plainly rather than as a rounding issue", () => {
    const r = reconcile({
      ledgerClosingMinor: 1_000_000n,
      statementClosingMinor: 1_000_100n,
      unmatchedInBank: [],
      unmatchedInLedger: [],
    });
    expect(r.reconciles).toBe(false);
    expect(r.unexplainedMinor).toBe(100n);
    expect(r.notes.join(" ")).toContain("not a rounding error");
  });

  it("describes the two lists as different problems", () => {
    const r = reconcile({
      ledgerClosingMinor: 0n,
      statementClosingMinor: 0n,
      unmatchedInBank: [stmt({ amountMinor: -500n })],
      unmatchedInLedger: [cand({ amountMinor: -500n })],
    });
    const text = r.notes.join(" ");
    expect(text).toContain("without being recorded here");
    expect(text).toContain("have not reached the bank");
  });
});

describe("importing the same statement twice is caught", () => {
  it("fingerprints on what a bank cannot change between exports", () => {
    const a = fingerprintOf({
      valueDate: "2026-04-10",
      amountMinor: -4_500_000n,
      narration: "NEFT  DR   Ramesh",
    });
    const b = fingerprintOf({
      valueDate: "2026-04-10",
      amountMinor: -4_500_000n,
      narration: "neft dr ramesh",
    });
    expect(a).toBe(b);
  });

  it("flags a line already stored", () => {
    const incoming = [
      { valueDate: "2026-04-10", amountMinor: -4_500_000n, narration: "NEFT DR" },
    ];
    const dupes = findDuplicates(incoming, [fingerprintOf(incoming[0]!)]);
    expect(dupes).toHaveLength(1);
  });

  it("reports rather than refuses, because two identical payments happen", () => {
    const sql = read("SQL-FILES/0070_bank_reconciliation.sql");
    // ⚠️ An index, never a unique constraint. See 0070.
    expect(sql).toContain("bank_statement_lines_fingerprint_idx");
    expect(sql).not.toMatch(/UNIQUE INDEX[^;]*fingerprint/);
  });
});

/* ================================================================== */
/* THE RULES THAT LIVE IN THE DATABASE                                 */
/* ================================================================== */

describe("0070 enforces what the comments promise", () => {
  const sql = () => read("SQL-FILES/0070_bank_reconciliation.sql");

  it("stops a count being posted twice", () => {
    expect(sql()).toContain("stock_counts_one_journal");
  });

  it("freezes a posted count's lines", () => {
    expect(sql()).toContain("ordence_guard_posted_count");
  });

  it("stops one document explaining two statement lines, and the reverse", () => {
    expect(sql()).toContain("bank_line_matches_one_per_line");
    expect(sql()).toContain("bank_line_matches_one_per_document");
  });

  it("keeps app_platform_scope out of WITH CHECK", () => {
    const withChecks = sql().match(/WITH CHECK \([^)]*\)/g) ?? [];
    expect(withChecks.length).toBeGreaterThan(0);
    for (const w of withChecks) expect(w).not.toContain("app_platform_scope");
  });
});

describe("both engines are reachable from a browser", () => {
  const mustBeReached: ReadonlyArray<readonly [string, string]> = [
    ["openCount", "app/(crm)/inventory/counts/page.tsx"],
    ["postCount", "app/(crm)/inventory/counts/page.tsx"],
    ["importStatement", "app/(crm)/banking/page.tsx"],
    ["confirmMatch", "app/(crm)/banking/[id]/page.tsx"],
    ["unmatch", "app/(crm)/banking/[id]/page.tsx"],
  ];

  for (const [action, screen] of mustBeReached) {
    it(`${action} is called from a screen`, () => {
      expect(existsSync(join(root, screen))).toBe(true);
      expect(read(screen)).toContain(action);
    });
  }
});

describe("nothing edits the bank's own evidence", () => {
  /**
   * 🔴 A tool that edits either side to make them agree has destroyed
   * the only evidence that something was wrong.
   */
  it("has no action that updates a statement line", () => {
    const action = read("server/actions/banking.ts");
    expect(action).not.toMatch(/\.update\(bankStatementLines\)/);
    expect(action).not.toMatch(/\.delete\(bankStatementLines\)/);
  });

  /**
   * ⚠️ THIS TEST USED TO ASSERT `inserts.toHaveLength(1)` AND THAT WAS THE
   * WRONG ASSERTION — v1.63.0 (0102).
   *
   * The invariant is "no row in `bank_line_matches` that a person did not
   * cause", and a count of insert sites is a proxy for it that stops being
   * true the moment a second legitimate person-initiated writer exists.
   * 0102 added one: `postBankLineAdjustment` writes the match for a journal
   * it has just posted, on a line the operator picked, in the same
   * transaction — because a charge written up and left unmatched stays on
   * the outstanding list and invites a second posting.
   *
   * ⭐ SO THE PROPERTY IS ASSERTED DIRECTLY: every insert names the person
   * responsible, and no bulk or score-triggered path exists. That is
   * stronger than the count was, and it does not fail a correct change.
   */
  it("has no auto-confirm at any score", () => {
    const action = read("server/actions/banking.ts");
    const inserts = [...action.matchAll(/\.insert\(bankLineMatches\)/g)];
    expect(inserts.length).toBeGreaterThan(0);

    for (const m of inserts) {
      /**
       * 🔴 EVERY MATCH RECORDS WHO DECIDED IT. A row written without a
       * person on it is an auto-confirm however it got there.
       *
       * ⚠️ THE WINDOW IS THE `values({ ... })` OBJECT, NOT 800
       * CHARACTERS. It was a fixed 800 until 0110 added
       * `allocated_minor` and its comment to the adjustment path, at
       * which point `confirmedBy` fell outside the window and a correct
       * change failed a correct test. The property is unchanged; only
       * the way it is located is. Two files asserted this the same
       * brittle way and both are fixed.
       */
      const start = action.indexOf("{", action.indexOf(".values(", m.index!));
      let depth = 0;
      let end = start;
      while (end < action.length) {
        if (action[end] === "{") depth += 1;
        if (action[end] === "}") {
          depth -= 1;
          if (depth === 0) break;
        }
        end += 1;
      }
      expect(action.slice(start, end + 1)).toContain("confirmedBy: ctx.user.id");
    }

    const confirmFn = action.slice(
      action.indexOf("export async function confirmMatch"),
      action.indexOf("export async function unmatch"),
    );
    expect(confirmFn).toContain(".insert(bankLineMatches)");

    // ⚠️ And nothing anywhere matches in bulk or off a score threshold.
    expect(action).not.toMatch(/autoConfirm|confirmAll|matchEverything/);
    expect(action).not.toMatch(/score\s*>=?\s*\d+\s*\)\s*\{?\s*await tx\.insert/);
  });
});
