"use server";

/**
 * Ordence — ⭐⭐⭐ APPRAISALS AND THE ORG CHART
 * Version: v1.47.0-alpha · Batch 109
 *
 * ⚠️ EVERY EXPORT OF THIS FILE IS A BROWSER-REACHABLE URL, whether or
 * not a screen ever renders a button for it. The guard lives on the
 * function and is visible at the export.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴🔴 THE LESSON FROM BATCH 107, RESTATED BECAUSE IT APPLIES HERE
 *        HARDER THAN IT DID TO PAYSLIPS
 * ══════════════════════════════════════════════════════════════════════
 * RLS in Ordence scopes by TENANT and by nothing else. `withTenant()`
 * sets `app.current_tenant_id`, the policy on `appraisal_subjects`
 * compares `tenant_id = app_current_tenant_id()`, and that is the whole
 * of it. EVERY COLLEAGUE'S APPRAISAL IS IN THE SAME TENANT. The database
 * will hand a junior developer the sales director's rating exactly as
 * cheerfully as it hands them their own, because from the policy's point
 * of view the two rows are the same class.
 *
 * ⚠️ AND A MANAGER IS THE DANGEROUS READER HERE, NOT A STRANGER. They
 * legitimately read appraisals — just not these ones. A query that says
 * "subjects in this cycle" instead of "subjects whose manager is me"
 * returns the whole company, satisfies the policy, type checks, renders
 * a perfectly ordinary screen, and is indistinguishable from correct
 * until somebody notices they can read their own manager's review of
 * their peer.
 *
 * 🔴 SO EVERY LINE-SCOPED READ IN THIS FILE ASKS WHICH ROWS POINT AT ME:
 *
 *      inArray(appraisalSubjects.managerEmployeeId, mine)
 *      inArray(appraisalSubjects.skipLevelEmployeeId, mine)
 *      inArray(appraisalSubjects.employeeId, mine)
 *
 * where `mine` comes from `employees.userId = ctx.user.id` and NEVER
 * from a parameter. `myAppraisals()` takes no arguments at all, for the
 * same reason `myPayslips()` takes none: a function with no parameter
 * cannot be handed somebody else's id by any future edit that does not
 * first change its signature, and a signature change is something a
 * reviewer sees.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE PERMISSION KEYS ARE BORROWED, AND THAT IS REPORTED, NOT HIDDEN
 * ══════════════════════════════════════════════════════════════════════
 * Ordence has no HR key. Batch 109 may not add one — a new key is a
 * change to `db/schema/auth.ts`, which this batch does not own — so the
 * four acts below reuse the closest existing keys and the batch report
 * names the four that should replace them:
 *
 *   `users:read`      → the org chart. "View team members" is what an
 *                       org chart is. WANTED: `hr.orgchart.read`.
 *   `payroll.manage`  → writing a reporting line, running a cycle.
 *                       Already THE key that authorises a write to an
 *                       `employees` row, so it is the honest one today.
 *                       WANTED: `hr.orgchart.manage`, `hr.appraisals.manage`
 *                       — so an HR coordinator can maintain the chart
 *                       without also holding the key that edits salaries.
 *   `payroll.read`    → the whole appraisal register. WANTED:
 *                       `hr.appraisals.read`.
 *   `payroll.approve` → signing off an outcome and amending a signed-off
 *                       one. ⭐ SEPARATE FROM `payroll.manage` ON
 *                       PURPOSE and it is the same argument the payroll
 *                       keys make: the person who runs the cycle and the
 *                       person who signs the verdict must be able to be
 *                       two people. WANTED: `hr.appraisals.signoff`.
 *
 * 🔴 AND ONE ACT HAS NO KEY AT ALL, DELIBERATELY: writing your OWN
 * review. A key would be exactly wrong — the people who need it are the
 * people who hold nothing. The authorisation is that the review row is
 * assigned to you, enforced in the WHERE clause of the update, and the
 * update affecting zero rows is the refusal. See `participantContext`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 NOT WIRED TO PAY. NOTHING HERE TOUCHES MONEY.
 * ══════════════════════════════════════════════════════════════════════
 * No import from `@/server/payroll/**`, `@/lib/payroll/**` or
 * `@/db/schema/payroll` beyond `employees` — the roster. A rating of
 * "outstanding" changes nobody's salary, writes no pay component and
 * appears on no payslip. Somebody opens payroll and types the new
 * figure. Assume nothing else.
 */

import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { withTenant } from "@/db";
import { employees } from "@/db/schema/payroll";
import {
  appraisalAmendments,
  appraisalCycles,
  appraisalReviews,
  appraisalSubjects,
  reportingLines,
  type AppraisalRating,
  type AppraisalReviewKind,
} from "@/db/schema/appraisals";
import { can } from "@/lib/permissions";
import { requirePermission, writeAudit } from "@/server/audit";
import { requireTenantContext } from "@/server/tenant-context";
import { toSalesActionError } from "@/server/sales/guards";
import type { ActionResult } from "@/lib/validators/crm";
import {
  buildOrgChart,
  wouldCreateCycle,
  skipLevelOf,
  chainUp,
  countNodes,
  type OrgChart,
  type OrgPerson,
  type ReportingEdge,
} from "@/lib/hr/hierarchy";
import {
  canReadReview,
  canWriteReview,
  describeWithheld,
  NO_RELATION,
  type ViewerRelation,
} from "@/lib/hr/visibility";
import {
  effectiveOutcome,
  fyLabelFor,
  isEligibleForCycle,
  lineCoveringPeriod,
  todayInIndia,
} from "@/lib/hr/appraisal";

/* ------------------------------------------------------------------ */
/* THE KEYS, NAMED ONCE                                                */
/* ------------------------------------------------------------------ */

/** ⭐ Reading the chart. The least sensitive thing in this file. */
const CHART_READ = "users:read" as const;
/** Writing a reporting line, and running a cycle. */
const HR_MANAGE = "payroll.manage" as const;
/** Reading everybody's appraisal, across every reporting line. */
const HR_READ = "payroll.read" as const;
/** 🔴 Signing off a verdict, and amending one that has been signed. */
const HR_SIGNOFF = "payroll.approve" as const;

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const RATINGS = [
  "unsatisfactory",
  "needs_improvement",
  "meets",
  "exceeds",
  "outstanding",
] as const;

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

/* ------------------------------------------------------------------ */
/* SHARED READS                                                        */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ EVERY CURRENT REPORTING EDGE IN THE TENANT, WHICH IS THE WHOLE
 * GRAPH AND IS DELIBERATELY LOADED IN ONE GO.
 *
 * 🔴 A RECURSIVE CTE WOULD BE THE DATABASE-Y ANSWER AND IT IS THE ONE
 * THAT HANGS. `WITH RECURSIVE` walking a cycle produces rows until the
 * connection dies; the cycle is refused by a trigger, but "refused by a
 * trigger" is a claim about writes that already happened and says
 * nothing about rows that arrived before the trigger existed, or from a
 * restore, or from a support session. Loading the edges and folding them
 * in TypeScript is bounded by construction — see MAX_REPORTING_DEPTH —
 * and an organisation with more reporting lines than fit in memory is
 * not an organisation on this product.
 */
async function currentEdges(tx: Tx, tenantId: string): Promise<ReportingEdge[]> {
  const rows = await tx
    .select({
      employeeId: reportingLines.employeeId,
      managerId: reportingLines.managerId,
    })
    .from(reportingLines)
    .where(and(eq(reportingLines.tenantId, tenantId), isNull(reportingLines.endedOn)));
  return rows;
}

async function roster(tx: Tx, tenantId: string): Promise<OrgPerson[]> {
  const rows = await tx
    .select({
      employeeId: employees.id,
      fullName: employees.fullName,
      employeeCode: employees.employeeCode,
      designation: employees.designation,
      department: employees.department,
      leftOn: employees.leftOn,
    })
    .from(employees)
    .where(eq(employees.tenantId, tenantId))
    .orderBy(asc(employees.fullName));
  return rows;
}

/**
 * 🔴 WHICH EMPLOYEE ROWS POINT AT THE CALLER'S SIGN-IN ACCOUNT.
 *
 * ⚠️ THE DIRECTION IS THE WHOLE CONTROL, and it is the same one
 * `server/actions/payroll-self.ts#myPayslips` turns on. We ask "which
 * employee rows are ME", never "is this employee row mine". The first
 * cannot return somebody else's row. The second is a check, and a check
 * can be bypassed by whoever chooses what is checked.
 *
 * ⭐ RETURNS A LIST, NOT A ROW. `employees.userId` is nullable and not
 * unique: most employees never sign in and a duplicate link is a
 * data-entry fault rather than an impossibility. Every row in the list
 * is still this person by definition of the link, so nothing widens.
 */
async function myEmployeeIds(tx: Tx, tenantId: string, userId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: employees.id })
    .from(employees)
    .where(and(eq(employees.tenantId, tenantId), eq(employees.userId, userId)));
  return rows.map((r) => r.id);
}

/* ------------------------------------------------------------------ */
/* ① THE ORG CHART                                                     */
/* ------------------------------------------------------------------ */

export type OrgChartView = {
  chart: OrgChart;
  people: OrgPerson[];
  /** ⭐ True when this reader may edit a line. Used to hide the form. */
  canManage: boolean;
  headcount: number;
  placed: number;
};

/**
 * ⭐ THE WHOLE CHART, IN ONE READ.
 *
 * ⚠️ THIS IS A READ AND IT STOPS AT ONE KEY BECAUSE THE CHART IS NOT
 * SENSITIVE IN THE WAY PAY IS. Who reports to whom is printed on an
 * induction handout. It is NOT filtered to the reader's own line, and
 * that is deliberate: a chart that shows you only your own branch is a
 * list of your colleagues, and the question people open it to answer —
 * "who do I escalate this to" — is precisely about the branch they are
 * not in.
 */
export async function getOrgChart(): Promise<ActionResult<OrgChartView>> {
  try {
    const ctx = await requirePermission(CHART_READ);

    const view = await withTenant(ctx.tenant.id, async (tx) => {
      const [people, edges] = await Promise.all([
        roster(tx, ctx.tenant.id),
        currentEdges(tx, ctx.tenant.id),
      ]);
      const chart = buildOrgChart(people, edges);
      return {
        chart,
        people,
        canManage: can({ role: ctx.role, overrides: ctx.user.permissionOverrides }, HR_MANAGE),
        headcount: people.length,
        placed: countNodes(chart.roots),
      };
    });

    return { ok: true, data: view };
  } catch (err) {
    return toSalesActionError(err, "org chart");
  }
}

const lineSchema = z.object({
  employeeId: z.string().uuid(),
  managerId: z.string().uuid(),
  effectiveFrom: z.string().regex(ISO).optional(),
  note: z.string().trim().max(500).optional(),
});

/**
 * ⭐⭐⭐ POINT ONE PERSON AT ANOTHER, AND REFUSE THE WRITE THAT CLOSES A
 * LOOP.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 WHERE THE CYCLE IS ENFORCED, AND WHY IT IS ENFORCED TWICE
 * ══════════════════════════════════════════════════════════════════════
 * ① `reporting_lines_no_self` — a CHECK constraint on the table. The
 *    one-hop cycle is refused by the planner on every row.
 * ② `reporting_lines_no_cycle()` — a BEFORE INSERT OR UPDATE trigger in
 *    `SQL-FILES/0085_appraisals_and_org.sql`. It walks up from the
 *    proposed manager through the current lines and raises if it meets
 *    the employee, and raises past a depth of 64. 🔴 THIS IS THE
 *    CONTROL. It is the only one an import, a psql session, a
 *    background job or an action written next year cannot go round.
 * ③ `wouldCreateCycle()`, below, in TypeScript — so the person gets a
 *    sentence naming the two people instead of a 500 carrying
 *    `P0001`. It is a courtesy. If ② and ③ ever disagree, ② is right.
 *
 * ⚠️ AND ③ IS RUN INSIDE THE SAME `withTenant` TRANSACTION AS THE WRITE,
 * against edges read in that transaction. Reading the graph in one
 * request and writing in the next is a check against a graph that no
 * longer exists — which is how two people setting two lines at the same
 * moment produce a loop that neither of them could have seen.
 */
export async function setReportingLine(
  input: unknown,
): Promise<ActionResult<{ id: string; note: string }>> {
  try {
    const ctx = await requirePermission(HR_MANAGE);
    const parsed = lineSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: "Check the form." };
    const d = parsed.data;

    if (d.employeeId === d.managerId) {
      return { ok: false, error: "Somebody cannot report to themselves." };
    }

    const effectiveFrom = d.effectiveFrom ?? todayInIndia();

    const outcome = await withTenant(
      ctx.tenant.id,
      async (tx): Promise<{ error: string } | { id: string; note: string }> => {
        const people = await roster(tx, ctx.tenant.id);
        const byId = new Map(people.map((p) => [p.employeeId, p]));
        const employee = byId.get(d.employeeId);
        const manager = byId.get(d.managerId);
        if (!employee || !manager) {
          /**
           * ⚠️ ONE MESSAGE FOR BOTH. "That employee is not in this
           * workspace" and "that manager is not" differ only in what
           * they confirm to somebody probing uuids.
           */
          return { error: "That person is not on this workspace's roster." };
        }

        const edges = await currentEdges(tx, ctx.tenant.id);
        const loop = wouldCreateCycle(edges, d.employeeId, d.managerId);
        if (loop) {
          const names = loop.map((id) => byId.get(id)?.fullName ?? "someone");
          return {
            error:
              `That would make the reporting line loop: ${names.join(" → ")}. ` +
              `A loop makes the org chart unwalkable and hangs every query that follows it. ` +
              `Move ${manager.fullName} out from under ${employee.fullName} first.`,
          };
        }

        /**
         * ⚠️ THE PREVIOUS LINE IS ENDED, NEVER UPDATED IN PLACE.
         * Overwriting `manager_id` erases the fact that anybody else
         * ever held the line — and that fact is what an appraisal for
         * last quarter is assigned from.
         */
        const [open] = await tx
          .select()
          .from(reportingLines)
          .where(
            and(
              eq(reportingLines.tenantId, ctx.tenant.id),
              eq(reportingLines.employeeId, d.employeeId),
              isNull(reportingLines.endedOn),
            ),
          )
          .limit(1);

        if (open) {
          if (open.managerId === d.managerId) {
            return { error: `${employee.fullName} already reports to ${manager.fullName}.` };
          }
          /**
           * ⚠️ CLAMPED SO THE OLD ROW NEVER ENDS BEFORE IT BEGAN. A
           * correction typed with an effective date earlier than the
           * line it replaces would otherwise violate
           * `reporting_lines_dates_ordered` and surface as a constraint
           * error nobody can act on.
           */
          const dayBefore = shiftDay(effectiveFrom, -1);
          const endedOn = dayBefore < open.effectiveFrom ? open.effectiveFrom : dayBefore;
          await tx
            .update(reportingLines)
            .set({ endedOn })
            .where(
              and(eq(reportingLines.tenantId, ctx.tenant.id), eq(reportingLines.id, open.id)),
            );
        }

        const [row] = await tx
          .insert(reportingLines)
          .values({
            tenantId: ctx.tenant.id,
            employeeId: d.employeeId,
            managerId: d.managerId,
            effectiveFrom,
            note: d.note ?? null,
            createdBy: ctx.user.id,
          })
          .returning({ id: reportingLines.id });

        // ⚠️ A `returning()` that comes back empty is a write that did not
        // happen. Reporting an id we do not have would be worse than the
        // refusal, because the caller would record a link that is not there.
        if (!row) throw new Error("The reporting line was not written. Nothing has been changed.");
        return {
          id: row.id,
          note:
            `${employee.fullName} now reports to ${manager.fullName} from ${effectiveFrom}.` +
            (manager.leftOn
              ? ` ⚠️ ${manager.fullName} left on ${manager.leftOn} — this line is stale the day it is created.`
              : ""),
        };
      },
    );

    if ("error" in outcome) return { ok: false, error: outcome.error };

    await writeAudit(ctx, {
      action: "update",
      resourceType: "reporting_line",
      resourceId: outcome.id,
      newValue: { employeeId: d.employeeId, managerId: d.managerId, effectiveFrom },
    });
    revalidatePath("/hr/org-chart");
    return { ok: true, data: outcome };
  } catch (err) {
    return toSalesActionError(err, "reporting line");
  }
}

const clearSchema = z.object({
  employeeId: z.string().uuid(),
  note: z.string().trim().max(500).optional(),
});

/**
 * ⭐ END A REPORTING LINE WITHOUT REPLACING IT.
 *
 * ⚠️ THE RESULT IS A ROOT, AND THE SCREEN SAYS SO. This is the right
 * action for a managing director and the wrong one for everybody else,
 * so it refuses silently-orphaning anybody who has reports of their own
 * — see below. Ending YOUR line does not move YOUR reports; they still
 * point at you, which is the whole "a leaver must not vanish mid-cycle"
 * decision applied to the ordinary case.
 */
export async function clearReportingLine(
  input: unknown,
): Promise<ActionResult<{ note: string }>> {
  try {
    const ctx = await requirePermission(HR_MANAGE);
    const parsed = clearSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: "Check the form." };
    const d = parsed.data;

    const outcome = await withTenant(
      ctx.tenant.id,
      async (tx): Promise<{ error: string } | { note: string }> => {
        const today = todayInIndia();
        const [open] = await tx
          .select()
          .from(reportingLines)
          .where(
            and(
              eq(reportingLines.tenantId, ctx.tenant.id),
              eq(reportingLines.employeeId, d.employeeId),
              isNull(reportingLines.endedOn),
            ),
          )
          .limit(1);
        if (!open) return { error: "There is no reporting line to end." };

        const endedOn = today < open.effectiveFrom ? open.effectiveFrom : today;
        await tx
          .update(reportingLines)
          .set({ endedOn, note: d.note ?? open.note })
          .where(and(eq(reportingLines.tenantId, ctx.tenant.id), eq(reportingLines.id, open.id)));

        const reports = await tx
          .select({ id: reportingLines.employeeId })
          .from(reportingLines)
          .where(
            and(
              eq(reportingLines.tenantId, ctx.tenant.id),
              eq(reportingLines.managerId, d.employeeId),
              isNull(reportingLines.endedOn),
            ),
          );

        return {
          note:
            `Reporting line ended on ${endedOn}. This person is now a root of the chart.` +
            (reports.length > 0
              ? ` ⚠️ ${reports.length} ${reports.length === 1 ? "person" : "people"} still report to them, and have NOT been moved.`
              : ""),
        };
      },
    );

    if ("error" in outcome) return { ok: false, error: outcome.error };

    await writeAudit(ctx, {
      action: "update",
      resourceType: "reporting_line",
      resourceId: d.employeeId,
      newValue: { cleared: true, note: d.note ?? null },
    });
    revalidatePath("/hr/org-chart");
    return { ok: true, data: outcome };
  } catch (err) {
    return toSalesActionError(err, "reporting line");
  }
}

/* ------------------------------------------------------------------ */
/* ② THE CYCLE                                                         */
/* ------------------------------------------------------------------ */

export type CycleSummary = {
  id: string;
  name: string;
  periodStart: string;
  periodEnd: string;
  fyLabel: string;
  status: string;
  selfReviewDueOn: string | null;
  managerReviewDueOn: string | null;
  enrolled: number;
  signedOff: number;
};

export async function listAppraisalCycles(): Promise<ActionResult<CycleSummary[]>> {
  try {
    const ctx = await requirePermission(HR_READ);

    const rows = await withTenant(ctx.tenant.id, async (tx) => {
      const cycles = await tx
        .select()
        .from(appraisalCycles)
        .where(eq(appraisalCycles.tenantId, ctx.tenant.id))
        .orderBy(desc(appraisalCycles.periodEnd));

      const counts = await tx
        .select({
          cycleId: appraisalSubjects.cycleId,
          enrolled: sql<number>`count(*)::int`,
          signedOff: sql<number>`count(*) FILTER (WHERE ${appraisalSubjects.signedOffAt} IS NOT NULL)::int`,
        })
        .from(appraisalSubjects)
        .where(eq(appraisalSubjects.tenantId, ctx.tenant.id))
        .groupBy(appraisalSubjects.cycleId);
      const byCycle = new Map(counts.map((c) => [c.cycleId, c]));

      return cycles.map((c) => ({
        id: c.id,
        name: c.name,
        periodStart: c.periodStart,
        periodEnd: c.periodEnd,
        fyLabel: c.fyLabel,
        status: c.status,
        selfReviewDueOn: c.selfReviewDueOn,
        managerReviewDueOn: c.managerReviewDueOn,
        enrolled: byCycle.get(c.id)?.enrolled ?? 0,
        signedOff: byCycle.get(c.id)?.signedOff ?? 0,
      }));
    });

    return { ok: true, data: rows };
  } catch (err) {
    return toSalesActionError(err, "appraisal cycles");
  }
}

const cycleSchema = z.object({
  name: z.string().trim().min(2).max(120),
  periodStart: z.string().regex(ISO),
  periodEnd: z.string().regex(ISO),
  selfReviewDueOn: z.string().regex(ISO).optional(),
  managerReviewDueOn: z.string().regex(ISO).optional(),
});

export async function createAppraisalCycle(
  input: unknown,
): Promise<ActionResult<{ id: string; fyLabel: string }>> {
  try {
    const ctx = await requirePermission(HR_MANAGE);
    const parsed = cycleSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: "Check the form." };
    const d = parsed.data;

    if (d.periodEnd <= d.periodStart) {
      return { ok: false, error: "The review period must end after it starts." };
    }

    /**
     * ⭐ THE FINANCIAL YEAR IS DERIVED, IN ASIA/KOLKATA CIVIL DATES,
     * FROM THE END OF THE PERIOD. 1 April to 31 March; a period ending
     * in January belongs to the year that started the previous April.
     * `fyLabelFor` is the one place that arithmetic lives.
     */
    const fyLabel = fyLabelFor(d.periodEnd);

    const id = await withTenant(ctx.tenant.id, async (tx) => {
      const [row] = await tx
        .insert(appraisalCycles)
        .values({
          tenantId: ctx.tenant.id,
          name: d.name,
          periodStart: d.periodStart,
          periodEnd: d.periodEnd,
          fyLabel,
          selfReviewDueOn: d.selfReviewDueOn ?? null,
          managerReviewDueOn: d.managerReviewDueOn ?? null,
          createdBy: ctx.user.id,
        })
        .returning({ id: appraisalCycles.id });
      // ⚠️ Same rule as the reporting line: no row back means no cycle was
      // created, and a caller told otherwise will open a cycle that is not there.
      if (!row) throw new Error("The appraisal cycle was not created. Nothing has been changed.");
      return row.id;
    });

    await writeAudit(ctx, {
      action: "create",
      resourceType: "appraisal_cycle",
      resourceId: id,
      newValue: { name: d.name, periodStart: d.periodStart, periodEnd: d.periodEnd, fyLabel },
    });
    revalidatePath("/hr/appraisals");
    return { ok: true, data: { id, fyLabel } };
  } catch (err) {
    return toSalesActionError(err, "appraisal cycle");
  }
}

const statusSchema = z.object({
  cycleId: z.string().uuid(),
  status: z.enum(["draft", "open", "closed", "cancelled"]),
});

/**
 * ⚠️ `closed` AND `cancelled` ARE NOT THE SAME AND NEITHER DELETES
 * ANYTHING. A closed cycle happened and its outcomes stand. A cancelled
 * cycle is one somebody abandoned and its outcomes must not be quoted —
 * but the rows stay, because deleting appraisals because they became
 * inconvenient is the single worst-looking thing in an employment file.
 */
export async function setAppraisalCycleStatus(
  input: unknown,
): Promise<ActionResult<{ status: string }>> {
  try {
    const ctx = await requirePermission(HR_MANAGE);
    const parsed = statusSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: "Check the form." };
    const d = parsed.data;

    const outcome = await withTenant(
      ctx.tenant.id,
      async (tx): Promise<{ error: string } | { status: string }> => {
        const [cycle] = await tx
          .select()
          .from(appraisalCycles)
          .where(
            and(eq(appraisalCycles.tenantId, ctx.tenant.id), eq(appraisalCycles.id, d.cycleId)),
          )
          .limit(1);
        if (!cycle) return { error: "That cycle is not in this workspace." };
        if (cycle.status === "closed" && d.status !== "closed") {
          return { error: "A closed cycle cannot be reopened. Run a new cycle instead." };
        }
        await tx
          .update(appraisalCycles)
          .set({ status: d.status, updatedAt: new Date() })
          .where(
            and(eq(appraisalCycles.tenantId, ctx.tenant.id), eq(appraisalCycles.id, d.cycleId)),
          );
        return { status: d.status };
      },
    );

    if ("error" in outcome) return { ok: false, error: outcome.error };

    await writeAudit(ctx, {
      action: "update",
      resourceType: "appraisal_cycle",
      resourceId: d.cycleId,
      newValue: { status: d.status },
    });
    revalidatePath("/hr/appraisals");
    return { ok: true, data: outcome };
  } catch (err) {
    return toSalesActionError(err, "appraisal cycle");
  }
}

const enrolSchema = z.object({
  cycleId: z.string().uuid(),
  /** Omitted means "everybody eligible". */
  employeeIds: z.array(z.string().uuid()).max(2000).optional(),
});

/**
 * ⭐⭐ ENROL PEOPLE, SNAPSHOTTING WHO REVIEWS THEM.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE REVIEWERS ARE COPIED ONTO THE SUBJECT ROW HERE AND NEVER
 *    LOOKED UP AGAIN
 * ══════════════════════════════════════════════════════════════════════
 * `lineCoveringPeriod()` picks the reporting line that covered the
 * REVIEW PERIOD, not today's. A cycle covering April to September,
 * enrolled in October after a reorganisation, is reviewed by whoever
 * managed the person in April — because a review written by somebody
 * who has never worked with them will be written anyway, and it will
 * look exactly like a real one forever.
 *
 * ⚠️ AND THE SNAPSHOT IS WHY A REORGANISATION MID-CYCLE IS SAFE. Change
 * a line tomorrow and forty live appraisals do not silently change
 * hands, half-written reviews do not vanish, and nobody is told they
 * now owe four reviews they have never seen.
 *
 * ⭐ RE-RUNNING IS SAFE. Already-enrolled people are skipped rather than
 * re-snapshotted, so pressing the button twice does not quietly reassign
 * everybody to today's manager — which would undo the entire paragraph
 * above with one convenience.
 */
export async function enrolInAppraisalCycle(
  input: unknown,
): Promise<ActionResult<{ enrolled: number; skipped: string[]; note: string }>> {
  try {
    const ctx = await requirePermission(HR_MANAGE);
    const parsed = enrolSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: "Check the form." };
    const d = parsed.data;

    const outcome = await withTenant(
      ctx.tenant.id,
      async (
        tx,
      ): Promise<
        { error: string } | { enrolled: number; skipped: string[]; note: string }
      > => {
        const [cycle] = await tx
          .select()
          .from(appraisalCycles)
          .where(
            and(eq(appraisalCycles.tenantId, ctx.tenant.id), eq(appraisalCycles.id, d.cycleId)),
          )
          .limit(1);
        if (!cycle) return { error: "That cycle is not in this workspace." };
        if (cycle.status === "closed" || cycle.status === "cancelled") {
          return { error: "That cycle is finished. Nobody else can be enrolled in it." };
        }

        const staff = await tx
          .select({
            id: employees.id,
            fullName: employees.fullName,
            joinedOn: employees.joinedOn,
            leftOn: employees.leftOn,
          })
          .from(employees)
          .where(eq(employees.tenantId, ctx.tenant.id));

        const wanted = d.employeeIds
          ? staff.filter((s) => d.employeeIds!.includes(s.id))
          : staff;

        const already = await tx
          .select({ employeeId: appraisalSubjects.employeeId })
          .from(appraisalSubjects)
          .where(
            and(
              eq(appraisalSubjects.tenantId, ctx.tenant.id),
              eq(appraisalSubjects.cycleId, d.cycleId),
            ),
          );
        const enrolledAlready = new Set(already.map((a) => a.employeeId));

        /** Every line ever, so the historical one can be found. */
        const allLines = await tx
          .select({
            employeeId: reportingLines.employeeId,
            managerId: reportingLines.managerId,
            effectiveFrom: reportingLines.effectiveFrom,
            endedOn: reportingLines.endedOn,
          })
          .from(reportingLines)
          .where(eq(reportingLines.tenantId, ctx.tenant.id));

        const linesFor = new Map<string, typeof allLines>();
        for (const line of allLines) {
          const list = linesFor.get(line.employeeId);
          if (list) list.push(line);
          else linesFor.set(line.employeeId, [line]);
        }

        /**
         * ⚠️ THE SKIP-LEVEL IS COMPUTED FROM THE LINES IN FORCE OVER THE
         * PERIOD, not from today's chart, for the same reason as the
         * manager. `skipLevelOf` returns null near the top of a small
         * company, which is normal and is stated on screen rather than
         * rendered as a box that never fills.
         */
        const periodEdges: ReportingEdge[] = [];
        for (const [employeeId, lines] of linesFor) {
          const picked = lineCoveringPeriod(lines, cycle.periodStart, cycle.periodEnd);
          if (picked) periodEdges.push({ employeeId, managerId: picked.managerId });
        }

        const skipped: string[] = [];
        const rows: Array<typeof appraisalSubjects.$inferInsert> = [];

        for (const person of wanted) {
          if (enrolledAlready.has(person.id)) continue;
          const eligible = isEligibleForCycle(
            { joinedOn: person.joinedOn, leftOn: person.leftOn },
            { periodStart: cycle.periodStart, periodEnd: cycle.periodEnd },
          );
          if (!eligible.eligible) {
            skipped.push(`${person.fullName}: ${eligible.reason}`);
            continue;
          }
          const managerId =
            periodEdges.find((e) => e.employeeId === person.id)?.managerId ?? null;
          const skipLevel = skipLevelOf(periodEdges, person.id);
          rows.push({
            tenantId: ctx.tenant.id,
            cycleId: d.cycleId,
            employeeId: person.id,
            managerEmployeeId: managerId,
            /**
             * ⚠️ A SKIP-LEVEL EQUAL TO THE MANAGER OR TO THE SUBJECT IS
             * REFUSED BY `appraisal_subjects_reviewer_not_self`. Sending
             * null instead of a constraint violation keeps a broken
             * chart from failing an enrolment of two hundred people.
             */
            skipLevelEmployeeId:
              skipLevel && skipLevel !== managerId && skipLevel !== person.id ? skipLevel : null,
            createdBy: ctx.user.id,
          });
        }

        if (rows.length > 0) {
          await tx.insert(appraisalSubjects).values(rows);
        }

        return {
          enrolled: rows.length,
          skipped,
          note:
            rows.length === 0
              ? "Nobody new was enrolled."
              : `${rows.length} enrolled. Reviewers were taken from the reporting lines in force between ${cycle.periodStart} and ${cycle.periodEnd}, and are now fixed for this cycle.`,
        };
      },
    );

    if ("error" in outcome) return { ok: false, error: outcome.error };

    await writeAudit(ctx, {
      action: "create",
      resourceType: "appraisal_subject",
      resourceId: d.cycleId,
      newValue: { enrolled: outcome.enrolled, skipped: outcome.skipped.length },
    });
    revalidatePath("/hr/appraisals");
    return { ok: true, data: outcome };
  } catch (err) {
    return toSalesActionError(err, "appraisal enrolment");
  }
}

/* ------------------------------------------------------------------ */
/* ③ THE REGISTER — HR'S VIEW OF ONE CYCLE                             */
/* ------------------------------------------------------------------ */

export type RegisterRow = {
  subjectId: string;
  employeeName: string;
  employeeCode: string;
  department: string | null;
  managerName: string | null;
  skipLevelName: string | null;
  status: string;
  /** ⭐ The EFFECTIVE outcome: the latest amendment, or the original. */
  rating: AppraisalRating | null;
  summary: string | null;
  amended: boolean;
  amendmentCount: number;
  signedOffAt: string | null;
  releasedAt: string | null;
  reviewsSubmitted: AppraisalReviewKind[];
};

export type CycleRegister = {
  cycle: CycleSummary;
  rows: RegisterRow[];
  canSignOff: boolean;
  canManage: boolean;
};

/**
 * ⚠️ THE ONE READ IN THIS FILE THAT CROSSES EVERY REPORTING LINE, AND
 * THE ONLY ONE GUARDED BY A KEY RATHER THAN BY A RELATIONSHIP.
 *
 * 🔴 IT IS A SEPARATE ENDPOINT FROM `myAppraisals()` ON PURPOSE AND MUST
 * STAY ONE. An endpoint that widens for a privileged caller puts "the
 * whole company" and "only my line" one boolean apart, and that boolean
 * is computed from a role that an impersonation session, a permission
 * override or a seeded fixture can flip. Two endpoints cannot leak into
 * each other. Same argument `payroll-self.ts` makes at length.
 */
export async function getAppraisalRegister(input: unknown): Promise<ActionResult<CycleRegister>> {
  try {
    const ctx = await requirePermission(HR_READ);
    const parsed = z.object({ cycleId: z.string().uuid() }).safeParse(input);
    if (!parsed.success) return { ok: false, error: "Check the form." };
    const cycleId = parsed.data.cycleId;

    const outcome = await withTenant(
      ctx.tenant.id,
      async (tx): Promise<{ error: string } | CycleRegister> => {
        const [cycle] = await tx
          .select()
          .from(appraisalCycles)
          .where(and(eq(appraisalCycles.tenantId, ctx.tenant.id), eq(appraisalCycles.id, cycleId)))
          .limit(1);
        if (!cycle) return { error: "That cycle is not in this workspace." };

        const subjects = await tx
          .select()
          .from(appraisalSubjects)
          .where(
            and(
              eq(appraisalSubjects.tenantId, ctx.tenant.id),
              eq(appraisalSubjects.cycleId, cycleId),
            ),
          );

        const people = await roster(tx, ctx.tenant.id);
        const byId = new Map(people.map((p) => [p.employeeId, p]));

        const subjectIds = subjects.map((s) => s.id);
        const amendments = subjectIds.length
          ? await tx
              .select()
              .from(appraisalAmendments)
              .where(
                and(
                  eq(appraisalAmendments.tenantId, ctx.tenant.id),
                  inArray(appraisalAmendments.subjectId, subjectIds),
                ),
              )
          : [];
        const reviews = subjectIds.length
          ? await tx
              .select({
                subjectId: appraisalReviews.subjectId,
                kind: appraisalReviews.kind,
                submittedAt: appraisalReviews.submittedAt,
              })
              .from(appraisalReviews)
              .where(
                and(
                  eq(appraisalReviews.tenantId, ctx.tenant.id),
                  inArray(appraisalReviews.subjectId, subjectIds),
                ),
              )
          : [];

        const rows: RegisterRow[] = subjects
          .map((s) => {
            const outcomeNow = effectiveOutcome({
              originalRating: s.outcomeRating,
              originalSummary: s.outcomeSummary,
              amendments: amendments
                .filter((a) => a.subjectId === s.id)
                .map((a) => ({
                  newRating: a.newRating,
                  newSummary: a.newSummary,
                  amendedAt: a.amendedAt,
                })),
            });
            return {
              subjectId: s.id,
              employeeName: byId.get(s.employeeId)?.fullName ?? "—",
              employeeCode: byId.get(s.employeeId)?.employeeCode ?? "",
              department: byId.get(s.employeeId)?.department ?? null,
              managerName: s.managerEmployeeId
                ? (byId.get(s.managerEmployeeId)?.fullName ?? "—")
                : null,
              skipLevelName: s.skipLevelEmployeeId
                ? (byId.get(s.skipLevelEmployeeId)?.fullName ?? "—")
                : null,
              status: s.status,
              rating: outcomeNow.rating,
              summary: outcomeNow.summary,
              amended: outcomeNow.amended,
              amendmentCount: outcomeNow.amendmentCount,
              signedOffAt: s.signedOffAt ? s.signedOffAt.toISOString() : null,
              releasedAt: s.releasedAt ? s.releasedAt.toISOString() : null,
              reviewsSubmitted: reviews
                .filter((r) => r.subjectId === s.id && r.submittedAt !== null)
                .map((r) => r.kind),
            };
          })
          .sort((a, b) => a.employeeName.localeCompare(b.employeeName));

        return {
          cycle: {
            id: cycle.id,
            name: cycle.name,
            periodStart: cycle.periodStart,
            periodEnd: cycle.periodEnd,
            fyLabel: cycle.fyLabel,
            status: cycle.status,
            selfReviewDueOn: cycle.selfReviewDueOn,
            managerReviewDueOn: cycle.managerReviewDueOn,
            enrolled: subjects.length,
            signedOff: subjects.filter((s) => s.signedOffAt !== null).length,
          },
          rows,
          canSignOff: can(
            { role: ctx.role, overrides: ctx.user.permissionOverrides },
            HR_SIGNOFF,
          ),
          canManage: can({ role: ctx.role, overrides: ctx.user.permissionOverrides }, HR_MANAGE),
        };
      },
    );

    if ("error" in outcome) return { ok: false, error: outcome.error };
    return { ok: true, data: outcome };
  } catch (err) {
    return toSalesActionError(err, "appraisal register");
  }
}

/* ------------------------------------------------------------------ */
/* ④ SIGN-OFF, RELEASE AND AMENDMENT                                   */
/* ------------------------------------------------------------------ */

const signOffSchema = z.object({
  subjectId: z.string().uuid(),
  rating: z.enum(RATINGS),
  summary: z.string().trim().min(1).max(4000),
});

/**
 * ⭐⭐ THE VERDICT, AND THE MOMENT IT STOPS BEING EDITABLE.
 *
 * 🔴 AFTER THIS, `outcome_rating` AND `outcome_summary` ARE FROZEN BY
 * THE `appraisal_subjects_frozen_after_signoff` TRIGGER IN 0085. Not by
 * this function — by the database, so a second action, an import or a
 * psql session cannot quietly rewrite what somebody's performance was
 * recorded as. A correction is `amendAppraisalOutcome`, which appends.
 *
 * ⚠️ GUARDED BY `payroll.approve` AND NOT `payroll.manage`, and the
 * split is the same one payroll makes: the person who runs the cycle and
 * chases the reviews must be able to be a different person from the one
 * who signs the verdict. Folding them means whoever assembles the
 * evidence also decides the outcome.
 */
export async function signOffAppraisal(input: unknown): Promise<ActionResult<{ note: string }>> {
  try {
    const ctx = await requirePermission(HR_SIGNOFF);
    const parsed = signOffSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: "Check the form." };
    const d = parsed.data;

    const outcome = await withTenant(
      ctx.tenant.id,
      async (tx): Promise<{ error: string } | { note: string }> => {
        const [subject] = await tx
          .select()
          .from(appraisalSubjects)
          .where(
            and(
              eq(appraisalSubjects.tenantId, ctx.tenant.id),
              eq(appraisalSubjects.id, d.subjectId),
            ),
          )
          .limit(1);
        if (!subject) return { error: "That appraisal is not in this workspace." };
        if (subject.signedOffAt) {
          return {
            error:
              "This outcome is already signed off and cannot be edited. Record a correction as an amendment instead — it keeps the original, the actor and the reason.",
          };
        }

        await tx
          .update(appraisalSubjects)
          .set({
            outcomeRating: d.rating,
            outcomeSummary: d.summary,
            status: "signed_off",
            signedOffAt: new Date(),
            signedOffBy: ctx.user.id,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(appraisalSubjects.tenantId, ctx.tenant.id),
              eq(appraisalSubjects.id, d.subjectId),
              /**
               * ⚠️ THE PREDICATE IS REPEATED IN THE WHERE CLAUSE RATHER
               * THAN TRUSTED FROM THE READ ABOVE. Between the SELECT and
               * the UPDATE somebody else may have signed it off, and
               * "check then write" is a race with an audit trail.
               */
              isNull(appraisalSubjects.signedOffAt),
            ),
          );

        return {
          note:
            "Signed off. The outcome is now evidence: it cannot be edited, and a correction is recorded as an amendment with a reason. It is NOT yet visible to the employee — release it when the conversation has happened.",
        };
      },
    );

    if ("error" in outcome) return { ok: false, error: outcome.error };

    await writeAudit(ctx, {
      action: "update",
      resourceType: "appraisal_subject",
      resourceId: d.subjectId,
      newValue: { signedOff: true, rating: d.rating },
      severity: "notice",
    });
    revalidatePath("/hr/appraisals");
    return { ok: true, data: outcome };
  } catch (err) {
    return toSalesActionError(err, "appraisal sign-off");
  }
}

/**
 * ⭐ RELEASE: the moment the subject may read the manager's review.
 *
 * ⚠️ SEPARATE FROM SIGN-OFF, DAYS APART IN PRACTICE, AND THE GAP IS THE
 * CONVERSATION. An employee who reads "needs improvement" at 11pm before
 * anybody has spoken to them is the specific harm this step prevents.
 */
export async function releaseAppraisal(input: unknown): Promise<ActionResult<{ note: string }>> {
  try {
    const ctx = await requirePermission(HR_MANAGE);
    const parsed = z.object({ subjectId: z.string().uuid() }).safeParse(input);
    if (!parsed.success) return { ok: false, error: "Check the form." };
    const subjectId = parsed.data.subjectId;

    const outcome = await withTenant(
      ctx.tenant.id,
      async (tx): Promise<{ error: string } | { note: string }> => {
        const [subject] = await tx
          .select()
          .from(appraisalSubjects)
          .where(
            and(
              eq(appraisalSubjects.tenantId, ctx.tenant.id),
              eq(appraisalSubjects.id, subjectId),
            ),
          )
          .limit(1);
        if (!subject) return { error: "That appraisal is not in this workspace." };
        if (!subject.signedOffAt) {
          return { error: "Nothing is released to an employee before it is signed off." };
        }
        if (subject.releasedAt) return { error: "Already released." };

        await tx
          .update(appraisalSubjects)
          .set({ releasedAt: new Date(), status: "released", updatedAt: new Date() })
          .where(
            and(
              eq(appraisalSubjects.tenantId, ctx.tenant.id),
              eq(appraisalSubjects.id, subjectId),
            ),
          );
        return {
          note: "Released. The employee can now read the manager's review and the outcome. The skip-level review stays hidden from them and from their manager.",
        };
      },
    );

    if ("error" in outcome) return { ok: false, error: outcome.error };

    await writeAudit(ctx, {
      action: "update",
      resourceType: "appraisal_subject",
      resourceId: subjectId,
      newValue: { released: true },
    });
    revalidatePath("/hr/appraisals");
    return { ok: true, data: outcome };
  } catch (err) {
    return toSalesActionError(err, "appraisal release");
  }
}

const amendSchema = z.object({
  subjectId: z.string().uuid(),
  rating: z.enum(RATINGS),
  summary: z.string().trim().max(4000).optional(),
  /**
   * 🔴 THE REASON, AND THE FLOOR IS ENFORCED BY THE DATABASE TOO
   * (`appraisal_amendments_reason_meant`). "typo" is not a reason to
   * change what somebody's performance was recorded as.
   */
  reason: z.string().trim().min(20).max(2000),
});

/**
 * ⭐⭐⭐ THE ONLY WAY A SIGNED-OFF OUTCOME CHANGES.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 IS AN APPRAISAL OUTCOME EDITABLE AFTER SIGN-OFF? NO — AND YES,
 *    WHICH IS WHY IT IS WORTH SPELLING OUT
 * ══════════════════════════════════════════════════════════════════════
 * The ROW is not editable. It is frozen by trigger, and nothing in this
 * codebase can UPDATE it — not this file, not an import, not a support
 * session.
 *
 * The EFFECTIVE outcome can be changed, by a holder of `payroll.approve`
 * (the sign-off key, not the everyday HR key), by APPENDING an amendment
 * that records the previous rating, the new rating, the actor, the
 * timestamp and a reason of at least twenty characters. Every amendment
 * is visible on the register, forever, and the original is still there.
 *
 * ⚠️ THE ALTERNATIVE — "signed off means never changes" — SOUNDS
 * STRONGER AND IS WEAKER IN PRACTICE. A genuine mistake then gets fixed
 * in a spreadsheet outside the product, and the register everybody
 * quotes becomes the one nobody maintains.
 *
 * 🔴 AND TO BE PLAIN ABOUT THE MONEY: this does not touch pay. Nothing
 * in payroll reads any appraisal table. Amending a rating from "meets"
 * to "exceeds" changes NO salary, NO arrears and NO payslip. If somebody
 * is owed an increment, somebody types it into payroll.
 */
export async function amendAppraisalOutcome(
  input: unknown,
): Promise<ActionResult<{ note: string }>> {
  try {
    const ctx = await requirePermission(HR_SIGNOFF);
    const parsed = amendSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error:
          "An amendment needs a reason of at least twenty characters. It is the only record of why the outcome changed.",
      };
    }
    const d = parsed.data;

    const outcome = await withTenant(
      ctx.tenant.id,
      async (tx): Promise<{ error: string } | { note: string }> => {
        const [subject] = await tx
          .select()
          .from(appraisalSubjects)
          .where(
            and(
              eq(appraisalSubjects.tenantId, ctx.tenant.id),
              eq(appraisalSubjects.id, d.subjectId),
            ),
          )
          .limit(1);
        if (!subject) return { error: "That appraisal is not in this workspace." };
        if (!subject.signedOffAt || !subject.outcomeRating) {
          return {
            error:
              "Nothing to amend — this appraisal has not been signed off. Sign it off with the right outcome instead.",
          };
        }

        const priorAmendments = await tx
          .select()
          .from(appraisalAmendments)
          .where(
            and(
              eq(appraisalAmendments.tenantId, ctx.tenant.id),
              eq(appraisalAmendments.subjectId, d.subjectId),
            ),
          );

        /**
         * ⚠️ THE "PREVIOUS" IS THE EFFECTIVE OUTCOME, NOT THE ORIGINAL
         * COLUMN. On a second amendment the original is two corrections
         * old, and recording it as what was superseded would make the
         * chain read as if the first correction never happened.
         */
        const current = effectiveOutcome({
          originalRating: subject.outcomeRating,
          originalSummary: subject.outcomeSummary,
          amendments: priorAmendments.map((a) => ({
            newRating: a.newRating,
            newSummary: a.newSummary,
            amendedAt: a.amendedAt,
          })),
        });

        const newSummary = d.summary ?? current.summary;
        if (current.rating === d.rating && (newSummary ?? null) === (current.summary ?? null)) {
          return { error: "That amendment changes nothing." };
        }

        const mine = await myEmployeeIds(tx, ctx.tenant.id, ctx.user.id);

        await tx.insert(appraisalAmendments).values({
          tenantId: ctx.tenant.id,
          subjectId: d.subjectId,
          previousRating: current.rating!,
          newRating: d.rating,
          previousSummary: current.summary,
          newSummary: newSummary ?? null,
          amendedBy: ctx.user.id,
          amendedByEmployeeId: mine[0] ?? null,
          reason: d.reason,
        });

        return {
          note: "Amendment recorded. The original outcome is unchanged and both are on the register, with who changed it and why.",
        };
      },
    );

    if ("error" in outcome) return { ok: false, error: outcome.error };

    await writeAudit(ctx, {
      action: "update",
      resourceType: "appraisal_amendment",
      resourceId: d.subjectId,
      newValue: { rating: d.rating },
      reason: d.reason,
      severity: "notice",
    });
    revalidatePath("/hr/appraisals");
    return { ok: true, data: outcome };
  } catch (err) {
    return toSalesActionError(err, "appraisal amendment");
  }
}

/* ------------------------------------------------------------------ */
/* ⑤ THE PARTICIPANT — MY OWN APPRAISALS, AND MY LINE'S                */
/* ------------------------------------------------------------------ */

export type ReviewView = {
  kind: AppraisalReviewKind;
  reviewerName: string;
  rating: AppraisalRating | null;
  strengths: string | null;
  improvements: string | null;
  submittedAt: string | null;
  /** ⚠️ Set when the reader may know it exists but not read it. */
  withheld: string | null;
};

export type ParticipantSubject = {
  subjectId: string;
  cycleName: string;
  periodStart: string;
  periodEnd: string;
  fyLabel: string;
  cycleStatus: string;
  employeeName: string;
  managerName: string | null;
  status: string;
  /** ⭐ Null until released, even when signed off. */
  rating: AppraisalRating | null;
  summary: string | null;
  amended: boolean;
  releasedAt: string | null;
  relation: ViewerRelation;
  /** Which kind, if any, THIS reader is expected to write. */
  myReviewKind: AppraisalReviewKind | null;
  myReviewSubmitted: boolean;
  reviews: ReviewView[];
};

export type MyAppraisalsView = {
  /** False when no `employees` row points at this sign-in account. */
  linked: boolean;
  /** ⚠️ More than one employee row linked to one account. A data fault. */
  duplicateLink: boolean;
  aboutMe: ParticipantSubject[];
  /** ⭐ The people I review. Scoped by which rows point at me. */
  myLine: ParticipantSubject[];
  /** True when this reader also holds the HR key. Reported, never acted on. */
  canSeeEveryone: boolean;
  /** My own chain to the top, for context. Names only. */
  myChain: string[];
};

/**
 * ⚠️ TIER 1 ON PURPOSE, AND THE IDENTITY IS THE AUTHORISATION.
 *
 * There is no key an ordinary employee holds that could gate this, and
 * inventing one would gate it on something an administrator could grant
 * to the wrong person. What limits it is that every query below asks
 * WHICH ROWS POINT AT ME, and `mine` comes from
 * `employees.userId = ctx.user.id`.
 *
 * 🔴 AND IT TAKES NO ARGUMENTS. Not a subject id, not an employee id,
 * not a filter. A function with no parameter cannot be handed somebody
 * else's id by a future edit that does not first change its signature.
 */
export async function myAppraisals(): Promise<ActionResult<MyAppraisalsView>> {
  try {
    const ctx = await requireTenantContext();

    const view = await withTenant(ctx.tenant.id, async (tx): Promise<MyAppraisalsView> => {
      const isHr = can({ role: ctx.role, overrides: ctx.user.permissionOverrides }, HR_READ);
      const mine = await myEmployeeIds(tx, ctx.tenant.id, ctx.user.id);

      if (mine.length === 0) {
        return {
          linked: false,
          duplicateLink: false,
          aboutMe: [],
          myLine: [],
          canSeeEveryone: isHr,
          myChain: [],
        };
      }

      /**
       * 🔴🔴 THE THREE PREDICATES THAT ARE THE WHOLE AUTHORISATION.
       *
       * ⚠️ IF ANY ONE OF THESE `inArray(..., mine)` CLAUSES IS DROPPED,
       * WEAKENED OR MOVED OUTSIDE THE `and(...)`, THIS ENDPOINT
       * PUBLISHES EVERY APPRAISAL IN THE COMPANY TO ANYBODY WHO CAN SIGN
       * IN. It type checks. It renders. RLS stays satisfied, because
       * every one of those rows is in this tenant. There is no test a
       * database can run against itself to notice.
       */
      const subjects = await tx
        .select()
        .from(appraisalSubjects)
        .where(
          and(
            eq(appraisalSubjects.tenantId, ctx.tenant.id),
            or(
              inArray(appraisalSubjects.employeeId, mine),
              inArray(appraisalSubjects.managerEmployeeId, mine),
              inArray(appraisalSubjects.skipLevelEmployeeId, mine),
            ),
          ),
        );

      const people = await roster(tx, ctx.tenant.id);
      const byId = new Map(people.map((p) => [p.employeeId, p]));
      const edges = await currentEdges(tx, ctx.tenant.id);
      // ⚠️ `mine` is non-empty by the guard above; the index expression
      // cannot know that under `noUncheckedIndexedAccess`.
      const myPrimaryId = mine[0];
      const myChain = myPrimaryId
        ? chainUp(edges, myPrimaryId).map((id) => byId.get(id)?.fullName ?? "—")
        : [];

      const subjectIds = subjects.map((s) => s.id);
      const cycleIds = [...new Set(subjects.map((s) => s.cycleId))];

      const cycles = cycleIds.length
        ? await tx
            .select()
            .from(appraisalCycles)
            .where(
              and(
                eq(appraisalCycles.tenantId, ctx.tenant.id),
                inArray(appraisalCycles.id, cycleIds),
              ),
            )
        : [];
      const cycleById = new Map(cycles.map((c) => [c.id, c]));

      /**
       * ⚠️ REVIEWS ARE FETCHED ONLY FOR SUBJECTS THIS READER ALREADY
       * PASSED THE PREDICATE ABOVE FOR, and are then filtered AGAIN by
       * `canReadReview`. Two narrowings, because the second one is about
       * a different question: the first says which appraisals concern
       * you, the second says which parts of one you may read.
       */
      const reviews = subjectIds.length
        ? await tx
            .select()
            .from(appraisalReviews)
            .where(
              and(
                eq(appraisalReviews.tenantId, ctx.tenant.id),
                inArray(appraisalReviews.subjectId, subjectIds),
              ),
            )
        : [];

      const amendments = subjectIds.length
        ? await tx
            .select()
            .from(appraisalAmendments)
            .where(
              and(
                eq(appraisalAmendments.tenantId, ctx.tenant.id),
                inArray(appraisalAmendments.subjectId, subjectIds),
              ),
            )
        : [];

      const shape = (s: (typeof subjects)[number]): ParticipantSubject => {
        const cycle = cycleById.get(s.cycleId);
        const relation: ViewerRelation = {
          ...NO_RELATION,
          isSubject: mine.includes(s.employeeId),
          isManager: s.managerEmployeeId !== null && mine.includes(s.managerEmployeeId),
          isSkipLevel: s.skipLevelEmployeeId !== null && mine.includes(s.skipLevelEmployeeId),
          /**
           * ⚠️ `isHr` IS FALSE HERE EVEN FOR AN HR READER. This endpoint
           * is the participant's view, and the whole-register view is a
           * different endpoint behind its own key. One endpoint that
           * widens for a privileged caller is the mistake this file is
           * arranged to make impossible.
           */
          isHr: false,
        };
        const released = s.releasedAt !== null;

        const mineOfThese = reviews.filter((r) => r.subjectId === s.id);
        const shapedReviews: ReviewView[] = mineOfThese.map((r) => {
          const readable = canReadReview(r.kind, relation, { released, submitted: r.submittedAt !== null });
          return {
            kind: r.kind,
            reviewerName: byId.get(r.reviewerEmployeeId)?.fullName ?? "—",
            rating: readable ? r.rating : null,
            strengths: readable ? r.strengths : null,
            improvements: readable ? r.improvements : null,
            submittedAt: r.submittedAt ? r.submittedAt.toISOString() : null,
            withheld: readable ? null : describeWithheld(r.kind, relation),
          };
        });

        const myKind: AppraisalReviewKind | null = relation.isSubject
          ? "self"
          : relation.isManager
            ? "manager"
            : relation.isSkipLevel
              ? "skip_level"
              : null;

        const outcomeNow = effectiveOutcome({
          originalRating: s.outcomeRating,
          originalSummary: s.outcomeSummary,
          amendments: amendments
            .filter((a) => a.subjectId === s.id)
            .map((a) => ({
              newRating: a.newRating,
              newSummary: a.newSummary,
              amendedAt: a.amendedAt,
            })),
        });

        /**
         * 🔴 THE SUBJECT DOES NOT SEE THE OUTCOME UNTIL IT IS RELEASED,
         * even though it is signed off and even though the row is right
         * there. A reviewer does.
         */
        const outcomeVisible = relation.isSubject ? released : true;

        return {
          subjectId: s.id,
          cycleName: cycle?.name ?? "—",
          periodStart: cycle?.periodStart ?? "",
          periodEnd: cycle?.periodEnd ?? "",
          fyLabel: cycle?.fyLabel ?? "",
          cycleStatus: cycle?.status ?? "",
          employeeName: byId.get(s.employeeId)?.fullName ?? "—",
          managerName: s.managerEmployeeId
            ? (byId.get(s.managerEmployeeId)?.fullName ?? "—")
            : null,
          status: s.status,
          rating: outcomeVisible ? outcomeNow.rating : null,
          summary: outcomeVisible ? outcomeNow.summary : null,
          amended: outcomeVisible ? outcomeNow.amended : false,
          releasedAt: s.releasedAt ? s.releasedAt.toISOString() : null,
          relation,
          myReviewKind: myKind,
          myReviewSubmitted: mineOfThese.some(
            (r) => r.kind === myKind && r.submittedAt !== null,
          ),
          reviews: shapedReviews,
        };
      };

      const shaped = subjects.map(shape);

      return {
        linked: true,
        duplicateLink: mine.length > 1,
        aboutMe: shaped.filter((s) => s.relation.isSubject),
        myLine: shaped.filter((s) => !s.relation.isSubject),
        canSeeEveryone: isHr,
        myChain,
      };
    });

    return { ok: true, data: view };
  } catch (err) {
    return toSalesActionError(err, "my appraisals");
  }
}

const reviewSchema = z.object({
  subjectId: z.string().uuid(),
  kind: z.enum(["self", "manager", "skip_level"]),
  rating: z.enum(RATINGS).optional(),
  strengths: z.string().trim().max(4000).optional(),
  improvements: z.string().trim().max(4000).optional(),
  /** False saves a private draft; true submits and freezes it. */
  submit: z.boolean().default(false),
});

/**
 * ⭐⭐⭐ WRITE A REVIEW — AND THE AUTHORISATION IS THAT IT IS YOURS TO
 * WRITE, NOT THAT YOU HOLD A KEY.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS TAKES A `subjectId` WHEN `myPayslips()` TAKES NOTHING
 * ══════════════════════════════════════════════════════════════════════
 * A write has to name the row it writes. The control is therefore not
 * the absence of a parameter but the SHAPE of the lookup: the subject is
 * fetched with the reviewer predicate IN the `and(...)`, so a `subjectId`
 * belonging to somebody else's appraisal returns no row and the action
 * refuses. There is no "fetch, then check" — the check IS the fetch, and
 * a fetch cannot be bypassed by a later edit that forgets a branch.
 *
 * ⚠️ AND THE KIND IS NOT TAKEN ON TRUST EITHER. `canWriteReview` says
 * only the subject may write `self`, only the snapshotted manager may
 * write `manager`, only the snapshotted skip-level may write
 * `skip_level`. The `appraisal_reviews_reviewer_matches_kind` trigger in
 * 0085 says the same thing in the database, so a future code path that
 * skips this function cannot file one person's opinion as another's.
 *
 * 🔴 HR CANNOT WRITE A REVIEW FOR SOMEBODY. There is deliberately no
 * administrative override: a review filed by somebody who was not there,
 * under a name that was, is a forgery with a permission key attached.
 */
export async function submitAppraisalReview(
  input: unknown,
): Promise<ActionResult<{ note: string }>> {
  try {
    /**
     * ⚠️ TIER 2 LIVES IN `participantContext`, ONE HOP AWAY, and it is
     * an honest one: the caller either holds `payroll.manage` (an HR
     * administrator, who is allowed here only so the screen can be
     * exercised and who still cannot write a review that is not theirs)
     * or is a linked employee. Whichever they are, the row predicate
     * below is what decides.
     */
    const gate = await participantContext();
    if ("error" in gate) return { ok: false, error: gate.error };
    const { ctx, mine } = gate;

    const parsed = reviewSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: "Check the form." };
    const d = parsed.data;

    const outcome = await withTenant(
      ctx.tenant.id,
      async (tx): Promise<{ error: string } | { note: string }> => {
        /**
         * 🔴 THE PREDICATE IS IN THE `and(...)`. Not after it, not in an
         * `if` below it. The row is only reachable when one of the three
         * reviewer columns names an employee row that points at this
         * sign-in account.
         */
        const [subject] = await tx
          .select()
          .from(appraisalSubjects)
          .where(
            and(
              eq(appraisalSubjects.tenantId, ctx.tenant.id),
              eq(appraisalSubjects.id, d.subjectId),
              or(
                inArray(appraisalSubjects.employeeId, mine),
                inArray(appraisalSubjects.managerEmployeeId, mine),
                inArray(appraisalSubjects.skipLevelEmployeeId, mine),
              ),
            ),
          )
          .limit(1);
        if (!subject) {
          return { error: "That appraisal is not one you take part in." };
        }

        const [cycle] = await tx
          .select()
          .from(appraisalCycles)
          .where(
            and(
              eq(appraisalCycles.tenantId, ctx.tenant.id),
              eq(appraisalCycles.id, subject.cycleId),
            ),
          )
          .limit(1);
        if (!cycle || cycle.status !== "open") {
          return { error: "That cycle is not open for reviews." };
        }

        const relation: ViewerRelation = {
          ...NO_RELATION,
          isSubject: mine.includes(subject.employeeId),
          isManager:
            subject.managerEmployeeId !== null && mine.includes(subject.managerEmployeeId),
          isSkipLevel:
            subject.skipLevelEmployeeId !== null && mine.includes(subject.skipLevelEmployeeId),
          isHr: false,
        };
        if (!canWriteReview(d.kind, relation)) {
          return {
            error:
              "That is not your review to write. A self review is written by the person being reviewed, a manager review by their manager, and a skip-level review by the manager's manager.",
          };
        }

        const reviewerEmployeeId = relation.isSubject
          ? subject.employeeId
          : d.kind === "manager"
            ? subject.managerEmployeeId!
            : subject.skipLevelEmployeeId!;

        const [existing] = await tx
          .select()
          .from(appraisalReviews)
          .where(
            and(
              eq(appraisalReviews.tenantId, ctx.tenant.id),
              eq(appraisalReviews.subjectId, d.subjectId),
              eq(appraisalReviews.kind, d.kind),
            ),
          )
          .limit(1);

        if (existing?.submittedAt) {
          return {
            error:
              "That review has been submitted and cannot be edited. A review somebody has acted on is evidence, the same as the outcome.",
          };
        }

        const submittedAt = d.submit ? new Date() : null;

        if (existing) {
          await tx
            .update(appraisalReviews)
            .set({
              rating: d.rating ?? null,
              strengths: d.strengths ?? null,
              improvements: d.improvements ?? null,
              submittedAt,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(appraisalReviews.tenantId, ctx.tenant.id),
                eq(appraisalReviews.id, existing.id),
                /** ⚠️ Re-asserted: never overwrite a submitted review. */
                isNull(appraisalReviews.submittedAt),
              ),
            );
        } else {
          await tx.insert(appraisalReviews).values({
            tenantId: ctx.tenant.id,
            subjectId: d.subjectId,
            kind: d.kind,
            reviewerEmployeeId,
            rating: d.rating ?? null,
            strengths: d.strengths ?? null,
            improvements: d.improvements ?? null,
            submittedAt,
          });
        }

        /**
         * ⚠️ THE SUBJECT'S STATUS MOVES, AND IT NEVER MOVES BACKWARDS
         * PAST A SIGN-OFF. The frozen-after-sign-off trigger would
         * refuse anyway; refusing here means the person gets a sentence.
         */
        if (submittedAt && !subject.signedOffAt) {
          const next =
            d.kind === "self"
              ? "self_submitted"
              : d.kind === "manager"
                ? "manager_submitted"
                : subject.status;
          if (next !== subject.status) {
            await tx
              .update(appraisalSubjects)
              .set({ status: next, updatedAt: new Date() })
              .where(
                and(
                  eq(appraisalSubjects.tenantId, ctx.tenant.id),
                  eq(appraisalSubjects.id, d.subjectId),
                  isNull(appraisalSubjects.signedOffAt),
                ),
              );
          }
        }

        return {
          note: submittedAt
            ? d.kind === "skip_level"
              ? "Skip-level review submitted. It is read by HR and by you. It is never shown to the employee or to their manager."
              : d.kind === "manager"
                ? "Manager review submitted. The employee sees it when the outcome is released, not before."
                : "Self review submitted. Your manager and skip-level can read it."
            : "Draft saved. Nobody else can see it until you submit it.",
        };
      },
    );

    if ("error" in outcome) return { ok: false, error: outcome.error };

    revalidatePath("/hr/me");
    return { ok: true, data: outcome };
  } catch (err) {
    return toSalesActionError(err, "appraisal review");
  }
}

/* ------------------------------------------------------------------ */
/* THE PARTICIPANT GATE                                                */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE TIER-2 GUARD FOR THE ONE WRITE THAT HAS NO PERMISSION KEY.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS ACTUALLY ASSERTS, AND WHAT IT DOES NOT
 * ══════════════════════════════════════════════════════════════════════
 * It asserts that the caller is a real session in a real workspace AND
 * that a linked `employees` row exists for them — because somebody with
 * no employee record cannot be anybody's reviewer and should be refused
 * with a sentence rather than by an empty result set.
 *
 * It does NOT assert that they may write the review they asked for.
 * That is decided by the row predicate at the call site and by
 * `canWriteReview`, and it has to be, because the authorisation is a
 * RELATIONSHIP and no permission key can express "is this person's
 * manager".
 *
 * ⚠️ THE `can()` CALL BELOW IS NOT DECORATION. It is how an HR
 * administrator with no employee record of their own is told the truth
 * — "you hold the HR key but you are not a participant" — instead of
 * being refused with the same message as a stranger. Ordence has no
 * `hr.appraisals.participate` key today; Batch 109 reports that it wants
 * one, and until then this is the honest shape.
 */
async function participantContext(): Promise<
  | { error: string }
  | { ctx: Awaited<ReturnType<typeof requireTenantContext>>; mine: string[]; isHr: boolean }
> {
  const ctx = await requireTenantContext();
  const isHr = can({ role: ctx.role, overrides: ctx.user.permissionOverrides }, HR_MANAGE);
  const mine = await withTenant(ctx.tenant.id, (tx) =>
    myEmployeeIds(tx, ctx.tenant.id, ctx.user.id),
  );
  if (mine.length === 0) {
    return {
      error: isHr
        ? "You hold the HR permission but no employee record is linked to your sign-in, so you take part in no appraisal. Link your employee record on the payroll screen."
        : "No employee record is linked to your sign-in, so there is no appraisal for you to write.",
    };
  }
  return { ctx, mine, isHr };
}

/* ------------------------------------------------------------------ */
/* SMALL HELPERS                                                       */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ `Date.UTC`, NEVER `new Date(iso)`. The latter is parsed in the
 * runtime's local zone for some formats, and a server in UTC and one in
 * Asia/Kolkata would disagree about which day 31 March is — the day the
 * financial year turns on.
 */
function shiftDay(iso: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const base = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
}
