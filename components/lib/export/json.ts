/**
 * Ordence — ⭐ JSON, AND WHY MONEY IS A STRING IN IT
 * Version: v1.73.0-alpha · Wave 5
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 `JSON.parse("12345678901234567")` IS 12345678901234568
 * ══════════════════════════════════════════════════════════════════════
 * JSON numbers are IEEE-754 doubles in every mainstream parser. An amount
 * held as a `bigint` and written as a bare JSON number comes back changed
 * on the other side, in a file whose whole purpose is that the other side
 * can rely on it.
 *
 * ⭐ SO MONEY IS EMITTED AS THREE FIELDS, NOT ONE:
 *
 *     "total": { "minor": "123456789", "currency": "INR", "decimal": "1234567.89" }
 *
 * `minor` is the integer as a STRING, exact and machine-safe. `currency`
 * is what it is denominated in. `decimal` is the same value scaled by
 * THIS currency's exponent, for a human reading the file. A consumer that
 * wants exactness parses `minor`; one that wants convenience reads
 * `decimal`; nobody has to guess whether 100 means one rupee or a hundred.
 *
 * ⚠️ AND THE SCHEMA IS IN THE FILE. `columns` carries the kind of every
 * field, so a consumer can tell a code from a number without inspecting
 * values — which is how `0012345` gets read back as 12345 by somebody
 * else's importer.
 */

import { formatMinorPlain, minorUnitExponent } from "@/lib/fx/currency";
import type { Dataset, Workbook } from "./types";
import { assertDatasetIsRenderable, renderCell } from "./values";

export type JsonExport = {
  readonly format: "ordence.export/1";
  readonly title: string;
  readonly generatedAt: string;
  readonly context: Record<string, string>;
  readonly datasets: readonly {
    readonly key: string;
    readonly title: string;
    readonly notes: readonly string[];
    readonly columns: readonly {
      readonly key: string;
      readonly label: string;
      readonly kind: string;
      readonly currencyKey?: string;
    }[];
    readonly rowCount: number;
    readonly rows: readonly Record<string, unknown>[];
  }[];
};

function datasetToJson(dataset: Dataset): JsonExport["datasets"][number] {
  assertDatasetIsRenderable(dataset);

  const rows = dataset.rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const column of dataset.columns) {
      const cell = renderCell(dataset, column, row);
      if (cell.kind === "blank") {
        out[column.key] = null;
        continue;
      }
      if (column.kind === "money") {
        /**
         * ⚠️ THE MONEY BRANCH RE-READS THE RAW VALUE rather than parsing
         * the rendered text back. Round-tripping through a decimal string
         * would be correct and it would also be a second implementation
         * of the same arithmetic, which is one more place for the two to
         * drift.
         */
        const raw = row[column.key];
        const minor = typeof raw === "bigint" ? raw : BigInt(String(raw));
        const currency = String(row[column.currencyKey!]).trim().toUpperCase();
        out[column.key] = {
          minor: minor.toString(),
          currency,
          decimal: formatMinorPlain(minor, currency),
          exponent: minorUnitExponent(currency),
        };
        continue;
      }
      switch (cell.kind) {
        case "number":
          /**
           * ⚠️ NON-MONEY NUMBERS ARE EMITTED AS JSON NUMBERS, and an
           * integer beyond 2^53 has already been demoted to `text` by
           * `values.ts`, so it arrives here as a string and stays exact.
           */
          out[column.key] = Number(cell.literal);
          break;
        case "boolean":
          out[column.key] = cell.value;
          break;
        case "date":
          out[column.key] = cell.iso;
          break;
        case "text":
          out[column.key] = cell.text;
          break;
      }
    }
    return out;
  });

  return {
    key: dataset.key,
    title: dataset.title,
    notes: [...(dataset.notes ?? [])],
    columns: dataset.columns.map((c) => ({
      key: c.key,
      label: c.label,
      kind: c.kind,
      ...(c.currencyKey ? { currencyKey: c.currencyKey } : {}),
    })),
    rowCount: dataset.rows.length,
    rows,
  };
}

export function workbookToJson(workbook: Workbook): JsonExport {
  return {
    format: "ordence.export/1",
    title: workbook.title,
    generatedAt: workbook.generatedAt.toISOString(),
    context: { ...(workbook.context ?? {}) },
    datasets: workbook.datasets.map(datasetToJson),
  };
}

export function workbookToJsonBytes(workbook: Workbook): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(workbookToJson(workbook), null, 2)}\n`);
}
