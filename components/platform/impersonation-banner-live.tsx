"use client";

/**
 * Ordence — The Live Impersonation Banner
 * Version: v1.52.0-alpha (Batch 28)
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS THIN WRAPPER EXISTS
 * ══════════════════════════════════════════════════════════════════════
 * `ImpersonationBanner` is deliberately dumb: props in, pixels out, no
 * fetching, no privilege, trivially testable. The console still needs an
 * END SESSION button in the bar itself, and wiring a server action to it
 * requires a client boundary somewhere. This is that boundary.
 *
 * ⭐ WHY THE BUTTON HAS TO BE IN THE BAR. Before this, ending a session
 * meant navigating back to the workspace page and finding a control. The
 * moment an operator most needs to leave — they have realised they are in
 * the wrong tab — is the moment they should not have to navigate
 * anywhere. Distance from "I should stop" to "I have stopped" is a safety
 * property.
 *
 * ⚠️ THE BUTTON IS NOT WHAT ENDS THE SESSION. `expires_at`, capped at
 * thirty minutes from the frozen `started_at`, does — re-decided on every
 * single request. This makes leaving early one click instead of a wait;
 * it does not make the bar load-bearing. Deleting this component from the
 * DOM with developer tools extends nobody's access by a second.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ TWO THINGS WERE ADDED IN BATCH 28, AND NEITHER IS DECORATION
 * ══════════════════════════════════════════════════════════════════════
 *   1. IT POLLS. The bar used to be a snapshot taken when the page
 *      rendered. A session ended by the workspace owner, or by a platform
 *      owner, or by the clock, left the operator looking at a bar that
 *      still said they were inside — and the first they learned otherwise
 *      was a refusal on their next click. Now the layout re-renders on
 *      the server every fifteen seconds while the tab is visible, so the
 *      bar stops claiming access the operator no longer has.
 *
 *   2. THE SCOPE LIFT LIVES HERE, BELOW THE BAR AND NOT IN IT. Sessions
 *      start read-only whatever the customer consented to; taking write
 *      access is a separate act with its own written reason. It is a
 *      SIBLING strip rather than another button in the bar, because the
 *      bar's button count is a property worth keeping at one: the only
 *      thing you can click in the warning itself is the thing that makes
 *      the warning go away honestly.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ImpersonationBanner } from "./impersonation-banner";
import { useVisiblePoll, SUPPORT_ACCESS_POLL_MS } from "./use-visible-poll";

type ActionResult = { ok: true } | { ok: false; error: string };

export function LiveImpersonationBanner({
  sessionId,
  tenantName,
  tenantSlug,
  scope,
  grantedScope,
  mode,
  minutesLeft,
  expiresAt,
  reason,
  writeAccessReason,
  onEnd,
  onLift,
}: {
  sessionId: string;
  tenantName: string;
  tenantSlug: string;
  /** The EFFECTIVE scope. Read-only until deliberately lifted. */
  scope: string;
  /** The frozen ceiling: the most the customer's consent permits. */
  grantedScope: string;
  mode: string;
  minutesLeft: number;
  expiresAt: string;
  reason: string;
  writeAccessReason: string | null;
  onEnd: (input: { sessionId: string }) => Promise<ActionResult>;
  onLift?: (input: { sessionId: string; reason: string }) => Promise<ActionResult>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [lifting, startLift] = useTransition();
  const [liftOpen, setLiftOpen] = useState(false);
  const [liftReason, setLiftReason] = useState("");
  const [liftError, setLiftError] = useState<string | null>(null);

  useVisiblePoll(() => router.refresh(), SUPPORT_ACCESS_POLL_MS);

  /**
   * ⚠️ THE STRIP IS OFFERED ONLY WHEN IT COULD SUCCEED — the consent
   * already permits writing and it has not been taken yet. Break-glass
   * never reaches here because its ceiling is `read_only`, which is the
   * load-bearing line of the whole consent model rather than a UI rule.
   *
   * 🔴 AND HIDING IT IS NOT WHAT MAKES IT TRUE. `liftImpersonationScope()`
   * re-derives all of this server-side and re-reads the consent row as it
   * stands at the moment of the act.
   */
  const canOfferLift =
    onLift != null && grantedScope === "read_write" && scope !== "read_write";

  return (
    <>
      <ImpersonationBanner
        tenantName={tenantName}
        tenantSlug={tenantSlug}
        scope={scope}
        mode={mode}
        minutesLeft={minutesLeft}
        expiresAt={expiresAt}
        reason={reason}
        ending={pending}
        onEnd={() =>
          startTransition(async () => {
            const result = await onEnd({ sessionId });
            if (result.ok) {
              toast.success("Session ended. You are yourself again.");
            } else {
              // Refreshing anyway: the usual cause of "no session to end" is
              // that it already expired, and the operator's view should stop
              // claiming otherwise.
              toast.error(result.error);
            }
            router.refresh();
          })
        }
      />

      {scope === "read_write" ? (
        <div
          data-testid="impersonation-write-access"
          className="border-b border-red-800 bg-red-700 px-4 py-2 text-xs font-semibold text-white"
        >
          Write access taken — you can change this customer&rsquo;s data.
          {writeAccessReason ? <> You said: {writeAccessReason}</> : null}
        </div>
      ) : null}

      {canOfferLift ? (
        <div
          data-testid="impersonation-lift"
          className="flex flex-wrap items-center gap-3 border-b border-border bg-muted px-4 py-2 text-xs"
        >
          <KeyRound className="h-4 w-4 shrink-0" aria-hidden />
          <span>
            This session is <strong>read only</strong>. This workspace has consented to
            changes, but taking write access is a separate step and is recorded.
          </span>

          {liftOpen ? (
            <div className="flex w-full flex-col gap-2">
              <label htmlFor="lift-reason" className="font-medium">
                What are you about to change? This goes into the customer&rsquo;s own
                audit log.
              </label>
              <Textarea
                id="lift-reason"
                rows={2}
                value={liftReason}
                onChange={(e) => setLiftReason(e.target.value)}
              />
              {liftError ? (
                <p role="alert" className="font-semibold text-destructive">
                  {liftError}
                </p>
              ) : null}
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={lifting}
                  onClick={() => {
                    setLiftError(null);
                    startLift(async () => {
                      const result = await onLift({
                        sessionId,
                        reason: liftReason.trim(),
                      });
                      if (result.ok) {
                        setLiftOpen(false);
                        setLiftReason("");
                        toast.success("Write access recorded. The customer can see it.");
                        router.refresh();
                      } else {
                        setLiftError(result.error);
                      }
                    });
                  }}
                >
                  {lifting ? "Recording…" : "Take write access"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={lifting}
                  onClick={() => {
                    setLiftOpen(false);
                    setLiftError(null);
                  }}
                >
                  Stay read only
                </Button>
              </div>
            </div>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="ml-auto"
              onClick={() => setLiftOpen(true)}
            >
              I need to change something
            </Button>
          )}
        </div>
      ) : null}
    </>
  );
}
