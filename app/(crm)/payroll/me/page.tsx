/**
 * Ordence — ⭐⭐⭐ EMPLOYEE SELF-SERVICE
 * Version: v1.43.0-alpha · Batch 107
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS ROUTE IS `/payroll/me` AND NOT `/payroll/employees/[id]`
 * ══════════════════════════════════════════════════════════════════════
 * There is already a payroll section, and the obvious place for "an
 * employee's payslips" is under it, keyed by employee id. That route
 * would be wrong here for one reason: A URL WITH AN ID IN IT IS A URL
 * SOMEBODY CAN EDIT.
 *
 * `/payroll/me` has nothing to change. The identity is resolved on the
 * server from the session, by `myPayslips()`, which takes no arguments
 * at all. Not "takes an id and checks it" — takes nothing. A screen that
 * cannot be pointed at anybody is a screen that cannot be pointed at the
 * wrong body.
 *
 * ⚠️ `me` SITS BESIDE `[id]`, AND THE STATIC SEGMENT WINS. Next.js
 * matches a literal path segment ahead of a dynamic one, so `/payroll/me`
 * reaches this file and never `payroll/[id]/page.tsx`. Worth stating
 * because the failure would be silent and backwards: an employee would
 * land on the run detail screen, which calls `getPayrollRun` behind
 * `payroll.read` — a refusal rather than a leak, but a refusal nobody
 * could explain. If this route is ever renamed, rename it to something
 * that is still not a uuid.
 *
 * ⚠️ AND THE ROUTE IS NOT THE CONTROL EITHER WAY. The guard is on the
 * action, because a server action is a POST to whatever URL the browser
 * happens to be on — the same reason `app/(crm)/payroll/page.tsx` says
 * it in its own header. This page renders what the action returned and
 * decides nothing.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE REST OF `/payroll` REFUSES THIS READER, AND THAT IS CORRECT
 * ══════════════════════════════════════════════════════════════════════
 * `payroll.read` is deliberately in no default role — salary is the one
 * figure people quit over knowing. So an ordinary member reaching
 * `/payroll` sees a refusal, and should. This page is the one door in
 * the payroll section that is open to them, and it opens onto exactly
 * one person's data.
 */

import Link from "next/link";
import { myPayslips } from "@/server/actions/payroll-self";
import { MyPayslips } from "@/components/payroll/my-payslips";

export const dynamic = "force-dynamic";
export const metadata = { title: "My payslips · Ordence" };

export default async function MyPayrollPage() {
  /*
    ⚠️ NO `searchParams`, NO `params`, NOTHING FROM THE REQUEST. This
    page reads one thing and it reads it with no input. If a future edit
    needs a filter, the filter belongs inside the action alongside the
    scoping — anything the browser can supply is a value somebody can
    change, and on this screen the only value that matters is who is
    asking.
  */
  const result = await myPayslips();

  if (!result.ok) {
    return (
      <main className="mx-auto w-full max-w-3xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">My payslips</h1>
        <p className="text-sm text-destructive">{result.error}</p>
      </main>
    );
  }

  const view = result.data;

  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">My payslips</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Your own pay, and only yours. Nobody else&rsquo;s payslip is reachable from this page,
          and yours is not reachable from anybody else&rsquo;s.
        </p>
      </div>

      {/*
        ⭐ THE ONE THING THE PRIVILEGE CHANGES ON THIS SCREEN IS A LINK.

        ⚠️ AN HR USER LOOKS AT THEIR OWN TWO PAYSLIPS AND CONCLUDES THE
        PRODUCT IS BROKEN. They hold `payroll.read`, they expect to see
        the company, and this page will never show it to them — because
        widening the same endpoint for a privileged caller is the exact
        mistake `server/actions/payroll-self.ts` is arranged to make
        impossible. So the answer is a signpost to the screen that DOES
        show everyone, guarded by its own permission, reading its own
        queries.
      */}
      {view.canSeeEveryone ? (
        <p className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
          You also hold the payroll permission. This page still shows only your own record — for
          everybody&rsquo;s, go to{" "}
          <Link href="/payroll" className="underline">
            Payroll
          </Link>
          .
        </p>
      ) : null}

      <MyPayslips view={view} />

      {/*
        ⚠️ WHO TO ASK, STATED ON THE SCREEN. Every figure here was
        computed from an employee record and a set of statutory rates
        that this reader cannot see and must not be able to edit. A
        payslip query with nowhere to go becomes an email to whoever
        answered last time.
      */}
      <p className="text-xs text-muted-foreground">
        Something look wrong? Nothing on this page can be edited here — a payslip is frozen once
        the run is signed off, and a correction means payroll raising a new run rather than
        changing an old figure. Take it to whoever runs payroll, with the payroll reference from
        the payslip.
      </p>
    </main>
  );
}
