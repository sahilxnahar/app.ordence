/**
 * Ordence — ⭐⭐⭐ GRATUITY UNDER THE PAYMENT OF GRATUITY ACT, 1972
 * Version: v1.46.0-alpha
 *
 * Pure. No database, no network, no clock, no `server-only`. Every date
 * and every rate arrives as an argument, exactly as
 * `lib/payroll/statutory.ts` does, so the whole of this file can be
 * checked by hand against the bare Act.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THIS IS A STATUTORY ENTITLEMENT, NOT A COMPANY BENEFIT
 * ══════════════════════════════════════════════════════════════════════
 * An employee who qualifies is owed the money whether or not the
 * employer agrees, whether or not it was in the offer letter, and
 * whether or not anybody remembers to run the calculation. Section 4(1)
 * says "shall be payable".
 *
 * ⚠️ AND THE PERSON THIS IS COMPUTED FOR HAS ALREADY LEFT. They have no
 * access to the system, no colleague checking the arithmetic for them,
 * and — for the death and disablement cases below — often nobody who
 * knows the Act at all. Every other number in payroll gets argued about
 * in the next month's payslip. This one does not get a second look, so
 * the failure mode is silent underpayment of somebody who cannot argue.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS FILE REFUSES TO DECIDE, ON PURPOSE
 * ══════════════════════════════════════════════════════════════════════
 * ① INCOME TAX ON GRATUITY IS NOT COMPUTED HERE. Section 10(10) of the
 *   Income-tax Act, 1961 exempts gratuity up to a limit that depends on
 *   whether the employee is covered by this Act, on the aggregate of
 *   exemptions already claimed from PREVIOUS employers over a lifetime,
 *   and — for the uncovered case — on a ten-month average salary. None
 *   of that machinery exists anywhere in Ordence: `projectMonthlyTds`
 *   knows about slabs, the standard deduction and the rebate, and
 *   nothing else. So `taxTreatment` below is the literal string
 *   "not_computed" and every result says so in words. Half-implementing
 *   a lifetime aggregate would produce a confident number that is wrong
 *   for exactly the employees who have changed jobs before.
 *
 * ② WHETHER SERVICE WAS "CONTINUOUS" under s.2A is an HR determination
 *   made against the attendance register (the 240-day / 190-day tests),
 *   not something derivable from a joining date and an exit date. This
 *   file does plain calendar arithmetic and exposes the assumption.
 *
 * ③ FORFEITURE under s.4(6) is never inferred. It requires a stated
 *   amount and a stated ground, and the amount is capped at the damage.
 *
 * Everything uncertain is an argument with a comment naming who has to
 * confirm it. A stated gap beats a confident guess.
 */

import {
  pickEffective,
  roundToRupee,
  type EffectiveDated,
  type Paise,
} from "./statutory";

/* ------------------------------------------------------------------ */
/* THE RULES — DATA, NEVER CONSTANTS                                   */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐ NOT ONE NUMBER OF THE ACT IS COMPILED INTO THIS FILE.
 *
 * 🔴 THE CEILING IN s.4(3) HAS ALREADY MOVED TWICE — ₹3.5 lakh, then
 * ₹10 lakh from 24 May 2010, then ₹20 lakh from 29 March 2018 (notified
 * under the Payment of Gratuity (Amendment) Act, 2018, which moved the
 * ceiling out of the statute and into a notification precisely so it
 * could be changed again without Parliament). A hard-coded ₹20,00,000
 * is a bug with a delay fuse: it is right until the notification, and
 * then it is wrong for every exit AND it retrospectively restates every
 * settlement anybody reopens.
 *
 * ⚠️ SO THE ROW IS SELECTED ON THE DATE THE GRATUITY BECAME PAYABLE —
 * the date of termination — and NOT on today's date. An employee who
 * left in 2017 is owed the 2017 ceiling however long the paperwork sat
 * in a drawer.
 *
 * Today's numbers, in a comment so that nobody edits code when they
 * change:
 *   ceiling ₹20,00,000 · 15 days' wages per completed year · divisor 26
 *   · 7 days' wages per season · 5 years' continuous service
 */
export interface GratuityRules extends EffectiveDated {
  /**
   * Paise. s.4(3) — the maximum STATUTORY entitlement.
   * 🔴 Read the note on `exGratiaMinor` below before treating this as a
   * cap on what the employer may pay. It is not one.
   */
  readonly ceilingMinor: string;
  /** s.4(2) — "fifteen days' wages" for every completed year. */
  readonly daysWagesPerCompletedYear: number;
  /**
   * s.4(2) Explanation — for a MONTHLY RATED employee the fifteen days'
   * wages are the monthly rate divided by twenty-six, times fifteen.
   * ⚠️ Twenty-six, not thirty: the Act deems four days a month to be
   * paid holidays. A divisor of 30 shrinks every daily wage by ~13%.
   */
  readonly monthlyWageDivisorDays: number;
  /** s.4(2) second proviso — seasonal establishments, per season. */
  readonly seasonalDaysWagesPerSeason: number;
  /**
   * s.4(1) — years of continuous service before the entitlement arises.
   * ⚠️ DATA BECAUSE IT IS ALREADY UNDER LEGISLATIVE CHANGE: s.53 of the
   * Code on Social Security, 2020 gives fixed-term employees pro-rata
   * gratuity with no five-year qualification. The Code is not in force
   * as this is written; when it is notified this becomes a new row and
   * not a new deploy.
   */
  readonly minimumContinuousYears: number;
  /**
   * s.7(3A) — simple interest where gratuity is not paid within the
   * thirty days s.7(3) allows.
   * 🔴 NULL MEANS "NOT CONFIGURED, SO NOT COMPUTED", and the result says
   * so. The rate is the one notified by the Central Government for
   * repayment of long-term deposits, it is not a number this file is
   * entitled to invent, and interest that is silently zero reads as
   * "nothing is owed" to whoever signs the settlement.
   */
  readonly delayInterestRateBpPerAnnum: number | null;
}

/** s.7(3) — gratuity is payable within thirty days of becoming payable. */
export const PAYMENT_DUE_DAYS = 30;

/* ------------------------------------------------------------------ */
/* WHAT ENDED THE EMPLOYMENT                                           */
/* ------------------------------------------------------------------ */

/**
 * 🔴🔴 THE TWO CAUSES THAT WAIVE THE FIVE-YEAR RULE ARE THE WHOLE REASON
 * THIS IS AN ENUM AND NOT A BOOLEAN.
 *
 * The proviso to s.4(1) is one sentence: "Provided that the completion
 * of continuous service of five years shall not be necessary where the
 * termination of the employment of any employee is due to death or
 * disablement."
 *
 * ⚠️ A SYSTEM THAT REFUSES A DEATH CLAIM BECAUSE OF THE FIVE-YEAR RULE
 * IS THE WORST FAILURE THIS FEATURE HAS. The family of somebody who
 * died in their third year is owed gratuity, they are frequently the
 * least equipped party in the whole transaction to challenge a payroll
 * screen, and the refusal looks exactly like a correct refusal.
 *
 * "disablement" is incapacity for the work the employee was capable of
 * performing before the accident or disease that caused it — s.2. It is
 * a medical determination the caller supplies; this file does not
 * grade it.
 */
export type TerminationCause =
  | "superannuation"
  | "retirement"
  | "resignation"
  | "termination_by_employer"
  | "death"
  | "disablement";

/** ⭐ The two causes the proviso to s.4(1) names, in one place. */
export function waivesMinimumService(cause: TerminationCause): boolean {
  return cause === "death" || cause === "disablement";
}

/* ------------------------------------------------------------------ */
/* THE ESTABLISHMENT, WHICH CHANGES THE FORMULA                        */
/* ------------------------------------------------------------------ */

/**
 * ⚠️⚠️ ONE RULE SILENTLY APPLIED TO EVERYBODY IS THE MISTAKE THIS UNION
 * EXISTS TO PREVENT. Section 4(2) has a main limb and two provisos, and
 * they are three different sums:
 *
 *   • MONTHLY RATED, non-seasonal — Explanation to s.4(2):
 *       monthly wages ÷ 26 × 15 × completed years
 *
 *   • PIECE RATED — first proviso to s.4(2): daily wages are the average
 *     of the total wages of the three months immediately preceding the
 *     termination, EXCLUDING overtime. 🔴 THE DIVISOR IN THAT AVERAGE IS
 *     NOT SETTLED — 90 calendar days, 78 (26 × 3), or days actually
 *     worked, all appear in practice and in commentary. This file
 *     therefore REFUSES TO DERIVE IT and takes the daily wage as an
 *     input. Naming the divisor here would be a guess dressed as an
 *     implementation. ⚠️ A CA or the establishment's counsel must fix
 *     the convention before this branch is used.
 *
 *   • SEASONAL and not employed throughout the year — second proviso to
 *     s.4(2): seven days' wages for EACH SEASON. Not fifteen, and per
 *     season rather than per year. An employee of a seasonal
 *     establishment who IS employed throughout the year falls back to
 *     the main limb, which is why the discriminator says
 *     `seasonal_not_year_round` rather than "seasonal".
 */
export type GratuityWageBasis =
  | {
      readonly kind: "monthly_rated";
      /**
       * 🔴 "WAGES" IS s.2(s) AND IT IS NOT GROSS PAY. It is all
       * emoluments earned while on duty INCLUDING dearness allowance,
       * and it EXCLUDES bonus, commission, house rent allowance,
       * overtime and every other allowance. In practice: basic + DA.
       * ⚠️ Passing the gross here overpays by roughly half, which no
       * employee will ever report, and which an audit will.
       */
      readonly monthlyWagesMinor: string;
    }
  | {
      readonly kind: "piece_rated";
      /** Paise per day, computed per the first proviso — see above. */
      readonly dailyWagesMinor: string;
      /** ⭐ Recorded so the settlement can show how it was arrived at. */
      readonly averagingNote: string;
    }
  | {
      readonly kind: "seasonal_not_year_round";
      readonly dailyWagesMinor: string;
      /** Seasons worked. The second proviso counts seasons, not years. */
      readonly seasons: number;
    };

/**
 * ⭐ THE DEFAULT, STATED OUT LOUD RATHER THAN ASSUMED.
 *
 * Every caller that does not know the establishment type uses
 * `monthly_rated` — the main limb of s.4(2) with the 26-day divisor —
 * because that is what the overwhelming majority of Ordence tenants are
 * (offices, factories and shops with monthly salaried staff) and
 * because it is the branch that is safe to apply by default: it is the
 * one the Explanation to s.4(2) writes out in full.
 *
 * 🔴 IT IS STILL A DEFAULT AND NOT A CERTAINTY. `basisApplied` is on
 * every result and the settlement prints it, so a seasonal
 * establishment sees the wrong rule named rather than quietly applied.
 */
export const DEFAULT_ESTABLISHMENT_BASIS = "monthly_rated" as const;

/* ------------------------------------------------------------------ */
/* FORFEITURE — s.4(6)                                                 */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ FORFEITURE IS NARROW, IT IS THE EMPLOYER'S CASE TO MAKE, AND IT IS
 * NEVER INFERRED FROM THE TERMINATION CAUSE.
 *
 *   s.4(6)(a) — damage or loss to, or destruction of, the employer's
 *     property caused by the employee's wilful omission or negligence:
 *     forfeiture TO THE EXTENT OF THE DAMAGE, and no further.
 *   s.4(6)(b) — services terminated for riotous or disorderly conduct
 *     or any act of violence, or for an offence involving moral
 *     turpitude committed in the course of employment: gratuity may be
 *     forfeited wholly or partially.
 *
 * 🔴 BOTH LIMBS REQUIRE THE AMOUNT TO BE STATED BY A HUMAN. Under (a)
 * it is capped by the damage, which this file cannot know; under (b) it
 * is discretionary and the courts require the termination to have
 * actually been for that ground. So an omitted amount produces a
 * problem, not a zero and not a guess.
 */
export interface GratuityForfeiture {
  readonly ground: "damage_or_loss" | "riotous_conduct_or_moral_turpitude";
  /** Paise. Null means "the employer has not stated one" — a problem. */
  readonly amountMinor: string | null;
  /** ⭐ The show-cause reference. A settlement without it is indefensible. */
  readonly reference: string;
}

/* ------------------------------------------------------------------ */
/* SERVICE — WHERE THE ROUNDING IS THE MONEY                           */
/* ------------------------------------------------------------------ */

export interface ServiceSpan {
  /** Whole years from joining to the day after the last working day. */
  readonly completedYears: number;
  /** ⭐ The date the final, incomplete year started. */
  readonly finalYearStartsOn: string;
  /** ⭐ The instant "six months" lands on. Beyond it, the year counts. */
  readonly sixMonthMarkOn: string;
  /** True when the final part-year was long enough to count. */
  readonly finalPartYearCounts: boolean;
  /** 🔴 What the money is multiplied by. Never used for ELIGIBILITY. */
  readonly qualifyingYears: number;
  /** Calendar days of service, last working day included. */
  readonly serviceDays: number;
}

export interface GratuityResult {
  readonly eligible: boolean;
  readonly service: ServiceSpan;
  readonly basisApplied: GratuityWageBasis["kind"];
  readonly rulesEffectiveFrom: string | null;
  /**
   * ⭐ THE ARITHMETIC, SHOWN. Fifteen days' wages, as the settlement
   * letter states it. ⚠️ The total is NOT this multiplied by the years:
   * the division happens once, at the end, so that a repeating decimal
   * (₹45,000 ÷ 26 recurs) is not rounded five times over.
   */
  readonly wagesPerCompletedYearMinor: Paise;
  readonly entitlementBeforeCeilingMinor: Paise;
  readonly ceilingMinor: Paise;
  readonly ceilingApplied: boolean;
  /** 🔴 s.4(3). The statutory figure, and nothing else. */
  readonly statutoryEntitlementMinor: Paise;
  readonly forfeitedMinor: Paise;
  /** What the Act obliges the employer to pay, after any s.4(6) cut. */
  readonly statutoryPayableMinor: Paise;
  /**
   * 🔴🔴 THE EXCESS THE EMPLOYER CHOOSES TO PAY, MODELLED SEPARATELY AND
   * NEVER FOLDED INTO THE STATUTORY FIGURE.
   *
   * s.4(5): "Nothing in this section shall affect the right of an
   * employee to receive better terms of gratuity under any award or
   * agreement or contract with the employer." The ceiling in s.4(3)
   * caps the ENTITLEMENT the Act creates; it does not make a larger
   * payment unlawful, and employers with better contractual terms make
   * them routinely.
   *
   * ⚠️ AND THE TWO ARE TAXED DIFFERENTLY, which is the practical reason
   * they must never be one number: the s.10(10) exemption attaches to
   * the statutory computation, and the excess is salary. Conflating
   * them destroys the only information Form 16 needs.
   */
  readonly exGratiaMinor: Paise;
  readonly totalPayableMinor: Paise;
  /** s.7(3) — thirty days from the date it became payable. */
  readonly payableByOn: string | null;
  /** 🔴 See the file header. Income tax on this is NOT computed. */
  readonly taxTreatment: "not_computed";
  readonly notes: readonly string[];
  /** 🔴 Non-empty means no settlement may be issued from this result. */
  readonly problems: readonly string[];
}

export interface GratuityArgs {
  readonly joinedOn: string;
  /**
   * The last working day. ⭐ INCLUSIVE: the day is served and paid, so
   * somebody who joined on 1 Jan 2015 and left on 31 Dec 2019 has
   * exactly five years, not five years less a day. Stated because the
   * other convention exists and disagrees by one day at every boundary.
   */
  readonly exitOn: string;
  readonly cause: TerminationCause;
  readonly basis: GratuityWageBasis;
  /**
   * 🔴 THE WHOLE HISTORY, NOT THE CURRENT ROW. The row in force on
   * `exitOn` is selected here, so reopening a 2016 settlement in 2026
   * produces the 2016 number.
   */
  readonly rulesHistory: readonly GratuityRules[];
  /**
   * ⚠️ THE MADRAS HIGH COURT POSITION, AND IT IS NOT SETTLED LAW.
   * `Mettur Beardsell Ltd. v. Regional Labour Commissioner` reads s.2A
   * with s.4(1) to mean that 4 years and 240 days is five years of
   * continuous service. Other High Courts have not followed it and the
   * Supreme Court has not ruled. It is therefore an explicit assertion
   * by whoever has read the attendance register, defaulting to off, and
   * 🔴 A CA OR THE ESTABLISHMENT'S COUNSEL MUST CONFIRM IT BEFORE IT IS
   * TURNED ON. Ordence will not decide a disputed question of law by
   * choosing a default.
   */
  readonly fifthYearQualifiesUnderSection2A?: boolean;
  /**
   * ⭐ An explicit waiver of the qualifying period with a stated reason —
   * the route for a fixed-term employee once s.53 of the Code on Social
   * Security, 2020 is notified, or for a settlement/award. Null is the
   * normal case. It never suppresses a problem silently: the reason is
   * printed on the result.
   */
  readonly minimumServiceWaivedBecause?: string | null;
  readonly forfeiture?: GratuityForfeiture | null;
  /**
   * The total the employer intends to pay, when it is more than the
   * statutory figure. Null means "pay the statutory figure".
   */
  readonly employerProposedTotalMinor?: string | null;
}

/* ------------------------------------------------------------------ */
/* CALENDAR ARITHMETIC — INTEGERS ONLY                                 */
/* ------------------------------------------------------------------ */

interface Ymd {
  readonly y: number;
  readonly m: number;
  readonly d: number;
}

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y: number, m: number): number {
  if (m === 2) return isLeap(y) ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function parseIsoDate(iso: string): Ymd | null {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (parts === null) return null;
  // 🔴 `noUncheckedIndexedAccess` — a regex group is `string | undefined`
  // even when the pattern guarantees it, and `Number(undefined)` is NaN.
  const [, ys, ms, ds] = parts;
  if (ys === undefined || ms === undefined || ds === undefined) return null;
  const y = Number(ys);
  const m = Number(ms);
  const d = Number(ds);
  if (m < 1 || m > 12) return null;
  if (d < 1 || d > daysInMonth(y, m)) return null;
  return { y, m, d };
}

function formatIsoDate(v: Ymd): string {
  const mm = v.m < 10 ? `0${v.m}` : `${v.m}`;
  const dd = v.d < 10 ? `0${v.d}` : `${v.d}`;
  return `${v.y}-${mm}-${dd}`;
}

/** Days since the epoch. Integers throughout; no time zone anywhere. */
function epochDay(v: Ymd): number {
  return Date.UTC(v.y, v.m - 1, v.d) / 86_400_000;
}

function fromEpochDay(day: number): Ymd {
  const at = new Date(day * 86_400_000);
  return { y: at.getUTCFullYear(), m: at.getUTCMonth() + 1, d: at.getUTCDate() };
}

function addDays(v: Ymd, days: number): Ymd {
  return fromEpochDay(epochDay(v) + days);
}

/**
 * ⚠️ MONTH ARITHMETIC CLAMPS THE DAY, and it has to: the six-month mark
 * from 31 August is 28 or 29 February, because there is no 31 February.
 * Overflowing into March instead would move the boundary by three days
 * in the employee's disfavour once every year they could have joined on
 * the 29th, 30th or 31st.
 */
function addMonthsClamped(v: Ymd, months: number): Ymd {
  const total = v.y * 12 + (v.m - 1) + months;
  const y = Math.floor(total / 12);
  const m = total - y * 12 + 1;
  const d = Math.min(v.d, daysInMonth(y, m));
  return { y, m, d };
}

/**
 * ⭐⭐ THE SERVICE SPAN, AND THE SIX-MONTH BOUNDARY THAT DECIDES A YEAR
 * OF SOMEBODY'S MONEY.
 *
 * s.4(2): "For every completed year of service OR PART THEREOF IN
 * EXCESS OF SIX MONTHS". Two consequences, and they are opposite:
 *
 *   🔴 IN EXCESS OF six months counts as a whole year. Six months and
 *     one day is a year's wages.
 *   🔴 EXACTLY six months does NOT. "In excess of" is not "at least",
 *     and an implementation using `>=` overpays every employee whose
 *     final part-year lands precisely on the mark — rare, but it is a
 *     silent overpayment the auditor finds, not the employee.
 *
 * ⚠️ AND THIS ROUNDING IS FOR THE QUANTUM ONLY. Section 4(1) requires
 * five years of continuous service before anything is payable at all,
 * and it has no rounding in it. Four years and seven months rounds to
 * five for the multiplication and is still NOT ELIGIBLE. Using the
 * rounded figure for eligibility would pay gratuity to somebody the Act
 * does not cover, which is the mirror image of refusing a death claim
 * and is just as wrong.
 */
export function measureService(joinedOn: string, exitOn: string): ServiceSpan | null {
  const join = parseIsoDate(joinedOn);
  const exit = parseIsoDate(exitOn);
  if (join === null || exit === null) return null;
  if (epochDay(exit) < epochDay(join)) return null;

  // ⭐ The last working day is served, so service ends at the END of it —
  // i.e. the exclusive end of the span is the following morning.
  const endExclusive = addDays(exit, 1);
  const endDay = epochDay(endExclusive);

  let completedYears = 0;
  // Bounded rather than `while (true)`: a 120-year career is a data
  // error, and an unbounded loop over a corrupt date is a hung request.
  for (let n = 1; n <= 120; n += 1) {
    if (epochDay(addMonthsClamped(join, n * 12)) <= endDay) completedYears = n;
    else break;
  }

  const finalYearStart = addMonthsClamped(join, completedYears * 12);
  const sixMonthMark = addMonthsClamped(finalYearStart, 6);
  // 🔴 STRICTLY GREATER. See the note above; `>=` is a different Act.
  const finalPartYearCounts = endDay > epochDay(sixMonthMark);

  return {
    completedYears,
    finalYearStartsOn: formatIsoDate(finalYearStart),
    sixMonthMarkOn: formatIsoDate(sixMonthMark),
    finalPartYearCounts,
    qualifyingYears: completedYears + (finalPartYearCounts ? 1 : 0),
    serviceDays: endDay - epochDay(join),
  };
}

/* ------------------------------------------------------------------ */
/* MONEY                                                               */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐ ONE DIVISION, AT THE VERY END, AND THE ROUNDING DONE ON THE EXACT
 * RATIO RATHER THAN ON A TRUNCATED ONE.
 *
 * `wages × 15 × years ÷ 26` has a repeating decimal for most wages.
 * Dividing early — a daily wage, or a per-year figure, rounded and then
 * multiplied — moves the answer by rupees: ₹45,000 for five years is
 * ₹1,29,808 done once and ₹1,29,810 done per year. Neither is a
 * rounding error the employee can be asked to accept, and only the
 * first is the Act's own arithmetic.
 *
 * 🔴 AND IT ROUNDS FROM THE EXACT REMAINDER. Truncating to paise first
 * and rounding after loses the half-paise that decides the rupee.
 * Half rounds AWAY FROM ZERO, matching `roundToRupee` in
 * `lib/payroll/statutory.ts`, so the whole engine rounds one way.
 */
function roundRupeesFromRatio(numeratorMinor: Paise, denominator: bigint): Paise {
  // Rupees = numerator ÷ (denominator × 100), then back to paise.
  const den = denominator * 100n;
  const whole = numeratorMinor / den;
  const remainder = numeratorMinor - whole * den;
  const twice = remainder * 2n;
  const rounded = twice >= den ? whole + 1n : whole;
  return rounded * 100n;
}

/* ------------------------------------------------------------------ */
/* THE CALCULATION                                                     */
/* ------------------------------------------------------------------ */

export function computeGratuity(args: GratuityArgs): GratuityResult {
  const notes: string[] = [];
  const problems: string[] = [];

  const service = measureService(args.joinedOn, args.exitOn);
  const emptySpan: ServiceSpan = {
    completedYears: 0,
    finalYearStartsOn: args.joinedOn,
    sixMonthMarkOn: args.joinedOn,
    finalPartYearCounts: false,
    qualifyingYears: 0,
    serviceDays: 0,
  };

  const refuse = (span: ServiceSpan, why: string, effectiveFrom: string | null): GratuityResult => ({
    eligible: false,
    service: span,
    basisApplied: args.basis.kind,
    rulesEffectiveFrom: effectiveFrom,
    wagesPerCompletedYearMinor: 0n,
    entitlementBeforeCeilingMinor: 0n,
    ceilingMinor: 0n,
    ceilingApplied: false,
    statutoryEntitlementMinor: 0n,
    forfeitedMinor: 0n,
    statutoryPayableMinor: 0n,
    exGratiaMinor: 0n,
    totalPayableMinor: 0n,
    payableByOn: null,
    taxTreatment: "not_computed",
    notes,
    problems: [...problems, why],
  });

  if (service === null) {
    return refuse(
      emptySpan,
      "The joining date or the last working day is not a valid date, or the exit falls before the joining. No gratuity can be computed from it.",
      null,
    );
  }

  /* ---- ① The rules in force on the day it became payable ----------- */
  // 🔴 ON THE EXIT DATE. Not today. See the note on `GratuityRules`.
  const rules = pickEffective(args.rulesHistory, args.exitOn);
  if (rules === null) {
    return refuse(
      service,
      `No gratuity rules are configured for ${args.exitOn}. Ordence will not fall back to the newest ceiling it happens to have, because that silently restates an old settlement at a new ceiling. Add the row that was in force on the date of exit.`,
      null,
    );
  }
  const effectiveFrom = rules.effectiveFrom;

  // ⚠️ TWO CONFIGURATION MISTAKES THAT UNDERPAY WITHOUT LOOKING WRONG.
  // Both are stated as problems rather than corrected, because a
  // tenant may genuinely have configured better terms under s.4(5) in
  // the other direction, and silently "fixing" data is how the ledger
  // stops matching the screen that produced it.
  if (rules.monthlyWageDivisorDays > 26) {
    problems.push(
      `The monthly wage divisor is configured as ${rules.monthlyWageDivisorDays} days. The Explanation to s.4(2) says twenty-six, and a larger divisor pays less than the Act requires.`,
    );
  }
  if (rules.daysWagesPerCompletedYear < 15) {
    problems.push(
      `The rules give ${rules.daysWagesPerCompletedYear} days' wages a year. Section 4(2) says fifteen, and less than fifteen is below the statutory minimum.`,
    );
  }

  /* ---- ② Eligibility — s.4(1) and its proviso ---------------------- */
  const waived = waivesMinimumService(args.cause);
  const plainlyQualified = service.completedYears >= rules.minimumContinuousYears;
  const section2A =
    args.fifthYearQualifiesUnderSection2A === true &&
    service.completedYears === rules.minimumContinuousYears - 1;
  const explicitWaiver =
    typeof args.minimumServiceWaivedBecause === "string" &&
    args.minimumServiceWaivedBecause.trim().length > 0;

  const eligible = waived || plainlyQualified || section2A || explicitWaiver;

  if (waived && !plainlyQualified) {
    // ⭐ SAID IN WORDS ON THE SETTLEMENT, because the person reading it
    // will otherwise "correct" the calculation back to a refusal.
    notes.push(
      args.cause === "death"
        ? "Gratuity is payable although the employee had less than the qualifying service: the proviso to s.4(1) removes the five-year requirement where employment ends by death. It is payable to the nominee, or to the heirs where there is no nomination (s.4(1), s.6)."
        : "Gratuity is payable although the employee had less than the qualifying service: the proviso to s.4(1) removes the five-year requirement where employment ends by disablement.",
    );
  }
  if (args.cause === "death" && plainlyQualified) {
    notes.push(
      "Payable to the nominee, or to the heirs where there is no nomination (s.4(1), s.6).",
    );
  }
  if (section2A && !plainlyQualified) {
    notes.push(
      `Qualified on the assertion that the final year is continuous service under s.2A (the "4 years and 240 days" reading in Mettur Beardsell). ⚠️ That reading is not settled across High Courts and has not been ruled on by the Supreme Court — this settlement rests on it, and it should be confirmed with the establishment's advisers before payment.`,
    );
  }
  if (explicitWaiver && !plainlyQualified && !waived && !section2A) {
    notes.push(
      `The qualifying period was waived by an explicit instruction: ${String(args.minimumServiceWaivedBecause).trim()}`,
    );
  }

  if (!eligible) {
    return refuse(
      service,
      `Not eligible: ${service.completedYears} completed year${service.completedYears === 1 ? "" : "s"} of continuous service against the ${rules.minimumContinuousYears} that s.4(1) requires. ⚠️ The final part-year rounding in s.4(2) decides how much is paid, never whether anything is paid, so ${service.qualifyingYears} qualifying years does not make this payable. Death and disablement are the only exceptions, and neither applies here.`,
      effectiveFrom,
    );
  }

  /* ---- ③ The entitlement — s.4(2) and its provisos ----------------- */
  const daysPerYear = BigInt(Math.trunc(rules.daysWagesPerCompletedYear));
  const divisor = BigInt(Math.trunc(rules.monthlyWageDivisorDays));
  const years = BigInt(service.qualifyingYears);

  let perYear: Paise;
  let beforeCeiling: Paise;

  if (args.basis.kind === "monthly_rated") {
    const monthly = BigInt(args.basis.monthlyWagesMinor);
    if (divisor <= 0n) {
      return refuse(service, "The monthly wage divisor is zero, which cannot be divided by.", effectiveFrom);
    }
    // Display only — the total below does NOT multiply this.
    perYear = roundRupeesFromRatio(monthly * daysPerYear, divisor);
    beforeCeiling = roundRupeesFromRatio(monthly * daysPerYear * years, divisor);
    notes.push(
      `Fifteen days' wages a year on the last drawn monthly wage, the month taken as ${divisor} days (s.4(2) and its Explanation), for ${service.qualifyingYears} year${service.qualifyingYears === 1 ? "" : "s"}.`,
    );
  } else if (args.basis.kind === "piece_rated") {
    const daily = BigInt(args.basis.dailyWagesMinor);
    perYear = roundToRupee(daily * daysPerYear);
    beforeCeiling = roundToRupee(daily * daysPerYear * years);
    notes.push(
      `Piece-rated: fifteen days' wages a year on an average daily wage supplied by the employer under the first proviso to s.4(2) — ${args.basis.averagingNote}. ⚠️ Ordence does not derive that average; the three-month averaging convention has to be the one the establishment's advisers have settled on.`,
    );
  } else {
    const daily = BigInt(args.basis.dailyWagesMinor);
    const seasons = BigInt(Math.max(0, Math.trunc(args.basis.seasons)));
    const perSeason = BigInt(Math.trunc(rules.seasonalDaysWagesPerSeason));
    perYear = roundToRupee(daily * perSeason);
    beforeCeiling = roundToRupee(daily * perSeason * seasons);
    notes.push(
      `Seasonal establishment, employee not employed throughout the year: ${rules.seasonalDaysWagesPerSeason} days' wages for each of ${args.basis.seasons} season${args.basis.seasons === 1 ? "" : "s"}, under the second proviso to s.4(2). The fifteen-day rule and the 26-day divisor do not apply to this employee.`,
    );
  }

  /* ---- ④ The ceiling — s.4(3), on the ENTITLEMENT only ------------- */
  const ceiling = BigInt(rules.ceilingMinor);
  const ceilingApplied = beforeCeiling > ceiling;
  const statutory = ceilingApplied ? ceiling : beforeCeiling;
  if (ceilingApplied) {
    notes.push(
      `The computed entitlement exceeds the s.4(3) ceiling in force on ${args.exitOn}, so the statutory entitlement is the ceiling. ⭐ That is a limit on what the Act compels; s.4(5) expressly preserves better terms, so the employer may pay more and any excess is recorded separately as ex gratia.`,
    );
  }

  /* ---- ⑤ Forfeiture — s.4(6) --------------------------------------- */
  let forfeited = 0n;
  const forfeiture = args.forfeiture ?? null;
  if (forfeiture !== null) {
    if (forfeiture.amountMinor === null) {
      problems.push(
        `Forfeiture under s.4(6) has been flagged (${forfeiture.reference}) with no amount stated. Under s.4(6)(a) the forfeiture is limited to the damage caused, and under s.4(6)(b) it is a decision the employer must make and defend. Ordence will not infer an amount, so nothing has been forfeited in this figure.`,
      );
    } else {
      const claimed = BigInt(forfeiture.amountMinor);
      if (claimed < 0n) {
        problems.push("The forfeiture amount is negative, which is not a forfeiture.");
      } else {
        forfeited = claimed > statutory ? statutory : claimed;
        if (claimed > statutory) {
          notes.push(
            "The forfeiture claimed is larger than the gratuity, so it has been limited to the gratuity. Any balance of the damage is a separate recovery and cannot be taken out of a nil gratuity.",
          );
        }
        notes.push(
          forfeiture.ground === "damage_or_loss"
            ? `Forfeited to the extent of damage or loss caused by wilful omission or negligence — s.4(6)(a), ${forfeiture.reference}. ⚠️ The forfeiture may not exceed the damage actually caused.`
            : `Forfeited under s.4(6)(b) — ${forfeiture.reference}. ⚠️ This limb applies only where the services were terminated for that conduct; a forfeiture attached to an ordinary resignation will not survive a challenge before the controlling authority.`,
        );
      }
    }
  }

  const statutoryPayable = statutory - forfeited;

  /* ---- ⑥ Ex gratia — s.4(5), kept apart --------------------------- */
  let exGratia = 0n;
  const proposed =
    typeof args.employerProposedTotalMinor === "string" && args.employerProposedTotalMinor.length > 0
      ? BigInt(args.employerProposedTotalMinor)
      : null;

  if (proposed !== null) {
    if (proposed < statutoryPayable) {
      problems.push(
        `The employer proposes ₹${(proposed / 100n).toLocaleString("en-IN")} against a statutory entitlement of ₹${(statutoryPayable / 100n).toLocaleString("en-IN")}. Section 4(5) allows better terms than the Act, never worse, so the shortfall is not payable as proposed. The figure below remains the statutory one.`,
      );
    } else {
      exGratia = proposed - statutoryPayable;
      if (exGratia > 0n) {
        notes.push(
          `₹${(exGratia / 100n).toLocaleString("en-IN")} of this settlement is above the statutory entitlement — lawful under s.4(5), recorded separately because its tax treatment differs from the statutory gratuity's.`,
        );
      }
    }
  }

  const total = statutoryPayable + exGratia;

  /* ---- ⑦ When it has to be paid — s.7(3) --------------------------- */
  const exitYmd = parseIsoDate(args.exitOn);
  const payableBy = exitYmd === null ? null : formatIsoDate(addDays(exitYmd, PAYMENT_DUE_DAYS));
  if (payableBy !== null) {
    notes.push(
      rules.delayInterestRateBpPerAnnum === null
        ? `Payable by ${payableBy} — thirty days from the date it became payable (s.7(3)). ⚠️ Beyond that s.7(3A) adds simple interest, and no interest rate is configured, so no interest has been computed here. It is not nil.`
        : `Payable by ${payableBy} (s.7(3)). Beyond that s.7(3A) adds simple interest at the configured rate; Ordence does not compute it in this settlement.`,
    );
  }

  notes.push(
    "⚠️ Income tax has not been computed on this gratuity. The exemption in s.10(10) of the Income-tax Act, 1961 depends on exemptions already claimed against previous employers over the employee's lifetime, which Ordence does not hold. Any ex gratia above the statutory entitlement is salary. Both figures are shown separately so the accountant can apply the exemption.",
  );

  return {
    eligible: true,
    service,
    basisApplied: args.basis.kind,
    rulesEffectiveFrom: effectiveFrom,
    wagesPerCompletedYearMinor: perYear,
    entitlementBeforeCeilingMinor: beforeCeiling,
    ceilingMinor: ceiling,
    ceilingApplied,
    statutoryEntitlementMinor: statutory,
    forfeitedMinor: forfeited,
    statutoryPayableMinor: statutoryPayable,
    exGratiaMinor: exGratia,
    totalPayableMinor: total,
    payableByOn: payableBy,
    taxTreatment: "not_computed",
    notes,
    problems,
  };
}

/* ------------------------------------------------------------------ */
/* WHAT THE FULL-AND-FINAL BATCH CONSUMES                              */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐ THERE IS NO SEPARATION OR FULL-AND-FINAL FLOW IN ORDENCE TODAY.
 *
 * `employees.left_on` is a date that stops payroll (`server/actions/
 * leave.ts` and `server/actions/registers.ts` filter on it) and nothing
 * anywhere assembles an exit settlement: no notice pay, no leave
 * encashment, no recovery of advances, no clearance.
 *
 * ⚠️ SO THIS BATCH DOES NOT INVENT ONE. A separation domain guessed at
 * from the outside would fix the shape of a settlement before anybody
 * has decided what belongs in it, and gratuity would then be wired to
 * the guess rather than to the real thing.
 *
 * 🔴 WHAT IS PROVIDED INSTEAD IS THE CALLABLE THE BATCH WILL NEED, with
 * the employee record's own fields as its inputs, so that wiring it up
 * later is one call and no re-derivation of the law.
 */
export interface ExitingEmployeeFacts {
  readonly joinedOn: string;
  readonly leftOn: string | null;
  /** s.2(s) wages — basic + DA for the last month. NOT the gross. */
  readonly lastDrawnWagesMinor: string;
}

/**
 * ⭐ The one call a full-and-final screen makes. Everything the Act
 * leaves to judgement — the establishment basis, the cause, forfeiture,
 * any better contractual terms — stays an argument, because none of it
 * can be read off an employee row.
 */
export function gratuityOnExit(args: {
  readonly employee: ExitingEmployeeFacts;
  readonly cause: TerminationCause;
  readonly rulesHistory: readonly GratuityRules[];
  /** Defaults to `monthly_rated` — see `DEFAULT_ESTABLISHMENT_BASIS`. */
  readonly basis?: GratuityWageBasis;
  readonly fifthYearQualifiesUnderSection2A?: boolean;
  readonly minimumServiceWaivedBecause?: string | null;
  readonly forfeiture?: GratuityForfeiture | null;
  readonly employerProposedTotalMinor?: string | null;
}): GratuityResult | null {
  // ⚠️ NO EXIT DATE, NO CALCULATION — and null rather than "today".
  // Defaulting to the current date would compute a live employee's
  // gratuity against a ceiling that has nothing to do with their exit.
  if (args.employee.leftOn === null) return null;

  return computeGratuity({
    joinedOn: args.employee.joinedOn,
    exitOn: args.employee.leftOn,
    cause: args.cause,
    basis:
      args.basis ?? {
        kind: DEFAULT_ESTABLISHMENT_BASIS,
        monthlyWagesMinor: args.employee.lastDrawnWagesMinor,
      },
    rulesHistory: args.rulesHistory,
    fifthYearQualifiesUnderSection2A: args.fifthYearQualifiesUnderSection2A,
    minimumServiceWaivedBecause: args.minimumServiceWaivedBecause,
    forfeiture: args.forfeiture,
    employerProposedTotalMinor: args.employerProposedTotalMinor,
  });
}

/**
 * ⭐ One line for a settlement letter. Deliberately says what was
 * applied, not just what came out: a number with no rule attached is
 * the thing an employee cannot check.
 */
export function describeGratuity(result: GratuityResult): string {
  if (!result.eligible) {
    return `No gratuity is payable. ${result.problems[0] ?? ""}`.trim();
  }
  const rupees = (p: Paise): string => `₹${(p / 100n).toLocaleString("en-IN")}`;
  const basis =
    result.basisApplied === "monthly_rated"
      ? "15 days' wages a year, month taken as 26 days"
      : result.basisApplied === "piece_rated"
        ? "15 days' wages a year on an averaged daily wage"
        : "7 days' wages a season";
  const excess = result.exGratiaMinor > 0n ? ` plus ${rupees(result.exGratiaMinor)} ex gratia` : "";
  return `${rupees(result.statutoryPayableMinor)} statutory gratuity for ${result.service.qualifyingYears} qualifying year${result.service.qualifyingYears === 1 ? "" : "s"} (${basis})${excess}. Income tax not computed.`;
}

/** ⭐ Exported so a ceiling can never be read as "unlimited" by mistake. */
export function ceilingInForceOn(
  rulesHistory: readonly GratuityRules[],
  onDate: string,
): Paise | null {
  const rules = pickEffective(rulesHistory, onDate);
  return rules === null ? null : BigInt(rules.ceilingMinor);
}
