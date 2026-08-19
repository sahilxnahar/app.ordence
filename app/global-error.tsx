"use client";

/**
 * Ordence — The last resort
 * Version: v0.95.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHY THIS FILE EXISTS — SENTRY TOLD US IT WAS MISSING
 * ══════════════════════════════════════════════════════════════════════
 * The build warned:
 *
 *   [@sentry/nextjs] It seems like you don't have a global error handler
 *   set up. React rendering errors are reported to Sentry [only] with a
 *   'global-error.js' file.
 *
 * ⚠️ WITHOUT THIS, A WHOLE CLASS OF FAULT IS INVISIBLE. `onRequestError`
 * in `instrumentation.ts` catches SERVER errors. A React render error in
 * the App Router — a component throwing during render on the client —
 * bypasses it entirely. The user sees a blank page, and nothing anywhere
 * records why.
 *
 * ⚠️ AND THIS COMPONENT REPLACES THE ROOT LAYOUT, so it must render its
 * own <html> and <body>. That is not a style choice; without them the
 * page renders nothing at all, which is the failure mode of the file
 * whose entire job is to handle a failure.
 */

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  useEffect(() => {
    /**
     * ⚠️ SAFE WITHOUT A DSN. `Sentry.init` is never called when
     * `SENTRY_ENABLED` is false, and `captureException` on an
     * uninitialised client is a no-op rather than a throw. An error page
     * that throws is worse than no error page.
     */
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "system-ui, -apple-system, sans-serif",
          display: "flex",
          minHeight: "100vh",
          alignItems: "center",
          justifyContent: "center",
          margin: 0,
          padding: "2rem",
        }}
      >
        <main style={{ maxWidth: "32rem", textAlign: "center" }}>
          <h1 style={{ fontSize: "1.25rem", fontWeight: 600, marginBottom: "0.5rem" }}>
            Something went wrong on this page.
          </h1>
          <p style={{ color: "#666", marginBottom: "1.5rem", lineHeight: 1.6 }}>
            {/**
             * ⚠️ THE MESSAGE IS NOT SHOWN. `error.message` on a client
             * render error can carry data from whatever the component was
             * rendering — a customer's name, an amount. The digest is the
             * safe handle: it means nothing to a stranger and everything
             * to us, because it is logged beside the real message in
             * `instrumentation.ts`.
             */}
            It has been reported automatically. Reloading usually helps — if it does not,
            quote the reference below.
          </p>

          {error.digest && (
            <p
              style={{
                fontFamily: "ui-monospace, monospace",
                fontSize: "0.8125rem",
                color: "#888",
                marginBottom: "1.5rem",
              }}
            >
              Reference: {error.digest}
            </p>
          )}

          {/**
           * ⚠️ A FULL RELOAD, NOT `reset()`. React's `reset` re-renders
           * the same tree that just threw; if the cause is the data
           * rather than a transient, it throws again immediately and the
           * button looks broken. A reload re-fetches everything.
           */}
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              padding: "0.5rem 1.25rem",
              borderRadius: "0.375rem",
              border: "1px solid #ccc",
              background: "#fff",
              cursor: "pointer",
              fontSize: "0.875rem",
            }}
          >
            Reload
          </button>
        </main>
      </body>
    </html>
  );
}
