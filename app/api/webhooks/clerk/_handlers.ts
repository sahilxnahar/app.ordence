/**
 * Ordence — Clerk Webhook: testable seam for the user-event handlers.
 *
 * The user handlers in `route.ts` are deliberately NOT exported there:
 * they are internals of the webhook contract and a direct import of
 * `route.ts` drags Svix, `next/server`, and the whole POST body into any
 * consumer — including tests. This module re-exports exactly the
 * functions evidence-tests need, nothing else.
 *
 * The design rule being enforced: verification (Svix signature, replay
 * window) and dispatch (what the platform does with a verified event) are
 * separate concerns. Dispatch is what leaves traces in `security_events`,
 * and it is dispatch that this seam exposes.
 */

export {
  handleUserCreated,
  handleUserUpdated,
  handleSignInAttemptFailed,
} from "./_webhook";
