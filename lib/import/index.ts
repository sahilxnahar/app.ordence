/**
 * Ordence — Import Framework, public surface
 * Version: v1.57.0-alpha (Batch 57)
 *
 * ⚠️ EVERYTHING UNDER `lib/import/` IS PURE — no database, no `node:`
 * imports, no clock. That is not tidiness: it is what lets the SAME
 * decision code run inside the server action during a commit and inside
 * the browser wizard when it builds a blank template, and it is what
 * makes constraint 1 (the dry run must match the real run) testable
 * without standing up Postgres.
 *
 * The database lives on the other side of this line, in
 * `server/actions/import.ts`, and its only jobs are: look up which
 * natural keys already exist, and write the rows this layer approved.
 */

export { parseCsv, alignToHeader, unguardFormulaPrefix } from "./csv";
export type { CsvRecord, CsvParseResult } from "./csv";

export {
  coerceText,
  coerceInteger,
  coerceMoneyMinor,
  coerceBoolean,
  coerceCivilDay,
  coerceEnum,
} from "./values";
export type { CoercionResult } from "./values";

export { normaliseHeader, mapHeaders, describeMissingHeaders } from "./mapping";
export type { HeaderMapping } from "./mapping";

export {
  planImport,
  /**
   * ⭐ WAVE 6. The same planner, from a record stream rather than text —
   * which is how Excel, JSON and Tally XML reach it without a second
   * importer. See `lib/import/sources/`.
   */
  planImportRecords,
  MAX_IMPORT_ROWS,
  MAX_IMPORT_BYTES,
} from "./plan";

export {
  buildReport,
  buildFailedRowsCsv,
  buildTemplateCsv,
  FAILED_ROW_ERROR_HEADER,
} from "./report";
export type { RowOutcome } from "./report";

export {
  IMPORT_ENTITIES,
  IMPORT_ENTITY_KEYS,
  ALL_IMPORT_ENTITIES,
  isImportEntityKey,
} from "./entities";
export type { ImportEntityKey, AnyImportEntityKey } from "./entities";

/* ---------------------------------------------------------------- */
/* ⭐⭐ BATCH 58 — OPENING BALANCES                                    */
/* ---------------------------------------------------------------- */

export {
  OPENING_IMPORT_ENTITIES,
  OPENING_IMPORT_ENTITY_KEYS,
} from "./opening-entities";
export type { OpeningImportEntityKey } from "./opening-entities";

export {
  OPENING_KEY_PREFIX,
  openingBatchKey,
  coerceQuantityThousandths,
  totalTrialBalance,
  describeImbalance,
  describeDisagreeingDates,
  disagreeingAsAtDates,
  describeAtomicRefusal,
  rupeesOf,
} from "./opening";
export type { OpeningKeyKind, TrialBalanceTotals } from "./opening";

/**
 * ⚠️ THE SCHEMAS ARE EXPORTED, AND THAT IS THE POINT OF EXPORTING THEM.
 * There is no single-record opening-balance form today. When one is
 * built it must import these rather than restate the rules beside itself
 * — see the header of `opening-schemas.ts`.
 */
export {
  openingLedgerLineSchema,
  openingCustomerInvoiceSchema,
  openingVendorBillSchema,
  openingStockLineSchema,
} from "./opening-schemas";

export type {
  DuplicateMode,
  HeaderAssignment,
  ImportColumn,
  ImportColumnKind,
  ImportContext,
  ImportEntityDefinition,
  ImportMoneyContract,
  ImportLookup,
  ImportLookupKind,
  ImportNaturalKey,
  ImportPlan,
  ImportReport,
  ImportReportRow,
  ImportRowError,
  ImportRowPlan,
  ImportTableKey,
  RowDisposition,
} from "./types";
