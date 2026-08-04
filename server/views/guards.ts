import "server-only";

/**
 * Ordence — View Gate Composition
 * Version: v0.25.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE SAME FOUR GATES AS PHASES 22–24, PLUS A FIFTH THAT ONLY EXISTS HERE
 * ══════════════════════════════════════════════════════════════════════
 *   1. ACCESS      — may this workspace write at all?
 *   2. ENTITLEMENT — has it paid for saved views?
 *   3. PERMISSION  — may this PERSON do it?
 *   4. Tenant isolation — the database, unconditionally.
 *   5. ⭐ OBJECT ACCESS — may this person see the RECORD TYPE the view is
 *      over, and which of those records may they see?
 *
 * Gates 1–3 are about the view. Gate 5 is about the DATA BEHIND IT, and
 * it is the one that makes sharing safe.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ WHY GATE 5 IS A SEPARATE GATE AND NOT PART OF GATE 3
 * ══════════════════════════════════════════════════════════════════════
 * `views:read` answers "may you use saved views". It is a feature
 * permission and every role that has any list page has it.
 *
 * It says NOTHING about whether you may see bookings. And the whole risk
 * of this phase is that those two questions look like one question:
 *
 *     the sales director saves "All bookings this quarter"
 *       → shares it
 *       → an external contractor with `assets:read` and `views:read`
 *         opens their picker and clicks it
 *       → the server replays the saved query
 *       → the contractor reads the company's order book
 *
 * Every individual step is correct. The authorisation simply happened at
 * the wrong TIME (when the view was saved) against the wrong PERSON (its
 * author). Gate 5 moves it to the right one: `requireViewObjectAccess`
 * runs on every open, against the caller, and the `saved_views` row
 * contributes no authority at all.
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
import { PermissionDeniedError, type PermissionSubject } from "@/lib/permissions";
import {
  canReadObject,
  describeObjectDenial,
  resolveViewerScope,
  VIEW_PERMISSIONS,
} from "@/lib/views/access";
import { ViewPlanError, type ViewerScope } from "@/lib/views/planner";
import type { ViewObjectDefinition } from "@/lib/views/registry";
import type { FeatureKey } from "@/lib/entitlements/features";
import type { ActionResult } from "@/lib/validators/crm";

/* ------------------------------------------------------------------ */
/* GATES 1–3 — WRITES                                                  */
/* ------------------------------------------------------------------ */

/**
 * Run the three application gates and return the tenant context.
 *
 * ⚠️ WRITE SITES ONLY. A gate on a `get*` function produces the worst
 * upgrade prompt in the product: a page that will not render at all
 * rather than a page that renders and refuses the button. Reads use
 * `requirePermission` alone.
 */
export async function guardViewWrite(args: {
  operation: string;
  feature: FeatureKey;
  permission: string;
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
/* ⭐ GATE 5 — THE OBJECT BEHIND THE VIEW                               */
/* ------------------------------------------------------------------ */

export class ViewObjectDeniedError extends Error {
  constructor(
    readonly objectKey: string,
    message: string,
  ) {
    super(message);
    this.name = "ViewObjectDeniedError";
  }
}

/** The subject shape `lib/permissions.ts` decides from. */
export function subjectFor(ctx: TenantContext): PermissionSubject {
  return {
    role: ctx.role,
    // Per-user grants and revokes — the SAME field `server/audit.ts`
    // reads, so "may I" has one answer rather than two that can drift.
    //
    // `views:read_all_records` is the one that matters here: revoking it
    // narrows every view this person opens to the records they own,
    // including the ones they build themselves.
    overrides: ctx.user.permissionOverrides as Record<string, boolean> | null,
  };
}

/**
 * ⭐ May this caller open a view over this object, and with what scope?
 *
 * Called on EVERY read of EVERY view, saved or ad-hoc, shared or private.
 * Never cached against the view, never resolved once at save time.
 *
 * Returns the `ViewerScope` that `compileWhere` requires — so the only
 * way to obtain a scope is to have passed the gate, and the only way to
 * compile a query is to have a scope. Neither can be skipped by
 * forgetting a call; they can only be skipped by removing one, which is
 * a much more visible edit.
 */
export function requireViewObjectAccess(
  ctx: TenantContext,
  object: ViewObjectDefinition,
): ViewerScope {
  const subject = subjectFor(ctx);

  if (!canReadObject(subject, object)) {
    throw new ViewObjectDeniedError(object.key, describeObjectDenial(object));
  }

  return resolveViewerScope(subject, object, ctx.user.id, ctx.tenant.id);
}

/** Non-throwing form, for a picker that must hide rather than fail. */
export function canOpenObject(
  ctx: TenantContext,
  object: ViewObjectDefinition,
): boolean {
  return canReadObject(subjectFor(ctx), object);
}

export { VIEW_PERMISSIONS };

/* ------------------------------------------------------------------ */
/* ERROR TRANSLATION                                                   */
/* ------------------------------------------------------------------ */

export function viewFail(
  error: string,
  fieldErrors?: Record<string, string[]>,
): ActionResult<never> {
  return { ok: false, error, fieldErrors };
}

/**
 * Turn anything thrown into a safe, useful envelope.
 *
 * ⚠️ `ViewPlanError` MESSAGES ARE PASSED THROUGH, NOT REPLACED, and they
 * are written for a person: "Cannot sort by 'foo' — Lead has no such
 * field. It may have been removed since this view was saved." That is
 * the sentence that tells somebody how to fix a view that stopped working
 * after a schema change, and "something went wrong" throws it away.
 *
 * ⚠️ WHAT THEY NEVER CONTAIN IS THE LIST OF FIELDS THAT DO EXIST. A
 * caller probing an object they cannot read would otherwise get a schema
 * dump one guess at a time.
 */
export function toViewActionError(err: unknown, scope: string): ActionResult<never> {
  if (err instanceof TenantAccessError) return viewFail(err.message);
  if (err instanceof AccessRestrictedError) return viewFail(err.message);
  if (err instanceof FeatureLockedError) return viewFail(err.message);
  if (err instanceof PermissionDeniedError) return viewFail(err.message);
  // ⚠️ The refusal carries the RULE, in a sentence written for the
  // operator: "this session is read-only", "role changes would
  // survive the session". A support engineer who is refused with
  // "something went wrong" concludes the product is broken and
  // reaches for a database client, which is the outcome the whole
  // impersonation system exists to avoid.
  if (err instanceof ImpersonationForbiddenError) return viewFail(err.message);
  if (err instanceof ViewObjectDeniedError) return viewFail(err.message);
  if (err instanceof ViewPlanError) return viewFail(err.message);

  if (err instanceof z.ZodError) {
    return viewFail(
      "Please check the form.",
      err.flatten().fieldErrors as Record<string, string[]>,
    );
  }

  const pg = asPgError(err);

  if (pg?.code === "23505") {
    if (pg.constraint?.includes("saved_views_name_unique")) {
      return viewFail("You already have a view with that name on this record type.");
    }
    if (pg.constraint?.includes("saved_views_one_workspace_default")) {
      return viewFail(
        "Another view is already the workspace default for this record type. " +
          "Clear that one first — refresh the page and try again.",
      );
    }
    if (pg.constraint?.includes("saved_view_defaults_unique")) {
      return viewFail("You already have a default view for this record type.");
    }
    return viewFail("That view already exists.");
  }

  if (pg?.code === "23514" || pg?.code === "42501") {
    // The tenant cap, the sharing guard, the kanban/calendar shape checks
    // and the filter-size ceiling all land here, and every one of them
    // raises a sentence that explains itself.
    if (pg.message) return viewFail(stripPgNoise(pg.message));
    return viewFail("That change is not allowed.");
  }

  if (pg?.code === "23503") {
    return viewFail(
      "Something this view refers to no longer exists. Refresh the page and try again.",
    );
  }

  console.error(`[views:${scope}]`, err);
  return viewFail("Something went wrong. Please try again.");
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
