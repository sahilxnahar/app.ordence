/**
 * Ordence — HEARINGS
 * Version: v0.70.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE PAGE LEADS WITH DATES THAT HAVE ALREADY GONE PAST
 * ══════════════════════════════════════════════════════════════════════
 * Every other calendar in existence opens on what is coming. This one
 * opens on what went by, because that is the only thing on a court diary
 * that is invisible from anywhere else.
 *
 * ⚠️ A HEARING STILL MARKED "CONFIRMED" A FORTNIGHT AFTER IT WAS LISTED
 * LOOKS EXACTLY LIKE ONE LISTED NEXT FORTNIGHT. Same row, same fields,
 * one digit different in a date nobody re-reads. From outside the file,
 * an adjournment nobody recorded and an ex-parte order passed in your
 * absence are the same row — and one of them is a costs order, or a
 * dismissal for non-prosecution.
 *
 * Then clashes, because the database is right to permit them and a
 * person cannot survive them. Then today. Then the week.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE TWO SOURCES ARE NEVER MERGED INTO ONE WORD
 * ══════════════════════════════════════════════════════════════════════
 * A listing before a court and a statutory filing deadline both live on
 * this diary and both get missed on the same Tuesday, so they belong on
 * one screen. They are not the same kind of obligation: one has a time
 * and a place and somebody standing up, the other has a day and a form.
 * Every row says which it is, and a statutory date never renders a clock
 * it does not have.
 */

import { Suspense } from "react";
import Link from "next/link";
import {
  listHearingCalendar,
  type CalendarItem,
} from "@/server/actions/calendar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export const metadata = { title: "Hearings · Ordence" };

function dayLabel(dateOnly: string): string {
  const d = new Date(`${dateOnly}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return dateOnly;
  return d.toLocaleDateString("en-IN", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
  });
}

function clock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** How a row reads its own date at a glance. */
function whenLabel(item: CalendarItem): string {
  if (!item.hasTime) return "all day";
  return clock(item.startsAt);
}

function relative(days: number): string {
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  if (days < 0) return `${Math.abs(days)}d ago`;
  return `in ${days}d`;
}

/**
 * ⚠️ TWO MAPS, NOT ONE, BECAUSE THE TWO SOURCES SHARE A STATUS NAME.
 *
 * `in_progress` means "part-heard" on a listing and "somebody has
 * started drafting it" on a filing. One merged lookup would render a
 * pending GST return as part-heard before a judge — which is funny once
 * and then is a screen nobody trusts.
 */
const HEARING_STATUS_LABEL: Record<string, string> = {
  held: "Provisional",
  confirmed: "Listed",
  checked_in: "Attending",
  in_progress: "Part-heard",
  completed: "Disposed",
  no_show: "Not attended",
  cancelled: "Cancelled",
  waitlisted: "Awaiting listing",
};

const DEADLINE_STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  in_progress: "In progress",
  awaiting_client: "Awaiting client",
  ready_to_file: "Ready to file",
  filed: "Filed",
  late_filed: "Filed late",
  missed: "Missed",
  not_applicable: "Not applicable",
  waived: "Waived",
};

function statusLabel(item: CalendarItem): string {
  const map =
    item.source === "hearing" ? HEARING_STATUS_LABEL : DEADLINE_STATUS_LABEL;
  return map[item.status] ?? item.status;
}

function statusTone(status: string): string {
  if (status === "missed") return "border-red-400 text-red-700 dark:border-red-700 dark:text-red-300";
  if (status === "cancelled" || status === "not_applicable" || status === "waived")
    return "text-muted-foreground";
  if (status === "held")
    return "border-amber-400 text-amber-700 dark:border-amber-700 dark:text-amber-300";
  if (status === "checked_in" || status === "in_progress")
    return "border-blue-400 text-blue-700 dark:border-blue-700 dark:text-blue-300";
  if (status === "completed" || status === "filed")
    return "border-emerald-300 text-emerald-700 dark:border-emerald-800 dark:text-emerald-300";
  return "";
}

function SourceBadge({ item }: { item: CalendarItem }) {
  return (
    <Badge variant="outline" className="text-[10px]">
      {item.source === "deadline"
        ? "statutory"
        : item.isHearingShaped
          ? item.kind
          : `${item.kind} · not a listing kind`}
    </Badge>
  );
}

async function CalendarBody() {
  const result = await listHearingCalendar();

  if (!result.ok) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Calendar unavailable</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{result.error}</p>
        </CardContent>
      </Card>
    );
  }

  const {
    items,
    passedWithoutOutcome,
    clashes,
    provisional,
    today,
    next7Days,
    deadlinesVisible,
    hearingCount,
    deadlineCount,
    otherKindCount,
  } = result.data;

  /* Group the forward view by day — a diary is read a day at a time. */
  const upcoming = new Map<string, CalendarItem[]>();
  for (const item of next7Days) {
    const bucket = upcoming.get(item.date);
    if (bucket) bucket.push(item);
    else upcoming.set(item.date, [item]);
  }

  return (
    <div className="space-y-6">
      {/* ── 1 · DATES THAT WENT PAST WITH NOTHING RECORDED. ────────── */}
      {passedWithoutOutcome.length > 0 && (
        <Card className="border-red-400 dark:border-red-700">
          <CardHeader>
            <CardTitle className="text-red-700 dark:text-red-300">
              {passedWithoutOutcome.length} date
              {passedWithoutOutcome.length === 1 ? " has" : "s have"} passed with
              no outcome recorded
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <ul className="space-y-1">
              {passedWithoutOutcome.slice(0, 15).map((i) => (
                <li key={`${i.source}-${i.id}`} className="flex flex-wrap items-baseline gap-3">
                  <span className="w-24 shrink-0 tabular-nums text-xs text-muted-foreground">
                    {dayLabel(i.date)}
                  </span>
                  <span className="font-medium">{i.title}</span>
                  {i.venue && (
                    <span className="text-xs text-muted-foreground">{i.venue}</span>
                  )}
                  <span className="tabular-nums text-red-600 dark:text-red-400">
                    {relative(i.daysUntil)}
                  </span>
                  <Badge variant="outline" className={statusTone(i.status)}>
                    {statusLabel(i)}
                  </Badge>
                  <SourceBadge item={i} />
                </li>
              ))}
            </ul>
            {passedWithoutOutcome.length > 15 && (
              <p className="text-xs text-muted-foreground">
                …and {passedWithoutOutcome.length - 15} more in the register
                below.
              </p>
            )}
            <p className="text-muted-foreground">
              ⚠️ This is the one thing on a diary that cannot be seen by
              looking at it. A matter still marked as listed, a fortnight after
              it was listed, is identical on screen to one listed a fortnight
              from now. Nobody knows whether it was heard, adjourned, or gone
              through without you — and the difference between those is
              whether there is an order against your client that nobody has
              read yet.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── 2 · CLASHES. Two places, one person, same hour. ────────── */}
      {clashes.length > 0 && (
        <Card className="border-amber-400 dark:border-amber-700">
          <CardHeader>
            <CardTitle className="text-amber-700 dark:text-amber-300">
              {clashes.length} pair
              {clashes.length === 1 ? "" : "s"} of commitments overlap in time
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <ul className="space-y-2">
              {clashes.slice(0, 10).map((c, idx) => (
                <li key={`${c.a.id}-${c.b.id}-${idx}`} className="space-y-0.5">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="w-24 shrink-0 tabular-nums text-xs text-muted-foreground">
                      {dayLabel(c.a.date)}
                    </span>
                    <span className="font-medium">{c.a.title}</span>
                    <span className="text-xs text-muted-foreground">
                      {c.a.venue} · {clock(c.a.startsAt)}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-baseline gap-2 pl-24">
                    <span className="font-medium">{c.b.title}</span>
                    <span className="text-xs text-muted-foreground">
                      {c.b.venue} · {clock(c.b.startsAt)}
                    </span>
                    <span className="tabular-nums text-amber-700 dark:text-amber-300">
                      {c.overlapMinutes}m overlap
                    </span>
                  </div>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground">
              ⭐ These are not double bookings — two commitments on one room or
              one counsel are refused outright by the database, under an
              exclusion constraint that holds even when two clerks book at the
              same instant. What is listed here is the pair the database is
              right to allow and a person cannot honour: two different venues,
              the same hour. Both rows are individually correct. The pair is
              not.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── 3 · Provisional dates about to evaporate. ──────────────── */}
      {provisional.length > 0 && (
        <Card className="border-blue-300 dark:border-blue-800">
          <CardHeader>
            <CardTitle className="text-blue-700 dark:text-blue-300">
              {provisional.length} provisional date
              {provisional.length === 1 ? "" : "s"} expiring or already expired
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <ul className="space-y-1">
              {provisional.slice(0, 10).map((i) => (
                <li key={i.id} className="flex flex-wrap items-baseline gap-3">
                  <span className="font-medium">{i.title}</span>
                  <span className="text-xs text-muted-foreground">{i.venue}</span>
                  <span
                    className={
                      (i.holdMinutesLeft ?? 0) < 0
                        ? "tabular-nums text-red-600 dark:text-red-400"
                        : "tabular-nums"
                    }
                  >
                    {(i.holdMinutesLeft ?? 0) < 0
                      ? `lapsed ${Math.abs(i.holdMinutesLeft ?? 0)}m ago`
                      : `${i.holdMinutesLeft}m left`}
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground">
              A provisional date holds the slot exactly as a fixed one does and
              then quietly releases it. Everybody who saw it in the diary
              yesterday still believes the matter is listed.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── 4 · What the calendar can and cannot see. ──────────────── */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className={today.length > 0 ? "border-blue-300 dark:border-blue-800" : ""}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Today
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{today.length}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {next7Days.length} more in the next seven days.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Listings
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{hearingCount}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {otherKindCount > 0
                ? `⚠️ ${otherKindCount} on a resource kind that is not a hall, slot or practitioner.`
                : "All on a hall, slot or practitioner."}
            </p>
          </CardContent>
        </Card>

        {/* ⭐ The statutory half says why it is empty, rather than being
            empty. See the header of server/actions/calendar.ts. */}
        <Card className={deadlinesVisible ? "" : "border-amber-300 dark:border-amber-800"}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Statutory dates
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {deadlinesVisible ? deadlineCount : "—"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {deadlinesVisible ? (
                <>
                  Filings and limitation dates, from the compliance register.
                </>
              ) : (
                <>
                  ⚠️ Hidden — you do not hold{" "}
                  <span className="font-mono">compliance.calendar.read</span>.
                  This calendar is showing listings only.
                </>
              )}
            </p>
          </CardContent>
        </Card>

        <Card
          className={
            passedWithoutOutcome.length > 0
              ? "border-red-300 dark:border-red-800"
              : ""
          }
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Awaiting an outcome
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {passedWithoutOutcome.length}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Dates that have gone by with nothing recorded against them.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* ── 5 · Today, in order. ──────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Today</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {today.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
              Nothing listed today.
            </p>
          ) : (
            <ul className="divide-y">
              {today.map((i) => (
                <li
                  key={`${i.source}-${i.id}`}
                  className="flex flex-wrap items-baseline gap-3 px-4 py-2 text-sm"
                >
                  <span className="w-16 shrink-0 tabular-nums text-muted-foreground">
                    {whenLabel(i)}
                  </span>
                  <span className="font-medium">{i.title}</span>
                  {i.subtitle && (
                    <span className="text-xs text-muted-foreground">
                      {i.subtitle}
                    </span>
                  )}
                  {i.venue && (
                    <span className="text-xs text-muted-foreground">
                      {i.venue}
                    </span>
                  )}
                  <Badge
                    variant="outline"
                    className={`ml-auto ${statusTone(i.status)}`}
                  >
                    {statusLabel(i)}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* ── 6 · The next seven days, a day at a time. ──────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">The next seven days</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {upcoming.size === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
              Nothing listed in the next seven days.
            </p>
          ) : (
            <div className="divide-y">
              {[...upcoming.entries()].map(([date, dayItems]) => (
                <div key={date} className="px-4 py-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {dayLabel(date)}
                  </p>
                  <ul className="mt-1 space-y-1">
                    {dayItems.map((i) => (
                      <li
                        key={`${i.source}-${i.id}`}
                        className="flex flex-wrap items-baseline gap-3 text-sm"
                      >
                        <span className="w-16 shrink-0 tabular-nums text-muted-foreground">
                          {whenLabel(i)}
                        </span>
                        <span className="font-medium">{i.title}</span>
                        {i.venue && (
                          <span className="text-xs text-muted-foreground">
                            {i.venue}
                          </span>
                        )}
                        <SourceBadge item={i} />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── 7 · The whole register. ───────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>The diary</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {items.length === 0 ? (
            <div className="space-y-3 px-6 py-10 text-center">
              <p className="text-sm text-muted-foreground">
                Nothing on the diary yet.
              </p>
              <p className="mx-auto max-w-2xl text-xs text-muted-foreground">
                This calendar is assembled from two things a practice already
                records rather than from a diary of its own. A{" "}
                <span className="font-medium">listing</span> is a booking
                against a resource — a hall, a listing slot, or a member of
                chambers — held from a start time to an end time for a named
                party under a matter reference; create one in Scheduling and it
                appears here. A{" "}
                <span className="font-medium">statutory date</span> is a
                compliance deadline: its due date is derived by the database
                from the period and the obligation&apos;s own rule, never
                typed, so an obligation due on the 31st still lands correctly
                in February.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">Date</th>
                    <th className="px-4 py-2 font-medium">Time</th>
                    <th className="px-4 py-2 font-medium">Matter</th>
                    <th className="px-4 py-2 font-medium">Before / authority</th>
                    <th className="px-4 py-2 font-medium">Kind</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th className="px-4 py-2 text-right font-medium">When</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {items.slice(0, 300).map((i) => {
                    const overdue = !i.settled && i.daysUntil < 0;
                    return (
                      <tr
                        key={`${i.source}-${i.id}`}
                        className={
                          overdue
                            ? "bg-red-50/60 hover:bg-red-50 dark:bg-red-950/20 dark:hover:bg-red-950/30"
                            : "hover:bg-muted/40"
                        }
                      >
                        <td className="px-4 py-2 tabular-nums text-xs">
                          {dayLabel(i.date)}
                        </td>
                        {/* ⚠️ A statutory date has a DAY, not a clock.
                            Rendering 00:00 invents a time somebody would
                            eventually plan a morning around. */}
                        <td className="px-4 py-2 tabular-nums text-xs text-muted-foreground">
                          {whenLabel(i)}
                        </td>
                        <td className="px-4 py-2 font-medium">
                          {i.title}
                          {i.subtitle && (
                            <div className="text-xs font-normal text-muted-foreground">
                              {i.subtitle}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-2 text-xs text-muted-foreground">
                          {i.venue ?? "—"}
                        </td>
                        <td className="px-4 py-2">
                          <SourceBadge item={i} />
                        </td>
                        <td className="px-4 py-2">
                          <Badge variant="outline" className={statusTone(i.status)}>
                            {statusLabel(i)}
                          </Badge>
                        </td>
                        <td
                          className={
                            overdue
                              ? "px-4 py-2 text-right tabular-nums text-xs text-red-600 dark:text-red-400"
                              : "px-4 py-2 text-right tabular-nums text-xs text-muted-foreground"
                          }
                        >
                          {relative(i.daysUntil)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Listings are read from the schedule and statutory dates from the
        compliance register — this screen owns no dates of its own and writes
        nothing. Two commitments on the same hall are impossible in the
        database rather than merely discouraged; two commitments in different
        halls at the same hour are permitted, which is why they are listed
        above rather than prevented. Resource kind is used to classify a
        listing, never to hide one: a booking recorded against a{" "}
        <span className="font-mono">room</span> rather than a{" "}
        <span className="font-mono">hall</span> still appears here, marked for
        what it is.
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

export default function CalendarPage() {
  return (
    <div className="space-y-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Hearings</h1>
          <p className="text-sm text-muted-foreground">
            Where you are expected, when — and which dates went by without an
            answer.
          </p>
        </div>
        <Link
          href="/scheduling"
          className="text-sm text-muted-foreground hover:underline"
        >
          Scheduling
        </Link>
      </header>

      <Suspense fallback={<Skeleton />}>
        <CalendarBody />
      </Suspense>
    </div>
  );
}
