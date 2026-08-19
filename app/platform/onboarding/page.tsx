/**
 * Ordence — Platform Console · ⭐⭐⭐ ONBOARDING PROGRESS
 * Version: v1.52.0-alpha
 * Runtime: Node
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHICH NEW WORKSPACE HAS STALLED, WHILE IT CAN STILL BE RESCUED
 * ══════════════════════════════════════════════════════════════════════
 * A customer stuck on step 3 for nine days is churn that has not happened
 * yet, and until this screen existed nothing in Ordence surfaced them.
 * The directory sorts by creation date; the health rules watch workspaces
 * that are USING the product, and a workspace that never finished setup
 * generates no activity for those rules to notice. They were invisible in
 * exactly the window where a phone call still works.
 *
 * ⚠️ THE STEPS ON THIS SCREEN ARE THE STEPS IN
 * `server/actions/onboarding.ts` — four of them, listed in
 * `lib/platform/onboarding-progress.ts` with the action that completes
 * each one named beside it. They are not a plausible-looking funnel
 * somebody invented for a dashboard.
 *
 * ⚠️ NO POLLING HERE, DELIBERATELY. `refreshMs` exists on the table and
 * is not used: a stall clock measured in days does not change while you
 * look at it, and a console tab that re-queries every workspace's audit
 * history on a timer costs the database far more than it tells anybody.
 */

import { listOnboardingProgress, markOnboardingForCall } from "@/server/platform/onboarding";
import { OnboardingBoard } from "@/components/platform/onboarding-board";
import { onConsoleHost } from "@/lib/platform/console-href";
import {
  ONBOARDING_STEPS,
  ONBOARDING_TOTAL_STEPS,
  STALL_THRESHOLD_DAYS,
} from "@/lib/platform/onboarding-progress";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

/**
 * 🔴 ONE HOP TO THE GUARD. This inline action does nothing but hand the
 * input to `markOnboardingForCall`, whose first line is
 * `requireCapability("tenants:read")`. No validation, no branching and no
 * database access happens on this side of that call.
 */
async function markForCall(input: { tenantId: string; note: string }) {
  "use server";
  const result = await markOnboardingForCall(input);
  return result.ok ? ({ ok: true } as const) : ({ ok: false, error: result.error } as const);
}

export default async function OnboardingProgressPage() {
  const [result, isConsole] = await Promise.all([listOnboardingProgress(), onConsoleHost()]);

  if (!result.ok) {
    return (
      <Card>
        <CardContent className="pt-6 text-sm text-destructive">{result.error}</CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Onboarding progress</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Workspaces that have not finished setup, worst first. The big number
          is whole days since the customer last completed a step — not since we
          last touched the row, which is why an operator opening a workspace
          does not reset its clock.
        </p>
      </div>

      <OnboardingBoard
        rows={result.data.rows}
        isConsoleHost={isConsole}
        onMarkForCall={markForCall}
        truncated={result.data.truncated}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">
            The {ONBOARDING_TOTAL_STEPS} steps, and what &ldquo;stalled&rdquo; means
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-xs text-muted-foreground">
          <ol className="space-y-1">
            {ONBOARDING_STEPS.map((step) => (
              <li key={step.number}>
                <strong className="text-foreground">
                  {step.number}. {step.label}
                </strong>{" "}
                — {step.blocker}
              </li>
            ))}
          </ol>
          <p className="border-t pt-2">
            <strong className="text-foreground">Stalled</strong> ={" "}
            {STALL_THRESHOLD_DAYS} whole days or more since the last completed
            step, floored and never rounded. One day is noise — somebody who
            starts at 18:00 and finishes next morning is a normal customer.
            Three survives a weekend: a step finished on Friday afternoon and
            picked up Monday morning is a gap of about 2.7 days, which floors to
            2 and is not flagged. Seven is too late — by then the trial has
            burned a quarter of itself and the call changes from &ldquo;shall I
            walk you through it&rdquo; to &ldquo;do you still want this&rdquo;.
          </p>
          <p>
            The badge above the table and every row use one function,{" "}
            <code>isStalled</code>, so a count and a list here cannot disagree.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
