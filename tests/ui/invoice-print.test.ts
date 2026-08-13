/**
 * The printed tax invoice.
 *
 * The words tests are real arithmetic. The sheet tests read source,
 * because a page compiles fine while omitting a field the law requires.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { rupeesInWords, wholeNumberInWords } from "@/lib/invoicing/amount-in-words";
import {
  addressLines,
  copyLabelsFor,
  formatGstin,
  printGaps,
} from "@/lib/invoicing/print";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const SHEET = read("app/(print)/invoices/[id]/print/page.tsx");
const LAYOUT = read("app/(print)/layout.tsx");
const ACTIONS = read("server/actions/sales-invoices.ts");
const DETAIL = read("app/(crm)/invoices/[id]/page.tsx");

/* ================================================================== */

describe("🔴 rupees in words use INDIAN grouping", () => {
  it("one lakh is a lakh, not a hundred thousand", () => {
    expect(wholeNumberInWords(100_000n)).toBe("One Lakh");
    expect(wholeNumberInWords(100_000n)).not.toContain("Thousand");
  });

  it("one crore is a crore, not ten million", () => {
    expect(wholeNumberInWords(10_000_000n)).toBe("One Crore");
    expect(wholeNumberInWords(10_000_000n)).not.toContain("Million");
  });

  it("reads a full mixed figure the way a person says it", () => {
    // 1,18,45,678
    expect(wholeNumberInWords(11_845_678n)).toBe(
      "One Crore Eighteen Lakh Forty Five Thousand Six Hundred Seventy Eight",
    );
  });

  /** Above a crore the conventions diverge; recursion gives the spoken form. */
  it("goes past a crore without inventing a unit nobody uses", () => {
    expect(wholeNumberInWords(1_000_000_000n)).toBe("One Hundred Crore");
    expect(wholeNumberInWords(100_000_000_000n)).toBe("Ten Thousand Crore");
  });

  it("handles the teens and the round tens", () => {
    expect(wholeNumberInWords(15n)).toBe("Fifteen");
    expect(wholeNumberInWords(70n)).toBe("Seventy");
    expect(wholeNumberInWords(90_9n)).toBe("Nine Hundred Nine");
  });

  it("zero is a word, not an empty string", () => {
    expect(wholeNumberInWords(0n)).toBe("Zero");
  });
});

describe("🔴 the amount line is the tie-breaker on the document", () => {
  it("speaks paise separately, never as a decimal", () => {
    expect(rupeesInWords(118_050n)).toBe(
      "One Thousand One Hundred Eighty Rupees and Fifty Paise Only",
    );
    expect(rupeesInWords(118_050n)).not.toContain("Point");
  });

  it("omits the paise clause entirely when there are none", () => {
    expect(rupeesInWords(118_000n)).toBe("One Thousand One Hundred Eighty Rupees Only");
    expect(rupeesInWords(118_000n)).not.toContain("Paise");
  });

  /** "Only" terminates the amount so nothing can be appended after it. */
  it("always ends in Only", () => {
    for (const v of [0n, 1n, 99n, 100n, 12_345_678_900n]) {
      expect(rupeesInWords(v).endsWith(" Only")).toBe(true);
    }
  });

  it("says Rupee, singular, for exactly one", () => {
    expect(rupeesInWords(100n)).toBe("One Rupee Only");
    expect(rupeesInWords(200n)).toBe("Two Rupees Only");
  });

  it("zero rupees is still a sentence", () => {
    expect(rupeesInWords(0n)).toBe("Zero Rupees Only");
  });

  /**
   * `Number.MAX_SAFE_INTEGER` is about ₹90,07,19,92,54,740 in paise, and a
   * real contract in this industry can reach it. A wrong word on a legal
   * document is the failure mode.
   */
  it("takes bigint and is exact past what a float could hold", () => {
    const huge = 9_007_199_254_740_993_00n; // beyond MAX_SAFE_INTEGER in paise
    expect(() => rupeesInWords(huge)).not.toThrow();
    expect(rupeesInWords(huge)).toContain("Crore");
  });

  it("spells a negative rather than printing a sign in front of words", () => {
    expect(rupeesInWords(-100n)).toBe("Minus One Rupee Only");
  });
});

describe("⭐ Rule 48(1) — the copies", () => {
  it("goods take three, and the transporter's copy is one of them", () => {
    const c = copyLabelsFor("goods");
    expect(c).toHaveLength(3);
    expect(c.join(" ")).toContain("TRANSPORTER");
  });

  /** There is no consignment on a supply of services. */
  it("services take two, and none of them mentions a transporter", () => {
    const c = copyLabelsFor("services");
    expect(c).toHaveLength(2);
    expect(c.join(" ")).not.toContain("TRANSPORTER");
  });

  it("anything unrecognised falls back to the goods form", () => {
    expect(copyLabelsFor("")).toHaveLength(3);
  });

  it("the sheet renders one page per copy and breaks between them", () => {
    expect(code(SHEET)).toContain("copies.map(");
    expect(code(SHEET)).toContain("break-after-page");
  });
});

describe("the address block", () => {
  it("drops empty parts instead of printing blank lines", () => {
    expect(addressLines({ line1: "Plot 14", line2: "", city: "Pune", state: "Maharashtra", postalCode: "411001" })).toEqual([
      "Plot 14",
      "Pune, Maharashtra - 411001",
    ]);
  });

  it("returns nothing at all for an empty address", () => {
    expect(addressLines({})).toEqual([]);
    expect(addressLines(null)).toEqual([]);
  });

  /** Noise on a domestic invoice, essential on an export one. */
  it("prints the country only when it is not India", () => {
    expect(addressLines({ city: "Pune", country: "India" })).toEqual(["Pune"]);
    expect(addressLines({ city: "Dubai", country: "UAE" })).toEqual(["Dubai", "UAE"]);
  });
});

describe("🔴 a GSTIN stays one token", () => {
  /** The only thing anyone does with it is paste it into the GST portal. */
  it("is upper-cased and never spaced into groups", () => {
    expect(formatGstin(" 27aabcu9603r1zm ")).toBe("27AABCU9603R1ZM");
    expect(formatGstin("27AABCU9603R1ZM")).not.toContain(" ");
  });

  it("an absent GSTIN is an empty string, not the word null", () => {
    expect(formatGstin(null)).toBe("");
    expect(formatGstin(undefined)).toBe("");
  });
});

describe("🔴 the document says what it is missing", () => {
  it("reports both uncaptured Rule 46 fields", () => {
    const gaps = printGaps({
      hasDeliveryAddress: false,
      hasSignatory: false,
      supplierGstin: "27AABCU9603R1ZM",
      supplierLegalName: "Acme Infra LLP",
    });
    expect(gaps.map((g) => g.rule)).toEqual(["Rule 46(o)", "Rule 46(q)"]);
  });

  it("and flags a supplier with no GSTIN, because the customer loses input credit", () => {
    const gaps = printGaps({
      hasDeliveryAddress: true,
      hasSignatory: true,
      supplierGstin: null,
      supplierLegalName: "Acme Infra LLP",
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.message).toContain("input tax credit");
  });

  it("nothing to report when everything is present", () => {
    expect(
      printGaps({
        hasDeliveryAddress: true,
        hasSignatory: true,
        supplierGstin: "27AABCU9603R1ZM",
        supplierLegalName: "Acme Infra LLP",
      }),
    ).toEqual([]);
  });

  /**
   * Omitting the row makes an incomplete invoice look complete. The whole
   * point is that a blank line gets noticed.
   */
  it("the sheet prints the delivery-address and signatory rows even when empty", () => {
    expect(SHEET).toContain("Rule 46(o)");
    expect(SHEET).toContain("Authorised Signatory");
  });

  it("the on-screen gap notice never reaches the paper", () => {
    /**
     * ⚠️ SLICED BACKWARDS FROM THE HEADING. `print:hidden` sits on the
     * wrapper ABOVE the text, so slicing forward from the heading finds
     * the block without the class that hides it — a test that would have
     * been "fixed" by moving the class onto the wrong element.
     */
    const at = SHEET.indexOf("What Rule 46 still wants");
    expect(at).toBeGreaterThan(-1);
    expect(SHEET.slice(at - 400, at)).toContain("print:hidden");
  });
});

describe("🔴 the sheet is a document, not a screen", () => {
  it("no app chrome — it has its own route group and layout", () => {
    expect(LAYOUT).toContain("@page");
    expect(LAYOUT).toContain("size: A4");
  });

  /** Every consumer printer has an unprintable edge of roughly 5mm. */
  it("leaves a real page margin rather than bleeding to the edge", () => {
    expect(LAYOUT).toMatch(/margin:\s*1[0-9]mm/);
  });

  it("keeps table rows off page breaks", () => {
    expect(LAYOUT).toContain("break-inside: avoid");
    expect(LAYOUT).toContain("table-header-group");
  });

  it("the toolbar and the print button are never printed", () => {
    expect(code(SHEET)).toContain("print:hidden");
  });

  it("does not open a print dialog by itself on load", () => {
    const trigger = read("components/invoices/print-trigger.tsx");
    expect(code(trigger)).toContain("window.print()");
    expect(code(trigger)).not.toContain("useEffect");
  });
});

describe("🔴 money and tax on the paper", () => {
  it("the sheet never divides by 100", () => {
    expect(code(SHEET)).not.toMatch(/Number\([^)]*\)\s*\/\s*100/);
    expect(code(SHEET)).toContain("padStart(3");
  });

  it("tax heads are never summed into one GST line", () => {
    expect(SHEET).toContain("IGST");
    expect(SHEET).toContain("CGST");
    expect(code(SHEET)).not.toMatch(/BigInt\(invoice\.cgstMinor\)\s*\+/);
  });

  it("labels the state half UTGST on an intra-UT supply", () => {
    expect(code(SHEET)).toContain("isUnionTerritory");
    expect(SHEET).toContain("UTGST");
  });

  it("dates print day-month-year, the form every Indian document uses", () => {
    expect(code(SHEET)).toContain("function dmy");
    expect(code(SHEET)).toMatch(/parts\[2\]\}-\$\{parts\[1\]\}-\$\{parts\[0\]/);
  });
});

describe("⭐ the HSN summary comes from the action, not the page", () => {
  /** It has to be the grouping GSTR-1 uses, or the invoice disagrees with the return. */
  it("is built server-side", () => {
    const body = code(ACTIONS);
    const print = body.slice(body.indexOf("export async function getInvoiceForPrint"));
    expect(print).toContain("hsnSummary");
    expect(print).toContain("summary.set(");
  });

  /** 3 bags and 3 tonnes is not 6 of anything. */
  it("groups by code AND unit", () => {
    const body = code(ACTIONS);
    const print = body.slice(body.indexOf("export async function getInvoiceForPrint"));
    expect(print).toMatch(/\$\{code\}\|\$\{l\.uom\}/);
  });

  it("the supplier is read from the registration frozen on the invoice", () => {
    const body = code(ACTIONS);
    const print = body.slice(body.indexOf("export async function getInvoiceForPrint"));
    expect(print).toContain("inv.supplierRegistrationId");
    expect(print).toContain("gstRegistrations");
  });
});

describe("the screen is reachable", () => {
  it("a missing invoice is indistinguishable from someone else's", () => {
    expect(code(SHEET)).toContain("notFound()");
  });

  /** People print a draft to check it; refusing just moves them to screenshots. */
  it("the print link is offered on a draft too, and the sheet watermarks it", () => {
    expect(DETAIL).toContain("Print / Save as PDF");
    expect(code(SHEET)).toContain("isDraft");
    expect(SHEET).toContain("Draft");
    expect(SHEET).toContain("NOT YET ISSUED");
  });
});
