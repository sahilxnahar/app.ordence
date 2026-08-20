/**
 * Ordence — The status surface, rendered
 *
 * ⚠️ IN `server/observability/` RATHER THAN BESIDE A PAGE — see
 * `reliability-page.tsx` for the Wave-7 security test that makes Track
 * B's assigned `app/` block unusable.
 * Version: v1.82.0-alpha (Wave 14 · Track B)
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THREE STATES PER OBJECTIVE, NOT TWO
 * ══════════════════════════════════════════════════════════════════════
 * MET · BREACHED · UNMEASURED, and the third one is rendered in its own
 * colour with its own explanation rather than being folded into either
 * of the others.
 *
 * A status page with two states has to put "we are not measuring this"
 * somewhere, and it always ends up in the green one — which is how a
 * stopped recorder reads as a healthy service. Twenty-three findings in
 * this repository share that shape; this file is where the observability
 * track would have committed the twenty-fourth.
 *
 * ⚠️ AND THE STALL BANNER IS ABOVE EVERYTHING. When the recorder is
 * silent, every number below it is a ratio over a window that was not
 * observed, and they will all look excellent. Saying so first is the
 * difference between a status page and a decoration.
 *
 * No client component, no polling, no chart library. The numbers are
 * numbers.
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RUNBOOKS, runbookForSlo } from "@/server/observability/alerts";
import { BURN_ALERT_WINDOWS, budgetMinutes } from "@/server/observability/slo";
import type { HealthSnapshot } from "@/server/observability/health";
import type { CostReport } from "@/server/observability/cost";
import type { StreamSummary } from "@/server/security/siem";
import type { SweepResult } from "@/server/observability/runtime";

/* ================================================================== */
/* SMALL PRESENTERS                                                    */
/* ================================================================== */

function pct(value: number, digits = 3): string {
  return `${(value * 100).toFixed(digits)}%`;
}

/** ⚠️ `null` IS "not read", NOT "none". It must never render as a number. */
function orDash(value: number | null, render: (n: number) => string): string {
  return value === null ? "—" : render(value);
}

function bytes(value: number): string {
  if (value <= 0) return "0";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = value;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function when(value: Date | null): string {
  if (!value) return "never";
  return value.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

/* ================================================================== */
/* THE PAGE BODY                                                       */
/* ================================================================== */

export function HealthView({
  snapshot,
  cost,
  stream,
  sweep,
  onAcknowledge,
  onCommitExport,
}: {
  snapshot: HealthSnapshot;
  cost: CostReport;
  stream: StreamSummary;
  sweep: SweepResult;
  /**
   * ⚠️ PLAIN `<form action={...}>` AND NO CLIENT COMPONENT ANYWHERE ON
   * THIS PAGE. The one screen an operator opens when things are already
   * wrong should not depend on a JavaScript bundle having loaded.
   */
  onAcknowledge: (formData: FormData) => Promise<void>;
  onCommitExport: (formData: FormData) => Promise<void>;
}) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Reliability</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Four objectives, their error budgets, and the workspaces behind the numbers.
          Every figure here is an aggregate — counts, sums and ratios. Nothing a
          customer typed reaches this screen; seeing that still requires a consented,
          time-limited, audited impersonation session.
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Generated {when(snapshot.generatedAt)}. The evaluation sweep runs on read:{" "}
          {sweep.evaluated} objective(s) evaluated, {sweep.raised} alert(s) delivered,{" "}
          {sweep.suppressed} suppressed by the rate limiter.
        </p>
      </div>

      {/* 🔴 ABOVE EVERYTHING. See the header. */}
      {snapshot.recorderStalled ? (
        <Card className="border-destructive">
          <CardHeader>
            <CardTitle className="text-sm text-destructive">
              The recorder is not writing — treat every number below as unverified
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>
              Last observation written: <span className="font-mono">{when(snapshot.recorderLastWriteAt)}</span>.
              An availability ratio over a window nothing observed is not a low number,
              it is no number — and it renders as a high one.
            </p>
            <p className="text-foreground">{RUNBOOKS["recorder-stalled"].whatToDoNow}</p>
          </CardContent>
        </Card>
      ) : null}

      {/* ---------------- objectives ---------------- */}
      <div className="grid gap-3 lg:grid-cols-2">
        {snapshot.slos.map((entry) => {
          const slo = entry.evaluation.slo;
          const runbook = runbookForSlo(slo.id);
          const unmeasured = entry.evaluation.state === "unmeasured";
          const breached = entry.evaluation.state === "measured" && entry.evaluation.breached;

          return (
            <Card key={slo.id} className={breached ? "border-destructive" : undefined}>
              <CardHeader className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="text-sm">{slo.title}</CardTitle>
                  <Badge variant={breached ? "destructive" : unmeasured ? "outline" : "secondary"}>
                    {unmeasured ? "UNMEASURED" : breached ? "BREACHED" : "MET"}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">{slo.statement}</p>
              </CardHeader>

              <CardContent className="space-y-3 text-sm">
                {entry.evaluation.state === "unmeasured" ? (
                  <>
                    <p className="text-muted-foreground">{entry.evaluation.why}</p>
                    {/*
                      ⚠️ AN UNMEASURED OBJECTIVE STILL SHOWS ITS BUDGET.
                      Hiding it would make the objective look aspirational;
                      it is not, it is simply not being measured yet, and
                      the two read very differently to whoever is deciding
                      what to build next.
                    */}
                    <p className="text-xs text-muted-foreground">
                      Target {pct(slo.target, 2)} over {slo.windowDays} days ={" "}
                      {budgetMinutes(slo.id).toLocaleString()} minutes of budget once measured.
                    </p>
                  </>
                ) : (
                  <>
                    <div className="grid grid-cols-3 gap-2">
                      <Figure label="Achieved" value={pct(entry.evaluation.achieved)} />
                      <Figure label="Target" value={pct(slo.target, 2)} />
                      <Figure
                        label="Budget used"
                        value={pct(Math.min(entry.evaluation.consumed, 9.99), 1)}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {entry.evaluation.bad.toLocaleString()} bad of{" "}
                      {entry.evaluation.sample.toLocaleString()} observed ·{" "}
                      {budgetMinutes(slo.id).toLocaleString()} minutes of budget in a{" "}
                      {slo.windowDays}-day window.
                      {entry.fastBurn
                        ? ` Last hour burning at ${entry.fastBurn.burnRate.toFixed(1)}x.`
                        : " Not enough traffic in the last hour to compute a burn rate."}
                    </p>
                  </>
                )}

                <details className="rounded-md border border-border p-2">
                  <summary className="cursor-pointer text-xs font-medium">
                    What happens when the budget is gone, and what to do at 3am
                  </summary>
                  <div className="mt-2 space-y-2 text-xs text-muted-foreground">
                    <p>
                      <span className="font-medium text-foreground">Consequence.</span>{" "}
                      {slo.consequence}
                    </p>
                    <p>
                      <span className="font-medium text-foreground">Runbook ({runbook.key}).</span>{" "}
                      {runbook.whatToDoNow}
                    </p>
                    <p>
                      <span className="font-medium text-foreground">Escalate if.</span>{" "}
                      {runbook.escalateIf}
                    </p>
                    <p>
                      <span className="font-medium text-foreground">Measured by.</span>{" "}
                      {slo.measuredBy}
                    </p>
                  </div>
                </details>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* ---------------- burn thresholds ---------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">When an alert fires</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-xs text-muted-foreground">
          {BURN_ALERT_WINDOWS.map((w) => (
            <p key={w.id}>
              <span className="font-mono text-foreground">{w.burnRate}x</span> sustained over{" "}
              {w.windowHours} hour(s) — {w.meaning}
            </p>
          ))}
          <p className="border-t pt-2">
            Every alert this system can raise carries a runbook key; the database refuses a
            row without one. There are {Object.keys(RUNBOOKS).length} of them and no others.
          </p>
        </CardContent>
      </Card>

      {/* ---------------- per-tenant ---------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">
            Per-workspace health — ordered by failures, not by traffic
          </CardTitle>
        </CardHeader>
        <CardContent>
          {snapshot.tenants.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No per-workspace observations in the window. That is not the same as no
              failures — see the notes below.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-1">Workspace</th>
                  <th className="py-1 text-right">Requests</th>
                  <th className="py-1 text-right">Failed</th>
                  <th className="py-1 text-right">Error rate</th>
                  <th className="py-1 text-right">p95</th>
                  <th className="py-1 text-right">Open alerts</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.tenants.map((t) => (
                  <tr key={t.tenantId} className="border-b last:border-0">
                    <td className="py-1 font-mono text-xs">{t.tenantId}</td>
                    <td className="py-1 text-right tabular-nums">{t.requests.toLocaleString()}</td>
                    <td className="py-1 text-right tabular-nums">{t.failed.toLocaleString()}</td>
                    <td
                      className={
                        "py-1 text-right tabular-nums " +
                        (t.errorRate >= 0.05 ? "font-semibold text-destructive" : "")
                      }
                    >
                      {pct(t.errorRate, 2)}
                    </td>
                    <td className="py-1 text-right tabular-nums">
                      {/* null means "above the last histogram edge", which is a
                          worse answer than any number and must not render as "—". */}
                      {t.p95Ms === null ? "> 5000 ms" : `${t.p95Ms} ms`}
                    </td>
                    <td className="py-1 text-right tabular-nums">{t.openAlerts}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* ---------------- cost ---------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">
            Per-workspace cost — ordered by AI tokens, the one dimension with no cap
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {cost.tenants.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing recorded in the window.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-1">Workspace</th>
                  <th className="py-1 text-right">AI tokens</th>
                  <th className="py-1 text-right">API calls</th>
                  <th className="py-1 text-right">Emails</th>
                  <th className="py-1 text-right">Storage</th>
                  <th className="py-1 text-right">Request time</th>
                </tr>
              </thead>
              <tbody>
                {cost.tenants.map((t) => (
                  <tr key={t.tenantId} className="border-b last:border-0">
                    <td className="py-1 font-mono text-xs">{t.tenantId}</td>
                    <td className="py-1 text-right tabular-nums">
                      {orDash(t.aiTotalTokens, (n) => n.toLocaleString())}
                    </td>
                    <td className="py-1 text-right tabular-nums">
                      {orDash(t.apiCalls, (n) => n.toLocaleString())}
                    </td>
                    <td className="py-1 text-right tabular-nums">
                      {orDash(t.emailsSent, (n) => n.toLocaleString())}
                    </td>
                    <td className="py-1 text-right tabular-nums">{orDash(t.storageBytes, bytes)}</td>
                    <td className="py-1 text-right tabular-nums">
                      {(t.requestMs / 1000).toFixed(0)} s
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <p className="border-t pt-2 text-xs text-muted-foreground">
            {/*
              ⚠️ COVERAGE IS PRINTED BESIDE THE TABLE, not buried in a note.
              Every metered figure here costs one transaction per workspace,
              because usage_counters, usage_levels and ai_usage are refused to
              a platform-scoped read by design and are therefore read inside
              each workspace's own scope. A reader who does not know the page
              is capped will read the total as the whole estate.
            */}
            Metered {cost.coverage.metered} of {cost.coverage.workspaces} workspace(s)
            {cost.coverage.failed > 0 ? `, ${cost.coverage.failed} failed` : ""} — cap{" "}
            {cost.coverage.cap}. A dash is a read that did not happen, not a zero.
          </p>

          {/* 🔴 WHAT IS NOT MEASURED IS PRINTED, NOT OMITTED. */}
          <div className="space-y-1 border-t pt-2 text-xs text-muted-foreground">
            {cost.unmeasured.map((u) => (
              <p key={u.dimension}>
                <span className="font-medium text-foreground">Not measured — {u.dimension}.</span>{" "}
                {u.reason}
              </p>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* ---------------- the security vocabulary ---------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Security events, last hour</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {snapshot.recentSecurity.length === 0 ? (
            <p className="text-muted-foreground">
              Nothing recorded in the last hour.{" "}
              {/*
                ⚠️ THE CAVEAT IS NOT OPTIONAL. Track D established that every
                tenant-attributed security event was refused by row-level
                security for the life of the table — seven call sites, zero
                rows, always. An empty hour here has meant "the writer is
                broken" far more often than it has meant "nothing happened",
                and it will keep meaning that until PATCH-REQUEST-D item 2 is
                applied everywhere.
              */}
              An empty hour is not evidence of a quiet hour: see Track D on
              <code className="font-mono"> recordSecurityEvent()</code>.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-1">Event type</th>
                  <th className="py-1">Severity</th>
                  <th className="py-1 text-right">Count</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.recentSecurity.map((e) => (
                  <tr key={`${e.eventType}:${e.severity}`} className="border-b last:border-0">
                    <td className="py-1 font-mono text-xs">{e.eventType}</td>
                    <td
                      className={
                        "py-1 text-xs " +
                        (e.severity === "critical" ? "font-semibold text-destructive" : "")
                      }
                    >
                      {e.severity}
                    </td>
                    <td className="py-1 text-right tabular-nums">{e.n.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* ---------------- the scheduler ---------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Track A&rsquo;s scheduler</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {!snapshot.scheduler.present || !snapshot.scheduler.callable ? (
            <p className="text-muted-foreground">
              Unmeasured — {snapshot.scheduler.why}{" "}
              {snapshot.scheduler.found.length > 0
                ? `Found: ${snapshot.scheduler.found.join(", ")}.`
                : ""}
            </p>
          ) : (
            <>
              <p
                className={
                  snapshot.overdueNow && snapshot.overdueNow > 0
                    ? "font-semibold text-destructive"
                    : ""
                }
              >
                {snapshot.overdueNow === 0
                  ? "Nothing is outside its cadence window right now."
                  : `${snapshot.overdueNow} job(s) outside their cadence window right now.`}
              </p>
              <p className="text-xs text-muted-foreground">
                {/*
                  ⚠️ THE NAMES ARE NOT REPEATED HERE. `scheduler_overdue()`
                  names them and is the only definition of overdue this page
                  accepts; a stale copy rendered from a snapshot is worse than
                  one query. The runbook sends you to the function.
                */}
                Read <code className="font-mono">SELECT * FROM scheduler_overdue()</code> for the
                job names. Cadence lives in{" "}
                <code className="font-mono">scheduler_job_expectations</code> and is not
                re-derived here — two definitions of &ldquo;overdue&rdquo; would agree for a
                while and then quietly disagree.
              </p>
            </>
          )}
        </CardContent>
      </Card>

      {/* ---------------- incidents ---------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Recent alerts</CardTitle>
        </CardHeader>
        <CardContent>
          {snapshot.alerts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing has fired. On a system whose recorder is running, that is good news;
              check the banner above before believing it.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-1">When</th>
                  <th className="py-1">Alert</th>
                  <th className="py-1">Runbook</th>
                  <th className="py-1 text-right">Raised</th>
                  <th className="py-1 text-right">Suppressed</th>
                  <th className="py-1">Delivered</th>
                  <th className="py-1">Acknowledged</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.alerts.map((a) => (
                  <tr key={a.id} className="border-b last:border-0 align-top">
                    <td className="py-1 whitespace-nowrap text-xs">{when(a.lastRaisedAt)}</td>
                    <td className="py-1">
                      <div className="font-medium">{a.title}</div>
                      <div className="font-mono text-xs text-muted-foreground">{a.alertKey}</div>
                    </td>
                    <td className="py-1 font-mono text-xs">{a.runbookKey}</td>
                    <td className="py-1 text-right tabular-nums">{a.raiseCount}</td>
                    <td className="py-1 text-right tabular-nums">{a.suppressedCount}</td>
                    <td className="py-1 text-xs">
                      {a.delivered ? "yes" : (a.deliveryError ?? "no")}
                    </td>
                    <td className="py-1 text-xs">
                      {a.acknowledgedAt ? (
                        `${a.acknowledgedBy} · ${when(a.acknowledgedAt)}`
                      ) : (
                        <form action={onAcknowledge} className="flex gap-1">
                          <input type="hidden" name="alertId" value={a.id} />
                          <input
                            name="note"
                            maxLength={500}
                            placeholder="what you did"
                            className="w-40 rounded border border-border bg-background px-1 py-0.5 text-xs"
                          />
                          <button
                            type="submit"
                            className="rounded border border-border px-2 py-0.5 text-xs hover:bg-muted"
                          >
                            Acknowledge
                          </button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* ---------------- the audit stream ---------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">The audit-grade event stream</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {!stream.available ? (
            <p className="text-muted-foreground">{stream.reason}</p>
          ) : (
            <>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-1">Source table</th>
                    <th className="py-1 text-right">Events (30d)</th>
                    <th className="py-1">Latest</th>
                  </tr>
                </thead>
                <tbody>
                  {stream.bySource.map((s) => (
                    <tr key={s.sourceTable} className="border-b last:border-0">
                      <td className="py-1 font-mono text-xs">{s.sourceTable}</td>
                      <td className="py-1 text-right tabular-nums">{s.events.toLocaleString()}</td>
                      <td className="py-1 text-xs">{when(s.latest)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/*
                🔴 THESE ARE NOT LINKS, AND THE REASON IS RECORDED RATHER
                THAN WORKED AROUND.

                The export handler exists — `server/observability/
                siem-export-handler.ts`, guarded, wrapped and tested — but
                the two-line `route.ts` that mounts it must live under
                `app/`, and Track B's assigned `app/` block cannot contain
                a file (see `reliability-page.tsx`). So the endpoint has no
                URL until PATCH-REQUEST-B.md is applied.

                An `<a href>` to it today would be a dead link, and
                `npm run check:links` refuses one — correctly, and it
                refused this exact pair on the first run. Its message is
                worth quoting: "Build the destination, or remove the link.
                Do not add it to KNOWN_DEAD: that list is a record of
                existing damage being paid down, not a place to put new
                damage."

                ⭐ WHEN THE PATCH LANDS, these two spans become anchors to
                the paths already written below and this comment goes.
              */}
              <div className="flex flex-wrap items-center gap-2 border-t pt-2 text-xs">
                <span className="rounded border border-dashed border-border px-2 py-1 text-muted-foreground">
                  Download NDJSON — <code className="font-mono">GET /platform/reliability/export?format=ndjson</code>{" "}
                  (not mounted yet; see PATCH-REQUEST-B.md)
                </span>
                <span className="rounded border border-dashed border-border px-2 py-1 text-muted-foreground">
                  Download CEF — <code className="font-mono">?format=cef</code>
                </span>
                {/*
                  🔴 SEPARATE FROM THE DOWNLOAD, ON PURPOSE. Advancing the
                  cursor inside the download would make export at-most-once:
                  a cancelled stream or a curious click would skip a batch of
                  security evidence permanently. This button is the operator
                  saying the bytes landed, which is the one fact the system
                  cannot determine for itself.

                  ⚠️ IT WORKS TODAY. It is a server action, not a URL, so it
                  needs no route file — which is why the one control on this
                  panel that changes state is the one that is live.
                */}
                <form action={onCommitExport}>
                  <input type="hidden" name="format" value="ndjson" />
                  <button
                    type="submit"
                    className="rounded border border-border px-2 py-1 hover:bg-muted"
                  >
                    Mark that batch as delivered
                  </button>
                </form>
              </div>

              <div className="space-y-1 text-xs text-muted-foreground">
                {stream.destinations.length === 0 ? (
                  <p>
                    No export feed has been configured. The stream is queryable and
                    exportable regardless — a feed is only needed to push it somewhere.
                  </p>
                ) : (
                  stream.destinations.map((d) => (
                    <p key={d.destination}>
                      <span className="font-mono text-foreground">{d.destination}</span> ·{" "}
                      {d.format} · {d.exportedTotal.toLocaleString()} exported · last{" "}
                      {when(d.lastExportedAt)} · {d.pending ?? 0} pending
                      {d.lastError ? ` · last error: ${d.lastError}` : ""}
                    </p>
                  ))
                )}
                <p className="border-t pt-2">
                  {/*
                    ⭐ WAVE 14 SAID THIS COULD NEVER HAPPEN, AND IT WAS RIGHT
                    AT THE TIME. Track D built the recorder, so the sentence
                    is now wrong in one direction and still true in another:
                    the rows are possible and absent. Corrected rather than
                    deleted, because a status page that quietly stops saying
                    something is a status page nobody can date.
                  */}
                  🔴 Cross-tenant read raises are still absent from this stream, and the
                  reason has changed. Track D built{" "}
                  <code className="font-mono">lib/security/platform-scope.ts</code> and added{" "}
                  <code className="font-mono">platform.scope_raised</code> to the vocabulary, so
                  the mechanism exists — but nothing calls{" "}
                  <code className="font-mono">recordPlatformScopeRaise()</code> outside its own
                  tests, and <code className="font-mono">db/index.ts</code> still discards the
                  justification it demands. Wave 14 said these rows could never exist. They can
                  now; they still do not. A missing caller and a missing mechanism need
                  different work from different people.
                </p>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* ---------------- notes ---------------- */}
      {snapshot.notes.length > 0 || sweep.notes.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">What this page could not measure</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-xs text-muted-foreground">
            {[...new Set([...snapshot.notes, ...sweep.notes])].map((n, i) => (
              <p key={i}>{n}</p>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}
