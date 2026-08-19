/**
 * Ordence — ⭐⭐⭐ THE ONE PLACE A STORED VALUE BECOMES AN EXPORTED CELL
 * Version: v1.73.0-alpha · Wave 5
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 EVERY WRITER GOES THROUGH HERE, AND NONE OF THEM MAY DIVIDE
 * ══════════════════════════════════════════════════════════════════════
 * Six formats × "just divide by 100" is six chances to be wrong by a
 * factor of ten in Kuwait and a factor of a hundred in Japan. There is
 * one conversion in this file, it is `formatMinorPlain` from
 * `lib/fx/currency.ts`, and it is string arithmetic on a `bigint`.
 *
 * ⚠️ AND NO `Number()` ON A MONEY VALUE ANYWHERE. `Number(9007199254740993n)`
 * is 9007199254740992. For INR that is a discrepancy of one paisa on a
 * ninety-thousand-crore figure, which nobody would notice and which would
 * still be a ledger that does not foot. `moneyCell` below never calls it;
 * it produces a DECIMAL STRING and hands the string to the writer.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ AND WHERE THE STRING STOPS BEING ENOUGH, IT SAYS SO
 * ══════════════════════════════════════════════════════════════════════
 * XLSX stores a number as text in XML and Excel reads it into an IEEE-754
 * double. Our string is exact; Excel's double is not, above 2^53 scaled
 * units. `exceedsDoublePrecision` detects that case and the XLSX writer
 * demotes the cell to text rather than writing a number Excel will round
 * in silence — and records a note saying which cells were demoted.
 *
 * This is the difference between a limitation and a bug: both lose
 * precision, only one of them tells you.
 */

import {
  formatMinorPlain,
  minorUnitExponent,
  normaliseCurrencyCode,
  isKnownCurrency,
} from "@/lib/fx/currency";
import type { CellValue, Column, Dataset, Row } from "./types";

export class ExportCellError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportCellError";
  }
}

/**
 * ⭐ THE RENDERED CELL. `kind` is what the FORMAT should make of it, not
 * what the column declared — a money value too large for a double comes
 * back as `text` with `demoted: true`, and the writer does not have to
 * know why.
 */
export type Cell =
  | { readonly kind: "blank" }
  | { readonly kind: "text"; readonly text: string; readonly demoted?: string }
  | {
      readonly kind: "number";
      /** ⚠️ A DECIMAL STRING, NOT A `number`. Writers emit it verbatim. */
      readonly literal: string;
      /** Decimals this value carries. Drives the XLSX number format. */
      readonly decimals: number;
      /** ISO-4217 code when this came from a money column. */
      readonly currency?: string;
      readonly text: string;
    }
  | { readonly kind: "boolean"; readonly value: boolean; readonly text: string }
  | {
      readonly kind: "date";
      /** ISO `YYYY-MM-DD` or full ISO-8601. */
      readonly iso: string;
      readonly withTime: boolean;
      readonly text: string;
    };

/**
 * 🔴 THE CEILING. Beyond this a JS double cannot represent every integer,
 * so a spreadsheet that reads our exact decimal string into a double
 * starts silently rounding. 2^53 - 1.
 */
export const MAX_EXACT_DOUBLE = 9007199254740991n;

export function exceedsDoublePrecision(minor: bigint): boolean {
  return minor > MAX_EXACT_DOUBLE || minor < -MAX_EXACT_DOUBLE;
}

/**
 * ⚠️ REFUSES RATHER THAN GUESSES. A money column with no `currencyKey`,
 * or a row whose currency cell is empty or unknown, stops the export.
 *
 * 🔴 THE ALTERNATIVE WAS CONSIDERED AND REJECTED: falling back to the
 * workspace's functional currency. It would work for the 99% of Indian
 * workspaces whose every figure is INR and it would mislabel exactly the
 * rows that matter — the foreign-currency invoices — as rupees, in a
 * file that leaves the product and gets filed.
 */
function currencyFor(dataset: Dataset, column: Column, row: Row): string {
  if (!column.currencyKey) {
    throw new ExportCellError(
      `Column "${column.key}" in dataset "${dataset.key}" is money and declares no currencyKey. ` +
        `An amount without a currency is not an amount. Add a currency column to the dataset and ` +
        `name it on the money column.`,
    );
  }
  const raw = row[column.currencyKey];
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new ExportCellError(
      `Row in dataset "${dataset.key}" has a value in money column "${column.key}" but its ` +
        `currency column "${column.currencyKey}" is empty. Nothing has been exported. ` +
        `Ordence will not label an amount with a currency it was not given.`,
    );
  }
  const code = normaliseCurrencyCode(raw);
  if (!isKnownCurrency(code)) {
    throw new ExportCellError(
      `"${raw}" in currency column "${column.currencyKey}" of dataset "${dataset.key}" is not a ` +
        `currency Ordence knows. Its minor unit is unknown, and assuming two decimal places is ` +
        `wrong by a factor of ten for the Gulf dinars.`,
    );
  }
  return code;
}

function toBigInt(value: CellValue, dataset: Dataset, column: Column): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new ExportCellError(
        `Money column "${column.key}" in dataset "${dataset.key}" received ${value}, which is not ` +
          `a whole number of minor units. Money is held as an integer count of the smallest unit; ` +
          `a fraction of a paisa is a rounding error that has already happened somewhere upstream.`,
      );
    }
    return BigInt(value);
  }
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }
  throw new ExportCellError(
    `Money column "${column.key}" in dataset "${dataset.key}" received ${JSON.stringify(value)}. ` +
      `Expected a whole number of minor units.`,
  );
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parseDate(value: CellValue, dataset: Dataset, column: Column): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new ExportCellError(
        `Column "${column.key}" in dataset "${dataset.key}" holds an invalid Date.`,
      );
    }
    return value;
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new ExportCellError(
        `Column "${column.key}" in dataset "${dataset.key}" holds "${value}", which is not a date.`,
      );
    }
    return parsed;
  }
  throw new ExportCellError(
    `Column "${column.key}" in dataset "${dataset.key}" expected a date and received ` +
      `${JSON.stringify(value)}.`,
  );
}

/**
 * ⭐⭐⭐ THE FUNCTION. Every writer calls this and nothing else.
 */
export function renderCell(dataset: Dataset, column: Column, row: Row): Cell {
  const value = row[column.key];

  if (value === null || value === undefined || value === "") {
    /**
     * ⚠️ EMPTY STRING IS BLANK AND `0` IS NOT. A blank cell and a zero
     * are different facts — "no invoices this month" and "invoices
     * totalling nothing" — and every format below distinguishes them.
     */
    if (value === "" && (column.kind === "text" || column.kind === "code")) {
      return { kind: "text", text: "" };
    }
    return { kind: "blank" };
  }

  switch (column.kind) {
    case "text":
    case "code":
      return { kind: "text", text: String(value) };

    case "boolean":
      return {
        kind: "boolean",
        value: Boolean(value),
        text: value ? "Yes" : "No",
      };

    case "integer": {
      const n =
        typeof value === "bigint"
          ? value
          : toBigInt(typeof value === "number" ? Math.trunc(value) : value, dataset, column);
      if (exceedsDoublePrecision(n)) {
        return {
          kind: "text",
          text: n.toString(),
          demoted:
            `${column.key} exceeds the largest integer a spreadsheet can hold exactly ` +
            `(2^53-1) and was written as text so no digit is lost.`,
        };
      }
      return { kind: "number", literal: n.toString(), decimals: 0, text: n.toString() };
    }

    case "number": {
      const decimals = column.decimals ?? 2;
      const literal =
        typeof value === "bigint"
          ? value.toString()
          : typeof value === "number"
            ? value.toFixed(decimals)
            : String(value);
      return { kind: "number", literal, decimals, text: literal };
    }

    case "money": {
      const currency = currencyFor(dataset, column, row);
      const minor = toBigInt(value, dataset, column);
      /** 🔴 STRING ARITHMETIC. No division anywhere in this branch. */
      const literal = formatMinorPlain(minor, currency);
      const decimals = minorUnitExponent(currency);
      if (exceedsDoublePrecision(minor)) {
        return {
          kind: "text",
          text: `${literal} ${currency}`,
          demoted:
            `${column.key} holds ${literal} ${currency}, which is beyond the range a ` +
            `spreadsheet holds exactly. It was written as text so the figure is not rounded ` +
            `by the program that opens it.`,
        };
      }
      return { kind: "number", literal, decimals, currency, text: literal };
    }

    case "date": {
      const d = parseDate(value, dataset, column);
      const iso = isoDate(d);
      return { kind: "date", iso, withTime: false, text: iso };
    }

    case "datetime": {
      const d = parseDate(value, dataset, column);
      const iso = d.toISOString();
      return { kind: "date", iso, withTime: true, text: iso };
    }
  }
}

/** Plain text for the formats that have only text: CSV, PDF, DOCX. */
export function cellText(cell: Cell): string {
  return cell.kind === "blank" ? "" : cell.text;
}

/**
 * ⚠️ VALIDATE BEFORE A SINGLE BYTE IS WRITTEN. A money column whose
 * currency column is missing must stop the export at row 1, not at row
 * 40,000 with half a file already streamed to the customer.
 */
export function assertDatasetIsRenderable(dataset: Dataset): void {
  const keys = new Set(dataset.columns.map((c) => c.key));
  for (const column of dataset.columns) {
    if (column.kind !== "money") continue;
    if (!column.currencyKey) {
      throw new ExportCellError(
        `Column "${column.key}" in dataset "${dataset.key}" is money and declares no currencyKey.`,
      );
    }
    if (!keys.has(column.currencyKey)) {
      throw new ExportCellError(
        `Column "${column.key}" in dataset "${dataset.key}" names currency column ` +
          `"${column.currencyKey}", which is not a column of this dataset.`,
      );
    }
  }
}
