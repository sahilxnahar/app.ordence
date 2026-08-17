/**
 * Ordence — The released-hostname resolver (301, and nothing else)
 * Version: v1.57.0-alpha
 * Runtime: Node — this is the half of the decision that needs a database.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS ANSWERS
 * ══════════════════════════════════════════════════════════════════════════
 * A workspace renamed. `old.ordence.com` is still in every bookmark, every
 * emailed invoice link, every WhatsApp message a site engineer forwarded,
 * and permanently in the public Certificate Transparency log. For 365 days
 * `tenant_slug_history` retains that label so nobody else can take it, and
 * a request arriving on it must be answered:
 *
 *      301 → the same path on the workspace's CURRENT host.
 *
 * 🔴 A REDIRECT AND NOTHING ELSE. Not a rewrite, not a fallback render, not
 *    a "best effort" resolve that serves the workspace under whichever name
 *    the visitor happened to type. The old label may since have been
 *    re-pointed — a different company may now hold it, or be about to — and
 *    serving data under it is a cross-tenant leak wearing a friendly face.
 *    That is why the live-tenant check below runs FIRST and wins.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⭐⭐ WHY THE LOOKUP IS HERE AND NOT IN `middleware.ts` — THE DECISION
 * ══════════════════════════════════════════════════════════════════════════
 * Middleware runs in the Edge Runtime on EVERY request. It may not open a
 * database connection: `pg`, Drizzle and `@neondatabase/serverless` are all
 * banned from that bundle, and even if one worked, a connection per request
 * on the hot path that decides which tenant a hostname belongs to is a cost
 * every customer pays so that a handful of renamed workspaces can redirect.
 *
 * Two designs were weighed.
 *
 *   ① AN EDGE-CACHED LOOKUP. Middleware holds a TTL map of released labels
 *      and refreshes it with a subrequest. REJECTED. It puts an `await
 *      fetch` on the critical path of every cold isolate, and it forces a
 *      fail-open/fail-closed decision on the lookup itself: fail open and a
 *      released host serves under the old name during any blip, fail closed
 *      and one slow query takes every tenant hostname offline. Both answers
 *      are worse than the problem.
 *
 *   ② THIS. Middleware stays pure string logic and REWRITES to this route
 *      at the two exits where it was already going to refuse the request —
 *      no Clerk session, or a session whose organisation does not match the
 *      host. This route then does the one indexed lookup and either issues
 *      the 301 or reproduces, exactly, the answer middleware would have
 *      given. CHOSEN, and it is the option the task prefers.
 *
 * ⭐ WHY OPTION ② IS FREE ON THE HOT PATH. A signed-in person working
 *    inside their own workspace never reaches those two exits, so they
 *    never reach this route. The requests that DO reach it were already
 *    going to be a redirect or a 401 — a round trip that ends in a
 *    `Location` header, not a rendered page.
 *
 * ⚠️ AND WHY THE REWRITE CANNOT SIMPLY WRAP EVERY REQUEST. A
 *    `NextResponse.rewrite` is TERMINAL: whatever it points at produces the
 *    response. There is no "check, then continue". So a rewrite can only be
 *    used where middleware was already terminating the request, which is
 *    precisely the two exits chosen above. This is a structural property of
 *    the framework, not a preference.
 *
 * ⚠️ THE RESIDUAL GAP, STATED RATHER THAN HIDDEN. Routes on `isPublicRoute`
 *    — `/`, `/pricing`, `/legal`, `/portal/...`, the webhook and health
 *    endpoints — are forwarded before the session is read, so a request to
 *    one of them on a released host is served rather than redirected. That
 *    is not a data leak and the reason is worth writing down: NOTHING in
 *    this product resolves a tenant from the hostname. `x-tenant-slug` has
 *    no reader anywhere in `app/` or `server/`; the tenant comes from the
 *    Clerk organisation, and the portal and MCP surfaces carry their own
 *    bearer credential and return the same bytes on every host. So the old
 *    name serves marketing HTML and a sign-in page, and no customer record
 *    of any kind. Closing even that gap requires design ①, and its cost is
 *    argued above.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ THE LABEL COMES FROM THE `Host` HEADER, NEVER FROM A QUERY PARAMETER
 * ══════════════════════════════════════════════════════════════════════════
 * This route is reachable directly, by URL, like any other. If the label
 * were a parameter, anyone could ask "where did `acme` move to?" and read
 * the released→current mapping for every workspace out of a public
 * endpoint. Deriving it from the Host header means the caller can only ask
 * about a hostname they were already able to address — which is the same
 * information the CT log publishes anyway.
 *
 * The two parameters that ARE read (`path`, `fallback`) can only change
 * where a REFUSED request is sent on the same host, and both are validated
 * below as if they were hostile, because from this route's point of view
 * they are.
 */

import { NextResponse, type NextRequest } from "next/server";
import { and, desc, eq, gt, isNotNull } from "drizzle-orm";

import { withPlatformScope } from "@/db";
import { tenants } from "@/db/schema";
import { tenantSlugHistory } from "@/db/schema/slugs";
import { resolveTenantFromHost, tenantUrl } from "@/lib/tenant";
import { applySecurityHeaders } from "@/lib/edge/security-headers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* ------------------------------------------------------------------ */
/* ENVIRONMENT                                                         */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ READ THROUGH A VARIABLE, THE SAME WAY `middleware.ts` DOES. Next.js
 * textually substitutes a literal `process.env.NEXT_PUBLIC_FOO` at BUILD
 * time, and on Cloudflare the build machine has none of these — the literal
 * `undefined` would be frozen into the output and every rename would
 * redirect to `https://acme.undefined/`.
 */
function readRuntimeEnv(name: string): string | undefined {
  try {
    const bag = process.env as unknown as Record<string, string | undefined>;
    const value = bag?.[name];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

const rootDomain = () => readRuntimeEnv("NEXT_PUBLIC_ROOT_DOMAIN") ?? "localhost:3000";
const zoneDomain = () => readRuntimeEnv("NEXT_PUBLIC_ZONE_DOMAIN");
const platformHost = () => {
  const explicit = readRuntimeEnv("PLATFORM_HOST");
  if (explicit) return explicit;
  const zone = zoneDomain();
  return zone ? `admin.${zone}` : undefined;
};

/* ------------------------------------------------------------------ */
/* THE CACHE                                                           */
/* ------------------------------------------------------------------ */

type Verdict =
  | { kind: "live" }
  | { kind: "moved"; currentSlug: string }
  | { kind: "unknown" };

/**
 * ⭐ ONE QUERY PER LABEL PER MINUTE PER INSTANCE, NOT ONE PER REQUEST.
 *
 * ⚠️ THIS IS A COST CONTROL, NOT A CORRECTNESS MECHANISM, AND THE
 *    DIFFERENCE DECIDES THE TTL. Everything this route can answer is a
 *    refusal or a redirect, so a stale answer costs at most sixty seconds
 *    of a browser being sent to the wrong one of two hosts we own. Nothing
 *    is authorised from it and nothing is written.
 *
 * ⚠️ WITHOUT IT, THIS ROUTE IS AN UNAUTHENTICATED DATABASE AMPLIFIER. It
 *    is reached by every session-less request to a tenant hostname, and
 *    the per-tenant edge limiter cannot count those — it keys on the
 *    organisation, which is exactly what a caller with no session does not
 *    have. A flood of `GET acme.ordence.com/dashboard` would otherwise be
 *    one Neon round trip each.
 *
 * Per-instance and in-memory on purpose: no Redis dependency on a path
 * whose failure mode would be "tenant hostnames stop redirecting".
 */
const VERDICT_TTL_MS = 60_000;
const verdictCache = new Map<string, { at: number; verdict: Verdict }>();

async function verdictFor(label: string): Promise<Verdict> {
  const hit = verdictCache.get(label);
  if (hit && Date.now() - hit.at < VERDICT_TTL_MS) return hit.verdict;

  const verdict = await lookup(label);

  /* Bounded, so a hostile stream of made-up labels cannot grow it without
   * limit. Oldest-first eviction is enough: this is a cache, not a store. */
  if (verdictCache.size > 500) {
    const oldest = verdictCache.keys().next();
    if (!oldest.done) verdictCache.delete(oldest.value);
  }
  verdictCache.set(label, { at: Date.now(), verdict });
  return verdict;
}

/**
 * ⚠️ `withPlatformScope`, BECAUSE THERE IS NO TENANT TO SCOPE TO. That is
 * the whole shape of the question: the caller has no session, and the
 * workspace being asked about is identified only by a label it no longer
 * holds. `tenant_slug_history`'s read policy is
 * `tenant_id = app_current_tenant_id() OR app_platform_scope()`, so a
 * tenant-scoped handle would see nothing and this route would answer
 * "unknown" for every rename — a refusal silently becoming a permission,
 * which is the exact failure 0091's SECURITY DEFINER guard exists to avoid.
 *
 * ⭐ THE LIVE-TENANT CHECK RUNS FIRST AND WINS. If some workspace holds
 *    this label TODAY, the host is theirs and there is nothing to redirect,
 *    even when an older tenant also has a released row for it. Getting this
 *    order wrong would send a live workspace's own traffic to whoever used
 *    to own its name.
 */
async function lookup(label: string): Promise<Verdict> {
  return withPlatformScope(
    `Resolve whether the hostname label "${label}" is a released tenant slug, to answer 301 or 404.`,
    async (tx) => {
      const [live] = await tx
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.slug, label))
        .limit(1);
      if (live) return { kind: "live" } as const;

      /*
       * ⚠️ THE 365-DAY WINDOW IS EXPRESSED THE SAME WAY THE TRIGGER
       * EXPRESSES IT. `ordence_guard_tenant_slug()` refuses a re-claim while
       * `released_at > now() - interval '365 days'`; outside that window the
       * label is genuinely free, so redirecting for it would send traffic
       * to a workspace that no longer has any claim on the name.
       */
      const cutoff = new Date(Date.now() - 365 * 86_400_000);

      const [moved] = await tx
        .select({ currentSlug: tenants.slug })
        .from(tenantSlugHistory)
        .innerJoin(tenants, eq(tenants.id, tenantSlugHistory.tenantId))
        .where(
          and(
            eq(tenantSlugHistory.slug, label),
            isNotNull(tenantSlugHistory.releasedAt),
            gt(tenantSlugHistory.releasedAt, cutoff),
          ),
        )
        .orderBy(desc(tenantSlugHistory.releasedAt))
        .limit(1);

      if (!moved) return { kind: "unknown" } as const;
      /* Defensive: a tenant that re-claimed its own old label would make
       * the redirect point at itself. The live check above already covers
       * it; this makes the loop impossible rather than merely unlikely. */
      if (moved.currentSlug === label) return { kind: "live" } as const;
      return { kind: "moved", currentSlug: moved.currentSlug } as const;
    },
  );
}

/* ------------------------------------------------------------------ */
/* THE ANSWER                                                          */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ TREATED AS HOSTILE EVEN THOUGH MIDDLEWARE WROTE IT. This route is
 * addressable directly, so the value may equally have come from a browser.
 * It is only ever used as a PATH on a host we already decided, so the one
 * thing that must be impossible is for it to become an absolute URL or a
 * protocol-relative one — `//evil.example` is the open-redirect classic.
 */
function safePath(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/";
  if (raw.includes("\\") || /[\r\n]/.test(raw)) return "/";
  return raw.slice(0, 2048);
}

async function answer(req: NextRequest): Promise<NextResponse> {
  const path = safePath(req.nextUrl.searchParams.get("path"));
  const fallback = req.nextUrl.searchParams.get("fallback") === "access-denied"
    ? "access-denied"
    : "sign-in";
  const isApi = path.startsWith("/api/");

  const locator = resolveTenantFromHost(req.headers.get("host"), rootDomain(), {
    zoneDomain: zoneDomain(),
    platformHost: platformHost(),
  });

  /*
   * ⭐ ONLY A TENANT SUBDOMAIN CAN BE A RELEASED SLUG, BY CONSTRUCTION.
   *
   * `resolveTenantFromHost` classifies the platform console host FIRST and
   * the app host and `www` before any subdomain branch, so `admin.` and
   * `app.` can never arrive here as `subdomain` — and both are in
   * `RESERVED_SLUGS` besides, so `isValidSlug` would refuse them anyway.
   * Anything else reaching this route by hand gets nothing.
   */
  if (locator.kind !== "subdomain") {
    return applySecurityHeaders(new NextResponse("Not found", { status: 404 }));
  }

  let verdict: Verdict;
  try {
    verdict = await verdictFor(locator.slug);
  } catch (error) {
    /*
     * 🔴 A FAILED LOOKUP MUST NOT BECOME AN OUTAGE FOR EVERY TENANT
     *    HOSTNAME.
     *
     * This route stands in front of the sign-in redirect for every
     * session-less request on a tenant host. If a database blip here
     * returned 500, nobody could reach a sign-in page on any workspace
     * address — a total outage caused by the code that handles renamed
     * workspaces, of which there are approximately none.
     *
     * ⚠️ FAILING TO `unknown` IS NOT "FAILING OPEN". The fallback is the
     *    refusal middleware was already going to issue. The only thing lost
     *    is the courtesy 301, and the old host still serves no data.
     */
    console.error("[host-moved] lookup failed:", error);
    verdict = { kind: "unknown" };
  }

  if (verdict.kind === "moved") {
    const target = tenantUrl(verdict.currentSlug, rootDomain(), path, zoneDomain());
    /*
     * ⚠️ 301 AND NOT 308, DELIBERATELY. This is a permanent move and we
     * WANT intermediaries and browsers to cache it — that is the point of
     * a workspace address change. 301's historical method-rewriting is
     * acceptable here precisely because no data may be posted to the old
     * name: a POST that arrives on a released host is a client using a
     * stale address, and turning it into a GET of the new one is a safer
     * outcome than replaying a write against a workspace under a name it
     * no longer holds.
     *
     * `cache-control` is set explicitly rather than left to the framework:
     * a permanent redirect that is revalidated on every navigation is a
     * permanent redirect in name only.
     */
    const res = NextResponse.redirect(target, 301);
    res.headers.set("cache-control", "public, max-age=3600");
    res.headers.set("x-ordence-locator", "released-slug");
    return applySecurityHeaders(res);
  }

  /*
   * NOT MOVED — reproduce, exactly, the answer `middleware.ts` would have
   * given had it not rewritten here. This route adds a redirect for renamed
   * workspaces; it must change nothing for anybody else.
   */
  if (isApi) {
    const [status, code, message] =
      fallback === "access-denied"
        ? ([403, "tenant_mismatch", "Session does not belong to this workspace."] as const)
        : ([401, "unauthenticated", "Sign-in required."] as const);
    return applySecurityHeaders(
      new NextResponse(JSON.stringify({ error: { code, message } }), {
        status,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      }),
    );
  }

  if (fallback === "access-denied") {
    return applySecurityHeaders(
      NextResponse.redirect(new URL("/access-denied", req.url)),
    );
  }

  const signIn = new URL("/sign-in", req.url);
  signIn.searchParams.set("redirect_url", path);
  return applySecurityHeaders(NextResponse.redirect(signIn));
}

/*
 * ⚠️ EVERY VERB, BECAUSE A REWRITE PRESERVES THE ORIGINAL METHOD. A person
 * whose bookmark is a form POST reaches this route as a POST, and a handler
 * that only exported GET would answer them 405 instead of moving them to
 * the address that works.
 */
export async function GET(req: NextRequest) {
  return answer(req);
}
export async function HEAD(req: NextRequest) {
  return answer(req);
}
export async function POST(req: NextRequest) {
  return answer(req);
}
export async function PUT(req: NextRequest) {
  return answer(req);
}
export async function PATCH(req: NextRequest) {
  return answer(req);
}
export async function DELETE(req: NextRequest) {
  return answer(req);
}
