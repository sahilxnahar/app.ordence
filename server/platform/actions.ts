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
 *      authorisation. Nothing decides anything here — a wrapper that does
 *      half the checking is a wrapper somebody eventually calls the inner
 *      function around.
 */

import { revalidatePath } from "next/cache";
import { requestSuspend, requestTermination } from "./control-actions";
import { suspendTenantSchema } from "@/lib/platform/schemas";

import {
  listTenants as listTenantsImpl,
  getTenantDetail as getTenantDetailImpl,
  reactivateTenant as reactivateTenantImpl,
  cancelTenantTermination as cancelTenantTerminationImpl,
  exportOffboardingSnapshot as exportOffboardingSnapshotImpl,
} from "./tenants";
import {
  previewConfigOverride as previewConfigOverrideImpl,
  setConfigOverride as setConfigOverrideImpl,
} from "./configuration";
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
import {
  updateUserStatus as updateUserStatusImpl,
  updateUserRole as updateUserRoleImpl,
} from "./users";
import { requirePlatformAdmin, recordStepUp, PlatformAccessError } from "./guard";

/* ------------------------------------------------------------------ */
/* TENANTS                                                             */
/* ------------------------------------------------------------------ */

export async function listTenantsAction(input: unknown) {
  return listTenantsImpl(input);
}

export async function getTenantDetailAction(tenantId: string) {
  return getTenantDetailImpl(tenantId);
}

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 SUSPENSION GOES THROUGH THE QUEUE. IT USED NOT TO.
 * ══════════════════════════════════════════════════════════════════════
 * `APPROVAL_POLICIES` has declared `tenant.suspend` as needing a second
 * pair of eyes since v0.54.0, `requestSuspend` was written to queue it,
 * and the console wired the button straight to `suspendTenantImpl`
 * instead. `requestSuspend` had ZERO CALLERS anywhere in the repository,
 * so the queue table stayed empty, the approvals screen looked like a
 * working control, and one owner suspended any live workspace in one
 * click.
 *
 * ⚠️ THE OPERATOR TYPES EXACTLY WHAT THEY TYPED BEFORE. The dialog
 * already collects a confirmation slug and a justification of at least
 * twenty characters; that sentence now serves as both the queue
 * justification and the reason written into the customer's own audit
 * log when the suspension actually runs. The only difference they
 * experience is that nothing happens yet.
 *
 * ⭐ `suspendTenantImpl` is no longer exported from this file. It is
 * reachable only through the approval executor registered in
 * `control-actions.ts`, so there is one door and it has two locks.
 */
export async function suspendTenantAction(input: unknown) {
  const parsed = suspendTenantSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false as const,
      error: "Check the form.",
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const result = await requestSuspend({
    tenantId: parsed.data.tenantId,
    confirmSlug: parsed.data.confirmSlug,
    reason: parsed.data.reason,
    customerMessage: parsed.data.customerMessage,
    justification: parsed.data.reason,
  });

  if (result.ok) {
    revalidatePath("/platform");
    revalidatePath("/platform/approvals");
  }
  return result;
}

export async function reactivateTenantAction(input: unknown) {
  const result = await reactivateTenantImpl(input);
  if (result.ok) revalidatePath("/platform");
  return result;
}

/* ------------------------------------------------------------------ */
/* OFFBOARDING — BATCH 46                                              */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THREE ENDPOINTS, AND NOT A FOURTH
 * ══════════════════════════════════════════════════════════════════════
 * Request, cancel, export. `scheduleTenantTermination` is deliberately
 * NOT wrapped here: it is reachable only through the approval executor
 * registered in `control-actions.ts`, exactly as `suspendTenant` is.
 * Publishing it as a server action would put a stable action id on the
 * function that locks a workspace and starts the clock, reachable by
 * POST from any page, with the approval queue routed around entirely.
 *
 * ⭐ NOTE THE ASYMMETRY BETWEEN THE THREE. Requesting a termination goes
 * through a queue and a second owner. Cancelling one is a single call
 * with a reason. That is not an oversight — stopping a destructive
 * action must always be cheaper than starting one, or the controls
 * protect the wrong direction.
 */
export async function requestTerminationAction(input: unknown) {
  const result = await requestTermination(input);
  if (result.ok) {
    revalidatePath("/platform");
    revalidatePath("/platform/approvals");
  }
  return result;
}

export async function cancelTerminationAction(input: unknown) {
  const result = await cancelTenantTerminationImpl(input);
  if (result.ok) {
    revalidatePath("/platform");
    revalidatePath("/platform/tenants");
  }
  return result;
}

export async function exportOffboardingSnapshotAction(input: unknown) {
  return exportOffboardingSnapshotImpl(input);
}

/* ------------------------------------------------------------------ */
/* THE CONFIGURATION CHAIN — BATCH 47                                  */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ THE PREVIEW IS A SEPARATE ENDPOINT FROM THE SAVE, and it is
 * gated separately too — `tenants:read` to see what a change would do,
 * `tenants:configure` to make it. A support engineer who can read a
 * workspace should be able to answer "what would happen if we raised
 * their ceiling?" without holding the capability to raise it.
 */
export async function previewConfigOverrideAction(input: unknown) {
  return previewConfigOverrideImpl(input);
}

export async function setConfigOverrideAction(input: unknown) {
  const result = await setConfigOverrideImpl(input);
  if (result.ok && typeof input === "object" && input !== null) {
    const tenantId = (input as { tenantId?: string }).tenantId;
    if (tenantId) {
      revalidatePath(`/platform/tenants/${tenantId}/configure`);
      revalidatePath(`/platform/tenants/${tenantId}`);
    }
    revalidatePath("/platform/config");
  }
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

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE ONE THING THESE TWO WRAPPERS DECIDE, AND WHY IT IS NOT A CHECK
 * ══════════════════════════════════════════════════════════════════════
 * `staff:manage` is on `STEP_UP_CAPABILITIES`, so `requireCapability()`
 * inside the implementation THROWS `PlatformAccessError("step_up_
 * required")` when the operator has not proved a second factor recently.
 * Next.js redacts a thrown server-action error in production and hands
 * the browser a digest — so the operator, whose problem has a
 * thirty-second remedy sitting on the same screen, is told "an
 * unexpected error occurred" and reloads the page, losing the reason
 * they had just typed.
 *
 * ⚠️ THIS IS NOT THE WRAPPER DOING AUTHORISATION. The check already ran,
 * in `grantPlatformStaff`/`revokePlatformStaff`, and it already refused.
 * Nothing here can make a refusal into a permission — the only thing
 * that changes is whether the refusal arrives as data the form can
 * render. Same argument, same shape, as `capabilityOrStepUp` in
 * `server/platform/configuration.ts`, which is where this pattern was
 * settled.
 *
 * ⚠️ AND ONLY THAT ONE CODE IS CAUGHT. `capability_denied` and
 * `not_platform_staff` keep throwing, deliberately: `PlatformAccessError`
 * exists to make those two indistinguishable from each other, and
 * turning either into a specific message here would hand a prober the
 * difference between "you are not staff" and "your grade is too low".
 */
async function stepUpAware<T>(
  run: () => Promise<T>,
): Promise<T | { ok: false; error: string; needsStepUp: true }> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof PlatformAccessError && error.code === "step_up_required") {
      return {
        ok: false,
        error:
          "Confirm your identity before changing who holds platform access, then try again.",
        needsStepUp: true,
      };
    }
    throw error;
  }
}

export async function grantPlatformStaffAction(input: unknown) {
  return stepUpAware(async () => {
    const result = await grantPlatformStaffImpl(input);
    if (result.ok) revalidatePath("/platform/staff");
    return result;
  });
}

export async function revokePlatformStaffAction(input: unknown) {
  return stepUpAware(async () => {
    const result = await revokePlatformStaffImpl(input);
    if (result.ok) revalidatePath("/platform/staff");
    return result;
  });
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

/* ------------------------------------------------------------------ */
/* USERS — v0.83.1                                                     */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THESE TWO WRAPPERS WERE MISSING, AND THEIR ABSENCE BROKE THE BUILD
 * ══════════════════════════════════════════════════════════════════════
 * `components/platform/user-actions.tsx` is a `"use client"` component. It
 * imported `updateUserStatus` and `updateUserRole` STRAIGHT FROM
 * `./users`, skipping this file entirely — which is the one layer that
 * makes a server function callable from a browser.
 *
 * tripwire whose entire purpose is to fail the build when a server module
 * is pulled toward a client bundle, and it did exactly that:
 *
 *     ./components/platform/user-actions.tsx
 *
 *     > Build failed because of webpack errors
 *
 * tried. It does not work and it is dangerous:
 *
 *   • It removes the alarm, not the fault. The client component still
 *     reaches `guard.ts`, which uses `withPlatformScope()` — the
 *     deliberate CROSS-TENANT read escape hatch, the one whose own
 *     comments call it "deliberately verbose so it is easy to grep for in
 *     a security review". That path must never travel toward a browser.
 *   • It does not even compile. Strip it from `users.ts` and the same
 *     error reappears in `guard.ts`, which also imports `next/headers` —
 *     and that genuinely cannot exist client-side. Deletion just moves the
 *     error one file deeper until something ships that should not.
 *
 * The correct fix is the house rule stated at the top of this file: a
 * client calls a `"use server"` wrapper, and the wrapper delegates to a
 * are thin for exactly that reason — `updateUserStatusImpl` already calls
 * `requireCapability("tenants:suspend")` and `updateUserRoleImpl` already
 * calls `requireCapability("tenants:configure")`. Nothing is decided here.
 *
 * ⚠️ AND REMEMBER WHAT `"use server"` MEANS: both of these are now public
 * HTTP endpoints with stable action ids, reachable by POST from any page.
 * That is safe ONLY because the capability check lives in the
 * implementation. Do not add a check here and remove it there.
 */
export async function updateUserStatusAction(input: {
  userId: string;
  tenantId: string;
  status: string;
}) {
  const result = await updateUserStatusImpl(input);
  if (result.ok) revalidatePath("/platform/users");
  return result;
}

export async function updateUserRoleAction(input: {
  userId: string;
  tenantId: string;
  role: string;
}) {
  const result = await updateUserRoleImpl(input);
  if (result.ok) revalidatePath("/platform/users");
  return result;
}
