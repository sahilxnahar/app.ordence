/**
 * Ordence — Portal Token Cryptography
 * Version: v0.9.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * PHASE 9 MANDATORY VERIFICATION #1
 * ══════════════════════════════════════════════════════════════════════
 * "Verify the token generation uses a cryptographically secure randomizer,
 *  not Math.random()."
 *
 * A test cannot inspect which primitive a function called. What it CAN do
 * is assert the properties that follow from using a CSPRNG and that
 * `Math.random()` could not provide, and separately assert that the source
 * file contains no call to it. Both are below.
 *
 * Why this matters concretely: V8's `Math.random()` is xorshift128+. Given
 * a handful of consecutive outputs its internal state can be solved for,
 * and every past and future output reconstructed. Applied here that means
 * a client who legitimately received two or three portal links could
 * derive the tokens for every OTHER client's contracts — with no brute
 * force at all.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  generatePortalToken,
  hashPortalToken,
  isWellFormedToken,
  tokenHashesMatch,
  buildPortalUrl,
  maskToken,
} from "@/lib/portal/tokens";

describe("token generation — the CSPRNG requirement", () => {
  it("uses node:crypto and NEVER Math.random()", () => {
    // Read the source rather than trusting the docblock.
    const source = readFileSync(
      join(process.cwd(), "lib/portal/tokens.ts"),
      "utf8",
    );

    // Strip comments — the file DISCUSSES Math.random() at length, and the
    // property under test is that it never CALLS it.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");

    expect(code).not.toMatch(/Math\s*\.\s*random/);
    expect(code).toMatch(/randomBytes/);
    expect(code).toMatch(/from "node:crypto"/);
  });

  it("produces 256 bits of entropy per token", () => {
    const { token } = generatePortalToken();
    // 64 hex characters × 4 bits.
    expect(token).toHaveLength(64);
    expect(token.length * 4).toBe(256);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces no collisions across 20,000 draws", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20_000; i++) seen.add(generatePortalToken().token);
    expect(seen.size).toBe(20_000);
  });

  it("produces tokens with no detectable positional bias", () => {
    // A weak generator often skews the distribution of nibbles. This is a
    // sanity check, not a statistical proof — but a generator returning
    // constants or a short cycle would fail it loudly.
    const counts = new Map<string, number>();
    const draws = 2_000;

    for (let i = 0; i < draws; i++) {
      const first = generatePortalToken().token[0]!;
      counts.set(first, (counts.get(first) ?? 0) + 1);
    }

    // All 16 hex values should appear across 2,000 draws.
    expect(counts.size).toBe(16);

    const expected = draws / 16;
    for (const [, n] of counts) {
      // Generous bounds — this catches a broken generator, not a biased bit.
      expect(n).toBeGreaterThan(expected * 0.4);
      expect(n).toBeLessThan(expected * 1.6);
    }
  });

  it("stores a HASH, never the token itself", () => {
    const { token, tokenHash } = generatePortalToken();

    expect(tokenHash).not.toBe(token);
    expect(tokenHash).toHaveLength(64);
    // Deterministic, so a lookup by hash works.
    expect(hashPortalToken(token)).toBe(tokenHash);
    // And the hash does not contain the token.
    expect(tokenHash).not.toContain(token.slice(0, 16));
  });

  it("exposes a prefix that is NOT sufficient to authenticate", () => {
    const { token, tokenPrefix } = generatePortalToken();

    expect(tokenPrefix).toHaveLength(8);
    expect(token.startsWith(tokenPrefix)).toBe(true);
    // 8 hex characters is 32 bits and is never compared during
    // authentication — it exists only so staff can tell links apart.
    expect(tokenPrefix.length).toBeLessThan(token.length);
  });
});

describe("token shape validation", () => {
  it("accepts a genuine token", () => {
    expect(isWellFormedToken(generatePortalToken().token)).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["too short", "abc123"],
    ["too long", "a".repeat(65)],
    ["uppercase hex", "A".repeat(64)],
    ["non-hex", "z".repeat(64)],
    ["path traversal", "../../../etc/passwd"],
    ["script tag", "<script>alert(1)</script>"],
    ["sql-ish", "' OR '1'='1"],
    ["null", null],
    ["number", 12345],
    ["object", { toString: () => "a".repeat(64) }],
  ])("rejects %s", (_label, value) => {
    // Refused before the database is touched, so hostile input never
    // becomes a query.
    expect(isWellFormedToken(value)).toBe(false);
  });
});

describe("hash comparison", () => {
  it("matches identical hashes and rejects different ones", () => {
    const a = generatePortalToken();
    const b = generatePortalToken();

    expect(tokenHashesMatch(a.tokenHash, a.tokenHash)).toBe(true);
    expect(tokenHashesMatch(a.tokenHash, b.tokenHash)).toBe(false);
  });

  it("rejects mismatched lengths without throwing", () => {
    expect(tokenHashesMatch("abc", "abcdef")).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(tokenHashesMatch(null as any, "abc")).toBe(false);
  });
});

describe("URL construction and masking", () => {
  it("builds an absolute portal URL", () => {
    const { token } = generatePortalToken();
    const url = buildPortalUrl(token, "https://app.example.com");

    // Absolute, because this goes into an email — a relative path in an
    // inbox resolves against the mail client's origin and goes nowhere.
    expect(url).toBe(`https://app.example.com/portal/${token}`);
  });

  it("strips a trailing slash from the base URL", () => {
    const { token } = generatePortalToken();
    expect(buildPortalUrl(token, "https://app.example.com/")).toBe(
      `https://app.example.com/portal/${token}`,
    );
  });

  it("masks a token so it can be logged safely", () => {
    const { token } = generatePortalToken();
    const masked = maskToken(token);

    expect(masked).not.toBe(token);
    expect(masked.length).toBeLessThan(token.length);
    // Enough to identify, not enough to use.
    expect(masked).toContain("…");
  });
});
