/**
 * Ordence — ⭐⭐⭐ ONE EMPLOYEE, ONE MONTH, ONE PAYSLIP
 * Version: v1.23.0-alpha
 *
 * Pure. No database, no clock. Everything arrives as an argument.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE PAYSLIP IS THE ONLY DOCUMENT IN THIS PRODUCT THAT A PERSON
 * CHECKS BY HAND
 * ══════════════════════════════════════════════════════════════════════
 * An employee with a calculator will find a one-rupee discrepancy and
 * they will be right to raise it. That is different from every other
 * total in Ordence, which is reconciled by a machine or not at all, and
 * it drives three decisions here:
 *
 *   ① EVERY LINE IS KEPT, including zero ones the employee is used to
 *     seeing. A payslip that silently drops "Conveyance — ₹0" because
 *     the month had no conveyance looks like something was taken away.
 *
 *   ② THE ARITHMETIC IS SHOWN, not just the answer. Each line carries
 *     how it was arrived at — full amount, days paid, days in month —
 *     so a query is answered by reading rather than by re-deriving.
 *
 *   ③ NOTHING IS NETTED. Gross earnings and total deductions are two
 *     numbers that both appear. A payslip showing only net is a payslip
 *     nobody can check.
 */

import {
  computeEsi,
  computeProfessionalTax,
  computePf,
  projectMonthlyTds,
  roundToRupee,
  type EsiRules,
  type Paise,
  type PfRules,
  type PtSlab,
  type TaxRules,
  type TaxSlab,
} from "./statutory";

/* ------------------------------------------------------------------ */
/* WHAT AN EMPLOYEE IS PAID                                            */
/* ------------------------------------------------------------------ */

export type ComponentKind = "earning" | "deduction";

export interface PayComponent {
  readonly code: string;
  readonly label: string;
  readonly kind: ComponentKind;
  /** ⭐ Counts towards the PF base — basic, DA, retaining allowance. */
  readonly pfApplicable: boolean;
  /** Counts towards the ESI gross. Almost everything does. */
  readonly esiApplicable: boolean;
  /** Counts towards taxable salary. */
  readonly taxable: boolean;
  /**
   * 🔴 FALSE MEANS THE AMOUNT IS PAID IN FULL REGARDLESS OF DAYS WORKED.
   *
   * ⚠️ THIS IS THE SINGLE MOST ARGUED-ABOUT FLAG IN INDIAN PAYROLL.
   * Basic pro-rates. A fixed reimbursement usually does not. Getting it
   * backwards on one component produces a payslip that is wrong by a
   * plausible amount for every employee who took a day off.
   */
  readonly proRates: boolean;
  readonly displayOrder: number;
}

export interface StructureLine {
  readonly componentCode: string;
  /** Paise, for a full month. */
  readonly monthlyAmountMinor: string;
}

/* ------------------------------------------------------------------ */
/* ATTENDANCE                                                          */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ `daysInMonth` IS THE CALENDAR MONTH, NOT A FIXED 30.
 *
 * 🔴 BOTH CONVENTIONS ARE USED IN PRACTICE AND THEY DISAGREE BY REAL
 * MONEY. A fixed-30 divisor pays February short and pays a 31-day month
 * long. Ordence uses the calendar month because it is what the payslip
 * can defend to the employee, and because a fixed divisor makes
 * "salary × 12" stop equalling the annual CTC.
 */
export interface AttendanceFacts {
  readonly daysInMonth: number;
  /** Days of loss of pay. Unpaid leave, unauthorised absence. */
  readonly lopDays: number;
  /** Days the employee was actually on the rolls this month. */
  readonly payableDays: number;
}

export function paidDays(a: AttendanceFacts): number {
  const paid = a.payableDays - a.lopDays;
  return paid < 0 ? 0 : paid;
}

/* ------------------------------------------------------------------ */
/* THE RESULT                                                          */
/* ------------------------------------------------------------------ */

export interface PayslipLine {
  readonly componentCode: string;
  readonly label: string;
  readonly kind: ComponentKind;
  readonly fullMonthMinor: Paise;
  readonly amountMinor: Paise;
  /** ⭐ How it was arrived at, in words, for the employee. */
  readonly workingNote: string;
  readonly displayOrder: number;
}

export interface PayslipResult {
  readonly lines: readonly PayslipLine[];
  readonly grossEarningsMinor: Paise;
  readonly pfWagesMinor: Paise;
  readonly esiGrossMinor: Paise;
  readonly taxableGrossMinor: Paise;

  readonly employeePfMinor: Paise;
  readonly employeeEsiMinor: Paise;
  readonly professionalTaxMinor: Paise;
  readonly tdsMinor: Paise;
  readonly otherDeductionsMinor: Paise;
  readonly totalDeductionsMinor: Paise;
  readonly netPayMinor: Paise;

  /** ⚠️ Cost to the company, which the employee never sees on a payslip. */
  readonly employerPfMinor: Paise;
  readonly employerPensionMinor: Paise;
  readonly employerEdliMinor: Paise;
  readonly employerPfAdminMinor: Paise;
  readonly employerEsiMinor: Paise;
  readonly employerTotalMinor: Paise;

  readonly tdsIsProjection: boolean;
  readonly tdsOverridden: boolean;
  readonly notes: readonly string[];
  /** 🔴 Non-empty means this payslip must not be paid as it stands. */
  readonly problems: readonly string[];
}

export interface EmployeeFacts {
  readonly stateCode: string;
  readonly pfExempt: boolean;
  readonly pfOnFullWages: boolean;
  readonly esiExempt: boolean;
  readonly esiCoveredAtPeriodStart: boolean;
  readonly taxRegime: "new" | "old";
  readonly declaredDeductionsMinor: string;
  /** ⭐ The accountant's own number, in paise, or null to project. */
  readonly tdsOverrideMinor: string | null;
  readonly hasPan: boolean;
}

export function buildPayslip(args: {
  readonly employee: EmployeeFacts;
  readonly components: readonly PayComponent[];
  readonly structure: readonly StructureLine[];
  readonly attendance: AttendanceFacts;
  readonly month: number;
  readonly periodEnd: string;
  readonly pfRules: PfRules | null;
  readonly esiRules: EsiRules | null;
  readonly ptSlabs: readonly PtSlab[];
  readonly taxRules: TaxRules | null;
  readonly taxSlabs: readonly TaxSlab[];
  readonly monthsRemaining: number;
  readonly tdsAlreadyDeductedMinor: string;
}): PayslipResult {
  const problems: string[] = [];
  const notes: string[] = [];

  const byCode = new Map(args.components.map((c) => [c.code, c]));
  const worked = paidDays(args.attendance);
  const days = args.attendance.daysInMonth;

  if (days <= 0) {
    problems.push("The month has no days in it, which means the period is wrong.");
  }

  /* ---- ① Pro-rate every line -------------------------------------- */
  const lines: PayslipLine[] = [];

  for (const line of args.structure) {
    const component = byCode.get(line.componentCode);
    if (!component) {
      // 🔴 A STRUCTURE LINE WITH NO COMPONENT IS A PROBLEM, NOT A ZERO.
      // Silently dropping it underpays the employee by exactly that line
      // and nothing anywhere reports it.
      problems.push(
        `This employee is paid a component called "${line.componentCode}" that no longer exists in the component list. Nothing has been calculated for it.`,
      );
      continue;
    }

    const full = BigInt(line.monthlyAmountMinor);

    let amount: Paise;
    let workingNote: string;

    if (!component.proRates || days <= 0) {
      amount = full;
      workingNote = "Paid in full — this component does not vary with days worked.";
    } else if (worked >= days) {
      amount = full;
      workingNote = `Full month (${worked} of ${days} days).`;
    } else {
      // ⚠️ MULTIPLY BEFORE DIVIDE. The other order loses paise on every
      // line and the payslip then does not add up to its own total.
      // ⭐ HALF-DAY LOP IS CHARGED AS WHOLE DAYS.
      // worked can be fractional (e.g. 30.5) due to half-day loss of pay.
      // We floor it to charge only whole days, and the fractional remainder
      // is reported as a problem so a human can acknowledge it.
      const wholeWorked = Math.floor(worked);
      if (wholeWorked < worked) {
        problems.push(
          `This employee has a fractional loss of pay (${args.attendance.lopDays} days). The remainder is charged as whole days, but please verify this assumption.`,
        );
      }
      amount = roundToRupee((full * BigInt(wholeWorked)) / BigInt(days));
      workingNote = `${wholeWorked} of ${days} days paid${args.attendance.lopDays > 0 ? ` (${args.attendance.lopDays} day${args.attendance.lopDays === 1 ? "" : "s"} loss of pay)` : ""}.`;
    }

    lines.push({
      componentCode: component.code,
      label: component.label,
      kind: component.kind,
      fullMonthMinor: full,
      amountMinor: amount,
      workingNote,
      displayOrder: component.displayOrder,
    });
  }

  lines.sort((a, b) => a.displayOrder - b.displayOrder || a.label.localeCompare(b.label));

  const sum = (predicate: (l: PayslipLine) => boolean): Paise =>
    lines.filter(predicate).reduce((total, l) => total + l.amountMinor, 0n);

  const grossEarnings = sum((l) => l.kind === "earning");
  const otherDeductions = sum((l) => l.kind === "deduction");

  const pfBase = sum(
    (l) => l.kind === "earning" && (byCode.get(l.componentCode)?.pfApplicable ?? false),
  );
  const esiGross = sum(
    (l) => l.kind === "earning" && (byCode.get(l.componentCode)?.esiApplicable ?? false),
  );
  const taxableGross = sum(
    (l) => l.kind === "earning" && (byCode.get(l.componentCode)?.taxable ?? false),
  );

  /* ---- ② Provident fund ------------------------------------------- */
  let employeePf = 0n;
  let employerPf = 0n;
  let employerPension = 0n;
  let employerEdli = 0n;
  let employerAdmin = 0n;

  if (args.pfRules === null) {
    if (!args.employee.pfExempt) {
      // ⚠️ REFUSED, NOT ASSUMED ZERO. A payroll that quietly skips PF
      // because nobody configured it is a payroll that under-deducts
      // every employee and is discovered by an inspector.
      problems.push(
        "No provident fund rates are configured for this period, and this employee is not marked exempt. Nothing has been deducted, which is almost certainly wrong.",
      );
    }
  } else {
    const pf = computePf({
      pfEligibleWagesMinor: pfBase,
      rules: args.pfRules,
      contributeAboveCeiling: args.employee.pfOnFullWages,
      isExempt: args.employee.pfExempt,
    });
    employeePf = pf.employeeMinor;
    employerPf = pf.employerPfMinor;
    employerPension = pf.employerPensionMinor;
    employerEdli = pf.edliMinor;
    employerAdmin = pf.adminMinor;
    if (!args.employee.pfExempt) notes.push(`Provident fund: ${pf.note}`);
  }

  /* ---- ③ ESI ------------------------------------------------------ */
  let employeeEsi = 0n;
  let employerEsi = 0n;

  if (args.esiRules === null) {
    if (!args.employee.esiExempt) {
      problems.push(
        "No ESI rates are configured for this period, and this employee is not marked exempt.",
      );
    }
  } else {
    const esi = computeEsi({
      grossMinor: esiGross,
      rules: args.esiRules,
      coveredAtPeriodStart: args.employee.esiCoveredAtPeriodStart,
      isExempt: args.employee.esiExempt,
    });
    employeeEsi = esi.employeeMinor;
    employerEsi = esi.employerMinor;
    if (!args.employee.esiExempt) notes.push(`ESI: ${esi.note}`);
  }

  /* ---- ④ Professional tax ----------------------------------------- */
  const pt = computeProfessionalTax({
    grossMinor: grossEarnings,
    stateCode: args.employee.stateCode,
    month: args.month,
    slabs: args.ptSlabs,
    onDate: args.periodEnd,
  });
  notes.push(`Professional tax: ${pt.note}`);

  /* ---- ⑤ Income tax ------------------------------------------------ */
  let tds = 0n;
  let tdsIsProjection = false;

  if (args.employee.tdsOverrideMinor !== null) {
    // ⭐ THE OVERRIDE WINS, AND IT IS SAID OUT LOUD ON THE PAYSLIP.
    tds = BigInt(args.employee.tdsOverrideMinor);
    notes.push(
      "Income tax is the figure entered by your accountant for this employee, not a figure Ordence calculated.",
    );
  } else if (args.taxRules === null) {
    if (taxableGross > 0n) {
      notes.push(
        "No income tax slabs are configured for this period, so nothing has been withheld. That is fine if this employee is below the threshold and a problem if not.",
      );
    }
  } else {
    const projected = projectMonthlyTds({
      // ⚠️ THE PROJECTION USES THE FULL-MONTH FIGURE, NOT THIS MONTH'S
      // PRO-RATED ONE. Projecting a year from a month with three days of
      // loss of pay under-withholds for the whole remaining year.
      projectedAnnualGrossMinor:
        lines
          .filter((l) => l.kind === "earning" && (byCode.get(l.componentCode)?.taxable ?? false))
          .reduce((t, l) => t + l.fullMonthMinor, 0n) * 12n,
      declaredDeductionsMinor: BigInt(args.employee.declaredDeductionsMinor),
      annualProfessionalTaxMinor: pt.amountMinor * 12n,
      rules: args.taxRules,
      slabs: args.taxSlabs,
      monthsRemaining: args.monthsRemaining,
      alreadyDeductedMinor: BigInt(args.tdsAlreadyDeductedMinor),
    });
    tds = projected.monthlyMinor;
    tdsIsProjection = true;
    notes.push(`Income tax: ${projected.note}`);
    for (const c of projected.caveats) notes.push(`Income tax: ${c}`);

    // 🔴 NO PAN MEANS A HIGHER RATE UNDER SECTION 206AA, AND ORDENCE
    // DOES NOT APPLY IT AUTOMATICALLY. It refuses instead, because
    // applying 20% to somebody who simply has not typed their PAN in yet
    // is a very expensive way to chase a data-entry gap.
    if (tds > 0n && !args.employee.hasPan) {
      problems.push(
        "Tax is due but this employee has no PAN recorded. Section 206AA requires a higher rate without one, and Ordence will not guess at it — add the PAN, or enter the figure your accountant has arrived at.",
      );
    }
  }

  /* ---- ⑥ Totals ---------------------------------------------------- */
  const totalDeductions = employeePf + employeeEsi + pt.amountMinor + tds + otherDeductions;
  const net = grossEarnings - totalDeductions;

  if (net < 0n) {
    // ⚠️ A NEGATIVE NET IS ARITHMETICALLY POSSIBLE AND OPERATIONALLY
    // IMPOSSIBLE. It means recoveries exceed the month's pay, and it has
    // to be a refusal rather than a negative payslip.
    problems.push(
      "Deductions come to more than this month's earnings, so the net is negative. Something has to be carried to next month rather than paid as a minus figure.",
    );
  }

  if (grossEarnings === 0n && worked > 0) {
    problems.push(
      "This employee worked days this month and has no earnings configured. They have a structure with nothing in it, or the structure has not started yet.",
    );
  }

  return {
    lines,
    grossEarningsMinor: grossEarnings,
    pfWagesMinor: pfBase,
    esiGrossMinor: esiGross,
    taxableGrossMinor: taxableGross,

    employeePfMinor: employeePf,
    employeeEsiMinor: employeeEsi,
    professionalTaxMinor: pt.amountMinor,
    tdsMinor: tds,
    otherDeductionsMinor: otherDeductions,
    totalDeductionsMinor: totalDeductions,
    netPayMinor: net,

    employerPfMinor: employerPf,
    employerPensionMinor: employerPension,
    employerEdliMinor: employerEdli,
    employerPfAdminMinor: employerAdmin,
    employerEsiMinor: employerEsi,
    employerTotalMinor:
      employerPf + employerPension + employerEdli + employerAdmin + employerEsi,

    tdsIsProjection,
    tdsOverridden: args.employee.tdsOverrideMinor !== null,
    notes,
    problems,
  };
}

/* ------------------------------------------------------------------ */
/* THE RUN TOTAL                                                       */
/* ------------------------------------------------------------------ */

export interface RunTotals {
  readonly employeeCount: number;
  readonly grossMinor: Paise;
  readonly employeePfMinor: Paise;
  readonly employerPfMinor: Paise;
  readonly employerPensionMinor: Paise;
  readonly edliMinor: Paise;
  readonly pfAdminMinor: Paise;
  readonly employeeEsiMinor: Paise;
  readonly employerEsiMinor: Paise;
  readonly professionalTaxMinor: Paise;
  readonly tdsMinor: Paise;
  readonly otherDeductionsMinor: Paise;
  readonly netPayMinor: Paise;
  readonly employerCostMinor: Paise;
  /** 🔴 Any payslip with a problem. The run must not be approved. */
  readonly withProblems: number;
}

export function totalRun(slips: readonly PayslipResult[]): RunTotals {
  const add = (pick: (s: PayslipResult) => Paise): Paise =>
    slips.reduce((total, s) => total + pick(s), 0n);

  const gross = add((s) => s.grossEarningsMinor);
  const employerCost = add((s) => s.employerTotalMinor);

  return {
    employeeCount: slips.length,
    grossMinor: gross,
    employeePfMinor: add((s) => s.employeePfMinor),
    employerPfMinor: add((s) => s.employerPfMinor),
    employerPensionMinor: add((s) => s.employerPensionMinor),
    edliMinor: add((s) => s.employerEdliMinor),
    pfAdminMinor: add((s) => s.employerPfAdminMinor),
    employeeEsiMinor: add((s) => s.employeeEsiMinor),
    employerEsiMinor: add((s) => s.employerEsiMinor),
    professionalTaxMinor: add((s) => s.professionalTaxMinor),
    tdsMinor: add((s) => s.tdsMinor),
    otherDeductionsMinor: add((s) => s.otherDeductionsMinor),
    netPayMinor: add((s) => s.netPayMinor),
    // ⭐ COST TO COMPANY IS GROSS PLUS THE EMPLOYER'S OWN CONTRIBUTIONS,
    // never gross alone. The difference is what the business actually
    // spends and it is roughly a seventh of the wage bill.
    employerCostMinor: gross + employerCost,
    withProblems: slips.filter((s) => s.problems.length > 0).length,
  };
}
