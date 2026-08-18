/**
 * Ordence — ⭐⭐⭐ WHICH NEW WORKSPACE HAS STALLED, WHILE IT CAN STILL BE SAVED
 * Version: v1.52.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 NO `import "server-only"` HERE, AND THAT IS THE WHOLE REASON THIS
 *    FILE IS SEPARATE FROM `server/platform/onboarding.ts`
 * ══════════════════════════════════════════════════════════════════════
 * The table renders in the browser and the badge above it renders in the
 * browser. If the stall rule lived in the server module, the client would
 * need its own copy — and a badge saying "6 stalled" over a table showing
 * eight rows is the exact failure this file exists to make impossible.
 * Everything here is pure: values in, values out, no request, no clock of
 * its own (`now` is always passed in).
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE STEPS ARE NOT INVENTED — THEY ARE READ OFF `server/actions/onboarding.ts`
 * ══════════════════════════════════════════════════════════════════════
 * That file is the only thing that ever writes `settings.onboardingStep`,
 * and it writes the number of the step the customer is ABOUT to do:
 *
 *   saveOrganizationDetails() → onboardingStep = 2
 *   saveFiscalPreferences()   → onboardingStep = 3
 *   saveIndustrySelection()   → onboardingStep = 4
 *   completeOnboarding()      → onboardedAt set, onboardingStep = null
 *
 * ⚠️ SO A WORKSPACE THAT HAS DONE NOTHING HAS NO `onboardingStep` AT ALL.
 * A provisioned tenant's `settings` is `{ industry, provisionedBy }` (see
 * `server/platform/provisioning.ts`) — absent is step 1, not step 0 and
 * not "unknown". Reading absent as anything else silently hides the
 * workspaces that never started, which are the worst ones on the list.
 */

/** The step a customer is being asked to do, 1-based. */
export type OnboardingStep = {
  /** The value that appears in `settings.onboardingStep`. */
  readonly number: number;
  readonly label: string;
  /**
   * The action in `server/actions/onboarding.ts` that COMPLETES this step
   * and advances the counter. Named so a reader can check this table
   * against the source of truth without guessing.
   */
  readonly completedBy: string;
  /** What an operator says on the phone to unblock it. */
  readonly blocker: string;
};

/**
 * ⚠️ `as const satisfies` AND NOT A PLAIN `readonly OnboardingStep[]`.
 * Under `noUncheckedIndexedAccess` an array index is `T | undefined`, so
 * the first-step fallback below would need a non-null assertion. A tuple
 * type makes the fallback provably safe instead of asserted safe, and
 * `satisfies` still type-checks every entry against `OnboardingStep`.
 */
export const ONBOARDING_STEPS = [
  {
    number: 1,
    label: "Organisation details",
    completedBy: "saveOrganizationDetails",
    blocker: "Legal name, GSTIN and registered address — usually waiting on their accountant.",
  },
  {
    number: 2,
    label: "Fiscal preferences",
    completedBy: "saveFiscalPreferences",
    blocker: "Fiscal year start, currency, timezone. Thirty seconds of work; they have simply left.",
  },
  {
    number: 3,
    label: "Industry selection",
    completedBy: "saveIndustrySelection",
    blocker: "One dropdown. A workspace parked here has stopped opening the tab, not stopped deciding.",
  },
  {
    number: 4,
    label: "Confirm and finish",
    completedBy: "completeOnboarding",
    blocker: "Everything is filled in and nobody pressed the last button. The cheapest call on this page.",
  },
] as const satisfies readonly OnboardingStep[];

export const ONBOARDING_TOTAL_STEPS = ONBOARDING_STEPS.length;

/**
 * ⚠️ ABSENT MEANS STEP 1. See the header. A number outside the wizard's
 * range is clamped rather than shown, because a corrupted counter should
 * put the workspace on the list, not off it.
 */
export function currentStepNumber(rawStep: number | null | undefined): number {
  if (typeof rawStep !== "number" || !Number.isFinite(rawStep)) return 1;
  if (rawStep < 1) return 1;
  if (rawStep > ONBOARDING_TOTAL_STEPS) return ONBOARDING_TOTAL_STEPS;
  return Math.floor(rawStep);
}

export function stepLabel(stepNumber: number): string {
  const step = ONBOARDING_STEPS.find((s) => s.number === currentStepNumber(stepNumber));
  return step ? step.label : ONBOARDING_STEPS[0].label;
}

export function stepBlocker(stepNumber: number): string {
  const step = ONBOARDING_STEPS.find((s) => s.number === currentStepNumber(stepNumber));
  return step ? step.blocker : ONBOARDING_STEPS[0].blocker;
}

/**
 * Steps FINISHED, which is one less than the step they are sitting on.
 * Somebody on step 3 has done two of four, not three of four, and telling
 * an operator otherwise makes the list look healthier than it is.
 */
export function stepsComplete(stepNumber: number): number {
  return currentStepNumber(stepNumber) - 1;
}

/* ================================================================== */
/* ⭐⭐⭐ "STALLED" — ONE DEFINITION, DEFENDED                          */
/* ================================================================== */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE DEFINITION
 * ══════════════════════════════════════════════════════════════════════
 * A workspace is STALLED when it has not finished onboarding and at least
 * THREE WHOLE DAYS have passed since the last step it completed (or,
 * where it has completed nothing, since it was created).
 *
 * ⚠️ WHY THREE AND NOT ONE, AND NOT SEVEN.
 *
 *   • The wizard is four screens and about ten minutes of typing. Nothing
 *     in it is work a customer goes away and comes back for, except the
 *     GSTIN on step 1, which they may have to ask their accountant for.
 *
 *   • ONE DAY IS NOISE. Somebody who starts at 18:00 and finishes the
 *     next morning is a normal customer, not a rescue. A list that shouts
 *     at every overnight gap is a list operators stop opening, and the
 *     nine-day workspace then dies inside a screen nobody reads.
 *
 *   • THREE SURVIVES A WEEKEND, WHICH IS THE CASE THAT MATTERS IN INDIA
 *     AND EVERYWHERE ELSE. A workspace whose owner did step 2 on Friday
 *     afternoon and comes back Monday morning has a gap of roughly 2.7
 *     days, which floors to 2 and is NOT flagged. Move the threshold to
 *     two and every Friday-afternoon signup in the country appears on
 *     Monday's list as an emergency.
 *
 *   • SEVEN IS TOO LATE. By day seven the person who signed up has been
 *     back at their real job for a week, the trial clock has burned a
 *     quarter of itself, and the phone call has changed from "shall I
 *     walk you through it" to "do you still want this". The point of the
 *     screen is the window in which a call still works.
 *
 * 🔴 WHOLE DAYS, FLOORED, NEVER ROUNDED. 2.9 days is 2. Rounding would
 * push the Friday-afternoon case above to 3 and undo the paragraph above.
 *
 * ⭐ EVERY CONSUMER GOES THROUGH `isStalled` — the table's row badge, the
 * table's default filter and `countStalled` for the header. There is no
 * second comparison against `STALL_THRESHOLD_DAYS` anywhere, so a badge
 * and a table cannot disagree. `tests/ui/onboarding-progress.test.ts`
 * asserts that as a property over generated rows rather than trusting it.
 */
export const STALL_THRESHOLD_DAYS = 3;

const MS_PER_DAY = 86_400_000;

/**
 * Whole days between an instant and `now`, floored at zero.
 *
 * ⚠️ A CLOCK IS NEVER READ IN HERE. `now` is a parameter so the same
 * function is testable, and so that every row on one render is measured
 * against ONE instant — rows measured against `Date.now()` each can put a
 * row above and below the threshold in the same table.
 */
export function daysSince(isoInstant: string | null | undefined, now: Date): number {
  if (!isoInstant) return 0;
  const then = new Date(isoInstant).getTime();
  if (!Number.isFinite(then)) return 0;
  const days = Math.floor((now.getTime() - then) / MS_PER_DAY);
  return days > 0 ? days : 0;
}

/**
 * One workspace still inside the wizard.
 *
 * ⚠️ `daysSinceProgress` is precomputed on the server against a single
 * `now`, so the browser is not re-deriving ages from timestamps on every
 * render and drifting away from the number the SQL ordered by.
 */
export type OnboardingProgressRow = {
  tenantId: string;
  slug: string;
  name: string;
  status: string;
  planTier: string;
  /** 1..ONBOARDING_TOTAL_STEPS. See `currentStepNumber`. */
  currentStep: number;
  /** ISO. The last completed step, or the workspace's creation. */
  lastProgressAt: string;
  /** True when the workspace has never completed a single step. */
  neverStarted: boolean;
  /** ⭐ THE PRIMARY NUMBER ON THE SCREEN. */
  daysSinceProgress: number;
  createdAt: string;
  trialEndsAt: string | null;
  /** Who to ring. Null when the workspace has no user record at all. */
  contactEmail: string | null;
  contactName: string | null;
  /** `invited` | `active` | … straight off `users.status`. */
  contactStatus: string | null;
};

/**
 * 🔴 THE ONE DEFINITION. Nothing else in the codebase may compare against
 * `STALL_THRESHOLD_DAYS` directly.
 */
export function isStalled(row: Pick<OnboardingProgressRow, "daysSinceProgress">): boolean {
  return row.daysSinceProgress >= STALL_THRESHOLD_DAYS;
}

/** ⭐ The header badge. Same predicate as every row, by construction. */
export function countStalled(
  rows: readonly Pick<OnboardingProgressRow, "daysSinceProgress">[],
): number {
  let n = 0;
  for (const row of rows) if (isStalled(row)) n += 1;
  return n;
}

/**
 * ⭐ STALLED FIRST, NOT NEWEST FIRST. The screen's job is to put the
 * rescuable churn at the top; a chronological list buries the nine-day
 * workspace under six that signed up this morning and are fine.
 *
 * Ties break on the earlier creation date, so the order is TOTAL and two
 * workspaces stalled the same number of days cannot swap between renders.
 */
export function byStalledFirst(a: OnboardingProgressRow, b: OnboardingProgressRow): number {
  if (a.daysSinceProgress !== b.daysSinceProgress) {
    return b.daysSinceProgress - a.daysSinceProgress;
  }
  return a.createdAt.localeCompare(b.createdAt);
}

/**
 * ⚠️ EVERY STATE ON THIS SCREEN CARRIES A WORD. Roughly one in twelve
 * Indian men is colour-blind; a red row and an amber row are the same row
 * to them, and "Stalled" versus "Moving" is not.
 */
export function stallWord(row: Pick<OnboardingProgressRow, "daysSinceProgress">): string {
  return isStalled(row) ? "Stalled" : "Moving";
}

/* ================================================================== */
/* 🔴 THE INVITE BUTTON, AND WHY IT IS OFF                             */
/* ================================================================== */

/**
 * ⚠️ THERE IS NO RESEND MECHANISM IN THIS BUILD, AND THE HONEST THING IS
 * TO SAY SO ON THE BUTTON RATHER THAN TO BUILD ONE THAT LOOKS LIKE IT
 * WORKED.
 *
 * `server/platform/provisioning.ts` returns the owner invitation in its
 * `pending[]` list — "Create the Clerk organisation and invite … as
 * owner" — because it is carried out by a human after provisioning. There
 * is no invitation table, no Clerk organisation-invitation call anywhere
 * in the repository, and `lib/email/resend.ts` sends exactly two
 * templates, neither of them an invitation.
 *
 * 🔴 SO A "RESEND INVITE" BUTTON WIRED TO AN AUDIT WRITE WOULD BE A LIE
 * WITH A RECEIPT: the operator clicks, the action register records a
 * resend, and the customer's inbox stays empty. A disabled button with
 * this sentence under it costs the operator one read and never costs a
 * customer a week.
 *
 * ⭐ Exported as a constant so the button's tooltip and the page's own
 * explanation are the same string — the same rule as `isStalled`.
 */
export const RESEND_INVITE_UNAVAILABLE_REASON =
  "No invite can be sent from here: this build has no invitation record and no invite email. " +
  "Provisioning hands the owner invitation to a person (see the pending list on Provision). " +
  "Use “Mark for a call” — it is logged — and issue the invite in Clerk.";

/* ================================================================== */
/* ⭐⭐⭐ "COMPLETED ONBOARDING" — ONE DEFINITION, DEFENDED             */
/* ================================================================== */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE COMPLETION MARKER IS `settings.onboardedAt`, AND NOTHING ELSE.
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ NOT `onboardingStep IS NULL`. `completeOnboarding()` sets the step
 * counter back to NULL as its last act, so "no step" is true BOTH for a
 * workspace that finished and for one that never opened the wizard —
 * exactly the two populations a cohort report exists to tell apart.
 * Reading the step counter would score every abandoned signup as a
 * success and make onboarding look like it is getting better while it is
 * getting worse.
 *
 * ⚠️ IT LIVES HERE, BESIDE `isStalled`, BECAUSE THE COHORT SCREEN IS THE
 * SECOND READER. `server/platform/onboarding.ts` asks the same question
 * in SQL (`settings ->> 'onboardedAt' IS NULL`) and now spells the key
 * with `ONBOARDING_COMPLETED_AT_KEY` rather than a literal, so the SQL
 * and the TypeScript cannot drift the way the two reserved-slug lists in
 * `lib/slug.ts` and `server/platform/provisioning.ts` did — eight names
 * apart in each direction, and nothing noticed for months.
 */
export const ONBOARDING_COMPLETED_AT_KEY = "onboardedAt";

/**
 * The instant onboarding finished, or null.
 *
 * ⚠️ TAKES `unknown` ON PURPOSE. `tenants.settings` is a `jsonb` column:
 * whatever TypeScript says, the value on the row is whatever was written
 * to it, including `null`, a string, or an object with the key holding a
 * number. A predicate over customer-written JSON that assumes a shape is
 * a predicate that throws on the one row that matters.
 */
export function completedOnboardingAt(settings: unknown): string | null {
  if (typeof settings !== "object" || settings === null) return null;
  const raw = (settings as Record<string, unknown>)[ONBOARDING_COMPLETED_AT_KEY];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  // An unparseable timestamp is NOT completion. It is a corrupted row,
  // and counting it as a success would inflate the very number the
  // cohort screen is read to check.
  return Number.isFinite(new Date(trimmed).getTime()) ? trimmed : null;
}

/**
 * 🔴 THE ONE DEFINITION. Nothing else in the codebase may decide for
 * itself what "completed onboarding" means — the cohort table, its
 * denominator and its median all go through this function, so a cohort
 * whose completion count and completion rate disagree is unbuildable.
 */
export function hasCompletedOnboarding(settings: unknown): boolean {
  return completedOnboardingAt(settings) !== null;
}
