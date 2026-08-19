"use server";

/**
 * Ordence — HEARINGS · THE DATED REGISTER
 * Version: v0.70.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION. A `"use server"` file that exports
 * anything else publishes it as an RPC endpoint reachable by anyone on
 * the internet. The helpers below are deliberately not exported.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE SOURCE, AND WHY IT IS TWO TABLES AND NOT A NEW ONE
 * ══════════════════════════════════════════════════════════════════════
 * There is no `hearings` table in this schema and this file does not
 * invent one. A hearing is two facts a chambers already records
 * elsewhere, and both are already tenant-scoped, RLS-protected and
 * enforced:
 *
 *   `schedule_bookings` — a period of time committed against a resource,
 *     with a party, a reference and a lifecycle. A listing before a court
 *     is exactly that: a hall, a slot or a counsel, held from 10:30 to
 *     11:00, for a named party, under a matter number.
 *   `compliance_tasks`  — a statutory date with a derived deadline. A
 *     limitation date, a filing, a return. It sits on the same diary as
 *     the hearings and is missed for the same reason.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE KIND FILTER IS A CLASSIFICATION, NOT A GATE — AND THAT IS THE
 *    LOAD-BEARING DECISION IN THIS FILE
 * ══════════════════════════════════════════════════════════════════════
 * `resource_kind` has no `court` member. It has `hall`, `slot`,
 * `practitioner`, `room`, `bed`, `table`, `vehicle`, `equipment`,
 * `staff`, `other`. A firm that records its courtrooms will use `hall`;
 * one that records listing slots will use `slot`; a counsel's own diary
 * is a `practitioner`.
 *
 * ⚠️ SO A HARD `WHERE kind IN (...)` IS A SCREEN THAT SILENTLY SHOWS
 * NOTHING the day a chambers types `room` instead of `hall` — and an
 * empty hearings calendar is indistinguishable from a quiet week. Nobody
 * files a bug about a quiet week.
 *
 * Every dated booking is therefore returned. `isHearingShaped` marks the
 * three kinds that mean "a matter is listed somewhere", the page leads
 * with those, and everything else is shown for what it is rather than
 * dropped. A classification can be argued with; a filter that removed
 * the row cannot.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ TWO PERMISSIONS, AND THE SECOND ONE IS SOFT ON PURPOSE
 * ══════════════════════════════════════════════════════════════════════
 * The diary needs `scheduling.bookings.read`; the statutory dates need
 * `compliance.calendar.read`. Requiring both would deny the entire
 * calendar to a clerk who holds one — so the first is REQUIRED and the
 * second is checked with the side-effect-free `can()`. When it is
 * absent, `deadlinesVisible` comes back false and the page SAYS the
 * statutory dates are hidden. A calendar that quietly omits half its
 * sources looks exactly like a calendar with nothing in it.
 *
 * `can()` rather than `checkPermission()` because the latter writes a
 * denial row on every page load by every user without the key, and
 * within a week the denial log is buried under "a clerk opened the
 * diary".
 */

import { and, asc, eq, isNull } from "drizzle-orm";
import { withTenant } from "@/db";
import { scheduleBookings, scheduleResources } from "@/db/schema/scheduling";
import { complianceTasks, complianceObligations } from "@/db/schema/compliance";
import { requirePermission } from "@/server/audit";
import { can } from "@/lib/permissions";
import type { ActionResult } from "@/lib/validators/crm";

/* ------------------------------------------------------------------ */
/* SHAPES                                                              */
/* ------------------------------------------------------------------ */

export type CalendarItem = {
  id: string;
  /** Which table this came from. Never merged away — see the header. */
  source: "hearing" | "deadline";
  title: string;
  subtitle: string | null;
  /** Where or before whom. Resource name, or the authority. */
  venue: string | null;
  /** The resource kind, or the compliance authority. */
  kind: string;
  /** ⭐ True for the three kinds that mean "a matter is listed". */
  isHearingShaped: boolean;
  /** YYYY-MM-DD, in UTC, for grouping. */
  date: string;
  /** Full instant for a hearing; midnight for a statutory date. */
  startsAt: string;
  endsAt: string | null;
  /** Statutory dates have no clock — showing 00:00 would be a lie. */
  hasTime: boolean;
  status: string;
  /** Nothing further is expected of anybody on this item. */
  settled: boolean;
  reference: string | null;
  /** Negative = in the past. */
  daysUntil: number;
  /** A provisional date somebody has not confirmed. Minutes, or null. */
  holdMinutesLeft: number | null;
};

export type Clash = {
  /** The two items that overlap. */
  a: CalendarItem;
  b: CalendarItem;
  /** Minutes of overlap. */
  overlapMinutes: number;
};

/* ------------------------------------------------------------------ */
/* HELPERS — not exported. See the header.                             */
/* ------------------------------------------------------------------ */

/**
 * ⭐ The kinds that mean "a matter is listed somewhere".
 *
 * ⚠️ Used to CLASSIFY and to order the page, never to exclude a row.
 * See the header for why that distinction is the whole design.
 */
const HEARING_KINDS = new Set(["hall", "slot", "practitioner"]);

/**
 * ⚠️ MUST MATCH `CAPACITY_CONSUMING_STATUSES` in `db/schema/scheduling.ts`.
 * A booking this screen thinks is finished, but the database thinks still
 * occupies the court, is a date this page will not chase.
 */
const BOOKING_LIVE = new Set(["held", "confirmed", "checked_in", "in_progress"]);

/** Compliance statuses that expect nothing further of anybody. */
const COMPLIANCE_SETTLED = new Set([
  "filed",
  "late_filed",
  "not_applicable",
  "waived",
]);

function iso(d: Date | string | null): string | null {
  if (!d) return null;
  return typeof d === "string" ? d : d.toISOString();
}

function dayKey(instant: string): string {
  return instant.slice(0, 10);
}

/** Whole days from today (UTC) to a YYYY-MM-DD. Negative = past. */
function daysUntilDay(dateOnly: string): number {
  const target = new Date(`${dateOnly}T00:00:00.000Z`).getTime();
  if (Number.isNaN(target)) return 0;
  const now = new Date();
  const todayUtc = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  return Math.round((target - todayUtc) / 86_400_000);
}

/**
 * ⭐ FIND ITEMS THAT OVERLAP IN TIME.
 *
 * ⚠️ This is NOT the double-booking check. Two bookings on ONE resource
 * are already impossible — the database refuses them under an exclusion
 * constraint (SQL 0033). What this finds is the thing the database is
 * right to permit and a person cannot survive: the same chambers listed
 * before two DIFFERENT courts at overlapping times. Both rows are
 * individually legitimate; the pair is not.
 *
 * Sweep over a start-sorted list, so this is O(n log n) plus the
 * overlapping pairs themselves rather than O(n²).
 */
function findClashes(items: CalendarItem[]): Clash[] {
  const timed = items
    .filter((i) => i.hasTime && !i.settled && i.endsAt !== null)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));

  const clashes: Clash[] = [];
  for (let i = 0; i < timed.length; i += 1) {
    const a = timed[i];
    if (!a) continue;
    const aEnd = new Date(a.endsAt as string).getTime();
    for (let j = i + 1; j < timed.length; j += 1) {
      const b = timed[j];
      if (!b) continue;
      const bStart = new Date(b.startsAt).getTime();
      // Sorted by start, so once one starts after `a` ends, so does
      // every later one. Half-open: touching is not overlapping.
      if (bStart >= aEnd) break;
      const overlapEnd = Math.min(aEnd, new Date(b.endsAt as string).getTime());
      clashes.push({
        a,
        b,
        overlapMinutes: Math.max(1, Math.round((overlapEnd - bStart) / 60_000)),
      });
      if (clashes.length >= 50) return clashes;
    }
  }
  return clashes;
}

/* ------------------------------------------------------------------ */
/* READ                                                                */
/* ------------------------------------------------------------------ */

/**
 * Every dated commitment in the workspace, and the ones that have gone
 * past without anybody recording an outcome.
 */
export async function listHearingCalendar(): Promise<
  ActionResult<{
    items: CalendarItem[];
    /**
     * ⭐ Dates that have PASSED with the item still open. These lead the
     * page — see the note where they are computed.
     */
    passedWithoutOutcome: CalendarItem[];
    /** ⭐ Two commitments at overlapping times. You cannot attend both. */
    clashes: Clash[];
    /** Provisional dates nobody has confirmed, expiring or already expired. */
    provisional: CalendarItem[];
    today: CalendarItem[];
    next7Days: CalendarItem[];
    /** False when the caller lacks `compliance.calendar.read`. */
    deadlinesVisible: boolean;
    /** How many of the returned items are hearing-shaped. */
    hearingCount: number;
    deadlineCount: number;
    /**
     * ⚠️ Bookings whose resource kind is NOT one of the three hearing
     * kinds. Reported so a chambers that typed `room` can see why its
     * hearings are not being called hearings.
     */
    otherKindCount: number;
  }>
> {
  try {
    /**
     * ⚠️ BOTH KEYS EXIST IN `PERMISSION_CATALOG`. A key that is absent
     * fails closed for every role including the owner, and presents as
     * "you do not have access" rather than as the bug it is.
     */
    const ctx = await requirePermission("scheduling.bookings.read");

    const deadlinesVisible = can(
      { role: ctx.role, overrides: ctx.user.permissionOverrides },
      "compliance.calendar.read",
    );

    const payload = await withTenant(ctx.tenant.id, async (tx) => {
      const bookings = await tx
        .select({
          id: scheduleBookings.id,
          reference: scheduleBookings.reference,
          startsAt: scheduleBookings.startsAt,
          endsAt: scheduleBookings.endsAt,
          status: scheduleBookings.status,
          partyName: scheduleBookings.partyName,
          holdExpiresAt: scheduleBookings.holdExpiresAt,
          resourceName: scheduleResources.name,
          resourceKind: scheduleResources.kind,
          resourceGroup: scheduleResources.groupName,
        })
        .from(scheduleBookings)
        .innerJoin(
          scheduleResources,
          and(
            eq(scheduleResources.id, scheduleBookings.resourceId),
            eq(scheduleResources.tenantId, scheduleBookings.tenantId),
          ),
        )
        .where(eq(scheduleBookings.tenantId, ctx.tenant.id))
        .orderBy(asc(scheduleBookings.startsAt))
        .limit(1000);

      /* ⚠️ The statutory half is skipped ENTIRELY, not filtered after the
       * fact, when the caller lacks the key. Reading rows a caller may
       * not see and discarding them later is how a refactor turns a
       * permission check into a decoration. */
      const deadlines = deadlinesVisible
        ? await tx
            .select({
              id: complianceTasks.id,
              dueDate: complianceTasks.dueDate,
              status: complianceTasks.status,
              severity: complianceTasks.severity,
              periodLabel: complianceTasks.periodLabel,
              filingReference: complianceTasks.filingReference,
              obligationName: complianceObligations.name,
              authority: complianceObligations.authority,
            })
            .from(complianceTasks)
            .innerJoin(
              complianceObligations,
              and(
                eq(complianceObligations.id, complianceTasks.obligationId),
                eq(complianceObligations.tenantId, complianceTasks.tenantId),
                isNull(complianceObligations.deletedAt),
              ),
            )
            .where(eq(complianceTasks.tenantId, ctx.tenant.id))
            .orderBy(asc(complianceTasks.dueDate))
            .limit(1000)
        : [];

      return { bookings, deadlines };
    });

    const now = Date.now();

    const hearingItems: CalendarItem[] = payload.bookings.map((b) => {
      const startsAt = iso(b.startsAt) ?? "";
      const endsAt = iso(b.endsAt);
      const holdIso = iso(b.holdExpiresAt);
      const date = dayKey(startsAt);
      return {
        id: b.id,
        source: "hearing" as const,
        title: b.partyName ?? b.reference,
        subtitle: b.partyName ? b.reference : null,
        venue: [b.resourceName, b.resourceGroup].filter(Boolean).join(" · ") || null,
        kind: b.resourceKind,
        isHearingShaped: HEARING_KINDS.has(b.resourceKind),
        date,
        startsAt,
        endsAt,
        hasTime: true,
        status: b.status,
        settled: !BOOKING_LIVE.has(b.status),
        reference: b.reference,
        daysUntil: daysUntilDay(date),
        holdMinutesLeft:
          b.status === "held" && holdIso
            ? Math.round((new Date(holdIso).getTime() - now) / 60_000)
            : null,
      };
    });

    const deadlineItems: CalendarItem[] = payload.deadlines.map((d) => ({
      id: d.id,
      source: "deadline" as const,
      title: d.obligationName,
      subtitle: d.periodLabel,
      venue: d.authority,
      kind: d.authority,
      isHearingShaped: false,
      date: d.dueDate,
      /* ⚠️ Midnight UTC, and `hasTime: false` beside it. A statutory
       * deadline has a DAY, not a clock — rendering it as 00:00 invents
       * a time somebody will eventually plan a morning around. */
      startsAt: `${d.dueDate}T00:00:00.000Z`,
      endsAt: null,
      hasTime: false,
      status: d.status,
      settled: COMPLIANCE_SETTLED.has(d.status),
      reference: d.filingReference,
      daysUntil: daysUntilDay(d.dueDate),
      holdMinutesLeft: null,
    }));

    const items = [...hearingItems, ...deadlineItems].sort((a, b) =>
      a.startsAt.localeCompare(b.startsAt),
    );

    /**
     * ⭐ THE LEAD: A DATE THAT CAME AND WENT WITH NOTHING RECORDED.
     *
     * ⚠️ This is the only failure on the calendar that is invisible by
     * construction. A hearing still marked `confirmed` a fortnight after
     * it was listed looks identical, in every list, to one next
     * fortnight — same row, same fields, one digit different in a date
     * nobody re-reads. From outside the file, an adjournment nobody
     * recorded and an ex-parte order passed in your absence are the same
     * row. One of them is a costs order.
     *
     * A booking is counted here only once it has ENDED, not merely
     * started, so a matter part-heard this afternoon is not shouted
     * about at 3pm.
     */
    const passedWithoutOutcome = items
      .filter((i) => {
        if (i.settled) return false;
        if (i.source === "hearing") {
          return i.endsAt !== null && new Date(i.endsAt).getTime() < now;
        }
        return i.daysUntil < 0;
      })
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt));

    const inDays = (i: CalendarItem, from: number, to: number) =>
      i.daysUntil >= from && i.daysUntil <= to;

    return {
      ok: true,
      data: {
        items,
        passedWithoutOutcome,
        clashes: findClashes(items),
        provisional: items
          .filter((i) => i.holdMinutesLeft !== null && i.holdMinutesLeft <= 60)
          .sort((a, b) => (a.holdMinutesLeft ?? 0) - (b.holdMinutesLeft ?? 0)),
        today: items.filter((i) => inDays(i, 0, 0)),
        next7Days: items.filter((i) => inDays(i, 1, 7) && !i.settled),
        deadlinesVisible,
        hearingCount: hearingItems.length,
        deadlineCount: deadlineItems.length,
        otherKindCount: hearingItems.filter((i) => !i.isHearingShaped).length,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error ? error.message : "The calendar could not be read.",
    };
  }
}
