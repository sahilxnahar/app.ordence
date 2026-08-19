/**
 * Ordence — ⭐⭐ READING A DXF, ONE GROUP CODE AT A TIME
 * Version: v1.75.0-alpha · Wave 7
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT A DXF ACTUALLY IS
 * ══════════════════════════════════════════════════════════════════════
 * Two lines per value, forever. An integer GROUP CODE on one line, the
 * value on the next:
 *
 *      0
 *      LINE
 *      8
 *      WALLS
 *      10
 *      1250.0
 *
 * "a LINE, on layer WALLS, starting at x = 1250". That is the whole
 * format. It is verbose, it is unambiguous, and it has been published by
 * Autodesk since 1982.
 *
 * ⭐ WHICH IS WHY THE ENGINE IS IN-HOUSE. The alternative was an ODA
 * licence at $7,500 for the first year and $4,500 a year after — and the
 * only tier that permits use in a web product, the cheaper Limited
 * Commercial tier, explicitly does not. LibreDWG is GPL-3, which is a
 * decision about the whole product, not about one feature.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE FILES THAT ARE NOT ASCII DXF, AND WHAT THEY GET TOLD
 * ══════════════════════════════════════════════════════════════════════
 * ① BINARY DXF — starts with "AutoCAD Binary DXF\r\n\x1a\0". A real
 *    format, rarely produced, and reading it as text produces garbage
 *    group codes and a parse error that says nothing useful.
 *
 * ② 🔴 DWG — the native format, and it is NOT DXF. It starts with `AC10`
 *    and a version number. Most people who say "CAD file" mean this. The
 *    refusal names the AutoCAD version the file was written by and tells
 *    them the two-click export that produces a DXF, because "unsupported
 *    file type" sends them to support and the sentence sends them back to
 *    their own software.
 *
 * ⚠️ AND ONE THING THAT LOOKS LIKE A FAILURE AND IS NOT: a DXF whose
 * lines end `\r\n`, or which uses a UTF-8 BOM, or whose group codes have
 * leading spaces. All three are common — the spaces are what AutoCAD's
 * own writer emits — and all three are handled here rather than in five
 * places downstream.
 */

export class DxfLexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DxfLexError";
  }
}

export type DxfPair = {
  readonly code: number;
  readonly value: string;
  /** 1-based line number of the CODE. Every error names it. */
  readonly line: number;
};

/** The sentinel a binary DXF starts with. */
const BINARY_SENTINEL = "AutoCAD Binary DXF";

/**
 * ⭐ DWG VERSION CODES. The first six bytes of every DWG ever written.
 * Naming the version in the refusal is the difference between a customer
 * who exports a DXF in two clicks and one who raises a ticket.
 */
const DWG_VERSIONS: Readonly<Record<string, string>> = Object.freeze({
  AC1006: "AutoCAD R10",
  AC1009: "AutoCAD R11/R12",
  AC1012: "AutoCAD R13",
  AC1014: "AutoCAD R14",
  AC1015: "AutoCAD 2000-2002",
  AC1018: "AutoCAD 2004-2006",
  AC1021: "AutoCAD 2007-2009",
  AC1024: "AutoCAD 2010-2012",
  AC1027: "AutoCAD 2013-2017",
  AC1032: "AutoCAD 2018 and later",
});

export type FileKind =
  | { readonly kind: "dxf-ascii" }
  | { readonly kind: "dxf-binary" }
  | { readonly kind: "dwg"; readonly version: string; readonly code: string }
  | { readonly kind: "unknown" };

export function identifyCadFile(bytes: Uint8Array): FileKind {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 64));
  if (head.startsWith(BINARY_SENTINEL)) return { kind: "dxf-binary" };

  const magic = head.slice(0, 6);
  if (/^AC1\d{3}$/.test(magic)) {
    return {
      kind: "dwg",
      code: magic,
      version: DWG_VERSIONS[magic] ?? `an AutoCAD version Ordence does not have a name for (${magic})`,
    };
  }

  /**
   * ⚠️ A DXF DOES NOT HAVE TO START WITH `0/SECTION`. Plenty begin with a
   * comment (group code 999), and some tools emit blank lines first. So
   * the test is "does a SECTION appear early", not "is it the first
   * thing".
   */
  const opening = new TextDecoder("utf-8").decode(bytes.subarray(0, 4096));
  if (/(^|\n)\s*0\s*[\r\n]+\s*SECTION\s*[\r\n]/.test(opening)) {
    return { kind: "dxf-ascii" };
  }
  return { kind: "unknown" };
}

/**
 * ⭐ THE REFUSAL FOR A DWG, WRITTEN FOR THE PERSON HOLDING THE FILE.
 *
 * ⚠️ IT NAMES THE VERSION AND THE MENU PATH. "Unsupported file type"
 * sends them to support; this sends them back to their own software,
 * which is where the fix is.
 */
export function dwgRefusal(version: string): string {
  return (
    `That is a DWG file, written by ${version}. DWG is AutoCAD's own format and its layout is ` +
    `not published; Ordence reads DXF, which is the interchange format Autodesk publishes and ` +
    `which every CAD program can write.\n\n` +
    `In AutoCAD: File → Save As → change "Files of type" to "AutoCAD 2018 DXF (*.dxf)".\n` +
    `In BricsCAD, DraftSight, ZWCAD or LibreCAD the same option is in the same place.\n\n` +
    `A DXF of the same drawing carries every layer, every dimension and every block. It is ` +
    `larger on disk and identical in content.`
  );
}

/**
 * ⭐⭐ THE LEXER. Pairs, in order, with line numbers.
 *
 * ⚠️ IT IS A GENERATOR. A site plan is routinely 40MB of ASCII and eight
 * million pairs; materialising them into an array costs several hundred
 * megabytes before a single entity exists. The parser consumes this
 * lazily and keeps only what it builds.
 */
export function* lexDxf(text: string): Generator<DxfPair> {
  /** ⚠️ BOM stripped once, here, so nothing downstream has to remember. */
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  let at = 0;
  let line = 1;
  const length = source.length;

  const readLine = (): string | null => {
    if (at >= length) return null;
    let end = source.indexOf("\n", at);
    if (end === -1) end = length;
    let text = source.slice(at, end);
    /** ⚠️ CRLF. A trailing `\r` on a layer name never matches again. */
    if (text.endsWith("\r")) text = text.slice(0, -1);
    at = end + 1;
    line += 1;
    return text;
  };

  for (;;) {
    const codeLine = readLine();
    if (codeLine === null) return;
    const codeText = codeLine.trim();
    /** A blank line between records is legal and common. */
    if (codeText === "") continue;

    const code = Number(codeText);
    if (!Number.isInteger(code)) {
      throw new DxfLexError(
        `Line ${line - 1} of that DXF should be a group code — a whole number — and reads ` +
          `"${codeText.slice(0, 40)}". The file is either damaged or is not a DXF at all. ` +
          `Nothing has been read from it.`,
      );
    }

    const valueLine = readLine();
    if (valueLine === null) {
      throw new DxfLexError(
        `That DXF ends after group code ${code} on line ${line - 1}, with no value after it. ` +
          `The file was truncated — most often by an interrupted download or an export that ` +
          `ran out of disk.`,
      );
    }

    /**
     * ⚠️ THE VALUE IS NOT TRIMMED. A TEXT entity's contents may
     * legitimately begin or end with a space, and trimming it silently
     * edits the drawing's annotations. Only the CODE is trimmed, because
     * AutoCAD's own writer pads codes to three columns.
     */
    yield { code, value: valueLine, line: line - 2 };
  }
}
