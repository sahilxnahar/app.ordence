"use server";

/**
 * Ordence — ⭐⭐ POST-SUPPLY DISCOUNTS · SECTION 15(3)
 * Version: v1.6.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION AND NONE TAKES A TENANT. The
 * reasoning lives in `lib/gst/discounts.ts`, which is pure.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE VERDICT IS COMPUTED ONCE AND STORED, DELIBERATELY
 * ══════════════════════════════════════════════════════════════════════
 * Whether a rebate could reduce tax is a conclusion about facts as they
 * stood on a date. Re-deriving it next year, against an agreement
 * somebody has since edited, would give a different answer to the one
 * that was acted on — and the one that was acted on is the one on a
 * filed return.
 */

import { and, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenant } from "@/db";
import {
  priceAgreements,
  postSupplyDiscounts,
  postSupplyDiscountInvoices,
} from "@/db/schema/pricing";
import { salesInvoices } from "@/db/schema/sales-invoices";
import { companies } from "@/db/schema/crm";
import { requirePermission, writeAudit } from "@/server/audit";
import { toSalesActionError } from "@/server/sales/guards";
import {
  allocateRebate,
  assessPostSupplyDiscount,
  earliestSupplyDate,
  rebateForTurnover,
  type InvoiceShare,
  type RebateSlab,
} from "@/lib/gst/discounts";
import { serializeAmount, toBigIntAmount } from "@/lib/billing/money";
import type { ActionResult } from "@/lib/validators/crm";

const READ = "sales.invoices.read" as const;
const WRITE = "sales.invoices.create" as const;

const civilDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");

/* ================================================================== */
/* ① THE AGREEMENT                                                     */
/* ================================================================== */

const agreementSchema = z.object({
  companyId: z.string().uuid(),
  referenceNo: z.string().trim().min(1).max(60),
  title: z.string().trim().min(1).max(255),
  /** 🔴 The date everything turns on. */
  agreementDate: civilDay,
  effectiveFrom: civilDay,
  effectiveTo: civilDay.optional(),
  discountKind: z
    .enum(["turnover_rebate", "quantity_rebate", "target", "other"])
    .default("turnover_rebate"),
  slabs: z
    .array(
      z.object({
        fromTurnoverMinor: z.string().regex(/^\d+$/),
        rateBps: z.number().int().min(0).max(10000),
      }),
    )
    .default([]),
  notes: z.string().trim().max(2000).optional(),
});

/**
 * ⭐ RECORD THE AGREEMENT.
 *
 * 🔴 IT WARNS WHEN THE AGREEMENT IS DATED AFTER THE PERIOD IT COVERS,
 *    AND IT DOES NOT REFUSE. Businesses really do sign a rebate letter
 *    in December for the year just finished — that arrangement is
 *    entirely lawful and simply cannot reduce GST. Refusing the record
 *    would make the product unusable for the arrangement most trading
 *    firms actually have; staying silent would let somebody claim a tax
 *    reduction they are not entitled to.
 */
export async function savePriceAgreement(
  input: unknown,
): Promise<ActionResult<{ id: string; qualifiesForTaxAdjustment: boolean; note: string }>> {
  try {
    const data = agreementSchema.parse(input);
    const ctx = await requirePermission(WRITE);

    /**
     * ⚠️ TESTED AGAINST THE START OF THE PERIOD, not the end. An
     * agreement signed on 1 October covers October onwards and does
     * nothing for April.
     */
    const inTime = data.agreementDate <= data.effectiveFrom;

    const id = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [row] = await tx
          .insert(priceAgreements)
          .values({
            tenantId: ctx.tenant.id,
            companyId: data.companyId,
            referenceNo: data.referenceNo,
            title: data.title,
            agreementDate: data.agreementDate,
            effectiveFrom: data.effectiveFrom,
            effectiveTo: data.effectiveTo ?? null,
            discountKind: data.discountKind,
            slabs: data.slabs,
            notes: data.notes ?? null,
            status: "active",
            createdBy: ctx.user.id,
            updatedBy: ctx.user.id,
          })
          .returning({ id: priceAgreements.id });
        if (!row) throw new Error("The agreement could not be saved.");

        await writeAudit(ctx, {
          action: "create",
          resourceType: "price_agreement",
          resourceId: row.id,
          newValue: {
            referenceNo: data.referenceNo,
            agreementDate: data.agreementDate,
            effectiveFrom: data.effectiveFrom,
            qualifiesForTaxAdjustment: inTime,
          },
          /** The date on this record decides whether tax can be recovered. */
          severity: "critical",
        });

        return row.id;
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/gst/discounts");
    return {
      ok: true,
      data: {
        id,
        qualifiesForTaxAdjustment: inTime,
        note: inTime
          ? "The agreement predates the period it covers, so rebates under it can reduce the GST on those supplies — provided each rebate is linked to specific invoices and the customer reverses the credit."
          : `🔴 This agreement is dated ${data.agreementDate} and covers supplies from ${data.effectiveFrom}. Section 15(3)(b)(i) needs the agreement to have existed at or before the supply, so rebates under it cannot reduce the GST on sales made before ${data.agreementDate}. They can still be credited to the customer — as a financial credit note, with no tax.`,
      },
    };
  } catch (err) {
    return toSalesActionError(err, "savePriceAgreement");
  }
}

/* ================================================================== */
/* ② COMPUTE THE REBATE                                                */
/* ================================================================== */

const computeSchema = z.object({
  companyId: z.string().uuid(),
  agreementId: z.string().uuid().nullish(),
  referenceNo: z.string().trim().min(1).max(60),
  periodFrom: civilDay,
  periodTo: civilDay,
  recipientReversalConfirmed: z.boolean().default(false),
  recipientReversalNote: z.string().trim().max(1000).optional(),
  notes: z.string().trim().max(2000).optional(),
});

/**
 * ⭐⭐ WORK OUT WHAT A PERIOD EARNED, AND WHETHER THE TAX COMES BACK.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE ALLOCATION IS DONE NOW, NOT LATER
 * ══════════════════════════════════════════════════════════════════════
 * Section 15(3)(b)(i) requires the discount to be "specifically linked
 * to relevant invoices" — and that linkage is also the only way the
 * customer can work out how much input tax credit to reverse.
 *
 * ⚠️ Software that stores a rebate as one figure **cannot produce the
 * linkage afterwards**, because the apportionment was never done. So it
 * happens here, in the same transaction as the rebate.
 */
export async function computeRebate(input: unknown): Promise<
  ActionResult<{
    id: string;
    turnoverMinor: string;
    discountMinor: string;
    rateBps: number;
    taxAtStakeMinor: string;
    reducesTax: boolean;
    reason: string;
    authority: string;
    outstanding: string[];
    invoiceCount: number;
    toNextBandMinor: string | null;
    nextRateBps: number | null;
  }>
> {
  try {
    const data = computeSchema.parse(input);
    const ctx = await requirePermission(WRITE);
    const today = new Date().toISOString().slice(0, 10);

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        let slabs: RebateSlab[] = [];
        let agreementDate: string | null = null;

        if (data.agreementId) {
          const [ag] = await tx
            .select()
            .from(priceAgreements)
            .where(
              and(
                eq(priceAgreements.tenantId, ctx.tenant.id),
                eq(priceAgreements.id, data.agreementId),
              ),
            )
            .limit(1);
          if (!ag) throw new Error("That agreement does not exist.");
          agreementDate = String(ag.agreementDate);
          slabs = (ag.slabs ?? []).map((s) => ({
            fromTurnoverMinor: BigInt(s.fromTurnoverMinor),
            rateBps: s.rateBps,
          }));
        }

        /**
         * ⚠️ ISSUED INVOICES ONLY. A draft has no turnover behind it, and
         * a cancelled one is a sale that did not happen — counting either
         * inflates the rebate the customer is told they have earned.
         */
        const rows = await tx
          .select({
            id: salesInvoices.id,
            invoiceNumber: salesInvoices.invoiceNumber,
            invoiceDate: salesInvoices.invoiceDate,
            taxableValueMinor: salesInvoices.taxableValueMinor,
            cgstMinor: salesInvoices.cgstMinor,
            sgstMinor: salesInvoices.sgstMinor,
            igstMinor: salesInvoices.igstMinor,
          })
          .from(salesInvoices)
          .where(
            and(
              eq(salesInvoices.tenantId, ctx.tenant.id),
              eq(salesInvoices.companyId, data.companyId),
              gte(salesInvoices.invoiceDate, data.periodFrom),
              lte(salesInvoices.invoiceDate, data.periodTo),
              sql`${salesInvoices.status} NOT IN ('draft', 'cancelled')`,
            ),
          )
          .limit(2000);

        if (rows.length === 0) {
          throw new Error(
            "That customer has no issued invoices in this period, so there is no turnover to rebate.",
          );
        }

        const invoices: InvoiceShare[] = rows.map((r) => {
          const taxable = toBigIntAmount(r.taxableValueMinor);
          const tax =
            toBigIntAmount(r.cgstMinor) +
            toBigIntAmount(r.sgstMinor) +
            toBigIntAmount(r.igstMinor);
          /**
           * ⭐ THE RATE IS DERIVED PER INVOICE. A rebate spanning goods
           * at 5%, 12% and 18% has no single rate, and an average would
           * reclaim the wrong amount on every line.
           */
          const rateBps =
            taxable > 0n ? Number((tax * 10_000n) / taxable) : 0;
          return {
            invoiceId: r.id,
            invoiceNumber: r.invoiceNumber,
            invoiceDate: String(r.invoiceDate),
            taxableMinor: taxable,
            taxRateBps: rateBps,
          };
        });

        const turnoverMinor = invoices.reduce((s, i) => s + i.taxableMinor, 0n);
        const rebate = rebateForTurnover({ turnoverMinor, slabs });

        if (rebate.discountMinor === 0n) {
          throw new Error(
            rebate.toNextBandMinor === null
              ? "This agreement has no rebate bands, so nothing has been earned. Add the bands to the agreement first."
              : `The turnover of ${serializeAmount(turnoverMinor)} paise has not reached the first rebate band. ${serializeAmount(rebate.toNextBandMinor)} paise more would reach ${(rebate.nextRateBps ?? 0) / 100}%.`,
          );
        }

        const allocation = allocateRebate({
          discountMinor: rebate.discountMinor,
          invoices,
        });

        const verdict = assessPostSupplyDiscount({
          agreementDate,
          earliestSupplyDate: earliestSupplyDate(invoices),
          linkedInvoiceCount: allocation.shares.length,
          recipientReversalConfirmed: data.recipientReversalConfirmed,
        });

        const [row] = await tx
          .insert(postSupplyDiscounts)
          .values({
            tenantId: ctx.tenant.id,
            companyId: data.companyId,
            agreementId: data.agreementId ?? null,
            referenceNo: data.referenceNo,
            periodFrom: data.periodFrom,
            periodTo: data.periodTo,
            computedOn: today,
            turnoverMinor,
            discountMinor: rebate.discountMinor,
            taxAtStakeMinor: allocation.taxTotalMinor,
            /** 🔴 The conclusion, stored with its reasoning. */
            reducesTax: verdict.reducesTax,
            verdictReason: verdict.reason,
            recipientReversalConfirmed: data.recipientReversalConfirmed,
            recipientReversalNote: data.recipientReversalNote ?? null,
            notes: data.notes ?? null,
            status: "draft",
            createdBy: ctx.user.id,
          })
          .returning({ id: postSupplyDiscounts.id });

        if (!row) throw new Error("The rebate could not be saved.");

        await tx.insert(postSupplyDiscountInvoices).values(
          allocation.shares.map((s) => ({
            tenantId: ctx.tenant.id,
            discountId: row.id,
            invoiceId: s.invoiceId,
            /** Captured, so a renumbered invoice cannot rewrite history. */
            invoiceNumber: s.invoiceNumber,
            invoiceDate: s.invoiceDate,
            invoiceTaxableMinor: s.taxableMinor,
            allocatedMinor: s.allocatedMinor,
            taxRateBps: s.taxRateBps,
            taxAllocatedMinor: s.taxAllocatedMinor,
          })),
        );

        await writeAudit(ctx, {
          action: "create",
          resourceType: "post_supply_discount",
          resourceId: row.id,
          newValue: {
            referenceNo: data.referenceNo,
            turnoverMinor: serializeAmount(turnoverMinor),
            discountMinor: serializeAmount(rebate.discountMinor),
            reducesTax: verdict.reducesTax,
            invoices: allocation.shares.length,
          },
          severity: "critical",
        });

        return {
          id: row.id,
          turnoverMinor: serializeAmount(turnoverMinor),
          discountMinor: serializeAmount(rebate.discountMinor),
          rateBps: rebate.rateBps,
          taxAtStakeMinor: serializeAmount(allocation.taxTotalMinor),
          reducesTax: verdict.reducesTax,
          reason: verdict.reason,
          authority: verdict.authority,
          outstanding: verdict.outstanding,
          invoiceCount: allocation.shares.length,
          toNextBandMinor:
            rebate.toNextBandMinor === null
              ? null
              : serializeAmount(rebate.toNextBandMinor),
          nextRateBps: rebate.nextRateBps,
        };
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/gst/discounts");
    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "computeRebate");
  }
}

/* ================================================================== */
/* ③ READS                                                             */
/* ================================================================== */

export async function getDiscounts(): Promise<
  ActionResult<{
    agreements: {
      id: string;
      referenceNo: string;
      title: string;
      companyName: string | null;
      agreementDate: string;
      effectiveFrom: string;
      effectiveTo: string | null;
      inTime: boolean;
      slabCount: number;
    }[];
    discounts: {
      id: string;
      referenceNo: string;
      companyName: string | null;
      periodFrom: string;
      periodTo: string;
      turnoverMinor: string;
      discountMinor: string;
      taxAtStakeMinor: string;
      reducesTax: boolean;
      verdictReason: string;
      invoiceCount: number;
      status: string;
    }[];
    taxLostMinor: string;
    taxRecoverableMinor: string;
  }>
> {
  try {
    const ctx = await requirePermission(READ);

    const data = await withTenant(ctx.tenant.id, async (tx) => {
      const ags = await tx
        .select({
          id: priceAgreements.id,
          referenceNo: priceAgreements.referenceNo,
          title: priceAgreements.title,
          companyName: companies.name,
          agreementDate: priceAgreements.agreementDate,
          effectiveFrom: priceAgreements.effectiveFrom,
          effectiveTo: priceAgreements.effectiveTo,
          slabs: priceAgreements.slabs,
        })
        .from(priceAgreements)
        .leftJoin(
          companies,
          and(
            eq(companies.id, priceAgreements.companyId),
            eq(companies.tenantId, ctx.tenant.id),
          ),
        )
        .where(eq(priceAgreements.tenantId, ctx.tenant.id))
        .orderBy(desc(priceAgreements.effectiveFrom))
        .limit(200);

      const dis = await tx
        .select({
          id: postSupplyDiscounts.id,
          referenceNo: postSupplyDiscounts.referenceNo,
          companyName: companies.name,
          periodFrom: postSupplyDiscounts.periodFrom,
          periodTo: postSupplyDiscounts.periodTo,
          turnoverMinor: postSupplyDiscounts.turnoverMinor,
          discountMinor: postSupplyDiscounts.discountMinor,
          taxAtStakeMinor: postSupplyDiscounts.taxAtStakeMinor,
          reducesTax: postSupplyDiscounts.reducesTax,
          verdictReason: postSupplyDiscounts.verdictReason,
          status: postSupplyDiscounts.status,
          invoiceCount: sql<number>`(
            SELECT COUNT(*)::int FROM post_supply_discount_invoices l
             WHERE l.tenant_id = ${ctx.tenant.id} AND l.discount_id = ${postSupplyDiscounts.id}
          )`,
        })
        .from(postSupplyDiscounts)
        .leftJoin(
          companies,
          and(
            eq(companies.id, postSupplyDiscounts.companyId),
            eq(companies.tenantId, ctx.tenant.id),
          ),
        )
        .where(eq(postSupplyDiscounts.tenantId, ctx.tenant.id))
        .orderBy(desc(postSupplyDiscounts.computedOn))
        .limit(500);

      /**
       * ⭐ TWO TOTALS, NEVER SUMMED. "Lost" is GST already paid on sales
       * that were rebated and cannot be recovered — money gone.
       * "Recoverable" is money a credit note can still bring back. One
       * combined figure hides which half is actionable.
       */
      let taxLost = 0n;
      let taxRecoverable = 0n;
      for (const d of dis) {
        if (d.status === "cancelled") continue;
        const t = toBigIntAmount(d.taxAtStakeMinor);
        if (d.reducesTax) taxRecoverable += t;
        else taxLost += t;
      }

      return {
        agreements: ags.map((a) => ({
          id: a.id,
          referenceNo: a.referenceNo,
          title: a.title,
          companyName: a.companyName,
          agreementDate: String(a.agreementDate),
          effectiveFrom: String(a.effectiveFrom),
          effectiveTo: a.effectiveTo ? String(a.effectiveTo) : null,
          /** 🔴 The one fact that decides everything downstream. */
          inTime: String(a.agreementDate) <= String(a.effectiveFrom),
          slabCount: (a.slabs ?? []).length,
        })),
        discounts: dis.map((d) => ({
          id: d.id,
          referenceNo: d.referenceNo,
          companyName: d.companyName,
          periodFrom: String(d.periodFrom),
          periodTo: String(d.periodTo),
          turnoverMinor: serializeAmount(toBigIntAmount(d.turnoverMinor)),
          discountMinor: serializeAmount(toBigIntAmount(d.discountMinor)),
          taxAtStakeMinor: serializeAmount(toBigIntAmount(d.taxAtStakeMinor)),
          reducesTax: d.reducesTax,
          verdictReason: d.verdictReason,
          invoiceCount: d.invoiceCount,
          status: d.status,
        })),
        taxLostMinor: serializeAmount(taxLost),
        taxRecoverableMinor: serializeAmount(taxRecoverable),
      };
    });

    return { ok: true, data };
  } catch (err) {
    return toSalesActionError(err, "getDiscounts");
  }
}

export async function getDiscountDetail(id: string): Promise<
  ActionResult<{
    lines: {
      invoiceNumber: string | null;
      invoiceDate: string | null;
      invoiceTaxableMinor: string;
      allocatedMinor: string;
      taxRateBps: number;
      taxAllocatedMinor: string;
    }[];
  }>
> {
  try {
    const ctx = await requirePermission(READ);
    const lines = await withTenant(ctx.tenant.id, async (tx) =>
      tx
        .select()
        .from(postSupplyDiscountInvoices)
        .where(
          and(
            eq(postSupplyDiscountInvoices.tenantId, ctx.tenant.id),
            eq(postSupplyDiscountInvoices.discountId, id),
          ),
        )
        .orderBy(postSupplyDiscountInvoices.invoiceDate)
        .limit(2000),
    );

    return {
      ok: true,
      data: {
        lines: lines.map((l) => ({
          invoiceNumber: l.invoiceNumber,
          invoiceDate: l.invoiceDate ? String(l.invoiceDate) : null,
          invoiceTaxableMinor: serializeAmount(toBigIntAmount(l.invoiceTaxableMinor)),
          allocatedMinor: serializeAmount(toBigIntAmount(l.allocatedMinor)),
          taxRateBps: l.taxRateBps,
          taxAllocatedMinor: serializeAmount(toBigIntAmount(l.taxAllocatedMinor)),
        })),
      },
    };
  } catch (err) {
    return toSalesActionError(err, "getDiscountDetail");
  }
}
