"use server";

/**
 * Ordence — Booking & Payment-Plan Actions
 * Version: v0.22.0-alpha
 *
 * ⚠️ Every export is an async function.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE ONE THAT MATTERS
 * ══════════════════════════════════════════════════════════════════════
 * Everything else in this product is recoverable with an UPDATE. This is
 * not: two live bookings on one flat means two families have been
 * promised the same property, and the remedy is a refund, a broken
 * relationship and possibly a RERA complaint.
 *
 * There are THREE layers, and it is worth being explicit about which one
 * does what, because only the last is a guarantee:
 *
 *   1. `canBook()` — a friendly pre-check, so the common case is an
 *      explanation rather than an error. RACES. Not protection.
 *   2. The trigger `bookings_unit_bookable` — takes `FOR UPDATE` on the
 *      unit, so concurrent attempts serialise. Catches blocked, sold,
 *      and held-for-somebody-else.
 *   3. ⭐ The partial unique index `bookings_one_live_per_unit` — the
 *      actual guarantee. The loser gets 23505, which
 *      `toSalesActionError` turns into a sentence about what happened.
 *
 * Layer 1 alone is what a single-organisation app ships with, and it is
 * the reason double-sales happen.
 */

import { and, asc, count, desc, eq, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withTenant } from "@/db";
import {
  bookings,
  units,
  leads,
  projects,
  channelPartners,
  paymentMilestones,
} from "@/db/schema";
import { requirePermission, writeAudit } from "@/server/audit";
import { guardSalesWrite, salesFail, toSalesActionError } from "@/server/sales/guards";
import { withGeneratedReference } from "@/server/sales/references";
import {
  createBookingSchema,
  advanceBookingSchema,
  cancelBookingSchema,
  generatePlanSchema,
  recordMilestonePaymentSchema,
} from "@/lib/validators/sales";
import { toMinorUnits } from "@/lib/validators/accounting";
import { canBook } from "@/lib/sales/inventory";
import {
  buildPlan,
  templateFor,
  summarisePlan,
  deriveMilestoneStatus,
  PLAN_TEMPLATES,
} from "@/lib/sales/payment-plan";
import { computeCommission } from "@/lib/sales/commission";
import type { ActionResult } from "@/lib/validators/crm";
import type { Booking, PaymentMilestone } from "@/db/schema/sales";

/* ------------------------------------------------------------------ */
/* READ                                                               */
/* ------------------------------------------------------------------ */

export type BookingRow = Booking & {
  unitCode: string | null;
  projectName: string | null;
  leadName: string | null;
  partnerFirmName: string | null;
};

export async function listBookings(input: { projectId?: string } = {}): Promise<
  ActionResult<{ rows: BookingRow[]; total: number }>
> {
  try {
    const ctx = await requirePermission("bookings:read");

    const result = await withTenant(ctx.tenant.id, async (tx) => {
      const conditions = [eq(bookings.tenantId, ctx.tenant.id)];
      if (input.projectId) conditions.push(eq(units.projectId, input.projectId));
      const where = and(...conditions);

      const rows = await tx
        .select({
          booking: bookings,
          unitCode: units.code,
          projectName: projects.name,
          leadName: leads.name,
          partnerFirmName: channelPartners.firmName,
        })
        .from(bookings)
        .leftJoin(
          units,
          and(eq(units.id, bookings.unitId), eq(units.tenantId, ctx.tenant.id)),
        )
        .leftJoin(
          projects,
          and(eq(projects.id, units.projectId), eq(projects.tenantId, ctx.tenant.id)),
        )
        .leftJoin(
          leads,
          and(eq(leads.id, bookings.leadId), eq(leads.tenantId, ctx.tenant.id)),
        )
        .leftJoin(
          channelPartners,
          and(
            eq(channelPartners.id, bookings.channelPartnerId),
            eq(channelPartners.tenantId, ctx.tenant.id),
          ),
        )
        .where(where)
        .orderBy(desc(bookings.bookedAt))
        .limit(200);

      const [totals] = await tx.select({ value: count() }).from(bookings).where(
        eq(bookings.tenantId, ctx.tenant.id),
      );

      return {
        rows: rows.map((r) => ({
          ...r.booking,
          unitCode: r.unitCode ?? null,
          projectName: r.projectName ?? null,
          leadName: r.leadName ?? null,
          partnerFirmName: r.partnerFirmName ?? null,
        })),
        total: Number(totals?.value ?? 0),
      };
    });

    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "listBookings");
  }
}

export async function getBooking(input: { id: string }): Promise<
  ActionResult<{
    booking: BookingRow;
    milestones: PaymentMilestone[];
    summary: ReturnType<typeof summarisePlan>;
    commission: ReturnType<typeof computeCommission> | null;
  }>
> {
  try {
    const ctx = await requirePermission("bookings:read");
    const now = new Date();

    const found = await withTenant(ctx.tenant.id, async (tx) => {
      const [row] = await tx
        .select({
          booking: bookings,
          unitCode: units.code,
          projectName: projects.name,
          leadName: leads.name,
          partnerFirmName: channelPartners.firmName,
          partnerBasis: channelPartners.commissionBasis,
          partnerRateBps: channelPartners.commissionRateBps,
          partnerMonthsCentis: channelPartners.commissionMonthsCentis,
          partnerFlatMinor: channelPartners.commissionFlatMinor,
        })
        .from(bookings)
        .leftJoin(
          units,
          and(eq(units.id, bookings.unitId), eq(units.tenantId, ctx.tenant.id)),
        )
        .leftJoin(
          projects,
          and(eq(projects.id, units.projectId), eq(projects.tenantId, ctx.tenant.id)),
        )
        .leftJoin(
          leads,
          and(eq(leads.id, bookings.leadId), eq(leads.tenantId, ctx.tenant.id)),
        )
        .leftJoin(
          channelPartners,
          and(
            eq(channelPartners.id, bookings.channelPartnerId),
            eq(channelPartners.tenantId, ctx.tenant.id),
          ),
        )
        .where(and(eq(bookings.id, input.id), eq(bookings.tenantId, ctx.tenant.id)))
        .limit(1);

      if (!row) return null;

      const milestones = await tx
        .select()
        .from(paymentMilestones)
        .where(
          and(
            eq(paymentMilestones.bookingId, row.booking.id),
            eq(paymentMilestones.tenantId, ctx.tenant.id),
          ),
        )
        .orderBy(asc(paymentMilestones.sequence));

      return { row, milestones };
    });

    if (!found) return salesFail("That booking does not exist, or you cannot see it.");

    const { row, milestones } = found;

    const commission = row.partnerBasis
      ? computeCommission({
          basis: row.partnerBasis,
          rateBps: row.partnerRateBps ?? 0,
          monthsCentis: row.partnerMonthsCentis,
          flatMinor: row.partnerFlatMinor,
          agreementValueMinor: row.booking.agreementValueMinor,
        })
      : null;

    return {
      ok: true,
      data: {
        booking: {
          ...row.booking,
          unitCode: row.unitCode ?? null,
          projectName: row.projectName ?? null,
          leadName: row.leadName ?? null,
          partnerFirmName: row.partnerFirmName ?? null,
        },
        milestones,
        summary: summarisePlan(
          milestones.map((m) => ({
            label: m.label,
            sequence: m.sequence,
            amountMinor: m.amountMinor,
            amountPaidMinor: m.amountPaidMinor,
            dueDate: m.dueDate,
          })),
          now,
        ),
        commission,
      },
    };
  } catch (err) {
    return toSalesActionError(err, "getBooking");
  }
}

export async function listPlanTemplates(): Promise<
  ActionResult<{ templates: typeof PLAN_TEMPLATES }>
> {
  try {
    await requirePermission("payment_plans:read");
    return { ok: true, data: { templates: PLAN_TEMPLATES } };
  } catch (err) {
    return toSalesActionError(err, "listPlanTemplates");
  }
}

/* ------------------------------------------------------------------ */
/* ⭐ CREATE — THE DOUBLE-SALE PATH                                    */
/* ------------------------------------------------------------------ */

export async function createBooking(input: unknown): Promise<
  ActionResult<{ id: string; reference: string }>
> {
  try {
    const ctx = await guardSalesWrite({
      operation: "bookings:create",
      feature: "sales.bookings",
      permission: "bookings:create",
    });

    const data = createBookingSchema.parse(input);
    const now = new Date();
    const agreementValueMinor = toMinorUnits(data.agreementValue);

    if (agreementValueMinor <= 0n) {
      return salesFail("The agreement value must be greater than zero.");
    }

    const outcome = await withTenant(ctx.tenant.id, async (tx) => {
      // ⚠️ FOR UPDATE — the same lock the trigger takes. Taking it here
      // too means the friendly pre-check below is reading a row nobody
      // else can change until we commit, so the common case is an
      // explanation rather than a constraint violation.
      const locked = (await tx.execute(sql`
        SELECT id, code, status, deleted_at, hold_until, held_for_lead_id
          FROM units
         WHERE id = ${data.unitId} AND tenant_id = ${ctx.tenant.id}
         FOR UPDATE
      `)) as unknown as { rows?: Record<string, unknown>[] };

      const unitRow = (Array.isArray(locked) ? locked[0] : locked.rows?.[0]) as
        | {
            id: string;
            code: string;
            status: "available" | "held" | "booked" | "sold" | "blocked";
            deleted_at: Date | null;
            hold_until: Date | null;
            held_for_lead_id: string | null;
          }
        | undefined;

      if (!unitRow) return { kind: "no_unit" as const };

      const [lead] = await tx
        .select({ id: leads.id, name: leads.name, status: leads.status })
        .from(leads)
        .where(
          and(
            eq(leads.id, data.leadId),
            eq(leads.tenantId, ctx.tenant.id),
            isNull(leads.deletedAt),
          ),
        )
        .limit(1);

      if (!lead) return { kind: "no_lead" as const };

      const verdict = canBook(
        {
          code: unitRow.code,
          status: unitRow.status,
          deletedAt: unitRow.deleted_at,
          holdUntil: unitRow.hold_until,
          heldForLeadId: unitRow.held_for_lead_id,
        },
        data.leadId,
        now,
      );

      if (!verdict.allowed) {
        return { kind: "refused" as const, message: `${verdict.reason} ${verdict.remedy}` };
      }

      const created = await withGeneratedReference(tx, "booking", async (reference) => {
        const [row] = await tx
          .insert(bookings)
          .values({
            tenantId: ctx.tenant.id,
            reference,
            leadId: data.leadId,
            unitId: data.unitId,
            salesRepId: data.salesRepId ?? ctx.user.id,
            channelPartnerId: data.channelPartnerId ?? null,
            status: "tentative",
            paymentStatus: "pending",
            agreementValueMinor,
            bookedAt: now,
            customFields: data.customFields ?? {},
          })
          .returning({ id: bookings.id, reference: bookings.reference });
        if (!row) throw new Error("Booking insert returned no row.");
        return row;
      });

      // The lead follows the booking. Doing it in the same transaction
      // is what stops the board saying "negotiation" while the flat says
      // "booked" — the two are reported to different people, and they
      // notice.
      await tx
        .update(leads)
        .set({ status: "booked", updatedAt: now })
        .where(and(eq(leads.id, data.leadId), eq(leads.tenantId, ctx.tenant.id)));

      // Optional payment plan, in the SAME transaction. A booking that
      // exists with no plan because the second call failed is a booking
      // nobody can raise a demand against.
      let planStages = 0;
      if (data.planTemplateKey) {
        const template = templateFor(data.planTemplateKey);
        if (!template) return { kind: "no_template" as const };

        const plan = buildPlan({ agreementValueMinor, stages: template.stages });
        if (!plan.ok) {
          return { kind: "refused" as const, message: plan.problem.message };
        }

        await tx.insert(paymentMilestones).values(
          plan.milestones.map((m) => ({
            tenantId: ctx.tenant.id,
            bookingId: created.id,
            label: m.label,
            amountMinor: m.amountMinor,
            sequence: m.sequence,
            status: "pending" as const,
          })),
        );
        planStages = plan.milestones.length;
      }

      return {
        kind: "ok" as const,
        booking: created,
        unitCode: unitRow.code,
        leadName: lead.name,
        planStages,
      };
    });

    if (outcome.kind === "no_unit") {
      return salesFail("That unit does not exist, or you cannot see it.");
    }
    if (outcome.kind === "no_lead") {
      return salesFail("That lead does not exist, or you cannot see it.");
    }
    if (outcome.kind === "no_template") {
      return salesFail("That payment plan template does not exist.");
    }
    if (outcome.kind === "refused") return salesFail(outcome.message);

    await writeAudit(ctx, {
      action: "create",
      resourceType: "booking",
      resourceId: outcome.booking.id,
      newValue: {
        reference: outcome.booking.reference,
        unitCode: outcome.unitCode,
        buyer: outcome.leadName,
        agreementValueMinor: agreementValueMinor.toString(),
      },
      metadata: { planStages: outcome.planStages },
      severity: "warning",
    });

    revalidatePath("/sales/bookings");
    revalidatePath("/sales/inventory");
    return { ok: true, data: outcome.booking };
  } catch (err) {
    return toSalesActionError(err, "createBooking");
  }
}

/* ------------------------------------------------------------------ */
/* ADVANCE                                                            */
/* ------------------------------------------------------------------ */

/**
 * Move a booking forward: tentative → confirmed → agreement → registered.
 *
 * ⚠️ FORWARD ONLY. Reversing a registered sale to "tentative" would be a
 * silent unwind of a completed transaction — the unit would go from
 * `sold` back to `booked` with no record of why. The route back is
 * cancellation, which requires a reason and records the money.
 */
export async function advanceBooking(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await guardSalesWrite({
      operation: "bookings:update",
      feature: "sales.bookings",
      permission: "bookings:update",
    });

    const data = advanceBookingSchema.parse(input);
    const order = ["tentative", "confirmed", "agreement", "registered"] as const;

    const outcome = await withTenant(ctx.tenant.id, async (tx) => {
      const [existing] = await tx
        .select({ id: bookings.id, status: bookings.status, leadId: bookings.leadId })
        .from(bookings)
        .where(and(eq(bookings.id, data.id), eq(bookings.tenantId, ctx.tenant.id)))
        .limit(1);

      if (!existing) return { kind: "not_found" as const };

      if (existing.status === "cancelled") {
        return {
          kind: "refused" as const,
          message:
            "This booking was cancelled. A cancelled booking cannot be revived — " +
            "create a new one against the unit.",
        };
      }

      const from = order.indexOf(existing.status as (typeof order)[number]);
      const to = order.indexOf(data.status);

      if (to < from) {
        return {
          kind: "refused" as const,
          message:
            `A booking cannot go back from ${existing.status} to ${data.status}. ` +
            `If the sale has fallen through, cancel it with a reason — that frees ` +
            `the unit and records what happened.`,
        };
      }

      await tx
        .update(bookings)
        .set({ status: data.status, updatedAt: new Date() })
        .where(and(eq(bookings.id, data.id), eq(bookings.tenantId, ctx.tenant.id)));

      // A registered sale is a won lead. This is the ONLY route to `won`
      // — see rule 1 in `lib/sales/pipeline.ts`.
      if (data.status === "registered" && existing.leadId) {
        await tx
          .update(leads)
          .set({ status: "won", updatedAt: new Date() })
          .where(and(eq(leads.id, existing.leadId), eq(leads.tenantId, ctx.tenant.id)));
      }

      return { kind: "ok" as const, from: existing.status };
    });

    if (outcome.kind === "not_found") {
      return salesFail("That booking does not exist, or you cannot see it.");
    }
    if (outcome.kind === "refused") return salesFail(outcome.message);

    await writeAudit(ctx, {
      action: "update",
      resourceType: "booking",
      resourceId: data.id,
      oldValue: { status: outcome.from },
      newValue: { status: data.status },
      severity: data.status === "registered" ? "warning" : undefined,
    });

    revalidatePath("/sales/bookings");
    revalidatePath("/sales/inventory");
    return { ok: true, data: { id: data.id } };
  } catch (err) {
    return toSalesActionError(err, "advanceBooking");
  }
}

/* ------------------------------------------------------------------ */
/* CANCEL                                                             */
/* ------------------------------------------------------------------ */

/**
 * Cancel a booking.
 *
 * ⚠️ THE MOST CONSEQUENTIAL WRITE IN THE PHASE, AND IT IS NOT A DELETE.
 *
 * Cancelling frees the unit (via the trigger `bookings_sync_unit`) and
 * records what happens to the money. Both halves matter:
 *
 *   • Freeing the unit is why a cancelled booking must not occupy the
 *     `bookings_one_live_per_unit` slot.
 *   • `forfeit` and `refund` are NEGOTIATED SEPARATELY and both appear in
 *     the ledger. A single "refund" number loses the distinction that
 *     the buyer's lawyer asks about first.
 *
 * There is no `deleteBooking`, and there is no DELETE grant on the table.
 * Erasing a booking would free the unit exactly the same way while
 * removing the evidence that it ever existed — which is precisely what
 * somebody covering up a double-sale would want.
 */
export async function cancelBooking(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await guardSalesWrite({
      operation: "bookings:cancel",
      feature: "sales.bookings",
      permission: "bookings:cancel",
    });

    const data = cancelBookingSchema.parse(input);
    const now = new Date();

    const forfeitMinor = data.forfeitAmount ? toMinorUnits(data.forfeitAmount) : null;
    const refundMinor = data.refundAmount ? toMinorUnits(data.refundAmount) : null;

    const outcome = await withTenant(ctx.tenant.id, async (tx) => {
      const [existing] = await tx
        .select({
          id: bookings.id,
          status: bookings.status,
          leadId: bookings.leadId,
          unitId: bookings.unitId,
          agreementValueMinor: bookings.agreementValueMinor,
          reference: bookings.reference,
        })
        .from(bookings)
        .where(and(eq(bookings.id, data.id), eq(bookings.tenantId, ctx.tenant.id)))
        .limit(1);

      if (!existing) return { kind: "not_found" as const };
      if (existing.status === "cancelled") {
        return { kind: "already" as const };
      }

      // ⚠️ Forfeit plus refund cannot exceed what was collected, and we
      // do not know what was collected without the milestones. Checked
      // against the plan rather than the agreement value, because a
      // buyer who has paid ₹5 lakh cannot be refunded ₹50 lakh.
      const collected = await tx
        .select({
          value: sql<string>`COALESCE(SUM(${paymentMilestones.amountPaidMinor}), 0)::text`,
        })
        .from(paymentMilestones)
        .where(
          and(
            eq(paymentMilestones.bookingId, existing.id),
            eq(paymentMilestones.tenantId, ctx.tenant.id),
          ),
        );

      const collectedMinor = BigInt(collected[0]?.value ?? "0");
      const disbursed = (forfeitMinor ?? 0n) + (refundMinor ?? 0n);

      if (collectedMinor > 0n && disbursed > collectedMinor) {
        return {
          kind: "refused" as const,
          message:
            `The forfeit and refund together come to more than the buyer has ` +
            `actually paid on this booking. Check the two figures against the ` +
            `payment history.`,
        };
      }

      await tx
        .update(bookings)
        .set({
          status: "cancelled",
          cancelledAt: now,
          cancelReason: data.reason,
          forfeitAmountMinor: forfeitMinor,
          refundAmountMinor: refundMinor,
          updatedAt: now,
        })
        .where(and(eq(bookings.id, data.id), eq(bookings.tenantId, ctx.tenant.id)));

      // The lead goes back into the pipeline rather than to `lost`. A
      // buyer who withdrew from one flat frequently buys another, and
      // marking them lost removes them from every follow-up list.
      if (existing.leadId) {
        await tx
          .update(leads)
          .set({ status: "negotiation", updatedAt: now })
          .where(and(eq(leads.id, existing.leadId), eq(leads.tenantId, ctx.tenant.id)));
      }

      return { kind: "ok" as const, reference: existing.reference, unitId: existing.unitId };
    });

    if (outcome.kind === "not_found") {
      return salesFail("That booking does not exist, or you cannot see it.");
    }
    if (outcome.kind === "already") {
      return salesFail("That booking has already been cancelled.");
    }
    if (outcome.kind === "refused") return salesFail(outcome.message);

    await writeAudit(ctx, {
      action: "update",
      resourceType: "booking",
      resourceId: data.id,
      oldValue: { status: "live" },
      newValue: {
        status: "cancelled",
        forfeitMinor: forfeitMinor?.toString() ?? null,
        refundMinor: refundMinor?.toString() ?? null,
      },
      reason: data.reason,
      severity: "warning",
      metadata: { reference: outcome.reference, unitId: outcome.unitId },
    });

    revalidatePath("/sales/bookings");
    revalidatePath("/sales/inventory");
    return { ok: true, data: { id: data.id } };
  } catch (err) {
    return toSalesActionError(err, "cancelBooking");
  }
}

/* ------------------------------------------------------------------ */
/* PAYMENT PLANS                                                      */
/* ------------------------------------------------------------------ */

export async function generatePaymentPlan(input: unknown): Promise<
  ActionResult<{ bookingId: string; stages: number }>
> {
  try {
    const ctx = await guardSalesWrite({
      operation: "payment_plans:manage",
      feature: "sales.payment_plans",
      permission: "payment_plans:manage",
    });

    const data = generatePlanSchema.parse(input);

    const stages = data.stages?.length
      ? data.stages
      : (templateFor(data.templateKey ?? "")?.stages ?? null);

    if (!stages) {
      return salesFail(
        "Choose a payment plan template, or define the stages yourself.",
      );
    }

    const outcome = await withTenant(ctx.tenant.id, async (tx) => {
      const [booking] = await tx
        .select({
          id: bookings.id,
          status: bookings.status,
          agreementValueMinor: bookings.agreementValueMinor,
        })
        .from(bookings)
        .where(and(eq(bookings.id, data.bookingId), eq(bookings.tenantId, ctx.tenant.id)))
        .limit(1);

      if (!booking) return { kind: "not_found" as const };
      if (booking.status === "cancelled") {
        return {
          kind: "refused" as const,
          message: "This booking was cancelled. There is nothing to collect against it.",
        };
      }
      if (booking.agreementValueMinor == null) {
        return {
          kind: "refused" as const,
          message: "Record the agreed sale value before generating a payment plan.",
        };
      }

      // ⚠️ REGENERATION IS REFUSED ONCE MONEY HAS MOVED.
      //
      // Replacing a plan a buyer has already paid against would discard
      // the record of what they paid and against what. Adjusting a live
      // plan is a different operation with a different conversation.
      const existing = await tx
        .select({
          id: paymentMilestones.id,
          amountPaidMinor: paymentMilestones.amountPaidMinor,
        })
        .from(paymentMilestones)
        .where(
          and(
            eq(paymentMilestones.bookingId, booking.id),
            eq(paymentMilestones.tenantId, ctx.tenant.id),
          ),
        );

      if (existing.some((m) => m.amountPaidMinor > 0n)) {
        return {
          kind: "refused" as const,
          message:
            "Payments have already been received against this plan, so it cannot " +
            "be regenerated. Adjust the individual milestones instead.",
        };
      }

      const plan = buildPlan({
        agreementValueMinor: booking.agreementValueMinor,
        stages,
      });

      if (!plan.ok) {
        return {
          kind: "refused" as const,
          message: `${plan.problem.message} ${plan.problem.remedy}`,
        };
      }

      if (existing.length > 0) {
        await tx
          .delete(paymentMilestones)
          .where(
            and(
              eq(paymentMilestones.bookingId, booking.id),
              eq(paymentMilestones.tenantId, ctx.tenant.id),
            ),
          );
      }

      await tx.insert(paymentMilestones).values(
        plan.milestones.map((m, index) => ({
          tenantId: ctx.tenant.id,
          bookingId: booking.id,
          label: m.label,
          amountMinor: m.amountMinor,
          sequence: m.sequence,
          dueDate: data.dueDates?.[index] ?? null,
          status: "pending" as const,
        })),
      );

      return { kind: "ok" as const, stages: plan.milestones.length };
    });

    if (outcome.kind === "not_found") {
      return salesFail("That booking does not exist, or you cannot see it.");
    }
    if (outcome.kind === "refused") return salesFail(outcome.message);

    await writeAudit(ctx, {
      action: "create",
      resourceType: "payment_plan",
      resourceId: data.bookingId,
      newValue: { stages: outcome.stages, template: data.templateKey ?? "custom" },
    });

    revalidatePath(`/sales/bookings/${data.bookingId}`);
    return { ok: true, data: { bookingId: data.bookingId, stages: outcome.stages } };
  } catch (err) {
    return toSalesActionError(err, "generatePaymentPlan");
  }
}

/**
 * Record a receipt against a milestone.
 *
 * ⚠️ THIS DOES NOT POST TO THE LEDGER. The Phase 11 accounting layer is
 * where money is recorded double-entry; this records COLLECTION PROGRESS
 * against a demand, which is a different thing that happens to use the
 * same numbers. Wiring the two together is a later phase and needs a
 * conversation about which ledger accounts, not a guess.
 */
export async function recordMilestonePayment(input: unknown): Promise<
  ActionResult<{ milestoneId: string; status: string }>
> {
  try {
    const ctx = await guardSalesWrite({
      operation: "payment_plans:manage",
      feature: "sales.payment_plans",
      permission: "payment_plans:manage",
    });

    const data = recordMilestonePaymentSchema.parse(input);
    const amountMinor = toMinorUnits(data.amount);
    const now = new Date();

    if (amountMinor <= 0n) {
      return salesFail("A receipt must be greater than zero.");
    }

    const outcome = await withTenant(ctx.tenant.id, async (tx) => {
      const [milestone] = await tx
        .select()
        .from(paymentMilestones)
        .where(
          and(
            eq(paymentMilestones.id, data.milestoneId),
            eq(paymentMilestones.tenantId, ctx.tenant.id),
          ),
        )
        .limit(1);

      if (!milestone) return { kind: "not_found" as const };

      const nextPaid = milestone.amountPaidMinor + amountMinor;

      // ⚠️ Over-payment is ALLOWED but flagged, not refused. Buyers round
      // up, pay two milestones with one cheque, and add interest. A
      // refusal here means the receipt goes unrecorded, which is worse
      // than a milestone showing more collected than demanded.
      const status = deriveMilestoneStatus({
        amountMinor: milestone.amountMinor,
        amountPaidMinor: nextPaid,
        dueDate: milestone.dueDate,
        now,
      });

      await tx
        .update(paymentMilestones)
        .set({
          amountPaidMinor: nextPaid,
          status,
          paidAt: status === "paid" ? (data.paidAt ?? now) : milestone.paidAt,
          updatedAt: now,
        })
        .where(
          and(
            eq(paymentMilestones.id, data.milestoneId),
            eq(paymentMilestones.tenantId, ctx.tenant.id),
          ),
        );

      // Roll the booking's headline payment status up from the parts.
      const rows = await tx
        .select({
          amountMinor: paymentMilestones.amountMinor,
          amountPaidMinor: paymentMilestones.amountPaidMinor,
          dueDate: paymentMilestones.dueDate,
        })
        .from(paymentMilestones)
        .where(
          and(
            eq(paymentMilestones.bookingId, milestone.bookingId),
            eq(paymentMilestones.tenantId, ctx.tenant.id),
          ),
        );

      const total = rows.reduce((sum, r) => sum + r.amountMinor, 0n);
      const paid = rows.reduce(
        (sum, r) => sum + (r.amountPaidMinor > r.amountMinor ? r.amountMinor : r.amountPaidMinor),
        0n,
      );
      const anyOverdue = rows.some(
        (r) =>
          r.amountPaidMinor < r.amountMinor &&
          r.dueDate !== null &&
          r.dueDate.getTime() < now.getTime(),
      );

      const bookingStatus =
        paid >= total && total > 0n
          ? "paid"
          : anyOverdue
            ? "overdue"
            : paid > 0n
              ? "partial"
              : "pending";

      await tx
        .update(bookings)
        .set({ paymentStatus: bookingStatus, updatedAt: now })
        .where(
          and(eq(bookings.id, milestone.bookingId), eq(bookings.tenantId, ctx.tenant.id)),
        );

      return {
        kind: "ok" as const,
        status,
        bookingId: milestone.bookingId,
        overpaid: nextPaid > milestone.amountMinor,
      };
    });

    if (outcome.kind === "not_found") {
      return salesFail("That milestone does not exist, or you cannot see it.");
    }

    await writeAudit(ctx, {
      action: "update",
      resourceType: "payment_milestone",
      resourceId: data.milestoneId,
      newValue: { amountMinor: amountMinor.toString(), status: outcome.status },
      metadata: { reference: data.reference ?? null, overpaid: outcome.overpaid },
      severity: "warning",
    });

    revalidatePath(`/sales/bookings/${outcome.bookingId}`);
    return { ok: true, data: { milestoneId: data.milestoneId, status: outcome.status } };
  } catch (err) {
    return toSalesActionError(err, "recordMilestonePayment");
  }
}
