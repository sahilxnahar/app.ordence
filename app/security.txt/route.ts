/**
 * Ordence — /security.txt (RFC 9116)
 * Version: v1.52.x  (Batch 134)
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS IS FOR
 * ══════════════════════════════════════════════════════════════════════
 * Somebody who finds a flaw in Ordence needs one obvious place to send it.
 * Without that, reports arrive through whatever channel the finder happens
 * to have — a sales form, a LinkedIn message, a tweet — or they do not
 * arrive at all. RFC 9116 exists so that both humans and scanners can find
 * the address by convention rather than by guessing.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ `Expires` IS MANDATORY, AND A STALE ONE IS WORSE THAN NONE
 * ══════════════════════════════════════════════════════════════════════
 * The RFC requires an `Expires` field and says the value should be less
 * than a year out. The point is to stop a file published once in 2023 from
 * still advertising a mailbox nobody reads. A hardcoded date meets the
 * letter of the rule and then quietly expires — and an expired
 * security.txt is a signal to a researcher that nobody is home.
 *
 * ⭐ SO IT IS COMPUTED PER REQUEST, six months ahead of now. The file can
 * never go stale while the service is running, and if the service stops
 * being served the file stops being served with it, which is the honest
 * outcome. This is why it is a route handler and not a static file.
 *
 * 🔴 EXPORTS: HTTP verbs and Next config fields only. `scripts/
 * check-route-exports.mjs` fails the build on anything else — a helper
 * exported from a route file is treated by Next as a route export and the
 * failure mode is confusing. `SECURITY_TXT_EXPIRY_DAYS` therefore stays a
 * module constant, not an export.
 *
 * ⚠️ ALSO REACHABLE AT THE WELL-KNOWN PATH. The RFC's canonical location
 * is `/.well-known/security.txt`; the top-level path is the legacy
 * fallback that many scanners still check first. This handler serves the
 * top-level path. If the well-known path is wanted too, add a rewrite in
 * `next.config.ts` rather than a second copy of this text — two copies
 * drift, and the one that drifts is the one nobody reads.
 */

/**
 * Six months. Short enough that a dead mailbox is caught within a
 * half-year, long enough that the value is not churning on every deploy.
 */
const SECURITY_TXT_EXPIRY_DAYS = 180;

const CONTACT_EMAIL = "security@ordence.com";

/**
 * ⚠️ RENDERED PER REQUEST so that `Expires` is computed against the clock
 * of the request, not the clock of the build machine.
 */
export const dynamic = "force-dynamic";

export function GET(): Response {
  const expires = new Date(Date.now() + SECURITY_TXT_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  /*
   * Field order follows the RFC's own examples: Contact first, because it
   * is the only field that matters to somebody in a hurry.
   *
   * `Preferred-Languages` names English only. Listing a language nobody on
   * the team reads would be a small lie of exactly the kind the trust page
   * is written to avoid.
   */
  const body = [
    "# Ordence — how to report a security problem.",
    "# Format: RFC 9116. Served by app/security.txt/route.ts.",
    "",
    `Contact: mailto:${CONTACT_EMAIL}`,
    `Expires: ${expires.toISOString()}`,
    "Preferred-Languages: en",
    "Canonical: https://ordence.com/security.txt",
    "Policy: https://ordence.com/trust",
    "",
    "# We do not run a paid bug bounty and we do not want you to discover",
    "# that after doing the work. What we do offer: a human reply, an",
    "# honest timeline, and credit if you want it.",
    "#",
    "# Please do not test against a live customer workspace, and please do",
    "# not access data that is not yours in order to demonstrate that you",
    "# could. A clear description is enough; we will reproduce it.",
    "",
  ].join("\n");

  return new Response(body, {
    status: 200,
    headers: {
      /*
       * ⚠️ `text/plain` with an explicit charset is required by the RFC.
       * Serving this as HTML or as a download makes scanners skip it.
       */
      "content-type": "text/plain; charset=utf-8",
      /*
       * Cached briefly at the edge but revalidated — the body carries a
       * computed expiry, so a long cache would defeat the point above.
       */
      "cache-control": "public, max-age=3600, must-revalidate",
    },
  });
}
