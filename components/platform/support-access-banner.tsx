"use client";

/**
 * Ordence — The Banner The CUSTOMER Sees
 * Version: v1.52.0-alpha (Batch 28)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE OPERATOR'S BANNER WAS NEVER THE HARD ONE
 * ══════════════════════════════════════════════════════════════════════
 * `impersonation-banner.tsx` warns OUR staff that they are in somebody
 * else's workspace. That is a mistake guard, and a good one.
 *
 * This is a different control with a different beneficiary. It appears on
 * every screen of the customer's own product, for every one of their
 * users, and it says: one of our staff is in here right now, this is who
 * they are, this is what they said they were doing, this is what they can
 * change, and this is when it stops.
 *
 * ⚠️ AN EMAIL SENT TO THE OWNERS IS NOT THIS. It arrives in one inbox,
 * possibly filtered, and it is read afterwards. The person who notices
 * something odd is the accounts clerk who is looking at the screen at the
 * time, and until this existed there was nothing on that screen to see.
 *
 * FOUR RULES, EACH LOAD-BEARING:
 *
 *   • NOT DISMISSIBLE. No close, no collapse, no "understood". The only
 *     button ENDS THE ACCESS — it never hides the notice. A banner that
 *     can be hidden is hidden on day two.
 *
 *   • NAMES THE HUMAN. "Support is in your workspace" names nobody and
 *     is therefore unanswerable. An email address is something the
 *     customer can quote back at us in a sentence.
 *
 *   • EVERY STATE CARRIES A WORD. Read-only and read-write are the
 *     difference between somebody looking and somebody changing, and one
 *     in twelve Indian men cannot use the colour to tell them apart. The
 *     words are there and the colour is emphasis.
 *
 *   • COUNTS DOWN FROM A SERVER-COMPUTED DEADLINE. `expiresAt` is the
 *     capped expiry the server derived from the session's frozen start
 *     time. This recomputes the display from that instant rather than
 *     decrementing a number, so a laptop that slept does not come back
 *     claiming there is time left on a session that is over.
 *
 * 🔴 NONE OF THIS ENFORCES ANYTHING. Deleting this bar with developer
 * tools removes a notice, not a control. The session is re-decided from
 * the database on every server request.
 */

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ShieldAlert, Eye, PencilLine } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useVisiblePoll, SUPPORT_ACCESS_POLL_MS } from "./use-visible-poll";

type ActionResult = { ok: true } | { ok: false; error: string };

export type SupportAccessBannerProps = {
  sessionId: string;
  operatorEmail: string;
  /** "Standing consent" / "Incident consent" / "BREAK-GLASS — no consent". */
  authority: string;
  mode: string;
  /** The EFFECTIVE scope: what they can do now. */
  scope: string;
  /** Why the operator entered. Written by them when the session started. */
  reason: string;
  /** Why they took write access, when they have. */
  writeAccessReason?: string | null;
  /** ISO. The server's capped deadline; the countdown recomputes from it. */
  expiresAt: string;
  minutesLeft: number;
  /**
   * Who is looking. `"owner"` gets the End button; `"member"` gets the
   * notice only; `"operator"` is our own staff, whose button ends their
   * own session and is worded as leaving rather than ejecting.
   */
  viewer: "owner" | "member" | "operator";
  onEnd?: (input: { sessionId: string; reason: string }) => Promise<ActionResult>;
};

export function SupportAccessBanner({
  sessionId,
  operatorEmail,
  authority,
  mode,
  scope,
  reason,
  writeAccessReason = null,
  expiresAt,
  minutesLeft,
  viewer,
  onEnd,
}: SupportAccessBannerProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [problem, setProblem] = useState<string | null>(null);

  const breakGlass = mode === "break_glass";
  const canWrite = scope === "read_write";

  /* ---- ⭐ THE LIVE PART ------------------------------------------- */
  //
  // `router.refresh()` re-renders the layout on the SERVER, which re-runs
  // the session lookup and re-derives the remaining time from the frozen
  // `started_at`. So the banner appears within one interval of an
  // operator entering, and disappears within one interval of the session
  // ending — by expiry, by them, or by us — with no client-held state to
  // go stale.
  useVisiblePoll(() => router.refresh(), SUPPORT_ACCESS_POLL_MS);

  /* ---- The countdown, recomputed rather than decremented ---------- */
  const [remaining, setRemaining] = useState(minutesLeft);
  useEffect(() => {
    const target = new Date(expiresAt).getTime();
    const tick = () => setRemaining(Math.max(0, Math.ceil((target - Date.now()) / 60_000)));
    tick();
    const id = window.setInterval(tick, 15_000);
    return () => window.clearInterval(id);
  }, [expiresAt]);

  const expired = remaining <= 0;

  return (
    <div
      role="alert"
      aria-live="assertive"
      data-testid="support-access-banner"
      data-mode={mode}
      data-scope={scope}
      className={cn(
        "flex flex-wrap items-center gap-x-4 gap-y-2 border-b-4 px-4 py-3 text-sm",
        breakGlass || canWrite
          ? "border-red-700 bg-red-600 text-white"
          : "border-amber-600 bg-amber-400 text-amber-950",
      )}
    >
      <ShieldAlert className="h-5 w-5 shrink-0" aria-hidden />

      <span className="font-semibold uppercase tracking-wide">
        Ordence support is in this workspace
      </span>

      <span className="font-mono text-xs">{operatorEmail}</span>

      {/* ⭐ THE WORD IS THE STATE. The colour above only emphasises it. */}
      <span
        data-testid="support-access-scope"
        className={cn(
          "inline-flex items-center gap-1 rounded-sm px-2 py-0.5 text-xs font-semibold uppercase",
          canWrite ? "bg-black/40" : "bg-black/20",
        )}
      >
        {canWrite ? (
          <PencilLine className="h-3 w-3" aria-hidden />
        ) : (
          <Eye className="h-3 w-3" aria-hidden />
        )}
        {canWrite ? "Can change your data" : "Can only look, not change"}
      </span>

      <span className="text-xs" data-testid="support-access-countdown">
        {expired
          ? "Access has ended — reload the page"
          : `Ends automatically in ${remaining} minute${remaining === 1 ? "" : "s"}`}
      </span>

      {onEnd ? (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="ml-auto"
          disabled={pending}
          onClick={() => {
            setProblem(null);
            startTransition(async () => {
              const result = await onEnd({
                sessionId,
                reason:
                  viewer === "operator"
                    ? "Operator left the workspace from the support banner."
                    : "Ended from the support access banner by the workspace.",
              });
              if (!result.ok) setProblem(result.error);
              // Refresh either way: the usual cause of "no session to
              // end" is that it ended a moment ago, and the view should
              // stop claiming otherwise.
              router.refresh();
            });
          }}
        >
          {pending
            ? "Ending…"
            : viewer === "operator"
              ? "Leave this workspace"
              : "End their access now"}
        </Button>
      ) : null}

      <p className="w-full text-xs">
        <span className="font-semibold">Authority:</span> {authority}.{" "}
        <span className="font-semibold">Reason given:</span> {reason}
        {writeAccessReason ? (
          <>
            {" "}
            <span className="font-semibold">Why they took write access:</span>{" "}
            {writeAccessReason}
          </>
        ) : null}
        {viewer === "member" ? (
          // ⚠️ SAID OUT LOUD TO EVERY USER, not only to the owner. Somebody
          // who cannot end the session should still know who at their own
          // company can, otherwise the notice is a worry with no remedy.
          <> An owner or admin of this workspace can end this access at any time.</>
        ) : null}
      </p>

      {problem ? (
        <p role="alert" className="w-full text-xs font-semibold">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
