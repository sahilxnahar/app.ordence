"use client";

/**
 * Ordence — THE BANNER THE CUSTOMER SEES
 * Version: v1.58.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THIS IS NOT AN OPERATOR INDICATOR. IT IS THE ONLY WARNING THE
 *    PERSON TYPING WILL EVER GET.
 * ══════════════════════════════════════════════════════════════════════
 * Without it, maintenance mode is a product that silently refuses saves,
 * and the first thing a user concludes is that their own work is broken.
 * They retype it. Then they call support. So the banner:
 *
 *   - cannot be dismissed. A notice you can close is a notice you close
 *     and then forget, and the freeze outlives the dismissal;
 *   - names WHAT is happening in the first four words, not in a link;
 *   - says WHEN it ends when we know, and admits it when we do not;
 *   - carries the word READ-ONLY, because one in twelve Indian men is
 *     colour-blind and a red bar alone says nothing to them.
 *
 * ⚠️ THE COUNTDOWN IS DERIVED FROM AN ABSOLUTE TIMESTAMP, NEVER
 * DECREMENTED. A tab left in the background gets its timers throttled;
 * a counter that subtracts one minute per tick would drift by exactly
 * however long the user was on another tab, and would then confidently
 * display a wrong end time. Every tick recomputes `endsAt - now`, so a
 * paused tab is simply late, never wrong. The server recomputes the same
 * value from the stored timestamp on every render.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useVisiblePoll } from "./use-visible-poll";
import { formatRemaining, remainingMs } from "@/lib/platform/maintenance-policy";

/**
 * 30 s. Slower than the support-access banner (15 s) on purpose: this one
 * is on every page of a product that has been told to stop writing, and
 * the thing it is watching for — an operator lifting the freeze — is not
 * a per-second event.
 */
export const MAINTENANCE_POLL_MS = 30_000;

export type MaintenanceBannerProps = {
  scope: "global" | "tenant";
  /** ISO, or null for "until we say otherwise". */
  endsAt: string | null;
  /** The operator's sentence to customers. May be empty. */
  message: string;
  /**
   * Server-computed remaining milliseconds, from the STORED end time at
   * render. The first paint uses it, so a user with JavaScript still
   * disabled or hydrating sees a real number rather than a dash.
   */
  remainingMsAtRender: number;
};

export function MaintenanceBanner({
  scope,
  endsAt,
  message,
  remainingMsAtRender,
}: MaintenanceBannerProps) {
  const router = useRouter();

  // Re-render on the SERVER, which re-reads the switch and re-derives the
  // remaining time from the stored timestamp. Paused while the tab is
  // hidden — see `use-visible-poll`.
  useVisiblePoll(() => router.refresh(), MAINTENANCE_POLL_MS);

  const [left, setLeft] = useState(remainingMsAtRender);
  useEffect(() => {
    if (!endsAt) return;
    const tick = () => setLeft(remainingMs(endsAt));
    tick();
    const id = window.setInterval(tick, 15_000);
    return () => window.clearInterval(id);
  }, [endsAt]);

  const what =
    scope === "global"
      ? "Ordence is READ-ONLY for maintenance"
      : "This workspace is READ-ONLY for maintenance";

  // ⚠️ "ending shortly" rather than "0 min": the window may be overrunning,
  // and a countdown that hits zero and stays there reads as a broken clock.
  const when = !endsAt
    ? "No end time has been set yet."
    : left <= 0
      ? "The scheduled end time has passed — we are finishing up."
      : `Expected to end in ${formatRemaining(left)}.`;

  return (
    <div
      role="alert"
      aria-live="assertive"
      data-testid="maintenance-banner"
      data-scope={scope}
      className="border-b border-amber-600 bg-amber-100 px-4 py-2 text-amber-950 dark:border-amber-400 dark:bg-amber-950 dark:text-amber-50"
    >
      <p className="text-sm font-semibold">
        {what} — changes cannot be saved right now.
      </p>
      <p className="mt-0.5 text-sm">
        {when}
        {message.trim() ? ` ${message.trim()}` : ""}
      </p>
      <p className="mt-0.5 text-xs opacity-90">
        You can still read and export everything. Nothing you have already
        saved is affected.
      </p>
    </div>
  );
}
