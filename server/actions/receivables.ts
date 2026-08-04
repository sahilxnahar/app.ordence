"use server";

/**
 * Ordence — ⭐ Receivables Actions
 * Version: v0.38.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION. Schemas live in
 * `lib/validators/receivables.ts`, rules in `lib/receivables/`, writes in
 * `server/receivables/`. A `"use server"` file that exports anything else
 * publishes it as an RPC endpoint reachable by anyone on the internet.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE IS RESPONSIBLE FOR, AND WHAT IT IS NOT
 * ══════════════════════════════════════════════════════════════════════
 * It asks the right questions before writing — access, entitlement,
 * permission, impersonation — and turns a refusal into a sentence
 * somebody can act on.
 *
 * It does NOT make the guarantees. One live demand per milestone, an
 * allocation that sums exactly, a ladder with no gaps, a cancellation
 * warning with a named human behind it and an issued demand whose figures
 * cannot move are constraints and triggers in
 * `SQL-FILES/0027_phase38_receivables.sql` — because this file is one of
 * several write paths, and a back-fill of a year's collection history is
 * both the one with the volume and the one that does not come through
 * here.
 *
 * ⚠️ MONEY CROSSES THE BOUNDARY AS A STRING. `JSON.stringify` throws on a
 * bigint, so every amount returned goes through `serializeAmount`.
 */

import { revalidatePath } from "next/cache";
import { requirePermission, writeAudit } from "@/server/audit";
import { requireTenantContext } from "@/server/tenant-context";
import {
  guardReceivablesWrite,
  receivablesFail,
  toReceivablesActionError,
} from "@/server/receivables/guards";
import {
  ageingQuerySchema,
  bounceReceiptSchema,
  cancelDemandSchema,
  dunningSweepSchema,
  issueDemandSchema,
  raiseDemandSchema,
  reallocateReceiptSchema,
  recordReceiptSchema,
  renderDemandNoticeSchema,
  sendDunningSchema,
  statementQuerySchema,
  supersedeDemandSchema,
  upsertDunningPolicySchema,
  upsertReceivablePolicySchema,
} from "@/lib/validators/receivables";
import {
  cancelDemand,
  issueDemand,
  noticeFactsFor,
  raiseDemand,
  supersedeDemand,
} from "@/server/receivables/demands";
import { bounceReceipt, recordReceipt, reallocateReceipt } from "@/server/receivables/receipts";
import { planDunningSweep, sendDunningLetter } from "@/server/receivables/dunning";
import { assembleStatement } from "@/server/receivables/statement";
import {
  ageingRows,
  findBookingContext,
  findDemand,
  listDemandsForBooking,
  listDunningEvents,
  listDunningPolicies,
  listReceiptsForBooking,
  listReceivablePolicies,
  resolvePolicies,
} from "@/server/receivables/registry";
import { withTenant } from "@/db";
import { and, eq } from "drizzle-orm";
import {
  dunningPolicies,
  receivablePolicies,
} from "@/db/schema/receivables";
import { ageReceivables } from "@/lib/receivables/ageing";
import { assessInterestRate } from "@/lib/receivables/interest";
import { ladderSchedule } from "@/lib/receivables/dunning";
import { renderDemandNotice, normaliseLanguage } from "@/lib/receivables/templates";
import { toCivilDay } from "@/lib/gst/constants";
import { serializeAmount } from "@/lib/billing/money";
import type { ActionResult } from "@/lib/validators/crm";

const FEATURE = "sales.receivables" as const;

/**
 * ⚠️ THE LETTERHEAD COMES FROM THE WORKSPACE, NOT FROM A FORM FIELD. A
 * demand notice signed by a name somebody typed into a text box is a
 * legal document attributed to whoever the sender felt like.
 */
async function letterhead(): Promise<{ developerName: string; contactLine: string }> {
  const ctx = await requireTenantContext();
  return {
    developerName: ctx.tenant.legalName ?? ctx.tenant.name,
    contactLine:
      "For any query on this notice, please contact the accounts department " +
      "quoting the notice number above.",
  };
}

function today(): string {
  return toCivilDay(new Date());
}

/* ================================================================== */
/* POLICIES                                                            */
/* ================================================================== */

export async function saveReceivablePolicy(
  input: unknown,
): Promise<ActionResult<{ id: string; rateFlagged: boolean; rateMessage: string }>> {
  try {
    const data = upsertReceivablePolicySchema.parse(input);
    const ctx = await guardReceivablesWrite({
      operation: "receivables:manage_policy",
      feature: FEATURE,
      permission: "receivables:manage_policy",
    });

    // ⭐ THE RERA COMPARISON, PUT IN FRONT OF THE PERSON SETTING THE RATE.
    // It does not refuse: whether a pre-RERA agreement's 24% survives
    // Section 2(za) is a legal judgement about that agreement. It makes
    // the gap impossible to not see.
    const verdict = assessInterestRate({
      rateBps: data.interestRateBps,
      referenceRateBps: data.referenceRateBps,
    });

    const saved = await withTenant(ctx.tenant.id, async (tx) => {
      const values = {
        tenantId: ctx.tenant.id,
        projectId: data.projectId ?? null,
        name: data.name,
        interestRateBps: data.interestRateBps,
        referenceRateBps: data.referenceRateBps,
        compounding: data.compounding,
        dayCount: data.dayCount,
        graceDays: data.graceDays,
        graceForgivesElapsedDays: data.graceForgivesElapsedDays,
        demandDueDays: data.demandDueDays,
        gstRateBps: data.gstRateBps,
        appropriationOrder: data.appropriationOrder,
        defaultAllocationStrategy: data.defaultAllocationStrategy,
        isActive: data.isActive,
        notes: data.notes ?? null,
        createdBy: ctx.user.id,
      };

      if (data.id) {
        const rows = await tx
          .update(receivablePolicies)
          .set(values)
          .where(
            and(
              eq(receivablePolicies.tenantId, ctx.tenant.id),
              eq(receivablePolicies.id, data.id),
            ),
          )
          .returning();
        return rows[0] ?? null;
      }

      const rows = await tx.insert(receivablePolicies).values(values).returning();
      return rows[0] ?? null;
    });

    if (!saved) return receivablesFail("That policy could not be saved.");

    await writeAudit(ctx, {
      action: data.id ? "update" : "create",
      resourceType: "receivable_policy",
      resourceId: saved.id,
      severity: verdict.exceedsReference ? "warning" : "info",
      metadata: {
        interestRateBps: data.interestRateBps,
        referenceRateBps: data.referenceRateBps,
        exceedsReference: verdict.exceedsReference,
      },
    });

    revalidatePath("/settings/receivables");
    return {
      ok: true,
      data: {
        id: saved.id,
        rateFlagged: verdict.exceedsReference,
        rateMessage: verdict.message,
      },
    };
  } catch (err) {
    return toReceivablesActionError(err, "saveReceivablePolicy");
  }
}

export async function saveDunningPolicy(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const data = upsertDunningPolicySchema.parse(input);
    const ctx = await guardReceivablesWrite({
      operation: "receivables:manage_policy",
      feature: FEATURE,
      permission: "receivables:manage_policy",
    });

    const saved = await withTenant(ctx.tenant.id, async (tx) => {
      const values = {
        tenantId: ctx.tenant.id,
        projectId: data.projectId ?? null,
        name: data.name,
        reminderAfterDays: data.reminderAfterDays,
        firstNoticeAfterDays: data.firstNoticeAfterDays,
        finalNoticeAfterDays: data.finalNoticeAfterDays,
        cancellationWarningAfterDays: data.cancellationWarningAfterDays,
        minGapDays: data.minGapDays,
        preDueReminderDays: data.preDueReminderDays,
        isActive: data.isActive,
        notes: data.notes ?? null,
        createdBy: ctx.user.id,
      };

      if (data.id) {
        const rows = await tx
          .update(dunningPolicies)
          .set(values)
          .where(
            and(
              eq(dunningPolicies.tenantId, ctx.tenant.id),
              eq(dunningPolicies.id, data.id),
            ),
          )
          .returning();
        return rows[0] ?? null;
      }

      const rows = await tx.insert(dunningPolicies).values(values).returning();
      return rows[0] ?? null;
    });

    if (!saved) return receivablesFail("That ladder could not be saved.");

    await writeAudit(ctx, {
      action: data.id ? "update" : "create",
      resourceType: "dunning_policy",
      resourceId: saved.id,
    });

    revalidatePath("/settings/receivables");
    return { ok: true, data: { id: saved.id } };
  } catch (err) {
    return toReceivablesActionError(err, "saveDunningPolicy");
  }
}

export async function getReceivableSettings(): Promise<
  ActionResult<{
    policies: Array<{ id: string; name: string; interestRateBps: number; exceedsReference: boolean }>;
    ladders: Array<{ id: string; name: string; reminderAfterDays: number }>;
  }>
> {
  try {
    const ctx = await requirePermission("receivables:read");
    const [policies, ladders] = await Promise.all([
      listReceivablePolicies(ctx.tenant.id),
      listDunningPolicies(ctx.tenant.id),
    ]);

    return {
      ok: true,
      data: {
        policies: policies.map((p) => ({
          id: p.id,
          name: p.name,
          interestRateBps: p.interestRateBps,
          exceedsReference: p.interestRateBps > p.referenceRateBps,
        })),
        ladders: ladders.map((l) => ({
          id: l.id,
          name: l.name,
          reminderAfterDays: l.reminderAfterDays,
        })),
      },
    };
  } catch (err) {
    return toReceivablesActionError(err, "getReceivableSettings");
  }
}

/* ================================================================== */
/* DEMANDS                                                             */
/* ================================================================== */

export async function createDemand(
  input: unknown,
): Promise<ActionResult<{ id: string; noticeNumber: string; rateFlagged: boolean; rateMessage: string }>> {
  try {
    const data = raiseDemandSchema.parse(input);
    const ctx = await guardReceivablesWrite({
      operation: "receivables:raise_demand",
      feature: FEATURE,
      permission: "receivables:raise_demand",
      resource: { type: "booking", id: data.bookingId },
    });

    const outcome = await raiseDemand({
      tenantId: ctx.tenant.id,
      userId: ctx.user.id,
      input: data,
    });

    if (!outcome.ok) {
      return receivablesFail(
        outcome.remedy ? `${outcome.error} ${outcome.remedy}` : outcome.error,
      );
    }

    await writeAudit(ctx, {
      action: "create",
      resourceType: "demand_notice",
      resourceId: outcome.demand.id,
      severity: outcome.rateFlagged ? "warning" : "info",
      metadata: {
        noticeNumber: outcome.demand.noticeNumber,
        milestoneId: outcome.demand.milestoneId,
        trigger: outcome.demand.triggerLabel,
        totalMinor: serializeAmount(outcome.demand.totalMinor),
        rateExceedsReference: outcome.rateFlagged,
      },
    });

    revalidatePath("/receivables");
    return {
      ok: true,
      data: {
        id: outcome.demand.id,
        noticeNumber: outcome.demand.noticeNumber,
        rateFlagged: outcome.rateFlagged,
        rateMessage: outcome.rateMessage,
      },
    };
  } catch (err) {
    return toReceivablesActionError(err, "createDemand");
  }
}

/**
 * ⭐ SERVE IT. The act that creates a legal document under RERA and starts
 * the interest clock.
 */
export async function serveDemand(
  input: unknown,
): Promise<
  ActionResult<{
    id: string;
    documents: Array<{ language: string; subject: string; wordsFellBack: boolean }>;
  }>
> {
  try {
    const data = issueDemandSchema.parse(input);
    const ctx = await guardReceivablesWrite({
      operation: "receivables:issue_demand",
      feature: FEATURE,
      permission: "receivables:issue_demand",
      resource: { type: "demand_notice", id: data.demandId },
    });

    const head = await letterhead();
    const outcome = await issueDemand({
      tenantId: ctx.tenant.id,
      userId: ctx.user.id,
      demandId: data.demandId,
      languages: data.languages,
      developerName: head.developerName,
      contactLine: head.contactLine,
      asOf: today(),
    });

    if (!outcome.ok) return receivablesFail(outcome.error);

    await writeAudit(ctx, {
      action: "update",
      resourceType: "demand_notice",
      resourceId: outcome.demand.id,
      severity: "notice",
      metadata: {
        issued: true,
        noticeNumber: outcome.demand.noticeNumber,
        languages: outcome.documents.map((d) => d.language),
        // ⭐ Recorded because it is reportable: a notice whose
        // amount-in-words fell back to figures is a gap in a language
        // pack, and it should be visible without reading the document.
        wordsFellBack: outcome.documents.some((d) => d.wordsFellBack),
      },
    });

    revalidatePath("/receivables");
    return {
      ok: true,
      data: {
        id: outcome.demand.id,
        documents: outcome.documents.map((d) => ({
          language: d.language,
          subject: d.subject,
          wordsFellBack: d.wordsFellBack,
        })),
      },
    };
  } catch (err) {
    return toReceivablesActionError(err, "serveDemand");
  }
}

export async function withdrawDemand(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const data = cancelDemandSchema.parse(input);
    const ctx = await guardReceivablesWrite({
      operation: "receivables:issue_demand",
      feature: FEATURE,
      permission: "receivables:issue_demand",
      resource: { type: "demand_notice", id: data.demandId },
    });

    const outcome = await cancelDemand({
      tenantId: ctx.tenant.id,
      demandId: data.demandId,
      reason: data.reason,
    });
    if (!outcome.ok) return receivablesFail(outcome.error);

    await writeAudit(ctx, {
      action: "update",
      resourceType: "demand_notice",
      resourceId: data.demandId,
      severity: "notice",
      metadata: { cancelled: true, reason: data.reason },
    });

    revalidatePath("/receivables");
    return { ok: true, data: { id: outcome.demand.id } };
  } catch (err) {
    return toReceivablesActionError(err, "withdrawDemand");
  }
}

export async function replaceDemand(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const data = supersedeDemandSchema.parse(input);
    const ctx = await guardReceivablesWrite({
      operation: "receivables:issue_demand",
      feature: FEATURE,
      permission: "receivables:issue_demand",
      resource: { type: "demand_notice", id: data.demandId },
    });

    const outcome = await supersedeDemand({
      tenantId: ctx.tenant.id,
      demandId: data.demandId,
      replacementDemandId: data.replacementDemandId,
      reason: data.reason,
    });
    if (!outcome.ok) return receivablesFail(outcome.error);

    await writeAudit(ctx, {
      action: "update",
      resourceType: "demand_notice",
      resourceId: data.demandId,
      severity: "notice",
      metadata: { supersededBy: data.replacementDemandId, reason: data.reason },
    });

    revalidatePath("/receivables");
    return { ok: true, data: { id: outcome.demand.id } };
  } catch (err) {
    return toReceivablesActionError(err, "replaceDemand");
  }
}

/**
 * ⭐ PREVIEW A NOTICE IN ANY SUPPORTED LANGUAGE, WITHOUT SENDING IT.
 *
 * ⚠️ A PREVIEW IS NOT STORED. `demand_notice_documents` records what was
 * SERVED; a preview that wrote a row would leave a document on file that
 * nobody received.
 */
export async function previewDemandNotice(
  input: unknown,
): Promise<
  ActionResult<{ subject: string; body: string; wordsFellBack: boolean; wordsLanguage: string }>
> {
  try {
    const data = renderDemandNoticeSchema.parse(input);
    const ctx = await requirePermission("receivables:read");

    const demand = await findDemand(ctx.tenant.id, data.demandId);
    if (!demand) return receivablesFail("That demand does not exist.");

    const booking = await findBookingContext(ctx.tenant.id, demand.bookingId);
    if (!booking) return receivablesFail("That booking no longer exists.");

    const head = await letterhead();
    const facts = noticeFactsFor({
      demand,
      booking,
      developerName: head.developerName,
      contactLine: head.contactLine,
      asOf: data.asOf ?? today(),
    });

    const rendered = renderDemandNotice({ ...facts, language: data.language });

    return {
      ok: true,
      data: {
        subject: rendered.subject,
        body: rendered.body,
        wordsFellBack: rendered.wordsFellBack,
        wordsLanguage: rendered.wordsLanguage,
      },
    };
  } catch (err) {
    return toReceivablesActionError(err, "previewDemandNotice");
  }
}

export async function getBookingReceivables(input: unknown): Promise<
  ActionResult<{
    buyerLanguage: string;
    demands: Array<{
      id: string;
      noticeNumber: string;
      status: string;
      dueDate: string;
      totalMinor: string;
      allocatedMinor: string;
      rateExceedsReference: boolean;
      triggerLabel: string;
    }>;
    receipts: Array<{
      id: string;
      receiptNumber: string;
      receivedOn: string;
      amountMinor: string;
      allocatedMinor: string;
      status: string;
      allocations: Array<{ noticeNumber: string; amountMinor: string; explanation: string }>;
    }>;
    ladder: Array<{ stage: string; dueOn: string; automatic: boolean }>;
  }>
> {
  try {
    const data = statementQuerySchema.parse(input);
    const ctx = await requirePermission("receivables:read");

    const booking = await findBookingContext(ctx.tenant.id, data.bookingId);
    if (!booking) return receivablesFail("That booking does not exist.");

    const [demands, receiptRows, policies] = await Promise.all([
      listDemandsForBooking(ctx.tenant.id, data.bookingId),
      listReceiptsForBooking(ctx.tenant.id, data.bookingId),
      resolvePolicies(ctx.tenant.id, booking.projectId),
    ]);

    const numberById = new Map(demands.map((d) => [d.id, d.noticeNumber]));
    const earliestDue = demands.find((d) => d.status === "issued" || d.status === "part_paid");

    return {
      ok: true,
      data: {
        buyerLanguage: normaliseLanguage(booking.preferredLang),
        demands: demands.map((d) => ({
          id: d.id,
          noticeNumber: d.noticeNumber,
          status: d.status,
          dueDate: d.dueDate,
          totalMinor: serializeAmount(d.totalMinor),
          allocatedMinor: serializeAmount(d.allocatedMinor),
          rateExceedsReference: d.rateExceedsReference,
          triggerLabel: d.triggerLabel,
        })),
        receipts: receiptRows.map((r) => ({
          id: r.id,
          receiptNumber: r.receiptNumber,
          receivedOn: r.receivedOn,
          amountMinor: serializeAmount(r.amountMinor),
          allocatedMinor: serializeAmount(r.allocatedMinor),
          status: r.status,
          allocations: r.allocations.map((a) => ({
            noticeNumber: numberById.get(a.demandId) ?? a.demandId,
            amountMinor: serializeAmount(a.amountMinor),
            explanation: a.explanation,
          })),
        })),
        ladder: earliestDue
          ? ladderSchedule(earliestDue.dueDate, policies.dunning).map((rung) => ({
              stage: rung.stage,
              dueOn: rung.dueOn,
              automatic: rung.automatic,
            }))
          : [],
      },
    };
  } catch (err) {
    return toReceivablesActionError(err, "getBookingReceivables");
  }
}

/* ================================================================== */
/* RECEIPTS                                                            */
/* ================================================================== */

/**
 * ⭐⭐ MONEY IN, AND THE SPLIT THAT HAS TO BE EXACT AND EXPLAINABLE.
 *
 * The narrative is returned so the person recording the receipt sees the
 * allocation immediately — including the reconciliation line — rather
 * than discovering it on a statement weeks later.
 */
export async function recordPayment(
  input: unknown,
): Promise<
  ActionResult<{
    id: string;
    receiptNumber: string;
    allocatedMinor: string;
    creditMinor: string;
    narrative: string[];
  }>
> {
  try {
    const data = recordReceiptSchema.parse(input);
    const ctx = await guardReceivablesWrite({
      operation: "receivables:record_receipt",
      feature: FEATURE,
      permission: "receivables:record_receipt",
      resource: { type: "booking", id: data.bookingId },
    });

    const outcome = await recordReceipt({
      tenantId: ctx.tenant.id,
      userId: ctx.user.id,
      input: data,
    });
    if (!outcome.ok) return receivablesFail(outcome.error);

    await writeAudit(ctx, {
      action: "create",
      resourceType: "receipt",
      resourceId: outcome.receipt.id,
      metadata: {
        receiptNumber: outcome.receipt.receiptNumber,
        amountMinor: serializeAmount(outcome.receipt.amountMinor),
        allocatedMinor: serializeAmount(outcome.allocation.totalAllocatedMinor),
        creditMinor: serializeAmount(outcome.allocation.creditMinor),
        demands: outcome.allocation.lines.map((l) => l.noticeNumber),
      },
    });

    revalidatePath("/receivables");
    return {
      ok: true,
      data: {
        id: outcome.receipt.id,
        receiptNumber: outcome.receipt.receiptNumber,
        allocatedMinor: serializeAmount(outcome.allocation.totalAllocatedMinor),
        creditMinor: serializeAmount(outcome.allocation.creditMinor),
        narrative: outcome.allocation.narrative,
      },
    };
  } catch (err) {
    return toReceivablesActionError(err, "recordPayment");
  }
}

export async function markReceiptBounced(
  input: unknown,
): Promise<ActionResult<{ id: string; releasedMinor: string }>> {
  try {
    const data = bounceReceiptSchema.parse(input);
    const ctx = await guardReceivablesWrite({
      operation: "receivables:allocate",
      feature: FEATURE,
      permission: "receivables:allocate",
      resource: { type: "receipt", id: data.receiptId },
    });

    const outcome = await bounceReceipt({
      tenantId: ctx.tenant.id,
      receiptId: data.receiptId,
      bouncedOn: data.bouncedOn,
      reason: data.reason,
    });
    if (!outcome.ok) return receivablesFail(outcome.error);

    await writeAudit(ctx, {
      action: "update",
      resourceType: "receipt",
      resourceId: data.receiptId,
      severity: "warning",
      metadata: {
        bounced: true,
        reason: data.reason,
        releasedMinor: serializeAmount(outcome.releasedMinor),
      },
    });

    revalidatePath("/receivables");
    return {
      ok: true,
      data: {
        id: outcome.receipt.id,
        releasedMinor: serializeAmount(outcome.releasedMinor),
      },
    };
  } catch (err) {
    return toReceivablesActionError(err, "markReceiptBounced");
  }
}

export async function reapplyReceipt(
  input: unknown,
): Promise<ActionResult<{ id: string; narrative: string[] }>> {
  try {
    const data = reallocateReceiptSchema.parse(input);
    const ctx = await guardReceivablesWrite({
      operation: "receivables:allocate",
      feature: FEATURE,
      permission: "receivables:allocate",
      resource: { type: "receipt", id: data.receiptId },
    });

    const outcome = await reallocateReceipt({
      tenantId: ctx.tenant.id,
      userId: ctx.user.id,
      receiptId: data.receiptId,
      strategy: data.strategy,
      appropriationOrder: data.appropriationOrder,
      instructions: data.instructions,
    });
    if (!outcome.ok) return receivablesFail(outcome.error);

    await writeAudit(ctx, {
      action: "update",
      resourceType: "receipt",
      resourceId: data.receiptId,
      severity: "notice",
      metadata: {
        reallocated: true,
        reason: data.reason,
        demands: outcome.allocation.lines.map((l) => l.noticeNumber),
      },
    });

    revalidatePath("/receivables");
    return {
      ok: true,
      data: { id: outcome.receipt.id, narrative: outcome.allocation.narrative },
    };
  } catch (err) {
    return toReceivablesActionError(err, "reapplyReceipt");
  }
}

/* ================================================================== */
/* DUNNING                                                             */
/* ================================================================== */

/**
 * ⭐⭐ SEND ONE RUNG.
 *
 * ⚠️ THE PERMISSION DEPENDS ON THE RUNG, and that is the only place in
 * this file where it does. A cancellation warning needs
 * `receivables:warn_cancellation` — a key the accountant who does every
 * other collections task deliberately does not hold, because the letter
 * precedes terminating an allotment and forfeiting what a family has paid
 * towards a home.
 */
export async function sendDunningNotice(
  input: unknown,
): Promise<
  ActionResult<{ id: string; stage: string; subject: string; body: string }>
> {
  try {
    const data = sendDunningSchema.parse(input);

    const permission =
      data.stage === "cancellation_warning"
        ? "receivables:warn_cancellation"
        : "receivables:dun";

    const ctx = await guardReceivablesWrite({
      operation: permission,
      feature: FEATURE,
      permission,
      resource: { type: "demand_notice", id: data.demandId },
    });

    const head = await letterhead();
    const outcome = await sendDunningLetter({
      tenantId: ctx.tenant.id,
      userId: ctx.user.id,
      demandId: data.demandId,
      stage: data.stage,
      channel: data.channel,
      language: data.language,
      recipient: data.recipient,
      sentOn: data.sentOn,
      authorisedReason: data.authorisedReason,
      notes: data.notes,
      developerName: head.developerName,
      contactLine: head.contactLine,
      asOf: today(),
    });

    if (!outcome.ok) {
      return receivablesFail(
        outcome.remedy ? `${outcome.error} ${outcome.remedy}` : outcome.error,
      );
    }

    await writeAudit(ctx, {
      action: "create",
      resourceType: "dunning_event",
      resourceId: outcome.event.id,
      // ⭐ A cancellation warning is `critical` in the audit log. It is the
      // most consequential thing this product does to a person.
      severity: data.stage === "cancellation_warning" ? "critical" : "notice",
      metadata: {
        demandId: data.demandId,
        stage: data.stage,
        channel: data.channel,
        language: outcome.language,
        authorisedReason: data.authorisedReason ?? null,
      },
    });

    revalidatePath("/receivables");
    return {
      ok: true,
      data: {
        id: outcome.event.id,
        stage: outcome.event.stage,
        subject: outcome.subject,
        body: outcome.body,
      },
    };
  } catch (err) {
    return toReceivablesActionError(err, "sendDunningNotice");
  }
}

/**
 * What the chase would do tonight.
 *
 * ⚠️ `dryRun` DEFAULTS TO TRUE AND THIS ACTION NEVER SENDS. It returns a
 * plan. Sending is `sendDunningNotice`, one rung at a time, through the
 * same gate — because a single call that sent a hundred letters would be
 * a single call that sent a hundred wrong letters.
 */
export async function planDunning(
  input: unknown,
): Promise<
  ActionResult<{
    asOf: string;
    toSend: Array<{ demandId: string; noticeNumber: string; stage: string; daysOverdue: number }>;
    needsDecision: Array<{ demandId: string; noticeNumber: string; reason: string }>;
  }>
> {
  try {
    const data = dunningSweepSchema.parse(input);
    const ctx = await requirePermission("receivables:read");
    const asOf = data.asOf ?? today();

    const items = await planDunningSweep({
      tenantId: ctx.tenant.id,
      projectId: data.projectId,
      asOf,
      limit: data.limit,
    });

    return {
      ok: true,
      data: {
        asOf,
        toSend: items
          .filter((i) => i.action === "send" && i.stage)
          .map((i) => ({
            demandId: i.demandId,
            noticeNumber: i.noticeNumber,
            stage: i.stage ?? "",
            daysOverdue: i.daysOverdue,
          })),
        needsDecision: items
          .filter((i) => i.action === "needs_decision")
          .map((i) => ({
            demandId: i.demandId,
            noticeNumber: i.noticeNumber,
            reason: i.reason,
          })),
      },
    };
  } catch (err) {
    return toReceivablesActionError(err, "planDunning");
  }
}

export async function getDunningHistory(
  demandId: string,
): Promise<
  ActionResult<Array<{ stage: string; rung: number; sentAt: string; channel: string; authorised: boolean }>>
> {
  try {
    const ctx = await requirePermission("receivables:read");
    const events = await listDunningEvents(ctx.tenant.id, demandId);
    return {
      ok: true,
      data: events.map((e) => ({
        stage: e.stage,
        rung: e.rung,
        sentAt: e.sentAt.toISOString(),
        channel: e.channel,
        authorised: e.authorisedBy !== null,
      })),
    };
  } catch (err) {
    return toReceivablesActionError(err, "getDunningHistory");
  }
}

/* ================================================================== */
/* REPORTS                                                             */
/* ================================================================== */

export async function getAgeingReport(input: unknown): Promise<
  ActionResult<{
    asOf: string;
    totals: Record<string, string>;
    totalMinor: string;
    overdueMinor: string;
    interestMinor: string;
    byProject: Array<{ key: string; label: string; overdueMinor: string; demandCount: number }>;
    byBuyer: Array<{ key: string; label: string; overdueMinor: string; oldestDaysOverdue: number }>;
  }>
> {
  try {
    const data = ageingQuerySchema.parse(input);
    const ctx = await requirePermission("receivables:read");
    const asOf = data.asOf ?? today();

    const rows = await ageingRows(ctx.tenant.id, {
      projectId: data.projectId,
      bookingId: data.bookingId,
      asOf,
    });
    const report = ageReceivables(rows, asOf);

    return {
      ok: true,
      data: {
        asOf: report.asOf,
        totals: Object.fromEntries(
          Object.entries(report.totals).map(([k, v]) => [k, serializeAmount(v)]),
        ),
        totalMinor: serializeAmount(report.totalMinor),
        overdueMinor: serializeAmount(report.overdueMinor),
        interestMinor: serializeAmount(report.interestMinor),
        byProject: report.byProject.map((g) => ({
          key: g.key,
          label: g.label,
          overdueMinor: serializeAmount(g.overdueMinor),
          demandCount: g.demandCount,
        })),
        byBuyer: report.byBuyer.map((g) => ({
          key: g.key,
          label: g.label,
          overdueMinor: serializeAmount(g.overdueMinor),
          oldestDaysOverdue: g.oldestDaysOverdue,
        })),
      },
    };
  } catch (err) {
    return toReceivablesActionError(err, "getAgeingReport");
  }
}

/**
 * ⭐ THE DOCUMENT A BUYER IS HANDED.
 *
 * Returns the narrative as well as the figures: the whole requirement is
 * that a split can be EXPLAINED, and the narrative carries the sentence
 * recorded when each payment was applied.
 */
export async function getStatementOfAccount(input: unknown): Promise<
  ActionResult<{
    asOf: string;
    demandedMinor: string;
    receivedMinor: string;
    outstandingMinor: string;
    interestOutstandingMinor: string;
    creditMinor: string;
    payableTodayMinor: string;
    narrative: string[];
  }>
> {
  try {
    const data = statementQuerySchema.parse(input);
    const ctx = await requirePermission("receivables:read");
    const asOf = data.asOf ?? today();

    const statement = await assembleStatement({
      tenantId: ctx.tenant.id,
      bookingId: data.bookingId,
      asOf,
    });
    if (!statement) return receivablesFail("That booking does not exist.");

    return {
      ok: true,
      data: {
        asOf: statement.asOf,
        demandedMinor: serializeAmount(statement.totals.demandedMinor),
        receivedMinor: serializeAmount(statement.totals.receivedMinor),
        outstandingMinor: serializeAmount(statement.totals.outstandingMinor),
        interestOutstandingMinor: serializeAmount(
          statement.totals.interestOutstandingMinor,
        ),
        creditMinor: serializeAmount(statement.totals.creditMinor),
        payableTodayMinor: serializeAmount(statement.totals.payableTodayMinor),
        narrative: statement.narrative,
      },
    };
  } catch (err) {
    return toReceivablesActionError(err, "getStatementOfAccount");
  }
}
