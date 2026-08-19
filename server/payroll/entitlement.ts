import "server-only";

/**
 * Ordence — ⭐⭐⭐ THE PAYROLL ENTITLEMENT GATE
 * Version: v1.68.0-alpha · Batch 0109
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT WAS ACTUALLY WRONG
 * ══════════════════════════════════════════════════════════════════════
 * `hr.payroll` sits at `advanced` in the price list. Payroll runs,
 * payslips, LOP in centidays, the regime election from 0095, the advances
 * ledger from 0096 and the wage-payment axis from 0094 are all built, and
 * until this batch NOTHING ASKED THE QUESTION. Every plan ran payroll,
 * including the free one. `lib/modules/registry.ts` marks the payroll nav
 * `feature: "hr.payroll"`, so the menu item was hidden on Basic — and a
 * hidden menu item is not a gate. `server/actions/payroll.ts` is a
 * `"use server"` module: every export is a browser-reachable endpoint
 * whether or not a screen renders a button for it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 WHY THIS IS NOT `requireFeature("hr.payroll")` AND MUST NOT BE
 * ══════════════════════════════════════════════════════════════════════
 * `effectiveTier()` drops a workspace whose subscription has lapsed to
 * `LAPSED_EFFECTIVE_TIER`, which is `basic`. A bare `requireFeature`
 * would therefore refuse payroll to a paying Advanced customer whose card
 * expired — and that is the exact scenario the rest of this system is
 * built to survive:
 *
 *   `lib/billing/grace.ts` exempts every `payroll:` write from the
 *   dunning restriction, and the test that pins it says why in one line:
 *   "Card failed on the 5th, payroll due on the 7th."
 *
 * The provident-fund deadline is the 15th, the ESI deadline is the 15th,
 * and s.192 TDS is due by the 7th. None of those move because a
 * sixteen-digit number reached its printed expiry date. A gate that let
 * a failed card become an unpaid statutory liability would have taken a
 * commercial problem and made it a legal one, for the customer, using
 * our software.
 *
 * ⭐ SO THE QUESTION THIS ASKS IS "WHAT DID THIS WORKSPACE CONTRACT FOR?"
 * and never "what is it allowed to reach today?". A lapsed Advanced
 * workspace keeps payroll and gets the dunning banner like everything
 * else. A Basic workspace never had it and does not get it.
 *
 * ⚠️ AN EXPLICIT REVOCATION STILL BITES, because `evaluateFeature` checks
 * the override before the tier. That is right: a revoke is a human act
 * for a stated reason — abuse, a regulatory hold — not an accident of
 * billing, and its message already refuses to offer an upgrade.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHERE THE GATE GOES, AND WHERE IT MUST NOT
 * ══════════════════════════════════════════════════════════════════════
 * `lib/entitlements/enforcement.ts` stated the rule before the gate
 * existed, and it is the right rule:
 *
 *   "the gate belongs on CREATING a run — never on approving or posting
 *    one that already exists."
 *
 * A plan change on the 12th must not strand a half-computed salary run
 * with PF, ESI and TDS already calculated against it. So:
 *
 *   GATED    saveEmployee, seedPayrollSetup, setPayStructure,
 *            openPayrollRun, grantAdvance, submitReimbursementClaim
 *            — every one of these STARTS a new commitment.
 *
 *   UNGATED  computePayrollRun, approvePayrollRun, postPayroll,
 *            cancelPayrollRun, recoverInstalment — every one of these
 *            FINISHES something already begun. Refusing them strands
 *            money that is owed to a person.
 *
 *   UNGATED  every list, every get, and `myPayslips`. See below.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE READ SIDE IS NOT NEGOTIABLE
 * ══════════════════════════════════════════════════════════════════════
 * A workspace with four hundred employees that drops to Basic still owns
 * every payslip it has ever issued, and its people still need Form 16
 * figures years later. `permitsExport()` returns true at EVERY access
 * level for the same reason, and `analytics.export` is marked "never
 * gate" in the ledger. Nothing here refuses a read, and a future edit
 * that adds one is a data-protection problem rather than a pricing
 * decision.
 */

import {
  evaluateFeature,
  TRIAL_EFFECTIVE_TIER,
  type EntitlementDecision,
} from "@/lib/entitlements/features";
import {
  FeatureLockedError,
  getEntitlementContext,
} from "@/server/entitlements";
import type { TenantContext } from "@/server/tenant-context";
import type { PlanTier } from "@/db/schema/core";

/**
 * ⚠️ SPELLED AS A MODULE CONSTANT ON PURPOSE.
 *
 * `tests/ui/entitlement-enforcement.test.ts` reads the source tree to
 * prove that a key the ledger calls `gated` is genuinely read by server
 * code. `FEATURE = "<key>"` is one of the spellings it recognises, so
 * writing it this way keeps this gate visible to the ledger instead of
 * making the ledger's own test lie about it — which is precisely the
 * fault this batch found in five other keys.
 */
const FEATURE = "hr.payroll" as const;

/**
 * The tier the workspace CONTRACTED for.
 *
 * ⚠️ `planTier`, not `effectiveTier`. The difference is the whole point
 * of this module and it is one line, so it is stated rather than left to
 * be re-derived by whoever reads it next.
 *
 * A `trial` workspace is treated as Advanced exactly as it is everywhere
 * else — a prospect evaluating the product must be able to run a test
 * payroll, or they are evaluating a product that cannot do the thing
 * they are buying it for.
 */
function contractedTier(planTier: PlanTier): PlanTier {
  return planTier === "trial" ? TRIAL_EFFECTIVE_TIER : planTier;
}

/**
 * Non-throwing. For rendering a payroll screen read-only with an upgrade
 * prompt beside it, which is what a downgraded workspace should see.
 */
export async function checkPayrollEntitlement(
  ctx?: TenantContext,
): Promise<EntitlementDecision> {
  const entitlements = await getEntitlementContext(ctx);

  return evaluateFeature(FEATURE, {
    planTier: contractedTier(entitlements.planTier),
    /**
     * ⚠️ HARD `true`, AND THIS IS THE STATUTORY EXEMPTION IN ONE ARGUMENT.
     *
     * Passing the real value would re-introduce the lapse downgrade
     * through `effectiveTier()` and undo everything the docblock above
     * argues for. Standing is answered by `requireAccess()`, which runs
     * first at every write site and has its own payroll exemption; this
     * gate answers only "is payroll in the plan they bought?".
     */
    subscriptionGrantsAccess: true,
    overrides: entitlements.overrides,
  });
}

/**
 * Throwing. The first statement of every payroll write that STARTS
 * something.
 */
export async function requirePayrollEntitlement(
  ctx?: TenantContext,
): Promise<EntitlementDecision> {
  const decision = await checkPayrollEntitlement(ctx);
  if (!decision.allowed) throw new FeatureLockedError(decision, null);
  return decision;
}
