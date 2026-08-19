/**
 * Ordence — ⭐⭐⭐ THE CENSUS, AND THE MATCH IT UNCOVERED
 * Version: v1.19.0-alpha
 *
 * ⚠️ Two of the assertions here are about claims I made in earlier
 * sessions and got wrong. They stay as tests rather than as a note in a
 * document, because a note is read once and a test is read every time.
 */

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_TOLERANCE,
  describeMinor,
  fromThousandths,
  matchThreeWay,
  toThousandths,
  withinPriceTolerance,
  type MatchLine,
  type Tolerance,
} from "@/lib/purchases/three-way";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");
const NOW = new Date("2026-05-31T00:00:00Z");

function line(over: Partial<MatchLine> = {}): MatchLine {
  return {
    lineKey: "l1",
    description: "TMT bar 12mm",
    orderedQty: "100.000",
    orderedUnitPriceMinor: 5_000_00n,
    receivedQty: "100.000",
    rejectedQty: "0.000",
    invoicedQty: "100.000",
    invoicedUnitPriceMinor: 5_000_00n,
    ...over,
  };
}

/* ================================================================== */
/* THE CENSUS                                                          */
/* ================================================================== */

describe("the orphan census", () => {
  it("has a recorded baseline", () => {
    expect(existsSync(join(root, "scripts/reachability-baseline.json"))).toBe(true);
  });

  /**
   * 🔴 THE FOUR TABLES THIS SESSION REACHED. If a later change orphans
   * any of them again, this fails by name rather than as a count.
   */
  it("no longer lists the tables v1.19.0 wired up", () => {
    const baseline = JSON.parse(read("scripts/reachability-baseline.json")).orphans;
    for (const t of [
      "purchase_orders",
      "purchase_order_lines",
      "goods_receipt_lines",
      "automation_events",
    ]) {
      expect(baseline).not.toContain(t);
    }
  });

  it("ratchets: the census exits non-zero on a new orphan", () => {
    const source = read("scripts/check-reachability.mjs");
    expect(source).toContain("process.exit(1)");
    // ⚠️ And it must never fail merely for having a baseline.
    expect(source).toContain("No new orphans");
  });

  it("runs clean against the checked-in baseline", () => {
    const out = execFileSync("node", ["scripts/check-reachability.mjs"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(out).toContain("No new orphans");
  });
});

/* ================================================================== */
/* THE CORRECTIONS                                                     */
/* ================================================================== */

describe("v1.16.0's claim is now true", () => {
  /**
   * 🔴 THE CLAIM WAS: 0068 gave the workflow engine its first business
   * events. Nothing wrote a row, in TypeScript or in SQL.
   */
  it("something writes an automation event", () => {
    const emit = read("server/automation/emit.ts");
    expect(emit).toContain(".insert(automationEvents)");
  });

  it("a real business action emits one", () => {
    const action = read("server/actions/purchase-orders.ts");
    expect(action).toContain("tryEmitAutomationEvent");
  });

  /**
   * ⚠️ AND THE OTHER END. `dispatchRecordEvent` was complete and uncalled
   * since v0.23.0.
   */
  it("something finally calls dispatchRecordEvent", () => {
    const drain = read("server/automation/drain.ts");
    expect(drain).toContain("dispatchRecordEvent");
  });

  it("only fires trigger types 0068's CHECK permits", () => {
    const emit = read("server/automation/emit.ts");
    const sql = read("SQL-FILES/0068_order_rhythm.sql");
    for (const t of ["record_created", "record_updated", "record_deleted", "webhook"]) {
      expect(sql).toContain(t);
    }
    // ⚠️ Anything outside that set would be refused by the database.
    const declared = emit.match(/"(record_\w+|webhook)"/g) ?? [];
    for (const d of declared) {
      expect(["record_created", "record_updated", "record_deleted", "webhook"]).toContain(
        d.replaceAll('"', ""),
      );
    }
  });

  /**
   * 🔴 A STALE BACKLOG IS NOT REPLAYED WHOLESALE. Two days of queued
   * reminders fired in one minute reach real customers at real cost.
   */
  it("skips stale events rather than firing them", () => {
    const drain = read("server/automation/drain.ts");
    expect(drain).toContain("STALE_AFTER_HOURS");
    expect(drain).toContain("older than");
  });

  /** ⚠️ A poisonous row must not stall the queue forever. */
  it("marks a failed event processed with its reason", () => {
    const drain = read("server/automation/drain.ts");
    expect(drain).toContain("Dispatch failed.");
  });
});

describe("v1.11.0's claim is now true", () => {
  it("something writes a purchase order", () => {
    const action = read("server/actions/purchase-orders.ts");
    expect(action).toContain(".insert(purchaseOrders)");
    expect(action).toContain(".insert(goodsReceipts)");
  });

  /**
   * 🔴 `match_state` HAS BEEN READ BY THE PAYMENT RUN SINCE v1.11.0 AND
   * NOTHING HAS EVER SET IT.
   */
  it("something finally sets match_state", () => {
    const action = read("server/actions/purchase-orders.ts");
    expect(action).toContain("matchState: verdict.state");
  });

  it("reaches every state 0063's CHECK permits", () => {
    const lib = read("lib/purchases/three-way.ts");
    for (const s of ["matched", "matched_within_tolerance", "unmatched", "no_order"]) {
      expect(lib).toContain(`"${s}"`);
    }
  });
});

/* ================================================================== */
/* THE MATCH                                                           */
/* ================================================================== */

describe("quantities do not drift", () => {
  it("round-trips three decimal places", () => {
    expect(fromThousandths(toThousandths("12.345"))).toBe("12.345");
  });

  it("refuses more precision than the column holds", () => {
    expect(() => toThousandths("1.2345")).toThrow(/three decimal places/);
  });
});

describe("three documents that agree", () => {
  it("matches", () => {
    const r = matchThreeWay([line()], DEFAULT_TOLERANCE, NOW);
    expect(r.state).toBe("matched");
    expect(r.findings).toHaveLength(0);
  });
});

describe("a bill with no order behind it", () => {
  /**
   * ⭐ NOT A FAILURE. Utilities, rent and professional fees never start
   * with a purchase order, and calling them unmatched trains people to
   * ignore the word.
   */
  it("is its own state", () => {
    const r = matchThreeWay(
      [line({ orderedQty: null, orderedUnitPriceMinor: null, receivedQty: null })],
      DEFAULT_TOLERANCE,
      NOW,
    );
    expect(r.state).toBe("no_order");
    expect(r.headline).toContain("normal for utilities");
  });
});

describe("the price, which is the one that gets through", () => {
  it("names the difference and what it costs over the line", () => {
    const r = matchThreeWay(
      [line({ invoicedUnitPriceMinor: 5_200_00n })],
      DEFAULT_TOLERANCE,
      NOW,
    );
    expect(r.state).toBe("unmatched");
    const price = r.findings.find((f) => f.discrepancy === "price_differs")!;
    // 100 units × ₹200 = ₹20,000
    expect(price.valueImpactMinor).toBe(2_000_000n);
    expect(price.explanation).toContain("was ordered at");
  });

  /**
   * 🔴 THE TIGHTER OF PERCENTAGE AND CAP WINS. 2% of ₹40 lakh is ₹80,000,
   * which is not a rounding difference.
   */
  it("lets the absolute cap beat a percentage on a large line", () => {
    const big: Tolerance = { priceBps: 200, priceCapMinor: 50_000n, quantityBps: 50 };
    // 2% of ₹40,00,000 would be ₹80,000. The cap is ₹500.
    expect(withinPriceTolerance(4_000_000_00n, 4_000_800_00n, big)).toBe(false);
  });

  it("lets the percentage beat the cap on a small line", () => {
    // ₹300 line, 2% is ₹6. A ₹7 difference is outside.
    expect(withinPriceTolerance(300_00n, 307_00n, DEFAULT_TOLERANCE)).toBe(false);
    expect(withinPriceTolerance(300_00n, 305_00n, DEFAULT_TOLERANCE)).toBe(true);
  });
});

describe("what arrived versus what is charged", () => {
  it("flags a bill for more than was accepted", () => {
    const r = matchThreeWay(
      [line({ receivedQty: "90.000", invoicedQty: "100.000" })],
      DEFAULT_TOLERANCE,
      NOW,
    );
    const f = r.findings.find((x) => x.discrepancy === "over_received")!;
    expect(f.valueImpactMinor).toBe(5_000_00n * 10n);
    expect(f.explanation).toContain("more than the receipt supports");
  });

  /**
   * 🔴 REJECTED IS NOT ACCEPTED. Forty bags arrive, six are torn, and the
   * bill charges for forty.
   */
  it("names rejected goods that are still being charged for", () => {
    const r = matchThreeWay(
      [line({ receivedQty: "100.000", rejectedQty: "6.000", invoicedQty: "100.000" })],
      DEFAULT_TOLERANCE,
      NOW,
    );
    const f = r.findings.find((x) => x.discrepancy === "rejected_but_invoiced")!;
    expect(f.withinTolerance).toBe(false);
    expect(f.explanation).toContain("credit note");
  });

  it("treats nothing received as never within tolerance", () => {
    const r = matchThreeWay([line({ receivedQty: "0.000" })], DEFAULT_TOLERANCE, NOW);
    const f = r.findings.find((x) => x.discrepancy === "not_received")!;
    expect(f.withinTolerance).toBe(false);
  });

  it("reports an under-billed line without blocking it", () => {
    const r = matchThreeWay(
      [line({ invoicedQty: "90.000" })],
      DEFAULT_TOLERANCE,
      NOW,
    );
    const f = r.findings.find((x) => x.discrepancy === "under_invoiced")!;
    // ⭐ A vendor under-charging is not a reason to refuse to pay them.
    expect(f.withinTolerance).toBe(true);
    expect(f.valueImpactMinor).toBeLessThan(0n);
  });
});

describe("tolerance produces a note, because 0063 demands one", () => {
  it("explains what the tolerance let through", () => {
    // ₹1 on a ₹5,000 unit is 0.02%, inside 2% and inside the ₹500 cap.
    const r = matchThreeWay(
      [line({ invoicedUnitPriceMinor: 5_001_00n })],
      DEFAULT_TOLERANCE,
      NOW,
    );
    expect(r.state).toBe("matched_within_tolerance");
    expect(r.note).not.toBeNull();
    expect(r.note).toContain("Passed on tolerance");
  });

  it("the database refuses that state without a note", () => {
    const sql = read("SQL-FILES/0063_purchase_orders_payments.sql");
    expect(sql).toContain("purchase_invoices_tolerance_is_explained");
  });
});

describe("the match is line by line and never total to total", () => {
  /**
   * 🔴🔴 THE FAILURE THIS PREVENTS. Two lines wrong in opposite
   * directions net to a correct total: the bill passes, one item was
   * over-charged and another under-delivered, and the invoice reconciles
   * perfectly to the order.
   */
  it("catches two offsetting errors that net to zero", () => {
    const r = matchThreeWay(
      [
        line({ lineKey: "a", description: "cement", invoicedUnitPriceMinor: 6_000_00n }),
        line({ lineKey: "b", description: "sand", invoicedUnitPriceMinor: 4_000_00n }),
      ],
      DEFAULT_TOLERANCE,
      NOW,
    );
    // The two price errors cancel exactly.
    expect(r.netImpactMinor).toBe(0n);
    // And the match still refuses.
    expect(r.state).toBe("unmatched");
    expect(r.findings.length).toBeGreaterThanOrEqual(2);
  });
});

describe("the sentences name a document to go and look at", () => {
  it("says so for a line on no order", () => {
    const r = matchThreeWay(
      [
        line(),
        line({
          lineKey: "z",
          description: "site tea",
          orderedQty: null,
          orderedUnitPriceMinor: null,
        }),
      ],
      DEFAULT_TOLERANCE,
      NOW,
    );
    const f = r.findings.find((x) => x.discrepancy === "no_order_line")!;
    expect(f.explanation).toContain("on no purchase order");
  });

  it("spells out the direction of money rather than using a minus", () => {
    expect(describeMinor(-5_000n)).toContain("in your favour");
    expect(describeMinor(5_000n)).toBe("₹50.00");
  });
});

describe("both new engines are reachable from a browser", () => {
  const mustBeReached: ReadonlyArray<readonly [string, string]> = [
    ["raisePurchaseOrder", "app/(crm)/purchases/orders/page.tsx"],
    ["approvePurchaseOrder", "app/(crm)/purchases/orders/page.tsx"],
    ["runAutomationQueue", "app/(crm)/automations/queue/page.tsx"],
  ];

  for (const [action, screen] of mustBeReached) {
    it(`${action} is called from a screen`, () => {
      expect(existsSync(join(root, screen))).toBe(true);
      expect(read(screen)).toContain(action);
    });
  }
});
