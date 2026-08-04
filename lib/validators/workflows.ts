/**
 * Ordence — Workflow Validation Schemas
 * Version: v0.23.0-alpha
 *
 * WHY THIS FILE EXISTS: a `"use server"` module may only export async
 * functions, so schemas live outside the action boundary. Same reason as
 * `lib/validators/crm.ts`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ ZOD IS THE SHAPE CHECK. IT IS NOT THE SAFETY CHECK.
 * ══════════════════════════════════════════════════════════════════════
 * Worth stating loudly, because a file this size looks like it is doing
 * the work. What Zod establishes here is that a definition is
 * STRUCTURALLY a workflow: the keys are strings, the actions are known,
 * the branches are arrays.
 *
 * What it cannot establish is whether the definition is SAFE:
 *
 *   • that `recordType` is one a workflow may touch      → records.ts
 *   • that every column in `values` is writable          → records.ts
 *   • that the URL is not the cloud metadata service     → http-policy.ts
 *   • that the loop cannot run a million times           → limits.ts
 *   • that the whole thing is publishable                → validation.ts
 *
 * A parse that succeeds means the JSON is well-formed. `validateDefinition`
 * is what decides whether it may run, and `server/workflows/` calls both.
 * Treating a green parse as authorisation is how a schema library becomes
 * the reason an incident happened.
 */

import { z } from "zod";
import { uuidSchema } from "./crm";
import {
  ACTION_TYPES,
  CONDITION_OPERATORS,
  TRIGGER_TYPES,
} from "@/lib/workflows/program";
import {
  MAX_CONFIGURABLE_STEP_BUDGET,
  MAX_DELAY_SECONDS,
  MAX_FIND_RESULTS,
  MAX_FORM_DUE_HOURS,
  MAX_ITERATIONS_PER_LOOP,
  MAX_NESTING_DEPTH,
  MAX_STEPS_PER_DEFINITION,
  MIN_DELAY_SECONDS,
} from "@/lib/workflows/limits";
import type { WorkflowStep } from "@/lib/workflows/program";

/* ------------------------------------------------------------------ */
/* PRIMITIVES                                                          */
/* ------------------------------------------------------------------ */

export const workflowKeySchema = z
  .string()
  .trim()
  .min(1, "A key is required.")
  .max(80)
  .regex(
    /^[a-z][a-z0-9_-]*$/,
    "Use lowercase letters, digits, hyphens and underscores, starting with a letter.",
  );

export const stepKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, "Step keys are lowercase letters, digits and underscores.");

export const conditionSchema = z.object({
  path: z.string().trim().min(1).max(200),
  operator: z.enum(CONDITION_OPERATORS),
  value: z.unknown().optional(),
});

export const conditionGroupSchema = z.object({
  // No `.default()`. See the note on `match` in `program.ts` — guessing
  // between "all" and "any" inverts the author's intent silently.
  match: z.enum(["all", "any"]),
  conditions: z.array(conditionSchema).max(25),
});

/**
 * A value written into a record.
 *
 * ⚠️ NO OBJECTS AND NO ARRAYS. Every writable column in `records.ts` is a
 * scalar, and accepting nested JSON would let a step write a structure
 * into a column typed for a string — which Postgres will happily accept
 * for `jsonb` and reject at run time for everything else, halfway through
 * a run that has already done other things.
 */
const templateValueSchema = z.union([
  z.string().max(10_000),
  z.number(),
  z.boolean(),
  z.null(),
]);

const valuesSchema = z.record(templateValueSchema).refine(
  (values) => Object.keys(values).length <= 40,
  { message: "A step may not set more than 40 fields." },
);

/* ------------------------------------------------------------------ */
/* STEPS                                                               */
/* ------------------------------------------------------------------ */

const stepCommon = {
  key: stepKeySchema,
  label: z.string().trim().max(120).optional(),
};

const createRecordStepSchema = z.object({
  ...stepCommon,
  action: z.literal("create_record"),
  recordType: z.string().trim().min(1).max(60),
  values: valuesSchema,
});

const updateRecordStepSchema = z.object({
  ...stepCommon,
  action: z.literal("update_record"),
  recordType: z.string().trim().min(1).max(60),
  recordId: z.string().trim().min(1).max(200),
  values: valuesSchema,
});

const deleteRecordStepSchema = z.object({
  ...stepCommon,
  action: z.literal("delete_record"),
  recordType: z.string().trim().min(1).max(60),
  recordId: z.string().trim().min(1).max(200),
});

const findRecordsStepSchema = z.object({
  ...stepCommon,
  action: z.literal("find_records"),
  recordType: z.string().trim().min(1).max(60),
  where: conditionGroupSchema.optional(),
  limit: z.number().int().min(1).max(MAX_FIND_RESULTS).optional(),
});

const sendEmailStepSchema = z.object({
  ...stepCommon,
  action: z.literal("send_email"),
  // Not `.email()`. The value is usually a binding — `{{ trigger.record.email }}`
  // — and rejecting that at save time would make the action unusable for
  // its main purpose. The resolved address is validated at run time.
  to: z.string().trim().min(1).max(320),
  subject: z.string().trim().min(1).max(200),
  body: z.string().max(20_000),
});

const httpRequestStepSchema = z.object({
  ...stepCommon,
  action: z.literal("http_request"),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  url: z.string().trim().min(1).max(2048),
  headers: z.record(z.string().max(2048)).optional(),
  body: z.string().max(64_000).optional(),
});

const filterStepSchema = z.object({
  ...stepCommon,
  action: z.literal("filter"),
  conditions: conditionGroupSchema,
});

const delayStepSchema = z.object({
  ...stepCommon,
  action: z.literal("delay"),
  seconds: z.number().int().min(MIN_DELAY_SECONDS).max(MAX_DELAY_SECONDS),
});

const formStepSchema = z.object({
  ...stepCommon,
  action: z.literal("form"),
  title: z.string().trim().min(1).max(200),
  instructions: z.string().max(4_000).optional(),
  assignTo: z.string().trim().max(200).optional(),
  dueInHours: z.number().int().min(1).max(MAX_FORM_DUE_HOURS).optional(),
  onReject: z.enum(["stop", "fail"]).optional(),
});

/**
 * ⚠️ THE RECURSION IS DEPTH-LIMITED BY HAND, NOT BY `z.lazy` ALONE.
 *
 * `z.lazy` will happily follow a definition nested four hundred deep, and
 * the parse is where that becomes a stack overflow in a server action —
 * a crash on untrusted input, which is a denial of service rather than a
 * validation failure. Building the schema to a fixed depth means an
 * over-nested definition is REJECTED rather than fatal, and the limit is
 * the same one `validation.ts` reports on.
 */
function buildStepSchema(depth: number): z.ZodType<WorkflowStep> {
  const leaves = [
    createRecordStepSchema,
    updateRecordStepSchema,
    deleteRecordStepSchema,
    findRecordsStepSchema,
    sendEmailStepSchema,
    httpRequestStepSchema,
    filterStepSchema,
    delayStepSchema,
    formStepSchema,
  ] as const;

  if (depth >= MAX_NESTING_DEPTH) {
    // At the floor, branches and loops are simply not accepted — a
    // clearer message than a recursion that bottoms out mysteriously.
    return z.discriminatedUnion("action", [...leaves]) as unknown as z.ZodType<WorkflowStep>;
  }

  const child = buildStepSchema(depth + 1);

  const ifElseStepSchema = z.object({
    ...stepCommon,
    action: z.literal("if_else"),
    conditions: conditionGroupSchema,
    then: z.array(child).max(MAX_STEPS_PER_DEFINITION),
    otherwise: z.array(child).max(MAX_STEPS_PER_DEFINITION),
  });

  const iteratorStepSchema = z.object({
    ...stepCommon,
    action: z.literal("iterator"),
    source: z.string().trim().min(1).max(200),
    itemAlias: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_]*$/, "An item name is lowercase letters and underscores.")
      .max(40)
      .optional(),
    maxIterations: z.number().int().min(1).max(MAX_ITERATIONS_PER_LOOP).optional(),
    body: z.array(child).max(MAX_STEPS_PER_DEFINITION),
  });

  return z.discriminatedUnion("action", [
    ...leaves,
    ifElseStepSchema,
    iteratorStepSchema,
  ]) as unknown as z.ZodType<WorkflowStep>;
}

export const workflowStepSchema = buildStepSchema(1);

export const workflowProgramSchema = z.object({
  steps: z.array(workflowStepSchema).max(MAX_STEPS_PER_DEFINITION),
});

/* ------------------------------------------------------------------ */
/* TRIGGERS                                                            */
/* ------------------------------------------------------------------ */

export const triggerConfigSchema = z.object({
  recordType: z.string().trim().max(60).optional(),
  watchFields: z.array(z.string().trim().min(1).max(63)).max(40).optional(),
  conditions: conditionGroupSchema.optional(),
  cron: z.string().trim().max(120).optional(),
  timezone: z.string().trim().max(64).optional(),
});

/* ------------------------------------------------------------------ */
/* ACTION INPUTS                                                       */
/* ------------------------------------------------------------------ */

export const createWorkflowSchema = z.object({
  key: workflowKeySchema,
  name: z.string().trim().min(1, "A name is required.").max(200),
  description: z.string().trim().max(2_000).optional().nullable(),
  triggerType: z.enum(TRIGGER_TYPES),
  triggerConfig: triggerConfigSchema.optional(),
  program: workflowProgramSchema.optional(),
});

export const saveDraftSchema = z.object({
  workflowId: uuidSchema,
  /** Omitted creates a new draft; supplied edits an existing one. */
  versionId: uuidSchema.optional(),
  triggerType: z.enum(TRIGGER_TYPES),
  triggerConfig: triggerConfigSchema,
  program: workflowProgramSchema,
  stepBudget: z.number().int().min(1).max(MAX_CONFIGURABLE_STEP_BUDGET).optional(),
  notes: z.string().trim().max(2_000).optional().nullable(),
});

export const publishVersionSchema = z.object({
  versionId: uuidSchema,
  /**
   * ⚠️ AN EXPLICIT ACKNOWLEDGEMENT, NOT A CHECKBOX NOBODY READS.
   *
   * Publishing a scheduled or webhook workflow lends the publisher's
   * identity to every future unattended run. That is a delegation, and a
   * delegation somebody made by accident is one nobody can account for
   * later. The server refuses without it.
   */
  acknowledgeRunsAsMe: z.literal(true, {
    errorMap: () => ({
      message:
        "Publishing makes this workflow act with your permissions when it runs " +
        "unattended. Confirm that is what you intend.",
    }),
  }),
  /** Publish anyway, having seen the warnings. Errors still refuse. */
  acceptWarnings: z.boolean().optional(),
});

export const archiveWorkflowSchema = z.object({
  workflowId: uuidSchema,
  reason: z.string().trim().min(3, "Say why.").max(500),
  /**
   * What to do about runs that are still in flight.
   *
   * ⚠️ NO DEFAULT. Leaving them running and cancelling them are both
   * defensible and they are not the same thing — a half-finished approval
   * chain that is silently cancelled is a decision somebody has to be
   * told about, and a default would make it for them.
   */
  inFlight: z.enum(["let_finish", "cancel"]),
});

export const setEnabledSchema = z.object({
  workflowId: uuidSchema,
  isEnabled: z.boolean(),
});

export const runManuallySchema = z.object({
  workflowId: uuidSchema,
  recordId: uuidSchema.optional(),
  input: z.record(z.unknown()).optional(),
});

export const cancelRunSchema = z.object({
  runId: uuidSchema,
  reason: z.string().trim().min(3, "Say why.").max(500),
});

export const respondToTaskSchema = z.object({
  taskId: uuidSchema,
  decision: z.enum(["approve", "reject"]),
  comment: z.string().trim().max(2_000).optional(),
});

export const listRunsSchema = z.object({
  workflowId: uuidSchema.optional(),
  status: z
    .enum([
      "queued",
      "running",
      "waiting_delay",
      "waiting_form",
      "succeeded",
      "stopped",
      "failed",
      "cancelled",
    ])
    .optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

export const getRunSchema = z.object({ runId: uuidSchema });

/* ------------------------------------------------------------------ */
/* TYPES                                                               */
/* ------------------------------------------------------------------ */

export type CreateWorkflowInput = z.infer<typeof createWorkflowSchema>;
export type SaveDraftInput = z.infer<typeof saveDraftSchema>;
export type PublishVersionInput = z.infer<typeof publishVersionSchema>;
export type ArchiveWorkflowInput = z.infer<typeof archiveWorkflowSchema>;
export type RunManuallyInput = z.infer<typeof runManuallySchema>;
export type RespondToTaskInput = z.infer<typeof respondToTaskSchema>;

export const ALL_ACTION_TYPES = ACTION_TYPES;
