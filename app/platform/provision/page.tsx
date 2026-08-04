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

import Link from "next/link";
import { redirect } from "next/navigation";
import {
  planProvision,
  provisionTenant,
  listIndustryPacks,
} from "@/server/platform/provisioning";
import { requireCapability } from "@/server/platform/guard";
import { ProvisionWizard } from "@/components/platform/provision-wizard";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Provision a workspace · Ordence Platform",
  robots: { index: false, follow: false },
};

export default async function ProvisionPage() {
  try {
    await requireCapability("tenants:provision");
  } catch {
    // A grade without this capability should not learn the page exists.
    redirect("/platform");
  }

  const industries = await listIndustryPacks();

  return (
    <div className="space-y-6 p-6">
      <header className="space-y-1">
        <nav className="text-sm text-muted-foreground">
          <Link href="/platform" className="hover:underline">
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

      <ProvisionWizard
        industries={industries}
        planAction={planProvision}
        provisionAction={provisionTenant}
      />
    </div>
  );
}
