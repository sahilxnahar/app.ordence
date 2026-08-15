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
  enforcementReport,
  expiryFor,
  gradeAtLeast,
  justificationProblem,
  mayApprove,
  mayReject,
  needsApproval,
  type ApprovalKind,
  type PlatformGrade,
  type PolicyEnforcement,
} from "@/lib/platform/approvals";
import { recordPlatformAudit, requireCapability, type PlatformOperator } from "./guard";
import type { PlatformResult } from "@/lib/platform/schemas";

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

/* ================================================================== */
/* ⭐⭐⭐ WHAT IS ACTUALLY ENFORCED, AS OPPOSED TO WHAT IS LISTED       */
/* ================================================================== */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 SIX POLICIES WERE PUBLISHED. ONE WAS ENFORCED. THE SCREEN SAID
 *      NOTHING ABOUT THE DIFFERENCE.
 * ══════════════════════════════════════════════════════════════════════
 * `app/platform/approvals/page.tsx` mapped straight over
 * `APPROVAL_POLICIES` and printed all six under "What is held, and why".
 * Every sentence was accurate about the CONSTANT. One of the six was
 * accurate about the SYSTEM.
 *
 * ⚠️ A DEAD CONTROL IS WORSE THAN A MISSING ONE. A missing control
 * produces a question — "so what stops somebody terminating a workspace
 * by accident?" — and the question gets answered. A dead one answers it
 * first, wrongly, and it is never asked again. The auditor reads the
 * same screen and records the gap as covered.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ THE ONLY THING THIS FILE CONTRIBUTES IS THE LIVE REGISTRY
 * ══════════════════════════════════════════════════════════════════════
 * The rules — which kinds have a request path, why the others do not,
 * and how those two facts combine into "enforced" — live in
 * `lib/platform/approvals.ts` beside `mayApprove` and for the same
 * reason the header there gives: they can be tested without a database,
 * and the screen and the server cannot disagree about them.
 *
 * 🔴 WHAT CANNOT LIVE THERE IS WHICH EXECUTORS ARE REGISTERED. That is
 * a runtime fact about this process, and it is deliberately OBSERVED
 * rather than written down: the day somebody calls
 * `registerApprovalExecutor` for a new kind, the screen stops calling it
 * unwired with no second edit to remember. A hand-maintained copy of
 * this list is exactly the artefact that produced the original bug.
 */

/**
 * ⭐ THE GUARDED READ. `requireCapability` is on the export, in one
 * line, because this list names every dangerous operation the platform
 * can perform AND which of them are currently ungated — which is a map
 * for an attacker as much as a status board for an operator.
 */
export async function getApprovalEnforcement(): Promise<
  PlatformResult<readonly PolicyEnforcement[]>
> {
  await requireCapability("tenants:read");
  // ⚠️ READ AT REQUEST TIME, NOT AT MODULE LOAD. Executors register
  // themselves from `control-actions.ts` at import time, and a snapshot
  // taken while this module's own body was still evaluating would be
  // empty — the report would tell an operator nothing is enforced on
  // every cold boot, which is its own kind of lie.
  return { ok: true, data: enforcementReport([...EXECUTORS.keys()]) };
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

  /**
   * ══════════════════════════════════════════════════════════════════
   * 🔴 REFUSED AT REQUEST TIME, NOT AT APPROVAL TIME
   * ══════════════════════════════════════════════════════════════════
   * `decideApproval` already refuses to approve a row whose executor is
   * missing, and that check has to stay — a module can be removed while
   * a request for it is still queued. But it is the WRONG PLACE to
   * discover the problem for a kind that never had an executor at all.
   *
   * ⚠️ WITHOUT THIS THE SEQUENCE IS: an operator raises a request, is
   * told "nothing has happened yet, it is waiting for approval", waits,
   * finds an owner, the owner approves — and only then does anything
   * say that this build cannot carry it out. Two people have now spent
   * real time, the dangerous action is still not done, and the row sits
   * in `pending` looking like a backlog rather than a bug.
   *
   * 🔴 IT ALSO CLOSES THE ONE WAY THIS QUEUE COULD FAKE ENFORCEMENT.
   * A request path could be added for a policy with no executor, the
   * screen would fill with pending rows, and every one of them would be
   * theatre: the operation is not held pending approval, it is simply
   * never performed. Refusing here means a policy is either enforceable
   * end to end or visibly not offered, with no state in between.
   */
  if (!EXECUTORS.has(args.kind)) {
    return {
      queued: false,
      error:
        `Nothing in this build can carry out "${policy.label}", so there is no ` +
        `point holding a request for it — it would wait, be approved, and then ` +
        `refuse to run. Raise this with whoever owns the action rather than ` +
        `queueing it.`,
    };
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
  /**
   * ⚠️ ACCEPTED AND DELIBERATELY NOT TRUSTED. Kept on the signature so
   * the existing caller still typechecks, and overridden below by a
   * count taken from the request's own required grade — see the block
   * above `mayApprove`. A caller-supplied "am I alone" is a caller-
   * supplied authorisation decision, and this one was also wrong.
   */
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
    /**
     * ══════════════════════════════════════════════════════════════
     * 🔴 THE REJECT BRANCH USED TO CHECK NOTHING AT ALL
     * ══════════════════════════════════════════════════════════════
     * It sat ABOVE `mayApprove` and applied no status test and no
     * grade test, while its caller is gated on `tenants:read` — which
     * `support` holds. Three consequences, all real:
     *
     *   ① A support-grade account could reject every pending owner
     *      request. That is a denial of control during an incident,
     *      from the grade the code itself calls the most phished.
     *   ② A row already `executed` could be flipped to `rejected`,
     *      overwriting `approver_id`, `decided_at` and
     *      `decision_note`. The record of who authorised a suspension
     *      that actually ran was destructible from the console.
     *   ③ A requester rejecting their own request violated
     *      `platform_approval_not_self` and surfaced as a 500.
     *
     * ⚠️ WITHDRAWAL IS NOT REJECTION. Pulling your own request is a
     * different fact from a second operator refusing it, so it leaves
     * `approver_id` NULL — which is also what the CHECK constraint
     * permits — and says so in the note.
     */
    const rejection = mayReject({
      kind: row.actionKind,
      requestedBy: row.requestedBy,
      approverId: args.approver.staff.id,
      approverGrade: args.approverGrade,
      status: row.status,
    });

    if (!rejection.allowed) return { ok: false, error: rejection.reason };

    await withPlatformScope(
      `Platform console: ${rejection.withdrawal ? "withdraw" : "reject"} approval request ${args.requestId}`,
      async (db) => {
        await db
          .update(platformApprovalQueue)
          .set({
            status: "rejected",
            approverId: rejection.withdrawal ? null : args.approver.staff.id,
            decidedAt: args.now,
            decisionNote: rejection.withdrawal
              ? `Withdrawn by the operator who raised it. ${args.note}`
              : args.note,
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
      reason: `${rejection.withdrawal ? "Withdrawn" : "Rejected"} ${row.actionKind} on ${row.targetLabel}: ${args.note.slice(0, 200)}`,
      metadata: {
        approvalKind: row.actionKind,
        stage: rejection.withdrawal ? "withdrawn" : "rejected",
      },
      severity: "notice",
    });

    return {
      ok: true,
      executed: false,
      note: rejection.withdrawal
        ? "Withdrawn. Nothing was changed."
        : "Rejected. Nothing was changed.",
    };
  }

  /**
   * ══════════════════════════════════════════════════════════════════
   * 🔴🔴 `soleOperator` IS RECOMPUTED HERE AND THE CALLER'S ANSWER IS
   *      IGNORED, BECAUSE THE CALLER'S ANSWER DEADLOCKS THE QUEUE
   * ══════════════════════════════════════════════════════════════════
   * `decideRequest` passes `countActiveOperators() <= 1`. That counts
   * every usable platform grant, of any grade. Every policy in
   * `APPROVAL_POLICIES` needs `owner` to approve.
   *
   * ⚠️ SO THE DAY THE FIRST SUPPORT ENGINEER IS GRANTED ACCESS, a
   * platform with exactly one owner reaches this state:
   *
   *   · the count is 2, so `soleOperator` is false, so the owner who
   *     raised the request is refused with "there is another operator
   *     who can approve it";
   *   · that other operator is `support`, and `mayApprove` refuses them
   *     on grade.
   *
   * 🔴 NOBODY CAN APPROVE ANYTHING. Every suspension request expires
   * unapproved, four hours at a time, and the visible symptom is a
   * refusal sentence that names an operator who cannot help. The
   * predictable response is the one this whole mechanism was designed to
   * avoid: somebody comments the queue out and suspends directly.
   *
   * ⭐ THE HONEST QUESTION IS "IS THERE SOMEBODY ELSE I COULD ASK", and
   * that means an active grant, at or above THIS policy's approver
   * grade, belonging to somebody who is not the requester. Anything
   * looser either opens the self-approval hatch when a real second pair
   * of eyes exists — the failure that matters — or shuts it when none
   * does.
   *
   * ⚠️ COMPUTED FROM THE ROW, NOT FROM THE SESSION, so it is the same
   * answer whoever is looking. `listPending` hands the identical number
   * to the screen for exactly that reason.
   */
  const policyForRow = POLICY_BY_KIND[row.actionKind];
  const otherEligible = policyForRow
    ? await countEligibleApprovers(policyForRow.approverGrade, row.requestedBy)
    : 0;

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
    soleOperator: otherEligible === 0,
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
  const rows = await withPlatformScope("Platform console: approval queue", async (db) => {
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

  /**
   * ⭐⭐ THE SCREEN GETS THE SAME NUMBER THE SERVER WILL USE.
   *
   * ⚠️ `getApprovalQueue` returns ONE `soleOperator` for the whole list,
   * derived from `countActiveOperators()`. That is wrong twice over: it
   * ignores grade (see the long note in `decideApproval`) and it ignores
   * WHO RAISED EACH ROW, which is the other half of the question. Two
   * rows raised by two different people do not have the same answer, and
   * a single flag cannot carry both.
   *
   * 🔴 A SCREEN THAT PREDICTS A DIFFERENT VERDICT FROM THE SERVER IS THE
   * FAILURE THIS COMPONENT WAS BUILT TO AVOID — `approval-queue.tsx`
   * runs `mayApprove` locally purely so the refusal is printed before
   * the click. Feed it a different `soleOperator` and it prints a
   * sentence the server does not agree with, which reads as a bug and
   * gets routed around.
   *
   * ⚠️ ONE QUERY, NOT ONE PER ROW. The grants are read once and each row
   * is scored against them in memory; a hundred queued rows must not be
   * a hundred round trips on a screen somebody opens during an incident.
   */
  const grants = await activePlatformGrants();

  return rows.map((row) => {
    const policy = POLICY_BY_KIND[row.actionKind];
    return {
      ...row,
      otherEligibleApprovers: policy
        ? grants.filter(
            (g) => g.id !== row.requestedBy && gradeAtLeast(g.grade, policy.approverGrade),
          ).length
        : 0,
    };
  });
}

/**
 * ⚠️ THE THREE COLUMNS TOGETHER, exactly as `countActiveOperators` reads
 * them, because a grant that is `active` with `expires_at` in the past is
 * not somebody you can ask to approve anything — and the two functions
 * disagreeing about what "usable" means would be worse than either being
 * wrong on its own.
 *
 * ⭐ THE GRADE IS RETURNED RATHER THAN COMPARED IN SQL. Ranking grades in
 * Postgres means either an ordered enum this schema does not have or a
 * CASE expression that is a second copy of `GRADE_RANK`. `gradeAtLeast`
 * is already the one definition the screen and the server share, so the
 * comparison stays in TypeScript where there is exactly one of it.
 */
async function activePlatformGrants(): Promise<
  ReadonlyArray<{ id: string; grade: PlatformGrade }>
> {
  return withPlatformScope("Platform console: usable platform grants", async (db) => {
    const result = await db.execute(sql`
      SELECT id::text AS id, grade::text AS grade
        FROM platform_staff
       WHERE status = 'active'
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > now())
    `);
    const raw = (Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows) ?? [];
    return (raw as Array<{ id?: string; grade?: string }>)
      .filter((r): r is { id: string; grade: string } => Boolean(r.id && r.grade))
      .map((r) => ({ id: r.id, grade: r.grade as PlatformGrade }));
  });
}

/**
 * ⭐ "IS THERE SOMEBODY ELSE I COULD ASK?" — the only question the
 * self-approval hatch actually turns on.
 *
 * ⚠️ `excludeStaffId` IS THE REQUESTER, NEVER THE APPROVER. Excluding
 * whoever happens to be looking would make the answer depend on who
 * opened the screen, and a lone owner would see the hatch open for their
 * colleague's request — which is not self-approval at all, it is a
 * second pair of eyes, and it must not be flagged as one or the other by
 * accident.
 */
export async function countEligibleApprovers(
  requiredGrade: PlatformGrade,
  excludeStaffId: string,
): Promise<number> {
  const grants = await activePlatformGrants();
  return grants.filter(
    (g) => g.id !== excludeStaffId && gradeAtLeast(g.grade, requiredGrade),
  ).length;
}

/**
 * ⚠️ Used to decide whether the self-approval hatch is open at all.
 *
 * 🔴 THIS QUERIED `WHERE is_active`, A COLUMN THAT HAS NEVER EXISTED.
 * `platform_staff` carries `status`, `expires_at` and `revoked_at`. The
 * statement threw, and because `getApprovalQueue` and `decideRequest`
 * both call this FIRST, the entire approvals screen rendered an error
 * card and no request could ever be approved or rejected. The four-eyes
 * control was not weak; it was inoperable, which is also why every
 * dangerous operation had grown a direct path around it.
 *
 * ⚠️ ALL THREE COLUMNS, TOGETHER. `status` alone is what
 * `evaluatePlatformAccess` reads, and a row that is `active` with an
 * expiry in the past is not somebody you can ask to approve anything.
 */
export async function countActiveOperators(): Promise<number> {
  return withPlatformScope("Platform console: operator count", async (db) => {
    const rows = await db.execute(sql`
      SELECT count(*)::int AS n
        FROM platform_staff
       WHERE status = 'active'
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > now())
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
