import "server-only";

/**
 * Ordence — ⭐⭐ ONE COMPUTATION, IN THE SHAPE THE DATABASE ACCEPTS
 * Wave 15 / Track E — GST, TDS and statutory correctness
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THIS FILE IS NOT A TAX ENGINE AND MUST NEVER BECOME ONE
 * ══════════════════════════════════════════════════════════════════════
 * Every rule — place of supply, rate resolution by date, the arithmetic,
 * the CGST/SGST split, reverse charge — lives in `lib/gst/`, has no
 * database import, and is tested without one. `server/gst/engine.ts`
 * already composes those three decisions into `quoteTax()`.
 *
 * What was missing is the last inch: `quoteTax()` returns a
 * `TaxComputation` shaped for a SCREEN — gross, discount, `tds`,
 * `amountPayableMinor` — and every caller that wants to WRITE a document
 * has to translate that into the columns `sales_invoices` and
 * `sales_invoice_lines` actually have. Four call sites do that translation
 * today, by hand, slightly differently:
 *
 *   · `server/actions/sales-invoices.ts` (create-from-order, ~L240)
 *   · `server/actions/sales-invoices.ts` (credit note)
 *   · `server/actions/orders.ts` (`lineValuesFor`, ~L166)
 *   · `server/actions/invoicing.ts` (platform's own billing)
 *
 * ⭐ A TRANSLATION WRITTEN FOUR TIMES IS A RULE ENFORCED ZERO TIMES. This
 * module is the fifth and last one, written once so the other four can
 * become calls to it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE ONE THING THIS FILE EXISTS FOR: `hsnSacRateId`
 * ══════════════════════════════════════════════════════════════════════
 * `server/actions/orders.ts:174` currently reads, in full:
 *
 *     hsnSacRateId: line.hsnSacRateId ?? null,
 *
 * ⚠️ THAT VALUE CAME FROM THE CLIENT. It is whatever the form posted,
 * validated as a uuid and written onto the line as the PROOF of which
 * notification the figure was charged under. Nothing checks that it is
 * the rate the engine actually resolved for that HSN on that date.
 *
 * What that buys, concretely: a line charged at 18% can be pinned to the
 * 5% period, or to a period that closed in 2019, or to another workspace's
 * row. SQL 0146 closed the cross-tenant half (the pin is a composite key
 * onto `(id, tenant_id)`) and SQL 0147 closed the "pin disagrees with the
 * figure" half at COMMIT — which means the failure mode today is a
 * database exception in front of a user, raised about a field they never
 * saw, on a form they filled in correctly.
 *
 * ⭐ SO THE PIN IS TAKEN FROM `quoteTax()`'s `rateByLine`, WHICH IS THE
 * REGISTRY ROW THE ENGINE RESOLVED, AND CALLER INPUT IS NOT CONSULTED AT
 * ALL. There is deliberately no `hsnSacRateId` field on this module's
 * input type: a value that must not be supplied is best made
 * unsupplyable.
 *
 * ⚠️ NOT `"use server"`. It exports types and a non-async constant
 * alongside an async function, and every export of a `"use server"` file
 * is published as a callable HTTP endpoint. It also takes `tenantId` as a
 * parameter, which is correct for a `server-only` module and is the v005
 * bug in an action file.
 */

import { quoteTax, type QuotedTax } from "@/server/gst/engine";
import type { ComputeTaxInput } from "@/lib/validators/gst";
import type { GstTaxKind, PlaceOfSupplyBasis } from "@/lib/gst/place-of-supply";

/* ------------------------------------------------------------------ */
/* VERSION                                                             */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE STRING THAT GOES IN `tax_decisions.engine_version`, WHICH IS
 * `NOT NULL` AND UNDEFAULTED ON PURPOSE (SQL 0150 §1).
 *
 * "Which version of the engine produced this?" is the question asked the
 * day a rounding defect is found, and it is unanswerable across a corpus
 * if the column was ever allowed to be blank.
 *
 * ⚠️ IT IS NOT `APP_VERSION`. The application version moves on every
 * release; this one moves when the TAX ARITHMETIC moves. Tying the two
 * together would mean a corpus in which every invoice claims a different
 * engine, and "show me everything computed by the version with the bug"
 * returns everything.
 *
 * ⚠️ varchar(20). Longer is silently truncated by nobody — it is
 * refused — so keep it short.
 */
export const TAX_ENGINE_VERSION = "gst-engine-1.0.0";

/* ------------------------------------------------------------------ */
/* THE PERSISTENCE SHAPE                                               */
/* ------------------------------------------------------------------ */

export type PersistableTaxLine = {
  /** The caller's own line key, echoed back so rows can be matched up. */
  key: string;
  /** Rule 46(g) prints the CODE, so it is held as text as well as by id. */
  hsnSacCode: string | null;
  /**
   * ⭐ THE `hsn_sac_codes` ROW THE ENGINE RESOLVED THE CLASSIFICATION TO.
   * Same argument as `hsnSacRateId` below: it comes from the registry
   * lookup `quoteTax()` already performs, never from caller input.
   */
  hsnSacCodeId: string | null;
  /**
   * ⭐⭐ THE RATE PERIOD THIS LINE WAS PRICED FROM, RESOLVED BY THE
   * REGISTRY AGAINST THE DOCUMENT'S OWN DATE. Never the caller's value.
   * See the header.
   */
  hsnSacRateId: string | null;
  taxRateBps: number;
  cessRateBps: number;
  /** quantity × unit price, before discount. `sales_invoice_lines` has no
   *  column for it, but `taxableValueMinor` is meaningless without it and
   *  the caller needs it to check its own arithmetic. */
  grossMinor: bigint;
  /** ⚠️ NON-NEGATIVE AND SUBTRACTED. A negative discount silently raises
   *  the taxable value; `computeInvoiceTax` refuses one outright. */
  discountMinor: bigint;
  taxableValueMinor: bigint;
  cgstMinor: bigint;
  /** ⚠️ Carries UTGST when the header's `taxKind` is `cgst_utgst`. */
  sgstMinor: bigint;
  igstMinor: bigint;
  cessMinor: bigint;
  /**
   * taxable + tax, or JUST taxable when the line is on reverse charge.
   * ⚠️ Not `taxable + cgst + sgst + igst + cess` at the call site — that
   * expression is right for four lines in five and adds tax the customer
   * does not owe on the fifth.
   */
  lineTotalMinor: bigint;
  isReverseCharge: boolean;
};

export type PersistableTaxHeader = {
  placeOfSupplyCode: string;
  placeOfSupplyBasis: PlaceOfSupplyBasis;
  /** e.g. "Section 12(3)(a), IGST Act". The citation, not the label. */
  statutoryRef: string;
  /** One sentence a human can check. Goes in the working papers. */
  placeOfSupplyExplanation: string;
  isInterState: boolean;
  /** ⚠️ True only when intra-state AND the state is a UT without a legislature. */
  isUnionTerritory: boolean;
  taxKind: GstTaxKind;

  supplierGstin: string;
  supplierStateCode: string;
  supplierRegistrationId: string;

  /** ⭐ The date the rates were resolved on. `YYYY-MM-DD`. Never "today". */
  taxPointDate: string;

  subtotalMinor: bigint;
  discountMinor: bigint;
  taxableValueMinor: bigint;
  cgstMinor: bigint;
  sgstMinor: bigint;
  igstMinor: bigint;
  cessMinor: bigint;
  /**
   * ⚠️ SHOWN, NEVER ADDED. Under s.9(3)/9(4) the RECIPIENT pays this to
   * the Government. Rule 46(p) requires the document to say so, and
   * adding it to the total is a double payment the customer only notices
   * when they refuse to pay the tax line.
   */
  reverseChargeTaxMinor: bigint;
  roundOffMinor: bigint;
  /** ⭐ The amount payable: taxable + collected tax + round-off. */
  totalMinor: bigint;
};

export type PersistableTax = {
  header: PersistableTaxHeader;
  lines: PersistableTaxLine[];
  /**
   * ⭐ A BRAND, NOT A FLAG. `gstComputed: true` is a literal type, so a
   * hand-built object cannot be passed where a `PersistableTax` is
   * expected without deliberately writing the field — which is a moment
   * the author has to think about, and is the whole reason the seam in
   * `server/tax/apply.ts` takes this type rather than a bag of numbers.
   */
  gstComputed: true;
};

export type PersistableTaxResult =
  | { ok: true; tax: PersistableTax; quote: QuotedTax }
  | { ok: false; error: string };

/* ------------------------------------------------------------------ */
/* THE ONE COMPUTATION                                                 */
/* ------------------------------------------------------------------ */

/**
 * Price a document and hand back exactly what has to be written.
 *
 * ⚠️ REFUSES RATHER THAN GUESSES, because `quoteTax()` does. A line with
 * no HSN, an HSN not in the master, an HSN with no rate covering the
 * document's date, a supply relating to immovable property with no
 * property state — each comes back as `{ ok: false, error }` with a
 * sentence written for a person. Coercing any of them to a zero rate
 * would raise a zero-tax invoice that looks deliberate.
 *
 * The raw `quote` is returned alongside so the caller can record the
 * decision trail (`server/tax/audit.ts`) without pricing twice. Pricing
 * twice is not merely wasteful: the second call re-reads the rate master,
 * and if a rate period were closed between the two the document and its
 * audit trail would disagree about what was in force.
 */
export async function computePersistableTax(
  tenantId: string,
  input: ComputeTaxInput,
): Promise<PersistableTaxResult> {
  const quoted = await quoteTax(tenantId, input);
  if (!quoted.ok) return { ok: false, error: quoted.error };

  return { ok: true, tax: toPersistable(quoted.quote), quote: quoted.quote };
}

/**
 * The translation itself, exported separately so a caller that already
 * holds a `QuotedTax` — because it quoted for the screen and is now
 * saving what the user saw — does not have to re-quote to persist it.
 *
 * ⚠️ SYNCHRONOUS AND PURE. It touches no database and makes no decision;
 * every figure below is copied out of the computation the engine already
 * produced. If an arithmetic expression ever appears in this function
 * other than the header sums that `computeInvoiceTax` does not itself
 * report, the rule it encodes has been written twice.
 */
export function toPersistable(quote: QuotedTax): PersistableTax {
  const { computation, placeOfSupply, registration } = quote;

  const lines: PersistableTaxLine[] = computation.lines.map((line) => {
    /**
     * ⭐⭐ HERE. The pin comes from `rateByLine[key]` — the
     * `hsn_sac_rates` row `server/gst/registry.ts` loaded and
     * `resolveRateOn()` picked for THIS document's date — and from
     * nowhere else.
     *
     * ⚠️ `computation.lines[].rateId` carries the same value today,
     * because `quoteTax()` sets it from the same object. It is read from
     * `rateByLine` anyway: `TaxLineInput.rateId` is an OPTIONAL field on
     * a pure type that anybody may construct, so `computation` is a
     * source that CAN carry a caller's value, and `rateByLine` is a
     * source that cannot. When the two are equivalent, prefer the one
     * that stays correct if somebody hands `computeInvoiceTax` a
     * hand-built line array.
     */
    const resolved = quote.rateByLine[line.key];
    const classification = quote.codeByLine[line.key];

    return {
      key: line.key,
      hsnSacCode: line.hsnSacCode,
      hsnSacCodeId: classification?.id ?? null,
      hsnSacRateId: resolved?.id ?? null,
      taxRateBps: line.rateBps,
      cessRateBps: line.cessRateBps,
      grossMinor: line.grossMinor,
      discountMinor: line.discountMinor,
      taxableValueMinor: line.taxableMinor,
      cgstMinor: line.cgstMinor,
      sgstMinor: line.sgstMinor,
      igstMinor: line.igstMinor,
      cessMinor: line.cessMinor,
      lineTotalMinor: line.lineTotalMinor,
      isReverseCharge: line.isReverseCharge,
    };
  });

  return {
    header: {
      placeOfSupplyCode: placeOfSupply.placeOfSupplyCode,
      placeOfSupplyBasis: placeOfSupply.basis,
      statutoryRef: placeOfSupply.statutoryRef,
      placeOfSupplyExplanation: placeOfSupply.explanation,
      isInterState: placeOfSupply.isInterState,
      isUnionTerritory: placeOfSupply.isUnionTerritory,
      taxKind: placeOfSupply.taxKind,

      supplierGstin: registration.gstin,
      supplierStateCode: registration.stateCode,
      supplierRegistrationId: registration.id,

      taxPointDate: quote.taxPointDate,

      subtotalMinor: computation.grossMinor,
      discountMinor: computation.discountMinor,
      taxableValueMinor: computation.taxableMinor,
      cgstMinor: computation.cgstMinor,
      sgstMinor: computation.sgstMinor,
      igstMinor: computation.igstMinor,
      cessMinor: computation.cessMinor,
      reverseChargeTaxMinor: computation.reverseChargeTaxMinor,
      roundOffMinor: computation.roundOffMinor,
      /**
       * ⭐ `amountPayableMinor`, NOT `invoiceTotalMinor`. The former
       * includes the round-off adjustment; the latter is the figure
       * BEFORE it. `sales_invoices.total_minor` is what the customer
       * owes, and `sales_invoices_received_within_total` compares
       * receipts against it — so writing the pre-rounding figure makes a
       * fully-paid invoice look overpaid by up to 99 paise.
       */
      totalMinor: computation.amountPayableMinor,
    },
    lines,
    gstComputed: true,
  };
}

/* ------------------------------------------------------------------ */
/* READING IT BACK                                                     */
/* ------------------------------------------------------------------ */

/**
 * Does a set of persistable lines add up to its header?
 *
 * ⚠️ NOT A DUPLICATE OF `reconcileInvoice` IN `lib/gst/tax.ts`, AND NOT A
 * DUPLICATE OF THE DEFERRED CONSTRAINT TRIGGER EITHER. The trigger is the
 * guarantee — it holds for a psql session and an import script as well as
 * for this code path. `reconcileInvoice` compares STORED rows. This
 * compares a `PersistableTax` BEFORE it is written, so a caller
 * assembling one from parts (a partial invoice, a selected subset of
 * order lines) finds out in its own stack frame rather than from a
 * constraint name.
 *
 * Returns an empty array when the document adds up.
 */
export function reconcilePersistable(tax: PersistableTax): string[] {
  const problems: string[] = [];

  let taxable = 0n;
  let cgst = 0n;
  let sgst = 0n;
  let igst = 0n;
  let cess = 0n;

  for (const line of tax.lines) {
    taxable += line.taxableValueMinor;
    // ⚠️ A reverse-charge line contributes its VALUE and none of its TAX.
    if (line.isReverseCharge) continue;
    cgst += line.cgstMinor;
    sgst += line.sgstMinor;
    igst += line.igstMinor;
    cess += line.cessMinor;
  }

  const checks: readonly (readonly [string, bigint, bigint])[] = [
    ["taxable value", taxable, tax.header.taxableValueMinor],
    ["CGST", cgst, tax.header.cgstMinor],
    ["SGST/UTGST", sgst, tax.header.sgstMinor],
    ["IGST", igst, tax.header.igstMinor],
    ["cess", cess, tax.header.cessMinor],
  ];

  for (const [field, expected, actual] of checks) {
    if (expected !== actual) {
      problems.push(
        `The ${field} on the header is ${actual} paise but the lines add to ` +
          `${expected} paise. The document does not add up; it must not be issued.`,
      );
    }
  }

  /**
   * ⚠️ IGST AND CGST/SGST ARE MUTUALLY EXCLUSIVE, and a document carrying
   * both is a place-of-supply defect rather than a rounding one. Both
   * `sales_invoices` and `sales_invoice_lines` carry a CHECK saying so;
   * this says it in a sentence first.
   */
  if (igst !== 0n && (cgst !== 0n || sgst !== 0n)) {
    problems.push(
      "This document charges IGST and CGST/SGST at the same time. One supply " +
        "has one place of supply, so it is inter-state or it is intra-state — " +
        "never both. This reaches GSTR-1 as a mismatch the officer sees first.",
    );
  }

  return problems;
}
