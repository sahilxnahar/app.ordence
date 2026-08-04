"use server";

/**
 * Ordence — ⭐ ENGINE 1 · SCHEDULING & CAPACITY ACTIONS
 * Version: v0.69.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION. A `"use server"` file that exports
 * anything else publishes it as an RPC endpoint reachable by anyone on
 * the internet.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THIS FILE DOES NOT CHECK AVAILABILITY. THAT IS THE POINT.
 * ══════════════════════════════════════════════════════════════════════
 * The obvious way to write `createBooking` is: query for clashes, and if
 * there are none, insert. Two statements.
 *
 * ⚠️ BETWEEN THOSE TWO STATEMENTS, ANOTHER REQUEST DOES EXACTLY THE SAME
 * THING. Both see a free room. Both insert. That is not a rare race — it
 * is what happens the first time two agents work the phones at once, and
 * it is why hotels have a walk policy.
 *
 * So this file simply INSERTS and lets the database refuse. Exclusivity
 * is a GiST exclusion constraint over a `tstzrange`; shared capacity is
 * counted under `SELECT ... FOR UPDATE` on the resource row. Both live in
 * SQL-FILES/0033.
 *
 * What this file does instead is TRANSLATE the refusal. A constraint
 * violation reaching a receptionist as "23P01" is useless; reaching them
 * as "that room is already booked for part of this period" is the whole
 * job.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ A HOLD IS NOT A BOOKING, AND IT EXPIRES
 * ══════════════════════════════════════════════════════════════════════
 * `held` occupies capacity — an abandoned hold that never releases is a
 * room nobody can sell. `hold_expires_at` is set on creation and the
 * sweep releases it. A hold with no expiry is a booking that nobody
 * decided to make.
 */

import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenant } from "@/db";
import {
  scheduleResources,
  scheduleBookings,
  scheduleBlocks,
  DEFAULT_HOLD_MINUTES,
} from "@/db/schema/scheduling";
import { requirePermission, writeAudit } from "@/server/audit";
import { guardSalesWrite, toSalesActionError } from "@/server/sales/guards";
import type { ActionResult } from "@/lib/validators/crm";

const FEATURE = "scheduling.resources" as const;

/* ------------------------------------------------------------------ */
/* SHAPES                                                              */
/* ------------------------------------------------------------------ */

export type ScheduleResourceRow = {
  id: string;
  code: string;
  name: string;
  kind: string;
  groupName: string | null;
  capacity: number;
  overbookLimit: number;
  bufferMinutes: number;
  isActive: boolean;
  baseRateMinor: string;
  /** Live bookings occupying this resource right now. */
  liveBookings: number;
  overbookings: number;
  /** Blocks covering any part of today onward. */
  activeBlocks: number;
};

export type ScheduleBookingRow = {
  id: string;
  resourceId: string;
  resourceName: string;
  resourceKind: string;
  reference: string | null;
  startsAt: string;
  endsAt: string;
  status: string;
  quantity: number;
  partyName: string | null;
  partyPhone: string | null;
  channel: string | null;
  quotedRateMinor: string;
  isOverbooking: boolean;
  holdExpiresAt: string | null;
  /** ⭐ Minutes until this hold evaporates. Negative = already expired. */
  holdMinutesLeft: number | null;
  cancellationReason: string | null;
};

export type ScheduleBlockRow = {
  id: string;
  resourceId: string;
  resourceName: string;
  kind: string;
  reason: string | null;
  startsAt: string;
  endsAt: string;
};

/* ------------------------------------------------------------------ */
/* HELPERS — not exported. See the header.                             */
/* ------------------------------------------------------------------ */

function minor(v: bigint | number | string | null | undefined): string {
  if (v === null || v === undefined) return "0";
  return String(v);
}

function iso(d: Date | string | null): string | null {
  if (!d) return null;
  return typeof d === "string" ? d : d.toISOString();
}

/**
 * ⭐ TURN A DATABASE REFUSAL INTO A SENTENCE SOMEBODY CAN ACT ON.
 *
 * ⚠️ THIS IS NOT COSMETIC. The whole concurrency design depends on the
 * database saying no — which means the quality of that "no" is the
 * quality of the feature. A receptionist told "23P01" phones IT. A
 * receptionist told "that room is already booked for part of this
 * period" offers the guest a different room.
 */
function explainScheduleError(err: unknown): string | null {
  const message =
    err && typeof err === "object" && "message" in err
      ? String((err as { message: unknown }).message)
      : "";
  const code =
    err && typeof err === "object" && "code" in err
      ? String((err as { code: unknown }).code)
      : "";

  // 23P01 = exclusion_violation — the no-overlap constraint.
  if (code === "23P01" || /schedule_bookings_no_overlap/.test(message)) {
    return (
      "That resource is already booked for part of this period. " +
      "Exclusive resources cannot overlap — including the changeover buffer, " +
      "which is counted as part of the booking."
    );
  }
  // Raised by the capacity guard trigger.
  if (/has no capacity for that period/.test(message)) return message;
  if (/is blocked for that period/.test(message)) return message;
  if (/is not active and cannot take new bookings/.test(message)) return message;
  if (/live booking\(s\) already cover that period/.test(message)) return message;
  if (/does not exist in this workspace/.test(message)) return message;
  return null;
}

/* ------------------------------------------------------------------ */
/* READ                                                                */
/* ------------------------------------------------------------------ */

/**
 * ⭐ The board: resources, what is on them, and what is wrong.
 *
 * ⚠️ OVERBOOKINGS AND EXPIRING HOLDS ARE RETURNED SEPARATELY, not left
 * to be spotted in a list. Both are deliberately permitted by the engine
 * — a hotel that cannot oversell loses money on no-shows — and a
 * permitted thing that nobody can find is how a front desk discovers at
 * 9pm that it has walked three guests.
 */
export async function listSchedule(params?: {
  /** ISO date. Defaults to today. */
  on?: string;
}): Promise<
  ActionResult<{
    resources: ScheduleResourceRow[];
    bookings: ScheduleBookingRow[];
    blocks: ScheduleBlockRow[];
    /** ⭐ Bookings taken beyond stated capacity. Permitted, never hidden. */
    overbookings: ScheduleBookingRow[];
    /** Holds within 30 minutes of evaporating, or already expired. */
    expiringHolds: ScheduleBookingRow[];
    arrivingToday: ScheduleBookingRow[];
    departingToday: ScheduleBookingRow[];
    committedRevenueMinor: string;
  }>
> {
  try {
    const ctx = await requirePermission("scheduling.bookings.read");

    const payload = await withTenant(ctx.tenant.id, async (tx) => {
      const resources = await tx
        .select()
        .from(scheduleResources)
        .where(
          and(
            eq(scheduleResources.tenantId, ctx.tenant.id),
            sql`${scheduleResources.deletedAt} IS NULL`,
          ),
        )
        .orderBy(asc(scheduleResources.groupName), asc(scheduleResources.name))
        .limit(500);

      const bookings = await tx
        .select({
          id: scheduleBookings.id,
          resourceId: scheduleBookings.resourceId,
          reference: scheduleBookings.reference,
          startsAt: scheduleBookings.startsAt,
          endsAt: scheduleBookings.endsAt,
          status: scheduleBookings.status,
          quantity: scheduleBookings.quantity,
          partyName: scheduleBookings.partyName,
          partyPhone: scheduleBookings.partyPhone,
          channel: scheduleBookings.channel,
          quotedRateMinor: scheduleBookings.quotedRateMinor,
          isOverbooking: scheduleBookings.isOverbooking,
          holdExpiresAt: scheduleBookings.holdExpiresAt,
          cancellationReason: scheduleBookings.cancellationReason,
          resourceName: scheduleResources.name,
          resourceKind: scheduleResources.kind,
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
        .orderBy(desc(scheduleBookings.startsAt))
        .limit(1000);

      const blocks = await tx
        .select({
          id: scheduleBlocks.id,
          resourceId: scheduleBlocks.resourceId,
          kind: scheduleBlocks.kind,
          reason: scheduleBlocks.reason,
          startsAt: scheduleBlocks.startsAt,
          endsAt: scheduleBlocks.endsAt,
          resourceName: scheduleResources.name,
        })
        .from(scheduleBlocks)
        .innerJoin(
          scheduleResources,
          and(
            eq(scheduleResources.id, scheduleBlocks.resourceId),
            eq(scheduleResources.tenantId, scheduleBlocks.tenantId),
          ),
        )
        .where(eq(scheduleBlocks.tenantId, ctx.tenant.id))
        .orderBy(asc(scheduleBlocks.startsAt))
        .limit(500);

      return { resources, bookings, blocks };
    });

    const now = Date.now();
    const day = params?.on ? new Date(`${params.on}T00:00:00.000Z`) : new Date();
    const dayStart = new Date(day);
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart.getTime() + 86_400_000);

    const bookingRows: ScheduleBookingRow[] = payload.bookings.map((b) => {
      const holdIso = iso(b.holdExpiresAt);
      return {
        id: b.id,
        resourceId: b.resourceId,
        resourceName: b.resourceName,
        resourceKind: b.resourceKind,
        reference: b.reference,
        startsAt: iso(b.startsAt) ?? "",
        endsAt: iso(b.endsAt) ?? "",
        status: b.status,
        quantity: b.quantity ?? 1,
        partyName: b.partyName,
        partyPhone: b.partyPhone,
        channel: b.channel,
        quotedRateMinor: minor(b.quotedRateMinor),
        isOverbooking: b.isOverbooking ?? false,
        holdExpiresAt: holdIso,
        holdMinutesLeft:
          b.status === "held" && holdIso
            ? Math.round((new Date(holdIso).getTime() - now) / 60_000)
            : null,
        cancellationReason: b.cancellationReason,
      };
    });

    /**
     * ⚠️ MUST MATCH `CAPACITY_CONSUMING_STATUSES` in the schema and the
     * five tagged predicates in SQL 0033. A booking that occupies a
     * resource in the database but not on the screen is a room the
     * screen says is free and the database will refuse to sell.
     */
    const OCCUPYING = new Set(["held", "confirmed", "checked_in", "in_progress"]);

    const blockRows: ScheduleBlockRow[] = payload.blocks.map((b) => ({
      id: b.id,
      resourceId: b.resourceId,
      resourceName: b.resourceName,
      kind: b.kind,
      reason: b.reason,
      startsAt: iso(b.startsAt) ?? "",
      endsAt: iso(b.endsAt) ?? "",
    }));

    const resourceRows: ScheduleResourceRow[] = payload.resources.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      kind: r.kind,
      groupName: r.groupName,
      capacity: r.capacity ?? 1,
      overbookLimit: r.overbookLimit ?? 0,
      bufferMinutes: r.bufferMinutes ?? 0,
      isActive: r.isActive ?? true,
      baseRateMinor: minor(r.baseRateMinor),
      liveBookings: bookingRows.filter(
        (b) => b.resourceId === r.id && OCCUPYING.has(b.status),
      ).length,
      overbookings: bookingRows.filter(
        (b) => b.resourceId === r.id && b.isOverbooking,
      ).length,
      activeBlocks: blockRows.filter(
        (b) => b.resourceId === r.id && new Date(b.endsAt).getTime() >= now,
      ).length,
    }));

    const inDay = (isoStr: string) => {
      const t = new Date(isoStr).getTime();
      return t >= dayStart.getTime() && t < dayEnd.getTime();
    };

    return {
      ok: true,
      data: {
        resources: resourceRows,
        bookings: bookingRows,
        blocks: blockRows,
        overbookings: bookingRows.filter(
          (b) => b.isOverbooking && OCCUPYING.has(b.status),
        ),
        expiringHolds: bookingRows
          .filter(
            (b) =>
              b.status === "held" &&
              b.holdMinutesLeft !== null &&
              b.holdMinutesLeft <= 30,
          )
          .sort((a, b) => (a.holdMinutesLeft ?? 0) - (b.holdMinutesLeft ?? 0)),
        arrivingToday: bookingRows
          .filter((b) => OCCUPYING.has(b.status) && inDay(b.startsAt))
          .sort((a, b) => a.startsAt.localeCompare(b.startsAt)),
        departingToday: bookingRows
          .filter(
            (b) =>
              (OCCUPYING.has(b.status) || b.status === "completed") &&
              inDay(b.endsAt),
          )
          .sort((a, b) => a.endsAt.localeCompare(b.endsAt)),
        committedRevenueMinor: String(
          bookingRows
            .filter((b) =>
              ["confirmed", "checked_in", "in_progress", "completed", "no_show"].includes(
                b.status,
              ),
            )
            .reduce((acc, b) => acc + BigInt(b.quotedRateMinor || "0"), 0n),
        ),
      },
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error ? error.message : "The schedule could not be read.",
    };
  }
}

/* ------------------------------------------------------------------ */
/* WRITE — RESOURCES                                                   */
/* ------------------------------------------------------------------ */

const resourceSchema = z.object({
  id: z.string().uuid().optional(),
  code: z.string().trim().min(1, "Give the resource a short code.").max(80),
  name: z.string().trim().min(1, "Name the resource.").max(200),
  kind: z.enum([
    "room", "bed", "table", "hall", "practitioner",
    "vehicle", "equipment", "staff", "slot", "other",
  ]),
  groupName: z.string().trim().max(120).optional().nullable(),
  /**
   * ⚠️ CAPACITY 1 IS NOT THE SAME KIND OF THING AS CAPACITY 20, and the
   * database treats them completely differently: 1 goes through the
   * exclusion constraint, anything above goes through a counting trigger
   * under a row lock. Changing this on a live resource changes which
   * mechanism protects it.
   */
  capacity: z.coerce.number().int().min(1, "Capacity is at least 1.").max(10_000),
  /**
   * ⭐ OVERBOOKING IS A STATED ALLOWANCE, NOT AN ACCIDENT.
   *
   * ⚠️ A hotel that cannot oversell loses money on no-shows, so the
   * engine permits it — but only up to a number somebody chose, and
   * every instance is flagged. Left at 0, the resource simply cannot be
   * oversold.
   */
  overbookLimit: z.coerce.number().int().min(0).max(1000).default(0),
  /**
   * ⭐ The changeover time, baked into the reserved range.
   *
   * ⚠️ A buffer applied by application code is a buffer the busy Tuesday
   * ignores. This one becomes part of the range the exclusion constraint
   * enforces, so it holds under concurrency like the booking itself.
   */
  bufferMinutes: z.coerce.number().int().min(0).max(1440).default(0),
  slotMinutes: z.coerce.number().int().min(1).max(1440).default(60),
  isActive: z.coerce.boolean().default(true),
  isBookableOnline: z.coerce.boolean().default(false),
  baseRateMinor: z
    .string()
    .trim()
    .regex(/^\d{1,19}$/, "Enter a whole amount in paise, digits only.")
    .transform((v) => BigInt(v))
    .optional()
    .nullable(),
});

export async function saveScheduleResource(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const data = resourceSchema.parse(input);
    const ctx = await guardSalesWrite({
      operation: "scheduling:resource:save",
      feature: FEATURE,
      permission: "scheduling.resources.manage",
    });

    const values = {
      code: data.code,
      name: data.name,
      kind: data.kind,
      groupName: data.groupName ?? null,
      capacity: data.capacity,
      overbookLimit: data.overbookLimit,
      bufferMinutes: data.bufferMinutes,
      slotMinutes: data.slotMinutes,
      isActive: data.isActive,
      isBookableOnline: data.isBookableOnline,
      baseRateMinor: data.baseRateMinor ?? 0n,
      updatedAt: new Date(),
    };

    const id = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        if (data.id) {
          await tx
            .update(scheduleResources)
            .set(values)
            .where(
              and(
                eq(scheduleResources.tenantId, ctx.tenant.id),
                eq(scheduleResources.id, data.id),
              ),
            );
          return data.id;
        }
        const [row] = await tx
          .insert(scheduleResources)
          .values({ tenantId: ctx.tenant.id, ...values })
          .returning({ id: scheduleResources.id });
        if (!row) throw new Error("The resource could not be created.");
        return row.id;
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: data.id ? "update" : "create",
      resourceType: "schedule_resource",
      resourceId: id,
      reason: `${data.name} (capacity ${data.capacity})`,
    });

    revalidatePath("/scheduling");
    return { ok: true, data: { id } };
  } catch (err) {
    return toSalesActionError(err, "scheduling");
  }
}

/* ------------------------------------------------------------------ */
/* WRITE — BOOKINGS                                                    */
/* ------------------------------------------------------------------ */

const bookingSchema = z
  .object({
    id: z.string().uuid().optional(),
    resourceId: z.string().uuid("Choose a resource."),
    /**
     * ⚠️ NOT NULL AND UNIQUE PER TENANT. A booking without a reference
     * cannot be quoted down a phone line, and two bookings sharing one
     * cannot be told apart when a guest rings about "booking 41".
     */
    reference: z.string().trim().max(60).optional(),
    startsAt: z.string().min(1, "When does it start?"),
    endsAt: z.string().min(1, "When does it end?"),
    quantity: z.coerce.number().int().min(1).max(10_000).default(1),
    partyName: z.string().trim().max(200).optional().nullable(),
    partyPhone: z.string().trim().max(30).optional().nullable(),
    /**
     * ⚠️ NOT NULL, DEFAULTS TO "direct". Channel is how you find out an
     * OTA is sending you bookings it cannot keep — a blank channel makes
     * the cancellation rate unattributable, so the column refuses one.
     */
    channel: z.string().trim().max(60).default("direct"),
    quotedRateMinor: z
      .string()
      .trim()
      .regex(/^\d{1,19}$/, "Enter a whole amount in paise, digits only.")
      .transform((v) => BigInt(v))
      .optional()
      .nullable(),
    notes: z.string().trim().max(5000).optional().nullable(),
    /** Omit to create a hold; pass "confirmed" to book outright. */
    status: z
      .enum(["held", "confirmed"])
      .default("held"),
  })
  .refine((d) => new Date(d.endsAt) > new Date(d.startsAt), {
    message: "The end must be after the start.",
    path: ["endsAt"],
  });

/**
 * ⭐ Create or amend a booking.
 *
 * ⚠️ NOTE WHAT IS ABSENT: there is no availability check here. See the
 * file header — the check and the write would be two statements with a
 * race between them, and the database already refuses the overlap under
 * concurrency. This function's real job is to make the refusal legible.
 */
export async function saveScheduleBooking(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const data = bookingSchema.parse(input);
    const ctx = await guardSalesWrite({
      operation: "scheduling:booking:save",
      feature: FEATURE,
      permission: "scheduling.bookings.manage",
    });

    /**
     * ⭐ A HOLD GETS AN EXPIRY, ALWAYS.
     *
     * ⚠️ `held` occupies capacity exactly as `confirmed` does. A hold
     * with no expiry is a resource permanently removed from sale by
     * somebody who wandered off mid-enquiry — and because it looks like
     * a real booking, nobody investigates.
     */
    const holdExpiresAt =
      data.status === "held"
        ? new Date(Date.now() + DEFAULT_HOLD_MINUTES * 60_000)
        : null;

    const values = {
      resourceId: data.resourceId,
      /**
       * ⚠️ GENERATED WHEN ABSENT, NEVER LEFT EMPTY. The column is NOT
       * NULL and unique per tenant; a blank would be rejected by the
       * database with a message about a constraint, which tells a
       * receptionist nothing.
       */
      reference:
        data.reference && data.reference.length > 0
          ? data.reference
          : `BK-${new Date(data.startsAt).toISOString().slice(0, 10).replace(/-/g, "")}-${Math.abs(
              [...`${data.resourceId}${data.startsAt}`].reduce(
                (h, c) => (h * 31 + c.charCodeAt(0)) | 0,
                7,
              ),
            )
              .toString(36)
              .toUpperCase()
              .slice(0, 6)}`,
      startsAt: new Date(data.startsAt),
      endsAt: new Date(data.endsAt),
      quantity: data.quantity,
      partyName: data.partyName ?? null,
      partyPhone: data.partyPhone ?? null,
      channel: data.channel,
      quotedRateMinor: data.quotedRateMinor ?? 0n,
      notes: data.notes ?? null,
      status: data.status,
      holdExpiresAt,
      updatedAt: new Date(),
    };

    const id = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        if (data.id) {
          await tx
            .update(scheduleBookings)
            .set(values)
            .where(
              and(
                eq(scheduleBookings.tenantId, ctx.tenant.id),
                eq(scheduleBookings.id, data.id),
              ),
            );
          return data.id;
        }
        const [row] = await tx
          .insert(scheduleBookings)
          .values({
            tenantId: ctx.tenant.id,
            createdByUserId: ctx.user.id,
            ...values,
          })
          .returning({ id: scheduleBookings.id });
        if (!row) throw new Error("The booking could not be created.");
        return row.id;
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: data.id ? "update" : "create",
      resourceType: "schedule_booking",
      resourceId: id,
      reason: `${data.partyName ?? "booking"} · ${data.startsAt} → ${data.endsAt}`,
    });

    revalidatePath("/scheduling");
    return { ok: true, data: { id } };
  } catch (err) {
    const explained = explainScheduleError(err);
    if (explained) return { ok: false, error: explained };
    return toSalesActionError(err, "scheduling");
  }
}

const statusSchema = z.object({
  id: z.string().uuid(),
  status: z.enum([
    "held", "confirmed", "checked_in", "in_progress",
    "completed", "no_show", "cancelled", "waitlisted",
  ]),
  cancellationReason: z.string().trim().max(500).optional().nullable(),
});

/**
 * ⭐ Move a booking's status.
 *
 * ⚠️ CANCELLING RELEASES CAPACITY, AND THAT IS THE WHOLE REASON THE
 * STATUS LIST IS SPLIT THE WAY IT IS. `cancelled` and `no_show` stop
 * occupying the resource; `held`, `confirmed`, `checked_in` and
 * `in_progress` continue to. Get that list wrong and either a cancelled
 * booking keeps blocking a resale, or a live one stops protecting the
 * room somebody is standing in.
 */
export async function setScheduleBookingStatus(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const data = statusSchema.parse(input);
    const ctx = await guardSalesWrite({
      operation: "scheduling:booking:status",
      feature: FEATURE,
      permission: "scheduling.bookings.manage",
      resource: { type: "schedule_booking", id: data.id },
    });

    if (data.status === "cancelled" && !data.cancellationReason) {
      return {
        ok: false,
        error:
          "Give a reason for the cancellation. A cancelled booking with no reason " +
          "makes the cancellation rate unreadable — and that number is how you find " +
          "out a channel is sending you business it cannot keep.",
      };
    }

    const now = new Date();
    await withTenant(
      ctx.tenant.id,
      async (tx) => {
        await tx
          .update(scheduleBookings)
          .set({
            status: data.status,
            cancellationReason: data.cancellationReason ?? null,
            // ⚠️ A cancelled or completed booking has no hold to expire.
            holdExpiresAt: data.status === "held" ? undefined : null,
            checkedInAt: data.status === "checked_in" ? now : undefined,
            completedAt: data.status === "completed" ? now : undefined,
            cancelledAt: data.status === "cancelled" ? now : undefined,
            updatedAt: now,
          })
          .where(
            and(
              eq(scheduleBookings.tenantId, ctx.tenant.id),
              eq(scheduleBookings.id, data.id),
            ),
          );
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: "update",
      resourceType: "schedule_booking",
      resourceId: data.id,
      reason: `status → ${data.status}`,
    });

    revalidatePath("/scheduling");
    return { ok: true, data: { id: data.id } };
  } catch (err) {
    const explained = explainScheduleError(err);
    if (explained) return { ok: false, error: explained };
    return toSalesActionError(err, "scheduling");
  }
}

/* ------------------------------------------------------------------ */
/* WRITE — BLOCKS                                                      */
/* ------------------------------------------------------------------ */

const blockSchema = z
  .object({
    id: z.string().uuid().optional(),
    resourceId: z.string().uuid("Choose a resource."),
    kind: z.enum([
      "maintenance", "cleaning", "closed", "holiday",
      "reserved_internal", "breakdown", "other",
    ]),
    /**
     * ⚠️ REQUIRED. A resource out of service with no stated reason is a
     * resource nobody dares release — the next person to look has no way
     * of knowing whether the problem was fixed.
     */
    reason: z.string().trim().min(1, "Why is it out of service?").max(300),
    startsAt: z.string().min(1, "When does the block start?"),
    endsAt: z.string().min(1, "When does it end?"),
  })
  .refine((d) => new Date(d.endsAt) > new Date(d.startsAt), {
    message: "The end must be after the start.",
    path: ["endsAt"],
  });

/**
 * ⭐ Take a resource out of service for a period.
 *
 * ⚠️ THE DATABASE REFUSES A BLOCK THAT LANDS ON A LIVE BOOKING, and the
 * asymmetry matters: block a room somebody is checked into and the guest
 * is now formally in a room that is out of service. Move or cancel the
 * booking first — which is a decision a person has to make, not one the
 * system should make silently.
 *
 * ⚠️ AND A BLOCK BEATS OVERBOOKING. Maintenance is not a demand problem;
 * the overbooking allowance does not apply to a room whose ceiling has
 * fallen in.
 */
export async function saveScheduleBlock(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const data = blockSchema.parse(input);
    const ctx = await guardSalesWrite({
      operation: "scheduling:block:save",
      feature: FEATURE,
      permission: "scheduling.resources.manage",
    });

    const values = {
      resourceId: data.resourceId,
      kind: data.kind,
      reason: data.reason,
      startsAt: new Date(data.startsAt),
      endsAt: new Date(data.endsAt),
    };

    const id = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        if (data.id) {
          await tx
            .update(scheduleBlocks)
            .set(values)
            .where(
              and(
                eq(scheduleBlocks.tenantId, ctx.tenant.id),
                eq(scheduleBlocks.id, data.id),
              ),
            );
          return data.id;
        }
        const [row] = await tx
          .insert(scheduleBlocks)
          .values({
            tenantId: ctx.tenant.id,
            createdByUserId: ctx.user.id,
            ...values,
          })
          .returning({ id: scheduleBlocks.id });
        if (!row) throw new Error("The block could not be created.");
        return row.id;
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: data.id ? "update" : "create",
      resourceType: "schedule_block",
      resourceId: id,
      reason: `${data.kind} · ${data.startsAt} → ${data.endsAt}`,
    });

    revalidatePath("/scheduling");
    return { ok: true, data: { id } };
  } catch (err) {
    const explained = explainScheduleError(err);
    if (explained) return { ok: false, error: explained };
    return toSalesActionError(err, "scheduling");
  }
}

export async function deleteScheduleBlock(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const { id } = z.object({ id: z.string().uuid() }).parse(input);
    const ctx = await guardSalesWrite({
      operation: "scheduling:block:delete",
      feature: FEATURE,
      permission: "scheduling.resources.manage",
      resource: { type: "schedule_block", id },
      // ⚠️ Judged as a DESTRUCTIVE act by the impersonation policy, not
      // merely as a scheduling one. See guardSalesWrite.
      impersonationOperation: "delete:schedule_block",
    });

    await withTenant(
      ctx.tenant.id,
      async (tx) => {
        await tx
          .delete(scheduleBlocks)
          .where(
            and(
              eq(scheduleBlocks.tenantId, ctx.tenant.id),
              eq(scheduleBlocks.id, id),
            ),
          );
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: "delete",
      resourceType: "schedule_block",
      resourceId: id,
      reason: "block removed — the resource is bookable again",
    });

    revalidatePath("/scheduling");
    return { ok: true, data: { id } };
  } catch (err) {
    return toSalesActionError(err, "scheduling");
  }
}

/* ------------------------------------------------------------------ */
/* SWEEP                                                               */
/* ------------------------------------------------------------------ */

/**
 * ⭐ Release holds that have expired.
 *
 * ⚠️ WITHOUT THIS, THE ENGINE SLOWLY STOPS SELLING. Every abandoned
 * enquiry leaves a `held` booking occupying a resource forever. The
 * symptom is not an error — it is a hotel that is mysteriously full on a
 * quiet Tuesday, and nobody thinks to look at holds from March.
 */
export async function releaseExpiredHolds(): Promise<
  ActionResult<{ released: number }>
> {
  try {
    const ctx = await guardSalesWrite({
      operation: "scheduling:holds:sweep",
      feature: FEATURE,
      permission: "scheduling.bookings.manage",
    });

    const released = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const rows = await tx
          .update(scheduleBookings)
          .set({
            status: "cancelled",
            cancellationReason: "Hold expired without confirmation.",
            cancelledAt: new Date(),
            holdExpiresAt: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(scheduleBookings.tenantId, ctx.tenant.id),
              eq(scheduleBookings.status, "held"),
              sql`${scheduleBookings.holdExpiresAt} IS NOT NULL`,
              lte(scheduleBookings.holdExpiresAt, new Date()),
            ),
          )
          .returning({ id: scheduleBookings.id });
        return rows.length;
      },
      { impersonationId: ctx.impersonationId },
    );

    if (released > 0) {
      await writeAudit(ctx, {
        action: "update",
        resourceType: "schedule_booking",
        reason: `${released} expired hold(s) released`,
      });
    }

    revalidatePath("/scheduling");
    return { ok: true, data: { released } };
  } catch (err) {
    return toSalesActionError(err, "scheduling");
  }
}
