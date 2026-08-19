"use server";

/**
 * Ordence — Self-serve: claiming a workspace address
 * Version: v1.65.0-alpha (Brief A)
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⭐ THE PRINCIPLE, WHICH THIS FILE OBEYS RATHER THAN RESTATES
 * ══════════════════════════════════════════════════════════════════════════
 *
 *       The availability check is advisory.
 *       The unique index is the truth.
 *       The insert is the claim.
 *
 * 🔴 SO THIS FILE DOES NOT CLAIM ANYTHING, AND THAT IS THE DESIGN.
 *    `app/api/webhooks/clerk/_webhook.ts` is the SOLE path that inserts a
 *    `tenants` row for a real signup. Adding a second writer here would
 *    give one workspace two creators racing each other, and the loser
 *    would be whichever one the customer was watching.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 🔴 THE ADDRESS IS CHOSEN **BEFORE** THE CLERK ORGANISATION EXISTS, AND
 *    THE REASON IS NOT PREFERENCE
 * ══════════════════════════════════════════════════════════════════════════
 * The brief asks which side of the organisation the address is chosen on.
 * Both are buildable. Only one survives contact with a Svix-delivered
 * webhook that is the sole writer.
 *
 *   AFTER — the customer creates the organisation, the webhook provisions a
 *           workspace on a slug DERIVED FROM THE COMPANY NAME, and only then
 *           are they asked what address they want. Their answer is now a
 *           RENAME of a workspace that is thirty seconds old:
 *             • it closes a `tenant_slug_history` tenure and opens another,
 *               spending 365 days of 0091's retention on an address nobody
 *               ever used,
 *             • it races the webhook, which may not have inserted the row
 *               yet, so the rename has nothing to rename, and
 *             • the Clerk organisation slug and `tenants.slug` disagree
 *               until something reconciles them, which is the lockout
 *               described in `server/platform/clerk-org-slug.ts`.
 *
 *   BEFORE — the address is the organisation's slug at the moment it is
 *            created. `organizationProvision()` reads `org.slug` and asks
 *            the database for exactly the name the customer typed. Nothing
 *            is renamed, no retention is spent, there is no race because
 *            there is only one write, and the two systems agree from the
 *            first instant.
 *
 * ⭐ CHOSEN: BEFORE. The organisation is created carrying the address.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT THIS FILE IS NOT ALLOWED TO CONCLUDE
 * ══════════════════════════════════════════════════════════════════════════
 * It never tells the customer their address is theirs. `checkSlugShape()`
 * runs here because the browser's copy of it can be edited from a console,
 * not because it decides anything the database has not. The database may
 * still refuse the name inside the webhook's transaction, in which case
 * `claimSlugWithFallback()` grants a different one and
 * `syncClerkOrganizationSlug()` makes Clerk agree — so the customer lands in
 * a working workspace on an address they did not pick, with
 * `settings.clerkSlug` recording why. That is a worse outcome than getting
 * the name and a far better one than the "your workspace is not ready yet"
 * card that has no exit.
 */

import { auth, clerkClient } from "@clerk/nextjs/server";
import { and, eq, isNull } from "drizzle-orm";

import { withPlatformScope } from "@/db";
import { tenants } from "@/db/schema";
import { checkSlugShape, type SlugRejectionCode } from "@/lib/slug";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { tenantUrl } from "@/lib/tenant";
import { readRuntimeEnv } from "@/lib/env";
import { verifiedSuggestions } from "@/app/api/public/slug-available/_availability";
import { clerkErrorMentionsSlug } from "@/server/platform/clerk-org-slug";

/* ------------------------------------------------------------------ */
/* THE WIRE SHAPES                                                     */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ STRUCTURALLY IDENTICAL TO `ClaimRejection` IN
 *    `components/signup/claim-subdomain.tsx`, AND DELIBERATELY NOT
 *    IMPORTED FROM IT. That module is `"use client"`; a server module
 *    importing from it — even for a type — is what
 *    `scripts/check-server-boundaries.mjs` exists to catch.
 *
 * ⭐ THE AGREEMENT IS STILL CHECKED BY THE COMPILER, not by discipline.
 *    `components/signup/claim-workspace.tsx` assigns this value to a
 *    `ClaimRejection`, so if either shape moves the assignment stops
 *    compiling. A comment saying "keep these in sync" would not.
 *
 * 🔴 `message` IS ALWAYS `publicMessage`. The operator string may name the
 *    workspace that collided, and naming it on a public signup form turns
 *    the form into a lookup tool for near-miss names — reconnaissance for
 *    exactly the phishing the confusable fold exists to prevent.
 */
type PublicRejection = {
  /**
   * ⭐ THE SLUG THE SERVER ACTUALLY REFUSED. Required, so the banner can
   *    never accuse a different name than the one it is about.
   */
  slug: string;
  code: SlugRejectionCode;
  message: string;
  suggestions?: string[];
};

export type ClaimAddressResult =
  | { ok: true; organizationId: string; slug: string }
  | { ok: false; kind: "rejected"; rejection: PublicRejection }
  /** Not a slug problem. Nothing was created and retrying may work. */
  | { ok: false; kind: "failed"; error: string };

export type ProvisioningStatus =
  /**
   * The workspace exists. `slug` is the address it actually holds, and
   * `workspaceUrl` is where the browser should go next.
   *
   * ⭐ THE URL IS BUILT HERE, ON THE SERVER, AND NOT IN THE BROWSER, AND
   *    THAT IS NOT TIDINESS. The zone lives in `NEXT_PUBLIC_ZONE_DOMAIN`,
   *    and Next.js replaces every literal `process.env.NEXT_PUBLIC_*` at
   *    BUILD time. The Railway build machine has no application variables,
   *    so a client component computing the host would compute
   *    `https://acme.undefined/` — the exact failure `readRuntimeEnv()`
   *    exists for, and one that only appears in production.
   *
   * ⚠️ IT IS ALSO BUILT WITH `tenantUrl()` rather than by concatenation, so
   *    the address the customer is sent to is assembled by the same module
   *    that decides which hostnames resolve.
   */
  | { ready: true; slug: string; workspaceUrl: string }
  /** No workspace yet — the webhook has not landed. Keep waiting. */
  | { ready: false; reason: "pending" }
  /** There is no organisation on this session to ask about. */
  | { ready: false; reason: "no_organization" };

/* ------------------------------------------------------------------ */
/* STEP 1 — CREATE THE ORGANISATION, CARRYING THE ADDRESS              */
/* ------------------------------------------------------------------ */

/**
 * Create the Clerk organisation whose slug is the address the customer
 * chose. The webhook does the rest.
 *
 * 🔴 AUTHENTICATION: A CLERK SESSION, AND NOTHING ELSE IS AVAILABLE.
 *    The caller is a person who has signed up and has no workspace, so
 *    there is no tenant to scope to and no permission table to consult —
 *    `requireTenantContext()` would refuse every legitimate caller. The
 *    guard is `userId`, checked here, first, before anything else runs.
 *    `scripts/check-action-guards.mjs` carries an allowlist entry saying
 *    exactly this.
 */
export async function claimWorkspaceAddress(input: {
  slug: string;
  companyName?: string;
}): Promise<ClaimAddressResult> {
  const { userId, orgId } = await auth();

  if (!userId) {
    return { ok: false, kind: "failed", error: "Sign in first." };
  }

  /*
   * ⚠️ ONE WORKSPACE PER SESSION, REFUSED HERE RATHER THAN CREATED AND
   *    REGRETTED. A session that already has an active organisation
   *    reaching this action means the funnel was re-entered — a back
   *    button, a stale tab, a double submit that beat the redirect. Every
   *    one of those creates a SECOND workspace with a second trial and a
   *    second public hostname, and nothing in the product merges them.
   */
  if (orgId) {
    return {
      ok: false,
      kind: "failed",
      error: "You already have a workspace. Open it from the workspace switcher.",
    };
  }

  /*
   * ⚠️ KEYED ON THE CLERK USER, NOT ON AN IP. There is no tenant to key on
   *    and the caller is authenticated, so the identity is the honest
   *    bucket: it survives a phone changing networks mid-signup, and it
   *    stops one account minting organisations in a loop. The `auth`
   *    policy enforces even when Redis is degraded, which is the correct
   *    trade for a write that creates a public hostname.
   */
  const limit = await checkRateLimit("auth", `claim:${userId}`);
  if (!limit.allowed) {
    return {
      ok: false,
      kind: "failed",
      error: "Too many attempts. Wait a moment and try again.",
    };
  }

  const slug = String(input?.slug ?? "").trim().toLowerCase();

  /*
   * ⭐ RE-VALIDATED SERVER-SIDE. The browser ran the same function; the
   *    browser is also where anybody can call this action directly with
   *    whatever they like. This is the identical `checkSlugShape()` the
   *    form, the resolver and the availability endpoint use — one answer,
   *    not a second reading of the same rules.
   */
  const shape = checkSlugShape(slug);
  if (shape) {
    return {
      ok: false,
      kind: "rejected",
      rejection: {
        slug,
        code: shape.code,
        message: shape.publicMessage,
        suggestions: await suggestionsFor(slug),
      },
    };
  }

  const name = displayName(input?.companyName, slug);

  try {
    const client = await clerkClient();
    const organization = await client.organizations.createOrganization({
      name,
      /*
       * 🔴 THE ADDRESS GOES IN AS THE ORGANISATION'S SLUG. This is the
       *    entire mechanism: `organizationUpsert()` reads `org.slug` and
       *    asks the database for it, and `middleware.ts:1031` compares the
       *    hostname label against this same value on every request.
       */
      slug,
      /*
       * ⚠️ WITHOUT THIS THE CREATOR IS NOT A MEMBER. Clerk's backend API
       *    creates an ownerless organisation when `createdBy` is omitted,
       *    and the customer would then be unable to select the workspace
       *    they just made.
       */
      createdBy: userId,
    });

    return { ok: true, organizationId: organization.id, slug };
  } catch (error) {
    /*
     * ⚠️ CLASSIFIED BY WHICH PARAMETER CLERK OBJECTED TO, NOT BY MESSAGE
     *    TEXT AND NOT BY GUESSING AT ITS ERROR CODES. If the objection is
     *    to `slug`, the honest sentence is that the address is unavailable.
     *    If it is to anything else — organisations disabled, a limit
     *    reached, Clerk down — saying "that address is taken" would be a
     *    lie the customer acts on by picking a different name that also
     *    fails.
     */
    if (clerkErrorMentionsSlug(error)) {
      return {
        ok: false,
        kind: "rejected",
        rejection: {
          slug,
          code: "taken",
          message: "That address is already in use. Try another.",
          suggestions: await suggestionsFor(slug),
        },
      };
    }

    console.error(`[claim] createOrganization failed for user ${userId}:`, error);
    return {
      ok: false,
      kind: "failed",
      error: "We could not create your workspace just now. Please try again.",
    };
  }
}

/* ------------------------------------------------------------------ */
/* STEP 2 — HAS THE WEBHOOK LANDED?                                    */
/* ------------------------------------------------------------------ */

/**
 * Report whether the workspace behind the session's organisation exists
 * yet, and at what address.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THIS EXISTS BECAUSE THE WRITE IS SOMEBODY ELSE'S DELIVERY.
 * ══════════════════════════════════════════════════════════════════════
 * `createOrganization()` returns as soon as Clerk has the organisation.
 * The `tenants` row arrives whenever Svix delivers `organization.created`
 * — usually under a second, occasionally not. Redirecting the customer to
 * their workspace before the row exists lands them on
 * `/onboarding`'s "your workspace is not ready yet" card, which is the
 * dead end this whole funnel is built to remove.
 *
 * ⭐ IT REPORTS THE GRANTED ADDRESS, NOT THE REQUESTED ONE. If the ladder
 *    walked, `tenants.slug` is the only value that will route, so it is
 *    the only value worth redirecting to.
 *
 * 🔴 AUTHENTICATION: THE CLERK SESSION, AND THE ORGANISATION IS TAKEN
 *    FROM IT — never from a parameter. An `orgId` argument would let any
 *    signed-in person read the address of any organisation whose id they
 *    can guess, which is a cross-tenant read wearing a status check.
 */
export async function workspaceProvisioningStatus(): Promise<ProvisioningStatus> {
  const { userId, orgId } = await auth();
  if (!userId || !orgId) return { ready: false, reason: "no_organization" };

  /*
   * ⚠️ `withPlatformScope`, LIKE `app/onboarding/page.tsx`. The question is
   *    "does a workspace exist for this organisation", asked BEFORE any
   *    workspace is known — which is by definition a question no
   *    tenant-scoped handle can answer. Unscoped it returns nothing under a
   *    correct role, which would make this poll say "not ready" forever.
   */
  const row = await withPlatformScope(
    `Self-serve signup: has the workspace for organization ${orgId} been provisioned yet?`,
    (tx) =>
      tx.query.tenants.findFirst({
        where: and(eq(tenants.clerkOrgId, orgId), isNull(tenants.deletedAt)),
        columns: { slug: true },
      }),
  );

  if (!row?.slug) return { ready: false, reason: "pending" };

  return {
    ready: true,
    slug: row.slug,
    workspaceUrl: tenantUrl(
      row.slug,
      readRuntimeEnv("NEXT_PUBLIC_ROOT_DOMAIN") ?? "localhost:3000",
      "/dashboard",
      readRuntimeEnv("NEXT_PUBLIC_ZONE_DOMAIN"),
    ),
  };
}

/* ------------------------------------------------------------------ */
/* HELPERS — NOT EXPORTED. A "use server" FILE PUBLISHES EVERY EXPORT.  */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ ONE PLATFORM-SCOPED READ, AND EVERY CANDIDATE IS CHECKED AGAINST THE
 *    DATABASE BEFORE IT IS OFFERED. `verifiedSuggestions()` is the
 *    availability endpoint's own function, imported rather than copied: a
 *    suggestion that is itself taken teaches the user that this form's
 *    answers are unreliable, on the one screen where they most need to
 *    believe it.
 *
 * ⚠️ A FAILURE HERE IS NOT A FAILURE OF THE CLAIM. The refusal is already
 *    decided; suggestions are a courtesy on top of it, and losing them is
 *    not worth turning a clear "that name will not work" into a 500.
 */
async function suggestionsFor(slug: string): Promise<string[]> {
  try {
    return await withPlatformScope(
      `Self-serve signup: verify alternative addresses for a refused slug.`,
      (tx) => verifiedSuggestions(tx, slug),
    );
  } catch (error) {
    console.warn("[claim] could not verify suggestions:", error);
    return [];
  }
}

/**
 * The organisation's display name.
 *
 * ⚠️ THE SLUG IS THE FALLBACK, NOT A GENERATED PLACEHOLDER. It is what the
 *    customer typed, it is already legal, and it is the name they will see
 *    at the top of every screen until they change it. `Workspace 4f3a` is
 *    not better.
 */
function displayName(companyName: string | undefined, slug: string): string {
  const trimmed = String(companyName ?? "").trim();
  if (trimmed.length > 0) return trimmed.slice(0, 100);
  return slug;
}
