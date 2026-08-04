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
