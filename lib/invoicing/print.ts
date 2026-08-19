/**
 * Ordence — ⭐ The printed document
 * Version: v0.97.0-alpha
 *
 * Pure. Everything here shapes what appears on paper; nothing here
 * decides what is owed.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE BROWSER IS THE PDF ENGINE, AND THAT IS A DECISION
 * ══════════════════════════════════════════════════════════════════════
 * There is no headless Chrome on the server, no `pdfkit`, no rendering
 * service. The print route serves a page styled for A4 and the person
 * presses Print → Save as PDF.
 *
 * ⚠️ THE ALTERNATIVE WAS WORSE. A server-side renderer means a second
 * browser resident in the Railway container — hundreds of megabytes of
 * memory that exist to do nothing most of the day, a cold start measured
 * in seconds, and a whole class of failure where the invoice cannot be
 * produced because the PDF service died. The document a customer needs
 * must not depend on the heaviest process in the system.
 *
 * ⚠️ AND IT MEANS THE OUTPUT IS SELECTABLE TEXT, always. A rasterised
 * PDF cannot be searched, copied into a ledger, or read by a screen
 * reader, and the accountant on the other end does all three.
 *
 * The cost is honest: the person has to press Print themselves, and
 * margins vary slightly by browser. Emailing a PDF automatically is a
 * later batch and will need a real renderer — this one does not.
 */

export type PostalAddress = {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
};

/**
 * An address as lines, in the order India Post reads them.
 *
 * ⚠️ EMPTY PARTS ARE DROPPED, NOT PRINTED BLANK. A gap in the middle of
 * a block address reads as a missing field on a legal document, and a
 * trailing comma before a PIN code is the detail that makes an invoice
 * look machine-generated in the bad way.
 *
 * ⚠️ COUNTRY IS OMITTED WHEN IT IS INDIA. Printing "India" on a domestic
 * GST invoice is noise; on an export invoice it is essential, so it
 * appears exactly when it is not India.
 */
export function addressLines(address: PostalAddress | null | undefined): string[] {
  if (!address) return [];
  const lines: string[] = [];

  const push = (v: string | undefined) => {
    const t = (v ?? "").trim();
    if (t) lines.push(t);
  };

  push(address.line1);
  push(address.line2);

  const cityState = [address.city, address.state]
    .map((v) => (v ?? "").trim())
    .filter(Boolean)
    .join(", ");
  const postal = (address.postalCode ?? "").trim();
  const locality = [cityState, postal].filter(Boolean).join(" - ");
  push(locality);

  const country = (address.country ?? "").trim();
  if (country && country.toLowerCase() !== "india") lines.push(country);

  return lines;
}

/**
 * ⭐ Rule 48(1) — how many copies, and what each is marked.
 *
 * ⚠️ GOODS TAKE THREE COPIES, SERVICES TAKE TWO. This is not a style
 * choice: the triplicate for goods exists because one copy travels with
 * the consignment for the transporter, and there is no consignment on a
 * supply of services. Printing "Duplicate for Transporter" on a
 * consultancy invoice is a small thing that tells a reader the document
 * was produced by someone who does not know the rule.
 */
export const INVOICE_COPIES = {
  goods: [
    "ORIGINAL FOR RECIPIENT",
    "DUPLICATE FOR TRANSPORTER",
    "TRIPLICATE FOR SUPPLIER",
  ],
  services: ["ORIGINAL FOR RECIPIENT", "DUPLICATE FOR SUPPLIER"],
} as const;

export function copyLabelsFor(supplyType: string): readonly string[] {
  return supplyType === "services" ? INVOICE_COPIES.services : INVOICE_COPIES.goods;
}

/**
 * ⚠️ A GSTIN IS PRINTED UNBROKEN, IN CAPITALS. It is a single
 * fifteen-character identifier and every portal, return and reconciliation
 * treats it as one token. Spacing it into groups to "help readability"
 * produces a string that fails a copy-paste into the GST portal — which is
 * the only thing anyone ever does with it.
 */
export function formatGstin(gstin: string | null | undefined): string {
  const t = (gstin ?? "").trim().toUpperCase();
  return t.length > 0 ? t : "";
}

export type PrintFinding = { field: string; rule: string; message: string };

/**
 * 🔴 WHAT IS MISSING FROM THIS DOCUMENT, SAID ON THE DOCUMENT.
 *
 * ⚠️ THE PRINT VIEW DOES NOT SILENTLY OMIT A FIELD IT DOES NOT HAVE.
 * `deliveryAddress` (Rule 46(o)) and `signedBy` (Rule 46(q)) are still
 * not captured anywhere in the product. The tempting move is to leave
 * those rows off the page so the invoice "looks complete" — which
 * produces a document that is confidently, invisibly deficient, and the
 * first anyone hears of it is a customer's accountant rejecting it.
 *
 * So the row is printed with the gap visible. An invoice that shows a
 * blank signature line is one somebody signs. An invoice with no
 * signature line at all is one nobody notices is unsigned.
 */
export function printGaps(args: {
  hasDeliveryAddress: boolean;
  hasSignatory: boolean;
  supplierGstin: string | null;
  supplierLegalName: string | null;
}): PrintFinding[] {
  const gaps: PrintFinding[] = [];

  if (!args.supplierLegalName) {
    gaps.push({
      field: "supplierLegalName",
      rule: "Rule 46(a)",
      message:
        "Your own legal name is not on this invoice. Add a GST registration under Settings before sending it.",
    });
  }
  if (!args.supplierGstin) {
    gaps.push({
      field: "supplierGstin",
      rule: "Rule 46(a)",
      message:
        "Your GSTIN is not on this invoice. Without it the customer cannot claim input tax credit.",
    });
  }
  if (!args.hasDeliveryAddress) {
    gaps.push({
      field: "deliveryAddress",
      rule: "Rule 46(o)",
      message:
        "Address of delivery is not captured. Required where it differs from the place of supply.",
    });
  }
  if (!args.hasSignatory) {
    gaps.push({
      field: "signedBy",
      rule: "Rule 46(q)",
      message: "Signature or digital signature of the supplier, or an authorised person.",
    });
  }

  return gaps;
}
