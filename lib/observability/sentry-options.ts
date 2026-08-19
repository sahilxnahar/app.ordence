/**
 * Ordence — Shared Sentry configuration
 * Version: v0.95.0-alpha
 *
 * ⚠️ ONE OPTIONS BUILDER FOR CLIENT, SERVER AND EDGE. Three copies of an
 * init block is three places to forget the scrubber, and the one that
 * gets forgotten is always the one that ships the cookie.
 *
 * ⭐ NO DSN → SENTRY IS OFF, SILENTLY AND DELIBERATELY.
 *    `npm run build`, `npm test` and a local `next dev` all run without a
 *    DSN. An SDK that threw, warned on every request, or worse *buffered
 *    events until a DSN appeared* would make the absence of monitoring
 *    noisier than the presence of it.
 */

import { scrubEvent, type ScrubbableEvent } from "./scrub";

export const SENTRY_DSN =
  process.env.NEXT_PUBLIC_SENTRY_DSN ?? process.env.SENTRY_DSN ?? "";

export const SENTRY_ENABLED = SENTRY_DSN !== "";

/**
 * ⭐ THE RELEASE IS THE COMMIT, AND THAT IS WHAT MAKES SUSPECT COMMITS
 *    WORK.
 *
 * Railway injects `RAILWAY_GIT_COMMIT_SHA` on every deploy, so this needs
 * no variable to be set. Sentry matches it against the GitHub integration
 * and answers the only question that matters at 3am: *which deploy broke
 * this?*
 *
 * ⚠️ FALLS BACK TO THE PACKAGE VERSION, NOT TO "unknown". `/api/diag`
 * reports `version: "unset"` today for exactly that reason, and an
 * unnamed release groups every deploy together — which is the same as
 * having no releases at all.
 */
export function sentryRelease(): string | undefined {
  return (
    process.env.NEXT_PUBLIC_RELEASE ??
    process.env.RAILWAY_GIT_COMMIT_SHA ??
    process.env.npm_package_version ??
    undefined
  );
}

export function sentryEnvironment(): string {
  return process.env.RAILWAY_ENVIRONMENT_NAME ?? process.env.NODE_ENV ?? "development";
}

/**
 * ⚠️ `tracesSampleRate: 0` — ERRORS ONLY, FOR NOW.
 *
 * Performance tracing on a free plan burns the event quota in days, and
 * then the errors you actually needed are the ones that get dropped.
 * Turn it up deliberately, after Batch E's measurement work says which
 * routes are worth tracing.
 */
export function baseOptions() {
  return {
    dsn: SENTRY_DSN,
    enabled: SENTRY_ENABLED,
    release: sentryRelease(),
    environment: sentryEnvironment(),

    tracesSampleRate: 0,

    /**
     * ⚠️ OFF. Sentry's default is to attach the IP address and, where it
     * can, the user's email. Neither is needed to fix a bug, and both are
     * personal data crossing a border under someone else's retention
     * policy.
     */
    sendDefaultPii: false,

    /**
     * ⭐ THE LAST GATE BEFORE AN EVENT LEAVES THE PROCESS.
     *
     * ⚠️ IF THE SCRUBBER THROWS, THE EVENT IS DROPPED — not sent
     * unscrubbed. A monitoring tool that leaks a session cookie because
     * its own sanitiser had a bug is worse than one that lost an error.
     */
    /**
     * ⚠️ THE CAST LIVES HERE AND NOWHERE ELSE, on purpose.
     *
     * `scrub.ts` deliberately does not import the Sentry SDK — its rules
     * have to be testable without a network or a vendor. That leaves one
     * structural gap between its `ScrubbableEvent` and Sentry's
     * `ErrorEvent`, and this is the single line that bridges it. Widening
     * `ScrubbableEvent` to satisfy the SDK would drag the SDK's types
     * into the one module that must not depend on them.
     */
    beforeSend(event: unknown) {
      try {
        return scrubEvent(event as ScrubbableEvent) as never;
      } catch {
        return null;
      }
    },

    /**
     * ⚠️ NOISE THAT IS NOT A BUG. Every one of these is a browser or a
     * network being a browser or a network, and an inbox full of them is
     * how people stop reading the inbox.
     */
    ignoreErrors: [
      "ResizeObserver loop limit exceeded",
      "ResizeObserver loop completed with undelivered notifications",
      "Non-Error promise rejection captured",
      "NetworkError when attempting to fetch resource",
      "Failed to fetch",
      "Load failed",
      "AbortError",
      /^Loading chunk \d+ failed/,
      /^Loading CSS chunk/,
    ],
  };
}
