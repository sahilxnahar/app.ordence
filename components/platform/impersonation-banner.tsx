"use client";

/**
 * Ordence — The Impersonation Banner
 * Version: v0.14.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THIS IS A SAFETY CONTROL WEARING THE CLOTHES OF A UI COMPONENT
 * ══════════════════════════════════════════════════════════════════════
 * The failure it exists to prevent is mundane and expensive: an operator
 * with two tabs open — their own admin view and a customer's workspace —
 * types into the wrong one. Nothing about that mistake is exotic, it has
 * happened to every support organisation that has ever built one of
 * these, and the only reliable defence is that the impersonated view does
 * not look like anything else in the product.
 *
 * So the rules here are deliberate and each one is load-bearing:
 *
 *   • NOT DISMISSIBLE. There is no close button, no collapse, no
 *     "understood" acknowledgement. A banner that can be dismissed is a
 *     banner that is dismissed on day two and never seen again.
 *
 *   • ALWAYS NAMES THE TENANT. "You are impersonating" without a name is
 *     useless in exactly the scenario it exists for — two sessions, wrong
 *     tab. The workspace name is the largest text in the bar.
 *
 *   • ALWAYS STATES THE SCOPE. "Read only" and "Read and write" are
 *     genuinely different situations and the operator must not have to
 *     remember which one they started.
 *
 *   • COUNTS DOWN, VISIBLY. The countdown does not enforce anything —
 *     `expires_at` in the database does, checked on every request. It is
 *     here so the expiry is never a surprise mid-edit.
 *
 *   • BREAK-GLASS LOOKS DIFFERENT FROM CONSENTED. Same bar, unmistakably
 *     louder. Break-glass is read-only and the customer has been emailed;
 *     the operator should feel that.
 *
 * ⚠️ NONE OF THIS IS ENFORCEMENT. Anything rendered in a browser can be
 * deleted with developer tools, and removing this bar does not extend a
 * session by one second. The server checks `expires_at` and the scope on
 * every call. This component exists so the honest state is visible, not
 * so it is true.
 */

import { useEffect, useState } from "react";
import { AlertTriangle, Eye, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export type ImpersonationBannerProps = {
  tenantName: string;
  tenantSlug: string;
  /** "read_only" | "read_write" */
  scope: string;
  /** "standing_consent" | "incident_consent" | "break_glass" */
  mode: string;
  minutesLeft: number;
  /** ISO timestamp. The countdown recomputes from this, not from a tick. */
  expiresAt: string;
  /**
   * ⭐ THE REASON THE OPERATOR GAVE — Batch 28. Optional, because this
   * component is also rendered from tests and from surfaces that do not
   * hold it, and a banner that refuses to render without it would be a
   * banner that sometimes is not there.
   *
   * ⚠️ IT IS TEXT, NOT A CONTROL. The button count in this bar is a
   * property somebody asserts: exactly one, and it ends the session.
   * Anything added here that a person can click has to justify itself
   * against that.
   */
  reason?: string;
  onEnd?: () => void;
  ending?: boolean;
};

export function ImpersonationBanner({
  tenantName,
  tenantSlug,
  scope,
  mode,
  minutesLeft,
  expiresAt,
  reason,
  onEnd,
  ending = false,
}: ImpersonationBannerProps) {
  const breakGlass = mode === "break_glass";
  const readOnly = scope === "read_only";

  // ⚠️ Recomputed FROM `expiresAt` every second rather than decremented.
  // A counter that decrements drifts when the tab is backgrounded and
  // ends up claiming there is time left after the session is over —
  // which is the one lie this bar must never tell.
  const [remaining, setRemaining] = useState(minutesLeft);

  useEffect(() => {
    const target = new Date(expiresAt).getTime();
    const tick = () => {
      const mins = Math.max(0, Math.ceil((target - Date.now()) / 60_000));
      setRemaining(mins);
    };
    tick();
    const id = window.setInterval(tick, 15_000);
    return () => window.clearInterval(id);
  }, [expiresAt]);

  const expired = remaining <= 0;

  return (
    <div
      role="alert"
      aria-live="assertive"
      data-testid="impersonation-banner"
      data-mode={mode}
      data-scope={scope}
      className={cn(
        "sticky top-0 z-50 flex flex-wrap items-center gap-x-4 gap-y-2 border-b-4 px-4 py-3 text-sm font-semibold",
        breakGlass
          ? "border-red-700 bg-red-600 text-white"
          : "border-amber-600 bg-amber-400 text-amber-950",
      )}
    >
      {breakGlass ? (
        <ShieldAlert className="h-5 w-5 shrink-0" aria-hidden />
      ) : (
        <AlertTriangle className="h-5 w-5 shrink-0" aria-hidden />
      )}

      <span className="uppercase tracking-wide">
        {breakGlass ? "Break-glass access" : "Impersonating"}
      </span>

      {/* The workspace name is the biggest thing in the bar, on purpose. */}
      <span className="text-base font-bold">{tenantName}</span>
      <span className="font-mono text-xs opacity-80">{tenantSlug}</span>

      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-sm px-2 py-0.5 text-xs uppercase",
          readOnly ? "bg-black/20" : "bg-black/40",
        )}
      >
        {readOnly ? <Eye className="h-3 w-3" aria-hidden /> : null}
        {readOnly ? "Read only" : "Read and write"}
      </span>

      <span className="ml-auto text-xs font-medium" data-testid="impersonation-countdown">
        {expired
          ? "Session expired — reload to leave"
          : `Ends in ${remaining} minute${remaining === 1 ? "" : "s"}`}
      </span>

      {onEnd ? (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={onEnd}
          disabled={ending}
        >
          {ending ? "Ending…" : "End session"}
        </Button>
      ) : null}

      {breakGlass ? (
        <p className="w-full text-xs font-normal">
          No consent was recorded for this workspace. It is read-only, the owners have
          been emailed, and every action is attributed to you.
        </p>
      ) : null}

      {reason ? (
        // ⚠️ THE REASON IS SHOWN TO THE OPERATOR TOO, not only to the
        // customer. Somebody who has been in a workspace for twenty
        // minutes has stopped remembering what they came in to do, and
        // "what did I say I was here for" is the question that stops a
        // session drifting into a general look around.
        <p className="w-full text-xs font-normal" data-testid="impersonation-reason">
          <span className="font-semibold">You said:</span> {reason}
        </p>
      ) : null}
    </div>
  );
}
