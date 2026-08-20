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

import {
  alignToHeader,
  parseCsv,
  unguardFormulaPrefix,
  type CsvRecord,
} from "./csv";
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
  ImportContext,
  ImportEntityDefinition,
  ImportPlan,
  ImportRowError,
  ImportRowPlan, ImportNaturalKey } from "./types";
/*
 * ⚠️ RULE 4 IS NOT BROKEN BY THIS IMPORT, AND THE DISTINCTION IS THE
 * WHOLE DESIGN. `lib/fx/currency.ts` is a pure module — no `server-only`,
 * no database, no clock, its own header says so — holding the published
 * ISO-4217 exponent table. It is the same table `currency_units` is
 * seeded from, and `server/fx/rate-service.ts#verifyCurrencyUnits()`
 * compares the two so they cannot drift in silence.
 *
 * 🔴 THE ALTERNATIVE — passing an exponent map in through `ImportContext`
 * "so the pure layer takes it as data" — makes a THIRD copy of that
 * fact with no checker over it, and the copy would be assembled by
 * whichever caller happened to be writing. What genuinely is not
 * knowable here is the WORKSPACE'S currency, which is a row in
 * `tenants`, and that does arrive as data. See `ImportContext`.
 */
import {
  isKnownCurrency,
  minorUnitExponent,
  normaliseCurrencyCode,
} from "@/lib/fx/currency";

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

/**
 * ⭐⭐⭐ WAVE 2C. `money` NOW CARRIES THE ROW'S CURRENCY WITH IT.
 *
 * The exponent and the code both come from `resolveRowCurrency` below,
 * once per row, and are handed down rather than looked up here — a money
 * column cannot be coerced without knowing which currency the row is in,
 * and this function has no row.
 */
function coerceCell(
  raw: string,
  column: ImportColumn,
  currency: RowCurrency,
): CoercionResult {
  switch (column.kind) {
    case "integer":
      return coerceInteger(raw, column.bounds);
    case "money":
      return coerceMoneyMinor(raw, currency.exponent, currency.code);
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

/* ------------------------------------------------------------------ */
/* ⭐⭐⭐ WAVE 2C — THE ROW'S CURRENCY, AND THEREFORE ITS EXPONENT       */
/* ------------------------------------------------------------------ */

type RowCurrency = { readonly code: string; readonly exponent: number };

/**
 * The refusal an entity gets when its `money` contract does not describe
 * its own columns. Written as a `fatal` because it is not a property of
 * the customer's file — no row they could edit would fix it — and
 * continuing would coerce real amounts at an exponent nobody chose.
 *
 * ⚠️ THIS IS THE RUNTIME HALF OF A RULE THAT IS ALSO A CI GATE.
 * `checkImportContract()` (gate 29) is asked to reject the same shape
 * across the whole allowlist, so it never reaches a customer; this check
 * is what makes the rule true for an entity the allowlist has not seen —
 * a test fixture, or an entity added between gate runs. Both exist
 * because `{ source: "none" }` is the one variant that could otherwise be
 * used as a way of not deciding.
 */
function describeMoneyContractBreach(entity: ImportEntityDefinition): string {
  const money = entity.columns.filter((c) => c.kind === "money").map((c) => c.header);
  return (
    `The "${entity.key}" importer declares no currency for its amounts ` +
    `(money: { source: "none" }) but has ${money.length} money column` +
    `${money.length === 1 ? "" : "s"}: ${money.join(", ")}. ` +
    `Nothing has been read. An amount cannot be converted to minor units ` +
    `without knowing how many decimal places its currency has — two is ` +
    `wrong by a factor of ten for the Gulf dinars and a hundred for the yen.`
  );
}

/**
 * ⚠️ RESOLVED FROM THE RAW CELL, BEFORE ANY COLUMN IS COERCED, and that
 * ordering is not cosmetic. The currency column is an ordinary `text` or
 * `enum` column and the mapper may place it AFTER the money columns in
 * `assignments`; resolving it inside the same loop would coerce the
 * amounts of a row whose currency had not been read yet.
 *
 * Returns either the row's currency or the row error that replaces it.
 * A row whose currency is unreadable produces ONE error naming the
 * currency cell, not one error per amount — the customer has one thing
 * to fix.
 */
function resolveRowCurrency(
  entity: ImportEntityDefinition,
  context: ImportContext,
  cellFor: (field: string) => string | null,
): { ok: true; currency: RowCurrency } | { ok: false; error: ImportRowError } {
  const workspace = () => {
    /*
     * ⚠️ AN UNKNOWN WORKSPACE CURRENCY IS A REFUSAL, NOT A FALLBACK.
     * `functionalCurrencyFromSettings` already refuses an unrecognised
     * code before it gets here, so this branch means the caller built
     * the context by hand. Guessing INR at this point would be the
     * silent-default defect one layer further down.
     */
    if (!isKnownCurrency(context.workspaceCurrency)) {
      return {
        ok: false as const,
        error: {
          column: null,
          message:
            `This workspace's currency is set to "${context.workspaceCurrency}", which is ` +
            `not a currency this system knows, so no amount in this file can be read. ` +
            `Set the workspace currency in Settings and run the import again.`,
        },
      };
    }
    const code = normaliseCurrencyCode(context.workspaceCurrency);
    return { ok: true as const, currency: { code, exponent: minorUnitExponent(code) } };
  };

  const money = entity.money;

  if (money.source === "none" || money.source === "workspace") return workspace();

  const raw = cellFor(money.field);
  const trimmed = (raw ?? "").trim();

  if (trimmed === "") {
    if (money.whenBlank === "workspace") return workspace();
    const column = entity.columns.find((c) => c.field === money.field);
    return {
      ok: false,
      error: {
        column: column?.header ?? money.field,
        message:
          `This row has no currency. Every amount on it is meaningless until the ` +
          `currency is known — 1.234 is a real amount in Kuwaiti dinars and a ` +
          `malformed one in rupees. Fill in the currency column with a three-letter ` +
          `code such as INR, USD or KWD.`,
      },
    };
  }

  const code = normaliseCurrencyCode(trimmed);
  if (!isKnownCurrency(code)) {
    const column = entity.columns.find((c) => c.field === money.field);
    return {
      ok: false,
      error: {
        column: column?.header ?? money.field,
        message:
          `"${trimmed}" is not a currency this system knows, so the amounts on this ` +
          `row cannot be read. Use the three-letter ISO code — INR, USD, AED, KWD.`,
      },
    };
  }

  return { ok: true, currency: { code, exponent: minorUnitExponent(code) } };
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
  context: ImportContext,
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

  return planImportRecords(entity, parsed.records, context);
}

/**
 * ⭐⭐⭐ WAVE 6 — THE SAME PLANNER, FROM A RECORD STREAM RATHER THAN TEXT.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THIS IS THE ENTIRE COST OF SUPPORTING EVERY INPUT FORMAT
 * ══════════════════════════════════════════════════════════════════════
 * `planImport` above used to do two jobs: turn CSV text into records, and
 * turn records into a plan. Only the first is format-specific.
 * `lib/import/sources/` produces `CsvRecord[]` from Excel, JSON and Tally
 * XML, and they all arrive HERE — so mapping, coercion, validation,
 * de-duplication, the dry run, the partial-success report and the
 * re-run safety are shared, not reimplemented per format.
 *
 * 🔴 THE ALTERNATIVE — an `importFromExcel` beside `importFromCsv` — is
 * exactly what `lib/import/types.ts` was written in Batch 57 to prevent,
 * one level up: *"the parser is duplicated, the error messages have
 * drifted, the dry run of one has a bug the other does not"*. A second
 * planner would have all of those properties and would also disagree
 * about de-duplication, which is the one that doubles a customer's data.
 *
 * ⚠️ `planImport` IS KEPT AND NOT REPLACED. Every existing caller passes
 * CSV text and none of them change; the new one is a second door onto the
 * same room, not a migration.
 */
export function planImportRecords(
  entity: ImportEntityDefinition,
  records: readonly CsvRecord[],
  context: ImportContext,
): ImportPlan {
  /*
   * ⭐⭐ WAVE 2C. BEFORE THE HEADER IS EVEN READ. An entity whose money
   * contract contradicts its own columns is refused outright rather than
   * coercing amounts at a guessed exponent. See
   * `describeMoneyContractBreach`.
   */
  if (entity.money.source === "none" && entity.columns.some((c) => c.kind === "money")) {
    return fatalPlan(entity.key, describeMoneyContractBreach(entity));
  }

  const [header, ...dataRecords] = records;
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

    /*
     * ⭐⭐ WAVE 2C. ONE RESOLUTION PER ROW, ABOVE THE COLUMN LOOP — see
     * `resolveRowCurrency` for why it cannot happen inside it.
     */
    const currency = resolveRowCurrency(entity, context, (field) => {
      const assignment = mapping.assignments.find((a) => a.field === field);
      if (!assignment || assignment.index < 0) return null;
      return unguardFormulaPrefix(aligned.cells[assignment.index] ?? "");
    });

    if (!currency.ok) {
      rows.push({
        recordNumber: record.recordNumber,
        cells: aligned.cells,
        errors: [currency.error],
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
      const coerced = coerceCell(raw, column, currency.currency);
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

    /*
     * ⭐⭐⭐ WAVE 3A , THE PAIR, NOT THE KEY.
     *
     * 🔴 THIS BLOCK USED TO KEY ON `naturalKey` ALONE, AND THAT LOST A
     *    LINE OFF EVERY MULTI-LINE VOUCHER. For a journal the thing that
     *    must not be created twice is the VOUCHER, so every leg carries
     *    the same natural key , and the second leg was refused as a
     *    duplicate of the first, before the database ever saw it.
     *
     * ⭐ `documentKey` separates the two questions. When an entity
     * declares one, the in-file check keys on the PAIR: two legs on two
     * accounts are two rows, and two legs on ONE account is still the
     * mistake it always was. When it does not , which is almost every
     * entity , the composite is exactly what it was before, so nothing
     * about the existing eighteen changes by one character.
     */
    const documentKey = entity.documentKey?.(parsedPayload) ?? null;

    if (naturalKey) {
      const composite = documentKey
        ? `${documentKey.kind}:${documentKey.value}||${naturalKey.kind}:${naturalKey.value}`
        : `${naturalKey.kind}:${naturalKey.value}`;
      const firstAt = seen.get(composite);
      if (firstAt !== undefined) {
        rows.push({
          recordNumber: record.recordNumber,
          cells: aligned.cells,
          errors: [
            {
              column: null,
              /*
               * ⚠️ TWO SENTENCES, BECAUSE THEY ARE TWO DIFFERENT
               * MISTAKES. Without a document the customer has the same
               * thing twice in one file. WITH one, they have the same
               * line twice inside one voucher , and telling them "only
               * one row per journal entry can be imported" would send
               * them to delete a leg their voucher needs.
               */
              message: documentKey
                ? `This is the same line as row ${firstAt}: both are ` +
                  `${naturalKey.label} within ${documentKey.label}. A document may ` +
                  `name each of its lines once; decide which of the two is right ` +
                  `and delete the other.`
                : `This is the same ${entity.noun.one} as row ${firstAt} , both have ` +
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
      documentKey,
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

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ WAVE 3A , THE ROWS, GROUPED INTO THE DOCUMENTS THEY BELONG TO
 * ══════════════════════════════════════════════════════════════════════
 * A journal file is many documents. The writer cannot post a voucher one
 * leg at a time , a transaction with one leg does not balance, and the
 * deferred constraint refuses it at COMMIT , so it needs the legs
 * together.
 *
 * ⚠️ ORDER IS PRESERVED, AND IT IS NOT COSMETIC. Groups come back in the
 * order their FIRST row appeared, and rows within a group keep their file
 * order. The failed-rows CSV, the report and the customer's own
 * spreadsheet all number from the top; a writer that reordered them would
 * make "row 12" mean two different things on two screens.
 *
 * ⚠️ ROWS WITH ERRORS ARE NOT GROUPED. They have no payload, so they have
 * no document to belong to. Whether one bad leg refuses its whole voucher
 * is the WRITER's decision, not this function's , and it is the same
 * question `atomic` answers for a whole file.
 *
 * 🔴 AN ENTITY WITH NO `documentKey` RETURNS ONE GROUP PER ROW, which is
 *    exactly what the write path already does. So a caller can group
 *    unconditionally and the eighteen existing entities behave as they
 *    always did.
 */
export function groupByDocument(
  rows: readonly ImportRowPlan[],
): readonly { key: ImportNaturalKey | null; rows: readonly ImportRowPlan[] }[] {
  const out: { key: ImportNaturalKey | null; rows: ImportRowPlan[] }[] = [];
  const index = new Map<string, number>();

  for (const row of rows) {
    if (row.errors.length > 0 || !row.payload) continue;

    const key = row.documentKey ?? null;
    if (!key) {
      out.push({ key: null, rows: [row] });
      continue;
    }

    const composite = `${key.kind}:${key.value}`;
    const at = index.get(composite);
    if (at === undefined) {
      index.set(composite, out.length);
      out.push({ key, rows: [row] });
    } else {
      out[at]!.rows.push(row);
    }
  }

  return out;
}
