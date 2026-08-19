"use server";

/**
 * Ordence — Workspace Configuration Server Actions
 * Version: v0.53.0 · Sections C, D and E
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ EVERY EXPORT HERE IS A PUBLIC HTTP ENDPOINT
 * ══════════════════════════════════════════════════════════════════════
 * Same contract as `server/platform/actions.ts`, restated because this
 * file is where somebody adding a fourth screen will look. `"use server"`
 * publishes each exported function with a stable action id; the
 * middleware matcher on `/platform(.*)` DOES NOT protect it, because a
 * server action is a POST to whatever page the browser happens to be on.
 * The gate has to be inside the implementation, and it is —
 * `server/platform/configuration.ts` calls `requireCapability()` on every
 * one of these before it reads or writes anything.
 *
 * Two house rules, both load-bearing:
 *
 *   1. ONLY ASYNC FUNCTIONS ARE EXPORTED. A `"use server"` file that
 *      exports a constant fails the production build — and if it did not,
 *      it would publish that constant as a callable endpoint. The schemas
 *      and the pure model live in `lib/platform/configuration.ts`.
 *
 *   2. THESE ARE THIN. No decisions here. A wrapper that does half the
 *      checking is a wrapper somebody eventually calls the inner function
 *      around.
 *
 * ⚠️ `revalidatePath` IS NOT COSMETIC ON THIS SCREEN. The whole point of
 * the module switchboard is that it shows the state the customer is
 * actually in; a stale render after a write is the exact failure the
 * "default vs override" distinction exists to prevent.
 */

import { revalidatePath } from "next/cache";

import {
  setModuleEntitlement as setModuleEntitlementImpl,
  setPlanAndLimits as setPlanAndLimitsImpl,
  setTenantIndustry as setTenantIndustryImpl,
} from "./configuration";

function revalidateTenant(tenantId: string): void {
  revalidatePath(`/platform/tenants/${tenantId}/configure`);
  revalidatePath(`/platform/tenants/${tenantId}`);
  revalidatePath("/platform/tenants");
  revalidatePath("/platform");
}

/* ------------------------------------------------------------------ */
/* C · MODULE SWITCHES                                                 */
/* ------------------------------------------------------------------ */

export async function setModuleEntitlementAction(input: {
  tenantId: string;
  feature: string;
  mode: "grant" | "revoke" | "clear";
  reason: string;
  expiresAt: string | null;
}) {
  const result = await setModuleEntitlementImpl(input);
  if (result.ok) revalidateTenant(input.tenantId);
  return result;
}

/* ------------------------------------------------------------------ */
/* D · PLAN AND LIMITS                                                 */
/* ------------------------------------------------------------------ */

export async function setPlanAndLimitsAction(input: {
  tenantId: string;
  planTier: string;
  seatLimit: number;
  storageLimitMb: number;
  acceptOverCommit: boolean;
  reason: string;
}) {
  const result = await setPlanAndLimitsImpl(input);
  if (result.ok) revalidateTenant(input.tenantId);
  return result;
}

/* ------------------------------------------------------------------ */
/* E · INDUSTRY                                                        */
/* ------------------------------------------------------------------ */

export async function setTenantIndustryAction(input: {
  tenantId: string;
  industry: string;
  confirmSlug: string;
  reason: string;
}) {
  const result = await setTenantIndustryImpl(input);
  if (result.ok) revalidateTenant(input.tenantId);
  return result;
}
