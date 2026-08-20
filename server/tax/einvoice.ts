import "server-only";

/**
 * Ordence — ⭐⭐ E-INVOICE (IRN) READINESS · Rule 48(4), CGST Rules 2017
 * Wave 15 / Track E — GST, TDS and statutory correctness
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT AN IRN IS, BECAUSE EVERY RULE BELOW FOLLOWS FROM IT
 * ══════════════════════════════════════════════════════════════════════
 * Under Rule 48(4) a NOTIFIED taxpayer's invoice **is not a valid tax
 * invoice at all** unless it has been reported to an Invoice Registration
 * Portal and carries the IRN and the signed QR code the IRP returned.
 * Rule 48(5) says so in terms: an invoice required to be issued under
 * 48(4) and issued any other way "shall not be treated as an invoice".
 *
 * The consequence is not a filing adjustment. The buyer's input tax
 * credit is denied — s.16(2)(a) requires a tax invoice — so a notified
 * supplier who ships a month of invoices without IRNs has issued a month
 * of documents their customers cannot claim against, and the remedy is to
 * credit and reissue every one of them.
 *
 * The IRP itself:
 *   · computes the IRN as a hash of (supplier GSTIN, document number,
 *     document type, financial year) and issues it ONCE — a second
 *     attempt returns "duplicate IRN", never a new one;
 *   · SIGNS the payload, and the QR the customer scans carries the
 *     GSTINs, the document number and date, and the taxable and tax
 *     amounts;
 *   · accepts a CANCELLATION only within 24 hours, and only if no e-way
 *     bill is active. After that the correction is a credit note.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT THIS FILE DOES AND DOES NOT DO
 * ══════════════════════════════════════════════════════════════════════
 * It BUILDS a payload, VALIDATES it against the things the IRP rejects on
 * that are cheap to check here, and HASHES it canonically for
 * `sales_invoices.einvoice_payload_hash` (SQL 0149 §2).
 *
 * 🔴 IT DOES NOT CALL THE IRP. `submitToIrp()` throws unless a named
 * environment flag is set, and is otherwise unimplemented — see its own
 * comment. Ordence holds no GSP credentials, and a half-written network
 * client that "works in dev" is how an unsigned document reaches a
 * customer looking exactly like a signed one.
 *
 * `lib/gst/eway.ts buildEwayPayload` is the template followed here: pure
 * shape-building, no clock, no network, every "why" in a comment beside
 * the field it explains.
 */

import { createHash } from "node:crypto";
import { describeGstinProblem } from "@/lib/gst/gstin";
import { minimumHsnDigits } from "@/lib/gst/eway";
import { isPlaceOfSupplyCode, OVERSEAS_PLACE_OF_SUPPLY } from "@/lib/gst/constants";
import { stateCodeFromGstin } from "@/lib/billing/money";
import type { GstRegistrationType } from "@/db/schema/gst";

export class EInvoiceError extends Error {}

/* ------------------------------------------------------------------ */
/* ① APPLICABILITY — WHO IS NOTIFIED, AND FROM WHEN                    */
/* ------------------------------------------------------------------ */

/**
 * 🔴 ₹5 CRORE = 5,00,00,000 rupees = 5,000,000,000 paise.
 *
 * Notification 10/2023-Central Tax dated 10 May 2023, with effect from
 * 1 August 2023: e-invoicing applies to a registered person whose
 * AGGREGATE TURNOVER in ANY financial year from 2017-18 onwards exceeded
 * ₹5 crore.
 *
 * ⚠️ THREE TRAPS IN THAT SENTENCE, AND EACH IS A REAL MISTAKE:
 *
 *   1. "ANY financial year from 2017-18 onwards", not "the last one". A
 *      business that crossed ₹5 crore in 2018-19 and has run at ₹2 crore
 *      since is STILL notified. Applicability is a ratchet: it does not
 *      come off when turnover falls.
 *   2. "AGGREGATE turnover" is PAN-level and all-India — every GSTIN of
 *      the same legal person, plus exempt supplies, exports and
 *      inter-branch stock transfers. A per-GSTIN figure understates it,
 *      and a multi-state developer is exactly the shape that gets this
 *      wrong.
 *   3. "EXCEEDED", not "of or exceeding". Turnover of exactly ₹5 crore is
 *      not notified. The comparison below is strictly greater than, which
 *      matters because round-number turnovers are not as rare as they
 *      sound.
 *
 * ⚠️⚠️ AND IT IS A MOVING TARGET THAT DOES NOT BELONG IN CODE. The
 * threshold has been ₹500cr, ₹100cr, ₹50cr, ₹20cr, ₹10cr and ₹5cr in
 * five years — six notifications, six deploys. It belongs in a table
 * alongside the rate history, resolved by date exactly as
 * `lib/gst/rates.ts` resolves a rate, so that a threshold change is a
 * row and not a release. `EINVOICE_THRESHOLD_SCHEDULE` below is that
 * table in the only place Track E may put it; a migration creating
 * `einvoice_thresholds` is requested in PATCH-REQUEST-E.md.
 *
 * 🔴 THE REPO STATES NO THRESHOLD ANYWHERE. SQL 0149 §6 says explicitly
 * that "Rule 48(4) applies above a turnover threshold that this database
 * does not record", and `lib/gst/eway.ts minimumHsnDigits` uses ₹5 crore
 * for a DIFFERENT rule (HSN digit count, Notification 78/2020). The
 * figure below is researched, not inherited.
 */
export const EINVOICE_TURNOVER_THRESHOLD_MINOR = 5_000_000_000n;

export type EInvoiceThresholdPeriod = {
  /** Inclusive. `YYYY-MM-DD`. */
  readonly from: string;
  /** Exclusive, or null for "still current". Half-open, as everywhere. */
  readonly to: string | null;
  readonly thresholdMinor: bigint;
  readonly notificationRef: string;
};

/**
 * ⭐ THE THRESHOLD AS AT A DATE, BECAUSE AN INVOICE IS JUDGED BY THE RULE
 * IN FORCE ON ITS OWN DATE — the same principle as `resolveRateOn`. A
 * March 2022 invoice from a ₹15 crore business was notified; the same
 * business's March 2021 invoice was not, and re-deciding both against
 * today's ₹5 crore would mark a correctly-issued 2021 document as a
 * compliance breach.
 *
 * ⚠️ Dates are the DATES OF EFFECT, not the notification dates.
 */
export const EINVOICE_THRESHOLD_SCHEDULE: readonly EInvoiceThresholdPeriod[] =
  Object.freeze([
    Object.freeze({
      from: "2020-10-01",
      to: "2021-01-01",
      thresholdMinor: 500_000_000_000n,
      notificationRef: "Notification 61/2020 & 70/2020-Central Tax (₹500 crore)",
    }),
    Object.freeze({
      from: "2021-01-01",
      to: "2021-04-01",
      thresholdMinor: 100_000_000_000n,
      notificationRef: "Notification 88/2020-Central Tax (₹100 crore)",
    }),
    Object.freeze({
      from: "2021-04-01",
      to: "2022-04-01",
      thresholdMinor: 50_000_000_000n,
      notificationRef: "Notification 05/2021-Central Tax (₹50 crore)",
    }),
    Object.freeze({
      from: "2022-04-01",
      to: "2022-10-01",
      thresholdMinor: 20_000_000_000n,
      notificationRef: "Notification 01/2022-Central Tax (₹20 crore)",
    }),
    Object.freeze({
      from: "2022-10-01",
      to: "2023-08-01",
      thresholdMinor: 10_000_000_000n,
      notificationRef: "Notification 17/2022-Central Tax (₹10 crore)",
    }),
    Object.freeze({
      from: "2023-08-01",
      to: null,
      thresholdMinor: EINVOICE_TURNOVER_THRESHOLD_MINOR,
      notificationRef: "Notification 10/2023-Central Tax (₹5 crore)",
    }),
  ]);

export function thresholdOn(invoiceDate: string): EInvoiceThresholdPeriod | null {
  const day = invoiceDate.slice(0, 10);
  return (
    EINVOICE_THRESHOLD_SCHEDULE.find(
      (period) => day >= period.from && (period.to === null || day < period.to),
    ) ?? null
  );
}

/**
 * The NIC `SupTyp` vocabulary — what KIND of supply this is for
 * e-invoicing, which is not the same question as `gst_supply_type`
 * (goods / services / immovable property).
 *
 * ⚠️ `WP` IS "WITH PAYMENT" AND `WOP` IS "WITHOUT PAYMENT" — of IGST, on
 * a zero-rated supply. An exporter under a Letter of Undertaking pays no
 * IGST and files EXPWOP; one who pays IGST and claims a refund files
 * EXPWP. Sending the wrong one is a refund claim the portal will not
 * match.
 */
export type EInvoiceSupplyCategory =
  | "B2B"
  | "SEZWP"
  | "SEZWOP"
  | "EXPWP"
  | "EXPWOP"
  | "DEXP";

export type EInvoiceApplicability = {
  required: boolean;
  /** One sentence for the screen. Never just a boolean on its own. */
  reason: string;
  /** Which notification decided it, when the answer turned on turnover. */
  notificationRef: string | null;
  thresholdMinor: bigint | null;
};

/**
 * ⭐ IS AN IRN REQUIRED FOR THIS DOCUMENT?
 *
 * ⚠️ TWO INDEPENDENT TESTS, AND BOTH MUST PASS. Being above the turnover
 * threshold makes the SUPPLIER notified; it does not make every document
 * reportable. e-invoicing covers B2B, supplies to SEZ, exports and deemed
 * exports. A **B2C** invoice from a notified supplier needs NO IRN.
 *
 * ⚠️ AND A B2C INVOICE FROM A NOTIFIED SUPPLIER IS NOT UNREGULATED — it
 * needs a self-generated dynamic QR code under Rule 46(r) above ₹500
 * crore. That is a different rule with a different threshold and it is
 * NOT implemented here; it is named so nobody reads `required: false` as
 * "nothing to do".
 *
 * ⚠️ `aggregateTurnoverMinor` IS PAN-LEVEL AND HISTORICAL — the highest
 * aggregate turnover in ANY financial year from 2017-18 onwards, not this
 * year's, and not this GSTIN's. The caller owns that figure; this
 * function cannot compute it and does not pretend to. Passing `null`
 * yields `required: false` with a reason that says the turnover is
 * unknown, which is the honest answer and is deliberately not the same
 * sentence as "below the threshold".
 */
export function eInvoiceRequired(args: {
  aggregateTurnoverMinor: bigint | null;
  /** `YYYY-MM-DD`. The DOCUMENT'S date — never `new Date()`. */
  invoiceDate: string;
  supplyType: EInvoiceSupplyCategory;
  recipientRegistration: GstRegistrationType;
}): EInvoiceApplicability {
  const period = thresholdOn(args.invoiceDate);

  if (!period) {
    return {
      required: false,
      reason:
        `e-invoicing did not apply to anybody on ${args.invoiceDate.slice(0, 10)}. ` +
        `Rule 48(4) commenced on 1 October 2020.`,
      notificationRef: null,
      thresholdMinor: null,
    };
  }

  /**
   * ⚠️ THE RECIPIENT TEST COMES FIRST, and deliberately. A B2C document
   * is out of scope whatever the supplier's turnover, and answering
   * "below the threshold" for a ₹50 crore business's retail sale would be
   * a true sentence about the wrong reason — which is the kind of
   * explanation somebody acts on.
   */
  const isB2c =
    args.recipientRegistration === "unregistered" && args.supplyType === "B2B";

  if (isB2c) {
    return {
      required: false,
      reason:
        "This is a B2C supply, and e-invoicing under Rule 48(4) covers B2B, SEZ, " +
        "export and deemed-export documents only. ⚠️ A notified supplier above " +
        "₹500 crore still owes a dynamic QR code on B2C invoices under Rule " +
        "46(r) — a separate rule, not implemented here.",
      notificationRef: period.notificationRef,
      thresholdMinor: period.thresholdMinor,
    };
  }

  if (args.aggregateTurnoverMinor === null) {
    return {
      required: false,
      reason:
        "The workspace's aggregate turnover is not recorded, so whether Rule " +
        "48(4) applies cannot be decided. ⚠️ This is NOT the same as being below " +
        "the threshold: record the highest aggregate turnover in any financial " +
        "year from 2017-18 onwards before relying on this answer.",
      notificationRef: period.notificationRef,
      thresholdMinor: period.thresholdMinor,
    };
  }

  // ⚠️ STRICTLY GREATER THAN. Exactly at the threshold is not notified.
  const required = args.aggregateTurnoverMinor > period.thresholdMinor;

  return {
    required,
    reason: required
      ? `Aggregate turnover exceeds the threshold in force on ` +
        `${args.invoiceDate.slice(0, 10)}, so this document must carry an IRN. ` +
        `Rule 48(5): an invoice required to be issued under 48(4) and issued any ` +
        `other way is not an invoice, and the buyer cannot claim credit on it.`
      : `Aggregate turnover does not exceed the threshold in force on ` +
        `${args.invoiceDate.slice(0, 10)}. ⚠️ Applicability is a ratchet — it is ` +
        `decided on the HIGHEST turnover in ANY year from 2017-18 onwards, so a ` +
        `business that crossed the threshold once stays notified.`,
    notificationRef: period.notificationRef,
    thresholdMinor: period.thresholdMinor,
  };
}

/* ------------------------------------------------------------------ */
/* ② THE NIC PAYLOAD — SCHEMA 1.1                                      */
/* ------------------------------------------------------------------ */

export type EInvoiceItem = {
  /** Rule 46(g): the description that goes on the document. */
  productDescription: string;
  hsnCode: string;
  /** Decimal string. Quantities are not money and are not bigint. */
  quantity: string;
  unit: string;
  /** Paise. Unit price BEFORE discount. */
  unitPriceMinor: bigint;
  /** Paise. quantity × unit price, before discount. */
  grossAmountMinor: bigint;
  discountMinor: bigint;
  /** Paise. gross − discount. What tax is charged on. */
  assessableValueMinor: bigint;
  /** ⚠️ THE FULL RATE, not the halved one. See `GstRt` below. */
  gstRateBps: number;
  igstMinor: bigint;
  cgstMinor: bigint;
  sgstMinor: bigint;
  cessRateBps: number;
  cessMinor: bigint;
  /** assessable + all tax on this line. */
  totalItemValueMinor: bigint;
  isService: boolean;
};

export type EInvoicePayloadInput = {
  supplyCategory: EInvoiceSupplyCategory;
  /** Is the tax on this document payable on reverse charge? `Y`/`N`. */
  isReverseCharge: boolean;
  /** `INV` | `CRN` | `DBN`. */
  documentType: "INV" | "CRN" | "DBN";
  documentNumber: string;
  /** `YYYY-MM-DD` in, `dd/mm/yyyy` out. */
  documentDate: string;

  seller: {
    gstin: string;
    legalName: string;
    tradeName?: string | null;
    address1: string;
    address2?: string | null;
    location: string;
    pincode: number;
    stateCode: string;
    phone?: string | null;
    email?: string | null;
  };

  buyer: {
    /** ⚠️ `URP` for an unregistered recipient. See the comment on the field. */
    gstin: string | null;
    legalName: string;
    tradeName?: string | null;
    address1: string;
    address2?: string | null;
    location: string;
    pincode: number;
    /** ⭐ The PLACE OF SUPPLY, which is not always the buyer's state. */
    placeOfSupplyCode: string;
    stateCode: string;
    phone?: string | null;
    email?: string | null;
  };

  items: readonly EInvoiceItem[];

  totals: {
    assessableValueMinor: bigint;
    cgstMinor: bigint;
    sgstMinor: bigint;
    igstMinor: bigint;
    cessMinor: bigint;
    discountMinor: bigint;
    otherChargesMinor: bigint;
    roundOffMinor: bigint;
    totalInvoiceValueMinor: bigint;
  };
};

/** NIC wants dd/mm/yyyy, and will silently mis-read anything else. */
export function nicDate(value: string): string {
  const iso = value.slice(0, 10);
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) throw new EInvoiceError(`Not a date: ${value}`);
  return `${d}/${m}/${y}`;
}

/**
 * Paise → the rupees-with-two-decimals number the portal expects.
 *
 * ⚠️ THE PORTAL'S JSON IS RUPEES AND OURS IS PAISE, and this is the only
 * place the two meet. `Number()` is safe here for the same reason it is
 * safe in `formatMoney`: the value is leaving the system, not feeding
 * another computation. Guarded anyway — an invoice above 2^53 paise
 * (₹90 trillion) means something upstream is wrong, and a silently
 * rounded figure on a SIGNED document is the worst place to find out.
 */
function rupees(minor: bigint): number {
  if (minor > 9_007_199_254_740_991n || minor < -9_007_199_254_740_991n) {
    throw new EInvoiceError(
      `${minor} paise cannot be represented exactly as a JSON number. The IRP ` +
        `signs what it is sent, so an approximated figure would be signed too.`,
    );
  }
  return Number(minor) / 100;
}

/** Basis points → the percentage the portal expects. 1800 → 18. */
function percent(bps: number): number {
  return bps / 100;
}

/**
 * ⭐ THE NIC SCHEMA 1.1 PAYLOAD.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 `URP` IS NOT A PLACEHOLDER. IT IS THE ANSWER.
 * ══════════════════════════════════════════════════════════════════════
 * An unregistered counterparty is declared as the literal `URP`. An empty
 * string is rejected, and the instinct — leave it blank until somebody
 * supplies a GSTIN — is wrong for the whole class of documents that need
 * it. Same rule, same reason, as `lib/gst/eway.ts`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ `GstRt` IS THE FULL RATE, EVEN ON AN INTRA-STATE SUPPLY
 * ══════════════════════════════════════════════════════════════════════
 * An 18% intra-state line is `GstRt: 18` with `CgstAmt` and `SgstAmt` at
 * 9% each. Sending `GstRt: 9` — which is what "the rate that produced
 * CgstAmt" suggests — is rejected, because the IRP recomputes
 * `CgstAmt + SgstAmt` against `AssAmt × GstRt` and gets half.
 *
 * ⚠️ THIS BUILDS A PAYLOAD. IT DOES NOT SEND ONE. See `submitToIrp`.
 */
export function buildEInvoicePayload(
  input: EInvoicePayloadInput,
): Record<string, unknown> {
  if (input.items.length === 0) {
    throw new EInvoiceError(
      "An e-invoice with no items describes no supply. The IRP refuses it and " +
        "so does this.",
    );
  }

  return {
    Version: "1.1",

    /**
     * ⚠️ `RegRev` IS THE REVERSE-CHARGE FLAG AND IT IS `Y`/`N`, NOT A
     * BOOLEAN. `TaxSch` is always `GST` — the field exists because the
     * schema predates GST being the only scheme, and sending anything
     * else is rejected.
     */
    TranDtls: {
      TaxSch: "GST",
      SupTyp: input.supplyCategory,
      RegRev: input.isReverseCharge ? "Y" : "N",
      /**
       * ⚠️ `IgstOnIntra` IS NOT `Y` JUST BECAUSE IGST IS CHARGED. It is
       * the rare s.8 case of IGST deliberately charged on an intra-state
       * supply. Sending `Y` on an ordinary inter-state invoice makes the
       * portal expect a different head split and reject it.
       */
      IgstOnIntra: "N",
    },

    DocDtls: {
      Typ: input.documentType,
      No: input.documentNumber,
      Dt: nicDate(input.documentDate),
    },

    SellerDtls: {
      Gstin: input.seller.gstin,
      LglNm: input.seller.legalName,
      TrdNm: input.seller.tradeName ?? input.seller.legalName,
      Addr1: input.seller.address1,
      Addr2: input.seller.address2 ?? undefined,
      Loc: input.seller.location,
      Pin: input.seller.pincode,
      Stcd: input.seller.stateCode,
      Ph: input.seller.phone ?? undefined,
      Em: input.seller.email ?? undefined,
    },

    BuyerDtls: {
      Gstin: input.buyer.gstin ?? "URP",
      LglNm: input.buyer.legalName,
      TrdNm: input.buyer.tradeName ?? input.buyer.legalName,
      /**
       * ⭐ `Pos` IS THE PLACE OF SUPPLY, WHICH IS A LEGAL DETERMINATION
       * AND NOT THE BUYER'S ADDRESS. For a supply relating to immovable
       * property it is the PROPERTY'S state under s.12(3) — a Pune flat
       * sold to a Bengaluru company has `Pos: "27"` and `Stcd: "29"`, and
       * copying `Stcd` into `Pos` is the single most expensive default
       * available in an Indian billing system.
       */
      Pos: input.buyer.placeOfSupplyCode,
      Addr1: input.buyer.address1,
      Addr2: input.buyer.address2 ?? undefined,
      Loc: input.buyer.location,
      Pin: input.buyer.pincode,
      Stcd: input.buyer.stateCode,
      Ph: input.buyer.phone ?? undefined,
      Em: input.buyer.email ?? undefined,
    },

    ItemList: input.items.map((item, index) => ({
      /** ⚠️ 1-based and a STRING. `SlNo: 1` is rejected; `"1"` is not. */
      SlNo: String(index + 1),
      PrdDesc: item.productDescription,
      IsServc: item.isService ? "Y" : "N",
      HsnCd: item.hsnCode,
      Qty: Number(item.quantity),
      Unit: item.unit,
      UnitPrice: rupees(item.unitPriceMinor),
      TotAmt: rupees(item.grossAmountMinor),
      Discount: rupees(item.discountMinor),
      /** ⭐ The taxable value. gross − discount. */
      AssAmt: rupees(item.assessableValueMinor),
      /** ⭐ THE FULL RATE. See the header. */
      GstRt: percent(item.gstRateBps),
      IgstAmt: rupees(item.igstMinor),
      CgstAmt: rupees(item.cgstMinor),
      SgstAmt: rupees(item.sgstMinor),
      CesRt: percent(item.cessRateBps),
      CesAmt: rupees(item.cessMinor),
      TotItemVal: rupees(item.totalItemValueMinor),
    })),

    ValDtls: {
      AssVal: rupees(input.totals.assessableValueMinor),
      CgstVal: rupees(input.totals.cgstMinor),
      SgstVal: rupees(input.totals.sgstMinor),
      IgstVal: rupees(input.totals.igstMinor),
      CesVal: rupees(input.totals.cessMinor),
      Discount: rupees(input.totals.discountMinor),
      OthChrg: rupees(input.totals.otherChargesMinor),
      RndOffAmt: rupees(input.totals.roundOffMinor),
      TotInvVal: rupees(input.totals.totalInvoiceValueMinor),
    },
  };
}

/* ------------------------------------------------------------------ */
/* ③ VALIDATION — WHAT THE IRP REJECTS, CHECKED HERE FIRST             */
/* ------------------------------------------------------------------ */

export type EInvoiceFindingSeverity = "error" | "warning";

export type EInvoiceFinding = {
  severity: EInvoiceFindingSeverity;
  /** Dotted path into the payload, e.g. `ItemList[3].HsnCd`. */
  field: string;
  message: string;
  remedy: string;
};

/**
 * ⭐ CHECK LOCALLY WHAT THE IRP WOULD REJECT REMOTELY.
 *
 * The IRP's rejections arrive as codes against a payload the user never
 * saw — `2172: Duplicate IRN`, `2150: Invalid HSN code` — and they arrive
 * AT ISSUE, which is the worst moment: the invoice number has been
 * consumed from a consecutive series (Rule 46(b)), so a failed submission
 * either leaves a hole in the series or forces a re-use.
 *
 * ⚠️ THIS IS NOT A SCHEMA VALIDATOR AND DOES NOT TRY TO BE. It checks the
 * handful of things that are (a) cheap here and (b) expensive there. The
 * IRP's own validation stays authoritative — a payload with no findings
 * is not thereby guaranteed to be accepted, and this function's name says
 * "validate", not "will succeed".
 *
 * ⚠️ REUSES `describeGstinProblem` AND `minimumHsnDigits` RATHER THAN
 * RESTATING THEM. A second GSTIN validator that disagrees with the first
 * by one character is worse than no second validator.
 */
export function validateEInvoicePayload(
  payload: Record<string, unknown>,
  context?: { aggregateTurnoverMinor?: bigint | null },
): EInvoiceFinding[] {
  const findings: EInvoiceFinding[] = [];

  const seller = asRecord(payload.SellerDtls);
  const buyer = asRecord(payload.BuyerDtls);
  const items = Array.isArray(payload.ItemList) ? payload.ItemList : [];
  const totals = asRecord(payload.ValDtls);

  /* --- GSTIN shape -------------------------------------------------- */

  const sellerGstin = asString(seller?.Gstin);
  const sellerProblem = sellerGstin ? describeGstinProblem(sellerGstin) : null;
  if (!sellerGstin) {
    findings.push({
      severity: "error",
      field: "SellerDtls.Gstin",
      message: "The supplier's GSTIN is missing.",
      remedy:
        "The IRN is a hash of the supplier GSTIN, the document number, the " +
        "document type and the financial year. Without the GSTIN there is no IRN " +
        "to compute.",
    });
  } else if (sellerProblem) {
    findings.push({
      severity: "error",
      field: "SellerDtls.Gstin",
      message: sellerProblem.message,
      remedy: sellerProblem.remedy,
    });
  }

  const buyerGstin = asString(buyer?.Gstin);
  if (!buyerGstin) {
    findings.push({
      severity: "error",
      field: "BuyerDtls.Gstin",
      message: "The recipient's GSTIN field is empty.",
      remedy:
        'An unregistered recipient is declared as the literal "URP". An empty ' +
        "string is rejected by the portal.",
    });
  } else if (buyerGstin !== "URP") {
    const buyerProblem = describeGstinProblem(buyerGstin);
    if (buyerProblem) {
      findings.push({
        severity: "error",
        field: "BuyerDtls.Gstin",
        message: buyerProblem.message,
        remedy: buyerProblem.remedy,
      });
    }
  }

  /* --- ⭐ PLACE OF SUPPLY vs THE BUYER'S GSTIN ---------------------- */

  const pos = asString(buyer?.Pos);
  if (!pos || !isPlaceOfSupplyCode(pos)) {
    findings.push({
      severity: "error",
      field: "BuyerDtls.Pos",
      message: `"${pos ?? ""}" is not a place-of-supply code.`,
      remedy:
        "Two digits: a state code, or 96 for a supply outside India. The place " +
        "of supply decides IGST against CGST+SGST, and the total is the same " +
        "either way — which is exactly why a wrong one is not noticed until a " +
        "return is filed.",
    });
  } else if (buyerGstin && buyerGstin !== "URP") {
    const gstinState = stateCodeFromGstin(buyerGstin);
    /**
     * ⚠️ A MISMATCH IS A WARNING, NOT AN ERROR, AND THE DISTINCTION IS
     * THE WHOLE RULE. `Pos` legitimately differs from the buyer's
     * registered state: s.12(3) immovable property (the property's
     * state), s.10(1)(a) goods delivered elsewhere, s.12(9) passenger
     * transport. Refusing the mismatch outright would refuse the correct
     * answer for a real-estate developer's every invoice. Refusing to
     * MENTION it lets the generic "place of supply = customer's state"
     * default through silently, which is the same product's most
     * expensive bug. So: say it, and let the reader decide.
     */
    if (gstinState && gstinState !== pos && pos !== OVERSEAS_PLACE_OF_SUPPLY) {
      findings.push({
        severity: "warning",
        field: "BuyerDtls.Pos",
        message:
          `The place of supply is ${pos} but the recipient's GSTIN is registered ` +
          `in ${gstinState}.`,
        remedy:
          "That is correct for a supply relating to immovable property (s.12(3) " +
          "— the property's state decides) or for goods delivered in another " +
          "state (s.10(1)(a)). Confirm which rule applies; if neither does, the " +
          "place of supply is the recipient's registered state under s.12(2)(a).",
      });
    }
  }

  /* --- ⚠️ ITEM COUNT ------------------------------------------------ */

  if (items.length === 0) {
    findings.push({
      severity: "error",
      field: "ItemList",
      message: "There are no items on this document.",
      remedy: "An e-invoice with no line items describes no supply.",
    });
  }
  /**
   * ⚠️ 1,000 LINE ITEMS IS THE HARD CEILING on the IRP. A document above
   * it is not "slow to submit" — it is refused, and the fix is to split
   * the invoice, which changes the document number series and cannot be
   * done after the number has been issued.
   */
  if (items.length > 1000) {
    findings.push({
      severity: "error",
      field: "ItemList",
      message: `This document has ${items.length} line items; the IRP accepts 1000.`,
      remedy:
        "Split the supply across documents BEFORE issuing. After a number is " +
        "consumed from the series, splitting means a credit note and a reissue.",
    });
  }

  /* --- ⭐ HSN DIGIT COUNT BY TURNOVER -------------------------------- */

  const turnover = context?.aggregateTurnoverMinor ?? null;
  const requiredDigits = turnover === null ? null : minimumHsnDigits(turnover);

  items.forEach((raw, index) => {
    const item = asRecord(raw);
    const hsn = asString(item?.HsnCd) ?? "";
    if (!/^\d{2,8}$/.test(hsn)) {
      findings.push({
        severity: "error",
        field: `ItemList[${index}].HsnCd`,
        message: `"${hsn}" is not an HSN or SAC code.`,
        remedy:
          "HSN is 2, 4, 6 or 8 digits; SAC is six digits beginning 99. The rate " +
          "is resolved from the classification, so a line without a valid one " +
          "has no defensible rate.",
      });
      return;
    }
    /**
     * ⚠️ A MINIMUM, NEVER A MAXIMUM. Declaring MORE digits than required
     * is always accepted; declaring fewer is rejected at generation.
     * Notification 78/2020 — 6 digits above ₹5 crore for B2B, 4 below.
     * `minimumHsnDigits` is the repo's existing statement of the e-way
     * bill form of this rule and is reused rather than restated.
     */
    if (requiredDigits !== null && hsn.length < requiredDigits) {
      findings.push({
        severity: "error",
        field: `ItemList[${index}].HsnCd`,
        message:
          `HSN ${hsn} has ${hsn.length} digits; this turnover requires at least ` +
          `${requiredDigits}.`,
        remedy:
          "Declare the fuller classification. More digits than required is always " +
          "accepted; fewer is rejected at generation, with the invoice number " +
          "already consumed from the series.",
      });
    }
    if (requiredDigits === null) {
      findings.push({
        severity: "warning",
        field: `ItemList[${index}].HsnCd`,
        message:
          "The required HSN digit count could not be checked because the " +
          "workspace's aggregate turnover is not recorded.",
        remedy:
          "Record the aggregate turnover. Notification 78/2020 sets the minimum " +
          "digit count from it, and the portal rejects a short code.",
      });
    }
  });

  /* --- ⭐ THE TOTAL MUST BE THE SUM OF THE LINES -------------------- */

  /**
   * 🔴 THE IRP RECOMPUTES `TotInvVal` AND REJECTS A MISMATCH ABOVE ±1
   * RUPEE. That tolerance exists for rounding, not for arithmetic, and a
   * document that is out by more has a real defect — usually a discount
   * applied to the header and not to the lines.
   *
   * ⚠️ COMPARED IN PAISE, NOT RUPEES. The payload carries JSON numbers
   * (floats), and `0.1 + 0.2 !== 0.3`; summing sixty of them and
   * comparing to a sixty-first is how a correct document fails its own
   * check. Scaled to integers first, the comparison is exact.
   */
  const lineTotalPaise = items.reduce((sum, raw) => {
    const item = asRecord(raw);
    return sum + toPaise(item?.TotItemVal);
  }, 0n);

  const declaredPaise = toPaise(totals?.TotInvVal);
  const roundOffPaise = toPaise(totals?.RndOffAmt);
  const otherChargesPaise = toPaise(totals?.OthChrg);
  const expectedPaise = lineTotalPaise + otherChargesPaise + roundOffPaise;
  const difference =
    declaredPaise > expectedPaise
      ? declaredPaise - expectedPaise
      : expectedPaise - declaredPaise;

  if (items.length > 0 && difference > 100n) {
    findings.push({
      severity: "error",
      field: "ValDtls.TotInvVal",
      message:
        `The declared invoice value is ${rupees(declaredPaise)} but the lines, ` +
        `other charges and round-off add to ${rupees(expectedPaise)} — a ` +
        `difference of ${rupees(difference)}.`,
      remedy:
        "The IRP recomputes this and rejects a difference above ₹1. A gap larger " +
        "than rounding is usually a discount or a charge applied to the header " +
        "and not to the lines; put it on the lines, where the tax is computed.",
    });
  }

  /* --- Document identity -------------------------------------------- */

  const doc = asRecord(payload.DocDtls);
  const docNo = asString(doc?.No) ?? "";
  /**
   * ⚠️ RULE 46(b): 16 CHARACTERS, and the portal additionally refuses a
   * number beginning with `0`, `/` or `-`. `lib/gst/invoice-fields.ts`
   * states the length rule for the document; this states the portal's
   * extra restriction, which the document rule does not cover.
   */
  if (docNo.length === 0 || docNo.length > 16) {
    findings.push({
      severity: "error",
      field: "DocDtls.No",
      message: `A document number is 1–16 characters; this one has ${docNo.length}.`,
      remedy:
        "Rule 46(b) caps the series at 16 characters. Shorten the prefix rather " +
        "than the sequence — the sequence has to stay consecutive.",
    });
  } else if (/^[0/-]/.test(docNo)) {
    findings.push({
      severity: "error",
      field: "DocDtls.No",
      message: `The IRP refuses a document number beginning with "${docNo[0]}".`,
      remedy:
        'A number may not start with "0", "/" or "-". Change the series prefix ' +
        "before any number in it is issued — renumbering afterwards leaves a gap " +
        "an auditor is entitled to ask about.",
    });
  }

  return findings;
}

/* ------------------------------------------------------------------ */
/* ④ THE CANONICAL HASH                                                */
/* ------------------------------------------------------------------ */

/**
 * ⭐ A DETERMINISTIC FINGERPRINT OF THE PAYLOAD, FOR
 * `sales_invoices.einvoice_payload_hash` (char(64), `^[0-9a-f]{64}$`).
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY KEY-SORTED AND NOT `JSON.stringify(payload)`
 * ══════════════════════════════════════════════════════════════════════
 * `JSON.stringify` preserves INSERTION ORDER. Two payloads with identical
 * content, built by two code paths that assign fields in different
 * orders, produce different strings and therefore different hashes. A
 * fingerprint that changes when nothing changed is a fingerprint nobody
 * can act on: the drift alarm fires on every deploy and gets muted, and
 * then it is not there when the payload genuinely moves.
 *
 * ⚠️ `undefined` FIELDS ARE DROPPED, WHICH `JSON.stringify` ALSO DOES —
 * stated here because `buildEInvoicePayload` deliberately emits
 * `undefined` for absent optional blocks rather than `null`. The IRP
 * treats an omitted field and a null field differently, and so does this
 * hash: `Addr2: undefined` and `Addr2: null` are not the same payload.
 *
 * ⚠️ WHAT THE COLUMN BUYS TODAY, per SQL 0149 §6: drift becomes
 * DETECTABLE after a restore or a manual edit that bypassed the freeze
 * trigger. It is never verified against the IRP, because computing the
 * IRP's own canonical form is the IRP client's job.
 */
export function canonicalPayloadHash(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
}

/**
 * Key-sorted JSON. Exported because a diff of two canonical forms is what
 * a person actually wants when the hash says a payload moved — "the
 * hashes differ" is a fact, and the diff is the answer.
 *
 * ⚠️ ARRAY ORDER IS PRESERVED, DELIBERATELY. `ItemList[0]` is line 1 of
 * the invoice; sorting it would make two documents with the same lines in
 * a different order hash identically, and line order is part of the
 * document a customer received.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "null";

  if (typeof value === "bigint") {
    // ⚠️ AS A STRING. A bigint has no JSON representation, and coercing it
    // through Number would round the very figures the hash exists to pin.
    return JSON.stringify(value.toString());
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);

  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    const body = keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",");
    return `{${body}}`;
  }

  // Functions and symbols cannot appear in a payload built by this file.
  return "null";
}

/* ------------------------------------------------------------------ */
/* ⑤ THE NETWORK CALL, BEHIND A FLAG                                   */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE ENVIRONMENT FLAG THAT MUST BE SET BEFORE ANYTHING IS SUBMITTED.
 *
 * ⚠️ READ FROM `process.env` DIRECTLY, AND NOT ADDED TO `lib/env.ts`.
 * The environment catalogue is outside Track E's block; a catalogue entry
 * (and the matching `.env.example` line) for `ORDENCE_EINVOICE_IRP_ENABLED`
 * is requested in PATCH-REQUEST-E.md. Until it lands, an unset variable
 * behaves exactly as a false one — which is the safe direction and the
 * one the product ships in.
 */
export const EINVOICE_IRP_FLAG = "ORDENCE_EINVOICE_IRP_ENABLED";

export type IrpSubmission = {
  payload: Record<string, unknown>;
  /** The hash written to `sales_invoices.einvoice_payload_hash`. */
  payloadHash: string;
};

export type IrpResponse = {
  irn: string;
  ackNo: string;
  ackDate: string;
  signedQrCode: string;
};

/**
 * 🔴 NOT IMPLEMENTED, AND THAT IS THE POINT.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THERE IS A THROWING STUB RATHER THAN NOTHING AT ALL
 * ══════════════════════════════════════════════════════════════════════
 * The alternative to this function is that the first person who needs an
 * IRN writes a `fetch` inline in an action, with credentials from an env
 * var nobody catalogued, no idempotency, and no place to put the fact
 * that a second submission of the same document returns "duplicate IRN"
 * rather than a new one. This function is the named place that work goes,
 * with the constraints written down before anybody is in a hurry.
 *
 * ⚠️ AND IT REFUSES RATHER THAN NO-OPS. A stub that quietly returned a
 * fake IRN would put an unsigned document in front of a customer looking
 * exactly like a signed one, and the buyer's credit claim would fail at
 * their year end — months after anybody could connect it to this
 * function.
 *
 * WHAT AN IMPLEMENTATION MUST HANDLE, so it is not rediscovered:
 *
 *   · AUTHENTICATION is a GSP-issued token with a lifetime measured in
 *     hours, not an API key. It must be cached and refreshed, and the
 *     refresh must not stampede.
 *   · IDEMPOTENCY IS NOT OPTIONAL. The IRN is a hash of (GSTIN, document
 *     number, type, financial year), so a retry after a timeout returns
 *     error 2150 "Duplicate IRN" WITH the original IRN attached. That
 *     response is a SUCCESS and must be recorded as one — treating it as
 *     a failure is how a correctly-registered invoice ends up marked
 *     `failed` and reissued under a new number.
 *   · CANCELLATION IS 24 HOURS AND NOT A MINUTE MORE, and only with no
 *     active e-way bill. SQL 0149 §4 already refuses to RECORD a
 *     cancellation outside that window.
 *   · THE RESPONSE IS THE ONLY COPY. `Irn`, `AckNo`, `AckDt` and
 *     `SignedQRCode` must be written in the same transaction that marks
 *     the invoice `generated`, or a crash between the two loses an IRN
 *     that can never be reissued.
 */
export async function submitToIrp(_submission: IrpSubmission): Promise<IrpResponse> {
  const enabled = process.env[EINVOICE_IRP_FLAG];

  if (enabled !== "1" && enabled !== "true") {
    throw new EInvoiceError(
      `e-invoice submission is not enabled. ${EINVOICE_IRP_FLAG} is not set, and ` +
        `Ordence holds no IRP or GSP credentials. The payload and its hash have ` +
        `been built and can be uploaded to the portal by hand; the IRN, ` +
        `acknowledgement number and signed QR code that come back are recorded ` +
        `against the invoice. ⚠️ Do NOT mark an invoice as e-invoiced without ` +
        `them — Rule 48(5) says a document that should have carried an IRN and ` +
        `does not is not an invoice, and the buyer cannot claim credit on it.`,
    );
  }

  throw new EInvoiceError(
    `${EINVOICE_IRP_FLAG} is set, but no IRP client is implemented. Enabling the ` +
      `flag does not create credentials, a token cache, or the duplicate-IRN ` +
      `handling that makes a retry safe. See the comment above submitToIrp() for ` +
      `what an implementation has to handle, and PATCH-REQUEST-E.md for the ` +
      `environment catalogue entry this flag still needs.`,
  );
}

/* ------------------------------------------------------------------ */
/* PLUMBING                                                            */
/* ------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * A rupees JSON number → exact paise.
 *
 * ⚠️ `Math.round(x * 100)` AND NOT `BigInt(x * 100)`. The payload's
 * numbers are floats: `18.25 * 100` is 1824.9999999999998, and `BigInt`
 * of that throws rather than rounding. Rounding first is exact for every
 * value with two decimal places, which is every value this schema holds.
 */
function toPaise(value: unknown): bigint {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0n;
  return BigInt(Math.round(value * 100));
}
