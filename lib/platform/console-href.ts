import "server-only";
import { headers } from "next/headers";

export { consoleHref, CONSOLE_NAV, type ConsoleNavItem } from "./console-paths";

/**
 * Ordence — ⭐⭐ ONE LINK HELPER, BECAUSE THE CONSOLE HAS TWO BASE PATHS
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE BUG THIS EXISTS TO KILL
 * ══════════════════════════════════════════════════════════════════════
 * The staff console is reachable at two different base paths, and until
 * this helper existed every link in it assumed one of them:
 *
 *   app.ordence.com/platform/tenants     ← the real route on disk
 *   admin.ordence.com/tenants            ← the console's own host
 *
 * On `admin.` the middleware REWRITES `/tenants` to `/platform/tenants`.
 * The page renders, the URL bar keeps saying `/tenants`, and everything
 * looks correct , until you click something.
 *
 * ⚠️ EVERY NAVIGATION LINK POINTED AT `/platform/...`, WHICH ON THE
 * CONSOLE HOST IS NOT A REWRITTEN PATH. Traced live, the chain was:
 *
 *   click "Workspaces"        → /platform/tenants
 *   not rewritten (already starts with /platform), falls through
 *   downstream tenant resolution finds no tenant
 *                             → redirect to /dashboard
 *   /dashboard IS rewritten   → /platform/dashboard
 *   which does not exist      → 404
 *
 * So the console loaded perfectly and every single link in it landed on
 * a 404. The operator could see the product and could not use it.
 *
 * ⭐ WHY THE FIX IS HERE AND NOT IN THE MIDDLEWARE. Turning the rewrite
 * into a redirect looks like the tidier fix and is the wrong one: the
 * rewritten path is the ONLY form that currently works, so "fixing" the
 * middleware breaks the one thing that was not broken. The links were
 * wrong, not the routing.
 *
 * ⚠️ THE HOST IS THE ONLY INPUT. Not an env var read at build time, not
 * a prop threaded through twelve components , the request's own `Host`
 * header, which is the same thing the middleware decided on.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHERE `consoleHref` ACTUALLY LIVES NOW, AND WHY IT MOVED
 * ══════════════════════════════════════════════════════════════════════
 * This module reads `headers()`, so it carries `import "server-only"` and
 * a `"use client"` file may not import it — webpack refuses, and so does
 * `scripts/check-server-boundaries.mjs`. The command palette is a client
 * component and needs the SAME mapping, so the pure half was moved to
 * `lib/platform/console-paths.ts` and is re-exported below.
 *
 * ⭐ RE-EXPORTED RATHER THAN MOVED-AND-UPDATED so that every existing
 * `import { consoleHref } from "@/lib/platform/console-href"` keeps
 * compiling. There is still exactly one implementation.
 */

/**
 * True when this request arrived on the console's own hostname, where
 * the middleware has already mapped `/x` onto `/platform/x`.
 */
export async function onConsoleHost(): Promise<boolean> {
  const h = await headers();
  const raw = (h.get("host") ?? "").toLowerCase().split(":")[0] ?? "";
  if (!raw) return false;

  const explicit = (process.env.PLATFORM_HOST ?? "").toLowerCase().split(":")[0];
  if (explicit) return raw === explicit;

  const zone = (process.env.NEXT_PUBLIC_ZONE_DOMAIN ?? "").toLowerCase().split(":")[0];
  return zone ? raw === `admin.${zone}` : false;
}

/*
 * `consoleHref()` is re-exported at the top of this file from
 * `./console-paths`. It is not defined here because a client component
 * needs it and cannot import a server-only module.
 */
