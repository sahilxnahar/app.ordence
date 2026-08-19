/**
 * Ordence — ⭐ HELVETICA METRICS AND THE WinAnsi WALL
 * Version: v1.73.0-alpha · Wave 5
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY MEASURE AT ALL
 * ══════════════════════════════════════════════════════════════════════
 * A table writer that does not know how wide a string is has two choices:
 * fixed-width columns that clip, or a monospace font. Both look like a
 * dump. These are the Adobe AFM advance widths for the two base-14 fonts
 * every PDF reader already has, so nothing has to be embedded and the
 * column fitting is real.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 AND THE LIMIT THIS FILE IS HONEST ABOUT
 * ══════════════════════════════════════════════════════════════════════
 * The base-14 fonts are encoded in WinAnsi, which is Latin-1 plus a
 * handful. THERE IS NO DEVANAGARI IN IT. There is no Tamil, no Bengali,
 * no Gujarati — and THERE IS NO RUPEE SIGN, because ₹ (U+20B9) was
 * assigned in 2010 and WinAnsi was fixed in 1985.
 *
 * ⚠️ FOR AN INDIAN PRODUCT THAT IS NOT A FOOTNOTE. A customer named
 * विक्रम शर्मा exported to PDF comes out as question marks.
 *
 * ⭐ THE ANSWER IS NOT TO PRETEND. `winAnsiByte` returns null for a
 * character it cannot draw, `lib/export/pdf.ts` counts them and names the
 * columns they were in, and `lib/export/registry.ts` marks PDF as
 * lossy-for-non-Latin so THE PICKER WARNS BEFORE THE DOWNLOAD. DOCX
 * carries the same content in full Unicode and is one click away.
 *
 * ⚠️ THE OTHER ANSWER — embedding a Devanagari font — means shipping a
 * multi-megabyte TTF, subsetting it, and writing a CID font with a
 * ToUnicode CMap. That is a wave of its own, not a paragraph in this one,
 * and pretending otherwise is how a half-built feature ships.
 */

/** Advance widths in 1/1000 em for WinAnsi codes 32..126. */
const HELVETICA_ASCII = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

const HELVETICA_BOLD_ASCII = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

/**
 * ⚠️ 128..255 IS APPROXIMATED AT THE AVERAGE. The accented Latin letters
 * are within a few thousandths of their unaccented forms, so the column
 * fitting is right to well under a character. Stating the approximation
 * because an unstated one is how "close enough" becomes a bug report
 * about a European supplier name overflowing its column.
 */
const HIGH_DEFAULT = 556;

export type PdfFont = "Helvetica" | "Helvetica-Bold";

export function glyphWidth(byte: number, font: PdfFont): number {
  const table = font === "Helvetica-Bold" ? HELVETICA_BOLD_ASCII : HELVETICA_ASCII;
  if (byte >= 32 && byte <= 126) return table[byte - 32]!;
  return HIGH_DEFAULT;
}

/**
 * ⭐ THE SPECIAL CASES OF WinAnsi: the code points between 0x80 and 0x9F
 * that Windows-1252 assigns and Latin-1 leaves undefined. Without this
 * map an em dash, a curly quote or a euro sign — all of which arrive
 * routinely in pasted text — would be unprintable.
 */
const WIN_ANSI_HIGH = new Map<number, number>([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84],
  [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88],
  [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c],
  [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92], [0x201c, 0x93],
  [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b],
  [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f],
]);

/**
 * The WinAnsi byte for a code point, or null when this font cannot draw
 * it at all. NULL IS THE POINT OF THE FUNCTION — see the header.
 */
export function winAnsiByte(codePoint: number): number | null {
  if (codePoint === 0x0a || codePoint === 0x0d || codePoint === 0x09) return 0x20;
  if (codePoint >= 0x20 && codePoint <= 0x7e) return codePoint;
  const mapped = WIN_ANSI_HIGH.get(codePoint);
  if (mapped !== undefined) return mapped;
  if (codePoint >= 0xa0 && codePoint <= 0xff) return codePoint;
  return null;
}

export type EncodedText = {
  /** The WinAnsi bytes, with unprintable characters replaced. */
  readonly bytes: number[];
  /** How many characters could not be drawn in this font. */
  readonly unprintable: number;
};

/** The glyph substituted for a character the font has not got. */
export const SUBSTITUTE = 0x3f; // '?'

export function encodeWinAnsi(text: string): EncodedText {
  const bytes: number[] = [];
  let unprintable = 0;
  for (const char of text) {
    const cp = char.codePointAt(0)!;
    const byte = winAnsiByte(cp);
    if (byte === null) {
      unprintable += 1;
      bytes.push(SUBSTITUTE);
    } else {
      bytes.push(byte);
    }
  }
  return { bytes, unprintable };
}

/** Width of a string at a given size, in points. */
export function textWidth(text: string, font: PdfFont, sizePt: number): number {
  const { bytes } = encodeWinAnsi(text);
  let thousandths = 0;
  for (const byte of bytes) thousandths += glyphWidth(byte, font);
  return (thousandths * sizePt) / 1000;
}
