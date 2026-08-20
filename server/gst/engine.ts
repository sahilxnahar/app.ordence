import "server-only";

/**
 * Ordence — GST Engine (composition layer)
 * Version: v0.32.0-alpha
 *
 * The only place that puts the three pure decisions together with the
 * database:
 *
 *   1. WHERE is the supply?   → `lib/gst/place-of-supply.ts`
 *   2. WHAT rate applied THAT DAY? → `lib/gst/rates.ts` over rows loaded
 *      by `server/gst/registry.ts`
 *   3. HOW MUCH, per line, reconciling exactly → `lib/gst/tax.ts`
 *
 * ⚠️ IT DECIDES NOTHING ITSELF. Every rule lives in `lib/gst/`. This file
 * loads rows, calls the engine, and turns a refusal into a sentence. If a
 * tax rule ever appears in this file, it has been written twice.
 *
 * ⚠️ NOT `"use server"`. It exports types alongside async functions.
 */

import { resolveIssuingRegistration, findHsnSacByCode, loadRateHistory } from "./registry";
import {
  determinePlaceOfSupply,
  type PlaceOfSupply,
} from "@/lib/gst/place-of-supply";
import { resolveRateOn, describeMissingRate, type DatedRate } from "@/lib/gst/rates";
import { computeInvoiceTax, type TaxComputation, type TaxLineInput } from "@/lib/gst/tax";
import { parseMoney } from "@/lib/billing/money";
import type { ComputeTaxInput } from "@/lib/validators/gst";
import type { GstRegistration, HsnSacCode } from "@/db/schema/gst";

export type QuotedTax = {
  registration: GstRegistration;
  placeOfSupply: PlaceOfSupply;
  computation: TaxComputation;
  /** The `hsn_sac_rates` row each line was priced from, keyed by line key. */
  rateByLine: Record<string, DatedRate>;
  /**
   * ⭐ ADDED IN WAVE 15 (Track E). The `hsn_sac_codes` row each line's
   * classification RESOLVED TO, keyed by line key.
   *
   * ⚠️ IT WAS ALREADY BEING LOADED AND THEN THROWN AWAY. `quoteTax` has
   * always called `findHsnSacByCode` — that is how it refuses a line whose
   * code is not in the master — and it kept only the rate history that
   * hung off it. So `sales_invoice_lines.hsn_sac_code_id` had no
   * engine-resolved value to be written from, and every caller wrote the
   * one the CLIENT posted, exactly as `server/actions/orders.ts:174` still
   * does for the rate pin.
   *
   * Additive: nothing that destructures `QuotedTax` today is affected.
   */
  codeByLine: Record<string, HsnSacCode>;
  taxPointDate: string;
};

export type QuoteResult =
  | { ok: true; quote: QuotedTax }
  | { ok: false; error: string };

/**
 * Price a document's tax, as at its own date.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ `taxPointDate` IS AN INPUT, NOT `new Date()`
 * ══════════════════════════════════════════════════════════════════════
 * Re-quoting a March 2019 invoice must produce the March 2019 figures.
 * If this function read the clock, the same document would price
 * differently every time a rate notification landed — and the second
 * answer would look exactly as authoritative as the first.
 *
 * That is also why the resolved rate row's id comes back in
 * `rateByLine`: the caller writes it onto `invoice_lines.gst_rate_id`,
 * which pins the document to the exact period it was priced from and is
 * what makes the rate unrecoverable-by-accident later.
 */
export async function quoteTax(
  tenantId: string,
  input: ComputeTaxInput,
): Promise<QuoteResult> {
  const registration = await resolveIssuingRegistration(
    tenantId,
    input.supplierRegistrationId,
  );

  if (!registration) {
    return {
      ok: false,
      error:
        "No GST registration was found to issue this under. Add the workspace's " +
        "GSTIN before raising a tax invoice.",
    };
  }

  const pos = determinePlaceOfSupply({
    supplierStateCode: registration.stateCode,
    supplyType: input.supplyType,
    recipientRegistration: input.recipientRegistration,
    recipientStateCode: input.recipientStateCode ?? null,
    propertyStateCode: input.propertyStateCode ?? null,
    deliveryStateCode: input.deliveryStateCode ?? null,
  });

  if (!pos.ok) {
    return { ok: false, error: `${pos.problem.message} ${pos.problem.remedy}` };
  }

  const rateByLine: Record<string, DatedRate> = {};
  const codeByLine: Record<string, HsnSacCode> = {};
  const lines: TaxLineInput[] = [];

  for (const line of input.lines) {
    if (!line.hsnSacCode) {
      return {
        ok: false,
        error:
          `"${line.description}" has no HSN or SAC code. The rate is resolved from ` +
          `the classification, so a line without one has no defensible rate.`,
      };
    }

    const code = await findHsnSacByCode(tenantId, line.hsnSacCode);
    if (!code) {
      return {
        ok: false,
        error:
          `${line.hsnSacCode} is not in the HSN/SAC master. Add it, with the rate ` +
          `periods that have applied to it.`,
      };
    }

    // ⭐ The whole history, resolved against the DOCUMENT'S date.
    const history = await loadRateHistory(tenantId, code.id);
    const rate = resolveRateOn(history, input.taxPointDate);

    if (!rate) {
      const problem = describeMissingRate(line.hsnSacCode, input.taxPointDate);
      return { ok: false, error: `${problem.message} ${problem.remedy}` };
    }

    rateByLine[line.key] = rate;
    codeByLine[line.key] = code;
    lines.push({
      key: line.key,
      description: line.description,
      hsnSacCode: line.hsnSacCode,
      rateId: rate.id,
      grossMinor: parseMoney(line.amount),
      discountMinor: line.discount ? parseMoney(line.discount) : 0n,
      rateBps: rate.rateBps,
      cessRateBps: rate.cessRateBps,
      cessPerUnitMinor: rate.cessPerUnitMinor,
      quantity: line.quantity,
      // ⚠️ The MASTER decides reverse charge, and the caller may only add
      // to it. A classification notified under Section 9(3) is on reverse
      // charge whatever the form says; a line may additionally be flagged
      // (Section 9(4), an unregistered supplier) which the master cannot
      // know.
      reverseCharge: rate.reverseCharge === true || line.reverseCharge === true,
    });
  }

  const computation = computeInvoiceTax({
    lines,
    taxKind: pos.supply.taxKind,
    placeOfSupplyCode: pos.supply.placeOfSupplyCode,
    roundToRupee: input.roundToRupee,
  });

  return {
    ok: true,
    quote: {
      registration,
      placeOfSupply: pos.supply,
      computation,
      rateByLine,
      codeByLine,
      taxPointDate: input.taxPointDate,
    },
  };
}
