/**
 * Ordence — ⭐⭐⭐ THE ADDRESS WE HAND OUT
 * Version: v1.17.0-alpha
 *
 * Pure. No clock, no network, no database.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THIS MODULE EXISTS BECAUSE THE ADDRESS WAS WRONG FOR FIVE SESSIONS
 * ══════════════════════════════════════════════════════════════════════
 * `createConnection` minted `/api/webhooks/${connectorKey}/${token}` and
 * `getConnections` rebuilt the same string a second time, by hand, four
 * hundred lines away. The route that actually exists is
 *
 *     app/api/webhooks/intake/[token]/route.ts
 *
 * There is no `[connector]` segment and there never was. So every
 * address the product would have printed — `/api/webhooks/justdial/…` —
 * was a 404.
 *
 * ⚠️ NOBODY CAUGHT IT BECAUSE NOTHING CALLED `createConnection`. The bug
 * was invisible for exactly as long as the feature was unreachable, and
 * it surfaced in the first hour of wiring a form to it.
 *
 * 🔴 AND IT IS THE WORST KIND OF WRONG. A JustDial address goes to their
 * account manager in an email and is then effectively permanent. Getting
 * it wrong does not produce an error on our screen; it produces a
 * customer who was told the integration was live, a far end cheerfully
 * POSTing into a 404, and nothing anywhere that says so.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ SO THERE IS ONE FUNCTION AND EVERY CALLER USES IT
 * ══════════════════════════════════════════════════════════════════════
 * Two hand-built copies of a path is one source of truth too many. A
 * test asserts that `INTAKE_ROUTE_DIR` names a directory that is really
 * on disk, so moving the route without moving this constant fails the
 * build rather than the customer.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ AND THE CONNECTOR IS DELIBERATELY NOT IN THE PATH
 * ══════════════════════════════════════════════════════════════════════
 * It reads better with it. That is the whole of the argument for, and it
 * loses to two arguments against.
 *
 * ① The token already identifies the endpoint, which identifies the
 *    connection, which names the connector. Putting the connector in the
 *    URL as well creates two answers to one question, and the day they
 *    disagree is the day somebody changes a connector on an existing
 *    connection.
 *
 * ② The address is permanent in a way our database is not. It lives in
 *    a far end's configuration screen that we cannot edit. Encoding a
 *    mutable fact in an immutable string is how you get a URL that lies.
 */

/**
 * 🔴 THE ONE PLACE THE ROUTE'S LOCATION IS WRITTEN DOWN.
 *
 * ⚠️ Changing this without moving `app/api/webhooks/intake/[token]`
 * fails `tests/ui/connection-setup.test.ts`, which stats the directory.
 */
export const INTAKE_ROUTE_DIR = "app/api/webhooks/intake/[token]" as const;

/** The path portion, always absolute, never with a trailing slash. */
export function webhookPathFor(pathToken: string): string {
  return `/api/webhooks/intake/${pathToken}`;
}

/**
 * ⭐ THE WHOLE ADDRESS, WHICH IS WHAT A PERSON ACTUALLY NEEDS.
 *
 * ⚠️ A relative path is useless to the human being who has to type it
 * into IndiaMART's seller panel or paste it into an email to JustDial.
 * The screen shows this, not the path.
 *
 * 🔴 `baseUrl` IS PASSED IN RATHER THAN READ FROM `process.env` HERE,
 * because this module is imported by pure tests that have no
 * environment, and because a tenant on a custom domain has a different
 * base from the one Railway knows about.
 *
 * Any trailing slash on the base is removed, since `NEXT_PUBLIC_APP_URL`
 * is typed by hand about as often as it is generated.
 */
export function webhookUrlFor(baseUrl: string, pathToken: string): string {
  return `${baseUrl.trim().replace(/\/+$/, "")}${webhookPathFor(pathToken)}`;
}
