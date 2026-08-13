/**
 * Credit notes — the two ceilings, and the screens that render them.
 *
 * The arithmetic tests are real: they call the module. The screen tests
 * read source, because a page compiles fine while leading with the wrong
 * number and "leads with the wrong number" is not a type error.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CREDIT_NOTE_REASON_META,
  assessCreditHeadroom,
  assessCreditLines,
  headroomMinor,
  previewCreditNote,
  remainingCreditableQty,
  remainingCreditableQtyMinor,
  type CreditableInvoiceLine,
} from "@/lib/invoicing/credit-note";
import { buildInvoice } from "@/lib/invoicing/build";
import { CREDIT_NOTE_REASONS } from "@/lib/validators/sales-invoices";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/**
 * ⚠️ ASSERTIONS RUN AGAINST COMMENT-STRIPPED SOURCE.
 * Twice now a test has matched the prose explaining a rule rather than
 * the code implementing it — and the only way to make such a test pass
 * is to delete the reason the rule exists. That is a bad test.
 */
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const MODULE = read("lib/invoicing/credit-note.ts");
const ACTIONS = read("server/actions/sales-invoices.ts");
const FORM = read("components/invoices/raise-credit-note.tsx");
const NOTE_ACTIONS = read("components/invoices/credit-note-actions.tsx");
const RAISE_PAGE = read("app/(crm)/invoices/[id]/credit/page.tsx");
const LIST_PAGE = read("app/(crm)/credit-notes/page.tsx");
const DETAIL_PAGE = read("app/(crm)/credit-notes/[id]/page.tsx");
const INVOICE_PAGE = read("app/(crm)/invoices/[id]/page.tsx");
const REGISTRY = read("lib/modules/registry.ts");

function line(over: Partial<CreditableInvoiceLine> = {}): CreditableInvoiceLine {
  return {
    id: "L1",
    lineNo: 1,
    description: "Cement OPC 53",
    hsnSacCode: "2523",
    uom: "bag",
    taxRateBps: 1800,
    unitPriceMinor: 10_000n,
    quantity: "10.000",
    quantityCreditedIssued: "0.000",
    ...over,
  };
}

/* ================================================================== */

describe("🔴 ceiling 1 — the document", () => {
  it("headroom is what the invoice charged less what has been credited", () => {
    expect(
      headroomMinor({ invoiceTotalMinor: 118_000n, issuedCreditTotalMinor: 18_000n }),
    ).toBe(100_000n);
  });

  /**
   * A negative headroom would render as "-₹40.00 remaining" and read
   * like a number you could spend. Zero is the honest answer.
   */
  it("floors at zero rather than going negative on odd historic data", () => {
    expect(
      headroomMinor({ invoiceTotalMinor: 100n, issuedCreditTotalMinor: 4_100n }),
    ).toBe(0n);
  });

  it("crediting the invoice EXACTLY is allowed — the trigger uses >, not >=", () => {
    expect(assessCreditHeadroom({ noteTotalMinor: 100n, headroomMinor: 100n })).toEqual({
      ok: true,
      overByMinor: 0n,
    });
  });

  it("one paise over is refused, and says by how much", () => {
    expect(assessCreditHeadroom({ noteTotalMinor: 101n, headroomMinor: 100n })).toEqual({
      ok: false,
      overByMinor: 1n,
    });
  });
});

describe("🔴 ceiling 2 — the line, which the database trigger cannot see", () => {
  it("remaining is invoiced less already credited", () => {
    expect(
      remainingCreditableQtyMinor(line({ quantityCreditedIssued: "4.000" })),
    ).toBe(6_000n);
    expect(remainingCreditableQty(line({ quantityCreditedIssued: "4.500" }))).toBe("5.500");
  });

  /**
   * Over-crediting line 1 must never create room on line 2. They are
   * different goods at different rates, and netting them makes the HSN
   * summary wrong in both directions at once.
   */
  it("floors per line, so an over-credit cannot lend headroom elsewhere", () => {
    expect(
      remainingCreditableQtyMinor(
        line({ quantity: "10.000", quantityCreditedIssued: "14.000" }),
      ),
    ).toBe(0n);
  });

  it("passes a return that fits", () => {
    expect(
      assessCreditLines({
        invoiceLines: [line()],
        proposed: [{ invoiceLineId: "L1", quantity: "10.000" }],
      }),
    ).toEqual([]);
  });

  /**
   * 🔴 THE CASE THE TRIGGER MISSES ENTIRELY. 100 units at ₹0.01 is a
   * small total and an absurd quantity, and the absurd quantity is what
   * reaches the HSN summary of GSTR-1.
   */
  it("refuses more units than were ever invoiced", () => {
    const findings = assessCreditLines({
      invoiceLines: [line()],
      proposed: [{ invoiceLineId: "L1", quantity: "100.000" }],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("10.000");
  });

  /**
   * Two lines of 6 against a 10-unit line are individually fine and
   * together are not. Checking each in isolation is the bug.
   */
  it("accumulates across the proposed lines rather than checking each alone", () => {
    const findings = assessCreditLines({
      invoiceLines: [line()],
      proposed: [
        { invoiceLineId: "L1", quantity: "6.000" },
        { invoiceLineId: "L1", quantity: "6.000" },
      ],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.requested).toBe("12.000");
  });

  it("says so plainly when a line has already been credited in full", () => {
    const findings = assessCreditLines({
      invoiceLines: [line({ quantityCreditedIssued: "10.000" })],
      proposed: [{ invoiceLineId: "L1", quantity: "1.000" }],
    });
    expect(findings[0]?.message).toContain("already been credited in full");
  });

  /**
   * A post-sale discount under Section 15(3)(b) reduces the value of a
   * supply with no goods coming back. It has no quantity to measure, and
   * the document ceiling still binds it.
   */
  it("skips lines that name no invoice line, rather than inventing a limit", () => {
    expect(
      assessCreditLines({
        invoiceLines: [line()],
        proposed: [{ quantity: "999.000" }, { invoiceLineId: null, quantity: "999.000" }],
      }),
    ).toEqual([]);
  });

  /**
   * Silently ignoring an unknown id would let a caller credit against
   * another invoice's line by guessing a uuid, with a plausible total.
   */
  it("treats an unknown invoice line as a finding, never as a skip", () => {
    const findings = assessCreditLines({
      invoiceLines: [line()],
      proposed: [{ invoiceLineId: "not-on-this-invoice", quantity: "1.000" }],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("not on this invoice");
  });
});

describe("🔴 there is ONE tax engine", () => {
  it("the preview equals what buildInvoice produces from the same facts", () => {
    const preview = previewCreditNote({
      lines: [
        {
          description: "Cement OPC 53",
          quantity: "10.000",
          unitPriceMinor: 10_000n,
          taxRateBps: 1800,
          hsnSacCode: "2523",
          uom: "bag",
        },
      ],
      taxKind: "cgst_sgst",
      placeOfSupplyCode: "27",
    });

    const direct = buildInvoice({
      orderLines: [
        {
          id: "cn-0",
          lineNo: 1,
          description: "Cement OPC 53",
          uom: "bag",
          quantity: "10.000",
          qtyInvoiced: "0.000",
          qtyCancelled: "0.000",
          unitPriceMinor: 10_000n,
          discountMinor: 0n,
          taxRateBps: 1800,
          cessRateBps: 0,
          hsnSacCode: "2523",
        },
      ],
      selection: [{ orderLineId: "cn-0" }],
      taxKind: "cgst_sgst",
      placeOfSupplyCode: "27",
    });

    expect(preview.tax.amountPayableMinor).toBe(direct.tax.amountPayableMinor);
    expect(preview.tax.taxableMinor).toBe(100_000n);
    expect(preview.tax.cgstMinor).toBe(9_000n);
    expect(preview.tax.sgstMinor).toBe(9_000n);
    expect(preview.tax.amountPayableMinor).toBe(118_000n);
  });

  it("an inter-state credit note reverses IGST and nothing else", () => {
    const p = previewCreditNote({
      lines: [
        {
          description: "Cement",
          quantity: "10.000",
          unitPriceMinor: 10_000n,
          taxRateBps: 1800,
        },
      ],
      taxKind: "igst",
      placeOfSupplyCode: "29",
    });
    expect(p.tax.igstMinor).toBe(18_000n);
    expect(p.tax.cgstMinor).toBe(0n);
    expect(p.tax.sgstMinor).toBe(0n);
  });

  /** A second tax engine is the one thing that must not come out of a UI batch. */
  it("the module delegates and computes no tax of its own", () => {
    expect(code(MODULE)).toContain("buildInvoice(");
    expect(code(MODULE)).not.toMatch(/taxRateBps\s*[*/]/);
    expect(code(MODULE)).not.toMatch(/\/\s*10000n?\b/);
  });

  it("the form previews through the module, it does not add up lines itself", () => {
    expect(code(FORM)).toContain("previewCreditNote(");
    expect(code(FORM)).not.toMatch(/reduce\(/);
    expect(code(FORM)).not.toMatch(/unitPriceMinor\s*\*/);
  });
});

describe("⭐ the grounds are the closed list Section 34(1) allows", () => {
  it("every reason code the validator accepts has a label and a statute", () => {
    for (const codeName of CREDIT_NOTE_REASONS) {
      const meta = CREDIT_NOTE_REASON_META[codeName];
      expect(meta, codeName).toBeDefined();
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.statute).toMatch(/Section/);
    }
  });

  it("and there is no extra ground in the UI that the validator would reject", () => {
    const known = new Set<string>(CREDIT_NOTE_REASONS);
    for (const k of Object.keys(CREDIT_NOTE_REASON_META)) {
      expect(known.has(k), k).toBe(true);
    }
  });

  it("the form offers them as a fixed set, not a free-text box", () => {
    expect(code(FORM)).toContain("CREDIT_NOTE_REASON_META");
    expect(code(FORM)).not.toMatch(/setReasonCode\(e\.target\.value\)/);
  });
});

describe("🔴 the server checks at issue, not only at raise", () => {
  /**
   * Two drafts can each be raised legitimately against the same ten
   * units. The first issued consumes them; the second must be refused.
   */
  it("assessCreditLines is called in BOTH raiseCreditNote and issueCreditNote", () => {
    const body = code(ACTIONS);
    const raise = body.slice(
      body.indexOf("export async function raiseCreditNote"),
      body.indexOf("export async function issueCreditNote"),
    );
    const issue = body.slice(
      body.indexOf("export async function issueCreditNote"),
      body.indexOf("export async function buildGstr1Return"),
    );
    expect(raise).toContain("assessCreditLines(");
    expect(issue).toContain("assessCreditLines(");
  });

  it("only issued notes consume headroom — drafts are excluded, as in the trigger", () => {
    expect(code(ACTIONS)).toContain(
      'notInArray(salesCreditNotes.status, ["draft", "cancelled"])',
    );
  });

  /**
   * It used to count every row in the year. Five open drafts made the
   * first issued note CN/00006, and Rule 46(b) via Rule 53 requires the
   * series to be consecutive.
   */
  it("the credit-note series counts issued notes only", () => {
    const body = code(ACTIONS);
    const counter = body.slice(
      body.indexOf("const creditNoteNumber = `CN/") - 1400,
      body.indexOf("const creditNoteNumber = `CN/"),
    );
    expect(counter).toContain("notInArray");
  });

  it("discarding a draft marks it cancelled and never deletes the row", () => {
    const body = code(ACTIONS);
    const discard = body.slice(body.indexOf("export async function discardCreditNoteDraft"));
    expect(discard).toContain('status: "cancelled"');
    expect(discard).not.toMatch(/\.delete\(/);
  });

  it("and refuses on anything that is not a draft", () => {
    const body = code(ACTIONS);
    const discard = body.slice(body.indexOf("export async function discardCreditNoteDraft"));
    expect(discard).toContain('note.status !== "draft"');
  });
});

describe("🔴 money never floats on the way to the screen", () => {
  it("no page or component divides by 100", () => {
    for (const src of [FORM, NOTE_ACTIONS, RAISE_PAGE, LIST_PAGE, DETAIL_PAGE]) {
      expect(code(src)).not.toMatch(/Number\([^)]*\)\s*\/\s*100/);
    }
  });

  it("every screen formats from digit strings", () => {
    for (const src of [FORM, RAISE_PAGE, LIST_PAGE, DETAIL_PAGE]) {
      expect(code(src)).toContain("padStart(3");
    }
  });

  it("the register leads with value reversed, not a count", () => {
    const head = LIST_PAGE.slice(0, LIST_PAGE.indexOf("Drafts"));
    expect(head).toContain("Value reversed");
    expect(head).toContain("inr(summary.issuedValueMinor)");
  });

  it("drafts are counted and never added into the value reversed", () => {
    const body = code(ACTIONS);
    const list = body.slice(body.indexOf("export async function listCreditNotes"));
    expect(list).toContain("draftCount");
    expect(list).toMatch(/if \(r\.status === "draft"\)[\s\S]{0,80}continue;/);
  });
});

describe("🔴 tax heads are shown separately, as on the invoice", () => {
  it("the detail page never renders one combined GST figure", () => {
    expect(DETAIL_PAGE).toContain("IGST");
    expect(DETAIL_PAGE).toContain("CGST");
    expect(code(DETAIL_PAGE)).not.toMatch(/BigInt\(note\.cgstMinor\)\s*\+/);
  });
});

describe("the screens are reachable and behave", () => {
  it("a missing credit note is indistinguishable from someone else's", () => {
    expect(code(DETAIL_PAGE)).toContain("notFound()");
    expect(code(RAISE_PAGE)).toContain("notFound()");
  });

  it("is registered in the module registry under money", () => {
    expect(REGISTRY).toContain('"/credit-notes"');
    expect(REGISTRY).toContain('navId: "credit-notes"');
  });

  /**
   * A draft invoice is corrected by editing it. Offering the credit
   * route there teaches the wrong habit on the document where it is
   * cheapest to learn.
   */
  it("the invoice screen offers the credit route only once issued", () => {
    const block = INVOICE_PAGE.slice(INVOICE_PAGE.indexOf("Raise a credit note") - 600);
    expect(block).toContain('invoice.status !== "draft"');
    expect(block).toContain('invoice.status !== "cancelled"');
  });

  /** A free-standing credit note is unreconcilable — GSTR-1 reports it against an invoice. */
  it("there is no way to start a credit note that names no invoice", () => {
    expect(code(LIST_PAGE)).not.toMatch(/href="\/credit-notes\/new"/);
    expect(code(ACTIONS)).not.toMatch(/invoiceId:\s*null/);
  });

  it("the raise form is absent, not disabled, on a draft or cancelled invoice", () => {
    expect(code(RAISE_PAGE)).toContain('invoice.status !== "draft"');
    expect(code(RAISE_PAGE)).toContain("creditable ?");
  });
});
