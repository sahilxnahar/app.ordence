/**
 * Ordence — ⭐⭐⭐ THE FORMAT REGISTRY, AND THE THING IT IS GUARDING
 * Version: v1.73.0-alpha · Wave 5
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE DEFECT THIS FILE EXISTS TO PREVENT IS THE ONE THIS CODEBASE
 *    KEEPS FINDING: DECLARED IN ONE PLACE, ENFORCED IN ANOTHER, AND THE
 *    TWO DRIFT.
 * ══════════════════════════════════════════════════════════════════════
 * A format lives in FOUR places at once:
 *
 *   ① here, as the thing the picker offers
 *   ② `server/export/render.ts`, as the writer that produces bytes
 *   ③ SQL `data_exports.format` CHECK, as a value the log will accept
 *   ④ the test matrix, as a format somebody has actually opened
 *
 * Add a format to ① and forget ③ and every export in that format fails at
 * the INSERT — after the file has been generated and streamed, so the
 * customer has their download and the log has no record of it. That is
 * precisely the "the audit trail is missing exactly the interesting rows"
 * failure, and it would be nobody's fault and completely silent.
 *
 * ⭐ `scripts/check-export-registry.mjs` reads all four and fails the
 * build when they disagree. This file is ①.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ AVAILABILITY IS PER DATASET, NOT GLOBAL
 * ══════════════════════════════════════════════════════════════════════
 * "Export should be in all format" is right for the five universal ones.
 * It is not right for Tally XML, which is an instruction to another
 * accounting system and needs a mapping this data may not have. Offering
 * it anyway and failing at the click is a worse answer than greying it
 * out with the reason attached — which is what `availability()` returns
 * and what `components/export/export-dialog.tsx` displays.
 */

import type { Dataset, Workbook } from "./types";
import { tallyRefusal } from "./tally";

export const EXPORT_FORMATS = [
  "csv",
  "xlsx",
  "json",
  "pdf",
  "docx",
  "tally-xml",
] as const;

export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export function isExportFormat(value: unknown): value is ExportFormat {
  return (EXPORT_FORMATS as readonly string[]).includes(value as string);
}

export type FormatDescriptor = {
  readonly id: ExportFormat;
  readonly label: string;
  /** Extension for a SINGLE dataset. A multi-dataset CSV becomes a zip. */
  readonly extension: string;
  readonly mediaType: string;
  /** ⭐ True when the format keeps a cell's type. Drives the picker's advice. */
  readonly keepsTypes: boolean;
  /** 🔴 False for PDF only. See `lib/export/pdf-fonts.ts`. */
  readonly unicodeSafe: boolean;
  /** True when several datasets fit in one file without zipping. */
  readonly multiDataset: boolean;
  /** One sentence, shown under the format in the picker. */
  readonly summary: string;
};

export const FORMAT_DESCRIPTORS: Readonly<Record<ExportFormat, FormatDescriptor>> =
  Object.freeze({
    csv: {
      id: "csv",
      label: "CSV",
      extension: "csv",
      mediaType: "text/csv; charset=utf-8",
      keepsTypes: false,
      unicodeSafe: true,
      multiDataset: false,
      summary:
        "Opens anywhere and imports into anything. Has no cell types, so a spreadsheet will " +
        "strip leading zeroes from invoice numbers and shorten long codes.",
    },
    xlsx: {
      id: "xlsx",
      label: "Excel",
      extension: "xlsx",
      mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      keepsTypes: true,
      unicodeSafe: true,
      multiDataset: true,
      summary:
        "Keeps codes as text, dates as dates and money at the right number of decimals for its " +
        "currency. The header stays frozen and the filter is already on.",
    },
    json: {
      id: "json",
      label: "JSON",
      extension: "json",
      mediaType: "application/json; charset=utf-8",
      keepsTypes: true,
      unicodeSafe: true,
      multiDataset: true,
      summary:
        "For another system to read. Money carries its exact minor-unit integer as a string, its " +
        "currency and its decimal form, so nothing is rounded in transit.",
    },
    pdf: {
      id: "pdf",
      label: "PDF",
      extension: "pdf",
      mediaType: "application/pdf",
      keepsTypes: false,
      unicodeSafe: false,
      multiDataset: true,
      summary:
        "For printing and for sending to somebody who should not edit it. Latin script only — " +
        "names in Indian scripts appear as question marks. Use Word for those.",
    },
    docx: {
      id: "docx",
      label: "Word",
      extension: "docx",
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      keepsTypes: false,
      unicodeSafe: true,
      multiDataset: true,
      summary:
        "A printable document you can still edit, in every script. This is the right choice when " +
        "the data has names in Hindi, Tamil, Bengali or any other Indian language.",
    },
    "tally-xml": {
      id: "tally-xml",
      label: "Tally XML",
      extension: "xml",
      mediaType: "application/xml; charset=utf-8",
      keepsTypes: true,
      unicodeSafe: true,
      multiDataset: false,
      summary:
        "An import file for Tally. Only offered where the data carries a real Tally mapping, " +
        "because a file that imports to the wrong ledger is worse than one that will not import.",
    },
  });

export type Availability = {
  readonly format: ExportFormat;
  readonly available: boolean;
  /** Present when unavailable. Shown to the person, not logged and hidden. */
  readonly reason?: string;
  /** Present when available but lossy. The picker shows it as a caution. */
  readonly caution?: string;
};

/**
 * ⭐ WHAT THIS DATASET CAN BE EXPORTED AS, AND WHAT IT COSTS.
 */
export function availability(dataset: Dataset, format: ExportFormat): Availability {
  if (format === "tally-xml") {
    const refusal = tallyRefusal(dataset);
    return refusal
      ? { format, available: false, reason: refusal }
      : { format, available: true };
  }

  const cautions: string[] = [];

  if (format === "csv" || format === "pdf" || format === "docx") {
    const codes = dataset.columns.filter((c) => c.kind === "code");
    if (format === "csv" && codes.length > 0) {
      cautions.push(
        `${codes.map((c) => c.label).join(", ")} will be altered by a spreadsheet on open — ` +
          `leading zeroes lost, long codes shortened. Excel keeps them intact.`,
      );
    }
  }

  if (format === "pdf") {
    const wide = dataset.columns.length > 12;
    if (wide) {
      cautions.push(
        `${dataset.columns.length} columns is more than fits comfortably on a printed page; long ` +
          `values will wrap and very long ones are shown with an ellipsis. Excel keeps every ` +
          `character.`,
      );
    }
  }

  return {
    format,
    available: true,
    ...(cautions.length > 0 ? { caution: cautions.join(" ") } : {}),
  };
}

export function availabilityForWorkbook(
  workbook: Workbook,
  format: ExportFormat,
): Availability {
  /**
   * ⚠️ A WORKBOOK IS AVAILABLE IN A FORMAT ONLY IF EVERY DATASET IS. A
   * partial export that silently omits the second sheet is the failure
   * mode; refusing with the reason from the dataset that cannot is the
   * honest one.
   */
  const perDataset = workbook.datasets.map((d) => availability(d, format));
  const blocked = perDataset.find((a) => !a.available);
  if (blocked) return blocked;

  if (!FORMAT_DESCRIPTORS[format].multiDataset && workbook.datasets.length > 1) {
    return {
      format,
      available: true,
      caution:
        `This export has ${workbook.datasets.length} tables and ${FORMAT_DESCRIPTORS[format].label} ` +
        `holds one per file, so you will receive a zip with ${workbook.datasets.length} files in it.`,
    };
  }

  const cautions = perDataset.map((a) => a.caution).filter((c): c is string => Boolean(c));
  return {
    format,
    available: true,
    ...(cautions.length > 0 ? { caution: [...new Set(cautions)].join(" ") } : {}),
  };
}

/** Every format, with its verdict for this workbook. Drives the picker. */
export function formatOptions(workbook: Workbook): readonly Availability[] {
  return EXPORT_FORMATS.map((format) => availabilityForWorkbook(workbook, format));
}
