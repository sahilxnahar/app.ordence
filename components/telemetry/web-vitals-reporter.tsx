"use client";

/**
 * Ordence — Core Web Vitals Reporter
 * Version: v0.12.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS USES `PerformanceObserver` DIRECTLY AND NOT A WEB-VITALS LIB
 * ══════════════════════════════════════════════════════════════════════
 * The `web-vitals` package would be the obvious dependency, and it is a
 * good one. It is not here because this phase adds NO new npm packages —
 * a deliberate standing constraint in this project — and because
 * everything below is already exposed by the browser. `PerformanceObserver`
 * with the `largest-contentful-paint`, `layout-shift`, `event`, `paint`
 * and `navigation` entry types gives all five metrics.
 *
 * WHAT WE GIVE UP BY NOT USING THE LIBRARY, STATED HONESTLY:
 *   • The library's INP attribution (which element, which interaction) is
 *     considerably better than the 98th-percentile-event approximation
 *     used here.
 *   • It handles several browser quirks — Safari's missing `event` entry
 *     support, an old Chrome LCP bug — that this does not.
 *   • Its rating thresholds track Google's revisions; ours are pinned
 *     constants that a human must update.
 * The numbers below are good enough to answer "did the p75 regress after
 * the last deploy", which is what this phase needs. If per-element INP
 * attribution is ever required, adding the dependency is the right call
 * and this file should be deleted rather than extended.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THREE RULES, ALL OF WHICH ARE ABOUT NOT BREAKING THE PAGE
 * ══════════════════════════════════════════════════════════════════════
 *
 * 1. EVERY BROWSER API IS FEATURE-DETECTED AND EVERY CALL IS WRAPPED.
 *    `PerformanceObserver` exists everywhere current, but `observe()`
 *    THROWS on an entry type the browser does not know — so a Safari
 *    version without `event` support would, unguarded, throw inside an
 *    effect during hydration and blank the page. Each observer is
 *    therefore registered in its own try/catch: an unsupported metric is
 *    simply not collected.
 *
 * 2. NOTHING IS SENT SYNCHRONOUSLY DURING RENDER OR INTERACTION.
 *    Events accumulate in a buffer and are flushed on `visibilitychange`
 *    (hidden) and `pagehide`. `beforeunload` is deliberately NOT used —
 *    it is unreliable on mobile, where a backgrounded tab is often killed
 *    without ever firing it, and registering it also disqualifies the
 *    page from the back/forward cache, which would make the very metrics
 *    we are measuring worse.
 *
 * 3. FAILURE IS SILENT. A telemetry error is caught and dropped. There is
 *    no retry, no toast, no console.error in production. A monitoring
 *    system that takes the app down is worse than no monitoring.
 *
 * ══════════════════════════════════════════════════════════════════════
 * NO PII CROSSES THIS BOUNDARY
 * ══════════════════════════════════════════════════════════════════════
 * The route is scrubbed to a PATTERN on the CLIENT, before the value ever
 * touches the network — so a customer's name sitting in a `?q=` search
 * parameter is gone before it can appear in an access log, ours or a
 * CDN's. The server scrubs again and does not trust this pass.
 *
 * No user-agent string is sent (a high-entropy fingerprinting vector), no
 * viewport is sent at pixel precision (also one), and no identifier of
 * any kind is attached — the server derives tenant and user from the
 * session cookie, and refuses to be told either by the client.
 */

import { useEffect, useRef } from "react";
import { scrubUrl } from "@/lib/telemetry/scrub";
import {
  MAX_BATCH_EVENTS,
  type ClientWebVitalEvent,
  type TelemetryIngestEvent,
  webVitalMetricValues,
} from "@/lib/telemetry/ingest-schema";

const INGEST_PATH = "/api/telemetry";

type MetricName = (typeof webVitalMetricValues)[number];

/**
 * Google's Core Web Vitals thresholds, [good_max, needs_improvement_max]
 * in the metric's own unit (ms, except CLS which is unitless).
 *
 * ⚠️ THESE ARE PINNED CONSTANTS AND THEY DRIFT. Google has revised more
 * than one of these boundaries. That is exactly why the raw VALUE is
 * stored alongside the rating in the database — a threshold change
 * invalidates the ratings but never the values, so historical data stays
 * comparable and can be re-rated.
 */
const THRESHOLDS: Record<MetricName, readonly [number, number]> = {
  LCP: [2_500, 4_000],
  INP: [200, 500],
  CLS: [0.1, 0.25],
  FCP: [1_800, 3_000],
  TTFB: [800, 1_800],
};

function rate(metric: MetricName, value: number): ClientWebVitalEvent["rating"] {
  const [good, poor] = THRESHOLDS[metric];
  if (value <= good) return "good";
  if (value <= poor) return "needs-improvement";
  return "poor";
}

/**
 * Viewport width rounded to the nearest 100px.
 *
 * The exact width of a browser window is a genuine fingerprinting signal
 * — combined with a handful of other bits it identifies an individual
 * device. The bucket answers the only question the field exists for
 * ("is LCP bad only on phones?") without being one.
 */
function viewportBucket(): number | undefined {
  if (typeof window === "undefined") return undefined;
  const width = window.innerWidth;
  if (!Number.isFinite(width) || width <= 0) return undefined;
  return Math.min(20_000, Math.round(width / 100) * 100);
}

function deviceClass(): ClientWebVitalEvent["deviceClass"] {
  const width = viewportBucket();
  if (width === undefined) return "unknown";
  if (width < 700) return "mobile";
  if (width < 1_100) return "tablet";
  return "desktop";
}

function connectionClass(): ClientWebVitalEvent["connection"] {
  try {
    // `navigator.connection` is non-standard and absent in Safari and
    // Firefox, so it is read through an untyped lookup rather than a
    // global type augmentation that would claim it always exists.
    const nav = navigator as Navigator & { connection?: { effectiveType?: string } };
    const effective = nav.connection?.effectiveType;
    if (effective === "slow-2g" || effective === "2g" || effective === "3g" || effective === "4g") {
      return effective;
    }
  } catch {
    /* Reading a non-standard property must never break a page. */
  }
  return "unknown";
}

function navigationType(): ClientWebVitalEvent["navigationType"] {
  try {
    const entries = performance.getEntriesByType("navigation");
    const nav = entries[0] as PerformanceNavigationTiming | undefined;
    const type = nav?.type;
    if (type === "reload") return "reload";
    if (type === "back_forward") return "back-forward";
    if (type === "prerender") return "prerender";
    return "navigate";
  } catch {
    return undefined;
  }
}

/* ================================================================== */
/* THE COMPONENT                                                       */
/* ================================================================== */

/**
 * Mount ONCE, high in the tree (the root layout). Mounting it twice
 * double-reports every metric and silently halves every percentile's
 * accuracy — a bug with no symptom other than numbers that are subtly
 * wrong, which is the worst kind of bug for a measurement system.
 * The module-level `mounted` guard below makes the second mount a no-op.
 */
export function WebVitalsReporter(): null {
  const bufferRef = useRef<TelemetryIngestEvent[]>([]);
  const sentRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (typeof PerformanceObserver === "undefined") return;

    // Guard against a second mount (React 18+ StrictMode double-invokes
    // effects in development, and a layout can be re-mounted on a route
    // group change). Without this, dev numbers are double-counted.
    if (mountedFlag.value) return;
    mountedFlag.value = true;

    const routePattern = scrubUrl(window.location.pathname + window.location.search);
    const observers: PerformanceObserver[] = [];

    /* ---- buffering -------------------------------------------- */

    const push = (metric: MetricName, value: number): void => {
      try {
        // One row per metric per page view. LCP and CLS both emit
        // repeatedly as the page settles; taking the LAST value is the
        // correct semantic for both, so later pushes replace earlier ones
        // rather than appending.
        if (!Number.isFinite(value) || value < 0) return;

        const event: ClientWebVitalEvent = {
          kind: "web-vital",
          metric,
          // Sub-millisecond precision is noise for four of these; CLS
          // needs four decimals because its whole scale is 0–1.
          value: metric === "CLS" ? Number(value.toFixed(4)) : Math.round(value),
          rating: rate(metric, value),
          route: routePattern,
          deviceClass: deviceClass(),
          connection: connectionClass(),
          viewportBucket: viewportBucket(),
          navigationType: navigationType(),
          occurredAt: Date.now(),
        };

        const existing = bufferRef.current.findIndex(
          (e) => e.kind === "web-vital" && e.metric === metric,
        );
        if (existing >= 0) {
          bufferRef.current[existing] = event;
        } else if (bufferRef.current.length < MAX_BATCH_EVENTS) {
          bufferRef.current.push(event);
        }
      } catch {
        /* Collection must never break the page. */
      }
    };

    /* ---- flushing --------------------------------------------- */

    const flush = (): void => {
      try {
        if (bufferRef.current.length === 0) return;

        // Deduplicate across flushes. `visibilitychange` and `pagehide`
        // both fire on a real tab close on some platforms, and without
        // this every metric would be counted twice on those.
        const pending = bufferRef.current.filter((e) => {
          const key = e.kind === "web-vital" ? `${e.kind}:${e.metric}` : `${e.kind}:${e.message}`;
          if (sentRef.current.has(key)) return false;
          sentRef.current.add(key);
          return true;
        });
        bufferRef.current = [];
        if (pending.length === 0) return;

        const body = JSON.stringify({ events: pending });

        /**
         * `sendBeacon` FIRST, and it is not an optimisation.
         *
         * A `fetch()` issued from a `pagehide` handler is cancelled when
         * the document is torn down — so the metrics for every page a
         * user navigates AWAY from, which is all of them, would be lost.
         * `sendBeacon` hands the request to the browser to deliver after
         * the page is gone. `keepalive: true` on fetch is the fallback
         * for the same reason.
         *
         * It returns `false` when the payload exceeds the browser's
         * beacon quota (~64 KB); the fetch fallback then handles it.
         */
        let queued = false;
        try {
          if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
            queued = navigator.sendBeacon(
              INGEST_PATH,
              new Blob([body], { type: "application/json" }),
            );
          }
        } catch {
          queued = false;
        }

        if (!queued) {
          void fetch(INGEST_PATH, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
            keepalive: true,
            // No credentials mode override: the session cookie is
            // same-origin and is what the server uses to resolve the
            // tenant. The client never sends a tenant id itself.
          }).catch(() => {
            /* Dropped. There is no retry — see rule 3 in the header. */
          });
        }
      } catch {
        /* Flushing must never break the page. */
      }
    };

    /* ---- observers -------------------------------------------- */

    /**
     * Registered individually. `observe()` THROWS — synchronously, inside
     * this effect — on an entry type the browser does not support, and an
     * effect that throws during hydration blanks the page. One shared
     * try/catch would mean one unsupported metric silently disables all
     * five.
     */
    const observe = (
      type: string,
      handler: (entries: PerformanceEntryList) => void,
      options: PerformanceObserverInit = {},
    ): void => {
      try {
        const observer = new PerformanceObserver((list) => {
          try {
            handler(list.getEntries());
          } catch {
            /* A malformed entry must not break the others. */
          }
        });
        observer.observe({ type, buffered: true, ...options });
        observers.push(observer);
      } catch {
        /* This browser does not support this entry type. Skip it. */
      }
    };

    // LCP — the last entry before the first interaction is the real one,
    // so we keep overwriting and let `push` replace.
    observe("largest-contentful-paint", (entries) => {
      const last = entries[entries.length - 1];
      if (last) push("LCP", last.startTime);
    });

    // FCP — from the paint timeline, filtered by name.
    observe("paint", (entries) => {
      for (const entry of entries) {
        if (entry.name === "first-contentful-paint") push("FCP", entry.startTime);
      }
    });

    // CLS — the sum of layout shifts NOT caused by user input. Including
    // input-driven shifts would score every dropdown open as a defect.
    let clsTotal = 0;
    observe("layout-shift", (entries) => {
      for (const entry of entries) {
        const shift = entry as PerformanceEntry & {
          value?: number;
          hadRecentInput?: boolean;
        };
        if (shift.hadRecentInput) continue;
        clsTotal += shift.value ?? 0;
      }
      push("CLS", clsTotal);
    });

    // INP — approximated as the WORST interaction latency observed.
    //
    // The real definition is roughly the 98th percentile of interactions
    // for busy pages, which needs the interaction-count bookkeeping the
    // web-vitals library does. Taking the max over-reports on pages with
    // hundreds of interactions. That bias is documented here rather than
    // hidden: it is a PESSIMISTIC approximation, so it will never tell us
    // things are fine when they are not.
    let worstInteraction = 0;
    observe(
      "event",
      (entries) => {
        for (const entry of entries) {
          const event = entry as PerformanceEntry & { interactionId?: number };
          // `interactionId` of 0 means the event was not part of a
          // user interaction, which is most of them.
          if (!event.interactionId) continue;
          if (entry.duration > worstInteraction) worstInteraction = entry.duration;
        }
        if (worstInteraction > 0) push("INP", worstInteraction);
      },
      // Below 40ms is imperceptible and would flood the observer.
      { durationThreshold: 40 } as PerformanceObserverInit,
    );

    // TTFB — read once from the navigation entry rather than observed.
    try {
      const navEntry = performance.getEntriesByType("navigation")[0] as
        | PerformanceNavigationTiming
        | undefined;
      if (navEntry && Number.isFinite(navEntry.responseStart)) {
        push("TTFB", navEntry.responseStart);
      }
    } catch {
      /* Unsupported. Skip TTFB. */
    }

    /* ---- lifecycle -------------------------------------------- */

    const onVisibilityChange = (): void => {
      if (document.visibilityState === "hidden") flush();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    // `pagehide` rather than `beforeunload`: see rule 2 in the header.
    window.addEventListener("pagehide", flush);

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", flush);
      for (const observer of observers) {
        try {
          observer.disconnect();
        } catch {
          /* Already disconnected. */
        }
      }
      // Final flush on unmount so a client-side route change does not
      // discard the metrics of the page being left.
      flush();
      mountedFlag.value = false;
    };
  }, []);

  return null;
}

/**
 * Module-scope mount guard. A ref would not work: two separate mounts are
 * two separate component instances with two separate refs, which is
 * exactly the case being guarded against.
 */
const mountedFlag = { value: false };

export default WebVitalsReporter;
