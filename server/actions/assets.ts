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
import { db, withTenant } from "@/db";
import {
  assets,
  customObjectDefinitions,
  customFieldDefinitions,
} from "@/db/schema";
import { TenantAccessError } from "@/server/tenant-context";
import { requirePermission } from "@/server/audit";
import { requireFeature, FeatureLockedError } from "@/server/entitlements";
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
  /**
   * 🔴 WITHOUT THIS LINE THE GATE ABOVE IS AN OUTAGE — Batch 0109.
   *
   * The message already names the plan and the remedy. Falling through
   * to "Something went wrong. Please try again." tells somebody whose
   * workspace had this module switched off that the product is broken,
   * and their next move is to press the button again.
   */
  if (err instanceof FeatureLockedError) return fail(err.message);
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
/**
 * ⭐⭐ WAVE 9 — `assets:read` WAS DECLARED, GRANTED TO EVERY ROLE
 * TEMPLATE, CITED IN TWO OTHER MODULES' REASONING, AND CHECKED NOWHERE.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS IS NOT COSMETIC EVEN THOUGH EVERY BUILT-IN ROLE HOLDS IT
 * ══════════════════════════════════════════════════════════════════════
 * All nine role templates grant `assets:read`, so switching these reads
 * from `requireTenantContext()` to `requirePermission("assets:read")`
 * locks out nobody who exists today. It matters anyway, for two reasons:
 *
 *   1. ROLES ARE CUSTOMISABLE. A workspace that builds a restricted role
 *      without `assets:read` currently gets a role that reads assets
 *      perfectly well, because the key it withheld was never consulted.
 *      A permission a customer can remove and that has no effect is
 *      worse than one that does not exist — it is a control they believe
 *      they applied.
 *
 *   2. TWO MODULES ALREADY REASON AS IF IT WERE ENFORCED.
 *      `lib/views/access.ts` and `server/views/guards.ts` both describe
 *      "an external contractor with `assets:read` and nothing else" when
 *      explaining what a saved view may expose. That sentence was only
 *      true of the views layer; on the assets surface itself the "and
 *      nothing else" part did no work.
 *
 * ⚠️ THE FILE HEADER'S CLAIM STANDS: this was never tenant-unsafe. The
 * tenant has always come from the session. This is the per-role half,
 * finished — Phase 50 gated the writes and left the reads.
 */
export async function getAssetFieldSpecs(): Promise<ActionResult<DynamicFieldSpec[]>> {
  try {
    const ctx = await requirePermission("assets:read");

    const definition = await withTenant(ctx.tenant.id, (tx) =>
      tx.query.customObjectDefinitions.findFirst({
        where: and(
          eq(customObjectDefinitions.tenantId, ctx.tenant.id),
          eq(customObjectDefinitions.slug, "asset"),
          isNull(customObjectDefinitions.deletedAt),
        ),
        with: {
          fields: { where: isNull(customFieldDefinitions.deletedAt) },
        },
      })
    );

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

/**
 * ⭐ PHASE 50 — THE PERMISSION GATE THAT WAS MISSING.
 *
 * ⚠️ THIS FILE WAS NEVER TENANT-UNSAFE. It has always derived the tenant
 * from `requireTenantContext()` and never from input, so no workspace
 * could ever reach another's assets. What it lacked was a PER-ROLE gate:
 * any member of a workspace could create and edit assets regardless of
 * their role.
 *
 * ⚠️ AND THE REASON IT WAS LEFT UNGATED IN PHASE 47 WAS WRONG. I recorded
 * then that no `assets:*` permission key existed, so gating would need a
 * new key, role seeding and a data migration. That was not true — the
 * keys have existed since Phase 8 (`assets:read`, `assets:create`,
 * `assets:update`, `assets:delete`, `assets:bulk_update`) and every role
 * template already carries the ones it should. The gate costs one line
 * and locks nobody out.
 */
export async function createAsset(input: CreateAssetInput): Promise<ActionResult<Asset>> {
  try {
    await requireFeature("assets.catalog");
    const ctx = await requirePermission("assets:create");

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

    const [created] = await withTenant(ctx.tenant.id, (tx) =>
      tx
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
        .returning()
    );

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
    /** ⭐ Wave 9 — see the note above `getAssetFieldSpecs`. */
    const ctx = await requirePermission("assets:read", { type: "asset", id });
    const parsedId = z.string().uuid("Invalid identifier.").parse(id);

    const row = await withTenant(ctx.tenant.id, (tx) =>
      tx.query.assets.findFirst({
        where: and(
          eq(assets.id, parsedId),
          // The tenant filter is written explicitly even though RLS also
          // enforces it. Two independent checks; either one alone is enough.
          eq(assets.tenantId, ctx.tenant.id),
          isNull(assets.deletedAt),
        ),
      })
    );

    if (!row) return fail("Asset not found.");
    return { ok: true, data: row };
  } catch (err) {
    return toActionError(err);
  }
}

export async function getRecentAssets(limit = 20): Promise<ActionResult<Asset[]>> {
  try {
    /** ⭐ Wave 9 — see the note above `getAssetFieldSpecs`. */
    const ctx = await requirePermission("assets:read");
    const capped = Math.min(Math.max(1, limit), 100);

    const rows = await withTenant(ctx.tenant.id, (tx) =>
      tx
        .select()
        .from(assets)
        .where(and(eq(assets.tenantId, ctx.tenant.id), isNull(assets.deletedAt)))
        .orderBy(desc(assets.createdAt))
        .limit(capped)
    );

    return { ok: true, data: rows };
  } catch (err) {
    return toActionError(err);
  }
}
