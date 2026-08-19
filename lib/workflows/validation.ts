/**
 * Ordence — Definition Validation
 * Version: v0.23.0-alpha
 *
 * Pure. Runs at save time and again at publish time.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ERRORS BLOCK A PUBLISH. WARNINGS DO NOT. THE SPLIT IS THE POINT.
 * ══════════════════════════════════════════════════════════════════════
 * A validator that refuses everything suspicious produces a product
 * people route around — they build the workflow somewhere else, or they
 * ask an administrator to edit the database. So the line is drawn at:
 *
 *   ERROR   — this definition CANNOT do what it says. A step names a
 *             record type that does not exist, writes a column it may
 *             never write, or waits for a year. Publishing it would
 *             produce a run that fails halfway, having already done the
 *             first half.
 *
 *   WARNING — this definition can run, and the author may not have meant
 *             it. An unscoped update trigger is the archetype: perfectly
 *             valid, occasionally correct, and the cause of most runaway
 *             workflows ever written.
 *
 * ⚠️ THE HALF-COMPLETED RUN IS WHY VALIDATION HAPPENS AT PUBLISH RATHER
 * THAN AT EXECUTION. There is no transaction around a workflow: step 1
 * sends an email, step 2 fails on a column that was never writable. The
 * email cannot be recalled. Catching it while the author is looking at
 * the builder is the only place the mistake is free.
 */

import {
  DEFAULT_STEP_BUDGET,
  MAX_CONFIGURABLE_STEP_BUDGET,
  MAX_DELAY_SECONDS,
  MAX_FORM_DUE_HOURS,
  MAX_ITERATIONS_PER_LOOP,
  MAX_NESTING_DEPTH,
  MAX_STEPS_PER_DEFINITION,
  MIN_DELAY_SECONDS,
} from "./limits";
import { isValidCron, isValidTimezone, parseCron } from "./cron";
import { checkOutboundUrl, filterHeaders } from "./http-policy";
import {
  partitionWritableColumns,
  permissionForRecordAction,
  recordTypeFor,
  RECORD_TYPE_KEYS,
} from "./records";
import { isActionType, isTriggerType } from "./program";
import type {
  TriggerConfig,
  WorkflowProgram,
  WorkflowStep,
  WorkflowTriggerType,
} from "./program";

/* ------------------------------------------------------------------ */
/* PROBLEMS                                                            */
/* ------------------------------------------------------------------ */

export type WorkflowProblem = {
  /** Stable code, so the UI can link to help without parsing prose. */
  code: string;
  /** Where it is — a step key, or `trigger`. */
  where: string;
  message: string;
  remedy: string;
};

export type ValidationResult = {
  ok: boolean;
  errors: WorkflowProblem[];
  warnings: WorkflowProblem[];
};

const KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/* ------------------------------------------------------------------ */
/* THE ENTRY POINT                                                     */
/* ------------------------------------------------------------------ */

export function validateDefinition(input: {
  triggerType: unknown;
  triggerConfig: TriggerConfig;
  program: WorkflowProgram;
  stepBudget?: number;
}): ValidationResult {
  const errors: WorkflowProblem[] = [];
  const warnings: WorkflowProblem[] = [];

  validateTrigger(input.triggerType, input.triggerConfig, errors, warnings);
  validateBudget(input.stepBudget, errors);

  const steps = input.program?.steps;
  if (!Array.isArray(steps)) {
    errors.push({
      code: "program_malformed",
      where: "program",
      message: "The workflow has no steps.",
      remedy: "Add at least one step before publishing.",
    });
    return { ok: false, errors, warnings };
  }

  if (steps.length === 0) {
    errors.push({
      code: "program_empty",
      where: "program",
      message: "This workflow does nothing.",
      remedy:
        "Add at least one action. An active workflow with no steps burns a run " +
        "on every matching event and produces nothing.",
    });
  }

  const seenKeys = new Set<string>();
  let total = 0;

  const walk = (list: WorkflowStep[], depth: number, where: string): void => {
    if (depth > MAX_NESTING_DEPTH) {
      errors.push({
        code: "nesting_too_deep",
        where,
        message: `Steps are nested more than ${MAX_NESTING_DEPTH} levels deep.`,
        remedy:
          "Split this into two workflows. A definition nobody can read on one " +
          "screen is a definition nobody can debug at 6pm.",
      });
      return;
    }

    for (const step of list) {
      total += 1;
      validateStep(step, seenKeys, errors, warnings, input);

      if (step && step.action === "if_else") {
        const branches = [step.then, step.otherwise];
        if (branches.every((b) => !Array.isArray(b) || b.length === 0)) {
          errors.push({
            code: "branch_empty",
            where: step.key ?? where,
            message: "Both sides of this branch are empty.",
            remedy: "Put at least one step on one side, or remove the branch.",
          });
        }
        if (Array.isArray(step.then)) walk(step.then, depth + 1, step.key);
        if (Array.isArray(step.otherwise)) walk(step.otherwise, depth + 1, step.key);
      } else if (step && step.action === "iterator") {
        if (!Array.isArray(step.body) || step.body.length === 0) {
          errors.push({
            code: "loop_empty",
            where: step.key ?? where,
            message: "This loop has no steps inside it.",
            remedy: "Add the steps to repeat, or remove the loop.",
          });
        } else {
          walk(step.body, depth + 1, step.key);
        }
      }
    }
  };

  walk(steps, 1, "program");

  if (total > MAX_STEPS_PER_DEFINITION) {
    errors.push({
      code: "too_many_steps",
      where: "program",
      message: `${total} steps. The limit is ${MAX_STEPS_PER_DEFINITION}.`,
      remedy:
        "Break this into several workflows that trigger each other — but watch " +
        "the chain depth limit while you do it.",
    });
  }

  checkForSelfTriggering(input.triggerType, input.triggerConfig, steps, warnings);

  return { ok: errors.length === 0, errors, warnings };
}

/* ------------------------------------------------------------------ */
/* TRIGGER                                                             */
/* ------------------------------------------------------------------ */

function validateTrigger(
  triggerType: unknown,
  config: TriggerConfig,
  errors: WorkflowProblem[],
  warnings: WorkflowProblem[],
): void {
  if (!isTriggerType(triggerType)) {
    errors.push({
      code: "trigger_unknown",
      where: "trigger",
      message: `"${String(triggerType)}" is not a trigger this product has.`,
      remedy: "Pick a trigger from the list.",
    });
    return;
  }

  const recordScoped =
    triggerType === "record_created" ||
    triggerType === "record_updated" ||
    triggerType === "record_deleted";

  if (recordScoped) {
    if (!recordTypeFor(config.recordType)) {
      errors.push({
        code: "trigger_record_type",
        where: "trigger",
        message: `"${String(config.recordType)}" is not a record type a workflow can watch.`,
        remedy: `Choose one of: ${RECORD_TYPE_KEYS.join(", ")}.`,
      });
    }
  }

  if (triggerType === "record_updated") {
    const watched = config.watchFields ?? [];
    if (watched.length === 0) {
      // ⭐ THE WARNING THAT PREVENTS MOST RUNAWAY WORKFLOWS.
      warnings.push({
        code: "trigger_unscoped_update",
        where: "trigger",
        message: "This runs on ANY change to the record, including its own.",
        remedy:
          "Name the fields you care about. An unscoped update trigger fires on " +
          "every write — including writes made by other workflows, by imports, " +
          "and by this workflow's own actions. Scoping it is the single most " +
          "effective way to stop automations triggering each other in circles.",
      });
    } else if (config.recordType) {
      const definition = recordTypeFor(config.recordType);
      const unknown = watched.filter(
        (field) => definition && !definition.readableColumns.includes(field),
      );
      if (unknown.length > 0) {
        errors.push({
          code: "trigger_unknown_field",
          where: "trigger",
          message: `Watching fields that do not exist: ${unknown.join(", ")}.`,
          remedy:
            "A watched field that does not exist can never change, so this " +
            "workflow would never fire.",
        });
      }
    }
  }

  if (triggerType === "scheduled") {
    if (!config.cron || !isValidCron(config.cron)) {
      const parsed = parseCron(config.cron ?? "");
      errors.push({
        code: "trigger_cron_invalid",
        where: "trigger",
        message: parsed.ok ? "A schedule is required." : parsed.error,
        remedy: 'Example: "0 9 * * 1-5" runs at 9am every weekday.',
      });
    }
    const timezone = config.timezone ?? "UTC";
    if (!isValidTimezone(timezone)) {
      errors.push({
        code: "trigger_timezone_invalid",
        where: "trigger",
        message: `"${timezone}" is not a timezone this system recognises.`,
        remedy: 'Use an IANA name such as "Asia/Kolkata".',
      });
    }
  }
}

function validateBudget(stepBudget: number | undefined, errors: WorkflowProblem[]): void {
  if (stepBudget === undefined) return;
  if (
    !Number.isInteger(stepBudget) ||
    stepBudget < 1 ||
    stepBudget > MAX_CONFIGURABLE_STEP_BUDGET
  ) {
    errors.push({
      code: "budget_out_of_range",
      where: "program",
      message: `The step budget must be between 1 and ${MAX_CONFIGURABLE_STEP_BUDGET}.`,
      remedy: `Leave it empty to use the default of ${DEFAULT_STEP_BUDGET}.`,
    });
  }
}

/* ------------------------------------------------------------------ */
/* STEPS                                                               */
/* ------------------------------------------------------------------ */

function validateStep(
  step: WorkflowStep,
  seenKeys: Set<string>,
  errors: WorkflowProblem[],
  warnings: WorkflowProblem[],
  input: { triggerType: unknown; triggerConfig: TriggerConfig },
): void {
  if (!step || typeof step !== "object") {
    errors.push({
      code: "step_malformed",
      where: "program",
      message: "A step is not an object.",
      remedy: "Remove it and add the step again.",
    });
    return;
  }

  const where = step.key ?? "(no key)";

  if (typeof step.key !== "string" || !KEY_PATTERN.test(step.key)) {
    errors.push({
      code: "step_key_invalid",
      where,
      message: `"${String(step.key)}" is not a valid step key.`,
      remedy:
        "Use lowercase letters, digits and underscores, starting with a letter. " +
        "Run history is keyed by this, so it has to be stable and readable.",
    });
  } else if (seenKeys.has(step.key)) {
    // ⚠️ NOT COSMETIC. Step outputs are stored under the key, so two
    // steps sharing one means the second silently overwrites the first's
    // output and every binding to it changes meaning halfway through.
    errors.push({
      code: "step_key_duplicate",
      where,
      message: `Two steps are called "${step.key}".`,
      remedy:
        "Rename one. Outputs are stored under the step key, so duplicates " +
        "overwrite each other's results.",
    });
  } else {
    seenKeys.add(step.key);
  }

  if (!isActionType(step.action)) {
    errors.push({
      code: "action_unknown",
      where,
      message: `"${String((step as { action?: unknown }).action)}" is not an action.`,
      remedy:
        "Pick an action from the list. Note that running custom code is not " +
        "offered — there is no sandbox to run it in.",
    });
    return;
  }

  switch (step.action) {
    case "create_record":
    case "update_record":
    case "delete_record":
    case "find_records":
      validateRecordStep(step, errors, where);
      break;

    case "send_email": {
      if (!nonEmpty(step.to)) {
        errors.push(problem("email_no_recipient", where, "This email has no recipient.",
          "Set a recipient — an address, or a binding such as {{ trigger.record.email }}."));
      }
      if (!nonEmpty(step.subject)) {
        errors.push(problem("email_no_subject", where, "This email has no subject.",
          "Add a subject line."));
      }
      break;
    }

    case "http_request": {
      // ⚠️ A URL containing a binding cannot be fully checked here — the
      // host is not known until run time. So the policy is applied AGAIN
      // in the executor against the resolved URL, and this check catches
      // the static cases while the author is still looking at the form.
      if (!nonEmpty(step.url)) {
        errors.push(problem("http_no_url", where, "This request has no URL.", "Add one."));
      } else if (!step.url.includes("{{")) {
        const verdict = checkOutboundUrl(step.url);
        if (!verdict.allowed) {
          errors.push(problem("http_url_refused", where, verdict.reason, verdict.remedy));
        }
      }
      const { refused } = filterHeaders(step.headers);
      if (refused.length > 0) {
        errors.push(problem("http_headers_refused", where,
          `These headers cannot be set: ${refused.join(", ")}.`,
          "They control how the request is routed or who it appears to come from."));
      }
      break;
    }

    case "filter": {
      if (!step.conditions || (step.conditions.conditions ?? []).length === 0) {
        // ⚠️ An empty filter passes everything (see `evaluateGroup`), so a
        // filter with no conditions is a step that does nothing while
        // looking like a guard. Refused at publish for exactly that reason.
        errors.push(problem("filter_empty", where,
          "This filter has no conditions, so it stops nothing.",
          "Add a condition, or remove the step — a filter that always passes " +
          "reads like a safety check and is not one."));
      }
      break;
    }

    case "if_else": {
      if (!step.conditions || (step.conditions.conditions ?? []).length === 0) {
        errors.push(problem("branch_no_conditions", where,
          "This branch has no conditions, so it always takes the same path.",
          "Add a condition."));
      }
      break;
    }

    case "iterator": {
      if (!nonEmpty(step.source)) {
        errors.push(problem("loop_no_source", where, "This loop has nothing to loop over.",
          "Point it at a list — usually the results of a Find step, e.g. " +
          "steps.find_leads.records."));
      }
      if (
        step.maxIterations !== undefined &&
        (!Number.isInteger(step.maxIterations) ||
          step.maxIterations < 1 ||
          step.maxIterations > MAX_ITERATIONS_PER_LOOP)
      ) {
        errors.push(problem("loop_max_invalid", where,
          `The repeat limit must be between 1 and ${MAX_ITERATIONS_PER_LOOP}.`,
          "Leave it empty to use the maximum."));
      }
      break;
    }

    case "delay": {
      if (
        !Number.isInteger(step.seconds) ||
        step.seconds < MIN_DELAY_SECONDS ||
        step.seconds > MAX_DELAY_SECONDS
      ) {
        errors.push(problem("delay_out_of_range", where,
          `A wait must be between ${MIN_DELAY_SECONDS} second and ` +
          `${Math.round(MAX_DELAY_SECONDS / 86400)} days.`,
          "For anything longer, use a scheduled workflow — it holds no open " +
          "state while it waits."));
      }
      break;
    }

    case "form": {
      if (!nonEmpty(step.title)) {
        errors.push(problem("form_no_title", where, "This approval step has no title.",
          "Say what the person is being asked to approve — it is all they will see."));
      }
      if (
        step.dueInHours !== undefined &&
        (!Number.isInteger(step.dueInHours) ||
          step.dueInHours < 1 ||
          step.dueInHours > MAX_FORM_DUE_HOURS)
      ) {
        errors.push(problem("form_due_invalid", where,
          `The deadline must be between 1 and ${MAX_FORM_DUE_HOURS} hours.`,
          "A request nobody answers has to expire, or the run waits forever."));
      }
      if (!nonEmpty(step.assignTo)) {
        warnings.push(problem("form_unassigned", where,
          "Nobody is assigned to this approval.",
          "Anyone with permission to approve will be able to respond. That is " +
          "fine for a small team and surprising in a large one."));
      }
      break;
    }
  }

  void input;
}

function validateRecordStep(
  step: Extract<
    WorkflowStep,
    { action: "create_record" | "update_record" | "delete_record" | "find_records" }
  >,
  errors: WorkflowProblem[],
  where: string,
): void {
  const definition = recordTypeFor(step.recordType);
  if (!definition) {
    errors.push(problem("record_type_unknown", where,
      `"${String(step.recordType)}" is not a record type a workflow can touch.`,
      `Choose one of: ${RECORD_TYPE_KEYS.join(", ")}. The list is deliberately ` +
      `short — it is what stops a workflow writing to the audit log or the ` +
      `user table.`));
    return;
  }

  const operation =
    step.action === "create_record" ? "create"
      : step.action === "update_record" ? "update"
        : step.action === "delete_record" ? "delete"
          : "read";

  if (!permissionForRecordAction(step.recordType, operation)) {
    errors.push(problem("record_operation_unsupported", where,
      `A workflow cannot ${operation} a ${definition.label.toLowerCase()}.`,
      operation === "create" && step.recordType === "booking"
        ? "A booking is created through the booking screen, which holds three " +
          "separate protections against selling one flat twice. An automation " +
          "that inserted one directly would bypass all three."
        : "This record type does not offer that operation to automations."));
    return;
  }

  if (step.action === "create_record" || step.action === "update_record") {
    const columns = Object.keys(step.values ?? {});
    if (columns.length === 0) {
      errors.push(problem("record_no_values", where, "No fields are being set.",
        "Choose at least one field to write."));
    }

    const { refused } = partitionWritableColumns(step.recordType, columns);
    if (refused.length > 0) {
      errors.push(problem("record_column_refused", where,
        `A workflow may not write: ${refused.join(", ")}.`,
        `Writable fields on a ${definition.label.toLowerCase()} are: ` +
        `${definition.writableColumns.join(", ")}. The rest are either ` +
        `system-managed or protected by rules a direct write would skip.`));
    }

    const missing =
      step.action === "create_record"
        ? definition.requiredOnCreate.filter((column) => !columns.includes(column))
        : [];
    if (missing.length > 0) {
      errors.push(problem("record_missing_required", where,
        `Creating a ${definition.label.toLowerCase()} needs: ${missing.join(", ")}.`,
        "Set them, or the step will fail at run time with a constraint error."));
    }
  }

  if (step.action === "update_record" || step.action === "delete_record") {
    if (!nonEmpty(step.recordId)) {
      errors.push(problem("record_no_id", where, "No record is identified.",
        "Point at the record — usually {{ trigger.record.id }} or an item from " +
        "a loop."));
    }
  }
}

/* ------------------------------------------------------------------ */
/* ⭐ THE SELF-TRIGGER WARNING                                          */
/* ------------------------------------------------------------------ */

/**
 * "When a lead changes, change the lead."
 *
 * The runtime refuses to re-enter a version from its own event (see
 * `triggers.ts`), so this shape cannot actually loop — but it is worth
 * saying out loud at publish time anyway, for two reasons:
 *
 *   1. The author usually did not realise, and the warning is the first
 *      time anybody explains the interaction to them.
 *   2. The runtime guard is per-VERSION. Two workflows written this way,
 *      watching each other's fields, DO chain — and are stopped only by
 *      the depth limit, after five runs per event, every time.
 *
 * A warning rather than an error because the pattern is sometimes exactly
 * right: "when a lead's status changes, recalculate its score" writes a
 * field nobody is watching and is perfectly well behaved.
 */
function checkForSelfTriggering(
  triggerType: unknown,
  config: TriggerConfig,
  steps: WorkflowStep[],
  warnings: WorkflowProblem[],
): void {
  if (triggerType !== "record_updated" || !config.recordType) return;

  const watched = config.watchFields ?? [];
  const collect = (list: WorkflowStep[], depth: number): WorkflowStep[] => {
    if (depth > 8) return [];
    const found: WorkflowStep[] = [];
    for (const step of list ?? []) {
      if (!step || typeof step !== "object") continue;
      found.push(step);
      if (step.action === "if_else") {
        found.push(...collect(step.then ?? [], depth + 1));
        found.push(...collect(step.otherwise ?? [], depth + 1));
      } else if (step.action === "iterator") {
        found.push(...collect(step.body ?? [], depth + 1));
      }
    }
    return found;
  };

  for (const step of collect(steps, 0)) {
    if (step.action !== "update_record") continue;
    if (step.recordType !== config.recordType) continue;

    const written = Object.keys(step.values ?? {});
    const overlap = watched.filter((field) => written.includes(field));

    if (watched.length === 0) {
      warnings.push({
        code: "self_trigger_unscoped",
        where: step.key,
        message:
          `This workflow watches every change to a ${config.recordType} and then ` +
          `updates a ${config.recordType}.`,
        remedy:
          "It cannot loop into itself — the engine refuses to re-enter a " +
          "workflow from its own event — but any OTHER workflow watching this " +
          "record will fire, and if it writes back, the two will chain until " +
          "the depth limit stops them. Name the fields you watch.",
      });
      return;
    }

    if (overlap.length > 0) {
      warnings.push({
        code: "self_trigger_watched_field",
        where: step.key,
        message: `This step writes ${overlap.join(", ")}, which is what the trigger watches.`,
        remedy:
          "The engine will suppress the run this causes, so it will not loop. " +
          "It will still produce a skipped-run entry in the history on every " +
          "execution. Writing a field you are not watching avoids both.",
      });
      return;
    }
  }
}

/* ------------------------------------------------------------------ */
/* HELPERS                                                             */
/* ------------------------------------------------------------------ */

function problem(
  code: string,
  where: string,
  message: string,
  remedy: string,
): WorkflowProblem {
  return { code, where, message, remedy };
}

function nonEmpty(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * A one-line summary for the publish dialog.
 *
 * Deliberately states the warning count as well as the error count: a
 * publish that goes ahead with three warnings should be a decision
 * somebody made, not a thing that happened.
 */
export function summariseValidation(result: ValidationResult): string {
  if (result.errors.length === 0 && result.warnings.length === 0) {
    return "Ready to publish.";
  }
  if (result.errors.length === 0) {
    return `Ready to publish, with ${count(result.warnings.length, "warning")}.`;
  }
  return `${count(result.errors.length, "problem")} must be fixed first.`;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export function isTriggerRecordScoped(triggerType: WorkflowTriggerType): boolean {
  return (
    triggerType === "record_created" ||
    triggerType === "record_updated" ||
    triggerType === "record_deleted"
  );
}
