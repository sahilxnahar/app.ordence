/**
 * Ordence — ⭐⭐ ONE APPRAISAL CYCLE, THE WHOLE REGISTER
 * Version: v1.47.0-alpha · Batch 109
 *
 * ⚠️ THERE IS A UUID IN THIS URL AND IT IS NOT THE CONTROL. The action
 * behind it, `getAppraisalRegister`, is guarded by the HR read key and
 * scopes the query to the caller's tenant; the id only chooses which
 * cycle inside that tenant. A cycle id from another workspace returns
 * nothing, because the tenant predicate is in the `and(...)` and RLS
 * refuses it besides.
 *
 * 🔴 THE SCREEN THAT MUST NOT HAVE AN ID IS `/hr/me`, and it does not.
 * That one is scoped by WHO IS ASKING rather than by a key, so a value
 * the browser supplies would be the whole attack.
 */

import Link from "next/link";
import { getAppraisalRegister } from "@/server/actions/appraisals";
import { AppraisalBoard } from "@/components/hr/appraisal-board";

export const dynamic = "force-dynamic";
export const metadata = { title: "Appraisal cycle · Ordence" };

export default async function AppraisalCyclePage({
  params,
}: {
  params: Promise<{ cycleId: string }>;
}) {
  const { cycleId } = await params;
  const result = await getAppraisalRegister({ cycleId });

  if (!result.ok) {
    return (
      <main className="mx-auto w-full max-w-4xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">Appraisal cycle</h1>
        <p className="text-sm text-destructive">{result.error}</p>
        <Link href="/hr/appraisals" className="text-sm underline">
          Back to cycles
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">{result.data.cycle.name}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          <Link href="/hr/appraisals" className="underline">
            All cycles
          </Link>{" "}
          ·{" "}
          <Link href="/hr/org-chart" className="underline">
            Org chart
          </Link>
        </p>
      </div>

      <AppraisalBoard register={result.data} />
    </main>
  );
}
