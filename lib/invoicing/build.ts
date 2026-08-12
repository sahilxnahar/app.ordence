/**
 * Ordence — ⭐ Building a tax invoice from a sales order
 * Version: v0.90.0-alpha
 *
 * Pure. No database, no clock, no `Date.now()`. Money is `bigint` paise
 * and quantity is a decimal STRING — see the note below, it is the whole
 * reason this file exists rather than a few lines inside an action.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THIS FILE COMPUTES NO TAX. IT ASSEMBLES THE INPUT AND DELEGATES.
 * ══════════════════════════════════════════════════════════════════════
 * `computeInvoiceTax()` in `lib/gst/tax.ts` already does the arithmetic,
 * `resolvePlaceOfSupply()` in `lib/gst/place-of-supply.ts` already makes
 * the legal determination, and `checkRule46()` in
 * `lib/gst/invoice-fields.ts` already checks the document. All three are
 * pure, tested, and were proven on the Phase 32 billing invoices.
 *
 * ⭐ A SECOND TAX ENGINE IS THE ONE THING THAT MUST NOT COME OUT OF THIS
 *    BATCH. Two answers to "what is the CGST on this line" is worse than
 *    none: the invoice says one, the return says the other, and the
 *    disagreement is discovered by an officer rather than by us.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 QUANTITY IS A STRING AND IS NEVER A JavaScript NUMBER HERE
 * ══════════════════════════════════════════════════════════════════════
 * `sales_order_lines.quantity` is `numeric(18,3)`. Drizzle hands it over
 * as a string, and it must stay one.
 *
 *     0.1 + 0.2 === 0.30000000000000004
 *
 * A tonnage that fails to add up on a delivery challan is a dispute with
 * a customer, and a part-invoiced order whose remaining quantity drifts
 * by 0.001 can never be closed — the last invoice is always short by an
 * amount too small to see and too real to ignore.
 *
 * So quantities are converted to `bigint` THOUSANDTHS, all arithmetic
 * happens there, and they are formatted back to a 3-decimal string at
 * the edge. Exactly the treatment money already gets, for the same
 * reason.
 */

import { computeInvoiceTax, type TaxLineInput, type TaxComputation } from "@/lib/gst/tax";
import type { GstTaxKind } from "@/lib/gst/place-of-supply";

/* ------------------------------------------------------------------ */
/* QUANTITY — bigint thousandths, never a float                        */
/* ------------------------------------------------------------------ */

/** One unit, in thousandths. `numeric(18,3)` has exactly 3 decimals. */
const QTY_SCALE = 1000n;

/**
 * `"12.500"` → `12500n`.
 *
 * ⚠️ PARSED BY STRING SURGERY, NOT BY `parseFloat`. Routing the value
 * through a float to "convert" it reintroduces the exact imprecision
 * this representation exists to avoid — and it would do so silently, on
 * values that look right in every test with round numbers in it.
 */
export function toQtyMinor(value: string | number | null | undefined): bigint {
  if (value === null || value === undefined) return 0n;
  const raw = typeof value === "number" ? value.toString() : value.trim();
  if (raw === "") return 0n;

  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(raw);
  if (!match) throw new Error(`Malformed quantity "${value}".`);

  const [, sign, whole = "", fraction = ""] = match;
  if (whole === "" && fraction === "") throw new Error(`Malformed quantity "${value}".`);

  /**
   * ⚠️ TRUNCATED, NOT ROUNDED, BEYOND 3 DECIMALS. The column holds 3, so
   * a 4th digit cannot survive a round trip to the database anyway.
   * Rounding here would make this function disagree with what Postgres
   * stores, which is a worse failure than losing a digit that was never
   * going to be kept.
   */
  const milli = (fraction + "000").slice(0, 3);
  const magnitude = BigInt(whole === "" ? "0" : whole) * QTY_SCALE + BigInt(milli);
  return sign === "-" ? -magnitude : magnitude;
}

/** `12500n` → `"12.500"`. The form Postgres accepts for `numeric(18,3)`. */
export function fromQtyMinor(qty: bigint): string {
  const negative = qty < 0n;
  const abs = negative ? -qty : qty;
  const whole = abs / QTY_SCALE;
  const fraction = (abs % QTY_SCALE).toString().padStart(3, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/* ------------------------------------------------------------------ */
/* WHAT IS STILL BILLABLE                                              */
/* ------------------------------------------------------------------ */

/**
 * One order line, as this module needs it. Every quantity is the raw
 * `numeric` string straight off the row.
 */
export type OrderLineFacts = {
  id: string;
  lineNo: number;
  description: string;
  sku?: string | null;
  assetId?: string | null;
  hsnSacCodeId?: string | null;
  hsnSacRateId?: string | null;
  hsnSacCode?: string | null;
  taxRateBps?: number | null;
  cessRateBps?: number | null;
  uom: string;
  quantity: string;
  qtyInvoiced: string;
  qtyCancelled: string;
  unitPriceMinor: bigint;
  /** Order-line discount, for the WHOLE line. Apportioned below. */
  discountMinor: bigint;
};

/**
 * How much of this line may still be put on an invoice.
 *
 * ⚠️ `qtyReturned` IS DELIBERATELY NOT SUBTRACTED. A return happens
 * AFTER the goods were invoiced, and it is reversed by a credit note
 * under Rule 53 — not by making the original line billable again.
 * Subtracting it here would let the same goods be invoiced twice: once
 * before the return and once after.
 */
export function billableQty(line: OrderLineFacts): bigint {
  const remaining =
    toQtyMinor(line.quantity) - toQtyMinor(line.qtyInvoiced) - toQtyMinor(line.qtyCancelled);
  return remaining > 0n ? remaining : 0n;
}

export type InvoiceLineSelection = {
  orderLineId: string;
  /** Omit to bill everything still outstanding on the line. */
  quantity?: string;
};

export type BuiltInvoiceLine = {
  orderLineId: string;
  lineNo: number;
  description: string;
  sku: string | null;
  assetId: string | null;
  hsnSacCodeId: string | null;
  hsnSacRateId: string | null;
  hsnSacCode: string | null;
  taxRateBps: number;
  cessRateBps: number;
  uom: string;
  /** `numeric(18,3)` string, ready for the database. */
  quantity: string;
  unitPriceMinor: bigint;
  discountMinor: bigint;
  grossMinor: bigint;
};

export class InvoiceBuildError extends Error {}

/**
 * Turn a selection of order lines into invoice lines.
 *
 * ⭐ EVERY FIGURE IS COPIED FROM THE ORDER, NOT RECALCULATED. The price,
 * the HSN code and the tax rate were decided at order entry and frozen
 * there. An invoice that re-derives them can disagree with the document
 * the customer already signed — and the customer is holding their copy.
 */
export function buildInvoiceLines(
  orderLines: readonly OrderLineFacts[],
  selection: readonly InvoiceLineSelection[],
): BuiltInvoiceLine[] {
  const byId = new Map(orderLines.map((l) => [l.id, l]));
  const built: BuiltInvoiceLine[] = [];
  const seen = new Set<string>();

  for (const pick of selection) {
    const line = byId.get(pick.orderLineId);
    if (!line) {
      throw new InvoiceBuildError(
        "One of the lines selected is not on this order any more. Reload the order and try again.",
      );
    }

    /**
     * ⚠️ A LINE SELECTED TWICE IS REFUSED, NOT SUMMED. Summing would
     * quietly bill it twice whenever a UI sent a duplicate — and a
     * duplicated row in a form submission is an ordinary bug, not an
     * exotic one.
     */
    if (seen.has(pick.orderLineId)) {
      throw new InvoiceBuildError(
        `Line ${line.lineNo} appears twice in this invoice. Each order line may appear once.`,
      );
    }
    seen.add(pick.orderLineId);

    const outstanding = billableQty(line);
    if (outstanding <= 0n) continue;

    const wanted = pick.quantity === undefined ? outstanding : toQtyMinor(pick.quantity);

    if (wanted <= 0n) {
      throw new InvoiceBuildError(
        `Line ${line.lineNo}: the quantity to invoice must be more than zero.`,
      );
    }

    /**
     * ⚠️ OVER-INVOICING IS REFUSED HERE **AND** BY A CHECK CONSTRAINT
     * (`sales_order_lines_invoiced_within_order`). This is not
     * duplication for its own sake: this refusal is a sentence naming
     * the line and both quantities, and the constraint is the guarantee
     * that holds on every other write path — the public API of Phase 41
     * and any back-fill included.
     */
    if (wanted > outstanding) {
      throw new InvoiceBuildError(
        `Line ${line.lineNo}: only ${fromQtyMinor(outstanding)} ${line.uom} of ${fromQtyMinor(
          toQtyMinor(line.quantity),
        )} remain to be invoiced. You asked for ${fromQtyMinor(wanted)}.`,
      );
    }

    /**
     * ⭐ THE DISCOUNT IS APPORTIONED BY QUANTITY, AND THE LAST INVOICE
     *    TAKES THE REMAINDER.
     *
     * ⚠️ A ₹100 discount on 3 units is 33.33 each, and three invoices of
     * ₹33.33 return ₹99.99 — one paisa of discount the customer was
     * promised and never received. When this invoice clears the line,
     * the whole undischarged remainder goes on it, so the arithmetic
     * closes exactly.
     */
    const fullQty = toQtyMinor(line.quantity);
    const clearsTheLine = wanted === outstanding;
    const alreadyInvoiced = toQtyMinor(line.qtyInvoiced);

    const discountMinor = clearsTheLine
      ? line.discountMinor - (line.discountMinor * alreadyInvoiced) / fullQty
      : (line.discountMinor * wanted) / fullQty;

    /**
     * ⚠️ MULTIPLY BEFORE DIVIDING. `unitPrice * qty / 1000` keeps every
     * paisa; `unitPrice * (qty / 1000)` truncates the quantity to whole
     * units first and silently bills 12 tonnes as 12 when the order said
     * 12.500.
     */
    const grossMinor = (line.unitPriceMinor * wanted) / QTY_SCALE;

    built.push({
      orderLineId: line.id,
      lineNo: line.lineNo,
      description: line.description,
      sku: line.sku ?? null,
      assetId: line.assetId ?? null,
      hsnSacCodeId: line.hsnSacCodeId ?? null,
      hsnSacRateId: line.hsnSacRateId ?? null,
      hsnSacCode: line.hsnSacCode ?? null,
      taxRateBps: line.taxRateBps ?? 0,
      cessRateBps: line.cessRateBps ?? 0,
      uom: line.uom,
      quantity: fromQtyMinor(wanted),
      unitPriceMinor: line.unitPriceMinor,
      discountMinor,
      grossMinor,
    });
  }

  if (built.length === 0) {
    throw new InvoiceBuildError(
      "There is nothing left to invoice on this order. Every line has already been billed or cancelled.",
    );
  }

  return built;
}

/* ------------------------------------------------------------------ */
/* THE WHOLE DOCUMENT                                                  */
/* ------------------------------------------------------------------ */

export type BuiltInvoice = {
  lines: BuiltInvoiceLine[];
  tax: TaxComputation;
};

/**
 * Assemble the lines and hand them to the tax engine.
 *
 * ⚠️ `roundToRupee` DEFAULTS OFF, matching `computeInvoiceTax`. Section
 * 170 rounds the TAX, which is a different operation from rounding the
 * invoice total, and a rounding that appears without being asked for
 * makes the invoice disagree with the payment plan by up to 99 paise per
 * instalment, forever.
 */
export function buildInvoice(args: {
  orderLines: readonly OrderLineFacts[];
  selection: readonly InvoiceLineSelection[];
  taxKind: GstTaxKind;
  placeOfSupplyCode: string;
  /** Section 9(3)/9(4): shown on the document, never collected. */
  reverseCharge?: boolean;
  roundToRupee?: boolean;
}): BuiltInvoice {
  const lines = buildInvoiceLines(args.orderLines, args.selection);

  const taxLines: TaxLineInput[] = lines.map((l) => ({
    key: l.orderLineId,
    description: l.description,
    hsnSacCode: l.hsnSacCode,
    rateId: l.hsnSacRateId,
    grossMinor: l.grossMinor,
    discountMinor: l.discountMinor,
    rateBps: l.taxRateBps,
    cessRateBps: l.cessRateBps,
    reverseCharge: args.reverseCharge ?? false,
  }));

  const tax = computeInvoiceTax({
    lines: taxLines,
    taxKind: args.taxKind,
    placeOfSupplyCode: args.placeOfSupplyCode,
    roundToRupee: args.roundToRupee ?? false,
  });

  return { lines, tax };
}

/* ------------------------------------------------------------------ */
/* NUMBERING                                                           */
/* ------------------------------------------------------------------ */

/**
 * ⭐ Rule 46(b): a consecutive serial number, unique for a financial
 * year, containing only letters, digits, `/` and `-`, up to 16
 * characters.
 *
 * ⚠️ 16 CHARACTERS IS THE LEGAL LIMIT AND IT IS TIGHTER THAN IT LOOKS.
 * `ORD/2026-27/000001` is 18 and already unlawful. The default below is
 * `ORD/2627/00001` — 14 — leaving room for a 4-character prefix.
 *
 * ⚠️ THIS FUNCTION DOES NOT MAKE THE NUMBER UNIQUE. The unique index
 * `sales_invoices_number_tenant_key` does. Two concurrent issues can
 * read the same maximum; only the database can refuse the second.
 */
export function formatInvoiceNumber(args: {
  prefix?: string;
  financialYear: string;
  sequence: number;
}): string {
  const prefix = (args.prefix ?? "ORD").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
  const [start = "", end = ""] = args.financialYear.split("-");
  const shortYear = `${start.slice(-2)}${end.slice(-2)}`;
  const seq = String(args.sequence).padStart(5, "0");

  const number = `${prefix}/${shortYear}/${seq}`;
  if (number.length > 16) {
    throw new InvoiceBuildError(
      `Invoice number "${number}" is ${number.length} characters. Rule 46(b) allows 16. Shorten the prefix.`,
    );
  }
  return number;
}
