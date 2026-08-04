/**
 * Ordence — Invoice Composition & Rendering
 * Version: v0.16.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THESE TESTS MATTER MORE THAN MOST UI TESTS
 * ══════════════════════════════════════════════════════════════════════
 * The output of this code is a LEGAL INSTRUMENT. A customer files it to
 * claim input tax credit. A missing field or a wrong split does not throw
 * — it produces a perfectly rendered document that gets their claim
 * rejected weeks later, at which point the only remedy is a credit note
 * and a reissue, and the mistake is permanently in both parties' filings.
 *
 * So: every field Rule 46 of the CGST Rules requires is asserted present,
 * and every escaping path is asserted against hostile input, because a
 * customer controls their own legal name.
 */

import { describe, it, expect } from "vitest";
import {
  renderInvoiceHtml,
  amountInWords,
  type InvoiceLineRow,
} from "@/lib/billing/invoice-render";
import {
  buildSubscriptionLines,
  buildProrationLines,
} from "@/lib/billing/invoice-lines";
import { computeGst } from "@/lib/billing/money";
import type { Invoice } from "@/db/schema/billing";

/* ------------------------------------------------------------------ */
/* FIXTURES                                                            */
/* ------------------------------------------------------------------ */

function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    tenantId: "22222222-2222-4222-8222-222222222222",
    subscriptionId: null,
    invoiceNumber: "AH/2026-27/000148",
    status: "open",
    currency: "INR",
    subtotalMinor: 499900n,
    discountMinor: 0n,
    cgstMinor: 44991n,
    sgstMinor: 44991n,
    igstMinor: 0n,
    totalMinor: 589882n,
    amountPaidMinor: 0n,
    customerGstin: "29AAACR5055K1Z5",
    placeOfSupplyCode: "29",
    customerLegalName: "Acme Realty Private Limited",
    customerAddress: {
      line1: "4th Floor, Prestige Tower",
      city: "Bengaluru",
      state: "Karnataka",
      postalCode: "560001",
      country: "IN",
    },
    periodStart: new Date("2026-07-01T00:00:00Z"),
    periodEnd: new Date("2026-08-01T00:00:00Z"),
    issuedAt: new Date("2026-07-01T06:00:00Z"),
    dueAt: new Date("2026-07-08T06:00:00Z"),
    paidAt: null,
    voidedAt: null,
    provider: "razorpay",
    providerInvoiceId: null,
    hostedInvoiceUrl: null,
    notes: null,
    metadata: {},
    createdAt: new Date("2026-07-01T06:00:00Z"),
    updatedAt: new Date("2026-07-01T06:00:00Z"),
    ...overrides,
  } as Invoice;
}

const LINES: InvoiceLineRow[] = [
  {
    description: "Advanced subscription (2026-07-01 to 2026-08-01)",
    sacCode: "998314",
    quantity: 1,
    unitAmountMinor: 499900n,
    amountMinor: 499900n,
    taxRateBps: 1800,
  },
];

const SUPPLIER = {
  legalName: "Ordence Technologies Private Limited",
  gstin: "29AABCU9603R1ZM",
  stateCode: "29",
  address: "Bengaluru, Karnataka 560001",
};

const render = (inv = invoice(), lines = LINES) =>
  renderInvoiceHtml({ invoice: inv, lines, supplier: SUPPLIER });

/* ================================================================== */
/* 1. RULE 46 — EVERY REQUIRED FIELD                                   */
/* ================================================================== */

describe("GST Rule 46 — the fields a tax invoice must carry", () => {
  const html = render();

  it('⭐ says the words "Tax Invoice"', () => {
    // Not "Invoice", not "Receipt". The wording is specified.
    expect(html).toMatch(/Tax Invoice/);
  });

  it("carries the supplier's name and GSTIN", () => {
    expect(html).toContain("Ordence Technologies Private Limited");
    expect(html).toContain("29AABCU9603R1ZM");
  });

  it("carries a serial number and the date of issue", () => {
    expect(html).toContain("AH/2026-27/000148");
    expect(html).toMatch(/01 Jul 2026/);
  });

  it("carries the recipient's name, address and GSTIN", () => {
    expect(html).toContain("Acme Realty Private Limited");
    expect(html).toContain("Prestige Tower");
    expect(html).toContain("29AAACR5055K1Z5");
  });

  it("states the place of supply by name, not just a code", () => {
    // "29" means nothing to a reader. "Karnataka (29)" does.
    expect(html).toMatch(/Karnataka \(29\)/);
  });

  it("carries a SAC code on every line", () => {
    expect(html).toContain("998314");
    expect(html).toMatch(/>SAC</);
  });

  it("⭐ splits the tax by head and never shows a combined figure", () => {
    // A single "GST ₹899.82" line is the most common way to get an
    // invoice rejected: the recipient's return needs the split.
    expect(html).toMatch(/>CGST</);
    expect(html).toMatch(/>SGST</);
    expect(html).not.toMatch(/>IGST</); // intra-state: IGST must be absent
  });

  it("⭐ shows IGST alone on an inter-state supply", () => {
    const interState = render(
      invoice({
        cgstMinor: 0n,
        sgstMinor: 0n,
        igstMinor: 89982n,
        placeOfSupplyCode: "27",
      }),
    );
    expect(interState).toMatch(/>IGST</);
    // Both heads present would double-count tax on a return.
    expect(interState).not.toMatch(/>CGST</);
    expect(interState).not.toMatch(/>SGST</);
    expect(interState).toMatch(/Inter-state/);
  });

  it("states the reverse-charge position explicitly", () => {
    // Cannot be omitted, even though the answer is "No" for a domestic
    // SaaS supply.
    expect(html).toMatch(/reverse charge/i);
  });

  it("carries a signature line", () => {
    expect(html).toMatch(/Authorised signatory/i);
  });

  it("⭐ says 'Unregistered' rather than leaving the GSTIN blank", () => {
    // A blank field reads as an omission by whoever prepared the
    // document. A stated fact does not.
    const unregistered = render(invoice({ customerGstin: null }));
    expect(unregistered).toMatch(/Unregistered \(no GSTIN\)/);
  });
});

/* ================================================================== */
/* 2. ESCAPING — THE CUSTOMER CONTROLS THEIR OWN NAME                  */
/* ================================================================== */

describe("escaping", () => {
  it("⭐ escapes a script tag in the customer's legal name", () => {
    // This document is rendered in a browser and may be emailed. An
    // unescaped name executes in whoever opens it — including our own
    // staff reviewing the invoice.
    const hostile = render(
      invoice({ customerLegalName: `<script>alert('xss')</script>` }),
    );
    expect(hostile).not.toContain("<script>alert");
    expect(hostile).toContain("&lt;script&gt;");
  });

  it("escapes hostile input in an address and a line description", () => {
    const hostile = renderInvoiceHtml({
      invoice: invoice({
        customerAddress: { line1: `"><img src=x onerror=alert(1)>` },
      }),
      lines: [{ ...LINES[0]!, description: `<b onmouseover="steal()">Plan</b>` }],
      supplier: SUPPLIER,
    });
    expect(hostile).not.toMatch(/<img src=x/);
    expect(hostile).not.toMatch(/<b onmouseover/);
    expect(hostile).toContain("&lt;img");
  });

  it("escapes the notes field", () => {
    const hostile = render(invoice({ notes: `</style><script>x()</script>` }));
    expect(hostile).not.toContain("<script>x()");
  });

  it("does not mangle ordinary punctuation", () => {
    // Over-escaping is its own failure — a company genuinely called
    // "Smith & Sons" must read correctly.
    const normal = render(invoice({ customerLegalName: "Smith & Sons Pvt. Ltd." }));
    expect(normal).toContain("Smith &amp; Sons Pvt. Ltd.");
  });
});

/* ================================================================== */
/* 3. AMOUNT IN WORDS — INDIAN NUMBERING                               */
/* ================================================================== */

describe("amountInWords", () => {
  it("uses lakh and crore, not million", () => {
    // ₹12,34,567 rendered as "one million two hundred…" reads as an error
    // to an Indian accounts department.
    expect(amountInWords(123456700n)).toMatch(/lakh/);
    expect(amountInWords(123456700n)).not.toMatch(/million/);
    expect(amountInWords(1234567800n)).toMatch(/crore/);
  });

  it("handles the ordinary case", () => {
    // 589882 paise = ₹5,898.82 — NOT ₹5,89,882. Confusing the two is the
    // single easiest mistake to make when every amount is in minor units,
    // and it is why the fixtures below are written as explicit paise.
    expect(amountInWords(589882n)).toBe(
      "Five thousand eight hundred ninety eight rupees and eighty two paise only",
    );
  });

  it("handles whole rupees with no paise", () => {
    expect(amountInWords(500000n)).toBe("Five thousand rupees only");
  });

  it("handles zero", () => {
    expect(amountInWords(0n)).toBe("Zero rupees only");
  });

  it("handles paise alone", () => {
    expect(amountInWords(45n)).toBe("Forty five paise only");
  });

  it("handles the teens, which are irregular", () => {
    expect(amountInWords(1300n)).toMatch(/^Thirteen rupees/);
    expect(amountInWords(1900n)).toMatch(/^Nineteen rupees/);
  });

  it("never produces double spaces or a leading space", () => {
    for (const amount of [100n, 1000n, 100000n, 10000000n, 101010101n, 7n]) {
      const words = amountInWords(amount);
      expect(words, `"${words}"`).not.toMatch(/\s{2,}/);
      expect(words).not.toMatch(/^\s/);
      expect(words.charAt(0)).toBe(words.charAt(0).toUpperCase());
    }
  });

  it("returns nothing for a non-INR currency rather than guessing", () => {
    // "Five thousand rupees" on a USD invoice would be worse than silence.
    expect(amountInWords(500000n, "USD")).toBe("");
  });
});

/* ================================================================== */
/* 4. LINE COMPOSITION                                                 */
/* ================================================================== */

describe("buildSubscriptionLines", () => {
  const base = {
    planName: "Advanced",
    periodStart: new Date("2026-07-01T00:00:00Z"),
    periodEnd: new Date("2026-08-01T00:00:00Z"),
    unitAmountMinor: 499900n,
    perSeatAmountMinor: 34900n,
    seatsPurchased: 15,
    includedSeats: 15,
  };

  it("produces one line when no extra seats are used", () => {
    const lines = buildSubscriptionLines(base);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.lineType).toBe("subscription");
  });

  it("⭐ itemises extra seats SEPARATELY, never folded into the plan price", () => {
    // A single line reading "Advanced — ₹8,486" is arithmetic the customer
    // cannot check. Two lines is a bill they can reconcile against their
    // own headcount without calling you.
    const lines = buildSubscriptionLines({ ...base, seatsPurchased: 24 });
    expect(lines).toHaveLength(2);
    expect(lines[1]!.quantity).toBe(9);
    expect(lines[1]!.unitAmountMinor).toBe(34900n);
    expect(lines[1]!.description).toMatch(/9 additional users/);
    expect(lines[1]!.description).toMatch(/beyond the 15 included/);
  });

  it("says 'user' not 'users' for exactly one extra seat", () => {
    const lines = buildSubscriptionLines({ ...base, seatsPurchased: 16 });
    expect(lines[1]!.description).toMatch(/1 additional user\b/);
    expect(lines[1]!.description).not.toMatch(/users/);
  });

  it("omits the seat line when per-seat pricing is zero", () => {
    // An unlimited-seat plan must not show a "0 × ₹0.00" line.
    const lines = buildSubscriptionLines({
      ...base,
      seatsPurchased: 40,
      perSeatAmountMinor: 0n,
    });
    expect(lines).toHaveLength(1);
  });

  it("never produces a negative seat count from a downgrade", () => {
    // Fewer seats purchased than included is legitimate after a plan
    // change; it must not become a negative charge.
    const lines = buildSubscriptionLines({ ...base, seatsPurchased: 3 });
    expect(lines).toHaveLength(1);
  });
});

describe("buildProrationLines", () => {
  const args = {
    oldPlanName: "Basic",
    newPlanName: "Advanced",
    periodStart: new Date("2026-07-01T00:00:00Z"),
    periodEnd: new Date("2026-08-01T00:00:00Z"),
    changeAt: new Date("2026-07-16T12:00:00Z"),
    oldAmountMinor: 200000n,
    newAmountMinor: 400000n,
  };

  it("⭐ shows the credit and the charge as SEPARATE lines", () => {
    // Netting them into "plan change — ₹1,000" is smaller and completely
    // unverifiable by the person paying it.
    const lines = buildProrationLines(args);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.unitAmountMinor).toBeLessThan(0n);
    expect(lines[1]!.unitAmountMinor).toBeGreaterThan(0n);
  });

  it("describes each line in terms a customer can check", () => {
    const lines = buildProrationLines(args);
    expect(lines[0]!.description).toMatch(/Credit for \d+ unused day/);
    expect(lines[0]!.description).toMatch(/Basic/);
    expect(lines[1]!.description).toMatch(/Advanced/);
  });

  it("nets to the same figure the preview showed", () => {
    // The invoice and the upgrade preview must agree to the paisa, or the
    // customer was quoted one number and charged another.
    const lines = buildProrationLines(args);
    const net = lines.reduce(
      (sum, line) => sum + BigInt(line.quantity) * line.unitAmountMinor,
      0n,
    );
    // Half the period remains: credit ₹1,000 of the old ₹2,000 plan,
    // charge ₹2,000 of the new ₹4,000 one. Net ₹1,000.
    expect(net).toBe(100000n);
  });
});

/* ================================================================== */
/* 5. THE HEADER AND THE LINES MUST AGREE                              */
/* ================================================================== */

describe("the rendered document is internally consistent", () => {
  it("⭐ the lines sum to the taxable value shown in the totals", () => {
    // The database check constraint proves the HEADER is self-consistent.
    // It says nothing about whether the header agrees with the itemisation
    // beneath it — and a customer reading the document adds up the lines.
    const lines: InvoiceLineRow[] = [
      { description: "Plan", sacCode: "998314", quantity: 1, unitAmountMinor: 499900n, amountMinor: 499900n, taxRateBps: 1800 },
      { description: "Seats", sacCode: "998314", quantity: 9, unitAmountMinor: 34900n, amountMinor: 314100n, taxRateBps: 1800 },
    ];
    const subtotal = lines.reduce((s, l) => s + BigInt(l.amountMinor), 0n);
    const gst = computeGst(subtotal, 1800, "29", "29");
    const total = subtotal + gst.cgstMinor + gst.sgstMinor + gst.igstMinor;

    const html = renderInvoiceHtml({
      invoice: invoice({
        subtotalMinor: subtotal,
        cgstMinor: gst.cgstMinor,
        sgstMinor: gst.sgstMinor,
        igstMinor: gst.igstMinor,
        totalMinor: total,
      }),
      lines,
      supplier: SUPPLIER,
    });

    // The taxable value in the totals block equals the sum of the lines.
    // 814000 PAISE = ₹8,140.00. Writing the expectation as "8,14,000"
    // was a paise/rupee confusion in the test itself — worth leaving the
    // note, because it is the same slip that produces a 100× invoice.
    expect(subtotal).toBe(814000n);
    expect(html).toContain("8,140.00");
    expect(gst.cgstMinor + gst.sgstMinor).toBe(gst.totalTaxMinor);
  });

  it("shows outstanding only when a payment has been recorded", () => {
    expect(render()).not.toMatch(/>Outstanding</);
    expect(render(invoice({ amountPaidMinor: 100000n }))).toMatch(/>Outstanding</);
  });

  it("is a complete, self-contained document with no external resources", () => {
    // It must render identically offline, in an email client, and in five
    // years. A CDN font that 404s turns a legal document into a mess.
    const html = render();
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).not.toMatch(/<link[^>]+href=["']http/i);
    expect(html).not.toMatch(/<script/i);
    expect(html).toMatch(/@media print/);
  });

  it("uses tabular figures so digits align down the column", () => {
    // The single most important typographic property of a financial
    // document — misaligned digits are misread.
    expect(render()).toMatch(/font-variant-numeric:\s*tabular-nums/);
  });
});
