/**
 * Ordence — ⭐⭐⭐ CURRENCY MINOR UNITS — THE EXPONENT IS PER CURRENCY
 * Batch 0101 · Multi-currency and FX
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS FILE EXISTS
 * ══════════════════════════════════════════════════════════════════════
 * There are sixteen `currency` columns across `db/schema/`. Until this
 * batch not one of them was read by anything that computes. The nearest
 * thing to currency logic in the product was a REFUSAL in
 * `server/actions/accounting.ts` — "All ledgers in a transaction must use
 * X" — which is not conversion, it is a locked door.
 *
 * 🔴 AND THE ONE PIECE OF EXPONENT LOGIC THAT DID EXIST WAS WRONG.
 * `lib/billing/money.ts` carried:
 *
 *     const ZERO_DECIMAL_CURRENCIES = new Set(["JPY","KRW","VND","CLP","ISK"]);
 *     minorUnitExponent = code => ZERO_DECIMAL.has(code) ? 0 : 2;
 *
 * That is right for the five it names and for most of the rest, and it is
 * WRONG BY A FACTOR OF TEN for the Gulf. KWD, BHD, OMR, JOD, TND, LYD and
 * IQD have THREE decimal places: 1 dinar is 1000 fils. Under the old
 * function `formatMoneyPlain(1234n, "KWD")` printed "12.34" for a value
 * that is 1.234 dinars, and `parseMoney("1.234","KWD")` threw. An invoice
 * to Kuwait was out by 10x in the display and unenterable in the form.
 *
 * ⚠️ AND IT DEFAULTED. An unrecognised code silently became two decimals.
 * A default is how a wrong answer gets produced confidently, which is the
 * defect pattern this whole batch exists to stop repeating, so
 * `minorUnitExponent` below REFUSES a code it does not know by name.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THIS FILE IS PURE
 * ══════════════════════════════════════════════════════════════════════
 * No `server-only`, no database, no clock. The exponent table is also
 * seeded into `currency_units` by SQL 0101 so that SQL-side reporting can
 * scale correctly; `server/fx/rate-service.ts#verifyCurrencyUnits()`
 * compares the two and reports a divergence rather than letting the copies
 * drift in silence.
 */

export class UnknownCurrencyError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(
      `"${code}" is not a currency this system knows. Nothing has been converted or formatted. ` +
        `A currency whose minor unit is unknown cannot be turned into money without guessing the ` +
        `number of decimal places, and a guess of two is wrong by a factor of ten for the Gulf dinars.`,
    );
    this.name = "UnknownCurrencyError";
    this.code = code;
  }
}

/**
 * 🔴 THE ONLY CURRENCIES WITH NO MINOR UNIT AT ALL. One yen is one yen;
 * there is no sen in circulation. An amount in JPY held as "minor units"
 * IS the yen count, and dividing it by 100 for display invents two
 * decimal places that do not exist and understates the figure 100-fold.
 */
const EXPONENT_0 = [
  "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG",
  "RWF", "UGX", "UYI", "VND", "VUV", "WST", "XAF", "XOF", "XPF",
] as const;

/**
 * 🔴 THE THOUSANDTHS. 1 Kuwaiti dinar = 1000 fils, and the same for the
 * Bahraini, Jordanian, Libyan, Omani and Tunisian units and the Iraqi
 * dinar. This is the group `lib/billing/money.ts` got wrong.
 */
const EXPONENT_3 = ["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"] as const;

/**
 * ⚠️ FOUR DECIMALS. Both are index units rather than notes and coins —
 * the Chilean Unidad de Fomento and the Uruguayan nominal wage index —
 * and both are ISO-4217 codes that a contract can legitimately be
 * denominated in. Listed so that a system holding one does not truncate
 * two of its digits.
 */
const EXPONENT_4 = ["CLF", "UYW"] as const;

/** Everything else in circulation. Two decimals. */
const EXPONENT_2 = [
  "AED", "AFN", "ALL", "AMD", "ANG", "AOA", "ARS", "AUD", "AWG", "AZN",
  "BAM", "BBD", "BDT", "BGN", "BMD", "BND", "BOB", "BOV", "BRL", "BSD",
  "BTN", "BWP", "BYN", "BZD", "CAD", "CDF", "CHE", "CHF", "CHW", "CNY",
  "COP", "COU", "CRC", "CUP", "CVE", "CZK", "DKK", "DOP", "DZD", "EGP",
  "ERN", "ETB", "EUR", "FJD", "FKP", "GBP", "GEL", "GHS", "GIP", "GMD",
  "GTQ", "GYD", "HKD", "HNL", "HTG", "HUF", "IDR", "ILS", "INR", "IRR",
  "JMD", "KES", "KGS", "KHR", "KPW", "KYD", "KZT", "LAK", "LBP", "LKR",
  "LRD", "LSL", "MAD", "MDL", "MGA", "MKD", "MMK", "MNT", "MOP", "MRU",
  "MUR", "MVR", "MWK", "MXN", "MXV", "MYR", "MZN", "NAD", "NGN", "NIO",
  "NOK", "NPR", "NZD", "PAB", "PEN", "PGK", "PHP", "PKR", "PLN", "QAR",
  "RON", "RSD", "RUB", "SAR", "SBD", "SCR", "SDG", "SEK", "SGD", "SHP",
  "SLE", "SOS", "SRD", "SSP", "STN", "SVC", "SYP", "SZL", "THB", "TJS",
  "TMT", "TOP", "TRY", "TTD", "TWD", "TZS", "UAH", "USD", "USN", "UYU",
  "UZS", "VED", "VES", "XCD", "XCG", "YER", "ZAR", "ZMW", "ZWG",
] as const;

/**
 * ⭐ THE TABLE ITSELF. Built once, frozen, and consulted by every
 * conversion, every parse and every format in the product.
 */
const EXPONENTS: ReadonlyMap<string, number> = new Map<string, number>([
  ...EXPONENT_0.map((c) => [c, 0] as [string, number]),
  ...EXPONENT_2.map((c) => [c, 2] as [string, number]),
  ...EXPONENT_3.map((c) => [c, 3] as [string, number]),
  ...EXPONENT_4.map((c) => [c, 4] as [string, number]),
]);

/** Every code this system will accept, sorted. Used by the SQL seed check. */
export const KNOWN_CURRENCIES: readonly string[] = [...EXPONENTS.keys()].sort();

/** ISO-4217 alphabetic codes are three upper-case letters and nothing else. */
export function normaliseCurrencyCode(code: string): string {
  return code.trim().toUpperCase();
}

export function isKnownCurrency(code: string): boolean {
  return EXPONENTS.has(normaliseCurrencyCode(code));
}

export function assertKnownCurrency(code: string): void {
  if (!isKnownCurrency(code)) throw new UnknownCurrencyError(code);
}

/**
 * 🔴 HOW MANY DECIMAL PLACES THIS CURRENCY HAS. Throws rather than
 * defaulting — see the header. Every caller that used to receive a
 * confident 2 for an unknown code now receives a sentence naming the code.
 */
export function minorUnitExponent(code: string): number {
  const key = normaliseCurrencyCode(code);
  const exponent = EXPONENTS.get(key);
  if (exponent === undefined) throw new UnknownCurrencyError(code);
  return exponent;
}

/** 10^exponent, as a bigint, for use in the arithmetic. */
export function minorUnitScale(code: string): bigint {
  return 10n ** BigInt(minorUnitExponent(code));
}

/**
 * Minor units → plain decimal string, with THIS currency's number of
 * decimals. No symbol, no grouping.
 *
 * ⚠️ `formatMinorPlain(1234n, "KWD")` is "1.234" and
 * `formatMinorPlain(1234n, "JPY")` is "1234". Both were "12.34" before
 * this batch.
 */
export function formatMinorPlain(minor: bigint, code: string): string {
  const exponent = minorUnitExponent(code);
  if (exponent === 0) return minor.toString();
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const scale = 10n ** BigInt(exponent);
  const whole = abs / scale;
  const fraction = (abs % scale).toString().padStart(exponent, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/**
 * Decimal string → minor units, refusing more decimals than the currency
 * has.
 *
 * ⚠️ PARSED AS TEXT. "1.005" through a float and back is 1.0049999…,
 * and `Math.round(Number("1.005") * 100)` is 100 rather than 101.
 */
export function parseMajorToMinor(text: string, code: string): bigint {
  const exponent = minorUnitExponent(code);
  const trimmed = text.trim();
  const pattern =
    exponent === 0
      ? /^-?\d{1,18}$/
      : new RegExp(`^-?\\d{1,18}(\\.\\d{1,${exponent}})?$`);
  if (!pattern.test(trimmed)) {
    throw new RangeError(
      `"${text}" is not a ${normaliseCurrencyCode(code)} amount. ` +
        `${normaliseCurrencyCode(code)} has ${exponent} decimal place(s), so the most precise ` +
        `value it can hold is ${exponent === 0 ? "a whole unit" : `0.${"0".repeat(exponent - 1)}1`}.`,
    );
  }
  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const scale = 10n ** BigInt(exponent);
  const padded = exponent === 0 ? "0" : fraction.padEnd(exponent, "0");
  const magnitude = BigInt(whole) * scale + BigInt(padded || "0");
  return negative ? -magnitude : magnitude;
}

/**
 * ⭐ A LABELLED AMOUNT. The type that makes "a total with no currency
 * label" impossible to express by accident — every aggregate in
 * `lib/fx/aggregate.ts` returns these and never a bare bigint.
 */
export type Money = {
  readonly amountMinor: bigint;
  readonly currency: string;
};

export function money(amountMinor: bigint, currency: string): Money {
  assertKnownCurrency(currency);
  return { amountMinor, currency: normaliseCurrencyCode(currency) };
}

/** Adding two amounts is only defined when they are the same currency. */
export function addMoney(a: Money, b: Money): Money {
  if (normaliseCurrencyCode(a.currency) !== normaliseCurrencyCode(b.currency)) {
    throw new RangeError(
      `Cannot add ${a.currency} to ${b.currency}. Convert one of them through a stated ` +
        `rate on a stated date, or group the total by currency — the sum of two currencies ` +
        `is not a number, it is two numbers.`,
    );
  }
  return { amountMinor: a.amountMinor + b.amountMinor, currency: normaliseCurrencyCode(a.currency) };
}

/* ------------------------------------------------------------------ */
/* THE FUNCTIONAL CURRENCY                                             */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ THE FALLBACK, NAMED, BECAUSE A SILENT ONE WOULD BE THE SAME DEFECT
 * AGAIN. Every workspace created before this batch has `settings.currency`
 * unset, and Ordence is an Indian product sold to Indian businesses whose
 * books are kept in rupees. INR is therefore the right answer for an
 * unset workspace — but it is a DECISION, so it is a named constant that
 * `functionalCurrencyFromSettings` reports through `isDefault`, and the
 * settings screen can say "your books are kept in INR" rather than leaving
 * the customer to find out from a revaluation.
 */
export const DEFAULT_FUNCTIONAL_CURRENCY = "INR";

export type FunctionalCurrency = {
  readonly code: string;
  /** True when nobody has chosen one and the default was used. */
  readonly isDefault: boolean;
};

/**
 * ⭐ THE ONE READER OF `tenants.settings.currency`.
 *
 * 🔴 THIS COLUMN IS ONE OF THE SIXTEEN. `server/actions/settings.ts`
 * writes it, `onboarding` writes it, the settings form displays it back —
 * and before this batch NOTHING READ IT AT A COMPUTATION. The books were
 * kept in rupees whatever the customer chose, and every posting in
 * `server/accounting/post-sales.ts` hardcoded `currency: "INR"`.
 *
 * ⚠️ AN UNRECOGNISED CODE IN THE SETTINGS BLOB IS REFUSED, NOT IGNORED.
 * The blob is free-form JSONB and nothing has ever validated it; a
 * workspace whose currency reads "Rs" or "inr " must not silently become
 * something else, because the functional currency is what every figure in
 * the ledger is denominated in.
 */
export function functionalCurrencyFromSettings(
  settings: { currency?: string | null } | Record<string, unknown> | null | undefined,
): FunctionalCurrency {
  const raw = (settings as { currency?: unknown } | null | undefined)?.currency;
  if (typeof raw !== "string" || raw.trim() === "") {
    return { code: DEFAULT_FUNCTIONAL_CURRENCY, isDefault: true };
  }
  const code = normaliseCurrencyCode(raw);
  assertKnownCurrency(code);
  return { code, isDefault: false };
}
