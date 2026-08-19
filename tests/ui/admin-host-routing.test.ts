import { describe, it, expect } from "vitest";
import { resolveTenantFromHost } from "@/lib/tenant";

const OPTS = { zoneDomain: "ordence.com", platformHost: "admin.ordence.com" };

describe("admin.ordence.com routing", () => {
  it("classifies the console host as platform", () => {
    expect(resolveTenantFromHost("admin.ordence.com", "app.ordence.com", OPTS))
      .toEqual({ kind: "platform" });
  });
  it("still classifies a tenant subdomain correctly", () => {
    expect(resolveTenantFromHost("acme.ordence.com", "app.ordence.com", OPTS))
      .toEqual({ kind: "subdomain", slug: "acme" });
  });
  it("⚠️ WITHOUT the zone/platform settings, admin. becomes a TENANT called 'admin'", () => {
    // This is what a deployment that predates those two variables does.
    const r = resolveTenantFromHost("admin.ordence.com", "app.ordence.com", {});
    expect(r).not.toEqual({ kind: "platform" });
    console.log("      → resolves as:", JSON.stringify(r));
  });
  it("handles a port and uppercase", () => {
    expect(resolveTenantFromHost("ADMIN.ordence.com:443", "app.ordence.com", OPTS))
      .toEqual({ kind: "platform" });
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE RELEASED-HOSTNAME BRANCH CANNOT REACH THE CONSOLE OR THE APP
 * ══════════════════════════════════════════════════════════════════════
 * v1.57.0-alpha added a middleware branch that rewrites a request to
 * `app/api/internal/host-moved/route.ts`, which answers 301 when the
 * host's label is a slug some workspace released within the last 365
 * days. That branch is written `if (locator.kind === "subdomain" && ...)`
 * and nothing else — so the ONLY question that matters for `admin.` and
 * `app.` is whether either can ever classify as `subdomain`.
 *
 * ⚠️ THIS IS PROOF, NOT REASSURANCE. `resolveTenantFromHost` was not
 *    modified by that batch — no branch added, no branch reordered — so
 *    these assertions describe the same function as before and would fail
 *    the moment somebody moves the platform-host check below the
 *    subdomain branches, which is the one edit that would let the console
 *    host be treated as a workspace.
 */
describe("the released-slug redirect can never fire on admin. or app.", () => {
  const hosts = [
    "admin.ordence.com",
    "app.ordence.com",
    "www.app.ordence.com",
    "ordence.com",
    "ordence.some-account.workers.dev",
    "ordence-preview.vercel.app",
  ];

  for (const host of hosts) {
    it(`${host} does not classify as a tenant subdomain`, () => {
      const r = resolveTenantFromHost(host, "app.ordence.com", OPTS);
      expect(r.kind).not.toBe("subdomain");
    });
  }

  it("admin. is platform and app. is root — the two classifications the branch skips", () => {
    expect(resolveTenantFromHost("admin.ordence.com", "app.ordence.com", OPTS).kind).toBe(
      "platform",
    );
    expect(resolveTenantFromHost("app.ordence.com", "app.ordence.com", OPTS).kind).toBe("root");
  });

  it("⚠️ and both labels are reserved anyway — two independent defences", async () => {
    const { RESERVED_SLUGS } = await import("@/lib/slug");
    expect(RESERVED_SLUGS.has("admin")).toBe(true);
    expect(RESERVED_SLUGS.has("app")).toBe(true);
  });

  it("a released label is still shape-valid, which is why the edge cannot decide", async () => {
    const { isValidSlug } = await import("@/lib/slug");
    // `acme` may have been released yesterday; nothing about the STRING
    // says so. That is the whole reason the lookup lives in the app layer
    // rather than in `resolveTenantFromHost`.
    expect(isValidSlug("acme")).toBe(true);
    expect(resolveTenantFromHost("acme.ordence.com", "app.ordence.com", OPTS)).toEqual({
      kind: "subdomain",
      slug: "acme",
    });
  });
});
