/**
 * Ordence — ⭐⭐⭐ THE THREE BATCHES I HAD MARKED FINISHED
 * Version: v1.21.0-alpha
 */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ASSUMED_LEAD_DAYS,
  findDeadStock,
  fromThousandths,
  suggestReorders,
  toThousandths,
  type ItemPosition,
} from "@/lib/inventory/reorder";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");
const TODAY = new Date("2026-08-14T00:00:00Z");

function item(over: Partial<ItemPosition> = {}): ItemPosition {
  return {
    stockItemId: "i1",
    sku: "TMT-12",
    name: "TMT bar 12mm",
    uom: "nos",
    reorderLevel: "50.000",
    reorderQuantity: "200.000",
    leadTimeDays: 10,
    onHand: "100.000",
    onOrder: "0.000",
    usedInWindow: "0.000",
    windowDays: 90,
    unitCostMinor: 50_000n,
    preferredVendorName: "Ramesh Traders",
    lastMovedOn: "2026-08-10",
    firstStockedOn: "2025-01-01",
    ...over,
  };
}

/* ================= BATCH 12: REORDER ================= */

describe("the reorder list counts what is already coming", () => {
  /**
   * 🔴 THE FAILURE A NAIVE REPORT PRODUCES. Stock 40, level 50, and 200
   * arriving Thursday. Ordering 200 more leaves 440 of something that
   * sells 20 a month.
   */
  it("does not reorder something already on order", () => {
    const out = suggestReorders(
      [item({ onHand: "40.000", onOrder: "200.000", usedInWindow: "0.000" })],
      TODAY,
    );
    expect(out).toHaveLength(0);
  });

  it("still reorders when the incoming order is not enough", () => {
    const out = suggestReorders(
      [item({ onHand: "10.000", onOrder: "5.000" })],
      TODAY,
    );
    expect(out).toHaveLength(1);
  });
});

describe("the reorder list looks at the shelf on the day goods arrive", () => {
  /**
   * ⚠️ THE CASE EVERY SIMPLE REPORT MISSES. Above the level today, below
   * it by the time anything could land.
   */
  it("flags an item that is healthy today and short by arrival", () => {
    // 900 used over 90 days = 10/day. 10 day lead = 100 used.
    const out = suggestReorders(
      [item({ onHand: "120.000", usedInWindow: "900.000", leadTimeDays: 10 })],
      TODAY,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.urgency).toBe("order_soon");
    expect(out[0]!.why).toContain("already too late");
  });

  it("assumes a lead time rather than zero when none is recorded", () => {
    expect(ASSUMED_LEAD_DAYS).toBeGreaterThan(0);
    const out = suggestReorders(
      [item({ onHand: "60.000", usedInWindow: "900.000", leadTimeDays: null })],
      TODAY,
    );
    expect(out[0]!.leadTimeDays).toBe(ASSUMED_LEAD_DAYS);
  });
});

describe("an item nobody reorders is not on the list", () => {
  it("skips a null reorder level rather than treating it as zero", () => {
    expect(suggestReorders([item({ reorderLevel: null })], TODAY)).toHaveLength(0);
  });
});

describe("dead stock is ranked by money, not by age", () => {
  it("puts the expensive item above the older cheap one", () => {
    const out = findDeadStock(
      [
        item({ stockItemId: "cheap", lastMovedOn: "2024-01-01", onHand: "10.000", unitCostMinor: 100n }),
        item({ stockItemId: "dear", lastMovedOn: "2026-01-01", onHand: "10.000", unitCostMinor: 900_000n }),
      ],
      TODAY,
    );
    expect(out[0]!.stockItemId).toBe("dear");
  });

  it("flags an item that has never moved separately", () => {
    const out = findDeadStock(
      [item({ lastMovedOn: null, firstStockedOn: "2025-01-01" })],
      TODAY,
    );
    expect(out[0]!.neverMoved).toBe(true);
    expect(out[0]!.note).toContain("never moved");
  });

  it("does not call an empty shelf dead stock", () => {
    expect(findDeadStock([item({ onHand: "0.000" })], TODAY)).toHaveLength(0);
  });

  it("does not drift on three decimal places", () => {
    expect(fromThousandths(toThousandths("0.100") + toThousandths("0.200"))).toBe("0.300");
  });
});

/* ================= BATCH 14: THE PERIOD LOCK ================= */

describe("a closed period refuses postings", () => {
  /**
   * 🔴 `isDateLocked` HAS EXISTED SINCE 0005 AND NOTHING CALLED IT.
   */
  it("the posting path now checks before writing", () => {
    const src = read("server/accounting/post-sales.ts");
    expect(src).toContain("closedPeriodFor");
    expect(src).toContain('reason: "period_closed"');
  });

  it("the database enforces it independently of the code", () => {
    const sql = read("SQL-FILES/0073_period_lock_and_reorder.sql");
    expect(sql).toContain("ordence_guard_closed_period");
    expect(sql).toContain("BEFORE INSERT OR UPDATE OF transaction_date ON transactions");
  });

  /**
   * ⚠️ THE DOCUMENT DATE, NEVER THE INSERT TIME. Checking `created_at`
   * would let a March-dated entry be posted in June and called compliant.
   */
  it("checks the document date rather than when it was typed", () => {
    const sql = read("SQL-FILES/0073_period_lock_and_reorder.sql");
    expect(sql).toContain("NEW.transaction_date BETWEEN start_date AND end_date");
    expect(sql).not.toContain("NEW.created_at BETWEEN");
  });

  /**
   * ⭐ `closing` MUST STILL ACCEPT POSTINGS, or a month can never be
   * closed at all and the rule gets switched off rather than fixed.
   */
  it("locks only closed and locked, never closing", () => {
    const sql = read("SQL-FILES/0073_period_lock_and_reorder.sql");
    expect(sql).toContain("status IN ('closed', 'locked')");
    expect(sql).not.toContain("'closing'");
  });

  it("names the period rather than returning a bare refusal", () => {
    const src = read("server/accounting/post-sales.ts");
    expect(src).toContain("period: lockedIn");
  });
});

/* ================= BATCH 3: CRM SETUP ================= */

describe("lead sources and pipeline stages are finally reachable", () => {
  for (const [action, screen] of [
    ["createLeadSource", "app/(crm)/settings/crm/page.tsx"],
    ["createPipelineStage", "app/(crm)/settings/crm/page.tsx"],
    ["getInventoryReports", "app/(crm)/inventory/planning/page.tsx"],
  ] as const) {
    it(`${action} is called from a screen`, () => {
      expect(existsSync(join(root, screen))).toBe(true);
      expect(read(screen)).toContain(action);
    });
  }

  /**
   * 🔴 WON AND LOST MUST BE DISTINGUISHABLE. A single "closed" stage
   * makes the conversion rate uncomputable, and every CRM that gets this
   * wrong reports a 100% close rate.
   */
  it("a closing stage must say which way it closed", () => {
    const src = read("server/actions/crm-setup.ts");
    expect(src).toContain('isWon: data.outcome === "won"');
    expect(src).toContain('isLost: data.outcome === "lost"');
  });

  it("a lost stage demands a reason by default", () => {
    const src = read("server/actions/crm-setup.ts");
    expect(src).toContain('data.outcome === "lost"');
    expect(src).toContain("requiresReason");
  });

  it("counts the leads that have no source, and says why", () => {
    const src = read("server/actions/crm-setup.ts");
    expect(src).toContain("leadsWithNoSource");
    const screen = read("components/crm-setup/crm-setup-panel.tsx");
    expect(screen).toContain("nowhere to record one");
  });
});
