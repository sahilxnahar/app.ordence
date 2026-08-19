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
  dunningBoardSchema,
  dunningSweepSchema,
  issueDemandSchema,
  previewDunningSchema,
  raiseDemandSchema,
  reallocateReceiptSchema,
  recordReceiptSchema,
  renderDemandNoticeSchema,
  recordDeemedServiceSchema,
  recordPostalServiceSchema,
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
import {
  describeNoticeService,
  dunningBoard,
  planDunningSweep,
  previewDunningLetter,
  recordDeemedService,
  recordPostalService,
  sendDunningLetter,
  type DunningPreview,
  type LadderBoard,
  type NoticeServiceView,
} from "@/server/receivables/dunning";
import {
  ladderAuthorityProblem,
  permissionForStage,
} from "@/lib/receivables/notice-authority";
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
import { postDemandNotice, postBookingReceipt } from "@/server/accounting/post-sales";
import { demandNotices, receipts } from "@/db/schema/receivables";
import { bookings } from "@/db/schema/sales";
import { and, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import {
  dunningPolicies,
  receivablePolicies,
} from "@/db/schema/receivables";
import {
  journalEntries,
  ledgers,
  salesPostingAccounts,
  transactions,
} from "@/db/schema/accounting";
import { ageReceivables } from "@/lib/receivables/ageing";
import { assessInterestRate } from "@/lib/receivables/interest";
import { ladderSchedule } from "@/lib/receivables/dunning";
import { renderDemandNotice, normaliseLanguage } from "@/lib/receivables/templates";
import { toCivilDay } from "@/lib/gst/constants";
import { serializeAmount } from "@/lib/billing/money";
import { toMinorUnits } from "@/lib/validators/accounting";
import {
  serializeReconciliation,
  type SerializedReconciliation,
} from "@/lib/reconciliation/gate";
import {
  AGEING_BREACH_CAUSES,
  COLLECTION_ROLES,
  LEDGER_TRANSACTION_STATUSES,
  RECEIVABLE_CONTROL_ROLE,
  STATEMENT_BREACH_CAUSES,
  reconcileAgeingReport,
  reconcileStatement,
  type ControlAccountFacts,
} from "@/lib/reconciliation/receivables";
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
/* ⭐⭐⭐ THE LEDGER SIDE OF THE RECONCILIATION GATE                    */
/* ================================================================== */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴🔴 WHY THIS QUERY EXISTS INSTEAD OF REUSING THE TRIAL BALANCE
 * ══════════════════════════════════════════════════════════════════════
 * `lib/reconciliation/gate.ts` states the rule this whole batch is
 * built on: the gate compares two INDEPENDENT computations. A check that
 * reads the same query twice proves only that the query is deterministic.
 *
 * The report side of every check below is built from `demand_notices`
 * and `receipts` by `lib/receivables/*`. This function is the OTHER
 * side, and it touches none of those tables — it starts from the
 * tenant's own posting-role map, walks to the ledger, and sums
 * `journal_entries`. The two paths share no row, no table and no
 * function. That is what makes agreement between them evidence rather
 * than tautology.
 *
 * ⚠️ AND IT IS DELIBERATELY NOT A CALL INTO `server/actions/
 * accounting.ts`. `ledgerBalances` there is private to a `"use server"`
 * module; reaching for it would mean exporting it, which would publish
 * a new RPC endpoint, and one action file calling another's exports
 * couples two public surfaces so that a permission change on one
 * silently re-guards the other.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE JOIN SHAPE IS COPIED FROM `ledgerBalances` ON PURPOSE
 * ══════════════════════════════════════════════════════════════════════
 * The date and status predicates sit in the JOIN's `ON` clause AND the
 * `transactions.id IS NOT NULL` guard sits inside the `CASE`. Both
 * halves are load-bearing and each one alone is a different bug:
 *
 *   • move the predicates to `WHERE` and the LEFT JOIN collapses to an
 *     inner join — a control account with no activity in range vanishes
 *     entirely, `configured` still reads true, and the gate reconciles
 *     the ageing total against a row that was silently dropped;
 *   • leave them only in `ON` and they filter NOTHING, because
 *     `journal_entries.amount` is still populated for an out-of-range
 *     entry whose transaction join did not match. Out-of-period money is
 *     counted anyway, silently, and the gate then fires on healthy data.
 *
 * ⚠️ THE DATE IS `transaction_date`, NOT `created_at`. A back-dated
 * journal posted in June for a March demand belongs in March. Filtering
 * on the insert timestamp would put the ledger side on a different
 * calendar from the document side and produce a phantom breach every
 * time somebody posted a backlog.
 */
type RoleLedgerTotals = {
  /**
   * 🔴 STRUCTURAL. True when at least one of the requested roles is
   * mapped to a live ledger — NEVER inferred from an amount. See design
   * point ④ in `lib/reconciliation/gate.ts`: `0n === 0n` on an unmapped
   * role is an unconfigured workspace, not a passing check.
   */
  configured: boolean;
  /** "Sundry debtors (1210)", for the breach sentence. */
  label: string;
  /** Debit-positive: `debits − credits`. The ledger convention. */
  balanceMinor: bigint;
  /** Debits alone. Used for "money that arrived" — see the statement. */
  debitMinor: bigint;
};

async function roleLedgerTotals(
  tenantId: string,
  roles: readonly string[],
  window: {
    /** Inclusive. Cumulative from inception to this civil day. */
    to: string;
    /**
     * When set, only entries carrying this booking as their counterparty.
     * `writePropertyPosting` stamps every property leg with
     * `counterparty_type = 'booking'` and the booking id, which is the
     * only per-buyer slice of the ledger that exists — there is no
     * project column on a journal entry.
     */
    bookingId?: string;
  },
): Promise<RoleLedgerTotals> {
  const entryFilters = [
    eq(journalEntries.ledgerId, ledgers.id),
    eq(journalEntries.tenantId, tenantId),
    ...(window.bookingId
      ? [
          eq(journalEntries.counterpartyType, "booking"),
          eq(journalEntries.counterpartyId, window.bookingId),
        ]
      : []),
  ];

  const inPeriod = and(
    eq(transactions.id, journalEntries.transactionId),
    // Tenant-scoped on every join. A missing predicate here is the exact
    // bug that reconciles one workspace's report against another's books.
    eq(transactions.tenantId, tenantId),
    inArray(transactions.status, [...LEDGER_TRANSACTION_STATUSES]),
    lte(transactions.transactionDate, window.to),
  );

  const rows = await withTenant(tenantId, (tx) =>
    tx
      .select({
        code: ledgers.code,
        name: ledgers.name,
        totalDebit: sql<string>`COALESCE(SUM(CASE WHEN ${transactions.id} IS NOT NULL AND ${journalEntries.entryType} = 'debit'  THEN ${journalEntries.amount} ELSE 0 END), 0)::text`,
        totalCredit: sql<string>`COALESCE(SUM(CASE WHEN ${transactions.id} IS NOT NULL AND ${journalEntries.entryType} = 'credit' THEN ${journalEntries.amount} ELSE 0 END), 0)::text`,
      })
      .from(salesPostingAccounts)
      /**
       * ⚠️ AN INNER JOIN TO `ledgers`, AND THE `deleted_at` FILTER IS THE
       * REASON. A ledger soft-deleted while a posting role still points
       * at it is a real state — the FK is `ON DELETE RESTRICT`, which
       * stops a hard delete and says nothing about a soft one. Treating
       * that role as UNMAPPED is the safe reading: the workspace is then
       * "unconfigured", the figures show with an explicit note that
       * nothing checked them, and nobody is handed a green tick earned
       * by summing a deleted account's entries.
       */
      .innerJoin(
        ledgers,
        and(
          eq(ledgers.id, salesPostingAccounts.ledgerId),
          eq(ledgers.tenantId, tenantId),
          isNull(ledgers.deletedAt),
        ),
      )
      .leftJoin(journalEntries, and(...entryFilters))
      .leftJoin(transactions, inPeriod)
      .where(
        and(
          eq(salesPostingAccounts.tenantId, tenantId),
          inArray(salesPostingAccounts.role, [...roles]),
        ),
      )
      .groupBy(ledgers.id, ledgers.code, ledgers.name),
  );

  let debitMinor = 0n;
  let creditMinor = 0n;
  for (const r of rows) {
    /**
     * ⚠️ THE DECIMAL STRING GOES STRAIGHT TO BIGINT PAISE, with no
     * `Number` in the middle. Postgres already returns an exact
     * 2-decimal string; a float round trip can only lose information,
     * and a gate whose own arithmetic drifts would report breaches it
     * created itself. Money is never a float here.
     */
    debitMinor += toMinorUnits(r.totalDebit);
    creditMinor += toMinorUnits(r.totalCredit);
  }

  return {
    configured: rows.length > 0,
    label:
      rows.length === 0
        ? "not mapped"
        : rows.map((r) => `${r.name} (${r.code})`).join(", "),
    balanceMinor: debitMinor - creditMinor,
    debitMinor,
  };
}

/** The receivables control account, as the gate needs it. */
async function receivableControl(
  tenantId: string,
  window: { to: string; bookingId?: string },
): Promise<ControlAccountFacts> {
  const totals = await roleLedgerTotals(tenantId, [RECEIVABLE_CONTROL_ROLE], window);
  return {
    configured: totals.configured,
    label: totals.label,
    balanceMinor: totals.balanceMinor,
  };
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

    /**
     * ⭐ THE BOOKS ARE TOLD — v1.0.0-rc.3.
     *
     * 🔴 Dr Booking receivable / Cr **Advance from customers** / Cr Output
     *    GST. NOT revenue — under Ind AS 115 a residential developer
     *    recognises revenue at POSSESSION, and money taken before then is
     *    the buyer's. The GST, however, IS payable now: time of supply
     *    for construction services is the earlier of invoice or payment.
     *
     * ⚠️ ITS OWN TRANSACTION, NOT THE ENGINE'S. `issueDemand()` owns its
     * scope and this runs after it commits — so a posting failure cannot
     * un-serve a demand the buyer has already received. The backlog at
     * `/accounting/posting` catches anything that did not land, and
     * idempotency makes the retry safe.
     */
    await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [d] = await tx
          .select({
            id: demandNotices.id,
            noticeNumber: demandNotices.noticeNumber,
            bookingId: demandNotices.bookingId,
            noticeDate: demandNotices.noticeDate,
            dueDate: demandNotices.dueDate,
            principalMinor: demandNotices.principalMinor,
            cgstMinor: demandNotices.cgstMinor,
            sgstMinor: demandNotices.sgstMinor,
            igstMinor: demandNotices.igstMinor,
            cessMinor: demandNotices.cessMinor,
            totalMinor: demandNotices.totalMinor,
            bookingReference: bookings.reference,
          })
          .from(demandNotices)
          .leftJoin(
            bookings,
            and(
              eq(bookings.id, demandNotices.bookingId),
              eq(bookings.tenantId, ctx.tenant.id),
            ),
          )
          .where(
            and(
              eq(demandNotices.tenantId, ctx.tenant.id),
              eq(demandNotices.id, outcome.demand.id),
            ),
          )
          .limit(1);

        if (!d) return;

        await postDemandNotice(tx, {
          tenantId: ctx.tenant.id,
          userId: ctx.user.id,
          demandId: d.id,
          demandNumber: d.noticeNumber,
          /**
           * ⚠️ THE NOTICE DATE, NOT THE DUE DATE. The liability arises
           * when the demand is issued; the due date is when the buyer is
           * late. Posting on the due date would move a project's GST
           * liability into the following month, every time.
           */
          servedOn: String(d.noticeDate),
          bookingId: d.bookingId,
          bookingReference: d.bookingReference ?? "—",
          buyerName: null,
          principalMinor: d.principalMinor,
          cgstMinor: d.cgstMinor,
          sgstMinor: d.sgstMinor,
          igstMinor: d.igstMinor,
          cessMinor: d.cessMinor,
          totalMinor: d.totalMinor,
        });
      },
      { impersonationId: ctx.impersonationId },
    );

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

    /**
     * ⭐ Dr Bank + Dr TDS receivable / Cr Booking receivable.
     *
     * ⚠️ IT TOUCHES NEITHER REVENUE NOR THE ADVANCE — both were recorded
     * when the demand was served. A receipt only turns a receivable into
     * cash, and posting it to revenue as well is the double-count that
     * makes a developer's turnover exactly twice its collections.
     */
    await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [r] = await tx
          .select({
            id: receipts.id,
            receiptNumber: receipts.receiptNumber,
            receivedOn: receipts.receivedOn,
            bookingId: receipts.bookingId,
            amountMinor: receipts.amountMinor,
            tdsCreditMinor: receipts.tdsCreditMinor,
            bookingReference: bookings.reference,
          })
          .from(receipts)
          .leftJoin(
            bookings,
            and(eq(bookings.id, receipts.bookingId), eq(bookings.tenantId, ctx.tenant.id)),
          )
          .where(
            and(eq(receipts.tenantId, ctx.tenant.id), eq(receipts.id, outcome.receipt.id)),
          )
          .limit(1);

        if (!r) return;

        await postBookingReceipt(tx, {
          tenantId: ctx.tenant.id,
          userId: ctx.user.id,
          receiptId: r.id,
          receiptNumber: r.receiptNumber,
          receivedOn: String(r.receivedOn),
          bookingId: r.bookingId,
          bookingReference: r.bookingReference ?? "—",
          buyerName: null,
          cashMinor: r.amountMinor,
          tdsMinor: r.tdsCreditMinor,
        });
      },
      { impersonationId: ctx.impersonationId },
    );

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

    /*
     * ⭐⭐ ONE SOURCE FOR THE PER-RUNG RIGHT.
     *
     * 🔴 THIS WAS A TERNARY HERE UNTIL v1.67.0, AND A TERNARY IS ENOUGH
     * TO REFUSE AND NOT ENOUGH TO OFFER. No screen could read it, so the
     * board that shows an accountant which rungs they may send would have
     * had to write the mapping out a second time — and the second copy is
     * always the permissive one. `permissionForStage` is now read by this
     * guard, by the row that gets written
     * (`dunning_events.authorised_permission`), by the preview and by the
     * board. SQL 0111 restates it as a CHECK, so an import that never
     * comes through here is refused too.
     */
    const permission = permissionForStage(data.stage);

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
      /*
       * ⭐⭐⭐ WHO AUTHORISED IT, UNDER WHICH RIGHT, AT WHAT TIME, AGAINST
       * WHICH RUNG — ALL FOUR, ON ONE ROW.
       *
       * ⚠️ THE ACTOR AND THE TIME WERE ALREADY THERE. `writeAudit` fills
       * the actor columns from `ctx` and `created_at` from the insert, so
       * "who" and "when" have never been the gap. THE RIGHT AND THE RUNG
       * WERE. An audit row saying "created a dunning_event" answers a
       * question nobody asks; the question asked at a hearing is which
       * rung of the statutory ladder this was and under whose authority
       * it was climbed, and neither was recorded until now.
       *
       * 🔴 `permission` IS THE KEY THAT WAS ACTUALLY CHECKED, not a
       * re-derivation. It is the same `const` the guard above was given,
       * so the log cannot claim a right that was not the one enforced —
       * which is the failure mode of writing `"receivables:dun"` in here
       * as a literal.
       *
       * ⚠️ `rung` IS THE INTEGER, beside the stage name. The names are an
       * enum whose order a tidy-up could change; the integer is what SQL
       * 0027 §6 compares and what a reader counts.
       */
      metadata: {
        demandId: data.demandId,
        stage: data.stage,
        rung: outcome.event.rung,
        permission,
        authorisedAt: new Date().toISOString(),
        channel: data.channel,
        language: outcome.language,
        authorisedReason: data.authorisedReason ?? null,
        // ⭐ Whether anything actually left the building, or whether the
        // row is raised and waiting for somebody to record a delivery.
        queuedForDispatch: outcome.queuedForDispatch,
      },
    });

    revalidatePath("/receivables");
    revalidatePath("/receivables/ladder");
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

/**
 * ⭐⭐ THE LADDER, WITH WHAT IS ACTUALLY BEHIND EACH RUNG.
 *
 * 🔴 `sentAt` USED TO BE THE ONLY FIELD HERE AND IT WAS ALWAYS PRESENT,
 * because the old schema wrote it when the row was created. Every screen
 * consuming this action rendered "sent on 12 March" for letters nothing
 * had ever sent. It is gone from the payload — not renamed, GONE — so a
 * page that has not been updated fails to compile rather than continuing
 * to display a date it should never have had.
 *
 * ⚠️ WHAT REPLACES IT CARRIES THE GRADE ON EVERY ROW. `evidenceLabel`
 * says "Dispatched by the system" or "Recorded by a person" or "Raised —
 * not dispatched", and `machineVerified` is the boolean a badge colours
 * itself from. A person's tick and a verified send can no longer render
 * identically, because they no longer arrive identically.
 */
export async function getDunningHistory(
  demandId: string,
): Promise<ActionResult<NoticeServiceView[]>> {
  try {
    const ctx = await requirePermission("receivables:read");
    const events = await listDunningEvents(ctx.tenant.id, demandId);
    return { ok: true, data: events.map(describeNoticeService) };
  } catch (err) {
    return toReceivablesActionError(err, "getDunningHistory");
  }
}

/**
 * ⭐⭐ RECORD THAT A POSTED OR HAND-DELIVERED NOTICE WAS SERVED.
 *
 * ⚠️ THE PERMISSION IS `receivables:dun`, NOT A READ KEY. Recording
 * service changes what the cancellation screen is willing to say about
 * this booking, so it is a write in the sense that matters.
 *
 * 🔴 AND IT CANNOT PRODUCE A DISPATCH RECORD, WHATEVER IT IS SENT. The
 * grade it writes is `human_recorded`; `dunning_events_human_record_is_
 * not_a_dispatch` in 0098 refuses the row a `dispatched_at` at all. This
 * action is structurally incapable of manufacturing the evidence the old
 * `sent_at` manufactured by accident.
 */
export async function recordNoticePostalService(
  input: unknown,
): Promise<ActionResult<{ id: string; evidenceWord: string }>> {
  try {
    const data = recordPostalServiceSchema.parse(input);

    const ctx = await guardReceivablesWrite({
      operation: "receivables:dun",
      feature: FEATURE,
      permission: "receivables:dun",
      resource: { type: "dunning_event", id: data.eventId },
    });

    const outcome = await recordPostalService({
      tenantId: ctx.tenant.id,
      userId: ctx.user.id,
      eventId: data.eventId,
      reference: data.reference,
      servedOn: data.servedOn ?? null,
      notes: data.notes ?? null,
    });

    if (!outcome.ok) return receivablesFail(outcome.error);

    await writeAudit(ctx, {
      action: "update",
      resourceType: "dunning_event",
      resourceId: outcome.event.id,
      // ⚠️ NOTICE, NOT INFO. This is a human asserting service that no
      // machine can check, on the file that decides a forfeiture.
      severity: "notice",
      metadata: {
        evidence: "human_recorded",
        stage: outcome.event.stage,
        rung: outcome.event.rung,
        permission: "receivables:dun",
        channel: outcome.event.channel,
        reference: data.reference,
      },
    });

    revalidatePath("/receivables");
    revalidatePath("/receivables/ladder");
    return {
      ok: true,
      data: { id: outcome.event.id, evidenceWord: outcome.event.serviceEvidence },
    };
  } catch (err) {
    return toReceivablesActionError(err, "recordNoticePostalService");
  }
}

/**
 * ⭐⭐⭐ RECORD THAT A NOTICE IS SERVED IN LAW WITHOUT PROOF OF RECEIPT.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE PERMISSION IS `receivables:warn_cancellation`, NOT
 *    `receivables:dun`, AND THAT IS THE ESCALATING RIGHT IN ACTION
 * ══════════════════════════════════════════════════════════════════════
 * Deeming service is not a stronger version of recording the post. It is
 * a CONCLUSION IN LAW drawn about a letter nobody watched arrive, and it
 * is the conclusion that turns an unproven rung into one the cancellation
 * gate will clear. `human_recorded` says "I posted it and here is the
 * consignment number" — a fact the person witnessed. `deemed` says "the
 * allottee is fixed with notice whether or not they read it", which is
 * an argument, and the person who has been chasing the money all quarter
 * is not the person who should be making it unreviewed.
 *
 * ⚠️ SO IT SITS WITH THE SAME KEY AS THE CANCELLATION WARNING — counsel
 * and the owner — because it is a step on the same road and because the
 * two are almost always decided in the same conversation.
 *
 * 🔴 AND IT CANNOT PRODUCE A DISPATCH RECORD, WHATEVER IT IS SENT.
 * `dunning_events_human_record_is_not_a_dispatch` (0098) refuses a
 * `deemed` row a `dispatched_at` at all, and
 * `dunning_events_deemed_states_its_basis` (0111) refuses one that does
 * not name a person, a date, a reference and the clause relied on.
 */
export async function recordNoticeDeemedService(
  input: unknown,
): Promise<ActionResult<{ id: string; evidenceWord: string }>> {
  try {
    const data = recordDeemedServiceSchema.parse(input);

    /*
     * ⭐ DERIVED FROM THE TOP RUNG, NOT SPELT OUT AGAIN.
     *
     * 🔴 A LITERAL HERE WOULD BE A SECOND COPY OF THE MAPPING, which is
     * the thing this batch removed from `sendDunningNotice`. If the key
     * that guards a forfeiture warning is ever changed, the right to
     * conclude that service happened must move with it — those two are
     * decided in the same conversation by the same person, and a rename
     * that split them would leave the weaker key guarding the step that
     * makes the stronger one possible.
     */
    const permission = permissionForStage("cancellation_warning");

    const ctx = await guardReceivablesWrite({
      operation: permission,
      feature: FEATURE,
      permission,
      resource: { type: "dunning_event", id: data.eventId },
    });

    const outcome = await recordDeemedService({
      tenantId: ctx.tenant.id,
      userId: ctx.user.id,
      eventId: data.eventId,
      reference: data.reference,
      basis: data.basis,
      servedOn: data.servedOn ?? null,
      notes: data.notes ?? null,
    });

    if (!outcome.ok) return receivablesFail(outcome.error);

    await writeAudit(ctx, {
      action: "update",
      resourceType: "dunning_event",
      resourceId: outcome.event.id,
      /*
       * ⚠️ CRITICAL, LIKE THE CANCELLATION WARNING ITSELF, AND NOT
       * `notice` LIKE RECORDING THE POST. This is the entry that will be
       * read back when somebody asks why the gate said the ladder was
       * served, and the answer is "a named person concluded it was".
       */
      severity: "critical",
      metadata: {
        evidence: "deemed",
        stage: outcome.event.stage,
        rung: outcome.event.rung,
        permission,
        authorisedAt: new Date().toISOString(),
        channel: outcome.event.channel,
        reference: data.reference,
        // ⭐ The basis travels into the log verbatim. A conclusion whose
        // stated reason lives only on the row it justifies is a
        // conclusion that can be edited into a different one.
        basis: data.basis,
      },
    });

    revalidatePath("/receivables");
    revalidatePath("/receivables/ladder");
    return {
      ok: true,
      data: { id: outcome.event.id, evidenceWord: outcome.event.serviceEvidence },
    };
  } catch (err) {
    return toReceivablesActionError(err, "recordNoticeDeemedService");
  }
}

/**
 * ⭐⭐⭐ THE STATUTORY LADDER BOARD — WHO IS DUE FOR WHICH RUNG.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THIS IS THE SCREEN THE CHASE WAS MISSING, AND IT SENDS NOTHING
 * ══════════════════════════════════════════════════════════════════════
 * `planDunningSweep` has been able to say which allottees have fallen
 * due for the next rung since Phase 38, and it writes nothing, which is
 * correct. `sendDunningNotice` has been able to send one, and it had NO
 * IMPORTER ANYWHERE in `app/` or `components/` — a legal instrument with
 * a permission model, four constraints and no way for a person to reach
 * it.
 *
 * ⚠️ AND IT IS NOT ON A CRON, DELIBERATELY. A cron holds no permission,
 * so putting the ladder on a clock would not be running it as somebody
 * with the right — it would be removing the right from the design. The
 * top rung precedes forfeiting what a family has paid towards a home;
 * "the system sent it automatically" is not an answer anybody can give at
 * a hearing.
 *
 * ⭐ `receivables:read`, AND WIDE ON PURPOSE. This is the list the person
 * who chases payments works from every morning, and gating the sight of
 * it behind the right to act on it would hide the arrears from the site
 * and from the CFO. Every act on it is guarded separately, at its own
 * rung's key.
 */
export async function getDunningLadderBoard(
  input: unknown,
): Promise<ActionResult<LadderBoard>> {
  try {
    const data = dunningBoardSchema.parse(input);
    await requirePermission("receivables:read");
    const ctx = await requireTenantContext();

    /*
     * ══════════════════════════════════════════════════════════════════
     * 🔴🔴 THE BOARD REFUSES TO RENDER IF THE PER-RUNG SPLIT IS GONE
     * ══════════════════════════════════════════════════════════════════
     * This screen's whole claim is that the escalating rung needs an
     * escalating right. That claim rests on `ROLE_TEMPLATES`, which lives
     * in another file and can be edited in one line by somebody being
     * helpful — give the accountant `receivables:warn_cancellation` and
     * every type still checks, every other test still passes, and the
     * safety catch is gone with no symptom.
     *
     * ⚠️ SO IT IS CHECKED HERE, AT READ TIME, AND THE ANSWER IS A
     * SENTENCE RATHER THAN A CRASH. A screen that offered a per-rung
     * authority the role model no longer honours would be worse than no
     * screen: it would be a screen asserting the catch is on.
     */
    const authorityProblem = ladderAuthorityProblem();
    if (authorityProblem) {
      return receivablesFail(
        `The dunning ladder's permission model is not intact, so this board will not show it. ${authorityProblem}`,
      );
    }

    const board = await dunningBoard({
      tenantId: ctx.tenant.id,
      projectId: data.projectId,
      asOf: data.asOf ?? today(),
      limit: data.limit,
    });

    return { ok: true, data: board };
  } catch (err) {
    return toReceivablesActionError(err, "getDunningLadderBoard");
  }
}

/**
 * ⭐⭐⭐ THE EXACT LETTER, BEFORE ANYBODY SENDS IT.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE PERMISSION IS THE RUNG'S OWN, NOT `receivables:read`
 * ══════════════════════════════════════════════════════════════════════
 * A preview here is not a report. It renders the actual instrument — the
 * allottee by name, the amount to be demanded, and for rung four the
 * words that precede terminating their allotment — and its only purpose
 * is to be confirmed. Gating it at `receivables:read` would mean anybody
 * in the workspace could compose a cancellation warning against a named
 * family and read it back, which is the document itself minus the
 * sending.
 *
 * ⚠️ AND IT MEANS THE SCREEN NEEDS NO SECOND COPY OF THE RULE. What the
 * preview returns is what may be sent; what it refuses is what may not.
 * A button that offered a rung the server would refuse is how people
 * learn a rule by hitting an error, and a rule learned that way is a rule
 * people work around.
 *
 * 🔴 IT WRITES NOTHING. No document row, no event row, no outbox row —
 * see `previewDunningLetter`. So it uses `requirePermission` rather than
 * `guardReceivablesWrite`: an entitlement gate here would refuse to
 * render the confirmation on a workspace whose plan lapsed, instead of
 * refusing the send, which is the check that matters.
 */
export async function previewDunningNotice(
  input: unknown,
): Promise<ActionResult<DunningPreview>> {
  try {
    const data = previewDunningSchema.parse(input);
    const permission = permissionForStage(data.stage);
    const ctx = await requirePermission(permission, {
      type: "demand_notice",
      id: data.demandId,
    });

    const head = await letterhead();
    const preview = await previewDunningLetter({
      tenantId: ctx.tenant.id,
      demandId: data.demandId,
      stage: data.stage,
      channel: data.channel,
      language: data.language,
      recipient: data.recipient,
      developerName: head.developerName,
      contactLine: head.contactLine,
      asOf: today(),
    });

    if ("ok" in preview && preview.ok === false) {
      return receivablesFail(
        preview.remedy ? `${preview.error} ${preview.remedy}` : preview.error,
      );
    }

    return { ok: true, data: preview as DunningPreview };
  } catch (err) {
    return toReceivablesActionError(err, "previewDunningNotice");
  }
}

/* ================================================================== */
/* REPORTS                                                             */
/* ================================================================== */

/**
 * ⭐ THE FIGURES, AS A SEPARATE OBJECT — AND THAT SHAPE IS THE POINT.
 *
 * 🔴 `figures` IS OPTIONAL AND IS **ABSENT** WHEN THE REPORT DOES NOT
 * RECONCILE. Not zeroed, not flagged, not accompanied by a boolean the
 * page is trusted to check — absent. The alternative shape, where every
 * total is always present alongside `reconciliation.renderable`, puts
 * the whole rule in the hands of one `if` on one screen, and the second
 * screen to consume this action is the one that forgets it. Making the
 * numbers structurally unavailable means a page that ignores the gate
 * does not render a wrong figure, it fails to compile.
 */
export type AgeingFigures = {
  totals: Record<string, string>;
  totalMinor: string;
  overdueMinor: string;
  interestMinor: string;
  byProject: Array<{ key: string; label: string; overdueMinor: string; demandCount: number }>;
  byBuyer: Array<{ key: string; label: string; overdueMinor: string; oldestDaysOverdue: number }>;
};

export type AgeingReportResult = {
  asOf: string;
  /** 🔴 Absent when `reconciliation.renderable` is false. See above. */
  figures?: AgeingFigures;
  reconciliation: SerializedReconciliation;
  /** Named causes for the breach. Empty unless there is one. */
  breachCauses: string[];
};

/**
 * ⭐⭐⭐ THE AGEING REPORT, OR THE REASON THERE ISN'T ONE.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 IT RECONCILES TO THE BOOKS BEFORE IT WILL PRODUCE A NUMBER
 * ══════════════════════════════════════════════════════════════════════
 * This report's total is the number a developer reads before deciding
 * who to chase, and it is the number a lender asks for before releasing
 * a construction tranche. It has never, until now, been checked against
 * anything. It is built from `demand_notices`; the books are built from
 * `journal_entries`; and three routine operations — withdrawing a
 * demand, superseding a demand, bouncing a receipt — move one without
 * moving the other. See `lib/reconciliation/receivables.ts` for the
 * identity and for the full list.
 *
 * ⚠️ THE GATE ALWAYS RUNS ON THE **WORKSPACE-WIDE** TOTAL, even when the
 * caller asked for one project. A journal entry carries a booking as its
 * counterparty and has no project column, so a per-project slice of the
 * control account does not exist to compare against. Reconciling the
 * whole set and then displaying a slice of it is the honest option — you
 * cannot publish an extract of a book that does not foot — and the
 * alternative, skipping the check whenever a filter is applied, would
 * switch the gate off at exactly the moment somebody is drilling into a
 * figure they already distrust.
 */
export async function getAgeingReport(
  input: unknown,
): Promise<ActionResult<AgeingReportResult>> {
  try {
    const data = ageingQuerySchema.parse(input);
    const ctx = await requirePermission("receivables:read");
    const asOf = data.asOf ?? today();
    const filtered = Boolean(data.projectId || data.bookingId);

    const rows = await ageingRows(ctx.tenant.id, {
      projectId: data.projectId,
      bookingId: data.bookingId,
      asOf,
    });
    const report = ageReceivables(rows, asOf);

    /**
     * ⚠️ THE UNFILTERED SET IS LOADED AGAIN ONLY WHEN A FILTER WAS
     * APPLIED. On the common path — the receivables screen, no filter —
     * the rows already in hand ARE the workspace-wide set, and querying
     * them a second time would cost a scan to obtain a value we hold.
     * It would also not make the check any more independent: the
     * independence comes from the LEDGER side, which shares no table
     * with either copy.
     */
    const workspaceTotalMinor = filtered
      ? ageReceivables(await ageingRows(ctx.tenant.id, { asOf }), asOf).totalMinor
      : report.totalMinor;

    const control = await receivableControl(ctx.tenant.id, { to: asOf });

    const verdict = reconcileAgeingReport({
      ageingTotalMinor: workspaceTotalMinor,
      control,
      showsInterest: true,
      asOf,
      today: today(),
    });

    const reconciliation = serializeReconciliation(verdict);

    /**
     * 🔴 NO FIGURES AT ALL WHEN IT DOES NOT RECONCILE — not the ageing
     * total, not the buckets, and not the control-account balance
     * either, even though that one is a fact read straight off the
     * ledger. `lib/accounting/cash-flow.ts` settled this argument for
     * the cash flow statement and the reasoning transfers unchanged: a
     * true figure printed under a heading that has just failed its own
     * consistency check is read as verified, because the reader takes
     * the heading to mean somebody checked. The gap itself IS returned,
     * inside the reconciliation, because it is a diagnostic rather than
     * a report figure — "your books are out by ₹14,500.00" sends
     * somebody to the right transaction where "reconciliation failed"
     * sends them to support.
     */
    if (!verdict.renderable) {
      return {
        ok: true,
        data: { asOf: report.asOf, reconciliation, breachCauses: [...AGEING_BREACH_CAUSES] },
      };
    }

    return {
      ok: true,
      data: {
        asOf: report.asOf,
        reconciliation,
        breachCauses: [],
        figures: {
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
export type StatementFigures = {
  demandedMinor: string;
  receivedMinor: string;
  outstandingMinor: string;
  interestOutstandingMinor: string;
  creditMinor: string;
  payableTodayMinor: string;
  /**
   * 🔴 THE NARRATIVE LIVES INSIDE `figures`, NOT BESIDE IT. Every line of
   * it quotes a rupee amount — "Received ₹2,00,000, outstanding ₹50,000".
   * Returning the prose while withholding the totals would hand over
   * exactly the numbers the gate refused, in sentences, and prose reads
   * as MORE authoritative than a table because somebody appears to have
   * written it.
   */
  narrative: string[];
};

export type StatementResult = {
  asOf: string;
  /** 🔴 Absent when the statement does not reconcile. See `AgeingFigures`. */
  figures?: StatementFigures;
  reconciliation: SerializedReconciliation;
  breachCauses: string[];
};

/**
 * ⭐ THE DOCUMENT A BUYER IS HANDED.
 *
 * Returns the narrative as well as the figures: the whole requirement is
 * that a split can be EXPLAINED, and the narrative carries the sentence
 * recorded when each payment was applied.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 AND IT NOW RECONCILES TO THIS BUYER'S LINE IN THE BOOKS FIRST
 * ══════════════════════════════════════════════════════════════════════
 * `buildStatement` already refuses to produce a statement that does not
 * foot — but that check is INTERNAL. It proves the document is
 * consistent with itself, which a document assembled from one table
 * always is. It cannot see that the developer's own ledger says this
 * buyer paid ₹2 lakh less, because a cheque bounced and no reversing
 * entry was ever posted.
 *
 * ⚠️ THIS IS THE HIGHEST-COST DOCUMENT IN THE STACK TO GET WRONG. It
 * leaves the building. A buyer keeps it, and produces it in a consumer
 * forum when the developer's ledger says something different — at which
 * point the developer is explaining, under oath, why their own two
 * systems disagreed and nobody noticed.
 *
 * Two checks rather than one combined figure, because "still owes" and
 * "has paid" fail for different reasons, are fixed by different people,
 * and a single combined check is satisfied by an error in each direction
 * cancelling out — the one case where BOTH halves are wrong.
 */
export async function getStatementOfAccount(
  input: unknown,
): Promise<ActionResult<StatementResult>> {
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

    /**
     * ⚠️ BOTH LEDGER FIGURES ARE SLICED BY THE BOOKING COUNTERPARTY, which
     * `writePropertyPosting` stamps onto every leg it writes. It is the
     * only per-buyer view of the ledger that exists, and it is the reason
     * a per-booking check is possible at all while a per-project one is
     * not.
     */
    const [control, collections] = await Promise.all([
      receivableControl(ctx.tenant.id, { to: asOf, bookingId: data.bookingId }),
      roleLedgerTotals(ctx.tenant.id, COLLECTION_ROLES, {
        to: asOf,
        bookingId: data.bookingId,
      }),
    ]);

    const verdict = reconcileStatement({
      outstandingMinor: statement.totals.outstandingMinor,
      receivedMinor: statement.totals.receivedMinor,
      tdsCreditMinor: statement.totals.tdsCreditMinor,
      control,
      // Debits only. A refund CREDITS the bank against the same booking
      // and is a separate fact on a separate date — netting it off would
      // make a refunded booking look like one that never paid. See
      // `lib/reconciliation/receivables.ts`.
      collectionDebitsMinor: collections.debitMinor,
      collectionsConfigured: collections.configured,
      collectionsLabel: collections.label,
    });

    const reconciliation = serializeReconciliation(verdict);

    // 🔴 No totals and no narrative when it does not reconcile. See
    // `StatementFigures` for why the prose goes with the numbers.
    if (!verdict.renderable) {
      return {
        ok: true,
        data: {
          asOf: statement.asOf,
          reconciliation,
          breachCauses: [...STATEMENT_BREACH_CAUSES],
        },
      };
    }

    return {
      ok: true,
      data: {
        asOf: statement.asOf,
        reconciliation,
        breachCauses: [],
        figures: {
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
      },
    };
  } catch (err) {
    return toReceivablesActionError(err, "getStatementOfAccount");
  }
}
