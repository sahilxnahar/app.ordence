"use server";

/**
 * Ordence — Workspace Settings
 * Version: v0.7.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY CHANGING THE INDUSTRY IS A BIGGER DEAL THAN IT LOOKS
 * ══════════════════════════════════════════════════════════════════════
 * `settings.industry` is one string in one JSONB column, and it drives the
 * navigation, the dashboard widgets, the asset types on offer and the
 * vocabulary used throughout the product. Switching it does not migrate or
 * delete anything — every record stays exactly where it is — but a
 * developer's "Units" become a firm's "Matters" on the next page load.
 *
 * That is the polymorphic engine working as designed. It is still
 * surprising if you did not expect it, so the UI says so plainly before
 * you save.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THE SETTINGS OBJECT IS MERGED, NOT REPLACED
 * ══════════════════════════════════════════════════════════════════════
 * The General form knows about timezone, locale and industry. The
 * Financial form knows about currency and fiscal year. If either wrote the
 * whole `settings` object, saving one would silently erase the other's
 * keys — including keys added by a future phase that neither form has
 * heard of. So both merge into the existing value.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db, withTenant } from "@/db";
import { tenants } from "@/db/schema";
import { requirePermission, writeAudit, auditMeta } from "@/server/audit";
import { TenantAccessError } from "@/server/tenant-context";
import { PermissionDeniedError } from "@/lib/permissions";
import { INDUSTRY_KEYS } from "@/lib/industry-templates";
import type { ActionResult } from "@/lib/validators/crm";

function fail(error: string, fieldErrors?: Record<string, string[]>): ActionResult<never> {
  return { ok: false, error, fieldErrors };
}

function toActionError(err: unknown): ActionResult<never> {
  if (err instanceof TenantAccessError) return fail(err.message);
  if (err instanceof PermissionDeniedError) return fail(err.message);
  if (err instanceof z.ZodError) {
    return fail("Validation failed.", err.flatten().fieldErrors as Record<string, string[]>);
  }
  console.error("[settings action]", err);
  return fail("Something went wrong. Please try again.");
}

const generalSchema = z.object({
  name: z.string().trim().min(1, "Your workspace needs a name.").max(255),
  industry: z.string().refine(
    (v) => (INDUSTRY_KEYS as string[]).includes(v),
    "Choose one of the listed industries.",
  ),
  timezone: z.string().trim().min(1).max(64).default("Asia/Kolkata"),
  locale: z.string().trim().min(2).max(10).default("en-IN"),
  dateFormat: z.enum(["dd/MM/yyyy", "MM/dd/yyyy", "yyyy-MM-dd"]).default("dd/MM/yyyy"),
});

const financialSchema = z.object({
  currency: z.string().trim().length(3, "Use a 3-letter code such as INR.").toUpperCase(),
  country: z.string().trim().length(2, "Use a 2-letter code such as IN.").toUpperCase(),
  /** Month the fiscal year starts. India runs April–March, so 4, not 1. */
  fiscalYearStartMonth: z.coerce.number().int().min(1).max(12).default(4),
  requireMfa: z.coerce.boolean().default(false),
  sessionIdleMinutes: z.coerce.number().int().min(5).max(1440).default(60),
});

export type GeneralSettingsInput = z.input<typeof generalSchema>;
export type FinancialSettingsInput = z.input<typeof financialSchema>;

export type WorkspaceSettings = {
  id: string;
  name: string;
  slug: string;
  planTier: string;
  status: string;
  seatLimit: number;
  settings: Record<string, unknown>;
};

export async function getWorkspaceSettings(): Promise<ActionResult<WorkspaceSettings>> {
  try {
    const ctx = await requirePermission("settings:read");

    const row = await withTenant(ctx.tenant.id, (tx) =>
      tx.query.tenants.findFirst({
        where: eq(tenants.id, ctx.tenant.id),
        columns: {
          id: true,
          name: true,
          slug: true,
          planTier: true,
          status: true,
          seatLimit: true,
          settings: true,
        },
      })
    );

    if (!row) return fail("Workspace not found.");

    return {
      ok: true,
      data: { ...row, settings: (row.settings ?? {}) as Record<string, unknown> },
    };
  } catch (err) {
    return toActionError(err);
  }
}

/** Merge a partial settings patch into the stored object. */
async function mergeSettings(
  tenantId: string,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const existing = await withTenant(tenantId, (tx) =>
    tx.query.tenants.findFirst({
      where: eq(tenants.id, tenantId),
      columns: { settings: true },
    })
  );
  return { ...((existing?.settings ?? {}) as Record<string, unknown>), ...patch };
}

export async function updateGeneralSettings(
  input: GeneralSettingsInput,
): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await requirePermission("settings:update", { type: "tenant" });
    const data = generalSchema.parse(input);

    const previous = (ctx.tenant.settings ?? {}) as Record<string, unknown>;

    const merged = await mergeSettings(ctx.tenant.id, {
      industry: data.industry,
      timezone: data.timezone,
      locale: data.locale,
      dateFormat: data.dateFormat,
    });

    const [updated] = await withTenant(ctx.tenant.id, (tx) =>
      tx
        .update(tenants)
        .set({
          name: data.name,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          settings: merged as any,
          updatedAt: new Date(),
        })
        .where(eq(tenants.id, ctx.tenant.id))
        .returning({ id: tenants.id })
    );

    if (!updated) return fail("Could not save your settings.");

    // Changing the industry reshapes the whole interface, so it is worth
    // more than a routine "settings updated" line in the log.
    const industryChanged = previous.industry !== data.industry;

    await writeAudit(ctx, {
      action: "update",
      resourceType: "tenant",
      resourceId: ctx.tenant.id,
      severity: industryChanged ? "warning" : "info",
      metadata: auditMeta({
        event: "general_settings_updated",
        industryChanged,
        previousIndustry: (previous.industry as string) ?? null,
        newIndustry: data.industry,
      }),
    });

    revalidatePath("/settings");
    revalidatePath("/dashboard");
    return { ok: true, data: updated };
  } catch (err) {
    return toActionError(err);
  }
}

export async function updateFinancialSettings(
  input: FinancialSettingsInput,
): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await requirePermission("settings:update", { type: "tenant" });
    const data = financialSchema.parse(input);

    const merged = await mergeSettings(ctx.tenant.id, {
      currency: data.currency,
      country: data.country,
      fiscalYearStartMonth: data.fiscalYearStartMonth,
      requireMfa: data.requireMfa,
      sessionIdleMinutes: data.sessionIdleMinutes,
    });

    const [updated] = await withTenant(ctx.tenant.id, (tx) =>
      tx
        .update(tenants)
        .set({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          settings: merged as any,
          updatedAt: new Date(),
        })
        .where(eq(tenants.id, ctx.tenant.id))
        .returning({ id: tenants.id })
    );

    if (!updated) return fail("Could not save your settings.");

    await writeAudit(ctx, {
      action: "update",
      resourceType: "tenant",
      resourceId: ctx.tenant.id,
      // Requiring MFA is a security control, so its change is logged louder.
      severity: data.requireMfa ? "notice" : "info",
      metadata: auditMeta({
        event: "financial_settings_updated",
        currency: data.currency,
        fiscalYearStartMonth: data.fiscalYearStartMonth,
        requireMfa: data.requireMfa,
      }),
    });

    revalidatePath("/settings/financial");
    return { ok: true, data: updated };
  } catch (err) {
    return toActionError(err);
  }
}
