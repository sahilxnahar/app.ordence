/**
 * Ordence — ⭐⭐ APPRAISAL CYCLES
 * Version: v1.47.0-alpha · Batch 109
 *
 * ⚠️ BEHIND THE HR READ KEY, WHICH IS DELIBERATELY IN NO DEFAULT ROLE.
 * An ordinary member reaching this page is refused, and should be — the
 * whole register is everybody's rating. The door that IS open to them is
 * `/hr/me`, which shows one person's appraisal and their own line, and
 * is a different endpoint reading different queries.
 */

import Link from "next/link";
import { listAppraisalCycles, getOrgChart } from "@/server/actions/appraisals";
import { CycleList } from "@/components/hr/cycle-list";

export const dynamic = "force-dynamic";
export const metadata = { title: "Appraisal cycles · Ordence" };

export default async function AppraisalCyclesPage() {
  const result = await listAppraisalCycles();

  if (!result.ok) {
    return (
      <main className="mx-auto w-full max-w-3xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">Appraisal cycles</h1>
        <p className="text-sm text-destructive">{result.error}</p>
        <p className="text-sm text-muted-foreground">
          Your own appraisal is at{" "}
          <Link href="/hr/me" className="underline">
            My appraisal
          </Link>
          , which needs no permission.
        </p>
      </main>
    );
  }

  /*
    ⚠️ `canManage` COMES FROM A SECOND CALL RATHER THAN FROM A PROP THE
    BROWSER COULD SET. It is used to hide a form, and hiding a form is
    cosmetic — every action re-checks, because a `"use server"` export is
    a URL whether or not anything renders a button for it.
  */
  const chart = await getOrgChart();
  const canManage = chart.ok ? chart.data.canManage : false;

  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Appraisal cycles</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          A cycle is a review period plus the people in it. Reviewers are taken from the{" "}
          <Link href="/hr/org-chart" className="underline">
            reporting lines
          </Link>{" "}
          in force during the period and fixed at enrolment.
        </p>
      </div>

      <CycleList cycles={result.data} canManage={canManage} />

      <p className="text-xs text-muted-foreground">
        Nothing in this section changes anybody&rsquo;s pay. Ordence records the appraisal; an
        increment is entered on the payroll screen by whoever runs payroll.
      </p>
    </main>
  );
}
