import "server-only";

/**
 * Ordence — the platform's OWN tax identity, resolved or refused
 * Version: v1.81.0-alpha · Wave 17 · Track E
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS FILE EXISTS
 * ══════════════════════════════════════════════════════════════════════
 * The Wave 17 environment audit found that `PLATFORM_GSTIN`,
 * `PLATFORM_LEGAL_NAME`, `PLATFORM_ADDRESS` and `PLATFORM_INVOICE_PREFIX`
 * are all **unset on production**.
 *
 * That would be a configuration gap and nothing more, if the code that
 * needs them refused without them. It does not. It **fails open**, in
 * four separate places, and each fallback produces a document that looks
 * finished:
 *
 *   server/actions/invoicing.ts:228-232
 *     legalName: process.env.PLATFORM_LEGAL_NAME ?? "Ordence"
 *     gstin:     process.env.PLATFORM_GSTIN      ?? null
 *     stateCode: process.env.PLATFORM_GST_STATE_CODE ?? "29"
 *     address:   process.env.PLATFORM_ADDRESS    ?? null
 *
 *   server/billing/invoice-generator.ts:114 / :122
 *     supplierStateCode() → DEFAULT_SUPPLIER_STATE_CODE
 *     invoicePrefix()     → "AH"
 *
 * ⚠️ WHAT THAT ACTUALLY PRODUCES, TODAY, IF SOMEBODY PRESSES "DOWNLOAD
 * INVOICE" ON PRODUCTION:
 *
 *   1. A document headed **"Ordence"** — a product name, not a registered
 *      legal name. Rule 46(b) wants the name on the GST certificate.
 *   2. **No GSTIN and no address.** Rule 46(b) and (c) require both. A
 *      document without them is not a tax invoice, and the recipient
 *      cannot claim input tax credit on it. They will find that out at
 *      GSTR-2B reconciliation, months later, and it will be our name on
 *      the mismatch.
 *   3. A supplier state code of **"29" (Karnataka), invented from a
 *      default**. That is not cosmetic: the supplier's state versus the
 *      place of supply is what decides CGST+SGST against IGST. With the
 *      variable unset, every one of Ordence's own subscription invoices
 *      computes its tax HEAD from a guess.
 *   4. An invoice number prefixed **"AH"** — the previous product's
 *      initials — on a document from a company called Ordence. Rule 46(b)
 *      requires a consecutive serial number unique for the financial
 *      year; changing the prefix later restarts nothing and leaves two
 *      series in one year.
 *
 * ⭐ SO THIS MODULE RESOLVES OR REFUSES, AND NEVER SUBSTITUTES. There is
 * no default anywhere in it. `??` does not appear in it. An absent GSTIN
 * comes back as an absent GSTIN with a sentence saying which variable to
 * set, and the caller declines to produce the document.
 *
 * ⚠️ NOT ITS JOB: reading these from the database. They are process-level
 * configuration for the ONE legal entity that operates the platform, not
 * per-tenant data — a tenant's own GSTINs live in `gst_registrations` and
 * are resolved by `server/gst/registry.ts resolveIssuingRegistration`.
 * Confusing the two is how a tenant ends up issuing under our GSTIN.
 *
 * ⚠️ NOT `"use server"`. It exports types alongside functions.
 *
 * TODO(PATCH-REQUEST-E): the two files that must call this instead of
 * their fallbacks are `server/actions/invoicing.ts` (~L228) and
 * `server/billing/invoice-generator.ts` (~L114, ~L122). Neither is in
 * Track E's block. See PATCH-REQUEST-E.md P12.
 */

import { describeGstinProblem, parseGstin } from "@/lib/gst/gstin";
import { isPlaceOfSupplyCode, placeOfSupplyName } from "@/lib/gst/constants";

/** Every variable this module reads, in the order a human should set them. */
export const PLATFORM_IDENTITY_VARS = [
  "PLATFORM_LEGAL_NAME",
  "PLATFORM_GSTIN",
  "PLATFORM_GST_STATE_CODE",
  "PLATFORM_ADDRESS",
  "PLATFORM_INVOICE_PREFIX",
] as const;

export type PlatformIdentityVar = (typeof PLATFORM_IDENTITY_VARS)[number];

export type PlatformIdentity = {
  legalName: string;
  gstin: string;
  /** The first two digits of the GSTIN. Not a separate opinion. */
  stateCode: string;
  stateName: string;
  address: string;
  invoicePrefix: string;
};

export type PlatformIdentityProblem = {
  variable: PlatformIdentityVar;
  /** What is wrong, in one sentence a non-developer can act on. */
  message: string;
  /** What to do about it. */
  remedy: string;
};

export type PlatformIdentityResult =
  | { ok: true; identity: PlatformIdentity }
  | { ok: false; problems: PlatformIdentityProblem[] };

function read(name: PlatformIdentityVar): string | null {
  const raw = process.env[name];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Resolve the platform's tax identity, or say precisely what is missing.
 *
 * ⭐ IT REPORTS **EVERY** PROBLEM, NOT THE FIRST. Someone configuring a
 * deployment sets these in one sitting, from one screen. Returning
 * "PLATFORM_GSTIN is missing", waiting for a redeploy, then returning
 * "PLATFORM_ADDRESS is missing" costs four deploys to learn four facts
 * that were all knowable at once.
 *
 * ⚠️ THE STATE CODE IS CHECKED AGAINST THE GSTIN, NOT ACCEPTED BESIDE IT.
 * The first two characters of a GSTIN **are** the state. Storing the code
 * separately gives the same fact two sources, and the day they disagree
 * the tax head is decided by whichever one the reader happened to reach
 * for. So `PLATFORM_GST_STATE_CODE` is treated as an ASSERTION to be
 * verified, and a disagreement is refused rather than silently resolved
 * in favour of either.
 */
export function resolvePlatformIdentity(): PlatformIdentityResult {
  const problems: PlatformIdentityProblem[] = [];

  const legalName = read("PLATFORM_LEGAL_NAME");
  if (!legalName) {
    problems.push({
      variable: "PLATFORM_LEGAL_NAME",
      message:
        "The platform has no registered legal name configured, so an invoice " +
        "it issues would be headed with a product name rather than a company.",
      remedy:
        "Set PLATFORM_LEGAL_NAME to the Legal Name of Business exactly as it " +
        "appears on the GST registration certificate.",
    });
  }

  const gstin = read("PLATFORM_GSTIN");
  if (!gstin) {
    problems.push({
      variable: "PLATFORM_GSTIN",
      message:
        "The platform has no GSTIN configured. A document without one is not " +
        "a tax invoice under Rule 46(b), and the customer cannot claim input " +
        "tax credit on it.",
      remedy: "Set PLATFORM_GSTIN to the 15-character registration number.",
    });
  } else {
    const problem = describeGstinProblem(gstin);
    if (problem) {
      problems.push({
        variable: "PLATFORM_GSTIN",
        message: `PLATFORM_GSTIN is not a valid GSTIN. ${problem.message}`,
        remedy: problem.remedy,
      });
    }
  }

  const parts = gstin ? parseGstin(gstin) : null;
  const declaredState = read("PLATFORM_GST_STATE_CODE");

  if (declaredState && !isPlaceOfSupplyCode(declaredState)) {
    problems.push({
      variable: "PLATFORM_GST_STATE_CODE",
      message: `PLATFORM_GST_STATE_CODE is "${declaredState}", which is not a GST state code.`,
      remedy:
        "Either remove it — the state is the first two digits of the GSTIN — " +
        "or set it to the correct two-digit code.",
    });
  } else if (declaredState && parts && declaredState !== parts.stateCode) {
    problems.push({
      variable: "PLATFORM_GST_STATE_CODE",
      message:
        `PLATFORM_GST_STATE_CODE says ${declaredState} ` +
        `(${placeOfSupplyName(declaredState)}) but PLATFORM_GSTIN begins ` +
        `${parts.stateCode} (${placeOfSupplyName(parts.stateCode)}). ` +
        "Which state the supplier is in decides CGST plus SGST against IGST, " +
        "so this cannot be resolved by preferring one of them.",
      remedy:
        "Correct whichever is wrong. If the GSTIN is right, remove " +
        "PLATFORM_GST_STATE_CODE entirely — it is derived, not configured.",
    });
  }

  const address = read("PLATFORM_ADDRESS");
  if (!address) {
    problems.push({
      variable: "PLATFORM_ADDRESS",
      message:
        "The platform has no address configured. Rule 46(c) requires the " +
        "supplier's address on a tax invoice.",
      remedy:
        "Set PLATFORM_ADDRESS to the principal place of business, one line.",
    });
  }

  const invoicePrefix = read("PLATFORM_INVOICE_PREFIX");
  if (!invoicePrefix) {
    problems.push({
      variable: "PLATFORM_INVOICE_PREFIX",
      message:
        "No invoice prefix is configured, so numbering would fall back to a " +
        "built-in default. Rule 46(b) requires a consecutive serial unique " +
        "for the financial year; adopting a prefix later leaves two series " +
        "inside one year, which an auditor is entitled to ask about.",
      remedy:
        "Set PLATFORM_INVOICE_PREFIX before the first invoice is issued. " +
        "One to ten letters, digits or hyphens.",
    });
  } else if (!/^[A-Za-z0-9-]{1,10}$/.test(invoicePrefix)) {
    problems.push({
      variable: "PLATFORM_INVOICE_PREFIX",
      message:
        `PLATFORM_INVOICE_PREFIX is "${invoicePrefix}", which contains a ` +
        "character that is not allowed. Rule 46(b) permits letters, digits, " +
        "the hyphen and the slash; the slash is excluded here because the " +
        "number becomes a filename and a URL path.",
      remedy: "Use one to ten letters, digits or hyphens.",
    });
  }

  if (problems.length > 0) return { ok: false, problems };

  // Every branch above has pushed a problem for a null, so these are
  // non-null here. Asserted rather than assumed, because
  // `noUncheckedIndexedAccess` will not catch a future branch that
  // forgets to push.
  if (!legalName || !gstin || !parts || !address || !invoicePrefix) {
    return {
      ok: false,
      problems: [
        {
          variable: "PLATFORM_GSTIN",
          message:
            "The platform identity could not be assembled even though no " +
            "individual problem was reported. This is a defect in " +
            "resolvePlatformIdentity, not a configuration error.",
          remedy: "Report it. Do not work around it by supplying a default.",
        },
      ],
    };
  }

  return {
    ok: true,
    identity: {
      legalName,
      gstin,
      stateCode: parts.stateCode,
      stateName: placeOfSupplyName(parts.stateCode),
      address,
      invoicePrefix,
    },
  };
}

/**
 * One paragraph a human can act on, for the four-problems-at-once case.
 *
 * ⚠️ THIS IS THE TEXT A CUSTOMER MIGHT SEE. It names variables, because
 * the person who hits it is the person who can set them, but it does not
 * quote a value: `PLATFORM_GSTIN` is not a secret, and the other three
 * are not either, but the habit of echoing environment values into a
 * user-facing string is how one eventually does.
 */
export function describePlatformIdentityProblems(
  problems: readonly PlatformIdentityProblem[],
): string {
  if (problems.length === 0) return "";
  const list = problems.map((p) => `• ${p.message} ${p.remedy}`).join("\n");
  return (
    "This workspace cannot issue an invoice yet, because the platform's own " +
    "tax identity is not configured:\n" +
    list +
    "\nUntil these are set, no document is produced. An invoice missing any " +
    "of them is not a valid tax invoice, and issuing one is worse than " +
    "issuing none, because it looks finished."
  );
}

/**
 * ⭐ THE ASSERTION THE WIRING TRACK CAN RUN.
 *
 * `true` exactly when a production deployment could legally issue one of
 * Ordence's own invoices. Intended for a health check and for a startup
 * log line — NOT for a code path that then supplies a default when it
 * reads `false`.
 */
export function platformCanIssueInvoices(): boolean {
  return resolvePlatformIdentity().ok;
}
