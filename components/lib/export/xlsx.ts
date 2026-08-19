/**
 * Ordence — ⭐⭐⭐ XLSX, WRITTEN BY HAND, WITH THE TYPES INTACT
 * Version: v1.73.0-alpha · Wave 5
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHY XLSX AND NOT "CSV IS FINE"
 * ══════════════════════════════════════════════════════════════════════
 * Because CSV has no types and this product's data is full of values that
 * a spreadsheet destroys on open: `0012345` invoice numbers, 15-character
 * GSTINs, 12-digit phone numbers, and dates in a country that writes them
 * day-first while Excel guesses month-first. The accountant opens the CSV,
 * sees `1.23457E+14` where the GSTIN was, and concludes the software is
 * broken — correctly, in the sense that the software chose the format.
 *
 * XLSX carries the type per cell. This writer uses it:
 *
 *   `code`     → inline string. `0012345` stays `0012345`.
 *   `money`    → number with THIS CURRENCY'S decimals in the format code.
 *   `date`     → a real Excel date, so filters and pivots work.
 *   `integer`  → a real integer, so SUM works.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE ONE THING EXCEL CANNOT DO, STATED RATHER THAN HIDDEN
 * ══════════════════════════════════════════════════════════════════════
 * Excel stores every number as an IEEE-754 double. Above 2^53-1 scaled
 * minor units it starts rounding, and it does so silently.
 * `lib/export/values.ts` detects that and hands back a TEXT cell with a
 * `demoted` sentence; this writer honours it and repeats the sentence in
 * the notes. A ledger that footed on our side and not in Excel is the
 * failure being avoided.
 *
 * ⚠️ AND THE 1900 LEAP-YEAR BUG IS REAL. Excel believes 1900 was a leap
 * year, because Lotus 1-2-3 did. The serial epoch below is 1899-12-30,
 * which is correct for every date from 1900-03-01 onward and wrong for
 * the two months before it. `dateSerial` REFUSES a date before
 * 1900-03-01 rather than writing one that is off by a day.
 *
 * ══════════════════════════════════════════════════════════════════════
 * INLINE STRINGS, NOT A SHARED STRING TABLE
 * ══════════════════════════════════════════════════════════════════════
 * A shared string table is smaller for repetitive data and it is a second
 * index to keep consistent. Deflate in `lib/export/zip.ts` recovers most
 * of the difference, and an inline string cannot be off by one.
 */

import type { Dataset, Workbook } from "./types";
import { assertDatasetIsRenderable, renderCell } from "./values";
import { XmlEscaper } from "./xml";
import { buildZip, type DeflateRaw, type ZipEntry } from "./zip";

const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** 1899-12-30, in ms. See the header for why not 1900-01-01. */
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86_400_000;
const EARLIEST_SAFE = Date.UTC(1900, 2, 1);

export class XlsxDateOutOfRangeError extends Error {
  constructor(iso: string) {
    super(
      `${iso} is before 1900-03-01. Excel's date system believes 1900 was a leap year, so every ` +
        `serial number before that date is off by one day. Nothing has been written. Export this ` +
        `column as text, or as CSV, where the date is the characters you can see.`,
    );
    this.name = "XlsxDateOutOfRangeError";
  }
}

function dateSerial(iso: string, withTime: boolean): number {
  const ms = Date.parse(iso);
  if (ms < EARLIEST_SAFE) throw new XlsxDateOutOfRangeError(iso);
  const days = (ms - EXCEL_EPOCH_MS) / MS_PER_DAY;
  return withTime ? days : Math.floor(days);
}

/** A1, B1 … Z1, AA1. */
export function cellRef(columnIndex: number, rowNumber: number): string {
  let n = columnIndex + 1;
  let letters = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - rem) / 26);
  }
  return `${letters}${rowNumber}`;
}

/**
 * ⚠️ EXCEL'S SHEET-NAME RULES, WHICH ARE NOT ADVICE. Over 31 characters,
 * or containing `: \ / ? * [ ]`, and Excel declares the file unreadable.
 * A leading or trailing apostrophe does the same. Two sheets with the
 * same name after truncation does the same again, which is why the
 * de-duplication below exists — "Sales register — north" and "Sales
 * register — south" both truncate to the same 31 characters.
 */
export function sheetName(title: string, taken: ReadonlySet<string>): string {
  let base = title.replace(/[:\\/?*[\]]/g, " ").replace(/^'+|'+$/g, "").trim();
  if (base === "") base = "Sheet";
  base = base.slice(0, 31);
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; i < 1000; i += 1) {
    const suffix = ` (${i})`;
    const candidate = base.slice(0, 31 - suffix.length) + suffix;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  throw new Error(`Cannot find a unique sheet name for "${title}".`);
}

/* ------------------------------------------------------------------ */
/* STYLES                                                              */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE STYLE TABLE IS BUILT FROM THE DATA, NOT FIXED. A workbook with
 * KWD amounts needs a three-decimal format and one with JPY needs zero;
 * emitting all four always would be harmless, and building only what is
 * used keeps the file readable when somebody unzips it to check us.
 */
type StyleKey = "header" | "date" | "datetime" | "integer" | `money:${number}` | `number:${number}`;

class StyleTable {
  private order: StyleKey[] = ["header", "date", "datetime", "integer"];

  index(key: StyleKey): number {
    const at = this.order.indexOf(key);
    if (at >= 0) return at + 1; // 0 is the default style
    this.order.push(key);
    return this.order.length;
  }

  xml(): string {
    const numFmts: string[] = [];
    const cellXfs: string[] = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
    let nextFmtId = 164; // 0-163 are reserved by the format

    for (const key of this.order) {
      if (key === "header") {
        cellXfs.push('<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>');
        continue;
      }
      if (key === "date") {
        numFmts.push(`<numFmt numFmtId="${nextFmtId}" formatCode="yyyy\\-mm\\-dd"/>`);
        cellXfs.push(`<xf numFmtId="${nextFmtId}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`);
        nextFmtId += 1;
        continue;
      }
      if (key === "datetime") {
        numFmts.push(`<numFmt numFmtId="${nextFmtId}" formatCode="yyyy\\-mm\\-dd\\ hh:mm:ss"/>`);
        cellXfs.push(`<xf numFmtId="${nextFmtId}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`);
        nextFmtId += 1;
        continue;
      }
      if (key === "integer") {
        cellXfs.push('<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>');
        continue;
      }
      const decimals = Number(key.split(":")[1]);
      /**
       * ⚠️ THOUSANDS SEPARATOR ON MONEY, NONE ON A PLAIN NUMBER. A
       * quantity of 1,000 metres reads oddly grouped; a figure of
       * 1,00,00,000 does not read at all ungrouped.
       *
       * 🔴 AND NO CURRENCY SYMBOL IN THE FORMAT CODE. The currency is its
       * own column, because a sheet where the symbol is baked into the
       * number format is a sheet where sorting mixes rupees and dollars
       * into one total and nothing on screen says so.
       */
      const code = key.startsWith("money:")
        ? decimals === 0
          ? "#,##0"
          : `#,##0.${"0".repeat(decimals)}`
        : decimals === 0
          ? "0"
          : `0.${"0".repeat(decimals)}`;
      numFmts.push(`<numFmt numFmtId="${nextFmtId}" formatCode="${code}"/>`);
      cellXfs.push(`<xf numFmtId="${nextFmtId}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`);
      nextFmtId += 1;
    }

    return (
      `${DECL}<styleSheet xmlns="${NS_MAIN}">` +
      (numFmts.length ? `<numFmts count="${numFmts.length}">${numFmts.join("")}</numFmts>` : "") +
      '<fonts count="2">' +
      '<font><sz val="11"/><name val="Calibri"/></font>' +
      '<font><b/><sz val="11"/><name val="Calibri"/></font>' +
      "</fonts>" +
      '<fills count="3">' +
      '<fill><patternFill patternType="none"/></fill>' +
      '<fill><patternFill patternType="gray125"/></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFEFEFEF"/><bgColor indexed="64"/></patternFill></fill>' +
      "</fills>" +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      `<cellXfs count="${cellXfs.length}">${cellXfs.join("")}</cellXfs>` +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      "</styleSheet>"
    );
  }
}

/* ------------------------------------------------------------------ */
/* SHEETS                                                              */
/* ------------------------------------------------------------------ */

function sheetXml(
  dataset: Dataset,
  styles: StyleTable,
  esc: XmlEscaper,
  demoted: string[],
): string {
  assertDatasetIsRenderable(dataset);

  const rows: string[] = [];
  let rowNumber = 1;

  /**
   * ⚠️ THE NOTES GO IN THE SHEET, ABOVE THE HEADER. A caveat kept in a
   * separate "About" tab is a caveat nobody opens. The header row moves
   * down by however many notes there are, and the freeze pane below
   * follows it, so the table still scrolls under a fixed heading.
   */
  const noteLines = dataset.notes ?? [];
  for (const note of noteLines) {
    rows.push(
      `<row r="${rowNumber}"><c r="${cellRef(0, rowNumber)}" t="inlineStr"><is><t xml:space="preserve">${esc.text(note)}</t></is></c></row>`,
    );
    rowNumber += 1;
  }

  const headerRow = rowNumber;
  const headerStyle = styles.index("header");
  rows.push(
    `<row r="${headerRow}">` +
      dataset.columns
        .map(
          (c, i) =>
            `<c r="${cellRef(i, headerRow)}" s="${headerStyle}" t="inlineStr"><is><t xml:space="preserve">${esc.text(c.label)}</t></is></c>`,
        )
        .join("") +
      "</row>",
  );
  rowNumber += 1;

  for (const row of dataset.rows) {
    const cells: string[] = [];
    dataset.columns.forEach((column, i) => {
      const cell = renderCell(dataset, column, row);
      const ref = cellRef(i, rowNumber);
      switch (cell.kind) {
        case "blank":
          return;
        case "text": {
          if (cell.demoted) demoted.push(cell.demoted);
          cells.push(
            `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc.text(cell.text)}</t></is></c>`,
          );
          return;
        }
        case "boolean":
          cells.push(`<c r="${ref}" t="b"><v>${cell.value ? 1 : 0}</v></c>`);
          return;
        case "date": {
          const style = styles.index(cell.withTime ? "datetime" : "date");
          cells.push(`<c r="${ref}" s="${style}"><v>${dateSerial(cell.iso, cell.withTime)}</v></c>`);
          return;
        }
        case "number": {
          const style =
            column.kind === "integer"
              ? styles.index("integer")
              : column.kind === "money"
                ? styles.index(`money:${cell.decimals}`)
                : styles.index(`number:${cell.decimals}`);
          /** 🔴 THE LITERAL, VERBATIM. Never `Number(...)`. See values.ts. */
          cells.push(`<c r="${ref}" s="${style}"><v>${cell.literal}</v></c>`);
          return;
        }
      }
    });
    rows.push(`<row r="${rowNumber}">${cells.join("")}</row>`);
    rowNumber += 1;
  }

  const lastColumn = cellRef(Math.max(0, dataset.columns.length - 1), 1).replace("1", "");
  const cols = dataset.columns
    .map((c, i) => {
      const width = c.width ?? Math.min(50, Math.max(10, c.label.length + 4));
      return `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`;
    })
    .join("");

  /**
   * ⭐ FREEZE THE HEADER AND TURN ON THE FILTER. Two attributes that turn
   * a forty-thousand-row dump into something an accountant can actually
   * work in, and the reason a spreadsheet was asked for rather than a PDF.
   */
  const freeze =
    `<sheetView workbookViewId="0"><pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" ` +
    `activePane="bottomLeft" state="frozen"/></sheetView>`;

  const autoFilter =
    dataset.rows.length > 0
      ? `<autoFilter ref="A${headerRow}:${lastColumn}${headerRow + dataset.rows.length}"/>`
      : "";

  return (
    `${DECL}<worksheet xmlns="${NS_MAIN}">` +
    `<sheetViews>${freeze}</sheetViews>` +
    `<cols>${cols}</cols>` +
    `<sheetData>${rows.join("")}</sheetData>` +
    autoFilter +
    "</worksheet>"
  );
}

/* ------------------------------------------------------------------ */
/* THE WORKBOOK                                                        */
/* ------------------------------------------------------------------ */

export type XlsxResult = {
  readonly bytes: Uint8Array;
  readonly notes: readonly string[];
};

export function workbookToXlsx(
  workbook: Workbook,
  options: { readonly deflateRaw?: DeflateRaw } = {},
): XlsxResult {
  const esc = new XmlEscaper();
  const styles = new StyleTable();
  const demoted: string[] = [];
  const taken = new Set<string>();

  const sheets = workbook.datasets.map((dataset, i) => {
    const name = sheetName(dataset.title, taken);
    taken.add(name.toLowerCase());
    return { index: i + 1, name, xml: sheetXml(dataset, styles, esc, demoted) };
  });

  const workbookXml =
    `${DECL}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><sheets>` +
    sheets
      .map((s) => `<sheet name="${esc.attr(s.name)}" sheetId="${s.index}" r:id="rId${s.index}"/>`)
      .join("") +
    "</sheets></workbook>";

  const workbookRels =
    `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    sheets
      .map(
        (s) =>
          `<Relationship Id="rId${s.index}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${s.index}.xml"/>`,
      )
      .join("") +
    `<Relationship Id="rId${sheets.length + 1}" Type="${NS_REL}/styles" Target="styles.xml"/>` +
    "</Relationships>";

  const contentTypes =
    `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    sheets
      .map(
        (s) =>
          `<Override PartName="/xl/worksheets/sheet${s.index}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
      )
      .join("") +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    "</Types>";

  const rootRels =
    `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/>` +
    "</Relationships>";

  const encoder = new TextEncoder();
  const entries: ZipEntry[] = [
    { path: "[Content_Types].xml", bytes: encoder.encode(contentTypes) },
    { path: "_rels/.rels", bytes: encoder.encode(rootRels) },
    { path: "xl/workbook.xml", bytes: encoder.encode(workbookXml) },
    { path: "xl/_rels/workbook.xml.rels", bytes: encoder.encode(workbookRels) },
    /**
     * 🔴 STYLES LAST, AND THAT IS NOT COSMETIC. `StyleTable.index()` is
     * called while the sheets are being written, so the table is not
     * complete until every sheet has been rendered. Serialising it before
     * the loop above would emit a style table missing every format the
     * data needed, and Excel would show raw serial numbers where the
     * dates are.
     */
    { path: "xl/styles.xml", bytes: encoder.encode(styles.xml()) },
    ...sheets.map((s) => ({
      path: `xl/worksheets/sheet${s.index}.xml`,
      bytes: encoder.encode(s.xml),
    })),
  ];

  const notes: string[] = [];
  const stripNote = esc.note();
  if (stripNote) notes.push(stripNote);
  for (const note of new Set(demoted)) notes.push(note);

  return {
    bytes: buildZip(entries, { at: workbook.generatedAt, deflateRaw: options.deflateRaw }),
    notes,
  };
}
