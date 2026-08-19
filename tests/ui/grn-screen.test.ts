/**
 * Ordence — ⭐⭐ BATCH 38, SECOND HALF: THE RECEIPT NOBODY COULD RECORD
 * Version: v1.43.0-alpha (Mega-wave 1)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 `recordGoodsReceipt` AND `runThreeWayMatch` HAD ZERO UI CALLERS
 * ══════════════════════════════════════════════════════════════════════
 * The first half of this batch fixed the receipt so that it finally
 * writes `stock_movements`. That fix landed in an action nothing in the
 * product called: the only way stock ever went up was an INSERT at a
 * psql prompt.
 *
 * ⚠️ AND `purchase_invoices.match_state` HAS BEEN READ BY THE PAYMENT RUN
 * SINCE v1.11.0 WITH NOTHING ABLE TO SET IT. Every bill in the payment
 * screen showed a blank match state, which reads as "not checked yet" and
 * meant "not checkable".
 *
 * ⭐ THE THREE THINGS THE FORM ASKS FOR BEFORE SAVING — a warehouse, a
 * rejection reason, and two separate quantities — are each a refusal the
 * server would otherwise have delivered after the typing was done.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const PAGE_PATH = "app/(crm)/purchases/orders/[id]/page.tsx";
const FORM_PATH = "components/purchases/receipt-form.tsx";
const OPTIONS_PATH = "server/actions/purchases-form.ts";

const PAGE = read(PAGE_PATH);
const FORM = read(FORM_PATH);
const OPTIONS = read(OPTIONS_PATH);
const ACTION = read("server/actions/purchase-orders.ts");

/**
 * ⚠️ ABSENCE IS ASSERTED AGAINST COMMENT-STRIPPED SOURCE, ALWAYS.
 *
 * 🔴 A test that greps the whole file for something that must NOT be
 * there fails on the comment explaining why it is not there. That has
 * cost this repository five separate afternoons.
 */
const codeOnly = (s: string) =>
  s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));

/* ================================================================== */
/* ① THE SCREEN EXISTS AND REACHES BOTH ORPHANS                        */
/* ================================================================== */

describe("the purchase order detail screen", () => {
  it("exists", () => {
    expect(existsSync(join(ROOT, PAGE_PATH))).toBe(true);
    expect(existsSync(join(ROOT, FORM_PATH))).toBe(true);
  });

  /** ⭐ Both actions that had no caller at all, plus the read behind them. */
  it("reaches recordGoodsReceipt and runThreeWayMatch", () => {
    const code = codeOnly(PAGE);
    for (const fn of [
      "getPurchaseOrder",
      "recordGoodsReceipt",
      "runThreeWayMatch",
      "listWarehouseOptions",
      "ReceiptForm",
      "BillMatch",
    ]) {
      expect(code, fn).toContain(fn);
    }
  });

  /**
   * ⚠️ A REFUSAL IS NOT A 404. "You may not receive goods" and "there is
   * no such order" are different answers, and collapsing them sends an
   * operator with the wrong role hunting for a record that is right
   * there.
   */
  it("distinguishes a permission refusal from a missing order", () => {
    const code = codeOnly(PAGE);
    expect(code).toContain("if (!result.ok)");
    expect(code).toContain("notFound()");
    expect(PAGE).toContain("A REFUSAL IS NOT A 404");
  });

  /**
   * 🔴 THE MATCH BUTTON IS OFFERED ONLY TO SOMEBODY WHO MAY RUN IT. The
   * receipt is guarded on `inventory.movements.post` and the match on
   * `settings:update`; showing both to the storekeeper would invite the
   * person who took delivery to pass the bill for it, which is the exact
   * arrangement a three-way match exists to prevent.
   */
  it("hides the match from whoever cannot run it, and says why", () => {
    const code = codeOnly(PAGE);
    expect(code).toContain("canMatch");
    expect(PAGE).toContain("THE BUTTON IS NOT THE CONTROL");
  });

  /**
   * ⚠️ A NULL `match_state` IS A SENTENCE, NOT AN EMPTY CELL. The payment
   * run's blank cell read as "not checked yet" and meant "not checkable".
   */
  it("renders an unchecked bill as unchecked rather than as blank", () => {
    const code = codeOnly(PAGE);
    expect(code).toContain("b.matchState === null");
    expect(PAGE).toContain("never checked");
  });

  /**
   * 🔴 TODAY IN INDIA, NOT TODAY IN UTC. IST is UTC+05:30, so between
   * midnight and 05:30 in a godown the UTC date is still yesterday's, and
   * a receipt defaulted to yesterday dates the MSME acceptance clock a
   * day early.
   */
  it("defaults the receipt date in the tenant's timezone", () => {
    const code = codeOnly(PAGE);
    expect(code).toContain('timeZone: "Asia/Kolkata"');
    expect(code).not.toContain("toISOString().slice(0, 10)");
  });

  /** ⚠️ Display only. The arithmetic never leaves bigint. */
  it("formats money without floats", () => {
    const code = codeOnly(PAGE);
    expect(code).not.toContain("parseFloat");
    expect(code).not.toMatch(/Number\(\w+\.\w*[Mm]inor\)/);
    expect(code).toContain("padStart");
  });
});

/* ================================================================== */
/* ② THE WAREHOUSE, ASKED FOR BEFORE THE SERVER REFUSES                */
/* ================================================================== */

describe("the warehouse requirement", () => {
  /**
   * 🔴 `recordGoodsReceipt` REFUSES A RECEIPT CONTAINING STOCK ITEMS WITH
   * NO WAREHOUSE, deliberately: defaulting to "the first warehouse" puts
   * a hundred bags of cement in whichever godown sorted first. The form
   * asks, and explains, rather than letting somebody find out after
   * typing twelve lines.
   */
  it("is asked for in the form, with the reason attached", () => {
    const code = codeOnly(FORM);
    expect(code).toContain("warehouseId");
    expect(code).toContain("movesStock");
    expect(FORM).toContain("stock has to arrive somewhere");
    expect(FORM).toContain("wrong godown");
  });

  /**
   * ⭐ ONLY THE ACCEPTED QUANTITY MAKES A LINE A STOCK MOVEMENT. Rejected
   * goods await return to the vendor and are never posted, so a receipt
   * of nothing but rejections needs no warehouse — demanding one would be
   * a rule the server does not have.
   */
  it("requires it only for accepted stock-item lines", () => {
    const code = codeOnly(FORM);
    expect(code).toContain("l.stockItemId !== null && a.positive");
  });

  /**
   * ⚠️ NULL, NOT "". `warehouseId` is `uuid().optional().nullable()`, and
   * an empty string is neither: a receipt of pure services would be
   * refused with a message about uuid format.
   */
  it("sends null rather than an empty string when there is no warehouse", () => {
    expect(codeOnly(FORM)).toContain("warehouseId: warehouseId || null");
  });

  /**
   * ⚠️ NO WAREHOUSES IS EXPLAINED, NOT RENDERED AS AN EMPTY DROPDOWN. An
   * empty select with no explanation sends somebody to a support channel.
   */
  it("explains an empty warehouse list instead of showing an empty select", () => {
    expect(codeOnly(FORM)).toContain("warehouses.length === 0");
    expect(FORM).toContain("No warehouse has been set up");
  });
});

/* ================================================================== */
/* ③ REJECTED IS SEPARATE FROM ACCEPTED, AND CARRIES A REASON          */
/* ================================================================== */

describe("rejection", () => {
  /**
   * 🔴 FORTY BAGS ARRIVE, SIX ARE TORN, THIRTY-FOUR ARE ACCEPTED. One box
   * would force a lie: "forty" pays for six torn bags, "thirty-four"
   * loses the fact that six came and went back.
   */
  it("collects two quantities per line and never adds them together", () => {
    const code = codeOnly(FORM);
    expect(code).toContain("acceptedQty:");
    expect(code).toContain("rejectedQty:");
    // ⚠️ Nothing anywhere sums the two.
    expect(code).not.toMatch(/accepted\s*\+\s*rejected/i);
    expect(code).not.toMatch(/rejected\s*\+\s*accepted/i);
  });

  /**
   * 🔴 THE REASON IS ASKED FOR BEFORE THE ACTION, NOT AFTER A REFUSAL.
   * The server returns a sentence about it and 0063 carries the rule as a
   * CHECK. Firing the save and surfacing the message teaches an operator
   * to type one word and press it again.
   */
  it("asks for the reason up front, in the form", () => {
    const code = codeOnly(FORM);
    expect(code).toContain("state.anythingRejected");
    expect(code).toContain("rejectionReason");
    expect(FORM).toContain("BEFORE THE ACTION, NOT AFTER A");
    expect(FORM).toContain("cannot be argued with the vendor later");
  });

  /** ⭐ And the reason only travels when something was actually rejected. */
  it("sends no reason on a clean receipt", () => {
    expect(codeOnly(FORM)).toContain(
      "rejectionReason: state.anythingRejected ? rejectionReason.trim() : null",
    );
  });
});

/* ================================================================== */
/* ④ QUANTITIES ARE THOUSANDTHS, AND NEVER A FLOAT                     */
/* ================================================================== */

describe("quantity handling", () => {
  /**
   * 🔴 `Number(thousandths) / 1000` IS THE OBVIOUS VERSION AND IT IS
   * WRONG TWICE: it loses precision above 2^53, and it renders 12.340 as
   * "12.34", which reads back as a different string from the one stored.
   */
  it("converts thousandths with BigInt and never with a float", () => {
    const code = codeOnly(FORM);
    expect(code).toContain("BigInt(");
    expect(code).not.toContain("parseFloat");
    expect(code).not.toContain("Number(");
  });

  /**
   * ⚠️ THE SERVER'S GRAMMAR IS MIRRORED SO A BAD QUANTITY NEVER ROUND
   * TRIPS. `receiveSchema` accepts `^\d+(\.\d{1,3})?$`; without the
   * mirror, "40 bags" comes back as a zod message quoting a regular
   * expression.
   */
  it("mirrors the server's quantity grammar", () => {
    const code = codeOnly(FORM);
    expect(code).toContain("^\\d+(\\.\\d{1,3})?$");
    expect(FORM).toContain("A MIRROR IS NOT A SECOND SOURCE OF TRUTH");
  });

  /**
   * ⚠️ OVER-DELIVERY IS FLAGGED AND NOT BLOCKED. 101 of 100 happens
   * constantly, `recomputeOrderStatus` uses `>=` for exactly that reason,
   * and the extra unit is a finding for the three-way match. Refusing it
   * would make the storekeeper record a lie about what came off the
   * lorry.
   */
  it("warns about over-delivery without refusing it", () => {
    const code = codeOnly(FORM);
    expect(code).toContain("toThousandths(accepted.value) > outstanding");
    expect(FORM).toContain("OVER-DELIVERY IS FLAGGED AND NOT BLOCKED");
    // The warning is a message, not a guard that stops the submit.
    expect(code).not.toMatch(/if\s*\(\s*over\s*\)\s*\{?\s*return/);
  });

  /**
   * ⭐ ONLY THE LINES WITH SOMETHING ON THEM ARE SENT. A row of zeroes per
   * untouched line makes the receipt look like a full delivery to every
   * report that counts rows rather than quantities.
   */
  it("sends only the lines that were touched", () => {
    expect(codeOnly(FORM)).toContain(".filter((l) => {");
    expect(FORM).toContain("ONLY THE LINES WITH SOMETHING ON THEM");
  });

  /**
   * ⭐ THE ACCEPTED BOX IS NOT PRE-FILLED WITH THE OUTSTANDING QUANTITY.
   * ⚠️ It would save typing and turn the receipt into a confirmation of
   * the paperwork instead of a record of the count.
   */
  it("does not pre-fill what was counted", () => {
    expect(FORM).toContain("NOT PRE-FILLED WITH THE OUTSTANDING QUANTITY");
    expect(codeOnly(FORM)).toContain('placeholder="0"');
  });
});

/* ================================================================== */
/* ⑤ A DRAFT ORDER IS NOT OFFERED THE FORM                             */
/* ================================================================== */

describe("an unapproved order", () => {
  /**
   * ⚠️ THE SERVER REFUSES A RECEIPT AGAINST A DRAFT: "booking goods in
   * against an unapproved order records a commitment nobody made".
   * Rendering the form anyway makes somebody type out a delivery note in
   * order to be told that.
   */
  it("shows the reason instead of the form", () => {
    const code = codeOnly(FORM);
    expect(code).toContain('poStatus === "draft"');
    expect(FORM).toContain("records a commitment nobody made");
  });

  /**
   * 🔴 AND THE EARLY RETURN SITS BELOW THE HOOKS. An early return above
   * the `useState` calls changes hook order between renders and React
   * tears the component down.
   */
  it("returns early only after the hooks have run", () => {
    // ⚠️ Sliced at `BillMatch`, because that component has hooks of its
    // own further down the file and a whole-file `lastIndexOf` would
    // measure the wrong component's ordering and pass for the wrong
    // reason.
    const code = codeOnly(FORM);
    const receiptOnly = code.slice(0, code.indexOf("export function BillMatch"));
    const hook = receiptOnly.lastIndexOf("useState");
    const early = receiptOnly.indexOf('poStatus === "draft"');
    expect(hook).toBeGreaterThan(-1);
    expect(early).toBeGreaterThan(hook);
  });
});

/* ================================================================== */
/* ⑥ THE READ ACTION AND THE OPTIONS HELPER ARE BOTH GUARDED           */
/* ================================================================== */

describe("server actions", () => {
  /**
   * ⚠️ EVERY `"use server"` EXPORT IS A BROWSER-REACHABLE URL. The new
   * read is no exception, and its id is interpolated into SQL casts.
   */
  it("getPurchaseOrder is guarded and validates its id", () => {
    const code = codeOnly(ACTION);
    expect(code).toContain("export async function getPurchaseOrder");
    expect(code).toContain("z.string().uuid().parse(poId)");
    expect(code).toContain("await requirePermission(RECEIVE)");
    expect(ACTION).toContain("GUARDED ON `RECEIVE`, NOT ON `ORDER`");
  });

  /**
   * 🔴 `checkPermission` WOULD LOG A DENIAL EVERY TIME IT SAID NO. The
   * storekeeper who legitimately cannot approve bills would write a row
   * to `permission_denials` on every page view, and that table is read as
   * a security signal — a cluster of denials is how somebody probing for
   * access is spotted. The pure evaluator answers the UI question without
   * poisoning it.
   */
  it("decides the match button with the pure evaluator, not the logging one", () => {
    const code = codeOnly(ACTION);
    expect(code).toContain("evaluatePermission(");
    expect(code).not.toContain("checkPermission(APPROVE)");
    expect(ACTION).toContain("WRITES A ROW TO `permission_denials`");
  });

  /**
   * ⭐ RECEIVED IS SUMMED FROM THE RECEIPT LINES, never stored on the
   * order line. A running column is a second copy of a number the
   * receipts already prove, and the two drift the first time a receipt is
   * corrected.
   */
  it("sums received quantity from the receipts rather than a stored column", () => {
    const code = codeOnly(ACTION);
    expect(code).toContain("COALESCE(SUM(grl.accepted_qty), 0)::text");
    expect(code).toContain("COALESCE(SUM(grl.rejected_qty), 0)::text");
  });

  /**
   * ⚠️ A MISSING ORDER IS `ok` WITH A NULL ORDER, so the page can tell a
   * refusal from a 404. Returning an error for both makes them the same
   * answer.
   */
  it("returns a null order rather than an error when there is no such order", () => {
    expect(codeOnly(ACTION)).toContain("order: null");
  });

  /**
   * ⚠️ SEPARATE FROM THE WRITE PATH ON PURPOSE, exactly as
   * `orders-form.ts` is separate from `orders.ts`. The guard audit of
   * `purchase-orders.ts` is the whole control — three permissions,
   * deliberately not one — and a dropdown helper in the middle of it
   * makes that audit harder to read.
   */
  it("the warehouse helper is a separate module, and says why", () => {
    expect(OPTIONS).toContain("SEPARATE FROM `purchase-orders.ts` ON PURPOSE");
    expect(codeOnly(OPTIONS)).toContain("requirePermission(");
  });

  /**
   * 🔴 GUARDED ON THE PERMISSION THAT POSTS THE MOVEMENT, not the one
   * that reads stock. The list exists only to be fed back into
   * `recordGoodsReceipt`, which requires `inventory.movements.post`;
   * offering the choice to somebody who will be refused the save is how a
   * form teaches an operator that the product is unreliable.
   */
  it("guards the warehouse list on the permission the receipt needs", () => {
    const code = codeOnly(OPTIONS);
    expect(code).toContain('requirePermission("inventory.movements.post")');
    expect(code).not.toContain('requirePermission("inventory.stock.read")');
  });

  /**
   * ⚠️ SOFT-DELETED AND INACTIVE GODOWNS ARE EXCLUDED IN SQL, not
   * filtered in the browser. A deleted godown that reaches the form is a
   * godown somebody can still book a lorry into, and the movement would
   * be valid and permanently invisible.
   */
  it("excludes retired warehouses in the query", () => {
    const code = codeOnly(OPTIONS);
    expect(code).toContain("isNull(warehouses.deletedAt)");
    expect(code).toContain("eq(warehouses.isActive, true)");
  });
});

/* ================================================================== */
/* ⑦ THE FIX FROM THE FIRST HALF IS STILL THERE                        */
/* ================================================================== */

describe("recordGoodsReceipt itself", () => {
  /**
   * ⭐ THE SCREEN EXISTS TO REACH THIS. If the movement insert were ever
   * removed, the form would go on saving receipts and inventory would go
   * on being understated by exactly what had been received.
   */
  it("still writes the stock movement this screen exists to trigger", () => {
    const code = codeOnly(ACTION);
    expect(code).toContain("insert(stockMovements)");
    expect(code).toContain('reason: "purchase_receipt"');
    expect(code).toContain("if (!data.warehouseId)");
  });
});
