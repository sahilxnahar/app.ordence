/**
 * Ordence — ⭐⭐⭐ READING AN XLSX INTO THE SAME ROW STREAM AS A CSV
 * Version: v1.74.0-alpha · Wave 6
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE WHOLE POINT: IT PRODUCES `CsvRecord[]`
 * ══════════════════════════════════════════════════════════════════════
 * `lib/import/plan.ts` already parses, maps, coerces, validates,
 * de-duplicates and reports. None of that changes for a spreadsheet. What
 * changes is only how the cells are obtained, so this file ends at exactly
 * the shape `parseCsv` produces and everything downstream is untouched.
 *
 * That is the difference between "we support Excel" and a second importer.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE FOUR THINGS THAT MAKE A NAIVE XLSX READER WRONG
 * ══════════════════════════════════════════════════════════════════════
 * ① **SPARSE CELLS.** `<row><c r="A5">…</c><c r="D5">…</c></row>` has a
 *    gap. Read in order and D's value lands in column B, so every value
 *    after the first blank cell is in the wrong column, in a file that
 *    looks fine. The `r` attribute is authoritative and this reader uses
 *    it. When a writer omits it — some do — position is implied, and that
 *    fallback is stated rather than assumed.
 *
 * ② **SHARED STRINGS.** Most text is not in the sheet. A cell with
 *    `t="s"` holds an INDEX into `xl/sharedStrings.xml`, so a reader that
 *    takes `<v>` at face value reads a column of small integers where the
 *    customer names were.
 *
 * ③ 🔴 **DATES ARE NUMBERS.** `2026-08-19` is stored as `46253`. There is
 *    nothing in the cell that says it is a date — the only evidence is
 *    the NUMBER FORMAT its style points at. A reader that ignores styles
 *    imports every invoice date as the integer 46253, and
 *    `coerceCivilDay` then rejects a thousand rows for a defect in the
 *    reader. This is the single highest-value thing in this file.
 *
 * ④ **THE 1900 LEAP-YEAR BUG, IN REVERSE.** Excel believes 1900 was a
 *    leap year. Serial 60 is a day that never existed. Converting with a
 *    fixed epoch is right from 1900-03-01 and off by one before it, so
 *    this refuses a serial below 61 rather than producing a date that is
 *    wrong by a day in a ledger.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ AND ONE THING IT CANNOT FIX, STATED HONESTLY
 * ══════════════════════════════════════════════════════════════════════
 * A GSTIN or an invoice number that the CUSTOMER's spreadsheet already
 * stored as a number has already lost its leading zeroes, before the file
 * reached us. This reader will not invent them back. What it will do is
 * not make it worse: numbers are rendered without exponent notation, so a
 * 15-digit value reads as its digits rather than `1.23457E+14`, and the
 * import report names any column where that shape was seen.
 */

import type { CsvRecord } from "../csv";
import { readZip, ZipReadError, type InflateRaw } from "./unzip";

export class XlsxReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XlsxReadError";
  }
}

export type XlsxSheet = {
  readonly name: string;
  readonly records: CsvRecord[];
};

export type XlsxDocument = {
  readonly sheets: readonly XlsxSheet[];
  /** Sentences for the import report. Never silent. */
  readonly notes: readonly string[];
};

/* ------------------------------------------------------------------ */
/* A DELIBERATELY SMALL XML SCANNER                                    */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ NOT A GENERAL XML PARSER, AND NOT `lib/tally/parse.ts` EITHER.
 * A sheet is a flat, extremely regular document, and the volume is the
 * problem: a 50,000-row sheet is 30MB of XML, and building a node tree
 * for it costs more memory than the rows do. This scans.
 */
function* tags(xml: string, name: string): Generator<{ attrs: string; body: string; selfClosing: boolean }> {
  const open = new RegExp(`<${name}(\\s[^>]*?)?(/?)>`, "g");
  let match: RegExpExecArray | null;
  while ((match = open.exec(xml)) !== null) {
    const attrs = match[1] ?? "";
    if (match[2] === "/") {
      yield { attrs, body: "", selfClosing: true };
      continue;
    }
    const close = xml.indexOf(`</${name}>`, open.lastIndex);
    if (close === -1) {
      throw new XlsxReadError(
        `That spreadsheet's XML has an unclosed <${name}> element. The file is corrupt; ` +
          `re-saving it from Excel usually fixes it.`,
      );
    }
    yield { attrs, body: xml.slice(open.lastIndex, close), selfClosing: false };
    open.lastIndex = close + name.length + 3;
  }
}

function attr(attrs: string, name: string): string | null {
  const match = attrs.match(new RegExp(`\\s${name}="([^"]*)"`));
  return match ? match[1]! : null;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function unescapeXml(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      return String.fromCodePoint(parseInt(body.slice(2), 16));
    }
    if (body.startsWith("#")) return String.fromCodePoint(parseInt(body.slice(1), 10));
    return ENTITIES[body] ?? whole;
  });
}

/** All the text of `<t>` runs inside a shared-string or inline-string item. */
function itemText(body: string): string {
  let out = "";
  for (const t of tags(body, "t")) out += unescapeXml(t.body);
  return out;
}

/* ------------------------------------------------------------------ */
/* CELL ADDRESSES                                                      */
/* ------------------------------------------------------------------ */

/** `AA7` → 26. Returns -1 when the reference is unreadable. */
export function columnIndexOf(reference: string): number {
  const letters = reference.match(/^([A-Z]+)/)?.[1];
  if (!letters) return -1;
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

/* ------------------------------------------------------------------ */
/* DATES                                                               */
/* ------------------------------------------------------------------ */

/** The built-in number formats that mean a date or a time. ECMA-376 §18.8.30. */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/**
 * ⚠️ A CUSTOM FORMAT IS A DATE IF ITS CODE CONTAINS DATE TOKENS OUTSIDE
 * QUOTES. `"Total: "0.00` contains no date token; `dd/mm/yyyy` does; and
 * `0.00" days"` must NOT be read as one, which is why the quoted sections
 * are removed first.
 */
export function formatCodeIsDate(code: string): boolean {
  const unquoted = code.replace(/"[^"]*"/g, "").replace(/\\./g, "");
  return /[yYdD]|(?<![[])m{1,5}(?![\]])|h{1,2}|s{1,2}/.test(unquoted) && !/^[#0.,%\s]*$/.test(unquoted);
}

const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86_400_000;
/** 🔴 Serial 60 is 1900-02-29, a day that never existed. See ④ in the header. */
const EARLIEST_TRUSTWORTHY_SERIAL = 61;

export function serialToIso(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < EARLIEST_TRUSTWORTHY_SERIAL) return null;
  const ms = EXCEL_EPOCH_MS + Math.floor(serial) * MS_PER_DAY;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ */
/* NUMBERS                                                             */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ NO EXPONENT NOTATION, EVER. `String(1.23456789012345e14)` is
 * `"123456789012345"` but `String(1e21)` is `"1e+21"`, and a value that
 * reaches `coerceMoneyMinor` as `1e+21` is rejected as not a number. The
 * threshold is low enough that a real figure never crosses it and a
 * corrupted one is refused rather than silently mangled.
 *
 * ⭐ AND TRAILING FLOAT NOISE IS TRIMMED. Excel stores 0.1+0.2 as
 * 0.30000000000000004; a customer who typed 0.3 should not see their
 * quantity rejected for having 17 decimal places.
 */
export function renderNumber(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return trimmed;
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value);
  if (Math.abs(value) >= 1e15) {
    /** Beyond exact integer range. Hand back what the file said, verbatim. */
    return trimmed;
  }
  const tidied = Number(value.toPrecision(15));
  return String(tidied);
}

/* ------------------------------------------------------------------ */
/* THE READER                                                          */
/* ------------------------------------------------------------------ */

export function readXlsx(bytes: Uint8Array, inflateRaw?: InflateRaw): XlsxDocument {
  let members: Map<string, Uint8Array>;
  try {
    members = readZip(bytes, inflateRaw);
  } catch (err) {
    if (err instanceof ZipReadError) throw new XlsxReadError(err.message);
    throw err;
  }

  const decoder = new TextDecoder("utf-8");
  const text = (path: string): string | null => {
    const found = members.get(path);
    return found ? decoder.decode(found) : null;
  };

  const workbookXml = text("xl/workbook.xml");
  if (!workbookXml) {
    throw new XlsxReadError(
      "That file is a zip archive but not a spreadsheet — it has no workbook inside it. If it " +
        "came from another program, export it as CSV instead.",
    );
  }

  /* ② SHARED STRINGS */
  const sharedStrings: string[] = [];
  const sharedXml = text("xl/sharedStrings.xml");
  if (sharedXml) {
    for (const si of tags(sharedXml, "si")) sharedStrings.push(itemText(si.body));
  }

  /* ③ STYLES → WHICH STYLE INDEXES MEAN A DATE */
  const dateStyles = new Set<number>();
  const stylesXml = text("xl/styles.xml");
  if (stylesXml) {
    const customDateFormats = new Set<number>();
    for (const numFmt of tags(stylesXml, "numFmt")) {
      const id = Number(attr(numFmt.attrs, "numFmtId"));
      const code = unescapeXml(attr(numFmt.attrs, "formatCode") ?? "");
      if (Number.isFinite(id) && formatCodeIsDate(code)) customDateFormats.add(id);
    }
    /**
     * ⚠️ ONLY THE `cellXfs` BLOCK. `cellStyleXfs` has the same element
     * name and is a DIFFERENT list; a cell's `s` attribute indexes the
     * first. Scanning both concatenates them and every style index past
     * the boundary resolves to the wrong format.
     */
    const cellXfsBlock = stylesXml.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? "";
    let index = 0;
    for (const xf of tags(cellXfsBlock, "xf")) {
      const id = Number(attr(xf.attrs, "numFmtId") ?? "0");
      if (BUILTIN_DATE_FORMATS.has(id) || customDateFormats.has(id)) dateStyles.add(index);
      index += 1;
    }
  }

  /* SHEET NAMES AND THEIR PARTS */
  const relsXml = text("xl/_rels/workbook.xml.rels") ?? "";
  const targetByRid = new Map<string, string>();
  for (const rel of tags(relsXml, "Relationship")) {
    const id = attr(rel.attrs, "Id");
    const target = attr(rel.attrs, "Target");
    if (id && target) targetByRid.set(id, target.replace(/^\/?xl\//, "").replace(/^\//, ""));
  }

  const sheetRefs: { name: string; path: string }[] = [];
  let fallbackIndex = 1;
  for (const sheet of tags(workbookXml, "sheet")) {
    const name = unescapeXml(attr(sheet.attrs, "name") ?? `Sheet${fallbackIndex}`);
    const rid = attr(sheet.attrs, "r:id") ?? attr(sheet.attrs, "id");
    const target = rid ? targetByRid.get(rid) : null;
    const path = `xl/${target ?? `worksheets/sheet${fallbackIndex}.xml`}`;
    sheetRefs.push({ name, path });
    fallbackIndex += 1;
  }
  if (sheetRefs.length === 0) {
    throw new XlsxReadError("That workbook has no sheets in it.");
  }

  const notes: string[] = [];
  const sheets: XlsxSheet[] = [];
  let sawImpliedPositions = false;
  let sawLongDigitString = false;
  let sawUntrustworthySerial = false;

  for (const ref of sheetRefs) {
    const sheetXml = text(ref.path);
    if (!sheetXml) {
      notes.push(
        `The sheet "${ref.name}" is listed in the workbook and its data is not in the file. It ` +
          `has been skipped rather than read as empty.`,
      );
      continue;
    }

    const records: CsvRecord[] = [];
    let recordNumber = 0;

    for (const row of tags(sheetXml, "row")) {
      recordNumber += 1;
      const declaredRow = Number(attr(row.attrs, "r") ?? recordNumber);
      const cells: string[] = [];
      let nextImplied = 0;

      for (const c of tags(row.body, "c")) {
        const reference = attr(c.attrs, "r");
        let column = reference ? columnIndexOf(reference) : -1;
        if (column < 0) {
          /** ⚠️ ① fallback. Stated, and reported once at the end. */
          column = nextImplied;
          sawImpliedPositions = true;
        }
        nextImplied = column + 1;

        const type = attr(c.attrs, "t") ?? "n";
        const styleIndex = Number(attr(c.attrs, "s") ?? "-1");

        let value = "";
        if (type === "inlineStr") {
          value = itemText(c.body);
        } else {
          const v = c.body.match(/<v[^>]*>([\s\S]*?)<\/v>/)?.[1] ?? "";
          const raw = unescapeXml(v);
          if (type === "s") {
            const index = Number(raw);
            value = sharedStrings[index] ?? "";
          } else if (type === "b") {
            value = raw === "1" ? "true" : "false";
          } else if (type === "e") {
            /**
             * ⚠️ A FORMULA ERROR IS NOT A VALUE. `#REF!` imported as text
             * becomes a customer named `#REF!`. It is passed through
             * verbatim so the row fails validation with something the
             * customer recognises from their own spreadsheet.
             */
            value = raw;
          } else if (type === "str") {
            value = raw;
          } else if (raw === "") {
            value = "";
          } else if (dateStyles.has(styleIndex)) {
            const iso = serialToIso(Number(raw));
            if (iso) {
              value = iso;
            } else {
              sawUntrustworthySerial = true;
              value = renderNumber(raw);
            }
          } else {
            value = renderNumber(raw);
            if (/^\d{12,}$/.test(value)) sawLongDigitString = true;
          }
        }

        while (cells.length < column) cells.push("");
        cells[column] = value;
      }

      /**
       * ⚠️ A COMPLETELY EMPTY ROW IS DROPPED, NOT KEPT AS A BLANK RECORD.
       * Spreadsheets are full of them — a blank line under the header, a
       * gap before a totals row — and every one kept becomes a row error
       * saying "name is required", which reads as bad data.
       */
      if (cells.some((cell) => cell !== "")) {
        records.push({ recordNumber: declaredRow, cells });
      }
    }

    sheets.push({ name: ref.name, records });
  }

  if (sawImpliedPositions) {
    notes.push(
      "Some cells in that spreadsheet carry no address, so their column was taken from their " +
        "order in the row. Check the preview before committing: if any column looks shifted, " +
        "re-save the file from Excel and upload it again.",
    );
  }
  if (sawUntrustworthySerial) {
    notes.push(
      "Some cells are formatted as dates and hold a value before 1 March 1900. Excel's date " +
        "system is off by one day before that, so those cells were read as numbers rather than " +
        "converted to a date that would be wrong.",
    );
  }
  if (sawLongDigitString) {
    notes.push(
      "Some cells hold twelve or more digits and were stored as numbers rather than text — GSTINs, " +
        "long invoice numbers and phone numbers all look like this. If any of them had a leading " +
        "zero, the spreadsheet removed it before the file reached Ordence and it cannot be " +
        "recovered here. Check those columns in the preview.",
    );
  }

  return { sheets, notes };
}
