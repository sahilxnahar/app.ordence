/**
 * Ordence — ⭐⭐⭐ BATCH 76: THE STATUTORY REGISTERS PACK
 * Version: v1.48.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE FIVE THINGS THAT MUST NOT BE QUIETLY REVERSED
 * ══════════════════════════════════════════════════════════════════════
 *   ① A REGISTER NEVER INVENTS A COLUMN. An unsourced statutory column
 *      is a `null` cell in every row, and a `null` cell renders as words
 *      rather than as a zero, a dash or an empty string. This is the
 *      whole batch, and it is the thing a later "let's just show 0.00,
 *      it looks cleaner" pull request would undo.
 *   ② THE REGISTER OF LOANS AND ADVANCES REFUSES. There is no builder
 *      for it, and its spec carries a refusal.
 *   ③ FORM NUMBERING IS DATA AND THE DEFAULT IS SILENCE. No State code
 *      appears in control flow anywhere in the module.
 *   ④ A REGISTER IS A POINT-IN-TIME DOCUMENT. The digest covers the
 *      content and excludes the clock; an unsettled run cannot produce a
 *      `final` document.
 *   ⑤ MONEY STAYS IN BIGINT. No `Number(...)` on a minor-unit value
 *      anywhere in the module, and Indian grouping on the way out.
 *
 * ⚠️ THE ABSENCE ASSERTIONS READ COMMENT-STRIPPED SOURCE. Every file in
 * this module argues at length about the things it does NOT do — "never
 * a zero", "no `Number()` on a money value" — so a naive `toContain`
 * search would match the argument and pass, or fail, for entirely the
 * wrong reason. `codeOnly` is the same helper `tests/ui/leave.test.ts`
 * uses.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_RULE_SET_ID,
  REGISTER_KINDS,
  RULE_SETS,
  citationLine,
  formNumberFor,
  isRegisterKind,
  multiStateWarning,
  ruleSetById,
  statesRepresented,
} from "@/lib/registers/forms";
import { REGISTER_SPECS, specFor, unsourcedColumns } from "@/lib/registers/spec";
import {
  centidaysFromNumeric,
  formatCentidays,
  formatIsoDate,
  formatPaise,
  formatPaiseOrBlank,
  paiseFromNumeric,
} from "@/lib/registers/format";
import { canonicalise, digestOf } from "@/lib/registers/digest";
import {
  MAX_MUSTER_DAYS,
  buildAttendanceRegister,
  buildEmployeeRegister,
  buildLeaveRegister,
  buildWageRegister,
  refuseLoansRegister,
  type AttendanceFact,
  type EmployeeFact,
  type LeaveLedgerFact,
  type PayslipFact,
  type RunFact,
} from "@/lib/registers/build";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const codeOnly = (s: string) =>
  s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));

const BUILD = read("lib/registers/build.ts");
const FORMS = read("lib/registers/forms.ts");
const FORMAT = read("lib/registers/format.ts");
const DIGEST = read("lib/registers/digest.ts");
const SPEC = read("lib/registers/spec.ts");
const ACTIONS = read("server/actions/registers.ts");
const VIEW = read("components/registers/register-view.tsx");
const PAGE = read("app/(crm)/payroll/registers/page.tsx");

const MODULE_SOURCES = [BUILD, FORMS, FORMAT, DIGEST, SPEC, ACTIONS];

/* ------------------------------------------------------------------ */
/* FIXTURES                                                            */
/* ------------------------------------------------------------------ */

const RAVI: EmployeeFact = {
  id: "11111111-1111-4111-8111-111111111111",
  employeeCode: "E-001",
  fullName: "Ravi Kumar",
  designation: "Fitter",
  department: "Plant",
  workStateCode: "KA",
  joinedOn: "2025-04-01",
  leftOn: null,
  pan: "ABCDE1234F",
  uan: "100200300400",
  esicNumber: "3100123456789012",
};

const MEENA: EmployeeFact = {
  id: "22222222-2222-4222-8222-222222222222",
  employeeCode: "E-002",
  fullName: "Meena Iyer",
  designation: "Supervisor",
  department: "Plant",
  workStateCode: "MH",
  /** ⚠️ Joins ten days into the muster period. See the unrecorded-day test. */
  joinedOn: "2026-04-11",
  leftOn: null,
  pan: null,
  uan: null,
  esicNumber: null,
};

const APPROVED_RUN: RunFact = {
  id: "aaaaaaaa-0000-4000-8000-000000000001",
  runNo: "PR-2026-04",
  status: "approved",
  periodStart: "2026-04-01",
  periodEnd: "2026-04-30",
};

const DRAFT_RUN: RunFact = {
  id: "aaaaaaaa-0000-4000-8000-000000000002",
  runNo: "PR-2026-05",
  status: "computed",
  periodStart: "2026-05-01",
  periodEnd: "2026-05-31",
};

function slip(overrides: Partial<PayslipFact> = {}): PayslipFact {
  return {
    runId: APPROVED_RUN.id,
    employeeId: RAVI.id,
    employeeCode: RAVI.employeeCode,
    employeeName: RAVI.fullName,
    daysInMonth: 30,
    payableCentidays: 3000,
    lopCentidays: 0,
    grossMinor: 4_500_000n,
    employeePfMinor: 180_000n,
    employeeEsiMinor: 33_800n,
    professionalTaxMinor: 20_000n,
    tdsMinor: 0n,
    otherDeductionsMinor: 0n,
    totalDeductionsMinor: 233_800n,
    netMinor: 4_266_200n,
    lines: [
      {
        label: "Basic",
        kind: "earning",
        fullMonthMinor: 3_000_000n,
        amountMinor: 3_000_000n,
      },
      { label: "HRA", kind: "earning", fullMonthMinor: 1_500_000n, amountMinor: 1_500_000n },
    ],
    ...overrides,
  };
}

const GENERATED_ON = "2026-08-15";

/* ================================================================== */
/* ① A REGISTER NEVER INVENTS A COLUMN                                 */
/* ================================================================== */

describe("① an unsourced statutory column is blank-and-named, never a zero", () => {
  /**
   * 🔴 THE ASSERTION THE WHOLE BATCH EXISTS FOR.
   *
   * Every column whose spec says `unsourced` must produce `null` in
   * EVERY row of EVERY register that declares it. Not "", not "0", not
   * "-". `null` is the only value the renderer turns into the words
   * "not recorded", and it is the only one that survives the digest as
   * distinct from an empty string.
   */
  it("every unsourced column is null in every row of every generated register", () => {
    const documents = [
      buildEmployeeRegister({
        employees: [RAVI, MEENA],
        ruleSetId: DEFAULT_RULE_SET_ID,
        generatedOn: GENERATED_ON,
        stateFilter: null,
      }),
      buildWageRegister({
        runs: [APPROVED_RUN],
        payslips: [slip()],
        ruleSetId: DEFAULT_RULE_SET_ID,
        generatedOn: GENERATED_ON,
        periodFrom: "2026-04-01",
        periodTo: "2026-04-30",
      }),
      buildAttendanceRegister({
        employees: [RAVI],
        attendance: [],
        ruleSetId: DEFAULT_RULE_SET_ID,
        generatedOn: GENERATED_ON,
        periodFrom: "2026-04-01",
        periodTo: "2026-04-30",
      }),
      buildLeaveRegister({
        employees: [RAVI],
        ledger: [],
        ruleSetId: DEFAULT_RULE_SET_ID,
        generatedOn: GENERATED_ON,
        periodFrom: "2025-04-01",
        periodTo: "2026-03-31",
        periodLabel: null,
      }),
    ];

    for (const document of documents) {
      const blanks = document.columns.filter((c) => c.sourcing.kind === "unsourced");
      expect(blanks.length).toBeGreaterThan(0);
      for (const row of document.rows) {
        for (const column of blanks) {
          expect(row.cells[column.id]).toBeNull();
        }
      }
    }
  });

  /** ⚠️ And the gap list names every one of them, with a reason. */
  it("every unsourced column appears in the document's gap list with a why", () => {
    const document = buildEmployeeRegister({
      employees: [RAVI],
      ruleSetId: DEFAULT_RULE_SET_ID,
      generatedOn: GENERATED_ON,
      stateFilter: null,
    });
    const blanks = document.columns.filter((c) => c.sourcing.kind === "unsourced");
    expect(document.gaps).toHaveLength(blanks.length);
    for (const gap of document.gaps) {
      expect(gap.why.length).toBeGreaterThan(20);
    }
  });

  /**
   * ⭐ A CEILING, NOT A COUNT. The number of unsourced columns on the
   * employee register can only ever go DOWN as the schema learns to hold
   * a date of birth and an address. Pinning it exactly would make every
   * improvement a test failure, which is how a test teaches people not
   * to improve things.
   */
  it("the employee register has no more unsourced columns than it does today", () => {
    expect(unsourcedColumns(specFor("employee_register")).length).toBeLessThanOrEqual(8);
    expect(unsourcedColumns(specFor("wage_register")).length).toBeLessThanOrEqual(4);
  });

  /**
   * 🔴 THE COALESCE THAT WOULD UNDO ALL OF IT.
   *
   * `?? 0n` or `?? "0"` on a money path turns "we could not read this"
   * into "the employer deducted nothing". It is a two-character change
   * that makes the tests above pass and the documents wrong.
   */
  it("no builder coalesces a missing money or day value to zero", () => {
    const code = codeOnly(BUILD);
    expect(code).not.toMatch(/\?\?\s*0n/);
    expect(code).not.toMatch(/\?\?\s*"0/);
    expect(code).not.toMatch(/\|\|\s*0n/);
    expect(codeOnly(FORMAT)).not.toMatch(/\?\?\s*0n/);
  });

  /**
   * ⚠️ AND THE RENDERER MUST NOT COLLAPSE IT EITHER. A `?? ""` in the
   * cell renderer would print every unsourced column as an ordinary
   * empty cell — the exact thing an inspector reads as nil.
   */
  it("the renderer prints words for a null cell, not an empty string", () => {
    const code = codeOnly(VIEW);
    expect(code).toContain("not recorded");
    expect(code).toMatch(/value\s*===\s*null/);
    expect(code).not.toMatch(/row\.cells\[column\.id\]\s*\?\?\s*""/);
  });
});

/* ================================================================== */
/* ② THE REGISTER OF LOANS AND ADVANCES REFUSES                        */
/* ================================================================== */

describe("② the register with no data behind it is not generated at all", () => {
  it("its spec carries a refusal and every one of its columns is unsourced", () => {
    const spec = specFor("loans_and_advances_register");
    expect(spec.refusal).not.toBeNull();
    expect(spec.refusal!.length).toBeGreaterThan(100);
    expect(spec.columns.every((c) => c.sourcing.kind === "unsourced")).toBe(true);
  });

  it("the builder returns a refusal, never a document", () => {
    const outcome = refuseLoansRegister({
      payslips: [slip({ otherDeductionsMinor: 250_000n })],
      generatedOn: GENERATED_ON,
      periodFrom: "2026-04-01",
      periodTo: "2026-04-30",
    });
    expect(outcome.generated).toBe(false);
    if (outcome.generated) throw new Error("unreachable");
    expect(outcome.refusal.gaps.length).toBe(
      specFor("loans_and_advances_register").columns.length,
    );
  });

  /**
   * ⭐ THE REFUSAL CARRIES EVIDENCE. "We cannot produce this" is weaker
   * than "we cannot produce this, and ₹2,500.00 of unattributable
   * deductions went through last month". The second tells the employer
   * they have a register to keep.
   */
  it("the refusal states how much unattributable deduction it can see", () => {
    const outcome = refuseLoansRegister({
      payslips: [slip({ otherDeductionsMinor: 250_000n })],
      generatedOn: GENERATED_ON,
      periodFrom: "2026-04-01",
      periodTo: "2026-04-30",
    });
    if (outcome.generated) throw new Error("unreachable");
    expect(outcome.refusal.evidence.join(" ")).toContain("2,500.00");
  });

  /** 🔴 There must be no way to talk it into producing a document. */
  it("no builder for a loans register exists", () => {
    expect(codeOnly(BUILD)).not.toMatch(/export function buildLoans/);
  });
});

/* ================================================================== */
/* ③ FORM NUMBERING IS DATA, AND THE DEFAULT SAYS NOTHING              */
/* ================================================================== */

describe("③ no State's numbering is hardcoded as though it were national", () => {
  it("the default rule set prints no form number for any register", () => {
    expect(ruleSetById(DEFAULT_RULE_SET_ID).id).toBe(DEFAULT_RULE_SET_ID);
    for (const kind of REGISTER_KINDS) {
      expect(formNumberFor(DEFAULT_RULE_SET_ID, kind)).toBeNull();
    }
  });

  /** ⚠️ And the sentence asks for the number rather than hiding the gap. */
  it("a missing form number produces a sentence, not an empty heading", () => {
    const line = citationLine(DEFAULT_RULE_SET_ID, "wage_register");
    expect(line).toContain("Form number not stated");
    expect(line.length).toBeGreaterThan(60);
  });

  it("only a rule set that says it is commonly cited carries form numbers", () => {
    for (const rules of RULE_SETS) {
      if (Object.keys(rules.forms).length > 0) {
        expect(rules.confidence).toBe("commonly-cited");
      }
    }
  });

  /**
   * 🔴 THE SHAPE IS DATA, NOT CONTROL FLOW. A `if (state === "KA")`
   * anywhere in this module is the beginning of a per-State fork that
   * nobody can audit and that silently mislabels every State somebody
   * forgot.
   */
  it("no State code appears in control flow anywhere in the module", () => {
    for (const source of MODULE_SOURCES) {
      const code = codeOnly(source);
      expect(code).not.toMatch(/===\s*"(KA|MH|TN|DL|GJ|UP|WB|TS|AP|KL|RJ|HR|PB|MP)"/);
      expect(code).not.toMatch(/switch\s*\(\s*\w*[Ss]tate/);
    }
  });

  it("a workforce spanning two States is warned about on the document", () => {
    const states = statesRepresented(["KA", "mh", " ", "KA", null]);
    expect(states).toEqual(["KA", "MH"]);
    expect(multiStateWarning(states)).not.toBeNull();
    expect(multiStateWarning(["KA"])).toBeNull();

    const document = buildEmployeeRegister({
      employees: [RAVI, MEENA],
      ruleSetId: DEFAULT_RULE_SET_ID,
      generatedOn: GENERATED_ON,
      stateFilter: null,
    });
    expect(document.warnings.some((w) => w.includes("2 States"))).toBe(true);
  });

  it("every register kind is a known kind and nothing else is", () => {
    for (const kind of REGISTER_KINDS) expect(isRegisterKind(kind)).toBe(true);
    expect(isRegisterKind("form_a")).toBe(false);
    expect(isRegisterKind(undefined)).toBe(false);
    expect(Object.keys(REGISTER_SPECS).sort()).toEqual([...REGISTER_KINDS].sort());
  });
});

/* ================================================================== */
/* ④ A REGISTER IS A POINT-IN-TIME DOCUMENT                            */
/* ================================================================== */

describe("④ regenerating a register cannot silently produce a different document", () => {
  const wage = (runs: readonly RunFact[], slips: readonly PayslipFact[], on = GENERATED_ON) =>
    buildWageRegister({
      runs,
      payslips: slips,
      ruleSetId: DEFAULT_RULE_SET_ID,
      generatedOn: on,
      periodFrom: "2026-04-01",
      periodTo: "2026-04-30",
    });

  /**
   * ⭐ THE DIGEST EXCLUDES THE CLOCK, DELIBERATELY. If the generation
   * date were in it, every reprint of an unchanged register would carry
   * a different digest, everybody would learn that the digest changes
   * for no reason, and it would stop being read at exactly the moment it
   * mattered.
   */
  it("reprinting an unchanged register on another day reproduces the digest", () => {
    expect(wage([APPROVED_RUN], [slip()], "2026-08-15").digest).toBe(
      wage([APPROVED_RUN], [slip()], "2027-01-02").digest,
    );
  });

  it("one changed figure changes the digest", () => {
    const before = wage([APPROVED_RUN], [slip()]);
    const after = wage([APPROVED_RUN], [slip({ netMinor: 4_266_201n })]);
    expect(after.digest).not.toBe(before.digest);
  });

  /** ⚠️ Two employees on identical pay must not collide. */
  it("the row key is part of the digest, so identical figures do not collide", () => {
    const a = wage([APPROVED_RUN], [slip()]);
    const b = wage(
      [APPROVED_RUN],
      [slip({ employeeId: MEENA.id, employeeCode: MEENA.employeeCode, employeeName: MEENA.fullName })],
    );
    expect(a.digest).not.toBe(b.digest);
  });

  it("a not-recorded cell hashes differently from an empty one", () => {
    const columns = specFor("wage_register").columns;
    const base = { kind: "wage_register", formNumber: null, ruleSetId: "unstated", periodFrom: null, periodTo: null, columns } as const;
    const withNull = digestOf({ ...base, rows: [{ key: "r", cells: { gross: null } }] });
    const withEmpty = digestOf({ ...base, rows: [{ key: "r", cells: { gross: "" } }] });
    expect(withNull).not.toBe(withEmpty);
  });

  it("the canonical form is column-ordered, so key insertion order cannot change it", () => {
    const columns = specFor("wage_register").columns;
    const args = { kind: "wage_register", formNumber: null, ruleSetId: "unstated", periodFrom: null, periodTo: null, columns } as const;
    const one = canonicalise({
      ...args,
      rows: [{ key: "r", cells: { gross: "10.00", net: "9.00" } }],
    });
    const two = canonicalise({
      ...args,
      rows: [{ key: "r", cells: { net: "9.00", gross: "10.00" } }],
    });
    expect(one).toBe(two);
  });

  /**
   * 🔴 THE STATUS RULE. A payslip is frozen once the run is approved, so
   * a register over settled runs is `final`. A computed-but-unapproved
   * run's payslips are deleted and rewritten by the next recompute, so a
   * register over one is PROVISIONAL and names the run.
   */
  it("a settled run yields a final register and an unsettled one does not", () => {
    expect(wage([APPROVED_RUN], [slip()]).status).toBe("final");

    const provisional = wage([APPROVED_RUN, DRAFT_RUN], [slip()]);
    expect(provisional.status).toBe("provisional");
    expect(provisional.statusReason).toContain("PR-2026-05");
    expect(provisional.statusReason).toContain("PROVISIONAL");
  });

  /**
   * ⚠️ THE EMPLOYEE REGISTER CAN NEVER BE FINAL. It is drawn from a live
   * mutable table and there is no frozen copy to build from. Claiming
   * otherwise would be the most confident wrong statement on the page.
   */
  it("registers drawn from live records are stamped as snapshots", () => {
    const document = buildEmployeeRegister({
      employees: [RAVI],
      ruleSetId: DEFAULT_RULE_SET_ID,
      generatedOn: GENERATED_ON,
      stateFilter: null,
    });
    expect(document.status).toBe("snapshot");
    expect(document.status).not.toBe("final");
  });

  it("the document states exactly what it was built from", () => {
    const document = wage([APPROVED_RUN], [slip()]);
    expect(document.basis.join(" ")).toContain("PR-2026-04");
    expect(document.basis.join(" ")).toContain("Cancelled runs are excluded");
  });
});

/* ================================================================== */
/* ⑤ MONEY NEVER LEAVES BIGINT                                         */
/* ================================================================== */

describe("⑤ money is bigint paise and the display never converts it", () => {
  it("groups the Indian way", () => {
    expect(formatPaise(123_456_789n)).toBe("12,34,567.89");
    expect(formatPaise(0n)).toBe("0.00");
    expect(formatPaise(5n)).toBe("0.05");
    expect(formatPaise(100_000n)).toBe("1,000.00");
    expect(formatPaise(-450_000n)).toBe("-4,500.00");
  });

  it("refuses a numeric it cannot read rather than rounding it", () => {
    expect(paiseFromNumeric("4500000")).toBe(4_500_000n);
    expect(paiseFromNumeric("4500000.00")).toBe(4_500_000n);
    /** 🔴 A fractional paise means the column is not paise. Refuse it. */
    expect(paiseFromNumeric("4500000.50")).toBeNull();
    expect(paiseFromNumeric("nonsense")).toBeNull();
    expect(paiseFromNumeric(null)).toBeNull();
    expect(formatPaiseOrBlank(null)).toBeNull();
  });

  it("days stay in integer hundredths", () => {
    expect(centidaysFromNumeric("26.50")).toBe(2650);
    expect(centidaysFromNumeric("0.5")).toBe(50);
    expect(centidaysFromNumeric(null)).toBeNull();
    expect(formatCentidays(2650)).toBe("26.5");
    expect(formatCentidays(2625)).toBe("26.25");
    expect(formatCentidays(3000)).toBe("30");
  });

  it("formats an ISO date without ever constructing a Date", () => {
    expect(formatIsoDate("2026-03-31")).toBe("31-03-2026");
    expect(formatIsoDate(null)).toBeNull();
    expect(codeOnly(FORMAT)).not.toMatch(/new Date\(/);
  });

  /**
   * 🔴 THE LEAK IS ALWAYS IN THE DISPLAY, NOT THE CALCULATION.
   * `Number(minor) / 100` in a formatter is the whole bug.
   */
  it("no module file calls Number() or parseFloat on anything", () => {
    for (const source of MODULE_SOURCES) {
      const code = codeOnly(source);
      expect(code).not.toMatch(/\bNumber\s*\(/);
      expect(code).not.toMatch(/\bparseFloat\s*\(/);
      expect(code).not.toMatch(/toLocaleString\s*\(/);
    }
  });

  /** ⚠️ And no date is ever derived from a UTC instant. */
  it("no module file derives a civil date from toISOString", () => {
    for (const source of [...MODULE_SOURCES, PAGE]) {
      expect(codeOnly(source)).not.toMatch(/toISOString\s*\(/);
    }
    expect(codeOnly(ACTIONS)).toContain("todayInIndia");
  });

  /**
   * ⭐ A PARTIAL SUM IS WORSE THAN A BLANK ON THE RATE-OF-WAGES COLUMN,
   * which is the first thing a minimum-wages inspection reads.
   */
  it("an unreadable earning line blanks the whole rate of wages, not part of it", () => {
    const document = buildWageRegister({
      runs: [APPROVED_RUN],
      payslips: [
        slip({
          lines: [
            { label: "Basic", kind: "earning", fullMonthMinor: 3_000_000n, amountMinor: null },
            { label: "HRA", kind: "earning", fullMonthMinor: null, amountMinor: null },
          ],
        }),
      ],
      ruleSetId: DEFAULT_RULE_SET_ID,
      generatedOn: GENERATED_ON,
      periodFrom: "2026-04-01",
      periodTo: "2026-04-30",
    });
    expect(document.rows[0]!.cells.rateOfWages).toBeNull();
    expect(document.warnings.join(" ")).toContain("blank, not zero");
  });

  it("a good payslip states the rate of wages and the net", () => {
    const document = buildWageRegister({
      runs: [APPROVED_RUN],
      payslips: [slip()],
      ruleSetId: DEFAULT_RULE_SET_ID,
      generatedOn: GENERATED_ON,
      periodFrom: "2026-04-01",
      periodTo: "2026-04-30",
    });
    expect(document.rows[0]!.cells.rateOfWages).toBe("45,000.00");
    expect(document.rows[0]!.cells.net).toBe("42,662.00");
    expect(document.basis.join(" ")).toContain("42,662.00");
  });

  /** 🔴 One unreadable net means NO total, rather than a quiet short one. */
  it("an unreadable net suppresses the total instead of understating it", () => {
    const document = buildWageRegister({
      runs: [APPROVED_RUN],
      payslips: [slip(), slip({ employeeId: MEENA.id, netMinor: null })],
      ruleSetId: DEFAULT_RULE_SET_ID,
      generatedOn: GENERATED_ON,
      periodFrom: "2026-04-01",
      periodTo: "2026-04-30",
    });
    expect(document.basis.join(" ")).toContain("Total net wages not stated");
    expect(document.rows[1]!.cells.net).toBeNull();
  });
});

/* ================================================================== */
/* ⑥ THE MUSTER ROLL AND ITS SILENCES                                  */
/* ================================================================== */

describe("⑥ a day nobody recorded is never printed as a day somebody worked", () => {
  const attendance = (rows: readonly AttendanceFact[], from = "2026-04-01", to = "2026-04-30") =>
    buildAttendanceRegister({
      employees: [RAVI, MEENA],
      attendance: rows,
      ruleSetId: DEFAULT_RULE_SET_ID,
      generatedOn: GENERATED_ON,
      periodFrom: from,
      periodTo: to,
    });

  it("a day with no entry is a null cell, not a present mark", () => {
    const document = attendance([
      { employeeId: RAVI.id, onDate: "2026-04-01", status: "present", lopCentidays: 0 },
    ]);
    const row = document.rows.find((r) => r.key === RAVI.id)!;
    expect(row.cells["d:2026-04-01"]).toBe("P");
    expect(row.cells["d:2026-04-02"]).toBeNull();
  });

  /**
   * 🔴 THE COUNT THAT MAKES A SILENT MONTH VISIBLE. Thirty unrecorded
   * days and thirty present days look identical on a printout unless
   * somebody counts the gaps.
   */
  it("unrecorded days are counted and warned about", () => {
    const document = attendance([
      { employeeId: RAVI.id, onDate: "2026-04-01", status: "present", lopCentidays: 0 },
    ]);
    const row = document.rows.find((r) => r.key === RAVI.id)!;
    expect(row.cells.daysUnrecorded).toBe("29");
    expect(document.warnings.join(" ")).toContain("no attendance entry");
  });

  /**
   * ⚠️ AND ONLY FOR DAYS THE PERSON WAS ON THE ROLLS. Counting the ten
   * days before Meena joined as unrecorded absence would make every new
   * joiner look like a compliance failure.
   */
  it("days before joining are not counted as unrecorded", () => {
    const document = attendance([]);
    const row = document.rows.find((r) => r.key === MEENA.id)!;
    expect(row.cells.daysUnrecorded).toBe("20");
  });

  it("the day grid is omitted, with a reason, for a period longer than a muster period", () => {
    const document = attendance([], "2025-04-01", "2026-03-31");
    expect(document.columns.some((c) => c.id.startsWith("d:"))).toBe(false);
    expect(document.warnings.join(" ")).toContain("day-by-day grid is omitted");
    expect(MAX_MUSTER_DAYS).toBeLessThanOrEqual(31);
  });

  /** ⚠️ Attendance is editable, so the muster roll can never be final. */
  it("the muster roll is never stamped final", () => {
    expect(attendance([]).status).toBe("provisional");
  });
});

/* ================================================================== */
/* ⑦ THE LEAVE REGISTER AND THE TWO KINDS THAT ARE NOT LEAVE           */
/* ================================================================== */

describe("⑦ a reservation is not leave taken", () => {
  const entry = (kind: string, centidays: number): LeaveLedgerFact => ({
    employeeId: RAVI.id,
    leaveTypeId: "el",
    leaveTypeCode: "EL",
    leaveTypeLabel: "Earned leave",
    kind,
    daysDeltaCentidays: centidays,
  });

  const leave = (ledger: readonly LeaveLedgerFact[]) =>
    buildLeaveRegister({
      employees: [RAVI],
      ledger,
      ruleSetId: DEFAULT_RULE_SET_ID,
      generatedOn: GENERATED_ON,
      periodFrom: "2025-04-01",
      periodTo: "2026-03-31",
      periodLabel: "FY 2025-26",
    });

  /**
   * 🔴 `commitment` AND `commitment_release` NEVER MOVE A BALANCE. They
   * are what an APPROVAL writes; only attendance writes `taken`. Folding
   * them in would report leave as taken that nobody has taken, on a
   * document the employee can dispute.
   */
  it("commitments are excluded from the fold and are said to be", () => {
    const withCommitments = leave([
      entry("carry_forward_in", 500),
      entry("accrual", 1800),
      entry("taken", -600),
      entry("commitment", -300),
      entry("commitment_release", 300),
    ]);
    const withoutCommitments = leave([
      entry("carry_forward_in", 500),
      entry("accrual", 1800),
      entry("taken", -600),
    ]);
    const a = withCommitments.rows[0]!.cells;
    const b = withoutCommitments.rows[0]!.cells;
    expect(a.closingDays).toBe(b.closingDays);
    expect(a.takenDays).toBe("6");
    expect(a.closingDays).toBe("17");
    expect(withCommitments.basis.join(" ")).toContain("reservation is not leave taken");
  });

  it("taken, encashed and lapsed print as magnitudes and still net correctly", () => {
    const document = leave([
      entry("opening_balance", 1000),
      entry("accrual", 1200),
      entry("taken", -400),
      entry("encashed", -200),
      entry("lapse", -100),
      entry("adjustment", 50),
    ]);
    const cells = document.rows[0]!.cells;
    expect(cells.openingDays).toBe("10");
    expect(cells.earnedDays).toBe("12");
    expect(cells.takenDays).toBe("4");
    expect(cells.encashedDays).toBe("2");
    expect(cells.lapsedDays).toBe("1");
    expect(cells.adjustedDays).toBe("0.5");
    expect(cells.closingDays).toBe("15.5");
  });

  /**
   * ⚠️ AN EMPLOYEE WITH NO LEDGER ENTRIES GETS NO ROW, AND THE DOCUMENT
   * SAYS SO. A nil row would assert an entitlement of zero, which is the
   * opposite of "we have no record".
   */
  it("an employee with no ledger entries gets no row and a stated warning", () => {
    const document = leave([]);
    expect(document.rows).toHaveLength(0);
    expect(document.warnings.join(" ")).toContain("not an entitlement of zero");
  });

  it("an unreadable ledger entry blanks the row rather than half-folding it", () => {
    const document = leave([
      entry("accrual", 1200),
      { ...entry("taken", 0), daysDeltaCentidays: null },
    ]);
    expect(document.rows[0]!.cells.closingDays).toBeNull();
    expect(document.warnings.join(" ")).toContain("unreadable");
  });
});

/* ================================================================== */
/* ⑧ THESE ARE REPORTS, NOT WRITES, AND BOTH DOORS ARE GUARDED         */
/* ================================================================== */

describe("⑧ the action reads, guards and writes nothing", () => {
  const code = codeOnly(ACTIONS);

  /**
   * 🔴 `"use server"` PUBLISHES EVERY EXPORT AS A URL. A wage register
   * is every colleague's salary; a leave register is everybody's absence
   * history. Tenant membership alone is not enough for either.
   */
  it("every export is guarded in one hop", () => {
    const exports = [...code.matchAll(/export async function ([A-Za-z0-9_]+)/g)].map(
      (m) => m[1]!,
    );
    expect(exports.length).toBeGreaterThan(0);
    expect(exports).toContain("generateRegister");
    expect(exports).toContain("listRegisterCatalogue");
    for (const name of exports) {
      const at = code.indexOf(`export async function ${name}`);
      const body = code.slice(at, at + 2600);
      expect(body).toMatch(/require(All)?Permissions?\s*\(/);
    }
  });

  /**
   * ⚠️ `leave.read` IS DELIBERATELY OUT OF THE DEFAULT ROLE TEMPLATES —
   * it is the whole leave register for everybody. Reaching leave data
   * through a payroll-shaped door would undo that decision silently.
   */
  it("the leave and attendance registers demand leave.read as well", () => {
    expect(code).toContain('"leave.read"');
    expect(code).toContain('"payroll.read"');
    expect(code).toMatch(/needsLeave\s*\?\s*\[PAYROLL_READ,\s*LEAVE_READ\]/);
    expect(specFor("attendance_register").needsLeave).toBe(true);
    expect(specFor("leave_with_wages_register").needsLeave).toBe(true);
    expect(specFor("wage_register").needsLeave).toBe(false);
  });

  it("nothing in the action writes, revalidates or executes raw SQL", () => {
    expect(code).not.toMatch(/\.insert\(/);
    expect(code).not.toMatch(/\.update\(/);
    expect(code).not.toMatch(/\.delete\(/);
    expect(code).not.toMatch(/revalidatePath\(/);
    expect(code).not.toMatch(/tx\.execute\(/);
    expect(code).not.toMatch(/CREATE TABLE/i);
  });

  /**
   * 🔴 EVERY TENANT-SCOPED READ GOES THROUGH `withTenant`. A query
   * outside it runs with no `app.current_tenant_id` set and RLS is the
   * SOLE isolation in this product.
   */
  it("every read runs inside withTenant and none re-filters tenant_id by hand", () => {
    expect(code).toContain("withTenant(ctx.tenant.id");
    expect((code.match(/withTenant\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(code).not.toMatch(/eq\(\s*\w+\.tenantId/);
  });

  /** ⚠️ A cancelled run's payslips describe wages that were never paid. */
  it("cancelled runs are excluded from the wage register's source query", () => {
    expect(code).toMatch(/ne\(payrollRuns\.status,\s*"cancelled"\)/);
  });

  /** ⭐ The page explains the blank-is-not-a-nil rule before generating. */
  it("the screen states the rule it runs on", () => {
    expect(PAGE).toContain("A blank is not a nil");
    expect(PAGE).toContain("plausible zero");
  });
});
