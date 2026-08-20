"use server";

/**
 * Ordence — OPERATOR ACTIONS ON THE JOB CONTROL PLANE
 * Version: v1.82.0-alpha (Wave 14, Track A)
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ EVERY EXPORT OF A `"use server"` MODULE IS A BROWSER-REACHABLE RPC
 *    ENDPOINT
 * ══════════════════════════════════════════════════════════════════════
 * That is the house rule stated in `server/actions/views.ts` and
 * `server/platform/control-actions.ts`, and it is why every export below
 * is an async function taking `unknown`, validating with zod, and calling
 * `requireCapability` FIRST. No schema, no constant and no type is
 * exported from this file.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 `flags:write`, AND IT REQUIRES STEP-UP
 * ══════════════════════════════════════════════════════════════════════
 * Reading the calendar is `observatory:read`, which every grade holds —
 * "did dunning run last night" is a question the person answering the
 * phone needs answered.
 *
 * Running a job, pausing one, or replaying a slot is `flags:write`, which
 * `lib/platform/roles.ts` gives to engineer and owner and lists in
 * STEP_UP_CAPABILITIES. That is deliberate and it is the closest existing
 * key: these actions are operational levers on one deployment, the same
 * shape as a feature flag, and pressing Run now on `dunning_sweep` queues
 * statutory demand notices — which should not be reachable with a lifted
 * cookie and no second factor.
 *
 * ⚠️ A NEW `scheduler:operate` CAPABILITY WOULD BE A BETTER FIT AND IS NOT
 * ADDED HERE. `lib/platform/roles.ts` belongs to another stream this
 * wave, and that file says in its own header that keys are stable
 * identifiers which fail closed — inventing one from this track would
 * mean every grade lacks it until the other change lands, i.e. a page
 * nobody can use. PATCH-REQUEST-A.md asks for it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * EVERY ACTION IS AUDITED WITH THE OPERATOR'S OWN JUSTIFICATION
 * ══════════════════════════════════════════════════════════════════════
 * `recordPlatformAudit` with `tenantId: null` writes to
 * `platform_action_log`, whose `justification` column is NOT NULL. The
 * same text is stored on the `scheduler_runs` row, where 0129's
 * `scheduler_runs_hand_started_is_justified` CHECK refuses anything under
 * twenty characters. Two places, on purpose: the audit log answers "who
 * did what", the ledger answers "why did this run happen", and the person
 * asking the second question is looking at a run, not at a log.
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireCapability, recordPlatformAudit } from "@/server/platform/guard";
import { runNow, runBackfill, missedSlots } from "@/server/scheduler/tick";
import {
  liftTenantPause,
  pauseTenant,
  requestCancel,
  setJobEnabled,
} from "@/server/scheduler/ledger";
import { findCatalogEntry } from "@/server/scheduler/catalog";

const PAGE = "/jobs";  // see layout.tsx for why this is not /platform/jobs yet

/**
 * Twenty characters, matching 0129's CHECK constraint exactly.
 *
 * ⚠️ THE NUMBER IS DUPLICATED BETWEEN HERE AND THE DATABASE ON PURPOSE.
 * The form check exists to give a readable error; the constraint exists
 * because a form check is a constraint until somebody writes a second
 * caller. If they ever disagree the database wins, which is the correct
 * direction for them to disagree in.
 */
const justification = z
  .string()
  .trim()
  .min(20, "Say why, in at least 20 characters. It is recorded against the run.");

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export async function runJobNow(input: unknown): Promise<Result<{ note: string }>> {
  const operator = await requireCapability("flags:write");

  const parsed = z
    .object({
      jobId: z.string().min(1),
      tenantId: z.string().uuid().nullable().optional(),
      justification,
    })
    .safeParse(input);

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the form." };
  }

  const entry = findCatalogEntry(parsed.data.jobId);
  if (!entry) return { ok: false, error: `No job called "${parsed.data.jobId}".` };

  const outcome = await runNow({
    jobId: parsed.data.jobId,
    subjectTenantId: parsed.data.tenantId ?? null,
    justification: parsed.data.justification,
    operator: operator.email,
  });

  await recordPlatformAudit({
    operator: {
      clerkUserId: operator.clerkUserId,
      email: operator.email,
      grade: operator.grade,
      ipAddress: operator.ipAddress,
      userAgent: operator.userAgent,
      requestId: operator.requestId,
    },
    tenantId: null,
    action: "update",
    resourceType: "scheduler_run",
    resourceId: parsed.data.jobId,
    newValue: {
      jobId: parsed.data.jobId,
      subjectTenantId: parsed.data.tenantId ?? null,
      accepted: outcome.ok,
      state: outcome.ok ? outcome.outcome.state : null,
      error: outcome.ok ? outcome.outcome.error : outcome.error,
    },
    reason: parsed.data.justification,
    /**
     * ⚠️ `warning`, NOT `info`. A hand-started `dunning_sweep` queues
     * statutory demand notices outside the schedule. Filing that at the
     * same severity as reading a page means it does not stand out in the
     * log somebody reads after a customer complains about a letter.
     */
    severity: "warning",
  });

  revalidatePath(PAGE);

  if (!outcome.ok) return { ok: false, error: outcome.error };

  const o = outcome.outcome;
  return {
    ok: true,
    data: {
      note:
        `${parsed.data.jobId}: ${o.state} in ${o.tookMs}ms` +
        (o.error ? ` — ${o.error}` : "") +
        (o.state === "skipped_paused"
          ? " (this job or workspace is paused; lift the pause first)"
          : ""),
    },
  };
}

export async function cancelRun(input: unknown): Promise<Result<{ note: string }>> {
  const operator = await requireCapability("flags:write");

  const parsed = z
    .object({ runId: z.string().uuid(), justification })
    .safeParse(input);

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the form." };
  }

  const asked = await requestCancel({
    runId: parsed.data.runId,
    by: operator.email,
    reason: parsed.data.justification,
  });

  await recordPlatformAudit({
    operator: {
      clerkUserId: operator.clerkUserId,
      email: operator.email,
      grade: operator.grade,
      ipAddress: operator.ipAddress,
      userAgent: operator.userAgent,
      requestId: operator.requestId,
    },
    tenantId: null,
    action: "update",
    resourceType: "scheduler_run_cancel",
    resourceId: parsed.data.runId,
    newValue: { accepted: asked },
    reason: parsed.data.justification,
    severity: "warning",
  });

  revalidatePath(PAGE);

  if (!asked) {
    return { ok: false, error: "That run has already finished. Nothing was cancelled." };
  }

  return {
    ok: true,
    data: {
      /**
       * 🔴 THE WORDING IS THE SPECIFICATION. Cancellation is cooperative:
       * the running job reads the flag at its next workspace boundary. A
       * button that said "Cancelled" would be claiming something the
       * system cannot do, which is exactly the kind of claim this
       * codebase has 23 recorded instances of.
       */
      note:
        "Cancellation requested. The run stops at its next workspace boundary — it is not " +
        "preempted. If it is wedged inside one workspace it will be marked abandoned once " +
        "its heartbeat goes stale (30 minutes).",
    },
  };
}

export async function setJobPaused(input: unknown): Promise<Result<{ note: string }>> {
  const operator = await requireCapability("flags:write");

  const parsed = z
    .object({ jobId: z.string().min(1), enabled: z.boolean(), justification })
    .safeParse(input);

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the form." };
  }
  if (!findCatalogEntry(parsed.data.jobId)) {
    return { ok: false, error: `No job called "${parsed.data.jobId}".` };
  }

  await setJobEnabled({
    jobId: parsed.data.jobId,
    enabled: parsed.data.enabled,
    reason: parsed.data.justification,
    by: operator.email,
  });

  await recordPlatformAudit({
    operator: {
      clerkUserId: operator.clerkUserId,
      email: operator.email,
      grade: operator.grade,
      ipAddress: operator.ipAddress,
      userAgent: operator.userAgent,
      requestId: operator.requestId,
    },
    tenantId: null,
    action: "config_change",
    resourceType: "scheduler_job_control",
    resourceId: parsed.data.jobId,
    newValue: { enabled: parsed.data.enabled },
    reason: parsed.data.justification,
    severity: parsed.data.enabled ? "notice" : "warning",
  });

  revalidatePath(PAGE);

  return {
    ok: true,
    data: {
      note: parsed.data.enabled
        ? `${parsed.data.jobId} re-enabled. Its watchdog alarm resumes with its next window.`
        : `${parsed.data.jobId} disabled. It stops alarming as deliberately-silent for 30 days; ` +
          `after that the watchdog treats the pause as an outage, because a pause nobody has ` +
          `revisited in a month is not a decision any more.`,
    },
  };
}

export async function pauseWorkspace(input: unknown): Promise<Result<{ note: string }>> {
  const operator = await requireCapability("flags:write");

  const parsed = z
    .object({
      /** `*` pauses the workspace from every job. */
      jobId: z.string().min(1),
      tenantId: z.string().uuid(),
      expiresAt: z.string().datetime().nullable().optional(),
      justification,
    })
    .safeParse(input);

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the form." };
  }
  if (parsed.data.jobId !== "*" && !findCatalogEntry(parsed.data.jobId)) {
    return { ok: false, error: `No job called "${parsed.data.jobId}".` };
  }

  try {
    await pauseTenant({
      jobId: parsed.data.jobId,
      subjectTenantId: parsed.data.tenantId,
      reason: parsed.data.justification,
      by: operator.email,
      expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
    });
  } catch (err) {
    /**
     * ⚠️ THE UNIQUE INDEX ON (job, workspace) WHERE lifted_at IS NULL is
     * what lands here. Reporting it as "already paused" rather than as a
     * database error is the difference between an operator lifting the
     * existing pause and an operator filing a bug.
     */
    return {
      ok: false,
      error:
        `That workspace already has an active pause on ${parsed.data.jobId}. Lift it first, ` +
        `so there is one pause with one reason rather than two contradictory ones. ` +
        `(${err instanceof Error ? err.message : String(err)})`,
    };
  }

  await recordPlatformAudit({
    operator: {
      clerkUserId: operator.clerkUserId,
      email: operator.email,
      grade: operator.grade,
      ipAddress: operator.ipAddress,
      userAgent: operator.userAgent,
      requestId: operator.requestId,
    },
    /**
     * ⭐ `tenantId` IS SET HERE AND NULL EVERYWHERE ELSE IN THIS FILE, and
     * the difference decides which table the row lands in.
     * `recordPlatformAudit` routes a non-null tenant into that
     * workspace's own hash-chained `audit_logs`. That is right: pausing a
     * workspace from dunning is a decision ABOUT that customer and
     * belongs in the record somebody pulls when the customer asks why
     * they stopped receiving reminders.
     */
    tenantId: parsed.data.tenantId,
    action: "config_change",
    resourceType: "scheduler_tenant_pause",
    resourceId: parsed.data.jobId,
    newValue: { jobId: parsed.data.jobId, expiresAt: parsed.data.expiresAt ?? null },
    reason: parsed.data.justification,
    severity: "warning",
  });

  revalidatePath(PAGE);

  return {
    ok: true,
    data: {
      note:
        `Workspace paused from ${parsed.data.jobId === "*" ? "every job" : parsed.data.jobId}` +
        (parsed.data.expiresAt ? ` until ${parsed.data.expiresAt}.` : ", indefinitely.") +
        (parsed.data.expiresAt
          ? ""
          : " An indefinite pause is not reviewed by anything; consider an expiry."),
    },
  };
}

export async function liftWorkspacePause(input: unknown): Promise<Result<{ note: string }>> {
  const operator = await requireCapability("flags:write");

  const parsed = z.object({ pauseId: z.string().uuid(), justification }).safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the form." };
  }

  const lifted = await liftTenantPause({
    pauseId: parsed.data.pauseId,
    by: operator.email,
    reason: parsed.data.justification,
  });

  await recordPlatformAudit({
    operator: {
      clerkUserId: operator.clerkUserId,
      email: operator.email,
      grade: operator.grade,
      ipAddress: operator.ipAddress,
      userAgent: operator.userAgent,
      requestId: operator.requestId,
    },
    tenantId: null,
    action: "config_change",
    resourceType: "scheduler_tenant_pause_lift",
    resourceId: parsed.data.pauseId,
    newValue: { lifted },
    reason: parsed.data.justification,
    severity: "notice",
  });

  revalidatePath(PAGE);

  if (!lifted) return { ok: false, error: "That pause was already lifted." };
  return { ok: true, data: { note: "Pause lifted. The job resumes at its next slot." } };
}

export async function backfillJob(input: unknown): Promise<Result<{ note: string }>> {
  const operator = await requireCapability("flags:write");

  const parsed = z
    .object({
      jobId: z.string().min(1),
      tenantId: z.string().uuid().nullable().optional(),
      sinceHours: z.number().int().min(1).max(30 * 24),
      justification,
    })
    .safeParse(input);

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the form." };
  }

  const missed = await missedSlots({
    jobId: parsed.data.jobId,
    subjectTenantId: parsed.data.tenantId ?? null,
    sinceHours: parsed.data.sinceHours,
  });

  if (missed.length === 0) {
    return {
      ok: false,
      error:
        `No missed slots for ${parsed.data.jobId} in the last ${parsed.data.sinceHours}h. ` +
        `A slot that was SKIPPED — because the job or the workspace was paused — is not ` +
        `missed, it was decided, and it is deliberately not offered for replay.`,
    };
  }

  const result = await runBackfill({
    jobId: parsed.data.jobId,
    subjectTenantId: parsed.data.tenantId ?? null,
    slots: missed.map((m) => m.slotAt),
    justification: parsed.data.justification,
    operator: operator.email,
  });

  await recordPlatformAudit({
    operator: {
      clerkUserId: operator.clerkUserId,
      email: operator.email,
      grade: operator.grade,
      ipAddress: operator.ipAddress,
      userAgent: operator.userAgent,
      requestId: operator.requestId,
    },
    tenantId: null,
    action: "update",
    resourceType: "scheduler_backfill",
    resourceId: parsed.data.jobId,
    newValue: {
      slotsFound: missed.length,
      accepted: result.ok,
      ran: result.ok ? result.outcomes.length : 0,
      error: result.ok ? null : result.error,
    },
    reason: parsed.data.justification,
    severity: "warning",
  });

  revalidatePath(PAGE);

  if (!result.ok) return { ok: false, error: result.error };

  const ran = result.outcomes.filter((o) => o.state === "succeeded").length;
  const refused = result.outcomes.filter((o) => o.state === "not_claimed").length;
  const failed = result.outcomes.filter(
    (o) => o.state === "failed" || o.state === "budget_exceeded",
  ).length;

  return {
    ok: true,
    data: {
      note:
        `${missed.length} missed slot(s) found; ${ran} replayed, ${refused} already claimed by ` +
        `a live run, ${failed} failed. Replayed oldest first` +
        (failed > 0 ? ", and stopped at the first failure so later slots are not run over a gap." : "."),
    },
  };
}
