/**
 * Ordence — ⭐⭐ THE ADDRESS OF RECORD AND THE ADDRESS CLERK HOLDS
 * Version: v1.65.0-alpha (Brief A)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE FACT EVERYTHING HERE FOLLOWS FROM
 * ══════════════════════════════════════════════════════════════════════
 * `middleware.ts:1031` is the cross-tenant gate:
 *
 *     if (locator.kind === "subdomain" && orgSlug && locator.slug !== orgSlug)
 *
 * `orgSlug` comes from `await auth()` — it is CLERK'S organisation slug,
 * not `tenants.slug`. Line 1061 sets the `x-tenant-slug` header from the
 * same value. So the two strings are COMPARED, on every request, and the
 * comparison decides whether a customer may enter their own workspace.
 *
 * ⚠️ THREE PLACES COULD MAKE THEM DISAGREE AND ALL THREE DID:
 *      • a provision whose address was diverted by the fallback ladder,
 *      • a rename the database refused,
 *      • an operator rename, which never touched Clerk at all.
 *
 * The first two are pinned in `tests/ui/clerk-workspace-provisioning.test.ts`,
 * against the real webhook. This file pins the mechanism itself and the
 * third caller.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const clerk = vi.hoisted(() => ({
  orgs: new Map<string, { slug: string | null }>(),
  updates: [] as Array<{ organizationId: string; slug: string }>,
  refuseUpdateWith: null as unknown,
  clientThrows: false,
  getThrows: false,
}));

vi.mock("@clerk/nextjs/server", () => ({
  clerkClient: async () => {
    if (clerk.clientThrows) throw new Error("no CLERK_SECRET_KEY");
    return {
      organizations: {
        async getOrganization({ organizationId }: { organizationId: string }) {
          if (clerk.getThrows) throw new Error("read failed");
          const org = clerk.orgs.get(organizationId);
          if (!org) throw new Error("no such organization");
          return org;
        },
        async updateOrganization(organizationId: string, params: { slug: string }) {
          if (clerk.refuseUpdateWith) throw clerk.refuseUpdateWith;
          clerk.orgs.set(organizationId, { slug: params.slug });
          clerk.updates.push({ organizationId, slug: params.slug });
          return { id: organizationId, slug: params.slug };
        },
      },
    };
  },
}));

import {
  clerkErrorMentionsSlug,
  syncClerkOrganizationSlug,
} from "@/server/platform/clerk-org-slug";

beforeEach(() => {
  clerk.orgs.clear();
  clerk.updates.length = 0;
  clerk.refuseUpdateWith = null;
  clerk.clientThrows = false;
  clerk.getThrows = false;
});

const sync = (clerkOrgId: string, slug: string) =>
  syncClerkOrganizationSlug({ clerkOrgId, slug, reason: "test" });

describe("🔴 the mirror is made to match, and only when it has to", () => {
  it("⭐ writes the address when Clerk holds a different one", async () => {
    clerk.orgs.set("org_1", { slug: "support" });

    const result = await sync("org_1", "support-india");

    expect(result.ok).toBe(true);
    expect(clerk.orgs.get("org_1")?.slug).toBe("support-india");
  });

  it("🔴 writes NOTHING when Clerk already agrees", async () => {
    /** Svix delivers at least once and an operator can double-click. A
     *  blind update per call is a Clerk write per delivery, and every
     *  Clerk write fires another `organization.updated` — a loop with a
     *  network in it. */
    clerk.orgs.set("org_2", { slug: "harbour" });

    const result = await sync("org_2", "harbour");

    expect(result).toMatchObject({ ok: true, changed: false });
    expect(clerk.updates).toHaveLength(0);
  });

  it("⚠️ a failed READ does not skip the WRITE", async () => {
    /** The read is an optimisation; the write is the thing that matters.
     *  Treating a read failure as "probably fine" is how a workspace stays
     *  locked out because a health check blipped. */
    clerk.orgs.set("org_3", { slug: "old" });
    clerk.getThrows = true;

    const result = await sync("org_3", "new-address");

    expect(result.ok).toBe(true);
    expect(clerk.updates).toHaveLength(1);
  });

  it("🔴 refuses to write an empty address", async () => {
    const result = await sync("org_4", "   ");
    expect(result.ok).toBe(false);
    expect(clerk.updates).toHaveLength(0);
  });
});

describe("🔴 a failure says WHICH kind of failure it was", () => {
  it("⭐ Clerk objecting to the slug is 'slug_refused' — a retry cannot fix it", async () => {
    clerk.orgs.set("org_5", { slug: "old" });
    clerk.refuseUpdateWith = Object.assign(new Error("refused"), {
      errors: [{ code: "duplicate_record", meta: { paramName: "slug" } }],
    });

    const result = await sync("org_5", "taken-elsewhere");
    expect(result).toMatchObject({ ok: false, reason: "slug_refused" });
  });

  it("⭐ anything else is 'unreachable' — a retry is exactly right", async () => {
    clerk.orgs.set("org_6", { slug: "old" });
    clerk.refuseUpdateWith = new Error("gateway timeout");

    const result = await sync("org_6", "new-address");
    expect(result).toMatchObject({ ok: false, reason: "unreachable" });
  });

  it("⭐ a client that cannot even be constructed is 'unreachable'", async () => {
    clerk.clientThrows = true;
    const result = await sync("org_7", "new-address");
    expect(result).toMatchObject({ ok: false, reason: "unreachable" });
  });

  it("🔴 the distinction is drawn on meta.paramName, not on message text", async () => {
    /** A message-text match breaks the first time Clerk changes its
     *  wording or runs under another locale — the same reason
     *  `claim-slug.ts` reads SQLSTATE and never an English sentence. */
    expect(
      clerkErrorMentionsSlug({ errors: [{ meta: { paramName: "slug" } }] }),
    ).toBe(true);
    expect(
      clerkErrorMentionsSlug({ errors: [{ meta: { paramName: "name" } }] }),
    ).toBe(false);
    expect(clerkErrorMentionsSlug(new Error("the slug is taken"))).toBe(false);
  });

  it("⚠️ a WRAPPED error is still classified — SDKs wrap", async () => {
    expect(
      clerkErrorMentionsSlug({
        cause: { errors: [{ meta: { paramName: "slug" } }] },
      }),
    ).toBe(true);
  });

  it("⚠️ junk is not an error report", async () => {
    expect(clerkErrorMentionsSlug(null)).toBe(false);
    expect(clerkErrorMentionsSlug("slug")).toBe(false);
    expect(clerkErrorMentionsSlug({ errors: "slug" })).toBe(false);
  });
});

/* ================================================================== */
/* THE THIRD CALLER — THE OPERATOR RENAME                              */
/* ================================================================== */

describe("🔴 the operator rename finishes the job in Clerk", () => {
  const source = readFileSync(
    resolve(process.cwd(), "server/platform/rename-slug.ts"),
    "utf8",
  );

  it("⭐⭐ renameTenantSlug writes the new address to Clerk", () => {
    /*
     * Before this, an operator rename changed `tenants.slug` and stopped.
     * Clerk kept the old slug, so `middleware.ts:1031` refused every member
     * of that workspace at the new address, `/api/internal/host-moved`
     * found a LIVE tenant on the label and therefore did not redirect, and
     * the console reported success and printed the new URL.
     *
     * ⚠️ ASSERTED ON THE SOURCE because driving `renameTenantSlug` needs a
     *    capability check, a platform transaction and an audit sink — a
     *    fake world large enough that the test would mostly be measuring
     *    itself. What is checkable here, and what actually broke, is that
     *    the call exists on that path at all.
     */
    expect(source).toContain("syncClerkOrganizationSlug");
  });

  it("🔴 it reads clerk_org_id — the call cannot be made without it", () => {
    expect(source).toContain("clerkOrgId: tenants.clerkOrgId");
  });

  it("⭐ a failed Clerk write is put in front of the OPERATOR, not in a log", () => {
    /** They are the only person who can fix it, and until they do, the
     *  workspace is unreachable by its own staff. */
    const idx = source.indexOf("pending: [");
    expect(idx).toBeGreaterThan(-1);
    expect(source.slice(idx, idx + 1200)).toContain("mirror.ok");
  });

  it("⚠️ the Clerk call is AFTER the transaction, not inside it", () => {
    /** An external call cannot be rolled back with the transaction it sits
     *  in, and holding a database connection open across a network round
     *  trip to another vendor is its own problem. */
    const scopeEnd = source.indexOf("await recordPlatformAudit(");
    const syncAt = source.indexOf("await syncClerkOrganizationSlug(");
    expect(scopeEnd).toBeGreaterThan(-1);
    expect(syncAt).toBeGreaterThan(scopeEnd);
  });
});
