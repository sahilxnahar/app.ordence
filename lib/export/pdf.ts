/**
 * Ordence — ⭐⭐⭐ PDF, WRITTEN BY HAND, PAGINATED, AND HONEST ABOUT SCRIPT
 * Version: v1.73.0-alpha · Wave 5
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THERE IS NO PDF LIBRARY IN `package.json`
 * ══════════════════════════════════════════════════════════════════════
 * The two obvious candidates are a ~2MB runtime with a font stack, and an
 * AGPL-licensed renderer. This product's build is already OOM-killed at
 * 8GB before either, and the AGPL one would need a lawyer, not an npm
 * install. What a register PDF actually needs is: base-14 Helvetica, a
 * table, page breaks, a repeated heading and a page number. That is this
 * file.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE LIMITATION, STATED BEFORE THE DOWNLOAD AND NOT AFTER
 * ══════════════════════════════════════════════════════════════════════
 * Base-14 fonts are WinAnsi. No Devanagari, no Tamil, no ₹. A name in an
 * Indian script comes out as question marks, and pretending otherwise
 * would be the exact defect pattern this codebase keeps finding: built,
 * shipped, quietly wrong.
 *
 * So: `pdf-fonts.ts` counts every character it could not draw, this file
 * names the COLUMNS they were in, and the result carries a note that
 * `server/export/log.ts` persists and the picker shows. DOCX carries the
 * same table in full Unicode.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ CELLS WRAP, THEY DO NOT CLIP
 * ══════════════════════════════════════════════════════════════════════
 * A clipped cell is a lie the reader cannot detect. Wrapping to a bounded
 * number of lines and then, only then, truncating with an ellipsis AND
 * counting it, is a loss the reader can see and the note can name.
 */

import type { Dataset, Workbook } from "./types";
import { assertDatasetIsRenderable, cellText, renderCell } from "./values";
import { encodeWinAnsi, textWidth, type PdfFont } from "./pdf-fonts";

/* ------------------------------------------------------------------ */
/* PAGE GEOMETRY — A4 LANDSCAPE, IN POINTS                             */
/* ------------------------------------------------------------------ */

const PAGE_W = 842;
const PAGE_H = 595;
const MARGIN = 32;
const CONTENT_W = PAGE_W - MARGIN * 2;

const TITLE_SIZE = 15;
const HEADING_SIZE = 11;
const BODY_SIZE = 8;
const NOTE_SIZE = 7;
const LINE_HEIGHT = 10;
const CELL_PAD = 3;
const MAX_CELL_LINES = 4;

/* ------------------------------------------------------------------ */
/* PDF PRIMITIVES                                                      */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ EVERY BYTE ABOVE 126 IS WRITTEN AS AN OCTAL ESCAPE. A raw 0x80 in a
 * PDF literal string is legal but survives exactly as long as nothing in
 * the pipeline decides the file is text. Octal is unambiguous.
 */
function pdfString(text: string): { literal: string; unprintable: number } {
  const { bytes, unprintable } = encodeWinAnsi(text);
  let out = "";
  for (const byte of bytes) {
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) {
      out += `\\${String.fromCharCode(byte)}`;
    } else if (byte < 32 || byte > 126) {
      out += `\\${byte.toString(8).padStart(3, "0")}`;
    } else {
      out += String.fromCharCode(byte);
    }
  }
  return { literal: out, unprintable };
}

class Page {
  ops: string[] = [];
  unprintable = 0;

  text(x: number, y: number, value: string, font: PdfFont, size: number, grey = 0): void {
    if (value === "") return;
    const { literal, unprintable } = pdfString(value);
    this.unprintable += unprintable;
    const resource = font === "Helvetica-Bold" ? "/F2" : "/F1";
    const colour = grey > 0 ? `${grey} ${grey} ${grey} rg ` : "0 0 0 rg ";
    this.ops.push(`BT ${colour}${resource} ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm (${literal}) Tj ET`);
  }

  /** Right-aligned. Used for every number, because a column of figures
   * aligned left is a column nobody can scan. */
  textRight(xRight: number, y: number, value: string, font: PdfFont, size: number): void {
    this.text(xRight - textWidth(value, font, size), y, value, font, size);
  }

  rect(x: number, y: number, w: number, h: number, grey: number): void {
    this.ops.push(`${grey} ${grey} ${grey} rg ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`);
  }

  line(x1: number, y1: number, x2: number, y2: number, grey: number): void {
    this.ops.push(
      `${grey} ${grey} ${grey} RG 0.4 w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* WRAPPING                                                            */
/* ------------------------------------------------------------------ */

export function wrapText(
  text: string,
  maxWidth: number,
  font: PdfFont,
  size: number,
  maxLines: number,
): { lines: string[]; truncated: boolean } {
  if (text === "") return { lines: [""], truncated: false };
  const words = text.split(/\s+/).filter((w) => w !== "");
  const lines: string[] = [];
  let current = "";

  const pushCurrent = () => {
    if (current !== "") lines.push(current);
    current = "";
  };

  for (const word of words) {
    const candidate = current === "" ? word : `${current} ${word}`;
    if (textWidth(candidate, font, size) <= maxWidth) {
      current = candidate;
      continue;
    }
    pushCurrent();
    /**
     * ⚠️ A SINGLE WORD WIDER THAN THE COLUMN IS BROKEN BY CHARACTER. A
     * 40-character email address or a document hash has no spaces, and a
     * wrapper that only breaks on whitespace puts it on one line that
     * runs into the next column.
     */
    let remainder = word;
    while (textWidth(remainder, font, size) > maxWidth && remainder.length > 1) {
      let cut = remainder.length;
      while (cut > 1 && textWidth(remainder.slice(0, cut), font, size) > maxWidth) cut -= 1;
      lines.push(remainder.slice(0, cut));
      remainder = remainder.slice(cut);
      if (lines.length >= maxLines) break;
    }
    current = remainder;
    if (lines.length >= maxLines) break;
  }
  pushCurrent();

  if (lines.length === 0) lines.push("");
  if (lines.length <= maxLines) return { lines, truncated: false };

  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = `${kept[maxLines - 1]!.replace(/\s+\S*$/, "")}…`;
  return { lines: kept, truncated: true };
}

/* ------------------------------------------------------------------ */
/* THE DOCUMENT                                                        */
/* ------------------------------------------------------------------ */

export type PdfResult = {
  readonly bytes: Uint8Array;
  readonly notes: readonly string[];
};

export function workbookToPdf(workbook: Workbook): PdfResult {
  const pages: Page[] = [];
  const notes: string[] = [];
  const unprintableColumns = new Set<string>();
  let truncatedCells = 0;

  let page = new Page();
  let y = PAGE_H - MARGIN;
  pages.push(page);

  const newPage = () => {
    page = new Page();
    pages.push(page);
    y = PAGE_H - MARGIN;
  };

  const ensure = (needed: number) => {
    if (y - needed < MARGIN + 18) newPage();
  };

  page.text(MARGIN, y - TITLE_SIZE, workbook.title, "Helvetica-Bold", TITLE_SIZE);
  y -= TITLE_SIZE + 6;
  const stamp = `Generated ${workbook.generatedAt.toISOString().replace("T", " ").slice(0, 19)} UTC`;
  page.text(MARGIN, y - NOTE_SIZE, stamp, "Helvetica", NOTE_SIZE, 0.4);
  y -= NOTE_SIZE + 4;
  for (const [key, value] of Object.entries(workbook.context ?? {})) {
    page.text(MARGIN, y - NOTE_SIZE, `${key}: ${value}`, "Helvetica", NOTE_SIZE, 0.4);
    y -= NOTE_SIZE + 2;
  }
  y -= 8;

  for (const dataset of workbook.datasets) {
    assertDatasetIsRenderable(dataset);

    ensure(HEADING_SIZE + 30);
    page.text(MARGIN, y - HEADING_SIZE, dataset.title, "Helvetica-Bold", HEADING_SIZE);
    y -= HEADING_SIZE + 4;

    for (const note of dataset.notes ?? []) {
      const { lines } = wrapText(note, CONTENT_W, "Helvetica", NOTE_SIZE, 3);
      for (const line of lines) {
        ensure(NOTE_SIZE + 2);
        page.text(MARGIN, y - NOTE_SIZE, line, "Helvetica", NOTE_SIZE, 0.35);
        y -= NOTE_SIZE + 2;
      }
    }
    y -= 4;

    /**
     * ⭐ COLUMN WIDTHS ARE PROPORTIONAL TO THE HINT AND FLOORED. A
     * fifteen-column register on A4 gives each column about 50 points;
     * below about 28 points nothing fits at all, so the floor is real and
     * the overflow is handled by wrapping rather than by shrinking a
     * column to nothing.
     */
    const hints = dataset.columns.map(
      (c) => c.width ?? Math.max(8, Math.min(40, c.label.length + 4)),
    );
    const totalHint = hints.reduce((a, b) => a + b, 0);
    const widths = hints.map((h) => Math.max(28, (h / totalHint) * CONTENT_W));
    const scale = CONTENT_W / widths.reduce((a, b) => a + b, 0);
    const finalWidths = widths.map((w) => w * scale);
    const xs: number[] = [];
    let cursor = MARGIN;
    for (const w of finalWidths) {
      xs.push(cursor);
      cursor += w;
    }

    const drawHeader = () => {
      const headerLines = dataset.columns.map((c, i) =>
        wrapText(c.label, finalWidths[i]! - CELL_PAD * 2, "Helvetica-Bold", BODY_SIZE, 2),
      );
      const rowLines = Math.max(...headerLines.map((h) => h.lines.length));
      const height = rowLines * LINE_HEIGHT + CELL_PAD * 2;
      ensure(height + LINE_HEIGHT);
      page.rect(MARGIN, y - height, CONTENT_W, height, 0.93);
      headerLines.forEach((wrapped, i) => {
        wrapped.lines.forEach((line, li) => {
          page.text(
            xs[i]! + CELL_PAD,
            y - CELL_PAD - (li + 1) * LINE_HEIGHT + 2,
            line,
            "Helvetica-Bold",
            BODY_SIZE,
          );
        });
      });
      y -= height;
      page.line(MARGIN, y, MARGIN + CONTENT_W, y, 0.6);
    };

    drawHeader();

    if (dataset.rows.length === 0) {
      ensure(LINE_HEIGHT * 2);
      page.text(
        MARGIN + CELL_PAD,
        y - LINE_HEIGHT,
        "No rows matched. This is an empty result, not a failed one.",
        "Helvetica",
        BODY_SIZE,
        0.35,
      );
      y -= LINE_HEIGHT * 2;
    }

    for (const row of dataset.rows) {
      const rendered = dataset.columns.map((column, i) => {
        const cell = renderCell(dataset, column, row);
        const text = cellText(cell);
        const wrapped = wrapText(
          text,
          finalWidths[i]! - CELL_PAD * 2,
          "Helvetica",
          BODY_SIZE,
          MAX_CELL_LINES,
        );
        if (wrapped.truncated) truncatedCells += 1;
        return { cell, wrapped, column };
      });

      const rowLines = Math.max(...rendered.map((r) => r.wrapped.lines.length));
      const height = rowLines * LINE_HEIGHT + CELL_PAD;

      if (y - height < MARGIN + 18) {
        newPage();
        drawHeader();
      }

      rendered.forEach((r, i) => {
        const before = page.unprintable;
        r.wrapped.lines.forEach((line, li) => {
          const baseline = y - (li + 1) * LINE_HEIGHT + 2;
          if (r.cell.kind === "number") {
            page.textRight(xs[i]! + finalWidths[i]! - CELL_PAD, baseline, line, "Helvetica", BODY_SIZE);
          } else {
            page.text(xs[i]! + CELL_PAD, baseline, line, "Helvetica", BODY_SIZE);
          }
        });
        if (page.unprintable > before) unprintableColumns.add(r.column.label);
      });

      y -= height;
      page.line(MARGIN, y, MARGIN + CONTENT_W, y, 0.88);
    }

    y -= 10;
  }

  /**
   * ⭐ THE FOOTER IS WRITTEN LAST, BECAUSE "Page 3 of 12" REQUIRES
   * KNOWING 12. A footer written during layout would say "Page 3 of ?"
   * or force a whole second layout pass.
   */
  pages.forEach((p, i) => {
    const label = `Page ${i + 1} of ${pages.length}`;
    p.text(MARGIN, MARGIN - 12, workbook.title, "Helvetica", NOTE_SIZE, 0.5);
    p.text(PAGE_W - MARGIN - textWidth(label, "Helvetica", NOTE_SIZE), MARGIN - 12, label, "Helvetica", NOTE_SIZE, 0.5);
  });

  const totalUnprintable = pages.reduce((a, p) => a + p.unprintable, 0);
  if (totalUnprintable > 0) {
    notes.push(
      `${totalUnprintable} character${totalUnprintable === 1 ? "" : "s"} could not be drawn in this ` +
        `PDF and appear as "?". PDF here uses the standard Helvetica font, which covers Latin script ` +
        `only — it has no Devanagari, no Tamil and no rupee sign. ` +
        `${unprintableColumns.size > 0 ? `Affected column${unprintableColumns.size === 1 ? "" : "s"}: ${[...unprintableColumns].join(", ")}. ` : ""}` +
        `Export the same data as Word or Excel to keep the original text.`,
    );
  }
  if (truncatedCells > 0) {
    notes.push(
      `${truncatedCells} cell${truncatedCells === 1 ? " was" : "s were"} too long for the printed ` +
        `column and ${truncatedCells === 1 ? "is" : "are"} shown ending in an ellipsis. The full ` +
        `value is present in the Excel, CSV and JSON exports of the same data.`,
    );
  }

  return { bytes: serialise(pages, workbook), notes };
}

/* ------------------------------------------------------------------ */
/* SERIALISATION                                                       */
/* ------------------------------------------------------------------ */

function serialise(pages: readonly Page[], workbook: Workbook): Uint8Array {
  const objects: string[] = [];
  const push = (body: string): number => {
    objects.push(body);
    return objects.length; // object numbers are 1-based
  };

  /**
   * ⚠️ THE PAGES OBJECT MUST NAME ITS KIDS AND EACH KID ITS PARENT, so
   * the object numbers have to be known before either is written. They
   * are allocated arithmetically rather than by a second pass.
   */
  const catalogNo = 1;
  const pagesNo = 2;
  const fontNo = 3;
  const fontBoldNo = 4;
  const firstPageNo = 5;
  const pageNos = pages.map((_, i) => firstPageNo + i * 2);
  const contentNos = pages.map((_, i) => firstPageNo + i * 2 + 1);

  push(`<< /Type /Catalog /Pages ${pagesNo} 0 R >>`);
  push(
    `<< /Type /Pages /Count ${pages.length} /Kids [${pageNos.map((n) => `${n} 0 R`).join(" ")}] >>`,
  );
  push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");

  pages.forEach((p, i) => {
    const stream = p.ops.join("\n");
    push(
      `<< /Type /Page /Parent ${pagesNo} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
        `/Resources << /Font << /F1 ${fontNo} 0 R /F2 ${fontBoldNo} 0 R >> >> ` +
        `/Contents ${contentNos[i]} 0 R >>`,
    );
    /**
     * 🔴 `stream.length`, NOT `TextEncoder().encode(...).length`. This
     * document is serialised as latin-1 at the bottom of this file, one
     * byte per code unit, and every character in an ops string is ASCII
     * because `pdfString` octal-escapes everything above 126. Measuring
     * in UTF-8 here would over-count nothing today and silently break the
     * moment a non-ASCII character reached an op — and a wrong /Length is
     * a PDF that opens blank.
     */
    push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });

  const infoNo = push(
    `<< /Title (${pdfString(workbook.title).literal}) /Producer (Ordence) /Creator (Ordence) >>`,
  );

  const parts: string[] = ["%PDF-1.4\n"];
  /**
   * ⚠️ THE BINARY COMMENT IS NOT DECORATION. Without four bytes above 127
   * on line two, tools that sniff text-versus-binary — mail gateways,
   * some version control, some proxies — treat the file as text and
   * newline-convert it, which corrupts the byte offsets in the xref.
   */
  parts.push("%âãÏÓ\n");

  const offsets: number[] = [];
  /**
   * 🔴 OFFSETS ARE COUNTED IN LATIN-1 CODE UNITS, WHICH IS WHAT THE
   * WRITER AT THE BOTTOM OF THIS FUNCTION EMITS. `TextEncoder` would
   * count the four bytes of the binary comment as EIGHT, and every xref
   * entry after it would point four bytes past its object. A reader that
   * cannot resolve the xref shows an empty document, or repairs it and
   * shows a different one.
   */
  let offset = parts.join("").length;

  objects.forEach((body, i) => {
    offsets.push(offset);
    const chunk = `${i + 1} 0 obj\n${body}\nendobj\n`;
    parts.push(chunk);
    offset += chunk.length;
  });

  const xrefOffset = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) xref += `${o.toString().padStart(10, "0")} 00000 n \n`;
  parts.push(xref);
  parts.push(
    `trailer\n<< /Size ${objects.length + 1} /Root ${catalogNo} 0 R /Info ${infoNo} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  );

  /**
   * 🔴 `latin1`, NOT UTF-8. Every string in this document is already
   * WinAnsi bytes escaped into ASCII, and the binary comment above is
   * four LATIN-1 bytes. Encoding the assembled document as UTF-8 would
   * turn those four bytes into eight and every xref offset computed above
   * would point past its object.
   */
  const text = parts.join("");
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}
