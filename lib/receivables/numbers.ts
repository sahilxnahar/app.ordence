/**
 * Ordence — Indian Money Formatting & Amounts in Words
 * Version: v0.38.0-alpha
 *
 * Pure and isomorphic. Every amount is `bigint` paise.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THIS DOES NOT USE `Intl.NumberFormat`
 * ══════════════════════════════════════════════════════════════════════
 * `lib/billing/money.ts` formats with `Intl` and is right to: it is
 * turning a subscription total into pixels, and it guards the
 * `Number.isSafeInteger` boundary before it does.
 *
 * This module produces the amount printed on a LEGAL NOTICE, and two
 * things make `Intl` the wrong tool for that:
 *
 *   1. It goes through `Number`. ₹1,00,00,00,000 is fine; the guard makes
 *      the failure visible rather than silent. But a demand is the one
 *      document where "visible failure" is still a document that had to
 *      be re-issued, and string surgery on a bigint cannot fail at all.
 *   2. `Intl` output varies with the ICU build. Node's small-icu, a
 *      different runtime and a different Node version have each been
 *      known to produce a different space or a different minus sign. A
 *      notice that renders differently on two servers is a notice a
 *      buyer can say they never received.
 *
 * So the grouping is done by hand, in exact integer arithmetic, and it
 * produces the same bytes everywhere forever.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE INDIAN GROUPING SYSTEM, WHICH IS NOT GROUPS OF THREE
 * ══════════════════════════════════════════════════════════════════════
 *     1234567  →  12,34,567     (twelve lakh thirty-four thousand …)
 *     NOT         1,234,567
 *
 * The last three digits group together; everything above them groups in
 * TWOS. A demand for ₹1,234,567 printed the Western way is read by an
 * Indian buyer as a different number to the one their agreement states,
 * and the first thing they do is ring to ask which is right.
 */

/* ------------------------------------------------------------------ */
/* GROUPING                                                            */
/* ------------------------------------------------------------------ */

/**
 * Group an integer string in the Indian system: last three, then twos.
 *
 * Takes and returns a STRING, so it is exact for any magnitude — a
 * bigint's digits go in and the same digits come out with commas.
 */
export function groupIndian(digits: string): string {
  const negative = digits.startsWith("-");
  const abs = negative ? digits.slice(1) : digits;

  if (abs.length <= 3) return negative ? `-${abs}` : abs;

  const last3 = abs.slice(-3);
  let rest = abs.slice(0, -3);

  const groups: string[] = [];
  while (rest.length > 2) {
    groups.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  if (rest.length > 0) groups.unshift(rest);

  const joined = `${groups.join(",")},${last3}`;
  return negative ? `-${joined}` : joined;
}

/**
 * Paise → "5,00,000.00". No symbol.
 *
 * ⚠️ ALWAYS TWO DECIMAL PLACES, EVEN WHEN THEY ARE ZERO. "₹5,00,000" and
 * "₹5,00,000.00" are the same money and only one of them looks like a
 * figure that was computed. On a document somebody may have to defend,
 * the paise being visibly zero is worth more than the tidier string.
 */
export function formatPaise(minor: bigint): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const rupees = abs / 100n;
  const paise = abs % 100n;
  const body = `${groupIndian(rupees.toString())}.${paise.toString().padStart(2, "0")}`;
  return negative ? `-${body}` : body;
}

/**
 * Paise → "₹5,00,000.00".
 *
 * ⚠️ THE RUPEE SIGN, NOT "Rs." OR "INR". U+20B9 is what every Indian
 * document uses and what a buyer expects; "Rs." reads as a form somebody
 * typed in 1998. The templates that cannot render the glyph — an SMS
 * gateway on a GSM alphabet — call `formatPaise` and prefix their own
 * word instead, which is a decision for the template and not for this.
 */
export function formatRupees(minor: bigint): string {
  const negative = minor < 0n;
  return `${negative ? "-" : ""}₹${formatPaise(negative ? -minor : minor)}`;
}

/** Basis points → "18.00%". Integers in, exact string out, no floats. */
export function formatRateBps(rateBps: number): string {
  const negative = rateBps < 0;
  const abs = Math.abs(Math.trunc(rateBps));
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  return `${negative ? "-" : ""}${whole}.${String(frac).padStart(2, "0")}%`;
}

/* ------------------------------------------------------------------ */
/* AMOUNTS IN WORDS — ENGLISH                                          */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THE WORDS ARE ON THE NOTICE AT ALL
 * ══════════════════════════════════════════════════════════════════════
 * Indian financial documents state the amount twice — in figures and in
 * words — for one reason: a figure can be altered with a pen and words
 * cannot. It is the same convention as a cheque, and a demand notice is
 * a document that ends up in a file, photocopied, for years.
 *
 * ⚠️ WHICH IS ALSO WHY A WRONG AMOUNT IN WORDS IS WORSE THAN NO AMOUNT
 * IN WORDS. Where the two disagree, the WORDS are conventionally taken
 * to prevail. A half-implemented numbering system that renders ₹4,50,000
 * as the words for ₹45,000 does not produce an ugly notice; it produces a
 * notice that says, in the part that prevails, a number the developer
 * never demanded.
 *
 * So this file implements English and Hindi completely, and
 * `lib/receivables/templates/index.ts` FALLS BACK TO DIGITS for the four
 * languages whose number-words are not implemented here — recording that
 * it fell back, so the gap is reportable rather than invisible.
 */

const EN_ONES = Object.freeze([
  "Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight",
  "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen",
  "Sixteen", "Seventeen", "Eighteen", "Nineteen",
]);

const EN_TENS = Object.freeze([
  "", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty",
  "Ninety",
]);

function enUnder100(n: number): string {
  if (n < 20) return EN_ONES[n] ?? "";
  const tens = EN_TENS[Math.floor(n / 10)] ?? "";
  const ones = n % 10;
  return ones === 0 ? tens : `${tens} ${EN_ONES[ones]}`;
}

function enUnder1000(n: number): string {
  if (n < 100) return enUnder100(n);
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const head = `${EN_ONES[hundreds]} Hundred`;
  return rest === 0 ? head : `${head} ${enUnder100(rest)}`;
}

/**
 * ⭐ THE INDIAN SCALE, NOT THE WESTERN ONE.
 *
 * crore (10^7) → lakh (10^5) → thousand (10^3) → hundred. "Million" and
 * "billion" do not appear on an Indian legal document, and a buyer
 * reading "one point two million" against an agreement that says
 * "₹1,20,00,000" has to do arithmetic to check their own demand.
 *
 * Above 10^9 the units continue — arab, kharab — and are not implemented
 * because they do not appear in residential property. `crore` simply
 * accumulates instead: ₹1,00,00,00,000 reads "One Thousand Crore", which
 * is what an Indian reader expects anyway.
 */
export function amountInWordsEnglish(minor: bigint): string {
  if (minor < 0n) return `Minus ${amountInWordsEnglish(-minor)}`;

  const rupees = minor / 100n;
  const paise = Number(minor % 100n);

  const rupeeWords = integerInWordsEnglish(rupees);

  if (paise === 0) return `Rupees ${rupeeWords} Only`;
  return `Rupees ${rupeeWords} and ${enUnder100(paise)} Paise Only`;
}

/** The integer part alone, without "Rupees" or "Only". */
export function integerInWordsEnglish(value: bigint): string {
  if (value === 0n) return "Zero";
  if (value < 0n) return `Minus ${integerInWordsEnglish(-value)}`;

  const parts: string[] = [];

  const crore = value / 10_000_000n;
  let rest = value % 10_000_000n;
  if (crore > 0n) {
    // ⚠️ RECURSES for the crore count. 1,234 crore is "One Thousand Two
    // Hundred Thirty Four Crore" — a flat `enUnder1000` would silently
    // truncate anything over 999 crore, which is the one magnitude where
    // being wrong is most expensive.
    parts.push(`${integerInWordsEnglish(crore)} Crore`);
  }

  const lakh = Number(rest / 100_000n);
  rest = rest % 100_000n;
  if (lakh > 0) parts.push(`${enUnder1000(lakh)} Lakh`);

  const thousand = Number(rest / 1000n);
  rest = rest % 1000n;
  if (thousand > 0) parts.push(`${enUnder1000(thousand)} Thousand`);

  const remainder = Number(rest);
  if (remainder > 0) parts.push(enUnder1000(remainder));

  return parts.join(" ");
}

/* ------------------------------------------------------------------ */
/* AMOUNTS IN WORDS — HINDI                                            */
/* ------------------------------------------------------------------ */

/**
 * ⭐ HINDI IS IMPLEMENTED IN FULL, AND THAT MEANS ALL NINETY-NINE.
 *
 * ⚠️ HINDI NUMERALS BELOW 100 ARE NOT COMPOSITIONAL. There is no
 * "twenty" + "one" rule: 21 is इक्कीस, 22 is बाईस, 29 is उनतीस. A
 * generated Hindi numeral built the English way — तीस एक for 31 — is not
 * merely stilted, it is not a number, and on the part of the document
 * that prevails over the figures that is a defect and not a typo.
 *
 * So the table is written out. Ninety-nine entries is the price of being
 * able to put words on a Hindi notice at all, and the alternative — a
 * clever partial implementation — is the failure this whole module is
 * organised around avoiding.
 */
const HI_UNDER_100 = Object.freeze([
  "शून्य", "एक", "दो", "तीन", "चार", "पाँच", "छह", "सात", "आठ", "नौ",
  "दस", "ग्यारह", "बारह", "तेरह", "चौदह", "पंद्रह", "सोलह", "सत्रह", "अठारह", "उन्नीस",
  "बीस", "इक्कीस", "बाईस", "तेईस", "चौबीस", "पच्चीस", "छब्बीस", "सत्ताईस", "अट्ठाईस", "उनतीस",
  "तीस", "इकतीस", "बत्तीस", "तैंतीस", "चौंतीस", "पैंतीस", "छत्तीस", "सैंतीस", "अड़तीस", "उनतालीस",
  "चालीस", "इकतालीस", "बयालीस", "तैंतालीस", "चवालीस", "पैंतालीस", "छियालीस", "सैंतालीस", "अड़तालीस", "उनचास",
  "पचास", "इक्यावन", "बावन", "तिरेपन", "चौवन", "पचपन", "छप्पन", "सत्तावन", "अट्ठावन", "उनसठ",
  "साठ", "इकसठ", "बासठ", "तिरसठ", "चौंसठ", "पैंसठ", "छियासठ", "सड़सठ", "अड़सठ", "उनहत्तर",
  "सत्तर", "इकहत्तर", "बहत्तर", "तिहत्तर", "चौहत्तर", "पचहत्तर", "छिहत्तर", "सतहत्तर", "अठहत्तर", "उन्यासी",
  "अस्सी", "इक्यासी", "बयासी", "तिरासी", "चौरासी", "पचासी", "छियासी", "सत्तासी", "अठासी", "नवासी",
  "नब्बे", "इक्यानवे", "बानवे", "तिरानवे", "चौरानवे", "पचानवे", "छियानवे", "सत्तानवे", "अट्ठानवे", "निन्यानवे",
]);

function hiUnder1000(n: number): string {
  if (n < 100) return HI_UNDER_100[n] ?? "";
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const head = `${HI_UNDER_100[hundreds]} सौ`;
  return rest === 0 ? head : `${head} ${HI_UNDER_100[rest]}`;
}

/** The integer part in Hindi, without "रुपये" or "मात्र". */
export function integerInWordsHindi(value: bigint): string {
  if (value === 0n) return "शून्य";
  if (value < 0n) return `ऋण ${integerInWordsHindi(-value)}`;

  const parts: string[] = [];

  const crore = value / 10_000_000n;
  let rest = value % 10_000_000n;
  if (crore > 0n) parts.push(`${integerInWordsHindi(crore)} करोड़`);

  const lakh = Number(rest / 100_000n);
  rest = rest % 100_000n;
  if (lakh > 0) parts.push(`${hiUnder1000(lakh)} लाख`);

  const thousand = Number(rest / 1000n);
  rest = rest % 1000n;
  if (thousand > 0) parts.push(`${hiUnder1000(thousand)} हज़ार`);

  const remainder = Number(rest);
  if (remainder > 0) parts.push(hiUnder1000(remainder));

  return parts.join(" ");
}

/**
 * "रुपये पाँच लाख मात्र".
 *
 * ⚠️ `मात्र` IS THE HINDI EQUIVALENT OF "ONLY" ON A CHEQUE, and it is
 * not decoration: it is what closes the amount so nothing can be written
 * after it. Dropping it produces a phrase that reads, to anybody used to
 * Indian instruments, like an amount somebody stopped writing.
 */
export function amountInWordsHindi(minor: bigint): string {
  if (minor < 0n) return `ऋण ${amountInWordsHindi(-minor)}`;

  const rupees = minor / 100n;
  const paise = Number(minor % 100n);

  const rupeeWords = integerInWordsHindi(rupees);
  if (paise === 0) return `रुपये ${rupeeWords} मात्र`;
  return `रुपये ${rupeeWords} तथा ${HI_UNDER_100[paise] ?? ""} पैसे मात्र`;
}
