/**
 * Ordence — Filter Tree Surgery
 * Version: v0.28.0-alpha
 *
 * Pure. No React, no DOM, no server. Everything the filter editor does to
 * a tree — add, remove, reorder, retype a condition — happens here, and
 * the editor is left holding nothing but `useState` and JSX.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THE TREE SURGERY IS A SEPARATE, TESTABLE FILE
 * ══════════════════════════════════════════════════════════════════════
 * The same split `components/workflows/step-tree.ts` made for Phase 23,
 * for the same reason: the bug in a nested editor is never in the markup.
 * It is in "remove the third child of the second group" writing to the
 * wrong index, or in a reorder that mutates the array the previous render
 * is still holding. Neither needs a DOM to catch, and neither is caught by
 * a test that clicks buttons.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE LIMITS ARE ENFORCED HERE, IN THE BROWSER, AND SAID OUT LOUD
 * ══════════════════════════════════════════════════════════════════════
 * `MAX_FILTER_DEPTH` and `MAX_FILTER_NODES` are already enforced twice on
 * the server — `lib/views/validation.ts` at save time, `lib/views/planner.ts`
 * at replay time — and this is a third copy that protects nobody.
 *
 * It is not a security control and it is not pretending to be one. It
 * exists because the alternative is a person who spends four minutes
 * building a sixty-first condition and is then told, on Save, that the
 * whole thing is refused. A cap that is invisible until you hit it is a
 * cap that reads as a bug. So the buttons go disabled AT the limit and
 * the reason is on the screen next to them.
 *
 * ⚠️ AND THE SERVER STILL CHECKS. Nothing here is load-bearing. A browser
 * that posts a 400-deep tree gets the planner's refusal, exactly as it
 * would have before this file existed.
 */

import { MAX_FILTER_DEPTH, MAX_FILTER_NODES } from "@/lib/views/limits";
import { OPERATORS, operatorsForKind } from "@/lib/views/operators";
import {
  isFilterGroup,
  type FieldKind,
  type FilterCondition,
  type FilterGroup,
  type FilterNode,
  type FilterOperator,
} from "@/lib/views/types";

/**
 * Where a node sits: the child index at each level, from the root group
 * down. `[]` is the root itself; `[1, 0]` is the first child of the
 * second child of the root.
 *
 * ⚠️ AN INDEX PATH RATHER THAN AN ID. A filter tree as stored has no node
 * identifiers — it is plain jsonb a customer's browser wrote months ago —
 * and minting ids on load would mean either persisting them (a schema
 * change for a UI concern) or regenerating them on every render (which is
 * how a React key ends up changing under a focused input).
 */
export type NodePath = readonly number[];

/* ------------------------------------------------------------------ */
/* MEASURING                                                           */
/* ------------------------------------------------------------------ */

/**
 * Groups AND conditions, counted together — the same arithmetic
 * `lib/views/limits.ts` explains and `lib/views/validation.ts` performs.
 * Counting only conditions is defeated by ten thousand empty groups.
 */
export function countNodes(node: FilterNode): number {
  if (!isFilterGroup(node)) return 1;
  let total = 1;
  for (const child of node.children) total += countNodes(child);
  return total;
}

/** How deep the group nesting goes. The root group is depth 1. */
export function treeDepth(node: FilterNode): number {
  if (!isFilterGroup(node)) return 0;
  let deepest = 1;
  for (const child of node.children) {
    if (isFilterGroup(child)) deepest = Math.max(deepest, 1 + treeDepth(child));
  }
  return deepest;
}

/** The depth of the group at `path`. The root (`[]`) is depth 1. */
export function depthAt(path: NodePath): number {
  return path.length + 1;
}

/* ------------------------------------------------------------------ */
/* READING                                                             */
/* ------------------------------------------------------------------ */

export function nodeAt(root: FilterNode, path: NodePath): FilterNode | null {
  let current: FilterNode = root;
  for (const index of path) {
    if (!isFilterGroup(current)) return null;
    const child = current.children[index];
    if (!child) return null;
    current = child;
  }
  return current;
}

export function groupAt(root: FilterGroup, path: NodePath): FilterGroup | null {
  const node = nodeAt(root, path);
  return node && isFilterGroup(node) ? node : null;
}

/* ------------------------------------------------------------------ */
/* WRITING — EVERY ONE OF THESE RETURNS A NEW TREE                     */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ NOTHING IN THIS FILE MUTATES. Every helper rebuilds the spine from
 * the root down to the node it touched and shares the rest.
 *
 * React 19's `useOptimistic` and `useState` both compare by reference. A
 * `children.splice()` on the array the current render is holding produces
 * an editor that updates on the NEXT keystroke rather than this one —
 * which presents as "the remove button needs two clicks" and is diagnosed
 * as an event-handler problem for an afternoon.
 */
function transform(
  node: FilterNode,
  path: NodePath,
  fn: (node: FilterNode) => FilterNode | null,
): FilterNode | null {
  if (path.length === 0) return fn(node);
  if (!isFilterGroup(node)) return node;

  const index = path[0]!;
  const child = node.children[index];
  if (!child) return node;

  const replacement = transform(child, path.slice(1), fn);
  const children = node.children.slice();
  if (replacement === null) children.splice(index, 1);
  else children[index] = replacement;

  return { ...node, children };
}

function asRoot(node: FilterNode | null, fallback: FilterGroup): FilterGroup {
  return node && isFilterGroup(node) ? node : fallback;
}

/** Replace one node wholesale. */
export function replaceAt(
  root: FilterGroup,
  path: NodePath,
  next: FilterNode,
): FilterGroup {
  return asRoot(transform(root, path, () => next), root);
}

/**
 * Remove one node.
 *
 * ⚠️ THE ROOT IS NOT REMOVABLE. A filter with no root group is not an
 * empty filter, it is a malformed one, and `emptyFilter()` is what "no
 * conditions" looks like.
 */
export function removeAt(root: FilterGroup, path: NodePath): FilterGroup {
  if (path.length === 0) return root;
  return asRoot(transform(root, path, () => null), root);
}

/** Append a child to the group at `path`. */
export function insertInto(
  root: FilterGroup,
  path: NodePath,
  child: FilterNode,
): FilterGroup {
  return asRoot(
    transform(root, path, (node) =>
      isFilterGroup(node) ? { ...node, children: [...node.children, child] } : node,
    ),
    root,
  );
}

/**
 * Move one child up or down within its group.
 *
 * ⭐ THIS IS THE KEYBOARD REORDERING PATH AND IT IS THE ONLY ONE. There is
 * no drag-and-drop in the filter editor: a nested tree is the single
 * hardest thing to drag correctly, and an editor that can only be
 * rearranged with a mouse is an editor a screen-reader user cannot
 * rearrange at all.
 */
export function moveChild(
  root: FilterGroup,
  groupPath: NodePath,
  index: number,
  delta: -1 | 1,
): FilterGroup {
  return asRoot(
    transform(root, groupPath, (node) => {
      if (!isFilterGroup(node)) return node;
      const target = index + delta;
      if (index < 0 || index >= node.children.length) return node;
      if (target < 0 || target >= node.children.length) return node;
      const children = node.children.slice();
      const [moved] = children.splice(index, 1);
      children.splice(target, 0, moved!);
      return { ...node, children };
    }),
    root,
  );
}

/* ------------------------------------------------------------------ */
/* THE BUDGET                                                          */
/* ------------------------------------------------------------------ */

export type BudgetVerdict =
  | { allowed: true }
  /** ⚠️ Always carries a sentence. A disabled button with no reason is a bug report. */
  | { allowed: false; reason: string };

const ALLOWED: BudgetVerdict = { allowed: true };

/** May one more node — of any kind — be added anywhere in this tree? */
export function canAddNode(root: FilterGroup): BudgetVerdict {
  if (countNodes(root) >= MAX_FILTER_NODES) {
    return {
      allowed: false,
      reason:
        `A filter may hold at most ${MAX_FILTER_NODES} conditions and groups ` +
        `together. Save this as one view and build a second for the rest — a ` +
        `filter this large is also one nobody can read.`,
    };
  }
  return ALLOWED;
}

/** May a NEW GROUP be nested inside the group at `path`? */
export function canNestGroupAt(root: FilterGroup, path: NodePath): BudgetVerdict {
  const budget = canAddNode(root);
  if (!budget.allowed) return budget;

  if (depthAt(path) + 1 > MAX_FILTER_DEPTH) {
    return {
      allowed: false,
      reason:
        `Groups may not nest more than ${MAX_FILTER_DEPTH} deep. Nothing past ` +
        `that changes which records match in a way anybody can predict.`,
    };
  }
  return ALLOWED;
}

/* ------------------------------------------------------------------ */
/* MAKING NEW NODES                                                    */
/* ------------------------------------------------------------------ */

export function newGroup(match: "all" | "any" = "all"): FilterGroup {
  return { type: "group", match, children: [] };
}

/**
 * The first operator this system will accept for a field of this kind.
 *
 * ⚠️ READ OUT OF THE CATALOGUE RATHER THAN HARD-CODED TO `eq`. `eq` is not
 * applicable to a boolean — the catalogue offers `is_true`/`is_false`
 * instead, for the tri-state reason given in `lib/views/types.ts` — so a
 * hard-coded default would seed every new boolean condition with a
 * combination the server refuses.
 */
export function defaultOperatorFor(kind: FieldKind): FilterOperator | null {
  return operatorsForKind(kind)[0] ?? null;
}

/**
 * A blank operand of the right shape for a field.
 *
 * ⚠️ NOT `null` FOR EVERYTHING. `coerceOperand` refuses `null` for every
 * kind, so a freshly added condition would open showing an error the
 * author has not made yet. An empty string is the thing a text box
 * contains before anybody types, and for an enum the first allowed value
 * is a real, valid choice rather than a guess.
 */
export function blankOperand(field: {
  kind: FieldKind;
  enumValues: readonly string[] | null;
}): unknown {
  if (field.kind === "enum") return field.enumValues?.[0] ?? "";
  return "";
}

/** A condition seeded so that it is valid the moment it appears. */
export function newCondition(field: {
  name: string;
  kind: FieldKind;
  enumValues: readonly string[] | null;
}): FilterCondition {
  const operator = defaultOperatorFor(field.kind);
  if (!operator) {
    // Only reachable for `json`, which the field picker never offers.
    return { type: "condition", field: field.name, operator: "is_empty" };
  }
  return withOperand({ type: "condition", field: field.name, operator }, field);
}

/**
 * Re-shape a condition's operand list to match its operator's arity.
 *
 * ⚠️ CALLED ON EVERY OPERATOR CHANGE, AND THIS IS THE BUG IT PREVENTS.
 * Switching `eq` → `between` leaves a `value` behind and no `values`, so
 * the server refuses with "give a start and an end" while the form still
 * shows the number the author typed. Switching `in` → `eq` leaves a
 * `values` array that the planner ignores, so a filter that reads as
 * "any of three" quietly matches on one.
 */
export function withOperand(
  condition: FilterCondition,
  field: { kind: FieldKind; enumValues: readonly string[] | null },
): FilterCondition {
  const arity = OPERATORS[condition.operator]?.arity ?? "none";
  const blank = blankOperand(field);

  switch (arity) {
    case "none":
      return { type: "condition", field: condition.field, operator: condition.operator };

    case "one":
      return {
        type: "condition",
        field: condition.field,
        operator: condition.operator,
        value: condition.value ?? condition.values?.[0] ?? blank,
      };

    case "two": {
      const existing = Array.isArray(condition.values) ? condition.values : [];
      return {
        type: "condition",
        field: condition.field,
        operator: condition.operator,
        values: [existing[0] ?? condition.value ?? blank, existing[1] ?? blank],
      };
    }

    case "many": {
      const existing = Array.isArray(condition.values) ? condition.values : [];
      const seed = existing.length > 0 ? existing : [condition.value ?? blank];
      return {
        type: "condition",
        field: condition.field,
        operator: condition.operator,
        values: seed,
      };
    }
  }
}

/**
 * Point a condition at a different field.
 *
 * ⚠️ THE OPERATOR IS KEPT ONLY IF IT STILL APPLIES. Moving a condition
 * from `name contains "sharma"` to `owner_id` must not leave `contains`
 * in place: `contains` on a uuid is refused by the catalogue for the
 * oracle reason in its header, and leaving it selected produces a form
 * that looks fine and a save that fails.
 */
export function retarget(
  condition: FilterCondition,
  field: { name: string; kind: FieldKind; enumValues: readonly string[] | null },
): FilterCondition {
  const stillApplies =
    OPERATORS[condition.operator]?.kinds.includes(field.kind) ?? false;

  const operator = stillApplies
    ? condition.operator
    : (defaultOperatorFor(field.kind) ?? "is_empty");

  return withOperand(
    {
      type: "condition",
      field: field.name,
      operator,
      // ⚠️ Spread field-by-field rather than `...condition`. A blanket
      // spread would put the OLD field name and the OLD operator back on
      // top of the two lines above it — a retarget that silently does
      // nothing, which is the kind of bug a reviewer reads straight past.
      ...(stillApplies ? { value: condition.value, values: condition.values } : {}),
    },
    field,
  );
}
