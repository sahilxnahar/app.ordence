/**
 * Ordence — A refused name means a DIFFERENT ADDRESS, never NO WORKSPACE
 * Version: v1.64.1-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE INCIDENT THIS FILE EXISTS FOR
 * ══════════════════════════════════════════════════════════════════════
 * `app/api/webhooks/clerk/_webhook.ts` is the only path that creates a
 * `tenants` row for a real signup. It derived one slug from the Clerk
 * organisation, inserted it, and handled exactly one conflict — a
 * duplicate `clerk_org_id`. Everything 0091 refuses (reserved name,
 * exact collision, confusable collision, a name inside the 365-day
 * retention window) therefore aborted the transaction, threw out of
 * `withPlatformScope`, and returned 500. The customer got the "your
 * workspace is not ready yet" card and never got a workspace at all.
 *
 * The founder hit it on the day this was written: a Clerk organisation
 * with the slug `ordence`, which `lib/slug.ts` reserves. Roughly seventy
 * other names — `support`, `admin`, `billing`, `gst`, `invoice`, `app`,
 * `api`, `test` — do the same thing to any customer unlucky enough to be
 * called one of them, and so does every name another tenant already has.
 *
 * ⭐ A NAME WE REFUSE IS A DIFFERENT ADDRESS. IT IS NEVER NO ADDRESS.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THIS FILE INVENTS NOTHING. THAT IS THE WHOLE POINT.
 * ══════════════════════════════════════════════════════════════════════
 * `suggestSlugs()` in `lib/slug.ts` already produces ordered, deterministic,
 * shape-checked alternatives and was read by the signup form and by
 * nothing on the path that actually provisions. `checkSlugShape()`
 * already answers "would this be refused before we even ask". Both are
 * used here as they are. A second suggestion generator would be the
 * two-reserved-word-lists incident rebuilt in a new shape.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 DETERMINISM IS A CORRECTNESS PROPERTY HERE, NOT A PREFERENCE
 * ══════════════════════════════════════════════════════════════════════
 * Svix delivers at least once. Two deliveries of ONE `organization.created`
 * event must converge on ONE slug and ONE tenant row. So the candidate
 * order is a pure function of the requested name and the Clerk
 * organisation id:
 *
 *   • `suggestSlugs()` is deterministic and stays that way.
 *   • 🔴 THE LAST-RESORT CANDIDATE IS DERIVED FROM `org.id`, WHICH IS
 *     STABLE ACROSS DELIVERIES. Never from `Date.now()`, never from a
 *     random suffix. `_webhook.ts` previously fell back to
 *     `org-${Date.now().toString(36)}` when a name normalised to nothing;
 *     two deliveries of that event would have produced two different
 *     slugs and, given the chance, two workspaces.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE ADVISORY SKIP IS ADVISORY, AND IT ONLY EVER SKIPS
 * ══════════════════════════════════════════════════════════════════════
 * `checkSlugShape()` is used to decide which candidates are worth
 * ATTEMPTING. It is never used to decide that a candidate is available:
 * that is the unique index's job and the insert's job. Skipping a name
 * the local list already calls reserved saves a guaranteed round trip and
 * a guaranteed aborted savepoint; it does not narrow what the database is
 * still free to refuse. The reason for a skip is recorded and reaches the
 * audit row, so "why is my address not my company name" has an answer
 * that does not require guessing.
 */

import {
  SLUG_MAX_LENGTH,
  checkSlugShape,
  suggestSlugs,
  type SlugRejectionCode,
} from "./slug";

/* ------------------------------------------------------------------ */
/* HOW MANY TIMES WE ARE WILLING TO ASK                                */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ BOUNDED, AND THE BOUND IS SMALL ON PURPOSE.
 *
 * Every attempt after the first costs a savepoint, a failed statement and
 * a rollback inside a webhook that Svix will time out. Ten is more than
 * enough to clear `suggestSlugs()`'s whole list; if ten distinct names
 * derived from one company are all refused, the honest outcome is a 500
 * and a retry rather than a fifty-deep loop nobody can read the log of.
 */
export const SLUG_ATTEMPT_LIMIT = 10;

/* ------------------------------------------------------------------ */
/* THE PLAN                                                            */
/* ------------------------------------------------------------------ */

/** A candidate that was not even attempted, and why. */
export type SkippedCandidate = { slug: string; code: SlugRejectionCode };

export type SlugCandidatePlan = {
  /** What the Clerk organisation asked for, normalised. */
  requested: string;
  /** In the order they will be attempted. May be empty. */
  candidates: string[];
  /** Refused by the advisory check before any statement was issued. */
  skipped: SkippedCandidate[];
};

/**
 * The last-resort candidate, derived from a value that does not move.
 *
 * 🔴 `stableId` IS THE CLERK ORGANISATION ID. It is the same string on
 *    every delivery of the same event, which is what makes a redelivery
 *    land on the same name instead of minting a second workspace.
 *
 * The tail is the LAST eight alphanumeric characters rather than the
 * first: Clerk ids are `org_` + an opaque body, and the leading
 * characters are shared by every organisation in the instance.
 */
export function fallbackSlugFromStableId(
  base: string,
  stableId: string,
): string | null {
  const tail = stableId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(-8);

  // Too little entropy to be worth offering as a distinct address.
  if (tail.length < 4) return null;

  const cleaned = base.toLowerCase().replace(/[^a-z0-9-]/g, "").replace(/^-+|-+$/g, "");

  // 63 characters is a DNS label, not a suggestion. Leave room for the
  // separator and the tail, then re-trim so the head cannot end on a
  // hyphen and produce `acme--2ab34cd5`.
  const room = SLUG_MAX_LENGTH - tail.length - 1;
  const head = cleaned.slice(0, Math.max(0, room)).replace(/-+$/g, "");

  /*
   * `ws-` when the company name normalised to nothing at all — an
   * organisation named entirely in Devanagari, say. It is a workspace
   * address, it is valid, it is stable, and it is better than the 500
   * this file replaces.
   */
  const candidate = head.length > 0 ? `${head}-${tail}` : `ws-${tail}`;

  return checkSlugShape(candidate) === null ? candidate : null;
}

/**
 * The ordered, deterministic list of addresses to try for one workspace.
 *
 * ⚠️ THE REQUESTED NAME IS ALWAYS FIRST WHEN IT IS PLAUSIBLE. A customer
 *    called "Acme" gets `acme` and nothing clever happens. The rest of
 *    this file only matters on the day it cannot.
 *
 * ⚠️ THE LAST-RESORT CANDIDATE IS ALWAYS LAST AND IS NEVER CROWDED OUT by
 *    the suffix list, because it is the only candidate that cannot
 *    collide with another tenant's name by construction. The limit is
 *    applied to everything before it.
 */
export function planSlugCandidates(
  desired: string,
  stableId: string,
  limit: number = SLUG_ATTEMPT_LIMIT,
): SlugCandidatePlan {
  const requested = desired.trim().toLowerCase();

  const candidates: string[] = [];
  const skipped: SkippedCandidate[] = [];
  const seen = new Set<string>();

  const consider = (candidate: string): void => {
    if (seen.has(candidate)) return;
    seen.add(candidate);
    const shape = checkSlugShape(candidate);
    if (shape) {
      skipped.push({ slug: candidate, code: shape.code });
      return;
    }
    candidates.push(candidate);
  };

  if (requested.length > 0) consider(requested);
  for (const suggestion of suggestSlugs(requested, limit)) consider(suggestion);

  const bounded = candidates.slice(0, Math.max(0, limit - 1));

  const lastResort = fallbackSlugFromStableId(requested, stableId);
  if (lastResort !== null && !bounded.includes(lastResort)) bounded.push(lastResort);

  return { requested, candidates: bounded, skipped };
}

/* ------------------------------------------------------------------ */
/* WHAT THE OPERATOR CONSOLE READS BACK                                */
/* ------------------------------------------------------------------ */

/**
 * ⭐ WHY THIS IS PERSISTED AT ALL.
 *
 * Support gets asked "why is our address not our company name?" and the
 * answer lives in one audit row written months ago. `tenants.settings`
 * already exists, is jsonb, needs no migration, and is read on the tenant
 * detail page — so the answer is one field lookup away from the operator
 * instead of a query nobody remembers how to write.
 *
 * ⚠️ WRITERS MUST MERGE INTO `settings`, NEVER REPLACE IT. Several forms
 *    write to that one column; a replace silently erases the others. The
 *    column's own comment in `db/schema/core.ts` says the same thing.
 */
export type SlugOrigin = {
  /** The address the Clerk organisation asked for. */
  requested: string;
  /** The address it actually got. */
  granted: string;
  /** Why the requested one was not available. */
  reason: SlugRejectionCode;
};

const REJECTION_CODES: ReadonlySet<string> = new Set<SlugRejectionCode>([
  "empty",
  "too_short",
  "too_long",
  "bad_characters",
  "leading_or_trailing_hyphen",
  "reserved",
  "taken",
  "too_similar",
  "recently_released",
]);

/**
 * Read the marker back out of a jsonb blob.
 *
 * ⚠️ DEFENSIVE, BECAUSE `settings` IS jsonb AND ITS TypeScript TYPE IS A
 *    PROMISE RATHER THAN A GUARANTEE. Rows predate the type, and a
 *    console page that throws on a malformed blob is a console page that
 *    is down during the incident it was opened for.
 */
export function readSlugOrigin(settings: unknown): SlugOrigin | null {
  if (typeof settings !== "object" || settings === null) return null;
  const raw = (settings as { clerkSlug?: unknown }).clerkSlug;
  if (typeof raw !== "object" || raw === null) return null;

  const { requested, granted, reason } = raw as Record<string, unknown>;
  if (typeof requested !== "string" || requested.length === 0) return null;
  if (typeof granted !== "string" || granted.length === 0) return null;
  if (typeof reason !== "string" || !REJECTION_CODES.has(reason)) return null;

  return { requested, granted, reason: reason as SlugRejectionCode };
}
