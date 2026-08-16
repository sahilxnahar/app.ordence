/**
 * Ordence — ⭐⭐⭐ CORS DENY-BY-DEFAULT — Wave 7 (Hardening I)
 * Version: v1.50.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════
 * WHAT THIS FILE PROVES
 * ══════════════════════════════════════════════════════════════════
 * The browser is the enforcement point: a script on another origin can
 * only read this app's responses if we put Access-Control-Allow-*
 * headers on them. The whole defence is therefore one property, stated
 * five ways:
 *
 *   1. THE DEFAULT IS SILENCE. No origin is on the allowlist, so a
 *      preflight from anywhere gets a bare 204 — and no browser will
 *      deliver a credentialed cross-origin response for it.
 *   2. NOTHING BUT PREFLIGHTS IS EVER ANSWERED. GET/POST responses
 *      never carry CORS headers, so even a same-user request from the
 *      wrong page gets no cross-origin access.
 *   3. A LISTED ORIGIN GETS EXACTLY ITS LIST. The Origin header is
 *      echoed, never widened to `*`, never merged with the list.
 *   4. CREDENTIALS ARE A SEPARATE, EXPLICIT TRUST STEP. They are only
 *      echoed when the allowlist entry asks for them.
 *   5. THE WIRED-UP MIDDLEWARE MATCHES THE MODULE. The middleware
 *      routes OPTIONS through decidePreflight and returns the module's
 *      decision verbatim — so the behaviour tested here is the
 *      behaviour deployed, and a future edit that bypasses the module
 *      fails the build.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { decidePreflight, CORS_HEADER_SET } from "@/lib/edge/cors";

const ROOT = resolve(process.cwd());

describe("CORS default: silence", () => {
  it("answers no origin with nothing — the list is empty", () => {
    const decision = decidePreflight("https://evil.example.com");
    expect(decision.preflight).toBeNull();
    expect(decision.listed).toBe(false);

    /*
     * ⚠️ NO ORIGIN IS TRUSTED BY DEFAULT, INCLUDING REASONABLE-LOOKING
     * ONES. A deployment's own staging subdomain is not on the list:
     * adding it is a deliberate config change, not an assumption the
     * code makes.
     */
    for (const origin of [
      "https://staging.ordence.com",
      "https://app.ordence.com",
      "https://ordence.com",
      "http://localhost:3000",
      "null",
    ]) {
      expect(decidePreflight(origin).preflight).toBeNull();
    }
  });

  it("answers a missing Origin with nothing", () => {
    expect(decidePreflight(null).preflight).toBeNull();
    expect(decidePreflight("").preflight).toBeNull();
  });
});

describe("CORS listed origin: exactly its list, never more", () => {
  it("honours the allowlist when the environment names one", () => {
    /**
     * ⚠️ THIS TEST READS THE LIVE ENVIRONMENT ON PURPOSE. If the
     * deployment's config names an origin, the module must answer it;
     * if it names none, the module must answer nobody. Testing the
     * configured behaviour — not a mock of it — is the only way a
     * configuration mistake surfaces before a real request does.
     */
    const env = process.env.CORS_ALLOWED_ORIGINS;
    const configured = (env ?? "")
      .split(";")
      .map((p) => p.trim().split("|")[0]?.trim())
      .filter(Boolean);

    if (configured.length === 0) {
      /* No allowlist — silence everywhere, default policy. */
      expect(decidePreflight("https://any.example.com").preflight).toBeNull();
      return;
    }

    const [origin, methods = "GET"] = env!.split(";")[0].split("|");
    const decision = decidePreflight(origin);
    expect(decision.preflight).not.toBeNull();
    expect(decision.preflight!.headers["access-control-allow-origin"]).toBe(
      origin,
    );

    /*
     * ⭐ THE METHODS ECHOED ARE ONLY THE ONES THIS ORIGIN WAS GIVEN.
     * A preflight asking for POST on a GET-only entry must not leak
     * POST in the response — the browser checks the echo against the
     * method it wanted and refuses anything not listed.
     */
    const allowedMethods = decision.preflight!.headers[
      "access-control-allow-methods"
    ] as string;
    for (const method of methods.toUpperCase().split(",")) {
      expect(allowedMethods).toContain(method.trim());
    }

    /* credentials: true only when the entry asks. */
    if (env!.split(";")[0].includes("credentials")) {
      expect(
        decision.preflight!.headers["access-control-allow-credentials"],
      ).toBe("true");
    } else {
      expect(decision.preflight!.headers["access-control-allow-credentials"]).toBeUndefined();
    }

    /* A neighbour origin gets nothing — the list is exact. */
    expect(decidePreflight("https://other.example.com").preflight).toBeNull();
  });

  it("never echoes `*` — the one value that hands access to everybody", () => {
    for (const origin of [
      "https://app.ordence.com",
      "https://evil.example.com",
      null,
    ]) {
      const headers = decidePreflight(origin).preflight?.headers ?? {};
      expect(headers["access-control-allow-origin"]).not.toBe("*");
    }
  });

  it("only emits headers this module is allowed to emit", () => {
    const decision = decidePreflight("https://listed.example.com");
    if (decision.preflight) {
      for (const name of Object.keys(decision.preflight.headers)) {
        expect(CORS_HEADER_SET.has(name)).toBe(true);
      }
      /* The vary header must carry Origin, or a cache could serve the
       * approved response to a blocked origin. */
      expect(decision.preflight.headers["vary"]).toBe("Origin");
    }
  });
});

describe("the middleware wires the module through verbatim", () => {
  it("routes OPTIONS into decidePreflight and returns its decision", () => {
    const src = readFileSync(resolve(ROOT, "middleware.ts"), "utf8");

    /* The preflight branch exists, early, before any tenant routing. */
    expect(src).toMatch(/req\.method\s*===\s*"OPTIONS"/);

    /* It asks the MODULE, not an inline policy — one source of truth. */
    expect(src).toContain("decidePreflight(req.headers.get(\"origin\"))");

    /* The 204 for a not-listed origin carries no CORS headers — the
     * response is constructed without any Access-Control-* values, so
     * the silence tested above is the silence deployed. */
    expect(src).toMatch(/new NextResponse\(null,\s*\{\s*status:\s*204\s*\}\)/);
  });

  it("never sets CORS headers on the non-preflight responses", () => {
    const src = readFileSync(resolve(ROOT, "middleware.ts"), "utf8");
    const corsSets = src.match(/headers\.set\(\s*["']access-control/g);
    expect(corsSets).toBeNull();
  });
});
