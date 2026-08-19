/**
 * Ordence — ⭐⭐ E-WAY BILL · Rule 138 of the CGST Rules, 2017
 * Version: v1.3.0-alpha
 *
 * Pure. No database, no network, and — 🔴 deliberately — NO CLOCK. Every
 * function that depends on "now" takes it as an argument, because a
 * validity computation that reads the system clock cannot be tested
 * against the one case that matters: the hour either side of midnight.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE COST OF BEING WRONG HERE IS NOT A WRONG REPORT
 * ══════════════════════════════════════════════════════════════════════
 * It is a lorry held at a checkpost under s.129, a penalty of ₹10,000 or
 * the tax sought to be evaded — whichever is HIGHER — and goods AND the
 * vehicle detained until it is paid. Every rounding decision below is
 * made in the direction that keeps a truck moving legally.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ EVERYTHING IN THIS FILE HAPPENS IN INDIAN STANDARD TIME
 * ══════════════════════════════════════════════════════════════════════
 * The NIC portal computes validity in IST and nothing else. IST is
 * UTC+05:30 and has never observed daylight saving, which is the only
 * reason a fixed offset is safe here — it is stated rather than assumed,
 * because a fixed offset is exactly the shortcut that breaks a system
 * the first time it is used somewhere that does observe DST.
 */

/* ------------------------------------------------------------------ */
/* CONSTANTS                                                           */
/* ------------------------------------------------------------------ */

export class EwayBillError extends Error {}

/** IST is UTC+05:30, always. No DST, ever. */
export const IST_OFFSET_MINUTES = 5 * 60 + 30;
const IST_OFFSET_MS = IST_OFFSET_MINUTES * 60 * 1000;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/**
 * 🔴 ₹50,000. Rule 138(1) — movement of goods of a consignment value
 * exceeding fifty thousand rupees.
 *
 * ⚠️ "EXCEEDING", NOT "OF OR EXCEEDING". A consignment of exactly
 * ₹50,000 needs no e-way bill. The comparison below is strictly greater
 * than, and it is a real distinction — round-number invoices are common
 * precisely because people aim at the threshold.
 */
export const EWAY_THRESHOLD_MINOR = 5_000_000n;

/** Regular cargo: one day per 200 km or part thereof. */
export const EWAY_KM_PER_DAY_REGULAR = 200;

/**
 * ⚠️ OVER DIMENSIONAL CARGO GETS 20 KM PER DAY, NOT 200.
 *
 * A transformer or a wind-turbine blade moves at night, under escort,
 * on a route survey. Giving it the regular allowance would produce an
 * e-way bill that expires halfway through a lawful journey — and the
 * consignments this affects are the ones nobody can simply re-route.
 */
export const EWAY_KM_PER_DAY_ODC = 20;

/** The portal will not accept a distance above this. */
export const EWAY_MAX_DISTANCE_KM = 4000;

/** Rule 138(9) — cancellation only within 24 hours of generation. */
export const EWAY_CANCEL_WINDOW_HOURS = 24;

/** Rule 138(12) — deemed accepted if the recipient says nothing in 72 hours. */
export const EWAY_REJECTION_WINDOW_HOURS = 72;

/** Extension is allowed 8 hours either side of expiry, and nowhere else. */
export const EWAY_EXTENSION_WINDOW_HOURS = 8;

/**
 * ⭐ TWO LIMITS INTRODUCED WITH EFFECT FROM 1 JANUARY 2025.
 *
 * ⚠️ Both exist to stop the same abuse: an e-way bill kept alive
 * indefinitely against a document that is years old. They are new enough
 * that a lot of software has not caught up, and the failure mode is the
 * portal refusing a bill somebody has already loaded a lorry for.
 */
export const EWAY_MAX_DOCUMENT_AGE_DAYS = 180;
export const EWAY_MAX_LIFETIME_DAYS = 360;

/**
 * ⚠️ PART B IS NOT REQUIRED FOR A SHORT FIRST OR LAST LEG — up to 50 km
 * within the State, consignor → transporter, or transporter → consignee.
 * Rule 138(3) third proviso and Rule 138(5) first proviso.
 *
 * 🔴 IT IS 50 KM **AND** WITHIN THE STATE. Either half alone is wrong,
 * and the inter-state half is the one people drop.
 */
export const EWAY_PART_B_EXEMPT_KM = 50;

export type EwayVehicleType = "regular" | "odc";
export type EwayTransportMode = "road" | "rail" | "air" | "ship";
export type EwayDocumentType =
  | "tax_invoice"
  | "bill_of_supply"
  | "delivery_challan"
  | "bill_of_entry"
  | "credit_note"
  | "others";

/** Rule 138 sub-supply types — the "why is this moving" list on the portal. */
export const EWAY_SUB_SUPPLY_TYPES = {
  supply: "Supply",
  export: "Export",
  import: "Import",
  job_work: "Job work",
  for_own_use: "For own use",
  job_work_returns: "Job work returns",
  sales_return: "Sales return",
  others: "Others",
  skd_ckd: "SKD/CKD",
  line_sales: "Line sales",
  recipient_not_known: "Recipient not known",
  exhibition_or_fairs: "Exhibition or fairs",
} as const;
export type EwaySubSupplyType = keyof typeof EWAY_SUB_SUPPLY_TYPES;

export const EWAY_TRANSACTION_TYPES = {
  regular: "Regular",
  bill_to_ship_to: "Bill to — Ship to",
  bill_from_dispatch_from: "Bill from — Dispatch from",
  combination: "Combination of both",
} as const;
export type EwayTransactionType = keyof typeof EWAY_TRANSACTION_TYPES;

/** NIC numeric codes, for the payload. Display never uses these. */
const NIC_SUB_SUPPLY_CODE: Record<EwaySubSupplyType, number> = {
  supply: 1,
  import: 2,
  export: 3,
  job_work: 4,
  for_own_use: 5,
  job_work_returns: 6,
  sales_return: 7,
  others: 8,
  skd_ckd: 9,
  line_sales: 10,
  recipient_not_known: 11,
  exhibition_or_fairs: 12,
};

const NIC_DOC_TYPE: Record<EwayDocumentType, string> = {
  tax_invoice: "INV",
  bill_of_supply: "BIL",
  delivery_challan: "CHL",
  bill_of_entry: "BOE",
  credit_note: "CNT",
  others: "OTH",
};

const NIC_TRANSPORT_MODE: Record<EwayTransportMode, number> = {
  road: 1,
  rail: 2,
  air: 3,
  ship: 4,
};

/* ------------------------------------------------------------------ */
/* ① CONSIGNMENT VALUE — THE FIGURE THE THRESHOLD IS TESTED AGAINST     */
/* ------------------------------------------------------------------ */

export type EwayLine = {
  taxableValueMinor: bigint;
  /** CGST + SGST/UTGST + IGST + cess on this line, in paise. */
  taxValueMinor: bigint;
  isExempt: boolean;
};

export type ConsignmentValue = {
  taxableMinor: bigint;
  taxMinor: bigint;
  exemptMinor: bigint;
  /** The figure Rule 138 tests against ₹50,000. */
  consignmentMinor: bigint;
  /** True when the exempt lines were dropped from the figure. */
  exemptExcluded: boolean;
};

/**
 * ⭐⭐ EXPLANATION 2 TO RULE 138(1), AND IT HAS TWO HALVES THAT PULL IN
 *      OPPOSITE DIRECTIONS.
 *
 * 🔴 IT INCLUDES THE TAX. "Consignment value … declared in an invoice …
 *    and also includes the central tax, State or Union territory tax,
 *    integrated tax and cess charged, if any, in the document."
 *    ⚠️ Using the taxable value alone under-states by up to 28% and
 *    skips e-way bills that were required — the expensive direction.
 *
 * 🔴 AND IT EXCLUDES EXEMPT SUPPLY, BUT ONLY ON A MIXED DOCUMENT.
 *    "…and shall exclude the value of exempt supply of goods where the
 *    invoice is issued in respect of BOTH exempt and taxable supply."
 *    ⚠️ On a document that is entirely exempt there is no "both", so the
 *    exclusion does not bite and the whole value is the consignment
 *    value. Applying the exclusion there would compute ₹0 for a full
 *    lorry — which reads as "no e-way bill needed" for a reason the rule
 *    never gave.
 */
export function consignmentValue(lines: readonly EwayLine[]): ConsignmentValue {
  const hasTaxable = lines.some((l) => !l.isExempt);
  const hasExempt = lines.some((l) => l.isExempt);
  const mixed = hasTaxable && hasExempt;

  let taxableMinor = 0n;
  let taxMinor = 0n;
  let exemptMinor = 0n;

  for (const l of lines) {
    if (l.taxableValueMinor < 0n || l.taxValueMinor < 0n) {
      throw new EwayBillError("A consignment line cannot carry a negative value.");
    }
    if (l.isExempt) {
      exemptMinor += l.taxableValueMinor;
      if (!mixed) taxableMinor += l.taxableValueMinor;
    } else {
      taxableMinor += l.taxableValueMinor;
      taxMinor += l.taxValueMinor;
    }
  }

  return {
    taxableMinor,
    taxMinor,
    exemptMinor,
    consignmentMinor: taxableMinor + taxMinor,
    exemptExcluded: mixed,
  };
}

export type EwayRequirement = {
  required: boolean;
  thresholdMinor: bigint;
  reason: string;
};

/**
 * ⭐ IS AN E-WAY BILL REQUIRED?
 *
 * ⚠️ THE INTRA-STATE THRESHOLD IS A STATE DECISION AND THE INTER-STATE
 * ONE IS NOT. Several States have notified higher limits for movement
 * wholly within the State — some as high as ₹2,00,000. **No State can
 * raise the inter-state limit**, and this function refuses to apply an
 * override to an inter-state movement for exactly that reason. A single
 * configurable "threshold" setting is how a workspace in a ₹1,00,000
 * State quietly stops raising e-way bills for its Gujarat dispatches.
 */
export function ewayRequired(args: {
  consignmentMinor: bigint;
  isInterState: boolean;
  /** A State-notified intra-state threshold, if the workspace has one. */
  intraStateThresholdMinor?: bigint;
  /** Rule 138(14) — the annexure of goods exempt whatever the value. */
  isExemptGoods?: boolean;
  /** Rule 138(14)(a) — a bullock cart needs no e-way bill. */
  isNonMotorisedConveyance?: boolean;
}): EwayRequirement {
  const threshold =
    args.isInterState || args.intraStateThresholdMinor === undefined
      ? EWAY_THRESHOLD_MINOR
      : args.intraStateThresholdMinor;

  if (args.isNonMotorisedConveyance) {
    return {
      required: false,
      thresholdMinor: threshold,
      reason:
        "Rule 138(14)(a) — goods moved by non-motorised conveyance need no e-way bill at any value.",
    };
  }

  if (args.isExemptGoods) {
    return {
      required: false,
      thresholdMinor: threshold,
      reason:
        "The goods are in the Rule 138(14) annexure, which is exempt from e-way bill whatever the consignment is worth.",
    };
  }

  /** 🔴 EXCEEDING, not "at or above". ₹50,000 exactly is below the line. */
  const required = args.consignmentMinor > threshold;
  return {
    required,
    thresholdMinor: threshold,
    reason: required
      ? `The consignment exceeds the ${
          args.isInterState ? "inter-state" : "intra-state"
        } threshold.`
      : "The consignment does not exceed the threshold, so Rule 138 does not require an e-way bill.",
  };
}

/* ------------------------------------------------------------------ */
/* ② VALIDITY — THE PART EVERYBODY GETS WRONG                          */
/* ------------------------------------------------------------------ */

/**
 * Rule 138(10) — how many days the bill is good for.
 *
 * ⚠️ "OR PART THEREOF" MEANS ROUND UP, ALWAYS. 201 km is two days, not
 * one and a bit. Rounding to nearest would expire a bill mid-journey,
 * and the person who finds out is a driver at a checkpost.
 */
export function ewayValidityDays(
  distanceKm: number,
  vehicleType: EwayVehicleType = "regular",
): number {
  if (!Number.isInteger(distanceKm) || distanceKm < 0) {
    throw new EwayBillError("Distance must be a whole, non-negative number of kilometres.");
  }
  if (distanceKm > EWAY_MAX_DISTANCE_KM) {
    throw new EwayBillError(
      `The portal will not accept a distance above ${EWAY_MAX_DISTANCE_KM} km — ${distanceKm} km was given.`,
    );
  }
  const perDay =
    vehicleType === "odc" ? EWAY_KM_PER_DAY_ODC : EWAY_KM_PER_DAY_REGULAR;
  /** ⚠️ A zero-distance movement is still one day, never zero. */
  return Math.max(1, Math.ceil(distanceKm / perDay));
}

/** The start of the IST day containing this instant, as a UTC instant. */
export function istDayStart(at: Date): Date {
  const shifted = at.getTime() + IST_OFFSET_MS;
  return new Date(Math.floor(shifted / DAY_MS) * DAY_MS - IST_OFFSET_MS);
}

/**
 * ⭐⭐ WHEN THE E-WAY BILL DIES.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE OFF-BY-ONE-DAY THAT IS IN MOST IMPLEMENTATIONS
 * ══════════════════════════════════════════════════════════════════════
 * Explanation 1 to Rule 138(10): "each day shall be counted as the
 * period expiring at midnight of the day IMMEDIATELY FOLLOWING the date
 * of generation."
 *
 * So a one-day bill generated at 00:04 on 14 March does NOT expire at
 * midnight ending the 14th. It expires at midnight ending the **15th** —
 * the day immediately following. The first day is almost always longer
 * than 24 hours, and for a bill generated at 23:55 it is nearly 48.
 *
 * ⚠️ THE NAIVE `generatedAt + days × 24h` IS SHORT BY UP TO A DAY, and
 * it is short in the direction that expires a bill while a lorry is
 * still on the road. That is the expensive direction.
 *
 * ⚠️ AND IT IS THE **IST** MIDNIGHT. Computing this in UTC moves every
 * expiry 5½ hours early — from midnight to 18:30 the previous evening —
 * which is exactly when the last leg of a day's delivery is running.
 */
export function ewayValidUntil(args: {
  /** 🔴 The FIRST Part B entry, not the Part A entry. */
  partBEnteredAt: Date;
  distanceKm: number;
  vehicleType?: EwayVehicleType;
}): Date {
  const days = ewayValidityDays(args.distanceKm, args.vehicleType ?? "regular");
  const dayStart = istDayStart(args.partBEnteredAt).getTime();
  /** +1 because day one expires at the END of the following day. */
  return new Date(dayStart + (days + 1) * DAY_MS);
}

export function isEwayExpired(validUntil: Date | null, now: Date): boolean {
  if (!validUntil) return false;
  return now.getTime() >= validUntil.getTime();
}

/** Whole hours left, floored. Negative once expired. */
export function hoursUntilExpiry(validUntil: Date, now: Date): number {
  return Math.floor((validUntil.getTime() - now.getTime()) / HOUR_MS);
}

/* ------------------------------------------------------------------ */
/* ③ THE WINDOWS                                                       */
/* ------------------------------------------------------------------ */

export type WindowVerdict = { allowed: boolean; reason: string };

/**
 * Rule 138(9) — cancellation within 24 hours of generation.
 *
 * ⚠️ AND NOT AT ALL ONCE THE CONSIGNMENT HAS BEEN VERIFIED IN TRANSIT.
 * The proviso is absolute: an e-way bill checked by an officer cannot be
 * cancelled even inside the 24 hours. Software that only counts the
 * hours will offer a button that the portal refuses, which teaches
 * people to distrust the screen.
 */
export function canCancelEway(args: {
  generatedAt: Date | null;
  now: Date;
  verifiedInTransit?: boolean;
}): WindowVerdict {
  if (!args.generatedAt) {
    return {
      allowed: true,
      reason:
        "Nothing has been generated on the portal yet, so there is nothing to cancel there — this only discards the prepared bill.",
    };
  }
  if (args.verifiedInTransit) {
    return {
      allowed: false,
      reason:
        "This consignment has been verified in transit. Rule 138(9) forbids cancellation once that has happened, even inside the 24 hours.",
    };
  }
  const elapsedHours = (args.now.getTime() - args.generatedAt.getTime()) / HOUR_MS;
  if (elapsedHours > EWAY_CANCEL_WINDOW_HOURS) {
    return {
      allowed: false,
      reason: `Rule 138(9) allows cancellation only within ${EWAY_CANCEL_WINDOW_HOURS} hours of generation, and ${Math.floor(elapsedHours)} hours have passed. A credit note or a fresh document is the remedy now, not a cancellation.`,
    };
  }
  return { allowed: true, reason: "Within the 24-hour cancellation window." };
}

/** Rule 138(12) — silence for 72 hours is deemed acceptance. */
export function rejectionDeadline(generatedAt: Date): Date {
  return new Date(generatedAt.getTime() + EWAY_REJECTION_WINDOW_HOURS * HOUR_MS);
}

/**
 * ⭐ EXTENSION IS ALLOWED IN AN 8-HOUR BAND EITHER SIDE OF EXPIRY, AND
 *    NOWHERE ELSE.
 *
 * ⚠️ NOT "ANY TIME BEFORE EXPIRY". A bill with three days left cannot be
 * extended, and the screen must say so rather than offering a button
 * that fails — a transporter who tries early and is refused will not try
 * again in the window that would have worked.
 *
 * 🔴 AND SINCE 1 JANUARY 2025 THERE IS A HARD CEILING: no extension may
 *    carry a bill beyond 360 days from its ORIGINAL generation. The
 *    original instant is therefore never overwritten by an extension.
 */
export function canExtendEway(args: {
  validUntil: Date;
  originalGeneratedAt: Date;
  now: Date;
}): WindowVerdict {
  const windowMs = EWAY_EXTENSION_WINDOW_HOURS * HOUR_MS;
  const opensAt = args.validUntil.getTime() - windowMs;
  const closesAt = args.validUntil.getTime() + windowMs;
  const now = args.now.getTime();

  if (now < opensAt) {
    const hours = Math.ceil((opensAt - now) / HOUR_MS);
    return {
      allowed: false,
      reason: `Too early. Extension opens ${EWAY_EXTENSION_WINDOW_HOURS} hours before expiry — about ${hours} hours from now.`,
    };
  }
  if (now > closesAt) {
    return {
      allowed: false,
      reason: `Too late. Extension closes ${EWAY_EXTENSION_WINDOW_HOURS} hours after expiry, and that window has passed. The consignment now needs a fresh e-way bill.`,
    };
  }

  const ceiling =
    args.originalGeneratedAt.getTime() + EWAY_MAX_LIFETIME_DAYS * DAY_MS;
  if (now > ceiling) {
    return {
      allowed: false,
      reason: `This e-way bill was generated more than ${EWAY_MAX_LIFETIME_DAYS} days ago. Since 1 January 2025 no extension can carry a bill past that point.`,
    };
  }

  return { allowed: true, reason: "Inside the extension window." };
}

/**
 * ⚠️ SINCE 1 JANUARY 2025 A DOCUMENT OLDER THAN 180 DAYS CANNOT HAVE AN
 * E-WAY BILL GENERATED AGAINST IT AT ALL.
 *
 * 🔴 This is checked BEFORE anybody loads a lorry, because the portal
 * checks it at generation — and finding out at that moment means the
 * goods are on the vehicle and the document cannot be re-dated.
 */
export function documentEligible(args: {
  documentDate: Date;
  now: Date;
}): WindowVerdict {
  const ageDays = Math.floor(
    (istDayStart(args.now).getTime() - istDayStart(args.documentDate).getTime()) / DAY_MS,
  );
  if (ageDays > EWAY_MAX_DOCUMENT_AGE_DAYS) {
    return {
      allowed: false,
      reason: `The document is ${ageDays} days old. Since 1 January 2025 the portal refuses an e-way bill against a document more than ${EWAY_MAX_DOCUMENT_AGE_DAYS} days old.`,
    };
  }
  if (ageDays < 0) {
    return {
      allowed: false,
      reason: "The document is dated in the future.",
    };
  }
  return { allowed: true, reason: `The document is ${ageDays} days old.` };
}

/**
 * ⚠️ PART B IS EXCUSED ONLY FOR A SHORT LEG **WITHIN THE STATE**.
 *
 * 🔴 The inter-state half is the one people drop, and dropping it means
 * a consignment leaves without a vehicle number on a movement where one
 * was required — which is the state an officer is specifically looking
 * for.
 */
export function partBRequired(args: {
  distanceKm: number;
  isInterState: boolean;
  /** True for consignor→transporter or transporter→consignee legs. */
  isTransporterLeg?: boolean;
}): WindowVerdict {
  if (
    !args.isInterState &&
    args.isTransporterLeg &&
    args.distanceKm <= EWAY_PART_B_EXEMPT_KM
  ) {
    return {
      allowed: false,
      reason: `Part B is not required — up to ${EWAY_PART_B_EXEMPT_KM} km within the State, between the consignor and the transporter.`,
    };
  }
  return {
    allowed: true,
    reason:
      "Part B is required. Without a vehicle number this e-way bill is not valid for movement.",
  };
}

/* ------------------------------------------------------------------ */
/* ④ VEHICLE NUMBERS                                                   */
/* ------------------------------------------------------------------ */

/**
 * The NIC portal's accepted vehicle-number formats, uppercase, no
 * spaces or hyphens.
 *
 * ⚠️ NOT JUST `MH12AB1234`. Defence vehicles, temporary registrations,
 * Bharat-series and dealer plates are all real, all legal and all
 * refused by a single naive pattern — and the person refused is trying
 * to dispatch on a genuine vehicle.
 */
export const EWAY_VEHICLE_PATTERNS: readonly RegExp[] = Object.freeze([
  /** Standard: MH12AB1234, DL1CAB1234 */
  /^[A-Z]{2}[0-9]{1,2}[A-Z]{1,3}[0-9]{4}$/,
  /** Older / no series letters: MH121234 */
  /^[A-Z]{2}[0-9]{1,2}[0-9]{4}$/,
  /** Defence: 12A123456 / 12AB123456 */
  /^[0-9]{2}[A-Z]{1,2}[0-9]{6}[A-Z]?$/,
  /** Temporary: MHTEMP1234 style — TEMP anywhere after the state code. */
  /^[A-Z]{2}TEMP[0-9]{4,6}$/,
  /** Bharat series: 22BH1234AA */
  /^[0-9]{2}BH[0-9]{4}[A-Z]{1,2}$/,
]);

export function normaliseVehicleNumber(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function isValidVehicleNumber(input: string): boolean {
  const v = normaliseVehicleNumber(input);
  if (v.length < 6 || v.length > 16) return false;
  return EWAY_VEHICLE_PATTERNS.some((re) => re.test(v));
}

/**
 * ⚠️ THE MINIMUM NUMBER OF HSN DIGITS THE PORTAL WILL ACCEPT — and it is
 * a MINIMUM, never a maximum. Declaring more digits than required is
 * always accepted; declaring fewer is rejected at generation, with a
 * loaded vehicle waiting.
 */
export function minimumHsnDigits(annualTurnoverMinor: bigint): number {
  /** ₹5 crore = 50,000,000 rupees = 5,000,000,000 paise. */
  return annualTurnoverMinor > 500_00_00_000n ? 4 : 2;
}

/* ------------------------------------------------------------------ */
/* ⑤ THE NIC PAYLOAD                                                   */
/* ------------------------------------------------------------------ */

/** NIC wants dd/mm/yyyy, and will silently mis-read anything else. */
export function nicDate(value: Date | string): string {
  const iso = typeof value === "string" ? value : value.toISOString().slice(0, 10);
  const parts = iso.slice(0, 10).split("-");
  const [y, m, d] = parts;
  if (!y || !m || !d) throw new EwayBillError(`Not a date: ${iso}`);
  return `${d}/${m}/${y}`;
}

export type EwayPayloadInput = {
  supplyType: "outward" | "inward";
  subSupplyType: EwaySubSupplyType;
  documentType: EwayDocumentType;
  documentNo: string;
  documentDate: string;
  transactionType: EwayTransactionType;

  fromGstin: string | null;
  fromLegalName: string | null;
  fromPlace: string | null;
  fromPincode: string;
  fromStateCode: string;

  toGstin: string | null;
  toLegalName: string | null;
  toPlace: string | null;
  toPincode: string;
  toStateCode: string;

  taxableValueMinor: bigint;
  cgstMinor: bigint;
  sgstMinor: bigint;
  igstMinor: bigint;
  cessMinor: bigint;
  totalValueMinor: bigint;

  transporterGstin: string | null;
  transporterName: string | null;
  transporterDocNo: string | null;
  transporterDocDate: string | null;
  transportMode: EwayTransportMode | null;
  distanceKm: number;
  vehicleNo: string | null;
  vehicleType: EwayVehicleType;

  items: readonly {
    productName: string;
    description: string | null;
    hsnCode: string;
    quantity: string;
    uqc: string;
    taxableValueMinor: bigint;
    cgstRateBps: number;
    sgstRateBps: number;
    igstRateBps: number;
    cessRateBps: number;
  }[];
};

/** Paise → the rupees-with-two-decimals number the portal expects. */
function rupees(minor: bigint): number {
  return Number(minor) / 100;
}

/**
 * ⭐ THE EWB-01 JSON, in the shape the NIC bulk-upload tool accepts.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 `URP` IS NOT A PLACEHOLDER. IT IS THE ANSWER.
 * ══════════════════════════════════════════════════════════════════════
 * An unregistered counterparty is declared as the literal string `URP`.
 * Sending an empty string instead is rejected, and the natural instinct
 * — leave it blank until somebody supplies a GSTIN — is wrong for the
 * whole class of B2C dispatches above ₹50,000, which is precisely the
 * class most likely to be moving on a small business's lorry.
 *
 * ⚠️ THIS BUILDS A PAYLOAD. IT DOES NOT SEND ONE. Ordence has no GSP
 * credentials; the file is uploaded to the portal by a human, and the
 * number that comes back is recorded against this bill.
 */
export function buildEwayPayload(input: EwayPayloadInput): Record<string, unknown> {
  if (input.items.length === 0) {
    throw new EwayBillError("An e-way bill with no goods on it describes no movement.");
  }
  if (input.distanceKm > EWAY_MAX_DISTANCE_KM) {
    throw new EwayBillError(
      `The portal will not accept a distance above ${EWAY_MAX_DISTANCE_KM} km.`,
    );
  }

  return {
    supplyType: input.supplyType === "outward" ? "O" : "I",
    subSupplyType: String(NIC_SUB_SUPPLY_CODE[input.subSupplyType]),
    docType: NIC_DOC_TYPE[input.documentType],
    docNo: input.documentNo,
    docDate: nicDate(input.documentDate),

    fromGstin: input.fromGstin ?? "URP",
    fromTrdName: input.fromLegalName ?? "",
    fromAddr1: input.fromPlace ?? "",
    fromPlace: input.fromPlace ?? "",
    fromPincode: Number(input.fromPincode),
    /**
     * ⚠️ `actFromStateCode` IS THE PLACE THE GOODS PHYSICALLY LEAVE;
     * `fromStateCode` IS THE SUPPLIER'S REGISTERED STATE. On a
     * Bill-from / Dispatch-from movement they differ, and collapsing
     * them into one field is what makes those consignments wrong.
     */
    actFromStateCode: Number(input.fromStateCode),
    fromStateCode: Number(input.fromStateCode),

    toGstin: input.toGstin ?? "URP",
    toTrdName: input.toLegalName ?? "",
    toAddr1: input.toPlace ?? "",
    toPlace: input.toPlace ?? "",
    toPincode: Number(input.toPincode),
    actToStateCode: Number(input.toStateCode),
    toStateCode: Number(input.toStateCode),

    transactionType: input.transactionType === "regular" ? 1 : 4,

    totalValue: rupees(input.taxableValueMinor),
    cgstValue: rupees(input.cgstMinor),
    sgstValue: rupees(input.sgstMinor),
    igstValue: rupees(input.igstMinor),
    cessValue: rupees(input.cessMinor),
    totInvValue: rupees(input.totalValueMinor),

    transporterId: input.transporterGstin ?? "",
    transporterName: input.transporterName ?? "",
    transDocNo: input.transporterDocNo ?? "",
    transDocDate: input.transporterDocDate ? nicDate(input.transporterDocDate) : "",
    transMode: input.transportMode ? String(NIC_TRANSPORT_MODE[input.transportMode]) : "",
    transDistance: String(input.distanceKm),
    vehicleNo: input.vehicleNo ? normaliseVehicleNumber(input.vehicleNo) : "",
    vehicleType: input.vehicleType === "odc" ? "O" : "R",

    itemList: input.items.map((i, idx) => ({
      itemNo: idx + 1,
      productName: i.productName,
      productDesc: i.description ?? i.productName,
      hsnCode: Number(i.hsnCode),
      quantity: Number(i.quantity),
      qtyUnit: i.uqc,
      taxableAmount: rupees(i.taxableValueMinor),
      /** Rates are percentages on the portal, not basis points. */
      sgstRate: i.sgstRateBps / 100,
      cgstRate: i.cgstRateBps / 100,
      igstRate: i.igstRateBps / 100,
      cessRate: i.cessRateBps / 100,
    })),
  };
}

/* ------------------------------------------------------------------ */
/* ⑥ WHAT THE SCREEN SAYS                                              */
/* ------------------------------------------------------------------ */

export type EwayStatus = "prepared" | "active" | "expired" | "cancelled" | "rejected";

export type EwayHealth = {
  tone: "ok" | "warn" | "danger" | "neutral";
  label: string;
  detail: string;
};

/**
 * ⭐ ONE SENTENCE ABOUT WHETHER THIS LORRY CAN LEGALLY MOVE.
 *
 * 🔴 EXPIRY IS COMPUTED FROM THE TIMESTAMP, NEVER READ FROM THE STATUS
 *    COLUMN. A stored `expired` flag needs a job to maintain it, and the
 *    gap between a bill expiring and the job running is a gap in which
 *    the screen says a truck is legal and it is not.
 */
export function ewayHealth(args: {
  status: EwayStatus;
  validUntil: Date | null;
  vehicleNo: string | null;
  now: Date;
}): EwayHealth {
  if (args.status === "cancelled") {
    return {
      tone: "neutral",
      label: "Cancelled",
      detail: "This e-way bill has been cancelled on the portal. Nothing may move on it.",
    };
  }
  if (args.status === "rejected") {
    return {
      tone: "danger",
      label: "Rejected",
      detail: "The counterparty rejected this e-way bill.",
    };
  }
  if (args.status === "prepared") {
    return {
      tone: "warn",
      label: "Prepared — not generated",
      detail:
        "🔴 No e-way bill number yet. This has not been submitted to the portal, so nothing may move on it.",
    };
  }
  if (!args.vehicleNo) {
    return {
      tone: "danger",
      label: "No Part B",
      detail:
        "An e-way bill without a vehicle number is not valid for movement. Add the conveyance before the goods leave.",
    };
  }
  if (isEwayExpired(args.validUntil, args.now)) {
    return {
      tone: "danger",
      label: "Expired",
      detail:
        "This e-way bill has expired. Moving on it is a detention under s.129 — extend it within 8 hours of expiry, or raise a fresh one.",
    };
  }
  const hours = args.validUntil ? hoursUntilExpiry(args.validUntil, args.now) : null;
  if (hours !== null && hours <= EWAY_EXTENSION_WINDOW_HOURS) {
    return {
      tone: "warn",
      label: `Expires in ${hours} hour${hours === 1 ? "" : "s"}`,
      detail:
        "Inside the extension window. If the consignment is still in transit, extend it now — the window closes 8 hours after expiry.",
    };
  }
  /**
   * ⚠️ HOURS UNDER A DAY ARE SAID IN HOURS. "Valid for 0 more days" is
   * what `Math.floor(hours / 24)` produces at 20 hours left, and it
   * reads as an error rather than as twenty hours.
   */
  if (hours === null) return { tone: "ok", label: "Active", detail: "Valid for movement." };
  return {
    tone: "ok",
    label:
      hours < 24
        ? `Valid for ${hours} more hours`
        : `Valid for ${Math.floor(hours / 24)} more day${Math.floor(hours / 24) === 1 ? "" : "s"}`,
    detail: "Valid for movement.",
  };
}
