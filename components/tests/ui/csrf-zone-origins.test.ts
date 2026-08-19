/**
 * Ordence — The CSRF origin check must accept every host in our own zone
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE DEFECT THIS SUITE WOULD HAVE CAUGHT
 * ══════════════════════════════════════════════════════════════════════
 * `resolveAllowedHosts()` built its set from three explicit variables and
 * had no wildcard and no zone derivation, while Railway serves
 * `app.ordence.com`, `admin.ordence.com` and `*.ordence.com` from one
 * service. So a POST from `acme.ordence.com` was refused with 403
 * "Cross-site request refused." in middleware, before Clerk and before
 * routing — and it was invisible, because GET is exempt. Every tenant
 * workspace read perfectly and could not save anything.
 *
 * ⚠️ THE OTHER HALF OF THE PROPERTY IS THE REFUSALS. A fix that accepts
 *    `acme.ordence.com` by loosening the comparison to a SUBSTRING would
 *    pass every acceptance case here and would also accept
 *    `notordence.com` and `evil-ordence.com`, which is strictly worse
 *    than the bug. Both halves are asserted, deliberately, in the same
 *    file, so neither can be satisfied alone.
 *
 * Properties, not shapes: no count is pinned and no list is compared by
 * length. Every assertion is "this host may write" or "this host may not".
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  isAllowedHost,
  isSuspiciousCrossOrigin,
  resolveAllowedHosts,
  verifyCsrf,
} from "@/lib/security/csrf";
import { isHostInZone, labelUnder } from "@/lib/tenant";

/**
 * ⚠️ THE ENV IS RESTORED AROUND EVERY TEST. `resolveAllowedHosts()` reads
 *    `process.env` on every call — that is the whole point of
 *    `readRuntimeEnv()` — so a leaked variable changes the answer for a
 *    later test in a way that looks like a real behaviour change.
 */
const KEYS = [
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_ZONE_DOMAIN",
  "PLATFORM_HOST",
  "ORDENCE_PLATFORM_HOST",
  "APP_HOST",
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const key of KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.NEXT_PUBLIC_APP_URL = "https://app.ordence.com";
  process.env.NEXT_PUBLIC_ZONE_DOMAIN = "ordence.com";
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

/** A plain JSON POST — no server-action digest is expected of it. */
function post(origin: string | null, extra: Partial<Parameters<typeof verifyCsrf>[0]> = {}) {
  return verifyCsrf({
    method: "POST",
    origin,
    referer: null,
    requestHost: "acme.ordence.com",
    contentType: "application/json",
    serverActionHeader: null,
    expectActionDigest: true,
    ...extra,
  });
}

describe("🔴 a write from a tenant subdomain is accepted", () => {
  it("accepts a POST from acme.ordence.com — the case the product sells", () => {
    expect(post("https://acme.ordence.com")).toMatchObject({ ok: true });
  });

  it("accepts the staff console host", () => {
    expect(post("https://admin.ordence.com")).toMatchObject({ ok: true });
  });

  it("accepts the app host", () => {
    expect(post("https://app.ordence.com")).toMatchObject({ ok: true });
  });

  it("accepts the zone apex itself", () => {
    expect(post("https://ordence.com")).toMatchObject({ ok: true });
  });

  it("accepts a tenant subdomain nobody has configured a variable for", () => {
    // The point of deriving from the zone: a workspace created one second
    // ago is same-site without a deploy.
    expect(post("https://a-brand-new-customer.ordence.com")).toMatchObject({ ok: true });
  });
});

describe("🔴 the suffix is matched on a label boundary, never as a substring", () => {
  it("refuses notordence.com", () => {
    expect(post("https://notordence.com")).toMatchObject({
      ok: false,
      reason: "origin_mismatch",
    });
  });

  it("refuses evil-ordence.com", () => {
    expect(post("https://evil-ordence.com")).toMatchObject({
      ok: false,
      reason: "origin_mismatch",
    });
  });

  it("refuses ordence.com.evil.net — our zone as a PREFIX of theirs", () => {
    expect(post("https://ordence.com.evil.net")).toMatchObject({
      ok: false,
      reason: "origin_mismatch",
    });
  });

  it("refuses an unrelated site", () => {
    expect(post("https://evil.example")).toMatchObject({
      ok: false,
      reason: "origin_mismatch",
    });
  });
});

describe("⚠️ depth — one label only, and that is a decision", () => {
  /*
   * Tenant slugs are a single DNS label by construction: `lib/slug.ts`
   * bans dots because the wildcard certificate covers exactly one label.
   * So nothing we serve is ever deeper, and refusing deeper names costs
   * nothing and closes a name we do not control the issuance of.
   */
  it("refuses a.b.ordence.com", () => {
    expect(post("https://a.b.ordence.com")).toMatchObject({
      ok: false,
      reason: "origin_mismatch",
    });
  });

  it("labelUnder agrees — a two-label name is not one label", () => {
    expect(labelUnder("acme.ordence.com", "ordence.com")).toBe("acme");
    expect(labelUnder("a.b.ordence.com", "ordence.com")).toBeNull();
    expect(labelUnder("notordence.com", "ordence.com")).toBeNull();
  });
});

describe("behaviour that must NOT have changed", () => {
  it("a POST with no Origin and no Referer is still accepted", () => {
    expect(post(null)).toMatchObject({ ok: true });
  });

  it("a POST with no Origin and a foreign Referer is still refused", () => {
    expect(post(null, { referer: "https://evil.example/page" })).toMatchObject({
      ok: false,
      reason: "origin_mismatch",
    });
  });

  it("a POST with no Origin and an in-zone Referer is accepted", () => {
    expect(post(null, { referer: "https://acme.ordence.com/invoices" })).toMatchObject({
      ok: true,
    });
  });

  it("GET is never refused, whatever the Origin", () => {
    expect(post("https://evil.example", { method: "GET" })).toMatchObject({ ok: true });
  });

  it("the server-action digest rule is untouched", () => {
    expect(
      post("https://acme.ordence.com", {
        contentType: "application/x-www-form-urlencoded",
      }),
    ).toMatchObject({ ok: false, reason: "missing_action_digest" });
  });

  it("with NO zone configured, only the explicit hosts are allowed", () => {
    // The zone is what widens the set. Without it the old, narrow
    // behaviour must remain exactly as it was — an unset variable may
    // never change how an existing deployment behaves.
    delete process.env.NEXT_PUBLIC_ZONE_DOMAIN;
    expect(post("https://app.ordence.com")).toMatchObject({ ok: true });
    expect(post("https://acme.ordence.com")).toMatchObject({
      ok: false,
      reason: "origin_mismatch",
    });
  });

  it("🔴 with NOTHING configured it degrades to SAME-SITE, not to accept-anything", () => {
    // ══════════════════════════════════════════════════════════════════
    // ⚠️ THIS TEST ASSERTED THE OPPOSITE, AND IT WAS PINNING A HOLE.
    // ══════════════════════════════════════════════════════════════════
    // It read:
    //
    //     expect(post("https://anything.example")).toMatchObject({ ok: true });
    //
    // and it was written in good faith, to protect a real concern that
    // still stands: failing CLOSED on a missing variable turns one absent
    // env var into a product-wide 403 on the first deploy.
    //
    // But `isAllowedHost` did not do what its own comment claimed. The
    // comment said the unconfigured case "degrades to same-site only";
    // the code was `if (allowed.includes("")) return true;`, which never
    // compared anything with the request host. So with
    // NEXT_PUBLIC_APP_URL, PLATFORM_HOST and APP_HOST all unset, a POST
    // from evil.example was accepted , AND `isSuspiciousCrossOrigin`
    // returned false, so the control and the telemetry that would have
    // shown it missing disappeared together.
    //
    // ⭐ The fix does what the comment said. Same-site is still not a 403
    // for the legitimate deployment , the request's own host is always
    // accepted , and it is a strictly smaller hole than "any site".
    for (const key of KEYS) delete process.env[key];

    // The request's own host still works, so an unconfigured deployment
    // is not bricked. This is the property the old test was protecting.
    expect(post("https://acme.ordence.com")).toMatchObject({ ok: true });

    // And a third-party origin no longer is.
    expect(post("https://anything.example")).toMatchObject({
      ok: false,
      reason: "origin_mismatch",
    });
  });

  it("⚠️ and the telemetry sees it too, so the two cannot disagree", async () => {
    // `isSuspiciousCrossOrigin` shares the same predicate. Before the fix
    // both said "fine" in the unconfigured case, which is the worst
    // combination: no refusal and no signal that anything was skipped.
    for (const key of KEYS) delete process.env[key];
    const { isSuspiciousCrossOrigin } = await import("@/lib/security/csrf");
    expect(
      isSuspiciousCrossOrigin({
        origin: "https://evil.example",
        referer: null,
        requestHost: "acme.ordence.com",
        method: "POST",
      }),
    ).toBe(true);
  });
});

describe("🔴 PLATFORM_HOST and ORDENCE_PLATFORM_HOST are one concept", () => {
  it("the documented name is honoured", () => {
    delete process.env.NEXT_PUBLIC_ZONE_DOMAIN;
    process.env.PLATFORM_HOST = "console.example.net";
    expect(resolveAllowedHosts()).toContain("console.example.net");
    expect(post("https://console.example.net")).toMatchObject({ ok: true });
  });

  it("the legacy name is still honoured, so the live deployment survives the deploy", () => {
    delete process.env.NEXT_PUBLIC_ZONE_DOMAIN;
    process.env.ORDENCE_PLATFORM_HOST = "console.example.net";
    expect(resolveAllowedHosts()).toContain("console.example.net");
    expect(post("https://console.example.net")).toMatchObject({ ok: true });
  });

  it("the documented name wins when both are set", () => {
    delete process.env.NEXT_PUBLIC_ZONE_DOMAIN;
    process.env.PLATFORM_HOST = "documented.example.net";
    process.env.ORDENCE_PLATFORM_HOST = "legacy.example.net";
    expect(post("https://documented.example.net")).toMatchObject({ ok: true });
    expect(post("https://legacy.example.net")).toMatchObject({
      ok: false,
      reason: "origin_mismatch",
    });
  });

  it("falls back to admin.<zone>, which is what middleware.ts also derives", () => {
    expect(resolveAllowedHosts()).toContain("admin.ordence.com");
  });
});

describe("isSuspiciousCrossOrigin agrees with verifyCsrf", () => {
  const args = (origin: string) => ({
    method: "POST",
    origin,
    referer: null,
    requestHost: "acme.ordence.com",
  });

  it("does not flag a tenant subdomain", () => {
    expect(isSuspiciousCrossOrigin(args("https://acme.ordence.com"))).toBe(false);
  });

  it("flags a look-alike zone", () => {
    expect(isSuspiciousCrossOrigin(args("https://notordence.com"))).toBe(true);
  });
});

describe("isHostInZone — the shared predicate", () => {
  it("is the same rule the tenant router uses, and it holds on ports", () => {
    // Development runs the whole zone on a port; cookies are not
    // port-scoped, so the comparison must not be either.
    expect(isHostInZone("acme.localhost:3000", "localhost:3000")).toBe(true);
    expect(isHostInZone("localhost:3000", "localhost:3000")).toBe(true);
    expect(isHostInZone("acme.notlocalhost:3000", "localhost:3000")).toBe(false);
  });

  it("is false when there is no zone at all", () => {
    expect(isHostInZone("acme.ordence.com", undefined)).toBe(false);
    expect(isHostInZone("acme.ordence.com", "")).toBe(false);
  });

  it("isAllowedHost is false for a nullish host", () => {
    expect(isAllowedHost(null)).toBe(false);
    expect(isAllowedHost("")).toBe(false);
  });
});
