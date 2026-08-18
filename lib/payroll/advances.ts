/**
 * Ordence — ⭐⭐⭐ SALARY ADVANCES AND EMPLOYEE LOANS
 * Version: v1.52.0-alpha
 *
 * Pure. No database, no network, no clock.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE RECOVERY IS A SECTION 7 DEDUCTION EVERY SINGLE MONTH
 * ══════════════════════════════════════════════════════════════════════
 * `lib/payroll/settlement.ts` already encodes the Payment of Wages Act,
 * 1936: the exhaustive list in s.7(2), and the s.7(3) proviso capping
 * the TOTAL of deductions at fifty per cent of the wages of the wage
 * period — seventy-five where any part of them is a payment to a
 * co-operative society under s.7(2)(j).
 *
 * ⭐⭐ THAT CAP IS NOT AN EXIT RULE. It says "the wages of any wage
 * period", and a monthly instalment off a live payslip is a deduction of
 * that wage period exactly as a settlement recovery is. So this file
 * IMPORTS `deductionCapBp`, `maximumLawfulDeductionMinor` and
 * `RECOVERY_HEAD_BY_KIND` and calls them. It defines no cap of its own.
 *
 * 🔴 A SECOND CAP WOULD BE WORSE THAN NO CAP. Two implementations that
 * agree today diverge the first time one is corrected — and the symptom
 * is that the monthly deduction and the final settlement disagree about
 * how much may lawfully be taken from the same person.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ SECTION 12 — AN ADVANCE NEEDS AN AGREED SCHEDULE, NOT A DIAL
 * ══════════════════════════════════════════════════════════════════════
 * s.7(2)(f) permits a deduction "for recovery of advances or for
 * adjustment of over-payments of wages", and s.12 then constrains HOW:
 *
 *   • s.12(a) — an advance made BEFORE the employment began is recovered
 *     from the first payment of wages, but no recovery may be made of
 *     an advance given for travelling expenses;
 *   • s.12(aa) — an advance made after employment began is subject to
 *     such conditions as the State Government may impose;
 *   • s.12(b) — recovery of an advance of WAGES NOT ALREADY EARNED is
 *     subject to rules made by the State Government "regulating the
 *     extent to which such advances may be given and the instalments by
 *     which they may be recovered".
 *
 * 🔴 SO AN OPEN-ENDED "DEDUCT WHAT YOU LIKE THIS MONTH" IS NOT LAWFUL
 * EVEN WHEN IT IS UNDER THE CAP. What is lawful is an agreed schedule.
 * This module therefore models an AGREEMENT with a fixed number of
 * fixed instalments, dated, referenced and consented to, and there is
 * no API anywhere in it for deducting an arbitrary amount.
 *
 * ⚠️ AND THE STATE RULES ARE NOT GUESSED. `AdvanceLimits` is null by
 * default and the engine says so on the result. A number invented here
 * would be wrong in most States and confidently applied in all of them.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 A LOAN IS A RECEIVABLE. IT IS NOT PAYROLL COST.
 * ══════════════════════════════════════════════════════════════════════
 * Disbursing ₹1,00,000 to an employee does not make the business ₹1,00,000
 * poorer: it converts cash into a claim on the employee. The entry is
 * Dr Employee Advances (ASSET) / Cr Bank, and each recovery is
 * Dr Salaries Payable / Cr Employee Advances. Routing the disbursement
 * through Salaries and Wages would overstate the wage bill, understate
 * assets, and — because the recoveries then have nowhere to go —
 * eventually credit the expense in a later period.
 *
 * ⚠️ `advanceLedgerIntent()` below states the two legs and the account
 * TYPE. 🔴 IT DOES NOT POST. There is no `employee_advance` posting role
 * in `lib/accounting/sales-posting.ts` and inventing one from here would
 * mean a chart-of-accounts mapping nobody has configured. STATED GAP:
 * advances are not yet in the ledger. The intent exists so the day the
 * role is added, nothing has to be re-derived — and so that nobody wires
 * the disbursement to `salary_expense` because it was the nearest role
 * to hand.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 WHAT IS NOT COMPUTED, SAID PLAINLY
 * ══════════════════════════════════════════════════════════════════════
 * ① THE PERQUISITE ON AN INTEREST-FREE OR CONCESSIONAL LOAN. Rule 3(7)(i)
 *   of the Income-tax Rules, 1962 values it on the maximum outstanding
 *   monthly balance using the State Bank of India's rate for the same
 *   kind of loan as on the first day of the relevant previous year, with
 *   exceptions for small aggregate loans and for the treatment of
 *   specified diseases. THE RATE IS AN EXTERNAL ANNUAL FACT ORDENCE DOES
 *   NOT HOLD, the "same kind of loan" mapping is a judgement, and the
 *   exception thresholds move. ⚠️ IT IS THEREFORE NOT VALUED HERE. The
 *   engine computes and exposes the maximum outstanding monthly balance,
 *   which is the input the valuation needs, marks the advance
 *   `perquisiteValuation: "not_computed"`, and says on the result that a
 *   CA must value it. A number produced from a guessed SBI rate would be
 *   a wrong perquisite added to somebody's taxable salary.
 * ② THE PERQUISITE ON A WRITE-OFF. A loan waived is a benefit and is
 *   taxable, but WHICH head — s.17(2) perquisite or s.17(3) profit in
 *   lieu of salary — and in which year, depends on the terms of the
 *   waiver. Marked, not computed.
 * ③ INTEREST INCOME. A loan carrying interest produces income for the
 *   employer. Not modelled; the schedule here amortises PRINCIPAL only
 *   and says so.
 */

import type { Paise } from "./statutory";
import {
  RECOVERY_HEAD_BY_KIND,
  deductionCapBp,
  maximumLawfulDeductionMinor,
  type Recovery,
  type RecoveryKind,
} from "./settlement";

/* ================================================================== */
/* ① THE AGREEMENT                                                     */
/* ================================================================== */

/**
 * ⚠️ THE KIND IS NOT COSMETIC — IT PICKS THE CLAUSE. `salary_advance`
 * recovers under s.7(2)(f) read with s.12; the two loan kinds recover
 * under s.7(2)(fff) and s.7(2)(ffff), which s.12 does not constrain in
 * the same way because a housing or welfare loan is not an advance of
 * unearned wages.
 */
export type AdvanceKind = "salary_advance" | "welfare_loan" | "house_building_loan";

/** ⭐ ONE MAPPING, so a head can never be chosen by a screen. */
export const ADVANCE_RECOVERY_KIND: Readonly<Record<AdvanceKind, RecoveryKind>> = Object.freeze({
  salary_advance: "advance_or_overpayment",
  welfare_loan: "loan",
  house_building_loan: "loan",
});

/**
 * 🔴 THE STATE RULES UNDER s.12(b), UNKNOWN UNTIL SOMEBODY ENTERS THEM.
 *
 * ⚠️ NULL IS THE HONEST DEFAULT AND IT IS NOT A FAILURE. The engine
 * still builds the schedule and still applies the s.7(3) cap; it simply
 * records that the State-specific extent-and-instalments rule has not
 * been configured, so the employer knows what has NOT been checked.
 */
export interface AdvanceLimits {
  /** e.g. "KA" — whose rules these are. */
  readonly stateCode: string;
  /** Paise, or null where the rule is expressed in months of wages. */
  readonly maximumAdvanceMinor?: string | null;
  /** The State rule's ceiling on the number of monthly instalments. */
  readonly maximumInstalments?: number | null;
  /** ⭐ The rule, cited, so an inspector can be shown it. */
  readonly reference: string;
}

export interface AdvanceAgreement {
  readonly kind: AdvanceKind;
  /** Paise. What was actually handed over. Never a float, never rupees. */
  readonly principalMinor: string;
  /** ⚠️ Fixed at the outset. s.12(b) speaks of "the instalments". */
  readonly instalmentCount: number;
  /** "YYYY-MM" — the wage period the first instalment falls in. */
  readonly firstRecoveryPeriod: string;
  /** The signed agreement or advance voucher. Printed on every payslip. */
  readonly agreementReference: string;
  /** ISO date the employee agreed to the schedule. */
  readonly employeeConsentedOn: string;
  /**
   * ⚠️ Basis points per annum, 0 for interest-free. Recorded because it
   * decides whether ① above is in play. NOT amortised — see the header.
   */
  readonly interestRateBp: number;
  /** Null where the State's s.12(b) rules have not been configured. */
  readonly limits?: AdvanceLimits | null;
}

/* ================================================================== */
/* ② THE SCHEDULE — IT SUMS TO THE PRINCIPAL, EXACTLY                  */
/* ================================================================== */

export interface ScheduledInstalment {
  /** 1-based, and stable across deferrals so the ledger can name it. */
  readonly seq: number;
  /** "YYYY-MM". Moves when an instalment is deferred; `seq` does not. */
  readonly period: string;
  readonly amountMinor: Paise;
}

export interface InstalmentSchedule {
  readonly instalments: readonly ScheduledInstalment[];
  readonly totalMinor: Paise;
  readonly problems: readonly string[];
  readonly notes: readonly string[];
}

/** ⭐ "YYYY-MM" + n months, pure. No Date arithmetic across time zones. */
export function addMonths(period: string, months: number): string {
  const [ys, ms] = period.split("-");
  const y = Number(ys);
  const m = Number(ms);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return period;
  const zero = y * 12 + (m - 1) + Math.trunc(months);
  const ny = Math.floor(zero / 12);
  const nm = zero - ny * 12 + 1;
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}`;
}

/**
 * ⭐⭐ THE FINAL INSTALMENT ABSORBS THE REMAINDER, AND THAT IS THE WHOLE
 * TRICK.
 *
 * 🔴 ₹10,000 over three months is 3,333.33 recurring. A schedule of
 * three equal instalments recovers either one paise too little (the
 * employee owes ₹0.01 forever and the advance never closes) or one paise
 * too much (the employer has taken money it was not owed, which is an
 * unauthorised deduction under s.7(1) however trivial the amount).
 *
 * ⚠️ SO THE ARITHMETIC IS: base = principal ÷ n in INTEGER paise, and
 * the last instalment is base + (principal − base×n). The sum is the
 * principal by construction rather than by rounding luck, and there is
 * a test that asserts it for a range of awkward principals.
 *
 * ⚠️ THE REMAINDER GOES LAST, NOT FIRST. Front-loading it would take the
 * extra paise from the employee earlier, and — far more visibly — would
 * make the first instalment the odd one on a payslip everybody reads.
 */
export function buildInstalmentSchedule(agreement: AdvanceAgreement): InstalmentSchedule {
  const problems: string[] = [];
  const notes: string[] = [];

  const principal = BigInt(agreement.principalMinor);
  const n = Math.trunc(agreement.instalmentCount);

  if (principal <= 0n) {
    problems.push("An advance of nothing is not an advance. State the principal in paise.");
    return { instalments: [], totalMinor: 0n, problems, notes };
  }
  if (n < 1) {
    problems.push(
      "The number of instalments must be at least one. s.12(b) of the Payment of Wages Act, 1936 contemplates recovery BY INSTALMENTS agreed in advance, not a deduction decided month by month.",
    );
    return { instalments: [], totalMinor: 0n, problems, notes };
  }
  if (!/^\d{4}-\d{2}$/.test(agreement.firstRecoveryPeriod)) {
    problems.push("The first recovery period must be a wage period in YYYY-MM form.");
    return { instalments: [], totalMinor: 0n, problems, notes };
  }
  if (agreement.employeeConsentedOn.trim().length === 0 || agreement.agreementReference.trim().length === 0) {
    problems.push(
      "An advance recovered from wages needs a written agreement and a date the employee consented to the instalments. Without them the deduction rests on nothing s.7(2)(f) and s.12 recognise.",
    );
  }

  const count = BigInt(n);
  const base = principal / count;
  const remainder = principal - base * count;

  const instalments: ScheduledInstalment[] = [];
  for (let i = 0; i < n; i += 1) {
    const isLast = i === n - 1;
    instalments.push({
      seq: i + 1,
      period: addMonths(agreement.firstRecoveryPeriod, i),
      amountMinor: isLast ? base + remainder : base,
    });
  }

  const total = instalments.reduce((s, x) => s + x.amountMinor, 0n);
  // 🔴 A BELT-AND-BRACES ASSERTION THAT IS NOT A TEST. If this ever
  // fires, the schedule is not the advance and no instalment may be
  // recovered from anybody's wages until it is.
  if (total !== principal) {
    problems.push(
      `The schedule sums to ${total.toString()} paise against a principal of ${principal.toString()}. It has NOT been issued.`,
    );
    return { instalments: [], totalMinor: 0n, problems, notes };
  }

  const limits = agreement.limits ?? null;
  if (limits === null) {
    notes.push(
      "⚠️ The State rules under s.12(b) of the Payment of Wages Act, 1936 — the extent to which advances of unearned wages may be given and the instalments by which they may be recovered — are NOT configured for this establishment. The s.7(3) cap is applied regardless, but the State's own limits have not been checked. They must be entered before this is relied on.",
    );
  } else {
    if (limits.maximumInstalments !== null && limits.maximumInstalments !== undefined && n > limits.maximumInstalments) {
      problems.push(
        `The schedule has ${n} instalments; ${limits.stateCode} permits ${limits.maximumInstalments} under ${limits.reference}.`,
      );
    }
    if (
      limits.maximumAdvanceMinor !== null &&
      limits.maximumAdvanceMinor !== undefined &&
      principal > BigInt(limits.maximumAdvanceMinor)
    ) {
      problems.push(
        `The advance exceeds the maximum ${limits.stateCode} permits under ${limits.reference}.`,
      );
    }
  }

  if (agreement.interestRateBp === 0) {
    notes.push(
      "⚠️ This advance is interest-free. Rule 3(7)(i) of the Income-tax Rules, 1962 treats a concessional or interest-free loan as a PERQUISITE. Ordence does NOT value it — the SBI rate for the corresponding kind of loan as on the first day of the previous year is not held here, and the small-loan and specified-disease exceptions are judgements. A CA must value the perquisite from `maximumOutstandingMinor`.",
    );
  }

  return { instalments, totalMinor: total, problems, notes };
}

/* ================================================================== */
/* ③ THE BALANCE — DERIVED, NEVER STORED                               */
/* ================================================================== */

/**
 * ⭐ ONE ROW PER RECOVERY ACTUALLY MADE. This is the ledger, and it is
 * append-only in the database (see 0096) for the same reason
 * `audit_logs` is: a recovery that can be edited afterwards is not
 * evidence that the recovery happened.
 */
export interface RecoveryLedgerEntry {
  /** "YYYY-MM" — the wage period the deduction was taken in. */
  readonly period: string;
  /** Paise actually deducted from that period's wages. */
  readonly amountMinor: string;
  /** The payslip it came off, so the employee can check it. */
  readonly payslipReference: string;
}

/**
 * 🔴🔴 THE OUTSTANDING BALANCE IS FOLDED FROM THE LEDGER. THERE IS NO
 * `outstanding_minor` COLUMN AND THERE MUST NEVER BE ONE.
 *
 * ⚠️ A RUNNING COUNTER DRIFTS, AND IT DRIFTS AGAINST A PERSON. Every
 * failure mode is a real one: a payroll run reversed and re-run
 * decrements twice; a recovery voided leaves the counter high; a
 * concurrent update on two payslips in the same run loses one. Nothing
 * complains, because a counter has no way to know it is wrong. The
 * employee then either has money taken after the advance was repaid, or
 * carries a debt that was already settled — and the record that would
 * have shown it is the record that was overwritten.
 *
 * ⭐ FOLDING COSTS ONE SUM OVER A HANDFUL OF ROWS AND CANNOT DISAGREE
 * WITH ITSELF. `advance_no` + the ledger IS the balance.
 */
export function outstandingMinor(
  principalMinor: string,
  ledger: readonly RecoveryLedgerEntry[],
  writtenOffMinor: string = "0",
): Paise {
  const recovered = ledger.reduce((s, e) => s + BigInt(e.amountMinor), 0n);
  const out = BigInt(principalMinor) - recovered - BigInt(writtenOffMinor);
  // ⚠️ Clamped at zero for DISPLAY only. An over-recovery is a real
  // event and `overRecoveredMinor` below reports it rather than hiding
  // it inside a negative balance nobody reads.
  return out > 0n ? out : 0n;
}

/** 🔴 Money taken beyond the principal. Refundable, and never netted. */
export function overRecoveredMinor(
  principalMinor: string,
  ledger: readonly RecoveryLedgerEntry[],
  writtenOffMinor: string = "0",
): Paise {
  const recovered = ledger.reduce((s, e) => s + BigInt(e.amountMinor), 0n);
  const excess = recovered + BigInt(writtenOffMinor) - BigInt(principalMinor);
  return excess > 0n ? excess : 0n;
}

/**
 * ⭐ THE INPUT Rule 3(7)(i) NEEDS, computed even though the valuation is
 * not. The perquisite is valued on the MAXIMUM OUTSTANDING MONTHLY
 * BALANCE, so it is folded here from the same ledger.
 */
export function maximumOutstandingMinor(
  principalMinor: string,
  ledger: readonly RecoveryLedgerEntry[],
): Paise {
  let running = BigInt(principalMinor);
  let max = running;
  // ⚠️ Sorted by period so a ledger inserted out of order still yields
  // the true maximum rather than the order rows happened to arrive in.
  const ordered = [...ledger].sort((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : 0));
  for (const e of ordered) {
    if (running > max) max = running;
    running -= BigInt(e.amountMinor);
  }
  return max > 0n ? max : 0n;
}

/* ================================================================== */
/* ④ THE MONTHLY RECOVERY — THE s.7(3) CAP, IMPORTED                   */
/* ================================================================== */

export interface PeriodRecoveryArgs {
  /** "YYYY-MM". The wage period the cap is measured over — s.7(3). */
  readonly period: string;
  /**
   * 🔴 THE WAGES OF THAT WAGE PERIOD, IN PAISE. Supplied by the payslip.
   * ⚠️ It is the caller's job to hand over WAGES as s.2(vi) defines
   * them, and specifically not a gross that has had a non-wage
   * reimbursement folded into it — see `lib/payroll/reimbursements.ts`.
   * Enlarging the base enlarges the lawful deduction.
   */
  readonly wagesForPeriodMinor: string;
  /**
   * ⭐ EVERY OTHER DEDUCTION OF THE SAME WAGE PERIOD, as `Recovery`
   * values so the imported machinery sees them unchanged: PF under
   * s.7(2)(i), income tax under s.7(2)(g), a co-operative society
   * subscription under s.7(2)(j) — which is the one that lifts the cap.
   */
  readonly otherDeductions: readonly Recovery[];
  readonly instalment: ScheduledInstalment;
  readonly kind: AdvanceKind;
  readonly agreementReference: string;
  /** Folded from the ledger, so the last instalment cannot over-recover. */
  readonly outstandingMinor: Paise;
}

export interface PeriodRecoveryDecision {
  readonly period: string;
  readonly capBaseMinor: Paise;
  /** 5000, or 7500 — from `deductionCapBp`, never recomputed here. */
  readonly capBp: number;
  readonly maximumLawfulDeductionMinor: Paise;
  readonly otherDeductionsMinor: Paise;
  /** What is left under the cap once the other deductions are counted. */
  readonly headroomMinor: Paise;
  readonly instalmentDueMinor: Paise;
  /** 🔴 The instalment, or ZERO. NEVER a clamped part-instalment. */
  readonly recoverMinor: Paise;
  /** 🔴 True means: take nothing, and roll the instalment forward. */
  readonly refused: boolean;
  readonly notes: readonly string[];
  readonly problems: readonly string[];
}

const rupees = (p: Paise): string => `₹${(p / 100n).toLocaleString("en-IN")}`;

/**
 * ⭐⭐ THE ONE CALL A PAYROLL RUN MAKES PER LIVE ADVANCE.
 *
 * 🔴🔴 IT REFUSES; IT DOES NOT CLAMP. If the instalment does not fit
 * under s.7(3) once the statutory deductions of the same wage period are
 * counted, NOTHING is recovered this month and the instalment is
 * deferred by `deferInstalment`. Clamping to the headroom would look
 * tidy on the payslip and would be wrong three ways: the employer
 * believes the instalment was taken, the schedule silently lengthens
 * without anybody agreeing to it, and — because the shortfall was never
 * named — the last instalment quietly grows.
 *
 * ⚠️ THE STATUTORY DEDUCTIONS ARE COUNTED FIRST, DELIBERATELY. PF,
 * professional tax and s.192 TDS are not optional and the employer
 * cannot choose to skip them to make room for its own advance. So the
 * DISCRETIONARY head is the one that gives way — which is also the head
 * whose deferral harms nobody but the employer's cash flow.
 */
export function decidePeriodRecovery(args: PeriodRecoveryArgs): PeriodRecoveryDecision {
  const notes: string[] = [];
  const problems: string[] = [];

  const capBase = BigInt(args.wagesForPeriodMinor);
  const recoveryKind = ADVANCE_RECOVERY_KIND[args.kind];

  /* ---- The instalment expressed as the s.7(2) head it really is ---- */
  const asRecovery: Recovery = {
    kind: recoveryKind,
    description: `Instalment ${args.instalment.seq} of an ${args.kind.replace(/_/g, " ")}`,
    amountMinor: args.instalment.amountMinor.toString(),
    reference: args.agreementReference,
  };

  /* ---- 🔴 THE CAP, FROM settlement.ts. Not reimplemented. ---------- */
  const all: readonly Recovery[] = [...args.otherDeductions, asRecovery];
  const capBp = deductionCapBp(all);
  const maxLawful = maximumLawfulDeductionMinor(capBase, capBp);

  const others = args.otherDeductions.reduce((s, r) => {
    const amount = BigInt(r.amountMinor);
    return s + (amount > 0n ? amount : 0n);
  }, 0n);

  const headroom = maxLawful > others ? maxLawful - others : 0n;

  /* ---- The last instalment can never exceed what is still owed ----- */
  // ⚠️ The schedule sums to the principal exactly, so this only bites
  // where an earlier over-recovery or a part write-off has happened —
  // and it is the ledger, not a counter, that says so.
  const due =
    args.instalment.amountMinor > args.outstandingMinor
      ? args.outstandingMinor
      : args.instalment.amountMinor;

  if (due < args.instalment.amountMinor) {
    notes.push(
      `The scheduled instalment of ${rupees(args.instalment.amountMinor)} has been reduced to ${rupees(due)}, which is all that the ledger shows is still outstanding. Recovering the scheduled figure would be a deduction of money that is not owed, and s.7(1) authorises no such thing.`,
    );
  }

  const head = RECOVERY_HEAD_BY_KIND[recoveryKind];
  if (head === undefined) {
    problems.push(
      "The advance maps to a deduction head s.7(2) of the Payment of Wages Act, 1936 does not enumerate. Nothing may be recovered from wages.",
    );
    return {
      period: args.period,
      capBaseMinor: capBase,
      capBp,
      maximumLawfulDeductionMinor: maxLawful,
      otherDeductionsMinor: others,
      headroomMinor: headroom,
      instalmentDueMinor: due,
      recoverMinor: 0n,
      refused: true,
      notes,
      problems,
    };
  }

  const refused = due > headroom;

  notes.push(
    `Deductions this wage period are capped at ${capBp / 100}% of ${rupees(capBase)} by s.7(3) of the Payment of Wages Act, 1936 — ${rupees(maxLawful)}. Other deductions of the same period account for ${rupees(others)}, leaving ${rupees(headroom)}. This instalment is recovered under ${head.clause}.`,
  );

  if (refused) {
    problems.push(
      `🔴 REFUSED FOR ${args.period}. The instalment of ${rupees(due)} would take total deductions past the ${rupees(maxLawful)} that s.7(3) of the Payment of Wages Act, 1936 permits against wages of ${rupees(capBase)}; only ${rupees(headroom)} is left after the deductions that are not discretionary. Ordence has recovered NOTHING rather than taking part of it: a part-instalment would leave the employer believing the schedule was on track, and a schedule that shortens itself is not the schedule the employee agreed to under s.12. The instalment rolls forward and the schedule extends by one wage period.`,
    );
  }

  return {
    period: args.period,
    capBaseMinor: capBase,
    capBp,
    maximumLawfulDeductionMinor: maxLawful,
    otherDeductionsMinor: others,
    headroomMinor: headroom,
    instalmentDueMinor: due,
    // 🔴 ZERO OR THE WHOLE THING.
    recoverMinor: refused ? 0n : due,
    refused,
    notes,
    problems,
  };
}

/**
 * ⭐⭐ THE SCHEDULE EXTENDS; THE INSTALMENT DOES NOT SHRINK.
 *
 * The refused instalment moves to the wage period AFTER the current tail
 * and every instalment behind it keeps its own period. So a six-month
 * schedule with one refusal becomes a seven-period schedule of six
 * instalments — 🔴 and the SUM IS UNCHANGED, which is the property the
 * test asserts. The alternative, re-spreading the deferred amount over
 * the remaining instalments, changes figures the employee consented to.
 */
export function deferInstalment(
  instalments: readonly ScheduledInstalment[],
  seq: number,
): readonly ScheduledInstalment[] {
  if (instalments.length === 0) return instalments;
  const target = instalments.find((i) => i.seq === seq);
  if (target === undefined) return instalments;

  let tail = instalments[0]?.period ?? target.period;
  for (const i of instalments) if (i.period > tail) tail = i.period;

  const moved: ScheduledInstalment = { ...target, period: addMonths(tail, 1) };
  const rest = instalments.filter((i) => i.seq !== seq);
  return [...rest, moved].sort((a, b) =>
    a.period === b.period ? a.seq - b.seq : a.period < b.period ? -1 : 1,
  );
}

/* ================================================================== */
/* ⑤ THE LEDGER INTENT — AN ASSET, NOT AN EXPENSE                      */
/* ================================================================== */

export interface AdvanceLedgerLeg {
  readonly side: "debit" | "credit";
  /** 🔴 The ACCOUNT TYPE, so nobody can route this to an expense. */
  readonly accountType: "asset" | "liability" | "expense" | "income";
  readonly roleHint: string;
  readonly amountMinor: Paise;
  readonly why: string;
}

/**
 * 🔴 THIS DESCRIBES A JOURNAL. IT DOES NOT WRITE ONE. See the header:
 * there is no advances posting role configured, and Ordence does not
 * post advances yet. The description exists so the gap is legible and so
 * the disbursement is never wired to `salary_expense`.
 */
export function advanceLedgerIntent(
  principalMinor: string,
): { readonly legs: readonly AdvanceLedgerLeg[]; readonly posted: false; readonly gap: string } {
  const principal = BigInt(principalMinor);
  return {
    legs: [
      {
        side: "debit",
        accountType: "asset",
        roleHint: "employee_advances_receivable",
        amountMinor: principal,
        why: "🔴 A loan to an employee is a RECEIVABLE. The business is not poorer for having made it; it holds a claim instead of cash. It belongs on the balance sheet under Loans and Advances, and it must never touch Salaries and Wages — doing so would overstate the wage bill in this period and leave the recoveries with nowhere to go but a credit to an expense in a later one.",
      },
      {
        side: "credit",
        accountType: "asset",
        roleHint: "bank",
        amountMinor: principal,
        why: "The cash that left.",
      },
    ],
    posted: false,
    gap: "⚠️ STATED GAP: employee advances are NOT posted to the ledger in this release. `lib/accounting/sales-posting.ts` has no advances role and inventing one here would require a chart-of-accounts mapping nobody has configured. Until it exists, the advance is recorded in `employee_advances` and is absent from the trial balance.",
  };
}

/* ================================================================== */
/* ⑥ THE SNAPSHOT                                                      */
/* ================================================================== */

export type PerquisiteValuation = "not_computed";

export interface AdvanceStatus {
  readonly principalMinor: Paise;
  readonly recoveredMinor: Paise;
  readonly writtenOffMinor: Paise;
  /** 🔴 Folded from the ledger. There is no counter to disagree with. */
  readonly outstandingMinor: Paise;
  readonly overRecoveredMinor: Paise;
  /** ⭐ The input Rule 3(7)(i) needs, for the valuation Ordence refuses. */
  readonly maximumOutstandingMinor: Paise;
  readonly perquisiteValuation: PerquisiteValuation;
  readonly notes: readonly string[];
}

/**
 * ⭐ EVERYTHING A SCREEN NEEDS ABOUT ONE ADVANCE, DERIVED IN ONE PLACE.
 */
export function advanceStatus(
  agreement: AdvanceAgreement,
  ledger: readonly RecoveryLedgerEntry[],
  writtenOffMinor: string = "0",
): AdvanceStatus {
  const recovered = ledger.reduce((s, e) => s + BigInt(e.amountMinor), 0n);
  const notes: string[] = [
    "🔴 The outstanding figure is folded from the recovery ledger every time it is read. It is not a stored counter, because a counter that is decremented by a payroll run which is later reversed, or written twice by two payslips in one run, is wrong in the direction of taking money from someone who does not owe it.",
  ];

  const written = BigInt(writtenOffMinor);
  if (written > 0n) {
    notes.push(
      "⚠️ Part or all of this advance has been WRITTEN OFF. A waived loan is a benefit in the employee's hands and is taxable — whether as a perquisite under s.17(2) of the Income-tax Act, 1961 or as a profit in lieu of salary under s.17(3), and in which previous year, depends on the terms of the waiver. 🔴 ORDENCE HAS NOT VALUED IT. A CA must decide the head and the year.",
    );
  }
  if (agreement.interestRateBp === 0) {
    notes.push(
      "⚠️ Interest-free. Rule 3(7)(i) of the Income-tax Rules, 1962 makes this a perquisite valued on the maximum outstanding monthly balance at the SBI rate for the corresponding loan as on the first day of the previous year. 🔴 NOT VALUED HERE: that rate is an external annual fact Ordence does not hold and the exceptions are judgements. `maximumOutstandingMinor` is provided as the input.",
    );
  }

  return {
    principalMinor: BigInt(agreement.principalMinor),
    recoveredMinor: recovered,
    writtenOffMinor: written,
    outstandingMinor: outstandingMinor(agreement.principalMinor, ledger, writtenOffMinor),
    overRecoveredMinor: overRecoveredMinor(agreement.principalMinor, ledger, writtenOffMinor),
    maximumOutstandingMinor: maximumOutstandingMinor(agreement.principalMinor, ledger),
    perquisiteValuation: "not_computed",
    notes,
  };
}
