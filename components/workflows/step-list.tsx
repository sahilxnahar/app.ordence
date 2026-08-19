"use client";

/**
 * Ordence — The Step List
 * Version: v0.24.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS IS A VERTICAL LIST AND NOT A CANVAS
 * ══════════════════════════════════════════════════════════════════════
 * The obvious shape for a workflow builder is a node graph on a pannable
 * canvas. It demos beautifully and it is the wrong tool for this
 * vocabulary. A definition here is a SEQUENCE with two kinds of nesting —
 * a branch and a loop — and it has no joins, no merges and no arbitrary
 * edges. Drawing that as a graph adds a second dimension carrying no
 * information, and takes away the things a list gives for free:
 *
 *   • It is readable top to bottom, which is the order it executes in.
 *   • It is operable with Tab and the arrow keys, with no custom key
 *     handling and no focus management to get wrong.
 *   • It prints, it works at 320px wide, and it works with the browser
 *     zoomed to 200%.
 *   • Nesting is indentation — the same way every programmer on earth
 *     already reads a branch.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ DRAG IS THE FAST PATH. THE BUTTONS ARE THE GUARANTEED ONE.
 * ══════════════════════════════════════════════════════════════════════
 * Same rule as `components/sales/pipeline-board.tsx`: a list that can
 * only be reordered by dragging cannot be reordered by a keyboard, by a
 * screen reader, or by anyone on a phone. So every step carries "Move
 * up" and "Move down" buttons, they are real `<button>`s, and they are
 * the ones the tests exercise.
 *
 * ⚠️ A step never moves BETWEEN lists. Dragging a step out of a loop
 * body changes what its bindings mean — `item` stops existing — and a
 * silent move would produce a definition that validates and fails at run
 * time. Moving levels is a delete and an add, done deliberately.
 */

import { useState } from "react";
import { ArrowDown, ArrowUp, GripVertical, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ACTION_CATALOG } from "@/lib/workflows/actions";
import { MAX_NESTING_DEPTH, MAX_STEPS_PER_DEFINITION } from "@/lib/workflows/limits";
import type {
  TriggerConfig,
  WorkflowActionType,
  WorkflowStep,
  WorkflowTriggerType,
} from "@/lib/workflows/program";
import type { ValidationResult } from "@/lib/workflows/validation";
import { ActionPicker } from "./action-picker";
import { StepConfig } from "./step-config";
import { ProblemList, problemsFor } from "./validation-panel";
import {
  bindingSuggestions,
  collectKeys,
  countSteps,
  createStep,
  depthOf,
  getList,
  insertStep,
  moveStep,
  pathId,
  removeStep,
  replaceStep,
  suggestKey,
  type ListPath,
} from "./step-tree";

export type StepListProps = {
  /** The WHOLE tree. Every edit is expressed against it. */
  steps: WorkflowStep[];
  onChange: (steps: WorkflowStep[]) => void;
  /** Which list inside the tree this renders. Empty = the top level. */
  path: ListPath;
  validation: ValidationResult;
  triggerType: WorkflowTriggerType;
  triggerConfig: TriggerConfig;
  /** True while the version is not a draft — an active version is immutable. */
  readOnly?: boolean;
};

export function StepList({
  steps,
  onChange,
  path,
  validation,
  triggerType,
  triggerConfig,
  readOnly = false,
}: StepListProps) {
  const [dragging, setDragging] = useState<number | null>(null);

  const list = getList(steps, path);
  const total = countSteps(steps);
  const atStepCap = total >= MAX_STEPS_PER_DEFINITION;
  const atDepthCap = depthOf(path) >= MAX_NESTING_DEPTH;

  const unavailable: Partial<Record<WorkflowActionType, string>> = {};
  if (atDepthCap) {
    const reason =
      `Steps may not nest more than ${MAX_NESTING_DEPTH} levels deep, and this ` +
      `list is already at level ${depthOf(path)}. Split this into a second ` +
      `workflow instead.`;
    unavailable.if_else = reason;
    unavailable.iterator = reason;
  }

  const add = (action: WorkflowActionType) => {
    const key = suggestKey(action, collectKeys(steps));
    onChange(insertStep(steps, path, list.length, createStep(action, key)));
  };

  return (
    <div className="space-y-2">
      <ol className="space-y-2">
        {list.map((step, index) => {
          const problems = problemsFor(validation, step.key);
          const definition = ACTION_CATALOG[step.action];
          const suggestions = bindingSuggestions({
            steps,
            path,
            index,
            triggerType,
            triggerConfig,
          });

          return (
            <li
              key={`${pathId(path)}-${index}-${step.key}`}
              draggable={!readOnly}
              onDragStart={(event) => {
                event.dataTransfer.setData("text/plain", String(index));
                event.dataTransfer.effectAllowed = "move";
                setDragging(index);
              }}
              onDragEnd={() => setDragging(null)}
              onDragOver={(event) => {
                if (dragging !== null) event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                const from = Number(event.dataTransfer.getData("text/plain"));
                setDragging(null);
                if (!Number.isInteger(from) || from === index) return;
                onChange(moveStep(steps, path, from, index - from));
              }}
              className={[
                "rounded-lg border border-border bg-card",
                problems.errors.length > 0 ? "border-l-4 border-l-red-600" : "",
                dragging === index ? "opacity-50" : "",
              ].join(" ")}
            >
              <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
                <GripVertical
                  className="h-4 w-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <span className="text-xs tabular-nums text-muted-foreground">
                  {index + 1}.
                </span>
                <span className="text-sm font-semibold">{definition.label}</span>
                <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                  {definition.kind === "control" ? "control" : "effect"}
                </span>
                {problems.errors.length > 0 ? (
                  <span className="rounded border border-red-500/30 bg-red-500/10 px-1.5 py-0.5 text-[10px] font-medium text-red-700">
                    {problems.errors.length} problem
                    {problems.errors.length === 1 ? "" : "s"}
                  </span>
                ) : null}

                <div className="ml-auto flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    disabled={readOnly || index === 0}
                    onClick={() => onChange(moveStep(steps, path, index, -1))}
                    aria-label={`Move step ${index + 1}, ${definition.label}, up`}
                  >
                    <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    disabled={readOnly || index === list.length - 1}
                    onClick={() => onChange(moveStep(steps, path, index, 1))}
                    aria-label={`Move step ${index + 1}, ${definition.label}, down`}
                  >
                    <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0 text-destructive"
                    disabled={readOnly}
                    onClick={() => onChange(removeStep(steps, path, index))}
                    aria-label={`Remove step ${index + 1}, ${definition.label}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                </div>
              </div>

              <div className="space-y-3 p-3">
                <div className="grid gap-2 md:grid-cols-2">
                  <div>
                    <label
                      htmlFor={`${pathId(path)}-${index}-key`}
                      className="mb-1 block text-xs font-medium"
                    >
                      Step key
                    </label>
                    <Input
                      id={`${pathId(path)}-${index}-key`}
                      value={step.key}
                      disabled={readOnly}
                      onChange={(event) =>
                        onChange(
                          replaceStep(steps, path, index, {
                            ...step,
                            key: event.target.value,
                          } as WorkflowStep),
                        )
                      }
                      className="font-mono text-xs"
                      aria-describedby={`${pathId(path)}-${index}-key-help`}
                    />
                    <p
                      id={`${pathId(path)}-${index}-key-help`}
                      className="mt-1 text-[11px] text-muted-foreground"
                    >
                      Lowercase letters, digits and underscores. Run history is keyed
                      by this, so renaming it detaches this step from its own past
                      executions.
                    </p>
                  </div>
                  <div>
                    <label
                      htmlFor={`${pathId(path)}-${index}-label`}
                      className="mb-1 block text-xs font-medium"
                    >
                      Description (optional)
                    </label>
                    <Input
                      id={`${pathId(path)}-${index}-label`}
                      value={step.label ?? ""}
                      disabled={readOnly}
                      onChange={(event) =>
                        onChange(
                          replaceStep(steps, path, index, {
                            ...step,
                            label: event.target.value,
                          } as WorkflowStep),
                        )
                      }
                      placeholder="Email the buyer their payment schedule"
                    />
                  </div>
                </div>

                <fieldset disabled={readOnly} className="space-y-3">
                  <StepConfig
                    step={step}
                    suggestions={suggestions}
                    allowChanged={triggerType === "record_updated"}
                    onChange={(next) => onChange(replaceStep(steps, path, index, next))}
                  />
                </fieldset>

                <ProblemList problems={problems.errors} tone="error" />
                <ProblemList problems={problems.warnings} tone="warning" />

                {/* ------------- NESTING ------------- */}
                {step.action === "if_else" ? (
                  <div className="space-y-2">
                    <Branch
                      title="Then — when the conditions hold"
                      steps={steps}
                      onChange={onChange}
                      path={[...path, { index, slot: "then" }]}
                      validation={validation}
                      triggerType={triggerType}
                      triggerConfig={triggerConfig}
                      readOnly={readOnly}
                    />
                    <Branch
                      title="Otherwise — when they do not"
                      steps={steps}
                      onChange={onChange}
                      path={[...path, { index, slot: "otherwise" }]}
                      validation={validation}
                      triggerType={triggerType}
                      triggerConfig={triggerConfig}
                      readOnly={readOnly}
                    />
                  </div>
                ) : null}

                {step.action === "iterator" ? (
                  <Branch
                    title={`Repeat for each item${step.itemAlias ? ` (as "${step.itemAlias}")` : ""}`}
                    steps={steps}
                    onChange={onChange}
                    path={[...path, { index, slot: "body" }]}
                    validation={validation}
                    triggerType={triggerType}
                    triggerConfig={triggerConfig}
                    readOnly={readOnly}
                  />
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>

      {list.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
          Nothing here yet.
        </p>
      ) : null}

      {readOnly ? null : (
        <>
          <ActionPicker
            onAdd={add}
            unavailable={unavailable}
            disabled={atStepCap}
            label={path.length === 0 ? "Add a step" : "Add a step inside"}
          />
          {atStepCap ? (
            <p role="alert" className="text-[11px] text-red-700">
              This workflow already has {total} steps, which is the limit of{" "}
              {MAX_STEPS_PER_DEFINITION}. Remove one, or split this into several
              workflows that trigger each other.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

/** An indented child list, with the parent's slot named out loud. */
function Branch({
  title,
  ...rest
}: StepListProps & { title: string }) {
  return (
    <section
      aria-label={title}
      className="rounded-md border border-border bg-muted/20 p-2.5"
    >
      <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h4>
      <div className="border-l-2 border-border pl-2.5">
        <StepList {...rest} />
      </div>
    </section>
  );
}
