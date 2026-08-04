/**
 * Ordence — Billing Money Arithmetic
 * Version: v0.11.0-alpha
 *
 * Isomorphic (no `server-only`) — the pricing page and the invoice
 * renderer both need these, and they must agree to the paisa with the
 * server that actually charges the card. A second implementation on the
 * client is how "the page said ₹5,898 and you charged me ₹5,899" happens.
 *
 * ══════════════════════════════════════════════════════════════════════
 * EVERY FUNCTION HERE TAKES AND RETURNS `bigint` MINOR UNITS
 * ══════════════════════════════════════════════════════════════════════
 * Paise for INR, cents for USD. There is no `number` in any signature
 * that represents money. The only places a monetary value becomes a
 * JavaScript number in this codebase are chart geometry (Phase 10) and
 * nowhere else.
 *
 * Rates are BASIS POINTS (integers): 18% is 1800, not 0.18. A percentage
 * held as a float reintroduces exactly the problem bigint was chosen to
 * avoid, one multiplication later.
 */

/* ------------------------------------------------------------------ */
/* PARSING & FORMATTING                                                */
/* ------------------------------------------------------------------ */

/** Currencies whose minor unit is not 1/100 of the major unit. */
const ZERO_DECIMAL_CURRENCIES = new Set(["JPY", "KRW", "VND", "CLP", "ISK"]);

export function minorUnitExponent(currency: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 0 : 2;
}

/**
 * Decimal string → minor units.
 *
 * Accepts an optional leading `-` because billing genuinely has negative
 * amounts: a proration credit when a customer downgrades mid-cycle is a
 * negative invoice line. (The accounting module's `toMinorUnits` rejects
 * negatives, which is correct there — a journal leg's sign is carried by
 * its debit/credit type, not by the number.)
 */
export function parseMoney(amount: string, currency = "INR"): bigint {
  const exponent = minorUnitExponent(currency);
  const trimmed = amount.trim();

  const pattern =
    exponent === 0 ? /^-?\d{1,15}$/ : new RegExp(`^-?\\d{1,15}(\\.\\d{1,${exponent}})?$`);

  if (!pattern.test(trimmed)) {
    throw new Error(
      `Invalid ${currency} amount "${amount}". ` +
        `Expected up to ${exponent} decimal places, e.g. "${exponent === 0 ? "4999" : "4999.00"}".`,
    );
  }

  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [whole = "0", fraction = ""] = unsigned.split(".");

  const scale = 10n ** BigInt(exponent);
  const paddedFraction = exponent === 0 ? "0" : fraction.padEnd(exponent, "0").slice(0, exponent);

  const magnitude = BigInt(whole) * scale + BigInt(paddedFraction || "0");
  return negative ? -magnitude : magnitude;
}

/** Minor units → plain decimal string. No symbol, no grouping. */
export function formatMoneyPlain(minor: bigint, currency = "INR"): string {
  const exponent = minorUnitExponent(currency);
  if (exponent === 0) return minor.toString();

  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const scale = 10n ** BigInt(exponent);
  const whole = abs / scale;
  const fraction = (abs % scale).toString().padStart(exponent, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/**
 * Minor units → display string with symbol and locale grouping.
 *
 * INR uses the Indian grouping system (lakh/crore): ₹12,34,567.00, not
 * ₹1,234,567.00. `Intl` gets this right for `en-IN` and hand-rolled
 * grouping does not, which is why this delegates rather than slicing
 * strings — but it delegates only the *presentation*, never the
 * arithmetic. The value handed to `Intl` is already final.
 */
export function formatMoney(minor: bigint, currency = "INR"): string {
  const exponent = minorUnitExponent(currency);
  const locale = currency.toUpperCase() === "INR" ? "en-IN" : "en-US";

  // Number is safe here and only here: the value is being turned into
  // pixels, not into another amount. Guarded anyway — a subscription
  // total that exceeds 2^53 paise (₹90 trillion) means something upstream
  // is wrong, and a silently rounded display would hide it.
  const asNumber = Number(minor) / 10 ** exponent;
  if (!Number.isSafeInteger(Number(minor))) {
    return `${currency} ${formatMoneyPlain(minor, currency)}`;
  }

  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  }).format(asNumber);
}

/* ------------------------------------------------------------------ */
/* ROUNDING                                                            */
/* ------------------------------------------------------------------ */

/**
 * Multiply a minor-unit amount by a basis-point rate, rounding half-up.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY HALF-UP AND NOT BANKER'S ROUNDING
 * ══════════════════════════════════════════════════════════════════════
 * Banker's rounding (half-to-even) is the better choice when you are
 * summing thousands of independent values and want the errors to cancel.
 * GST is not that. The rule under Indian tax law is to round the tax
 * amount to the nearest rupee with half rounding up, and an auditor
 * checking one invoice by hand will compute it that way. Matching the
 * statutory method on a document someone will recompute matters more than
 * statistical elegance across a portfolio.
 *
 * Negative amounts round away from zero by the same magnitude, so a
 * proration credit of -₹100 at 18% is exactly the negative of a charge of
 * ₹100 at 18%. Without that symmetry an upgrade followed by an immediate
 * downgrade would leave a stray paisa on the account.
 */
export function applyRateBps(amountMinor: bigint, rateBps: number): bigint {
  if (!Number.isInteger(rateBps) || rateBps < 0) {
    throw new Error(`Rate must be a non-negative integer in basis points. Got ${rateBps}.`);
  }
  const negative = amountMinor < 0n;
  const abs = negative ? -amountMinor : amountMinor;

  const numerator = abs * BigInt(rateBps);
  // +5000 before dividing by 10000 is half-up in exact integer arithmetic.
  const rounded = (numerator + 5000n) / 10_000n;

  return negative ? -rounded : rounded;
}

/**
 * Split a total into `parts` shares that sum EXACTLY back to the total.
 *
 * Naively dividing ₹100 three ways gives 3333 + 3333 + 3333 = 9999 paise
 * and loses a paisa. This distributes the remainder one minor unit at a
 * time across the earliest shares, so the sum is always exact. Used for
 * per-seat allocation and for splitting a proration across line items.
 */
export function splitEvenly(totalMinor: bigint, parts: number): bigint[] {
  if (!Number.isInteger(parts) || parts <= 0) {
    throw new Error(`Cannot split into ${parts} parts.`);
  }
  const n = BigInt(parts);
  const base = totalMinor / n;
  const remainder = totalMinor - base * n;

  const shares: bigint[] = new Array<bigint>(parts).fill(base);
  const step = remainder < 0n ? -1n : 1n;
  let left = remainder < 0n ? -remainder : remainder;

  for (let i = 0; i < parts && left > 0n; i += 1) {
    shares[i] = (shares[i] ?? 0n) + step;
    left -= 1n;
  }
  return shares;
}

/* ------------------------------------------------------------------ */
/* GST                                                                 */
/* ------------------------------------------------------------------ */

/**
 * GST state codes. The first two digits of a GSTIN are the state, and the
 * place of supply determines whether a sale is intra-state (CGST + SGST,
 * split equally) or inter-state (IGST at the full rate).
 *
 * Only the codes needed to validate a GSTIN prefix are listed; the
 * validator checks membership rather than a bare `\d{2}`, because "99" is
 * not a state and an invoice bearing it would be rejected on filing.
 */
export const GST_STATE_CODES: Readonly<Record<string, string>> = Object.freeze({
  "01": "Jammu and Kashmir",
  "02": "Himachal Pradesh",
  "03": "Punjab",
  "04": "Chandigarh",
  "05": "Uttarakhand",
  "06": "Haryana",
  "07": "Delhi",
  "08": "Rajasthan",
  "09": "Uttar Pradesh",
  "10": "Bihar",
  "11": "Sikkim",
  "12": "Arunachal Pradesh",
  "13": "Nagaland",
  "14": "Manipur",
  "15": "Mizoram",
  "16": "Tripura",
  "17": "Meghalaya",
  "18": "Assam",
  "19": "West Bengal",
  "20": "Jharkhand",
  "21": "Odisha",
  "22": "Chhattisgarh",
  "23": "Madhya Pradesh",
  "24": "Gujarat",
  "26": "Dadra and Nagar Haveli and Daman and Diu",
  "27": "Maharashtra",
  "29": "Karnataka",
  "30": "Goa",
  "31": "Lakshadweep",
  "32": "Kerala",
  "33": "Tamil Nadu",
  "34": "Puducherry",
  "35": "Andaman and Nicobar Islands",
  "36": "Telangana",
  "37": "Andhra Pradesh",
  "38": "Ladakh",
  "97": "Other Territory",
});

export type GstBreakdown = {
  cgstMinor: bigint;
  sgstMinor: bigint;
  igstMinor: bigint;
  totalTaxMinor: bigint;
  isInterState: boolean;
};

/**
 * Compute the GST split for a taxable amount.
 *
 * `supplierStateCode` is OUR registered state; `placeOfSupplyCode` is the
 * customer's. Equal means intra-state.
 *
 * The intra-state split uses `splitEvenly`, not `rate / 2` twice. At an
 * odd tax amount — ₹100.01 of tax — halving twice and rounding each half
 * gives ₹50.01 + ₹50.01 = ₹100.02, which does not equal the tax charged.
 * The check constraint on `invoices` would reject the row, and rightly so.
 */
export function computeGst(
  taxableMinor: bigint,
  rateBps: number,
  supplierStateCode: string,
  placeOfSupplyCode: string | null | undefined,
): GstBreakdown {
  const totalTaxMinor = applyRateBps(taxableMinor, rateBps);

  // No place of supply recorded → treat as inter-state. IGST is the safe
  // default: it is a single line at the full rate, so nothing is
  // under-collected, and it is straightforward to correct on a revised
  // invoice. Guessing intra-state could under-collect against a state we
  // are not registered in.
  const isInterState =
    !placeOfSupplyCode || placeOfSupplyCode !== supplierStateCode;

  if (isInterState) {
    return {
      cgstMinor: 0n,
      sgstMinor: 0n,
      igstMinor: totalTaxMinor,
      totalTaxMinor,
      isInterState: true,
    };
  }

  const [cgstMinor = 0n, sgstMinor = 0n] = splitEvenly(totalTaxMinor, 2);
  return { cgstMinor, sgstMinor, igstMinor: 0n, totalTaxMinor, isInterState: false };
}

/**
 * GSTIN structural validation.
 *
 * Format: 2 state digits, 10-char PAN, 1 entity digit, literal 'Z',
 * 1 checksum character. This checks the shape AND the state code AND the
 * mod-36 checksum — a typo'd GSTIN on an invoice is rejected at filing
 * time, weeks later, by which point the customer has already paid against
 * a document that has to be reissued.
 */
export function isValidGstin(gstin: string): boolean {
  const value = gstin.trim().toUpperCase();
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(value)) {
    return false;
  }
  const stateCode = value.slice(0, 2);
  if (!(stateCode in GST_STATE_CODES)) return false;

  return gstinChecksum(value.slice(0, 14)) === value.charAt(14);
}

const GSTIN_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * The official GSTIN check character: weights alternate 1,2,1,2…; each
 * product is folded (quotient + remainder against 36); the check digit is
 * whatever brings the running sum to a multiple of 36.
 */
function gstinChecksum(first14: string): string {
  let sum = 0;
  for (let i = 0; i < first14.length; i += 1) {
    const char = first14.charAt(i);
    const value = GSTIN_ALPHABET.indexOf(char);
    if (value < 0) return "";
    const weight = i % 2 === 0 ? 1 : 2;
    const product = value * weight;
    sum += Math.floor(product / 36) + (product % 36);
  }
  const remainder = sum % 36;
  const checkValue = (36 - remainder) % 36;
  return GSTIN_ALPHABET.charAt(checkValue);
}

/**
 * The check character a GSTIN's first 14 positions demand.
 *
 * Exported for Phase 32, which has to tell somebody WHAT the fifteenth
 * character should have been — "you typed Z, it should be 5" is a typo
 * they can find, and "invalid GSTIN" is not. Returns "" if the first 14
 * characters are not from the GSTIN alphabet at all.
 *
 * ⚠️ `isValidGstin` remains the only gate. This is a diagnostic, and a
 * caller that compares against it INSTEAD of calling `isValidGstin` has
 * skipped the shape and state-code checks.
 */
export function gstinCheckCharacter(first14: string): string {
  return gstinChecksum(first14.trim().toUpperCase().slice(0, 14));
}

/** Extract the state code from a GSTIN, or null if it is not valid. */
export function stateCodeFromGstin(gstin: string | null | undefined): string | null {
  if (!gstin || !isValidGstin(gstin)) return null;
  return gstin.trim().toUpperCase().slice(0, 2);
}

/* ------------------------------------------------------------------ */
/* PRORATION                                                           */
/* ------------------------------------------------------------------ */

export type ProrationResult = {
  /** Credit for unused time on the old plan. Negative or zero. */
  creditMinor: bigint;
  /** Charge for the remainder of the period on the new plan. */
  chargeMinor: bigint;
  /** creditMinor + chargeMinor. Negative means the customer is in credit. */
  netMinor: bigint;
  remainingSeconds: number;
  totalSeconds: number;
};

/**
 * Proration for a mid-cycle plan change.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS PRORATES BY SECONDS AND NOT BY DAYS
 * ══════════════════════════════════════════════════════════════════════
 * Day-based proration has to decide whether the switching day counts, and
 * every answer is arguable. Seconds elapsed against seconds in the period
 * has no such boundary: the customer pays for exactly the time they had.
 * It also sidesteps the 28/29/30/31-day month problem entirely, and DST —
 * a period containing a clock change is 23 or 25 hours longer, and a
 * day-count would silently misprice it.
 *
 * `changeAt` is clamped into the period. A change dated before the period
 * started (clock skew on a webhook) would otherwise produce a credit
 * larger than the amount ever charged.
 */
export function computeProration(args: {
  periodStart: Date;
  periodEnd: Date;
  changeAt: Date;
  oldAmountMinor: bigint;
  newAmountMinor: bigint;
}): ProrationResult {
  const { periodStart, periodEnd, oldAmountMinor, newAmountMinor } = args;

  const startMs = periodStart.getTime();
  const endMs = periodEnd.getTime();
  if (!(endMs > startMs)) {
    throw new Error("Proration period must end after it starts.");
  }

  const changeMs = Math.min(Math.max(args.changeAt.getTime(), startMs), endMs);

  const totalSeconds = Math.floor((endMs - startMs) / 1000);
  const remainingSeconds = Math.floor((endMs - changeMs) / 1000);

  if (totalSeconds <= 0) {
    return {
      creditMinor: 0n,
      chargeMinor: 0n,
      netMinor: 0n,
      remainingSeconds: 0,
      totalSeconds: 0,
    };
  }

  const total = BigInt(totalSeconds);
  const remaining = BigInt(remainingSeconds);

  // Truncating division on both sides, then negating the credit. Truncation
  // rounds each amount toward zero, which means the CREDIT is never
  // overstated and the CHARGE is never overstated either — the residual
  // paisa always falls in the customer's favour by at most one unit. That
  // is the correct direction for an error you cannot eliminate.
  const creditMinor = -((oldAmountMinor * remaining) / total);
  const chargeMinor = (newAmountMinor * remaining) / total;

  return {
    creditMinor,
    chargeMinor,
    netMinor: creditMinor + chargeMinor,
    remainingSeconds,
    totalSeconds,
  };
}

/* ------------------------------------------------------------------ */
/* PERIODS                                                             */
/* ------------------------------------------------------------------ */

export type BillingIntervalName = "monthly" | "quarterly" | "annual";

/**
 * Advance a billing anchor by one interval.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE 31ST-OF-THE-MONTH PROBLEM
 * ══════════════════════════════════════════════════════════════════════
 * A subscription anchored on 31 January has no 31 February to advance to.
 * JavaScript's `Date` will happily roll that over to 2 or 3 March, which
 * silently moves the customer's anchor day forward for the rest of time.
 * By June they are billed on the 3rd and nobody can explain why.
 *
 * So the day is CLAMPED to the last day of the target month — 31 Jan
 * becomes 28 Feb (29 in a leap year) — and the original anchor day is
 * preserved by the caller for the next advance. That is the behaviour
 * customers expect and the behaviour both providers implement.
 *
 * Computed in UTC throughout. A billing anchor that shifts by an hour
 * twice a year because the server observes DST is a support ticket.
 */
export function addInterval(from: Date, interval: BillingIntervalName): Date {
  const monthsToAdd = interval === "monthly" ? 1 : interval === "quarterly" ? 3 : 12;

  const year = from.getUTCFullYear();
  const month = from.getUTCMonth();
  const day = from.getUTCDate();

  const targetMonthIndex = month + monthsToAdd;
  const targetYear = year + Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12;

  // Day 0 of the following month is the last day of the target month.
  const daysInTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const clampedDay = Math.min(day, daysInTargetMonth);

  return new Date(
    Date.UTC(
      targetYear,
      targetMonth,
      clampedDay,
      from.getUTCHours(),
      from.getUTCMinutes(),
      from.getUTCSeconds(),
      from.getUTCMilliseconds(),
    ),
  );
}

/** Add whole days in UTC. Used for trial ends and dunning grace windows. */
export function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}

/* ------------------------------------------------------------------ */
/* SERIALISATION                                                       */
/* ------------------------------------------------------------------ */

/**
 * `JSON.stringify` throws on a bigint — "Do not know how to serialize a
 * BigInt" — which means any server action returning a raw billing row
 * crashes the moment it crosses the RSC boundary. Rather than patching
 * `BigInt.prototype.toJSON` globally (which would change behaviour for
 * every unrelated caller, including libraries), amounts are converted
 * explicitly at the boundary with this helper.
 */
export function serializeAmount(minor: bigint | string | null | undefined): string {
  if (minor === null || minor === undefined) return "0";
  return typeof minor === "bigint" ? minor.toString() : minor;
}

/**
 * Read a minor-unit amount back out of a database row.
 *
 * Drizzle returns `bigint` columns as strings under `mode: "bigint"` in
 * some driver paths and as bigints in others, depending on whether the
 * query went through the HTTP or the WebSocket client. Normalising here
 * means no call site has to care which one it got.
 */
export function toBigIntAmount(value: bigint | string | number | null | undefined): bigint {
  if (value === null || value === undefined) return 0n;
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`Unsafe numeric amount ${value} — money must not arrive as a float.`);
    }
    return BigInt(value);
  }
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new Error(`Malformed minor-unit amount "${value}".`);
  }
  return BigInt(trimmed);
}

/** Sum a column of minor-unit amounts exactly. */
export function sumAmounts(
  values: readonly (bigint | string | number | null | undefined)[],
): bigint {
  return values.reduce<bigint>((total, value) => total + toBigIntAmount(value), 0n);
}
