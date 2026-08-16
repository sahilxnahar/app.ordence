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
  | "enum"
  /**
   * ⭐ BATCH 58. A physical quantity, held as INTEGER THOUSANDTHS for
   * exactly the reason money is held as integer paise: `0.1 + 0.2` is
   * not `0.3` in binary floating point, and a stock ledger that is out
   * by a millionth of a kilogram on every movement stops reconciling
   * after a few thousand of them. `stock_movements.quantity` is
   * `numeric(18,3)`, so three decimal places is the storage precision as
   * well as the arithmetic one.
   */
  | "quantity";

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
export type ImportTableKey =
  | "companies"
  | "gst_parties"
  /**
   * ⭐⭐ BATCH 58 — THE OPENING-BALANCE DESTINATIONS.
   *
   * ⚠️ `transactions` IS THE LEDGER ITSELF, AND IT IS THE ONLY ENTRY IN
   * THIS UNION THAT IS WRITTEN AS ONE DOCUMENT FOR THE WHOLE FILE. An
   * opening trial balance is a single balanced journal entry — see
   * `atomic` and `batchKey` below. The other three write one row each,
   * exactly like `companies` does.
   */
  | "transactions"
  | "sales_invoices"
  | "vendor_ledger_entries"
  | "stock_movements";

/* ------------------------------------------------------------------ */
/* LOOKUPS — THINGS A ROW REFERS TO BUT DOES NOT CREATE                */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ BATCH 58 — A ROW CAN REFER TO SOMETHING THAT MUST ALREADY EXIST
 * ══════════════════════════════════════════════════════════════════════
 * The two Batch 57 entities were self-contained: everything a `companies`
 * row needed was in the row. An opening trial balance line is not — it
 * names an ACCOUNT CODE, and that account either exists in the
 * workspace's chart of accounts or the line means nothing. Same for an
 * opening customer invoice (a company), an opening vendor bill (a vendor
 * code) and opening stock (an SKU and a warehouse).
 *
 * 🔴 AND THE RESOLUTION MUST HAPPEN IN THE PREVIEW, NOT AT THE WRITE.
 * The obvious implementation resolves the code inside the insert and
 * lets a miss become a foreign-key violation — which means the dry run
 * reports "412 will be created" and the real run creates 380. That is
 * exactly the drift constraint 1 forbids, and it is the failure mode
 * that makes a customer stop reading the preview.
 *
 * So a lookup is DECLARED by the entity, resolved once for the whole
 * file by `server/actions/import.ts`, and an unresolved lookup turns the
 * row into an ordinary reported error — in BOTH runs, from one call site.
 *
 * ⚠️ THE KIND IS A STRING DISCRIMINANT, for exactly the reason `table`
 * is one: putting a Drizzle table here would drag the database into the
 * client bundle and undo the purity that makes the wizard able to build
 * a blank template.
 */
export type ImportLookupKind =
  /** `ledgers.code`, active and not deleted. */
  | "ledger_by_code"
  /** `companies.name`, case- and whitespace-insensitive, not deleted. */
  | "company_by_name"
  /** `vendors.code` — "V-0042". Unique per workspace. */
  | "vendor_by_code"
  /** `stock_items.sku`, active. */
  | "stock_item_by_sku"
  /** `warehouses.code`, active. */
  | "warehouse_by_code";

export type ImportLookup = {
  kind: ImportLookupKind;
  /** Already canonicalised — lower-cased where the match is insensitive. */
  value: string;
  /**
   * The payload field the resolved uuid is written into before the write
   * runs. `writeRow` reads the id from here and never re-resolves it,
   * so the thing that was previewed is the thing that is written.
   */
  into: string;
  /** What the failed-rows CSV says when nothing matched. Written for a human. */
  missing: string;
};

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

  /* ---------------------------------------------------------------- */
  /* ⭐⭐ BATCH 58 ADDITIONS. Every one is OPTIONAL and every one has a  */
  /*    default that reproduces Batch 57 behaviour exactly, so the two  */
  /*    original entities did not change by one character.             */
  /* ---------------------------------------------------------------- */

  /**
   * Things this row REFERS to that must already exist. See `ImportLookup`.
   * Runs on the PARSED payload, post-Zod, and is pure — it only says what
   * to look up, never how.
   */
  lookups?: (parsed: Record<string, unknown>) => readonly ImportLookup[];

  /**
   * ══════════════════════════════════════════════════════════════════
   * 🔴 ALL-OR-NOTHING, AND IT IS A DELIBERATE INVERSION OF CONSTRAINT 2
   * ══════════════════════════════════════════════════════════════════
   * `lib/import/report.ts` argues at length that partial success is the
   * design and not the failure mode, and it is right for a list of
   * companies: 900 of 1000 rows is what the customer wants.
   *
   * 🔴 IT IS THE OPPOSITE FOR AN OPENING TRIAL BALANCE. That file is ONE
   * journal entry. Importing 38 of its 40 lines does not give the
   * customer 95% of their opening position — it gives them a ledger that
   * does not balance, which the database's own deferred constraint
   * trigger would refuse anyway, and which every report built on it
   * would be wrong about forever.
   *
   * ⚠️ AND THE REFUSAL IS EXPRESSED AS ROW ERRORS, NOT AS A `fatal`. A
   * fatal empties `rows`, which would take the failed-rows CSV away with
   * it — and the failed-rows download is the entire mechanism by which
   * the customer finds the two lines that were wrong. So every otherwise
   * valid row is marked with a whole-row error saying the file was
   * refused as a whole, the counts read "40 errors", nothing is written,
   * and the CSV they download has all forty rows in it with the two real
   * reasons on the two real offenders.
   */
  atomic?: boolean;

  /**
   * A rule over the WHOLE FILE, run after every row has been planned.
   * Returns a sentence to refuse the file with, or `null`.
   *
   * 🔴 THIS IS WHERE "AN OPENING TRIAL BALANCE THAT DOES NOT BALANCE IS
   * REFUSED" LIVES. It is not expressible per row: no single line of an
   * unbalanced trial balance is wrong, and marking one would be a lie
   * about which one. The message names the difference in rupees and
   * which side is short, because "does not balance" without the number
   * is a message that cannot be acted on.
   *
   * ⚠️ IT RUNS ONLY WHEN EVERY ROW READ CLEANLY. Arithmetic over a file
   * with an unreadable amount in it is arithmetic over a number nobody
   * has, and reporting "you are ₹4,000 out" when the truth is "row 12 is
   * unreadable" sends the customer to look for a ₹4,000 error that does
   * not exist.
   */
  fileRule?: (rows: readonly ImportRowPlan[]) => string | null;

  /**
   * ══════════════════════════════════════════════════════════════════
   * 🔴 THE IDEMPOTENCY KEY FOR A FILE THAT BECOMES ONE DOCUMENT
   * ══════════════════════════════════════════════════════════════════
   * `naturalKey` identifies a ROW. That is the right question for a
   * company and the wrong one for an opening trial balance, where the
   * thing that must not happen twice is not "this account line" but
   * "this opening entry". Entering the opening position twice must not
   * double the books, and the account codes are the same both times.
   *
   * ⭐ SO THE KEY IS `OPENING:TB:<as-at date>`, WRITTEN INTO
   * `transactions.transaction_number`, WHICH THE DATABASE ALREADY HOLDS
   * UNIQUE PER TENANT (`transactions_tenant_number_unique`). Our check is
   * a courtesy that produces a readable outcome; the index is what makes
   * two people pressing the button at once safe. Same reasoning as
   * `salesTransactionKey` in `server/accounting/post-sales.ts`, and
   * deliberately the same SHAPE so a human reading a trial balance can
   * tell at a glance where a transaction came from.
   *
   * ⚠️ THE DATE IS IN THE KEY. Two different opening dates are two
   * different opening positions — a workspace that goes live on 1 April
   * and then imports a corrected position as at 30 June has two entries
   * and should. What the key stops is the SAME position posted twice.
   */
  batchKey?: (rows: readonly ImportRowPlan[]) => ImportNaturalKey | null;

  /**
   * Which duplicate modes this entity accepts. Defaults to all three.
   *
   * 🔴 AN OPENING JOURNAL ENTRY HAS NO `update`. `journal_entries` is
   * append-only by design — the schema says so in a comment where
   * `updatedAt` and `deletedAt` would have been. A posted entry is
   * corrected by REVERSING it and posting a new one, which is an
   * accounting act with its own audit trail, not by an importer quietly
   * rewriting the numbers under a transaction somebody has already
   * reconciled against. Offering "overwrite" here would be offering an
   * operation the ledger cannot perform.
   */
  duplicateModes?: readonly DuplicateMode[];

  /**
   * One sentence naming the matching rule, in the customer's words, for
   * the screen that asks about duplicates.
   *
   * ⚠️ IT LIVES ON THE ENTITY BECAUSE THE ALTERNATIVE IS A TERNARY IN A
   * COMPONENT. `components/settings/import-wizard.tsx` has exactly that
   * — `entityKey === "companies" ? "…domain…" : "…GSTIN…"` — so every
   * entity added after the second one is described to the customer as a
   * GST party. That is a wrong sentence about their data shown at the
   * moment they choose what happens to it.
   */
  duplicateRule?: string;
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
  /**
   * ⭐ BATCH 58 — what this row refers to. Computed by the pure layer,
   * resolved against the database by `server/actions/import.ts` once for
   * the whole file, for both runs, from one call site.
   */
  lookups?: readonly ImportLookup[];
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
