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

import { Suspense } from "react";
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
import { NotificationBell } from "@/components/layout/notification-bell";
import { CommandBar } from "@/components/layout/command-bar";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { MobileSidebar, MobileMenuTrigger, SearchTriggerBridge } from "@/components/layout/mobile-sidebar";
import { SearchTrigger } from "@/components/layout/search-trigger";
import { SupportAccessBanner } from "@/components/platform/support-access-banner";
import { MaintenanceBanner } from "@/components/platform/maintenance-banner";
import { effectiveMaintenance } from "@/server/platform/maintenance";
import { remainingMs } from "@/lib/platform/maintenance-policy";
import { activeSupportAccessForTenant } from "@/server/platform/tenant-support-access";
import {
  endSupportSessionAction,
  leaveSupportSessionAction,
} from "@/server/actions/support-access";
import { ADMIN_ROLES } from "@/server/tenant-context";
import type { SystemRole } from "@/db/schema";
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
      {/*
        ⚠️ Mounted at the layout, not per page, so ⌘K works everywhere inside
        `(crm)` including on a page that is still streaming. It renders
        nothing until opened — the Radix portal is empty while closed — so
        the cost of it being here is one keydown listener.
      */}
      <CommandBar />
      <SearchTriggerBridge />

      <div className="flex h-screen flex-col overflow-hidden">
        {/*
          ⭐⭐⭐ THE CUSTOMER'S OWN SUPPORT-ACCESS NOTICE — Batch 28.

          ══════════════════════════════════════════════════════════════
          🔴 IT IS IN THE LAYOUT, ABOVE EVERYTHING, ON EVERY SCREEN
          ══════════════════════════════════════════════════════════════
          Not on a settings page somebody would have to go and look at.
          The failure this prevents is a customer learning, weeks later
          and from an email they had filtered, that one of our staff was
          inside their workspace reading their payroll. The banner has to
          be where they already are.

          ⚠️ IT SUSPENDS SEPARATELY. Resolving the session is a database
          round trip, and blocking the entire CRM shell on it would slow
          every page in the product for a query that returns no rows on
          the overwhelming majority of requests.

          ⚠️ AND ITS FAILURE IS NOT THE APP'S FAILURE. `SupportAccessSlot`
          swallows a read error and renders nothing rather than taking the
          workspace down. That is the right trade — but it is also why the
          banner is a NOTICE and not a boundary. What actually constrains
          an operator is re-decided server-side on every request, in
          `getActiveImpersonation()` and `assertImpersonationAllows()`.
        */}
        <Suspense fallback={null}>
          <SupportAccessSlot
            tenantId={tenant.id}
            role={role}
            impersonationId={ctx.impersonationId}
          />
        </Suspense>

        {/*
          🔴 ABOVE THE FOLD AND ABOVE THE SIDEBAR, not tucked into a page.
          A person who lands directly on an edit form must meet this notice
          before they meet the form, or they will type into it.
        */}
        <Suspense fallback={null}>
          <MaintenanceNotice tenantId={tenant.id} />
        </Suspense>

        <div className="flex min-h-0 flex-1 overflow-hidden">
          <Sidebar
            sections={sections}
            industryLabel={template.label}
            tenantName={tenant.name}
          />
          <MobileSidebar
            sections={sections}
            industryLabel={template.label}
            tenantName={tenant.name}
          />

          <div className="flex min-w-0 flex-1 flex-col">
            <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-5">
              <div className="flex items-center gap-3">
                <MobileMenuTrigger />
                <OrganizationSwitcher
                  hidePersonal
                  afterSelectOrganizationUrl="/dashboard"
                />
              </div>
              <div className="flex items-center gap-3">
                <NotificationBell />
                <span className="hidden text-sm text-muted-foreground sm:inline">
                  {user.firstName ?? user.email}
                </span>
                {/*
                  Dark mode toggle — Wave 8b (v1.50.0-alpha). The palette
                  choice is a user preference saved on the device; it is
                  shown here next to the identity controls because the top
                  bar is the one place every authenticated screen shares.
                */}
                <ThemeToggle />
                <UserButton />
              </div>
            </header>
            {/*
              Site search to the top — Wave 8b. The global command bar
              (⌘K) opens from this control; see components/layout/
              search-trigger.tsx for why it is a button and not a second
              search implementation.
            */}
            <div className="flex shrink-0 items-center border-b border-border px-5 py-2">
              <SearchTrigger />
            </div>

            {/*
              #main-content is the skip-link target: components/layout/
              accessibility.tsx renders the skip anchor, and the anchor's
              href must resolve to exactly this id.
            */}
            <main id="main-content" className="flex-1 overflow-y-auto">{children}</main>
          </div>
        </div>
      </div>
    </IndustryProvider>
  );
}

/**
 * ⭐ WHO IS LOOKING DECIDES WHICH BUTTON THEY GET — and all three of them
 * are correct answers to different questions.
 *
 *   OPERATOR — our own staff, inside this workspace right now. Their
 *              button LEAVES, and is filed as `operator_ended`. It is
 *              here because the console layout is not rendered on CRM
 *              routes, so without it the only way out is to navigate back
 *              to `admin.` and find a control.
 *   OWNER    — an owner or admin of the workspace. Their button ENDS OUR
 *              ACCESS, and is filed as `revoked_by_tenant`. The argument
 *              for giving them this at all, including the case against
 *              it, is at `endSessionForTenantOwner()`.
 *   MEMBER   — everybody else. The notice, with no button, and a sentence
 *              telling them who at their own company can act on it.
 *
 * ⚠️ THE ROLE CHECK HERE IS POLITENESS, NOT AUTHORISATION. Both actions
 * re-decide server-side; `endSupportSession()` calls
 * `requireRole(ADMIN_ROLES)` and refuses an impersonated caller outright.
 */
async function SupportAccessSlot({
  tenantId,
  role,
  impersonationId,
}: {
  tenantId: string;
  role: SystemRole;
  impersonationId: string | null;
}) {
  // ⚠️ A FAILED READ MUST NOT TAKE THE WORKSPACE DOWN. The banner is a
  // notice; the enforcement is elsewhere and is unaffected by this
  // returning null.
  const notice = await activeSupportAccessForTenant(tenantId).catch(() => null);
  if (!notice) return null;

  const viewer =
    impersonationId === notice.sessionId
      ? ("operator" as const)
      : (ADMIN_ROLES as readonly SystemRole[]).includes(role)
        ? ("owner" as const)
        : ("member" as const);

  return (
    <SupportAccessBanner
      sessionId={notice.sessionId}
      operatorEmail={notice.operatorEmail}
      authority={notice.authority}
      mode={notice.mode}
      scope={notice.scope}
      reason={notice.reason}
      writeAccessReason={notice.writeAccessReason}
      expiresAt={notice.expiresAt}
      minutesLeft={notice.minutesLeft}
      viewer={viewer}
      onEnd={
        viewer === "operator"
          ? leaveSupportSessionAction
          : viewer === "owner"
            ? endSupportSessionAction
            : undefined
      }
    />
  );
}


/**
 * ⭐ THE CUSTOMER-FACING HALF OF MAINTENANCE MODE.
 *
 * 🔴 IT IS A NOTICE, NOT THE CONTROL. The writes are refused in
 * `server/platform/maintenance.ts`, one hop inside the same gate every
 * mutation already calls. If this component were deleted the product
 * would still be read-only — it would just be read-only without telling
 * anybody, which is the failure this exists to prevent.
 *
 * ⚠️ THE REMAINING TIME IS COMPUTED HERE, ON THE SERVER, FROM THE STORED
 * END TIMESTAMP, ON EVERY RENDER. The client re-derives it from the same
 * absolute timestamp; neither side ever decrements a held number, so a
 * tab left open overnight cannot extend or shorten the window it shows.
 */
async function MaintenanceNotice({ tenantId }: { tenantId: string }) {
  // ⚠️ A FAILED READ MUST NOT TAKE THE WORKSPACE DOWN, same argument as
  // the support banner above.
  const state = await effectiveMaintenance(tenantId).catch(() => null);
  const active = state?.active ?? null;
  if (!active) return null;

  return (
    <MaintenanceBanner
      scope={active.scope}
      endsAt={active.endsAt}
      message={active.message}
      remainingMsAtRender={remainingMs(active.endsAt)}
    />
  );
}
