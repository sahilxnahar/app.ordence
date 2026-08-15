/**
 * Ordence — ⭐⭐⭐ THE POLICY LIST THAT STOPPED CLAIMING SIX
 * Version: v1.32.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 WHAT THIS REPLACED, AND WHY IT WAS THE WORST KIND OF BUG
 * ══════════════════════════════════════════════════════════════════════
 * `app/platform/approvals/page.tsx` used to map straight over
 * `APPROVAL_POLICIES` and print all six under "What is held, and why".
 * Every sentence was accurate about the constant. One of the six was
 * accurate about the system.
 *
 * ⚠️ A CONTROL THAT DOES NOTHING IS WORSE THAN A MISSING ONE. A missing
 * control produces a question — "so what stops somebody terminating a
 * workspace by accident?" — and the question gets answered. A dead
 * control answers it first, wrongly, and it is never asked again. The
 * auditor reads the same screen, ticks the same box, and the gap is now
 * documented as covered.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ SO THE STATUS IS DERIVED FROM THE RUNNING SYSTEM, NOT TYPED HERE
 * ══════════════════════════════════════════════════════════════════════
 * Every row's badge comes from `enforcementReport()` in
 * `server/platform/approvals.ts`, which reads the live executor registry
 * and the declared request paths. This file cannot say a policy is
 * enforced; it can only render what the server found. That matters
 * because the failure being fixed is precisely a screen that knew
 * something the code did not.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️⚠️ THERE IS NO ON/OFF SWITCH ON THIS SCREEN, ON PURPOSE
 * ══════════════════════════════════════════════════════════════════════
 * The obvious way to make a policy list "do something" is a toggle per
 * row. It is the wrong thing to build here, for two independent reasons
 * and either one is enough:
 *
 *   ① NOTHING PERSISTS IT. There is no platform-settings table, and the
 *      policies are frozen constants compiled into the build. A switch
 *      would flip a value that resets on the next request, which is a
 *      more convincing lie than the one being fixed.
 *
 *   ② IT IS THE CONTROL'S OWN FAILURE MODE. A four-eyes requirement an
 *      operator can switch off is switched off at the exact moment it
 *      becomes inconvenient — the incident, the midnight suspension, the
 *      customer shouting. That is the moment it exists for. The way to
 *      stop holding an action is to change the code and ship it, where
 *      somebody reviews the diff.
 *
 * ⭐ SO THE SCREEN SAYS THAT OUT LOUD rather than leaving the absence to
 * be read as an oversight.
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { PolicyEnforcement } from "@/lib/platform/approvals";

/**
 * ⚠️ THE SERVER'S TYPE, NOT A LOCAL COPY OF IT. A parallel `type
 * PolicyEnforcementView = { ... }` declared here would compile happily
 * while `enforced` and `hasRequestPath` drifted apart in meaning, which
 * is a subtler version of the bug this whole component exists to fix.
 */
export type PolicyEnforcementView = PolicyEnforcement;

/**
 * ⚠️ THE TWO HALVES ARE NAMED SEPARATELY, because they fail differently
 * and the difference is the whole diagnosis.
 *
 * · No request path, executor present — the dangerous action still has
 *   its old immediate door. Clicking it does the thing. This is the
 *   shape `entitlement.override_paid` is in, and the shape that reads
 *   most like enforcement from the outside.
 *
 * · No executor — an approved request would refuse to run. Since
 *   v1.32.0 `queueForApproval` will not even accept one, so this state
 *   means the policy cannot be raised at all.
 */
function statusOf(p: PolicyEnforcementView): { text: string; tone: "on" | "off" } {
  if (p.enforced) return { text: "Enforced", tone: "on" };
  if (!p.hasExecutor && !p.hasRequestPath) return { text: "Not enforced", tone: "off" };
  if (!p.hasRequestPath) return { text: "Not enforced — nothing raises it", tone: "off" };
  return { text: "Not enforced — nothing can carry it out", tone: "off" };
}

export function ApprovalPolicyBoard({
  policies,
}: {
  policies: readonly PolicyEnforcementView[];
}) {
  const enforced = policies.filter((p) => p.enforced);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">
          What is held, and what is not
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/*
          ⭐ THE COUNT IS THE HEADLINE, and it is stated as a fraction
          rather than as a number of successes. "One of six" is a
          sentence somebody acts on; "1 policy enforced" is a metric
          somebody scrolls past.
        */}
        <p
          className="rounded border border-dashed p-3 text-xs"
          data-testid="approval-enforcement-summary"
        >
          <span className="font-medium">
            {enforced.length} of {policies.length} of these policies is enforced today.
          </span>{" "}
          The rest are listed because they are the right list, not because
          they are switched on. Each one below says what has to exist before
          it can apply, and until then the action it names still happens
          immediately. Do not read this page as coverage.
        </p>

        {policies.map((p) => {
          const status = statusOf(p);
          return (
            <div key={p.kind} className="space-y-1 border-t pt-3 text-xs first:border-t-0 first:pt-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{p.label}</span>
                <Badge
                  variant={status.tone === "on" ? "secondary" : "outline"}
                  data-testid={`policy-status-${p.kind}`}
                >
                  {status.text}
                </Badge>
                <span className="text-muted-foreground">
                  {p.approverGrade} approves · expires in {p.expiryHours}h
                </span>
              </div>

              <p className="text-muted-foreground">{p.because}</p>

              {p.enforced ? (
                <p className="text-muted-foreground">
                  Raised by: {p.requestPath}
                </p>
              ) : (
                /*
                  🔴 THE PRECONDITION, NOT AN APOLOGY. "This policy will
                  apply once X exists" is a sentence an operator can plan
                  around and an auditor can chase. "Coming soon" is not.
                */
                <p
                  className="rounded border border-amber-400 p-2"
                  data-testid={`policy-blocked-${p.kind}`}
                >
                  <span className="font-medium">Not enforced today. </span>
                  {p.blockedBecause}
                </p>
              )}
            </div>
          );
        })}

        <div className="space-y-2 border-t pt-3 text-xs text-muted-foreground">
          {/*
            ⚠️ THE ABSENCE OF A SWITCH IS STATED, because an absence that
            is not explained gets read as an oversight and somebody
            helpfully adds one.
          */}
          <p>
            <span className="font-medium">
              None of these can be switched off from this console, and there
              is no setting elsewhere that does it either.
            </span>{" "}
            A four-eyes requirement an operator can disable is disabled at
            the moment it becomes inconvenient, which is the moment it
            exists for. Changing this list means changing the code and
            shipping it, where somebody reads the diff.
          </p>
          <p>
            Deliberately absent from the list entirely: provisioning,
            consented read-only impersonation, and overrides on trial
            workspaces. All three are routine and reversible, and a queue
            that fires on routine work is a queue people learn to
            rubber-stamp.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
