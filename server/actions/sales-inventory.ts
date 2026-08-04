"use server";

/**
 * Ordence — Project & Inventory Actions
 * Version: v0.22.0-alpha
 *
 * ⚠️ Every export is an async function. Constants and schemas live in
 * `lib/sales/inventory.ts` and `lib/validators/sales.ts`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE IS RESPONSIBLE FOR, AND WHAT IT IS NOT
 * ══════════════════════════════════════════════════════════════════════
 * It is responsible for asking the right questions before writing, and
 * for turning a refusal into a sentence somebody can act on.
 *
 * It is NOT responsible for making the guarantees. Those are constraints
 * and triggers in `SQL-FILES/0016_phase22_sales.sql`, because this file
 * is one of four write paths — an import, a support fix and a future API
 * route are the others — and a rule enforced in one of four places is a
 * rule that will be bypassed by the other three.
 */

import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, lte, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withTenant } from "@/db";
import { projects, units, leads, bookings } from "@/db/schema";
import { requirePermission, writeAudit } from "@/server/audit";
import { guardSalesWrite, salesFail, toSalesActionError } from "@/server/sales/guards";
import {
  createProjectSchema,
  updateProjectSchema,
  createUnitSchema,
  updateUnitSchema,
  unitAreaCoherent,
  holdUnitSchema,
  releaseHoldSchema,
  setUnitStatusSchema,
  unitFilterSchema,
} from "@/lib/validators/sales";
import { toMinorUnits } from "@/lib/validators/accounting";
import {
  canHold,
  resolveHoldPolicy,
  holdExpiryFor,
  summariseAvailability,
  holdHoursRemaining,
} from "@/lib/sales/inventory";
import type { ActionResult } from "@/lib/validators/crm";
import type { Project, Unit } from "@/db/schema/sales";

/* ------------------------------------------------------------------ */
/* PROJECTS                                                           */
/* ------------------------------------------------------------------ */

export type ProjectRow = Project & {
  unitCount: number;
  availableCount: number;
};

export async function listProjects(): Promise<ActionResult<{ rows: ProjectRow[] }>> {
  try {
    const ctx = await requirePermission("projects:read");

    const rows = await withTenant(ctx.tenant.id, async (tx) =>
      tx
        .select({
          project: projects,
          unitCount: sql<number>`(
            SELECT count(*)::int FROM units u
             WHERE u.project_id = ${projects.id} AND u.deleted_at IS NULL
          )`,
          availableCount: sql<number>`(
            SELECT count(*)::int FROM units u
             WHERE u.project_id = ${projects.id}
               AND u.deleted_at IS NULL
               AND u.status = 'available'
          )`,
        })
        .from(projects)
        .where(
          and(eq(projects.tenantId, ctx.tenant.id), isNull(projects.deletedAt)),
        )
        .orderBy(asc(projects.name)),
    );

    return {
      ok: true,
      data: {
        rows: rows.map((r) => ({
          ...r.project,
          unitCount: Number(r.unitCount ?? 0),
          availableCount: Number(r.availableCount ?? 0),
        })),
      },
    };
  } catch (err) {
    return toSalesActionError(err, "listProjects");
  }
}

export async function createProject(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await guardSalesWrite({
      operation: "projects:manage",
      feature: "sales.inventory",
      permission: "projects:manage",
    });

    const data = createProjectSchema.parse(input);

    const created = await withTenant(ctx.tenant.id, async (tx) => {
      const [row] = await tx
        .insert(projects)
        .values({
          tenantId: ctx.tenant.id,
          code: data.code,
          name: data.name,
          description: data.description ?? null,
          addressLine: data.addressLine ?? null,
          city: data.city ?? null,
          state: data.state ?? null,
          latitude: data.latitude ?? null,
          longitude: data.longitude ?? null,
          reraNumber: data.reraNumber ?? null,
          startedAt: data.startedAt ?? null,
          expectedCompletionAt: data.expectedCompletionAt ?? null,
        })
        .returning({ id: projects.id });
      return row ?? null;
    });

    if (!created) return salesFail("The project could not be created.");

    await writeAudit(ctx, {
      action: "create",
      resourceType: "project",
      resourceId: created.id,
      newValue: { code: data.code, name: data.name, reraNumber: data.reraNumber ?? null },
    });

    revalidatePath("/sales/inventory");
    return { ok: true, data: created };
  } catch (err) {
    return toSalesActionError(err, "createProject");
  }
}

export async function updateProject(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await guardSalesWrite({
      operation: "projects:manage",
      feature: "sales.inventory",
      permission: "projects:manage",
    });

    const data = updateProjectSchema.parse(input);

    const updated = await withTenant(ctx.tenant.id, async (tx) => {
      const result = await tx
        .update(projects)
        .set({
          ...(data.code !== undefined ? { code: data.code } : {}),
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.description !== undefined ? { description: data.description } : {}),
          ...(data.addressLine !== undefined ? { addressLine: data.addressLine } : {}),
          ...(data.city !== undefined ? { city: data.city } : {}),
          ...(data.state !== undefined ? { state: data.state } : {}),
          ...(data.latitude !== undefined ? { latitude: data.latitude } : {}),
          ...(data.longitude !== undefined ? { longitude: data.longitude } : {}),
          ...(data.reraNumber !== undefined ? { reraNumber: data.reraNumber } : {}),
          ...(data.startedAt !== undefined ? { startedAt: data.startedAt } : {}),
          ...(data.expectedCompletionAt !== undefined
            ? { expectedCompletionAt: data.expectedCompletionAt }
            : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(projects.id, data.id),
            eq(projects.tenantId, ctx.tenant.id),
            isNull(projects.deletedAt),
          ),
        )
        .returning({ id: projects.id });
      return result[0] ?? null;
    });

    if (!updated) return salesFail("That project does not exist, or you cannot see it.");

    await writeAudit(ctx, {
      action: "update",
      resourceType: "project",
      resourceId: data.id,
      newValue: { ...data } as Record<string, unknown>,
    });

    revalidatePath("/sales/inventory");
    return { ok: true, data: updated };
  } catch (err) {
    return toSalesActionError(err, "updateProject");
  }
}

/* ------------------------------------------------------------------ */
/* UNITS                                                              */
/* ------------------------------------------------------------------ */

export type UnitRow = Unit & {
  projectName: string | null;
  heldForName: string | null;
  holdHoursRemaining: number | null;
};

export async function listUnits(input: unknown = {}): Promise<
  ActionResult<{
    rows: UnitRow[];
    total: number;
    page: number;
    pageSize: number;
    summary: ReturnType<typeof summariseAvailability>;
  }>
> {
  try {
    const ctx = await requirePermission("units:read");
    const filter = unitFilterSchema.parse(input ?? {});
    const now = new Date();

    const result = await withTenant(ctx.tenant.id, async (tx) => {
      const conditions = [eq(units.tenantId, ctx.tenant.id), isNull(units.deletedAt)];

      if (filter.projectId) conditions.push(eq(units.projectId, filter.projectId));
      if (filter.status?.length) conditions.push(inArray(units.status, filter.status));
      if (filter.tower) conditions.push(ilike(units.tower, `%${filter.tower}%`));
      if (filter.typology) conditions.push(eq(units.typology, filter.typology));
      if (filter.facing) conditions.push(eq(units.facing, filter.facing));
      if (filter.minPrice) conditions.push(gte(units.priceMinor, toMinorUnits(filter.minPrice)));
      if (filter.maxPrice) conditions.push(lte(units.priceMinor, toMinorUnits(filter.maxPrice)));

      const where = and(...conditions);

      const sortColumn = {
        code: units.code,
        price_minor: units.priceMinor,
        floor: units.floor,
        status: units.status,
      }[filter.sortBy];

      const orderBy = filter.sortDir === "asc" ? asc(sortColumn) : desc(sortColumn);

      const rows = await tx
        .select({
          unit: units,
          projectName: projects.name,
          heldForName: leads.name,
        })
        .from(units)
        .leftJoin(
          projects,
          and(eq(projects.id, units.projectId), eq(projects.tenantId, ctx.tenant.id)),
        )
        .leftJoin(
          leads,
          and(eq(leads.id, units.heldForLeadId), eq(leads.tenantId, ctx.tenant.id)),
        )
        .where(where)
        .orderBy(orderBy)
        .limit(filter.pageSize)
        .offset((filter.page - 1) * filter.pageSize);

      const [totals] = await tx.select({ value: count() }).from(units).where(where);

      // ⚠️ The summary counts the WHOLE filtered set, not the page. A
      // "12 available" that means "12 on this page of 50" is a number
      // that gets quoted in a meeting and is wrong.
      const statusCounts = await tx
        .select({ status: units.status, value: count() })
        .from(units)
        .where(where)
        .groupBy(units.status);

      const expanded = statusCounts.flatMap((row) =>
        Array.from({ length: Number(row.value) }, () => ({ status: row.status })),
      );

      return {
        rows: rows.map((row) => ({
          ...row.unit,
          projectName: row.projectName ?? null,
          heldForName: row.heldForName ?? null,
          holdHoursRemaining: holdHoursRemaining(
            { code: row.unit.code, status: row.unit.status, holdUntil: row.unit.holdUntil },
            now,
          ),
        })),
        total: Number(totals?.value ?? 0),
        summary: summariseAvailability(expanded),
      };
    });

    return {
      ok: true,
      data: { ...result, page: filter.page, pageSize: filter.pageSize },
    };
  } catch (err) {
    return toSalesActionError(err, "listUnits");
  }
}

export async function createUnit(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await guardSalesWrite({
      operation: "units:create",
      feature: "sales.inventory",
      permission: "units:create",
    });

    const data = createUnitSchema.parse(input);

    const areaProblem = unitAreaCoherent(data);
    if (areaProblem) return salesFail(areaProblem);

    const created = await withTenant(ctx.tenant.id, async (tx) => {
      // The project must be OURS. The composite foreign key
      // `units_project_same_tenant` enforces it too; this exists so the
      // message is "that project does not exist" rather than a 23503.
      const [project] = await tx
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(
            eq(projects.id, data.projectId),
            eq(projects.tenantId, ctx.tenant.id),
            isNull(projects.deletedAt),
          ),
        )
        .limit(1);

      if (!project) return { kind: "no_project" as const };

      const [row] = await tx
        .insert(units)
        .values({
          tenantId: ctx.tenant.id,
          projectId: data.projectId,
          code: data.code,
          tower: data.tower ?? null,
          floor: data.floor ?? null,
          typology: data.typology ?? null,
          carpetAreaSqft: data.carpetAreaSqft ?? null,
          builtUpAreaSqft: data.builtUpAreaSqft ?? null,
          facing: data.facing ?? null,
          priceMinor: data.price ? toMinorUnits(data.price) : null,
          customFields: data.customFields ?? {},
        })
        .returning({ id: units.id });

      return { kind: "ok" as const, id: row?.id ?? null };
    });

    if (result_isNoProject(created)) {
      return salesFail("That project does not exist, or you cannot see it.");
    }
    if (!created.id) return salesFail("The unit could not be created.");

    await writeAudit(ctx, {
      action: "create",
      resourceType: "unit",
      resourceId: created.id,
      newValue: { code: data.code, projectId: data.projectId, price: data.price ?? null },
    });

    revalidatePath("/sales/inventory");
    return { ok: true, data: { id: created.id } };
  } catch (err) {
    return toSalesActionError(err, "createUnit");
  }
}

function result_isNoProject(
  value: { kind: "no_project" } | { kind: "ok"; id: string | null },
): value is { kind: "no_project" } {
  return value.kind === "no_project";
}

export async function updateUnit(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await guardSalesWrite({
      operation: "units:update",
      feature: "sales.inventory",
      permission: "units:update",
    });

    const data = updateUnitSchema.parse(input);

    const areaProblem = unitAreaCoherent(data);
    if (areaProblem) return salesFail(areaProblem);

    const updated = await withTenant(ctx.tenant.id, async (tx) => {
      const result = await tx
        .update(units)
        .set({
          ...(data.code !== undefined ? { code: data.code } : {}),
          ...(data.tower !== undefined ? { tower: data.tower } : {}),
          ...(data.floor !== undefined ? { floor: data.floor } : {}),
          ...(data.typology !== undefined ? { typology: data.typology } : {}),
          ...(data.carpetAreaSqft !== undefined ? { carpetAreaSqft: data.carpetAreaSqft } : {}),
          ...(data.builtUpAreaSqft !== undefined
            ? { builtUpAreaSqft: data.builtUpAreaSqft }
            : {}),
          ...(data.facing !== undefined ? { facing: data.facing } : {}),
          ...(data.price !== undefined
            ? { priceMinor: data.price ? toMinorUnits(data.price) : null }
            : {}),
          ...(data.customFields !== undefined ? { customFields: data.customFields } : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(units.id, data.id),
            eq(units.tenantId, ctx.tenant.id),
            isNull(units.deletedAt),
          ),
        )
        .returning({ id: units.id });
      return result[0] ?? null;
    });

    if (!updated) return salesFail("That unit does not exist, or you cannot see it.");

    await writeAudit(ctx, {
      action: "update",
      resourceType: "unit",
      resourceId: data.id,
      newValue: { ...data } as Record<string, unknown>,
    });

    revalidatePath("/sales/inventory");
    return { ok: true, data: updated };
  } catch (err) {
    return toSalesActionError(err, "updateUnit");
  }
}

/* ------------------------------------------------------------------ */
/* HOLDS                                                              */
/* ------------------------------------------------------------------ */

/**
 * Hold a unit for a named buyer.
 *
 * ⚠️ THE `FOR UPDATE` IS WHAT MAKES THIS SAFE.
 *
 * Reading the unit's status and then writing it is the same race as the
 * double-booking: two reps read `available`, both write `held`, and the
 * second silently overwrites the first — including who it was held for.
 * No error, no symptom, and the first rep finds out when their buyer
 * arrives to a flat held for somebody else.
 *
 * The row lock serialises them, so the second attempt reads the first
 * one's effect and is refused with an explanation.
 */
export async function holdUnit(input: unknown): Promise<
  ActionResult<{ unitId: string; holdUntil: string }>
> {
  try {
    const ctx = await guardSalesWrite({
      operation: "units:hold",
      feature: "sales.inventory",
      permission: "units:hold",
    });

    const data = holdUnitSchema.parse(input);
    const now = new Date();
    const policy = resolveHoldPolicy(null);

    if (policy.requireToken && !data.tokenAmount) {
      return salesFail("A token amount is required to hold a unit in this workspace.");
    }

    const outcome = await withTenant(ctx.tenant.id, async (tx) => {
      // ⚠️ FOR UPDATE. See the note above.
      const locked = (await tx.execute(sql`
        SELECT id, code, status, deleted_at, hold_until, held_for_lead_id
          FROM units
         WHERE id = ${data.unitId} AND tenant_id = ${ctx.tenant.id}
         FOR UPDATE
      `)) as unknown as { rows?: Record<string, unknown>[] };

      const row = (Array.isArray(locked) ? locked[0] : locked.rows?.[0]) as
        | {
            id: string;
            code: string;
            status: "available" | "held" | "booked" | "sold" | "blocked";
            deleted_at: Date | null;
            hold_until: Date | null;
            held_for_lead_id: string | null;
          }
        | undefined;

      if (!row) return { kind: "no_unit" as const };

      const [lead] = await tx
        .select({ id: leads.id, name: leads.name })
        .from(leads)
        .where(
          and(
            eq(leads.id, data.leadId),
            eq(leads.tenantId, ctx.tenant.id),
            isNull(leads.deletedAt),
          ),
        )
        .limit(1);

      if (!lead) return { kind: "no_lead" as const };

      const verdict = canHold(
        {
          code: row.code,
          status: row.status,
          deletedAt: row.deleted_at,
          holdUntil: row.hold_until,
          heldForLeadId: row.held_for_lead_id,
        },
        data.leadId,
        now,
      );

      if (!verdict.allowed) {
        return { kind: "refused" as const, message: `${verdict.reason} ${verdict.remedy}` };
      }

      const holdUntil = holdExpiryFor(now, data.days ?? policy.defaultDays, policy);

      await tx
        .update(units)
        .set({
          status: "held",
          holdUntil,
          heldForLeadId: data.leadId,
          heldByUserId: ctx.user.id,
          holdTokenMinor: data.tokenAmount ? toMinorUnits(data.tokenAmount) : null,
          holdNote: data.note ?? null,
          updatedAt: now,
        })
        .where(and(eq(units.id, data.unitId), eq(units.tenantId, ctx.tenant.id)));

      return { kind: "ok" as const, holdUntil, unitCode: row.code, leadName: lead.name };
    });

    if (outcome.kind === "no_unit") {
      return salesFail("That unit does not exist, or you cannot see it.");
    }
    if (outcome.kind === "no_lead") {
      return salesFail("That lead does not exist, or you cannot see it.");
    }
    if (outcome.kind === "refused") return salesFail(outcome.message);

    await writeAudit(ctx, {
      action: "update",
      resourceType: "unit",
      resourceId: data.unitId,
      newValue: {
        status: "held",
        holdUntil: outcome.holdUntil.toISOString(),
        heldFor: outcome.leadName,
      },
      metadata: { unitCode: outcome.unitCode },
    });

    revalidatePath("/sales/inventory");
    return {
      ok: true,
      data: { unitId: data.unitId, holdUntil: outcome.holdUntil.toISOString() },
    };
  } catch (err) {
    return toSalesActionError(err, "holdUnit");
  }
}

export async function releaseHold(input: unknown): Promise<ActionResult<{ unitId: string }>> {
  try {
    const ctx = await guardSalesWrite({
      operation: "units:hold",
      feature: "sales.inventory",
      permission: "units:hold",
    });

    const data = releaseHoldSchema.parse(input);

    const released = await withTenant(ctx.tenant.id, async (tx) => {
      const result = await tx
        .update(units)
        .set({
          status: "available",
          holdUntil: null,
          heldForLeadId: null,
          heldByUserId: null,
          holdTokenMinor: null,
          holdNote: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(units.id, data.unitId),
            eq(units.tenantId, ctx.tenant.id),
            eq(units.status, "held"),
          ),
        )
        .returning({ id: units.id, code: units.code });
      return result[0] ?? null;
    });

    if (!released) {
      return salesFail(
        "That unit is not currently held, or you cannot see it. Refresh and try again.",
      );
    }

    await writeAudit(ctx, {
      action: "update",
      resourceType: "unit",
      resourceId: data.unitId,
      oldValue: { status: "held" },
      newValue: { status: "available" },
      reason: data.reason ?? undefined,
    });

    revalidatePath("/sales/inventory");
    return { ok: true, data: { unitId: data.unitId } };
  } catch (err) {
    return toSalesActionError(err, "releaseHold");
  }
}

/**
 * Sweep expired holds.
 *
 * ⚠️ Calls the database function rather than reimplementing the
 * predicate in TypeScript. Two definitions of "expired" drift, and the
 * one that drifts is always the one nobody is testing.
 *
 * Safe to call repeatedly — it only ever moves `held` → `available`, and
 * it refuses to free a unit that somehow carries a live booking.
 */
export async function releaseExpiredHolds(): Promise<ActionResult<{ released: number }>> {
  try {
    const ctx = await guardSalesWrite({
      operation: "units:hold",
      feature: "sales.inventory",
      permission: "units:read",
    });

    const released = await withTenant(ctx.tenant.id, async (tx) => {
      const result = (await tx.execute(
        sql`SELECT * FROM release_expired_unit_holds(${ctx.tenant.id}::uuid)`,
      )) as unknown as { rows?: unknown[] };
      const rows = Array.isArray(result) ? result : (result.rows ?? []);
      return rows.length;
    });

    if (released > 0) {
      await writeAudit(ctx, {
        action: "update",
        resourceType: "unit",
        metadata: { releasedExpiredHolds: released },
        reason: "Automatic release of expired holds.",
      });
      revalidatePath("/sales/inventory");
    }

    return { ok: true, data: { released } };
  } catch (err) {
    return toSalesActionError(err, "releaseExpiredHolds");
  }
}

/**
 * Block or unblock a unit.
 *
 * ⚠️ A SEPARATE PERMISSION FROM HOLDING, DELIBERATELY.
 *
 * A block is a management decision that does not expire and that no rep
 * can override. Giving it to everyone who can hold a unit would make it
 * indistinguishable from a hold in practice, which defeats the point of
 * having two states.
 */
export async function setUnitAvailability(input: unknown): Promise<ActionResult<{ unitId: string }>> {
  try {
    const ctx = await guardSalesWrite({
      operation: "units:block",
      feature: "sales.inventory",
      permission: "units:block",
    });

    const data = setUnitStatusSchema.parse(input);

    if (data.status === "blocked" && !data.reason?.trim()) {
      return salesFail(
        "Say why this unit is being withdrawn from sale. Six months from now " +
          "that is the only question anybody will ask about it.",
      );
    }

    const outcome = await withTenant(ctx.tenant.id, async (tx) => {
      const [existing] = await tx
        .select({ id: units.id, code: units.code, status: units.status })
        .from(units)
        .where(
          and(
            eq(units.id, data.unitId),
            eq(units.tenantId, ctx.tenant.id),
            isNull(units.deletedAt),
          ),
        )
        .limit(1);

      if (!existing) return { kind: "no_unit" as const };

      // Blocking a unit that is already sold or booked would hide a live
      // commitment from the board. Refused rather than silently applied.
      if (
        data.status === "blocked" &&
        (existing.status === "booked" || existing.status === "sold")
      ) {
        const [live] = await tx
          .select({ value: count() })
          .from(bookings)
          .where(
            and(
              eq(bookings.unitId, existing.id),
              eq(bookings.tenantId, ctx.tenant.id),
              sql`${bookings.status} <> 'cancelled'`,
            ),
          );
        if (Number(live?.value ?? 0) > 0) {
          return {
            kind: "refused" as const,
            message:
              `Unit ${existing.code} has a live booking and cannot be withdrawn ` +
              `from sale. Cancel the booking first, with a reason.`,
          };
        }
      }

      await tx
        .update(units)
        .set({
          status: data.status,
          holdUntil: null,
          heldForLeadId: null,
          heldByUserId: null,
          holdNote: data.reason ?? null,
          updatedAt: new Date(),
        })
        .where(and(eq(units.id, data.unitId), eq(units.tenantId, ctx.tenant.id)));

      return { kind: "ok" as const, from: existing.status, code: existing.code };
    });

    if (outcome.kind === "no_unit") {
      return salesFail("That unit does not exist, or you cannot see it.");
    }
    if (outcome.kind === "refused") return salesFail(outcome.message);

    await writeAudit(ctx, {
      action: "update",
      resourceType: "unit",
      resourceId: data.unitId,
      oldValue: { status: outcome.from },
      newValue: { status: data.status },
      reason: data.reason ?? undefined,
      severity: data.status === "blocked" ? "warning" : undefined,
      metadata: { unitCode: outcome.code },
    });

    revalidatePath("/sales/inventory");
    return { ok: true, data: { unitId: data.unitId } };
  } catch (err) {
    return toSalesActionError(err, "setUnitAvailability");
  }
}
