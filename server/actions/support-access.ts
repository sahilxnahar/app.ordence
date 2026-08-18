"use server";

/**
 * Ordence — ⭐⭐ THE CUSTOMER'S SIDE OF SUPPORT CONSENT
 * Version: v1.40.0-alpha (Mega-wave 2, Batch 41)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 NO SCREEN ANYWHERE GRANTED CONSENT, SO EVERY VISIT WAS BREAK-GLASS
 * ══════════════════════════════════════════════════════════════════════
 * `server/platform/consent.ts` is complete. It has both modes, the role
 * rules, an expiry per mode, and a circularity gate that stops an
 * operator inside a live session writing themselves a ninety-day
 * standing permission. `grantSupportConsent`, `revokeSupportConsent` and
 * `getSupportConsentState` had ZERO callers. Only `hasLiveConsent` was
 * used, by the console, to display a permission that could never exist.
 *
 * ⚠️ THE CONSEQUENCE IS NOT "SUPPORT IS BLOCKED". Support worked fine,
 * through break-glass, which is the emergency path. The design
 * deliberately separates:
 *
 *   ROUTINE   consented, scoped, quiet, ordinary in the log
 *   EMERGENCY break-glass, loud, reviewed, rare
 *
 * With no way to grant consent, those two collapsed into one. Every
 * legitimate support visit looked like an emergency, which destroys
 * exactly the signal the emergency path exists to carry: after the
 * fiftieth break-glass entry, the fifty-first stops being read.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHY THIS FILE EXISTS RATHER THAN CALLING consent.ts DIRECTLY
 * ══════════════════════════════════════════════════════════════════════
 * `consent.ts` is `import "server-only"`, not `"use server"`. Its
 * exports are functions, not RPC endpoints, which is correct: it is
 * reached from both the tenant app and the console and should not
 * publish itself to the browser by accident.
 *
 * This file is the tenant-side door, and it is deliberately thin. Every
 * rule stays in `consent.ts`, where the console's own path also sees it.
 * A wrapper that re-implemented a role check would be a second opinion
 * about who may say yes, and the two would eventually disagree.
 */

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/audit";
import {
  grantSupportConsent,
  revokeSupportConsent,
  getSupportConsentState,
  type ConsentView,
} from "@/server/platform/consent";
import { endSupportSession as endSupportSessionImpl } from "@/server/platform/tenant-support-access";
import { stopImpersonation as stopImpersonationImpl } from "@/server/platform/impersonation";
import type { PlatformResult } from "@/lib/platform/schemas";

/**
 * ⚠️ THE PERMISSION GUARD HERE IS NOT DUPLICATION, AND `check:guards`
 * WAS RIGHT TO DEMAND IT.
 *
 * ══════════════════════════════════════════════════════════════════════
 * A ROLE CHECK AND A PERMISSION CHECK ANSWER DIFFERENT QUESTIONS.
 * ══════════════════════════════════════════════════════════════════════
 * `consent.ts` checks `ctx.role`: owner for standing, owner or admin for
 * incident. That is a rule about WHO MAY SAY YES, and it is the right
 * rule and it stays where it is, so the console's path sees it too.
 *
 * 🔴 BUT `requireTenantContext()` ALONE ANSWERS "who are you", NOT "may
 * you do this". Every export of a `"use server"` module is a URL. A
 * mutation reachable by any authenticated member of the workspace,
 * relying on a role comparison further down a call chain, is exactly the
 * shape the guard gate exists to refuse. If `consent.ts` were ever
 * refactored so a branch returned before the role check, this endpoint
 * would become open and nothing would fail.
 *
 * ⭐ SO THE DOOR ASKS A PERMISSION AND THE ENGINE ASKS A ROLE. Two
 * independent reasons, both of which must hold.
 */
const MANAGE = "settings:update" as const;

export async function grantSupportAccess(
  input: unknown,
): Promise<PlatformResult<{ consentId: string; expiresAt: string }>> {
  await requirePermission(MANAGE);
  const result = await grantSupportConsent(input);
  if (result.ok) revalidatePath("/settings/support-access");
  return result;
}

/**
 * ⭐ REVOCATION IS NOT GUARDED MORE TIGHTLY THAN GRANTING, ON PURPOSE.
 *
 * ⚠️ A customer who wants support out of their workspace must be able to
 * get them out immediately. Requiring the owner to revoke when an admin
 * could grant would mean the person able to close the door is asleep
 * exactly when somebody wants it closed, and the workaround for that is
 * a support call asking us to revoke our own access.
 */
export async function revokeSupportAccess(
  input: unknown,
): Promise<PlatformResult<void>> {
  await requirePermission(MANAGE);
  const result = await revokeSupportConsent(input);
  if (result.ok) revalidatePath("/settings/support-access");
  return result;
}

export async function listSupportAccess(): Promise<PlatformResult<ConsentView[]>> {
  return getSupportConsentState();
}

/* ------------------------------------------------------------------ */
/* ⭐⭐ ENDING A LIVE SESSION — Batch 28                                */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ ENDING A SESSION IS NOT REVOKING CONSENT, AND CONFLATING THEM WOULD
 *    BE A REAL MISTAKE
 * ══════════════════════════════════════════════════════════════════════
 * The two exports above manage the CONSENT — a durable, ninety-day
 * standing permission, or a sixty-minute incident approval. The two
 * below end ONE LIVE SESSION and leave the permission untouched.
 *
 * They are separate because the situations are separate. "Please step
 * out of my workspace for ten minutes while I take this call" and "I
 * withdraw support's access to my company's data" are different
 * sentences with different consequences, and a customer who wanted the
 * first should not have to re-grant a ninety-day permission afterwards.
 *
 * ⭐ TWO EXPORTS AND NOT ONE, because they are performed by different
 * people under different authority and are recorded as different things:
 *
 *   `endSupportSessionAction`   the CUSTOMER ends our access.
 *                               `requireRole(ADMIN_ROLES)` in their own
 *                               workspace → filed as `revoked_by_tenant`.
 *   `leaveSupportSessionAction` OUR OPERATOR chooses to leave.
 *                               `requirePlatformAdmin()` plus a match on
 *                               the session's own actor → filed as
 *                               `operator_ended`.
 *
 * One endpoint with an `if` would have made the register's answer to
 * "who ended this" depend on a branch nobody reads.
 */
export async function endSupportSessionAction(input: unknown) {
  const result = await endSupportSessionImpl(input);
  if (result.ok) {
    // ⚠️ `"layout"`, not the default `"page"`. The banner is rendered by
    // the CRM layout, so revalidating only the current page would leave
    // it on screen describing access that has stopped.
    revalidatePath("/", "layout");
  }
  return result;
}

/**
 * The operator leaves, from inside the customer's workspace.
 *
 * ⭐ THIS IS WHY IT LIVES HERE AND NOT ONLY IN THE CONSOLE. An operator
 * inside a workspace is looking at the CRM, and the console layout — with
 * its own banner and its own end button — is not rendered on those routes
 * at all. Before this, the only way out was to navigate back to
 * `admin.ordence.com` and find a control, and the moment somebody most
 * needs to leave is the moment they should not have to navigate anywhere.
 */
export async function leaveSupportSessionAction(input: unknown) {
  const result = await stopImpersonationImpl(input);
  if (result.ok) revalidatePath("/", "layout");
  return result;
}
