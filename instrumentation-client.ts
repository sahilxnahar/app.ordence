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
