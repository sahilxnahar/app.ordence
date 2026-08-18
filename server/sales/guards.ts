import "server-only";

/**
 * Ordence — Sales Gate Composition
 * Version: v0.22.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * FOUR GATES, IN ONE ORDER, WITH A REASON FOR THE ORDER
 * ══════════════════════════════════════════════════════════════════════
 * By Phase 14 this system had four independent gates, and they answer
 * genuinely different questions:
 *
 *   1. ACCESS      (Phase 14) — is this workspace allowed to WRITE at
 *                  all? A cancelled or unpaid account is read-only.
 *   2. ENTITLEMENT (Phase 12) — has this workspace PAID for the feature?
 *   3. PERMISSION  (Phase 5)  — is this PERSON allowed to do it?
 *   4. Tenant isolation       — the database, unconditionally.
 *
 * ⚠️ THE ORDER IS THE PRODUCT, NOT THE PLUMBING.
 *
 * Reversed, a workspace owner whose card expired is told "you do not
 * have permission" — sending them to an administrator who is themselves.
 * A member on a plan that excludes payment plans is told "upgrade",
 * which they cannot do. Each gate's refusal is aimed at a different
 * person, and the order decides who gets the message.
 *
 * ⚠️ THIS FILE IS NOT `"use server"`. It exports a type and a
 * non-async helper alongside the async ones, and a `"use server"` file
 * that exports anything but async functions publishes them as RPC
 * endpoints. Six schemas were found doing exactly that in Phase 7.
 */

import { z } from "zod";
import { requireTenantContext, TenantAccessError, type TenantContext } from "@/server/tenant-context";
import { requireAccess, AccessRestrictedError } from "@/server/billing/access";
import {
  assertImpersonationAllows,
  ImpersonationForbiddenError,
} from "@/server/platform/impersonation";
import { requireFeature, FeatureLockedError } from "@/server/entitlements";
import { PermissionDeniedError } from "@/lib/permissions";
import type { FeatureKey } from "@/lib/entitlements/features";
import type { ActionResult } from "@/lib/validators/crm";
import {
  isBookingCollision,
  describeBookingCollision,
} from "@/lib/sales/inventory";
import { CreditNoteCapRefusal } from "@/server/sales/refund-cap";
import type { PermissionKey } from "@/db/schema/auth";

/**
 * Run all three application gates and return the tenant context.
 *
 * ⚠️ CALL THIS AT WRITE SITES ONLY.
 *
 * An automated wiring pass in Phase 12 put entitlement gates on three
 * READ functions and none of the writes — every guard installed, none of
 * them where it mattered. A gate on a `get*` function also produces the
 * worst possible upgrade prompt: a page that will not render at all,
 * rather than a page that renders and refuses the button.
 *
 * Reads use `requirePermission` alone, plus `checkFeature` where the UI
 * needs to know whether to show something.
 */
export async function guardSalesWrite(args: {
  /** The operation key, e.g. "bookings:create". Used by the access gate. */
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

  // 1. Can this workspace write at all?
  await requireAccess(args.operation, ctx);

  // 2. Has it paid for this capability?
  await requireFeature(args.feature, ctx);

  // 3. May THIS person do it?
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

export function salesFail(
  error: string,
  fieldErrors?: Record<string, string[]>,
): ActionResult<never> {
  return { ok: false, error, fieldErrors };
}

/**
 * ⭐ THE PLACE-OF-SUPPLY ENGINE REFUSED, AND THE REFUSAL IS THE FEATURE.
 * Added v1.37.0 (Batch 33).
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY A REFUSAL AND NOT A DEFAULT
 * ══════════════════════════════════════════════════════════════════════
 * The code this replaces ended in `: false` — when it had not been told
 * enough to decide, it answered "intra-state" and carried on. That is the
 * worst available behaviour for this particular question, because:
 *
 *   • The total on the document is identical either way. Nothing on the
 *     screen looks wrong.
 *   • The error surfaces at the BUYER's reconciliation or at an
 *     assessment, months later.
 *   • Correcting CGST+SGST wrongly paid instead of IGST is a refund
 *     application under Section 77, not an edit.
 *
 * So an unanswerable question stops the order. The message says what is
 * missing and the remedy says which field to set — because a refusal
 * without a remedy is just an outage, and the operator's next move is to
 * find someone who will type it into the database directly.
 */
export class OrderTaxRefusal extends Error {
  readonly remedy: string;
  constructor(message: string, remedy: string) {
    super(message);
    this.name = "OrderTaxRefusal";
    this.remedy = remedy;
  }
}

/**
 * Turn anything thrown into a safe, useful envelope.
 *
 * ⚠️ THE DATABASE ERRORS ARE TRANSLATED, NOT PASSED THROUGH.
 *
 * Phase 22 is the first phase where the guarantees are enforced by
 * constraints a user can hit during ordinary work — two reps booking one
 * flat is not misuse, it is a busy Saturday. Left raw, the loser sees
 * "duplicate key value violates unique constraint
 * bookings_one_live_per_unit" and concludes the software is broken.
 *
 * Each mapping below names a specific constraint, so a NEW constraint
 * failing falls through to the generic message rather than being
 * mislabelled as something it is not.
 */
export function toSalesActionError(err: unknown, scope: string): ActionResult<never> {
  if (err instanceof TenantAccessError) return salesFail(err.message);
  if (err instanceof AccessRestrictedError) return salesFail(err.message);
  if (err instanceof FeatureLockedError) return salesFail(err.message);
  if (err instanceof PermissionDeniedError) return salesFail(err.message);
  // ⚠️ The refusal carries the RULE, in a sentence written for the
  // operator: "this session is read-only", "role changes would
  // survive the session". A support engineer who is refused with
  // "something went wrong" concludes the product is broken and
  // reaches for a database client, which is the outcome the whole
  // impersonation system exists to avoid.
  if (err instanceof ImpersonationForbiddenError) return salesFail(err.message);

  /**
   * ⭐ THE TAX REFUSAL CARRIES ITS REMEDY INTO THE MESSAGE. The operator
   * needs both halves: what we could not determine, and which field to
   * set so we can. Splitting them across a log line and a toast means
   * only one of them reaches the person who can act.
   */
  /**
   * 🔴 BATCH 48 — THE CREDIT-NOTE CAP REFUSAL CARRIES ITS OWN SENTENCE.
   *
   * ⚠️ WITHOUT THIS LINE THE REFUSAL FALLS THROUGH TO "Something went
   * wrong. Please try again." — and a person told that about a credit
   * note above their limit concludes the product is broken and presses
   * Issue until somebody phones support. The message already names the
   * amount, the limit and the way forward; all this does is let it out.
   */
  if (err instanceof CreditNoteCapRefusal) return salesFail(err.message);

  if (err instanceof OrderTaxRefusal) {
    return salesFail(`${err.message} ${err.remedy}`);
  }

  if (err instanceof z.ZodError) {
    return salesFail(
      "Please check the form.",
      err.flatten().fieldErrors as Record<string, string[]>,
    );
  }

  // ⭐ The double-sale refusal. The most important message in the phase.
  if (isBookingCollision(err)) {
    return salesFail(describeBookingCollision());
  }

  const pg = asPgError(err);

  if (pg?.code === "23505") {
    if (pg.constraint?.includes("units_code_project_unique")) {
      return salesFail(
        "A unit with that number already exists in this project. Unit numbers " +
          "must be unique within a project.",
      );
    }
    if (pg.constraint?.includes("leads_reference_tenant_unique")) {
      return salesFail("That lead reference is already in use.");
    }
    if (pg.constraint?.includes("bookings_reference_tenant_unique")) {
      return salesFail("That booking reference is already in use.");
    }
    if (pg.constraint?.includes("projects_code_tenant_unique")) {
      return salesFail("A project with that code already exists.");
    }
    if (pg.constraint?.includes("channel_partners_code_tenant_unique")) {
      return salesFail("A channel partner with that code already exists.");
    }
    return salesFail("That record already exists.");
  }

  if (pg?.code === "23514") {
    // A CHECK constraint or a trigger raising 23514. The triggers raise
    // messages written for a person, so pass those through — they say
    // things like "Unit A-1203 is held for another buyer until …".
    const constraint = pg.constraint ?? "";
    if (constraint.includes("leads_lost_has_reason")) {
      return salesFail("A lost lead needs a reason. Say what happened.");
    }
    if (constraint.includes("leads_budget_sane")) {
      return salesFail("The maximum budget is below the minimum. Check the two figures.");
    }
    if (constraint.includes("units_hold_is_complete")) {
      return salesFail(
        "A hold needs both a buyer and a deadline. Pick the lead it is held for.",
      );
    }
    if (constraint.includes("bookings_cancel_has_reason")) {
      return salesFail("Say why this booking is being cancelled.");
    }
    if (constraint.includes("leads_score_sane")) {
      return salesFail("The lead score is out of range. This is a defect — report it.");
    }

    /* --- ⭐ v1.37.0: the constraints that outlive the fix -------------- */
    //
    // ⚠️ THESE FIRE FOR WRITE PATHS WE HAVE NOT CORRECTED YET — an import,
    // the future REST API, a psql prompt. The application path determines
    // place of supply through the engine and cannot reach them. Anything
    // that DOES reach them is by definition code that guessed, so the
    // message names the statute rather than apologising.
    if (constraint.includes("sales_orders_immovable_property_pos")) {
      return salesFail(
        "This order relates to immovable property, so under Section 12(3) of the " +
          "IGST Act the place of supply must be the state the property is in. Set " +
          "the project's GST state code.",
      );
    }
    if (constraint.includes("sales_orders_sez_is_inter_state")) {
      return salesFail(
        "The buyer is in a Special Economic Zone. Section 7(5)(b) makes that an " +
          "inter-state supply even when the SEZ is in our own state, so it cannot " +
          "be recorded as intra-state.",
      );
    }
    if (constraint.includes("sales_orders_ut_is_intra_state")) {
      return salesFail(
        "An order cannot be both inter-state and in a Union Territory: UTGST only " +
          "applies to an intra-state supply. This is a defect — report it.",
      );
    }
    if (constraint.includes("sales_orders_pos_has_basis")) {
      return salesFail(
        "This order has a place of supply with no record of which rule produced " +
          "it. A place of supply must be determined, not assumed. This is a " +
          "defect — report it.",
      );
    }
    if (pg.message) return salesFail(stripPgNoise(pg.message));
    return salesFail("That change is not allowed.");
  }

  if (pg?.code === "42501") {
    // The append-only trigger, or a missing GRANT.
    return salesFail(
      "That record cannot be changed after the fact. Add a new entry recording " +
        "the correction instead.",
    );
  }

  if (pg?.code === "23503") {
    return salesFail(
      "Something this refers to no longer exists. Refresh the page and try again.",
    );
  }

  console.error(`[sales:${scope}]`, err);
  return salesFail("Something went wrong. Please try again.");
}

type PgErrorShape = {
  code?: string;
  constraint?: string;
  message?: string;
};

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

/**
 * PostgreSQL prefixes trigger messages with nothing, but drivers
 * sometimes wrap them. Keep the sentence, drop the machinery.
 */
function stripPgNoise(message: string): string {
  return message
    .replace(/^error:\s*/i, "")
    .replace(/\s*CONTEXT:[\s\S]*$/i, "")
    .trim();
}
