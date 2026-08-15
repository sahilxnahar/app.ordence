import "server-only";

/**
 * Ordence — Runtime Object Gate Composition
 * Version: v0.24.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE SAME FOUR GATES AS PHASE 22 AND 23
 * ══════════════════════════════════════════════════════════════════════
 *   1. ACCESS      — may this workspace write at all?
 *   2. ENTITLEMENT — has it paid for custom record types?
 *   3. PERMISSION  — may this PERSON do it?
 *   4. Tenant isolation — the database, unconditionally.
 *
 * ⚠️ AND IN THAT ORDER, BROADEST REASON OUTERMOST. A workspace owner on
 * Basic who is told "you do not have permission" is being sent to ask an
 * administrator who is themselves. The true answer is "your plan does not
 * include this", and it is aimed at a different person entirely — the one
 * holding the credit card.
 *
 * ⚠️ READS ARE `requirePermission` ALONE. A workspace whose plan lapsed
 * must still be able to SEE the records it already created — a downgrade
 * that makes existing customer data unreadable is a hostage situation,
 * not a paywall. Only DEFINING and WRITING are entitlement-gated.
 *
 * ⚠️ THIS FILE IS NOT `"use server"`. It exports types and non-async
 * helpers, and a `"use server"` file that exports anything but async
 * functions publishes them as RPC endpoints.
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
import { PermissionDeniedError } from "@/lib/permissions";
import { IdentifierError } from "@/lib/dynamic/identifiers";
import { DdlPlanError } from "@/lib/dynamic/ddl";
import type { FeatureKey } from "@/lib/entitlements/features";
import type { ActionResult } from "@/lib/validators/crm";
import type { PermissionKey } from "@/db/schema/auth";

/**
 * The one feature key this phase gates on.
 *
 * ⚠️ DELIBERATELY THE SAME KEY THE JSONB ENGINE USED. A customer who
 * bought "Custom records" bought the capability, not the storage
 * strategy. Introducing `crm.dynamic_objects` would mean an existing
 * Advanced customer losing a feature they already paid for on the day we
 * shipped a better implementation of it.
 */
export const DYNAMIC_FEATURE: FeatureKey = "crm.custom_objects";

/**
 * Run the three application gates and return the tenant context.
 *
 * ⚠️ WRITE SITES ONLY. A gate on a `get*` function produces the worst
 * upgrade prompt in the product: a page that will not render at all
 * rather than a page that renders and refuses the button.
 */
export async function guardDynamicWrite(args: {
  operation: string;
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
  await requireFeature(DYNAMIC_FEATURE, ctx);

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
/* ERROR TRANSLATION                                                   */
/* ------------------------------------------------------------------ */

export function dynamicFail(
  error: string,
  fieldErrors?: Record<string, string[]>,
): ActionResult<never> {
  return { ok: false, error, fieldErrors };
}

/**
 * Turn anything thrown into a safe, useful envelope.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE DDL ERRORS ARE PASSED THROUGH. THE PLUMBING ERRORS ARE NOT.
 * ══════════════════════════════════════════════════════════════════════
 * Every message raised by `dynamic_assert_identifier`,
 * `dynamic_create_object_table` and their siblings is a sentence written
 * for a person: "names must match ^[a-z][a-z0-9_]*$", "this record type
 * already has 12 records, so a required field cannot be added". Replacing
 * those with "something went wrong" would throw away the only explanation
 * of rules nobody understands on first encounter.
 *
 * ⚠️ BUT NOT EVERY POSTGRES ERROR IS SAFE TO SHOW. A raw DDL failure can
 * contain a physical table name belonging to this tenant (harmless) or a
 * constraint name that reveals another tenant's object (not). So only the
 * SQLSTATEs this engine raises deliberately are forwarded, and everything
 * else is logged and generalised.
 *
 * The forwarded set:
 *   42602 invalid_name              — the identifier gate
 *   42501 insufficient_privilege    — the tenant/prefix/allowlist refusals
 *   23514 check_violation           — caps, the drop confirmation, NOT NULL
 *   42P01 undefined_table           — "that record type does not exist"
 *   42701 duplicate_column          — "already has a field called…"
 *   42704 undefined_object          — an unknown field type
 *   42809 wrong_object_type         — a relation on a non-relation field
 */
const FORWARDED_SQLSTATES = new Set([
  "42602",
  "42501",
  "23514",
  "42P01",
  "42701",
  "42704",
  "42809",
]);

export function toDynamicActionError(err: unknown, scope: string): ActionResult<never> {
  if (err instanceof TenantAccessError) return dynamicFail(err.message);
  if (err instanceof AccessRestrictedError) return dynamicFail(err.message);
  if (err instanceof FeatureLockedError) return dynamicFail(err.message);
  if (err instanceof PermissionDeniedError) return dynamicFail(err.message);
  // ⚠️ The refusal carries the RULE, in a sentence written for the
  // operator: "this session is read-only", "role changes would
  // survive the session". A support engineer who is refused with
  // "something went wrong" concludes the product is broken and
  // reaches for a database client, which is the outcome the whole
  // impersonation system exists to avoid.
  if (err instanceof ImpersonationForbiddenError) return dynamicFail(err.message);

  // ⭐ The two families this phase raises from pure code. Both carry a
  // sentence naming the remedy, and both are field-scoped where they can
  // be, so the form highlights the box that is wrong.
  if (err instanceof IdentifierError) {
    return dynamicFail(err.message, { [err.kind === "object" ? "apiName" : "field"]: [err.message] });
  }
  if (err instanceof DdlPlanError) {
    return dynamicFail(err.message, err.field ? { [err.field]: [err.message] } : undefined);
  }

  if (err instanceof z.ZodError) {
    return dynamicFail(
      "Please check the form.",
      err.flatten().fieldErrors as Record<string, string[]>,
    );
  }

  const pg = asPgError(err);

  if (pg?.code === "23505") {
    if (pg.constraint?.includes("dynamic_objects_api_name_unique")) {
      return dynamicFail("A record type with that name already exists.");
    }
    if (pg.constraint?.includes("dynamic_objects_physical_unique")) {
      // Should be impossible — the physical name carries a random
      // discriminator. If it happens, the metadata and the catalogue have
      // got out of step and a human needs to look.
      return dynamicFail(
        "That record type could not be created because its table name is " +
          "already taken. This should not be possible; please report it.",
      );
    }
    if (pg.constraint?.includes("dynamic_fields_object_name_unique")) {
      return dynamicFail("This record type already has a field with that name.");
    }
    return dynamicFail("That already exists.");
  }

  if (pg?.code === "23503") {
    return dynamicFail(
      "Something this refers to no longer exists, or belongs to another " +
        "workspace. Refresh the page and try again.",
    );
  }

  if (pg?.code && FORWARDED_SQLSTATES.has(pg.code) && pg.message) {
    return dynamicFail(stripPgNoise(pg.message));
  }

  console.error(`[dynamic:${scope}]`, err);
  return dynamicFail("Something went wrong. Please try again.");
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
