/**
 * Ordence — The Step Tree
 * Version: v0.24.0-alpha
 *
 * Pure. No React, no I/O. Everything the builder does to a definition —
 * add, remove, reorder, nest — happens here, and it happens immutably.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THE EDITING MODEL IS A SEPARATE, PURE FILE
 * ══════════════════════════════════════════════════════════════════════
 * A workflow definition is a TREE, not a list: `if_else` carries two
 * child lists and `iterator` carries one. "Move step 3 down" therefore
 * means "move the step at index 3 of the list addressed by this path",
 * and every one of those operations has an off-by-one in it somewhere.
 *
 * Doing that arithmetic inside a component means it can only be checked
 * by clicking. Doing it here means it is checked by a test, and the
 * component is left with the part components are good at — rendering.
 *
 * ⚠️ NOTHING IN THIS FILE DECIDES WHETHER A DEFINITION IS VALID. That
 * question has exactly one answer and it lives in
 * `lib/workflows/validation.ts`, which the builder calls on every
 * keystroke. A second opinion here would be a second opinion that can be
 * wrong.
 */

import { ACTION_CATALOG, permissionsRequiredBy } from "@/lib/workflows/actions";
import {
  DEFAULT_FORM_DUE_HOURS,
  MAX_ITERATIONS_PER_LOOP,
} from "@/lib/workflows/limits";
import {
  permissionForRecordAction,
  RECORD_TYPES,
  RECORD_TYPE_KEYS,
} from "@/lib/workflows/records";
import type {
  WorkflowActionType,
  WorkflowStep,
  WorkflowTriggerType,
} from "@/lib/workflows/program";
import type { TriggerConfig } from "@/lib/workflows/program";

/* ------------------------------------------------------------------ */
/* ADDRESSING                                                          */
/* ------------------------------------------------------------------ */

/** The child lists a step may own. */
export type Slot = "then" | "otherwise" | "body";

/**
 * The address of a LIST of steps.
 *
 * Empty means the top-level list. `[{ index: 2, slot: "then" }]` means
 * "the `then` branch of the step at index 2 of the top-level list".
 */
export type ListPath = readonly { index: number; slot: Slot }[];

export const ROOT: ListPath = [];

export function pathsEqual(a: ListPath, b: ListPath): boolean {
  return (
    a.length === b.length &&
    a.every((seg, i) => seg.index === b[i]?.index && seg.slot === b[i]?.slot)
  );
}

/** A stable string form, used for React keys and `aria-controls`. */
export function pathId(path: ListPath): string {
  return path.length === 0 ? "root" : path.map((s) => `${s.index}.${s.slot}`).join(".");
}

function childList(step: WorkflowStep | undefined, slot: Slot): WorkflowStep[] | null {
  if (!step) return null;
  if (step.action === "if_else" && (slot === "then" || slot === "otherwise")) {
    return (slot === "then" ? step.then : step.otherwise) ?? [];
  }
  if (step.action === "iterator" && slot === "body") return step.body ?? [];
  return null;
}

function withChildList(
  step: WorkflowStep,
  slot: Slot,
  list: WorkflowStep[],
): WorkflowStep {
  if (step.action === "if_else" && slot === "then") return { ...step, then: list };
  if (step.action === "if_else" && slot === "otherwise") {
    return { ...step, otherwise: list };
  }
  if (step.action === "iterator" && slot === "body") return { ...step, body: list };
  return step;
}

/** The steps at `path`, or an empty list when the path does not resolve. */
export function getList(steps: readonly WorkflowStep[], path: ListPath): WorkflowStep[] {
  let current = steps as WorkflowStep[];
  for (const segment of path) {
    const next = childList(current[segment.index], segment.slot);
    if (!next) return [];
    current = next;
  }
  return current;
}

/**
 * Rebuild the tree with the list at `path` replaced by `fn(list)`.
 *
 * ⚠️ Immutable all the way down. React re-renders on identity, and a
 * mutation two levels inside a `then` branch produces an editor that has
 * changed and does not repaint — which reads as "my edit was lost".
 */
export function mapList(
  steps: readonly WorkflowStep[],
  path: ListPath,
  fn: (list: WorkflowStep[]) => WorkflowStep[],
): WorkflowStep[] {
  if (path.length === 0) return fn([...steps]);

  const [head, ...rest] = path;
  if (!head) return fn([...steps]);

  const parent = steps[head.index];
  const inner = childList(parent, head.slot);
  if (!parent || !inner) return [...steps];

  const updated = withChildList(parent, head.slot, mapList(inner, rest, fn));
  return steps.map((step, index) => (index === head.index ? updated : step));
}

export function insertStep(
  steps: readonly WorkflowStep[],
  path: ListPath,
  index: number,
  step: WorkflowStep,
): WorkflowStep[] {
  return mapList(steps, path, (list) => {
    const at = Math.max(0, Math.min(index, list.length));
    return [...list.slice(0, at), step, ...list.slice(at)];
  });
}

export function removeStep(
  steps: readonly WorkflowStep[],
  path: ListPath,
  index: number,
): WorkflowStep[] {
  return mapList(steps, path, (list) => list.filter((_, i) => i !== index));
}

export function replaceStep(
  steps: readonly WorkflowStep[],
  path: ListPath,
  index: number,
  next: WorkflowStep,
): WorkflowStep[] {
  return mapList(steps, path, (list) =>
    list.map((step, i) => (i === index ? next : step)),
  );
}

/**
 * Move a step within its own list.
 *
 * ⚠️ Deliberately does NOT move a step between lists. Dragging a step
 * out of a loop body and into the top level changes what its bindings
 * mean — `item` stops existing — and doing that silently produces a
 * definition that validates and then fails at run time. Moving between
 * levels is a remove and an add, which the author does on purpose.
 */
export function moveStep(
  steps: readonly WorkflowStep[],
  path: ListPath,
  index: number,
  delta: number,
): WorkflowStep[] {
  return mapList(steps, path, (list) => {
    const target = index + delta;
    if (index < 0 || index >= list.length) return list;
    if (target < 0 || target >= list.length) return list;
    const next = [...list];
    const [moved] = next.splice(index, 1);
    if (!moved) return list;
    next.splice(target, 0, moved);
    return next;
  });
}

/* ------------------------------------------------------------------ */
/* MEASURING — WHAT THE LIMIT METER READS                              */
/* ------------------------------------------------------------------ */

/** Every step in the tree, including the ones inside branches and loops. */
export function flattenSteps(steps: readonly WorkflowStep[]): WorkflowStep[] {
  const out: WorkflowStep[] = [];
  const walk = (list: readonly WorkflowStep[], depth: number): void => {
    if (depth > 32) return;
    for (const step of list) {
      out.push(step);
      if (step.action === "if_else") {
        walk(step.then ?? [], depth + 1);
        walk(step.otherwise ?? [], depth + 1);
      } else if (step.action === "iterator") {
        walk(step.body ?? [], depth + 1);
      }
    }
  };
  walk(steps, 1);
  return out;
}

export function countSteps(steps: readonly WorkflowStep[]): number {
  return flattenSteps(steps).length;
}

/**
 * The deepest nesting level in use, counted the way `validation.ts`
 * counts it: a flat list is 1, a step inside a branch is 2.
 *
 * The two must agree, because this number is what the meter shows and
 * that number is what refuses the publish.
 */
export function definitionDepth(steps: readonly WorkflowStep[]): number {
  if (steps.length === 0) return 0;
  let deepest = 1;
  for (const step of steps) {
    if (step.action === "if_else") {
      const inner = Math.max(
        definitionDepth(step.then ?? []),
        definitionDepth(step.otherwise ?? []),
      );
      if (inner > 0) deepest = Math.max(deepest, 1 + inner);
    } else if (step.action === "iterator") {
      const inner = definitionDepth(step.body ?? []);
      if (inner > 0) deepest = Math.max(deepest, 1 + inner);
    }
  }
  return deepest;
}

/** The nesting level a NEW step would occupy at `path`. */
export function depthOf(path: ListPath): number {
  return path.length + 1;
}

export function collectKeys(steps: readonly WorkflowStep[]): string[] {
  return flattenSteps(steps).map((step) => step.key);
}

/* ------------------------------------------------------------------ */
/* NEW STEPS                                                           */
/* ------------------------------------------------------------------ */

/**
 * A key that is free, readable and derived from the action.
 *
 * ⚠️ Run history is keyed by the step key, so it is generated once and
 * then left alone — the author may rename it, and the builder warns that
 * renaming detaches the step from its own past executions.
 */
export function suggestKey(
  action: WorkflowActionType,
  taken: readonly string[],
): string {
  const base = action;
  if (!taken.includes(base)) return base;
  for (let n = 2; n < 500; n += 1) {
    const candidate = `${base}_${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
  return `${base}_${Date.now().toString(36)}`;
}

/**
 * A blank step of the requested action.
 *
 * ⚠️ EVERY DEFAULT HERE IS EITHER VALID OR OBVIOUSLY EMPTY. What it must
 * never be is *silently* wrong: a `filter` created with an empty
 * condition group is refused at publish and says so, which is correct. A
 * `filter` created with a condition that happens to pass everything
 * would look finished and do nothing.
 */
export function createStep(action: WorkflowActionType, key: string): WorkflowStep {
  switch (action) {
    case "create_record":
      return { key, action, recordType: "lead", values: {} };
    case "update_record":
      return {
        key,
        action,
        recordType: "lead",
        recordId: "{{ trigger.record.id }}",
        values: {},
      };
    case "delete_record":
      return { key, action, recordType: "lead", recordId: "{{ trigger.record.id }}" };
    case "find_records":
      return { key, action, recordType: "lead", limit: 50 };
    case "send_email":
      return { key, action, to: "", subject: "", body: "" };
    case "http_request":
      return { key, action, method: "POST", url: "" };
    case "filter":
      return { key, action, conditions: { match: "all", conditions: [] } };
    case "if_else":
      return {
        key,
        action,
        conditions: { match: "all", conditions: [] },
        then: [],
        otherwise: [],
      };
    case "iterator":
      return {
        key,
        action,
        source: "",
        itemAlias: "item",
        maxIterations: MAX_ITERATIONS_PER_LOOP,
        body: [],
      };
    case "delay":
      return { key, action, seconds: 3600 };
    case "form":
      return {
        key,
        action,
        title: "",
        dueInHours: DEFAULT_FORM_DUE_HOURS,
        onReject: "stop",
      };
  }
}

/** The catalogue label, never a second hardcoded list. */
export function actionLabel(action: WorkflowActionType): string {
  return ACTION_CATALOG[action].label;
}

/* ------------------------------------------------------------------ */
/* ⭐ VARIABLE BINDING                                                  */
/* ------------------------------------------------------------------ */

export type BindingSuggestion = {
  /** The path as it is written inside `{{ }}`. */
  path: string;
  label: string;
  /** Where it comes from, so the list can be grouped. */
  group: "Trigger" | "Loop" | "Earlier steps";
};

/**
 * What a step at this position may legitimately reference.
 *
 * ⚠️ ONLY WHAT IS ALREADY IN SCOPE. A binding to a step that runs LATER
 * resolves to nothing at run time, and an editor that offers it is
 * inviting a workflow that emails an empty string to a buyer. So the
 * list is built from the steps that precede this one in its own list,
 * plus the steps that precede each of its ancestors — which is exactly
 * what the run context will hold when it executes.
 *
 * Loop aliases come from the enclosing iterators, innermost last.
 */
export function bindingSuggestions(args: {
  steps: readonly WorkflowStep[];
  path: ListPath;
  index: number;
  triggerType: WorkflowTriggerType;
  triggerConfig: TriggerConfig;
}): BindingSuggestion[] {
  const out: BindingSuggestion[] = [
    { path: "trigger.type", label: "Which trigger fired", group: "Trigger" },
    { path: "trigger.firedAt", label: "When it fired", group: "Trigger" },
  ];

  const recordScoped =
    args.triggerType === "record_created" ||
    args.triggerType === "record_updated" ||
    args.triggerType === "record_deleted";

  if (recordScoped) {
    const definition =
      args.triggerConfig.recordType &&
      (RECORD_TYPE_KEYS as readonly string[]).includes(args.triggerConfig.recordType)
        ? RECORD_TYPES[args.triggerConfig.recordType as keyof typeof RECORD_TYPES]
        : null;

    out.push({
      path: "trigger.record.id",
      label: "The record that triggered this",
      group: "Trigger",
    });
    for (const column of definition?.readableColumns ?? []) {
      if (column === "id") continue;
      out.push({
        path: `trigger.record.${column}`,
        label: `${definition?.label ?? "Record"} — ${column}`,
        group: "Trigger",
      });
    }
    if (args.triggerType === "record_updated") {
      out.push({
        path: "trigger.changedFields",
        label: "Fields this update changed",
        group: "Trigger",
      });
    }
  }

  if (args.triggerType === "manual" || args.triggerType === "webhook") {
    out.push({
      path: "trigger.input",
      label: args.triggerType === "webhook" ? "The webhook payload" : "Caller input",
      group: "Trigger",
    });
  }

  /* --- Walk down the path, collecting what is in scope --------------- */
  let list = args.steps as WorkflowStep[];
  const inScope: WorkflowStep[] = [];

  for (const segment of args.path) {
    for (let i = 0; i < segment.index; i += 1) {
      const sibling = list[i];
      if (sibling) inScope.push(sibling);
    }
    const parent = list[segment.index];
    if (parent?.action === "iterator") {
      // ⚠️ The alias is bound at the ROOT of the run context, not under
      // `item` — see `scopeFor` in `planner.ts`. `item` always means the
      // innermost loop, which is why both are offered: an outer loop is
      // only reachable by its alias once an inner one exists.
      const alias = parent.itemAlias?.trim() || "item";
      out.push({
        path: alias,
        label: `The current item of "${parent.key}"`,
        group: "Loop",
      });
      out.push({ path: "item", label: "The innermost loop's current item", group: "Loop" });
      out.push({ path: "index", label: "The innermost loop's position", group: "Loop" });
    }
    const next = childList(parent, segment.slot);
    if (!next) break;
    list = next;
  }

  for (let i = 0; i < args.index; i += 1) {
    const sibling = list[i];
    if (sibling) inScope.push(sibling);
  }

  for (const step of inScope) {
    switch (step.action) {
      case "find_records":
        out.push({
          path: `steps.${step.key}.records`,
          label: `${step.key} — the records found`,
          group: "Earlier steps",
        });
        out.push({
          path: `steps.${step.key}.count`,
          label: `${step.key} — how many were found`,
          group: "Earlier steps",
        });
        break;
      case "create_record":
      case "update_record":
      case "delete_record":
        out.push({
          path: `steps.${step.key}.id`,
          label: `${step.key} — the record's id`,
          group: "Earlier steps",
        });
        break;
      case "http_request":
        out.push({
          path: `steps.${step.key}.status`,
          label: `${step.key} — the HTTP status`,
          group: "Earlier steps",
        });
        out.push({
          path: `steps.${step.key}.body`,
          label: `${step.key} — the response body`,
          group: "Earlier steps",
        });
        break;
      case "send_email":
        out.push({
          path: `steps.${step.key}.sent`,
          label: `${step.key} — whether it sent`,
          group: "Earlier steps",
        });
        break;
      default:
        break;
    }
  }

  /* De-duplicate, keeping the first (most specific) label. */
  const seen = new Set<string>();
  return out.filter((entry) => {
    if (seen.has(entry.path)) return false;
    seen.add(entry.path);
    return true;
  });
}

/** Wrap a path the way the engine expects to read it. */
export function asBinding(path: string): string {
  return `{{ ${path} }}`;
}

/* ------------------------------------------------------------------ */
/* WHAT A DEFINITION WILL NEED                                         */
/* ------------------------------------------------------------------ */

/**
 * Every permission this definition will need at run time.
 *
 * ⚠️ ADVISORY, AND SAYS SO WHERE IT IS RENDERED. The authoritative check
 * is `requiredPermissionsFor` in `server/workflows/definitions.ts`, which
 * runs at publish against the publisher's live role and overrides and
 * names anything missing. That module is `server-only` — it reaches the
 * database — so it cannot be imported here.
 *
 * What stops the two drifting is that both are built from the SAME two
 * pure catalogues: `permissionsRequiredBy` for the action, and
 * `permissionForRecordAction` for the record type. Neither list is
 * repeated in this file. If a new action gains a permission, both learn
 * about it from `ACTION_CATALOG`.
 */
export function requiredPermissionsFor(steps: readonly WorkflowStep[]): string[] {
  const all = flattenSteps(steps);
  const required = new Set<string>(permissionsRequiredBy(all.map((s) => s.action)));

  for (const step of all) {
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
