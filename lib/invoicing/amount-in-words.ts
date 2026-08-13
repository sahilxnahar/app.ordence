/**
 * Ordence — ⭐ Rupees in words, Indian numbering
 * Version: v0.97.0-alpha
 *
 * Pure. Takes `bigint` paise and returns the words that go on the face of
 * an invoice.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THIS IS NOT OPTIONAL DECORATION
 * ══════════════════════════════════════════════════════════════════════
 * The amount in words is the tie-breaker. When the figure is smudged,
 * mis-keyed, or altered after signing, the words are what a court and a
 * bank read. Every Indian invoice, cheque and demand carries them, and an
 * invoice without them is the one an accounts department sends back.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 INDIAN GROUPING, NOT WESTERN. THIS IS THE WHOLE FILE.
 * ══════════════════════════════════════════════════════════════════════
 *      1,00,000  →  One Lakh              (not "One Hundred Thousand")
 *  1,00,00,000  →  One Crore              (not "Ten Million")
 *
 * A library that groups in thousands produces "Eleven Million Eight
 * Hundred Thousand" on a document that has to say "One Crore Eighteen
 * Lakh". Both are the same money and only one of them is read without
 * hesitation by the person paying it — which is the entire job.
 *
 * ⚠️ AND IT TAKES `bigint`, NEVER A NUMBER. `Number.MAX_SAFE_INTEGER` is
 * about ₹90,07,19,92,54,740 in paise. That is reachable by a real
 * contract value in this industry, and the failure mode of exceeding it
 * is a silently wrong word on a legal document.
 */

const ONES = [
  "",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Eleven",
  "Twelve",
  "Thirteen",
  "Fourteen",
  "Fifteen",
  "Sixteen",
  "Seventeen",
  "Eighteen",
  "Nineteen",
] as const;

const TENS = [
  "",
  "",
  "Twenty",
  "Thirty",
  "Forty",
  "Fifty",
  "Sixty",
  "Seventy",
  "Eighty",
  "Ninety",
] as const;

/** 0–99. */
function underHundred(n: bigint): string {
  if (n < 20n) return ONES[Number(n)] ?? "";
  const tens = TENS[Number(n / 10n)] ?? "";
  const rest = ONES[Number(n % 10n)] ?? "";
  return rest ? `${tens} ${rest}` : tens;
}

/** 0–999. */
function underThousand(n: bigint): string {
  const hundreds = n / 100n;
  const rest = n % 100n;
  if (hundreds === 0n) return underHundred(rest);
  const head = `${ONES[Number(hundreds)]} Hundred`;
  return rest === 0n ? head : `${head} ${underHundred(rest)}`;
}

const THOUSAND = 1_000n;
const LAKH = 100_000n;
const CRORE = 10_000_000n;

/**
 * A whole number in Indian words.
 *
 * ⚠️ THE CRORE BRANCH RECURSES, and that is deliberate. Above a crore
 * the conventions diverge — some say "arab", most say "one thousand
 * crore" — and recursion produces the form people actually read aloud:
 * `1,00,00,00,00,000` becomes "One Lakh Crore", not a unit nobody in the
 * room recognises.
 */
export function wholeNumberInWords(value: bigint): string {
  if (value === 0n) return "Zero";
  if (value < 0n) return `Minus ${wholeNumberInWords(-value)}`;

  const parts: string[] = [];

  if (value >= CRORE) {
    parts.push(`${wholeNumberInWords(value / CRORE)} Crore`);
    value %= CRORE;
  }
  if (value >= LAKH) {
    parts.push(`${underHundred(value / LAKH)} Lakh`);
    value %= LAKH;
  }
  if (value >= THOUSAND) {
    parts.push(`${underHundred(value / THOUSAND)} Thousand`);
    value %= THOUSAND;
  }
  if (value > 0n) {
    parts.push(underThousand(value));
  }

  return parts.join(" ");
}

/**
 * ⭐ The line that goes on the invoice.
 *
 * ⚠️ PAISE ARE SPOKEN SEPARATELY, NEVER AS A DECIMAL. "One Thousand
 * Point Five Zero Rupees" is not a form anyone uses; the convention is
 * "… Rupees and Fifty Paise Only". Getting this wrong is not a rounding
 * error, it is a document that reads as though a machine wrote it.
 *
 * ⚠️ "ONLY" IS PART OF THE INSTRUMENT, NOT POLITENESS. It terminates the
 * amount so nothing can be appended after it — the same reason it appears
 * on a cheque. Dropping it because it looks redundant removes a control.
 *
 * ⚠️ NEGATIVES ARE SPELLED "MINUS", NOT SHOWN WITH A SIGN. A credit note
 * is printed as a positive reversal, so this should rarely fire — but if
 * it ever does, a minus sign in front of words is the kind of thing that
 * gets read straight past.
 */
export function rupeesInWords(minorUnits: bigint): string {
  const negative = minorUnits < 0n;
  const abs = negative ? -minorUnits : minorUnits;

  const rupees = abs / 100n;
  const paise = abs % 100n;

  const head = `${wholeNumberInWords(rupees)} ${rupees === 1n ? "Rupee" : "Rupees"}`;
  const tail = paise > 0n ? ` and ${underHundred(paise)} Paise` : "";

  return `${negative ? "Minus " : ""}${head}${tail} Only`;
}
