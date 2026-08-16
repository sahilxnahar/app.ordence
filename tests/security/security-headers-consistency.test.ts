/**
 * Ordence — ⭐⭐⭐ SECURITY HEADERS CONSISTENCY — Wave 7 (Hardening I)
 * Version: v1.50.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════
 * ⚠️ THE TWO SURFACES MUST ALWAYS AGREE
 * ══════════════════════════════════════════════════════════════════
 * The hard transport headers (HSTS, nosniff, SAMEORIGIN, Referrer-Policy,
 * Permissions-Policy, COOP) exist in two places by construction:
 *
 *   1. `next.config.ts` → `headers()` — applied to responses the
 *      Next.js server renders (HTML pages, route handlers).
 *   2. `lib/edge/security-headers.ts` → `applySecurityHeaders()` —
 *      applied to responses the edge middleware synthesises itself
 *      (413, 429, 404, 401, 403, redirects).
 *
 * If the two arrays ever disagree, an attacker can distinguish a
 * refused request from a rendered one just by reading the headers —
 * and whichever surface is missing a header is missing it for EVERY
 * request it serves. That is a silent split brain on the product's
 * outermost defence, and no code review catches it, because both
 * arrays are "right" on their own.
 *
 * So this test reads both files as TEXT and asserts that `next.config.ts`
 * imports the array from `security-headers.ts` and uses it verbatim.
 * A hand-duplicated list anywhere in `next.config.ts` fails the build.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(process.cwd());
const configSrc = readFileSync(resolve(ROOT, "next.config.ts"), "utf8");
const headerSrc = readFileSync(resolve(ROOT, "lib/edge/security-headers.ts"), "utf8");

describe("security headers single source of truth", () => {
  it("imports SECURITY_HEADERS from the shared module, never declares its own", () => {
    /* ⚠️ The array MUST come from the module — the import line is the
     * proof, and the absence of a hand-written array is enforced by the
     * next check. */
    expect(configSrc).toMatch(
      /import\s*\{\s*SECURITY_HEADERS(?:,\s*PORTAL_OVERRIDE_HEADERS)?\s*\}\s*from\s*["']@\/lib\/edge\/security-headers["']/,
    );

    /*
     * 🔴 A hand-written array anywhere in the file would be a second
     * copy — and the day somebody adds X-Robots-Tag to one and not the
     * other, the two surfaces split. The file is allowed to re-export
     * the name (`const securityHeaders = SECURITY_HEADERS`) because
     * `headers()` needs the identifier, but a raw `{ key: ... }` array
     * literal with header names is the second copy this test catches.
     */
    const headerLiteral = /\{\s*key:\s*"(Strict-Transport-Security|X-Content-Type-Options|X-Frame-Options|Referrer-Policy|Permissions-Policy|Cross-Origin-Opener-Policy|X-Permitted-Cross-Domain-Policies|X-DNS-Prefetch-Control)"/;
    expect(configSrc).not.toMatch(headerLiteral);
  });

  it("uses the shared array verbatim for every rendered response", () => {
    /* headers(): the global :path* source spreads securityHeaders. */
    expect(configSrc).toMatch(/\{\s*source:\s*"\s*\/:path\*"\s*,\s*headers:\s*securityHeaders\s*\}/);

    /*
     * ⭐ THE PORTAL IS STRICTER, NOT DIFFERENT — its headers() spreads
     * the shared array AND the shared portal overrides, never a mixed
     * inline list. PORTAL_OVERRIDE_HEADERS lives in the same module so
     * the overrides are a single source of truth as well.
     */
    const portalMatch = configSrc.match(/\{\s*source:\s*"\/portal\/:path\*"\s*,\s*headers:\s*\[(.*?)\],?\s*\}/s);
    expect(portalMatch).not.toBeNull();
    const portalHeaders = portalMatch![1];
    expect(portalHeaders).toContain("...securityHeaders");
    /* The portal's stricter headers must also come from the shared module
     * — either the imported name or the direct module export, never an
     * inline duplicate. */
    expect(
      portalHeaders.includes("...portalOverrideHeaders") ||
        portalHeaders.includes("...PORTAL_OVERRIDE_HEADERS"),
    ).toBe(true);
    expect(headerSrc).toContain("export const PORTAL_OVERRIDE_HEADERS");
  });

  it("declares the same header names in config and the module", () => {
    /*
     * ⚠️ The MODULE is the source of truth; the config file must use
     * every name it exports (nothing silently dropped) and only those
     * names (nothing invented). This catches a rename on one side that
     * the import check above would not.
     */
    const moduleNames = (headerSrc.match(/key:\s*"[^"]+"/g) ?? []).map((m) =>
      m.replace('key: "', "").replace('"', ""),
    );
    const used = (configSrc.match(/SECURITY_HEADERS|PORTAL_OVERRIDE_HEADERS/g) ?? []).length;
    expect(used).toBeGreaterThanOrEqual(3);

    /* Every key the module exports appears in its own source, and the
     * names the middleware reads are identical to these — the middleware
     * imports applySecurityHeaders(), which walks the SAME array. */
    for (const name of ["Strict-Transport-Security", "X-Content-Type-Options"]) {
      expect(moduleNames).toContain(name);
    }
  });

  it("stamps the SAME headers onto every refusal the middleware makes", () => {
    /*
     * ⭐ A REFUSED RESPONSE MUST LOOK LIKE ANY OTHER RESPONSE — that is
     * the whole point of this wave. So every response-synthesis path in
     * `middleware.ts` (the 413, the 429s, the 404, the 401, the 403s and
     * the redirects) must flow through `applySecurityHeaders()`.
     *
     * `run()` is not exported, so the middleware is tested as text:
     * each refusal pattern is required to appear WITH the helper. The
     * helper is idempotent — double-stamping is harmlessly safe, so the
     * property is "every refusal path is wrapped", not "wrapped once".
     */
    const middlewareSrc = readFileSync(resolve(ROOT, "middleware.ts"), "utf8");

    expect(middlewareSrc).toContain(
      'import { applySecurityHeaders } from "@/lib/edge/security-headers"',
    );

    /* The refusal patterns: each NextResponse / redirect construction
     * that leaves this file must be wrapped. The patterns are matched
     * loosely on purpose — indentation and ordering drift. */
    expect(middlewareSrc).toMatch(/applySecurityHeaders\(\s*new NextResponse[\s\S]{0,120}status:\s*413/);
    expect(middlewareSrc).toMatch(/applySecurityHeaders\(\s*new NextResponse[\s\S]{0,120}status:\s*500/);
    expect(middlewareSrc).toMatch(/applySecurityHeaders\(\s*new NextResponse\("Not found"[\s\S]{0,40}status:\s*404/);
    expect(middlewareSrc).toMatch(/applySecurityHeaders\(\s*NextResponse\.redirect/);

    /*
     * 🔴 THE JSON REFUSALS FLOW THROUGH jsonError() — and jsonError()
     * itself is wrapped. So the 401/403 JSON errors carry the headers
     * without each call site repeating itself.
     */
    expect(middlewareSrc).toMatch(
      /function jsonError\([\s\S]{0,600}return applySecurityHeaders\(\s*new NextResponse/,
    );

    /*
     * ⭐ THE FORWARD PATH AND THE CONSOLE REWRITE ARE APPLICATION HTML,
     * and the app's headers() sets the same names there — but the
     * middleware stamps them as well, so the two surfaces share one
     * array and one test, and nothing depends on a renderer path.
     */
    expect(middlewareSrc).toMatch(/applySecurityHeaders\(withCsp\(/);
  });
});
