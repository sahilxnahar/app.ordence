"use server";

/**
 * Ordence — Platform Console Server Actions
 * Version: v0.14.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ EVERY EXPORT IN THIS FILE IS A PUBLIC HTTP ENDPOINT
 * ══════════════════════════════════════════════════════════════════════
 * `"use server"` publishes each exported function as a callable endpoint
 * with a stable action id. There is no route to protect and no matcher to
 * configure — the middleware check on `/platform(.*)` DOES NOT APPLY,
 * because a server action is invoked by POSTing to whatever page URL the
 * client happens to be on. Someone who extracts an action id from the
 * client bundle can call these from `/dashboard`, or from curl.
 *
 * That is precisely why `requirePlatformAdmin()` lives inside the
 * implementations rather than at a route boundary: the gate has to be on
 * the function, because the function is the endpoint.
 *
 * Two house rules this file obeys:
 *
 *   1. ONLY ASYNC FUNCTIONS ARE EXPORTED. A `"use server"` file that
 *      exports a constant fails the production build, and if it did not,
 *      it would publish that constant as a callable endpoint. Schemas
 *      live in `lib/platform/schemas.ts`.
 *
 *   2. THESE ARE THIN. Every one delegates immediately to a module that
 *      starts with `import "server-only"` and performs its own
 *      authorisation. Nothing decides anything here — a wrapper that does
 *      half the checking is a wrapper somebody eventually calls the inner
 *      function around.
 */

import { revalidatePath } from "next/cache";

import {
  listTenants as listTenantsImpl,
  getTenantDetail as getTenantDetailImpl,
  suspendTenant as suspendTenantImpl,
  reactivateTenant as reactivateTenantImpl,
} from "./tenants";
import {
  startImpersonation as startImpersonationImpl,
  stopImpersonation as stopImpersonationImpl,
  getActiveImpersonation as getActiveImpersonationImpl,
} from "./impersonation";
import { platformSearch as platformSearchImpl } from "./search";
import { revokeImpersonationSession as revokeImpersonationSessionImpl } from "./action-log";
import {
  setTenantFlag as setTenantFlagImpl,
  listTenantFlags as listTenantFlagsImpl,
} from "./flags";
import {
  listPlatformStaff as listPlatformStaffImpl,
  grantPlatformStaff as grantPlatformStaffImpl,
  revokePlatformStaff as revokePlatformStaffImpl,
} from "./staff";
import {
  grantSupportConsent as grantSupportConsentImpl,
  revokeSupportConsent as revokeSupportConsentImpl,
} from "./consent";
import { requirePlatformAdmin, recordStepUp } from "./guard";

/* ------------------------------------------------------------------ */
/* TENANTS                                                             */
/* ------------------------------------------------------------------ */

export async function listTenantsAction(input: unknown) {
  return listTenantsImpl(input);
}

export async function getTenantDetailAction(tenantId: string) {
  return getTenantDetailImpl(tenantId);
}

export async function suspendTenantAction(input: unknown) {
  const result = await suspendTenantImpl(input);
  if (result.ok) revalidatePath("/platform");
  return result;
}

export async function reactivateTenantAction(input: unknown) {
  const result = await reactivateTenantImpl(input);
  if (result.ok) revalidatePath("/platform");
  return result;
}

/* ------------------------------------------------------------------ */
/* IMPERSONATION                                                       */
/* ------------------------------------------------------------------ */

export async function startImpersonationAction(input: unknown) {
  const result = await startImpersonationImpl(input);
  if (result.ok) revalidatePath("/platform");
  return result;
}

export async function stopImpersonationAction(input: unknown) {
  const result = await stopImpersonationImpl(input);
  if (result.ok) revalidatePath("/platform");
  return result;
}

/**
 * Returns a plain object, never the internal session row.
 *
 * The banner needs four strings and a number. Returning the record would
 * ship the justification, the consent id and the recorded IP into a
 * client bundle for no reason at all.
 */
export async function getActiveImpersonationAction(): Promise<{
  sessionId: string;
  tenantName: string;
  tenantSlug: string;
  scope: string;
  mode: string;
  banner: string;
  minutesLeft: number;
  expiresAt: string;
} | null> {
  const active = await getActiveImpersonationImpl();
  if (!active) return null;
  return {
    sessionId: active.sessionId,
    tenantName: active.tenantName,
    tenantSlug: active.tenantSlug,
    scope: active.scope,
    mode: active.mode,
    banner: active.banner,
    minutesLeft: active.minutesLeft,
    expiresAt: active.expiresAt.toISOString(),
  };
}

/**
 * End SOMEBODY ELSE'S live session. Owner grade, step-up, written reason.
 *
 * Separate from `stopImpersonationAction` on purpose: that one closes the
 * caller's own session and is an ordinary act; this one reaches into a
 * colleague's session and is not. Two endpoints, two capabilities, two
 * different audit severities.
 */
export async function revokeImpersonationSessionAction(input: unknown) {
  const result = await revokeImpersonationSessionImpl(input);
  if (result.ok) {
    revalidatePath("/platform/sessions");
    revalidatePath("/platform");
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* SEARCH                                                              */
/* ------------------------------------------------------------------ */

export async function platformSearchAction(input: unknown) {
  return platformSearchImpl(input);
}

/* ------------------------------------------------------------------ */
/* FLAGS                                                               */
/* ------------------------------------------------------------------ */

export async function listTenantFlagsAction(tenantId: string) {
  return listTenantFlagsImpl(tenantId);
}

export async function setTenantFlagAction(input: unknown) {
  const result = await setTenantFlagImpl(input);
  if (result.ok) revalidatePath("/platform");
  return result;
}

/* ------------------------------------------------------------------ */
/* STAFF                                                               */
/* ------------------------------------------------------------------ */

export async function listPlatformStaffAction() {
  return listPlatformStaffImpl();
}

export async function grantPlatformStaffAction(input: unknown) {
  const result = await grantPlatformStaffImpl(input);
  if (result.ok) revalidatePath("/platform/staff");
  return result;
}

export async function revokePlatformStaffAction(input: unknown) {
  const result = await revokePlatformStaffImpl(input);
  if (result.ok) revalidatePath("/platform/staff");
  return result;
}

/* ------------------------------------------------------------------ */
/* STEP-UP                                                             */
/* ------------------------------------------------------------------ */

/**
 * Record that the operator re-confirmed their identity.
 *
 * ⚠️ READ THE CAVEAT IN `guard.ts` BEFORE TRUSTING THIS. Where Clerk's
 * `fva` session claim is available it is authoritative and this timestamp
 * is ignored. Where it is not, this records that somebody clicked a
 * button — which an attacker holding the session can also do. It is a
 * speed bump until INTEGRATION step 4 lands.
 */
export async function recordStepUpAction(): Promise<{ ok: true }> {
  const operator = await requirePlatformAdmin();
  await recordStepUp(operator);
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* TENANT-SIDE CONSENT                                                 */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ THESE TWO AUTHENTICATE AS THE CUSTOMER, NOT AS PLATFORM STAFF.
 * They are exported from this file only because the console and the
 * settings page are shipped together in this phase. `grantSupportConsent`
 * calls `requireTenantContext()`, and the RLS policy on
 * `tenant_support_consents` refuses a write from a platform-scoped
 * connection — so a platform operator calling this endpoint directly gets
 * nothing. Consent we can write is not consent.
 */
export async function grantSupportConsentAction(input: unknown) {
  const result = await grantSupportConsentImpl(input);
  if (result.ok) revalidatePath("/settings");
  return result;
}

export async function revokeSupportConsentAction(input: unknown) {
  const result = await revokeSupportConsentImpl(input);
  if (result.ok) revalidatePath("/settings");
  return result;
}
