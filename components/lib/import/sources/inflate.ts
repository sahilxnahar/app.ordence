/**
 * Ordence — ⭐⭐ RAW DEFLATE, DECODED IN ABOUT TWO HUNDRED LINES
 * Version: v1.74.0-alpha · Wave 6
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS EXISTS RATHER THAN `node:zlib` OR `DecompressionStream`
 * ══════════════════════════════════════════════════════════════════════
 * The customer's migration file is read IN THEIR BROWSER — that is the
 * whole reason it never has to be uploaded to us — and an .xlsx is a zip
 * whose parts are raw-deflated. So the reader needs an inflater that
 * works in a browser.
 *
 *   `node:zlib`            does not exist there.
 *   `DecompressionStream`  does, and it is ASYNCHRONOUS. Threading a
 *                          promise through a zip central-directory walk
 *                          to avoid two hundred lines is a worse trade
 *                          than the two hundred lines, and it would make
 *                          every caller async for no benefit.
 *   a dependency           `lib/import/csv.ts` already argued this for
 *                          the CSV parser: *"a pure state machine over a
 *                          string with a specification that has not
 *                          changed since 2005"*. RFC 1951 has not changed
 *                          since 1996.
 *
 * ⭐ SO: pure, synchronous, no imports, works in a browser, in Node, in a
 * test and in the edge runtime. The SERVER may still pass Node's
 * `inflateRawSync` — it is faster — and `lib/import/sources/unzip.ts`
 * takes it as a parameter, so this is the FALLBACK rather than the only
 * path.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT IT REFUSES
 * ══════════════════════════════════════════════════════════════════════
 * Everything malformed, loudly, with the bit position. A silent partial
 * inflate produces a truncated sheet — half a customer list — which
 * imports perfectly and is missing four thousand rows.
 */

export class InflateError extends Error {
  constructor(message: string) {
    super(
      `${message} The spreadsheet's compressed data is damaged. Nothing has been read from it. ` +
        `Re-saving the file from Excel usually fixes this; if it does not, the download was ` +
        `interrupted.`,
    );
    this.name = "InflateError";
  }
}

/** RFC 1951 §3.2.5 — the length codes' base values and extra bits. */
const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258,
];
const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];
/** §3.2.7 — the order the code-length code lengths themselves arrive in. */
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/**
 * ⚠️ A CANONICAL HUFFMAN TABLE, DECODED BIT BY BIT RATHER THAN BY A
 * LOOKUP TABLE. Slower per symbol and impossible to get subtly wrong —
 * the fast version needs a reversed-bit table whose off-by-one produces
 * plausible garbage rather than an error.
 */
type Huffman = {
  /** counts[n] = how many codes have length n. */
  readonly counts: Int32Array;
  /** symbols in canonical order. */
  readonly symbols: Int32Array;
};

function buildHuffman(lengths: Int32Array | number[], count: number): Huffman {
  const counts = new Int32Array(16);
  for (let i = 0; i < count; i += 1) {
    const length = lengths[i] ?? 0;
    /**
     * ⚠️ REFUSED RATHER THAN CLAMPED. A code length above 15 cannot exist
     * in DEFLATE, and silently treating it as 15 builds a table that
     * decodes to plausible garbage rather than failing.
     */
    if (length < 0 || length > 15) {
      throw new InflateError(`A code length of ${length} was found, and DEFLATE allows 0 to 15.`);
    }
    /** ⚠️ `?? 0` because the compiler cannot see that `length` is in range. */
    counts[length] = (counts[length] ?? 0) + 1;
  }
  counts[0] = 0;

  const offsets = new Int32Array(16);
  for (let n = 1; n < 16; n += 1) offsets[n] = (offsets[n - 1] ?? 0) + (counts[n - 1] ?? 0);

  const symbols = new Int32Array(count);
  for (let i = 0; i < count; i += 1) {
    const length = lengths[i] ?? 0;
    if (length !== 0) {
      symbols[offsets[length] ?? 0] = i;
      offsets[length] = (offsets[length] ?? 0) + 1;
    }
  }
  return { counts, symbols };
}

class BitReader {
  private at = 0;
  private bit = 0;

  constructor(private readonly bytes: Uint8Array) {}

  /** One bit, least significant first. */
  read1(): number {
    if (this.at >= this.bytes.length) {
      throw new InflateError(`Ran out of data at byte ${this.at}.`);
    }
    const value = (this.bytes[this.at]! >> this.bit) & 1;
    this.bit += 1;
    if (this.bit === 8) {
      this.bit = 0;
      this.at += 1;
    }
    return value;
  }

  read(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i += 1) value |= this.read1() << i;
    return value;
  }

  alignToByte(): void {
    if (this.bit !== 0) {
      this.bit = 0;
      this.at += 1;
    }
  }

  get bytePosition(): number {
    return this.at;
  }

  copyBytes(count: number): Uint8Array {
    if (this.at + count > this.bytes.length) {
      throw new InflateError(
        `A stored block claims ${count} bytes and only ${this.bytes.length - this.at} remain.`,
      );
    }
    const out = this.bytes.subarray(this.at, this.at + count);
    this.at += count;
    return out;
  }

  decode(table: Huffman): number {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let length = 1; length < 16; length += 1) {
      code |= this.read1();
      const count = table.counts[length]!;
      if (code - first < count) return table.symbols[index + (code - first)]!;
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new InflateError(`An invalid Huffman code was found at byte ${this.at}.`);
  }
}

/** ⚠️ Refuses rather than truncating. A truncated sheet imports fine. */
export function inflateRaw(input: Uint8Array, expectedSize?: number): Uint8Array {
  const reader = new BitReader(input);
  /**
   * ⚠️ THE OUTPUT GROWS RATHER THAN BEING PRE-SIZED FROM `expectedSize`.
   * That number comes from the archive's own header and is an assertion
   * by whoever wrote the file, not a fact — `lib/import/sources/unzip.ts`
   * says so. It is used as a HINT for the initial allocation and never as
   * a bound.
   */
  let out = new Uint8Array(Math.max(1024, Math.min(expectedSize ?? 0, 1 << 22) || 1024));
  let length = 0;

  const push = (byte: number) => {
    if (length === out.length) {
      const bigger = new Uint8Array(out.length * 2);
      bigger.set(out);
      out = bigger;
    }
    out[length] = byte;
    length += 1;
  };

  let fixedLiteral: Huffman | null = null;
  let fixedDistance: Huffman | null = null;

  for (;;) {
    const final = reader.read1();
    const type = reader.read(2);

    if (type === 0) {
      /* §3.2.4 — a stored block. */
      reader.alignToByte();
      const len = reader.read(16);
      const nlen = reader.read(16);
      if ((len ^ 0xffff) !== nlen) {
        throw new InflateError(
          `A stored block's length and its complement disagree at byte ${reader.bytePosition}.`,
        );
      }
      const block = reader.copyBytes(len);
      for (const byte of block) push(byte);
    } else if (type === 1 || type === 2) {
      let literal: Huffman;
      let distance: Huffman;

      if (type === 1) {
        /* §3.2.6 — the fixed tables, built once. */
        if (!fixedLiteral || !fixedDistance) {
          const literalLengths = new Int32Array(288);
          for (let i = 0; i < 144; i += 1) literalLengths[i] = 8;
          for (let i = 144; i < 256; i += 1) literalLengths[i] = 9;
          for (let i = 256; i < 280; i += 1) literalLengths[i] = 7;
          for (let i = 280; i < 288; i += 1) literalLengths[i] = 8;
          fixedLiteral = buildHuffman(literalLengths, 288);
          const distanceLengths = new Int32Array(30).fill(5);
          fixedDistance = buildHuffman(distanceLengths, 30);
        }
        literal = fixedLiteral;
        distance = fixedDistance;
      } else {
        /* §3.2.7 — dynamic tables, described by a third table. */
        const hlit = reader.read(5) + 257;
        const hdist = reader.read(5) + 1;
        const hclen = reader.read(4) + 4;

        const codeLengths = new Int32Array(19);
        for (let i = 0; i < hclen; i += 1) {
          codeLengths[CODE_LENGTH_ORDER[i]!] = reader.read(3);
        }
        const codeTable = buildHuffman(codeLengths, 19);

        const lengths = new Int32Array(hlit + hdist);
        let i = 0;
        while (i < hlit + hdist) {
          const symbol = reader.decode(codeTable);
          if (symbol < 16) {
            lengths[i] = symbol;
            i += 1;
          } else if (symbol === 16) {
            if (i === 0) {
              throw new InflateError("A code-length repeat appeared before any code length.");
            }
            const previous = lengths[i - 1]!;
            const repeat = 3 + reader.read(2);
            for (let n = 0; n < repeat; n += 1) lengths[i + n] = previous;
            i += repeat;
          } else if (symbol === 17) {
            const repeat = 3 + reader.read(3);
            i += repeat;
          } else {
            const repeat = 11 + reader.read(7);
            i += repeat;
          }
        }
        if (i > hlit + hdist) {
          throw new InflateError("A code-length repeat ran past the end of the table.");
        }

        literal = buildHuffman(lengths.subarray(0, hlit), hlit);
        distance = buildHuffman(lengths.subarray(hlit), hdist);
      }

      for (;;) {
        const symbol = reader.decode(literal);
        if (symbol < 256) {
          push(symbol);
          continue;
        }
        if (symbol === 256) break; // end of block

        const lengthIndex = symbol - 257;
        if (lengthIndex >= LENGTH_BASE.length) {
          throw new InflateError(`Length code ${symbol} is not defined.`);
        }
        const matchLength = LENGTH_BASE[lengthIndex]! + reader.read(LENGTH_EXTRA[lengthIndex]!);

        const distanceSymbol = reader.decode(distance);
        if (distanceSymbol >= DIST_BASE.length) {
          throw new InflateError(`Distance code ${distanceSymbol} is not defined.`);
        }
        const matchDistance =
          DIST_BASE[distanceSymbol]! + reader.read(DIST_EXTRA[distanceSymbol]!);

        if (matchDistance > length) {
          throw new InflateError(
            `A back-reference points ${matchDistance} bytes back with only ${length} decoded.`,
          );
        }
        /**
         * ⚠️ COPIED BYTE BY BYTE AND NOT WITH `set()`. Overlapping copies
         * are legal and common — that is how DEFLATE encodes a run — and
         * a bulk copy of a source that the destination overlaps produces
         * the wrong bytes.
         */
        for (let n = 0; n < matchLength; n += 1) push(out[length - matchDistance]!);
      }
    } else {
      throw new InflateError(`Block type 3 is reserved and is not valid.`);
    }

    if (final) break;
  }

  return out.subarray(0, length);
}
