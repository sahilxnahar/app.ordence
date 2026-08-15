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
