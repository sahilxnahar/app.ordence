"use client";

/**
 * Ordence — Poll While Somebody Is Looking, And Only Then
 * Version: v1.52.0-alpha (Batch 28)
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHY POLLING AND NOT A WEBSOCKET
 * ══════════════════════════════════════════════════════════════════════
 * The thing this keeps fresh — "is one of Ordence's staff inside my
 * workspace right now" — has to be right within seconds, on every screen,
 * for every user of a workspace. A socket is the textbook answer and it
 * is the wrong one here:
 *
 *   • Ordence runs on Railway, behind a proxy, on more than one instance.
 *     A socket has to survive proxy idle timeouts, reconnect with
 *     backoff, and be fanned out across instances that share nothing.
 *     Every one of those is a thing that breaks quietly and is debugged
 *     at the worst possible time.
 *   • The payload is one row. A poll is one indexed read against an
 *     index that exists for exactly this question.
 *   • ⚠️ AND THE FAILURE MODES ARE OPPOSITE. A poll that fails shows a
 *     slightly stale banner for a few seconds. A socket that fails
 *     silently shows NO banner at all and looks completely healthy —
 *     which for a transparency notice is the one outcome that matters.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ AND WHY IT STOPS WHEN THE TAB IS HIDDEN
 * ══════════════════════════════════════════════════════════════════════
 * A background tab left open overnight would otherwise issue a server
 * round trip every few seconds, forever, for a screen nobody is looking
 * at — multiplied by every open tab in every workspace.
 *
 * ⭐ AND IT COSTS NOTHING IN CORRECTNESS, because the banner is not the
 * boundary. The session is re-read from the database on every server
 * request; a hidden tab that has stopped polling cannot see anything it
 * was not already allowed to see, and the moment it becomes visible it
 * refreshes IMMEDIATELY rather than waiting out the interval.
 *
 * 🔴 NOTHING HERE ENFORCES ANYTHING. Blocking this timer with developer
 * tools does not extend an impersonation session by one second — the
 * clock lives in Postgres and is re-decided from the session's frozen
 * `started_at` on every request.
 */

import { useEffect, useRef } from "react";

export function useVisiblePoll(tick: () => void, intervalMs: number): void {
  /**
   * ⚠️ THE CALLBACK LIVES IN A REF. A caller writing `useVisiblePoll(() =>
   * router.refresh(), 15000)` passes a NEW function on every render, and
   * a render is exactly what `router.refresh()` causes. With the callback
   * in the dependency list, every tick would tear down and rebuild the
   * interval — which resets the countdown to the next poll each time and,
   * on a slow refresh, can stop it firing at all.
   */
  const latest = useRef(tick);
  latest.current = tick;

  useEffect(() => {
    if (typeof document === "undefined") return;

    let timer: ReturnType<typeof setInterval> | null = null;

    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };

    const start = () => {
      if (timer !== null) return;
      timer = setInterval(() => latest.current(), intervalMs);
    };

    const onVisibility = () => {
      if (document.hidden) {
        stop();
        return;
      }
      // ⭐ CATCH UP FIRST, THEN RESUME. Somebody returning to a tab they
      // left ten minutes ago must not spend another interval looking at
      // a banner describing a session that ended while they were away.
      latest.current();
      start();
    };

    document.addEventListener("visibilitychange", onVisibility);
    if (!document.hidden) start();

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
    };
  }, [intervalMs]);
}

/**
 * How often the support-access banners re-ask the server.
 *
 * ⚠️ A COMPROMISE, STATED AS ONE. Faster means a customer sees an
 * operator arrive sooner, at the cost of a request per tab per interval.
 * Fifteen seconds is well inside the time it takes a person to read a
 * banner and react to it, and comfortably outside the rate at which a
 * page of open tabs becomes a load problem.
 */
export const SUPPORT_ACCESS_POLL_MS = 15_000;
