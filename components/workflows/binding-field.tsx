"use client";

/**
 * Ordence — Variable Binding
 * Version: v0.24.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THE BINDING PICKER IS A `<select>` NEXT TO A TEXT BOX
 * ══════════════════════════════════════════════════════════════════════
 * A field like an email subject is part prose and part reference:
 * `Booking for {{ trigger.record.name }}`. Two designs are tempting and
 * both are worse:
 *
 *   • A rich token editor — a contenteditable with chips. It looks
 *     right, and it is a keyboard trap, it fights every screen reader,
 *     and it cannot be pasted into.
 *   • A bare text box — honest, and it requires the author to know the
 *     binding language by heart, so they guess `{{ lead.name }}` and get
 *     an email addressed to nobody.
 *
 * So: a real `<input>` holding real text, plus a real `<select>` that
 * appends a binding at the end. Both are native, both are labelled, both
 * work with a keyboard, and the value in the box is exactly what will be
 * stored.
 *
 * ⚠️ THE SUGGESTIONS ARE SCOPE-AWARE. Only steps that have already run
 * at this position are offered — see `bindingSuggestions` in
 * `step-tree.ts`. Offering a later step's output would produce a binding
 * that resolves to nothing, and "the email went out blank" is discovered
 * by the recipient.
 */

import { useId } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { asBinding, type BindingSuggestion } from "./step-tree";

export type BindingInputProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  suggestions: readonly BindingSuggestion[];
  placeholder?: string;
  description?: string;
  multiline?: boolean;
  required?: boolean;
  /** Rendered under the field, in the destructive colour AND with a prefix. */
  error?: string | null;
};

export function BindingInput({
  label,
  value,
  onChange,
  suggestions,
  placeholder,
  description,
  multiline = false,
  required = false,
  error = null,
}: BindingInputProps) {
  const fieldId = useId();
  const pickerId = `${fieldId}-binding`;
  const helpId = `${fieldId}-help`;

  const groups = groupSuggestions(suggestions);

  return (
    <div>
      <label htmlFor={fieldId} className="mb-1 block text-xs font-medium">
        {label}
        {required ? (
          <>
            <span className="ml-0.5 text-destructive" aria-hidden="true">
              *
            </span>
            <span className="sr-only"> (required)</span>
          </>
        ) : null}
      </label>

      <div className="flex flex-col gap-1.5 sm:flex-row">
        {multiline ? (
          <Textarea
            id={fieldId}
            value={value}
            placeholder={placeholder}
            aria-describedby={description || error ? helpId : undefined}
            aria-invalid={error ? true : undefined}
            onChange={(event) => onChange(event.target.value)}
            className="min-h-[86px] flex-1 text-sm"
          />
        ) : (
          <Input
            id={fieldId}
            value={value}
            placeholder={placeholder}
            aria-describedby={description || error ? helpId : undefined}
            aria-invalid={error ? true : undefined}
            onChange={(event) => onChange(event.target.value)}
            className="flex-1"
          />
        )}

        <div className="sm:w-56">
          <label htmlFor={pickerId} className="sr-only">
            Insert a value into {label}
          </label>
          <select
            id={pickerId}
            value=""
            onChange={(event) => {
              const path = event.target.value;
              if (!path) return;
              const separator = value.length === 0 || value.endsWith(" ") ? "" : " ";
              onChange(`${value}${separator}${asBinding(path)}`);
              // Reset so the same value can be inserted twice.
              event.target.value = "";
            }}
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="">Insert a value…</option>
            {groups.map(([group, entries]) => (
              <optgroup key={group} label={group}>
                {entries.map((entry) => (
                  <option key={entry.path} value={entry.path}>
                    {entry.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
      </div>

      {description || error ? (
        <p id={helpId} className="mt-1 text-[11px]">
          {error ? (
            <span className="text-destructive">
              <span className="sr-only">Error: </span>
              {error}
            </span>
          ) : (
            <span className="text-muted-foreground">{description}</span>
          )}
        </p>
      ) : null}
    </div>
  );
}

function groupSuggestions(
  suggestions: readonly BindingSuggestion[],
): [BindingSuggestion["group"], BindingSuggestion[]][] {
  const order: BindingSuggestion["group"][] = ["Trigger", "Loop", "Earlier steps"];
  return order
    .map(
      (group) =>
        [group, suggestions.filter((entry) => entry.group === group)] as [
          BindingSuggestion["group"],
          BindingSuggestion[],
        ],
    )
    .filter(([, entries]) => entries.length > 0);
}
