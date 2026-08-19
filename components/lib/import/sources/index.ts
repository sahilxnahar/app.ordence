/**
 * Ordence — ⭐⭐⭐ ANY FORMAT, ONE ROW STREAM
 * Version: v1.74.0-alpha · Wave 6
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE FORMAT IS DETECTED FROM THE BYTES, NOT FROM THE FILE NAME
 * ══════════════════════════════════════════════════════════════════════
 * A file name is a claim by whoever renamed it. Three real cases:
 *
 *   • `customers.xlsx` that is actually an old `.xls` (an OLE compound
 *     document, not a zip) because somebody renamed it. Trusting the
 *     extension produces "not a valid zip"; reading the bytes produces
 *     the sentence that tells them to Save As.
 *   • `data.csv` that is a UTF-16 export from a Windows accounting
 *     package. Read as UTF-8 it is a column of `C\0o\0d\0e\0` — every
 *     header unmatched, every row failing, and nothing saying why.
 *   • `export.txt` that is a perfectly good CSV.
 *
 * ⭐ SO: MAGIC BYTES FIRST, THEN CONTENT SHAPE, AND THE EXTENSION ONLY AS
 * A TIE-BREAK. The extension is still used for ONE thing — telling the
 * customer their file was not what its name said, which is usually the
 * whole explanation.
 */

import { parseCsv, type CsvRecord } from "../csv";
import { readJson, JsonReadError } from "./json-read";
import { readTally, TallyReadError, type TallyView } from "./tally-read";
import { readXlsx, XlsxReadError } from "./xlsx-read";
import type { InflateRaw } from "./unzip";

export { readZip, ZipReadError, type InflateRaw } from "./unzip";
export { readXlsx, XlsxReadError } from "./xlsx-read";
export { readJson, JsonReadError } from "./json-read";
export { readTally, TallyReadError } from "./tally-read";

/**
 * ⚠️ THIS LIST IS CHECKED BY `scripts/check-import-sources.mjs` AGAINST
 * the reader that handles it, the detector that recognises it and the
 * test that opens one. Same discipline as `lib/export/registry.ts`: a
 * format declared in one place and enforced in another is the defect this
 * codebase keeps finding.
 */
export const IMPORT_SOURCE_FORMATS = ["csv", "xlsx", "json", "tally-xml"] as const;
export type ImportSourceFormat = (typeof IMPORT_SOURCE_FORMATS)[number];

export function isImportSourceFormat(value: unknown): value is ImportSourceFormat {
  return (IMPORT_SOURCE_FORMATS as readonly string[]).includes(value as string);
}

export const SOURCE_FORMAT_LABELS: Readonly<Record<ImportSourceFormat, string>> = Object.freeze({
  csv: "CSV",
  xlsx: "Excel",
  json: "JSON",
  "tally-xml": "Tally XML",
});

export class SourceReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceReadError";
  }
}

/* ------------------------------------------------------------------ */
/* DETECTION                                                           */
/* ------------------------------------------------------------------ */

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((byte, i) => bytes[i] === byte);
}

export type Detection = {
  readonly format: ImportSourceFormat;
  /** How it was decided. Shown when the extension disagreed. */
  readonly evidence: string;
};

export function detectFormat(bytes: Uint8Array, fileName?: string): Detection {
  /** `PK\x03\x04`. Every XLSX, DOCX and ODS begins here. */
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    return { format: "xlsx", evidence: "the file begins with a zip archive header" };
  }
  /** 🔴 The OLE compound-document signature: a real, old `.xls`. */
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    throw new SourceReadError(
      `${fileName ? `"${fileName}"` : "That file"} is an old Excel 97-2003 workbook (.xls), ` +
        `whatever its name says. Ordence reads the modern .xlsx format. Open it in Excel and ` +
        `choose File → Save As → Excel Workbook (.xlsx), then upload that.`,
    );
  }
  /** ⚠️ UTF-16, which reads as interleaved NULs and matches nothing. */
  if (startsWith(bytes, [0xff, 0xfe]) || startsWith(bytes, [0xfe, 0xff])) {
    throw new SourceReadError(
      `${fileName ? `"${fileName}"` : "That file"} is saved as UTF-16 text. Read as ordinary ` +
        `text every column heading comes out with an invisible character between each letter, so ` +
        `nothing matches and every row fails for a reason that is not in your data. Re-save it as ` +
        `CSV UTF-8, or as .xlsx.`,
    );
  }

  const head = new TextDecoder("utf-8").decode(bytes.subarray(0, 4096)).replace(/^﻿/, "").trimStart();

  if (head.startsWith("<")) {
    if (/<ENVELOPE|<TALLYMESSAGE|<VOUCHER/i.test(head)) {
      return { format: "tally-xml", evidence: "the file is XML containing a Tally envelope" };
    }
    throw new SourceReadError(
      `${fileName ? `"${fileName}"` : "That file"} is XML, and it is not a Tally export — Ordence ` +
        `has no way to know what its elements mean. Export it as CSV or Excel from whichever ` +
        `system produced it.`,
    );
  }

  if (head.startsWith("{") || head.startsWith("[")) {
    return { format: "json", evidence: "the file begins with a JSON object or list" };
  }

  return { format: "csv", evidence: "the file is delimited text" };
}

/* ------------------------------------------------------------------ */
/* THE ONE ENTRY POINT                                                 */
/* ------------------------------------------------------------------ */

export type SourceTable = {
  readonly format: ImportSourceFormat;
  /** ⭐ Exactly what `parseCsv` produces. Everything downstream is unchanged. */
  readonly records: CsvRecord[];
  /** Present for spreadsheets with more than one sheet. */
  readonly sheetNames?: readonly string[];
  readonly selectedSheet?: string;
  readonly notes: readonly string[];
};

export type ReadSourceOptions = {
  readonly fileName?: string;
  /** Which sheet, for a workbook with several. Defaults to the first with rows. */
  readonly sheet?: string;
  readonly tallyView?: TallyView;
  /** Node's `inflateRawSync`, supplied by the server. */
  readonly inflateRaw?: InflateRaw;
};

export function readSource(bytes: Uint8Array, options: ReadSourceOptions = {}): SourceTable {
  const detection = detectFormat(bytes, options.fileName);
  const notes: string[] = [];

  /**
   * ⭐ THE EXTENSION IS ONLY EVER USED TO EXPLAIN. When it disagrees with
   * the bytes, the bytes win and the customer is told — because "your
   * file is not what it says it is" is usually the entire explanation for
   * whatever they are about to see.
   */
  const extension = options.fileName?.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  const expected: Record<string, ImportSourceFormat> = {
    csv: "csv",
    txt: "csv",
    xlsx: "xlsx",
    json: "json",
    jsonl: "json",
    ndjson: "json",
    xml: "tally-xml",
  };
  if (extension && expected[extension] && expected[extension] !== detection.format) {
    notes.push(
      `That file is named .${extension} and ${detection.evidence}, so it was read as ` +
        `${SOURCE_FORMAT_LABELS[detection.format]}. If that is not what you expected, the file was ` +
        `probably renamed rather than saved in the format its name claims.`,
    );
  }

  switch (detection.format) {
    case "csv": {
      const text = new TextDecoder("utf-8").decode(bytes);
      const parsed = parseCsv(text);
      if (!parsed.ok) throw new SourceReadError(parsed.error);
      return { format: "csv", records: parsed.records, notes };
    }

    case "json": {
      try {
        const document = readJson(new TextDecoder("utf-8").decode(bytes));
        return { format: "json", records: document.records, notes: [...notes, ...document.notes] };
      } catch (err) {
        if (err instanceof JsonReadError) throw new SourceReadError(err.message);
        throw err;
      }
    }

    case "tally-xml": {
      try {
        const document = readTally(
          new TextDecoder("utf-8").decode(bytes),
          options.tallyView ?? "ledger-masters",
        );
        return {
          format: "tally-xml",
          records: document.records,
          notes: [...notes, ...document.notes],
        };
      } catch (err) {
        if (err instanceof TallyReadError) throw new SourceReadError(err.message);
        throw err;
      }
    }

    case "xlsx": {
      let document;
      try {
        document = readXlsx(bytes, options.inflateRaw);
      } catch (err) {
        if (err instanceof XlsxReadError) throw new SourceReadError(err.message);
        throw err;
      }

      const withRows = document.sheets.filter((sheet) => sheet.records.length > 0);
      if (withRows.length === 0) {
        throw new SourceReadError(
          `That workbook has ${document.sheets.length} sheet` +
            `${document.sheets.length === 1 ? "" : "s"} and no rows in any of them.`,
        );
      }

      const chosen = options.sheet
        ? withRows.find((sheet) => sheet.name === options.sheet)
        : withRows[0];

      if (!chosen) {
        throw new SourceReadError(
          `That workbook has no sheet called "${options.sheet}". It has: ` +
            `${withRows.map((s) => `"${s.name}"`).join(", ")}.`,
        );
      }

      const extra = [...notes, ...document.notes];
      if (withRows.length > 1) {
        /**
         * ⚠️ NAMED, NOT SILENTLY IGNORED. A workbook with "Customers",
         * "Vendors" and "Items" imported as whichever tab happened to be
         * first is how somebody's vendor list becomes their customer list.
         */
        extra.push(
          `That workbook has ${withRows.length} sheets with data in them ` +
            `(${withRows.map((s) => `"${s.name}"`).join(", ")}). "${chosen.name}" was read. ` +
            `Choose a different sheet above if that is the wrong one.`,
        );
      }

      return {
        format: "xlsx",
        records: chosen.records,
        sheetNames: withRows.map((s) => s.name),
        selectedSheet: chosen.name,
        notes: extra,
      };
    }
  }
}
