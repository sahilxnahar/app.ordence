/**
 * Ordence — ⭐⭐ THE ORG CHART
 * Version: v1.47.0-alpha · Batch 109
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE CHART IS NOT FILTERED TO THE READER'S OWN BRANCH, AND THAT IS A
 *    DECISION RATHER THAN AN OMISSION
 * ══════════════════════════════════════════════════════════════════════
 * Who reports to whom is on an induction handout. The question people
 * open a chart to answer — "who do I escalate this to" — is precisely
 * about the branch they are not in, so narrowing it to their own line
 * would leave a list of their immediate colleagues and no chart.
 *
 * 🔴 APPRAISALS ARE THE OPPOSITE AND ARE SOMEWHERE ELSE. `/hr/me` shows
 * a manager only the rows that name them as reviewer, narrowed in the
 * WHERE clause, because RLS scopes by tenant and every colleague's
 * appraisal is in the same tenant.
 *
 * ⚠️ THE PAGE TAKES NOTHING FROM THE REQUEST. No `params`, no
 * `searchParams`. The guard is on the action, because a server action is
 * a POST to whatever URL the browser happens to be on.
 */

import Link from "next/link";
import { getOrgChart } from "@/server/actions/appraisals";
import { OrgChartBoard } from "@/components/hr/org-chart";

export const dynamic = "force-dynamic";
export const metadata = { title: "Org chart · Ordence" };

export default async function OrgChartPage() {
  const result = await getOrgChart();

  if (!result.ok) {
    return (
      <main className="mx-auto w-full max-w-4xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">Org chart</h1>
        <p className="text-sm text-destructive">{result.error}</p>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Org chart</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The reporting hierarchy as it stands today. A reporting change ends the current line
          and starts a new one; the old line is kept, because an appraisal for a past period is
          assigned from whoever held the line then.{" "}
          <Link href="/hr/appraisals" className="underline">
            Appraisal cycles
          </Link>
          .
        </p>
      </div>

      <OrgChartBoard view={result.data} />

      <p className="text-xs text-muted-foreground">
        Ordence refuses a reporting line that would make a loop — A reporting to B reporting to A
        — in the database as well as in the form, because a loop hangs every query that walks the
        chart and no foreign key has an opinion about it.
      </p>
    </main>
  );
}
