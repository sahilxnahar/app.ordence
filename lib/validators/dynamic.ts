/**
 * Ordence — Runtime Object Validation Schemas
 * Version: v0.24.0-alpha
 *
 * WHY THIS FILE EXISTS: a `"use server"` module may only export async
 * functions, so schemas live outside the action boundary. Same reason as
 * `lib/validators/crm.ts` and `lib/validators/workflows.ts`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ ZOD IS THE SHAPE CHECK. IT IS NOT THE INJECTION DEFENCE.
 * ══════════════════════════════════════════════════════════════════════
 * Worth stating loudly here more than anywhere else in the codebase,
 * because this is the one phase where a string from a form ends up
 * INTERPOLATED INTO DDL rather than bound as a parameter.
 *
 * The regexes below look like they are doing the security work. They are
 * not. They are a fast, friendly first opinion, and they exist so a
 * person gets "use lowercase letters" in a form field rather than a
 * Postgres error. The actual defence is:
 *
 *   • `assertIdentifier()` in `lib/dynamic/identifiers.ts` — which knows
 *     about reserved words, system columns, byte length and homoglyphs,
 *     none of which a `.regex()` here would catch, and which is called
 *     again by the server whatever this file decided;
 *   • `dynamic_assert_identifier()` in the database, which is called by
 *     the DDL functions themselves and therefore applies to callers that
 *     never touch this file at all.
 *
 * ⚠️ IF YOU ARE ADDING A FIELD THAT REACHES AN IDENTIFIER POSITION,
 * ADDING IT HERE IS NOT ENOUGH. Treating a green parse as authorisation
 * is how a schema library becomes the reason an incident happened.
 */

import { z } from "zod";
import { uuidSchema } from "./crm";
import { DYNAMIC_FIELD_TYPES, RELATION_CORE_TABLES } from "@/lib/dynamic/field-types";
import {
  MAX_FIELDS_PER_OBJECT,
  MAX_PAGE_SIZE,
  MAX_SELECT_OPTIONS,
  DEFAULT_PAGE_SIZE,
} from "@/lib/dynamic/limits";
import {
  MAX_FIELD_API_NAME_LENGTH,
  MAX_OBJECT_API_NAME_LENGTH,
} from "@/lib/dynamic/identifiers";

/* ------------------------------------------------------------------ */
/* PRIMITIVES                                                          */
/* ------------------------------------------------------------------ */

const IDENTIFIER_MESSAGE =
  "Use lowercase letters, digits and underscores only, starting with a letter.";

/**
 * ⚠️ NO `.trim()` AND NO `.toLowerCase()`. See `assertIdentifier` — a
 * pipeline that repairs a name before checking it has checked a different
 * string from the one the customer typed, and Unicode case folding is
 * locale-dependent, so the repair can differ between two servers.
 */
export const objectApiNameSchema = z
  .string()
  .min(1, "A name is required.")
  .max(MAX_OBJECT_API_NAME_LENGTH)
  .regex(/^[a-z][a-z0-9_]*$/, IDENTIFIER_MESSAGE);

export const fieldApiNameSchema = z
  .string()
  .min(1, "A name is required.")
  .max(MAX_FIELD_API_NAME_LENGTH)
  .regex(/^[a-z][a-z0-9_]*$/, IDENTIFIER_MESSAGE);

export const selectChoiceSchema = z.object({
  value: z
    .string()
    .trim()
    .min(1)
    .max(59)
    // The value is written into a CHECK constraint as a LITERAL (`%L`).
    // Kept conservative so it stays readable in a constraint violation.
    .regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/, "Choice values stay simple: letters, digits, spaces, dots, hyphens, underscores."),
  label: z.string().trim().min(1).max(80),
  color: z.string().trim().max(20).optional(),
});

/**
 * ⚠️ A DISCRIMINATED UNION, NOT TWO OPTIONAL FIELDS.
 *
 * `{ objectId?, coreTable? }` allows both, allows neither, and pushes the
 * "exactly one" rule into runtime code that a second call site will
 * forget. The database says the same thing a third time
 * (`dynamic_fields_relation_target`), because a relation with two targets
 * has no defined foreign key and one with none has no column type.
 */
export const relationTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("object"), objectId: uuidSchema }),
  z.object({
    kind: z.literal("core"),
    // ⭐ AN ALLOWLIST, ENFORCED AGAIN IN THE DATABASE. Not "any table with
    // a tenant_id": a foreign key into `audit_logs` would let a customer
    // pin an audit row in place and block retention.
    table: z.enum(RELATION_CORE_TABLES as unknown as [string, ...string[]]),
  }),
]);

export const fieldDefinitionSchema = z.object({
  apiName: fieldApiNameSchema,
  label: z.string().trim().min(1, "A label is required.").max(150),
  fieldType: z.enum(DYNAMIC_FIELD_TYPES as unknown as [string, ...string[]]),
  helpText: z.string().trim().max(500).optional(),
  placeholder: z.string().trim().max(200).optional(),
  isRequired: z.boolean().default(false),
  isUnique: z.boolean().default(false),
  isIndexed: z.boolean().default(false),
  isHidden: z.boolean().default(false),
  showInGrid: z.boolean().default(true),
  options: z.array(selectChoiceSchema).max(MAX_SELECT_OPTIONS).default([]),
  relation: relationTargetSchema.nullish(),
  sortOrder: z.number().int().min(0).max(9999).default(0),
});

export type FieldDefinitionInput = z.infer<typeof fieldDefinitionSchema>;

/* ------------------------------------------------------------------ */
/* OBJECTS                                                             */
/* ------------------------------------------------------------------ */

export const createDynamicObjectSchema = z.object({
  apiName: objectApiNameSchema,
  label: z.string().trim().min(1, "A name is required.").max(120),
  pluralLabel: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(1000).optional(),
  icon: z.string().trim().max(60).default("box"),
  color: z.string().trim().max(20).default("#B08D3C"),
  /**
   * ⚠️ AT LEAST ONE FIELD IS REQUIRED.
   *
   * An object with no fields is a table with six system columns and
   * nothing in it. Every record looks identical, the grid renders empty
   * rows, and the first thing the customer does is delete it — which is
   * a `DROP TABLE` they now have to be talked through.
   */
  fields: z.array(fieldDefinitionSchema).min(1, "Add at least one field.").max(MAX_FIELDS_PER_OBJECT),
  displayFieldApiName: fieldApiNameSchema.optional(),
});

export type CreateDynamicObjectInput = z.infer<typeof createDynamicObjectSchema>;

/**
 * ⚠️ `apiName` IS ABSENT AND THAT IS THE POINT OF THE WHOLE PHASE.
 *
 * A rename changes what people see. The api name is in URLs, in saved
 * integrations and inside the physical table name; changing it would mean
 * either an `ALTER TABLE … RENAME` — an ACCESS EXCLUSIVE lock on a table
 * that may hold millions of rows, because somebody fixed a typo — or a
 * metadata row pointing at a table whose name no longer matches it.
 */
export const renameDynamicObjectSchema = z.object({
  objectId: uuidSchema,
  label: z.string().trim().min(1).max(120),
  pluralLabel: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(1000).nullish(),
  icon: z.string().trim().max(60).optional(),
  color: z.string().trim().max(20).optional(),
  displayFieldApiName: fieldApiNameSchema.nullish(),
});

export const archiveDynamicObjectSchema = z.object({
  objectId: uuidSchema,
});

/**
 * ⭐ THE DESTRUCTIVE ONE. Read the notes on both fields.
 */
export const dropDynamicObjectSchema = z.object({
  objectId: uuidSchema,

  /**
   * ⭐ THE NUMBER OF LIVE RECORDS THE CALLER BELIEVES THEY ARE DESTROYING.
   *
   * ⚠️ NOT A BOOLEAN. `confirm: true` is typed once, by a developer, at
   * the call site — and from then on every call is confirmed. A count has
   * to come from somewhere: a screen a person read. If it has changed
   * since they read it, the drop aborts and they look again. It is
   * optimistic concurrency applied to a decision instead of a row.
   *
   * The database checks it too (`dynamic_drop_object_table`), because
   * this schema only protects callers that come through this schema.
   */
  confirmRecordCount: z.number().int().min(0),

  /**
   * The api name, typed back. The GitHub "type the repository name"
   * pattern, and it is here for the same reason: it is the only
   * confirmation step that cannot be completed by muscle memory.
   */
  confirmApiName: objectApiNameSchema,
});

export type DropDynamicObjectInput = z.infer<typeof dropDynamicObjectSchema>;

/* ------------------------------------------------------------------ */
/* FIELDS                                                              */
/* ------------------------------------------------------------------ */

export const addDynamicFieldSchema = z.object({
  objectId: uuidSchema,
  field: fieldDefinitionSchema,
});

/**
 * What may be changed about an existing field.
 *
 * ⚠️ `apiName` AND `fieldType` ARE BOTH ABSENT, DELIBERATELY.
 *
 * Changing the name is `ALTER TABLE … RENAME COLUMN`, which breaks every
 * saved view, export and integration referring to it — silently, because
 * they would simply stop finding the field.
 *
 * Changing the type is worse. `ALTER TABLE … ALTER COLUMN … TYPE` rewrites
 * the whole table under an ACCESS EXCLUSIVE lock and either fails halfway
 * (text that is not a number) or SUCCEEDS DESTRUCTIVELY: `numeric` → `text`
 * is lossless, `text` → `numeric` is not, and `currency` → `number` silently
 * reinterprets paise as rupees. The honest operation is "add a new field,
 * migrate, remove the old one", which the customer can do today with two
 * calls that are each reversible until the last one.
 */
export const updateDynamicFieldSchema = z.object({
  fieldId: uuidSchema,
  label: z.string().trim().min(1).max(150).optional(),
  helpText: z.string().trim().max(500).nullish(),
  placeholder: z.string().trim().max(200).nullish(),
  isHidden: z.boolean().optional(),
  showInGrid: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});

/**
 * ⭐ Removing a field DROPS THE COLUMN, in the same transaction.
 *
 * There is no "hidden but still stored" state: a column the product has
 * stopped showing but is still writing is personal data nobody knows they
 * hold, which is a data-protection problem rather than a tidiness one.
 * `isHidden` is what "stop showing it" means.
 */
export const removeDynamicFieldSchema = z.object({
  fieldId: uuidSchema,
  /** The field's api name, typed back. Same argument as the drop above. */
  confirmApiName: fieldApiNameSchema,
});

/* ------------------------------------------------------------------ */
/* RECORDS                                                             */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ `values` IS `z.record(z.unknown())` AND THAT IS NOT LAZINESS.
 *
 * The shape of a record is not known at compile time — it is whatever the
 * tenant defined five minutes ago. Zod cannot express it. The real check
 * is `validateRecordValues()` in `lib/dynamic/values.ts`, which reads the
 * field list out of the database and coerces value by value, and behind
 * that the column types themselves.
 *
 * The one thing enforced here is a KEY COUNT, because a record with ten
 * thousand keys is a denial-of-service against the validator rather than
 * against the database.
 */
const recordValuesSchema = z
  .record(z.unknown())
  .refine((v) => Object.keys(v).length <= MAX_FIELDS_PER_OBJECT + 10, {
    message: "Too many values for one record.",
  });

export const createDynamicRecordSchema = z.object({
  objectId: uuidSchema,
  values: recordValuesSchema,
});

export const updateDynamicRecordSchema = z.object({
  objectId: uuidSchema,
  recordId: uuidSchema,
  values: recordValuesSchema,
});

export const deleteDynamicRecordSchema = z.object({
  objectId: uuidSchema,
  recordId: uuidSchema,
});

export const getDynamicRecordSchema = z.object({
  objectId: uuidSchema,
  recordId: uuidSchema,
});

/**
 * ⚠️ `sortBy` IS A FIELD API NAME AND THEREFORE AN IDENTIFIER POSITION.
 *
 * It is the least obvious injection surface in the phase: it looks like a
 * filter parameter and it becomes an `ORDER BY` clause, which cannot be
 * parameterised any more than a table name can. The regex here is the
 * first opinion; `server/dynamic/records.ts` resolves it against the
 * object's ACTUAL field list and refuses anything that is not on it,
 * which is a stronger guarantee than any pattern — a name that survives
 * that check provably came from our own metadata.
 */
export const listDynamicRecordsSchema = z.object({
  objectId: uuidSchema,
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  search: z.string().trim().max(200).optional(),
  sortBy: fieldApiNameSchema.optional(),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
  includeDeleted: z.boolean().default(false),
});

export type ListDynamicRecordsInput = z.infer<typeof listDynamicRecordsSchema>;
export type CreateDynamicRecordInput = z.infer<typeof createDynamicRecordSchema>;
export type UpdateDynamicRecordInput = z.infer<typeof updateDynamicRecordSchema>;
