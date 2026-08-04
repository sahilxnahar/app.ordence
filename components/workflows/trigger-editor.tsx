"use client";

/**
 * Ordence — Trigger Editor
 * Version: v0.24.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE TRIGGER LIST IS READ FROM THE ENGINE, LIKE THE ACTION LIST
 * ══════════════════════════════════════════════════════════════════════
 * Options come from `TRIGGER_TYPES`, labels and descriptions from
 * `TRIGGER_CATALOG`, record types from `RECORD_TYPES`, and the field list
 * on an update trigger from that record type's own `readableColumns`.
 * Nothing on this screen is a list somebody typed here.
 *
 * The field list matters most: `validation.ts` REFUSES a watched field
 * that does not exist, on the grounds that a field which cannot change
 * means a workflow that can never fire. Offering a free-text box would
 * make that refusal a typo hunt; offering checkboxes over the real
 * columns makes it impossible.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ FIELD SCOPING IS PRESENTED AS THE DEFAULT, NOT AS AN OPTION
 * ══════════════════════════════════════════════════════════════════════
 * An unscoped "when a lead is updated" fires on every write to the row —
 * including writes this workflow's own steps make, and writes made by
 * other automations. It is the single most common cause of a runaway.
 * The engine warns about it; this editor puts the field list directly
 * under the trigger with the warning attached, because a warning at
 * publish time arrives after the design decision was made.
 */

import { useId } from "react";
import { Clock, Globe, User, Database } from "lucide-react";
import { Input } from "@/components/ui/input";
import { TRIGGER_TYPES } from "@/lib/workflows/program";
import { TRIGGER_CATALOG } from "@/lib/workflows/triggers";
import { describeCron, isValidCron } from "@/lib/workflows/cron";
import { RECORD_TYPES, RECORD_TYPE_KEYS } from "@/lib/workflows/records";
import type { TriggerConfig, WorkflowTriggerType } from "@/lib/workflows/program";
import type { WorkflowProblem } from "@/lib/workflows/validation";
import { ProblemList } from "./validation-panel";

const TRIGGER_ICONS: Record<WorkflowTriggerType, typeof Clock> = {
  record_created: Database,
  record_updated: Database,
  record_deleted: Database,
  manual: User,
  scheduled: Clock,
  webhook: Globe,
};

export type TriggerEditorProps = {
  triggerType: WorkflowTriggerType;
  triggerConfig: TriggerConfig;
  onChange: (next: { triggerType: WorkflowTriggerType; triggerConfig: TriggerConfig }) => void;
  problems: { errors: WorkflowProblem[]; warnings: WorkflowProblem[] };
  disabled?: boolean;
};

export function TriggerEditor({
  triggerType,
  triggerConfig,
  onChange,
  problems,
  disabled = false,
}: TriggerEditorProps) {
  const baseId = useId();
  const definition = TRIGGER_CATALOG[triggerType];
  const TriggerIcon = TRIGGER_ICONS[triggerType];

  const recordDefinition =
    triggerConfig.recordType &&
    (RECORD_TYPE_KEYS as readonly string[]).includes(triggerConfig.recordType)
      ? RECORD_TYPES[triggerConfig.recordType as keyof typeof RECORD_TYPES]
      : null;

  const watched = triggerConfig.watchFields ?? [];

  const patch = (config: Partial<TriggerConfig>) =>
    onChange({ triggerType, triggerConfig: { ...triggerConfig, ...config } });

  return (
    <section
      aria-labelledby={`${baseId}-heading`}
      className="rounded-lg border border-border bg-card p-4"
    >
      <div className="flex items-center gap-2">
        <TriggerIcon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <h2 id={`${baseId}-heading`} className="text-sm font-semibold">
          When this runs
        </h2>
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div>
          <label htmlFor={`${baseId}-type`} className="mb-1 block text-xs font-medium">
            Trigger
          </label>
          <select
            id={`${baseId}-type`}
            value={triggerType}
            disabled={disabled}
            aria-describedby={`${baseId}-type-help`}
            onChange={(event) => {
              const next = event.target.value as WorkflowTriggerType;
              // Config that belongs to the OLD trigger is dropped rather
              // than carried across — a cron left behind on a record
              // trigger is dead weight that reappears if the author
              // switches back and does not expect it.
              const nextDefinition = TRIGGER_CATALOG[next];
              onChange({
                triggerType: next,
                triggerConfig: {
                  recordType: nextDefinition.recordScoped
                    ? (triggerConfig.recordType ?? "lead")
                    : undefined,
                  watchFields: next === "record_updated" ? watched : undefined,
                  cron: next === "scheduled" ? (triggerConfig.cron ?? "0 9 * * 1-5") : undefined,
                  timezone:
                    next === "scheduled" ? (triggerConfig.timezone ?? "Asia/Kolkata") : undefined,
                  conditions: triggerConfig.conditions,
                },
              });
            }}
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            {TRIGGER_TYPES.map((value) => (
              <option key={value} value={value}>
                {TRIGGER_CATALOG[value].label}
              </option>
            ))}
          </select>
          <p id={`${baseId}-type-help`} className="mt-1 text-[11px] text-muted-foreground">
            {definition.description}
          </p>
        </div>

        {definition.recordScoped ? (
          <div>
            <label
              htmlFor={`${baseId}-record`}
              className="mb-1 block text-xs font-medium"
            >
              Which records
            </label>
            <select
              id={`${baseId}-record`}
              value={triggerConfig.recordType ?? ""}
              disabled={disabled}
              onChange={(event) =>
                patch({ recordType: event.target.value, watchFields: [] })
              }
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              <option value="">Choose a record type…</option>
              {RECORD_TYPE_KEYS.map((key) => (
                <option key={key} value={key}>
                  {RECORD_TYPES[key].label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-muted-foreground">
              The list is deliberately short — it is what stops an automation reaching
              the audit log or the user table.
            </p>
          </div>
        ) : null}
      </div>

      {/* ⭐ FIELD SCOPING */}
      {triggerType === "record_updated" ? (
        <fieldset className="mt-3 rounded-md border border-border p-2.5">
          <legend className="px-1 text-xs font-medium">
            Which fields to watch
          </legend>

          {watched.length === 0 ? (
            <p className="mb-2 rounded border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-[11px] text-amber-900">
              <span className="sr-only">Warning: </span>
              Nothing is selected, so this fires on ANY change to the record —
              including changes made by this workflow&apos;s own steps, by imports and
              by other automations. Naming the fields you care about is the single
              most effective way to stop automations triggering each other in circles.
            </p>
          ) : null}

          {recordDefinition ? (
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {recordDefinition.readableColumns.map((column) => {
                const checkboxId = `${baseId}-watch-${column}`;
                return (
                  <div key={column} className="flex items-center gap-1.5">
                    <input
                      id={checkboxId}
                      type="checkbox"
                      disabled={disabled}
                      checked={watched.includes(column)}
                      onChange={(event) =>
                        patch({
                          watchFields: event.target.checked
                            ? [...watched, column]
                            : watched.filter((field) => field !== column),
                        })
                      }
                      className="h-3.5 w-3.5 rounded border-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                    <label htmlFor={checkboxId} className="font-mono text-[11px]">
                      {column}
                    </label>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              Choose a record type first — the fields come from it.
            </p>
          )}
        </fieldset>
      ) : null}

      {/* SCHEDULE */}
      {triggerType === "scheduled" ? (
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <div>
            <label htmlFor={`${baseId}-cron`} className="mb-1 block text-xs font-medium">
              Schedule (five-field cron)
            </label>
            <Input
              id={`${baseId}-cron`}
              value={triggerConfig.cron ?? ""}
              disabled={disabled}
              onChange={(event) => patch({ cron: event.target.value })}
              placeholder="0 9 * * 1-5"
              className="font-mono"
              aria-describedby={`${baseId}-cron-help`}
            />
            {/*
              ⚠️ Echoed back in English, live. A cron expression is
              write-only for most people, and "0 9 * * 1-5" versus
              "0 9 1-5 * *" is the difference between every weekday and
              the first five days of the month.
            */}
            <p id={`${baseId}-cron-help`} className="mt-1 text-[11px]" aria-live="polite">
              {triggerConfig.cron && isValidCron(triggerConfig.cron) ? (
                <span className="text-emerald-700">
                  {describeCron(triggerConfig.cron)}
                </span>
              ) : (
                <span className="text-muted-foreground">
                  Example: <code className="font-mono">0 9 * * 1-5</code> runs at 9am
                  every weekday.
                </span>
              )}
            </p>
          </div>

          <div>
            <label htmlFor={`${baseId}-tz`} className="mb-1 block text-xs font-medium">
              Timezone
            </label>
            <Input
              id={`${baseId}-tz`}
              value={triggerConfig.timezone ?? ""}
              disabled={disabled}
              onChange={(event) => patch({ timezone: event.target.value })}
              placeholder="Asia/Kolkata"
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              An IANA name. Left empty this runs in UTC, which is five and a half
              hours out for an Indian office.
            </p>
          </div>
        </div>
      ) : null}

      {/* ⭐ THE DELEGATION NOTE, SHOWN WHERE THE CHOICE IS MADE */}
      {definition.unattended ? (
        <p className="mt-3 rounded border border-amber-500/30 bg-amber-500/5 px-2.5 py-2 text-[11px] text-amber-900">
          <strong className="font-semibold">Nobody is present when this runs.</strong>{" "}
          A {triggerType === "scheduled" ? "scheduled" : "webhook"} run has no live
          person, so it acts with the permissions of whoever publishes it — and it
          keeps doing so on every future run. That delegation is confirmed again at
          publish.
        </p>
      ) : null}

      {triggerType === "manual" ? (
        <p className="mt-3 rounded border border-border bg-muted/30 px-2.5 py-2 text-[11px] text-muted-foreground">
          A manual run acts as the person who pressed the button, which may be
          somebody with fewer permissions than you. If it is, their run fails
          visibly on the step they may not perform — that is correct, and it is the
          difference between a shortcut and a privilege.
        </p>
      ) : null}

      {triggerType === "webhook" ? (
        <p className="mt-2 text-[11px] text-muted-foreground">
          A webhook token is issued from the workflow&apos;s page after publishing,
          and shown exactly once — only its hash is stored.
        </p>
      ) : null}

      <ProblemList problems={problems.errors} tone="error" />
      <ProblemList problems={problems.warnings} tone="warning" />
    </section>
  );
}
