import "server-only";

/**
 * Ordence — Purchase Engine (composition layer)
 * Version: v0.33.0-alpha
 *
 * The only place that puts the pure decisions together with the database:
 *
 *   1. WHERE is the supply?        → `lib/gst/place-of-supply.ts` (Phase 32)
 *   2. WHAT rate applied THAT DAY? → `lib/gst/rates.ts` over rows loaded
 *      by `server/gst/registry.ts` (Phase 32)
 *   3. ⭐ MAY WE CLAIM THE CREDIT? → `lib/purchases/itc.ts`
 *
 * ⚠️ IT DECIDES NOTHING ITSELF. Every rule lives in `lib/`. This file
 * loads rows, calls the engines, and turns a refusal into a sentence. If
 * a tax rule ever appears in this file, it has been written twice.
 *
 * ⚠️ NOT `"use server"`. It exports types alongside async functions.
 */

import { parseMoney } from "@/lib/billing/money";
import { determinePlaceOfSupply } from "@/lib/gst/place-of-supply";
import { resolveRateOn } from "@/lib/gst/rates";
import { findHsnSacByCode, loadRateHistory, resolveIssuingRegistration } from "@/server/gst/registry";
import {
  determineItcEligibility,
  splitItcByVerdict,
  sumHeads,
  type ItcDetermination,
  type TaxHeads,
} from "@/lib/purchases/itc";
import { taxPeriodOf } from "@/lib/purchases/register";
import { findVendor } from "./registry";
import type { RecordPurchaseInvoiceInput } from "@/lib/validators/purchases";
import type { GstRegistration } from "@/db/schema/gst";

/* ------------------------------------------------------------------ */
/* TYPES                                                               */
/* ------------------------------------------------------------------ */

export type PricedPurchaseLine = {
  lineNumber: number;
  description: string;
  hsnSacId: string | null;
  hsnSacCode: string | null;
  /** ⭐ The dated rate period the supplier's charge was CHECKED against. */
  gstRateId: string | null;

  amountMinor: bigint;
  discountMinor: bigint;
  taxableValueMinor: bigint;
  rateBps: number;
  cessRateBps: number;
  heads: TaxHeads;
  isReverseCharge: boolean;

  determination: ItcDetermination;
  itcEligibleTaxMinor: bigint;
  itcBlockedTaxMinor: bigint;

  isCapitalGoods: boolean;
  projectId: string | null;

  /**
   * ⚠️ A WARNING, NOT A REFUSAL. The supplier charged a rate our master
   * says did not apply on that date. It may be their error, or our master
   * may be behind a notification — and refusing the bill would make the
   * product unusable in the week after every rate change. So it is
   * surfaced and the bill is still recordable, because credit is
   * available only on tax "charged in respect of such supply" and
   * somebody has to look at the excess.
   */
  rateMismatch: string | null;
};

export type PricedPurchase = {
  registration: GstRegistration | null;
  placeOfSupplyCode: string | null;
  isInterState: boolean;
  lines: PricedPurchaseLine[];

  subtotalMinor: bigint;
  discountMinor: bigint;
  taxableValueMinor: bigint;
  cgstMinor: bigint;
  sgstMinor: bigint;
  igstMinor: bigint;
  cessMinor: bigint;
  roundOffMinor: bigint;
  totalMinor: bigint;

  itcEligibleTaxMinor: bigint;
  itcBlockedTaxMinor: bigint;

  /** Tax we self-assess and pay IN CASH under Section 9(3)/9(4). */
  rcmTaxMinor: bigint;
  /** ⚠️ EXCLUDES GST — CBDT Circular 23/2017. */
  tdsBaseMinor: bigint;

  taxPeriod: string;
};

export type PriceResult =
  | { ok: true; priced: PricedPurchase }
  | { ok: false; error: string };

/* ------------------------------------------------------------------ */
/* ⭐ THE COMPOSITION                                                  */
/* ------------------------------------------------------------------ */

/**
 * Turn a validated vendor bill into the rows that will be written.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHY THE TAX IS TAKEN FROM THE DOCUMENT AND NOT RECOMPUTED
 * ══════════════════════════════════════════════════════════════════════
 * This is the single biggest structural difference from Phase 32, and
 * getting it backwards would be a subtle disaster.
 *
 * On the OUTWARD side we decide the tax, so `computeInvoiceTax` produces
 * it and the document is built from the answer. On the INWARD side the
 * SUPPLIER decided it. What we owe them is what they billed, and what we
 * may claim is the tax "charged in respect of such supply" — Section
 * 16(2)(a). Recomputing and substituting our own figure would:
 *
 *   • make the payable disagree with the vendor's invoice, so the vendor
 *     reconciliation fails on every line;
 *   • make our books disagree with GSTR-2B, which carries the SUPPLIER'S
 *     figures, so the Phase 34 reconciliation would show a mismatch on
 *     every document;
 *   • and claim a credit for tax that was never charged.
 *
 * So the supplier's figures are RECORDED, and the dated rate master is
 * used only to CHECK them — a mismatch is surfaced as `rateMismatch` and
 * the person entering the bill decides.
 *
 * ⚠️ `taxPointDate` IS THE INVOICE DATE, NOT `new Date()`. A March bill
 * entered in May must be checked against March's rate. Reading the clock
 * would compare a historical charge with today's notification and report
 * a mismatch on every old bill in a backlog.
 */
export async function pricePurchase(
  tenantId: string,
  input: RecordPurchaseInvoiceInput,
): Promise<PriceResult> {
  const vendor = await findVendor(tenantId, input.vendorId);
  if (!vendor) {
    return { ok: false, error: "That vendor is not in this workspace." };
  }
  if (!vendor.isActive) {
    return {
      ok: false,
      error:
        `${vendor.legalName} is blocked${vendor.blockedReason ? `: ${vendor.blockedReason}` : ""}. ` +
        `Unblock the vendor before entering new bills — blocking exists to stop ` +
        `exactly this, and the history stays either way.`,
    };
  }

  const registration = await resolveIssuingRegistration(
    tenantId,
    input.recipientRegistrationId,
  );

  /**
   * ⭐ Place of supply, on the INWARD side.
   *
   * ⚠️ THE "SUPPLIER" HERE IS THE VENDOR AND THE "RECIPIENT" IS US — the
   * roles are the mirror of Phase 32. What we actually need out of it is
   * whether the supply was inter-state, because that decides whether the
   * credit arrives as IGST or as CGST+SGST, and a credit in the wrong
   * head cannot be set against that head's liability.
   *
   * The engine is reused rather than reimplemented: Section 12(3) applies
   * to a contractor's bill for building a tower exactly as it applies to
   * the flat we sell out of it.
   */
  let placeOfSupplyCode: string | null = input.placeOfSupplyCode ?? null;
  let isInterState = false;

  if (input.supplyType === "immovable_property" && input.propertyStateCode) {
    // The validator has already refused a place of supply that disagrees
    // with the property. Trust it and record the property's state.
    placeOfSupplyCode = input.propertyStateCode;
  } else if (!placeOfSupplyCode && registration) {
    /**
     * ⚠️ WE ARE THE RECIPIENT, SO **OUR** REGISTRATION IS THE RECIPIENT
     * STATE — and the "supplier state" the engine wants is also ours,
     * deliberately.
     *
     * The engine answers "where is the supply, relative to the supplier".
     * On a purchase we are asking a narrower question: which head did the
     * credit arrive in. The vendor already answered it by charging IGST
     * or CGST+SGST, and this branch is only reached when the document did
     * not say — an unregistered vendor, or an incomplete import.
     *
     * Passing our own state on both sides makes the fallback INTRA-state,
     * which is the conservative answer: an intra-state credit recorded in
     * error is corrected by a credit note from the vendor, whereas
     * guessing IGST records a credit in a pool the supply never touched.
     */
    const pos = determinePlaceOfSupply({
      supplierStateCode: registration.stateCode,
      supplyType: input.supplyType,
      recipientRegistration: "regular",
      recipientStateCode: registration.stateCode,
      propertyStateCode: input.propertyStateCode ?? null,
    });
    if (pos.ok) placeOfSupplyCode = pos.supply.placeOfSupplyCode;
  }

  if (registration && placeOfSupplyCode) {
    isInterState = placeOfSupplyCode !== registration.stateCode;
  }

  /* --- Lines ---------------------------------------------------- */

  const lines: PricedPurchaseLine[] = [];

  let subtotal = 0n;
  let discount = 0n;
  let taxable = 0n;
  let cgst = 0n;
  let sgst = 0n;
  let igst = 0n;
  let cess = 0n;
  let itcEligible = 0n;
  let itcBlocked = 0n;
  let rcmTax = 0n;

  for (const line of input.lines) {
    const amountMinor = parseMoney(line.amount);
    const discountMinor = line.discount ? parseMoney(line.discount) : 0n;

    if (discountMinor > amountMinor) {
      return {
        ok: false,
        error:
          `Line ${line.lineNumber} is discounted below zero. A discount larger ` +
          `than the line is a credit note from the vendor, not a line.`,
      };
    }

    const taxableValueMinor = amountMinor - discountMinor;

    const heads: TaxHeads = {
      cgstMinor: parseMoney(line.cgst),
      sgstMinor: parseMoney(line.sgst),
      igstMinor: parseMoney(line.igst),
      cessMinor: parseMoney(line.cess),
    };

    /* --- Check the supplier's rate against the dated master ----- */

    let hsnSacId: string | null = null;
    let gstRateId: string | null = null;
    let rateMismatch: string | null = null;

    if (line.hsnSacCode) {
      const code = await findHsnSacByCode(tenantId, line.hsnSacCode);
      if (code) {
        hsnSacId = code.id;
        const history = await loadRateHistory(tenantId, code.id);
        // ⭐ Resolved against the INVOICE date, never the clock.
        const rate = resolveRateOn(history, input.invoiceDate);
        if (rate) {
          gstRateId = rate.id;
          if (rate.rateBps !== line.rateBps) {
            rateMismatch =
              `The supplier charged ${line.rateBps / 100}% on ${line.hsnSacCode}, ` +
              `but the rate notified for that classification on ${input.invoiceDate} ` +
              `was ${rate.rateBps / 100}%. Input tax credit is available only on tax ` +
              `charged in respect of the supply (Section 16(2)), so any excess is ` +
              `not claimable — check the bill with the vendor, or correct the rate ` +
              `master if it is behind a notification.`;
          }
        }
      }
    }

    /* --- ⭐⭐ THE DETERMINATION -------------------------------- */

    const determination = determineItcEligibility({
      itcPurpose: line.itcPurpose,
      expenditureNature: line.expenditureNature,
      // ⭐ Read from the OUTWARD rate the caller supplies. A developer on
      // the 1%/5% residential scheme has no credit on that project at
      // all, whatever Section 17(5) says — and can simultaneously be on
      // the old 12%-with-credit scheme for another tower.
      ...(line.outwardRateAllowsItc === undefined
        ? {}
        : { outwardRateAllowsItc: line.outwardRateAllowsItc }),
      ...(line.vehicleUsedForTaxableOnwardSupply === undefined
        ? {}
        : { vehicleUsedForTaxableOnwardSupply: line.vehicleUsedForTaxableOnwardSupply }),
      ...(line.statutoryObligationToEmployees === undefined
        ? {}
        : { statutoryObligationToEmployees: line.statutoryObligationToEmployees }),
      ...(line.usedForSameCategoryOutwardSupply === undefined
        ? {}
        : { usedForSameCategoryOutwardSupply: line.usedForSameCategoryOutwardSupply }),
      // ⚠️ A bill of supply is not a tax invoice, and Section 16(2)(a)
      // outranks every other test. Derived from the document rather than
      // asked for again per line.
      hasValidTaxInvoice: !input.isBillOfSupply,
    });

    const split = splitItcByVerdict(determination.eligibility, heads);

    lines.push({
      lineNumber: line.lineNumber,
      description: line.description,
      hsnSacId,
      hsnSacCode: line.hsnSacCode ?? null,
      gstRateId,
      amountMinor,
      discountMinor,
      taxableValueMinor,
      rateBps: line.rateBps,
      cessRateBps: line.cessRateBps,
      heads,
      isReverseCharge: line.isReverseCharge,
      determination,
      itcEligibleTaxMinor: split.eligibleTaxMinor,
      itcBlockedTaxMinor: split.blockedTaxMinor,
      isCapitalGoods: line.isCapitalGoods,
      projectId: line.projectId ?? null,
      rateMismatch,
    });

    subtotal += amountMinor;
    discount += discountMinor;
    taxable += taxableValueMinor;
    cgst += heads.cgstMinor;
    sgst += heads.sgstMinor;
    igst += heads.igstMinor;
    cess += heads.cessMinor;
    itcEligible += split.eligibleTaxMinor;
    itcBlocked += split.blockedTaxMinor;

    // ⭐ On a purchase, reverse-charge tax is cash OUT. Section 49(4)
    // forbids paying it from the credit ledger, so it is tracked
    // separately from the amount payable to the vendor — the vendor never
    // charged it and must not be paid it.
    if (line.isReverseCharge) rcmTax += sumHeads(heads);
  }

  const roundOffMinor = parseMoney(input.roundOff);
  const totalMinor = taxable + cgst + sgst + igst + cess + roundOffMinor;

  /**
   * ⚠️ BELT AND BRACES, AND IT HAS EARNED ITS PLACE. The deferred trigger
   * in SQL §6 asks the same question at COMMIT and is the guarantee. This
   * fires before anything is written, so the caller gets a sentence
   * rather than a constraint name — and if it ever fires, the loop above
   * is wrong and a figure that does not add up is on its way to a return.
   */
  if (itcEligible + itcBlocked !== cgst + sgst + igst + cess) {
    return {
      ok: false,
      error:
        "The input tax credit determination does not account for all of the tax " +
        "on this bill. Every paisa is either claimable or blocked; a gap reaches " +
        "neither the return nor the cost of the building. This is a defect — do " +
        "not record this invoice, and report it.",
    };
  }

  return {
    ok: true,
    priced: {
      registration,
      placeOfSupplyCode,
      isInterState,
      lines,
      subtotalMinor: subtotal,
      discountMinor: discount,
      taxableValueMinor: taxable,
      cgstMinor: cgst,
      sgstMinor: sgst,
      igstMinor: igst,
      cessMinor: cess,
      roundOffMinor,
      totalMinor,
      itcEligibleTaxMinor: itcEligible,
      itcBlockedTaxMinor: itcBlocked,
      rcmTaxMinor: rcmTax,
      // ⚠️ EXCLUDES GST. CBDT Circular 23/2017 — where the tax is shown
      // separately, income-tax TDS is deducted on the value alone.
      // Deducting on the gross over-deducts by the GST rate, and the
      // excess is only recoverable on the deductee's own return.
      tdsBaseMinor: input.isTdsDeductible ? taxable : 0n,
      // The period the credit is claimed in. Explicit where given —
      // a March bill received in May is claimed in May.
      taxPeriod: input.taxPeriod ?? taxPeriodOf(input.invoiceDate),
    },
  };
}
