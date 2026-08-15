/**
 * Ordence — CSV Reader
 * Version: v1.57.0-alpha (Batch 57)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE PRODUCT HAD NO WAY IN
 * ══════════════════════════════════════════════════════════════════════
 * Every workspace started empty and everything in it was typed by hand.
 * A prospect with 800 customers on file was being asked to re-key 800
 * customers before the software did anything for them, which is not a
 * migration cost anybody pays to evaluate a product.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THIS IS ~120 LINES OF PARSER AND NOT A DEPENDENCY
 * ══════════════════════════════════════════════════════════════════════
 * `papaparse` and `csv-parse` both do this correctly and both were
 * deliberately not added. `lib/documents/csv.ts` already states the rule
 * for the WRITE side: Ordence deploys from GitHub to Railway, the deploy
 * is the fragile part of this project, and every dependency is a way for
 * `npm ci` to fail. The read side is the same argument with a second one
 * on top — a CSV parser is a pure state machine over a string with a
 * specification (RFC 4180) that has not changed since 2005. It is the
 * exact shape of problem where a dependency buys nothing and costs a
 * supply-chain surface.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE FILE ORDINARY CUSTOMERS ACTUALLY SEND, AND WHAT IT DOES TO YOU
 * ══════════════════════════════════════════════════════════════════════
 * Nobody uploads RFC 4180. They upload whatever "Save as CSV" produced,
 * and each of the following is a real defect this parser exists to absorb:
 *
 *   • A BOM. Excel on Windows writes `EF BB BF` before the first byte.
 *     Skipped naively, the first header reads `﻿Name` instead of
 *     `Name`, which does NOT match, so the name column silently goes
 *     unmapped and every row fails with "name is required". The report
 *     then blames the data for a defect in the reader. This is the single
 *     highest-frequency cause of a "the importer is broken" ticket.
 *
 *   • CRLF line endings. Split on `\n` alone and every last field on
 *     every row keeps a trailing `\r` — so `"Mumbai\r"` is stored, and it
 *     never matches `"Mumbai"` again in any search or join.
 *
 *   • Quoted fields containing commas: `"Kumar, Rajesh & Co"`. Split on
 *     `,` and the row gains a column, everything after it shifts left,
 *     and a phone number lands in the city field. Shifted data is worse
 *     than rejected data because it imports successfully.
 *
 *   • Quoted fields containing NEWLINES — a multi-line postal address in
 *     one cell. A line-based reader turns one record into three broken
 *     ones. This is why the parser walks characters and never splits on
 *     lines first.
 *
 *   • `""` as an escaped quote inside a quoted field.
 *
 *   • Trailing blank lines. Almost every exporter writes one; a reader
 *     that does not drop them reports "1 row failed" on a file the
 *     customer can see is fine, and there is no row for them to look at.
 *
 * ⚠️ NO I/O, NO DATABASE, NO `node:` IMPORTS. This module is imported by
 * the server action AND by the client wizard (which builds the blank
 * template from the same column list). Anything unpure here would drag a
 * database client into the browser bundle.
 */

/** One physical record. `recordNumber` is 1-based and counts the header. */
export type CsvRecord = {
  /**
   * ⚠️ A RECORD NUMBER, NOT A LINE NUMBER, AND THE TWO GENUINELY DIFFER.
   *
   * A quoted address spanning three lines is ONE record. Reporting the
   * file line would send the customer to a line that is the middle of a
   * cell. Every error message in the framework counts records, and the
   * header is record 1 — which is also how a spreadsheet numbers its
   * rows, so "record 47" and the row Excel labels 47 are the same thing.
   */
  recordNumber: number;
  cells: string[];
};

export type CsvParseResult =
  | { ok: true; records: CsvRecord[] }
  | { ok: false; error: string };

/**
 * ⚠️ THE BOM IS STRIPPED HERE AND NOWHERE ELSE.
 *
 * Doing it at the point of use — in the header matcher, say — means the
 * next reader of a CSV in this codebase has to remember. Doing it here
 * means a `﻿` cannot survive into a cell value at all.
 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Parse a whole CSV document into records.
 *
 * ⚠️ RETURNS A RESULT, NOT A THROW, AND REFUSES ON AN UNBALANCED QUOTE.
 *
 * The tempting behaviour for an unterminated quote is to treat end-of-file
 * as the closing quote and carry on. That is what most naive parsers do,
 * and it is the worst possible outcome: one stray `"` in row 12 of a
 * thousand-row file swallows the remaining 988 rows into a single cell,
 * the import reports "1 row imported", and nothing anywhere says why. A
 * refusal that names the record is recoverable; a silent swallow is not.
 */
export function parseCsv(text: string): CsvParseResult {
  const src = stripBom(text);

  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let field = "";
  let inQuotes = false;
  /** Where the currently-open quote started, so the refusal can name it. */
  let openQuoteRecord = 0;
  let physicalRecord = 1;
  let i = 0;

  const endField = () => {
    cells.push(field);
    field = "";
  };
  const endRecord = () => {
    endField();
    records.push({ recordNumber: physicalRecord, cells });
    cells = [];
    physicalRecord += 1;
  };

  while (i < src.length) {
    const ch = src[i];

    if (inQuotes) {
      if (ch === '"') {
        // `""` inside a quoted field is one literal quote (RFC 4180 §2.7).
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      /*
       * ⚠️ A NEWLINE INSIDE QUOTES IS DATA, and CRLF is normalised to LF
       * on the way in. Storing the `\r` would mean a two-line address
       * renders with a stray carriage return in every PDF and email that
       * ever prints it.
       */
      if (ch === "\r") {
        field += "\n";
        i += src[i + 1] === "\n" ? 2 : 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      openQuoteRecord = physicalRecord;
      i += 1;
      continue;
    }
    if (ch === ",") {
      endField();
      i += 1;
      continue;
    }
    // CR, CRLF and bare LF all end a record. Old Mac CR-only files exist.
    if (ch === "\r") {
      endRecord();
      i += src[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    if (ch === "\n") {
      endRecord();
      i += 1;
      continue;
    }

    field += ch;
    i += 1;
  }

  if (inQuotes) {
    return {
      ok: false,
      error:
        `A quoted value starting on row ${openQuoteRecord} is never closed — ` +
        `there is an odd number of " characters in the file. Everything after ` +
        `it would be read as one cell, so nothing has been imported. Open the ` +
        `file in a text editor and check row ${openQuoteRecord}.`,
    };
  }

  // The final record has no terminator when the file does not end in a
  // newline. Flushing unconditionally and dropping empties below handles
  // both cases with one rule instead of two.
  endRecord();

  /*
   * ⚠️ BLANK RECORDS ARE DROPPED WHEREVER THEY APPEAR, not only at the
   * end. A blank line in the middle of a file is a formatting artefact,
   * never a record somebody meant to create — but `recordNumber` is
   * assigned BEFORE this filter, so the numbers the report quotes still
   * match the row numbers the customer sees in their spreadsheet. Filter
   * first and renumber and every error message points one row too high.
   */
  const nonEmpty = records.filter((r) => r.cells.some((c) => c.trim() !== ""));

  if (nonEmpty.length === 0) {
    return { ok: false, error: "That file has no rows in it." };
  }

  return { ok: true, records: nonEmpty };
}

/**
 * ⭐ UNDO — AND ONLY UNDO — THE FORMULA GUARD `escapeCsvCell` APPLIES.
 *
 * `lib/documents/csv.ts` prefixes an apostrophe to any value beginning
 * `=`, `+`, `-`, `@` or a control character, because Excel would
 * otherwise execute it (CWE-1236). That is correct and must stay.
 *
 * 🔴 BUT IT BREAKS THE LOOP THIS FRAMEWORK IS BUILT AROUND. Constraint 2
 * says the failed rows come back as a CSV the customer fixes and
 * re-uploads. That file is written by `escapeCsvCell`, so a phone number
 * `+919812345678` comes back as `'+919812345678` — and on re-upload it is
 * stored WITH the apostrophe. The round trip would corrupt exactly the
 * columns most likely to start with a `+`: phone numbers.
 *
 * ⚠️ THE TEST IS DELIBERATELY NARROW: an apostrophe is only removed when
 * the character after it is one Excel would have interpreted. A company
 * genuinely named `'Tis The Season` keeps its apostrophe, because `T` is
 * not a formula trigger. Stripping every leading apostrophe would be a
 * data-mangling rule of its own.
 *
 * As a bonus this also reads files that other tools write with the same
 * convention — a leading apostrophe is the spreadsheet idiom for "this
 * is text, not a formula", and Excel itself never displays it.
 */
export function unguardFormulaPrefix(cell: string): string {
  return /^'[=+\-@\t\r]/.test(cell) ? cell.slice(1) : cell;
}

/**
 * Line up a data record against the header.
 *
 * ⚠️ TOO MANY VALUES IS AN ERROR; TOO FEW IS PADDED. They are not
 * symmetrical and treating them the same is wrong in one direction.
 *
 * A record with MORE values than headers is almost always an unescaped
 * comma inside a value — `Kumar, Rajesh` written without quotes. Every
 * field after it has shifted by one, so the record parses cleanly and
 * stores the phone number in `city`. Accepting it produces plausible,
 * wrong data that nobody finds until a year later. It has to be refused.
 *
 * A record with FEWER is the ordinary case of an exporter omitting
 * trailing empty columns, so the missing tail is padded with empties and
 * the row is judged on its content like any other. Refusing it would fail
 * most real files for no benefit.
 *
 * Trailing EMPTY extras are trimmed rather than refused — a trailing comma
 * on every line is a common exporter quirk and carries no data.
 */
export function alignToHeader(
  cells: readonly string[],
  headerCount: number,
): { ok: true; cells: string[] } | { ok: false; error: string } {
  let end = cells.length;
  while (end > headerCount && cells[end - 1]?.trim() === "") end -= 1;

  if (end > headerCount) {
    return {
      ok: false,
      error:
        `This row has ${end} values but the header has ${headerCount} columns. ` +
        `A value containing a comma must be wrapped in double quotes — ` +
        `otherwise every column after it shifts across and the data would be ` +
        `imported into the wrong fields.`,
    };
  }

  const aligned = cells.slice(0, end);
  while (aligned.length < headerCount) aligned.push("");
  return { ok: true, cells: aligned };
}
