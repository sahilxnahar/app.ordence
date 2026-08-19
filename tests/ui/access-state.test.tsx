/**
 * Ordence — Access Restriction & Dunning
 * Version: v0.14.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE PROPERTY EVERY TEST HERE DEFENDS
 * ══════════════════════════════════════════════════════════════════════
 * **Never lock out a customer who is trying to pay you.**
 *
 * The failure mode is not a crash. It is a workspace that goes read-only
 * a week too early, on a customer whose card expired while they were
 * busy — turning a renewal that was always going to happen into churn,
 * a refund request, and a review.
 *
 * So the tests below are mostly about what does NOT happen: no
 * restriction on the first failure, none on the third, none while the
 * provider is still retrying, and never a state in which the customer
 * cannot read or export their own records.
 */

import { describe, it, expect } from "vitest";
import {
  evaluateAccess,
  permitsWrites,
  permitsReads,
  permitsExport,
  permitsBilling,
  isExemptWrite,
  ACCESS_LEVELS,
  ACCESS_RANK,
  TRIAL_NOTICE_DAYS,
  TRIAL_GRACE_DAYS,
  ALWAYS_PERMITTED_WRITE_PREFIXES,
  type AccessInput,
} from "@/lib/billing/access-state";

const NOW = new Date("2026-07-31T12:00:00Z");
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

function input(overrides: Partial<AccessInput> = {}): AccessInput {
  return {
    subscriptionStatus: "active",
    planTier: "advanced",
    tenantStatus: "active",
    trialEndsAt: null,
    graceEndsAt: null,
    currentPeriodEnd: days(20),
    failedPaymentCount: 0,
    cancelAtPeriodEnd: false,
    now: NOW,
    ...overrides,
  };
}

/* ================================================================== */
/* 1. THE INVARIANTS                                                   */
/* ================================================================== */

describe("invariants that must hold at EVERY level", () => {
  it("⭐ export is ALWAYS permitted, including when locked", () => {
    // Retaining someone's data while denying them a copy is a
    // data-protection problem, not a collections strategy. Under DPDP the
    // right of access does not lapse because an invoice is outstanding.
    for (const level of ACCESS_LEVELS) {
      expect(permitsExport(level), `export blocked at "${level}"`).toBe(true);
    }
  });

  it("⭐ billing is ALWAYS reachable", () => {
    // A paywall you cannot pay through is just a wall.
    for (const level of ACCESS_LEVELS) {
      expect(permitsBilling(level), `billing blocked at "${level}"`).toBe(true);
    }
  });

  it("reading is permitted everywhere except a hard administrative lock", () => {
    for (const level of ACCESS_LEVELS) {
      expect(permitsReads(level)).toBe(level !== "locked");
    }
  });

  it("no billing state produces a decision that hides the customer's data", () => {
    // Sweep every reachable combination. A workspace can end up in a
    // surprising state through a downgrade, a lost webhook or a clock
    // skew — and none of those may make someone's records disappear.
    const statuses = [
      null, "trialing", "active", "past_due", "unpaid", "paused", "cancelled", "expired",
    ] as const;

    for (const status of statuses) {
      for (const grace of [null, days(-30), days(-1), days(3)]) {
        for (const trial of [null, days(-30), days(-1), days(3)]) {
          const decision = evaluateAccess(
            input({ subscriptionStatus: status, graceEndsAt: grace, trialEndsAt: trial }),
          );
          expect(decision.canRead, `read blocked for ${status}`).toBe(true);
          expect(decision.canExport, `export blocked for ${status}`).toBe(true);
        }
      }
    }
  });

  it("the ladder is strictly ordered", () => {
    for (let i = 1; i < ACCESS_LEVELS.length; i += 1) {
      expect(ACCESS_RANK[ACCESS_LEVELS[i]!]).toBeGreaterThan(
        ACCESS_RANK[ACCESS_LEVELS[i - 1]!],
      );
    }
    expect(permitsWrites("full")).toBe(true);
    expect(permitsWrites("notice")).toBe(true);
    expect(permitsWrites("warning")).toBe(true);
    expect(permitsWrites("restricted")).toBe(false);
    expect(permitsWrites("locked")).toBe(false);
  });
});

/* ================================================================== */
/* 2. DUNNING NEVER RESTRICTS TOO EARLY                                */
/* ================================================================== */

describe("dunning", () => {
  it("⭐ a FIRST failed payment restricts NOTHING", () => {
    // The single most important test in this file. An expired card is
    // the usual cause, and cutting access here is how a recoverable
    // renewal becomes a churn event plus a refund request.
    const decision = evaluateAccess(
      input({
        subscriptionStatus: "past_due",
        failedPaymentCount: 1,
        graceEndsAt: days(7),
      }),
    );
    expect(decision.canWrite).toBe(true);
    expect(decision.level).toBe("notice");
    expect(decision.reason).toBe("payment_failed");
    expect(decision.detail).toMatch(/nothing has changed about your access/i);
  });

  it("⭐ past_due NEVER restricts writes, at any failure count", () => {
    // While the provider is still retrying, cutting access is the worst
    // of both worlds: we lose the customer AND we get paid.
    for (const failures of [1, 2, 3, 4, 10]) {
      for (const grace of [days(7), days(3), days(1), days(0), days(-5)]) {
        const decision = evaluateAccess(
          input({
            subscriptionStatus: "past_due",
            failedPaymentCount: failures,
            graceEndsAt: grace,
          }),
        );
        expect(
          decision.canWrite,
          `past_due restricted writes at ${failures} failures, grace ${grace.toISOString()}`,
        ).toBe(true);
      }
    }
  });

  it("escalates the WORDING as the grace window closes, without restricting", () => {
    const early = evaluateAccess(
      input({ subscriptionStatus: "past_due", graceEndsAt: days(6) }),
    );
    const late = evaluateAccess(
      input({ subscriptionStatus: "past_due", graceEndsAt: days(1) }),
    );

    expect(early.level).toBe("notice");
    expect(late.level).toBe("warning");
    expect(late.reason).toBe("grace_expiring");
    expect(early.canWrite && late.canWrite).toBe(true);
  });

  it("⭐ `unpaid` still honours its grace window", () => {
    // `unpaid` is set after the fourth failure; grace runs seven days
    // from there. So the earliest restriction is ~3 weeks after the first
    // failure, by which time the provider has stopped retrying.
    const decision = evaluateAccess(
      input({ subscriptionStatus: "unpaid", failedPaymentCount: 4, graceEndsAt: days(4) }),
    );
    expect(decision.canWrite).toBe(true);
    expect(decision.level).toBe("warning");
    expect(decision.detail).toMatch(/nothing will be deleted/i);
  });

  it("restricts only once unpaid AND the grace window has closed", () => {
    const decision = evaluateAccess(
      input({ subscriptionStatus: "unpaid", failedPaymentCount: 4, graceEndsAt: days(-1) }),
    );
    expect(decision.level).toBe("restricted");
    expect(decision.canWrite).toBe(false);
    expect(decision.canRead).toBe(true);
    expect(decision.canExport).toBe(true);
    expect(decision.reason).toBe("unpaid_grace_expired");
  });

  it("a restricted message says the data is still there and how to fix it", () => {
    // The reader's first question is "have I lost everything?". Nothing
    // else gets heard until that is answered.
    const decision = evaluateAccess(
      input({ subscriptionStatus: "unpaid", graceEndsAt: days(-1) }),
    );
    expect(decision.detail).toMatch(/still here/i);
    expect(decision.detail).toMatch(/download/i);
    expect(decision.detail).toMatch(/restores full access/i);
    expect(decision.callToAction?.href).toBe("/settings/billing");
  });
});

/* ================================================================== */
/* 3. TRIALS                                                           */
/* ================================================================== */

describe("trials", () => {
  it("is silent until the notice window", () => {
    const decision = evaluateAccess(
      input({ subscriptionStatus: "trialing", trialEndsAt: days(TRIAL_NOTICE_DAYS + 2) }),
    );
    expect(decision.level).toBe("full");
    expect(decision.headline).toBeNull();
  });

  it("gives notice as the trial nears its end", () => {
    const decision = evaluateAccess(
      input({ subscriptionStatus: "trialing", trialEndsAt: days(3) }),
    );
    expect(decision.level).toBe("notice");
    expect(decision.headline).toMatch(/ends in 3 days/);
    expect(decision.detail).toMatch(/nothing is deleted/i);
    expect(decision.canWrite).toBe(true);
  });

  it("⭐ does NOT hard-stop at midnight on the last day", () => {
    // A trial that stops dead catches people mid-evaluation — often the
    // ones who were about to buy.
    const decision = evaluateAccess(
      input({ subscriptionStatus: "trialing", trialEndsAt: days(-1) }),
    );
    expect(decision.canWrite).toBe(true);
    expect(decision.level).toBe("warning");
    expect(decision.reason).toBe("trial_expired");
  });

  it("goes read-only after the grace days", () => {
    const decision = evaluateAccess(
      input({ subscriptionStatus: "trialing", trialEndsAt: days(-(TRIAL_GRACE_DAYS + 1)) }),
    );
    expect(decision.level).toBe("restricted");
    expect(decision.canRead).toBe(true);
    expect(decision.canExport).toBe(true);
  });
});

/* ================================================================== */
/* 4. CANCELLATION                                                     */
/* ================================================================== */

describe("cancellation", () => {
  it("⭐ keeps FULL access through the period already paid for", () => {
    // Cancelling must never forfeit time the customer has bought. Doing
    // so would be taking money for nothing.
    const decision = evaluateAccess(
      input({ subscriptionStatus: "active", cancelAtPeriodEnd: true, currentPeriodEnd: days(12) }),
    );
    expect(decision.canWrite).toBe(true);
    expect(decision.level).toBe("notice");
    expect(decision.headline).toMatch(/ends in 12 days/);
    expect(decision.callToAction?.label).toMatch(/resume/i);
  });

  it("a cancelled subscription still inside its period keeps full access", () => {
    const decision = evaluateAccess(
      input({ subscriptionStatus: "cancelled", currentPeriodEnd: days(5) }),
    );
    expect(decision.canWrite).toBe(true);
  });

  it("goes read-only once the paid period has passed", () => {
    const decision = evaluateAccess(
      input({ subscriptionStatus: "cancelled", currentPeriodEnd: days(-1) }),
    );
    expect(decision.level).toBe("restricted");
    expect(decision.canRead).toBe(true);
  });
});

/* ================================================================== */
/* 5. ADMINISTRATIVE SUSPENSION                                        */
/* ================================================================== */

describe("administrative suspension", () => {
  it("⭐ outranks a perfectly healthy billing state", () => {
    // A workspace suspended for abuse whose card also happens to be
    // valid must stay suspended. If billing were checked first, paying
    // an invoice would silently un-suspend them.
    const decision = evaluateAccess(
      input({ tenantStatus: "suspended", subscriptionStatus: "active" }),
    );
    expect(decision.level).toBe("locked");
    expect(decision.canWrite).toBe(false);
    expect(decision.canRead).toBe(false);
    expect(decision.reason).toBe("tenant_suspended");
  });

  it("still permits export", () => {
    const decision = evaluateAccess(input({ tenantStatus: "suspended" }));
    expect(decision.canExport).toBe(true);
    expect(decision.detail).toMatch(/download a copy/i);
  });

  it("is reached only by suspension, never by dunning", () => {
    // No amount of non-payment produces `locked`.
    for (const status of ["past_due", "unpaid", "cancelled", "expired"] as const) {
      const decision = evaluateAccess(
        input({ subscriptionStatus: status, graceEndsAt: days(-100) }),
      );
      expect(decision.level, `${status} reached "locked" through dunning`).not.toBe("locked");
    }
  });
});

/* ================================================================== */
/* 6. WRITE EXEMPTIONS — THE PAYWALL TRAP                              */
/* ================================================================== */

describe("write exemptions", () => {
  it("⭐ paying is permitted while restricted", () => {
    // Without this the workspace is a trap: the customer wants to pay,
    // the payment form is a write, the write is blocked, and the only
    // route out is a support ticket.
    expect(isExemptWrite("billing:startCheckout")).toBe(true);
    expect(isExemptWrite("billing:changePlan")).toBe(true);
    expect(isExemptWrite("payment:updateMethod")).toBe(true);
  });

  it("exporting and signing out are permitted", () => {
    expect(isExemptWrite("export:contacts")).toBe(true);
    expect(isExemptWrite("session:signOut")).toBe(true);
  });

  it("ordinary product writes are NOT exempt", () => {
    for (const operation of [
      "contacts:create",
      "accounting:postTransaction",
      "contracts:send",
      "users:invite",
      // Adversarial: a namespace that merely CONTAINS an exempt word.
      "contacts:billing_notes_update",
      "notbilling:create",
    ]) {
      expect(isExemptWrite(operation), `"${operation}" was wrongly exempt`).toBe(false);
    }
  });

  it("every exempt prefix ends with a colon", () => {
    // A prefix without the separator would match any namespace starting
    // with those letters — `billing` would exempt `billingsomething`.
    for (const prefix of ALWAYS_PERMITTED_WRITE_PREFIXES) {
      expect(prefix.endsWith(":"), `"${prefix}" has no separator`).toBe(true);
    }
  });
});

/* ================================================================== */
/* 7. MESSAGE HYGIENE                                                  */
/* ================================================================== */

describe("what the customer reads", () => {
  it("every restricting decision offers a way out", () => {
    const restricting: AccessInput[] = [
      input({ subscriptionStatus: "unpaid", graceEndsAt: days(-1) }),
      input({ subscriptionStatus: "trialing", trialEndsAt: days(-10) }),
      input({ subscriptionStatus: "cancelled", currentPeriodEnd: days(-1) }),
      input({ subscriptionStatus: "paused" }),
      input({ tenantStatus: "suspended" }),
    ];

    for (const scenario of restricting) {
      const decision = evaluateAccess(scenario);
      expect(decision.callToAction, `no way out from ${decision.reason}`).not.toBeNull();
      expect(decision.callToAction!.href.length).toBeGreaterThan(1);
    }
  });

  it("never blames the customer or uses collections language", () => {
    // "Delinquent", "overdue account", "failure to pay" all read as
    // debt-collection. The overwhelming majority of these people have an
    // expired card, not an intention.
    const scenarios: AccessInput[] = [
      input({ subscriptionStatus: "past_due", graceEndsAt: days(6) }),
      input({ subscriptionStatus: "unpaid", graceEndsAt: days(-1) }),
      input({ subscriptionStatus: "trialing", trialEndsAt: days(-10) }),
    ];

    for (const scenario of scenarios) {
      const decision = evaluateAccess(scenario);
      const text = `${decision.headline ?? ""} ${decision.detail ?? ""}`;
      expect(text).not.toMatch(/delinquent|overdue|failure to pay|arrears|debt/i);
    }
  });

  it("a healthy workspace is shown nothing at all", () => {
    const decision = evaluateAccess(input());
    expect(decision.headline).toBeNull();
    expect(decision.detail).toBeNull();
    expect(decision.callToAction).toBeNull();
  });
});
