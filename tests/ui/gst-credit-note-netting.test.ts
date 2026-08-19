/**
 * Ordence — ⭐⭐⭐ RULE 53: WHAT A CREDIT NOTE DOES TO OUTPUT TAX
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE FAULT THESE TESTS DEFEND AGAINST
 * ══════════════════════════════════════════════════════════════════════
 * `getGstSummary` reported output tax GROSS of credit notes and said so
 * on the payload (`outputTaxExcludesCreditNotes: true`). Every workspace
 * that has ever taken a return was shown a GST liability that was too
 * high, every month.
 *
 * ⚠️ AND THE OBVIOUS FIX IS WRONG FOUR WAYS, each of which produces a
 * figure that foots:
 *   ① a note issued after the s.34(2) deadline reduces NOTHING;
 *   ② a note belongs to the period it is DECLARED in, not the period of
 *      the invoice it reduces;
 *   ③ CGST reduces CGST — the heads are different governments;
 *   ④ a net below zero is REAL and carries forward. It is not zero.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHAT IS ASSERTED, AND WHAT DELIBERATELY IS NOT
 * ══════════════════════════════════════════════════════════════════════
 * Nothing below pins a count, an id or a total from the product. Every
 * money figure in an assertion is one the test itself constructed, and
 * every assertion is a PROPERTY — stated over a grid of inputs rather
 * than one lucky example, because the bug being defended against
 * produces a plausible number for every single one of them.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  GST_HEADS,
  ZERO_HEADS,
  creditNoteEffect,
  financialYearOf,
  netCreditNotes,
  section34Deadline,
  taxPeriodOf,
  totalOf,
  type Head,
  type HeadAmounts,
  type PeriodMovement,
} from "@/lib/gstr1/netting";
import { buildGstr1, type Gstr1Document } from "@/lib/gstr1/build";

const heads = (over: Partial<Record<Head, bigint>> = {}): HeadAmounts => ({
  igst: 0n,
  cgst: 0n,
  sgst: 0n,
  cess: 0n,
  ...over,
});

const movement = (period: string, h: Partial<Record<Head, bigint>>, value = 0n): PeriodMovement => ({
  period,
  heads: heads(h),
  taxableValueMinor: value,
});

/* ================================================================== */
/* ① A HEAD REDUCES ITS OWN HEAD, AND ONLY ITS OWN                    */
/* ================================================================== */

describe("🔴 CGST reduces CGST — the heads are different governments", () => {
  /**
   * ⭐ STATED OVER EVERY HEAD, not demonstrated on one. An
   * implementation that netted totals rather than heads passes a
   * single-head example and fails here on the second iteration.
   */
  it("a credit note reduces the matching head and leaves the others exactly alone", () => {
    const supplied = { igst: 700_00n, cgst: 900_00n, sgst: 900_00n, cess: 100_00n };

    for (const head of GST_HEADS) {
      const netting = netCreditNotes({
        supplies: [movement("2026-05", supplied)],
        reductions: [movement("2026-05", { [head]: 100_00n })],
      });

      expect(netting.net[head]).toBe(supplied[head] - 100_00n);
      for (const other of GST_HEADS) {
        if (other === head) continue;
        expect(
          netting.net[other],
          `reducing ${head} moved ${other} — that is one government's money paying another's`,
        ).toBe(supplied[other]);
      }
    }
  });

  /**
   * 🔴 THE ANTI-PROPERTY. An intra-state credit note against an
   * inter-state month must NOT come out right in total. If it does, the
   * netting is happening on the sum and both halves are wrong.
   */
  it("an intra-state note cannot pay an inter-state liability", () => {
    const netting = netCreditNotes({
      supplies: [movement("2026-05", { igst: 500_00n })],
      reductions: [movement("2026-05", { cgst: 250_00n, sgst: 250_00n })],
    });

    expect(netting.liability.igst).toBe(500_00n);
    expect(netting.net.cgst).toBeLessThan(0n);
    expect(netting.net.sgst).toBeLessThan(0n);
    // The TOTAL nets to zero. The liability does not, and that is the point.
    expect(totalOf(netting.net)).toBe(0n);
    expect(totalOf(netting.liability)).toBeGreaterThan(0n);
  });
});

/* ================================================================== */
/* ② THE PERIOD IS THE NOTE'S, NOT THE INVOICE'S                      */
/* ================================================================== */

describe("🔴 a reduction lands in the period it is declared in", () => {
  it("reduces the note's own period and not the invoice's", () => {
    const netting = netCreditNotes({
      supplies: [movement("2026-06", { cgst: 500_00n }), movement("2026-08", { cgst: 500_00n })],
      reductions: [movement("2026-08", { cgst: 200_00n })],
    });

    const june = netting.periods.find((p) => p.period === "2026-06");
    const august = netting.periods.find((p) => p.period === "2026-08");

    expect(june?.reductions.cgst).toBe(0n);
    expect(june?.liability.cgst).toBe(500_00n);
    expect(august?.reductions.cgst).toBe(200_00n);
    expect(august?.liability.cgst).toBe(300_00n);
  });

  /** A period with only reductions still exists. It is not skipped. */
  it("a period with a reduction and no supply is still a period", () => {
    const netting = netCreditNotes({
      supplies: [movement("2026-06", { cgst: 500_00n })],
      reductions: [movement("2026-09", { cgst: 100_00n })],
    });
    expect(netting.periods.map((p) => p.period)).toContain("2026-09");
  });

  /**
   * ⚠️ A DATE WITH NO ZONE MUST NOT BE PUT THROUGH `Date`. Doing so
   * applies the server's zone and moves documents across a month
   * boundary — the entire class of bug this codebase keeps finding.
   */
  it("reads the period off the string and never through a clock", () => {
    expect(taxPeriodOf("2026-04-01")).toBe("2026-04");
    expect(taxPeriodOf("2026-03-31T23:59:59.999Z")).toBe("2026-03");
  });
});

/* ================================================================== */
/* ③ SECTION 34(2) — A NOTE OUT OF TIME REDUCES NOTHING               */
/* ================================================================== */

describe("🔴 section 34(2): after the deadline a credit note has no tax effect", () => {
  /**
   * ⭐ THE FINANCIAL YEAR IS DERIVED, and the boundary is 1 April. A
   * March supply and an April supply are in different years and have
   * deadlines twelve months apart.
   */
  it("puts the year boundary at 1 April, not 1 January", () => {
    expect(financialYearOf("2026-03-31").label).toBe("2025-26");
    expect(financialYearOf("2026-04-01").label).toBe("2026-27");
    expect(section34Deadline("2026-03-31")).toBe("2026-11-30");
    expect(section34Deadline("2026-04-01")).toBe("2027-11-30");
  });

  /**
   * ⭐ THE BOUNDARY, FROM BOTH SIDES, ACROSS A GRID OF SUPPLY DATES. The
   * deadline day itself is inside the window; the next day is not.
   */
  it("the deadline day reduces and the day after does not, for every year tested", () => {
    for (const supplyDate of ["2024-04-05", "2024-12-31", "2025-03-31", "2025-04-01", "2026-01-15"]) {
      const deadline = section34Deadline(supplyDate);
      const dayAfter = `${deadline.slice(0, 8)}${String(Number(deadline.slice(8)) + 1).padStart(2, "0")}`;

      expect(creditNoteEffect({ noteDate: deadline, supplyDate }).reducesOutputTax).toBe(true);
      const late = creditNoteEffect({ noteDate: dayAfter, supplyDate });
      expect(late.reducesOutputTax, `${dayAfter} is after ${deadline}`).toBe(false);
      expect(late.reason).toBe("time_barred");
    }
  });

  /**
   * ⚠️ THE EARLIER LIMB. The window closes on the annual return's filing
   * date when that comes first, and a note between the two dates is out
   * of time even though 30 November has not arrived.
   */
  it("closes early when the annual return was furnished first", () => {
    const supplyDate = "2025-06-10";
    expect(section34Deadline(supplyDate, "2026-09-15")).toBe("2026-09-15");
    expect(section34Deadline(supplyDate, "2027-01-01")).toBe("2026-11-30");
    expect(
      creditNoteEffect({ noteDate: "2026-10-01", supplyDate, annualReturnFiledOn: "2026-09-15" })
        .reducesOutputTax,
    ).toBe(false);
  });

  /**
   * 🔴 MISSING DATA IS NOT A REFUSAL. Refusing the reduction because the
   * original supply date is unknown would overstate the liability — the
   * exact fault this batch exists to remove — so it reduces and is
   * flagged for a human.
   */
  it("an unknown supply date is flagged, not silently treated as out of time", () => {
    const effect = creditNoteEffect({ noteDate: "2026-08-01", supplyDate: null });
    expect(effect.reducesOutputTax).toBe(true);
    expect(effect.reason).toBe("supply_date_unknown");
    expect(effect.deadline).toBeNull();
  });
});

/* ================================================================== */
/* ④ BELOW ZERO IS REAL, AND CARRIES                                  */
/* ================================================================== */

describe("🔴 netting below zero is carried, never clamped away", () => {
  const netting = netCreditNotes({
    supplies: [movement("2026-05", { cgst: 100_00n }), movement("2026-06", { cgst: 400_00n })],
    reductions: [movement("2026-05", { cgst: 300_00n })],
  });

  const may = () => netting.periods.find((p) => p.period === "2026-05");
  const june = () => netting.periods.find((p) => p.period === "2026-06");

  /** The signed net keeps the sign. Reporting it as zero is a lie. */
  it("reports the period's net as negative rather than as zero", () => {
    expect(may()?.net.cgst).toBeLessThan(0n);
    expect(netting.hasNegativePeriod).toBe(true);
  });

  /** But nothing is PAYABLE. A negative liability is not a refund. */
  it("makes nothing payable for that period, and does not invent a refund", () => {
    expect(may()?.liability.cgst).toBe(0n);
    expect(totalOf(may()?.liability ?? ZERO_HEADS)).toBe(0n);
  });

  /** ⭐ AND THE EXCESS REDUCES THE NEXT PERIOD, on the same head. */
  it("carries the excess into the next period on the same head", () => {
    expect(may()?.carriedOut.cgst).toBe(200_00n);
    expect(june()?.carriedIn.cgst).toBe(200_00n);
    expect(june()?.liability.cgst).toBe(200_00n);
    // Not onto any other head.
    expect(june()?.carriedIn.sgst).toBe(0n);
    expect(june()?.carriedIn.igst).toBe(0n);
  });

  /**
   * ⭐⭐ THE CONSERVATION INVARIANT, OVER A GRID. Whatever the shape of
   * the data, no reduction may be created or destroyed:
   *
   *     liability = net + carriedForward, head by head.
   *
   * A clamp that threw the excess away breaks this on the first negative
   * period; a carry that leaked across heads breaks it on the second.
   */
  it("neither creates nor destroys a reduction, for every shape tested", () => {
    const shapes: { supplies: PeriodMovement[]; reductions: PeriodMovement[] }[] = [
      { supplies: [], reductions: [movement("2026-05", { cgst: 10n })] },
      {
        supplies: [movement("2026-05", { cgst: 1n, sgst: 1n, igst: 1n, cess: 1n })],
        reductions: [movement("2026-05", { cgst: 5n, sgst: 0n, igst: 9n, cess: 2n })],
      },
      {
        supplies: [movement("2026-04", { igst: 100n }), movement("2026-05", { igst: 100n })],
        reductions: [movement("2026-04", { igst: 500n })],
      },
      {
        supplies: [movement("2026-04", { cgst: 999_999_999_999n })],
        reductions: [movement("2026-04", { cgst: 1n }), movement("2026-04", { cgst: 2n })],
      },
      {
        supplies: [movement("2027-01", { sgst: 50n }), movement("2026-12", { sgst: 50n })],
        reductions: [movement("2026-12", { sgst: 75n }), movement("2027-01", { sgst: 75n })],
      },
    ];

    for (const shape of shapes) {
      const result = netCreditNotes(shape);
      for (const head of GST_HEADS) {
        expect(
          result.liability[head],
          `head ${head}: liability must equal net plus what is still carrying`,
        ).toBe(result.net[head] + result.carriedForward[head]);
        expect(result.liability[head] >= 0n, "a liability is never negative").toBe(true);
        expect(result.carriedForward[head] >= 0n, "a carry is never negative").toBe(true);
      }
    }
  });

  /**
   * ⚠️ AND THE UNUSED REDUCTION SURVIVES THE END OF THE DATA. There is
   * no later period to absorb it, so it is reported rather than dropped.
   */
  it("keeps a reduction that no period could absorb", () => {
    const result = netCreditNotes({
      supplies: [movement("2026-05", { cgst: 10n })],
      reductions: [movement("2026-05", { cgst: 90n })],
    });
    expect(result.carriedForward.cgst).toBe(80n);
    expect(totalOf(result.liability)).toBe(0n);
  });
});

/* ================================================================== */
/* ⑤ THE RETURN AND THE SUMMARY APPLY ONE RULE                        */
/* ================================================================== */

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

const invoice = (over: Partial<Gstr1Document> = {}): Gstr1Document => ({
  id: "i1",
  number: "ORD/2526/00001",
  date: "2025-06-10",
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

const creditNote = (over: Partial<Gstr1Document> = {}): Gstr1Document =>
  invoice({
    id: "c1",
    number: "CN/00001",
    kind: "credit_note",
    againstInvoiceNumber: "ORD/2526/00001",
    againstInvoiceDate: "2025-06-10",
    ...over,
  });

describe("🔴 GSTR-1 applies section 34(2) to its own totals", () => {
  const inTime = buildGstr1({
    period: "2026-08",
    supplierGstin: "27BBBBB0000B1Z5",
    documents: [invoice(), creditNote({ date: "2026-08-01" })],
  });

  const outOfTime = buildGstr1({
    period: "2026-12",
    supplierGstin: "27BBBBB0000B1Z5",
    documents: [invoice(), creditNote({ date: "2026-12-01" })],
  });

  const invoiceOnly = buildGstr1({
    period: "2026-12",
    supplierGstin: "27BBBBB0000B1Z5",
    documents: [invoice()],
  });

  it("subtracts a note inside the window", () => {
    expect(inTime.totals.cgst).toBe("0.00");
    expect(inTime.creditNotes.nettedCount).toBeGreaterThan(0);
    expect(inTime.creditNotes.timeBarred).toHaveLength(0);
  });

  /**
   * 🔴 THE ONE THAT COSTS MONEY. Subtracting a time-barred note
   * UNDER-declares the return, and a shortfall carries interest under
   * s.50 and is found by a machine at reconciliation.
   */
  it("subtracts nothing for a note after the deadline", () => {
    expect(outOfTime.totals.cgst).toBe(invoiceOnly.totals.cgst);
    expect(outOfTime.totals.sgst).toBe(invoiceOnly.totals.sgst);
    expect(outOfTime.totals.igst).toBe(invoiceOnly.totals.igst);
    expect(outOfTime.totals.taxableValue).toBe(invoiceOnly.totals.taxableValue);
  });

  /** ⚠️ And Table 12 must not move either — the supply was not reduced. */
  it("leaves the HSN summary alone for a time-barred note", () => {
    expect(outOfTime.hsn.map((h) => h.taxableValue)).toEqual(
      invoiceOnly.hsn.map((h) => h.taxableValue),
    );
  });

  /**
   * ⚠️ THE DOCUMENT STILL EXISTS. Dropping it would make the return
   * disagree with the customer's books by exactly one document, and the
   * customer holds a credit note that our return denies.
   */
  it("still lists the document, and names it as out of time", () => {
    expect(outOfTime.cdnr).toHaveLength(1);
    expect(outOfTime.creditNotes.timeBarred).toHaveLength(1);
    expect(outOfTime.creditNotes.timeBarred[0]?.deadline).toBe(section34Deadline("2025-06-10"));
    expect(outOfTime.warnings.join(" ")).toMatch(/34\(2\)/);
  });

  /** A note whose original supply date is unknown is deducted AND named. */
  it("deducts an unverifiable note but does not hide that it did", () => {
    const built = buildGstr1({
      period: "2026-08",
      supplierGstin: null,
      documents: [invoice(), creditNote({ date: "2026-08-01", againstInvoiceDate: null })],
    });
    expect(built.totals.cgst).toBe("0.00");
    expect(built.creditNotes.windowUnverified).toContain("CN/00001");
    expect(built.warnings.join(" ")).toMatch(/34\(2\)/);
  });

  /**
   * ⭐⭐ THE SUMMARY AND THE RETURN AGREE, ASSERTED BY RUNNING BOTH OVER
   * THE SAME DOCUMENTS. `getGstSummary` cannot be executed without a
   * database, but the rule it applies is `netCreditNotes` over
   * `creditNoteEffect` — the same two functions the builder calls — so
   * the agreement is checkable here, where a disagreement would be
   * introduced.
   */
  it("the netting engine reaches the same figures as the return, note by note", () => {
    for (const noteDate of ["2025-07-01", "2026-08-01", "2026-11-30", "2026-12-01", "2027-06-30"]) {
      const documents = [invoice(), creditNote({ date: noteDate })];
      const built = buildGstr1({ period: taxPeriodOf(noteDate), supplierGstin: null, documents });

      const effect = creditNoteEffect({ noteDate, supplyDate: "2025-06-10" });
      const netting = netCreditNotes({
        supplies: [
          movement(taxPeriodOf("2025-06-10"), { cgst: 9_000n, sgst: 9_000n }, 100_000n),
        ],
        reductions: effect.reducesOutputTax
          ? [movement(taxPeriodOf(noteDate), { cgst: 9_000n, sgst: 9_000n }, 100_000n)]
          : [],
      });

      // The return's totals are the signed net of the same movements.
      const expected = effect.reducesOutputTax ? 0n : 9_000n;
      expect(netting.net.cgst, `summary disagrees with the return for ${noteDate}`).toBe(expected);
      expect(built.totals.cgst).toBe(
        `${expected / 100n}.${(expected % 100n).toString().padStart(2, "0")}`,
      );
    }
  });
});

/* ================================================================== */
/* ⑥ THE WIRING, AND THE ENUM-VALUE CLASS OF BUG                      */
/* ================================================================== */

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const stripComments = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));

describe("🔴 one implementation of Rule 53, reached from both screens", () => {
  /**
   * ⭐ THE CHECK THAT KEEPS THE TWO FIGURES ONE POSITION. If the summary
   * ever grows its own copy of the deadline, the two screens can differ
   * on a return and nothing will say so.
   */
  it("the summary and the return both call the shared engine", () => {
    const reports = stripComments(read("server/actions/reports.ts"));
    const build = stripComments(read("lib/gstr1/build.ts"));

    expect(reports).toMatch(/from "@\/lib\/gstr1\/netting"/);
    expect(reports).toMatch(/creditNoteEffect\(/);
    expect(reports).toMatch(/netCreditNotes\(/);
    expect(build).toMatch(/creditNoteEffect\(/);
  });

  /** The deadline is stated once. A second `11-30` is a second rule. */
  it("states the 30 November long stop in exactly one file", () => {
    const owners = [
      "server/actions/reports.ts",
      "lib/gstr1/build.ts",
      "lib/gstr1/netting.ts",
    ].filter((p) => /-11-30|11-30/.test(stripComments(read(p))));
    expect(owners).toEqual(["lib/gstr1/netting.ts"]);
  });

  /** The payload no longer claims to be gross of credit notes. */
  it("the summary stops declaring itself gross of credit notes", () => {
    const reports = stripComments(read("server/actions/reports.ts"));
    expect(reports).toMatch(/outputTaxExcludesCreditNotes:\s*false/);
    expect(reports).not.toMatch(/outputTaxExcludesCreditNotes:\s*true/);
  });
});

describe("🔴 no GST filter names a value its enum does not have", () => {
  /**
   * ⚠️ THE CLASS OF BUG, NOT THE INSTANCE. v1.66.0 found
   * `status = 'open'` in this file — `sales_invoice_status` has no such
   * label — and v1.67.0 found `status = 'completed'` beside it, which
   * `compliance_task_status` does not have either.
   *
   * ⭐ BOTH SURVIVED BECAUSE THEY WERE WRITTEN AS RAW SQL. Drizzle's
   * `eq(table.status, "…")` is typed against the enum and `tsc` refuses
   * a wrong label; a literal inside a `sql` template is a string to
   * everyone. So this test reads the raw comparisons out of the file and
   * checks each label against the enum the column actually declares.
   */
  const enumValues = (schemaFile: string, enumName: string): string[] => {
    const src = read(schemaFile);
    const start = src.indexOf(`export const ${enumName} = pgEnum(`);
    expect(start, `${enumName} should exist in ${schemaFile}`).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf("]);", start));
    return [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1] as string).slice(1);
  };

  const COLUMNS: { symbol: string; schema: string; enumName: string }[] = [
    {
      symbol: "salesInvoices",
      schema: "db/schema/sales-invoices.ts",
      enumName: "salesInvoiceStatusEnum",
    },
    {
      symbol: "salesCreditNotes",
      schema: "db/schema/sales-invoices.ts",
      enumName: "salesInvoiceStatusEnum",
    },
    {
      symbol: "complianceTasks",
      schema: "db/schema/compliance.ts",
      enumName: "complianceTaskStatusEnum",
    },
  ];

  it("every status literal in the reports module is a label of its own enum", () => {
    const body = stripComments(read("server/actions/reports.ts"));
    let checked = 0;

    for (const column of COLUMNS) {
      const labels = enumValues(column.schema, column.enumName);
      expect(labels.length).toBeGreaterThan(0);

      // `${salesInvoices.status} IN ('a', 'b')` and `… = 'a'`, in raw SQL.
      const pattern = new RegExp(
        `\\$\\{${column.symbol}\\.status\\}\\s*(?:=|IN)\\s*\\(?([^)\\n]*)`,
        "g",
      );
      for (const match of body.matchAll(pattern)) {
        for (const literal of (match[1] ?? "").matchAll(/'([a-z_]+)'/g)) {
          checked += 1;
          expect(
            labels,
            `"${literal[1]}" is not a value of ${column.enumName}`,
          ).toContain(literal[1] as string);
        }
      }
    }

    // The test is worthless if it matched nothing.
    expect(checked).toBeGreaterThan(0);
  });

  /**
   * ⚠️ A LIABILITY ARISES ON ISSUE, NOT ON PAYMENT. So the selection is
   * by lifecycle and a draft — which is not a document — is excluded.
   */
  it("selects credit notes by the same lifecycle as the invoices they reduce", () => {
    const body = stripComments(read("server/actions/reports.ts"));
    const selection = body.match(
      /\$\{salesCreditNotes\.status\}\s*IN\s*\(([^)]*)\)/,
    )?.[1];
    expect(selection, "credit notes must be selected by status").toBeTruthy();
    expect(selection).toMatch(/'issued'/);
    expect(selection).not.toMatch(/'draft'/);
    expect(selection).not.toMatch(/'cancelled'/);
  });
});
