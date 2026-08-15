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

export { planImport, MAX_IMPORT_ROWS, MAX_IMPORT_BYTES } from "./plan";

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
  isImportEntityKey,
} from "./entities";
export type { ImportEntityKey } from "./entities";

export type {
  DuplicateMode,
  HeaderAssignment,
  ImportColumn,
  ImportColumnKind,
  ImportEntityDefinition,
  ImportNaturalKey,
  ImportPlan,
  ImportReport,
  ImportReportRow,
  ImportRowError,
  ImportRowPlan,
  ImportTableKey,
  RowDisposition,
} from "./types";
