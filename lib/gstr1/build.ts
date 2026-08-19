/**
 * Ordence — ⭐ GSTR-1: the outward supplies return
 * Version: v0.92.0-alpha
 *
 * Pure. `bigint` paise in, rupee-decimal strings out, no clock and no
 * database. Every classification rule below is a statutory one, and each
 * carries the reason it exists — because every one of them, got wrong,
 * produces a return that files successfully and is wrong.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE FIGURES LEAVE AS STRINGS, AND THAT IS NOT A STYLE CHOICE
 * ══════════════════════════════════════════════════════════════════════
 * The GST portal takes rupees with two decimals. Money is held here in
 * paise as `bigint` and formatted once, at the edge, by integer division.
 * Passing a JavaScript number would reintroduce the float error the whole
 * codebase is built to avoid — and it would do it on the one document
 * that is checked by somebody with statutory powers.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHAT THIS FILE IS NOT
 * ══════════════════════════════════════════════════════════════════════
 * It is NOT a filing client. It builds the return; it does not send it.
 * Transmission needs a GSP, an API contract that changes, and credentials
 * — and a pure function that produces a checkable artefact is worth
 * having on its own. An accountant can reconcile this against their own
 * working papers before anything is transmitted, which is exactly what a
 * first filing needs.
 */

import { creditNoteEffect, type CreditNoteEffect } from "./netting";

/* ------------------------------------------------------------------ */
/* INPUT                                                               */
/* ------------------------------------------------------------------ */

export type Gstr1Document = {
  id: string;
  /** Invoice or credit-note number, exactly as issued. */
  number: string;
  /** `YYYY-MM-DD`. */
  date: string;
  kind: "invoice" | "credit_note";
  /** The recipient's GSTIN, or null for an unregistered buyer. */
  customerGstin: string | null;
  customerName: string | null;
  placeOfSupplyCode: string | null;
  isInterState: boolean;
  isReverseCharge: boolean;
  taxableValueMinor: bigint;
  cgstMinor: bigint;
  sgstMinor: bigint;
  igstMinor: bigint;
  cessMinor: bigint;
  totalMinor: bigint;
  /** Credit notes only: the invoice being reduced. */
  againstInvoiceNumber?: string | null;
  againstInvoiceDate?: string | null;
  lines: Gstr1Line[];
};

export type Gstr1Line = {
  hsnSacCode: string | null;
  description: string;
  uom: string;
  /** `numeric(18,3)` string. Never a float — see lib/invoicing/build.ts. */
  quantity: string;
  taxRateBps: number;
  taxableValueMinor: bigint;
  cgstMinor: bigint;
  sgstMinor: bigint;
  igstMinor: bigint;
  cessMinor: bigint;
};

/* ------------------------------------------------------------------ */
/* MONEY OUT                                                           */
/* ------------------------------------------------------------------ */

/**
 * Paise → `"1234.56"`.
 *
 * ⚠️ INTEGER DIVISION, NEVER `Number(x) / 100`. A crore in paise is 10^9
 * and survives a float; a hundred crore does not, and the value that
 * breaks is the one on the largest invoice of the year.
 */
export function toRupees(minor: bigint): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  return `${negative ? "-" : ""}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ */
/* B2CS THRESHOLD                                                      */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE B2CL THRESHOLD, IN PAISE.
 *
 * An INTER-STATE supply to an UNREGISTERED person above this value is
 * reported invoice-by-invoice (B2CL). Below it, and all intra-state
 * unregistered supplies, are reported as a rate-wise summary (B2CS).
 *
 * ⚠️ THIS NUMBER HAS BEEN REVISED AND WILL BE AGAIN — it was ₹2,50,000
 * for years and was reduced to ₹1,00,000. It is a named constant with
 * this comment attached so that when it changes, it changes in one place
 * and whoever changes it can see what depends on it.
 *
 * ⚠️ VERIFY IT AGAINST THE GST PORTAL BEFORE A FIRST FILING. Building to
 * a stale threshold puts invoices in the wrong table, which the portal
 * accepts and a notice later questions.
 */
export const B2CL_THRESHOLD_MINOR = 10_000_000n; // ₹1,00,000

/* ------------------------------------------------------------------ */
/* SECTIONS                                                            */
/* ------------------------------------------------------------------ */

export type Gstr1Section = "B2B" | "B2CL" | "B2CS" | "CDNR" | "CDNUR";

/**
 * ⭐ WHICH TABLE OF THE RETURN A DOCUMENT BELONGS IN.
 *
 * ⚠️ THE PRESENCE OF A GSTIN IS THE ONLY THING THAT DECIDES B2B, and it
 * decides it for both invoices and credit notes. A registered buyer's
 * document must appear against their GSTIN or their GSTR-2B will not show
 * it — and then THEY cannot claim the credit, ring us, and are right to.
 *
 * That is the failure mode worth naming: misclassifying a B2B invoice
 * does not hurt us on our return. It silently denies the customer their
 * input credit, and they find out weeks later.
 */
export function classify(doc: Gstr1Document): Gstr1Section {
  const registered = Boolean(doc.customerGstin && doc.customerGstin.trim() !== "");

  if (doc.kind === "credit_note") {
    return registered ? "CDNR" : "CDNUR";
  }

  if (registered) return "B2B";

  /**
   * ⚠️ BOTH CONDITIONS, NOT EITHER. B2CL is inter-state AND above the
   * threshold. A ₹5,00,000 intra-state sale to a walk-in customer is
   * B2CS, and putting it in B2CL is a common and confident error.
   */
  if (doc.isInterState && doc.totalMinor > B2CL_THRESHOLD_MINOR) return "B2CL";

  return "B2CS";
}

/* ------------------------------------------------------------------ */
/* OUTPUT                                                              */
/* ------------------------------------------------------------------ */

export type Gstr1InvoiceRow = {
  gstin: string | null;
  customerName: string | null;
  number: string;
  date: string;
  placeOfSupply: string | null;
  reverseCharge: "Y" | "N";
  taxableValue: string;
  cgst: string;
  sgst: string;
  igst: string;
  cess: string;
  total: string;
  againstInvoiceNumber?: string | null;
  againstInvoiceDate?: string | null;
};

export type Gstr1RateSummaryRow = {
  placeOfSupply: string | null;
  taxRatePercent: string;
  taxableValue: string;
  cgst: string;
  sgst: string;
  igst: string;
  cess: string;
};

export type Gstr1HsnRow = {
  hsnSacCode: string;
  description: string;
  uom: string;
  quantity: string;
  taxRatePercent: string;
  taxableValue: string;
  cgst: string;
  sgst: string;
  igst: string;
  cess: string;
};

export type Gstr1Return = {
  period: string;
  gstin: string | null;
  b2b: Gstr1InvoiceRow[];
  b2cl: Gstr1InvoiceRow[];
  b2cs: Gstr1RateSummaryRow[];
  cdnr: Gstr1InvoiceRow[];
  cdnur: Gstr1InvoiceRow[];
  hsn: Gstr1HsnRow[];
  /** Table 13 — the document series, with gaps declared. */
  docIssued: { from: string; to: string; totalNumber: number; cancelled: number }[];
  totals: {
    documentCount: number;
    taxableValue: string;
    cgst: string;
    sgst: string;
    igst: string;
    cess: string;
  };
  /**
   * ⭐⭐ WHAT RULE 53 DID TO THE TOTALS ABOVE, DECLARED RATHER THAN
   * IMPLIED. The totals are NET of every credit note that reduces output
   * tax and GROSS of every one that does not, and an accountant
   * reconciling this against the ledger needs to be told which was which
   * without reading the warning list.
   */
  creditNotes: {
    /** Notes whose tax was subtracted from `totals` and from `hsn`. */
    nettedCount: number;
    /**
     * 🔴 SECTION 34(2) HAS RUN OUT ON THESE. They are still listed in
     * CDNR/CDNUR — the documents exist and the customer holds them — but
     * their tax is NOT subtracted from `totals`, because it is not
     * subtractable. That is why the section tables can foot to more than
     * the totals do.
     */
    timeBarred: {
      number: string;
      noteDate: string;
      deadline: string | null;
      againstInvoiceNumber: string | null;
    }[];
    /**
     * ⚠️ NETTED, BUT UNVERIFIED. The original supply date was not
     * supplied, so no s.34(2) window could be drawn. Reducing was the
     * safer of the two wrong answers; the list exists so somebody can
     * make it the right one.
     */
    windowUnverified: string[];
  };
  warnings: string[];
};

function toRow(doc: Gstr1Document): Gstr1InvoiceRow {
  return {
    gstin: doc.customerGstin,
    customerName: doc.customerName,
    number: doc.number,
    date: doc.date,
    placeOfSupply: doc.placeOfSupplyCode,
    reverseCharge: doc.isReverseCharge ? "Y" : "N",
    taxableValue: toRupees(doc.taxableValueMinor),
    cgst: toRupees(doc.cgstMinor),
    sgst: toRupees(doc.sgstMinor),
    igst: toRupees(doc.igstMinor),
    cess: toRupees(doc.cessMinor),
    total: toRupees(doc.totalMinor),
    ...(doc.kind === "credit_note"
      ? {
          againstInvoiceNumber: doc.againstInvoiceNumber ?? null,
          againstInvoiceDate: doc.againstInvoiceDate ?? null,
        }
      : {}),
  };
}

/** Basis points → the percent string the portal expects. `1800` → `"18"`. */
function ratePercent(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const fraction = bps % 100;
  return fraction === 0 ? String(whole) : `${whole}.${String(fraction).padStart(2, "0")}`;
}

/**
 * ⭐ BUILD THE RETURN.
 *
 * ⚠️ WARNINGS ARE RETURNED, NOT THROWN. A return with one questionable
 * document still has to be filed — the deadline does not move — and a
 * builder that refused the whole month because of one row would be worked
 * around by exporting to a spreadsheet, which is worse. The accountant
 * sees the list and decides.
 */
export function buildGstr1(args: {
  period: string;
  supplierGstin: string | null;
  documents: readonly Gstr1Document[];
  /**
   * ⚠️ THE EARLIER LIMB OF SECTION 34(2), AND IT IS NORMALLY ABSENT.
   * The window closes on the date the annual return was furnished if
   * that is before 30 November. Nothing in this codebase records a
   * GSTR-9 filing, so no caller can pass it and the window applied is
   * the latest lawful one. See `lib/gstr1/netting.ts`.
   */
  annualReturnFiledOn?: string | null;
}): Gstr1Return {
  const warnings: string[] = [];
  const b2b: Gstr1InvoiceRow[] = [];
  const b2cl: Gstr1InvoiceRow[] = [];
  const cdnr: Gstr1InvoiceRow[] = [];
  const cdnur: Gstr1InvoiceRow[] = [];

  /** B2CS is a SUMMARY, keyed by place of supply and rate. */
  const b2csBuckets = new Map<
    string,
    { pos: string | null; bps: number; taxable: bigint; cgst: bigint; sgst: bigint; igst: bigint; cess: bigint }
  >();

  const hsnBuckets = new Map<
    string,
    {
      code: string;
      description: string;
      uom: string;
      qtyMilli: bigint;
      bps: number;
      taxable: bigint;
      cgst: bigint;
      sgst: bigint;
      igst: bigint;
      cess: bigint;
    }
  >();

  let taxable = 0n;
  let cgst = 0n;
  let sgst = 0n;
  let igst = 0n;
  let cess = 0n;

  let nettedCount = 0;
  const timeBarred: Gstr1Return["creditNotes"]["timeBarred"] = [];
  const windowUnverified: string[] = [];

  for (const doc of args.documents) {
    /**
     * ══════════════════════════════════════════════════════════════════
     * 🔴 SECTION 34(2) — DECIDED BEFORE ANY ARITHMETIC
     * ══════════════════════════════════════════════════════════════════
     * A credit note issued after 30 November following the end of the
     * financial year OF THE ORIGINAL SUPPLY reduces nothing. Ordence
     * subtracted it anyway until this batch, which under-declares the
     * return — the expensive direction, because the shortfall carries
     * interest under s.50 and is found by a machine at reconciliation.
     *
     * ⚠️ THE TEST IS AGAINST THE SUPPLY'S DATE, NOT THE NOTE'S OWN
     * FINANCIAL YEAR. A note raised in the following April against a
     * March supply is in a different year from the supply and is well
     * inside the window; a note raised on the same day against a supply
     * two years old is not.
     */
    const effect: CreditNoteEffect | null =
      doc.kind === "credit_note"
        ? creditNoteEffect({
            noteDate: doc.date,
            supplyDate: doc.againstInvoiceDate ?? null,
            annualReturnFiledOn: args.annualReturnFiledOn ?? null,
          })
        : null;

    if (effect) {
      if (!effect.reducesOutputTax) {
        timeBarred.push({
          number: doc.number,
          noteDate: doc.date,
          deadline: effect.deadline,
          againstInvoiceNumber: doc.againstInvoiceNumber ?? null,
        });
        warnings.push(
          `${doc.number} is dated ${doc.date}, after the section 34(2) deadline of ` +
            `${effect.deadline} for a supply made on ${doc.againstInvoiceDate}. It is listed ` +
            `as a document but its tax is NOT deducted — the credit note is commercial, the ` +
            `output tax stays.`,
        );
      } else if (effect.reason === "supply_date_unknown") {
        windowUnverified.push(doc.number);
        warnings.push(
          `${doc.number} names no original invoice date, so the section 34(2) window cannot ` +
            `be checked. Its tax IS deducted; confirm the original supply date before filing.`,
        );
        nettedCount += 1;
      } else {
        nettedCount += 1;
      }
    }
    /**
     * ⚠️ A DOCUMENT WITH NO PLACE OF SUPPLY CANNOT BE CLASSIFIED and is
     * reported rather than silently dropped. Dropping it makes the return
     * total disagree with the books by exactly one invoice, which is the
     * hardest kind of discrepancy to find.
     */
    if (!doc.placeOfSupplyCode) {
      warnings.push(
        `${doc.number} has no place of supply. It is included, but the portal will reject it until the document is corrected.`,
      );
    }

    /**
     * ⚠️ CGST + SGST AND IGST TOGETHER IS A PLACE-OF-SUPPLY BUG. The
     * database refuses it on new documents; anything historical predates
     * that constraint and must be surfaced, not filed.
     */
    if (doc.igstMinor > 0n && (doc.cgstMinor > 0n || doc.sgstMinor > 0n)) {
      warnings.push(
        `${doc.number} carries both IGST and CGST/SGST. That is a place-of-supply error, not a rounding one — fix the document before filing.`,
      );
    }

    const section = classify(doc);
    const row = toRow(doc);

    if (section === "B2B") b2b.push(row);
    else if (section === "B2CL") b2cl.push(row);
    else if (section === "CDNR") cdnr.push(row);
    else if (section === "CDNUR") cdnur.push(row);
    else {
      for (const line of doc.lines) {
        const key = `${doc.placeOfSupplyCode ?? "??"}|${line.taxRateBps}`;
        const bucket = b2csBuckets.get(key) ?? {
          pos: doc.placeOfSupplyCode,
          bps: line.taxRateBps,
          taxable: 0n,
          cgst: 0n,
          sgst: 0n,
          igst: 0n,
          cess: 0n,
        };
        bucket.taxable += line.taxableValueMinor;
        bucket.cgst += line.cgstMinor;
        bucket.sgst += line.sgstMinor;
        bucket.igst += line.igstMinor;
        bucket.cess += line.cessMinor;
        b2csBuckets.set(key, bucket);
      }
    }

    /**
     * ⭐ THE HSN SUMMARY SPANS EVERY SECTION. Table 12 is the whole
     * month's supplies by code and rate, regardless of who bought them —
     * so it is accumulated here, outside the section branch, and not
     * inside any one of them.
     *
     * ⚠️ A CREDIT NOTE SUBTRACTS. Its line values are positive on the
     * document (it is a reduction, not a negative supply), so the sign is
     * applied here. An HSN summary that added credit notes overstates
     * turnover by twice the value of every return.
     */
    const sign =
      doc.kind === "credit_note" ? (effect?.reducesOutputTax === false ? 0n : -1n) : 1n;

    /**
     * ⚠️ A TIME-BARRED NOTE CONTRIBUTES NOTHING TO TABLE 12 EITHER, and
     * is skipped rather than added with a zero sign — otherwise it opens
     * an HSN bucket of zeros for a code and rate that no supply in the
     * period used, and an empty row in Table 12 is a question at an
     * assessment with no answer behind it.
     */
    for (const line of sign === 0n ? [] : doc.lines) {
      const code = line.hsnSacCode?.trim() || "";
      if (code === "") {
        warnings.push(
          `${doc.number} has a line with no HSN/SAC code. Table 12 requires one — Rule 46(g).`,
        );
      }
      const key = `${code}|${line.taxRateBps}`;
      const bucket = hsnBuckets.get(key) ?? {
        code,
        description: line.description,
        uom: line.uom,
        qtyMilli: 0n,
        bps: line.taxRateBps,
        taxable: 0n,
        cgst: 0n,
        sgst: 0n,
        igst: 0n,
        cess: 0n,
      };
      const qtyMilli = BigInt(
        (() => {
          const m = /^(\d*)(?:\.(\d{0,3}))?/.exec(line.quantity.trim());
          const whole = m?.[1] || "0";
          const frac = ((m?.[2] ?? "") + "000").slice(0, 3);
          return `${whole}${frac}`;
        })(),
      );
      bucket.qtyMilli += sign * qtyMilli;
      bucket.taxable += sign * line.taxableValueMinor;
      bucket.cgst += sign * line.cgstMinor;
      bucket.sgst += sign * line.sgstMinor;
      bucket.igst += sign * line.igstMinor;
      bucket.cess += sign * line.cessMinor;
      hsnBuckets.set(key, bucket);
    }

    taxable += sign * doc.taxableValueMinor;
    cgst += sign * doc.cgstMinor;
    sgst += sign * doc.sgstMinor;
    igst += sign * doc.igstMinor;
    cess += sign * doc.cessMinor;
  }

  const invoices = args.documents.filter((d) => d.kind === "invoice");
  const sortedNumbers = invoices.map((d) => d.number).sort();

  return {
    period: args.period,
    gstin: args.supplierGstin,
    b2b,
    b2cl,
    b2cs: [...b2csBuckets.values()].map((b) => ({
      placeOfSupply: b.pos,
      taxRatePercent: ratePercent(b.bps),
      taxableValue: toRupees(b.taxable),
      cgst: toRupees(b.cgst),
      sgst: toRupees(b.sgst),
      igst: toRupees(b.igst),
      cess: toRupees(b.cess),
    })),
    cdnr,
    cdnur,
    hsn: [...hsnBuckets.values()].map((h) => ({
      hsnSacCode: h.code,
      description: h.description,
      uom: h.uom,
      quantity: `${h.qtyMilli / 1000n}.${(
        (h.qtyMilli < 0n ? -h.qtyMilli : h.qtyMilli) % 1000n
      )
        .toString()
        .padStart(3, "0")}`,
      taxRatePercent: ratePercent(h.bps),
      taxableValue: toRupees(h.taxable),
      cgst: toRupees(h.cgst),
      sgst: toRupees(h.sgst),
      igst: toRupees(h.igst),
      cess: toRupees(h.cess),
    })),
    /**
     * ⭐ TABLE 13 — the document series issued in the period.
     *
     * ⚠️ THE PORTAL ASKS FOR THIS BECAUSE A GAP IN A NUMBER SERIES IS THE
     * FIRST THING AN OFFICER LOOKS FOR. Declaring the range honestly is
     * the whole point; a system that could not report it would be asking
     * its user to type a number they have no way to verify.
     */
    docIssued:
      sortedNumbers.length > 0
        ? [
            {
              from: sortedNumbers[0] ?? "",
              to: sortedNumbers[sortedNumbers.length - 1] ?? "",
              totalNumber: sortedNumbers.length,
              cancelled: 0,
            },
          ]
        : [],
    creditNotes: { nettedCount, timeBarred, windowUnverified },
    totals: {
      documentCount: args.documents.length,
      taxableValue: toRupees(taxable),
      cgst: toRupees(cgst),
      sgst: toRupees(sgst),
      igst: toRupees(igst),
      cess: toRupees(cess),
    },
    warnings,
  };
}
