/**
 * Ordence — ⭐⭐ BATCH 34: THE ORDER NOBODY COULD OPEN
 * Version: v1.41.0-alpha (Mega-wave 1)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 ELEVEN OF TWELVE ACTIONS IN `orders.ts` HAD NO CALLER
 * ══════════════════════════════════════════════════════════════════════
 * 1,288 lines implementing confirmation with credit assessment,
 * amendment with revisions, cancellation with a mandatory reason, hold,
 * release, close, fulfilment and delivery. Only `listOrders` was
 * imported anywhere in the tree.
 *
 * ⚠️ AND `getOrder` WAS THE SHARPEST CASE. It returns the order, its
 * lines and its full event history, and the orders list linked every
 * order number to `/orders/${o.id}` — a route that did not exist. Every
 * row on the only working screen in the domain was a 404.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const PAGE_PATH = "app/(crm)/orders/[id]/page.tsx";
const PAGE = read(PAGE_PATH);
const LIFECYCLE = read("components/orders/order-lifecycle.tsx");
const GATE = read("scripts/check-links.mjs");

const codeOnly = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) => m.replace(/[^\n]/g, " "));

/* ================================================================== */
/* ① THE ROUTE EXISTS AND REACHES THE ENGINE                           */
/* ================================================================== */

describe("the order detail page", () => {
  it("exists, so every row of the orders list is no longer a 404", () => {
    expect(existsSync(join(ROOT, PAGE_PATH))).toBe(true);
  });

  /** ⭐ Five lifecycle actions plus the read, all previously orphaned. */
  it("reaches six of the eleven unreachable actions", () => {
    const code = codeOnly(PAGE);
    for (const fn of [
      "getOrder",
      "confirmOrder",
      "cancelOrder",
      "holdOrder",
      "releaseOrder",
      "closeOrder",
    ]) {
      expect(code, fn).toContain(fn);
    }
  });

  /**
   * ⚠️ A REFUSAL IS NOT A 404, and collapsing them costs an afternoon.
   * "You do not have permission to read orders" and "that order does not
   * exist" are different answers; an operator with the wrong role should
   * not go hunting for a record that is right there.
   */
  it("distinguishes a permission refusal from a missing order", () => {
    const code = codeOnly(PAGE);
    expect(code).toContain("if (!result.ok)");
    expect(code).toContain("notFound()");
    expect(PAGE).toContain("A REFUSAL IS NOT A 404");
  });

  /**
   * ⚠️ FULFILLED AND CANCELLED ARE SHOWN SEPARATELY, never merged into a
   * "remaining". Those two states owe the customer opposite things: one
   * owes goods, the other owes a credit note.
   */
  it("shows fulfilled and cancelled quantities separately", () => {
    const code = codeOnly(PAGE);
    expect(code).toContain("l.qtyFulfilled");
    expect(code).toContain("l.qtyCancelled");
    expect(PAGE).toContain("owes goods, the other owes a credit");
  });

  /** ⭐ The tax split, which after Batch 33 has a reason behind it. */
  it("shows the tax split and the place of supply", () => {
    const code = codeOnly(PAGE);
    expect(code).toContain("order.isInterState");
    expect(code).toContain("order.placeOfSupplyCode");
    expect(code).toContain("IGST");
  });

  /**
   * ⭐ THE EVENT HISTORY IS ON THE PAGE. An order that changed and cannot
   * say when is an order somebody has to defend from memory.
   */
  it("renders the event history", () => {
    expect(codeOnly(PAGE)).toContain("events.map(");
    expect(PAGE).toContain("What has happened to this order");
  });

  /** ⚠️ Display only. The arithmetic never leaves bigint. */
  it("formats money without floats", () => {
    const code = codeOnly(PAGE);
    expect(code).not.toContain("parseFloat");
    expect(code).not.toMatch(/Number\((?:l|order)\.\w*[Mm]inor\)/);
    expect(code).toContain("padStart");
  });
});

/* ================================================================== */
/* ② THE BUTTONS MIRROR THE TRIGGERS, THEY DO NOT REPLACE THEM         */
/* ================================================================== */

describe("the lifecycle controls", () => {
  /**
   * ⭐ THE DATABASE REMAINS THE AUTHORITY. Legal transitions are enforced
   * by triggers in 0028, because this is one write path of several. The
   * screen mirrors them only so it does not offer what will be refused.
   *
   * ⚠️ IF THE MIRROR DRIFTS, the screen offers something the database
   * refuses: a confusing afternoon. If the database drifted from the
   * screen, an order would change in a way nobody meant: a dispute. Only
   * one of those is recoverable, so only one is authoritative.
   */
  it("derives available actions from status, and says why that is a mirror", () => {
    expect(codeOnly(LIFECYCLE)).toContain("const ALLOWS");
    expect(LIFECYCLE).toContain("A MIRROR IS NOT A SECOND SOURCE OF TRUTH");
    expect(LIFECYCLE).toContain("enforced by triggers");
  });

  /**
   * 🔴 THE REASON IS ASKED FOR BEFORE THE ACTION, NOT AFTER A REJECTION.
   * `cancelOrderSchema` requires ten characters because the customer
   * will ask why. Firing the action and surfacing a validation error
   * teaches the operator to type "x" ten times.
   */
  it("asks for a cancellation reason up front, matching the schema minimum", () => {
    const code = codeOnly(LIFECYCLE);
    expect(code).toContain('minLength={10}');
    expect(code).toContain("reason:");
    expect(LIFECYCLE).toContain("BEFORE THE ACTION, NOT AFTER A REJECTION");
  });

  it("asks for a hold reason too", () => {
    expect(codeOnly(LIFECYCLE)).toContain("minLength={5}");
  });

  /**
   * ⚠️ A TERMINAL ORDER SAYS SO. An empty row of buttons reads as a page
   * that failed to load.
   */
  it("explains itself when nothing is possible", () => {
    expect(LIFECYCLE).toContain("Nothing further can be done");
  });

  /** Cancel and close are not offered on a status that forbids them. */
  it("does not offer confirm on a cancelled order", () => {
    const m = /confirm:\s*\[([^\]]*)\]/.exec(LIFECYCLE);
    expect(m).not.toBeNull();
    expect(m![1]).not.toContain("cancelled");
    expect(m![1]).toContain("draft");
  });
});

/* ================================================================== */
/* ③ THE DEAD-LINK BUDGET RATCHETED DOWN                               */
/* ================================================================== */

describe("check:links", () => {
  /**
   * ⭐ THE BUDGET IS THE BACKLOG. It went 12 → 11 with `/sales`, and
   * 11 → 10 here. The mechanism gets deleted when it reaches zero.
   */
  it("no longer lists /orders/:id, and the budget fell to 10", () => {
    expect(GATE).not.toContain('["/orders/:id"');
    const m = /const KNOWN_DEAD_MAX = (\d+);/.exec(GATE);
    expect(Number(m![1])).toBe(10);
  });
});
