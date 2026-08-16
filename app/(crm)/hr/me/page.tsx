/**
 * Ordence — ⭐⭐⭐ MY APPRAISAL
 * Version: v1.47.0-alpha · Batch 109
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS ROUTE IS `/hr/me` AND NOT `/hr/appraisals/[subjectId]`
 * ══════════════════════════════════════════════════════════════════════
 * A URL WITH AN ID IN IT IS A URL SOMEBODY CAN EDIT. `/hr/me` has
 * nothing to change: the identity is resolved on the server by
 * `myAppraisals()`, which takes no arguments at all — not "takes an id
 * and checks it", takes nothing. A screen that cannot be pointed at
 * anybody cannot be pointed at the wrong body.
 *
 * ⚠️ AND THE ROUTE IS NOT THE CONTROL EITHER WAY. The guard is on the
 * action, because a server action is a POST to whatever URL the browser
 * happens to be on. This page renders what the action returned and
 * decides nothing.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE REST OF `/hr` REFUSES THIS READER, AND THAT IS CORRECT
 * ══════════════════════════════════════════════════════════════════════
 * `/hr/appraisals` is the whole register and sits behind the HR read
 * key, which is deliberately in no default role. This page is the one
 * door in the section that is open to an ordinary employee, and it opens
 * onto exactly the rows that name them.
 */

import { myAppraisals } from "@/server/actions/appraisals";
import { MyAppraisals } from "@/components/hr/my-appraisals";

export const dynamic = "force-dynamic";
export const metadata = { title: "My appraisal · Ordence" };

export default async function MyAppraisalPage() {
  /*
    ⚠️ NO `searchParams`, NO `params`, NOTHING FROM THE REQUEST. This
    page reads one thing and reads it with no input. If a future edit
    needs a filter, the filter belongs inside the action alongside the
    scoping — anything the browser can supply is a value somebody can
    change, and on this screen the only value that matters is who is
    asking.
  */
  const result = await myAppraisals();

  if (!result.ok) {
    return (
      <main className="mx-auto w-full max-w-3xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">My appraisal</h1>
        <p className="text-sm text-destructive">{result.error}</p>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">My appraisal</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Your own appraisal, and the appraisals of the people whose reviewer you are. Nobody
          else&rsquo;s is reachable from this page, and yours is not reachable from anybody
          else&rsquo;s.
        </p>
      </div>

      <MyAppraisals view={result.data} />

      <p className="text-xs text-muted-foreground">
        A skip-level review is read by HR and by the skip-level manager only. It is never shown
        to the person being reviewed or to their direct manager — that is what makes it a check
        on the manager rather than a second manager review.
      </p>
    </main>
  );
}
