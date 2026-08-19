import "server-only";

/**
 * Ordence — Workflow Gate Composition
 * Version: v0.23.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE SAME FOUR GATES AS PHASE 22, PLUS A FIFTH THAT ONLY EXISTS HERE
 * ══════════════════════════════════════════════════════════════════════
 *   1. ACCESS      — may this workspace write at all?
 *   2. ENTITLEMENT — has it paid for automation?
 *   3. PERMISSION  — may this PERSON do it?
 *   4. Tenant isolation — the database, unconditionally.
 *   5. ⭐ ACTOR PERMISSION — may the person the RUN IS ACTING AS do the
 *      thing this step is about to do?
 *
 * Gates 1–3 are about the person clicking. Gate 5 is about the person a
 * run borrowed, which is frequently somebody else and sometimes somebody
 * who left the company. It is the one that stops a workflow being a
 * privilege-escalation device, and it is checked per STEP rather than per
 * request — see `authoriseActor` below.
 *
 * ⚠️ THIS FILE IS NOT `"use server"`. It exports types and non-async
 * helpers, and a `"use server"` file that exports anything but async
 * functions publishes them as RPC endpoints. Six schemas were found doing
 * exactly that in Phase 7.
 */

import { z } from "zod";
import {
  requireTenantContext,
  TenantAccessError,
  type TenantContext,
} from "@/server/tenant-context";
import { requireAccess, AccessRestrictedError } from "@/server/billing/access";
import {
  assertImpersonationAllows,
  ImpersonationForbiddenError,
} from "@/server/platform/impersonation";
import { requireFeature, FeatureLockedError } from "@/server/entitlements";
import { evaluatePermission, PermissionDeniedError } from "@/lib/permissions";
import type { FeatureKey } from "@/lib/entitlements/features";
import type { ActionResult } from "@/lib/validators/crm";
import type { SystemRole } from "@/db/schema/core";
import type { PermissionKey } from "@/db/schema/auth";

/**
 * Run the three application gates and return the tenant context.
 *
 * ⚠️ WRITE SITES ONLY. A gate on a `get*` function produces the worst
 * upgrade prompt in the product: a page that will not render at all
 * rather than a page that renders and refuses the button. Reads use
 * `requirePermission` alone.
 */
export async function guardWorkflowWrite(args: {
  operation: string;
  feature: FeatureKey;
  permission: PermissionKey;
  resource?: { type?: string; id?: string };
  /**
   * Override the key the IMPERSONATION policy is evaluated against.
   *
   * ⚠️ Needed because the two vocabularies do not line up. The access
   * gate reads `"dynamicRecords:delete"`; the forbidden list is keyed
   * on prefixes like `"delete:"`, because it is a statement about what
   * an operation DOES rather than about which module it lives in.
   * Destructive call sites pass the policy key explicitly; everything
   * else falls through to `operation` and is judged by scope alone.
   */
  impersonationOperation?: string;
}): Promise<TenantContext> {
  const ctx = await requireTenantContext();

  await requireAccess(args.operation, ctx);
  await requireFeature(args.feature, ctx);

  const { requirePermission } = await import("@/server/audit");
  const granted = await requirePermission(args.permission, args.resource);

  /* --- 4. ⭐ IS SOMEBODY WEARING THE CUSTOMER'S FACE? ------------- */
  //
  // LAST, and deliberately so. The first three gates answer questions
  // about the WORKSPACE and the PERSON; this one answers a question
  // about the REQUEST — is this our own support staff, inside a
  // consented session, and is this one of the things a session may
  // never do? A read-only session refuses every write here; a
  // read-write one still refuses the forbidden list in
  // `lib/platform/impersonation-policy.ts`.
  //
  // ⚠️ `granted` IS PASSED, so this costs nothing on the ordinary
  // path: the context already carries `impersonationId: null` and the
  // gate returns without touching Clerk or the database.
  await assertImpersonationAllows(
    args.impersonationOperation ?? args.operation,
    granted,
  );

  return granted;
}

/* ------------------------------------------------------------------ */
/* ⭐ GATE 5 — THE ACTOR                                               */
/* ------------------------------------------------------------------ */

export type RunActor = {
  userId: string;
  role: SystemRole;
  overrides: Record<string, boolean> | null;
  /** `active` — anything else and the run stops. */
  status: string;
};

export class ActorDeniedError extends Error {
  constructor(
    readonly permission: string,
    readonly actorId: string,
    message: string,
  ) {
    super(message);
    this.name = "ActorDeniedError";
  }
}

/**
 * May the identity this run is acting as perform `permission`?
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE FUNCTION THAT STOPS A WORKFLOW BEING A PRIVILEGE ESCALATION
 * ══════════════════════════════════════════════════════════════════════
 * The convenient design is for the engine to hold broad rights and
 * execute whatever the definition says. It is convenient because
 * workflows then never fail with "permission denied", which reads like a
 * feature. What it actually is:
 *
 *   A sales executive with `leads:read` and no `leads:delete` writes a
 *   workflow whose action is "delete every lead older than a year". The
 *   engine has the right. The executive does not. The leads are gone.
 *
 * So every step is checked here, against the SAME `evaluatePermission`
 * the server actions use — one answer to "may this person do this", not
 * two that can drift.
 *
 * ⚠️ THE ROLE IS RE-READ ON EVERY RUN, NEVER SNAPSHOTTED ON THE VERSION.
 * A snapshot means somebody who has left the company keeps acting through
 * the automations they left behind, which is the exact scenario an
 * offboarding process exists to close. `workflow_runs.actor_role` records
 * what the role WAS for the history; the decision uses what it IS.
 *
 * ⚠️ A SUSPENDED USER AUTHORISES NOTHING. Checked before the permission,
 * because a suspended admin still has an admin's role.
 */
export function authoriseActor(actor: RunActor, permission: string): void {
  if (actor.status !== "active") {
    throw new ActorDeniedError(
      permission,
      actor.userId,
      `This automation runs as a user whose account is ${actor.status}. It will ` +
        `not act on their behalf. Publish it again as somebody who still works ` +
        `here, or switch it off.`,
    );
  }

  const decision = evaluatePermission(
    { role: actor.role, overrides: actor.overrides },
    permission,
  );

  if (!decision.allowed) {
    throw new ActorDeniedError(
      permission,
      actor.userId,
      `This automation runs as a user who does not have permission to ` +
        `${permission}. A workflow can never do more than the person it acts ` +
        `as — that is deliberate. Either grant them the permission, or have ` +
        `somebody who holds it publish the workflow.`,
    );
  }
}

/** Non-throwing form, for the builder's "this will not work" hints. */
export function actorCan(actor: RunActor, permission: string): boolean {
  if (actor.status !== "active") return false;
  return evaluatePermission({ role: actor.role, overrides: actor.overrides }, permission)
    .allowed;
}

/* ------------------------------------------------------------------ */
/* ERROR TRANSLATION                                                   */
/* ------------------------------------------------------------------ */

export function workflowFail(
  error: string,
  fieldErrors?: Record<string, string[]>,
): ActionResult<never> {
  return { ok: false, error, fieldErrors };
}

/**
 * Turn anything thrown into a safe, useful envelope.
 *
 * ⚠️ THE TRIGGER MESSAGES ARE PASSED THROUGH, NOT REPLACED.
 *
 * The loop guard and the immutability guard both raise sentences written
 * for a person — "this workflow already ran earlier in the chain of
 * events that led here". Replacing that with "something went wrong" would
 * throw away the only explanation of a failure mode nobody understands on
 * first encounter.
 */
export function toWorkflowActionError(err: unknown, scope: string): ActionResult<never> {
  if (err instanceof TenantAccessError) return workflowFail(err.message);
  if (err instanceof AccessRestrictedError) return workflowFail(err.message);
  if (err instanceof FeatureLockedError) return workflowFail(err.message);
  if (err instanceof PermissionDeniedError) return workflowFail(err.message);
  // ⚠️ The refusal carries the RULE, in a sentence written for the
  // operator: "this session is read-only", "role changes would
  // survive the session". A support engineer who is refused with
  // "something went wrong" concludes the product is broken and
  // reaches for a database client, which is the outcome the whole
  // impersonation system exists to avoid.
  if (err instanceof ImpersonationForbiddenError) return workflowFail(err.message);
  if (err instanceof ActorDeniedError) return workflowFail(err.message);

  if (err instanceof z.ZodError) {
    return workflowFail(
      "Please check the form.",
      err.flatten().fieldErrors as Record<string, string[]>,
    );
  }

  const pg = asPgError(err);

  if (pg?.code === "23505") {
    if (pg.constraint?.includes("workflows_key_tenant_unique")) {
      return workflowFail("A workflow with that key already exists.");
    }
    if (pg.constraint?.includes("workflow_versions_one_active")) {
      return workflowFail(
        "This workflow already has a live version. Publishing archives the old " +
          "one — refresh the page and try again.",
      );
    }
    if (pg.constraint?.includes("workflow_tasks_one_pending")) {
      return workflowFail("There is already an open request for this step.");
    }
    return workflowFail("That record already exists.");
  }

  if (pg?.code === "23514" || pg?.code === "42501") {
    // The loop guard, the immutability guard, the finality guard and the
    // answered-once guard all land here, and every one of them raises a
    // sentence that explains itself.
    if (pg.message) return workflowFail(stripPgNoise(pg.message));
    return workflowFail("That change is not allowed.");
  }

  if (pg?.code === "23503") {
    return workflowFail(
      "Something this refers to no longer exists. Refresh the page and try again.",
    );
  }

  console.error(`[workflows:${scope}]`, err);
  return workflowFail("Something went wrong. Please try again.");
}

type PgErrorShape = { code?: string; constraint?: string; message?: string };

function asPgError(err: unknown): PgErrorShape | null {
  if (typeof err !== "object" || err === null) return null;
  const candidate = err as Record<string, unknown>;
  const code = typeof candidate.code === "string" ? candidate.code : undefined;
  if (!code) return null;
  return {
    code,
    constraint: typeof candidate.constraint === "string" ? candidate.constraint : undefined,
    message: typeof candidate.message === "string" ? candidate.message : undefined,
  };
}

function stripPgNoise(message: string): string {
  return message
    .replace(/^error:\s*/i, "")
    .replace(/\s*CONTEXT:[\s\S]*$/i, "")
    .trim();
}
