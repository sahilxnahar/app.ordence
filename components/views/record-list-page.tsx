"use client";

/**
 * Ordence — The Record List Shell
 * Version: v0.28.0-alpha
 *
 * One component that puts the saved-view layer on top of ANY list page:
 * the view bar, a table/board/calendar switcher, the filter editor, the
 * column picker, and whichever renderer the current view type needs — all
 * driven by the object description out of `lib/views/registry.ts`, so it
 * works for leads, for bookings, and for a Phase 24 runtime object nobody
 * has written a component for.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ THE ONE RULE THIS FILE EXISTS TO NOT BREAK
 * ══════════════════════════════════════════════════════════════════════
 * THE VIEW SUPPLIES THE FILTER. THE CALLER'S PERMISSIONS SUPPLY THE
 * SCOPE.
 *
 * Every query this component issues goes through `runSavedView` /
 * `runSavedBoard`, which resolve the object, call
 * `requireViewObjectAccess` against the CALLER, and hand the resulting
 * `ViewerScope` to `compileWhere` as its first, required argument. The
 * view contributes a filter that is ANDed INSIDE that scope and can only
 * ever remove rows.
 *
 * ⚠️ THERE IS DELIBERATELY NO SECOND PATH. This component does not import
 * `@/db`, does not import a planner, and does not have a "fast" branch
 * that fetches rows some other way. If a future change needs data this
 * shell cannot get, the fix is in `server/views/query.ts` where the gate
 * is — not here, where it is not.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ ADDITIVE, NEVER A REGRESSION
 * ══════════════════════════════════════════════════════════════════════
 * `children` is the page exactly as it was before this phase: the
 * hardcoded pipeline board, the inventory grid, the bookings table. It is
 * what renders until somebody SELECTS a view or CHANGES something.
 *
 * That is not laziness about migrating the pages. Those components know
 * things the generic renderer cannot: that a unit's hold expires in four
 * hours, that calling a New Jersey buyer at 11am IST is calling them at
 * 1:30am, that `won` is reached by registering a booking and must not be
 * a drop target. Replacing them with a generic table would be a feature
 * and a downgrade in the same commit.
 *
 * So the rule is: no saved view, nothing customised → the page you had.
 * The moment a reader asks for something else, the engine answers.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { GenericKanban, type BoardCardData } from "./generic-kanban";
import { SavedViewBar, type SavedViewOption } from "./saved-view-bar";
import { FilterEditor } from "./filter-editor";
import { ColumnPicker } from "./column-picker";
import { CalendarView, addMonths, startOfMonth, type CalendarEvent } from "./calendar-view";
import { ResultTable } from "./result-table";
import { countNodes } from "./filter-tree";
import type { ViewObjectDescription, ViewRow, WorkingView } from "./types";
import { emptyFilter } from "@/lib/views/types";
import type { ColumnSpec, FilterGroup, SortSpec, ViewType } from "@/lib/views/types";
import { KANBAN_COLUMN_CARD_LIMIT, MAX_PAGE_SIZE } from "@/lib/views/limits";
import type { ActionResult } from "@/lib/validators/crm";

/* ------------------------------------------------------------------ */
/* WHAT THE SERVER SENDS BACK                                          */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ RESTATED STRUCTURALLY RATHER THAN IMPORTED FROM `server/views/query.ts`.
 * That module is `server-only`; a type import from it would compile, and
 * would leave a client component one careless edit away from a value
 * import that does not. The shapes below are subsets of the real ones, so
 * the real actions are assignable to the props without a cast.
 */
export type ViewPageResult = {
  objectKey: string;
  label: string;
  pluralLabel: string;
  fields: Array<{
    name: string;
    label: string;
    kind: string;
    enumValues: readonly string[] | null;
  }>;
  rows: ViewRow[];
  total: number;
  page: number;
  pageSize: number;
  scopedToOwnRecords: boolean;
};

export type BoardPageResult = {
  objectKey: string;
  label: string;
  groupField: { name: string; label: string; kind: string };
  fields: Array<{ name: string; label: string; kind: string }>;
  columns: Array<{
    value: string | null;
    label: string;
    total: number;
    cards: ViewRow[];
    truncated: boolean;
  }>;
  columnsTruncated: boolean;
  scopedToOwnRecords: boolean;
};

export type SavedViewDefinitionRow = {
  id: string;
  viewType: ViewType;
  filter: FilterGroup;
  sorts: SortSpec[];
  groupBy: string | null;
  dateField: string | null;
  visibleColumns: ColumnSpec[];
};

/**
 * The server actions, INJECTED.
 *
 * ⚠️ PROPS RATHER THAN IMPORTS, and for a reason that is not testing
 * convenience: `server/actions/views.ts` transitively builds a database
 * client at module scope, so a client component importing it drags a
 * driver into the browser bundle and explodes under jsdom. The same
 * arrangement `components/workflows/workflow-builder.tsx` uses, for the
 * same reason.
 */
export type RecordListActions = {
  runView: (input: unknown) => Promise<ActionResult<ViewPageResult>>;
  runBoard: (input: unknown) => Promise<ActionResult<BoardPageResult>>;
  getView: (input: { id: string }) => Promise<ActionResult<SavedViewDefinitionRow>>;
  createView: (input: unknown) => Promise<ActionResult<{ id: string }>>;
  updateView: (input: unknown) => Promise<ActionResult<{ id: string }>>;
  deleteView: (input: unknown) => Promise<ActionResult<{ id: string }>>;
  setDefaultView: (input: unknown) => Promise<ActionResult<{ viewId: string | null }>>;
};

export type RecordListPageProps = {
  object: ViewObjectDescription;
  views: SavedViewOption[];
  /** The reader's landing view, personal first then the workspace's. */
  defaultViewId: string | null;
  canShare?: boolean;
  actions: RecordListActions;
  /**
   * Where a record lives, with `{id}` where the identifier goes:
   * `/sales/leads/{id}`, `/contacts/{id}/edit`.
   *
   * ⚠️ A PATTERN RATHER THAN A PREFIX, because the identifier is not
   * always last. Contacts and companies have no detail route in this
   * product — only `/contacts/<id>/edit` — and a prefix-only prop would
   * silently produce links to a 404 on two of the seven pages.
   *
   * ⚠️ AND A STRING RATHER THAN A FUNCTION. This component is rendered by
   * a SERVER component, and a function cannot cross that boundary:
   * passing one fails at runtime with "functions cannot be passed
   * directly to client components", which is discovered on the page
   * rather than in the type checker. Omit it for un-clickable rows.
   */
  hrefPattern?: string | null;
  /** ⭐ The page as it is today. Rendered until a view is chosen. */
  children: ReactNode;
};

/* ------------------------------------------------------------------ */
/* THE DEFAULT DEFINITION                                              */
/* ------------------------------------------------------------------ */

/**
 * What "no view" means, computed in the browser from the same object
 * description the server built.
 *
 * ⚠️ `sorts` IS EMPTY ON PURPOSE. `resolveRequest` substitutes
 * `object.defaultSorts` for an empty list, so leaving it empty means the
 * registry stays the single source of the default order — copying it into
 * the browser would be a second copy that drifts.
 */
export function defaultWorkingView(object: ViewObjectDescription): WorkingView {
  return {
    viewType: "table",
    filter: emptyFilter(),
    sorts: [],
    groupBy: object.defaultGroupBy,
    dateField: object.defaultDateField,
    columns: object.defaultColumns.map((field) => ({ field })),
  };
}

/** Structural equality, used only to decide whether anything has changed. */
export function sameDefinition(a: WorkingView, b: WorkingView): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/* ------------------------------------------------------------------ */
/* THE SHELL                                                           */
/* ------------------------------------------------------------------ */

export function RecordListPage({
  object,
  views,
  defaultViewId,
  canShare = false,
  actions,
  hrefPattern,
  children,
}: RecordListPageProps) {
  const router = useRouter();
  const panelId = useId();
  const typeGroupId = useId();

  const defaults = useMemo(() => defaultWorkingView(object), [object]);

  /*
    ⚠️ A row with no `id` gets no link rather than a link to the list
    itself. `resolveColumns` always selects `id`, so this only bites when
    a future object has none — and a table of rows that all navigate to
    the same page is worse than a table of plain text.
  */
  const hrefFor = useCallback(
    (row: ViewRow): string | null =>
      hrefPattern && typeof row.id === "string"
        ? hrefPattern.replace("{id}", encodeURIComponent(row.id))
        : null,
    [hrefPattern],
  );

  /*
    ⚠️ STARTS AT `null` EVEN WHEN THE READER HAS A LANDING VIEW, and the
    effect below selects it. Seeding it with `defaultViewId` would mark
    the shell engaged before the definition has loaded, so the first
    render would run the OBJECT'S DEFAULTS against the server and throw
    the answer away a moment later — one wasted query per page load, on
    every page in the product.
  */
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  const [working, setWorking] = useState<WorkingView>(defaults);
  /** The definition as it is SAVED, so "Save changes" knows there are any. */
  const [baseline, setBaseline] = useState<WorkingView>(defaults);
  const [page, setPage] = useState(1);
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const [editing, setEditing] = useState(false);

  const [table, setTable] = useState<ViewPageResult | null>(null);
  const [board, setBoard] = useState<BoardPageResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /*
    ⚠️ Refs, not effect dependencies. `actions` and `object` are props from
    a server component, so their identity changes on every navigation but
    their contents do not — listing them as dependencies would refetch on
    every parent render and, with an object literal in the page's JSX,
    would loop.
  */
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const objectRef = useRef(object);
  objectRef.current = object;

  const customised = !sameDefinition(working, defaults);
  /** ⭐ The switch. False → the page renders exactly as it did before. */
  const engaged = activeViewId !== null || customised;
  const dirty = activeViewId !== null && !sameDefinition(working, baseline);

  /* --- Selecting a saved view ------------------------------------- */

  const selectView = useCallback(
    async (viewId: string | null) => {
      setError(null);
      setPage(1);

      if (viewId === null) {
        setActiveViewId(null);
        setWorking(defaults);
        setBaseline(defaults);
        return;
      }

      setBusy(true);
      const outcome = await actionsRef.current.getView({ id: viewId });
      setBusy(false);

      if (!outcome.ok) {
        setError(outcome.error);
        return;
      }

      const loaded: WorkingView = {
        viewType: outcome.data.viewType,
        filter: outcome.data.filter ?? emptyFilter(),
        sorts: outcome.data.sorts ?? [],
        groupBy: outcome.data.groupBy,
        dateField: outcome.data.dateField,
        columns: outcome.data.visibleColumns ?? [],
      };

      setActiveViewId(viewId);
      setWorking(loaded);
      setBaseline(loaded);
    },
    [defaults],
  );

  /* --- Opening to the reader's default, once ---------------------- */
  //
  // ⚠️ `useRef` GUARD RATHER THAN AN EMPTY DEPENDENCY ARRAY. React 19 runs
  // effects twice in development strict mode; without the guard the
  // landing view is fetched twice on every page load, which is harmless
  // and looks exactly like a bug when somebody reads the network tab.
  const landed = useRef(false);
  useEffect(() => {
    if (landed.current) return;
    landed.current = true;
    if (defaultViewId) void selectView(defaultViewId);
  }, [defaultViewId, selectView]);

  /* --- Running ----------------------------------------------------- */

  const monthKey = `${month.getFullYear()}-${month.getMonth()}`;

  const requestKey = useMemo(
    () => JSON.stringify({ working, page, monthKey: working.viewType === "calendar" ? monthKey : null }),
    [working, page, monthKey],
  );

  useEffect(() => {
    if (!engaged) {
      setTable(null);
      setBoard(null);
      return;
    }

    let cancelled = false;
    setBusy(true);
    setError(null);

    void (async () => {
      const outcome = await runCurrent(
        actionsRef.current,
        objectRef.current,
        working,
        page,
        month,
      );

      // ⚠️ The guard that stops a slow first request overwriting a fast
      // second one. Without it, typing in a filter produces results that
      // arrive out of order and a table that shows the second-to-last
      // thing you asked for.
      if (cancelled) return;
      setBusy(false);

      if (outcome.kind === "error") {
        setError(outcome.message);
        return;
      }
      if (outcome.kind === "board") {
        setBoard(outcome.data);
        setTable(null);
        return;
      }
      setTable(outcome.data);
      setBoard(null);
    })();

    return () => {
      cancelled = true;
    };
    // `working`, `page` and `month` are folded into `requestKey`; listing
    // them as well would refire on an identical object with a new
    // identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engaged, requestKey]);

  /* --- Saving ------------------------------------------------------ */

  const definitionPayload = () => ({
    viewType: working.viewType,
    filter: working.filter,
    sorts: working.sorts,
    groupBy: working.groupBy,
    dateField: working.dateField,
    columns: working.columns,
  });

  const saveAs = async (name: string, isShared: boolean): Promise<string | null> => {
    const outcome = await actionsRef.current.createView({
      objectKey: object.key,
      dynamicObjectId: object.dynamicObjectId,
      name,
      isShared,
      ...definitionPayload(),
    });
    if (!outcome.ok) return firstMessage(outcome);
    setActiveViewId(outcome.data.id);
    setBaseline(working);
    router.refresh();
    return null;
  };

  const saveChanges = async (): Promise<string | null> => {
    if (!activeViewId) return null;
    const outcome = await actionsRef.current.updateView({
      id: activeViewId,
      ...definitionPayload(),
    });
    if (!outcome.ok) return firstMessage(outcome);
    setBaseline(working);
    router.refresh();
    return null;
  };

  const remove = async (viewId: string): Promise<string | null> => {
    const outcome = await actionsRef.current.deleteView({ id: viewId });
    if (!outcome.ok) return firstMessage(outcome);
    setActiveViewId(null);
    setWorking(defaults);
    setBaseline(defaults);
    router.refresh();
    return null;
  };

  const makeDefault = async (viewId: string | null): Promise<string | null> => {
    const outcome = await actionsRef.current.setDefaultView({
      objectKey: object.key,
      dynamicObjectId: object.dynamicObjectId,
      viewId,
    });
    if (!outcome.ok) return firstMessage(outcome);
    router.refresh();
    return null;
  };

  /* --- Rendering --------------------------------------------------- */

  const groupableFields = object.fields.filter((field) => field.groupable);
  const dateFields = object.fields.filter((field) => field.kind === "date");
  const sortableNames = useMemo(
    () => new Set(object.fields.filter((field) => field.sortable).map((f) => f.name)),
    [object],
  );

  return (
    <div className="flex flex-col gap-4">
      <SavedViewBar
        views={views}
        activeViewId={activeViewId}
        defaultViewId={defaultViewId}
        scopedToOwnRecords={object.scopedToOwnRecords}
        canShare={canShare}
        isDirty={dirty}
        onSelect={(id) => void selectView(id)}
        onSaveAs={saveAs}
        onSaveChanges={saveChanges}
        onDelete={remove}
        onMakeDefault={makeDefault}
      />

      <div className="flex flex-wrap items-center gap-2">
        {/*
          ⚠️ A RADIO GROUP IN A FIELDSET, NOT THREE BUTTONS WITH
          `aria-pressed`. "Table, board or calendar" is one choice among
          three mutually exclusive options, which is what radios ARE — and
          radios come with arrow-key navigation that a button group has to
          reimplement and usually does not.
        */}
        <fieldset className="flex items-center gap-1 rounded-md border border-border px-2 py-1">
          <legend className="sr-only">How to show these records</legend>
          {VIEW_TYPE_CHOICES.map((choice) => (
            <label
              key={choice.value}
              className="flex items-center gap-1.5 rounded px-2 py-0.5 text-xs"
              htmlFor={`${typeGroupId}-${choice.value}`}
            >
              <input
                id={`${typeGroupId}-${choice.value}`}
                type="radio"
                name={typeGroupId}
                value={choice.value}
                checked={working.viewType === choice.value}
                disabled={
                  (choice.value === "kanban" && groupableFields.length === 0) ||
                  (choice.value === "calendar" && dateFields.length === 0)
                }
                onChange={() => {
                  setPage(1);
                  setWorking((current) => ({
                    ...current,
                    viewType: choice.value,
                    // A board needs a group-by and a calendar needs a
                    // date field. Falling back to the registry's default
                    // means switching type never produces a refusal the
                    // reader has to fix before they see anything.
                    groupBy:
                      choice.value === "kanban"
                        ? (current.groupBy ??
                          object.defaultGroupBy ??
                          groupableFields[0]?.name ??
                          null)
                        : current.groupBy,
                    dateField:
                      choice.value === "calendar"
                        ? (current.dateField ??
                          object.defaultDateField ??
                          dateFields[0]?.name ??
                          null)
                        : current.dateField,
                  }));
                }}
              />
              <span>{choice.label}</span>
            </label>
          ))}
        </fieldset>

        {working.viewType === "kanban" && groupableFields.length > 0 ? (
          <label className="flex items-center gap-2 text-xs">
            <span>Columns from</span>
            <select
              value={working.groupBy ?? ""}
              onChange={(event) =>
                setWorking((current) => ({ ...current, groupBy: event.target.value || null }))
              }
              className="rounded border border-input bg-background px-2 py-1 text-xs"
            >
              {groupableFields.map((field) => (
                <option key={field.name} value={field.name}>
                  {field.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {working.viewType === "calendar" && dateFields.length > 0 ? (
          <label className="flex items-center gap-2 text-xs">
            <span>Place records on</span>
            <select
              value={working.dateField ?? ""}
              onChange={(event) =>
                setWorking((current) => ({ ...current, dateField: event.target.value || null }))
              }
              className="rounded border border-input bg-background px-2 py-1 text-xs"
            >
              {dateFields.map((field) => (
                <option key={field.name} value={field.name}>
                  {field.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <div className="ml-auto flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            className="h-8 text-xs"
            aria-expanded={editing}
            aria-controls={panelId}
            onClick={() => setEditing((open) => !open)}
          >
            {editing ? "Hide filters and columns" : "Filters and columns"}
            {countNodes(working.filter) > 1 ? (
              <span className="ml-1.5 rounded bg-secondary px-1.5 text-[10px]">
                {countNodes(working.filter) - 1}
              </span>
            ) : null}
          </Button>

          {engaged ? (
            /*
              ⚠️ THE WAY BACK. Without it, a reader who ticks one filter
              can never get to the page they know — and "reload the tab"
              is not a thing anybody should have to work out.
            */
            <Button
              type="button"
              variant="ghost"
              className="h-8 text-xs"
              onClick={() => {
                setActiveViewId(null);
                setWorking(defaults);
                setBaseline(defaults);
                setPage(1);
                setError(null);
              }}
            >
              Back to the standard list
            </Button>
          ) : null}
        </div>
      </div>

      {editing ? (
        <div id={panelId} className="flex flex-col gap-4 rounded-lg border border-border p-3">
          <FilterEditor
            object={object}
            filter={working.filter}
            onChange={(filter) => {
              setPage(1);
              setWorking((current) => ({ ...current, filter }));
            }}
          />

          <div>
            <h3 className="mb-2 text-xs font-medium uppercase text-muted-foreground">
              Columns
            </h3>
            <ColumnPicker
              object={object}
              columns={working.columns}
              onChange={(columns) => setWorking((current) => ({ ...current, columns }))}
            />
          </div>
        </div>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      ) : null}

      {!engaged ? (
        /* ⭐ The page exactly as it was. See the header. */
        <div>{children}</div>
      ) : working.viewType === "kanban" ? (
        board ? (
          <GenericKanban
            columns={board.columns.map((column) => ({
              ...column,
              cards: column.cards as BoardCardData[],
            }))}
            fields={board.fields.filter((field) => field.name !== "id")}
            groupLabel={board.groupField.label}
            hrefFor={hrefPattern ? (card) => hrefFor(card) ?? "#" : undefined}
            scopedToOwnRecords={board.scopedToOwnRecords}
            columnsTruncated={board.columnsTruncated}
            cardLimit={KANBAN_COLUMN_CARD_LIMIT}
          />
        ) : (
          <Placeholder busy={busy} />
        )
      ) : working.viewType === "calendar" ? (
        table && working.dateField ? (
          <CalendarView
            month={month}
            events={toEvents(table, working.dateField, hrefFor)}
            dateFieldLabel={labelFor(object, working.dateField)}
            onMonthChange={(next) => {
              setPage(1);
              setMonth(next);
            }}
            scopedToOwnRecords={table.scopedToOwnRecords}
            truncated={table.total > table.rows.length}
          />
        ) : (
          <Placeholder busy={busy} />
        )
      ) : table ? (
        <ResultTable
          fields={table.fields}
          rows={table.rows}
          sorts={working.sorts}
          /*
            ⭐ The order the SERVER fell back to. `working.sorts` is empty
            until somebody presses a header, but the rows are not in
            insertion order — `resolveRequest()` substituted this. Passing
            it is the difference between a header that describes the table
            and one that contradicts it.
          */
          defaultSorts={object.defaultSorts}
          sortableFields={sortableNames}
          onSortChange={(sorts) => {
            setPage(1);
            setWorking((current) => ({ ...current, sorts }));
          }}
          hrefFor={hrefPattern ? hrefFor : undefined}
          total={table.total}
          page={table.page}
          pageSize={table.pageSize}
          onPageChange={setPage}
          scopedToOwnRecords={table.scopedToOwnRecords}
          busy={busy}
        />
      ) : (
        <Placeholder busy={busy} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* RUNNING ONE REQUEST                                                 */
/* ------------------------------------------------------------------ */

type RunOutcome =
  | { kind: "table"; data: ViewPageResult }
  | { kind: "board"; data: BoardPageResult }
  | { kind: "error"; message: string };

/**
 * ⭐ THE ONLY PLACE THIS COMPONENT ASKS FOR DATA, AND IT ALWAYS ASKS THE
 * ENGINE.
 *
 * ⚠️ NOTE WHAT IS **NOT** SENT: a `viewId`. The definition on screen may
 * have been edited since it was loaded, and running by id would show the
 * SAVED filter under an EDITED filter's controls — a reader who unticks a
 * condition and sees the same rows concludes the filter does nothing.
 *
 * Sending the definition instead costs nothing in safety: `resolveRequest`
 * derives the scope from the caller either way, so an ad-hoc definition
 * and a stored one are narrowed identically. The saved row is the
 * STARTING POINT for the editor, never the authority for the query.
 */
async function runCurrent(
  actions: RecordListActions,
  object: ViewObjectDescription,
  working: WorkingView,
  page: number,
  month: Date,
): Promise<RunOutcome> {
  const base = {
    objectKey: object.key,
    dynamicObjectId: object.dynamicObjectId,
    filter: working.filter,
    sorts: working.sorts,
    columns: working.columns,
  };

  if (working.viewType === "kanban") {
    if (!working.groupBy) {
      return { kind: "error", message: "A board needs a field to make its columns from." };
    }
    const outcome = await actions.runBoard({ ...base, groupBy: working.groupBy });
    return outcome.ok
      ? { kind: "board", data: outcome.data }
      : { kind: "error", message: firstMessage(outcome) };
  }

  if (working.viewType === "calendar") {
    if (!working.dateField) {
      return {
        kind: "error",
        message: "A calendar needs a date field to place records on.",
      };
    }

    const outcome = await actions.runView({
      ...base,
      // The date field has to be SELECTED for the calendar to place a
      // record. `resolveColumns` de-duplicates, so adding it when it is
      // already visible costs nothing.
      columns: [...working.columns, { field: working.dateField }],
      /*
        ⭐ THE MONTH WINDOW GOES IN `overrideFilter`, WHICH THE SERVER
        **ANDS** ONTO THE VIEW'S OWN FILTER. It narrows; it cannot widen.
        Putting it in `filter` instead would replace what the view says
        and quietly show records the reader had filtered out.
      */
      overrideFilter: monthWindow(working.dateField, month),
      page: 1,
      pageSize: MAX_PAGE_SIZE,
    });

    return outcome.ok
      ? { kind: "table", data: outcome.data }
      : { kind: "error", message: firstMessage(outcome) };
  }

  const outcome = await actions.runView({ ...base, page, pageSize: 50 });
  return outcome.ok
    ? { kind: "table", data: outcome.data }
    : { kind: "error", message: firstMessage(outcome) };
}

/**
 * `[first of the month, first of the next month)`.
 *
 * ⚠️ HALF-OPEN, matching `resolveDateWindow` in `lib/views/operators.ts`.
 * `<=` on the last day loses every timestamp between 23:59:59.001 and
 * midnight — invisible on a `date` column and very visible on a
 * `timestamptz` an automation wrote at 23:59:59.4.
 */
function monthWindow(dateField: string, month: Date): FilterGroup {
  const from = startOfMonth(month);
  const until = addMonths(from, 1);
  return {
    type: "group",
    match: "all",
    children: [
      { type: "condition", field: dateField, operator: "gte", value: from.toISOString() },
      { type: "condition", field: dateField, operator: "lt", value: until.toISOString() },
    ],
  };
}

/* ------------------------------------------------------------------ */
/* PLUMBING                                                            */
/* ------------------------------------------------------------------ */

const VIEW_TYPE_CHOICES: Array<{ value: ViewType; label: string }> = [
  { value: "table", label: "Table" },
  { value: "kanban", label: "Board" },
  { value: "calendar", label: "Calendar" },
];

function labelFor(object: ViewObjectDescription, name: string): string {
  return object.fields.find((field) => field.name === name)?.label ?? name;
}

/**
 * Rows → calendar events.
 *
 * ⚠️ A ROW WHOSE DATE IS NULL IS DROPPED, NOT DRAWN ON TODAY. A follow-up
 * that has not been scheduled appearing on today's cell is a call a rep
 * makes because the calendar told them to.
 */
function toEvents(
  page: ViewPageResult,
  dateField: string,
  hrefFor?: (row: ViewRow) => string | null,
): CalendarEvent[] {
  const titleField =
    page.fields.find((field) => field.name !== "id" && field.kind === "text")?.name ??
    page.fields.find((field) => field.name !== "id")?.name ??
    "id";

  const events: CalendarEvent[] = [];

  for (const row of page.rows) {
    const raw = row[dateField];
    if (raw === null || raw === undefined || raw === "") continue;
    const date = raw instanceof Date ? raw : new Date(String(raw));
    if (Number.isNaN(date.getTime())) continue;

    const id = typeof row.id === "string" ? row.id : `${events.length}`;
    const title = row[titleField];

    events.push({
      id,
      date,
      title:
        title === null || title === undefined || title === "" ? "(untitled)" : String(title),
      href: hrefFor?.(row) ?? undefined,
    });
  }

  return events;
}

/**
 * The sentence to show for a refusal.
 *
 * ⚠️ THE FIELD ERROR WINS OVER THE HEADLINE. `createView` answers "please
 * check the view" plus a `fieldErrors` map naming the actual problem —
 * showing only the headline tells somebody something is wrong and not
 * what.
 */
function firstMessage(result: {
  ok: false;
  error: string;
  fieldErrors?: Record<string, string[]>;
}): string {
  const detail = Object.values(result.fieldErrors ?? {})
    .flat()
    .filter((message) => typeof message === "string" && message.length > 0);
  return detail.length > 0 ? `${result.error} ${detail.join(" ")}` : result.error;
}

function Placeholder({ busy }: { busy: boolean }) {
  return (
    <div
      className="h-48 animate-pulse rounded-lg border border-border bg-muted/30"
      role="status"
      aria-live="polite"
    >
      <span className="sr-only">{busy ? "Loading records…" : "No results yet."}</span>
    </div>
  );
}
