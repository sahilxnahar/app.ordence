"use client";

/**
 * Ordence — The Field List
 * Version: v0.27.0-alpha
 *
 * Add, edit, reorder and remove the fields of one record type.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE SAME LIST MEANS TWO DIFFERENT THINGS, AND IT SAYS WHICH
 * ══════════════════════════════════════════════════════════════════════
 * On a record type that does not exist yet (`live={false}`) every row is
 * a proposal. Removing one costs nothing, because nothing has been built.
 *
 * On a record type that exists (`live`) every row is a COLUMN. Removing
 * one is `ALTER TABLE … DROP COLUMN` and every value in it goes with it —
 * so the engine demands the field's api name typed back, and this list
 * asks for exactly that rather than putting a checkbox in front of it.
 *
 * ⚠️ REORDERING IS UP/DOWN BUTTONS, NEVER DRAG-ONLY. Drag is unreachable
 * from a keyboard and unusable with a screen reader. Same call as
 * `components/workflows/step-list.tsx`.
 */

import { useState } from "react";
import { ChevronDown, ChevronUp, Pencil, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldEditor, Problem } from "./field-editor";
import { LimitMeter } from "./limit-meter";
import {
  checkDraftField,
  effectiveApiName,
  fieldTypeOption,
  newDraftField,
  FIELD_LIMIT_EXPLANATION,
  INDEX_LIMIT_EXPLANATION,
  MAX_FIELDS_PER_OBJECT,
  MAX_INDEXED_FIELDS_PER_OBJECT,
  type DraftField,
  type RelationTargetOption,
} from "./presentation";

export type FieldListProps = {
  fields: DraftField[];
  relationTargets: readonly RelationTargetOption[];
  /** True when these fields are real columns on a real table. */
  live: boolean;
  /** The field that identifies a record. It cannot be removed. */
  displayFieldApiName: string | null;
  busy?: boolean;
  /** Whole-list replacement, used by the draft designer and by reordering. */
  onChange: (fields: DraftField[]) => void;
  /** Only on a live object: one server call per operation. */
  onCommitAdd?: (draft: DraftField) => Promise<string | null>;
  onCommitUpdate?: (draft: DraftField) => Promise<string | null>;
  onCommitRemove?: (draft: DraftField, confirmApiName: string) => Promise<string | null>;
  onCommitReorder?: (fields: DraftField[]) => Promise<string | null>;
};

export function FieldList({
  fields,
  relationTargets,
  live,
  displayFieldApiName,
  busy = false,
  onChange,
  onCommitAdd,
  onCommitUpdate,
  onCommitRemove,
  onCommitReorder,
}: FieldListProps) {
  /** The key of the row open for editing, or "new" while adding. */
  const [editing, setEditing] = useState<string | null>(null);
  const [addDraft, setAddDraft] = useState<DraftField | null>(null);
  const [removing, setRemoving] = useState<DraftField | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const indexed = fields.filter((f) => f.isIndexed).length;
  const atFieldCap = fields.length >= MAX_FIELDS_PER_OBJECT;
  const disabled = busy || pending;

  const run = async (work: () => Promise<string | null>) => {
    setError(null);
    setPending(true);
    try {
      const failure = await work();
      if (failure) setError(failure);
      return failure;
    } finally {
      setPending(false);
    }
  };

  const move = async (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= fields.length) return;
    const next = [...fields];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved!);
    onChange(next);
    if (live && onCommitReorder) await run(() => onCommitReorder(next));
  };

  const startAdd = () => {
    setAddDraft(newDraftField());
    setEditing("new");
  };

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <LimitMeter
          label="Fields on this record type"
          used={fields.length}
          max={MAX_FIELDS_PER_OBJECT}
          explanation={FIELD_LIMIT_EXPLANATION}
        />
        <LimitMeter
          label="Indexed fields"
          used={indexed}
          max={MAX_INDEXED_FIELDS_PER_OBJECT}
          explanation={INDEX_LIMIT_EXPLANATION}
        />
      </div>

      {error ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}

      {/* ---------------- The list ---------------- */}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <caption className="sr-only">
            {fields.length} field{fields.length === 1 ? "" : "s"}, in the order they
            appear on the form
          </caption>
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                Field
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Type
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Rules
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Order and actions
              </th>
            </tr>
          </thead>
          <tbody>
            {fields.map((field, index) => {
              const option = fieldTypeOption(field.fieldType);
              const apiName = effectiveApiName(field);
              const problems = checkDraftField(field, fields);
              const isDisplay = apiName === displayFieldApiName;

              return (
                <tr key={field.key} className="border-t border-border align-top">
                  <td className="px-3 py-2">
                    <div className="font-medium">{field.label || "(no label yet)"}</div>
                    <div className="font-mono text-[11px] text-muted-foreground">
                      {apiName || "(no api name yet)"}
                    </div>
                    {isDisplay ? (
                      <Badge variant="outline" className="mt-1 text-[10px]">
                        Identifies a record
                      </Badge>
                    ) : null}
                    {problems.length > 0 ? (
                      <Problem message={problems[0]!.message} />
                    ) : null}
                  </td>

                  <td className="px-3 py-2 text-xs">
                    {option.label}
                    <div className="text-[11px] text-muted-foreground">
                      <code className="font-mono">{option.pgType}</code>
                      {live ? " · fixed" : ""}
                    </div>
                  </td>

                  <td className="px-3 py-2 text-[11px] text-muted-foreground">
                    {/* ⚠️ Text, not icons or colour. */}
                    {[
                      field.isRequired ? "Required" : "Optional",
                      field.isUnique ? "Unique" : null,
                      field.isIndexed ? "Indexed" : null,
                      field.isHidden ? "Hidden from forms" : null,
                      field.showInGrid ? null : "Not in the list",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </td>

                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={disabled || index === 0}
                        aria-label={`Move ${field.label || apiName} up`}
                        onClick={() => void move(index, -1)}
                      >
                        <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={disabled || index === fields.length - 1}
                        aria-label={`Move ${field.label || apiName} down`}
                        onClick={() => void move(index, 1)}
                      >
                        <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={disabled}
                        aria-label={`Edit ${field.label || apiName}`}
                        onClick={() =>
                          setEditing(editing === field.key ? null : field.key)
                        }
                      >
                        <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="text-destructive"
                        disabled={disabled || isDisplay}
                        aria-label={`Remove ${field.label || apiName}`}
                        title={
                          isDisplay
                            ? "This field identifies a record in lists and pickers. Choose a different display field first."
                            : undefined
                        }
                        onClick={() => {
                          if (live) {
                            setRemoving(field);
                          } else {
                            onChange(fields.filter((f) => f.key !== field.key));
                          }
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}

            {fields.length === 0 ? (
              <tr>
                <td
                  colSpan={4}
                  className="px-3 py-8 text-center text-sm text-muted-foreground"
                >
                  No fields yet. A record type needs at least one — without it every
                  record looks identical.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {/* ---------------- Inline editor for an existing row ---------------- */}
      {fields.map((field) =>
        editing === field.key ? (
          <div key={`edit-${field.key}`} className="rounded-lg border border-border p-4">
            <h3 className="mb-3 text-sm font-semibold">
              {field.label || effectiveApiName(field) || "Field"}
            </h3>
            <FieldEditor
              draft={field}
              siblings={fields}
              relationTargets={relationTargets}
              onAddNewField={
                live
                  ? () => {
                      setEditing(null);
                      startAdd();
                    }
                  : undefined
              }
              onChange={(next) =>
                onChange(fields.map((f) => (f.key === next.key ? next : f)))
              }
            />
            <div className="mt-3 flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={disabled}
                onClick={() => setEditing(null)}
              >
                Close
              </Button>
              {live && onCommitUpdate ? (
                <Button
                  type="button"
                  disabled={disabled || checkDraftField(field, fields).length > 0}
                  onClick={async () => {
                    const failure = await run(() => onCommitUpdate(field));
                    if (!failure) setEditing(null);
                  }}
                >
                  {pending ? "Saving…" : "Save this field"}
                </Button>
              ) : null}
            </div>
          </div>
        ) : null,
      )}

      {/* ---------------- Add ---------------- */}
      {editing === "new" && addDraft ? (
        <div className="rounded-lg border border-dashed border-border p-4">
          <h3 className="mb-3 text-sm font-semibold">New field</h3>
          <FieldEditor
            draft={addDraft}
            siblings={[...fields, addDraft]}
            relationTargets={relationTargets}
            onChange={setAddDraft}
          />
          <div className="mt-3 flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              onClick={() => {
                setAddDraft(null);
                setEditing(null);
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={
                disabled || checkDraftField(addDraft, [...fields, addDraft]).length > 0
              }
              onClick={async () => {
                if (live && onCommitAdd) {
                  const failure = await run(() => onCommitAdd(addDraft));
                  if (failure) return;
                } else {
                  onChange([...fields, addDraft]);
                }
                setAddDraft(null);
                setEditing(null);
              }}
            >
              {pending ? "Adding…" : live ? "Add the column" : "Add field"}
            </Button>
          </div>
          {live ? (
            <p className="mt-2 text-[11px] text-muted-foreground">
              Adding a field runs <code className="font-mono">ALTER TABLE … ADD COLUMN</code>{" "}
              straight away. Existing records get an empty value, which is why a field
              added to a table that already holds records cannot be required.
            </p>
          ) : null}
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          disabled={disabled || atFieldCap}
          onClick={startAdd}
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          Add a field
        </Button>
      )}

      {atFieldCap ? (
        <p className="text-xs text-muted-foreground">
          This record type has the maximum of {MAX_FIELDS_PER_OBJECT} fields. Remove one
          before adding another.
        </p>
      ) : null}

      <RemoveFieldDialog
        field={removing}
        onCancel={() => setRemoving(null)}
        onConfirm={async (field, typed) => {
          if (!onCommitRemove) return "Removing a field is not available here.";
          const failure = await run(() => onCommitRemove(field, typed));
          if (!failure) setRemoving(null);
          return failure;
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* REMOVING A FIELD                                                    */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE API NAME, TYPED BACK. Not a checkbox.
 *
 * `removeDynamicFieldSchema` requires `confirmApiName`, and it requires it
 * because removing a field DROPS THE COLUMN in the same transaction. There
 * is no soft version and there deliberately is not: a column the product
 * has stopped showing but is still writing is personal data nobody knows
 * they hold.
 *
 * ⚠️ THE DIALOG OFFERS THE OTHER DOOR TOO. "Hide from forms" keeps every
 * value and is what most people mean, so it is named here rather than left
 * to be discovered after the data is gone.
 */
function RemoveFieldDialog({
  field,
  onCancel,
  onConfirm,
}: {
  field: DraftField | null;
  onCancel: () => void;
  onConfirm: (field: DraftField, confirmApiName: string) => Promise<string | null>;
}) {
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apiName = field ? effectiveApiName(field) : "";
  const matches = typed === apiName && apiName !== "";

  return (
    <Dialog
      open={field !== null}
      onOpenChange={(open) => {
        if (!open) {
          setTyped("");
          setError(null);
          onCancel();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove &ldquo;{field?.label ?? ""}&rdquo;?</DialogTitle>
          <DialogDescription>
            This drops the column <code className="font-mono">{apiName}</code> and every
            value stored in it, for every record. There is no undo and no recycle bin —
            the column stops existing.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
          If you only want to stop showing this field, close this and tick{" "}
          <strong className="font-medium text-foreground">Hide from forms</strong>{" "}
          instead. That keeps every value exactly where it is.
        </div>

        <div>
          <label htmlFor="remove-field-confirm" className="mb-1 block text-xs font-medium">
            Type <code className="font-mono">{apiName}</code> to confirm
          </label>
          <Input
            id="remove-field-confirm"
            value={typed}
            className="font-mono"
            autoComplete="off"
            onChange={(event) => setTyped(event.target.value)}
          />
        </div>

        {error ? (
          <p
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={!matches || pending || !field}
            onClick={async () => {
              if (!field) return;
              setPending(true);
              setError(null);
              try {
                const failure = await onConfirm(field, typed);
                if (failure) setError(failure);
                else setTyped("");
              } finally {
                setPending(false);
              }
            }}
          >
            {pending ? "Dropping…" : "Drop the column"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
