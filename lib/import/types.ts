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
/* ⭐⭐ TRACK M1 — THE MIGRATION CONTRACT                                */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS SECTION EXISTS AT ALL
 * ══════════════════════════════════════════════════════════════════════
 * Everything above this line describes ONE FILE being loaded into ONE
 * table. That was the right unit for Batch 57 and it is the wrong unit
 * for a migration, which is twenty files loaded in an order, by somebody
 * who has never used this product, out of a system we have never seen,
 * on a day when their old software is being switched off.
 *
 * Four things a migration needs that a single upload does not:
 *
 *   ORDER        Customers before their invoices. Nothing above states
 *                this, so a client who uploads in the wrong order gets
 *                foreign-key misses that read to them as data errors in
 *                a file that is in fact perfect.
 *
 *   REVERSAL     A migration is an experiment. The first attempt is
 *                usually wrong and the customer usually wants it gone.
 *                Track M2 builds the ledger that undoes a run; this is
 *                the part each entity must contribute to it, declared at
 *                DEFINITION time because at undo time the entity that
 *                wrote the row may no longer be the one being asked.
 *
 *   PROVENANCE   "Which file, which line, which run put this row here."
 *                Migration support is mostly answering that question,
 *                and today nothing in the product can. Verified:
 *                `grep -rn "importRunId\|import_run_id" db/schema/`
 *                returns nothing at all.
 *
 *   REQUIREDNESS `ImportColumn.required` already means "the FILE must
 *                have this column" and says so at length. It does not
 *                mean "the ROW is meaningless without a value", which is
 *                a different question with a different answer: a contact
 *                with no email is fine, an invoice with no customer is
 *                not. The Zod schema settles per-field validity; what it
 *                cannot express is which absences make the row not a
 *                thing.
 *
 * ⚠️ EVERY MEMBER ADDED BY THIS SECTION IS REQUIRED, AND THAT IS THE
 *    POINT. This codebase's characteristic defect — found more than
 *    thirty times — is built and unreachable, declared and unenforced,
 *    or verified by a floor. An optional `reversal?:` would be that
 *    defect in its purest form: the six tracks writing entities behind
 *    this one would each omit it, the undo would silently do nothing for
 *    the entities that skipped it, and the run report would still say
 *    "reversed". Required, checked by `checkImportContract()`, and that
 *    checker is CI gate 29.
 */

/* ---------------- ORDER ---------------- */

/**
 * What must already be in the workspace before rows of this entity can
 * be written.
 *
 * ⚠️ THIS IS NOT `lookups`, AND CONFUSING THE TWO IS THE EASY MISTAKE.
 * `lookups` is a per-ROW question — "this row names account 4000, find
 * it" — resolved against whatever is in the database at the time. This
 * is a per-ENTITY statement about the SHAPE of a migration: contacts
 * name companies, so companies are loaded first. A row can have no
 * lookups and the entity still depend on another (an entity whose
 * dependency shows up only in an optional column), and an entity can
 * have lookups into something it does not depend on (a currency table
 * that ships with the product and is never imported).
 *
 * ⚠️ DEPENDENCIES ARE ON ENTITY KEYS, NOT TABLES. Two entities can write
 * the same table — an opening trial balance and a general journal import
 * both write `transactions` — and they do not have the same
 * predecessors.
 *
 * 🔴 THE ARRAY IS `readonly string[]` AND NOT `AnyImportEntityKey[]` ON
 *    PURPOSE, AND IT IS NOT LAZINESS. `types.ts` cannot import
 *    `entities.ts`: `entities.ts` imports this file, and the cycle would
 *    be a real one at module-evaluation time, not merely a type-level
 *    one. So the key is a string here and `checkImportContract()`
 *    verifies every string names a real entity. A dangling dependency is
 *    a refusal at CI, not a type error — which is strictly weaker, and
 *    saying so is better than pretending otherwise.
 */
export type ImportDependency = {
  /** The entity key that must be loaded first. */
  entity: string;
  /**
   * Whether the migration can proceed without it.
   *
   * `hard`  — rows will fail without it. Contacts without companies get
   *           an unresolved lookup on every row that names one.
   * `soft`  — rows will succeed but will be less complete. Loading them
   *           out of order costs the customer a re-run, not their data.
   *
   * ⚠️ THE DISTINCTION EARNS ITS KEEP IN THE PLANNER, NOT HERE. A
   * migration that refuses to start until every soft dependency is
   * satisfied is a migration nobody can start, because most customers do
   * not have all twenty files on day one.
   */
  strength: "hard" | "soft";
  /**
   * Why, in the customer's words, for the screen that shows the order.
   * "Contacts are linked to companies by name, so companies go first."
   */
  because: string;
};

/* ---------------- REVERSAL ---------------- */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 HOW A ROW THIS ENTITY WROTE IS UNDONE
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ "DELETE THE ROWS THIS RUN CREATED" IS THE ANSWER FOR SOME ENTITIES
 *    AND A DATA-DESTROYING BUG FOR OTHERS, AND THE DIFFERENCE IS NOT
 *    VISIBLE FROM THE WRITE SITE.
 *
 * Three cases, and they behave differently enough that one generic undo
 * cannot serve all three:
 *
 * ① The row did not exist before the run. Deleting it restores the
 *    prior state exactly. This is `delete`.
 *
 * ② The row existed and the run OVERWROTE it (`duplicateMode: "update"`).
 *    Deleting it destroys a record the customer had before the migration
 *    and did not ask to lose. Undo means putting the old values back,
 *    which means the old values were captured at write time — because
 *    they are gone by undo time. This is `restore-prior`, and the
 *    capture is not optional: an entity that permits `update` and
 *    declares `delete` is declaring that its undo deletes customer data.
 *    `checkImportContract()` refuses that combination by name.
 *
 * ③ The row is in an append-only ledger. It cannot be deleted or
 *    rewritten; `journal_entries` says so in a comment where `updatedAt`
 *    and `deletedAt` would have been. Undo is a REVERSING entry, which
 *    is an accounting act with its own audit trail and its own date.
 *    This is `reverse-entry`.
 *
 * ⚠️ AND ONE HONEST FOURTH. Some effects genuinely cannot be undone: an
 *    email that went out, a file pushed to a customer's portal. An
 *    entity whose write has such an effect declares `irreversible` and
 *    says what escapes, and the planner shows that sentence to the
 *    customer BEFORE the run rather than after. A migration tool that
 *    cannot be honest about this is one that says "reverted" while the
 *    customer's suppliers have already had the email.
 */
export type ImportReversalKind =
  | "delete"
  | "restore-prior"
  | "reverse-entry"
  | "irreversible";

export type ImportReversalPolicy = {
  kind: ImportReversalKind;
  /**
   * Fields whose PRIOR values must be captured before an `update`
   * overwrites them, so `restore-prior` has something to restore.
   *
   * 🔴 REQUIRED AND NON-EMPTY WHEN `kind` IS `restore-prior`. Checked.
   * An empty list here is the same failure as a missing one: an undo
   * that runs, reports success, and restores nothing — verified by a
   * floor, which is the shape this project keeps finding.
   *
   * ⚠️ NAMING `"*"` MEANS THE WHOLE ROW, and it is the right answer for
   * most entities. Listing individual fields is for the case where the
   * row carries something the import did not write and must not restore.
   */
  capturePriorFields?: readonly string[];
  /**
   * What escapes an undo, in one sentence, for the screen shown before
   * the run. `null` when nothing does.
   *
   * ⚠️ `null` IS A CLAIM, NOT A DEFAULT. It says the author looked. It
   * is a separate member from `kind` because `kind: "delete"` and "but a
   * webhook fired" are both true at once.
   */
  escapes: string | null;
  /** Why this kind and not another. One or two sentences. */
  because: string;
};

/* ---------------- PROVENANCE ---------------- */

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHICH FILE, WHICH LINE, WHICH RUN
 * ══════════════════════════════════════════════════════════════════════
 * The obvious implementation adds `import_run_id` and `import_row_no`
 * columns to every destination table. It is obvious and it is wrong
 * here, for a measured reason: there are 313 tables, the migration
 * tracks will target something like thirty of them, and each column pair
 * is a migration, an index, a schema change on a live table, and a
 * `NOT NULL`-less column that every non-import write leaves empty. The
 * signal-to-cost ratio is bad and it gets worse with every entity.
 *
 * ⭐ SO PROVENANCE IS A SIDECAR: one table, `import_row_provenance`,
 * holding (run, entity, row number, target table, target id). It is
 * written by the same transaction as the row it describes — see SQL
 * 0196 — so a row and its provenance cannot disagree.
 *
 * ⚠️ AND THE SIDECAR IS WHAT MAKES REVERSAL POSSIBLE AT ALL. `delete`
 * needs to know which ids this run created. Without provenance the only
 * available answer is "rows created between these two timestamps", which
 * catches every row the customer's staff typed in by hand during the
 * migration window. That is not a hypothetical: a migration takes hours
 * and the office does not stop.
 *
 * The entity's job here is small and it is not automatable: name the
 * destination table for a written row, and name the id. Both are needed
 * because an entity can write more than one table per row.
 */
export type ImportProvenancePolicy = {
  /**
   * Every table this entity may write a row into, as the string
   * discriminants used by `import_row_provenance.target_table`.
   *
   * 🔴 IT MUST INCLUDE `table`. Checked. An entity whose provenance
   * omits its own destination is an entity whose rows are unattributable
   * and therefore unreversible, while the contract looks complete.
   */
  /**
   * ⚠️ THE UNION INCLUDES `PendingImportTableKey` SO THAT A WORKED
   * EXAMPLE CAN DECLARE ITS PROVENANCE HONESTLY BEFORE THE WRITE PATH
   * SUPPORTS IT. That widening cannot make an entity reachable — reach
   * is decided by membership in `ALL_IMPORT_ENTITIES`, whose element
   * type pins `table` to `ImportTableKey`.
   */
  targets: readonly (ImportTableKey | PendingImportTableKey | ImportSecondaryTableKey)[];
  /**
   * ⚠️ WHETHER ONE INPUT ROW PRODUCES ONE OUTPUT ROW.
   *
   * `one-to-one` for a company. `many` for an invoice with lines, and
   * `whole-file` for an opening trial balance, which is one document
   * assembled from every row in the file.
   *
   * This is not decoration: it decides whether a provenance miss is a
   * bug. A `one-to-one` entity that wrote 900 rows and recorded 880
   * provenance rows has lost 20; a `whole-file` entity that wrote 1 row
   * for 40 input lines is correct. Track M8's reconciliation reads this.
   */
  cardinality: "one-to-one" | "many" | "whole-file";
};

/* ---------------- REQUIREDNESS ---------------- */

/**
 * ⚠️ SEPARATE FROM `ImportColumn.required` AND FROM THE ZOD SCHEMA, AND
 *    NOT A THIRD COPY OF EITHER.
 *
 *   `ImportColumn.required`  the FILE must have this HEADER.
 *   the Zod schema           this VALUE, if present, must be valid, and
 *                            may itself refuse a blank.
 *   this                     without this value the ROW IS NOT A THING.
 *
 * The third is not derivable from the second. `createContactSchema`
 * makes `companyId` optional and is right to: a contact with no company
 * is a real contact. `sales_invoices` would make a customer optional in
 * exactly the same shape — `.optional().nullable()` — because the form
 * fills it from context, and an invoice with no customer is not an
 * invoice.
 *
 * ⭐ WHAT IT IS FOR: the planner reports a row missing a structural
 * field as `error` with a sentence naming what is missing, BEFORE the
 * write, in the dry run, where the customer can still fix the file. The
 * alternative is a foreign-key violation at 3am on cutover night.
 *
 * ⚠️ AN EMPTY ARRAY IS A VALID AND COMMON ANSWER. It is required rather
 * than optional so that "nothing is structurally required here" is a
 * decision somebody made, not a member somebody forgot.
 */
export type ImportRequiredness = {
  /** Payload field names, post-Zod. Absent or null means the row fails. */
  structural: readonly string[];
  /** What the failed-rows CSV says. Keyed by field name. */
  messages: Readonly<Record<string, string>>;
};

/* ---------------- THE DUPLICATE DECISION ---------------- */

/**
 * `duplicateModes` above says which modes are OFFERED. This says which
 * one is RECOMMENDED and why.
 *
 * ⚠️ THE REASON IS THE REQUIRED PART. A default with no reason is a
 * default nobody can overrule with confidence, and the customer choosing
 * between "skip" and "update" for the first time is choosing about their
 * own live data with no information. `because` is shown next to the
 * radio button.
 */
export type ImportDuplicateDecision = {
  recommended: DuplicateMode;
  because: string;
};

/**
 * Everything Track M1 adds, gathered so it can be attached to an entity
 * defined in a file this track does not own.
 *
 * ⚠️ THIS IS NOT A SECOND REGISTRY AND MUST NOT BECOME ONE. It is never
 * consulted on the write path; `ALL_IMPORT_ENTITIES` remains the single
 * allowlist and `isImportEntityKey` remains membership in it. What this
 * type permits is DECORATING an entity that lives elsewhere, which is
 * how the four opening-balance entities get a contract without this
 * track editing a file it does not own.
 */
export type ImportContract = {
  dependsOn: readonly ImportDependency[];
  reversal: ImportReversalPolicy;
  provenance: ImportProvenancePolicy;
  requiredness: ImportRequiredness;
  duplicateDecision: ImportDuplicateDecision;
};

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
  | "stock_movements"
  /**
   * ⭐⭐ PHASE 8 , THE ACCOUNTING AND MASTER-DATA DESTINATIONS.
   *
   * 🔴 `ledgers` IS THE CHART OF ACCOUNTS, AND ADDING IT IS THE SINGLE MOST
   *    CONSEQUENTIAL LINE IN PHASE 8. Until now the chart of accounts was
   *    not importable, which is why `opening-trial-balance` declared
   *    `dependsOn: []` and argued its prerequisite was "a setup step rather
   *    than another import". That argument was correct and this line ends it.
   *
   * ⚠️ `hsn_sac_codes`, NOT `tax_codes`. The brief names `tax_codes`; there
   * is no such table and there never was , 0 of 312 `pgTable` declarations.
   * The code and the RATE are deliberately two tables, and only the CODE is
   * imported.
   */
  | "ledgers"
  | "cost_centres"
  | "hsn_sac_codes"
  /**
   * ⭐⭐ PHASE 4 , CRM. `contacts` finally arrives as a real destination.
   * It was M1's worked example and was deliberately held out of
   * `ALL_IMPORT_ENTITIES` because it had no writer; Phase 4 wrote one, so
   * `PendingImportTableKey` below is now empty of it.
   */
  | "contacts"
  | "leads"
  /** ⭐⭐ PHASE 7 , inventory. `stock_items` and `warehouses` are what make
   * `opening-stock`'s two lookups resolve at all. */
  | "stock_items"
  | "warehouses"
  | "stock_batches"
  /**
   * ⭐ PHASE 5 , CUSTOMER RECEIPTS. Money received and not yet applied to an
   * invoice. Written one row at a time and , unlike the single-record action
   * that writes the same table , posting NOTHING to the general ledger: an
   * imported receipt is sub-ledger detail beside an opening trial balance
   * that already carries the bank and the debtors.
   */
  | "customer_receipts"
  /**
   * ⭐ PHASE 6 , PURCHASES. `vendors` is its own table, not `gst_parties`,
   * so it does not collide with Phase 5's `customers`.
   */
  | "vendors"
  | "purchase_invoices";

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

/* ------------------------------------------------------------------ */
/* ⭐⭐⭐ WAVE 2C — WHERE A MONEY COLUMN'S EXPONENT COMES FROM          */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 TWO DECIMAL PLACES CANNOT REPRESENT A DINAR
 * ══════════════════════════════════════════════════════════════════════
 * Rule 6 of the import contract, `db/schema/accounting.ts`'s
 * `amount_minor` and `lib/fx/currency.ts` all say the same thing: the
 * number of decimal places money has is a fact about the CURRENCY, not a
 * constant. JPY has 0, the seven Gulf dinars have 3, CLF and UYW have 4.
 *
 * Until this wave `lib/import/plan.ts` called `coerceMoneyMinor(raw)`
 * with no exponent, so every money column in the product was coerced at
 * two places. `1.234` — an ordinary 1,234-fils amount in Kuwait — was
 * refused as malformed, and `1234` in a JPY column became `123400`.
 *
 * ⚠️ THE EXPONENT IS NOT A CONSTANT ON THE COLUMN EITHER. One file can
 * carry invoices in two currencies, so the exponent is a fact about the
 * ROW. What the ENTITY can say is where in the row to look.
 *
 * 🔴 AND IT IS NOT OPTIONAL WITH A DEFAULT OF 2. That is exactly the
 * present behaviour wearing a member: every entity written after this one
 * would omit it and silently get the defect back. Same argument the
 * header of this file makes about `reversal` — "there is no such thing as
 * an entity with no reversal policy; there are only entities whose policy
 * nobody wrote down." There is no such thing as a money column with no
 * currency.
 */
export type ImportMoneyContract =
  /**
   * 🔴 THIS ENTITY HAS NO MONEY COLUMN AT ALL, and saying so is an
   * ANSWER rather than an omission. Declaring `none` while carrying a
   * `kind: "money"` column is refused — by `planImportRecords` at the
   * top of every run, and by `checkImportContract()` (CI gate 29) over
   * the whole allowlist. So `none` cannot be used as a way of not
   * deciding.
   */
  | { readonly source: "none" }
  /**
   * The file carries no currency column, so every amount in it is in the
   * workspace's own functional currency.
   *
   * ⚠️ WHICH THE PURE LAYER DOES NOT KNOW. It lives in
   * `tenants.settings.currency` and is read by
   * `functionalCurrencyFromSettings()`; the caller supplies it in
   * `ImportContext`. See the boundary note on `ImportContext`.
   */
  | { readonly source: "workspace" }
  /**
   * A column in the file names the currency per row. `field` is the
   * PAYLOAD FIELD of that column (`ImportColumn.field`), not its header —
   * headers have aliases and the mapper resolves them.
   *
   * ⚠️ `whenBlank` IS REQUIRED FOR THE SAME REASON THE WHOLE MEMBER IS.
   * A currency column with an empty cell is common (an export that only
   * fills it for foreign invoices), and "assume the workspace currency"
   * and "refuse the row" are both defensible — so the entity says which,
   * rather than the framework guessing.
   */
  | {
      readonly source: "column";
      readonly field: string;
      readonly whenBlank: "workspace" | "refuse";
    };

/**
 * ⭐ WHAT THE CALLER KNOWS AND THE PURE LAYER CANNOT.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 RULE 4: `lib/import/` MUST NOT IMPORT THE DATABASE
 * ══════════════════════════════════════════════════════════════════════
 * That purity is what lets the browser build a blank template and what
 * makes the decision layer testable without Postgres, so the workspace's
 * functional currency — a row in `tenants` — arrives as DATA, in this
 * object, from the one caller that has a session.
 *
 * ⚠️ AND THE EXPONENT TABLE DOES NOT. It would have been easy to make
 * this object carry `exponents: ReadonlyMap<string, number>` too and
 * call that "taking the exponent as data". It would also have created a
 * THIRD copy of a fact that already exists twice —
 * `lib/fx/currency.ts` and the `currency_units` table — with no checker
 * over the third. The two that exist are compared by
 * `server/fx/rate-service.ts#verifyCurrencyUnits()`, which is the whole
 * reason that function exists.
 *
 * So `lib/import/plan.ts` resolves code → exponent through
 * `minorUnitExponent()` in `lib/fx/currency.ts`. That module is pure —
 * no `server-only`, no database, no clock, its own header says so — and
 * `npm run check:boundaries` (gate 8) is what fires if that ever stops
 * being true. What the caller supplies is the CURRENCY, which is tenant
 * state; not the arithmetic, which is a published ISO fact.
 */
export type ImportContext = {
  /**
   * ISO-4217 code the workspace keeps its books in, from
   * `functionalCurrencyFromSettings(tenant.settings).code`.
   *
   * ⚠️ NOT OPTIONAL AND NOT DEFAULTED TO "INR". `lib/fx/currency.ts`
   * already owns that decision and names it
   * (`DEFAULT_FUNCTIONAL_CURRENCY`); a second silent default here is how
   * the two drift.
   */
  readonly workspaceCurrency: string;
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
   * 🔴 WHERE THE EXPONENT OF THIS ENTITY'S MONEY COLUMNS COMES FROM.
   * REQUIRED, INCLUDING `{ source: "none" }` FOR AN ENTITY THAT HAS NO
   * MONEY COLUMN. See `ImportMoneyContract`.
   */
  money: ImportMoneyContract;

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

  /**
   * ══════════════════════════════════════════════════════════════════
   * ⭐⭐⭐ WAVE 3A , MANY DOCUMENTS PER FILE
   * ══════════════════════════════════════════════════════════════════
   * 🔴 THE FRAMEWORK HAD EXACTLY TWO SHAPES AND A JOURNAL IS NEITHER.
   *
   *   one document per FILE   `writeFile`  , the opening trial balance
   *   one document per ROW    `writeRow`   , everything else
   *
   * A general journal export is **many documents per file**: R lines
   * across V vouchers, each voucher one balanced transaction. Phase 8
   * measured what that costs today, by executing the planner:
   *
   *     ① two legs of ONE voucher, planned:
   *        row 2: errors=0
   *        row 3: errors=1  "This is the same account as row 2 , both have
   *                          voucher JV-0001. Only one row per account can
   *                          be imported in a single file."
   *
   *    **A two-line voucher loses its second line before it reaches the
   *    database.**
   *
   * ⚠️ AND THE CAUSE IS THAT TWO DIFFERENT QUESTIONS WERE SHARING ONE
   *    KEY. `naturalKey` answers "what must not be created twice", and
   *    for a journal that is the VOUCHER , so every leg of one voucher
   *    carries the same key and the second is refused as a duplicate of
   *    the first.
   *
   * ⭐ SO THE QUESTIONS ARE SEPARATED. `documentKey` is what must not
   * exist twice; `naturalKey` becomes what identifies this ROW WITHIN
   * that document. With both present:
   *
   *   · the in-file duplicate check keys on the PAIR, so two legs on
   *     two accounts are two rows and two legs on ONE account is still
   *     the mistake it always was;
   *   · `findExisting` keys on `documentKey` alone , "is this voucher
   *     already in the workspace";
   *   · the writer receives rows GROUPED, one group per document.
   *
   * ⚠️ ABSENT ON ALMOST EVERY ENTITY, AND THAT IS CORRECT. A company is
   * its own document. Only an entity whose file carries several
   * documents declares this, and `checkImportContract()` refuses one
   * that declares `documentKey` without a `naturalKey` , a document with
   * no way to tell its lines apart is a document that can only ever have
   * one line.
   *
   * 🔴 IT DOES NOT MAKE THE WRITER ATOMIC PER DOCUMENT ON ITS OWN. That
   *    is `writeFile`'s job for a whole file and is the write path's job
   *    per group; declaring this member says the rows GROUP, not that
   *    the grouping is transactional. Whoever builds the grouped writer
   *    owes that guarantee separately, and a half-written voucher is
   *    worse than a refused one.
   */
  documentKey?: (parsed: Record<string, unknown>) => ImportNaturalKey | null;

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

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 AN ENTITY THAT HAS BEEN THROUGH THE CONTRACT
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY A SECOND TYPE RATHER THAN A REQUIRED MEMBER ON THE FIRST.
 *
 * The first attempt at this made `contract` a required member of
 * `ImportEntityDefinition`. It was rejected for a reason worth writing
 * down, because the next author will try it again:
 *
 * Entity definitions live in more than one file, and Track M1 does not
 * own all of them. A required member would have made every file that
 * declares an entity fail to compile until its owner edited it — which
 * blocks six tracks for the sake of a mechanical addition, and which
 * pushes toward the one outcome that must not happen: somebody making it
 * `contract?:` to unblock themselves. An optional reversal policy is an
 * undo that silently does nothing for the entities that omitted it,
 * while the run report says "reversed".
 *
 * ⭐ SO THE REQUIREMENT SITS WHERE THE PRODUCT ALREADY PUTS ITS ONE
 * GUARD: at `ALL_IMPORT_ENTITIES`, the single allowlist on the write
 * path. An entity is reachable only by being in that map, that map is
 * typed `Record<string, ContractedImportEntity>`, and so an entity is
 * reachable only if it has a contract. The check is in exactly one
 * place, it is the same place `isImportEntityKey` guards, and it cannot
 * be softened without softening the allowlist itself.
 *
 * ⚠️ AND IT IS NOT MERELY A TYPE. `checkImportContract()` reads the same
 * map at CI gate 29 and refuses contracts that are present but
 * meaningless — a `restore-prior` that captures nothing, a provenance
 * that omits its own table. Types insist the object exists; the gate
 * insists it means something.
 */
export type ContractedImportEntity = ImportEntityDefinition & {
  contract: ImportContract;
};

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 A DESTINATION THE WRITE PATH CANNOT REACH YET
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THIS TYPE EXISTS BECAUSE OF A GUARD THAT FIRED, AND THE STORY IS
 *    WORTH THE TWENTY LINES.
 *
 * Track M1's second worked example is a `contacts` entity. Adding
 * `"contacts"` to `ImportTableKey` broke the build in exactly one place:
 * `REVALIDATE_AFTER` in `server/actions/import.ts`, a `Record` keyed on
 * this union whose own comment says it is a `Record` rather than a
 * ternary so that "TypeScript refuses to compile when a destination is
 * added without one". It did.
 *
 * ⭐ THAT REFUSAL WAS CORRECT AND IT SHOULD NOT BE PAPERED OVER. The
 * write path has no `contacts` branch. `writeRow` and
 * `findExistingByNaturalKey` dispatch on `entity.table` with `if`
 * chains, so an unhandled destination does not fail to compile — it
 * falls through. Registering the entity anyway would have produced the
 * exact defect this codebase has been found to have thirty times over: a
 * thing that is built, offered in a picker, and unreachable.
 *
 * ⚠️ SO THE WORKED EXAMPLE IS NOT IN `ALL_IMPORT_ENTITIES`. It is fully
 * typed, fully contracted, and exercised by the contract tests — it
 * proves the contract can express a dependent entity — and it is
 * deliberately not reachable from the server, because the three changes
 * that would make it reachable are in a file this track does not own and
 * are written out in `PATCH-REQUEST-M1.md`.
 *
 * 🔴 THIS TYPE IS A DEBT MARKER, NOT AN EXTENSION POINT. Every member of
 *    it is an entity that cannot be imported. Adding to it is a way of
 *    saying "not yet"; the goal is for it to be empty.
 */
/**
 * ⚠️ EMPTY AS OF PHASE 4, WHICH WAS ALWAYS THE GOAL.
 *
 * This union held `"contacts"` , M1's worked example, complete and
 * contracted and deliberately unreachable because the write path had no
 * branch for it. Phase 4 wrote the writer, so `contacts` moved up into
 * `ImportTableKey` and this became what its own header said it should be:
 * a debt marker with nothing in it.
 *
 * 🔴 `never` RATHER THAN DELETING THE TYPE. The next phase to build an
 *    entity ahead of its writer needs somewhere honest to say so, and a
 *    type that has to be re-invented is a type somebody will skip.
 */
export type PendingImportTableKey = never;

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ A TABLE A WRITER TOUCHES BUT NO ENTITY TARGETS
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 PHASE 3 FOUND WHY THIS TYPE HAS TO EXIST, BY MEASURING.
 *
 * `opening-trial-balance` declares destination `transactions`, and
 * `writeOpeningTrialBalance` inserts into `transactions` AND one
 * `journal_entries` row per account. Provenance decides what a reversal
 * can undo and what a reconciliation can tie, so `journal_entries` has to
 * be declared , and it must NOT be an `ImportTableKey`, because that
 * union is what `IMPORT_WRITERS` is exhaustive over. Adding it there
 * would demand a writer for a table no entity imports into directly.
 *
 * ⚠️ SO: DESTINATIONS AND PROVENANCE TARGETS ARE DIFFERENT SETS, and
 * conflating them is what hid this. A destination is where an entity's
 * rows go. A provenance target is any table the write touches.
 */
export type ImportSecondaryTableKey = "journal_entries";

/**
 * ⚠️ RETAINED WITH NO MEMBERS, for the reason `PendingImportTableKey` is
 * `never` rather than deleted: the next phase that builds an entity ahead
 * of its writer needs an honest way to say so.
 */
export type PendingImportEntity = Omit<ContractedImportEntity, "table"> & {
  table: PendingImportTableKey;
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
  /**
   * ⭐ WAVE 3A. Which document this row belongs to, when the entity has
   * more than one per file. `null` for every entity that does not.
   */
  documentKey?: ImportNaturalKey | null;
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

  /**
   * ⭐ WAVE 6 — SET ONLY WHEN THIS WAS ONE PART OF A LARGER MIGRATION,
   * and only when there is something to say about the part itself rather
   * than about its rows.
   *
   * ⚠️ THE SENTENCE THAT MATTERS MOST HERE IS "this part had already been
   * imported, so it was not imported again". A customer whose connection
   * dropped mid-migration and who re-ran it needs to know their rows are
   * there ONCE — not to be shown a report of zero rows written and
   * conclude the second attempt failed.
   */
  chunkNote?: string;
};
