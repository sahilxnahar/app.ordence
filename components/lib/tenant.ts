/**
 * Ordence — Tenant Resolution (Edge-safe)
 * Version: v0.1.0-alpha
 *
 * Pure string/URL logic only — no database, no Node APIs — so this module can run
 * inside Edge Middleware. Authoritative tenant verification happens server-side in
 * `server/tenant-context.ts`; this layer only decides *which* tenant is being asked for.
 */

/**
 * ⚠️ THE ONLY IMPORT THIS FILE MAY EVER HAVE, AND IT IS SAFE BECAUSE
 *    `lib/slug.ts` HAS NONE. `middleware.ts` imports this module and runs in
 *    the Edge Runtime on every request; anything pulled in here is pulled
 *    into that bundle. The re-export block further down says why the rules
 *    moved out of this file at all.
 */
import { isValidSlug } from "@/lib/slug";

/** Header names used to carry tenant context from middleware to server components. */
export const TENANT_HEADERS = {
  tenantId: "x-tenant-id",
  tenantSlug: "x-tenant-slug",
  tenantRole: "x-tenant-role",
  clerkOrgId: "x-tenant-org-id",
  userId: "x-tenant-user-id",
  requestId: "x-request-id",
} as const;

/**
 * Every header the client is FORBIDDEN from supplying.
 *
 * THREAT (Blueprint: "Cross-Tenant Query Protection"): without this, an attacker
 * simply sends `x-tenant-id: <victim-uuid>` and our own server components trust it.
 * Middleware strips all of these from the inbound request before setting its own.
 */
export const SPOOFABLE_HEADERS: readonly string[] = Object.values(TENANT_HEADERS);

/**
 * 🔴 THE SLUG RULES DO NOT LIVE HERE ANY MORE. `lib/slug.ts` is the only
 *    copy: shape, length and the 71 reserved names, mirrored by the
 *    `reserved_slugs` table and enforced by 0091.
 *
 * ⚠️ WHY IT MOVED. This file held one list ("what RESOLVES") and
 *    `server/platform/provisioning.ts` held another ("what can be CREATED"),
 *    and they drifted by eight names in each direction. Provisioning minted
 *    `assets`, `ns1`, `ns2`, `ftp`, `clerk`, `preview`, `vercel` and
 *    `logout`; the resolver below then refused them and fell back to
 *    `{ kind: "root" }`, so the workspace was created with a dead front door
 *    and nothing reported it. Both halves now ask the same function.
 *
 * ⚠️ THIS IS A BEHAVIOUR CHANGE AND IT IS THE FIX, NOT A SIDE EFFECT. The
 *    old local pattern allowed one- and two-character labels; the shared one
 *    starts at three, and the reserved set grew from 33 names to 71. Hosts
 *    that used to resolve as tenants now fall back to root — which is
 *    correct, because provisioning could never have created them either.
 *
 * ⚠️ EDGE BUDGET: `lib/slug.ts` imports nothing at all, deliberately, because
 *    `middleware.ts` imports this file and runs on every request. Do not
 *    import zod (or anything else) into that module or into this one — the
 *    Zod schema lives apart in `lib/slug-schema.ts` for exactly that reason.
 *
 * Re-exported rather than merely imported: these two names were part of this
 * module's public surface before the move, and a rename is not worth breaking
 * a call site over.
 */
export { RESERVED_SLUGS } from "@/lib/slug";
export { isValidSlug };

export type TenantLocator =
  | { kind: "subdomain"; slug: string }
  | { kind: "custom-domain"; domain: string }
  /**
   * ⭐ THE STAFF CONSOLE, ON ITS OWN HOSTNAME — v0.43.0.
   *
   * ⚠️ A SEPARATE KIND, NOT A PATH PREFIX, AND THAT IS THE POINT. While
   * `/platform` was only a route, the sole thing standing between a
   * customer and the cross-tenant console was a permission check inside
   * the app they are already authenticated to. One missed guard on one
   * new page is a customer reading every other customer's revenue.
   *
   * Giving it a hostname means the request can be refused at the edge,
   * before a route handler is chosen, which is a boundary that cannot be
   * forgotten on a page somebody adds next month.
   */
  | { kind: "platform" }
  | { kind: "root" };

/** Strip port and normalise case. Returns "" for junk input. */
function normaliseHost(rawHost: string | null | undefined): string {
  if (!rawHost) return "";
  const host = rawHost.split(":")[0]?.trim().toLowerCase() ?? "";
  // Reject anything that is not a plausible hostname (Host-header injection guard).
  if (!/^[a-z0-9.-]+$/.test(host)) return "";
  return host;
}

/* ------------------------------------------------------------------ */
/* ONE LABEL UNDER A BASE — THE SUFFIX RULE, WRITTEN ONCE               */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE SUFFIX TEST, EXTRACTED SO THERE IS EXACTLY ONE OF IT.
 *
 * `host` is one DNS label beneath `base` → the label. Anything else →
 * `null`. Both inputs are already normalised by `normaliseHost`.
 *
 * 🔴 THE MATCH IS A SUFFIX ON A LABEL BOUNDARY, NEVER A SUBSTRING, AND
 *    THE DIFFERENCE IS THE WHOLE SECURITY VALUE. `endsWith(zone)` alone
 *    accepts `notordence.com` and `evil-ordence.com` for the zone
 *    `ordence.com`, because both genuinely end with that string. The
 *    leading dot in the comparison is what makes the boundary a boundary.
 *
 * ⚠️ A DEEPER NAME IS NOT ONE LABEL. `a.b.ordence.com` returns null,
 *    because `label.includes(".")`. This is the same rule the tenant
 *    resolver has always applied, and it is what the wildcard certificate
 *    `*.ordence.com` covers — exactly one label, never two.
 */
export function labelUnder(
  rawHost: string | null | undefined,
  rawBase: string | null | undefined,
): string | null {
  const host = normaliseHost(rawHost);
  const base = normaliseHost(rawBase);
  if (!host || !base) return null;
  if (!host.endsWith(`.${base}`)) return null;
  const label = host.slice(0, -(base.length + 1));
  if (!label || label.includes(".")) return null;
  return label;
}

/**
 * Is `rawHost` a hostname this deployment serves under `rawZone`?
 *
 * True for the zone apex itself and for any SINGLE label beneath it —
 * `ordence.com`, `app.ordence.com`, `admin.ordence.com`,
 * `acme.ordence.com`. False for `notordence.com`, `evil-ordence.com`,
 * `ordence.com.evil.net` and `a.b.ordence.com`.
 *
 * ⚠️ PORT-INSENSITIVE, BECAUSE `normaliseHost` STRIPS THE PORT, AND THAT
 *    IS DELIBERATE RATHER THAN AN OVERSIGHT. The thing this predicate
 *    protects is a cookie-carrying request, and cookies are not
 *    port-scoped: an attacker who can serve `acme.ordence.com:8443`
 *    already controls `acme.ordence.com` for every purpose that matters
 *    here. Requiring the ports to match would buy nothing and would break
 *    `acme.localhost:3000` in development, where the zone carries a port
 *    and the origin does too.
 */
export function isHostInZone(
  rawHost: string | null | undefined,
  rawZone: string | null | undefined,
): boolean {
  const host = normaliseHost(rawHost);
  const zone = normaliseHost(rawZone);
  if (!host || !zone) return false;
  if (host === zone) return true;
  return labelUnder(host, zone) !== null;
}

/**
 * Work out which tenant a request is addressed to, from the Host header alone.
 *
 * Handles:
 *   acme.app.ordence.com      → subdomain "acme"
 *   acme.localhost:3000       → subdomain "acme"   (local dev)
 *   crm.acme.com              → custom domain
 *   app.ordence.com / www...  → root (marketing + platform sign-in)
 *   *.workers.dev             → root (Cloudflare deploy URL)
 *   *.vercel.app              → root (preview deployments)
 */
export function resolveTenantFromHost(
  rawHost: string | null | undefined,
  rootDomain: string,
  options?: {
    /**
     * ⭐ THE ZONE TENANT SUBDOMAINS HANG OFF — v0.43.0.
     *
     * ══════════════════════════════════════════════════════════════════
     * ⚠️ TWO DIFFERENT ROOTS WERE DOING ONE JOB, AND IT DID NOT FIT
     * ══════════════════════════════════════════════════════════════════
     * `rootDomain` has always meant the APP HOST — `app.ordence.com`, the
     * canonical address with no tenant on it. Tenant subdomains were
     * therefore resolved beneath it, giving `acme.app.ordence.com`.
     *
     * That is a working design and it is not the one that was asked for.
     * The intent is `acme.ordence.com` — one label under the ZONE, which
     * is a different thing from the app host and reads far better on a
     * customer's address bar.
     *
     * So the two are now separate inputs. Pass `zoneDomain: "ordence.com"`
     * with `rootDomain: "app.ordence.com"` and both forms resolve: the app
     * host stays canonical, and tenants sit one label under the zone.
     * Omit it and the previous behaviour is unchanged, which is why no
     * existing deployment moves.
     */
    zoneDomain?: string;
    /** The staff console host. Defaults to `admin.<zone>`. */
    platformHost?: string;
  },
): TenantLocator {
  const host = normaliseHost(rawHost);
  const root = normaliseHost(rootDomain);
  const zone = options?.zoneDomain ? normaliseHost(options.zoneDomain) : null;

  if (!host) return { kind: "root" };

  /**
   * ⚠️ CHECKED BEFORE EVERYTHING ELSE, INCLUDING THE ROOT HOST. The
   * staff console must never be reachable by any other classification,
   * and a rule placed after the tenant branches is a rule that a future
   * hostname can slip past.
   */
  const platformHost = normaliseHost(
    options?.platformHost ?? (zone ? `admin.${zone}` : ""),
  );
  if (platformHost && host === platformHost) return { kind: "platform" };

  /**
   * ⚠️ PLATFORM-ISSUED HOSTNAMES ARE NEVER TENANT SUBDOMAINS.
   *
   * `ordence.<account>.workers.dev` is the URL Cloudflare hands you the
   * moment you deploy, and it is what the operator uses to check the app is
   * alive BEFORE any DNS is pointed at it. Without this line that host does
   * not end with the root domain, falls through to the last branch, and is
   * classified as a CUSTOM DOMAIN — so the very first smoke test after a
   * first deploy looks for a tenant that does not exist and appears broken.
   *
   * `.vercel.app` is the same problem on the platform this migrated from,
   * and is kept because that deployment path still builds.
   */
  if (host.endsWith(".workers.dev")) return { kind: "root" };
  if (host.endsWith(".vercel.app")) return { kind: "root" };

  // Bare root, or www.
  if (host === root || host === `www.${root}`) return { kind: "root" };

  if (host.endsWith(`.${root}`)) {
    // Only a single label counts (a.b.root is not a tenant). `labelUnder`
    // is that rule, shared with `isHostInZone` above so the host set the
    // CSRF check trusts and the host set that resolves are the same shape.
    const label = labelUnder(host, root);
    if (label === null) return { kind: "root" };
    if (!isValidSlug(label)) return { kind: "root" };
    return { kind: "subdomain", slug: label };
  }

  /**
   * ⭐ TENANTS ONE LABEL UNDER THE ZONE: `acme.ordence.com`.
   *
   * ⚠️ AFTER the app-host branch above, so `app.ordence.com` is still the
   * root and never resolves to a tenant called "app". `app` is in
   * RESERVED_SLUGS as well — two independent defences, because this one
   * decides whether the product's own front door is mistaken for a
   * customer.
   */
  if (zone && host.endsWith(`.${zone}`)) {
    const label = labelUnder(host, zone);
    if (label === null) return { kind: "root" };
    if (!isValidSlug(label)) return { kind: "root" };
    return { kind: "subdomain", slug: label };
  }

  if (zone && host === zone) return { kind: "root" };

  // Plain "localhost" with no subdomain.
  if (host === "localhost" || host === "127.0.0.1") return { kind: "root" };

  // Anything else is a candidate custom domain.
  return { kind: "custom-domain", domain: host };
}

/** Build an absolute URL for a given tenant. */
export function tenantUrl(
  slug: string,
  rootDomain: string,
  path = "/",
  zoneDomain?: string,
): string {
  /**
   * ⚠️ BUILT FROM THE ZONE WHERE ONE EXISTS, so the link a customer is
   * emailed matches the host the resolver will accept. A URL builder and
   * a URL parser that disagree produce a working invitation to a page
   * that says the workspace does not exist.
   */
  const base = zoneDomain ?? rootDomain;
  const isLocal = base.startsWith("localhost");
  const protocol = isLocal ? "http" : "https";
  return `${protocol}://${slug}.${base}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Cheap, dependency-free request id for correlating logs across services. */
export function generateRequestId(): string {
  return crypto.randomUUID();
}
