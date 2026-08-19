/**
 * Ordence — where a failed tenant resolution sends the user
 * Version: v0.67.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS TEST IS ACTUALLY DEFENDING
 * ══════════════════════════════════════════════════════════════════════
 * Two bugs, one shape.
 *
 * `/dashboard` ref 2120306202 — the layout answered "redirect" and the
 * page answered "throw", to the same question, at the same time. In the
 * App Router they render CONCURRENTLY, so neither one wins reliably; when
 * the throw won, the user got an error digest for a condition that is not
 * an error.
 *
 * The sign-out client exception — the layout sent EVERY failure to
 * `/onboarding`, including "there is no session", which the middleware
 * then bounced to `/sign-in`. Two hops on an RSC fetch, ending in HTML.
 * The client router cannot follow that.
 *
 * Both were fixed by making one decision in one place. The tests below
 * are the thing that keeps it one decision — they read the layout and the
 * helper as SOURCE and assert they still agree, because a future edit to
 * either file alone is precisely how this comes back.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/** Strip comments so prose about a rule is never mistaken for the rule. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const CRM_PAGES = [
  "app/(crm)/dashboard/page.tsx",
  "app/(crm)/dashboard/panels.tsx",
  "app/(crm)/assets/page.tsx",
  "app/(crm)/assets/new/page.tsx",
  "app/(crm)/settings/page.tsx",
  "app/(crm)/settings/team/page.tsx",
  "app/(crm)/settings/financial/page.tsx",
  "app/(crm)/accounting/page.tsx",
  "app/(crm)/contracts/[id]/page.tsx",
];

describe("a failed tenant resolution never reaches an error boundary", () => {
  it("⚠️ no page under (crm) calls requireTenantContext — that is the throw that produced digest 2120306202", () => {
    const offenders = CRM_PAGES.filter((rel) =>
      /\brequireTenantContext\b/.test(code(read(rel))),
    );

    expect(
      offenders,
      `These render inside a layout that REDIRECTS on the same condition. ` +
        `They must call requirePageContext() instead:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("every one of them calls requirePageContext instead", () => {
    for (const rel of CRM_PAGES) {
      expect(code(read(rel)), rel).toMatch(/\brequirePageContext\b/);
    }
  });

  it("requirePageContext re-throws anything that is not a TenantAccessError, so a real outage still surfaces", () => {
    const source = code(read("server/tenant-context.ts"));
    const fn = source.slice(source.indexOf("export async function requirePageContext"));

    // A bare `catch { }` that swallowed everything would hide a database
    // outage behind an onboarding screen — the failure would look like a
    // configuration problem to every customer at once.
    expect(fn).toMatch(/instanceof TenantAccessError/);
    expect(fn).toMatch(/throw err/);
  });
});

describe("the layout and the page helper agree on the destination", () => {
  /** Which paths a source file redirects to. */
  function redirectTargets(source: string): Set<string> {
    const out = new Set<string>();
    for (const m of code(source).matchAll(/redirect\(\s*([^)]*)\)/g)) {
      for (const lit of m[1].matchAll(/["'`](\/[^"'`]*)["'`]/g)) out.add(lit[1]);
    }
    return out;
  }

  const layout = redirectTargets(read("app/(crm)/layout.tsx"));
  const helper = redirectTargets(read("server/tenant-context.ts"));

  it("both send an unauthenticated caller to /sign-in — NOT /onboarding", () => {
    // /onboarding for a caller with no session is the two-hop chain: the
    // middleware bounces it straight on to /sign-in, and the App Router
    // cannot follow that on an RSC fetch. It throws at the user instead,
    // during sign-out, on their way out of the product.
    expect(layout).toContain("/sign-in");
    expect(helper).toContain("/sign-in");
  });

  it("both send a signed-in caller with no workspace to /onboarding", () => {
    expect(layout).toContain("/onboarding");
    expect(helper).toContain("/onboarding");
  });

  it("⚠️ neither one has a destination the other does not — divergence here IS the bug", () => {
    expect([...layout].sort()).toEqual([...helper].sort());
  });
});

describe("/onboarding is not a dead end for a user who already has an organisation", () => {
  const source = read("app/onboarding/page.tsx");

  it("looks up whether the workspace actually exists rather than assuming it does not", () => {
    expect(code(source)).toMatch(/tenants\.clerkOrgId/);
  });

  it("⚠️ does not re-offer CreateOrganization to someone whose org exists — submitting it creates a second broken org", () => {
    const body = code(source);
    const missingBranch = body.slice(
      body.indexOf("if (workspaceMissing)"),
      body.lastIndexOf("return ("),
    );
    expect(missingBranch).not.toMatch(/<CreateOrganization/);
  });

  it("shows the organisation id, which is the one value that makes support a single indexed lookup", () => {
    expect(code(source)).toMatch(/\{orgId\}/);
  });

  it("survives a database outage rather than becoming a digest screen — this is the only page a stuck user can reach", () => {
    const body = code(source);
    const lookup = body.slice(body.indexOf("if (orgId)"), body.indexOf("if (workspaceMissing)"));
    expect(lookup).toMatch(/try\s*\{/);
    expect(lookup).toMatch(/catch/);
  });
});
