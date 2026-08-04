/**
 * Ordence — The Executor Planner
 * Version: v0.23.0-alpha
 *
 * ⭐ THE HEART OF THE PHASE, AND IT TOUCHES NOTHING.
 *
 * Pure: no `@/db`, no network, no clock of its own — `now` is an
 * argument. Given the program, a cursor and the run context, it answers
 * one question: **what happens next?**
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THE DECISIONS AND THE EFFECTS ARE SEPARATED AT ALL
 * ══════════════════════════════════════════════════════════════════════
 * The hard parts of a workflow engine are branching, looping, stopping
 * and resuming. The easy parts are "write a row" and "send an email".
 * In most implementations they are interleaved — a recursive `execute()`
 * that evaluates a condition, awaits a database call, recurses into a
 * branch — and the result is that the hard parts can only be tested with
 * a database, a mail server and a clock.
 *
 * They are not tested. Nobody sets that up for the fourteenth branch
 * case, so the fourteenth branch case is discovered by a customer.
 *
 * Here every control decision is a pure function of state, so the loop
 * caps, the branch selection, the filter stop and the resume-after-delay
 * path are all exercised in `tests/security/workflows.test.ts` with
 * literal objects and no fixtures at all.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE CURSOR IS ADVANCED **BEFORE** THE STEP RUNS
 * ══════════════════════════════════════════════════════════════════════
 * Every result that dispatches work carries the cursor as it will be
 * AFTER that work. The executor persists the outcome and the new cursor
 * together, so a process killed mid-step leaves a run in `running` with
 * the step recorded as started and never finished — which a sweeper marks
 * failed and a human can read.
 *
 * The alternative (advance on completion) makes a crashed step run again
 * on resume. For `send_email` that is a duplicate message to a buyer; for
 * `http_request` it is a duplicate charge on somebody's payment API.
 * At-most-once with a visible failure beats at-least-once with a silent
 * one, for effects nobody has told us are idempotent.
 */

import {
  MAX_ITERATIONS_PER_LOOP,
  MAX_ITERATIONS_PER_RUN,
  MAX_PLANNER_WALK,
  MAX_STEPS_PER_RUN,
  MAX_TRIGGER_DEPTH,
} from "./limits";
import { evaluateGroup, readPath } from "./bindings";
import type {
  RunContext,
  WorkflowProgram,
  WorkflowStep,
} from "./program";

/* ------------------------------------------------------------------ */
/* THE CURSOR                                                          */
/* ------------------------------------------------------------------ */

/**
 * One level of the walk.
 *
 * `list` addresses a step ARRAY inside the program — `[]` is the top
 * level, `["2","then"]` is the `then` branch of the third step,
 * `["2","then","0","body"]` is the body of the first step inside it.
 *
 * ⚠️ ADDRESSED BY PATH, NOT BY EMBEDDED STEPS. The cursor is persisted as
 * JSON on the run and is re-read minutes or days later; a cursor that
 * carried copies of the steps would keep executing a definition the
 * author has since changed, and would silently disagree with the version
 * the run claims to be running.
 */
export type CursorFrame = {
  list: string[];
  /** Index of the next step to consider within that list. */
  index: number;
  /** Present only on frames opened by an `iterator`. */
  loop?: {
    stepKey: string;
    sourcePath: string;
    alias: string;
    iteration: number;
    /**
     * Fixed when the loop opens.
     *
     * ⚠️ FROZEN ON PURPOSE. The items themselves are re-read from the
     * context each time — cheaper than copying two hundred rows into the
     * cursor — but the COUNT is not. If a step inside the body rewrites
     * the source, a live count would let the loop extend itself, which is
     * an unbounded loop wearing a bounded loop's clothes.
     */
    itemCount: number;
  };
};

export type Cursor = { frames: CursorFrame[] };

export function initialCursor(): Cursor {
  return { frames: [{ list: [], index: 0 }] };
}

export function isFinished(cursor: Cursor): boolean {
  return cursor.frames.length === 0;
}

/* ------------------------------------------------------------------ */
/* THE RESULT                                                          */
/* ------------------------------------------------------------------ */

export type PlanAbortReason =
  | "step_budget_exhausted"
  | "iteration_budget_exhausted"
  | "depth_exceeded"
  | "invalid_program"
  | "planner_walk_exhausted";

export type PlanResult =
  /** Execute an effect, then persist this cursor. */
  | {
      kind: "run_step";
      step: WorkflowStep;
      /** Human-readable address, e.g. `2.then.0`. Recorded on the step row. */
      path: string;
      /** Bindings from enclosing loops: alias → element, plus `item`. */
      scope: Record<string, unknown>;
      cursor: Cursor;
    }
  /** Suspend until `resumeAt`, then continue from this cursor. */
  | { kind: "sleep"; step: WorkflowStep; path: string; resumeAt: Date; cursor: Cursor }
  /** Suspend until a person responds to the task for this step. */
  | {
      kind: "await_form";
      step: WorkflowStep;
      path: string;
      scope: Record<string, unknown>;
      cursor: Cursor;
    }
  /** The program ran to the end. */
  | { kind: "finish"; status: "succeeded" }
  /** A filter said no, or a person rejected. Not a failure. */
  | { kind: "finish"; status: "stopped"; stepKey: string; message: string }
  /** A limit was hit. The run stops and says so. */
  | { kind: "abort"; reason: PlanAbortReason; message: string };

export type PlanState = {
  program: WorkflowProgram;
  cursor: Cursor;
  context: RunContext;
  counters: {
    stepsExecuted: number;
    iterationsUsed: number;
    /** The version's own budget, already clamped to MAX_STEPS_PER_RUN. */
    stepBudget: number;
  };
  /** How deep this run sits in a chain of workflow-triggered workflows. */
  depth: number;
  now: Date;
};

/* ------------------------------------------------------------------ */
/* ⭐ THE PLANNER                                                       */
/* ------------------------------------------------------------------ */

export function planNext(state: PlanState): PlanResult {
  /**
   * ⚠️ CHECKED HERE AS WELL AS AT DISPATCH AND IN THE DATABASE.
   *
   * Three places for one rule looks redundant until you ask which of them
   * is running when a run is resumed from a `delay` an hour after the
   * dispatcher made its decision. This is the only one of the three that
   * sees every continuation of every run.
   */
  if (state.depth > MAX_TRIGGER_DEPTH) {
    return {
      kind: "abort",
      reason: "depth_exceeded",
      message:
        `This run is ${state.depth} workflows deep in a chain of automations ` +
        `that triggered each other. The limit is ${MAX_TRIGGER_DEPTH}. Something ` +
        `is looping — check which workflows write to the records the others watch.`,
    };
  }

  const cursor = cloneCursor(state.cursor);
  const budget = Math.min(state.counters.stepBudget, MAX_STEPS_PER_RUN);

  for (let walk = 0; walk < MAX_PLANNER_WALK; walk += 1) {
    if (cursor.frames.length === 0) return { kind: "finish", status: "succeeded" };

    // Non-null: the length check above guarantees a frame is present.
    const frame = cursor.frames[cursor.frames.length - 1]!;
    const list = resolveList(state.program, frame.list);

    if (!list) {
      return {
        kind: "abort",
        reason: "invalid_program",
        message:
          `This run's saved position (${frame.list.join(".") || "start"}) does not ` +
          `exist in the workflow it is running. That should be impossible — an ` +
          `active version cannot be edited — so treat it as a defect and report it.`,
      };
    }

    /* --- End of this list -------------------------------------- */
    if (frame.index >= list.length) {
      if (frame.loop) {
        const nextIteration = frame.loop.iteration + 1;
        if (nextIteration < frame.loop.itemCount) {
          if (state.counters.iterationsUsed + nextIteration >= MAX_ITERATIONS_PER_RUN) {
            return {
              kind: "abort",
              reason: "iteration_budget_exhausted",
              message:
                `This run has repeated steps ${MAX_ITERATIONS_PER_RUN} times, which is ` +
                `the limit for one run. Narrow the list the loop works through — a ` +
                `"for each" over every record in the workspace is not a workflow, it ` +
                `is a migration.`,
            };
          }
          frame.loop.iteration = nextIteration;
          frame.index = 0;
          continue;
        }
      }
      cursor.frames.pop();
      continue;
    }

    const step: WorkflowStep | undefined = list[frame.index];
    const path = pathFor(frame.list, frame.index);

    if (!step || typeof step !== "object" || typeof step.action !== "string") {
      return {
        kind: "abort",
        reason: "invalid_program",
        message: `Step at ${path} is malformed.`,
      };
    }

    const scope = scopeFor(cursor, state.context);
    const scopedContext = withScope(state.context, scope);

    switch (step.action) {
      /* --- filter: stop, quietly and on purpose ------------------ */
      case "filter": {
        if (evaluateGroup(step.conditions, scopedContext)) {
          frame.index += 1;
          continue;
        }
        // ⚠️ `stopped`, NOT `succeeded` and NOT `failed`.
        //
        // "The run did nothing, and that was correct" has to be
        // distinguishable from "the run did everything" — otherwise the
        // only way to tell a working filter from a broken workflow is to
        // read every run's steps. It is equally not a failure: nobody
        // should be paged because a lead was not hot enough.
        return {
          kind: "finish",
          status: "stopped",
          stepKey: step.key,
          message: `Stopped at "${step.label ?? step.key}": the conditions were not met.`,
        };
      }

      /* --- if_else: descend into the taken branch ---------------- */
      case "if_else": {
        const taken = evaluateGroup(step.conditions, scopedContext) ? "then" : "otherwise";
        frame.index += 1;
        cursor.frames.push({
          list: [...frame.list, String(frame.index - 1), taken],
          index: 0,
        });
        continue;
      }

      /* --- iterator: open a loop frame --------------------------- */
      case "iterator": {
        const items = readPath(scopedContext, step.source);
        const openedAt = frame.index;
        frame.index += 1;

        if (!Array.isArray(items) || items.length === 0) {
          // Nothing to loop over is not an error. A "for each overdue
          // milestone" workflow on a day with none should end quietly.
          continue;
        }

        const requested = Math.max(1, step.maxIterations ?? MAX_ITERATIONS_PER_LOOP);
        const itemCount = Math.min(items.length, requested, MAX_ITERATIONS_PER_LOOP);

        if (state.counters.iterationsUsed >= MAX_ITERATIONS_PER_RUN) {
          return {
            kind: "abort",
            reason: "iteration_budget_exhausted",
            message:
              `This run has already repeated steps ${MAX_ITERATIONS_PER_RUN} times. ` +
              `It will not start another loop.`,
          };
        }

        cursor.frames.push({
          list: [...frame.list, String(openedAt), "body"],
          index: 0,
          loop: {
            stepKey: step.key,
            sourcePath: step.source,
            alias: step.itemAlias ?? "item",
            iteration: 0,
            itemCount,
          },
        });
        continue;
      }

      /* --- delay: suspend on the clock --------------------------- */
      case "delay": {
        frame.index += 1;
        const seconds = clampDelaySeconds(step.seconds);
        return {
          kind: "sleep",
          step,
          path,
          resumeAt: new Date(state.now.getTime() + seconds * 1000),
          cursor,
        };
      }

      /* --- form: suspend on a person ----------------------------- */
      case "form": {
        frame.index += 1;
        return { kind: "await_form", step, path, scope, cursor };
      }

      /* --- everything else is an effect the executor performs ----- */
      default: {
        if (state.counters.stepsExecuted >= budget) {
          return {
            kind: "abort",
            reason: "step_budget_exhausted",
            message:
              `This run has executed ${state.counters.stepsExecuted} steps, which is its ` +
              `budget. A run that hits this is almost always looping over more ` +
              `records than intended — check the "for each" steps.`,
          };
        }
        frame.index += 1;
        return { kind: "run_step", step, path, scope, cursor };
      }
    }
  }

  // Unreachable unless the walk above fails to make progress, which would
  // be a defect in this file rather than in a workflow.
  return {
    kind: "abort",
    reason: "planner_walk_exhausted",
    message:
      "The planner could not find the next step within its own limit. This is " +
      "a defect in the engine, not in the workflow — report it.",
  };
}

/* ------------------------------------------------------------------ */
/* ADDRESSING                                                          */
/* ------------------------------------------------------------------ */

/**
 * Resolve a list path to the step array it names.
 *
 * Returns null rather than throwing on anything unexpected, so a cursor
 * that no longer fits its program aborts the run with an explanation
 * instead of taking down the worker.
 */
export function resolveList(
  program: WorkflowProgram,
  listPath: readonly string[],
): WorkflowStep[] | null {
  let current: WorkflowStep[] = program?.steps ?? [];
  if (!Array.isArray(current)) return null;

  for (let i = 0; i < listPath.length; i += 2) {
    const index = Number(listPath[i]);
    const branch = listPath[i + 1];
    if (!Number.isInteger(index) || index < 0 || index >= current.length) return null;

    const step: WorkflowStep | undefined = current[index];
    if (!step) return null;

    if (step.action === "if_else" && branch === "then") current = step.then;
    else if (step.action === "if_else" && branch === "otherwise") current = step.otherwise;
    else if (step.action === "iterator" && branch === "body") current = step.body;
    else return null;

    if (!Array.isArray(current)) return null;
  }

  return current;
}

export function pathFor(listPath: readonly string[], index: number): string {
  return [...listPath, String(index)].join(".");
}

/* ------------------------------------------------------------------ */
/* SCOPE                                                               */
/* ------------------------------------------------------------------ */

/**
 * The loop bindings visible at the current position.
 *
 * Outer loops stay visible under their alias, so a nested "for each
 * project → for each unit" can reference both. `item` always means the
 * innermost, because that is what people write first and are surprised
 * by only when they nest.
 */
export function scopeFor(cursor: Cursor, context: RunContext): Record<string, unknown> {
  const scope: Record<string, unknown> = {};

  for (const frame of cursor.frames) {
    if (!frame.loop) continue;
    const items = readPath(context, frame.loop.sourcePath);
    if (!Array.isArray(items)) continue;
    const value = items[frame.loop.iteration];
    scope[frame.loop.alias] = value;
    scope.item = value;
    scope.index = frame.loop.iteration;
  }

  return scope;
}

function withScope(context: RunContext, scope: Record<string, unknown>): RunContext {
  if (Object.keys(scope).length === 0) return context;
  // ⚠️ A COPY. Mutating the run's context here would leave the last
  // loop's item bound after the loop ended, so a step AFTER the loop
  // would read a value it has no business seeing — and would work, which
  // is worse than failing.
  return { ...context, ...scope } as RunContext;
}

function clampDelaySeconds(seconds: unknown): number {
  const value = typeof seconds === "number" && Number.isFinite(seconds) ? seconds : 0;
  // The real ceiling is enforced by the validator at publish time; this
  // clamp is for a definition that reached here some other way.
  return Math.max(1, Math.min(Math.floor(value), 30 * 24 * 60 * 60));
}

function cloneCursor(cursor: Cursor): Cursor {
  return {
    frames: (cursor?.frames ?? []).map((frame) => ({
      list: [...frame.list],
      index: frame.index,
      loop: frame.loop ? { ...frame.loop } : undefined,
    })),
  };
}

/* ------------------------------------------------------------------ */
/* WALKING A DEFINITION                                                */
/* ------------------------------------------------------------------ */

/** Every step in a program, depth-first, including nested ones. */
export function collectSteps(program: WorkflowProgram): WorkflowStep[] {
  const found: WorkflowStep[] = [];

  const walk = (steps: WorkflowStep[] | undefined, depth: number): void => {
    if (!Array.isArray(steps) || depth > 32) return;
    for (const step of steps) {
      if (!step || typeof step !== "object") continue;
      found.push(step);
      if (step.action === "if_else") {
        walk(step.then, depth + 1);
        walk(step.otherwise, depth + 1);
      } else if (step.action === "iterator") {
        walk(step.body, depth + 1);
      }
    }
  };

  walk(program?.steps, 0);
  return found;
}
