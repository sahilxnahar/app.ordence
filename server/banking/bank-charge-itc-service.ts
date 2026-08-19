import "server-only";

/**
 * Ordence — ⭐⭐⭐ THE DATABASE HALF OF THE BANK-CHARGE INPUT CREDIT
 * Version: v1.67.0-alpha (Batch 0110)
 *
 * The argument for why the rate is never derived, configured or
 * defaulted lives in `lib/banking/bank-charge-itc.ts`. This file is the
 * part that knows what a table is.
 *
 * ⭐ `import "server-only"` AND EVERY FUNCTION TAKES A `tx`, for the same
 * reason as the rest of `server/banking/`: the deferral row and the
 * journal it belongs to have to commit or fail together. A charge posted
 * without its deferral is a credit nobody will ever be told about, which
 * is the defect this whole file exists to end.
 */

import { and, desc, eq } from "drizzle-orm";
import type { withTenant } from "@/db";
import { bankChargeItcDeferrals } from "@/db/schema/banking";
import {
  claimableCreditMinor,
  postingRefusal,
  taxPeriodOf,
  totalByPeriod,
  transcriptionRefusal,
  type DeferralRow,
  type ItcDeferralStatus,
  type ItcPeriodTotals,
  type TranscribedTaxInvoice,
} from "@/lib/banking/bank-charge-itc";
import { describeGstinProblem } from "@/lib/gst/gstin";
import { postBankChargeItc } from "@/server/accounting/post-sales";

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

/* ------------------------------------------------------------------ */
/* WRITING THE DEFERRAL AT THE MOMENT THE CHARGE IS POSTED             */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐ CALLED FROM INSIDE `postBankLineAdjustment`'S TRANSACTION.
 *
 * 🔴 ONLY FOR `bank_charge`. Interest credited is money the bank GAVE
 *    us; it is our income, not a supply to us, so there is no input
 *    credit to defer and a row here would be a permanent zero that makes
 *    the register look half wrong. Interest is also exempt in the other
 *    direction — Notification 12/2017-Central Tax (Rate), entry 27 —
 *    which is a fact about the bank's supply, not about ours.
 *
 * ⚠️ RETURNS THE ROW ID SO THE AUDIT ENTRY CAN NAME IT. A deferral
 *    created invisibly is one nobody can trace back to the charge.
 */
export async function deferBankChargeCredit(
  tx: Tx,
  args: {
    tenantId: string;
    bankAccountId: string;
    statementLineId: string;
    transactionId: string;
    /** 🔴 POSITIVE MAGNITUDE. What the bank took. */
    grossMinor: bigint;
    valueDate: string;
  },
): Promise<{ deferralId: string; taxPeriod: string }> {
  const taxPeriod = taxPeriodOf(args.valueDate);

  const [row] = await tx
    .insert(bankChargeItcDeferrals)
    .values({
      tenantId: args.tenantId,
      bankAccountId: args.bankAccountId,
      statementLineId: args.statementLineId,
      transactionId: args.transactionId,
      grossMinor: args.grossMinor,
      valueDate: args.valueDate,
      taxPeriod,
      status: "awaiting_invoice",
    })
    .returning({ id: bankChargeItcDeferrals.id });

  if (!row) {
    throw new Error(
      "The bank charge was posted but the deferred input credit could not be recorded. Neither has been written.",
    );
  }

  return { deferralId: row.id as string, taxPeriod };
}

/* ------------------------------------------------------------------ */
/* 🔴🔴 READING IT BACK — THE PART THAT CHANGES WHAT A SCREEN SAYS      */
/* ------------------------------------------------------------------ */

function toDeferralRow(r: Record<string, unknown>): DeferralRow {
  const status = r.status as ItcDeferralStatus;
  /**
   * ⭐ THE CREDIT IS ZERO UNLESS AN INVOICE WAS ACTUALLY RECORDED, AND
   * IT IS DERIVED FROM THE STORED TAX HEADS RATHER THAN STORED SEPARATELY.
   *
   * ⚠️ A stored `credit_minor` alongside the four heads would be a fifth
   * figure that can disagree with the sum of the other four, and the one
   * that disagrees is the one a return quotes.
   */
  const head = (value: unknown): bigint =>
    value === null || value === undefined
      ? 0n
      : BigInt(value as string | number | bigint);

  const credit =
    status === "invoice_recorded"
      ? head(r.cgstMinor) + head(r.sgstMinor) + head(r.igstMinor) + head(r.cessMinor)
      : 0n;

  return {
    id: r.id as string,
    statementLineId: r.statementLineId as string,
    valueDate: String(r.valueDate),
    taxPeriod: r.taxPeriod as string,
    grossMinor: BigInt(r.grossMinor as string | bigint),
    status,
    creditMinor: credit,
    invoiceNo: (r.invoiceNo as string | null) ?? null,
    /**
     * ⭐ 0112. Serialised, because `DeferralRow` is read by a client
     * component and a `Date` does not survive the boundary intact.
     */
    creditPostedAt:
      r.creditPostedAt instanceof Date
        ? r.creditPostedAt.toISOString()
        : ((r.creditPostedAt as string | null) ?? null),
    creditTransactionId: (r.creditTransactionId as string | null) ?? null,
  };
}

export async function loadDeferrals(
  tx: Tx,
  tenantId: string,
  bankAccountId?: string,
): Promise<readonly DeferralRow[]> {
  const rows = await tx
    .select()
    .from(bankChargeItcDeferrals)
    .where(
      bankAccountId === undefined
        ? eq(bankChargeItcDeferrals.tenantId, tenantId)
        : and(
            eq(bankChargeItcDeferrals.tenantId, tenantId),
            eq(bankChargeItcDeferrals.bankAccountId, bankAccountId),
          ),
    )
    .orderBy(desc(bankChargeItcDeferrals.valueDate));

  return rows.map((r: Record<string, unknown>) => toDeferralRow(r));
}

/**
 * ⭐⭐⭐ THE REGISTER, TOTALLED PER TAX PERIOD.
 *
 * 🔴 `status` DECIDES WHICH OF THE THREE BUCKETS EACH ROW LANDS IN, and
 *    the three buckets are three different instructions to the person
 *    reading them. That is the read that makes the column mean something
 *    rather than merely exist.
 */
export async function itcRegisterTotals(
  tx: Tx,
  tenantId: string,
): Promise<readonly ItcPeriodTotals[]> {
  return totalByPeriod(await loadDeferrals(tx, tenantId));
}

/** ⚠️ One period, for the reconciliation screen's footer. */
export async function itcTotalsForPeriod(
  tx: Tx,
  tenantId: string,
  taxPeriod: string,
): Promise<ItcPeriodTotals | null> {
  const all = await itcRegisterTotals(tx, tenantId);
  return all.find((t) => t.taxPeriod === taxPeriod) ?? null;
}

/* ------------------------------------------------------------------ */
/* 🔴 CLOSING ONE OUT                                                  */
/* ------------------------------------------------------------------ */

export class ItcDeferralRefusal extends Error {}

/**
 * ⭐⭐ RECORD THE BANK'S TAX INVOICE AGAINST ONE CHARGE.
 *
 * ⚠️ THE GROSS COMES FROM THE STORED ROW, NEVER FROM THE FORM. A form
 * that supplies both the gross and the split can be made to foot against
 * itself, and a check that always passes is not a check.
 *
 * 🔴 THE ROW MUST STILL BE `awaiting_invoice`. Re-recording an invoice
 *    over one already recorded would change a figure a GSTR-3B may
 *    already quote, with no record that it moved.
 */
export async function recordTaxInvoice(
  tx: Tx,
  args: {
    tenantId: string;
    userId: string;
    deferralId: string;
    invoice: TranscribedTaxInvoice;
  },
): Promise<{ creditMinor: bigint; taxPeriod: string }> {
  const [row] = await tx
    .select()
    .from(bankChargeItcDeferrals)
    .where(
      and(
        eq(bankChargeItcDeferrals.tenantId, args.tenantId),
        eq(bankChargeItcDeferrals.id, args.deferralId),
      ),
    )
    .limit(1);

  if (!row) throw new ItcDeferralRefusal("No such bank charge in the register.");

  if (row.status !== "awaiting_invoice") {
    throw new ItcDeferralRefusal(
      row.status === "invoice_recorded"
        ? `This charge already has invoice ${row.invoiceNo ?? "(unnumbered)"} recorded against it. Changing it would move a credit figure a return may already quote, with no record that it moved. If the first entry was wrong, that is a correction with a reason and it needs one.`
        : "This charge was marked not claimable, with a reason. Reverse that decision before recording an invoice against it, so the register shows the decision was changed rather than that it never happened.",
    );
  }

  const problem = transcriptionRefusal({
    grossMinor: BigInt(row.grossMinor as string | bigint),
    invoice: args.invoice,
    gstinProblem: describeGstinProblem(args.invoice.supplierGstin)?.message ?? null,
    chargeValueDate: String(row.valueDate),
  });

  if (problem !== null) throw new ItcDeferralRefusal(problem);

  await tx
    .update(bankChargeItcDeferrals)
    .set({
      status: "invoice_recorded",
      invoiceNo: args.invoice.invoiceNo.trim(),
      invoiceDate: args.invoice.invoiceDate,
      supplierGstin: args.invoice.supplierGstin.trim().toUpperCase(),
      taxableValueMinor: args.invoice.taxableValueMinor,
      cgstMinor: args.invoice.cgstMinor,
      sgstMinor: args.invoice.sgstMinor,
      igstMinor: args.invoice.igstMinor,
      cessMinor: args.invoice.cessMinor,
      resolvedAt: new Date(),
      resolvedBy: args.userId,
    })
    .where(
      and(
        eq(bankChargeItcDeferrals.tenantId, args.tenantId),
        eq(bankChargeItcDeferrals.id, args.deferralId),
      ),
    );

  return {
    creditMinor: claimableCreditMinor(args.invoice),
    taxPeriod: row.taxPeriod as string,
  };
}

/**
 * ⭐ THE OTHER WAY OUT: SOMEBODY DECIDES, AND SAYS WHY.
 *
 * ⚠️ A CHARGE THAT WILL NEVER CARRY A CLAIMABLE CREDIT HAS TO LEAVE THE
 * "chase the bank" LIST, or the list stops being read. But it must not
 * leave silently: an exempt supply and a blocked credit under s.17(5)
 * are different facts, and both are different from an oversight.
 */
export async function markNotClaimable(
  tx: Tx,
  args: {
    tenantId: string;
    userId: string;
    deferralId: string;
    reason: string;
  },
): Promise<{ taxPeriod: string }> {
  const [row] = await tx
    .select({
      id: bankChargeItcDeferrals.id,
      status: bankChargeItcDeferrals.status,
      taxPeriod: bankChargeItcDeferrals.taxPeriod,
    })
    .from(bankChargeItcDeferrals)
    .where(
      and(
        eq(bankChargeItcDeferrals.tenantId, args.tenantId),
        eq(bankChargeItcDeferrals.id, args.deferralId),
      ),
    )
    .limit(1);

  if (!row) throw new ItcDeferralRefusal("No such bank charge in the register.");

  if (row.status === "invoice_recorded") {
    throw new ItcDeferralRefusal(
      "An invoice has already been recorded against this charge and the credit on it is a known amount. Marking it not claimable now would hide a figure that has been identified, which is a different act from never having identified one.",
    );
  }

  await tx
    .update(bankChargeItcDeferrals)
    .set({
      status: "not_claimable",
      notClaimableReason: args.reason,
      resolvedAt: new Date(),
      resolvedBy: args.userId,
    })
    .where(
      and(
        eq(bankChargeItcDeferrals.tenantId, args.tenantId),
        eq(bankChargeItcDeferrals.id, args.deferralId),
      ),
    );

  return { taxPeriod: row.taxPeriod as string };
}

/* ------------------------------------------------------------------ */
/* ⭐⭐⭐ POSTING THE CREDIT — 0112                                     */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐⭐ WRITE THE JOURNAL AND STAMP THE ROW, OR DO NEITHER.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 ONE TRANSACTION, AND THAT IS THE WHOLE POINT OF THIS FUNCTION
 * ══════════════════════════════════════════════════════════════════════
 * A journal written without the stamp is a credit in the ledger that the
 * register still shows as outstanding, so the next person posts it again
 * — and the idempotency key would stop the second posting but NOT the
 * second attempt, so the operator sees "already posted" against a row
 * that says it is not. A stamp written without the journal is worse: the
 * register reports a credit as claimed and the trial balance never took
 * it.
 *
 * ⚠️ `postBankChargeItc` TAKES THE SAME `tx`. Both writes are inside the
 * caller's `withTenant`, so they commit or fail together.
 *
 * ⭐ AND THE REFUSAL IS ASKED BEFORE ANYTHING IS WRITTEN, in
 * `lib/banking/bank-charge-itc.ts`, which is the same function the button
 * calls to decide whether to be enabled. The database refuses these too;
 * this is so the person is told in a sentence rather than by a constraint.
 */
export async function postIdentifiedCredit(
  tx: Tx,
  args: {
    tenantId: string;
    userId: string;
    deferralId: string;
  },
): Promise<
  | { posted: true; transactionId: string; creditMinor: bigint; taxPeriod: string }
  | { posted: false; reason: "period_closed"; period: string }
  | { posted: false; reason: "unmapped_roles"; missing: readonly string[] }
  | { posted: false; reason: "already_posted" }
> {
  const [row] = await tx
    .select()
    .from(bankChargeItcDeferrals)
    .where(
      and(
        eq(bankChargeItcDeferrals.tenantId, args.tenantId),
        eq(bankChargeItcDeferrals.id, args.deferralId),
      ),
    )
    .limit(1);

  if (!row) throw new ItcDeferralRefusal("No such bank charge in the register.");

  const mapped = toDeferralRow(row as Record<string, unknown>);
  const refusal = postingRefusal(mapped);
  if (refusal !== null) throw new ItcDeferralRefusal(refusal);

  const head = (v: unknown): bigint =>
    v === null || v === undefined ? 0n : BigInt(v as string | number | bigint);

  const outcome = await postBankChargeItc(tx, {
    tenantId: args.tenantId,
    userId: args.userId,
    deferralId: args.deferralId,
    cgstMinor: head(row.cgstMinor),
    sgstMinor: head(row.sgstMinor),
    igstMinor: head(row.igstMinor),
    cessMinor: head(row.cessMinor),
    /**
     * 🔴 THE BANK'S INVOICE DATE, NEVER `value_date` AND NEVER TODAY. The
     * charge was posted on the value date because that is when the money
     * left. The CREDIT arises when the invoice exists — s.16(2)(a) — and
     * that is usually a later month. Dating this back to the charge would
     * claim the credit in a period the taxpayer was not entitled to it in.
     */
    invoiceDate: String(row.invoiceDate),
    invoiceNo: String(row.invoiceNo),
    supplierGstin: String(row.supplierGstin),
  });

  if (!outcome.posted) {
    /**
     * ⚠️ `already_posted` REACHED THROUGH THE KEY RATHER THAN THE STAMP
     * MEANS THE TWO HAVE COME APART — a journal exists under this
     * deferral's key and `credit_posted_at` is NULL, which the paragraph
     * at the top of this function says must not happen. It is reported
     * rather than swallowed, because a register that quietly re-syncs
     * itself hides the fact that it once did not.
     */
    if (outcome.reason === "already_posted") return { posted: false, reason: "already_posted" };
    if (outcome.reason === "period_closed") {
      return { posted: false, reason: "period_closed", period: outcome.period };
    }
    if (outcome.reason === "unmapped_roles") {
      return { posted: false, reason: "unmapped_roles", missing: outcome.missing };
    }
    /**
     * 🔴 `nothing_to_post` IS UNREACHABLE HERE AND IS STILL HANDLED.
     * `writePosting` returns it when the legs are empty;
     * `buildBankChargeItcPosting` throws on a zero credit before it can
     * return an empty set, and `postingRefusal` above refuses the same
     * case with a sentence first. Falling through to a "credit posted"
     * result on a branch nobody expects is how a register comes to say
     * something is in the ledger when it is not.
     */
    throw new ItcDeferralRefusal(
      `The ledger refused this posting with "${outcome.reason}", which this screen has no sentence for. Nothing was written. Report this rather than retrying.`,
    );
  }

  const transactionId = outcome.transactionId;

  await tx
    .update(bankChargeItcDeferrals)
    .set({
      creditTransactionId: transactionId,
      creditPostedAt: new Date(),
      creditPostedBy: args.userId,
      resolvedAt: new Date(),
      resolvedBy: args.userId,
    })
    .where(
      and(
        eq(bankChargeItcDeferrals.tenantId, args.tenantId),
        eq(bankChargeItcDeferrals.id, args.deferralId),
      ),
    );

  return {
    posted: true,
    transactionId,
    creditMinor: mapped.creditMinor,
    taxPeriod: row.taxPeriod as string,
  };
}
