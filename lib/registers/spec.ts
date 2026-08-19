/**
 * Ordence — 🔴🔴 WHAT EACH REGISTER MUST CONTAIN, AND WHAT WE HAVE
 * Version: v1.50.0-alpha · Batch 76
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE RULE THIS ENTIRE MODULE EXISTS TO ENFORCE
 * ══════════════════════════════════════════════════════════════════════
 * A REGISTER MUST NOT INVENT A COLUMN IT CANNOT SOURCE.
 *
 * The tempting thing — and the thing every payroll product does — is to
 * print the statutory column headings and fill the ones with no data
 * behind them with a zero, a dash, or the nearest number that happens to
 * be in scope. "Overtime hours: 0". "Advance recovered: ₹0.00". Both
 * read as a positive assertion by the employer that no overtime was
 * worked and no advance was recovered. Neither is something this system
 * knows. If either is wrong, the register is a signed false statement,
 * and the employer produced it themselves.
 *
 * ⭐ SO EVERY COLUMN CARRIES ITS SOURCING IN THE SPEC:
 *
 *   sourced    — there is a column, or a derivation from columns, that
 *                answers this. The register prints the value.
 *   unsourced  — the form requires it and Ordence does not hold it. The
 *                column is PRINTED WITH ITS HEADING AND LEFT BLANK, and
 *                the document lists it under "not sourced" with the
 *                reason. Blank means "we do not know". Zero means "we
 *                know, and it is nothing". They are different claims.
 *
 * 🔴 AND WHEN THE UNSOURCED COLUMNS ARE THE WHOLE REGISTER, IT REFUSES.
 * `loans_and_advances_register` has a `refusal` and generates nothing.
 * A register of loans and advances whose every substantive column is
 * blank is not a register with gaps; it is a blank sheet with a real
 * form number on it, which is worse than not producing one — it looks
 * like a compliance artefact and asserts that no advances exist.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THE COLUMN LIST IS DATA AND NOT JSX
 * ══════════════════════════════════════════════════════════════════════
 * The renderer walks this list. It cannot render a column that is not
 * here, and it cannot silently drop one that is — which means the "not
 * sourced" footnote and the table can never disagree, because they are
 * generated from the same array. A hand-written `<th>` in a component is
 * one careless edit away from a heading with no footnote behind it.
 */

import type { RegisterKind } from "./forms";

/* ------------------------------------------------------------------ */
/* COLUMNS                                                             */
/* ------------------------------------------------------------------ */

export type ColumnSourcing =
  | { readonly kind: "sourced"; readonly from: string }
  | { readonly kind: "unsourced"; readonly why: string };

export interface RegisterColumn {
  readonly id: string;
  readonly label: string;
  /**
   * ⚠️ `true` means the FORM asks for it. A sourced column that is not
   * statutory is one we add because it helps the reader — a run number,
   * say — and it is marked so an inspector can tell ours from theirs.
   */
  readonly statutory: boolean;
  readonly sourcing: ColumnSourcing;
  readonly align: "left" | "right";
}

const sourced = (
  id: string,
  label: string,
  from: string,
  align: "left" | "right" = "left",
  statutory = true,
): RegisterColumn => ({ id, label, statutory, align, sourcing: { kind: "sourced", from } });

const unsourced = (id: string, label: string, why: string): RegisterColumn => ({
  id,
  label,
  statutory: true,
  align: "left",
  sourcing: { kind: "unsourced", why },
});

/* ------------------------------------------------------------------ */
/* THE SPEC                                                            */
/* ------------------------------------------------------------------ */

export interface RegisterSpec {
  readonly kind: RegisterKind;
  readonly title: string;
  /** Why an inspector asks for it, in one sentence, shown on the page. */
  readonly purpose: string;
  /**
   * ⭐ WHETHER THIS REGISTER READS LEAVE AND ATTENDANCE DATA. It decides
   * the permission set, not the layout — see `server/actions/registers.ts`.
   */
  readonly needsLeave: boolean;
  /** ⚠️ True when the document covers a date range rather than a moment. */
  readonly periodic: boolean;
  readonly columns: readonly RegisterColumn[];
  /**
   * 🔴 NON-NULL MEANS THIS REGISTER DOES NOT GENERATE. The string is the
   * reason, printed where the register would have been.
   */
  readonly refusal: string | null;
}

/* ------------------------------------------------------------------ */
/* ① REGISTER OF EMPLOYEES                                             */
/* ------------------------------------------------------------------ */

/**
 * ⭐ SHIPPED, WITH SEVEN NAMED HOLES.
 *
 * The employee register is the first thing asked for and the one Ordence
 * can most nearly produce: code, name, designation, department, date of
 * joining, date of exit, UAN, ESIC number, PAN and work State all exist
 * on `employees` and are all things the form wants.
 *
 * 🔴 WHAT IT CANNOT PRODUCE IS THE IDENTITY BLOCK, and every item in it
 * is a column on the statutory form: father's or husband's name, date of
 * birth, sex, nationality, present and permanent address, and the nature
 * of work. None of these is on `employees` and none can be derived. A
 * date of birth in particular is unguessable and load-bearing — it is
 * how child-labour and young-person provisions are checked, which is a
 * substantial part of why the register exists at all.
 *
 * ⚠️ SO WE PRINT THE HEADINGS AND LEAVE THEM BLANK. An employer who
 * needs a complete Form A gets a document that shows exactly which seven
 * facts they have to write in by hand, which is a materially better
 * starting point than a spreadsheet — and the register never claims a
 * blank is a nil.
 */
const EMPLOYEE_REGISTER: RegisterSpec = {
  kind: "employee_register",
  title: "Register of employees",
  purpose:
    "Who is on the rolls, since when, and under which identifiers. The first register an inspector asks for and the one every other register is checked against.",
  needsLeave: false,
  periodic: false,
  columns: [
    sourced("serial", "S. No.", "Row position in this document", "right", false),
    sourced("employeeCode", "Employee code", "employees.employee_code"),
    sourced("fullName", "Name", "employees.full_name"),
    unsourced(
      "guardianName",
      "Father's / husband's name",
      "Ordence does not hold a guardian or spouse name. `employees` carries one name field and it is the employee's own.",
    ),
    unsourced(
      "dateOfBirth",
      "Date of birth",
      "Not held. This is the column the young-person and child-labour provisions turn on, so a guess is not merely unhelpful — it would be the false statement the provision exists to prevent.",
    ),
    unsourced(
      "sex",
      "Sex",
      "Not held. `employees` records no sex or gender, and it is the column the night-work, creche and maternity provisions are checked against.",
    ),
    unsourced(
      "nationality",
      "Nationality",
      "Not held. It governs whether an international-worker PF obligation arises, which is a different contribution basis from the domestic one.",
    ),
    sourced("designation", "Designation", "employees.designation"),
    sourced("department", "Department / section", "employees.department", "left", false),
    unsourced(
      "natureOfWork",
      "Nature of work",
      "Not held as a separate fact. Designation is a job title and the form asks what the person actually does, which is not the same thing and must not be substituted for it.",
    ),
    sourced("joinedOn", "Date of joining", "employees.joined_on"),
    sourced("workState", "State of work", "employees.work_state_code"),
    sourced("uan", "UAN", "employees.uan"),
    sourced("esicNumber", "ESIC insurance number", "employees.esic_number"),
    sourced("pan", "PAN", "employees.pan"),
    unsourced(
      "presentAddress",
      "Present address",
      "Not held. `employees` has no address columns; the addresses in the CRM belong to companies and contacts, not to staff, and reusing one would attribute a customer's address to an employee.",
    ),
    unsourced(
      "permanentAddress",
      "Permanent address",
      "Not held, for the same reason as the present address. The two are separate columns on the form precisely because a migrant worker's home State is a fact the register is meant to capture.",
    ),
    sourced("leftOn", "Date of exit", "employees.left_on"),
    unsourced(
      "reasonForLeaving",
      "Reason for leaving",
      "Not held. `employees.left_on` records that somebody left and never why. Resignation, retirement, termination and death are legally different exits and the form asks which.",
    ),
  ],
  refusal: null,
};

/* ------------------------------------------------------------------ */
/* ② WAGE REGISTER                                                     */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐ THE REGISTER ORDENCE IS ACTUALLY GOOD AT, AND THE REASON IS THAT
 * A PAYSLIP IS ALREADY FROZEN.
 *
 * `payslips` stores the employee's name and code as they were, the days
 * in the month, the payable days, the loss-of-pay days, the gross, every
 * statutory deduction separately, the total deduction and the net — all
 * written once at compute time and never recomputed. That is very nearly
 * the wage register, and it is frozen, which is the property the
 * register needs most.
 *
 * ⭐ "RATE OF WAGES PAYABLE" COMES FROM `lines[].fullMonthMinor`, which
 * is the full-month value of each earning component before attendance is
 * applied. That is precisely what the form means by the rate — what the
 * person is on, not what they were paid this month, which is the next
 * column along.
 *
 * 🔴 TWO COLUMNS ARE NOT SOURCED AND ONE OF THEM IS THE IMPORTANT ONE:
 *
 *   • DATE OF PAYMENT. `payroll_runs` records `computed_at`,
 *     `approved_at` and `posted_at`. NONE of them is the date wages
 *     reached the employee. Posting a journal is an accounting event;
 *     the bank transfer is a different event on a different day, and the
 *     whole of the Payment of Wages Act is about which day that was.
 *     Printing `posted_at` under "date of payment" would be a wrong
 *     answer to the one question this register is asked in a dispute.
 *
 *   • OVERTIME. Neither hours nor an overtime wage rate is recorded
 *     anywhere in this codebase. `staff_attendance` is a per-day verdict
 *     with no clock times on it. A zero here would assert that nobody
 *     worked overtime.
 */
const WAGE_REGISTER: RegisterSpec = {
  kind: "wage_register",
  title: "Wage register",
  purpose:
    "What each person was entitled to, what was deducted and why, and what was paid — for every payroll run whose figures are settled.",
  needsLeave: false,
  periodic: true,
  columns: [
    sourced("serial", "S. No.", "Row position in this document", "right", false),
    sourced("runNo", "Run", "payroll_runs.run_no", "left", false),
    sourced("period", "Wage period", "payroll_runs.period_start / period_end"),
    sourced("employeeCode", "Employee code", "payslips.employee_code"),
    sourced("employeeName", "Name", "payslips.employee_name (frozen at compute time)"),
    sourced("daysInMonth", "Days in wage period", "payslips.days_in_month", "right"),
    sourced("payableDays", "Days paid for", "payslips.payable_days", "right"),
    sourced("lopDays", "Days of loss of pay", "payslips.lop_days", "right"),
    unsourced(
      "overtimeHours",
      "Overtime hours worked",
      "Not held. Nothing in Ordence records clock times or hours; `staff_attendance` is one verdict per day. A zero here would assert that no overtime was worked.",
    ),
    sourced(
      "rateOfWages",
      "Rate of wages payable",
      "Sum of the full-month value of every earning line on the payslip",
      "right",
    ),
    sourced("gross", "Gross wages payable", "payslips.gross_minor", "right"),
    unsourced(
      "overtimeWages",
      "Overtime wages",
      "Not held, for the same reason as overtime hours. It is not zero; it is unknown.",
    ),
    sourced("employeePf", "Provident fund deducted", "payslips.employee_pf_minor", "right"),
    sourced("employeeEsi", "ESI deducted", "payslips.employee_esi_minor", "right"),
    sourced("professionalTax", "Professional tax", "payslips.professional_tax_minor", "right"),
    sourced("tds", "Income tax deducted", "payslips.tds_minor", "right"),
    /**
     * ⚠️ NAMED "OTHER DEDUCTIONS", NOT "ADVANCES RECOVERED", AND THAT
     * NAMING IS THE WHOLE POINT. See the loans register below: this
     * figure is the sum of every non-statutory deduction line, which may
     * be an advance instalment, a canteen bill, a uniform charge or a
     * recovery for damage. The form wants those itemised by cause and we
     * cannot itemise them by cause.
     */
    sourced("otherDeductions", "Other deductions", "payslips.other_deductions_minor", "right"),
    sourced("totalDeductions", "Total deductions", "payslips.total_deductions_minor", "right"),
    sourced("net", "Net wages paid", "payslips.net_minor", "right"),
    unsourced(
      "dateOfPayment",
      "Date of payment",
      "Not held. `payroll_runs` records when the run was computed, approved and posted to the ledger. None of those is the day the money reached the employee, and the Payment of Wages Act is entirely about that day.",
    ),
    unsourced(
      "receipt",
      "Signature / thumb impression of employee",
      "A physical acknowledgement. Nothing in Ordence stands in for it, and an e-signature record would be a different assertion from the one the column asks for.",
    ),
  ],
  refusal: null,
};

/* ------------------------------------------------------------------ */
/* ③ ATTENDANCE REGISTER / MUSTER ROLL                                 */
/* ------------------------------------------------------------------ */

/**
 * ⭐ SHIPPED, AND HONEST ABOUT BEING A DAY REGISTER AND NOT AN HOURS
 * REGISTER.
 *
 * `staff_attendance` is one verdict per person per day, enforced unique,
 * with a loss-of-pay fraction on it. That is a muster roll. It is not a
 * record of hours, spread-over, rest intervals or overtime, and the
 * OSH-side forms want those too.
 *
 * 🔴 THE DAY COLUMNS ARE NOT IN THIS LIST AND THAT IS DELIBERATE. A
 * muster roll's body is one column per day of the period, so the columns
 * depend on the period rather than on the register — they are generated
 * in `build.ts` and appended to these. Everything here is the fixed part.
 *
 * ⚠️ A DAY WITH NO ROW IS PRINTED AS "—", NEVER AS "P". The single most
 * dangerous default in an attendance system is treating silence as
 * presence: it pays somebody for a month nobody recorded, and it is
 * indistinguishable from a correctly-marked month on the printout.
 */
const ATTENDANCE_REGISTER: RegisterSpec = {
  kind: "attendance_register",
  title: "Attendance register (muster roll)",
  purpose:
    "Who was present on which day, and which absences were leave, which were unpaid and which were nobody telling anybody.",
  needsLeave: true,
  periodic: true,
  columns: [
    sourced("serial", "S. No.", "Row position in this document", "right", false),
    sourced("employeeCode", "Employee code", "employees.employee_code"),
    sourced("fullName", "Name", "employees.full_name"),
    unsourced(
      "hoursWorked",
      "Hours worked / spread-over",
      "Not held. `staff_attendance` records a verdict for the day and no clock times, so hours, rest intervals and spread-over cannot be produced.",
    ),
    unsourced(
      "overtimeHours",
      "Overtime hours",
      "Not held, as above. Blank rather than zero: nobody has told this system that no overtime was worked.",
    ),
    sourced("daysPresent", "Days present", "staff_attendance rows with status present/on_duty", "right"),
    sourced("daysLeave", "Days on leave", "staff_attendance rows with status paid_leave/unpaid_leave", "right"),
    sourced("daysAbsent", "Days absent", "staff_attendance rows with status absent", "right"),
    sourced("daysUnrecorded", "Days with no entry", "Days in the period with no attendance row at all", "right"),
    sourced("lopDays", "Loss-of-pay days", "Sum of staff_attendance.lop_fraction", "right"),
  ],
  refusal: null,
};

/* ------------------------------------------------------------------ */
/* ④ REGISTER OF LEAVE WITH WAGES                                      */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐ SHIPPED, AND IT IS THE REGISTER THE LEAVE LEDGER WAS ALREADY THE
 * RIGHT SHAPE FOR.
 *
 * The register of leave with wages asks, per employee per leave year:
 * leave brought forward, leave earned, leave taken with dates, leave
 * encashed, leave lapsed and the balance carried forward. `leave_ledger`
 * is an append-only signed ledger whose `kind` says exactly which of
 * those each entry is — `carry_forward_in`, `accrual`, `taken`,
 * `encashed`, `lapse`, `opening_balance`, `adjustment`. The register is
 * a fold of that ledger by kind, which is a derivation, not a guess.
 *
 * 🔴 `commitment` AND `commitment_release` ARE EXCLUDED, AND GETTING
 * THAT WRONG WOULD MIS-STATE EVERY BALANCE. They are reservations
 * against an approved application; they never move the balance. Folding
 * them in would report leave as taken that nobody has taken yet.
 *
 * 🔴 "WAGES PAID FOR THE LEAVE PERIOD" IS NOT SOURCED, and it is the
 * column the form's title is about. Payroll pays a monthly salary
 * against payable days; it does not compute or store a separate wage for
 * the days that happened to be leave. Deriving one by dividing a
 * month's gross by its days would be a plausible number that no payslip
 * supports and that the employee's own payslip would contradict.
 */
const LEAVE_REGISTER: RegisterSpec = {
  kind: "leave_with_wages_register",
  title: "Register of leave with wages",
  purpose:
    "What each person earned, took, encashed, lost and carried forward in a leave year — folded from the leave ledger by entry kind.",
  needsLeave: true,
  periodic: true,
  columns: [
    sourced("serial", "S. No.", "Row position in this document", "right", false),
    sourced("employeeCode", "Employee code", "employees.employee_code"),
    sourced("fullName", "Name", "employees.full_name"),
    sourced("joinedOn", "Date of joining", "employees.joined_on"),
    sourced("leaveType", "Leave type", "leave_types.code / label"),
    sourced("openingDays", "Leave brought forward", "leave_ledger opening_balance + carry_forward_in", "right"),
    sourced("earnedDays", "Leave earned in the year", "leave_ledger accrual", "right"),
    sourced("takenDays", "Leave taken", "leave_ledger taken (written from attendance only)", "right"),
    sourced("encashedDays", "Leave encashed", "leave_ledger encashed", "right"),
    sourced("lapsedDays", "Leave lapsed", "leave_ledger lapse", "right"),
    sourced("adjustedDays", "Adjustments", "leave_ledger adjustment", "right", false),
    sourced("closingDays", "Balance carried forward", "Fold of the entries above", "right"),
    unsourced(
      "wagesForLeave",
      "Wages paid for the leave period",
      "Not held. Payroll pays a monthly salary against payable days and stores no separate wage for the days that were leave. Dividing a month's gross by its days would produce a figure the employee's own payslip does not contain.",
    ),
    unsourced(
      "refusalOfLeave",
      "Leave refused, and the reason",
      "Not sourced. `leave_requests` records rejections with a note, but the form asks about leave with wages REFUSED under the Act, which is a narrower thing than an application declined for any reason. Reporting one as the other would overstate refusals.",
    ),
  ],
  refusal: null,
};

/* ------------------------------------------------------------------ */
/* ⑤ REGISTER OF LOANS AND ADVANCES — REFUSED                          */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴🔴 THIS ONE REFUSES TO GENERATE, AND THAT IS THE MOST IMPORTANT
 *        DECISION IN THE BATCH
 * ══════════════════════════════════════════════════════════════════════
 * The register of loans and advances wants, per advance: the date it was
 * granted, the purpose, the principal, the number of instalments, the
 * date and amount of every repayment, and the balance outstanding.
 *
 * ORDENCE HOLDS NONE OF THOSE. There is no loans table, no advances
 * table, and no instalment plan anywhere in the schema.
 *
 * ⚠️ WHAT THERE IS, AND WHY IT IS A TRAP: `payslips.other_deductions_minor`
 * and the deduction lines behind it. A structure component labelled
 * "Advance" produces a monthly deduction, and it is extremely tempting
 * to print those amounts under "amount repaid" and call it a register.
 *
 * 🔴 IT WOULD BE WRONG IN FOUR SEPARATE WAYS AT ONCE:
 *   1. The principal is unknown, so "balance outstanding" would be
 *      fabricated or blank on every row.
 *   2. The date of grant is unknown — a recurring deduction has no start
 *      event recorded anywhere.
 *   3. The purpose is unknown, and an advance against wages, a loan and
 *      a recovery for damage are legally different things with different
 *      limits on how much may be deducted.
 *   4. A canteen or uniform deduction sharing the bucket would be
 *      reported as loan repayment.
 *
 * ⭐ AND A BLANK REGISTER IS NOT THE SAFE FALLBACK. Producing a
 * correctly-headed Form C with no rows asserts that no advances were
 * granted, which is a statement about the employer's conduct and one
 * they did not make. Refusing produces no document and an explanation,
 * which is the only outcome that leaves the employer where they actually
 * are: needing to maintain this register outside Ordence until Ordence
 * can hold the facts.
 *
 * ⚠️ THE REFUSAL IS NOT SILENT. `build.ts` still gathers the evidence —
 * which employees had a non-statutory deduction, and how much — and
 * shows it under the refusal, so the reader can see that there IS
 * something to record and roughly how much of it there is.
 */
const LOANS_REGISTER: RegisterSpec = {
  kind: "loans_and_advances_register",
  title: "Register of loans and advances",
  purpose:
    "Every advance or loan made to an employee, its purpose, and each instalment recovered against it.",
  needsLeave: false,
  periodic: true,
  columns: [
    unsourced("grantedOn", "Date of advance / loan", "No loans or advances table exists."),
    unsourced("purpose", "Purpose", "Not held. An advance against wages, a loan and a recovery for damage carry different statutory deduction limits."),
    unsourced("principal", "Amount advanced", "Not held. Only monthly deduction amounts exist, and they are not the principal."),
    unsourced(
      "instalments",
      "Number of instalments",
      "Not held. A recurring deduction component has no end date and no instalment count; it stops when somebody removes it from the pay structure.",
    ),
    unsourced("repaidOn", "Date of each repayment", "Not held. Deductions are attached to a wage period, not to a repayment schedule."),
    unsourced("repaidAmount", "Amount repaid", "Only an undifferentiated 'other deductions' total exists, which may be canteen, uniform or damage rather than repayment."),
    unsourced("outstanding", "Balance outstanding", "Cannot be computed without a principal."),
  ],
  refusal:
    "Ordence holds no record of loans or advances — no principal, no date of grant, no purpose and no instalment plan. " +
    "The only related figure is an undifferentiated 'other deductions' total on the payslip, which may be an advance instalment, a canteen bill, a uniform charge or a recovery for damage. " +
    "Printing those amounts under this form would state repayments against loans that are not recorded, and printing an empty form would assert that no advances were granted. " +
    "This register is therefore not generated. Maintain it outside Ordence until advances are recorded as advances.",
};

/* ------------------------------------------------------------------ */

export const REGISTER_SPECS: Readonly<Record<RegisterKind, RegisterSpec>> = {
  employee_register: EMPLOYEE_REGISTER,
  wage_register: WAGE_REGISTER,
  attendance_register: ATTENDANCE_REGISTER,
  leave_with_wages_register: LEAVE_REGISTER,
  loans_and_advances_register: LOANS_REGISTER,
};

export function specFor(kind: RegisterKind): RegisterSpec {
  return REGISTER_SPECS[kind];
}

/** Every column the form wants and this product cannot fill. */
export function unsourcedColumns(spec: RegisterSpec): readonly RegisterColumn[] {
  return spec.columns.filter((c) => c.sourcing.kind === "unsourced");
}
