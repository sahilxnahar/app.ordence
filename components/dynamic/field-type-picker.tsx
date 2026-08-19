"use client";

/**
 * Ordence — The Field Type Picker
 * Version: v0.27.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE LIST IS READ FROM THE ENGINE. THERE IS NO SECOND LIST.
 * ══════════════════════════════════════════════════════════════════════
 * Every option below is generated from `FIELD_TYPE_OPTIONS`, which is
 * generated from `DYNAMIC_FIELD_TYPES` and `FIELD_TYPE_CATALOG` — the same
 * two exports the DDL planner, the value validator and the `dynamic_field_type`
 * Postgres enum are built from. Same argument as the workflow action picker.
 *
 * ⚠️ `formula`, `rollup` AND `file` ARE NOT HERE BECAUSE THE ENGINE DOES
 * NOT HAVE THEM. They are not hidden, disabled or feature-flagged: the
 * product does not have them, and a picker that cannot invent options is
 * how the UI says so honestly.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ AND IT IS ONLY EVER RENDERED FOR A FIELD THAT DOES NOT EXIST YET
 * ══════════════════════════════════════════════════════════════════════
 * `updateDynamicFieldSchema` accepts no `fieldType`. There is no
 * "change the type" operation in the engine, because `ALTER COLUMN … TYPE`
 * rewrites the table under an ACCESS EXCLUSIVE lock and either fails
 * halfway or succeeds destructively. `FieldEditor` renders
 * `FixedFieldType` instead on an existing field — a sentence, not a
 * disabled dropdown, because a disabled control reads as a permission
 * problem and a sentence reads as a rule.
 */

import { useId } from "react";
import {
  FIELD_TYPE_OPTIONS,
  fieldTypeOption,
  FIELD_TYPE_IS_FIXED_EXPLANATION,
} from "./presentation";
import type { DynamicFieldType } from "@/lib/dynamic/field-types";

export function FieldTypePicker({
  value,
  onChange,
  disabled = false,
  id,
}: {
  value: DynamicFieldType;
  onChange: (next: DynamicFieldType) => void;
  disabled?: boolean;
  id?: string;
}) {
  const generatedId = useId();
  const selectId = id ?? `${generatedId}-field-type`;
  const describedBy = `${selectId}-hint`;
  const option = fieldTypeOption(value);

  return (
    <div>
      <label htmlFor={selectId} className="mb-1 block text-xs font-medium">
        Type
        <span className="ml-0.5 text-destructive" aria-hidden="true">
          *
        </span>
        <span className="sr-only"> (required)</span>
      </label>
      <select
        id={selectId}
        value={value}
        disabled={disabled}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.value as DynamicFieldType)}
        className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        {FIELD_TYPE_OPTIONS.map((entry) => (
          <option key={entry.value} value={entry.value}>
            {entry.label}
          </option>
        ))}
      </select>
      <p id={describedBy} className="mt-1 text-[11px] text-muted-foreground">
        {option.hint}{" "}
        <span className="whitespace-nowrap">
          Stored as <code className="font-mono">{option.pgType}</code>.
        </span>
      </p>
    </div>
  );
}

/**
 * ⭐ WHAT AN EXISTING FIELD SHOWS WHERE THE DROPDOWN WOULD BE.
 *
 * Not a `<select disabled>`. A disabled control is an invitation with the
 * reason missing, and the reason here is the whole point: the column is a
 * real column and its type is now a fact about a table that may hold
 * millions of rows.
 */
export function FixedFieldType({
  value,
  onAddNewField,
}: {
  value: DynamicFieldType;
  onAddNewField?: () => void;
}) {
  const option = fieldTypeOption(value);

  return (
    <div className="rounded-md border border-border bg-muted/30 p-3">
      <p className="text-xs font-medium">Type</p>
      <p className="mt-0.5 text-sm">
        {option.label}{" "}
        <span className="text-muted-foreground">
          — stored as <code className="font-mono">{option.pgType}</code>
        </span>
      </p>
      <p className="mt-1.5 text-[11px] text-muted-foreground">
        <strong className="font-medium text-foreground">
          The type cannot be changed.
        </strong>{" "}
        {FIELD_TYPE_IS_FIXED_EXPLANATION}
      </p>
      {onAddNewField ? (
        <button
          type="button"
          onClick={onAddNewField}
          className="mt-2 rounded-md border border-input bg-background px-2.5 py-1 text-xs font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Add a new field instead
        </button>
      ) : null}
    </div>
  );
}
