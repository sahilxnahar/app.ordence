import "server-only";

/**
 * Ordence — Claiming an address that is actually available
 * Version: v1.64.1-alpha
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⭐ THE PRINCIPLE, UNCHANGED — THIS FILE ONLY ADDS "AND THEN TRY THE NEXT"
 * ══════════════════════════════════════════════════════════════════════════
 *
 *       The availability check is advisory.
 *       The unique index is the truth.
 *       The insert is the claim.
 *
 * `claimSlug()` already implements one claim correctly, including the
 * SQLSTATE mapping and the `tenant_slug_history` row. Nothing here
 * re-implements any of it. This file answers ONE question `claimSlug()`
 * deliberately does not: what should happen when the answer is "no".
 *
 * For the OPERATOR wizard and the signup form, "no" is shown to a human who
 * picks another name. For the Clerk webhook there is no human — there is a
 * paying customer staring at "your workspace is not ready yet" — so "no"
 * must become "here is a different address".
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 🔴 THE SAVEPOINT IS NOT AN OPTIMISATION. WITHOUT IT THERE IS NO RETRY.
 * ══════════════════════════════════════════════════════════════════════════
 * `claim-slug.ts`'s own header states it: a refusal from the guard trigger or
 * a unique index puts the WHOLE transaction into the aborted state, and every
 * later statement on that handle fails with `25P02 current transaction is
 * aborted`. So a loop that simply calls `claimSlug()` again would fail on its
 * second candidate with an error that has nothing to do with slugs, and the
 * customer would get the same 500 by a longer route.
 *
 * `SAVEPOINT` / `ROLLBACK TO SAVEPOINT` is the only thing that makes the
 * handle usable again. `server/automation/emit.ts` does the same, for the
 * same reason, and this file follows its shape deliberately.
 *
 * ⚠️ NO SECOND CONNECTION AND NO NESTED TRANSACTION. RLS is the only tenant
 *    isolation in this product and it is pinned by a transaction-local GUC
 *    set by `withPlatformScope()`. Stepping outside that transaction to
 *    retry would step outside the scope.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 🔴 ONLY THE REFUSALS `rejectionFromPgError()` RECOGNISES ARE RETRIED
 * ══════════════════════════════════════════════════════════════════════════
 * `claimSlug()` returns `{ ok: false }` for exactly those and THROWS for
 * everything else. This file never catches. A foreign-key violation, a NOT
 * NULL violation, a lost connection or a permission error propagates, the
 * webhook returns 500, and Svix retries — which is correct, because those are
 * real faults and hiding them would turn a visible outage into silent data
 * loss. That trade is strictly worse than the bug this file fixes.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ THE TWO PATHS ARE DELIBERATELY DIFFERENT, AND THE DIFFERENCE IS THE
 *    WHOLE DESIGN
 * ══════════════════════════════════════════════════════════════════════════
 *   CREATE  → walk the candidate list. A workspace that does not exist has
 *             no hostname anybody has bookmarked; a different address costs
 *             the customer nothing.
 *
 *   RENAME  → ONE attempt at the requested name, and on refusal KEEP THE
 *             EXISTING SLUG. See `tryRenameSlugForClerkOrg` below: an
 *             automatic fallback here would move a LIVE hostname to a name
 *             nobody chose and burn the old one for 365 days.
 */

import { and, eq, isNull, sql } from "drizzle-orm";

import type { withPlatformScope } from "@/db";
import { tenantSlugHistory } from "@/db/schema/slugs";
import {
  checkSlugShape,
  rejection,
  type SlugRejection,
  type SlugRejectionCode,
} from "@/lib/slug";
import { planSlugCandidates, SLUG_ATTEMPT_LIMIT } from "@/lib/slug-resolution";
import { claimSlug, type NewTenantRow } from "./claim-slug";

/**
 * The caller's open handle — `withPlatformScope`, never `withTenant`.
 * `tenant_slug_history` has `WITH CHECK (app_platform_scope())` on its write
 * policy, and the two handles are structurally identical to TypeScript.
 */
type PlatformTx = Parameters<Parameters<typeof withPlatformScope>[1]>[0];

/**
 * ⚠️ ONE NAME, REUSED EVERY ITERATION, AND THAT IS CORRECT. `SAVEPOINT x`
 *    after `ROLLBACK TO SAVEPOINT x; RELEASE SAVEPOINT x` establishes a
 *    fresh one. It is a constant rather than interpolated so that nothing
 *    the webhook receives from Clerk can ever reach an identifier position.
 */
const SAVEPOINT = sql`SAVEPOINT ordence_slug_attempt`;
const ROLLBACK_TO = sql`ROLLBACK TO SAVEPOINT ordence_slug_attempt`;
const RELEASE = sql`RELEASE SAVEPOINT ordence_slug_attempt`;

/* ------------------------------------------------------------------ */
/* WHAT CAME BACK                                                      */
/* ------------------------------------------------------------------ */

/**
 * One refused address, in the order it was refused.
 *
 * ⚠️ `operatorMessage`, NEVER `publicMessage`. This ends up in the audit
 *    trail and in front of staff. The public/operator split in
 *    `SLUG_REJECTIONS` exists because a public message that names the
 *    conflicting workspace is a lookup tool for near-miss names.
 */
export type SlugRefusal = {
  slug: string;
  code: SlugRejectionCode;
  operatorMessage: string;
  /**
   * `advisory` — refused by `checkSlugShape()` before any statement ran.
   * `database` — refused by 0091's trigger or one of the unique indexes.
   */
  source: "advisory" | "database";
};

export type SlugClaimWithFallback =
  | {
      ok: true;
      tenantId: string;
      /** What was asked for. */
      requested: string;
      /** What was actually claimed. Equal to `requested` on the happy path. */
      granted: string;
      refusals: SlugRefusal[];
    }
  | { ok: false; requested: string; refusals: SlugRefusal[] };

const asRefusal = (
  slug: string,
  r: SlugRejection,
  source: SlugRefusal["source"],
): SlugRefusal => ({
  slug,
  code: r.code,
  operatorMessage: r.operatorMessage,
  source,
});

/* ------------------------------------------------------------------ */
/* CREATE — WALK THE LIST                                              */
/* ------------------------------------------------------------------ */

/**
 * Claim the first address in the deterministic candidate list that the
 * database will actually accept, and insert the tenant row with it.
 *
 * ⭐ THE CANDIDATE LIST IS A PURE FUNCTION of the requested name and the
 *    Clerk organisation id (`stableId`). Two Svix deliveries of one event
 *    walk the same list in the same order, so they converge on the same
 *    slug. See `lib/slug-resolution.ts`.
 *
 * ⚠️ `tenant.clerkOrgId` CARRIES ITS OWN UNIQUE INDEX (`tenants_clerk_org_unique`).
 *    A genuinely simultaneous second delivery therefore loses on THAT index,
 *    which `rejectionFromPgError()` does not recognise, so it throws and the
 *    webhook returns 500 and Svix retries — by which time the first delivery
 *    has committed and the retry takes the "already exists" branch. One
 *    workspace either way; the redelivery is what makes it converge.
 */
export async function claimSlugWithFallback(
  tx: PlatformTx,
  params: {
    /** The address derived from the Clerk organisation. */
    desired: string;
    /** The Clerk organisation id. Stable across deliveries. */
    stableId: string;
    tenant: NewTenantRow;
    actor: string;
    limit?: number;
  },
): Promise<SlugClaimWithFallback> {
  const plan = planSlugCandidates(
    params.desired,
    params.stableId,
    params.limit ?? SLUG_ATTEMPT_LIMIT,
  );

  const refusals: SlugRefusal[] = plan.skipped.map((s) =>
    asRefusal(s.slug, rejection(s.code), "advisory"),
  );

  for (const candidate of plan.candidates) {
    /*
     * 🔴 THE SAVEPOINT GOES ROUND THE CLAIM, NOT ROUND THE LOOP. Each
     *    attempt must be independently discardable: the whole point is that
     *    attempt two runs on a handle attempt one did not poison.
     */
    await tx.execute(SAVEPOINT);

    /*
     * ⚠️ NOT WRAPPED IN try/catch, ON PURPOSE. `claimSlug()` throws for
     *    everything that is not a recognised slug refusal, and those must
     *    keep going. The savepoint is left unreleased, which is harmless:
     *    the caller's transaction is unwinding anyway.
     */
    const claim = await claimSlug(tx, {
      slug: candidate,
      tenant: params.tenant,
      actor: params.actor,
    });

    if (claim.ok) {
      await tx.execute(RELEASE);
      return {
        ok: true,
        tenantId: claim.tenantId,
        requested: plan.requested,
        granted: candidate,
        refusals,
      };
    }

    refusals.push(asRefusal(candidate, claim.rejection, "database"));

    /*
     * ⭐ THIS IS WHAT MAKES THE NEXT ITERATION POSSIBLE. Without it the
     *    handle is aborted and every later statement fails with 25P02.
     */
    await tx.execute(ROLLBACK_TO);
    await tx.execute(RELEASE);
  }

  /*
   * Every candidate refused. Nothing has been written, the handle is
   * usable, and the caller is expected to THROW so Svix retries — because
   * ten distinct names all being refused is a fault, not an answer.
   */
  return { ok: false, requested: plan.requested, refusals };
}

/* ------------------------------------------------------------------ */
/* RENAME — ONE ATTEMPT, AND NO FALLBACK. EVER.                        */
/* ------------------------------------------------------------------ */

export type SlugRenameOutcome =
  /** The address changed, or was already what Clerk asked for. */
  | { ok: true; slug: string; changed: boolean }
  /** The address did NOT change and the workspace keeps working. */
  | { ok: false; slug: string; refusal: SlugRefusal };

/**
 * ══════════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS DOES NOT DO WHAT `claimSlugWithFallback` DOES
 * ══════════════════════════════════════════════════════════════════════════
 * An existing workspace already HAS a live hostname. Every bookmark, every
 * emailed invoice link, every WhatsApp message a site engineer forwarded,
 * and the certificate published in the public CT log all point at it.
 *
 * So if the name Clerk now asks for is refused, the correct outcome is that
 * NOTHING MOVES. Walking to `acme-india` would:
 *
 *   • change a working public hostname to a name literally nobody chose,
 *     silently, from a background webhook, and
 *   • release the old one into `tenant_slug_history`, where 0091 blocks it
 *     for 365 days — spending a year of retention on a rename that was an
 *     accident of somebody editing a field in the Clerk dashboard.
 *
 * ⭐ A REFUSED RENAME IS THEREFORE A NO-OP PLUS A RECORD. The name and the
 *    branding still update, because those were never in doubt, and the
 *    refusal is written into the audit row so support can answer for it.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ ON THE SUCCESS PATH THE OLD TENURE IS CLOSED FIRST
 * ══════════════════════════════════════════════════════════════════════════
 * `claimSlug()` opens a new `tenant_slug_history` row. If the previous one
 * were left open the workspace would hold two open tenures, the old hostname
 * would never enter the retention window, and the next tenant to ask for it
 * would be handed a name that is live in somebody's bookmarks. `renameSlug`
 * (the operator path) closes first for exactly this reason; so does this.
 *
 * Both statements sit inside ONE savepoint, so a refused claim also discards
 * the close — the alternative is a workspace whose current address has been
 * marked released while it is still sitting on it.
 */
export async function tryRenameSlugForClerkOrg(
  tx: PlatformTx,
  params: {
    tenantId: string;
    currentSlug: string;
    desired: string;
    actor: string;
  },
): Promise<SlugRenameOutcome> {
  const desired = params.desired.trim().toLowerCase();

  /*
   * ⚠️ NOTHING TO DO IS NOT A REFUSAL. Most `organization.updated`
   *    deliveries carry an unchanged slug — a logo change, a name change.
   *    Issuing the UPDATE anyway would fire 0091's trigger for no reason and
   *    close a tenure that is not ending.
   */
  if (desired === params.currentSlug || desired.length === 0) {
    return { ok: true, slug: params.currentSlug, changed: false };
  }

  /*
   * The advisory check, doing the one thing it is allowed to do: telling us
   * not to bother asking. The database remains the authority for everything
   * it does not catch.
   */
  const shape = checkSlugShape(desired);
  if (shape) {
    return {
      ok: false,
      slug: params.currentSlug,
      refusal: asRefusal(desired, shape, "advisory"),
    };
  }

  await tx.execute(SAVEPOINT);

  const releaseReason =
    `Clerk organisation slug changed to "${desired}". ` +
    `Applied by the Clerk sync webhook; the previous address is retained for 365 days.`;

  await tx
    .update(tenantSlugHistory)
    .set({ releasedAt: sql`now()`, releaseReason })
    .where(
      and(
        eq(tenantSlugHistory.tenantId, params.tenantId),
        isNull(tenantSlugHistory.releasedAt),
      ),
    );

  const claim = await claimSlug(tx, {
    slug: desired,
    tenantId: params.tenantId,
    actor: params.actor,
  });

  if (claim.ok) {
    await tx.execute(RELEASE);
    return { ok: true, slug: desired, changed: true };
  }

  await tx.execute(ROLLBACK_TO);
  await tx.execute(RELEASE);

  return {
    ok: false,
    slug: params.currentSlug,
    refusal: asRefusal(desired, claim.rejection, "database"),
  };
}
