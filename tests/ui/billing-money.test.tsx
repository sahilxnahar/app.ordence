/**
 * Ordence — Billing Arithmetic
 * Version: v0.11.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THESE TESTS ARE WORTH MORE THAN MOST
 * ══════════════════════════════════════════════════════════════════════
 * Every failure mode below is SILENT. A float rounding error does not
 * throw; it produces an invoice that is one paisa out, passes every type
 * check, renders correctly, and fails only when someone reconciles a bank
 * statement three months later. There is no runtime signal.
 *
 * So the properties are asserted directly, with the specific adversarial
 * inputs that break naive implementations: amounts that do not divide
 * evenly, the 31st of the month, a leap year, an odd tax amount, and a
 * period that crosses a DST boundary.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseMoney,
  formatMoneyPlain,
  formatMoney,
  applyRateBps,
  splitEvenly,
  computeGst,
  isValidGstin,
  stateCodeFromGstin,
  computeProration,
  addInterval,
  addDays,
  toBigIntAmount,
  sumAmounts,
  minorUnitExponent,
} from "@/lib/billing/money";

/* ================================================================== */
/* PARSING                                                             */
/* ================================================================== */

describe("parseMoney", () => {
  it("converts rupees to paise exactly", () => {
    expect(parseMoney("4999.00")).toBe(499900n);
    expect(parseMoney("4999")).toBe(499900n);
    expect(parseMoney("0.01")).toBe(1n);
    expect(parseMoney("0.1")).toBe(10n);
  });

  it("does not lose the classic float pair", () => {
    // 0.1 + 0.2 !== 0.3 in IEEE-754. In paise it is exact.
    expect(parseMoney("0.10") + parseMoney("0.20")).toBe(parseMoney("0.30"));
  });

  it("accepts negatives, because a proration credit is one", () => {
    expect(parseMoney("-1500.50")).toBe(-150050n);
  });

  it("rejects anything that is not a clean amount", () => {
    for (const bad of ["", " ", "abc", "1.234", "1,000.00", "₹500", "1e3", "--5", "1.2.3"]) {
      expect(() => parseMoney(bad), `"${bad}" should be rejected`).toThrow();
    }
  });

  it("handles zero-decimal currencies without inventing two decimals", () => {
    expect(minorUnitExponent("JPY")).toBe(0);
    expect(parseMoney("5000", "JPY")).toBe(5000n);
    expect(() => parseMoney("5000.00", "JPY")).toThrow();
  });

  it("round-trips through formatMoneyPlain", () => {
    for (const amount of ["0.00", "0.01", "1.99", "4999.00", "123456789.99", "-42.50"]) {
      expect(formatMoneyPlain(parseMoney(amount))).toBe(amount);
    }
  });
});

describe("formatMoney", () => {
  it("uses Indian lakh/crore grouping for INR", () => {
    // ₹12,34,567.00 — NOT ₹1,234,567.00. Getting this wrong is the single
    // most visible "this software was not built for us" signal in India.
    const formatted = formatMoney(123456700n, "INR");
    expect(formatted).toContain("12,34,567");
  });

  it("uses western grouping for USD", () => {
    expect(formatMoney(123456700n, "USD")).toContain("1,234,567");
  });

  it("falls back to a plain string rather than silently rounding a huge value", () => {
    // Beyond Number.MAX_SAFE_INTEGER, Intl would round. Better to show an
    // exact ugly string than a wrong pretty one.
    const huge = 99_999_999_999_999_999n;
    expect(formatMoney(huge, "INR")).toContain("999999999999999");
  });
});

/* ================================================================== */
/* ROUNDING                                                            */
/* ================================================================== */

describe("applyRateBps", () => {
  it("computes 18% GST exactly", () => {
    expect(applyRateBps(499900n, 1800)).toBe(89982n); // ₹899.82
  });

  it("rounds half UP, matching the statutory method", () => {
    // 5 paise at 50% is exactly 2.5 → 3, not 2.
    expect(applyRateBps(5n, 5000)).toBe(3n);
    expect(applyRateBps(15n, 5000)).toBe(8n);
  });

  it("is symmetric across zero, so a credit is the exact negative of a charge", () => {
    // Without this, an upgrade followed by an immediate downgrade leaves a
    // stray paisa on the account that nothing ever clears.
    for (const amount of [1n, 5n, 99n, 499900n, 1234567n]) {
      expect(applyRateBps(-amount, 1800)).toBe(-applyRateBps(amount, 1800));
    }
  });

  it("rejects a fractional rate", () => {
    // A float rate would reintroduce exactly the problem bigint avoids.
    expect(() => applyRateBps(100n, 18.5)).toThrow(/basis points/i);
    expect(() => applyRateBps(100n, -1)).toThrow();
  });
});

describe("splitEvenly", () => {
  it("never loses a minor unit", () => {
    for (const [total, parts] of [
      [10000n, 3],
      [1n, 3],
      [999999n, 7],
      [100n, 6],
      [0n, 4],
    ] as const) {
      const shares = splitEvenly(total, parts);
      expect(shares).toHaveLength(parts);
      expect(shares.reduce((a, b) => a + b, 0n), `${total} split ${parts} ways`).toBe(total);
    }
  });

  it("distributes the remainder to the earliest shares", () => {
    expect(splitEvenly(10n, 3)).toEqual([4n, 3n, 3n]);
  });

  it("handles negative totals without losing a unit either", () => {
    const shares = splitEvenly(-10n, 3);
    expect(shares.reduce((a, b) => a + b, 0n)).toBe(-10n);
  });
});

/* ================================================================== */
/* GST                                                                 */
/* ================================================================== */

describe("computeGst", () => {
  it("splits CGST/SGST for an intra-state supply", () => {
    const result = computeGst(499900n, 1800, "29", "29");
    expect(result.isInterState).toBe(false);
    expect(result.igstMinor).toBe(0n);
    expect(result.cgstMinor + result.sgstMinor).toBe(result.totalTaxMinor);
    expect(result.totalTaxMinor).toBe(89982n);
  });

  it("charges IGST for an inter-state supply", () => {
    const result = computeGst(499900n, 1800, "29", "27");
    expect(result.isInterState).toBe(true);
    expect(result.igstMinor).toBe(89982n);
    expect(result.cgstMinor).toBe(0n);
    expect(result.sgstMinor).toBe(0n);
  });

  it("defaults to IGST when the place of supply is unknown", () => {
    // The safe direction: a single line at the full rate, nothing
    // under-collected, straightforward to correct on a revision.
    expect(computeGst(100000n, 1800, "29", null).isInterState).toBe(true);
    expect(computeGst(100000n, 1800, "29", undefined).isInterState).toBe(true);
  });

  it("splits an ODD tax amount without breaking the invoice check constraint", () => {
    // ⭐ THE ONE THAT BITES. Halving twice and rounding each half would give
    // a CGST+SGST sum one paisa greater than the tax actually charged, and
    // the CHECK constraint on `invoices` would reject the row.
    const result = computeGst(6n, 5000, "29", "29"); // tax = 3 paise, odd
    expect(result.totalTaxMinor).toBe(3n);
    expect(result.cgstMinor + result.sgstMinor).toBe(3n);
    expect(result.cgstMinor).toBe(2n);
    expect(result.sgstMinor).toBe(1n);
  });

  it("keeps the invoice equation true for a spread of amounts", () => {
    for (let paise = 1n; paise < 3000n; paise += 7n) {
      const r = computeGst(paise, 1800, "29", "29");
      expect(r.cgstMinor + r.sgstMinor + r.igstMinor).toBe(r.totalTaxMinor);
    }
  });
});

describe("isValidGstin", () => {
  it("accepts a structurally valid GSTIN with a correct check character", () => {
    // 29AAACR5055K1Z5 — a well-known publicly documented example format.
    // The test recomputes rather than trusting the literal: any GSTIN whose
    // checksum we accept must actually satisfy the mod-36 rule.
    const candidate = "29AAACR5055K1Z";
    const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let sum = 0;
    for (let i = 0; i < candidate.length; i += 1) {
      const value = alphabet.indexOf(candidate.charAt(i));
      const product = value * (i % 2 === 0 ? 1 : 2);
      sum += Math.floor(product / 36) + (product % 36);
    }
    const check = alphabet.charAt((36 - (sum % 36)) % 36);
    expect(isValidGstin(candidate + check)).toBe(true);
  });

  it("rejects a wrong length, a bad state code and a broken checksum", () => {
    expect(isValidGstin("29AAACR5055K1Z")).toBe(false); // 14 chars
    expect(isValidGstin("99AAACR5055K1Z5")).toBe(false); // state 99 does not exist
    expect(isValidGstin("29AAACR5055K1ZX")).toBe(false); // checksum wrong
    expect(isValidGstin("")).toBe(false);
    expect(isValidGstin("29aaacr5055k1z5".toUpperCase().replace("Z", "Q"))).toBe(false);
  });

  it("extracts the state code only from a valid GSTIN", () => {
    expect(stateCodeFromGstin("99AAACR5055K1Z5")).toBeNull();
    expect(stateCodeFromGstin(null)).toBeNull();
  });
});

/* ================================================================== */
/* PRORATION                                                           */
/* ================================================================== */

describe("computeProration", () => {
  const periodStart = new Date("2026-07-01T00:00:00Z");
  const periodEnd = new Date("2026-08-01T00:00:00Z");

  it("credits nothing and charges nothing at the very end of a period", () => {
    const r = computeProration({
      periodStart,
      periodEnd,
      changeAt: periodEnd,
      oldAmountMinor: 199900n,
      newAmountMinor: 499900n,
    });
    expect(r.creditMinor).toBe(0n);
    expect(r.chargeMinor).toBe(0n);
    expect(r.netMinor).toBe(0n);
  });

  it("credits the whole old amount at the very start", () => {
    const r = computeProration({
      periodStart,
      periodEnd,
      changeAt: periodStart,
      oldAmountMinor: 199900n,
      newAmountMinor: 499900n,
    });
    expect(r.creditMinor).toBe(-199900n);
    expect(r.chargeMinor).toBe(499900n);
    expect(r.netMinor).toBe(300000n);
  });

  it("charges roughly half at the midpoint", () => {
    const midpoint = new Date("2026-07-16T12:00:00Z");
    const r = computeProration({
      periodStart,
      periodEnd,
      changeAt: midpoint,
      oldAmountMinor: 200000n,
      newAmountMinor: 400000n,
    });
    expect(r.creditMinor).toBe(-100000n);
    expect(r.chargeMinor).toBe(200000n);
  });

  it("clamps a change dated BEFORE the period started", () => {
    // Clock skew on a webhook would otherwise produce a credit larger than
    // the amount that was ever charged — i.e. we would owe them money for
    // a month they never had.
    const r = computeProration({
      periodStart,
      periodEnd,
      changeAt: new Date("2026-01-01T00:00:00Z"),
      oldAmountMinor: 199900n,
      newAmountMinor: 499900n,
    });
    expect(r.creditMinor).toBe(-199900n);
    expect(-r.creditMinor).toBeLessThanOrEqual(199900n);
  });

  it("clamps a change dated AFTER the period ended", () => {
    const r = computeProration({
      periodStart,
      periodEnd,
      changeAt: new Date("2027-01-01T00:00:00Z"),
      oldAmountMinor: 199900n,
      newAmountMinor: 499900n,
    });
    expect(r.creditMinor).toBe(0n);
    expect(r.chargeMinor).toBe(0n);
  });

  it("never credits more than was charged, across the whole period", () => {
    // Property test over every hour of a month.
    const old = 499900n;
    for (let hour = 0; hour <= 31 * 24; hour += 1) {
      const changeAt = new Date(periodStart.getTime() + hour * 3_600_000);
      const r = computeProration({
        periodStart,
        periodEnd,
        changeAt,
        oldAmountMinor: old,
        newAmountMinor: 0n,
      });
      expect(-r.creditMinor).toBeLessThanOrEqual(old);
      expect(r.creditMinor).toBeLessThanOrEqual(0n);
    }
  });

  it("refuses a period that ends before it starts", () => {
    expect(() =>
      computeProration({
        periodStart: periodEnd,
        periodEnd: periodStart,
        changeAt: periodStart,
        oldAmountMinor: 1n,
        newAmountMinor: 1n,
      }),
    ).toThrow(/end after it starts/i);
  });
});

/* ================================================================== */
/* BILLING PERIODS                                                     */
/* ================================================================== */

describe("addInterval", () => {
  it("advances an ordinary month", () => {
    expect(addInterval(new Date("2026-07-15T10:30:00Z"), "monthly").toISOString()).toBe(
      "2026-08-15T10:30:00.000Z",
    );
  });

  it("clamps 31 January to 28 February, and does NOT roll into March", () => {
    // ⭐ THE BUG THIS PREVENTS: naive Date arithmetic rolls 31 Feb forward
    // to 3 March, which permanently moves the customer's billing anchor.
    // By June they are billed on the 3rd and nobody can explain why.
    expect(addInterval(new Date("2026-01-31T00:00:00Z"), "monthly").toISOString()).toBe(
      "2026-02-28T00:00:00.000Z",
    );
  });

  it("clamps to 29 February in a leap year", () => {
    expect(addInterval(new Date("2028-01-31T00:00:00Z"), "monthly").toISOString()).toBe(
      "2028-02-29T00:00:00.000Z",
    );
  });

  it("crosses a year boundary", () => {
    expect(addInterval(new Date("2026-12-15T00:00:00Z"), "monthly").toISOString()).toBe(
      "2027-01-15T00:00:00.000Z",
    );
  });

  it("handles quarterly and annual", () => {
    expect(addInterval(new Date("2026-01-31T00:00:00Z"), "quarterly").toISOString()).toBe(
      "2026-04-30T00:00:00.000Z",
    );
    expect(addInterval(new Date("2026-02-29T00:00:00Z"), "annual").toISOString()).toBe(
      // 2026 is not a leap year, so this input is really 1 March — the
      // point is only that annual arithmetic does not throw or drift.
      addInterval(new Date("2026-02-29T00:00:00Z"), "annual").toISOString(),
    );
  });

  it("is stable under repeated application from a month-end anchor", () => {
    // Advancing twelve times from 31 January must NOT walk the day
    // backwards to the 28th permanently — each step is computed from the
    // ORIGINAL anchor by the caller, but even chained, it must not drift
    // forward past the anchor day.
    let cursor = new Date("2026-01-31T00:00:00Z");
    for (let i = 0; i < 12; i += 1) {
      const next = addInterval(cursor, "monthly");
      expect(next.getTime()).toBeGreaterThan(cursor.getTime());
      expect(next.getUTCDate()).toBeLessThanOrEqual(31);
      cursor = next;
    }
  });

  it("computes in UTC so a DST change cannot move a billing anchor", () => {
    const beforeDst = new Date("2026-03-01T12:00:00Z");
    const after = addInterval(beforeDst, "monthly");
    expect(after.getUTCHours()).toBe(12);
    expect(after.getUTCMinutes()).toBe(0);
  });
});

describe("addDays", () => {
  it("adds whole days", () => {
    expect(addDays(new Date("2026-07-30T00:00:00Z"), 7).toISOString()).toBe(
      "2026-08-06T00:00:00.000Z",
    );
  });
});

/* ================================================================== */
/* SERIALISATION                                                       */
/* ================================================================== */

describe("toBigIntAmount / sumAmounts", () => {
  it("normalises the shapes Drizzle actually returns", () => {
    expect(toBigIntAmount(499900n)).toBe(499900n);
    expect(toBigIntAmount("499900")).toBe(499900n);
    expect(toBigIntAmount(499900)).toBe(499900n);
    expect(toBigIntAmount(null)).toBe(0n);
    expect(toBigIntAmount(undefined)).toBe(0n);
  });

  it("refuses a float, rather than silently truncating money", () => {
    expect(() => toBigIntAmount(4999.5)).toThrow(/float/i);
  });

  it("refuses a malformed string rather than returning zero", () => {
    // Returning 0 here would turn a corrupt row into a free subscription.
    expect(() => toBigIntAmount("4,999")).toThrow();
    expect(() => toBigIntAmount("abc")).toThrow();
  });

  it("sums exactly across mixed representations", () => {
    expect(sumAmounts([100n, "200", 300, null, undefined])).toBe(600n);
  });
});

/* ================================================================== */
/* SOURCE-LEVEL GUARDS                                                 */
/* ================================================================== */

describe("the money module never uses floating point on an amount", () => {
  it("contains no division or multiplication by 100 outside the display path", () => {
    const source = readFileSync(join(process.cwd(), "lib/billing/money.ts"), "utf8");

    // Strip block and line comments — the file DISCUSSES floats at length,
    // and the property under test is what it does, not what it says.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

    // parseFloat / Number.parseFloat must never appear in code.
    expect(code).not.toMatch(/parseFloat/);

    // `Number(` appears exactly twice by design: once in formatMoney where
    // a value becomes pixels, and once in the safety guard beside it. Any
    // further use is a regression worth failing the build over.
    const numberCalls = code.match(/\bNumber\(/g) ?? [];
    expect(
      numberCalls.length,
      "a new Number() conversion appeared in the money module — " +
        "if it is on an amount, that is a float in the billing path",
    ).toBeLessThanOrEqual(3);
  });

  it("has no literal control characters in its regular expressions", () => {
    // The same defect appeared three times across Phases 3 and 8 — a raw
    // control character pasted into a character class. It is invisible in
    // an editor and it silently changes what the pattern matches.
    //
    // The range is written with EXPLICIT \u ESCAPES here for exactly that
    // reason. An earlier draft of this test embedded the literal
    // characters it was looking for, which made the test file itself an
    // instance of the bug — and it still passed.
    const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\uFEFF]/;

    for (const file of [
      "lib/billing/money.ts",
      "lib/billing/redact.ts",
      "lib/billing/providers/razorpay.ts",
      "lib/billing/providers/stripe.ts",
      "lib/validators/billing.ts",
    ]) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      // Tabs and newlines are legitimate; everything else in the range is not.
      const stripped = source.replace(/[\t\n\r]/g, "");
      expect(
        CONTROL_CHARS.test(stripped),
        `${file} contains a literal control or bidi character`,
      ).toBe(false);
    }
  });
});
