"use server";

/**
 * Ordence — Onboarding Server Actions
 * Version: v0.81.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION.
 *
 * Saves the multi-step onboarding wizard data. Each step merges into
 * the tenant's existing `settings` JSONB column — never replaces it.
 */

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { tenants } from "@/db/schema";
import { requireTenantContext } from "@/server/tenant-context";
import { writeAudit } from "@/server/audit";

/* ------------------------------------------------------------------ */
/* SAVE ORGANIZATION DETAILS (Step 1)                                  */
/* ------------------------------------------------------------------ */

export async function saveOrganizationDetails(input: {
  legalName: string;
  gstin?: string;
  pan?: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  state: string;
  postalCode: string;
  country?: string;
  billingEmail?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const ctx = await requireTenantContext();

    // Read current settings, merge the billingProfile into them.
    const current = await db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, ctx.tenant.id))
      .limit(1);

    const existingSettings = (current[0]?.settings ?? {}) as Record<string, unknown>;
    const existingBilling = (existingSettings.billingProfile ?? {}) as Record<string, unknown>;

    const mergedSettings = {
      ...existingSettings,
      billingProfile: {
        ...existingBilling,
        gstin: input.gstin ?? null,
        placeOfSupplyCode: input.gstin?.slice(0, 2) ?? null,
        addressLine1: input.addressLine1,
        addressLine2: input.addressLine2 ?? null,
        city: input.city,
        state: input.state,
        postalCode: input.postalCode,
        country: input.country ?? "India",
        billingEmail: input.billingEmail ?? null,
      },
      onboardingStep: 2,
    } as typeof tenants.settings._.data;

    await db
      .update(tenants)
      .set({
        legalName: input.legalName,
        settings: mergedSettings,
        updatedAt: new Date(),
      })
      .where(eq(tenants.id, ctx.tenant.id));

    await writeAudit(ctx, {
      action: "update",
      resourceType: "tenant",
      resourceId: ctx.tenant.id,
      newValue: { step: "organization_details", legalName: input.legalName },
      reason: "Onboarding wizard — organization details saved",
    });

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to save organization details.",
    };
  }
}

/* ------------------------------------------------------------------ */
/* SAVE FISCAL PREFERENCES (Step 2)                                    */
/* ------------------------------------------------------------------ */

export async function saveFiscalPreferences(input: {
  fiscalYearStartMonth: number;
  currency: string;
  timezone: string;
  dateFormat?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const ctx = await requireTenantContext();

    const current = await db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, ctx.tenant.id))
      .limit(1);

    const existingSettings = (current[0]?.settings ?? {}) as Record<string, unknown>;

    const mergedSettings = {
      ...existingSettings,
      fiscalYearStartMonth: input.fiscalYearStartMonth,
      currency: input.currency,
      timezone: input.timezone,
      dateFormat: input.dateFormat ?? "DD-MM-YYYY",
      onboardingStep: 3,
    } as typeof tenants.settings._.data;

    await db
      .update(tenants)
      .set({
        settings: mergedSettings,
        updatedAt: new Date(),
      })
      .where(eq(tenants.id, ctx.tenant.id));

    await writeAudit(ctx, {
      action: "update",
      resourceType: "tenant",
      resourceId: ctx.tenant.id,
      newValue: { step: "fiscal_preferences", fiscalYearStartMonth: input.fiscalYearStartMonth },
      reason: "Onboarding wizard — fiscal preferences saved",
    });

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to save fiscal preferences.",
    };
  }
}

/* ------------------------------------------------------------------ */
/* SAVE INDUSTRY SELECTION (Step 3)                                    */
/* ------------------------------------------------------------------ */

export async function saveIndustrySelection(input: {
  industry: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const ctx = await requireTenantContext();

    const current = await db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, ctx.tenant.id))
      .limit(1);

    const existingSettings = (current[0]?.settings ?? {}) as Record<string, unknown>;

    const mergedSettings = {
      ...existingSettings,
      industry: input.industry,
      onboardingStep: 4,
    } as typeof tenants.settings._.data;

    await db
      .update(tenants)
      .set({
        settings: mergedSettings,
        updatedAt: new Date(),
      })
      .where(eq(tenants.id, ctx.tenant.id));

    await writeAudit(ctx, {
      action: "update",
      resourceType: "tenant",
      resourceId: ctx.tenant.id,
      newValue: { step: "industry_selection", industry: input.industry },
      reason: "Onboarding wizard — industry selected",
    });

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to save industry selection.",
    };
  }
}

/* ------------------------------------------------------------------ */
/* COMPLETE ONBOARDING (Step 4)                                        */
/* ------------------------------------------------------------------ */

export async function completeOnboarding(): Promise<
  { ok: true } | { ok: false; error: string }
> {
  try {
    const ctx = await requireTenantContext();

    const current = await db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, ctx.tenant.id))
      .limit(1);

    const existingSettings = (current[0]?.settings ?? {}) as Record<string, unknown>;

    const mergedSettings = {
      ...existingSettings,
      onboardedAt: new Date().toISOString(),
      onboardingStep: null,
    } as unknown as typeof tenants.settings._.data;

    await db
      .update(tenants)
      .set({
        settings: mergedSettings,
        updatedAt: new Date(),
      })
      .where(eq(tenants.id, ctx.tenant.id));

    await writeAudit(ctx, {
      action: "update",
      resourceType: "tenant",
      resourceId: ctx.tenant.id,
      newValue: { onboardedAt: new Date().toISOString() },
      reason: "Onboarding wizard — completed",
    });

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to complete onboarding.",
    };
  }
}

/* ------------------------------------------------------------------ */
/* GET ONBOARDING STATE                                                */
/* ------------------------------------------------------------------ */

export async function getOnboardingState(): Promise<
  { ok: true; step: number | null; onboardedAt: string | null } | { ok: false; error: string }
> {
  try {
    const ctx = await requireTenantContext();

    const settings = (ctx.tenant.settings ?? {}) as {
      onboardingStep?: number | null;
      onboardedAt?: string | null;
    };

    return {
      ok: true,
      step: settings.onboardingStep ?? null,
      onboardedAt: settings.onboardedAt ?? null,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to get onboarding state.",
    };
  }
}
