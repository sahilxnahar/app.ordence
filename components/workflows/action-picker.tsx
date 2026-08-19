"use client";

/**
 * Ordence — The Action Picker
 * Version: v0.24.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE LIST IS READ FROM THE ENGINE. THERE IS NO SECOND LIST.
 * ══════════════════════════════════════════════════════════════════════
 * Every option below is generated from `ACTION_TYPES` and labelled from
 * `ACTION_CATALOG` — the same two exports the validator, the planner and
 * the Postgres enum are built from.
 *
 * The alternative — a nice hand-written array of `{ value, label }` in
 * this file — is what every builder UI starts as, and it drifts on the
 * first Monday somebody adds an action to the engine and forgets the
 * picker, or removes one from the engine and leaves the picker offering
 * it. The second failure is the expensive one: the author builds a
 * workflow around an action that no longer exists, and finds out when
 * the save is refused.
 *
 * ⚠️ `run_code` IS NOT HERE BECAUSE IT IS NOT IN THE ENGINE. It is not
 * hidden, disabled or feature-flagged — the product does not have it, and
 * a picker that cannot invent options is how the UI says so honestly.
 *
 * The nesting actions stay VISIBLE but DISABLED at the depth limit,
 * rather than disappearing. An option that vanishes reads as a bug; an
 * option that explains why it cannot be used reads as a rule.
 */

import { useId, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ACTION_CATALOG } from "@/lib/workflows/actions";
import { ACTION_TYPES } from "@/lib/workflows/program";
import type { WorkflowActionType } from "@/lib/workflows/program";

export type ActionPickerProps = {
  /** Called with the chosen action. The caller creates the step. */
  onAdd: (action: WorkflowActionType) => void;
  /**
   * Actions that cannot be added HERE, with the reason. Rendered as
   * disabled options carrying the reason in their label.
   */
  unavailable?: Partial<Record<WorkflowActionType, string>>;
  /** Distinguishes the picker in a nested list from the one above it. */
  label?: string;
  disabled?: boolean;
};

const EFFECT_ACTIONS = ACTION_TYPES.filter((a) => ACTION_CATALOG[a].kind === "effect");
const CONTROL_ACTIONS = ACTION_TYPES.filter((a) => ACTION_CATALOG[a].kind === "control");

export function ActionPicker({
  onAdd,
  unavailable = {},
  label = "Add a step",
  disabled = false,
}: ActionPickerProps) {
  const selectId = useId();
  const describedBy = `${selectId}-description`;
  const [action, setAction] = useState<WorkflowActionType>(ACTION_TYPES[0]);

  const definition = ACTION_CATALOG[action];
  const blockedReason = unavailable[action];

  return (
    <div className="rounded-md border border-dashed border-border bg-muted/20 p-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[15rem] flex-1">
          <label
            htmlFor={selectId}
            className="mb-1 block text-xs font-medium text-muted-foreground"
          >
            {label}
          </label>
          <select
            id={selectId}
            aria-describedby={describedBy}
            value={action}
            disabled={disabled}
            onChange={(event) => setAction(event.target.value as WorkflowActionType)}
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            <optgroup label="Do something">
              {EFFECT_ACTIONS.map((value) => (
                <option key={value} value={value} disabled={Boolean(unavailable[value])}>
                  {ACTION_CATALOG[value].label}
                  {unavailable[value] ? " — not available here" : ""}
                </option>
              ))}
            </optgroup>
            <optgroup label="Control the flow">
              {CONTROL_ACTIONS.map((value) => (
                <option key={value} value={value} disabled={Boolean(unavailable[value])}>
                  {ACTION_CATALOG[value].label}
                  {unavailable[value] ? " — not available here" : ""}
                </option>
              ))}
            </optgroup>
          </select>
        </div>

        <Button
          type="button"
          variant="outline"
          className="h-9"
          disabled={disabled || Boolean(blockedReason)}
          onClick={() => onAdd(action)}
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          Add {definition.label.toLowerCase()}
        </Button>
      </div>

      <p id={describedBy} className="mt-2 text-xs text-muted-foreground">
        {blockedReason ? (
          <span className="text-amber-700">{blockedReason}</span>
        ) : (
          <>
            {definition.description}
            {definition.permission ? (
              <>
                {" "}
                Needs the <code className="font-mono">{definition.permission}</code>{" "}
                permission — and the person who publishes this workflow must hold it
                personally.
              </>
            ) : null}
            {definition.suspends ? " This step pauses the run until it can continue." : ""}
          </>
        )}
      </p>
    </div>
  );
}
