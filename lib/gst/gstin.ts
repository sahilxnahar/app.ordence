/**
 * Ordence — GSTIN Inspection
 * Version: v0.32.0-alpha
 *
 * Pure. Wraps `isValidGstin` from `lib/billing/money.ts` — it is NOT
 * reimplemented here — and adds the two things a registry needs that a
 * boolean cannot give: which of the five things is wrong, and what the
 * fifteen characters mean.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY A BOOLEAN IS NOT ENOUGH FOR THIS SCREEN
 * ══════════════════════════════════════════════════════════════════════
 * A GSTIN is typed off a certificate, an email signature or a photograph
 * of an invoice. It is fifteen characters with no separators and it
 * contains both O and 0, both I and 1. "That is not a valid GSTIN" sends
 * the user back to compare fifteen characters by eye.
 *
 * "The 15th character should be 5, not S" is a correction they can make
 * in two seconds — and it is free, because the checksum computation
 * already knows the answer.
 *
 * ⚠️ AND THE COST OF NOT CATCHING IT: a wrong GSTIN is accepted by every
 * screen in the product and rejected at GSTR-1 upload, weeks later, by
 * which time the customer has paid against a document that now has to be
 * cancelled and reissued — and their input credit for that month is gone
 * until it is.
 */

import {
  GST_STATE_CODES,
  gstinCheckCharacter,
  isValidGstin,
} from "@/lib/billing/money";
import type { GstRegistrationType } from "@/db/schema/gst";

/* ------------------------------------------------------------------ */
/* ANATOMY                                                             */
/* ------------------------------------------------------------------ */

export type GstinParts = {
  /** Positions 1–2. The state of registration. */
  stateCode: string;
  stateName: string;
  /** Positions 3–12. The holder's PAN — the link to income tax. */
  pan: string;
  /** Position 13. Nth registration in this state against this PAN. */
  entityNumber: string;
  /** Position 14. Currently always "Z". */
  reserved: string;
  /** Position 15. Mod-36 check character. */
  checkCharacter: string;
};

export function parseGstin(gstin: string): GstinParts | null {
  const value = gstin.trim().toUpperCase();
  if (value.length !== 15) return null;

  const stateCode = value.slice(0, 2);
  return {
    stateCode,
    stateName: GST_STATE_CODES[stateCode] ?? "Unknown",
    pan: value.slice(2, 12),
    entityNumber: value.slice(12, 13),
    reserved: value.slice(13, 14),
    checkCharacter: value.slice(14, 15),
  };
}

/* ------------------------------------------------------------------ */
/* DIAGNOSIS                                                           */
/* ------------------------------------------------------------------ */

export type GstinProblem = {
  message: string;
  remedy: string;
};

/**
 * `null` when the GSTIN is good. Otherwise the FIRST thing wrong with it,
 * in the order a person would notice: length, then shape, then state,
 * then checksum.
 *
 * ⚠️ THE ORDER IS THE PRODUCT. Reporting the checksum failure on a
 * 14-character string is technically correct and useless — the checksum
 * is wrong because a character is missing, and telling somebody to fix
 * the last character sends them the wrong way.
 */
export function describeGstinProblem(gstin: string): GstinProblem | null {
  const value = gstin.trim().toUpperCase();

  if (value.length === 0) {
    return {
      message: "No GSTIN entered.",
      remedy: "A GSTIN is 15 characters, e.g. 27AAACR5055K1Z7.",
    };
  }

  if (value.length !== 15) {
    return {
      message: `A GSTIN is 15 characters; this one has ${value.length}.`,
      remedy:
        value.length < 15
          ? "Check for a missing character — the two easiest to drop are the " +
            "leading zero of a state code below 10, and the final check character."
          : "Check for a stray space or a duplicated character.",
    };
  }

  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(value)) {
    return {
      message: "That is not the shape of a GSTIN.",
      remedy:
        "Two digits for the state, then a 10-character PAN (5 letters, 4 digits, " +
        "1 letter), an entity digit, the letter Z, and a check character. " +
        "⚠️ O and 0 are easy to confuse here: the PAN's 6th to 9th characters " +
        "are always digits, and the state code is always digits.",
    };
  }

  const stateCode = value.slice(0, 2);
  if (!(stateCode in GST_STATE_CODES)) {
    return {
      message: `"${stateCode}" is not an Indian GST state code.`,
      remedy:
        "The first two digits are the state of registration. There is no state " +
        "25 or 99 — 25 and 28 were merged away, and codes above 38 do not exist.",
    };
  }

  const expected = gstinCheckCharacter(value);
  const actual = value.slice(14, 15);
  if (expected !== actual) {
    return {
      message: `The check character is wrong: it should be "${expected}", not "${actual}".`,
      remedy:
        "One of the fifteen characters has been mistyped — the checksum covers " +
        "all of them, so the error may be anywhere. Compare against the " +
        "registration certificate. ⚠️ Saving it anyway means the return that " +
        "quotes it is rejected weeks later and the buyer loses the input credit " +
        "for that month.",
    };
  }

  // Defence in depth: if the four checks above pass but the shared
  // validator disagrees, trust the validator. Two implementations that
  // disagree is a defect, and the safe direction is to refuse.
  if (!isValidGstin(value)) {
    return {
      message: "That GSTIN did not pass validation.",
      remedy: "Check it against the registration certificate.",
    };
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* CONSISTENCY WITH THE REST OF THE RECORD                             */
/* ------------------------------------------------------------------ */

/**
 * Does the registration type agree with whether a GSTIN was supplied?
 *
 * The database enforces this too (`gst_parties_type_matches_gstin`), and
 * this exists so the form refuses before the round-trip and can say what
 * the mismatch costs:
 *
 *   • "regular" with no GSTIN → a B2B invoice with nothing to report it
 *     against, rejected at GSTR-1 upload.
 *   • "unregistered" with a GSTIN → a B2C invoice raised to a registered
 *     buyer, who loses input credit they were entitled to and notices at
 *     their own year end.
 */
export function checkRegistrationConsistency(args: {
  registrationType: GstRegistrationType;
  gstin: string | null | undefined;
  stateCode?: string | null;
}): GstinProblem | null {
  const gstin = args.gstin?.trim().toUpperCase() || null;
  const expectsGstin =
    args.registrationType !== "unregistered" && args.registrationType !== "overseas";

  if (expectsGstin && !gstin) {
    return {
      message: `A ${args.registrationType} party must have a GSTIN.`,
      remedy:
        "Enter the GSTIN, or change the registration type to unregistered. An " +
        "invoice raised to a 'regular' party with no GSTIN has nothing to report " +
        "it against and fails at filing.",
    };
  }

  if (!expectsGstin && gstin) {
    return {
      message: `An ${args.registrationType} party cannot hold an Indian GSTIN.`,
      remedy:
        "Set the registration type to regular or composition. Leaving it as " +
        "unregistered raises a B2C invoice to a registered buyer, and they lose " +
        "the input credit.",
    };
  }

  if (gstin) {
    const problem = describeGstinProblem(gstin);
    if (problem) return problem;

    if (args.stateCode && args.stateCode !== gstin.slice(0, 2)) {
      return {
        message: `The GSTIN is registered in state ${gstin.slice(0, 2)} but the state on record is ${args.stateCode}.`,
        remedy:
          "A GSTIN's first two digits ARE its state. Correct whichever is wrong — " +
          "the place-of-supply decision reads the state, and a mismatch flips an " +
          "invoice between IGST and CGST+SGST.",
      };
    }
  }

  return null;
}

/**
 * Do two GSTINs belong to the same legal person?
 *
 * Positions 3–12 are the PAN, so a company's Maharashtra and Karnataka
 * registrations share it. Used to spot a customer entering a second
 * registration of an existing party as a new party — which would split
 * their ledger in two.
 */
export function sharesPan(a: string, b: string): boolean {
  const left = parseGstin(a);
  const right = parseGstin(b);
  if (!left || !right) return false;
  return left.pan === right.pan;
}
