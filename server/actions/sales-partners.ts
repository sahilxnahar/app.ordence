"use server";

/**
 * Ordence — Channel Partner Actions
 * Version: v0.22.0-alpha
 *
 * ⚠️ Every export is an async function.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY BROKERS GET THEIR OWN TABLE AND NOT A CONTACT RECORD
 * ══════════════════════════════════════════════════════════════════════
 * A channel partner is a counterparty, not a contact. They have a RERA
 * registration, a PAN the company deducts tax against, a GSTIN, a
 * commission basis negotiated per firm, and a KYC state that gates
 * payment. None of that fits in a contact record without a dozen custom
 * fields that mean nothing to any other vertical.
 *
 * More importantly: money leaves the company through them. That deserves
 * its own audit surface.
 */

import { and, asc, count, desc, eq, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withTenant } from "@/db";
import { channelPartners, leads, bookings } from "@/db/schema";
import { requirePermission, writeAudit } from "@/server/audit";
import { guardSalesWrite, salesFail, toSalesActionError } from "@/server/sales/guards";
import {
  createChannelPartnerSchema,
  updateChannelPartnerSchema,
  setPartnerStatusSchema,
} from "@/lib/validators/sales";
import { toMinorUnits } from "@/lib/validators/accounting";
import {
  computeCommission,
  computeTds,
  cpLockDaysRemaining,
} from "@/lib/sales/commission";
import { financialYearWindow, toCivilDay } from "@/lib/gst/constants";
import type { ActionResult } from "@/lib/validators/crm";
import type { ChannelPartner } from "@/db/schema/sales";

/**
 * ⚠️ IST, NOT UTC. A booking made at 09:00 on 1 April IST is 03:30 UTC on
 * 1 April and lands in the right year either way; one made at 02:00 IST
 * on 1 April is 20:30 UTC on 31 MARCH, and a naive `toISOString()` files
 * it in the previous financial year. `toCivilDay` already shifts to IST
 * for exactly this reason, so the TDS date reuses it rather than
 * inventing a second answer.
 */
function isoDay(value: Date): string {
  return toCivilDay(value);
}

/* ------------------------------------------------------------------ */
/* READ                                                               */
/* ------------------------------------------------------------------ */

export type PartnerRow = ChannelPartner & {
  registeredLeads: number;
  liveBookings: number;
  /** Why this partner cannot be paid yet, if they cannot. */
  payoutBlocker: string | null;
};

export async function listChannelPartners(): Promise<ActionResult<{ rows: PartnerRow[] }>> {
  try {
    const ctx = await requirePermission("partners:read");

    const rows = await withTenant(ctx.tenant.id, async (tx) =>
      tx
        .select({
          partner: channelPartners,
          registeredLeads: sql<number>`(
            SELECT count(*)::int FROM leads l
             WHERE l.channel_partner_id = ${channelPartners.id}
               AND l.deleted_at IS NULL
          )`,
          liveBookings: sql<number>`(
            SELECT count(*)::int FROM bookings b
             WHERE b.channel_partner_id = ${channelPartners.id}
               AND b.status <> 'cancelled'
          )`,
        })
        .from(channelPartners)
        .where(
          and(
            eq(channelPartners.tenantId, ctx.tenant.id),
            isNull(channelPartners.deletedAt),
          ),
        )
        .orderBy(asc(channelPartners.firmName)),
    );

    return {
      ok: true,
      data: {
        rows: rows.map((r) => ({
          ...r.partner,
          registeredLeads: Number(r.registeredLeads ?? 0),
          liveBookings: Number(r.liveBookings ?? 0),
          payoutBlocker: payoutBlockerFor(r.partner),
        })),
      },
    };
  } catch (err) {
    return toSalesActionError(err, "listChannelPartners");
  }
}

/**
 * ⚠️ Named so it reads as a REFUSAL TO PAY, not a data-quality warning.
 *
 * Every item here stops money leaving the company, and the reason is
 * legal rather than tidiness: paying an unverified counterparty, or one
 * with no PAN, creates a liability for the payer, not the payee.
 */
function payoutBlockerFor(partner: ChannelPartner): string | null {
  if (partner.status === "terminated") {
    return "This partner has been terminated. No further commission is payable.";
  }
  if (partner.status === "suspended") {
    return "This partner is suspended. Commission is held until they are reinstated.";
  }
  if (partner.status === "pending") {
    return "This partner has not been activated yet.";
  }
  if (partner.kycStatus !== "verified") {
    return (
      "KYC is not verified. Paying an unverified counterparty is a compliance " +
      "exposure for the payer."
    );
  }
  if (!partner.panNumber) {
    return (
      "No PAN on file, so TDS must be deducted at 20% under section 206AA " +
      "instead of 5%. Collect the PAN before paying."
    );
  }
  return null;
}

export async function getChannelPartner(input: { id: string }): Promise<
  ActionResult<{
    partner: ChannelPartner;
    payoutBlocker: string | null;
    lockedLeads: { id: string; reference: string; name: string; daysRemaining: number | null }[];
    pipeline: {
      bookingReference: string;
      agreementValueMinor: string;
      commission: ReturnType<typeof computeCommission>;
      tds: ReturnType<typeof computeTds>;
    }[];
  }>
> {
  try {
    const ctx = await requirePermission("partners:read");
    const now = new Date();
    const { start: fyStart, end: fyEnd } = financialYearWindow(now);

    const found = await withTenant(ctx.tenant.id, async (tx) => {
      const [partner] = await tx
        .select()
        .from(channelPartners)
        .where(
          and(
            eq(channelPartners.id, input.id),
            eq(channelPartners.tenantId, ctx.tenant.id),
            isNull(channelPartners.deletedAt),
          ),
        )
        .limit(1);

      if (!partner) return null;

      const locked = await tx
        .select({
          id: leads.id,
          reference: leads.reference,
          name: leads.name,
          cpLockedUntil: leads.cpLockedUntil,
        })
        .from(leads)
        .where(
          and(
            eq(leads.channelPartnerId, partner.id),
            eq(leads.tenantId, ctx.tenant.id),
            isNull(leads.deletedAt),
            sql`${leads.cpLockedUntil} IS NOT NULL AND ${leads.cpLockedUntil} > now()`,
          ),
        )
        .orderBy(asc(leads.cpLockedUntil))
        .limit(200);

      /**
       * ══════════════════════════════════════════════════════════════
       * 🔴 TWO CORRECTIONS TO THIS QUERY IN v1.25.0-alpha
       * ══════════════════════════════════════════════════════════════
       * ① IT IS BOUNDED TO THE FINANCIAL YEAR. The 194H threshold is a
       *    FINANCIAL-YEAR threshold. Accumulating every live booking a
       *    partner has ever had crosses ₹20,000 permanently and starts
       *    deducting on a fresh year that has earned nothing.
       *
       * ② IT IS ORDERED OLDEST FIRST. The running total below only
       *    means anything in the order the year actually happened.
       *    Newest-first accumulation charged the threshold catch-up
       *    against the most recent booking and left April's carrying
       *    nothing, which is the reverse of what the section says.
       */
      const live = await tx
        .select({
          reference: bookings.reference,
          agreementValueMinor: bookings.agreementValueMinor,
          bookedAt: bookings.bookedAt,
        })
        .from(bookings)
        .where(
          and(
            eq(bookings.channelPartnerId, partner.id),
            eq(bookings.tenantId, ctx.tenant.id),
            sql`${bookings.status} <> 'cancelled'`,
            sql`${bookings.bookedAt} >= ${fyStart}::timestamptz`,
            sql`${bookings.bookedAt} < ${fyEnd}::timestamptz`,
          ),
        )
        .orderBy(asc(bookings.bookedAt))
        .limit(200);

      return { partner, locked, live };
    });

    if (!found) {
      return salesFail("That channel partner does not exist, or you cannot see it.");
    }

    const { partner, locked, live } = found;

    // ⚠️ TDS accumulates across the year. Each booking is assessed
    // against the running total, not in isolation — otherwise a partner
    // paid ₹15,000 twice never crosses the ₹20,000 threshold and the
    // company under-deducts.
    let ytd = 0n;
    /**
     * ⭐ AND THE TAX ALREADY DEDUCTED IS CARRIED TOO, FROM v1.25.0-alpha.
     *
     * 🔴 194H is `aggregate_whole`: once the year crosses the threshold,
     * tax is due on everything credited in it. `computeTds` charges the
     * whole running base and subtracts what has been deducted already —
     * so a running gross with no running tax would re-charge the catch-up
     * on every row below it and show a partner a payout that shrinks
     * further with each booking they win.
     */
    let ytdTds = 0n;
    const pipeline = live.map((booking) => {
      const commission = computeCommission({
        basis: partner.commissionBasis,
        rateBps: partner.commissionRateBps,
        monthsCentis: partner.commissionMonthsCentis,
        flatMinor: partner.commissionFlatMinor,
        agreementValueMinor: booking.agreementValueMinor,
      });

      /**
       * ⚠️ THE BOOKING DATE, NOT TODAY. This is a projection of what
       * would be deducted on each booking in the pipeline, and a rate
       * resolved against "now" would restate a booking made before the
       * October 2024 rate change at today's rate.
       */
      const tds = computeTds({
        grossMinor: commission.grossMinor,
        hasPan: Boolean(partner.panNumber),
        onDate: isoDay(booking.bookedAt),
        ytdGrossMinor: ytd,
        ytdTdsMinor: ytdTds,
      });

      ytd += commission.grossMinor;
      ytdTds += tds.tdsMinor;

      return {
        bookingReference: booking.reference,
        agreementValueMinor: (booking.agreementValueMinor ?? 0n).toString(),
        commission,
        tds,
      };
    });

    return {
      ok: true,
      data: {
        partner,
        payoutBlocker: payoutBlockerFor(partner),
        lockedLeads: locked.map((l) => ({
          id: l.id,
          reference: l.reference,
          name: l.name,
          daysRemaining: cpLockDaysRemaining(l.cpLockedUntil, now),
        })),
        pipeline,
      },
    };
  } catch (err) {
    return toSalesActionError(err, "getChannelPartner");
  }
}

/* ------------------------------------------------------------------ */
/* WRITE                                                              */
/* ------------------------------------------------------------------ */

export async function createChannelPartner(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await guardSalesWrite({
      operation: "partners:manage",
      feature: "sales.channel_partners",
      permission: "partners:manage",
    });

    const data = createChannelPartnerSchema.parse(input);

    const created = await withTenant(ctx.tenant.id, async (tx) => {
      const [row] = await tx
        .insert(channelPartners)
        .values({
          tenantId: ctx.tenant.id,
          code: data.code,
          firmName: data.firmName,
          contactName: data.contactName,
          phone: data.phone,
          email: data.email ?? null,
          reraNumber: data.reraNumber ?? null,
          panNumber: data.panNumber ?? null,
          gstin: data.gstin ?? null,
          commissionBasis: data.commissionBasis,
          commissionRateBps: data.commissionRateBps,
          commissionMonthsCentis: data.commissionMonthsCentis ?? null,
          commissionFlatMinor: data.commissionFlat
            ? toMinorUnits(data.commissionFlat)
            : null,
          // ⚠️ NEW PARTNERS START `pending`, NOT `active`.
          //
          // An active partner can be attributed leads and accrue
          // commission. Making that the default means a half-registered
          // broker starts earning before anybody has checked their RERA
          // number.
          status: "pending",
          kycStatus: "pending",
          notes: data.notes ?? null,
        })
        .returning({ id: channelPartners.id });
      return row ?? null;
    });

    if (!created) return salesFail("The channel partner could not be created.");

    await writeAudit(ctx, {
      action: "create",
      resourceType: "channel_partner",
      resourceId: created.id,
      newValue: {
        code: data.code,
        firmName: data.firmName,
        commissionBasis: data.commissionBasis,
        commissionRateBps: data.commissionRateBps,
      },
      severity: "warning",
    });

    revalidatePath("/sales/partners");
    return { ok: true, data: created };
  } catch (err) {
    return toSalesActionError(err, "createChannelPartner");
  }
}

export async function updateChannelPartner(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await guardSalesWrite({
      operation: "partners:manage",
      feature: "sales.channel_partners",
      permission: "partners:manage",
    });

    const data = updateChannelPartnerSchema.parse(input);

    const outcome = await withTenant(ctx.tenant.id, async (tx) => {
      const [existing] = await tx
        .select()
        .from(channelPartners)
        .where(
          and(
            eq(channelPartners.id, data.id),
            eq(channelPartners.tenantId, ctx.tenant.id),
            isNull(channelPartners.deletedAt),
          ),
        )
        .limit(1);

      if (!existing) return { kind: "not_found" as const };

      // ⚠️ CHANGING THE COMMISSION RATE ON A PARTNER WITH LIVE BOOKINGS.
      //
      // Refused, and this is the sort of rule that only exists because
      // the alternative is indefensible: the commission on a booking is
      // computed from the partner's CURRENT rate, so lowering the rate
      // silently reduces what is owed on sales that already happened.
      //
      // Nobody would do that deliberately. Somebody absolutely would
      // renegotiate a rate for future business and not realise it applied
      // backwards.
      const rateChanged =
        (data.commissionRateBps !== undefined &&
          data.commissionRateBps !== existing.commissionRateBps) ||
        (data.commissionBasis !== undefined &&
          data.commissionBasis !== existing.commissionBasis);

      if (rateChanged) {
        const [live] = await tx
          .select({ value: count() })
          .from(bookings)
          .where(
            and(
              eq(bookings.channelPartnerId, existing.id),
              eq(bookings.tenantId, ctx.tenant.id),
              sql`${bookings.status} <> 'cancelled'`,
            ),
          );

        if (Number(live?.value ?? 0) > 0) {
          return {
            kind: "refused" as const,
            message:
              `${existing.firmName} has ${live?.value} live booking(s), and ` +
              `commission is computed from the current rate — changing it now ` +
              `would alter what is owed on sales that have already happened. ` +
              `Register a new partner record for the new terms, or settle the ` +
              `outstanding bookings first.`,
          };
        }
      }

      await tx
        .update(channelPartners)
        .set({
          ...(data.code !== undefined ? { code: data.code } : {}),
          ...(data.firmName !== undefined ? { firmName: data.firmName } : {}),
          ...(data.contactName !== undefined ? { contactName: data.contactName } : {}),
          ...(data.phone !== undefined ? { phone: data.phone } : {}),
          ...(data.email !== undefined ? { email: data.email } : {}),
          ...(data.reraNumber !== undefined ? { reraNumber: data.reraNumber } : {}),
          ...(data.panNumber !== undefined ? { panNumber: data.panNumber } : {}),
          ...(data.gstin !== undefined ? { gstin: data.gstin } : {}),
          ...(data.commissionBasis !== undefined
            ? { commissionBasis: data.commissionBasis }
            : {}),
          ...(data.commissionRateBps !== undefined
            ? { commissionRateBps: data.commissionRateBps }
            : {}),
          ...(data.commissionMonthsCentis !== undefined
            ? { commissionMonthsCentis: data.commissionMonthsCentis }
            : {}),
          ...(data.commissionFlat !== undefined
            ? {
                commissionFlatMinor: data.commissionFlat
                  ? toMinorUnits(data.commissionFlat)
                  : null,
              }
            : {}),
          ...(data.notes !== undefined ? { notes: data.notes } : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(channelPartners.id, data.id),
            eq(channelPartners.tenantId, ctx.tenant.id),
          ),
        );

      return { kind: "ok" as const, rateChanged };
    });

    if (outcome.kind === "not_found") {
      return salesFail("That channel partner does not exist, or you cannot see it.");
    }
    if (outcome.kind === "refused") return salesFail(outcome.message);

    await writeAudit(ctx, {
      action: "update",
      resourceType: "channel_partner",
      resourceId: data.id,
      newValue: { ...data } as Record<string, unknown>,
      severity: outcome.rateChanged ? "warning" : undefined,
    });

    revalidatePath("/sales/partners");
    return { ok: true, data: { id: data.id } };
  } catch (err) {
    return toSalesActionError(err, "updateChannelPartner");
  }
}

export async function setChannelPartnerStatus(input: unknown): Promise<
  ActionResult<{ id: string }>
> {
  try {
    const ctx = await guardSalesWrite({
      operation: "partners:manage",
      feature: "sales.channel_partners",
      permission: "partners:manage",
    });

    const data = setPartnerStatusSchema.parse(input);

    if (
      (data.status === "suspended" || data.status === "terminated") &&
      !data.reason?.trim()
    ) {
      return salesFail(
        "Say why. Suspending or terminating a partner stops their commission, " +
          "and they will ask.",
      );
    }

    const outcome = await withTenant(ctx.tenant.id, async (tx) => {
      const result = await tx
        .update(channelPartners)
        .set({ status: data.status, updatedAt: new Date() })
        .where(
          and(
            eq(channelPartners.id, data.id),
            eq(channelPartners.tenantId, ctx.tenant.id),
            isNull(channelPartners.deletedAt),
          ),
        )
        .returning({ id: channelPartners.id, firmName: channelPartners.firmName });
      return result[0] ?? null;
    });

    if (!outcome) {
      return salesFail("That channel partner does not exist, or you cannot see it.");
    }

    await writeAudit(ctx, {
      action: "update",
      resourceType: "channel_partner",
      resourceId: data.id,
      newValue: { status: data.status },
      reason: data.reason ?? undefined,
      severity: "warning",
      metadata: { firmName: outcome.firmName },
    });

    revalidatePath("/sales/partners");
    return { ok: true, data: { id: data.id } };
  } catch (err) {
    return toSalesActionError(err, "setChannelPartnerStatus");
  }
}

/**
 * ⭐ Clear a lead's commission-protection window.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE PERMISSION THAT SETTLES A BROKER DISPUTE
 * ══════════════════════════════════════════════════════════════════════
 * A broker registered this buyer, so the buyer is theirs until the window
 * closes. Clearing it early moves a commission somebody has already
 * earned to somebody else.
 *
 * That is sometimes the correct answer — the broker released the lead,
 * the registration was a duplicate, the buyer says they never met them.
 * It is never a routine one.
 *
 * FOUR THINGS MAKE IT DELIBERATE:
 *   1. Its own permission, `partners:override_lock`, held by almost
 *      nobody and absent from the sales-executive role.
 *   2. A mandatory reason.
 *   3. Marked dangerous, so a DENIED attempt is recorded too.
 *   4. Audited at `critical`, because this is the record produced when
 *      the broker's lawyer asks who decided and when.
 *
 * The trigger `leads_cp_lock` refuses the re-attribution until this has
 * run. There is no other route.
 */
export async function clearCommissionLock(input: {
  leadId: string;
  reason: string;
}): Promise<ActionResult<{ leadId: string }>> {
  try {
    const ctx = await guardSalesWrite({
      operation: "partners:override_lock",
      feature: "sales.channel_partners",
      permission: "partners:override_lock",
    });

    const reason = input.reason?.trim() ?? "";
    if (reason.length < 10) {
      return salesFail(
        "Record why this protection window is being cleared, in a sentence. " +
          "This is the record that answers the broker's question later.",
      );
    }

    const outcome = await withTenant(ctx.tenant.id, async (tx) => {
      const [existing] = await tx
        .select({
          id: leads.id,
          reference: leads.reference,
          channelPartnerId: leads.channelPartnerId,
          cpLockedUntil: leads.cpLockedUntil,
        })
        .from(leads)
        .where(
          and(
            eq(leads.id, input.leadId),
            eq(leads.tenantId, ctx.tenant.id),
            isNull(leads.deletedAt),
          ),
        )
        .limit(1);

      if (!existing) return { kind: "not_found" as const };
      if (!existing.cpLockedUntil) {
        return { kind: "no_lock" as const };
      }

      await tx
        .update(leads)
        .set({ cpLockedUntil: null, updatedAt: new Date() })
        .where(and(eq(leads.id, input.leadId), eq(leads.tenantId, ctx.tenant.id)));

      return {
        kind: "ok" as const,
        reference: existing.reference,
        partnerId: existing.channelPartnerId,
        was: existing.cpLockedUntil,
      };
    });

    if (outcome.kind === "not_found") {
      return salesFail("That lead does not exist, or you cannot see it.");
    }
    if (outcome.kind === "no_lock") {
      return salesFail("That lead has no commission-protection window to clear.");
    }

    await writeAudit(ctx, {
      action: "update",
      resourceType: "lead",
      resourceId: input.leadId,
      oldValue: {
        cpLockedUntil: outcome.was.toISOString(),
        channelPartnerId: outcome.partnerId,
      },
      newValue: { cpLockedUntil: null },
      reason,
      severity: "critical",
      metadata: { leadReference: outcome.reference },
    });

    revalidatePath(`/sales/leads/${input.leadId}`);
    return { ok: true, data: { leadId: input.leadId } };
  } catch (err) {
    return toSalesActionError(err, "clearCommissionLock");
  }
}
