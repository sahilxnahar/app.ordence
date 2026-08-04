/**
 * Ordence — The Saved-View UI
 * Version: v0.28.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * PHASE 28 MANDATORY VERIFICATION
 * ══════════════════════════════════════════════════════════════════════
 * Four claims are made about this layer, and all four are the sort that
 * quietly stop being true:
 *
 *   1. THE FIELD PICKER OFFERS EXACTLY THE REGISTRY'S FIELDS. The
 *      registry derives its field table from Drizzle metadata precisely
 *      so that a column added last week is filterable today. A picker
 *      built from a hand-written list would pass every other test in the
 *      suite and silently stop tracking the schema — which is the failure
 *      the registry's own header says it exists to prevent.
 *
 *   2. THE OPERATOR PICKER IS FILTERED BY FIELD KIND. `contains` on a
 *      `uuid` column compiles to `col::text ILIKE '%…%'`: a full scan, and
 *      an oracle that answers "does a record exist whose owner id starts
 *      with this" from nothing but the row count. The operator catalogue
 *      refuses it on the server. If the UI still OFFERS it, every use of
 *      the builder ends in a refusal the author cannot explain.
 *
 *   3. THE DEPTH AND NODE LIMITS ARE ENFORCED IN THE BROWSER. Not as a
 *      security control — the planner and the validator both refuse
 *      independently — but so that a cap is visible before somebody has
 *      spent four minutes building past it.
 *
 *   4. THE CALENDAR PUTS A RECORD ON THE DAY IT IS ACTUALLY DUE. A
 *      `timestamptz` bucketed by its ISO string lands on the previous day
 *      for every evening appointment in India, and the reader sees a call
 *      scheduled for a day nobody scheduled it.
 *
 * ⚠️ THESE TESTS RENDER THE REAL COMPONENTS AGAINST THE REAL ENGINE
 * EXPORTS. The registry, the operator catalogue and the limits are all
 * the genuine modules — mocking any of them would make these tests assert
 * that the mocks agree with themselves. Nothing is stubbed at all: the
 * components under test take their data as props precisely so that no
 * server module has to be.
 */

import * as React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { FilterEditor } from "@/components/views/filter-editor";
import { CalendarView, dayKey, monthGrid } from "@/components/views/calendar-view";
import { ResultTable, formatValue, nextSorts } from "@/components/views/result-table";
import { RecordListPage } from "@/components/views/record-list-page";
import {
  canAddNode,
  canNestGroupAt,
  countNodes,
  moveChild,
  retarget,
  treeDepth,
  withOperand,
} from "@/components/views/filter-tree";
import type { ViewObjectDescription } from "@/components/views/types";

import { VIEW_OBJECTS, filterableFields } from "@/lib/views/registry";
import { OPERATORS, operatorsForKind } from "@/lib/views/operators";
import { MAX_FILTER_DEPTH, MAX_FILTER_NODES } from "@/lib/views/limits";
import type { FilterGroup } from "@/lib/views/types";

/* ------------------------------------------------------------------ */
/* HARNESS                                                             */
/* ------------------------------------------------------------------ */

/**
 * Build the payload `server/views/catalog.ts` sends to the browser, from
 * the real registry.
 *
 * ⚠️ DERIVED, NOT TYPED OUT. A fixture listing "the fields of a lead" by
 * hand is a third copy of the schema, and the moment it drifts these
 * tests start proving that the fixture matches the UI rather than that
 * the UI matches the product.
 */
function describeObject(key: keyof typeof VIEW_OBJECTS): ViewObjectDescription {
  const object = VIEW_OBJECTS[key]!;
  return {
    key: object.key,
    label: object.label,
    pluralLabel: object.pluralLabel,
    dynamicObjectId: null,
    scopedToOwnRecords: false,
    defaultSorts: object.defaultSorts,
    defaultGroupBy: object.defaultGroupBy,
    defaultDateField: object.defaultDateField,
    defaultColumns: object.defaultColumns,
    fields: Object.values(object.fields).map((field) => ({
      name: field.name,
      label: field.label,
      kind: field.kind,
      enumValues: field.enumValues,
      filterable: field.filterable,
      sortable: field.sortable,
      groupable: field.groupable,
      operators: operatorsForKind(field.kind).map((operator) => ({
        key: operator,
        label: OPERATORS[operator].label,
        arity: OPERATORS[operator].arity,
      })),
    })),
  };
}

const LEAD = describeObject("lead");

function oneCondition(field: string, operator: string, value?: unknown): FilterGroup {
  return {
    type: "group",
    match: "all",
    children: [
      {
        type: "condition",
        field,
        operator: operator as never,
        ...(value === undefined ? {} : { value }),
      },
    ],
  };
}

function optionValues(select: HTMLElement): string[] {
  return Array.from((select as HTMLSelectElement).options).map((option) => option.value);
}

/* ------------------------------------------------------------------ */
/* 1. THE FIELD PICKER TRACKS THE REGISTRY                             */
/* ------------------------------------------------------------------ */

describe("the field picker offers exactly the registry's fields", () => {
  it("lists every filterable field of a lead, in registry order, and nothing else", () => {
    render(
      <FilterEditor object={LEAD} filter={oneCondition("name", "contains", "")} onChange={vi.fn()} />,
    );

    const expected = filterableFields(VIEW_OBJECTS.lead!).map((field) => field.name);

    expect(optionValues(screen.getByRole("combobox", { name: "Field" }))).toEqual(expected);
  });

  it("withholds the fields the registry marks unfilterable", () => {
    render(
      <FilterEditor object={LEAD} filter={oneCondition("name", "contains", "")} onChange={vi.fn()} />,
    );

    const offered = optionValues(screen.getByRole("combobox", { name: "Field" }));

    // `custom_fields` is jsonb: describable, and filterable by nothing.
    // Filtering inside it needs a path expression, which is a second
    // untrusted identifier-shaped string with its own allowlist problem.
    expect(LEAD.fields.some((field) => field.name === "custom_fields")).toBe(true);
    expect(offered).not.toContain("custom_fields");

    // ⭐ And the isolation boundary is not a field at all. `tenant_id` is
    // absent from the registry itself — a filterable one is a probe that
    // answers "does that workspace exist" from a row count.
    expect(offered).not.toContain("tenant_id");
    expect(offered).not.toContain("deleted_at");
  });

  it("covers every built-in object, not just leads", () => {
    for (const key of Object.keys(VIEW_OBJECTS) as Array<keyof typeof VIEW_OBJECTS>) {
      const description = describeObject(key);
      const expected = filterableFields(VIEW_OBJECTS[key]!).map((field) => field.name);
      const first = expected[0]!;

      const { unmount } = render(
        <FilterEditor
          object={description}
          filter={oneCondition(first, operatorsForKind(
            description.fields.find((f) => f.name === first)!.kind,
          )[0]!)}
          onChange={vi.fn()}
        />,
      );

      expect(optionValues(screen.getByRole("combobox", { name: "Field" }))).toEqual(expected);
      unmount();
    }
  });
});

/* ------------------------------------------------------------------ */
/* 2. THE OPERATOR PICKER IS FILTERED BY KIND                          */
/* ------------------------------------------------------------------ */

describe("the operator picker is filtered by field kind", () => {
  it("offers text matching on a text field", () => {
    render(
      <FilterEditor object={LEAD} filter={oneCondition("name", "contains", "")} onChange={vi.fn()} />,
    );

    const offered = optionValues(screen.getByRole("combobox", { name: "Comparison" }));

    expect(offered).toEqual(operatorsForKind("text"));
    expect(offered).toContain("contains");
    expect(offered).toContain("starts_with");
  });

  it("⭐ refuses to offer `contains` on a relation, which is the oracle case", () => {
    render(
      <FilterEditor
        object={LEAD}
        filter={oneCondition("owner_id", "eq", "11111111-1111-4111-8111-111111111111")}
        onChange={vi.fn()}
      />,
    );

    const offered = optionValues(screen.getByRole("combobox", { name: "Comparison" }));

    expect(offered).toEqual(operatorsForKind("uuid"));
    expect(offered).not.toContain("contains");
    expect(offered).not.toContain("starts_with");
    // `in` is the right way to say "any of these people".
    expect(offered).toContain("in");
  });

  it("offers only the presence and yes/no operators on a boolean", () => {
    render(
      <FilterEditor object={LEAD} filter={oneCondition("is_nri", "is_true")} onChange={vi.fn()} />,
    );

    const offered = optionValues(screen.getByRole("combobox", { name: "Comparison" }));

    expect(offered).toEqual(operatorsForKind("boolean"));
    // ⚠️ `eq: true` is deliberately absent — a tri-state column filtered
    // with `neq: true` includes NULLs on some databases and excludes them
    // on others, and a saved view is the worst place to find out which.
    expect(offered).not.toContain("eq");
    expect(offered).not.toContain("neq");
    expect(offered).toEqual(
      expect.arrayContaining(["is_true", "is_false", "is_empty", "is_not_empty"]),
    );
  });

  it("offers the relative-date operators only on dates", () => {
    const { unmount } = render(
      <FilterEditor
        object={LEAD}
        filter={oneCondition("next_follow_up_at", "overdue")}
        onChange={vi.fn()}
      />,
    );
    expect(optionValues(screen.getByRole("combobox", { name: "Comparison" }))).toContain(
      "overdue",
    );
    unmount();

    render(<FilterEditor object={LEAD} filter={oneCondition("score", "gte", 5)} onChange={vi.fn()} />);
    expect(
      optionValues(screen.getByRole("combobox", { name: "Comparison" })),
    ).not.toContain("overdue");
  });

  it("gives an enum field a picker of its own values rather than a text box", () => {
    render(
      <FilterEditor object={LEAD} filter={oneCondition("status", "eq", "new")} onChange={vi.fn()} />,
    );

    const status = LEAD.fields.find((field) => field.name === "status")!;
    expect(status.enumValues && status.enumValues.length > 0).toBe(true);

    const value = screen.getByRole("combobox", { name: "Value for Status" });
    expect(optionValues(value)).toEqual([...(status.enumValues ?? [])]);
  });

  it("drops an operator that no longer applies when the field changes", () => {
    // Pure, because this is where the bug actually lives: a retarget that
    // keeps `contains` produces a form that looks right and a save that
    // is refused.
    const uuidField = LEAD.fields.find((field) => field.name === "owner_id")!;
    const moved = retarget(
      { type: "condition", field: "name", operator: "contains", value: "sharma" },
      uuidField,
    );

    expect(moved.field).toBe("owner_id");
    expect(OPERATORS[moved.operator].kinds).toContain("uuid");
    expect(moved.operator).not.toBe("contains");
  });

  it("reshapes the operand when the arity changes", () => {
    const score = LEAD.fields.find((field) => field.name === "score")!;

    const between = withOperand(
      { type: "condition", field: "score", operator: "between", value: 10 },
      score,
    );
    expect(between.values).toHaveLength(2);
    expect(between.value).toBeUndefined();

    const empty = withOperand(
      { type: "condition", field: "score", operator: "is_empty", values: [1, 2] },
      score,
    );
    expect(empty.value).toBeUndefined();
    expect(empty.values).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* 3. THE LIMITS, ENFORCED IN THE BROWSER                              */
/* ------------------------------------------------------------------ */

/** A chain of groups `depth` levels deep, the innermost one empty. */
function nested(depth: number): FilterGroup {
  let node: FilterGroup = { type: "group", match: "any", children: [] };
  for (let level = 1; level < depth; level += 1) {
    node = { type: "group", match: "all", children: [node] };
  }
  return node;
}

/** A root group holding `count` empty children — cheap nodes to render. */
function wide(count: number): FilterGroup {
  return {
    type: "group",
    match: "all",
    children: Array.from({ length: count }, () => ({
      type: "group" as const,
      match: "any" as const,
      children: [],
    })),
  };
}

describe("the filter limits are enforced client-side and stated", () => {
  it("counts groups and conditions together, as the engine does", () => {
    expect(countNodes(nested(MAX_FILTER_DEPTH))).toBe(MAX_FILTER_DEPTH);
    expect(countNodes(wide(10))).toBe(11);
    expect(treeDepth(nested(MAX_FILTER_DEPTH))).toBe(MAX_FILTER_DEPTH);
  });

  it("refuses a group that would nest past the cap", () => {
    const tree = nested(MAX_FILTER_DEPTH);

    // The path to the innermost group: one index per level below the root.
    const deepest = Array.from({ length: MAX_FILTER_DEPTH - 1 }, () => 0);
    const oneAbove = deepest.slice(0, -1);

    expect(canNestGroupAt(tree, oneAbove).allowed).toBe(true);
    expect(canNestGroupAt(tree, deepest).allowed).toBe(false);
  });

  it("⭐ disables “Add group” at the deepest level and says why", () => {
    render(
      <FilterEditor object={LEAD} filter={nested(MAX_FILTER_DEPTH)} onChange={vi.fn()} />,
    );

    // A group's own buttons are rendered AFTER its children, so the first
    // pair in document order belongs to the innermost group.
    const addGroupButtons = screen.getAllByRole("button", { name: "Add group" });
    const addConditionButtons = screen.getAllByRole("button", { name: "Add condition" });

    expect(addGroupButtons[0]).toBeDisabled();
    // ⚠️ The DEPTH cap must not be mistaken for the NODE cap. A five-node
    // tree has 55 nodes of headroom, so conditions are still addable at
    // the deepest level — a UI that disabled both would be telling the
    // author something untrue.
    expect(addConditionButtons[0]).toBeEnabled();

    // ⭐ And the reason is TEXT, not just a grey button.
    expect(
      screen.getAllByText(new RegExp(`may not nest more than ${MAX_FILTER_DEPTH} deep`, "i")).length,
    ).toBeGreaterThan(0);
  });

  it("still allows nesting one level above the cap", () => {
    render(
      <FilterEditor object={LEAD} filter={nested(MAX_FILTER_DEPTH - 1)} onChange={vi.fn()} />,
    );
    expect(screen.getAllByRole("button", { name: "Add group" })[0]).toBeEnabled();
  });

  it("refuses one more node at the total cap", () => {
    expect(canAddNode(wide(MAX_FILTER_NODES - 2)).allowed).toBe(true);
    expect(canAddNode(wide(MAX_FILTER_NODES - 1)).allowed).toBe(false);
  });

  it("⭐ disables both add buttons at the node cap and says why", () => {
    // root + (MAX - 1) children = exactly MAX nodes.
    render(
      <FilterEditor object={LEAD} filter={wide(MAX_FILTER_NODES - 1)} onChange={vi.fn()} />,
    );

    for (const button of screen.getAllByRole("button", { name: "Add condition" })) {
      expect(button).toBeDisabled();
    }
    for (const button of screen.getAllByRole("button", { name: "Add group" })) {
      expect(button).toBeDisabled();
    }

    expect(
      screen.getAllByText(
        new RegExp(`at most ${MAX_FILTER_NODES} conditions and groups`, "i"),
      ).length,
    ).toBeGreaterThan(0);
  });

  it("shows the budget before it bites", () => {
    render(<FilterEditor object={LEAD} filter={wide(3)} onChange={vi.fn()} />);
    expect(
      screen.getByText(new RegExp(`4 of ${MAX_FILTER_NODES} conditions and groups used`, "i")),
    ).toBeInTheDocument();
  });

  it("reorders with the up/down buttons and never mutates the tree it was given", () => {
    const before = oneCondition("name", "contains", "a");
    before.children.push({ type: "condition", field: "score", operator: "gte", value: 5 });

    const snapshot = JSON.stringify(before);
    const after = moveChild(before, [], 1, -1);

    expect(JSON.stringify(before)).toBe(snapshot);
    expect((after.children[0] as { field: string }).field).toBe("score");
    expect((after.children[1] as { field: string }).field).toBe("name");
  });
});

/* ------------------------------------------------------------------ */
/* 4. THE CALENDAR PUTS RECORDS ON THE RIGHT DAYS                      */
/* ------------------------------------------------------------------ */

/** March 2026 begins on a Sunday, so it has six leading days. */
const MARCH_2026 = new Date(2026, 2, 1);

function cellFor(title: string): HTMLElement {
  const cell = screen.getByText(title).closest("td");
  if (!cell) throw new Error(`"${title}" is not inside a calendar cell.`);
  return cell;
}

describe("the calendar month grid", () => {
  it("starts on the Monday of the week containing the 1st", () => {
    const grid = monthGrid(MARCH_2026);

    expect(grid).toHaveLength(6);
    expect(grid[0]).toHaveLength(7);
    // 1 March 2026 is a Sunday, so the grid opens on 23 February.
    expect(dayKey(grid[0]![0]!)).toBe("2026-02-23");
    expect(grid[0]![0]!.getDay()).toBe(1);
    expect(dayKey(grid[0]![6]!)).toBe("2026-03-01");
  });

  it("is always six rows, so the navigation does not move between months", () => {
    for (const month of [new Date(2026, 1, 1), new Date(2026, 2, 1), new Date(2026, 7, 1)]) {
      expect(monthGrid(month)).toHaveLength(6);
      expect(monthGrid(month).flat()).toHaveLength(42);
    }
  });

  it("⭐ draws each event on its own day", () => {
    render(
      <CalendarView
        month={MARCH_2026}
        today={new Date(2026, 2, 10, 9, 0)}
        dateFieldLabel="Next follow up"
        events={[
          { id: "a", title: "Ravi Sharma", date: new Date(2026, 2, 5, 10, 30) },
          { id: "b", title: "Meena Iyer", date: new Date(2026, 2, 17, 16, 0) },
          { id: "c", title: "Anand Rao", date: new Date(2026, 2, 31, 9, 0) },
        ]}
      />,
    );

    expect(within(cellFor("Ravi Sharma")).getByText("5")).toBeInTheDocument();
    expect(within(cellFor("Meena Iyer")).getByText("17")).toBeInTheDocument();
    expect(within(cellFor("Anand Rao")).getByText("31")).toBeInTheDocument();

    // …and not on any other day.
    expect(within(cellFor("Ravi Sharma")).queryByText("Meena Iyer")).toBeNull();
  });

  it("⭐ keeps a late-evening record on the day it is due", () => {
    // The bug this pins: bucketing by `toISOString()` moves 23:30 IST to
    // the previous UTC day, so every evening follow-up in India lands on
    // the wrong cell.
    render(
      <CalendarView
        month={MARCH_2026}
        today={new Date(2026, 2, 10)}
        dateFieldLabel="Next follow up"
        events={[{ id: "late", title: "Late call", date: new Date(2026, 2, 9, 23, 30) }]}
      />,
    );

    expect(within(cellFor("Late call")).getByText("9")).toBeInTheDocument();
  });

  it("sorts several records on one day by time", () => {
    render(
      <CalendarView
        month={MARCH_2026}
        today={new Date(2026, 2, 10)}
        dateFieldLabel="Next follow up"
        events={[
          { id: "pm", title: "Afternoon", date: new Date(2026, 2, 12, 15, 0) },
          { id: "am", title: "Morning", date: new Date(2026, 2, 12, 9, 0) },
        ]}
      />,
    );

    const cell = cellFor("Morning");
    const listed = within(cell)
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(listed).toEqual(["Morning", "Afternoon"]);
  });

  it("names today in words, not only with a ring", () => {
    render(
      <CalendarView
        month={MARCH_2026}
        today={new Date(2026, 2, 10, 12, 0)}
        dateFieldLabel="Next follow up"
        events={[{ id: "x", title: "Site visit", date: new Date(2026, 2, 10, 11, 0) }]}
      />,
    );

    // ⚠️ Colour and a border are the fast path and never the only path.
    // Twice over: the visible badge, and the sentence the screen reader
    // hears as part of the cell's full date.
    expect(within(cellFor("Site visit")).getAllByText(/today/i).length).toBeGreaterThan(0);
    expect(
      within(cellFor("Site visit")).getByText(/Tuesday, 10 March 2026 — today/),
    ).toBeInTheDocument();
  });

  it("uses real column headers so a screen reader can place a cell", () => {
    render(
      <CalendarView
        month={MARCH_2026}
        today={new Date(2026, 2, 10)}
        dateFieldLabel="Next follow up"
        events={[]}
      />,
    );

    for (const day of ["Monday", "Sunday"]) {
      expect(screen.getByRole("columnheader", { name: day })).toBeInTheDocument();
    }
  });

  it("says so when it could not load every record in the month", () => {
    render(
      <CalendarView
        month={MARCH_2026}
        dateFieldLabel="Next follow up"
        events={[]}
        truncated
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(/some are not\s+drawn/i);
  });
});

/* ------------------------------------------------------------------ */
/* THE TABLE'S SORT AFFORDANCES                                        */
/* ------------------------------------------------------------------ */

describe("the result table", () => {
  const fields = [
    { name: "id", label: "Id", kind: "uuid" },
    { name: "name", label: "Name", kind: "text" },
    { name: "score", label: "Score", kind: "number" },
    { name: "budget_max_minor", label: "Budget max", kind: "money" },
  ];

  const rows = [
    {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Ravi Sharma",
      score: 72,
      budget_max_minor: "450000000",
    },
  ];

  it("⭐ marks every sortable header, not only the sorted one", () => {
    render(
      <ResultTable
        fields={fields}
        rows={rows}
        sorts={[{ field: "score", direction: "desc" }]}
        onSortChange={vi.fn()}
        total={1}
        page={1}
        pageSize={50}
      />,
    );

    // A table where only the active column carries `aria-sort` reads as a
    // table with exactly one sortable column, so the others are never
    // discovered.
    expect(screen.getByRole("columnheader", { name: /Score/ })).toHaveAttribute(
      "aria-sort",
      "descending",
    );
    expect(screen.getByRole("columnheader", { name: /Name/ })).toHaveAttribute(
      "aria-sort",
      "none",
    );
  });

  it("🔴 announces the SERVER'S default order when the view names no sort", () => {
    /*
      THE REGRESSION. `runView` with an empty sort list does not return
      unsorted rows — `resolveRequest()` substitutes the registry's
      `defaultSorts`. The table used to receive `sorts={[]}` and render
      `aria-sort="none"` on every column, telling a screen-reader user
      that a sorted table was unsorted.
    */
    render(
      <ResultTable
        fields={fields}
        rows={rows}
        sorts={[]}
        defaultSorts={[{ field: "score", direction: "desc" }]}
        onSortChange={vi.fn()}
        total={1}
        page={1}
        pageSize={50}
      />,
    );

    expect(screen.getByRole("columnheader", { name: /Score/ })).toHaveAttribute(
      "aria-sort",
      "descending",
    );
    // Every other sortable column is still announced as sortable.
    expect(screen.getByRole("columnheader", { name: /Name/ })).toHaveAttribute(
      "aria-sort",
      "none",
    );
  });

  it("an explicit sort still wins over the default", () => {
    render(
      <ResultTable
        fields={fields}
        rows={rows}
        sorts={[{ field: "name", direction: "asc" }]}
        defaultSorts={[{ field: "score", direction: "desc" }]}
        onSortChange={vi.fn()}
        total={1}
        page={1}
        pageSize={50}
      />,
    );

    expect(screen.getByRole("columnheader", { name: /Name/ })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    expect(screen.getByRole("columnheader", { name: /Score/ })).toHaveAttribute(
      "aria-sort",
      "none",
    );
  });

  it("⭐ pressing the default-sorted header still CHANGES something", () => {
    /*
      The trap in the fix. If the cycle read the default instead of the
      real (empty) sort list, "already descending → ascending" would be
      computed from a value the user never chose — and clearing it later
      would fall straight back to the default, leaving a button that
      does nothing. The indicator reads the default; the cycle does not.
    */
    const onSortChange = vi.fn();
    render(
      <ResultTable
        fields={fields}
        rows={rows}
        sorts={[]}
        defaultSorts={[{ field: "score", direction: "desc" }]}
        onSortChange={onSortChange}
        total={1}
        page={1}
        pageSize={50}
      />,
    );

    screen.getByRole("button", { name: /Score/ }).click();
    expect(onSortChange).toHaveBeenCalledWith([{ field: "score", direction: "desc" }]);
  });

  it("puts a real button in the header, so it is reachable by keyboard", () => {
    render(
      <ResultTable
        fields={fields}
        rows={rows}
        sorts={[]}
        onSortChange={vi.fn()}
        total={1}
        page={1}
        pageSize={50}
      />,
    );
    expect(screen.getByRole("button", { name: /Name/ })).toBeInTheDocument();
  });

  it("hides the id column and still links the row", () => {
    render(
      <ResultTable
        fields={fields}
        rows={rows}
        sorts={[]}
        hrefFor={(row) => `/sales/leads/${String(row.id)}`}
        total={1}
        page={1}
        pageSize={50}
      />,
    );

    expect(screen.queryByRole("columnheader", { name: "Id" })).toBeNull();
    expect(screen.getByRole("link", { name: "Ravi Sharma" })).toHaveAttribute(
      "href",
      "/sales/leads/11111111-1111-4111-8111-111111111111",
    );
  });

  it("cycles a header press descending → ascending → unsorted", () => {
    expect(nextSorts([], "score")).toEqual([{ field: "score", direction: "desc" }]);
    expect(nextSorts([{ field: "score", direction: "desc" }], "score")).toEqual([
      { field: "score", direction: "asc" },
    ]);
    expect(nextSorts([{ field: "score", direction: "asc" }], "score")).toEqual([]);
  });

  it("⭐ formats money out of minor units without going through a float", () => {
    // ₹4.5 crore in paise. `Number(87456330000000)/100` is where the last
    // digits of an agreement value quietly disappear.
    expect(formatValue("450000000", "money")).toBe("₹45,00,000.00");
    expect(formatValue("87456330000000", "money")).toBe("₹8,74,56,33,00,000.00");
    expect(formatValue(null, "money")).toBe("—");
    // A jsonb column is never stringified into a cell.
    expect(formatValue({ a: 1 }, "json")).toBe("—");
  });
});

/* ------------------------------------------------------------------ */
/* ⭐ THE SHELL IS ADDITIVE, AND IT ALWAYS ASKS THE ENGINE             */
/* ------------------------------------------------------------------ */

describe("the record list shell", () => {
  function harness() {
    return {
      runView: vi.fn(async () => ({
        ok: true as const,
        data: {
          objectKey: "lead",
          label: "Lead",
          pluralLabel: "Leads",
          fields: [
            { name: "id", label: "Id", kind: "uuid", enumValues: null },
            { name: "name", label: "Name", kind: "text", enumValues: null },
          ],
          rows: [{ id: "11111111-1111-4111-8111-111111111111", name: "Ravi Sharma" }],
          total: 1,
          page: 1,
          pageSize: 50,
          scopedToOwnRecords: false,
        },
      })),
      runBoard: vi.fn(async () => ({
        ok: true as const,
        data: {
          objectKey: "lead",
          label: "Lead",
          groupField: { name: "status", label: "Status", kind: "enum" },
          fields: [{ name: "name", label: "Name", kind: "text" }],
          columns: [],
          columnsTruncated: false,
          scopedToOwnRecords: false,
        },
      })),
      getView: vi.fn(async () => ({
        ok: true as const,
        data: {
          id: "22222222-2222-4222-8222-222222222222",
          viewType: "table" as const,
          filter: oneCondition("status", "eq", "new"),
          sorts: [{ field: "score" as const, direction: "desc" as const }],
          groupBy: null,
          dateField: null,
          visibleColumns: [{ field: "name" }],
        },
      })),
      createView: vi.fn(async () => ({ ok: true as const, data: { id: "new" } })),
      updateView: vi.fn(async () => ({ ok: true as const, data: { id: "x" } })),
      deleteView: vi.fn(async () => ({ ok: true as const, data: { id: "x" } })),
      setDefaultView: vi.fn(async () => ({ ok: true as const, data: { viewId: null } })),
    };
  }

  const SAVED = [
    {
      id: "22222222-2222-4222-8222-222222222222",
      name: "Hot leads",
      viewType: "table" as const,
      isShared: false,
      isWorkspaceDefault: false,
      isMine: true,
      canManage: true,
    },
  ];

  it("⭐ renders the page's own list and issues NO query until a view is chosen", async () => {
    const actions = harness();

    render(
      <RecordListPage
        object={LEAD}
        views={SAVED}
        defaultViewId={null}
        actions={actions}
        hrefPattern="/sales/leads/{id}"
      >
        <p>The pipeline board that was already here</p>
      </RecordListPage>,
    );

    expect(screen.getByText("The pipeline board that was already here")).toBeInTheDocument();

    // ⚠️ THE REGRESSION GUARD. A shell that fetched on mount would put a
    // second, slower copy of every list page in front of every user on
    // every page load — additive in the changelog and a regression on the
    // screen.
    await waitFor(() => expect(actions.runView).not.toHaveBeenCalled());
    expect(actions.runBoard).not.toHaveBeenCalled();
  });

  it("⭐ runs the definition through the engine, never by view id", async () => {
    const user = userEvent.setup();
    const actions = harness();

    render(
      <RecordListPage
        object={LEAD}
        views={SAVED}
        defaultViewId={null}
        actions={actions}
        hrefPattern="/sales/leads/{id}"
      >
        <p>The pipeline board that was already here</p>
      </RecordListPage>,
    );

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Saved view" }),
      "22222222-2222-4222-8222-222222222222",
    );

    await waitFor(() => expect(actions.runView).toHaveBeenCalled());

    const sent = actions.runView.mock.calls[0]![0] as Record<string, unknown>;

    // The object is named explicitly and the SCOPE is not in the payload
    // at all — `server/views/query.ts` derives it from the caller. A
    // client that could send a scope would be a client that could widen
    // one.
    expect(sent.objectKey).toBe("lead");
    expect(sent).not.toHaveProperty("viewId");
    expect(sent).not.toHaveProperty("tenantId");
    expect(sent).not.toHaveProperty("ownerUserId");
    expect(sent.filter).toEqual(oneCondition("status", "eq", "new"));

    // And the page's own list has stepped aside for the view's results.
    await waitFor(() =>
      expect(screen.getByRole("link", { name: "Ravi Sharma" })).toHaveAttribute(
        "href",
        "/sales/leads/11111111-1111-4111-8111-111111111111",
      ),
    );
    expect(screen.queryByText("The pipeline board that was already here")).toBeNull();
  });

  it("offers a way back to the page the reader knows", async () => {
    const user = userEvent.setup();
    const actions = harness();

    render(
      <RecordListPage
        object={LEAD}
        views={SAVED}
        defaultViewId={null}
        actions={actions}
        hrefPattern="/sales/leads/{id}"
      >
        <p>The pipeline board that was already here</p>
      </RecordListPage>,
    );

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Saved view" }),
      "22222222-2222-4222-8222-222222222222",
    );
    await waitFor(() => expect(actions.runView).toHaveBeenCalled());

    await user.click(screen.getByRole("button", { name: "Back to the standard list" }));

    expect(screen.getByText("The pipeline board that was already here")).toBeInTheDocument();
  });

  it("windows a calendar with an ANDed override rather than replacing the filter", async () => {
    const user = userEvent.setup();
    const actions = harness();

    render(
      <RecordListPage
        object={LEAD}
        views={SAVED}
        defaultViewId={null}
        actions={actions}
        hrefPattern="/sales/leads/{id}"
      >
        <p>The pipeline board that was already here</p>
      </RecordListPage>,
    );

    await user.click(screen.getByRole("radio", { name: "Calendar" }));
    await waitFor(() => expect(actions.runView).toHaveBeenCalled());

    const sent = actions.runView.mock.calls.at(-1)![0] as {
      filter: unknown;
      overrideFilter: { children: Array<{ operator: string; field: string }> };
      columns: Array<{ field: string }>;
    };

    // ⭐ The month window is an OVERRIDE, which the server ANDs on top of
    // the view's own filter. Putting it in `filter` would discard what
    // the view says and show records the reader had filtered out.
    expect(sent.overrideFilter.children.map((child) => child.operator)).toEqual(["gte", "lt"]);
    expect(sent.overrideFilter.children.every((child) => child.field === LEAD.defaultDateField)).toBe(
      true,
    );
    // The date field has to be selected for the calendar to place a record.
    expect(sent.columns.some((column) => column.field === LEAD.defaultDateField)).toBe(true);
  });
});
