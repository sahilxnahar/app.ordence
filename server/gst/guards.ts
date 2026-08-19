import "server-only";

/**
 * Ordence — GST Gate Composition
 * Version: v0.32.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE SAME FOUR GATES, IN THE SAME ORDER, FOR THE SAME REASONS
 * ══════════════════════════════════════════════════════════════════════
 *   1. ACCESS      — may this workspace WRITE at all? An unpaid account
 *                    is read-only.
 *   2. ENTITLEMENT — has it paid for the capability?
 *   3. PERMISSION  — may this PERSON do it?
 *   4. Tenant isolation — the database, unconditionally.
 *
 * ⚠️ THE ORDER DECIDES WHO GETS THE MESSAGE. Reversed, a workspace owner
 * whose card expired is told "you do not have permission" and sent to an
 * administrator who is themselves.
 *
 * ⚠️ THIS FILE IS NOT `"use server"`. It exports non-async helpers
 * alongside the async one, and a `"use server"` file that exports
 * anything but async functions publishes them as RPC endpoints.
 */

import { z } from "zod";
import {
  requireTenantContext,
  TenantAccessError,
  type TenantContext,
} from "@/server/tenant-context";
import { requireAccess, AccessRestrictedError } from "@/server/billing/access";
import { requireFeature, FeatureLockedError } from "@/server/entitlements";
import { PermissionDeniedError } from "@/lib/permissions";
import type { FeatureKey } from "@/lib/entitlements/features";
import type { ActionResult } from "@/lib/validators/crm";
import type { PermissionKey } from "@/db/schema/auth";

/**
 * ⚠️ WRITE SITES ONLY. A gate on a `get*` function produces the worst
 * upgrade prompt in the product: a page that will not render at all
 * rather than a page that renders and refuses the button. Reads use
 * `requirePermission` alone.
 */
export async function guardGstWrite(args: {
  operation: string;
  feature: FeatureKey;
  permission: PermissionKey;
  resource?: { type?: string; id?: string };
}): Promise<TenantContext> {
  const ctx = await requireTenantContext();

  await requireAccess(args.operation, ctx);
  await requireFeature(args.feature, ctx);

  const { requirePermission } = await import("@/server/audit");
  return requirePermission(args.permission, args.resource);
}

/* ------------------------------------------------------------------ */
/* ERROR TRANSLATION                                                   */
/* ------------------------------------------------------------------ */

export function gstFail(
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
 * The rate-history guard and the reconciliation guard both raise
 * sentences written for a person — "this rate has already been used on 14
 * invoice lines and cannot be changed". That sentence is the entire
 * explanation of a rule nobody understands on first encounter, and
 * replacing it with "something went wrong" throws it away.
 *
 * Each mapping below names a specific constraint, so a NEW constraint
 * failing falls through to the generic message rather than being
 * mislabelled as something it is not.
 */
export function toGstActionError(err: unknown, scope: string): ActionResult<never> {
  if (err instanceof TenantAccessError) return gstFail(err.message);
  if (err instanceof AccessRestrictedError) return gstFail(err.message);
  if (err instanceof FeatureLockedError) return gstFail(err.message);
  if (err instanceof PermissionDeniedError) return gstFail(err.message);

  if (err instanceof z.ZodError) {
    return gstFail(
      "Please check the form.",
      err.flatten().fieldErrors as Record<string, string[]>,
    );
  }

  const pg = asPgError(err);

  // ⭐ The overlap refusal. 23P01 is `exclusion_violation`, and it is
  // raised by exactly one constraint in this phase.
  if (pg?.code === "23P01" || pg?.constraint?.includes("hsn_sac_rates_no_overlap")) {
    return gstFail(
      "A rate for this code already covers part of that period. Close the current " +
        "period on the day the new rate takes effect — two rates valid on one day " +
        "means the rate on an invoice raised that day is decided by a sort order, " +
        "and nothing on the document would show which one it got.",
    );
  }

  if (pg?.code === "23505") {
    if (pg.constraint?.includes("gst_registrations_gstin_tenant_unique")) {
      return gstFail("That GSTIN is already registered in this workspace.");
    }
    if (pg.constraint?.includes("gst_registrations_one_primary")) {
      return gstFail(
        "Another registration is already the primary one. Clear that first — two " +
          "defaults would mean the GSTIN we issue from is decided by a sort order.",
      );
    }
    if (pg.constraint?.includes("gst_parties_gstin_type_unique")) {
      return gstFail("That GSTIN is already on file for this workspace.");
    }
    if (pg.constraint?.includes("hsn_sac_codes_code_tenant_unique")) {
      return gstFail("That HSN/SAC code is already in the master.");
    }
    return gstFail("That record already exists.");
  }

  if (pg?.code === "23514") {
    const constraint = pg.constraint ?? "";
    if (constraint.includes("gstin_checksum")) {
      return gstFail(
        "That GSTIN fails its own checksum — one of the fifteen characters is " +
          "mistyped. Check it against the registration certificate.",
      );
    }
    if (constraint.includes("type_matches_gstin")) {
      return gstFail(
        "The registration type and the GSTIN disagree. A registered party must " +
          "have a GSTIN; an unregistered one must not.",
      );
    }
    if (constraint.includes("state_matches_gstin")) {
      return gstFail(
        "The state does not match the GSTIN's first two digits. A GSTIN's prefix " +
          "IS its state, and a mismatch flips the invoice between IGST and " +
          "CGST+SGST.",
      );
    }
    if (constraint.includes("invoices_immovable_property_pos")) {
      return gstFail(
        "For a supply relating to immovable property the place of supply must be " +
          "the PROPERTY'S state (Section 12(3), IGST Act) — not the buyer's " +
          "address and not their GSTIN. Set the project's state and use it.",
      );
    }
    if (constraint.includes("hsn_sac_codes_shape")) {
      return gstFail(
        "That is not a valid code. HSN is 2, 4, 6 or 8 digits; SAC is six digits " +
          "beginning 99.",
      );
    }
    if (constraint.includes("hsn_sac_rates_period_sane")) {
      return gstFail(
        "The end date must be after the start date. It is exclusive — a period " +
          "ends on the day its successor begins.",
      );
    }
    if (constraint.includes("invoices_totals_balance")) {
      return gstFail(
        "The invoice total does not equal its parts. This is a defect — do not " +
          "issue it, and report it.",
      );
    }
    // The reconciliation trigger and the remaining checks raise sentences
    // written for a person. Keep them.
    if (pg.message) return gstFail(stripPgNoise(pg.message));
    return gstFail("That change is not allowed.");
  }

  if (pg?.code === "42501") {
    // ⭐ The rate-history guard lands here. Its message is the whole
    // explanation of the phase's central rule.
    if (pg.message) return gstFail(stripPgNoise(pg.message));
    return gstFail(
      "That change is refused. A rate an invoice has already used cannot be " +
        "edited — supersede it with a new period instead.",
    );
  }

  if (pg?.code === "23503") {
    if (pg.constraint?.includes("invoice_lines_gst_rate_same_tenant")) {
      return gstFail(
        "That rate period is used by invoices already raised and cannot be " +
          "removed. It is the record of what those documents were charged at.",
      );
    }
    return gstFail(
      "Something this refers to no longer exists. Refresh the page and try again.",
    );
  }

  console.error(`[gst:${scope}]`, err);
  return gstFail("Something went wrong. Please try again.");
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
