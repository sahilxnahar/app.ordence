import "server-only";

/**
 * Ordence — Running a View
 * Version: v0.25.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE ONLY FILE IN THE PHASE THAT ISSUES A STATEMENT, AND IT BUILDS
 *    NOTHING ITSELF
 * ══════════════════════════════════════════════════════════════════════
 * Every identifier, every operator and every bound value in the query
 * below was produced by `lib/views/planner.ts` from descriptors resolved
 * against `lib/views/registry.ts`. This file's entire job is:
 *
 *   1. resolve the object,
 *   2. ⭐ check the CALLER against it and get a scope,
 *   3. hand the planner the scope and the view,
 *   4. splice the tokens into a Drizzle `sql` template,
 *   5. execute.
 *
 * ⚠️ STEP 4 IS THE DANGEROUS ONE AND IT IS FOUR LINES LONG BY DESIGN.
 * `tokensToSql` below is the ONLY place in this codebase where a token
 * list becomes SQL, and it maps `sql` tokens through `sql.raw` and
 * `param` tokens through a placeholder. If somebody ever "simplifies" it
 * by rendering both through `sql.raw`, every filter operand in the
 * product becomes an injection point in one commit — so it is small,
 * commented, and worth reading twice.
 *
 * ⚠️ THE TABLE NAME IS `sql.identifier(object.table)`, WHERE `object`
 * CAME FROM THE REGISTRY OR FROM `assertPhysicalTableName`. It is never
 * a string out of the `saved_views` row: there is no column that holds
 * one, deliberately. See the header of `db/schema/views.ts`.
 */

import { sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { requirePermission } from "@/server/audit";
import { requireViewObjectAccess, toViewActionError, viewFail } from "./guards";
import { resolveViewObject } from "./objects";
import { loadView } from "./definitions";
import { runBoardSchema, runViewSchema } from "@/lib/validators/views";
import {
  compileGroupByColumn,
  compileOrderBy,
  compileSelectList,
  compileWhere,
  resolveColumns,
  resolveGroupBy,
  ViewPlanError,
  type QueryToken,
  type ViewerScope,
} from "@/lib/views/planner";
import { emptyFilter } from "@/lib/views/types";
import type { ColumnSpec, FilterGroup, SortSpec } from "@/lib/views/types";
import {
  KANBAN_COLUMN_CARD_LIMIT,
  MAX_KANBAN_COLUMNS,
} from "@/lib/views/limits";
import { VIEW_PERMISSIONS } from "@/lib/views/access";
import type { ViewFieldDescriptor, ViewObjectDefinition } from "@/lib/views/registry";
import type { ActionResult } from "@/lib/validators/crm";

/* ------------------------------------------------------------------ */
/* ⭐ TOKENS → DRIZZLE                                                  */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐ THE ONE PLACE A TOKEN LIST BECOMES SQL. READ IT TWICE.
 *
 * A `sql` token is a fragment the planner wrote: an operator, a
 * parenthesis, or a quoted identifier that came out of a resolved
 * descriptor. It is spliced with `sql.raw`, because that is what it is.
 *
 * A `param` token is DATA. It goes through `sql\`${value}\``, which makes
 * it a bind parameter — the driver never sees it as text.
 *
 * ⚠️ THE TWO BRANCHES MUST NEVER BE MERGED. Rendering a `param` through
 * `sql.raw` would turn every filter operand in the product into an
 * injection point, and the change would look like a simplification in a
 * diff. That is the whole reason the planner emits two structurally
 * different token types instead of a string with placeholders in it.
 */
function tokensToSql(tokens: readonly QueryToken[]) {
  return sql.join(
    tokens.map((token) =>
      token.kind === "sql" ? sql.raw(token.text) : sql`${token.value}`,
    ),
    sql``,
  );
}

/* ------------------------------------------------------------------ */
/* SHARED RESOLUTION                                                   */
/* ------------------------------------------------------------------ */

type ResolvedRequest = {
  object: ViewObjectDefinition;
  scope: ViewerScope;
  filter: FilterGroup;
  sorts: SortSpec[];
  columns: ColumnSpec[];
  groupBy: string | null;
  tenantId: string;
};

/**
 * Turn a request — a saved view id, or an ad-hoc definition — into
 * everything the planner needs, having passed Gate 5 on the way.
 *
 * ⚠️ THE SAVED VIEW CONTRIBUTES THE FILTER, THE SORTS, THE COLUMNS AND
 * THE GROUPING. IT CONTRIBUTES NO AUTHORITY. `view.ownerUserId` is read
 * for nothing here; the scope comes from `requireViewObjectAccess`,
 * evaluated against the caller. That is the entire answer to "can a
 * shared view widen access?" and it is enforced by there being no other
 * source for a `ViewerScope`.
 */
async function resolveRequest(
  ctx: Awaited<ReturnType<typeof requirePermission>>,
  input: {
    viewId?: string;
    objectKey?: string;
    dynamicObjectId?: string | null;
    filter?: FilterGroup;
    sorts?: SortSpec[];
    columns?: ColumnSpec[];
    groupBy?: string | null;
    overrideFilter?: FilterGroup;
  },
): Promise<ResolvedRequest | { error: string }> {
  let selector: { objectKey: string; dynamicObjectId?: string | null };
  let filter: FilterGroup;
  let sorts: SortSpec[];
  let columns: ColumnSpec[];
  let groupBy: string | null;

  if (input.viewId) {
    // ⚠️ `loadView` applies "mine or shared" IN THE SQL. A view somebody
    // else keeps private is not readable here, so it cannot be run here
    // either — one rule, one place.
    const view = await loadView(ctx.tenant.id, ctx.user.id, input.viewId);
    if (!view) return { error: "That view does not exist." };

    selector = { objectKey: view.objectKey, dynamicObjectId: view.dynamicObjectId };
    filter = view.filter;
    sorts = view.sorts;
    columns = view.visibleColumns;
    groupBy = input.groupBy ?? view.groupBy;
  } else {
    if (!input.objectKey) return { error: "Say which record type to show." };
    selector = { objectKey: input.objectKey, dynamicObjectId: input.dynamicObjectId };
    filter = input.filter ?? emptyFilter();
    sorts = input.sorts ?? [];
    columns = input.columns ?? [];
    groupBy = input.groupBy ?? null;
  }

  const object = await resolveViewObject(ctx.tenant.id, selector);
  if (!object) return { error: "That record type does not exist." };

  /* --- ⭐ GATE 5, ON EVERY RUN, AGAINST THE CALLER ---------------- */
  const scope = requireViewObjectAccess(ctx, object);

  /* --- The reader's own extra filter, ANDed on top ---------------- */
  //
  // ⚠️ ANDed, never substituted. It is the search box above a saved view,
  // and a search box that silently discards the view's own filter shows
  // records the reader believed they had filtered out.
  if (input.overrideFilter) {
    filter = {
      type: "group",
      match: "all",
      children: [filter, input.overrideFilter],
    };
  }

  if (sorts.length === 0) sorts = [...object.defaultSorts];
  if (columns.length === 0) columns = object.defaultColumns.map((field) => ({ field }));

  return {
    object,
    scope,
    filter,
    sorts,
    columns,
    groupBy,
    tenantId: ctx.tenant.id,
  };
}

/* ------------------------------------------------------------------ */
/* TABLE / LIST                                                        */
/* ------------------------------------------------------------------ */

export type ViewPage = {
  objectKey: string;
  label: string;
  pluralLabel: string;
  /** Descriptors for the columns actually returned, in order. */
  fields: Array<Pick<ViewFieldDescriptor, "name" | "label" | "kind" | "enumValues">>;
  rows: Record<string, unknown>[];
  total: number;
  page: number;
  pageSize: number;
  /** True when the caller is seeing only their own records. Shown in the UI. */
  scopedToOwnRecords: boolean;
};

export async function runView(input: unknown): Promise<ActionResult<ViewPage>> {
  try {
    const ctx = await requirePermission(VIEW_PERMISSIONS.read);
    const params = runViewSchema.parse(input);

    const resolved = await resolveRequest(ctx, params);
    if ("error" in resolved) return viewFail(resolved.error);

    const { object, scope } = resolved;

    const fields = resolveColumns(object, resolved.columns);
    const selectList = compileSelectList(fields);
    const order = compileOrderBy(object, resolved.sorts);
    const where = compileWhere(scope, object, resolved.filter, { now: new Date() });

    const table = sql.identifier(object.table);
    const whereSql = tokensToSql(where.tokens);
    const offset = (params.page - 1) * params.pageSize;

    const result = await withTenant(resolved.tenantId, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT ${sql.raw(selectList)}
          FROM ${table}
         WHERE ${whereSql}
         ORDER BY ${sql.raw(order.text)}
         LIMIT ${params.pageSize} OFFSET ${offset}
      `);

      // ⚠️ A SECOND STATEMENT RATHER THAN `count(*) OVER ()`. The window
      // function looks free and is not: it forces the executor to
      // materialise the whole result set before applying LIMIT, so a view
      // over 400,000 rows pays for all of them to return 50. Two queries
      // against the same index is the cheaper shape by a wide margin.
      const counted = await tx.execute(sql`
        SELECT count(*)::int AS total FROM ${table} WHERE ${whereSql}
      `);

      return { rows: allRows(rows), total: Number(allRows(counted)[0]?.total ?? 0) };
    });

    return {
      ok: true,
      data: {
        objectKey: object.key,
        label: object.label,
        pluralLabel: object.pluralLabel,
        fields: fields.map((field) => ({
          name: field.name,
          label: field.label,
          kind: field.kind,
          enumValues: field.enumValues,
        })),
        rows: result.rows,
        total: result.total,
        page: params.page,
        pageSize: params.pageSize,
        // ⚠️ SURFACED, NOT HIDDEN. A rep who sees 12 leads where their
        // manager sees 400 must be told why, or they will report the
        // difference as missing data — and the honest answer ("you are
        // seeing your own records") is also the one that tells them who
        // to ask.
        scopedToOwnRecords: scope.restrictToOwnerUserId !== null,
      },
    };
  } catch (err) {
    return toViewActionError(err, "runView");
  }
}

/* ------------------------------------------------------------------ */
/* KANBAN                                                              */
/* ------------------------------------------------------------------ */

export type BoardColumn = {
  /** The raw group value. Null is a real column: "no owner", "no stage". */
  value: string | null;
  label: string;
  total: number;
  cards: Record<string, unknown>[];
  truncated: boolean;
};

export type BoardResult = {
  objectKey: string;
  label: string;
  pluralLabel: string;
  groupField: { name: string; label: string; kind: string };
  fields: Array<Pick<ViewFieldDescriptor, "name" | "label" | "kind" | "enumValues">>;
  columns: BoardColumn[];
  /** True when columns were dropped because there were too many. */
  columnsTruncated: boolean;
  scopedToOwnRecords: boolean;
};

/**
 * The generic Kanban, generalising `components/sales/pipeline-board.tsx`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THIS IS ONE QUERY AND NOT ONE QUERY PER COLUMN
 * ══════════════════════════════════════════════════════════════════════
 * The hardcoded lead board could issue eight queries, because it had
 * eight columns and it knew them at compile time. A board over ANY field
 * does not: group by `owner_id` in a workspace with 300 users and the
 * per-column approach is 300 round trips, discovered at a customer's site
 * rather than in a test.
 *
 * So the board is one window-function query: rank rows within their group,
 * keep the first `KANBAN_COLUMN_CARD_LIMIT` of each, and count the rest.
 * The columns fall out of the data.
 *
 * ⚠️ AND THE COLUMN LIST IS CAPPED AND THE CAP IS ANNOUNCED. A board with
 * 300 columns is not a board. `MAX_KANBAN_COLUMNS` busiest groups are
 * drawn and `columnsTruncated` says the rest exist — because a truncation
 * the reader cannot see is a truncation that becomes a decision. That is
 * the same rule the lead board applies to cards within a column.
 */
export async function runBoard(input: unknown): Promise<ActionResult<BoardResult>> {
  try {
    const ctx = await requirePermission(VIEW_PERMISSIONS.read);
    const params = runBoardSchema.parse(input);

    const resolved = await resolveRequest(ctx, params);
    if ("error" in resolved) return viewFail(resolved.error);

    const { object, scope } = resolved;

    if (!resolved.groupBy) {
      return viewFail("A board needs a field to make its columns from.");
    }

    // ⭐ Resolved and refused if it is not groupable — a board over a free
    // text column asks PostgreSQL for 400,000 distinct values.
    const groupField = resolveGroupBy(object, resolved.groupBy);
    const groupColumn = compileGroupByColumn(groupField);

    const fields = resolveColumns(object, resolved.columns);
    const selectList = compileSelectList(fields);
    const order = compileOrderBy(object, resolved.sorts);
    const where = compileWhere(scope, object, resolved.filter, { now: new Date() });

    const table = sql.identifier(object.table);
    const whereSql = tokensToSql(where.tokens);

    const result = await withTenant(resolved.tenantId, async (tx) => {
      const cards = await tx.execute(sql`
        WITH ranked AS (
          SELECT ${sql.raw(selectList)},
                 ${sql.raw(groupColumn)}::text AS __group,
                 row_number() OVER (
                   PARTITION BY ${sql.raw(groupColumn)}
                   ORDER BY ${sql.raw(order.text)}
                 ) AS __rank
            FROM ${table}
           WHERE ${whereSql}
        )
        SELECT * FROM ranked
         WHERE __rank <= ${KANBAN_COLUMN_CARD_LIMIT}
         ORDER BY __group NULLS LAST, __rank
      `);

      const totals = await tx.execute(sql`
        SELECT ${sql.raw(groupColumn)}::text AS __group, count(*)::int AS total
          FROM ${table}
         WHERE ${whereSql}
         GROUP BY ${sql.raw(groupColumn)}
         ORDER BY count(*) DESC
      `);

      return { cards: allRows(cards), totals: allRows(totals) };
    });

    /* --- Assemble the columns --------------------------------------- */
    //
    // ⚠️ FOR AN ENUM, EVERY VALUE IS A COLUMN, EVEN AN EMPTY ONE. A
    // pipeline board that hides "Negotiation" because nothing is in it
    // makes the stage look as though it does not exist, and a rep cannot
    // drag a card into a column that is not drawn. For anything else,
    // only the values that occur — there is no list to enumerate.
    const totalsByValue = new Map<string | null, number>();
    for (const row of result.totals) {
      totalsByValue.set((row.__group as string | null) ?? null, Number(row.total ?? 0));
    }

    const cardsByValue = new Map<string | null, Record<string, unknown>[]>();
    for (const row of result.cards) {
      const key = (row.__group as string | null) ?? null;
      const list = cardsByValue.get(key) ?? [];
      const { __group, __rank, ...card } = row;
      void __group;
      void __rank;
      list.push(card);
      cardsByValue.set(key, list);
    }

    const orderedValues: (string | null)[] =
      groupField.enumValues && groupField.enumValues.length > 0
        ? [...groupField.enumValues, ...(totalsByValue.has(null) ? [null] : [])]
        : [...totalsByValue.keys()];

    const columnsTruncated = orderedValues.length > MAX_KANBAN_COLUMNS;
    const visibleValues = orderedValues.slice(0, MAX_KANBAN_COLUMNS);

    const columns: BoardColumn[] = visibleValues.map((value) => {
      const total = totalsByValue.get(value) ?? 0;
      const cards = cardsByValue.get(value) ?? [];
      return {
        value,
        label: value ?? `No ${groupField.label.toLowerCase()}`,
        total,
        cards,
        truncated: total > cards.length,
      };
    });

    return {
      ok: true,
      data: {
        objectKey: object.key,
        label: object.label,
        pluralLabel: object.pluralLabel,
        groupField: {
          name: groupField.name,
          label: groupField.label,
          kind: groupField.kind,
        },
        fields: fields.map((field) => ({
          name: field.name,
          label: field.label,
          kind: field.kind,
          enumValues: field.enumValues,
        })),
        columns,
        columnsTruncated,
        scopedToOwnRecords: scope.restrictToOwnerUserId !== null,
      },
    };
  } catch (err) {
    if (err instanceof ViewPlanError) return viewFail(err.message);
    return toViewActionError(err, "runBoard");
  }
}

/* ------------------------------------------------------------------ */
/* PLUMBING                                                            */
/* ------------------------------------------------------------------ */

/**
 * Drizzle's `execute` returns `{ rows }` on some drivers and an array on
 * others. Normalised in one place rather than at four call sites, which
 * is how three of them end up handling only the shape the developer had
 * locally.
 */
function allRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: Record<string, unknown>[] }).rows;
  }
  return [];
}
