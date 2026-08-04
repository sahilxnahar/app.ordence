/**
 * Ordence — What the bytes actually are
 * Version: v0.67.0-alpha
 * Runtime: Edge-safe. Pure byte inspection, no I/O.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE HOLE THIS CLOSES
 * ══════════════════════════════════════════════════════════════════════
 * `/api/upload` checks `isAllowedMimeType(payload.contentType)` — the
 * content type the CLIENT declared. `text/html` and `image/svg+xml` are
 * deliberately absent from that allowlist because both can carry script,
 * and a file with script served from an origin the user is signed in to
 * is stored XSS.
 *
 * But the allowlist reads a string the attacker wrote. Uploading an HTML
 * document while declaring `application/pdf` passes every check in the
 * pipeline: the allowlist is satisfied, the type is pinned into the
 * signed ticket, and `/api/upload/put` faithfully verifies that the body
 * arrives claiming the same lie it was told earlier. The file is then
 * stored, and the pinned content type is what it is served with.
 *
 * ⚠️ THE PINNING IS WHAT MAKES THIS SURVIVABLE TODAY, AND IT IS NOT
 * ENOUGH TO RELY ON. Serving an HTML file as `application/pdf` means most
 * browsers download rather than render it. That is a mitigation supplied
 * by the browser's sniffing rules, not by us, and it varies by browser,
 * by extension, and by whether `Content-Disposition` survives whatever
 * proxy sits in front. Depending on it is depending on somebody else's
 * default.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS DOES, AND THE TWO SEPARATE QUESTIONS IT ASKS
 * ══════════════════════════════════════════════════════════════════════
 * 1. IS IT WHAT IT CLAIMS? For formats with a real signature — PDF, PNG,
 *    JPEG, ZIP and everything built on ZIP (docx/xlsx/pptx) — the first
 *    bytes are checked against the declared type.
 *
 * 2. IS IT SOMETHING DANGEROUS? Independently of what it claims, a body
 *    that opens like HTML, SVG or a script is refused. This is the check
 *    that matters, because it holds even for the formats that have no
 *    signature at all.
 *
 * ⚠️ QUESTION 2 IS NOT REDUNDANT AND MUST NOT BE FOLDED INTO QUESTION 1.
 * `text/plain`, `text/csv` and `application/rtf` have no dependable magic
 * number — a CSV legitimately starts with any byte at all. A checker that
 * only answered question 1 would return "unknown, allow" for exactly the
 * declared types an attacker would choose.
 */

/** How many bytes are needed to answer both questions. */
export const MAGIC_BYTES_WINDOW = 64;

type Signature = {
  /** Bytes that must appear at `offset`. */
  bytes: number[];
  offset: number;
};

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));

/**
 * Signatures by declared content type.
 *
 * ⚠️ A TYPE ABSENT FROM THIS MAP IS NOT REFUSED — it is "unknown", and
 * falls through to question 2 alone. Absence must mean "no signature
 * exists for this format", never "nobody got round to it", so anything
 * added to `ALLOWED_MIME_TYPES` should be considered here at the same
 * time.
 */
const SIGNATURES: Record<string, Signature[]> = {
  "application/pdf": [{ bytes: ascii("%PDF-"), offset: 0 }],

  "image/png": [{ bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], offset: 0 }],
  "image/jpeg": [{ bytes: [0xff, 0xd8, 0xff], offset: 0 }],
  "image/gif": [
    { bytes: ascii("GIF87a"), offset: 0 },
    { bytes: ascii("GIF89a"), offset: 0 },
  ],
  // RIFF....WEBP — the four size bytes in between are not part of the signature.
  "image/webp": [{ bytes: ascii("WEBP"), offset: 8 }],
  // ISO base media container; 'ftyp' at offset 4, then a heic/heif brand.
  "image/heic": [{ bytes: ascii("ftyp"), offset: 4 }],
  "image/tiff": [
    { bytes: [0x49, 0x49, 0x2a, 0x00], offset: 0 }, // little-endian
    { bytes: [0x4d, 0x4d, 0x00, 0x2a], offset: 0 }, // big-endian
  ],

  /**
   * ⚠️ EVERY MODERN OFFICE FORMAT IS A ZIP FILE. docx, xlsx and pptx all
   * begin `PK\x03\x04`, so this check proves the container and says
   * nothing about the contents. That is the honest limit of a magic-byte
   * check and the reason question 2 exists.
   *
   * `PK\x05\x06` is an empty archive and `PK\x07\x08` a spanned one; both
   * are valid ZIPs and both are accepted rather than producing a
   * confusing refusal for a legitimately empty file.
   */
  "application/zip": zipSignatures(),
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": zipSignatures(),
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": zipSignatures(),
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": zipSignatures(),

  // Legacy Office: OLE2 compound document.
  "application/msword": [{ bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], offset: 0 }],
  "application/vnd.ms-excel": [{ bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], offset: 0 }],
  "application/vnd.ms-powerpoint": [{ bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], offset: 0 }],

  "application/rtf": [{ bytes: ascii("{\\rtf"), offset: 0 }],
};

function zipSignatures(): Signature[] {
  return [
    { bytes: [0x50, 0x4b, 0x03, 0x04], offset: 0 },
    { bytes: [0x50, 0x4b, 0x05, 0x06], offset: 0 },
    { bytes: [0x50, 0x4b, 0x07, 0x08], offset: 0 },
  ];
}

/**
 * Openings that mean "this can execute in a browser", whatever it claims.
 *
 * ⚠️ MATCHED CASE-INSENSITIVELY AFTER SKIPPING LEADING WHITESPACE AND A
 * BYTE-ORDER MARK. `<!DOCTYPE html>` and `﻿  <ScRiPt>` are the same
 * file to a browser, and a checker that only recognised the tidy form
 * would be trivially bypassed by pressing space.
 */
const DANGEROUS_OPENINGS = [
  "<!doctype html",
  "<html",
  "<head",
  "<body",
  "<script",
  "<svg",
  "<?php",
  "<%",
  "#!/",
];

export type SniffVerdict =
  | { ok: true; reason: "matched" | "no-signature-known" }
  | { ok: false; reason: "signature-mismatch" | "executable-content"; detail: string };

/**
 * Inspect the first bytes of an upload.
 *
 * Pure and synchronous: the caller supplies a window, this decides. That
 * separation is what lets the streaming path check a 50 MB upload without
 * buffering it, and lets the tests run without a network.
 */
export function sniffUpload(declaredType: string, head: Uint8Array): SniffVerdict {
  /* ---- Question 2 first, because it applies to every declared type. --- */
  const opening = leadingText(head);
  for (const marker of DANGEROUS_OPENINGS) {
    if (opening.startsWith(marker)) {
      return {
        ok: false,
        reason: "executable-content",
        detail:
          `The file begins with "${marker}", which a browser can execute. ` +
          `Markup and scripts are never accepted as uploads, whatever content type they are sent as.`,
      };
    }
  }

  /* ---- Question 1. ---------------------------------------------------- */
  const signatures = SIGNATURES[declaredType];
  if (!signatures) {
    // text/plain, text/csv and anything else with no dependable opening.
    // Question 2 has already run, which is the check that matters for these.
    return { ok: true, reason: "no-signature-known" };
  }

  // ⚠️ A truncated head is NOT a mismatch. A body shorter than the
  // signature it should carry is a broken or empty upload, and refusing it
  // as "not what it claims" would send the operator looking for a security
  // problem that is not there. Let it through; the storage layer's own
  // size checks are the right place for that.
  if (head.length < MAGIC_BYTES_WINDOW && !signatures.some((s) => head.length >= s.offset + s.bytes.length)) {
    return { ok: true, reason: "no-signature-known" };
  }

  for (const signature of signatures) {
    if (matches(head, signature)) return { ok: true, reason: "matched" };
  }

  return {
    ok: false,
    reason: "signature-mismatch",
    detail:
      `The file was sent as ${declaredType}, but its contents are not in that format. ` +
      `Re-save it in the format you intended and upload it again.`,
  };
}

function matches(head: Uint8Array, signature: Signature): boolean {
  if (head.length < signature.offset + signature.bytes.length) return false;
  for (let i = 0; i < signature.bytes.length; i++) {
    if (head[signature.offset + i] !== signature.bytes[i]) return false;
  }
  return true;
}

/**
 * The opening of the file as lowercase text, with a BOM and leading
 * whitespace removed. Non-ASCII bytes end the run — a binary file has no
 * meaningful "opening text" and should not be coerced into one.
 */
function leadingText(head: Uint8Array): string {
  let i = 0;

  // UTF-8 BOM.
  if (head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) i = 3;

  while (i < head.length && isWhitespace(head[i]!)) i++;

  let text = "";
  for (let j = i; j < head.length; j++) {
    const byte = head[j]!;
    if (byte < 0x20 || byte > 0x7e) break;
    text += String.fromCharCode(byte);
  }
  return text.toLowerCase();
}

function isWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x0b || byte === 0x0c;
}
