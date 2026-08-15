/**
 * Ordence — ⭐⭐ THE APPRAISAL CYCLE, AS ARITHMETIC
 * Version: v1.47.0-alpha · Batch 109
 *
 * Pure. No database, no clock beyond the one that is passed in, no I/O.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 EVERY DATE IN THIS MODULE IS A CIVIL DATE IN ASIA/KOLKATA, HELD AS
 *    `YYYY-MM-DD`, AND NEVER A `Date` OBJECT
 * ══════════════════════════════════════════════════════════════════════
 * `new Date().toISOString().slice(0,10)` on a server in UTC returns
 * YESTERDAY for everybody in India between 00:00 and 05:30 IST. A cycle
 * whose period ends "31 March" would then be recorded as ending 30 March
 * for any run that happens overnight, which puts it in the wrong
 * financial year — and the wrong financial year is the one thing the
 * label exists to get right.
 */

import type { AppraisalRating } from "@/db/schema/appraisals";

/**
 * ⭐ TODAY, IN INDIA, AS A CIVIL DATE.
 *
 * ⚠️ `en-CA` IS NOT A TYPO. It is the only widely-supported locale whose
 * short date format is already `YYYY-MM-DD`, so no reassembly of parts
 * is needed and no month/day transposition is possible. The same trick
 * `lib/accounting/periods.ts` and `lib/sales/inventory.ts` use.
 */
export function todayInIndia(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * ⭐ THE INDIAN FINANCIAL YEAR A DATE FALLS IN, AS "2025-26".
 *
 * 1 April to 31 March. 🔴 A DATE IN JANUARY BELONGS TO THE FY THAT
 * STARTED THE PREVIOUS APRIL, and getting that backwards files an
 * appraisal cycle under a year that has not started.
 *
 * ⚠️ THE LABEL IS DERIVED FROM `periodEnd`, NOT `periodStart`. A cycle
 * running October to March is the second half of FY 2025-26, and
 * labelling it by its start would file it under 2025-26 as well — which
 * is right — but a cycle running January to June is FY 2026-27's, and
 * labelling that one by its start would file it under the year it was
 * mostly not in. The end date is the one people mean.
 */
export function fyLabelFor(isoDate: string): string {
  const year = Number(isoDate.slice(0, 4));
  const month = Number(isoDate.slice(5, 7));
  if (!Number.isFinite(year) || !Number.isFinite(month)) return "";
  const startYear = month >= 4 ? year : year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

/** The first day of the FY a date falls in. */
export function fyStartOf(isoDate: string): string {
  const label = fyLabelFor(isoDate);
  return `${label.slice(0, 4)}-04-01`;
}

/**
 * ⭐ THE RATINGS, IN ORDER, WITH THE WORDS PEOPLE ACTUALLY READ.
 *
 * ⚠️ THE ORDER IS DATA, NOT A COMPARISON ON THE ENUM. Postgres orders an
 * enum by declaration order and TypeScript orders strings
 * alphabetically, which puts "exceeds" below "meets" and above
 * "needs_improvement" — a silent mis-sort on the one column a manager
 * scans down.
 */
export const RATING_ORDER: readonly AppraisalRating[] = [
  "unsatisfactory",
  "needs_improvement",
  "meets",
  "exceeds",
  "outstanding",
];

export const RATING_LABELS: Record<AppraisalRating, string> = {
  unsatisfactory: "Unsatisfactory",
  needs_improvement: "Needs improvement",
  meets: "Meets expectations",
  exceeds: "Exceeds expectations",
  outstanding: "Outstanding",
};

export function rankOfRating(rating: AppraisalRating): number {
  return RATING_ORDER.indexOf(rating);
}

/**
 * ⭐⭐ THE EFFECTIVE OUTCOME IS A FOLD, NEVER A COLUMN.
 *
 * 🔴 `appraisal_subjects.outcome_rating` IS FROZEN AT SIGN-OFF AND IS
 * THE ORIGINAL, FOREVER. A correction is an `appraisal_amendments` row
 * with an actor and a reason, and the outcome anybody should quote is
 * the latest amendment, or the original when there is none.
 *
 * ⚠️ WRITING THE AMENDED RATING BACK ONTO THE SUBJECT ROW WAS THE
 * TEMPTING SHORTCUT AND IT IS THE BUG. Two places holding the same fact
 * disagree the first time one write of a pair is missed, and both look
 * like ratings, so nothing on any screen would show which is stale.
 * `leave_ledger` makes exactly this call about balances.
 */
export function effectiveOutcome(args: {
  originalRating: AppraisalRating | null;
  originalSummary: string | null;
  amendments: ReadonlyArray<{
    newRating: AppraisalRating;
    newSummary: string | null;
    amendedAt: Date | string;
  }>;
}): {
  rating: AppraisalRating | null;
  summary: string | null;
  amended: boolean;
  amendmentCount: number;
} {
  if (args.amendments.length === 0) {
    return {
      rating: args.originalRating,
      summary: args.originalSummary,
      amended: false,
      amendmentCount: 0,
    };
  }
  /**
   * ⚠️ SORTED HERE RATHER THAN TRUSTED FROM THE CALLER. An unordered
   * array is one forgotten `orderBy` away from reporting the FIRST
   * correction as the current one, which on an appraisal that has been
   * corrected twice means quoting a rating that was itself withdrawn.
   */
  const sorted = [...args.amendments].sort((a, b) => {
    const at = a.amendedAt instanceof Date ? a.amendedAt.getTime() : Date.parse(String(a.amendedAt));
    const bt = b.amendedAt instanceof Date ? b.amendedAt.getTime() : Date.parse(String(b.amendedAt));
    return at - bt;
  });
  // ⚠️ `noUncheckedIndexedAccess` is on, and it is right to be: `sorted`
  // is non-empty by the guard above, but an index expression cannot know
  // that. The fallback is not decoration, it is the honest answer if the
  // guard is ever moved.
  const last = sorted[sorted.length - 1];
  if (!last) {
    return {
      rating: args.originalRating,
      summary: args.originalSummary,
      amended: false,
      amendmentCount: 0,
    };
  }
  return {
    rating: last.newRating,
    summary: last.newSummary,
    amended: true,
    amendmentCount: sorted.length,
  };
}

/**
 * ⭐ WHICH REPORTING LINE COVERED A REVIEW PERIOD.
 *
 * 🔴 THE APPRAISAL ASKS "WHO MANAGED THIS PERSON THEN", NOT "WHO
 * MANAGES THEM NOW". A cycle covering April to September, enrolled in
 * October after a reorganisation, must pick the line that was in force
 * during the period — otherwise the review is assigned to somebody who
 * has never worked with the subject, and it will be written anyway.
 *
 * ⚠️ WHEN SEVERAL LINES OVERLAP THE PERIOD — somebody changed manager in
 * July — THE ONE WITH THE LONGEST OVERLAP WINS, and that is a choice
 * rather than a truth. Two managers each owning half a period is a real
 * situation with no single correct answer; picking the larger share is
 * defensible, arbitrary, and better than picking whichever row the
 * database happened to return first. The screen shows who was picked so
 * a human can change it.
 */
export function lineCoveringPeriod<
  T extends { managerId: string; effectiveFrom: string; endedOn: string | null },
>(lines: readonly T[], periodStart: string, periodEnd: string): T | null {
  let best: T | null = null;
  let bestDays = -1;
  for (const line of lines) {
    const from = line.effectiveFrom > periodStart ? line.effectiveFrom : periodStart;
    const to =
      line.endedOn === null || line.endedOn > periodEnd ? periodEnd : line.endedOn;
    if (from > to) continue;
    const days = inclusiveDays(from, to);
    /**
     * ⚠️ STRICTLY GREATER, so an earlier line wins a tie. Deterministic
     * beats "whichever came back first" — a chart that renders
     * differently on refresh is a chart nobody trusts.
     */
    if (days > bestDays) {
      bestDays = days;
      best = line;
    }
  }
  return best;
}

/**
 * Inclusive civil-day count between two `YYYY-MM-DD` dates.
 *
 * ⚠️ `Date.UTC` AND NOT `new Date(iso)`. The latter is parsed in the
 * runtime's local zone for some formats, so a server in Asia/Kolkata and
 * one in UTC would disagree about whether a period contains 31 March —
 * the day the financial year turns on. Same reasoning as
 * `lib/leave/days.ts#inclusiveDayCount`, which this deliberately mirrors
 * rather than imports: `lib/leave/**` is another track's file.
 */
export function inclusiveDays(fromIso: string, toIso: string): number {
  const m1 = /^(\d{4})-(\d{2})-(\d{2})/.exec(fromIso);
  const m2 = /^(\d{4})-(\d{2})-(\d{2})/.exec(toIso);
  if (!m1 || !m2) return 0;
  const a = Date.UTC(Number(m1[1]), Number(m1[2]) - 1, Number(m1[3]));
  const b = Date.UTC(Number(m2[1]), Number(m2[2]) - 1, Number(m2[3]));
  const days = Math.round((b - a) / 86_400_000) + 1;
  return days < 0 ? 0 : days;
}

/**
 * ⭐ WHETHER SOMEBODY SHOULD BE ENROLLED IN A CYCLE AT ALL.
 *
 * ⚠️ THE JOINER AND THE LEAVER ARE BOTH REAL AND THEY FAIL IN OPPOSITE
 * DIRECTIONS. Somebody who joined a fortnight before the period ended
 * has nothing to be reviewed on, and enrolling them produces a rating
 * derived from nothing that follows them for years. Somebody who left
 * DURING the period was there for most of it — and excluding them means
 * the manager's review of the person who actually did the work is never
 * written, which is the record an exit interview and a rehire decision
 * both need.
 *
 * 🔴 SO A LEAVER IS ENROLLED IF THEY OVERLAPPED THE PERIOD AT ALL, and a
 * joiner is enrolled only if they were on the rolls for at least
 * `minDays` of it. The default of 90 is a policy, stated in one place,
 * rather than a rule buried in a query.
 */
export function isEligibleForCycle(
  employee: { joinedOn: string; leftOn: string | null },
  cycle: { periodStart: string; periodEnd: string },
  minDays = 90,
): { eligible: boolean; reason: string } {
  const from = employee.joinedOn > cycle.periodStart ? employee.joinedOn : cycle.periodStart;
  const to =
    employee.leftOn === null || employee.leftOn > cycle.periodEnd
      ? cycle.periodEnd
      : employee.leftOn;
  if (from > to) {
    return { eligible: false, reason: "Not on the rolls during this review period." };
  }
  const days = inclusiveDays(from, to);
  if (days < minDays) {
    return {
      eligible: false,
      reason: `Only ${days} day${days === 1 ? "" : "s"} on the rolls in this period — under the ${minDays}-day floor.`,
    };
  }
  return { eligible: true, reason: `${days} days on the rolls in this period.` };
}
