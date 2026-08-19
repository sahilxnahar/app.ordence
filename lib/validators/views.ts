/**
 * Ordence — Saved-View Validation Schemas
 * Version: v0.25.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS SEPARATELY FROM THE SERVER ACTIONS
 * ══════════════════════════════════════════════════════════════════════
 * A file marked `"use server"` may ONLY export async functions. Every
 * other export in such a file is compiled into a callable RPC endpoint
 * reachable by anyone on the internet — six Zod schemas were found doing
 * exactly that in Phase 7. Schemas are pure values; the action and the
 * form import the same ones, which is also the only way to stop a form
 * accepting input the action will reject.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT ZOD CAN AND CANNOT DO FOR THIS PHASE
 * ══════════════════════════════════════════════════════════════════════
 * It checks SHAPE. It cannot check MEANING, and the meaning is the whole
 * risk here:
 *
 *   `{ field: "tenant_id", operator: "eq", value: "…" }`
 *
 * is a perfectly well-formed condition. Every string is a string, the
 * operator is in the enum, the value is present. Zod passes it, and it
 * must — deciding whether `tenant_id` is a field of `leads` needs the
 * registry, and the registry needs to know which object the view is over,
 * which is a different property of a different part of the payload.
 *
 * So the schemas below stop the tree being ABSURD (bounded depth, bounded
 * size, string fields that are strings) and `lib/views/validation.ts`
 * decides whether it is MEANINGFUL. Both run on every write. Treating
 * either as sufficient is the mistake.
 *
 * ⚠️ `field` IS A BOUNDED STRING HERE AND NOT A REGEX-CHECKED IDENTIFIER,
 * ON PURPOSE. A regex like `^[a-z_][a-z0-9_]*$` looks like a defence and
 * teaches the next reader that a name which matches it is safe to use —
 * which is exactly the belief this phase exists to prevent. The name is
 * resolved against a real field table or it is refused. Nothing about its
 * spelling makes it acceptable.
 */

import { z } from "zod";
import {
  MAX_FILTER_DEPTH,
  MAX_FILTER_NODES,
  MAX_IN_VALUES,
  MAX_PAGE_SIZE,
  MAX_SORTS,
  MAX_VIEW_NAME_LENGTH,
  MAX_VISIBLE_COLUMNS,
} from "@/lib/views/limits";
import { FILTER_OPERATORS, VIEW_TYPES } from "@/lib/views/types";
import type { FilterGroup, FilterNode } from "@/lib/views/types";

const uuid = z.string().uuid("Not a valid identifier.");

/**
 * A field name as it is STORED.
 *
 * Bounded because PostgreSQL identifiers are 63 bytes and anything longer
 * cannot possibly resolve; not otherwise constrained, for the reason in
 * the header.
 */
const fieldName = z.string().trim().min(1).max(63);

/* ------------------------------------------------------------------ */
/* THE FILTER TREE                                                     */
/* ------------------------------------------------------------------ */

/**
 * Operand values.
 *
 * ⚠️ `z.unknown()` WOULD BE WRONG HERE AND IT IS WORTH SAYING WHY. It
 * accepts a nested object, and a nested object is how somebody eventually
 * discovers that `JSON.stringify` of an operand ends up somewhere it
 * should not. Operands are scalars: a string, a number, a boolean, or
 * null. Anything with a shape is refused before it reaches coercion.
 */
const operandValue = z.union([
  z.string().max(500),
  z.number(),
  z.boolean(),
  z.null(),
]);

const filterConditionSchema = z.object({
  type: z.literal("condition"),
  field: fieldName,
  operator: z.enum(FILTER_OPERATORS),
  value: operandValue.optional(),
  values: z.array(operandValue).max(MAX_IN_VALUES).optional(),
});

/**
 * The recursive group.
 *
 * ⚠️ THE DEPTH CAP IS ENFORCED BY BUILDING A BOUNDED CHAIN OF SCHEMAS
 * RATHER THAN BY `z.lazy` PLUS A `superRefine` THAT COUNTS AFTERWARDS.
 *
 * The difference matters and it is not stylistic. `z.lazy` parses the
 * WHOLE tree before any refinement can look at it, so a 200,000-level
 * payload has already been walked — and zod's own parse is recursive, so
 * on a deep enough input the process dies with a stack overflow inside
 * the validator that was supposed to reject it. Bounding the schema
 * itself means depth `MAX_FILTER_DEPTH + 1` fails to MATCH, at the point
 * it is reached, with no recursion past the cap.
 */
function groupSchemaAtDepth(remaining: number): z.ZodType<FilterGroup> {
  const child: z.ZodType<FilterNode> =
    remaining <= 1
      ? (filterConditionSchema as unknown as z.ZodType<FilterNode>)
      : (z.union([
          filterConditionSchema,
          groupSchemaAtDepth(remaining - 1),
        ]) as unknown as z.ZodType<FilterNode>);

  return z.object({
    type: z.literal("group"),
    match: z.enum(["all", "any"], {
      // ⚠️ No default. See `FilterGroup` in `lib/views/types.ts`.
      required_error: "Say whether records must match all of these or any of them.",
    }),
    children: z.array(child).max(MAX_FILTER_NODES),
  }) as unknown as z.ZodType<FilterGroup>;
}

export const filterGroupSchema = groupSchemaAtDepth(MAX_FILTER_DEPTH);

/* ------------------------------------------------------------------ */
/* SORTS AND COLUMNS                                                   */
/* ------------------------------------------------------------------ */

export const sortSpecSchema = z.object({
  field: fieldName,
  direction: z.enum(["asc", "desc"]),
  nulls: z.enum(["first", "last"]).optional(),
});

export const columnSpecSchema = z.object({
  field: fieldName,
  /** Advisory, for the renderer. Never reaches SQL. */
  width: z.number().int().min(40).max(1200).optional(),
});

/* ------------------------------------------------------------------ */
/* THE DEFINITION                                                      */
/* ------------------------------------------------------------------ */

const definitionShape = {
  viewType: z.enum(VIEW_TYPES).default("table"),
  filter: filterGroupSchema.default({ type: "group", match: "all", children: [] }),
  sorts: z.array(sortSpecSchema).max(MAX_SORTS).default([]),
  groupBy: fieldName.nullable().optional(),
  dateField: fieldName.nullable().optional(),
  columns: z.array(columnSpecSchema).max(MAX_VISIBLE_COLUMNS).default([]),
};

/**
 * Which record type a view is over.
 *
 * ⚠️ EXACTLY ONE OF THE TWO, MIRRORING THE DATABASE CHECK CONSTRAINT.
 * A payload naming both would be ambiguous, and the resolution order a
 * reader assumes ("the specific one wins") is the opposite of the one a
 * different reader assumes.
 */
const objectSelector = z
  .object({
    objectKey: z.string().trim().min(1).max(60),
    dynamicObjectId: uuid.nullable().optional(),
  })
  .refine(
    (input) =>
      (input.objectKey === "dynamic_object") === Boolean(input.dynamicObjectId),
    {
      message:
        "A view over a custom record type must name it, and a view over a built-in " +
        "type must not.",
      path: ["dynamicObjectId"],
    },
  );

export const createViewSchema = objectSelector.and(
  z.object({
    name: z
      .string()
      .trim()
      .min(1, "Give the view a name.")
      .max(MAX_VIEW_NAME_LENGTH),
    description: z.string().trim().max(500).optional().nullable(),
    isShared: z.boolean().default(false),
    ...definitionShape,
  }),
);

export const updateViewSchema = z.object({
  id: uuid,
  name: z.string().trim().min(1).max(MAX_VIEW_NAME_LENGTH).optional(),
  description: z.string().trim().max(500).optional().nullable(),
  isShared: z.boolean().optional(),
  viewType: z.enum(VIEW_TYPES).optional(),
  filter: filterGroupSchema.optional(),
  sorts: z.array(sortSpecSchema).max(MAX_SORTS).optional(),
  groupBy: fieldName.nullable().optional(),
  dateField: fieldName.nullable().optional(),
  columns: z.array(columnSpecSchema).max(MAX_VISIBLE_COLUMNS).optional(),
});

export const deleteViewSchema = z.object({ id: uuid });

export const listViewsSchema = z.object({
  objectKey: z.string().trim().min(1).max(60).optional(),
  dynamicObjectId: uuid.nullable().optional(),
});

export const setDefaultViewSchema = z.object({
  objectKey: z.string().trim().min(1).max(60),
  dynamicObjectId: uuid.nullable().optional(),
  /** Null clears the personal default and falls back to the workspace one. */
  viewId: uuid.nullable(),
});

export const setWorkspaceDefaultSchema = z.object({
  id: uuid,
  isWorkspaceDefault: z.boolean(),
});

/* ------------------------------------------------------------------ */
/* RUNNING A VIEW                                                      */
/* ------------------------------------------------------------------ */

/**
 * Run a SAVED view, optionally with the reader's own extra filter.
 *
 * ⚠️ `overrideFilter` IS A NARROWING, NOT A REPLACEMENT, AND THE SERVER
 * ENFORCES THAT BY **ANDING** IT — see `server/views/query.ts`. It is the
 * search box on top of a saved view. Letting it replace the saved filter
 * would mean a reader could turn "my leads this week" into "everything",
 * which is fine (the scope still holds) but confusing; ANDing it is what
 * a person expects a search box to do.
 */
export const runViewSchema = z.object({
  viewId: uuid.optional(),
  /** For an unsaved, ad-hoc view — the list page before anybody saves one. */
  objectKey: z.string().trim().min(1).max(60).optional(),
  dynamicObjectId: uuid.nullable().optional(),
  ...definitionShape,
  viewType: z.enum(VIEW_TYPES).optional(),
  filter: filterGroupSchema.optional(),
  sorts: z.array(sortSpecSchema).max(MAX_SORTS).optional(),
  columns: z.array(columnSpecSchema).max(MAX_VISIBLE_COLUMNS).optional(),
  overrideFilter: filterGroupSchema.optional(),
  page: z.number().int().min(1).max(10_000).default(1),
  pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
});

export const runBoardSchema = z.object({
  viewId: uuid.optional(),
  objectKey: z.string().trim().min(1).max(60).optional(),
  dynamicObjectId: uuid.nullable().optional(),
  groupBy: fieldName.optional(),
  filter: filterGroupSchema.optional(),
  sorts: z.array(sortSpecSchema).max(MAX_SORTS).optional(),
  columns: z.array(columnSpecSchema).max(MAX_VISIBLE_COLUMNS).optional(),
});

/* ------------------------------------------------------------------ */
/* INFERRED TYPES                                                      */
/* ------------------------------------------------------------------ */

export type CreateViewInput = z.infer<typeof createViewSchema>;
export type UpdateViewInput = z.infer<typeof updateViewSchema>;
export type RunViewInput = z.infer<typeof runViewSchema>;
export type RunBoardInput = z.infer<typeof runBoardSchema>;
