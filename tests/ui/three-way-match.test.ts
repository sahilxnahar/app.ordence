/**
 * Ordence — ⭐⭐⭐ THE MATCH THAT MATCHED THE WRONG ORDER
 * Version: v1.19.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 `runThreeWayMatch` JOINED BILL LINES TO ORDER LINES BY DESCRIPTION,
 *    ACROSS THE WHOLE TENANT
 * ══════════════════════════════════════════════════════════════════════
 * The ON clause was `pol.tenant_id = pil.tenant_id AND lower(pol.desc) =
 * lower(pil.desc)` and named no `po_id` anywhere. A builder's purchase
 * ledger is fifty orders for "OPC 53 grade cement", so a bill against one
 * of them was measured against ALL of them — and, because it was a LEFT
 * JOIN, one bill line came back as several rows, producing several
 * findings and landing in `netImpactMinor` several times.
 *
 * ⚠️ THIS FILE PROVES THE DEFECT RATHER THAN ASSERTING THE FIX. The join
 * predicates — old and new — are modelled here and run against the REAL
 * `matchThreeWay`, so what is compared is two verdicts on one bill, not
 * two spellings of a SQL string.
 *
 * ⭐ AND THE STRING ASSERTIONS THAT REMAIN RUN AGAINST COMMENT-STRIPPED
 * SOURCE. A test that greps a whole file for something that must NOT be
 * there fails on the comment explaining why it is not there, and that has
 * cost this repository five separate afternoons.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_TOLERANCE,
  fromThousandths,
  matchThreeWay,
  toThousandths,
  type MatchLine,
} from "@/lib/purchases/three-way";

const ROOT = join(__dirname, "..", "..");
const ACTION = readFileSync(join(ROOT, "server/actions/purchase-orders.ts"), "utf8");

const codeOnly = (s: string) =>
  s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));

const CODE = codeOnly(ACTION);

/** The SQL of the match, on its own, so an assertion cannot pass on some
 *  other query in the file that happens to mention `po_id`. */
const MATCH_SQL = (() => {
  const from = CODE.indexOf("const lines = await tx.execute");
  const to = CODE.indexOf("const rows = rowsOf", from);
  expect(from, "the match query").toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return CODE.slice(from, to);
})();

/** Likewise for the status recompute — the whole function, query and all. */
const STATUS_FN = (() => {
  const from = CODE.indexOf("async function recomputeOrderStatus");
  const to = CODE.indexOf("async function nextNumber", from);
  expect(from, "recomputeOrderStatus").toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return CODE.slice(from, to);
})();

/* ================================================================== */
/* THE FIXTURE: A LEDGER WITH TWO ORDERS FOR THE SAME CEMENT           */
/* ================================================================== */

const NOW = new Date("2026-04-01T00:00:00.000Z");

interface PoLine {
  readonly id: string;
  readonly poId: string;
  readonly lineNo: number;
  readonly description: string;
  /** Thousandths, as `purchase_order_lines.ordered_qty` stores them. */
  readonly orderedQty: bigint;
  readonly unitPriceMinor: bigint;
}

interface BillLine {
  readonly id: string;
  /** ⚠️ `purchase_invoices.po_id`. NULL on a utility bill. */
  readonly poId: string | null;
  readonly description: string;
  readonly invoicedQty: bigint;
  readonly unitPriceMinor: bigint;
}

interface GrnLine {
  readonly poLineId: string;
  readonly accepted: bigint;
  readonly rejected: bigint;
}

/**
 * ⭐ THE THREE JOINS, MODELLED EXACTLY AS THE SQL EXPRESSES THEM.
 *
 * `tenantWide`  — the shipped-and-wrong ON clause: description only.
 * `sameOrder`   — `pol.po_id = pi.po_id` and NO row limit.
 * `firstOnOrder`— what the fix does: the LATERAL, ordered by line number,
 *                 LIMIT 1.
 *
 * ⚠️ `sameOrder` IS HERE BECAUSE IT IS THE OBVIOUS HALF-FIX and it is not
 * enough. See ② below.
 */
type JoinMode = "tenantWide" | "sameOrder" | "firstOnOrder";

function orderLinesFor(bill: BillLine, poLines: readonly PoLine[], mode: JoinMode): PoLine[] {
  const sameDescription = poLines.filter(
    (l) => l.description.toLowerCase() === bill.description.toLowerCase(),
  );
  if (mode === "tenantWide") return sameDescription;

  // `pol.po_id = pi.po_id` is never true when `pi.po_id` is NULL, and that
  // is the whole answer for a bill with no order behind it.
  const onThisOrder = sameDescription.filter(
    (l) => bill.poId !== null && l.poId === bill.poId,
  );
  if (mode === "sameOrder") return onThisOrder;

  return [...onThisOrder].sort((a, b) => a.lineNo - b.lineNo).slice(0, 1);
}

/** One SELECT, returning what the action would hand to `matchThreeWay`. */
function selectMatchLines(
  bills: readonly BillLine[],
  poLines: readonly PoLine[],
  receipts: readonly GrnLine[],
  mode: JoinMode,
): MatchLine[] {
  const out: MatchLine[] = [];
  for (const bill of bills) {
    const matched = orderLinesFor(bill, poLines, mode);

    // ⚠️ LEFT JOIN: no order line still returns the bill line, with nulls.
    if (matched.length === 0) {
      out.push({
        lineKey: bill.id,
        description: bill.description,
        orderedQty: null,
        orderedUnitPriceMinor: null,
        receivedQty: null,
        rejectedQty: "0.000",
        invoicedQty: fromThousandths(bill.invoicedQty),
        invoicedUnitPriceMinor: bill.unitPriceMinor,
      });
      continue;
    }

    for (const pol of matched) {
      const against = receipts.filter((g) => g.poLineId === pol.id);
      const accepted = against.reduce((a, g) => a + g.accepted, 0n);
      const rejected = against.reduce((a, g) => a + g.rejected, 0n);
      out.push({
        lineKey: bill.id,
        description: bill.description,
        orderedQty: fromThousandths(pol.orderedQty),
        orderedUnitPriceMinor: pol.unitPriceMinor,
        receivedQty: fromThousandths(accepted),
        rejectedQty: fromThousandths(rejected),
        invoicedQty: fromThousandths(bill.invoicedQty),
        invoicedUnitPriceMinor: bill.unitPriceMinor,
      });
    }
  }
  return out;
}

const verdictFor = (
  bills: readonly BillLine[],
  poLines: readonly PoLine[],
  receipts: readonly GrnLine[],
  mode: JoinMode,
) => matchThreeWay(selectMatchLines(bills, poLines, receipts, mode), DEFAULT_TOLERANCE, NOW);

/* ================================================================== */
/* ① ONE BILL, TWO ORDERS, AND THE VERDICT CAME FROM THE WRONG ONE     */
/* ================================================================== */

describe("the match reaches only the bill's own purchase order", () => {
  /**
   * Two orders for the same cement, spelled with different capitals
   * because `lower()` is what made them collide:
   *
   *   PO-A  100.000 bags at ₹500.00 — fully received, fully billed.
   *   PO-B   20.000 bags at ₹500.00 — a different, smaller order.
   *
   * The bill names PO-A and agrees with it on every number.
   */
  const poLines: PoLine[] = [
    {
      id: "pol-a1",
      poId: "po-a",
      lineNo: 1,
      description: "OPC 53 grade cement",
      orderedQty: toThousandths("100"),
      unitPriceMinor: 50_000n,
    },
    {
      id: "pol-b1",
      poId: "po-b",
      lineNo: 1,
      description: "OPC 53 Grade Cement",
      orderedQty: toThousandths("20"),
      unitPriceMinor: 50_000n,
    },
  ];

  const receipts: GrnLine[] = [
    { poLineId: "pol-a1", accepted: toThousandths("100"), rejected: 0n },
    { poLineId: "pol-b1", accepted: toThousandths("20"), rejected: 0n },
  ];

  const bill: BillLine[] = [
    {
      id: "pil-1",
      poId: "po-a",
      description: "OPC 53 grade cement",
      invoicedQty: toThousandths("100"),
      unitPriceMinor: 50_000n,
    },
  ];

  /** ⭐ The fix, on a bill that is right: nothing to report. */
  it("passes a bill that agrees with the order it names", () => {
    const verdict = verdictFor(bill, poLines, receipts, "firstOnOrder");
    expect(verdict.state).toBe("matched");
    expect(verdict.findings).toHaveLength(0);
    expect(verdict.netImpactMinor).toBe(0n);
  });

  /**
   * 🔴 THE DEFECT, DEMONSTRATED. The same correct bill, run through the
   * old ON clause, is condemned by an order it has nothing to do with:
   * PO-B ordered 20 and received 20, so a bill for 100 reads as 80 more
   * than the receipt supports — ₹40,000 of alarm on a bill where every
   * number is right.
   */
  it("the tenant-wide join condemned that same correct bill", () => {
    const verdict = verdictFor(bill, poLines, receipts, "tenantWide");
    expect(verdict.state).toBe("unmatched");
    expect(verdict.netImpactMinor).toBe(4_000_000n); // ₹40,000, invented
    expect(verdict.findings.map((f) => f.discrepancy)).toContain("over_received");
    // And it is PO-B's twenty bags doing the talking.
    expect(verdict.headline).toContain("20.000");
  });

  /**
   * ⚠️ AND IT FAILS THE OTHER WAY TOO, which is the expensive direction.
   * A bill for 20 bags against PO-B is cleared by PO-A's hundred: the
   * duplicate row that agrees produces no finding, and a genuinely
   * short-received line is passed because a DIFFERENT order covered it.
   */
  it("the tenant-wide join also cleared a bill it should have stopped", () => {
    const short: GrnLine[] = [
      { poLineId: "pol-a1", accepted: toThousandths("100"), rejected: 0n },
      // Nothing has arrived against PO-B at all.
    ];
    const billB: BillLine[] = [
      {
        id: "pil-2",
        poId: "po-b",
        description: "OPC 53 Grade Cement",
        invoicedQty: toThousandths("20"),
        unitPriceMinor: 50_000n,
      },
    ];

    const old = verdictFor(billB, poLines, short, "tenantWide");
    const fixed = verdictFor(billB, poLines, short, "firstOnOrder");

    // The fix says what is true: nothing was booked in against this line.
    expect(fixed.state).toBe("unmatched");
    expect(fixed.findings.map((f) => f.discrepancy)).toContain("not_received");

    // The old join produced a row from PO-A on which everything agreed,
    // so its `not_received` finding sits next to a clean one and the
    // net impact understates what is at stake.
    expect(old.findings.length).toBeGreaterThan(fixed.findings.length);
  });

  /** The join in the shipped SQL names the bill's order. */
  it("restricts the join on po_id in the query itself", () => {
    expect(MATCH_SQL).toContain("pol.po_id = pi.po_id");
    expect(MATCH_SQL).toContain("lower(pol.description) = lower(pil.description)");
    // ⚠️ The unrestricted form is gone, not merely commented out.
    expect(CODE).not.toContain("LEFT JOIN purchase_order_lines");
  });
});

/* ================================================================== */
/* ② ONE BILL LINE IS AT MOST ONE ROW                                  */
/* ================================================================== */

describe("a bill line cannot produce two findings", () => {
  /**
   * 🔴 `po_id` ALONE IS NOT ENOUGH, and this is why the fix is a LATERAL
   * rather than an extra AND. One order may carry the same description on
   * two lines — two delivery dates, two rates, a split against two
   * projects — and a plain join still returns both.
   *
   * PO-A: line 1 and line 2, both "TMT bar 12mm", 50.000 each at ₹600.00.
   * The bill charges 50.000 at ₹700.00: a real ₹5,000 price difference.
   */
  const poLines: PoLine[] = [
    {
      id: "pol-a1",
      poId: "po-a",
      lineNo: 1,
      description: "TMT bar 12mm",
      orderedQty: toThousandths("50"),
      unitPriceMinor: 60_000n,
    },
    {
      id: "pol-a2",
      poId: "po-a",
      lineNo: 2,
      description: "TMT bar 12mm",
      orderedQty: toThousandths("50"),
      unitPriceMinor: 60_000n,
    },
  ];

  const receipts: GrnLine[] = [
    { poLineId: "pol-a1", accepted: toThousandths("50"), rejected: 0n },
    { poLineId: "pol-a2", accepted: toThousandths("50"), rejected: 0n },
  ];

  const bill: BillLine[] = [
    {
      id: "pil-1",
      poId: "po-a",
      description: "TMT bar 12mm",
      invoicedQty: toThousandths("50"),
      unitPriceMinor: 70_000n,
    },
  ];

  /** ⭐ One line, one finding, and the money is the money. */
  it("reports the price difference exactly once", () => {
    const verdict = verdictFor(bill, poLines, receipts, "firstOnOrder");
    expect(verdict.findings).toHaveLength(1);
    expect(verdict.findings[0]!.discrepancy).toBe("price_differs");
    // 50.000 units × ₹100.00 = ₹5,000.00.
    expect(verdict.netImpactMinor).toBe(500_000n);
  });

  /**
   * ⚠️ THE HALF-FIX DOUBLES IT. Two matching order lines, two identical
   * findings, and `netImpactMinor` — the number on the approval screen —
   * is exactly twice the money at stake.
   */
  it("po_id alone would have counted it twice", () => {
    const half = verdictFor(bill, poLines, receipts, "sameOrder");
    expect(half.findings).toHaveLength(2);
    expect(half.netImpactMinor).toBe(1_000_000n);
    // Two rows, one bill line: the duplicate carries the same key.
    expect(new Set(half.findings.map((f) => f.lineKey)).size).toBe(1);
  });

  /** And the query says LIMIT 1, deterministically ordered. */
  it("takes one order line per bill line, in the query", () => {
    expect(MATCH_SQL).toContain("LEFT JOIN LATERAL");
    expect(MATCH_SQL).toContain("LIMIT 1");
    expect(MATCH_SQL).toContain("ORDER BY pol.line_no");
    expect(ACTION).toContain("ONE BILL LINE IS AT MOST ONE ROW");
  });
});

/* ================================================================== */
/* ③ A BILL WITH NO ORDER IS NOT MATCHED AGAINST EVERYTHING            */
/* ================================================================== */

describe("a bill with no po_id", () => {
  const poLines: PoLine[] = [
    {
      id: "pol-a1",
      poId: "po-a",
      lineNo: 1,
      description: "Diesel",
      orderedQty: toThousandths("500"),
      unitPriceMinor: 9_000n,
    },
  ];
  const receipts: GrnLine[] = [
    { poLineId: "pol-a1", accepted: toThousandths("500"), rejected: 0n },
  ];

  /** A fuel bill somebody typed in directly. No order, no receipt. */
  const utility: BillLine[] = [
    {
      id: "pil-9",
      poId: null,
      description: "Diesel",
      invoicedQty: toThousandths("40"),
      unitPriceMinor: 9_500n,
    },
  ];

  /**
   * ⭐ THE DECISION, STATED: A NON-PO BILL CANNOT BE THREE-WAY MATCHED.
   * Three documents, one missing, no comparison to make. `matchThreeWay`
   * already has the right word for it — `no_order` — and its headline
   * says somebody must still approve it on its own merits.
   */
  it("is reported as no_order rather than measured against a stranger", () => {
    const verdict = verdictFor(utility, poLines, receipts, "firstOnOrder");
    expect(verdict.state).toBe("no_order");
    expect(verdict.findings).toHaveLength(0);
    expect(verdict.netImpactMinor).toBe(0n);
    expect(verdict.headline).toContain("no purchase order behind this bill");
  });

  /**
   * 🔴 THE OLD JOIN GAVE IT A VERDICT. It found the diesel on somebody
   * else's purchase order, compared 40 litres against 500, and reported a
   * shortfall on a bill that was never going to have a receipt — a
   * control announcing a result about something it had not checked.
   */
  it("the tenant-wide join printed a verdict about it anyway", () => {
    const old = verdictFor(utility, poLines, receipts, "tenantWide");
    expect(old.state).not.toBe("no_order");
    expect(old.findings.length).toBeGreaterThan(0);
  });

  /** The reason is written down where the query is. */
  it("says in the source why a null po_id matches nothing", () => {
    expect(ACTION).toContain("A BILL WITH NO `po_id` MATCHES NOTHING");
  });
});

/* ================================================================== */
/* ④ THE ORDER'S STATUS IS DECIDED LINE BY LINE                        */
/* ================================================================== */

/**
 * 🔴 `recomputeOrderStatus` COMPARED TOTALS. Order 100 bags of cement and
 * 100 of sand; 120 cement arrive and 80 sand; the sums are 200 and 200
 * and the order closes as `received` with 20 bags of sand outstanding.
 */
interface StatusLine {
  readonly orderedQty: bigint;
  readonly accepted: bigint;
}

/** The shipped-and-wrong version: two sums, compared. */
function statusByTotal(lines: readonly StatusLine[]): string {
  const ordered = lines.reduce((a, l) => a + l.orderedQty, 0n);
  const accepted = lines.reduce((a, l) => a + l.accepted, 0n);
  return accepted <= 0n ? "approved" : accepted >= ordered ? "received" : "part_received";
}

/** The fix: counts of lines, exactly as the FILTER clauses count them. */
function statusByLine(lines: readonly StatusLine[]): string {
  const started = lines.filter((l) => l.accepted > 0n).length;
  const complete = lines.filter((l) => l.accepted >= l.orderedQty).length;
  return started === 0 ? "approved" : complete >= lines.length ? "received" : "part_received";
}

describe("recomputeOrderStatus", () => {
  const cementAndSand: StatusLine[] = [
    { orderedQty: toThousandths("100"), accepted: toThousandths("120") },
    { orderedQty: toThousandths("100"), accepted: toThousandths("80") },
  ];

  /** ⚠️ The defect, demonstrated: the surplus paid for the shortfall. */
  it("summing totals closed an order with a line still outstanding", () => {
    expect(statusByTotal(cementAndSand)).toBe("received");
  });

  it("counting lines leaves it part received", () => {
    expect(statusByLine(cementAndSand)).toBe("part_received");
  });

  /**
   * ⭐ OVER-DELIVERY STILL CLOSES ITS OWN LINE. `>=` per line is kept:
   * 101 of 100 is complete, and the extra unit is a finding for the
   * three-way match rather than a reason to leave the order open forever.
   */
  it("still closes an order that over-delivered on every line", () => {
    const over: StatusLine[] = [
      { orderedQty: toThousandths("100"), accepted: toThousandths("101") },
      { orderedQty: toThousandths("50"), accepted: toThousandths("50") },
    ];
    expect(statusByLine(over)).toBe("received");
  });

  /** Nothing booked in yet is `approved`, not `part_received`. */
  it("reports an untouched order as approved", () => {
    expect(statusByLine([{ orderedQty: toThousandths("100"), accepted: 0n }])).toBe("approved");
    // ⚠️ And an order with no lines makes no claim about goods either.
    expect(statusByLine([])).toBe("approved");
  });

  /** One line of two started is part received, whichever line it is. */
  it("reports a partly started order as part received", () => {
    expect(
      statusByLine([
        { orderedQty: toThousandths("100"), accepted: toThousandths("100") },
        { orderedQty: toThousandths("100"), accepted: 0n },
      ]),
    ).toBe("part_received");
  });

  /** The query counts lines and no longer sums quantities. */
  it("does the counting in Postgres, per line", () => {
    expect(STATUS_FN).toContain("FILTER (WHERE");
    expect(STATUS_FN).toContain("lines_complete");
    expect(STATUS_FN).toContain("COALESCE(recv.accepted, 0) >= pol.ordered_qty");
    // 🔴 The totals comparison is gone.
    expect(STATUS_FN).not.toContain("SUM(pol.ordered_qty)");
    expect(STATUS_FN).not.toContain("COALESCE(SUM(recv.accepted), 0)");
  });

  /**
   * ⚠️ AND NO QUANTITY CROSSES INTO JAVASCRIPT. What comes back is three
   * counts of lines; a `Number()` over `bigint` thousandths would be a
   * float on a quantity, which this codebase does not do anywhere.
   */
  it("brings back counts, not quantities", () => {
    expect(STATUS_FN).toContain("Number(row.line_count");
    expect(STATUS_FN).not.toContain("Number(row.ordered");
    expect(STATUS_FN).not.toContain("Number(row.accepted");
  });
});

/* ================================================================== */
/* ⑤ THE NUMBERING RACE, AND THE ANSWER TO IT                          */
/* ================================================================== */

describe("nextNumber and nextGrnNumber", () => {
  /**
   * 🔴 THE RACE IS REAL AND IS NOT DENIED. `MAX(...) + 1` read outside a
   * lock hands the same number to two concurrent transactions, and this
   * demonstrates exactly that: two readers of one maximum, one number.
   */
  it("two concurrent reads of the maximum propose the same number", () => {
    const maxSoFar = 41;
    const propose = (max: number) => `GRN-${String(max + 1).padStart(5, "0")}`;
    // Both transactions began before either committed, so both see 41.
    expect(propose(maxSoFar)).toBe(propose(maxSoFar));
    expect(propose(maxSoFar)).toBe("GRN-00042");
  });

  /**
   * ⭐ WHICH IS WHY THE INDEX IS THE GUARANTEE. 0063 carries
   * `goods_receipts_number_unique (tenant_id, grn_number)`, so the second
   * INSERT raises 23505 and the whole transaction — receipt, lines, stock
   * movements, status — rolls back together. Nothing partial survives.
   */
  it("leans on the unique index, and says so", () => {
    expect(ACTION).toContain("THE UNIQUE INDEX IS THE GUARANTEE");
    expect(ACTION).toContain("goods_receipts_number_unique");
    expect(ACTION).toContain("purchase_orders_number_unique");
  });

  /**
   * ⚠️ AND THE REJECTED ALTERNATIVE IS NAMED. An advisory transaction
   * lock cannot be released before COMMIT, so it would serialise the
   * whole receipt path — inserts, stock movements and all — for a tenant,
   * to prevent a collision the index already prevents.
   */
  it("says why the advisory lock was rejected, and takes none", () => {
    expect(ACTION).toContain("WHY THE ADVISORY LOCK WAS REJECTED");
    expect(ACTION).toContain("pg_advisory_xact_lock");
    // ⚠️ Named in prose only. The code takes no lock.
    expect(CODE).not.toContain("pg_advisory");
    expect(CODE).not.toContain("FOR UPDATE");
  });

  /** ⭐ Consistent with `nextOrderNo`, deliberately, and it says that too. */
  it("matches the reasoning already used for sales order numbers", () => {
    expect(ACTION).toContain("nextOrderNo");
    const ORDERS = readFileSync(join(ROOT, "server/actions/orders.ts"), "utf8");
    expect(ORDERS).toContain("THE UNIQUE INDEX IS THE ACTUAL GUARANTEE");
  });
});
