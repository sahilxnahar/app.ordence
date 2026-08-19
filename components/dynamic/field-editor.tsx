"use client";

/**
 * Ordence — The Field Editor
 * Version: v0.27.0-alpha
 *
 * One field, in two quite different states.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ A NEW FIELD IS A PROPOSAL. AN EXISTING FIELD IS A COLUMN.
 * ══════════════════════════════════════════════════════════════════════
 * On a NEW field everything is editable, because nothing has been built
 * yet and the whole thing is still a sentence in a form.
 *
 * On an EXISTING field, three things are facts about a real PostgreSQL
 * column and the form does not pretend otherwise:
 *
 *   • THE TYPE. `updateDynamicFieldSchema` has no `fieldType`. There is no
 *     "change the type" call to make. See `FixedFieldType`.
 *   • THE API NAME. Renaming is `ALTER TABLE … RENAME COLUMN`, which
 *     silently breaks every saved view, export and integration naming it —
 *     they simply stop finding the field.
 *   • UNIQUE / INDEXED. Adding or dropping an index on a live table is a
 *     separate operation the engine does not expose on update; the flags
 *     are shown as they are, read-only, rather than as switches that would
 *     appear to work and change nothing.
 *
 * What IS editable on an existing field is exactly what
 * `updateDynamicFieldSchema` accepts: label, help text, placeholder,
 * hidden, shown-in-grid. The form and the schema agree because the form
 * was written from the schema.
 *
 * ⚠️ THE CHOICES ON AN EXISTING `select` ARE READ-ONLY HERE TOO, AND THAT
 * IS NOT AN OVERSIGHT. Editing them means dropping and recreating a CHECK
 * constraint — which the engine can do and does not expose through
 * `updateDynamicField`. Showing an editable list that the server would
 * ignore is worse than showing the list as it is.
 */

import { useId } from "react";
import { Trash2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FieldTypePicker, FixedFieldType } from "./field-type-picker";
import {
  checkDraftField,
  effectiveApiName,
  fieldTypeOption,
  MAX_FIELD_API_NAME_LENGTH,
  MAX_SELECT_OPTIONS,
  RELATION_CORE_TABLES,
  API_NAME_IS_PERMANENT_EXPLANATION,
  LABEL_IS_SAFE_EXPLANATION,
  type DraftField,
  type RelationTargetOption,
} from "./presentation";
import type { DynamicFieldType } from "@/lib/dynamic/field-types";

export type FieldEditorProps = {
  draft: DraftField;
  /** Every field on this record type, for the duplicate-name check. */
  siblings: readonly DraftField[];
  /** What a `relation` field may point at, resolved by the caller. */
  relationTargets: readonly RelationTargetOption[];
  onChange: (next: DraftField) => void;
  /** Offered instead of a type dropdown on an existing field. */
  onAddNewField?: () => void;
};

export function FieldEditor({
  draft,
  siblings,
  relationTargets,
  onChange,
  onAddNewField,
}: FieldEditorProps) {
  const uid = useId();
  const exists = draft.id !== null;
  const option = fieldTypeOption(draft.fieldType);
  const problems = checkDraftField(draft, siblings);
  const problemFor = (where: string) =>
    problems.find((p) => p.where === where)?.message ?? null;

  const apiName = effectiveApiName(draft);
  const set = (patch: Partial<DraftField>) => onChange({ ...draft, ...patch });

  const coreTargets: RelationTargetOption[] = RELATION_CORE_TABLES.map((table) => ({
    kind: "core" as const,
    table,
    label: table,
  }));
  const allTargets = [...relationTargets, ...coreTargets];

  return (
    <div className="space-y-3">
      {/* ---------------- Label ---------------- */}
      <div>
        <label htmlFor={`${uid}-label`} className="mb-1 block text-xs font-medium">
          Label
          <span className="ml-0.5 text-destructive" aria-hidden="true">
            *
          </span>
          <span className="sr-only"> (required)</span>
        </label>
        <Input
          id={`${uid}-label`}
          value={draft.label}
          maxLength={150}
          aria-describedby={`${uid}-label-help`}
          aria-invalid={problemFor("label") ? true : undefined}
          onChange={(event) => set({ label: event.target.value })}
          placeholder="Carpet area"
        />
        <p id={`${uid}-label-help`} className="mt-1 text-[11px] text-muted-foreground">
          What people see on the form and in the grid. {LABEL_IS_SAFE_EXPLANATION}
        </p>
        <Problem message={problemFor("label")} />
      </div>

      {/* ---------------- API name ---------------- */}
      <div>
        <label htmlFor={`${uid}-api`} className="mb-1 block text-xs font-medium">
          API name
          {exists ? (
            <span className="ml-2 rounded border border-border px-1 py-0.5 text-[10px] font-normal uppercase tracking-wide text-muted-foreground">
              permanent
            </span>
          ) : null}
        </label>
        {exists ? (
          /*
           * ⚠️ RENDERED AS TEXT, NOT AS A DISABLED INPUT. A disabled box
           * still looks like a box somebody could be given permission to
           * type in. This is a column name in a real table; it is a fact.
           */
          <>
            <p className="rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-sm">
              {draft.apiName}
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              This is the physical column name. Renaming it would be{" "}
              <code className="font-mono">ALTER TABLE … RENAME COLUMN</code>, which
              breaks every saved view, export and integration that names this field —
              silently, because they would simply stop finding it.
            </p>
          </>
        ) : (
          <>
            <Input
              id={`${uid}-api`}
              value={apiName}
              maxLength={MAX_FIELD_API_NAME_LENGTH}
              className="font-mono"
              aria-describedby={`${uid}-api-help`}
              aria-invalid={problemFor("apiName") ? true : undefined}
              onChange={(event) =>
                set({ apiName: event.target.value, apiNameTouched: true })
              }
              placeholder="carpet_area"
            />
            <p id={`${uid}-api-help`} className="mt-1 text-[11px] text-muted-foreground">
              Suggested from the label until you edit it. Lowercase letters, digits and
              underscores, starting with a letter. {API_NAME_IS_PERMANENT_EXPLANATION}
            </p>
          </>
        )}
        <Problem message={problemFor("apiName")} />
      </div>

      {/* ---------------- Type ---------------- */}
      {exists ? (
        <FixedFieldType value={draft.fieldType} onAddNewField={onAddNewField} />
      ) : (
        <FieldTypePicker
          id={`${uid}-type`}
          value={draft.fieldType}
          onChange={(fieldType: DynamicFieldType) => {
            const next = fieldTypeOption(fieldType);
            // Config that cannot apply to the new type is DROPPED rather
            // than carried invisibly: `planField` refuses choices on a
            // non-choice field, and a hidden leftover would be a refusal
            // whose cause is not on the screen.
            set({
              fieldType,
              options: next.requiresOptions ? draft.options : [],
              relation: next.requiresTarget ? draft.relation : null,
              isUnique: draft.isUnique && next.supportsUnique,
              isIndexed: draft.isIndexed && next.supportsIndex,
            });
          }}
        />
      )}

      {/* ---------------- Per-type config ---------------- */}
      {option.requiresOptions ? (
        <ChoiceEditor
          uid={uid}
          draft={draft}
          readOnly={exists}
          onChange={(options) => set({ options })}
          error={problemFor("options")}
        />
      ) : null}

      {option.requiresTarget ? (
        <div>
          <label htmlFor={`${uid}-target`} className="mb-1 block text-xs font-medium">
            Links to
            <span className="ml-0.5 text-destructive" aria-hidden="true">
              *
            </span>
            <span className="sr-only"> (required)</span>
          </label>
          {exists ? (
            <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
              {describeTarget(draft, allTargets)}
              <span className="ml-2 text-[11px] text-muted-foreground">
                Fixed — it is a foreign key.
              </span>
            </p>
          ) : (
            <select
              id={`${uid}-target`}
              value={targetKey(draft)}
              aria-describedby={`${uid}-target-help`}
              onChange={(event) => set({ relation: parseTargetKey(event.target.value) })}
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">Choose a record type…</option>
              {relationTargets.length > 0 ? (
                <optgroup label="Your record types">
                  {relationTargets.map((target) =>
                    target.kind === "object" ? (
                      <option key={target.objectId} value={`object:${target.objectId}`}>
                        {target.label}
                      </option>
                    ) : null,
                  )}
                </optgroup>
              ) : null}
              <optgroup label="Built-in record types">
                {coreTargets.map((target) =>
                  target.kind === "core" ? (
                    <option key={target.table} value={`core:${target.table}`}>
                      {target.label}
                    </option>
                  ) : null,
                )}
              </optgroup>
            </select>
          )}
          <p id={`${uid}-target-help`} className="mt-1 text-[11px] text-muted-foreground">
            A real foreign key, scoped to this workspace. Only a short allowlist of
            built-in record types can be linked to — a key into the audit log or the
            billing tables would let a record pin our own rows in place.
            {draft.isRequired
              ? " Because this field is required, deleting the linked record will be refused rather than blanking this one."
              : " Because this field is optional, deleting the linked record leaves this field empty."}
          </p>
          <Problem message={problemFor("relation")} />
        </div>
      ) : null}

      {draft.fieldType === "number" ? (
        <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
          <strong className="font-medium text-foreground">Precision is fixed</strong> at{" "}
          <code className="font-mono">numeric(38,10)</code> — 38 significant digits, 10 of
          them after the point, exact decimal rather than floating point. The engine does
          not offer a per-field precision, because narrowing one later would be a table
          rewrite that silently rounds values already stored.
        </p>
      ) : null}

      {draft.fieldType === "currency" ? (
        <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
          <strong className="font-medium text-foreground">Money is stored in paise</strong>{" "}
          as a whole number. ₹1,250.50 is <code className="font-mono">125050</code>. The
          currency belongs to the workspace and is not stored per record — a per-row
          currency invites summing two of them into one number.
        </p>
      ) : null}

      {/* ---------------- Flags ---------------- */}
      <fieldset className="rounded-md border border-border p-3">
        <legend className="px-1 text-xs font-medium">Behaviour</legend>

        <div className="space-y-2">
          <Flag
            id={`${uid}-required`}
            checked={draft.isRequired}
            disabled={exists}
            onChange={(isRequired) => set({ isRequired })}
            label="Required"
            hint={
              exists
                ? "Fixed — this is a NOT NULL constraint on a live column."
                : "Every record must have a value. Enforced by the column, not by a form."
            }
          />

          <Flag
            id={`${uid}-unique`}
            checked={draft.isUnique}
            disabled={exists || !option.supportsUnique}
            onChange={(isUnique) => set({ isUnique })}
            label="No two records may share a value"
            hint={
              !option.supportsUnique
                ? `A "${option.label}" field cannot be unique.`
                : exists
                  ? "Fixed — this is a unique index on a live table."
                  : "A real UNIQUE index, scoped to this workspace."
            }
          />

          <Flag
            id={`${uid}-indexed`}
            checked={draft.isIndexed}
            disabled={exists || !option.supportsIndex}
            onChange={(isIndexed) => set({ isIndexed })}
            label="Index it for filtering and sorting"
            hint={
              !option.supportsIndex
                ? `A "${option.label}" field cannot be indexed.`
                : exists
                  ? "Fixed — indexes are added and dropped separately from a field edit."
                  : "Faster to read, slower to write. Every index is written on every insert and update."
            }
          />

          <Flag
            id={`${uid}-grid`}
            checked={draft.showInGrid}
            onChange={(showInGrid) => set({ showInGrid })}
            label="Show in the list"
            hint="Whether this field gets a column in the record list."
          />

          <Flag
            id={`${uid}-hidden`}
            checked={draft.isHidden}
            onChange={(isHidden) => set({ isHidden })}
            label="Hide from forms"
            hint="Stops showing the field. The column and every value in it stay exactly where they are — that is the difference between hiding a field and removing one."
          />
        </div>
        <Problem message={problemFor("isUnique") ?? problemFor("isIndexed")} />
      </fieldset>

      {/* ---------------- Help text ---------------- */}
      <div>
        <label htmlFor={`${uid}-help`} className="mb-1 block text-xs font-medium">
          Help text (optional)
        </label>
        <Textarea
          id={`${uid}-help`}
          value={draft.helpText}
          maxLength={500}
          onChange={(event) => set({ helpText: event.target.value })}
          placeholder="Shown under the input when somebody fills this in."
        />
      </div>

      <div>
        <label htmlFor={`${uid}-placeholder`} className="mb-1 block text-xs font-medium">
          Placeholder (optional)
        </label>
        <Input
          id={`${uid}-placeholder`}
          value={draft.placeholder}
          maxLength={200}
          onChange={(event) => set({ placeholder: event.target.value })}
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* CHOICES                                                             */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ VALUE AND LABEL ARE SEPARATE BOXES, DELIBERATELY.
 *
 * The VALUE lands in the column and inside the CHECK constraint. The
 * LABEL is what a person reads. Keeping them apart is what makes renaming
 * "In progress" to "Under way" a metadata edit rather than an `UPDATE`
 * over every row plus a constraint rebuild.
 */
function ChoiceEditor({
  uid,
  draft,
  readOnly,
  onChange,
  error,
}: {
  uid: string;
  draft: DraftField;
  readOnly: boolean;
  onChange: (options: DraftField["options"]) => void;
  error: string | null;
}) {
  const options = draft.options;

  if (readOnly) {
    return (
      <div className="rounded-md border border-border bg-muted/30 p-3">
        <p className="text-xs font-medium">Choices</p>
        <ul className="mt-1.5 space-y-0.5">
          {options.map((option) => (
            <li key={option.value} className="text-xs">
              {option.label}{" "}
              <code className="font-mono text-muted-foreground">({option.value})</code>
            </li>
          ))}
        </ul>
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          Fixed here. The choices are a CHECK constraint on the column, and changing
          them means dropping and recreating it — which is not part of a field edit.
        </p>
      </div>
    );
  }

  return (
    <fieldset className="rounded-md border border-border p-3">
      <legend className="px-1 text-xs font-medium">
        Choices
        <span className="ml-0.5 text-destructive" aria-hidden="true">
          *
        </span>
        <span className="sr-only"> (required)</span>
      </legend>

      <table className="w-full text-xs">
        <caption className="sr-only">
          {options.length} of at most {MAX_SELECT_OPTIONS} choices
        </caption>
        <thead className="text-left text-muted-foreground">
          <tr>
            <th scope="col" className="pb-1 font-medium">
              Stored value
            </th>
            <th scope="col" className="pb-1 font-medium">
              Label
            </th>
            <th scope="col" className="pb-1 font-medium">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {options.map((option, index) => (
            <tr key={index}>
              <td className="py-0.5 pr-2">
                <Input
                  aria-label={`Choice ${index + 1} stored value`}
                  value={option.value}
                  maxLength={59}
                  className="h-8 font-mono text-xs"
                  onChange={(event) => {
                    const next = [...options];
                    next[index] = { ...option, value: event.target.value };
                    onChange(next);
                  }}
                />
              </td>
              <td className="py-0.5 pr-2">
                <Input
                  aria-label={`Choice ${index + 1} label`}
                  value={option.label}
                  maxLength={80}
                  className="h-8 text-xs"
                  onChange={(event) => {
                    const next = [...options];
                    next[index] = { ...option, label: event.target.value };
                    onChange(next);
                  }}
                />
              </td>
              <td className="py-0.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove choice ${option.label || option.value || index + 1}`}
                  onClick={() => onChange(options.filter((_, i) => i !== index))}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-2"
        disabled={options.length >= MAX_SELECT_OPTIONS}
        onClick={() => onChange([...options, { value: "", label: "" }])}
      >
        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
        Add a choice
      </Button>

      <p className="mt-1.5 text-[11px] text-muted-foreground" id={`${uid}-choices-help`}>
        The stored value goes into the column and into a CHECK constraint, so it stays
        simple: letters, digits, spaces, dots, hyphens and underscores. The label is what
        people read and can be changed later without touching a single row.
      </p>
      <Problem message={error} />
    </fieldset>
  );
}

/* ------------------------------------------------------------------ */
/* SMALL PARTS                                                         */
/* ------------------------------------------------------------------ */

function Flag({
  id,
  checked,
  disabled = false,
  onChange,
  label,
  hint,
}: {
  id: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <div className="flex items-start gap-2">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        aria-describedby={`${id}-hint`}
        className="mt-0.5 h-4 w-4 rounded border-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      />
      <div>
        <label htmlFor={id} className="text-xs font-medium">
          {label}
        </label>
        <p id={`${id}-hint`} className="text-[11px] text-muted-foreground">
          {hint}
        </p>
      </div>
    </div>
  );
}

/**
 * ⚠️ `role="alert"` AND TEXT. Not a red border on its own — a border is
 * colour-only meaning, and this form is read by the same people the
 * inventory grid's note is about.
 */
export function Problem({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="mt-1 text-[11px] text-destructive">
      {message}
    </p>
  );
}

function targetKey(draft: DraftField): string {
  if (!draft.relation) return "";
  return draft.relation.kind === "object"
    ? `object:${draft.relation.objectId}`
    : `core:${draft.relation.table}`;
}

function parseTargetKey(value: string): DraftField["relation"] {
  if (value.startsWith("object:")) {
    return { kind: "object", objectId: value.slice("object:".length) };
  }
  if (value.startsWith("core:")) {
    return { kind: "core", table: value.slice("core:".length) };
  }
  return null;
}

function describeTarget(
  draft: DraftField,
  targets: readonly RelationTargetOption[],
): string {
  if (!draft.relation) return "—";
  if (draft.relation.kind === "core") return draft.relation.table;
  const objectId = draft.relation.objectId;
  const found = targets.find(
    (t) => t.kind === "object" && t.objectId === objectId,
  );
  return found?.label ?? "another record type";
}
