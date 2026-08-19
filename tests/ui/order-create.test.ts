/**
 * Ordence — ⭐⭐ BATCH 34, SECOND HALF: THE PRODUCT CAN TAKE AN ORDER
 * Version: v1.42.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 `createOrder` HAD NO CALLER
 * ══════════════════════════════════════════════════════════════════════
 * The orders list, the detail page, fulfilment, invoicing and every
 * sales report read a table the product could not write to. The only way
 * an order existed was an INSERT at a psql prompt.
 *
 * ⭐ AND THE FORM DELIBERATELY DOES TWO LESS OBVIOUS THINGS: it computes
 * no money, and it sends no place of supply.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const FORM = read("components/orders/new-order-form.tsx");
const PAGE = read("app/(crm)/orders/new/page.tsx");
const LIST = read("app/(crm)/orders/page.tsx");
const OPTIONS = read("server/actions/orders-form.ts");

const codeOnly = (s: string) =>
  s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));

/* ================================================================== */
/* ① IT EXISTS AND IS REACHABLE                                        */
/* ================================================================== */

describe("the order create path", () => {
  it("exists", () => {
    expect(existsSync(join(ROOT, "app/(crm)/orders/new/page.tsx"))).toBe(true);
  });

  it("calls createOrder", () => {
    expect(codeOnly(PAGE)).toContain("createOrder");
    expect(codeOnly(PAGE)).toContain("NewOrderForm");
  });

  /** ⭐ And the list links to it, so it is reachable without typing a URL. */
  it("is linked from the orders list", () => {
    expect(codeOnly(LIST)).toContain('href="/orders/new"');
    expect(LIST).toContain("New order");
  });

  /**
   * ⚠️ A MISSING REGISTRATION IS EXPLAINED, NOT RENDERED AS AN EMPTY
   * DROPDOWN. `createOrder` refuses without one because it cannot
   * determine a place of supply from nothing, and an empty select with
   * no explanation sends somebody to a support channel.
   */
  it("explains a missing registration or customer instead of showing an empty form", () => {
    const code = codeOnly(PAGE);
    expect(code).toContain("registrationOptions.length === 0");
    expect(code).toContain("partyOptions.length === 0");
    expect(PAGE).toContain("no active GST registration");
  });
});

/* ================================================================== */
/* ② THE TWO THINGS IT DELIBERATELY DOES NOT DO                        */
/* ================================================================== */

describe("what the form refuses to do", () => {
  /**
   * 🔴 IT SENDS NO PLACE OF SUPPLY. After Batch 33 the server determines
   * it and REFUSES if what it was sent disagrees. A form that guessed
   * would turn that refusal into a routine obstacle, and the first fix
   * anybody reached for would be to stop sending it.
   */
  it("never sends a place of supply", () => {
    const code = codeOnly(FORM);
    expect(code).not.toContain("placeOfSupplyCode");
    expect(FORM).toContain("IT DOES NOT SEND A PLACE OF SUPPLY");
    // But it does send the facts the determination is made from.
    expect(code).toContain("sellerRegistrationId");
    expect(code).toContain("gstPartyId");
    expect(code).toContain("supplyType");
  });

  /**
   * ⚠️ NO RUNNING TOTAL. It would be a second implementation of
   * `priceLine`, in floating point, in a browser, and the two would
   * disagree by a paisa on the first multi-rate order. The number the
   * customer sees must be the number that was posted.
   */
  it("computes no money", () => {
    const code = codeOnly(FORM);
    expect(code).not.toMatch(/total\s*[+*]?=/i);
    expect(code).not.toContain("taxRateBps *");
    expect(FORM).toContain("NO RUNNING TOTAL, DELIBERATELY");
  });
});

/* ================================================================== */
/* ③ RUPEES TO PAISE WITHOUT A FLOAT                                   */
/* ================================================================== */

describe("money conversion", () => {
  /**
   * 🔴 `Math.round(Number("1.005") * 100)` IS THE OBVIOUS VERSION AND IT
   * IS WRONG: `1.005 * 100` is `100.49999999999999`, so a price ending in
   * half a paisa rounds DOWN and the invoice is a paisa short of the
   * quotation.
   */
  it("splits the string rather than multiplying a float", () => {
    const code = codeOnly(FORM);
    expect(code).toContain("BigInt(whole) * 100n");
    expect(code).not.toContain("Math.round(Number");
    expect(code).not.toMatch(/parseFloat\([^)]*\)\s*\*\s*100/);
  });

  /** The failure the string split avoids, demonstrated. */
  it("the float version would have been wrong", () => {
    expect(Math.round(1.005 * 100)).toBe(100); // 1.005 → 100 paise, a paisa lost
    // The string split cannot lose a digit it never converted.
    const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec("1.005".slice(0, 4));
    expect(m).not.toBeNull();
  });

  /** ⚠️ An unparseable price is refused before the round trip. */
  it("refuses a price it cannot parse rather than sending zero", () => {
    const code = codeOnly(FORM);
    expect(code).toContain('rupeesToPaise(l.unitPrice) === ""');
    expect(FORM).toContain("is not a price");
  });

  /** Percent to basis points, same discipline. */
  it("converts percent to basis points without a float", () => {
    const code = codeOnly(FORM);
    expect(code).toContain("whole * 100 + Number(frac)");
  });
});

/* ================================================================== */
/* ④ THE SITE, AND WHY ITS ABSENCE IS SHOWN                            */
/* ================================================================== */

describe("immovable property", () => {
  /**
   * 🔴 s.12(3): THE SITE DECIDES. Choosing "works contract or property"
   * makes the project required and warns that the tax follows the site
   * rather than the buyer.
   */
  it("requires a site when the supply is immovable property", () => {
    const code = codeOnly(FORM);
    expect(code).toContain('supplyType === "immovable_property"');
    expect(FORM).toContain("The tax follows where the site is");
  });

  /**
   * ⭐ AND A PROJECT WITH NO GST STATE CODE IS SHOWN AS SUCH. Batch 33
   * makes the engine refuse without one, by design. Surfacing which
   * projects can answer the question turns that refusal from a surprise
   * at save time into something visible while choosing.
   */
  it("marks projects that cannot answer s.12(3) yet", () => {
    expect(codeOnly(OPTIONS)).toContain("p.stateCode ? `GST state");
    expect(OPTIONS).toContain("THE STATE CODE IS THE HINT, AND ITS ABSENCE IS THE POINT");
    expect(FORM).toContain("no GST state set");
  });

  /**
   * ⚠️ THE DELIVERY STATE IS A CODE, NOT A NAME. s.10(1)(a) needs "29",
   * not "Karnataka". Prose fails the check quietly and falls back to our
   * own state, making every consignment intra-state.
   */
  it("asks for a two-digit delivery code for goods", () => {
    const code = codeOnly(FORM);
    expect(code).toContain("deliveryStateCode");
    expect(code).toContain('pattern="[0-9]{2}"');
  });
});

/* ================================================================== */
/* ⑤ THE OPTIONS HELPER IS SEPARATE FROM THE WRITE PATH                */
/* ================================================================== */

describe("orders-form.ts", () => {
  /**
   * ⚠️ EVERY EXPORT OF `orders.ts` IS A BROWSER-REACHABLE ENDPOINT. A
   * read helper for a dropdown does not belong beside `cancelOrder`, and
   * mixing them makes the guard audit of that file harder to read.
   */
  it("is a separate module, and says why", () => {
    expect(OPTIONS).toContain("SEPARATE FROM `orders.ts` ON PURPOSE");
    expect(codeOnly(OPTIONS)).toContain("requirePermission(");
  });
});
