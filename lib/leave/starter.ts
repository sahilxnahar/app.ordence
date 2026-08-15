/**
 * Ordence — ⭐ THE STARTER LEAVE POLICY
 * Version: v1.46.0-alpha · Batch 59
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ A SEED, NOT A DEFAULT, AND NOT LEGAL ADVICE
 * ══════════════════════════════════════════════════════════════════════
 * These rows are written once and are then the tenant's to change. A
 * "default" re-applied on every load silently undoes whatever they
 * corrected — the same rule `lib/payroll/starter.ts` follows.
 *
 * 🔴 AND THE NUMBERS ARE ORDINARY INDIAN PRACTICE, NOT A STATUTORY
 * MINIMUM. Earned leave for a factory worker comes from section 79 of
 * the Factories Act 1948; everybody else is covered by their State's
 * Shops and Establishments Act, and those differ from each other on the
 * number of days, on whether sick and casual leave are separate, and on
 * what lapses. Ordence does not know which Act applies to a given
 * employee and a product that guessed would be confidently wrong for
 * most of its users. The screen says so, in those words, next to the
 * button that writes these rows.
 */

export interface StarterLeaveType {
  readonly code: string;
  readonly label: string;
  readonly isPaid: boolean;
  readonly accrualMethod: "monthly_earned" | "annual_advance" | "none";
  readonly annualEntitlementDays: string;
  readonly carryForwardCapDays: string;
  readonly encashmentCapDays: string;
  readonly countsHolidaysAndOffs: boolean;
  readonly probationDays: number;
  readonly displayOrder: number;
  readonly notes: string;
}

export const STARTER_LEAVE_TYPES: readonly StarterLeaveType[] = [
  {
    code: "EL",
    label: "Earned Leave",
    isPaid: true,
    /**
     * ⭐ EARNED, MONTHLY. 18 days a year is 1.5 a month, which divides
     * evenly at half-day granularity — chosen deliberately so the first
     * thing a new workspace sees is an accrual that does not need
     * explaining.
     */
    accrualMethod: "monthly_earned",
    annualEntitlementDays: "18.00",
    /**
     * 🔴 CAPPED AT 30, NOT UNCAPPED. Roughly eighteen months of
     * entitlement, which is enough to cover somebody who could not take
     * leave for a year and short enough that it cannot quietly become
     * three person-years of unfunded obligation.
     */
    carryForwardCapDays: "30.00",
    encashmentCapDays: "15.00",
    /** ⚠️ Long blocks of earned leave count intervening Sundays. */
    countsHolidaysAndOffs: true,
    probationDays: 0,
    displayOrder: 10,
    notes:
      "Earned across the year in proportion to days on the rolls. Check the entitlement against the Act your establishment is registered under before the first accrual.",
  },
  {
    code: "CL",
    label: "Casual Leave",
    isPaid: true,
    /**
     * ⚠️ GRANTED UP FRONT, WHICH IS ORDINARY FOR CASUAL LEAVE AND HAS A
     * COST. Somebody who takes all twelve days in April and resigns in
     * May has been paid for days they did not earn.
     * `lib/leave/accrual.ts` still pro-rates a part-year joiner, so the
     * October starter gets a part year and not a full one.
     */
    accrualMethod: "annual_advance",
    annualEntitlementDays: "12.00",
    /** ⭐ Use it or lose it, which is what casual leave is for. */
    carryForwardCapDays: "0.00",
    encashmentCapDays: "0.00",
    countsHolidaysAndOffs: false,
    probationDays: 0,
    displayOrder: 20,
    notes: "Granted at the start of the leave year. Does not carry forward and is not encashable.",
  },
  {
    code: "SL",
    label: "Sick Leave",
    isPaid: true,
    accrualMethod: "annual_advance",
    annualEntitlementDays: "12.00",
    carryForwardCapDays: "0.00",
    encashmentCapDays: "0.00",
    countsHolidaysAndOffs: false,
    probationDays: 0,
    displayOrder: 30,
    notes:
      "Ordence records that sick leave was taken and never why. No medical certificate content, no diagnosis, no health data of any kind.",
  },
  {
    code: "LOP",
    label: "Loss of Pay",
    isPaid: false,
    /**
     * 🔴 THE TYPE THAT MAKES THE PAYSLIP AND THE REGISTER AGREE.
     *
     * ⚠️ WITHOUT IT, AN UNPAID DAY IS "THE ABSENCE OF AN APPROVED
     * LEAVE" — which is not a record of anything, cannot be applied for,
     * cannot be approved, and leaves the payroll deduction as the only
     * evidence it happened. With it, an unpaid day goes through exactly
     * the same application and approval as any other and the two systems
     * are describing the same event.
     */
    accrualMethod: "none",
    annualEntitlementDays: "0.00",
    carryForwardCapDays: "0.00",
    encashmentCapDays: "0.00",
    countsHolidaysAndOffs: false,
    probationDays: 0,
    displayOrder: 90,
    notes:
      "Never earned and never accrued. Every day taken is loss of pay on the payslip for that month.",
  },
];

/**
 * ⭐ THE LEAVE YEAR THE SEED PROPOSES, AND WHY IT IS A PROPOSAL.
 *
 * ⚠️ 1 APRIL – 31 MARCH MATCHES THE INDIAN FINANCIAL YEAR AND IS THE
 * commonest leave year here, and it is not universal: calendar-year
 * leave years are normal in multinationals and joining-anniversary years
 * exist. The seed writes one row the tenant can change, rather than a
 * constant in code that only fits the workspaces that guessed our way.
 */
export function proposedLeaveYear(today: string): {
  label: string;
  startsOn: string;
  endsOn: string;
} {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  /* Before April, the current leave year began in the previous April. */
  const startYear = month >= 4 ? year : year - 1;
  return {
    label: `FY ${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`,
    startsOn: `${startYear}-04-01`,
    endsOn: `${startYear + 1}-03-31`,
  };
}
