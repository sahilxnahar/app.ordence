"use client";

/**
 * Ordence — ⭐⭐⭐ INCIDENT MODE AND THE BREAK-GLASS LEDGER
 * Version: v1.22.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ TWO THINGS ON ONE SCREEN, AND THEY BELONG TOGETHER
 * ══════════════════════════════════════════════════════════════════════
 * An incident is the hour where somebody reaches for break-glass, and
 * the write-up owed afterwards is the paperwork of the same hour.
 * Putting them on separate screens means the second one is only ever
 * seen at the moment it refuses somebody.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { BREAK_GLASS, PROCEDURE_STEPS } from "@/lib/platform/break-glass";

export type IncidentView = {
  id: string;
  reference: string;
  title: string;
  severity: string;
  declaredAt: string;
  resolvedAt: string | null;
  summary: string | null;
};

export type WriteUpView = {
  sessionId: string;
  tenantName: string;
  actorEmail: string;
  justification: string;
  closedAt: string;
  dueAt: string;
  overdue: boolean;
  hoursLate: number;
};

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export function IncidentBoard({
  incidents,
  writeUps,
  myEmail,
  onDeclare,
  onResolve,
  onWriteUp,
}: {
  incidents: IncidentView[];
  writeUps: WriteUpView[];
  myEmail: string;
  onDeclare: (input: {
    title: string;
    severity: "sev1" | "sev2" | "sev3";
  }) => Promise<Result<{ reference: string }>>;
  onResolve: (input: {
    incidentId: string;
    summary: string;
  }) => Promise<Result<{ resolved: true }>>;
  onWriteUp: (input: {
    sessionId: string;
    note: string;
  }) => Promise<Result<{ note: string }>>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [title, setTitle] = useState("");
  const [severity, setSeverity] = useState<"sev1" | "sev2" | "sev3">("sev2");
  const [openIncident, setOpenIncident] = useState<string | null>(null);
  const [summary, setSummary] = useState("");
  const [openWriteUp, setOpenWriteUp] = useState<string | null>(null);
  const [note, setNote] = useState("");

  const live = incidents.filter((i) => !i.resolvedAt);
  const past = incidents.filter((i) => i.resolvedAt);
  const mine = writeUps.filter((w) => w.actorEmail.toLowerCase() === myEmail.toLowerCase());

  return (
    <div className="space-y-6">
      {/* ---------------------------------------------------------- */}
      {/* ⭐ WHAT I OWE, FIRST                                        */}
      {/* ---------------------------------------------------------- */}
      {mine.length > 0 ? (
        <Card className="border-destructive">
          <CardHeader>
            <CardTitle className="text-sm text-destructive">
              You owe {mine.length} break-glass write-up
              {mine.length === 1 ? "" : "s"}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Until these are written you cannot break glass again. Consented
            support access is unaffected — this only blocks reading a workspace
            without permission.
          </CardContent>
        </Card>
      ) : null}

      {/* ---------------------------------------------------------- */}
      {/* DECLARE                                                     */}
      {/* ---------------------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Declare an incident</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            At three in the morning nobody writes down what they did. While an
            incident is open, every action taken in this console is tagged with
            it, so the post-mortem assembles itself from the log rather than
            from memory.
          </p>
          <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
            <div className="space-y-1">
              <Label htmlFor="incident-title">What is happening</Label>
              <Input
                id="incident-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Invoicing failing for every workspace on the Mumbai region"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="incident-severity">Severity</Label>
              <select
                id="incident-severity"
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                value={severity}
                onChange={(e) => setSeverity(e.target.value as "sev1" | "sev2" | "sev3")}
              >
                <option value="sev1">sev1 — customers cannot work</option>
                <option value="sev2">sev2 — something important is broken</option>
                <option value="sev3">sev3 — degraded, contained</option>
              </select>
            </div>
            <div className="flex items-end">
              <Button
                disabled={pending || title.trim().length < 5}
                onClick={() =>
                  startTransition(async () => {
                    const result = await onDeclare({ title, severity });
                    if (result.ok) {
                      setTitle("");
                      toast.success(`${result.data.reference} declared.`);
                      router.refresh();
                    } else {
                      toast.error(result.error);
                    }
                  })
                }
              >
                Declare
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ---------------------------------------------------------- */}
      {/* LIVE                                                        */}
      {/* ---------------------------------------------------------- */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Open ({live.length})</h2>
        {live.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing is on fire.</p>
        ) : null}
        {live.map((incident) => (
          <Card key={incident.id} data-testid={`incident-${incident.reference}`}>
            <CardContent className="space-y-2 pt-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="destructive">{incident.severity}</Badge>
                <code className="font-mono text-xs">{incident.reference}</code>
                <span className="font-medium">{incident.title}</span>
                <span className="ml-auto text-xs text-muted-foreground">
                  since {new Date(incident.declaredAt).toLocaleString("en-IN")}
                </span>
              </div>

              {openIncident === incident.id ? (
                <div className="space-y-2">
                  <Textarea
                    value={summary}
                    onChange={(e) => setSummary(e.target.value)}
                    rows={4}
                    placeholder="What happened, what fixed it, and what would stop it happening again. Twenty characters minimum."
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      disabled={pending}
                      onClick={() =>
                        startTransition(async () => {
                          const result = await onResolve({
                            incidentId: incident.id,
                            summary,
                          });
                          if (result.ok) {
                            setOpenIncident(null);
                            setSummary("");
                            toast.success("Closed.");
                            router.refresh();
                          } else {
                            toast.error(result.error);
                          }
                        })
                      }
                    >
                      Resolve
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setOpenIncident(null);
                        setSummary("");
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setOpenIncident(incident.id)}
                >
                  Resolve with a summary
                </Button>
              )}
            </CardContent>
          </Card>
        ))}
      </section>

      {/* ---------------------------------------------------------- */}
      {/* ⭐⭐ THE BREAK-GLASS LEDGER                                  */}
      {/* ---------------------------------------------------------- */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">
          Break-glass write-ups outstanding ({writeUps.length})
        </h2>
        <p className="max-w-3xl text-xs text-muted-foreground">
          A break-glass session leaves the operator owing a written note within{" "}
          {BREAK_GLASS.noteDueHours} hours, and until it is written that
          operator cannot break glass again. Anybody with console access can
          close one out from the log — a permanent block on somebody who has
          left the company is a control that gets disabled the first time it
          happens — and the row records who actually wrote it.
        </p>

        {writeUps.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing outstanding. Break-glass is rare, and an empty list here is
            the expected state rather than a sign nothing is being recorded.
          </p>
        ) : null}

        {writeUps.map((w) => (
          <Card key={w.sessionId} className={w.overdue ? "border-destructive" : undefined}>
            <CardContent className="space-y-2 pt-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={w.overdue ? "destructive" : "outline"}>
                  {w.overdue ? `${w.hoursLate}h overdue` : "due"}
                </Badge>
                <span className="font-medium">{w.tenantName}</span>
                <span className="text-xs text-muted-foreground">{w.actorEmail}</span>
                <span className="ml-auto text-xs text-muted-foreground">
                  closed {new Date(w.closedAt).toLocaleString("en-IN")}
                </span>
              </div>

              <p className="text-xs text-muted-foreground">
                Justification at the time: {w.justification}
              </p>

              {openWriteUp === w.sessionId ? (
                <div className="space-y-2">
                  <Textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    rows={5}
                    placeholder="What you looked at, what you found, and what stops this needing break-glass next time."
                  />
                  <p className="text-xs text-muted-foreground">
                    {BREAK_GLASS.minNoteLength} characters minimum. This cannot
                    be edited afterwards — evidence that can be rewritten after
                    somebody asks a question about it is not evidence.
                  </p>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      disabled={pending}
                      onClick={() =>
                        startTransition(async () => {
                          const result = await onWriteUp({
                            sessionId: w.sessionId,
                            note,
                          });
                          if (result.ok) {
                            setOpenWriteUp(null);
                            setNote("");
                            toast.success(result.data.note);
                            router.refresh();
                          } else {
                            toast.error(result.error);
                          }
                        })
                      }
                    >
                      Write it up
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setOpenWriteUp(null);
                        setNote("");
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setOpenWriteUp(w.sessionId)}
                >
                  Write it up
                </Button>
              )}
            </CardContent>
          </Card>
        ))}
      </section>

      {/* ---------------------------------------------------------- */}
      {/* THE PROCEDURE, PUBLISHED                                    */}
      {/* ---------------------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">The break-glass procedure</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
            {PROCEDURE_STEPS.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </CardContent>
      </Card>

      {/* ---------------------------------------------------------- */}
      {/* PAST                                                        */}
      {/* ---------------------------------------------------------- */}
      {past.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Resolved</h2>
          {past.map((incident) => (
            <div key={incident.id} className="rounded border p-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary">{incident.severity}</Badge>
                <code className="font-mono">{incident.reference}</code>
                <span className="font-medium">{incident.title}</span>
              </div>
              {incident.summary ? (
                <p className="mt-1 text-muted-foreground">{incident.summary}</p>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}
    </div>
  );
}
