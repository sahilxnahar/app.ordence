/**
 * Ordence — ⭐⭐⭐ THE SELF-SERVE FUNNEL ACTUALLY CLAIMS SOMETHING
 * Version: v1.65.0-alpha (Brief A)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE DEFECT THIS FILE PINS
 * ══════════════════════════════════════════════════════════════════════
 * The product sells "your own subdomain" and could not deliver one.
 * `app/(marketing)/claim/page.tsx` was an explicit placeholder that said
 * so on screen — "Continue is not wired to anything yet" — and the only
 * path that created a workspace was Clerk's `<CreateOrganization>`, which
 * never asks for an address. `server/platform/claim-slug.ts`,
 * `lib/slug.ts`'s `suggestSlugs` / `rejectionFromPgError`, and
 * `components/signup/claim-subdomain.tsx` were all built, all correct, and
 * reachable from nothing on the path a customer walks.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE PRINCIPLE THESE TESTS MUST NOT ACCIDENTALLY BREAK
 * ══════════════════════════════════════════════════════════════════════
 *      The availability check is advisory.
 *      The unique index is the truth.
 *      The insert is the claim.
 *
 * So nothing here asserts that the action claims a slug — it does not, and
 * must not. `app/api/webhooks/clerk/_webhook.ts` remains the sole writer.
 * What is asserted is that the address the customer chose is carried INTO
 * the Clerk organisation, which is the value that webhook reads and the
 * value `middleware.ts:1031` compares the hostname against.
 *
 * ⚠️ PROPERTIES, NEVER SHAPES. No count, id, suffix or total is pinned.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/* ------------------------------------------------------------------ */
/* THE SEAMS                                                           */
/* ------------------------------------------------------------------ */

const session = vi.hoisted(() => ({
  userId: "user_test" as string | null,
  orgId: null as string | null,
}));

const clerkWorld = vi.hoisted(() => ({
  created: [] as Array<{ name: string; slug?: string; createdBy?: string }>,
  /** Set to make creation refuse the way Clerk refuses a duplicate slug. */
  refuseWith: null as unknown,
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: session.userId, orgId: session.orgId }),
  clerkClient: async () => ({
    organizations: {
      async createOrganization(params: {
        name: string;
        slug?: string;
        createdBy?: string;
      }) {
        if (clerkWorld.refuseWith) throw clerkWorld.refuseWith;
        clerkWorld.created.push(params);
        return { id: `org_${clerkWorld.created.length}`, slug: params.slug ?? null };
      },
    },
  }),
}));

const tenantRow = vi.hoisted(() => ({ slug: null as string | null }));

vi.mock("@/db", () => ({
  db: {},
  withPlatformScope: async (
    _reason: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cb: (tx: any) => Promise<unknown>,
  ) =>
    cb({
      query: {
        tenants: {
          findFirst: async () =>
            tenantRow.slug === null ? undefined : { slug: tenantRow.slug },
        },
      },
    }),
}));

const limiter = vi.hoisted(() => ({ allowed: true }));

vi.mock("@/lib/security/rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: limiter.allowed }),
}));

/**
 * ⚠️ MOCKED SO THIS FILE TESTS THE CLAIM PATH, NOT THE AVAILABILITY
 *    ENDPOINT. `verifiedSuggestions` has its own coverage and needs a
 *    database-shaped handle; what matters here is that the refusal
 *    carries suggestions at all, because `ClaimRejection.suggestions` is
 *    rendered as clickable alternatives.
 */
vi.mock("@/app/api/public/slug-available/_availability", () => ({
  verifiedSuggestions: async (_tx: unknown, raw: string) => [`${raw}-india`],
}));

import {
  claimWorkspaceAddress,
  workspaceProvisioningStatus,
} from "@/server/actions/claim";
import { SLUG_REJECTIONS } from "@/lib/slug";

beforeEach(() => {
  session.userId = "user_test";
  session.orgId = null;
  clerkWorld.created.length = 0;
  clerkWorld.refuseWith = null;
  tenantRow.slug = null;
  limiter.allowed = true;
  process.env.NEXT_PUBLIC_ZONE_DOMAIN = "ordence.com";
  process.env.NEXT_PUBLIC_ROOT_DOMAIN = "app.ordence.com";
});

/* ================================================================== */
/* 1. ⭐⭐⭐ THE ADDRESS REACHES THE ORGANISATION                       */
/* ================================================================== */

describe("🔴 the address the customer typed becomes the organisation's slug", () => {
  it("⭐⭐⭐ creating a workspace carries the chosen address into Clerk", async () => {
    const result = await claimWorkspaceAddress({ slug: "harbour-works" });

    expect(result.ok, "the funnel must actually create something").toBe(true);
    expect(clerkWorld.created).toHaveLength(1);
    /*
     * 🔴 THIS IS THE WHOLE MECHANISM. `organizationUpsert()` reads
     *    `org.slug` and asks the database for it, and `middleware.ts:1031`
     *    compares the hostname label against the same value on every
     *    request. An organisation created without it is a workspace whose
     *    address was derived from a company name the customer never chose.
     */
    expect(clerkWorld.created[0].slug).toBe("harbour-works");
  });

  it("🔴 the creator is made a member — otherwise they cannot select it", async () => {
    await claimWorkspaceAddress({ slug: "harbour-works" });
    expect(clerkWorld.created[0].createdBy).toBe("user_test");
  });

  it("⚠️ the address is normalised before it is used, not trusted as typed", async () => {
    await claimWorkspaceAddress({ slug: "  HARBOUR-Works  " });
    expect(clerkWorld.created[0].slug).toBe("harbour-works");
  });

  it("⚠️ a company name is carried through; the address is the fallback name", async () => {
    await claimWorkspaceAddress({ slug: "harbour-works", companyName: "Harbour Works Pvt Ltd" });
    expect(clerkWorld.created[0].name).toBe("Harbour Works Pvt Ltd");

    clerkWorld.created.length = 0;
    await claimWorkspaceAddress({ slug: "second-name" });
    expect(clerkWorld.created[0].name).toBe("second-name");
  });
});

/* ================================================================== */
/* 2. 🔴 THE GUARDS                                                    */
/* ================================================================== */

describe("🔴 the endpoint asks who is calling before it does anything", () => {
  it("refuses with no session, and creates nothing", async () => {
    session.userId = null;
    const result = await claimWorkspaceAddress({ slug: "harbour-works" });
    expect(result.ok).toBe(false);
    expect(clerkWorld.created).toHaveLength(0);
  });

  it("🔴 refuses a session that ALREADY has a workspace", async () => {
    /** A back button, a stale tab or a double submit would otherwise mint a
     *  second workspace with a second trial and a second public hostname,
     *  and nothing in this product merges them. */
    session.orgId = "org_existing";
    const result = await claimWorkspaceAddress({ slug: "harbour-works" });
    expect(result.ok).toBe(false);
    expect(clerkWorld.created).toHaveLength(0);
  });

  it("⚠️ refuses when the rate limit is spent, and creates nothing", async () => {
    limiter.allowed = false;
    const result = await claimWorkspaceAddress({ slug: "harbour-works" });
    expect(result.ok).toBe(false);
    expect(clerkWorld.created).toHaveLength(0);
  });
});

/* ================================================================== */
/* 3. 🔴 REFUSALS SAY THE RIGHT THING TO THE RIGHT AUDIENCE            */
/* ================================================================== */

describe("🔴 a refusal never leaks another workspace's name", () => {
  it("⭐ a reserved address is refused with the PUBLIC message", async () => {
    const result = await claimWorkspaceAddress({ slug: "admin" });

    expect(result.ok).toBe(false);
    if (result.ok || result.kind !== "rejected") throw new Error("expected a rejection");

    expect(result.rejection.code).toBe("reserved");
    expect(result.rejection.message).toBe(SLUG_REJECTIONS.reserved.publicMessage);
    /*
     * 🔴 THE OPERATOR STRING NAMES CONSTRAINTS AND MAY NAME A CONFLICTING
     *    WORKSPACE. On a public signup form that is a lookup tool for
     *    which near-miss names are taken — reconnaissance for exactly the
     *    phishing the confusable fold exists to prevent.
     */
    expect(result.rejection.message).not.toBe(SLUG_REJECTIONS.reserved.operatorMessage);
    expect(clerkWorld.created).toHaveLength(0);
  });

  it("⭐ the refusal carries the slug it is ABOUT", async () => {
    /** Without it the banner keeps accusing whatever is in the box —
     *  including a different name typed afterwards that the server has
     *  never seen and which may well be free. */
    const result = await claimWorkspaceAddress({ slug: "gst" });
    if (result.ok || result.kind !== "rejected") throw new Error("expected a rejection");
    expect(result.rejection.slug).toBe("gst");
  });

  it("⭐ a refusal offers alternatives that were checked, not merely generated", async () => {
    const result = await claimWorkspaceAddress({ slug: "admin" });
    if (result.ok || result.kind !== "rejected") throw new Error("expected a rejection");
    expect(result.rejection.suggestions?.length ?? 0).toBeGreaterThan(0);
  });

  it("🔴 a shape refusal happens SERVER-SIDE — the browser's copy is not the guard", async () => {
    /** The same `checkSlugShape` runs in the browser. The browser is also
     *  where anybody can call this action directly with whatever they like. */
    for (const bad of ["", "ab", "-acme", "acme-", "ACME.corp", "a".repeat(70)]) {
      const result = await claimWorkspaceAddress({ slug: bad });
      expect(result.ok, `"${bad}" must be refused`).toBe(false);
    }
    expect(clerkWorld.created).toHaveLength(0);
  });
});

/* ================================================================== */
/* 4. ⚠️ CLERK'S OWN REFUSALS ARE CLASSIFIED, NOT GUESSED AT           */
/* ================================================================== */

describe("⚠️ a Clerk failure is only called 'taken' when it is about the slug", () => {
  it("⭐ an objection to the slug parameter becomes an honest 'taken'", async () => {
    clerkWorld.refuseWith = Object.assign(new Error("refused"), {
      errors: [{ code: "duplicate_record", meta: { paramName: "slug" } }],
    });

    const result = await claimWorkspaceAddress({ slug: "harbour-works" });
    if (result.ok || result.kind !== "rejected") throw new Error("expected a rejection");
    expect(result.rejection.code).toBe("taken");
    expect(result.rejection.slug).toBe("harbour-works");
  });

  it("🔴 any OTHER Clerk failure is not reported as a taken address", async () => {
    /** Telling somebody "that address is taken" when organisations are
     *  disabled, or Clerk is down, sends them to pick another name that
     *  will also fail — and they will keep going until they leave. */
    clerkWorld.refuseWith = new Error("Clerk is unreachable");

    const result = await claimWorkspaceAddress({ slug: "harbour-works" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.kind).toBe("failed");
  });

  it("⚠️ a wrapped error is still recognised — SDKs wrap", async () => {
    clerkWorld.refuseWith = Object.assign(new Error("outer"), {
      cause: Object.assign(new Error("inner"), {
        errors: [{ code: "form_identifier_exists", meta: { paramName: "slug" } }],
      }),
    });

    const result = await claimWorkspaceAddress({ slug: "harbour-works" });
    if (result.ok || result.kind !== "rejected") throw new Error("expected a rejection");
    expect(result.rejection.code).toBe("taken");
  });
});

/* ================================================================== */
/* 5. ⭐ THE WAIT — THE WRITE IS SOMEBODY ELSE'S DELIVERY               */
/* ================================================================== */

describe("⭐ the status poll reports the GRANTED address, not the requested one", () => {
  it("says 'pending' while the webhook has not landed", async () => {
    session.orgId = "org_waiting";
    tenantRow.slug = null;
    const status = await workspaceProvisioningStatus();
    expect(status.ready).toBe(false);
  });

  it("⭐⭐ reports the address the DATABASE granted, which may not be the one asked for", async () => {
    /** If the fallback ladder walked, `tenants.slug` is the only value
     *  that will route. Redirecting to the requested one lands the
     *  customer on a hostname that is not theirs. */
    session.orgId = "org_waiting";
    tenantRow.slug = "support-india";

    const status = await workspaceProvisioningStatus();
    expect(status.ready).toBe(true);
    if (!status.ready) throw new Error("unreachable");
    expect(status.slug).toBe("support-india");
    expect(status.workspaceUrl).toContain("support-india.ordence.com");
  });

  it("🔴 the URL is built on the SERVER, where the zone is readable at runtime", async () => {
    /** Next.js inlines every literal `process.env.NEXT_PUBLIC_*` at BUILD
     *  time and the Railway build machine has no application variables, so
     *  a browser computing this host computes `https://acme.undefined/`. */
    session.orgId = "org_waiting";
    tenantRow.slug = "harbour";
    const status = await workspaceProvisioningStatus();
    if (!status.ready) throw new Error("unreachable");
    expect(status.workspaceUrl).not.toContain("undefined");
    expect(status.workspaceUrl.startsWith("https://")).toBe(true);
  });

  it("⚠️ takes no arguments — there is nothing to point it at", async () => {
    /** An `orgId` parameter would let any signed-in person read the
     *  address of any organisation whose id they can guess. */
    expect(workspaceProvisioningStatus.length).toBe(0);
  });

  it("refuses to answer for a session with no organisation", async () => {
    session.orgId = null;
    const status = await workspaceProvisioningStatus();
    expect(status.ready).toBe(false);
  });
});

/* ================================================================== */
/* 6. 🔴 THE WIRING — THE PARTS THAT ARE EASY TO LEAVE UNCONNECTED     */
/* ================================================================== */

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("🔴 the funnel is reachable, and the placeholder is gone", () => {
  it("⭐⭐ the claim page no longer says Continue is not wired to anything", () => {
    const page = read("app/(marketing)/claim/page.tsx");
    expect(page).not.toContain("Continue is not wired to anything yet");
    expect(page).not.toContain("Placeholder screen");
  });

  it("🔴 the page is still a SERVER component and delegates the hooks", () => {
    /** A server component may not call a client hook, and cannot pass
     *  `onContinue` either — a function prop is not serialisable across
     *  the boundary. That is WHY the button was inert. */
    const page = read("app/(marketing)/claim/page.tsx");
    /*
     * ⚠️ THE FIRST NON-EMPTY LINE, NOT `includes("use client")`. The page's
     *    own header EXPLAINS the boundary, so a substring search finds the
     *    words in a comment and concludes the opposite of the truth — the
     *    same way `check:guards` once matched `requirePermission(` in a doc
     *    comment and passed an unguarded write.
     */
    const firstLine = page.split("\n").find((l) => l.trim().length > 0) ?? "";
    expect(firstLine.trim()).not.toBe('"use client";');
    expect(page).toContain("ClaimWorkspace");

    const wrapper = read("components/signup/claim-workspace.tsx");
    expect(wrapper.split("\n")[0].trim()).toBe('"use client";');
    expect(wrapper).toContain("onContinue");
  });

  it("⭐⭐ the customer is TOLD when the address granted is not the one they typed", () => {
    /** `claimSlugWithFallback()` walks a candidate ladder, so "support"
     *  becomes "support-india". Silently redirecting somebody to a
     *  hostname they did not choose is the same "nobody was told" failure
     *  the rename notification exists for, one screen earlier. */
    const wrapper = read("components/signup/claim-workspace.tsx");
    expect(wrapper).toContain("requestedRef.current");
    /* ⭐ THE GRANTED SLUG IS COMPARED, not merely rendered. */
    expect(wrapper).toContain("requested !== status.slug");
    expect(wrapper).toContain('kind: "diverted"');
  });

  it("⭐ the client wrapper hands a refusal back through ClaimRejection", () => {
    /** The type deliberately carries the slug it is about, so the banner
     *  can never accuse a different name. */
    const wrapper = read("components/signup/claim-workspace.tsx");
    expect(wrapper).toContain("ClaimRejection");
    expect(wrapper).toContain("serverRejection");
  });

  it("🔴 middleware lets a session with NO workspace reach /claim", () => {
    /** Somebody who has just signed up has no active organisation by
     *  definition. Without this the address step is bounced to
     *  /onboarding and can never be shown at its own URL. */
    const middleware = read("middleware.ts");
    expect(middleware).toContain("NO_WORKSPACE_ROUTES");
    const idx = middleware.indexOf("NO_WORKSPACE_ROUTES");
    const window = middleware.slice(idx, idx + 200);
    expect(window).toContain('"/claim"');
    expect(window).toContain('"/onboarding"');
  });

  it("⚠️ /claim is NOT public — creating an organisation needs a person", () => {
    const middleware = read("middleware.ts");
    const publicList = middleware.slice(
      middleware.indexOf("const isPublicRoute"),
      middleware.indexOf("const isPublicRoute") + 6000,
    );
    expect(publicList).not.toContain('"/claim"');
  });

  it("⭐ sign-up sends a new account to the address step", () => {
    const signUp = read("app/(auth)/sign-up/[[...sign-up]]/page.tsx");
    expect(signUp).toContain("/claim");
  });

  it("🔴 onboarding no longer offers CreateOrganization to somebody with no org", () => {
    /** That form never asks for an address, which is how the product's
     *  central promise went undelivered. */
    const onboarding = read("app/onboarding/page.tsx");
    const noOrgBranch = onboarding.slice(onboarding.indexOf("if (!orgId)"));
    const nextReturn = noOrgBranch.slice(0, noOrgBranch.indexOf("</main>"));
    expect(nextReturn).toContain("ClaimWorkspace");
    expect(nextReturn).not.toContain("CreateOrganization");
  });
});
