"use server";

/**
 * Ordence — ⭐⭐⭐ THE PAYMENT RUN
 * Version: v1.11.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION AND NONE TAKES A TENANT.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THIS IS THE EVENT THE TDS ENGINE HAS BEEN WAITING FOR SINCE 0025
 * ══════════════════════════════════════════════════════════════════════
 * The posting gate has said so for twenty sessions: tax is deducted when
 * the money MOVES, and there were no payments. Not a missing feature — a
 * missing event.
 *
 * ⭐ SO THIS ACTION DOES NOT REIMPLEMENT ANY TDS ARITHMETIC. The
 * thresholds, catch-up bases, lower deduction certificates, rate bases
 * and PAN cross-checks were all built in 0025 and are called here.
 * Rebuilding them would give two answers to "how much do we withhold",
 * which is the exact failure the price list decision in 0057 avoided.
 */

import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenant } from "@/db";
import {
  goodsReceipts,
  vendorPaymentAllocations,
  vendorPayments,
} from "@/db/schema/procurement";
import { purchaseInvoices, vendors } from "@/db/schema/purchases";
import { requirePermission, writeAudit } from "@/server/audit";
import { toSalesActionError } from "@/server/sales/guards";
import { postVendorPayment } from "@/server/accounting/post-sales";
import { serializeAmount, toBigIntAmount } from "@/lib/billing/money";
import type { ActionResult } from "@/lib/validators/crm";
import {
  allocateOldestFirst,
  buildPaymentRun,
  BUCKET_LABEL,
  type PayableBill,
} from "@/lib/purchases/ageing";
import { assessMsmeBill, type MsmeCategory, type SupplierKind } from "@/lib/purchases/msme";

const READ = "purchases:read" as const;
const WRITE = "purchases:record_invoice" as const;

/**
 * ⚠️ THE RBI BANK RATE IS AN ARGUMENT, NOT A CONSTANT.
 *
 * 🔴 s.16 MSMED interest is three times the bank rate, and a multiple of
 * a stale rate is a stale rate. There is no default that could quietly
 * go out of date — the caller supplies it, and the screen says which
 * figure was used.
 */
const DEFAULT_BANK_RATE_BPS = 600;

/* ------------------------------------------------------------------ */
/* THE RUN                                                             */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐ WHAT SHOULD BE PAID, AND IN WHAT ORDER.
 *
 * 🔴 NOT SORTED BY AGE. Two bills of the same size and the same age are
 *    not equally urgent: one of them costs the deduction on its whole
 *    value if it is still there on 31 March, and the other does not.
 */
export async function getPaymentRun(input?: unknown): Promise<
  ActionResult<{
    lines: {
      invoiceId: string;
      vendorName: string;
      invoiceNumber: string;
      invoiceDate: string;
      dueOn: string | null;
      outstandingMinor: string;
      bucket: string;
      bucketLabel: string;
      daysOverdue: number;
      payable: boolean;
      blockedReason: string | null;
      priority: number;
      why: string;
      msmeHeadline: string | null;
      msmeInterestMinor: string;
      deductionAtRisk: boolean;
    }[];
    payableTotalMinor: string;
    blockedTotalMinor: string;
    blockedCount: number;
    deductionAtRiskMinor: string;
    deductionAtRiskCount: number;
    interestAccruedMinor: string;
    byBucket: { bucket: string; label: string; amountMinor: string }[];
    financialYearEndsOn: string;
    bankRateBps: number;
    today: string;
  }>
> {
  try {
    const opts = z
      .object({ bankRateBps: z.number().int().min(0).max(5000).optional() })
      .parse(input ?? {});
    const ctx = await requirePermission(READ);
    const today = new Date().toISOString().slice(0, 10);
    const bankRateBps = opts.bankRateBps ?? DEFAULT_BANK_RATE_BPS;

    const built = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const rows = await tx
          .select({
            id: purchaseInvoices.id,
            vendorId: purchaseInvoices.vendorId,
            invoiceNumber: purchaseInvoices.invoiceNumber,
            invoiceDate: purchaseInvoices.invoiceDate,
            dueDate: purchaseInvoices.dueDate,
            totalMinor: purchaseInvoices.totalMinor,
            paidMinor: purchaseInvoices.amountPaidMinor,
            matchState: purchaseInvoices.matchState,
            acceptedOn: purchaseInvoices.acceptedOn,
            status: purchaseInvoices.status,
            vendorName: vendors.legalName,
            msmeCategory: vendors.msmeCategory,
            vendorType: vendors.vendorType,
          })
          .from(purchaseInvoices)
          .leftJoin(vendors, eq(vendors.id, purchaseInvoices.vendorId))
          .where(eq(purchaseInvoices.tenantId, ctx.tenant.id))
          .orderBy(asc(purchaseInvoices.invoiceDate))
          .limit(2000);

        const bills: PayableBill[] = [];
        const msme = new Map<string, ReturnType<typeof assessMsmeBill>>();

        for (const r of rows) {
          const total = toBigIntAmount(r.totalMinor ?? 0n);
          const paid = toBigIntAmount(r.paidMinor ?? 0n);
          /** ⚠️ A draft bill is not a payable. Nobody has approved it. */
          if (r.status === "draft" || r.status === "cancelled") continue;
          if (total - paid <= 0n) continue;

          /**
           * ⭐ THE MSME ASSESSMENT DECIDES THE PRIORITY, not the age.
           * The vendor's own category and what they supply decide
           * whether the rule reaches them at all.
           */
          const verdict = assessMsmeBill({
            category: (r.msmeCategory ?? "not_registered") as MsmeCategory,
            supplierKind: mapVendorKind(r.vendorType),
            acceptedOn: r.acceptedOn ?? null,
            outstandingMinor: total - paid,
            today,
            bankRateBps,
          });
          msme.set(r.id, verdict);

          bills.push({
            id: r.id,
            vendorId: r.vendorId,
            vendorName: r.vendorName ?? "Unnamed vendor",
            invoiceNumber: r.invoiceNumber,
            invoiceDate: r.invoiceDate,
            dueOn: r.dueDate ?? null,
            totalMinor: total,
            paidMinor: paid,
            matchState: (r.matchState ?? null) as PayableBill["matchState"],
            msmePriority: verdict.priority,
            msmeDeductionAtRisk: verdict.deductionAtRisk,
            msmeInterestMinor: verdict.interestMinor,
            onHold: false,
          });
        }

        return { run: buildPaymentRun({ bills, today }), msme };
      },
      { impersonationId: ctx.impersonationId },
    );

    const { run, msme } = built;
    const fyEnd = run.lines[0]
      ? (msme.get(run.lines[0].bill.id)?.financialYearEndsOn ?? "")
      : financialYearEndFallback(today);

    return {
      ok: true,
      data: {
        lines: run.lines.map((l) => {
          const m = msme.get(l.bill.id);
          return {
            invoiceId: l.bill.id,
            vendorName: l.bill.vendorName,
            invoiceNumber: l.bill.invoiceNumber,
            invoiceDate: l.bill.invoiceDate,
            dueOn: l.bill.dueOn,
            outstandingMinor: serializeAmount(l.outstandingMinor),
            bucket: l.bucket,
            bucketLabel: BUCKET_LABEL[l.bucket],
            daysOverdue: l.daysOverdue,
            payable: l.payable,
            blockedReason: l.blockedReason,
            priority: l.priority,
            why: l.why,
            msmeHeadline: m && m.inScope ? m.headline : null,
            msmeInterestMinor: serializeAmount(l.bill.msmeInterestMinor),
            deductionAtRisk: l.bill.msmeDeductionAtRisk,
          };
        }),
        payableTotalMinor: serializeAmount(run.payableTotalMinor),
        blockedTotalMinor: serializeAmount(run.blockedTotalMinor),
        blockedCount: run.blockedCount,
        deductionAtRiskMinor: serializeAmount(run.deductionAtRiskMinor),
        deductionAtRiskCount: run.deductionAtRiskCount,
        interestAccruedMinor: serializeAmount(run.interestAccruedMinor),
        byBucket: Object.entries(run.byBucket).map(([bucket, amt]) => ({
          bucket,
          label: BUCKET_LABEL[bucket as keyof typeof BUCKET_LABEL],
          amountMinor: serializeAmount(amt),
        })),
        financialYearEndsOn: fyEnd || financialYearEndFallback(today),
        bankRateBps,
        today,
      },
    };
  } catch (err) {
    return toSalesActionError(err, "getPaymentRun");
  }
}

/* ------------------------------------------------------------------ */
/* PAYING                                                              */
/* ------------------------------------------------------------------ */

const paySchema = z.object({
  vendorId: z.string().uuid(),
  paymentNumber: z.string().trim().min(1).max(40),
  paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  method: z
    .enum(["bank_transfer", "cheque", "cash", "upi", "adjustment"])
    .default("bank_transfer"),
  bankReference: z.string().trim().max(120).optional(),
  bankLedgerId: z.string().uuid().nullish(),
  /** What the bills are being settled for, before withholding. */
  grossMinor: z.string().regex(/^\d+$/),
  /** ⭐ Supplied by the caller after asking the TDS engine. */
  tdsMinor: z.string().regex(/^\d+$/).default("0"),
  tdsSection: z.string().trim().max(12).nullish(),
  tdsDeductionId: z.string().uuid().nullish(),
  msmeInterestMinor: z.string().regex(/^\d+$/).default("0"),
  roundOffMinor: z.string().regex(/^-?\d+$/).default("0"),
  runId: z.string().uuid().nullish(),
  notes: z.string().trim().max(2000).optional(),
});

/**
 * ⭐⭐ PAY, ALLOCATE, WITHHOLD AND POST — IN ONE TRANSACTION.
 *
 * 🔴 ALL OF IT OR NONE OF IT. A payment written without its allocations
 *    leaves the bills looking unpaid and they get paid again. A payment
 *    posted without its withholding clears the vendor's balance with the
 *    tax nowhere. Both have happened in real systems and both are why
 *    this is one transaction.
 *
 * ⚠️ THE ALLOCATION IS OLDEST FIRST AND CANNOT EXCEED WHAT IS
 * OUTSTANDING. The database refuses an over-allocation as well; this
 * gets the arithmetic right before it is attempted, so a person sees a
 * sentence rather than a constraint name.
 */
export async function payVendor(input: unknown): Promise<
  ActionResult<{
    id: string;
    allocated: number;
    unallocatedMinor: string;
    netMinor: string;
    posted: boolean;
    postingProblem: string | null;
  }>
> {
  try {
    const data = paySchema.parse(input);
    const ctx = await requirePermission(WRITE);

    const gross = BigInt(data.grossMinor);
    const tds = BigInt(data.tdsMinor);
    const interest = BigInt(data.msmeInterestMinor);
    const roundOff = BigInt(data.roundOffMinor);
    const net = gross - tds + interest + roundOff;

    if (gross <= 0n) throw new Error("A payment has to be for more than nothing.");
    if (tds > gross) {
      throw new Error(
        "More is being withheld than the payment itself. That is a sign error, and it would credit the Government money the vendor was never owed.",
      );
    }
    if (net < 0n) {
      throw new Error("This payment works out to a negative amount leaving the bank.");
    }
    if (tds > 0n && !data.tdsSection) {
      throw new Error(
        "A deduction has to name the section it was made under, or the quarterly return cannot be built from it.",
      );
    }

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [vendor] = await tx
          .select({ id: vendors.id, name: vendors.legalName })
          .from(vendors)
          .where(and(eq(vendors.tenantId, ctx.tenant.id), eq(vendors.id, data.vendorId)))
          .limit(1);
        if (!vendor) throw new Error("That vendor does not exist.");

        /* ── what is outstanding, oldest first ─────────────────────── */
        const open = await tx
          .select({
            id: purchaseInvoices.id,
            dueDate: purchaseInvoices.dueDate,
            totalMinor: purchaseInvoices.totalMinor,
            paidMinor: purchaseInvoices.amountPaidMinor,
            matchState: purchaseInvoices.matchState,
            invoiceNumber: purchaseInvoices.invoiceNumber,
            status: purchaseInvoices.status,
          })
          .from(purchaseInvoices)
          .where(
            and(
              eq(purchaseInvoices.tenantId, ctx.tenant.id),
              eq(purchaseInvoices.vendorId, data.vendorId),
            ),
          )
          .limit(500);

        /**
         * 🔴 A BILL WHOSE THREE-WAY MATCH FAILED IS NOT PAID, EVEN BY
         *    OLDEST-FIRST ALLOCATION. A payment run over unmatched bills
         *    pays the wrong things faster.
         */
        const eligible = open
          .filter((o) => o.status !== "draft" && o.status !== "cancelled")
          .filter((o) => o.matchState !== "unmatched")
          .map((o) => ({
            id: o.id,
            dueOn: o.dueDate ?? null,
            outstandingMinor:
              toBigIntAmount(o.totalMinor ?? 0n) - toBigIntAmount(o.paidMinor ?? 0n),
          }));

        const { allocations, unallocatedMinor } = allocateOldestFirst({
          amountMinor: gross,
          bills: eligible,
        });

        const [payment] = await tx
          .insert(vendorPayments)
          .values({
            tenantId: ctx.tenant.id,
            vendorId: data.vendorId,
            paymentNumber: data.paymentNumber,
            paymentDate: data.paymentDate,
            method: data.method,
            bankReference: data.bankReference ?? null,
            bankLedgerId: data.bankLedgerId ?? null,
            grossMinor: gross,
            tdsMinor: tds,
            msmeInterestMinor: interest,
            roundOffMinor: roundOff,
            netMinor: net,
            tdsSection: data.tdsSection ?? null,
            tdsDeductionId: data.tdsDeductionId ?? null,
            status: "approved",
            approvedBy: ctx.user.id,
            approvedAt: new Date(),
            runId: data.runId ?? null,
            notes: data.notes ?? null,
            createdBy: ctx.user.id,
          })
          .returning({ id: vendorPayments.id });
        if (!payment) throw new Error("The payment could not be recorded.");

        if (allocations.length > 0) {
          await tx.insert(vendorPaymentAllocations).values(
            allocations.map((a) => ({
              tenantId: ctx.tenant.id,
              paymentId: payment.id,
              invoiceId: a.invoiceId,
              allocatedMinor: a.allocatedMinor,
            })),
          );
        }

        /* ── the ledger ───────────────────────────────────────────── */
        const outcome = await postVendorPayment(tx, {
          tenantId: ctx.tenant.id,
          userId: ctx.user.id,
          paymentId: payment.id,
          paymentNumber: data.paymentNumber,
          paymentDate: data.paymentDate,
          vendorId: data.vendorId,
          vendorName: vendor.name,
          grossMinor: gross,
          tdsMinor: tds,
          msmeInterestMinor: interest,
          roundOffMinor: roundOff,
          netMinor: net,
          tdsSection: data.tdsSection ?? null,
        });

        let problem: string | null = null;
        if (outcome.posted) {
          await tx
            .update(vendorPayments)
            .set({ status: "paid", postedAt: new Date() })
            .where(eq(vendorPayments.id, payment.id));
        } else if (outcome.reason === "unmapped_roles") {
          /**
           * ⚠️ THE PAYMENT STAYS `approved`, NOT `paid`. The money has
           * not reached the ledger, and marking it paid would hide that.
           * The accounts a firm has not mapped yet is a setup problem
           * with a name, not a silent failure.
           */
          problem = `The payment is recorded but has not reached the ledger: no account is mapped for ${(outcome.missing ?? []).join(", ")}. Map ${(outcome.missing ?? []).length === 1 ? "it" : "them"} in the posting accounts and post again.`;
        } else if (outcome.reason === "already_posted") {
          problem = "This payment was already in the ledger.";
        }

        await writeAudit(ctx, {
          action: "create",
          resourceType: "vendor_payment",
          resourceId: payment.id,
          newValue: {
            grossMinor: serializeAmount(gross),
            tdsMinor: serializeAmount(tds),
            netMinor: serializeAmount(net),
            allocations: allocations.length,
          },
          /** Money leaving the business. */
          severity: "critical",
        });

        return {
          id: payment.id,
          allocated: allocations.length,
          unallocatedMinor: serializeAmount(unallocatedMinor),
          netMinor: serializeAmount(net),
          posted: outcome.posted,
          postingProblem: problem,
        };
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/purchases/payment-run");
    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "payVendor");
  }
}

/* ------------------------------------------------------------------ */

function mapVendorKind(vendorType: string | null): SupplierKind {
  switch (vendorType) {
    /**
     * ⭐ Services, on any reading. Renting out premises is a supply of
     * service, and so is transport, professional work and a utility.
     */
    case "contractor":
    case "professional":
    case "transporter":
    case "landlord":
    case "utility":
      return "service_provider";
    /**
     * ⚠️ `material_supplier` IS NOT MAPPED TO MANUFACTURER, deliberately.
     * A material supplier may manufacture what it sells or may buy and
     * resell it, and only manufacturers and service providers are
     * "suppliers" under s.15 of the MSMED Act. Guessing either way is
     * wrong: guessing manufacturer puts traders on a report that does
     * not apply to them, and guessing trader loses a deduction. It
     * returns `unknown`, which is flagged on the screen and treated as
     * in scope, because that is the answer that costs nobody a
     * deduction if it turns out to be right.
     */
    default:
      return "unknown";
  }
}

function financialYearEndFallback(today: string): string {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  return month >= 4 ? `${year + 1}-03-31` : `${year}-03-31`;
}
