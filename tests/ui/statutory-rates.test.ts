/**
 * Ordence — ⭐⭐⭐ BATCH 52: STATUTORY RATES COULD BE SEEDED, NEVER CORRECTED
 * Version: v1.46.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS FILE IS ABOUT
 * ══════════════════════════════════════════════════════════════════════
 * `statutory_rates` has been effective-dated since Batch 15 and nothing
 * in the product could write a second row into it. `seedPayrollSetup`
 * writes opening figures once and deliberately never overwrites them, so
 * a Finance Act change — one a year, every February — was a code deploy,
 * and a typo in a PF ceiling was `UPDATE statutory_rates SET payload`.
 *
 * ⚠️ THAT `UPDATE` SILENTLY RESTATES EVERY PAYROLL EVER COMPUTED AGAINST
 * THE ROW, and the payslip in the employee's inbox stops matching the
 * system. Nothing errors. Nothing is logged.
 *
 * ⭐ THE ASSERTIONS BELOW ARE ABOUT THE DOOR, NOT THE ARITHMETIC. The
 * arithmetic is `lib/payroll/statutory.ts` and is tested in
 * `payroll.test.ts` against worked examples. What is tested here is the
 * period algebra — who overlaps whom, which runs read which row, and
 * whether a write restates history — plus the structural claims the
 * screens make, asserted against comment-stripped source so that a
 * paragraph of prose cannot make a test pass.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import {
  RATE_KINDS,
  describeRuns,
  findOverlaps,
  isSettled,
  openIncumbent,
  percentFromBp,
  periodsOverlap,
  previousDay,
  resolutionFor,
  rowsInForceOn,
  rupeesFromMinor,
  runsResolvedDifferently,
  runsUsingRow,
  seriesKey,
  withRevision,
  type RatePeriod,
  type RunPeriod,
} from "@/lib/payroll/rate-periods";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/**
 * ⚠️ COMMENTS STRIPPED, BECAUSE EVERY ASSERTION OF ABSENCE BELOW WOULD
 * OTHERWISE BE SATISFIED BY THE PARAGRAPH EXPLAINING WHY THE THING IS
 * ABSENT. Same helper as `tests/ui/order-create.test.ts`.
 */
const codeOnly = (s: string) =>
  s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));

const ACTION = read("server/actions/statutory-rates.ts");
const PAGE = read("app/(crm)/payroll/rates/page.tsx");
const TABLE = read("components/payroll/rate-series-table.tsx");
const FORM = read("components/payroll/rate-revision-form.tsx");
const DIALOG = read("components/payroll/rate-correction-dialog.tsx");
const HELPERS = read("lib/payroll/rate-periods.ts");
const RUN = read("server/payroll/run.ts");

/* ------------------------------------------------------------------ */
/* FIXTURES                                                            */
/* ------------------------------------------------------------------ */

const pf = (id: string, from: string, to: string | null): RatePeriod => ({
  id,
  kind: "pf",
  scope: null,
  effectiveFrom: from,
  effectiveTo: to,
});

const ptSlabRow = (id: string, from: string, to: string | null): RatePeriod => ({
  id,
  kind: "professional_tax",
  scope: "KA",
  effectiveFrom: from,
  effectiveTo: to,
});

const run = (
  runNo: string,
  periodStart: string,
  periodEnd: string,
  status: string,
): RunPeriod => ({ id: `run-${runNo}`, runNo, periodStart, periodEnd, status });

/* ================================================================== */
/* ① THE PERIOD ALGEBRA                                                */
/* ================================================================== */

describe("effective periods", () => {
  /**
   * 🔴 BOTH BOUNDS ARE INCLUSIVE AND GETTING THAT WRONG BREAKS EVERY
   * LEGITIMATE RATE CHANGE IN THE COUNTRY. A row ending 31 March and a
   * row starting 1 April do not overlap; a half-open reading would call
   * that an overlap and refuse the ordinary Budget change.
   */
  it("does not call a clean handover an overlap", () => {
    expect(periodsOverlap(pf("a", "2024-04-01", "2025-03-31"), pf("b", "2025-04-01", null))).toBe(
      false,
    );
  });

  it("calls one day of shared cover an overlap", () => {
    expect(periodsOverlap(pf("a", "2024-04-01", "2025-04-01"), pf("b", "2025-04-01", null))).toBe(
      true,
    );
  });

  it("treats an open-ended row as overlapping everything after it starts", () => {
    expect(periodsOverlap(pf("a", "2024-04-01", null), pf("b", "2030-01-01", null))).toBe(true);
    expect(periodsOverlap(pf("a", "2024-04-01", null), pf("b", "2020-01-01", "2020-12-31"))).toBe(
      false,
    );
  });

  /**
   * ⚠️ A STATE'S PROFESSIONAL TAX IS NOT A VERSION OF ANOTHER STATE'S.
   * Treating `kind` alone as the series would report Karnataka as
   * overlapping Maharashtra, the refusal would fire on every legitimate
   * write, and the fix somebody reached for would be to delete it.
   */
  it("keeps two States' professional tax in separate series", () => {
    const ka = ptSlabRow("ka", "2024-04-01", null);
    const mh: RatePeriod = { ...ka, id: "mh", scope: "MH" };
    expect(seriesKey(ka.kind, ka.scope)).not.toBe(seriesKey(mh.kind, mh.scope));
    expect(findOverlaps([ka, mh], ka)).toHaveLength(0);
  });

  it("finds a real overlap inside one series", () => {
    const rows = [pf("a", "2024-04-01", null), pf("b", "2025-01-01", null)];
    expect(findOverlaps(rows, rows[1]!).map((r) => r.id)).toEqual(["a"]);
  });

  it("steps back one day in UTC, never the local clock", () => {
    expect(previousDay("2025-04-01")).toBe("2025-03-31");
    expect(previousDay("2024-03-01")).toBe("2024-02-29");
  });
});

/* ================================================================== */
/* ② THE TWO RESOLUTION RULES                                          */
/* ================================================================== */

describe("how the engine resolves each kind", () => {
  /**
   * 🔴 THE FACT THIS FILE EXISTS TO PIN DOWN. `loadRates` calls
   * `pickEffective` for pf, esi and income_tax — one row wins. It
   * `flatMap`s professional_tax and income_tax_slab — every row in force
   * applies together. A screen that assumed one rule for both would show
   * a superseded slab table as inert when the engine is still reading it.
   */
  it("is single for pf, esi and income tax and union for the slab tables", () => {
    expect(resolutionFor("pf")).toBe("single");
    expect(resolutionFor("esi")).toBe("single");
    expect(resolutionFor("income_tax")).toBe("single");
    expect(resolutionFor("professional_tax")).toBe("union");
    expect(resolutionFor("income_tax_slab")).toBe("union");
  });

  /** ⚠️ And that claim is checked against `loadRates` itself, not asserted. */
  it("matches what loadRates actually does", () => {
    const code = codeOnly(RUN);
    expect(code).toMatch(/pickEffective\(\s*\n?\s*dated\.filter\(\(r\) => r\.kind === "pf"\)/);
    /*
      ⚠️ THE SLICE IS `loadRates`' OWN BODY, not a search of the whole
      file. `ptSlabs:` appears three times in `run.ts` — the
      `LoadedRates` interface, the object `loadRates` builds, and the
      arguments `computeRun` hands to `buildPayslip`. Only the middle one
      says anything about how the rows are resolved.
    */
    const loadBody = code.slice(
      code.indexOf("export async function loadRates("),
      code.indexOf("function num("),
    );
    const ptSlice = loadBody.slice(
      loadBody.indexOf("ptSlabs:"),
      loadBody.indexOf("taxByRegime:"),
    );
    expect(ptSlice).toContain("flatMap");
    expect(ptSlice).not.toContain("pickEffective");
    // ⭐ And the tax slabs are the same shape: unioned, never picked.
    const slabSlice = loadBody.slice(loadBody.indexOf("taxSlabs:"));
    expect(slabSlice).toContain("flatMap");
    expect(slabSlice).not.toContain("pickEffective");
  });

  it("returns one row for a single-resolution series and both for a union one", () => {
    const single = [pf("old", "2024-04-01", null), pf("new", "2025-04-01", null)];
    expect(rowsInForceOn(single, "2025-06-01").map((r) => r.id)).toEqual(["new"]);

    const union = [ptSlabRow("old", "2024-04-01", null), ptSlabRow("new", "2025-04-01", null)];
    expect(rowsInForceOn(union, "2025-06-01").map((r) => r.id).sort()).toEqual(["new", "old"]);
  });

  /**
   * ⚠️ NOTHING IN FORCE IS AN EMPTY LIST, NEVER A FALLBACK TO THE
   * NEWEST ROW. `pickEffective` refuses for the same reason: a payroll
   * for a period with no configured rate must state a problem rather
   * than quietly use today's numbers.
   */
  it("returns nothing for a date before the series starts", () => {
    expect(rowsInForceOn([pf("a", "2024-04-01", null)], "2020-01-01")).toEqual([]);
  });
});

/* ================================================================== */
/* ③ WHICH RUNS READ WHICH ROW                                         */
/* ================================================================== */

describe("attributing runs to rate rows", () => {
  const series = [pf("old", "2024-04-01", "2025-03-31"), pf("new", "2025-04-01", null)];
  const runs = [
    run("PR-2025-02", "2025-02-01", "2025-02-28", "posted"),
    run("PR-2025-04", "2025-04-01", "2025-04-30", "approved"),
    run("PR-2025-05", "2025-05-01", "2025-05-31", "computed"),
    run("PR-2025-06", "2025-06-01", "2025-06-30", "cancelled"),
  ];

  it("attributes each run by its period END, which is what computeRun passes", () => {
    expect(runsUsingRow({ rowId: "old", series, runs }).map((r) => r.runNo)).toEqual([
      "PR-2025-02",
    ]);
    expect(runsUsingRow({ rowId: "new", series, runs }).map((r) => r.runNo)).toEqual([
      "PR-2025-04",
      "PR-2025-05",
    ]);
  });

  /**
   * 🔴 THE ATTRIBUTION IS ONLY TRUE WHILE THE ENGINE STILL SELECTS ON
   * `periodEnd`. If `computeRun` ever loaded rates on `periodStart`, this
   * screen would attribute runs to the wrong rows in exactly the month a
   * rate changed — the one month anybody looks at.
   */
  it("is pinned to computeRun still loading rates on the period end", () => {
    expect(codeOnly(RUN)).toContain("loadRates(tx, args.tenantId, args.periodEnd)");
  });

  /** ⚠️ A cancelled run moved no money and must not block anything. */
  it("ignores cancelled runs", () => {
    expect(
      runsUsingRow({ rowId: "new", series, runs }).some((r) => r.status === "cancelled"),
    ).toBe(false);
  });

  it("counts only approved and posted runs as settled", () => {
    expect(isSettled("approved")).toBe(true);
    expect(isSettled("posted")).toBe(true);
    expect(isSettled("computed")).toBe(false);
    expect(isSettled("draft")).toBe(false);
    expect(isSettled("cancelled")).toBe(false);
  });
});

/* ================================================================== */
/* ④ A CHANGE IS NOT A CORRECTION, AND THE SERVER DECIDES WHICH        */
/* ================================================================== */

describe("telling a rate change from a correction", () => {
  const series = [pf("old", "2024-04-01", null)];
  const settled = [
    run("PR-2025-02", "2025-02-01", "2025-02-28", "posted"),
    run("PR-2025-03", "2025-03-01", "2025-03-31", "approved"),
  ];

  /**
   * ⭐ THE ORDINARY CASE. A rate starting after everything settled
   * restates nothing, so it is a CHANGE and needs no ceremony. A
   * workflow with ceremony on the February Budget change is a workflow
   * people route around with psql.
   */
  it("calls a forward-dated rate a change, restating nothing", () => {
    const candidate = pf("candidate", "2025-07-01", null);
    const after = withRevision(series, candidate);
    expect(runsResolvedDifferently({ before: series, after, runs: settled })).toEqual([]);
  });

  /**
   * 🔴 THE CASE THE WHOLE BATCH EXISTS FOR. A rate back-dated into a
   * month already signed off changes what that month resolves to, so it
   * is a CORRECTION wearing a change's clothes and the ordinary door
   * must refuse it BY NAME.
   */
  it("calls a back-dated rate a correction and names the runs", () => {
    const candidate = pf("candidate", "2025-03-01", null);
    const after = withRevision(series, candidate);
    const restated = runsResolvedDifferently({ before: series, after, runs: settled });
    expect(restated.map((r) => r.runNo)).toEqual(["PR-2025-03"]);
    expect(describeRuns(restated)).toBe("PR-2025-03");
  });

  /**
   * ⚠️ AND A UNION SERIES IS CAUGHT WHERE A DATE HEURISTIC WOULD MISS
   * IT. Adding a second professional tax table alongside an existing one
   * does not supersede anything — the engine reads BOTH — so a settled
   * run's resolved set changes even though the ordinary "latest start
   * wins" intuition says nothing moved.
   */
  it("catches a union series where the new row does not supersede", () => {
    const ptSeries = [ptSlabRow("first", "2024-04-01", null)];
    const candidate = ptSlabRow("second", "2025-03-01", null);
    // ⚠️ Not `withRevision`, which closes the incumbent — this is the
    // shape where somebody adds an overlapping row on purpose.
    const after = [...ptSeries, candidate];
    const restated = runsResolvedDifferently({ before: ptSeries, after, runs: settled });
    expect(restated.map((r) => r.runNo)).toEqual(["PR-2025-03"]);
  });

  /**
   * ⭐ CLOSING THE INCUMBENT IS THE ONLY EDIT A CHANGE MAKES, AND IT IS
   * A DATE. The payload and the start date of the superseded row are
   * untouched, which is what lets an old payslip still be reproduced.
   */
  it("closes the open incumbent the day before, and touches nothing else", () => {
    const after = withRevision(series, pf("candidate", "2025-07-01", null));
    const previous = after.find((r) => r.id === "old")!;
    expect(previous.effectiveTo).toBe("2025-06-30");
    expect(previous.effectiveFrom).toBe("2024-04-01");
  });

  /**
   * 🔴🔴 THE CASE THAT WOULD HAVE CREATED THE VERY OVERLAP THIS BATCH
   * REFUSES. A series that already carries TWO open-ended rows — from an
   * import, or from before the refusal existed — must not have both
   * tidied away by the projection. `addRateRevision` issues ONE update,
   * so the projection closes ONE row, the stray one is still open, and
   * `findOverlaps` sees it and the write is refused.
   */
  it("closes only the one row the action actually updates, so a stray open row is still caught", () => {
    const broken = [pf("a", "2024-01-01", null), pf("b", "2024-06-01", null)];
    const candidate = pf("candidate", "2025-07-01", null);
    const after = withRevision(broken, candidate);

    expect(after.find((r) => r.id === "b")!.effectiveTo).toBe("2025-06-30");
    expect(after.find((r) => r.id === "a")!.effectiveTo).toBeNull();
    expect(findOverlaps(after, candidate).map((r) => r.id)).toEqual(["a"]);
  });

  /** ⚠️ A row somebody already closed on purpose is never silently moved. */
  it("leaves an already-closed row alone", () => {
    const closed = [pf("old", "2024-04-01", "2024-12-31")];
    const after = withRevision(closed, pf("candidate", "2025-07-01", null));
    expect(after.find((r) => r.id === "old")!.effectiveTo).toBe("2024-12-31");
  });

  it("finds the open incumbent of a series and nothing when there is none", () => {
    expect(openIncumbent(series, "pf", null)?.id).toBe("old");
    expect(openIncumbent([pf("a", "2024-04-01", "2024-12-31")], "pf", null)).toBeNull();
  });
});

/* ================================================================== */
/* ⑤ THE ACTIONS: WHAT THEY GUARD AND WHAT THEY REFUSE                 */
/* ================================================================== */

describe("server/actions/statutory-rates.ts", () => {
  it("exists and is a server module", () => {
    expect(existsSync(join(ROOT, "server/actions/statutory-rates.ts"))).toBe(true);
    expect(ACTION.startsWith('"use server";')).toBe(true);
  });

  /**
   * 🔴 EVERY EXPORT IS A PUBLIC HTTP ENDPOINT AND THE GUARD MUST BE
   * VISIBLE AT IT. `check:guards` follows one hop only.
   */
  it("guards every export at the export", () => {
    const code = codeOnly(ACTION);
    const exports = [...code.matchAll(/export async function (\w+)\(/g)].map((m) => m[1]!);
    expect(exports.sort()).toEqual([
      "addRateRevision",
      "correctStatutoryRate",
      "listStatutoryRates",
    ]);
    for (const name of exports) {
      const body = code.slice(code.indexOf(`export async function ${name}(`));
      const head = body.slice(0, 600);
      expect(head, `${name} has no tier-2 guard at the export`).toMatch(
        /require(Permission|AllPermissions)\(/,
      );
    }
  });

  /**
   * ⭐⭐ THE CORRECTION IS SEPARATELY PERMISSIONED, AND THE SECOND KEY IS
   * THE SIGNATURE KEY. `payroll.manage` maintains rates; `payroll.approve`
   * signs off a wage bill. A correction rewrites what was signed off.
   *
   * ⚠️ The key actually wanted is `payroll.rates.correct`, which cannot
   * be added without touching `db/schema/auth.ts`. Composing two
   * existing keys is strictly stronger than `payroll.manage` alone.
   */
  it("requires both the maintenance key and the approval key to correct", () => {
    const code = codeOnly(ACTION);
    const body = code.slice(code.indexOf("export async function correctStatutoryRate("));
    expect(body.slice(0, 400)).toContain("requireAllPermissions([MANAGE, APPROVE])");
  });

  it("adds a revision behind the maintenance key alone", () => {
    const code = codeOnly(ACTION);
    const body = code.slice(code.indexOf("export async function addRateRevision("));
    expect(body.slice(0, 400)).toContain("requirePermission(MANAGE)");
  });

  /**
   * 🔴🔴 DESIGN POINT 1, ASSERTED AS AN ABSENCE. `addRateRevision` may
   * INSERT and may set `effectiveTo` on the incumbent. It must never
   * write a payload onto an existing row — that is the `UPDATE ... SET
   * payload` this whole batch exists to prevent, and it would restate
   * every payslip computed from the row.
   */
  it("never writes a payload onto an existing row from the ordinary door", () => {
    const code = codeOnly(ACTION);
    const add = code.slice(
      code.indexOf("export async function addRateRevision("),
      code.indexOf("export async function correctStatutoryRate("),
    );
    expect(add).toContain(".insert(statutoryRates)");
    // The only `.set(` in the change path closes a period. No payload.
    const sets = [...add.matchAll(/\.set\(\{([^}]*)\}\)/g)].map((m) => m[1]!);
    expect(sets).toHaveLength(1);
    expect(sets[0]).toContain("effectiveTo");
    expect(sets[0]).not.toContain("payload");
  });

  /**
   * ⚠️ AND THERE IS NO GENERIC UPDATE EXPORT. One would be reached for
   * the next time a number is wrong, at 9pm on payroll day.
   */
  it("exports no generic rate update", () => {
    const code = codeOnly(ACTION);
    expect(code).not.toMatch(/export async function (update|save|edit)Rate/i);
    expect(code).not.toMatch(/export async function deleteRate/i);
  });

  /**
   * 🔴 DESIGN POINT 4. Both doors refuse an overlap. A correction is
   * permission to restate history, never permission to make payroll
   * non-deterministic, and collapsing the two would make the loud door
   * a way round the quiet check.
   */
  it("refuses overlapping effective periods at both doors", () => {
    const code = codeOnly(ACTION);
    const add = code.slice(
      code.indexOf("export async function addRateRevision("),
      code.indexOf("export async function correctStatutoryRate("),
    );
    const correct = code.slice(code.indexOf("export async function correctStatutoryRate("));
    expect(add).toContain("findOverlaps(");
    expect(correct).toContain("findOverlaps(");
    expect(ACTION).toContain("already in force over that period");
  });

  /**
   * ⭐ THE CORRECTION MUST NAME THE RUNS AND THE CALLER MUST SEND THAT
   * LIST BACK. A confirmation the caller can satisfy without reading is
   * a confirmation that confirms nothing — and the failure it guards is
   * precise: a colleague approves another run while the dialog is open.
   */
  it("checks the acknowledged run list against its own", () => {
    const code = codeOnly(ACTION);
    expect(code).toContain("acknowledgeRuns");
    const correct = code.slice(code.indexOf("export async function correctStatutoryRate("));
    expect(correct).toContain("expected.join");
    expect(correct).toContain("acknowledged.join");
    expect(ACTION).toContain("That is not the list you confirmed");
  });

  /** ⚠️ A correction that restates nothing belongs at the ordinary door. */
  it("refuses a correction to a row no settled run read", () => {
    expect(ACTION).toContain("this is not a correction");
  });

  /**
   * ⭐ THE SUPERSEDED FIGURES SURVIVE. There is no `previous_payload`
   * column, so the row's own note carries them. Without them nobody can
   * explain a payslip issued before the correction.
   */
  it("preserves the superseded figures and reasons on the row", () => {
    expect(ACTION).toContain("Superseded figures");
    expect(ACTION).toContain("CORRECTED");
  });

  /** 🔴 And the audit entry is critical and carries the reason. */
  it("audits a correction as critical with its reason", () => {
    const code = codeOnly(ACTION);
    const correct = code.slice(code.indexOf("export async function correctStatutoryRate("));
    expect(correct).toContain('severity: "critical"');
    expect(correct).toContain("restatesHistory: true");
    expect(correct).toContain("reason: d.reason");
  });

  /**
   * 🔴 MONEY IS A DIGIT STRING AND A RATE IS A WHOLE BASIS POINT.
   * `z.number()` on a paise ceiling loses precision at nine figures, and
   * a float rate multiplied into bigint paise is where the rupee goes.
   */
  it("takes money as digit strings and rates as integers, never floats", () => {
    const code = codeOnly(ACTION);
    expect(code).toContain('.regex(/^\\d+$/');
    expect(code).toMatch(/z\s*\n?\s*\.number\(\)\s*\n?\s*\.int\(/);
    expect(code).not.toMatch(/parseFloat|Number\.parseFloat|z\.number\(\)\.min\(0\)\.max\(1\)/);
  });

  /**
   * ⚠️ A SLAB LADDER IS VALIDATED AS A LADDER. A gap is a band of income
   * taxed by nothing; an overlap is a band taxed twice. Both are silent.
   */
  it("validates slab ladders for gaps and overlaps", () => {
    expect(ACTION).toContain("Slabs must be contiguous to the paise");
    expect(ACTION).toContain("The top slab must be open-ended");
  });

  /** ⚠️ A scope that the engine never selects is a row nothing reads. */
  it("refuses a scope the engine would never select", () => {
    const code = codeOnly(ACTION);
    expect(code).toContain("function validateScope");
    expect(ACTION).toContain("two-letter State code");
  });
});

/* ================================================================== */
/* ⑥ THE SCREEN                                                        */
/* ================================================================== */

describe("the rates screen", () => {
  it("exists and is reachable from payroll", () => {
    expect(existsSync(join(ROOT, "app/(crm)/payroll/rates/page.tsx"))).toBe(true);
    expect(codeOnly(read("app/(crm)/payroll/page.tsx"))).toContain('href="/payroll/rates"');
  });

  it("calls all three actions", () => {
    const code = codeOnly(PAGE);
    expect(code).toContain("listStatutoryRates");
    expect(code).toContain("addRateRevision");
    expect(code).toContain("correctStatutoryRate");
  });

  /**
   * ⭐⭐ DESIGN POINT 3. A rate table that does not say which row is in
   * force today, and which runs read each historical row, is a list of
   * numbers nobody can audit.
   */
  it("marks the row in force today and names the runs that read each row", () => {
    const code = codeOnly(TABLE);
    expect(code).toContain("inForceToday");
    expect(code).toContain("row.runs");
    expect(TABLE).toContain("in force today");
    expect(TABLE).toContain("Read by");
  });

  /** ⚠️ And it says the attribution is derived rather than recorded. */
  it("says the run attribution is a derivation, not a record", () => {
    expect(ACTION).toContain("It is a derivation, not a record");
  });

  /** 🔴 An overlap already in the table is an alarm, not a silent row. */
  it("shows an existing overlap loudly", () => {
    expect(codeOnly(TABLE)).toContain("overlapsWith.length > 0");
    expect(codeOnly(PAGE)).toContain("overlapCount");
    expect(TABLE).toContain("charged twice");
  });

  /**
   * 🔴 THE CORRECTION DOOR ONLY APPEARS WHERE THERE IS SOMETHING TO
   * RESTATE, AND ONLY WITH BOTH KEYS. Two ways to do the harmless thing
   * is one too many, and the second one is the one people learn.
   */
  it("offers the correction only for rows a settled run read, and only with both keys", () => {
    const code = codeOnly(TABLE);
    expect(code).toContain("canCorrect && row.settledRunNos.length > 0");
    expect(codeOnly(PAGE)).toContain("manage.allowed && approve.allowed");
  });

  /**
   * ⚠️ THE ADD FORM CARRIES NO ROW ID AND CANNOT REACH THE CORRECTION
   * ACTION. A form with an id and a save button is one refactor away
   * from being an update.
   */
  it("gives the add form no way to edit an existing row", () => {
    const code = codeOnly(FORM);
    expect(code).not.toContain("correctStatutoryRate");
    expect(code).not.toContain("rowId");
  });

  /** ⭐ The dialog names the runs before it shows the fields. */
  it("names the affected runs in the correction dialog", () => {
    const code = codeOnly(DIALOG);
    expect(code).toContain("settledRunNos.join");
    expect(code).toContain("acknowledgeRuns: [...settledRunNos]");
    expect(DIALOG).toContain("frozen");
  });

  /**
   * ⚠️ AND IT SAYS WHAT IT DOES NOT DO. Correcting the rate does not
   * recompute the frozen payslips. A dialog that implied otherwise would
   * be the more dangerous lie.
   */
  it("says the frozen payslips are not recomputed", () => {
    expect(DIALOG).toContain("does not recompute anything");
  });
});

/* ================================================================== */
/* ⑦ THE ARITHMETIC IS NOT TOUCHED                                     */
/* ================================================================== */

describe("what this batch deliberately leaves alone", () => {
  /**
   * ⭐ THE STATUTORY ENGINE IS THE STRONGEST CODE IN THE DOMAIN AND THIS
   * BATCH BUILT THE DOOR, NOT THE ROOM. `rate-periods.ts` must not carry
   * a second copy of the selection rule — it delegates to the engine's
   * own `pickEffective`, so the screen cannot disagree with what payroll
   * actually reads.
   */
  it("delegates the selection rule to the engine rather than copying it", () => {
    const code = codeOnly(HELPERS);
    expect(code).toContain('from "@/lib/payroll/statutory"');
    expect(code).toContain("pickEffective(live, onDate)");
    // No second implementation of "latest start wins".
    expect(code).not.toContain("sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0]!;\n  }\n\n  return");
  });

  /** ⚠️ And it does no arithmetic on money at all beyond formatting. */
  it("computes no money", () => {
    const code = codeOnly(HELPERS);
    expect(code).not.toContain("roundToRupee");
    expect(code).not.toContain("computePf");
  });
});

/* ================================================================== */
/* ⑧ THE SMALL PURE HELPERS                                            */
/* ================================================================== */

describe("presentation helpers", () => {
  it("formats paise as rupees without ever going through a float", () => {
    expect(rupeesFromMinor("1500000")).toBe("₹15,000.00");
    expect(rupeesFromMinor("0")).toBe("₹0.00");
    // ⭐ Five crore in paise, grouped the Indian way and never via a float.
    expect(rupeesFromMinor("5000000000")).toBe("₹5,00,00,000.00");
    expect(rupeesFromMinor("2100000")).toBe("₹21,000.00");
  });

  it("formats basis points as a percentage the way the law states it", () => {
    expect(percentFromBp(1200)).toBe("12%");
    expect(percentFromBp(833)).toBe("8.33%");
    expect(percentFromBp(75)).toBe("0.75%");
  });

  it("names runs in a sentence rather than counting them", () => {
    expect(describeRuns([])).toBe("no payroll runs");
    expect(
      describeRuns([
        run("PR-1", "2025-01-01", "2025-01-31", "posted"),
        run("PR-2", "2025-02-01", "2025-02-28", "posted"),
        run("PR-3", "2025-03-01", "2025-03-31", "posted"),
      ]),
    ).toBe("PR-1, PR-2 and PR-3");
  });

  it("knows the five kinds the engine can actually read", () => {
    expect([...RATE_KINDS].sort()).toEqual([
      "esi",
      "income_tax",
      "income_tax_slab",
      "pf",
      "professional_tax",
    ]);
  });
});
