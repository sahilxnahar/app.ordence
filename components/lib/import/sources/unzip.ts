/**
 * Ordence — ⭐⭐ READING A ZIP, BECAUSE AN XLSX IS ONE
 * Version: v1.74.0-alpha · Wave 6
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE MIRROR OF `lib/export/zip.ts`, AND DELIBERATELY NOT THE SAME FILE
 * ══════════════════════════════════════════════════════════════════════
 * Writing a ZIP and reading one share a format and nothing else. The
 * writer controls everything it emits; the reader is handed a file a
 * customer produced with software nobody here has seen, and every
 * assumption it makes is an assumption an attacker or a broken exporter
 * can violate. Merging them would put the writer's confidence into the
 * reader's code path.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT A HOSTILE OR MERELY BROKEN ARCHIVE CAN DO, AND WHAT STOPS IT
 * ══════════════════════════════════════════════════════════════════════
 * ① **A ZIP BOMB.** 42 kilobytes that inflate to 4.5 petabytes is a real,
 *    named file. `MAX_INFLATED_BYTES` and `MAX_ENTRIES` below are checked
 *    as the archive is walked, and the refusal names the ratio.
 *
 * ② **PATH TRAVERSAL.** `../../etc/cron.d/x` as an entry name. Nothing in
 *    this codebase writes an extracted entry to disk, so it is not
 *    exploitable TODAY — which is exactly the condition under which
 *    somebody later adds a `writeFile` and it becomes exploitable
 *    without anybody re-reading this file. Refused here, once.
 *
 * ③ **A LYING CENTRAL DIRECTORY.** The uncompressed size in the header is
 *    an assertion by whoever wrote the file, not a fact. It is used only
 *    as a CHEAP PRE-CHECK; the real limit is enforced against the bytes
 *    actually produced.
 *
 * ⚠️ AND THE CENTRAL DIRECTORY IS THE INDEX, NOT THE LOCAL HEADERS. Some
 * writers stream and leave zeroes in the local header with the real sizes
 * in a data descriptor after the data. Reading local headers works for
 * Excel and fails for LibreOffice-in-streaming-mode, which is precisely
 * the kind of "works on my file" bug a customer reports as "your importer
 * is broken".
 *
 * ══════════════════════════════════════════════════════════════════════
 * PURE. `inflateRaw` DEFAULTS TO OUR OWN AND MAY BE REPLACED
 * ══════════════════════════════════════════════════════════════════════
 * Same discipline as the writer: no `node:zlib` here, so this runs in a
 * browser, in a test, in the edge runtime and in a script.
 *
 * ⭐ THE DEFAULT IS `lib/import/sources/inflate.ts` — two hundred lines
 * of RFC 1951, pure and synchronous — because THE CUSTOMER'S FILE IS READ
 * IN THEIR BROWSER, where `node:zlib` does not exist and
 * `DecompressionStream` is asynchronous.
 *
 * ⚠️ THE SERVER MAY STILL PASS `inflateRawSync`, which is faster. It is
 * an override, not a requirement, so nothing breaks when it is absent.
 */

import { inflateRaw as pureInflateRaw } from "./inflate";

export type InflateRaw = (input: Uint8Array, expectedSize: number) => Uint8Array;

export type ZipMember = {
  readonly path: string;
  readonly bytes: Uint8Array;
};

export class ZipReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipReadError";
  }
}

/** A spreadsheet of a million cells is a few tens of megabytes of XML. */
export const MAX_INFLATED_BYTES = 256 * 1024 * 1024;
/** An XLSX has a handful of parts per sheet. Thousands means something else. */
export const MAX_ENTRIES = 4096;

function u16(bytes: Uint8Array, at: number): number {
  return bytes[at]! | (bytes[at + 1]! << 8);
}

function u32(bytes: Uint8Array, at: number): number {
  return (
    (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)) >>> 0
  );
}

/**
 * ⚠️ THE END-OF-CENTRAL-DIRECTORY RECORD IS FOUND BY SEARCHING BACKWARDS,
 * because it is followed by a variable-length comment. Scanning forwards
 * for the signature would find it inside compressed data.
 */
function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const minimum = 22;
  if (bytes.length < minimum) {
    throw new ZipReadError(
      "That file is too small to be a spreadsheet. It may be empty, or the download may have " +
        "been interrupted.",
    );
  }
  /** The comment field is 16 bits, so it cannot start further back than this. */
  const earliest = Math.max(0, bytes.length - minimum - 0xffff);
  for (let at = bytes.length - minimum; at >= earliest; at -= 1) {
    if (u32(bytes, at) === 0x06054b50) return at;
  }
  throw new ZipReadError(
    "That file is not a readable spreadsheet. An .xlsx file is a zip archive, and this one has " +
      "no archive index — which usually means it is actually an older .xls file, or it was " +
      "renamed rather than saved as .xlsx. Open it in Excel and choose Save As → Excel Workbook.",
  );
}

/**
 * ⭐ EVERY ENTRY, KEYED BY PATH. An XLSX has fewer than twenty parts, so
 * reading them all is cheaper than seeking twice.
 */
export function readZip(bytes: Uint8Array, inflateRaw?: InflateRaw): Map<string, Uint8Array> {
  const eocd = findEndOfCentralDirectory(bytes);
  const entryCount = u16(bytes, eocd + 10);
  const directoryOffset = u32(bytes, eocd + 16);

  if (entryCount > MAX_ENTRIES) {
    throw new ZipReadError(
      `That archive contains ${entryCount} entries. A spreadsheet has a few dozen. Nothing has ` +
        `been read.`,
    );
  }
  if (directoryOffset >= bytes.length) {
    throw new ZipReadError(
      "That archive's index points outside the file. It is truncated or corrupt — re-download " +
        "it and try again.",
    );
  }

  const out = new Map<string, Uint8Array>();
  const decoder = new TextDecoder("utf-8");
  let inflatedTotal = 0;
  let at = directoryOffset;

  for (let i = 0; i < entryCount; i += 1) {
    if (at + 46 > bytes.length || u32(bytes, at) !== 0x02014b50) {
      throw new ZipReadError(
        `That archive's index ends after ${i} of ${entryCount} entries. The file is truncated.`,
      );
    }

    const method = u16(bytes, at + 10);
    const compressedSize = u32(bytes, at + 20);
    const declaredSize = u32(bytes, at + 24);
    const nameLength = u16(bytes, at + 28);
    const extraLength = u16(bytes, at + 30);
    const commentLength = u16(bytes, at + 32);
    const localOffset = u32(bytes, at + 42);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));

    at += 46 + nameLength + extraLength + commentLength;

    /** ⚠️ ② — refused whether or not anything writes it to disk. */
    if (name.includes("..") || name.startsWith("/") || name.includes("\\")) {
      throw new ZipReadError(
        `That archive contains an entry named "${name}", which tries to escape the archive. ` +
          `Nothing has been read from it.`,
      );
    }
    if (name.endsWith("/")) continue; // a directory entry has no data

    /** ⚠️ ③ — a cheap pre-check on a number the file asserts. */
    if (declaredSize > MAX_INFLATED_BYTES) {
      throw new ZipReadError(
        `"${name}" claims to be ${(declaredSize / 1024 / 1024).toFixed(0)} MB uncompressed, ` +
          `which is beyond what Ordence will read in one file.`,
      );
    }

    if (localOffset + 30 > bytes.length || u32(bytes, localOffset) !== 0x04034b50) {
      throw new ZipReadError(
        `That archive's index points at "${name}" in a place where no entry begins. The file is ` +
          `corrupt.`,
      );
    }
    const localNameLength = u16(bytes, localOffset + 26);
    const localExtraLength = u16(bytes, localOffset + 28);
    const dataAt = localOffset + 30 + localNameLength + localExtraLength;
    const data = bytes.subarray(dataAt, dataAt + compressedSize);

    let content: Uint8Array;
    if (method === 0) {
      content = data;
    } else if (method === 8) {
      /** ⭐ Ours unless the caller supplied a faster one. See the header. */
      content = (inflateRaw ?? pureInflateRaw)(data, declaredSize);
    } else {
      throw new ZipReadError(
        `"${name}" uses compression method ${method}, which Ordence does not read. Spreadsheets ` +
          `written by Excel, LibreOffice, Numbers and Google Sheets all use the standard method.`,
      );
    }

    /** 🔴 ① — the real check, against bytes that actually exist. */
    inflatedTotal += content.length;
    if (inflatedTotal > MAX_INFLATED_BYTES) {
      const ratio = Math.round(inflatedTotal / Math.max(1, bytes.length));
      throw new ZipReadError(
        `That archive expands to more than ${Math.round(MAX_INFLATED_BYTES / 1024 / 1024)} MB ` +
          `from ${(bytes.length / 1024).toFixed(0)} KB — a ratio of about ${ratio} to one. ` +
          `Nothing further has been read. A spreadsheet does not compress like that.`,
      );
    }

    out.set(name, content);
  }

  return out;
}

export function memberText(members: Map<string, Uint8Array>, path: string): string | null {
  const bytes = members.get(path);
  if (!bytes) return null;
  return new TextDecoder("utf-8").decode(bytes);
}
