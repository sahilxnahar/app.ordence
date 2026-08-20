/**
 * Ordence — Browser error reporting
 * Version: v0.95.0-alpha
 *
 * ⚠️ `instrumentation-client.ts`, NOT `sentry.client.config.ts`. Next.js
 * 15 loads this file for client instrumentation; the older filename still
 * works but is on its way out, and having both is how you end up
 * initialising Sentry twice and reporting every error as a duplicate.
 */

import * as Sentry from "@sentry/nextjs";
import { baseOptions, SENTRY_ENABLED } from "@/lib/observability/sentry-options";

if (SENTRY_ENABLED) {
  Sentry.init({
    ...baseOptions(),

    /**
     * ⚠️ SESSION REPLAY IS OFF, AND NOT ONLY FOR QUOTA REASONS.
     *
     * A replay is a recording of a person using an ERP: their customers'
     * names, their prices, their margins. Masking is opt-out and gets
     * missed on exactly the field that mattered. If we ever want replay
     * it needs its own decision, with the tenants told.
     */
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
  });
}

/**
 * Router transition instrumentation. Harmless with tracing off, and it
 * means turning tracing on later is a one-line change rather than a hunt.
 */
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;

/* ==================================================================== */
/* ⭐⭐⭐ WAVE 14 — THE CLIENT ERROR LANE THAT WAS BUILT AND NEVER USED   */
/* ==================================================================== */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT WAS ALREADY THERE, AND WHAT WAS MISSING
 * ══════════════════════════════════════════════════════════════════════
 * `lib/telemetry/ingest-schema.ts` defines `clientErrorEventSchema`:
 * `kind: "error"`, a bounded message, a bounded stack, a severity the
 * browser is allowed to assert, a route and a metadata bag.
 * `app/api/telemetry/route.ts` parses it, scrubs it server-side, forces
 * `source: "client"` so a caller cannot launder a fabricated backend
 * error into our triage queue, and inserts it into `error_events`.
 *
 * ⚠️ AND NOTHING IN THE BROWSER HAS EVER SENT ONE.
 * `components/telemetry/web-vitals-reporter.tsx` is the only client that
 * posts to that endpoint and it only ever emits `kind: "web-vital"`.
 * Verified by grep at v1.81.0-alpha. A complete, tested, RLS-protected
 * ingest lane with no producer — the same shape as the three server-side
 * modules this track was commissioned to wire.
 *
 * ⭐ SO THIS IS THE PRODUCER, and it is fifty lines because everything
 * downstream of it already exists.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY NOT JUST RELY ON SENTRY
 * ══════════════════════════════════════════════════════════════════════
 * `SENTRY_ENABLED` is false in plenty of correct deployments — it is a
 * DSN away from being off in production, and it was off for most of this
 * product's life. `error_events` is ours, is in the same database as the
 * tenant it belongs to, and is what `/platform/reliability` reads. Two
 * destinations, the same argument `instrumentation.ts` makes for keeping
 * `console.error` beside Sentry: a monitoring vendor is one more
 * dependency that can be down, misconfigured or out of quota on the day
 * you need it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE THREE THINGS THAT MAKE THIS SAFE TO SHIP
 * ══════════════════════════════════════════════════════════════════════
 * ① BOUNDED. Five reports per page load, hard. A render loop in an error
 *    boundary can emit an error per frame; without a cap, one broken page
 *    on one browser is a denial-of-service against our own ingest — and
 *    that endpoint is anonymous by design, so there is nothing else in
 *    front of it. The route's own header records that rate limiting is
 *    the piece still missing there.
 * ② DEDUPLICATED. The same message from the same route is sent once.
 * ③ SCRUBBED BEFORE IT LEAVES THE BROWSER. `scrubText` and `scrubUrl`
 *    run here as well as on the server. The server scrubs again — a
 *    hand-crafted POST never ran this code — but a message containing a
 *    customer's email should not be on the wire in the first place.
 */

import { scrubText, scrubUrl } from "@/lib/telemetry/scrub";

const CLIENT_ERROR_BUDGET = 5;
const INGEST_PATH = "/api/telemetry";

let clientErrorsSent = 0;
const seenClientErrors = new Set<string>();

function reportClientError(input: {
  name: string;
  message: string;
  stack: string | null;
  severity: "fatal" | "error" | "warning";
}): void {
  try {
    if (clientErrorsSent >= CLIENT_ERROR_BUDGET) return;

    const message = scrubText(input.message, 4_000);
    if (message.length === 0) return;

    const route = scrubUrl(window.location.pathname);
    const key = `${input.name}:${message}:${route}`;
    if (seenClientErrors.has(key)) return;
    seenClientErrors.add(key);
    clientErrorsSent++;

    const body = JSON.stringify({
      events: [
        {
          kind: "error",
          name: input.name.slice(0, 120),
          message,
          // ⚠️ 4,000 rather than the column's 8,000: the wire schema caps
          // it there, and a stack longer than 4 KB is a runaway recursion
          // whose first twenty frames say everything the remaining four
          // hundred do.
          ...(input.stack ? { stack: scrubText(input.stack, 4_000) } : {}),
          severity: input.severity,
          route,
          // Allow-listed server-side by `scrubMetadata`. `boundary` says
          // which global handler caught it, which is the difference
          // between a thrown render and a dropped promise.
          metadata: { boundary: "window", component: "browser" },
          occurredAt: Date.now(),
        },
      ],
    });

    /**
     * `sendBeacon` first, `fetch(keepalive)` second — the same order and
     * the same reason as `web-vitals-reporter.tsx`: a `fetch` issued while
     * the document is being torn down is cancelled, and the errors that
     * matter most are the ones that happen on the way out.
     */
    let queued = false;
    try {
      if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
        queued = navigator.sendBeacon(INGEST_PATH, new Blob([body], { type: "application/json" }));
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
      }).catch(() => {
        /* Dropped. There is no retry: a retry loop on an error path is the
           thing that turns a bad page into a bad afternoon. */
      });
    }
  } catch {
    /* Reporting an error must never be the thing that breaks the page. */
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("error", (event: ErrorEvent) => {
    const error = event.error as { name?: string; message?: string; stack?: string } | undefined;
    reportClientError({
      name: typeof error?.name === "string" ? error.name : "Error",
      // `event.message` is populated even when `event.error` is not, which
      // is the case for cross-origin script errors ("Script error.").
      message:
        typeof error?.message === "string" && error.message.length > 0
          ? error.message
          : event.message || "(the thrown value carried no message)",
      stack: typeof error?.stack === "string" ? error.stack : null,
      severity: "error",
    });
  });

  window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
    const reason = event.reason as { name?: string; message?: string; stack?: string } | undefined;
    reportClientError({
      name: typeof reason?.name === "string" ? reason.name : "UnhandledRejection",
      message:
        typeof reason?.message === "string" && reason.message.length > 0
          ? reason.message
          : String(event.reason),
      stack: typeof reason?.stack === "string" ? reason.stack : null,
      severity: "error",
    });
  });
}
