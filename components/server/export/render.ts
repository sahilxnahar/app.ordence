import "server-only";

/**
 * Ordence — ⭐⭐⭐ THE ONE DOOR EVERY EXPORT GOES THROUGH
 * Version: v1.73.0-alpha · Wave 5
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THERE IS A SINGLE FUNCTION AND NOT SIX ROUTES
 * ══════════════════════════════════════════════════════════════════════
 * The same reason `server/ai/chat.ts` is a single door in wave 4: a rule
 * enforced at one call site is a rule, and a rule enforced at six is a
 * rule with five exceptions waiting to be written. Everything that must
 * be true of an export — money never divided, the notes carried out with
 * the file, the log written, the size bounded — is true here or it is not
 * true at all.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ `node:zlib` IS IMPORTED HERE AND NOWHERE UNDER `lib/`
 * ══════════════════════════════════════════════════════════════════════
 * `lib/export/zip.ts` takes a `deflateRaw` function and stores entries
 * uncompressed without one, so the whole writer stack stays pure and
 * runnable in a test, in the edge runtime and in a script. This file is
 * the only place that knows it is on Node.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE SIZE CEILING IS A REFUSAL, NOT A TRUNCATION
 * ══════════════════════════════════════════════════════════════════════
 * A serverless response has a hard body limit and an export that exceeds
 * it fails somewhere in the platform, after the query has run and usually
 * with a message about a gateway. Checking the ROW COUNT before rendering
 * turns that into a sentence naming the number of rows and the narrower
 * range that would work.
 */

import { deflateRawSync } from "node:zlib";

import { datasetToCsv, csvBytes } from "@/lib/export/csv";
import { workbookToDocx } from "@/lib/export/docx";
import { workbookToJsonBytes } from "@/lib/export/json";
import { workbookToPdf } from "@/lib/export/pdf";
import { datasetToTallyXml, tallyBytes } from "@/lib/export/tally";
import {
  FORMAT_DESCRIPTORS,
  availabilityForWorkbook,
  type ExportFormat,
} from "@/lib/export/registry";
import type { RenderedExport, Workbook } from "@/lib/export/types";
import { workbookToXlsx } from "@/lib/export/xlsx";
import { buildZip } from "@/lib/export/zip";

const deflateRaw = (input: Uint8Array): Uint8Array =>
  new Uint8Array(deflateRawSync(input));

/**
 * 🔴 THE CEILING, AND IT IS DELIBERATELY LOW ENOUGH TO BE HIT. Two
 * hundred thousand rows of a fifteen-column register is roughly 40MB of
 * XLSX before compression, and the whole workbook is built in memory
 * because a ZIP central directory cannot be written until every entry's
 * size is known. A number that is never reached is not a limit, it is a
 * comment.
 */
export const MAX_EXPORT_ROWS = 200_000;

export class ExportTooLargeError extends Error {
  constructor(rows: number) {
    super(
      `This export is ${rows.toLocaleString("en-IN")} rows, which is beyond the ` +
        `${MAX_EXPORT_ROWS.toLocaleString("en-IN")} Ordence will build in one file. Nothing has ` +
        `been generated. Narrow the date range, or export one month at a time — a file that is ` +
        `cut off part-way through and still opens is the outcome this refusal prevents.`,
    );
    this.name = "ExportTooLargeError";
  }
}

export class ExportFormatUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportFormatUnavailableError";
  }
}

/** `Sales register` + 2026-08-19 → `sales-register-2026-08-19`. */
export function exportSlug(title: string, at: Date): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    /**
     * ⚠️ NON-LATIN TITLES DO NOT SURVIVE `[^a-z0-9]`, and a workspace
     * whose report is named in Hindi would download `-2026-08-19.csv`.
     * The fallback is the reason the `|| "export"` is there and the
     * reason it is not silent in review.
     */
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug || "export"}-${at.toISOString().slice(0, 10)}`;
}

export function countRows(workbook: Workbook): number {
  return workbook.datasets.reduce((total, d) => total + d.rows.length, 0);
}

/**
 * ⭐⭐⭐ RENDER. Never touches the database, never reads a clock; the
 * workbook carries its own `generatedAt` so the same input renders to the
 * same bytes and the tests can say so.
 */
export function renderExport(workbook: Workbook, format: ExportFormat): RenderedExport {
  const verdict = availabilityForWorkbook(workbook, format);
  if (!verdict.available) {
    throw new ExportFormatUnavailableError(
      verdict.reason ?? `This data cannot be exported as ${FORMAT_DESCRIPTORS[format].label}.`,
    );
  }

  const rows = countRows(workbook);
  if (rows > MAX_EXPORT_ROWS) throw new ExportTooLargeError(rows);

  const descriptor = FORMAT_DESCRIPTORS[format];
  const notes: string[] = [];
  if (verdict.caution) notes.push(verdict.caution);

  switch (format) {
    case "json":
      return {
        bytes: workbookToJsonBytes(workbook),
        extension: "json",
        mediaType: descriptor.mediaType,
        notes,
      };

    case "xlsx": {
      const result = workbookToXlsx(workbook, { deflateRaw });
      return {
        bytes: result.bytes,
        extension: "xlsx",
        mediaType: descriptor.mediaType,
        notes: [...notes, ...result.notes],
      };
    }

    case "docx": {
      const result = workbookToDocx(workbook, { deflateRaw });
      return {
        bytes: result.bytes,
        extension: "docx",
        mediaType: descriptor.mediaType,
        notes: [...notes, ...result.notes],
      };
    }

    case "pdf": {
      const result = workbookToPdf(workbook);
      return {
        bytes: result.bytes,
        extension: "pdf",
        mediaType: descriptor.mediaType,
        notes: [...notes, ...result.notes],
      };
    }

    case "csv": {
      /**
       * ⚠️ ONE DATASET IS A CSV. TWO IS A ZIP OF CSVs, NOT A CSV WITH THE
       * SECOND TABLE APPENDED UNDER A BLANK ROW. Every importer in the
       * world reads that second table as continuation rows of the first,
       * with the wrong number of columns, and reports a mapping error the
       * customer cannot diagnose.
       */
      const parts = workbook.datasets.map((dataset) => {
        const result = datasetToCsv(dataset);
        notes.push(...result.notes);
        return { dataset, result };
      });

      if (parts.length === 1) {
        return {
          bytes: csvBytes(parts[0]!.result.text),
          extension: "csv",
          mediaType: descriptor.mediaType,
          notes,
        };
      }

      const bytes = buildZip(
        parts.map((p) => ({
          path: `${exportSlug(p.dataset.title, workbook.generatedAt)}.csv`,
          bytes: csvBytes(p.result.text),
        })),
        { at: workbook.generatedAt, deflateRaw },
      );
      return { bytes, extension: "zip", mediaType: "application/zip", notes };
    }

    case "tally-xml": {
      const companyName = workbook.context?.["Tally company"] ?? workbook.context?.["Workspace"];
      if (!companyName) {
        /**
         * 🔴 THE COMPANY NAME IS THE SINGLE MOST CONSEQUENTIAL ELEMENT IN
         * A TALLY FILE — `lib/tally/envelope.ts` says so in its own
         * header. Importing into the wrong company is not an error Tally
         * reports; it is a company's books with somebody else's ledgers
         * in them. Guessing it is not acceptable.
         */
        throw new ExportFormatUnavailableError(
          `A Tally export must name the company exactly as it is typed in Tally, and this export ` +
            `was not given one. Importing into the wrong company puts these ledgers into somebody ` +
            `else's books, and Tally does not warn about it.`,
        );
      }

      const documents = workbook.datasets.map((dataset) => ({
        path: `${exportSlug(dataset.title, workbook.generatedAt)}.xml`,
        bytes: tallyBytes(datasetToTallyXml(dataset, { companyName })),
      }));

      if (documents.length === 1) {
        return {
          bytes: documents[0]!.bytes,
          extension: "xml",
          mediaType: descriptor.mediaType,
          notes,
        };
      }
      return {
        bytes: buildZip(documents, { at: workbook.generatedAt, deflateRaw }),
        extension: "zip",
        mediaType: "application/zip",
        notes,
      };
    }
  }
}

export function exportFileName(workbook: Workbook, rendered: RenderedExport): string {
  return `${exportSlug(workbook.title, workbook.generatedAt)}.${rendered.extension}`;
}
