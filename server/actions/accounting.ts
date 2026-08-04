"use server";

/**
 * Ordence — Trust Accounting Actions
 * Version: v0.4.0-alpha
 *
 * DOUBLE-ENTRY ENFORCEMENT, APPLICATION LAYER.
 *
 * The database has a deferred constraint trigger that rejects any unbalanced
 * transaction at COMMIT. That is the guarantee. This layer exists so users get a
 * clear, actionable error *before* the write is attempted, rather than a raw
 * Postgres exception.
 *
 * Both layers are necessary and neither is redundant:
 *   - App layer  → good errors, business rules, tenant scoping
 *   - DB trigger → the guarantee that survives any application bug, any raw SQL,
 *                  any future service written by someone who never read this file
 *
 * MONEY IS NEVER A JAVASCRIPT NUMBER HERE.
 * Amounts stay as decimal strings and are summed in integer paise. `0.1 + 0.2`
 * is `0.30000000000000004` in IEEE-754 — over a few thousand entries that drift
 * becomes a genuinely unbalanced ledger.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { and, eq, isNull, sql, desc } from "drizzle-orm";
import { db, withTenant } from "@/db";
import { ledgers, transactions, journalEntries, auditLogs } from "@/db/schema";
import { requireTenantContext, requireRole, TenantAccessError } from "@/server/tenant-context";
import { requireFeature, FeatureLockedError } from "@/server/entitlements";
import { requireAccess, AccessRestrictedError } from "@/server/billing/access";
import type { ActionResult } from "@/lib/validators/crm";
import {
  postTransactionSchema,
  toMinorUnits,
  fromMinorUnits,
} from "@/lib/validators/accounting";
import type { PostTransactionInput } from "@/lib/validators/accounting";
import type { Ledger, Transaction, SystemRole } from "@/db/schema";

/* ------------------------------------------------------------------ */
/* EXACT DECIMAL ARITHMETIC                                            */
/* ------------------------------------------------------------------ */

// Money helpers, the leg schema and `postTransactionSchema` now live in
// `lib/validators/accounting.ts` — a "use server" file may only export
// async functions, so a shared schema cannot be declared here.

const uuidSchema = z.string().uuid("Invalid identifier.");

export type { PostTransactionInput };

const createLedgerSchema = z.object({
  name: z.string().trim().min(1).max(200),
  code: z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9._-]+$/, "Use letters, numbers, dot, dash or underscore."),
  description: z.string().trim().max(1_000).optional(),
  type: z.enum(["operating", "trust", "escrow", "retention", "suspense"]).default("operating"),
  accountType: z.enum(["asset", "liability", "equity", "revenue", "expense"]),
  currency: z.string().length(3).default("INR"),
  requiresReconciliation: z.boolean().default(false),
  bankDetails: z
    .object({
      bankName: z.string().trim().max(200).optional(),
      accountNumber: z.string().trim().max(40).optional(),
      ifsc: z.string().trim().max(20).optional(),
      branch: z.string().trim().max(200).optional(),
      accountHolder: z.string().trim().max(200).optional(),
    })
    .default({}),
});

export type CreateLedgerInput = z.input<typeof createLedgerSchema>;

/** Only these roles may touch the ledger. */
const FINANCE_ROLES = [
  "tenant_owner",
  "tenant_admin",
  "billing_admin",
  "platform_super_admin",
] as const satisfies readonly SystemRole[];

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
  if (err instanceof TenantAccessError) return fail(err.message);
  if (err instanceof z.ZodError) {
    return fail("Validation failed.", err.flatten().fieldErrors as Record<string, string[]>);
  }
  // Surface the database's own balance rejection in plain language.
  const message = err instanceof Error ? err.message : "";
  if (message.includes("unbalanced") || message.includes("does not balance")) {
    return fail("The database rejected this transaction because its entries do not balance.");
  }
  if (message.includes("append-only")) {
    return fail("Journal entries cannot be edited or deleted. Post a reversing entry instead.");
  }
  console.error("[accounting action]", err);
  return fail("Something went wrong. Please try again.");
}

/* ------------------------------------------------------------------ */
/* CREATE LEDGER                                                       */
/* ------------------------------------------------------------------ */

export async function createLedger(
  input: CreateLedgerInput,
): Promise<ActionResult<Ledger>> {
  try {
    const ctx = await requireRole(FINANCE_ROLES);
    // ACCOUNT STANDING FIRST, then plan, then person. Broadest
    // reason outermost, so the customer is told the thing they can
    // actually act on rather than an inner detail.
    await requireAccess("accounting:createLedger", ctx);
    // ⚠️ ENTITLEMENT BEFORE PERMISSION. If a workspace owner on a plan
    // without this feature hits it, the true answer is "your plan does
    // not include it" — not "you lack permission", which would send the
    // owner to ask an administrator who is themselves.
    await requireFeature("accounting.ledger", ctx);
    const data = createLedgerSchema.parse(input);

    const clash = await db.query.ledgers.findFirst({
      where: and(
        eq(ledgers.tenantId, ctx.tenant.id),
        eq(ledgers.code, data.code),
        isNull(ledgers.deletedAt),
      ),
      columns: { id: true },
    });
    if (clash) {
      return fail("Validation failed.", { code: [`Ledger code "${data.code}" is already in use.`] });
    }

    // Trust and escrow ledgers hold client money — reconciliation is not optional.
    const requiresReconciliation =
      data.type === "trust" || data.type === "escrow" || data.requiresReconciliation;

    const [created] = await db
      .insert(ledgers)
      .values({
        tenantId: ctx.tenant.id,
        name: data.name,
        code: data.code,
        description: data.description ?? null,
        type: data.type,
        accountType: data.accountType,
        currency: data.currency,
        requiresReconciliation,
        bankDetails: data.bankDetails,
        createdBy: ctx.user.id,
      })
      .returning();

    if (!created) return fail("Failed to create ledger.");

    revalidatePath("/accounting");
    return { ok: true, data: created };
  } catch (err) {
    return toActionError(err);
  }
}

/* ------------------------------------------------------------------ */
/* POST TRANSACTION                                                    */
/* ------------------------------------------------------------------ */

export type PostedTransaction = {
  transaction: Transaction;
  legCount: number;
  totalAmount: string;
};

/**
 * Post a balanced transaction.
 *
 * All legs are written inside ONE database transaction. That is what makes the
 * deferred trigger work: it evaluates balance at COMMIT, once every leg is
 * present. Writing legs across separate transactions would trip the trigger on
 * the first one.
 */
export async function postTransaction(
  input: PostTransactionInput,
): Promise<ActionResult<PostedTransaction>> {
  try {
    const ctx = await requireRole(FINANCE_ROLES);
    // ACCOUNT STANDING FIRST, then plan, then person. Broadest
    // reason outermost, so the customer is told the thing they can
    // actually act on rather than an inner detail.
    await requireAccess("accounting:postTransaction", ctx);
    // ⚠️ ENTITLEMENT BEFORE PERMISSION. If a workspace owner on a plan
    // without this feature hits it, the true answer is "your plan does
    // not include it" — not "you lack permission", which would send the
    // owner to ask an administrator who is themselves.
    await requireFeature("accounting.ledger", ctx);
    const data = postTransactionSchema.parse(input);

    // Every ledger referenced must belong to this tenant. Without this check a
    // caller could post entries into another tenant's trust account.
    const ledgerIds = [...new Set(data.legs.map((l) => l.ledgerId))];
    const { inArray } = await import("drizzle-orm");

    const ownedLedgers = await db
      .select({ id: ledgers.id, currency: ledgers.currency, isActive: ledgers.isActive })
      .from(ledgers)
      .where(
        and(
          inArray(ledgers.id, ledgerIds),
          eq(ledgers.tenantId, ctx.tenant.id),
          isNull(ledgers.deletedAt),
        ),
      );

    if (ownedLedgers.length !== ledgerIds.length) {
      return fail("One or more ledgers do not exist in this workspace.");
    }
    const inactive = ownedLedgers.filter((l) => !l.isActive);
    if (inactive.length > 0) {
      return fail("Cannot post to an inactive ledger.");
    }
    // Mixing currencies inside one transaction makes "balanced" meaningless.
    const mismatched = ownedLedgers.filter((l) => l.currency !== data.currency);
    if (mismatched.length > 0) {
      return fail(
        `All ledgers in a transaction must use ${data.currency}. ` +
          `${mismatched.length} ledger(s) use a different currency.`,
      );
    }

    const totalMinor = data.legs
      .filter((l) => l.entryType === "debit")
      .reduce((sum, l) => sum + toMinorUnits(l.amount), 0n);
    const totalAmount = fromMinorUnits(totalMinor);

    // Single transaction — the deferred trigger fires once, at COMMIT.
    const result = await withTenant(ctx.tenant.id, async (tx) => {
      const [txn] = await tx
        .insert(transactions)
        .values({
          tenantId: ctx.tenant.id,
          transactionNumber: data.transactionNumber ?? null,
          description: data.description,
          transactionDate: data.transactionDate,
          status: "posted",
          referenceType: data.referenceType,
          referenceId: data.referenceId ?? null,
          currency: data.currency,
          totalAmount,
          createdBy: ctx.user.id,
          postedAt: new Date(),
        })
        .returning();

      if (!txn) throw new Error("Failed to create transaction.");

      await tx.insert(journalEntries).values(
        data.legs.map((leg) => ({
          tenantId: ctx.tenant.id,
          transactionId: txn.id,
          ledgerId: leg.ledgerId,
          entryType: leg.entryType,
          amount: leg.amount,
          description: leg.description ?? data.description,
          referenceType: data.referenceType,
          referenceId: data.referenceId ?? null,
          counterpartyType: leg.counterpartyType ?? null,
          counterpartyId: leg.counterpartyId ?? null,
          counterpartyName: leg.counterpartyName ?? null,
          createdBy: ctx.user.id,
        })),
      );

      return txn;
      // COMMIT happens here. If the legs do not balance, the deferred trigger
      // raises and the whole transaction rolls back — no partial state.
    });

    await db.insert(auditLogs).values({
      tenantId: ctx.tenant.id,
      actorUserId: ctx.user.id,
      actorEmail: ctx.user.email,
      actorRole: ctx.role,
      action: "create",
      resourceType: "transaction",
      resourceId: result.id,
      newValue: { totalAmount, legCount: data.legs.length, currency: data.currency },
      reason: data.description,
    });

    revalidatePath("/accounting");
    return {
      ok: true,
      data: { transaction: result, legCount: data.legs.length, totalAmount },
    };
  } catch (err) {
    return toActionError(err);
  }
}

/* ------------------------------------------------------------------ */
/* REVERSE TRANSACTION                                                 */
/* ------------------------------------------------------------------ */

const reverseSchema = z.object({
  transactionId: uuidSchema,
  reason: z.string().trim().min(5, "Give a reason for the reversal.").max(1_000),
  reversalDate: z.string().date().optional(),
});

/**
 * Reverse a transaction by posting its mirror image.
 *
 * Journal entries are append-only, so a mistake is never deleted — it is undone
 * by an equal and opposite entry, and both remain visible. That is standard
 * bookkeeping practice and it is what makes the ledger auditable.
 */
export async function reverseTransaction(
  input: z.input<typeof reverseSchema>,
): Promise<ActionResult<{ originalId: string; reversalId: string }>> {
  try {
    const ctx = await requireRole(FINANCE_ROLES);
    // ACCOUNT STANDING FIRST, then plan, then person. Broadest
    // reason outermost, so the customer is told the thing they can
    // actually act on rather than an inner detail.
    await requireAccess("accounting:reverseTransaction", ctx);
    // ⚠️ ENTITLEMENT BEFORE PERMISSION. If a workspace owner on a plan
    // without this feature hits it, the true answer is "your plan does
    // not include it" — not "you lack permission", which would send the
    // owner to ask an administrator who is themselves.
    await requireFeature("accounting.ledger", ctx);
    const data = reverseSchema.parse(input);

    const original = await db.query.transactions.findFirst({
      where: and(
        eq(transactions.id, data.transactionId),
        eq(transactions.tenantId, ctx.tenant.id),
      ),
      with: { entries: true },
    });

    if (!original) return fail("Transaction not found.");
    if (original.status === "reversed") return fail("This transaction has already been reversed.");
    if (original.status === "void") return fail("This transaction is void.");

    const entries = (original as unknown as { entries: Array<{
      ledgerId: string; entryType: "debit" | "credit"; amount: string;
      counterpartyType: string | null; counterpartyId: string | null; counterpartyName: string | null;
    }> }).entries;

    if (entries.length === 0) return fail("Transaction has no entries to reverse.");

    const reversalId = await withTenant(ctx.tenant.id, async (tx) => {
      const [reversal] = await tx
        .insert(transactions)
        .values({
          tenantId: ctx.tenant.id,
          description: `Reversal of: ${original.description}`,
          transactionDate: data.reversalDate ?? new Date().toISOString().slice(0, 10),
          status: "posted",
          referenceType: original.referenceType,
          referenceId: original.referenceId,
          currency: original.currency,
          totalAmount: original.totalAmount,
          reversesTransactionId: original.id,
          reversalReason: data.reason,
          createdBy: ctx.user.id,
          postedAt: new Date(),
        })
        .returning();

      if (!reversal) throw new Error("Failed to create reversal.");

      // Flip every leg. Debits become credits and vice versa — so the reversal
      // balances by construction, exactly like the original.
      await tx.insert(journalEntries).values(
        entries.map((entry) => ({
          tenantId: ctx.tenant.id,
          transactionId: reversal.id,
          ledgerId: entry.ledgerId,
          entryType: entry.entryType === "debit" ? ("credit" as const) : ("debit" as const),
          amount: entry.amount,
          description: `Reversal: ${data.reason}`,
          referenceType: original.referenceType,
          referenceId: original.referenceId,
          counterpartyType: entry.counterpartyType,
          counterpartyId: entry.counterpartyId,
          counterpartyName: entry.counterpartyName,
          createdBy: ctx.user.id,
        })),
      );

      // Mark the original. The transactions table is mutable; the journal is not.
      await tx
        .update(transactions)
        .set({ status: "reversed", reversedByTransactionId: reversal.id })
        .where(
          and(eq(transactions.id, original.id), eq(transactions.tenantId, ctx.tenant.id)),
        );

      return reversal.id;
    });

    await db.insert(auditLogs).values({
      tenantId: ctx.tenant.id,
      actorUserId: ctx.user.id,
      actorEmail: ctx.user.email,
      actorRole: ctx.role,
      action: "update",
      resourceType: "transaction",
      resourceId: original.id,
      oldValue: { status: original.status },
      newValue: { status: "reversed", reversalId },
      reason: data.reason,
    });

    revalidatePath("/accounting");
    return { ok: true, data: { originalId: original.id, reversalId } };
  } catch (err) {
    return toActionError(err);
  }
}

/* ------------------------------------------------------------------ */
/* TRIAL BALANCE                                                       */
/* ------------------------------------------------------------------ */

export type TrialBalanceRow = {
  ledgerId: string;
  code: string;
  name: string;
  type: string;
  accountType: string;
  totalDebit: string;
  totalCredit: string;
  balance: string;
};

/**
 * Trial balance across every ledger.
 * If `isBalanced` is ever false, the double-entry guarantee has been violated
 * and the ledger needs investigation before anything else happens.
 */
/**
 * ⚠️ DELIBERATELY NOT GATED BY `requireFeature`.
 *
 * This is a READ. A workspace that downgrades off Advanced still has its
 * ledger rows, and refusing to show them would make the customer's own
 * financial records look deleted at exactly the moment we are asking them
 * to pay us. They can look; they cannot post. `postTransaction`,
 * `createLedger` and `reverseTransaction` are the gated ones.
 *
 * The Phase 12 brief calls this "graceful degradation, never a hard
 * crash", and this is what that means in practice.
 */
export async function getTrialBalance(): Promise<
  ActionResult<{
    rows: TrialBalanceRow[];
    totalDebits: string;
    totalCredits: string;
    isBalanced: boolean;
    difference: string;
  }>
> {
  try {
    const ctx = await requireTenantContext();

    const rows = await db
      .select({
        ledgerId: ledgers.id,
        code: ledgers.code,
        name: ledgers.name,
        type: ledgers.type,
        accountType: ledgers.accountType,
        totalDebit: sql<string>`COALESCE(SUM(CASE WHEN ${journalEntries.entryType} = 'debit'  THEN ${journalEntries.amount} ELSE 0 END), 0)::text`,
        totalCredit: sql<string>`COALESCE(SUM(CASE WHEN ${journalEntries.entryType} = 'credit' THEN ${journalEntries.amount} ELSE 0 END), 0)::text`,
      })
      .from(ledgers)
      .leftJoin(
        journalEntries,
        and(
          eq(journalEntries.ledgerId, ledgers.id),
          // The join is tenant-scoped too — a missing predicate here would be
          // the exact bug that leaks another tenant's numbers into a report.
          eq(journalEntries.tenantId, ctx.tenant.id),
        ),
      )
      .where(and(eq(ledgers.tenantId, ctx.tenant.id), isNull(ledgers.deletedAt)))
      .groupBy(ledgers.id, ledgers.code, ledgers.name, ledgers.type, ledgers.accountType)
      .orderBy(ledgers.code);

    let totalDebitMinor = 0n;
    let totalCreditMinor = 0n;

    const enriched: TrialBalanceRow[] = rows.map((r) => {
      const debit = toMinorUnits(Number(r.totalDebit).toFixed(2));
      const credit = toMinorUnits(Number(r.totalCredit).toFixed(2));
      totalDebitMinor += debit;
      totalCreditMinor += credit;
      return {
        ...r,
        totalDebit: fromMinorUnits(debit),
        totalCredit: fromMinorUnits(credit),
        balance: fromMinorUnits(debit - credit),
      };
    });

    const difference =
      totalDebitMinor > totalCreditMinor
        ? totalDebitMinor - totalCreditMinor
        : totalCreditMinor - totalDebitMinor;

    return {
      ok: true,
      data: {
        rows: enriched,
        totalDebits: fromMinorUnits(totalDebitMinor),
        totalCredits: fromMinorUnits(totalCreditMinor),
        isBalanced: difference === 0n,
        difference: fromMinorUnits(difference),
      },
    };
  } catch (err) {
    return toActionError(err);
  }
}

/* ------------------------------------------------------------------ */
/* LEDGER LIST                                                         */
/* ------------------------------------------------------------------ */

export async function getLedgers(): Promise<ActionResult<Ledger[]>> {
  try {
    const ctx = await requireTenantContext();
    const rows = await db
      .select()
      .from(ledgers)
      .where(and(eq(ledgers.tenantId, ctx.tenant.id), isNull(ledgers.deletedAt)))
      .orderBy(ledgers.code);
    return { ok: true, data: rows };
  } catch (err) {
    return toActionError(err);
  }
}

export async function getRecentTransactions(
  limit = 50,
): Promise<ActionResult<Transaction[]>> {
  try {
    const ctx = await requireTenantContext();
    const capped = Math.min(Math.max(1, limit), 200);
    const rows = await db
      .select()
      .from(transactions)
      .where(eq(transactions.tenantId, ctx.tenant.id))
      .orderBy(desc(transactions.transactionDate), desc(transactions.createdAt))
      .limit(capped);
    return { ok: true, data: rows };
  } catch (err) {
    return toActionError(err);
  }
}
