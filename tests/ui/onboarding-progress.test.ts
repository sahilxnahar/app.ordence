/**
 * Ordence — ⭐⭐⭐ THE STALL DEFINITION IS ONE FUNCTION
 * Version: v1.52.0-alpha
 *
 * ⚠️ THESE ASSERT PROPERTIES, NOT SHAPES. No test here pins a literal
 * count, a literal href or a rendered string. A test that says
 * "STALL_THRESHOLD_DAYS === 3" only asserts that somebody typed 3 twice;
 * it does not stop a badge and a table from disagreeing, which is the
 * failure that actually costs a customer.
 */

import { describe, expect, it } from "vitest";
import {
  ONBOARDING_STEPS,
  ONBOARDING_TOTAL_STEPS,
  STALL_THRESHOLD_DAYS,
  byStalledFirst,
  countStalled,
  currentStepNumber,
  daysSince,
  isStalled,
  stallWord,
  stepsComplete,
  type OnboardingProgressRow,
} from "@/lib/platform/onboarding-progress";
import { CONSOLE_NAV, consoleHref } from "@/lib/platform/console-paths";

const DAY = 86_400_000;

function row(days: number, createdAt = "2026-01-01T00:00:00.000Z"): OnboardingProgressRow {
  return {
    tenantId: `t-${days}-${createdAt}`,
    slug: "acme",
    name: "Acme",
    status: "active",
    planTier: "growth",
    currentStep: 2,
    lastProgressAt: createdAt,
    neverStarted: false,
    daysSinceProgress: days,
    createdAt,
    trialEndsAt: null,
    contactEmail: null,
    contactName: null,
    contactStatus: null,
  };
}

/** A spread that straddles the threshold from both sides, whatever it is. */
const SPREAD = [
  0,
  1,
  STALL_THRESHOLD_DAYS - 2,
  STALL_THRESHOLD_DAYS - 1,
  STALL_THRESHOLD_DAYS,
  STALL_THRESHOLD_DAYS + 1,
  9,
  40,
].filter((d) => d >= 0);

describe("the stall definition is one function", () => {
  /**
   * 🔴 THE TEST THAT MATTERS MOST. The header badge calls `countStalled`
   * and each row calls `isStalled`; if those two ever stop agreeing, a
   * badge says six and the table shows eight. This asserts the identity
   * over an arbitrary population rather than over one hand-built case.
   */
  it("the count equals the number of rows the list itself marks stalled", () => {
    for (let seed = 0; seed < 40; seed += 1) {
      const rows = Array.from({ length: seed % 11 }, (_, i) =>
        row(SPREAD[(i * 3 + seed) % SPREAD.length]),
      );
      expect(countStalled(rows)).toBe(rows.filter((r) => isStalled(r)).length);
    }
  });

  it("the count is never larger than the list and never negative", () => {
    const rows = SPREAD.map((d) => row(d));
    expect(countStalled(rows)).toBeGreaterThanOrEqual(0);
    expect(countStalled(rows)).toBeLessThanOrEqual(rows.length);
    expect(countStalled([])).toBe(0);
  });

  it("the word on a row agrees with the predicate that counts it", () => {
    for (const days of SPREAD) {
      const r = row(days);
      // Every state carries a WORD — and it must be the word for the
      // state the counter put it in.
      expect(stallWord(r) === "Stalled").toBe(isStalled(r));
    }
  });

  it("stalling is monotone: an older row is never less stalled than a newer one", () => {
    for (const days of SPREAD) {
      if (isStalled(row(days))) expect(isStalled(row(days + 1))).toBe(true);
    }
  });
});

describe("age in days", () => {
  it("is floored, so a gap short of a whole day never counts as one", () => {
    const now = new Date("2026-03-10T09:00:00.000Z");
    const almost = new Date(now.getTime() - (DAY - 1000)).toISOString();
    expect(daysSince(almost, now)).toBe(0);
  });

  it("a Friday-afternoon step picked up Monday morning is not stalled", () => {
    // ⭐ The case the threshold was chosen for. Fri 16:00 → Mon 09:00 is
    // about 2.7 days; flooring keeps it below the line.
    const friday = "2026-03-06T16:00:00.000Z";
    const monday = new Date("2026-03-09T09:00:00.000Z");
    expect(isStalled({ daysSinceProgress: daysSince(friday, monday) })).toBe(false);
  });

  it("never returns a negative age for a timestamp in the future or an unusable one", () => {
    const now = new Date("2026-03-10T09:00:00.000Z");
    expect(daysSince("2027-01-01T00:00:00.000Z", now)).toBe(0);
    expect(daysSince(null, now)).toBe(0);
    expect(daysSince("not a date", now)).toBe(0);
  });

  it("reads the same clock for every row on a page", () => {
    const now = new Date("2026-03-10T09:00:00.000Z");
    const iso = new Date(now.getTime() - 5 * DAY).toISOString();
    expect(daysSince(iso, now)).toBe(daysSince(iso, now));
  });
});

describe("the steps come from server/actions/onboarding.ts", () => {
  it("numbers the steps consecutively from one, with no gaps", () => {
    ONBOARDING_STEPS.forEach((step, i) => expect(step.number).toBe(i + 1));
    expect(ONBOARDING_TOTAL_STEPS).toBe(ONBOARDING_STEPS.length);
  });

  it("names the action that completes each step, so the table is checkable", () => {
    for (const step of ONBOARDING_STEPS) {
      expect(step.completedBy.length).toBeGreaterThan(0);
      expect(step.blocker.length).toBeGreaterThan(0);
    }
  });

  it("treats an absent counter as the first step rather than hiding the workspace", () => {
    // A provisioned tenant's settings carry no `onboardingStep` at all.
    expect(currentStepNumber(null)).toBe(ONBOARDING_STEPS[0].number);
    expect(currentStepNumber(undefined)).toBe(ONBOARDING_STEPS[0].number);
  });

  it("clamps a corrupt counter into the wizard instead of off the list", () => {
    expect(currentStepNumber(0)).toBe(1);
    expect(currentStepNumber(-4)).toBe(1);
    expect(currentStepNumber(ONBOARDING_TOTAL_STEPS + 9)).toBe(ONBOARDING_TOTAL_STEPS);
    expect(currentStepNumber(Number.NaN)).toBe(1);
  });

  it("counts steps FINISHED, which is one fewer than the step you are on", () => {
    for (const step of ONBOARDING_STEPS) {
      expect(stepsComplete(step.number)).toBe(step.number - 1);
      expect(stepsComplete(step.number)).toBeLessThan(ONBOARDING_TOTAL_STEPS);
      expect(stepsComplete(step.number)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("the list is stalled-first, not chronological", () => {
  it("puts the longest-stalled workspace at the top", () => {
    const rows = SPREAD.map((d, i) => row(d, `2026-01-0${(i % 9) + 1}T00:00:00.000Z`));
    const sorted = [...rows].sort(byStalledFirst);
    for (let i = 1; i < sorted.length; i += 1) {
      expect(sorted[i - 1].daysSinceProgress).toBeGreaterThanOrEqual(sorted[i].daysSinceProgress);
    }
    // Whatever is first is at least as bad as anything else on the page.
    const worst = Math.max(...rows.map((r) => r.daysSinceProgress));
    expect(sorted[0].daysSinceProgress).toBe(worst);
  });

  it("orders totally, so equal ages cannot swap between renders", () => {
    const a = row(5, "2026-01-01T00:00:00.000Z");
    const b = row(5, "2026-02-01T00:00:00.000Z");
    expect(byStalledFirst(a, b)).toBeLessThan(0);
    expect(byStalledFirst(b, a)).toBeGreaterThan(0);
    expect(byStalledFirst(a, a)).toBe(0);
  });
});

describe("the page is reachable on both console hosts", () => {
  it("appears in the nav exactly once, written canonically", () => {
    const entries = CONSOLE_NAV.filter((n) => n.href.includes("onboarding"));
    expect(entries).toHaveLength(1);
    expect(entries[0].href.startsWith("/platform")).toBe(true);
    expect(entries[0].label.length).toBeGreaterThan(0);
  });

  it("maps onto whichever host is serving, and drops the prefix on the console host", () => {
    const entry = CONSOLE_NAV.find((n) => n.href.includes("onboarding"));
    expect(entry).toBeDefined();
    const href = entry!.href;
    expect(consoleHref(href, false)).toBe(href);
    expect(consoleHref(href, true).startsWith("/platform")).toBe(false);
    expect(consoleHref(href, true).startsWith("/")).toBe(true);
  });
});
