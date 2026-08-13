/**
 * Ordence — ⭐⭐⭐ RULE 33 — THE ₹500 THAT COSTS ₹9,090
 * Version: v1.8.0-alpha
 *
 * Pure. No database, no clock.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE RULE, AND WHY IT IS THE MOST EXPENSIVE ROUNDING IN INDIAN
 *      PROFESSIONAL PRACTICE
 * ══════════════════════════════════════════════════════════════════════
 * A firm pays a **₹50,000 court fee** for a client and recovers it on
 * the bill. Under **Rule 33 of the CGST Rules** that recovery is
 * excluded from the value of supply altogether — no GST on it, because
 * the firm was a *pure agent*: it paid somebody else's statutory
 * liability, held no title to anything, and got back exactly what it
 * put out.
 *
 * 🔴 **Recover ₹50,500 instead of ₹50,000 and the exclusion is gone.**
 *
 * Not the ₹500. **The whole ₹50,500.** Explanation (d) to Rule 33
 * requires the pure agent to receive "only the actual amount incurred".
 * Take one rupee more and the transaction stops being a disbursement and
 * becomes part of what the firm supplied — so the entire sum drops into
 * the value of supply and bears tax at 18%.
 *
 *     ₹500 of handling charge  →  ₹9,090 of GST.
 *
 * ⚠️ And firms do this constantly, for entirely innocent reasons: a
 * rounded-up bill, a bundled "court fees and incidentals" line, a
 * standard 1% handling charge somebody added years ago.
 *
 * ⭐ THE DATABASE REFUSES IT. `matter_disbursements_pure_agent_is_at_actual`
 * in 0059 will not store a pure-agent line where the recovery differs
 * from the payment by a single paisa. Not a warning — a rejection —
 * because a warning on this one gets clicked through.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE CBIC'S OWN ILLUSTRATION IS THIS EXACT CASE
 * ══════════════════════════════════════════════════════════════════════
 * The illustration appended to Rule 33 is a corporate services firm
 * recovering registration and approval fees paid to the Registrar of
 * Companies. Statutory fees, compulsorily borne by the client, recovered
 * at actual, in addition to the firm's own fee — a pure agent recovery.
 * Court fees are the same fact pattern with a different registry.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE THREE CONDITIONS AND THE FOUR LIMBS ARE CUMULATIVE
 * ══════════════════════════════════════════════════════════════════════
 * Rule 33 proper — all three:
 *   (i)   paid to the third party **on the recipient's authorisation**;
 *   (ii)  **separately indicated** in the invoice;
 *   (iii) **in addition to** the services supplied on the firm's own
 *         account.
 *
 * Explanation — all four:
 *   (a) a contractual agreement to act as pure agent for that cost;
 *   (b) neither intends to hold nor holds title to what was procured;
 *   (c) does not use it for his own interest;
 *   (d) receives **only the actual amount incurred**.
 *
 * 🔴 Condition (ii) is the one software breaks, not people. A fee note
 * that adds the disbursement into the fee total and prints one number
 * has failed Rule 33 on the face of the document, however the money
 * actually moved.
 */

import { formatMinor } from "./gst-legal";

export class DisbursementError extends Error {}

/* ------------------------------------------------------------------ */
/* WHAT WAS PAID OUT                                                   */
/* ------------------------------------------------------------------ */

export type DisbursementKind =
  /** Ad valorem or fixed fee on the plaint. Statutory, and the client's. */
  | "court_fee"
  /** Fee for issue and service of summons and notices. */
  | "process_fee"
  /** On an instrument — the client's liability under the Stamp Act. */
  | "stamp_duty"
  /** Advocates' Welfare Fund stamp on the vakalatnama. */
  | "welfare_stamp"
  /** Certified copies, inspection, typing at the registry. */
  | "copying_charges"
  /** Paid to a valuer, handwriting expert, translator, surveyor. */
  | "expert_fee"
  /** Filing fee on a portal or with a tribunal registry. */
  | "filing_fee"
  /** ⚠️ The firm's own cost of getting there. Almost never a pure agent item. */
  | "travel"
  /** ⚠️ Likewise. */
  | "courier"
  | "other";

export const DISBURSEMENT_KINDS: readonly DisbursementKind[] = [
  "court_fee",
  "process_fee",
  "stamp_duty",
  "welfare_stamp",
  "copying_charges",
  "expert_fee",
  "filing_fee",
  "travel",
  "courier",
  "other",
] as const;

/**
 * ⭐ Which kinds are *capable* of being pure agent recoveries at all.
 *
 * 🔴 Travel and courier are not, and this is the second most common
 * error after the markup. The client did not owe the airline anything.
 * The firm chose to travel in order to supply its own service, so the
 * cost is the firm's own input and recovering it is simply part of the
 * fee — taxable, at the rate the fee bears.
 *
 * ⚠️ "But I bought the ticket for the client's case" is not the test.
 * The test is whether the CLIENT was liable to the third party and the
 * firm merely discharged that liability. Nobody was ever going to send
 * the client a bill for the firm's flight.
 */
export const PURE_AGENT_CAPABLE: Readonly<Record<DisbursementKind, boolean>> = {
  court_fee: true,
  process_fee: true,
  stamp_duty: true,
  welfare_stamp: true,
  copying_charges: true,
  expert_fee: true,
  filing_fee: true,
  travel: false,
  courier: false,
  other: true,
};

/** ⭐ Human labels, used on the screen and in the fee note. */
export const DISBURSEMENT_LABELS: Readonly<Record<DisbursementKind, string>> = {
  court_fee: "Court fee",
  process_fee: "Process fee",
  stamp_duty: "Stamp duty",
  welfare_stamp: "Advocates' Welfare Fund stamp",
  copying_charges: "Copying and certified copies",
  expert_fee: "Expert's fee",
  filing_fee: "Filing fee",
  travel: "Travel",
  courier: "Courier",
  other: "Other",
};

/* ------------------------------------------------------------------ */
/* THE ASSESSMENT                                                      */
/* ------------------------------------------------------------------ */

export type PureAgentVerdict = {
  /** 🔴 Whether the recovery stays OUT of the value of supply. */
  excludedFromValue: boolean;
  /** Which limb failed, where one did. */
  failedOn: readonly string[];
  reason: string;
  citation: string;
  /**
   * 🔴 What the mistake costs, where the exclusion is lost because of a
   * markup. The tax on the WHOLE recovery, not on the markup.
   */
  taxAtRiskMinor: bigint;
  notes: readonly string[];
};

const RULE_33 = "Rule 33, CGST Rules 2017 — value of supply in case of pure agent";

export function assessPureAgent(args: {
  kind: DisbursementKind;
  /** What the firm actually paid the third party. */
  paidMinor: bigint;
  /** What the firm is recovering from the client. */
  recoveredMinor: bigint;
  /** Rule 33(i) and Explanation (a) — the client authorised it. */
  clientAuthorised: boolean;
  /** Rule 33(ii) — it appears as its own line on the fee note. */
  separatelyIndicated: boolean;
  /**
   * Rule 33(iii) — the firm is also supplying something on its own
   * account. A "bill" consisting only of a recovered court fee is not a
   * pure agent recovery; it is a reimbursement with nothing to be an
   * agent alongside.
   */
  suppliedOnOwnAccount: boolean;
  /** Explanation (b)/(c) — the firm holds no title and takes no benefit. */
  holdsNoTitle?: boolean;
  /** The rate the firm's own fee bears, for costing the mistake. */
  feeTaxRateBps?: number;
}): PureAgentVerdict {
  if (args.paidMinor < 0n || args.recoveredMinor < 0n) {
    throw new DisbursementError("A disbursement cannot be negative.");
  }
  const rateBps = args.feeTaxRateBps ?? 1800;
  if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10000) {
    throw new DisbursementError("A tax rate must be an integer between 0 and 10000 bps.");
  }

  const failed: string[] = [];
  const notes: string[] = [];

  if (!PURE_AGENT_CAPABLE[args.kind]) {
    failed.push(
      `${DISBURSEMENT_LABELS[args.kind]} is the firm's own cost, not the client's liability`,
    );
  }
  if (!args.clientAuthorised) {
    failed.push("Rule 33(i) and Explanation (a) — no authorisation from the client to incur it");
  }
  if (!args.separatelyIndicated) {
    failed.push("Rule 33(ii) — not separately indicated on the invoice");
  }
  if (!args.suppliedOnOwnAccount) {
    failed.push("Rule 33(iii) — nothing supplied on the firm's own account alongside it");
  }
  if (args.holdsNoTitle === false) {
    failed.push("Explanation (b) and (c) — the firm holds title to, or takes a benefit from, what was procured");
  }

  /* 🔴 THE ONE THAT COSTS MONEY. */
  const markup = args.recoveredMinor - args.paidMinor;
  if (markup !== 0n) {
    failed.push(
      markup > 0n
        ? `Explanation (d) — recovered ${formatMinor(markup)} MORE than was paid`
        : `Explanation (d) — recovered ${formatMinor(-markup)} LESS than was paid`,
    );
  }

  /**
   * ⚠️ Recovering LESS is also a failure of limb (d) on the words —
   * "only the actual amount incurred". In practice a firm absorbing part
   * of a court fee is not the mischief the rule is aimed at, and nobody
   * has been assessed for it. Said plainly rather than hidden, because
   * the software should not pretend to a certainty the rule does not
   * give.
   */
  if (markup < 0n) {
    notes.push(
      "⚠️ Recovering less than was paid fails limb (d) on a literal reading, but the rule exists to stop a margin being hidden in a disbursement, and there is no margin here. Ordence flags it rather than blocking it — the practical question is why the firm is absorbing part of a statutory fee, which is usually a write-off decision somebody should see.",
    );
  }

  const excluded = failed.length === 0;

  /**
   * 🔴 THE COST OF GETTING IT WRONG, IN RUPEES.
   *
   * ⚠️ Computed on the WHOLE recovery, not on the markup — because that
   * is what actually happens. Once the exclusion fails, the entire sum
   * is consideration for the firm's supply.
   */
  const taxAtRisk = excluded
    ? 0n
    : (args.recoveredMinor * BigInt(rateBps)) / 10000n;

  if (!excluded && markup > 0n) {
    notes.push(
      `🔴 A markup of ${formatMinor(markup)} moves the WHOLE ${formatMinor(
        args.recoveredMinor,
      )} into the value of supply, so the tax at stake is ${formatMinor(
        taxAtRisk,
      )} — not the tax on the markup. Recover the fee at actual and bill the handling separately as fees if the firm wants to charge for the work.`,
    );
  }

  if (excluded && args.kind === "court_fee") {
    notes.push(
      "⭐ The illustration appended to Rule 33 is this exact pattern: statutory fees paid to a registry on the client's behalf, recovered at actual, alongside the firm's own fee.",
    );
  }

  if (!excluded && !PURE_AGENT_CAPABLE[args.kind]) {
    notes.push(
      `⚠️ ${DISBURSEMENT_LABELS[args.kind]} is recoverable from the client — it just is not a pure agent recovery. Bill it as part of the fee and let it bear tax at the same rate the fee does. The client was never liable to the third party for it, and that is the whole test.`,
    );
  }

  return {
    excludedFromValue: excluded,
    failedOn: failed,
    citation: RULE_33,
    reason: excluded
      ? `The firm paid ${formatMinor(
          args.paidMinor,
        )} to a third party on the client's authorisation and is recovering exactly that. All three conditions and all four limbs of the Explanation are met, so the recovery is excluded from the value of supply and bears no tax.`
      : `This recovery is NOT excluded from the value of supply. ${failed.length} requirement${
          failed.length === 1 ? "" : "s"
        } of Rule 33 ${failed.length === 1 ? "is" : "are"} not met, so the whole of ${formatMinor(
          args.recoveredMinor,
        )} is consideration for what the firm supplied.`,
    taxAtRiskMinor: taxAtRisk,
    notes,
  };
}

/* ------------------------------------------------------------------ */
/* THE FEE NOTE                                                        */
/* ------------------------------------------------------------------ */

export type FeeNoteLine = {
  kind: DisbursementKind;
  description: string;
  paidMinor: bigint;
  recoveredMinor: bigint;
  /** As stored — the database has already refused any markup on a true one. */
  isPureAgent: boolean;
};

export type FeeNoteTotals = {
  /** Professional fees, before tax. */
  feesMinor: bigint;
  /** ⭐ Excluded from value. Printed separately — Rule 33(ii). */
  pureAgentDisbursementsMinor: bigint;
  /** ⚠️ In the value of supply, taxed at the fee rate. */
  taxableRecoveriesMinor: bigint;
  /** The taxable value: fees + taxable recoveries. */
  taxableValueMinor: bigint;
  taxMinor: bigint;
  /** What the client actually pays. */
  totalPayableMinor: bigint;
  /** 🔴 Zero where the supply is exempt or on reverse charge. */
  taxRateBps: number;
};

/**
 * ⭐⭐ THE ARITHMETIC OF A LAWYER'S BILL, WHICH IS NOT THE ARITHMETIC OF
 *     ANY OTHER BILL IN ORDENCE.
 *
 * 🔴 Two things are different. The disbursements sit OUTSIDE the taxable
 * value and are added back at the end; and the tax rate is usually zero
 * because the client pays it, not the firm.
 *
 * ⚠️ A bill that adds the court fee into the fee total and prints one
 * number has failed Rule 33(ii) on the face of the document — which is
 * why this function returns the two totals separately and the fee note
 * prints them on separate lines.
 */
export function feeNoteTotals(args: {
  feesMinor: bigint;
  lines: readonly FeeNoteLine[];
  /** From `assessLegalCharge` — 0 for exempt and reverse charge. */
  taxRateBps: number;
}): FeeNoteTotals {
  if (args.feesMinor < 0n) {
    throw new DisbursementError("A fee cannot be negative.");
  }
  const rateBps = args.taxRateBps;
  if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10000) {
    throw new DisbursementError("A tax rate must be an integer between 0 and 10000 bps.");
  }

  let pureAgent = 0n;
  let taxableRecoveries = 0n;
  for (const l of args.lines) {
    if (l.recoveredMinor < 0n) {
      throw new DisbursementError("A recovery cannot be negative.");
    }
    if (l.isPureAgent) {
      if (l.recoveredMinor !== l.paidMinor) {
        /**
         * 🔴 Belt and braces. The constraint in 0059 makes this
         * unreachable through the product — but a bulk import, a
         * restored backup or a hand-written UPDATE could get past it,
         * and a fee note built on a false pure-agent line is a Rule 33
         * defect the firm would never see.
         */
        throw new DisbursementError(
          `A pure agent line must be recovered at actual. "${l.description}" was paid ${formatMinor(
            l.paidMinor,
          )} and is being recovered at ${formatMinor(l.recoveredMinor)}.`,
        );
      }
      pureAgent += l.recoveredMinor;
    } else {
      taxableRecoveries += l.recoveredMinor;
    }
  }

  const taxableValue = args.feesMinor + taxableRecoveries;
  const tax = (taxableValue * BigInt(rateBps)) / 10000n;

  return {
    feesMinor: args.feesMinor,
    pureAgentDisbursementsMinor: pureAgent,
    taxableRecoveriesMinor: taxableRecoveries,
    taxableValueMinor: taxableValue,
    taxMinor: tax,
    /** ⭐ Disbursements are added AFTER tax. They were never in the value. */
    totalPayableMinor: taxableValue + tax + pureAgent,
    taxRateBps: rateBps,
  };
}
