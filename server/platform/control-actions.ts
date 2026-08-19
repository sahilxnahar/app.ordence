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
// 🔴 SIDE-EFFECT IMPORT. Registers every approval executor. See the note
// under "① THE EXECUTORS" below, and that module's own header.
import "./approval-executors";
import {
  countActiveOperators,
  decideApproval,
  listPending,
  queueForApproval,
  tenantLabel,
} from "./approvals";
import { setTenantFlag, getTenantFlags } from "./flags";
import { readGlobalMaintenance } from "./maintenance";
import { platformTenantFlags } from "@/db/schema/platform";
import {
  MAINTENANCE_FLAG_KEY,
  MAINTENANCE_LOG_RESOURCE,
  MAINTENANCE_LOG_RESOURCE_ID,
  type MaintenanceState,
} from "@/lib/platform/maintenance-policy";
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
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THEY MOVED, AND THE MOVE IS THE POINT — BATCH 43
 * ══════════════════════════════════════════════════════════════════════
 * All five registrations now live in `./approval-executors`, imported
 * above for its side effect. They were here while the only two request
 * paths were also here; three of the five are now raised by the WRITING
 * FUNCTIONS themselves (`flags.ts`, `configuration.ts`, `staff.ts`),
 * which are reachable from server actions that never import this file.
 *
 * 🔴 `queueForApproval` REFUSES A KIND WITH NO REGISTERED EXECUTOR. Left
 * here, a plan change would have been held, tried to queue, and been told
 * "nothing in this build can carry that out" — a true sentence about an
 * untrue situation, on a path that had just correctly stopped a write.
 * That file's header has the rest of the argument.
 *
 * ⚠️ NOTHING ABOUT THE WRAPPER DESIGN CHANGED. There is still exactly one
 * implementation of suspension; the queue still delays it rather than
 * reimplementing it; there is still no second code path to drift.
 */

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
/* ②b TERMINATE, THROUGH THE SAME QUEUE — BATCH 46                     */
/* ================================================================== */

const requestTerminationSchema = z.object({
  tenantId: z.string().uuid(),
  /** ① The workspace address, typed. Catches the wrong-row mistake. */
  confirmSlug: z.string().min(1),
  /**
   * ② A phrase nobody types by accident. The slug is on the screen and
   * can be copied; this cannot, which is the entire difference between
   * the two fields and the reason both exist.
   */
  confirmPhrase: z.string(),
  /**
   * ③ An acknowledgement, not a checkbox for its own sake: it is the one
   * confirmation that asserts something about the WORLD rather than
   * about the form — that the customer has been offered their data.
   */
  acknowledgeExport: z.literal(true, {
    errorMap: () => ({
      message:
        "Confirm that this customer has been offered an export. Deleting a workspace whose owner never got their records back is a DPDP problem, not a support one.",
    }),
  }),
  reason: z.string().min(20),
  justification: z.string().min(20),
});

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THREE CONFIRMATIONS, A SECOND APPROVER, AND STILL NOTHING HAPPENS
 * ══════════════════════════════════════════════════════════════════════
 * This queues. It does not schedule and it certainly does not delete.
 * The operator's three confirmations buy them the right to ASK; the
 * second owner's approval buys a date on the calendar; the cancel window
 * runs from there.
 *
 * ⚠️ IT REUSES THE EXISTING QUEUE, DELIBERATELY. `tenant.terminate` is
 * already declared in `lib/platform/approvals.ts` — owner grade, 24-hour
 * request expiry, self-approval only while Ordence has one operator and
 * only after fifteen minutes. Inventing a second approval mechanism for
 * the most dangerous action in the console would mean the weakest one
 * guards the worst thing.
 */
export async function requestTermination(
  input: unknown,
): Promise<PlatformResult<{ note: string }>> {
  const operator = await requireCapability("tenants:suspend");
  const parsed = requestTerminationSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Check the form.",
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  // ⚠️ CHECKED HERE AND AGAIN IN THE EXECUTOR. Here so the operator is
  // told immediately; there because hours pass in between and the queue
  // row is replayed by a different person.
  if (parsed.data.confirmPhrase.trim() !== "DELETE ALL DATA") {
    return {
      ok: false,
      error: "The confirmation phrase does not match.",
      fieldErrors: { confirmPhrase: ["Type DELETE ALL DATA exactly."] },
    };
  }

  const label = await tenantLabel(parsed.data.tenantId);
  const now = new Date();

  const outcome = await queueForApproval({
    kind: "tenant.terminate",
    operator,
    targetType: "tenant",
    targetId: parsed.data.tenantId,
    targetLabel: label,
    justification: parsed.data.justification,
    proposedBefore: { status: "live" },
    proposedAfter: {
      status: "pending_deletion",
      // ⭐ WHAT APPROVING WILL ACTUALLY DO, on the approver's screen.
      // The queue renders `proposedAfter`, and an approver who reads
      // "terminate" without reading "schedules, does not delete" will
      // hesitate over the wrong thing.
      effect: "Schedules a deletion and locks the workspace read-only. Cancellable until the scheduled moment. Nothing is deleted by approving.",
      reason: parsed.data.reason,
    },
    // The validated arguments, replayed verbatim into
    // `scheduleTenantTermination` on approval.
    payload: {
      tenantId: parsed.data.tenantId,
      confirmSlug: parsed.data.confirmSlug,
      confirmPhrase: parsed.data.confirmPhrase.trim(),
      acknowledgeExport: true,
      reason: parsed.data.reason,
      requestedByEmail: operator.email,
      requestedAt: now.toISOString(),
    },
    now,
  });

  if (!outcome.queued) return { ok: false, error: outcome.error };
  revalidatePath("/platform/approvals");
  revalidatePath(`/platform/tenants/${parsed.data.tenantId}`);
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
): Promise<PlatformResult<{ verified: boolean; note: string; queued: boolean }>> {
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

  /**
   * ══════════════════════════════════════════════════════════════════
   * 🔴 HELD. NOTHING WAS WRITTEN, SO THERE IS NOTHING TO VERIFY.
   * ══════════════════════════════════════════════════════════════════
   * `setTenantFlag` is the enforcement point for
   * `entitlement.override_paid` and holds the write itself when the
   * workspace is a paying one. Falling through to the verify step would
   * read the flag back, correctly find it unchanged, and write a history
   * row saying the change FAILED — turning a control that worked into an
   * error report.
   *
   * ⚠️ AND NO HISTORY ROW EITHER. `platform_entitlement_history` records
   * changes that happened; a queued request is recorded in the approval
   * queue and in the action log, which is where it belongs until
   * somebody agrees to it.
   */
  if (written.data.queued) {
    return {
      ok: true,
      data: { verified: false, queued: true, note: written.data.note },
    };
  }

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
  return { ok: true, data: { verified: verdict.ok, queued: false, note: verdict.note } };
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

  /**
   * 🔴 A REVERT ON A PAYING CUSTOMER IS HELD LIKE ANY OTHER CHANGE TO
   * WHAT THEY CAN USE, and no history row is written until it runs.
   *
   * ⚠️ THIS IS NOT THE "SWITCHING SOMETHING OFF IS NEVER BLOCKED" RULE
   * BEING BROKEN. That rule is about kill switches, where the moment you
   * most need to act is the moment a refusal is most expensive. An
   * `entitlement:` key is what the customer bought; taking it back is
   * the same commercial act as granting it, in the other direction. See
   * `entitlementOverrideIsHeld` for the full argument.
   */
  if (written.data.queued) {
    return { ok: true, data: { note: written.data.note } };
  }

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

/* ================================================================== */
/* ⑧ MAINTENANCE MODE — TURNING THE PRODUCT READ-ONLY, DELIBERATELY    */
/* ================================================================== */

/**
 * ⚠️ NOTHING BELOW ENFORCES ANYTHING. These are the doors that record a
 * decision; the refusal happens in `server/platform/maintenance.ts`, one
 * hop inside `assertImpersonationAllows()`, on the write itself. If you
 * are reading this file to find out whether a save is blocked, you are in
 * the wrong file — and that separation is the point.
 */

const maintenanceWindow = {
  /** ISO. Optional: "until somebody turns it off" is a legitimate window. */
  endsAt: z.string().datetime({ message: "Use an ISO timestamp." }).optional().nullable(),
  /**
   * The sentence the CUSTOMER reads. Optional, and empty is honest — a
   * placeholder written by us ("We are performing maintenance") says less
   * than nothing when the operator knows what actually broke.
   */
  message: z.string().max(400).optional(),
} as const;

const globalMaintenanceSchema = z.object({
  enabled: z.boolean(),
  /**
   * 🔴 TWENTY CHARACTERS, ENFORCED HERE AND NOT ONLY IN THE DIALOG. The
   * typed-confirmation dialog is a client component and a server action is
   * a POST to whatever URL the browser is on: treating "the dialog was
   * satisfied" as authorisation means the dialog is the security control.
   */
  reason: z.string().trim().min(20).max(2000),
  ...maintenanceWindow,
});

/**
 * ⭐⭐ GLOBAL READ-ONLY. Every workspace, at once.
 *
 * Recorded as an event in `platform_action_log` — see
 * `MAINTENANCE_LOG_RESOURCE` for why that is the store rather than a
 * settings row this batch is not allowed to create. `recordPlatformAudit`
 * writes through `withPlatformScope`, so the tenant-less RLS rule holds.
 */
export async function setGlobalMaintenance(
  input: unknown,
): Promise<PlatformResult<{ enabled: boolean }>> {
  // Tier-2 guard, one hop from the export. `tenants:configure` is the
  // grade that already changes plans and declares incidents; pausing the
  // fleet belongs in that company, not below it.
  const operator = await requireCapability("tenants:configure");

  const parsed = globalMaintenanceSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error:
        "A written reason of at least twenty characters is required. It is shown to whoever asks why the product stopped accepting changes.",
    };
  }
  const { enabled, reason, endsAt, message } = parsed.data;

  await recordPlatformAudit({
    operator,
    tenantId: null,
    action: "config_change",
    resourceType: MAINTENANCE_LOG_RESOURCE,
    resourceId: MAINTENANCE_LOG_RESOURCE_ID,
    reason,
    // 🔴 `critical` BOTH WAYS. Turning it off is as consequential as
    // turning it on — an operator who lifts a freeze early, during the
    // migration it was protecting, has done the more dangerous of the two.
    severity: "critical",
    metadata: {
      enabled,
      endsAt: endsAt ?? null,
      message: message ?? "",
    },
  });

  revalidatePath("/platform/maintenance");
  return { ok: true, data: { enabled } };
}

const tenantMaintenanceSchema = z.object({
  tenantId: z.string().uuid(),
  enabled: z.boolean(),
  reason: z.string().trim().min(20).max(2000),
  ...maintenanceWindow,
});

/**
 * ⭐ ONE WORKSPACE READ-ONLY.
 *
 * ⚠️ GOES THROUGH `setTenantFlag`, NOT AROUND IT. That function is the
 * enforcement point for the flag write itself — capability check, RLS
 * `WITH CHECK`, approval gate, audit — and a second writer straight into
 * `platform_tenant_flags` would be a hole in all four.
 */
export async function setTenantMaintenance(
  input: unknown,
): Promise<PlatformResult<{ enabled: boolean }>> {
  // Guard here too, even though `setTenantFlag` guards again: the gate
  // must be visible one hop from the export for `check-action-guards`,
  // and a reader must not have to follow a call to learn who may do this.
  await requireCapability("flags:write");

  const parsed = tenantMaintenanceSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error:
        "A written reason of at least twenty characters is required, and the workspace must be identified.",
    };
  }
  const { tenantId, enabled, reason, endsAt, message } = parsed.data;

  const result = await setTenantFlag({
    tenantId,
    flagKey: MAINTENANCE_FLAG_KEY,
    enabled,
    reason,
    // ⭐ THE FLAG'S OWN EXPIRY IS THE END OF THE WINDOW. Storing the end
    // time anywhere else would mean a window that has passed while the
    // flag is still enabled — and the flag is what the gate reads.
    expiresAt: endsAt ?? null,
    value: { message: message ?? "" },
  });

  if (!result.ok) return result;

  revalidatePath("/platform/maintenance");
  return { ok: true, data: { enabled } };
}

/**
 * Everything the console screen shows, in one call.
 *
 * ⚠️ INCLUDES WINDOWS WHOSE END TIME HAS PASSED, marked rather than
 * hidden. A flag still switched on with an expiry in the past is no
 * longer enforcing anything, and an operator who cannot see that row
 * cannot tidy it up — they can only be surprised by it later.
 */
export async function getMaintenanceOverview(): Promise<
  PlatformResult<{
    global: MaintenanceState | null;
    tenants: ReadonlyArray<{
      tenantId: string;
      tenantName: string;
      tenantSlug: string;
      state: MaintenanceState;
    }>;
  }>
> {
  await requireCapability("observatory:read");

  const global = await readGlobalMaintenance();

  const rows = await withPlatformScope(
    "Platform console: list workspaces currently in maintenance mode",
    async (db) =>
      db
        .select({
          tenantId: platformTenantFlags.tenantId,
          tenantName: tenants.name,
          tenantSlug: tenants.slug,
          enabled: platformTenantFlags.enabled,
          expiresAt: platformTenantFlags.expiresAt,
          value: platformTenantFlags.value,
          reason: platformTenantFlags.reason,
          createdAt: platformTenantFlags.createdAt,
          setByEmail: platformTenantFlags.setByEmail,
        })
        .from(platformTenantFlags)
        .innerJoin(tenants, eq(tenants.id, platformTenantFlags.tenantId))
        .where(
          and(
            eq(platformTenantFlags.flagKey, MAINTENANCE_FLAG_KEY),
            eq(platformTenantFlags.enabled, true),
          ),
        )
        .orderBy(desc(platformTenantFlags.updatedAt))
        .limit(200),
  );

  return {
    ok: true,
    data: {
      global,
      tenants: rows.map((r) => ({
        tenantId: r.tenantId,
        tenantName: r.tenantName,
        tenantSlug: r.tenantSlug,
        state: {
          scope: "tenant" as const,
          enabled: r.enabled,
          endsAt: r.expiresAt ? r.expiresAt.toISOString() : null,
          message:
            typeof (r.value as Record<string, unknown>)?.message === "string"
              ? String((r.value as Record<string, unknown>).message)
              : "",
          reason: r.reason,
          since: r.createdAt ? r.createdAt.toISOString() : null,
          setBy: r.setByEmail,
        },
      })),
    },
  };
}
