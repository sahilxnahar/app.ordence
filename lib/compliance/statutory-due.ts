/**
 * Ordence — ⭐⭐⭐ WHAT THIS BUSINESS OWES A GOVERNMENT THIS MONTH
 * Version: v1.24.0-alpha · Batch 16
 *
 * Pure. No database, no clock. `today` is always an argument.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE PROBLEM THIS SOLVES IS NOT CALCULATION. IT IS ASSEMBLY.
 * ══════════════════════════════════════════════════════════════════════
 * Every one of these liabilities is already correct in the ledger. GST
 * output tax has been there since v0.9x, vendor TDS since v1.11.0, and
 * provident fund, pension, ESI, professional tax and salary TDS since
 * last session's payroll batch.
 *
 * ⚠️ AND NOTHING ANYWHERE PUTS THEM ON ONE PAGE WITH THEIR DUE DATES.
 * A business owner finds out what they owe by opening a trial balance
 * and knowing which eight accounts to look at, which is a thing nobody
 * does on the 6th of the month.
 *
 * 🔴 THE COST OF MISSING ONE IS NOT THE TAX. It is interest at 1% or
 * 1.5% a month, a late fee per day, and — for provident fund and ESI —
 * damages that can exceed the contribution itself. Every one of those is
 * avoidable by knowing the date.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE DATES ARE STATED AS THE LAW STATES THEM
 * ══════════════════════════════════════════════════════════════════════
 * "The 15th of the following month", not "thirty days after". The two
 * are different dates in eleven months out of twelve, and the second one
 * is how a compliance calendar quietly drifts.
 */

export type ObligationKind =
  | "gst_3b"
  | "gst_1"
  | "tds_vendor"
  | "tds_salary"
  | "provident_fund"
  | "esi"
  | "professional_tax";

export interface ObligationRule {
  readonly kind: ObligationKind;
  readonly label: string;
  /** Day of the FOLLOWING month it falls due. */
  readonly dueDayNextMonth: number;
  /** Which ledger role balances make it up. */
  readonly roles: readonly string[];
  readonly authority: string;
  /** ⚠️ What happens if it is late, in words the owner will act on. */
  readonly ifLate: string;
}

/**
 * ⭐ SEVEN OBLIGATIONS, AND EVERY ONE IS BACKED BY A LEDGER BALANCE
 * RATHER THAN BY A REMINDER.
 *
 * ⚠️ A COMPLIANCE CALENDAR THAT IS ONLY A CALENDAR TELLS YOU A DATE HAS
 * ARRIVED AND NOT WHETHER YOU OWE ANYTHING. Ordence already has one of
 * those, in `compliance_deadlines`, and it is genuinely useful for
 * licences and renewals. This is the other half: the amount.
 *
 * 🔴 PROFESSIONAL TAX HAS NO SINGLE NATIONAL DUE DATE, and pretending it
 * does would be worse than saying so. The 20th is the most common, it is
 * marked as an assumption, and the note says to check the State.
 */
export const OBLIGATIONS: readonly ObligationRule[] = Object.freeze([
  {
    kind: "tds_vendor",
    label: "TDS deducted from vendors",
    dueDayNextMonth: 7,
    roles: ["tds_payable"],
    authority: "Income Tax Department",
    ifLate:
      "Interest at 1.5% per month from the date of deduction, counted in whole months — one day late costs a full month.",
  },
  {
    kind: "tds_salary",
    label: "TDS deducted from salaries (s.192)",
    dueDayNextMonth: 7,
    roles: ["tds_payable_salary"],
    authority: "Income Tax Department",
    ifLate:
      "Interest at 1.5% per month, and the deduction cannot be shown against the employee's PAN until the challan is paid.",
  },
  {
    kind: "provident_fund",
    label: "Provident fund and pension",
    dueDayNextMonth: 15,
    roles: ["pf_payable", "pension_payable"],
    authority: "EPFO",
    ifLate:
      "Interest at 12% a year plus damages of up to 25% a year. ⚠️ Employee contributions deducted and not deposited are treated far more seriously than the employer's own share.",
  },
  {
    kind: "esi",
    label: "Employees' State Insurance",
    dueDayNextMonth: 15,
    roles: ["esi_payable"],
    authority: "ESIC",
    ifLate: "Interest at 12% a year plus damages, and cover can lapse for the employees themselves.",
  },
  {
    kind: "professional_tax",
    label: "Professional tax",
    // ⚠️ AN ASSUMPTION, NOT A RULE. See the header.
    dueDayNextMonth: 20,
    roles: ["professional_tax_payable"],
    authority: "State government",
    ifLate:
      "Varies by State, usually interest plus a penalty. ⚠️ The due date varies by State too — the 20th is the common one and Ordence assumes it. Check yours.",
  },
  {
    kind: "gst_1",
    label: "GSTR-1, outward supplies",
    dueDayNextMonth: 11,
    roles: [],
    authority: "GSTN",
    ifLate:
      "Late fee per day, and — the expensive part — your customers cannot see the invoice in their 2B, so they chase you for credit they cannot take.",
  },
  {
    kind: "gst_3b",
    label: "GSTR-3B and the tax with it",
    dueDayNextMonth: 20,
    roles: ["output_cgst", "output_sgst", "output_igst", "output_cess"],
    authority: "GSTN",
    ifLate: "Interest at 18% a year on the cash portion, plus a late fee for every day.",
  },
]);

export const OBLIGATION_BY_KIND: Readonly<Record<string, ObligationRule>> =
  Object.freeze(Object.fromEntries(OBLIGATIONS.map((o) => [o.kind, o])));

/* ------------------------------------------------------------------ */
/* DUE DATES                                                           */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ "THE 7TH OF THE FOLLOWING MONTH", NOT "SEVEN DAYS AFTER".
 *
 * 🔴 THE TWO DIVERGE IN EVERY MONTH THAT IS NOT 30 DAYS LONG, and the
 * error is silent: the calendar shows a date, somebody pays on it, and
 * the interest clock had already started. `server/actions/compliance.ts`
 * documents the same trap for GSTR-3B.
 */
export function dueDateFor(periodEnd: string, dueDayNextMonth: number): string {
  const year = Number(periodEnd.slice(0, 4));
  const month = Number(periodEnd.slice(5, 7));
  if (!Number.isFinite(year) || !Number.isFinite(month)) return periodEnd;

  const dueMonth = month === 12 ? 1 : month + 1;
  const dueYear = month === 12 ? year + 1 : year;

  // ⚠️ Clamped to the month's length, so a "31st" rule in February lands
  // on the 28th rather than rolling into March.
  const lastDay = new Date(Date.UTC(dueYear, dueMonth, 0)).getUTCDate();
  const day = dueDayNextMonth > lastDay ? lastDay : dueDayNextMonth;

  return `${dueYear}-${String(dueMonth).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ */
/* THE LIST                                                            */
/* ------------------------------------------------------------------ */

export type DueState = "not_due" | "due_soon" | "due_today" | "overdue" | "nothing_owed";

export interface DueItem {
  readonly kind: ObligationKind;
  readonly label: string;
  readonly authority: string;
  readonly amountMinor: bigint;
  readonly dueOn: string;
  readonly state: DueState;
  readonly daysUntil: number;
  readonly ifLate: string;
  /** ⭐ Which ledger balances this figure came from. */
  readonly sourceRoles: readonly string[];
  readonly note: string | null;
}

/** ⚠️ Inside this many days it is worth surfacing. */
export const DUE_SOON_DAYS = 5;

export function buildDueList(args: {
  readonly periodEnd: string;
  /** Ledger role → closing balance in paise. Absent means zero. */
  readonly balances: Readonly<Record<string, bigint>>;
  /** ⭐ The 3B cash figure, which is NOT the raw output-tax balance. */
  readonly gstCashPayableMinor: bigint | null;
  readonly today: string;
}): readonly DueItem[] {
  const items: DueItem[] = [];

  for (const rule of OBLIGATIONS) {
    const dueOn = dueDateFor(args.periodEnd, rule.dueDayNextMonth);
    const daysUntil = daysBetween(args.today, dueOn);

    let amount: bigint;
    let note: string | null = null;

    if (rule.kind === "gst_3b") {
      /**
       * 🔴 THE GST FIGURE IS THE 3B CASH PAYABLE, NOT THE OUTPUT TAX
       * BALANCE, AND THE DIFFERENCE IS THE WHOLE POINT OF A 3B.
       *
       * ⚠️ Output tax of ₹4,00,000 against ₹3,60,000 of credit means
       * ₹40,000 leaves the bank. Showing the ₹4,00,000 would frighten
       * somebody into arranging ten times the cash they need.
       */
      if (args.gstCashPayableMinor === null) {
        amount = 0n;
        note =
          "No GSTR-3B has been prepared for this period yet, so the cash figure is not known. The output tax in the ledger is not the answer — credit has to be set off against it first.";
      } else {
        amount = args.gstCashPayableMinor;
        note = "From the prepared GSTR-3B, after credit has been set off.";
      }
    } else if (rule.kind === "gst_1") {
      // ⚠️ A STATEMENT, NOT A PAYMENT. Zero is correct and the note says
      // why, rather than leaving a nil row looking like an error.
      amount = 0n;
      note = "Nothing to pay — GSTR-1 is a statement of outward supplies. The money moves with the 3B.";
    } else {
      amount = rule.roles.reduce((sum, role) => sum + (args.balances[role] ?? 0n), 0n);
    }

    const state: DueState =
      amount === 0n && rule.kind !== "gst_1"
        ? "nothing_owed"
        : daysUntil < 0
          ? "overdue"
          : daysUntil === 0
            ? "due_today"
            : daysUntil <= DUE_SOON_DAYS
              ? "due_soon"
              : "not_due";

    items.push({
      kind: rule.kind,
      label: rule.label,
      authority: rule.authority,
      amountMinor: amount,
      dueOn,
      state,
      daysUntil,
      ifLate: rule.ifLate,
      sourceRoles: rule.roles,
      note,
    });
  }

  /**
   * ⭐ SORTED BY WHAT NEEDS DOING, NOT BY DATE.
   *
   * ⚠️ Overdue first, then due today, then soon. A list in date order
   * puts a settled obligation from the 7th above an overdue one from
   * last month, which is the opposite of useful.
   */
  const rank: Record<DueState, number> = {
    overdue: 0,
    due_today: 1,
    due_soon: 2,
    not_due: 3,
    nothing_owed: 4,
  };

  return [...items].sort(
    (a, b) => rank[a.state] - rank[b.state] || a.dueOn.localeCompare(b.dueOn),
  );
}

function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/**
 * ⭐ ONE SENTENCE FOR THE TOP OF THE SCREEN.
 *
 * ⚠️ IT LEADS WITH OVERDUE AND WITH MONEY, because that is the only
 * thing on the page that changes what somebody does in the next hour.
 */
export function summariseDue(items: readonly DueItem[]): string {
  const overdue = items.filter((i) => i.state === "overdue" && i.amountMinor > 0n);
  const soon = items.filter(
    (i) => (i.state === "due_today" || i.state === "due_soon") && i.amountMinor > 0n,
  );

  const rupees = (minor: bigint) => `₹${(minor / 100n).toLocaleString("en-IN")}`;

  if (overdue.length > 0) {
    const total = overdue.reduce((s, i) => s + i.amountMinor, 0n);
    return `${rupees(total)} is overdue across ${overdue.length} obligation${overdue.length === 1 ? "" : "s"}. Interest is running on every one of them.`;
  }
  if (soon.length > 0) {
    const total = soon.reduce((s, i) => s + i.amountMinor, 0n);
    return `${rupees(total)} falls due within ${DUE_SOON_DAYS} days.`;
  }

  const owed = items.filter((i) => i.amountMinor > 0n);
  if (owed.length === 0) {
    return "Nothing is owed to any authority for this period. If that is a surprise, the month may not have been posted yet.";
  }
  const total = owed.reduce((s, i) => s + i.amountMinor, 0n);
  return `${rupees(total)} is owed for this period, none of it due yet.`;
}

/* ================================================================== */
/* ⭐⭐⭐ THE PAYMENT OF WAGES ACT, 1936 — THE DATE WAGES WERE PAID     */
/* ================================================================== */

/**
 * 🔴🔴 THIS SECTION EXISTS BECAUSE `payroll_runs` COULD NOT STORE THE
 * ONLY FACT THE ACT IS ABOUT.
 *
 * The run recorded what was computed — gross, PF, ESI, TDS, net — and
 * when it was APPROVED and when it was POSTED. It recorded nothing at
 * all about when the money reached the employee. The Payment of Wages
 * Act, 1936 is, end to end, about that day:
 *
 *   • s.5(1) — wages must be paid before the expiry of the SEVENTH day
 *     after the last day of the wage period in an establishment
 *     employing fewer than one thousand persons, and before the expiry
 *     of the TENTH day otherwise.
 *   • s.4 — a wage period may not exceed one month, which is why the
 *     day is counted from the end of the period and not from the run.
 *   • s.13A — the employer must maintain registers, and the register an
 *     inspector opens is a register of DATES PAID.
 *
 * ⚠️ SO A RUN THAT IS "approved" AND "posted" AND SILENT ON PAYMENT IS
 * NOT EVIDENCE OF COMPLIANCE. It is evidence that an accrual was made.
 *
 * ⭐ WHY THIS LIVES HERE AND NOT IN A NEW MODULE. `dueDateFor` above
 * already means "the Nth day of the month following the period", and
 * `DueState` already means "overdue / due today / due soon". A second
 * due-date notion in `lib/payroll/` would drift from this one within a
 * release. Wages are simply an eighth obligation with a different payee
 * — the employee rather than an authority — so they reuse the machinery
 * and are kept out of `OBLIGATIONS` only because that list feeds the
 * ledger-balance assembly and wages are not a ledger role.
 */

/**
 * 🔴 THE THRESHOLD IN s.5(1) IS A HEADCOUNT, AND IT IS THE
 * ESTABLISHMENT'S HEADCOUNT, NOT THE RUN'S. A run covering forty
 * employees inside a factory of twelve hundred is a 10th-of-the-month
 * establishment. Deriving the band from `employee_count` on the run
 * would give the wrong date to every partial run, so it is stated.
 */
export type EstablishmentWageBand = "under_1000" | "1000_or_more";

/** s.5(1) — the two days the Act names, as data rather than literals. */
export const WAGE_PAYMENT_DUE_DAY: Readonly<Record<EstablishmentWageBand, number>> =
  Object.freeze({
    under_1000: 7,
    "1000_or_more": 10,
  });

/**
 * 🔴🔴 THE TERMINATED EMPLOYEE IS ON A DIFFERENT CLOCK, AND GETTING
 * THIS WRONG IS THE COMMONEST WAGE CLAIM THERE IS.
 *
 * Somebody whose employment ends on the 3rd does NOT wait until the 7th
 * of the following month for the wages they have already earned. The
 * ordinary wage-period rule in s.5(1) does not govern them at all.
 *
 * ⚠️⚠️ WHAT THE OFFSET SHOULD BE IS NOT SOMETHING ORDENCE MAY DECIDE,
 * AND IT IS CONFIGURATION FOR THAT REASON. Three readings are live:
 *
 *   ① the last working day itself — the reading Ordence's own
 *     compliance brief states, and the one that is safest for the
 *     employee, so it is the DEFAULT (offset 0);
 *   ② "before the expiry of the second working day from the day on
 *     which his employment is terminated" — the wording that appears in
 *     the Payment of Wages Act's termination limb as commonly printed;
 *   ③ two working days under s.17(2) of the Code on Wages, 2019, which
 *     is enacted but whose sections were not all in force as this was
 *     written.
 *
 * 🔴 THE DEFAULT OF ZERO IS DELIBERATELY THE STRICTEST OF THE THREE.
 * Being strict produces a false "overdue" flag on a settlement paid two
 * days late; being lax produces a settlement that is genuinely late and
 * that Ordence reported as fine. Only the first of those is recoverable.
 * ⚠️ A CA OR THE ESTABLISHMENT'S COUNSEL MUST CONFIRM WHICH READING THE
 * ESTABLISHMENT FOLLOWS BEFORE THIS IS MOVED OFF ZERO — and note that
 * ② and ③ count WORKING days, which this function cannot count without
 * the establishment's holiday calendar, so a non-zero offset here is
 * calendar days and is an approximation that must be said out loud.
 */
export const TERMINATION_WAGE_DUE_OFFSET_DAYS_DEFAULT = 0;

export interface WagePaymentDue {
  /** The date by which the wages had to be in the employee's hands. */
  readonly dueOn: string;
  /** ⭐ Which limb produced it, in words the register can print. */
  readonly basis: "wage_period" | "termination";
  /** The section, so the figure can be checked against the bare Act. */
  readonly section: string;
  readonly note: string;
}

/**
 * ⭐ ONE FUNCTION, TWO LIMBS, AND THE TERMINATION LIMB WINS.
 *
 * ⚠️ `terminatedOn` is the LAST WORKING DAY, not the resignation date
 * and not the date the paperwork cleared. Where it is present the
 * ordinary s.5(1) date is not merely earlier — it does not apply.
 */
export function wagePaymentDueDate(args: {
  readonly periodEnd: string;
  readonly band: EstablishmentWageBand;
  /** Null for an ordinary monthly run. */
  readonly terminatedOn?: string | null;
  readonly terminationOffsetDays?: number;
}): WagePaymentDue {
  const terminatedOn =
    typeof args.terminatedOn === "string" && args.terminatedOn.length > 0
      ? args.terminatedOn
      : null;

  if (terminatedOn !== null) {
    const offset = Math.max(
      0,
      Math.trunc(args.terminationOffsetDays ?? TERMINATION_WAGE_DUE_OFFSET_DAYS_DEFAULT),
    );
    return {
      dueOn: shiftIsoDays(terminatedOn, offset),
      basis: "termination",
      section: "Payment of Wages Act, 1936 s.5 (termination limb)",
      note:
        offset === 0
          ? `Employment ended on ${terminatedOn}, so the wages earned fell due on the last working day itself. The seventh-of-the-following-month rule in s.5(1) governs a wage period, and this employee no longer has one.`
          : `Employment ended on ${terminatedOn}; the establishment applies a ${offset}-day allowance after the last working day. ⚠️ That allowance is counted in CALENDAR days here because Ordence does not hold the establishment's holiday calendar, and the Act's termination limb counts working days.`,
    };
  }

  const day = WAGE_PAYMENT_DUE_DAY[args.band];
  return {
    // ⭐ REUSES `dueDateFor`, so wages clamp to the end of a short month
    // exactly as every other obligation on this page does.
    dueOn: dueDateFor(args.periodEnd, day),
    basis: "wage_period",
    section: "Payment of Wages Act, 1936 s.5(1)",
    note:
      args.band === "under_1000"
        ? "Fewer than one thousand persons employed, so wages fell due before the expiry of the seventh day after the end of the wage period (s.5(1))."
        : "One thousand or more persons employed, so wages fell due before the expiry of the tenth day after the end of the wage period (s.5(1)).",
  };
}

/** ⚠️ Calendar arithmetic in UTC. No time zone reaches a due date. */
function shiftIsoDays(iso: string, days: number): string {
  const at = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(at)) return iso;
  const moved = new Date(at + days * 86_400_000);
  return moved.toISOString().slice(0, 10);
}

/**
 * ⭐⭐ THE THING WORTH SURFACING: A RUN PAST ITS DATE AND NOT MARKED PAID.
 *
 * 🔴 NOT "a run that is unapproved", AND NOT "a run that is unposted".
 * Approval is a signature and posting is a journal; neither one is money
 * leaving a bank. A run approved on the 3rd whose NEFT file bounced on
 * the 6th is the exact case this exists to catch, and every status-based
 * view in Ordence shows it as green.
 */
export interface WageRunFacts {
  readonly runNo: string;
  readonly periodEnd: string;
  readonly netPayMinor: bigint;
  readonly employeeCount: number;
  /** 🔴 NULL MEANS UNPAID. It never means "assume approved is paid". */
  readonly paidOn: string | null;
  /** ⚠️ Set when a transfer was attempted and failed. Still unpaid. */
  readonly paymentFailedOn: string | null;
  readonly band: EstablishmentWageBand;
  /** The last working day, for a final-settlement run. */
  readonly terminatedOn: string | null;
}

export interface WagePaymentStatus {
  readonly runNo: string;
  readonly due: WagePaymentDue;
  readonly state: DueState;
  readonly daysUntil: number;
  readonly amountMinor: bigint;
  readonly paidOn: string | null;
  /** ⭐ True only where the money is late, which is the actionable set. */
  readonly lateBy: number;
  readonly message: string;
}

export function wagePaymentStatus(
  run: WageRunFacts,
  today: string,
  terminationOffsetDays?: number,
): WagePaymentStatus {
  const due = wagePaymentDueDate({
    periodEnd: run.periodEnd,
    band: run.band,
    terminatedOn: run.terminatedOn,
    terminationOffsetDays,
  });

  const daysUntil = daysBetween(today, due.dueOn);

  if (run.paidOn !== null) {
    // ⭐ A PAID RUN IS STILL REPORTED AGAINST ITS DUE DATE, because the
    // register the inspector reads is a register of dates paid and a run
    // paid on the 12th is a finding whatever today is.
    const lateBy = daysBetween(due.dueOn, run.paidOn);
    return {
      runNo: run.runNo,
      due,
      state: "nothing_owed",
      daysUntil,
      amountMinor: run.netPayMinor,
      paidOn: run.paidOn,
      lateBy: lateBy > 0 ? lateBy : 0,
      message:
        lateBy > 0
          ? `Paid on ${run.paidOn}, ${lateBy} day${lateBy === 1 ? "" : "s"} after the ${due.dueOn} the Act allowed. ⚠️ The delay is on the record and s.20 makes it an offence; the register cannot be corrected by paying now.`
          : `Paid on ${run.paidOn}, within the ${due.dueOn} the Act allowed.`,
    };
  }

  const state: DueState =
    daysUntil < 0
      ? "overdue"
      : daysUntil === 0
        ? "due_today"
        : daysUntil <= DUE_SOON_DAYS
          ? "due_soon"
          : "not_due";

  const failed =
    run.paymentFailedOn === null
      ? ""
      : ` A transfer was attempted on ${run.paymentFailedOn} and failed, so the run is approved and still unpaid.`;

  const rupees = `₹${(run.netPayMinor / 100n).toLocaleString("en-IN")}`;

  return {
    runNo: run.runNo,
    due,
    state,
    daysUntil,
    amountMinor: run.netPayMinor,
    paidOn: null,
    lateBy: daysUntil < 0 ? -daysUntil : 0,
    message:
      state === "overdue"
        ? `${rupees} of net wages for ${run.employeeCount} employee${run.employeeCount === 1 ? "" : "s"} is ${-daysUntil} day${daysUntil === -1 ? "" : "s"} past the ${due.dueOn} required by ${due.section}, and is not marked paid.${failed}`
        : `${rupees} of net wages falls due on ${due.dueOn} under ${due.section}.${failed}`,
  };
}

/**
 * ⭐ SORTED BY HOW LATE THE MONEY IS. ⚠️ Unlike `buildDueList` this does
 * NOT drop nil rows: a run with a net of zero and no payment date is a
 * data problem worth seeing, not an obligation that has been met.
 */
export function overdueWagePayments(
  runs: readonly WageRunFacts[],
  today: string,
  terminationOffsetDays?: number,
): readonly WagePaymentStatus[] {
  return runs
    .map((r) => wagePaymentStatus(r, today, terminationOffsetDays))
    .filter((s) => s.paidOn === null && s.state === "overdue")
    .sort((a, b) => b.lateBy - a.lateBy || a.due.dueOn.localeCompare(b.due.dueOn));
}
