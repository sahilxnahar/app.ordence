/**
 * Ordence — Clerk webhook ROUTE. Deliberately thin.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 A `route.ts` MAY ONLY EXPORT WHAT NEXT.JS RECOGNISES AS A ROUTE
 * ══════════════════════════════════════════════════════════════════════
 * The HTTP verbs, plus the config fields (`runtime`, `dynamic`,
 * `revalidate`, `maxDuration`, and a few others). ANY other export is a
 * hard build error:
 *
 *     Type error: Route "app/api/webhooks/clerk/route.ts" does not match
 *     the required types of a Next.js Route.
 *       "handleUserCreated" is not a valid Route export field.
 *
 * ⚠️ AND `tsc --noEmit` DOES NOT CATCH IT. That rule is enforced by types
 * Next.js GENERATES into `.next/types` during `next build`, so a project
 * can be green on tsc, green on every unit test, and still fail the
 * production build. This file exists because that is exactly what
 * happened: the handlers were exported from here so `_handlers.ts` could
 * re-export them for the evidence tests, and Railway refused the build.
 *
 * ⭐ THE IMPLEMENTATION DID NOT MOVE. It is `_webhook.ts`, byte for byte,
 * and a leading underscore keeps it out of Next's route resolution. The
 * seam `_handlers.ts` describes is unchanged; it now re-exports from
 * `_webhook.ts` rather than from a route file. Nothing about the webhook
 * contract, the Svix verification or the dispatch behaviour changed.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export { POST } from "./_webhook";
