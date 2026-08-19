"use server";

/**
 * Ordence — Financial Period Close (SEC-012)
 * Version: v0.5.0-alpha
 *
 * Closing a period is an ATTESTATION: "these numbers are final; I stand behind
 * them." Everything here is built around that being a serious act.
 *
 *   - It requires `periods:close`, which the Accountant role deliberately does
 *     NOT hold. Recording numbers and declaring them final are different jobs;
 *     separating them is standard segregation of duties.
 *   - The trial balance is verified BEFORE the lock. Sealing books that do not
 *     balance would make the seal worthless.
 *   - A snapshot of every ledger balance is stored at close, so a later
 *     reconciliation has something to compare against.
 *   - Reopening is possible but requires a written reason, a higher permission,
 *     and produces a critical-severity audit record.
 *
 * The database trigger is the actual guarantee. This layer exists so the user
 * gets a clear explanation instead of a raw Postgres exception.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { and, eq, sql, desc, lte, gte, ne } from "drizzle-orm";
import { db, withTenant } from "@/db";
import { financialPeriods, ledgers, journalEntries, transactions } from "@/db/schema";
import { requirePermission } from "@/server/audit";
import { writeAudit, auditMeta } from "@/server/audit";
import { TenantAccessError } from "@/server/tenant-context";
import {
  assertImpersonationAllows,
  ImpersonationForbiddenError,
} from "@/server/platform/impersonation";
import { requireFeature, FeatureLockedError } from "@/server/entitlements";
import { requireAccess, AccessRestrictedError } from "@/server/billing/access";
import { PermissionDeniedError } from "@/lib/permissions";
import type { ActionResult } from "@/lib/validators/crm";
import {
  createPeriodSchema,
  closePeriodSchema,
  reopenPeriodSchema,
} from "@/lib/validators/periods";
import type {
  CreatePeriodInput,
  ClosePeriodInput,
  ReopenPeriodInput,
} from "@/lib/validators/periods";
import { closeReadiness } from "@/server/accounting/close-readiness";
import {
  closeVerdict,
  describeStranded,
  periodHasEnded,
} from "@/lib/accounting/close-checklist";
import { toCivilDay } from "@/lib/gst/constants";
import type { FinancialPeriod } from "@/db/schema";

/* ------------------------------------------------------------------ */
/* VALIDATION                                                          */
/* ------------------------------------------------------------------ */

const uuidSchema = z.string().uuid("Invalid identifier.");

// Period schemas now live in `lib/validators/periods.ts` — a "use server"
// file may only export async functions.

export type { CreatePeriodInput, ClosePeriodInput, ReopenPeriodInput };

function fail(error: string, fieldErrors?: Record<string, string[]>): ActionResult<never> {
  return { ok: false, error, fieldErrors };
}

function toActionError(err: unknown): ActionResult<never> {
  // A read-only workspace is an account-standing answer with its own
  // remedy. It must not surface as a generic failure — and it must not
  // be confused with a permission or plan problem.
  if (err instanceof AccessRestrictedError) return fail(err.message);
  // A locked feature is a commercial answer, not a fault. It must
  // never surface as "something went wrong" — the customer can act
  // on "upgrade to Advanced" and cannot act on a generic error.
  if (err instanceof FeatureLockedError) return fail(err.message);
  if (err instanceof PermissionDeniedError) return fail(err.message);
  if (err instanceof TenantAccessError) return fail(err.message);
  if (err instanceof ImpersonationForbiddenError) return fail(err.message);
  if (err instanceof z.ZodError) {
    return fail("Validation failed.", err.flatten().fieldErrors as Record<string, string[]>);
  }
  const message = err instanceof Error ? err.message : "";
  // Surface the database trigger's own rejection in plain language.
  if (message.includes("closed accounting period") || message.includes("period is closed")) {
    return fail(
      "That accounting period is closed. Post the entry to an open period, or reopen the period first.",
    );
  }
  if (message.includes("overlap")) {
    return fail("This period overlaps an existing one. Periods must not overlap.");
  }
  console.error("[periods action]", err);
  return fail("Something went wrong. Please try again.");
}

/* ------------------------------------------------------------------ */
/* CREATE PERIOD                                                       */
/* ------------------------------------------------------------------ */

export async function createFinancialPeriod(
  input: CreatePeriodInput,
): Promise<ActionResult<FinancialPeriod>> {
  try {
    const ctx = await requirePermission("periods:close");
    // ACCOUNT STANDING FIRST, then plan, then person. Broadest
    // reason outermost, so the customer is told the thing they can
    // actually act on rather than an inner detail.
    await requireAccess("periods:create", ctx);
    // ⚠️ ENTITLEMENT BEFORE PERMISSION. If a workspace owner on a plan
    // without this feature hits it, the true answer is "your plan does
    // not include it" — not "you lack permission", which would send the
    // owner to ask an administrator who is themselves.
    await requireFeature("accounting.period_close", ctx);
    const data = createPeriodSchema.parse(input);

    // Overlap check in the application, so the user gets a useful message.
    // The database has an exclusion constraint as the actual guarantee.
    const overlapping = await withTenant(ctx.tenant.id, (tx) =>
      tx
        .select({ id: financialPeriods.id, name: financialPeriods.name })
        .from(financialPeriods)
        .where(
          and(
            eq(financialPeriods.tenantId, ctx.tenant.id),
            lte(financialPeriods.startDate, data.endDate),
            gte(financialPeriods.endDate, data.startDate),
          ),
        )
        .limit(1)
    );

    if (overlapping.length > 0) {
      return fail("Validation failed.", {
        startDate: [`This range overlaps the existing period "${overlapping[0]?.name}".`],
      });
    }

    const [created] = await withTenant(ctx.tenant.id, (tx) =>
      tx
        .insert(financialPeriods)
        .values({
          tenantId: ctx.tenant.id,
          name: data.name,
          startDate: data.startDate,
          endDate: data.endDate,
          fiscalYear: data.fiscalYear ?? null,
          periodNumber: data.periodNumber ?? null,
          status: "open",
          createdBy: ctx.user.id,
        })
        .returning()
    );

    if (!created) return fail("Failed to create the period.");

    await writeAudit(ctx, {
      action: "create",
      resourceType: "financial_period",
      resourceId: created.id,
      newValue: { name: created.name, startDate: created.startDate, endDate: created.endDate },
      metadata: auditMeta({ fiscalYear: data.fiscalYear }),
      reason: "Accounting period created",
      severity: "notice",
    });

    revalidatePath("/accounting");
    return { ok: true, data: created };
  } catch (err) {
    return toActionError(err);
  }
}

/* ------------------------------------------------------------------ */
/* CLOSE PERIOD  — the SEC-012 resolution                              */
/* ------------------------------------------------------------------ */

export type ClosePeriodResult = {
  period: FinancialPeriod;
  entriesLocked: number;
  /** ⭐ Minor units, as digit strings. Batch 0108; was a rupee string. */
  totalDebitsMinor: string;
  totalCreditsMinor: string;
  wasBalanced: boolean;
};

/**
 * Close a period. From this point the database physically refuses any journal
 * entry dated inside it.
 */
export async function closeFinancialPeriod(
  input: ClosePeriodInput,
): Promise<ActionResult<ClosePeriodResult>> {
  try {
    const ctx = await requirePermission("periods:close", { type: "financial_period" });
    // ACCOUNT STANDING FIRST, then plan, then person. Broadest
    // reason outermost, so the customer is told the thing they can
    // actually act on rather than an inner detail.
    await requireAccess("periods:close", ctx);
    // ⚠️ ENTITLEMENT BEFORE PERMISSION. If a workspace owner on a plan
    // without this feature hits it, the true answer is "your plan does
    // not include it" — not "you lack permission", which would send the
    // owner to ask an administrator who is themselves.
    await requireFeature("accounting.period_close", ctx);
    // ⭐ Closing a period is an ATTESTATION — "these books are final" —
    // and it is the customer's to make, not ours. A support session
    // that could sign off somebody's accounts has signed something on
    // their behalf.
    await assertImpersonationAllows("periods:close", ctx);
    const data = closePeriodSchema.parse(input);

    const period = await withTenant(ctx.tenant.id, (tx) =>
      tx.query.financialPeriods.findFirst({
        where: and(
          eq(financialPeriods.id, data.periodId),
          eq(financialPeriods.tenantId, ctx.tenant.id),
        ),
      })
    );

    if (!period) return fail("Period not found.");
    if (period.status === "closed" || period.status === "locked") {
      return fail(`This period is already ${period.status}.`);
    }

    /**
     * ⭐ A MONTH THAT HAS NOT ENDED CANNOT BE FINAL — v1.27.0-alpha.
     *
     * ⚠️ THIS IS NOT A SMALLER MISTAKE THAN SEALING OVER UNPOSTED
     * DOCUMENTS. It is the same mistake with a guaranteed outcome:
     * everything that happens for the rest of the month is stranded by
     * construction, and there is no version of the facts under which
     * the attestation is true when it is made.
     */
    const today = toCivilDay(new Date());
    if (!periodHasEnded({ endDate: period.endDate }, today)) {
      return fail(
        `"${period.name}" runs to ${period.endDate} and today is ${today}. A period ` +
          `cannot be declared final before it has ended — everything recorded for the ` +
          `rest of it would be locked out of the month it happened in.`,
      );
    }

    /* ---- 0. ⭐⭐⭐ IS ANYTHING FROM THIS MONTH STILL NOT POSTED? ---- */
    /**
     * ══════════════════════════════════════════════════════════════
     * 🔴 THE CHECK THAT WAS MISSING FOR NINETEEN BATCHES
     * ══════════════════════════════════════════════════════════════
     * Everything below this — the balance check, the snapshot, the
     * audit record — has been careful since v0.5.0. And a period with
     * eleven unposted July documents BALANCES PERFECTLY, because the
     * missing entries are missing from both sides. Zero equals zero.
     *
     * ⚠️ SO THE SEAL WENT ON BOOKS THAT WERE INTERNALLY CONSISTENT AND
     * INCOMPLETE, and `0073`'s period lock then refused those documents
     * from the month they belong to, permanently.
     *
     * ⭐ IT RUNS BEFORE THE BALANCE CHECK, deliberately. A month with
     * missing documents will usually balance, so reporting the balance
     * first would tell somebody the books are fine and then refuse.
     */
    const blockers = await closeReadiness(ctx.tenant.id, {
      startDate: period.startDate,
      endDate: period.endDate,
    });
    const verdict = closeVerdict(blockers);

    if (!verdict.ready && !data.strandDocumentsReason) {
      return fail(
        `${verdict.headline} ${describeStranded(verdict.blocking)}. ` +
          `${verdict.overrideWarning} ` +
          `Post them first, or close with a written reason if they genuinely do not belong in this month.`,
      );
    }

    /* ---- 1. Verify the books balance for this period -------------- */
    const totals = await withTenant(ctx.tenant.id, (tx) =>
      tx
        .select({
          /**
           * ⭐ SUMMED IN MINOR UNITS. Batch 0108.
           *
           * 🔴 THE COMPARISON BELOW USED TO BE A FLOAT ONE. This query
           * summed `numeric(18,2)`, the consumer did `Number(...)`, and the
           * gate that decides whether a period may be SEALED read
           * `Math.abs(debits - credits) < 0.005`. An epsilon comparison on
           * IEEE-754 doubles, guarding the statement an auditor is given.
           * Two integers are either equal or they are not.
           */
          totalDebitsMinor: sql<string>`COALESCE(SUM(CASE WHEN ${journalEntries.entryType} = 'debit'  THEN ${journalEntries.amountMinor} ELSE 0 END), 0)::text`,
          totalCreditsMinor: sql<string>`COALESCE(SUM(CASE WHEN ${journalEntries.entryType} = 'credit' THEN ${journalEntries.amountMinor} ELSE 0 END), 0)::text`,
          entryCount: sql<number>`COUNT(*)::int`,
          /** ⚠️ SUM() skips NULLs; an unscaled leg would make the books
           *  appear to balance by being absent from both sides. */
          unscaledLegs: sql<number>`COUNT(*) FILTER (WHERE ${journalEntries.amountMinor} IS NULL)::int`,
        })
        .from(journalEntries)
        .innerJoin(transactions, eq(transactions.id, journalEntries.transactionId))
        .where(
          and(
            eq(journalEntries.tenantId, ctx.tenant.id),
            gte(transactions.transactionDate, period.startDate),
            lte(transactions.transactionDate, period.endDate),
          ),
        )
    );

    const summary = totals[0];

    if ((summary?.unscaledLegs ?? 0) > 0) {
      return fail(
        `Cannot close: ${summary?.unscaledLegs} journal line(s) in this period have no ` +
          `amount in minor units, so whether the period balances cannot be established. ` +
          `Run the census in SQL-FILES/0108 to see which currency is unscaled.`,
      );
    }

    const debitsMinor = BigInt(summary?.totalDebitsMinor ?? "0");
    const creditsMinor = BigInt(summary?.totalCreditsMinor ?? "0");
    const entryCount = summary?.entryCount ?? 0;
    /**
     * ⭐ EXACT. Batch 0108. Two integers are equal or they are not; there
     * is no epsilon and there is nothing to tune.
     */
    const wasBalanced = debitsMinor === creditsMinor;

    // Sealing books that do not balance makes the seal meaningless.
    if (!wasBalanced && !data.forceUnbalanced) {
      return fail(
        `Cannot close: the period does not balance. ` +
          `Debits ${debitsMinor} vs credits ${creditsMinor} (in minor units). ` +
          `Find the discrepancy first, or close with an explicit override.`,
      );
    }

    /* ---- 2. Snapshot every ledger balance ------------------------- */
    const ledgerRows = await withTenant(ctx.tenant.id, (tx) =>
      tx
        .select({
          ledgerId: ledgers.id,
          code: ledgers.code,
          balance: ledgers.currentBalance,
        })
        .from(ledgers)
        .where(eq(ledgers.tenantId, ctx.tenant.id))
    );

    /* ---- 3. Lock it ----------------------------------------------- */
    const [closed] = await withTenant(ctx.tenant.id, (tx) =>
      tx
        .update(financialPeriods)
        .set({
          status: "closed",
          closedAt: new Date(),
          closedBy: ctx.user.id,
          closingNotes: data.closingNotes ?? null,
          closingBalances: {
            /**
             * ⭐ MINOR UNITS, AND THE KEY SAYS SO. Batch 0108.
             *
             * ⚠️ THE OLD KEYS `totalDebits` / `totalCredits` HELD A
             * `.toFixed(2)` RUPEE STRING and are deliberately not reused
             * for a different unit. A sealed snapshot whose numbers
             * silently changed meaning between releases is unreadable
             * afterwards, and this blob is the thing an auditor is shown.
             */
            totalDebitsMinor: debitsMinor.toString(),
            totalCreditsMinor: creditsMinor.toString(),
            entryCount,
            ledgerBalances: ledgerRows.map((l) => ({
              ledgerId: l.ledgerId,
              code: l.code,
              balance: l.balance,
            })),
          },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(financialPeriods.id, period.id),
            eq(financialPeriods.tenantId, ctx.tenant.id),
          ),
        )
        .returning()
    );

    if (!closed) return fail("Failed to close the period.");

    await writeAudit(ctx, {
      action: "config_change",
      resourceType: "financial_period",
      resourceId: closed.id,
      oldValue: { status: period.status },
      newValue: { status: "closed" },
      metadata: auditMeta({
        periodName: closed.name,
        startDate: closed.startDate,
        endDate: closed.endDate,
        totalDebitsMinor: debitsMinor.toString(),
        totalCreditsMinor: creditsMinor.toString(),
        entriesLocked: entryCount,
        wasBalanced,
        forcedUnbalanced: !wasBalanced && data.forceUnbalanced,
        /**
         * ⭐ THE STRANDED DOCUMENTS ARE NAMED IN THE AUDIT RECORD, by
         * module and count, not merely counted. "Closed with 11
         * stranded" is a fact somebody has to go and reconstruct; "3
         * sales invoices, 8 vendor payments" is where to look.
         */
        strandedCount: verdict.strandedCount,
        stranded: verdict.strandedCount > 0 ? describeStranded(verdict.blocking) : null,
        strandDocumentsReason: data.strandDocumentsReason ?? null,
      }),
      reason:
        data.strandDocumentsReason ??
        data.closingNotes ??
        `Period "${closed.name}" closed.`,
      /**
       * An unbalanced forced close is exactly the event an auditor must
       * find — and so is a close that knowingly left documents out of
       * the month they happened in.
       */
      severity: wasBalanced && verdict.strandedCount === 0 ? "notice" : "critical",
    });

    revalidatePath("/accounting");
    revalidatePath("/dashboard");

    return {
      ok: true,
      data: {
        period: closed,
        entriesLocked: entryCount,
        totalDebitsMinor: debitsMinor.toString(),
        totalCreditsMinor: creditsMinor.toString(),
        wasBalanced,
      },
    };
  } catch (err) {
    return toActionError(err);
  }
}

/* ------------------------------------------------------------------ */
/* ⭐⭐⭐ THE PRE-CLOSE CHECK — v1.27.0-alpha                           */
/* ------------------------------------------------------------------ */

export type CloseReadinessView = {
  periodName: string;
  startDate: string;
  endDate: string;
  hasEnded: boolean;
  ready: boolean;
  headline: string;
  strandedCount: number;
  overrideWarning: string | null;
  blocking: {
    key: string;
    source: string;
    count: number;
    headline: string;
    consequence: string;
    where: string;
    amountMinor: string | null;
    oldest: string | null;
  }[];
  advisory: {
    key: string;
    source: string;
    count: number;
    headline: string;
    consequence: string;
    where: string;
    amountMinor: string | null;
    oldest: string | null;
  }[];
};

/**
 * ⭐ WHAT WOULD HAPPEN IF THIS PERIOD WERE CLOSED RIGHT NOW.
 *
 * ⚠️ GATED ON `periods:read`, NOT ON `periods:close`. Seeing what is
 * outstanding is how somebody knows what to POST, and the people who
 * post are deliberately not the people who close — the Accountant role
 * holds `transactions:post` and does not hold `periods:close`. Gating
 * the checklist on the closing permission would show the list only to
 * the person who cannot act on it.
 */
export async function getCloseReadiness(input: {
  periodId: string;
}): Promise<ActionResult<CloseReadinessView>> {
  try {
    const ctx = await requirePermission("periods:read");
    const periodId = uuidSchema.parse(input.periodId);

    const period = await withTenant(ctx.tenant.id, (tx) =>
      tx.query.financialPeriods.findFirst({
        where: and(
          eq(financialPeriods.id, periodId),
          eq(financialPeriods.tenantId, ctx.tenant.id),
        ),
      })
    );
    if (!period) return fail("Period not found.");

    const blockers = await closeReadiness(ctx.tenant.id, {
      startDate: period.startDate,
      endDate: period.endDate,
    });
    const verdict = closeVerdict(blockers);
    const today = toCivilDay(new Date());

    const shape = (b: (typeof verdict.blocking)[number]) => ({
      key: b.key,
      source: b.source,
      count: b.count,
      headline: b.headline,
      consequence: b.consequence,
      where: b.where,
      amountMinor: b.amountMinor === null ? null : b.amountMinor.toString(),
      oldest: b.oldest,
    });

    return {
      ok: true,
      data: {
        periodName: period.name,
        startDate: period.startDate,
        endDate: period.endDate,
        hasEnded: periodHasEnded({ endDate: period.endDate }, today),
        ready: verdict.ready,
        headline: verdict.headline,
        strandedCount: verdict.strandedCount,
        overrideWarning: verdict.overrideWarning,
        blocking: verdict.blocking.map(shape),
        advisory: verdict.advisory.map(shape),
      },
    };
  } catch (err) {
    return toActionError(err);
  }
}

/* ------------------------------------------------------------------ */
/* REOPEN PERIOD                                                       */
/* ------------------------------------------------------------------ */

/**
 * Reopen a closed period.
 *
 * Requires `periods:reopen` — a permission held only by owners and admins, not
 * by the Accountant role. Every reopen is a critical-severity audit event,
 * because it means previously-final numbers can change again.
 */
export async function reopenFinancialPeriod(
  input: ReopenPeriodInput,
): Promise<ActionResult<FinancialPeriod>> {
  try {
    const ctx = await requirePermission("periods:reopen", { type: "financial_period" });
    // ACCOUNT STANDING FIRST, then plan, then person. Broadest
    // reason outermost, so the customer is told the thing they can
    // actually act on rather than an inner detail.
    await requireAccess("periods:reopen", ctx);
    // ⚠️ ENTITLEMENT BEFORE PERMISSION. If a workspace owner on a plan
    // without this feature hits it, the true answer is "your plan does
    // not include it" — not "you lack permission", which would send the
    // owner to ask an administrator who is themselves.
    await requireFeature("accounting.period_close", ctx);
    // Reopening rewrites signed-off financial history. Same reason,
    // pointed the other way.
    await assertImpersonationAllows("periods:reopen", ctx);
    const data = reopenPeriodSchema.parse(input);

    const period = await withTenant(ctx.tenant.id, (tx) =>
      tx.query.financialPeriods.findFirst({
        where: and(
          eq(financialPeriods.id, data.periodId),
          eq(financialPeriods.tenantId, ctx.tenant.id),
        ),
      })
    );

    if (!period) return fail("Period not found.");
    if (period.status === "open") return fail("This period is already open.");
    if (period.status === "locked") {
      return fail("This period is permanently locked and cannot be reopened.");
    }

    const [reopened] = await withTenant(ctx.tenant.id, (tx) =>
      tx
        .update(financialPeriods)
        .set({
          status: "open",
          reopenedAt: new Date(),
          reopenedBy: ctx.user.id,
          reopenReason: data.reason,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(financialPeriods.id, period.id),
            eq(financialPeriods.tenantId, ctx.tenant.id),
          ),
        )
        .returning()
    );

    if (!reopened) return fail("Failed to reopen the period.");

    await writeAudit(ctx, {
      action: "config_change",
      resourceType: "financial_period",
      resourceId: reopened.id,
      oldValue: { status: "closed", closedAt: period.closedAt },
      newValue: { status: "open" },
      metadata: auditMeta({
        periodName: reopened.name,
        originallyClosedAt: period.closedAt,
        closingBalancesAtClose: period.closingBalances,
      }),
      reason: data.reason,
      severity: "critical",
    });

    revalidatePath("/accounting");
    return { ok: true, data: reopened };
  } catch (err) {
    return toActionError(err);
  }
}

/* ------------------------------------------------------------------ */
/* READS                                                               */
/* ------------------------------------------------------------------ */

export async function getFinancialPeriods(): Promise<ActionResult<FinancialPeriod[]>> {
  try {
    const ctx = await requirePermission("periods:read");
    const rows = await withTenant(ctx.tenant.id, (tx) =>
      tx
        .select()
        .from(financialPeriods)
        .where(eq(financialPeriods.tenantId, ctx.tenant.id))
        .orderBy(desc(financialPeriods.startDate))
    );
    return { ok: true, data: rows };
  } catch (err) {
    return toActionError(err);
  }
}

/**
 * Is a given date inside a closed period?
 * Used by the UI to disable date pickers before the user even tries.
 */
export async function isDateLocked(
  date: string,
): Promise<ActionResult<{ locked: boolean; periodName?: string }>> {
  try {
    const ctx = await requirePermission("periods:read");
    const parsed = z.string().date().parse(date);

    const rows = await withTenant(ctx.tenant.id, (tx) =>
      tx
        .select({ name: financialPeriods.name, status: financialPeriods.status })
        .from(financialPeriods)
        .where(
          and(
            eq(financialPeriods.tenantId, ctx.tenant.id),
            lte(financialPeriods.startDate, parsed),
            gte(financialPeriods.endDate, parsed),
            ne(financialPeriods.status, "open"),
          ),
        )
        .limit(1)
    );

    const hit = rows[0];
    return {
      ok: true,
      data: hit ? { locked: true, periodName: hit.name } : { locked: false },
    };
  } catch (err) {
    return toActionError(err);
  }
}
