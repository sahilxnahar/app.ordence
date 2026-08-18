/**
 * Ordence — ⭐⭐⭐ FULL AND FINAL SETTLEMENT ON SEPARATION
 * Version: v1.52.0-alpha
 *
 * Pure. No database, no network, no clock. Every date, every rate and
 * every balance arrives as an argument, exactly as
 * `lib/payroll/statutory.ts` and `lib/payroll/gratuity.ts` do, so the
 * whole of this file can be checked by hand against the bare Acts.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE DANGEROUS HALF OF THIS FEATURE IS THE DEDUCTIONS
 * ══════════════════════════════════════════════════════════════════════
 * Assembling what is OWED — part-month wages, leave encashment, gratuity,
 * notice pay — is arithmetic, and an error in it gets argued about.
 *
 * ⚠️ The RECOVERIES are different. An employer with a grievance reaches
 * for the settlement because it is the last time they hold the money:
 * an unreturned laptop, a training bond, a notice period the employee
 * did not serve, an advance from three years ago that nobody documented.
 * Netted together they routinely take a settlement to zero.
 *
 * 🔴 AND THE LAW DOES NOT ALLOW THAT. Section 7 of the Payment of Wages
 * Act, 1936 is an EXHAUSTIVE list: "no deductions shall be made from the
 * wages of an employed person except those authorised by or under this
 * Act", and s.7(2) then enumerates them. Section 7(3) caps the TOTAL at
 * fifty per cent of the wages of the wage period — seventy-five where
 * the deductions include payments to co-operative societies under
 * s.7(2)(j).
 *
 * ⭐⭐ SO AN OVER-CAP SETTLEMENT IS A REFUSAL HERE, NOT A CLAMP. Clamping
 * silently to 50% produces a lawful-looking number and leaves the
 * employer believing the balance was recovered; they then chase the
 * employee for it, or worse, hold the settlement hostage. Refusing puts
 * the decision where it belongs: the employer must drop a head, prove
 * one under s.10, or sue for it as a civil debt.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 GRATUITY IS NOT IN THE CAP BASE, AND THAT IS NOT A PREFERENCE
 * ══════════════════════════════════════════════════════════════════════
 * Section 2(vi) defines "wages" and then excludes, in terms, "any
 * gratuity payable on the termination of employment". A settlement that
 * folds gratuity into the base doubles or trebles the amount an employer
 * may lawfully deduct — on the exact figure the Payment of Gratuity Act
 * protects hardest (s.13 exempts gratuity from attachment in execution
 * of a decree). It is therefore excluded UNCONDITIONALLY and is not
 * configurable. Everything genuinely arguable below IS configurable and
 * says who has to confirm it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT THIS FILE TAKES AS INPUT BECAUSE IT DOES NOT EXIST YET
 * ══════════════════════════════════════════════════════════════════════
 * ① THE LEAVE BALANCE. `lib/leave/balance.ts` DOES compute one —
 *   `foldLedger()` returns a `LeaveBalance` in centidays — but reading
 *   the ledger needs the database and this file is pure. So the balance
 *   arrives as centidays and the caller is expected to fold it from
 *   `leave_ledger`. The VALUATION uses `encashmentValueMinor` from that
 *   same module rather than a second rounding rule here.
 * ② THE DAILY RATE FOR ENCASHMENT. Basic, basic+DA or gross is a policy
 *   question with real money on it and no single right answer;
 *   `lib/leave/balance.ts` already refuses to decide it and so does this.
 * ③ NOTICE PAY. Whether notice is owed or recoverable, and at what rate,
 *   is contractual. Both directions are modelled; neither is inferred.
 * ④ INCOME TAX ON THE SETTLEMENT. Not computed. See `gratuity.ts` ①.
 */

import { encashmentValueMinor } from "../leave/balance";
import type { Centidays } from "../leave/days";
import {
  gratuityOnExit,
  type ExitingEmployeeFacts,
  type GratuityForfeiture,
  type GratuityResult,
  type GratuityRules,
  type GratuityWageBasis,
  type TerminationCause,
} from "./gratuity";
import type { Paise } from "./statutory";

/* ================================================================== */
/* ① PART-MONTH WAGES                                                  */
/* ================================================================== */

/**
 * 🔴 THE DIVISOR IS A POLICY CHOICE AND IT MOVES REAL MONEY.
 *
 * A month's wages for seventeen days is `monthly × 17 ÷ D`, and D is
 * one of three numbers depending on what the establishment's standing
 * orders or appointment letter say:
 *
 *   • the calendar days of THAT month (28, 30 or 31) — the commonest,
 *     and the only one where a February exit is not quietly favourable;
 *   • a fixed 30, so every month pays the same daily rate;
 *   • 26, the Payment of Gratuity Act's divisor, used by establishments
 *     that treat four days a month as paid holidays.
 *
 * ⚠️ THE SPREAD IS ABOUT 15% OF A PART MONTH'S PAY. Ordence will not
 * pick one silently; the caller states it and the settlement prints it.
 */
export type PartMonthDivisor =
  | { readonly kind: "calendar_days_of_month"; readonly daysInMonth: number }
  | { readonly kind: "fixed"; readonly days: number };

export interface PartMonthWages {
  readonly monthlyWagesMinor: string;
  readonly daysPayable: number;
  readonly divisor: PartMonthDivisor;
}

/**
 * ⭐⭐ ONE DIVISION, AT THE END, ROUNDED FROM THE EXACT REMAINDER.
 *
 * 🔴 THE ALTERNATIVE — round a daily rate, then multiply by the days —
 * is what a spreadsheet does and it is wrong by rupees. ₹45,000 over 17
 * of 31 days is ₹24,677.42 done once and ₹24,677.37 done per day. The
 * employee is never told which was used, so the error is invisible to
 * the only person who would object.
 *
 * ⚠️ AND EVERY STEP IS `bigint` PAISE. The float version of this
 * expression is a number with a fractional paise in it, and
 * `BigInt(24677.42)` throws rather than truncating — which is the good
 * failure, but only if nobody rounds it first.
 *
 * Rounded to the nearest PAISE, half away from zero. Not to the rupee:
 * a part month is one line of a settlement that is summed with others,
 * and rounding every line to the rupee moves the total by more than
 * rounding the total once.
 */
export function partMonthWagesMinor(part: PartMonthWages): Paise {
  const monthly = BigInt(part.monthlyWagesMinor);
  const days = BigInt(Math.max(0, Math.trunc(part.daysPayable)));
  const divisor = BigInt(
    Math.trunc(
      part.divisor.kind === "calendar_days_of_month"
        ? part.divisor.daysInMonth
        : part.divisor.days,
    ),
  );
  if (divisor <= 0n) return 0n;

  const numerator = monthly * days;
  const whole = numerator / divisor;
  const remainder = numerator - whole * divisor;
  // ⭐ Half AWAY FROM ZERO, matching `roundToRupee` in statutory.ts, so
  // the whole payroll engine rounds one way.
  const twice = (remainder < 0n ? -remainder : remainder) * 2n;
  const bump = twice >= divisor ? 1n : 0n;
  return numerator < 0n ? whole - bump : whole + bump;
}

/* ================================================================== */
/* ② NOTICE — WHICH WAY THE MONEY GOES                                 */
/* ================================================================== */

/**
 * ⚠️ NOTICE RUNS IN BOTH DIRECTIONS AND THEY ARE NOT SYMMETRICAL.
 *
 *   • `employer_pays_in_lieu` — the employer released the employee
 *     early. This is an EARNING. Under s.2(vi)(d) of the Payment of
 *     Wages Act a sum payable by reason of the termination of employment
 *     under a contract IS wages, so it is in the cap base by default.
 *
 *   • `recover_from_employee` — the employee did not serve out notice.
 *     🔴 THIS IS THE HEAD WITH NO HOME IN s.7(2). The enumerated list
 *     does not contain "notice shortfall", and the Supreme Court has
 *     never blessed recovering it as a wage deduction; establishments do
 *     it on the strength of the appointment letter. So it is modelled as
 *     a RECOVERY like any other and inherits the s.7(3) cap, and its
 *     head carries `statutoryBasis: "unsettled"` so an employer using it
 *     is told rather than reassured.
 */
export type NoticeDirection = "none" | "employer_pays_in_lieu" | "recover_from_employee";

export interface Notice {
  readonly direction: NoticeDirection;
  /** Paise. Whichever direction, the amount is stated, never derived. */
  readonly amountMinor: string;
  /** ⭐ The clause it rests on. A settlement without it is indefensible. */
  readonly reference: string;
}

/* ================================================================== */
/* ③ RECOVERIES — SECTION 7 IS AN EXHAUSTIVE LIST                      */
/* ================================================================== */

/**
 * 🔴 THE HEADS, WITH THE CLAUSE THAT AUTHORISES EACH ONE.
 *
 * "no deductions shall be made from the wages of an employed person
 * except those authorised by or under this Act" — s.7(1). A head that
 * is not on this list is not a deduction, it is a civil claim, and the
 * employer has to sue for it like anybody else.
 */
export type RecoveryKind =
  | "advance_or_overpayment"
  | "loan"
  | "damage_or_loss"
  | "unreturned_asset"
  | "co_operative_society"
  | "income_tax"
  | "provident_fund"
  | "notice_shortfall";

export interface RecoveryHead {
  readonly kind: RecoveryKind;
  readonly label: string;
  readonly clause: string;
  /**
   * 🔴 "unsettled" MEANS ORDENCE WILL NOT PRETEND IT IS AUTHORISED. The
   * head is refused unless the caller supplies `authorisedBecause`, and
   * the settlement prints that sentence.
   */
  readonly statutoryBasis: "authorised" | "unsettled";
  /**
   * s.10(1A) — a deduction for damage or loss may be made only after
   * the employee has been given an opportunity to show cause. Without a
   * reference to that hearing the deduction is unlawful however small.
   */
  readonly requiresShowCause: boolean;
  /** ⚠️ Whether this head triggers the 75% limb of the s.7(3) proviso. */
  readonly triggersSeventyFive: boolean;
}

export const RECOVERY_HEADS: readonly RecoveryHead[] = Object.freeze([
  {
    kind: "advance_or_overpayment",
    label: "Salary advance or over-payment of wages",
    clause: "Payment of Wages Act, 1936 s.7(2)(f), read with s.12",
    statutoryBasis: "authorised",
    requiresShowCause: false,
    triggersSeventyFive: false,
  },
  {
    kind: "loan",
    label: "Loan granted for welfare or house-building",
    clause: "Payment of Wages Act, 1936 s.7(2)(fff) and s.7(2)(ffff)",
    statutoryBasis: "authorised",
    requiresShowCause: false,
    triggersSeventyFive: false,
  },
  {
    kind: "damage_or_loss",
    label: "Damage to or loss of goods expressly entrusted",
    clause: "Payment of Wages Act, 1936 s.7(2)(c), read with s.10",
    statutoryBasis: "authorised",
    // 🔴 s.10(1) also caps it at the amount of the damage or loss
    // ACTUALLY caused — which Ordence cannot know, so it is the
    // employer's stated figure and the show-cause reference is what
    // makes it defensible.
    requiresShowCause: true,
    triggersSeventyFive: false,
  },
  {
    kind: "unreturned_asset",
    label: "Unreturned company asset",
    // ⚠️ IN LAW THIS IS THE SAME HEAD AS `damage_or_loss`: goods
    // expressly entrusted to the employee for custody, whose loss is
    // directly attributable to their neglect or default — s.7(2)(c).
    // It is a separate kind ONLY so the settlement can name the laptop,
    // and it carries the same s.10 hearing requirement.
    clause: "Payment of Wages Act, 1936 s.7(2)(c), read with s.10",
    statutoryBasis: "authorised",
    requiresShowCause: true,
    triggersSeventyFive: false,
  },
  {
    kind: "co_operative_society",
    label: "Payment to a co-operative society",
    clause: "Payment of Wages Act, 1936 s.7(2)(j)",
    statutoryBasis: "authorised",
    requiresShowCause: false,
    // ⭐ THE ONLY HEAD THAT MOVES THE CAP. See `deductionCapBp`.
    triggersSeventyFive: true,
  },
  {
    kind: "income_tax",
    label: "Income tax payable by the employee",
    clause: "Payment of Wages Act, 1936 s.7(2)(g)",
    statutoryBasis: "authorised",
    requiresShowCause: false,
    triggersSeventyFive: false,
  },
  {
    kind: "provident_fund",
    label: "Provident fund contribution",
    clause: "Payment of Wages Act, 1936 s.7(2)(i)",
    statutoryBasis: "authorised",
    requiresShowCause: false,
    triggersSeventyFive: false,
  },
  {
    kind: "notice_shortfall",
    label: "Notice period not served",
    clause: "Not enumerated in s.7(2)",
    // 🔴 SEE `NoticeDirection`. Employers do this routinely on the
    // strength of the appointment letter; s.7(2) does not list it, and
    // Ordence will not record it as authorised on the employer's say-so.
    statutoryBasis: "unsettled",
    requiresShowCause: false,
    triggersSeventyFive: false,
  },
]);

export const RECOVERY_HEAD_BY_KIND: Readonly<Record<string, RecoveryHead>> =
  Object.freeze(Object.fromEntries(RECOVERY_HEADS.map((h) => [h.kind, h])));

export interface Recovery {
  readonly kind: RecoveryKind;
  /** What it is, in the words the employee will read. */
  readonly description: string;
  /** Paise. Never negative — a negative recovery is an earning. */
  readonly amountMinor: string;
  /** The advance voucher, the loan agreement, the asset register row. */
  readonly reference: string;
  /**
   * s.10(1A). Required for every head with `requiresShowCause`, and its
   * absence is a refusal rather than a warning: a deduction for a
   * disputed laptop with no hearing is the single commonest unlawful
   * line on an Indian settlement.
   */
  readonly showCauseReference?: string | null;
  /**
   * ⭐ The employer's stated authority for a head s.7(2) does not list.
   * Printed on the settlement verbatim so it can be tested later.
   */
  readonly authorisedBecause?: string | null;
}

/* ================================================================== */
/* ④ THE CAP BASE — WHAT COUNTS AS "WAGES"                             */
/* ================================================================== */

/**
 * 🔴🔴 THE BASE THE FIFTY PER CENT BITES ON IS "WAGES", AND WHICH LINES
 * OF A SETTLEMENT ARE WAGES IS GENUINELY CONTESTABLE. SO IT IS
 * CONFIGURATION, WITH THE ARGUMENT FOR EACH DEFAULT WRITTEN OUT.
 *
 * s.2(vi) INCLUDES, at limb (d), "any sum which by reason of the
 * termination of employment of the person employed is payable under any
 * law, contract or instrument", and EXCLUDES, at the end of the same
 * definition, "any gratuity payable on the termination of employment".
 *
 *   • PART-MONTH WAGES — wages beyond argument. Always in the base and
 *     not configurable.
 *
 *   • LEAVE ENCASHMENT — payable on termination under s.79(11) of the
 *     Factories Act, 1948 (and the equivalent provision of the State
 *     Shops and Establishments Act), so it falls squarely inside limb
 *     (d). DEFAULT: IN. ⚠️ A CA or the establishment's counsel should
 *     confirm this for a non-factory establishment whose State Act
 *     words the entitlement differently.
 *
 *   • NOTICE PAY IN LIEU — payable by reason of termination under the
 *     contract, so limb (d) again. DEFAULT: IN. ⚠️ Same confirmation.
 *
 *   • EX GRATIA ABOVE THE STATUTORY GRATUITY — voluntary, so it is
 *     payable under no law, contract or instrument and does not enter
 *     limb (d). DEFAULT: OUT. ⚠️ If the better terms are written into
 *     an award or contract they are NOT ex gratia and the employer
 *     should be recording them as such; a CA should confirm which.
 *
 *   • STATUTORY GRATUITY — 🔴 EXCLUDED, ALWAYS, AND THERE IS NO FLAG
 *     FOR IT. See the file header.
 */
export interface CapBaseConfig {
  readonly leaveEncashmentIsWages: boolean;
  readonly noticePayInLieuIsWages: boolean;
  readonly exGratiaIsWages: boolean;
}

export const CAP_BASE_DEFAULT: CapBaseConfig = Object.freeze({
  leaveEncashmentIsWages: true,
  noticePayInLieuIsWages: true,
  exGratiaIsWages: false,
});

/** s.7(3) proviso, in basis points so the arithmetic stays integral. */
export const DEDUCTION_CAP_BP = 5_000;
export const DEDUCTION_CAP_BP_WITH_CO_OPERATIVE = 7_500;

/**
 * ⭐ WHICH LIMB OF THE s.7(3) PROVISO APPLIES.
 *
 * "in cases where such deductions are wholly or partly made for
 * payments to co-operative societies under clause (j)... seventy-five
 * per cent of such wages, and in any other case, fifty per cent".
 *
 * ⚠️ "WHOLLY OR PARTLY" — one rupee of co-operative society deduction
 * lifts the cap on the WHOLE set, which is a real and slightly
 * surprising consequence of the drafting, so it is asserted in a test.
 */
export function deductionCapBp(recoveries: readonly Recovery[]): number {
  const any = recoveries.some(
    (r) => RECOVERY_HEAD_BY_KIND[r.kind]?.triggersSeventyFive === true,
  );
  return any ? DEDUCTION_CAP_BP_WITH_CO_OPERATIVE : DEDUCTION_CAP_BP;
}

/**
 * 🔴 THE CAP ROUNDS DOWN. `capBase × 5000 ÷ 10000` on an odd number of
 * paise is a half-paise, and rounding it UP would permit a deduction of
 * fifty per cent PLUS a fraction — which is exactly the arithmetic a
 * float pipeline performs when it divides rupees by two and rounds to
 * the paise. Integer division truncates toward zero, which for a
 * non-negative base is a floor, which is the conservative direction.
 */
export function maximumLawfulDeductionMinor(capBaseMinor: Paise, capBp: number): Paise {
  if (capBaseMinor <= 0n) return 0n;
  return (capBaseMinor * BigInt(Math.trunc(capBp))) / 10_000n;
}

/* ================================================================== */
/* ⑤ THE SETTLEMENT                                                    */
/* ================================================================== */

export interface SettlementLine {
  readonly key: string;
  readonly label: string;
  readonly amountMinor: Paise;
  /** ⭐ Whether this line is in the s.7(3) base, and why. */
  readonly isWagesForCap: boolean;
  readonly basis: string;
}

export interface SettlementArgs {
  readonly employee: ExitingEmployeeFacts;
  readonly cause: TerminationCause;
  /** The last working day. ⭐ Inclusive, as `gratuity.ts` defines it. */
  readonly lastWorkingDay: string;
  readonly partMonth: PartMonthWages;
  /**
   * ⭐ FROM `lib/leave/balance.ts` — `foldLedger(entries).balanceCentidays`
   * or the equivalent. Taken as an input because this file is pure.
   */
  readonly leaveBalanceCentidays: Centidays;
  /** 🔴 Basic, basic+DA or gross. The caller decides; see the header. */
  readonly leaveDailyRateMinor: string;
  readonly leaveRateBasisNote: string;
  readonly notice: Notice;
  readonly recoveries: readonly Recovery[];
  readonly gratuityRulesHistory: readonly GratuityRules[];
  readonly gratuityBasis?: GratuityWageBasis;
  readonly gratuityForfeiture?: GratuityForfeiture | null;
  readonly gratuityEmployerProposedTotalMinor?: string | null;
  readonly fifthYearQualifiesUnderSection2A?: boolean;
  readonly minimumServiceWaivedBecause?: string | null;
  readonly capBase?: CapBaseConfig;
}

export interface SettlementResult {
  readonly lastWorkingDay: string;
  /** Every earning, itemised, with its cap treatment shown. */
  readonly earnings: readonly SettlementLine[];
  readonly grossDuesMinor: Paise;

  /* ---- The s.7(3) machinery, all of it on the result --------------- */
  readonly capBaseMinor: Paise;
  readonly capBaseExcludesMinor: Paise;
  readonly capBp: number;
  readonly maximumLawfulDeductionMinor: Paise;
  readonly recoveriesClaimedMinor: Paise;
  /** 🔴 Zero when refused. Never a clamped figure. */
  readonly deductionsAppliedMinor: Paise;
  readonly overCapByMinor: Paise;

  readonly gratuity: GratuityResult | null;
  /**
   * 🔴 TRUE MEANS NO SETTLEMENT MAY BE ISSUED FROM THIS RESULT, and
   * `netPayableMinor` is not a number anybody may pay.
   */
  readonly refused: boolean;
  readonly netPayableMinor: Paise;
  readonly taxTreatment: "not_computed";
  readonly notes: readonly string[];
  readonly problems: readonly string[];
}

const rupees = (p: Paise): string => `₹${(p / 100n).toLocaleString("en-IN")}`;

/**
 * ⭐⭐ THE ONE CALL A FULL-AND-FINAL SCREEN MAKES.
 *
 * ⚠️ IT RETURNS A REFUSAL AS A VALUE, NOT AS A THROW. The employer needs
 * to see the working that led to the refusal — the base, the cap, the
 * claimed total and the excess — in order to decide which head to drop.
 * An exception carrying a string gives them none of it.
 */
export function computeSettlement(args: SettlementArgs): SettlementResult {
  const notes: string[] = [];
  const problems: string[] = [];
  const capCfg = args.capBase ?? CAP_BASE_DEFAULT;

  /* ---- ① Wages for the part month worked --------------------------- */
  const partWages = partMonthWagesMinor(args.partMonth);
  const divisorDays =
    args.partMonth.divisor.kind === "calendar_days_of_month"
      ? args.partMonth.divisor.daysInMonth
      : args.partMonth.divisor.days;

  /* ---- ② Leave encashment ------------------------------------------ */
  /**
   * 🔴 THE IN-SERVICE CAPS IN `encashable()` ARE NOT APPLIED HERE, AND
   * THAT IS DELIBERATE. An annual encashment cap and a "days that must
   * remain afterwards" floor are policy limits on cashing out WHILE
   * EMPLOYED — the floor exists so that somebody who encashes and then
   * falls ill is not on loss of pay. Neither survives separation: there
   * is no next illness and no next leave year. Applying them on exit
   * would forfeit earned leave the employee is entitled to be paid for
   * under s.79(11) of the Factories Act, 1948.
   *
   * ⚠️ A NEGATIVE BALANCE IS NOT ENCASHED AS A RECOVERY. Leave taken in
   * advance of accrual is a claim the employer must raise as a named
   * recovery head, where the s.7(3) cap can see it, rather than a
   * silent negative line inside the earnings.
   */
  const leaveCentidays = Math.max(0, Math.trunc(args.leaveBalanceCentidays));
  const leaveValue = encashmentValueMinor(leaveCentidays, BigInt(args.leaveDailyRateMinor));
  if (args.leaveBalanceCentidays < 0) {
    problems.push(
      `The leave balance is negative (${(args.leaveBalanceCentidays / 100).toFixed(2)} days taken in advance of accrual). Ordence has encashed nothing rather than netting it off the settlement: recovering advance leave is a deduction and it has to be stated as one so that s.7(3) can be applied to it.`,
    );
  }

  /* ---- ③ Gratuity — the existing engine, never reimplemented -------- */
  const gratuity = gratuityOnExit({
    employee: args.employee,
    cause: args.cause,
    rulesHistory: args.gratuityRulesHistory,
    basis: args.gratuityBasis,
    fifthYearQualifiesUnderSection2A: args.fifthYearQualifiesUnderSection2A,
    minimumServiceWaivedBecause: args.minimumServiceWaivedBecause,
    forfeiture: args.gratuityForfeiture,
    employerProposedTotalMinor: args.gratuityEmployerProposedTotalMinor,
  });

  if (gratuity === null) {
    problems.push(
      "No exit date is recorded on the employee, so gratuity could not be computed. A settlement issued without it is incomplete, and s.7(3) of the Payment of Gratuity Act, 1972 starts a thirty-day clock the employer is already inside.",
    );
  } else {
    for (const p of gratuity.problems) problems.push(`Gratuity: ${p}`);
    for (const n of gratuity.notes) notes.push(`Gratuity: ${n}`);
  }
  const gratuityStatutory = gratuity?.statutoryPayableMinor ?? 0n;
  const gratuityExGratia = gratuity?.exGratiaMinor ?? 0n;

  /* ---- ④ Notice, where it is owed TO the employee ------------------ */
  const noticeAmount = BigInt(args.notice.amountMinor);
  if (noticeAmount < 0n) {
    problems.push("The notice amount is negative. State the direction instead of the sign.");
  }
  const noticeEarned =
    args.notice.direction === "employer_pays_in_lieu" && noticeAmount > 0n ? noticeAmount : 0n;

  /* ---- ⑤ The earnings, itemised ------------------------------------ */
  const earnings: SettlementLine[] = [
    {
      key: "part_month_wages",
      label: "Wages for the part month worked",
      amountMinor: partWages,
      isWagesForCap: true,
      basis: `${args.partMonth.daysPayable} of ${divisorDays} days at the monthly rate (${args.partMonth.divisor.kind === "calendar_days_of_month" ? "calendar days of the month" : "a fixed divisor"}). Wages beyond argument under s.2(vi).`,
    },
    {
      key: "leave_encashment",
      label: "Encashment of unavailed leave",
      amountMinor: leaveValue,
      isWagesForCap: capCfg.leaveEncashmentIsWages,
      basis: `${(leaveCentidays / 100).toFixed(2)} days at ${rupees(BigInt(args.leaveDailyRateMinor))} a day — ${args.leaveRateBasisNote}. Payable on discharge under s.79(11) of the Factories Act, 1948 or the State equivalent.`,
    },
    {
      key: "notice_pay_in_lieu",
      label: "Pay in lieu of notice",
      amountMinor: noticeEarned,
      isWagesForCap: capCfg.noticePayInLieuIsWages,
      basis:
        noticeEarned > 0n
          ? `Employer released the employee before the notice period expired — ${args.notice.reference}.`
          : "No notice pay is owed to the employee.",
    },
    {
      key: "gratuity_statutory",
      label: "Gratuity (statutory)",
      amountMinor: gratuityStatutory,
      // 🔴 NEVER TRUE. s.2(vi) excludes gratuity payable on termination
      // from "wages", so it is not in the base the 50% bites on.
      isWagesForCap: false,
      basis:
        "Payment of Gratuity Act, 1972 s.4. 🔴 Excluded from the deduction base — s.2(vi) of the Payment of Wages Act, 1936 excludes gratuity payable on termination from the definition of wages, and s.13 of the Gratuity Act protects it from attachment.",
    },
    {
      key: "gratuity_ex_gratia",
      label: "Gratuity above the statutory entitlement (ex gratia)",
      amountMinor: gratuityExGratia,
      isWagesForCap: capCfg.exGratiaIsWages,
      basis:
        "Lawful under s.4(5) of the Payment of Gratuity Act, 1972. Taxed as salary, not as gratuity.",
    },
  ];

  const grossDues = earnings.reduce((s, l) => s + l.amountMinor, 0n);
  const capBase = earnings.reduce((s, l) => s + (l.isWagesForCap ? l.amountMinor : 0n), 0n);
  const capExcluded = grossDues - capBase;

  /* ---- ⑥ The recoveries, head by head ------------------------------ */
  let claimed = 0n;
  for (const r of args.recoveries) {
    const head = RECOVERY_HEAD_BY_KIND[r.kind];
    if (head === undefined) {
      problems.push(
        `"${r.description}" is not a recognised deduction head. Section 7(1) of the Payment of Wages Act, 1936 allows no deduction except those it authorises; an unrecognised head is a civil claim, not a deduction.`,
      );
      continue;
    }
    const amount = BigInt(r.amountMinor);
    if (amount < 0n) {
      problems.push(`"${r.description}" is a negative recovery, which is an earning. State it as one.`);
      continue;
    }
    claimed += amount;

    const authorised =
      typeof r.authorisedBecause === "string" && r.authorisedBecause.trim().length > 0;

    if (head.statutoryBasis === "unsettled" && !authorised) {
      problems.push(
        `${head.label} — ${rupees(amount)} (${r.reference}). 🔴 ${head.clause}. Employers make this deduction on the strength of the appointment letter, and it has no clause of its own in the enumerated list. Ordence will not record it as authorised without a stated ground; supply one, or pursue it as a civil debt.`,
      );
    } else if (head.statutoryBasis === "unsettled" && authorised) {
      notes.push(
        `${head.label} deducted on the employer's stated authority: ${String(r.authorisedBecause).trim()} ⚠️ ${head.clause} — this ground has not been tested and the employee may recover it before the authority under s.15.`,
      );
    }

    if (
      head.requiresShowCause &&
      !(typeof r.showCauseReference === "string" && r.showCauseReference.trim().length > 0)
    ) {
      problems.push(
        `${head.label} — ${rupees(amount)} (${r.reference}) has no show-cause reference. Section 10(1A) of the Payment of Wages Act, 1936 permits a deduction for damage or loss ONLY after the employee has been given an opportunity to show cause, and s.10(1) limits it to the loss actually caused. A disputed asset netted off a settlement without that hearing is unlawful whatever its size.`,
      );
    }
  }

  /* ---- ⑦ s.7(3) — the cap, and the refusal ------------------------- */
  const capBp = deductionCapBp(args.recoveries);
  const maxLawful = maximumLawfulDeductionMinor(capBase, capBp);
  const overBy = claimed > maxLawful ? claimed - maxLawful : 0n;

  notes.push(
    `Deductions are capped at ${capBp / 100}% of wages by s.7(3) of the Payment of Wages Act, 1936${capBp === DEDUCTION_CAP_BP_WITH_CO_OPERATIVE ? " — the seventy-five per cent limb, because the deductions include a payment to a co-operative society under s.7(2)(j), and the proviso lifts the cap on the whole set once any part of it is such a payment" : ""}. The base is ${rupees(capBase)}; ${rupees(capExcluded)} of this settlement is not wages under s.2(vi) and is not in it.`,
  );

  if (overBy > 0n) {
    problems.push(
      `🔴 REFUSED. Recoveries of ${rupees(claimed)} exceed the ${rupees(maxLawful)} that s.7(3) of the Payment of Wages Act, 1936 permits against wages of ${rupees(capBase)}, by ${rupees(overBy)}. Ordence has NOT reduced the recoveries to the cap: a settlement clamped to the limit reads as though the balance was recovered, and it was not. Drop a head, establish one under s.10, or recover the balance as a civil debt. ⚠️ Gratuity of ${rupees(gratuityStatutory)} is deliberately outside this base and enlarging it with gratuity would not make the deduction lawful.`,
    );
  }

  const refused = overBy > 0n || problems.length > 0;
  const applied = overBy > 0n ? 0n : claimed;
  const net = refused ? 0n : grossDues - claimed;

  if (refused && overBy === 0n) {
    problems.push(
      "No settlement may be issued while any problem above is unresolved. The net figure has been withheld rather than estimated.",
    );
  }

  notes.push(
    "⚠️ Income tax on this settlement has not been computed. The s.10(10) gratuity exemption, the s.10(10AA) leave-encashment exemption and the treatment of ex gratia all depend on facts Ordence does not hold — chiefly exemptions already claimed against previous employers. Every line is shown separately so the accountant can apply them.",
  );

  return {
    lastWorkingDay: args.lastWorkingDay,
    earnings,
    grossDuesMinor: grossDues,
    capBaseMinor: capBase,
    capBaseExcludesMinor: capExcluded,
    capBp,
    maximumLawfulDeductionMinor: maxLawful,
    recoveriesClaimedMinor: claimed,
    deductionsAppliedMinor: applied,
    overCapByMinor: overBy,
    gratuity,
    refused,
    netPayableMinor: net,
    taxTreatment: "not_computed",
    notes,
    problems,
  };
}

/**
 * ⭐ THE SNAPSHOT THAT MAKES A SETTLEMENT REPRODUCIBLE.
 *
 * 🔴 AN EMPLOYEE DISPUTING A SETTLEMENT TWO YEARS LATER IS ENTITLED TO
 * THE WORKING, NOT THE TOTAL. Rates change, leave ledgers are corrected,
 * the gratuity ceiling moves — recomputing in 2028 from today's tables
 * produces a different number and proves nothing. So the INPUTS go into
 * `employee_settlements.inputs` verbatim alongside the computed figures,
 * and the row is the evidence rather than a pointer to tables that have
 * since moved.
 *
 * ⚠️ `bigint` DOES NOT SURVIVE `JSON.stringify`, so every amount here is
 * already a decimal string and stays one.
 */
export function settlementSnapshot(
  args: SettlementArgs,
  result: SettlementResult,
): { readonly inputs: unknown; readonly computed: unknown } {
  return {
    inputs: {
      employee: args.employee,
      cause: args.cause,
      lastWorkingDay: args.lastWorkingDay,
      partMonth: args.partMonth,
      leaveBalanceCentidays: args.leaveBalanceCentidays,
      leaveDailyRateMinor: args.leaveDailyRateMinor,
      leaveRateBasisNote: args.leaveRateBasisNote,
      notice: args.notice,
      recoveries: args.recoveries,
      gratuityRulesHistory: args.gratuityRulesHistory,
      gratuityBasis: args.gratuityBasis ?? null,
      gratuityForfeiture: args.gratuityForfeiture ?? null,
      capBase: args.capBase ?? CAP_BASE_DEFAULT,
    },
    computed: {
      earnings: result.earnings.map((l) => ({
        key: l.key,
        label: l.label,
        amountMinor: l.amountMinor.toString(),
        isWagesForCap: l.isWagesForCap,
        basis: l.basis,
      })),
      grossDuesMinor: result.grossDuesMinor.toString(),
      capBaseMinor: result.capBaseMinor.toString(),
      capBaseExcludesMinor: result.capBaseExcludesMinor.toString(),
      capBp: result.capBp,
      maximumLawfulDeductionMinor: result.maximumLawfulDeductionMinor.toString(),
      recoveriesClaimedMinor: result.recoveriesClaimedMinor.toString(),
      deductionsAppliedMinor: result.deductionsAppliedMinor.toString(),
      overCapByMinor: result.overCapByMinor.toString(),
      refused: result.refused,
      netPayableMinor: result.netPayableMinor.toString(),
      taxTreatment: result.taxTreatment,
      notes: result.notes,
      problems: result.problems,
    },
  };
}
