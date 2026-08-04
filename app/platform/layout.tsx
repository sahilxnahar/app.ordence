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

import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { getPlatformOperator } from "@/server/platform/guard";
import { getActiveImpersonation } from "@/server/platform/impersonation";
import { stopImpersonationAction } from "@/server/platform/actions";
import { LiveImpersonationBanner } from "@/components/platform/impersonation-banner-live";
import { GRADE_LABELS } from "@/lib/platform/roles";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

/**
 * ⚠️ THIS LIST IS NOT AN ACCESS CONTROL.
 *
 * Every one of these pages guards itself with `requireCapability()`, and
 * each server action behind them guards itself again. Hiding a link from a
 * grade that cannot use it is a courtesy — it stops support staff clicking
 * into a redirect — not a boundary. A link nobody can see is still a URL
 * anybody can type.
 *
 * Observatory sits second because it is the screen you want to open first:
 * churn alarms before workspaces.
 */
const NAV = [
  { href: "/platform", label: "Workspaces" },
  // Sits beside the directory rather than inside it: the directory
  // answers "find me Acme", this answers "who needs me today?" — see the
  // header of `app/platform/tenants/page.tsx`.
  { href: "/platform/tenants", label: "Needs attention" },
  { href: "/platform/observatory", label: "Observatory" },
  { href: "/platform/provision", label: "Provision" },
  { href: "/platform/sessions", label: "Sessions" },
  { href: "/platform/search", label: "Search" },
  { href: "/platform/log", label: "Action register" },
  { href: "/platform/staff", label: "Staff access" },
] as const;

export default async function PlatformLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const operator = await getPlatformOperator();

  // Fail closed, and fail SILENTLY. No message, no hint, no redirect that
  // names the console.
  if (!operator) notFound();

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
              <Link key={item.href} href={item.href} className="hover:underline">
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
      mode={active.mode}
      minutesLeft={active.minutesLeft}
      expiresAt={active.expiresAt.toISOString()}
      onEnd={stopImpersonationAction}
    />
  );
}
