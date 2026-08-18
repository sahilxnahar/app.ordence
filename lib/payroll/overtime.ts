/**
 * Ordence — ⭐⭐⭐ OVERTIME UNDER THE FACTORIES ACT AND THE STATE SHOPS ACTS
 * Version: v1.52.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS FILE IS AND IS NOT
 * ══════════════════════════════════════════════════════════════════════
 * It is pure. No I/O, no `server-only`, no database, no clock. It takes
 * hours somebody else measured and rules somebody else configured, and
 * it answers three questions:
 *
 *   ① HOW MANY MINUTES OF THIS PERIOD WERE OVERTIME.
 *   ② WHAT THEY ARE WORTH, in paise, at the multiplier the governing Act
 *      prescribes.
 *   ③ WHETHER WORKING THEM WAS LAWFUL — because s.64/s.65 of the
 *      Factories Act 1948 cap total and overtime hours, and exceeding the
 *      cap is an OFFENCE BY THE EMPLOYER under s.92, not a payroll
 *      rounding matter. Paying the hours correctly and saying nothing
 *      about the breach is the wrong behaviour: it launders the offence
 *      through the payslip.
 *
 * 🔴 IT DOES NOT KNOW WHERE HOURS COME FROM, AND TODAY NOTHING FEEDS IT.
 * `server/payroll/attendance-bridge.ts` reads `staff_attendance`, which
 * is ONE VERDICT PER DAY in centidays — present, absent, half a day of
 * loss of pay. There is no clock-in, no clock-out, no hours column
 * anywhere in `db/schema/leave.ts` or `db/schema/payroll.ts`, and
 * `lib/registers/spec.ts` already states as a positive fact that
 * overtime hours are NOT HELD ("it is not zero; it is unknown"). So this
 * module is exposed as a callable and is deliberately NOT wired into
 * `server/payroll/run.ts`. Inventing an hours source to have something to
 * call would put fabricated numbers on a statutory register.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE UNIT OF TIME IS THE WHOLE MINUTE, AND THAT IS A DECISION
 * ══════════════════════════════════════════════════════════════════════
 * The rest of this codebase counts quantities in integer THOUSANDTHS and
 * loss of pay in integer CENTIDAYS, for one reason: a previous payroll
 * change did `Math.floor(worked)` and docked a full day for a half day
 * worked. The lesson is "integers, and never floor a part-unit to zero",
 * not "thousandths specifically".
 *
 * 🔴 THOUSANDTHS OF AN HOUR CANNOT REPRESENT A MINUTE. 1/60 h is
 * 16.666… thousandths, so every clock reading would be inexact before
 * any arithmetic happened. A whole minute represents every clock reading
 * exactly, is an integer, and 7.5 hours is exactly 450 of them. So time
 * is minutes here; DAY fractions arriving from the attendance world stay
 * centidays and are converted by `minutesFromDayFraction()`, which is the
 * only bridge between the two units and does its division in bigint.
 *
 * ⚠️ THERE IS NO `Math.floor` AND NO FLOAT ON ANY TIME OR MONEY PATH IN
 * THIS FILE. Money is `bigint` paise throughout; the single rounding step
 * is half-away-from-zero at the last division.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ "ORDINARY RATE OF WAGES" IS A DEFINED TERM AND IT IS NOT GROSS
 * ══════════════════════════════════════════════════════════════════════
 * Factories Act 1948, s.59(2): the ordinary rate of wages means the
 * basic wages plus such allowances, including the cash equivalent of the
 * advantage accruing through the concessional sale to workers of food
 * grains and other articles, as the worker is for the time being
 * entitled to, BUT DOES NOT INCLUDE A BONUS AND WAGES FOR OVERTIME WORK.
 *
 * 🔴 SO BOTH OBVIOUS SHORTCUTS ARE WRONG IN OPPOSITE DIRECTIONS.
 * Computing overtime on GROSS sweeps in bonus and last month's overtime
 * and overpays. Computing it on BASIC alone drops the allowances s.59(2)
 * expressly includes and underpays — and underpaying overtime is the
 * recovery an inspector actually orders.
 *
 * ⚠️ WHICH OF A TENANT'S OWN COMPONENTS ARE "ALLOWANCES THE WORKER IS
 * ENTITLED TO" IS A JUDGEMENT ABOUT THAT TENANT'S PAY STRUCTURE, NOT A
 * FACT THIS FILE CAN KNOW. A conveyance allowance paid to everybody
 * every month is plainly in; a discretionary incentive is plainly out; a
 * fixed "special allowance" is argued both ways. So the base is EXPLICIT
 * CONFIGURATION — `ordinaryRateIncludes`, a list of component codes —
 * and an empty list REFUSES rather than defaulting to basic or to gross.
 * 🔴 NEEDS THE TENANT'S CA / COUNSEL TO CONFIRM THE LIST PER PAY
 * STRUCTURE. What this file enforces on its own is only what s.59(2)
 * settles in terms: bonus is out, overtime is out.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ THE RULES ARE DATA, EFFECTIVE-DATED, EXACTLY LIKE PF AND PT
 * ══════════════════════════════════════════════════════════════════════
 * A multiplier or a cap compiled into code is a bug with a delay fuse: a
 * state amends its rules, and every payroll re-run for an earlier period
 * silently changes. `statutory_rates` already stores `kind` + `scope` +
 * `effective_from/to` + a jsonb payload, so overtime needs NO NEW TABLE
 * and NO MIGRATION: rows are `kind = 'overtime'`, `scope = <state code>`,
 * read the same way `loadRates()` reads professional tax.
 *
 * 🔴 SHOPS AND ESTABLISHMENTS ACTS ARE STATE LAW AND THEY DIFFER —
 * in the daily and weekly threshold, in the cap, and sometimes in the
 * multiplier. There is no national shops-and-establishments rule to hard
 * code. The establishment's STATE plus its KIND select the row, and a
 * state with no row REFUSES. It does not fall back to a neighbouring
 * state, it does not fall back to the Factories Act, and it does not
 * fall back to the newest row on file — the same reason `pickEffective`
 * refuses rather than reaching for today's rates.
 */

import {
  pickEffective,
  type EffectiveDated,
  type Paise,
} from "./statutory";
import type { Centidays } from "@/lib/leave/days";

/* ------------------------------------------------------------------ */
/* UNITS                                                               */
/* ------------------------------------------------------------------ */

/** ⭐ Integer minutes. See the header for why not thousandths of an hour. */
export type Minutes = number;

export const MINUTES_PER_HOUR = 60;

/** ⭐ A hundredth of a day — the unit `lib/leave/*` and the register use. */
const CENTIDAYS_PER_DAY = 100;

/**
 * 🔴 TWICE THE ORDINARY RATE. Factories Act 1948, s.59(1): a worker who
 * works for more than nine hours in any day or for more than forty-eight
 * hours in any week shall, in respect of overtime work, be entitled to
 * wages at the rate of TWICE HIS ORDINARY RATE OF WAGES.
 *
 * ⚠️ NOT 1.5×. One-and-a-half is the United States' FLSA rate and it is
 * the single commonest defect in payroll software sold in India. It is a
 * floor here, not a hard-coded rate: the actual multiplier is data, and
 * a state or a contract may be MORE generous.
 */
export const FACTORIES_ACT_MIN_MULTIPLIER_BP = 20_000;

/* ------------------------------------------------------------------ */
/* THE RULES, AS DATA                                                  */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ WHICH STATUTE GOVERNS THIS ESTABLISHMENT. It is not a formality:
 * a factory is governed by a central Act with state rules under it; a
 * shop or commercial establishment is governed by a wholly separate
 * STATE Act with its own thresholds and its own caps.
 */
export type EstablishmentKind = "factory" | "shops_and_establishments";

/**
 * ⚠️ HOW THE DAILY AND WEEKLY LIMITS COMBINE, WHICH IS A REAL CHOICE.
 *
 * s.59(1) makes overtime payable for work beyond NINE HOURS IN A DAY
 * *OR* BEYOND FORTY-EIGHT HOURS IN A WEEK. Read literally, a week of six
 * ten-hour days is both six hours of daily excess and twelve hours of
 * weekly excess, and adding them would pay eighteen. Establishments
 * settle this differently and the difference is real money.
 *
 * 🔴 SO IT IS CONFIGURATION, NOT A DEFAULT. `greater_of` is the reading
 * most commonly certified (the worker gets whichever limit is more
 * favourable, never both) — but it is stated per tenant and not assumed.
 */
export type OvertimeBasis = "daily" | "weekly" | "greater_of";

export interface OvertimeRules extends EffectiveDated {
  /** ⚠️ The state whose law governs. Selects the row; never defaulted. */
  readonly stateCode: string;
  readonly establishmentKind: EstablishmentKind;

  /**
   * Basis points of the ordinary rate. 20000 = twice, s.59(1).
   * ⚠️ Stored rather than assumed because a settlement or a standing
   * order may be more generous than the statutory minimum.
   */
  readonly multiplierBp: number;

  /** s.54: nine hours in any day → 540. State shops Acts differ. */
  readonly dailyThresholdMinutes: Minutes;
  /** s.51: forty-eight hours in any week → 2880. State shops Acts differ. */
  readonly weeklyThresholdMinutes: Minutes;
  readonly basis: OvertimeBasis;

  /**
   * 🔴 THE CAPS. s.64(4) and s.65(3) limit TOTAL hours including
   * overtime — commonly sixty in a week and ten (or ten and a half with
   * spread-over) in a day — and cap OVERTIME ITSELF PER QUARTER, s.65(3)
   * fixing fifty hours in any one quarter. State rules made under s.64
   * vary these, several states having raised the quarterly figure by
   * notification.
   *
   * ⚠️ NULL MEANS "NOT CONFIGURED FOR THIS STATE", AND THAT IS A
   * BLOCKING FINDING, NOT A LICENCE. If nobody has said what the cap is,
   * this file cannot tell a lawful eighty-hour quarter from an unlawful
   * one, and quietly paying is exactly the failure mode. Needs the
   * state's rules under s.64 confirmed by counsel before being filled in.
   */
  readonly dailyTotalCapMinutes: Minutes | null;
  readonly weeklyTotalCapMinutes: Minutes | null;
  readonly quarterlyOvertimeCapMinutes: Minutes | null;

  /**
   * ⭐ THE s.59(2) BASE, AS COMPONENT CODES. Empty refuses. See header.
   */
  readonly ordinaryRateIncludes: readonly string[];

  /**
   * ⚠️ s.2(f): a week is a period of seven days beginning at midnight on
   * Saturday night — i.e. starting SUNDAY — "or such other night as may
   * be approved in writing for a particular factory by the Chief
   * Inspector". Approval makes it configurable, so it is configured.
   * 0 = Sunday, matching `weekdayOf()`.
   */
  readonly weekStartsOnWeekday: number;

  /** ⭐ Free text: which notification this row encodes, and who confirmed it. */
  readonly authorityNote: string;
}

/**
 * ⭐ THE ROW GOVERNING THIS ESTABLISHMENT ON THIS DAY, OR NULL.
 *
 * 🔴 THE FILTER IS STATE **AND** KIND, BOTH EXACT. A factory row must
 * never answer for a shop and Karnataka's row must never answer for
 * Maharashtra: those are different statutes with different numbers, and
 * a near-miss produces a payslip that looks right and is unlawful.
 */
export function pickOvertimeRules(
  rows: readonly OvertimeRules[],
  args: {
    readonly stateCode: string;
    readonly establishmentKind: EstablishmentKind;
    readonly onDate: string;
  },
): OvertimeRules | null {
  const scoped = rows.filter(
    (r) =>
      r.stateCode === args.stateCode && r.establishmentKind === args.establishmentKind,
  );
  // ⚠️ pickEffective refuses rather than falling back to the newest row.
  return pickEffective(scoped, args.onDate);
}

/* ------------------------------------------------------------------ */
/* THE FACTS                                                           */
/* ------------------------------------------------------------------ */

/** One day somebody measured. Minutes actually worked, integer. */
export interface WorkedDayFacts {
  /** ISO `YYYY-MM-DD`. */
  readonly onDate: string;
  readonly workedMinutes: Minutes;
}

/**
 * One earning component as it stands for this period.
 *
 * ⚠️ `isBonus` and `isOvertime` ARE SUPPLIED, NOT SNIFFED FROM THE CODE.
 * s.59(2) excludes both by name; guessing from a label called "BONUS_ADH"
 * would be a string heuristic deciding a statutory base.
 */
export interface OrdinaryRateComponent {
  readonly componentCode: string;
  /** Paise, as the component stands for this period. */
  readonly amountMinor: Paise;
  readonly isBonus: boolean;
  readonly isOvertime: boolean;
}

export type FindingSeverity = "blocking" | "warning";

export interface OvertimeFinding {
  readonly code: string;
  readonly severity: FindingSeverity;
  readonly message: string;
}

export interface WeekBreakdown {
  /** ISO date of the day the week began, per `weekStartsOnWeekday`. */
  readonly weekStart: string;
  readonly workedMinutes: Minutes;
  readonly overtimeMinutes: Minutes;
}

export interface OvertimeResult {
  /** 🔴 FALSE MEANS NOTHING WAS CALCULATED. `refusal` says why. */
  readonly computed: boolean;
  readonly refusal: string | null;

  readonly overtimeMinutes: Minutes;
  readonly ordinaryBaseMinor: Paise;
  readonly overtimeWagesMinor: Paise;
  readonly multiplierBp: number;
  readonly weeks: readonly WeekBreakdown[];

  readonly findings: readonly OvertimeFinding[];
  /** 🔴 Non-empty means this must not be paid as it stands — the payslip convention. */
  readonly problems: readonly string[];
  readonly notes: readonly string[];
}

/* ------------------------------------------------------------------ */
/* INTEGER ARITHMETIC                                                  */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ HALF AWAY FROM ZERO, IN BIGINT, WITH NO `Math.floor` ANYWHERE.
 * bigint `/` truncates toward zero, so the remainder is compared on its
 * magnitude and the quotient stepped in the sign's own direction. Half
 * DOWN would bias every overtime line in the employer's favour.
 */
function divideRoundHalf(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const twiceRemainder = (remainder < 0n ? -remainder : remainder) * 2n;
  if (twiceRemainder < denominator) return quotient;
  return numerator < 0n ? quotient - 1n : quotient + 1n;
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

/**
 * ⭐⭐ THE BRIDGE FROM THE ATTENDANCE WORLD'S CENTIDAYS TO MINUTES.
 *
 * 🔴 THIS IS THE FUNCTION THE OLD `Math.floor(worked)` BUG LIVED IN.
 * A half day is 50 centidays; against an eight-hour day that is exactly
 * 240 minutes, and a quarter day exactly 120. Flooring the day to zero
 * (or ceiling it to one) is the defect that docked a full day for a half
 * day worked. The multiply happens BEFORE the divide, in bigint, so the
 * fraction survives exactly wherever it can, and the one rounding step is
 * half-away-from-zero to the whole minute.
 */
export function minutesFromDayFraction(
  centidays: Centidays,
  normalDailyMinutes: Minutes,
): Minutes {
  if (!isNonNegativeInteger(centidays) || !isNonNegativeInteger(normalDailyMinutes)) {
    return 0;
  }
  const scaled = BigInt(centidays) * BigInt(normalDailyMinutes);
  return Number(divideRoundHalf(scaled, BigInt(CENTIDAYS_PER_DAY)));
}

/**
 * ⭐ THE DIVISOR: HOW MANY ORDINARY MINUTES THIS PERIOD'S PAY BUYS.
 *
 * ⚠️ THE DIVISOR CONVENTION IS ITSELF CONTESTED. Monthly wages ÷ (days
 * on the rolls × normal daily hours) is the common reading; some rules
 * fix twenty-six days regardless of the calendar, which pays a different
 * hourly rate for the same salary. Ordence takes the payable days it
 * actually holds — in CENTIDAYS, so a half day on the rolls is half a
 * day here too — and states the convention on the result.
 * 🔴 THE TENANT'S CA MUST CONFIRM WHICH DIVISOR THEIR ESTABLISHMENT USES.
 */
export function ordinaryMinutesInPeriod(args: {
  readonly payableCentidays: Centidays;
  readonly normalDailyMinutes: Minutes;
}): Minutes {
  return minutesFromDayFraction(args.payableCentidays, args.normalDailyMinutes);
}

/**
 * ⭐ WHAT THE OVERTIME MINUTES ARE WORTH.
 *
 *   wages = ordinary base × overtime minutes × multiplier
 *           ────────────────────────────────────────────
 *              ordinary minutes in period × 10 000
 *
 * ⚠️ ONE DIVISION, AT THE END. Deriving a per-minute rate first and then
 * multiplying would round twice and lose paise on every line; the
 * payslip then does not add up to its own total. Everything is bigint,
 * so ₹30,000.50 is 3000050n and never `BigInt(30.5)`, which throws.
 */
export function overtimeWagesMinor(args: {
  readonly ordinaryBaseMinor: Paise;
  readonly ordinaryMinutesInPeriod: Minutes;
  readonly overtimeMinutes: Minutes;
  readonly multiplierBp: number;
}): Paise {
  if (
    !isNonNegativeInteger(args.ordinaryMinutesInPeriod) ||
    args.ordinaryMinutesInPeriod === 0 ||
    !isNonNegativeInteger(args.overtimeMinutes) ||
    !isNonNegativeInteger(args.multiplierBp)
  ) {
    return 0n;
  }
  const numerator =
    args.ordinaryBaseMinor * BigInt(args.overtimeMinutes) * BigInt(args.multiplierBp);
  const denominator = BigInt(args.ordinaryMinutesInPeriod) * 10_000n;
  return divideRoundHalf(numerator, denominator);
}

/* ------------------------------------------------------------------ */
/* THE s.59(2) BASE                                                    */
/* ------------------------------------------------------------------ */

export interface OrdinaryBaseResult {
  readonly baseMinor: Paise;
  readonly includedCodes: readonly string[];
  readonly findings: readonly OvertimeFinding[];
}

/**
 * ⭐⭐ THE ORDINARY RATE OF WAGES, s.59(2).
 *
 * The configured list decides what is in. Two things this file enforces
 * on its own, because s.59(2) settles them in terms and no configuration
 * may override them:
 *   🔴 A BONUS IS OUT.
 *   🔴 OVERTIME IS OUT OF ITS OWN BASE. Including last month's overtime
 *      compounds the multiplier month on month.
 * Both are BLOCKING, not silent exclusions: the configuration is wrong
 * and somebody has to fix it, and a payslip computed from a base the
 * operator did not intend is worse than one that refuses.
 */
export function ordinaryRateBase(args: {
  readonly earnings: readonly OrdinaryRateComponent[];
  readonly includeCodes: readonly string[];
}): OrdinaryBaseResult {
  const findings: OvertimeFinding[] = [];
  const wanted = new Set(args.includeCodes);
  const included: string[] = [];
  let base = 0n;

  for (const earning of args.earnings) {
    if (!wanted.has(earning.componentCode)) continue;
    if (earning.isBonus) {
      findings.push({
        code: "ordinary_rate_includes_bonus",
        severity: "blocking",
        message: `"${earning.componentCode}" is a bonus and section 59(2) of the Factories Act excludes a bonus from the ordinary rate of wages. Remove it from the overtime base configuration.`,
      });
      continue;
    }
    if (earning.isOvertime) {
      findings.push({
        code: "ordinary_rate_includes_overtime",
        severity: "blocking",
        message: `"${earning.componentCode}" is overtime pay and section 59(2) excludes wages for overtime work from the ordinary rate. Overtime cannot form part of its own base.`,
      });
      continue;
    }
    base += earning.amountMinor;
    included.push(earning.componentCode);
  }

  // ⚠️ A CONFIGURED CODE THAT IS NOT ON THIS PAYSLIP IS SILENT MONEY.
  // It may be legitimate (an allowance this employee does not draw) or a
  // typo that quietly shrinks the base, so it is stated, not swallowed.
  for (const code of args.includeCodes) {
    if (!args.earnings.some((e) => e.componentCode === code)) {
      findings.push({
        code: "ordinary_rate_component_absent",
        severity: "warning",
        message: `The overtime base is configured to include "${code}", but this employee has no such earning this period. Nothing has been counted for it.`,
      });
    }
  }

  return { baseMinor: base, includedCodes: included, findings };
}

/* ------------------------------------------------------------------ */
/* WEEKS                                                               */
/* ------------------------------------------------------------------ */

const MS_PER_DAY = 86_400_000;

function weekStartIso(onDate: string, weekStartsOnWeekday: number): string | null {
  const ms = Date.parse(`${onDate}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  const weekday = new Date(ms).getUTCDay();
  // ⚠️ `+ 7) % 7` because the offset must never be negative: a Sunday
  // week start against a Saturday date is 6 days back, not -1 forward.
  const back = (weekday - weekStartsOnWeekday + 7) % 7;
  return new Date(ms - back * MS_PER_DAY).toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ */
/* THE CALCULATION                                                     */
/* ------------------------------------------------------------------ */

export interface OvertimeInput {
  /** 🔴 Null means no rule is on file for this state — the refusal case. */
  readonly rules: OvertimeRules | null;
  /** Named only so a refusal can say WHICH state is unconfigured. */
  readonly stateCode: string;
  readonly establishmentKind: EstablishmentKind;
  readonly days: readonly WorkedDayFacts[];
  readonly earnings: readonly OrdinaryRateComponent[];
  readonly ordinaryMinutesInPeriod: Minutes;
  /**
   * ⚠️ OVERTIME ALREADY WORKED EARLIER IN THE SAME QUARTER. The s.65(3)
   * cap is per QUARTER, so a period that is lawful on its own can be the
   * one that breaches. A caller with no quarter history passes 0 and gets
   * a stated assumption back rather than a false clean bill.
   */
  readonly quarterToDateOvertimeMinutes: Minutes;
  /** True when the caller genuinely has the quarter's earlier overtime. */
  readonly quarterToDateIsKnown: boolean;
}

function refuse(reason: string): OvertimeResult {
  return {
    computed: false,
    refusal: reason,
    overtimeMinutes: 0,
    ordinaryBaseMinor: 0n,
    overtimeWagesMinor: 0n,
    multiplierBp: 0,
    weeks: [],
    findings: [],
    problems: [reason],
    notes: [],
  };
}

/**
 * ⭐⭐⭐ THE WHOLE THING.
 *
 * 🔴 A REFUSAL IS A RESULT. Every path that cannot be certain returns
 * `computed: false` with a sentence saying what is missing, and puts the
 * same sentence in `problems` so the existing "a run with problems
 * cannot be approved" machinery stops it without knowing what overtime
 * is. A guess that looks finished is the failure this shape exists to
 * prevent.
 */
export function computeOvertime(input: OvertimeInput): OvertimeResult {
  const rules = input.rules;

  /* ---- ① No rule for the state → refuse, never fall back ---------- */
  if (rules === null) {
    return refuse(
      `No overtime rules are configured for ${input.stateCode} (${input.establishmentKind === "factory" ? "factory" : "shop or commercial establishment"}). Overtime thresholds, the multiplier and the statutory caps differ between the Factories Act 1948 and each state's Shops and Establishments Act, so nothing has been calculated. Configure a rate row for this state and period before running overtime.`,
    );
  }
  if (rules.stateCode !== input.stateCode || rules.establishmentKind !== input.establishmentKind) {
    // ⚠️ Belt and braces against a caller selecting the row itself and
    // handing over a neighbouring state's numbers.
    return refuse(
      `The overtime rules supplied are for ${rules.stateCode} (${rules.establishmentKind}) but this establishment is in ${input.stateCode} (${input.establishmentKind}). One state's rules may not be applied to another.`,
    );
  }
  if (rules.ordinaryRateIncludes.length === 0) {
    return refuse(
      `The overtime base for ${input.stateCode} is not configured. Section 59(2) of the Factories Act defines the ordinary rate of wages as basic wages plus the allowances the worker is entitled to, excluding bonus and overtime — it is neither gross pay nor basic alone, so it cannot be guessed. List the pay components that make up the ordinary rate.`,
    );
  }
  if (rules.multiplierBp <= 0) {
    return refuse(
      `The overtime multiplier configured for ${input.stateCode} is not a positive rate, so no overtime wage can be calculated.`,
    );
  }
  if (
    !isNonNegativeInteger(input.ordinaryMinutesInPeriod) ||
    input.ordinaryMinutesInPeriod === 0
  ) {
    return refuse(
      "The number of ordinary working minutes in this period is zero or unknown, so there is nothing to divide the monthly wage by and no hourly rate can be derived.",
    );
  }
  if (!isNonNegativeInteger(rules.dailyThresholdMinutes) || !isNonNegativeInteger(rules.weeklyThresholdMinutes)) {
    return refuse(
      `The daily or weekly overtime threshold configured for ${input.stateCode} is not a whole number of minutes.`,
    );
  }
  for (const day of input.days) {
    if (!isNonNegativeInteger(day.workedMinutes)) {
      return refuse(
        `Hours worked on ${day.onDate} are not a whole number of minutes. Overtime is counted in whole minutes so that a part hour is never lost to rounding; fix the attendance record rather than approximating it.`,
      );
    }
  }

  const findings: OvertimeFinding[] = [];
  const notes: string[] = [];

  /* ---- ② The base, s.59(2) ---------------------------------------- */
  const base = ordinaryRateBase({
    earnings: input.earnings,
    includeCodes: rules.ordinaryRateIncludes,
  });
  findings.push(...base.findings);
  notes.push(
    `Ordinary rate of wages taken as ${base.includedCodes.length > 0 ? base.includedCodes.join(" + ") : "no component"} — section 59(2), Factories Act 1948, which is basic wages plus entitled allowances and excludes bonus and overtime. Divided by ${input.ordinaryMinutesInPeriod} ordinary working minutes in the period.`,
  );

  /* ---- ③ The multiplier ------------------------------------------- */
  // 🔴 A FACTORY MAY NOT PAY LESS THAN TWICE. s.59(1) fixes it, and
  // 1.5× — the American rate — is the defect this check exists to catch
  // even when it arrives as configured data rather than as code.
  if (
    rules.establishmentKind === "factory" &&
    rules.multiplierBp < FACTORIES_ACT_MIN_MULTIPLIER_BP
  ) {
    findings.push({
      code: "multiplier_below_statutory_minimum",
      severity: "blocking",
      message: `The configured overtime multiplier is ${(rules.multiplierBp / 10_000).toFixed(2)}× the ordinary rate. Section 59(1) of the Factories Act 1948 entitles a worker to wages at TWICE the ordinary rate for overtime; anything less is a shortfall an inspector can order recovered.`,
    });
  }
  if (
    rules.establishmentKind === "shops_and_establishments" &&
    rules.multiplierBp < FACTORIES_ACT_MIN_MULTIPLIER_BP
  ) {
    // ⚠️ NOT ASSERTED AS UNLAWFUL. Shops Acts are state law and a few
    // prescribe a different multiplier. Flagged for confirmation instead
    // of being declared a breach this file cannot prove.
    findings.push({
      code: "multiplier_below_factories_act_rate",
      severity: "warning",
      message: `The overtime multiplier configured for ${input.stateCode} is below twice the ordinary rate. Most state Shops and Establishments Acts follow the Factories Act's double rate. Have counsel confirm this state's section before paying at it.`,
    });
  }

  /* ---- ④ The minutes ----------------------------------------------- */
  const weekTotals = new Map<string, number>();
  let dailyExcess = 0;

  for (const day of input.days) {
    const excess = day.workedMinutes - rules.dailyThresholdMinutes;
    // ⚠️ No `Math.floor`, no clamp on a float: integers only, and a day
    // under the threshold contributes zero rather than a negative that
    // would cancel out another day's overtime.
    if (excess > 0) dailyExcess += excess;

    if (
      rules.dailyTotalCapMinutes !== null &&
      day.workedMinutes > rules.dailyTotalCapMinutes
    ) {
      findings.push({
        code: "daily_total_cap_exceeded",
        severity: "blocking",
        message: `${day.onDate}: ${describeMinutes(day.workedMinutes)} worked in one day against a configured limit of ${describeMinutes(rules.dailyTotalCapMinutes)} including overtime (sections 64 and 65, Factories Act 1948). Working these hours is an offence by the employer under section 92 — paying them does not cure it.`,
      });
    }

    const start = weekStartIso(day.onDate, rules.weekStartsOnWeekday);
    if (start === null) {
      return refuse(`The attendance date "${day.onDate}" is not a valid date.`);
    }
    weekTotals.set(start, (weekTotals.get(start) ?? 0) + day.workedMinutes);
  }

  const weeks: WeekBreakdown[] = [];
  let weeklyExcess = 0;

  for (const [weekStart, workedMinutes] of [...weekTotals].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const excess = workedMinutes - rules.weeklyThresholdMinutes;
    const overtimeThisWeek = excess > 0 ? excess : 0;
    weeklyExcess += overtimeThisWeek;
    weeks.push({ weekStart, workedMinutes, overtimeMinutes: overtimeThisWeek });

    if (
      rules.weeklyTotalCapMinutes !== null &&
      workedMinutes > rules.weeklyTotalCapMinutes
    ) {
      findings.push({
        code: "weekly_total_cap_exceeded",
        severity: "blocking",
        message: `Week beginning ${weekStart}: ${describeMinutes(workedMinutes)} worked against a configured limit of ${describeMinutes(rules.weeklyTotalCapMinutes)} including overtime (sections 64 and 65, Factories Act 1948). This is an offence by the employer under section 92, not a payroll adjustment.`,
      });
    }
  }

  const overtimeMinutes =
    rules.basis === "daily"
      ? dailyExcess
      : rules.basis === "weekly"
        ? weeklyExcess
        : dailyExcess > weeklyExcess
          ? dailyExcess
          : weeklyExcess;

  /* ---- ⑤ The quarterly cap ----------------------------------------- */
  // 🔴 THE CAP IS PER QUARTER AS WELL AS PER WEEK. s.65(3) limits total
  // overtime to fifty hours in any one quarter (state rules under s.64
  // vary the figure). A month that is lawful on its own can be the month
  // that breaches, which is why the quarter's earlier overtime is an input.
  if (rules.quarterlyOvertimeCapMinutes === null) {
    findings.push({
      code: "quarterly_cap_not_configured",
      severity: "blocking",
      message: `No quarterly overtime cap is configured for ${input.stateCode}. Section 65(3) of the Factories Act caps overtime per quarter and state rules under section 64 vary the figure, so this run cannot tell a lawful quarter from an unlawful one. Have the state's rules confirmed and recorded before paying overtime.`,
    });
  } else if (!input.quarterToDateIsKnown) {
    findings.push({
      code: "quarter_to_date_unknown",
      severity: "warning",
      message: `Overtime already worked earlier this quarter is not known to this run, so only this period's ${describeMinutes(overtimeMinutes)} has been tested against the quarterly cap of ${describeMinutes(rules.quarterlyOvertimeCapMinutes)}.`,
    });
  }

  if (rules.quarterlyOvertimeCapMinutes !== null) {
    const quarterTotal =
      (isNonNegativeInteger(input.quarterToDateOvertimeMinutes)
        ? input.quarterToDateOvertimeMinutes
        : 0) + overtimeMinutes;
    if (quarterTotal > rules.quarterlyOvertimeCapMinutes) {
      findings.push({
        code: "quarterly_overtime_cap_exceeded",
        severity: "blocking",
        message: `${describeMinutes(quarterTotal)} of overtime this quarter against a cap of ${describeMinutes(rules.quarterlyOvertimeCapMinutes)} (section 65(3), Factories Act 1948, as varied by the rules of ${input.stateCode}). The hours over the cap were worked unlawfully; the wages are still owed, but the breach has to be answered for.`,
      });
    }
  }

  /* ---- ⑥ The money ------------------------------------------------- */
  const wages = overtimeWagesMinor({
    ordinaryBaseMinor: base.baseMinor,
    ordinaryMinutesInPeriod: input.ordinaryMinutesInPeriod,
    overtimeMinutes,
    multiplierBp: rules.multiplierBp,
  });

  notes.push(
    `${describeMinutes(overtimeMinutes)} of overtime at ${(rules.multiplierBp / 10_000).toFixed(2)}× the ordinary rate (${rules.basis === "greater_of" ? "the greater of the daily and the weekly excess" : rules.basis === "daily" ? "daily excess only" : "weekly excess only"}), section 59(1).`,
  );
  if (rules.authorityNote.length > 0) notes.push(rules.authorityNote);

  return {
    computed: true,
    refusal: null,
    overtimeMinutes,
    ordinaryBaseMinor: base.baseMinor,
    overtimeWagesMinor: wages,
    multiplierBp: rules.multiplierBp,
    weeks,
    findings,
    // 🔴 EVERY BLOCKING FINDING BECOMES A PROBLEM. `problems` is the
    // word the rest of payroll already understands as "must not be paid
    // as it stands", so a cap breach stops a run without the run knowing
    // anything about the Factories Act.
    problems: findings.filter((f) => f.severity === "blocking").map((f) => f.message),
    notes,
  };
}

/**
 * ⚠️ MINUTES → WORDS, WITHOUT A FLOAT AND WITHOUT FLOORING TO ZERO.
 * "7 hours 30 minutes", never "7 hours" and never "8".
 */
export function describeMinutes(minutes: Minutes): string {
  if (!Number.isInteger(minutes)) return `${minutes} minutes`;
  const negative = minutes < 0;
  const total = negative ? -minutes : minutes;
  const hours = (total - (total % MINUTES_PER_HOUR)) / MINUTES_PER_HOUR;
  const rest = total % MINUTES_PER_HOUR;
  const sign = negative ? "-" : "";
  if (hours === 0) return `${sign}${rest} minute${rest === 1 ? "" : "s"}`;
  if (rest === 0) return `${sign}${hours} hour${hours === 1 ? "" : "s"}`;
  return `${sign}${hours} hour${hours === 1 ? "" : "s"} ${rest} minute${rest === 1 ? "" : "s"}`;
}

/* ------------------------------------------------------------------ */
/* READING A RULE ROW OUT OF `statutory_rates`                         */
/* ------------------------------------------------------------------ */

function intOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * ⭐ `statutory_rates` jsonb → rules, or NULL IF IT DOES NOT PARSE.
 *
 * 🔴 A MALFORMED ROW MUST BECOME A REFUSAL, NOT A ZERO. `loadRates()`
 * already works this way for PF and ESI, and for the same reason: a
 * silent zero multiplier looks like a correctly calculated exemption.
 * No new table and no migration — `kind = 'overtime'`, `scope = state`.
 */
export function asOvertimeRules(
  payload: unknown,
  scope: string,
  effectiveFrom: string,
  effectiveTo: string | null,
): OvertimeRules | null {
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;

  const kind = p["establishmentKind"];
  if (kind !== "factory" && kind !== "shops_and_establishments") return null;

  const basis = p["basis"];
  if (basis !== "daily" && basis !== "weekly" && basis !== "greater_of") return null;

  const multiplierBp = intOrNull(p["multiplierBp"]);
  const dailyThresholdMinutes = intOrNull(p["dailyThresholdMinutes"]);
  const weeklyThresholdMinutes = intOrNull(p["weeklyThresholdMinutes"]);
  if (multiplierBp === null || multiplierBp === 0) return null;
  if (dailyThresholdMinutes === null || weeklyThresholdMinutes === null) return null;

  const weekStart = intOrNull(p["weekStartsOnWeekday"]);
  if (weekStart === null || weekStart > 6) return null;

  const includes = p["ordinaryRateIncludes"];
  if (!Array.isArray(includes)) return null;
  const codes = includes.filter((c): c is string => typeof c === "string" && c.length > 0);
  // ⚠️ An empty list is KEPT rather than rejected here, so that
  // `computeOvertime` refuses with the sentence that names section 59(2)
  // instead of the generic "no rules for this state".
  if (scope.length === 0) return null;

  return {
    stateCode: scope,
    establishmentKind: kind,
    multiplierBp,
    dailyThresholdMinutes,
    weeklyThresholdMinutes,
    basis,
    dailyTotalCapMinutes: intOrNull(p["dailyTotalCapMinutes"]),
    weeklyTotalCapMinutes: intOrNull(p["weeklyTotalCapMinutes"]),
    quarterlyOvertimeCapMinutes: intOrNull(p["quarterlyOvertimeCapMinutes"]),
    ordinaryRateIncludes: codes,
    weekStartsOnWeekday: weekStart,
    authorityNote: typeof p["authorityNote"] === "string" ? p["authorityNote"] : "",
    effectiveFrom,
    effectiveTo,
  };
}
