import "server-only";

/**
 * Ordence — Renaming a workspace's address (operator-only)
 * Version: v1.57.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 🔴 A RENAME IS A HOSTNAME CHANGE. IT IS NOT AN EDIT TO A DISPLAY FIELD.
 * ══════════════════════════════════════════════════════════════════════════
 * The moment `tenants.slug` changes, `old.ordence.com` stops being the
 * customer's front door and `new.ordence.com` starts being it. Everything
 * that already points at the old name keeps pointing at it:
 *
 *   • every bookmark every one of their staff has,
 *   • every emailed invoice link and every payment reminder already sent,
 *   • every WhatsApp message a site engineer forwarded to a subcontractor,
 *   • the certificate we issued for the old label, published permanently in
 *     the public Certificate Transparency log.
 *
 * ⭐ SO THE OLD NAME IS NOT FREED, IT IS RETAINED. `tenant_slug_history`
 *    keeps it for 365 days and `ordence_guard_tenant_slug()` refuses any
 *    other tenant that tries to claim it (P0092 exact, P0093 folded). The
 *    365 days is the SHORTEST defensible figure: annual business cycles mean
 *    a link sent last March is opened this March.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 🔴 WHY THERE IS NO SELF-SERVE RENAME, AND WHY THAT IS NOT AN OVERSIGHT
 * ══════════════════════════════════════════════════════════════════════════
 * The obvious next feature is a "change your workspace address" field in the
 * customer's own settings. It must NOT be built until two things exist that
 * do not exist yet:
 *
 *   ① THE REDIRECT. Track 6 ships the 301 from the released host to the
 *      current one (`app/api/internal/host-moved/route.ts`). Until a rename
 *      is survivable for the people holding old links, letting a customer
 *      trigger one is handing them a button that breaks their own invoices.
 *
 *   ② THE OWNER NOTIFICATION. Nobody is told. A workspace owner who renames
 *      at 18:00 has silently changed the address of every colleague's
 *      bookmark, and the first anybody hears of it is a support call the
 *      next morning that begins "the system is down".
 *
 * Until both are real and proven, a rename stays an operator act performed
 * with a stated reason, so that there is always a human who knows it
 * happened and a record saying why.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 🔴 `release_reason` IS NOT OPTIONAL, AND THE DATABASE AGREES
 * ══════════════════════════════════════════════════════════════════════════
 * 0091 carries `CHECK (released_at IS NULL OR release_reason IS NOT NULL)`.
 * That CHECK is the boundary; `RELEASE_REASON_MIN` below is the mistake
 * guard that stops the operator satisfying it with a single space.
 *
 * ⚠️ A ONE-CHARACTER REASON PASSES THE CHECK AND FAILS THE PURPOSE. The row
 *    exists for the day somebody asks "why does acme.ordence.com 301 to
 *    zed.ordence.com, and who decided that?" — a reason of "x" answers
 *    nothing in exactly the incident the record was written for.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ THE ORDER INSIDE THE TRANSACTION IS LOAD-BEARING: CLOSE, THEN CLAIM
 * ══════════════════════════════════════════════════════════════════════════
 * The history row for the CURRENT slug is closed BEFORE `claimSlug()` runs,
 * for two reasons that both bite if it is done the other way round:
 *
 *   • `claimSlug()` leaves the caller's transaction ABORTED on a refusal
 *     (see its header). Any write attempted after a refusal fails with
 *     25P02, so the close would silently never happen and the old hostname
 *     would be left unretained — free for anybody to claim.
 *
 *   • Closing first is safe because the guard trigger deliberately excludes
 *     the tenant's own rows (`h.tenant_id IS DISTINCT FROM NEW.id`). A
 *     workspace can never be blocked by its own retention record.
 *
 * ⭐ `now()` RATHER THAN A JAVASCRIPT `Date`. `now()` is the TRANSACTION
 *    timestamp, which is also what `claimed_at` defaults to on the new row —
 *    so the old tenure ends at the exact instant the new one begins, with no
 *    gap and no overlap in the record.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { withPlatformScope } from "@/db";
import { tenants } from "@/db/schema";
import { tenantSlugHistory } from "@/db/schema/slugs";
import { foldSlug, type SlugRejection } from "@/lib/slug";
import { operatorSlugSchema } from "@/lib/slug-schema";
import { tenantUrl } from "@/lib/tenant";
import type { PlatformResult } from "@/lib/platform/schemas";
import { claimSlug } from "./claim-slug";
import { recordPlatformAudit, requireCapability } from "./guard";

/* ------------------------------------------------------------------ */
/* PRIVATE — NOTHING HERE IS EXPORTED                                  */
/* ------------------------------------------------------------------ */

/*
 * 🔴 THIS MODULE IS `server-only`, NOT `"use server"`, AND THAT IS THE
 *    WHOLE POINT OF THE SPLIT.
 *
 *    `"use server"` publishes EVERY export in a file as a browser-reachable
 *    HTTP endpoint with a stable action id. If the implementation lived in
 *    such a file, these two helper classes and the schema below would be
 *    published alongside it — and a future contributor adding an
 *    `export function buildRenamePreview()` would publish an unguarded
 *    endpoint without touching a single line of security code.
 *
 *    So the endpoint is exactly one thin wrapper in
 *    `server/platform/actions.ts`, and the capability check lives HERE,
 *    one hop from that export, on the function that does the work.
 */

/** The retention window `ordence_guard_tenant_slug()` enforces. */
const RETENTION_DAYS = 365;

/**
 * ⚠️ TEN CHARACTERS, NOT ZERO AND NOT TWENTY.
 *
 * Zero is what the database alone would allow (`NOT NULL` is satisfied by
 * an empty string, and 0091's CHECK only asks for non-NULL). Twenty is what
 * `suspendTenantSchema` demands, and that is right for a suspension because
 * the sentence is shown to the CUSTOMER. This reason is internal evidence,
 * so the bar is "a short sentence a colleague can act on" rather than "a
 * paragraph an operator will pad to reach the limit".
 */
const RELEASE_REASON_MIN = 10;

/**
 * Carries a typed slug refusal out of the `withPlatformScope` callback.
 *
 * ⚠️ THROWN, NOT RETURNED, AND THE THROW IS THE MECHANISM. Returning a
 * value from the callback COMMITS the transaction — and after a refusal the
 * transaction is already aborted, so the commit fails in a place that has
 * lost the reason. Throwing unwinds it and keeps the rejection.
 */
class SlugClaimRefused extends Error {
  readonly rejection: SlugRejection;

  constructor(rejection: SlugRejection) {
    super(`slug_claim_refused:${rejection.code}`);
    this.name = "SlugClaimRefused";
    this.rejection = rejection;
  }
}

/**
 * A refusal decided by US rather than by the database — wrong workspace,
 * mistyped confirmation, nothing to change.
 *
 * ⚠️ ALSO THROWN RATHER THAN RETURNED, so the transaction rolls back. Every
 * one of these is discovered AFTER the SELECT that opened the transaction,
 * and a returned value would commit a transaction that did nothing —
 * harmless today and a landmine the first time a statement is added above.
 */
class RenameRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenameRefused";
  }
}

/**
 * ⚠️ THE SLUG FIELDS GO THROUGH `operatorSlugSchema`, NOT A LOCAL REGEX.
 *
 * `lib/slug.ts` is the only copy of the shape, the length and the 71
 * reserved names, and `lib/slug-schema.ts` is the only Zod wrapper of it.
 * The last time this file's neighbours each kept their own copy, the two
 * disagreed by eight reserved names and one character of minimum length,
 * and workspaces were provisioned onto hostnames the resolver refused to
 * serve. 🔴 Do not reintroduce a local copy here.
 *
 * ⚠️ AND IT IS STILL ONLY A MISTAKE GUARD. Reserved, taken, too-similar and
 *    recently-released are decided by 0091 at UPDATE time, inside
 *    `claimSlug()`. Nothing in this schema may ever be the only refusal.
 */
const renameSlugSchema = z.object({
  tenantId: z.string().uuid("Invalid identifier."),

  /**
   * ⚠️ THE CURRENT ADDRESS, TYPED OUT. Same control the suspend dialog
   * uses, and it is worth more here: the console shows several workspaces
   * per screen, and a rename aimed at the wrong row moves a hostname that
   * nobody asked to move and burns the old one for 365 days.
   *
   * Lowercased before comparison because `tenants.slug` is forced lowercase
   * by `tenants_slug_lowercase`, so "ACME" and "acme" are the same answer.
   */
  confirmSlug: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, "Type the workspace's current address to confirm."),

  newSlug: operatorSlugSchema,

  /**
   * 🔴 WRITTEN TO `tenant_slug_history.release_reason`, WHICH 0091 REFUSES
   *    TO LEAVE NULL. See the header.
   */
  releaseReason: z
    .string()
    .trim()
    .min(
      RELEASE_REASON_MIN,
      `Say why, in at least ${RELEASE_REASON_MIN} characters — this is the only record of why the old address was given up.`,
    )
    .max(1000, "Keep it under 1000 characters."),
});

/* ------------------------------------------------------------------ */
/* THE ACT                                                             */
/* ------------------------------------------------------------------ */

export type RenameSlugOutcome = {
  tenantId: string;
  previousSlug: string;
  newSlug: string;
  /** The address the customer's people must start using. */
  workspaceUrl: string;
  /**
   * Until when the OLD address stays blocked for everybody, including this
   * workspace. Surfaced rather than assumed: the operator is about to tell
   * a customer "your old link keeps working", and that promise has a date.
   */
  retainedUntil: string;
  /**
   * ⚠️ THINGS THIS FUNCTION DID NOT DO. Returned rather than hidden, in the
   * same spirit as `provisionTenant`'s `pending` list — a rename that
   * half-happened must be visible, or somebody tells a customer it is done.
   */
  pending: string[];
};

/**
 * Move a workspace onto a new address, and retain the old one.
 *
 * 🔴 THE CAPABILITY IS `tenants:provision`, WHICH IS OWNER-ONLY, AND THE
 *    CHOICE IS DELIBERATE. `capabilitiesForGrade` gives provisioning to
 *    `owner` alone with the comment "creating a workspace mints billing
 *    identity and a public hostname; it belongs with the grade that can
 *    already suspend one". A rename mints a public hostname AND destroys
 *    one — it is strictly the heavier act, so it cannot sit below the
 *    capability that guards the lighter one.
 *
 * ⚠️ THE GUARD IS HERE, ON THE FUNCTION, NOT ON THE SCREEN. The console
 *    hides the control from a grade that cannot use it, and that hiding is
 *    a courtesy for the operator, not a boundary: the wrapper in
 *    `actions.ts` is a public HTTP endpoint reachable by POST from any page
 *    in the product by anybody who can read a network tab.
 */
export async function renameTenantSlug(
  input: unknown,
): Promise<PlatformResult<RenameSlugOutcome>> {
  const operator = await requireCapability("tenants:provision");

  const parsed = renameSlugSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Some details need fixing.",
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  const { tenantId, confirmSlug, newSlug, releaseReason } = parsed.data;

  try {
    const outcome = await withPlatformScope(
      /*
       * ⚠️ THE REASON STRING IS NOT DECORATION. `withPlatformScope` is the
       * deliberate cross-tenant escape hatch and its own header calls itself
       * "deliberately verbose so it is easy to grep for in a security
       * review". A scope opened with a sentence that names the workspace,
       * the new address and the operator's justification is a scope somebody
       * reading the log can judge.
       */
      `Platform console: rename workspace ${tenantId} to "${newSlug}". ${releaseReason.slice(0, 120)}`,
      async (tx) => {
        const [tenant] = await tx
          .select({ id: tenants.id, slug: tenants.slug, name: tenants.name })
          .from(tenants)
          .where(eq(tenants.id, tenantId))
          .limit(1);

        if (!tenant) throw new RenameRefused("Workspace not found.");

        if (tenant.slug !== confirmSlug) {
          /*
           * ⚠️ NAMES NEITHER SIDE. Echoing the real slug back would turn a
           * mistyped confirmation into a way of reading the address of any
           * workspace id an operator can guess — and the confirmation field
           * exists precisely because the operator may be looking at the
           * wrong row.
           */
          throw new RenameRefused(
            "The current address you typed does not match this workspace. Check you are on the right row.",
          );
        }

        if (tenant.slug === newSlug) {
          /*
           * 🔴 A NO-OP RENAME IS NOT HARMLESS AND MUST BE REFUSED HERE.
           *
           * The guard trigger returns early when the slug is unchanged
           * (`IS NOT DISTINCT FROM`), so the UPDATE would succeed — but the
           * close below would already have stamped `released_at` on the row
           * for the address the workspace is still sitting on. The tenant's
           * own current hostname would then be inside the 365-day retention
           * set, blocking every OTHER tenant from a name that is not free
           * and never was released. Silent, permanent, and invisible until
           * somebody else is refused for no reason anyone can find.
           */
          throw new RenameRefused("That is already this workspace's address. Nothing to change.");
        }

        /*
         * ⭐ CLOSE THE CURRENT TENURE. See the header for why this happens
         * BEFORE the claim rather than after it.
         *
         * `isNull(releasedAt)` and not `slug = tenant.slug`: the invariant
         * being maintained is "a tenant has at most one OPEN row", and
         * closing by the invariant rather than by the value also repairs a
         * workspace that somehow acquired two.
         */
        const closed = await tx
          .update(tenantSlugHistory)
          .set({ releasedAt: sql`now()`, releaseReason })
          .where(
            and(
              eq(tenantSlugHistory.tenantId, tenantId),
              isNull(tenantSlugHistory.releasedAt),
            ),
          )
          .returning({ slug: tenantSlugHistory.slug });

        if (closed.length === 0) {
          /*
           * 🔴 ZERO ROWS CLOSED MEANS THE OLD HOSTNAME WOULD BE LEFT
           *    UNRETAINED, WHICH IS THE ONE OUTCOME THIS WHOLE SUBSYSTEM
           *    EXISTS TO PREVENT.
           *
           * 0091 §6 backfills a row for every tenant that existed when it
           * ran, so this should be unreachable. "Should be unreachable" is
           * not a retention policy: if a tenant row ever appears without
           * history — a restore from a partial dump, a hand-written INSERT
           * during an incident — the rename would silently hand the old
           * label to the next company that asks for it, with a live
           * certificate for it already in the CT log.
           *
           * So the record is written rather than assumed. `claimed_at` is
           * left to default: the true start of that tenure is unknown here,
           * and a fabricated one is worse than an honest "as far as we
           * know, now".
           */
          await tx.insert(tenantSlugHistory).values({
            tenantId,
            slug: tenant.slug,
            slugFold: foldSlug(tenant.slug),
            releasedAt: sql`now()`,
            releaseReason,
          });
          console.error(
            `[renameTenantSlug] no open slug-history row for tenant ${tenantId} ("${tenant.slug}"). ` +
              `One was written so the old hostname is retained. 0091's backfill should have made this impossible.`,
          );
        }

        /*
         * ⭐ THE CLAIM. `tenantId` present means "rename in place" — the
         * same `UPDATE tenants SET slug` the guard trigger fires on, plus
         * the new `tenant_slug_history` row, in this same transaction.
         *
         * 🔴 A REFUSAL HAS ALREADY ABORTED THIS TRANSACTION. Nothing may be
         *    written after it; throwing is the only correct exit.
         */
        const claim = await claimSlug(tx, {
          slug: newSlug,
          tenantId,
          actor: operator.email,
        });
        if (!claim.ok) throw new SlugClaimRefused(claim.rejection);

        return { previousSlug: tenant.slug, name: tenant.name };
      },
    );

    /*
     * ⚠️ THE AUDIT ROW IS WRITTEN AFTER THE TRANSACTION COMMITS, NOT INSIDE
     * IT, AND THAT IS `claimSlug`'s CONTRACT RATHER THAN A PREFERENCE: a
     * refused claim leaves the handle aborted, so an audit insert attempted
     * on it would fail with 25P02 and take the real error with it.
     *
     * ⭐ ATTRIBUTED TO THE TENANT, so it lands in the CUSTOMER'S OWN audit
     * log. Their address was changed by us; they are entitled to see who,
     * when and why without asking.
     */
    await recordPlatformAudit({
      operator,
      tenantId,
      action: "config_change",
      resourceType: "tenant_slug",
      resourceId: tenantId,
      oldValue: { slug: outcome.previousSlug },
      newValue: { slug: newSlug },
      /*
       * ⚠️ `critical`, the same severity as a suspension. A rename takes a
       * working workspace off the address every one of its people has
       * bookmarked. It is not a settings change.
       */
      severity: "critical",
      reason: releaseReason,
      metadata: {
        previousSlug: outcome.previousSlug,
        newSlug,
        retentionDays: RETENTION_DAYS,
        renamedBy: operator.email,
      },
    });

    const retainedUntil = new Date(Date.now() + RETENTION_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);

    return {
      ok: true,
      data: {
        tenantId,
        previousSlug: outcome.previousSlug,
        newSlug,
        workspaceUrl: workspaceUrlFor(newSlug),
        retainedUntil,
        pending: [
          `Tell ${outcome.name}'s owner that the address changed — nothing in this product notifies them.`,
          `${workspaceUrlFor(outcome.previousSlug)} now answers 301 to the new address, and stays blocked for everybody until ${retainedUntil}.`,
        ],
      },
    };
  } catch (error) {
    if (error instanceof RenameRefused) {
      return { ok: false, error: error.message };
    }

    /*
     * ⭐ `operatorMessage`, NOT `publicMessage`. The reader is staff with a
     * database in front of them, so the refusal may name the constraint and
     * the conflict. The split exists because the same sentence on a public
     * signup form would be a lookup tool for which near-miss names are
     * already taken — see the note in `lib/slug.ts`.
     */
    if (error instanceof SlugClaimRefused) {
      return {
        ok: false,
        error: `"${newSlug}" cannot be claimed. ${error.rejection.operatorMessage} Nothing was changed.`,
      };
    }

    console.error("[renameTenantSlug] failed:", error);
    return {
      ok: false,
      error: "The rename failed. Nothing was changed. The failure was logged.",
    };
  }
}

/**
 * ⚠️ BUILT WITH `tenantUrl()` RATHER THAN BY CONCATENATION, so the address
 * the operator is shown is assembled by the same module that decides which
 * hostnames resolve. A builder and a parser that disagree produce a
 * confident sentence pointing at a host the resolver will not serve.
 */
function workspaceUrlFor(slug: string): string {
  const env = process.env as Record<string, string | undefined>;
  return tenantUrl(
    slug,
    env["NEXT_PUBLIC_ROOT_DOMAIN"] ?? "localhost:3000",
    "/",
    env["NEXT_PUBLIC_ZONE_DOMAIN"],
  );
}
