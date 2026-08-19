import "server-only";

/**
 * Ordence — ⭐⭐⭐ THE EXECUTOR REGISTRY, IN ONE PLACE
 * Version: v1.58.0-alpha (Batch 43)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 WHY THIS FILE EXISTS AT ALL, WHEN THE REGISTRATIONS USED TO LIVE
 *      IN `control-actions.ts`
 * ══════════════════════════════════════════════════════════════════════
 * `queueForApproval` REFUSES a kind with no registered executor, and that
 * refusal is load-bearing: it is the one thing stopping a policy from
 * filling the screen with pending rows that would never run. See its own
 * header.
 *
 * ⚠️ WHICH MEANS REGISTRATION IS NOT A DETAIL — IT IS A PRECONDITION FOR
 * QUEUEING AT ALL. While the only request paths were `requestSuspend` and
 * `requestTermination`, both of which live in `control-actions.ts`
 * alongside the registrations, that was self-satisfying. Batch 43 moved
 * three request paths INTO the writing functions — `flags.ts`,
 * `configuration.ts`, `staff.ts` — and those modules are reachable from
 * server actions that never import `control-actions.ts`. A plan change
 * would have been held, tried to queue, and been told "nothing in this
 * build can carry that out" — which is the most confusing possible
 * failure, because it is a true sentence about an untrue situation.
 *
 * ⭐ SO EVERY MODULE THAT CAN QUEUE IMPORTS THIS ONE FOR ITS SIDE EFFECT,
 * and this one imports NOTHING that could import it back.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️⚠️ THE IMPLEMENTATIONS ARE LOADED WITH `await import()`, ON PURPOSE
 * ══════════════════════════════════════════════════════════════════════
 * A static `import { setTenantFlag } from "./flags"` here would be a
 * cycle the moment `flags.ts` imports this file for the registration —
 * and the failure mode of a module cycle is not a build error, it is a
 * binding that is `undefined` on some import orders and correct on
 * others, which is a bug that reproduces on one machine.
 *
 * ⭐ AND IT COSTS NOTHING. An executor body runs at most once per
 * approval, minutes or hours after the module loaded; the import is
 * cached from then on. What it buys is that this file has exactly one
 * static dependency and therefore cannot participate in a cycle at all.
 */

import { registerApprovalExecutor } from "./approvals";

/* ------------------------------------------------------------------ */
/* THE TWO THAT ARE RAISED BY A WRAPPER                                */
/* ------------------------------------------------------------------ */

/**
 * 🔴 THESE TWO TAKE NO TICKET, and the asymmetry is deliberate rather
 * than an omission. `suspendTenant` and `scheduleTenantTermination` are
 * not exported as server actions and are not called from anywhere else:
 * the executor is their only caller, so there is no second door for a
 * gate to guard. The three below are the opposite case — each has two or
 * three existing callers — which is why their gate is inside them.
 */
registerApprovalExecutor("tenant.suspend", async (payload) => {
  const { suspendTenant } = await import("./tenants");
  const result = await suspendTenant(payload);
  return result.ok ? { ok: true } : { ok: false, error: result.error };
});

/**
 * ⚠️ THE EXECUTOR SCHEDULES. IT DOES NOT DELETE. Approving a termination
 * writes a date, locks the workspace read-only and starts a cancel
 * window — see the offboarding header in `tenants.ts` for why the window,
 * and not the confirmations, is the control that protects anybody.
 */
registerApprovalExecutor("tenant.terminate", async (payload) => {
  const { scheduleTenantTermination } = await import("./tenants");
  const result = await scheduleTenantTermination(payload);
  return result.ok ? { ok: true } : { ok: false, error: result.error };
});

/* ------------------------------------------------------------------ */
/* THE THREE THAT ARE RAISED BY THE WRITE ITSELF — BATCH 43            */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ ONE POLICY, TWO WRITERS, AND THE PAYLOAD SAYS WHICH
 * ══════════════════════════════════════════════════════════════════════
 * An `entitlement:` key is written from two genuinely different places
 * with genuinely different arguments: the flag panel goes through
 * `setTenantFlag` (a key, a boolean, an expiry) and the module
 * switchboard goes through `setModuleEntitlement` (a feature, a mode of
 * grant/revoke/CLEAR, where clear DELETES the row rather than writing
 * false).
 *
 * 🔴 COLLAPSING THEM INTO ONE SHAPE WOULD BE THE BUG. "Clear" and
 * "revoke" look identical on the day they are applied and differ forever
 * afterwards — absence means the plan decides, `false` means it does not,
 * and an upgrade the customer paid for would silently do nothing. So the
 * queue row records which writer raised it and the approval replays into
 * that same writer, with the same arguments, exactly as the wrapper-style
 * executors do.
 *
 * ⚠️ `writer` IS READ FROM THE STORED PAYLOAD, WHICH ONLY THE SERVER EVER
 * WROTE. It is not an input; the request path sets it beside the
 * validated arguments and nothing else can reach that column.
 */
registerApprovalExecutor("entitlement.override_paid", async (payload, ticket) => {
  const shape = (payload ?? {}) as { writer?: string };

  if (shape.writer === "module") {
    const { setModuleEntitlement } = await import("./configuration");
    const result = await setModuleEntitlement(payload, ticket);
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  }

  const { setTenantFlag } = await import("./flags");
  const result = await setTenantFlag(payload, ticket);
  return result.ok ? { ok: true } : { ok: false, error: result.error };
});

registerApprovalExecutor("staff.elevate", async (payload, ticket) => {
  const { grantPlatformStaff } = await import("./staff");
  const result = await grantPlatformStaff(payload, ticket);
  return result.ok ? { ok: true } : { ok: false, error: result.error };
});

registerApprovalExecutor("tenant.plan_change", async (payload, ticket) => {
  const { setPlanAndLimits } = await import("./configuration");
  const result = await setPlanAndLimits(payload, ticket);
  return result.ok ? { ok: true } : { ok: false, error: result.error };
});

/**
 * ⚠️ `impersonate.break_glass` IS ABSENT AND MUST STAY ABSENT. Read
 * `BLOCKED_BECAUSE` in `lib/platform/approvals.ts` before adding it: an
 * executor runs inside the APPROVER's request, and `startImpersonation`
 * binds the session it creates to whoever is calling. Approving a queued
 * break-glass would open the customer's workspace for the approver rather
 * than for the engineer who needs it, and would name the wrong person in
 * the email the customer receives. That is not a gap to close; it is a
 * design constraint, and closing it the obvious way ships a worse control
 * than none.
 */

/**
 * ⭐ IMPORTED FOR THE SIDE EFFECT, so a linter that removes "unused"
 * imports has something to keep. Every module that can queue does
 * `import "./approval-executors"`.
 */
export const APPROVAL_EXECUTORS_REGISTERED = true;
