/**
 * Ordence — Polymorphic CRM Layout
 * Version: v0.3.0-alpha
 * Runtime: Node (needs the database to resolve the tenant)
 *
 * THE INDUSTRY ROUTING ENGINE.
 *
 * This layout runs before any page inside `(crm)` renders. It:
 *   1. Resolves the authenticated tenant (throws if absent — fail closed)
 *   2. Reads the industry from tenant settings
 *   3. Loads the matching template
 *   4. Filters navigation by the caller's role
 *   5. Publishes terminology to descendants via React context
 *
 * The result: `/contacts` renders "Leads" for a developer and "Clients" for an
 * advocate, from identical component code.
 *
 * RESOLUTION ORDER for the industry value:
 *   tenant.settings.industry  →  the authoritative store, editable in settings
 *   fallback: "generic"       →  never throws on a bad value
 *
 * Clerk `publicMetadata` is deliberately NOT trusted for this. It is client-
 * readable and, on some plans, client-writable — using it to drive entitlement-
 * adjacent UI would be a privilege boundary in the wrong place. The database row
 * is the source of truth.
 */

import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { OrganizationSwitcher, UserButton } from "@clerk/nextjs";
import { getTenantContext } from "@/server/tenant-context";
import {
  resolveIndustryTemplate,
  filterNavigationByRole,
} from "@/lib/industry-templates";
import { checkFeatures } from "@/server/entitlements";
import { requiredFeatureKeys } from "@/lib/modules/registry";
import { filterNavigationByEntitlement } from "@/lib/modules/nav";
import { Sidebar } from "@/components/layout/sidebar";
import { IndustryProvider } from "@/components/layout/industry-provider";

export const dynamic = "force-dynamic";

export default async function CrmLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const ctx = await getTenantContext();

  /*
   * ══════════════════════════════════════════════════════════════════════
   * ⭐ TWO DESTINATIONS, NOT ONE — v0.67.0. THIS IS THE SIGN-OUT FIX.
   * ══════════════════════════════════════════════════════════════════════
   * No verified tenant → no CRM surface. Fail closed, never render a shell
   * that might leak structure to an unprovisioned or suspended user. That
   * part has always been right.
   *
   * What was wrong was sending EVERY such case to `/onboarding`.
   *
   * ⚠️ SIGNING OUT IS ONE OF THESE CASES, AND IT PRODUCED A REDIRECT
   * CHAIN THE CLIENT ROUTER CANNOT FOLLOW.
   *
   * Clerk's sign-out refreshes the current route before navigating away.
   * That refresh is an RSC fetch for `/dashboard` with the session already
   * gone, so:
   *
   *     /dashboard  →  (this layout) redirect /onboarding
   *                 →  (middleware, no userId) redirect /sign-in
   *                 →  an HTML page
   *
   * Two hops, ending in a document rather than an RSC payload. The App
   * Router client follows a single redirect on an RSC fetch; it cannot
   * resolve a chain that lands on HTML, and it surfaces that as
   * "Application error: a client-side exception has occurred" — on the way
   * OUT of the application, which is the worst possible moment because the
   * user has already stopped being able to do anything about it.
   *
   * ⚠️ THE FIX IS TO MAKE EACH CASE ONE HOP, AND TO MAKE THIS LAYOUT AGREE
   * WITH THE MIDDLEWARE ABOUT WHERE IT GOES. No session → `/sign-in`,
   * which is exactly where the middleware would have sent it. A session
   * with no workspace → `/onboarding`, which the middleware leaves alone.
   * Neither one redirects a second time.
   *
   * ⚠️ `auth()` IS CHEAP HERE. It reads the same request the middleware
   * already validated — no database, no network — so this costs nothing on
   * the ordinary path where `ctx` is present and this branch never runs.
   */
  if (!ctx) {
    const { userId } = await auth();
    redirect(userId ? "/onboarding" : "/sign-in");
  }

  const { tenant, user, role } = ctx;

  // `settings` is JSONB and may legitimately be missing the key.
  const industryValue = (tenant.settings as { industry?: unknown } | null)?.industry;
  const template = resolveIndustryTemplate(industryValue);

  /**
   * ⭐ TWO FILTERS, IN THIS ORDER — Section B, v0.53.0.
   *
   * 1. ROLE     — what this person is allowed to see
   * 2. PLAN     — what this workspace has actually bought
   *
   * Role first, deliberately. It means a missing entitlement can never be
   * the reason an admin-only item shows up for an ordinary member: by the
   * time the plan filter runs, everything it can see was already
   * permitted. Reversed, the two filters would still produce the right
   * answer today and would stop doing so the first time somebody made the
   * plan filter additive.
   *
   * ⚠️ ONE query, not thirty. `checkFeatures()` takes the whole key list
   * at once and `getEntitlementContext` is wrapped in React `cache()`, so
   * rendering the menu costs a single indexed read no matter how many
   * modules exist.
   *
   * ⚠️ AND NEITHER OF THESE IS THE SECURITY BOUNDARY. They decide what is
   * polite to show. Every gated route calls `requireFeature()` server-side
   * and must keep doing so — a hidden link is still a reachable URL.
   */
  const allowed = await checkFeatures(requiredFeatureKeys());

  const sections = filterNavigationByEntitlement(
    filterNavigationByRole(template.navigation, role),
    allowed,
  );

  return (
    <IndustryProvider
      industryKey={template.key}
      terminology={template.terminology}
      dashboard={template.dashboard}
      assetTypes={template.assetTypes}
    >
      <div className="flex h-screen overflow-hidden">
        <Sidebar
          sections={sections}
          industryLabel={template.label}
          tenantName={tenant.name}
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-5">
            <div className="flex items-center gap-3">
              <OrganizationSwitcher
                hidePersonal
                afterSelectOrganizationUrl="/dashboard"
              />
            </div>
            <div className="flex items-center gap-3">
              <span className="hidden text-sm text-muted-foreground sm:inline">
                {user.firstName ?? user.email}
              </span>
              <UserButton />
            </div>
          </header>

          <main className="flex-1 overflow-y-auto">{children}</main>
        </div>
      </div>
    </IndustryProvider>
  );
}
