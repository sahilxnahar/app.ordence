/**
 * Ordence — ⭐⭐ FORM 16 PART B AS A DOCUMENT
 * Version: v1.52.0-alpha
 *
 * Pure. Turns the computation in `form16.ts` into the same shape every
 * other compliance artefact in this product prints as.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHY THIS REUSES `lib/registers/` RATHER THAN INTRODUCING A RENDERER
 * ══════════════════════════════════════════════════════════════════════
 * `lib/registers/document.ts` already solved the hard part of printing a
 * compliance document: a `null` cell that means "not recorded" and never
 * renders as a zero, a STATED BASIS listing what the figures were built
 * from, an honest `final`/`provisional` status, and a content digest so
 * two printouts with the same heading can be told apart in five seconds.
 * Form 16 needs every one of those, for exactly the same reason — an
 * employee holding last year's certificate and an employer regenerating
 * it must be able to see whether they are the same document.
 *
 * ⚠️ BUT FORM 16 IS NOT A `RegisterKind`, AND MAKING IT ONE WOULD BE A
 * BUG OF ITS OWN. `RegisterKind` is the set of registers maintained under
 * the labour codes — wage, attendance, leave — and they are picked from
 * one dropdown, share one rule-set citation and one permission set. A
 * salary TDS certificate under Rule 31 has a different statute, a
 * different reader and a per-employee scope. It borrows the CARPENTRY
 * (columns, rows, digest, money formatting) and keeps its own taxonomy.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE INVARIANT THIS FILE EXISTS TO HOLD
 * ══════════════════════════════════════════════════════════════════════
 * `part` is the literal `"B"` and `includesPartA` is the literal `false`.
 * Nothing assembled here is Part A, the Part A figures appear under a
 * heading that says they are inputs for reconciliation, and the notice
 * naming TRACES is generated from `PART_A_MUST_COME_FROM_TRACES` so it
 * cannot be edited out of one surface and left in another.
 */

import type { RegisterCell, RegisterRow, RegisterStatus } from "@/lib/registers/document";
import type { RegisterColumn } from "@/lib/registers/spec";
import { digestOf } from "@/lib/registers/digest";
import { formatPaise } from "@/lib/registers/format";
import {
  PART_A_MUST_COME_FROM_TRACES,
  type Form16Finding,
  type Form16Line,
  type Form16Outcome,
  type Form16PartAInputs,
  type Form16PartB,
  type Form16Reconciliation,
} from "./form16";

/* ------------------------------------------------------------------ */
/* SHAPE                                                               */
/* ------------------------------------------------------------------ */

export interface Form16Document {
  /** 🔴 The literal `"B"`. There is no `"A"` and there is no `"A+B"`. */
  readonly part: "B";
  /** 🔴 A type-level promise, not a runtime flag somebody can flip. */
  readonly includesPartA: false;

  readonly title: string;
  /** The sentence about TRACES, printed on the face of the document. */
  readonly partANotice: string;

  readonly financialYear: string;
  readonly assessmentYear: string;
  readonly employeeName: string;
  readonly employeePan: string;
  readonly employerName: string;
  readonly employerTan: string | null;
  readonly regime: "new" | "old";
  readonly regimeDeclaredOn: string;

  readonly generatedOn: string;
  readonly status: RegisterStatus;
  readonly statusReason: string;

  readonly columns: readonly RegisterColumn[];
  readonly rows: readonly RegisterRow[];

  /**
   * ⚠️ THE PART A FIGURES, UNDER A HEADING THAT SAYS WHAT THEY ARE FOR.
   * Deliberately a SEPARATE table from `rows` so no renderer can print
   * them contiguously and produce something that reads as one certificate.
   */
  readonly partAHeading: string;
  readonly partAColumns: readonly RegisterColumn[];
  readonly partARows: readonly RegisterRow[];

  readonly basis: readonly string[];
  readonly warnings: readonly string[];
  readonly notes: readonly string[];
  readonly digest: string;
}

export interface Form16DocumentRefusal {
  readonly part: "B";
  readonly includesPartA: false;
  readonly title: string;
  readonly reason: string;
  readonly evidence: readonly string[];
  readonly partANotice: string;
  readonly generatedOn: string;
}

export type Form16DocumentOutcome =
  | { readonly generated: true; readonly document: Form16Document }
  | { readonly generated: false; readonly refusal: Form16DocumentRefusal };

/* ------------------------------------------------------------------ */
/* COLUMNS                                                             */
/* ------------------------------------------------------------------ */

const col = (
  id: string,
  label: string,
  from: string,
  align: "left" | "right",
  statutory = true,
): RegisterColumn => ({ id, label, statutory, align, sourcing: { kind: "sourced", from } });

const PART_B_COLUMNS: readonly RegisterColumn[] = [
  col("item", "Particulars", "Form 16 Part B, as notified", "left"),
  col("citation", "Section", "Income-tax Act 1961", "left"),
  col("amount", "Amount (₹)", "Payroll records and declarations on file", "right"),
];

const PART_A_INPUT_COLUMNS: readonly RegisterColumn[] = [
  col("quarter", "Quarter", "Financial-year quarter, Rule 31A", "left"),
  col("period", "Period", "1 April to 31 March", "left"),
  col("deducted", "Deducted per payslips (₹)", "payslips.tds_minor", "right"),
  col("deposited", "Deposited per challans (₹)", "TDS challan allocations", "right"),
  col("short", "Not yet deposited (₹)", "Deducted less deposited", "right"),
  col("challans", "Challan identification", "BSR code and serial", "left"),
];

/* ------------------------------------------------------------------ */
/* BUILD                                                               */
/* ------------------------------------------------------------------ */

export function buildForm16Document(args: {
  readonly outcome: Form16Outcome;
  /** ⚠️ Asia/Kolkata civil date, supplied. Never `new Date()` in here. */
  readonly generatedOn: string;
}): Form16DocumentOutcome {
  if (!args.outcome.issued) {
    const r = args.outcome.refusal;
    return {
      generated: false,
      refusal: {
        part: "B",
        includesPartA: false,
        title: `Form 16 Part B not issued — ${r.employeeName}, FY ${r.financialYear}`,
        reason: r.reason,
        evidence: r.evidence,
        partANotice: PART_A_MUST_COME_FROM_TRACES,
        generatedOn: args.generatedOn,
      },
    };
  }

  const { partB, partAInputs, reconciliation } = args.outcome;
  const rows = partBRows(partB);
  const partARows = partAInputRows(partAInputs);

  const blocking = partB.findings.filter((f) => f.severity === "blocking");

  /**
   * ⭐ THE STATUS IS HONEST OR IT IS WORTHLESS. `final` requires the
   * year's payslips to agree with the annual computation AND nothing
   * blocking outstanding. Everything else prints the word PROVISIONAL at
   * the top with the reason beside it, because a certificate handed to an
   * employee while the deposit is short is a certificate they will act on.
   */
  const status: RegisterStatus =
    blocking.length === 0 && reconciliation.agrees ? "final" : "provisional";

  const statusReason =
    status === "final"
      ? "Every figure is drawn from settled payslips and the year's withholding agrees with the annual computation."
      : blocking.length > 0
        ? blocking.map((f) => f.message).join(" ")
        : `The year's payslips withheld ₹${formatPaise(reconciliation.deductedPerPayslipsMinor)} against an annual computation of ₹${formatPaise(reconciliation.annualTaxPayableMinor)}. Both figures are printed; neither has been adjusted to match the other.`;

  return {
    generated: true,
    document: {
      part: "B",
      includesPartA: false,
      title: `Form 16 Part B — annexure to the certificate under section 203, FY ${partB.financialYear} (AY ${partB.assessmentYear})`,
      partANotice: PART_A_MUST_COME_FROM_TRACES,
      financialYear: partB.financialYear,
      assessmentYear: partB.assessmentYear,
      employeeName: partB.employee.name,
      employeePan: partB.employee.pan ?? "",
      employerName: partB.employer.name,
      employerTan: partB.employer.tan,
      regime: partB.election.regime,
      regimeDeclaredOn: partB.election.declaredOn,
      generatedOn: args.generatedOn,
      status,
      statusReason,
      columns: PART_B_COLUMNS,
      rows,
      partAHeading:
        "Inputs for reconciling against Part A — NOT Part A, and not a certificate",
      partAColumns: PART_A_INPUT_COLUMNS,
      partARows,
      basis: basisOf(partB, partAInputs, reconciliation),
      warnings: messagesOf(partB.findings, ["blocking", "warning"]),
      notes: messagesOf(partB.findings, ["note"]),
      digest: digestOf({
        kind: "form16_part_b",
        formNumber: "Form 16 Part B",
        ruleSetId: `${partB.election.regime}:${partB.financialYear}`,
        periodFrom: `${partB.financialYear.slice(0, 4)}-04-01`,
        periodTo: `${Number(partB.financialYear.slice(0, 4)) + 1}-03-31`,
        columns: PART_B_COLUMNS,
        rows,
      }),
    },
  };
}

/* ------------------------------------------------------------------ */
/* ROWS                                                                */
/* ------------------------------------------------------------------ */

function cells(item: string, citation: string | null, amount: bigint | null): Record<string, RegisterCell> {
  return {
    item,
    citation,
    amount: amount === null ? null : formatPaise(amount),
  };
}

function fromLine(prefix: string, l: Form16Line): RegisterRow {
  /**
   * 🔴 A DISALLOWED LINE IS PRINTED AT NIL WITH ITS REASON, NEVER OMITTED.
   * An employee who declared ₹1,50,000 of 80C and sees no 80C line assumes
   * the declaration was lost. Seeing it at nil with "not available under
   * the new regime" beside it tells them the thing they actually need to
   * know, which is that their election cost them the deduction.
   */
  return {
    key: `${prefix}:${l.id}`,
    cells: {
      item: l.note === null ? l.label : `${l.label} — ${l.note}`,
      citation: l.citation,
      amount: formatPaise(l.amountMinor),
    },
  };
}

function total(key: string, label: string, amount: bigint): RegisterRow {
  return { key, cells: cells(label, null, amount) };
}

function partBRows(b: Form16PartB): readonly RegisterRow[] {
  const rows: RegisterRow[] = [];
  for (const l of b.salaryLines) rows.push(fromLine("salary", l));
  rows.push(total("t:gross", "Gross salary", b.grossSalaryMinor));

  for (const l of b.exemptionLines) rows.push(fromLine("s10", l));
  rows.push(total("t:exempt", "Total exemption under section 10", b.exemptSalaryMinor));
  rows.push(total("t:after10", "Salary after section 10 exemptions", b.salaryAfterExemptionsMinor));

  for (const l of b.section16Lines) rows.push(fromLine("s16", l));
  rows.push(total("t:s16", "Total deduction under section 16", b.section16TotalMinor));
  rows.push(
    total("t:salaries", "Income chargeable under the head Salaries", b.incomeChargeableUnderSalariesMinor),
  );

  /**
   * ⚠️ REPORTED, NOT DISCOVERED. s.192(2B) lets an employee report other
   * income to the employer for withholding. The employer certifies only
   * what was reported to them, and this row says so in its own label.
   */
  rows.push(
    total(
      "t:other",
      "Other income reported by the employee under section 192(2B)",
      b.otherIncomeReportedMinor,
    ),
  );
  rows.push(total("t:gti", "Gross total income", b.grossTotalIncomeMinor));

  for (const l of b.chapterViALines) rows.push(fromLine("via", l));
  rows.push(total("t:via", "Aggregate deductible under Chapter VI-A", b.chapterViATotalMinor));

  rows.push({
    key: "t:ti",
    cells: cells(
      "Total income, rounded to the nearest ten rupees",
      "s.288A",
      b.totalIncomeMinor,
    ),
  });
  rows.push(total("t:tax", "Tax on total income", b.taxOnTotalIncomeMinor));
  rows.push({ key: "t:87a", cells: cells("Rebate", "s.87A", b.rebate87aMinor) });
  rows.push(total("t:afterrebate", "Tax after rebate", b.taxAfterRebateMinor));
  rows.push(total("t:cess", "Health and education cess", b.cessMinor));
  rows.push({
    key: "t:payable",
    cells: cells("Tax payable, rounded to the nearest ten rupees", "s.288B", b.taxPayableMinor),
  });

  /**
   * 🔴 THE TWO ROWS THAT MUST NEVER BE COLLAPSED INTO ONE. The first is
   * what the payslips withheld; the second is the gap against the
   * computation above. A certificate showing only the computed figure in
   * the "deducted" box hides an under-withholding that Form 26AS will
   * show anyway, six months later, to the employee.
   */
  rows.push({
    key: "t:deducted",
    cells: cells(
      "Tax deducted at source per the year's payslips",
      "s.192",
      b.taxDeductedPerPayslipsMinor,
    ),
  });
  rows.push({
    key: "t:balance",
    cells: cells(
      b.balanceMinor === 0n
        ? "Difference between tax deducted and tax payable"
        : b.balanceMinor > 0n
          ? "Deducted in excess of the computation above — claimable as a refund on assessment"
          : "Short of the computation above — payable by the employee on assessment; interest under s.201(1A) may apply to the employer",
      null,
      b.balanceMinor,
    ),
  });

  return rows;
}

function partAInputRows(a: Form16PartAInputs): readonly RegisterRow[] {
  const rows: RegisterRow[] = a.quarters.map((q) => ({
    key: `q:${q.quarter}`,
    cells: {
      quarter: q.quarter,
      period: `${q.from} to ${q.to}`,
      deducted: formatPaise(q.deductedMinor),
      deposited: formatPaise(q.depositedMinor),
      short: formatPaise(q.undepositedMinor),
      /**
       * 🔴 `null`, NOT "—" AND NOT "". The register renderer prints "not
       * recorded" in words for a null cell, and the whole point of this
       * table is that a missing challan identification is visible. An
       * empty cell here reads as "none needed".
       */
      challans:
        q.challans.length === 0
          ? null
          : q.challans
              .map(
                (c) =>
                  `${c.bsrCode ?? "BSR not recorded"} / ${c.challanSerial ?? "serial not recorded"} / ${c.depositDate}`,
              )
              .join("; "),
    },
  }));

  rows.push({
    key: "q:total",
    cells: {
      quarter: "Year",
      period: "Total",
      deducted: formatPaise(a.totalDeductedMinor),
      deposited: formatPaise(a.totalDepositedMinor),
      short: formatPaise(a.totalUndepositedMinor),
      challans: null,
    },
  });

  return rows;
}

/* ------------------------------------------------------------------ */
/* BASIS                                                               */
/* ------------------------------------------------------------------ */

function basisOf(
  b: Form16PartB,
  a: Form16PartAInputs,
  r: Form16Reconciliation,
): readonly string[] {
  return [
    `Financial year ${b.financialYear} (assessment year ${b.assessmentYear}), 1 April to 31 March.`,
    `Regime: ${b.election.regime === "old" ? "old" : "new (section 115BAC)"}, elected for this year and declared on ${b.election.declaredOn}${b.election.recordedBy === null ? "" : `, recorded by ${b.election.recordedBy}`}. The election is stored per year; it was not inferred from the employee's current setting.`,
    `${r.payslipCount} payslip${r.payslipCount === 1 ? "" : "s"} across ${r.monthsWithPayslip} month${r.monthsWithPayslip === 1 ? "" : "s"} of the year, of which ${r.projectionCount} carried a projected tax figure and ${r.overriddenCount} an accountant's override.`,
    `Tax deducted is the sum of what those payslips actually withheld: ₹${formatPaise(r.deductedPerPayslipsMinor)}. It is not a recomputation.`,
    `Deposits identified against challans: ₹${formatPaise(a.totalDepositedMinor)} across ${a.quarters.reduce((n, q) => n + q.challans.length, 0)} challan reference${a.quarters.reduce((n, q) => n + q.challans.length, 0) === 1 ? "" : "s"}.`,
    "Slabs, standard deduction, rebate limit and cess rate were read from the effective-dated statutory rate rows in force for this financial year, not from constants in code.",
    PART_A_MUST_COME_FROM_TRACES,
  ];
}

function messagesOf(
  findings: readonly Form16Finding[],
  severities: readonly Form16Finding["severity"][],
): readonly string[] {
  return findings.filter((f) => severities.includes(f.severity)).map((f) => f.message);
}
