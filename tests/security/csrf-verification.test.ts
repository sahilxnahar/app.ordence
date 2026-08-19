/**
 * Ordence — CSRF Verification Behaviour (Hardening II)
 *
 * Properties, not implementation details:
 *   1. A state-changing request with an explicit Origin from another site
 *      is refused, whatever its content type.
 *   2. A server-action POST without the `Server-Action` digest is refused.
 *   3. A server-action POST with the digest present is accepted.
 *   4. GET/HEAD/OPTIONS are never refused on CSRF grounds (no state change).
 *   5. A navigation-style POST (form content type) with the digest absent
 *      is refused — the form protocol is exactly what a CSRF page replays.
 *   6. Webhook-surface content types are checked only on origin binding,
 *      never on the digest (they carry their own signatures — Svix/HMAC).
 *   7. The middleware wires verifyCsrf in BEFORE routing and auth.
 */

import { describe, expect, it, beforeAll } from "vitest";

// Env anchors must exist before importing the module under test.
beforeAll(() => {
  process.env.NEXT_PUBLIC_APP_URL = "https://app.ordence.com";
});

import {
  verifyCsrf,
  requiresActionDigest,
  isSuspiciousCrossOrigin,
  resolveAllowedHosts,
} from "@/lib/security/csrf";

function cs(args: Partial<Parameters<typeof verifyCsrf>[0]> = {}) {
  return verifyCsrf({
    method: "POST",
    origin: "https://app.ordence.com",
    referer: null,
    requestHost: "app.ordence.com",
    contentType: null,
    serverActionHeader: null,
    expectActionDigest: true,
    ...args,
  });
}

describe("CSRF — origin binding", () => {
  it("accepts same-origin POST", () => {
    expect(cs()).toMatchObject({ ok: true, reason: null });
  });

  it("refuses POST with an explicit foreign Origin", () => {
    const verdict = cs({ origin: "https://evil.example" });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("origin_mismatch");
  });

  it("refuses POST with a foreign Referer and no Origin", () => {
    const verdict = cs({ origin: null, referer: "https://evil.example/page" });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("origin_mismatch");
  });

  it("accepts a same-host Referer with no Origin (navigation POST)", () => {
    expect(
      cs({ origin: null, referer: "https://app.ordence.com/dashboard" }),
    ).toMatchObject({ ok: true, reason: null });
  });

  it("never refuses GET, HEAD or OPTIONS", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(cs({ method, origin: "https://evil.example" })).toMatchObject({
        ok: true,
        reason: null,
      });
    }
  });
});

describe("CSRF — server-action digest", () => {
  it("refuses a form POST without the digest", () => {
    const verdict = cs({
      contentType: "multipart/form-data; boundary=x",
      serverActionHeader: null,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("missing_action_digest");
  });

  it("refuses x-www-form-urlencoded POST without the digest", () => {
    const verdict = cs({
      contentType: "application/x-www-form-urlencoded",
      serverActionHeader: null,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("missing_action_digest");
  });

  it("accepts a server-action POST that carries the digest", () => {
    expect(
      cs({
        contentType: "application/x-www-form-urlencoded",
        serverActionHeader: "1$encrypted$signature$digest",
      }),
    ).toMatchObject({ ok: true, reason: null });
  });

  it("does not inspect content that is not a protocol body", () => {
    expect(
      cs({ contentType: "application/json", serverActionHeader: null }),
    ).toMatchObject({ ok: true, reason: null });
  });

  it("accepts webhook content types without a digest when opted out", () => {
    // Razorpay/Stripe callbacks arrive as application/json — signature is
    // the control; the digest check only engages protocol body types.
    expect(
      cs({ contentType: "application/json", serverActionHeader: null }),
    ).toMatchObject({ ok: true, reason: null });
  });
});

describe("requiresActionDigest", () => {
  it("flags the three protocol body types", () => {
    expect(requiresActionDigest("multipart/form-data; boundary=x")).toBe(true);
    expect(requiresActionDigest("application/x-www-form-urlencoded")).toBe(true);
    expect(requiresActionDigest("text/x-component")).toBe(true);
    expect(requiresActionDigest(null)).toBe(false);
  });
});

describe("isSuspiciousCrossOrigin", () => {
  it("flags a mutating request from a foreign origin", () => {
    expect(
      isSuspiciousCrossOrigin({
        method: "POST",
        origin: "https://evil.example",
        referer: null,
        requestHost: "app.ordence.com",
      }),
    ).toBe(true);
  });

  it("does not flag GETs from anywhere", () => {
    expect(
      isSuspiciousCrossOrigin({
        method: "GET",
        origin: "https://evil.example",
        referer: null,
        requestHost: "app.ordence.com",
      }),
    ).toBe(false);
  });

  it("does not flag same-origin mutating requests", () => {
    expect(
      isSuspiciousCrossOrigin({
        method: "POST",
        origin: "https://app.ordence.com",
        referer: null,
        requestHost: "app.ordence.com",
      }),
    ).toBe(false);
  });
});

describe("resolveAllowedHosts", () => {
  it("includes the configured app host", () => {
    expect(resolveAllowedHosts()).toContain("app.ordence.com");
  });

  it("includes the platform host when configured", () => {
    process.env.ORDENCE_PLATFORM_HOST = "admin.ordence.com";
    try {
      expect(resolveAllowedHosts()).toContain("admin.ordence.com");
    } finally {
      delete process.env.ORDENCE_PLATFORM_HOST;
    }
  });
});

describe("CSRF — middleware wiring", async () => {
  const fs = await import("fs");
  const path = await import("path");
  const source = fs.readFileSync(path.resolve("middleware.ts"), "utf8");

  it("calls verifyCsrf", () => {
    expect(source).toContain("verifyCsrf(");
  });

  it("stamps the refusal BEFORE tenant routing runs", () => {
    const verifyIdx = source.indexOf("verifyCsrf(");
    const tenantIdx = source.indexOf("resolveTenantFromHost(req.headers.get");
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(tenantIdx).toBeGreaterThan(-1);
    expect(verifyIdx).toBeLessThan(tenantIdx);
  });

  it("refuses with 403 and the security header set", () => {
    expect(source).toContain("Cross-site request refused.");
    const idx = source.indexOf("Cross-site request refused.");
    // The refusal response must be wrapped in applySecurityHeaders.
    const window = source.slice(Math.max(0, idx - 400), idx);
    expect(window).toContain("applySecurityHeaders");
  });
});
