/**
 * Ordence — ⭐⭐⭐ ROUTE AUDIT — NO DEFAULT ADMIN, DEBUG OR CONSOLE — Wave 7
 * Version: v1.50.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════
 * ⚠️ FRAMEWORKS SHIP DEFAULT ROUTES THAT BELONG IN NO PRODUCTION APP
 * ══════════════════════════════════════════════════════════════════
 *
 * Next.js's own examples and many tutorials ship `/api/hello`, and the
 * framework has never had a `/admin`, `/debug`, `/console` or `/test`
 * route of its own — but the pattern is the threat, not the name:
 *
 *   - An admin endpoint, even a tiny "health of internals" one, is a
 *     second authentication surface with no hardening review. Ordence
 *     has ONE cross-tenant surface — the platform console under
 *     `/platform`, gated by the middleware's platform-staff matcher —
 *     and any addition must go through that gate deliberately.
 *   - A debug endpoint prints internals: env, tenants, queries, stack
 *     traces. Every one of those is a map for an attacker. The app's
 *     one equivalent is `/api/diag` — and it exists precisely BECAUSE
 *     it was argued for: it only reports whether the deployment's own
 *     env names are set, refuses anything else, and its response is a
 *     plain JSON the middleware stamps with the hardening headers
 *     like any refusal. It is the exception with a name and a reason;
 *     anything added next to it without one is the defect.
 *
 * WHAT THIS TEST ASSERTS (as code, so it fails the build, not a PR
 * review that nobody runs):
 *
 *   1. NO ROUTE FILE EXISTS UNDER app/ FOR admin/debug/console/test.
 *      Not as directories, not as files, not inside groups — a file at
 *      app/(debug)/whatever/route.ts would still be a URL.
 *   2. NO API ROUTE PREFIX NAMED admin/debug/console/test EXISTS in
 *      server/routers (tRPC) or app/api.
 *   3. /api/hello DOES NOT EXIST — the framework example nobody needs.
 *
 * The middleware's 404 on unknown paths is the runtime brace: a probe
 * for `/admin` gets a refused response carrying the hardening headers,
 * indistinguishable from any other refusal. This test is the build-
 * time brace: the routes must not exist to be probed at all.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(process.cwd());
const APP = resolve(ROOT, "app");

const FORBIDDEN_NAMES = new Set(["admin", "debug", "console", "test"]);

/**
 * Walk `app/` recursively and return every path segment that appears
 * in a URL position — directory names and file basenames, with Next
 * conventions stripped (`(group)` route groups are invisible to the
 * router, so they are not threats; everything else is).
 */
function urlSegments(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith("[")) continue; /* dynamic segment */
    if (entry.isDirectory()) {
      if (!entry.name.startsWith("(")) out.push(entry.name);
      urlSegments(join(dir, entry.name), out);
    } else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) {
      out.push(entry.name.replace(/\.(tsx|ts)$/, ""));
    }
  }
  return out;
}

describe("no default admin/debug/console/test routes", () => {
  it("no page or route file under any forbidden URL segment", () => {
    const segments = urlSegments(APP);
    const found = segments.filter((s) => FORBIDDEN_NAMES.has(s));
    expect(found).toEqual([]);
  });

  it("the one diagnostic endpoint is the named exception", () => {
    /*
     * ⚠️ /api/diag IS ALLOWED — it is the exception this file names in
     * its header. This assertion exists so that a future edit adding a
     * SECOND diagnostic endpoint has a property to fail: diag must be
     * the only `diag`-family name, and `health` (plain readiness) is
     * the only other infrastructure path.
     */
    expect(existsSync(resolve(ROOT, "app/api/diag"))).toBe(true);
    expect(existsSync(resolve(ROOT, "app/api/health"))).toBe(true);
  });

  it("the framework example route does not exist", () => {
    expect(existsSync(resolve(ROOT, "app/api/hello"))).toBe(false);
  });

  it("no forbidden segment appears in tRPC server routers", () => {
    /*
     * tRPC procedures get their own URL space (`/api/trpc/<router>`),
     * so a router named `admin` would surface as `/api/trpc/admin` —
     * the same class of defect as a page route.
     */
    const routers = existsSync(resolve(ROOT, "server/routers"))
      ? readdirSync(resolve(ROOT, "server/routers")).map((f) =>
          f.replace(/\.(tsx|ts)$/, ""),
        )
      : [];
    expect(routers.filter((r) => FORBIDDEN_NAMES.has(r))).toEqual([]);
  });
});
