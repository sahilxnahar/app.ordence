/**
 * The invoice action flow.
 *
 * ⚠️ THESE READ SOURCE because the invariants are about what the UI
 * OFFERS, and offering the wrong button is not a type error.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const ACTIONS_UI = read("components/invoices/invoice-actions.tsx");
const SETTLE = read("components/invoices/settle-invoice.tsx");
const RAISE = read("components/invoices/raise-invoice.tsx");
const DETAIL = read("app/(crm)/invoices/[id]/page.tsx");
const SERVER = read("server/actions/sales-invoices.ts");

describe("🔴 client components never import a server-only module", () => {
  for (const [name, src] of [
    ["invoice-actions", ACTIONS_UI],
    ["settle-invoice", SETTLE],
    ["raise-invoice", RAISE],
  ] as const) {
    it(`${name} imports from server/actions, not server/invoicing`, () => {
      expect(src.startsWith('"use client";')).toBe(true);
      expect(src).toContain('from "@/server/actions/sales-invoices"');
      expect(src).not.toContain('from "@/server/invoicing/');
      expect(src).not.toContain('from "@/server/credit/');
    });
  }
});

describe("🔴 issuing is irreversible, and the UI says what becomes true", () => {
  it("asks for confirmation before issuing", () => {
    expect(code(ACTIONS_UI)).toContain("setConfirming(true)");
  });

  /**
   * A dialog that asks "are you sure" is answered yes without being read.
   *
   * ⚠️ ASSERTED AGAINST STRIPPED SOURCE. The header comment in the
   * component quotes that phrase to explain WHY it is avoided, and a test
   * that greps raw source cannot tell the explanation from a relapse. The
   * only way to make such a test pass would be to delete the reason the
   * rule exists — which is a bad trade, and the same trap rule 4's test
   * fell into.
   */
  it("states the consequence rather than asking 'are you sure'", () => {
    const rendered = code(ACTIONS_UI);
    expect(rendered).toMatch(/cannot be edited/i);
    expect(rendered).toMatch(/credit note/i);
    expect(rendered).not.toMatch(/are you sure/i);
  });

  /**
   * The server decides what is lawful. Disabling on a client check would
   * put a rule in the one place a caller can skip.
   */
  it("warns about blocking Rule 46 findings without disabling the button", () => {
    const block = ACTIONS_UI.slice(ACTIONS_UI.indexOf("hasBlockingFindings &&"));
    expect(block).toMatch(/Rule 46/);
    expect(block).not.toMatch(/disabled=\{hasBlockingFindings/);
  });

  it("requires a reason before cancelling", () => {
    expect(code(ACTIONS_UI)).toContain("reason.trim().length < 4");
  });

  it("does not offer cancel once money has been received", () => {
    expect(code(ACTIONS_UI)).toContain("const settled = receivedMinor !== \"0\"");
    expect(code(ACTIONS_UI)).toContain("{!settled && !cancelling");
  });
});

describe("🔴 rupees become paise by string surgery", () => {
  it("never multiplies by 100", () => {
    expect(code(SETTLE)).not.toMatch(/\*\s*100/);
    expect(code(SETTLE)).not.toMatch(/Math\.round\(/);
  });

  it("pads the fraction to two digits", () => {
    expect(code(SETTLE)).toContain('(fraction + "00").slice(0, 2)');
  });
});

describe("⭐ TDS settles the invoice too", () => {
  it("the form collects it", () => {
    expect(SETTLE).toContain("TDS withheld");
  });

  /**
   * A customer who paid ₹90,000 and withheld ₹10,000 settled ₹1,00,000.
   * Allocating only the cash leaves ₹10,000 overdue forever.
   */
  it("settleInvoice allocates cash PLUS withheld tax", () => {
    const body = code(SERVER).slice(code(SERVER).indexOf("export async function settleInvoice"));
    expect(body).toContain('BigInt(input.amountMinor) + BigInt(input.tdsCreditMinor ?? "0")');
  });

  it("settleInvoice delegates rather than duplicating the guarantees", () => {
    const body = code(SERVER).slice(code(SERVER).indexOf("export async function settleInvoice"));
    expect(body).toContain("recordCustomerReceipt(");
    expect(body).toContain("allocateReceipt(");
    expect(body).not.toContain("insert(customerReceipts)");
  });
});

describe("🔴 raising creates a DRAFT, never an issued document", () => {
  it("the form says so", () => {
    expect(RAISE).toMatch(/draft/i);
    expect(code(RAISE)).toContain("raiseInvoiceFromOrder(");
    expect(code(RAISE)).not.toContain("issueInvoice(");
  });

  it("quantities are never parsed to numbers", () => {
    expect(code(RAISE)).not.toContain("parseFloat");
    expect(code(RAISE)).not.toMatch(/Number\(l\.billableQty\)/);
  });

  /** "No orders available" sends somebody hunting for a bug. */
  it("the empty state names the cause, not the symptom", () => {
    expect(RAISE).toMatch(/confirmed/);
    expect(RAISE).toMatch(/already fully invoiced/);
  });

  it("only offers orders that still have something billable", () => {
    const body = code(SERVER).slice(
      code(SERVER).indexOf("export async function listInvoiceableOrders"),
    );
    expect(body).toContain("if (lines.length === 0) continue;");
  });
});

describe("🔴 the detail page offers the right actions for the state", () => {
  it("puts actions above the lines", () => {
    expect(DETAIL.indexOf("Actions")).toBeLessThan(DETAIL.indexOf(">Lines<"));
  });

  /** Money against a document the customer never saw is a data error. */
  it("hides the payment form on a draft entirely, not disabled", () => {
    expect(code(DETAIL)).toContain('invoice.status !== "draft" && invoice.status !== "cancelled"');
  });
});
