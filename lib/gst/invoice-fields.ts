/**
 * Ordence — Rule 46 Tax Invoice Fields
 * Version: v0.32.0-alpha
 *
 * Pure. Takes an invoice-shaped object and reports what Rule 46 of the
 * CGST Rules requires and this document does not have.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THIS EXTENDS PHASE 16, IT DOES NOT REPLACE IT
 * ══════════════════════════════════════════════════════════════════════
 * `invoices` and `invoice_lines` already exist and already carry the
 * customer's GSTIN, the place of supply, the legal name, the address, the
 * SAC code and the three tax heads. Phase 32 adds the columns Rule 46
 * needs and Phase 11 had no reason to have — our own GSTIN and state, the
 * supply type, the property's state, the reverse-charge flag, cess — and
 * this file is the checker over the union of the two.
 *
 * ⚠️ IT REPORTS, IT DOES NOT REFUSE. A DRAFT invoice is legitimately
 * incomplete — that is what a draft is. The refusal belongs at ISSUE, and
 * the issue path calls this and treats a non-empty `blocking` list as
 * fatal. A checker that threw would make the draft screen unusable.
 */

import { financialYearOf } from "./constants";
import type { GstSupplyType, GstRegistrationType } from "@/db/schema/gst";

/* ------------------------------------------------------------------ */
/* THE DOCUMENT, AS RULE 46 SEES IT                                    */
/* ------------------------------------------------------------------ */

export type Rule46Line = {
  description: string;
  /** Rule 46(g). HSN for goods, SAC for services. */
  hsnSacCode: string | null;
  quantity: number | null;
  /** Rule 46(g) again — the quantity is meaningless without its unit. */
  uqc: string | null;
  taxableMinor: bigint;
  rateBps: number;
};

export type Rule46Document = {
  /** Rule 46(b). */
  invoiceNumber: string;
  /** Rule 46(c). */
  issuedAt: Date | string | null;

  /** Rule 46(a) — ours. */
  supplierLegalName: string | null;
  supplierGstin: string | null;
  supplierStateCode: string | null;
  supplierAddress: Record<string, unknown> | null;

  /** Rule 46(d)/(e)/(f) — theirs. */
  recipientLegalName: string | null;
  recipientGstin: string | null;
  recipientRegistration: GstRegistrationType;
  recipientAddress: Record<string, unknown> | null;
  recipientStateCode: string | null;

  supplyType: GstSupplyType;
  /** Rule 46(n) — required for an inter-state supply. */
  placeOfSupplyCode: string | null;
  /** ⭐ Phase 32. Where the flat is. */
  propertyStateCode: string | null;
  isInterState: boolean;

  /** Rule 46(p). */
  isReverseCharge: boolean;

  /** Rule 46(o) — delivery address, when it differs from the place of supply. */
  deliveryAddress: Record<string, unknown> | null;

  /** Rule 46(q) — a signature or a digital signature. */
  signedBy: string | null;

  totalMinor: bigint;
  lines: readonly Rule46Line[];
};

export type Rule46Finding = {
  /** The clause, so the message can be checked against the Rules. */
  rule: string;
  field: string;
  message: string;
  remedy: string;
};

export type Rule46Report = {
  ok: boolean;
  /** Must be fixed before the invoice may be issued. */
  blocking: Rule46Finding[];
  /** Worth fixing; will not stop the document being valid. */
  advisory: Rule46Finding[];
  financialYear: string | null;
};

/* ------------------------------------------------------------------ */
/* LIMITS                                                              */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ SIXTEEN CHARACTERS, AND `invoices.invoice_number` IS varchar(60).
 *
 * Rule 46(b): "a consecutive serial number not exceeding sixteen
 * characters, in one or multiple series, containing alphabets or numerals
 * or special characters hyphen or dash and slash… unique for a financial
 * year".
 *
 * The Phase 11 column is wider than the rule allows because it was built
 * for a SaaS subscription number nobody files. Narrowing it now would
 * break invoices already issued, so the rule is enforced HERE and the
 * column stays wide. The consequence of ignoring it is concrete: the
 * GSTN portal truncates or rejects the row at GSTR-1 upload.
 */
export const MAX_INVOICE_NUMBER_LENGTH = 16;
const INVOICE_NUMBER_PATTERN = /^[A-Za-z0-9/-]+$/;

/**
 * Rule 46(f): for an UNREGISTERED recipient, the name, address and state
 * must appear once the taxable value passes ₹50,000.
 */
export const B2C_ADDRESS_THRESHOLD_MINOR = 5_000_000n;

/* ------------------------------------------------------------------ */
/* THE CHECK                                                           */
/* ------------------------------------------------------------------ */

export function checkRule46(doc: Rule46Document): Rule46Report {
  const blocking: Rule46Finding[] = [];
  const advisory: Rule46Finding[] = [];

  /* --- (a) supplier ------------------------------------------------ */
  if (!doc.supplierLegalName?.trim()) {
    blocking.push({
      rule: "46(a)",
      field: "supplierLegalName",
      message: "The invoice does not name us.",
      remedy: "Set the legal name on the GST registration this is issued under.",
    });
  }
  if (!doc.supplierGstin?.trim()) {
    blocking.push({
      rule: "46(a)",
      field: "supplierGstin",
      message: "The invoice does not carry our GSTIN.",
      remedy:
        "Pick the GST registration this document is issued under. A tax invoice " +
        "without the supplier's GSTIN is not a tax invoice, and the buyer cannot " +
        "claim credit against it.",
    });
  }
  if (!doc.supplierAddress || Object.keys(doc.supplierAddress).length === 0) {
    advisory.push({
      rule: "46(a)",
      field: "supplierAddress",
      message: "No principal place of business is recorded for this registration.",
      remedy: "Add the address from the registration certificate.",
    });
  }

  /* --- (b) number -------------------------------------------------- */
  const number = doc.invoiceNumber?.trim() ?? "";
  if (!number) {
    blocking.push({
      rule: "46(b)",
      field: "invoiceNumber",
      message: "The invoice has no number.",
      remedy: "Issue it through the numbering sequence rather than by hand.",
    });
  } else {
    if (number.length > MAX_INVOICE_NUMBER_LENGTH) {
      blocking.push({
        rule: "46(b)",
        field: "invoiceNumber",
        message: `The invoice number is ${number.length} characters; Rule 46(b) allows at most ${MAX_INVOICE_NUMBER_LENGTH}.`,
        remedy:
          "Shorten the series prefix. The GSTN portal rejects or truncates a " +
          "longer serial at GSTR-1 upload, and a truncated serial collides with " +
          "another invoice.",
      });
    }
    if (!INVOICE_NUMBER_PATTERN.test(number)) {
      blocking.push({
        rule: "46(b)",
        field: "invoiceNumber",
        message: "The invoice number contains characters Rule 46(b) does not allow.",
        remedy: "Only letters, digits, hyphen and slash are permitted.",
      });
    }
  }

  /* --- (c) date ---------------------------------------------------- */
  if (!doc.issuedAt) {
    blocking.push({
      rule: "46(c)",
      field: "issuedAt",
      message: "The invoice has no date.",
      remedy:
        "⚠️ The date is not decoration here — it is what the GST RATE is " +
        "resolved on, and what the return period is decided by.",
    });
  }

  /* --- (d)(e)(f) recipient ----------------------------------------- */
  const isRegistered =
    doc.recipientRegistration === "regular" ||
    doc.recipientRegistration === "composition" ||
    doc.recipientRegistration === "sez";

  if (!doc.recipientLegalName?.trim()) {
    blocking.push({
      rule: "46(d)",
      field: "recipientLegalName",
      message: "The invoice does not name the buyer.",
      remedy: "Record the buyer's name as it appears on their registration or ID.",
    });
  }

  if (isRegistered && !doc.recipientGstin?.trim()) {
    blocking.push({
      rule: "46(e)",
      field: "recipientGstin",
      message: "The buyer is registered but the invoice carries no GSTIN for them.",
      remedy:
        "Enter their GSTIN. Without it the supply is reported as B2C and they " +
        "cannot claim the input credit — which they will discover at their own " +
        "year end, long after paying.",
    });
  }

  if (!isRegistered && doc.totalMinor >= B2C_ADDRESS_THRESHOLD_MINOR) {
    if (!doc.recipientAddress || Object.keys(doc.recipientAddress).length === 0) {
      blocking.push({
        rule: "46(f)",
        field: "recipientAddress",
        message:
          "This is an unregistered supply over ₹50,000, so the buyer's address is required on the face of the invoice.",
        remedy: "Record the buyer's delivery address and state.",
      });
    }
    if (!doc.recipientStateCode) {
      blocking.push({
        rule: "46(f)",
        field: "recipientStateCode",
        message: "This is an unregistered supply over ₹50,000, so the buyer's state must be named.",
        remedy: "Record the state and its two-digit code.",
      });
    }
  }

  /* --- (g) lines --------------------------------------------------- */
  if (doc.lines.length === 0) {
    blocking.push({
      rule: "46(g)",
      field: "lines",
      message: "The invoice has no lines.",
      remedy: "An invoice with nothing on it cannot describe a supply.",
    });
  }

  doc.lines.forEach((line, index) => {
    const where = `line ${index + 1}`;
    if (!line.description?.trim()) {
      blocking.push({
        rule: "46(g)",
        field: `lines[${index}].description`,
        message: `${where} has no description.`,
        remedy: "Describe what is being supplied.",
      });
    }
    if (!line.hsnSacCode?.trim()) {
      blocking.push({
        rule: "46(g)",
        field: `lines[${index}].hsnSacCode`,
        message: `${where} has no HSN or SAC code.`,
        remedy:
          "Pick the classification from the HSN/SAC master. ⚠️ It is also what " +
          "the rate is resolved from, so a line without one has no defensible rate.",
      });
    }
    if (doc.supplyType === "goods" && (line.quantity === null || !line.uqc)) {
      advisory.push({
        rule: "46(g)",
        field: `lines[${index}].uqc`,
        message: `${where} is a supply of goods with no quantity or no unit.`,
        remedy:
          "Record the quantity and its unit quantity code (NOS, KGS, SQM). GSTR-1 " +
          "will not accept a free-text unit.",
      });
    }
    if (!Number.isInteger(line.rateBps) || line.rateBps < 0) {
      blocking.push({
        rule: "46(k)",
        field: `lines[${index}].rateBps`,
        message: `${where} has no tax rate.`,
        remedy: "Resolve the rate from the HSN/SAC master for the invoice's date.",
      });
    }
  });

  /* --- (n) place of supply ----------------------------------------- */
  if (!doc.placeOfSupplyCode) {
    if (doc.isInterState) {
      blocking.push({
        rule: "46(n)",
        field: "placeOfSupplyCode",
        message: "An inter-state supply must name the place of supply and its state.",
        remedy: "Set the place of supply. Without it the return cannot be filed.",
      });
    } else {
      advisory.push({
        rule: "46(n)",
        field: "placeOfSupplyCode",
        message: "No place of supply is recorded.",
        remedy: "Record it even for an intra-state supply — it is what proves it is intra-state.",
      });
    }
  }

  /* --- ⭐ Phase 32: immovable property ----------------------------- */
  //
  // Not a Rule 46 clause; it is Section 12(3), and it is checked here
  // because this is the gate an invoice passes through before issue. An
  // invoice for a flat whose place of supply is not the flat's state is
  // taxed in the wrong state, and neither the amount nor the layout of
  // the document shows it.
  if (doc.supplyType === "immovable_property") {
    if (!doc.propertyStateCode) {
      blocking.push({
        rule: "s.12(3) IGST Act",
        field: "propertyStateCode",
        message: "This supply relates to immovable property and the property's state is not recorded.",
        remedy:
          "Set the project's state. The place of supply for anything relating to " +
          "immovable property IS the property's location — not the buyer's.",
      });
    } else if (doc.placeOfSupplyCode && doc.placeOfSupplyCode !== doc.propertyStateCode) {
      blocking.push({
        rule: "s.12(3) IGST Act",
        field: "placeOfSupplyCode",
        message:
          `The place of supply is ${doc.placeOfSupplyCode} but the property is in ` +
          `${doc.propertyStateCode}.`,
        remedy:
          "For immovable property the place of supply is the LOCATION OF THE " +
          "PROPERTY, whatever the buyer's address or GSTIN says. Charging the " +
          "wrong state's tax is corrected by a refund claim under Section 77, " +
          "not by an edit.",
      });
    }
  }

  /* --- (q) signature ------------------------------------------------ */
  if (!doc.signedBy?.trim()) {
    advisory.push({
      rule: "46(q)",
      field: "signedBy",
      message: "The invoice is not signed.",
      remedy:
        "Name the authorised signatory. A digitally signed or e-invoiced document " +
        "does not need a manual signature, which is why this is advisory.",
    });
  }

  return {
    ok: blocking.length === 0,
    blocking,
    advisory,
    financialYear: doc.issuedAt ? financialYearOf(doc.issuedAt) : null,
  };
}
