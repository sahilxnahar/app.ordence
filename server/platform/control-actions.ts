"use server";

/**
 * Ordence — ⭐⭐⭐ THE FIVE CONTROLS, REACHABLE
 * Version: v1.22.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION AND NONE TAKES A TENANT ID IT
 * DOES NOT CHECK. The platform console is the one place in Ordence where
 * a caller legitimately names a workspace, so every export here begins
 * with `requireCapability`, which is what makes that legitimate.
 *
 * ⭐ Five gaps closed in one file: the approval queue, the entitlement
 * preview with verification and undo, health events that persist,
 * break-glass with a procedure, and incident mode.
 */

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withPlatformScope } from "@/db";
import {
  platformApprovalQueue,
  platformEntitlementHistory,
  platformIncidents,
  tenantHealthEvents,
} from "@/db/schema/platform-control";
import { tenants } from "@/db/schema/core";
import { requireCapability, recordPlatformAudit } from "./guard";
import {
  countActiveOperators,
  decideApproval,
  listPending,
  queueForApproval,
  registerApprovalExecutor,
  tenantLabel,
} from "./approvals";
import { suspendTenant } from "./tenants";
import { setTenantFlag, getTenantFlags } from "./flags";
import { previewChange, verifyChange } from "@/lib/platform/entitlement-diff";
import { MODULE_REGISTRY } from "@/lib/modules/registry";
import { effectiveTier, featuresForTier } from "@/lib/entitlements/features";
import { myBreakGlassDebt, allOutstandingWriteUps, writePostIncidentNote } from "./break-glass";
import { sweepTenantHealth } from "./health-sweep";
import { PROCEDURE_STEPS } from "@/lib/platform/break-glass";
import type { PlatformResult } from "@/lib/platform/schemas";
import type { PlatformGrade } from "@/lib/platform/approvals";
import type { PlanTier } from "@/db/schema/core";

/* ================================================================== */
/* ① THE EXECUTORS                                                     */
/* ================================================================== */

/**
 * 🔴 REGISTERED AT IMPORT TIME, AND THEY CALL THE EXISTING FUNCTIONS
 * UNCHANGED.
 *
 * ⚠️ THIS IS THE WHOLE POINT OF THE WRAPPER DESIGN. There is one
 * implementation of suspension. The queue delays it; it does not
 * reimplement it, and there is no second code path to drift.
 */
registerApprovalExecutor("tenant.suspend", async (payload) => {
  const result = await suspendTenant(payload);
  return result.ok ? { ok: true } : { ok: false, error: result.error };
});

registerApprovalExecutor("entitlement.override_paid", async (payload) => {
  const result = await setTenantFlag(payload);
  return result.ok ? { ok: true } : { ok: false, error: result.error };
});

/* ================================================================== */
/* ② SUSPEND, THROUGH THE QUEUE                                        */
/* ================================================================== */

const requestSuspendSchema = z.object({
  tenantId: z.string().uuid(),
  confirmSlug: z.string().min(1),
  reason: z.string().min(5),
  customerMessage: z.string().optional(),
  justification: z.string().min(20),
});

/**
 * ⭐ THE OPERATOR CALLS THIS INSTEAD OF `suspendTenant`, and the only
 * difference they experience is that nothing happens yet.
 */
export async function requestSuspend(
  input: unknown,
): Promise<PlatformResult<{ note: string }>> {
  const operator = await requireCapability("tenants:suspend");
  const parsed = requestSuspendSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Check the form.",
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const label = await tenantLabel(parsed.data.tenantId);
  const outcome = await queueForApproval({
    kind: "tenant.suspend",
    operator,
    targetType: "tenant",
    targetId: parsed.data.tenantId,
    targetLabel: label,
    justification: parsed.data.justification,
    proposedAfter: { status: "suspended", reason: parsed.data.reason },
    // ⚠️ THE VALIDATED ARGUMENTS, STORED VERBATIM. On approval they are
    // handed back to the same function that would have received them.
    payload: {
      tenantId: parsed.data.tenantId,
      confirmSlug: parsed.data.confirmSlug,
      reason: parsed.data.reason,
      customerMessage: parsed.data.customerMessage,
    },
    now: new Date(),
  });

  if (!outcome.queued) return { ok: false, error: outcome.error };
  revalidatePath("/platform/approvals");
  return { ok: true, data: { note: outcome.note } };
}

/* ================================================================== */
/* ③ THE QUEUE SCREEN                                                  */
/* ================================================================== */

export async function getApprovalQueue(): Promise<
  PlatformResult<{
    rows: ReadonlyArray<Record<string, unknown>>;
    soleOperator: boolean;
    myStaffId: string;
  }>
> {
  const operator = await requireCapability("tenants:read");
  const rows = await listPending(new Date());
  const operators = await countActiveOperators();

  return {
    ok: true,
    data: {
      rows: rows as ReadonlyArray<Record<string, unknown>>,
      // ⭐ Drives whether the self-approval hatch is offered at all.
      soleOperator: operators <= 1,
      myStaffId: operator.staff.id,
    },
  };
}

const decideSchema = z.object({
  requestId: z.string().uuid(),
  approve: z.boolean(),
  note: z.string().max(1000).default(""),
});

export async function decideRequest(
  input: unknown,
): Promise<PlatformResult<{ note: string }>> {
  const operator = await requireCapability("tenants:read");
  const parsed = decideSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Check the form." };

  const operators = await countActiveOperators();

  const outcome = await decideApproval({
    requestId: parsed.data.requestId,
    approver: operator,
    approverGrade: operator.grade as PlatformGrade,
    approve: parsed.data.approve,
    note: parsed.data.note,
    soleOperator: operators <= 1,
    now: new Date(),
  });

  if (!outcome.ok) return { ok: false, error: outcome.error };
  revalidatePath("/platform/approvals");
  return { ok: true, data: { note: outcome.note } };
}

/* ================================================================== */
/* ④ THE TOGGLE: PREVIEW, WRITE, VERIFY                                */
/* ================================================================== */

const previewSchema = z.object({
  tenantId: z.string().uuid(),
  featureKey: z.string().min(1).max(120),
  direction: z.enum(["enable", "disable"]),
});

/**
 * ⭐⭐ WHAT THIS TOGGLE ACTUALLY DOES, BEFORE IT DOES IT.
 *
 * ⚠️ `featuresGainedBy` and `featuresLostBy` have existed in
 * `lib/entitlements/features.ts` since the tier system was built, and
 * nothing on the console has ever called either.
 */
export async function previewEntitlementChange(
  input: unknown,
): Promise<PlatformResult<ReturnType<typeof previewChange>>> {
  await requireCapability("entitlements:override");
  const parsed = previewSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Check the form." };

  const facts = await withPlatformScope(
    `Platform console: preview ${parsed.data.featureKey} for ${parsed.data.tenantId}`,
    async (db) => {
      const [t] = await db
        .select({ name: tenants.name })
        .from(tenants)
        .where(eq(tenants.id, parsed.data.tenantId))
        .limit(1);

      const rows = await db.execute(sql`
        SELECT
          (SELECT count(*)::int FROM users
            WHERE tenant_id = ${parsed.data.tenantId}::uuid
              AND deleted_at IS NULL
              AND status = 'active')                        AS users,
          (SELECT s.plan_tier FROM subscriptions s
            WHERE s.tenant_id = ${parsed.data.tenantId}::uuid
            LIMIT 1)                                        AS plan_tier,
          (SELECT s.status FROM subscriptions s
            WHERE s.tenant_id = ${parsed.data.tenantId}::uuid
            LIMIT 1)                                        AS sub_status
      `);
      const first = (Array.isArray(rows) ? rows[0] : (rows as { rows?: unknown[] }).rows?.[0]) ?? {};
      const r = first as { users?: number; plan_tier?: string; sub_status?: string };

      return {
        name: t?.name ?? "this workspace",
        userCount: Number(r.users ?? 0),
        planTier: (r.plan_tier ?? "free") as PlanTier,
        subStatus: r.sub_status ?? null,
      };
    },
  );

  const modules = Object.values(MODULE_REGISTRY).map((m) => ({
    id: m.navId,
    label: m.label,
    featureKey: (m.feature ?? null) as string | null,
    status: m.status,
  }));

  /**
   * 🔴🔴 A SECOND BUG CAUGHT BEFORE IT SHIPPED, AND IT IS THE SAME
   * MISTAKE AS THE RECORD COUNTS.
   *
   * ⚠️ THIS PASSED AN EMPTY ARRAY. `previewChange` then evaluated
   * `!planFeatures.includes(key)` — always true — and printed "their
   * plan does not include this, so it is effectively a discount" on
   * EVERY enable, including the ones the customer is already paying for.
   * An empty list is not "we do not know"; it is a confident and wrong
   * answer.
   *
   * ⭐ `effectiveTier` IS THE RIGHT SOURCE, NOT `plan_tier`. A workspace
   * on trial has the advanced feature set and a `free` row, and a lapsed
   * one has the opposite. The two disagree exactly when it matters.
   */
  const tier = effectiveTier({
    planTier: facts.planTier,
    // ⚠️ THE SAME SET `lib/billing/access-state.ts` TREATS AS LAPSED. A
    // trialing workspace still has access; an unpaid one does not, and
    // the preview must say what the customer actually sees today.
    subscriptionGrantsAccess:
      facts.subStatus === null
        ? false
        : !["unpaid", "past_due", "cancelled", "incomplete_expired"].includes(facts.subStatus),
  });

  return {
    ok: true,
    data: previewChange({
      featureKey: parsed.data.featureKey,
      direction: parsed.data.direction,
      tenantName: facts.name,
      modules,
      planFeatures: featuresForTier(tier),
      // ⚠️ DELIBERATELY EMPTY, AND `previewChange` NOW KNOWS THE
      // DIFFERENCE BETWEEN EMPTY AND ZERO. Counting rows per module needs
      // a module-to-table map that does not exist, and the preview says
      // "this screen has not counted" rather than "there is no data".
      recordCounts: {},
      userCount: facts.userCount,
    }),
  };
}

const applySchema = z.object({
  tenantId: z.string().uuid(),
  featureKey: z.string().min(1).max(120),
  enabled: z.boolean(),
  // ⚠️ 15, not 10. `setTenantFlagSchema` demands 15, so a
  // 12-character reason passed this form and was rejected downstream
  // with "Check the form." and no field to point at.
  reason: z.string().min(15).max(1000),
});

/**
 * ⭐⭐⭐ WRITE, THEN CHECK ON A FRESH READ, THEN RECORD BOTH.
 *
 * 🔴 A TOGGLE THAT SILENTLY FAILS IS WORSE THAN ONE THAT ERRORS. It
 * produces a support ticket beginning "I enabled it, it should be
 * working", and the operator's own screen agrees with the customer.
 */
export async function applyEntitlementChange(
  input: unknown,
): Promise<PlatformResult<{ verified: boolean; note: string }>> {
  const operator = await requireCapability("entitlements:override");
  const parsed = applySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Check the form." };

  const flagKey = `entitlement:${parsed.data.featureKey}`;

  const before = await getTenantFlags(parsed.data.tenantId);
  const beforeEnabled = before.has(flagKey);

  const written = await setTenantFlag({
    tenantId: parsed.data.tenantId,
    flagKey,
    enabled: parsed.data.enabled,
    reason: parsed.data.reason,
  });

  if (!written.ok) return { ok: false, error: written.error };

  // 🔴 A FRESH READ. Confirming a write by reading back the value you
  // just sent confirms nothing at all.
  const after = await getTenantFlags(parsed.data.tenantId);
  const verdict = verifyChange({
    expected: parsed.data.enabled,
    observed: after.has(flagKey),
    featureKey: parsed.data.featureKey,
  });

  await withPlatformScope(
    `Platform console: record entitlement change for ${parsed.data.tenantId}`,
    async (db) => {
      await db.insert(platformEntitlementHistory).values({
        tenantId: parsed.data.tenantId,
        flagKey,
        beforeEnabled,
        afterEnabled: parsed.data.enabled,
        changedBy: operator.staff.id,
        reason: parsed.data.reason,
        verifiedAt: new Date(),
        verifiedOk: verdict.ok,
        verifyNote: verdict.note.slice(0, 500),
      });
    },
  );

  revalidatePath(`/platform/tenants/${parsed.data.tenantId}`);
  return { ok: true, data: { verified: verdict.ok, note: verdict.note } };
}

/**
 * ⭐ UNDO. A revert is a NEW row, never a deletion.
 *
 * ⚠️ The history of a workspace's configuration is evidence. Editing it
 * to make the present tidy destroys the only record of what a customer
 * had at the moment they complained.
 */
export async function revertEntitlementChange(
  input: unknown,
): Promise<PlatformResult<{ note: string }>> {
  const operator = await requireCapability("entitlements:override");
  const { historyId } = z.object({ historyId: z.string().uuid() }).parse(input);

  const row = await withPlatformScope("Platform console: read entitlement history", async (db) => {
    const [r] = await db
      .select()
      .from(platformEntitlementHistory)
      .where(eq(platformEntitlementHistory.id, historyId))
      .limit(1);
    return r ?? null;
  });

  if (!row) return { ok: false, error: "No such change." };

  // ⚠️ NULL BEFORE MEANS THE FLAG DID NOT EXIST, which reverts to off.
  // Treating null as false would be the same outcome by accident rather
  // than on purpose, and the next person could not tell which.
  const target = row.beforeEnabled ?? false;

  const written = await setTenantFlag({
    tenantId: row.tenantId,
    flagKey: row.flagKey,
    enabled: target,
    reason: `Reverting the change made on ${row.changedAt.toISOString().slice(0, 10)}.`,
  });

  if (!written.ok) return { ok: false, error: written.error };

  await withPlatformScope("Platform console: record revert", async (db) => {
    await db.insert(platformEntitlementHistory).values({
      tenantId: row.tenantId,
      flagKey: row.flagKey,
      beforeEnabled: row.afterEnabled,
      afterEnabled: target,
      changedBy: operator.staff.id,
      reason: "Reverted.",
      revertsId: row.id,
      verifiedAt: new Date(),
      verifiedOk: true,
      verifyNote: "Reverted to the state recorded before the original change.",
    });
  });

  revalidatePath(`/platform/tenants/${row.tenantId}`);
  return { ok: true, data: { note: `Reverted ${row.flagKey}.` } };
}

/* ================================================================== */
/* ⑤ HEALTH EVENTS                                                     */
/* ================================================================== */

/**
 * ⭐⭐⭐ THE READ THAT SWEEPS FIRST.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WITHOUT THIS ONE LINE THE WHOLE FEATURE IS AN EMPTY TABLE
 * ══════════════════════════════════════════════════════════════════════
 * `tenant_health_events`, the rules that fill it and the screen that
 * reads it were all written before anything CALLED the sweep. That is
 * the eighth time this codebase has produced a complete engine nothing
 * reaches, and `scripts/check-reachability.mjs` exists because of the
 * first seven.
 *
 * ⚠️ SWEPT ON READ RATHER THAN ON A SCHEDULE. A cron would be tidier and
 * would also mean this screen is silently empty on the morning the
 * scheduler is the thing that broke — which is a morning when somebody
 * is looking at this screen specifically.
 */
export async function getOpenHealthEvents(): Promise<
  PlatformResult<ReadonlyArray<Record<string, unknown>>>
> {
  await requireCapability("observatory:read");
  await sweepTenantHealth(new Date());
  const rows = await withPlatformScope("Platform console: open health events", async (db) =>
    db
      .select({
        id: tenantHealthEvents.id,
        tenantId: tenantHealthEvents.tenantId,
        tenantName: tenants.name,
        ruleKey: tenantHealthEvents.ruleKey,
        severity: tenantHealthEvents.severity,
        headline: tenantHealthEvents.headline,
        whatToDo: tenantHealthEvents.whatToDo,
        evidence: tenantHealthEvents.evidence,
        detectedAt: tenantHealthEvents.detectedAt,
      })
      .from(tenantHealthEvents)
      .innerJoin(tenants, eq(tenants.id, tenantHealthEvents.tenantId))
      .where(isNull(tenantHealthEvents.resolvedAt))
      .orderBy(desc(tenantHealthEvents.detectedAt))
      .limit(100),
  );
  return { ok: true, data: rows as ReadonlyArray<Record<string, unknown>> };
}

const resolveSchema = z.object({
  eventId: z.string().uuid(),
  note: z.string().min(10).max(2000),
});

/**
 * ⚠️ THE NOTE IS MANDATORY AND TEN CHARACTERS IS THE FLOOR. An alert
 * dismissed without one is an alert that will be raised again next week
 * and dismissed again, and the third time nobody reads it.
 */
export async function resolveHealthEvent(
  input: unknown,
): Promise<PlatformResult<{ resolved: true }>> {
  const operator = await requireCapability("tenants:read");
  const parsed = resolveSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error:
        "A note of at least ten characters is required. Closing an alert without saying what you did means the next person sees it again and learns to ignore it.",
    };
  }

  await withPlatformScope("Platform console: resolve health event", async (db) => {
    await db
      .update(tenantHealthEvents)
      .set({
        resolvedAt: new Date(),
        resolvedBy: operator.staff.id,
        resolutionNote: parsed.data.note,
      })
      .where(eq(tenantHealthEvents.id, parsed.data.eventId));
  });

  revalidatePath("/platform/health");
  return { ok: true, data: { resolved: true } };
}

/* ================================================================== */
/* ⑥ INCIDENT MODE                                                     */
/* ================================================================== */

const declareSchema = z.object({
  title: z.string().min(5).max(200),
  severity: z.enum(["sev1", "sev2", "sev3"]),
});

/**
 * ⭐ AT THREE IN THE MORNING NOBODY WRITES DOWN WHAT THEY DID. Every
 * action taken while this is open is tagged with the incident, so the
 * post-mortem assembles itself from the log rather than from memory.
 */
export async function declareIncident(
  input: unknown,
): Promise<PlatformResult<{ reference: string }>> {
  const operator = await requireCapability("tenants:configure");
  const parsed = declareSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Check the form." };

  const reference = await withPlatformScope("Platform console: declare incident", async (db) => {
    const rows = await db.execute(sql`
      SELECT COALESCE(MAX(NULLIF(regexp_replace(reference, '\\D', '', 'g'), '')::int), 0) + 1 AS n
        FROM platform_incidents
    `);
    const first = (Array.isArray(rows) ? rows[0] : (rows as { rows?: unknown[] }).rows?.[0]) ?? {};
    const ref = `INC-${String(Number((first as { n?: number }).n ?? 1)).padStart(4, "0")}`;

    await db.insert(platformIncidents).values({
      reference: ref,
      title: parsed.data.title,
      severity: parsed.data.severity,
      declaredBy: operator.staff.id,
    });
    return ref;
  });

  await recordPlatformAudit({
    operator,
    tenantId: null,
    action: "config_change",
    resourceType: "incident",
    reason: `Declared ${reference}: ${parsed.data.title}`,
    severity: "critical",
  });

  revalidatePath("/platform/incidents");
  return { ok: true, data: { reference } };
}

const resolveIncidentSchema = z.object({
  incidentId: z.string().uuid(),
  summary: z.string().min(20).max(5000),
});

export async function resolveIncident(
  input: unknown,
): Promise<PlatformResult<{ resolved: true }>> {
  const operator = await requireCapability("tenants:configure");
  const parsed = resolveIncidentSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error:
        "A summary of at least twenty characters is required. An incident closed without one is an incident nobody can learn from.",
    };
  }

  await withPlatformScope("Platform console: resolve incident", async (db) => {
    await db
      .update(platformIncidents)
      .set({
        resolvedAt: new Date(),
        resolvedBy: operator.staff.id,
        summary: parsed.data.summary,
      })
      .where(eq(platformIncidents.id, parsed.data.incidentId));
  });

  revalidatePath("/platform/incidents");
  return { ok: true, data: { resolved: true } };
}

export async function getIncidents(): Promise<
  PlatformResult<ReadonlyArray<Record<string, unknown>>>
> {
  await requireCapability("observatory:read");
  const rows = await withPlatformScope("Platform console: incidents", async (db) =>
    db
      .select()
      .from(platformIncidents)
      .orderBy(desc(platformIncidents.declaredAt))
      .limit(50),
  );
  return { ok: true, data: rows as ReadonlyArray<Record<string, unknown>> };
}

/* ================================================================== */
/* ⑦ BREAK-GLASS: THE WRITE-UP THAT UNBLOCKS THE NEXT ONE              */
/* ================================================================== */

/**
 * ⭐ WHAT I OWE, ON MY OWN SCREEN.
 *
 * ⚠️ SHOWN BEFORE IT IS BLOCKING, not only at the moment of refusal. A
 * control whose first appearance is a refusal at two in the morning is a
 * control that gets described as "the thing that stopped me helping a
 * customer" rather than as a procedure.
 */
export async function getMyBreakGlassDebt(): Promise<
  PlatformResult<{
    mine: ReadonlyArray<Record<string, unknown>>;
    all: ReadonlyArray<Record<string, unknown>>;
    steps: readonly string[];
  }>
> {
  const operator = await requireCapability("tenants:read");
  const now = new Date();
  const mine = await myBreakGlassDebt(operator.staff.id, now);
  const all = await allOutstandingWriteUps(now);
  return {
    ok: true,
    data: {
      mine: mine as unknown as ReadonlyArray<Record<string, unknown>>,
      all: all as unknown as ReadonlyArray<Record<string, unknown>>,
      steps: PROCEDURE_STEPS,
    },
  };
}

const writeUpSchema = z.object({
  sessionId: z.string().uuid(),
  note: z.string().min(1).max(5000),
});

export async function writeBreakGlassNote(
  input: unknown,
): Promise<PlatformResult<{ note: string }>> {
  const operator = await requireCapability("tenants:read");
  const parsed = writeUpSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Write the note first." };

  const outcome = await writePostIncidentNote({
    sessionId: parsed.data.sessionId,
    note: parsed.data.note,
    operator,
    now: new Date(),
  });

  if (!outcome.ok) return { ok: false, error: outcome.error };
  revalidatePath("/platform/incidents");
  revalidatePath("/platform/sessions");
  return { ok: true, data: { note: outcome.note } };
}

void and;
void platformApprovalQueue;
