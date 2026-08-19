/**
 * Ordence — ⭐⭐⭐ STATUTORY RATES
 * Version: v1.46.0-alpha · Batch 52
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE DOOR THAT DID NOT EXIST
 * ══════════════════════════════════════════════════════════════════════
 * `statutory_rates` has been effective-dated since Batch 15 and the only
 * thing that could write to it was `seedPayrollSetup`, once, never
 * overwriting. Everything after the seed — the Finance Act change that
 * arrives every February, the PF ceiling somebody typed with one zero
 * missing — was a code deploy or a psql prompt. This is the screen for
 * both, and the two are deliberately not the same screen.
 *
 * ⚠️ THE GUARD IS ON EVERY ACTION, NOT ON THIS ROUTE. A server action is
 * a POST to whatever URL the browser happens to be on, so rendering or
 * not rendering a button decides nothing. `listStatutoryRates` requires
 * `payroll.read`, `addRateRevision` requires `payroll.manage` and
 * `correctStatutoryRate` requires `payroll.manage` AND
 * `payroll.approve`. What this page does with `checkPermission` is
 * decide what to SHOW, which is a courtesy and not a control.
 *
 * ⭐ CORRECTION NEEDS TWO KEYS AND THE SECOND ONE IS THE SIGNATURE KEY.
 * `payroll.manage` is who maintains the rate table. `payroll.approve` is
 * who signs off a wage bill. A correction rewrites what was signed off,
 * so it needs both — the rate maintainer cannot silently restate
 * somebody else's approval.
 */

import Link from "next/link";
import {
  addRateRevision,
  correctStatutoryRate,
  listStatutoryRates,
} from "@/server/actions/statutory-rates";
import {
  RateSeriesTable,
  type RateSeries,
} from "@/components/payroll/rate-series-table";
import {
  RateRevisionForm,
  type SeriesOption,
} from "@/components/payroll/rate-revision-form";
import { checkPermission } from "@/server/audit";

export const dynamic = "force-dynamic";
export const metadata = { title: "Statutory rates · Ordence" };

export default async function StatutoryRatesPage() {
  const [rates, manage, approve] = await Promise.all([
    listStatutoryRates(),
    checkPermission("payroll.manage"),
    checkPermission("payroll.approve"),
  ]);

  if (!rates.ok) {
    return (
      <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">Statutory rates</h1>
        <p className="text-sm text-destructive">{rates.error}</p>
      </main>
    );
  }

  const series: readonly RateSeries[] = rates.data.series;

  /**
   * ⭐ THE ADD FORM IS PRE-FILLED FROM THE ROW IN FORCE TODAY.
   *
   * ⚠️ A rate change almost always moves ONE number out of seven. Making
   * somebody retype the other six is how the other six acquire typos,
   * and a typo in a PF pension rate produces a payslip that is wrong by
   * a plausible amount rather than an obviously broken one.
   */
  const options: SeriesOption[] = series.map((s) => {
    const live = s.rows.find((r) => r.inForceToday) ?? s.rows[0];
    return {
      key: s.key,
      kind: s.kind,
      scope: s.scope,
      label: s.label,
      templateJson: live ? JSON.stringify(live.payload, null, 2) : "{}",
    };
  });

  const overlapCount = series.reduce(
    (n, s) => n + s.rows.filter((r) => r.overlapsWith.length > 0).length,
    0,
  );

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div>
        <Link href="/payroll" className="text-xs underline">
          Payroll
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">Statutory rates</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Provident fund, ESI, professional tax and income tax, each as a series of dated rows.
          A payroll run reads the rows in force on its own period end, so a March run computed in
          September still uses March&apos;s ceiling. Rates in force on {rates.data.asOf} are
          marked.
        </p>
      </div>

      {/*
        🔴 THE SENTENCE THIS WHOLE BATCH IS ABOUT, SAID AT THE TOP.
        Somebody arriving here wants to change a number. What they need
        to know before they start is that there are two different things
        they might be doing and only one of them is safe.
      */}
      <div className="rounded border p-3 text-xs">
        <p className="font-semibold">A change and a correction are different things.</p>
        <p className="mt-1 text-muted-foreground">
          A Budget moves the ESI threshold from 1 July: that is a CHANGE. Add a row with that
          date — the old figure stays right for June forever and nothing already paid moves.
        </p>
        <p className="mt-1 text-muted-foreground">
          A ceiling was typed with a zero missing and two payrolls have run against it: that is a
          CORRECTION. It restates months people have already been paid for, it needs the approval
          key as well as the maintenance key, it records a reason, and it names the runs it
          affects before you confirm it.
        </p>
        <p className="mt-1 text-muted-foreground">
          You do not choose between them. Adding a row that would change what a signed-off run
          computed is refused, with those runs named, and sent to the correction door.
        </p>
      </div>

      {overlapCount > 0 ? (
        <div className="rounded border border-destructive p-3 text-xs">
          <p className="font-semibold">
            {overlapCount} row{overlapCount === 1 ? "" : "s"} overlap another row in the same
            series.
          </p>
          <p className="mt-1 text-muted-foreground">
            Two rows in force on the same day makes payroll non-deterministic. This screen
            refuses to create one, but it cannot undo one that arrived from an import or a psql
            prompt, and the database does not yet refuse it either. Fix these before the next
            run — the details are on the affected series below.
          </p>
        </div>
      ) : null}

      {series.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No statutory rates are configured. A payroll run would refuse to compute rather than
          deduct zero, which is deliberate. Seed the opening figures under{" "}
          <Link href="/payroll/setup" className="underline">
            payroll setup
          </Link>{" "}
          and then correct them against what your State and your auditor say.
        </p>
      ) : (
        <RateSeriesTable
          series={series}
          asOf={rates.data.asOf}
          canCorrect={manage.allowed && approve.allowed}
          onCorrect={correctStatutoryRate}
        />
      )}

      {manage.allowed ? (
        <RateRevisionForm options={options} onAdd={addRateRevision} />
      ) : (
        <p className="text-xs text-muted-foreground">
          You can see the rates but not change them. Adding a dated rate needs
          <code className="mx-1">payroll.manage</code>; correcting one that a signed-off run
          already used needs <code className="mx-1">payroll.approve</code> as well.
        </p>
      )}

      <p className="text-xs text-muted-foreground">{rates.data.note}</p>
    </main>
  );
}
