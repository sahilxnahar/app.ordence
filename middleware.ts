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
  generateRequestId,
} from "@/lib/tenant";
import { buildCsp, cspHeaderName, generateNonce } from "@/lib/security/csp";

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
  "/api/webhooks(.*)",
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
        return new NextResponse(
          JSON.stringify(
            { ok: false, stage: "middleware", error: message, settingsPresent: presentSettings() },
            null,
            2,
          ),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
      return new NextResponse("Internal Server Error", { status: 500 });
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
   * ⚠️ REWRITE, NOT REDIRECT, for the console's own root. A redirect
   * would bounce the operator to `app.` and leak the console's existence
   * in a Location header to anyone who probes the host.
   */
  const path = req.nextUrl.pathname;

  if (locator.kind === "platform") {
    if (!path.startsWith("/platform") && !path.startsWith("/api")) {
      const url = req.nextUrl.clone();
      url.pathname = `/platform${path === "/" ? "" : path}`;
      return withCsp(NextResponse.rewrite(url, { request: { headers } }));
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
    return new NextResponse("Not found", { status: 404 });
  }

  if (locator.kind === "subdomain") {
    headers.set(TENANT_HEADERS.tenantSlug, locator.slug);
  } else if (locator.kind === "custom-domain") {
    headers.set(TENANT_HEADERS.tenantSlug, `domain:${locator.domain}`);
  }

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
  const forward = () => withCsp(NextResponse.next({ request: { headers } }));

  /* -- 3. Public routes ------------------------------------------------ */
  if (isPublicRoute(req)) {
    return forward();
  }

  /* -- 4. Require a session -------------------------------------------- */
  const { userId, orgId, orgSlug, orgRole, sessionClaims } = await auth();

  if (!userId) {
    // API callers get JSON; browsers get redirected to sign-in.
    if (req.nextUrl.pathname.startsWith("/api/")) {
      return jsonError(401, "unauthenticated", "Sign-in required.", requestId);
    }
    const signIn = new URL("/sign-in", req.url);
    signIn.searchParams.set("redirect_url", req.nextUrl.pathname + req.nextUrl.search);
    return NextResponse.redirect(signIn);
  }

  /* -- 5. Platform-admin routes ---------------------------------------- */
  if (isPlatformAdminRoute(req)) {
    const isPlatformAdmin =
      (sessionClaims?.metadata as { platformAdmin?: boolean } | undefined)?.platformAdmin === true;

    if (!isPlatformAdmin) {
      return req.nextUrl.pathname.startsWith("/api/")
        ? jsonError(403, "forbidden", "Platform staff only.", requestId)
        : NextResponse.redirect(new URL("/dashboard", req.url));
    }
    headers.set(TENANT_HEADERS.userId, userId);
    headers.set(TENANT_HEADERS.tenantRole, "platform_super_admin");
    return forward();
  }

  /* -- 6. Require an active organization ------------------------------- */
  if (!orgId) {
    if (req.nextUrl.pathname.startsWith("/api/")) {
      return jsonError(403, "no_active_organization", "Select an organization first.", requestId);
    }
    // Send the user somewhere they can create or pick an org.
    if (req.nextUrl.pathname !== "/onboarding") {
      return NextResponse.redirect(new URL("/onboarding", req.url));
    }
    headers.set(TENANT_HEADERS.userId, userId);
    return forward();
  }

  /* -- 7. THE CRITICAL CHECK ------------------------------------------- */
  // The host says one tenant; the session says another. Refuse.
  // Without this, any authenticated user could browse any tenant's subdomain.
  if (locator.kind === "subdomain" && orgSlug && locator.slug !== orgSlug) {
    return req.nextUrl.pathname.startsWith("/api/")
      ? jsonError(403, "tenant_mismatch", "Session does not belong to this workspace.", requestId)
      : NextResponse.redirect(new URL("/access-denied", req.url));
  }

  /* -- 8. Inject server-trusted context -------------------------------- */
  headers.set(TENANT_HEADERS.clerkOrgId, orgId);
  headers.set(TENANT_HEADERS.userId, userId);
  headers.set(TENANT_HEADERS.tenantRole, orgRole ?? "org:member");
  if (orgSlug) headers.set(TENANT_HEADERS.tenantSlug, orgSlug);

  return forward();
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
  return new NextResponse(JSON.stringify({ error: { code, message, requestId } }), {
    status,
    headers: { "content-type": "application/json", "x-request-id": requestId },
  });
}

export const config = {
  matcher: [
    // Everything except Next internals and static files...
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?)$).*)",
    // ...but always run on API and tRPC routes.
    "/(api|trpc)(.*)",
  ],
};
