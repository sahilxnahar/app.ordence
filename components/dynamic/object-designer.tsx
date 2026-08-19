"use client";

/**
 * Ordence — The Record Type Designer
 * Version: v0.27.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE ONE DISTINCTION THIS SCREEN EXISTS TO MAKE VISIBLE
 * ══════════════════════════════════════════════════════════════════════
 * A record type has TWO names and they behave completely differently:
 *
 *   • THE LABEL is what people see. Changing it is one UPDATE of one
 *     varchar. Nothing locks, nothing moves, nothing breaks.
 *
 *   • THE API NAME is part of the physical table name
 *     (`cx_<api_name>_<8 hex>`). There is no code path that changes it,
 *     and there is not going to be: changing it would either orphan the
 *     table or require an `ALTER TABLE … RENAME` — an ACCESS EXCLUSIVE
 *     lock on a table that may hold millions of rows, taken in the middle
 *     of a working day because somebody fixed a typo.
 *
 * ⚠️ IN THE DATA THOSE TWO LOOK IDENTICAL — two varchars on one row — so
 * a customer who is not told will assume both are editable, and will find
 * out otherwise when they try. Hence the badges, the two different help
 * texts, and the fact that on an existing record type the api name is
 * rendered as TEXT and not as a disabled input.
 *
 * ══════════════════════════════════════════════════════════════════════
 * TWO MODES, ONE COMPONENT
 * ══════════════════════════════════════════════════════════════════════
 * CREATING — the whole thing is a form. Nothing exists, so everything is
 * editable and the fields are collected locally and submitted together.
 * `createDynamicObjectSchema` requires at least one field, because an
 * object with none is a table of six system columns whose only remaining
 * use is being dropped.
 *
 * EDITING — the table exists. The label half saves through
 * `renameDynamicObject`; each field operation is its own call, because
 * each is its own piece of DDL and batching them would mean a failure
 * halfway leaves the screen disagreeing with the database.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ObjectIcon, OBJECT_ICON_NAMES } from "./object-icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FieldList } from "./field-list";
import { LimitMeter } from "./limit-meter";
import { Problem } from "./field-editor";
import {
  checkObjectDraft,
  draftFromField,
  effectiveApiName,
  fieldPayload,
  suggestObjectApiName,
  API_NAME_IS_PERMANENT_EXPLANATION,
  LABEL_IS_SAFE_EXPLANATION,
  MAX_OBJECT_API_NAME_LENGTH,
  MAX_OBJECTS_PER_TENANT,
  OBJECT_LIMIT_EXPLANATION,
  type DraftField,
  type ObjectFieldRow,
  type ObjectSummary,
  type RelationTargetOption,
} from "./presentation";
import type { ActionResult } from "@/lib/validators/crm";

export type ObjectDesignerActions = {
  onCreate?: (input: unknown) => Promise<ActionResult<{ id: string }>>;
  onRename?: (input: unknown) => Promise<ActionResult<unknown>>;
  onAddField?: (input: unknown) => Promise<ActionResult<unknown>>;
  onUpdateField?: (input: unknown) => Promise<ActionResult<unknown>>;
  onRemoveField?: (input: unknown) => Promise<ActionResult<unknown>>;
};

export function ObjectDesigner({
  object,
  fields: initialFields,
  relationTargets,
  objectCount,
  actions,
}: {
  /** `null` when defining a new record type. */
  object: ObjectSummary | null;
  fields: readonly ObjectFieldRow[];
  relationTargets: readonly RelationTargetOption[];
  objectCount: number;
  actions: ObjectDesignerActions;
}) {
  const router = useRouter();
  const live = object !== null;

  const [label, setLabel] = useState(object?.label ?? "");
  const [pluralLabel, setPluralLabel] = useState(object?.pluralLabel ?? "");
  const [pluralTouched, setPluralTouched] = useState(Boolean(object));
  const [apiName, setApiName] = useState(object?.apiName ?? "");
  const [apiNameTouched, setApiNameTouched] = useState(Boolean(object));
  const [description, setDescription] = useState(object?.description ?? "");
  const [icon, setIcon] = useState(object?.icon ?? "box");
  const [displayField, setDisplayField] = useState(object?.displayFieldApiName ?? "");

  const [fields, setFields] = useState<DraftField[]>(() =>
    initialFields.map(draftFromField),
  );

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const effectivePlural = pluralTouched ? pluralLabel : label.trim() ? `${label.trim()}s` : "";
  const effectiveApi = apiNameTouched ? apiName : suggestObjectApiName(label);

  const problems = checkObjectDraft({
    label,
    pluralLabel: effectivePlural,
    apiName: effectiveApi,
    fields,
    requireAtLeastOneField: !live,
  });
  const problemFor = (where: string) =>
    problems.find((p) => p.where === where)?.message ?? null;

  const atObjectCap = !live && objectCount >= MAX_OBJECTS_PER_TENANT;

  /** Every server call in this file goes through here. */
  const run = async (work: () => Promise<ActionResult<unknown>>): Promise<string | null> => {
    setPending(true);
    setError(null);
    setSaved(false);
    try {
      const result = await work();
      if (!result.ok) {
        setError(result.error);
        return result.error;
      }
      return null;
    } finally {
      setPending(false);
    }
  };

  /* ---------------- create ---------------- */

  const create = async () => {
    if (!actions.onCreate) return;
    setPending(true);
    setError(null);
    try {
      const result = await actions.onCreate({
        apiName: effectiveApi,
        label: label.trim(),
        pluralLabel: effectivePlural.trim(),
        description: description.trim() === "" ? undefined : description.trim(),
        icon: icon.trim() || "box",
        fields: fields.map((field, index) => fieldPayload(field, index)),
        displayFieldApiName:
          displayField || (fields[0] ? effectiveApiName(fields[0]) : undefined),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push(`/objects/${result.data.id}`);
      router.refresh();
    } finally {
      setPending(false);
    }
  };

  /* ---------------- rename ---------------- */

  const saveDetails = async () => {
    if (!object || !actions.onRename) return;
    const failure = await run(() =>
      actions.onRename!({
        objectId: object.id,
        label: label.trim(),
        pluralLabel: effectivePlural.trim(),
        description: description.trim() === "" ? null : description.trim(),
        icon: icon.trim() || "box",
        displayFieldApiName: displayField || undefined,
      }),
    );
    if (!failure) {
      setSaved(true);
      router.refresh();
    }
  };

  return (
    <div className="space-y-5">
      {!live ? (
        <LimitMeter
          label="Record types in this workspace"
          used={objectCount}
          max={MAX_OBJECTS_PER_TENANT}
          explanation={OBJECT_LIMIT_EXPLANATION}
        />
      ) : null}

      {atObjectCap ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          This workspace already has the maximum of {MAX_OBJECTS_PER_TENANT} record
          types. Archive or delete one before defining another.
        </p>
      ) : null}

      {error ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}

      {saved ? (
        <p
          role="status"
          className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground"
        >
          Saved. Only the metadata changed — no table was touched.
        </p>
      ) : null}

      {/* ================= Names ================= */}
      <section className="rounded-lg border border-border p-4">
        <h2 className="text-sm font-semibold">Names</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          One of these can be changed whenever you like. The other cannot be changed at
          all. They look the same in the data, so the difference is spelled out here.
        </p>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="obj-label" className="mb-1 block text-xs font-medium">
              Name (singular)
              <span className="ml-0.5 text-destructive" aria-hidden="true">
                *
              </span>
              <span className="sr-only"> (required)</span>
              <span className="ml-2 rounded border border-border px-1 py-0.5 text-[10px] font-normal uppercase tracking-wide text-muted-foreground">
                safe to change
              </span>
            </label>
            <Input
              id="obj-label"
              value={label}
              maxLength={120}
              aria-describedby="obj-label-help"
              aria-invalid={problemFor("label") ? true : undefined}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="Site visit"
            />
            <p id="obj-label-help" className="mt-1 text-[11px] text-muted-foreground">
              {LABEL_IS_SAFE_EXPLANATION}
            </p>
            <Problem message={problemFor("label")} />
          </div>

          <div>
            <label htmlFor="obj-plural" className="mb-1 block text-xs font-medium">
              Name (plural)
              <span className="ml-0.5 text-destructive" aria-hidden="true">
                *
              </span>
              <span className="sr-only"> (required)</span>
            </label>
            <Input
              id="obj-plural"
              value={effectivePlural}
              maxLength={120}
              aria-invalid={problemFor("pluralLabel") ? true : undefined}
              onChange={(event) => {
                setPluralTouched(true);
                setPluralLabel(event.target.value);
              }}
              placeholder="Site visits"
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              Used in headings and navigation. Guessed by adding an &ldquo;s&rdquo; until
              you edit it, because that guess is wrong often enough to be worth showing.
            </p>
            <Problem message={problemFor("pluralLabel")} />
          </div>
        </div>

        <div className="mt-3">
          <label htmlFor="obj-api" className="mb-1 block text-xs font-medium">
            API name
            <span className="ml-2 rounded border border-destructive/40 bg-destructive/10 px-1 py-0.5 text-[10px] font-normal uppercase tracking-wide text-destructive">
              permanent
            </span>
          </label>

          {live ? (
            <>
              <p className="rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-sm">
                {object.apiName}
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Fixed. This record type&rsquo;s data lives in the table{" "}
                <code className="font-mono">{object.physicalTableName}</code>, whose name
                was derived from this one when it was created. Renaming would mean
                locking that table to move it — so the label above is what changes when
                the name changes, and this stays as an address.
              </p>
            </>
          ) : (
            <>
              <Input
                id="obj-api"
                value={effectiveApi}
                maxLength={MAX_OBJECT_API_NAME_LENGTH}
                className="font-mono"
                aria-describedby="obj-api-help"
                aria-invalid={problemFor("apiName") ? true : undefined}
                onChange={(event) => {
                  setApiNameTouched(true);
                  setApiName(event.target.value);
                }}
                placeholder="site_visit"
              />
              <p id="obj-api-help" className="mt-1 text-[11px] text-muted-foreground">
                Suggested from the name until you edit it. Lowercase letters, digits and
                underscores, starting with a letter, at most {MAX_OBJECT_API_NAME_LENGTH}{" "}
                characters. {API_NAME_IS_PERMANENT_EXPLANATION}
              </p>
              {effectiveApi ? (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  The table will be called{" "}
                  <code className="font-mono">cx_{effectiveApi}_&lt;id&gt;</code>.
                </p>
              ) : null}
            </>
          )}
          <Problem message={problemFor("apiName")} />
        </div>
      </section>

      {/* ================= Presentation ================= */}
      <section className="rounded-lg border border-border p-4">
        <h2 className="text-sm font-semibold">Description and icon</h2>

        <div className="mt-3 space-y-3">
          <div>
            <label htmlFor="obj-desc" className="mb-1 block text-xs font-medium">
              What this record type is for (optional)
            </label>
            <Textarea
              id="obj-desc"
              value={description}
              maxLength={1000}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="A visit by a prospective buyer to a project site."
            />
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor="obj-icon" className="mb-1 block text-xs font-medium">
                Icon
              </label>
              <Input
                id="obj-icon"
                value={icon}
                maxLength={60}
                list="obj-icon-suggestions"
                className="w-56 font-mono"
                aria-describedby="obj-icon-help"
                onChange={(event) => setIcon(event.target.value)}
              />
              <datalist id="obj-icon-suggestions">
                {OBJECT_ICON_NAMES.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
              <p id="obj-icon-help" className="mt-1 text-[11px] text-muted-foreground">
                A Lucide icon name. Any valid one is stored and drawn in the sidebar;
                the preview beside this box only knows the suggested names and shows a
                plain square for the rest, rather than pulling the whole icon library
                into this page for one 16-pixel square.
              </p>
            </div>

            <div className="flex items-center gap-2 rounded-md border border-border px-3 py-2">
              <ObjectIcon name={icon || "box"} className="h-5 w-5" />
              <span className="text-xs text-muted-foreground">Preview</span>
            </div>
          </div>

          {fields.length > 0 ? (
            <div>
              <label htmlFor="obj-display" className="mb-1 block text-xs font-medium">
                Which field identifies a record
              </label>
              <select
                id="obj-display"
                value={displayField}
                aria-describedby="obj-display-help"
                onChange={(event) => setDisplayField(event.target.value)}
                className="h-9 w-full max-w-sm rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="">
                  {fields[0] ? `${fields[0].label || effectiveApiName(fields[0])} (first field)` : "—"}
                </option>
                {fields.map((field) => (
                  <option key={field.key} value={effectiveApiName(field)}>
                    {field.label || effectiveApiName(field)}
                  </option>
                ))}
              </select>
              <p id="obj-display-help" className="mt-1 text-[11px] text-muted-foreground">
                Shown in lists, pickers and search results, and the only field searched
                when somebody types in the list&rsquo;s search box. It cannot be removed
                while it holds this job — every record would render as a blank row.
              </p>
            </div>
          ) : null}
        </div>

        {live ? (
          <div className="mt-3 flex justify-end">
            <Button type="button" onClick={saveDetails} disabled={pending}>
              {pending ? "Saving…" : "Save names and description"}
            </Button>
          </div>
        ) : null}
      </section>

      {/* ================= Fields ================= */}
      <section className="rounded-lg border border-border p-4">
        <h2 className="text-sm font-semibold">Fields</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {live
            ? "Each of these is a real column. Adding or removing one runs DDL against the table the moment you confirm it."
            : "Nothing here exists yet. The table and all of its columns are created together, in one transaction — either all of it or none of it."}
        </p>

        <div className="mt-3">
          <FieldList
            fields={fields}
            relationTargets={relationTargets}
            live={live}
            displayFieldApiName={
              displayField || (fields[0] ? effectiveApiName(fields[0]) : null)
            }
            busy={pending}
            onChange={setFields}
            onCommitAdd={
              live && actions.onAddField
                ? async (draft) => {
                    const failure = await run(() =>
                      actions.onAddField!({
                        objectId: object.id,
                        field: fieldPayload(draft, fields.length),
                      }),
                    );
                    if (!failure) router.refresh();
                    return failure;
                  }
                : undefined
            }
            onCommitUpdate={
              live && actions.onUpdateField
                ? async (draft) => {
                    if (!draft.id) return "That field has not been created yet.";
                    const failure = await run(() =>
                      actions.onUpdateField!({
                        fieldId: draft.id,
                        label: draft.label.trim(),
                        helpText: draft.helpText.trim() === "" ? null : draft.helpText.trim(),
                        placeholder:
                          draft.placeholder.trim() === "" ? null : draft.placeholder.trim(),
                        isHidden: draft.isHidden,
                        showInGrid: draft.showInGrid,
                      }),
                    );
                    if (!failure) router.refresh();
                    return failure;
                  }
                : undefined
            }
            onCommitRemove={
              live && actions.onRemoveField
                ? async (draft, confirmApiName) => {
                    if (!draft.id) return "That field has not been created yet.";
                    const failure = await run(() =>
                      actions.onRemoveField!({ fieldId: draft.id, confirmApiName }),
                    );
                    if (!failure) {
                      setFields((current) => current.filter((f) => f.key !== draft.key));
                      router.refresh();
                    }
                    return failure;
                  }
                : undefined
            }
            onCommitReorder={
              live && actions.onUpdateField
                ? async (next) => {
                    /*
                     * ⚠️ ONE CALL PER FIELD, SEQUENTIALLY, AND ONLY FOR THE
                     * ONES THAT MOVED. `updateDynamicField` takes a single
                     * field; there is no batch endpoint, and inventing one
                     * in the client by firing N requests in parallel makes
                     * a partial failure impossible to reason about.
                     */
                    for (const [index, field] of next.entries()) {
                      if (!field.id) continue;
                      const result = await actions.onUpdateField!({
                        fieldId: field.id,
                        sortOrder: index,
                      });
                      if (!result.ok) {
                        setError(result.error);
                        return result.error;
                      }
                    }
                    router.refresh();
                    return null;
                  }
                : undefined
            }
          />
        </div>
      </section>

      {/* ================= Create ================= */}
      {!live ? (
        <div className="flex items-center justify-end gap-3">
          {problems.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              {problems.length} thing{problems.length === 1 ? "" : "s"} to fix first.
            </p>
          ) : null}
          <Button
            type="button"
            onClick={create}
            disabled={pending || problems.length > 0 || atObjectCap}
          >
            {pending ? "Creating the table…" : "Create this record type"}
          </Button>
        </div>
      ) : null}

      {!live && problems.length > 0 ? (
        <ul className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
          {problems.map((problem) => (
            <li key={`${problem.where}:${problem.message}`}>{problem.message}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
