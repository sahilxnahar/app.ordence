/**
 * Ordence — The One Validation Path
 * Version: v1.57.0-alpha (Batch 57)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 CONSTRAINT 1: A DRY RUN THAT DOES NOT MATCH THE REAL RUN IS WORSE
 *    THAN NO DRY RUN
 * ══════════════════════════════════════════════════════════════════════
 * A preview exists to be BELIEVED. Its entire value is that the customer
 * reads "982 will be created, 18 will fail", presses the button, and gets
 * exactly that. If the real run then rejects a further 40 rows, the
 * preview has done active harm: it consumed the customer's attention,
 * spent their trust, and taught them that the number on the screen is
 * decorative. From then on they skip it — which means the one safety rail
 * the import has is the first thing they turn off.
 *
 * The way that failure happens is never a decision to write two
 * validators. It is a "quick" one: the preview needs to run in the
 * browser, or needs to be faster, so it checks "just the obvious things".
 * Six weeks later the real path has a rule the preview does not.
 *
 * ⚠️ SO THERE IS ONE FUNCTION, `planImport`, AND IT IS THE ONLY PLACE IN
 * THIS CODEBASE THAT DECIDES WHETHER AN IMPORTED ROW IS VALID.
 * `previewImport` calls it. `commitImport` calls it. Neither takes a
 * parameter that changes what it does. There is no `quick` flag, no
 * `skipExpensiveChecks`, and no second entry point — because the moment
 * one exists, "worse than no dry run" is one refactor away.
 *
 * The commit's only additional knowledge is what the DATABASE says, and
 * that is obtained by the same helper for both runs too (see
 * `server/actions/import.ts`). What genuinely remains unknowable at
 * preview time is stated out loud in the wizard rather than papered over:
 * a database constraint nothing in the schema layer models, and anything
 * a colleague writes in the seconds between the two clicks.
 *
 * ⚠️ PURE. No database, no clock, no randomness. Given the same text and
 * the same entity this returns the same plan on the server, in the
 * browser and in a test, which is the property that makes constraint 1
 * checkable at all.
 */

import { alignToHeader, parseCsv, unguardFormulaPrefix } from "./csv";
import { describeMissingHeaders, mapHeaders } from "./mapping";
import { coerceQuantityThousandths, describeAtomicRefusal } from "./opening";
import {
  coerceBoolean,
  coerceCivilDay,
  coerceEnum,
  coerceInteger,
  coerceMoneyMinor,
  coerceText,
  type CoercionResult,
} from "./values";
import type {
  ImportColumn,
  ImportEntityDefinition,
  ImportPlan,
  ImportRowError,
  ImportRowPlan,
} from "./types";

/**
 * ⚠️ CAPPED, AND THE CAP IS A PRODUCT DECISION RATHER THAN A LIMITATION.
 *
 * The commit writes one transaction per row (see `server/actions/import.ts`
 * for why partial success requires that). A thousand of those is slow but
 * finishes; a hundred thousand is a request that times out halfway with
 * some rows written and no report, which is the single worst outcome the
 * whole framework is built to avoid.
 *
 * A customer with more than this has a genuine migration, not a CSV
 * upload, and the honest answer is to say so and split the file — which
 * the message does.
 */
export const MAX_IMPORT_ROWS = 1000;

/**
 * ⚠️ AND A BYTE CAP, BECAUSE THE ROW CAP IS NOT REACHED UNTIL AFTER
 * PARSING. A 200 MB paste is a memory event before a single row exists to
 * count. 4 MB is far more than 1000 rows of CRM data ever is.
 */
export const MAX_IMPORT_BYTES = 4 * 1024 * 1024;

function coerceCell(raw: string, column: ImportColumn): CoercionResult {
  switch (column.kind) {
    case "integer":
      return coerceInteger(raw, column.bounds);
    case "money":
      return coerceMoneyMinor(raw);
    /*
     * ⭐ BATCH 58. Integer thousandths, through the same BigInt string
     * parse the money coercion uses — `0.1 + 0.2 !== 0.3`, and a stock
     * ledger out by a millionth on every movement stops reconciling.
     */
    case "quantity":
      return coerceQuantityThousandths(raw);
    case "boolean":
      return coerceBoolean(raw);
    case "date":
      return coerceCivilDay(raw);
    case "enum":
      return coerceEnum(raw, column.enumValues ?? []);
    case "text":
    default:
      return coerceText(raw, column.maxLength);
  }
}

function fatalPlan(entityKey: string, fatal: string): ImportPlan {
  return {
    entityKey,
    headers: [],
    assignments: [],
    unrecognisedHeaders: [],
    rows: [],
    fatal,
  };
}

/**
 * Parse, map, coerce, validate and de-duplicate a whole file.
 *
 * The result carries a decision for every row and nothing else — no
 * writes, no database reads, no side effects. Both server actions consume
 * it unchanged.
 */
export function planImport(
  entity: ImportEntityDefinition,
  csvText: string,
): ImportPlan {
  if (csvText.length > MAX_IMPORT_BYTES) {
    return fatalPlan(
      entity.key,
      `That file is too large (over ${Math.round(MAX_IMPORT_BYTES / (1024 * 1024))} MB). ` +
        `Split it and import the pieces one after another — imports are matched on ` +
        `${entity.label.toLowerCase()} identity, so the pieces will not overlap.`,
    );
  }

  const parsed = parseCsv(csvText);
  if (!parsed.ok) return fatalPlan(entity.key, parsed.error);

  const [header, ...dataRecords] = parsed.records;
  if (!header) return fatalPlan(entity.key, "That file has no rows in it.");

  const headers = header.cells;
  const mapping = mapHeaders(headers, entity.columns);

  /*
   * ⚠️ REFUSED BEFORE A SINGLE ROW IS READ. Continuing would produce a
   * thousand identical row errors saying "name is required", which reads
   * like a thousand bad rows rather than one bad header, and buries the
   * one sentence that would fix it.
   */
  if (mapping.missingRequired.length > 0) {
    return fatalPlan(
      entity.key,
      describeMissingHeaders(mapping.missingRequired, headers),
    );
  }

  if (dataRecords.length === 0) {
    return fatalPlan(
      entity.key,
      "That file has a header row and no data rows under it.",
    );
  }

  if (dataRecords.length > MAX_IMPORT_ROWS) {
    return fatalPlan(
      entity.key,
      `That file has ${dataRecords.length} rows and the limit for one import is ` +
        `${MAX_IMPORT_ROWS}. Split it into files of ${MAX_IMPORT_ROWS} or fewer and ` +
        `run them one after another — matching on ${entity.label.toLowerCase()} ` +
        `identity means running several files, or the same file twice, will not ` +
        `duplicate anything.`,
    );
  }

  /**
   * ⚠️ IN-FILE DUPLICATES ARE CAUGHT HERE, NOT LEFT TO THE DATABASE.
   *
   * Two rows in one file with the same natural key is common — an export
   * from a system that had the duplicate already, or a copy-paste. Left
   * alone, the outcome depends on the duplicate mode in a way nobody
   * would predict: under `skip` the second row is silently discarded
   * because the first has by then been written; under `update` the second
   * row silently overwrites the first, so which of two conflicting rows
   * "wins" is decided by their order in a spreadsheet; under `fail` a
   * unique-constraint violation surfaces halfway through as a database
   * error message.
   *
   * All three are the same defect: a decision made by accident. So the
   * SECOND row is refused, naming the row it collides with, and it lands
   * in the failed-rows CSV where a human can pick.
   */
  const seen = new Map<string, number>();
  const rows: ImportRowPlan[] = [];

  for (const record of dataRecords) {
    const errors: ImportRowError[] = [];

    const aligned = alignToHeader(record.cells, headers.length);
    if (!aligned.ok) {
      rows.push({
        recordNumber: record.recordNumber,
        cells: record.cells,
        errors: [{ column: null, message: aligned.error }],
      });
      continue;
    }

    const values: Record<string, string | number | boolean | null> = {};
    for (const assignment of mapping.assignments) {
      const column = entity.columns.find((c) => c.field === assignment.field);
      if (!column) continue;

      // An unmatched optional column contributes nothing at all — not
      // `null`. See `buildPayload`: absent and null mean different things
      // to an update.
      if (assignment.index < 0) continue;

      // Undoes the formula guard our own failed-rows CSV applies, so the
      // fix-and-re-upload loop is lossless. See `unguardFormulaPrefix`.
      const raw = unguardFormulaPrefix(aligned.cells[assignment.index] ?? "");
      const coerced = coerceCell(raw, column);
      if (!coerced.ok) {
        errors.push({ column: column.header, message: coerced.message });
        continue;
      }
      values[column.field] = coerced.value;
    }

    if (errors.length > 0) {
      rows.push({ recordNumber: record.recordNumber, cells: aligned.cells, errors });
      continue;
    }

    /*
     * 🔴 THE ENTITY'S OWN SCHEMA — the same object `createCompany` and
     * `saveParty` parse. Every rule this product actually depends on is
     * in there, and this is the line that stops the bulk path from being
     * a way around them.
     */
    const payload = entity.buildPayload(values);
    const result = entity.schema.safeParse(payload);

    if (!result.success) {
      for (const issue of result.error.issues) {
        const field = issue.path[0];
        const column = entity.columns.find((c) => c.field === field);
        errors.push({
          column: column?.header ?? (typeof field === "string" ? field : null),
          message: issue.message,
        });
      }
      rows.push({ recordNumber: record.recordNumber, cells: aligned.cells, errors });
      continue;
    }

    const parsedPayload = result.data as Record<string, unknown>;
    const naturalKey = entity.naturalKey(parsedPayload);

    if (naturalKey) {
      const composite = `${naturalKey.kind}:${naturalKey.value}`;
      const firstAt = seen.get(composite);
      if (firstAt !== undefined) {
        rows.push({
          recordNumber: record.recordNumber,
          cells: aligned.cells,
          errors: [
            {
              column: null,
              message:
                `This is the same ${entity.noun.one} as row ${firstAt} — both have ` +
                `${naturalKey.label}. Only one row per ${entity.noun.one} can be ` +
                `imported in a single file; decide which of the two is right and ` +
                `delete the other.`,
            },
          ],
        });
        continue;
      }
      seen.set(composite, record.recordNumber);
    }

    rows.push({
      recordNumber: record.recordNumber,
      cells: aligned.cells,
      errors: [],
      payload: parsedPayload,
      naturalKey,
      label: entity.rowLabel(parsedPayload),
      /*
       * ⭐ BATCH 58. What this row REFERS to — an account code, a
       * customer, a warehouse. Named here, resolved against the database
       * by `server/actions/import.ts` once for the whole file and for
       * both runs. Naming it in the pure layer is what keeps the preview
       * and the commit reading the same list.
       */
      lookups: entity.lookups?.(parsedPayload),
    });
  }

  /*
   * ══════════════════════════════════════════════════════════════════
   * ⭐⭐ BATCH 58 — THE TWO WHOLE-FILE RULES, AND THE ORDER IS THE POINT
   * ══════════════════════════════════════════════════════════════════
   * Both run BELOW every row decision and neither knows which run it is
   * in, so a preview and a commit reach the same verdict about the same
   * file.
   *
   * 1. ATOMIC ENTITIES REFUSE THE WHOLE FILE IF ANY ROW FAILED. The
   *    reasoning is on `atomic` in `types.ts`: an opening trial balance
   *    is ONE journal entry, and importing 38 of its 40 lines produces a
   *    ledger that does not balance rather than 95% of an opening
   *    position.
   *
   *    ⚠️ THE REFUSAL IS WRITTEN AS ROW ERRORS AND NOT AS `fatal`. A
   *    fatal empties `rows`, which takes the failed-rows CSV with it —
   *    and that download is the entire mechanism by which the customer
   *    finds the two lines that were wrong. Marking every clean row
   *    instead means nothing is written (the server only writes rows
   *    with no errors), the counts are honest, and the CSV they download
   *    has all forty rows in it with the real reasons on the real
   *    offenders.
   *
   * 2. THE FILE RULE — the balance check — runs ONLY on a file whose
   *    rows all read cleanly. Arithmetic over a file containing an
   *    unreadable amount produces a difference that is an artefact of
   *    the unreadable cell, and "you are ₹4,000 out" sends the customer
   *    hunting for an error that does not exist.
   */
  const badRows = rows.filter((row) => row.errors.length > 0).length;

  if (entity.atomic && badRows > 0) {
    const refusal = describeAtomicRefusal(entity.noun.many, badRows, rows.length);
    return {
      entityKey: entity.key,
      headers,
      assignments: mapping.assignments,
      unrecognisedHeaders: mapping.unrecognisedHeaders,
      rows: rows.map((row) =>
        row.errors.length > 0
          ? row
          : { ...row, payload: undefined, errors: [{ column: null, message: refusal }] },
      ),
      fatal: null,
    };
  }

  const fileFatal = badRows === 0 ? (entity.fileRule?.(rows) ?? null) : null;

  return {
    entityKey: entity.key,
    headers,
    assignments: mapping.assignments,
    unrecognisedHeaders: mapping.unrecognisedHeaders,
    /*
     * ⚠️ `rows` IS EMPTIED WHEN THE FILE RULE REFUSES, which is the
     * contract `fatal` has carried since Batch 57 and is right here: an
     * unbalanced trial balance has no failed ROWS to hand back. Every
     * line in it is individually fine. What is wrong is the total, and
     * the message carries the difference in rupees and which side is
     * short — which is the whole of what the customer needs to find it.
     */
    rows: fileFatal ? [] : rows,
    fatal: fileFatal,
  };
}
