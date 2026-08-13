/**
 * Ordence — ⭐⭐⭐ THE CALENDAR
 * Version: v1.9.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE PAST IS ON THIS SCREEN, AND THAT IS THE POINT
 * ══════════════════════════════════════════════════════════════════════
 * A calendar that starts at today hides the hearing nobody attended last
 * Thursday and the filing that was due on the 20th. Those are exactly
 * the entries a person needs to see, and they are the ones every
 * calendar product drops off the top of the screen the moment the day
 * turns.
 *
 * ⭐ AND NOTHING HERE IS STORED. Six sources already knew their own
 * dates and each kept its own screen: hearings, filings, licence
 * renewals, payment milestones, tasks and diary entries. A person does
 * not have six days. They have one.
 *
 * ⚠️ A LICENCE APPEARS ON ITS RENEWAL DATE, NOT ITS EXPIRY DATE. One
 * expiring on 30 June with a 60 day lead time belongs on somebody's list
 * on 1 May. Showing it on the 30th is showing it on the day it is
 * already too late, which is how a compliance calendar manages to be
 * technically correct and completely useless.
 */

import Link from "next/link";
import { getAgenda } from "@/server/actions/agenda";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export const metadata = { title: "Calendar · Ordence" };

const SOURCE_BADGE: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  hearing: "destructive",
  compliance: "destructive",
  licence: "destructive",
  milestone: "secondary",
  task: "outline",
  event: "default",
};

export default async function CalendarPage() {
  const result = await getAgenda({ daysAhead: 21, daysBack: 30 });

  if (!result.ok) {
    return (
      <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">Calendar</h1>
        <p className="text-sm text-destructive">{result.error}</p>
      </main>
    );
  }

  const { days, overdueCount, consequentialOverdueCount, todayCount, total, today } =
    result.data;

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Calendar</h1>
        <p className="text-sm text-muted-foreground">
          {/**
           * ⭐ What it actually is, said first.
           */}
          Everything dated, in one list: hearings, statutory filings, licence
          renewals, money due, tasks and diary entries. Nothing here is a
          separate record. Each one still lives, and is still closed, where it
          belongs.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card
          className={consequentialOverdueCount > 0 ? "border-destructive" : undefined}
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Missed, and cannot be done late
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {consequentialOverdueCount}
            </p>
            <p className="text-xs text-muted-foreground">
              {/**
               * 🔴 A hearing, a filing or a licence. These do not
               * become expensive; they become final.
               */}
              A hearing, a statutory filing or an expired licence. These do not
              get more expensive when they slip. They end something.
            </p>
          </CardContent>
        </Card>

        <Card className={overdueCount > 0 ? "border-amber-500" : undefined}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Past its date
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{overdueCount}</p>
            <p className="text-xs text-muted-foreground">
              Still shown, on the day it was due, until it is closed at source.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Today
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{todayCount}</p>
            <p className="text-xs text-muted-foreground tabular-nums">
              {today} · {total} in the window
            </p>
          </CardContent>
        </Card>
      </div>

      {days.length === 0 ? (
        <Card>
          <CardContent className="py-8">
            <p className="text-sm text-muted-foreground">
              Nothing dated in this window. If that is wrong, the dates are being
              kept somewhere other than Ordence.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {days.map((d) => (
            <Card
              key={d.on}
              className={
                d.offset < 0 && d.hasConsequential
                  ? "border-destructive"
                  : d.offset === 0
                    ? "border-primary"
                    : undefined
              }
            >
              <CardHeader className="pb-2">
                <CardTitle className="text-base">
                  <span className="tabular-nums">{d.on}</span>{" "}
                  <span className="font-normal text-muted-foreground">{d.label}</span>
                  {d.offset < 0 && (
                    <Badge variant="destructive" className="ml-2">
                      past
                    </Badge>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {d.entries.map((e) => (
                  <div
                    key={e.id}
                    className="flex flex-wrap items-start gap-2 border-b pb-2 text-sm last:border-0 last:pb-0"
                  >
                    <Badge variant={SOURCE_BADGE[e.source] ?? "outline"}>
                      {e.sourceLabel}
                    </Badge>
                    {e.atLabel && (
                      <span className="tabular-nums text-xs text-muted-foreground">
                        {e.atLabel}
                      </span>
                    )}
                    <span className="flex-1">
                      {e.href ? (
                        <Link href={e.href} className="underline">
                          {e.title}
                        </Link>
                      ) : (
                        e.title
                      )}
                      {e.detail && (
                        <p className="text-xs text-muted-foreground">{e.detail}</p>
                      )}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {e.ownerName ?? "unassigned"}
                    </span>
                  </div>
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">How the ordering works</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            Within a day, what cannot be done late comes first. A hearing at four
            in the afternoon matters more than a call at ten, so the list is not
            in clock order. The times are shown; they just do not decide the
            order.
          </p>
          <p>
            ⚠️ A licence appears on its renewal date, not its expiry date. One
            expiring on 30 June with a 60 day lead time is on the list from 1
            May, because showing it on the 30th is showing it on the day it is
            already too late.
          </p>
          <p>
            🔴 An entry that belongs to nobody stays on everybody&apos;s list.
            Filtering unowned work out of a personal view is how it becomes
            invisible on the one screen that should surface it.
          </p>
        </CardContent>
      </Card>

      <p className="text-sm text-muted-foreground">
        <Link href="/tasks" className="underline">
          Tasks
        </Link>
      </p>
    </main>
  );
}
