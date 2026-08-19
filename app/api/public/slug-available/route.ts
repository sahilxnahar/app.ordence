/**
 * Ordence — Public slug availability
 * Version: v1.57.0-alpha
 *
 * POST { slug } → { available, reason?: { code, message }, suggestions? }
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE ANSWER IS ADVISORY AND CANNOT PREVENT A DUPLICATE.
 * ══════════════════════════════════════════════════════════════════════
 *      The availability check is advisory.
 *      The unique index is the truth.
 *      The insert is the claim.
 *
 * `tenants_slug_unique` and `tenants_slug_fold_unique` decide what may be
 * held; this endpoint only predicts them, and its prediction is stale the
 * moment it is returned. The claim path re-checks INSIDE the transaction
 * that inserts the row and maps the SQLSTATE with `rejectionFromPgError()`.
 *
 * 🔴 DO NOT "OPTIMISE" THE CLAIM BY TRUSTING THIS. The full argument, and
 *    the enumeration note that goes with it, are at the top of
 *    `./_availability.ts` — which is where the implementation lives and
 *    where anyone changing this behaviour will actually be reading.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 A `route.ts` MAY EXPORT ONLY THE HTTP VERBS AND NEXT'S CONFIG FIELDS
 * ══════════════════════════════════════════════════════════════════════
 * Anything else — a helper, a type, a constant — is a HARD BUILD FAILURE
 * that `tsc --noEmit` does not catch, because the rule is enforced by
 * types Next.js generates into `.next/types` during `next build`. It has
 * turned a Railway deploy red in this repository once already. That is
 * why every line of logic sits in `_availability.ts` (leading underscore:
 * Next does not treat it as a route) and this file re-exports one verb.
 * `scripts/check-route-exports.mjs` is the cheap static gate for it.
 */

import { checkSlugAvailability } from "./_availability";

/**
 * ⚠️ NODE RUNTIME, NOT EDGE. The check reads `tenants` and
 * `tenant_slug_history` through `withPlatformScope()`, which opens a
 * pooled WebSocket transaction — not an Edge target.
 */
export const runtime = "nodejs";

/**
 * Never cached, never statically analysed into a build-time answer. An
 * availability answer is true for an instant; a cached one is a lie with
 * a long tail.
 */
export const dynamic = "force-dynamic";

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 POST, WITH THE SLUG IN THE BODY. NEVER GET, NEVER A QUERY STRING.
 * ══════════════════════════════════════════════════════════════════════
 * A standing rule in this project: no user-supplied identifier goes in a
 * URL. A query string lands in the access log of every hop, in the
 * `Referer` header of whatever the page loads next, in browser history
 * and in any CDN or WAF that samples URLs. `?slug=acme-corp` is a record,
 * in half a dozen systems that were never scoped for it, of a name
 * somebody typed while deciding whether to become a customer.
 *
 * It also makes the endpoint cacheable by things trying to be helpful,
 * which is exactly wrong for an answer that expires instantly.
 */
export async function POST(request: Request) {
  return checkSlugAvailability(request);
}

/**
 * GET is 405, stated rather than left to Next's default.
 *
 * ⭐ Saying it here is what stops a CDN or a browser turning a GET into a
 *    cached response, and it makes the refusal explicit to anyone who
 *    tries the obvious `?slug=` form after reading the POST rule above.
 */
export function GET() {
  return new Response(null, {
    status: 405,
    headers: { allow: "POST", "cache-control": "no-store" },
  });
}
