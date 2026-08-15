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
