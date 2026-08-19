/**
 * Ordence — ⭐⭐⭐ PROFESSIONAL TAX RETURNS, WHICH ARE STATE LAW
 * Version: v1.52.0-alpha · Batch 78
 *
 * Pure. `bigint` paise. No I/O, no clock.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THERE IS NO SUCH THING AS AN INDIAN PROFESSIONAL TAX RETURN
 * ══════════════════════════════════════════════════════════════════════
 * Professional tax is levied by STATES under Article 276 of the
 * Constitution. Every one of them wrote its own Act, and they disagree
 * about:
 *
 *   • WHETHER IT EXISTS AT ALL — Delhi, Haryana, Uttar Pradesh and
 *     Rajasthan do not levy it;
 *   • THE FORM — Maharashtra's Form III-B, Karnataka's Form 5A, and so
 *     on, with nothing in common but the name "return";
 *   • THE FREQUENCY — and Maharashtra's is not even fixed: an employer
 *     whose liability in the previous year reached the threshold files
 *     MONTHLY, and everybody else files ANNUALLY;
 *   • THE SLABS, THE DUE DATE, AND WHETHER FEBRUARY IS DIFFERENT.
 *
 * ⭐ SO THIS MODULE HAS NO NATIONAL SHAPE. It has a table of States, and
 * for a State that is not in the table IT REFUSES. Not a blank form, not
 * "the common shape", not the 20th of the following month because that
 * is the most common due date — a refusal that names the State and says
 * what has to be configured.
 *
 * 🔴 THE ALTERNATIVE, WHICH IS WHAT MOST PAYROLL SOFTWARE DOES, IS TO
 * EMIT ONE GENERIC PT STATEMENT AND LET THE ACCOUNTANT ADAPT IT. That is
 * a well-formed document with a guessed statutory basis, and a well-formed
 * document with a guessed basis is precisely the failure this batch
 * exists to prevent: it gets filed, it is accepted, and it becomes the
 * employer's position.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT IN HERE NEEDS A CA'S CONFIRMATION — EXPLICITLY
 * ══════════════════════════════════════════════════════════════════════
 * Every row below carries `confirmedWithCa: false`. The form numbers and
 * frequencies were encoded from the State Acts as generally published;
 * none of them was checked against the State's current portal, because
 * the machine that wrote them has no network. A State whose form number
 * changed last April will produce a correct-looking worksheet headed
 * with last decade's form.
 *
 * ⭐ THE TABLE IS AN ARGUMENT, NOT A CONSTANT. `buildPtReturn` takes the
 * rows, so a tenant's own configuration — the natural home is
 * `statutory_rates` with `kind = 'professional_tax_return'` and
 * `scope = <state code>`, which already exists and is already
 * effective-dated — overrides the built-in table without touching code.
 */

import { pickEffective, type EffectiveDated } from "@/lib/payroll/statutory";
import { isWholeRupee, rupeesFromPaise } from "./layout";
import {
  blocking,
  containsDelimiter,
  hasBlocking,
  joinLines,
  refuse,
  sanitiseText,
  warn,
  type ReturnFinding,
  type StatutoryReturnOutcome,
} from "./validate";

/* ------------------------------------------------------------------ */
/* THE STATE TABLE                                                     */
/* ------------------------------------------------------------------ */

export type PtFilingFrequency = "monthly" | "annual";

/**
 * ⭐ FREQUENCY IS A RULE, NOT A VALUE, BECAUSE IN MAHARASHTRA IT IS ONE.
 *
 * ⚠️ AND THE RULE NEEDS AN INPUT THE PAYROLL DOES NOT HOLD — last year's
 * total liability. When it is not supplied the module REFUSES rather
 * than assuming monthly. Assuming monthly would file eleven returns that
 * were not due; assuming annual would miss eleven that were.
 */
export type PtFrequencyRule =
  | { readonly kind: "fixed"; readonly frequency: PtFilingFrequency }
  | {
      readonly kind: "prior_year_liability";
      /** Paise. At or above this, monthly; below it, annual. */
      readonly thresholdMinor: string;
      readonly citation: string;
    };

export interface PtReturnForm extends EffectiveDated {
  readonly stateCode: string;
  readonly stateName: string;
  /** 🔴 False means the State does not levy professional tax at all. */
  readonly levies: boolean;
  readonly formNumber: string | null;
  readonly frequency: PtFrequencyRule | null;
  /** Day of the following month the monthly return falls due, if known. */
  readonly dueDayNextMonth: number | null;
  readonly citation: string;
  /** 🔴 FALSE until a CA has checked it against the State's portal. */
  readonly confirmedWithCa: boolean;
  readonly note: string;
}

/**
 * ⚠️ FOUR STATES CONFIGURED AND FOUR STATES EXPLICITLY NIL. THAT IS ALL,
 * AND THE SHORTNESS IS THE POINT — every row here is a claim about
 * somebody's statutory obligation, and a row added on a hunch is worse
 * than no row, because no row produces a refusal that gets read.
 */
export const PT_RETURN_FORMS: readonly PtReturnForm[] = Object.freeze([
  {
    stateCode: "MH",
    stateName: "Maharashtra",
    levies: true,
    formNumber: "III-B",
    effectiveFrom: "2011-04-01",
    effectiveTo: null,
    frequency: {
      kind: "prior_year_liability",
      thresholdMinor: "5000000",
      citation:
        "Maharashtra State Tax on Professions, Trades, Callings and Employments Act 1975, r.11 — " +
        "an employer whose tax liability in the previous year was ₹50,000 or more files monthly; " +
        "below that, annually by 31 March.",
    },
    dueDayNextMonth: 31,
    citation: "MSTPTCE Act 1975 and the Rules made under it. Return in Form III-B.",
    confirmedWithCa: false,
    note:
      "🔴 CONFIRM THE FORM NUMBER, THE ₹50,000 THRESHOLD AND THE DUE DATE with a CA before filing. " +
      "The monthly return is due by the last day of the following month, which is NOT the 20th that " +
      "Ordence's generic compliance calendar assumes for professional tax.",
  },
  {
    stateCode: "KA",
    stateName: "Karnataka",
    levies: true,
    formNumber: "5A",
    effectiveFrom: "2015-04-01",
    effectiveTo: null,
    frequency: { kind: "fixed", frequency: "monthly" },
    dueDayNextMonth: 20,
    citation:
      "Karnataka Tax on Professions, Trades, Callings and Employments Act 1976 — monthly statement " +
      "in Form 5A, with an annual return in Form 5.",
    confirmedWithCa: false,
    note:
      "🔴 The ANNUAL return (Form 5) is NOT produced by this module — its due date is not encoded, " +
      "and a guessed annual due date is worse than none. Confirm both with a CA.",
  },
  /* --- States that do not levy it. A nil statement, not a file. ---- */
  {
    stateCode: "DL",
    stateName: "Delhi",
    levies: false,
    formNumber: null,
    effectiveFrom: "2000-04-01",
    effectiveTo: null,
    frequency: null,
    dueDayNextMonth: null,
    citation: "Delhi does not levy a tax on professions, trades, callings and employments.",
    confirmedWithCa: false,
    note: "No professional tax return exists. Confirm before relying on it.",
  },
  {
    stateCode: "HR",
    stateName: "Haryana",
    levies: false,
    formNumber: null,
    effectiveFrom: "2000-04-01",
    effectiveTo: null,
    frequency: null,
    dueDayNextMonth: null,
    citation: "Haryana does not levy professional tax.",
    confirmedWithCa: false,
    note: "No professional tax return exists. Confirm before relying on it.",
  },
  {
    stateCode: "UP",
    stateName: "Uttar Pradesh",
    levies: false,
    formNumber: null,
    effectiveFrom: "2000-04-01",
    effectiveTo: null,
    frequency: null,
    dueDayNextMonth: null,
    citation: "Uttar Pradesh does not levy professional tax.",
    confirmedWithCa: false,
    note: "No professional tax return exists. Confirm before relying on it.",
  },
  {
    stateCode: "RJ",
    stateName: "Rajasthan",
    levies: false,
    formNumber: null,
    effectiveFrom: "2000-04-01",
    effectiveTo: null,
    frequency: null,
    dueDayNextMonth: null,
    citation: "Rajasthan does not levy professional tax.",
    confirmedWithCa: false,
    note: "No professional tax return exists. Confirm before relying on it.",
  },
]);

export function ptFormFor(
  stateCode: string,
  onDate: string,
  forms: readonly PtReturnForm[] = PT_RETURN_FORMS,
): PtReturnForm | null {
  return pickEffective(
    forms.filter((f) => f.stateCode === stateCode.trim().toUpperCase()),
    onDate,
  );
}

/**
 * ⭐ THE FREQUENCY, OR AN HONEST NULL.
 *
 * ⚠️ NULL MEANS "CANNOT BE DETERMINED", never "monthly by default".
 */
export function ptFrequencyFor(
  form: PtReturnForm,
  priorYearLiabilityMinor: bigint | null,
): PtFilingFrequency | null {
  if (form.frequency === null) return null;
  if (form.frequency.kind === "fixed") return form.frequency.frequency;
  if (priorYearLiabilityMinor === null) return null;
  return priorYearLiabilityMinor >= BigInt(form.frequency.thresholdMinor) ? "monthly" : "annual";
}

/* ------------------------------------------------------------------ */
/* FACTS AND ROWS                                                      */
/* ------------------------------------------------------------------ */

export interface PtPersonFacts {
  readonly employeeId: string;
  readonly employeeCode: string;
  readonly employeeName: string;
  readonly workStateCode: string;
  readonly grossMinor: bigint;
  readonly professionalTaxMinor: bigint;
}

export interface PtRow {
  readonly employeeCode: string;
  readonly employeeName: string;
  readonly grossRupees: bigint;
  readonly taxRupees: bigint;
}

/** ⭐ What the State forms actually ask for: heads per rate, not per person. */
export interface PtSlabSummaryRow {
  readonly taxRupees: bigint;
  readonly employeeCount: number;
  readonly totalTaxRupees: bigint;
}

export interface PtBuildArgs {
  readonly people: readonly PtPersonFacts[];
  readonly stateCode: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  /** From `lib/compliance/statutory-due.ts`. */
  readonly dueOn: string;
  readonly dueAuthority: string;
  readonly ifLate: string;
  /** Needed by States whose frequency depends on it. Null is honest. */
  readonly priorYearLiabilityMinor: bigint | null;
  readonly forms?: readonly PtReturnForm[];
}

const PT_COLUMNS = ["Employee code", "Employee name", "Gross wages (₹)", "Professional tax (₹)"] as const;
const DELIMITER = ",";

export function buildPtReturn(args: PtBuildArgs): StatutoryReturnOutcome {
  const state = args.stateCode.trim().toUpperCase();
  const title = `Professional tax return — ${state}`;
  const period = { periodStart: args.periodStart, periodEnd: args.periodEnd };

  const form = ptFormFor(state, args.periodEnd, args.forms ?? PT_RETURN_FORMS);

  /**
   * 🔴 THE REFUSAL THIS MODULE IS FOR.
   *
   * ⚠️ NOTE WHAT IT DOES NOT DO: it does not fall back to a neighbouring
   * State, it does not emit the columns "most States want", and it does
   * not use the 20th-of-the-month assumption that Ordence's compliance
   * calendar carries for the AMOUNT. The amount can be assumed because
   * an assumed date on a dashboard is corrected by a human; a filed
   * return on the wrong form under the wrong Act is not.
   */
  if (form === null) {
    return refuse({
      kind: "professional_tax",
      title,
      reason:
        `Professional tax returns are not configured for ${state}. Professional tax is State law — ` +
        "the form, the frequency and the slabs all differ, and some States do not levy it at all. " +
        "Ordence will not guess a form for a State it has not been told about. Add the State's " +
        "return configuration, confirmed with a CA, and regenerate.",
      findings: [
        blocking(
          "pt_state_not_configured",
          state,
          `No professional tax return form is configured for ${state} as at ${args.periodEnd}.`,
        ),
      ],
      ...period,
    });
  }

  if (!form.levies) {
    return refuse({
      kind: "professional_tax",
      title: `Professional tax — ${form.stateName}`,
      reason:
        `${form.stateName} does not levy professional tax, so no return exists to file. ${form.citation} ` +
        "This is a nil obligation rather than a missing file. " +
        (form.confirmedWithCa ? "" : "⚠️ This has not been confirmed with a CA."),
      findings: [
        blocking(
          "no_rows",
          form.stateName,
          `${form.stateName} levies no professional tax; there is no form and no due date.`,
        ),
      ],
      ...period,
    });
  }

  const frequency = ptFrequencyFor(form, args.priorYearLiabilityMinor);
  if (frequency === null) {
    return refuse({
      kind: "professional_tax",
      title,
      reason:
        `${form.stateName}'s filing frequency depends on the employer's professional tax liability in ` +
        "the previous year, which has not been supplied. Filing monthly when the return is annual, or " +
        "annually when it is monthly, is a default that cannot be corrected retrospectively without " +
        "interest. Supply last year's liability and regenerate.",
      findings: [
        blocking(
          "pt_frequency_unknown",
          form.stateName,
          form.frequency !== null && form.frequency.kind === "prior_year_liability"
            ? form.frequency.citation
            : "The filing frequency for this State is not encoded.",
        ),
      ],
      ...period,
    });
  }

  const people = args.people.filter((p) => p.workStateCode.trim().toUpperCase() === state);
  if (people.length === 0) {
    return refuse({
      kind: "professional_tax",
      title,
      reason: `No employee in this period has ${state} as their work State, so there is nothing to return.`,
      findings: [blocking("no_rows", state, `No employee works in ${state} this period.`)],
      ...period,
    });
  }

  const findings: ReturnFinding[] = [];
  const rows: PtRow[] = [];

  for (const p of people) {
    const who = `${p.employeeName} (${p.employeeCode})`;
    if (p.professionalTaxMinor < 0n || p.grossMinor < 0n) {
      findings.push(blocking("negative_amount", who, "A negative amount cannot appear on a return."));
    }
    /**
     * 🔴 PROFESSIONAL TAX IS A SLAB AMOUNT AND IS ALWAYS A WHOLE RUPEE.
     * A figure with paise in it did not come from a slab, so something
     * upstream is computing it as a percentage — which is a different
     * State's rule, or a bug, and either way it must not be rounded away
     * quietly on the way into a return.
     */
    if (!isWholeRupee(p.professionalTaxMinor)) {
      findings.push(
        blocking(
          "paise_would_be_lost",
          who,
          `Professional tax is ${p.professionalTaxMinor} paise. Slab amounts are whole rupees; a ` +
            "figure with paise did not come from the slab table.",
        ),
      );
    }
    const name = sanitiseText(p.employeeName);
    if (containsDelimiter(name, DELIMITER)) {
      findings.push(
        blocking(
          "member_name_missing",
          who,
          "The name contains a comma, which is the column separator on this worksheet.",
        ),
      );
    }
    rows.push({
      employeeCode: p.employeeCode,
      employeeName: name,
      grossRupees: rupeesFromPaise(p.grossMinor, "nearest") ?? 0n,
      taxRupees: rupeesFromPaise(p.professionalTaxMinor, "nearest") ?? 0n,
    });
  }

  if (frequency === "annual") {
    findings.push(
      warn(
        "pt_frequency_unknown",
        form.stateName,
        `${form.stateName} requires an ANNUAL return from this employer, not a monthly one. The ` +
          "worksheet below covers one month and is a working paper towards that annual return, not " +
          "the return itself.",
      ),
    );
  }
  if (!form.confirmedWithCa) {
    findings.push(
      warn(
        "pt_state_not_configured",
        form.stateName,
        `The form number (${form.formNumber ?? "unknown"}), the frequency and the due date for ` +
          `${form.stateName} have NOT been confirmed with a CA. ${form.note}`,
      ),
    );
  }

  if (hasBlocking(findings)) {
    const named = findings.filter((f) => f.severity === "blocking").length;
    return refuse({
      kind: "professional_tax",
      title,
      reason: `${named} blocking finding${named === 1 ? "" : "s"} on the ${form.stateName} professional tax return.`,
      findings,
      ...period,
    });
  }

  /* --- what the State forms actually want ------------------------ */
  const bySlab = new Map<string, PtSlabSummaryRow>();
  for (const r of rows) {
    const key = r.taxRupees.toString();
    const existing = bySlab.get(key);
    bySlab.set(key, {
      taxRupees: r.taxRupees,
      employeeCount: (existing?.employeeCount ?? 0) + 1,
      totalTaxRupees: (existing?.totalTaxRupees ?? 0n) + r.taxRupees,
    });
  }
  const slabSummary = [...bySlab.values()].sort((a, b) => (a.taxRupees < b.taxRupees ? -1 : 1));

  const lines = [
    PT_COLUMNS.join(DELIMITER),
    ...rows.map((r) =>
      [r.employeeCode, r.employeeName, r.grossRupees.toString(), r.taxRupees.toString()].join(DELIMITER),
    ),
    "",
    ["Rate (₹)", "Employees", "Tax (₹)", ""].join(DELIMITER),
    ...slabSummary.map((s) =>
      [s.taxRupees.toString(), String(s.employeeCount), s.totalTaxRupees.toString(), ""].join(DELIMITER),
    ),
  ];

  const month = args.periodEnd.slice(0, 7).replace("-", "");

  return {
    generated: true,
    file: {
      kind: "professional_tax",
      title: `Professional tax return ${form.formNumber ?? ""} — ${form.stateName}`.trim(),
      fileName: `PT_${state}_${month}.csv`,
      text: joinLines(lines),
      lineCount: rows.length,
      layoutId: `pt_${state.toLowerCase()}`,
      layoutVersion: form.formNumber ?? "unnumbered",
      layoutSource: form.citation,
      confirmedAgainstPortal: form.confirmedWithCa,
      periodStart: args.periodStart,
      periodEnd: args.periodEnd,
      dueOn: args.dueOn,
      dueAuthority: args.dueAuthority,
      ifLate: args.ifLate,
      totals: {
        grossMinor: people.reduce((a, p) => a + p.grossMinor, 0n),
        professionalTaxMinor: people.reduce((a, p) => a + p.professionalTaxMinor, 0n),
      },
      basis: [
        `${form.stateName}, ${form.citation}`,
        `Filing frequency for this employer: ${frequency}.`,
        `${rows.length} employees whose work State is ${state}. Employees in other States are on their own State's return.`,
        "Professional tax is a slab amount, so no rounding was applied to it — a figure with paise in " +
          "it blocks the return instead.",
      ],
      warnings: [
        "🔴 THIS IS A WORKING PAPER FOR THE STATE'S OWN FORM, NOT A PORTAL-READY FILE. Most State " +
          "professional tax portals take a web form or their own template; transcribe these figures " +
          "into it.",
        form.confirmedWithCa
          ? "The form and frequency have been confirmed."
          : `⚠️ ${form.note}`,
        "⚠️ The due date shown is the generic 20th-of-the-following-month that Ordence's compliance " +
          "calendar assumes for professional tax. THE ACTUAL DUE DATE IS SET BY THE STATE — " +
          (form.dueDayNextMonth === null
            ? "this State's is not encoded."
            : `${form.stateName}'s is understood to be day ${form.dueDayNextMonth} of the following month, unconfirmed.`),
      ],
      findings,
    },
  };
}
