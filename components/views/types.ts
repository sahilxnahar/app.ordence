/**
 * Ordence — What the Browser Is Told About an Object
 * Version: v0.28.0-alpha
 *
 * Types only. No runtime code, no "use client" — everything here is
 * erased at compile time, which is what lets a server component and a
 * client component agree on a shape without either importing the other's
 * module graph.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THIS IS A DESCRIPTION, NOT AN AUTHORITY
 * ══════════════════════════════════════════════════════════════════════
 * `ViewObjectDescription` is the payload `server/views/catalog.ts` sends
 * to the builder so that the filter editor can draw a field picker. It is
 * structurally identical to that file's `ObjectDescription` on purpose —
 * a page hands one straight through — and it is restated here rather than
 * imported so that no client component ever has a static edge into a
 * `server-only` module.
 *
 * ⚠️ NOTHING IN THIS FILE DECIDES WHAT MAY BE READ. The browser can post
 * whatever field name it likes; `resolveField()` in `lib/views/registry.ts`
 * is what refuses it, on every replay, on the server. A field missing from
 * the list below is a field the UI does not OFFER — which is a usability
 * property, not a boundary. The distinction is spelled out at length in
 * the header of `server/views/catalog.ts` and it is worth reading there.
 */

import type {
  ColumnSpec,
  FieldKind,
  FilterGroup,
  FilterOperator,
  SortSpec,
  ViewType,
} from "@/lib/views/types";

export type ViewFieldDescription = {
  name: string;
  label: string;
  kind: FieldKind;
  enumValues: readonly string[] | null;
  filterable: boolean;
  sortable: boolean;
  groupable: boolean;
  /**
   * Which comparisons the server would accept for this field.
   *
   * ⚠️ THE FILTER EDITOR DOES NOT READ THIS AND THAT IS DELIBERATE. It
   * calls `operatorsForKind()` from `lib/views/operators.ts` itself, so
   * that the list on screen is derived from the same pure catalogue the
   * planner consults rather than from a payload that could have been
   * assembled by an older server during a rolling deploy. The field stays
   * on the type because the catalogue sends it and dropping it would make
   * the two shapes incompatible.
   */
  operators?: Array<{ key: FilterOperator; label: string; arity: string }>;
};

export type ViewObjectDescription = {
  key: string;
  label: string;
  pluralLabel: string;
  dynamicObjectId: string | null;
  /** True when this caller sees only the records assigned to them. Announced. */
  scopedToOwnRecords: boolean;
  /**
   * ⭐ THE ORDER THE SERVER APPLIES WHEN A VIEW SPECIFIES NONE.
   *
   * ⚠️ SENT BECAUSE THE TABLE HEADER LIES WITHOUT IT. `runView` with an
   * empty `sorts` list does NOT return unsorted rows — `resolveRequest`
   * in `server/views/query.ts` substitutes the registry's default. So
   * the browser used to receive rows in `updated_at desc` while
   * `working.sorts` was `[]`, and every sortable header rendered
   * `aria-sort="none"`.
   *
   * To a screen-reader user that is a table announced as unsorted whose
   * rows are in an order they cannot account for — which is worse than
   * no sort indication at all, because it is a confident wrong answer.
   *
   * ⚠️ IT IS FOR DISPLAY, NOT FOR STATE. It is never copied into
   * `working.sorts`; see the note on `defaultWorkingView`.
   */
  defaultSorts: readonly SortSpec[];
  defaultGroupBy: string | null;
  defaultDateField: string | null;
  defaultColumns: readonly string[];
  fields: ViewFieldDescription[];
};

/**
 * The definition currently on screen — a saved view's, or the object's
 * defaults, or the two plus whatever the reader has just changed.
 *
 * ⚠️ IT CARRIES NO IDENTITY AND NO SHARING STATE. Those live on the saved
 * row and are decided by the server; a working copy that carried
 * `isShared` would be a client-side value that looks like it grants
 * something.
 */
export type WorkingView = {
  viewType: ViewType;
  filter: FilterGroup;
  sorts: SortSpec[];
  groupBy: string | null;
  dateField: string | null;
  columns: ColumnSpec[];
};

/** One row as the engine returns it. Keyed by field NAME, not by column. */
export type ViewRow = Record<string, unknown>;

/** The subset of a field descriptor a renderer needs. */
export type RenderField = {
  name: string;
  label: string;
  kind: string;
  enumValues?: readonly string[] | null;
};
