"use client";

/**
 * Ordence — Per-Action Configuration
 * Version: v0.24.0-alpha
 *
 * One form per action, driven by the same catalogues the engine uses.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE FIELD LISTS COME FROM `lib/workflows/records.ts`
 * ══════════════════════════════════════════════════════════════════════
 * That file is the security boundary of the record actions: every table
 * name and every column name that reaches SQL comes from it. A builder
 * that offered a free-text column box would be inviting the author to
 * type `tenant_id`, and the refusal would arrive at publish with no
 * explanation of why that particular word is special.
 *
 * So the column picker lists `writableColumns` and nothing else, and the
 * absences are explained where they will be noticed — `units.status` is
 * missing because a unit is booked by creating a booking, not by writing
 * a column.
 *
 * ⚠️ NUMBERS ARE BOUNDED BY THE ENGINE'S CONSTANTS, IN THE `max`
 * ATTRIBUTE AND IN THE HELP TEXT. A `min`/`max` alone is silent when it
 * clamps; the sentence next to it is what a person reads.
 */

import { useId } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  DEFAULT_FORM_DUE_HOURS,
  MAX_DELAY_SECONDS,
  MAX_FIND_RESULTS,
  MAX_FORM_DUE_HOURS,
  MAX_ITERATIONS_PER_LOOP,
  MIN_DELAY_SECONDS,
} from "@/lib/workflows/limits";
import { RECORD_TYPES, RECORD_TYPE_KEYS } from "@/lib/workflows/records";
import type { TemplateValue, WorkflowStep } from "@/lib/workflows/program";
import { BindingInput } from "./binding-field";
import { ConditionEditor, parseValue, stringifyValue } from "./condition-editor";
import { describeSeconds } from "./presentation";
import type { BindingSuggestion } from "./step-tree";

export type StepConfigProps = {
  step: WorkflowStep;
  onChange: (next: WorkflowStep) => void;
  suggestions: readonly BindingSuggestion[];
  /** True on a `record_updated` trigger — enables the `changed` operator. */
  allowChanged?: boolean;
};

export function StepConfig({
  step,
  onChange,
  suggestions,
  allowChanged = false,
}: StepConfigProps) {
  const baseId = useId();

  switch (step.action) {
    /* ---------------------------------------------------------------- */
    case "create_record":
      return (
        <div className="space-y-3">
          <RecordTypePicker
            id={`${baseId}-type`}
            value={step.recordType}
            operation="create"
            onChange={(recordType) => onChange({ ...step, recordType, values: {} })}
          />
          <ValuesEditor
            recordType={step.recordType}
            values={step.values ?? {}}
            onChange={(values) => onChange({ ...step, values })}
            suggestions={suggestions}
          />
        </div>
      );

    /* ---------------------------------------------------------------- */
    case "update_record":
      return (
        <div className="space-y-3">
          <RecordTypePicker
            id={`${baseId}-type`}
            value={step.recordType}
            operation="update"
            onChange={(recordType) => onChange({ ...step, recordType, values: {} })}
          />
          <BindingInput
            label="Which record"
            required
            value={step.recordId ?? ""}
            onChange={(recordId) => onChange({ ...step, recordId })}
            suggestions={suggestions}
            placeholder="{{ trigger.record.id }}"
            description="Usually the record that triggered this, or an item from a loop."
          />
          <ValuesEditor
            recordType={step.recordType}
            values={step.values ?? {}}
            onChange={(values) => onChange({ ...step, values })}
            suggestions={suggestions}
          />
        </div>
      );

    /* ---------------------------------------------------------------- */
    case "delete_record":
      return (
        <div className="space-y-3">
          <RecordTypePicker
            id={`${baseId}-type`}
            value={step.recordType}
            operation="delete"
            onChange={(recordType) => onChange({ ...step, recordType })}
          />
          <BindingInput
            label="Which record"
            required
            value={step.recordId ?? ""}
            onChange={(recordId) => onChange({ ...step, recordId })}
            suggestions={suggestions}
            placeholder="{{ trigger.record.id }}"
            description="Deletion is a move to the recycle bin, not an erase — but it is still a deletion, and the person who publishes this must hold the delete permission themselves."
          />
        </div>
      );

    /* ---------------------------------------------------------------- */
    case "find_records":
      return (
        <div className="space-y-3">
          <div className="grid gap-3 md:grid-cols-2">
            <RecordTypePicker
              id={`${baseId}-type`}
              value={step.recordType}
              operation="read"
              onChange={(recordType) => onChange({ ...step, recordType })}
            />
            <NumberField
              id={`${baseId}-limit`}
              label="How many at most"
              value={step.limit ?? MAX_FIND_RESULTS}
              min={1}
              max={MAX_FIND_RESULTS}
              onChange={(limit) => onChange({ ...step, limit })}
              help={`Never more than ${MAX_FIND_RESULTS}. The result also says whether it was truncated — read steps.${step.key}.truncated before looping.`}
            />
          </div>
          <ConditionEditor
            group={step.where ?? { match: "all", conditions: [] }}
            onChange={(where) => onChange({ ...step, where })}
            suggestions={suggestions}
            allowChanged={false}
            lead="Find records where"
            emptyHint="With no conditions this returns the most recent records of that type, up to the limit."
          />
        </div>
      );

    /* ---------------------------------------------------------------- */
    case "send_email":
      return (
        <div className="space-y-3">
          <p className="rounded border border-amber-500/30 bg-amber-500/5 px-2.5 py-2 text-[11px] text-amber-900">
            <span className="sr-only">Warning: </span>
            An email leaves the building. It reaches the recipient under the
            company&apos;s name with no human between this form and their inbox, which
            is why sending needs its own permission.
          </p>
          <BindingInput
            label="To"
            required
            value={step.to ?? ""}
            onChange={(to) => onChange({ ...step, to })}
            suggestions={suggestions}
            placeholder="{{ trigger.record.email }}"
            description="An address, or a binding that resolves to one. The resolved address is checked at run time and recorded in the run history."
          />
          <BindingInput
            label="Subject"
            required
            value={step.subject ?? ""}
            onChange={(subject) => onChange({ ...step, subject })}
            suggestions={suggestions}
            placeholder="Your booking at {{ trigger.record.name }}"
          />
          <BindingInput
            label="Message"
            multiline
            value={step.body ?? ""}
            onChange={(body) => onChange({ ...step, body })}
            suggestions={suggestions}
          />
        </div>
      );

    /* ---------------------------------------------------------------- */
    case "http_request":
      return (
        <div className="space-y-3">
          <p className="rounded border border-red-500/30 bg-red-500/5 px-2.5 py-2 text-[11px] text-red-800">
            <span className="sr-only">Warning: </span>
            Anything readable in this run can be sent to the address below. Private
            addresses, cloud metadata endpoints and routing headers are refused, and
            the URL is checked again after any binding in it resolves.
          </p>
          <div className="grid gap-3 md:grid-cols-[8rem_1fr]">
            <div>
              <label
                htmlFor={`${baseId}-method`}
                className="mb-1 block text-xs font-medium"
              >
                Method
              </label>
              <select
                id={`${baseId}-method`}
                value={step.method}
                onChange={(event) =>
                  onChange({
                    ...step,
                    method: event.target.value as typeof step.method,
                  })
                }
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {(["GET", "POST", "PUT", "PATCH", "DELETE"] as const).map((method) => (
                  <option key={method} value={method}>
                    {method}
                  </option>
                ))}
              </select>
            </div>
            <BindingInput
              label="URL"
              required
              value={step.url ?? ""}
              onChange={(url) => onChange({ ...step, url })}
              suggestions={suggestions}
              placeholder="https://example.com/hooks/ordence"
            />
          </div>

          <HeadersEditor
            headers={step.headers ?? {}}
            onChange={(headers) => onChange({ ...step, headers })}
          />

          <BindingInput
            label="Request body"
            multiline
            value={step.body ?? ""}
            onChange={(body) => onChange({ ...step, body })}
            suggestions={suggestions}
            description="Sent as-is. The response comes back as text, never as a parsed object."
          />
        </div>
      );

    /* ---------------------------------------------------------------- */
    case "filter":
      return (
        <ConditionEditor
          group={step.conditions ?? { match: "all", conditions: [] }}
          onChange={(conditions) => onChange({ ...step, conditions })}
          suggestions={suggestions}
          allowChanged={allowChanged}
          lead="Continue only when"
          emptyHint="A filter with no conditions stops nothing. Publishing is refused until it has one — a step that always passes reads like a safety check and is not one."
        />
      );

    /* ---------------------------------------------------------------- */
    case "if_else":
      return (
        <ConditionEditor
          group={step.conditions ?? { match: "all", conditions: [] }}
          onChange={(conditions) => onChange({ ...step, conditions })}
          suggestions={suggestions}
          allowChanged={allowChanged}
          lead="Take the first path when"
          emptyHint="Without a condition this branch always takes the same path."
        />
      );

    /* ---------------------------------------------------------------- */
    case "iterator":
      return (
        <div className="space-y-3">
          <BindingInput
            label="List to repeat over"
            required
            value={step.source ?? ""}
            onChange={(source) => onChange({ ...step, source })}
            suggestions={suggestions}
            placeholder="steps.find_leads.records"
            description="Usually the results of a Find step. Write the path WITHOUT braces."
          />
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <label
                htmlFor={`${baseId}-alias`}
                className="mb-1 block text-xs font-medium"
              >
                Name for the current item
              </label>
              <Input
                id={`${baseId}-alias`}
                value={step.itemAlias ?? ""}
                onChange={(event) => onChange({ ...step, itemAlias: event.target.value })}
                placeholder="item"
                className="font-mono"
                aria-describedby={`${baseId}-alias-help`}
              />
              <p id={`${baseId}-alias-help`} className="mt-1 text-[11px] text-muted-foreground">
                Steps inside can read it under this name. <code className="font-mono">item</code>{" "}
                always means the innermost loop, which is why an outer loop needs a name of
                its own.
              </p>
            </div>
            <NumberField
              id={`${baseId}-max`}
              label="Repeat at most"
              value={step.maxIterations ?? MAX_ITERATIONS_PER_LOOP}
              min={1}
              max={MAX_ITERATIONS_PER_LOOP}
              onChange={(maxIterations) => onChange({ ...step, maxIterations })}
              help={`Between 1 and ${MAX_ITERATIONS_PER_LOOP}. One run may repeat 1,000 times across every loop it contains, whichever comes first.`}
            />
          </div>
        </div>
      );

    /* ---------------------------------------------------------------- */
    case "delay":
      return (
        <div className="space-y-2">
          <NumberField
            id={`${baseId}-seconds`}
            label="Wait for (seconds)"
            value={step.seconds ?? 0}
            min={MIN_DELAY_SECONDS}
            max={MAX_DELAY_SECONDS}
            onChange={(seconds) => onChange({ ...step, seconds })}
            help={`That is ${describeSeconds(step.seconds ?? 0)}. The longest a wait may be is ${describeSeconds(MAX_DELAY_SECONDS)} — beyond that the right tool is a scheduled workflow, which holds no open state while it waits.`}
          />
          <div className="flex flex-wrap gap-1.5">
            {[
              ["5 minutes", 300],
              ["1 hour", 3600],
              ["1 day", 86_400],
              ["7 days", 604_800],
            ].map(([label, seconds]) => (
              <Button
                key={String(label)}
                type="button"
                variant="outline"
                size="sm"
                className="h-7 text-[11px]"
                onClick={() => onChange({ ...step, seconds: Number(seconds) })}
              >
                {label}
              </Button>
            ))}
          </div>
        </div>
      );

    /* ---------------------------------------------------------------- */
    case "form":
      return (
        <div className="space-y-3">
          <div>
            <label htmlFor={`${baseId}-title`} className="mb-1 block text-xs font-medium">
              What is being approved
              <span className="ml-0.5 text-destructive" aria-hidden="true">
                *
              </span>
              <span className="sr-only"> (required)</span>
            </label>
            <Input
              id={`${baseId}-title`}
              value={step.title ?? ""}
              onChange={(event) => onChange({ ...step, title: event.target.value })}
              placeholder="Approve the 12% discount on this booking"
              aria-describedby={`${baseId}-title-help`}
            />
            <p id={`${baseId}-title-help`} className="mt-1 text-[11px] text-muted-foreground">
              It is all the approver will see in their inbox. Write it as the question
              they are answering.
            </p>
          </div>

          <div>
            <label htmlFor={`${baseId}-instructions`} className="mb-1 block text-xs font-medium">
              Instructions (optional)
            </label>
            <Textarea
              id={`${baseId}-instructions`}
              value={step.instructions ?? ""}
              onChange={(event) => onChange({ ...step, instructions: event.target.value })}
            />
          </div>

          <BindingInput
            label="Who must answer"
            value={step.assignTo ?? ""}
            onChange={(assignTo) => onChange({ ...step, assignTo })}
            suggestions={suggestions}
            placeholder="{{ trigger.record.owner_id }}"
            description="A user id, or a binding to one. Left empty, anyone with permission to approve can answer — fine for a small team, surprising in a large one."
          />

          <div className="grid gap-3 md:grid-cols-2">
            <NumberField
              id={`${baseId}-due`}
              label="Expires after (hours)"
              value={step.dueInHours ?? DEFAULT_FORM_DUE_HOURS}
              min={1}
              max={MAX_FORM_DUE_HOURS}
              onChange={(dueInHours) => onChange({ ...step, dueInHours })}
              help={`Between 1 and ${MAX_FORM_DUE_HOURS} hours. A request nobody answers has to expire, or the run waits forever holding its place in the definition.`}
            />
            <div>
              <label
                htmlFor={`${baseId}-reject`}
                className="mb-1 block text-xs font-medium"
              >
                If it is rejected
              </label>
              <select
                id={`${baseId}-reject`}
                value={step.onReject ?? "stop"}
                onChange={(event) =>
                  onChange({ ...step, onReject: event.target.value as "stop" | "fail" })
                }
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="stop">Stop the run — a &quot;no&quot; is a normal outcome</option>
                <option value="fail">Fail the run — a &quot;no&quot; means something is wrong</option>
              </select>
              <p className="mt-1 text-[11px] text-muted-foreground">
                A stopped run is not an error and pages nobody. A failed one shows up
                in the failure list.
              </p>
            </div>
          </div>
        </div>
      );
  }
}

/* ------------------------------------------------------------------ */
/* SHARED CONTROLS                                                     */
/* ------------------------------------------------------------------ */

function RecordTypePicker({
  id,
  value,
  operation,
  onChange,
}: {
  id: string;
  value: string;
  operation: "read" | "create" | "update" | "delete";
  onChange: (value: string) => void;
}) {
  const OPERATION_WORD = {
    read: "read",
    create: "create",
    update: "update",
    delete: "delete",
  } as const;

  // ⚠️ Types the engine will not perform this operation on are shown
  // DISABLED with the reason, not hidden. "Why can't I create a booking?"
  // deserves the answer, which is that a booking is created through the
  // booking screen and its three protections against selling one flat
  // twice.
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-medium">
        Record type
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {RECORD_TYPE_KEYS.map((key) => {
          const permitted = RECORD_TYPES[key].permissions[operation] !== null;
          return (
            <option key={key} value={key} disabled={!permitted}>
              {RECORD_TYPES[key].label}
              {permitted ? "" : ` — an automation cannot ${OPERATION_WORD[operation]} this`}
            </option>
          );
        })}
      </select>
    </div>
  );
}

function ValuesEditor({
  recordType,
  values,
  onChange,
  suggestions,
}: {
  recordType: string;
  values: Record<string, TemplateValue>;
  onChange: (values: Record<string, TemplateValue>) => void;
  suggestions: readonly BindingSuggestion[];
}) {
  const baseId = useId();
  const definition = (RECORD_TYPE_KEYS as readonly string[]).includes(recordType)
    ? RECORD_TYPES[recordType as keyof typeof RECORD_TYPES]
    : null;

  const entries = Object.entries(values);
  const used = entries.map(([column]) => column);
  const available = (definition?.writableColumns ?? []).filter(
    (column) => !used.includes(column),
  );

  return (
    <fieldset className="rounded-md border border-border p-2.5">
      <legend className="px-1 text-xs font-medium">Fields to set</legend>

      {definition ? (
        <p className="mb-2 text-[11px] text-muted-foreground">
          Only the fields a workflow may write are listed. The rest are either
          system-managed or protected by rules a direct write would skip.
          {definition.requiredOnCreate.length > 0 ? (
            <>
              {" "}
              Creating one needs:{" "}
              <code className="font-mono">
                {definition.requiredOnCreate.join(", ")}
              </code>
              .
            </>
          ) : null}
        </p>
      ) : null}

      {entries.length === 0 ? (
        <p className="mb-2 text-[11px] text-amber-700">
          No fields set yet. A create or update that writes nothing is refused at
          publish.
        </p>
      ) : null}

      <ul className="space-y-2">
        {entries.map(([column, value]) => (
          <li key={column} className="rounded border border-border bg-muted/20 p-2">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[11px] font-medium">{column}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-[11px]"
                onClick={() => {
                  const next = { ...values };
                  delete next[column];
                  onChange(next);
                }}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                <span className="sr-only">Stop setting {column}</span>
                Remove
              </Button>
            </div>
            <div className="mt-1.5">
              <BindingInput
                label={`Value for ${column}`}
                value={stringifyValue(value)}
                onChange={(raw) => onChange({ ...values, [column]: toTemplateValue(raw) })}
                suggestions={suggestions}
              />
            </div>
          </li>
        ))}
      </ul>

      <div className="mt-2 flex flex-wrap items-end gap-2">
        <div className="min-w-[12rem] flex-1">
          <label htmlFor={`${baseId}-add`} className="mb-1 block text-xs font-medium">
            Add a field
          </label>
          <select
            id={`${baseId}-add`}
            value=""
            disabled={available.length === 0}
            onChange={(event) => {
              const column = event.target.value;
              if (!column) return;
              onChange({ ...values, [column]: "" });
              event.target.value = "";
            }}
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            <option value="">
              {available.length === 0 ? "Every writable field is already set" : "Choose a field…"}
            </option>
            {available.map((column) => (
              <option key={column} value={column}>
                {column}
              </option>
            ))}
          </select>
        </div>
      </div>
    </fieldset>
  );
}

/**
 * ⚠️ Values are SCALARS ONLY — see `lib/validators/workflows.ts`. A number
 * typed into a text box has to become a number here, or `score` is set to
 * the string "80" and every later comparison is a text comparison.
 */
function toTemplateValue(raw: string): TemplateValue {
  const parsed = parseValue(raw);
  if (
    typeof parsed === "string" ||
    typeof parsed === "number" ||
    typeof parsed === "boolean" ||
    parsed === null
  ) {
    return parsed;
  }
  return raw;
}

function HeadersEditor({
  headers,
  onChange,
}: {
  headers: Record<string, string>;
  onChange: (headers: Record<string, string>) => void;
}) {
  const baseId = useId();
  const entries = Object.entries(headers);

  return (
    <fieldset className="rounded-md border border-border p-2.5">
      <legend className="px-1 text-xs font-medium">Headers</legend>
      <p className="mb-2 text-[11px] text-muted-foreground">
        Headers that control routing or forge the origin of the request are refused —
        the refusal names them.
      </p>

      <ul className="space-y-1.5">
        {entries.map(([name, value], index) => (
          <li key={index} className="flex flex-wrap items-end gap-1.5">
            <div className="min-w-[10rem] flex-1">
              <label htmlFor={`${baseId}-n-${index}`} className="sr-only">
                Header {index + 1} name
              </label>
              <Input
                id={`${baseId}-n-${index}`}
                value={name}
                placeholder="Authorization"
                onChange={(event) => {
                  const next: Record<string, string> = {};
                  entries.forEach(([k, v], i) => {
                    next[i === index ? event.target.value : k] = v;
                  });
                  onChange(next);
                }}
              />
            </div>
            <div className="min-w-[10rem] flex-1">
              <label htmlFor={`${baseId}-v-${index}`} className="sr-only">
                Header {index + 1} value
              </label>
              <Input
                id={`${baseId}-v-${index}`}
                value={value}
                placeholder="Bearer …"
                onChange={(event) => onChange({ ...headers, [name]: event.target.value })}
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-9 px-2 text-[11px]"
              onClick={() => {
                const next = { ...headers };
                delete next[name];
                onChange(next);
              }}
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="sr-only">Remove header {name || index + 1}</span>
            </Button>
          </li>
        ))}
      </ul>

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-2 h-8"
        onClick={() => onChange({ ...headers, "": "" })}
        disabled={Object.hasOwn(headers, "")}
      >
        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
        Add a header
      </Button>
    </fieldset>
  );
}

function NumberField({
  id,
  label,
  value,
  min,
  max,
  onChange,
  help,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  help?: string;
}) {
  const outOfRange = !Number.isInteger(value) || value < min || value > max;

  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-medium">
        {label}
      </label>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={Number.isFinite(value) ? value : ""}
        aria-describedby={help ? `${id}-help` : undefined}
        aria-invalid={outOfRange ? true : undefined}
        onChange={(event) => {
          const parsed = Number(event.target.value);
          onChange(Number.isFinite(parsed) ? Math.trunc(parsed) : min);
        }}
      />
      {help ? (
        <p
          id={`${id}-help`}
          className={[
            "mt-1 text-[11px]",
            outOfRange ? "text-destructive" : "text-muted-foreground",
          ].join(" ")}
        >
          {outOfRange ? <span className="sr-only">Out of range. </span> : null}
          {help}
        </p>
      ) : null}
    </div>
  );
}
