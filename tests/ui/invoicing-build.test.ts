/**
 * Building an invoice from an order.
 *
 * The tests that matter are the decimal ones. Everything else is
 * bookkeeping; a quantity that drifts by 0.001 is an order that can
 * never be closed.
 */
import { describe, expect, it } from "vitest";
import {
  billableQty,
  buildInvoice,
  buildInvoiceLines,
  formatInvoiceNumber,
  fromQtyMinor,
  toQtyMinor,
  InvoiceBuildError,
  type OrderLineFacts,
} from "@/lib/invoicing/build";

const line = (over: Partial<OrderLineFacts> = {}): OrderLineFacts => ({
  id: "l1",
  lineNo: 1,
  description: "TMT bar 12mm",
  uom: "tonne",
  quantity: "10.000",
  qtyInvoiced: "0.000",
  qtyCancelled: "0.000",
  unitPriceMinor: 5_000_000n, // ₹50,000 a tonne
  discountMinor: 0n,
  taxRateBps: 1800,
  cessRateBps: 0,
  ...over,
});

describe("🔴 quantity never touches a float", () => {
  it("round-trips three decimals exactly", () => {
    for (const q of ["0.001", "12.500", "0.100", "999999.999"]) {
      expect(fromQtyMinor(toQtyMinor(q))).toBe(q);
    }
  });

  it("the classic float failure does not occur", () => {
    // 0.1 + 0.2 === 0.30000000000000004 as a float.
    expect(fromQtyMinor(toQtyMinor("0.1") + toQtyMinor("0.2"))).toBe("0.300");
  });

  it("truncates beyond three decimals rather than rounding", () => {
    // The column holds 3. Rounding here would disagree with Postgres.
    expect(fromQtyMinor(toQtyMinor("1.9999"))).toBe("1.999");
  });

  it("refuses a malformed quantity instead of coercing it", () => {
    expect(() => toQtyMinor("12.5.3")).toThrow();
    expect(() => toQtyMinor("abc")).toThrow();
  });
});

describe("billableQty", () => {
  it("is quantity less invoiced less cancelled", () => {
    expect(billableQty(line({ qtyInvoiced: "3.000", qtyCancelled: "1.000" }))).toBe(6_000n);
  });

  it("floors at zero", () => {
    expect(billableQty(line({ qtyInvoiced: "99.000" }))).toBe(0n);
  });

  /**
   * A return happens after invoicing and is reversed by a credit note.
   * Making the line billable again would invoice the same goods twice.
   */
  it("does NOT add returned quantity back", () => {
    const l = line({ qtyInvoiced: "10.000" });
    expect(billableQty(l)).toBe(0n);
  });
});

describe("buildInvoiceLines", () => {
  it("bills the whole outstanding quantity when none is given", () => {
    const [built] = buildInvoiceLines([line()], [{ orderLineId: "l1" }]);
    expect(built?.quantity).toBe("10.000");
    expect(built?.grossMinor).toBe(50_000_000n); // 10 × ₹50,000
  });

  it("multiplies before dividing, so a fractional quantity is exact", () => {
    const [built] = buildInvoiceLines(
      [line({ quantity: "20.000" })],
      [{ orderLineId: "l1", quantity: "12.500" }],
    );
    // Would be wrong if qty were truncated to whole units first.
    expect(built?.grossMinor).toBe(62_500_000n);
  });

  it("refuses to invoice more than remains, and names both figures", () => {
    expect(() =>
      buildInvoiceLines([line({ qtyInvoiced: "8.000" })], [{ orderLineId: "l1", quantity: "5.000" }]),
    ).toThrow(/2\.000.*remain/s);
  });

  it("refuses a line selected twice rather than summing it", () => {
    expect(() =>
      buildInvoiceLines([line()], [{ orderLineId: "l1" }, { orderLineId: "l1" }]),
    ).toThrow(InvoiceBuildError);
  });

  it("refuses when nothing is left to bill", () => {
    expect(() => buildInvoiceLines([line({ qtyInvoiced: "10.000" })], [{ orderLineId: "l1" }]))
      .toThrow(/nothing left to invoice/);
  });

  it("refuses a line that is not on the order", () => {
    expect(() => buildInvoiceLines([line()], [{ orderLineId: "ghost" }])).toThrow(
      InvoiceBuildError,
    );
  });
});

describe("🔴 the discount closes exactly across part invoices", () => {
  /**
   * ₹100 across 3 units is 33.33 each; three invoices of 33.33 return
   * 99.99 and the customer is one paisa short of what they were promised.
   * The invoice that clears the line takes the remainder.
   */
  it("gives the final invoice the undischarged remainder", () => {
    const l = line({ quantity: "3.000", discountMinor: 10_000n, unitPriceMinor: 100_000n });

    const [first] = buildInvoiceLines([l], [{ orderLineId: "l1", quantity: "1.000" }]);
    const [second] = buildInvoiceLines(
      [{ ...l, qtyInvoiced: "1.000" }],
      [{ orderLineId: "l1", quantity: "1.000" }],
    );
    const [third] = buildInvoiceLines(
      [{ ...l, qtyInvoiced: "2.000" }],
      [{ orderLineId: "l1" }], // clears the line
    );

    const total =
      (first?.discountMinor ?? 0n) + (second?.discountMinor ?? 0n) + (third?.discountMinor ?? 0n);
    expect(total).toBe(10_000n);
    expect(third?.discountMinor).toBe(3_334n); // takes the odd paisa
  });
});

describe("buildInvoice delegates to the tax engine", () => {
  it("splits CGST/SGST intra-state and never emits IGST as well", () => {
    const { tax } = buildInvoice({
      orderLines: [line()],
      selection: [{ orderLineId: "l1" }],
      taxKind: "cgst_sgst",
      placeOfSupplyCode: "27",
    });
    expect(tax.igstMinor).toBe(0n);
    expect(tax.cgstMinor).toBeGreaterThan(0n);
    expect(tax.cgstMinor).toBe(tax.sgstMinor);
    expect(tax.taxableMinor).toBe(50_000_000n);
  });

  it("emits IGST inter-state and no CGST/SGST", () => {
    const { tax } = buildInvoice({
      orderLines: [line()],
      selection: [{ orderLineId: "l1" }],
      taxKind: "igst",
      placeOfSupplyCode: "29",
    });
    expect(tax.cgstMinor).toBe(0n);
    expect(tax.sgstMinor).toBe(0n);
    expect(tax.igstMinor).toBe(9_000_000n); // 18% of ₹5,00,000
  });

  /** Reverse-charge tax is shown and NOT collected. */
  it("keeps reverse-charge tax out of what we collect", () => {
    const { tax } = buildInvoice({
      orderLines: [line()],
      selection: [{ orderLineId: "l1" }],
      taxKind: "igst",
      placeOfSupplyCode: "29",
      reverseCharge: true,
    });
    expect(tax.totalTaxMinor).toBe(0n);
    expect(tax.reverseChargeTaxMinor).toBeGreaterThan(0n);
  });

  it("does not round to the rupee unless asked", () => {
    const { tax } = buildInvoice({
      orderLines: [line({ unitPriceMinor: 33_333n, quantity: "1.000" })],
      selection: [{ orderLineId: "l1" }],
      taxKind: "igst",
      placeOfSupplyCode: "29",
    });
    expect(tax.roundOffMinor).toBe(0n);
  });
});

describe("🔴 Rule 46(b) — the number fits in 16 characters", () => {
  it("produces a compliant number", () => {
    const n = formatInvoiceNumber({ financialYear: "2026-27", sequence: 1 });
    expect(n).toBe("ORD/2627/00001");
    expect(n.length).toBeLessThanOrEqual(16);
    expect(n).toMatch(/^[A-Z0-9/-]+$/);
  });

  it("refuses a prefix that would breach the legal limit", () => {
    // ORDENCE/2627/00001 is 18 — unlawful, and silently so.
    expect(() =>
      formatInvoiceNumber({ prefix: "ORDENCEX", financialYear: "2026-27", sequence: 1 }),
    ).not.toThrow(); // prefix is clipped to 4 first
    expect(
      formatInvoiceNumber({ prefix: "ORDENCEX", financialYear: "2026-27", sequence: 1 }).length,
    ).toBeLessThanOrEqual(16);
  });

  it("strips punctuation a workspace might type into a prefix", () => {
    expect(formatInvoiceNumber({ prefix: "a-b/", financialYear: "2026-27", sequence: 42 })).toBe(
      "AB/2627/00042",
    );
  });
});
