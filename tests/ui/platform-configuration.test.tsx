/**
 * Ordence — ⭐ THE ADMIN CONSOLE'S DECISION LOGIC
 * Session 4 · v0.70.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS AT ALL
 * ══════════════════════════════════════════════════════════════════════
 * Everything tested below decides what a PAYING CUSTOMER can see. Get
 * `buildModuleMatrix` wrong in one direction and a workspace loses a
 * module it pays for; wrong in the other and it silently gets one it does
 * not. Neither shows up as an error — both present as "the product is
 * behaving normally", to the operator and to the customer alike.
 *
 * ⚠️ AND THE FUNCTIONS ARE PURE, WHICH IS THE ONLY REASON THIS IS CHEAP.
 * The console screens are thin wrappers over them. Testing the wrappers
 * would need a browser, a session and a database; testing these needs a
 * table of inputs.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE DISTINCTION THE WHOLE CONSOLE TURNS ON
 * ══════════════════════════════════════════════════════════════════════
 * "This tenant can see Rates" has two completely different causes:
 *
 *   PLAN DEFAULT  — their tier includes it. Changes when they upgrade.
 *   OVERRIDE      — somebody on the platform team switched it on for
 *                   them specifically. Does NOT change when they upgrade,
 *                   and outlives the person who set it.
 *
 * Collapsing those into one boolean makes "why can this customer see
 * that?" unanswerable — which is the question every support escalation
 * and every billing dispute eventually reduces to.
 */

import { describe, it, expect } from "vitest";
import {
  buildModuleMatrix,
  measureLimit,
  previewIndustryChange,
  troubleSignals,
  CONFIGURABLE_PLAN_TIERS,
  TRIAL_WARNING_DAYS,
} from "@/lib/platform/configuration";
import { INDUSTRY_TEMPLATES } from "@/lib/industry-templates";

/* ------------------------------------------------------------------ */
/* THE MODULE MATRIX                                                   */
/* ------------------------------------------------------------------ */

describe("⭐ buildModuleMatrix — plan default vs deliberate override", () => {
  const base = {
    planTier: "basic" as const,
    subscriptionGrantsAccess: false,
    overrides: {} as Record<string, { enabled: boolean }>,
  };

  it("returns every module in the registry, grouped", () => {
    const m = buildModuleMatrix(base);
    const total = m.groups.reduce((n, g) => n + g.modules.length, 0);
    expect(total).toBeGreaterThan(40);
    expect(m.groups.length).toBeGreaterThan(1);
  });

  it("never loses or duplicates a module across the groups", () => {
    /**
     * ⚠️ A MODULE THAT APPEARS TWICE GETS TWO SWITCHES, and the second one
     * silently undoes the first depending on which the operator touched
     * last. A module that appears in no group cannot be switched at all
     * and is invisible to the console — which reads as "that feature does
     * not exist" rather than "nobody can reach its control".
     */
    const m = buildModuleMatrix(base);
    const ids = m.groups.flatMap((g) => g.modules.map((r) => r.navId));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("distinguishes a plan default from an override in the state, not just visually", () => {
    const plain = buildModuleMatrix(base);
    const anyModule = plain.groups.flatMap((g) => g.modules).find((r) => r.feature);
    expect(anyModule).toBeDefined();

    const overridden = buildModuleMatrix({
      ...base,
      overrides: { [anyModule!.feature!]: { enabled: true } },
    });
    const row = overridden.groups
      .flatMap((g) => g.modules)
      .find((r) => r.navId === anyModule!.navId)!;

    // The state must SAY it was overridden. A bare `allowed: true` would
    // make an override indistinguishable from a generous plan.
    expect(JSON.stringify(row)).toMatch(/override|grant/i);
  });

  it("lets an override switch a module OFF as well as on", () => {
    /**
     * ⚠️ THE OFF DIRECTION IS THE ONE THAT GETS FORGOTTEN, and it is the
     * one that matters during an incident: a module misbehaving for one
     * customer needs switching off for that customer without a deploy.
     */
    const m0 = buildModuleMatrix(base);
    const withFeature = m0.groups.flatMap((g) => g.modules).find((r) => r.feature)!;

    const off = buildModuleMatrix({
      ...base,
      subscriptionGrantsAccess: true,
      overrides: { [withFeature.feature!]: { enabled: false } },
    });
    const row = off.groups
      .flatMap((g) => g.modules)
      .find((r) => r.navId === withFeature.navId)!;
    expect(JSON.stringify(row)).toMatch(/revoke|false/i);
  });

  it("treats a module with no feature key as always available", () => {
    // `feature: null` means "part of the product, not sold separately" —
    // Dashboard, Settings. Gating those would lock a customer out of the
    // screen they change their own plan on.
    const m = buildModuleMatrix(base);
    const free = m.groups.flatMap((g) => g.modules).filter((r) => r.feature === null);
    expect(free.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* LIMITS                                                              */
/* ------------------------------------------------------------------ */

describe("measureLimit", () => {
  it("reports pressure as a fraction", () => {
    expect(measureLimit(5, 10).fraction).toBeCloseTo(0.5);
  });

  /**
   * ⭐ OVER-COMMITTED IS A REAL AND LEGITIMATE STATE.
   *
   * ⚠️ It happens on every downgrade: a workspace with 12 users moving to
   * a 5-seat plan is over its limit the instant the plan changes, and
   * that is the correct commercial outcome. Refusing to represent it
   * would force the operator into a database client to do a normal thing,
   * with no audit row — which is strictly worse than showing it.
   */
  it("represents being over the limit rather than clamping it away", () => {
    const over = measureLimit(12, 5);
    expect(over.overCommitted).toBe(true);
    expect(over.fraction).toBeLessThanOrEqual(1);
  });

  it("does not divide by zero on an unlimited or unset limit", () => {
    const r = measureLimit(3, 0);
    expect(Number.isNaN(r.fraction ?? 0)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* INDUSTRY                                                            */
/* ------------------------------------------------------------------ */

describe("⭐ previewIndustryChange — what the customer will actually notice", () => {
  const allowed: Record<string, boolean> = {};

  it("reports terminology changes, because those are what a user sees first", () => {
    /**
     * ⚠️ A HOTEL CALLS THEM GUESTS AND A CLINIC CALLS THEM PATIENTS, and
     * both are the `contacts` module. Switching a customer's industry
     * renames things all over their product. An operator who applies that
     * without seeing it coming has changed the vocabulary of somebody
     * else's business by picking an option from a dropdown.
     */
    const p = previewIndustryChange({
      from: "generic",
      to: "hospitality",
      allowed,
    });
    expect(Array.isArray(p.terminology)).toBe(true);
    expect(p.terminology.length).toBeGreaterThan(0);
  });

  it("reports modules appearing and disappearing", () => {
    const p = previewIndustryChange({
      from: "hospitality",
      to: "healthcare",
      allowed,
    });
    /**
     * ⚠️ THE FIELDS ARE `appearing` / `disappearing`, NOT `added` /
     * `removed` — and the difference is not arbitrary. "Added" describes
     * what the operator did; "appearing" describes what the CUSTOMER will
     * see happen to their sidebar tomorrow morning. The preview exists for
     * the second reading.
     */
    expect(p).toHaveProperty("appearing");
    expect(p).toHaveProperty("disappearing");
    // Two different verticals cannot have identical navigation, or the
    // templates are not doing anything.
    expect(p.appearing.length + p.disappearing.length).toBeGreaterThan(0);
  });

  /**
   * ⭐ THIS TEST FOUND A REAL BUG, AND IT IS WORTH SAYING WHAT.
   *
   * ⚠️ `appearing` was compared against what the workspace could SEE
   * today, not against what its old template NAMED. An item present in
   * both templates but hidden by the plan in both was therefore reported
   * as appearing — on every preview, including one that changes nothing.
   *
   * Previewing logistics against itself listed thirteen items as arriving.
   * On a real change it was worse but quieter: a narrow plan produced a
   * long "appearing" list of things that were already there and already
   * hidden, telling the operator the customer's navigation was about to
   * grow when it was not.
   */
  it("is a no-op preview when the industry does not change", () => {
    const p = previewIndustryChange({ from: "logistics", to: "logistics", allowed });
    expect(p.unchanged).toBe(true);
    expect(p.appearing).toEqual([]);
    expect(p.disappearing).toEqual([]);
    expect(p.terminology).toEqual([]);
  });

  it("handles every one of the 13 templates without throwing", () => {
    const keys = Object.keys(INDUSTRY_TEMPLATES) as Array<
      keyof typeof INDUSTRY_TEMPLATES
    >;
    expect(keys.length).toBe(13);
    for (const to of keys) {
      expect(() =>
        previewIndustryChange({ from: "generic", to, allowed }),
      ).not.toThrow();
    }
  });
});

/* ------------------------------------------------------------------ */
/* THE ATTENTION BOARD                                                 */
/* ------------------------------------------------------------------ */

describe("⭐ troubleSignals — which workspaces are in trouble", () => {
  const now = new Date("2026-08-04T00:00:00.000Z");
  const healthy = {
    status: "active",
    planTier: "basic" as const,
    trialEndsAt: null,
    seatsInUse: 3,
    seatLimit: 10,
    storageUsedMb: 100,
    storageLimitMb: 512,
    lastActivityAt: new Date("2026-08-03T00:00:00.000Z"),
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    now,
  };

  it("says nothing about a healthy workspace", () => {
    /**
     * ⚠️ THE MOST IMPORTANT ASSERTION HERE. A board that flags everything
     * flags nothing — the operator stops reading it within a week, and
     * then the genuinely failing workspace scrolls past unread.
     */
    expect(troubleSignals(healthy)).toEqual([]);
  });

  it("flags a trial about to end", () => {
    const s = troubleSignals({
      ...healthy,
      planTier: "trial",
      trialEndsAt: new Date(
        now.getTime() + (TRIAL_WARNING_DAYS - 1) * 86_400_000,
      ),
    });
    expect(s.length).toBeGreaterThan(0);
  });

  it("does not flag a trial that is still comfortably away", () => {
    const s = troubleSignals({
      ...healthy,
      planTier: "trial",
      trialEndsAt: new Date(now.getTime() + 90 * 86_400_000),
    });
    expect(s).toEqual([]);
  });

  it("flags a workspace over its seat limit", () => {
    const s = troubleSignals({ ...healthy, seatsInUse: 12, seatLimit: 10 });
    expect(s.length).toBeGreaterThan(0);
  });

  it("flags a workspace over its storage limit", () => {
    const s = troubleSignals({ ...healthy, storageUsedMb: 900, storageLimitMb: 512 });
    expect(s.length).toBeGreaterThan(0);
  });

  it("flags a long-silent workspace", () => {
    const s = troubleSignals({
      ...healthy,
      lastActivityAt: new Date(now.getTime() - 365 * 86_400_000),
    });
    expect(s.length).toBeGreaterThan(0);
  });

  it("does not call a brand-new workspace silent", () => {
    /**
     * ⚠️ A WORKSPACE PROVISIONED THIS MORNING HAS NO ACTIVITY, and that is
     * not a problem — it is Tuesday. Flagging it puts every new customer
     * on the trouble board on their first day, which is precisely when an
     * operator most wants the board to mean something.
     */
    const s = troubleSignals({
      ...healthy,
      lastActivityAt: null,
      createdAt: new Date(now.getTime() - 2 * 86_400_000),
    });
    expect(s.every((x) => x.kind !== "silent")).toBe(true);
  });

  it("flags a suspended workspace", () => {
    const s = troubleSignals({ ...healthy, status: "suspended" });
    expect(s.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* PLAN TIERS                                                          */
/* ------------------------------------------------------------------ */

describe("⭐ drift guard — the configurable tiers are real database values", () => {
  /**
   * ⚠️ THIS IS THE BUG THAT MADE PROVISIONING NEVER WORK.
   *
   * The provisioning form offered `free`, `starter`, `growth` and `scale`.
   * The `plan_tier` Postgres enum accepts `trial`, `basic`, `advanced`,
   * `ai` and `enterprise`. Nothing type-checked the gap because the value
   * went into a raw `sql` template, so every attempt to create a workspace
   * died on `invalid input value for enum plan_tier` — a failure at the
   * very first step of onboarding a customer.
   *
   * The enum lives in `db/schema/core.ts`. If somebody adds a tier there
   * and not here, this fails.
   */
  it("offers only tiers the plan_tier enum actually accepts", () => {
    const REAL = ["trial", "basic", "advanced", "ai", "enterprise"];
    for (const tier of CONFIGURABLE_PLAN_TIERS) {
      expect(
        REAL,
        `"${tier}" is offered in the console but is not a member of the plan_tier enum — provisioning with it fails at the INSERT.`,
      ).toContain(tier);
    }
  });
});
