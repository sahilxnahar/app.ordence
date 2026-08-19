"use server";

/**
 * Ordence — Custom Object Server Actions
 * Version: v0.2.0-alpha
 *
 * Same isolation contract as contacts.ts: `tenantId` always comes from the
 * session, every query carries the tenant predicate.
 *
 * EXTRA HAZARD HERE: `data` is a free-form JSONB blob supplied by the client.
 * It is validated field-by-field against `custom_field_definitions` before any
 * write, and unknown keys are REJECTED rather than silently stored. Accepting
 * arbitrary keys would let a caller bloat rows or smuggle payloads past the UI.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { and, eq, isNull, desc, asc, count, sql } from "drizzle-orm";
import { db, withTenant } from "@/db";
import {
  customObjectDefinitions,
  customFieldDefinitions,
  customObjectRecords,
  dynamicObjects,
  dynamicFields,
} from "@/db/schema";
import { requirePermission } from "@/server/audit";
import {
  requireTenantContext,
  requireRole,
  ADMIN_ROLES,
  TenantAccessError,
} from "@/server/tenant-context";
import { requireFeature, FeatureLockedError } from "@/server/entitlements";
import { requireAccess, AccessRestrictedError } from "@/server/billing/access";
import {
  slugSchema,
  defineCustomObjectSchema,
  createCustomRecordSchema,
  listCustomRecordsSchema,
  validateRecordData,
  slugify,
  type ActionResult,
  type DefineCustomObjectInput,
  type CreateCustomRecordInput,
  type ListCustomRecordsInput,
} from "@/lib/validators/crm";
import type {
  CustomObjectRecord,
  CustomObjectWithFields,
} from "@/db/schema";

/* ------------------------------------------------------------------ */
/* ERROR HANDLING                                                      */
/* ------------------------------------------------------------------ */

function fail(error: string, fieldErrors?: Record<string, string[]>): ActionResult<never> {
  return { ok: false, error, fieldErrors };
}

function toActionError(err: unknown): ActionResult<never> {
  // A read-only workspace is an account-standing answer with its own
  // remedy. It must not surface as a generic failure — and it must not
  // be confused with a permission or plan problem.
  if (err instanceof AccessRestrictedError) return fail(err.message);
  // A locked feature is a commercial answer, not a fault. It must
  // never surface as "something went wrong" — the customer can act
  // on "upgrade to Advanced" and cannot act on a generic error.
  if (err instanceof FeatureLockedError) return fail(err.message);
  if (err instanceof TenantAccessError) return fail(err.message);
  if (err instanceof z.ZodError) {
    return fail("Validation failed.", err.flatten().fieldErrors as Record<string, string[]>);
  }
  console.error("[custom-objects action]", err);
  return fail("Something went wrong. Please try again.");
}

/* ------------------------------------------------------------------ */
/* DEFINE A CUSTOM OBJECT                                              */
/* ------------------------------------------------------------------ */

/**
 * Creates an object definition and its fields together. Schema changes are an
 * administrative act, so this is gated to admin roles — not any member.
 */
export async function defineCustomObject(
  input: DefineCustomObjectInput,
): Promise<ActionResult<CustomObjectWithFields>> {
  try {
    const ctx = await requireRole(ADMIN_ROLES);
    // ACCOUNT STANDING FIRST, then plan, then person. Broadest
    // reason outermost, so the customer is told the thing they can
    // actually act on rather than an inner detail.
    await requireAccess("customObjects:define", ctx);
    // ⚠️ ENTITLEMENT BEFORE PERMISSION. If a workspace owner on a plan
    // without this feature hits it, the true answer is "your plan does
    // not include it" — not "you lack permission", which would send the
    // owner to ask an administrator who is themselves.
    await requireFeature("crm.custom_objects", ctx);
    const data = defineCustomObjectSchema.parse(input);

    const slug = data.slug ?? slugify(data.name);
    const pluralName = data.pluralName ?? `${data.name}s`;

    const clash = await withTenant(ctx.tenant.id, (tx) =>
      tx.query.customObjectDefinitions.findFirst({
        where: and(
          eq(customObjectDefinitions.tenantId, ctx.tenant.id),
          eq(customObjectDefinitions.slug, slug),
          isNull(customObjectDefinitions.deletedAt),
        ),
        columns: { id: true },
      })
    );
    if (clash) {
      return fail("Validation failed.", { slug: [`An object with slug "${slug}" already exists.`] });
    }

    const [definition] = await withTenant(ctx.tenant.id, (tx) =>
      tx
        .insert(customObjectDefinitions)
        .values({
          tenantId: ctx.tenant.id,
          name: data.name,
          pluralName,
          slug,
          icon: data.icon,
          color: data.color,
          description: data.description ?? null,
          industryTemplate: data.industryTemplate ?? null,
          // First field doubles as the display value by default.
          displayFieldName: data.fields[0]?.fieldName ?? null,
          createdBy: ctx.user.id,
        })
        .returning()
    );

    if (!definition) return fail("Failed to create object definition.");

    const insertedFields = await withTenant(ctx.tenant.id, (tx) =>
      tx
        .insert(customFieldDefinitions)
        .values(
          data.fields.map((f, index) => ({
            tenantId: ctx.tenant.id,
            objectDefinitionId: definition.id,
            fieldName: f.fieldName,
            label: f.label,
            fieldType: f.fieldType,
            isRequired: f.isRequired,
            isUnique: f.isUnique,
            showInGrid: f.showInGrid,
            helpText: f.helpText ?? null,
            placeholder: f.placeholder ?? null,
            options: f.options,
            validation: f.validation,
            defaultValue: f.defaultValue ?? null,
            sortOrder: f.sortOrder || index,
          })),
        )
        .returning()
    );

    revalidatePath("/objects");
    return { ok: true, data: { ...definition, fields: insertedFields } };
  } catch (err) {
    return toActionError(err);
  }
}

/* ------------------------------------------------------------------ */
/* READ DEFINITIONS                                                    */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ DELIBERATELY NOT GATED. A read — see the note on `getTrialBalance`
 * in accounting.ts. Custom records a workspace already created stay
 * visible after a downgrade; only DEFINING and CREATING are gated.
 */
export async function getCustomObjects(): Promise<ActionResult<CustomObjectWithFields[]>> {
  try {
    const ctx = await requireTenantContext();

    const definitions = await withTenant(ctx.tenant.id, (tx) =>
      tx.query.customObjectDefinitions.findMany({
        where: and(
          eq(customObjectDefinitions.tenantId, ctx.tenant.id),
          eq(customObjectDefinitions.isActive, true),
          isNull(customObjectDefinitions.deletedAt),
        ),
        orderBy: [asc(customObjectDefinitions.sortOrder), asc(customObjectDefinitions.name)],
        with: {
          fields: {
            where: isNull(customFieldDefinitions.deletedAt),
            orderBy: [asc(customFieldDefinitions.sortOrder)],
          },
        },
      })
    );

    return { ok: true, data: definitions as CustomObjectWithFields[] };
  } catch (err) {
    return toActionError(err);
  }
}

export async function getCustomObjectBySlug(
  slug: string,
): Promise<ActionResult<CustomObjectWithFields>> {
  try {
    const ctx = await requireTenantContext();
    const parsed = slugSchema.parse(slug);

    const definition = await withTenant(ctx.tenant.id, (tx) =>
      tx.query.customObjectDefinitions.findFirst({
        where: and(
          eq(customObjectDefinitions.tenantId, ctx.tenant.id),
          eq(customObjectDefinitions.slug, parsed),
          isNull(customObjectDefinitions.deletedAt),
        ),
        with: {
          fields: {
            where: isNull(customFieldDefinitions.deletedAt),
            orderBy: [asc(customFieldDefinitions.sortOrder)],
          },
        },
      })
    );

    if (!definition) return fail("Object not found.");
    return { ok: true, data: definition as CustomObjectWithFields };
  } catch (err) {
    return toActionError(err);
  }
}

/* ------------------------------------------------------------------ */
/* CREATE A RECORD                                                     */
/* ------------------------------------------------------------------ */

export async function createCustomRecord(
  input: CreateCustomRecordInput,
): Promise<ActionResult<CustomObjectRecord>> {
  try {
    const ctx = await requireTenantContext();
    // ACCOUNT STANDING FIRST, then plan, then person. Broadest
    // reason outermost, so the customer is told the thing they can
    // actually act on rather than an inner detail.
    await requireAccess("customObjects:create", ctx);
    /**
     * 🔴 ADDED IN v1.26.0-alpha BY `check:guards`. Creating a record in a custom object was reachable by any member. Note the key spelling differs from the one passed to `requireAccess` above — that argument is a billing exemption label, not a permission, which is exactly why the two were never reconciled.
     */
    await requirePermission("custom_objects:create_record");
    // ⚠️ ENTITLEMENT BEFORE PERMISSION. If a workspace owner on a plan
    // without this feature hits it, the true answer is "your plan does
    // not include it" — not "you lack permission", which would send the
    // owner to ask an administrator who is themselves.
    await requireFeature("crm.custom_objects", ctx);
    const parsed = createCustomRecordSchema.parse(input);

    // The definition must belong to this tenant — otherwise a caller could
    // write records against another tenant's object definition.
    const definition = await withTenant(ctx.tenant.id, (tx) =>
      tx.query.customObjectDefinitions.findFirst({
        where: and(
          eq(customObjectDefinitions.id, parsed.definitionId),
          eq(customObjectDefinitions.tenantId, ctx.tenant.id),
          isNull(customObjectDefinitions.deletedAt),
        ),
        with: {
          fields: { where: isNull(customFieldDefinitions.deletedAt) },
        },
      })
    );

    if (!definition) return fail("Object definition not found.");

    const fields = (definition as CustomObjectWithFields).fields;
    const validation = validateRecordData(parsed.data, fields);
    if (!validation.ok) return fail("Validation failed.", validation.fieldErrors);

    const displayField = definition.displayFieldName;
    const displayValue =
      displayField && validation.cleaned[displayField] != null
        ? String(validation.cleaned[displayField]).slice(0, 500)
        : null;

    const [created] = await withTenant(ctx.tenant.id, (tx) =>
      tx
        .insert(customObjectRecords)
        .values({
          tenantId: ctx.tenant.id,
          definitionId: definition.id,
          data: validation.cleaned,
          displayValue,
          relatedCompanyId: parsed.relatedCompanyId ?? null,
          relatedContactId: parsed.relatedContactId ?? null,
          relatedDealId: parsed.relatedDealId ?? null,
          ownerId: ctx.user.id,
          createdBy: ctx.user.id,
        })
        .returning()
    );

    if (!created) return fail("Failed to create record.");

    revalidatePath(`/objects/${definition.slug}`);
    return { ok: true, data: created };
  } catch (err) {
    return toActionError(err);
  }
}

/* ------------------------------------------------------------------ */
/* LIST RECORDS                                                        */
/* ------------------------------------------------------------------ */


export async function getCustomRecords(
  input: ListCustomRecordsInput,
): Promise<ActionResult<{ rows: CustomObjectRecord[]; total: number }>> {
  try {
    const ctx = await requireTenantContext();
    const params = listCustomRecordsSchema.parse(input);

    const conditions = [
      eq(customObjectRecords.tenantId, ctx.tenant.id),
      eq(customObjectRecords.definitionId, params.definitionId),
      isNull(customObjectRecords.deletedAt),
    ];

    if (params.search) {
      conditions.push(sql`${customObjectRecords.displayValue} ILIKE ${`%${params.search}%`}`);
    }

    const where = and(...conditions);

    const [rows, totalResult] = await withTenant(ctx.tenant.id, (tx) =>
      Promise.all([
        tx
          .select()
          .from(customObjectRecords)
          .where(where)
          .orderBy(desc(customObjectRecords.createdAt))
          .limit(params.pageSize)
          .offset((params.page - 1) * params.pageSize),
        tx.select({ value: count() }).from(customObjectRecords).where(where),
      ]),
    );

    return { ok: true, data: { rows, total: totalResult[0]?.value ?? 0 } };
  } catch (err) {
    return toActionError(err);
  }
}


/* ------------------------------------------------------------------ */
/* ⭐ THE DEFINITION VIEW — /settings/objects                          */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THIS IS THE SETTINGS VIEW. `/objects` IS THE RECORDS VIEW.
 * ══════════════════════════════════════════════════════════════════════
 * `/objects` lists the RUNTIME record types (`dynamic_objects`) and the
 * rows inside them — it is where somebody goes to look at data.
 *
 * This is the other question entirely: what SHAPES has this workspace
 * defined, on which of the two engines, and which of those definitions
 * are quietly not doing what the person who wrote them believes.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE ONE THING THIS SCREEN EXISTS TO SAY
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ ON THE JSONB ENGINE, `is_unique` IS STORED AND NEVER ENFORCED.
 *
 * `custom_field_definitions.is_unique` is written by the field designer,
 * kept in the row, echoed back by every read — and there is no unique
 * index behind it, because the values live in a shared `data` JSONB
 * column where no per-field constraint can exist. `validateRecordData()`
 * does not check it either. Grep the repository: the only places the flag
 * appears are the schema, the zod object, this file and the form.
 *
 * So a workspace that ticked "unique" on an employee code has been
 * accepting duplicates ever since, silently, with a screen that says
 * otherwise. Nothing errors. Nothing warns. It is found when two rows
 * turn up in a report and somebody has to decide which one is real.
 *
 * ⭐ THE RUNTIME ENGINE DOES ENFORCE IT — a real UNIQUE index on a real
 * column — which is why the migration path this screen points at is a
 * fix and not a preference.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ DELIBERATELY NOT FEATURE-GATED. Reads are never gated in this file
 * (see `getCustomObjects`): definitions a workspace already created stay
 * visible after a downgrade, because hiding somebody's own schema over a
 * commercial dispute helps nobody and answers no question they have.
 */
export type CustomObjectSettingsRow = {
  id: string;
  name: string;
  pluralName: string;
  slug: string;
  description: string | null;
  isSystem: boolean;
  isActive: boolean;
  industryTemplate: string | null;
  displayFieldName: string | null;
  /** ⭐ True when the display field names a field that no longer exists. */
  displayFieldMissing: boolean;
  fieldCount: number;
  /** Fields flagged unique on an engine that cannot enforce it. */
  unenforcedUniqueFields: string[];
  requiredFields: number;
  recordCount: number;
  createdAt: string;
};

export type RuntimeObjectRow = {
  id: string;
  apiName: string;
  label: string;
  pluralLabel: string;
  fieldCount: number;
  /** Fields with a real UNIQUE index behind them. */
  uniqueFields: number;
  isActive: boolean;
  archivedAt: string | null;
};

export type CustomObjectSettingsView = {
  legacy: CustomObjectSettingsRow[];
  runtime: RuntimeObjectRow[];
  /** Total fields across the JSONB engine claiming a uniqueness nobody keeps. */
  unenforcedUniqueCount: number;
  legacyRecordCount: number;
};

export async function getCustomObjectSettings(): Promise<
  ActionResult<CustomObjectSettingsView>
> {
  try {
    const ctx = await requirePermission("custom_objects:read");

    return await withTenant(ctx.tenant.id, async (tx) => {
      /* ⚠️ INACTIVE DEFINITIONS ARE INCLUDED, SOFT-DELETED ONES ARE NOT.
         An inactive object is hidden from navigation and still owns every
         record ever created under it — which is precisely the state
         somebody needs to be told about. A deleted one is gone. */
      const definitions = await tx
        .select()
        .from(customObjectDefinitions)
        .where(
          and(
            eq(customObjectDefinitions.tenantId, ctx.tenant.id),
            isNull(customObjectDefinitions.deletedAt),
          ),
        )
        .orderBy(asc(customObjectDefinitions.sortOrder), asc(customObjectDefinitions.name))
        .limit(200);

      const fields = await tx
        .select()
        .from(customFieldDefinitions)
        .where(
          and(
            eq(customFieldDefinitions.tenantId, ctx.tenant.id),
            isNull(customFieldDefinitions.deletedAt),
          ),
        )
        .orderBy(asc(customFieldDefinitions.sortOrder))
        .limit(2000);

      /* Live records per definition. Counted rather than cached: an
         object showing "0 records" that actually holds four thousand is
         the difference between archiving it and losing them. */
      const counts = await tx
        .select({
          definitionId: customObjectRecords.definitionId,
          total: sql<number>`count(*)::int`,
        })
        .from(customObjectRecords)
        .where(
          and(
            eq(customObjectRecords.tenantId, ctx.tenant.id),
            isNull(customObjectRecords.deletedAt),
          ),
        )
        .groupBy(customObjectRecords.definitionId);

      const countByDefinition = new Map(
        counts.map((c) => [c.definitionId, Number(c.total ?? 0)]),
      );

      const runtimeObjects = await tx
        .select()
        .from(dynamicObjects)
        .where(eq(dynamicObjects.tenantId, ctx.tenant.id))
        .orderBy(asc(dynamicObjects.sortOrder), asc(dynamicObjects.label))
        .limit(200);

      const runtimeFields = await tx
        .select()
        .from(dynamicFields)
        .where(
          and(eq(dynamicFields.tenantId, ctx.tenant.id), isNull(dynamicFields.deletedAt)),
        )
        .limit(4000);

      const legacy: CustomObjectSettingsRow[] = definitions.map((d) => {
        const own = fields.filter((f) => f.objectDefinitionId === d.id);
        const unique = own.filter((f) => f.isUnique).map((f) => f.label);
        return {
          id: d.id,
          name: d.name,
          pluralName: d.pluralName,
          slug: d.slug,
          description: d.description,
          isSystem: d.isSystem,
          isActive: d.isActive,
          industryTemplate: d.industryTemplate,
          displayFieldName: d.displayFieldName,
          displayFieldMissing:
            !d.displayFieldName ||
            !own.some((f) => f.fieldName === d.displayFieldName),
          fieldCount: own.length,
          unenforcedUniqueFields: unique,
          requiredFields: own.filter((f) => f.isRequired).length,
          recordCount: countByDefinition.get(d.id) ?? 0,
          createdAt: d.createdAt.toISOString(),
        };
      });

      const runtime: RuntimeObjectRow[] = runtimeObjects.map((o) => {
        const own = runtimeFields.filter((f) => f.objectId === o.id);
        return {
          id: o.id,
          apiName: o.apiName,
          label: o.label,
          pluralLabel: o.pluralLabel,
          fieldCount: own.length,
          uniqueFields: own.filter((f) => f.isUnique).length,
          isActive: o.isActive,
          archivedAt: o.archivedAt ? o.archivedAt.toISOString() : null,
        };
      });

      return {
        ok: true as const,
        data: {
          legacy,
          runtime,
          unenforcedUniqueCount: legacy.reduce(
            (t, o) => t + o.unenforcedUniqueFields.length,
            0,
          ),
          legacyRecordCount: legacy.reduce((t, o) => t + o.recordCount, 0),
        },
      };
    });
  } catch (err) {
    return toActionError(err);
  }
}
