/**
 * Ordence — The Custom Object Designer UI
 * Version: v0.27.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * PHASE 27 MANDATORY VERIFICATION
 * ══════════════════════════════════════════════════════════════════════
 * Four claims are made about these screens, and all four are the sort that
 * quietly stop being true:
 *
 *   1. The field type picker offers EXACTLY the engine's catalogue. Two
 *      lists drift; the designer then offers a type the DDL planner has
 *      never heard of, and the save is refused after forty fields have
 *      been entered.
 *   2. An api name the server would refuse is refused HERE, by the
 *      server's own validator — not by a second regex that agrees with it
 *      today.
 *   3. The drop dialog demands the exact live record count, because the
 *      engine does. Softening that to a checkbox would move the real
 *      requirement from a form field to an error message.
 *   4. An existing field shows its type as a FACT, not as a dropdown that
 *      silently fails. `updateDynamicFieldSchema` has no `fieldType`.
 *
 * These tests RENDER the real components against the real engine exports.
 * Nothing about the catalogue, the limits or the identifier validator is
 * mocked — mocking any of them would make these tests assert that the
 * mocks agree with themselves.
 *
 * ⚠️ THE SERVER ACTIONS ARE THE ONLY THING STUBBED, and only because
 * `server/actions/dynamic-objects.ts` reaches `server-only` modules that
 * build a database client at import time. That is exactly why every
 * component here takes its actions as PROPS rather than importing them.
 */

import * as React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  FieldTypePicker,
  FixedFieldType,
} from "@/components/dynamic/field-type-picker";
import { FieldEditor } from "@/components/dynamic/field-editor";
import { FieldList } from "@/components/dynamic/field-list";
import { ObjectDesigner } from "@/components/dynamic/object-designer";
import { DropObjectDialog } from "@/components/dynamic/drop-object-dialog";
import { RecordForm } from "@/components/dynamic/record-form";
import {
  checkDraftField,
  checkObjectDraft,
  draftFromField,
  effectiveApiName,
  fieldPayload,
  formatPaise,
  moveDraft,
  newDraftField,
  FIELD_TYPE_OPTIONS,
  type DraftField,
  type ObjectFieldRow,
  type ObjectSummary,
} from "@/components/dynamic/presentation";

import {
  DYNAMIC_FIELD_TYPES,
  FIELD_TYPE_CATALOG,
  RELATION_CORE_TABLES,
} from "@/lib/dynamic/field-types";
import {
  MAX_FIELDS_PER_OBJECT,
  MAX_OBJECTS_PER_TENANT,
} from "@/lib/dynamic/limits";
import { checkIdentifier } from "@/lib/dynamic/identifiers";

/* ------------------------------------------------------------------ */
/* FIXTURES                                                            */
/* ------------------------------------------------------------------ */

function fieldRow(overrides: Partial<ObjectFieldRow> = {}): ObjectFieldRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    apiName: "visit_note",
    label: "Visit note",
    helpText: null,
    placeholder: null,
    fieldType: "text",
    isRequired: false,
    isUnique: false,
    isIndexed: false,
    isHidden: false,
    showInGrid: true,
    options: [],
    relationObjectId: null,
    relationCoreTable: null,
    sortOrder: 0,
    ...overrides,
  };
}

function objectSummary(overrides: Partial<ObjectSummary> = {}): ObjectSummary {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    apiName: "site_visit",
    label: "Site visit",
    pluralLabel: "Site visits",
    description: null,
    icon: "box",
    displayFieldApiName: "visit_note",
    physicalTableName: "cx_site_visit_22222222",
    createdAt: "2026-01-05T10:00:00.000Z",
    fieldCount: 1,
    recordCount: 0,
    ...overrides,
  };
}

/** A picker mounted with a spy, so the choice can be read back. */
function TypePickerHarness() {
  const [value, setValue] = React.useState(DYNAMIC_FIELD_TYPES[0]);
  return <FieldTypePicker value={value} onChange={setValue} />;
}

/** A field editor driven by real state, so edits are visible. */
function EditorHarness({ initial }: { initial: DraftField }) {
  const [draft, setDraft] = React.useState(initial);
  return (
    <FieldEditor
      draft={draft}
      siblings={[draft]}
      relationTargets={[
        { kind: "object", objectId: "33333333-3333-4333-8333-333333333333", label: "Snag" },
      ]}
      onChange={setDraft}
    />
  );
}

/* ================================================================== */
/* 1. THE FIELD TYPE PICKER IS THE ENGINE'S CATALOGUE                  */
/* ================================================================== */

describe("Field type picker — driven by the engine's catalogue", () => {
  it("offers exactly the field types the engine has, and no others", () => {
    render(<TypePickerHarness />);

    const select = screen.getByLabelText(/type/i, { selector: "select" });
    const offered = within(select)
      .getAllByRole("option")
      .map((option) => (option as HTMLOptionElement).value);

    expect(offered).toEqual([...DYNAMIC_FIELD_TYPES]);
  });

  it("labels every option from FIELD_TYPE_CATALOG rather than a local map", () => {
    render(<TypePickerHarness />);

    const select = screen.getByLabelText(/type/i, { selector: "select" });
    for (const type of DYNAMIC_FIELD_TYPES) {
      const option = within(select).getByRole("option", {
        name: FIELD_TYPE_CATALOG[type].label,
      });
      expect((option as HTMLOptionElement).value).toBe(type);
    }
  });

  it("does not offer formula, rollup or file — the engine does not have them", () => {
    render(<TypePickerHarness />);

    const select = screen.getByLabelText(/type/i, { selector: "select" });
    const offered = within(select)
      .getAllByRole("option")
      .map((option) => (option as HTMLOptionElement).value);

    expect(offered).not.toContain("formula");
    expect(offered).not.toContain("rollup");
    expect(offered).not.toContain("file");
  });

  it("shows the engine's own hint and the physical column type for the choice", async () => {
    const user = userEvent.setup();
    render(<TypePickerHarness />);

    const select = screen.getByLabelText(/type/i, { selector: "select" });
    await user.selectOptions(select, "currency");

    expect(screen.getByText(new RegExp(FIELD_TYPE_CATALOG.currency.hint.slice(0, 20)))).toBeInTheDocument();
    // `bigint`, because money is minor units. Read from the catalogue.
    expect(screen.getByText(FIELD_TYPE_CATALOG.currency.pgType)).toBeInTheDocument();
  });

  it("derives FIELD_TYPE_OPTIONS from the catalogue, in the enum's order", () => {
    expect(FIELD_TYPE_OPTIONS.map((o) => o.value)).toEqual([...DYNAMIC_FIELD_TYPES]);
    for (const option of FIELD_TYPE_OPTIONS) {
      expect(option.label).toBe(FIELD_TYPE_CATALOG[option.value].label);
      expect(option.pgType).toBe(FIELD_TYPE_CATALOG[option.value].pgType);
    }
  });
});

/* ================================================================== */
/* 2. AN INVALID API NAME IS REFUSED BY THE ENGINE'S OWN VALIDATOR     */
/* ================================================================== */

describe("API names — refused client-side by the engine's own validator", () => {
  it("refuses a reserved SQL word with the validator's own sentence", async () => {
    const user = userEvent.setup();
    render(<EditorHarness initial={newDraftField({ label: "Select" })} />);

    const apiInput = screen.getByLabelText(/api name/i);
    await user.clear(apiInput);
    await user.type(apiInput, "select");

    // The exact message the engine produces, not a paraphrase.
    const engineVerdict = checkIdentifier("select", "field");
    expect(engineVerdict.ok).toBe(false);
    if (engineVerdict.ok) throw new Error("unreachable");

    const alerts = screen.getAllByRole("alert").map((n) => n.textContent ?? "");
    expect(alerts.some((text) => text === engineVerdict.error)).toBe(true);
  });

  it("refuses a system column name, naming the row-level-security reason", async () => {
    const user = userEvent.setup();
    render(<EditorHarness initial={newDraftField({ label: "Tenant" })} />);

    const apiInput = screen.getByLabelText(/api name/i);
    await user.clear(apiInput);
    await user.type(apiInput, "tenant_id");

    const alerts = screen.getAllByRole("alert").map((n) => n.textContent ?? "");
    expect(alerts.some((text) => /system column/i.test(text))).toBe(true);
    expect(alerts.some((text) => /row-level security/i.test(text))).toBe(true);
  });

  it("refuses capitals rather than silently lower-casing them", () => {
    const draft = newDraftField({
      label: "Carpet Area",
      apiName: "CarpetArea",
      apiNameTouched: true,
    });
    const problems = checkDraftField(draft, [draft]);
    expect(problems.some((p) => p.where === "apiName")).toBe(true);
    // And the value is not repaired behind the customer's back.
    expect(effectiveApiName(draft)).toBe("CarpetArea");
  });

  it("suggests a valid api name from a label without accepting the label itself", () => {
    const draft = newDraftField({ label: "Carpet Area (sq ft)" });
    const suggested = effectiveApiName(draft);
    expect(checkIdentifier(suggested, "field").ok).toBe(true);
    expect(checkDraftField(draft, [draft]).some((p) => p.where === "apiName")).toBe(false);
  });

  it("refuses an object api name the server would refuse, and blocks the create button", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => ({ ok: true as const, data: { id: "x" } }));

    render(
      <ObjectDesigner
        object={null}
        fields={[]}
        relationTargets={[]}
        objectCount={0}
        actions={{ onCreate }}
      />,
    );

    await user.type(screen.getByLabelText(/^name \(singular\)/i), "Users");
    const apiInput = screen.getByLabelText(/api name/i);
    await user.clear(apiInput);
    // A core table name — the engine refuses it as permanently ambiguous.
    await user.type(apiInput, "users");

    const verdict = checkIdentifier("users", "object");
    expect(verdict.ok).toBe(false);

    const create = screen.getByRole("button", { name: /create this record type/i });
    expect(create).toBeDisabled();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("checkObjectDraft refuses a record type with no fields, in the engine's terms", () => {
    const problems = checkObjectDraft({
      label: "Site visit",
      pluralLabel: "Site visits",
      apiName: "site_visit",
      fields: [],
    });
    expect(problems.some((p) => p.where === "fields")).toBe(true);
  });
});

/* ================================================================== */
/* 3. THE DROP DIALOG DEMANDS THE EXACT LIVE RECORD COUNT              */
/* ================================================================== */

describe("Dropping a record type — the count is typed back, not ticked", () => {
  const openDialog = async (props: Partial<React.ComponentProps<typeof DropObjectDialog>> = {}) => {
    const onDrop = vi.fn(async () => ({
      ok: true as const,
      data: { objectId: "22222222-2222-4222-8222-222222222222", recordsDestroyed: 7 },
    }));
    const user = userEvent.setup();

    render(
      <DropObjectDialog
        objectId="22222222-2222-4222-8222-222222222222"
        apiName="site_visit"
        label="Site visit"
        physicalTableName="cx_site_visit_22222222"
        recordCount={7}
        onDrop={onDrop}
        {...props}
      />,
    );

    await user.click(screen.getByRole("button", { name: /delete permanently/i }));
    return { user, onDrop };
  };

  it("states the live record count instead of an adjective", async () => {
    await openDialog();
    expect(screen.getByText(/7 live records will be destroyed/i)).toBeInTheDocument();
  });

  it("keeps the drop disabled until BOTH the api name and the exact count are typed", async () => {
    const { user } = await openDialog();

    const drop = screen.getByRole("button", { name: /drop the table and 7 records/i });
    expect(drop).toBeDisabled();

    await user.type(screen.getByLabelText(/type the api name/i), "site_visit");
    expect(drop).toBeDisabled();

    // A wrong count is not good enough — this is the whole point.
    await user.type(screen.getByLabelText(/number of records being destroyed/i), "6");
    expect(drop).toBeDisabled();
  });

  it("enables the drop only for the exact count, and sends it to the engine", async () => {
    const { user, onDrop } = await openDialog();

    await user.type(screen.getByLabelText(/type the api name/i), "site_visit");
    await user.type(screen.getByLabelText(/number of records being destroyed/i), "7");

    const drop = screen.getByRole("button", { name: /drop the table and 7 records/i });
    expect(drop).toBeEnabled();

    await user.click(drop);

    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith({
      objectId: "22222222-2222-4222-8222-222222222222",
      confirmApiName: "site_visit",
      confirmRecordCount: 7,
    });
  });

  it("refuses a mistyped api name even when the count is right", async () => {
    const { user, onDrop } = await openDialog();

    await user.type(screen.getByLabelText(/type the api name/i), "site_visits");
    await user.type(screen.getByLabelText(/number of records being destroyed/i), "7");

    expect(screen.getByRole("button", { name: /drop the table and 7 records/i })).toBeDisabled();
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("does not treat an empty count box as zero on an empty record type", async () => {
    const { user, onDrop } = await openDialog({ recordCount: 0 });

    await user.type(screen.getByLabelText(/type the api name/i), "site_visit");
    // Nothing typed into the count. `Number("")` is 0, which would satisfy
    // a naive comparison — and would make the confirmation meaningless on
    // exactly the record types people delete most often.
    expect(screen.getByRole("button", { name: /drop the table and 0 records/i })).toBeDisabled();

    await user.type(screen.getByLabelText(/number of records being destroyed/i), "0");
    expect(screen.getByRole("button", { name: /drop the table and 0 records/i })).toBeEnabled();
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("offers no drop at all when the count could not be read", async () => {
    const user = userEvent.setup();
    const onDrop = vi.fn();

    render(
      <DropObjectDialog
        objectId="22222222-2222-4222-8222-222222222222"
        apiName="site_visit"
        label="Site visit"
        physicalTableName="cx_site_visit_22222222"
        recordCount={null}
        onDrop={onDrop as never}
      />,
    );
    await user.click(screen.getByRole("button", { name: /delete permanently/i }));

    expect(screen.getByText(/count could not be read/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/type the api name/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^drop the table$/i })).toBeDisabled();
  });

  it("names archiving as the reversible alternative, before the destructive one", async () => {
    const onArchive = vi.fn(async () => ({ ok: true as const, data: { objectId: "x" } }));
    await openDialog({ onArchive });

    expect(screen.getByRole("button", { name: /archive instead/i })).toBeInTheDocument();
    expect(screen.getByText(/leaves the table and every record exactly where they are/i))
      .toBeInTheDocument();
  });
});

/* ================================================================== */
/* 4. AN EXISTING FIELD'S TYPE IS A FACT, NOT A DROPDOWN               */
/* ================================================================== */

describe("An existing field — the type is fixed and the screen says so", () => {
  const existing = () =>
    draftFromField(fieldRow({ fieldType: "currency", label: "Agreed price", apiName: "agreed_price" }));

  it("renders no type dropdown at all for a field that already exists", () => {
    render(
      <FieldEditor
        draft={existing()}
        siblings={[existing()]}
        relationTargets={[]}
        onChange={() => {}}
      />,
    );

    // Not "disabled" — absent. A disabled control reads as a permission
    // problem somebody could be granted out of.
    expect(screen.queryByLabelText(/^type$/i, { selector: "select" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /^type$/i })).not.toBeInTheDocument();
  });

  it("states the type, its storage, and why it cannot change", () => {
    render(
      <FieldEditor
        draft={existing()}
        siblings={[existing()]}
        relationTargets={[]}
        onChange={() => {}}
      />,
    );

    expect(screen.getByText(FIELD_TYPE_CATALOG.currency.label)).toBeInTheDocument();
    expect(screen.getByText(/the type cannot be changed/i)).toBeInTheDocument();
    expect(screen.getByText(/paise reinterpreted as rupees/i)).toBeInTheDocument();
  });

  it("offers 'add a new field' as the path forward instead of a silent failure", async () => {
    const user = userEvent.setup();
    const onAddNewField = vi.fn();

    render(<FixedFieldType value="currency" onAddNewField={onAddNewField} />);

    const button = screen.getByRole("button", { name: /add a new field instead/i });
    await user.click(button);
    expect(onAddNewField).toHaveBeenCalledTimes(1);
  });

  it("renders the api name as text, not as an editable box, once the column exists", () => {
    render(
      <FieldEditor
        draft={existing()}
        siblings={[existing()]}
        relationTargets={[]}
        onChange={() => {}}
      />,
    );

    // Present as a label and a value, but there is no input to type into.
    expect(screen.getByText("agreed_price")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /api name/i })).not.toBeInTheDocument();
    expect(screen.getAllByText(/permanent/i).length).toBeGreaterThan(0);
  });

  it("still offers a type dropdown on a field that does not exist yet", () => {
    render(<EditorHarness initial={newDraftField({ label: "New one" })} />);
    expect(screen.getByLabelText(/type/i, { selector: "select" })).toBeInTheDocument();
  });
});

/* ================================================================== */
/* API NAME vs LABEL — THE DISTINCTION IS ON THE SCREEN                */
/* ================================================================== */

describe("API name versus label — invisible in the data, visible here", () => {
  it("marks the label safe to change and the api name permanent, on a new record type", () => {
    render(
      <ObjectDesigner
        object={null}
        fields={[]}
        relationTargets={[]}
        objectCount={0}
        actions={{}}
      />,
    );

    expect(screen.getAllByText(/safe to change/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/permanent/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/renaming touches one row of metadata/i)).toBeInTheDocument();
  });

  it("renders the api name of an existing record type as text with its table name", () => {
    render(
      <ObjectDesigner
        object={objectSummary()}
        fields={[fieldRow()]}
        relationTargets={[]}
        objectCount={1}
        actions={{}}
      />,
    );

    expect(screen.queryByRole("textbox", { name: /api name/i })).not.toBeInTheDocument();
    expect(screen.getByText("cx_site_visit_22222222")).toBeInTheDocument();
    expect(screen.getByText(/locking that table to move it/i)).toBeInTheDocument();
  });

  it("keeps the label editable on an existing record type", async () => {
    const user = userEvent.setup();
    render(
      <ObjectDesigner
        object={objectSummary()}
        fields={[fieldRow()]}
        relationTargets={[]}
        objectCount={1}
        actions={{ onRename: vi.fn(async () => ({ ok: true as const, data: {} })) }}
      />,
    );

    const label = screen.getByLabelText(/^name \(singular\)/i);
    await user.clear(label);
    await user.type(label, "Inspection");
    expect(label).toHaveValue("Inspection");
  });
});

/* ================================================================== */
/* LIMITS, SHOWN BEFORE THEY ARE HIT                                   */
/* ================================================================== */

describe("Limits — the engine's numbers, shown while there is still room", () => {
  it("shows the per-tenant object ceiling from lib/dynamic/limits.ts", () => {
    render(
      <ObjectDesigner
        object={null}
        fields={[]}
        relationTargets={[]}
        objectCount={3}
        actions={{}}
      />,
    );

    expect(
      screen.getByText(new RegExp(`3 of ${MAX_OBJECTS_PER_TENANT}`)),
    ).toBeInTheDocument();
    expect(
      screen.getByText(new RegExp(`${MAX_OBJECTS_PER_TENANT - 3} left`)),
    ).toBeInTheDocument();
  });

  it("states the field ceiling in words as well as in a bar, so it is not colour-only", () => {
    render(
      <FieldList
        fields={[]}
        relationTargets={[]}
        live={false}
        displayFieldApiName={null}
        onChange={() => {}}
      />,
    );

    expect(
      screen.getByText(new RegExp(`0 of ${MAX_FIELDS_PER_OBJECT}`)),
    ).toBeInTheDocument();
    const bar = screen.getByRole("progressbar", { name: /fields on this record type/i });
    expect(bar).toHaveAttribute("aria-valuemax", String(MAX_FIELDS_PER_OBJECT));
  });

  it("refuses a new record type once the workspace is at the cap, and says why", () => {
    render(
      <ObjectDesigner
        object={null}
        fields={[]}
        relationTargets={[]}
        objectCount={MAX_OBJECTS_PER_TENANT}
        actions={{}}
      />,
    );

    expect(screen.getByRole("button", { name: /create this record type/i })).toBeDisabled();
    expect(
      screen.getByText(new RegExp(`maximum of ${MAX_OBJECTS_PER_TENANT} record types`)),
    ).toBeInTheDocument();
  });
});

/* ================================================================== */
/* REORDERING — A KEYBOARD CAN DO EVERYTHING A MOUSE CAN               */
/* ================================================================== */

describe("Reordering fields", () => {
  const twoFields = (): DraftField[] => [
    newDraftField({ label: "First", apiName: "first", apiNameTouched: true }),
    newDraftField({ label: "Second", apiName: "second", apiNameTouched: true }),
  ];

  function ListHarness() {
    const [fields, setFields] = React.useState<DraftField[]>(twoFields);
    return (
      <FieldList
        fields={fields}
        relationTargets={[]}
        live={false}
        displayFieldApiName={null}
        onChange={setFields}
      />
    );
  }

  it("gives every field real Move up / Move down buttons", () => {
    render(<ListHarness />);
    expect(screen.getByRole("button", { name: /move first down/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /move second up/i })).toBeInTheDocument();
  });

  it("actually reorders when the button is pressed", async () => {
    const user = userEvent.setup();
    render(<ListHarness />);

    await user.click(screen.getByRole("button", { name: /move second up/i }));

    const rows = screen.getAllByRole("row").slice(1); // skip the header
    expect(rows[0]!.textContent).toContain("Second");
  });

  it("moveDraft is a no-op at either end rather than wrapping around", () => {
    const list = ["a", "b", "c"];
    expect(moveDraft(list, 0, -1)).toBe(list);
    expect(moveDraft(list, 2, 1)).toBe(list);
    expect(moveDraft(list, 0, 1)).toEqual(["b", "a", "c"]);
  });
});

/* ================================================================== */
/* PER-TYPE CONFIGURATION                                              */
/* ================================================================== */

describe("Per-type configuration comes from the catalogue", () => {
  it("asks for choices on a select and refuses one with none", async () => {
    const user = userEvent.setup();
    render(<EditorHarness initial={newDraftField({ label: "Status", fieldType: "select" })} />);

    expect(screen.getByRole("button", { name: /add a choice/i })).toBeInTheDocument();
    const alerts = screen.getAllByRole("alert").map((n) => n.textContent ?? "");
    expect(alerts.some((text) => /needs at least one choice/i.test(text))).toBe(true);

    await user.click(screen.getByRole("button", { name: /add a choice/i }));
    expect(screen.getByLabelText(/choice 1 stored value/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/choice 1 label/i)).toBeInTheDocument();
  });

  it("asks for a target on a relation, offering the engine's core allowlist", () => {
    render(<EditorHarness initial={newDraftField({ label: "Contact", fieldType: "relation" })} />);

    const select = screen.getByLabelText(/links to/i, { selector: "select" });
    const offered = within(select)
      .getAllByRole("option")
      .map((o) => (o as HTMLOptionElement).value)
      .filter((v) => v.startsWith("core:"))
      .map((v) => v.slice("core:".length));

    expect(offered).toEqual([...RELATION_CORE_TABLES]);
  });

  it("offers no choice editor on a type that does not take choices", () => {
    render(<EditorHarness initial={newDraftField({ label: "Note", fieldType: "text" })} />);
    expect(screen.queryByRole("button", { name: /add a choice/i })).not.toBeInTheDocument();
  });

  it("says the number precision is fixed rather than offering a control that does nothing", () => {
    render(<EditorHarness initial={newDraftField({ label: "Area", fieldType: "number" })} />);
    expect(screen.getByText(/precision is fixed/i)).toBeInTheDocument();
    expect(screen.getAllByText(FIELD_TYPE_CATALOG.number.pgType).length).toBeGreaterThan(0);
  });

  it("disables 'unique' on a type the engine says cannot be unique", () => {
    render(<EditorHarness initial={newDraftField({ label: "Notes", fieldType: "long_text" })} />);
    expect(FIELD_TYPE_CATALOG.long_text.supportsUnique).toBe(false);
    expect(screen.getByLabelText(/no two records may share a value/i)).toBeDisabled();
  });

  it("drops configuration that cannot apply when the type changes", async () => {
    const user = userEvent.setup();
    render(
      <EditorHarness
        initial={newDraftField({
          label: "Status",
          fieldType: "select",
          options: [{ value: "open", label: "Open" }],
        })}
      />,
    );

    await user.selectOptions(screen.getByLabelText(/type/i, { selector: "select" }), "text");
    expect(screen.queryByLabelText(/choice 1 stored value/i)).not.toBeInTheDocument();
  });

  it("fieldPayload strips options and relation that the chosen type refuses", () => {
    const draft = newDraftField({
      label: "Note",
      apiName: "note",
      apiNameTouched: true,
      fieldType: "text",
      options: [{ value: "open", label: "Open" }],
      relation: { kind: "core", table: "contacts" },
      isIndexed: true,
    });

    const payload = fieldPayload(draft, 3);
    expect(payload.options).toEqual([]);
    expect(payload.relation).toBeNull();
    expect(payload.sortOrder).toBe(3);
    expect(payload.isIndexed).toBe(true);
  });
});

/* ================================================================== */
/* GENERATED RECORD FORMS                                              */
/* ================================================================== */

describe("A record form generated from field definitions", () => {
  const fields: ObjectFieldRow[] = [
    fieldRow({ id: "f1", apiName: "title", label: "Title", fieldType: "text", isRequired: true }),
    fieldRow({ id: "f2", apiName: "notes", label: "Notes", fieldType: "long_text" }),
    fieldRow({ id: "f3", apiName: "visited_on", label: "Visited on", fieldType: "date" }),
    fieldRow({ id: "f4", apiName: "agreed", label: "Agreed", fieldType: "boolean" }),
    fieldRow({ id: "f5", apiName: "price", label: "Price", fieldType: "currency" }),
    fieldRow({
      id: "f6",
      apiName: "status",
      label: "Status",
      fieldType: "select",
      options: [
        { value: "open", label: "Open" },
        { value: "done", label: "Done" },
      ],
    }),
  ];

  it("renders a distinct control for each field type", () => {
    render(
      <RecordForm
        objectId="obj"
        objectLabel="site visit"
        fields={fields}
        record={null}
        onSubmit={vi.fn()}
        redirectTo="/objects/obj/records"
        cancelHref="/objects/obj/records"
      />,
    );

    expect(screen.getByLabelText(/title/i)).toHaveProperty("tagName", "INPUT");
    expect(screen.getByLabelText(/notes/i)).toHaveProperty("tagName", "TEXTAREA");
    expect(screen.getByLabelText(/visited on/i)).toHaveAttribute("type", "date");
    expect(screen.getByLabelText(/agreed/i)).toHaveAttribute("type", "checkbox");
    expect(screen.getByLabelText(/status/i)).toHaveProperty("tagName", "SELECT");
  });

  it("omits an empty optional value on create so the engine reports 'required' properly", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => ({ ok: true as const, data: {} }));

    render(
      <RecordForm
        objectId="obj"
        objectLabel="site visit"
        fields={fields}
        record={null}
        onSubmit={onSubmit}
        redirectTo="/objects/obj/records"
        cancelHref="/objects/obj/records"
      />,
    );

    await user.type(screen.getByLabelText(/title/i), "North tower walkthrough");
    await user.click(screen.getByRole("button", { name: /create site visit/i }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const sent = onSubmit.mock.calls[0]![0] as { values: Record<string, unknown> };
    expect(sent.values.title).toBe("North tower walkthrough");
    expect(sent.values).not.toHaveProperty("notes");
    // A boolean is always sent — an unticked checkbox is a real "no".
    expect(sent.values.agreed).toBe(false);
  });

  it("shows money in rupees beside the paise box, so the unit is never guessed", async () => {
    const user = userEvent.setup();
    render(
      <RecordForm
        objectId="obj"
        objectLabel="site visit"
        fields={fields}
        record={null}
        onSubmit={vi.fn()}
        redirectTo="/x"
        cancelHref="/x"
      />,
    );

    await user.type(screen.getByLabelText(/price/i), "125050");
    expect(screen.getByText(/₹1,250\.50/)).toBeInTheDocument();
  });

  it("renders the engine's own field errors against the field they belong to", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => ({
      ok: false as const,
      error: "Please check the form.",
      fieldErrors: { title: ["Title is required."] },
    }));

    render(
      <RecordForm
        objectId="obj"
        objectLabel="site visit"
        fields={fields}
        record={null}
        onSubmit={onSubmit}
        redirectTo="/x"
        cancelHref="/x"
      />,
    );

    await user.click(screen.getByRole("button", { name: /create site visit/i }));
    expect(await screen.findByText("Title is required.")).toBeInTheDocument();
    expect(screen.getByLabelText(/title/i)).toHaveAttribute("aria-invalid", "true");
  });

  it("sends null for a value the editor emptied, because update is a PATCH", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => ({ ok: true as const, data: {} }));

    render(
      <RecordForm
        objectId="obj"
        objectLabel="site visit"
        fields={fields}
        record={{ id: "rec-1", title: "Old", notes: "Some notes" }}
        onSubmit={onSubmit}
        redirectTo="/x"
        cancelHref="/x"
      />,
    );

    await user.clear(screen.getByLabelText(/notes/i));
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    const sent = onSubmit.mock.calls[0]![0] as { values: Record<string, unknown> };
    expect(sent.values.notes).toBeNull();
  });
});

/* ================================================================== */
/* MONEY FORMATTING                                                    */
/* ================================================================== */

describe("Money is read back as paise, exactly", () => {
  it("formats minor units in lakh/crore grouping without floating point", () => {
    expect(formatPaise("125050")).toBe("₹1,250.50");
    expect(formatPaise("850000000")).toBe("₹85,00,000.00");
  });

  it("survives values above 2^53, where Number would lose paise", () => {
    // `Number("9007199254740993")` is 9007199254740992 — one paisa short.
    // The BigInt path keeps the 3 at the end.
    expect(formatPaise("9007199254740993")).toBe("₹9,00,71,99,25,47,409.93");
  });
});
