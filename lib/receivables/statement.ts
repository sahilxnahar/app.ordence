/**
 * Ordence — ⭐ Statement of Account
 * Version: v0.38.0-alpha
 *
 * Pure and isomorphic. Money is `bigint` paise.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE DOCUMENT A BUYER IS HANDED, AND WHAT THAT REQUIRES OF IT
 * ══════════════════════════════════════════════════════════════════════
 * Every argument about money on a flat ends with somebody asking for the
 * statement of account, and it is usually asked for at the worst moment:
 * a buyer who thinks they have paid, a broker sorting out a handover, a
 * lender before a tranche, an advocate before a complaint.
 *
 * So this is not a report. It is a document that has to survive being
 * read line by line by somebody who disagrees with it, which imposes
 * three requirements a dashboard does not have:
 *
 *   1. ⭐ IT MUST FOOT. Demanded − received = outstanding, exactly, with
 *      no reconciling item anybody has to be told about verbally. The
 *      builder ASSERTS this before returning; a statement that does not
 *      foot is worse than no statement, because the buyer finds the
 *      error and every other number becomes suspect.
 *   2. ⭐ EVERY LINE MUST BE TRACEABLE. Each receipt line names the
 *      demands it was applied to and why (`explanation`, from
 *      `receipt_allocations`), so "where did my ₹5,00,000 go?" is
 *      answered by the document rather than by a phone call.
 *   3. ⚠️ INTEREST IS SHOWN SEPARATELY AND ITS BASIS IS STATED. Folding
 *      interest into the outstanding column produces a figure that grows
 *      when nothing happened and that the buyer cannot reproduce.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY A CREDIT IS ON THE STATEMENT AND NOT NETTED OFF
 * ══════════════════════════════════════════════════════════════════════
 * An over-payment is the buyer's money sitting with the developer. Netting
 * it against an unrelated outstanding demand makes both numbers wrong: the
 * demand looks part-paid when nothing was appropriated to it, and the
 * credit disappears from view — which is how a buyer's ₹40,000 is
 * discovered two years later by their advocate rather than by the
 * developer.
 */

import { formatPaise } from "./numbers";
import { toCivilDay } from "./interest";
import { bucketForDaysOverdue, daysOverdue, type AgeingBucket } from "./ageing";

/* ------------------------------------------------------------------ */
/* INPUT                                                               */
/* ------------------------------------------------------------------ */

export type StatementDemand = {
  demandId: string;
  noticeNumber: string;
  noticeDate: string;
  dueDate: string;
  triggerLabel: string;
  status: string;
  principalMinor: bigint;
  taxMinor: bigint;
  totalMinor: bigint;
  allocatedMinor: bigint;
  interestAccruedMinor: bigint;
  interestPaidMinor: bigint;
  /** ⭐ The stated basis, in the buyer's language. Printed once per demand. */
  interestBasisNote: string;
};

export type StatementAllocation = {
  demandId: string;
  noticeNumber: string;
  amountMinor: bigint;
  principalMinor: bigint;
  taxMinor: bigint;
  interestMinor: bigint;
  explanation: string;
};

export type StatementReceipt = {
  receiptId: string;
  receiptNumber: string;
  receivedOn: string;
  amountMinor: bigint;
  tdsCreditMinor: bigint;
  allocatedMinor: bigint;
  method: string;
  status: string;
  instrumentRef?: string | null;
  allocations: readonly StatementAllocation[];
};

export type StatementInput = {
  asOf: string;
  buyerName: string;
  bookingReference: string;
  unitLabel: string;
  projectName: string;
  agreementValueMinor?: bigint | null;
  demands: readonly StatementDemand[];
  receipts: readonly StatementReceipt[];
};

/* ------------------------------------------------------------------ */
/* OUTPUT                                                              */
/* ------------------------------------------------------------------ */

export type StatementDemandLine = StatementDemand & {
  outstandingMinor: bigint;
  outstandingInterestMinor: bigint;
  daysOverdue: number;
  bucket: AgeingBucket;
};

export type StatementReceiptLine = StatementReceipt & {
  /** ⚠️ `amount + tdsCredit − allocated`. Money still on account. */
  unappliedMinor: bigint;
  /** False for a bounced or cancelled receipt — shown, never counted. */
  counted: boolean;
};

export type StatementTotals = {
  demandedMinor: bigint;
  demandedPrincipalMinor: bigint;
  demandedTaxMinor: bigint;
  receivedMinor: bigint;
  /** Section 194-IA tax the buyer paid to the Government on our behalf. */
  tdsCreditMinor: bigint;
  appliedMinor: bigint;
  outstandingMinor: bigint;
  interestAccruedMinor: bigint;
  interestPaidMinor: bigint;
  interestOutstandingMinor: bigint;
  creditMinor: bigint;
  payableTodayMinor: bigint;
};

export type Statement = {
  asOf: string;
  buyerName: string;
  bookingReference: string;
  unitLabel: string;
  projectName: string;
  agreementValueMinor: bigint | null;
  demands: StatementDemandLine[];
  receipts: StatementReceiptLine[];
  totals: StatementTotals;
  /** ⭐ The interest bases in force, de-duplicated. Printed on the document. */
  interestBases: string[];
  /** The whole thing as lines somebody can hand over. */
  narrative: string[];
};

export class StatementImbalanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StatementImbalanceError";
  }
}

/* ------------------------------------------------------------------ */
/* THE BUILD                                                           */
/* ------------------------------------------------------------------ */

export function buildStatement(input: StatementInput): Statement {
  const asOf = toCivilDay(input.asOf);

  let demandedMinor = 0n;
  let demandedPrincipal = 0n;
  let demandedTax = 0n;
  let appliedFromDemands = 0n;
  let interestAccrued = 0n;
  let interestPaid = 0n;

  const demandLines: StatementDemandLine[] = input.demands
    // ⚠️ CANCELLED AND SUPERSEDED DEMANDS ARE EXCLUDED FROM THE TOTALS AND
    // KEPT NOWHERE ELSE. They were withdrawn or replaced; including them
    // would demand the same money twice on the face of the statement,
    // which is the single most damaging error this document can contain.
    .filter((d) => d.status !== "cancelled" && d.status !== "superseded")
    .map((demand) => {
      const outstanding =
        demand.totalMinor - demand.allocatedMinor > 0n
          ? demand.totalMinor - demand.allocatedMinor
          : 0n;
      const outstandingInterest =
        demand.interestAccruedMinor - demand.interestPaidMinor > 0n
          ? demand.interestAccruedMinor - demand.interestPaidMinor
          : 0n;
      const late = daysOverdue(demand.dueDate, asOf);

      demandedMinor += demand.totalMinor;
      demandedPrincipal += demand.principalMinor;
      demandedTax += demand.taxMinor;
      appliedFromDemands += demand.allocatedMinor;
      interestAccrued += demand.interestAccruedMinor;
      interestPaid += demand.interestPaidMinor;

      return {
        ...demand,
        outstandingMinor: outstanding,
        outstandingInterestMinor: outstandingInterest,
        daysOverdue: late,
        bucket: bucketForDaysOverdue(late),
      };
    })
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  let receivedMinor = 0n;
  let tdsCreditMinor = 0n;
  let appliedFromReceipts = 0n;
  let creditMinor = 0n;

  const receiptLines: StatementReceiptLine[] = input.receipts
    .map((receipt) => {
      // ⚠️ A BOUNCED OR CANCELLED RECEIPT IS SHOWN AND NOT COUNTED. Hiding
      // it produces a statement the buyer disputes on sight — they have the
      // counterfoil — and counting it credits money that never arrived.
      const counted = receipt.status === "cleared" || receipt.status === "pending";
      const unapplied =
        receipt.amountMinor + receipt.tdsCreditMinor - receipt.allocatedMinor;

      if (counted) {
        receivedMinor += receipt.amountMinor;
        tdsCreditMinor += receipt.tdsCreditMinor;
        appliedFromReceipts += receipt.allocatedMinor;
        creditMinor += unapplied > 0n ? unapplied : 0n;
      }

      return { ...receipt, unappliedMinor: unapplied, counted };
    })
    .sort((a, b) => a.receivedOn.localeCompare(b.receivedOn));

  /* --- ⭐ IT MUST FOOT. ------------------------------------------ */
  //
  // The demand side and the receipt side each hold a number for "how much
  // has been applied". They are maintained by different code paths and
  // held in step by SQL 0027 §5 — so if they disagree HERE, the statement
  // is being built from rows that were written outside that guard, and
  // the right answer is to refuse to produce the document rather than to
  // print whichever number was reached first.
  //
  // ⚠️ THE COMPARISON INCLUDES THE INTEREST LEG, AND THE FIRST DRAFT DID
  // NOT. A demand's `allocated_minor` covers principal and tax only —
  // interest has its own column, because interest is income and the tax
  // element is money held for the Government, and a statement has to be
  // able to say how much of a payment was which. A receipt's
  // `allocated_minor` is the whole payment, all three legs. Comparing the
  // two directly makes every account with a paisa of interest on it look
  // like a corrupted one, which is the fastest way to teach everybody to
  // ignore this check.
  const appliedFromDemandsIncludingInterest = appliedFromDemands + interestPaid;

  if (appliedFromDemandsIncludingInterest !== appliedFromReceipts) {
    throw new StatementImbalanceError(
      `This statement cannot be produced: the demands record ` +
        `₹${formatPaise(appliedFromDemands)} of principal and tax plus ` +
        `₹${formatPaise(interestPaid)} of interest as received, and the receipts ` +
        `record ₹${formatPaise(appliedFromReceipts)} as applied. ` +
        `⚠️ The two are held in step by the database, so a difference means rows ` +
        `were written outside that guard. Do not hand this to a buyer — a ` +
        `statement that does not foot is found by the person it is handed to, and ` +
        `every other figure on it becomes suspect.`,
    );
  }

  const outstandingMinor =
    demandedMinor - appliedFromDemands > 0n ? demandedMinor - appliedFromDemands : 0n;
  const interestOutstanding =
    interestAccrued - interestPaid > 0n ? interestAccrued - interestPaid : 0n;

  const totals: StatementTotals = {
    demandedMinor,
    demandedPrincipalMinor: demandedPrincipal,
    demandedTaxMinor: demandedTax,
    receivedMinor,
    tdsCreditMinor,
    appliedMinor: appliedFromDemands,
    outstandingMinor,
    interestAccruedMinor: interestAccrued,
    interestPaidMinor: interestPaid,
    interestOutstandingMinor: interestOutstanding,
    creditMinor,
    // ⚠️ NET OF THE CREDIT, because that is the number the buyer should
    // actually transfer. Showing an amount that ignores their own money
    // sitting with us is the fastest way to have the whole document
    // rejected.
    payableTodayMinor:
      outstandingMinor + interestOutstanding - creditMinor > 0n
        ? outstandingMinor + interestOutstanding - creditMinor
        : 0n,
  };

  const interestBases = [
    ...new Set(demandLines.map((d) => d.interestBasisNote).filter((n) => n && n.trim())),
  ];

  return {
    asOf,
    buyerName: input.buyerName,
    bookingReference: input.bookingReference,
    unitLabel: input.unitLabel,
    projectName: input.projectName,
    agreementValueMinor: input.agreementValueMinor ?? null,
    demands: demandLines,
    receipts: receiptLines,
    totals,
    interestBases,
    narrative: narrate(input, demandLines, receiptLines, totals, interestBases, asOf),
  };
}

/* ------------------------------------------------------------------ */
/* THE DOCUMENT                                                        */
/* ------------------------------------------------------------------ */

function narrate(
  input: StatementInput,
  demands: readonly StatementDemandLine[],
  receipts: readonly StatementReceiptLine[],
  totals: StatementTotals,
  interestBases: readonly string[],
  asOf: string,
): string[] {
  const lines: string[] = [
    `STATEMENT OF ACCOUNT as at ${asOf}`,
    `${input.buyerName} — ${input.unitLabel}, ${input.projectName} (booking ${input.bookingReference})`,
    "",
  ];

  if (input.agreementValueMinor && input.agreementValueMinor > 0n) {
    lines.push(`Agreement value: ₹${formatPaise(input.agreementValueMinor)}`, "");
  }

  lines.push("DEMANDS RAISED");
  if (demands.length === 0) {
    lines.push("  None.");
  }
  for (const demand of demands) {
    lines.push(
      `  ${demand.noticeNumber}  ${demand.noticeDate}  ${demand.triggerLabel}`,
      `      Demanded ₹${formatPaise(demand.totalMinor)} (principal ₹${formatPaise(demand.principalMinor)}, GST ₹${formatPaise(demand.taxMinor)}), due ${demand.dueDate}`,
      `      Received ₹${formatPaise(demand.allocatedMinor)}, outstanding ₹${formatPaise(demand.outstandingMinor)}` +
        (demand.outstandingMinor > 0n ? ` (${demand.daysOverdue} days past due)` : ""),
    );
    if (demand.outstandingInterestMinor > 0n) {
      lines.push(
        `      Interest accrued and unpaid ₹${formatPaise(demand.outstandingInterestMinor)}`,
      );
    }
  }

  lines.push("", "AMOUNTS RECEIVED");
  if (receipts.length === 0) {
    lines.push("  None.");
  }
  for (const receipt of receipts) {
    lines.push(
      `  ${receipt.receiptNumber}  ${receipt.receivedOn}  ₹${formatPaise(receipt.amountMinor)}  ${receipt.method}` +
        (receipt.instrumentRef ? ` (${receipt.instrumentRef})` : "") +
        (receipt.counted ? "" : `  — ${receipt.status.toUpperCase()}, not counted`),
    );
    if (receipt.tdsCreditMinor > 0n) {
      lines.push(
        `      Plus ₹${formatPaise(receipt.tdsCreditMinor)} tax deducted at source under Section 194-IA and paid to the Government on our behalf`,
      );
    }
    // ⭐ THE TRACEABILITY REQUIREMENT. Each allocation carries the
    // sentence written when the money was applied.
    for (const allocation of receipt.allocations) {
      lines.push(`      ${allocation.explanation}`);
    }
    if (receipt.counted && receipt.unappliedMinor > 0n) {
      lines.push(
        `      ₹${formatPaise(receipt.unappliedMinor)} remains on account as a credit.`,
      );
    }
  }

  lines.push(
    "",
    "SUMMARY",
    `  Total demanded                     ₹${formatPaise(totals.demandedMinor)}`,
    `  Total received                     ₹${formatPaise(totals.receivedMinor)}`,
  );
  if (totals.tdsCreditMinor > 0n) {
    lines.push(
      `  Tax deducted at source (194-IA)    ₹${formatPaise(totals.tdsCreditMinor)}`,
    );
  }
  lines.push(
    `  Applied against demands            ₹${formatPaise(totals.appliedMinor)}`,
    `  Outstanding on demands             ₹${formatPaise(totals.outstandingMinor)}`,
    `  Interest accrued and unpaid        ₹${formatPaise(totals.interestOutstandingMinor)}`,
  );
  if (totals.creditMinor > 0n) {
    lines.push(
      `  Credit held on account             ₹${formatPaise(totals.creditMinor)}`,
    );
  }
  lines.push(
    `  PAYABLE AS AT ${asOf}          ₹${formatPaise(totals.payableTodayMinor)}`,
    "",
    // ⭐ THE FOOTING, WRITTEN OUT. A reader who wants to check the
    // document should not have to work out which numbers are supposed to
    // add up to which.
    `  Demanded ₹${formatPaise(totals.demandedMinor)} − applied ₹${formatPaise(totals.appliedMinor)} = outstanding ₹${formatPaise(totals.outstandingMinor)}.`,
  );

  if (interestBases.length > 0) {
    lines.push("", "BASIS OF INTEREST");
    for (const basis of interestBases) lines.push(`  ${basis}`);
  }

  lines.push(
    "",
    "If any entry on this statement is disputed, please write to us with the",
    "receipt or transfer reference and it will be reconciled before any further",
    "step is taken on the account.",
  );

  return lines;
}
