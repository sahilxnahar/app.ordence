/**
 * Ordence — One Run, Step By Step
 * Version: v0.24.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ A FAILED RUN MUST SAY WHICH STEP FAILED AND WHY, ABOVE THE FOLD
 * ══════════════════════════════════════════════════════════════════════
 * `workflow_runs` carries `error` and `error_step_key` precisely so this
 * page does not have to infer it, and the banner is rendered before the
 * table so it is the first thing read. A run detail that shows a red
 * badge and a list of twenty rows makes the reader do the search the
 * database already did.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ ONE ROW PER STEP EXECUTION, NOT PER STEP IN THE DEFINITION
 * ══════════════════════════════════════════════════════════════════════
 * Four steps inside a loop over fifty records is two hundred rows, and
 * that is the point: "which iteration failed, and what was the item?" is
 * the first question anybody asks, and it cannot be answered by a table
 * with four rows in it. The iteration number is a column.
 *
 * ⚠️ THE INPUT SHOWN IS THE RESOLVED ONE. `{{ trigger.record.email }}`
 * tells you nothing about why the email went to the wrong person; the
 * address it actually became tells you everything. It is behind a
 * `<details>` because it is long, not because it is secondary.
 *
 * ⚠️ NOTHING HERE UNDOES ANYTHING, AND THE PAGE SAYS SO. Steps already
 * executed have already happened: the email is sent, the record is
 * written. The failure banner states that explicitly, because a run
 * detail that reads like a transaction log invites somebody to look for
 * a rollback button that cannot exist.
 *
 * ⚠️ THERE IS NO CANCEL CONTROL ON THIS PAGE YET. `cancelWorkflowRun`
 * exists in the server actions; stopping a misbehaving automation is
 * currently done with the workflow's kill switch, which stops it
 * starting anything new. Cancelling one suspended run is a narrower
 * tool and is not wired up here.
 */

import Link from "next/link";
import { AlertOctagon } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ACTION_CATALOG } from "@/lib/workflows/actions";
import { TRIGGER_CATALOG } from "@/lib/workflows/triggers";
import type {
  WorkflowRunStatus,
  WorkflowStepStatus,
  WorkflowTaskStatus,
} from "@/db/schema/workflows";
import type {
  WorkflowActionType,
  WorkflowTriggerType,
} from "@/lib/workflows/program";
import {
  formatMoment,
  runDuration,
  RUN_STATUS_LABELS,
  RUN_STATUS_STYLES,
  STEP_STATUS_LABELS,
  STEP_STATUS_STYLES,
  TASK_STATUS_LABELS,
} from "./presentation";

export type RunDetailStep = {
  id: string;
  stepKey: string;
  stepPath: string;
  actionType: WorkflowActionType;
  status: WorkflowStepStatus;
  iteration: number | null;
  sequence: number;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
};

export type RunDetailProps = {
  run: {
    id: string;
    workflowId: string;
    workflowName: string | null;
    status: WorkflowRunStatus;
    triggerType: WorkflowTriggerType;
    recordType: string | null;
    recordId: string | null;
    actorRole: string;
    depth: number;
    stepsExecuted: number;
    iterationsUsed: number;
    error: string | null;
    errorStepKey: string | null;
    stopReason: string | null;
    queuedAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    resumeAt: string | null;
  };
  steps: readonly RunDetailStep[];
  tasks: readonly {
    id: string;
    stepKey: string;
    title: string;
    status: WorkflowTaskStatus;
    expiresAt: string;
    respondedAt: string | null;
  }[];
};

export function RunDetail({ run, steps, tasks }: RunDetailProps) {
  const duration = runDuration(run.startedAt, run.finishedAt);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">
            {run.workflowName ?? "(deleted workflow)"}
          </h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {TRIGGER_CATALOG[run.triggerType].label} · queued{" "}
            {formatMoment(run.queuedAt)}
            {duration ? ` · took ${duration}` : ""} · ran as a{" "}
            <span className="font-mono">{run.actorRole}</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex rounded border px-2 py-1 text-xs font-medium ${RUN_STATUS_STYLES[run.status]}`}
          >
            {RUN_STATUS_LABELS[run.status]}
          </span>
          <Link
            href={`/automations/${run.workflowId}`}
            className="text-xs font-medium text-primary hover:underline"
          >
            Open the workflow
          </Link>
        </div>
      </header>

      {/* ⭐ WHICH STEP FAILED, AND WHY — FIRST. */}
      {run.status === "failed" ? (
        <div
          role="alert"
          className="rounded-lg border border-red-500/40 bg-red-500/10 p-3"
        >
          <div className="flex items-start gap-2">
            <AlertOctagon
              className="mt-0.5 h-5 w-5 shrink-0 text-red-700"
              aria-hidden="true"
            />
            <div className="text-sm text-red-900">
              <p className="font-semibold">
                {run.errorStepKey ? (
                  <>
                    This run failed at the step{" "}
                    <code className="font-mono">{run.errorStepKey}</code>.
                  </>
                ) : (
                  "This run failed."
                )}
              </p>
              <p className="mt-1">{run.error ?? "No reason was recorded."}</p>
              <p className="mt-1 text-xs opacity-90">
                Steps that ran before it already happened — an email that was sent
                cannot be recalled, and a record that was written stays written.
                Everything below is the record of what did happen.
              </p>
            </div>
          </div>
        </div>
      ) : null}

      {run.status === "stopped" && run.stopReason ? (
        <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
          <strong className="font-medium">Stopped early, which is not a failure.</strong>{" "}
          {run.stopReason}
        </p>
      ) : null}

      {run.status === "waiting_form" ? (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-900">
          Waiting for a person to answer an approval. It resumes when they do, or ends
          when the request expires.
        </p>
      ) : null}

      {run.status === "waiting_delay" && run.resumeAt ? (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-900">
          Waiting on a timer. It continues at {formatMoment(run.resumeAt)}.
        </p>
      ) : null}

      <dl className="grid grid-cols-2 gap-3 rounded-lg border border-border bg-card p-3 text-xs sm:grid-cols-4">
        <Fact label="Steps executed" value={String(run.stepsExecuted)} />
        <Fact label="Loop iterations" value={String(run.iterationsUsed)} />
        <Fact
          label="Chain depth"
          value={
            run.depth === 0
              ? "0 — started by an event, not by another workflow"
              : String(run.depth)
          }
        />
        <Fact
          label="Triggering record"
          value={run.recordType ? `${run.recordType} ${run.recordId ?? ""}` : "None"}
        />
      </dl>

      {tasks.length > 0 ? (
        <section aria-label="Approvals in this run" className="rounded-lg border border-border">
          <h2 className="border-b border-border px-3 py-2 text-sm font-semibold">
            Approvals
          </h2>
          <ul className="divide-y divide-border">
            {tasks.map((task) => (
              <li key={task.id} className="px-3 py-2 text-xs">
                <span className="font-medium">{task.title}</span>{" "}
                <span className="text-muted-foreground">
                  ({task.stepKey}) — {TASK_STATUS_LABELS[task.status]}
                  {task.respondedAt
                    ? `, answered ${formatMoment(task.respondedAt)}`
                    : `, expires ${formatMoment(task.expiresAt)}`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-label="Steps" className="rounded-lg border border-border">
        <h2 className="border-b border-border px-3 py-2 text-sm font-semibold">
          What it did, in order
        </h2>

        {steps.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            No step ever started. The run was stopped or cancelled before its first
            step.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12 text-right">#</TableHead>
                <TableHead>Step</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead className="text-right">Took</TableHead>
                <TableHead>Detail</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {steps.map((step) => {
                const failed = step.status === "failed";
                return (
                  <TableRow
                    key={step.id}
                    className={failed ? "bg-red-500/5" : undefined}
                  >
                    <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
                      {step.sequence}
                    </TableCell>

                    <TableCell>
                      <p className="font-mono text-xs font-medium">{step.stepKey}</p>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        {ACTION_CATALOG[step.actionType].label}
                        {step.iteration !== null
                          ? ` · iteration ${step.iteration + 1}`
                          : ""}
                        {" · "}
                        <span className="font-mono">{step.stepPath}</span>
                      </p>
                    </TableCell>

                    <TableCell>
                      <span
                        className={`inline-flex rounded border px-1.5 py-0.5 text-[11px] font-medium ${STEP_STATUS_STYLES[step.status]}`}
                      >
                        {STEP_STATUS_LABELS[step.status]}
                      </span>
                      {step.error ? (
                        <p className="mt-0.5 max-w-md text-[11px] text-red-700">
                          {step.error}
                        </p>
                      ) : null}
                    </TableCell>

                    <TableCell className="text-right text-xs tabular-nums">
                      {runDuration(step.startedAt, step.finishedAt) ?? (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>

                    <TableCell>
                      {step.input || step.output ? (
                        <details>
                          <summary className="cursor-pointer text-[11px] text-primary">
                            What it was given and what it returned
                          </summary>
                          <div className="mt-1 space-y-1">
                            {step.input ? (
                              <Payload label="Given (resolved)" value={step.input} />
                            ) : null}
                            {step.output ? (
                              <Payload label="Returned" value={step.output} />
                            ) : null}
                          </div>
                        </details>
                      ) : (
                        <span className="text-[11px] text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-medium">{value}</dd>
    </div>
  );
}

function Payload({ label, value }: { label: string; value: Record<string, unknown> }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <pre className="mt-0.5 max-h-48 overflow-auto rounded border border-border bg-muted/40 p-1.5 text-[10px]">
        {safeJson(value)}
      </pre>
    </div>
  );
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return "(could not be displayed)";
  }
}
