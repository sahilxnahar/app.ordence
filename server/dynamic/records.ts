import "server-only";

/**
 * Ordence — Generic CRUD over any runtime object
 * Version: v0.24.0-alpha
 *
 * One set of functions that reads and writes EVERY tenant-defined record
 * type, whatever shape it happens to have.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHERE THE IDENTIFIERS IN THIS FILE COME FROM, AND WHY THAT IS SAFE
 * ══════════════════════════════════════════════════════════════════════
 * Every query below names a table and some columns that are not known at
 * compile time. They cannot be bind parameters — `SELECT $1 FROM $2` is
 * not SQL — so they are interpolated, which is the thing this codebase
 * spends twenty-three phases never doing.
 *
 * It is safe because of where the names come from and what happens to
 * them on the way, and BOTH halves are necessary:
 *
 *   1. THEY COME FROM `dynamic_objects` AND `dynamic_fields`, never from
 *      the request. The caller supplies a UUID and a set of VALUES. It
 *      never supplies a column name that is used as one — even `sortBy`,
 *      which looks like a caller-supplied identifier, is resolved against
 *      the object's real field list and refused if it is not on it.
 *
 *   2. ⚠️ AND THEY ARE RE-VALIDATED ANYWAY, on every read, by
 *      `assertPhysicalTableName` / `assertPhysicalColumnName`. Those rows
 *      were checked when they were written — months ago, by a code path
 *      that may since have been edited, into a table that a restore, a
 *      support fix or a bug could have altered. "It came from our own
 *      database" is the assumption behind a large fraction of second-order
 *      SQL injection. The check costs a regex per query.
 *
 *   3. `sql.identifier()` does the quoting. Never string concatenation,
 *      not once, anywhere in this file.
 *
 * ⚠️ AND EVERY VALUE IS STILL A BOUND PARAMETER. The identifier problem
 * does not extend to the data; treating it as though it did would be how
 * a customer's own record content becomes an injection.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { dynamicObjects, dynamicFields } from "@/db/schema";
import { requirePermission, writeAudit } from "@/server/audit";
import { guardDynamicWrite, toDynamicActionError, dynamicFail } from "./guards";
import {
  createDynamicRecordSchema,
  deleteDynamicRecordSchema,
  getDynamicRecordSchema,
  listDynamicRecordsSchema,
  updateDynamicRecordSchema,
} from "@/lib/validators/dynamic";
import {
  assertPhysicalColumnName,
  assertPhysicalTableName,
} from "@/lib/dynamic/identifiers";
import { validateRecordValues, type ValidatableField } from "@/lib/dynamic/values";
import type { DynamicField } from "@/db/schema";
import type { SelectChoice } from "@/lib/dynamic/field-types";
import type { ActionResult } from "@/lib/validators/crm";

/* ------------------------------------------------------------------ */
/* SHARED PLUMBING                                                     */
/* ------------------------------------------------------------------ */

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

/**
 * The system columns every runtime table has. Selected alongside the
 * customer's own fields so a record always has an id and timestamps
 * whatever it is called.
 *
 * ⚠️ `tenant_id` IS NOT IN THIS LIST AND IT IS NOT AN OVERSIGHT. It is
 * never selected and never written by this file. A generic reader that
 * returns it hands the tenant id to the client, where it becomes
 * something a form can post back — and the only thing between that and a
 * cross-tenant write is the WITH CHECK clause. Not offering it costs
 * nothing.
 */
const SYSTEM_SELECT = [
  "id",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
  // Returned so `includeDeleted` means something to the caller: a list of
  // records where the deleted ones are indistinguishable from the live
  // ones is a recycle bin that cannot be rendered.
  "deleted_at",
] as const;

type ResolvedObject = {
  id: string;
  apiName: string;
  table: string;
  displayFieldApiName: string | null;
  fields: DynamicField[];
};

/**
 * Find an object and its live fields, and validate every identifier on
 * the way out. Tenant-scoped in the query as well as by RLS.
 *
 * ⚠️ THE VALIDATION HAPPENS HERE, ONCE, SO NO CALLER CAN FORGET IT. If
 * `assertPhysicalTableName` were called at each query site instead, the
 * fourth query somebody adds is the one that skips it.
 */
async function resolveObject(
  tx: Tx,
  tenantId: string,
  objectId: string,
): Promise<ResolvedObject | null> {
  const [object] = await tx
    .select()
    .from(dynamicObjects)
    .where(
      and(
        eq(dynamicObjects.id, objectId),
        eq(dynamicObjects.tenantId, tenantId),
        isNull(dynamicObjects.archivedAt),
      ),
    )
    .limit(1);

  if (!object) return null;

  const fields = await tx
    .select()
    .from(dynamicFields)
    .where(
      and(
        eq(dynamicFields.objectId, object.id),
        eq(dynamicFields.tenantId, tenantId),
        isNull(dynamicFields.deletedAt),
      ),
    );

  return {
    id: object.id,
    apiName: object.apiName,
    table: assertPhysicalTableName(object.physicalTableName),
    displayFieldApiName: object.displayFieldApiName,
    fields: fields.map((f) => {
      assertPhysicalColumnName(f.physicalColumnName);
      return f;
    }),
  };
}

function validatableFields(fields: DynamicField[]): ValidatableField[] {
  return fields.map((f) => ({
    apiName: f.apiName,
    label: f.label,
    fieldType: f.fieldType,
    isRequired: f.isRequired,
    options: (f.options ?? []) as SelectChoice[],
  }));
}

/** Drizzle's `execute` shape differs by driver. Both are handled. */
function allRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  return (result as { rows?: Record<string, unknown>[] })?.rows ?? [];
}

/**
 * The SELECT list: system columns plus every live field.
 *
 * Built from `sql.identifier`, so a column name that somehow survived
 * both validations still cannot break out of an identifier position.
 */
function selectList(object: ResolvedObject) {
  const columns = [
    ...SYSTEM_SELECT.map((c) => sql.identifier(c)),
    ...object.fields.map((f) => sql.identifier(f.physicalColumnName)),
  ];
  return sql.join(columns, sql`, `);
}

/* ------------------------------------------------------------------ */
/* READ                                                                */
/* ------------------------------------------------------------------ */

export type DynamicRecordPage = {
  rows: Record<string, unknown>[];
  total: number;
  page: number;
  pageSize: number;
};

/**
 * ⚠️ `requirePermission` ALONE — a read. See `guards.ts`.
 */
export async function listDynamicRecords(
  input: unknown,
): Promise<ActionResult<DynamicRecordPage>> {
  try {
    const ctx = await requirePermission("custom_objects:read");
    const params = listDynamicRecordsSchema.parse(input);

    const page = await withTenant(ctx.tenant.id, async (tx) => {
      const object = await resolveObject(tx, ctx.tenant.id, params.objectId);
      if (!object) return null;

      /* --- ⭐ ORDER BY, THE SUBTLEST INJECTION SURFACE IN THE PHASE --- */
      //
      // `sortBy` arrives from the caller and becomes an identifier. The
      // regex in the validator is the first opinion; this is the check
      // that matters — the name must be one of THIS OBJECT'S FIELDS.
      // A name that survives it provably came out of our own metadata,
      // which is a stronger guarantee than any pattern match, and it also
      // stops one tenant sorting by a column that only exists on another
      // tenant's object (an existence oracle, if a small one).
      const sortField = params.sortBy
        ? object.fields.find((f) => f.apiName === params.sortBy)
        : null;

      if (params.sortBy && !sortField) {
        throw new Error(
          `Cannot sort by "${params.sortBy}" — this record type has no such field.`,
        );
      }

      const sortColumn = sortField
        ? sql.identifier(assertPhysicalColumnName(sortField.physicalColumnName))
        : sql.identifier("created_at");

      const direction = params.sortDir === "asc" ? sql`ASC` : sql`DESC`;

      /* --- Filters ------------------------------------------------- */
      const conditions = [sql`tenant_id = ${ctx.tenant.id}::uuid`];
      if (!params.includeDeleted) conditions.push(sql`deleted_at IS NULL`);

      // Search runs over the DISPLAY field only. Searching every text
      // column of an arbitrary table is a sequential scan with N ILIKEs
      // per row, on a table whose shape we do not control — the kind of
      // query that is fine on the developer's fifty rows and takes the
      // instance down on a customer's four hundred thousand.
      if (params.search) {
        const displayField = object.fields.find(
          (f) => f.apiName === object.displayFieldApiName,
        );
        if (displayField) {
          const column = sql.identifier(
            assertPhysicalColumnName(displayField.physicalColumnName),
          );
          conditions.push(sql`${column}::text ILIKE ${`%${params.search}%`}`);
        }
      }

      const where = sql.join(conditions, sql` AND `);
      const table = sql.identifier(object.table);
      const offset = (params.page - 1) * params.pageSize;

      const rowsResult = await tx.execute(sql`
        SELECT ${selectList(object)}
          FROM ${table}
         WHERE ${where}
         ORDER BY ${sortColumn} ${direction} NULLS LAST, id DESC
         LIMIT ${params.pageSize} OFFSET ${offset}
      `);

      const countResult = await tx.execute(sql`
        SELECT count(*)::int AS total FROM ${table} WHERE ${where}
      `);

      return {
        rows: allRows(rowsResult),
        total: Number(allRows(countResult)[0]?.total ?? 0),
        page: params.page,
        pageSize: params.pageSize,
      };
    });

    if (!page) return dynamicFail("That record type does not exist.");
    return { ok: true, data: page };
  } catch (err) {
    return toDynamicActionError(err, "listDynamicRecords");
  }
}

export async function getDynamicRecord(
  input: unknown,
): Promise<ActionResult<Record<string, unknown>>> {
  try {
    const ctx = await requirePermission("custom_objects:read");
    const params = getDynamicRecordSchema.parse(input);

    const record = await withTenant(ctx.tenant.id, async (tx) => {
      const object = await resolveObject(tx, ctx.tenant.id, params.objectId);
      if (!object) return null;

      const result = await tx.execute(sql`
        SELECT ${selectList(object)}
          FROM ${sql.identifier(object.table)}
         WHERE id = ${params.recordId}::uuid
           AND tenant_id = ${ctx.tenant.id}::uuid
           AND deleted_at IS NULL
         LIMIT 1
      `);

      return allRows(result)[0] ?? null;
    });

    if (!record) return dynamicFail("That record does not exist.");
    return { ok: true, data: record };
  } catch (err) {
    return toDynamicActionError(err, "getDynamicRecord");
  }
}

/* ------------------------------------------------------------------ */
/* WRITE                                                               */
/* ------------------------------------------------------------------ */

export async function createDynamicRecord(
  input: unknown,
): Promise<ActionResult<Record<string, unknown>>> {
  try {
    const ctx = await guardDynamicWrite({
      operation: "dynamicRecords:create",
      permission: "custom_objects:create_record",
    });

    const params = createDynamicRecordSchema.parse(input);

    const outcome = await withTenant(ctx.tenant.id, async (tx) => {
      const object = await resolveObject(tx, ctx.tenant.id, params.objectId);
      if (!object) return { kind: "missing" as const };

      const validation = validateRecordValues(
        validatableFields(object.fields),
        params.values,
        "create",
      );
      if (!validation.ok) {
        return { kind: "invalid" as const, fieldErrors: validation.fieldErrors };
      }

      const provided = object.fields.filter((f) =>
        Object.prototype.hasOwnProperty.call(validation.values, f.apiName),
      );

      // ⚠️ `tenant_id` IS SET FROM THE SESSION CONTEXT, NEVER FROM THE
      // PAYLOAD. `validateRecordValues` already refuses an unknown key and
      // no field may be called `tenant_id` — this is the third statement
      // of the same rule, and the WITH CHECK clause is the fourth.
      const columns = [
        sql.identifier("tenant_id"),
        sql.identifier("created_by"),
        sql.identifier("updated_by"),
        ...provided.map((f) => sql.identifier(f.physicalColumnName)),
      ];
      const values = [
        sql`${ctx.tenant.id}::uuid`,
        sql`${ctx.user.id}::uuid`,
        sql`${ctx.user.id}::uuid`,
        ...provided.map((f) => sql`${validation.values[f.apiName]}`),
      ];

      const result = await tx.execute(sql`
        INSERT INTO ${sql.identifier(object.table)}
          (${sql.join(columns, sql`, `)})
        VALUES
          (${sql.join(values, sql`, `)})
        RETURNING ${selectList(object)}
      `);

      const row = allRows(result)[0];
      if (!row) return { kind: "failed" as const };
      return { kind: "ok" as const, row, object };
    });

    if (outcome.kind === "missing") return dynamicFail("That record type does not exist.");
    if (outcome.kind === "invalid") {
      return dynamicFail("Please check the form.", outcome.fieldErrors);
    }
    if (outcome.kind === "failed") return dynamicFail("The record could not be created.");

    await writeAudit(ctx, {
      action: "create",
      resourceType: `dynamic:${outcome.object.apiName}`,
      resourceId: String(outcome.row.id),
    });

    return { ok: true, data: outcome.row };
  } catch (err) {
    return toDynamicActionError(err, "createDynamicRecord");
  }
}

export async function updateDynamicRecord(
  input: unknown,
): Promise<ActionResult<Record<string, unknown>>> {
  try {
    const ctx = await guardDynamicWrite({
      operation: "dynamicRecords:update",
      permission: "custom_objects:update_record",
    });

    const params = updateDynamicRecordSchema.parse(input);

    const outcome = await withTenant(ctx.tenant.id, async (tx) => {
      const object = await resolveObject(tx, ctx.tenant.id, params.objectId);
      if (!object) return { kind: "missing" as const };

      // ⚠️ `update` MODE IS A PATCH. An absent key means "leave it alone",
      // so a caller editing one field does not have to re-send the other
      // ninety-nine — and a required field they were not editing does not
      // make the whole update impossible.
      const validation = validateRecordValues(
        validatableFields(object.fields),
        params.values,
        "update",
      );
      if (!validation.ok) {
        return { kind: "invalid" as const, fieldErrors: validation.fieldErrors };
      }

      const provided = object.fields.filter((f) =>
        Object.prototype.hasOwnProperty.call(validation.values, f.apiName),
      );

      if (provided.length === 0) {
        return { kind: "invalid" as const, fieldErrors: { values: ["Nothing to change."] } };
      }

      const assignments = [
        ...provided.map(
          (f) => sql`${sql.identifier(f.physicalColumnName)} = ${validation.values[f.apiName]}`,
        ),
        sql`${sql.identifier("updated_by")} = ${ctx.user.id}::uuid`,
      ];

      // ⚠️ `tenant_id = :tenant` IS IN THE WHERE CLAUSE AS WELL AS RLS.
      // RLS makes another tenant's row invisible; this makes the statement
      // WRONG rather than merely empty if a connection ever loses its
      // context. Both, always — the same pattern as Phase 23's effects.
      const result = await tx.execute(sql`
        UPDATE ${sql.identifier(object.table)}
           SET ${sql.join(assignments, sql`, `)}
         WHERE id = ${params.recordId}::uuid
           AND tenant_id = ${ctx.tenant.id}::uuid
           AND deleted_at IS NULL
        RETURNING ${selectList(object)}
      `);

      const row = allRows(result)[0];
      if (!row) return { kind: "missing_record" as const };
      return { kind: "ok" as const, row, object };
    });

    if (outcome.kind === "missing") return dynamicFail("That record type does not exist.");
    if (outcome.kind === "missing_record") return dynamicFail("That record does not exist.");
    if (outcome.kind === "invalid") {
      return dynamicFail("Please check the form.", outcome.fieldErrors);
    }

    await writeAudit(ctx, {
      action: "update",
      resourceType: `dynamic:${outcome.object.apiName}`,
      resourceId: String(outcome.row.id),
    });

    return { ok: true, data: outcome.row };
  } catch (err) {
    return toDynamicActionError(err, "updateDynamicRecord");
  }
}

/**
 * ⚠️ A SOFT DELETE, AND IT IS NOT THE SAME DECISION AS `removeField`.
 *
 * Dropping a FIELD destroys a column, because a column nobody can see and
 * everybody is still storing is personal data held in secret. Deleting a
 * RECORD is an ordinary product action taken by ordinary people on a
 * Tuesday, and the recoverable version is what they mean by it. The row
 * stays, `deleted_at` is stamped, and every read in this file already
 * filters on it.
 */
export async function deleteDynamicRecord(
  input: unknown,
): Promise<ActionResult<{ recordId: string }>> {
  try {
    const ctx = await guardDynamicWrite({
      operation: "dynamicRecords:delete",
      // A soft delete is an UPDATE, so the database DELETE guard never
      // fires on it. This key is what refuses it.
      impersonationOperation: "delete:dynamic_record",
      permission: "custom_objects:delete_record",
    });

    const params = deleteDynamicRecordSchema.parse(input);

    const outcome = await withTenant(ctx.tenant.id, async (tx) => {
      const object = await resolveObject(tx, ctx.tenant.id, params.objectId);
      if (!object) return null;

      const result = await tx.execute(sql`
        UPDATE ${sql.identifier(object.table)}
           SET deleted_at = now(), deleted_by = ${ctx.user.id}::uuid
         WHERE id = ${params.recordId}::uuid
           AND tenant_id = ${ctx.tenant.id}::uuid
           AND deleted_at IS NULL
        RETURNING id
      `);

      const row = allRows(result)[0];
      return row ? { id: String(row.id), apiName: object.apiName } : null;
    });

    if (!outcome) return dynamicFail("That record does not exist.");

    await writeAudit(ctx, {
      action: "delete",
      resourceType: `dynamic:${outcome.apiName}`,
      resourceId: outcome.id,
      reason: "Soft-deleted a custom record. The row is retained and recoverable.",
    });

    return { ok: true, data: { recordId: outcome.id } };
  } catch (err) {
    return toDynamicActionError(err, "deleteDynamicRecord");
  }
}
