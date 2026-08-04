/**
 * Ordence — Place of Supply Engine
 * Version: v0.32.0-alpha
 *
 * Pure. No database, no I/O, no `Date.now()`. Given four facts it returns
 * one answer and the section of the Act it came from.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHY THIS IS THE MOST IMPORTANT FILE IN THE PHASE
 * ══════════════════════════════════════════════════════════════════════
 * Place of supply decides WHICH TAX, not how much. Get it wrong and the
 * total on the invoice is right to the paisa and the document is still
 * unusable:
 *
 *   • Charged CGST+SGST when it should have been IGST — the buyer cannot
 *     claim the credit (it sits in the wrong state's pool), and we owe
 *     IGST that was never collected. Paying it later attracts interest
 *     from the original date.
 *   • Charged IGST when it should have been CGST+SGST — the same in
 *     reverse, and the refund of the wrongly-paid tax is a separate
 *     application under Section 77 that takes months.
 *
 * Neither error is visible on the invoice. Both surface at the buyer's
 * reconciliation or at an assessment, long after the money moved.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE RULE EVERYBODY GETS WRONG: SECTION 12(3)
 * ══════════════════════════════════════════════════════════════════════
 * For services "directly in relation to immovable property" — which
 * includes construction, sale of an under-construction flat, works
 * contracts, leasing, and an architect's or surveyor's fee — the place of
 * supply is **the location of the property**. Full stop. It does not
 * matter where the buyer lives, where their GSTIN is registered, or where
 * the agreement was signed.
 *
 * Concretely, and this is the case a real-estate CRM meets weekly:
 *
 *     Supplier registered in MAHARASHTRA (27).
 *     Flat in PUNE, so the property is in MAHARASHTRA (27).
 *     Buyer is an NRI resident in Dubai, or a company registered in
 *       KARNATAKA (29).
 *
 *     Place of supply = 27. INTRA-state. CGST + SGST.
 *
 * Every generic billing engine answers 29 (or "export"), because every
 * generic billing engine derives place of supply from the customer
 * record. That single default is the most expensive bug available in this
 * product, so `supplyType: "immovable_property"` does not merely prefer
 * the property location — it REFUSES to answer without one.
 */

import {
  isPlaceOfSupplyCode,
  isUnionTerritoryCode,
  OVERSEAS_PLACE_OF_SUPPLY,
  placeOfSupplyName,
} from "./constants";
import type { GstRegistrationType, GstSupplyType } from "@/db/schema/gst";

/* ------------------------------------------------------------------ */
/* TYPES                                                               */
/* ------------------------------------------------------------------ */

export type PlaceOfSupplyBasis =
  /** ⭐ Section 12(3)/13(4) — the property decides. */
  | "immovable_property_location"
  /** Section 12(2)(a) — the recipient's registered state. */
  | "recipient_registration"
  /** Section 12(2)(b) — the address on record for an unregistered buyer. */
  | "recipient_address"
  /** Section 10(1)(a) — where movement of goods terminates. */
  | "delivery_location"
  /** Section 12(2)(b) proviso — nothing on record, so our own location. */
  | "supplier_location"
  /** Section 7(5)(b) — SEZ, deemed inter-state wherever it sits. */
  | "sez_deemed_interstate"
  /** Section 2(6)/16 — export, place of supply outside India. */
  | "outside_india";

/** Which pair of taxes applies. UTGST is a different Act from SGST. */
export type GstTaxKind = "cgst_sgst" | "cgst_utgst" | "igst";

export type PlaceOfSupplyInput = {
  /** OUR registered state for this document. Two digits. */
  supplierStateCode: string;
  supplyType: GstSupplyType;
  recipientRegistration: GstRegistrationType;
  /** From the recipient's GSTIN, or the state on their address. */
  recipientStateCode?: string | null;
  /**
   * ⭐ Where the flat, plot, shop or site IS. Required — and only
   * required — for `immovable_property`.
   */
  propertyStateCode?: string | null;
  /** Ship-to state for goods, when it differs from the bill-to. */
  deliveryStateCode?: string | null;
};

export type PlaceOfSupplyProblem = {
  message: string;
  remedy: string;
};

export type PlaceOfSupply = {
  placeOfSupplyCode: string;
  basis: PlaceOfSupplyBasis;
  /** The provision relied on, for the working papers and the tooltip. */
  statutoryRef: string;
  isInterState: boolean;
  /** True only when intra-state AND the state is a UT without a legislature. */
  isUnionTerritory: boolean;
  taxKind: GstTaxKind;
  /** One sentence a human can check. Shown next to the tax on the form. */
  explanation: string;
};

export type PlaceOfSupplyResult =
  | { ok: true; supply: PlaceOfSupply }
  | { ok: false; problem: PlaceOfSupplyProblem };

/* ------------------------------------------------------------------ */
/* THE ENGINE                                                          */
/* ------------------------------------------------------------------ */

export function determinePlaceOfSupply(input: PlaceOfSupplyInput): PlaceOfSupplyResult {
  const supplier = normaliseCode(input.supplierStateCode);

  // ⚠️ The `!supplier` half is what narrows `string | null` to `string`
  // for the whole rest of the function. Everything below reads the
  // supplier state, and a null one would make every comparison unequal —
  // i.e. would quietly make every supply inter-state.
  if (!supplier || !isPlaceOfSupplyCode(supplier) || supplier === OVERSEAS_PLACE_OF_SUPPLY) {
    return {
      ok: false,
      problem: {
        message: `"${input.supplierStateCode}" is not a state we can issue from.`,
        remedy:
          "Pick the GST registration this document is being issued under. The " +
          "first two digits of that GSTIN are the supplier state.",
      },
    };
  }

  /* ---------------------------------------------------------------- */
  /* 1. ⭐ IMMOVABLE PROPERTY — THE PROPERTY DECIDES                   */
  /* ---------------------------------------------------------------- */
  //
  // FIRST, deliberately. It outranks the recipient's registration, their
  // address, and whether they are overseas. Putting this branch anywhere
  // below the SEZ or overseas checks would mean an NRI buyer or an SEZ
  // registration silently converted a Pune flat into an inter-state
  // supply — which is precisely the bug this ordering exists to prevent.
  if (input.supplyType === "immovable_property") {
    const property = normaliseCode(input.propertyStateCode);

    if (!property) {
      return {
        ok: false,
        problem: {
          message: "This is a supply relating to immovable property, and we have not been told where the property is.",
          remedy:
            "Set the project's state. Under Section 12(3) of the IGST Act the " +
            "place of supply for anything relating to immovable property is the " +
            "LOCATION OF THE PROPERTY — not the buyer's address and not their " +
            "GSTIN. Guessing from the buyer would put the tax in the wrong " +
            "state's pool, and correcting that afterwards is a refund " +
            "application under Section 77, not an edit.",
        },
      };
    }

    if (!isPlaceOfSupplyCode(property)) {
      return {
        ok: false,
        problem: {
          message: `"${input.propertyStateCode}" is not a state or territory code.`,
          remedy: "Set the project's state to a valid two-digit GST state code.",
        },
      };
    }

    // ⚠️ Section 13(4) covers a property OUTSIDE India, and it says the
    // same thing: the location of the property. A supplier registered in
    // India selling a service on a Dubai building has its place of supply
    // in Dubai — outside India, so IGST as a zero-rated export.
    if (property === OVERSEAS_PLACE_OF_SUPPLY) {
      return ok({
        placeOfSupplyCode: OVERSEAS_PLACE_OF_SUPPLY,
        basis: "immovable_property_location",
        statutoryRef: "Section 13(4), IGST Act",
        isInterState: true,
        isUnionTerritory: false,
        taxKind: "igst",
        explanation:
          "The property is outside India, so the place of supply is outside " +
          "India. Zero-rated export, reported under IGST.",
      });
    }

    const interState = property !== supplier;
    return ok({
      placeOfSupplyCode: property,
      basis: "immovable_property_location",
      statutoryRef: "Section 12(3)(a), IGST Act",
      isInterState: interState,
      isUnionTerritory: !interState && isUnionTerritoryCode(property),
      taxKind: taxKindFor(interState, property),
      explanation:
        `The property is in ${placeOfSupplyName(property)}, so that is the place ` +
        `of supply — regardless of where the buyer is or where their GSTIN is ` +
        `registered (Section 12(3), IGST Act). ` +
        (interState
          ? "Our registration is in another state, so this is inter-state: IGST."
          : "Our registration is in the same state, so this is intra-state."),
    });
  }

  /* ---------------------------------------------------------------- */
  /* 2. SEZ — DEEMED INTER-STATE WHEREVER IT IS                        */
  /* ---------------------------------------------------------------- */
  //
  // ⚠️ An SEZ unit two kilometres away, in the same state, is still an
  // inter-state supply. Section 7(5)(b) says so in terms. Matching the
  // state codes and concluding "intra-state" is the single most common
  // SEZ mistake, and it under-collects IGST that has to be paid later
  // with interest.
  if (input.recipientRegistration === "sez") {
    const recipient = normaliseCode(input.recipientStateCode) ?? supplier;
    return ok({
      placeOfSupplyCode: isPlaceOfSupplyCode(recipient) ? recipient : supplier,
      basis: "sez_deemed_interstate",
      statutoryRef: "Section 7(5)(b), IGST Act",
      isInterState: true,
      isUnionTerritory: false,
      taxKind: "igst",
      explanation:
        "The recipient is in a Special Economic Zone. Section 7(5)(b) deems " +
        "this an inter-state supply even when the SEZ is in our own state, so " +
        "IGST applies and the supply is zero-rated.",
    });
  }

  /* ---------------------------------------------------------------- */
  /* 3. OVERSEAS RECIPIENT — EXPORT                                    */
  /* ---------------------------------------------------------------- */
  if (input.recipientRegistration === "overseas") {
    return ok({
      placeOfSupplyCode: OVERSEAS_PLACE_OF_SUPPLY,
      basis: "outside_india",
      statutoryRef: "Section 2(6) read with Section 16, IGST Act",
      isInterState: true,
      isUnionTerritory: false,
      taxKind: "igst",
      explanation:
        "The recipient is outside India, so this is a zero-rated export " +
        "reported under IGST. ⚠️ If this supply actually relates to a property " +
        "in India, it is NOT an export — set the supply type to immovable " +
        "property and the place of supply becomes the property's state.",
    });
  }

  /* ---------------------------------------------------------------- */
  /* 4. GOODS — WHERE THE MOVEMENT ENDS                                */
  /* ---------------------------------------------------------------- */
  if (input.supplyType === "goods") {
    const delivery =
      normaliseCode(input.deliveryStateCode) ?? normaliseCode(input.recipientStateCode);

    if (!delivery || !isPlaceOfSupplyCode(delivery)) {
      // ⚠️ Falls back to the SUPPLIER's state, which is the outcome for an
      // over-the-counter sale where the buyer carries the goods away
      // (Section 10(1)(c)). It is also the conservative answer for a
      // missing address: an intra-state supply raised in error is corrected
      // with a credit note, whereas guessing another state puts a return
      // on file naming a state we never supplied.
      return ok({
        placeOfSupplyCode: supplier,
        basis: "supplier_location",
        statutoryRef: "Section 10(1)(c), IGST Act",
        isInterState: false,
        isUnionTerritory: isUnionTerritoryCode(supplier),
        taxKind: taxKindFor(false, supplier),
        explanation:
          "No delivery address is recorded, so the goods are treated as " +
          "collected from us: the place of supply is our own state.",
      });
    }

    const interState = delivery !== supplier;
    return ok({
      placeOfSupplyCode: delivery,
      basis: "delivery_location",
      statutoryRef: "Section 10(1)(a), IGST Act",
      isInterState: interState,
      isUnionTerritory: !interState && isUnionTerritoryCode(delivery),
      taxKind: taxKindFor(interState, delivery),
      explanation:
        `The goods are delivered in ${placeOfSupplyName(delivery)}, which is ` +
        `where the movement terminates, so that is the place of supply.`,
    });
  }

  /* ---------------------------------------------------------------- */
  /* 5. SERVICES                                                       */
  /* ---------------------------------------------------------------- */
  const recipient = normaliseCode(input.recipientStateCode);
  const isRegistered =
    input.recipientRegistration === "regular" ||
    input.recipientRegistration === "composition";

  if (isRegistered) {
    if (!recipient || !isPlaceOfSupplyCode(recipient)) {
      return {
        ok: false,
        problem: {
          message: "The recipient is registered but we have no state for them.",
          remedy:
            "Record their GSTIN. For a registered recipient the place of supply " +
            "is their registered location (Section 12(2)(a)), so it cannot be " +
            "derived from anything else.",
        },
      };
    }
    const interState = recipient !== supplier;
    return ok({
      placeOfSupplyCode: recipient,
      basis: "recipient_registration",
      statutoryRef: "Section 12(2)(a), IGST Act",
      isInterState: interState,
      isUnionTerritory: !interState && isUnionTerritoryCode(recipient),
      taxKind: taxKindFor(interState, recipient),
      explanation:
        `The recipient is registered in ${placeOfSupplyName(recipient)}, so that ` +
        `is the place of supply.`,
    });
  }

  // Unregistered recipient: the address on our records, if we have one.
  if (recipient && isPlaceOfSupplyCode(recipient)) {
    const interState = recipient !== supplier;
    return ok({
      placeOfSupplyCode: recipient,
      basis: "recipient_address",
      statutoryRef: "Section 12(2)(b)(i), IGST Act",
      isInterState: interState,
      isUnionTerritory: !interState && isUnionTerritoryCode(recipient),
      taxKind: taxKindFor(interState, recipient),
      explanation:
        `The recipient is unregistered and their address on record is in ` +
        `${placeOfSupplyName(recipient)}, so that is the place of supply.`,
    });
  }

  return ok({
    placeOfSupplyCode: supplier,
    basis: "supplier_location",
    statutoryRef: "Section 12(2)(b)(ii), IGST Act",
    isInterState: false,
    isUnionTerritory: isUnionTerritoryCode(supplier),
    taxKind: taxKindFor(false, supplier),
    explanation:
      "The recipient is unregistered and we hold no address for them, so the " +
      "place of supply is our own location (Section 12(2)(b)(ii)).",
  });
}

/* ------------------------------------------------------------------ */
/* HELPERS                                                             */
/* ------------------------------------------------------------------ */

function ok(supply: PlaceOfSupply): PlaceOfSupplyResult {
  return { ok: true, supply };
}

/**
 * ⚠️ Two digits, zero-padded. "7" and "07" are the same state to a human
 * and different strings to a comparison, and a place of supply that never
 * equals the supplier's makes every supply inter-state.
 */
function normaliseCode(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (trimmed === "") return null;
  return trimmed.length === 1 ? `0${trimmed}` : trimmed;
}

function taxKindFor(isInterState: boolean, placeOfSupply: string): GstTaxKind {
  if (isInterState) return "igst";
  return isUnionTerritoryCode(placeOfSupply) ? "cgst_utgst" : "cgst_sgst";
}
