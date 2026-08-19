/**
 * Ordence — ⭐⭐ JSON INTO THE SAME ROW STREAM
 * Version: v1.74.0-alpha · Wave 6
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE HARD PART OF JSON IS NOT PARSING IT
 * ══════════════════════════════════════════════════════════════════════
 * `JSON.parse` is one line. The work is deciding WHAT IS A ROW in a
 * document whose shape nobody agreed in advance, and the wrong answer
 * silently imports the wrong thing.
 *
 * The four shapes that actually arrive out of other systems:
 *
 *   ① `[ {...}, {...} ]`                         a bare array of records
 *   ② `{ "data": [ ... ] }`                      wrapped, any key name
 *   ③ `{ "rows": [...], "meta": {...} }`         wrapped, with siblings
 *   ④ `{"a":1}\n{"a":2}\n`                       JSON Lines
 *
 * 🔴 AND ONE MORE THAT MUST BE REFUSED RATHER THAN GUESSED: an object
 * with SEVERAL arrays of objects in it. Picking the longest would be a
 * coin toss between the invoices and their line items, and the wrong
 * choice imports line items as invoices — every one of which validates,
 * because they have amounts and dates too.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE COLUMNS ARE THE UNION OF EVERY RECORD'S KEYS, IN FIRST-SEEN ORDER
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE UNION, NOT THE FIRST RECORD'S KEYS. JSON omits nulls routinely,
 * so record 1 may have no `gstin` and record 400 may. Taking the first
 * record's keys as the header drops that column for the whole file and
 * the customer's GSTINs never arrive, with nothing reporting it.
 *
 * ⚠️ AND NESTED VALUES ARE FLATTENED WITH A DOTTED PATH — `address.city`
 * — rather than JSON-stringified into a cell. A cell containing
 * `{"city":"Pune"}` is a cell no mapping can use and no human can read in
 * a preview.
 */

import type { CsvRecord } from "../csv";

export class JsonReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonReadError";
  }
}

export type JsonDocument = {
  readonly headers: string[];
  readonly records: CsvRecord[];
  readonly notes: readonly string[];
};

/** How deep a nested object is flattened before it is left as text. */
const MAX_FLATTEN_DEPTH = 3;

function isRecordArray(value: unknown): value is Record<string, unknown>[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((v) => typeof v === "object" && v !== null && !Array.isArray(v))
  );
}

function flatten(
  value: unknown,
  prefix: string,
  depth: number,
  into: Map<string, string>,
): void {
  if (value === null || value === undefined) {
    into.set(prefix, "");
    return;
  }
  if (Array.isArray(value)) {
    /**
     * ⚠️ AN ARRAY IN A CELL IS JOINED, NOT INDEXED. `tags: ["a","b"]`
     * becomes `a, b` in one column. Expanding it to `tags.0`, `tags.1`
     * makes the header set depend on the longest record in the file, so
     * two exports of the same data produce different columns.
     */
    into.set(prefix, value.map((v) => (v === null ? "" : String(v))).join(", "));
    return;
  }
  if (typeof value === "object") {
    if (depth >= MAX_FLATTEN_DEPTH) {
      into.set(prefix, JSON.stringify(value));
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, depth + 1, into);
    }
    return;
  }
  if (typeof value === "boolean") {
    into.set(prefix, value ? "true" : "false");
    return;
  }
  into.set(prefix, String(value));
}

/** ④ JSON Lines, tried before the whole-document parse. */
function tryJsonLines(text: string): Record<string, unknown>[] | null {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length < 2) return null;
  const out: Record<string, unknown>[] = [];
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return null;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    out.push(parsed as Record<string, unknown>);
  }
  return out;
}

export function readJson(text: string): JsonDocument {
  const notes: string[] = [];

  let rows: Record<string, unknown>[] | null = tryJsonLines(text);
  if (rows) {
    notes.push(
      `That file is JSON Lines — one record per line — and was read as ${rows.length} records.`,
    );
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new JsonReadError(
        `That file is not valid JSON. ${err instanceof Error ? err.message : ""} Nothing has been ` +
          `read. If it came out of another system, check whether it was truncated by the download.`,
      );
    }

    if (isRecordArray(parsed)) {
      rows = parsed;
    } else if (Array.isArray(parsed)) {
      throw new JsonReadError(
        parsed.length === 0
          ? "That file is an empty list. There is nothing to import."
          : "That file is a list of values rather than a list of records. Each entry needs to be " +
            "an object with named fields, so that the columns have names to map.",
      );
    } else if (typeof parsed === "object" && parsed !== null) {
      const candidates = Object.entries(parsed as Record<string, unknown>).filter(([, v]) =>
        isRecordArray(v),
      );
      if (candidates.length === 1) {
        rows = candidates[0]![1] as Record<string, unknown>[];
        notes.push(`Records were read from the "${candidates[0]![0]}" list in that file.`);
      } else if (candidates.length === 0) {
        /**
         * ⚠️ A SINGLE OBJECT IS ONE RECORD, NOT AN ERROR. Somebody
         * testing an integration sends exactly this.
         */
        rows = [parsed as Record<string, unknown>];
        notes.push("That file holds a single record, and was read as one row.");
      } else {
        /** 🔴 REFUSED, NOT GUESSED. See the header. */
        throw new JsonReadError(
          `That file has ${candidates.length} lists of records in it ` +
            `(${candidates.map(([k]) => `"${k}"`).join(", ")}), and Ordence will not guess which ` +
            `one you meant. Importing the wrong one succeeds — line items validate as invoices — ` +
            `so it has to be your decision. Send a file containing only the list you want, or ` +
            `export it as CSV.`,
        );
      }
    } else {
      throw new JsonReadError("That file holds a single value rather than any records.");
    }
  }

  if (rows.length === 0) {
    throw new JsonReadError("That file has no records in it.");
  }

  /** ⭐ The union of every record's keys, in first-seen order. */
  const headers: string[] = [];
  const seen = new Set<string>();
  const flattened = rows.map((row) => {
    const cells = new Map<string, string>();
    flatten(row, "", 0, cells);
    for (const key of cells.keys()) {
      if (!seen.has(key)) {
        seen.add(key);
        headers.push(key);
      }
    }
    return cells;
  });

  const records: CsvRecord[] = [{ recordNumber: 1, cells: headers }];
  flattened.forEach((cells, index) => {
    records.push({
      recordNumber: index + 2,
      cells: headers.map((header) => cells.get(header) ?? ""),
    });
  });

  const sparse = headers.filter(
    (header) => flattened.filter((cells) => (cells.get(header) ?? "") !== "").length === 0,
  );
  if (sparse.length > 0) {
    notes.push(
      `${sparse.length} field${sparse.length === 1 ? " is" : "s are"} present in the file and ` +
        `empty in every record (${sparse.slice(0, 5).join(", ")}${sparse.length > 5 ? ", …" : ""}). ` +
        `They are shown so you can see what the source system sent, not because they carry data.`,
    );
  }

  return { headers, records, notes };
}
