/**
 * Ordence — ⭐⭐⭐ BATCH 109: APPRAISALS AND THE ORG CHART
 * Version: v1.47.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY SO MUCH OF THIS SUITE ASSERTS ABOUT SOURCE RATHER THAN BEHAVIOUR
 * ══════════════════════════════════════════════════════════════════════
 * Two of the three things that can go wrong in this batch do not throw,
 * do not fail to compile and do not look different on screen.
 *
 * ① A MANAGER READING OUTSIDE THEIR LINE. RLS in Ordence scopes by
 *    TENANT. Every colleague's appraisal is in the same tenant, so the
 *    policy is satisfied by "all subjects in this cycle" exactly as it
 *    is by "subjects whose manager is me". The security suite — which
 *    proves RLS holds against a real Postgres — stays green through
 *    both. The only thing that can notice is a test that reads the
 *    query.
 *
 * ② A SKIP-LEVEL REVIEW SHOWN TO THE MANAGER IT IS ABOUT. The row is
 *    correct either way; what differs is who was rendered it.
 *
 * The third — a cycle in the hierarchy — DOES have behaviour, and it is
 * exercised directly against `lib/hr/hierarchy.ts` below.
 *
 * ⭐ ASSERTIONS ABOUT ABSENCE USE `codeOnly()`. These files argue with
 * the mistakes they avoid at length — `payroll`, `manager_id` and
 * `employeeId` all appear in prose explaining why they are not used — so
 * a naive `.not.toContain` would be satisfied by the warning about the
 * bug rather than by its absence.
 *
 * ⚠️ AND NO ASSERTION PINS AN EXACT NUMBER THAT CAN ONLY IMPROVE. Counts
 * are ceilings or floors.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildOrgChart,
  chainUp,
  countNodes,
  descendantsOf,
  MAX_REPORTING_DEPTH,
  skipLevelOf,
  wouldCreateCycle,
  type OrgPerson,
  type ReportingEdge,
} from "@/lib/hr/hierarchy";
import {
  canReadReview,
  canWriteReview,
  canSeeSubject,
  NO_RELATION,
  type ViewerRelation,
} from "@/lib/hr/visibility";
import {
  effectiveOutcome,
  fyLabelFor,
  isEligibleForCycle,
  lineCoveringPeriod,
  RATING_ORDER,
  todayInIndia,
} from "@/lib/hr/appraisal";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const ACTION_PATH = "server/actions/appraisals.ts";
const SCHEMA_PATH = "db/schema/appraisals.ts";
const HIERARCHY_PATH = "lib/hr/hierarchy.ts";
const VISIBILITY_PATH = "lib/hr/visibility.ts";
const APPRAISAL_LIB_PATH = "lib/hr/appraisal.ts";
const SQL_PATH = "SQL-FILES/0085_appraisals_and_org.sql";
const VERIFY_PATH = "SQL-FILES/VERIFY-0085-neon-safe.sql";
const DRILL_PATH = "SQL-FILES/DRILL-DO-NOT-RUN-IN-NEON-0085.sql";

const PAGE_ME = "app/(crm)/hr/me/page.tsx";
const PAGE_CHART = "app/(crm)/hr/org-chart/page.tsx";
const PAGE_CYCLES = "app/(crm)/hr/appraisals/page.tsx";
const PAGE_CYCLE = "app/(crm)/hr/appraisals/[cycleId]/page.tsx";
const COMPONENT_CHART = "components/hr/org-chart.tsx";
const COMPONENT_BOARD = "components/hr/appraisal-board.tsx";
const COMPONENT_MINE = "components/hr/my-appraisals.tsx";
const COMPONENT_CYCLES = "components/hr/cycle-list.tsx";

const ALL_FILES = [
  ACTION_PATH,
  SCHEMA_PATH,
  HIERARCHY_PATH,
  VISIBILITY_PATH,
  APPRAISAL_LIB_PATH,
  SQL_PATH,
  VERIFY_PATH,
  DRILL_PATH,
  PAGE_ME,
  PAGE_CHART,
  PAGE_CYCLES,
  PAGE_CYCLE,
  COMPONENT_CHART,
  COMPONENT_BOARD,
  COMPONENT_MINE,
  COMPONENT_CYCLES,
];

/** Blanks comments and JSX comments while preserving line count. */
const codeOnly = (s: string) =>
  s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));

/** Comments AND string literals blanked — for "this word never appears". */
const codeNoStrings = (s: string) =>
  codeOnly(s)
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");

const ACTION = read(ACTION_PATH);
const ACTION_CODE = codeOnly(ACTION);
const SCHEMA = read(SCHEMA_PATH);
const SQL = read(SQL_PATH);
const PAGE_ME_SRC = read(PAGE_ME);

/* ================================================================== */
/* ① EVERYTHING EXISTS AND IS WIRED                                    */
/* ================================================================== */

describe("the HR section exists and is reachable", () => {
  it("every file this batch claims to ship is on disk", () => {
    for (const p of ALL_FILES) {
      expect(existsSync(join(ROOT, p)), `${p} is missing`).toBe(true);
    }
  });

  /**
   * 🔴 THE ORPHAN CHECK, INLINE. Ordence's recurring failure is a
   * complete engine that nothing reaches — roughly thirty-five instances
   * so far. Every export of the action file must be called from a screen
   * or a component, or it is another one.
   */
  it("every server action is called from a screen or a component", () => {
    const exports = [
      ...ACTION_CODE.matchAll(/^export async function ([A-Za-z0-9_]+)/gm),
    ].map((m) => m[1]);
    expect(exports.length).toBeGreaterThan(8);

    const callers = [
      PAGE_ME,
      PAGE_CHART,
      PAGE_CYCLES,
      PAGE_CYCLE,
      COMPONENT_CHART,
      COMPONENT_BOARD,
      COMPONENT_MINE,
      COMPONENT_CYCLES,
    ]
      .map((p) => codeOnly(read(p)))
      .join("\n");

    for (const name of exports) {
      expect(callers, `${name} is a public endpoint no screen calls`).toContain(name);
    }
  });

  it("the pages import from the action file and render the components", () => {
    expect(codeOnly(PAGE_ME_SRC)).toContain('from "@/server/actions/appraisals"');
    expect(codeOnly(PAGE_ME_SRC)).toContain("myAppraisals");
    expect(codeOnly(read(PAGE_CHART))).toContain("getOrgChart");
    expect(codeOnly(read(PAGE_CYCLE))).toContain("getAppraisalRegister");
  });
});

/* ================================================================== */
/* ② 🔴🔴 THE CYCLE — THE DEFECT THIS BATCH IS ARRANGED AROUND         */
/* ================================================================== */

describe("🔴 a reporting hierarchy with a cycle in it is refused", () => {
  const line = (employeeId: string, managerId: string): ReportingEdge => ({
    employeeId,
    managerId,
  });

  it("refuses the one-hop cycle: A reports to A", () => {
    expect(wouldCreateCycle([], "a", "a")).not.toBeNull();
  });

  it("refuses the two-hop cycle: A→B when B→A already", () => {
    const edges = [line("b", "a")];
    const loop = wouldCreateCycle(edges, "a", "b");
    expect(loop).not.toBeNull();
    expect(loop).toContain("a");
    expect(loop).toContain("b");
  });

  /**
   * ⚠️ THE THREE-HOP CASE IS THE ONE PEOPLE ACTUALLY CREATE. Nobody
   * types A→B→C→A in one go; it is two edits a month apart, each of
   * which looked reasonable to whoever made it.
   */
  it("refuses a three-hop cycle", () => {
    const edges = [line("b", "a"), line("c", "b")];
    expect(wouldCreateCycle(edges, "a", "c")).not.toBeNull();
  });

  it("allows an ordinary line that closes nothing", () => {
    const edges = [line("b", "a"), line("c", "b")];
    expect(wouldCreateCycle(edges, "d", "c")).toBeNull();
  });

  /**
   * ⚠️ RE-POINTING AN EXISTING LINE MUST STILL WORK. A cycle checker
   * that counted the row being replaced would refuse every legitimate
   * reorganisation, and the "fix" would be to weaken it.
   */
  it("allows re-pointing somebody who already has a manager", () => {
    const edges = [line("b", "a"), line("c", "b"), line("d", "a")];
    expect(wouldCreateCycle(edges, "c", "d")).toBeNull();
  });

  /**
   * 🔴 A LOOP ALREADY IN THE DATA MUST NOT HANG THE CHECKER. This is the
   * failure mode that matters most: a cycle detector that loops forever
   * while detecting a loop.
   */
  it("terminates when the existing graph is already cyclic", () => {
    const edges = [line("b", "a"), line("a", "b")];
    expect(wouldCreateCycle(edges, "z", "a")).not.toBeNull();
  });

  it("refuses a chain longer than the depth ceiling", () => {
    const edges: ReportingEdge[] = [];
    for (let i = 1; i <= MAX_REPORTING_DEPTH + 5; i += 1) {
      edges.push(line(`n${i}`, `n${i - 1}`));
    }
    expect(wouldCreateCycle(edges, "x", `n${MAX_REPORTING_DEPTH + 5}`)).not.toBeNull();
  });

  /**
   * 🔴🔴 AND THE ENFORCEMENT THAT MATTERS IS IN THE DATABASE, NOT HERE.
   * A TypeScript check is bypassed by an import, a psql session or an
   * action written next year. These assertions are about the SQL.
   */
  it("the refusal is a trigger in 0085, not only an application check", () => {
    expect(SQL).toContain("reporting_lines_no_cycle");
    expect(SQL).toMatch(/BEFORE INSERT OR UPDATE ON reporting_lines/);
    /** ⚠️ UPDATE too: re-opening an ended loop-closing line is an undo. */
    expect(SQL).toMatch(/CREATE TRIGGER reporting_lines_no_cycle_check[\s\S]{0,200}INSERT OR UPDATE/);
  });

  it("the one-hop cycle is also a CHECK constraint, which nothing skips", () => {
    expect(SQL).toContain("reporting_lines_no_self");
    expect(SQL).toContain("CHECK (employee_id <> manager_id)");
  });

  it("the trigger's own walk is bounded, so it cannot hang detecting a hang", () => {
    const triggerBody = SQL.slice(
      SQL.indexOf("FUNCTION reporting_lines_no_cycle()"),
      SQL.indexOf("DROP TRIGGER IF EXISTS reporting_lines_no_cycle_check"),
    );
    expect(triggerBody).toMatch(/hops\s*:?=\s*hops\s*\+\s*1/);
    expect(triggerBody).toMatch(/hops\s*>\s*64/);
  });
});

/* ================================================================== */
/* ③ THE CHART SURVIVES BAD DATA                                       */
/* ================================================================== */

describe("the org chart never silently loses a person", () => {
  const person = (id: string, leftOn: string | null = null): OrgPerson => ({
    employeeId: id,
    fullName: id.toUpperCase(),
    employeeCode: id,
    designation: null,
    department: null,
    leftOn,
  });

  it("places everybody when the graph is a tree", () => {
    const people = [person("a"), person("b"), person("c")];
    const chart = buildOrgChart(people, [
      { employeeId: "b", managerId: "a" },
      { employeeId: "c", managerId: "b" },
    ]);
    expect(countNodes(chart.roots)).toBe(people.length);
    expect(chart.cyclic).toHaveLength(0);
    expect(chart.maxDepth).toBe(2);
  });

  /**
   * 🔴 A CHART THAT QUIETLY OMITS THREE PEOPLE IS WORSE THAN ONE THAT
   * SAYS THREE PEOPLE COULD NOT BE PLACED.
   */
  it("names the people it cannot place instead of dropping them", () => {
    const people = [person("a"), person("b"), person("c")];
    const chart = buildOrgChart(people, [
      { employeeId: "b", managerId: "c" },
      { employeeId: "c", managerId: "b" },
    ]);
    expect(chart.cyclic.sort()).toEqual(["b", "c"]);
    expect(countNodes(chart.roots) + chart.cyclic.length).toBe(people.length);
  });

  /**
   * 🔴 THE LEAVER DECISION, ASSERTED. Somebody who has left keeps their
   * node and their reports are NOT moved and NOT orphaned — the risk is
   * reported instead.
   */
  it("keeps a leaver on the chart and reports their reports as stale", () => {
    const people = [person("a"), person("boss", "2025-08-31"), person("c")];
    const chart = buildOrgChart(people, [
      { employeeId: "boss", managerId: "a" },
      { employeeId: "c", managerId: "boss" },
    ]);
    expect(countNodes(chart.roots)).toBe(3);
    expect(chart.staleLines).toHaveLength(1);
    expect(chart.staleLines[0].employee.employeeId).toBe("c");
    expect(chart.staleLines[0].manager.leftOn).toBe("2025-08-31");
  });

  it("reports people with no reporting line rather than hiding them", () => {
    const chart = buildOrgChart([person("a"), person("b")], []);
    expect(chart.unassigned.map((p) => p.employeeId).sort()).toEqual(["a", "b"]);
  });

  it("descendantsOf terminates on a cyclic graph", () => {
    const set = descendantsOf(
      [
        { employeeId: "b", managerId: "a" },
        { employeeId: "a", managerId: "b" },
      ],
      "a",
    );
    expect(set.has("a")).toBe(true);
    expect(set.has("b")).toBe(true);
  });

  it("chainUp terminates on a cyclic graph", () => {
    const chain = chainUp(
      [
        { employeeId: "b", managerId: "a" },
        { employeeId: "a", managerId: "b" },
      ],
      "a",
    );
    expect(chain.length).toBeLessThanOrEqual(MAX_REPORTING_DEPTH + 1);
  });

  it("the skip-level is the manager's manager, and null near the top", () => {
    const edges = [
      { employeeId: "c", managerId: "b" },
      { employeeId: "b", managerId: "a" },
    ];
    expect(skipLevelOf(edges, "c")).toBe("a");
    expect(skipLevelOf(edges, "b")).toBeNull();
    expect(skipLevelOf(edges, "a")).toBeNull();
  });
});

/* ================================================================== */
/* ④ 🔴🔴 SELF, MANAGER AND SKIP-LEVEL ARE THREE DIFFERENT ACTS        */
/* ================================================================== */

describe("🔴 three review kinds, three readerships", () => {
  const rel = (over: Partial<ViewerRelation>): ViewerRelation => ({
    ...NO_RELATION,
    ...over,
  });

  it("the schema has three kinds, not one comment field", () => {
    expect(SCHEMA).toContain("appraisalReviewKindEnum");
    for (const kind of ["self", "manager", "skip_level"]) {
      expect(SQL).toContain(`'${kind}'`);
    }
    expect(SQL).toContain("CREATE TYPE appraisal_review_kind");
  });

  it("the subject always reads their own self review", () => {
    expect(canReadReview("self", rel({ isSubject: true }), { released: false })).toBe(true);
  });

  /**
   * ⚠️ NOT BECAUSE IT IS SECRET. A manager who knows the text is being
   * watched live writes a blander, useless review, and an employee
   * reading "needs improvement" before anybody has spoken to them is the
   * harm the release step exists to prevent.
   */
  it("the subject does NOT read the manager review before release", () => {
    expect(canReadReview("manager", rel({ isSubject: true }), { released: false })).toBe(false);
    expect(canReadReview("manager", rel({ isSubject: true }), { released: true })).toBe(true);
  });

  /**
   * 🔴🔴 THE ONE THAT MATTERS MOST. A skip-level review is a check ON
   * the manager. Showing it to them makes it a second manager review
   * with extra steps and nobody writes an honest one again.
   */
  it("the skip-level review is NEVER readable by the manager or the subject", () => {
    for (const released of [false, true]) {
      expect(canReadReview("skip_level", rel({ isManager: true }), { released })).toBe(false);
      expect(canReadReview("skip_level", rel({ isSubject: true }), { released })).toBe(false);
    }
    expect(canReadReview("skip_level", rel({ isSkipLevel: true }), { released: false })).toBe(
      true,
    );
    expect(canReadReview("skip_level", rel({ isHr: true }), { released: false })).toBe(true);
  });

  it("a stranger reads nothing and sees no subject", () => {
    expect(canSeeSubject(NO_RELATION)).toBe(false);
    for (const kind of ["self", "manager", "skip_level"] as const) {
      expect(canReadReview(kind, NO_RELATION, { released: true })).toBe(false);
    }
  });

  /**
   * 🔴 HR MAY READ EVERYTHING AND MAY WRITE NOBODY'S REVIEW. A review
   * filed by somebody who was not there, under a name that was, is a
   * forgery with a permission key attached.
   */
  it("HR cannot write any review kind", () => {
    for (const kind of ["self", "manager", "skip_level"] as const) {
      expect(canWriteReview(kind, rel({ isHr: true }))).toBe(false);
    }
  });

  it("each kind is writable only by the person it belongs to", () => {
    expect(canWriteReview("self", rel({ isSubject: true }))).toBe(true);
    expect(canWriteReview("self", rel({ isManager: true }))).toBe(false);
    expect(canWriteReview("manager", rel({ isManager: true }))).toBe(true);
    expect(canWriteReview("manager", rel({ isSkipLevel: true }))).toBe(false);
    expect(canWriteReview("skip_level", rel({ isSkipLevel: true }))).toBe(true);
    expect(canWriteReview("skip_level", rel({ isManager: true }))).toBe(false);
  });

  /**
   * ⚠️ THE DATABASE AGREES INDEPENDENTLY. `canWriteReview` is bypassed
   * by any code path that does not call it; the trigger is not.
   */
  it("the reviewer/kind rule is also a trigger in 0085", () => {
    expect(SQL).toContain("appraisal_reviews_reviewer_matches_kind");
    expect(SQL).toContain("a self review must be written by the person being reviewed");
    expect(SQL).toContain("a skip-level review must be written by the skip-level manager");
  });
});

/* ================================================================== */
/* ⑤ 🔴🔴 THE myPayslips LESSON — A MANAGER READS ONLY THEIR OWN LINE  */
/* ================================================================== */

describe("🔴 appraisal reads are scoped by which rows point at the caller", () => {
  /**
   * 🔴 THE PARAMETER THAT MUST NOT EXIST. `myAppraisals()` takes no
   * arguments at all — not an employee id, not a subject id, not a
   * filter. A function with no parameter cannot be handed somebody
   * else's id by any future edit that does not first change its
   * signature, which is a change a reviewer sees.
   */
  it("myAppraisals() takes no arguments", () => {
    expect(ACTION_CODE).toMatch(/export async function myAppraisals\(\)/);
  });

  it("the identity comes from the session, never from the input", () => {
    const helper = ACTION_CODE.slice(
      ACTION_CODE.indexOf("async function myEmployeeIds"),
      ACTION_CODE.indexOf("async function myEmployeeIds") + 700,
    );
    expect(helper).toContain("eq(employees.userId, userId)");
    expect(ACTION_CODE).toContain("ctx.user.id");
  });

  /**
   * 🔴🔴 THE THREE PREDICATES. If any one is dropped, weakened or moved
   * outside the `and(...)`, the endpoint publishes every appraisal in
   * the company to anybody who can sign in — and it type checks, it
   * renders, and RLS stays satisfied because every row is in the same
   * tenant.
   */
  it("the participant read narrows on all three reviewer columns", () => {
    const body = ACTION_CODE.slice(
      ACTION_CODE.indexOf("export async function myAppraisals"),
      ACTION_CODE.indexOf("const reviewSchema"),
    );
    expect(body).toContain("inArray(appraisalSubjects.employeeId, mine)");
    expect(body).toContain("inArray(appraisalSubjects.managerEmployeeId, mine)");
    expect(body).toContain("inArray(appraisalSubjects.skipLevelEmployeeId, mine)");
  });

  /**
   * ⚠️ THE WRITE HAS TO NAME A ROW, SO THE CONTROL IS THE SHAPE OF THE
   * LOOKUP: the reviewer predicate is IN the `and(...)`, so a subjectId
   * belonging to somebody else returns no row. There is no "fetch, then
   * check" — the check IS the fetch.
   */
  it("the review write scopes the lookup by the caller, not by a later check", () => {
    const body = ACTION_CODE.slice(
      ACTION_CODE.indexOf("export async function submitAppraisalReview"),
      ACTION_CODE.indexOf("async function participantContext"),
    );
    expect(body).toContain("eq(appraisalSubjects.id, d.subjectId)");
    expect(body).toContain("inArray(appraisalSubjects.managerEmployeeId, mine)");
    expect(body).toContain("canWriteReview");
  });

  /**
   * 🔴 THE PARTICIPANT ENDPOINT MUST NOT WIDEN FOR A PRIVILEGED CALLER.
   * Two code paths in one function put "everything" and "only mine" one
   * boolean apart, and that boolean comes from a role an impersonation
   * session or a seeded fixture can flip.
   */
  it("myAppraisals reports the HR privilege and never acts on it", () => {
    const body = ACTION_CODE.slice(
      ACTION_CODE.indexOf("export async function myAppraisals"),
      ACTION_CODE.indexOf("const reviewSchema"),
    );
    expect(body).toContain("canSeeEveryone");
    /** The relation handed to the visibility matrix pins isHr false. */
    expect(body).toMatch(/isHr:\s*false/);
  });

  it("the whole register is a separate endpoint behind its own key", () => {
    expect(ACTION_CODE).toMatch(/export async function getAppraisalRegister/);
    const body = ACTION_CODE.slice(
      ACTION_CODE.indexOf("export async function getAppraisalRegister"),
      ACTION_CODE.indexOf("const signOffSchema"),
    );
    expect(body).toContain("requirePermission(HR_READ)");
  });

  /**
   * ⚠️ THE SELF-SERVICE PAGE TAKES NOTHING FROM THE REQUEST. `params`
   * and `searchParams` are both values the browser supplies.
   */
  it("the /hr/me page reads no params and no searchParams", () => {
    const code = codeOnly(PAGE_ME_SRC);
    expect(code).not.toMatch(/\bsearchParams\b/);
    expect(code).not.toMatch(/\bparams\b/);
  });

  it("the participant screen has no employee picker", () => {
    const code = codeNoStrings(read(COMPONENT_MINE));
    expect(code).not.toMatch(/employeeId\s*[:=]/);
  });
});

/* ================================================================== */
/* ⑥ 🔴 A SIGNED-OFF OUTCOME IS EVIDENCE                               */
/* ================================================================== */

describe("🔴 a signed-off outcome is not editable", () => {
  it("the row is frozen by a trigger, not by a convention", () => {
    expect(SQL).toContain("appraisal_subjects_freeze_signed");
    expect(SQL).toContain("a signed-off appraisal outcome cannot be edited");
    expect(SQL).toMatch(/BEFORE UPDATE ON appraisal_subjects/);
  });

  /**
   * ⚠️ RELEASE MUST STILL BE POSSIBLE AFTER SIGN-OFF. Freezing it along
   * with the outcome would mean an appraisal could be signed off and
   * never shown to the person it is about.
   */
  it("release is deliberately not frozen", () => {
    const fn = SQL.slice(
      SQL.indexOf("FUNCTION appraisal_subjects_freeze_signed()"),
      SQL.indexOf("DROP TRIGGER IF EXISTS appraisal_subjects_frozen_after_signoff"),
    );
    expect(fn).toContain("outcome_rating");
    expect(fn).not.toContain("released_at");
  });

  it("a correction is an append-only amendment with an actor and a reason", () => {
    expect(SQL).toContain("appraisal_amendments_append_only");
    expect(SQL).toContain("appraisal_amendments_reason_meant");
    expect(SQL).toContain("length(btrim(reason)) >= 20");
    expect(SQL).toContain("amended_by");
  });

  it("amending needs the sign-off key, not the everyday HR key", () => {
    const body = ACTION_CODE.slice(
      ACTION_CODE.indexOf("export async function amendAppraisalOutcome"),
      ACTION_CODE.indexOf("export type ReviewView"),
    );
    expect(body).toContain("requirePermission(HR_SIGNOFF)");
    expect(body).toContain("reason");
  });

  /**
   * 🔴 THE EFFECTIVE OUTCOME IS A FOLD, NEVER A COLUMN THAT WAS
   * OVERWRITTEN. Two places holding the same fact disagree the first
   * time one write of a pair is missed, and both look like ratings.
   */
  it("the effective outcome is the latest amendment, and the original survives", () => {
    const base = { originalRating: "meets" as const, originalSummary: "steady" };
    expect(effectiveOutcome({ ...base, amendments: [] })).toMatchObject({
      rating: "meets",
      amended: false,
    });
    const folded = effectiveOutcome({
      ...base,
      amendments: [
        { newRating: "outstanding", newSummary: "b", amendedAt: "2026-02-01T00:00:00Z" },
        { newRating: "exceeds", newSummary: "a", amendedAt: "2026-01-01T00:00:00Z" },
      ],
    });
    /** ⚠️ Unordered input; the latest by timestamp wins, not the first. */
    expect(folded.rating).toBe("outstanding");
    expect(folded.amended).toBe(true);
    expect(folded.amendmentCount).toBe(2);
  });

  it("the register renders that an outcome was amended", () => {
    expect(codeOnly(read(COMPONENT_BOARD))).toContain("amended");
  });
});

/* ================================================================== */
/* ⑦ 🔴 NOT WIRED TO PAY, AND IT SAYS SO ON THE SCREEN                 */
/* ================================================================== */

describe("🔴 the appraisal is NOT wired to pay, plainly", () => {
  /**
   * ⚠️ ASSERTED AGAINST COMMENT-AND-STRING-STRIPPED SOURCE. Every one of
   * these files discusses payroll at length in prose explaining why it
   * is not touched, and a naive `.not.toContain("payroll")` would be
   * satisfied by the warning about the mistake.
   */
  it("the action imports nothing from the payroll engine", () => {
    const imports = ACTION.slice(0, ACTION.indexOf("/* ---"));
    expect(imports).not.toContain('from "@/server/payroll');
    expect(imports).not.toContain('from "@/lib/payroll');
    expect(imports).not.toContain('from "@/server/actions/payroll');
  });

  /** ⭐ `employees` is the roster and is the only payroll import allowed. */
  it("the only payroll import is the employee roster", () => {
    const matches = [...ACTION.matchAll(/from "@\/db\/schema\/payroll"/g)];
    expect(matches.length).toBeLessThanOrEqual(1);
    expect(ACTION).toContain('import { employees } from "@/db/schema/payroll"');
  });

  /**
   * 🔴 NO MONEY COLUMN ANYWHERE. Money in Ordence is bigint paise; an
   * appraisal table with a `minor` column would be the first step to
   * an increment nobody signed.
   */
  it("no money column exists in the schema or the SQL", () => {
    const schemaCode = codeNoStrings(SCHEMA);
    for (const word of ["Minor", "amount", "bigint", "numeric"]) {
      expect(schemaCode, `${word} appears in the appraisal schema`).not.toContain(word);
    }
    const sqlNoComments = SQL.replace(/^\s*--.*$/gm, "");
    for (const word of ["_minor", "numeric(", "bigint"]) {
      expect(sqlNoComments, `${word} appears in 0085`).not.toContain(word);
    }
  });

  /**
   * ⚠️ SAID ON THE SCREEN, NOT ONLY IN A COMMENT. The assumption that an
   * appraisal system feeds payroll is the default assumption, and the
   * cost of it being wrong is somebody not getting an increment they
   * were told they had.
   */
  it("the screens say it in words a user reads", () => {
    for (const p of [COMPONENT_BOARD, PAGE_CYCLES]) {
      expect(read(p).toLowerCase()).toContain("pay");
    }
    expect(read(COMPONENT_BOARD)).toMatch(/changes anybody(&rsquo;|')s pay/i);
  });
});

/* ================================================================== */
/* ⑧ THE PERIOD, THE FINANCIAL YEAR AND ELIGIBILITY                    */
/* ================================================================== */

describe("the Indian financial year and the review period", () => {
  it("runs 1 April to 31 March", () => {
    expect(fyLabelFor("2025-04-01")).toBe("2025-26");
    expect(fyLabelFor("2026-03-31")).toBe("2025-26");
    expect(fyLabelFor("2026-04-01")).toBe("2026-27");
    /** 🔴 January belongs to the year that started the previous April. */
    expect(fyLabelFor("2026-01-15")).toBe("2025-26");
  });

  it("crosses a century boundary without producing a three-digit label", () => {
    expect(fyLabelFor("2099-05-01")).toBe("2099-00");
  });

  /**
   * 🔴 NEVER `toISOString()` FOR "TODAY". A server in UTC returns
   * YESTERDAY for everybody in India between 00:00 and 05:30 IST, which
   * on 1 April files a cycle in the wrong financial year.
   */
  it("today is an Asia/Kolkata civil date, not a UTC slice", () => {
    expect(todayInIndia()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const midnightUtc = new Date("2026-04-01T00:30:00Z");
    expect(todayInIndia(midnightUtc)).toBe("2026-04-01");
    /** ⚠️ 23:00 UTC on 31 March is already 1 April in India. */
    expect(todayInIndia(new Date("2026-03-31T23:00:00Z"))).toBe("2026-04-01");
    const lib = codeNoStrings(read(APPRAISAL_LIB_PATH));
    expect(lib).not.toContain("toISOString");
  });

  it("picks the reporting line that covered the review period, not today's", () => {
    const lines = [
      { managerId: "old", effectiveFrom: "2024-01-01", endedOn: "2025-07-31" },
      { managerId: "new", effectiveFrom: "2025-08-01", endedOn: null },
    ];
    /** April–September 2025: four months under `old`, two under `new`. */
    expect(lineCoveringPeriod(lines, "2025-04-01", "2025-09-30")?.managerId).toBe("old");
    /** A period entirely after the change picks the new one. */
    expect(lineCoveringPeriod(lines, "2025-09-01", "2026-03-31")?.managerId).toBe("new");
  });

  it("a mid-period joiner with almost no time is not enrolled", () => {
    const cycle = { periodStart: "2025-04-01", periodEnd: "2026-03-31" };
    expect(isEligibleForCycle({ joinedOn: "2026-03-01", leftOn: null }, cycle).eligible).toBe(
      false,
    );
    expect(isEligibleForCycle({ joinedOn: "2020-01-01", leftOn: null }, cycle).eligible).toBe(
      true,
    );
  });

  /**
   * 🔴 A LEAVER WHO WAS THERE FOR MOST OF THE PERIOD IS STILL ENROLLED.
   * Excluding them means the manager's review of the person who actually
   * did the work is never written — the record an exit interview and a
   * rehire decision both need.
   */
  it("somebody who left mid-period is still enrolled", () => {
    const cycle = { periodStart: "2025-04-01", periodEnd: "2026-03-31" };
    expect(
      isEligibleForCycle({ joinedOn: "2020-01-01", leftOn: "2025-12-31" }, cycle).eligible,
    ).toBe(true);
    /** Somebody who left before the period started is not. */
    expect(
      isEligibleForCycle({ joinedOn: "2020-01-01", leftOn: "2025-03-01" }, cycle).eligible,
    ).toBe(false);
  });

  it("the rating scale is ordered by data, never by string comparison", () => {
    expect(RATING_ORDER.indexOf("exceeds")).toBeGreaterThan(RATING_ORDER.indexOf("meets"));
    expect(RATING_ORDER.indexOf("meets")).toBeGreaterThan(
      RATING_ORDER.indexOf("needs_improvement"),
    );
    /** ⚠️ Alphabetically "exceeds" sorts below "meets". That is the trap. */
    expect([...RATING_ORDER].sort()).not.toEqual([...RATING_ORDER]);
  });
});

/* ================================================================== */
/* ⑨ THE REVIEWER SNAPSHOT AND THE ENROLMENT                           */
/* ================================================================== */

describe("the reviewers are snapshotted, not joined at read time", () => {
  it("the subject row carries its own manager and skip-level columns", () => {
    expect(SCHEMA).toContain("managerEmployeeId");
    expect(SCHEMA).toContain("skipLevelEmployeeId");
    expect(SQL).toContain("manager_employee_id");
    expect(SQL).toContain("skip_level_employee_id");
  });

  it("enrolment uses the line covering the period", () => {
    const body = ACTION_CODE.slice(
      ACTION_CODE.indexOf("export async function enrolInAppraisalCycle"),
      ACTION_CODE.indexOf("export type RegisterRow"),
    );
    expect(body).toContain("lineCoveringPeriod");
    expect(body).toContain("cycle.periodStart");
    /** ⚠️ Re-running must not re-snapshot everybody to today's manager. */
    expect(body).toContain("enrolledAlready");
  });

  it("nobody reviews themselves, and the skip-level is not the manager", () => {
    expect(SQL).toContain("appraisal_subjects_reviewer_not_self");
    expect(SCHEMA).toContain("reviewerNotSelf");
  });

  it("a sign-off without a rating is refused by the database", () => {
    expect(SQL).toContain("appraisal_subjects_signed_has_outcome");
    expect(SQL).toContain("appraisal_subjects_release_after_signoff");
  });
});

/* ================================================================== */
/* ⑩ THE SQL FILES ARE THE RIGHT SHAPE                                 */
/* ================================================================== */

describe("0085 matches the house shape", () => {
  it("is one guarded, re-runnable transaction", () => {
    expect(SQL).toContain("BEGIN;");
    expect(SQL.trimEnd()).toContain("COMMIT;");
    expect(SQL).toContain("CREATE TABLE IF NOT EXISTS");
    expect(SQL).toContain("EXCEPTION WHEN duplicate_object THEN NULL");
    expect(SQL).toContain("CREATE OR REPLACE FUNCTION");
    expect(SQL).toContain("DROP TRIGGER IF EXISTS");
  });

  it("says whether it runs before or after the code push", () => {
    expect(SQL).toMatch(/RUN THIS BEFORE PUSHING THE CODE/);
  });

  /**
   * 🔴 RLS ENABLED **AND FORCED** WITH A POLICY ON EVERY NEW TABLE. This
   * application connects as the table owner, and an owner without FORCE
   * bypasses every policy.
   */
  it("every new table has RLS enabled, forced and a tenant policy", () => {
    const tables = [
      "reporting_lines",
      "appraisal_cycles",
      "appraisal_subjects",
      "appraisal_reviews",
      "appraisal_amendments",
    ];
    const rlsBlock = SQL.slice(SQL.indexOf("ROW LEVEL SECURITY"));
    for (const t of tables) {
      expect(rlsBlock, `${t} is not in the RLS loop`).toContain(`'${t}'`);
      expect(SQL, `${t} is not created`).toContain(`CREATE TABLE IF NOT EXISTS ${t}`);
    }
    expect(SQL).toContain("ENABLE ROW LEVEL SECURITY");
    expect(SQL).toContain("FORCE  ROW LEVEL SECURITY");
    expect(SQL).toContain("tenant_id = app_current_tenant_id()");
    /** ⚠️ Platform scope reads across tenants and never writes. */
    expect(SQL).toContain("app_platform_scope()");
    const withCheck = SQL.slice(SQL.indexOf("WITH CHECK"));
    expect(withCheck.slice(0, 120)).not.toContain("app_platform_scope");
  });

  it("every schema table is created by the SQL", () => {
    const schemaTables = [...SCHEMA.matchAll(/pgTable\(\s*\n?\s*"([a-z0-9_]+)"/g)].map(
      (m) => m[1],
    );
    expect(schemaTables.length).toBeGreaterThanOrEqual(5);
    for (const t of schemaTables) {
      expect(SQL, `${t} is in the Drizzle schema but no SQL creates it`).toContain(
        `CREATE TABLE IF NOT EXISTS ${t}`,
      );
    }
  });

  it("does not touch another batch's migration or alter an existing table", () => {
    expect(SQL).not.toContain("ALTER TABLE employees");
    expect(SQL).not.toContain("ALTER TABLE payslips");
    expect(SQL).not.toContain("ALTER TABLE leave_ledger");
    /** ⚠️ 0083 and 0084 belong to other tracks running concurrently. */
    expect(existsSync(join(ROOT, "SQL-FILES/0083_credit_control_and_dunning.sql"))).toBe(true);
  });

  it("the verify file is read-only and safe against Neon", () => {
    const verify = read(VERIFY_PATH);
    for (const banned of [
      "INSERT ",
      "UPDATE ",
      "DELETE ",
      "CREATE TABLE",
      "ALTER TABLE",
      "DROP ",
      "TRUNCATE",
    ]) {
      const withoutComments = verify.replace(/^\s*--.*$/gm, "");
      expect(withoutComments, `VERIFY-0085 contains ${banned}`).not.toContain(banned);
    }
    expect(verify).toContain("SELECT");
  });

  /**
   * 🔴 THE DRILL MUST NEVER RUN AGAINST NEON, AND IT REFUSES BY ITSELF
   * RATHER THAN BY THE FILENAME.
   */
  it("the drill refuses to run on a database that looks real", () => {
    const drill = read(DRILL_PATH);
    expect(drill).toContain("DO NOT RUN THIS IN NEON");
    expect(drill).toContain("current_database() LIKE '%neon%'");
    expect(drill).toContain("REFUSING");
    /** ⚠️ Every break is paired with a write that must still succeed. */
    expect(drill).toContain("POSITIVE 1");
    expect(drill).toContain("NEGATIVE 3");
  });
});

/* ================================================================== */
/* ⑪ EVERY EXPORT ASKS WHO IS CALLING IT                               */
/* ================================================================== */

describe("every public endpoint is guarded", () => {
  const TIER2 = ["requirePermission", "requireAllPermissions", "requireRole", "can("];
  const TIER1 = ["requireTenantContext"];

  it("no export is unguarded", () => {
    const names = [...ACTION_CODE.matchAll(/^export async function ([A-Za-z0-9_]+)/gm)].map(
      (m) => m[1],
    );
    for (const name of names) {
      const start = ACTION_CODE.indexOf(`export async function ${name}`);
      const next = names
        .map((n) => ACTION_CODE.indexOf(`export async function ${n}`))
        .filter((i) => i > start)
        .sort((a, b) => a - b)[0];
      const body = ACTION_CODE.slice(start, next === undefined ? undefined : next);
      const guarded =
        TIER2.some((g) => body.includes(g)) ||
        TIER1.some((g) => body.includes(g)) ||
        body.includes("participantContext(");
      expect(guarded, `${name} asks nothing about its caller`).toBe(true);
    }
  });

  /**
   * ⚠️ THE ONE WRITE WITH NO PERMISSION KEY IS THE PARTICIPANT'S OWN
   * REVIEW, AND ITS GUARD IS ONE HOP AWAY IN THE SAME FILE, WHICH IS
   * ALL `check:guards` WALKS.
   */
  it("the participant gate is a local helper containing a tier-2 check", () => {
    const gate = ACTION_CODE.slice(ACTION_CODE.indexOf("async function participantContext"));
    expect(gate).toContain("requireTenantContext");
    expect(gate).toContain("can(");
    expect(gate).toContain("HR_MANAGE");
  });

  /**
   * 🔴 A WRITE BEHIND A READ KEY IS HOW `exportWorkspace` ENDED UP
   * REACHABLE BY THE READ-ONLY ROLE.
   */
  it("no mutation is gated on a read-shaped key alone", () => {
    for (const fn of [
      "setReportingLine",
      "clearReportingLine",
      "createAppraisalCycle",
      "setAppraisalCycleStatus",
      "enrolInAppraisalCycle",
      "releaseAppraisal",
    ]) {
      const start = ACTION_CODE.indexOf(`export async function ${fn}`);
      expect(start, `${fn} is missing`).toBeGreaterThan(-1);
      const body = ACTION_CODE.slice(start, start + 900);
      expect(body, `${fn} is not behind the manage key`).toContain(
        "requirePermission(HR_MANAGE)",
      );
    }
    for (const fn of ["signOffAppraisal", "amendAppraisalOutcome"]) {
      const start = ACTION_CODE.indexOf(`export async function ${fn}`);
      const body = ACTION_CODE.slice(start, start + 900);
      expect(body, `${fn} is not behind the sign-off key`).toContain(
        "requirePermission(HR_SIGNOFF)",
      );
    }
  });

  /** ⭐ Every tenant-scoped read and write goes through withTenant. */
  it("nothing queries outside withTenant", () => {
    const strayDb = /\bdb\s*\.\s*(select|insert|update|delete)\b/;
    expect(ACTION_CODE).not.toMatch(strayDb);
    const withTenantCalls = [...ACTION_CODE.matchAll(/withTenant\(/g)].length;
    expect(withTenantCalls).toBeGreaterThanOrEqual(10);
  });
});
