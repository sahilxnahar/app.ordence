/**
 * Ordence — GST Computation
 * Version: v0.32.0-alpha
 *
 * Pure. Every amount is `bigint` paise; every rate is integer basis
 * points. `applyRateBps` and `splitEvenly` come from
 * `lib/billing/money.ts` and are NOT restated here — a second rounding
 * implementation that differs by one paisa from the one the subscription
 * biller uses is a discrepancy nobody can explain and everybody can see.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHY TAX IS COMPUTED PER LINE AND THEN SUMMED, NEVER ON THE TOTAL
 * ══════════════════════════════════════════════════════════════════════
 * A tax invoice prints a tax figure against EACH line and a total at the
 * foot. Somebody — an auditor, the buyer's accounts clerk, the buyer —
 * will add the column. If the total were computed as tax on the summed
 * taxable value, the column would not add up to it whenever rounding
 * broke differently, and the difference would be a rupee or two on a
 * document that has to be defended.
 *
 * So: round each line, then add. The printed column adds to the printed
 * total BY CONSTRUCTION, on every invoice, for every set of amounts.
 * There is no reconciliation step because there is nothing to reconcile.
 *
 * This is also why lines carry their own rate. A booking invoice for a
 * flat has the 5% construction line and an 18% line for the club-house
 * membership, and the two cannot share a computation.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ REVERSE CHARGE IS SHOWN AND NOT COLLECTED
 * ══════════════════════════════════════════════════════════════════════
 * Under Section 9(3)/9(4), for some supplies the RECIPIENT pays the tax
 * directly to the Government. The invoice must show the tax and must NOT
 * add it to the amount payable — Rule 46(p) requires the document to say
 * "tax payable on reverse charge basis".
 *
 * Adding it to the total is the failure mode, and it is a double payment:
 * the customer pays us tax we do not owe, and pays the Government the
 * same tax that they do. Getting it back is a credit note and a refund
 * claim. So `reverseChargeTaxMinor` is tracked SEPARATELY from
 * `totalTaxMinor` and is deliberately absent from `invoiceTotalMinor`.
 */

import { applyRateBps, splitEvenly } from "@/lib/billing/money";
import type { GstTaxKind } from "./place-of-supply";

/* ------------------------------------------------------------------ */
/* INPUT                                                               */
/* ------------------------------------------------------------------ */

export type TaxLineInput = {
  /** Stable key so the caller can match a computed line back to its row. */
  key: string;
  description?: string;
  hsnSacCode?: string | null;
  /** ⭐ The `hsn_sac_rates` row this rate came from. Pinned on the line. */
  rateId?: string | null;

  /** quantity × unit price, before any discount. Paise. */
  grossMinor: bigint;
  /** Line-level discount. Paise, non-negative. */
  discountMinor?: bigint;

  rateBps: number;
  cessRateBps?: number;
  /** Specific cess per unit — coal is ₹400 a tonne whatever it costs. */
  cessPerUnitMinor?: bigint;
  /** Units, for the specific cess only. Never used for the value. */
  quantity?: number;

  /** Section 9(3)/9(4): the recipient pays this line's tax, not us. */
  reverseCharge?: boolean;
};

export type TaxComputationInput = {
  lines: readonly TaxLineInput[];
  taxKind: GstTaxKind;
  placeOfSupplyCode: string;
  /**
   * Round the amount payable to a whole rupee, recording the adjustment.
   *
   * ⚠️ OFF BY DEFAULT. Section 170 rounds the TAX to the nearest rupee,
   * which is a different operation from rounding the invoice total, and
   * many developers deliberately do neither so the demand matches the
   * agreement to the paisa. A rounding that appears without being asked
   * for makes the invoice disagree with the payment plan by up to 99
   * paise per instalment, forever.
   */
  roundToRupee?: boolean;
};

/* ------------------------------------------------------------------ */
/* OUTPUT                                                              */
/* ------------------------------------------------------------------ */

export type ComputedTaxLine = {
  key: string;
  hsnSacCode: string | null;
  rateId: string | null;
  grossMinor: bigint;
  discountMinor: bigint;
  /** gross − discount. What tax is charged on. */
  taxableMinor: bigint;
  rateBps: number;
  cessRateBps: number;
  cgstMinor: bigint;
  /** Carries UTGST when `taxKind` is `cgst_utgst`. Same column, other Act. */
  sgstMinor: bigint;
  igstMinor: bigint;
  cessMinor: bigint;
  totalTaxMinor: bigint;
  /** taxable + tax, or just taxable when the tax is on reverse charge. */
  lineTotalMinor: bigint;
  isReverseCharge: boolean;
};

/**
 * ⚠️ THE HOOK PHASE 36 FILLS IN, AND WHY IT IS A HOOK RATHER THAN A
 * HALF-IMPLEMENTATION.
 *
 * Two different deductions collide with GST and they behave differently:
 *
 *   • TDS under the Income-tax Act (194-IA on a property transfer at 1%,
 *     194C/194J on contractor and professional payments) is deducted by
 *     the PAYER from what they pay us. It is computed on the value
 *     EXCLUDING GST where the GST is shown separately — CBDT Circular
 *     23/2017. Computing it on the gross is a common and expensive error.
 *   • TDS under Section 51 of the CGST Act is 2% deducted by government
 *     and PSU recipients, again on the value excluding tax.
 *
 * Neither changes what we CHARGE — they change what we RECEIVE — so
 * putting them in this computation would mix the tax on the invoice with
 * the cash the invoice collects. They belong to the receipt, and the
 * receipt is Phase 36. This shape exists so the seam is visible.
 */
export type TdsInteraction = {
  applicable: false;
  /** The base a later phase must use. Excludes GST. Stated now, not later. */
  deductionBaseMinor: bigint;
  note: string;
};

export type TaxComputation = {
  taxKind: GstTaxKind;
  placeOfSupplyCode: string;
  isInterState: boolean;
  isUnionTerritory: boolean;

  lines: ComputedTaxLine[];

  grossMinor: bigint;
  discountMinor: bigint;
  taxableMinor: bigint;

  cgstMinor: bigint;
  sgstMinor: bigint;
  igstMinor: bigint;
  cessMinor: bigint;

  /** Tax WE collect. Excludes anything on reverse charge. */
  totalTaxMinor: bigint;
  /** Tax the RECIPIENT pays direct. Shown on the invoice, never added. */
  reverseChargeTaxMinor: bigint;

  /** taxable + totalTax. The figure the customer owes before rounding. */
  invoiceTotalMinor: bigint;
  roundOffMinor: bigint;
  amountPayableMinor: bigint;

  tds: TdsInteraction;
};

/* ------------------------------------------------------------------ */
/* THE COMPUTATION                                                     */
/* ------------------------------------------------------------------ */

export function computeInvoiceTax(input: TaxComputationInput): TaxComputation {
  const { taxKind, placeOfSupplyCode } = input;
  const isInterState = taxKind === "igst";
  const isUnionTerritory = taxKind === "cgst_utgst";

  const lines: ComputedTaxLine[] = [];

  let gross = 0n;
  let discount = 0n;
  let taxable = 0n;
  let cgst = 0n;
  let sgst = 0n;
  let igst = 0n;
  let cess = 0n;
  let collectedTax = 0n;
  let reverseChargeTax = 0n;
  let invoiceTotal = 0n;

  for (const line of input.lines) {
    const lineDiscount = line.discountMinor ?? 0n;

    if (lineDiscount < 0n) {
      throw new Error(
        `Line "${line.key}" has a negative discount. A discount is subtracted; ` +
          `a negative one silently increases the taxable value.`,
      );
    }
    if (lineDiscount > line.grossMinor && line.grossMinor >= 0n) {
      throw new Error(
        `Line "${line.key}" is discounted below zero. A discount larger than the ` +
          `line is a credit note, not a line — issue one.`,
      );
    }

    const lineTaxable = line.grossMinor - lineDiscount;
    const cessRateBps = line.cessRateBps ?? 0;

    // ⚠️ ROUNDED HERE, ONCE, PER LINE. `applyRateBps` is half-up in exact
    // integer arithmetic, which is the statutory method and the method an
    // auditor recomputing the line by hand will use.
    const lineTax = applyRateBps(lineTaxable, line.rateBps);

    // Ad-valorem cess plus specific cess. Both can apply to one line.
    const adValoremCess = applyRateBps(lineTaxable, cessRateBps);
    const specificCess =
      (line.cessPerUnitMinor ?? 0n) * BigInt(Math.max(0, Math.trunc(line.quantity ?? 0)));
    const lineCess = adValoremCess + specificCess;

    let lineCgst = 0n;
    let lineSgst = 0n;
    let lineIgst = 0n;

    if (isInterState) {
      lineIgst = lineTax;
    } else {
      // ⭐ `splitEvenly`, NOT `applyRateBps(taxable, rate / 2)` twice.
      //
      // Halving the RATE and rounding each half separately is the obvious
      // implementation and it is wrong: on a tax of ₹100.01 it produces
      // ₹50.01 + ₹50.01 = ₹100.02, so the two halves do not add to the
      // tax charged and the invoice check constraint refuses the row —
      // correctly. Splitting the ROUNDED TOTAL is exact by construction,
      // and the odd paisa lands on CGST, deterministically.
      const [half = 0n, otherHalf = 0n] = splitEvenly(lineTax, 2);
      lineCgst = half;
      lineSgst = otherHalf;
    }

    const lineTotalTax = lineTax + lineCess;
    const isRcm = line.reverseCharge === true;

    // ⭐ The reverse-charge line contributes its VALUE to the invoice and
    // its TAX to nothing the customer pays.
    const lineTotal = isRcm ? lineTaxable : lineTaxable + lineTotalTax;

    lines.push({
      key: line.key,
      hsnSacCode: line.hsnSacCode ?? null,
      rateId: line.rateId ?? null,
      grossMinor: line.grossMinor,
      discountMinor: lineDiscount,
      taxableMinor: lineTaxable,
      rateBps: line.rateBps,
      cessRateBps,
      cgstMinor: lineCgst,
      sgstMinor: lineSgst,
      igstMinor: lineIgst,
      cessMinor: lineCess,
      totalTaxMinor: lineTotalTax,
      lineTotalMinor: lineTotal,
      isReverseCharge: isRcm,
    });

    gross += line.grossMinor;
    discount += lineDiscount;
    taxable += lineTaxable;
    invoiceTotal += lineTotal;

    if (isRcm) {
      reverseChargeTax += lineTotalTax;
    } else {
      cgst += lineCgst;
      sgst += lineSgst;
      igst += lineIgst;
      cess += lineCess;
      collectedTax += lineTotalTax;
    }
  }

  /**
   * ⚠️ BELT AND BRACES, AND IT HAS EARNED ITS PLACE.
   *
   * If this ever fires, the loop above is wrong and a document that does
   * not add up is on its way to a buyer and to a return. `buildPlan` in
   * Phase 22 carries the same guard for the same reason: an arithmetic
   * invariant that is only true "by construction" is true until somebody
   * edits the construction.
   */
  const expectedTotal = taxable + collectedTax;
  if (invoiceTotal !== expectedTotal) {
    throw new Error(
      `GST computation does not reconcile: lines total ${invoiceTotal} paise, ` +
        `taxable + tax is ${expectedTotal} paise. This is a defect — do not ` +
        `issue this invoice.`,
    );
  }
  if (cgst + sgst + igst + cess !== collectedTax) {
    throw new Error(
      "GST computation does not reconcile: the tax heads do not sum to the tax " +
        "collected. This is a defect — do not issue this invoice.",
    );
  }

  const roundOff = input.roundToRupee ? roundOffToRupee(invoiceTotal) : 0n;

  return {
    taxKind,
    placeOfSupplyCode,
    isInterState,
    isUnionTerritory,
    lines,
    grossMinor: gross,
    discountMinor: discount,
    taxableMinor: taxable,
    cgstMinor: cgst,
    sgstMinor: sgst,
    igstMinor: igst,
    cessMinor: cess,
    totalTaxMinor: collectedTax,
    reverseChargeTaxMinor: reverseChargeTax,
    invoiceTotalMinor: invoiceTotal,
    roundOffMinor: roundOff,
    amountPayableMinor: invoiceTotal + roundOff,
    tds: {
      applicable: false,
      // ⚠️ EXCLUDING GST. CBDT Circular 23/2017 — where the tax is shown
      // separately on the invoice, TDS is deducted on the value alone.
      deductionBaseMinor: taxable,
      note:
        "TDS interaction is Phase 36. The base recorded here excludes GST, per " +
        "CBDT Circular 23/2017 — deducting on the gross over-deducts by the tax " +
        "rate and the excess is only recoverable on the payer's return.",
    },
  };
}

/**
 * The adjustment that takes an amount to the nearest whole rupee.
 *
 * Half-up on 50 paise, matching `applyRateBps` and matching what a person
 * recomputing the round-off line by hand will do.
 */
export function roundOffToRupee(amountMinor: bigint): bigint {
  const remainder = ((amountMinor % 100n) + 100n) % 100n;
  return remainder === 0n ? 0n : remainder >= 50n ? 100n - remainder : -remainder;
}

/* ------------------------------------------------------------------ */
/* RECONCILIATION                                                      */
/* ------------------------------------------------------------------ */

export type ReconciliationProblem = {
  field: string;
  expectedMinor: bigint;
  actualMinor: bigint;
  message: string;
};

/**
 * Does a stored invoice header agree with its stored lines?
 *
 * ⚠️ THE DATABASE ASKS THE SAME QUESTION AT COMMIT (SQL Section 6), and
 * this is not a duplicate of that. The deferred constraint trigger is the
 * guarantee — it holds for the import script and the psql session as well
 * as for this code path. This function exists to produce a SENTENCE for
 * the person looking at a document that has already gone wrong, naming
 * which head is off and by how much.
 */
export function reconcileInvoice(args: {
  header: {
    subtotalMinor: bigint;
    discountMinor: bigint;
    cgstMinor: bigint;
    sgstMinor: bigint;
    igstMinor: bigint;
    cessMinor: bigint;
    totalMinor: bigint;
  };
  lines: readonly {
    taxableMinor: bigint;
    cgstMinor: bigint;
    sgstMinor: bigint;
    igstMinor: bigint;
    cessMinor: bigint;
    isReverseCharge: boolean;
  }[];
}): ReconciliationProblem[] {
  const problems: ReconciliationProblem[] = [];

  let taxable = 0n;
  let cgst = 0n;
  let sgst = 0n;
  let igst = 0n;
  let cess = 0n;

  for (const line of args.lines) {
    taxable += line.taxableMinor;
    if (line.isReverseCharge) continue;
    cgst += line.cgstMinor;
    sgst += line.sgstMinor;
    igst += line.igstMinor;
    cess += line.cessMinor;
  }

  const headerTaxable = args.header.subtotalMinor - args.header.discountMinor;

  const checks: [string, bigint, bigint][] = [
    ["taxable value", taxable, headerTaxable],
    ["CGST", cgst, args.header.cgstMinor],
    ["SGST/UTGST", sgst, args.header.sgstMinor],
    ["IGST", igst, args.header.igstMinor],
    ["cess", cess, args.header.cessMinor],
    ["total", taxable + cgst + sgst + igst + cess, args.header.totalMinor],
  ];

  for (const [field, expected, actual] of checks) {
    if (expected !== actual) {
      problems.push({
        field,
        expectedMinor: expected,
        actualMinor: actual,
        message:
          `The ${field} on the invoice is ${actual} paise but the lines add to ` +
          `${expected} paise. The document does not add up; it must not be issued.`,
      });
    }
  }

  return problems;
}
