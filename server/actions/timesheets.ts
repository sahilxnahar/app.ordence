"use server";

/**
 * Ordence — ⭐ TIMESHEETS · READ ACTIONS
 * Version: v0.70.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION. A `"use server"` file that
 * exports anything else publishes it as an RPC endpoint reachable by
 * anyone on the internet. The helpers below are not exported.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THERE IS NO TIMESHEET TABLE IN THIS PRODUCT, AND THIS FILE DOES NOT
 *    PRETEND OTHERWISE
 * ══════════════════════════════════════════════════════════════════════
 * A timesheet, in the sense a software or professional-services firm
 * means it, is: person × day × task × hours, with a billable flag, a
 * charge rate, a cost rate and an approval. None of those columns exist
 * anywhere in this schema. What exists is time recorded as a SIDE EFFECT
 * of doing work, in exactly two places:
 *
 *   `site_attendance`  — check_in / check_out punches, per person, per
 *                        project, with a geofence verdict. Time ON A
 *                        SITE. No task, no rate.
 *   `field_visits`     — `on_site_minutes`, derived by trigger from the
 *                        arrival and departure of one technician at one
 *                        JOB. Time ON A JOB. Still no task and no rate.
 *
 * `piece_rate_entries` measures OUTPUT, not time — quantity × rate, with
 * no duration anywhere on the row — so it is not a time source and is not
 * read here. `duty_rosters` is a PLAN: who was supposed to be where. It
 * is read here for exactly one purpose, below.
 *
 * ⚠️ SO THIS SCREEN REPORTS RECORDED TIME AND CALLS IT THAT. It cannot
 * produce a billable-hours report, an invoice from time, or utilisation
 * against a charge rate, and inventing a `billable` column to make it
 * look like it could would be a number somebody bills a client from.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE TWO SOURCES ARE NEVER ADDED TOGETHER. THIS IS THE DECISION.
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ A technician who punches in at the site AND logs a field visit at a
 * job on that site has produced two records of one afternoon. Summing
 * them double-counts the day — and the double-count is not uniform, so it
 * is invisible in a total and wrong per person. They are therefore
 * carried, reported and labelled separately, all the way to the page.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ AN UNCLOSED PUNCH IS NOT A LONG DAY
 * ══════════════════════════════════════════════════════════════════════
 * A check_in whose matching check_out never arrived would otherwise pair
 * with a check_out three days later and report a 68-hour shift. Pairs
 * longer than `MAX_SHIFT_HOURS` are treated as UNCLOSED rather than
 * counted: no lawful shift is that long, so a pair beyond it is a missing
 * punch, and a missing punch reported as work is a wage claim nobody can
 * defend. Unclosed punches get their own list because they are the thing
 * that has to be fixed while somebody still remembers the day.
 */

import { sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { requirePermission } from "@/server/audit";
import { toSalesActionError } from "@/server/sales/guards";
import type { ActionResult } from "@/lib/validators/crm";

/** Beyond any lawful shift. A pair longer than this is a missing punch. */
const MAX_SHIFT_HOURS = 16;

/** The reporting window. Long enough to cover a payroll month. */
const WINDOW_DAYS = 30;

/** How far back a roster gap is still worth chasing. */
const ROSTER_LOOKBACK_DAYS = 14;

/* ------------------------------------------------------------------ */
/* SHAPES                                                              */
/* ------------------------------------------------------------------ */

/** Time from paired attendance punches, per person, over the window. */
export type AttendanceTimeRow = {
  subjectId: string;
  name: string;
  /** "staff" (a user) or "worker" (a site worker on a contractor's roll). */
  kind: "staff" | "worker";
  trade: string | null;
  /** Days on which at least one check-in was recorded. */
  daysPresent: number;
  /** Sum of paired shifts, in minutes. Never mixed with visit minutes. */
  pairedMinutes: number;
  /** Check-ins with no usable check-out. Time that was never recorded. */
  unclosedPunches: number;
  /** Punches captured offline and replayed later. Device-clock claims. */
  offlinePunches: number;
  projectsWorked: number;
};

/** Time from field visits, per technician, over the window. */
export type VisitTimeRow = {
  userId: string;
  name: string;
  visits: number;
  /** Sum of `on_site_minutes`. Never mixed with attendance minutes. */
  onSiteMinutes: number;
  /** Visits checked in and never checked out. Minutes are null on these. */
  openVisits: number;
  /** Visits whose check-in was suspiciously far from the site. */
  suspiciousVisits: number;
};

/** A check-in with no usable check-out. */
export type OpenPunch = {
  id: string;
  name: string;
  kind: "staff" | "worker";
  projectName: string | null;
  occurredAt: string;
  hoursOpen: number;
  isOffline: boolean;
};

/** A visit somebody arrived at and never left, per the record. */
export type OpenVisit = {
  id: string;
  jobNumber: string;
  jobTitle: string;
  technicianName: string | null;
  checkedInAt: string;
  hoursOpen: number;
};

/** Rostered for a shift, with no time recorded from either source. */
export type RosterGap = {
  id: string;
  rosterDate: string;
  shift: string;
  name: string;
  projectName: string | null;
};

/** Where the recorded time went, by project. Attendance only. */
export type ProjectTimeRow = {
  projectId: string | null;
  projectName: string | null;
  pairedMinutes: number;
  people: number;
};

export type TimesheetView = {
  windowDays: number;
  windowStart: string;
  openPunches: OpenPunch[];
  openVisits: OpenVisit[];
  rosterGaps: RosterGap[];
  attendance: AttendanceTimeRow[];
  visits: VisitTimeRow[];
  byProject: ProjectTimeRow[];
  /** ⚠️ Totals are per source and are NEVER added. See the header. */
  totalAttendanceMinutes: number;
  totalVisitMinutes: number;
};

/* ------------------------------------------------------------------ */
/* HELPERS — not exported.                                             */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ `tx.execute` RETURNS EITHER AN ARRAY OR `{ rows }` DEPENDING ON THE
 * DRIVER PATH. Reading the wrong one yields an empty result rather than
 * an error — a timesheet that silently shows nobody worked.
 */
function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

function num(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === "" ? null : s;
}

function iso(value: unknown): string {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/* ------------------------------------------------------------------ */
/* THE READ                                                            */
/* ------------------------------------------------------------------ */

export async function getTimesheets(): Promise<ActionResult<TimesheetView>> {
  try {
    const ctx = await requirePermission("labour.timesheets.read");

    const windowStart = new Date(Date.now() - WINDOW_DAYS * 86_400_000);

    const data = await withTenant(ctx.tenant.id, async (tx) => {
      /* ── PAIRED ATTENDANCE ─────────────────────────────────────────
       *
       * ⭐ `LEAD()` OVER THE SUBJECT'S OWN PUNCHES, IN TIME ORDER. Each
       * check_in is paired with whatever came next for that person.
       *
       * ⚠️ PARTITIONED BY THE SUBJECT, NOT BY THE DAY. A night shift
       * starting at 21:00 and ending at 05:00 is one shift, and a
       * per-day partition would report it as two unclosed punches and
       * eight unrecorded hours every single night.
       *
       * ⚠️ AND `worker_id` IS AS VALID A SUBJECT AS `user_id`. The table
       * has a CHECK forcing exactly one of them, so `COALESCE` picks the
       * one that is set — dropping worker punches would silently exclude
       * everybody on a contractor's roll, which on a site is most of the
       * people who were there.
       */
      const attendanceRows = rowsOf(
        await tx.execute(sql`
          WITH punches AS (
            SELECT
              a.id,
              COALESCE(a.user_id, a.worker_id)                AS subject_id,
              a.user_id,
              a.worker_id,
              a.project_id,
              a.kind,
              a.occurred_at,
              a.is_offline,
              LEAD(a.occurred_at) OVER (
                PARTITION BY COALESCE(a.user_id, a.worker_id)
                ORDER BY a.occurred_at
              )                                               AS next_at,
              LEAD(a.kind) OVER (
                PARTITION BY COALESCE(a.user_id, a.worker_id)
                ORDER BY a.occurred_at
              )                                               AS next_kind
            FROM site_attendance a
            WHERE a.tenant_id = ${ctx.tenant.id}
              AND a.occurred_at >= ${windowStart.toISOString()}::timestamptz
          ),
          shifts AS (
            SELECT
              p.*,
              (p.next_kind = 'check_out'
               AND p.next_at IS NOT NULL
               AND p.next_at - p.occurred_at
                   <= make_interval(hours => ${sql.raw(String(MAX_SHIFT_HOURS))})) AS is_closed,
              CASE WHEN p.next_kind = 'check_out'
                    AND p.next_at IS NOT NULL
                    AND p.next_at - p.occurred_at
                        <= make_interval(hours => ${sql.raw(String(MAX_SHIFT_HOURS))})
                   THEN EXTRACT(EPOCH FROM (p.next_at - p.occurred_at)) / 60
                   ELSE 0 END                                     AS minutes
            FROM punches p
            WHERE p.kind = 'check_in'
          )
          SELECT
            s.subject_id,
            MAX(CASE WHEN s.user_id IS NOT NULL THEN 'staff' ELSE 'worker' END)
                                                                AS subject_kind,
            COALESCE(
              MAX(NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), '')),
              MAX(u.email),
              MAX(w.worker_name),
              'Unknown'
            )                                                   AS name,
            MAX(w.trade)                                        AS trade,
            COUNT(DISTINCT s.occurred_at::date)::int            AS days_present,
            COALESCE(ROUND(SUM(s.minutes)), 0)::int             AS paired_minutes,
            COUNT(*) FILTER (WHERE NOT s.is_closed)::int        AS unclosed_punches,
            COUNT(*) FILTER (WHERE s.is_offline)::int           AS offline_punches,
            COUNT(DISTINCT s.project_id)::int                   AS projects_worked
          FROM shifts s
          LEFT JOIN users u
            ON u.id = s.user_id AND u.tenant_id = ${ctx.tenant.id}
          LEFT JOIN site_workers w
            ON w.id = s.worker_id AND w.tenant_id = ${ctx.tenant.id}
          GROUP BY s.subject_id
          ORDER BY paired_minutes DESC
          LIMIT 200
        `),
      );

      /* ── UNCLOSED PUNCHES, LISTED ──────────────────────────────────
       *
       * The same pairing, kept as rows. ⚠️ THE MOST RECENT CHECK-IN IS
       * EXCLUDED WHEN IT IS LESS THAN AN HOUR OLD — somebody who arrived
       * twenty minutes ago has not failed to check out, and putting them
       * on an exceptions list every morning is how the list gets ignored.
       */
      const openPunchRows = rowsOf(
        await tx.execute(sql`
          WITH punches AS (
            SELECT
              a.id,
              a.user_id,
              a.worker_id,
              a.project_id,
              a.kind,
              a.occurred_at,
              a.is_offline,
              LEAD(a.occurred_at) OVER (
                PARTITION BY COALESCE(a.user_id, a.worker_id)
                ORDER BY a.occurred_at
              )                                               AS next_at,
              LEAD(a.kind) OVER (
                PARTITION BY COALESCE(a.user_id, a.worker_id)
                ORDER BY a.occurred_at
              )                                               AS next_kind
            FROM site_attendance a
            WHERE a.tenant_id = ${ctx.tenant.id}
              AND a.occurred_at >= ${windowStart.toISOString()}::timestamptz
          )
          SELECT
            p.id,
            CASE WHEN p.user_id IS NOT NULL THEN 'staff' ELSE 'worker' END
                                                              AS subject_kind,
            COALESCE(
              NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), ''),
              u.email,
              w.worker_name,
              'Unknown'
            )                                                 AS name,
            pr.name                                           AS project_name,
            p.occurred_at,
            p.is_offline,
            ROUND(EXTRACT(EPOCH FROM (now() - p.occurred_at)) / 3600)::int
                                                              AS hours_open
          FROM punches p
          LEFT JOIN users u
            ON u.id = p.user_id AND u.tenant_id = ${ctx.tenant.id}
          LEFT JOIN site_workers w
            ON w.id = p.worker_id AND w.tenant_id = ${ctx.tenant.id}
          LEFT JOIN projects pr
            ON pr.id = p.project_id AND pr.tenant_id = ${ctx.tenant.id}
          WHERE p.kind = 'check_in'
            AND p.occurred_at < now() - interval '1 hour'
            AND (
              p.next_at IS NULL
              OR p.next_kind <> 'check_out'
              OR p.next_at - p.occurred_at
                 > make_interval(hours => ${sql.raw(String(MAX_SHIFT_HOURS))})
            )
          ORDER BY p.occurred_at DESC
          LIMIT 60
        `),
      );

      /* ── FIELD VISITS ──────────────────────────────────────────────
       *
       * ⚠️ `on_site_minutes` IS DERIVED BY TRIGGER FROM THE DEVICE
       * CLOCK, not from when the server heard about the visit. A visit
       * recorded at 11:05 and synced at 18:40 is an 11:05 visit — that is
       * the whole offline design — so nothing here recomputes it from
       * `synced_at`.
       */
      const visitRows = rowsOf(
        await tx.execute(sql`
          SELECT
            v.technician_user_id                              AS user_id,
            COALESCE(
              NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), ''),
              u.email,
              'Unassigned'
            )                                                 AS name,
            COUNT(*)::int                                     AS visits,
            COALESCE(SUM(v.on_site_minutes), 0)::int          AS on_site_minutes,
            COUNT(*) FILTER (
              WHERE v.checked_in_at IS NOT NULL AND v.checked_out_at IS NULL
            )::int                                            AS open_visits,
            COUNT(*) FILTER (WHERE v.is_distance_suspicious)::int
                                                              AS suspicious_visits
          FROM field_visits v
          LEFT JOIN users u
            ON u.id = v.technician_user_id AND u.tenant_id = ${ctx.tenant.id}
          WHERE v.tenant_id = ${ctx.tenant.id}
            AND v.checked_in_at >= ${windowStart.toISOString()}::timestamptz
          GROUP BY v.technician_user_id, u.first_name, u.last_name, u.email
          ORDER BY on_site_minutes DESC
          LIMIT 200
        `),
      );

      const openVisitRows = rowsOf(
        await tx.execute(sql`
          SELECT
            v.id,
            j.job_number,
            j.title                                           AS job_title,
            COALESCE(
              NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), ''),
              u.email
            )                                                 AS technician_name,
            v.checked_in_at,
            ROUND(EXTRACT(EPOCH FROM (now() - v.checked_in_at)) / 3600)::int
                                                              AS hours_open
          FROM field_visits v
          JOIN field_jobs j
            ON j.id = v.job_id AND j.tenant_id = v.tenant_id
          LEFT JOIN users u
            ON u.id = v.technician_user_id AND u.tenant_id = ${ctx.tenant.id}
          WHERE v.tenant_id = ${ctx.tenant.id}
            AND v.checked_in_at IS NOT NULL
            AND v.checked_out_at IS NULL
            AND v.checked_in_at < now() - interval '1 hour'
          ORDER BY v.checked_in_at DESC
          LIMIT 60
        `),
      );

      /* ── ROSTERED, NOTHING RECORDED ────────────────────────────────
       *
       * ⭐ THE ONLY THING ON THIS PAGE THAT FINDS TIME NOBODY ENTERED.
       * Every other panel reports what WAS recorded, so a person who
       * simply never punched is invisible in all of them — and a missing
       * timesheet does not look like anything until payroll.
       *
       * ⚠️ TODAY IS EXCLUDED. A shift in progress is not a gap.
       *
       * ⚠️ `occurred_at::date` RESOLVES IN THE DATABASE SESSION'S
       * TIMEZONE. For a workspace operating in one country that is
       * exactly right; for a night shift crossing midnight it can put the
       * punch on the following roster date. That is stated rather than
       * papered over — the alternative is a per-tenant timezone the
       * roster table does not carry.
       */
      const rosterGapRows = rowsOf(
        await tx.execute(sql`
          SELECT
            r.id,
            r.roster_date,
            r.shift::text                                     AS shift,
            COALESCE(
              NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), ''),
              u.email,
              'Unknown'
            )                                                 AS name,
            p.name                                            AS project_name
          FROM duty_rosters r
          JOIN users u
            ON u.id = r.user_id AND u.tenant_id = r.tenant_id
          LEFT JOIN projects p
            ON p.id = r.project_id AND p.tenant_id = r.tenant_id
          WHERE r.tenant_id = ${ctx.tenant.id}
            AND r.shift <> 'off'
            AND r.roster_date >= (CURRENT_DATE - make_interval(days => ${sql.raw(String(ROSTER_LOOKBACK_DAYS))}))::date
            AND r.roster_date < CURRENT_DATE
            AND NOT EXISTS (
              SELECT 1 FROM site_attendance a
               WHERE a.tenant_id = r.tenant_id
                 AND a.user_id = r.user_id
                 AND a.kind = 'check_in'
                 AND a.occurred_at::date = r.roster_date
            )
            AND NOT EXISTS (
              SELECT 1 FROM field_visits v
               WHERE v.tenant_id = r.tenant_id
                 AND v.technician_user_id = r.user_id
                 AND v.checked_in_at::date = r.roster_date
            )
          ORDER BY r.roster_date DESC, name
          LIMIT 80
        `),
      );

      /* ── BY PROJECT ────────────────────────────────────────────────
       *
       * ⚠️ ATTENDANCE ONLY. `field_visits` has no project — it hangs off
       * a JOB, which has a customer and a site address and no project id
       * — so folding the two together here would attribute a technician's
       * afternoon to whichever project happened to be handy.
       */
      const projectRows = rowsOf(
        await tx.execute(sql`
          WITH punches AS (
            SELECT
              COALESCE(a.user_id, a.worker_id)                AS subject_id,
              a.project_id,
              a.kind,
              a.occurred_at,
              LEAD(a.occurred_at) OVER (
                PARTITION BY COALESCE(a.user_id, a.worker_id)
                ORDER BY a.occurred_at
              )                                               AS next_at,
              LEAD(a.kind) OVER (
                PARTITION BY COALESCE(a.user_id, a.worker_id)
                ORDER BY a.occurred_at
              )                                               AS next_kind
            FROM site_attendance a
            WHERE a.tenant_id = ${ctx.tenant.id}
              AND a.occurred_at >= ${windowStart.toISOString()}::timestamptz
          )
          SELECT
            p.project_id,
            pr.name                                           AS project_name,
            COALESCE(ROUND(SUM(
              CASE WHEN p.next_kind = 'check_out'
                    AND p.next_at IS NOT NULL
                    AND p.next_at - p.occurred_at
                        <= make_interval(hours => ${sql.raw(String(MAX_SHIFT_HOURS))})
                   THEN EXTRACT(EPOCH FROM (p.next_at - p.occurred_at)) / 60
                   ELSE 0 END
            )), 0)::int                                       AS paired_minutes,
            COUNT(DISTINCT p.subject_id)::int                 AS people
          FROM punches p
          LEFT JOIN projects pr
            ON pr.id = p.project_id AND pr.tenant_id = ${ctx.tenant.id}
          WHERE p.kind = 'check_in'
          GROUP BY p.project_id, pr.name
          ORDER BY paired_minutes DESC
          LIMIT 60
        `),
      );

      return {
        attendanceRows,
        openPunchRows,
        visitRows,
        openVisitRows,
        rosterGapRows,
        projectRows,
      };
    });

    const attendance: AttendanceTimeRow[] = data.attendanceRows.map((r) => ({
      subjectId: String(r.subject_id),
      name: String(r.name ?? "Unknown"),
      kind: r.subject_kind === "staff" ? "staff" : "worker",
      trade: text(r.trade),
      daysPresent: num(r.days_present),
      pairedMinutes: num(r.paired_minutes),
      unclosedPunches: num(r.unclosed_punches),
      offlinePunches: num(r.offline_punches),
      projectsWorked: num(r.projects_worked),
    }));

    const visits: VisitTimeRow[] = data.visitRows.map((r) => ({
      userId: String(r.user_id ?? ""),
      name: String(r.name ?? "Unassigned"),
      visits: num(r.visits),
      onSiteMinutes: num(r.on_site_minutes),
      openVisits: num(r.open_visits),
      suspiciousVisits: num(r.suspicious_visits),
    }));

    return {
      ok: true,
      data: {
        windowDays: WINDOW_DAYS,
        windowStart: windowStart.toISOString(),
        openPunches: data.openPunchRows.map((r) => ({
          id: String(r.id),
          name: String(r.name ?? "Unknown"),
          kind: r.subject_kind === "staff" ? "staff" : "worker",
          projectName: text(r.project_name),
          occurredAt: iso(r.occurred_at),
          hoursOpen: num(r.hours_open),
          isOffline: Boolean(r.is_offline),
        })),
        openVisits: data.openVisitRows.map((r) => ({
          id: String(r.id),
          jobNumber: String(r.job_number ?? ""),
          jobTitle: String(r.job_title ?? ""),
          technicianName: text(r.technician_name),
          checkedInAt: iso(r.checked_in_at),
          hoursOpen: num(r.hours_open),
        })),
        rosterGaps: data.rosterGapRows.map((r) => ({
          id: String(r.id),
          rosterDate: String(r.roster_date ?? "").slice(0, 10),
          shift: String(r.shift ?? ""),
          name: String(r.name ?? "Unknown"),
          projectName: text(r.project_name),
        })),
        attendance,
        visits,
        byProject: data.projectRows.map((r) => ({
          projectId: text(r.project_id),
          projectName: text(r.project_name),
          pairedMinutes: num(r.paired_minutes),
          people: num(r.people),
        })),
        // ⚠️ TWO TOTALS, NEVER ONE. See the header.
        totalAttendanceMinutes: attendance.reduce((t, a) => t + a.pairedMinutes, 0),
        totalVisitMinutes: visits.reduce((t, v) => t + v.onSiteMinutes, 0),
      },
    };
  } catch (err) {
    return toSalesActionError(err, "getTimesheets");
  }
}
