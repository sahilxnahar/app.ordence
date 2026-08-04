"use server";

/**
 * Ordence — Asset Server Actions
 * Version: v0.7.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE TENANT RULE, RESTATED BECAUSE IT IS THE ONE THAT MATTERS
 * ══════════════════════════════════════════════════════════════════════
 * `tenantId` is NEVER taken from the request. It comes from
 * `requireTenantContext()`, which derives it from the verified Clerk
 * session. A client that sends its own tenant id is ignored.
 *
 * That is the first of four layers. Below it: Row-Level Security with
 * FORCE (so even the table owner is subject to it), cross-tenant reference
 * triggers (a plain foreign key proves a row EXISTS, not that it belongs to
 * you), and the edge middleware that strips spoofable headers before any of
 * this runs.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY DYNAMIC ATTRIBUTES ARE VALIDATED AGAINST DEFINITIONS, NOT TRUSTED
 * ══════════════════════════════════════════════════════════════════════
 * `dynamic_attributes` is a JSONB column, which means the database will
 * accept literally any shape. The protection is `buildDynamicSchema()`,
 * which constructs a Zod schema from THIS TENANT'S field definitions and
 * strips every key that is not described by one.
 *
 * Without that strip, a crafted request could write arbitrary keys into the
 * column, and those keys would later be rendered back to other users in the
 * same tenant — a stored-XSS vector wearing a JSONB costume.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { and, eq, isNull, desc } from "drizzle-orm";
import { db } from "@/db";
import {
  assets,
  customObjectDefinitions,
  customFieldDefinitions,
} from "@/db/schema";
import { requireTenantContext, TenantAccessError } from "@/server/tenant-context";
import {
  createAssetSchema,
  buildDynamicSchema,
  defaultFieldsForIndustry,
} from "@/lib/validators/assets";
import type { ActionResult } from "@/lib/validators/crm";
import type { CreateAssetInput } from "@/lib/validators/assets";
import type { DynamicFieldSpec } from "@/components/forms/form-fields";
import type { Asset } from "@/db/schema";

export type { CreateAssetInput };

function fail(error: string, fieldErrors?: Record<string, string[]>): ActionResult<never> {
  return { ok: false, error, fieldErrors };
}

function toActionError(err: unknown): ActionResult<never> {
  if (err instanceof TenantAccessError) return fail(err.message);
  if (err instanceof z.ZodError) {
    return fail("Validation failed.", err.flatten().fieldErrors as Record<string, string[]>);
  }
  console.error("[assets action]", err);
  return fail("Something went wrong. Please try again.");
}

/* ------------------------------------------------------------------ */
/* FIELD DEFINITIONS                                                   */
/* ------------------------------------------------------------------ */

/**
 * The field specs that drive the "New asset" form.
 *
 * Resolution order:
 *   1. A custom object definition with slug "asset" belonging to this
 *      tenant — their own fields always win.
 *   2. The built-in starting set for the tenant's industry.
 *
 * Returned to a client component, so it contains nothing sensitive: labels,
 * types and option lists only.
 */
export async function getAssetFieldSpecs(): Promise<ActionResult<DynamicFieldSpec[]>> {
  try {
    const ctx = await requireTenantContext();

    const definition = await db.query.customObjectDefinitions.findFirst({
      where: and(
        eq(customObjectDefinitions.tenantId, ctx.tenant.id),
        eq(customObjectDefinitions.slug, "asset"),
        isNull(customObjectDefinitions.deletedAt),
      ),
      with: {
        fields: { where: isNull(customFieldDefinitions.deletedAt) },
      },
    });

    const rows = (definition as { fields?: Array<Record<string, unknown>> } | undefined)?.fields;

    if (rows && rows.length > 0) {
      const specs: DynamicFieldSpec[] = rows
        .filter((f) => f.isHidden !== true)
        .map((f) => ({
          fieldName: String(f.fieldName),
          label: String(f.label),
          fieldType: f.fieldType as DynamicFieldSpec["fieldType"],
          isRequired: f.isRequired === true,
          helpText: (f.helpText as string | null) ?? null,
          placeholder: (f.placeholder as string | null) ?? null,
          options: (f.options as DynamicFieldSpec["options"]) ?? [],
          validation: (f.validation as DynamicFieldSpec["validation"]) ?? null,
        }));
      return { ok: true, data: specs };
    }

    const industry =
      typeof ctx.tenant.settings === "object" && ctx.tenant.settings !== null
        ? String((ctx.tenant.settings as Record<string, unknown>).industry ?? "generic")
        : "generic";

    return { ok: true, data: defaultFieldsForIndustry(industry) };
  } catch (err) {
    return toActionError(err);
  }
}

/* ------------------------------------------------------------------ */
/* CREATE                                                              */
/* ------------------------------------------------------------------ */

export async function createAsset(input: CreateAssetInput): Promise<ActionResult<Asset>> {
  try {
    const ctx = await requireTenantContext();

    // 1. The fixed half.
    const parsed = createAssetSchema.parse(input);

    // 2. The variable half, against this tenant's own definitions.
    const specsResult = await getAssetFieldSpecs();
    if (!specsResult.ok) return fail("Could not load the field definitions for this workspace.");

    const dynamicSchema = buildDynamicSchema(specsResult.data);
    const dynamicParsed = dynamicSchema.safeParse(parsed.dynamicAttributes ?? {});

    if (!dynamicParsed.success) {
      // Prefix the paths so the client can map errors back onto the inputs,
      // which are registered as `dynamicAttributes.<fieldName>`.
      const flat = dynamicParsed.error.flatten().fieldErrors;
      const prefixed: Record<string, string[]> = {};
      for (const [key, messages] of Object.entries(flat)) {
        if (messages) prefixed[`dynamicAttributes.${key}`] = messages;
      }
      return fail("Some custom fields need attention.", prefixed);
    }

    const [created] = await db
      .insert(assets)
      .values({
        tenantId: ctx.tenant.id,
        name: parsed.name,
        assetType: parsed.assetType,
        assetSubtype: parsed.assetSubtype ?? null,
        code: parsed.code ?? null,
        description: parsed.description ?? null,
        status: parsed.status,
        dynamicAttributes: dynamicParsed.data,
        valueAmount: parsed.valueAmount ?? null,
        currency: parsed.currency,
        areaValue: parsed.areaValue ?? null,
        areaUnit: parsed.areaUnit ?? null,
        quantity: parsed.quantity,
        addressLine1: parsed.addressLine1 ?? null,
        addressLine2: parsed.addressLine2 ?? null,
        locality: parsed.locality ?? null,
        city: parsed.city ?? null,
        state: parsed.state ?? null,
        postalCode: parsed.postalCode ?? null,
        acquiredDate: parsed.acquiredDate ?? null,
        commissionedDate: parsed.commissionedDate ?? null,
        createdBy: ctx.user.id,
      })
      .returning();

    if (!created) return fail("Failed to create the asset.");

    revalidatePath("/assets");
    return { ok: true, data: created };
  } catch (err) {
    return toActionError(err);
  }
}

/* ------------------------------------------------------------------ */
/* READ                                                                */
/* ------------------------------------------------------------------ */

export async function getAsset(id: string): Promise<ActionResult<Asset>> {
  try {
    const ctx = await requireTenantContext();
    const parsedId = z.string().uuid("Invalid identifier.").parse(id);

    const row = await db.query.assets.findFirst({
      where: and(
        eq(assets.id, parsedId),
        // The tenant filter is written explicitly even though RLS also
        // enforces it. Two independent checks; either one alone is enough.
        eq(assets.tenantId, ctx.tenant.id),
        isNull(assets.deletedAt),
      ),
    });

    if (!row) return fail("Asset not found.");
    return { ok: true, data: row };
  } catch (err) {
    return toActionError(err);
  }
}

export async function getRecentAssets(limit = 20): Promise<ActionResult<Asset[]>> {
  try {
    const ctx = await requireTenantContext();
    const capped = Math.min(Math.max(1, limit), 100);

    const rows = await db
      .select()
      .from(assets)
      .where(and(eq(assets.tenantId, ctx.tenant.id), isNull(assets.deletedAt)))
      .orderBy(desc(assets.createdAt))
      .limit(capped);

    return { ok: true, data: rows };
  } catch (err) {
    return toActionError(err);
  }
}
