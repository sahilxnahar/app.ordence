/**
 * Ordence — The Workflow Vocabulary
 * Version: v0.23.0-alpha
 *
 * Pure and isomorphic. No `@/db` import, no I/O, no Node APIs.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE DEPENDENCY POINTS THE OTHER WAY IN THIS PHASE, DELIBERATELY
 * ══════════════════════════════════════════════════════════════════════
 * Everywhere else in this codebase, `lib/` imports a type from
 * `db/schema/` — `payment-plan.ts` takes `SalesPaymentStatus` from
 * `db/schema/sales.ts`, and that is the right direction when the database
 * owns the vocabulary.
 *
 * Here the database does not own it. The list of actions is the PRODUCT:
 * the validator, the planner, the builder UI and the run history all
 * reason about it, and the `workflow_action_type` enum is a projection of
 * it into a column. So this file is the source and `db/schema/workflows.ts`
 * builds its pgEnum from these arrays.
 *
 * The payoff is that the two cannot drift. Adding an action here is a
 * type error everywhere that switches on it, and a migration diff in the
 * enum — instead of a value the database accepts and the planner has
 * never heard of, which is how an engine ends up with a run stuck in
 * `running` forever.
 *
 * ⚠️ `run_code` IS ABSENT AND THAT IS A DECISION, NOT AN OMISSION.
 * Executing tenant-authored code needs a sandbox with a memory ceiling, a
 * CPU ceiling and no ambient network — none of which exist here. A
 * `new Function()` or a `vm` context in the same process as the database
 * client is not a sandbox; it is remote code execution with extra steps,
 * and the first thing it reads is `process.env.DATABASE_URL`. When there
 * is a real isolate to run it in, it becomes an action. Until then the
 * honest answer is that the product does not have it.
 */

/* ------------------------------------------------------------------ */
/* TRIGGERS                                                            */
/* ------------------------------------------------------------------ */

export const TRIGGER_TYPES = [
  "record_created",
  "record_updated",
  "record_deleted",
  "manual",
  "scheduled",
  "webhook",
] as const;

export type WorkflowTriggerType = (typeof TRIGGER_TYPES)[number];

/* ------------------------------------------------------------------ */
/* ACTIONS                                                             */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ THE ORDER OF THIS ARRAY IS THE ORDER OF THE POSTGRES ENUM.
 *
 * Appending is free. Inserting in the middle or reordering is an enum
 * rewrite, and on a table with run history that is a long lock on the
 * busiest table in the phase. Add to the end.
 */
export const ACTION_TYPES = [
  /* --- Effects: these change something outside the run ------------ */
  "create_record",
  "update_record",
  "delete_record",
  "find_records",
  "send_email",
  "http_request",
  /* --- Control: these change what the run does next --------------- */
  "filter",
  "if_else",
  "iterator",
  "delay",
  "form",
] as const;

export type WorkflowActionType = (typeof ACTION_TYPES)[number];

/**
 * Control-flow actions are decided ENTIRELY in `planner.ts`, with no
 * database and no network. That is not a performance note — it is why the
 * hardest part of this engine (branching, looping, stopping) is testable
 * without a Postgres instance, and therefore why it is tested.
 */
export const CONTROL_ACTIONS: readonly WorkflowActionType[] = Object.freeze([
  "filter",
  "if_else",
  "iterator",
  "delay",
  "form",
]);

export function isControlAction(action: WorkflowActionType): boolean {
  return CONTROL_ACTIONS.includes(action);
}

export function isActionType(value: unknown): value is WorkflowActionType {
  return (
    typeof value === "string" &&
    (ACTION_TYPES as readonly string[]).includes(value)
  );
}

export function isTriggerType(value: unknown): value is WorkflowTriggerType {
  return (
    typeof value === "string" &&
    (TRIGGER_TYPES as readonly string[]).includes(value)
  );
}

/* ------------------------------------------------------------------ */
/* CONDITIONS                                                          */
/* ------------------------------------------------------------------ */

export const CONDITION_OPERATORS = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "not_contains",
  "in",
  "is_empty",
  "is_not_empty",
  /** True when the triggering UPDATE touched the named field. */
  "changed",
] as const;

export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

export type WorkflowCondition = {
  /** A binding path into the run context, e.g. `trigger.record.status`. */
  path: string;
  operator: ConditionOperator;
  /** Absent for `is_empty`, `is_not_empty` and `changed`. */
  value?: unknown;
};

/**
 * ⚠️ `match` IS REQUIRED, WITH NO DEFAULT.
 *
 * "All of these" and "any of these" are opposite instructions, and a
 * default silently picks one. On a filter step, guessing `any` when the
 * author meant `all` means the workflow fires on records it was written
 * to skip — and the author's evidence that it works is that it ran.
 */
export type WorkflowConditionGroup = {
  match: "all" | "any";
  conditions: WorkflowCondition[];
};

/* ------------------------------------------------------------------ */
/* STEPS                                                               */
/* ------------------------------------------------------------------ */

type StepCommon = {
  /**
   * Unique within the whole definition, including inside branches and
   * loop bodies. It is what run history is keyed by, so renaming a step
   * makes its past executions unreadable — hence a key AND a label.
   */
  key: string;
  label?: string;
};

/** A value written into a record. Strings may carry `{{ bindings }}`. */
export type TemplateValue = string | number | boolean | null;

export type CreateRecordStep = StepCommon & {
  action: "create_record";
  recordType: string;
  values: Record<string, TemplateValue>;
};

export type UpdateRecordStep = StepCommon & {
  action: "update_record";
  recordType: string;
  /** Binding path resolving to the id, e.g. `trigger.record.id`. */
  recordId: string;
  values: Record<string, TemplateValue>;
};

export type DeleteRecordStep = StepCommon & {
  action: "delete_record";
  recordType: string;
  recordId: string;
};

export type FindRecordsStep = StepCommon & {
  action: "find_records";
  recordType: string;
  where?: WorkflowConditionGroup;
  limit?: number;
};

export type SendEmailStep = StepCommon & {
  action: "send_email";
  to: string;
  subject: string;
  body: string;
};

export type HttpRequestStep = StepCommon & {
  action: "http_request";
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  body?: string;
};

export type FilterStep = StepCommon & {
  action: "filter";
  conditions: WorkflowConditionGroup;
};

export type IfElseStep = StepCommon & {
  action: "if_else";
  conditions: WorkflowConditionGroup;
  then: WorkflowStep[];
  otherwise: WorkflowStep[];
};

export type IteratorStep = StepCommon & {
  action: "iterator";
  /** Binding path to an array, e.g. `steps.find_units.records`. */
  source: string;
  /** Name the current element is bound to inside the body. */
  itemAlias?: string;
  maxIterations?: number;
  body: WorkflowStep[];
};

export type DelayStep = StepCommon & {
  action: "delay";
  seconds: number;
};

export type FormStep = StepCommon & {
  action: "form";
  title: string;
  instructions?: string;
  /** Binding path or literal uuid of the person who must respond. */
  assignTo?: string;
  dueInHours?: number;
  /**
   * What a rejection means. `stop` ends the run as "stopped" — the human
   * said no and that is a normal outcome. `fail` marks it failed, for the
   * cases where a rejection genuinely is an error somebody must look at.
   */
  onReject?: "stop" | "fail";
};

export type WorkflowStep =
  | CreateRecordStep
  | UpdateRecordStep
  | DeleteRecordStep
  | FindRecordsStep
  | SendEmailStep
  | HttpRequestStep
  | FilterStep
  | IfElseStep
  | IteratorStep
  | DelayStep
  | FormStep;

/** The whole program. A version stores exactly this in `steps`. */
export type WorkflowProgram = {
  steps: WorkflowStep[];
};

/* ------------------------------------------------------------------ */
/* TRIGGER CONFIGURATION                                               */
/* ------------------------------------------------------------------ */

export type TriggerConfig = {
  /** Required for the three `record_*` triggers. */
  recordType?: string;
  /**
   * ⭐ FIELD SCOPING on `record_updated`.
   *
   * An unscoped "when a lead is updated" fires on every write to the
   * table — including the write this very workflow just made. Naming the
   * fields the workflow cares about is the single most effective loop
   * prevention available, because it is the one the author understands:
   * a workflow that watches `status` and writes `owner_id` cannot
   * re-trigger itself at all.
   *
   * Empty or absent means "any field", which is allowed and warned about
   * by `validation.ts`.
   */
  watchFields?: string[];
  /** Extra conditions the record must satisfy for the run to start. */
  conditions?: WorkflowConditionGroup;
  /** `scheduled` only. Five-field cron, evaluated in the tenant timezone. */
  cron?: string;
  timezone?: string;
};

/* ------------------------------------------------------------------ */
/* RUN CONTEXT                                                         */
/* ------------------------------------------------------------------ */

/**
 * Everything a step can read, and the only thing bindings resolve against.
 *
 * ⚠️ NOTHING ABOUT THE ENVIRONMENT IS IN HERE. No env vars, no connection
 * details, no platform identifiers. A binding language whose root object
 * contains a secret is a data-exfiltration feature: one `http_request`
 * step with `{{ env.DATABASE_URL }}` in the body and the workspace has
 * posted its own credentials to an endpoint of the author's choosing.
 */
export type RunContext = {
  trigger: {
    type: WorkflowTriggerType;
    recordType?: string;
    record?: Record<string, unknown> | null;
    /** Field names the triggering UPDATE actually changed. */
    changedFields?: string[];
    /** For `webhook`: the parsed payload. For `manual`: caller input. */
    input?: Record<string, unknown> | null;
    firedAt?: string;
  };
  /** Output of each completed step, keyed by step key. */
  steps: Record<string, unknown>;
  /** The element the innermost iterator is currently on. */
  item?: unknown;
  /** Non-sensitive facts about who this run is acting as. */
  actor: {
    userId: string;
    role: string;
  };
};
