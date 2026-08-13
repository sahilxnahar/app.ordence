/**
 * Ordence — ⭐ Credit notes: what may still be credited, and how much
 * Version: v0.96.0-alpha
 *
 * Pure. No database, no clock. Imported by BOTH the server action and
 * the `"use client"` form, deliberately — the preview a person sees
 * before they press the button and the figure the server writes come
 * out of the same function, so they cannot disagree.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THERE ARE TWO CEILINGS ON A CREDIT NOTE, AND THEY ARE DIFFERENT
 * ══════════════════════════════════════════════════════════════════════
 *
 *   1. THE DOCUMENT CEILING — the sum of issued credit notes against an
 *      invoice may not exceed what that invoice charged. This is
 *      enforced by `sales_credit_note_within_invoice()` in `0050`, a
 *      database trigger, because credit notes are raised months apart by
 *      different people and by the public API. `headroomMinor()` below
 *      only PREDICTS it so a person is told before they type, never
 *      after.
 *
 *   2. 🔴 THE LINE CEILING — you cannot return 20 units of a line that
 *      only ever had 10 on it. **The trigger does not catch this.** It
 *      compares document totals, so crediting 100 units at ₹0.01 passes
 *      a check meant to stop crediting 10 units at ₹100. That is a real
 *      hole and `assessCreditLines()` is what closes it.
 *
 * ⚠️ THE LINE CEILING APPLIES ONLY TO LINES THAT NAME AN INVOICE LINE.
 * A post-sale discount under Section 15(3)(b) reduces the value of a
 * supply without any goods coming back — it legitimately has no
 * quantity to check against. Those lines are governed by the document
 * ceiling alone, which is the correct answer rather than a loophole:
 * they still cannot exceed what was billed.
 *
 * ⚠️ AND ONLY ISSUED NOTES CONSUME EITHER CEILING. A draft is a working
 * paper. If a draft consumed headroom, one colleague's abandoned draft
 * would silently block another's legitimate credit note, and nothing on
 * either screen would say why. Same rule as the trigger, stated in the
 * same words, on purpose.
 */

import { buildInvoice, toQtyMinor, fromQtyMinor } from "@/lib/invoicing/build";
import type { GstTaxKind } from "@/lib/gst/place-of-supply";

/* ------------------------------------------------------------------ */
/* THE GROUNDS — Section 34(1)                                         */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ THE LABELS ARE NOT DECORATION. `CREDIT_NOTE_REASONS` in the
 * validators is the closed list the law allows; this is how each ground
 * is explained to the person choosing one. A picker of five bare
 * snake_case codes gets "other" selected every time, and "other" is the
 * credit note an officer asks about.
 *
 * ⚠️ THE STATUTE IS SHOWN, NOT HIDDEN. Somebody eventually has to defend
 * this document. "Section 34(1) — goods returned" can be looked up.
 * "Sales return" cannot.
 */
export const CREDIT_NOTE_REASON_META = {
  sales_return: {
    label: "Goods returned",
    statute: "Section 34(1)",
    help: "The customer sent the goods back. Credit the quantity that came back, not the whole line.",
  },
  rate_revision: {
    label: "Price or rate was too high",
    statute: "Section 34(1)",
    help: "The taxable value or the tax charged on the invoice exceeded what was actually payable.",
  },
  deficiency: {
    label: "Supply was deficient",
    statute: "Section 34(1)",
    help: "The goods or services were found deficient. Say what was wrong — this is read back at an audit.",
  },
  post_sale_discount: {
    label: "Post-sale discount",
    statute: "Section 15(3)(b)",
    help: "Agreed before or at the time of supply and linked to this invoice. A discount agreed afterwards does not reduce the taxable value.",
  },
  other: {
    label: "Something else",
    statute: "Section 34(1)",
    help: "Only if none of the above fits. Expect to be asked about it — write the reason as if to a stranger.",
  },
} as const satisfies Record<string, { label: string; statute: string; help: string }>;

export type CreditNoteReasonCode = keyof typeof CREDIT_NOTE_REASON_META;

/* ------------------------------------------------------------------ */
/* CEILING 1 — THE DOCUMENT                                            */
/* ------------------------------------------------------------------ */

/**
 * How much of an invoice has not yet been credited.
 *
 * ⚠️ FLOORED AT ZERO, NEVER NEGATIVE. If historic data somehow exceeds
 * the invoice, a negative headroom would render as "-₹4,000 remaining"
 * and read like a number you could spend. Zero is the honest answer:
 * nothing remains.
 */
export function headroomMinor(args: {
  invoiceTotalMinor: bigint;
  issuedCreditTotalMinor: bigint;
}): bigint {
  const remaining = args.invoiceTotalMinor - args.issuedCreditTotalMinor;
  return remaining > 0n ? remaining : 0n;
}

export type CreditHeadroomVerdict = {
  ok: boolean;
  /** Zero when `ok`. Never negative. */
  overByMinor: bigint;
};

/**
 * Would issuing a note of this size breach the document ceiling?
 *
 * ⚠️ THIS IS A PREDICTION, NOT THE ENFORCEMENT. The trigger decides. If
 * this ever disagrees with the trigger, the trigger is right and this is
 * a bug — which is why it is written to the same comparison the trigger
 * uses (`credited + total > invoice_total`) rather than a rearrangement
 * of it that is "equivalent" until one of them is edited.
 */
export function assessCreditHeadroom(args: {
  noteTotalMinor: bigint;
  headroomMinor: bigint;
}): CreditHeadroomVerdict {
  if (args.noteTotalMinor <= args.headroomMinor) {
    return { ok: true, overByMinor: 0n };
  }
  return { ok: false, overByMinor: args.noteTotalMinor - args.headroomMinor };
}

/* ------------------------------------------------------------------ */
/* CEILING 2 — THE LINE                                                */
/* ------------------------------------------------------------------ */

/** One invoice line, as far as crediting is concerned. */
export type CreditableInvoiceLine = {
  id: string;
  lineNo: number;
  description: string;
  hsnSacCode: string | null;
  uom: string;
  taxRateBps: number | null;
  unitPriceMinor: bigint;
  /** `numeric(18,3)` string, straight off the row. */
  quantity: string;
  /** Sum of ISSUED credit-note quantities already against this line. */
  quantityCreditedIssued: string;
};

/**
 * What may still be credited on one line, in quantity thousandths.
 *
 * ⚠️ FLOORED AT ZERO PER LINE, NOT ACROSS THE DOCUMENT. Over-crediting
 * line 1 must never silently create room on line 2 — the two are
 * different goods at different tax rates, and netting them produces a
 * document whose HSN summary is wrong in both directions at once.
 */
export function remainingCreditableQtyMinor(line: CreditableInvoiceLine): bigint {
  const remaining = toQtyMinor(line.quantity) - toQtyMinor(line.quantityCreditedIssued);
  return remaining > 0n ? remaining : 0n;
}

/** Same figure, as the decimal string a screen shows. */
export function remainingCreditableQty(line: CreditableInvoiceLine): string {
  return fromQtyMinor(remainingCreditableQtyMinor(line));
}

export type CreditLineFinding = {
  invoiceLineId: string;
  lineNo: number;
  description: string;
  requested: string;
  remaining: string;
  message: string;
};

/**
 * ⭐ THE CHECK THE DATABASE TRIGGER CANNOT DO.
 *
 * Every proposed line that names an invoice line is measured against
 * what is left on that line. Lines naming nothing are skipped — see the
 * header: a post-sale discount has no quantity to measure.
 *
 * ⚠️ RETURNS FINDINGS; IT DOES NOT THROW. The caller decides whether
 * this is a warning on a form or a refusal in an action, and the same
 * function has to serve both without one of them having to catch.
 *
 * ⚠️ A LINE NAMING AN INVOICE LINE THAT IS NOT ON THIS INVOICE IS A
 * FINDING, NOT A SKIP. Silently ignoring an unknown id would let a
 * caller credit against another customer's invoice line by guessing a
 * uuid, and the total would still look plausible.
 */
export function assessCreditLines(args: {
  invoiceLines: readonly CreditableInvoiceLine[];
  proposed: readonly { invoiceLineId?: string | null; quantity: string }[];
}): CreditLineFinding[] {
  const byId = new Map(args.invoiceLines.map((l) => [l.id, l]));
  const findings: CreditLineFinding[] = [];

  /**
   * ⚠️ ACCUMULATED ACROSS THE PROPOSED LINES, NOT CHECKED ONE BY ONE.
   * Two lines each crediting 6 of a 10-unit line are individually fine
   * and together are not. Checking each in isolation is the bug this
   * map exists to prevent.
   */
  const requestedByLine = new Map<string, bigint>();

  for (const p of args.proposed) {
    const id = p.invoiceLineId;
    if (id === null || id === undefined || id === "") continue;

    const line = byId.get(id);
    if (!line) {
      findings.push({
        invoiceLineId: id,
        lineNo: 0,
        description: "Unknown line",
        requested: p.quantity,
        remaining: "0.000",
        message: "That line is not on this invoice.",
      });
      continue;
    }

    const running = (requestedByLine.get(id) ?? 0n) + toQtyMinor(p.quantity);
    requestedByLine.set(id, running);

    const remaining = remainingCreditableQtyMinor(line);
    if (running > remaining) {
      findings.push({
        invoiceLineId: id,
        lineNo: line.lineNo,
        description: line.description,
        requested: fromQtyMinor(running),
        remaining: fromQtyMinor(remaining),
        message:
          remaining === 0n
            ? `Line ${line.lineNo} has already been credited in full. There is nothing left on it to reverse.`
            : `Line ${line.lineNo} was invoiced for ${line.quantity} ${line.uom} and ${fromQtyMinor(remaining)} remain uncredited. ${fromQtyMinor(running)} cannot be returned.`,
      });
    }
  }

  return findings;
}

/* ------------------------------------------------------------------ */
/* THE PREVIEW                                                         */
/* ------------------------------------------------------------------ */

export type ProposedCreditLine = {
  invoiceLineId?: string | null;
  description: string;
  quantity: string;
  unitPriceMinor: bigint;
  taxRateBps: number;
  hsnSacCode?: string | null;
  uom?: string;
};

/**
 * What this credit note will come to, computed by the invoice engine.
 *
 * 🔴 THE SAME `buildInvoice()` THE ACTION USES, NOT A COPY OF ITS
 *    ARITHMETIC. A second tax engine is the one thing that must not come
 *    out of a UI batch: the form would say ₹11,800, the document would
 *    say ₹11,799, and the disagreement gets found by an officer rather
 *    than by us. If this preview is ever wrong, it is wrong in exactly
 *    the same way the saved document is — which is a bug you can find.
 *
 * ⚠️ `discountMinor` IS ZERO ON EVERY LINE, MATCHING `raiseCreditNote`.
 * The credit note reverses a value that was already computed net of the
 * invoice's discount; applying a discount again would credit less than
 * was charged and leave a residue nobody can explain.
 */
export function previewCreditNote(args: {
  lines: readonly ProposedCreditLine[];
  taxKind: GstTaxKind;
  placeOfSupplyCode: string;
}) {
  return buildInvoice({
    orderLines: args.lines.map((l, i) => ({
      id: `cn-${i}`,
      lineNo: i + 1,
      description: l.description,
      uom: l.uom ?? "nos",
      quantity: l.quantity,
      qtyInvoiced: "0.000",
      qtyCancelled: "0.000",
      unitPriceMinor: l.unitPriceMinor,
      discountMinor: 0n,
      taxRateBps: l.taxRateBps,
      cessRateBps: 0,
      hsnSacCode: l.hsnSacCode ?? null,
    })),
    selection: args.lines.map((_, i) => ({ orderLineId: `cn-${i}` })),
    taxKind: args.taxKind,
    placeOfSupplyCode: args.placeOfSupplyCode,
  });
}
