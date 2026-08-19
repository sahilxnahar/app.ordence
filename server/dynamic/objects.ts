import "server-only";

/**
 * Ordence — Runtime Object Schema Management
 * Version: v0.24.0-alpha
 *
 * Create, alter and drop tenant-defined record types. Every function here
 * ends up issuing real DDL against the shared database.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE METADATA ROW AND THE PHYSICAL TABLE ARE ONE TRANSACTION
 * ══════════════════════════════════════════════════════════════════════
 * PostgreSQL is one of the few databases where `CREATE TABLE` can be
 * rolled back, and this phase is built on that. Every function below does
 * the metadata write and the DDL inside a single `withTenant()`
 * transaction, so there are exactly two outcomes and no third:
 *
 *   • both, or
 *   • neither.
 *
 * ⚠️ THE THIRD OUTCOME IS WHAT THIS BUYS. Without the transaction:
 *
 *   A metadata row with no table  → the object appears in the customer's
 *     navigation and every query against it fails with `relation "cx_…"
 *     does not exist`, an error naming a table they have never heard of.
 *
 *   A table with no metadata row  → worse. Customer data, potentially
 *     personal data, in a table that nothing in the product can list,
 *     export, retain or delete. It is invisible to the tenant, invisible
 *     to support, and it still appears in every backup.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THE DDL IS A FUNCTION CALL AND NOT SQL BUILT HERE
 * ══════════════════════════════════════════════════════════════════════
 * `dynamic_create_object_table()` attaches `tenant_id NOT NULL`, ENABLE +
 * FORCE row-level security and a policy with both USING and WITH CHECK,
 * and then re-reads the catalogue to prove it did. It takes no argument
 * that would skip any of that.
 *
 * If this file assembled the DDL instead, "remember the RLS" would be a
 * code-review rule — and `SQL-FILES/0019` §9 revokes CREATE on the schema
 * from the application role precisely so that it cannot become one.
 */

import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { dynamicObjects, dynamicFields } from "@/db/schema";
import { requirePermission, writeAudit } from "@/server/audit";
import { guardDynamicWrite, toDynamicActionError, dynamicFail } from "./guards";
import {
  addDynamicFieldSchema,
  archiveDynamicObjectSchema,
  createDynamicObjectSchema,
  dropDynamicObjectSchema,
  removeDynamicFieldSchema,
  renameDynamicObjectSchema,
  updateDynamicFieldSchema,
} from "@/lib/validators/dynamic";
import {
  describePlan,
  planFields,
  planObject,
  DdlPlanError,
  type FieldPlan,
} from "@/lib/dynamic/ddl";
import { assertPhysicalTableName } from "@/lib/dynamic/identifiers";
import { MAX_OBJECTS_PER_TENANT } from "@/lib/dynamic/limits";
import type { DynamicField, DynamicObject, DynamicObjectWithFields } from "@/db/schema";
import type { DynamicFieldType, SelectChoice } from "@/lib/dynamic/field-types";
import type { ActionResult } from "@/lib/validators/crm";

/* ------------------------------------------------------------------ */
/* READS                                                               */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ `requirePermission` ALONE, NO ENTITLEMENT GATE.
 *
 * A workspace whose plan lapsed must still be able to see what record
 * types it has, if only to export them before it leaves. Locking the READ
 * behind the plan turns a downgrade into a hostage situation.
 */
export async function listDynamicObjects(): Promise<
  ActionResult<{ rows: DynamicObjectWithFields[] }>
> {
  try {
    const ctx = await requirePermission("custom_objects:read");

    const rows = await withTenant(ctx.tenant.id, async (tx) => {
      const objects = await tx
        .select()
        .from(dynamicObjects)
        .where(
          and(
            eq(dynamicObjects.tenantId, ctx.tenant.id),
            isNull(dynamicObjects.archivedAt),
          ),
        )
        .orderBy(asc(dynamicObjects.sortOrder), asc(dynamicObjects.label))
        .limit(MAX_OBJECTS_PER_TENANT + 1);

      const fields = await tx
        .select()
        .from(dynamicFields)
        .where(
          and(eq(dynamicFields.tenantId, ctx.tenant.id), isNull(dynamicFields.deletedAt)),
        )
        .orderBy(asc(dynamicFields.sortOrder));

      return objects.map((object) => ({
        ...object,
        fields: fields.filter((f) => f.objectId === object.id),
      }));
    });

    return { ok: true, data: { rows } };
  } catch (err) {
    return toDynamicActionError(err, "listDynamicObjects");
  }
}

export async function getDynamicObject(input: {
  objectId: string;
}): Promise<ActionResult<DynamicObjectWithFields>> {
  try {
    const ctx = await requirePermission("custom_objects:read");

    const found = await withTenant(ctx.tenant.id, (tx) =>
      loadObject(tx, ctx.tenant.id, input.objectId),
    );

    if (!found) return dynamicFail("That record type does not exist.");
    return { ok: true, data: found };
  } catch (err) {
    return toDynamicActionError(err, "getDynamicObject");
  }
}

/**
 * Load an object and its live fields, tenant-scoped.
 *
 * ⚠️ THE TENANT PREDICATE IS EXPLICIT EVEN THOUGH RLS IS ON. Belt and
 * braces, the same as everywhere else in this codebase: RLS makes the row
 * invisible, and this makes the statement WRONG rather than merely empty
 * if a connection ever loses its tenant context.
 */
type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

async function loadObject(
  tx: Tx,
  tenantId: string,
  objectId: string,
): Promise<DynamicObjectWithFields | null> {
  const [object] = await tx
    .select()
    .from(dynamicObjects)
    .where(and(eq(dynamicObjects.id, objectId), eq(dynamicObjects.tenantId, tenantId)))
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
    )
    .orderBy(asc(dynamicFields.sortOrder));

  return { ...object, fields };
}

/* ------------------------------------------------------------------ */
/* CREATE                                                              */
/* ------------------------------------------------------------------ */

/**
 * ⭐ Define a record type: one metadata row, one physical table, one
 * column per field, one transaction.
 *
 * The order matters and is not arbitrary:
 *
 *   1. Insert the `dynamic_objects` row FIRST. The factory function
 *      counts rows to enforce the per-tenant cap, so the new object has
 *      to be visible to its own count — otherwise fifty concurrent
 *      requests each see forty-nine and all fifty succeed.
 *   2. Call the factory. It creates the table WITH row-level security and
 *      raises if the result is not protected.
 *   3. Insert the field rows and add the columns, one pair at a time. A
 *      failure anywhere unwinds all of it.
 */
export async function createDynamicObject(
  input: unknown,
): Promise<ActionResult<DynamicObjectWithFields>> {
  try {
    const ctx = await guardDynamicWrite({
      operation: "dynamicObjects:create",
      permission: "custom_objects:define",
    });

    const data = createDynamicObjectSchema.parse(input);

    const created = await withTenant(ctx.tenant.id, async (tx) => {
      /* --- Resolve relation targets before planning ---------------- */
      //
      // ⚠️ ONLY OBJECTS IN THIS TENANT. The lookup carries the tenant
      // predicate, so a field pointing at another workspace's object
      // resolves to nothing and the plan refuses it with the same message
      // it would give for an id that does not exist anywhere. Anything
      // else is an oracle for which object ids are real.
      const siblings = await tx
        .select({
          id: dynamicObjects.id,
          physicalTableName: dynamicObjects.physicalTableName,
        })
        .from(dynamicObjects)
        .where(
          and(
            eq(dynamicObjects.tenantId, ctx.tenant.id),
            isNull(dynamicObjects.archivedAt),
          ),
        );

      const tableById = new Map(siblings.map((s) => [s.id, s.physicalTableName]));

      const objectId = crypto.randomUUID();
      const plan = planObject({ apiName: data.apiName, objectId });
      const fieldPlans = planFields(
        data.fields,
        (id) => tableById.get(id) ?? null,
      );

      if (
        data.displayFieldApiName &&
        !fieldPlans.some((f) => f.apiName === data.displayFieldApiName)
      ) {
        throw new DdlPlanError(
          "displayFieldApiName",
          `"${data.displayFieldApiName}" is not one of this record type's fields, ` +
            `so it cannot be the one shown in lists.`,
        );
      }

      /* --- 1. The metadata row ------------------------------------- */
      const [object] = await tx
        .insert(dynamicObjects)
        .values({
          id: objectId,
          tenantId: ctx.tenant.id,
          apiName: plan.apiName,
          label: data.label,
          pluralLabel: data.pluralLabel ?? `${data.label}s`,
          description: data.description ?? null,
          icon: data.icon,
          color: data.color,
          physicalTableName: plan.tableName,
          displayFieldApiName: data.displayFieldApiName ?? fieldPlans[0]!.apiName,
          createdBy: ctx.user.id,
        })
        .returning();

      if (!object) throw new Error("The record type could not be created.");

      /* --- 2. ⭐ The table, with RLS attached by the factory -------- */
      await tx.execute(
        sql`SELECT dynamic_create_object_table(${ctx.tenant.id}::uuid, ${plan.tableName})`,
      );

      /* --- 3. The fields ------------------------------------------- */
      const fieldRows: DynamicField[] = [];
      for (const [index, fieldPlan] of fieldPlans.entries()) {
        const source = data.fields[index]!;
        fieldRows.push(
          await addOneField(tx, {
            tenantId: ctx.tenant.id,
            objectId: object.id,
            tableName: plan.tableName,
            plan: fieldPlan,
            label: source.label,
            helpText: source.helpText ?? null,
            placeholder: source.placeholder ?? null,
            isHidden: source.isHidden,
            showInGrid: source.showInGrid,
            options: source.options as SelectChoice[],
            relation: source.relation ?? null,
            sortOrder: source.sortOrder || index,
          }),
        );
      }

      return { ...object, fields: fieldRows };
    });

    await writeAudit(ctx, {
      action: "config_change",
      resourceType: "dynamic_object",
      resourceId: created.id,
      newValue: { apiName: created.apiName, table: created.physicalTableName },
      // ⚠️ THE PLAN IN WORDS, NOT A DIFF OF TWO ROWS. A schema change is
      // the one change that cannot be undone by editing a row, so the
      // trail records what was actually built, in the sentences the person
      // was shown before they agreed to it. Reconstructed from the rows
      // that were written rather than from the input, so it describes what
      // happened rather than what was asked for.
      reason: describePlan(
        { apiName: created.apiName, tableName: created.physicalTableName },
        created.fields.map((f) => ({
          apiName: f.apiName,
          columnName: f.physicalColumnName,
          fieldType: f.fieldType,
          pgType: "",
          isRequired: f.isRequired,
          isUnique: f.isUnique,
          isIndexed: f.isIndexed,
          optionValues: (f.options ?? []).map((o) => o.value),
          relationTable: f.relationCoreTable,
          onDelete: f.fieldType === "relation" ? (f.isRequired ? "restrict" : "set_null") : null,
        })),
      ).join(" "),
    });

    return { ok: true, data: created };
  } catch (err) {
    return toDynamicActionError(err, "createDynamicObject");
  }
}

/* ------------------------------------------------------------------ */
/* FIELDS                                                              */
/* ------------------------------------------------------------------ */

/**
 * Write one field row AND add its column, in that order, in the caller's
 * transaction.
 *
 * ⚠️ THE ROW FIRST, BECAUSE THE FIELD CAP IS COUNTED IN THE DATABASE.
 * `dynamic_add_field_column` counts `dynamic_fields` to enforce the
 * hundred-field limit; a column added before its row would be invisible
 * to that count, and two concurrent requests could each see ninety-nine.
 */
async function addOneField(
  tx: Tx,
  args: {
    tenantId: string;
    objectId: string;
    tableName: string;
    plan: FieldPlan;
    label: string;
    helpText: string | null;
    placeholder: string | null;
    isHidden: boolean;
    showInGrid: boolean;
    options: SelectChoice[];
    relation: { kind: "object"; objectId: string } | { kind: "core"; table: string } | null;
    sortOrder: number;
  },
): Promise<DynamicField> {
  const { plan } = args;

  const [row] = await tx
    .insert(dynamicFields)
    .values({
      tenantId: args.tenantId,
      objectId: args.objectId,
      apiName: plan.apiName,
      label: args.label,
      helpText: args.helpText,
      placeholder: args.placeholder,
      fieldType: plan.fieldType as DynamicFieldType,
      physicalColumnName: plan.columnName,
      isRequired: plan.isRequired,
      isUnique: plan.isUnique,
      isIndexed: plan.isIndexed,
      isHidden: args.isHidden,
      showInGrid: args.showInGrid,
      options: args.options,
      relationObjectId: args.relation?.kind === "object" ? args.relation.objectId : null,
      relationCoreTable: args.relation?.kind === "core" ? args.relation.table : null,
      sortOrder: args.sortOrder,
    })
    .returning();

  if (!row) throw new Error(`The field "${plan.apiName}" could not be created.`);

  // ⚠️ EVERY ARGUMENT IS A BOUND PARAMETER. The identifiers travel as
  // VALUES into a function that validates and quotes them with `%I` — so
  // nothing in this file ever concatenates a customer's string into SQL.
  // That is the whole reason the DDL lives in the database.
  await tx.execute(sql`
    SELECT dynamic_add_field_column(
      ${args.tenantId}::uuid,
      ${args.tableName},
      ${plan.columnName},
      ${plan.fieldType},
      ${plan.isRequired},
      ${plan.isUnique},
      ${plan.isIndexed},
      ${plan.optionValues.length ? plan.optionValues : null}::text[],
      ${plan.relationTable},
      ${plan.onDelete ?? "set_null"}
    )
  `);

  return row;
}

export async function addDynamicField(input: unknown): Promise<ActionResult<DynamicField>> {
  try {
    const ctx = await guardDynamicWrite({
      operation: "dynamicObjects:alter",
      permission: "custom_objects:define",
    });

    const data = addDynamicFieldSchema.parse(input);

    const field = await withTenant(ctx.tenant.id, async (tx) => {
      const object = await loadObject(tx, ctx.tenant.id, data.objectId);
      if (!object) throw new DdlPlanError(null, "That record type does not exist.");
      if (object.archivedAt) {
        throw new DdlPlanError(
          null,
          "This record type is archived. Restore it before changing its fields — " +
            "altering something that is on its way out is how a half-finished " +
            "migration ends up permanent.",
        );
      }

      const table = assertPhysicalTableName(object.physicalTableName);

      const siblings = await tx
        .select({
          id: dynamicObjects.id,
          physicalTableName: dynamicObjects.physicalTableName,
        })
        .from(dynamicObjects)
        .where(
          and(
            eq(dynamicObjects.tenantId, ctx.tenant.id),
            isNull(dynamicObjects.archivedAt),
          ),
        );
      const tableById = new Map(siblings.map((s) => [s.id, s.physicalTableName]));

      const [plan] = planFields(
        [data.field],
        (id) => tableById.get(id) ?? null,
        object.fields.map((f) => ({ apiName: f.apiName, isIndexed: f.isIndexed })),
      );

      return addOneField(tx, {
        tenantId: ctx.tenant.id,
        objectId: object.id,
        tableName: table,
        plan: plan!,
        label: data.field.label,
        helpText: data.field.helpText ?? null,
        placeholder: data.field.placeholder ?? null,
        isHidden: data.field.isHidden,
        showInGrid: data.field.showInGrid,
        options: data.field.options as SelectChoice[],
        relation: data.field.relation ?? null,
        sortOrder: data.field.sortOrder || object.fields.length,
      });
    });

    await writeAudit(ctx, {
      action: "config_change",
      resourceType: "dynamic_field",
      resourceId: field.id,
      newValue: { apiName: field.apiName, fieldType: field.fieldType },
      reason: `Added the field "${field.apiName}" (${field.fieldType}).`,
    });

    return { ok: true, data: field };
  } catch (err) {
    return toDynamicActionError(err, "addDynamicField");
  }
}

/**
 * Edit a field's PRESENTATION. See `updateDynamicFieldSchema` for why
 * neither the name nor the type is editable.
 */
export async function updateDynamicField(
  input: unknown,
): Promise<ActionResult<DynamicField>> {
  try {
    const ctx = await guardDynamicWrite({
      operation: "dynamicObjects:alter",
      permission: "custom_objects:define",
    });

    const data = updateDynamicFieldSchema.parse(input);

    const updated = await withTenant(ctx.tenant.id, async (tx) => {
      const [row] = await tx
        .update(dynamicFields)
        .set({
          ...(data.label !== undefined ? { label: data.label } : {}),
          ...(data.helpText !== undefined ? { helpText: data.helpText ?? null } : {}),
          ...(data.placeholder !== undefined
            ? { placeholder: data.placeholder ?? null }
            : {}),
          ...(data.isHidden !== undefined ? { isHidden: data.isHidden } : {}),
          ...(data.showInGrid !== undefined ? { showInGrid: data.showInGrid } : {}),
          ...(data.sortOrder !== undefined ? { sortOrder: data.sortOrder } : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(dynamicFields.id, data.fieldId),
            eq(dynamicFields.tenantId, ctx.tenant.id),
            isNull(dynamicFields.deletedAt),
          ),
        )
        .returning();
      return row ?? null;
    });

    if (!updated) return dynamicFail("That field does not exist.");
    return { ok: true, data: updated };
  } catch (err) {
    return toDynamicActionError(err, "updateDynamicField");
  }
}

/**
 * ⭐ Remove a field. THIS DROPS THE COLUMN AND THE DATA IN IT.
 *
 * ⚠️ There is deliberately no "soft" version. A column the product has
 * stopped showing but is still storing is personal data nobody knows they
 * hold — a data-protection problem rather than a tidiness one. `isHidden`
 * is what "stop showing it" means, and it keeps the data.
 */
export async function removeDynamicField(
  input: unknown,
): Promise<ActionResult<{ apiName: string }>> {
  try {
    const ctx = await guardDynamicWrite({
      operation: "dynamicObjects:alter",
      // Drops the column and every value in it.
      impersonationOperation: "delete:dynamic_field",
      permission: "custom_objects:define",
    });

    const data = removeDynamicFieldSchema.parse(input);

    const removed = await withTenant(ctx.tenant.id, async (tx) => {
      const [field] = await tx
        .select()
        .from(dynamicFields)
        .where(
          and(
            eq(dynamicFields.id, data.fieldId),
            eq(dynamicFields.tenantId, ctx.tenant.id),
            isNull(dynamicFields.deletedAt),
          ),
        )
        .limit(1);

      if (!field) throw new DdlPlanError(null, "That field does not exist.");

      // The typed-back name. Cheap, and it is the only confirmation that
      // cannot be completed by muscle memory.
      if (data.confirmApiName !== field.apiName) {
        throw new DdlPlanError(
          "confirmApiName",
          `Type "${field.apiName}" to confirm. Removing a field deletes every ` +
            `value stored in it, for every record, and there is no undo.`,
        );
      }

      const [object] = await tx
        .select()
        .from(dynamicObjects)
        .where(
          and(
            eq(dynamicObjects.id, field.objectId),
            eq(dynamicObjects.tenantId, ctx.tenant.id),
          ),
        )
        .limit(1);

      if (!object) throw new DdlPlanError(null, "That record type does not exist.");

      if (object.displayFieldApiName === field.apiName) {
        throw new DdlPlanError(
          null,
          `"${field.apiName}" is what identifies a record in lists and pickers. ` +
            `Choose a different display field first, or every record would show ` +
            `as a blank row.`,
        );
      }

      const table = assertPhysicalTableName(object.physicalTableName);

      await tx
        .update(dynamicFields)
        .set({ deletedAt: new Date() })
        .where(eq(dynamicFields.id, field.id));

      await tx.execute(sql`
        SELECT dynamic_drop_field_column(
          ${ctx.tenant.id}::uuid, ${table}, ${field.physicalColumnName})
      `);

      return field;
    });

    await writeAudit(ctx, {
      action: "config_change",
      resourceType: "dynamic_field",
      resourceId: removed.id,
      oldValue: { apiName: removed.apiName, fieldType: removed.fieldType },
      reason: `Dropped the field "${removed.apiName}" and every value stored in it.`,
    });

    return { ok: true, data: { apiName: removed.apiName } };
  } catch (err) {
    return toDynamicActionError(err, "removeDynamicField");
  }
}

/* ------------------------------------------------------------------ */
/* RENAME, ARCHIVE, DROP                                               */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE RENAME THAT NEVER TOUCHES THE TABLE.
 *
 * The whole reason `physical_table_name` exists. Changing the label is
 * one UPDATE of one varchar. An `ALTER TABLE … RENAME` would be an ACCESS
 * EXCLUSIVE lock on a table that may hold millions of rows, taken in the
 * middle of a working day because somebody fixed a typo, and every
 * foreign key, index name, saved view and support runbook naming the old
 * table would have to be found.
 */
export async function renameDynamicObject(
  input: unknown,
): Promise<ActionResult<DynamicObject>> {
  try {
    const ctx = await guardDynamicWrite({
      operation: "dynamicObjects:alter",
      permission: "custom_objects:define",
    });

    const data = renameDynamicObjectSchema.parse(input);

    const updated = await withTenant(ctx.tenant.id, async (tx) => {
      if (data.displayFieldApiName) {
        const [field] = await tx
          .select({ id: dynamicFields.id })
          .from(dynamicFields)
          .where(
            and(
              eq(dynamicFields.objectId, data.objectId),
              eq(dynamicFields.tenantId, ctx.tenant.id),
              eq(dynamicFields.apiName, data.displayFieldApiName),
              isNull(dynamicFields.deletedAt),
            ),
          )
          .limit(1);
        if (!field) {
          throw new DdlPlanError(
            "displayFieldApiName",
            `"${data.displayFieldApiName}" is not a field on this record type.`,
          );
        }
      }

      const [row] = await tx
        .update(dynamicObjects)
        .set({
          label: data.label,
          ...(data.pluralLabel !== undefined ? { pluralLabel: data.pluralLabel } : {}),
          ...(data.description !== undefined
            ? { description: data.description ?? null }
            : {}),
          ...(data.icon !== undefined ? { icon: data.icon } : {}),
          ...(data.color !== undefined ? { color: data.color } : {}),
          ...(data.displayFieldApiName !== undefined
            ? { displayFieldApiName: data.displayFieldApiName ?? null }
            : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(dynamicObjects.id, data.objectId),
            eq(dynamicObjects.tenantId, ctx.tenant.id),
          ),
        )
        .returning();

      return row ?? null;
    });

    if (!updated) return dynamicFail("That record type does not exist.");
    return { ok: true, data: updated };
  } catch (err) {
    return toDynamicActionError(err, "renameDynamicObject");
  }
}

/**
 * Hide a record type without destroying anything.
 *
 * ⚠️ THE DEFAULT ANSWER TO "GET RID OF THIS". Archiving takes it out of
 * navigation and leaves the table and every row exactly where they are,
 * so an archive made in error is one UPDATE away from being undone. The
 * `DROP TABLE` version is a separate call with two confirmations and its
 * own dangerous permission.
 */
export async function archiveDynamicObject(
  input: unknown,
): Promise<ActionResult<{ objectId: string }>> {
  try {
    const ctx = await guardDynamicWrite({
      operation: "dynamicObjects:archive",
      permission: "custom_objects:define",
    });

    const data = archiveDynamicObjectSchema.parse(input);

    const archived = await withTenant(ctx.tenant.id, async (tx) => {
      const [row] = await tx
        .update(dynamicObjects)
        .set({
          archivedAt: new Date(),
          archivedBy: ctx.user.id,
          // ⚠️ Archiving also deactivates. An archived object whose
          // `is_active` is still true is one bug in a navigation query
          // away from coming back.
          isActive: false,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(dynamicObjects.id, data.objectId),
            eq(dynamicObjects.tenantId, ctx.tenant.id),
            isNull(dynamicObjects.archivedAt),
          ),
        )
        .returning({ id: dynamicObjects.id });
      return row ?? null;
    });

    if (!archived) return dynamicFail("That record type does not exist, or is already archived.");

    await writeAudit(ctx, {
      action: "config_change",
      resourceType: "dynamic_object",
      resourceId: archived.id,
      reason: "Archived a record type. Its table and every record are untouched.",
    });

    return { ok: true, data: { objectId: archived.id } };
  } catch (err) {
    return toDynamicActionError(err, "archiveDynamicObject");
  }
}

/**
 * ⭐⭐ DROP THE TABLE. THE MOST DESTRUCTIVE ACTION IN THE PRODUCT.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THREE INDEPENDENT CONFIRMATIONS, AND NONE OF THEM IS A BOOLEAN
 * ══════════════════════════════════════════════════════════════════════
 *   1. `custom_objects:drop_object` — its own permission, on the
 *      dangerous list, so the denial is audited as a security event.
 *   2. `confirmApiName` — the object's own name, typed back. The GitHub
 *      "type the repository name" pattern: the only confirmation that
 *      cannot be completed by muscle memory.
 *   3. ⭐ `confirmRecordCount` — the number of live records being
 *      destroyed, checked against the real count INSIDE the database. A
 *      `confirm: true` boolean is typed once by a developer at the call
 *      site and is true forever after; a count has to come from a screen
 *      a person read, and if it has changed since they read it the drop
 *      aborts.
 *
 * ⚠️ AND THERE IS NO `force`. The remedy for "the count changed" is to
 * look again, which is the entire point.
 */
export async function dropDynamicObject(
  input: unknown,
): Promise<ActionResult<{ objectId: string; recordsDestroyed: number }>> {
  try {
    const ctx = await guardDynamicWrite({
      operation: "dynamicObjects:drop",
      // ⭐ DROPs a real Postgres table and every row in it. The single
      // most destructive action in the product, and unrecoverable
      // in-product by the customer.
      impersonationOperation: "delete:dynamic_object",
      permission: "custom_objects:drop_object",
    });

    const data = dropDynamicObjectSchema.parse(input);

    const outcome = await withTenant(ctx.tenant.id, async (tx) => {
      const [object] = await tx
        .select()
        .from(dynamicObjects)
        .where(
          and(
            eq(dynamicObjects.id, data.objectId),
            eq(dynamicObjects.tenantId, ctx.tenant.id),
          ),
        )
        .limit(1);

      if (!object) throw new DdlPlanError(null, "That record type does not exist.");

      if (data.confirmApiName !== object.apiName) {
        throw new DdlPlanError(
          "confirmApiName",
          `Type "${object.apiName}" to confirm. This deletes the record type ` +
            `and every record in it, permanently.`,
        );
      }

      const table = assertPhysicalTableName(object.physicalTableName);

      // ⚠️ The count is verified inside `dynamic_drop_object_table`, not
      // here. A check in application code is a check a second call site
      // can skip; and between reading a count here and dropping there,
      // another request could have inserted.
      const result = await tx.execute(sql`
        SELECT dynamic_drop_object_table(
          ${ctx.tenant.id}::uuid, ${table}, ${data.confirmRecordCount}::bigint) AS destroyed
      `);

      // ⚠️ THE METADATA GOES LAST, IN THE SAME TRANSACTION. Deleting it
      // first and failing on the DROP would leave a table nothing can
      // enumerate. Deleting it at all is right here and nowhere else:
      // the description of a table that no longer exists is an object in
      // the customer's navigation whose every query fails.
      await tx
        .delete(dynamicObjects)
        .where(
          and(
            eq(dynamicObjects.id, object.id),
            eq(dynamicObjects.tenantId, ctx.tenant.id),
          ),
        );

      const rows = Array.isArray(result)
        ? (result as Record<string, unknown>[])
        : ((result as { rows?: Record<string, unknown>[] }).rows ?? []);

      return {
        objectId: object.id,
        apiName: object.apiName,
        table,
        recordsDestroyed: Number(rows[0]?.destroyed ?? data.confirmRecordCount),
      };
    });

    await writeAudit(ctx, {
      action: "delete",
      resourceType: "dynamic_object",
      resourceId: outcome.objectId,
      oldValue: { apiName: outcome.apiName, table: outcome.table },
      reason:
        `Dropped the record type "${outcome.apiName}" and its table ` +
        `${outcome.table}, destroying ${outcome.recordsDestroyed} record(s). ` +
        `This cannot be undone.`,
    });

    return {
      ok: true,
      data: { objectId: outcome.objectId, recordsDestroyed: outcome.recordsDestroyed },
    };
  } catch (err) {
    return toDynamicActionError(err, "dropDynamicObject");
  }
}
