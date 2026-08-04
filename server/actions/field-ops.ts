"use server";

/**
 * Ordence — ⭐ ENGINE 3 · FIELD & MOBILE OPERATIONS ACTIONS
 * Version: v0.65.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION. A `"use server"` file that exports
 * anything else — a constant, a Zod schema, a type guard — publishes it as
 * an RPC endpoint reachable by anyone on the internet. Every helper below
 * is deliberately not exported.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THIS FILE DOES NOT DECIDE WHETHER A STATUS MOVE IS LEGAL
 * ══════════════════════════════════════════════════════════════════════
 * `field_job_guard_transition()` in SQL-FILES/0036 does, and it has to,
 * because the client this engine is built for spends its day offline. A
 * phone that has been out of coverage for four hours reconnects and
 * replays a queue that is not guaranteed to be in order — a retry of an
 * early event landing after a later one. A rule enforced in TypeScript is
 * a rule that queue routes around, and what you get is a job marked
 * `completed` that was never `on_site`, which makes the first-time-fix
 * rate fiction.
 *
 * ⚠️ SO WHAT THIS FILE DOES IS TRANSLATE THE REFUSAL. See
 * `explainFieldError`. The trigger's messages are already written for a
 * dispatcher ("Job FJ-20260804-7K3M cannot move from completed to
 * on_site. Permitted next steps: none — this status is final."), so most
 * of the work is passing them through rather than flattening them into
 * "Something went wrong". `canTransition` in db/schema/field-ops.ts is
 * imported by the SCREEN, to decide which buttons to draw. It is not
 * imported here, because a second opinion at the write site is a second
 * opinion that will eventually disagree with the first.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ A RETRIED SUBMIT IS ABSORBED, NOT REJECTED
 * ══════════════════════════════════════════════════════════════════════
 * `recordFieldVisit` and `recordFieldProof` take a `clientEventId` chosen
 * ON THE DEVICE before the first attempt, and insert with
 * ON CONFLICT DO NOTHING against `field_visits_client_event_key`.
 *
 * ⚠️ THE DUPLICATE IS A SUCCESS, NOT AN ERROR. A technician whose phone
 * lost signal mid-submit and retried on reconnect has sent one event
 * twice. Returning "that already exists" to the retry teaches the app to
 * show a failure for work that was recorded perfectly — and the second
 * thing every field app then grows is a "force resend" button, which is
 * how you get two visits, two hours of labour and two bills.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ GPS IS EVIDENCE. NOTHING HERE REFUSES A CHECK-IN ON DISTANCE.
 * ══════════════════════════════════════════════════════════════════════
 * `distance_from_site_m` and `is_distance_suspicious` are computed by
 * trigger and returned for a supervisor to read. A check-in 4 km out is a
 * conversation. Refusing it does not stop the technician working — the
 * customer is standing there — it stops the work being RECORDED, and the
 * job history ends up missing precisely the hard jobs.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ MONEY LEAVES THIS FILE AS A STRING
 * ══════════════════════════════════════════════════════════════════════
 * `quoted_amount_minor` and `unit_cost_minor` are `bigint` paise in the
 * database. `JSON.stringify` throws on a bigint and a server action's
 * return value is serialised, so one un-stringified bigint anywhere in a
 * payload takes down the whole page with "Do not know how to serialize a
 * BigInt", nowhere near the column that caused it.
 */

import { and, asc, desc, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenant } from "@/db";
import {
  fieldJobs,
  fieldVisits,
  fieldProofs,
  fieldJobMaterials,
} from "@/db/schema/field-ops";
import { companies } from "@/db/schema/crm";
import { users } from "@/db/schema/core";
import { requirePermission, writeAudit } from "@/server/audit";
import { guardSalesWrite, toSalesActionError } from "@/server/sales/guards";
import type { ActionResult } from "@/lib/validators/crm";

/** ⚠️ Exactly this string. It is the key in lib/modules/registry.ts. */
const FEATURE = "field.jobs" as const;

const READ_PERMISSION = "field.jobs.read";
const WRITE_PERMISSION = "field.jobs.manage";

/* ------------------------------------------------------------------ */
/* SHAPES — everything monetary is a string. See the header.           */
/* ------------------------------------------------------------------ */

export type FieldJobRow = {
  id: string;
  jobNumber: string;
  title: string;
  description: string | null;
  jobKind: string;
  status: string;
  priority: string;

  customerCompanyId: string | null;
  customerName: string | null;

  siteAddress: string | null;
  siteLandmark: string | null;
  /** ⚠️ Both or neither. A row with one is a point in the Gulf of Guinea. */
  siteLatitude: string | null;
  siteLongitude: string | null;

  windowStart: string | null;
  windowEnd: string | null;
  estimatedMinutes: number | null;

  assignedUserId: string | null;
  assigneeName: string | null;
  crewName: string | null;

  completedAt: string | null;
  failureReason: string | null;
  failureNote: string | null;

  /** ⭐ Trigger-maintained. Three is the operational alarm. */
  visitCount: number;
  quotedAmountMinor: string | null;

  /** ⭐ From `v_field_dispatch_board` — late against the customer's window. */
  isOverdue: boolean;
  /** ⭐ From `v_field_dispatch_board` — visit_count >= 3. */
  isRepeatFailure: boolean;
  /** Check-ins on this job flagged far from site. Evidence, not a verdict. */
  suspiciousCheckIns: number;

  /** `completed` and `cancelled`. Nothing moves out of either. */
  isClosed: boolean;
};

export type FieldVisitRow = {
  id: string;
  jobId: string;
  jobNumber: string;
  jobTitle: string;
  sequence: number;
  clientEventId: string;
  checkedInAt: string | null;
  checkedOutAt: string | null;
  /** Metres from the site, by haversine. `null` when either point is absent. */
  distanceFromSiteM: number | null;
  isDistanceSuspicious: boolean;
  onSiteMinutes: number | null;
  checkedInAccuracyM: number | null;
  technicianUserId: string | null;
  technicianName: string | null;
  /**
   * ⭐ When the SERVER heard about it, kept alongside the device clock. The
   * gap between the two is the only way to spot a handset with a wrong
   * clock, or a day filled in from the sofa afterwards.
   */
  syncedAt: string;
  notes: string | null;
};

export type FieldProofRow = {
  id: string;
  jobId: string;
  jobNumber: string;
  visitId: string;
  kind: string;
  value: string | null;
  storageKey: string | null;
  acceptedByName: string | null;
  otpVerified: boolean;
  capturedAt: string;
  capturedLatitude: string | null;
  capturedLongitude: string | null;
};

export type FieldMaterialRow = {
  id: string;
  jobId: string;
  visitId: string | null;
  itemCode: string;
  itemName: string;
  /** Negative = returned to stock. Never zero; the database refuses it. */
  quantity: string;
  unit: string;
  unitCostMinor: string;
  isBillable: boolean;
  isWarranty: boolean;
  serialNumber: string | null;
};

export type FieldTechnicianRow = {
  userId: string | null;
  name: string;
  jobsClosed: number;
  completed: number;
  failed: number;
  firstTimeFixes: number;
  /** ⭐ Percent, one decimal, as a string. `null` when nothing has closed. */
  firstTimeFixPct: string | null;
  avgOnSiteMinutes: number | null;
  suspiciousCheckIns: number;
};

export type FieldUserOption = { id: string; name: string };
export type FieldCustomerOption = { id: string; name: string };

export type FieldCounters = {
  open: number;
  overdue: number;
  repeatFailures: number;
  suspiciousCheckIns: number;
  completed: number;
  couldNotComplete: number;
  /** Across every closed job, one decimal, as a string. */
  firstTimeFixPct: string | null;
  /** Quoted value sitting on jobs that are still open. Paise, as a string. */
  openQuotedMinor: string;
};

/* ------------------------------------------------------------------ */
/* HELPERS — not exported. See the header.                             */
/* ------------------------------------------------------------------ */

function iso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  return d instanceof Date ? d.toISOString() : String(d);
}

function minorOrNull(v: bigint | number | string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return String(v);
}

function personName(
  first: string | null,
  last: string | null,
  email: string | null,
): string {
  const joined = [first, last].filter(Boolean).join(" ").trim();
  return joined || email || "Unassigned";
}

/** The driver hands back either an array or `{ rows }`. Normalise. */
function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as Record<string, unknown>[];
  }
  return [];
}

/**
 * ⭐ TURN THE DATABASE'S REFUSAL INTO A SENTENCE SOMEBODY CAN ACT ON.
 *
 * ⚠️ THE QUALITY OF THIS FUNCTION IS THE QUALITY OF THE FEATURE, for the
 * same reason it is in `explainScheduleError`: the status machine is
 * enforced nowhere else, so the trigger's "no" is the only "no" there is.
 * A dispatcher told "P0001" phones IT and then closes the job by hand in
 * a spreadsheet. A dispatcher told "no visit has been checked in against
 * it" records the visit.
 *
 * ⚠️ THESE ARRIVE AS SQLSTATE P0001 — `RAISE EXCEPTION` — not as 23514,
 * so `toSalesActionError` does not recognise them as check violations and
 * would flatten every one. They are matched here, ahead of it.
 */
function explainFieldError(err: unknown): string | null {
  const message =
    err && typeof err === "object" && "message" in err
      ? String((err as { message: unknown }).message)
      : "";
  const code =
    err && typeof err === "object" && "code" in err
      ? String((err as { code: unknown }).code)
      : "";
  const constraint =
    err && typeof err === "object" && "constraint" in err
      ? String((err as { constraint: unknown }).constraint)
      : "";

  /* --- The status machine. Already written for a person. ----------- */
  if (/cannot move from .+ to /.test(message)) return message;
  if (/no visit has been checked in against it/.test(message)) return message;
  if (/without a reason/.test(message)) return message;

  /* --- Append-only proof. ------------------------------------------ */
  if (/Proof of service cannot be/.test(message)) return message;

  /* --- The visit trigger's own refusals. ---------------------------- */
  if (/does not exist in this workspace/.test(message)) return message;

  /* --- Row-level CHECKs, which arrive as 23514 with a constraint. --- */
  if (constraint.includes("field_jobs_window_ordered")) {
    return (
      "The promise window ends before it starts. The window is what the " +
      "customer was actually told — \"between 10 and 1\" — and every lateness " +
      "figure on this screen is measured against its end."
    );
  }
  if (constraint.includes("field_jobs_coords_paired")) {
    return (
      "Give both the latitude and the longitude of the site, or neither. One " +
      "on its own becomes a point on the equator or the prime meridian — a " +
      "real coordinate in the Gulf of Guinea — and every check-in against " +
      "this job would then be flagged as thousands of kilometres out."
    );
  }
  if (constraint.includes("field_jobs_coords_sane")) {
    return (
      "Latitude runs −90 to 90 and longitude −180 to 180. A swapped pair is " +
      "the usual cause: Mumbai is 19.07, 72.87 and not 72.87, 19.07."
    );
  }
  if (constraint.includes("field_visits_times_ordered")) {
    return (
      "The check-out is earlier than the check-in. Both come from the " +
      "handset's clock, so a device whose time is wrong produces exactly " +
      "this — check the phone before editing the times."
    );
  }
  if (constraint.includes("field_job_materials_quantity_non_zero")) {
    return (
      "A material line of zero records nothing. Use a negative quantity to " +
      "put a part back into van stock, or remove the line."
    );
  }

  /* --- Uniqueness. -------------------------------------------------- */
  if (code === "23505" && constraint.includes("field_jobs_number_key")) {
    return (
      "A job with that number already exists in this workspace. The number " +
      "is how a job is quoted down a phone line, so two cannot share one."
    );
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* READ                                                                */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE DISPATCH BOARD: what is open, who has it, whether it is late.
 *
 * ⚠️ OVERDUE AND REPEAT-FAILURE ARE READ FROM `v_field_dispatch_board`,
 * NOT RECOMPUTED HERE. Both are one-line rules and both are the kind of
 * one-line rule that drifts: "late" means past `window_end` and not
 * closed — where closed is three statuses, not one — and "repeat" means
 * `visit_count >= 3`. A screen that disagrees with the view about which
 * jobs are late is a screen a dispatcher stops believing, and the view is
 * what any report or alert built later will read.
 *
 * ⚠️ THE VIEW ONLY CARRIES OPEN JOBS — it excludes `completed` and
 * `cancelled` by design, because a finished job is not on anybody's
 * board. Closed jobs come from the table and are marked overdue = false,
 * which is what the view's own predicate would say about them anyway.
 *
 * ⚠️ AND THE TECHNICIAN FIGURES ARE **NOT** TAKEN FROM
 * `v_field_technician_performance`. That view LEFT JOINs `field_visits`
 * and then counts rows, so a three-visit job is counted three times in
 * `jobs_closed`, `completed` and `failed` — while `first_time_fixes`
 * counts only single-visit jobs and is therefore counted once each. The
 * ratio is deflated by exactly the amount of repeat work a technician
 * has, which is the opposite of what the number is for. Recomputed below
 * over `field_jobs` alone, with the fan-out removed. See the report note.
 */
export async function listFieldJobs(params?: {
  /** Filter to one kind, e.g. "housekeeping" for the hospitality board. */
  jobKind?: string;
}): Promise<
  ActionResult<{
    jobs: FieldJobRow[];
    /** ⭐ Past the window the customer was given, and still open. */
    overdue: FieldJobRow[];
    /** ⭐ Three visits or more. Two is bad luck; three is a wrong diagnosis. */
    repeatFailures: FieldJobRow[];
    /** ⭐ Check-ins far from site. Prominent, and never a rejection. */
    suspiciousCheckIns: FieldVisitRow[];
    visits: FieldVisitRow[];
    proofs: FieldProofRow[];
    materials: FieldMaterialRow[];
    technicians: FieldTechnicianRow[];
    assignees: FieldUserOption[];
    customers: FieldCustomerOption[];
    jobKinds: string[];
    counters: FieldCounters;
  }>
> {
  try {
    const ctx = await requirePermission(READ_PERMISSION);
    const kindFilter = params?.jobKind?.trim() || null;

    const payload = await withTenant(ctx.tenant.id, async (tx) => {
      const jobs = await tx
        .select({
          id: fieldJobs.id,
          jobNumber: fieldJobs.jobNumber,
          title: fieldJobs.title,
          description: fieldJobs.description,
          jobKind: fieldJobs.jobKind,
          status: fieldJobs.status,
          priority: fieldJobs.priority,
          customerCompanyId: fieldJobs.customerCompanyId,
          siteAddress: fieldJobs.siteAddress,
          siteLandmark: fieldJobs.siteLandmark,
          siteLatitude: fieldJobs.siteLatitude,
          siteLongitude: fieldJobs.siteLongitude,
          windowStart: fieldJobs.windowStart,
          windowEnd: fieldJobs.windowEnd,
          estimatedMinutes: fieldJobs.estimatedMinutes,
          assignedUserId: fieldJobs.assignedUserId,
          crewName: fieldJobs.crewName,
          completedAt: fieldJobs.completedAt,
          failureReason: fieldJobs.failureReason,
          failureNote: fieldJobs.failureNote,
          visitCount: fieldJobs.visitCount,
          quotedAmountMinor: fieldJobs.quotedAmountMinor,
          customerName: companies.name,
          assigneeFirstName: users.firstName,
          assigneeLastName: users.lastName,
          assigneeEmail: users.email,
        })
        .from(fieldJobs)
        // ⚠️ LEFT on both. Most jobs in most verticals have no company row
        // (a home-care visit, a domestic delivery) and an unassigned job is
        // the single most important row on a dispatch board.
        .leftJoin(
          companies,
          and(
            eq(companies.id, fieldJobs.customerCompanyId),
            eq(companies.tenantId, fieldJobs.tenantId),
          ),
        )
        .leftJoin(
          users,
          and(
            eq(users.id, fieldJobs.assignedUserId),
            eq(users.tenantId, fieldJobs.tenantId),
          ),
        )
        .where(
          and(
            eq(fieldJobs.tenantId, ctx.tenant.id),
            sql`${fieldJobs.deletedAt} IS NULL`,
            kindFilter ? eq(fieldJobs.jobKind, kindFilter) : undefined,
          ),
        )
        .orderBy(asc(fieldJobs.windowStart), desc(fieldJobs.createdAt))
        .limit(1000);

      /**
       * ⭐ The board's own verdict on lateness and repeat failure.
       * `security_invoker` is set on the view, so RLS applies as it does
       * to the tables — the tenant predicate below is belt as well as
       * braces, and cheap.
       */
      const board = rowsOf(
        await tx.execute(sql`
          SELECT job_id, is_overdue, is_repeat_failure, suspicious_checkins
            FROM v_field_dispatch_board
           WHERE tenant_id = ${ctx.tenant.id}::uuid
        `),
      );

      const visits = await tx
        .select({
          id: fieldVisits.id,
          jobId: fieldVisits.jobId,
          sequence: fieldVisits.sequence,
          clientEventId: fieldVisits.clientEventId,
          checkedInAt: fieldVisits.checkedInAt,
          checkedOutAt: fieldVisits.checkedOutAt,
          distanceFromSiteM: fieldVisits.distanceFromSiteM,
          isDistanceSuspicious: fieldVisits.isDistanceSuspicious,
          onSiteMinutes: fieldVisits.onSiteMinutes,
          checkedInAccuracyM: fieldVisits.checkedInAccuracyM,
          technicianUserId: fieldVisits.technicianUserId,
          syncedAt: fieldVisits.syncedAt,
          notes: fieldVisits.notes,
          jobNumber: fieldJobs.jobNumber,
          jobTitle: fieldJobs.title,
          jobKind: fieldJobs.jobKind,
          techFirstName: users.firstName,
          techLastName: users.lastName,
          techEmail: users.email,
        })
        .from(fieldVisits)
        .innerJoin(
          fieldJobs,
          and(
            eq(fieldJobs.id, fieldVisits.jobId),
            eq(fieldJobs.tenantId, fieldVisits.tenantId),
          ),
        )
        .leftJoin(
          users,
          and(
            eq(users.id, fieldVisits.technicianUserId),
            eq(users.tenantId, fieldVisits.tenantId),
          ),
        )
        .where(
          and(
            eq(fieldVisits.tenantId, ctx.tenant.id),
            sql`${fieldJobs.deletedAt} IS NULL`,
            kindFilter ? eq(fieldJobs.jobKind, kindFilter) : undefined,
          ),
        )
        // ⚠️ BY THE DEVICE CLOCK, NOT BY `synced_at`. Ordering on arrival at
        // the server puts a technician's whole day in upload order, which
        // is roughly the reverse of the order it happened in.
        .orderBy(desc(fieldVisits.checkedInAt), desc(fieldVisits.syncedAt))
        .limit(1000);

      const proofs = await tx
        .select({
          id: fieldProofs.id,
          jobId: fieldProofs.jobId,
          visitId: fieldProofs.visitId,
          kind: fieldProofs.kind,
          value: fieldProofs.value,
          storageKey: fieldProofs.storageKey,
          acceptedByName: fieldProofs.acceptedByName,
          otpVerified: fieldProofs.otpVerified,
          capturedAt: fieldProofs.capturedAt,
          capturedLatitude: fieldProofs.capturedLatitude,
          capturedLongitude: fieldProofs.capturedLongitude,
          jobNumber: fieldJobs.jobNumber,
        })
        .from(fieldProofs)
        .innerJoin(
          fieldJobs,
          and(
            eq(fieldJobs.id, fieldProofs.jobId),
            eq(fieldJobs.tenantId, fieldProofs.tenantId),
          ),
        )
        .where(
          and(
            eq(fieldProofs.tenantId, ctx.tenant.id),
            sql`${fieldJobs.deletedAt} IS NULL`,
            kindFilter ? eq(fieldJobs.jobKind, kindFilter) : undefined,
          ),
        )
        .orderBy(desc(fieldProofs.capturedAt))
        .limit(1000);

      const materials = await tx
        .select()
        .from(fieldJobMaterials)
        .where(eq(fieldJobMaterials.tenantId, ctx.tenant.id))
        .orderBy(desc(fieldJobMaterials.createdAt))
        .limit(1000);

      /**
       * ⭐ FIRST-TIME FIX, COUNTED OVER JOBS AND NOTHING ELSE.
       *
       * ⚠️ NO JOIN TO `field_visits` HERE, AND THAT IS THE WHOLE POINT —
       * see the function header. Joining multiplies every closed job by
       * its visit count, which penalises exactly the technicians whose
       * repeat work the number exists to measure.
       */
      const perf = rowsOf(
        await tx.execute(sql`
          SELECT j.assigned_user_id                                        AS user_id,
                 count(*)                                                  AS jobs_closed,
                 count(*) FILTER (WHERE j.status = 'completed')            AS completed,
                 count(*) FILTER (WHERE j.status = 'could_not_complete')   AS failed,
                 count(*) FILTER (WHERE j.status = 'completed'
                                    AND j.visit_count = 1)                 AS first_time_fixes
            FROM field_jobs j
           WHERE j.tenant_id = ${ctx.tenant.id}::uuid
             AND j.deleted_at IS NULL
             AND j.status IN ('completed','could_not_complete')
             ${kindFilter ? sql`AND j.job_kind = ${kindFilter}` : sql``}
           GROUP BY j.assigned_user_id
        `),
      );

      const assigneeRows = await tx
        .select({
          id: users.id,
          firstName: users.firstName,
          lastName: users.lastName,
          email: users.email,
        })
        .from(users)
        .where(
          and(
            eq(users.tenantId, ctx.tenant.id),
            sql`${users.deletedAt} IS NULL`,
          ),
        )
        .orderBy(asc(users.firstName), asc(users.email))
        .limit(500);

      const customerRows = await tx
        .select({ id: companies.id, name: companies.name })
        .from(companies)
        .where(
          and(
            eq(companies.tenantId, ctx.tenant.id),
            sql`${companies.deletedAt} IS NULL`,
          ),
        )
        .orderBy(asc(companies.name))
        .limit(500);

      return {
        jobs,
        board,
        visits,
        proofs,
        materials,
        perf,
        assigneeRows,
        customerRows,
      };
    });

    /* --- Visits, first: the job rows borrow their suspicious count. -- */
    const visitRows: FieldVisitRow[] = payload.visits.map((v) => ({
      id: v.id,
      jobId: v.jobId,
      jobNumber: v.jobNumber,
      jobTitle: v.jobTitle,
      sequence: v.sequence,
      clientEventId: v.clientEventId,
      checkedInAt: iso(v.checkedInAt),
      checkedOutAt: iso(v.checkedOutAt),
      distanceFromSiteM: v.distanceFromSiteM,
      isDistanceSuspicious: v.isDistanceSuspicious,
      onSiteMinutes: v.onSiteMinutes,
      checkedInAccuracyM: v.checkedInAccuracyM,
      technicianUserId: v.technicianUserId,
      technicianName: v.technicianUserId
        ? personName(v.techFirstName, v.techLastName, v.techEmail)
        : null,
      syncedAt: iso(v.syncedAt) ?? "",
      notes: v.notes,
    }));

    const boardByJob = new Map(
      payload.board.map((b) => [
        String(b.job_id),
        {
          isOverdue: b.is_overdue === true,
          isRepeatFailure: b.is_repeat_failure === true,
          suspicious: Number(b.suspicious_checkins ?? 0),
        },
      ]),
    );

    const CLOSED = new Set(["completed", "cancelled"]);

    const jobRows: FieldJobRow[] = payload.jobs.map((j) => {
      const board = boardByJob.get(j.id);
      return {
        id: j.id,
        jobNumber: j.jobNumber,
        title: j.title,
        description: j.description,
        jobKind: j.jobKind,
        status: j.status,
        priority: j.priority,
        customerCompanyId: j.customerCompanyId,
        customerName: j.customerName,
        siteAddress: j.siteAddress,
        siteLandmark: j.siteLandmark,
        siteLatitude: j.siteLatitude,
        siteLongitude: j.siteLongitude,
        windowStart: iso(j.windowStart),
        windowEnd: iso(j.windowEnd),
        estimatedMinutes: j.estimatedMinutes,
        assignedUserId: j.assignedUserId,
        assigneeName: j.assignedUserId
          ? personName(j.assigneeFirstName, j.assigneeLastName, j.assigneeEmail)
          : null,
        crewName: j.crewName,
        completedAt: iso(j.completedAt),
        failureReason: j.failureReason,
        failureNote: j.failureNote,
        visitCount: j.visitCount,
        quotedAmountMinor: minorOrNull(j.quotedAmountMinor),
        // ⚠️ Absent from the view = the job is completed or cancelled, and
        // the view's own predicate would call it neither late nor repeat.
        isOverdue: board?.isOverdue ?? false,
        isRepeatFailure: board?.isRepeatFailure ?? false,
        suspiciousCheckIns:
          board?.suspicious ??
          visitRows.filter((v) => v.jobId === j.id && v.isDistanceSuspicious)
            .length,
        isClosed: CLOSED.has(j.status),
      };
    });

    const proofRows: FieldProofRow[] = payload.proofs.map((p) => ({
      id: p.id,
      jobId: p.jobId,
      jobNumber: p.jobNumber,
      visitId: p.visitId,
      kind: p.kind,
      value: p.value,
      storageKey: p.storageKey,
      acceptedByName: p.acceptedByName,
      otpVerified: p.otpVerified,
      capturedAt: iso(p.capturedAt) ?? "",
      capturedLatitude: p.capturedLatitude,
      capturedLongitude: p.capturedLongitude,
    }));

    const jobIds = new Set(jobRows.map((j) => j.id));
    const materialRows: FieldMaterialRow[] = payload.materials
      // ⚠️ Filtered in memory rather than joined, because the kind filter
      // lives on the job. A material line whose job is filtered out (or
      // soft-deleted) has nothing on this screen to attach to.
      .filter((m) => jobIds.has(m.jobId))
      .map((m) => ({
        id: m.id,
        jobId: m.jobId,
        visitId: m.visitId,
        itemCode: m.itemCode,
        itemName: m.itemName,
        quantity: String(m.quantity),
        unit: m.unit,
        unitCostMinor: String(m.unitCostMinor),
        isBillable: m.isBillable,
        isWarranty: m.isWarranty,
        serialNumber: m.serialNumber,
      }));

    const nameById = new Map(
      payload.assigneeRows.map((u) => [
        u.id,
        personName(u.firstName, u.lastName, u.email),
      ]),
    );

    const technicians: FieldTechnicianRow[] = payload.perf
      .map((p) => {
        const userId = p.user_id ? String(p.user_id) : null;
        const completed = Number(p.completed ?? 0);
        const firstTimeFixes = Number(p.first_time_fixes ?? 0);
        const theirVisits = visitRows.filter(
          (v) => v.technicianUserId === userId && v.onSiteMinutes !== null,
        );
        return {
          userId,
          name: userId ? (nameById.get(userId) ?? "Unknown user") : "Unassigned",
          jobsClosed: Number(p.jobs_closed ?? 0),
          completed,
          failed: Number(p.failed ?? 0),
          firstTimeFixes,
          /**
           * ⚠️ `null`, NOT 0, WHEN NOTHING HAS COMPLETED. A technician with
           * no closed jobs shown as "0.0%" reads as the worst performer on
           * the board — which is how a new joiner gets a conversation about
           * a number that describes an empty set.
           */
          firstTimeFixPct:
            completed > 0
              ? ((100 * firstTimeFixes) / completed).toFixed(1)
              : null,
          avgOnSiteMinutes:
            theirVisits.length > 0
              ? Math.round(
                  theirVisits.reduce((a, v) => a + (v.onSiteMinutes ?? 0), 0) /
                    theirVisits.length,
                )
              : null,
          suspiciousCheckIns: visitRows.filter(
            (v) => v.technicianUserId === userId && v.isDistanceSuspicious,
          ).length,
        };
      })
      .sort((a, b) => b.jobsClosed - a.jobsClosed);

    const overdue = jobRows
      .filter((j) => j.isOverdue)
      .sort((a, b) => (a.windowEnd ?? "").localeCompare(b.windowEnd ?? ""));

    const repeatFailures = jobRows
      .filter((j) => j.isRepeatFailure)
      .sort((a, b) => b.visitCount - a.visitCount);

    const suspiciousCheckIns = visitRows.filter((v) => v.isDistanceSuspicious);

    const openJobs = jobRows.filter(
      (j) => !j.isClosed && j.status !== "could_not_complete",
    );
    const completedCount = jobRows.filter((j) => j.status === "completed").length;
    const firstTimeCount = jobRows.filter(
      (j) => j.status === "completed" && j.visitCount === 1,
    ).length;

    return {
      ok: true,
      data: {
        jobs: jobRows,
        overdue,
        repeatFailures,
        suspiciousCheckIns,
        visits: visitRows,
        proofs: proofRows,
        materials: materialRows,
        technicians,
        assignees: payload.assigneeRows.map((u) => ({
          id: u.id,
          name: personName(u.firstName, u.lastName, u.email),
        })),
        customers: payload.customerRows.map((c) => ({ id: c.id, name: c.name })),
        jobKinds: [...new Set(jobRows.map((j) => j.jobKind))].sort(),
        counters: {
          open: openJobs.length,
          overdue: overdue.length,
          repeatFailures: repeatFailures.length,
          suspiciousCheckIns: suspiciousCheckIns.length,
          completed: completedCount,
          couldNotComplete: jobRows.filter(
            (j) => j.status === "could_not_complete",
          ).length,
          firstTimeFixPct:
            completedCount > 0
              ? ((100 * firstTimeCount) / completedCount).toFixed(1)
              : null,
          openQuotedMinor: String(
            openJobs.reduce(
              (acc, j) => acc + BigInt(j.quotedAmountMinor ?? "0"),
              0n,
            ),
          ),
        },
      },
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "The dispatch board could not be read.",
    };
  }
}

/* ------------------------------------------------------------------ */
/* SHARED FIELD SHAPES                                                 */
/* ------------------------------------------------------------------ */

const optionalUuid = z
  .union([z.string().uuid("That is not a valid reference."), z.literal(""), z.null()])
  .optional()
  .transform((v) => (v ? v : null));

const optionalText = (max: number) =>
  z
    .union([z.string().trim().max(max), z.null()])
    .optional()
    .transform((v) => (v ? v : null));

/** A whole number of paise, as typed. Kept a string until the last moment. */
const paise = z
  .string()
  .trim()
  .regex(/^-?\d{1,18}$/, "Enter a whole amount in paise, digits only.");

const optionalMoment = z
  .union([z.string().trim().min(1), z.literal(""), z.null()])
  .optional()
  .transform((v) => (v ? new Date(v) : null))
  .refine((d) => d === null || !Number.isNaN(d.getTime()), {
    message: "That is not a date and time this system can read.",
  });

/**
 * ⚠️ A COORDINATE IS A STRING ALL THE WAY DOWN. `numeric(10,7)` maps to a
 * string in Drizzle, and rounding a lat/long through a JavaScript float on
 * the way in is how a site drifts a few metres for no reason anybody can
 * later account for — on the one column the distance flag is measured
 * from.
 */
const optionalCoord = z
  .union([
    z.string().trim().regex(/^-?\d{1,3}(\.\d{1,7})?$/, "Use decimal degrees, e.g. 19.0760."),
    z.literal(""),
    z.null(),
  ])
  .optional()
  .transform((v) => (v ? v : null));

/* ------------------------------------------------------------------ */
/* WRITE — JOBS                                                        */
/* ------------------------------------------------------------------ */

const jobSchema = z
  .object({
    id: z.string().uuid().optional(),

    /** ⚠️ NOT NULL and unique per tenant. Generated below when absent. */
    jobNumber: z.string().trim().max(60).optional(),

    title: z.string().trim().min(1, "Say what the job is.").max(250),
    description: optionalText(5000),

    /**
     * ⚠️ NOT NULL, AND IT IS THE FILTER THE HOSPITALITY BOARD RUNS ON.
     * `/field-jobs?type=housekeeping` is the same screen restricted to
     * `job_kind = 'housekeeping'`, so a blank or misspelt kind is a job
     * that exists and appears on nobody's board.
     */
    jobKind: z.string().trim().min(1, "What kind of job is this?").max(60),

    /**
     * ⚠️ ONLY MEANINGFUL ON CREATE. Every later move goes through
     * `setFieldJobStatus`, because `field_job_guard_transition()` is a
     * BEFORE UPDATE trigger — it does not see inserts, and it is the only
     * thing entitled to decide whether a move is legal.
     */
    status: z.enum(["draft", "scheduled"]).default("draft"),
    priority: z.enum(["routine", "standard", "urgent", "emergency"]).default("standard"),

    customerCompanyId: optionalUuid,
    customerContactId: optionalUuid,

    siteAddress: optionalText(2000),
    siteLandmark: optionalText(250),
    siteLatitude: optionalCoord,
    siteLongitude: optionalCoord,

    /**
     * ⭐ A WINDOW, NOT AN APPOINTMENT. "Between 10 and 1" is what the
     * customer was promised and what `is_overdue` is measured against.
     */
    windowStart: optionalMoment,
    windowEnd: optionalMoment,

    estimatedMinutes: z.coerce.number().int().min(1).max(10_080).optional().nullable(),

    assignedUserId: optionalUuid,
    crewName: optionalText(120),

    /** Nullable in the database — an unpriced job is a legitimate job. */
    quotedAmountMinor: z
      .union([paise, z.literal(""), z.null()])
      .optional()
      .transform((v) => (v ? v : null)),
  })
  /**
   * ⚠️ CHECKED HERE **AND** BY `field_jobs_coords_paired`. Not redundancy:
   * this one can point at the field while the constraint is what holds
   * when a sync job writes the row.
   */
  .refine(
    (d) => (d.siteLatitude === null) === (d.siteLongitude === null),
    {
      message:
        "Give both the latitude and the longitude, or neither. One alone is a " +
        "point in the Gulf of Guinea, and every check-in would be flagged.",
      path: ["siteLongitude"],
    },
  )
  .refine(
    (d) => !d.windowStart || !d.windowEnd || d.windowEnd >= d.windowStart,
    {
      message: "The window ends before it starts.",
      path: ["windowEnd"],
    },
  );

/**
 * ⭐ Create or amend a job.
 *
 * ⚠️ THIS FUNCTION NEVER WRITES `status`, `visit_count` OR `completed_at`
 * ON AN EXISTING JOB. `visit_count` is maintained by
 * `field_job_recount_visits()`, `completed_at` is stamped by the
 * transition trigger, and status belongs to `setFieldJobStatus` — writing
 * any of the three from an edit form is how a dispatcher who was fixing a
 * typo in an address silently reopens a closed job.
 */
export async function saveFieldJob(
  input: unknown,
): Promise<ActionResult<{ id: string; jobNumber: string }>> {
  try {
    const data = jobSchema.parse(input);
    const ctx = await guardSalesWrite({
      operation: "field:job:save",
      feature: FEATURE,
      permission: WRITE_PERMISSION,
      resource: data.id ? { type: "field_job", id: data.id } : undefined,
    });

    /**
     * ⚠️ GENERATED WHEN ABSENT, NEVER LEFT EMPTY. The column is NOT NULL
     * and unique per tenant, and a job with no number cannot be quoted
     * down a phone line by a customer asking where the engineer is.
     */
    const jobNumber =
      data.jobNumber && data.jobNumber.length > 0
        ? data.jobNumber
        : `FJ-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${Math.random()
            .toString(36)
            .slice(2, 7)
            .toUpperCase()}`;

    const values = {
      title: data.title,
      description: data.description,
      jobKind: data.jobKind,
      priority: data.priority,
      customerCompanyId: data.customerCompanyId,
      customerContactId: data.customerContactId,
      siteAddress: data.siteAddress,
      siteLandmark: data.siteLandmark,
      siteLatitude: data.siteLatitude,
      siteLongitude: data.siteLongitude,
      windowStart: data.windowStart,
      windowEnd: data.windowEnd,
      estimatedMinutes: data.estimatedMinutes ?? null,
      assignedUserId: data.assignedUserId,
      crewName: data.crewName,
      quotedAmountMinor:
        data.quotedAmountMinor === null ? null : BigInt(data.quotedAmountMinor),
      updatedAt: new Date(),
    };

    const saved = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        if (data.id) {
          const [row] = await tx
            .update(fieldJobs)
            .set(values)
            .where(
              and(eq(fieldJobs.tenantId, ctx.tenant.id), eq(fieldJobs.id, data.id)),
            )
            .returning({ id: fieldJobs.id, jobNumber: fieldJobs.jobNumber });
          if (!row) throw new Error("That job no longer exists in this workspace.");
          return row;
        }
        const [row] = await tx
          .insert(fieldJobs)
          .values({
            tenantId: ctx.tenant.id,
            jobNumber,
            status: data.status,
            ...values,
          })
          .returning({ id: fieldJobs.id, jobNumber: fieldJobs.jobNumber });
        if (!row) throw new Error("The job could not be created.");
        return row;
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: data.id ? "update" : "create",
      resourceType: "field_job",
      resourceId: saved.id,
      // ⚠️ `reason`, not `summary`. There is no `summary` on AuditEntry.
      reason: `${saved.jobNumber} · ${data.jobKind} · ${data.priority}${
        data.assignedUserId ? "" : " · unassigned"
      }`,
      metadata: {
        jobKind: data.jobKind,
        priority: data.priority,
        windowStart: iso(data.windowStart),
        windowEnd: iso(data.windowEnd),
        assignedUserId: data.assignedUserId,
        quotedAmountMinor: data.quotedAmountMinor,
      },
    });

    revalidatePath("/field-jobs");
    return { ok: true, data: { id: saved.id, jobNumber: saved.jobNumber } };
  } catch (err) {
    const explained = explainFieldError(err);
    if (explained) return { ok: false, error: explained };
    return toSalesActionError(err, "field");
  }
}

const statusSchema = z.object({
  id: z.string().uuid(),
  status: z.enum([
    "draft",
    "scheduled",
    "dispatched",
    "travelling",
    "on_site",
    "paused",
    "completed",
    "could_not_complete",
    "cancelled",
  ]),
  /** ⚠️ REQUIRED for `could_not_complete`. The database refuses without it. */
  failureReason: z
    .enum([
      "customer_absent",
      "access_denied",
      "site_not_ready",
      "part_unavailable",
      "wrong_address",
      "unsafe_conditions",
      "weather",
      "vehicle_breakdown",
      "customer_refused",
      "other",
    ])
    .optional()
    .nullable(),
  failureNote: optionalText(2000),
});

/**
 * ⭐ MOVE A JOB THROUGH THE STATUS MACHINE.
 *
 * ⚠️ THE MACHINE ITSELF IS NOT HERE. `field_job_guard_transition()` owns
 * it — see the file header — and this function's job is to hand the
 * trigger's refusal back as the sentence it already is. The only checks
 * below are the two the trigger cannot phrase as helpfully as a form can,
 * and both are re-enforced underneath:
 *
 *   1. `could_not_complete` without a reason. The DB raises on it, but a
 *      form can say WHICH field is missing before the round trip.
 *   2. Nothing at all moves out of `completed`. The transition table has
 *      an empty list for it, so the trigger refuses — but a UI that
 *      offers the button and then apologises is a UI that has taught the
 *      dispatcher the system is unreliable.
 *
 * ⭐ `completed_at` IS STAMPED BY THE TRIGGER, NOT SET HERE. It also
 * refuses to complete a job with no checked-in visit against it, which is
 * the difference between a job that went perfectly and one closed by a
 * mis-tap on a list screen.
 */
export async function setFieldJobStatus(
  input: unknown,
): Promise<ActionResult<{ id: string; status: string }>> {
  try {
    const data = statusSchema.parse(input);
    const ctx = await guardSalesWrite({
      operation: "field:job:status",
      feature: FEATURE,
      permission: WRITE_PERMISSION,
      resource: { type: "field_job", id: data.id },
    });

    if (data.status === "could_not_complete" && !data.failureReason) {
      return {
        ok: false,
        error:
          "Say why it could not be done. \"Closed\" and \"completed\" are " +
          "different outcomes, and a team that keeps driving to sites and " +
          "finding nobody home has a scheduling problem that is invisible to " +
          "anyone reading a single closed flag.",
      };
    }

    const moved = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [before] = await tx
          .select({ status: fieldJobs.status, jobNumber: fieldJobs.jobNumber })
          .from(fieldJobs)
          .where(
            and(eq(fieldJobs.tenantId, ctx.tenant.id), eq(fieldJobs.id, data.id)),
          )
          .limit(1);

        if (!before) throw new Error("That job no longer exists in this workspace.");

        const [row] = await tx
          .update(fieldJobs)
          .set({
            status: data.status,
            /**
             * ⚠️ CLEARED when the job is not failing. A job re-scheduled
             * out of `could_not_complete` that keeps "customer absent"
             * hanging on it reads, on every later screen, as a job that
             * failed for a reason it did not.
             */
            failureReason:
              data.status === "could_not_complete" ? data.failureReason : null,
            failureNote:
              data.status === "could_not_complete" ? data.failureNote : null,
            updatedAt: new Date(),
          })
          .where(
            and(eq(fieldJobs.tenantId, ctx.tenant.id), eq(fieldJobs.id, data.id)),
          )
          .returning({ id: fieldJobs.id, status: fieldJobs.status });

        if (!row) throw new Error("That job no longer exists in this workspace.");
        return { ...row, from: before.status, jobNumber: before.jobNumber };
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: "update",
      resourceType: "field_job",
      resourceId: data.id,
      oldValue: { status: moved.from },
      newValue: { status: moved.status },
      reason: `${moved.jobNumber}: ${moved.from} → ${moved.status}${
        data.failureReason ? ` (${data.failureReason})` : ""
      }`,
      severity:
        data.status === "could_not_complete" || data.status === "cancelled"
          ? "notice"
          : "info",
    });

    revalidatePath("/field-jobs");
    return { ok: true, data: { id: moved.id, status: moved.status } };
  } catch (err) {
    const explained = explainFieldError(err);
    if (explained) return { ok: false, error: explained };
    return toSalesActionError(err, "field");
  }
}

/**
 * ⭐ RE-OPEN A FINISHED JOB BY RAISING A NEW ONE THAT REFERENCES IT.
 *
 * ⚠️ THIS IS THE ONLY WAY BACK FROM `completed`, AND THE REASON IS THE
 * FIRST-TIME-FIX RATE. If a completed job could be moved backwards and
 * completed again, every failed first attempt would edit itself out of
 * the record: the figure trends to 100% while the business gets worse,
 * and nobody can see it happening because the evidence is what is being
 * deleted.
 *
 * The link is kept in `metadata` on the new job, in both directions of
 * reading — the number and the id — so a later query can reconstruct the
 * chain without a schema change.
 */
export async function reopenFieldJob(
  input: unknown,
): Promise<ActionResult<{ id: string; jobNumber: string }>> {
  try {
    const data = z
      .object({
        id: z.string().uuid(),
        reason: z.string().trim().min(1, "Say what came back.").max(1000),
      })
      .parse(input);

    const ctx = await guardSalesWrite({
      operation: "field:job:reopen",
      feature: FEATURE,
      permission: WRITE_PERMISSION,
      resource: { type: "field_job", id: data.id },
    });

    const created = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [original] = await tx
          .select()
          .from(fieldJobs)
          .where(
            and(eq(fieldJobs.tenantId, ctx.tenant.id), eq(fieldJobs.id, data.id)),
          )
          .limit(1);

        if (!original) throw new Error("That job no longer exists in this workspace.");

        const jobNumber = `${original.jobNumber}-R${original.visitCount + 1}`;

        const [row] = await tx
          .insert(fieldJobs)
          .values({
            tenantId: ctx.tenant.id,
            jobNumber,
            title: `Re-visit: ${original.title}`.slice(0, 250),
            description: data.reason,
            jobKind: original.jobKind,
            // ⚠️ `scheduled`, not `draft` — something came back, and a
            // draft is a job nobody is expected to look at today.
            status: "scheduled",
            priority: original.priority,
            customerCompanyId: original.customerCompanyId,
            customerContactId: original.customerContactId,
            siteAddress: original.siteAddress,
            siteLandmark: original.siteLandmark,
            siteLatitude: original.siteLatitude,
            siteLongitude: original.siteLongitude,
            estimatedMinutes: original.estimatedMinutes,
            assignedUserId: original.assignedUserId,
            crewName: original.crewName,
            rateCardId: original.rateCardId,
            metadata: {
              reopenedFromJobId: original.id,
              reopenedFromJobNumber: original.jobNumber,
              reopenedReason: data.reason,
            },
          })
          .returning({ id: fieldJobs.id, jobNumber: fieldJobs.jobNumber });

        if (!row) throw new Error("The follow-up job could not be created.");
        return { ...row, fromNumber: original.jobNumber };
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: "create",
      resourceType: "field_job",
      resourceId: created.id,
      reason: `${created.jobNumber} raised against ${created.fromNumber} — ${data.reason}`,
      metadata: { reopenedFromJobId: data.id, reopenedFromJobNumber: created.fromNumber },
      severity: "notice",
    });

    revalidatePath("/field-jobs");
    return { ok: true, data: { id: created.id, jobNumber: created.jobNumber } };
  } catch (err) {
    const explained = explainFieldError(err);
    if (explained) return { ok: false, error: explained };
    return toSalesActionError(err, "field");
  }
}

/**
 * ⭐ Remove a job from the board.
 *
 * ⚠️ SOFT, BY SETTING `deleted_at`, AND NOT ONLY OUT OF CAUTION. The
 * composite foreign keys from visits, proofs and materials are ON DELETE
 * CASCADE, so a hard delete here takes the proof of service with it —
 * the photographs, the signature, the OTP verdict — which is the exact
 * evidence somebody would most want gone at the moment they most matter.
 */
export async function deleteFieldJob(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const { id } = z.object({ id: z.string().uuid() }).parse(input);
    const ctx = await guardSalesWrite({
      operation: "field:job:delete",
      feature: FEATURE,
      permission: WRITE_PERMISSION,
      resource: { type: "field_job", id },
      // ⚠️ Judged as a DESTRUCTIVE act by the impersonation policy rather
      // than as an ordinary dispatch edit. See guardSalesWrite.
      impersonationOperation: "delete:field_job",
    });

    await withTenant(
      ctx.tenant.id,
      async (tx) => {
        await tx
          .update(fieldJobs)
          .set({ deletedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(fieldJobs.tenantId, ctx.tenant.id), eq(fieldJobs.id, id)));
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: "delete",
      resourceType: "field_job",
      resourceId: id,
      reason: "job removed from the board; visits and proof of service are untouched",
      severity: "warning",
    });

    revalidatePath("/field-jobs");
    return { ok: true, data: { id } };
  } catch (err) {
    const explained = explainFieldError(err);
    if (explained) return { ok: false, error: explained };
    return toSalesActionError(err, "field");
  }
}

/* ------------------------------------------------------------------ */
/* WRITE — VISITS                                                      */
/* ------------------------------------------------------------------ */

const visitSchema = z
  .object({
    jobId: z.string().uuid("Choose a job."),

    /**
     * ⭐ CHOSEN ON THE DEVICE, BEFORE THE FIRST ATTEMPT. Not optional, and
     * not generated here: a key the server invents cannot tell a retry
     * from a second visit, because to the server they are two POSTs.
     */
    clientEventId: z
      .string()
      .trim()
      .min(1, "The device must supply an event id before its first attempt.")
      .max(120),

    checkedInAt: optionalMoment,
    checkedInLatitude: optionalCoord,
    checkedInLongitude: optionalCoord,
    /** Metres claimed by the handset. Large = a fix not worth trusting. */
    checkedInAccuracyM: z.coerce.number().int().min(0).max(100_000).optional().nullable(),

    checkedOutAt: optionalMoment,
    checkedOutLatitude: optionalCoord,
    checkedOutLongitude: optionalCoord,

    technicianUserId: optionalUuid,
    notes: optionalText(2000),
  })
  .refine(
    (d) =>
      (d.checkedInLatitude === null) === (d.checkedInLongitude === null),
    {
      message: "Give both the latitude and the longitude of the check-in, or neither.",
      path: ["checkedInLongitude"],
    },
  )
  .refine(
    (d) => !d.checkedInAt || !d.checkedOutAt || d.checkedOutAt >= d.checkedInAt,
    { message: "The check-out is earlier than the check-in.", path: ["checkedOutAt"] },
  );

/**
 * ⭐ RECORD A TRIP TO THE SITE.
 *
 * ⚠️ A DUPLICATE `client_event_id` IS A SUCCESS. The insert is
 * ON CONFLICT DO NOTHING against `field_visits_client_event_key`, and
 * when nothing comes back the existing row is returned with
 * `deduplicated: true`. See the file header — a phone that lost signal
 * mid-submit and retried has sent one event twice, and telling it "that
 * already exists" is how an app grows a force-resend button, which is how
 * a customer gets billed for two visits.
 *
 * ⚠️ THREE COLUMNS ARE NOT WRITTEN HERE AND MUST NOT BE.
 * `sequence`, `distance_from_site_m` and `is_distance_suspicious` are all
 * derived by `field_visit_derive()` — the sequence from a MAX over the
 * job's existing visits, the distance by haversine against the site.
 * Sending values for them would be a second opinion that eventually
 * disagrees with the first, on the one number a fraud conversation turns
 * on. `visit_count` on the job is likewise recounted by trigger.
 */
export async function recordFieldVisit(
  input: unknown,
): Promise<ActionResult<{ id: string; deduplicated: boolean }>> {
  try {
    const data = visitSchema.parse(input);
    const ctx = await guardSalesWrite({
      operation: "field:visit:record",
      feature: FEATURE,
      permission: WRITE_PERMISSION,
      resource: { type: "field_job", id: data.jobId },
    });

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const inserted = await tx
          .insert(fieldVisits)
          .values({
            tenantId: ctx.tenant.id,
            jobId: data.jobId,
            clientEventId: data.clientEventId,
            checkedInAt: data.checkedInAt,
            checkedInLatitude: data.checkedInLatitude,
            checkedInLongitude: data.checkedInLongitude,
            checkedInAccuracyM: data.checkedInAccuracyM ?? null,
            checkedOutAt: data.checkedOutAt,
            checkedOutLatitude: data.checkedOutLatitude,
            checkedOutLongitude: data.checkedOutLongitude,
            technicianUserId: data.technicianUserId ?? ctx.user.id,
            notes: data.notes,
          })
          // ⭐ THE RETRY COLLIDES WITH ITSELF AND IS ABSORBED.
          .onConflictDoNothing({
            target: [fieldVisits.tenantId, fieldVisits.clientEventId],
          })
          .returning({
            id: fieldVisits.id,
            distanceFromSiteM: fieldVisits.distanceFromSiteM,
            isDistanceSuspicious: fieldVisits.isDistanceSuspicious,
          });

        if (inserted[0]) return { row: inserted[0], deduplicated: false };

        const [existing] = await tx
          .select({
            id: fieldVisits.id,
            distanceFromSiteM: fieldVisits.distanceFromSiteM,
            isDistanceSuspicious: fieldVisits.isDistanceSuspicious,
          })
          .from(fieldVisits)
          .where(
            and(
              eq(fieldVisits.tenantId, ctx.tenant.id),
              eq(fieldVisits.clientEventId, data.clientEventId),
            ),
          )
          .limit(1);

        if (!existing) throw new Error("The visit could not be recorded.");
        return { row: existing, deduplicated: true };
      },
      { impersonationId: ctx.impersonationId },
    );

    /**
     * ⚠️ THE DUPLICATE IS NOT AUDITED AS A SECOND VISIT. An audit trail
     * that shows two check-ins where one happened is worse than one that
     * shows none, because it looks authoritative.
     */
    if (!result.deduplicated) {
      await writeAudit(ctx, {
        action: "create",
        resourceType: "field_visit",
        resourceId: result.row.id,
        reason: result.row.isDistanceSuspicious
          ? `visit recorded ${result.row.distanceFromSiteM} m from the site — flagged for a supervisor, not refused`
          : "visit recorded",
        metadata: {
          jobId: data.jobId,
          clientEventId: data.clientEventId,
          checkedInAt: iso(data.checkedInAt),
          checkedOutAt: iso(data.checkedOutAt),
          distanceFromSiteM: result.row.distanceFromSiteM,
          isDistanceSuspicious: result.row.isDistanceSuspicious,
        },
        severity: result.row.isDistanceSuspicious ? "notice" : "info",
      });
    }

    revalidatePath("/field-jobs");
    return {
      ok: true,
      data: { id: result.row.id, deduplicated: result.deduplicated },
    };
  } catch (err) {
    const explained = explainFieldError(err);
    if (explained) return { ok: false, error: explained };
    return toSalesActionError(err, "field");
  }
}

/* ------------------------------------------------------------------ */
/* WRITE — PROOF OF SERVICE                                            */
/* ------------------------------------------------------------------ */

const proofSchema = z.object({
  jobId: z.string().uuid("Choose a job."),
  visitId: z.string().uuid("Proof belongs to a visit, not to a job in general."),
  kind: z.enum([
    "photo_before",
    "photo_after",
    "signature",
    "otp",
    "barcode_scan",
    "document",
    "reading",
    "note",
  ]),
  value: optionalText(5000),
  storageKey: optionalText(500),
  acceptedByName: optionalText(200),
  /**
   * ⚠️ THE VERDICT, NEVER THE CODE. Storing the OTP itself would let
   * anyone with read access reconstruct an acceptance, which defeats the
   * entire purpose of having sent it to the customer's own number.
   */
  otpVerified: z.coerce.boolean().default(false),
  /** ⚠️ NOT NULL with NO DEFAULT in the database. Never send null. */
  capturedAt: z
    .union([z.string().trim().min(1), z.literal(""), z.null()])
    .optional()
    .transform((v) => (v ? new Date(v) : new Date()))
    .refine((d) => !Number.isNaN(d.getTime()), {
      message: "That is not a date and time this system can read.",
    }),
  capturedLatitude: optionalCoord,
  capturedLongitude: optionalCoord,
  clientEventId: z
    .string()
    .trim()
    .min(1, "The device must supply an event id before its first attempt.")
    .max(120),
});

/**
 * ⭐ APPEND A PIECE OF EVIDENCE. THERE IS NO SIBLING THAT EDITS ONE.
 *
 * ⚠️ IF AN "AMEND PROOF" FUNCTION EVER APPEARS NEXT TO THIS ONE, IT IS A
 * BUG. A photo that can be replaced after the fact is not evidence, it is
 * a picture — and the only reason a customer accepts "we attended and the
 * unit was working" is that nobody could have changed the record
 * afterwards. The database agrees twice over: a BEFORE UPDATE OR DELETE
 * trigger refuses with a sentence, and `ordence_app` holds no UPDATE or
 * DELETE privilege on the table at all.
 *
 * A correction is a NEW row saying what is now believed, alongside the
 * old one saying what was believed then.
 */
export async function recordFieldProof(
  input: unknown,
): Promise<ActionResult<{ id: string; deduplicated: boolean }>> {
  try {
    const data = proofSchema.parse(input);
    const ctx = await guardSalesWrite({
      operation: "field:proof:record",
      feature: FEATURE,
      permission: WRITE_PERMISSION,
      resource: { type: "field_job", id: data.jobId },
    });

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const inserted = await tx
          .insert(fieldProofs)
          .values({
            tenantId: ctx.tenant.id,
            jobId: data.jobId,
            visitId: data.visitId,
            kind: data.kind,
            value: data.value,
            storageKey: data.storageKey,
            acceptedByName: data.acceptedByName,
            otpVerified: data.otpVerified,
            capturedAt: data.capturedAt,
            capturedLatitude: data.capturedLatitude,
            capturedLongitude: data.capturedLongitude,
            clientEventId: data.clientEventId,
          })
          // ⭐ Same offline story as the visit. A retry is one event.
          .onConflictDoNothing({
            target: [fieldProofs.tenantId, fieldProofs.clientEventId],
          })
          .returning({ id: fieldProofs.id });

        if (inserted[0]) return { id: inserted[0].id, deduplicated: false };

        const [existing] = await tx
          .select({ id: fieldProofs.id })
          .from(fieldProofs)
          .where(
            and(
              eq(fieldProofs.tenantId, ctx.tenant.id),
              eq(fieldProofs.clientEventId, data.clientEventId),
            ),
          )
          .limit(1);

        if (!existing) throw new Error("The proof could not be recorded.");
        return { id: existing.id, deduplicated: true };
      },
      { impersonationId: ctx.impersonationId },
    );

    if (!result.deduplicated) {
      await writeAudit(ctx, {
        action: "create",
        resourceType: "field_proof",
        resourceId: result.id,
        reason: `${data.kind} captured${
          data.otpVerified ? " — OTP verified against the customer's own number" : ""
        }`,
        metadata: {
          jobId: data.jobId,
          visitId: data.visitId,
          kind: data.kind,
          acceptedByName: data.acceptedByName,
          otpVerified: data.otpVerified,
        },
      });
    }

    revalidatePath("/field-jobs");
    return { ok: true, data: { id: result.id, deduplicated: result.deduplicated } };
  } catch (err) {
    const explained = explainFieldError(err);
    if (explained) return { ok: false, error: explained };
    return toSalesActionError(err, "field");
  }
}

/* ------------------------------------------------------------------ */
/* WRITE — MATERIALS                                                   */
/* ------------------------------------------------------------------ */

const materialSchema = z.object({
  jobId: z.string().uuid("Choose a job."),
  /**
   * ⭐ RECORDED AGAINST THE VISIT WHERE POSSIBLE. A three-visit job that
   * fitted a part on the second and returned it on the third is two
   * movements, and a job-level quantity cannot express that — which is
   * exactly where van stock goes missing.
   */
  visitId: optionalUuid,
  itemCode: z.string().trim().min(1, "Which part?").max(100),
  itemName: z.string().trim().min(1, "Name the part.").max(250),
  /** ⚠️ NOT NULL and the database refuses zero. Negative = back to stock. */
  quantity: z
    .string()
    .trim()
    .regex(/^-?\d{1,14}(\.\d{1,4})?$/, "Up to four decimal places.")
    .refine((v) => Number(v) !== 0, {
      message:
        "A line of zero records nothing. Use a negative quantity to return a " +
        "part to van stock.",
    }),
  unit: z.string().trim().min(1).max(20).default("nos"),
  /** ⚠️ NOT NULL with a default of 0 in the database. Never send null. */
  unitCostMinor: paise.default("0"),
  isBillable: z.coerce.boolean().default(true),
  /** ⚠️ Stated, not inferred. Warranty work is fitted and not charged. */
  isWarranty: z.coerce.boolean().default(false),
  serialNumber: optionalText(120),
});

/** ⭐ What was actually fitted, against the trip on which it was fitted. */
export async function recordFieldMaterial(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const data = materialSchema.parse(input);
    const ctx = await guardSalesWrite({
      operation: "field:material:record",
      feature: FEATURE,
      permission: WRITE_PERMISSION,
      resource: { type: "field_job", id: data.jobId },
    });

    const id = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [row] = await tx
          .insert(fieldJobMaterials)
          .values({
            tenantId: ctx.tenant.id,
            jobId: data.jobId,
            visitId: data.visitId,
            itemCode: data.itemCode,
            itemName: data.itemName,
            quantity: data.quantity,
            unit: data.unit,
            unitCostMinor: BigInt(data.unitCostMinor),
            isBillable: data.isBillable,
            isWarranty: data.isWarranty,
            serialNumber: data.serialNumber,
          })
          .returning({ id: fieldJobMaterials.id });
        if (!row) throw new Error("The material line could not be recorded.");
        return row.id;
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: "create",
      resourceType: "field_job_material",
      resourceId: id,
      reason:
        Number(data.quantity) < 0
          ? `${data.quantity} ${data.unit} of ${data.itemCode} returned to stock`
          : `${data.quantity} ${data.unit} of ${data.itemCode} fitted${
              data.isWarranty ? " under warranty" : ""
            }`,
      metadata: {
        jobId: data.jobId,
        visitId: data.visitId,
        itemCode: data.itemCode,
        quantity: data.quantity,
        unitCostMinor: data.unitCostMinor,
        isBillable: data.isBillable,
        isWarranty: data.isWarranty,
      },
    });

    revalidatePath("/field-jobs");
    return { ok: true, data: { id } };
  } catch (err) {
    const explained = explainFieldError(err);
    if (explained) return { ok: false, error: explained };
    return toSalesActionError(err, "field");
  }
}
