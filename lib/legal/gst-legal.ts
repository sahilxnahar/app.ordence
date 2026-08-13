/**
 * Ordence — ⭐⭐⭐ WHO PAYS THE GST ON A LAWYER'S BILL
 * Version: v1.8.0-alpha
 *
 * Pure. No database, no clock. `today` is never read here — the only
 * date that matters is the recipient's turnover for the **preceding**
 * financial year, and the caller supplies it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE DEFECT THIS FILE EXISTS TO CORRECT
 * ══════════════════════════════════════════════════════════════════════
 * `raiseInvoiceFromTime`, shipped in v1.2.0, charges **18% forward, on
 * every invoice, unconditionally.**
 *
 * For an individual advocate or a firm of advocates that is wrong in
 * very nearly every case. Legal services are either
 *
 *   - **EXEMPT** — Notification 12/2017-Central Tax (Rate), Sr. No. 45; or
 *   - **REVERSE CHARGE** — Notification 13/2017-Central Tax (Rate),
 *     Sr. No. 2, where the **recipient** pays.
 *
 * ⚠️ **AN ADVOCATE ALMOST NEVER CHARGES FORWARD GST ON LEGAL SERVICES.**
 *
 * And getting it wrong is not symmetrical:
 *
 *   🔴 Charging tax that was not chargeable means money collected from a
 *      client as tax. **Section 76** requires every rupee collected as
 *      tax to be paid to the Government whether or not it was due — so
 *      the firm cannot simply keep it, and the client cannot claim the
 *      credit either, because the supplier had no authority to charge
 *      it. Both sides lose.
 *
 *   ⚠️ Not charging where forward charge did apply means the firm owes
 *      the tax out of the fee it already collected.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE STRUCTURE, WHICH IS EASIER THAN IT LOOKS
 * ══════════════════════════════════════════════════════════════════════
 * Ask three questions in this order:
 *
 *   1. **Is it a legal service at all?** An advocate who runs a training
 *      course, writes a column, or lets out office space is an ordinary
 *      supplier making an ordinary forward-charge supply. Entry 45 and
 *      entry 2 both only ever speak about *legal services*.
 *
 *   2. **Where is the recipient?** Entry 2 puts the liability on "any
 *      business entity located in the taxable territory". A client
 *      outside India is not one — that is an **export of service**,
 *      zero-rated under s.16 IGST Act, and the firm needs an LUT (or
 *      pays IGST and claims a refund).
 *
 *   3. **Who is the recipient?** Government, a non-business, a small
 *      business below the registration threshold, or another advocate —
 *      exempt. Anybody else — reverse charge.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT THIS FILE WILL NOT DECIDE FOR YOU
 * ══════════════════════════════════════════════════════════════════════
 * A **senior advocate** supplying to another advocate or firm of
 * advocates. Limb (i) of entry 45 — services to an advocate or firm of
 * advocates providing legal services — is written for the non-senior
 * case, and the senior-advocate limb of entry 45 does not repeat it.
 * The position has moved more than once since 2017.
 *
 * ⭐ So the verdict for that one combination is returned **flagged as
 * arguable, with the reasoning shown**, and the screen says so. It is
 * not resolved silently in either direction, because a silent answer to
 * a genuinely open question is the worst of the three options.
 */

export class LegalChargeError extends Error {}

/* ------------------------------------------------------------------ */
/* WHO IS SUPPLYING                                                    */
/* ------------------------------------------------------------------ */

export type LegalSupplierKind =
  /** An individual advocate enrolled under the Advocates Act 1961. */
  | "individual_advocate"
  /** Designated under s.16 of the Advocates Act. */
  | "senior_advocate"
  /** A partnership firm — or LLP — of advocates. */
  | "firm_of_advocates"
  /**
   * ⚠️ Anybody else billing for legal-ish work: a company secretary, a
   * consultancy, a legal-process outfit that is not a firm of advocates.
   * Entry 2 does not reach them and neither does entry 45.
   */
  | "not_an_advocate";

export const LEGAL_SUPPLIER_KINDS: readonly LegalSupplierKind[] = [
  "individual_advocate",
  "senior_advocate",
  "firm_of_advocates",
  "not_an_advocate",
] as const;

/* ------------------------------------------------------------------ */
/* WHAT IS BEING SUPPLIED                                              */
/* ------------------------------------------------------------------ */

export type LegalServiceKind =
  /**
   * "any service provided in relation to advice, consultancy or
   * assistance in any branch of law, in any manner" — the definition in
   * Notification 12/2017 itself.
   */
  | "advice"
  /** Appearing before a court, tribunal or authority. */
  | "representational"
  /**
   * ⚠️ Sitting AS an arbitral tribunal is a different entry — Sr. No. 3
   * of Notification 13/2017, not Sr. No. 2. Still reverse charge, but on
   * its own footing, and the exemption limbs differ.
   */
  | "arbitral_tribunal"
  /**
   * 🔴 Not a legal service. Training, writing, speaking, renting out the
   * chamber. Ordinary forward charge — and this is the case firms most
   * often misclassify, because the same person issues the bill.
   */
  | "not_a_legal_service";

export const LEGAL_SERVICE_KINDS: readonly LegalServiceKind[] = [
  "advice",
  "representational",
  "arbitral_tribunal",
  "not_a_legal_service",
] as const;

/* ------------------------------------------------------------------ */
/* WHO IS RECEIVING                                                    */
/* ------------------------------------------------------------------ */

export type LegalRecipientKind =
  /**
   * ⭐ A person who is NOT a business entity — an individual in a family
   * matter, a consumer, a person defending a criminal charge. The
   * Explanation to the notification is specific that "business entity"
   * means the litigant, applicant or petitioner itself.
   */
  | "not_a_business"
  /** A business entity: company, LLP, firm, proprietor, trust in business. */
  | "business_entity"
  /** Central or State Government, UT, local authority, governmental authority or entity. */
  | "government"
  /** Another advocate, or a firm of advocates, providing legal services. */
  | "advocate_or_firm";

export const LEGAL_RECIPIENT_KINDS: readonly LegalRecipientKind[] = [
  "not_a_business",
  "business_entity",
  "government",
  "advocate_or_firm",
] as const;

/* ------------------------------------------------------------------ */
/* THE REGISTRATION THRESHOLD, WHICH IS THE RECIPIENT'S, NOT YOURS     */
/* ------------------------------------------------------------------ */

/**
 * 🔴 THE THRESHOLD THAT MATTERS IS THE ONE IN THE **RECIPIENT'S** STATE.
 *
 * ⚠️ This is the single most-missed fact in the whole entry. The
 * exemption turns on whether the *client* was liable to register — so a
 * Mumbai firm billing a small business in Manipur applies **₹10 lakh**,
 * not ₹20 lakh, and a client just over ₹10 lakh in a special-category
 * State is on reverse charge while the same turnover in Maharashtra is
 * exempt.
 *
 * ⚠️ These are the thresholds for a supplier **of services**. The ₹40
 * lakh figure people quote is the goods-only threshold and has nothing
 * to do with this.
 */
export const THRESHOLD_STANDARD_MINOR = 2_000_000_00n; // ₹20,00,000
export const THRESHOLD_REDUCED_MINOR = 1_000_000_00n; // ₹10,00,000

/**
 * The States for which the reduced services threshold is not in doubt.
 * The proviso to s.22(1) applies to the special category States, and the
 * Explanation to it takes several of them back out again.
 */
export const REDUCED_THRESHOLD_STATE_CODES: readonly string[] = [
  "13", // Nagaland
  "14", // Manipur
  "15", // Mizoram
  "16", // Tripura
] as const;

/**
 * 🔴 STATES WHERE PUBLISHED SOURCES DISAGREE, AND ORDENCE SAYS SO.
 *
 * ⚠️ The special-category set for the **services registration
 * threshold** is not the Article 279A(4)(g) set: the Explanation to the
 * proviso to s.22(1) removes several States from it, and separately a
 * number of States exercised options in 2019 that are usually written up
 * as if they applied to services when they applied to goods. Reputable
 * sources published today still list these States both ways.
 *
 * ⭐ So Ordence does not pick. For a client in one of these States it
 * applies the ₹20 lakh figure — the one that produces reverse charge and
 * therefore never leaves tax uncollected — and **tells the firm to
 * confirm it**, because the wrong answer here decides whether a client
 * owes tax at all.
 */
export const THRESHOLD_CONTESTED_STATE_CODES: readonly string[] = [
  "02", // Himachal Pradesh
  "05", // Uttarakhand
  "11", // Sikkim
  "12", // Arunachal Pradesh
  "17", // Meghalaya
  "18", // Assam
  "34", // Puducherry
] as const;

export function thresholdMinorFor(args: {
  recipientStateCode?: string | null;
  /** ⭐ A tenant-supplied figure always wins. Thresholds move. */
  overrideMinor?: bigint | null;
}): bigint {
  if (args.overrideMinor !== null && args.overrideMinor !== undefined) {
    if (args.overrideMinor <= 0n) {
      throw new LegalChargeError("A registration threshold has to be positive.");
    }
    return args.overrideMinor;
  }
  const code = (args.recipientStateCode ?? "").trim();
  return REDUCED_THRESHOLD_STATE_CODES.includes(code)
    ? THRESHOLD_REDUCED_MINOR
    : THRESHOLD_STANDARD_MINOR;
}

/** ⚠️ True where the threshold for this State should be confirmed by hand. */
export function thresholdIsContested(args: {
  recipientStateCode?: string | null;
  overrideMinor?: bigint | null;
}): boolean {
  if (args.overrideMinor !== null && args.overrideMinor !== undefined) return false;
  return THRESHOLD_CONTESTED_STATE_CODES.includes((args.recipientStateCode ?? "").trim());
}

/* ------------------------------------------------------------------ */
/* THE VERDICT                                                         */
/* ------------------------------------------------------------------ */

export type ChargeBasis =
  /** Nil rated under Notification 12/2017 Sr. No. 45. No tax, either way. */
  | "exempt"
  /** 🔴 Recipient pays. Notification 13/2017 Sr. No. 2. Invoice carries no tax. */
  | "reverse_charge"
  /** The firm charges and pays the tax in the ordinary way. */
  | "forward_charge"
  /** Recipient outside India. Zero-rated under s.16 IGST Act. */
  | "export_zero_rated";

export type ChargeVerdict = {
  basis: ChargeBasis;
  /** The rate the INVOICE carries. Zero for everything except forward charge. */
  invoiceTaxRateBps: number;
  /** 🔴 Whether `sales_invoices.is_reverse_charge` must be set. */
  isReverseCharge: boolean;
  /** The statutory hook, named. */
  citation: string;
  /** Why, in a sentence a partner can check. */
  reason: string;
  /**
   * 🔴 Rule 46(p) — the invoice must state whether tax is payable on
   * reverse charge. This is the exact line to print.
   */
  invoiceDeclaration: string;
  /**
   * ⚠️ True where the answer is genuinely contested and the firm should
   * take its own view rather than the software's.
   */
  arguable: boolean;
  /** Set when `arguable`. What the argument actually is. */
  arguableNote?: string;
  /** ⭐ Anything the firm should be told even where the answer is clear. */
  notes: readonly string[];
};

const RCM_CITATION =
  "Notification 13/2017-Central Tax (Rate), Sr. No. 2 — read with s.9(3) CGST Act";
const EXEMPT_CITATION =
  "Notification 12/2017-Central Tax (Rate), Sr. No. 45 — nil rated";
const EXPORT_CITATION = "s.16 IGST Act 2017 — zero-rated supply";

const DECL_RCM = "Tax payable on reverse charge basis by the recipient.";
const DECL_NONE = "Tax is not payable on reverse charge basis.";

/**
 * ⭐⭐ THE DECISION.
 *
 * 🔴 Order matters. "Is it a legal service" comes before everything,
 * because an advocate's non-legal supply is an ordinary supply and none
 * of the rest of this applies to it.
 */
export function assessLegalCharge(args: {
  supplier: LegalSupplierKind;
  service: LegalServiceKind;
  recipient: LegalRecipientKind;
  /** Two-digit State code of the recipient. Absent for an overseas client. */
  recipientStateCode?: string | null;
  /** 🔴 True where the recipient is outside India — export of service. */
  recipientOutsideIndia?: boolean;
  /**
   * Aggregate turnover of the recipient in the **preceding** financial
   * year, in minor units. Null where it is not known — which is itself
   * an answer worth surfacing.
   */
  recipientTurnoverPrecedingFyMinor?: bigint | null;
  /** Tenant override of the registration threshold. */
  thresholdOverrideMinor?: bigint | null;
  /** The rate to charge where forward charge applies. Default 18%. */
  forwardRateBps?: number;
}): ChargeVerdict {
  const forwardRateBps = args.forwardRateBps ?? 1800;
  if (!Number.isInteger(forwardRateBps) || forwardRateBps < 0 || forwardRateBps > 10000) {
    throw new LegalChargeError("A tax rate must be an integer between 0 and 10000 bps.");
  }
  const notes: string[] = [];

  /* ---------------------------------------------------------------- */
  /* ① NOT A LEGAL SERVICE — ordinary forward charge, and stop.        */
  /* ---------------------------------------------------------------- */
  if (args.service === "not_a_legal_service") {
    return {
      basis: "forward_charge",
      invoiceTaxRateBps: forwardRateBps,
      isReverseCharge: false,
      citation: "Neither Notification 12/2017 Sr. No. 45 nor 13/2017 Sr. No. 2 applies",
      reason:
        "This is not a legal service. Both the exemption and the reverse charge entry speak only about legal services — advice, consultancy or assistance in a branch of law, and representation. Training, writing, speaking and letting out chambers are ordinary supplies by an ordinary supplier, and the firm charges and pays the tax itself.",
      invoiceDeclaration: DECL_NONE,
      arguable: false,
      notes: [
        "🔴 A firm whose outward legal supplies are all under reverse charge but which also makes forward-charge supplies like this one CANNOT rely on Notification 5/2017-Central Tax to stay unregistered. That relief is only for a person making supplies on which the whole of the tax is paid by the recipient.",
      ],
    };
  }

  /* ---------------------------------------------------------------- */
  /* ② NOT AN ADVOCATE — the entries do not reach the supplier at all. */
  /* ---------------------------------------------------------------- */
  if (args.supplier === "not_an_advocate") {
    return {
      basis: "forward_charge",
      invoiceTaxRateBps: forwardRateBps,
      isReverseCharge: false,
      citation: "Notification 13/2017 Sr. No. 2 applies only to an advocate or firm of advocates",
      reason:
        "Sr. No. 2 puts the liability on the recipient only where the supplier is an individual advocate, a senior advocate, or a firm of advocates. A consultancy, a company secretary, or a legal-process business supplying the same work in substance is outside the entry, charges tax in the ordinary way, and the exemption in Sr. No. 45 does not reach it either.",
      invoiceDeclaration: DECL_NONE,
      arguable: false,
      notes: [
        "⚠️ The entry turns on who the supplier IS, not on what the work looks like. An LLP of advocates is within it; an LLP of consultants doing the same drafting is not.",
      ],
    };
  }

  /* ---------------------------------------------------------------- */
  /* ③ RECIPIENT OUTSIDE INDIA — export, and entry 2 cannot apply.     */
  /* ---------------------------------------------------------------- */
  if (args.recipientOutsideIndia) {
    return {
      basis: "export_zero_rated",
      invoiceTaxRateBps: 0,
      isReverseCharge: false,
      citation: EXPORT_CITATION,
      reason:
        "Sr. No. 2 makes the tax payable by a business entity located in the taxable territory. A client outside India is not one, so there is nobody here to pay it under reverse charge. Where the place of supply is outside India and payment is received in convertible foreign exchange this is an export of service and zero-rated.",
      invoiceDeclaration: `${DECL_NONE} Supply meant for export of services under bond or Letter of Undertaking without payment of integrated tax.`,
      arguable: false,
      notes: [
        "🔴 Zero-rated is not the same as exempt. Export needs a Letter of Undertaking, or IGST paid and refunded — and the LUT is annual, so check it is the current year's.",
        "⚠️ The place of supply for legal services to a foreign client is the recipient's location under s.13(2) IGST Act — but only if it is a service in relation to that client generally. Representation in an Indian court for a foreign party is where people get caught, and the answer is not automatic.",
      ],
    };
  }

  /* ---------------------------------------------------------------- */
  /* ④ ARBITRAL TRIBUNAL — a different entry, and worth saying so.     */
  /* ---------------------------------------------------------------- */
  if (args.service === "arbitral_tribunal") {
    if (args.recipient === "not_a_business" || args.recipient === "government") {
      return {
        basis: "exempt",
        invoiceTaxRateBps: 0,
        isReverseCharge: false,
        citation: EXEMPT_CITATION,
        reason:
          "Services of an arbitral tribunal to a person other than a business entity, or to the Government or a local authority, are exempt on the same footing as legal services.",
        invoiceDeclaration: DECL_NONE,
        arguable: false,
        notes: [
          "⚠️ Sitting AS the tribunal is Sr. No. 3 of Notification 13/2017, not Sr. No. 2. Appearing BEFORE a tribunal as counsel is Sr. No. 2. The same person can do both in the same month.",
        ],
      };
    }
    return {
      basis: "reverse_charge",
      invoiceTaxRateBps: 0,
      isReverseCharge: true,
      citation:
        "Notification 13/2017-Central Tax (Rate), Sr. No. 3 — services of an arbitral tribunal",
      reason:
        "Services supplied by an arbitral tribunal to a business entity in the taxable territory are on reverse charge under Sr. No. 3. The tribunal issues an invoice carrying no tax and the business entity pays it.",
      invoiceDeclaration: DECL_RCM,
      arguable: false,
      notes: [
        "⚠️ This is Sr. No. 3, not Sr. No. 2. If the firm is also appearing as counsel in the same arbitration, that fee sits under Sr. No. 2 and should be billed separately — two entries, two lines, one file.",
      ],
    };
  }

  /* ---------------------------------------------------------------- */
  /* ⑤ THE EXEMPTION LIMBS.                                            */
  /* ---------------------------------------------------------------- */
  if (args.recipient === "government") {
    return {
      basis: "exempt",
      invoiceTaxRateBps: 0,
      isReverseCharge: false,
      citation: `${EXEMPT_CITATION} — limb covering the Government, local authority, governmental authority or Government entity`,
      reason:
        "Legal services to the Central or a State Government, a Union territory, a local authority, a governmental authority or a Government entity are exempt. There is no tax on this bill from either side.",
      invoiceDeclaration: DECL_NONE,
      arguable: false,
      notes: [
        "⚠️ A Government COMPANY is not automatically a governmental authority or a Government entity — the definitions turn on how it was set up and on the 90% participation test. A PSU client is usually a business entity on reverse charge, not an exempt one.",
      ],
    };
  }

  if (args.recipient === "not_a_business") {
    return {
      basis: "exempt",
      invoiceTaxRateBps: 0,
      isReverseCharge: false,
      citation: `${EXEMPT_CITATION} — limb covering any person other than a business entity`,
      reason:
        "The client is not a business entity, so the supply is exempt. The Explanation is specific that the business entity has to be the litigant, applicant or petitioner itself — an individual in a family, criminal, service or consumer matter is not one, whatever they do for a living.",
      invoiceDeclaration: DECL_NONE,
      arguable: false,
      notes: [
        "⭐ A proprietor sued personally over a business debt is the hard case. Look at who is on the cause title, not at whose money it is.",
      ],
    };
  }

  if (args.recipient === "advocate_or_firm") {
    if (args.supplier === "senior_advocate") {
      /**
       * 🔴 THE ONE COMBINATION THIS FILE REFUSES TO DECIDE.
       */
      return {
        basis: "reverse_charge",
        invoiceTaxRateBps: 0,
        isReverseCharge: true,
        citation: `${RCM_CITATION} — with the Sr. No. 45 senior-advocate limb in issue`,
        reason:
          "Ordence has taken reverse charge as the working answer, because it is the position that does not leave tax uncollected if it turns out to be right. It is not a confident answer.",
        invoiceDeclaration: DECL_RCM,
        arguable: true,
        arguableNote:
          "🔴 A SENIOR ADVOCATE BILLING ANOTHER ADVOCATE OR A FIRM OF ADVOCATES IS GENUINELY UNSETTLED. Sr. No. 45 exempts services to an advocate or firm of advocates providing legal services, but that limb sits in the part of the entry written for the non-senior case and is not repeated for senior advocates; the treatment of senior advocates has been amended more than once since 2017 and has been litigated. Take your own view on this one and record it — do not let the software decide it for you. Where the instructing firm is itself going to bill the lay client, the tax usually comes out in the wash; where it is not, it does not.",
        notes: [
          "⚠️ Whichever view the firm takes, take it consistently. A file where the same senior's fee is treated two ways in one year is the file that gets picked.",
        ],
      };
    }
    return {
      basis: "exempt",
      invoiceTaxRateBps: 0,
      isReverseCharge: false,
      citation: `${EXEMPT_CITATION} — limb covering an advocate or partnership firm of advocates providing legal services`,
      reason:
        "Legal services supplied to an advocate, or to a partnership firm of advocates, which is itself providing legal services, are exempt. This is what stops the tax stacking every time work is briefed down a chain.",
      invoiceDeclaration: DECL_NONE,
      arguable: false,
      notes: [
        "⚠️ The limb requires the recipient advocate to be PROVIDING legal services. An advocate instructing on his own personal dispute is receiving as an individual, not as an advocate — and that is exempt too, but under a different limb.",
      ],
    };
  }

  /* ---------------------------------------------------------------- */
  /* ⑥ A BUSINESS ENTITY — turnover decides.                           */
  /* ---------------------------------------------------------------- */
  const threshold = thresholdMinorFor({
    recipientStateCode: args.recipientStateCode,
    overrideMinor: args.thresholdOverrideMinor,
  });
  const contested = thresholdIsContested({
    recipientStateCode: args.recipientStateCode,
    overrideMinor: args.thresholdOverrideMinor,
  });
  if (contested) {
    notes.push(
      `🔴 CONFIRM THE THRESHOLD FOR THIS CLIENT'S STATE BY HAND. Published sources still disagree about whether the reduced ₹10,00,000 services threshold applies in this State — the Explanation to the proviso to s.22(1) takes several special category States back out, and the 2019 options that are usually quoted applied to goods. Ordence has used ${formatMinor(
        threshold,
      )}, which is the answer that never leaves tax uncollected, and it may be the wrong one for this client.`,
    );
  }
  const turnover = args.recipientTurnoverPrecedingFyMinor;

  if (turnover === null || turnover === undefined) {
    /**
     * ⚠️ NOT KNOWING IS NOT NEUTRAL. Assuming exempt costs the client an
     * RCM default; assuming reverse charge costs nothing if wrong,
     * because the client can simply not pay it and the firm has still
     * charged no tax. So the safe default is reverse charge — and the
     * screen says the figure is missing rather than pretending.
     */
    return {
      basis: "reverse_charge",
      invoiceTaxRateBps: 0,
      isReverseCharge: true,
      citation: RCM_CITATION,
      reason:
        "The client is a business entity, so the default is reverse charge and the invoice carries no tax. The exemption for a small business turns on the client's aggregate turnover in the preceding financial year, and that figure has not been recorded.",
      invoiceDeclaration: DECL_RCM,
      arguable: false,
      notes: [
        ...notes,
        `🔴 The client's turnover for the preceding financial year is not on file. Below ${formatMinor(threshold)} this supply would be EXEMPT and the client should not be paying anything under reverse charge. Ask, and record the answer.`,
        "⭐ The threshold that applies is the one in the CLIENT's State, not the firm's.",
      ],
    };
  }

  if (turnover < 0n) {
    throw new LegalChargeError("A turnover cannot be negative.");
  }

  if (turnover <= threshold) {
    return {
      basis: "exempt",
      invoiceTaxRateBps: 0,
      isReverseCharge: false,
      citation: `${EXEMPT_CITATION} — limb covering a business entity with turnover up to the registration threshold`,
      reason: `The client is a business entity whose aggregate turnover in the preceding financial year was ${formatMinor(
        turnover,
      )}, at or below the ${formatMinor(
        threshold,
      )} registration threshold applicable to it. The supply is exempt, and the client owes nothing under reverse charge.`,
      invoiceDeclaration: DECL_NONE,
      arguable: false,
      notes: [
        ...notes,
        "🔴 This is decided on the PRECEDING financial year. A client who crosses the threshold this year is still exempt on this year's bills and moves to reverse charge from 1 April.",
        `⭐ ${formatMinor(
          threshold,
        )} is the threshold for the client's State. A client in a special-category State crosses it at half the figure most people quote.`,
      ],
    };
  }

  return {
    basis: "reverse_charge",
    invoiceTaxRateBps: 0,
    isReverseCharge: true,
    citation: RCM_CITATION,
    reason: `The client is a business entity in the taxable territory whose aggregate turnover in the preceding financial year was ${formatMinor(
      turnover,
    )}, above the ${formatMinor(
      threshold,
    )} threshold. The tax is payable by the client under reverse charge. This invoice carries no tax.`,
    invoiceDeclaration: DECL_RCM,
    arguable: false,
    notes: [
        ...notes,
      "⭐ The client pays the tax and takes the credit for it. Legal services are not blocked under s.17(5), so for a client making taxable supplies this is cash-flow, not cost.",
      "⚠️ The firm still reports this supply — GSTR-1 table 4B, outward supplies attracting reverse charge. Leaving it out because no tax was charged is the most common way this goes wrong at the filing end.",
    ],
  };
}

/* ------------------------------------------------------------------ */
/* REGISTRATION — THE QUESTION EVERY NEW FIRM ASKS FIRST               */
/* ------------------------------------------------------------------ */

export type RegistrationVerdict = {
  mustRegister: boolean;
  reason: string;
  citation: string;
  notes: readonly string[];
};

/**
 * ⭐ A firm whose entire outward supply is legal services on reverse
 * charge is **not liable to register**, however large it is —
 * Notification 5/2017-Central Tax, issued under s.23(2).
 *
 * 🔴 ONE FORWARD-CHARGE SUPPLY DESTROYS THAT. A single seminar fee, one
 * arbitration where the firm sat as tribunal for a non-business, one
 * sub-let of the chamber — and the relief is gone, because it only ever
 * applied to a person making supplies *the whole of the tax on which* is
 * paid by the recipient.
 */
export function assessRegistrationNeed(args: {
  /** Does the firm make any supply on which IT would have to pay the tax? */
  hasForwardChargeSupplies: boolean;
  /** Aggregate turnover this year, all supplies, minor units. */
  aggregateTurnoverMinor: bigint;
  /** The firm's own State code. */
  ownStateCode?: string | null;
  thresholdOverrideMinor?: bigint | null;
  /** ⚠️ Any inter-State supply of GOODS forces registration under s.24. */
  makesInterStateSupplyOfGoods?: boolean;
}): RegistrationVerdict {
  const threshold = thresholdMinorFor({
    recipientStateCode: args.ownStateCode,
    overrideMinor: args.thresholdOverrideMinor,
  });

  if (args.makesInterStateSupplyOfGoods) {
    return {
      mustRegister: true,
      reason:
        "A person making an inter-State taxable supply of goods must register regardless of turnover.",
      citation: "s.24(i) CGST Act 2017",
      notes: [
        "⚠️ The compulsory-registration trigger in s.24(i) is for GOODS. Inter-State supply of SERVICES has its own relief up to the threshold — Notification 10/2017-Integrated Tax — which is why a firm briefed from another State does not have to register on that account alone.",
      ],
    };
  }

  if (!args.hasForwardChargeSupplies) {
    return {
      mustRegister: false,
      reason:
        "Every outward supply is one on which the whole of the tax is payable by the recipient under reverse charge, so the firm is exempt from registration whatever its turnover.",
      citation: "Notification 5/2017-Central Tax dated 19 June 2017, issued under s.23(2) CGST Act",
      notes: [
        "🔴 This relief survives exactly as long as the firm makes no forward-charge supply. One seminar fee, one column, one sub-let of the chamber, and it is gone from that day.",
        "⚠️ Not registering also means no input tax credit on the firm's own costs — rent, software, research subscriptions. That is a commercial choice, not a legal one, and it is usually the right one for a practice whose costs are mostly salaries.",
        "⭐ Exempt supplies do not affect this. A firm billing only individuals is making exempt supplies and is not liable to register under s.23(1)(a) either.",
      ],
    };
  }

  if (args.aggregateTurnoverMinor > threshold) {
    return {
      mustRegister: true,
      reason: `The firm makes forward-charge supplies and its aggregate turnover of ${formatMinor(
        args.aggregateTurnoverMinor,
      )} exceeds the ${formatMinor(threshold)} threshold.`,
      citation: "s.22(1) CGST Act 2017",
      notes: [
        "🔴 Aggregate turnover counts EXEMPT and reverse-charge outward supplies too — s.2(6). A firm with ₹5 crore of RCM legal fees and ₹1 lakh of seminar income is over the threshold on the ₹5 crore, and the ₹1 lakh is what takes away the Notification 5/2017 relief. Both halves have to be wrong at once, and they usually are.",
      ],
    };
  }

  return {
    mustRegister: false,
    reason: `The firm makes forward-charge supplies but its aggregate turnover of ${formatMinor(
      args.aggregateTurnoverMinor,
    )} is at or below the ${formatMinor(threshold)} threshold.`,
    citation: "s.22(1) CGST Act 2017",
    notes: [
      "⚠️ Aggregate turnover includes exempt and reverse-charge outward supplies. Check the figure above is the whole of them and not just the taxable part.",
    ],
  };
}

/* ------------------------------------------------------------------ */

/** ₹ with two decimals and Indian grouping. Minor units in. */
export function formatMinor(minor: bigint): string {
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString().padStart(3, "0");
  const whole = digits.slice(0, -2);
  const frac = digits.slice(-2);
  const lastThree = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest
    ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${lastThree}`
    : lastThree;
  return `${negative ? "-" : ""}₹${grouped}.${frac}`;
}
