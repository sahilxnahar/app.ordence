"use client";

/**
 * Ordence — A Form Generated From Field Definitions
 * Version: v0.27.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE INPUT IS CHOSEN BY THE FIELD TYPE, WHICH IS CHOSEN BY THE ENGINE
 * ══════════════════════════════════════════════════════════════════════
 * There is one `switch` below and it is exhaustive over
 * `DynamicFieldType`. A type added to `lib/dynamic/field-types.ts` and not
 * added here is a TypeScript error, not a blank box in production — which
 * is the entire argument for the switch having no `default` that renders
 * something plausible.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS FORM DELIBERATELY DOES NOT DO
 * ══════════════════════════════════════════════════════════════════════
 * It does not validate. `validateRecordValues()` runs on the server against
 * the field list read from the database, and behind it the column types
 * themselves refuse what it missed. A second copy of those rules here would
 * be a copy that drifts, and the drift is invisible: the form would accept
 * something the server refuses, or refuse something the server accepts, and
 * only the second is ever reported.
 *
 * What it does instead is SHAPE the input — a date picker for a date, a
 * checkbox for a boolean, digits for money — so the value that arrives is
 * the one the validator expects, and render the validator's own sentence
 * against the field it belongs to when it is not.
 */

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  datetimeInputToIso,
  formatPaise,
  toDateInputValue,
  toDateTimeInputValue,
  type ObjectFieldRow,
} from "./presentation";
import type { ActionResult } from "@/lib/validators/crm";

/** A record this field may point at, resolved by the page. */
export type RelationChoice = { id: string; label: string };

export type RecordFormProps = {
  objectId: string;
  objectLabel: string;
  fields: readonly ObjectFieldRow[];
  /** `null` when creating. */
  record: Record<string, unknown> | null;
  /**
   * Keyed by field api name. Present only for relations pointing at
   * another custom record type — there is no generic reader for the core
   * tables, and inventing one here would be a second query planner.
   */
  relationChoices?: Record<string, RelationChoice[]>;
  onSubmit: (input: unknown) => Promise<ActionResult<Record<string, unknown>>>;
  /** Where to go after a successful save. */
  redirectTo: string;
  cancelHref: string;
};

type FormState = Record<string, string | boolean | string[]>;

function initialState(
  fields: readonly ObjectFieldRow[],
  record: Record<string, unknown> | null,
): FormState {
  const state: FormState = {};
  for (const field of fields) {
    const value = record ? record[field.apiName] : undefined;
    switch (field.fieldType) {
      case "boolean":
        state[field.apiName] = value === true || value === "true";
        break;
      case "multi_select":
        state[field.apiName] = Array.isArray(value) ? value.map(String) : [];
        break;
      case "date":
        state[field.apiName] = value == null ? "" : toDateInputValue(value);
        break;
      case "datetime":
        state[field.apiName] = value == null ? "" : toDateTimeInputValue(value);
        break;
      default:
        state[field.apiName] = value == null ? "" : String(value);
    }
  }
  return state;
}

export function RecordForm({
  objectId,
  objectLabel,
  fields,
  record,
  relationChoices = {},
  onSubmit,
  redirectTo,
  cancelHref,
}: RecordFormProps) {
  const router = useRouter();
  const editing = record !== null;
  const [state, setState] = useState<FormState>(() => initialState(fields, record));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  /*
   * ⚠️ A HIDDEN FIELD IS NOT RENDERED — UNLESS IT IS REQUIRED.
   *
   * `isHidden` means "stop showing this". A required hidden field is a
   * contradiction the engine allows and the form cannot silently resolve:
   * omitting it makes every create fail with a message about a field
   * nobody can see. So it is shown, in its own section, saying why.
   */
  const visible = fields.filter((f) => !f.isHidden);
  const hiddenButRequired = fields.filter((f) => f.isHidden && f.isRequired);

  const set = (apiName: string, value: string | boolean | string[]) => {
    setState((current) => ({ ...current, [apiName]: value }));
  };

  const submit = async () => {
    setPending(true);
    setError(null);
    setFieldErrors({});
    try {
      const values: Record<string, unknown> = {};
      for (const field of [...visible, ...hiddenButRequired]) {
        const raw = state[field.apiName];

        if (field.fieldType === "boolean") {
          values[field.apiName] = raw === true;
          continue;
        }

        if (field.fieldType === "multi_select") {
          const list = Array.isArray(raw) ? raw : [];
          // An empty selection is `null`, not `[]`, so a required field
          // reports "is required" rather than storing an empty array.
          values[field.apiName] = list.length > 0 ? list : null;
          continue;
        }

        const text = typeof raw === "string" ? raw : "";

        if (text.trim() === "") {
          // ⚠️ On CREATE an empty box is OMITTED, so a required field is
          // reported as "is required". On UPDATE it is sent as null,
          // because update is a PATCH and omitting it would mean "leave it
          // alone" — making it impossible to clear a value.
          if (editing) values[field.apiName] = null;
          continue;
        }

        values[field.apiName] =
          field.fieldType === "datetime" ? datetimeInputToIso(text) : text;
      }

      const result = await onSubmit(
        editing
          ? { objectId, recordId: String(record.id), values }
          : { objectId, values },
      );

      if (!result.ok) {
        setError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
        return;
      }

      router.push(redirectTo);
      router.refresh();
    } finally {
      setPending(false);
    }
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {error ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}

      <div className="space-y-4">
        {visible.map((field) => (
          <FieldInput
            key={field.id}
            field={field}
            value={state[field.apiName]!}
            errors={fieldErrors[field.apiName] ?? []}
            choices={relationChoices[field.apiName] ?? []}
            onChange={(value) => set(field.apiName, value)}
          />
        ))}
      </div>

      {hiddenButRequired.length > 0 ? (
        <fieldset className="rounded-md border border-border p-3">
          <legend className="px-1 text-xs font-medium">Hidden but required</legend>
          <p className="mb-2 text-[11px] text-muted-foreground">
            These fields are marked hidden and also required. They are shown here
            because a required field that nothing renders makes every save fail with a
            message about a field nobody can see.
          </p>
          <div className="space-y-4">
            {hiddenButRequired.map((field) => (
              <FieldInput
                key={field.id}
                field={field}
                value={state[field.apiName]!}
                errors={fieldErrors[field.apiName] ?? []}
                choices={relationChoices[field.apiName] ?? []}
                onChange={(value) => set(field.apiName, value)}
              />
            ))}
          </div>
        </fieldset>
      ) : null}

      {/* Errors the server reported against a field this form does not show. */}
      {Object.entries(fieldErrors)
        .filter(([key]) => !fields.some((f) => f.apiName === key))
        .map(([key, messages]) => (
          <p key={key} role="alert" className="text-xs text-destructive">
            {key}: {messages.join(" ")}
          </p>
        ))}

      <div className="flex justify-end gap-2">
        {/*
          ⚠️ NOT `<Button asChild disabled>`. `Slot` forwards every prop to
          the anchor, and `disabled` is not an attribute an <a> has — it
          renders, does nothing, and reads as a control that is off when it
          is not. A link either navigates or is not a link.
        */}
        <Button type="button" variant="outline" asChild>
          <Link href={cancelHref}>Cancel</Link>
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : editing ? "Save changes" : `Create ${objectLabel}`}
        </Button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* ONE FIELD                                                           */
/* ------------------------------------------------------------------ */

function FieldInput({
  field,
  value,
  errors,
  choices,
  onChange,
}: {
  field: ObjectFieldRow;
  value: string | boolean | string[];
  errors: string[];
  choices: RelationChoice[];
  onChange: (value: string | boolean | string[]) => void;
}) {
  const id = `f-${field.apiName}`;
  const labelId = `${id}-label`;
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const describedBy = [field.helpText ? helpId : null, errors.length ? errorId : null]
    .filter(Boolean)
    .join(" ");

  const text = typeof value === "string" ? value : "";
  const common = {
    id,
    "aria-describedby": describedBy || undefined,
    "aria-invalid": errors.length > 0 ? (true as const) : undefined,
    placeholder: field.placeholder ?? undefined,
  };

  /*
   * ⚠️ A `multi_select` IS A GROUP OF CHECKBOXES, AND `<label htmlFor>`
   * MAY ONLY POINT AT A FORM CONTROL. Pointing one at the wrapping <div>
   * is invalid HTML that browsers accept and screen readers ignore — the
   * field would simply be announced as unlabelled. So the group gets a
   * <span id> and `aria-labelledby`, and everything else keeps the real
   * <label htmlFor>.
   */
  const isGroup = field.fieldType === "multi_select";
  const labelContent = (
    <>
      {field.label}
      {field.isRequired ? (
        <>
          <span className="ml-0.5 text-destructive" aria-hidden="true">
            *
          </span>
          <span className="sr-only"> (required)</span>
        </>
      ) : null}
    </>
  );

  return (
    <div>
      {isGroup ? (
        <span id={labelId} className="mb-1 block text-xs font-medium">
          {labelContent}
        </span>
      ) : (
        <label htmlFor={id} className="mb-1 block text-xs font-medium">
          {labelContent}
        </label>
      )}

      {renderControl()}

      {field.helpText ? (
        <p id={helpId} className="mt-1 text-[11px] text-muted-foreground">
          {field.helpText}
        </p>
      ) : null}

      {field.fieldType === "currency" && text.trim() !== "" ? (
        <p className="mt-1 text-[11px] text-muted-foreground">
          = {formatPaise(text.trim())}
        </p>
      ) : null}

      {errors.length > 0 ? (
        <p id={errorId} role="alert" className="mt-1 text-[11px] text-destructive">
          {errors.join(" ")}
        </p>
      ) : null}
    </div>
  );

  function renderControl() {
    switch (field.fieldType) {
      case "long_text":
        return (
          <Textarea
            {...common}
            value={text}
            maxLength={20_000}
            onChange={(event) => onChange(event.target.value)}
          />
        );

      case "boolean":
        return (
          <div className="flex items-center gap-2">
            <input
              {...common}
              type="checkbox"
              checked={value === true}
              onChange={(event) => onChange(event.target.checked)}
              className="h-4 w-4 rounded border-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <span className="text-xs text-muted-foreground">
              {value === true ? "Yes" : "No"}
            </span>
          </div>
        );

      case "number":
        return (
          <Input
            {...common}
            value={text}
            inputMode="decimal"
            onChange={(event) => onChange(event.target.value)}
          />
        );

      case "currency":
        return (
          <Input
            {...common}
            value={text}
            inputMode="numeric"
            placeholder={field.placeholder ?? "125050"}
            onChange={(event) => onChange(event.target.value)}
          />
        );

      case "date":
        return (
          <Input
            {...common}
            type="date"
            value={text}
            onChange={(event) => onChange(event.target.value)}
          />
        );

      case "datetime":
        return (
          <Input
            {...common}
            type="datetime-local"
            value={text}
            onChange={(event) => onChange(event.target.value)}
          />
        );

      case "email":
        return (
          <Input
            {...common}
            type="email"
            value={text}
            onChange={(event) => onChange(event.target.value)}
          />
        );

      case "phone":
        return (
          <Input
            {...common}
            type="tel"
            value={text}
            onChange={(event) => onChange(event.target.value)}
          />
        );

      case "url":
        return (
          <Input
            {...common}
            type="url"
            value={text}
            placeholder={field.placeholder ?? "https://"}
            onChange={(event) => onChange(event.target.value)}
          />
        );

      case "select":
        return (
          <select
            {...common}
            value={text}
            onChange={(event) => onChange(event.target.value)}
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="">{field.isRequired ? "Choose…" : "— none —"}</option>
            {field.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        );

      case "multi_select": {
        const selected = Array.isArray(value) ? value : [];
        /*
         * ⚠️ CHECKBOXES, NOT A `<select multiple>`. Multi-select boxes
         * require ctrl-click to add and silently clear the whole selection
         * on a plain click — a behaviour that loses somebody's work
         * quietly and is close to unusable on a touch screen.
         */
        return (
          <div
            role="group"
            id={id}
            aria-labelledby={labelId}
            aria-describedby={describedBy || undefined}
            className="space-y-1 rounded-md border border-input p-2"
          >
            {field.options.map((option) => {
              const optionId = `${id}-${option.value}`;
              return (
                <div key={option.value} className="flex items-center gap-2">
                  <input
                    id={optionId}
                    type="checkbox"
                    checked={selected.includes(option.value)}
                    onChange={(event) =>
                      onChange(
                        event.target.checked
                          ? [...selected, option.value]
                          : selected.filter((v) => v !== option.value),
                      )
                    }
                    className="h-4 w-4 rounded border-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  <label htmlFor={optionId} className="text-xs">
                    {option.label}
                  </label>
                </div>
              );
            })}
          </div>
        );
      }

      case "relation":
        if (choices.length > 0) {
          return (
            <select
              {...common}
              value={text}
              onChange={(event) => onChange(event.target.value)}
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">{field.isRequired ? "Choose a record…" : "— none —"}</option>
              {choices.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.label}
                </option>
              ))}
            </select>
          );
        }
        /*
         * ⚠️ NO PICKER FOR A LINK INTO A BUILT-IN TABLE, AND THE FORM SAYS
         * SO. There is no generic reader for `contacts`, `units` and the
         * rest — each has its own permissions and its own idea of what a
         * row is called. Rendering an empty dropdown would read as "there
         * are none"; an id box with a sentence reads as "this is not
         * finished", which is true.
         */
        return (
          <>
            <Input
              {...common}
              value={text}
              className="font-mono"
              placeholder="00000000-0000-0000-0000-000000000000"
              onChange={(event) => onChange(event.target.value)}
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              Paste the id of the record to link to
              {field.relationCoreTable ? ` in ${field.relationCoreTable}` : ""}. A picker
              for built-in record types is not built yet — the link itself is a real
              foreign key and is checked when you save.
            </p>
          </>
        );

      case "text":
        return (
          <Input
            {...common}
            value={text}
            maxLength={500}
            onChange={(event) => onChange(event.target.value)}
          />
        );

      default: {
        // Exhaustive. A new field type is a compile error here, not a
        // blank box in production.
        const exhaustive: never = field.fieldType;
        throw new Error(
          `[dynamic] No input for field type "${String(exhaustive)}". The form is ` +
            `behind the engine — refusing to render a box whose value nothing can read.`,
        );
      }
    }
  }
}
