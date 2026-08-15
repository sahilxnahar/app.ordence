/**
 * Ordence — ⭐⭐ BATCH 38: THE GOODS RECEIPT THAT MOVED NO GOODS
 * Version: v1.43.0-alpha (Mega-wave 1)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 A GRN WROTE ITS OWN ROW AND LEFT THE STOCK LEDGER UNTOUCHED
 * ══════════════════════════════════════════════════════════════════════
 * `recordGoodsReceipt` wrote a `goods_receipts` row, wrote its lines,
 * recomputed the purchase order's status, emitted an automation event,
 * and never inserted a `stock_movements` row.
 *
 * ⚠️ SO INVENTORY COULD ONLY EVER GO DOWN. `sales_dispatch` writes
 * movements. `purchase_receipt` did not. A warehouse that received a
 * hundred and sold ten showed MINUS TEN, and no screen anywhere would
 * have said why.
 *
 * ⭐ AND THE CONSEQUENCE COMPOUNDS. Batch 86 makes `valuationMethod`
 * actually read the movement ledger. Had that shipped first, it would
 * have valued a ledger with no receipts in it.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fromThousandths, toThousandths } from "@/lib/purchases/three-way";

const ROOT = join(__dirname, "..", "..");
const ACTION = readFileSync(
  join(ROOT, "server/actions/purchase-orders.ts"),
  "utf8",
);

const codeOnly = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));

/* ================================================================== */
/* ① THE MOVEMENT IS WRITTEN                                           */
/* ================================================================== */

describe("recordGoodsReceipt", () => {
  it("writes stock movements", () => {
    const code = codeOnly(ACTION);
    expect(code).toContain("insert(stockMovements)");
    expect(code).toContain('reason: "purchase_receipt"');
  });

  /** The movement points back at the receipt that caused it. */
  it("references the goods receipt that caused it", () => {
    const code = codeOnly(ACTION);
    expect(code).toContain('referenceType: "goods_receipt"');
    expect(code).toContain("referenceId: grn.id");
  });

  /**
   * 🔴 ACCEPTED ONLY, NEVER ACCEPTED PLUS REJECTED.
   *
   * Rejected goods are physically on the premises and are NOT ours: they
   * await return to the vendor, they were never bought, and no credit is
   * owed on them. Counting them would inflate both the stock figure and
   * the inventory asset on the balance sheet.
   */
  it("moves accepted quantity only", () => {
    const code = codeOnly(ACTION);
    expect(code).toContain("const accepted = toThousandths(l.acceptedQty)");
    // The movement mapper must not reach for rejectedQty.
    const from = code.indexOf("const movements = data.lines");
    const to = code.indexOf("insert(stockMovements)");
    expect(from).toBeGreaterThan(-1);
    expect(code.slice(from, to)).not.toContain("rejectedQty");
    expect(ACTION).toContain("ACCEPTED QUANTITY ONLY");
  });

  /**
   * ⚠️ A LINE WITH NO `stockItemId` IS SKIPPED, NOT DEFAULTED. A purchase
   * order line for a service, freight, or a one-off with no catalogue
   * item has nothing to move. Inventing a stock item would put a phantom
   * row in the ledger nobody could ever count.
   */
  it("skips lines with no stock item rather than inventing one", () => {
    const code = codeOnly(ACTION);
    expect(code).toContain("m.stockItemId !== null && m.accepted > 0n");
    expect(ACTION).toContain("SKIPPED, NOT DEFAULTED");
  });

  /**
   * 🔴 A RECEIPT OF ITEMS WITH NO WAREHOUSE IS REFUSED, NOT GUESSED.
   * `warehouse_id` is nullable because a receipt of pure services has no
   * warehouse. Defaulting to "the first one" would put a hundred bags of
   * cement in whichever godown happened to sort first.
   */
  it("refuses to guess a warehouse", () => {
    const code = codeOnly(ACTION);
    expect(code).toContain("if (!data.warehouseId)");
    expect(ACTION).toContain("picking one for you would");
    // And only when there is actually stock to place.
    const guardAt = code.indexOf("if (!data.warehouseId)");
    const branchAt = code.indexOf("if (movements.length > 0)");
    expect(branchAt).toBeGreaterThan(-1);
    expect(branchAt).toBeLessThan(guardAt);
  });

  /**
   * ⭐ THE MOVEMENT CARRIES THE COST, and that needed a column adding to
   * the SELECT. Without it every receipt would be costless: quantity
   * right, value zero, inventory asset understated to nothing.
   */
  it("selects the unit price so the movement has a cost", () => {
    const code = codeOnly(ACTION);
    expect(code).toContain("unitPriceMinor: purchaseOrderLines.unitPriceMinor");
    expect(code).toContain("unitCostMinor:");
    expect(ACTION).toContain("a movement with no cost is invisible to every");
  });
});

/* ================================================================== */
/* ② THE QUANTITY CONVERSION IS EXACT                                  */
/* ================================================================== */

describe("quantity round trip", () => {
  /**
   * ⚠️ QUANTITIES ARE INTEGER THOUSANDTHS, because 12.5 tonnes of cement
   * is a real quantity and a float would round it. The movement stores a
   * decimal string, so the conversion has to be exact in both directions.
   */
  it("survives a round trip without losing a thousandth", () => {
    for (const q of ["1", "0.001", "12.500", "999999.999", "100"]) {
      expect(fromThousandths(toThousandths(q))).toBe(
        Number(q).toFixed(3),
      );
    }
  });

  /** And the float version of the same thing does not. */
  it("shows why thousandths are integers", () => {
    // 0.1 + 0.2 is the canonical example, and a delivery challan that
    // does not add up is a dispute with a customer.
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(fromThousandths(toThousandths("0.1") + toThousandths("0.2"))).toBe(
      "0.300",
    );
  });
});
