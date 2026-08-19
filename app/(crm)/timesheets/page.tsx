/**
 * Ordence — ⭐ TIMESHEETS · TIME RECORDED AGAINST WORK
 * Version: v0.70.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ READ THE HEADER OF `server/actions/timesheets.ts` FIRST
 * ══════════════════════════════════════════════════════════════════════
 * There is no timesheet table in this product. There is time recorded as
 * a SIDE EFFECT of doing work, in two places — attendance punches and
 * field visits — and this page reports exactly that and calls it that.
 * It is not a billable-hours report, because no charge rate, cost rate,
 * task or billable flag exists anywhere in the schema to build one from.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE TWO SOURCES ARE SHOWN SIDE BY SIDE AND NEVER ADDED
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ A technician who punches in at a site AND logs a visit at a job on
 * that site has recorded one afternoon twice. A single "total hours"
 * figure would double-count them — unevenly, so the error is invisible in
 * the total and wrong per person. Two columns, two totals, one sentence
 * explaining why.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT LEADS, AND WHY
 * ══════════════════════════════════════════════════════════════════════
 *   1. ⭐ ROSTERED WITH NOTHING RECORDED. The only panel here that finds
 *      time NOBODY ENTERED. Every other number reports what was
 *      captured, so a person who simply never punched is invisible in all
 *      of them — and a missing day does not look like anything until
 *      payroll, when it is a wage dispute with no evidence on either
 *      side.
 *   2. ⭐ UNCLOSED PUNCHES AND OPEN VISITS. Somebody arrived and, on the
 *      record, never left. The hours are unrecoverable once the day is
 *      out of memory, and an unclosed punch is worth nothing to a wage
 *      claim, an EPF reconciliation or a customer's SLA.
 *   3. Then the time itself, per person and per project.
 */

import { Suspense } from "react";
import Link from "next/link";
import { getTimesheets } from "@/server/actions/timesheets";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export const metadata = { title: "Timesheets · Ordence" };

/**
 * Minutes to "7h 45m".
 *
 * ⚠️ NOT DECIMAL HOURS. 7.75 is what a payroll system wants and "7h 45m"
 * is what a supervisor checking a day against a muster roll wants, and
 * this screen is read by the second person.
 */
function hm(minutes: number): string {
  if (!minutes) return "0h";
  const sign = minutes < 0 ? "-" : "";
  const abs = Math.abs(Math.round(minutes));
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `${sign}${h}h${m ? ` ${m}m` : ""}`;
}

function day(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
  });
}

function when(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

const SHIFT_LABEL: Record<string, string> = {
  morning: "Morning",
  evening: "Evening",
  night: "Night",
  full_day: "Full day",
  off: "Off",
};

async function TimesheetBody() {
  const result = await getTimesheets();

  if (!result.ok) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Timesheets unavailable</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{result.error}</p>
        </CardContent>
      </Card>
    );
  }

  const {
    windowDays,
    openPunches,
    openVisits,
    rosterGaps,
    attendance,
    visits,
    byProject,
    totalAttendanceMinutes,
    totalVisitMinutes,
  } = result.data;

  const nothingRecorded =
    attendance.length === 0 &&
    visits.length === 0 &&
    rosterGaps.length === 0 &&
    openPunches.length === 0 &&
    openVisits.length === 0;

  if (nothingRecorded) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No time has been recorded in the last {windowDays} days</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>
            This screen reports time that was captured while work was being
            done. It fills in from two places, and neither of them is a form
            somebody sits down and fills in at the end of the week:
          </p>
          <ul className="ml-4 list-disc space-y-1">
            <li>
              <strong>Site attendance</strong> — check-in and check-out punches
              from the site app, per person and per project, each carrying a
              geofence verdict and a flag for punches captured with no signal.
              Paired into shifts here.
            </li>
            <li>
              <strong>Field visits</strong> — a technician arriving at and
              leaving a job. The minutes on site are derived from the device
              clock, not from when the server heard about it, so a visit worked
              in a basement and synced three hours later is still an
              11:05 visit.
            </li>
          </ul>
          <p>
            ⚠️ Worth being plain about: this product has no timesheet TABLE. It
            has no task dimension, no billable flag, no charge rate and no
            approval step, so it cannot produce a billable-hours report or
            invoice a client from time. What it can do — and what this page
            does — is show who was where, for how long, and where the record
            has a hole in it.
          </p>
          <p>
            Start recording:{" "}
            <Link href="/field-jobs" className="underline">
              field jobs and visits
            </Link>
            .
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* ── 1 · ROSTERED, NOTHING RECORDED. ────────────────────────── */}
      {rosterGaps.length > 0 && (
        <Card className="border-red-400 dark:border-red-800">
          <CardHeader>
            <CardTitle className="text-red-700 dark:text-red-300">
              {rosterGaps.length} rostered shift
              {rosterGaps.length === 1 ? " has" : "s have"} no time recorded
              against them
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <ul className="space-y-1">
              {rosterGaps.slice(0, 20).map((g) => (
                <li key={g.id} className="flex flex-wrap items-baseline gap-3">
                  <span className="w-16 shrink-0 tabular-nums text-muted-foreground">
                    {day(g.rosterDate)}
                  </span>
                  <span className="font-medium">{g.name}</span>
                  <Badge variant="outline" className="text-[10px]">
                    {SHIFT_LABEL[g.shift] ?? g.shift}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {g.projectName ?? "no project"}
                  </span>
                </li>
              ))}
            </ul>
            {rosterGaps.length > 20 && (
              <p className="text-xs text-muted-foreground">
                and {rosterGaps.length - 20} more.
              </p>
            )}
            <p className="text-muted-foreground">
              ⭐ This is the only panel on the page that finds time NOBODY
              ENTERED. Everything else reports what was captured, so a person
              who never punched is invisible in all of it — and a missing day
              does not look like anything until payroll, at which point it is
              somebody&apos;s word against an empty row. Either the shift did
              not happen and the roster is wrong, or it happened and the record
              of it does not exist. Both are worth ten minutes today.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── 2 · ARRIVED AND NEVER LEFT. ───────────────────────────── */}
      {(openPunches.length > 0 || openVisits.length > 0) && (
        <Card className="border-amber-400 dark:border-amber-700">
          <CardHeader>
            <CardTitle className="text-amber-700 dark:text-amber-300">
              {openPunches.length + openVisits.length} record
              {openPunches.length + openVisits.length === 1 ? "" : "s"} of
              somebody arriving and never leaving
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {openPunches.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Attendance punches
                </p>
                <ul className="space-y-1">
                  {openPunches.slice(0, 15).map((p) => (
                    <li key={p.id} className="flex flex-wrap items-baseline gap-3">
                      <span className="font-medium">{p.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {p.kind === "worker" ? "site worker" : "staff"}
                        {p.projectName ? ` · ${p.projectName}` : ""}
                      </span>
                      <span className="tabular-nums text-xs">
                        in at {when(p.occurredAt)}
                      </span>
                      <span
                        className={
                          p.hoursOpen > 24
                            ? "tabular-nums text-xs text-red-700 dark:text-red-300"
                            : "tabular-nums text-xs text-muted-foreground"
                        }
                      >
                        {p.hoursOpen}h open
                      </span>
                      {p.isOffline && (
                        <Badge variant="outline" className="text-[10px]">
                          offline punch
                        </Badge>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {openVisits.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Field visits
                </p>
                <ul className="space-y-1">
                  {openVisits.slice(0, 15).map((v) => (
                    <li key={v.id} className="flex flex-wrap items-baseline gap-3">
                      <span className="font-mono text-xs">{v.jobNumber}</span>
                      <span className="font-medium">{v.jobTitle}</span>
                      <span className="text-xs text-muted-foreground">
                        {v.technicianName ?? "unassigned"}
                      </span>
                      <span className="tabular-nums text-xs">
                        in at {when(v.checkedInAt)}
                      </span>
                      <span
                        className={
                          v.hoursOpen > 24
                            ? "tabular-nums text-xs text-red-700 dark:text-red-300"
                            : "tabular-nums text-xs text-muted-foreground"
                        }
                      >
                        {v.hoursOpen}h open
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <p className="text-muted-foreground">
              ⚠️ A check-in with no check-out contributes ZERO minutes, not a
              long day — a pair stretching beyond {16} hours is treated as a
              missing punch rather than a shift, because no lawful shift is
              that long and a 68-hour day reported as work is a wage claim
              nobody can defend. The hours are recoverable while somebody still
              remembers the day and not afterwards.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── 3 · The two totals, deliberately apart. ────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Site time
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {hm(totalAttendanceMinutes)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Paired attendance punches, {attendance.length}{" "}
              {attendance.length === 1 ? "person" : "people"}.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Job time
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {hm(totalVisitMinutes)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              On-site minutes from field visits.
            </p>
          </CardContent>
        </Card>
        <Card
          className={
            openPunches.length + openVisits.length > 0
              ? "border-amber-300 dark:border-amber-800"
              : ""
          }
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Unclosed
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {openPunches.length + openVisits.length}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Records contributing no time at all.
            </p>
          </CardContent>
        </Card>
        <Card
          className={rosterGaps.length > 0 ? "border-red-300 dark:border-red-800" : ""}
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Roster gaps
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {rosterGaps.length}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Shifts planned with nothing recorded.
            </p>
          </CardContent>
        </Card>
      </div>

      <p className="text-xs text-muted-foreground">
        ⭐ &quot;Site time&quot; and &quot;job time&quot; are NOT added
        together anywhere on this page. A technician who punches in at a site
        and also logs a visit at a job on that site has recorded one afternoon
        twice; a single total would double-count them unevenly, which is worse
        than two honest numbers because nobody can see the error in a total.
      </p>

      {/* ── 4 · Per person, per source. ────────────────────────────── */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Site time by person
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                attendance punches
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {attendance.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                No attendance was punched in this window. Attendance comes from
                the site app — a check-in and a check-out, each with a geofence
                verdict — and it is the denominator every EPF and ESI
                reconciliation is checked against.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">Person</th>
                      <th className="px-3 py-2 text-right font-medium">Days</th>
                      <th className="px-3 py-2 text-right font-medium">Time</th>
                      <th className="px-3 py-2 text-right font-medium">Unclosed</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {attendance.map((a) => (
                      <tr key={a.subjectId}>
                        <td className="px-3 py-2">
                          <span className="font-medium">{a.name}</span>
                          <div className="text-[10px] text-muted-foreground">
                            {a.kind === "worker"
                              ? `site worker${a.trade ? ` · ${a.trade}` : ""}`
                              : "staff"}
                            {a.projectsWorked > 1
                              ? ` · ${a.projectsWorked} projects`
                              : ""}
                            {a.offlinePunches > 0
                              ? ` · ${a.offlinePunches} offline`
                              : ""}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {a.daysPresent}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums font-medium">
                          {hm(a.pairedMinutes)}
                        </td>
                        <td
                          className={
                            a.unclosedPunches > 0
                              ? "px-3 py-2 text-right tabular-nums text-amber-700 dark:text-amber-300"
                              : "px-3 py-2 text-right tabular-nums text-muted-foreground"
                          }
                        >
                          {a.unclosedPunches}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Job time by technician
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                field visits
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {visits.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                No field visit was recorded in this window. A visit carries the
                arrival, the departure and the distance from the site, and the
                minutes between them are the closest thing in this product to
                time booked against a specific piece of work.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">Technician</th>
                      <th className="px-3 py-2 text-right font-medium">Visits</th>
                      <th className="px-3 py-2 text-right font-medium">Time</th>
                      <th className="px-3 py-2 text-right font-medium">Open</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {visits.map((v) => (
                      <tr key={v.userId || v.name}>
                        <td className="px-3 py-2">
                          <span className="font-medium">{v.name}</span>
                          {v.suspiciousVisits > 0 && (
                            <div className="text-[10px] text-amber-700 dark:text-amber-300">
                              {v.suspiciousVisits} checked in far from the site
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {v.visits}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums font-medium">
                          {hm(v.onSiteMinutes)}
                        </td>
                        <td
                          className={
                            v.openVisits > 0
                              ? "px-3 py-2 text-right tabular-nums text-amber-700 dark:text-amber-300"
                              : "px-3 py-2 text-right tabular-nums text-muted-foreground"
                          }
                        >
                          {v.openVisits}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── 5 · Where the site time went. ─────────────────────────── */}
      {byProject.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Site time by project</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y">
              {byProject.map((p) => (
                <li
                  key={p.projectId ?? "unassigned"}
                  className="flex flex-wrap items-baseline gap-3 px-4 py-2 text-sm"
                >
                  <span className="font-medium">
                    {p.projectName ?? "No project on the punch"}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {p.people} {p.people === 1 ? "person" : "people"}
                  </span>
                  <span className="ml-auto tabular-nums">
                    {hm(p.pairedMinutes)}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <div className="space-y-2 text-xs text-muted-foreground">
        <p>
          ⚠️ Field visits are absent from the per-project table on purpose. A
          visit hangs off a JOB, which carries a customer and a site address
          and no project — attributing those minutes to a project would mean
          guessing, and a guessed allocation looks exactly like a measured one.
        </p>
        <p>
          ⚠️ An offline punch is a claim about a time the device recorded and
          the server did not witness. It is flagged rather than discarded:
          usually it is true, occasionally it is a phone with its clock moved,
          and marking it lets a supervisor weigh it instead of making every
          record look equally verified.
        </p>
        <p>
          This product has no timesheet table — no task, no billable flag, no
          charge or cost rate, no approval step. Everything above is time
          captured while work was happening, which is a stronger record than a
          form filled in on Friday and a weaker one than a billing system.
          Nothing here should be invoiced from without a human in front of it.
        </p>
      </div>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="space-y-6">
      <div className="h-44 animate-pulse rounded-lg border bg-muted/40" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-28 animate-pulse rounded-lg border bg-muted/40" />
        ))}
      </div>
      <div className="h-80 animate-pulse rounded-lg border bg-muted/40" />
    </div>
  );
}

export default function TimesheetsPage() {
  return (
    <div className="space-y-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Timesheets</h1>
          <p className="text-sm text-muted-foreground">
            Time recorded against work in the last 30 days — and the days where
            the record has a hole in it.
          </p>
        </div>
        <Link
          href="/field-jobs"
          className="text-sm text-muted-foreground hover:underline"
        >
          Field jobs
        </Link>
      </header>

      <Suspense fallback={<Skeleton />}>
        <TimesheetBody />
      </Suspense>
    </div>
  );
}
