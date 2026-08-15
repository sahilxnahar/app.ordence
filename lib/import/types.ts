/**
 * Ordence — Import Framework Types
 * Version: v1.57.0-alpha (Batch 57)
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THIS IS A FRAMEWORK, NOT AN IMPORTER, AND THE DIFFERENCE IS THE
 *    POINT OF THE WHOLE BATCH
 * ══════════════════════════════════════════════════════════════════════
 * The version of this work that gets written under pressure is
 * `importCompanies(csv)`. It ships in a day, and the second entity is a
 * copy of the first with the field names changed — at which point the
 * parser is duplicated, the error messages have drifted, the dry run of
 * one has a bug the other does not, and the third entity is a rewrite.
 *
 * So an entity contributes a DESCRIPTION of itself — its columns, how to
 * assemble a payload, WHICH EXISTING VALIDATOR judges it, and what its
 * natural key is — and contributes no code that runs. Everything that
 * runs (parse, map, coerce, validate, deduplicate, report) is written
 * once and is identical for every entity. Adding an entity is adding a
 * value to a table, and it inherits the dry run, the partial-success
 * report and the re-run safety for free because it cannot opt out of them.
 *
 * ⚠️ NO DATABASE IMPORT ANYWHERE IN `lib/import/`. The entity definition
 * names a table with a string discriminant and `server/actions/import.ts`
 * switches on it. That is what keeps the whole decision layer testable
 * without Postgres, and it is what lets the client wizard import the
 * column list to build a blank template.
 */

import type { z } from "zod";
import type { PermissionKey } from "@/db/schema/auth";
import type { FeatureKey } from "@/lib/entitlements/features";

/* ------------------------------------------------------------------ */
/* COLUMNS                                                             */
/* ------------------------------------------------------------------ */

export type ImportColumnKind =
  | "text"
  | "integer"
  | "money"
  | "boolean"
  | "date"
  | "enum";

export type ImportColumn = {
  /** Key in the payload handed to the entity's Zod schema. */
  field: string;
  /** Canonical header, and what the downloadable blank template says. */
  header: string;
  kind: ImportColumnKind;
  /**
   * ⚠️ REQUIRED HERE MEANS "THE FILE MUST HAVE THIS COLUMN", which is not
   * the same as "the value must be present". Whether a value may be blank
   * is the Zod schema's business — restating it here would be the second
   * copy of a rule, and the two copies would disagree the first time the
   * schema changed. This flag only decides whether a header's ABSENCE
   * stops the run before any row is read.
   */
  required: boolean;
  /**
   * Header spellings seen in the wild. Matched after normalisation, so
   * `Company Name`, `company_name` and `COMPANYNAME` already collapse to
   * one form — these are genuinely different WORDS (`org`, `firm`, `gst
   * number`), not different casings.
   */
  aliases?: readonly string[];
  /** For `kind: "enum"`. The canonical values, which are also the message. */
  enumValues?: readonly string[];
  maxLength?: number;
  bounds?: { min?: number; max?: number };
  /** One line in the wizard's column table. Written for a non-technical reader. */
  help: string;
};

/* ------------------------------------------------------------------ */
/* NATURAL KEYS — CONSTRAINT 3                                         */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 RE-RUNNING AN IMPORT MUST NOT DOUBLE THE DATA
 * ══════════════════════════════════════════════════════════════════════
 * Re-running is not an edge case, it is the NORMAL second action. The
 * first run reports 100 failures, the customer fixes those 100 rows, and
 * the file they re-upload is very often the WHOLE file again rather than
 * just the fixed rows — because that is the file on their desktop. If the
 * importer keys on nothing, that second upload creates 900 duplicate
 * companies, and a CRM with every customer in it twice is worse than an
 * empty one: it cannot be cleaned up without deciding, per pair, which
 * copy has the notes on it.
 *
 * So every entity MUST declare a natural key — a value that identifies
 * the same real-world thing across two files — and the framework matches
 * on it. There is no opt-out; `naturalKey` is a required member of the
 * entity definition.
 *
 * ⚠️ `kind` IS PART OF THE KEY, NOT DECORATION. An entity can key on more
 * than one thing (a company keys on its domain when it has one and on its
 * name when it does not), and `"name:acme"` must never match
 * `"domain:acme"`. Comparing bare values would let a company named
 * `ordence.com` collide with a company whose domain is `ordence.com`.
 */
export type ImportNaturalKey = {
  /** Which key this is — `"domain"`, `"name"`, `"gstin"`. */
  kind: string;
  /** Already lower-cased / canonicalised. Compared as an exact string. */
  value: string;
  /** How the report describes it: "domain ordence.com". */
  label: string;
};

/**
 * What to do when a row's natural key already exists in the workspace.
 *
 * ⚠️ CHOSEN BEFORE THE RUN, NEVER AFTER, AND THE ORDER IS THE WHOLE
 * SAFETY PROPERTY. Asked afterwards — "we found 340 matches, update
 * them?" — the question arrives when the customer has already waited for
 * the upload and is committed to finishing; the answer is always yes, and
 * `update` is the destructive one. Asked first, it is a decision about
 * their own data made while they still have the file in front of them.
 */
export type DuplicateMode =
  /** Leave the existing record untouched. The safe default to recommend. */
  | "skip"
  /** Overwrite the existing record with this row. A mass edit — see below. */
  | "update"
  /** Refuse the row so it lands in the failed-rows CSV for inspection. */
  | "fail";

/* ------------------------------------------------------------------ */
/* ENTITY DEFINITION                                                   */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ `table` IS A STRING DISCRIMINANT, NOT A DRIZZLE TABLE OBJECT.
 *
 * Putting the table here would drag `@/db/schema` — and through it the
 * database client — into every module that imports the entity list,
 * including the client wizard. `server/actions/import.ts` switches on
 * this string against a hard-coded allowlist, which is also the same
 * reasoning `server/actions/bulk.ts` gives for its `BULK_ENTITIES` table:
 * a dynamic resolver is one migration away from letting a crafted entity
 * string reach `users` or the vault.
 */
export type ImportTableKey = "companies" | "gst_parties";

export type ImportEntityDefinition = {
  key: string;
  label: string;
  /** Singular, lower case, for sentences: "3 companies will be created". */
  noun: { one: string; many: string };
  description: string;
  table: ImportTableKey;

  /** Gate 2 — has the workspace paid for this module? */
  feature: FeatureKey;
  /** Gate 3 — may this PERSON create one of these? */
  createPermission: PermissionKey;
  /**
   * ⚠️ SEPARATE FROM `createPermission`, AND CHECKED ONLY IN `update`
   * MODE. Choosing "overwrite" converts an import into a mass edit of
   * records that already exist, which is a different act from adding new
   * ones — a junior user loading a list of new prospects should not be
   * able to rewrite the customer master by ticking a radio button.
   */
  updatePermission: PermissionKey;

  columns: readonly ImportColumn[];

  /**
   * Turn coerced cell values into the object the entity's EXISTING
   * validator expects. This is where a flat CSV becomes a nested payload
   * (address columns folding into one `address` object, say).
   */
  buildPayload: (
    values: Readonly<Record<string, string | number | boolean | null>>,
  ) => Record<string, unknown>;

  /**
   * 🔴 THE SAME SCHEMA THE SINGLE-RECORD SERVER ACTION PARSES. NOT A
   * COPY, NOT AN "IMPORT VARIANT", NOT A LOOSER ONE.
   *
   * An import that validates differently from the form is an import that
   * writes rows the form would have refused — and every rule in this
   * product that matters is in a schema: that a `regular` GST party must
   * carry a GSTIN, that a state code must agree with the GSTIN's first
   * two digits. A bulk path that skips those is how ten thousand
   * unusable rows arrive at once. `server/actions/gst.ts` already names
   * "an import of historical bookings" as one of the four write paths
   * that must not bypass the rules; this is that import, and it goes
   * through the front door.
   */
  schema: z.ZodTypeAny;

  /** See `ImportNaturalKey`. Runs on the PARSED payload, post-Zod. */
  naturalKey: (parsed: Record<string, unknown>) => ImportNaturalKey | null;

  /** A short human label for a row in the report — the company's name. */
  rowLabel: (parsed: Record<string, unknown>) => string;
};

/* ------------------------------------------------------------------ */
/* PLAN — the output of the pure layer                                 */
/* ------------------------------------------------------------------ */

export type ImportRowError = {
  /** Canonical header the problem belongs to, or null for a whole-row problem. */
  column: string | null;
  message: string;
};

export type ImportRowPlan = {
  recordNumber: number;
  /** The row exactly as it arrived, so the failed-rows CSV can hand it back. */
  cells: readonly string[];
  errors: readonly ImportRowError[];
  /** Present only when `errors` is empty. */
  payload?: Record<string, unknown>;
  naturalKey?: ImportNaturalKey | null;
  label?: string;
};

export type HeaderAssignment = {
  field: string;
  header: string;
  required: boolean;
  /** The header text in the customer's file, or null if it is absent. */
  matchedHeader: string | null;
  /** Index into each record's cells. -1 when unmatched. */
  index: number;
};

export type ImportPlan = {
  entityKey: string;
  /** Header row exactly as it appeared, for the failed-rows CSV. */
  headers: readonly string[];
  assignments: readonly HeaderAssignment[];
  /** Headers in the file that no column claimed. Reported, never fatal. */
  unrecognisedHeaders: readonly string[];
  rows: readonly ImportRowPlan[];
  /**
   * A problem with the FILE rather than with a row — unbalanced quotes, a
   * missing required column, too many rows. When set, `rows` is empty and
   * nothing may be written.
   */
  fatal: string | null;
};

/* ------------------------------------------------------------------ */
/* REPORT — what crosses back to the browser                           */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ ONE VOCABULARY FOR BOTH RUNS, AND THE TENSE LIVES IN `mode`.
 *
 * The alternative is two enums — `will_create`/`created` — and two
 * renderers, which is the first crack through which a dry run and a real
 * run drift apart (constraint 1). One set of dispositions, computed by
 * one function, rendered by one component that reads `mode` to choose
 * between "will create" and "created".
 */
export type RowDisposition = "create" | "update" | "skip" | "error";

export type ImportReportRow = {
  recordNumber: number;
  disposition: RowDisposition;
  label: string;
  /** "domain ordence.com" — what the match was made on, when there was one. */
  matchedOn: string | null;
  errors: readonly ImportRowError[];
};

export type ImportReport = {
  mode: "preview" | "commit";
  entityKey: string;
  entityLabel: string;
  noun: { one: string; many: string };
  duplicateMode: DuplicateMode;

  totalRows: number;
  counts: Record<RowDisposition, number>;

  headers: readonly string[];
  assignments: readonly HeaderAssignment[];
  unrecognisedHeaders: readonly string[];

  /**
   * ⚠️ EVERY FAILED ROW, PLUS A SAMPLE OF THE REST.
   *
   * The failures are the part the customer has to act on and they are
   * never truncated — an import that says "100 errors" and shows twelve
   * of them is an import nobody can finish. The successes are sampled
   * because a thousand rows of "will create ✓" is a payload, not
   * information; the counts above already say how many there are.
   */
  rows: readonly ImportReportRow[];
  successSampleShown: number;

  /**
   * The failed rows as a CSV, ready to download, with their original
   * values and one extra column saying what was wrong. See
   * `buildFailedRowsCsv`.
   */
  failedRowsCsv: string | null;

  fatal: string | null;
};
