/**
 * Ordence — Tenant Resolution (Edge-safe)
 * Version: v0.1.0-alpha
 *
 * Pure string/URL logic only — no database, no Node APIs — so this module can run
 * inside Edge Middleware. Authoritative tenant verification happens server-side in
 * `server/tenant-context.ts`; this layer only decides *which* tenant is being asked for.
 */

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

/** Reserved subdomains that can never belong to a tenant. */
export const RESERVED_SLUGS = new Set([
  "www", "app", "api", "admin", "auth", "login", "logout", "signin", "signup",
  "dashboard", "status", "docs", "help", "support", "blog", "cdn", "assets",
  "static", "mail", "smtp", "ftp", "ns1", "ns2", "vercel", "clerk", "internal",
  "platform", "system", "root", "test", "staging", "dev", "preview",
]);

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

/** RFC-1123 label: lowercase alphanumeric + hyphen, no leading/trailing hyphen. */
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function isValidSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug) && !RESERVED_SLUGS.has(slug);
}

/** Strip port and normalise case. Returns "" for junk input. */
function normaliseHost(rawHost: string | null | undefined): string {
  if (!rawHost) return "";
  const host = rawHost.split(":")[0]?.trim().toLowerCase() ?? "";
  // Reject anything that is not a plausible hostname (Host-header injection guard).
  if (!/^[a-z0-9.-]+$/.test(host)) return "";
  return host;
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
    const label = host.slice(0, -(root.length + 1));
    // Only a single label counts (a.b.root is not a tenant).
    if (!label || label.includes(".")) return { kind: "root" };
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
    const label = host.slice(0, -(zone.length + 1));
    if (!label || label.includes(".")) return { kind: "root" };
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
