import "server-only";

/**
 * Ordence — Maintenance Mode: THE ENFORCEMENT POINT
 * Version: v1.58.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 A SCREEN THAT HIDES THE SAVE BUTTON IS A MISTAKE GUARD, NOT A
 *    BOUNDARY. THE BOUNDARY IS HERE.
 * ══════════════════════════════════════════════════════════════════════
 * `assertMaintenanceAllows()` is called from inside
 * `assertImpersonationAllows()` — the function Batch 28 already declared
 * "THE CALL EVERY TENANT-SIDE MUTATION NEEDS" and which every delete,
 * period close, invite, export and billing action already makes.
 *
 * ⭐ REUSED, NOT DUPLICATED, AND THE REASON IS SPECIFIC. Two independent
 * gates on the same write can disagree, and the way they disagree is
 * always the same: one of them classifies `orders:submit` as a read. So
 * this module shares Batch 28's `isWriteOperation` (fails closed) and
 * hangs off Batch 28's single call site, which means a call site cannot
 * be guarded against impersonation and unguarded against maintenance.
 *
 * ⚠️ WHAT THIS DOES NOT COVER, SAID OUT LOUD: a mutation that calls
 * neither gate is refused by neither. That set is the same set Batch 28
 * already lives with, and narrowing it is one job, not two — which is
 * exactly the argument for not adding a second mechanism.
 *
 * ⚠️ PLATFORM WRITES ARE UNAFFECTED. The console reaches the database
 * through `withPlatformScope`, never through this gate, so the operator
 * who switched maintenance on can always switch it off. A read-only mode
 * you cannot turn off from inside is an outage.
 */

import { cache } from "react";
import { and, desc, eq, or, gt, isNull } from "drizzle-orm";
import { withPlatformScope } from "@/db";
import { platformTenantFlags, platformActionLog } from "@/db/schema/platform";
import {
  MAINTENANCE_FLAG_KEY,
  MAINTENANCE_LOG_RESOURCE,
  MAINTENANCE_LOG_RESOURCE_ID,
  evaluateMaintenance,
  isMaintenanceActive,
  type MaintenanceState,
} from "@/lib/platform/maintenance-policy";

/**
 * Thrown at the point of refusal.
 *
 * ⚠️ ITS OWN CLASS, so a caller can tell "we are paused" from "you are
 * not allowed" from "the database is down". A UI that renders all three
 * as "Something went wrong" is why people distrust planned windows.
 */
export class MaintenanceReadOnlyError extends Error {
  constructor(
    readonly operation: string,
    readonly scope: "global" | "tenant",
    message: string,
  ) {
    super(message);
    this.name = "MaintenanceReadOnlyError";
  }
}

/* ------------------------------------------------------------------ */
/* READS                                                               */
/* ------------------------------------------------------------------ */

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * The latest global decision. `null` when nobody has ever made one.
 *
 * ⚠️ `cache()` DEDUPES PER REQUEST, NOT ACROSS REQUESTS. That is the
 * whole point: a request may check this once for the layout banner and
 * five more times for five writes, and it must not open five extra
 * platform-scoped transactions to answer a question it already answered
 * — but a value cached beyond the request would mean an operator turning
 * maintenance OFF is ignored until some TTL expires.
 */
export const readGlobalMaintenance = cache(async (): Promise<MaintenanceState | null> => {
  const row = await withPlatformScope(
    "Read the current global maintenance-mode decision to gate tenant writes",
    async (db) => {
      const [latest] = await db
        .select()
        .from(platformActionLog)
        .where(
          and(
            eq(platformActionLog.resourceType, MAINTENANCE_LOG_RESOURCE),
            eq(platformActionLog.resourceId, MAINTENANCE_LOG_RESOURCE_ID),
          ),
        )
        .orderBy(desc(platformActionLog.createdAt))
        .limit(1);
      return latest ?? null;
    },
  );

  if (!row) return null;
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  return {
    scope: "global",
    enabled: meta.enabled === true,
    endsAt: typeof meta.endsAt === "string" ? meta.endsAt : null,
    message: textOf(meta.message),
    reason: row.justification,
    since: row.createdAt instanceof Date ? row.createdAt.toISOString() : null,
    setBy: row.actorEmail,
  };
});

/**
 * One workspace's switch.
 *
 * ⚠️ THE EXPIRY IS APPLIED IN THE QUERY, not read and compared later.
 * `flags.ts` makes the same argument: a row whose `expires_at` has passed
 * must never come back as "enabled", because somewhere downstream a
 * caller will forget to check it.
 */
export const readTenantMaintenance = cache(
  async (tenantId: string): Promise<MaintenanceState | null> => {
    const row = await withPlatformScope(
      "Read this workspace's maintenance-mode flag to gate its writes",
      async (db) => {
        const [flag] = await db
          .select()
          .from(platformTenantFlags)
          .where(
            and(
              eq(platformTenantFlags.tenantId, tenantId),
              eq(platformTenantFlags.flagKey, MAINTENANCE_FLAG_KEY),
              eq(platformTenantFlags.enabled, true),
              or(
                isNull(platformTenantFlags.expiresAt),
                gt(platformTenantFlags.expiresAt, new Date()),
              ),
            ),
          )
          .limit(1);
        return flag ?? null;
      },
    );

    if (!row) return null;
    const value = (row.value ?? {}) as Record<string, unknown>;
    return {
      scope: "tenant",
      enabled: row.enabled,
      endsAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      message: textOf(value.message),
      reason: row.reason,
      since: row.createdAt ? row.createdAt.toISOString() : null,
      setBy: row.setByEmail,
    };
  },
);

export type EffectiveMaintenance = {
  global: MaintenanceState | null;
  tenant: MaintenanceState | null;
  /** The one in force right now, or null. */
  active: MaintenanceState | null;
};

/**
 * ⭐ GLOBAL WINS OVER PER-TENANT, and the tie is not arbitrary: global is
 * the broader statement, so if both are on, the sentence the customer
 * should read is the one about the whole product being paused.
 */
export async function effectiveMaintenance(
  tenantId: string | null,
  now: Date = new Date(),
): Promise<EffectiveMaintenance> {
  const [global, tenant] = await Promise.all([
    readGlobalMaintenance().catch(() => null),
    tenantId ? readTenantMaintenance(tenantId).catch(() => null) : Promise.resolve(null),
  ]);

  const active = isMaintenanceActive(global, now)
    ? global
    : isMaintenanceActive(tenant, now)
      ? tenant
      : null;

  return { global, tenant, active };
}

/* ------------------------------------------------------------------ */
/* THE GATE                                                            */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐⭐ REFUSE THIS WRITE IF THE PRODUCT IS PAUSED.
 *
 * Returns silently when nothing is paused, so it is safe to call
 * unconditionally — the same contract `assertImpersonationAllows` has,
 * deliberately, because it is called from inside it.
 *
 * @param tenantId `null` for background paths with no tenant resolved:
 *                 those are still subject to the GLOBAL switch, which is
 *                 the one that matters when nobody is logged in.
 *
 * ⚠️ A FAILED READ REFUSES NOTHING. `effectiveMaintenance` swallows read
 * errors to `null`. That is a deliberate fail-OPEN on a control whose
 * failure mode is "the product stays writable during a window", not "the
 * product goes down" — and the alternative is that one flaky platform
 * query freezes every tenant in the fleet.
 */
export async function assertMaintenanceAllows(
  operation: string,
  tenantId: string | null,
): Promise<void> {
  const now = new Date();
  const { active } = await effectiveMaintenance(tenantId, now);
  const verdict = evaluateMaintenance(operation, active, now);
  if (verdict.allowed) return;

  throw new MaintenanceReadOnlyError(
    operation,
    verdict.scope ?? "global",
    verdict.reason ?? "Changes are paused for maintenance.",
  );
}
