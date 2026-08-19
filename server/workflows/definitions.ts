import "server-only";

/**
 * Ordence — Workflow Definitions
 * Version: v0.23.0-alpha
 *
 * Create, draft, publish, archive. The database enforces the rules (see
 * `SQL-FILES/0018_phase23_workflows.sql`); this file is where they are
 * explained to a person before they hit one.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ PUBLISHING IS THE MOMENT AUTHORITY IS DELEGATED
 * ══════════════════════════════════════════════════════════════════════
 * Everything else here is bookkeeping. Publishing is not: it makes a
 * definition live AND, for scheduled and webhook triggers, lends the
 * publisher's own identity to every unattended run the workflow will ever
 * make.
 *
 * Three things follow, and all three are implemented below rather than
 * described in documentation nobody reads:
 *
 *   1. It has its own permission (`workflows:publish`), on the dangerous
 *      list, separate from editing a draft. A draft never runs.
 *   2. It requires an explicit acknowledgement in the input — a
 *      delegation made by accident is one nobody can account for later.
 *   3. ⭐ THE PUBLISHER MUST PERSONALLY HOLD EVERY PERMISSION THE
 *      DEFINITION NEEDS. Checked here, at publish, because the
 *      alternative is discovering it at 2am when the scheduled run fails
 *      half way through — having already done the first half.
 */

import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { workflows, workflowVersions, workflowRuns } from "@/db/schema";
import { requirePermission, writeAudit } from "@/server/audit";
import { requireFeature } from "@/server/entitlements";
import { guardWorkflowWrite, workflowFail, toWorkflowActionError } from "./guards";
import {
  archiveWorkflowSchema,
  createWorkflowSchema,
  publishVersionSchema,
  saveDraftSchema,
  setEnabledSchema,
} from "@/lib/validators/workflows";
import { validateDefinition, summariseValidation } from "@/lib/workflows/validation";
import { permissionsRequiredBy } from "@/lib/workflows/actions";
import { permissionForRecordAction } from "@/lib/workflows/records";
import { collectSteps } from "@/lib/workflows/planner";
import { nextCronFireAt } from "@/lib/workflows/cron";
import { DEFAULT_STEP_BUDGET } from "@/lib/workflows/limits";
import { evaluatePermission } from "@/lib/permissions";
import type { FeatureKey } from "@/lib/entitlements/features";
import type { ActionResult } from "@/lib/validators/crm";
import type {
  WorkflowActionType,
  WorkflowProgram,
  WorkflowStep,
  WorkflowTriggerType,
} from "@/lib/workflows/program";
import type { Workflow, WorkflowVersion } from "@/db/schema/workflows";

/* ------------------------------------------------------------------ */
/* READ                                                               */
/* ------------------------------------------------------------------ */

export type WorkflowSummary = Workflow & {
  activeVersion: number | null;
  activeTrigger: WorkflowTriggerType | null;
  draftVersion: number | null;
};

export async function listWorkflows(): Promise<ActionResult<{ rows: WorkflowSummary[] }>> {
  try {
    // ⚠️ `requirePermission` alone. Reads are never entitlement-gated —
    // a workspace whose plan lapsed must still be able to SEE what its
    // automations are, if only to switch them off.
    const ctx = await requirePermission("workflows:read");

    const rows = await withTenant(ctx.tenant.id, async (tx) => {
      const found = await tx
        .select()
        .from(workflows)
        .where(and(eq(workflows.tenantId, ctx.tenant.id), isNull(workflows.archivedAt)))
        .orderBy(asc(workflows.name))
        .limit(200);

      const versions = await tx
        .select({
          workflowId: workflowVersions.workflowId,
          version: workflowVersions.version,
          status: workflowVersions.status,
          triggerType: workflowVersions.triggerType,
        })
        .from(workflowVersions)
        .where(eq(workflowVersions.tenantId, ctx.tenant.id));

      return found.map((workflow) => {
        const mine = versions.filter((v) => v.workflowId === workflow.id);
        const active = mine.find((v) => v.status === "active");
        const drafts = mine.filter((v) => v.status === "draft");
        return {
          ...workflow,
          activeVersion: active?.version ?? null,
          activeTrigger: active?.triggerType ?? null,
          draftVersion: drafts.length
            ? Math.max(...drafts.map((d) => d.version))
            : null,
        };
      });
    });

    return { ok: true, data: { rows } };
  } catch (err) {
    return toWorkflowActionError(err, "listWorkflows");
  }
}

export async function getWorkflow(input: { id: string }): Promise<
  ActionResult<{ workflow: Workflow; versions: WorkflowVersion[]; runCount: number }>
> {
  try {
    const ctx = await requirePermission("workflows:read");

    const found = await withTenant(ctx.tenant.id, async (tx) => {
      const [workflow] = await tx
        .select()
        .from(workflows)
        .where(and(eq(workflows.id, input.id), eq(workflows.tenantId, ctx.tenant.id)))
        .limit(1);

      if (!workflow) return null;

      const versions = await tx
        .select()
        .from(workflowVersions)
        .where(
          and(
            eq(workflowVersions.workflowId, workflow.id),
            eq(workflowVersions.tenantId, ctx.tenant.id),
          ),
        )
        .orderBy(desc(workflowVersions.version));

      const [counted] = await tx
        .select({ value: sql<string>`count(*)::text` })
        .from(workflowRuns)
        .where(
          and(
            eq(workflowRuns.workflowId, workflow.id),
            eq(workflowRuns.tenantId, ctx.tenant.id),
          ),
        );

      return { workflow, versions, runCount: Number(counted?.value ?? "0") };
    });

    if (!found) return workflowFail("That workflow does not exist, or you cannot see it.");
    return { ok: true, data: found };
  } catch (err) {
    return toWorkflowActionError(err, "getWorkflow");
  }
}

/* ------------------------------------------------------------------ */
/* CREATE                                                             */
/* ------------------------------------------------------------------ */

export async function createWorkflow(input: unknown): Promise<
  ActionResult<{ id: string; versionId: string }>
> {
  try {
    const ctx = await guardWorkflowWrite({
      operation: "workflows:create",
      feature: "workflows.builder",
      permission: "workflows:create",
    });

    const data = createWorkflowSchema.parse(input);

    const created = await withTenant(ctx.tenant.id, async (tx) => {
      const [workflow] = await tx
        .insert(workflows)
        .values({
          tenantId: ctx.tenant.id,
          key: data.key,
          name: data.name,
          description: data.description ?? null,
          // ⚠️ A NEW WORKFLOW IS SWITCHED OFF UNTIL SOMEBODY PUBLISHES.
          // `is_enabled` defaults true because that is what it means for a
          // published workflow; what stops this one running is that it has
          // no active version yet. Two independent conditions, and the
          // dispatcher requires both.
          createdBy: ctx.user.id,
        })
        .returning({ id: workflows.id });

      if (!workflow) throw new Error("Workflow insert returned no row.");

      const [version] = await tx
        .insert(workflowVersions)
        .values({
          tenantId: ctx.tenant.id,
          workflowId: workflow.id,
          version: 1,
          status: "draft",
          triggerType: data.triggerType,
          triggerConfig: data.triggerConfig ?? {},
          steps: (data.program?.steps ?? []) as WorkflowStep[],
          stepBudget: DEFAULT_STEP_BUDGET,
          createdBy: ctx.user.id,
        })
        .returning({ id: workflowVersions.id });

      if (!version) throw new Error("Version insert returned no row.");
      return { id: workflow.id, versionId: version.id };
    });

    await writeAudit(ctx, {
      action: "create",
      resourceType: "workflow",
      resourceId: created.id,
      newValue: { key: data.key, name: data.name, trigger: data.triggerType },
    });

    return { ok: true, data: created };
  } catch (err) {
    return toWorkflowActionError(err, "createWorkflow");
  }
}

/* ------------------------------------------------------------------ */
/* DRAFT                                                              */
/* ------------------------------------------------------------------ */

/**
 * Save a draft — either the existing one or a new one branched off the
 * live version.
 *
 * ⚠️ EDITING A LIVE WORKFLOW ALWAYS PRODUCES A DRAFT, NEVER AN EDIT.
 * The database refuses the edit anyway (Section 5), so doing it here is
 * about the message: "create a new draft" is a thing a person can do,
 * "insufficient_privilege" is not.
 */
export async function saveDraft(input: unknown): Promise<
  ActionResult<{ versionId: string; version: number; validation: string }>
> {
  try {
    const ctx = await guardWorkflowWrite({
      operation: "workflows:update",
      feature: "workflows.builder",
      permission: "workflows:update",
    });

    const data = saveDraftSchema.parse(input);

    // Validated on save as well as on publish. Errors do not block a save
    // — a half-built workflow is a normal state for something somebody is
    // still building — but the author sees them as they work.
    const validation = validateDefinition({
      triggerType: data.triggerType,
      triggerConfig: data.triggerConfig,
      program: data.program as WorkflowProgram,
      stepBudget: data.stepBudget,
    });

    const outcome = await withTenant(ctx.tenant.id, async (tx) => {
      const [workflow] = await tx
        .select({ id: workflows.id, archivedAt: workflows.archivedAt })
        .from(workflows)
        .where(
          and(eq(workflows.id, data.workflowId), eq(workflows.tenantId, ctx.tenant.id)),
        )
        .limit(1);

      if (!workflow) return { kind: "not_found" as const };
      if (workflow.archivedAt) {
        return {
          kind: "refused" as const,
          message: "This workflow is archived. Restore it before editing.",
        };
      }

      if (data.versionId) {
        const [existing] = await tx
          .select({
            id: workflowVersions.id,
            version: workflowVersions.version,
            status: workflowVersions.status,
          })
          .from(workflowVersions)
          .where(
            and(
              eq(workflowVersions.id, data.versionId),
              eq(workflowVersions.tenantId, ctx.tenant.id),
            ),
          )
          .limit(1);

        if (!existing) return { kind: "not_found" as const };

        if (existing.status !== "draft") {
          return {
            kind: "refused" as const,
            message:
              `Version ${existing.version} is ${existing.status} and cannot be ` +
              `edited — runs may be part-way through it right now. Create a new ` +
              `draft instead.`,
          };
        }

        await tx
          .update(workflowVersions)
          .set({
            triggerType: data.triggerType,
            triggerConfig: data.triggerConfig,
            steps: data.program.steps as WorkflowStep[],
            stepBudget: data.stepBudget ?? DEFAULT_STEP_BUDGET,
            notes: data.notes ?? null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(workflowVersions.id, existing.id),
              eq(workflowVersions.tenantId, ctx.tenant.id),
            ),
          );

        return { kind: "ok" as const, versionId: existing.id, version: existing.version };
      }

      const [highest] = await tx
        .select({ value: sql<number>`COALESCE(MAX(${workflowVersions.version}), 0)` })
        .from(workflowVersions)
        .where(
          and(
            eq(workflowVersions.workflowId, workflow.id),
            eq(workflowVersions.tenantId, ctx.tenant.id),
          ),
        );

      const nextVersion = Number(highest?.value ?? 0) + 1;

      const [created] = await tx
        .insert(workflowVersions)
        .values({
          tenantId: ctx.tenant.id,
          workflowId: workflow.id,
          version: nextVersion,
          status: "draft",
          triggerType: data.triggerType,
          triggerConfig: data.triggerConfig,
          steps: data.program.steps as WorkflowStep[],
          stepBudget: data.stepBudget ?? DEFAULT_STEP_BUDGET,
          notes: data.notes ?? null,
          createdBy: ctx.user.id,
        })
        .returning({ id: workflowVersions.id });

      if (!created) throw new Error("Draft insert returned no row.");
      return { kind: "ok" as const, versionId: created.id, version: nextVersion };
    });

    if (outcome.kind === "not_found") {
      return workflowFail("That workflow does not exist, or you cannot see it.");
    }
    if (outcome.kind === "refused") return workflowFail(outcome.message);

    return {
      ok: true,
      data: {
        versionId: outcome.versionId,
        version: outcome.version,
        validation: summariseValidation(validation),
      },
    };
  } catch (err) {
    return toWorkflowActionError(err, "saveDraft");
  }
}

/* ------------------------------------------------------------------ */
/* ⭐ PUBLISH                                                          */
/* ------------------------------------------------------------------ */

export async function publishVersion(input: unknown): Promise<
  ActionResult<{ versionId: string; version: number; archivedVersion: number | null }>
> {
  try {
    const ctx = await guardWorkflowWrite({
      operation: "workflows:publish",
      feature: "workflows.builder",
      permission: "workflows:publish",
    });

    const data = publishVersionSchema.parse(input);

    const loaded = await withTenant(ctx.tenant.id, async (tx) => {
      const [version] = await tx
        .select()
        .from(workflowVersions)
        .where(
          and(
            eq(workflowVersions.id, data.versionId),
            eq(workflowVersions.tenantId, ctx.tenant.id),
          ),
        )
        .limit(1);
      if (!version) return null;

      const [workflow] = await tx
        .select()
        .from(workflows)
        .where(
          and(
            eq(workflows.id, version.workflowId),
            eq(workflows.tenantId, ctx.tenant.id),
          ),
        )
        .limit(1);

      return workflow ? { version, workflow } : null;
    });

    if (!loaded) return workflowFail("That version does not exist, or you cannot see it.");
    const { version, workflow } = loaded;

    if (version.status !== "draft") {
      return workflowFail(
        `Version ${version.version} is already ${version.status}. Only a draft can ` +
          `be published.`,
      );
    }

    const program: WorkflowProgram = { steps: version.steps ?? [] };
    const validation = validateDefinition({
      triggerType: version.triggerType,
      triggerConfig: version.triggerConfig ?? {},
      program,
      stepBudget: version.stepBudget,
    });

    if (!validation.ok) {
      return workflowFail(
        `${summariseValidation(validation)} ${validation.errors
          .map((e) => `${e.where}: ${e.message}`)
          .join(" ")}`,
      );
    }

    if (validation.warnings.length > 0 && !data.acceptWarnings) {
      return workflowFail(
        `${summariseValidation(validation)} ${validation.warnings
          .map((w) => `${w.where}: ${w.message} ${w.remedy}`)
          .join(" ")}`,
      );
    }

    /* --- The entitlements this definition needs ------------------- */
    //
    // Checked at publish rather than at run time, because an entitlement
    // failure mid-run leaves half a workflow's effects committed. The
    // trigger's own feature is included: a scheduled workflow on a plan
    // without scheduling would simply never fire, silently.
    const actions = collectSteps(program).map((s) => s.action) as WorkflowActionType[];
    for (const feature of featuresFor(version.triggerType, actions)) {
      await requireFeature(feature, ctx);
    }

    /* --- ⭐ The permissions the PUBLISHER must personally hold ------ */
    const required = requiredPermissionsFor(program, actions);
    const lacking = required.filter(
      (permission) =>
        !evaluatePermission(
          { role: ctx.role, overrides: ctx.user.permissionOverrides },
          permission,
        ).allowed,
    );

    if (lacking.length > 0) {
      return workflowFail(
        `You cannot publish this workflow because it does things you are not ` +
          `permitted to do yourself: ${lacking.join(", ")}. An automation acts ` +
          `with the permissions of the person who published it — it can never do ` +
          `more than you can. Ask somebody who holds these to publish it, or ` +
          `remove those steps.`,
      );
    }

    const now = new Date();
    const nextRunAt =
      version.triggerType === "scheduled" && version.triggerConfig?.cron
        ? nextCronFireAt(
            version.triggerConfig.cron,
            now,
            version.triggerConfig.timezone ?? "UTC",
          )
        : null;

    const outcome = await withTenant(ctx.tenant.id, async (tx) => {
      // ⚠️ ARCHIVE FIRST, THEN ACTIVATE. `workflow_versions_one_active` is
      // a unique index, so the other order fails — and it fails with a
      // duplicate-key error rather than anything explicable.
      const [previous] = await tx
        .select({ id: workflowVersions.id, version: workflowVersions.version })
        .from(workflowVersions)
        .where(
          and(
            eq(workflowVersions.workflowId, version.workflowId),
            eq(workflowVersions.tenantId, ctx.tenant.id),
            eq(workflowVersions.status, "active"),
          ),
        )
        .limit(1);

      if (previous) {
        await tx
          .update(workflowVersions)
          .set({ status: "archived", updatedAt: now })
          .where(
            and(
              eq(workflowVersions.id, previous.id),
              eq(workflowVersions.tenantId, ctx.tenant.id),
            ),
          );
      }

      await tx
        .update(workflowVersions)
        .set({
          status: "active",
          publishedAt: now,
          publishedBy: ctx.user.id,
          // ⭐ The identity unattended runs will borrow. See the header.
          runAsUserId: ctx.user.id,
          updatedAt: now,
        })
        .where(
          and(
            eq(workflowVersions.id, version.id),
            eq(workflowVersions.tenantId, ctx.tenant.id),
          ),
        );

      await tx
        .update(workflows)
        .set({ nextRunAt: nextRunAt ?? null, updatedAt: now })
        .where(and(eq(workflows.id, workflow.id), eq(workflows.tenantId, ctx.tenant.id)));

      return { archivedVersion: previous?.version ?? null };
    });

    await writeAudit(ctx, {
      action: "config_change",
      resourceType: "workflow_version",
      resourceId: version.id,
      oldValue: { status: "draft" },
      newValue: {
        status: "active",
        version: version.version,
        trigger: version.triggerType,
        runsAs: ctx.user.email,
      },
      metadata: {
        archivedVersion: outcome.archivedVersion,
        warnings: validation.warnings.map((w) => w.code),
        nextRunAt: nextRunAt?.toISOString() ?? null,
      },
      // ⚠️ `warning`, always. Publishing lends this person's authority to
      // an unattended process, and that is the entry a reviewer needs to
      // find six months later.
      severity: "warning",
    });

    return {
      ok: true,
      data: {
        versionId: version.id,
        version: version.version,
        archivedVersion: outcome.archivedVersion,
      },
    };
  } catch (err) {
    return toWorkflowActionError(err, "publishVersion");
  }
}

/* ------------------------------------------------------------------ */
/* ENABLE / DISABLE                                                   */
/* ------------------------------------------------------------------ */

/**
 * The kill switch.
 *
 * ⚠️ DISABLING NEEDS `workflows:cancel_run`, NOT `workflows:publish`.
 * The person who has to stop a misbehaving automation at 6pm is rarely
 * the person who published it, and making them find that person first is
 * how a small incident becomes a long one. Turning something OFF is
 * always the safer direction, so it is deliberately the wider permission.
 */
export async function setWorkflowEnabled(input: unknown): Promise<
  ActionResult<{ id: string; isEnabled: boolean }>
> {
  try {
    const data = setEnabledSchema.parse(input);

    // ⚠️ Note the asymmetry: switching ON is a write to the workspace's
    // automation surface and goes through the full gate; switching OFF
    // only needs the permission, so a lapsed subscription cannot stop
    // somebody stopping a runaway.
    const ctx = data.isEnabled
      ? await guardWorkflowWrite({
          operation: "workflows:update",
          feature: "workflows.builder",
          permission: "workflows:publish",
        })
      : await requirePermission("workflows:cancel_run");

    const outcome = await withTenant(ctx.tenant.id, async (tx) => {
      const result = await tx
        .update(workflows)
        .set({ isEnabled: data.isEnabled, updatedAt: new Date() })
        .where(
          and(eq(workflows.id, data.workflowId), eq(workflows.tenantId, ctx.tenant.id)),
        )
        .returning({ id: workflows.id, archivedAt: workflows.archivedAt });
      return result[0] ?? null;
    });

    if (!outcome) return workflowFail("That workflow does not exist, or you cannot see it.");

    await writeAudit(ctx, {
      action: "config_change",
      resourceType: "workflow",
      resourceId: data.workflowId,
      newValue: { isEnabled: data.isEnabled },
      severity: "warning",
    });

    return { ok: true, data: { id: data.workflowId, isEnabled: data.isEnabled } };
  } catch (err) {
    return toWorkflowActionError(err, "setWorkflowEnabled");
  }
}

/* ------------------------------------------------------------------ */
/* ⭐ ARCHIVE — AND THE RUNS IN FLIGHT                                 */
/* ------------------------------------------------------------------ */

/**
 * Retire a workflow.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THERE IS NO `deleteWorkflow`, AND THE REASON IS THE RUNS
 * ══════════════════════════════════════════════════════════════════════
 * A run can be suspended for thirty days on a delay, or indefinitely on
 * an approval. Deleting the workflow underneath it has three possible
 * meanings and two of them are wrong:
 *
 *   • Cascade — the run history goes too, including what the automation
 *     already did to customer data. That is the one thing nobody may
 *     lose, and it is exactly what somebody covering up a bad automation
 *     would choose.
 *   • Refuse while runs exist — the operator cannot get rid of a workflow
 *     that is misbehaving, at the moment they most want to, BECAUSE it is
 *     misbehaving.
 *   • Archive — stop it starting anything new, decide explicitly about
 *     what has already started, keep the history.
 *
 * ⚠️ `inFlight` HAS NO DEFAULT. "Let them finish" and "cancel them" are
 * both defensible and they are not the same thing — a half-finished
 * approval chain that is silently cancelled is a decision somebody has to
 * be told about, and a default would make it for them.
 */
export async function archiveWorkflow(input: unknown): Promise<
  ActionResult<{ id: string; cancelledRuns: number; runsLeftRunning: number }>
> {
  try {
    const ctx = await guardWorkflowWrite({
      operation: "workflows:archive",
      feature: "workflows.builder",
      permission: "workflows:archive",
    });

    const data = archiveWorkflowSchema.parse(input);
    const now = new Date();

    const outcome = await withTenant(ctx.tenant.id, async (tx) => {
      const [workflow] = await tx
        .select({ id: workflows.id, name: workflows.name })
        .from(workflows)
        .where(
          and(eq(workflows.id, data.workflowId), eq(workflows.tenantId, ctx.tenant.id)),
        )
        .limit(1);

      if (!workflow) return { kind: "not_found" as const };

      // The trigger `workflows_archive_guard` also clears `is_enabled` and
      // `next_run_at`. Setting them here as well means the row is right
      // even if somebody later disables the trigger to run a migration.
      await tx
        .update(workflows)
        .set({
          archivedAt: now,
          archivedBy: ctx.user.id,
          isEnabled: false,
          nextRunAt: null,
          updatedAt: now,
        })
        .where(
          and(eq(workflows.id, workflow.id), eq(workflows.tenantId, ctx.tenant.id)),
        );

      const live = await tx
        .select({ id: workflowRuns.id, status: workflowRuns.status })
        .from(workflowRuns)
        .where(
          and(
            eq(workflowRuns.workflowId, workflow.id),
            eq(workflowRuns.tenantId, ctx.tenant.id),
            sql`${workflowRuns.status} IN ('queued','running','waiting_delay','waiting_form')`,
          ),
        );

      if (data.inFlight === "cancel" && live.length > 0) {
        await tx
          .update(workflowRuns)
          .set({
            status: "cancelled",
            finishedAt: now,
            stopReason: `The workflow was archived: ${data.reason}`,
            updatedAt: now,
          })
          .where(
            and(
              eq(workflowRuns.workflowId, workflow.id),
              eq(workflowRuns.tenantId, ctx.tenant.id),
              sql`${workflowRuns.status} IN ('queued','running','waiting_delay','waiting_form')`,
            ),
          );
      }

      return {
        kind: "ok" as const,
        name: workflow.name,
        cancelled: data.inFlight === "cancel" ? live.length : 0,
        stillRunning: data.inFlight === "cancel" ? 0 : live.length,
      };
    });

    if (outcome.kind === "not_found") {
      return workflowFail("That workflow does not exist, or you cannot see it.");
    }

    await writeAudit(ctx, {
      action: "delete",
      resourceType: "workflow",
      resourceId: data.workflowId,
      oldValue: { name: outcome.name },
      newValue: { archived: true, inFlight: data.inFlight },
      reason: data.reason,
      metadata: { cancelledRuns: outcome.cancelled, leftRunning: outcome.stillRunning },
      severity: "warning",
    });

    return {
      ok: true,
      data: {
        id: data.workflowId,
        cancelledRuns: outcome.cancelled,
        runsLeftRunning: outcome.stillRunning,
      },
    };
  } catch (err) {
    return toWorkflowActionError(err, "archiveWorkflow");
  }
}

/* ------------------------------------------------------------------ */
/* WHAT A DEFINITION NEEDS                                             */
/* ------------------------------------------------------------------ */

/**
 * Every permission a definition will need at run time.
 *
 * Two sources, and both matter: the ACTION (sending an email at all) and
 * the RECORD TYPE it operates on (`leads:delete`). Checking only the
 * first would let somebody with no delete rights publish a workflow that
 * deletes leads; checking only the second would let them publish one that
 * emails every buyer in the workspace.
 */
export function requiredPermissionsFor(
  program: WorkflowProgram,
  actions: readonly WorkflowActionType[],
): string[] {
  const required = new Set<string>(permissionsRequiredBy(actions));

  for (const step of collectSteps(program)) {
    switch (step.action) {
      case "create_record":
        addIf(required, permissionForRecordAction(step.recordType, "create"));
        break;
      case "update_record":
        addIf(required, permissionForRecordAction(step.recordType, "update"));
        break;
      case "delete_record":
        addIf(required, permissionForRecordAction(step.recordType, "delete"));
        break;
      case "find_records":
        addIf(required, permissionForRecordAction(step.recordType, "read"));
        break;
      default:
        break;
    }
  }

  return [...required].sort();
}

function addIf(set: Set<string>, permission: string | null): void {
  if (permission) set.add(permission);
}

/** The entitlements a trigger and a set of actions imply. */
export function featuresFor(
  triggerType: WorkflowTriggerType,
  actions: readonly WorkflowActionType[],
): FeatureKey[] {
  const features = new Set<FeatureKey>(["workflows.builder"]);
  if (triggerType === "scheduled") features.add("workflows.scheduled");
  if (triggerType === "webhook") features.add("workflows.webhooks");
  if (actions.includes("http_request")) features.add("workflows.http_request");
  if (actions.includes("send_email")) features.add("email.transactional");
  return [...features];
}
