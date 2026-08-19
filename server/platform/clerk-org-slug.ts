import "server-only";

/**
 * Ordence — Keeping Clerk's organisation slug equal to the address of record
 * Version: v1.65.0-alpha (Brief A)
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 🔴 THE FACT THAT MAKES THIS FILE NECESSARY, AND IT IS NOT OBVIOUS
 * ══════════════════════════════════════════════════════════════════════════
 * `middleware.ts` line 1031 is the cross-tenant gate:
 *
 *     if (locator.kind === "subdomain" && orgSlug && locator.slug !== orgSlug)
 *
 * `orgSlug` comes out of `await auth()`. It is CLERK'S organisation slug,
 * not `tenants.slug`. Line 1061 then sets the `x-tenant-slug` header from
 * the same value.
 *
 * ⭐ SO THE TWO STRINGS ARE NOT "RELATED". THEY ARE COMPARED, ON EVERY
 *    REQUEST, AND THE COMPARISON DECIDES WHETHER A CUSTOMER MAY ENTER
 *    THEIR OWN WORKSPACE.
 *
 * 🔴 WHAT HAPPENS WHEN THEY DISAGREE — TRACED, NOT ASSUMED:
 *
 *   1. Ordence grants `acme-india`; Clerk still holds `acme`.
 *   2. A member of that workspace opens `acme-india.ordence.com/dashboard`.
 *   3. `locator.slug` is `acme-india`, `orgSlug` is `acme`. They differ, so
 *      middleware rewrites to `/api/internal/host-moved` with
 *      `fallback=access-denied`.
 *   4. That route looks the label up. A LIVE tenant holds `acme-india` — it
 *      is their own workspace — so its live-tenant check returns
 *      `{ kind: "live" }`, which is deliberately NOT a redirect.
 *   5. The fallback runs. The customer is shown `/access-denied` on their
 *      own workspace, and every one of their colleagues sees the same.
 *
 * ⚠️ THERE ARE THREE PLACES THE TWO CAN COME APART, AND ALL THREE EXIST
 *    IN THE PRODUCT TODAY:
 *
 *   • PROVISION WITH A DIVERTED ADDRESS. `claimSlugWithFallback()` walks
 *     the candidate ladder, so a company called Support gets
 *     `support-india` while Clerk holds `support`. `settings.clerkSlug`
 *     records the divergence for support staff to read — and nothing
 *     reconciles it, so the workspace is unreachable by the people it
 *     belongs to. A field written, displayed, and enforced by nothing.
 *
 *   • A REFUSED RENAME. `tryRenameSlugForClerkOrg()` correctly keeps the
 *     existing address when the requested one is refused — at which point
 *     Clerk holds the requested name and we hold the old one.
 *
 *   • AN OPERATOR RENAME. `server/platform/rename-slug.ts` changes
 *     `tenants.slug` and never touches Clerk at all.
 *
 * ⭐ THE RULE THIS FILE INSTALLS, WHICH OUTLIVES THE THREE CASES:
 *
 *        `tenants.slug` is the ADDRESS OF RECORD.
 *        Clerk's organisation slug is a MIRROR of it.
 *        A mirror that is allowed to drift is a lockout.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THIS NEVER THROWS, AND WHY IT IS STILL NOT "BEST EFFORT"
 * ══════════════════════════════════════════════════════════════════════════
 * It returns an outcome rather than throwing, because every caller is
 * after-commit: the workspace row is already durable and unwinding is no
 * longer available. What the CALLER does with a failure is the caller's
 * decision, and the webhook's decision is to fail the delivery so Svix
 * retries — which is the right answer there and the wrong answer inside an
 * operator's rename form, where the rename genuinely did happen.
 *
 * ⚠️ IT IS ALSO NOT IDEMPOTENT BY ACCIDENT — IT IS IDEMPOTENT BY READING
 *    FIRST. Svix delivers at least once and an operator can double-click.
 *    A blind `updateOrganization` on every call would issue a Clerk write
 *    per delivery and would fire a fresh `organization.updated` webhook
 *    each time, which is a loop with a network in it. Reading first turns
 *    the second delivery into a no-op with no write and no event.
 */

import { clerkClient } from "@clerk/nextjs/server";

/*
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ THERE IS NO "ORDENCE WROTE THIS" MARKER IN `public_metadata`, AND ONE
 *    WAS WRITTEN AND THEN REMOVED BEFORE THIS SHIPPED.
 * ══════════════════════════════════════════════════════════════════════════
 * The idea was to stamp every address Ordence puts into Clerk so the
 * webhook could tell its own write echoing back from somebody editing the
 * field in Clerk's dashboard. It was deleted because nothing ever read it
 * to make a decision: the only consumer was the check deciding whether to
 * write the marker again. A field written, stored, and enforced by nothing
 * is the defect this codebase has now produced ten times, and adding an
 * eleventh to a file whose whole purpose is reconciliation would have been
 * a poor joke.
 *
 * ⭐ THE COMPARISON THAT ACTUALLY DECIDES IS `org.slug` vs `tenants.slug`,
 *    and both are already in the webhook delivery.
 */

export type ClerkSlugSyncResult =
  /** Clerk now holds `slug`. `changed` is false when it already did. */
  | { ok: true; changed: boolean }
  /**
   * Clerk would not take it. The workspace is reachable ONLY at the address
   * Clerk holds, so a caller that cannot retry must say so loudly.
   */
  | { ok: false; reason: "slug_refused" | "unreachable"; detail: string };

/**
 * Make Clerk's organisation slug equal `slug`.
 *
 * @param clerkOrgId the Clerk organisation, e.g. `org_2abc...`
 * @param slug       the address of record — `tenants.slug`, already claimed
 * @param reason     one sentence, for the log. Never shown to a customer.
 */
export async function syncClerkOrganizationSlug(params: {
  clerkOrgId: string;
  slug: string;
  reason: string;
}): Promise<ClerkSlugSyncResult> {
  const slug = params.slug.trim().toLowerCase();
  if (slug.length === 0) {
    return {
      ok: false,
      reason: "slug_refused",
      detail: "Refused to write an empty slug into Clerk.",
    };
  }

  let client: Awaited<ReturnType<typeof clerkClient>>;
  try {
    client = await clerkClient();
  } catch (error) {
    return { ok: false, reason: "unreachable", detail: messageOf(error) };
  }

  /*
   * ⭐ READ FIRST. See the header: this is what makes a redelivery free and
   *    what stops this function feeding its own webhook.
   */
  try {
    const current = await client.organizations.getOrganization({
      organizationId: params.clerkOrgId,
    });
    if (current.slug === slug) return { ok: true, changed: false };
  } catch (error) {
    /*
     * ⚠️ A FAILED READ IS NOT A REASON TO SKIP THE WRITE. The write is the
     *    thing that matters; the read is only an optimisation. Falling
     *    through costs one redundant Clerk update in the rare case the read
     *    failed and the value was already correct.
     */
    console.warn(
      `[clerk-org-slug] could not read organization ${params.clerkOrgId} before writing: ${messageOf(error)}`,
    );
  }

  try {
    await client.organizations.updateOrganization(params.clerkOrgId, { slug });
    return { ok: true, changed: true };
  } catch (error) {
    /*
     * ⚠️ CLASSIFIED BY `meta.paramName`, NOT BY MESSAGE TEXT AND NOT BY
     *    GUESSING AT CLERK'S ERROR CODE STRINGS. The codes have moved
     *    between Clerk versions; the parameter name is the stable part of
     *    the contract, and it is the only thing that distinguishes "that
     *    address is spoken for in Clerk's namespace" from "Clerk is down".
     */
    const refusedSlug = clerkErrorMentionsSlug(error);
    return {
      ok: false,
      reason: refusedSlug ? "slug_refused" : "unreachable",
      detail: messageOf(error),
    };
  }
}

/* ------------------------------------------------------------------ */
/* ERROR SHAPES                                                        */
/* ------------------------------------------------------------------ */

type ClerkApiError = {
  code?: unknown;
  message?: unknown;
  meta?: { paramName?: unknown } | null;
};

/**
 * Does this Clerk failure concern the `slug` parameter specifically?
 *
 * ⚠️ WALKS `cause` THE SAME WAY `asPgError()` IN `claim-slug.ts` DOES, and
 *    for the same reason: SDKs wrap. Reading `.errors` off the top-level
 *    object alone finds nothing the first time a wrapper is introduced, and
 *    every refusal silently becomes "the service is down".
 */
export function clerkErrorMentionsSlug(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof current !== "object") return false;
    const candidate = current as { errors?: unknown; cause?: unknown };
    if (Array.isArray(candidate.errors)) {
      for (const entry of candidate.errors as ClerkApiError[]) {
        const param = entry?.meta?.paramName;
        if (typeof param === "string" && param.toLowerCase().includes("slug")) {
          return true;
        }
      }
    }
    current = candidate.cause;
  }
  return false;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
