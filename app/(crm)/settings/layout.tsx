/**
 * Ordence — Settings Layout
 * Version: v0.7.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THESE TABS ARE ROUTES AND NOT CLIENT-SIDE TAB PANELS
 * ══════════════════════════════════════════════════════════════════════
 * A client-side <Tabs> would mount all three panels in one component,
 * which means one page load has to fetch the workspace record, the full
 * team list AND the financial configuration — even for someone who only
 * wanted to rename the workspace.
 *
 * As routes, each tab is its own server component that loads only what it
 * needs, and each one gets a real URL. That matters more than it sounds:
 * `/settings/team` can be bookmarked, linked to in a support reply, and
 * opened in a new tab. A client tab panel can do none of those.
 *
 * The visual treatment is still a tab strip, because that is what people
 * expect settings to look like.
 */

import Link from "next/link";
import { SettingsTabs } from "./settings-tabs";

export const dynamic = "force-dynamic";

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-4xl p-6">
      <div className="mb-5">
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Workspace configuration, people and financial defaults.
        </p>
      </div>

      <SettingsTabs />

      <div className="mt-6">{children}</div>

      <p className="mt-10 border-t border-border pt-4 text-xs text-muted-foreground">
        Changes here are recorded in the audit log with your name against them.{" "}
        <Link href="/dashboard" className="underline underline-offset-2">
          Back to dashboard
        </Link>
      </p>
    </main>
  );
}
