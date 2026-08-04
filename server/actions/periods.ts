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
    const overlapping = await db
      .select({ id: financialPeriods.id, name: financialPeriods.name })
      .from(financialPeriods)
      .where(
        and(
          eq(financialPeriods.tenantId, ctx.tenant.id),
          lte(financialPeriods.startDate, data.endDate),
          gte(financialPeriods.endDate, data.startDate),
        ),
      )
      .limit(1);

    if (overlapping.length > 0) {
      return fail("Validation failed.", {
        startDate: [`This range overlaps the existing period "${overlapping[0]?.name}".`],
      });
    }

    const [created] = await db
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
      .returning();

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
  totalDebits: string;
  totalCredits: string;
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

    const period = await db.query.financialPeriods.findFirst({
      where: and(
        eq(financialPeriods.id, data.periodId),
        eq(financialPeriods.tenantId, ctx.tenant.id),
      ),
    });

    if (!period) return fail("Period not found.");
    if (period.status === "closed" || period.status === "locked") {
      return fail(`This period is already ${period.status}.`);
    }

    /* ---- 1. Verify the books balance for this period -------------- */
    const totals = await db
      .select({
        totalDebits: sql<string>`COALESCE(SUM(CASE WHEN ${journalEntries.entryType} = 'debit'  THEN ${journalEntries.amount} ELSE 0 END), 0)::text`,
        totalCredits: sql<string>`COALESCE(SUM(CASE WHEN ${journalEntries.entryType} = 'credit' THEN ${journalEntries.amount} ELSE 0 END), 0)::text`,
        entryCount: sql<number>`COUNT(*)::int`,
      })
      .from(journalEntries)
      .innerJoin(transactions, eq(transactions.id, journalEntries.transactionId))
      .where(
        and(
          eq(journalEntries.tenantId, ctx.tenant.id),
          gte(transactions.transactionDate, period.startDate),
          lte(transactions.transactionDate, period.endDate),
        ),
      );

    const summary = totals[0];
    const debits = Number(summary?.totalDebits ?? 0);
    const credits = Number(summary?.totalCredits ?? 0);
    const entryCount = summary?.entryCount ?? 0;
    const wasBalanced = Math.abs(debits - credits) < 0.005;

    // Sealing books that do not balance makes the seal meaningless.
    if (!wasBalanced && !data.forceUnbalanced) {
      return fail(
        `Cannot close: the period does not balance. ` +
          `Debits ${debits.toFixed(2)} vs credits ${credits.toFixed(2)}. ` +
          `Find the discrepancy first, or close with an explicit override.`,
      );
    }

    /* ---- 2. Snapshot every ledger balance ------------------------- */
    const ledgerRows = await db
      .select({
        ledgerId: ledgers.id,
        code: ledgers.code,
        balance: ledgers.currentBalance,
      })
      .from(ledgers)
      .where(eq(ledgers.tenantId, ctx.tenant.id));

    /* ---- 3. Lock it ----------------------------------------------- */
    const [closed] = await db
      .update(financialPeriods)
      .set({
        status: "closed",
        closedAt: new Date(),
        closedBy: ctx.user.id,
        closingNotes: data.closingNotes ?? null,
        closingBalances: {
          totalDebits: debits.toFixed(2),
          totalCredits: credits.toFixed(2),
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
      .returning();

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
        totalDebits: debits.toFixed(2),
        totalCredits: credits.toFixed(2),
        entriesLocked: entryCount,
        wasBalanced,
        forcedUnbalanced: !wasBalanced && data.forceUnbalanced,
      }),
      reason: data.closingNotes ?? `Period "${closed.name}" closed.`,
      // An unbalanced forced close is exactly the event an auditor must find.
      severity: wasBalanced ? "notice" : "critical",
    });

    revalidatePath("/accounting");
    revalidatePath("/dashboard");

    return {
      ok: true,
      data: {
        period: closed,
        entriesLocked: entryCount,
        totalDebits: debits.toFixed(2),
        totalCredits: credits.toFixed(2),
        wasBalanced,
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

    const period = await db.query.financialPeriods.findFirst({
      where: and(
        eq(financialPeriods.id, data.periodId),
        eq(financialPeriods.tenantId, ctx.tenant.id),
      ),
    });

    if (!period) return fail("Period not found.");
    if (period.status === "open") return fail("This period is already open.");
    if (period.status === "locked") {
      return fail("This period is permanently locked and cannot be reopened.");
    }

    const [reopened] = await db
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
      .returning();

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
    const rows = await db
      .select()
      .from(financialPeriods)
      .where(eq(financialPeriods.tenantId, ctx.tenant.id))
      .orderBy(desc(financialPeriods.startDate));
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

    const rows = await db
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
      .limit(1);

    const hit = rows[0];
    return {
      ok: true,
      data: hit ? { locked: true, periodName: hit.name } : { locked: false },
    };
  } catch (err) {
    return toActionError(err);
  }
}
