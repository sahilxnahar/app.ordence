import "server-only";

/**
 * Ordence — ⭐⭐⭐ THE APPROVAL QUEUE
 * Version: v1.22.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 A WRAPPER, NOT A REWRITE
 * ══════════════════════════════════════════════════════════════════════
 * `suspendTenant`, `setTenantFlag` and the rest already exist, already
 * work, and already write to the action log. Nothing about them changes.
 *
 * ⚠️ THE ONLY DIFFERENCE IS WHEN THEY RUN. A gated action is intercepted
 * before execution, its validated arguments are written to a queue row,
 * and the operator is told it is waiting. On approval the identical
 * function is called with the identical arguments.
 *
 * ⭐ THAT IS WHAT KEEPS THIS ONE SESSION RATHER THAN A REFACTOR, and it
 * is also what keeps the queue honest: there is no second code path that
 * could drift from the first.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE EXECUTOR REGISTRY IS THE ONE THING TO GET RIGHT
 * ══════════════════════════════════════════════════════════════════════
 * An approved row has to be turned back into a function call. The naive
 * shape is a `switch` on `action_kind` inside this file, which means the
 * queue imports every action module and becomes the thing everything
 * depends on.
 *
 * ⚠️ SO EXECUTORS REGISTER THEMSELVES. The queue knows a kind, a
 * validator and a callback; it does not know what suspension means.
 */

import { and, desc, eq, lt, sql } from "drizzle-orm";
import { withPlatformScope } from "@/db";
import { platformApprovalQueue } from "@/db/schema/platform-control";
import { tenants } from "@/db/schema/core";
import {
  POLICY_BY_KIND,
  expiryFor,
  justificationProblem,
  mayApprove,
  needsApproval,
  type ApprovalKind,
  type PlatformGrade,
} from "@/lib/platform/approvals";
import { recordPlatformAudit, type PlatformOperator } from "./guard";

/* ------------------------------------------------------------------ */
/* THE REGISTRY                                                        */
/* ------------------------------------------------------------------ */

export type ApprovalExecutor = (payload: unknown) => Promise<
  { ok: true } | { ok: false; error: string }
>;

const EXECUTORS = new Map<string, ApprovalExecutor>();

/**
 * ⭐ CALLED BY THE ACTION MODULE THAT OWNS THE OPERATION, at import time.
 *
 * ⚠️ AN APPROVED ROW WHOSE EXECUTOR IS NOT REGISTERED CANNOT RUN, and
 * that is a deliberate failure rather than a silent one: it means a
 * module was removed while a request for it was still queued, and
 * running a half-remembered version would be worse than refusing.
 */
export function registerApprovalExecutor(
  kind: ApprovalKind,
  executor: ApprovalExecutor,
): void {
  EXECUTORS.set(kind, executor);
}

/* ------------------------------------------------------------------ */
/* REQUEST                                                             */
/* ------------------------------------------------------------------ */

export type QueueOutcome =
  | { queued: true; requestId: string; note: string }
  | { queued: false; error: string };

export async function queueForApproval(args: {
  readonly kind: ApprovalKind;
  readonly operator: PlatformOperator;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly targetLabel: string;
  readonly justification: string;
  readonly proposedBefore?: Record<string, unknown> | null;
  readonly proposedAfter?: Record<string, unknown>;
  readonly payload: Record<string, unknown>;
  readonly now: Date;
}): Promise<QueueOutcome> {
  const policy = POLICY_BY_KIND[args.kind];
  if (!policy) {
    return { queued: false, error: "This action does not go through the queue." };
  }

  const problem = justificationProblem(args.justification);
  if (problem) return { queued: false, error: problem };

  const id = await withPlatformScope(
    `Platform console: queue ${args.kind} for ${args.targetLabel}`,
    async (db) => {
      const [row] = await db
        .insert(platformApprovalQueue)
        .values({
          actionKind: args.kind,
          targetType: args.targetType,
          targetId: args.targetId,
          targetLabel: args.targetLabel,
          proposedBefore: args.proposedBefore ?? null,
          proposedAfter: args.proposedAfter ?? {},
          payload: args.payload,
          requestedBy: args.operator.staff.id,
          requestedAt: args.now,
          justification: args.justification.trim(),
          requiredGrade: policy.approverGrade,
          expiresAt: expiryFor(args.kind, args.now),
        })
        .returning({ id: platformApprovalQueue.id });
      return row?.id ?? null;
    },
  );

  if (!id) return { queued: false, error: "The request could not be recorded." };

  await recordPlatformAudit({
    operator: args.operator,
    // ⚠️ TENANT-ATTRIBUTED WHERE THERE IS A TENANT. The guard's own
    // header makes the argument: everything we do TO a customer should
    // be something they can see us doing, and a queued request against
    // their workspace is something we did.
    tenantId: args.targetType === "tenant" ? args.targetId : null,
    action: "config_change",
    resourceType: args.targetType,
    resourceId: args.targetId,
    reason: `${policy.label} requested for ${args.targetLabel}: ${args.justification.trim().slice(0, 200)}`,
    metadata: { approvalKind: args.kind, stage: "requested" },
    severity: "notice",
  });

  return {
    queued: true,
    requestId: id,
    // ⭐ SAID PLAINLY, INCLUDING WHY. An operator who is refused without
    // a reason concludes the tool is broken and looks for a way round it.
    note: `Nothing has happened yet. ${policy.label} is waiting for approval, because: ${policy.because} The request expires in ${policy.expiryHours} hour${policy.expiryHours === 1 ? "" : "s"}.`,
  };
}

/* ------------------------------------------------------------------ */
/* DECIDE                                                              */
/* ------------------------------------------------------------------ */

export type DecisionOutcome =
  | { ok: true; executed: boolean; note: string }
  | { ok: false; error: string };

export async function decideApproval(args: {
  readonly requestId: string;
  readonly approver: PlatformOperator;
  readonly approverGrade: PlatformGrade;
  readonly approve: boolean;
  readonly note: string;
  readonly soleOperator: boolean;
  readonly now: Date;
}): Promise<DecisionOutcome> {
  const row = await withPlatformScope(
    `Platform console: read approval request ${args.requestId}`,
    async (db) => {
      const [r] = await db
        .select()
        .from(platformApprovalQueue)
        .where(eq(platformApprovalQueue.id, args.requestId))
        .limit(1);
      return r ?? null;
    },
  );

  if (!row) return { ok: false, error: "No such request." };

  if (!args.approve) {
    await withPlatformScope(
      `Platform console: reject approval request ${args.requestId}`,
      async (db) => {
        await db
          .update(platformApprovalQueue)
          .set({
            status: "rejected",
            approverId: args.approver.staff.id,
            decidedAt: args.now,
            decisionNote: args.note,
          })
          .where(eq(platformApprovalQueue.id, args.requestId));
      },
    );

    await recordPlatformAudit({
      operator: args.approver,
      tenantId: row.targetType === "tenant" ? row.targetId : null,
      action: "config_change",
      resourceType: row.targetType,
      resourceId: row.targetId,
      reason: `Rejected ${row.actionKind} on ${row.targetLabel}: ${args.note.slice(0, 200)}`,
      metadata: { approvalKind: row.actionKind, stage: "rejected" },
      severity: "notice",
    });

    return { ok: true, executed: false, note: "Rejected. Nothing was changed." };
  }

  // 🔴 THE PURE VERDICT DECIDES. Self-approval, grade and expiry are all
  // in `lib/platform/approvals.ts` so they can be tested without a
  // database and so the screen and the server cannot disagree.
  const verdict = mayApprove({
    kind: row.actionKind,
    requestedBy: row.requestedBy,
    requestedAt: row.requestedAt,
    approverId: args.approver.staff.id,
    approverGrade: args.approverGrade,
    status: row.status,
    expiresAt: row.expiresAt,
    now: args.now,
    soleOperator: args.soleOperator,
  });

  if (!verdict.allowed) return { ok: false, error: verdict.reason };

  const executor = EXECUTORS.get(row.actionKind);
  if (!executor) {
    return {
      ok: false,
      error: `Nothing in this build knows how to carry out "${row.actionKind}". The request is left pending rather than marked done, because a half-remembered version of an action is worse than none.`,
    };
  }

  // ⚠️ MARKED APPROVED BEFORE EXECUTION, so a crash mid-execution leaves
  // evidence that it was attempted rather than a row that looks
  // untouched. `executed_at` is what says it finished.
  await withPlatformScope(
    `Platform console: approve request ${args.requestId}`,
    async (db) => {
      await db
        .update(platformApprovalQueue)
        .set({
          status: "approved",
          approverId: args.approver.staff.id,
          decidedAt: args.now,
          decisionNote: args.note,
          selfApproved: verdict.selfApproved,
        })
        .where(eq(platformApprovalQueue.id, args.requestId));
    },
  );

  const result = await executor(row.payload);

  await withPlatformScope(
    `Platform console: record execution of ${args.requestId}`,
    async (db) => {
      await db
        .update(platformApprovalQueue)
        .set(
          result.ok
            ? { status: "executed", executedAt: args.now }
            : { status: "failed", executionError: result.error.slice(0, 1000) },
        )
        .where(eq(platformApprovalQueue.id, args.requestId));
    },
  );

  await recordPlatformAudit({
    operator: args.approver,
    tenantId: row.targetType === "tenant" ? row.targetId : null,
    action: "config_change",
    resourceType: row.targetType,
    resourceId: row.targetId,
    reason: `${result.ok ? "Carried out" : "Failed"}: ${row.actionKind} on ${row.targetLabel}${verdict.selfApproved ? " (self-approved after the waiting period)" : ""}`,
    metadata: {
      approvalKind: row.actionKind,
      stage: result.ok ? "executed" : "failed",
      // 🔴 FLAGGED IN THE LOG AS WELL AS IN THE ROW, so an auditor
      // counting self-approvals does not have to join two tables.
      selfApproved: verdict.selfApproved,
    },
    severity: "critical",
  });

  if (!result.ok) {
    return {
      ok: false,
      error: `Approved, but it did not run: ${result.error}`,
    };
  }

  return {
    ok: true,
    executed: true,
    note: verdict.note ?? "Approved and carried out.",
  };
}

/* ------------------------------------------------------------------ */
/* READ                                                                */
/* ------------------------------------------------------------------ */

export async function listPending(now: Date) {
  return withPlatformScope("Platform console: approval queue", async (db) => {
    // ⭐ EXPIRE ON READ. A scheduled sweeper would be tidier and would
    // also mean a request could be approved in the window between
    // expiring and the sweep noticing.
    await db
      .update(platformApprovalQueue)
      .set({ status: "expired" })
      .where(
        and(
          eq(platformApprovalQueue.status, "pending"),
          lt(platformApprovalQueue.expiresAt, now),
        ),
      );

    return db
      .select()
      .from(platformApprovalQueue)
      .orderBy(desc(platformApprovalQueue.requestedAt))
      .limit(100);
  });
}

/** ⚠️ Used to decide whether the self-approval hatch is open at all. */
export async function countActiveOperators(): Promise<number> {
  return withPlatformScope("Platform console: operator count", async (db) => {
    const rows = await db.execute(sql`
      SELECT count(*)::int AS n FROM platform_staff WHERE is_active
    `);
    const first = (Array.isArray(rows) ? rows[0] : (rows as { rows?: unknown[] }).rows?.[0]) ?? {};
    return Number((first as { n?: number }).n ?? 1);
  });
}

export async function tenantLabel(tenantId: string): Promise<string> {
  return withPlatformScope("Platform console: tenant label", async (db) => {
    const [t] = await db
      .select({ name: tenants.name, slug: tenants.slug })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    return t ? `${t.name} (${t.slug})` : tenantId;
  });
}

export { needsApproval };
