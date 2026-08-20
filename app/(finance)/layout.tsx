/**
 * Ordence — The finance surface
 * Wave 15 / Track E — GST, TDS and statutory correctness
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHY A SECOND AUTHENTICATED ROUTE GROUP AND NOT A FOLDER IN `(crm)`
 * ══════════════════════════════════════════════════════════════════════
 * Everything under here is a WORKING PAPER: a screen a chartered
 * accountant opens to answer "why is this number what it is", printed,
 * annotated and handed to somebody who was not in the room. `(crm)` is
 * the operator's surface — it optimises for doing the next thing. Those
 * are different jobs and, in time, different chrome.
 *
 * ⚠️ IT IS NOT A SECOND SECURITY MODEL, AND MUST NEVER BECOME ONE. This
 * file resolves the tenant exactly the way `app/(crm)/layout.tsx` does,
 * through `getTenantContext()`, and it applies the same session policy
 * through the same pure `evaluateSession()`. A route group that resolved
 * identity its own way is how two surfaces come to disagree about who is
 * signed in — and the one that disagrees quietly is the one that leaks.
 *
 * ⚠️ THE LAYOUT IS NOT THE BOUNDARY EITHER. Every page below re-decides
 * server-side (`requirePageContext()`, `can()`, and the permission gate
 * inside each reader). A rendered shell proves nothing about what the
 * caller may read.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE DUPLICATION HERE IS REAL, IS THE MINIMUM, AND IS WRITTEN DOWN
 * ══════════════════════════════════════════════════════════════════════
 * The tenant resolution, the session verdict, the two-filter navigation
 * and the two safety banners below are the same shape as `(crm)`. Track E
 * may not write `components/**`, so the honest fix — lifting this shell
 * into `components/layout/app-shell.tsx` and having BOTH groups render it
 * — is a patch request, recorded in PATCH-REQUEST-E.md.
 *
 * Until then the rule for anybody editing either file is: a change to the
 * auth or session logic in one is a change to the other. They are two
 * copies of one decision, and the copy nobody updated is the bug.
 *
 * ⚠️ THE SUPPORT-ACCESS AND MAINTENANCE NOTICES ARE HERE ON PURPOSE.
 * Leaving them out would have been less code and would have meant that a
 * customer whose workspace one of our staff is sitting inside sees the
 * notice on every CRM screen and NOT on the screen that shows their tax
 * reasoning. A notice with a hole in it is worse than no notice, because
 * people learn to trust it.
 */

import { Suspense } from "react";
import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { OrganizationSwitcher, UserButton } from "@clerk/nextjs";

import { getTenantContext, ADMIN_ROLES } from "@/server/tenant-context";
import {
  evaluateSession,
  readFactorEvidence,
  readSessionExpiryMs,
  readSessionPolicy,
} from "@/lib/security/session-policy";
import {
  resolveIndustryTemplate,
  filterNavigationByRole,
} from "@/lib/industry-templates";
import { checkFeatures } from "@/server/entitlements";
import { requiredFeatureKeys } from "@/lib/modules/registry";
import { filterNavigationByEntitlement } from "@/lib/modules/nav";
import { parseAppearancePreferences } from "@/lib/appearance/preferences";
import { effectiveMaintenance } from "@/server/platform/maintenance";
import { remainingMs } from "@/lib/platform/maintenance-policy";
import { activeSupportAccessForTenant } from "@/server/platform/tenant-support-access";
import {
  endSupportSessionAction,
  leaveSupportSessionAction,
} from "@/server/actions/support-access";

import { Sidebar } from "@/components/layout/sidebar";
import { MobileSidebar, MobileMenuTrigger } from "@/components/layout/mobile-sidebar";
import { IndustryProvider } from "@/components/layout/industry-provider";
import { NotificationBell } from "@/components/layout/notification-bell";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { ThemeSync } from "@/components/layout/theme-provider";
import { SupportAccessBanner } from "@/components/platform/support-access-banner";
import { MaintenanceBanner } from "@/components/platform/maintenance-banner";

import type { SystemRole } from "@/db/schema";

export const dynamic = "force-dynamic";

export default async function FinanceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const ctx = await getTenantContext();

  /**
   * ⚠️ TWO DESTINATIONS, ONE HOP EACH, MATCHING `(crm)` AND
   * `requirePageContext()` EXACTLY.
   *
   * No session at all → `/sign-in`, which is where the middleware would
   * have sent it. A session with no workspace → `/onboarding`, which the
   * middleware leaves alone. Sending both to `/onboarding` produces a
   * two-hop redirect chain on an RSC fetch, and the App Router client
   * cannot follow one — it surfaces to the user as "a client-side
   * exception has occurred", on the way OUT of the product. The argument
   * in full is in `app/(crm)/layout.tsx`.
   */
  if (!ctx) {
    const { userId } = await auth();
    redirect(userId ? "/onboarding" : "/sign-in");
  }

  const { tenant, user, role } = ctx;

  /**
   * ⭐ THE WORKSPACE'S OWN SECURITY SETTINGS, ENFORCED HERE TOO.
   *
   * `evaluateSession` is pure and lives in `lib/security/session-policy.ts`
   * so the edge middleware, `(crm)` and this group cannot come to three
   * different answers about whether a session is still good. If this
   * surface skipped the check, "require MFA" would hold everywhere except
   * the screen that shows the tax reasoning — which is precisely the
   * screen somebody would go looking for.
   */
  const { sessionClaims } = await auth();
  const sessionVerdict = evaluateSession({
    policy: readSessionPolicy(tenant.settings),
    factors: readFactorEvidence(sessionClaims),
    // 🔴 THE SERVER'S CLOCK, NEVER A CLIENT TIMESTAMP.
    nowMs: Date.now(),
    sessionExpiresAtMs: readSessionExpiryMs(sessionClaims),
  });
  if (sessionVerdict.outcome !== "allow" && sessionVerdict.redirectTo) {
    redirect(`${sessionVerdict.redirectTo}?reason=${sessionVerdict.outcome}`);
  }

  // `settings` is JSONB and may legitimately be missing the key.
  const industryValue = (tenant.settings as { industry?: unknown } | null)?.industry;
  const template = resolveIndustryTemplate(industryValue);

  /**
   * ⚠️ ROLE FIRST, THEN PLAN — the same order as `(crm)`, for the same
   * reason. Role first means a missing entitlement can never be the
   * reason an admin-only item appears for an ordinary member.
   *
   * ⚠️ AND NEITHER FILTER IS THE SECURITY BOUNDARY. They decide what is
   * polite to show; a hidden link is still a reachable URL, and every
   * page below re-decides.
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
      <div className="flex h-screen flex-col overflow-hidden">
        {/*
          ⚠️ BOTH NOTICES SUSPEND SEPARATELY AND BOTH SWALLOW THEIR OWN
          READ ERROR. Blocking the shell on either would slow every page
          here for a query that returns no rows almost always, and a
          failed read must not take a workspace's books offline. What
          actually constrains an operator, and what actually refuses a
          write during maintenance, is re-decided server-side.
        */}
        <Suspense fallback={null}>
          <SupportAccessSlot
            tenantId={tenant.id}
            role={role}
            impersonationId={ctx.impersonationId}
          />
        </Suspense>

        <Suspense fallback={null}>
          <MaintenanceNotice tenantId={tenant.id} />
        </Suspense>

        {/*
          ⭐ THE SERVER VALUE OVERRIDES THE PAINT-FLASH CACHE. The theme
          in `localStorage` belongs to ONE BROWSER; this row belongs to
          the PERSON. No extra query — `ctx.user` is already resolved.
        */}
        <ThemeSync serverTheme={parseAppearancePreferences(user.preferences).theme} />

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
                <ThemeToggle />
                <UserButton />
              </div>
            </header>

            {/*
              ⚠️ `#main-content` IS THE SKIP-LINK TARGET.
              `components/layout/accessibility.tsx` renders the anchor and
              its href must resolve to exactly this id — the same contract
              `(crm)` keeps.

              ⚠️ NO `<CommandBar />` AND NO `<SearchTrigger />` HERE, and
              that is a deliberate omission rather than an oversight. Both
              are `(crm)` navigation aids whose results are `(crm)` URLs;
              mounting them would put a second keydown listener and a
              second search implementation on a surface that has two
              pages. Add them the day this group has something to search.
            */}
            <main id="main-content" className="flex-1 overflow-y-auto">
              {children}
            </main>
          </div>
        </div>
      </div>
    </IndustryProvider>
  );
}

/**
 * ⭐ WHO IS LOOKING DECIDES WHICH BUTTON THEY GET — operator LEAVES,
 * owner ENDS OUR ACCESS, everybody else gets the notice with no button.
 * The reasoning, including the case against giving an owner the control
 * at all, is at `endSessionForTenantOwner()`.
 *
 * ⚠️ THE ROLE CHECK IS POLITENESS, NOT AUTHORISATION. Both actions
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
  // ⚠️ A FAILED READ MUST NOT TAKE THE WORKSPACE DOWN.
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
 * 🔴 A NOTICE, NOT THE CONTROL. The writes are refused in
 * `server/platform/maintenance.ts`. Delete this component and the product
 * is still read-only — it is just read-only without telling anybody.
 *
 * ⚠️ THE REMAINING TIME IS DERIVED ON THE SERVER FROM THE STORED END
 * TIMESTAMP ON EVERY RENDER, and the client re-derives from the same
 * absolute value. Neither side decrements a held number, so a tab left
 * open overnight cannot lengthen or shorten the window it shows.
 */
async function MaintenanceNotice({ tenantId }: { tenantId: string }) {
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
