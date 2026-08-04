"use client";

/**
 * Ordence — Reusable Form Fields
 * Version: v0.7.0-alpha
 *
 * A thin, typed layer over react-hook-form. Every field here:
 *   - binds through `register()` so validation is automatic
 *   - renders its own label, help text and error message
 *   - wires `aria-invalid` and `aria-describedby` so screen readers announce
 *     the error, not just show it visually
 *
 * `DynamicField` is the interesting one: it takes a row from
 * `custom_field_definitions` and renders the right input for its declared type.
 * That is what lets a tenant invent an entity at 10am and have a working form
 * for it at 10:01, with no code change and no deployment.
 */

import * as React from "react";
import type {
  FieldValues,
  UseFormRegister,
  FieldErrors,
  Path,
  RegisterOptions,
} from "react-hook-form";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/* SHARED WRAPPER                                                      */
/* ------------------------------------------------------------------ */

type FieldShellProps = {
  name: string;
  label: string;
  required?: boolean;
  help?: string;
  error?: string;
  className?: string;
  children: (ids: { id: string; describedBy: string | undefined }) => React.ReactNode;
};

function FieldShell({ name, label, required, help, error, className, children }: FieldShellProps) {
  const id = `field-${name}`;
  const helpId = help ? `${id}-help` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  // Both ids when both exist — screen readers read them in order.
  const describedBy = [helpId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={id} required={required}>
        {label}
      </Label>

      {children({ id, describedBy })}

      {help && !error && (
        <p id={helpId} className="text-xs text-muted-foreground">
          {help}
        </p>
      )}
      {error && (
        // role="alert" makes the error announced the moment it appears.
        <p id={errorId} role="alert" className="text-xs font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** Pull a possibly-nested error message out of react-hook-form's error object. */
export function errorMessage<T extends FieldValues>(
  errors: FieldErrors<T>,
  name: string,
): string | undefined {
  const parts = name.split(".");
  let current: unknown = errors;
  for (const part of parts) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  const msg = (current as { message?: unknown } | undefined)?.message;
  return typeof msg === "string" ? msg : undefined;
}

/* ------------------------------------------------------------------ */
/* TEXT                                                                */
/* ------------------------------------------------------------------ */

export type TextFieldProps<T extends FieldValues> = {
  name: Path<T>;
  label: string;
  register: UseFormRegister<T>;
  errors: FieldErrors<T>;
  type?: "text" | "email" | "tel" | "url" | "number" | "date" | "datetime-local" | "password";
  placeholder?: string;
  required?: boolean;
  help?: string;
  disabled?: boolean;
  step?: string;
  options?: RegisterOptions<T, Path<T>>;
  className?: string;
};

export function TextField<T extends FieldValues>({
  name, label, register, errors, type = "text",
  placeholder, required, help, disabled, step, options, className,
}: TextFieldProps<T>) {
  const error = errorMessage(errors, name);
  return (
    <FieldShell name={name} label={label} required={required} help={help} error={error} className={className}>
      {({ id, describedBy }) => (
        <Input
          id={id}
          type={type}
          step={step}
          placeholder={placeholder}
          disabled={disabled}
          // `required` reaches the CONTROL, not just the label's asterisk.
          // A visual asterisk is invisible to a screen reader; this is what
          // makes the field announce itself as required.
          required={required}
          aria-required={required ? true : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={error ? "border-destructive focus-visible:ring-destructive" : undefined}
          {...register(name, options)}
        />
      )}
    </FieldShell>
  );
}

/* ------------------------------------------------------------------ */
/* TEXTAREA                                                            */
/* ------------------------------------------------------------------ */

export function TextareaField<T extends FieldValues>({
  name, label, register, errors, placeholder, required, help, disabled, rows = 3, className,
}: {
  name: Path<T>;
  label: string;
  register: UseFormRegister<T>;
  errors: FieldErrors<T>;
  placeholder?: string;
  required?: boolean;
  help?: string;
  disabled?: boolean;
  rows?: number;
  className?: string;
}) {
  const error = errorMessage(errors, name);
  return (
    <FieldShell name={name} label={label} required={required} help={help} error={error} className={className}>
      {({ id, describedBy }) => (
        <Textarea
          id={id}
          rows={rows}
          placeholder={placeholder}
          disabled={disabled}
          required={required}
          aria-required={required ? true : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={error ? "border-destructive focus-visible:ring-destructive" : undefined}
          {...register(name)}
        />
      )}
    </FieldShell>
  );
}

/* ------------------------------------------------------------------ */
/* SELECT                                                              */
/* ------------------------------------------------------------------ */

export type SelectOption = { label: string; value: string };

export function SelectField<T extends FieldValues>({
  name, label, register, errors, choices, required, help, disabled, placeholder = "Select…", className,
}: {
  name: Path<T>;
  label: string;
  register: UseFormRegister<T>;
  errors: FieldErrors<T>;
  choices: readonly SelectOption[];
  required?: boolean;
  help?: string;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}) {
  const error = errorMessage(errors, name);
  return (
    <FieldShell name={name} label={label} required={required} help={help} error={error} className={className}>
      {({ id, describedBy }) => (
        <Select
          id={id}
          disabled={disabled}
          required={required}
          aria-required={required ? true : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={error ? "border-destructive focus-visible:ring-destructive" : undefined}
          {...register(name)}
        >
          <option value="">{placeholder}</option>
          {choices.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </Select>
      )}
    </FieldShell>
  );
}

/* ------------------------------------------------------------------ */
/* CHECKBOX                                                            */
/* ------------------------------------------------------------------ */

export function CheckboxField<T extends FieldValues>({
  name, label, register, errors, help, disabled, className, required,
}: {
  name: Path<T>;
  label: string;
  register: UseFormRegister<T>;
  errors: FieldErrors<T>;
  help?: string;
  disabled?: boolean;
  className?: string;
  required?: boolean;
}) {
  const error = errorMessage(errors, name);
  const id = `field-${name}`;
  return (
    <div className={cn("space-y-1", className)}>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="checkbox"
          disabled={disabled}
          required={required}
          aria-required={required ? true : undefined}
          aria-invalid={error ? true : undefined}
          className="h-4 w-4 cursor-pointer rounded border-input accent-[hsl(var(--primary))]"
          {...register(name)}
        />
        <Label htmlFor={id} className="cursor-pointer font-normal">
          {label}
        </Label>
      </div>
      {help && !error && <p className="text-xs text-muted-foreground">{help}</p>}
      {error && <p role="alert" className="text-xs font-medium text-destructive">{error}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* DYNAMIC FIELD — the custom-object engine's UI half                   */
/* ------------------------------------------------------------------ */

/** The subset of `custom_field_definitions` the renderer needs. */
export type DynamicFieldSpec = {
  fieldName: string;
  label: string;
  fieldType:
    | "text" | "textarea" | "number" | "currency" | "date" | "datetime"
    | "select" | "multiselect" | "boolean" | "email" | "phone" | "url";
  isRequired?: boolean;
  helpText?: string | null;
  placeholder?: string | null;
  options?: Array<{ label: string; value: string; color?: string }>;
  validation?: {
    min?: number; max?: number; minLength?: number; maxLength?: number;
    currencyCode?: string; precision?: number;
  } | null;
};

/**
 * Render one input from a field DEFINITION rather than from hand-written JSX.
 *
 * The field name is prefixed (usually `data.` or `dynamicAttributes.`) so the
 * values land in the right nested object for the server action, which then
 * validates them against the same definitions. Client and server read the same
 * source of truth — the UI cannot drift from what the server will accept.
 */
export function DynamicField<T extends FieldValues>({
  spec,
  prefix,
  register,
  errors,
  disabled,
}: {
  spec: DynamicFieldSpec;
  prefix: string;
  register: UseFormRegister<T>;
  errors: FieldErrors<T>;
  disabled?: boolean;
}) {
  const name = `${prefix}.${spec.fieldName}` as Path<T>;
  const common = {
    name,
    label: spec.label,
    register,
    errors,
    required: spec.isRequired,
    help: spec.helpText ?? undefined,
    placeholder: spec.placeholder ?? undefined,
    disabled,
  };

  switch (spec.fieldType) {
    case "textarea":
      return <TextareaField {...common} rows={4} />;

    case "number":
      return (
        <TextField
          {...common}
          type="number"
          step={spec.validation?.precision ? `0.${"0".repeat(spec.validation.precision - 1)}1` : "any"}
        />
      );

    case "currency":
      return (
        <TextField
          {...common}
          type="number"
          step="0.01"
          label={`${spec.label} (${spec.validation?.currencyCode ?? "INR"})`}
        />
      );

    case "date":
      return <TextField {...common} type="date" />;

    case "datetime":
      return <TextField {...common} type="datetime-local" />;

    case "email":
      return <TextField {...common} type="email" />;

    case "phone":
      return <TextField {...common} type="tel" />;

    case "url":
      return <TextField {...common} type="url" placeholder={spec.placeholder ?? "https://"} />;

    case "boolean":
      return <CheckboxField {...common} />;

    case "select":
      return <SelectField {...common} choices={spec.options ?? []} />;

    case "multiselect":
      // Native multi-select: keyboard accessible and zero JS.
      return (
        <MultiSelectField
          name={name}
          label={spec.label}
          register={register}
          errors={errors}
          choices={spec.options ?? []}
          required={spec.isRequired}
          help={spec.helpText ?? "Hold ⌘ (or Ctrl) to choose more than one."}
          disabled={disabled}
        />
      );

    case "text":
    default:
      return <TextField {...common} type="text" />;
  }
}

function MultiSelectField<T extends FieldValues>({
  name, label, register, errors, choices, required, help, disabled,
}: {
  name: Path<T>;
  label: string;
  register: UseFormRegister<T>;
  errors: FieldErrors<T>;
  choices: readonly SelectOption[];
  required?: boolean;
  help?: string;
  disabled?: boolean;
}) {
  const error = errorMessage(errors, name);
  return (
    <FieldShell name={name} label={label} required={required} help={help} error={error}>
      {({ id, describedBy }) => (
        <Select
          id={id}
          multiple
          size={Math.min(5, Math.max(3, choices.length))}
          disabled={disabled}
          required={required}
          aria-required={required ? true : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn("h-auto py-1.5", error && "border-destructive")}
          {...register(name)}
        >
          {choices.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </Select>
      )}
    </FieldShell>
  );
}

/**
 * Render an entire object definition's fields in order.
 * This is the whole "no-migration custom entity" promise, made visible.
 */
export function DynamicFieldSet<T extends FieldValues>({
  fields,
  prefix,
  register,
  errors,
  disabled,
  columns = 2,
}: {
  fields: DynamicFieldSpec[];
  prefix: string;
  register: UseFormRegister<T>;
  errors: FieldErrors<T>;
  disabled?: boolean;
  columns?: 1 | 2;
}) {
  if (fields.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
        This object has no fields defined yet.
      </p>
    );
  }

  return (
    <div className={cn("grid gap-4", columns === 2 && "sm:grid-cols-2")}>
      {fields.map((spec) => (
        <div
          key={spec.fieldName}
          // Long-form inputs get the full width.
          className={cn(
            (spec.fieldType === "textarea" || spec.fieldType === "multiselect") && "sm:col-span-2",
          )}
        >
          <DynamicField
            spec={spec}
            prefix={prefix}
            register={register}
            errors={errors}
            disabled={disabled}
          />
        </div>
      ))}
    </div>
  );
}
