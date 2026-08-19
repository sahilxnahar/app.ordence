import "server-only";

/**
 * Ordence — Public slug availability, the implementation
 * Version: v1.57.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE ANSWER THIS FILE RETURNS IS ADVISORY. IT IS NOT A RESERVATION,
 *      IT IS NOT A LOCK, AND IT CANNOT PREVENT A DUPLICATE.
 * ══════════════════════════════════════════════════════════════════════
 *      The availability check is advisory.
 *      The unique index is the truth.
 *      The insert is the claim.
 *
 * `tenants_slug_unique` and `tenants_slug_fold_unique` (SECTION 3 of
 * SQL-FILES/0091_slug_authority.sql), together with the
 * `ordence_guard_tenant_slug` trigger, are the ONLY things that decide
 * whether a slug can be held. Everything below is a mistake guard: it
 * stops a typo becoming a support ticket and it makes the signup form
 * pleasant. Between the moment this endpoint answers "yes" and the moment
 * the claim runs, the answer can become wrong — the window is the user's
 * typing speed, and two people signing up simultaneously are both told
 * yes. That is not a bug to be fixed here; it is why the claim path
 * re-checks INSIDE the transaction that inserts the row, and maps the
 * resulting SQLSTATE with `rejectionFromPgError()`.
 *
 * 🔴 SO: DO NOT "OPTIMISE" THE CLAIM PATH BY TRUSTING THIS ENDPOINT.
 *    Not by calling it first and skipping the insert-time guard, not by
 *    caching its answer, not by treating a 200 with `available: true` as
 *    a soft reservation. A check that runs before an insert is a race,
 *    and the only reason this product has never lost that race is that
 *    nothing has ever been allowed to depend on winning it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THIS ENDPOINT NECESSARILY REVEALS WHICH WORKSPACES EXIST, AND THAT
 *    IS NOT A LEAK BEING TOLERATED — IT IS A FACT ABOUT THE PRODUCT.
 * ══════════════════════════════════════════════════════════════════════
 * `acme.ordence.com` resolves in public DNS, and the certificate we issue
 * for it is published in the public certificate transparency log within
 * minutes of issuance. Anyone who wants the list of tenant slugs already
 * has cheaper and more complete ways to get it than typing names into a
 * signup form one at a time.
 *
 * The rate limit below therefore exists to stop BULK SCRAPING and to keep
 * an unauthenticated endpoint from becoming a free database-load
 * generator. It does not, and cannot, hide an individual answer.
 *
 * 🔴 NOBODY MAY LATER BUILD A FEATURE THAT ASSUMES A TENANT SLUG IS
 *    CONFIDENTIAL. It is a public hostname. What IS protected here is
 *    narrower and real: the refusal never NAMES the workspace it collided
 *    with (see `publicMessage` below), because naming it turns the form
 *    into a lookup tool for near-miss names, which is reconnaissance for
 *    exactly the phishing attack the confusable fold exists to prevent.
 */

import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { withPlatformScope } from "@/db";
import { checkEdgeLimit, edgeLimitStatus, type EdgeIdentity } from "@/lib/edge/limits";
import { ipPrefix, rateLimitBody } from "@/lib/security/rate-limit";
import {
  checkSlugShape,
  foldSlug,
  rejection,
  suggestSlugs,
  type SlugRejection,
  type SlugRejectionCode,
} from "@/lib/slug";

/* ------------------------------------------------------------------ */
/* THE WIRE SHAPE                                                      */
/* ------------------------------------------------------------------ */

export type SlugAvailabilityResponse = {
  available: boolean;
  /**
   * ⚠️ `message` IS ALWAYS `publicMessage`, NEVER `operatorMessage`.
   *
   * The operator string may name the conflicting workspace, quote the
   * constraint that refused it and cite the retention date. Every one of
   * those is useful to staff with a database in front of them and is
   * reconnaissance in the hands of an anonymous caller. The split lives
   * in `lib/slug.ts`; this file's only job is not to undo it.
   */
  reason?: { code: SlugRejectionCode; message: string };
  /** Verified free at the moment of the answer. Advisory, like the rest. */
  suggestions?: string[];
};

/**
 * ⚠️ `.strict()`, so `{ slug, tenantId }` is a 400 rather than a field
 *    quietly ignored. There is nothing else this endpoint accepts, and an
 *    endpoint that tolerates unknown keys is one refactor away from
 *    honouring one.
 *
 * No `.max()` on the string: the body is already capped at
 * `MAX_BODY_BYTES` below, and letting an over-long name reach
 * `checkSlugShape()` is what produces the honest `too_long` message
 * instead of a generic parse failure.
 */
const bodySchema = z.object({ slug: z.string() }).strict();

/**
 * 1 KiB. A legal slug is at most 63 bytes and the envelope adds a dozen;
 * anything larger is not a workspace name being typed.
 *
 * ⚠️ Enforced here as well as in middleware (`BODY_LIMIT_RULES` defaults
 *    to 512 KiB for this path). The middleware number is a platform
 *    backstop; this one is the route saying what it actually accepts.
 */
const MAX_BODY_BYTES = 1024;

/* ------------------------------------------------------------------ */
/* THE RATE LIMIT                                                      */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 10 PER MINUTE AND 60 PER HOUR, PER SOURCE NETWORK. BOTH, NOT EITHER.
 * ══════════════════════════════════════════════════════════════════════
 * A minute window alone permits 600/hour to a patient caller, which is a
 * perfectly comfortable rate at which to walk a dictionary. An hour
 * window alone permits the whole 60 in one burst, which is the shape a
 * script has. Two windows over one key cost one extra Redis round trip
 * and close both.
 *
 * 10/minute is far above a human: a person typing a workspace name and
 * watching the field turn green does it two or three times.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WITHOUT `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` THESE
 *    NUMBERS ARE NOT THE NUMBERS.
 * ══════════════════════════════════════════════════════════════════════
 * `lib/edge/limits.ts` degrades to a per-INSTANCE sliding-window log when
 * no shared counter is configured, and reports `mode: "degraded"` when it
 * does. On a multi-instance deployment the effective ceiling is then
 * `limit × instance count`, and it resets on every cold start.
 *
 * On an AUTHENTICATED surface that is a tolerable speed bump. On THIS
 * one — anonymous, unauthenticated, and answering a question about which
 * workspaces exist — a limit multiplied by the instance count is an
 * enumeration tool, and the multiplier is chosen by whoever is scaling
 * the deployment rather than by us. Configure Redis in any environment
 * where this route is reachable from the internet.
 */
const PER_MINUTE = { limit: 10, windowSeconds: 60 } as const;
const PER_HOUR = { limit: 60, windowSeconds: 3600 } as const;

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHICH ADDRESS WE COUNT, AND WHY NOT THE OBVIOUS ONE.
 * ══════════════════════════════════════════════════════════════════════
 * `x-forwarded-for` is a LIST the client starts and each proxy appends
 * to. Its FIRST entry is therefore attacker-chosen, and a limiter keyed
 * on it is bypassed by a header — which is the trap
 * `app/api/telemetry/route.ts` declined to walk into and wrote up instead
 * of half-doing.
 *
 * So, in order:
 *   1. `cf-connecting-ip` — written by Cloudflare, which strips any
 *      client-supplied copy. Trustworthy when we are behind it.
 *   2. `x-real-ip` — written by the immediate reverse proxy.
 *   3. The LAST entry of `x-forwarded-for` — the address the closest
 *      trusted hop observed, i.e. the one it appended itself. The
 *      leftmost is the client's own claim and is never used.
 *
 * ⚠️ STEP 3 ASSUMES EXACTLY ONE TRUSTED HOP IN FRONT OF US. That is true
 *    of Railway and of the Cloudflare Worker deployment today. Add a
 *    second proxy and the rightmost entry becomes the first proxy rather
 *    than the client, and this must be revisited — written down here
 *    because it is the kind of assumption that is invisible once it is
 *    wrong.
 *
 * ⭐ Then collapsed to a /24 (v4) or /64 (v6) PREFIX by `ipPrefix()`.
 *    Anyone with a VPS holds a /64 of IPv6, which is eighteen quintillion
 *    exact addresses and therefore eighteen quintillion free buckets if
 *    the exact address were the key.
 *
 * A null address collapses every unidentifiable caller into one bucket.
 * That is the safe direction: stripping the headers is not a bypass, it
 * is a shared bucket.
 */
function sourceKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const lastHop = forwarded?.split(",").pop()?.trim() ?? null;

  const observed =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-real-ip") ??
    lastHop;

  return ipPrefix(observed);
}

/* ------------------------------------------------------------------ */
/* RESPONSES                                                           */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ `no-store` ON EVERY EXIT, INCLUDING THE REFUSALS. An availability
 *    answer is true for an instant. A CDN or a browser that cached one
 *    would keep showing "available" for a name somebody else has since
 *    taken, and the user would discover it at the end of signup.
 */
function json(
  body: SlugAvailabilityResponse | { error: string },
  status: number,
  extra: Record<string, string> = {},
): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "cache-control": "no-store", ...extra },
  });
}

/** An answer of "no", carrying the PUBLIC sentence and nothing more. */
function refuse(
  reasonForRefusal: SlugRejection,
  suggestions?: string[],
): SlugAvailabilityResponse {
  return {
    available: false,
    reason: { code: reasonForRefusal.code, message: reasonForRefusal.publicMessage },
    ...(suggestions && suggestions.length > 0 ? { suggestions } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* THE DATABASE CHECKS                                                 */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ 365 DAYS IS WRITTEN IN TWO PLACES AND THE OTHER ONE IS THE
 *    AUTHORITY. `ordence_guard_tenant_slug()` in
 *    SQL-FILES/0091_slug_authority.sql raises P0092/P0093 on its own
 *    reading of this interval; the constant here only decides what this
 *    endpoint PREDICTS. If they diverge, the database still refuses
 *    correctly and this endpoint lies — which is the failure mode the
 *    whole file is written to make loud rather than to make impossible.
 */
const RETENTION_DAYS = 365;

/** Drizzle's `execute` yields `{ rows }` on the pooled client, an array on neon-http. */
function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  return (result as { rows?: Record<string, unknown>[] })?.rows ?? [];
}

type Tx = Parameters<Parameters<typeof withPlatformScope>[1]>[0];

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE ORDER OF THESE CHECKS IS THE ORDER THE DATABASE USES, AND THAT
 *    IS THE ENTIRE POINT OF THE FUNCTION.
 * ══════════════════════════════════════════════════════════════════════
 *   1. shape              `tenants_slug_shape` + `tenants_slug_lowercase`
 *   2. reserved           `reserved_slugs`, raised as P0091
 *   3. retention window   `tenant_slug_history`, P0092 (exact) / P0093 (fold)
 *   4. exact unique       `tenants_slug_unique`, 23505
 *   5. fold unique        `tenants_slug_fold_unique`, 23505
 *
 * Steps 1 and 2 are `checkSlugShape()` — the same function the resolver
 * and the operator console use, not a second reading of the same rules.
 * Steps 3 to 5 are the same predicates the trigger and the two indexes
 * evaluate.
 *
 * ⚠️ THIS HAS ALREADY GONE WRONG ONCE IN THIS PRODUCT, AND NOT SUBTLY.
 *    `lib/tenant.ts` and `server/platform/provisioning.ts` each carried
 *    their own reserved list and their own minimum length, disagreeing by
 *    eight names in each direction and by two characters. Provisioning
 *    minted names the resolver then refused to resolve, and the customer's
 *    front door was dead while every log said success. An availability
 *    check written from a different mental model than the insert is blind
 *    to precisely the mistakes the insert makes — it says yes to the
 *    things the database will refuse, and no to nothing at all.
 *
 * Returns the first refusal, or `null` when nothing here objects.
 */
async function firstRefusal(tx: Tx, slug: string, fold: string): Promise<SlugRejection | null> {
  /* ---- 3. released within the retention window ------------------- */
  /**
   * ⚠️ EXACT AND FOLDED IN ONE QUERY, DELIBERATELY. The trigger raises
   *    two distinct SQLSTATEs for them (P0092, P0093) because staff
   *    reading a console want to know which; both map to the SAME
   *    `recently_released` public message, and the public form has
   *    nothing to do with the difference. One round trip, one answer.
   *
   * 🔴 NO `tenant_id IS DISTINCT FROM` CLAUSE, unlike the trigger. The
   *    trigger exempts a tenant re-claiming its own released slug. The
   *    caller here is ANONYMOUS and owns nothing, so the exemption cannot
   *    apply and adding it would report free a name this caller cannot
   *    have. A signed-in RENAME needs its own check that passes the
   *    tenant id; it must not reuse this one.
   */
  const released = await tx.execute(sql`
    SELECT 1
      FROM public.tenant_slug_history
     WHERE released_at IS NOT NULL
       AND released_at > now() - make_interval(days => ${RETENTION_DAYS})
       AND (slug = ${slug} OR slug_fold = ${fold})
     LIMIT 1
  `);
  if (rowsOf(released).length > 0) return rejection("recently_released");

  /* ---- 4. exact unique ------------------------------------------- */
  /**
   * 🔴 NO `deleted_at IS NULL` FILTER, AND IT WOULD BE A BUG TO ADD ONE.
   *    `tenants_slug_unique` indexes every row in the table, soft-deleted
   *    or not, so a soft-deleted workspace still holds its slug. Filtering
   *    here would report "available" for a name the INSERT then refuses
   *    with 23505 — the check disagreeing with the index it is supposed
   *    to be predicting, which is the one thing this file must not do.
   */
  const exact = await tx.execute(sql`
    SELECT 1 FROM public.tenants WHERE slug = ${slug} LIMIT 1
  `);
  if (rowsOf(exact).length > 0) return rejection("taken");

  /* ---- 5. fold unique -------------------------------------------- */
  /**
   * ⚠️ `slug_fold` IS A STORED GENERATED COLUMN (0091 SECTION 3), NOT
   *    SOMETHING THE APPLICATION WRITES. We compare against it using
   *    `foldSlug()`'s output, so this check is only as correct as those
   *    two implementations agreeing — which is why `foldSlug()` carries
   *    the byte-for-byte warning it does, and why the first version of
   *    the migration mapping `1` to `l` instead of `i` let `zedbui1ders`
   *    walk straight past the index.
   */
  const folded = await tx.execute(sql`
    SELECT 1 FROM public.tenants WHERE slug_fold = ${fold} LIMIT 1
  `);
  if (rowsOf(folded).length > 0) return rejection("too_similar");

  return null;
}

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ EVERY SUGGESTION IS CHECKED AGAINST THE DATABASE BEFORE IT IS
 *    OFFERED. A SUGGESTION THAT IS ITSELF TAKEN IS WORSE THAN NONE.
 * ══════════════════════════════════════════════════════════════════════
 * `suggestSlugs()` returns CANDIDATES — shape-valid, non-reserved, and
 * entirely ignorant of what exists. Offering them unchecked teaches the
 * user that this form's answers are unreliable, on the one screen where
 * they most need to believe it: they click the suggestion we made, and we
 * refuse it.
 *
 * One query covers all three remaining checks for the whole candidate
 * list, rather than three per candidate.
 *
 * ⚠️ CANDIDATES ARE ALSO DEDUPLICATED AGAINST EACH OTHER BY FOLD. Two
 *    suggestions that fold together cannot both be claimed — the second
 *    would hit `tenants_slug_fold_unique` a minute after the user took
 *    the first — so offering both is the same broken promise one step
 *    later.
 *
 * Capped at 3: a list of eight near-identical names is a decision, not a
 * help.
 */
/**
 * ⚠️ EXPORTED, NOT COPIED — Brief A. `server/actions/claim.ts` refuses a
 *    claim too and needs the same answer. A second implementation would be
 *    the two-reserved-word-lists incident in a new shape: one copy gets the
 *    fold-deduplication fix and the other keeps offering a name that is
 *    already spoken for.
 *
 * ⚠️ THIS FILE IS `_availability.ts`, NOT `route.ts`. The Next.js rule that
 *    a route module may export only HTTP verbs does not apply here, which is
 *    precisely why the logic was put in this file in the first place, and
 *    `scripts/check-route-exports.mjs` is the gate that keeps it that way.
 */
export async function verifiedSuggestions(tx: Tx, raw: string): Promise<string[]> {
  const candidates = suggestSlugs(raw, 6);
  if (candidates.length === 0) return [];

  const folds = new Map(candidates.map((c) => [c, foldSlug(c)]));
  const slugList = sql.join(
    candidates.map((c) => sql`${c}`),
    sql`, `,
  );
  const foldList = sql.join(
    candidates.map((c) => sql`${folds.get(c)!}`),
    sql`, `,
  );

  const taken = await tx.execute(sql`
      SELECT slug, slug_fold
        FROM public.tenants
       WHERE slug IN (${slugList}) OR slug_fold IN (${foldList})
    UNION ALL
      SELECT slug, slug_fold
        FROM public.tenant_slug_history
       WHERE released_at IS NOT NULL
         AND released_at > now() - make_interval(days => ${RETENTION_DAYS})
         AND (slug IN (${slugList}) OR slug_fold IN (${foldList}))
  `);

  const takenSlugs = new Set<string>();
  const takenFolds = new Set<string>();
  for (const row of rowsOf(taken)) {
    if (typeof row.slug === "string") takenSlugs.add(row.slug);
    if (typeof row.slug_fold === "string") takenFolds.add(row.slug_fold);
  }

  const offered: string[] = [];
  const offeredFolds = new Set<string>();
  for (const candidate of candidates) {
    if (offered.length >= 3) break;
    const fold = folds.get(candidate)!;
    if (takenSlugs.has(candidate) || takenFolds.has(fold)) continue;
    if (offeredFolds.has(fold)) continue;
    offered.push(candidate);
    offeredFolds.add(fold);
  }
  return offered;
}

/* ------------------------------------------------------------------ */
/* THE HANDLER                                                         */
/* ------------------------------------------------------------------ */

export async function checkSlugAvailability(request: Request): Promise<NextResponse> {
  /* ---- 0. Rate limit, BEFORE the body is read -------------------- */
  /**
   * ⚠️ BOTH WINDOWS ARE CHECKED IN PARALLEL AND BOTH ARE CONSUMED. The
   *    sequential alternative — refuse on the minute window without
   *    touching the hour window — sounds tidier and quietly means a
   *    caller who stays permanently over the minute limit never
   *    accumulates an hourly count at all.
   *
   * ⚠️ `checkEdgeLimit` NEVER THROWS. On an internal failure it allows
   *    and marks the decision degraded, which is the documented and
   *    deliberate direction: a broken limiter must not turn into a 500 on
   *    every request to the route it guards.
   */
  const identity: EdgeIdentity = { kind: "anonymous", ip: sourceKey(request) };
  const [minute, hour] = await Promise.all([
    checkEdgeLimit({ surface: "api", identity, budget: PER_MINUTE }),
    checkEdgeLimit({ surface: "api", identity, budget: PER_HOUR }),
  ]);

  if (!minute.allowed || !hour.allowed) {
    const refused = minute.allowed ? hour : minute;
    /**
     * ⚠️ `Retry-After` AND NOTHING ELSE. `edgeLimitHeaders()` also
     *    publishes the exact limit, the exact remaining budget and the
     *    tier — useful to an authenticated caller reading their own
     *    numbers, and a free calibration API for an anonymous one, who
     *    stops probing for the threshold and simply reads it. The module
     *    says so at `edgeLimitHeaders`; this is that rule being obeyed
     *    rather than restated.
     *
     * The body is `rateLimitBody()` — three words, no policy, no counts.
     */
    return json(rateLimitBody(), edgeLimitStatus(refused), {
      "retry-after": String(Math.max(1, refused.retryAfterSeconds)),
    });
  }

  /* ---- 1. Read and validate the body ----------------------------- */
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return json({ error: "Body too large." }, 413);
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return json({ error: "Malformed request." }, 400);
  }

  // Measured in BYTES. `.length` counts UTF-16 code units, so a body of
  // astral-plane characters is up to 4x the bytes its length suggests and
  // would slip a cap built on it.
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
    return json({ error: "Body too large." }, 413);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return json({ error: "Malformed request." }, 400);
  }

  const parsed = bodySchema.safeParse(parsedJson);
  if (!parsed.success) {
    /**
     * ⚠️ `parsed.error` IS NEVER RETURNED AND NEVER LOGGED IN FULL. A Zod
     *    issue embeds the offending VALUE, so echoing it puts whatever an
     *    anonymous caller sent into our response body and our logs.
     */
    return json(refuse(rejection("empty")), 400);
  }

  /**
   * ⚠️ TRIM AND LOWERCASE BEFORE ANYTHING ELSE, exactly as `slugSchema`
   *    does. `checkSlugShape()` normalises internally to DECIDE, but the
   *    value we then query with is ours — and `tenants_slug_lowercase`
   *    means a query for `Acme` would find nothing and report a taken
   *    name free.
   */
  const slug = parsed.data.slug.trim().toLowerCase();

  /* ---- 2. Shape and reserved (steps 1 and 2) --------------------- */
  const shapeRefusal = checkSlugShape(slug);

  if (shapeRefusal && shapeRefusal.code !== "reserved") {
    /**
     * ⭐ NO SUGGESTIONS AND NO DATABASE WORK FOR A SHAPE FAILURE, and
     *    both halves are deliberate. The user is mid-keystroke — "ac" is
     *    not a rejected name, it is an unfinished one — and a list of
     *    alternatives under a half-typed word is noise. It also means a
     *    caller sending garbage cannot spend our database on it: the
     *    cheap pure check refuses first.
     */
    return json(refuse(shapeRefusal), 200);
  }

  /* ---- 3-5. The database, in the database's own order ------------ */
  const fold = foldSlug(slug);

  try {
    /**
     * 🔴 `withPlatformScope`, NOT `withTenant`. There is no tenant: the
     *    caller is anonymous and is asking a question whose answer spans
     *    every workspace in the product. `withTenant` needs a tenant id
     *    we do not have, and a tenant-scoped read would see nothing and
     *    cheerfully report every taken name as free — RLS failing CLOSED
     *    turned into an availability check failing OPEN.
     *
     * ⚠️ READ-ONLY BY CONSTRUCTION. The platform marker appears in every
     *    policy's USING clause and in no policy's WITH CHECK clause, so
     *    nothing reached from here can write across tenants even by
     *    mistake.
     */
    const body = await withPlatformScope(
      "public slug availability check: an anonymous signup asks whether one slug is " +
        "free, which requires reading tenants and tenant_slug_history across every " +
        "workspace because the caller has no tenant of their own yet",
      async (tx): Promise<SlugAvailabilityResponse> => {
        const dbRefusal = shapeRefusal ?? (await firstRefusal(tx, slug, fold));
        if (!dbRefusal) return { available: true };
        return refuse(dbRefusal, await verifiedSuggestions(tx, slug));
      },
    );

    return json(body, 200);
  } catch (err) {
    /**
     * ══════════════════════════════════════════════════════════════
     * 🔴 AN UNANSWERABLE QUESTION IS NOT A YES.
     * ══════════════════════════════════════════════════════════════
     * The tempting failure path returns `{ available: true }` so the
     * signup button stays enabled during a database blip. That teaches
     * the form to say yes precisely when it knows least, and the user
     * discovers the truth after filling in everything else.
     *
     * 503, `available: false`, and NO `reason` — the absence of a code is
     * how "we could not check" stays distinguishable from "we checked and
     * the answer is no". The claim path is unaffected: it re-checks
     * inside its own transaction regardless of what this said.
     */
    console.error(
      "[slug-available] availability check failed:",
      err instanceof Error ? err.message : String(err),
    );
    return json({ available: false }, 503, { "retry-after": "2" });
  }
}
