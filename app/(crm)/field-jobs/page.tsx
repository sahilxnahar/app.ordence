/**
 * Ordence — ⭐ ENGINE 3 · THE DISPATCH BOARD
 * Version: v0.65.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE PAGE LEADS WITH THE THREE THINGS NOBODY CAN SEE ANY OTHER WAY
 * ══════════════════════════════════════════════════════════════════════
 * Everything structurally dangerous is already impossible: a job cannot
 * be completed by somebody who never arrived, a completed job cannot be
 * quietly reopened, proof cannot be edited. The database refuses all
 * three, under an offline client replaying a queue out of order. So this
 * screen has nothing useful to add about them.
 *
 * What it must say is what the data knows and a list does not:
 *
 *   1. OVERDUE — past the window the CUSTOMER was given, not past some
 *      internal target nobody was told about. Sorted by how late.
 *   2. ⭐ REPEAT FAILURES — `visit_count >= 3`. Two visits is bad luck;
 *      three is a diagnosis that has now been wrong twice, and it is
 *      almost always cheaper to send a different person than the same
 *      one a fourth time. This number is the whole reason `visit_count`
 *      is a column and not a report, and it is invisible in every field
 *      system that counts visits at report time.
 *   3. SUSPICIOUS CHECK-INS — a check-in far from the site. ⚠️ THESE ARE
 *      NOT REJECTIONS AND MUST NEVER BE PRESENTED AS ONE. GPS in a
 *      basement plant room is wrong by hundreds of metres; the flag is a
 *      conversation, and 500 m is loose on purpose so that a flag still
 *      means something.
 *
 * ⚠️ THE STATUS BUTTONS COME FROM `canTransition`, WHICH IS A HINT.
 * `FIELD_JOB_TRANSITIONS` is imported to decide what to DRAW. The
 * database decides what is legal — see SQL-FILES/0036 — because the
 * client is offline half the day and the page it rendered from may be
 * four hours stale.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ `?type=housekeeping` IS THE SAME SCREEN, FILTERED
 * ══════════════════════════════════════════════════════════════════════
 * A hotel's room-attendant board and a solar installer's dispatch board
 * are the same shape: somebody goes to a place, inside a window, does a
 * stated thing, and leaves evidence. Only the heading, the empty state
 * and the `job_kind` filter differ. Two pages would be two places for
 * the repeat-visit alarm to be fixed, and only one would get fixed.
 */

import { Suspense } from "react";
import Link from "next/link";
import {
  listFieldJobs,
  type FieldJobRow,
  type FieldVisitRow,
} from "@/server/actions/field-ops";
import {
  canTransition,
  SUSPICIOUS_DISTANCE_M,
  type FieldJobStatus,
} from "@/db/schema/field-ops";
import { FieldJobActions } from "@/components/field-ops/field-job-actions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export const metadata = { title: "Field work · Ordence" };

const ALL_STATUSES: FieldJobStatus[] = [
  "draft",
  "scheduled",
  "dispatched",
  "travelling",
  "on_site",
  "paused",
  "completed",
  "could_not_complete",
  "cancelled",
];

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  scheduled: "Scheduled",
  dispatched: "Dispatched",
  travelling: "Travelling",
  on_site: "On site",
  paused: "Paused",
  completed: "Completed",
  could_not_complete: "Could not complete",
  cancelled: "Cancelled",
};

function inr(minorUnits: string | null | undefined): string {
  if (!minorUnits) return "₹0.00";
  const raw = String(minorUnits);
  const negative = raw.startsWith("-");
  const digits = (negative ? raw.slice(1) : raw).padStart(3, "0");
  const whole = digits.slice(0, -2) || "0";
  const frac = digits.slice(-2);
  const lastThree = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest
    ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${lastThree}`
    : lastThree;
  return `${negative ? "-" : ""}₹${grouped}.${frac}`;
}

function when(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** How late, in words. Reads better than a timestamp on an alarm panel. */
function lateBy(windowEnd: string | null): string {
  if (!windowEnd) return "no window set";
  const minutes = Math.round((Date.now() - new Date(windowEnd).getTime()) / 60_000);
  if (minutes < 60) return `${minutes}m late`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h late`;
  return `${Math.floor(minutes / 1440)}d late`;
}

function humanise(value: string): string {
  return value.replace(/_/g, " ");
}

function statusTone(status: string): string {
  if (status === "cancelled") return "text-muted-foreground";
  if (status === "could_not_complete")
    return "border-red-300 text-red-700 dark:border-red-800 dark:text-red-300";
  if (status === "completed")
    return "border-emerald-300 text-emerald-700 dark:border-emerald-800 dark:text-emerald-300";
  if (status === "on_site" || status === "travelling")
    return "border-blue-400 text-blue-700 dark:border-blue-700 dark:text-blue-300";
  if (status === "paused")
    return "border-amber-400 text-amber-700 dark:border-amber-700 dark:text-amber-300";
  return "";
}

function priorityTone(priority: string): string {
  if (priority === "emergency")
    return "border-red-400 text-red-700 dark:border-red-700 dark:text-red-300";
  if (priority === "urgent")
    return "border-amber-400 text-amber-700 dark:border-amber-700 dark:text-amber-300";
  return "text-muted-foreground";
}

/** The label a visit carries in a picker: which trip, on which job. */
function visitLabel(v: FieldVisitRow): string {
  return `${v.jobNumber} · visit ${v.sequence} · ${when(v.checkedInAt)}${
    v.isDistanceSuspicious ? " · flagged" : ""
  }`;
}

type Variant = {
  jobKind: string | null;
  heading: string;
  subheading: string;
  emptyTitle: string;
  emptyBody: string;
  noun: string;
};

/**
 * ⭐ The two readings of the same board.
 *
 * ⚠️ THE EMPTY STATE IS NOT DECORATION. A hotel manager who opens the
 * housekeeping board and reads about solar commissioning concludes the
 * link is broken and stops using it. It is the only copy on the screen
 * that a brand-new workspace ever sees.
 */
function variantFor(type: string | undefined): Variant {
  if (type === "housekeeping") {
    return {
      jobKind: "housekeeping",
      heading: "Housekeeping",
      subheading: "Which rooms are turned, who has them, and which are late.",
      emptyTitle: "No housekeeping jobs yet.",
      emptyBody:
        "A housekeeping job is one room, one attendant, one window — checkout " +
        "at 11, guest arriving at 14. Raise them here and the board shows which " +
        "are past their window before the front desk hands over a key, plus any " +
        "room somebody has been sent back to three times, which is a maintenance " +
        "problem wearing a cleaning problem's clothes.",
      noun: "housekeeping job",
    };
  }
  return {
    jobKind: null,
    heading: "Field work",
    subheading: "What is open, who has it, and whether it is late.",
    emptyTitle: "No field jobs yet.",
    emptyBody:
      "A job is somebody going to a place, inside a window, to do a stated " +
      "thing — a commissioning, a breakdown call, a delivery, a meter read. " +
      "The board leads with what is past the window the customer was given, " +
      "what has taken three visits, and where a check-in came in far from " +
      "site. None of the three is visible in a list sorted by date.",
    noun: "job",
  };
}

async function FieldBody({ variant }: { variant: Variant }) {
  const result = await listFieldJobs(
    variant.jobKind ? { jobKind: variant.jobKind } : undefined,
  );

  if (!result.ok) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Dispatch board unavailable</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{result.error}</p>
        </CardContent>
      </Card>
    );
  }

  const {
    jobs,
    overdue,
    repeatFailures,
    suspiciousCheckIns,
    visits,
    proofs,
    materials,
    technicians,
    assignees,
    customers,
    jobKinds,
    counters,
  } = result.data;

  /**
   * ⭐ WHICH MOVES TO DRAW, FROM THE ONE TRANSITION TABLE.
   *
   * ⚠️ COMPUTED HERE RATHER THAN LISTED IN THE COMPONENT, so there is
   * exactly one copy of the rule in TypeScript and it is the copy the
   * test suite asserts against the SQL. A `completed` job yields an empty
   * array, and the component draws no move at all — only the follow-up.
   */
  const jobOptions = jobs.map((j) => ({
    id: j.id,
    jobNumber: j.jobNumber,
    title: j.title,
    status: j.status,
    isClosed: j.isClosed,
    nextStatuses: ALL_STATUSES.filter(
      (to) => to !== j.status && canTransition(j.status as FieldJobStatus, to),
    ) as string[],
  }));

  const visitOptions = visits.map((v) => ({
    id: v.id,
    jobId: v.jobId,
    label: visitLabel(v),
  }));

  const unassignedOpen = jobs.filter((j) => !j.isClosed && !j.assignedUserId);

  return (
    <div className="space-y-6">
      <FieldJobActions
        jobs={jobOptions}
        visits={visitOptions}
        assignees={assignees}
        customers={customers}
        jobKinds={jobKinds}
        defaultJobKind={variant.jobKind}
      />

      {/* ── 1 · OVERDUE. Late against the customer's own window. ────── */}
      {overdue.length > 0 && (
        <Card className="border-red-400 dark:border-red-700">
          <CardHeader>
            <CardTitle className="text-red-700 dark:text-red-300">
              {overdue.length} {variant.noun}
              {overdue.length === 1 ? " is" : "s are"} past the promised window
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <ul className="space-y-1">
              {overdue.slice(0, 12).map((j) => (
                <li key={j.id} className="flex flex-wrap items-baseline gap-3">
                  <span className="font-mono text-xs">{j.jobNumber}</span>
                  <span className="font-medium">{j.title}</span>
                  <span className="text-xs text-muted-foreground">
                    {j.assigneeName ?? j.crewName ?? "unassigned"}
                  </span>
                  <span className="tabular-nums text-red-700 dark:text-red-300">
                    {lateBy(j.windowEnd)}
                  </span>
                  <Badge variant="outline" className={statusTone(j.status)}>
                    {STATUS_LABEL[j.status] ?? j.status}
                  </Badge>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground">
              Late against the window the customer was actually given —
              &ldquo;between 10 and 1&rdquo; — not against an internal target
              nobody was told about. A single appointment time would force this
              figure to invent a tolerance, and every team invents a different
              one.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── 2 · ⭐ REPEAT FAILURES. The number nobody can otherwise see. */}
      {repeatFailures.length > 0 && (
        <Card className="border-amber-400 dark:border-amber-700">
          <CardHeader>
            <CardTitle className="text-amber-700 dark:text-amber-300">
              {repeatFailures.length} {variant.noun}
              {repeatFailures.length === 1 ? " has" : "s have"} taken three
              visits or more
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <ul className="space-y-1">
              {repeatFailures.slice(0, 12).map((j) => (
                <li key={j.id} className="flex flex-wrap items-baseline gap-3">
                  <span className="font-mono text-xs">{j.jobNumber}</span>
                  <span className="font-medium">{j.title}</span>
                  <span className="text-xs text-muted-foreground">
                    {j.customerName ?? j.siteAddress ?? "—"}
                  </span>
                  <span className="tabular-nums font-semibold text-amber-700 dark:text-amber-300">
                    {j.visitCount} visits
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {j.assigneeName ?? "unassigned"}
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground">
              Two visits is bad luck. Three is a diagnosis that has been wrong
              twice, and it is almost always cheaper to send a different person
              than the same one a fourth time. Each of these has cost three lots
              of travel and burned two of the customer&rsquo;s afternoons for
              nothing.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── 3 · SUSPICIOUS CHECK-INS. Evidence, never a rejection. ──── */}
      {suspiciousCheckIns.length > 0 && (
        <Card className="border-blue-300 dark:border-blue-800">
          <CardHeader>
            <CardTitle className="text-blue-700 dark:text-blue-300">
              {suspiciousCheckIns.length} check-in
              {suspiciousCheckIns.length === 1 ? "" : "s"} more than{" "}
              {SUSPICIOUS_DISTANCE_M} m from site
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <ul className="space-y-1">
              {suspiciousCheckIns.slice(0, 12).map((v) => (
                <li key={v.id} className="flex flex-wrap items-baseline gap-3">
                  <span className="font-mono text-xs">{v.jobNumber}</span>
                  <span className="font-medium">{v.jobTitle}</span>
                  <span className="text-xs text-muted-foreground">
                    {v.technicianName ?? "unknown technician"}
                  </span>
                  <span className="tabular-nums">
                    {v.distanceFromSiteM === null
                      ? "—"
                      : `${(v.distanceFromSiteM / 1000).toFixed(1)} km out`}
                  </span>
                  {v.checkedInAccuracyM !== null && (
                    <span className="text-xs text-muted-foreground">
                      handset claimed ±{v.checkedInAccuracyM} m
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {when(v.checkedInAt)}
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground">
              These are recorded, not refused, and that is deliberate. GPS in a
              basement plant room or under a metal roof is wrong by hundreds of
              metres; refusing the check-in would not stop the technician
              working — the customer is standing there — it would stop the work
              being written down, and the history would then be missing exactly
              the hard jobs. Read the accuracy figure alongside the distance
              before treating one as a finding.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── 4 · The numbers. ──────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Open
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{counters.open}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {unassignedOpen.length} with nobody assigned.
            </p>
          </CardContent>
        </Card>
        <Card className={counters.overdue > 0 ? "border-red-300 dark:border-red-800" : ""}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Overdue
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{counters.overdue}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Past the customer&rsquo;s window.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              First-time fix
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {counters.firstTimeFixPct === null ? "—" : `${counters.firstTimeFixPct}%`}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {counters.completed} completed, {counters.couldNotComplete} could
              not be.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Quoted, still open
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {inr(counters.openQuotedMinor)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Work promised and not yet delivered.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* ── 5 · The jobs. ─────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>{variant.heading} jobs</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {jobs.length === 0 ? (
            <div className="space-y-3 px-6 py-10 text-center">
              <p className="text-sm text-muted-foreground">{variant.emptyTitle}</p>
              <p className="mx-auto max-w-2xl text-xs text-muted-foreground">
                {variant.emptyBody}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">Job</th>
                    <th className="px-4 py-2 font-medium">Kind</th>
                    <th className="px-4 py-2 font-medium">Customer / site</th>
                    <th className="px-4 py-2 font-medium">Window</th>
                    <th className="px-4 py-2 font-medium">Who</th>
                    <th className="px-4 py-2 text-right font-medium">Visits</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th className="px-4 py-2 text-right font-medium">Quoted</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {jobs.slice(0, 300).map((j: FieldJobRow) => (
                    <tr
                      key={j.id}
                      className={
                        j.isOverdue
                          ? "bg-red-50/60 hover:bg-red-50 dark:bg-red-950/20"
                          : j.isRepeatFailure
                            ? "bg-amber-50/60 hover:bg-amber-50 dark:bg-amber-950/20"
                            : j.isClosed
                              ? "opacity-70 hover:bg-muted/40"
                              : "hover:bg-muted/40"
                      }
                    >
                      <td className="px-4 py-2">
                        <span className="font-medium">{j.title}</span>
                        <div className="font-mono text-xs text-muted-foreground">
                          {j.jobNumber}
                        </div>
                      </td>
                      <td className="px-4 py-2 text-xs text-muted-foreground">
                        {humanise(j.jobKind)}
                        <div>
                          <Badge
                            variant="outline"
                            className={`text-[10px] ${priorityTone(j.priority)}`}
                          >
                            {j.priority}
                          </Badge>
                        </div>
                      </td>
                      <td className="px-4 py-2">
                        {j.customerName ?? "—"}
                        {j.siteAddress && (
                          <div className="max-w-[18rem] truncate text-xs text-muted-foreground">
                            {j.siteAddress}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2 tabular-nums text-xs">
                        {when(j.windowStart)} → {when(j.windowEnd)}
                        {j.isOverdue && (
                          <div className="text-[10px] text-red-700 dark:text-red-300">
                            {lateBy(j.windowEnd)}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2 text-xs">
                        {j.assigneeName ?? (
                          <span className="text-amber-700 dark:text-amber-300">
                            unassigned
                          </span>
                        )}
                        {j.crewName && (
                          <div className="text-muted-foreground">{j.crewName}</div>
                        )}
                      </td>
                      {/* ⭐ Three or more is the alarm, on the row, before
                          anybody assigns a fourth. */}
                      <td className="px-4 py-2 text-right tabular-nums">
                        <span
                          className={
                            j.isRepeatFailure
                              ? "font-semibold text-amber-700 dark:text-amber-300"
                              : ""
                          }
                        >
                          {j.visitCount}
                        </span>
                        {j.suspiciousCheckIns > 0 && (
                          <div className="text-[10px] text-blue-700 dark:text-blue-300">
                            {j.suspiciousCheckIns} flagged
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2">
                        <Badge variant="outline" className={statusTone(j.status)}>
                          {STATUS_LABEL[j.status] ?? j.status}
                        </Badge>
                        {j.failureReason && (
                          <div className="mt-1 text-[10px] text-red-700 dark:text-red-300">
                            {humanise(j.failureReason)}
                          </div>
                        )}
                        {j.status === "completed" && (
                          <div className="mt-1 text-[10px] text-muted-foreground">
                            final
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {j.quotedAmountMinor === null ? "—" : inr(j.quotedAmountMinor)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── 6 · ⭐ TECHNICIANS, BY FIRST-TIME FIX. ─────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Technicians</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {technicians.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              Nothing has closed yet, so there is no first-time-fix rate to
              show. A rate computed from an empty set reads as 0% and gets
              somebody a conversation they did not earn.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">Technician</th>
                    <th className="px-4 py-2 text-right font-medium">Closed</th>
                    <th className="px-4 py-2 text-right font-medium">Completed</th>
                    <th className="px-4 py-2 text-right font-medium">
                      Could not complete
                    </th>
                    <th className="px-4 py-2 text-right font-medium">
                      First-time fix
                    </th>
                    <th className="px-4 py-2 text-right font-medium">
                      Avg on site
                    </th>
                    <th className="px-4 py-2 text-right font-medium">Flagged</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {technicians.map((t) => (
                    <tr key={t.userId ?? "unassigned"} className="hover:bg-muted/40">
                      <td className="px-4 py-2 font-medium">{t.name}</td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {t.jobsClosed}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {t.completed}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {t.failed}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums font-semibold">
                        {t.firstTimeFixPct === null ? "—" : `${t.firstTimeFixPct}%`}
                        <div className="text-[10px] font-normal text-muted-foreground">
                          {t.firstTimeFixes} of {t.completed} in one visit
                        </div>
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-xs text-muted-foreground">
                        {t.avgOnSiteMinutes === null ? "—" : `${t.avgOnSiteMinutes}m`}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-xs">
                        {t.suspiciousCheckIns > 0 ? (
                          <span className="text-blue-700 dark:text-blue-300">
                            {t.suspiciousCheckIns}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── 7 · PROOF OF SERVICE. Read-only, by design. ─────────────── */}
      {proofs.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Proof of service</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y">
              {proofs.slice(0, 60).map((p) => (
                <li
                  key={p.id}
                  className="flex flex-wrap items-baseline gap-3 px-4 py-2 text-sm"
                >
                  <span className="font-mono text-xs">{p.jobNumber}</span>
                  <Badge variant="outline" className="text-[10px]">
                    {humanise(p.kind)}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {p.value ?? p.storageKey ?? "—"}
                  </span>
                  {p.acceptedByName && (
                    <span className="text-xs">accepted by {p.acceptedByName}</span>
                  )}
                  {/* ⭐ The verdict, never the code. */}
                  {p.otpVerified && (
                    <Badge
                      variant="outline"
                      className="border-emerald-300 text-[10px] text-emerald-700 dark:border-emerald-800 dark:text-emerald-300"
                    >
                      OTP verified
                    </Badge>
                  )}
                  <span className="ml-auto tabular-nums text-xs text-muted-foreground">
                    {when(p.capturedAt)}
                  </span>
                </li>
              ))}
            </ul>
            {/* ⚠️ NO EDIT AND NO DELETE ANYWHERE ON THIS LIST, and that is
                the entire value of the table. A photo that can be replaced
                afterwards is a picture, not evidence. */}
            <p className="px-4 py-3 text-xs text-muted-foreground">
              Append-only. There is no edit and no delete here, and none in the
              database either — the application role holds no UPDATE or DELETE
              privilege on this table and a trigger refuses both. The only
              reason a customer accepts &ldquo;we attended and it was
              working&rdquo; is that nobody could have changed the record
              afterwards. A correction is a new record beside the old one.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── 8 · MATERIALS. Against the trip, not the job. ───────────── */}
      {materials.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Materials consumed</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y">
              {materials.slice(0, 60).map((m) => (
                <li
                  key={m.id}
                  className="flex flex-wrap items-baseline gap-3 px-4 py-2 text-sm"
                >
                  <span className="font-mono text-xs">{m.itemCode}</span>
                  <span className="font-medium">{m.itemName}</span>
                  <span
                    className={
                      Number(m.quantity) < 0
                        ? "tabular-nums text-blue-700 dark:text-blue-300"
                        : "tabular-nums"
                    }
                  >
                    {m.quantity} {m.unit}
                    {Number(m.quantity) < 0 && " (returned)"}
                  </span>
                  {m.isWarranty && (
                    <Badge variant="outline" className="text-[10px]">
                      warranty
                    </Badge>
                  )}
                  {!m.isBillable && !m.isWarranty && (
                    <Badge variant="outline" className="text-[10px]">
                      not charged
                    </Badge>
                  )}
                  {m.serialNumber && (
                    <span className="text-xs text-muted-foreground">
                      #{m.serialNumber}
                    </span>
                  )}
                  <span className="ml-auto tabular-nums text-xs text-muted-foreground">
                    {inr(m.unitCostMinor)} each
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <p className="text-xs text-muted-foreground">
        The status machine is enforced in the database, not on this screen. An
        offline handset replaying four hours of queued events out of order
        cannot complete a job it never arrived at, and a completed job cannot
        move backwards at all — work that comes back is a new job that
        references the old one, so the failed first attempt stays in the
        first-time-fix rate rather than editing itself out. A retried submit
        from a phone that lost signal collides with its own device-generated
        event id and is absorbed, so the customer is not billed for two visits.
      </p>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-28 animate-pulse rounded-lg border bg-muted/40" />
        ))}
      </div>
      <div className="h-96 animate-pulse rounded-lg border bg-muted/40" />
    </div>
  );
}

export default async function FieldJobsPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string }>;
}) {
  const params = await searchParams;
  const variant = variantFor(params.type);

  return (
    <div className="space-y-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            {variant.heading}
          </h1>
          <p className="text-sm text-muted-foreground">{variant.subheading}</p>
        </div>
        <div className="flex gap-4 text-sm text-muted-foreground">
          {variant.jobKind ? (
            <Link href="/field-jobs" className="hover:underline">
              All field work
            </Link>
          ) : (
            <Link href="/field-jobs?type=housekeeping" className="hover:underline">
              Housekeeping
            </Link>
          )}
          <Link href="/scheduling" className="hover:underline">
            Scheduling
          </Link>
        </div>
      </header>

      <Suspense fallback={<Skeleton />}>
        <FieldBody variant={variant} />
      </Suspense>
    </div>
  );
}
