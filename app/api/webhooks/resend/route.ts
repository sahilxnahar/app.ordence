/**
 * Ordence — Resend webhook ROUTE. Deliberately thin.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 A `route.ts` MAY ONLY EXPORT WHAT NEXT.JS RECOGNISES AS A ROUTE
 * ══════════════════════════════════════════════════════════════════════
 * The HTTP verbs, plus the config fields. ANY other export is a hard
 * build error — and `tsc --noEmit` DOES NOT CATCH IT, because the rule
 * lives in types Next.js generates during `next build`. The Clerk
 * webhook is split the same way, for the same reason, after Railway
 * refused a build that was green on tsc and on every test.
 *
 * ⭐ The implementation is `_webhook.ts`. A leading underscore keeps it
 * out of Next's route resolution while leaving it directly importable by
 * the tests.
 */

/**
 * ⚠️ NODE RUNTIME IS MANDATORY, NOT A PREFERENCE. `svix` verifies with
 * `node:crypto`; on the Edge runtime this route would fail to build, or
 * worse, fall back to something that is not a constant-time comparison.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export { POST } from "./_webhook";
