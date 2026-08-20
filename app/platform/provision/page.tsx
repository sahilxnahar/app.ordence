/**
 * Ordence — Platform Console · Provisioning
 * Version: v0.32.0-alpha
 *
 * One screen: describe a workspace, read exactly what will happen, approve.
 *
 * ⚠️ Guarded twice, and both are load-bearing. `requireCapability()` runs
 * here so the page cannot render for the wrong grade, and it runs AGAIN
 * inside `planProvision()` and `provisionTenant()` — because a server
 * action is a public HTTP endpoint whether or not a page ever links to it.
 * A guard on the page alone protects the button, not the door.
 */

import { consoleHref, onConsoleHost } from "@/lib/platform/console-href";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  planProvision,
  provisionTenant,
  listIndustryPacks,
} from "@/server/platform/provisioning";
import { requireCapability } from "@/server/platform/guard";
import { listPendingProvisions } from "@/server/platform/adopt-clerk-org";
import { ProvisionWizard } from "@/components/platform/provision-wizard";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Provision a workspace · Ordence Platform",
  robots: { index: false, follow: false },
};

export default async function ProvisionPage() {
  // ⚠️ The console is served at two base paths. See
  // `lib/platform/console-href.ts` , a `/platform/...` link on the
  // console host is not a rewritten path and lands on a 404.
  const isConsole = await onConsoleHost();

  try {
    await requireCapability("tenants:provision");
  } catch {
    // A grade without this capability should not learn the page exists.
    redirect("/platform");
  }

  const industries = await listIndustryPacks();

  /*
   * ⭐⭐ WAVE 1 , THE WORKSPACES THAT NEVER FINISHED.
   *
   * A workspace whose Clerk organisation was never created has a
   * hostname, a chart of accounts and NO WAY IN. Nothing about it looks
   * wrong from the outside, and until this list existed the only way to
   * find one was for a customer to complain.
   *
   * ⚠️ IT IS ON THE PROVISION PAGE ON PURPOSE, not on a separate screen.
   * The operator who is about to create a workspace is the one person
   * guaranteed to be looking at this page, and an unfinished provision is
   * most cheaply fixed by whoever is already in the middle of the task.
   */
  const stuck = await listPendingProvisions();

  return (
    <div className="space-y-6 p-6">
      <header className="space-y-1">
        <nav className="text-sm text-muted-foreground">
          <Link href={consoleHref("/platform", isConsole)} className="hover:underline">
            Platform
          </Link>
          <span className="px-2">/</span>
          <span>Provision</span>
        </nav>
        <h1 className="text-2xl font-semibold tracking-tight">
          Provision a workspace
        </h1>
        <p className="text-sm text-muted-foreground">
          Nothing is created until you have read the plan and approved it.
        </p>
      </header>

      {stuck.length > 0 ? (
        <section className="rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-900/60 dark:bg-amber-950/30">
          <h2 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
            {stuck.length} workspace{stuck.length === 1 ? "" : "s"} never finished provisioning
          </h2>
          <p className="mt-1 text-sm text-amber-900/80 dark:text-amber-200/80">
            These hold their address and their chart of accounts, and have no owner ,
            the Clerk organisation was never created. Nobody can sign in to them.
          </p>
          <ul className="mt-3 space-y-1 text-sm">
            {stuck.map((t) => (
              <li key={t.tenantId} className="flex items-baseline gap-3">
                <span className="font-medium">{t.slug}</span>
                <span className="text-muted-foreground">{t.name}</span>
                <span className="ml-auto tabular-nums text-xs text-muted-foreground">
                  {t.createdAt.slice(0, 10)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <ProvisionWizard
        industries={industries}
        planAction={planProvision}
        provisionAction={provisionTenant}
      />
    </div>
  );
}
