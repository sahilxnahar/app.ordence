import "server-only";

/**
 * Ordence — Tenant Feature Flags
 * Version: v0.14.0-alpha
 *
 * The catalogue and the "flags are not entitlements" argument live in
 * `lib/platform/flags-catalog.ts`. This file writes them (platform side)
 * and reads them (tenant side), and the asymmetry between those two is
 * the whole security model:
 *
 *   WRITE — platform scope only. Enforced twice: `requireCapability`
 *           refuses anyone below `engineer`, and the RLS `WITH CHECK`
 *           refuses any connection that has a tenant context set. Even a
 *           SQL-injection foothold inside tenant code cannot flip a flag,
 *           because the injected statement would run with a tenant
 *           context pinned and the policy would reject the write.
 *
 *   READ  — the owning tenant, plus platform. The app has to be able to
 *           render, so the tenant's own connection can see its own rows.
 */

import { and, eq, isNull, or, sql, gt } from "drizzle-orm";
import { withPlatformScope, withTenant } from "@/db";
import { tenants } from "@/db/schema";
import { platformTenantFlags } from "@/db/schema/platform";
import {
  isFlagKey,
  validateFlagExpiry,
  flagDefinitionFor,
  FLAG_CATALOG,
} from "@/lib/platform/flags-catalog";
import { setTenantFlagSchema, type PlatformResult } from "@/lib/platform/schemas";
import { requireCapability, recordPlatformAudit } from "./guard";

/* ------------------------------------------------------------------ */
/* WRITE                                                               */
/* ------------------------------------------------------------------ */

export async function setTenantFlag(input: unknown): Promise<PlatformResult<void>> {
  const operator = await requireCapability("flags:write");

  const parsed = setTenantFlagSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Check the form.",
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  const { tenantId, flagKey, enabled, reason, expiresAt, value } = parsed.data;

  if (!isFlagKey(flagKey)) {
    return { ok: false, error: `Unknown flag "${flagKey}".` };
  }

  const expiry = expiresAt ? new Date(expiresAt) : null;

  // ⚠️ Only checked when TURNING ON. Switching a flag off must never be
  // blocked by a validation rule — the moment you most need to disable
  // something is the moment a form refusing you is most expensive.
  if (enabled) {
    const expiryError = validateFlagExpiry(flagKey, expiry);
    if (expiryError) {
      return { ok: false, error: expiryError, fieldErrors: { expiresAt: [expiryError] } };
    }
  }

  const outcome = await withPlatformScope(
    `Platform console: set flag ${flagKey}=${enabled} on tenant ${tenantId} — ` +
      reason.slice(0, 80),
    async (db) => {
      const [tenant] = await db
        .select({ id: tenants.id, slug: tenants.slug })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);

      if (!tenant) return { error: "Workspace not found." } as const;

      const [previous] = await db
        .select()
        .from(platformTenantFlags)
        .where(
          and(
            eq(platformTenantFlags.tenantId, tenantId),
            eq(platformTenantFlags.flagKey, flagKey),
          ),
        )
        .limit(1);

      await db
        .insert(platformTenantFlags)
        .values({
          tenantId,
          flagKey,
          enabled,
          value: value ?? {},
          reason,
          expiresAt: expiry,
          setByStaffId: operator.staff.id,
          setByEmail: operator.email,
        })
        .onConflictDoUpdate({
          target: [platformTenantFlags.tenantId, platformTenantFlags.flagKey],
          set: {
            enabled,
            value: value ?? {},
            reason,
            expiresAt: expiry,
            setByStaffId: operator.staff.id,
            setByEmail: operator.email,
            updatedAt: new Date(),
          },
        });

      return { previous: previous?.enabled ?? false, slug: tenant.slug } as const;
    },
  );

  if (outcome.error) return { ok: false, error: outcome.error };

  // Into the CUSTOMER'S audit log. A capability appearing or disappearing
  // in their workspace with no explanation anywhere they can see is how a
  // support win becomes a trust problem.
  await recordPlatformAudit({
    operator,
    tenantId,
    action: "config_change",
    resourceType: "tenant_feature_flag",
    resourceId: flagKey,
    oldValue: { enabled: outcome.previous },
    newValue: { enabled, expiresAt: expiry?.toISOString() ?? null },
    severity: "notice",
    reason,
    metadata: {
      flagLabel: flagDefinitionFor(flagKey)?.label ?? flagKey,
      grantsPaidCapability:
        flagDefinitionFor(flagKey)?.grantsPaidCapability ?? false,
    },
  });

  return { ok: true, data: undefined };
}

/* ------------------------------------------------------------------ */
/* READ — TENANT SIDE                                                  */
/* ------------------------------------------------------------------ */

/**
 * Is a flag on for a tenant, right now?
 *
 * Read in the TENANT'S OWN context, not platform scope — the app calls
 * this on ordinary requests and it must not need a cross-tenant
 * connection to render a page. The RLS `USING` clause admits the owning
 * tenant precisely so this works.
 *
 * ⚠️ EXPIRY IS APPLIED IN THE QUERY, not by a job. A flag whose
 * `expires_at` has passed reads as OFF the instant the clock passes it,
 * whatever any cleanup task is or is not doing. The same rule as
 * impersonation liveness, for the same reason.
 *
 * Fails CLOSED: any error returns false. A flag that cannot be read is a
 * capability that is not switched on.
 */
export async function isTenantFlagEnabled(
  tenantId: string,
  flagKey: string,
): Promise<boolean> {
  if (!isFlagKey(flagKey)) return false;
  const now = new Date();

  try {
    const rows = await withTenant(tenantId, async (tx) =>
      tx
        .select({ enabled: platformTenantFlags.enabled })
        .from(platformTenantFlags)
        .where(
          and(
            eq(platformTenantFlags.tenantId, tenantId),
            eq(platformTenantFlags.flagKey, flagKey),
            eq(platformTenantFlags.enabled, true),
            or(
              isNull(platformTenantFlags.expiresAt),
              gt(platformTenantFlags.expiresAt, now),
            ),
          ),
        )
        .limit(1),
    );
    return rows.length > 0;
  } catch (err) {
    console.error("[platform] flag read failed; treating as off", { tenantId, flagKey, err });
    return false;
  }
}

/** Every live flag for a tenant, for the tenant's own app to read once. */
export async function getTenantFlags(tenantId: string): Promise<Set<string>> {
  const now = new Date();
  try {
    const rows = await withTenant(tenantId, async (tx) =>
      tx
        .select({ flagKey: platformTenantFlags.flagKey })
        .from(platformTenantFlags)
        .where(
          and(
            eq(platformTenantFlags.tenantId, tenantId),
            eq(platformTenantFlags.enabled, true),
            or(
              isNull(platformTenantFlags.expiresAt),
              gt(platformTenantFlags.expiresAt, now),
            ),
          ),
        ),
    );
    return new Set(rows.map((r) => r.flagKey));
  } catch {
    return new Set();
  }
}

/* ------------------------------------------------------------------ */
/* READ — CONSOLE SIDE                                                 */
/* ------------------------------------------------------------------ */

export type FlagRow = {
  key: string;
  label: string;
  description: string;
  enabled: boolean;
  reason: string | null;
  expiresAt: string | null;
  expired: boolean;
  setByEmail: string | null;
  grantsPaidCapability: boolean;
};

/**
 * The full catalogue joined against this tenant's overrides, so the
 * console shows every flag that COULD be set, not only those that are.
 * A console that lists only existing rows makes turning a new flag on
 * feel like a database operation.
 */
export async function listTenantFlags(
  tenantId: string,
): Promise<PlatformResult<FlagRow[]>> {
  await requireCapability("flags:read");
  const now = new Date();

  const rows = await withPlatformScope(
    `Platform console: read feature flags for tenant ${tenantId}`,
    async (db) =>
      db
        .select()
        .from(platformTenantFlags)
        .where(eq(platformTenantFlags.tenantId, tenantId)),
  );

  const byKey = new Map(rows.map((r) => [r.flagKey, r]));

  return {
    ok: true,
    data: Object.entries(FLAG_CATALOG).map(([key, def]) => {
      const row = byKey.get(key);
      const expired = Boolean(row?.expiresAt && row.expiresAt.getTime() <= now.getTime());
      return {
        key,
        label: def.label,
        description: def.description,
        enabled: Boolean(row?.enabled) && !expired,
        reason: row?.reason ?? null,
        expiresAt: row?.expiresAt?.toISOString() ?? null,
        expired,
        setByEmail: row?.setByEmail ?? null,
        grantsPaidCapability: def.grantsPaidCapability,
      };
    }),
  };
}

export { sql };
