/**
 * Ordence — ⭐ Turning hours into money
 * Version: v1.2.0-alpha
 *
 * Pure. No database, no clock. Imported by the server actions and by the
 * time-entry form, so the value a person sees while typing and the value
 * that reaches the invoice come out of one function.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 DURATION IS MINUTES, AS AN INTEGER. NEVER HOURS AS A DECIMAL.
 * ══════════════════════════════════════════════════════════════════════
 * A timesheet is hundreds of additions, and
 *
 *     0.1 + 0.1 + 0.1  ===  0.30000000000000004
 *
 * A month of six-minute units accumulates that error into a figure that
 * disagrees with the same month added in a different order. Minutes are
 * exact. The conversion to "2.4 hours" happens once, at the edge, for a
 * human to read — and never on the way back.
 *
 * This is the same rule as money in `lib/billing/money.ts`: the smallest
 * unit, as an integer, always.
 */

/* ------------------------------------------------------------------ */
/* BILLING INCREMENTS                                                  */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE SIX-MINUTE UNIT IS NOT AN ARBITRARY DEFAULT.
 *
 * Legal and professional practice bills in tenths of an hour, so a rate
 * card of ₹8,000/hour is charged as ₹800 per six-minute unit. Seven
 * minutes of work is billed as two units — twelve minutes — because the
 * unit is the thing being sold.
 *
 * ⚠️ ROUNDING UP IS THE CONVENTION AND IT MUST BE STATED, NOT ASSUMED.
 * Rounding to nearest would under-bill roughly half of all entries and
 * a firm would find out at year end. Rounding up is what the engagement
 * letter says; a system that quietly does something else is producing
 * invoices its own terms of business do not support.
 */
export const BILLING_INCREMENTS = {
  /** Tenths of an hour. The legal and accountancy standard. */
  six_minutes: 6,
  /** Quarter-hour. Common in consulting and IT. */
  fifteen_minutes: 15,
  /** Half-hour. Some retainer and advisory work. */
  thirty_minutes: 30,
  /** Bill the exact minutes worked. Used by agencies and support desks. */
  exact: 1,
} as const;

export type BillingIncrement = keyof typeof BILLING_INCREMENTS;

export class TimeBillingError extends Error {}

/**
 * Round worked minutes up to the next whole billing unit.
 *
 * ⚠️ ZERO STAYS ZERO. Rounding 0 up to a full unit would bill for a note
 * somebody made and deleted, and would put a charge on an invoice for
 * work that did not happen.
 */
export function billableMinutes(
  workedMinutes: number,
  increment: BillingIncrement = "six_minutes",
): number {
  if (!Number.isInteger(workedMinutes)) {
    throw new TimeBillingError(
      `Worked minutes must be a whole number, received ${workedMinutes}. Hours as decimals are how a timesheet stops adding up.`,
    );
  }
  if (workedMinutes < 0) {
    throw new TimeBillingError("Worked minutes cannot be negative.");
  }
  if (workedMinutes === 0) return 0;

  const unit = BILLING_INCREMENTS[increment];
  return Math.ceil(workedMinutes / unit) * unit;
}

/**
 * ⭐ What a block of billable minutes is worth, in paise.
 *
 * 🔴 THE ARITHMETIC IS `rate × minutes / 60`, IN THAT ORDER, IN BIGINT.
 *    Dividing first — `rate / 60 * minutes` — throws away the fraction of
 *    a paisa per minute before multiplying it back up, and a full day at
 *    ₹8,000/hour loses several rupees. Multiplying first keeps every
 *    paisa and rounds exactly once, at the end.
 *
 * ⚠️ AND IT ROUNDS HALF UP, DELIBERATELY. `bigint` division truncates
 * toward zero, which would systematically under-bill by up to one paisa
 * on every single entry. Over a year of entries that is a real number
 * and it is always in the client's favour, which is not a defensible
 * place for a rounding rule to sit by accident.
 */
export function timeValueMinor(args: {
  billableMinutes: number;
  rateMinorPerHour: bigint;
}): bigint {
  if (!Number.isInteger(args.billableMinutes) || args.billableMinutes < 0) {
    throw new TimeBillingError("Billable minutes must be a whole, non-negative number.");
  }
  if (args.rateMinorPerHour < 0n) {
    throw new TimeBillingError("An hourly rate cannot be negative.");
  }

  const numerator = args.rateMinorPerHour * BigInt(args.billableMinutes);
  // Round half up: (n + 30) / 60 in integer arithmetic.
  return (numerator + 30n) / 60n;
}

/** Minutes → the "2.4" a human reads. Display only, never fed back in. */
export function minutesToHoursLabel(minutes: number): string {
  const whole = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${whole}:${String(rest).padStart(2, "0")}`;
}

/**
 * "2:30", "2.5", "150m", "2h 30m" → 150 minutes.
 *
 * ⚠️ PEOPLE TYPE TIME FIVE DIFFERENT WAYS AND ALL FIVE ARE REASONABLE.
 * A form that accepts only one produces a timesheet nobody fills in, and
 * an unfilled timesheet is an unbilled month.
 *
 * ⚠️ `2.5` IS TWO AND A HALF HOURS, NOT TWO MINUTES AND FIVE. The decimal
 * form is hours by universal convention on a timesheet, and reading it as
 * anything else would silently bill 1% of the correct amount.
 */
export function parseDuration(input: string): number | null {
  const t = input.trim().toLowerCase();
  if (t === "") return null;

  // 2h 30m · 2h · 45m
  const hm = t.match(/^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?$/);
  if (hm && (hm[1] || hm[2])) {
    return Number(hm[1] ?? 0) * 60 + Number(hm[2] ?? 0);
  }

  // 2:30
  const colon = t.match(/^(\d+):([0-5]\d)$/);
  if (colon) return Number(colon[1]) * 60 + Number(colon[2]);

  // 2.5 → hours. ⚠️ Rounded to a whole minute here, so nothing downstream
  // ever sees a fractional minute.
  const dec = t.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (dec) {
    const hours = Number(dec[1]);
    const frac = dec[2] ? Number(`0.${dec[2]}`) : 0;
    return Math.round((hours + frac) * 60);
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* RATE RESOLUTION                                                     */
/* ------------------------------------------------------------------ */

export type RateRow = {
  id: string;
  userId: string | null;
  roleName: string | null;
  companyId: string | null;
  rateMinor: bigint;
  effectiveFrom: string;
  effectiveTo: string | null;
};

/**
 * ⭐ THE LADDER. Most specific wins:
 *
 *     1. this person, for this client
 *     2. this person, any client
 *     3. this role, for this client
 *     4. this role, any client
 *     5. this client, any person      ← a blended client rate
 *
 * ⚠️ SPECIFICITY BEATS RECENCY, ALWAYS. A house rate set yesterday must
 * not override the rate negotiated with a client in their engagement
 * letter last year. Sorting by date first is the bug that silently
 * re-prices a firm's biggest account.
 */
function specificity(r: RateRow): number {
  if (r.userId && r.companyId) return 5;
  if (r.userId) return 4;
  if (r.roleName && r.companyId) return 3;
  if (r.roleName) return 2;
  if (r.companyId) return 1;
  return 0;
}

/**
 * ⚠️ THE WINDOW IS HALF-OPEN — `[from, to)`. A closed range makes the
 * boundary day belong to two rates, and the resolver would then depend on
 * row order for the one day a year that matters most.
 */
function coversDate(r: RateRow, onDate: string): boolean {
  if (onDate < r.effectiveFrom) return false;
  if (r.effectiveTo !== null && onDate >= r.effectiveTo) return false;
  return true;
}

export type RateResolution =
  | { found: true; rateMinor: bigint; rateId: string; specificity: number }
  | { found: false; reason: string };

/**
 * Which rate applies to this person, for this client, on this date.
 *
 * ⚠️ IT TAKES THE DATE THE WORK WAS DONE, NOT TODAY. Work done in March
 * bills at March's rate even when the invoice is raised in September.
 * Passing today's date is the mistake that re-prices a year of unbilled
 * work the moment somebody edits a rate card.
 *
 * ⚠️ AND "NO RATE" IS AN ANSWER, NOT A ZERO. Returning 0 would put a
 * ₹0.00 line on a client's bill and nobody would query it until the
 * year-end review. Saying so lets the screen ask.
 */
export function resolveRate(args: {
  rates: readonly RateRow[];
  userId: string;
  roleName: string | null;
  companyId: string | null;
  onDate: string;
}): RateResolution {
  const candidates = args.rates
    .filter((r) => coversDate(r, args.onDate))
    .filter((r) => r.userId === null || r.userId === args.userId)
    .filter((r) => r.roleName === null || r.roleName === args.roleName)
    .filter((r) => r.companyId === null || r.companyId === args.companyId);

  if (candidates.length === 0) {
    return {
      found: false,
      reason:
        "No billing rate covers this person, this client and this date. Set one before the time can be billed.",
    };
  }

  /**
   * ⚠️ SPECIFICITY FIRST, THEN THE LATER START DATE AS THE TIE-BREAK.
   * Two rates at the same specificity covering one day is a data problem;
   * taking the later one is the least surprising resolution and is
   * deterministic, which "whichever the database returned first" is not.
   */
  const best = [...candidates].sort((a, b) => {
    const s = specificity(b) - specificity(a);
    if (s !== 0) return s;
    return a.effectiveFrom < b.effectiveFrom ? 1 : -1;
  })[0];

  if (!best) {
    return { found: false, reason: "No billing rate applies." };
  }

  return {
    found: true,
    rateMinor: best.rateMinor,
    rateId: best.id,
    specificity: specificity(best),
  };
}

/* ------------------------------------------------------------------ */
/* WHAT IS UNBILLED                                                    */
/* ------------------------------------------------------------------ */

export type UnbilledEntry = {
  id: string;
  isBillable: boolean;
  status: string;
  billableMinutes: number;
  valueMinor: bigint;
};

/**
 * ⭐ WHAT IS SITTING THERE, UNBILLED — the number a practice lives on.
 *
 * ⚠️ APPROVED AND UNAPPROVED ARE REPORTED SEPARATELY, NEVER SUMMED.
 * Approved time is money the firm can invoice this week. Unapproved time
 * is a claim a partner has not yet stood behind, and some of it will be
 * written down. One combined figure is the number that makes a practice
 * think it is richer than it is.
 *
 * ⚠️ NON-BILLABLE TIME IS COUNTED IN MINUTES AND CARRIES NO VALUE. It is
 * the most important number on the page for a different reason: it is
 * what the firm is giving away.
 */
export function summariseUnbilled(entries: readonly UnbilledEntry[]) {
  let approvedMinutes = 0;
  let approvedValueMinor = 0n;
  let pendingMinutes = 0;
  let pendingValueMinor = 0n;
  let nonBillableMinutes = 0;

  for (const e of entries) {
    if (!e.isBillable) {
      nonBillableMinutes += e.billableMinutes > 0 ? e.billableMinutes : 0;
      continue;
    }
    if (e.status === "approved") {
      approvedMinutes += e.billableMinutes;
      approvedValueMinor += e.valueMinor;
    } else if (e.status === "draft" || e.status === "submitted") {
      pendingMinutes += e.billableMinutes;
      pendingValueMinor += e.valueMinor;
    }
  }

  return {
    approvedMinutes,
    approvedValueMinor,
    pendingMinutes,
    pendingValueMinor,
    nonBillableMinutes,
    /** ⚠️ Reported, never used as "what we can bill". */
    totalMinutes: approvedMinutes + pendingMinutes + nonBillableMinutes,
  };
}

/**
 * ⚠️ REALISATION IS THE NUMBER A PRACTICE IS ACTUALLY JUDGED ON —
 * billable minutes as a share of all minutes recorded. Returned as a
 * whole percentage; `null` when nothing has been recorded, because a
 * practice with no timesheets has no realisation rate, not a rate of
 * zero.
 */
export function realisationPercent(args: {
  billableMinutes: number;
  totalMinutes: number;
}): number | null {
  if (args.totalMinutes <= 0) return null;
  return Math.round((args.billableMinutes / args.totalMinutes) * 100);
}
