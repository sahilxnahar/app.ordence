"use server";

/**
 * Ordence — Channel-Partner Brokerage
 * Version: v1.25.0-alpha · Batch 17
 *
 * ⚠️ Every export is an async function, and every one of them is a
 * browser-reachable RPC endpoint.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐⭐ THE NINTH TIME: A COMPLETE ENGINE THAT NOTHING REACHED
 * ══════════════════════════════════════════════════════════════════════
 * `lib/sales/commission.ts` has computed brokerage since Phase 22. It
 * handles all three commission bases, it deducts TDS, it explains the
 * deduction in a sentence, and it has a test file. `/sales/partners/[id]`
 * has DISPLAYED the figure for almost as long.
 *
 * And nothing has ever recorded one. No document, no liability, no
 * expense in the profit and loss account. A developer running Ordence
 * could see exactly what they owed their brokers and had no way to book
 * it — so the largest single selling cost in the business was invisible
 * to the accounts, and the TDS on it was never withheld by anything.
 *
 * ⚠️ THAT IS THE SAME SHAPE AS THE POSSESSION POSTING, THE TDS ENGINE,
 * THE PERIOD LOCK AND FIVE OTHERS. The lesson has stopped being
 * interesting and started being a checklist item: when an engine exists,
 * ask what calls it before writing another one.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 AND FIXING THE REACHABILITY EXPOSED TWO DEFECTS IN THE ENGINE
 * ══════════════════════════════════════════════════════════════════════
 * Both are documented at length in `lib/sales/commission.ts`. In short:
 * the rate was 5% and has been 2% since 1 October 2024, and the ₹20,000
 * threshold behaved per-payment where 194H is `aggregate_whole` — the
 * product's own section table said so while importing the wrong
 * behaviour from here.
 *
 * ⚠️ NEITHER WOULD EVER HAVE BEEN FOUND WHILE THE FIGURE WAS ONLY EVER
 * DISPLAYED. A wrong number on a preview screen is an opinion. The same
 * number withheld from a broker and reported on a Form 16A is a
 * liability with interest running on it.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenant } from "@/db";
import {
  channelPartners,
  channelPartnerCommissions,
  bookings,
  salesPostingAccounts,
} from "@/db/schema";
import { requirePermission, writeAudit } from "@/server/audit";
import { guardSalesWrite, salesFail, toSalesActionError } from "@/server/sales/guards";
import { withGeneratedReference } from "@/server/sales/references";
import { computeCommission, computeTds } from "@/lib/sales/commission";
import { postBrokerage, postPartnerPayment } from "@/server/accounting/post-sales";
import { financialYearWindow } from "@/lib/gst/constants";
import { toMinorUnits } from "@/lib/validators/accounting";
import { PROPERTY_ROLE_META } from "@/lib/accounting/sales-posting";
import type { ActionResult } from "@/lib/validators/crm";
import type { ChannelPartnerCommission } from "@/db/schema/sales";

/**
 * ⚠️ THE ROLES A BROKERAGE POSTING TOUCHES, IN ONE PLACE. The screen
 * uses this to say which accounts are missing BEFORE somebody fills in a
 * bill, rather than after they press post.
 */
const BROKERAGE_ROLES = ["brokerage_expense", "partner_payable", "tds_payable"] as const;
const BROKERAGE_ITC_ROLES = ["input_cgst", "input_sgst", "input_igst"] as const;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/* ------------------------------------------------------------------ */
/* READ                                                               */
/* ------------------------------------------------------------------ */

export type BrokerageRow = ChannelPartnerCommission & {
  partnerFirmName: string;
  partnerHasPan: boolean;
  bookingReference: string | null;
};

export async function listBrokerage(
  input: { partnerId?: string } = {},
): Promise<ActionResult<{ rows: BrokerageRow[]; outstandingMinor: string }>> {
  try {
    const ctx = await requirePermission("partners:read");

    const rows = await withTenant(ctx.tenant.id, async (tx) =>
      tx
        .select({
          bill: channelPartnerCommissions,
          partnerFirmName: channelPartners.firmName,
          partnerPan: channelPartners.panNumber,
          bookingReference: bookings.reference,
        })
        .from(channelPartnerCommissions)
        .innerJoin(
          channelPartners,
          eq(channelPartners.id, channelPartnerCommissions.partnerId),
        )
        .leftJoin(bookings, eq(bookings.id, channelPartnerCommissions.bookingId))
        .where(
          and(
            eq(channelPartnerCommissions.tenantId, ctx.tenant.id),
            input.partnerId
              ? eq(channelPartnerCommissions.partnerId, input.partnerId)
              : sql`true`,
          ),
        )
        .orderBy(desc(channelPartnerCommissions.creditedOn))
        .limit(500),
    );

    /**
     * ⚠️ OUTSTANDING IS `posted` ONLY, NOT `approved`. An approved bill
     * is a decision; a posted one is a liability in the balance sheet.
     * Counting approvals as outstanding would make the figure on this
     * screen disagree with the Channel Partners Payable account, and the
     * account is the one that is right.
     */
    const outstandingMinor = rows
      .filter((r) => r.bill.status === "posted")
      .reduce((sum, r) => sum + r.bill.netPayableMinor, 0n);

    return {
      ok: true,
      data: {
        rows: rows.map((r) => ({
          ...r.bill,
          partnerFirmName: r.partnerFirmName,
          partnerHasPan: Boolean(r.partnerPan),
          bookingReference: r.bookingReference,
        })),
        outstandingMinor: outstandingMinor.toString(),
      },
    };
  } catch (err) {
    return toSalesActionError(err, "listBrokerage");
  }
}

/**
 * ⭐ WHICH LEDGER ACCOUNTS ARE MISSING, ASKED BEFORE THE WORK RATHER
 *   THAN AFTER IT.
 *
 * ⚠️ THE ITC ACCOUNTS ARE REPORTED SEPARATELY because they are only
 * needed when a bill claims credit — which on a 1%/5% residential
 * project it never does. Listing them as required would send a developer
 * off to create three input-tax ledgers they will never post to.
 */
export async function brokerageAccountsNeeded(): Promise<
  ActionResult<{
    missing: { role: string; label: string; help: string }[];
    missingForItc: { role: string; label: string; help: string }[];
  }>
> {
  try {
    const ctx = await requirePermission("partners:read");

    const mapped = await withTenant(ctx.tenant.id, async (tx) =>
      tx
        .select({ role: salesPostingAccounts.role })
        .from(salesPostingAccounts)
        .where(eq(salesPostingAccounts.tenantId, ctx.tenant.id)),
    );
    const have = new Set(mapped.map((m) => m.role));

    const describe = (role: string) => {
      const meta = (PROPERTY_ROLE_META as Record<string, { label: string; help: string }>)[
        role
      ];
      return {
        role,
        label: meta?.label ?? role,
        help: meta?.help ?? "",
      };
    };

    return {
      ok: true,
      data: {
        missing: BROKERAGE_ROLES.filter((r) => !have.has(r)).map(describe),
        missingForItc: BROKERAGE_ITC_ROLES.filter((r) => !have.has(r)).map(describe),
      },
    };
  } catch (err) {
    return toSalesActionError(err, "brokerageAccountsNeeded");
  }
}

/* ------------------------------------------------------------------ */
/* ⭐⭐ THE PREVIEW — WHAT WOULD BE DEDUCTED, AND WHY                   */
/* ------------------------------------------------------------------ */

export type BrokeragePreview = {
  grossMinor: string;
  workings: string;
  problem: string | null;
  tdsMinor: string;
  tdsRateBps: number;
  tdsApplicable: boolean;
  tdsExplanation: string;
  tdsCaution: string | null;
  chargeableBaseMinor: string;
  ytdGrossMinor: string;
  ytdTdsMinor: string;
  financialYear: string;
  netBeforeGstMinor: string;
  hasPan: boolean;
};

/**
 * ⚠️ THE YEAR-TO-DATE FIGURES COME FROM RECORDED BILLS, NOT FROM THE
 * BOOKING PIPELINE.
 *
 * The partner screen projects TDS across live bookings, which is useful
 * for a conversation and useless for a deduction: those bookings have
 * not been credited with anything. The threshold is tested on what has
 * ACTUALLY been credited in the financial year, which is exactly the set
 * of rows in this table.
 */
export async function previewBrokerage(input: {
  partnerId: string;
  bookingId?: string | null;
  creditedOn: string;
  /** Optional override; defaults to the partner's agreed basis. */
  overrideGross?: string | null;
}): Promise<ActionResult<BrokeragePreview>> {
  try {
    const ctx = await requirePermission("partners:read");
    if (!ISO_DAY.test(input.creditedOn)) {
      return salesFail("The credit date has to be a calendar date, as YYYY-MM-DD.");
    }

    const window = financialYearWindow(input.creditedOn);

    const found = await withTenant(ctx.tenant.id, async (tx) => {
      const [partner] = await tx
        .select()
        .from(channelPartners)
        .where(
          and(
            eq(channelPartners.id, input.partnerId),
            eq(channelPartners.tenantId, ctx.tenant.id),
          ),
        )
        .limit(1);
      if (!partner) return null;

      let considerationMinor: bigint | null = null;
      if (input.bookingId) {
        const [booking] = await tx
          .select({ agreementValueMinor: bookings.agreementValueMinor })
          .from(bookings)
          .where(
            and(eq(bookings.id, input.bookingId), eq(bookings.tenantId, ctx.tenant.id)),
          )
          .limit(1);
        considerationMinor = booking?.agreementValueMinor ?? null;
      }

      /**
       * ⚠️ CANCELLED BILLS ARE EXCLUDED FROM THE RUNNING TOTAL. A bill
       * that was raised and withdrawn credited the partner with nothing,
       * so counting it would cross the threshold on money that never
       * moved and start deducting tax nobody owes.
       */
      const [ytd] = await tx
        .select({
          gross: sql<string>`COALESCE(SUM(${channelPartnerCommissions.grossMinor}), 0)::text`,
          tds: sql<string>`COALESCE(SUM(${channelPartnerCommissions.tdsMinor}), 0)::text`,
          earliest: sql<
            string | null
          >`MIN(${channelPartnerCommissions.creditedOn})::text`,
        })
        .from(channelPartnerCommissions)
        .where(
          and(
            eq(channelPartnerCommissions.tenantId, ctx.tenant.id),
            eq(channelPartnerCommissions.partnerId, input.partnerId),
            sql`${channelPartnerCommissions.status} <> 'cancelled'`,
            sql`${channelPartnerCommissions.creditedOn} >= ${window.start}::date`,
            sql`${channelPartnerCommissions.creditedOn} < ${window.end}::date`,
          ),
        );

      return { partner, considerationMinor, ytd };
    });

    if (!found) return salesFail("That channel partner does not exist, or you cannot see it.");
    const { partner, considerationMinor, ytd } = found;

    const commission = computeCommission({
      basis: partner.commissionBasis,
      rateBps: partner.commissionRateBps,
      monthsCentis: partner.commissionMonthsCentis,
      flatMinor: partner.commissionFlatMinor,
      agreementValueMinor: considerationMinor,
    });

    /**
     * ⚠️ AN OVERRIDE IS ALLOWED AND IT IS RECORDED AS SUCH. Brokerage is
     * genuinely paid in tranches and genuinely renegotiated on a large
     * deal. Forcing the computed figure would drive people to enter a
     * fake commission rate on the partner record, which then silently
     * misprices every other booking that partner brings.
     */
    const overrideMinor =
      input.overrideGross && input.overrideGross.trim() !== ""
        ? toMinorUnits(input.overrideGross)
        : null;

    const grossMinor = overrideMinor ?? commission.grossMinor;
    const workings =
      overrideMinor !== null
        ? `Entered by hand. The agreed basis would give ${commission.workings}.`
        : commission.workings;

    const ytdGross = BigInt(ytd?.gross ?? "0");
    const ytdTds = BigInt(ytd?.tds ?? "0");

    const tds = computeTds({
      grossMinor,
      hasPan: Boolean(partner.panNumber),
      onDate: input.creditedOn,
      ytdGrossMinor: ytdGross,
      ytdTdsMinor: ytdTds,
      ytdEarliestDate: ytd?.earliest ?? null,
    });

    return {
      ok: true,
      data: {
        grossMinor: grossMinor.toString(),
        workings,
        problem: overrideMinor !== null ? null : commission.problem,
        tdsMinor: tds.tdsMinor.toString(),
        tdsRateBps: tds.rateBps,
        tdsApplicable: tds.applicable,
        tdsExplanation: tds.explanation,
        tdsCaution: tds.caution,
        chargeableBaseMinor: tds.chargeableBaseMinor.toString(),
        ytdGrossMinor: ytdGross.toString(),
        ytdTdsMinor: ytdTds.toString(),
        financialYear: window.financialYear,
        netBeforeGstMinor: (grossMinor - tds.tdsMinor).toString(),
        hasPan: Boolean(partner.panNumber),
      },
    };
  } catch (err) {
    return toSalesActionError(err, "previewBrokerage");
  }
}

/* ------------------------------------------------------------------ */
/* WRITE                                                              */
/* ------------------------------------------------------------------ */

const raiseBrokerageSchema = z.object({
  partnerId: z.string().uuid(),
  bookingId: z.string().uuid().nullish(),
  creditedOn: z.string().regex(ISO_DAY, "Use YYYY-MM-DD."),
  overrideGross: z.string().trim().nullish(),
  partnerInvoiceNumber: z.string().trim().max(40).nullish(),
  partnerInvoiceDate: z.string().regex(ISO_DAY).nullish(),
  cgst: z.string().trim().nullish(),
  sgst: z.string().trim().nullish(),
  igst: z.string().trim().nullish(),
  itcEligible: z.boolean().default(false),
  note: z.string().trim().max(2000).nullish(),
});

export async function raiseBrokerage(
  input: unknown,
): Promise<ActionResult<{ id: string; reference: string; netPayableMinor: string }>> {
  try {
    const ctx = await guardSalesWrite({
      operation: "brokerage:raise",
      feature: "sales.brokerage",
      permission: "partners:manage",
    });
    const data = raiseBrokerageSchema.parse(input);
    const now = new Date();

    const cgstMinor = data.cgst ? toMinorUnits(data.cgst) : 0n;
    const sgstMinor = data.sgst ? toMinorUnits(data.sgst) : 0n;
    const igstMinor = data.igst ? toMinorUnits(data.igst) : 0n;

    type Outcome =
      | { kind: "refused"; message: string }
      | { kind: "ok"; id: string; reference: string; netPayableMinor: bigint };

    const window = financialYearWindow(data.creditedOn);

    const outcome = await withTenant(
      ctx.tenant.id,
      async (tx): Promise<Outcome> => {
        const [partner] = await tx
          .select()
          .from(channelPartners)
          .where(
            and(
              eq(channelPartners.id, data.partnerId),
              eq(channelPartners.tenantId, ctx.tenant.id),
            ),
          )
          .limit(1);
        if (!partner) return { kind: "refused", message: "That channel partner does not exist." };

        /**
         * 🔴 A TERMINATED OR SUSPENDED PARTNER IS NOT PAID NEW BROKERAGE.
         * The status exists precisely to stop money going out, and a
         * brokerage bill IS money going out — it creates a payable that
         * a later payment run will settle without asking again.
         */
        if (partner.status === "terminated" || partner.status === "suspended") {
          return {
            kind: "refused",
            message:
              `${partner.firmName} is ${partner.status}. Raising brokerage would create a ` +
              `payable that a payment run will settle without asking anybody again. Reactivate ` +
              `the partner first if this is genuinely owed.`,
          };
        }

        let considerationMinor: bigint | null = null;
        if (data.bookingId) {
          const [booking] = await tx
            .select({
              agreementValueMinor: bookings.agreementValueMinor,
              status: bookings.status,
              reference: bookings.reference,
            })
            .from(bookings)
            .where(
              and(eq(bookings.id, data.bookingId), eq(bookings.tenantId, ctx.tenant.id)),
            )
            .limit(1);
          if (!booking) return { kind: "refused", message: "That booking does not exist." };

          /**
           * ⚠️ BROKERAGE ON A CANCELLED BOOKING IS REFUSED, NOT WARNED
           * ABOUT. The sale did not happen. If it was genuinely earned
           * before the cancellation, it was earned on a live booking and
           * should have been raised then — and raising it now would put
           * a selling cost against revenue that will never exist.
           */
          if (booking.status === "cancelled") {
            return {
              kind: "refused",
              message:
                `Booking ${booking.reference} was cancelled, so there is no sale to pay ` +
                `brokerage on. If it was earned before the cancellation, raise it against ` +
                `no booking with a note explaining why — that leaves the reasoning on the ` +
                `record rather than attaching a cost to a sale that did not happen.`,
            };
          }
          considerationMinor = booking.agreementValueMinor;
        }

        const commission = computeCommission({
          basis: partner.commissionBasis,
          rateBps: partner.commissionRateBps,
          monthsCentis: partner.commissionMonthsCentis,
          flatMinor: partner.commissionFlatMinor,
          agreementValueMinor: considerationMinor,
        });

        const overrideMinor =
          data.overrideGross && data.overrideGross.trim() !== ""
            ? toMinorUnits(data.overrideGross)
            : null;

        if (overrideMinor === null && commission.problem) {
          return { kind: "refused", message: commission.problem };
        }

        const grossMinor = overrideMinor ?? commission.grossMinor;
        if (grossMinor <= 0n) {
          return {
            kind: "refused",
            message: "A brokerage bill for nothing has no effect. Enter what is owed.",
          };
        }

        const [ytd] = await tx
          .select({
            gross: sql<string>`COALESCE(SUM(${channelPartnerCommissions.grossMinor}), 0)::text`,
            tds: sql<string>`COALESCE(SUM(${channelPartnerCommissions.tdsMinor}), 0)::text`,
            earliest: sql<
              string | null
            >`MIN(${channelPartnerCommissions.creditedOn})::text`,
          })
          .from(channelPartnerCommissions)
          .where(
            and(
              eq(channelPartnerCommissions.tenantId, ctx.tenant.id),
              eq(channelPartnerCommissions.partnerId, data.partnerId),
              sql`${channelPartnerCommissions.status} <> 'cancelled'`,
              sql`${channelPartnerCommissions.creditedOn} >= ${window.start}::date`,
              sql`${channelPartnerCommissions.creditedOn} < ${window.end}::date`,
            ),
          );

        const tds = computeTds({
          grossMinor,
          hasPan: Boolean(partner.panNumber),
          onDate: data.creditedOn,
          ytdGrossMinor: BigInt(ytd?.gross ?? "0"),
          ytdTdsMinor: BigInt(ytd?.tds ?? "0"),
          ytdEarliestDate: ytd?.earliest ?? null,
        });

        const netPayableMinor =
          grossMinor + cgstMinor + sgstMinor + igstMinor - tds.tdsMinor;

        const created = await withGeneratedReference(tx, "brokerage", async (reference) => {
          const [row] = await tx
            .insert(channelPartnerCommissions)
            .values({
              tenantId: ctx.tenant.id,
              partnerId: data.partnerId,
              bookingId: data.bookingId ?? null,
              reference,
              status: "draft",
              creditedOn: data.creditedOn,
              basis: partner.commissionBasis,
              rateBps: partner.commissionRateBps,
              monthsCentis: partner.commissionMonthsCentis,
              flatMinor: partner.commissionFlatMinor,
              considerationMinor,
              workings:
                overrideMinor !== null
                  ? `Entered by hand. The agreed basis would give ${commission.workings}.`
                  : commission.workings,
              grossMinor,
              partnerInvoiceNumber: data.partnerInvoiceNumber ?? null,
              partnerInvoiceDate: data.partnerInvoiceDate ?? null,
              cgstMinor,
              sgstMinor,
              igstMinor,
              itcEligible: data.itcEligible,
              tdsMinor: tds.tdsMinor,
              tdsRateBps: tds.rateBps,
              tdsChargeableBaseMinor: tds.chargeableBaseMinor,
              tdsExplanation: [tds.explanation, tds.caution].filter(Boolean).join(" "),
              netPayableMinor,
              note: data.note ?? null,
              createdAt: now,
              updatedAt: now,
            })
            .returning({ id: channelPartnerCommissions.id });
          return { id: row!.id, reference };
        });

        return {
          kind: "ok",
          id: created.id,
          reference: created.reference,
          netPayableMinor,
        };
      },
      { impersonationId: ctx.impersonationId },
    );

    if (outcome.kind === "refused") return salesFail(outcome.message);

    await writeAudit(ctx, {
      action: "create",
      resourceType: "channel_partner_commission",
      resourceId: outcome.id,
      newValue: {
        reference: outcome.reference,
        partnerId: data.partnerId,
        bookingId: data.bookingId ?? null,
        netPayableMinor: outcome.netPayableMinor.toString(),
      },
      severity: "warning",
    });

    revalidatePath("/sales/brokerage");
    revalidatePath("/sales/partners");
    return {
      ok: true,
      data: {
        id: outcome.id,
        reference: outcome.reference,
        netPayableMinor: outcome.netPayableMinor.toString(),
      },
    };
  } catch (err) {
    return toSalesActionError(err, "raiseBrokerage");
  }
}

const brokerageIdSchema = z.object({ id: z.string().uuid() });

/**
 * ⭐ APPROVAL IS A SEPARATE PAIR OF EYES ON MONEY LEAVING.
 *
 * ⚠️ AND SELF-APPROVAL IS PERMITTED, deliberately, because a one-person
 * developer is a real customer and blocking them would mean the feature
 * does not work at all. What is NOT permitted is it being invisible: the
 * approver is recorded, and the audit row carries the fact.
 */
export async function approveBrokerage(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await guardSalesWrite({
      operation: "brokerage:approve",
      feature: "sales.brokerage",
      permission: "partners:manage",
    });
    const data = brokerageIdSchema.parse(input);
    const now = new Date();

    const outcome = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [bill] = await tx
          .select({
            id: channelPartnerCommissions.id,
            reference: channelPartnerCommissions.reference,
            status: channelPartnerCommissions.status,
            partnerId: channelPartnerCommissions.partnerId,
          })
          .from(channelPartnerCommissions)
          .where(
            and(
              eq(channelPartnerCommissions.id, data.id),
              eq(channelPartnerCommissions.tenantId, ctx.tenant.id),
            ),
          )
          .limit(1);

        if (!bill) return { kind: "refused" as const, message: "That bill does not exist." };
        if (bill.status !== "draft") {
          return {
            kind: "refused" as const,
            message: `Brokerage bill ${bill.reference} is ${bill.status}, not a draft.`,
          };
        }

        const [partner] = await tx
          .select({ kycStatus: channelPartners.kycStatus, firmName: channelPartners.firmName })
          .from(channelPartners)
          .where(eq(channelPartners.id, bill.partnerId))
          .limit(1);

        /**
         * 🔴 KYC BEFORE APPROVAL, NOT BEFORE PAYMENT. By the time money
         * is leaving, the bill has been posted, the expense is in the
         * P&L and the TDS has been reported — and a blocked payment then
         * leaves a liability nobody can clear. The gate belongs where
         * the decision is made.
         */
        if (partner && partner.kycStatus !== "verified") {
          return {
            kind: "refused" as const,
            message:
              `${partner.firmName}'s KYC is ${partner.kycStatus}. Brokerage cannot be ` +
              `approved until it is verified — a payout to an unverified party is the ` +
              `single most common finding in a developer's audit, and without a PAN the ` +
              `deduction is 20% rather than 2%.`,
          };
        }

        await tx
          .update(channelPartnerCommissions)
          .set({ status: "approved", approvedAt: now, approvedBy: ctx.user.id, updatedAt: now })
          .where(
            and(
              eq(channelPartnerCommissions.id, data.id),
              eq(channelPartnerCommissions.tenantId, ctx.tenant.id),
            ),
          );

        return { kind: "ok" as const, reference: bill.reference };
      },
      { impersonationId: ctx.impersonationId },
    );

    if (outcome.kind === "refused") return salesFail(outcome.message);

    await writeAudit(ctx, {
      action: "update",
      resourceType: "channel_partner_commission",
      resourceId: data.id,
      oldValue: { status: "draft" },
      newValue: { status: "approved", reference: outcome.reference },
      severity: "warning",
    });

    revalidatePath("/sales/brokerage");
    return { ok: true, data: { id: data.id } };
  } catch (err) {
    return toSalesActionError(err, "approveBrokerage");
  }
}

/** ⭐⭐ POST IT. The expense, the input credit if any, the TDS, the payable. */
export async function postBrokerageBill(
  input: unknown,
): Promise<ActionResult<{ id: string; transactionId: string | null }>> {
  try {
    const data = brokerageIdSchema.parse(input);
    const ctx = await requirePermission("transactions:post");
    const now = new Date();

    type Outcome =
      | { kind: "refused"; message: string }
      | { kind: "ok"; transactionId: string | null; reference: string };

    const outcome = await withTenant(
      ctx.tenant.id,
      async (tx): Promise<Outcome> => {
        const [row] = await tx
          .select({
            bill: channelPartnerCommissions,
            partnerFirmName: channelPartners.firmName,
            bookingReference: bookings.reference,
          })
          .from(channelPartnerCommissions)
          .innerJoin(
            channelPartners,
            eq(channelPartners.id, channelPartnerCommissions.partnerId),
          )
          .leftJoin(bookings, eq(bookings.id, channelPartnerCommissions.bookingId))
          .where(
            and(
              eq(channelPartnerCommissions.id, data.id),
              eq(channelPartnerCommissions.tenantId, ctx.tenant.id),
            ),
          )
          .limit(1);

        if (!row) return { kind: "refused", message: "That bill does not exist." };
        const bill = row.bill;

        if (bill.status === "posted" || bill.status === "paid") {
          return {
            kind: "refused",
            message: `Brokerage bill ${bill.reference} is already in the ledger.`,
          };
        }
        if (bill.status !== "approved") {
          return {
            kind: "refused",
            message:
              `Brokerage bill ${bill.reference} is ${bill.status}. It has to be approved ` +
              `before it reaches the ledger — posting is what makes it a liability.`,
          };
        }

        const posted = await postBrokerage(tx, {
          tenantId: ctx.tenant.id,
          userId: ctx.user.id,
          commissionId: bill.id,
          reference: bill.reference,
          creditedOn: bill.creditedOn,
          partnerId: bill.partnerId,
          partnerName: row.partnerFirmName,
          bookingReference: row.bookingReference,
          grossMinor: bill.grossMinor,
          cgstMinor: bill.cgstMinor,
          sgstMinor: bill.sgstMinor,
          igstMinor: bill.igstMinor,
          itcEligible: bill.itcEligible,
          tdsMinor: bill.tdsMinor,
        });

        if (!posted.posted) {
          return { kind: "refused", message: describeRefusal(posted, bill.reference) };
        }

        await tx
          .update(channelPartnerCommissions)
          .set({ status: "posted", postedAt: now, updatedAt: now })
          .where(
            and(
              eq(channelPartnerCommissions.id, bill.id),
              eq(channelPartnerCommissions.tenantId, ctx.tenant.id),
            ),
          );

        return { kind: "ok", transactionId: posted.transactionId, reference: bill.reference };
      },
      { impersonationId: ctx.impersonationId },
    );

    if (outcome.kind === "refused") return salesFail(outcome.message);

    await writeAudit(ctx, {
      action: "create",
      resourceType: "transaction",
      resourceId: outcome.transactionId ?? data.id,
      newValue: { kind: "brokerage", commissionId: data.id, reference: outcome.reference },
      severity: "critical",
    });

    revalidatePath("/sales/brokerage");
    revalidatePath("/accounting/posting");
    return { ok: true, data: { id: data.id, transactionId: outcome.transactionId } };
  } catch (err) {
    return toSalesActionError(err, "postBrokerageBill");
  }
}

const payBrokerageSchema = z.object({
  id: z.string().uuid(),
  paidOn: z.string().regex(ISO_DAY, "Use YYYY-MM-DD."),
  paymentReference: z.string().trim().min(1).max(60),
});

/**
 * ⭐ THE TRANSFER. Clears the payable, and touches neither the expense
 * nor the TDS.
 *
 * ⚠️ THE TDS LIABILITY SURVIVES THIS DELIBERATELY. It is discharged by a
 * challan to the Government, not by the transfer to the broker — and
 * netting the two is how a TDS payable balance reaches zero without a
 * challan ever having been paid, which is a default nobody notices until
 * the quarterly return will not validate.
 */
export async function payBrokerage(
  input: unknown,
): Promise<ActionResult<{ id: string; transactionId: string | null }>> {
  try {
    const data = payBrokerageSchema.parse(input);
    const ctx = await requirePermission("transactions:post");
    const now = new Date();

    type Outcome =
      | { kind: "refused"; message: string }
      | { kind: "ok"; transactionId: string | null; reference: string };

    const outcome = await withTenant(
      ctx.tenant.id,
      async (tx): Promise<Outcome> => {
        const [row] = await tx
          .select({
            bill: channelPartnerCommissions,
            partnerFirmName: channelPartners.firmName,
          })
          .from(channelPartnerCommissions)
          .innerJoin(
            channelPartners,
            eq(channelPartners.id, channelPartnerCommissions.partnerId),
          )
          .where(
            and(
              eq(channelPartnerCommissions.id, data.id),
              eq(channelPartnerCommissions.tenantId, ctx.tenant.id),
            ),
          )
          .limit(1);

        if (!row) return { kind: "refused", message: "That bill does not exist." };
        const bill = row.bill;

        if (bill.status === "paid") {
          return {
            kind: "refused",
            message: `Brokerage bill ${bill.reference} was already paid.`,
          };
        }
        if (bill.status !== "posted") {
          return {
            kind: "refused",
            message:
              `Brokerage bill ${bill.reference} is ${bill.status}. Post it first — paying ` +
              `before the payable exists would push that account into a debit balance, ` +
              `which reads as the broker owing you money.`,
          };
        }

        const posted = await postPartnerPayment(tx, {
          tenantId: ctx.tenant.id,
          userId: ctx.user.id,
          commissionId: bill.id,
          reference: bill.reference,
          paidOn: data.paidOn,
          partnerId: bill.partnerId,
          partnerName: row.partnerFirmName,
          paymentReference: data.paymentReference,
          amountMinor: bill.netPayableMinor,
        });

        if (!posted.posted) {
          return { kind: "refused", message: describeRefusal(posted, bill.reference) };
        }

        await tx
          .update(channelPartnerCommissions)
          .set({
            status: "paid",
            paidAt: now,
            paymentReference: data.paymentReference,
            updatedAt: now,
          })
          .where(
            and(
              eq(channelPartnerCommissions.id, bill.id),
              eq(channelPartnerCommissions.tenantId, ctx.tenant.id),
            ),
          );

        return { kind: "ok", transactionId: posted.transactionId, reference: bill.reference };
      },
      { impersonationId: ctx.impersonationId },
    );

    if (outcome.kind === "refused") return salesFail(outcome.message);

    await writeAudit(ctx, {
      action: "create",
      resourceType: "transaction",
      resourceId: outcome.transactionId ?? data.id,
      newValue: {
        kind: "partner_payment",
        commissionId: data.id,
        reference: outcome.reference,
        paymentReference: data.paymentReference,
      },
      severity: "critical",
    });

    revalidatePath("/sales/brokerage");
    return { ok: true, data: { id: data.id, transactionId: outcome.transactionId } };
  } catch (err) {
    return toSalesActionError(err, "payBrokerage");
  }
}

const cancelBrokerageSchema = z.object({
  id: z.string().uuid(),
  reason: z.string().trim().min(10, "Say why in a sentence somebody else can read.").max(2000),
});

export async function cancelBrokerageBill(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await guardSalesWrite({
      operation: "brokerage:cancel",
      feature: "sales.brokerage",
      permission: "partners:manage",
    });
    const data = cancelBrokerageSchema.parse(input);
    const now = new Date();

    const outcome = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [bill] = await tx
          .select({
            reference: channelPartnerCommissions.reference,
            status: channelPartnerCommissions.status,
          })
          .from(channelPartnerCommissions)
          .where(
            and(
              eq(channelPartnerCommissions.id, data.id),
              eq(channelPartnerCommissions.tenantId, ctx.tenant.id),
            ),
          )
          .limit(1);

        if (!bill) return { kind: "refused" as const, message: "That bill does not exist." };

        /**
         * ⚠️ A POSTED BILL CAN BE CANCELLED AND THE LEDGER ENTRY STAYS.
         * Reversing it is a separate, dated decision — `transactions:
         * reverse` exists for that. Silently reversing here would mean
         * one button both withdrew a document and moved a trial balance,
         * and only one of those is what the person pressing it meant.
         */
        if (bill.status === "paid") {
          return {
            kind: "refused" as const,
            message:
              `Brokerage bill ${bill.reference} has been paid. Cancelling it would leave a ` +
              `payment in the bank with nothing behind it. Recover the amount and record ` +
              `that instead, so both movements are on the record.`,
          };
        }

        await tx
          .update(channelPartnerCommissions)
          .set({ status: "cancelled", note: data.reason, updatedAt: now })
          .where(
            and(
              eq(channelPartnerCommissions.id, data.id),
              eq(channelPartnerCommissions.tenantId, ctx.tenant.id),
            ),
          );

        return { kind: "ok" as const, reference: bill.reference, was: bill.status };
      },
      { impersonationId: ctx.impersonationId },
    );

    if (outcome.kind === "refused") return salesFail(outcome.message);

    await writeAudit(ctx, {
      action: "update",
      resourceType: "channel_partner_commission",
      resourceId: data.id,
      oldValue: { status: outcome.was },
      newValue: { status: "cancelled", reference: outcome.reference },
      reason: data.reason,
      severity: outcome.was === "posted" ? "critical" : "warning",
    });

    revalidatePath("/sales/brokerage");
    return { ok: true, data: { id: data.id } };
  } catch (err) {
    return toSalesActionError(err, "cancelBrokerageBill");
  }
}

/* ------------------------------------------------------------------ */

function describeRefusal(
  outcome: { posted: false; reason: string; missing?: unknown; period?: unknown },
  reference: string,
): string {
  if (outcome.reason === "already_posted") {
    return `Brokerage bill ${reference} is already in the ledger.`;
  }
  if (outcome.reason === "unmapped_roles") {
    const missing = Array.isArray(outcome.missing) ? outcome.missing.join(", ") : "";
    return (
      `These ledger accounts have not been mapped yet: ${missing}. Map them under ` +
      `Accounting → Posting accounts, then post this again. Nothing has been written.`
    );
  }
  if (outcome.reason === "period_closed") {
    return (
      `This entry belongs in ${String(outcome.period)}, which has been closed. Reopen that ` +
      `period, or agree a credit date in an open one before the bill is approved.`
    );
  }
  return `Brokerage bill ${reference} could not be posted.`;
}
