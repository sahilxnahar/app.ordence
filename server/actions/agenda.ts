"use server";

/**
 * Ordence — ⭐⭐⭐ ONE DAY, NOT SIX SCREENS
 * Version: v1.9.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION AND NONE TAKES A TENANT.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE CALENDAR IS A MERGE, NOT A TABLE
 * ══════════════════════════════════════════════════════════════════════
 * Ordence already knew about six kinds of dated thing and kept each on
 * its own screen: hearings, compliance filings, licence renewals,
 * payment milestones, tasks and diary entries.
 *
 * ⚠️ A person does not have six days. They have one. Six screens each
 * showing a true subset of tomorrow produces a paper diary on the desk,
 * because that is the only place all six appear together.
 *
 * ⭐ Nothing here is stored. Every source keeps its own record and its
 * own rules; this action puts them in one order.
 */

import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { withTenant } from "@/db";
import { calendarEvents, tasks } from "@/db/schema/work";
import { legalHearings, legalMatters } from "@/db/schema/legal";
import { complianceLicences, complianceObligations, complianceTasks } from "@/db/schema/compliance";
import { paymentMilestones, bookings, units } from "@/db/schema/sales";
import { users } from "@/db/schema/core";
import { requirePermission } from "@/server/audit";
import { toSalesActionError } from "@/server/sales/guards";
import { toBigIntAmount } from "@/lib/billing/money";
import type { ActionResult } from "@/lib/validators/crm";
import {
  buildAgenda,
  complianceEntry,
  eventEntry,
  hearingEntry,
  licenceEntry,
  milestoneEntry,
  taskEntry,
  type AgendaEntry,
} from "@/lib/work/agenda";

const READ = "crm.contacts.read" as const;

/**
 * 🔴 THE BUSINESS DAY IS ASIA/KOLKATA, NOT THE SERVER'S DAY.
 *
 * ⚠️ A meeting at eleven at night on the 3rd is on the 3rd for the
 * person attending it. Deriving the civil day from a UTC timestamp puts
 * it on the 4th, which is how an agenda quietly shows tomorrow's
 * appointments today for four and a half hours every evening.
 */
const IST = "Asia/Kolkata";

function istDay(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: IST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function istTime(d: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: IST,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

function inr(minor: bigint): string {
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString().padStart(3, "0");
  const whole = digits.slice(0, -2);
  const frac = digits.slice(-2);
  const lastThree = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest
    ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${lastThree}`
    : lastThree;
  return `${negative ? "-" : ""}₹${grouped}.${frac}`;
}

function personName(
  first: string | null,
  last: string | null,
  email: string | null,
): string | null {
  return [first, last].filter(Boolean).join(" ").trim() || email || null;
}

/**
 * ⭐⭐ THE AGENDA.
 *
 * 🔴 THE PAST IS INCLUDED, AND THAT IS THE MOST IMPORTANT DECISION HERE.
 *    A calendar that starts at today hides the hearing nobody attended
 *    last Thursday and the filing that was due on the 20th. Those are
 *    exactly the entries a person needs to see, and they are the ones
 *    every calendar drops off the top of the screen the moment the day
 *    turns.
 */
export async function getAgenda(input?: unknown): Promise<
  ActionResult<{
    days: {
      on: string;
      offset: number;
      label: string;
      hasConsequential: boolean;
      entries: {
        id: string;
        source: string;
        sourceLabel: string;
        atLabel: string | null;
        title: string;
        detail: string | null;
        ownerName: string | null;
        href: string | null;
        weight: string;
      }[];
    }[];
    overdueCount: number;
    consequentialOverdueCount: number;
    todayCount: number;
    total: number;
    today: string;
    mineOnly: boolean;
  }>
> {
  try {
    const opts = z
      .object({
        daysAhead: z.number().int().min(0).max(120).default(14),
        daysBack: z.number().int().min(0).max(120).default(30),
        mineOnly: z.boolean().default(false),
      })
      .parse(input ?? {});
    const ctx = await requirePermission(READ);

    const now = new Date();
    const today = istDay(now);
    const windowStart = new Date(now.getTime() - (opts.daysBack + 2) * 86_400_000);
    const windowEnd = new Date(now.getTime() + (opts.daysAhead + 2) * 86_400_000);
    const startDay = istDay(windowStart);
    const endDay = istDay(windowEnd);

    const entries = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const collected: AgendaEntry[] = [];

        /* ── tasks ────────────────────────────────────────────────── */
        const taskRows = await tx
          .select({
            id: tasks.id,
            title: tasks.title,
            dueOn: tasks.dueOn,
            subjectLabel: tasks.subjectLabel,
            assignedTo: tasks.assignedTo,
            first: users.firstName,
            last: users.lastName,
            email: users.email,
          })
          .from(tasks)
          .leftJoin(users, eq(users.id, tasks.assignedTo))
          .where(
            and(
              eq(tasks.tenantId, ctx.tenant.id),
              inArray(tasks.status, ["open", "in_progress", "blocked"]),
              gte(tasks.dueOn, startDay),
              lte(tasks.dueOn, endDay),
            ),
          )
          .limit(2000);
        for (const t of taskRows) {
          const e = taskEntry({
            id: t.id,
            title: t.title,
            dueOn: t.dueOn,
            subjectLabel: t.subjectLabel,
            assignedTo: t.assignedTo,
            assigneeName: personName(t.first, t.last, t.email),
          });
          if (e) collected.push(e);
        }

        /* ── diary entries ────────────────────────────────────────── */
        const eventRows = await tx
          .select({
            id: calendarEvents.id,
            title: calendarEvents.title,
            startsAt: calendarEvents.startsAt,
            allDay: calendarEvents.allDay,
            location: calendarEvents.location,
            organiserId: calendarEvents.organiserId,
            status: calendarEvents.status,
            first: users.firstName,
            last: users.lastName,
            email: users.email,
          })
          .from(calendarEvents)
          .leftJoin(users, eq(users.id, calendarEvents.organiserId))
          .where(
            and(
              eq(calendarEvents.tenantId, ctx.tenant.id),
              gte(calendarEvents.startsAt, windowStart),
              lte(calendarEvents.startsAt, windowEnd),
            ),
          )
          .limit(2000);
        for (const ev of eventRows) {
          const e = eventEntry(
            {
              id: ev.id,
              title: ev.title,
              startsAt: ev.startsAt.toISOString(),
              allDay: ev.allDay,
              location: ev.location,
              organiserId: ev.organiserId,
              organiserName: personName(ev.first, ev.last, ev.email),
              status: ev.status,
            },
            (iso) => istDay(new Date(iso)),
            (iso) => istTime(new Date(iso)),
          );
          if (e) collected.push(e);
        }

        /* ── hearings ─────────────────────────────────────────────── */
        const hearingRows = await tx
          .select({
            id: legalHearings.id,
            matterId: legalHearings.matterId,
            hearingDate: legalHearings.hearingDate,
            purpose: legalHearings.purpose,
            appearedBy: legalHearings.appearedBy,
            matterNo: legalMatters.matterNo,
            title: legalMatters.title,
            courtName: legalMatters.courtName,
            first: users.firstName,
            last: users.lastName,
            email: users.email,
          })
          .from(legalHearings)
          .leftJoin(legalMatters, eq(legalMatters.id, legalHearings.matterId))
          .leftJoin(users, eq(users.id, legalHearings.appearedBy))
          .where(
            and(
              eq(legalHearings.tenantId, ctx.tenant.id),
              gte(legalHearings.hearingDate, startDay),
              lte(legalHearings.hearingDate, endDay),
            ),
          )
          .limit(2000);
        for (const h of hearingRows) {
          collected.push(
            hearingEntry({
              id: h.id,
              matterId: h.matterId,
              hearingDate: h.hearingDate,
              matterNo: h.matterNo,
              title: h.title,
              courtName: h.courtName,
              purpose: h.purpose,
              appearedBy: h.appearedBy,
              appearedByName: personName(h.first, h.last, h.email),
            }),
          );
        }

        /* ── compliance filings ───────────────────────────────────── */
        const filingRows = await tx
          .select({
            id: complianceTasks.id,
            dueDate: complianceTasks.dueDate,
            periodLabel: complianceTasks.periodLabel,
            ownerUserId: complianceTasks.ownerUserId,
            status: complianceTasks.status,
            obligationName: complianceObligations.name,
            first: users.firstName,
            last: users.lastName,
            email: users.email,
          })
          .from(complianceTasks)
          .leftJoin(
            complianceObligations,
            eq(complianceObligations.id, complianceTasks.obligationId),
          )
          .leftJoin(users, eq(users.id, complianceTasks.ownerUserId))
          .where(
            and(
              eq(complianceTasks.tenantId, ctx.tenant.id),
              gte(complianceTasks.dueDate, startDay),
              lte(complianceTasks.dueDate, endDay),
            ),
          )
          .limit(2000);
        for (const f of filingRows) {
          /** ⚠️ A filed return leaves the agenda. It is done. */
          if (f.status === "filed" || f.status === "not_applicable" || f.status === "waived") continue;
          collected.push(
            complianceEntry({
              id: f.id,
              dueDate: f.dueDate,
              periodLabel: f.periodLabel,
              obligationName: f.obligationName,
              ownerUserId: f.ownerUserId,
              ownerName: personName(f.first, f.last, f.email),
            }),
          );
        }

        /* ── licence renewals ─────────────────────────────────────── */
        const licenceRows = await tx
          .select({
            id: complianceLicences.id,
            name: complianceLicences.name,
            validUntil: complianceLicences.validUntil,
            renewalLeadDays: complianceLicences.renewalLeadDays,
            authority: complianceLicences.authority,
            ownerUserId: complianceLicences.ownerUserId,
            status: complianceLicences.status,
            first: users.firstName,
            last: users.lastName,
            email: users.email,
          })
          .from(complianceLicences)
          .leftJoin(users, eq(users.id, complianceLicences.ownerUserId))
          .where(eq(complianceLicences.tenantId, ctx.tenant.id))
          .limit(2000);
        for (const l of licenceRows) {
          if (l.status === "cancelled" || l.status === "not_required") continue;
          const e = licenceEntry({
            id: l.id,
            name: l.name,
            validUntil: l.validUntil,
            renewalLeadDays: l.renewalLeadDays,
            authority: l.authority,
            ownerUserId: l.ownerUserId,
            ownerName: personName(l.first, l.last, l.email),
          });
          if (e) collected.push(e);
        }

        /* ── payment milestones ───────────────────────────────────── */
        const milestoneRows = await tx
          .select({
            id: paymentMilestones.id,
            label: paymentMilestones.label,
            dueDate: paymentMilestones.dueDate,
            amountMinor: paymentMilestones.amountMinor,
            amountPaidMinor: paymentMilestones.amountPaidMinor,
            status: paymentMilestones.status,
            unitLabel: units.code,
          })
          .from(paymentMilestones)
          .leftJoin(bookings, eq(bookings.id, paymentMilestones.bookingId))
          .leftJoin(units, eq(units.id, bookings.unitId))
          .where(
            and(
              eq(paymentMilestones.tenantId, ctx.tenant.id),
              gte(paymentMilestones.dueDate, windowStart),
              lte(paymentMilestones.dueDate, windowEnd),
            ),
          )
          .limit(2000);
        for (const m of milestoneRows) {
          const e = milestoneEntry(
            {
              id: m.id,
              label: m.label,
              dueOn: m.dueDate ? istDay(m.dueDate) : null,
              amountMinor: toBigIntAmount(m.amountMinor ?? 0n),
              amountPaidMinor: toBigIntAmount(m.amountPaidMinor ?? 0n),
              status: String(m.status),
              unitLabel: m.unitLabel,
            },
            inr,
          );
          if (e) collected.push(e);
        }

        return collected;
      },
      { impersonationId: ctx.impersonationId },
    );

    const built = buildAgenda({
      entries,
      today,
      daysAhead: opts.daysAhead,
      daysBack: opts.daysBack,
      ownerId: opts.mineOnly ? ctx.user.id : null,
    });

    return {
      ok: true,
      data: {
        days: built.days.map((d) => ({
          on: d.on,
          offset: d.offset,
          label: d.label,
          hasConsequential: d.hasConsequential,
          entries: d.entries.map((e) => ({
            id: e.id,
            source: e.source,
            sourceLabel: AGENDA_LABEL[e.source] ?? e.source,
            atLabel: e.atLabel ?? null,
            title: e.title,
            detail: e.detail ?? null,
            ownerName: e.ownerName ?? null,
            href: e.href ?? null,
            weight: e.weight,
          })),
        })),
        overdueCount: built.overdueCount,
        consequentialOverdueCount: built.consequentialOverdueCount,
        todayCount: built.todayCount,
        total: built.total,
        today,
        mineOnly: opts.mineOnly,
      },
    };
  } catch (err) {
    return toSalesActionError(err, "getAgenda");
  }
}

const AGENDA_LABEL: Record<string, string> = {
  task: "Task",
  event: "Diary",
  hearing: "Hearing",
  compliance: "Filing",
  licence: "Licence",
  milestone: "Payment due",
};

/* ------------------------------------------------------------------ */
/* DIARY ENTRIES                                                       */
/* ------------------------------------------------------------------ */

const eventSchema = z.object({
  title: z.string().trim().min(1).max(300),
  detail: z.string().trim().max(4000).optional(),
  location: z.string().trim().max(300).optional(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  allDay: z.boolean().default(false),
  kind: z
    .enum(["meeting", "call", "site_visit", "hearing", "inspection", "delivery", "personal", "other"])
    .default("meeting"),
  subjectType: z.string().trim().max(40).nullish(),
  subjectId: z.string().uuid().nullish(),
  subjectLabel: z.string().trim().max(300).nullish(),
});

/**
 * ⭐ PUT SOMETHING IN THE DIARY.
 *
 * 🔴 An entry that ends before it starts is a typed year, and it always
 *    looks plausible on a form. The database refuses it; this refuses it
 *    in a sentence first.
 */
export async function saveCalendarEvent(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const data = eventSchema.parse(input);
    const ctx = await requirePermission("crm.contacts.write");

    const starts = new Date(data.startsAt);
    const ends = new Date(data.endsAt);
    if (Number.isNaN(starts.getTime()) || Number.isNaN(ends.getTime())) {
      throw new Error("That is not a valid date and time.");
    }
    if (ends <= starts) {
      throw new Error(
        "This entry ends before it starts. That is almost always a typed year or a missed am and pm, and it looks perfectly plausible on the form.",
      );
    }

    const hasType = data.subjectType !== null && data.subjectType !== undefined;
    const hasId = data.subjectId !== null && data.subjectId !== undefined;
    if (hasType !== hasId) {
      throw new Error(
        "A diary entry is attached to a record or to nothing. Half a link will never resolve on a screen.",
      );
    }

    const id = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [row] = await tx
          .insert(calendarEvents)
          .values({
            tenantId: ctx.tenant.id,
            title: data.title,
            detail: data.detail ?? null,
            location: data.location ?? null,
            startsAt: starts,
            endsAt: ends,
            allDay: data.allDay,
            kind: data.kind,
            subjectType: data.subjectType ?? null,
            subjectId: data.subjectId ?? null,
            subjectLabel: data.subjectLabel ?? null,
            organiserId: ctx.user.id,
            createdBy: ctx.user.id,
            updatedBy: ctx.user.id,
          })
          .returning({ id: calendarEvents.id });
        if (!row) throw new Error("The entry could not be saved.");
        return row.id;
      },
      { impersonationId: ctx.impersonationId },
    );

    return { ok: true, data: { id } };
  } catch (err) {
    return toSalesActionError(err, "saveCalendarEvent");
  }
}
