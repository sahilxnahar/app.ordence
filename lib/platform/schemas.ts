/**
 * Ordence — Platform Console Input Schemas
 * Version: v0.14.0-alpha
 *
 * Pure Zod. These live here and not beside the server actions because a
 * `"use server"` file may only export async functions — exporting a schema
 * from one fails the production build, and if it did not, it would publish
 * the schema as a callable endpoint. Same reason `lib/validators/team.ts`
 * exists.
 *
 * ══════════════════════════════════════════════════════════════════════
 * EVERY DANGEROUS OPERATION IN THIS PHASE CARRIES A WRITTEN REASON
 * ══════════════════════════════════════════════════════════════════════
 * Not because the string is checked by anything — nothing can check
 * whether "ZD-4471, customer reports missing invoice" is true — but
 * because it is the field a reviewer reads six months later, and because
 * typing a sentence is a moment of deliberation in front of an action
 * that crosses a tenant boundary.
 *
 * The minimums are set above `withPlatformScope()`'s ten characters on
 * purpose: that floor exists to catch an empty string, this one exists to
 * catch "test".
 *
 * ⚠️ `confirmSlug` on the destructive schemas is NOT security. Anyone can
 * type a slug. It exists because the console shows a list of two hundred
 * near-identical rows and the failure it prevents is suspending the wrong
 * customer — a mistake, not an attack.
 */

import { z } from "zod";
import { SEARCH_SCOPES, MIN_SEARCH_JUSTIFICATION } from "./search-scopes";
import { isFlagKey, FLAG_KEYS } from "./flags-catalog";
import { MIN_JUSTIFICATION_LENGTH } from "./impersonation-policy";
import { PLATFORM_GRADES } from "./roles";

/* ------------------------------------------------------------------ */
/* SHARED                                                              */
/* ------------------------------------------------------------------ */

const uuidField = z.string().uuid("Invalid identifier.");

const justification = (min: number, what: string) =>
  z
    .string()
    .trim()
    .min(min, `Describe why, in at least ${min} characters — this is written to ${what}.`)
    .max(1000, "Keep it under 1000 characters.");

/* ------------------------------------------------------------------ */
/* TENANT LIST & DETAIL                                                */
/* ------------------------------------------------------------------ */

export const tenantListSchema = z.object({
  query: z.string().trim().max(120).optional(),
  status: z
    .enum(["all", "pending", "active", "suspended", "archived", "pending_deletion"])
    .default("all"),
  planTier: z.enum(["all", "trial", "basic", "advanced", "ai", "enterprise"]).default("all"),
  health: z.enum(["all", "healthy", "watch", "at_risk", "suspended"]).default("all"),
  // Bounded. There is no "show all" — see MAX_RESULTS in search-scopes.ts
  // for why unbounded listing across tenants is a different thing entirely.
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).max(10_000).default(0),
});

export type TenantListInput = z.infer<typeof tenantListSchema>;

/* ------------------------------------------------------------------ */
/* SUSPEND / REACTIVATE                                                */
/* ------------------------------------------------------------------ */

/**
 * Suspension is reversible and destroys nothing — see
 * `evaluateAccess()`, where `tenantStatus === "suspended"` produces
 * `locked` with `canExport: true`. The schema does not carry a "delete
 * data" option because no such option exists anywhere in this phase.
 */
export const suspendTenantSchema = z.object({
  tenantId: uuidField,
  /** Typed by the operator to prove they are looking at the right row. */
  confirmSlug: z.string().trim().min(1, "Type the workspace address to confirm."),
  reason: justification(20, "the customer's own audit log"),
  /** Told to the customer verbatim. Kept separate from the internal reason. */
  customerMessage: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined)),
});

export const reactivateTenantSchema = z.object({
  tenantId: uuidField,
  reason: justification(15, "the customer's own audit log"),
});

/* ------------------------------------------------------------------ */
/* IMPERSONATION                                                       */
/* ------------------------------------------------------------------ */

export const startImpersonationSchema = z.object({
  tenantId: uuidField,
  /**
   * `break_glass` is accepted here and refused later unless the caller
   * holds `impersonate:breakglass` AND no usable consent exists. It is
   * NOT a preference — asking for break-glass when consent is available
   * is refused, because break-glass is read-only and choosing it would be
   * a way to skip the consent check for a read.
   */
  mode: z.enum(["standing_consent", "incident_consent", "break_glass"]),
  justification: justification(
    MIN_JUSTIFICATION_LENGTH,
    "the customer's own audit log and the permanent impersonation record",
  ),
  /** Optional: whose view to reproduce. Read-only either way. */
  subjectUserId: uuidField.optional(),
  confirmSlug: z.string().trim().min(1, "Type the workspace address to confirm."),
  /**
   * ⭐ REQUIRED FOR `break_glass` AND MEANINGLESS OTHERWISE, which is why
   * it is optional HERE and checked by `breakGlassReasonProblem` once the
   * mode is known. A Zod refinement could express it, but the refusal
   * sentences that field needs are three paragraphs of argument about
   * ticket references and copy-pasted justifications, and they belong in
   * `lib/platform/break-glass.ts` next to the rest of the procedure.
   */
  breakGlassReason: z.string().trim().max(4000).optional(),
});

export type StartImpersonationInput = z.infer<typeof startImpersonationSchema>;

export const stopImpersonationSchema = z.object({
  sessionId: uuidField,
});

/* ------------------------------------------------------------------ */
/* TENANT-SIDE CONSENT                                                 */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ SUBMITTED BY A TENANT USER, NEVER BY PLATFORM STAFF. The action that
 * consumes this runs under the tenant's own session and RLS context;
 * consent that platform staff can write is not consent.
 */
export const grantSupportConsentSchema = z.object({
  mode: z.enum(["standing", "incident"]),
  scope: z.enum(["read_only", "read_write"]).default("read_only"),
  /** Ticket or incident this belongs to; required for incident consent. */
  reference: z.string().trim().max(200).optional(),
  note: z.string().trim().max(500).optional(),
});

export const revokeSupportConsentSchema = z.object({
  consentId: uuidField,
});

/* ------------------------------------------------------------------ */
/* CROSS-TENANT SEARCH                                                 */
/* ------------------------------------------------------------------ */

export const platformSearchSchema = z.object({
  scope: z.enum(SEARCH_SCOPES),
  query: z.string().trim().min(2, "Enter at least 2 characters.").max(200),
  /**
   * Mandatory on EVERY search, including the first one of the day.
   * A justification that is only demanded for "sensitive" searches is a
   * justification nobody writes, because nothing feels sensitive at the
   * time.
   */
  justification: justification(MIN_SEARCH_JUSTIFICATION, "the cross-tenant access log"),
});

export type PlatformSearchInput = z.infer<typeof platformSearchSchema>;

/* ------------------------------------------------------------------ */
/* FEATURE FLAGS                                                       */
/* ------------------------------------------------------------------ */

export const setTenantFlagSchema = z.object({
  tenantId: uuidField,
  /**
   * 🔴 WAS `z.enum(FLAG_KEYS)`, which rejected every `entitlement:*`
   * key and so made the whole entitlement-override screen unusable.
   * `isFlagKey` accepts the closed catalogue plus that one constructed
   * namespace, and nothing else.
   */
  flagKey: z.string().refine(isFlagKey, "Unknown flag."),
  enabled: z.boolean(),
  reason: justification(15, "the flag's permanent record"),
  /** ISO date string; required for flags that grant paid capability. */
  expiresAt: z
    .string()
    .datetime({ message: "Use an ISO timestamp." })
    .optional()
    .nullable(),
  value: z.record(z.unknown()).optional(),
});

export type SetTenantFlagInput = z.infer<typeof setTenantFlagSchema>;

/* ------------------------------------------------------------------ */
/* STAFF ADMINISTRATION                                                */
/* ------------------------------------------------------------------ */

/**
 * Granting platform access is the only operation in the console that
 * creates another operator, so it is the one an attacker most wants. It
 * requires the `owner` grade, a fresh step-up, and — enforced in
 * `server/platform/staff.ts` — the target must ALREADY be in
 * `PLATFORM_ADMIN_EMAILS`. This form cannot mint access on its own; it
 * turns the second key for someone who already holds the first.
 */
export const grantPlatformStaffSchema = z.object({
  clerkUserId: z.string().trim().min(1, "Clerk user id is required.").max(255),
  email: z.string().trim().email("Enter a valid email address.").max(320),
  displayName: z.string().trim().max(200).optional(),
  grade: z.enum(PLATFORM_GRADES),
  reason: justification(20, "the platform access record"),
  /** Required. Standing access with no end date is how contractors linger. */
  expiresAt: z.string().datetime({ message: "Use an ISO timestamp." }),
});

export const revokePlatformStaffSchema = z.object({
  staffId: uuidField,
  reason: justification(15, "the platform access record"),
});

/* ------------------------------------------------------------------ */
/* RESULT ENVELOPE                                                     */
/* ------------------------------------------------------------------ */

/**
 * Same shape as `ActionResult` in `lib/validators/crm.ts`, redeclared
 * rather than imported so this module stays free of CRM concepts.
 * A console error must never be a raw exception message: the console
 * talks to a database that holds every tenant, and an unhandled error
 * string from it is the widest possible information leak in the product.
 */
export type PlatformResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };
