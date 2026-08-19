/**
 * Ordence — Header Mapping
 * Version: v1.57.0-alpha (Batch 57)
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE HEADER ROW IS WHERE AN IMPORT SILENTLY GOES WRONG
 * ══════════════════════════════════════════════════════════════════════
 * A row that fails validation is visible: it is in the report with a
 * reason. A COLUMN that fails to map is not — every row simply arrives
 * without that field, and if the field was optional the import succeeds
 * completely while quietly discarding the phone number of every contact
 * in the file. Nobody notices for months.
 *
 * So this module does two things that are easy to leave out:
 *   1. It reports every header the file has that no column claimed, and
 *      the wizard shows that list. An ignored column is stated, never
 *      just ignored.
 *   2. It refuses the whole run when a REQUIRED header is missing,
 *      naming what was expected and what was found, rather than reading
 *      a thousand rows and failing each one for the same reason.
 */

import type { HeaderAssignment, ImportColumn } from "./types";

/**
 * ⚠️ NORMALISATION IS DELIBERATELY AGGRESSIVE.
 *
 * `Company Name`, `company_name`, `COMPANY NAME`, `Company-Name` and
 * `companyname ` are the same column by any human reading, and the
 * customer did not choose which one their previous system exported. Every
 * one of those normalises to `companyname`.
 *
 * ⚠️ AND IT STRIPS THE BOM AGAIN, BELT AND BRACES. `parseCsv` removes it
 * at the front of the file, but a customer who concatenated two exports
 * can have one mid-file. A `﻿` surviving into a header is the defect
 * that makes the FIRST column — usually the name, usually required —
 * silently unmapped, which is the single most common "the importer is
 * broken" report there is.
 */
export function normaliseHeader(header: string): string {
  return header
    .replace(/﻿/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

export type HeaderMapping = {
  assignments: HeaderAssignment[];
  unrecognisedHeaders: string[];
  /** Canonical headers of required columns the file does not have. */
  missingRequired: string[];
};

/**
 * Match the file's header row against an entity's columns.
 *
 * ⚠️ FIRST MATCH WINS AND THE DUPLICATE IS LEFT UNRECOGNISED. A file with
 * two columns both normalising to `name` is ambiguous; taking the first
 * and SAYING the second was ignored is the only honest option, because
 * silently taking the last means the customer's data depends on column
 * order they never thought about.
 */
export function mapHeaders(
  headerRow: readonly string[],
  columns: readonly ImportColumn[],
): HeaderMapping {
  const claimed = new Set<number>();
  const assignments: HeaderAssignment[] = [];
  const missingRequired: string[] = [];

  for (const column of columns) {
    const candidates = new Set<string>([
      normaliseHeader(column.header),
      normaliseHeader(column.field),
      ...(column.aliases ?? []).map(normaliseHeader),
    ]);

    let index = -1;
    for (let i = 0; i < headerRow.length; i += 1) {
      if (claimed.has(i)) continue;
      const cell = headerRow[i];
      if (cell !== undefined && candidates.has(normaliseHeader(cell))) {
        index = i;
        break;
      }
    }

    if (index >= 0) claimed.add(index);
    if (index < 0 && column.required) missingRequired.push(column.header);

    assignments.push({
      field: column.field,
      header: column.header,
      required: column.required,
      matchedHeader: index >= 0 ? (headerRow[index] ?? null) : null,
      index,
    });
  }

  const unrecognisedHeaders = headerRow
    .map((h, i) => ({ h, i }))
    .filter(({ h, i }) => !claimed.has(i) && h.trim() !== "")
    .map(({ h }) => h);

  return { assignments, unrecognisedHeaders, missingRequired };
}

/**
 * The sentence shown when required columns are missing.
 *
 * ⚠️ IT LISTS WHAT THE FILE DOES HAVE. "Missing column: Name" is true and
 * useless when the file's first header is `﻿Name` or `Customer Name` —
 * the customer looks at their file, sees a name column, and concludes the
 * software is wrong. Printing both sides of the comparison is what turns
 * that into a thirty-second fix.
 */
export function describeMissingHeaders(
  missingRequired: readonly string[],
  headerRow: readonly string[],
): string {
  const found = headerRow.filter((h) => h.trim() !== "");
  return (
    `This file is missing ${missingRequired.length === 1 ? "a required column" : "required columns"}: ` +
    `${missingRequired.join(", ")}. ` +
    `The columns found were: ${found.length > 0 ? found.join(", ") : "(none)"}. ` +
    `Nothing has been imported — download the blank template above, which has ` +
    `the headings spelled the way this expects them.`
  );
}
