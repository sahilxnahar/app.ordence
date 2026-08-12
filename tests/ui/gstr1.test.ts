/**
 * GSTR-1.
 *
 * ⚠️ EVERY TEST HERE GUARDS A MISTAKE THAT FILES SUCCESSFULLY. The portal
 * accepts a wrong classification without complaint; the consequence
 * arrives weeks later as a customer who cannot claim their credit, or a
 * notice.
 */
import { describe, expect, it } from "vitest";
import {
  B2CL_THRESHOLD_MINOR,
  buildGstr1,
  classify,
  toRupees,
  type Gstr1Document,
} from "@/lib/gstr1/build";

const line = (over: Partial<Gstr1Document["lines"][number]> = {}) => ({
  hsnSacCode: "7214",
  description: "TMT bar",
  uom: "tonne",
  quantity: "1.000",
  taxRateBps: 1800,
  taxableValueMinor: 100_000n,
  cgstMinor: 9_000n,
  sgstMinor: 9_000n,
  igstMinor: 0n,
  cessMinor: 0n,
  ...over,
});

const doc = (over: Partial<Gstr1Document> = {}): Gstr1Document => ({
  id: "d1",
  number: "ORD/2627/00001",
  date: "2026-04-10",
  kind: "invoice",
  customerGstin: "27AAAAA0000A1Z5",
  customerName: "Acme Steel",
  placeOfSupplyCode: "27",
  isInterState: false,
  isReverseCharge: false,
  taxableValueMinor: 100_000n,
  cgstMinor: 9_000n,
  sgstMinor: 9_000n,
  igstMinor: 0n,
  cessMinor: 0n,
  totalMinor: 118_000n,
  lines: [line()],
  ...over,
});

describe("🔴 money leaves as a string, computed in integers", () => {
  it("formats paise to two decimals", () => {
    expect(toRupees(118_000n)).toBe("1180.00");
    expect(toRupees(1n)).toBe("0.01");
    expect(toRupees(-5_050n)).toBe("-50.50");
  });

  it("survives a value a float would not", () => {
    // ₹1,00,00,00,000.99 — beyond Number.MAX_SAFE_INTEGER in paise.
    expect(toRupees(100_000_000_099n)).toBe("1000000000.99");
  });
});

describe("🔴 classification — the errors that file successfully", () => {
  it("a registered buyer is always B2B", () => {
    expect(classify(doc())).toBe("B2B");
  });

  /**
   * Misclassifying a B2B invoice does not hurt our return. It silently
   * denies the CUSTOMER their input credit, and they find out weeks later.
   */
  it("a registered buyer stays B2B even on a large inter-state supply", () => {
    expect(
      classify(doc({ isInterState: true, totalMinor: B2CL_THRESHOLD_MINOR * 10n })),
    ).toBe("B2B");
  });

  it("an unregistered inter-state supply above the threshold is B2CL", () => {
    expect(
      classify(
        doc({
          customerGstin: null,
          isInterState: true,
          totalMinor: B2CL_THRESHOLD_MINOR + 1n,
        }),
      ),
    ).toBe("B2CL");
  });

  /** BOTH conditions. A large INTRA-state retail sale is B2CS, not B2CL. */
  it("a large INTRA-state unregistered supply is B2CS, not B2CL", () => {
    expect(
      classify(
        doc({ customerGstin: null, isInterState: false, totalMinor: B2CL_THRESHOLD_MINOR * 5n }),
      ),
    ).toBe("B2CS");
  });

  it("exactly at the threshold is B2CS — the boundary is strictly above", () => {
    expect(
      classify(
        doc({ customerGstin: null, isInterState: true, totalMinor: B2CL_THRESHOLD_MINOR }),
      ),
    ).toBe("B2CS");
  });

  it("credit notes split by registration too", () => {
    expect(classify(doc({ kind: "credit_note" }))).toBe("CDNR");
    expect(classify(doc({ kind: "credit_note", customerGstin: null }))).toBe("CDNUR");
  });

  it("treats a blank GSTIN as unregistered, not as registered", () => {
    expect(classify(doc({ customerGstin: "   ", isInterState: false }))).toBe("B2CS");
  });
});

describe("🔴 a credit note SUBTRACTS", () => {
  const built = buildGstr1({
    period: "2026-04",
    supplierGstin: "27BBBBB0000B1Z5",
    documents: [
      doc(),
      doc({
        id: "d2",
        number: "CN/00001",
        kind: "credit_note",
        againstInvoiceNumber: "ORD/2627/00001",
        againstInvoiceDate: "2026-04-10",
      }),
    ],
  });

  /**
   * An HSN summary that ADDED credit notes overstates turnover by twice
   * the value of every return.
   */
  it("nets to zero across an invoice and its full credit note", () => {
    expect(built.totals.taxableValue).toBe("0.00");
    expect(built.totals.cgst).toBe("0.00");
  });

  it("and the HSN summary nets to zero too", () => {
    expect(built.hsn[0]?.taxableValue).toBe("0.00");
    expect(built.hsn[0]?.quantity).toBe("0.000");
  });

  it("but both documents still appear in their own tables", () => {
    expect(built.b2b).toHaveLength(1);
    expect(built.cdnr).toHaveLength(1);
    expect(built.totals.documentCount).toBe(2);
  });

  it("a credit note carries the invoice it reduces", () => {
    expect(built.cdnr[0]?.againstInvoiceNumber).toBe("ORD/2627/00001");
  });
});

describe("🔴 B2CS is a summary, B2B is not", () => {
  const built = buildGstr1({
    period: "2026-04",
    supplierGstin: null,
    documents: [
      doc({ id: "a", number: "A1", customerGstin: null }),
      doc({ id: "b", number: "A2", customerGstin: null }),
    ],
  });

  it("collapses same place-of-supply and rate into one row", () => {
    expect(built.b2cs).toHaveLength(1);
    expect(built.b2cs[0]?.taxableValue).toBe("2000.00");
    expect(built.b2cs[0]?.taxRatePercent).toBe("18");
  });
});

describe("🔴 the HSN summary spans every section", () => {
  it("includes B2B and B2CS lines in one table", () => {
    const built = buildGstr1({
      period: "2026-04",
      supplierGstin: null,
      documents: [doc({ id: "a", number: "A1" }), doc({ id: "b", number: "A2", customerGstin: null })],
    });
    expect(built.hsn).toHaveLength(1);
    expect(built.hsn[0]?.taxableValue).toBe("2000.00");
  });

  it("separates rates that differ", () => {
    const built = buildGstr1({
      period: "2026-04",
      supplierGstin: null,
      documents: [
        doc({ id: "a", number: "A1", lines: [line({ taxRateBps: 1800 })] }),
        doc({ id: "b", number: "A2", lines: [line({ taxRateBps: 500 })] }),
      ],
    });
    expect(built.hsn).toHaveLength(2);
    expect(built.hsn.map((h) => h.taxRatePercent).sort()).toEqual(["18", "5"]);
  });
});

describe("🔴 warnings are returned, never thrown", () => {
  it("flags a missing place of supply and still includes the document", () => {
    const built = buildGstr1({
      period: "2026-04",
      supplierGstin: null,
      documents: [doc({ placeOfSupplyCode: null })],
    });
    expect(built.warnings.join(" ")).toMatch(/no place of supply/);
    expect(built.totals.documentCount).toBe(1);
  });

  it("flags a document carrying both IGST and CGST/SGST", () => {
    const built = buildGstr1({
      period: "2026-04",
      supplierGstin: null,
      documents: [doc({ igstMinor: 100n })],
    });
    expect(built.warnings.join(" ")).toMatch(/place-of-supply error/);
  });

  it("flags a missing HSN code — Rule 46(g)", () => {
    const built = buildGstr1({
      period: "2026-04",
      supplierGstin: null,
      documents: [doc({ lines: [line({ hsnSacCode: null })] })],
    });
    expect(built.warnings.join(" ")).toMatch(/HSN\/SAC/);
  });

  /** The deadline does not move for one questionable row. */
  it("never throws — a return with problems still has to be filed", () => {
    expect(() =>
      buildGstr1({
        period: "2026-04",
        supplierGstin: null,
        documents: [doc({ placeOfSupplyCode: null, igstMinor: 5n, lines: [line({ hsnSacCode: "" })] })],
      }),
    ).not.toThrow();
  });
});

describe("🔴 Table 13 declares the series", () => {
  it("reports the range and the count", () => {
    const built = buildGstr1({
      period: "2026-04",
      supplierGstin: null,
      documents: [
        doc({ id: "a", number: "ORD/2627/00001" }),
        doc({ id: "b", number: "ORD/2627/00007" }),
      ],
    });
    expect(built.docIssued[0]).toMatchObject({
      from: "ORD/2627/00001",
      to: "ORD/2627/00007",
      totalNumber: 2,
    });
  });

  it("excludes credit notes — they have their own series", () => {
    const built = buildGstr1({
      period: "2026-04",
      supplierGstin: null,
      documents: [doc(), doc({ id: "c", number: "CN/00001", kind: "credit_note" })],
    });
    expect(built.docIssued[0]?.totalNumber).toBe(1);
  });
});

/* ================================================================== */
/* THE WIRING                                                          */
/* ================================================================== */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const stripped = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("🔴 the period window is half-open", () => {
  const ACTIONS = stripped(src("server/actions/sales-invoices.ts"));
  const DOCS = stripped(src("server/invoicing/documents.ts"));

  /**
   * A closed range on a timestamp loses every document issued after
   * 00:00:00 on the last day — which is nearly all of them. The classic
   * month-boundary bug, and it under-reports a statutory return.
   */
  it("uses gte/lt, never lte, on the issue timestamp", () => {
    expect(DOCS).toContain("gte(salesInvoices.issuedAt");
    expect(DOCS).toContain("lt(salesInvoices.issuedAt");
    expect(DOCS).not.toContain("lte(salesInvoices.issuedAt");
  });

  it("rolls December into the next year", () => {
    expect(ACTIONS).toMatch(/month === 12/);
  });

  /**
   * A document dated 30 April but issued 3 May belongs to May's return —
   * it did not exist when April closed.
   */
  it("filters on issuedAt, not on invoiceDate", () => {
    expect(DOCS).not.toContain("gte(salesInvoices.invoiceDate");
  });

  it("excludes drafts and cancelled documents from the return", () => {
    expect(DOCS).toContain('notInArray(salesInvoices.status, ["draft", "cancelled"])');
    expect(DOCS).toContain('notInArray(salesCreditNotes.status, ["draft", "cancelled"])');
  });

  it("is a read, gated on a read permission", () => {
    expect(ACTIONS).toMatch(/buildGstr1Return[\s\S]{0,400}sales\.invoices\.read/);
  });
});

describe("🔴 the intra-UT gap from Phase 49 is closed", () => {
  const ACTIONS = stripped(src("server/actions/sales-invoices.ts"));

  it("uses taxKindFor rather than assuming cgst_sgst", () => {
    expect(ACTIONS).toContain("taxKindFor(order.isInterState");
    expect(ACTIONS).not.toMatch(/order\.isInterState \? \("igst" as const\) : \("cgst_sgst"/);
  });

  it("records isUnionTerritory on the invoice from the resolved kind", () => {
    expect(ACTIONS).toContain('isUnionTerritory: taxKind === "cgst_utgst"');
  });
});
