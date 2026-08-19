/**
 * Ordence — ⭐⭐ TASKS
 * Version: v1.9.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE TWO COUNTERS NOBODY ELSE SHOWS
 * ══════════════════════════════════════════════════════════════════════
 * Every task product counts what is overdue. Almost none count the two
 * ways work actually disappears:
 *
 *   **Nobody's name on it.** Nobody's problem, so nobody does it.
 *   **No date on it.** On no dated list, so it never becomes overdue.
 *
 * ⚠️ Neither will ever appear as late. A dashboard counting only overdue
 * work reports a clean desk while the work sits there. Both are here,
 * first, in red.
 */

import Link from "next/link";
import { getAssignableUsers, getTasks } from "@/server/actions/tasks";
import { getRecentActivity } from "@/server/actions/activities";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TaskBoard } from "@/components/work/task-board";

export const dynamic = "force-dynamic";

export const metadata = { title: "Tasks · Ordence" };

const TONE_BADGE: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  ok: "outline",
  warn: "secondary",
  danger: "destructive",
  muted: "outline",
};

export default async function TasksPage() {
  const [result, people, recent] = await Promise.all([
    getTasks({}),
    getAssignableUsers(),
    getRecentActivity(25),
  ]);

  if (!result.ok) {
    return (
      <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">Tasks</h1>
        <p className="text-sm text-destructive">{result.error}</p>
      </main>
    );
  }

  const { rows, workload, today } = result.data;

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Tasks</h1>
        <p className="text-sm text-muted-foreground">
          {/**
           * 🔴 Why this screen exists at all, said plainly.
           */}
          Until now Ordence could record what the business is and not what
          anybody did about it. A task hangs off whatever it concerns, and
          closing it writes into that record&apos;s own history.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Card className={workload.unassigned > 0 ? "border-destructive" : undefined}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Nobody&apos;s name on it
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{workload.unassigned}</p>
            <p className="text-xs text-muted-foreground">
              {/* 🔴 Never shows as overdue, because it is nobody's. */}
              Unassigned work is nobody&apos;s problem, so it does not get done and
              never shows up as late.
            </p>
          </CardContent>
        </Card>

        <Card className={workload.undated > 0 ? "border-destructive" : undefined}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              No date on it
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{workload.undated}</p>
            <p className="text-xs text-muted-foreground">
              These appear on no dated list and can never become overdue. Give
              them a date or close them.
            </p>
          </CardContent>
        </Card>

        <Card className={workload.overdue > 0 ? "border-amber-500" : undefined}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Late
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{workload.overdue}</p>
            <p className="text-xs text-muted-foreground">
              {workload.worstOverdueDays > 0
                ? `The oldest is ${workload.worstOverdueDays} days past its date.`
                : "Nothing past its date."}
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
            <p className="text-2xl font-semibold tabular-nums">{workload.today}</p>
            <p className="text-xs text-muted-foreground tabular-nums">{today}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Open in total
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{workload.live}</p>
            <p className="text-xs text-muted-foreground">
              {workload.soon} due in the next week.
            </p>
          </CardContent>
        </Card>
      </div>

      <TaskBoard
        rows={rows}
        people={people.ok ? people.data.people : []}
        today={today}
      />

      {workload.byAssignee.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Who is carrying what</CardTitle>
            <p className="text-sm text-muted-foreground">
              {/**
               * ⚠️ Sorted worst first. A list by name hides the person
               * drowning.
               */}
              Sorted by what is late, not alphabetically. A list ordered by name
              hides whoever is drowning.
            </p>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Person</th>
                  <th className="py-2 pr-3 text-right font-medium">Open</th>
                  <th className="py-2 pr-3 text-right font-medium">Late</th>
                </tr>
              </thead>
              <tbody>
                {workload.byAssignee.map((a) => {
                  const name =
                    a.userId === null
                      ? null
                      : (people.ok
                          ? people.data.people.find((p) => p.id === a.userId)?.name
                          : null) ?? "Unnamed";
                  return (
                    <tr key={a.userId ?? "unassigned"} className="border-b last:border-0">
                      <td className="py-2 pr-3">
                        {name ?? (
                          <Badge variant="destructive">nobody</Badge>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">{a.live}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {a.overdue > 0 ? (
                          <Badge variant="destructive">{a.overdue}</Badge>
                        ) : (
                          0
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {recent.ok && recent.data.rows.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Recently, across everything</CardTitle>
            <p className="text-sm text-muted-foreground">
              {/**
               * ⚠️ The useful reading is who is NOT on this list.
               */}
              Every note, call and change, newest first. The useful reading is
              usually who is not on it.
            </p>
          </CardHeader>
          <CardContent className="space-y-2">
            {recent.data.rows.map((r) => (
              <div key={r.id} className="flex gap-3 border-b pb-2 text-sm last:border-0">
                <span className="w-36 shrink-0 tabular-nums text-xs text-muted-foreground">
                  {r.occurredAt.slice(0, 16).replace("T", " ")}
                </span>
                <span className="flex-1">
                  {r.summary}
                  <span className="ml-2 text-xs text-muted-foreground">
                    {r.subjectLabel ?? r.subjectType}
                  </span>
                </span>
                <span className="w-32 shrink-0 text-xs text-muted-foreground">
                  {r.userName ?? "system"}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <p className="text-sm text-muted-foreground">
        <Link href="/calendar" className="underline">
          Calendar
        </Link>
      </p>
    </main>
  );
}
