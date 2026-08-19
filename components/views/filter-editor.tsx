"use client";

/**
 * Ordence — The Filter Editor
 * Version: v0.28.0-alpha
 *
 * Nested AND/OR groups over any object in `lib/views/registry.ts`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE THREE PICKERS AND WHERE EACH ONE'S LIST COMES FROM
 * ══════════════════════════════════════════════════════════════════════
 *   FIELD     — `object.fields`, filtered to `filterable`. That list was
 *               derived on the server from Drizzle's schema metadata, so
 *               a column added last week is offered today and a column in
 *               a `hide` list is offered never.
 *
 *   OPERATOR  — `operatorsForKind(field.kind)`, called HERE, from the
 *               pure catalogue in `lib/views/operators.ts`.
 *
 *               ⚠️ NOT from `field.operators` in the payload, even though
 *               the payload carries it. During a rolling deploy the page
 *               HTML and the JavaScript bundle can come from different
 *               builds; deriving the list in the browser from the same
 *               module the planner consults means the editor cannot offer
 *               a comparison this build's server would refuse. It also
 *               makes the rule testable without a server round trip,
 *               which is how it stays true.
 *
 *   VALUE     — typed to `field.kind`. A date gets a date picker, an enum
 *               gets its own values, money gets a note that it is minor
 *               units, a boolean gets no input at all because `is_true`
 *               and `is_false` take none.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ NONE OF THIS IS A SECURITY CONTROL
 * ══════════════════════════════════════════════════════════════════════
 * A browser can post any field name and any operator it likes. What stops
 * `{ field: "tenant_id" }` is `resolveField()` on the server, run again on
 * every single replay of every view — see the header of
 * `lib/views/registry.ts`. This file exists so that a filter which saves
 * is a filter that runs, which is a usability property.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ACCESSIBILITY, WHICH IS NOT OPTIONAL IN A TREE EDITOR
 * ══════════════════════════════════════════════════════════════════════
 *   • Every group is a real `<fieldset>` with a `<legend>`, so a screen
 *     reader announces which group a control belongs to. A tree of
 *     `<div>`s is where that information goes to die.
 *   • Every control has a real, associated `<label>` — several of them
 *     visually hidden, because "Field", "Comparison", "Value" repeated
 *     down forty rows is noise on screen and essential in a list of form
 *     controls.
 *   • Reordering is two buttons, not a drag. See `moveChild` in
 *     `filter-tree.ts`.
 *   • The limits are announced as text next to disabled buttons, never
 *     conveyed by the disabled state alone.
 */

import { useId } from "react";
import { Button } from "@/components/ui/button";
import {
  MAX_FILTER_DEPTH,
  MAX_FILTER_NODES,
  MAX_IN_VALUES,
} from "@/lib/views/limits";
import { OPERATORS, operatorsForKind } from "@/lib/views/operators";
import {
  isFilterGroup,
  type FilterCondition,
  type FilterGroup,
  type FilterNode,
  type FilterOperator,
} from "@/lib/views/types";
import {
  canAddNode,
  canNestGroupAt,
  countNodes,
  depthAt,
  insertInto,
  moveChild,
  newCondition,
  newGroup,
  removeAt,
  replaceAt,
  retarget,
  treeDepth,
  withOperand,
  type NodePath,
} from "./filter-tree";
import type { ViewFieldDescription, ViewObjectDescription } from "./types";

export type FilterEditorProps = {
  object: ViewObjectDescription;
  filter: FilterGroup;
  onChange: (filter: FilterGroup) => void;
  /** Field errors keyed by the validator's dotted path, from the server. */
  problems?: Record<string, string[]>;
};

export function FilterEditor({ object, filter, onChange, problems }: FilterEditorProps) {
  const fields = object.fields.filter((field) => field.filterable);
  const nodes = countNodes(filter);

  return (
    <div className="flex flex-col gap-3">
      <GroupEditor
        object={object}
        fields={fields}
        root={filter}
        path={[]}
        group={filter}
        onChange={onChange}
        problems={problems}
      />

      {/*
        ⚠️ THE BUDGET IS ON SCREEN BEFORE IT BITES, NOT ONLY WHEN IT DOES.
        "58 of 60" tells somebody to stop adding; a button that goes grey
        without warning at 60 tells them the product is broken.
      */}
      <p className="text-xs text-muted-foreground">
        {nodes} of {MAX_FILTER_NODES} conditions and groups used. Groups may nest{" "}
        {MAX_FILTER_DEPTH} deep; this filter is {treeDepth(filter)} deep.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* A GROUP                                                             */
/* ------------------------------------------------------------------ */

type GroupEditorProps = {
  object: ViewObjectDescription;
  fields: ViewFieldDescription[];
  root: FilterGroup;
  path: NodePath;
  group: FilterGroup;
  onChange: (filter: FilterGroup) => void;
  problems?: Record<string, string[]>;
};

function GroupEditor({
  object,
  fields,
  root,
  path,
  group,
  onChange,
  problems,
}: GroupEditorProps) {
  const matchId = useId();
  const noteId = useId();

  const addNode = canAddNode(root);
  const addGroup = canNestGroupAt(root, path);
  const depth = depthAt(path);
  const isRoot = path.length === 0;
  const firstField = fields[0];

  const problemsHere = problemsFor(problems, pathToProblemKey(path));

  return (
    <fieldset
      className={[
        "rounded-lg border border-border p-3",
        isRoot ? "bg-muted/20" : "bg-background",
      ].join(" ")}
    >
      <legend className="px-1 text-xs font-medium text-muted-foreground">
        {isRoot ? "Show records where" : `Nested group (level ${depth})`}
      </legend>

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-sm" htmlFor={matchId}>
          <span>Records must match</span>
          <select
            id={matchId}
            value={group.match}
            onChange={(event) =>
              onChange(
                replaceAt(root, path, {
                  ...group,
                  // ⚠️ Narrowed to the two literals rather than cast. A
                  // `match` of anything else is refused by the planner
                  // with "a filter group must say all or any", and there
                  // is no reason for this control to be able to produce
                  // it.
                  match: event.target.value === "any" ? "any" : "all",
                }),
              )
            }
            className="rounded border border-input bg-background px-2 py-1 text-sm"
          >
            {/*
              ⚠️ NO "please choose" PLACEHOLDER AND NO GUESSED DEFAULT.
              "All" and "any" are opposite instructions — see the note on
              `FilterGroup` in `lib/views/types.ts`. A new group opens on
              "all", which is stated, not implied.
            */}
            <option value="all">all of these</option>
            <option value="any">any of these</option>
          </select>
        </label>

        {!isRoot ? (
          <Button
            type="button"
            variant="ghost"
            className="ml-auto h-8 text-xs text-destructive"
            onClick={() => onChange(removeAt(root, path))}
          >
            Remove this group
          </Button>
        ) : null}
      </div>

      {problemsHere.length > 0 ? (
        <ul className="mt-2 space-y-1" role="alert">
          {problemsHere.map((message) => (
            <li key={message} className="text-xs text-destructive">
              {message}
            </li>
          ))}
        </ul>
      ) : null}

      <ol className="mt-3 flex flex-col gap-2">
        {group.children.map((child, index) => (
          <li key={index} className="flex items-start gap-2">
            {/*
              ⭐ THE KEYBOARD REORDERING. Two buttons per row, disabled at
              the ends of the list. There is deliberately no drag handle:
              a nested tree is the hardest thing in a UI to drag
              correctly, and an editor that can only be rearranged with a
              mouse cannot be rearranged by half the people using it.
            */}
            <div className="flex shrink-0 flex-col gap-0.5 pt-1">
              <Button
                type="button"
                variant="ghost"
                className="h-6 w-6 p-0 text-xs"
                disabled={index === 0}
                onClick={() => onChange(moveChild(root, path, index, -1))}
              >
                <span aria-hidden="true">↑</span>
                <span className="sr-only">Move {describeNode(child)} up</span>
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="h-6 w-6 p-0 text-xs"
                disabled={index === group.children.length - 1}
                onClick={() => onChange(moveChild(root, path, index, 1))}
              >
                <span aria-hidden="true">↓</span>
                <span className="sr-only">Move {describeNode(child)} down</span>
              </Button>
            </div>

            <div className="min-w-0 flex-1">
              {isFilterGroup(child) ? (
                <GroupEditor
                  object={object}
                  fields={fields}
                  root={root}
                  path={[...path, index]}
                  group={child}
                  onChange={onChange}
                  problems={problems}
                />
              ) : (
                <ConditionEditor
                  fields={fields}
                  objectLabel={object.label}
                  root={root}
                  path={[...path, index]}
                  condition={child}
                  onChange={onChange}
                  problems={problems}
                />
              )}
            </div>
          </li>
        ))}

        {group.children.length === 0 ? (
          <li className="rounded border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">
            No conditions in this group, so it does not narrow anything down yet.
          </li>
        ) : null}
      </ol>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          className="h-8 text-xs"
          disabled={!addNode.allowed || !firstField}
          aria-describedby={addNode.allowed ? undefined : noteId}
          onClick={() => {
            if (!firstField) return;
            onChange(insertInto(root, path, newCondition(firstField)));
          }}
        >
          Add condition
        </Button>

        <Button
          type="button"
          variant="outline"
          className="h-8 text-xs"
          disabled={!addGroup.allowed}
          aria-describedby={addGroup.allowed ? undefined : noteId}
          onClick={() => onChange(insertInto(root, path, newGroup("any")))}
        >
          Add group
        </Button>

        {/*
          ⚠️ THE REASON IS TEXT, NOT A TOOLTIP AND NOT THE GREY ITSELF. A
          disabled control whose reason is only conveyed by being disabled
          is a control that reads as broken — and to a screen reader it is
          simply absent from the tab order with no explanation at all.
        */}
        {!addNode.allowed || !addGroup.allowed ? (
          <p id={noteId} className="text-xs text-muted-foreground">
            {!addNode.allowed ? addNode.reason : addGroup.allowed ? "" : addGroup.reason}
          </p>
        ) : null}
      </div>
    </fieldset>
  );
}

/* ------------------------------------------------------------------ */
/* ONE CONDITION                                                       */
/* ------------------------------------------------------------------ */

type ConditionEditorProps = {
  fields: ViewFieldDescription[];
  objectLabel: string;
  root: FilterGroup;
  path: NodePath;
  condition: FilterCondition;
  onChange: (filter: FilterGroup) => void;
  problems?: Record<string, string[]>;
};

function ConditionEditor({
  fields,
  objectLabel,
  root,
  path,
  condition,
  onChange,
  problems,
}: ConditionEditorProps) {
  const fieldId = useId();
  const operatorId = useId();

  const field = fields.find((candidate) => candidate.name === condition.field) ?? null;

  const update = (next: FilterCondition) => onChange(replaceAt(root, path, next));

  const key = pathToProblemKey(path);
  const messages = [
    ...problemsFor(problems, `${key}.field`),
    ...problemsFor(problems, `${key}.operator`),
    ...problemsFor(problems, `${key}.value`),
    ...problemsFor(problems, `${key}.values`),
    ...problemsFor(problems, `${key}.values.0`),
    ...problemsFor(problems, `${key}.values.1`),
  ];

  /*
    ⚠️ A CONDITION NAMING A FIELD THAT NO LONGER EXISTS IS SHOWN, NOT
    DROPPED. The planner refuses to RUN such a filter — dropping it there
    would silently widen the view — so the editor has to make it fixable.
    Hiding the row would leave an author with a view that will not open
    and no control anywhere on screen that explains why.
  */
  if (!field) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2.5">
        <p className="text-xs text-destructive">
          This condition filters on “{String(condition.field)}”, which {objectLabel} no
          longer has. Pick another field or remove the condition — the view will not
          open until you do.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs" htmlFor={fieldId}>
            <span>Field</span>
            <select
              id={fieldId}
              value=""
              onChange={(event) => {
                const replacement = fields.find((f) => f.name === event.target.value);
                if (replacement) update(retarget(condition, replacement));
              }}
              className="rounded border border-input bg-background px-2 py-1 text-xs"
            >
              <option value="">Choose a field…</option>
              {fields.map((candidate) => (
                <option key={candidate.name} value={candidate.name}>
                  {candidate.label}
                </option>
              ))}
            </select>
          </label>
          <Button
            type="button"
            variant="ghost"
            className="h-7 text-xs text-destructive"
            onClick={() => onChange(removeAt(root, path))}
          >
            Remove
          </Button>
        </div>
      </div>
    );
  }

  /* ⭐ The operator list, derived here from the pure catalogue. */
  const operators = operatorsForKind(field.kind);
  const spec = OPERATORS[condition.operator];
  const arity = spec?.arity ?? "none";

  return (
    <div className="rounded-md border border-border bg-background p-2.5">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1" htmlFor={fieldId}>
          <span className="sr-only">Field</span>
          <select
            id={fieldId}
            value={field.name}
            onChange={(event) => {
              const replacement = fields.find((f) => f.name === event.target.value);
              if (replacement) update(retarget(condition, replacement));
            }}
            className="rounded border border-input bg-background px-2 py-1 text-sm"
            aria-label="Field"
          >
            {fields.map((candidate) => (
              <option key={candidate.name} value={candidate.name}>
                {candidate.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1" htmlFor={operatorId}>
          <span className="sr-only">Comparison</span>
          <select
            id={operatorId}
            value={condition.operator}
            onChange={(event) =>
              update(
                withOperand(
                  {
                    ...condition,
                    operator: event.target.value as FilterOperator,
                  },
                  field,
                ),
              )
            }
            className="rounded border border-input bg-background px-2 py-1 text-sm"
            aria-label="Comparison"
          >
            {operators.map((operator) => (
              <option key={operator} value={operator}>
                {OPERATORS[operator].label}
              </option>
            ))}
          </select>
        </label>

        <ValueEditor
          field={field}
          condition={condition}
          arity={arity}
          onChange={update}
        />

        <Button
          type="button"
          variant="ghost"
          className="ml-auto h-8 text-xs text-destructive"
          onClick={() => onChange(removeAt(root, path))}
        >
          <span aria-hidden="true">Remove</span>
          <span className="sr-only">
            Remove the condition on {field.label}
          </span>
        </Button>
      </div>

      {messages.length > 0 ? (
        <ul className="mt-2 space-y-1" role="alert">
          {messages.map((message) => (
            <li key={message} className="text-xs text-destructive">
              {message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* THE OPERAND                                                         */
/* ------------------------------------------------------------------ */

/**
 * The input, typed to the field.
 *
 * ⚠️ THE TYPING IS A CORRECTNESS FEATURE, NOT A POLISH ONE. Every branch
 * below exists because the untyped version produces a filter that saves
 * and then matches the wrong rows:
 *
 *   • `enum` is a `<select>` of the column's own values, so
 *     `status = 'Qualified'` (capital Q) — a filter that never matches
 *     and never errors — cannot be typed.
 *   • `date` is `<input type="date">`, so "last tuesday" cannot be typed.
 *     `coerceOperand` refuses it, but only after the author has saved.
 *   • `money` says MINOR UNITS on the label. Phase 11 stores every amount
 *     in paise; a box that silently accepts "45000" for ₹45,000 filters
 *     on ₹450.
 *   • `boolean` gets no input at all, because `is_true` / `is_false` /
 *     `is_empty` are the only operators it has and none takes an operand.
 */
function ValueEditor({
  field,
  condition,
  arity,
  onChange,
}: {
  field: ViewFieldDescription;
  condition: FilterCondition;
  arity: "none" | "one" | "two" | "many";
  onChange: (next: FilterCondition) => void;
}) {
  if (arity === "none") {
    return (
      <p className="py-1.5 text-xs text-muted-foreground">
        This comparison takes no value.
      </p>
    );
  }

  if (arity === "one") {
    return (
      <SingleValue
        field={field}
        label={`Value for ${field.label}`}
        value={condition.value}
        onChange={(value) => onChange({ ...condition, value })}
      />
    );
  }

  const values = Array.isArray(condition.values) ? condition.values : [];

  if (arity === "two") {
    return (
      <div className="flex flex-wrap items-end gap-2">
        <SingleValue
          field={field}
          label={`Start of the range for ${field.label}`}
          value={values[0]}
          onChange={(value) => onChange({ ...condition, values: [value, values[1] ?? ""] })}
        />
        <span className="pb-2 text-xs text-muted-foreground">and</span>
        <SingleValue
          field={field}
          label={`End of the range for ${field.label}`}
          value={values[1]}
          onChange={(value) => onChange({ ...condition, values: [values[0] ?? "", value] })}
        />
      </div>
    );
  }

  /* --- `in`: one to MAX_IN_VALUES ---------------------------------- */
  return (
    <div className="flex flex-col gap-1.5">
      <ul className="flex flex-wrap items-end gap-2">
        {values.map((value, index) => (
          <li key={index} className="flex items-end gap-1">
            <SingleValue
              field={field}
              label={`Value ${index + 1} for ${field.label}`}
              value={value}
              onChange={(next) => {
                const copy = values.slice();
                copy[index] = next;
                onChange({ ...condition, values: copy });
              }}
            />
            <Button
              type="button"
              variant="ghost"
              className="h-8 w-8 p-0 text-xs"
              disabled={values.length <= 1}
              onClick={() =>
                onChange({
                  ...condition,
                  values: values.filter((_, at) => at !== index),
                })
              }
            >
              <span aria-hidden="true">×</span>
              <span className="sr-only">
                Remove value {index + 1} from {field.label}
              </span>
            </Button>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          className="h-7 text-xs"
          disabled={values.length >= MAX_IN_VALUES}
          onClick={() =>
            onChange({
              ...condition,
              values: [
                ...values,
                field.kind === "enum" ? (field.enumValues?.[0] ?? "") : "",
              ],
            })
          }
        >
          Add another value
        </Button>
        {values.length >= MAX_IN_VALUES ? (
          <span className="text-xs text-muted-foreground">
            At most {MAX_IN_VALUES} values in one “is any of”.
          </span>
        ) : null}
      </div>
    </div>
  );
}

function SingleValue({
  field,
  label,
  value,
  onChange,
}: {
  field: ViewFieldDescription;
  label: string;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const id = useId();
  const text = value === null || value === undefined ? "" : String(value);

  if (field.kind === "enum" && field.enumValues && field.enumValues.length > 0) {
    return (
      <label className="flex flex-col gap-1" htmlFor={id}>
        <span className="sr-only">{label}</span>
        <select
          id={id}
          value={text}
          aria-label={label}
          onChange={(event) => onChange(event.target.value)}
          className="rounded border border-input bg-background px-2 py-1 text-sm"
        >
          {field.enumValues.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (field.kind === "date") {
    return (
      <label className="flex flex-col gap-1" htmlFor={id}>
        <span className="sr-only">{label}</span>
        <input
          id={id}
          type="date"
          aria-label={label}
          value={toDateInputValue(text)}
          onChange={(event) => onChange(event.target.value)}
          className="rounded border border-input bg-background px-2 py-1 text-sm"
        />
      </label>
    );
  }

  const numeric = field.kind === "number" || field.kind === "money";

  return (
    <label className="flex flex-col gap-1" htmlFor={id}>
      <span className="sr-only">{label}</span>
      <input
        id={id}
        type="text"
        aria-label={
          field.kind === "money" ? `${label} — in whole minor units, e.g. paise` : label
        }
        inputMode={numeric ? "numeric" : "text"}
        value={text}
        onChange={(event) => onChange(event.target.value)}
        placeholder={PLACEHOLDERS[field.kind] ?? ""}
        className="rounded border border-input bg-background px-2 py-1 text-sm"
      />
    </label>
  );
}

const PLACEHOLDERS: Record<string, string> = {
  text: "Type a value",
  number: "0",
  // ⚠️ Says paise, because the column is paise. See `inferKind`'s note on
  // the `_minor` suffix in `lib/views/registry.ts`.
  money: "450000000 (paise)",
  uuid: "00000000-0000-0000-0000-000000000000",
};

/* ------------------------------------------------------------------ */
/* PLUMBING                                                            */
/* ------------------------------------------------------------------ */

/**
 * `[0, 2]` → `filter.children.0.children.2`, matching the dotted paths
 * `lib/views/validation.ts` reports problems against.
 *
 * ⚠️ THE TWO MUST AGREE OR EVERY SERVER-SIDE MESSAGE LANDS ON THE WRONG
 * ROW — which is worse than showing none, because the author then "fixes"
 * a condition that was correct.
 */
function pathToProblemKey(path: NodePath): string {
  return ["filter", ...path.flatMap((index) => ["children", String(index)])].join(".");
}

function problemsFor(
  problems: Record<string, string[]> | undefined,
  key: string,
): string[] {
  return problems?.[key] ?? [];
}

function describeNode(node: FilterNode): string {
  return isFilterGroup(node) ? "this group" : `the condition on ${node.field}`;
}

/** `2026-03-05T00:00:00.000Z` and `2026-03-05` both → `2026-03-05`. */
function toDateInputValue(raw: string): string {
  if (raw === "") return "";
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(raw);
  return match ? match[1]! : "";
}
