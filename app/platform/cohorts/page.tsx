/**
 * Ordence — Platform Console · ⭐⭐ COHORTS
 * Version: v1.52.0-alpha
 * Runtime: Node
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ IS ONBOARDING GETTING BETTER OR WORSE?
 * ══════════════════════════════════════════════════════════════════════
 * "Onboarding progress" answers a question about today: which workspace
 * has stalled while a phone call still works. It cannot answer whether
 * the last three months of changes helped, because a snapshot of the
 * currently-stuck has no memory. This screen groups every workspace by
 * the month it joined and reports, per month, how many finished, how many
 * are still alive, and how long finishing took.
 *
 * ⚠️ THE COMPLETION RULE IS NOT RESTATED HERE. It is
 * `hasCompletedOnboarding()` in `lib/platform/onboarding-progress.ts` —
 * the module batch 122 landed — used by the cohort maths itself. Two
 * screens that must agree about "completed" by discipline is exactly the
 * defect that produced migration 0091.
 *
 * ⚠️ NO POLLING. A cohort moves once a month. `refreshMs` exists on the
 * table and is deliberately unused.
 */

import { listWorkspaceCohorts } from "@/server/platform/cohorts";
import { CohortTable } from "@/components/platform/cohort-table";
import { consoleHref, onConsoleHost } from "@/lib/platform/console-href";
import { STALL_THRESHOLD_DAYS } from "@/lib/platform/onboarding-progress";
import { Card, CardContent } from "@/components/ui/card";
import Link from "next/link";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Cohorts · Ordence Platform",
  robots: { index: false, follow: false },
};

export default async function CohortsPage() {
  const [result, isConsole] = await Promise.all([listWorkspaceCohorts(), onConsoleHost()]);

  if (!result.ok) {
    return (
      <Card>
        <CardContent className="pt-6 text-sm text-destructive">{result.error}</CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Cohorts</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Every workspace grouped by the month it joined, cut on Indian Standard
          Time so the months match the sales calendar. Read down a column to see
          whether onboarding is improving; read across a row to see how small
          the month was before believing it.{" "}
          <Link
            href={consoleHref("/platform/onboarding", isConsole)}
            className="underline underline-offset-2"
          >
            Onboarding progress
          </Link>{" "}
          is the other half: this screen says whether the last three months
          helped, that one says which workspace is {STALL_THRESHOLD_DAYS}+ days
          stuck right now and can still be rescued.
        </p>
      </div>

      <CohortTable
        rows={result.data.rows}
        totalWorkspaces={result.data.totalWorkspaces}
        truncated={result.data.truncated}
      />
    </div>
  );
}
