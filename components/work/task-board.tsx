"use client";

/**
 * Ordence — ⭐ THE TASK LIST, AND ADDING TO IT
 * Version: v1.9.0-alpha
 *
 * 🔴 THE LIST IS SORTED BY DATE FIRST AND PRIORITY SECOND.
 *
 * ⚠️ A "normal" task three weeks late beats an "urgent" one due next
 * month. Every product that sorts by priority first teaches its users
 * that the priority field is a lever you pull to get attention, and
 * within a month everything is urgent.
 */

import { useState, useTransition } from "react";
import { closeTask, saveTask } from "@/server/actions/tasks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Row = {
  id: string;
  title: string;
  detail: string | null;
  subjectType: string | null;
  subjectId: string | null;
  subjectLabel: string | null;
  assignedTo: string | null;
  assigneeName: string | null;
  dueOn: string | null;
  priority: string;
  status: string;
  urgency: string;
  urgencyLabel: string;
  tone: string;
  repeats: boolean;
};

const TONE: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  ok: "outline",
  warn: "secondary",
  danger: "destructive",
  muted: "outline",
};

export function TaskBoard({
  rows,
  people,
  today,
}: {
  rows: readonly Row[];
  people: readonly { id: string; name: string }[];
  today: string;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [assignedTo, setAssignedTo] = useState("");
  const [dueOn, setDueOn] = useState(today);
  const [priority, setPriority] = useState("normal");
  const [repeatDays, setRepeatDays] = useState("");

  function add() {
    setError(null);
    setNote(null);
    start(async () => {
      const res = await saveTask({
        title,
        assignedTo: assignedTo || null,
        dueOn: dueOn || null,
        priority,
        repeatEveryDays: repeatDays ? Number(repeatDays) : null,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setTitle("");
      setRepeatDays("");
      setNote("Added.");
    });
  }

  function finish(id: string) {
    setError(null);
    setNote(null);
    start(async () => {
      const res = await closeTask({ id, status: "done" });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setNote(
        res.data.nextDueOn
          ? `Done. The next one is due ${res.data.nextDueOn}.`
          : "Done.",
      );
    });
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Add a task</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-5">
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="t-title">What has to be done</Label>
              <Input
                id="t-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Ring Sharma about the pending challan"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="t-who">Who</Label>
              <Select
                id="t-who"
                value={assignedTo}
                onChange={(e) => setAssignedTo(e.target.value)}
              >
                <option value="">Nobody yet</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="t-due">By when</Label>
              <Input
                id="t-due"
                type="date"
                value={dueOn}
                onChange={(e) => setDueOn(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="t-pri">Priority</Label>
              <Select
                id="t-pri"
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
              >
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </Select>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-5">
            <div className="space-y-1">
              <Label htmlFor="t-rep">Repeat every (days)</Label>
              <Input
                id="t-rep"
                inputMode="numeric"
                value={repeatDays}
                onChange={(e) => setRepeatDays(e.target.value)}
                placeholder="blank = once"
              />
            </div>
            <div className="flex items-end sm:col-span-4">
              <Button onClick={add} disabled={pending || !title.trim()}>
                {pending ? "Saving…" : "Add"}
              </Button>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            {/**
             * ⭐ The recurrence rule, said where somebody sets it.
             */}
            A repeating task creates the next one when this one is completed, not
            on a schedule. There is only ever one live copy, and it counts from
            the due date rather than the day it was finished, so a task that is
            always done late does not drift out of its own cycle.
          </p>

          {error && <p className="text-sm text-destructive">{error}</p>}
          {note && <p className="text-sm text-muted-foreground">{note}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            Open{" "}
            <span className="font-normal text-muted-foreground">({rows.length})</span>
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Sorted by date first and priority second. Anything with no date sorts
            last and is counted separately above.
          </p>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing open. Either the desk is clear or nothing is being recorded.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Due</th>
                  <th className="py-2 pr-3 font-medium">What</th>
                  <th className="py-2 pr-3 font-medium">About</th>
                  <th className="py-2 pr-3 font-medium">Who</th>
                  <th className="py-2 pr-3 font-medium">Priority</th>
                  <th className="py-2 pr-3"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b last:border-0 align-top">
                    <td className="py-2 pr-3 tabular-nums">
                      <Badge variant={TONE[r.tone] ?? "outline"}>{r.urgencyLabel}</Badge>
                      {r.dueOn && (
                        <p className="mt-1 text-xs text-muted-foreground">{r.dueOn}</p>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      {r.title}
                      {r.repeats && (
                        <Badge variant="outline" className="ml-1">
                          repeats
                        </Badge>
                      )}
                      {r.detail && (
                        <p className="text-xs text-muted-foreground">{r.detail}</p>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-xs text-muted-foreground">
                      {r.subjectLabel ?? r.subjectType ?? "—"}
                    </td>
                    <td className="py-2 pr-3">
                      {r.assigneeName ?? <Badge variant="destructive">nobody</Badge>}
                    </td>
                    <td className="py-2 pr-3">{r.priority}</td>
                    <td className="py-2 pr-3">
                      <Button
                        variant="outline"
                        onClick={() => finish(r.id)}
                        disabled={pending}
                      >
                        Done
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
