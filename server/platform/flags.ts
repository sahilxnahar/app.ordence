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
// 🔴 SIDE EFFECT: registers every approval executor. Without it this
// module could hold a write and then fail to queue it, because
// `queueForApproval` refuses a kind with no executor. See that module.
import "./approval-executors";
import {
  approvalGate,
  commercialStandingIn,
  queueForApproval,
  recordApprovalRefusal,
  type ApprovalTicket,
} from "./approvals";
import { entitlementOverrideIsHeld } from "@/lib/platform/approvals";

/* ------------------------------------------------------------------ */
/* WRITE                                                               */
/* ------------------------------------------------------------------ */

/**
 * ⭐ WHAT A CALLER GETS BACK WHEN THE POLICY HELD THE WRITE.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 `ok: true` MUST NOT MEAN BOTH "DONE" AND "QUEUED"
 * ══════════════════════════════════════════════════════════════════════
 * That collapse is a bug this codebase has already shipped once, on the
 * suspend button: `requestSuspend` returned `ok: true` with a note
 * beginning "Nothing has happened yet" and the UI raised
 * `toast.success("Done.")`. The operator then believed a live workspace
 * was locked.
 *
 * ⚠️ SO THE DISTINCTION IS IN THE TYPE, NOT IN A STRING. `queued` is
 * required on the success shape, so a caller cannot forget it exists —
 * which is exactly how the last one forgot.
 */
export type FlagWriteOutcome =
  | { readonly queued: false }
  | { readonly queued: true; readonly requestId: string; readonly note: string };

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐⭐ THIS IS THE ENFORCEMENT POINT FOR `entitlement.override_paid`
 * ══════════════════════════════════════════════════════════════════════
 * Not `applyEntitlementChange`, not `setTenantFlagAction`, not the flag
 * panel. All three of those reach this function, and a gate in any one of
 * them leaves the other two open — which is precisely the shape
 * `BLOCKED_BECAUSE` called decoration.
 *
 * ⚠️ `ticket` IS A SECOND ARGUMENT AND NEVER PART OF `input`. Every
 * public door forwards exactly one argument and Zod strips what it does
 * not know, so no POST body can become one. The approval executor is the
 * only caller that passes it, and it is re-verified against the queue row
 * inside the write transaction anyway.
 */
export async function setTenantFlag(
  input: unknown,
  ticket?: ApprovalTicket,
): Promise<PlatformResult<FlagWriteOutcome>> {
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
        .select({ id: tenants.id, name: tenants.name, slug: tenants.slug })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);

      if (!tenant) return { step: "missing" } as const;

      /*
       * ══════════════════════════════════════════════════════════════
       * 🔴🔴 THE GATE. HERE, BEFORE THE INSERT, ON THIS CONNECTION.
       * ══════════════════════════════════════════════════════════════
       * `commercialStandingIn` reads the plan tier and the subscription's
       * `unit_amount_minor` — a bigint, compared to `0n` as a bigint — in
       * this same transaction, so a workspace that converted from trial
       * to paid two seconds ago is paid for the purposes of this write.
       * A copy of that fact read before the transaction opened would be a
       * race with money on the other side of it.
       *
       * ⚠️ NOTHING IS WRITTEN ON THE HELD PATH. The function returns out
       * of the transaction before the insert, and the caller raises the
       * request afterwards with the arguments it already validated.
       */
      const standing = await commercialStandingIn(db, tenantId);
      const gate = await approvalGate(db, {
        kind: "entitlement.override_paid",
        held: entitlementOverrideIsHeld({ flagKey, ...standing }),
        ticket,
        targetId: tenantId,
      });

      if (!gate.proceed) {
        return {
          step: "held",
          gate,
          label: `${tenant.name} (${tenant.slug})`,
        } as const;
      }

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

      return { step: "written", previous: previous?.enabled ?? false } as const;
    },
  );

  if (outcome.step === "missing") return { ok: false, error: "Workspace not found." };

  /* ---------------------------------------------------------------- */
  /* THE HELD PATH — NOTHING WAS WRITTEN                               */
  /* ---------------------------------------------------------------- */
  if (outcome.step === "held") {
    const { gate } = outcome;

    /*
     * 🔴 A CLAIM THAT DID NOT CHECK OUT. Refused outright rather than
     * queued: a ticket that names a rejected, expired, already-executed
     * or self-approved-without-the-hatch row is not a request waiting to
     * be made, it is an assertion that turned out to be false, and
     * turning it into a fresh request would launder it.
     */
    if (!gate.queue) {
      await recordApprovalRefusal({
        operator,
        kind: "entitlement.override_paid",
        targetType: "tenant",
        targetId: tenantId,
        targetLabel: outcome.label,
        reason: gate.reason,
      });
      return { ok: false, error: gate.reason };
    }

    const queued = await queueForApproval({
      kind: "entitlement.override_paid",
      operator,
      targetType: "tenant",
      targetId: tenantId,
      targetLabel: outcome.label,
      justification: reason,
      proposedAfter: {
        flagKey,
        enabled,
        // ⚠️ WHAT THE APPROVER IS ACTUALLY AGREEING TO, in words. The
        // queue renders `proposedAfter` verbatim, and "entitlement:
        // crm.deals = true" is not a sentence somebody can weigh.
        effect: enabled
          ? `Switches ${flagKey} ON for a paying customer — a capability they are not currently invoiced for.`
          : `Switches ${flagKey} OFF for a paying customer — a capability they may be relying on today.`,
      },
      // ⭐ THE VALIDATED ARGUMENTS, REPLAYED VERBATIM. `writer` tells the
      // executor which of the two entitlement writers raised this; see
      // `approval-executors.ts` for why collapsing them would be a bug.
      payload: {
        writer: "flag",
        tenantId,
        flagKey,
        enabled,
        reason,
        expiresAt: expiresAt ?? null,
        value,
      },
      heldWrite: true,
      now: new Date(),
    });

    /*
     * ⚠️ THE COMMONEST REASON THIS FAILS IS THE JUSTIFICATION FLOOR, AND
     * IT IS NOT A BUG. This form asks for fifteen characters; the queue
     * asks for twenty, because its reason is read by a SECOND PERSON,
     * months later, deciding whether to agree. So a fifteen-character
     * reason saves an unheld flag and is bounced for a held one, with the
     * error pointing at the field that has to grow.
     *
     * 🔴 AND IT IS STILL RECORDED. A write that was stopped and then
     * failed to become a request is the state most worth finding later —
     * it is an operator who tried, was refused, and has nothing waiting.
     */
    if (!queued.queued) {
      await recordApprovalRefusal({
        operator,
        kind: "entitlement.override_paid",
        targetType: "tenant",
        targetId: tenantId,
        targetLabel: outcome.label,
        reason: queued.error,
      });
      return {
        ok: false,
        error: queued.error,
        fieldErrors: { reason: [queued.error] },
      };
    }

    return {
      ok: true,
      data: { queued: true, requestId: queued.requestId, note: queued.note },
    };
  }

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
      // ⭐ WHICH APPROVAL MADE THIS LEGAL, in the customer's own log. An
      // auditor reading the workspace's history should not have to join
      // to the queue to find out whether a second person agreed.
      approvedRequestId: ticket?.approvedRequestId ?? null,
    },
  });

  return { ok: true, data: { queued: false } };
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

/**
 * Every live flag for a tenant, for the tenant's own app to read once.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THIS SET IS NOT ONLY FLAGS, AND CALLERS MUST NOT TREAT IT AS ONE
 * ══════════════════════════════════════════════════════════════════════
 * `platform_tenant_flags` now carries FOUR namespaces, all of them rows
 * in this one table under one RLS policy:
 *
 *   (no prefix)     the catalogue in `lib/platform/flags-catalog.ts`
 *   `entitlement:`  module overrides — `lib/entitlements/overrides.ts`
 *   `config:`       the configuration chain — `lib/platform/config-chain.ts`
 *   `lifecycle:`    the offboarding record — `server/platform/tenants.ts`
 *
 * The namespaces are kept apart so a beta flag can never collide with a
 * feature key and become a free upgrade nobody invoices, and so a
 * scheduled deletion is never mistaken for a toggle.
 *
 * ⚠️ SO `getTenantFlags()` RETURNS PREFIXED KEYS TOO — it always has;
 * `applyEntitlementChange` relies on `entitlement:` appearing here. Every
 * caller asks `has(someKnownKey)`, which is safe. What is NOT safe is
 * iterating this set and treating each member as a catalogue flag: use
 * `isFlagKey()` first, exactly as `isTenantFlagEnabled` above does.
 */
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
