/**
 * Ordence — ⭐⭐ A ZIP WRITER, BECAUSE XLSX AND DOCX ARE ZIPS
 * Version: v1.73.0-alpha · Wave 5
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS IS HAND-WRITTEN AND NOT AN npm INSTALL
 * ══════════════════════════════════════════════════════════════════════
 * Wave 5 adds six output formats. The obvious route is four dependencies
 * — a spreadsheet library, a PDF library, a Word library and a zipper —
 * and each one is:
 *
 *   ⚠️ WEIGHT IN A BUILD THAT IS ALREADY OOM-KILLED. `next build` is
 *      killed by the 8GB limit in this container today, before any of
 *      them. ExcelJS alone is ~5MB unpacked and pulls a stream stack.
 *   ⚠️ A SUPPLY-CHAIN SURFACE on the path that emits the customer's
 *      complete financial data.
 *   ⚠️ A LICENCE TO READ. Two of the popular PDF libraries are AGPL.
 *
 * The whole of ZIP-as-XLSX-and-DOCX needs is: store or deflate an entry,
 * a CRC-32, a local header, a central directory and an end record. That
 * is this file, in about two hundred lines, with no runtime import at all.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ PURE, AND COMPRESSION IS INJECTED
 * ══════════════════════════════════════════════════════════════════════
 * `node:zlib` is not imported here — this file runs anywhere, including
 * the edge runtime, and `scripts/check-server-boundaries.mjs` stays
 * quiet. The SERVER passes `deflateRaw` in; without it every entry is
 * STORED, which is a larger file and a completely valid archive that
 * Excel, Word, macOS Archive Utility and `unzip` all open.
 *
 * ⚠️ DETERMINISTIC. The timestamp comes from the caller, never from a
 * clock, so the same workbook exported twice is byte-for-byte identical
 * and the tests can assert on it.
 */

export type ZipEntry = {
  /** Forward-slash path inside the archive. No leading slash. */
  readonly path: string;
  readonly bytes: Uint8Array;
};

/** A raw-deflate function. Node's `zlib.deflateRawSync`, when available. */
export type DeflateRaw = (input: Uint8Array) => Uint8Array;

export class ZipTooLargeError extends Error {
  constructor(bytes: number) {
    super(
      `This export is ${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB, which is beyond the 4 GB ` +
        `limit of the classic ZIP format. Nothing has been written. Export a narrower date range, ` +
        `or export the datasets one at a time — a truncated archive that opens and is missing rows ` +
        `is the failure this refusal exists to prevent.`,
    );
    this.name = "ZipTooLargeError";
  }
}

/* ------------------------------------------------------------------ */
/* CRC-32                                                              */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ THE TABLE IS BUILT ONCE. A per-byte polynomial loop over a 20MB
 * spreadsheet is 160 million iterations; the table makes it 20 million.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/* ------------------------------------------------------------------ */
/* MS-DOS DATE AND TIME                                                */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ ZIP STORES TIME IN THE 1980 MS-DOS FORMAT, WITH TWO-SECOND
 * RESOLUTION AND NO TIME ZONE. A date before 1980 cannot be represented,
 * so it is clamped rather than wrapped — a wrapped year produces an
 * archive whose entries are dated 2107 and some tools refuse it.
 */
function dosDateTime(at: Date): { date: number; time: number } {
  const year = Math.max(1980, at.getUTCFullYear());
  const date =
    (((year - 1980) & 0x7f) << 9) | (((at.getUTCMonth() + 1) & 0x0f) << 5) | (at.getUTCDate() & 0x1f);
  const time =
    ((at.getUTCHours() & 0x1f) << 11) |
    ((at.getUTCMinutes() & 0x3f) << 5) |
    ((at.getUTCSeconds() >> 1) & 0x1f);
  return { date, time };
}

/* ------------------------------------------------------------------ */
/* THE WRITER                                                          */
/* ------------------------------------------------------------------ */

class ByteSink {
  private chunks: Uint8Array[] = [];
  length = 0;

  push(bytes: Uint8Array): void {
    this.chunks.push(bytes);
    this.length += bytes.length;
  }

  u16(value: number): void {
    this.push(new Uint8Array([value & 0xff, (value >>> 8) & 0xff]));
  }

  u32(value: number): void {
    this.push(
      new Uint8Array([
        value & 0xff,
        (value >>> 8) & 0xff,
        (value >>> 16) & 0xff,
        (value >>> 24) & 0xff,
      ]),
    );
  }

  concat(): Uint8Array {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

export function buildZip(
  entries: readonly ZipEntry[],
  options: { readonly at: Date; readonly deflateRaw?: DeflateRaw },
): Uint8Array {
  const { date, time } = dosDateTime(options.at);
  const encoder = new TextEncoder();

  const body = new ByteSink();
  const central = new ByteSink();

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.path);
    const raw = entry.bytes;
    const checksum = crc32(raw);

    /**
     * ⚠️ COMPRESSION IS ONLY USED WHEN IT HELPS. Deflating an already
     * compressed payload — a PNG dropped into a zip of attachments —
     * makes it larger. Comparing and keeping the smaller is two lines and
     * it is the difference between "we compress" and "we compress
     * usefully".
     */
    let stored = raw;
    let method = 0;
    if (options.deflateRaw) {
      const deflated = options.deflateRaw(raw);
      if (deflated.length < raw.length) {
        stored = deflated;
        method = 8;
      }
    }

    const localOffset = body.length;

    body.u32(0x04034b50);
    body.u16(method === 8 ? 20 : 10); // version needed
    /**
     * 🔴 BIT 11 IS THE UTF-8 FLAG. Without it a file called
     * `विक्रय-रजिस्टर.csv` inside the archive is read in the extractor's
     * local code page and arrives as mojibake. Ordence is an Indian
     * product; this bit is not optional.
     */
    body.u16(0x0800);
    body.u16(method);
    body.u16(time);
    body.u16(date);
    body.u32(checksum);
    body.u32(stored.length);
    body.u32(raw.length);
    body.u16(nameBytes.length);
    body.u16(0); // extra field length
    body.push(nameBytes);
    body.push(stored);

    central.u32(0x02014b50);
    central.u16(0x031e); // version made by: 3.0, unix
    central.u16(method === 8 ? 20 : 10);
    central.u16(0x0800);
    central.u16(method);
    central.u16(time);
    central.u16(date);
    central.u32(checksum);
    central.u32(stored.length);
    central.u32(raw.length);
    central.u16(nameBytes.length);
    central.u16(0); // extra
    central.u16(0); // comment
    central.u16(0); // disk
    central.u16(0); // internal attrs
    central.u32(0o100644 << 16); // external attrs: -rw-r--r--
    central.u32(localOffset);
    central.push(nameBytes);

    if (body.length > 0xffffffff) throw new ZipTooLargeError(body.length);
  }

  const centralOffset = body.length;
  const centralBytes = central.concat();

  const end = new ByteSink();
  end.u32(0x06054b50);
  end.u16(0);
  end.u16(0);
  end.u16(entries.length);
  end.u16(entries.length);
  end.u32(centralBytes.length);
  end.u32(centralOffset);
  end.u16(0);

  const bodyBytes = body.concat();
  const endBytes = end.concat();

  const total = bodyBytes.length + centralBytes.length + endBytes.length;
  if (total > 0xffffffff) throw new ZipTooLargeError(total);

  const out = new Uint8Array(total);
  out.set(bodyBytes, 0);
  out.set(centralBytes, bodyBytes.length);
  out.set(endBytes, bodyBytes.length + centralBytes.length);
  return out;
}
