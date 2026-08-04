/**
 * Ordence — Content-Security-Policy tests
 * Version: v0.67.0-alpha
 *
 * These assert the properties that make a CSP worth having at all. Almost
 * every deployed CSP in the world is decoration, and it is decoration for
 * one of exactly three reasons: it contains `unsafe-inline` in `script-src`,
 * it omits `base-uri`, or the nonce is not actually per-request. Each of
 * those has a test below, phrased as the failure rather than the feature.
 */

import { describe, it, expect } from "vitest";
import { buildCsp, cspHeaderName, generateNonce } from "@/lib/security/csp";

/** Pull one directive's sources out of the policy string. */
function directive(policy: string, name: string): string[] {
  const found = policy
    .split(";")
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `));

  if (found === undefined) return [];
  return found.slice(name.length).trim().split(/\s+/).filter(Boolean);
}

describe("Content-Security-Policy", () => {
  const nonce = generateNonce();

  describe("the three ways a CSP becomes decoration", () => {
    it("⚠️ never allows unsafe-inline in script-src — that single token disables the whole policy", () => {
      for (const isDev of [false, true]) {
        const policy = buildCsp({ nonce, isDev });
        expect(directive(policy, "script-src")).not.toContain("'unsafe-inline'");
      }
    });

    it("⚠️ sets base-uri — without it an injected <base> repoints every relative script and defeats the nonce", () => {
      expect(directive(buildCsp({ nonce }), "base-uri")).toEqual(["'self'"]);
    });

    it("⚠️ mints a different nonce every call — a reused nonce is exactly unsafe-inline wearing a costume", () => {
      const seen = new Set(Array.from({ length: 200 }, () => generateNonce()));
      expect(seen.size).toBe(200);
    });
  });

  describe("script-src", () => {
    it("carries the nonce it was given", () => {
      expect(directive(buildCsp({ nonce }), "script-src")).toContain(`'nonce-${nonce}'`);
    });

    it("includes strict-dynamic, without which Clerk cannot load its own chunks", () => {
      expect(directive(buildCsp({ nonce }), "script-src")).toContain("'strict-dynamic'");
    });

    it("⚠️ allows unsafe-eval in development ONLY — React Refresh needs it, production must never have it", () => {
      expect(directive(buildCsp({ nonce, isDev: true }), "script-src")).toContain("'unsafe-eval'");
      expect(directive(buildCsp({ nonce, isDev: false }), "script-src")).not.toContain("'unsafe-eval'");
    });

    it("defaults to production when isDev is not passed — a forgotten flag must fail safe, not open", () => {
      expect(directive(buildCsp({ nonce }), "script-src")).not.toContain("'unsafe-eval'");
    });
  });

  describe("the directives that cost nothing and close real holes", () => {
    it("forbids plugins outright", () => {
      expect(directive(buildCsp({ nonce }), "object-src")).toEqual(["'none'"]);
    });

    it("pins form submissions to this origin, so an injected form cannot POST customer data elsewhere", () => {
      expect(directive(buildCsp({ nonce }), "form-action")).toEqual(["'self'"]);
    });

    it("refuses to be framed", () => {
      expect(directive(buildCsp({ nonce }), "frame-ancestors")).toEqual(["'none'"]);
    });

    it("does not wildcard connect-src — that is the directive governing exfiltration", () => {
      const sources = directive(buildCsp({ nonce }), "connect-src");
      expect(sources).not.toContain("https:");
      expect(sources).not.toContain("*");
      expect(sources).toContain("'self'");
    });
  });

  describe("style-src", () => {
    it("⚠️ knowingly allows unsafe-inline for STYLES ONLY — React emits computed style attributes and nonces do not apply to attributes", () => {
      expect(directive(buildCsp({ nonce }), "style-src")).toContain("'unsafe-inline'");
      // The point of the exception is that it stays in styles.
      expect(directive(buildCsp({ nonce }), "script-src")).not.toContain("'unsafe-inline'");
    });
  });

  describe("report-uri", () => {
    it("is omitted when no collector is configured", () => {
      expect(buildCsp({ nonce })).not.toContain("report-uri");
    });

    it("is appended when one is", () => {
      expect(buildCsp({ nonce, reportUri: "/api/csp-report" })).toContain("report-uri /api/csp-report");
    });
  });

  describe("which header name carries it", () => {
    it("⚠️ ships REPORT-ONLY by default — an enforcing policy one directive short is a white screen for every customer at once", () => {
      expect(cspHeaderName(false)).toBe("content-security-policy-report-only");
    });

    it("enforces when explicitly told to", () => {
      expect(cspHeaderName(true)).toBe("content-security-policy");
    });
  });

  describe("well-formedness", () => {
    it("emits no empty segments and no duplicate directives", () => {
      const policy = buildCsp({ nonce, reportUri: "/api/csp-report" });
      const parts = policy.split(";").map((p) => p.trim());

      expect(parts.every((p) => p.length > 0)).toBe(true);

      const names = parts.map((p) => p.split(/\s+/)[0]);
      expect(new Set(names).size).toBe(names.length);
    });

    it("declares a default-src, so an unlisted directive falls back to self rather than to anything", () => {
      expect(directive(buildCsp({ nonce }), "default-src")).toEqual(["'self'"]);
    });

    it("produces a nonce that is valid base64 and at least 128 bits", () => {
      const value = generateNonce();
      expect(value).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
      expect(atob(value).length).toBeGreaterThanOrEqual(16);
    });
  });
});
