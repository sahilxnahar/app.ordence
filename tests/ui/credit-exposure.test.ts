/**
 * Credit exposure and approval limits.
 *
 * The tests that matter here are the NULL ones. Everything else is
 * arithmetic; NULL-vs-zero is the bug that stops a customer trading.
 */
import { describe, expect, it } from "vitest";
import {
  assessCredit,
  companyExposure,
  mayApprove,
  orderExposure,
  EXPOSURE_EXCLUDED_STATUSES,
} from "@/lib/credit/exposure";

const order = (
  status: string,
  totalMinor: bigint,
  receivedValueMinor = 0n,
  id = status,
) => ({ id, orderNo: `SO-${id}`, status, totalMinor, receivedValueMinor });

describe("orderExposure", () => {
  it("is the unpaid remainder", () => {
    expect(orderExposure(order("confirmed", 100_000n, 30_000n))).toBe(70_000n);
  });

  it("floors at zero so an overpaid order lends nobody headroom", () => {
    expect(orderExposure(order("confirmed", 100_000n, 150_000n))).toBe(0n);
  });

  it("counts a closed-but-unpaid order — the oldest money on the account", () => {
    expect(orderExposure(order("closed", 100_000n, 0n))).toBe(100_000n);
  });

  it("counts on_hold: the goods are still promised", () => {
    expect(orderExposure(order("on_hold", 100_000n, 0n))).toBe(100_000n);
  });

  it.each(EXPOSURE_EXCLUDED_STATUSES)("ignores %s", (status) => {
    expect(orderExposure(order(status, 100_000n, 0n))).toBe(0n);
  });
});

describe("companyExposure", () => {
  it("sums live orders and reports what it skipped", () => {
    const result = companyExposure([
      order("confirmed", 100_000n, 0n, "a"),
      order("partially_fulfilled", 50_000n, 20_000n, "b"),
      order("draft", 900_000n, 0n, "c"),
      order("cancelled", 900_000n, 0n, "d"),
      order("confirmed", 40_000n, 40_000n, "e"),
    ]);
    expect(result.exposureMinor).toBe(130_000n);
    expect(result.contributingOrders).toBe(2);
    expect(result.excludedOrders).toBe(2);
  });

  it("an overpayment on one order does not subsidise another", () => {
    const result = companyExposure([
      order("confirmed", 100_000n, 500_000n, "over"),
      order("confirmed", 100_000n, 0n, "unpaid"),
    ]);
    expect(result.exposureMinor).toBe(100_000n);
  });
});

describe("assessCredit — NULL is not zero", () => {
  it("no profile row at all blocks nothing", () => {
    const d = assessCredit({ profile: null, orders: [], newOrderTotalMinor: 99_00_00_000n });
    expect(d.outcome).toBe("allow");
    expect(d.reasonCode).toBe("no_limit_set");
    expect(d.limitMinor).toBeNull();
    expect(d.headroomMinor).toBeNull();
  });

  it("a NULL limit blocks nothing", () => {
    const d = assessCredit({
      profile: { creditLimitMinor: null, onHold: false, holdReason: null },
      orders: [order("confirmed", 99_00_00_000n)],
      newOrderTotalMinor: 99_00_00_000n,
    });
    expect(d.outcome).toBe("allow");
    expect(d.reasonCode).toBe("no_limit_set");
  });

  it("a ZERO limit blocks everything, including a zero-value order", () => {
    const d = assessCredit({
      profile: { creditLimitMinor: 0n, onHold: false, holdReason: null },
      orders: [],
      newOrderTotalMinor: 0n,
    });
    expect(d.outcome).toBe("approval_required");
    expect(d.reasonCode).toBe("limit_is_zero");
  });
});

describe("assessCredit — the ceiling", () => {
  const profile = { creditLimitMinor: 500_000n, onHold: false, holdReason: null };

  it("allows an order that lands exactly on the limit", () => {
    const d = assessCredit({
      profile,
      orders: [order("confirmed", 300_000n)],
      newOrderTotalMinor: 200_000n,
    });
    expect(d.outcome).toBe("allow");
    expect(d.headroomMinor).toBe(0n);
  });

  it("routes to approval one paisa over", () => {
    const d = assessCredit({
      profile,
      orders: [order("confirmed", 300_000n)],
      newOrderTotalMinor: 200_001n,
    });
    expect(d.outcome).toBe("approval_required");
    expect(d.reasonCode).toBe("limit_exceeded");
    expect(d.headroomMinor).toBe(-1n);
  });

  it("states both figures, so the next question is already answered", () => {
    const d = assessCredit({ profile, orders: [], newOrderTotalMinor: 600_000n });
    expect(d.message).toContain("₹6,000.00");
    expect(d.message).toContain("₹5,000.00");
    expect(d.message).toContain("₹1,000.00");
    expect(d.message).not.toMatch(/denied|refused|rejected/i);
  });
});

describe("assessCredit — hold outranks the arithmetic", () => {
  it("a held account well inside its limit still needs approval", () => {
    const d = assessCredit({
      profile: { creditLimitMinor: 10_000_000n, onHold: true, holdReason: "cheque bounced" },
      orders: [],
      newOrderTotalMinor: 1_000n,
    });
    expect(d.outcome).toBe("approval_required");
    expect(d.reasonCode).toBe("account_on_hold");
    expect(d.message).toContain("cheque bounced");
  });

  it("a held account with a NULL limit still needs approval", () => {
    const d = assessCredit({
      profile: { creditLimitMinor: null, onHold: true, holdReason: null },
      orders: [],
      newOrderTotalMinor: 1_000n,
    });
    expect(d.outcome).toBe("approval_required");
    expect(d.reasonCode).toBe("account_on_hold");
  });
});

describe("mayApprove", () => {
  it("no row = no authority. Absence does not grant a signature.", () => {
    const r = mayApprove({ limit: null, valueMinor: 1n });
    expect(r.allowed).toBe(false);
  });

  it("NULL maxValue = unlimited for that scope", () => {
    const r = mayApprove({ limit: { maxValueMinor: null }, valueMinor: 99_00_00_000n });
    expect(r.allowed).toBe(true);
  });

  it("zero maxValue means may approve nothing, not unlimited", () => {
    expect(mayApprove({ limit: { maxValueMinor: 0n }, valueMinor: 1n }).allowed).toBe(false);
    expect(mayApprove({ limit: { maxValueMinor: 0n }, valueMinor: 0n }).allowed).toBe(true);
  });

  it("allows exactly at the ceiling", () => {
    expect(mayApprove({ limit: { maxValueMinor: 100n }, valueMinor: 100n }).allowed).toBe(true);
    expect(mayApprove({ limit: { maxValueMinor: 100n }, valueMinor: 101n }).allowed).toBe(false);
  });
});

describe("rupee formatting uses Indian grouping", () => {
  it("lakhs and crores group 2,2,3", () => {
    const d = assessCredit({
      profile: { creditLimitMinor: 1_000_000_00n, onHold: false, holdReason: null },
      orders: [],
      newOrderTotalMinor: 0n,
    });
    expect(d.message).toContain("₹10,00,000.00");
  });
});
