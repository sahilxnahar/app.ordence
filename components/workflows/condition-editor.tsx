"use client";

/**
 * Ordence — Condition Editor
 * Version: v0.24.0-alpha
 *
 * Edits a `WorkflowConditionGroup` — the shape `filter`, `if_else`,
 * `find_records` and the trigger all share.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ "ALL" AND "ANY" HAVE NO DEFAULT, HERE EITHER
 * ══════════════════════════════════════════════════════════════════════
 * `program.ts` refuses to default `match`, and the reason is worth
 * repeating in the UI: "all of these" and "any of these" are opposite
 * instructions. A builder that quietly starts on one of them means an
 * author who never looked at the control has had the choice made for
 * them — and the workflow fires on records it was written to skip, while
 * appearing to work.
 *
 * The control is therefore always visible, always in a labelled
 * `<select>`, and reads as a sentence: "Continue when ALL of these are
 * true."
 *
 * ⚠️ THREE OPERATORS TAKE NO VALUE. `is_empty`, `is_not_empty` and
 * `changed` are complete on their own; the value box disappears rather
 * than sitting there inviting an entry that would be ignored. `changed`
 * additionally only means anything on an update trigger, which the
 * caller says by passing `allowChanged`.
 */

import { useId } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CONDITION_OPERATORS } from "@/lib/workflows/program";
import type {
  ConditionOperator,
  WorkflowCondition,
  WorkflowConditionGroup,
} from "@/lib/workflows/program";
import { BindingInput } from "./binding-field";
import type { BindingSuggestion } from "./step-tree";

const OPERATOR_LABELS: Record<ConditionOperator, string> = {
  eq: "is",
  neq: "is not",
  gt: "is greater than",
  gte: "is at least",
  lt: "is less than",
  lte: "is at most",
  contains: "contains",
  not_contains: "does not contain",
  in: "is one of (comma separated)",
  is_empty: "is empty",
  is_not_empty: "is not empty",
  changed: "was changed by this update",
};

const VALUELESS: readonly ConditionOperator[] = ["is_empty", "is_not_empty", "changed"];

export function operatorTakesValue(operator: ConditionOperator): boolean {
  return !VALUELESS.includes(operator);
}

export type ConditionEditorProps = {
  group: WorkflowConditionGroup;
  onChange: (group: WorkflowConditionGroup) => void;
  suggestions: readonly BindingSuggestion[];
  /** `changed` is only meaningful on a `record_updated` trigger. */
  allowChanged?: boolean;
  /** The sentence the group completes, e.g. "Continue when". */
  lead?: string;
  emptyHint?: string;
};

export function ConditionEditor({
  group,
  onChange,
  suggestions,
  allowChanged = false,
  lead = "Continue when",
  emptyHint,
}: ConditionEditorProps) {
  const matchId = useId();

  const operators = CONDITION_OPERATORS.filter(
    (operator) => allowChanged || operator !== "changed",
  );

  const setCondition = (index: number, next: WorkflowCondition) => {
    onChange({
      ...group,
      conditions: group.conditions.map((c, i) => (i === index ? next : c)),
    });
  };

  return (
    <fieldset className="rounded-md border border-border p-2.5">
      <legend className="px-1 text-xs font-medium text-muted-foreground">
        Conditions
      </legend>

      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <span>{lead}</span>
        <label htmlFor={matchId} className="sr-only">
          Must all conditions match, or any of them?
        </label>
        <select
          id={matchId}
          value={group.match}
          onChange={(event) =>
            onChange({ ...group, match: event.target.value as "all" | "any" })
          }
          className="h-8 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="all">ALL of these</option>
          <option value="any">ANY of these</option>
        </select>
        <span>are true.</span>
      </div>

      {group.conditions.length === 0 ? (
        <p className="mt-2 text-[11px] text-amber-700">
          {emptyHint ??
            "No conditions yet. A condition group with nothing in it passes everything, " +
              "which reads like a safety check and is not one."}
        </p>
      ) : null}

      <ol className="mt-2 space-y-2">
        {group.conditions.map((condition, index) => (
          <li key={index} className="rounded border border-border bg-muted/20 p-2">
            <div className="flex items-start justify-between gap-2">
              <p className="text-[11px] font-medium text-muted-foreground">
                Condition {index + 1}
              </p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-[11px]"
                onClick={() =>
                  onChange({
                    ...group,
                    conditions: group.conditions.filter((_, i) => i !== index),
                  })
                }
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                <span className="sr-only">Remove condition {index + 1}</span>
                Remove
              </Button>
            </div>

            <div className="mt-1.5 grid gap-2 md:grid-cols-[1fr_auto_1fr]">
              <BindingInput
                label={`Condition ${index + 1} — value to check`}
                value={condition.path}
                onChange={(path) => setCondition(index, { ...condition, path })}
                suggestions={suggestions}
                placeholder="trigger.record.status"
                description="A path into the run, written WITHOUT the braces."
              />

              <div>
                <label
                  htmlFor={`${matchId}-op-${index}`}
                  className="mb-1 block text-xs font-medium"
                >
                  Comparison
                </label>
                <select
                  id={`${matchId}-op-${index}`}
                  value={condition.operator}
                  onChange={(event) => {
                    const operator = event.target.value as ConditionOperator;
                    const next: WorkflowCondition = { ...condition, operator };
                    if (!operatorTakesValue(operator)) delete next.value;
                    setCondition(index, next);
                  }}
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:w-48"
                >
                  {operators.map((operator) => (
                    <option key={operator} value={operator}>
                      {OPERATOR_LABELS[operator]}
                    </option>
                  ))}
                </select>
              </div>

              {operatorTakesValue(condition.operator) ? (
                <div>
                  <label
                    htmlFor={`${matchId}-val-${index}`}
                    className="mb-1 block text-xs font-medium"
                  >
                    Compared with
                  </label>
                  <Input
                    id={`${matchId}-val-${index}`}
                    value={stringifyValue(condition.value)}
                    onChange={(event) =>
                      setCondition(index, {
                        ...condition,
                        value: parseValue(event.target.value),
                      })
                    }
                    placeholder="hot"
                  />
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Numbers and true/false are read as such; everything else is text.
                  </p>
                </div>
              ) : (
                <p className="self-end text-[11px] text-muted-foreground">
                  This comparison needs nothing to compare against.
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-2 h-8"
        onClick={() =>
          onChange({
            ...group,
            conditions: [...group.conditions, { path: "", operator: "eq", value: "" }],
          })
        }
      >
        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
        Add a condition
      </Button>
    </fieldset>
  );
}

/* ------------------------------------------------------------------ */
/* VALUES                                                              */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ A TEXT BOX PRODUCES A STRING, AND `score > "5"` IS NOT `score > 5`.
 *
 * `evaluateCondition` compares numbers numerically and everything else as
 * text, so a numeric threshold typed into a text box would silently
 * become a string comparison — under which "10" is less than "9". The
 * coercion is done once, here, on the way in.
 */
export function parseValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return raw;
}

export function stringifyValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}
