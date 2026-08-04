/**
 * Ordence — Workflow & Automation Engine
 * Version: v0.23.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT IS DIFFERENT ABOUT THIS PHASE
 * ══════════════════════════════════════════════════════════════════════
 * Twenty-two phases of this product have stored what customers DID. This
 * one stores what customers WROTE — a program, authored inside the
 * workspace, that runs on our servers against their data. Three problems
 * come with that, and none of them existed before:
 *
 *   1. A DEFINITION IS UNTRUSTED INPUT WITH A LONG LIFE. A booking is
 *      validated once and stored. A workflow is validated once and then
 *      executed a thousand times, months later, against records nobody
 *      had thought of. Everything a step names — a table, a column, a URL
 *      — is checked against a frozen catalogue in `lib/workflows/`, every
 *      time it runs, not once when it was saved.
 *
 *   2. IT CAN TRIGGER ITSELF. A workflow that updates a record fires the
 *      trigger that starts a workflow. Three columns on `workflow_runs`
 *      exist for this and nothing else: `depth`, `origin_chain` and
 *      `parent_run_id`. They are computed by a database trigger from the
 *      PARENT row rather than supplied by the caller, because a loop
 *      guard that trusts the value it is guarding is decoration.
 *
 *   3. IT RUNS AS SOMEBODY. Not as the engine, not as an admin — as the
 *      person who triggered it, or for unattended triggers as the person
 *      who published it. `workflow_runs.actor_user_id` is NOT NULL for
 *      that reason: there is no such thing as a run with no responsible
 *      human, and a nullable column would eventually hold one.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE VOCABULARY LIVES IN `lib/workflows/program.ts`, NOT HERE
 * ══════════════════════════════════════════════════════════════════════
 * The enums below are BUILT FROM the arrays in that file rather than
 * repeated. It is the opposite direction from `sales.ts` (where the
 * database owns the vocabulary and `lib/` imports the type), and the
 * reason is that the planner, the validator and the builder all reason
 * about the action list — while the column merely stores it. Two hand-
 * maintained copies would eventually disagree, and the failure mode is a
 * value the database accepts and the planner has never heard of: a run
 * that starts and can never finish.
 */

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  varchar,
  timestamp,
  jsonb,
  boolean,
  integer,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { tenants, users } from "./core";
import {
  ACTION_TYPES,
  TRIGGER_TYPES,
  type WorkflowActionType,
  type WorkflowTriggerType,
} from "@/lib/workflows/program";
import type { TriggerConfig, WorkflowStep } from "@/lib/workflows/program";
import type { Cursor } from "@/lib/workflows/planner";
import { ABSOLUTE_MAX_TRIGGER_DEPTH, MAX_STEPS_PER_RUN } from "@/lib/workflows/limits";

/* ------------------------------------------------------------------ */
/* ENUMS                                                               */
/* ------------------------------------------------------------------ */

export const workflowTriggerTypeEnum = pgEnum(
  "workflow_trigger_type",
  TRIGGER_TYPES as unknown as [WorkflowTriggerType, ...WorkflowTriggerType[]],
);

export const workflowActionTypeEnum = pgEnum(
  "workflow_action_type",
  ACTION_TYPES as unknown as [WorkflowActionType, ...WorkflowActionType[]],
);

/**
 * ⭐ THE LIFECYCLE THAT MAKES A RUNNING WORKFLOW SAFE TO REASON ABOUT.
 *
 *   draft    — editable, cannot run.
 *   active   — running, and IMMUTABLE. Exactly one per workflow.
 *   archived — was active, kept because runs reference it.
 *
 * ⚠️ WHY `active` IS IMMUTABLE, WHICH IS THE WHOLE POINT OF VERSIONING:
 *
 * A run is not instantaneous. It can be suspended for thirty days by a
 * `delay` or indefinitely by an approval step, and while it waits it
 * holds a CURSOR — a position inside the step list. Edit the definition
 * underneath it and that position now means something else. Step 3 was an
 * email and is now a delete. The run resumes and deletes a record on the
 * strength of an approval somebody gave for an email.
 *
 * So an edit to an active version creates a NEW DRAFT. Publishing that
 * draft archives the old version, which keeps existing for as long as
 * there are runs that were started against it. Nothing in flight ever
 * sees its own definition change.
 */
export const workflowVersionStatusEnum = pgEnum("workflow_version_status", [
  "draft",
  "active",
  "archived",
]);

/**
 * ⚠️ `stopped` IS NOT `succeeded`, AND THE DISTINCTION IS OPERATIONAL.
 *
 * A filter that says "not a hot lead" ends a run correctly, having done
 * nothing. Recording that as success makes "did this workflow do
 * anything?" unanswerable without reading every step of every run;
 * recording it as failure pages somebody at 3am because a lead was warm.
 */
export const workflowRunStatusEnum = pgEnum("workflow_run_status", [
  "queued",
  "running",
  "waiting_delay",
  "waiting_form",
  "succeeded",
  "stopped",
  "failed",
  "cancelled",
]);

export const workflowStepStatusEnum = pgEnum("workflow_step_status", [
  "running",
  "succeeded",
  "failed",
  "skipped",
]);

export const workflowTaskStatusEnum = pgEnum("workflow_task_status", [
  "pending",
  "approved",
  "rejected",
  "expired",
  "cancelled",
]);

/* ------------------------------------------------------------------ */
/* WORKFLOWS                                                           */
/* ------------------------------------------------------------------ */

/**
 * The stable identity. Everything that changes lives on a version.
 *
 * ⚠️ THERE IS NO `active_version_id` COLUMN, DELIBERATELY.
 *
 * The obvious design is a pointer from here to the live version. It gives
 * two sources of truth for "which version runs" — the pointer, and the
 * version whose status is `active` — and they drift the first time a
 * publish half-fails. A workflow that runs a version it does not consider
 * active is a bug nobody can see from either table alone.
 *
 * Instead the partial unique index `workflow_versions_one_active`
 * guarantees at most one active version per workflow, and the live
 * version is found by asking for it. One fact, one place.
 */
export const workflows = pgTable(
  "workflows",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** Stable slug, referenced by support and by the API. Unique per tenant. */
    key: varchar("key", { length: 80 }).notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    description: text("description"),

    /**
     * ⭐ THE KILL SWITCH.
     *
     * Separate from the version lifecycle on purpose. When an automation
     * is misbehaving at 6pm, the operator needs one action that stops it
     * NOW, without archiving a version, without editing a definition, and
     * without deciding anything they will have to justify tomorrow. The
     * dispatcher reads this before it reads anything else.
     */
    isEnabled: boolean("is_enabled").default(true).notNull(),

    /**
     * ⚠️ THE HASH, NEVER THE TOKEN.
     *
     * A webhook trigger needs a shared secret. Stored raw it is readable
     * by anyone with `workflows:read`, present in every database backup,
     * and visible in a support session — and it authenticates a caller
     * who can start runs inside the workspace. Hashed, a leak of this
     * table is not a leak of the credential. The token is shown exactly
     * once, when it is generated.
     */
    webhookSecretHash: varchar("webhook_secret_hash", { length: 64 }),

    /* --- Scheduling state ------------------------------------------ */
    //
    // Derived from the active version's cron, but stored HERE because it
    // is runtime state rather than definition. Putting it on the version
    // would make an immutable row mutable, which is the one thing the
    // version lifecycle promises it is not.
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),

    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),

    /**
     * ⚠️ ARCHIVED, NOT DELETED — AND THE REASON IS RUNS IN FLIGHT.
     *
     * Deleting a workflow while a run is suspended on an approval step
     * leaves that run pointing at nothing. Cascade the delete and the
     * history goes with it, including the record of what the automation
     * did to somebody's data last month. Refuse the delete while runs
     * exist and the operator cannot get rid of a workflow that is
     * misbehaving, which is when they most want to.
     *
     * Archiving does what people actually mean: stop it starting anything
     * new, leave what has already started to finish or be cancelled
     * explicitly, keep the history. `SQL-FILES/0018` grants no DELETE on
     * this table at all, so the option does not exist to be taken.
     */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    archivedBy: uuid("archived_by"),
  },
  (t) => ({
    keyPerTenant: uniqueIndex("workflows_key_tenant_unique")
      .on(t.tenantId, t.key)
      .where(sql`${t.archivedAt} IS NULL`),
    tenantIdx: index("workflows_tenant_idx").on(t.tenantId),
    enabledIdx: index("workflows_tenant_enabled_idx").on(t.tenantId, t.isEnabled),
    /** Drives the scheduled dispatcher. Partial, so it stays small. */
    dueIdx: index("workflows_due_idx")
      .on(t.nextRunAt)
      .where(sql`${t.isEnabled} AND ${t.archivedAt} IS NULL AND ${t.nextRunAt} IS NOT NULL`),
  }),
);

/* ------------------------------------------------------------------ */
/* VERSIONS                                                            */
/* ------------------------------------------------------------------ */

export const workflowVersions = pgTable(
  "workflow_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),

    version: integer("version").notNull(),
    status: workflowVersionStatusEnum("status").default("draft").notNull(),

    triggerType: workflowTriggerTypeEnum("trigger_type").notNull(),
    triggerConfig: jsonb("trigger_config")
      .$type<TriggerConfig>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

    /** The program. Shape and meaning live in `lib/workflows/program.ts`. */
    steps: jsonb("steps")
      .$type<WorkflowStep[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),

    /**
     * How many steps one run of this version may execute.
     *
     * A per-version tightening of the global cap, never a loosening — the
     * check constraint pins it to `MAX_STEPS_PER_RUN`. A workflow author
     * who knows their loop should never exceed twenty gets a much earlier
     * and much more readable failure than the engine-wide limit.
     */
    stepBudget: integer("step_budget").default(100).notNull(),

    /**
     * ⭐ WHOSE AUTHORITY AN UNATTENDED RUN BORROWS.
     *
     * A scheduled or webhook run has no live person, and the wrong answer
     * — a service identity with broad rights — turns "create a workflow"
     * into "grant yourself permissions". So the run acts as the user who
     * PUBLISHED this version, with exactly their permissions at run time.
     *
     * That places the decision at publish, which is where it belongs:
     * publishing is a separate permission, it is audited, and the person
     * doing it is delegating their own authority rather than borrowing
     * somebody else's.
     *
     * ⚠️ Their permissions are re-read on every run, never snapshotted.
     * A person who leaves the company and is suspended must stop being
     * able to act, including through automations they left behind.
     */
    runAsUserId: uuid("run_as_user_id"),

    notes: text("notes"),

    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedBy: uuid("published_by"),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    versionPerWorkflow: uniqueIndex("workflow_versions_number_unique").on(
      t.workflowId,
      t.version,
    ),
    /**
     * ⭐ AT MOST ONE ACTIVE VERSION PER WORKFLOW.
     *
     * The constraint the whole versioning story rests on. Two active
     * versions means a triggering event starts two runs of "the same"
     * workflow, doing different things, and no page in the product would
     * show anything wrong.
     */
    oneActive: uniqueIndex("workflow_versions_one_active")
      .on(t.workflowId)
      .where(sql`${t.status} = 'active'`),
    tenantIdx: index("workflow_versions_tenant_idx").on(t.tenantId),
    /** The dispatcher's lookup: active versions listening for an event. */
    dispatchIdx: index("workflow_versions_dispatch_idx")
      .on(t.tenantId, t.triggerType)
      .where(sql`${t.status} = 'active'`),

    versionPositive: check("workflow_versions_number_positive", sql`${t.version} > 0`),
    budgetSane: check(
      "workflow_versions_budget_sane",
      sql`${t.stepBudget} >= 1 AND ${t.stepBudget} <= ${sql.raw(String(MAX_STEPS_PER_RUN))}`,
    ),
    /**
     * ⚠️ AN ACTIVE VERSION MUST NAME THE IDENTITY IT RUNS AS.
     *
     * Without this, a version published by a path that forgot to set
     * `run_as_user_id` runs unattended with no actor — and the executor
     * would have to decide what to do with a null. Every answer to that
     * is worse than refusing the row.
     */
    activeIsPublished: check(
      "workflow_versions_active_is_published",
      sql`${t.status} <> 'active'
          OR (${t.publishedAt} IS NOT NULL AND ${t.runAsUserId} IS NOT NULL)`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* RUNS                                                                */
/* ------------------------------------------------------------------ */

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    workflowId: uuid("workflow_id").notNull(),
    /**
     * ⚠️ The version, not just the workflow. A run must be readable
     * against the definition it actually executed — six months later,
     * after four republishes. This is why archived versions are kept.
     */
    versionId: uuid("version_id").notNull(),

    status: workflowRunStatusEnum("status").default("queued").notNull(),
    triggerType: workflowTriggerTypeEnum("trigger_type").notNull(),

    /** What set it off. Free-form because it may be a webhook or a schedule. */
    recordType: varchar("record_type", { length: 60 }),
    recordId: uuid("record_id"),

    /** Trigger payload plus each completed step's output. */
    context: jsonb("context")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

    /** Where the planner is. See `lib/workflows/planner.ts`. */
    cursor: jsonb("cursor")
      .$type<Cursor>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

    /* --- ⭐ WHO THIS RUN IS ----------------------------------------- */
    //
    // NOT NULL, both of them. Every step is authorised against this
    // person's permissions, so a run without one would have to either
    // fail everything or check nothing. See `lib/workflows/actions.ts`.
    actorUserId: uuid("actor_user_id").notNull(),
    /** Snapshot for the history — the check itself re-reads the live role. */
    actorRole: varchar("actor_role", { length: 60 }).notNull(),

    /* --- ⭐ LOOP CONTROL -------------------------------------------- */
    //
    // ⚠️ EVERY COLUMN IN THIS BLOCK IS COMPUTED BY THE DATABASE TRIGGER
    // `workflow_runs_guard_chain`, NOT BY THE CALLER.
    //
    // The caller supplies `parent_run_id` and nothing else. Depth and the
    // chain are derived from the parent row inside the trigger, because
    // an engine that accepted `depth: 0` from its caller has a loop guard
    // that any caller can switch off — including a caller that is a bug
    // rather than an attacker.
    parentRunId: uuid("parent_run_id"),
    rootRunId: uuid("root_run_id"),
    depth: integer("depth").default(0).notNull(),
    /** Version ids already in this causal chain. Cycle detection reads it. */
    originChain: uuid("origin_chain")
      .array()
      .default(sql`ARRAY[]::uuid[]`)
      .notNull(),

    /* --- Budgets consumed ------------------------------------------ */
    stepsExecuted: integer("steps_executed").default(0).notNull(),
    iterationsUsed: integer("iterations_used").default(0).notNull(),

    /** Set while suspended by a `delay`. The resume sweeper reads it. */
    resumeAt: timestamp("resume_at", { withTimezone: true }),

    error: text("error"),
    errorStepKey: varchar("error_step_key", { length: 80 }),
    /** Why a `stopped` run stopped — which filter, or whose rejection. */
    stopReason: text("stop_reason"),

    queuedAt: timestamp("queued_at", { withTimezone: true }).defaultNow().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    tenantIdx: index("workflow_runs_tenant_idx").on(t.tenantId, t.queuedAt),
    workflowIdx: index("workflow_runs_workflow_idx").on(t.workflowId, t.queuedAt),
    statusIdx: index("workflow_runs_status_idx").on(t.tenantId, t.status),
    /** The two sweepers: resume-after-delay, and reap-the-stuck. */
    resumeIdx: index("workflow_runs_resume_idx")
      .on(t.resumeAt)
      .where(sql`${t.status} = 'waiting_delay'`),
    parentIdx: index("workflow_runs_parent_idx").on(t.parentRunId),

    depthSane: check(
      "workflow_runs_depth_sane",
      sql`${t.depth} >= 0 AND ${t.depth} <= ${sql.raw(String(ABSOLUTE_MAX_TRIGGER_DEPTH))}`,
    ),
    /**
     * ⚠️ THE LAST LINE OF DEFENCE AGAINST A RUNAWAY RUN.
     *
     * The planner refuses at the version's budget and the engine's cap
     * long before this. If this constraint ever fires, both of those have
     * been bypassed — so it raises a constraint violation rather than
     * clamping, because a silent clamp would hide the fact that the real
     * guards are not working.
     */
    stepsSane: check(
      "workflow_runs_steps_sane",
      sql`${t.stepsExecuted} >= 0 AND ${t.stepsExecuted} <= ${sql.raw(String(MAX_STEPS_PER_RUN))}`,
    ),
    chainBounded: check(
      "workflow_runs_chain_bounded",
      sql`array_length(${t.originChain}, 1) IS NULL
          OR array_length(${t.originChain}, 1) <= ${sql.raw(String(ABSOLUTE_MAX_TRIGGER_DEPTH))}`,
    ),
    /** A finished run says why it finished. */
    failureHasReason: check(
      "workflow_runs_failure_has_reason",
      sql`${t.status} <> 'failed' OR ${t.error} IS NOT NULL`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* RUN STEPS                                                           */
/* ------------------------------------------------------------------ */

/**
 * One row per STEP EXECUTION — not per step in the definition.
 *
 * ⚠️ A loop of four steps over fifty items is two hundred rows, and that
 * is the point. "Which iteration failed, and what was the item?" is the
 * first question anybody asks about a failed run, and an engine that
 * stores one row per definition step cannot answer it.
 */
export const workflowRunSteps = pgTable(
  "workflow_run_steps",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull(),

    stepKey: varchar("step_key", { length: 80 }).notNull(),
    /** Position in the definition, e.g. `2.then.0`. Survives a rename. */
    stepPath: varchar("step_path", { length: 200 }).notNull(),
    actionType: workflowActionTypeEnum("action_type").notNull(),
    status: workflowStepStatusEnum("status").default("running").notNull(),

    /** Which pass through the enclosing loop, if any. */
    iteration: integer("iteration"),
    sequence: integer("sequence").notNull(),

    /**
     * ⚠️ RESOLVED INPUT, NOT THE TEMPLATE.
     *
     * Recording `{{ trigger.record.email }}` tells you nothing about why
     * the email went to the wrong person. Recording the address it
     * actually resolved to tells you everything — and it is the reason
     * this table is worth its storage.
     */
    input: jsonb("input").$type<Record<string, unknown>>(),
    output: jsonb("output").$type<Record<string, unknown>>(),
    error: text("error"),

    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => ({
    runIdx: index("workflow_run_steps_run_idx").on(t.runId, t.sequence),
    tenantIdx: index("workflow_run_steps_tenant_idx").on(t.tenantId),
    failedIdx: index("workflow_run_steps_failed_idx")
      .on(t.tenantId, t.startedAt)
      .where(sql`${t.status} = 'failed'`),
  }),
);

/* ------------------------------------------------------------------ */
/* HUMAN APPROVAL TASKS                                                */
/* ------------------------------------------------------------------ */

/**
 * A `form` step suspends a run until a person answers.
 *
 * ⚠️ THE DEADLINE IS NOT OPTIONAL, AND `expires_at` IS WHY.
 *
 * A run waiting on a person who has left the company waits forever. It
 * holds a cursor, it appears in every "in progress" count, and it blocks
 * the workflow it belongs to from ever being archived cleanly. An expiry
 * turns that into an outcome somebody can see and act on.
 */
export const workflowTasks = pgTable(
  "workflow_tasks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull(),

    stepKey: varchar("step_key", { length: 80 }).notNull(),
    title: varchar("title", { length: 200 }).notNull(),
    instructions: text("instructions"),

    /** Null means "anyone who may approve", which the validator warns about. */
    assignedToUserId: uuid("assigned_to_user_id"),

    status: workflowTaskStatusEnum("status").default("pending").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),

    response: jsonb("response").$type<Record<string, unknown>>(),
    respondedBy: uuid("responded_by"),
    respondedAt: timestamp("responded_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    /**
     * One live request per step per run. A retry that created a second
     * one would ask two people the same question and accept whichever
     * answered first.
     */
    onePendingPerStep: uniqueIndex("workflow_tasks_one_pending")
      .on(t.runId, t.stepKey)
      .where(sql`${t.status} = 'pending'`),
    tenantIdx: index("workflow_tasks_tenant_idx").on(t.tenantId, t.status),
    assigneeIdx: index("workflow_tasks_assignee_idx").on(t.tenantId, t.assignedToUserId),
    expiryIdx: index("workflow_tasks_expiry_idx")
      .on(t.expiresAt)
      .where(sql`${t.status} = 'pending'`),

    /** An answered task records who answered and when. */
    responseIsAttributed: check(
      "workflow_tasks_response_attributed",
      sql`${t.status} NOT IN ('approved','rejected')
          OR (${t.respondedBy} IS NOT NULL AND ${t.respondedAt} IS NOT NULL)`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* RELATIONS                                                           */
/* ------------------------------------------------------------------ */

export const workflowsRelations = relations(workflows, ({ one, many }) => ({
  tenant: one(tenants, { fields: [workflows.tenantId], references: [tenants.id] }),
  versions: many(workflowVersions),
  runs: many(workflowRuns),
}));

export const workflowVersionsRelations = relations(workflowVersions, ({ one, many }) => ({
  workflow: one(workflows, {
    fields: [workflowVersions.workflowId],
    references: [workflows.id],
  }),
  runAs: one(users, {
    fields: [workflowVersions.runAsUserId],
    references: [users.id],
  }),
  runs: many(workflowRuns),
}));

export const workflowRunsRelations = relations(workflowRuns, ({ one, many }) => ({
  tenant: one(tenants, { fields: [workflowRuns.tenantId], references: [tenants.id] }),
  workflow: one(workflows, {
    fields: [workflowRuns.workflowId],
    references: [workflows.id],
  }),
  version: one(workflowVersions, {
    fields: [workflowRuns.versionId],
    references: [workflowVersions.id],
  }),
  actor: one(users, { fields: [workflowRuns.actorUserId], references: [users.id] }),
  steps: many(workflowRunSteps),
  tasks: many(workflowTasks),
}));

export const workflowRunStepsRelations = relations(workflowRunSteps, ({ one }) => ({
  run: one(workflowRuns, {
    fields: [workflowRunSteps.runId],
    references: [workflowRuns.id],
  }),
}));

export const workflowTasksRelations = relations(workflowTasks, ({ one }) => ({
  run: one(workflowRuns, { fields: [workflowTasks.runId], references: [workflowRuns.id] }),
  assignee: one(users, {
    fields: [workflowTasks.assignedToUserId],
    references: [users.id],
  }),
}));

/* ------------------------------------------------------------------ */
/* INFERRED TYPES                                                      */
/* ------------------------------------------------------------------ */

export type Workflow = typeof workflows.$inferSelect;
export type NewWorkflow = typeof workflows.$inferInsert;
export type WorkflowVersion = typeof workflowVersions.$inferSelect;
export type NewWorkflowVersion = typeof workflowVersions.$inferInsert;
export type WorkflowRun = typeof workflowRuns.$inferSelect;
export type NewWorkflowRun = typeof workflowRuns.$inferInsert;
export type WorkflowRunStep = typeof workflowRunSteps.$inferSelect;
export type WorkflowTask = typeof workflowTasks.$inferSelect;

export type WorkflowVersionStatus = (typeof workflowVersionStatusEnum.enumValues)[number];
export type WorkflowRunStatus = (typeof workflowRunStatusEnum.enumValues)[number];
export type WorkflowStepStatus = (typeof workflowStepStatusEnum.enumValues)[number];
export type WorkflowTaskStatus = (typeof workflowTaskStatusEnum.enumValues)[number];
