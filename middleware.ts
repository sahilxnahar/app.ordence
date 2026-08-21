/**
 * Ordence — Edge Multi-Tenant Middleware
 * Version: v0.1.0-alpha
 * Runtime: Edge (no Node APIs, no database driver)
 *
 * ORDER OF OPERATIONS — the order itself is the security control:
 *   1. Strip every client-supplied tenant header  ← prevents header spoofing
 *   2. Resolve the requested tenant from the Host header
 *   3. Let public routes through untouched
 *   4. Require an authenticated Clerk session
 *   5. Require an ACTIVE Clerk Organization, and require that it matches the host
 *   6. Inject server-trusted tenant headers
 *
 * Step 5 is what stops a legitimately logged-in user of Tenant A from simply
 * typing tenant-b.app.ordence.com into the address bar.
 */

import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse, type NextRequest } from "next/server";
import {
  TENANT_HEADERS,
  SPOOFABLE_HEADERS,
  resolveTenantFromHost,
  encodeTenantHostClaim,
  generateRequestId,
} from "@/lib/tenant";
import { buildCsp, cspHeaderName, generateNonce } from "@/lib/security/csp";
import {
  checkEdgeLimit,
  edgeLimitHeaders,
  edgeLimitBody,
  edgeLimitStatus,
  type EdgeLimitDecision,
} from "@/lib/edge/limits";
import { isRateLimitExempt } from "@/lib/edge/budgets";
import { checkDeclaredBodySize, bodyTooLargeBody } from "@/lib/edge/body-limit";
import { applySecurityHeaders } from "@/lib/edge/security-headers";
import { decidePreflight } from "@/lib/edge/cors";
import { verifyCsrf } from "@/lib/security/csrf";
import {
  evaluateSession,
  readFactorEvidence,
  readPolicyFromClaims,
  readSessionExpiryMs,
} from "@/lib/security/session-policy";

/* ------------------------------------------------------------------ */
/* RUNTIME ENVIRONMENT                                                 */
/* ------------------------------------------------------------------ */

/**
 * Read an environment variable WITHOUT letting the bundler inline it.
 *
 * ⚠️ Do not "tidy" this into `process.env.SOMETHING`. The indirection is
 * the entire point.
 *
 * Next.js textually replaces every literal `process.env.NEXT_PUBLIC_FOO`
 * with whatever that variable held AT BUILD TIME — including inside code
 * imported from node_modules. On Cloudflare the build runs on one machine
 * and the Worker runs on another, so a variable configured on the Worker
 * is simply absent during the build and the literal `undefined` is frozen
 * into the output.
 *
 * Looking the name up through a variable defeats that substitution, so the
 * value is read when the request arrives.
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

function rootDomain(): string {
  return readRuntimeEnv("NEXT_PUBLIC_ROOT_DOMAIN") ?? "localhost:3000";
}

/**
 * ⭐ THE ZONE TENANT SUBDOMAINS HANG OFF — `ordence.com`.
 *
 * ⚠️ DISTINCT FROM `rootDomain()`, WHICH IS THE APP HOST
 * (`app.ordence.com`). One variable was doing both jobs, which forced
 * tenants to `acme.app.ordence.com`. With the zone supplied separately,
 * `acme.ordence.com` resolves as well and the app host stays canonical.
 *
 * ⚠️ RETURNS undefined WHEN UNSET, and the resolver then behaves exactly
 * as it did before. An unset variable must never change how an existing
 * deployment routes — that is how a config change becomes an outage.
 */
function zoneDomain(): string | undefined {
  return readRuntimeEnv("NEXT_PUBLIC_ZONE_DOMAIN");
}

/** The staff console host. Defaults to `admin.<zone>`. */
function platformHost(): string | undefined {
  const explicit = readRuntimeEnv("PLATFORM_HOST");
  if (explicit) return explicit;
  const zone = zoneDomain();
  return zone ? `admin.${zone}` : undefined;
}

/**
 * ⚠️ THE KEYS ARE PASSED TO CLERK EXPLICITLY. THIS IS NOT OPTIONAL HERE.
 *
 * Left to itself, `clerkMiddleware()` reads
 * `process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` from inside Clerk's own
 * bundled code — a literal that Next.js already replaced at build time with
 * `undefined`, because the build machine has no Clerk keys. Clerk then
 * throws "Missing publishableKey" on EVERY request, before routing happens.
 *
 * That is why `/api/health` — a route with no database, no Clerk usage and
 * a hard-coded JSON body — was returning 500 alongside everything else.
 * Nothing was reaching it.
 */
function clerkKeys() {
  return {
    publishableKey:
      readRuntimeEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY") ??
      readRuntimeEnv("CLERK_PUBLISHABLE_KEY"),
    secretKey: readRuntimeEnv("CLERK_SECRET_KEY"),
  };
}

/** Routes reachable without a session. Everything else is deny-by-default. */
const isPublicRoute = createRouteMatcher([
  "/",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/api/health",
  /**
   * ⭐ The readiness probe is public, and it has to be.
   *
   * An uptime monitor has no session and never will. Requiring auth here
   * would mean the probe returns 401 during an outage AND during perfect
   * health — indistinguishable, and therefore useless.
   *
   * ⚠️ IT IS SAFE TO EXPOSE BECAUSE OF WHAT IT WITHHOLDS: a SQLSTATE code
   * and a duration, never a driver message, a host or a user. See the
   * note in the route.
   */
  "/api/ready",
  "/api/webhooks(.*)",
  /**
   * ⭐ WAVE 2E. The tenant logo, resolved from the hostname. It is on this
   * list for the same reason `/sign-in` is: it is rendered ON the sign-in
   * page, before any session exists.
   *
   * ⚠️ WHAT IT MAY SERVE IS ONE OBJECT PER TENANT , the key named by that
   * tenant's own `branding.logoKey`, re-checked against their storage
   * prefix before a byte is fetched. There is no key parameter and no
   * listing. A logo is public by purpose: it is already on that customer's
   * invoices and their login page.
   */
  "/api/branding/logo",
  // ══════════════════════════════════════════════════════════════
  // BACKGROUND WORK (v0.21.0 — Cloudflare)
  //
  // Cloudflare's Cron Trigger and Queue consumer call this route with
  // no browser cookie, so a Clerk gate here would refuse every piece
  // of background work in the system.
  //
  // "Public" does NOT mean unauthenticated. `/api/workers` authenticates
  // every request itself against WORKER_API_SECRET (constant-time), a
  // QStash signature, or the Vercel cron secret — and returns 503 if
  // none of the three is configured. Before this entry existed, the
  // Clerk gate let in every authenticated user of every tenant and the
  // route refused them anyway; the shared secret was always the real
  // control. Read the header of app/api/workers/route.ts.
  // ══════════════════════════════════════════════════════════════
  "/api/workers",
  // Same authentication model — bearer secret, no Clerk cookie.
  "/api/workers/ai-monitors",
  // ══════════════════════════════════════════════════════════════
  // ⭐⭐ THE ISOLATION CANARY (Batch 45)
  //
  // A scheduler has no browser cookie. Without this entry the canary
  // is an orphan: present, correct, and refused with 401 on every run
  // — which is the one failure mode this repository has shipped most
  // often, and the one a probe can least afford, because a probe that
  // never runs is indistinguishable from a probe that always passes.
  //
  // "Public" does NOT mean unauthenticated. `/api/cron/canary`
  // compares every request against CRON_SECRET in constant time and
  // returns 503 when no secret is configured, so an unauthenticated
  // caller never learns a tenant id. Read the header of
  // app/api/cron/canary/route.ts.
  // ══════════════════════════════════════════════════════════════
  "/api/cron/canary",
  // ══════════════════════════════════════════════════════════════
  // TELEMETRY INGEST (Phase 19)
  //
  // Deliberately public. Core Web Vitals fire during and before page
  // hydration, often before a session is established — requiring one
  // would silently zero the highest-volume signal in the system.
  //
  // "Public" does not mean unbounded: the route caps the body size,
  // validates strictly with Zod, echoes nothing back, and writes a
  // NULL-tenant row when no session is present (the same pattern as
  // orphan payment events). A tenant session writes tenant-scoped rows
  // under RLS as normal.
  // ══════════════════════════════════════════════════════════════
  "/api/telemetry",
  // ══════════════════════════════════════════════════════════════
  // PUBLIC SLUG AVAILABILITY (v1.57.0-alpha)
  //
  // Deliberately public, and it has to be: the caller is a person part
  // way through self-serve signup who has no Clerk session and, by
  // definition, no organisation yet. A gate here would make the field
  // that tells them their workspace address is free answer 401 for
  // every single person who needs it.
  //
  // ⚠️ THE ONE PATH, NOT `/api/public(.*)`. A wildcard would make every
  //    route somebody adds under `/api/public` unauthenticated by
  //    default, and "it was public because of where I put the file" is
  //    not a decision anyone made. Each entry earns its own line, the
  //    same way `/api/cron/canary` does.
  //
  // "Public" does not mean unbounded: the route rate-limits per source
  // network before reading the body (10/minute, 60/hour), caps the
  // body, answers only `available` plus a public sentence that never
  // names a conflicting workspace, and can neither write nor reserve
  // anything. Read the header of app/api/public/slug-available/route.ts.
  // ══════════════════════════════════════════════════════════════
  "/api/public/slug-available",
  // ══════════════════════════════════════════════════════════════
  // THE EXTERNAL CLIENT PORTAL (Phase 9)
  //
  // Deliberately public. A counterparty reviewing a contract has no
  // Clerk account and no organisation — requiring a session here would
  // send them to a sign-in page they can never get past, which is the
  // dead end this whole phase exists to remove.
  //
  // "Public" means "no Clerk session required". It does NOT mean
  // unauthenticated: the URL carries a 256-bit token that the page
  // resolves, checks for revocation and expiry, and uses to pin every
  // subsequent query to one tenant. The credential moved from a cookie
  // to the path; it did not disappear.
  // ══════════════════════════════════════════════════════════════
  "/portal(.*)",
  "/pricing",
  "/legal(.*)",
  // ══════════════════════════════════════════════════════════════
  // DIAGNOSTICS
  //
  // Reports whether each required setting is PRESENT. Never its value.
  // Public because the failure it exists to diagnose is one where nothing
  // authenticates at all — a diagnostic behind the broken gate is useless.
  // ══════════════════════════════════════════════════════════════
  "/api/diag",
  /**
   * ⭐ MCP — v0.74.0-alpha.
   *
   * ⚠️ "PUBLIC" HERE MEANS "NO BROWSER SESSION REQUIRED", NOT
   *    "UNAUTHENTICATED".
   *
   * An MCP client has no cookie jar and is never redirected through a
   * sign-in page, so `clerkMiddleware` cannot authenticate it. The route
   * authenticates ITSELF: every request must carry a bearer token that
   * resolves, in the database, to a live, unrevoked, unexpired grant.
   * Without one it answers 401 and touches nothing.
   *
   * The tenant is derived FROM THE TOKEN. A client cannot assert it —
   * which is the same rule that makes step 1 above strip six headers.
   */
  "/api/mcp",
]);

/** Routes that require platform-staff privileges, not just any session. */
const isPlatformAdminRoute = createRouteMatcher(["/platform(.*)"]);

/**
 * ⭐⭐⭐ SESSION COOKIES — DELEGATED TO CLERK, STATED ON PURPOSE — Wave 7
 *
 * This product sets NO cookies of its own. Every session cookie on any
 * Ordence response is Clerk's — `__session`, `__clerk_db_jwt` and the
 * handshake pair — and the Clerk Next.js SDK already sets them
 * `Secure`, `HttpOnly` and `SameSite=Lax` by default, so the flags a
 * cookie audit looks for are on every session cookie today.
 *
 * ⚠️ DELEGATION IS NOT AN EXCUSE. `CLERK_SESSION_COOKIE_SECURE=true`
 * is the env flag that pins Secure even when the SDK's default would
 * relax (some SDK versions read the request protocol and go `Secure`
 * only under TLS; a reverse proxy terminating TLS can look like plain
 * HTTP). Set it in production as a belt with the braces, and the
 * deploy file repeats it. If this app ever issues its own cookie —
 * the portal token moved to URLs on purpose so that would be a
 * deliberate decision with its own flags — that is the one place to
 * add flags, and the cookie banner batch (Wave 8) is where any new
 * cookie should first be argued for.
 */
export default clerkMiddleware(
  async (auth, req: NextRequest) => {
    try {
      const res = await run(auth, req);

      /* ── ⭐ WHAT THE MIDDLEWARE DECIDED, ON EVERY RESPONSE — v0.51.0 ──
       *
       * `admin.ordence.com` returned Next.js's own 404. That is a very
       * specific piece of evidence: a 404 rendered by the APPLICATION
       * means the request reached the Worker, ran this middleware, and
       * was then handed to a route that does not exist. Cloudflare
       * failing to route it, or DNS failing to resolve, would both look
       * completely different.
       *
       * So the host either was not recognised as the platform console, or
       * was recognised and rewritten somewhere with no page. From outside
       * those are indistinguishable, and each implies a different fix —
       * one is a missing setting, the other a missing route.
       *
       * These three headers settle it in one reload of DevTools →
       * Network → click the request → Response Headers. `x-ordence-locator`
       * says how the host was classified; the other two say what the
       * middleware could actually see when it decided.
       *
       * ⚠️ HOSTNAMES AND A ONE-WORD KIND. Nothing secret: every value here
       * is already in the URL bar or in public DNS. Deliberately not the
       * settings themselves — `/api/diag` covers those, once.
       */
      try {
        res.headers.set("x-ordence-locator", resolveTenantFromHost(
          req.headers.get("host"),
          rootDomain(),
          { zoneDomain: zoneDomain(), platformHost: platformHost() },
        ).kind);
        res.headers.set("x-ordence-platform-host", platformHost() ?? "(unset)");
        res.headers.set("x-ordence-zone", zoneDomain() ?? "(unset)");
      } catch {
        // Diagnostics must never be the reason a request fails.
      }

      return res;
    } catch (error) {
      /* ── A THROWN MIDDLEWARE IS A BLANK 500 ON EVERY URL ──────────────
       *
       * Including routes that touch neither Clerk nor the database. That
       * is how `/api/health` — a hard-coded JSON body — came back 500
       * alongside the home page: nothing was reaching it.
       *
       * With no message anywhere, "auth is misconfigured" and "the
       * database is down" look identical from outside. This makes the
       * Worker say which, at one url, and stay silent everywhere else.
       */
      const message = error instanceof Error ? error.message : String(error);
      console.error("[middleware] threw:", message);

      if (req.nextUrl.pathname === "/api/diag") {
        return applySecurityHeaders(
          new NextResponse(
            JSON.stringify(
              { ok: false, stage: "middleware", error: message, settingsPresent: presentSettings() },
              null,
              2,
            ),
            { status: 500, headers: { "content-type": "application/json" } },
          ),
        );
      }
      return applySecurityHeaders(new NextResponse("Internal Server Error", { status: 500 }));
    }
  },
  () => clerkKeys(),
);

/**
 * The shape of Clerk's `auth` argument, described structurally.
 *
 * ⚠️ Deliberately NOT `Parameters<Parameters<typeof clerkMiddleware>[0]>[0]`.
 * `clerkMiddleware` is an overloaded function, so `Parameters<>` resolves
 * against the LAST overload and collapses to `never` — which then reports
 * itself as five unrelated errors elsewhere in the file. Naming the two
 * fields actually used is both accurate and immune to Clerk's overloads
 * being reordered in a future release.
 */
type ClerkAuth = () => Promise<{
  userId: string | null;
  orgId?: string | null;
  orgSlug?: string | null;
  orgRole?: string | null;
  sessionClaims?: Record<string, unknown> | null;
}>;

/** Enforce the CSP, or only report on it? Read at request time, not build time. */
function cspEnforced(): boolean {
  return readRuntimeEnv("CSP_ENFORCE") === "true";
}

/** Optional collector for violation reports. */
function cspReportUri(): string | undefined {
  return readRuntimeEnv("CSP_REPORT_URI");
}

/**
 * ⭐ OBSERVE-ONLY MODE FOR THE CAPACITY LIMITER — Batch 31.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ A NEW LIMIT SHIPPED STRAIGHT TO ENFORCE IS A GUESS WITH A BLAST
 *    RADIUS.
 * ══════════════════════════════════════════════════════════════════════
 * The per-plan budgets in `lib/edge/budgets.ts` are reasoned, not
 * measured — nothing in this product has ever counted requests per
 * workspace, so there is no observed peak to set them against. Turning
 * them on blind means the first evidence that a number is too low is a
 * customer unable to work at month end.
 *
 * `EDGE_LIMIT_MODE=observe` counts everything, publishes the position in
 * the response headers, and refuses nothing. Run it for a week, read
 * `x-ratelimit-remaining` off real traffic, then set the numbers and
 * remove the variable.
 *
 * ⚠️ ENFORCE IS THE DEFAULT AND THE UNSET VALUE. A limiter whose safe
 * mode is the default is a limiter that is off in production the day
 * somebody forgets a variable — which is the failure this whole batch
 * exists to remove. Observe mode must be asked for, explicitly, by name.
 */
function limitsObserveOnly(): boolean {
  return readRuntimeEnv("EDGE_LIMIT_MODE") === "observe";
}

/* ------------------------------------------------------------------ */
/* PER-TENANT CAPACITY LIMITING                                        */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHY THE GATE SITS *AFTER* AUTH AND NOT BEFORE IT — Batch 31
 * ══════════════════════════════════════════════════════════════════════
 * The bucket is the WORKSPACE, because the costs this bounds — Neon
 * compute, Worker CPU, a shared connection pool — are incurred per
 * workspace and paid for by everyone else on the instance. There is no
 * workspace to key on until `auth()` has returned an organisation, so a
 * gate placed earlier would have nothing to count against except the
 * client's own hostname or headers, both of which the client chooses.
 * Keying on those makes the limit opt-in: rotate the value, get a fresh
 * budget, every request is the first request.
 *
 * The cost of the ordering is that a flood of UNAUTHENTICATED requests is
 * not counted here. That is deliberate and already covered: anonymous
 * surfaces are bounded by the IP-keyed policies in
 * `lib/security/rate-limit.ts`, which is the right key for a caller who
 * has no identity, and Clerk refuses them before any database work.
 *
 * ⚠️ THIS ADDS A NETWORK ROUND TRIP TO EVERY AUTHENTICATED REQUEST.
 * Upstash over REST from the edge is single-digit to low-tens of
 * milliseconds. It is paid deliberately: the alternative — sampling, or
 * limiting only `/api` — leaves the page and server-action traffic that
 * makes up most of the load entirely uncounted, which is the hole this
 * batch exists to close. The plan lookup is memoised in-process for a
 * minute so it is not a second round trip per request.
 */
async function edgeLimitGate(
  req: NextRequest,
  requestId: string,
  identity: Parameters<typeof checkEdgeLimit>[0]["identity"],
  surface: "app" | "api" | "platform",
): Promise<{ refusal: NextResponse | null; headers: Record<string, string> }> {
  /**
   * ⚠️ HEALTH CHECKS, WEBHOOKS AND CRON ARE NEVER COUNTED.
   *
   * Most of them are already `isPublicRoute` and never reach this
   * function. The check is repeated here anyway because "it is exempt
   * because it happens to be public" is a coincidence, and the day
   * someone makes `/api/workers` require a session, Railway's health
   * probe starts getting 429s, Railway reads that as an unhealthy
   * container, kills it, and the replacement inherits the same counter
   * out of shared Redis. That is a crash loop the deploy cannot escape,
   * caused by the rate limiter. It has happened here before.
   */
  if (isRateLimitExempt(req.nextUrl.pathname)) {
    return { refusal: null, headers: {} };
  }

  const decision: EdgeLimitDecision = await checkEdgeLimit({ surface, identity });
  const headers = edgeLimitHeaders(decision);

  if (decision.allowed) return { refusal: null, headers };

  if (limitsObserveOnly()) {
    /**
     * Counted, published, not enforced. The mode is renamed in the
     * header rather than hidden, so a response that WOULD have been
     * refused is visible in DevTools and in any log that keeps headers —
     * which is the entire value of observe mode.
     */
    return {
      refusal: null,
      headers: { ...headers, "x-ordence-limit-mode": `observe:${decision.mode}` },
    };
  }

  const status = edgeLimitStatus(decision);
  const isApiPath = req.nextUrl.pathname.startsWith("/api/");

  /**
   * ⚠️ A BROWSER NAVIGATION GETS TEXT, NOT JSON. A JSON body rendered
   * into a browser window as the response to clicking a link is a wall
   * of punctuation that tells the person nothing. They get the sentence;
   * an API client gets the machine-readable shape. Both carry
   * `Retry-After`, because that is what makes a well-behaved client back
   * off instead of hot-looping on the endpoint we are protecting.
   */
  const body = edgeLimitBody(decision);
  const refusal = isApiPath
    ? applySecurityHeaders(
        new NextResponse(JSON.stringify({ error: { ...body.error, requestId } }), {
          status,
          headers: {
            ...headers,
            "content-type": "application/json",
            "x-request-id": requestId,
            "cache-control": "no-store",
          },
        }),
      )
    : applySecurityHeaders(
        new NextResponse(body.error.message, {
          status,
          headers: {
            ...headers,
            "content-type": "text/plain; charset=utf-8",
            "x-request-id": requestId,
            "cache-control": "no-store",
          },
        }),
      );

  return { refusal, headers };
}

/* ------------------------------------------------------------------ */
/* RELEASED TENANT HOSTNAMES — 301, RESOLVED IN THE APP LAYER          */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 A RENAMED WORKSPACE LEAVES ITS OLD HOSTNAME LIVE IN THE WORLD
 * ══════════════════════════════════════════════════════════════════════
 * `old.ordence.com` stays in every bookmark, every emailed invoice link,
 * every WhatsApp message a site engineer forwarded, and permanently in
 * the public Certificate Transparency log. `tenant_slug_history` retains
 * the label for 365 days so nobody else can take it, and a request
 * arriving on it must be answered with a 301 to the same path on the
 * workspace's current host — a redirect and NOTHING else, because the old
 * name may since have been re-pointed and serving data under it is a
 * cross-tenant leak wearing a friendly face.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE DELIBERATE PART: THIS FILE DOES NOT DO THE LOOKUP
 * ══════════════════════════════════════════════════════════════════════
 * Middleware runs in the Edge Runtime on every single request. It may not
 * open a database connection, and `pg`, Drizzle and
 * `@neondatabase/serverless` are all banned from this bundle. Two designs
 * were available and the choice was made on the cost, not the taste:
 *
 *   ① AN EDGE-CACHED LOOKUP — a TTL map in the isolate, refilled by a
 *      subrequest. REJECTED: it puts an `await fetch` on the critical
 *      path of every cold isolate, and it forces a fail-open/fail-closed
 *      decision on the lookup itself. Fail open and a released host
 *      serves under the old name during any blip; fail closed and one
 *      slow query takes every tenant hostname offline. Both answers are
 *      worse than the problem being solved.
 *
 *   ② REWRITE TO AN APP-LAYER ROUTE that owns the query — CHOSEN. This
 *      file stays pure string logic and the database work happens in
 *      `app/api/internal/host-moved/route.ts`, in the Node runtime,
 *      behind a one-minute per-label cache.
 *
 * ⭐ AND IT IS FREE ON THE HOT PATH, WHICH IS WHY THE PLACEMENT MATTERS.
 *    The rewrite is issued at exactly the two exits where this middleware
 *    was ALREADY going to refuse the request — no Clerk session (step 4)
 *    and a session whose organisation does not match the host (step 7).
 *    A signed-in person working inside their own workspace never reaches
 *    either, so they never reach the route and never pay for the query.
 *    Both of those exits were already a round trip ending in a `Location`
 *    header; the route either issues a better one or reproduces the
 *    original exactly.
 *
 * ⚠️ A REWRITE IS TERMINAL — THERE IS NO "CHECK, THEN CONTINUE". That is
 *    a property of the framework and it is the reason the check cannot
 *    simply wrap every request: whatever a rewrite points at PRODUCES the
 *    response. So it may only be used where the request was already being
 *    terminated. The residual gap (public routes, which are forwarded
 *    before the session is read) is argued in the route's own header —
 *    nothing in this product resolves a tenant from the hostname, so the
 *    old name serves marketing HTML and a sign-in page and no customer
 *    record of any kind.
 *
 * ⚠️ NOTHING IN `resolveTenantFromHost` CHANGED, AND THAT IS ON PURPOSE.
 *    A released slug is shape-valid — it was a real workspace address
 *    yesterday — so it classifies as `{ kind: "subdomain" }` exactly as it
 *    always did, and no ordering in that resolver moves. `admin.` still
 *    returns `{ kind: "platform" }` from the first branch and `app.` still
 *    returns `{ kind: "root" }` from the bare-root branch; neither is
 *    `subdomain`, so neither can ever reach the rewrite below.
 */
const HOST_MOVED_ROUTE = "/api/internal/host-moved";

/**
 * Hand this request to the resolver instead of refusing it here.
 *
 * ⚠️ THE LABEL IS NOT PASSED. The route derives it from the `Host` header,
 * which the rewrite preserves. Passing it as a parameter would make the
 * route a public lookup table of "where did workspace X move to" for any
 * label somebody cares to type; deriving it from the Host means a caller
 * can only ask about a hostname they were already able to address.
 *
 * `fallback` says which refusal to reproduce when the label has NOT been
 * released, so a request that was going to get `/sign-in` still gets
 * `/sign-in` and one that was going to get `/access-denied` still does.
 */
function rewriteToHostResolver(
  req: NextRequest,
  headers: Headers,
  fallback: "sign-in" | "access-denied",
): NextResponse {
  const url = req.nextUrl.clone();
  url.search = "";
  url.pathname = HOST_MOVED_ROUTE;
  url.searchParams.set("path", req.nextUrl.pathname + req.nextUrl.search);
  url.searchParams.set("fallback", fallback);
  /*
   * 🔴 `{ request: { headers } }` IS NOT OPTIONAL HERE.
   *
   * A bare `NextResponse.rewrite(url)` forwards the request's ORIGINAL
   * headers — including every `x-tenant-*` a client supplied, which step 1
   * of this middleware deleted precisely so that nothing downstream can be
   * told which tenant it is serving by the caller. The resolver does not
   * read them today; handing it the unsanitised set anyway would leave a
   * spoofable header sitting one edit away from being trusted, on the one
   * route whose entire job is deciding what a hostname is allowed to be.
   *
   * It also carries `x-request-id`, so the resolver's log line correlates
   * with the request that produced it.
   */
  return applySecurityHeaders(NextResponse.rewrite(url, { request: { headers } }));
}

/** Copy the observability headers onto whatever response we return. */
function withLimitHeaders(
  res: NextResponse,
  headers: Record<string, string>,
): NextResponse {
  for (const [name, value] of Object.entries(headers)) res.headers.set(name, value);
  return res;
}

async function run(auth: ClerkAuth, req: NextRequest) {
  const requestId = generateRequestId();

  /* -- 1. Build a clean header set ------------------------------------ */
  // Copy inbound headers, then delete anything a client could use to
  // impersonate a tenant. Nothing below may be trusted from the client.
  const headers = new Headers(req.headers);
  for (const header of SPOOFABLE_HEADERS) {
    headers.delete(header);
  }
  headers.set(TENANT_HEADERS.requestId, requestId);

  /* -- 1b. CSRF — ORIGIN BINDING + SERVER-ACTION DIGEST — Wave 8 ----
   *
   * See the top of `lib/security/csrf.ts` for the threat model. Two
   * properties, verified before a single byte of the body is consumed
   * and before Clerk or the tenant lookup run:
   *
   *   1. An explicit `Origin` must resolve to a host we serve.
   *   2. A POST carrying a server-action content type without the
   *      `Server-Action` digest header is refused — that header is
   *      Next.js's own CSRF contract and its absence on such a POST
   *      is the fingerprint of a cross-site replay.
   *
   * 403, one line, no leak. The public webhook surfaces opt out of the
   * digest check individually — they carry their own signatures (Svix,
   * HMAC) and must never be refused for lacking ours.
   */
  const csrfVerdict = verifyCsrf({
    method: req.method,
    origin: req.headers.get("origin"),
    referer: req.headers.get("referer"),
    requestHost: req.headers.get("host"),
    contentType: req.headers.get("content-type"),
    serverActionHeader: req.headers.get("server-action"),
    expectActionDigest: true,
  });
  if (!csrfVerdict.ok) {
    return applySecurityHeaders(
      new NextResponse(
        JSON.stringify({ error: "Cross-site request refused." }),
        {
          status: 403,
          headers: {
            "content-type": "application/json",
            "x-request-id": requestId,
            "cache-control": "no-store",
          },
        },
      ),
    );
  }

  /* -- 1a. ⭐ REQUEST SIZE — REFUSED BEFORE A BYTE IS READ — Batch 31 --
   *
   * ══════════════════════════════════════════════════════════════════
   * 🔴 THE CHEAPEST CHECK IN THE REQUEST, SO IT RUNS FIRST
   * ══════════════════════════════════════════════════════════════════
   * Before this, an oversized body was buffered by the route handler
   * (`await req.json()`) and only then validated — so the memory was
   * already allocated by the time anything could object, and on the
   * assistant route the bytes had already become prompt tokens somebody
   * charges us for.
   *
   * Reading one header costs nothing and happens before Clerk, before
   * the tenant lookup and before any route is chosen.
   *
   * ⚠️ THIS RUNS ON UNAUTHENTICATED REQUESTS TOO, ON PURPOSE. The size
   * of a body is not a secret and refusing a 60 MB payload from an
   * anonymous caller is precisely when refusing is most valuable. It is
   * placed above the auth gate for that reason and not by accident.
   *
   * ⚠️ `Content-Length` IS A CLAIM. A chunked request omits it and a
   * hostile client can lie, so this is the cheap half of a two-part
   * control — `readJsonWithLimit()` in `lib/edge/body-limit.ts` counts
   * the bytes that actually arrive, in the route, and that is the half
   * that holds. Middleware cannot do the measured check: consuming the
   * body here would leave the route nothing to read.
   *
   * ⚠️ THE CAP IS PER PATH PREFIX, NOT GLOBAL, AND THAT IS LOAD-BEARING.
   * `/api/upload/put` legitimately streams tens of megabytes. A single
   * global cap would have refused every document a customer uploads,
   * with a 413 indistinguishable from a browser bug.
   */
  if (req.method !== "GET" && req.method !== "HEAD") {
    const sizeVerdict = checkDeclaredBodySize(
      req.nextUrl.pathname,
      req.headers.get("content-length"),
    );
    if (!sizeVerdict.ok) {
      // 413 with a STATED REASON and the limit, never a stack trace: the
      // caller has to know the ceiling to comply with it, and a 500 from
      // an unhandled parse error tells them nothing and tells an
      // attacker our framework.
      return applySecurityHeaders(
        new NextResponse(JSON.stringify(bodyTooLargeBody(sizeVerdict)), {
          status: 413,
          headers: {
            "content-type": "application/json",
            "x-request-id": requestId,
            "cache-control": "no-store",
          },
        }),
      );
    }
  }

  /* -- 1b. ⭐ CONTENT-SECURITY-POLICY — v0.67.0 ------------------------
   *
   * ══════════════════════════════════════════════════════════════════
   * ⚠️ THE NONCE GOES ON THE *REQUEST*, THE POLICY ON THE *RESPONSE*.
   * ══════════════════════════════════════════════════════════════════
   * Next.js does not accept a nonce as configuration. It looks for a
   * `content-security-policy` header on the INBOUND request, extracts
   * `'nonce-…'` from it, and stamps that value onto every script tag it
   * renders. Set it only on the response and Next never sees it — the
   * policy is then enforced against scripts that carry no nonce, which
   * is a blank page for every user.
   *
   * ⚠️ THE REQUEST HEADER NAME IS ALWAYS `content-security-policy`,
   * EVEN IN REPORT-ONLY MODE. Next does not read the report-only name.
   * Using it there would mean the nonce silently stops propagating the
   * moment somebody sets `CSP_ENFORCE=true` — the policy would go live
   * and break everything in the same instant, which is precisely the
   * outcome report-only exists to prevent.
   *
   * ⚠️ THE NONCE IS ALSO DELETED FROM THE INBOUND HEADERS FIRST. A
   * client that supplies its own `content-security-policy` request
   * header would otherwise hand Next a nonce the attacker chose, and
   * every injected script bearing that nonce would execute.
   *
   * Skipped for API routes: they return JSON, run no scripts, and a
   * per-request nonce on them is pure cost.
   */
  headers.delete("content-security-policy");
  headers.delete("content-security-policy-report-only");

  /* -- 0. ⭐⭐⭐ CORS — DENY-BY-DEFAULT — Wave 7 ----------------------
   *
   * ════════════════════════════════════════════════════════════════
   * A browser script on evil.example can issue credentialed fetches to
   * this app; the browser only delivers the response if WE put
   * Access-Control-Allow-* headers on it. The safe default is silence.
   *
   * Only OPTION preflights are answered here. Actual GET/POST requests
   * pass through untouched — their responses carry NO CORS headers,
   * which means the browser refuses to expose them to any script whose
   * origin is not this app's. A preflight from an origin not on the
   * allowlist (default: EMPTY — nobody is listed) gets a bare 204 with
   * no CORS headers, and the browser ends the exchange there.
   *
   * The allowlist lives in CORS_ALLOWED_ORIGINS, one entry per listed
   * integration; adding an origin is a deliberate, reviewable change.
   */
  if (req.method === "OPTIONS") {
    const decision = decidePreflight(req.headers.get("origin"));
    if (decision.preflight) {
      return applySecurityHeaders(
        new NextResponse(null, {
          status: decision.preflight.status,
          headers: decision.preflight.headers,
        }),
      );
    }
    /* Not listed — say nothing. The plain 204 carries no CORS headers
     * and the credentialed cross-origin request dies at the browser. */
    return new NextResponse(null, { status: 204 });
  }

  const isApi = req.nextUrl.pathname.startsWith("/api/");
  const csp = isApi
    ? null
    : (() => {
        const nonce = generateNonce();
        const policy = buildCsp({
          nonce,
          isDev: process.env.NODE_ENV === "development",
          reportUri: cspReportUri(),
        });
        headers.set("content-security-policy", policy);
        headers.set("x-nonce", nonce);
        return { policy, headerName: cspHeaderName(cspEnforced()) };
      })();

  /** Attach the policy to whatever response this request ends up with. */
  const withCsp = (res: NextResponse): NextResponse => {
    if (csp) res.headers.set(csp.headerName, csp.policy);
    return res;
  };

  /* -- 2. Which tenant is being addressed? ---------------------------- */
  const locator = resolveTenantFromHost(req.headers.get("host"), rootDomain(), {
    zoneDomain: zoneDomain(),
    platformHost: platformHost(),
  });

  /* -- 2b. ⭐ WAVE 3B — RECORD THE HOST, ONCE, BEFORE ANY EXIT --------
   *
   * ══════════════════════════════════════════════════════════════════
   * 🔴 THIS IS THE ONLY WRITE, AND IT IS UNCONDITIONAL ON PURPOSE
   * ══════════════════════════════════════════════════════════════════
   * `requireTenantContext` refuses a request that arrives on a custom
   * domain the workspace has not verified. That refusal is only worth
   * anything if the header is present on EVERY request that reaches a
   * server component , a branch that forwarded headers without setting
   * it would be a silent hole in exactly the check this wave adds.
   *
   * So it is set here, immediately after the locator exists and before
   * the console-host branch, the rewrite, the redirects and `forward()`.
   * Every later exit inherits it.
   *
   * ⚠️ IT REPLACES the old `x-tenant-slug: domain:<host>` write, which
   * was overwritten by the organisation slug further down and read by
   * nothing. `tenantSlug` now means one thing only: the Clerk
   * organisation's label.
   */
  headers.set(
    TENANT_HEADERS.tenantHost,
    encodeTenantHostClaim(
      locator.kind === "subdomain"
        ? { kind: "subdomain", slug: locator.slug }
        : locator.kind === "custom-domain"
          ? { kind: "custom-domain", domain: locator.domain }
          : { kind: "root" },
    ),
  );

  /**
   * ⭐ THE STAFF CONSOLE HOST — `admin.ordence.com`.
   *
   * ══════════════════════════════════════════════════════════════════
   * ⚠️ THE HOSTNAME IS A BOUNDARY THE APP CANNOT FORGET
   * ══════════════════════════════════════════════════════════════════
   * `/platform/*` is guarded by `requirePlatformAdmin()` inside each
   * route. That is correct and it stays. But it is a guard that a new
   * page can omit, and the cost of omitting it once is a customer
   * reading every other customer's revenue from a console designed to
   * show exactly that.
   *
   * Binding the console to its own hostname adds a second, structural
   * defence: on `admin.`, ONLY `/platform` is reachable, and everywhere
   * else `/platform` is not. Neither half depends on a developer
   * remembering anything.
   *
   * ⚠️ SAME-HOST REDIRECT, NOT REWRITE. THIS WAS A REWRITE AND IT BROKE
   * EVERY LINK IN THE CONSOLE.
   *
   * 🔴 THE SYMPTOM: the console loaded, and then every click on the
   * navigation went to a 404. The page you land on is server-rendered
   * and fine; the moment the App Router does a client-side navigation it
   * fails.
   *
   * 🔴 THE CAUSE: a rewrite renders `/platform/tenants` while the URL bar
   * still says `/tenants`. The server is happy , the ROUTER is not. Next's
   * App Router builds its route tree from the rendered path and its
   * history from the URL, and when those two disagree every subsequent
   * RSC fetch asks for a tree that does not exist at the URL it is asking
   * about. A rewrite INTO a route segment works for the first document
   * and breaks navigation, which is the worst possible failure shape:
   * the product looks like it loaded.
   *
   * ⭐ THE FIX IS TO MAKE THE URL TRUE. Redirect to the real path once,
   * and from then on the URL, the route tree and the sidebar's hrefs all
   * say `/platform/...`. Nothing has to be kept in sync because nothing
   * differs.
   *
   * ⚠️ AND THE SECURITY ARGUMENT FOR THE REWRITE DOES NOT APPLY. The old
   * comment here said a redirect "would bounce the operator to `app.` and
   * leak the console's existence in a Location header". That is true of a
   * CROSS-HOST redirect and this is not one: it stays on `admin.`, and
   * anyone receiving it has already reached the console's own hostname.
   * There is nothing left to disclose. The host boundary below is
   * untouched , `/platform` is still refused everywhere else.
   */
  const path = req.nextUrl.pathname;

  if (locator.kind === "platform") {
    if (!path.startsWith("/platform") && !path.startsWith("/api")) {
      const url = req.nextUrl.clone();
      url.pathname = `/platform${path === "/" ? "" : path}`;
      return applySecurityHeaders(withCsp(NextResponse.rewrite(url, { request: { headers } })));
    }
  } else if (path.startsWith("/platform") && platformHost()) {
    /**
     * ⚠️ THE `platformHost()` CHECK IS LOAD-BEARING AND WAS ALMOST
     * OMITTED. Without it, a deployment that has not yet set
     * `NEXT_PUBLIC_ZONE_DOMAIN` — which is every existing one — resolves
     * no platform host, never returns the `platform` locator, and so
     * 404s EVERY `/platform` route. That locks the operator out of their
     * own console the moment they deploy, with no error to explain it.
     *
     * The console moves hosts only once its new host exists. Until then
     * `app.<root>/platform` keeps working exactly as before.
     *
     * 404 rather than 403 once it IS configured: a host that does not
     * serve the console should not confirm the console exists.
     */
    /**
     * ⭐ A refused 404 carries the hard headers too — an attacker probing
     * for the console on the wrong host gets a blank page that looks
     * exactly like any other refused response. A bare 404 looks like a
     * plain Next.js surface, and that difference is evidence.
     */
    return applySecurityHeaders(new NextResponse("Not found", { status: 404 }));
  }

  if (locator.kind === "subdomain") {
    headers.set(TENANT_HEADERS.tenantSlug, locator.slug);
  }
  /*
   * ⚠️ NO `else if` FOR THE CUSTOM DOMAIN ANY MORE , WAVE 3B.
   * It used to write `domain:<host>` into `tenantSlug` here, and step 8
   * below overwrote it with `orgSlug` on every authenticated request.
   * The host now travels in `TENANT_HEADERS.tenantHost`, set at step 2b,
   * which nothing overwrites and `requireTenantContext` enforces.
   */

  /*
   * ⚠️ `withCsp` IS APPLIED HERE AND ON THE REWRITE ABOVE — AND NOWHERE
   * ELSE, ON PURPOSE.
   *
   * Those two are the only responses that end up rendering application
   * HTML, and HTML is the only thing a script can be injected into. The
   * remaining exits are redirects (a `Location` header and an empty
   * body), a plain-text 404, and JSON errors. Attaching a per-request
   * nonce policy to those costs a `getRandomValues` call and buys
   * nothing.
   */
  /**
   * ⭐ THE FORWARD PATH ALSO GETS THE HARD HEADERS HERE — the app's
   * `headers()` in `next.config.ts` sets them for rendered responses,
   * but setting them on the middleware's own `NextResponse` as well is
   * what makes them apply to the refused and redirected paths that
   * never reach the renderer. On the forward path the two sets are
   * idempotent: same keys, same values, so nothing doubles up.
   */
  const forward = () => applySecurityHeaders(withCsp(NextResponse.next({ request: { headers } })));

  /* -- 3. Public routes ------------------------------------------------ */
  if (isPublicRoute(req)) {
    return forward();
  }

  /* -- 4. Require a session -------------------------------------------- */
  const { userId, orgId, orgSlug, orgRole, sessionClaims } = await auth();

  if (!userId) {
    /**
     * ⭐ THE RELEASED-HOSTNAME BRANCH — v1.57.0-alpha.
     *
     * ⚠️ ONLY FOR A TENANT SUBDOMAIN, AND ONLY WHERE THIS FILE WAS ALREADY
     * REFUSING. `admin.` resolves to `platform` and `app.`/`www.`/
     * `*.workers.dev`/`*.vercel.app` resolve to `root`, so none of them can
     * be `subdomain` and none of them reaches this line. See the block
     * above `rewriteToHostResolver` for why the lookup is not done here.
     *
     * ⚠️ THE GUARD AGAINST REWRITING THE RESOLVER TO ITSELF is not
     * theoretical: the resolver route is not on `isPublicRoute`, so a
     * direct session-less request to it lands on exactly this branch.
     * Without the check it would be rewritten to itself with its own path
     * nested in the query, which resolves fine and reads like a bug.
     */
    if (locator.kind === "subdomain" && !path.startsWith(HOST_MOVED_ROUTE)) {
      return rewriteToHostResolver(req, headers, "sign-in");
    }

    // API callers get JSON; browsers get redirected to sign-in.
    if (req.nextUrl.pathname.startsWith("/api/")) {
      return jsonError(401, "unauthenticated", "Sign-in required.", requestId);
    }
    const signIn = new URL("/sign-in", req.url);
    signIn.searchParams.set("redirect_url", req.nextUrl.pathname + req.nextUrl.search);
    return applySecurityHeaders(NextResponse.redirect(signIn));
  }

  /* -- 5. Platform-admin routes ---------------------------------------- */
  if (isPlatformAdminRoute(req)) {
    const isPlatformAdmin =
      (sessionClaims?.metadata as { platformAdmin?: boolean } | undefined)?.platformAdmin === true;

    if (!isPlatformAdmin) {
      return req.nextUrl.pathname.startsWith("/api/")
        ? jsonError(403, "forbidden", "Platform staff only.", requestId)
        : applySecurityHeaders(NextResponse.redirect(new URL("/dashboard", req.url)));
    }
    headers.set(TENANT_HEADERS.userId, userId);
    headers.set(TENANT_HEADERS.tenantRole, "platform_super_admin");

    /**
     * ⭐ THE STAFF CONSOLE HAS ITS OWN BUCKET AND ITS OWN FAILURE MODE.
     *
     * ⚠️ NOT THE TENANT BUCKET. A staff member has no workspace, so
     * there is nothing tenant-shaped to key on — and if there were, the
     * bucket would be wrong anyway: the two surfaces have opposite blast
     * radii. Throttling a customer wrongly breaks one workspace's day;
     * failing to count the console means a compromised staff session can
     * read every workspace in the product at network speed.
     *
     * Keyed per staff USER rather than per console, so one operator
     * running an export cannot throttle their colleagues during an
     * incident.
     *
     * ⚠️ THIS IS THE SURFACE THAT FAILS CLOSED. See `FAIL_MODE` in
     * lib/edge/budgets.ts for the argument and for the escape hatch.
     */
    const staffGate = await edgeLimitGate(
      req,
      requestId,
      { kind: "staff", userId },
      "platform",
    );
    if (staffGate.refusal) return staffGate.refusal;
    return withLimitHeaders(forward(), staffGate.headers);
  }

  /* -- 6. Require an active organization ------------------------------- */
  if (!orgId) {
    if (req.nextUrl.pathname.startsWith("/api/")) {
      return jsonError(403, "no_active_organization", "Select an organization first.", requestId);
    }
    /*
     * ⭐ TWO DESTINATIONS, NOT ONE — v1.65.0-alpha (Brief A).
     *
     * `/onboarding` is where this branch has always sent people and it
     * stays the redirect target, because it is the address in every
     * existing bookmark, log and support answer. `/claim` is the same
     * step reachable at a marketing URL, and it has to be ALLOWED here or
     * the self-serve funnel is unreachable: a person who has just signed
     * up has no active organisation by definition, so without this line
     * every visit to `/claim` is bounced to `/onboarding` and the address
     * step can never be shown at its own URL.
     *
     * 🔴 ALLOWED, NOT REDIRECTED TO. Changing the target from
     *    `/onboarding` to `/claim` would send a session that has
     *    organisations but none ACTIVE — a workspace switcher mid-change,
     *    a revoked membership — to a screen offering to create a new
     *    workspace, which is the wrong answer to "pick one".
     *
     * ⚠️ EXACT PATHS, NEVER A PREFIX MATCH. `/claim(.*)` would make every
     *    route somebody later adds under `/claim` reachable without a
     *    workspace, and "it was open because of where I put the file" is
     *    not a decision anybody made.
     */
    const NO_WORKSPACE_ROUTES = ["/onboarding", "/claim"];
    if (!NO_WORKSPACE_ROUTES.includes(req.nextUrl.pathname)) {
      return applySecurityHeaders(NextResponse.redirect(new URL("/onboarding", req.url)));
    }
    headers.set(TENANT_HEADERS.userId, userId);
    return forward();
  }

  /* -- 7. THE CRITICAL CHECK ------------------------------------------- */
  // The host says one tenant; the session says another. Refuse.
  // Without this, any authenticated user could browse any tenant's subdomain.
  if (locator.kind === "subdomain" && orgSlug && locator.slug !== orgSlug) {
    /**
     * ⭐ THE SECOND RELEASED-HOSTNAME EXIT — v1.57.0-alpha.
     *
     * ⚠️ THIS IS WHERE A RENAMED WORKSPACE'S OWN STAFF LAND, EVERY TIME.
     * After a rename their session carries the NEW `orgSlug` while their
     * bookmark still carries the old label, so `locator.slug !== orgSlug`
     * is true for every one of them — and until now the answer was
     * `/access-denied`, which tells a paying customer that they may not
     * enter their own workspace.
     *
     * ⚠️ IT IS NOT A WEAKENING OF THE CROSS-TENANT CHECK. The resolver
     * refuses to redirect for any label a live workspace currently holds,
     * so a genuine attempt to reach someone else's host still ends in
     * `/access-denied` — the route reproduces this exact refusal when the
     * label was not released. Nothing is served under the old name in
     * either case.
     */
    if (!path.startsWith(HOST_MOVED_ROUTE)) {
      return rewriteToHostResolver(req, headers, "access-denied");
    }
    return req.nextUrl.pathname.startsWith("/api/")
      ? jsonError(403, "tenant_mismatch", "Session does not belong to this workspace.", requestId)
      : applySecurityHeaders(NextResponse.redirect(new URL("/access-denied", req.url)));
  }

  /* -- 8. Inject server-trusted context -------------------------------- */
  headers.set(TENANT_HEADERS.clerkOrgId, orgId);
  headers.set(TENANT_HEADERS.userId, userId);
  headers.set(TENANT_HEADERS.tenantRole, orgRole ?? "org:member");
  if (orgSlug) headers.set(TENANT_HEADERS.tenantSlug, orgSlug);

  /* -- 9. ⭐ PER-TENANT CAPACITY BUDGET — Batch 31 ---------------------
   *
   * ⚠️ `orgId` COMES FROM `auth()`, WHICH IS THE SAME PLACE STEP 7 GOT
   * THE VALUE IT USED TO REFUSE A CROSS-TENANT REQUEST. It is not a
   * header (every `x-tenant-*` was deleted in step 1), not the hostname
   * (client-supplied, and step 7 exists precisely because it can
   * disagree with the session) and not a query parameter. If the bucket
   * key were any of those, a caller could reset their own budget by
   * changing a string, and the limit would be advisory.
   *
   * ⚠️ TWO SURFACES, TWO BUCKETS. A browser session and a scripted API
   * client have different natural rates and different failure modes —
   * a person waits, a script retries — so a shared bucket would let one
   * runaway integration lock a workspace's own staff out of the CRM.
   */
  const surface = req.nextUrl.pathname.startsWith("/api/") ? "api" : "app";
  const gate = await edgeLimitGate(req, requestId, { kind: "tenant", orgId }, surface);
  if (gate.refusal) return gate.refusal;

  /* -- 10. ⭐⭐⭐ THE WORKSPACE'S OWN SESSION POLICY — Batch 136 -------
   *
   * ══════════════════════════════════════════════════════════════════
   * 🔴 `requireMfa` AND `sessionIdleMinutes` WERE SAVED, DISPLAYED, AND
   *    ENFORCED BY NOTHING. THIS IS WHERE THEY START MEANING SOMETHING.
   * ══════════════════════════════════════════════════════════════════
   * A tenant admin ticked "require MFA", the settings page reported it
   * ON, and no gate in the product ever read the value. That is not a
   * missing feature, it is a false claim about the protection around
   * somebody else's payroll and GST filings.
   *
   * ⚠️ THE DECISION IS NOT MADE IN THIS FILE. Every judgement lives in
   * `lib/security/session-policy.ts` — pure, no I/O — so the refusals can
   * be proved without a database, a Clerk instance or a request, and so
   * that the Node-runtime backstop in `app/(crm)/layout.tsx` cannot drift
   * away from what the edge does. Read that file for the trade-offs; the
   * two that matter most are repeated here because they change behaviour
   * people will notice:
   *
   *   • AN ALREADY-OPEN SESSION IS NOT GRANDFATHERED. The policy is read
   *     from the live claims on every request, so the switch bites on the
   *     next request rather than at the next sign-in. An admin turning MFA
   *     on usually has a suspicion; exempting the sessions that are
   *     already open exempts precisely the one they are worried about.
   *
   *   • THE ENROLMENT PAGE AND THE SIGN-OUT PAGE ARE EXEMPT, BY NAME, in
   *     `SESSION_POLICY_EXEMPT_PATHS`. A gate that also blocks its own
   *     cure is a locked door.
   *
   * ⚠️ THE POLICY ARRIVES AS A SIGNED CLAIM, NOT A QUERY. Edge Runtime:
   * no database driver, for the same reasons written above
   * `rewriteToHostResolver`. `null` means THIS RUNTIME CANNOT SEE the
   * policy — not that there is none — and the CRM layout re-runs the
   * identical function against `tenants.settings` in Node, which is what
   * makes the control real before the JWT template is ever touched.
   */
  const edgePolicy = readPolicyFromClaims(sessionClaims);
  if (edgePolicy) {
    const verdict = evaluateSession({
      path,
      policy: edgePolicy,
      factors: readFactorEvidence(sessionClaims),
      // 🔴 THE SERVER'S CLOCK. Nothing from the request reaches this.
      nowMs: Date.now(),
      sessionExpiresAtMs: readSessionExpiryMs(sessionClaims),
    });

    if (verdict.outcome !== "allow") {
      const refusal = req.nextUrl.pathname.startsWith("/api/")
        ? jsonError(403, verdict.outcome, verdict.reason, requestId)
        : (() => {
            const url = new URL(verdict.redirectTo ?? "/", req.url);
            /*
             * ⭐ THE WORD TRAVELS WITH THE REDIRECT, AND IT IS A WORD.
             * One in twelve Indian men is colour-blind; a page that
             * signalled "expired" with a red bar alone would be
             * unreadable to them. The destination pages print
             * `verdict.word` and the sentence.
             */
            url.searchParams.set("reason", verdict.outcome);
            if (verdict.outcome === "mfa_required") {
              url.searchParams.set("redirect_url", path + req.nextUrl.search);
            }
            return applySecurityHeaders(NextResponse.redirect(url));
          })();
      refusal.headers.set("x-ordence-session-policy", verdict.word);
      return withLimitHeaders(refusal, gate.headers);
    }

    /*
     * ⚠️ "NOT MEASURED" MUST NEVER LOOK LIKE "WITHIN THE LIMIT". When the
     * `fva` claim is absent the idle limit cannot be computed at all, and
     * saying so in a header is the difference between a degraded control
     * and a silent one — the same reason `edgeLimitGate` publishes
     * `observe:` rather than hiding an uncounted request.
     */
    const allowed = withLimitHeaders(forward(), gate.headers);
    allowed.headers.set(
      "x-ordence-session-policy",
      verdict.idleUnenforceable ? "idle-unmeasured" : "ok",
    );
    return allowed;
  }

  return withLimitHeaders(forward(), gate.headers);
};

/**
 * Which settings the RUNNING Worker can actually see.
 *
 * ⚠️ Booleans only. Never the values — this is reachable without signing in,
 * which it has to be: the fault it diagnoses is one where signing in is
 * exactly what does not work.
 */
export function presentSettings(): Record<string, boolean> {
  const names = [
    "DATABASE_URL",
    "DATABASE_URL_UNPOOLED",
    "CLERK_SECRET_KEY",
    "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
    "NEXT_PUBLIC_APP_URL",
    "NEXT_PUBLIC_ROOT_DOMAIN",
    "PLATFORM_ADMIN_EMAILS",
  ];
  const out: Record<string, boolean> = {};
  for (const name of names) out[name] = readRuntimeEnv(name) !== undefined;
  return out;
}

/** Uniform JSON error shape — never leaks internals to the caller. */
function jsonError(status: number, code: string, message: string, requestId: string) {
  /**
   * ⭐⭐⭐ THE HARD HEADERS ARE SET HERE, NOT IN EACH CALLER — Wave 7.
   *
   * Every JSON refusal this file produces (401, 403, 404s) flows through
   * this one function, so a refused API call carries HSTS, nosniff,
   * SAMEORIGIN, Referrer-Policy and COOP exactly like a rendered page.
   * A refusal without them would tell a probe the request never reached
   * a hardened surface; a refusal WITH them is just a refusal.
   */
  return applySecurityHeaders(
    new NextResponse(JSON.stringify({ error: { code, message, requestId } }), {
      status,
      headers: { "content-type": "application/json", "x-request-id": requestId },
    }),
  );
}

export const config = {
  matcher: [
    // Everything except Next internals and static files...
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?)$).*)",
    // ...but always run on API and tRPC routes.
    "/(api|trpc)(.*)",
  ],
};
