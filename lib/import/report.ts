/**
 * Ordence — The Report, and Getting the Failed Rows Back
 * Version: v1.57.0-alpha (Batch 57)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 CONSTRAINT 2: PARTIAL SUCCESS IS THE DEFAULT AND MUST BE SAID OUT
 *    LOUD
 * ══════════════════════════════════════════════════════════════════════
 * The instinct with an import is all-or-nothing: one transaction, any
 * failure rolls everything back, the customer "fixes the file" and tries
 * again. It sounds rigorous and it is unusable. A thousand-row export
 * from a decade-old system has bad rows in it — a missing GSTIN, a
 * garbled date, a name field with a stray quote. All-or-nothing means the
 * customer cannot get ANY of their data in until they have fixed EVERY
 * defect in it, with the only feedback being one error at a time. Most
 * give up, and giving up here means not becoming a customer.
 *
 * 900 of 1000 rows importing is what they actually want. So partial
 * success is the design, not the failure mode.
 *
 * ⚠️ BUT PARTIAL SUCCESS IS ONLY ACCEPTABLE IF THE REMAINDER IS HANDED
 * BACK. An import that reports "100 errors" and stops there has created a
 * task nobody can complete: the customer now has a file of 1000 rows,
 * 900 of which are already imported, and no way to tell which 100 are
 * not. Re-uploading the whole file is their only option, and whether that
 * duplicates everything depends on a natural key they have never heard of.
 *
 * So `buildFailedRowsCsv` gives back exactly the failed rows, in their
 * original columns, in their original wording, plus one extra column
 * saying what was wrong with each. The customer edits that file — it is
 * small, and every row in it needs attention — and uploads it again. That
 * is the loop, and the report is not finished until the loop closes.
 */

import { escapeCsvCell, toCsv, type CsvColumn } from "@/lib/documents/csv";
import type {
  DuplicateMode,
  ImportColumn,
  ImportEntityDefinition,
  ImportPlan,
  ImportReport,
  ImportReportRow,
  ImportRowError,
  RowDisposition,
} from "./types";

/**
 * ⚠️ THE HEADER OF THE EXTRA COLUMN MATTERS.
 *
 * It is prose, not a field name, so it can never collide with a real
 * column — and when the fixed file is uploaded again it lands in the
 * report's "columns we ignored" list, where it reads as an explanation
 * rather than an error. Naming it `error` would risk matching a
 * customer's own column one entity from now.
 */
export const FAILED_ROW_ERROR_HEADER = "What was wrong with this row";

/**
 * ⚠️ SUCCESSES ARE SAMPLED, FAILURES NEVER ARE.
 *
 * The report crosses a server-action boundary and is rendered in one
 * table. A thousand rows of "will create ✓" is payload without
 * information — the counts already say how many there are, and nobody
 * scrolls it. The failures are the entire actionable content of the
 * screen and are sent in full however many there are; the CSV carries
 * them too, so even a report that is unpleasant to scroll is workable.
 */
const SUCCESS_SAMPLE = 20;

/** What the server decided about a row that passed validation. */
export type RowOutcome = {
  disposition: Exclude<RowDisposition, "error"> | "error";
  /** "domain ordence.com" — set when an existing record was matched. */
  matchedOn?: string | null;
  /** Set only when the WRITE failed; see the note in `server/actions/import.ts`. */
  errors?: readonly ImportRowError[];
};

export function buildReport(
  entity: ImportEntityDefinition,
  plan: ImportPlan,
  args: {
    mode: "preview" | "commit";
    duplicateMode: DuplicateMode;
    /** Keyed by `recordNumber`. Only rows that passed validation appear. */
    outcomes: ReadonlyMap<number, RowOutcome>;
  },
): ImportReport {
  const counts: Record<RowDisposition, number> = {
    create: 0,
    update: 0,
    skip: 0,
    error: 0,
  };

  const rows: ImportReportRow[] = [];
  let successesIncluded = 0;

  for (const row of plan.rows) {
    const outcome = args.outcomes.get(row.recordNumber);

    /*
     * ⚠️ VALIDATION ERRORS AND WRITE ERRORS ARE CONCATENATED, NOT CHOSEN
     * BETWEEN. A row can only have one or the other today, but a row that
     * silently lost one of two reasons is a support conversation that
     * goes in circles.
     */
    const errors: ImportRowError[] = [...row.errors, ...(outcome?.errors ?? [])];

    const disposition: RowDisposition =
      errors.length > 0 ? "error" : (outcome?.disposition ?? "error");

    counts[disposition] += 1;

    const include =
      disposition === "error" || successesIncluded < SUCCESS_SAMPLE;
    if (!include) continue;
    if (disposition !== "error") successesIncluded += 1;

    rows.push({
      recordNumber: row.recordNumber,
      disposition,
      label: row.label ?? describeUnparsedRow(row.cells),
      matchedOn: outcome?.matchedOn ?? row.naturalKey?.label ?? null,
      errors,
    });
  }

  const failedRows = plan.rows.filter((row) => {
    const outcome = args.outcomes.get(row.recordNumber);
    return row.errors.length > 0 || (outcome?.errors?.length ?? 0) > 0;
  });

  return {
    mode: args.mode,
    entityKey: entity.key,
    entityLabel: entity.label,
    noun: entity.noun,
    duplicateMode: args.duplicateMode,
    totalRows: plan.rows.length,
    counts,
    headers: plan.headers,
    assignments: plan.assignments,
    unrecognisedHeaders: plan.unrecognisedHeaders,
    rows,
    successSampleShown: successesIncluded,
    failedRowsCsv:
      failedRows.length > 0
        ? buildFailedRowsCsv(
            plan.headers,
            failedRows.map((row) => ({
              cells: row.cells,
              errors: [
                ...row.errors,
                ...(args.outcomes.get(row.recordNumber)?.errors ?? []),
              ],
            })),
          )
        : null,
    fatal: plan.fatal,
  };
}

/**
 * ⚠️ A ROW THAT FAILED BEFORE ANY FIELD WAS UNDERSTOOD STILL NEEDS A
 * LABEL. Showing an empty cell in the report's "row" column for the very
 * rows the customer must find in their spreadsheet is a small cruelty;
 * the first two non-empty values are enough to recognise it.
 */
function describeUnparsedRow(cells: readonly string[]): string {
  const shown = cells.filter((c) => c.trim() !== "").slice(0, 2);
  return shown.length > 0 ? shown.join(" · ") : "(empty row)";
}

/* ------------------------------------------------------------------ */
/* THE FILE THE CUSTOMER FIXES AND RE-UPLOADS                          */
/* ------------------------------------------------------------------ */

type FailedRow = { cells: readonly string[]; errors: readonly ImportRowError[] };

/**
 * The failed rows, ready to download.
 *
 * ⚠️ THE ORIGINAL HEADERS, IN THE ORIGINAL ORDER, WITH THE ORIGINAL
 * VALUES. Not the canonical headers this framework prefers, and not the
 * coerced values. The customer is going to open this next to the file
 * they exported, and anything renamed or reformatted is something they
 * have to reconcile before they can start fixing. The one addition is the
 * error column, appended at the END so the columns they know keep the
 * positions they know.
 *
 * ⚠️ AND IT GOES THROUGH `toCsv`, WHICH MEANS `escapeCsvCell`, WHICH
 * MEANS THE FORMULA GUARD. The values in here came from a file we did not
 * write; re-emitting `=HYPERLINK(...)` unescaped into a file the customer
 * will open in Excel is exactly the stored-injection path CWE-1236
 * describes. `unguardFormulaPrefix` in `lib/import/csv.ts` reverses the
 * one character this adds when the file comes back, so the guard costs
 * the round trip nothing.
 */
export function buildFailedRowsCsv(
  headers: readonly string[],
  rows: readonly FailedRow[],
): string {
  const columns: CsvColumn<FailedRow>[] = headers.map((header, index) => ({
    header,
    value: (row) => row.cells[index] ?? "",
  }));

  columns.push({
    header: FAILED_ROW_ERROR_HEADER,
    /*
     * ⚠️ EVERY reason, not the first. A row missing a GSTIN AND carrying
     * an unreadable date needs two fixes; reporting one means a second
     * round trip through the whole loop to discover the other.
     */
    value: (row) =>
      row.errors
        .map((e) => (e.column ? `${e.column}: ${e.message}` : e.message))
        .join(" "),
  });

  return toCsv(rows, columns);
}

/* ------------------------------------------------------------------ */
/* THE BLANK TEMPLATE                                                  */
/* ------------------------------------------------------------------ */

/**
 * A header-only CSV for an entity.
 *
 * ⚠️ THE CHEAPEST THING IN THE FRAMEWORK AND THE ONE THAT PREVENTS THE
 * MOST FAILED IMPORTS. Without it the customer guesses at column names,
 * gets one wrong, and meets the "missing required column" refusal — which
 * is a good message but is still a wasted attempt. With it, the first
 * upload usually works.
 *
 * ⚠️ A SECOND ROW OF GUIDANCE WAS DELIBERATELY NOT ADDED. It is tempting
 * to write an example row or the `help` text underneath the headers, and
 * every customer who fills the template in without deleting that row then
 * imports a company called "e.g. Acme Traders". The help lives on the
 * screen, where it cannot be mistaken for data.
 */
export function buildTemplateCsv(columns: readonly ImportColumn[]): string {
  // CRLF for the same reason `toCsv` uses it: RFC 4180 says so, and an
  // LF-only file opens as one mangled row in Excel on Windows.
  return `${columns.map((c) => escapeCsvCell(c.header)).join(",")}\r\n`;
}
