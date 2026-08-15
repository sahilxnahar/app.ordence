/**
 * Credit control, holds, overrides and dunning — Batch 40.
 *
 * ══════════════════════════════════════════════════════════════════════
 * TWO KINDS OF TEST, AND THE SECOND KIND IS THE REASON THIS FILE EXISTS
 * ══════════════════════════════════════════════════════════════════════
 * The arithmetic tests below are ordinary. The WIRING tests read the
 * source, and they guard a class of mistake that compiles, passes every
 * other test, and is wrong in production: a hold that is checked on the
 * screen and not at the write, a gate that fails open, a sweep that
 * sends where it was supposed to queue.
 *
 * ⚠️ COMMENTS AND STRINGS ARE STRIPPED BEFORE MATCHING, ALWAYS.
 *
 * Every one of these files explains the mistake it prevents, quoting the
 * broken shape verbatim — `lib/credit/enforce.ts` says "there is no
 * `try { ... } catch { return allowed }` in this file", and
 * `credit-control-board.tsx` says a screen-only check is not a boundary.
 * A test that grepped raw source could not tell those explanations from
 * a relapse, and the only way to make it pass would be to delete the
 * reason the rule exists. A test that pressures you into removing an
 * explanation is a bad test.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  EXPOSURE_SCOPE_NOTE,
  INVOICE_EXCLUDED_STATUSES,
  ORDER_EXCLUDED_STATUSES,
  creditExposure,
  creditHeadroom,
  invoiceOutstanding,
  reconcileCreditPosition,
  unbilledCommitment,
  type InvoiceExposureFact,
} from "@/lib/credit/headroom";
import { EXPOSURE_EXCLUDED_STATUSES } from "@/lib/credit/exposure";
import {
  AUTO_HOLDS_NEVER_SELF_RELEASE,
  assessAutoHold,
  formatPaise,
  holdBlocksConfirmation,
} from "@/lib/credit/hold";
import {
  addDays,
  daysBetween,
  describeSweep,
  dunningKey,
  planDunning,
  type DunningStageFact,
} from "@/lib/credit/dunning";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/** SQL's own comment stripper. Same argument as `codeOnly` below. */
const sqlCode = (src: string): string => src.replace(/--[^\n]*/g, " ");

/**
 * ⚠️ THE COMMENT AND STRING STRIPPER. Block comments, line comments,
 * template literals and quoted strings all go, so an assertion about
 * what the code DOES cannot be satisfied or defeated by prose.
 */
const codeOnly = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/`(?:\\.|[^`\\])*`/g, '""')
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, '""');

const ORDERS = read("server/actions/orders.ts");
const ENFORCE = read("lib/credit/enforce.ts");
const HOLD = read("lib/credit/hold.ts");
const DUNNING = read("lib/credit/dunning.ts");
const CREDIT_ACTIONS = read("server/actions/credit.ts");
const SQL_0083 = read("SQL-FILES/0083_credit_control_and_dunning.sql");
const VERIFY_0083 = read("SQL-FILES/VERIFY-0083-neon-safe.sql");
const DRILL_0083 = read("SQL-FILES/DRILL-DO-NOT-RUN-IN-NEON-0083.sql");
const BOARD = read("components/credit/credit-control-board.tsx");

/* ================================================================== */
/* 🔴 THE HOLD REFUSES THE WRITE                                       */
/* ================================================================== */

describe("🔴 the hold is enforced at the write, not on the screen", () => {
  const confirmBody = codeOnly(
    ORDERS.slice(
      ORDERS.indexOf("export async function confirmOrder"),
      ORDERS.indexOf("export async function approveOrderCredit"),
    ),
  );

  it("finds the confirmOrder body at all", () => {
    expect(confirmBody.length).toBeGreaterThan(500);
  });

  it("confirmOrder calls the credit gate", () => {
    expect(confirmBody).toMatch(/creditGateForConfirmation\s*\(/);
  });

  it("the gate is given the caller's transaction, not a fresh connection", () => {
    /**
     * Reading a hold on one connection and confirming on another is a
     * race with goods in it: a hold placed in the same second is either
     * seen or not depending on connection timing.
     */
    const call = confirmBody.slice(confirmBody.indexOf("creditGateForConfirmation"));
    expect(call.slice(0, 200)).toMatch(/\btx\b/);
  });

  it("confirmOrder catches CreditHoldRefusal by name", () => {
    /**
     * `toSalesActionError` turns a plain Error into "Something went
     * wrong. Please try again.", which reads as an outage. The refusal
     * has to carry its own sentence to the counter.
     */
    expect(confirmBody).toMatch(/instanceof\s+CreditHoldRefusal/);
  });

  it("the gate throws rather than returning a boolean the caller may forget", () => {
    expect(codeOnly(ENFORCE)).toMatch(/throw new CreditHoldRefusal/);
  });

  it("🔴 the gate does not fail open — no catch turns a read error into 'allowed'", () => {
    const code = codeOnly(ENFORCE);
    expect(code).not.toMatch(/catch/);
  });

  it("the board component performs no credit decision of its own", () => {
    /**
     * ⚠️ THE SCREEN MAY NOT DECIDE. If this component could conclude
     * "not held" on its own, the product would have two answers to one
     * question and the browser would hold one of them.
     */
    const code = codeOnly(BOARD);
    expect(code).not.toMatch(/holdBlocksConfirmation/);
    expect(code).not.toMatch(/assessAutoHold/);
  });
});

describe("holdBlocksConfirmation", () => {
  const hold = {
    id: "h1",
    source: "manual" as const,
    reason: "Cheque returned unpaid.",
    placedAt: new Date("2026-08-12T00:00:00Z"),
  };

  it("lets everything through when there is no hold", () => {
    const out = holdBlocksConfirmation({
      orderId: "o1",
      orderNo: "SO-1",
      activeHold: null,
      override: null,
    });
    expect(out.blocked).toBe(false);
    expect(out.consumeOverrideId).toBeNull();
  });

  it("🔴 blocks a held customer with no override", () => {
    const out = holdBlocksConfirmation({
      orderId: "o1",
      orderNo: "SO-1",
      activeHold: hold,
      override: null,
    });
    expect(out.blocked).toBe(true);
    expect(out.message).toContain("Cheque returned unpaid.");
  });

  it("🔴 refuses an override raised against a different order", () => {
    const out = holdBlocksConfirmation({
      orderId: "o1",
      orderNo: "SO-1",
      activeHold: hold,
      override: {
        id: "ov1",
        orderId: "o2",
        actorUserId: "u1",
        reason: "Released against the RTGS.",
        consumedAt: null,
      },
    });
    expect(out.blocked).toBe(true);
    expect(out.consumeOverrideId).toBeNull();
  });

  it("🔴 refuses an override that has already been used", () => {
    const out = holdBlocksConfirmation({
      orderId: "o1",
      orderNo: "SO-1",
      activeHold: hold,
      override: {
        id: "ov1",
        orderId: "o1",
        actorUserId: "u1",
        reason: "Released against the RTGS.",
        consumedAt: new Date("2026-08-12T00:00:00Z"),
      },
    });
    expect(out.blocked).toBe(true);
  });

  it("lets an unused override for THIS order through, and consumes it", () => {
    const out = holdBlocksConfirmation({
      orderId: "o1",
      orderNo: "SO-1",
      activeHold: hold,
      override: {
        id: "ov1",
        orderId: "o1",
        actorUserId: "u1",
        reason: "Released against the RTGS.",
        consumedAt: null,
      },
    });
    expect(out.blocked).toBe(false);
    expect(out.consumeOverrideId).toBe("ov1");
  });

  it("⚠️ still says the account is on hold when it lets one through", () => {
    const out = holdBlocksConfirmation({
      orderId: "o1",
      orderNo: "SO-1",
      activeHold: hold,
      override: {
        id: "ov1",
        orderId: "o1",
        actorUserId: "u1",
        reason: "Released against the RTGS.",
        consumedAt: null,
      },
    });
    expect(out.message).toContain("on hold");
  });
});

/* ================================================================== */
/* THE AUTOMATIC HOLD                                                  */
/* ================================================================== */

describe("assessAutoHold", () => {
  const base = { autoHoldEnabled: true, activeHold: null };

  it("⚠️ NULL is not zero — an unset limit places nothing", () => {
    const out = assessAutoHold({ ...base, limitMinor: null, exposureMinor: 10_000_000n });
    expect(out.shouldPlace).toBe(false);
  });

  it("⚠️ a zero limit places nothing either — it already routes to approval", () => {
    const out = assessAutoHold({ ...base, limitMinor: 0n, exposureMinor: 10_000_000n });
    expect(out.shouldPlace).toBe(false);
  });

  it("places a hold when exposure passes the limit", () => {
    const out = assessAutoHold({ ...base, limitMinor: 500_000n, exposureMinor: 840_000n });
    expect(out.shouldPlace).toBe(true);
    expect(out.reason).toContain("over");
  });

  it("exactly at the limit is not over it", () => {
    const out = assessAutoHold({ ...base, limitMinor: 500_000n, exposureMinor: 500_000n });
    expect(out.shouldPlace).toBe(false);
  });

  it("🔴 is idempotent: an existing hold is never re-placed", () => {
    const out = assessAutoHold({
      autoHoldEnabled: true,
      activeHold: {
        id: "h1",
        source: "automatic",
        reason: "Over limit.",
        placedAt: new Date("2026-08-01T00:00:00Z"),
      },
      limitMinor: 500_000n,
      exposureMinor: 900_000n,
    });
    expect(out.shouldPlace).toBe(false);
  });

  it("with automatic holds off it says who WOULD be held and writes nothing", () => {
    const out = assessAutoHold({
      autoHoldEnabled: false,
      activeHold: null,
      limitMinor: 500_000n,
      exposureMinor: 840_000n,
    });
    expect(out.shouldPlace).toBe(false);
    expect(out.note).toContain("Would be held");
  });

  it("⭐ an automatic hold never lifts itself, and the rule is stated in code", () => {
    expect(AUTO_HOLDS_NEVER_SELF_RELEASE).toBe(true);
    const code = codeOnly(HOLD);
    /* Nothing in the hold engine may ever return a release decision. */
    expect(code).not.toMatch(/shouldRelease/);
  });
});

/* ================================================================== */
/* EXPOSURE — WHAT COUNTS                                              */
/* ================================================================== */

const invoice = (
  over: Partial<InvoiceExposureFact> & Pick<InvoiceExposureFact, "id">,
): InvoiceExposureFact => ({
  invoiceNumber: `AH/${over.id}`,
  status: "issued",
  orderId: null,
  dueDate: "2026-05-01",
  totalMinor: 0n,
  receivedMinor: 0n,
  allocatedMinor: 0n,
  ...over,
});

describe("exposure", () => {
  it("counts the unpaid part of an issued invoice", () => {
    expect(
      invoiceOutstanding(invoice({ id: "1", totalMinor: 100_000n, receivedMinor: 30_000n })),
    ).toBe(70_000n);
  });

  it("⚠️ ignores a draft — the customer has never seen it", () => {
    expect(
      invoiceOutstanding(
        invoice({ id: "1", status: "draft", totalMinor: 100_000n, receivedMinor: 0n }),
      ),
    ).toBe(0n);
  });

  it("floors at zero so an overpaid invoice lends nobody headroom", () => {
    expect(
      invoiceOutstanding(invoice({ id: "1", totalMinor: 100_000n, receivedMinor: 150_000n })),
    ).toBe(0n);
  });

  it("🔴 does not double count: an invoiced order contributes once", () => {
    const out = creditExposure({
      orders: [{ id: "o1", orderNo: "SO-1", status: "confirmed", totalMinor: 500_000n }],
      invoices: [
        invoice({
          id: "i1",
          orderId: "o1",
          totalMinor: 500_000n,
          receivedMinor: 0n,
          allocatedMinor: 0n,
        }),
      ],
    });
    expect(out.billedMinor).toBe(500_000n);
    expect(out.unbilledMinor).toBe(0n);
    expect(out.totalMinor).toBe(500_000n);
  });

  it("🔴 sees a service invoice with no order behind it", () => {
    /**
     * The gap `lib/credit/exposure.ts` could not see: a customer whose
     * whole trade is service-invoiced had an exposure of ₹0 and
     * unlimited headroom, forever.
     */
    const out = creditExposure({
      orders: [],
      invoices: [invoice({ id: "i1", orderId: null, totalMinor: 400_000n })],
    });
    expect(out.totalMinor).toBe(400_000n);
  });

  it("counts the part-invoiced remainder of an order exactly once", () => {
    const out = creditExposure({
      orders: [{ id: "o1", orderNo: "SO-1", status: "confirmed", totalMinor: 500_000n }],
      invoices: [invoice({ id: "i1", orderId: "o1", totalMinor: 200_000n })],
    });
    expect(out.billedMinor).toBe(200_000n);
    expect(out.unbilledMinor).toBe(300_000n);
    expect(out.totalMinor).toBe(500_000n);
  });

  it("⚠️ a paid-off invoice stops inflating the unbilled half", () => {
    const out = creditExposure({
      orders: [{ id: "o1", orderNo: "SO-1", status: "confirmed", totalMinor: 500_000n }],
      invoices: [
        invoice({ id: "i1", orderId: "o1", totalMinor: 500_000n, receivedMinor: 500_000n }),
      ],
    });
    expect(out.totalMinor).toBe(0n);
  });

  it.each([...ORDER_EXCLUDED_STATUSES])("ignores a %s order", (status) => {
    expect(
      unbilledCommitment({ id: "o1", orderNo: "SO-1", status, totalMinor: 500_000n }, 0n),
    ).toBe(0n);
  });

  it("🔴 the order exclusion list matches lib/credit/exposure.ts exactly", () => {
    /**
     * Two hand-written copies of the list of statuses that count is the
     * drift a credit ceiling cannot survive: one screen counts `on_hold`
     * orders and the other does not, and a customer's exposure depends
     * on which page you opened.
     */
    expect([...ORDER_EXCLUDED_STATUSES].sort()).toEqual(
      [...EXPOSURE_EXCLUDED_STATUSES].sort(),
    );
  });

  it("⚠️ the exposure scope note names what is NOT counted", () => {
    expect(EXPOSURE_SCOPE_NOTE).toMatch(/demand/i);
    expect(EXPOSURE_SCOPE_NOTE).toMatch(/booking/i);
  });

  it("the invoice exclusion list keeps `paid` in, so a stale status cannot hide a shortfall", () => {
    expect(INVOICE_EXCLUDED_STATUSES).not.toContain("paid");
    expect(
      invoiceOutstanding(
        invoice({ id: "1", status: "paid", totalMinor: 100_000n, receivedMinor: 40_000n }),
      ),
    ).toBe(60_000n);
  });
});

/* ================================================================== */
/* 🔴 THE RECONCILIATION GATE                                          */
/* ================================================================== */

describe("🔴 two readings of what has been received, and no figure when they disagree", () => {
  const agreeing = [
    invoice({ id: "i1", totalMinor: 400_000n, receivedMinor: 150_000n, allocatedMinor: 150_000n }),
  ];

  it("reconciles when the column and the allocations agree", () => {
    const exposure = creditExposure({ invoices: agreeing, orders: [] });
    const r = reconcileCreditPosition({
      companyLabel: "Shree Traders",
      invoices: agreeing,
      exposure,
    });
    expect(r.state).toBe("reconciled");
    expect(r.renderable).toBe(true);
    expect(r.verified).toBe(true);
  });

  it("🔴 breaches when a bounced receipt leaves the column overstated", () => {
    const drifted = [
      invoice({ id: "i1", totalMinor: 400_000n, receivedMinor: 150_000n, allocatedMinor: 0n }),
    ];
    const exposure = creditExposure({ invoices: drifted, orders: [] });
    const r = reconcileCreditPosition({
      companyLabel: "Shree Traders",
      invoices: drifted,
      exposure,
    });
    expect(r.state).toBe("breached");
    expect(r.renderable).toBe(false);
    expect(r.breaches.length).toBeGreaterThan(0);
  });

  it("🔴 a breach removes the headroom figure structurally, not visually", () => {
    const drifted = [
      invoice({ id: "i1", totalMinor: 400_000n, receivedMinor: 150_000n, allocatedMinor: 0n }),
    ];
    const out = creditHeadroom({
      companyLabel: "Shree Traders",
      ceiling: { creditLimitMinor: 1_000_000n },
      invoices: drifted,
      orders: [],
    });
    expect(out.figures).toBeNull();
  });

  it("⚠️ a customer with no invoices is UNCONFIGURED, not verified", () => {
    /**
     * Decided from the COUNT, never from the amount. A gate that
     * inferred "nothing to check" from `0n === 0n` would tick a customer
     * whose invoices happen to net to zero.
     */
    const out = creditHeadroom({
      companyLabel: "New Customer",
      ceiling: { creditLimitMinor: 1_000_000n },
      invoices: [],
      orders: [{ id: "o1", orderNo: "SO-1", status: "confirmed", totalMinor: 500_000n }],
    });
    expect(out.reconciliation.state).toBe("unconfigured");
    expect(out.reconciliation.verified).toBe(false);
    /* ⚠️ AND THE FIGURES ARE STILL SHOWN. Unconfigured is not a breach. */
    expect(out.figures).not.toBeNull();
    expect(out.figures?.headroomMinor).toBe(500_000n);
  });

  it("⚠️ the unbilled half is declared unverified in a note, every time", () => {
    const out = creditHeadroom({
      companyLabel: "Shree Traders",
      ceiling: { creditLimitMinor: 1_000_000n },
      invoices: agreeing,
      orders: [{ id: "o1", orderNo: "SO-1", status: "confirmed", totalMinor: 500_000n }],
    });
    expect(out.reconciliation.notes.join(" ")).toMatch(/not verified/i);
  });

  it("the two sides of the check quote different sources", () => {
    /**
     * A check whose sides share a source proves only that the query is
     * deterministic. `reconcile()` faults it — this asserts we never
     * hand it one.
     */
    const exposure = creditExposure({ invoices: agreeing, orders: [] });
    const r = reconcileCreditPosition({
      companyLabel: "X",
      invoices: agreeing,
      exposure,
    });
    const check = r.checks[0]!;
    expect(check.report.source).not.toBe(check.ledger.source);
  });

  it("headroom is negative, not clamped, when the customer is over", () => {
    const out = creditHeadroom({
      companyLabel: "Shree Traders",
      ceiling: { creditLimitMinor: 100_000n },
      invoices: agreeing,
      orders: [],
    });
    expect(out.figures?.overLimit).toBe(true);
    expect(out.figures?.headroomMinor).toBe(-150_000n);
  });

  it("⚠️ a NULL limit is unlimited, not zero", () => {
    const out = creditHeadroom({
      companyLabel: "Shree Traders",
      ceiling: { creditLimitMinor: null },
      invoices: agreeing,
      orders: [],
    });
    expect(out.figures?.headroomMinor).toBeNull();
    expect(out.figures?.overLimit).toBe(false);
  });
});

/* ================================================================== */
/* DUNNING                                                             */
/* ================================================================== */

const stage = (
  stageNo: number,
  daysPastDue: number,
  over: Partial<DunningStageFact> = {},
): DunningStageFact => ({
  id: `s${stageNo}`,
  stageNo,
  label: `Stage ${stageNo}`,
  daysPastDue,
  channel: "email",
  templateKey: null,
  placesHold: false,
  ...over,
});

const LADDER = [stage(1, 7), stage(2, 30), stage(3, 60, { placesHold: true })];

const overdue = (over: Partial<Parameters<typeof planDunning>[0]["invoices"][number]> = {}) => ({
  id: "i1",
  invoiceNumber: "AH/2026-27/0001",
  companyId: "c1",
  companyName: "Shree Traders",
  dueDate: "2026-05-01",
  outstandingMinor: 250_000n,
  recipientName: "Mr Shah",
  recipientEmail: "accounts@shree.example",
  recipientPhone: "+919000000000",
  ...over,
});

describe("dunning dates", () => {
  it("counts whole days between calendar dates", () => {
    expect(daysBetween("2026-05-01", "2026-05-31")).toBe(30);
  });

  it("is negative before the due date — not yet due is not an error", () => {
    expect(daysBetween("2026-05-01", "2026-04-20")).toBe(-11);
  });

  it("crosses a month end and a financial year end", () => {
    expect(daysBetween("2026-03-31", "2026-04-01")).toBe(1);
    expect(addDays("2026-03-31", 1)).toBe("2026-04-01");
  });
});

describe("planDunning", () => {
  it("fires nothing before the first rung", () => {
    const plan = planDunning({
      asOf: "2026-05-05",
      invoices: [overdue()],
      stages: LADDER,
      alreadyRecorded: new Set(),
    });
    expect(plan.actions).toHaveLength(0);
  });

  it("fires the first rung on the day it falls due", () => {
    const plan = planDunning({
      asOf: "2026-05-08",
      invoices: [overdue()],
      stages: LADDER,
      alreadyRecorded: new Set(),
    });
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]!.stageNo).toBe(1);
    expect(plan.actions[0]!.delivery).toBe("queued");
  });

  it("🔴 fires ONE rung — the highest due — and records the rest as overtaken", () => {
    /**
     * An invoice 95 days past due when the ladder is first configured
     * qualifies for every rung at once. Sending all of them is four
     * escalating letters in one morning about a debt nobody had
     * mentioned before breakfast.
     */
    const plan = planDunning({
      asOf: "2026-08-04",
      invoices: [overdue()],
      stages: LADDER,
      alreadyRecorded: new Set(),
    });
    const queued = plan.actions.filter((a) => a.delivery === "queued");
    expect(queued).toHaveLength(1);
    expect(queued[0]!.stageNo).toBe(3);
    expect(plan.actions.filter((a) => a.delivery === "suppressed")).toHaveLength(2);
  });

  it("⚠️ a suppressed rung never places a hold", () => {
    const plan = planDunning({
      asOf: "2026-08-04",
      invoices: [overdue()],
      stages: LADDER,
      alreadyRecorded: new Set(),
    });
    for (const a of plan.actions.filter((x) => x.delivery === "suppressed")) {
      expect(a.placesHold).toBe(false);
    }
  });

  it("🔴 IDEMPOTENT — a recorded stage is never planned again", () => {
    const first = planDunning({
      asOf: "2026-05-08",
      invoices: [overdue()],
      stages: LADDER,
      alreadyRecorded: new Set(),
    });
    const recorded = new Set(first.actions.map((a) => dunningKey(a.invoiceId, a.stageId)));

    const second = planDunning({
      asOf: "2026-05-08",
      invoices: [overdue()],
      stages: LADDER,
      alreadyRecorded: recorded,
    });
    expect(second.actions).toHaveLength(0);
  });

  it("🔴 re-running after the ladder escalates fires only the new rung", () => {
    const recorded = new Set([dunningKey("i1", "s1")]);
    const plan = planDunning({
      asOf: "2026-06-05",
      invoices: [overdue()],
      stages: LADDER,
      alreadyRecorded: recorded,
    });
    expect(plan.actions.map((a) => a.stageNo)).toEqual([2]);
  });

  it("the next-action date comes from the due date, not from today", () => {
    const plan = planDunning({
      asOf: "2026-05-20",
      invoices: [overdue()],
      stages: LADDER,
      alreadyRecorded: new Set(),
    });
    /* Rung 1 fired; rung 2 is 30 days past a 1 May due date. */
    expect(plan.actions[0]!.nextActionOn).toBe("2026-05-31");
  });

  it("the last rung has no next action — it is a human decision", () => {
    const plan = planDunning({
      asOf: "2026-08-04",
      invoices: [overdue()],
      stages: LADDER,
      alreadyRecorded: new Set(),
    });
    expect(plan.actions.at(-1)!.nextActionOn).toBeNull();
  });

  it("⚠️ an invoice with no due date is skipped with a sentence, not guessed at", () => {
    const plan = planDunning({
      asOf: "2026-08-04",
      invoices: [overdue({ dueDate: null })],
      stages: LADDER,
      alreadyRecorded: new Set(),
    });
    expect(plan.actions).toHaveLength(0);
    expect(plan.skipped[0]!.why).toMatch(/due date/i);
  });

  it("⚠️ an e-mail rung with no address is skipped, never queued to nobody", () => {
    const plan = planDunning({
      asOf: "2026-05-08",
      invoices: [overdue({ recipientEmail: null })],
      stages: LADDER,
      alreadyRecorded: new Set(),
    });
    expect(plan.actions).toHaveLength(0);
    expect(plan.skipped[0]!.why).toMatch(/e-mail/i);
  });

  it("⚠️ no ladder means nobody is chased, and it says so", () => {
    const plan = planDunning({
      asOf: "2026-08-04",
      invoices: [overdue()],
      stages: [],
      alreadyRecorded: new Set(),
    });
    expect(plan.actions).toHaveLength(0);
    expect(plan.skipped[0]!.why).toMatch(/no dunning ladder/i);
  });

  it("a settled invoice is not chased", () => {
    const plan = planDunning({
      asOf: "2026-08-04",
      invoices: [overdue({ outstandingMinor: 0n })],
      stages: LADDER,
      alreadyRecorded: new Set(),
    });
    expect(plan.actions).toHaveLength(0);
  });

  it("🔴 the summary says QUEUED and never SENT", () => {
    const plan = planDunning({
      asOf: "2026-05-08",
      invoices: [overdue()],
      stages: LADDER,
      alreadyRecorded: new Set(),
    });
    const summary = describeSweep(plan);
    expect(summary).toMatch(/queued/i);
    expect(summary).toMatch(/Nothing has been sent/i);
  });
});

describe("🔴 the sweep queues; it does not send", () => {
  it("the dunning engine imports no mail transport", () => {
    const code = codeOnly(DUNNING);
    expect(code).not.toMatch(/resend|nodemailer|sendMail|sendEmail/i);
  });

  it("the sweep action imports no mail transport", () => {
    const code = codeOnly(CREDIT_ACTIONS);
    expect(code).not.toMatch(/resend|nodemailer|sendMail|sendEmail/i);
  });

  it("the sweep never writes a `sent` delivery state", () => {
    const code = codeOnly(CREDIT_ACTIONS);
    expect(code).not.toMatch(/delivery:\s*""sent""/);
    expect(code).not.toMatch(/sentAt:/);
  });

  it("the sweep relies on the unique index rather than a check-then-insert", () => {
    expect(codeOnly(CREDIT_ACTIONS)).toMatch(/onConflictDoNothing\(/);
  });

  it("⚠️ the date comes from Asia/Kolkata, never from toISOString", () => {
    const sweep = codeOnly(
      CREDIT_ACTIONS.slice(CREDIT_ACTIONS.indexOf("export async function runDunningSweep")),
    );
    expect(sweep).toMatch(/todayInIndia\(/);
    expect(sweep).not.toMatch(/toISOString/);
  });
});

/* ================================================================== */
/* MIGRATION 0083                                                      */
/* ================================================================== */

const NEW_TABLES = [
  "credit_hold_events",
  "credit_hold_overrides",
  "credit_dunning_ladders",
  "credit_dunning_stages",
  "credit_dunning_log",
];

describe("SQL 0083", () => {
  it("is one transaction", () => {
    expect(SQL_0083).toMatch(/^BEGIN;/m);
    expect(SQL_0083).toMatch(/^COMMIT;/m);
  });

  it("says whether it runs before or after the code push, and why", () => {
    expect(SQL_0083).toMatch(/BEFORE\*{0,2} PUSHING THE CODE|RUN THIS \*{0,2}BEFORE\*{0,2}/);
  });

  it.each(NEW_TABLES)("creates %s guarded", (t) => {
    expect(SQL_0083).toContain(`CREATE TABLE IF NOT EXISTS ${t}`);
  });

  it.each(NEW_TABLES)("puts %s inside the RLS loop", (t) => {
    const loop = SQL_0083.slice(SQL_0083.indexOf("ROW LEVEL SECURITY"));
    expect(loop).toContain(`'${t}'`);
  });

  it("enables AND forces row level security", () => {
    expect(SQL_0083).toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect(SQL_0083).toMatch(/FORCE\s+ROW LEVEL SECURITY/);
  });

  it("🔴 puts app_platform_scope in USING and never in WITH CHECK", () => {
    expect(SQL_0083).toMatch(/USING \(tenant_id = app_current_tenant_id\(\) OR app_platform_scope\(\)\)/);
    const withCheck = SQL_0083.match(/WITH CHECK \([^)]*\)/g) ?? [];
    for (const clause of withCheck) {
      expect(clause).not.toContain("app_platform_scope");
    }
  });

  it("🔴 carries the three indexes that ARE the product rules", () => {
    expect(SQL_0083).toContain("credit_hold_events_one_active_key");
    expect(SQL_0083).toContain("credit_hold_overrides_one_per_order_key");
    expect(SQL_0083).toContain("credit_dunning_log_once_per_stage_key");
  });

  it("🔴 the one-active-hold index is PARTIAL on released_at", () => {
    const idx = SQL_0083.slice(SQL_0083.indexOf("credit_hold_events_one_active_key"));
    expect(idx.slice(0, 300)).toMatch(/WHERE released_at IS NULL/);
  });

  it("🔴 withholds DELETE on the two evidence tables and the dunning log", () => {
    const grants = SQL_0083.match(/GRANT[^;']*ON credit_\w+/g) ?? [];
    const evidence = grants.filter(
      (g) =>
        g.includes("credit_hold_events") ||
        g.includes("credit_hold_overrides") ||
        g.includes("credit_dunning_log"),
    );
    expect(evidence.length).toBeGreaterThan(0);
    for (const g of evidence) expect(g).not.toContain("DELETE");
  });

  it("requires a reason on both the hold and the override, in the database", () => {
    expect(SQL_0083).toContain("credit_hold_events_reason_said");
    expect(SQL_0083).toContain("credit_hold_overrides_reason_said");
  });

  it("⚠️ the override actor is NOT NULL and RESTRICT, unlike every other actor column", () => {
    const block = SQL_0083.slice(
      SQL_0083.indexOf("CREATE TABLE IF NOT EXISTS credit_hold_overrides"),
      SQL_0083.indexOf("CREATE UNIQUE INDEX IF NOT EXISTS credit_hold_overrides_id_tenant_key"),
    );
    expect(block).toMatch(/actor_user_id\s+uuid NOT NULL REFERENCES users\(id\) ON DELETE RESTRICT/);
  });

  it("is re-runnable — every ALTER TABLE ADD COLUMN is guarded", () => {
    /**
     * ⚠️ SQL COMMENTS ARE STRIPPED FIRST, for the same reason the
     * TypeScript ones are: the header EXPLAINS that columns are added
     * with `ADD COLUMN IF NOT EXISTS`, and a grep over raw text cannot
     * tell the explanation from the statement.
     */
    for (const m of sqlCode(SQL_0083).matchAll(/ADD COLUMN(?! IF NOT EXISTS)/g)) {
      expect(m[0]).toBe("guarded");
    }
  });

  it("adds the profile columns off by default", () => {
    expect(SQL_0083).toMatch(/auto_hold_enabled boolean NOT NULL DEFAULT false/);
  });
});

describe("VERIFY 0083 is read-only", () => {
  const statements = sqlCode(VERIFY_0083);

  /**
   * ⚠️ ANCHORED AT A STATEMENT BOUNDARY, NOT A SUBSTRING SEARCH.
   *
   * A bare `toContain("DROP")` fails on `pg_attribute.attisdropped` and
   * a bare `toContain("GRANT")` fails on
   * `information_schema.role_table_grants` — both of which are exactly
   * what a read-only verifier is supposed to be reading. A test that
   * forces those out is a test that forces the verifier to stop
   * verifying.
   */
  it.each([
    "INSERT",
    "UPDATE",
    "DELETE",
    "CREATE",
    "ALTER",
    "DROP",
    "TRUNCATE",
    "GRANT",
  ])("contains no %s statement", (kw) => {
    const pattern = new RegExp(`(^|;|\\n)\\s*${kw}\\b`, "i");
    expect(statements).not.toMatch(pattern);
  });

  it("checks rls_enabled, rls_forced and the policy count separately", () => {
    expect(VERIFY_0083).toContain("relrowsecurity");
    expect(VERIFY_0083).toContain("relforcerowsecurity");
    expect(VERIFY_0083).toContain("pg_policy");
  });

  it("re-derives the reconciliation from the allocations", () => {
    expect(VERIFY_0083).toContain("customer_receipt_allocations");
    expect(VERIFY_0083).toMatch(/'pending',\s*'cleared'/);
  });
});

describe("🔴 the drill never runs against Neon", () => {
  it("says so in its own filename", () => {
    /* The filename is the first and cheapest guard. */
    expect(() => read("SQL-FILES/DRILL-DO-NOT-RUN-IN-NEON-0083.sql")).not.toThrow();
  });

  it("refuses to run on a database that looks real", () => {
    expect(DRILL_0083).toMatch(/current_database\(\) LIKE '%neon%'/);
    expect(DRILL_0083).toMatch(/RAISE EXCEPTION/);
  });

  it("pairs every refusal with a write that must still work", () => {
    const refusals = (DRILL_0083.match(/✅ REFUSAL/g) ?? []).length;
    const positives = (DRILL_0083.match(/✅ POSITIVE/g) ?? []).length;
    /**
     * ⚠️ A CEILING ON NEITHER — a floor on both. A drill that only shows
     * breaks cannot tell "the constraint works" from "the table rejects
     * everything".
     */
    expect(refusals).toBeGreaterThanOrEqual(10);
    expect(positives).toBeGreaterThanOrEqual(5);
  });

  it("exercises the once-per-stage index and the one-active-hold index", () => {
    expect(DRILL_0083).toContain("credit_dunning_log_once_per_stage_key");
    expect(DRILL_0083).toContain("credit_hold_events_one_active_key");
  });
});

/* ================================================================== */
/* MONEY                                                               */
/* ================================================================== */

describe("money never becomes a float", () => {
  it("formats paise with Indian grouping from the bigint alone", () => {
    expect(formatPaise(840_000_00n)).toBe("₹8,40,000.00");
    expect(formatPaise(-15_000_50n)).toBe("−₹15,000.50");
  });

  it("survives a figure that a double could not hold exactly", () => {
    /**
     * 9,007,199,254,740,993 is `Number.MAX_SAFE_INTEGER + 2`, which a
     * double rounds to ...992. The paise are exact here because nothing
     * on the path ever left `bigint`.
     */
    expect(formatPaise(9_007_199_254_740_993n)).toBe("₹9,00,71,99,25,47,409.93");
  });

  it.each([
    "lib/credit/headroom.ts",
    "lib/credit/hold.ts",
    "lib/credit/dunning.ts",
    "lib/credit/enforce.ts",
    "lib/credit/queries.ts",
  ])("%s never calls Number() on a money value", (file) => {
    const code = codeOnly(read(file));
    expect(code).not.toMatch(/Number\(\s*\w*[Mm]inor/);
    expect(code).not.toMatch(/parseFloat/);
  });
});
