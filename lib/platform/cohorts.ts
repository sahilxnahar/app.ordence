/**
 * Ordence — ⭐⭐ JOIN-MONTH COHORTS: IS ONBOARDING GETTING BETTER OR WORSE?
 * Version: v1.52.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 NO `import "server-only"` HERE, FOR THE SAME REASON AS
 *    `lib/platform/onboarding-progress.ts`
 * ══════════════════════════════════════════════════════════════════════
 * The table renders in the browser and sorts in the browser. If the
 * arithmetic lived in the server module, a sorted column and the number
 * printed in it could be computed by two different pieces of code.
 * Everything here is pure: values in, values out, no clock of its own.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ "COMPLETED ONBOARDING" IS NOT DEFINED IN THIS FILE
 * ══════════════════════════════════════════════════════════════════════
 * It is `hasCompletedOnboarding()` from `onboarding-progress.ts`, imported
 * below and used for the count, the rate AND the median's sample. A second
 * definition here — "step is null", say — would look right and be wrong in
 * precisely one direction: it would score every workspace that never
 * opened the wizard as a success, because `completeOnboarding()` clears
 * the step counter on its way out. Two lists that must agree by discipline
 * is what produced the eight-name reserved-slug drift that migration 0091
 * had to clean up.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ EVERY DERIVED NUMBER CARRIES ITS DENOMINATOR
 * ══════════════════════════════════════════════════════════════════════
 * "60% completed" over five workspaces is three workspaces. The screen
 * that says only "60%" invites a decision that the evidence cannot carry,
 * and this platform has months with four signups in them. So the rate is
 * always rendered beside `completed of created`, and the median is
 * SUPPRESSED rather than shown when the sample is too small — see
 * `MIN_COHORT_FOR_MEDIAN`.
 */

import {
  daysSince,
  completedOnboardingAt,
  hasCompletedOnboarding,
} from "./onboarding-progress";

/* ------------------------------------------------------------------ */
/* INPUT                                                               */
/* ------------------------------------------------------------------ */

/** One workspace, as the cohort maths needs it. */
export type CohortMember = {
  tenantId: string;
  /** ISO. The month of this instant decides which cohort the row joins. */
  createdAt: string;
  /** Straight off `tenants.status`. `active` is the only living value. */
  status: string;
  /**
   * ⚠️ RAW `tenants.settings`, NOT A PRE-COMPUTED BOOLEAN. Handing this
   * module a `completed: boolean` would move the definition to whoever
   * built the row, which is the second definition this file exists to
   * refuse. The predicate is applied here, once, by the imported function.
   */
  settings: unknown;
};

/* ------------------------------------------------------------------ */
/* THE MONTH BOUNDARY                                                  */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ COHORTS ARE CUT IN IST, NOT UTC, AND THE DIFFERENCE IS REAL.
 *
 * A customer who signs up at 01:30 on 1 March in Mumbai is stored as
 * 2026-02-28T20:00Z. Bucketed by UTC month they join FEBRUARY — a month
 * they were not alive in — and every cohort boundary in the country is
 * off by five and a half hours of signups. Operators compare these rows
 * against a sales calendar kept in IST; the report has to agree with it.
 *
 * A fixed offset is correct rather than lazy: India has had no daylight
 * saving since 1945, so +05:30 is not an approximation, and a fixed
 * offset keeps this function pure and identical on server and client
 * (`Intl` time zone data differs between Node builds).
 */
const IST_OFFSET_MINUTES = 330;

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/** `2026-03` for any instant, cut on IST month boundaries. Sorts as text. */
export function cohortKey(isoInstant: string): string | null {
  const t = new Date(isoInstant).getTime();
  if (!Number.isFinite(t)) return null;
  const local = new Date(t + IST_OFFSET_MINUTES * 60_000);
  const month = String(local.getUTCMonth() + 1).padStart(2, "0");
  return `${local.getUTCFullYear()}-${month}`;
}

/** `2026-03` → `March 2026`. Falls back to the key rather than inventing one. */
export function cohortLabel(key: string): string {
  const [year, month] = key.split("-");
  if (year === undefined || month === undefined) return key;
  // 🔴 `noUncheckedIndexedAccess`: MONTH_NAMES[n] is `string | undefined`,
  // and a corrupted key must degrade to the raw key rather than "undefined
  // 2026" — which is what a cast would have printed.
  const name = MONTH_NAMES[Number.parseInt(month, 10) - 1];
  return name === undefined ? key : `${name} ${year}`;
}

/* ------------------------------------------------------------------ */
/* ⭐ THE MEDIAN, AND WHEN IT REFUSES TO ANSWER                        */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 FIVE MEASURED ACTIVATIONS, OR NO MEDIAN AT ALL.
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY FIVE.
 *
 *   • With four or fewer, one workspace is at least a quarter of the
 *     sample. A single customer who left the wizard open over Diwali and
 *     finished on day 19 moves the printed "median days to activation"
 *     by a week, and somebody reads that as a trend and changes the
 *     onboarding emails because of it.
 *
 *   • Below five the median is not even an observation: an even sample
 *     averages the two middle values, so a two-row cohort prints a number
 *     that no workspace actually experienced.
 *
 *   • Five is odd, so the answer is a real workspace's real duration, and
 *     no single row is worth more than 20% of the sample. It is also low
 *     enough that a genuinely small month still reports SOMETHING for its
 *     count and rate — only the median goes quiet.
 *
 * ⚠️ THE SAMPLE IS COMPLETED WORKSPACES, NOT CREATED ONES. A month with
 * forty signups and three completions has no median: there are three
 * durations in existence. Testing the created count instead would print a
 * confident number off three data points, which is the exact failure this
 * threshold exists to prevent.
 *
 * ⭐ SUPPRESSED, NOT ZEROED AND NOT HIDDEN. The cell says so in words —
 * one in twelve Indian men is colour-blind, and a greyed-out number is
 * just a number to them.
 */
export const MIN_COHORT_FOR_MEDIAN = 5;

/** What the cell says when the sample is too small to mean anything. */
export const MEDIAN_SUPPRESSED_WORD = "Too few to say";

/**
 * Median of an ALREADY SORTED ascending list, or null when empty.
 *
 * 🔴 `noUncheckedIndexedAccess` is on: `sorted[mid]` is `number |
 * undefined`. The undefined branches are handled and not asserted away —
 * a `!` here would be a crash on the day somebody passes a sparse array.
 */
export function medianOf(sorted: readonly number[]): number | null {
  const n = sorted.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  const upper = sorted[mid];
  if (upper === undefined) return null;
  if (n % 2 === 1) return upper;
  const lower = sorted[mid - 1];
  if (lower === undefined) return null;
  return (lower + upper) / 2;
}

/* ------------------------------------------------------------------ */
/* OUTPUT                                                              */
/* ------------------------------------------------------------------ */

export type CohortRow = {
  /** `2026-03`. Sorts correctly as text, which is why it is the row id. */
  key: string;
  label: string;
  /** 🔴 THE DENOMINATOR FOR EVERYTHING ELSE ON THE ROW. */
  created: number;
  /** Decided by `hasCompletedOnboarding`, never by the step counter. */
  completed: number;
  /** 0..1, or null when the cohort is empty (which cannot happen here). */
  completionRate: number | null;
  /** `tenants.status === "active"` today, not at any point in the past. */
  stillActive: number;
  /**
   * Whole days from creation to completion, floored — the same flooring
   * rule as the stall clock, via `daysSince`.
   * 🔴 NULL WHEN SUPPRESSED. A consumer cannot tell "no data" from "zero
   * days" if suppression writes 0, so suppression writes null.
   */
  medianDaysToActivation: number | null;
  /** How many durations the median was taken over. Always rendered. */
  medianSample: number;
  /** True when the sample was below `MIN_COHORT_FOR_MEDIAN`. */
  medianSuppressed: boolean;
};

/**
 * Group workspaces by the IST month they joined.
 *
 * ⚠️ NO `now` IS NEEDED AND NONE IS TAKEN. Every number here is a fact
 * about the past: when a workspace was created, whether it has completed,
 * how long that took. Nothing ages between renders, so nothing here may
 * read a clock and produce two different tables for two operators.
 *
 * Newest cohort first: the question this screen answers is "is it getting
 * better", and the most recent month is the one being asked about.
 */
export function buildCohorts(members: readonly CohortMember[]): CohortRow[] {
  const buckets = new Map<
    string,
    { created: number; completed: number; stillActive: number; durations: number[] }
  >();

  for (const member of members) {
    const key = cohortKey(member.createdAt);
    // A row with an unparseable creation timestamp belongs to no month.
    // Dropping it is the only honest option; putting it in the current
    // month would inflate whichever cohort is under scrutiny.
    if (key === null) continue;

    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = { created: 0, completed: 0, stillActive: 0, durations: [] };
      buckets.set(key, bucket);
    }

    bucket.created += 1;
    if (member.status === "active") bucket.stillActive += 1;

    if (hasCompletedOnboarding(member.settings)) {
      bucket.completed += 1;
      const completedAt = completedOnboardingAt(member.settings);
      if (completedAt !== null) {
        /*
         * ⚠️ `daysSince` MEASURES FROM CREATION TO COMPLETION, not to now.
         * Reusing it rather than dividing by 86_400_000 again keeps ONE
         * flooring rule in the codebase: 2.9 days is 2 here exactly as it
         * is on the stall clock, and it also floors a clock-skewed
         * negative to 0 rather than dragging the median below zero.
         */
        bucket.durations.push(daysSince(member.createdAt, new Date(completedAt)));
      }
    }
  }

  const rows: CohortRow[] = [];
  for (const [key, bucket] of buckets) {
    const sorted = [...bucket.durations].sort((a, b) => a - b);
    const suppressed = sorted.length < MIN_COHORT_FOR_MEDIAN;
    rows.push({
      key,
      label: cohortLabel(key),
      created: bucket.created,
      completed: bucket.completed,
      completionRate: bucket.created > 0 ? bucket.completed / bucket.created : null,
      stillActive: bucket.stillActive,
      medianDaysToActivation: suppressed ? null : medianOf(sorted),
      medianSample: sorted.length,
      medianSuppressed: suppressed,
    });
  }

  rows.sort((a, b) => b.key.localeCompare(a.key));
  return rows;
}

/**
 * ⭐ THE WORD IN THE MEDIAN CELL, so the state is legible without colour
 * and without comparing two cells. Carries the denominator either way:
 * "6 days (from 11)" is a number somebody can argue with; "6 days" is not.
 */
export function medianWord(row: Pick<CohortRow, "medianDaysToActivation" | "medianSample">): string {
  if (row.medianDaysToActivation === null) {
    return `${MEDIAN_SUPPRESSED_WORD} (${row.medianSample} of ${MIN_COHORT_FOR_MEDIAN} needed)`;
  }
  const days = row.medianDaysToActivation;
  const rendered = Number.isInteger(days) ? String(days) : days.toFixed(1);
  return `${rendered} ${days === 1 ? "day" : "days"} (from ${row.medianSample})`;
}

/** "9 of 14 · 64%". Never the percentage on its own. See the header. */
export function rateWord(completed: number, created: number): string {
  if (created <= 0) return "0 of 0";
  return `${completed} of ${created} · ${Math.round((completed / created) * 100)}%`;
}
