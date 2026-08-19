/**
 * Ordence — Platform Console Shell
 * Version: v0.14.0-alpha
 * Runtime: Node (needs the database and the Clerk backend)
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE SECOND GATE. THE FIRST ONE IS NOT ENOUGH ON ITS OWN.
 * ══════════════════════════════════════════════════════════════════════
 * `middleware.ts` already refuses `/platform(.*)` to anyone whose Clerk
 * session claim does not say `platformAdmin`. This layout re-decides from
 * scratch, and the duplication is the point:
 *
 *   • The middleware check trusts a JWT claim whose forgeability depends
 *     on the Clerk JWT template (see `lib/platform/roles.ts`). If that
 *     template ever maps `unsafe_metadata`, the route check becomes
 *     self-service.
 *
 *   • A server action invoked from this console is NOT protected by the
 *     route matcher at all — it is a POST to whatever page the browser is
 *     on. So the gate has to live on the functions anyway, and a layout
 *     that relied on middleware would be the only piece not re-checking.
 *
 * `getPlatformOperator()` requires BOTH keys — the env allowlist and an
 * active `platform_staff` row. It is `cache()`d, so the pages below reuse
 * this resolution rather than repeating the Clerk round-trip.
 *
 * ⚠️ `notFound()`, NOT `redirect("/access-denied")`. A 404 tells a prober
 * nothing about whether the console exists; a bespoke denial page
 * confirms it does and that they were close.
 */

import { consoleHref, onConsoleHost } from "@/lib/platform/console-href";
import { CONSOLE_NAV } from "@/lib/platform/console-paths";
import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { getPlatformOperator } from "@/server/platform/guard";
import { getActiveImpersonation } from "@/server/platform/impersonation";
import {
  stopImpersonationAction,
  liftImpersonationScopeAction,
} from "@/server/platform/actions";
import { LiveImpersonationBanner } from "@/components/platform/impersonation-banner-live";
import { GRADE_LABELS } from "@/lib/platform/roles";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

/**
 * ⚠️ THE NAV LIST MOVED TO `lib/platform/console-paths.ts` AND IS NOT
 * RETYPED HERE. It is rendered below and it is also what the command
 * palette jumps to, and two hand-maintained copies is a palette that
 * silently stops matching the nav bar the first time somebody adds a
 * screen.
 *
 * It did NOT move into this file's exports, deliberately: a client
 * component importing from `app/platform/layout.tsx` would drag
 * `server/platform/guard.ts` (server-only) into the browser bundle and
 * fail the webpack build. The shared module imports nothing privileged,
 * so both sides can have it.
 *
 * ⚠️ IT IS STILL NOT AN ACCESS CONTROL. Every one of these pages guards
 * itself with `requireCapability()`, and each server action behind them
 * guards itself again. Hiding a link from a grade that cannot use it is a
 * courtesy — it stops support staff clicking into a redirect — not a
 * boundary. A link nobody can see is still a URL anybody can type.
 */
const NAV = CONSOLE_NAV;

/**
 * ⚠️ THE NAV ABOVE IS WRITTEN IN CANONICAL `/platform/...` PATHS, WHICH
 * ARE THE PATHS THAT EXIST ON DISK. `consoleHref` maps them onto the form
 * THIS host actually serves. On `admin.` the middleware already rewrites
 * `/x` to `/platform/x`, so a link to `/platform/x` there is not a
 * rewritten path, falls through to tenant resolution, and lands on a 404.
 * That is why every link in this console used to be broken.
 */
export default async function PlatformLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const operator = await getPlatformOperator();

  // Fail closed, and fail SILENTLY. No message, no hint, no redirect that
  // names the console.
  if (!operator) notFound();

  // ⚠️ READ THE HOST ONCE, HERE. Every link below is written in the
  // canonical `/platform/...` form and mapped onto whatever this host
  // actually serves. See `lib/platform/console-href.ts` for the 404 chain
  // this prevents.
  const isConsole = await onConsoleHost();

  return (
    <div className="min-h-screen bg-background">
      {/*
        The banner streams separately. It reads the live session and can
        terminate it on an IP mismatch, which is a database round-trip —
        blocking the whole console on it would make every page in the
        support tool slower during the incident when it matters most.
      */}
      <Suspense fallback={null}>
        <ImpersonationBannerSlot />
      </Suspense>

      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-4 px-4 py-3">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5" aria-hidden />
            <span className="font-semibold">Platform console</span>
          </div>

          <nav className="flex items-center gap-4 text-sm">
            {NAV.map((item) => (
              <Link key={item.href} href={consoleHref(item.href, isConsole)} className="hover:underline">
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
            <span>{operator.email}</span>
            <Badge variant="outline">{GRADE_LABELS[operator.grade]}</Badge>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-6 px-4 py-6">{children}</main>

      <footer className="mx-auto max-w-7xl px-4 pb-8 text-xs text-muted-foreground">
        Every action here is recorded against {operator.email}. Anything aimed at one
        workspace also appears in that customer&rsquo;s own audit log.
      </footer>
    </div>
  );
}

/**
 * Separated so the banner can suspend independently, and so a failure to
 * resolve the session cannot take down the console — an operator who
 * cannot load the page cannot end the session they are worried about.
 */
async function ImpersonationBannerSlot() {
  // ⚠️ Read from the DATABASE by the operator's Clerk id — never from a
  // cookie. A cookie saying "you are impersonating Acme" IS a credential:
  // steal it, replay it, you are inside Acme. This also makes revocation
  // immediate, because there is no client-held token to expire.
  //
  // Throwing here would take down the whole console for an operator who
  // is not staff at all; the layout has already refused those, but the
  // banner must not be the thing that decides.
  const active = await getActiveImpersonation().catch(() => null);
  if (!active) return null;

  return (
    <LiveImpersonationBanner
      sessionId={active.sessionId}
      tenantName={active.tenantName}
      tenantSlug={active.tenantSlug}
      scope={active.scope}
      grantedScope={active.grantedScope}
      mode={active.mode}
      minutesLeft={active.minutesLeft}
      expiresAt={active.expiresAt.toISOString()}
      reason={active.justification}
      writeAccessReason={active.scopeLiftReason}
      onEnd={stopImpersonationAction}
      onLift={liftImpersonationScopeAction}
    />
  );
}
