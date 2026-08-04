/**
 * Ordence — Runtime Object Limits
 * Version: v0.24.0-alpha
 *
 * Pure constants. No imports, no I/O — the validator, the DDL planner, the
 * database functions in `SQL-FILES/0019_phase24_dynamic_objects.sql` and the
 * UI all read the same numbers.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY A RUNTIME-DDL ENGINE NEEDS CAPS THAT THE JSONB ENGINE DID NOT
 * ══════════════════════════════════════════════════════════════════════
 * Phase 2 stored custom records as rows in `custom_object_records`. A
 * tenant who defined four hundred objects cost us four hundred ROWS in a
 * metadata table and nothing else. This phase issues real `CREATE TABLE`,
 * so the same tenant costs four hundred TABLES — and tables are not free
 * in the way rows are:
 *
 *   • Every table is a `pg_class` row, N `pg_attribute` rows and a set of
 *     relation files. `pg_dump`, `pg_restore`, `\dt`, autovacuum's table
 *     list and the query planner's catalogue cache all grow with it.
 *   • Catalogue bloat is SHARED. It is the one cost in this product a
 *     single tenant can impose on every other tenant on the instance.
 *   • `drizzle-kit push` diffs the whole schema. A catalogue with tens of
 *     thousands of runtime tables makes every deployment slower for
 *     everybody.
 *
 * ⚠️ These are not anti-abuse numbers. They are the line between one
 * customer's enthusiasm and everybody's migration window. A customer who
 * genuinely needs more gets it raised deliberately, by a human who has
 * looked at the catalogue — not by an accident of the API.
 *
 * ⚠️ EVERY LIMIT IS ENFORCED TWICE. `server/dynamic/objects.ts` refuses
 * politely, with a sentence naming the cap; the SQL functions refuse
 * absolutely, because an import script or a future API route would
 * otherwise walk straight past the polite one.
 */

/**
 * How many live objects one workspace may define.
 *
 * Fifty is generous for a CRM — the whole standard schema is about forty
 * tables — and small enough that a runaway script is stopped after fifty
 * `CREATE TABLE`s rather than fifty thousand.
 */
export const MAX_OBJECTS_PER_TENANT = 50;

/**
 * How many fields one object may have.
 *
 * PostgreSQL's own ceiling is 1600 columns, and it is the wrong number to
 * aim at: a table near it is unusable in every grid the product renders,
 * and `ALTER TABLE ... ADD COLUMN` on it takes an ACCESS EXCLUSIVE lock
 * for measurably longer. 100 leaves room for the six system columns and
 * still fits a screen after a person has thought about it.
 */
export const MAX_FIELDS_PER_OBJECT = 100;

/** Choices on a `select` / `multi_select`. Beyond this it wants a relation. */
export const MAX_SELECT_OPTIONS = 200;

/**
 * How many elements one `multi_select` value may hold.
 *
 * Unbounded, a single row could hold a megabyte of tags — and it is the
 * `<@` containment CHECK that would have to evaluate all of them on every
 * write.
 */
export const MAX_MULTI_SELECT_VALUES = 50;

/** Longest value a `text`, `email`, `phone` or `url` field will accept. */
export const MAX_TEXT_LENGTH = 500;

/** Longest value a `long_text` field will accept. */
export const MAX_LONG_TEXT_LENGTH = 20_000;

/**
 * ⭐ THE MONEY CEILING, IN MINOR UNITS (paise).
 *
 * 10^17 paise is about ₹1,000,000,000,000,000 — absurd, and deliberately
 * so. It exists to keep a value inside `bigint` after any arithmetic the
 * product does with it (a sum over a page of rows, a percentage), because
 * a bigint that overflows in Postgres raises rather than wraps, mid-write,
 * halfway through somebody's booking.
 */
export const MAX_CURRENCY_MINOR_UNITS = 100_000_000_000_000_000n;

/** How many rows one generic list query may return. */
export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 50;

/**
 * How many indexes a tenant may ask for on one object.
 *
 * Every index is written on every INSERT and UPDATE to that table. A
 * tenant who ticks "indexed" on all hundred fields has built a table that
 * is slower to write than to scan, and they will report it as our bug.
 */
export const MAX_INDEXED_FIELDS_PER_OBJECT = 12;
