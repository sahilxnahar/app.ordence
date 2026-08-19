/**
 * Ordence — ⭐ Invoice-Number Normalisation
 * Version: v0.34.0-alpha
 *
 * Pure. No database, no I/O.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE ONE RULE THIS FILE EXISTS TO PROTECT
 * ══════════════════════════════════════════════════════════════════════
 * NORMALISATION IS FOR COMPARISON ONLY. THE SUPPLIER'S NUMBER IS NEVER
 * REWRITTEN.
 *
 * The temptation, on discovering that `INV-001` and `INV/001` are the
 * same bill, is to "clean up" one of them. It is wrong for a reason that
 * has nothing to do with data hygiene:
 *
 *     The number in GSTR-2B is the number the SUPPLIER filed. It is what
 *     the portal holds, what appears on any notice, and what has to be
 *     quoted in every letter to that supplier and every reply to the
 *     department. Ours is what is printed on the paper in our file.
 *
 *     They are both correct and they are both evidence. Overwriting
 *     either one destroys the ability to say "their document says X, our
 *     document says Y, here is why they are the same supply" — which is
 *     the entire content of the answer an officer wants.
 *
 * So `gstr2b_rows.invoice_number` and `purchase_invoices.invoice_number`
 * are both left exactly as received, and the normalised form lives beside
 * them as a lookup key.
 *
 * ══════════════════════════════════════════════════════════════════════
 * TWO LEVELS OF NORMALISATION, AND THEY MEAN DIFFERENT THINGS
 * ══════════════════════════════════════════════════════════════════════
 *   canonicalise — upper-case, trim, collapse internal whitespace.
 *                  Two strings that differ only this much are THE SAME
 *                  STRING typed by two people. This is the same rule the
 *                  Phase 33 duplicate-bill index uses (`upper(btrim(…))`),
 *                  deliberately, so "is this the same number" has one
 *                  answer in the index and in the engine.
 *
 *   normalise    — additionally strip every non-alphanumeric character
 *                  and every leading zero within each run of digits.
 *                  Two strings that agree only after THIS are merely
 *                  CANDIDATES. ⚠️ Never sufficient on its own — see the
 *                  collision note on `normaliseInvoiceNumber`.
 */

/**
 * Upper-case, trimmed, internal whitespace collapsed to a single space.
 *
 * ⚠️ WHITESPACE IS COLLAPSED, NOT REMOVED. `INV 001` and `INV001` are
 * NOT the same string at this level — the first has a separator and the
 * second does not, and treating them as identical here would let a
 * genuine formatting difference be recorded as an EXACT match. It is a
 * `number_mismatch`, which is a category that puts a person in the loop.
 */
export function canonicaliseInvoiceNumber(raw: string | null | undefined): string {
  if (raw == null) return "";
  return raw.trim().toUpperCase().replace(/\s+/g, " ");
}

/**
 * ⭐ The candidate key: alphanumerics only, leading zeros stripped from
 * each run of digits.
 *
 *     INV-001   → INV1
 *     INV/001   → INV1
 *     INV 001   → INV1
 *     inv001    → INV1
 *     INV1      → INV1
 *     INV-002   → INV2      (correctly DIFFERENT)
 *     INV-010   → INV10     (correctly different from INV-100 → INV100)
 *     2024/INV/001 → 2024INV1  (correctly different from INV-001)
 *
 * ⚠️ ZEROS ARE STRIPPED PER RUN, NOT GLOBALLY. A global `replace(/0/g,'')`
 * would turn `INV-100` into `INV1` and merge it with `INV-001`, which are
 * two different invoices from the same supplier in the same month. Only
 * zeros at the FRONT of a digit run are padding; the rest are the number.
 *
 * ⚠️ AND A RUN OF ONLY ZEROS KEEPS ONE. `INV-000` → `INV0`, not `INV`.
 * Dropping it entirely would merge every all-zero serial with the
 * prefix alone.
 *
 * ⚠️⚠️ THIS FUNCTION CAN COLLIDE, AND THE ENGINE IS BUILT ON THAT
 * ASSUMPTION. `A-1-2` and `A-12` both normalise to `A12`; so do `AB/0/1`
 * and `AB01`. There is no normalisation that separates them without also
 * separating `INV-001` from `INV/001`, which is the case that matters
 * ten thousand times more often.
 *
 * The engine therefore NEVER treats an agreement here as a match on its
 * own. A `number_mismatch` additionally requires the same supplier
 * GSTIN, the same invoice date and the same taxable value — three
 * independent facts that a genuine collision will not also satisfy — and
 * it is never auto-accepted. See `lib/gstr2b/matching.ts`.
 */
export function normaliseInvoiceNumber(raw: string | null | undefined): string {
  if (raw == null) return "";
  const upper = raw.trim().toUpperCase();

  let out = "";
  let index = 0;

  while (index < upper.length) {
    const ch = upper[index]!;

    if (ch >= "0" && ch <= "9") {
      // Consume the whole digit run, then drop its leading zeros.
      let end = index;
      while (end < upper.length && upper[end]! >= "0" && upper[end]! <= "9") end += 1;
      const run = upper.slice(index, end);
      const trimmed = run.replace(/^0+/, "");
      out += trimmed === "" ? "0" : trimmed;
      index = end;
      continue;
    }

    // ⚠️ `A-Z` only, deliberately. A supplier's number can carry Devanagari
    // or an accented character from a copy-paste, and `\w` under Unicode
    // would keep those while `[A-Z0-9]` drops them — which is the safer
    // direction, because a stray invisible character is exactly what makes
    // two identical-looking numbers fail to match.
    if (ch >= "A" && ch <= "Z") out += ch;

    index += 1;
  }

  return out;
}

/** The same number, typed twice. Case and spacing do not make it different. */
export function invoiceNumbersIdentical(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const left = canonicaliseInvoiceNumber(a);
  return left !== "" && left === canonicaliseInvoiceNumber(b);
}

/**
 * ⭐ The same number, formatted differently — a CANDIDATE, not a match.
 *
 * ⚠️ RETURNS FALSE FOR TWO IDENTICAL NUMBERS ONLY IN THE SENSE THAT IT
 * ALSO RETURNS TRUE FOR THEM. Equivalence is the weaker test and
 * identical numbers satisfy it. Callers that need "differs only in
 * punctuation" ask for `invoiceNumbersEquivalent && !invoiceNumbersIdentical`.
 */
export function invoiceNumbersEquivalent(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const left = normaliseInvoiceNumber(a);
  return left !== "" && left === normaliseInvoiceNumber(b);
}

/**
 * A sentence describing how two numbers differ, or `null` when they are
 * the same string.
 *
 * Written for the workbench, where the question is always "why does this
 * need me" and the answer has to fit on one line beside the row.
 */
export function describeNumberDifference(
  twoBNumber: string,
  bookNumber: string,
): string | null {
  if (invoiceNumbersIdentical(twoBNumber, bookNumber)) return null;

  if (invoiceNumbersEquivalent(twoBNumber, bookNumber)) {
    return (
      `The supplier filed "${twoBNumber}"; the bill was entered as "${bookNumber}". ` +
      `The two differ only in punctuation, spacing or leading zeros. ` +
      `⚠️ The supplier's number is the one the portal holds — quote theirs in any ` +
      `correspondence, and do not overwrite it with ours.`
    );
  }

  return (
    `The supplier filed "${twoBNumber}"; the bill was entered as "${bookNumber}". ` +
    `These are different numbers, not different formatting.`
  );
}
