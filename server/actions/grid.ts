"use server";

/**
 * Ordence — Grid Inline Edit Persistence
 * Version: v0.4.0-alpha
 *
 * RESOLVES SEC-009. In Phase 3 the grid's optimistic UI was fully wired but
 * `onCellEdit` resolved a timer — edits appeared to save and reverted on refresh.
 * These actions make them real.
 *
 * THE SPECIFIC HAZARD HERE:
 * The grid sends a `columnId` like `"dynamicAttributes.pricing.allInPrice"` —
 * a client-supplied path into a JSONB blob. Written naively, that is a direct
 * route to overwriting arbitrary keys, including ones the UI never exposes.
 *
 * Controls applied, in order:
 *   1. `tenantId` from the session; the row is fetched with BOTH id and tenant
 *   2. The JSONB column name is checked against an allowlist (never interpolated)
 *   3. Path segments are validated against `^[a-zA-Z0-9_]+$`
 *   4. `__proto__` / `constructor` / `prototype` are rejected outright
 *   5. Path depth capped at 4 and total keys capped, to bound blob growth
 *   6. For custom objects, the field must exist in `custom_field_definitions`
 *      and the value must pass that field's declared type validation
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { and, eq, isNull } from "drizzle-orm";
import { db, withTenant } from "@/db";
import {
  assets,
  customObjectRecords,
  customObjectDefinitions,
  customFieldDefinitions,
  auditLogs,
} from "@/db/schema";
import { requirePermission } from "@/server/audit";
import { requireTenantContext, TenantAccessError } from "@/server/tenant-context";
import { validateRecordData } from "@/lib/validators/crm";
import type { ActionResult } from "@/lib/validators/crm";
import type { CustomFieldDefinition } from "@/db/schema";

/* ------------------------------------------------------------------ */
/* VALIDATION                                                          */
/* ------------------------------------------------------------------ */

const uuidSchema = z.string().uuid("Invalid identifier.");

/** Only these JSONB columns may be edited through the grid. */
const EDITABLE_JSON_COLUMNS = ["dynamicAttributes", "customFields", "data"] as const;
type EditableJsonColumn = (typeof EDITABLE_JSON_COLUMNS)[number];

/** Scalar columns on `assets` the grid may edit directly. */
const EDITABLE_ASSET_COLUMNS = [
  "name",
  "code",
  "description",
  "status",
  "valueAmount",
  "areaValue",
  "areaUnit",
  "locality",
  "city",
  "state",
  "postalCode",
] as const;

const BLOCKED_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_PATH_DEPTH = 4;
const MAX_JSON_KEYS = 200;

const cellEditSchema = z.object({
  rowId: uuidSchema,
  /** "columnName" or "jsonColumn.path.to.key" */
  columnId: z.string().trim().min(1).max(200),
  /** JSON-serialisable scalar or array. Objects are rejected. */
  value: z.union([
    z.string().max(10_000),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(z.union([z.string().max(500), z.number(), z.boolean()])).max(100),
  ]),
});

export type CellEditInput = z.input<typeof cellEditSchema>;

function fail(error: string, fieldErrors?: Record<string, string[]>): ActionResult<never> {
  return { ok: false, error, fieldErrors };
}

function toActionError(err: unknown): ActionResult<never> {
  if (err instanceof TenantAccessError) return fail(err.message);
  if (err instanceof z.ZodError) {
    return fail("Validation failed.", err.flatten().fieldErrors as Record<string, string[]>);
  }
  console.error("[grid action]", err);
  return fail("Could not save the change. Please try again.");
}

/* ------------------------------------------------------------------ */
/* PATH PARSING                                                        */
/* ------------------------------------------------------------------ */

type ParsedColumn =
  | { kind: "scalar"; column: string }
  | { kind: "json"; jsonColumn: EditableJsonColumn; path: string[] };

/**
 * Parse and validate a client-supplied `columnId`.
 * Returns null for anything that fails — the caller treats that as a rejection,
 * never as "write it anyway".
 */
function parseColumnId(columnId: string): ParsedColumn | null {
  const segments = columnId.split(".");
  const head = segments[0];
  if (!head) return null;

  // Plain column reference.
  if (segments.length === 1) {
    return { kind: "scalar", column: head };
  }

  // JSONB path. The head must be an allowlisted column.
  if (!(EDITABLE_JSON_COLUMNS as readonly string[]).includes(head)) return null;

  const path = segments.slice(1);
  if (path.length === 0 || path.length > MAX_PATH_DEPTH) return null;

  for (const segment of path) {
    if (!segment) return null;
    if (BLOCKED_PATH_SEGMENTS.has(segment)) return null;
    if (!/^[a-zA-Z0-9_]+$/.test(segment)) return null;
  }

  return { kind: "json", jsonColumn: head as EditableJsonColumn, path };
}

/**
 * Immutably set a nested value, rebuilding each level with a null-prototype
 * object so a crafted key cannot reach `Object.prototype`.
 */
function setNested(
  source: Record<string, unknown>,
  path: string[],
  value: unknown,
): Record<string, unknown> {
  const [head, ...rest] = path;
  if (!head) return source;

  const next: Record<string, unknown> = Object.assign(Object.create(null), source);

  if (rest.length === 0) {
    next[head] = value;
    return { ...next };
  }

  const child = source[head];
  const childObject =
    child && typeof child === "object" && !Array.isArray(child)
      ? (child as Record<string, unknown>)
      : {};

  next[head] = setNested(childObject, rest, value);
  return { ...next };
}

/** Count keys across the whole blob, to bound growth. */
function countKeys(value: unknown, depth = 0): number {
  if (depth > 6 || !value || typeof value !== "object" || Array.isArray(value)) return 0;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length + entries.reduce((sum, [, v]) => sum + countKeys(v, depth + 1), 0);
}

/* ------------------------------------------------------------------ */
/* ASSET CELL EDIT                                                     */
/* ------------------------------------------------------------------ */

export async function updateAssetCell(
  input: CellEditInput,
): Promise<ActionResult<{ id: string; columnId: string }>> {
  try {
    const ctx = await requirePermission("assets:update");
    const parsed = cellEditSchema.parse(input);

    const column = parseColumnId(parsed.columnId);
    if (!column) return fail("That column cannot be edited.");

    // Fetch with BOTH predicates. Fetching by id alone would be the IDOR.
    const existing = await withTenant(ctx.tenant.id, (tx) =>
      tx.query.assets.findFirst({
        where: and(
          eq(assets.id, parsed.rowId),
          eq(assets.tenantId, ctx.tenant.id),
          isNull(assets.deletedAt),
        ),
      })
    );
    if (!existing) return fail("Record not found.");

    let updatePayload: Record<string, unknown>;
    let oldValue: unknown;

    if (column.kind === "scalar") {
      if (!(EDITABLE_ASSET_COLUMNS as readonly string[]).includes(column.column)) {
        return fail("That column cannot be edited.");
      }

      // Enum columns must be validated against their allowed values.
      if (column.column === "status") {
        const allowed = assets.status.enumValues as readonly string[];
        if (typeof parsed.value !== "string" || !allowed.includes(parsed.value)) {
          return fail("Validation failed.", { status: [`Must be one of: ${allowed.join(", ")}`] });
        }
      }

      // Numeric columns must parse cleanly — a bad string would corrupt the row.
      if (column.column === "valueAmount" || column.column === "areaValue") {
        if (parsed.value !== null) {
          const num = Number(parsed.value);
          if (!Number.isFinite(num) || num < 0) {
            return fail("Validation failed.", { [column.column]: ["Must be a positive number."] });
          }
        }
      }

      oldValue = (existing as unknown as Record<string, unknown>)[column.column];
      updatePayload = {
        [column.column]:
          parsed.value === null
            ? null
            : column.column === "valueAmount" || column.column === "areaValue"
              ? String(Number(parsed.value).toFixed(2))
              : String(parsed.value),
      };
    } else {
      if (column.jsonColumn !== "dynamicAttributes") {
        return fail("That column cannot be edited on this record.");
      }

      const current = (existing.dynamicAttributes ?? {}) as Record<string, unknown>;
      oldValue = column.path.reduce<unknown>(
        (acc, key) =>
          acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined,
        current,
      );

      const nextAttributes = setNested(current, column.path, parsed.value);

      if (countKeys(nextAttributes) > MAX_JSON_KEYS) {
        return fail("This record has too many custom fields to add another.");
      }

      updatePayload = { dynamicAttributes: nextAttributes };
    }

    const [updated] = await withTenant(ctx.tenant.id, (tx) =>
      tx
        .update(assets)
        .set({ ...updatePayload, updatedAt: new Date(), updatedBy: ctx.user.id })
        .where(and(eq(assets.id, parsed.rowId), eq(assets.tenantId, ctx.tenant.id)))
        .returning({ id: assets.id })
    );

    if (!updated) return fail("Could not save the change.");

    await writeAudit({
      tenantId: ctx.tenant.id,
      actorUserId: ctx.user.id,
      actorEmail: ctx.user.email,
      actorRole: ctx.role,
      resourceType: "asset",
      resourceId: parsed.rowId,
      oldValue: { [parsed.columnId]: oldValue },
      newValue: { [parsed.columnId]: parsed.value },
    });

    revalidatePath("/assets");
    return { ok: true, data: { id: updated.id, columnId: parsed.columnId } };
  } catch (err) {
    return toActionError(err);
  }
}

/* ------------------------------------------------------------------ */
/* CUSTOM OBJECT RECORD CELL EDIT                                      */
/* ------------------------------------------------------------------ */

export async function updateCustomRecordCell(
  input: CellEditInput,
): Promise<ActionResult<{ id: string; columnId: string }>> {
  try {
    const ctx = await requirePermission("custom_objects:update_record");
    const parsed = cellEditSchema.parse(input);

    const column = parseColumnId(parsed.columnId);
    if (!column) return fail("That column cannot be edited.");
    if (column.kind !== "json" || column.jsonColumn !== "data") {
      return fail("Only custom field values can be edited on this record.");
    }
    // Custom object fields are flat — a nested path would not match a definition.
    if (column.path.length !== 1) {
      return fail("Nested custom fields are not supported.");
    }
    const fieldName = column.path[0];
    if (!fieldName) return fail("Invalid field.");

    const record = await withTenant(ctx.tenant.id, (tx) =>
      tx.query.customObjectRecords.findFirst({
        where: and(
          eq(customObjectRecords.id, parsed.rowId),
          eq(customObjectRecords.tenantId, ctx.tenant.id),
          isNull(customObjectRecords.deletedAt),
        ),
      })
    );
    if (!record) return fail("Record not found.");

    // The definition must belong to this tenant too — belt and braces.
    const definition = await withTenant(ctx.tenant.id, (tx) =>
      tx.query.customObjectDefinitions.findFirst({
        where: and(
          eq(customObjectDefinitions.id, record.definitionId),
          eq(customObjectDefinitions.tenantId, ctx.tenant.id),
          isNull(customObjectDefinitions.deletedAt),
        ),
        with: { fields: { where: isNull(customFieldDefinitions.deletedAt) } },
      })
    );
    if (!definition) return fail("Object definition not found.");

    const fields = (definition as unknown as { fields: CustomFieldDefinition[] }).fields;
    const field = fields.find((f) => f.fieldName === fieldName);

    // The field must be declared. Undeclared keys are rejected, not stored.
    if (!field) return fail(`Unknown field "${fieldName}".`);

    // Re-validate the whole record so type rules and required-ness still hold.
    const merged: Record<string, unknown> = { ...(record.data ?? {}), [fieldName]: parsed.value };
    const validation = validateRecordData(merged, fields);
    if (!validation.ok) {
      return fail("Validation failed.", validation.fieldErrors);
    }

    const oldValue = (record.data ?? {})[fieldName];

    // Keep the denormalised display value in step with the display field.
    const displayValue =
      definition.displayFieldName && validation.cleaned[definition.displayFieldName] != null
        ? String(validation.cleaned[definition.displayFieldName]).slice(0, 500)
        : record.displayValue;

    const [updated] = await withTenant(ctx.tenant.id, (tx) =>
      tx
        .update(customObjectRecords)
        .set({
          data: validation.cleaned,
          displayValue,
          updatedAt: new Date(),
          updatedBy: ctx.user.id,
        })
        .where(
          and(
            eq(customObjectRecords.id, parsed.rowId),
            eq(customObjectRecords.tenantId, ctx.tenant.id),
          ),
        )
        .returning({ id: customObjectRecords.id })
    );

    if (!updated) return fail("Could not save the change.");

    await writeAudit({
      tenantId: ctx.tenant.id,
      actorUserId: ctx.user.id,
      actorEmail: ctx.user.email,
      actorRole: ctx.role,
      resourceType: "custom_object_record",
      resourceId: parsed.rowId,
      oldValue: { [fieldName]: oldValue },
      newValue: { [fieldName]: parsed.value },
    });

    revalidatePath(`/objects/${definition.slug}`);
    return { ok: true, data: { id: updated.id, columnId: parsed.columnId } };
  } catch (err) {
    return toActionError(err);
  }
}

/* ------------------------------------------------------------------ */
/* BULK STATUS UPDATE                                                  */
/* ------------------------------------------------------------------ */

const bulkStatusSchema = z.object({
  ids: z.array(uuidSchema).min(1).max(500),
  status: z.string().trim().min(1).max(50),
});

/** Apply a status to many assets at once. Bounded at 500 rows per call. */
export async function bulkUpdateAssetStatus(
  input: z.input<typeof bulkStatusSchema>,
): Promise<ActionResult<{ updated: number }>> {
  try {
    /**
     * ⚠️ `assets:bulk_update`, NOT `assets:update`, AND THIS CHANGES
     *    BEHAVIOUR — read before deploying.
     *
     * Until now any workspace member could bulk-change the status of
     * every asset they could see. `assets:bulk_update` is held only by
     * the owner and the administrator, so after this release a Team
     * Member editing one asset at a time still works and the bulk button
     * refuses.
     *
     * That is what the separate key is FOR: one careless bulk update
     * across a whole catalogue is a different act from editing a row,
     * and it is the one nobody can undo by hand.
     */
    const ctx = await requirePermission("assets:bulk_update");
    const parsed = bulkStatusSchema.parse(input);

    const allowed = assets.status.enumValues as readonly string[];
    if (!allowed.includes(parsed.status)) {
      return fail("Validation failed.", { status: [`Must be one of: ${allowed.join(", ")}`] });
    }

    const { inArray } = await import("drizzle-orm");

    const updated = await withTenant(ctx.tenant.id, (tx) =>
      tx
        .update(assets)
        .set({
          status: parsed.status as (typeof assets.status.enumValues)[number],
          updatedAt: new Date(),
          updatedBy: ctx.user.id,
        })
        // Tenant predicate applies to every row in the set.
        .where(
          and(
            inArray(assets.id, parsed.ids),
            eq(assets.tenantId, ctx.tenant.id),
            isNull(assets.deletedAt),
          ),
        )
        .returning({ id: assets.id })
    );

    await writeAudit({
      tenantId: ctx.tenant.id,
      actorUserId: ctx.user.id,
      actorEmail: ctx.user.email,
      actorRole: ctx.role,
      resourceType: "asset",
      resourceId: `bulk:${updated.length}`,
      newValue: { status: parsed.status, count: updated.length },
    });

    revalidatePath("/assets");
    return { ok: true, data: { updated: updated.length } };
  } catch (err) {
    return toActionError(err);
  }
}

/* ------------------------------------------------------------------ */
/* AUDIT                                                               */
/* ------------------------------------------------------------------ */

/** Best-effort audit write — never allowed to fail the user's edit. */
async function writeAudit(entry: {
  tenantId: string;
  actorUserId: string;
  actorEmail: string;
  actorRole: string;
  resourceType: string;
  resourceId: string;
  oldValue?: Record<string, unknown>;
  newValue?: Record<string, unknown>;
}): Promise<void> {
  try {
    /** ⚠️ Into the customer's own log, so it writes AS that tenant. */
    await withTenant(entry.tenantId, (tx) =>
      tx.insert(auditLogs).values({
      tenantId: entry.tenantId,
      actorUserId: entry.actorUserId,
      actorEmail: entry.actorEmail,
      actorRole: entry.actorRole,
      action: "update",
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      oldValue: entry.oldValue ?? null,
      newValue: entry.newValue ?? null,
      reason: "Inline grid edit",
      }),
    );
  } catch (err) {
    console.error("[grid audit]", err);
  }
}
