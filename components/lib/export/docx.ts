/**
 * Ordence — ⭐⭐ DOCX, AND WHY IT IS THE UNICODE-SAFE PRINTABLE FORMAT
 * Version: v1.73.0-alpha · Wave 5
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE DIVISION OF LABOUR BETWEEN THIS FILE AND `pdf.ts`
 * ══════════════════════════════════════════════════════════════════════
 * Both produce a document somebody prints or emails. They are not
 * interchangeable and the picker says so:
 *
 *   PDF  fixed layout, opens identically everywhere, cannot be edited —
 *        and, in this implementation, LATIN-1 ONLY, because embedding a
 *        Devanagari font would mean shipping a font binary. See pdf.ts,
 *        which counts and reports every character it could not draw.
 *
 *   DOCX 🔴 FULL UNICODE, because the text lives in UTF-8 XML and Word
 *        picks the font. A customer named विक्रम or a Tamil address comes
 *        out right. It is also editable, which is what a person preparing
 *        a covering note actually wants.
 *
 * ⚠️ SO FOR INDIAN-LANGUAGE CONTENT DOCX IS THE CORRECT PRINTABLE FORMAT
 * AND PDF IS THE WRONG ONE, and `lib/export/registry.ts` marks the
 * limitation on PDF rather than leaving the customer to discover it from
 * a page of question marks.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT IS IN THE PACKAGE
 * ══════════════════════════════════════════════════════════════════════
 * The minimum WordprocessingML that Word, Pages, LibreOffice and Google
 * Docs all open: content types, the root relationship, the document, and
 * a style part for the heading and the table. No theme, no settings, no
 * fontTable — every one of them is optional and every one is another
 * thing to get subtly wrong.
 */

import type { Dataset, Workbook } from "./types";
import { assertDatasetIsRenderable, cellText, renderCell } from "./values";
import { XmlEscaper } from "./xml";
import { buildZip, type DeflateRaw, type ZipEntry } from "./zip";

const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** A4 landscape in twentieths of a point. Landscape because these are tables. */
const PAGE_W = 16838;
const PAGE_H = 11906;
const MARGIN = 720; // half an inch
const CONTENT_W = PAGE_W - MARGIN * 2;

function para(text: string, opts: { style?: string; esc: XmlEscaper }): string {
  const style = opts.style ? `<w:pPr><w:pStyle w:val="${opts.style}"/></w:pPr>` : "";
  return `<w:p>${style}<w:r><w:t xml:space="preserve">${opts.esc.text(text)}</w:t></w:r></w:p>`;
}

function tableCell(text: string, widthTwips: number, bold: boolean, esc: XmlEscaper, alignRight: boolean): string {
  const runProps = bold ? "<w:rPr><w:b/></w:rPr>" : "";
  const justify = alignRight ? '<w:jc w:val="right"/>' : "";
  const shading = bold ? '<w:shd w:val="clear" w:color="auto" w:fill="EFEFEF"/>' : "";
  return (
    `<w:tc><w:tcPr><w:tcW w:w="${widthTwips}" w:type="dxa"/>${shading}</w:tcPr>` +
    `<w:p><w:pPr>${justify}</w:pPr><w:r>${runProps}<w:t xml:space="preserve">${esc.text(text)}</w:t></w:r></w:p></w:tc>`
  );
}

function datasetTable(dataset: Dataset, esc: XmlEscaper): string {
  assertDatasetIsRenderable(dataset);

  /**
   * ⚠️ WIDTHS ARE PROPORTIONAL TO THE DECLARED HINT, NOT EQUAL. A column
   * of dates and a column of addresses given the same width produces a
   * table where one wraps every row and the other is half empty, which is
   * the difference between a document somebody reads and one they ask you
   * to redo.
   */
  const hints = dataset.columns.map((c) => c.width ?? Math.max(8, Math.min(40, c.label.length + 4)));
  const total = hints.reduce((a, b) => a + b, 0);
  const widths = hints.map((h) => Math.max(400, Math.round((h / total) * CONTENT_W)));

  const grid = widths.map((w) => `<w:gridCol w:w="${w}"/>`).join("");

  const headerCells = dataset.columns
    .map((c, i) => tableCell(c.label, widths[i]!, true, esc, false))
    .join("");
  /**
   * ⭐ `tblHeader` REPEATS THE HEADING ROW ON EVERY PAGE. A forty-page
   * table whose column names appear once is unreadable from page two.
   */
  const headerRow = `<w:tr><w:trPr><w:tblHeader/></w:trPr>${headerCells}</w:tr>`;

  const bodyRows = dataset.rows
    .map((row) => {
      const cells = dataset.columns
        .map((column, i) => {
          const cell = renderCell(dataset, column, row);
          const right = cell.kind === "number";
          return tableCell(cellText(cell), widths[i]!, false, esc, right);
        })
        .join("");
      return `<w:tr>${cells}</w:tr>`;
    })
    .join("");

  const borders =
    "<w:tblBorders>" +
    ["top", "left", "bottom", "right", "insideH", "insideV"]
      .map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/>`)
      .join("") +
    "</w:tblBorders>";

  return (
    `<w:tbl><w:tblPr><w:tblW w:w="${CONTENT_W}" w:type="dxa"/>${borders}</w:tblPr>` +
    `<w:tblGrid>${grid}</w:tblGrid>${headerRow}${bodyRows}</w:tbl>`
  );
}

export type DocxResult = {
  readonly bytes: Uint8Array;
  readonly notes: readonly string[];
};

export function workbookToDocx(
  workbook: Workbook,
  options: { readonly deflateRaw?: DeflateRaw } = {},
): DocxResult {
  const esc = new XmlEscaper();
  const body: string[] = [];

  body.push(para(workbook.title, { style: "Title", esc }));
  body.push(
    para(`Generated ${workbook.generatedAt.toISOString().replace("T", " ").slice(0, 19)} UTC`, {
      style: "Subtle",
      esc,
    }),
  );
  for (const [key, value] of Object.entries(workbook.context ?? {})) {
    body.push(para(`${key}: ${value}`, { style: "Subtle", esc }));
  }

  workbook.datasets.forEach((dataset, index) => {
    if (index > 0) {
      /**
       * ⚠️ A PAGE BREAK BETWEEN DATASETS, NOT A BLANK LINE. Two registers
       * running together on one page is how a reader attributes a total
       * to the wrong table.
       */
      body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
    }
    body.push(para(dataset.title, { style: "Heading1", esc }));
    for (const note of dataset.notes ?? []) body.push(para(note, { style: "Subtle", esc }));
    if (dataset.rows.length === 0) {
      body.push(para("No rows matched. This is an empty result, not a failed one.", { style: "Subtle", esc }));
    } else {
      body.push(datasetTable(dataset, esc));
    }
  });

  const sectPr =
    `<w:sectPr><w:pgSz w:w="${PAGE_W}" w:h="${PAGE_H}" w:orient="landscape"/>` +
    `<w:pgMar w:top="${MARGIN}" w:right="${MARGIN}" w:bottom="${MARGIN}" w:left="${MARGIN}" ` +
    `w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>`;

  const documentXml = `${DECL}<w:document xmlns:w="${W}"><w:body>${body.join("")}${sectPr}</w:body></w:document>`;

  const stylesXml =
    `${DECL}<w:styles xmlns:w="${W}">` +
    '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="18"/></w:rPr></w:rPrDefault></w:docDefaults>' +
    '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Subtle"><w:name w:val="Subtle"/><w:rPr><w:i/><w:color w:val="595959"/><w:sz w:val="16"/></w:rPr></w:style>' +
    "</w:styles>";

  const contentTypes =
    `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    "</Types>";

  const rootRels =
    `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/>` +
    "</Relationships>";

  const documentRels =
    `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="${REL}/styles" Target="styles.xml"/>` +
    "</Relationships>";

  const encoder = new TextEncoder();
  const entries: ZipEntry[] = [
    { path: "[Content_Types].xml", bytes: encoder.encode(contentTypes) },
    { path: "_rels/.rels", bytes: encoder.encode(rootRels) },
    { path: "word/document.xml", bytes: encoder.encode(documentXml) },
    { path: "word/_rels/document.xml.rels", bytes: encoder.encode(documentRels) },
    { path: "word/styles.xml", bytes: encoder.encode(stylesXml) },
  ];

  const notes: string[] = [];
  const stripNote = esc.note();
  if (stripNote) notes.push(stripNote);

  return {
    bytes: buildZip(entries, { at: workbook.generatedAt, deflateRaw: options.deflateRaw }),
    notes,
  };
}
