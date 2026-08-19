/**
 * Ordence — Saved-View Limits
 * Version: v0.25.0-alpha
 *
 * Pure constants. No imports, no I/O — the planner, the zod schemas, the
 * server guards, the SQL check constraints and the builder UI all read
 * the same numbers.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHY A FILTER TREE NEEDS A BUDGET AT ALL
 * ══════════════════════════════════════════════════════════════════════
 * A filter is not a value; it is a small program, and it is evaluated by
 * PostgreSQL against every candidate row. Two things follow, and both of
 * them are denial-of-service rather than injection:
 *
 *   1. NESTING COSTS THE PLANNER, NOT THE ROW. A tree 400 groups deep
 *      compiles to 400 nested parenthesised expressions. The compiler
 *      here recurses over it, the query planner recurses over it again,
 *      and the second one is holding a connection from a pool shared with
 *      every other workspace on the instance. It is also the shape a
 *      recursive descent parser blows its stack on, which turns a saved
 *      view into a 500 for everybody.
 *
 *   2. WIDTH COSTS EVERY ROW. Sixty `ILIKE '%…%'` conditions over an
 *      unindexed text column is sixty substring searches per row, on a
 *      table with four hundred thousand of them. Nothing in the query is
 *      wrong. It simply never finishes, and it does so while holding a
 *      connection.
 *
 * ⚠️ Neither of these needs an attacker. The tree that gets you is the one
 * a customer built in the UI by clicking "add condition" until the view
 * did what they wanted, and it will be replayed on every page load
 * forever after.
 *
 * ⚠️ EVERY LIMIT IS ENFORCED IN AT LEAST TWO PLACES. `lib/views/validation.ts`
 * refuses at save time with a message naming the offending node;
 * `lib/views/planner.ts` refuses again at compile time, because a view
 * saved before a limit was tightened is still in the table; and
 * `SQL-FILES/0020_phase25_views.sql` caps the stored jsonb by BYTES, which
 * is the backstop that holds against an INSERT that never went through
 * either.
 */

/* ------------------------------------------------------------------ */
/* THE FILTER TREE                                                     */
/* ------------------------------------------------------------------ */

/**
 * How deeply groups may nest. The root group is depth 1.
 *
 * Five is generous for a filter a person can still read. "(A or B) and
 * (C or (D and E))" is depth 3 and is already at the edge of what anybody
 * reviews correctly.
 */
export const MAX_FILTER_DEPTH = 5;

/**
 * Total nodes — groups AND conditions — in one filter tree.
 *
 * Counted together on purpose. A cap on conditions alone is defeated by
 * ten thousand empty groups, which cost the planner just as much and
 * return everything.
 */
export const MAX_FILTER_NODES = 60;

/** Values in one `in` list. Each one is a bound parameter and a comparison. */
export const MAX_IN_VALUES = 50;

/**
 * Bytes of stored filter JSON, enforced by a CHECK constraint.
 *
 * ⚠️ THE ONLY LIMIT IN THIS FILE THAT SURVIVES A HAND-WRITTEN INSERT.
 * Depth and node count are application rules; a support engineer fixing a
 * row in psql, a restore from an older schema, or a future API route each
 * bypass them. Size does not distinguish who is asking.
 */
export const MAX_FILTER_BYTES = 8_192;

/* ------------------------------------------------------------------ */
/* SORTS, COLUMNS                                                      */
/* ------------------------------------------------------------------ */

/**
 * Sort keys in one view.
 *
 * ⚠️ Four is not an arbitrary politeness. A multi-column ORDER BY that no
 * index covers is a full sort of the result set in work_mem, spilling to
 * disk when it does not fit — and the fifth key never changes the answer
 * anyway, because the first four have already made every row distinct.
 */
export const MAX_SORTS = 4;

/** Columns a table view may show. Beyond this the browser is the bottleneck. */
export const MAX_VISIBLE_COLUMNS = 40;

/* ------------------------------------------------------------------ */
/* PAGE SIZES                                                          */
/* ------------------------------------------------------------------ */

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

/**
 * Cards loaded per Kanban column, and columns drawn.
 *
 * ⚠️ A Kanban over an arbitrary field is not a Kanban over an eight-stage
 * pipeline. Group by `owner_id` in a workspace with 300 users and the
 * naive implementation issues 300 queries and draws a board nobody can
 * scroll. The board loads the busiest `MAX_KANBAN_COLUMNS` and SAYS SO —
 * a truncation the reader cannot see is a truncation that becomes a
 * decision.
 */
export const KANBAN_COLUMN_CARD_LIMIT = 50;
export const MAX_KANBAN_COLUMNS = 20;

/* ------------------------------------------------------------------ */
/* HOW MANY VIEWS MAY EXIST                                            */
/* ------------------------------------------------------------------ */

/**
 * Saved views per workspace, enforced by the server AND by a trigger.
 *
 * The failure this stops is not storage — a view is a few hundred bytes.
 * It is the view PICKER: a script (or an enthusiastic integration) that
 * creates a view per import run fills the dropdown on every list page in
 * the product with thousands of entries, and the workspace's own admins
 * cannot find the three they use. Recovering from that means deleting
 * rows one workspace at a time.
 */
export const MAX_SAVED_VIEWS_PER_TENANT = 500;

/** Views one person may keep on one object. Keeps the picker human. */
export const MAX_VIEWS_PER_OBJECT_PER_USER = 30;

/** Characters in a view name. Long enough to be descriptive, short enough to render. */
export const MAX_VIEW_NAME_LENGTH = 80;
