/**
 * Ordence — Workflow Presentation Helpers
 * Version: v0.24.0-alpha
 *
 * Pure formatting. Labels, durations and badge styling for the four
 * automation surfaces.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ NO STATE IS EVER COMMUNICATED BY COLOUR ALONE
 * ══════════════════════════════════════════════════════════════════════
 * Every map below pairs a colour class with a WORD. A red badge with no
 * text is invisible to a screen reader, indistinguishable from amber to
 * roughly one man in twelve, and meaningless in a printed report — and
 * "which of my automations failed last night" is exactly the question
 * somebody asks from a phone in bright sunlight.
 *
 * The colour is the shortcut. The word is the answer.
 */

import type {
  WorkflowRunStatus,
  WorkflowStepStatus,
  WorkflowTaskStatus,
  WorkflowVersionStatus,
} from "@/db/schema/workflows";

/* ------------------------------------------------------------------ */
/* RUN STATUS                                                          */
/* ------------------------------------------------------------------ */

export const RUN_STATUS_LABELS: Record<WorkflowRunStatus, string> = {
  queued: "Queued",
  running: "Running",
  waiting_delay: "Waiting — timer",
  waiting_form: "Waiting — approval",
  succeeded: "Succeeded",
  // ⚠️ Not "Succeeded". A filter that ended the run correctly, having done
  // nothing, is a different fact from a run that did its work — and the
  // difference is the whole reason `stopped` exists as a status.
  stopped: "Stopped early",
  failed: "Failed",
  cancelled: "Cancelled",
};

export const RUN_STATUS_STYLES: Record<WorkflowRunStatus, string> = {
  queued: "border-slate-500/30 bg-slate-500/10 text-slate-600",
  running: "border-sky-500/30 bg-sky-500/10 text-sky-700",
  waiting_delay: "border-amber-500/30 bg-amber-500/10 text-amber-700",
  waiting_form: "border-amber-500/30 bg-amber-500/10 text-amber-700",
  succeeded: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700",
  stopped: "border-slate-500/30 bg-slate-500/10 text-slate-600",
  failed: "border-red-500/30 bg-red-500/10 text-red-700",
  cancelled: "border-slate-500/30 bg-slate-500/10 text-slate-600",
};

export const STEP_STATUS_LABELS: Record<WorkflowStepStatus, string> = {
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  skipped: "Skipped",
};

export const STEP_STATUS_STYLES: Record<WorkflowStepStatus, string> = {
  running: "border-sky-500/30 bg-sky-500/10 text-sky-700",
  succeeded: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700",
  failed: "border-red-500/30 bg-red-500/10 text-red-700",
  skipped: "border-slate-500/30 bg-slate-500/10 text-slate-600",
};

export const TASK_STATUS_LABELS: Record<WorkflowTaskStatus, string> = {
  pending: "Waiting for an answer",
  approved: "Approved",
  rejected: "Rejected",
  expired: "Expired unanswered",
  cancelled: "Cancelled",
};

export const VERSION_STATUS_LABELS: Record<WorkflowVersionStatus, string> = {
  draft: "Draft",
  active: "Active",
  archived: "Archived",
};

/* ------------------------------------------------------------------ */
/* THE LIST PAGE'S STATUS COLUMN                                       */
/* ------------------------------------------------------------------ */

/**
 * What a workflow's state actually is, from three separate facts.
 *
 * ⚠️ "Active" needs BOTH an active version AND the kill switch on. A
 * workflow whose version is live but whose `is_enabled` is false does
 * not run, and a list that shows it as active is the reason somebody
 * spends an afternoon debugging a workflow that was switched off.
 */
export type WorkflowState = "draft" | "active" | "paused" | "archived";

export function workflowState(args: {
  archivedAt: Date | string | null;
  isEnabled: boolean;
  activeVersion: number | null;
}): WorkflowState {
  if (args.archivedAt) return "archived";
  if (args.activeVersion === null) return "draft";
  return args.isEnabled ? "active" : "paused";
}

export const WORKFLOW_STATE_LABELS: Record<WorkflowState, string> = {
  draft: "Draft — never published",
  active: "Active",
  paused: "Switched off",
  archived: "Archived",
};

export const WORKFLOW_STATE_STYLES: Record<WorkflowState, string> = {
  draft: "border-slate-500/30 bg-slate-500/10 text-slate-600",
  active: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700",
  paused: "border-amber-500/30 bg-amber-500/10 text-amber-700",
  archived: "border-slate-500/30 bg-slate-500/10 text-slate-600",
};

/* ------------------------------------------------------------------ */
/* TIME                                                                */
/* ------------------------------------------------------------------ */

/**
 * How long a run took.
 *
 * Returns null rather than "0s" when the run has not finished — an
 * unfinished run has no duration, and printing one implies it stopped.
 */
export function runDuration(
  startedAt: Date | string | null,
  finishedAt: Date | string | null,
): string | null {
  if (!startedAt || !finishedAt) return null;
  const start = new Date(startedAt).getTime();
  const end = new Date(finishedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return formatDuration(end - start);
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.max(0, Math.round(ms))}ms`;
  const seconds = ms / 1_000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** Absolute, in the reader's locale. Ambiguity here costs an afternoon. */
export function formatMoment(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** A wait, expressed the way a person would say it. */
export function describeSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "no time at all";
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${round(minutes)} minute${round(minutes) === 1 ? "" : "s"}`;
  const hours = minutes / 60;
  if (hours < 48) return `${round(hours)} hour${round(hours) === 1 ? "" : "s"}`;
  const days = hours / 24;
  return `${round(days)} day${round(days) === 1 ? "" : "s"}`;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
