/**
 * Ordence — ⭐⭐ COHORTS: ONE COMPLETION RULE, AND A MEDIAN THAT KNOWS
 *                WHEN TO SHUT UP
 * Version: v1.52.0-alpha
 *
 * ⚠️ THESE ASSERT PROPERTIES, NOT SHAPES. Nothing here pins a rendered
 * string, an href, a path or a literal count. "MIN_COHORT_FOR_MEDIAN === 5"
 * would only prove somebody typed 5 twice; it would not stop a four-row
 * cohort printing a confident median, which is the failure that costs a
 * decision.
 */

import { describe, expect, it } from "vitest";
import {
  MIN_COHORT_FOR_MEDIAN,
  buildCohorts,
  cohortKey,
  medianOf,
  medianWord,
  rateWord,
  type CohortMember,
} from "@/lib/platform/cohorts";
import { hasCompletedOnboarding } from "@/lib/platform/onboarding-progress";
import { CONSOLE_NAV, consoleHref } from "@/lib/platform/console-paths";

const DAY = 86_400_000;

/**
 * A deliberately awkward population: finished, never started, parked
 * mid-wizard with the step counter cleared, corrupted markers, and two
 * IST-boundary signups that a UTC month cut would file under the wrong
 * month.
 */
function population(): CohortMember[] {
  const members: CohortMember[] = [];
  const base = Date.parse("2026-03-05T06:00:00.000Z");

  // Twelve completed workspaces in March, spread over 0..11 days.
  for (let i = 0; i < 12; i += 1) {
    const createdAt = new Date(base + i * DAY).toISOString();
    members.push({
      tenantId: `mar-done-${i}`,
      createdAt,
      status: i % 4 === 0 ? "suspended" : "active",
      settings: {
        industry: "generic",
        onboardedAt: new Date(Date.parse(createdAt) + i * DAY).toISOString(),
      },
    });
  }

  // Five March workspaces that never finished. 🔴 THE TRAP: two of them
  // have NO `onboardingStep`, exactly like a workspace that finished —
  // `completeOnboarding()` clears the counter on its way out. A rule
  // written against the step counter scores these as successes.
  for (let i = 0; i < 5; i += 1) {
    members.push({
      tenantId: `mar-stuck-${i}`,
      createdAt: new Date(base + i * DAY).toISOString(),
      status: "pending",
      settings: i < 2 ? { industry: "generic" } : { onboardingStep: 3 },
    });
  }

  // April: three completed only — below the median floor whatever it is.
  for (let i = 0; i < 3; i += 1) {
    const createdAt = new Date(Date.parse("2026-04-02T04:00:00.000Z") + i * DAY).toISOString();
    members.push({
      tenantId: `apr-done-${i}`,
      createdAt,
      status: "active",
      settings: { onboardedAt: new Date(Date.parse(createdAt) + 30 * DAY).toISOString() },
    });
  }

  // Corrupted and hostile markers. None of these is a completion.
  members.push(
    { tenantId: "junk-1", createdAt: "2026-04-04T00:00:00.000Z", status: "active", settings: null },
    { tenantId: "junk-2", createdAt: "2026-04-04T00:00:00.000Z", status: "active", settings: { onboardedAt: "" } },
    { tenantId: "junk-3", createdAt: "2026-04-04T00:00:00.000Z", status: "active", settings: { onboardedAt: "not-a-date" } },
    { tenantId: "junk-4", createdAt: "2026-04-04T00:00:00.000Z", status: "active", settings: { onboardedAt: 17 } },
    { tenantId: "junk-5", createdAt: "2026-04-04T00:00:00.000Z", status: "active", settings: "onboardedAt" },
  );

  return members;
}

describe("completed onboarding is ONE function, shared with batch 122", () => {
  it("counts exactly the members the exported predicate accepts", () => {
    const members = population();
    const rows = buildCohorts(members);

    // 🔴 THE PROPERTY THAT MATTERS: the table's total is derived from the
    // SAME predicate the onboarding screen uses, not from a second rule
    // that happens to agree today.
    const expected = members.filter((m) => hasCompletedOnboarding(m.settings)).length;
    const counted = rows.reduce((sum, r) => sum + r.completed, 0);
    expect(counted).toBe(expected);
  });

  it("does not treat an absent step counter as completion", () => {
    // Both of these have no `onboardingStep`. One finished; one never
    // started. A rule reading the counter cannot tell them apart.
    const finished: CohortMember = {
      tenantId: "a",
      createdAt: "2026-05-01T00:00:00.000Z",
      status: "active",
      settings: { onboardedAt: "2026-05-03T00:00:00.000Z" },
    };
    const neverStarted: CohortMember = { ...finished, tenantId: "b", settings: {} };

    const [row] = buildCohorts([finished, neverStarted]);
    expect(row).toBeDefined();
    expect(row?.created).toBe(2);
    expect(row?.completed).toBe(hasCompletedOnboarding(finished.settings) ? 1 : 0);
    expect(row?.completed).toBe(1);
  });

  it("never counts more completions than workspaces, in any cohort", () => {
    for (const row of buildCohorts(population())) {
      expect(row.completed).toBeLessThanOrEqual(row.created);
      // A duration can only exist for a completed workspace.
      expect(row.medianSample).toBeLessThanOrEqual(row.completed);
      expect(row.stillActive).toBeLessThanOrEqual(row.created);
    }
  });
});

describe("a cohort too small to mean anything suppresses its median", () => {
  it("suppresses below the floor and answers at or above it, whatever the floor is", () => {
    const created = "2026-06-01T00:00:00.000Z";
    // Sweep sample sizes straddling the threshold from both sides.
    for (let n = 0; n <= MIN_COHORT_FOR_MEDIAN + 2; n += 1) {
      const members: CohortMember[] = [];
      for (let i = 0; i < n; i += 1) {
        members.push({
          tenantId: `x-${i}`,
          createdAt: created,
          status: "active",
          settings: { onboardedAt: new Date(Date.parse(created) + (i + 1) * DAY).toISOString() },
        });
      }
      const [row] = buildCohorts(members);
      if (n === 0) {
        expect(row).toBeUndefined();
        continue;
      }
      expect(row).toBeDefined();
      if (!row) continue;

      if (n < MIN_COHORT_FOR_MEDIAN) {
        // 🔴 NULL, NOT ZERO. Zero would sort as the fastest month ever.
        expect(row.medianDaysToActivation).toBeNull();
        expect(row.medianSuppressed).toBe(true);
      } else {
        expect(row.medianDaysToActivation).not.toBeNull();
        expect(row.medianSuppressed).toBe(false);
      }
    }
  });

  it("says so in words, and the words carry the denominator either way", () => {
    for (const row of buildCohorts(population())) {
      const word = medianWord(row);
      // ⚠️ THE WORD, NOT THE COLOUR: a suppressed cell must be legible to
      // somebody who cannot see that it is greyed out.
      expect(word.trim().length).toBeGreaterThan(0);
      expect(/[A-Za-z]/.test(word)).toBe(true);
      // The sample size appears in both states, so no number on this
      // screen can be read without its denominator.
      expect(word).toContain(String(row.medianSample));
    }
  });

  it("prints a rate only alongside the two numbers it came from", () => {
    for (const row of buildCohorts(population())) {
      const word = rateWord(row.completed, row.created);
      expect(word).toContain(String(row.completed));
      expect(word).toContain(String(row.created));
    }
  });
});

describe("the median itself", () => {
  it("is an element of an odd sample and lies between the middles of an even one", () => {
    const odd = [1, 4, 9];
    expect(odd).toContain(medianOf(odd));

    const even = [2, 4, 10, 20];
    const m = medianOf(even);
    expect(m).not.toBeNull();
    if (m !== null) {
      expect(m).toBeGreaterThanOrEqual(4);
      expect(m).toBeLessThanOrEqual(10);
    }
  });

  it("returns null rather than a number for an empty sample", () => {
    expect(medianOf([])).toBeNull();
  });
});

describe("cohort months", () => {
  it("puts a late-night Indian signup in the month its customer was living in", () => {
    // 01:30 IST on 1 March is 2026-02-28T20:00Z. A UTC cut files this
    // customer under a month they had not reached.
    const istEarlyMarch = "2026-02-28T20:00:00.000Z";
    const istLateFebruary = "2026-02-28T17:00:00.000Z";
    expect(cohortKey(istEarlyMarch)).not.toBe(cohortKey(istLateFebruary));
    expect(cohortKey(istEarlyMarch)).toBe("2026-03");
  });

  it("drops a row it cannot date rather than filing it under today", () => {
    const rows = buildCohorts([
      { tenantId: "bad", createdAt: "not-a-date", status: "active", settings: {} },
    ]);
    expect(rows).toHaveLength(0);
  });
});

describe("the screen is reachable on both console base paths", () => {
  it("has a nav entry whose links never keep the /platform prefix on the console host", () => {
    const entry = CONSOLE_NAV.find((item) => item.href.includes("cohort"));
    expect(entry).toBeDefined();
    if (!entry) return;
    // ⚠️ A PROPERTY, NOT A PINNED STRING: on the console host no console
    // link may still carry the prefix, whatever the path happens to be.
    expect(consoleHref(entry.href, true).startsWith("/platform")).toBe(false);
    expect(consoleHref(entry.href, false)).toBe(entry.href);
  });
});
