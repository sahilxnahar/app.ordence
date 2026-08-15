/**
 * Ordence — ⭐⭐⭐ THE REGISTER BUILDERS: PURE, AND THAT IS THE POINT
 * Version: v1.48.0-alpha · Batch 76
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ NO DATABASE, NO CONTEXT, NO CLOCK
 * ══════════════════════════════════════════════════════════════════════
 * Every function here takes facts and returns a document. `generatedOn`
 * is a parameter rather than a call to `new Date()`, which is what makes
 * the digest testable at all — a builder that reads the clock produces a
 * different document every run and the whole point-in-time mechanism
 * becomes untestable folklore.
 *
 * ⚠️ MONEY ARRIVES AS `bigint | null` AND LEAVES AS `string | null`.
 * The action parses `numeric` strings into bigint at the boundary
 * (`format.ts#paiseFromNumeric`) and a value it cannot parse arrives as
 * `null`, which becomes a named blank rather than a zero. Nothing in
 * this file constructs a `Number` from a money value.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE HABIT THIS FILE IS WRITTEN TO AVOID
 * ══════════════════════════════════════════════════════════════════════
 * `?? 0n` — used once, anywhere in a register, turns "we could not read
 * this" into "the employer deducted nothing". Every coalesce in this
 * file goes to `null`, and the only place a zero appears is where a fold
 * genuinely summed zero rows of a kind that exists.
 */

import { isSettled } from "@/lib/payroll/rate-periods";
import { addDays, inclusiveDayCount, utcDay } from "@/lib/leave/days";
import {
  citationLine,
  formNumberFor,
  multiStateWarning,
  ruleSetById,
  statesRepresented,
  type RegisterKind,
} from "./forms";
import { specFor, type RegisterColumn } from "./spec";
import {
  gapsFrom,
  type RegisterDocument,
  type RegisterOutcome,
  type RegisterRow,
  type RegisterStatus,
} from "./document";
import { digestOf } from "./digest";
import {
  formatCentidays,
  formatIsoDate,
  formatPaise,
  formatPaiseOrBlank,
} from "./format";

/* ================================================================== */
/* THE FACTS EACH BUILDER TAKES                                        */
/* ================================================================== */

export interface EmployeeFact {
  readonly id: string;
  readonly employeeCode: string;
  readonly fullName: string;
  readonly designation: string | null;
  readonly department: string | null;
  readonly workStateCode: string | null;
  readonly joinedOn: string;
  readonly leftOn: string | null;
  readonly pan: string | null;
  readonly uan: string | null;
  readonly esicNumber: string | null;
}

export interface WageLineFact {
  readonly label: string;
  readonly kind: "earning" | "deduction";
  /** The full-month value before attendance. Null when unreadable. */
  readonly fullMonthMinor: bigint | null;
  readonly amountMinor: bigint | null;
}

export interface RunFact {
  readonly id: string;
  readonly runNo: string;
  readonly status: string;
  readonly periodStart: string;
  readonly periodEnd: string;
}

export interface PayslipFact {
  readonly runId: string;
  readonly employeeId: string;
  readonly employeeCode: string;
  readonly employeeName: string;
  readonly daysInMonth: number;
  readonly payableCentidays: number | null;
  readonly lopCentidays: number | null;
  readonly grossMinor: bigint | null;
  readonly employeePfMinor: bigint | null;
  readonly employeeEsiMinor: bigint | null;
  readonly professionalTaxMinor: bigint | null;
  readonly tdsMinor: bigint | null;
  readonly otherDeductionsMinor: bigint | null;
  readonly totalDeductionsMinor: bigint | null;
  readonly netMinor: bigint | null;
  readonly lines: readonly WageLineFact[];
}

export interface AttendanceFact {
  readonly employeeId: string;
  readonly onDate: string;
  readonly status: string;
  readonly lopCentidays: number | null;
}

export interface LeaveLedgerFact {
  readonly employeeId: string;
  readonly leaveTypeId: string;
  readonly leaveTypeCode: string;
  readonly leaveTypeLabel: string;
  readonly kind: string;
  readonly daysDeltaCentidays: number | null;
}

/* ================================================================== */
/* SHARED ASSEMBLY                                                     */
/* ================================================================== */

interface AssembleArgs {
  readonly kind: RegisterKind;
  readonly ruleSetId: string;
  readonly generatedOn: string;
  readonly periodFrom: string | null;
  readonly periodTo: string | null;
  readonly status: RegisterStatus;
  readonly statusReason: string;
  readonly extraColumns?: readonly RegisterColumn[];
  readonly rows: readonly RegisterRow[];
  readonly basis: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * ⭐ ONE ASSEMBLER, SO THE DIGEST, THE CITATION AND THE GAP LIST CANNOT
 * BE PRESENT ON THREE REGISTERS AND FORGOTTEN ON THE FOURTH.
 *
 * ⚠️ THE DIGEST IS COMPUTED HERE, OVER THE FINISHED COLUMNS AND ROWS,
 * and it deliberately does NOT include `generatedOn`. Two prints of the
 * same settled register on different days are the same document and must
 * carry the same digest — if the timestamp were in it, every reprint
 * would look like a change and nobody would ever compare them again.
 */
function assemble(args: AssembleArgs): RegisterDocument {
  const spec = specFor(args.kind);
  const extra = args.extraColumns ?? [];
  const columns = [...spec.columns, ...extra];
  const rules = ruleSetById(args.ruleSetId);
  const formNumber = formNumberFor(args.ruleSetId, args.kind);

  return {
    kind: args.kind,
    title: spec.title,
    formNumber,
    ruleSetId: rules.id,
    ruleSetLabel: rules.label,
    citationLine: citationLine(args.ruleSetId, args.kind),
    formNumberIsEncoded: formNumber !== null && rules.confidence === "commonly-cited",
    periodFrom: args.periodFrom,
    periodTo: args.periodTo,
    generatedOn: args.generatedOn,
    status: args.status,
    statusReason: args.statusReason,
    columns,
    rows: args.rows,
    gaps: gapsFrom(spec, extra),
    basis: args.basis,
    warnings: args.warnings,
    digest: digestOf({
      kind: args.kind,
      formNumber,
      ruleSetId: rules.id,
      periodFrom: args.periodFrom,
      periodTo: args.periodTo,
      columns,
      rows: args.rows,
    }),
  };
}

/**
 * ⚠️ EVERY UNSOURCED COLUMN GETS AN EXPLICIT `null` CELL.
 *
 * 🔴 NOT AN ABSENT KEY. An absent key and a null both render blank
 * today, but they hash differently the moment somebody adds a column,
 * and a renderer that falls back on `?? ""` would print an unsourced
 * column as an ordinary empty string with no marker. Writing the null
 * makes the "not recorded" state a value the whole pipeline carries.
 */
function blanksFor(kind: RegisterKind): Record<string, null> {
  const out: Record<string, null> = {};
  for (const column of specFor(kind).columns) {
    if (column.sourcing.kind === "unsourced") out[column.id] = null;
  }
  return out;
}

/* ================================================================== */
/* ① REGISTER OF EMPLOYEES                                             */
/* ================================================================== */

/**
 * ⭐ ALWAYS A `snapshot`, NEVER `final`, AND THE REASON IS PRINTED.
 *
 * `employees` is a live, mutable table. A designation changes, an exit
 * date is filled in, a UAN is corrected — and the register regenerated
 * afterwards is a different document with the same title. There is no
 * frozen copy to build from, so the only honest status is "this is what
 * the records said on this date", with the digest to compare against a
 * previous print.
 */
export function buildEmployeeRegister(args: {
  readonly employees: readonly EmployeeFact[];
  readonly ruleSetId: string;
  readonly generatedOn: string;
  /** ⚠️ Optional filter, so a multi-State workforce can print one State. */
  readonly stateFilter: string | null;
}): RegisterDocument {
  const kind: RegisterKind = "employee_register";
  const blanks = blanksFor(kind);

  const rows: RegisterRow[] = args.employees.map((e, index) => ({
    key: e.id,
    cells: {
      ...blanks,
      serial: String(index + 1),
      employeeCode: e.employeeCode,
      fullName: e.fullName,
      designation: e.designation,
      department: e.department,
      joinedOn: formatIsoDate(e.joinedOn),
      workState: e.workStateCode,
      uan: e.uan,
      esicNumber: e.esicNumber,
      pan: e.pan,
      /**
       * ⚠️ A NULL EXIT DATE IS "STILL EMPLOYED" AND MUST NOT PRINT AS A
       * NAMED BLANK — the blank marker means "we do not know". Here we
       * do know, so it says so in words.
       */
      leftOn: e.leftOn === null ? "In service" : formatIsoDate(e.leftOn),
    },
  }));

  const states = statesRepresented(args.employees.map((e) => e.workStateCode));
  const warnings: string[] = [];
  const multi = multiStateWarning(states);
  if (multi !== null) warnings.push(multi);

  const missingState = args.employees.filter(
    (e) => (e.workStateCode ?? "").trim().length === 0,
  ).length;
  if (missingState > 0) {
    warnings.push(
      `${missingState} employee${missingState === 1 ? " has" : "s have"} no State of work recorded. ` +
        "That column drives professional tax as well as which establishment's register they belong on.",
    );
  }

  return assemble({
    kind,
    ruleSetId: args.ruleSetId,
    generatedOn: args.generatedOn,
    periodFrom: null,
    periodTo: null,
    status: "snapshot",
    statusReason:
      "Drawn from live employee records, which can be edited at any time. This is what they said on the date above and nothing freezes it. " +
      "Compare the digest against a previous print to see whether anything moved.",
    rows,
    basis: [
      `${args.employees.length} employee record${args.employees.length === 1 ? "" : "s"} as at ${formatIsoDate(args.generatedOn) ?? args.generatedOn}.`,
      args.stateFilter === null
        ? "No State filter applied."
        : `Filtered to employees whose State of work is ${args.stateFilter}.`,
      states.length === 0 ? "No State of work recorded." : `States represented: ${states.join(", ")}.`,
    ],
    warnings,
  });
}

/* ================================================================== */
/* ② WAGE REGISTER                                                     */
/* ================================================================== */

/**
 * 🔴🔴 THE STATUS RULE, WHICH IS THE POINT-IN-TIME DECISION IN CODE.
 *
 * A payslip is written once at compute time and never recomputed, so a
 * wage register over APPROVED or POSTED runs regenerates identically
 * forever — it is `final`. A DRAFT or COMPUTED run's payslips are
 * deleted and rewritten by the next recompute, so a register over one is
 * `provisional`, stamped in those words, naming the runs.
 *
 * ⚠️ A CANCELLED RUN IS EXCLUDED BY THE CALLER, NOT HERE. A cancelled
 * run's payslips still exist and describe wages that were never paid;
 * including them would overstate the wage bill on a statutory document.
 * The action's query is where that filter belongs, and the basis line
 * says it was applied.
 */
export function buildWageRegister(args: {
  readonly runs: readonly RunFact[];
  readonly payslips: readonly PayslipFact[];
  readonly ruleSetId: string;
  readonly generatedOn: string;
  readonly periodFrom: string;
  readonly periodTo: string;
}): RegisterDocument {
  const kind: RegisterKind = "wage_register";
  const blanks = blanksFor(kind);
  const runById = new Map(args.runs.map((r) => [r.id, r]));

  const rows: RegisterRow[] = args.payslips.map((slip, index) => {
    const run = runById.get(slip.runId);

    /**
     * ⭐ "RATE OF WAGES PAYABLE" — the sum of the full-month value of the
     * earning lines, which is what the person is on rather than what
     * they were paid this month.
     *
     * 🔴 IF ANY EARNING LINE'S FULL-MONTH VALUE IS UNREADABLE, THE WHOLE
     * CELL IS BLANK. A partial sum is a smaller wage rate than the real
     * one, printed with no indication that it is partial, on the column
     * a minimum-wages inspection reads first.
     */
    const earnings = slip.lines.filter((l) => l.kind === "earning");
    let rate: bigint | null = 0n;
    for (const line of earnings) {
      if (line.fullMonthMinor === null) {
        rate = null;
        break;
      }
      rate = rate === null ? null : rate + line.fullMonthMinor;
    }
    if (earnings.length === 0) rate = null;

    return {
      key: `${slip.runId}:${slip.employeeId}`,
      cells: {
        ...blanks,
        serial: String(index + 1),
        runNo: run?.runNo ?? null,
        period:
          run === undefined
            ? null
            : `${formatIsoDate(run.periodStart) ?? run.periodStart} to ${formatIsoDate(run.periodEnd) ?? run.periodEnd}`,
        employeeCode: slip.employeeCode,
        employeeName: slip.employeeName,
        daysInMonth: String(slip.daysInMonth),
        payableDays:
          slip.payableCentidays === null ? null : formatCentidays(slip.payableCentidays),
        lopDays: slip.lopCentidays === null ? null : formatCentidays(slip.lopCentidays),
        rateOfWages: formatPaiseOrBlank(rate),
        gross: formatPaiseOrBlank(slip.grossMinor),
        employeePf: formatPaiseOrBlank(slip.employeePfMinor),
        employeeEsi: formatPaiseOrBlank(slip.employeeEsiMinor),
        professionalTax: formatPaiseOrBlank(slip.professionalTaxMinor),
        tds: formatPaiseOrBlank(slip.tdsMinor),
        otherDeductions: formatPaiseOrBlank(slip.otherDeductionsMinor),
        totalDeductions: formatPaiseOrBlank(slip.totalDeductionsMinor),
        net: formatPaiseOrBlank(slip.netMinor),
      },
    };
  });

  const unsettled = args.runs.filter((r) => !isSettled(r.status));
  const status: RegisterStatus = unsettled.length === 0 ? "final" : "provisional";
  const statusReason =
    unsettled.length === 0
      ? "Every run behind this register is approved or posted, so its payslips are frozen. Regenerating it reproduces this document; the digest below is how you check."
      : `PROVISIONAL. ${unsettled.length} run${unsettled.length === 1 ? " is" : "s are"} not yet approved (${unsettled
          .map((r) => `${r.runNo} — ${r.status}`)
          .join("; ")}), so their payslips are deleted and rewritten by the next recompute. Do not produce this as a statutory record until those runs are signed off.`;

  /**
   * ⭐ A TOTAL OF THE NET, IN BIGINT, PURELY SO THE BASIS CAN STATE THE
   * WAGE BILL THIS DOCUMENT COVERS.
   *
   * ⚠️ IT IS OMITTED ENTIRELY IF ANY ROW WAS UNREADABLE. A total that
   * silently excludes three payslips is the most quotable wrong number
   * on the page.
   */
  let netTotal: bigint | null = 0n;
  for (const slip of args.payslips) {
    if (slip.netMinor === null) {
      netTotal = null;
      break;
    }
    netTotal = netTotal === null ? null : netTotal + slip.netMinor;
  }

  const warnings: string[] = [];
  if (rows.some((r) => r.cells.rateOfWages === null)) {
    warnings.push(
      "One or more rows could not state a rate of wages, because the payslip carried no readable earning lines. Those cells are blank, not zero.",
    );
  }
  if (netTotal === null) {
    warnings.push(
      "At least one net-pay figure could not be read, so no total is stated. A total that quietly omits a payslip is worse than none.",
    );
  }

  return assemble({
    kind,
    ruleSetId: args.ruleSetId,
    generatedOn: args.generatedOn,
    periodFrom: args.periodFrom,
    periodTo: args.periodTo,
    status,
    statusReason,
    rows,
    basis: [
      `Wage periods ending between ${formatIsoDate(args.periodFrom) ?? args.periodFrom} and ${formatIsoDate(args.periodTo) ?? args.periodTo}.`,
      args.runs.length === 0
        ? "No payroll runs fall in this window."
        : `Runs: ${args.runs.map((r) => `${r.runNo} (${r.status})`).join(", ")}.`,
      "Cancelled runs are excluded — their payslips describe wages that were never paid.",
      `${args.payslips.length} payslip${args.payslips.length === 1 ? "" : "s"}.`,
      netTotal === null
        ? "Total net wages not stated — see the warning above."
        : `Total net wages: ${formatPaise(netTotal)}.`,
    ],
    warnings,
  });
}

/* ================================================================== */
/* ③ ATTENDANCE REGISTER / MUSTER ROLL                                 */
/* ================================================================== */

/**
 * ⚠️ THE DAY GRID IS CAPPED AT 31 COLUMNS AND THE CAP IS A DESIGN
 * DECISION, NOT A PERFORMANCE ONE.
 *
 * A muster roll is a month. Asked for a year, the honest answer is not
 * 365 unreadable columns — it is the per-employee summary with a line
 * saying the day grid was omitted because the period is not a muster
 * period. Silently rendering 365 columns produces a document nobody can
 * read and an inspector will not accept.
 */
export const MAX_MUSTER_DAYS = 31;

/** ⭐ The marks, kept short because they head a column one character wide. */
const ATTENDANCE_MARKS: Readonly<Record<string, string>> = {
  present: "P",
  on_duty: "OD",
  weekly_off: "WO",
  holiday: "H",
  paid_leave: "PL",
  unpaid_leave: "UL",
  absent: "A",
};

export const ATTENDANCE_MARK_LEGEND: readonly { mark: string; meaning: string }[] = [
  { mark: "P", meaning: "Present" },
  { mark: "OD", meaning: "On duty elsewhere" },
  { mark: "WO", meaning: "Weekly off" },
  { mark: "H", meaning: "Declared holiday" },
  { mark: "PL", meaning: "Paid leave" },
  { mark: "UL", meaning: "Unpaid leave" },
  { mark: "A", meaning: "Absent" },
];

export function buildAttendanceRegister(args: {
  readonly employees: readonly EmployeeFact[];
  readonly attendance: readonly AttendanceFact[];
  readonly ruleSetId: string;
  readonly generatedOn: string;
  readonly periodFrom: string;
  readonly periodTo: string;
}): RegisterDocument {
  const kind: RegisterKind = "attendance_register";
  const blanks = blanksFor(kind);

  const dayCount = inclusiveDayCount(args.periodFrom, args.periodTo);
  const showGrid = dayCount > 0 && dayCount <= MAX_MUSTER_DAYS;

  const days: string[] = [];
  if (showGrid) {
    let cursor = args.periodFrom;
    for (let i = 0; i < dayCount; i += 1) {
      days.push(cursor);
      cursor = addDays(cursor, 1);
    }
  }

  const dayColumns: RegisterColumn[] = days.map((iso) => ({
    id: `d:${iso}`,
    label: iso.slice(8, 10),
    statutory: true,
    align: "left",
    sourcing: { kind: "sourced", from: `staff_attendance on ${iso}` },
  }));

  const byEmployee = new Map<string, AttendanceFact[]>();
  for (const row of args.attendance) {
    const list = byEmployee.get(row.employeeId);
    if (list === undefined) byEmployee.set(row.employeeId, [row]);
    else list.push(row);
  }

  let unrecordedTotal = 0;

  const rows: RegisterRow[] = args.employees.map((employee, index) => {
    const facts = byEmployee.get(employee.id) ?? [];
    const byDate = new Map(facts.map((f) => [f.onDate, f]));

    let present = 0;
    let leave = 0;
    let absent = 0;
    let lopCentidays = 0;
    let lopUnreadable = false;

    for (const fact of facts) {
      if (fact.status === "present" || fact.status === "on_duty") present += 1;
      else if (fact.status === "paid_leave" || fact.status === "unpaid_leave") leave += 1;
      else if (fact.status === "absent") absent += 1;
      if (fact.lopCentidays === null) lopUnreadable = true;
      else lopCentidays += fact.lopCentidays;
    }

    /**
     * 🔴 DAYS WITH NO ENTRY ARE COUNTED AND NAMED.
     *
     * ⚠️ THE MOST DANGEROUS DEFAULT IN ANY ATTENDANCE SYSTEM IS TREATING
     * SILENCE AS PRESENCE. A month nobody marked and a month everybody
     * was present look identical unless somebody counts the gaps, and
     * the first one is a full month's wages paid on no evidence at all.
     *
     * ⭐ IT IS ONLY COUNTED FOR DAYS THE PERSON WAS ACTUALLY ON THE
     * ROLLS. Counting the eleven days before somebody joined as
     * unrecorded absence would make every new joiner look like a
     * compliance failure.
     */
    const onRollsDays = onRollsWithin(employee, args.periodFrom, args.periodTo);
    const recordedOnRolls = facts.filter(
      (f) =>
        f.onDate >= maxIso(args.periodFrom, employee.joinedOn) &&
        (employee.leftOn === null || f.onDate <= employee.leftOn),
    ).length;
    const unrecorded = Math.max(0, onRollsDays - recordedOnRolls);
    unrecordedTotal += unrecorded;

    const dayCells: Record<string, string | null> = {};
    for (const iso of days) {
      const fact = byDate.get(iso);
      dayCells[`d:${iso}`] = fact === undefined ? null : (ATTENDANCE_MARKS[fact.status] ?? "?");
    }

    return {
      key: employee.id,
      cells: {
        ...blanks,
        serial: String(index + 1),
        employeeCode: employee.employeeCode,
        fullName: employee.fullName,
        daysPresent: String(present),
        daysLeave: String(leave),
        daysAbsent: String(absent),
        daysUnrecorded: String(unrecorded),
        lopDays: lopUnreadable ? null : formatCentidays(lopCentidays),
        ...dayCells,
      },
    };
  });

  const warnings: string[] = [];
  if (!showGrid) {
    warnings.push(
      `The day-by-day grid is omitted: this period is ${dayCount} days and a muster roll is a month. ` +
        `Ask for ${MAX_MUSTER_DAYS} days or fewer to get the grid; the per-employee counts above are for the whole period either way.`,
    );
  }
  if (unrecordedTotal > 0) {
    warnings.push(
      `${unrecordedTotal} employee-day${unrecordedTotal === 1 ? " has" : "s have"} no attendance entry at all while the person was on the rolls. ` +
        "Those cells are blank, not present. A muster roll with gaps is a muster roll with gaps, and payroll for those days rested on nothing recorded here.",
    );
  }
  const multi = multiStateWarning(statesRepresented(args.employees.map((e) => e.workStateCode)));
  if (multi !== null) warnings.push(multi);

  return assemble({
    kind,
    ruleSetId: args.ruleSetId,
    generatedOn: args.generatedOn,
    periodFrom: args.periodFrom,
    periodTo: args.periodTo,
    /**
     * ⚠️ `provisional`, ALWAYS, AND NOT BECAUSE OF THE GAPS.
     * `staff_attendance` is editable — that is the whole point of
     * regularising an absence after the fact — so a muster roll printed
     * today can honestly differ from one printed next week. Marking it
     * `final` would promise a freeze that the table does not have.
     */
    status: "provisional",
    statusReason:
      "Attendance rows remain editable — regularising an absence after the fact is ordinary and correct — so this document can legitimately differ from one printed later. " +
      "The digest below is what tells you whether it has.",
    extraColumns: dayColumns,
    rows,
    basis: [
      `${formatIsoDate(args.periodFrom) ?? args.periodFrom} to ${formatIsoDate(args.periodTo) ?? args.periodTo} (${dayCount} day${dayCount === 1 ? "" : "s"}).`,
      `${args.employees.length} employee${args.employees.length === 1 ? "" : "s"} on the rolls at some point in the period.`,
      `${args.attendance.length} attendance row${args.attendance.length === 1 ? "" : "s"}.`,
      showGrid ? "Day grid rendered." : "Day grid omitted — period longer than a muster period.",
    ],
    warnings,
  });
}

/** Inclusive days the person was on the rolls inside the window. */
function onRollsWithin(employee: EmployeeFact, from: string, to: string): number {
  const start = maxIso(from, employee.joinedOn);
  const end = employee.leftOn === null ? to : minIso(to, employee.leftOn);
  if (utcDay(start) === null || utcDay(end) === null) return 0;
  if (start > end) return 0;
  return inclusiveDayCount(start, end);
}

const maxIso = (a: string, b: string) => (a > b ? a : b);
const minIso = (a: string, b: string) => (a < b ? a : b);

/* ================================================================== */
/* ④ REGISTER OF LEAVE WITH WAGES                                      */
/* ================================================================== */

/**
 * 🔴 THE KINDS THAT MOVE A BALANCE, AND THE TWO THAT DO NOT.
 *
 * `commitment` and `commitment_release` are reservations written when an
 * application is approved. They never move what the employee has earned.
 * Folding them into this register would report leave as taken that
 * nobody has taken, on a document an employee can dispute.
 */
const BALANCE_KINDS = new Set([
  "opening_balance",
  "carry_forward_in",
  "accrual",
  "taken",
  "encashed",
  "lapse",
  "adjustment",
]);

export function buildLeaveRegister(args: {
  readonly employees: readonly EmployeeFact[];
  readonly ledger: readonly LeaveLedgerFact[];
  readonly ruleSetId: string;
  readonly generatedOn: string;
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly periodLabel: string | null;
}): RegisterDocument {
  const kind: RegisterKind = "leave_with_wages_register";
  const blanks = blanksFor(kind);
  const employeeById = new Map(args.employees.map((e) => [e.id, e]));

  interface Fold {
    opening: number;
    earned: number;
    taken: number;
    encashed: number;
    lapsed: number;
    adjusted: number;
    unreadable: boolean;
    code: string;
    label: string;
    employeeId: string;
    leaveTypeId: string;
  }

  const folds = new Map<string, Fold>();
  let ignoredCommitments = 0;

  for (const entry of args.ledger) {
    if (!BALANCE_KINDS.has(entry.kind)) {
      ignoredCommitments += 1;
      continue;
    }
    const key = `${entry.employeeId}:${entry.leaveTypeId}`;
    let fold = folds.get(key);
    if (fold === undefined) {
      fold = {
        opening: 0,
        earned: 0,
        taken: 0,
        encashed: 0,
        lapsed: 0,
        adjusted: 0,
        unreadable: false,
        code: entry.leaveTypeCode,
        label: entry.leaveTypeLabel,
        employeeId: entry.employeeId,
        leaveTypeId: entry.leaveTypeId,
      };
      folds.set(key, fold);
    }
    const delta = entry.daysDeltaCentidays;
    if (delta === null) {
      fold.unreadable = true;
      continue;
    }
    if (entry.kind === "opening_balance" || entry.kind === "carry_forward_in") fold.opening += delta;
    else if (entry.kind === "accrual") fold.earned += delta;
    else if (entry.kind === "taken") fold.taken += delta;
    else if (entry.kind === "encashed") fold.encashed += delta;
    else if (entry.kind === "lapse") fold.lapsed += delta;
    else fold.adjusted += delta;
  }

  const ordered = [...folds.values()].sort((a, b) => {
    const nameA = employeeById.get(a.employeeId)?.fullName ?? "";
    const nameB = employeeById.get(b.employeeId)?.fullName ?? "";
    return nameA === nameB ? a.code.localeCompare(b.code) : nameA.localeCompare(nameB);
  });

  const rows: RegisterRow[] = ordered.map((fold, index) => {
    const employee = employeeById.get(fold.employeeId);
    /**
     * ⭐ CLOSING IS A FOLD OF THE SIGNED ENTRIES, NOT A STORED NUMBER.
     * `taken`, `encashed` and `lapse` are already negative in the ledger
     * — the schema has a CHECK that enforces it — so the closing balance
     * is a plain sum and the displayed columns take the magnitude.
     */
    const closing =
      fold.opening + fold.earned + fold.taken + fold.encashed + fold.lapsed + fold.adjusted;
    const blank = fold.unreadable;

    return {
      key: `${fold.employeeId}:${fold.leaveTypeId}`,
      cells: {
        ...blanks,
        serial: String(index + 1),
        employeeCode: employee?.employeeCode ?? null,
        fullName: employee?.fullName ?? null,
        joinedOn: employee === undefined ? null : formatIsoDate(employee.joinedOn),
        leaveType: `${fold.code} — ${fold.label}`,
        openingDays: blank ? null : formatCentidays(fold.opening),
        earnedDays: blank ? null : formatCentidays(fold.earned),
        takenDays: blank ? null : formatCentidays(-fold.taken),
        encashedDays: blank ? null : formatCentidays(-fold.encashed),
        lapsedDays: blank ? null : formatCentidays(-fold.lapsed),
        adjustedDays: blank ? null : formatCentidays(fold.adjusted),
        closingDays: blank ? null : formatCentidays(closing),
      },
    };
  });

  const warnings: string[] = [];
  if (rows.some((r) => r.cells.closingDays === null)) {
    warnings.push(
      "At least one leave balance could not be folded because a ledger entry was unreadable. Those rows are blank rather than partial.",
    );
  }
  const withoutLedger = args.employees.filter(
    (e) => ![...folds.values()].some((f) => f.employeeId === e.id),
  ).length;
  if (withoutLedger > 0) {
    warnings.push(
      `${withoutLedger} employee${withoutLedger === 1 ? " has" : "s have"} no leave ledger entry in this period and therefore no row here. ` +
        "That is an absence of records, not an entitlement of zero — a register that invented a nil row for them would say the opposite.",
    );
  }

  return assemble({
    kind,
    ruleSetId: args.ruleSetId,
    generatedOn: args.generatedOn,
    periodFrom: args.periodFrom,
    periodTo: args.periodTo,
    /**
     * ⚠️ `provisional` FOR THE SAME REASON AS THE MUSTER ROLL: the
     * ledger is append-only, so a later adjustment cannot rewrite
     * history — but it CAN be added, and a register printed afterwards
     * legitimately shows a different balance.
     */
    status: "provisional",
    statusReason:
      "The leave ledger is append-only, so nothing already in this document can be rewritten — but an adjustment or a late accrual can be appended, and a register printed afterwards will differ. Compare the digest.",
    rows,
    basis: [
      args.periodLabel === null
        ? `Leave year ${formatIsoDate(args.periodFrom) ?? args.periodFrom} to ${formatIsoDate(args.periodTo) ?? args.periodTo}.`
        : `Leave year ${args.periodLabel} (${formatIsoDate(args.periodFrom) ?? args.periodFrom} to ${formatIsoDate(args.periodTo) ?? args.periodTo}).`,
      `${args.ledger.length} ledger entr${args.ledger.length === 1 ? "y" : "ies"} read, of which ${ignoredCommitments} ${ignoredCommitments === 1 ? "is a commitment or release and is" : "are commitments or releases and are"} excluded — a reservation is not leave taken.`,
      `${rows.length} employee-and-leave-type combination${rows.length === 1 ? "" : "s"}.`,
    ],
    warnings,
  });
}

/* ================================================================== */
/* ⑤ REGISTER OF LOANS AND ADVANCES — THE REFUSAL                      */
/* ================================================================== */

/**
 * 🔴🔴 THIS RETURNS A REFUSAL AND NEVER A DOCUMENT.
 *
 * See the block comment on `LOANS_REGISTER` in `spec.ts` for why. What
 * this function adds is EVIDENCE: it counts the payslips carrying a
 * non-statutory deduction and totals them, so the refusal can say how
 * much money is flowing through the bucket it cannot attribute. An
 * employer with ₹0 of other deductions has nothing to maintain; an
 * employer with ₹1.4 lakh of them has a register to keep and does not
 * know it.
 */
export function refuseLoansRegister(args: {
  readonly payslips: readonly PayslipFact[];
  readonly generatedOn: string;
  readonly periodFrom: string;
  readonly periodTo: string;
}): RegisterOutcome {
  const spec = specFor("loans_and_advances_register");

  const withDeduction = args.payslips.filter(
    (s) => s.otherDeductionsMinor !== null && s.otherDeductionsMinor > 0n,
  );
  let total = 0n;
  let unreadable = 0;
  for (const slip of args.payslips) {
    if (slip.otherDeductionsMinor === null) unreadable += 1;
    else total += slip.otherDeductionsMinor;
  }

  const labels = new Set<string>();
  for (const slip of args.payslips) {
    for (const line of slip.lines) {
      if (line.kind === "deduction") labels.add(line.label);
    }
  }

  const evidence: string[] = [
    `${formatIsoDate(args.periodFrom) ?? args.periodFrom} to ${formatIsoDate(args.periodTo) ?? args.periodTo}.`,
    withDeduction.length === 0
      ? "No payslip in this window carries a non-statutory deduction."
      : `${withDeduction.length} payslip${withDeduction.length === 1 ? "" : "s"} carr${withDeduction.length === 1 ? "ies" : "y"} a non-statutory deduction, totalling ${formatPaise(total)} — which may be advance instalments, canteen, uniform or damage recovery, in unknown proportions.`,
    labels.size === 0
      ? "No deduction components are named on these payslips."
      : `Deduction components seen: ${[...labels].sort().join(", ")}. A label is not a loan record — it carries no principal, no date of grant and no outstanding balance.`,
  ];
  if (unreadable > 0) {
    evidence.push(
      `${unreadable} payslip${unreadable === 1 ? "'s" : "s'"} other-deduction figure could not be read and is excluded from the total above.`,
    );
  }

  return {
    generated: false,
    refusal: {
      kind: "loans_and_advances_register",
      title: spec.title,
      reason: spec.refusal ?? "Not generated.",
      gaps: gapsFrom(spec),
      evidence,
      generatedOn: args.generatedOn,
    },
  };
}
