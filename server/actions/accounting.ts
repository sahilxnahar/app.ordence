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
import { and, eq, gte, inArray, isNull, lte, sql, desc } from "drizzle-orm";
import { db, withTenant } from "@/db";
import {
  ledgers,
  transactions,
  journalEntries,
  auditLogs,
  bankAccounts,
  salesPostingAccounts,
} from "@/db/schema";
import { requireRole, TenantAccessError } from "@/server/tenant-context";
import { requirePermission } from "@/server/audit";
import { PermissionDeniedError } from "@/lib/permissions";
import { requireFeature, FeatureLockedError } from "@/server/entitlements";
import { requireAccess, AccessRestrictedError } from "@/server/billing/access";
import type { ActionResult } from "@/lib/validators/crm";
import {
  postTransactionSchema,
  toMinorUnits,
  fromMinorUnits,
} from "@/lib/validators/accounting";
import type { PostTransactionInput } from "@/lib/validators/accounting";
import { formatMinorPlain, isKnownCurrency, parseMajorToMinor } from "@/lib/fx/currency";
import { resolveStatementPeriod, previousDay } from "@/lib/accounting/periods";
import type { StatementPeriodInput, StatementPeriod } from "@/lib/accounting/periods";
import {
  buildCashFlow,
  explainCashFlowFailure,
  type CashLedger,
  type LedgerMovement,
} from "@/lib/accounting/cash-flow";
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
  /**
   * ⭐ WAVE 9 — ADDED WITH THE READ GATES. Without this branch a
   * `manager` opening the trial balance would be told "Something went
   * wrong. Please try again." and would try again, forever. A refusal
   * that names itself is the difference between a support ticket and a
   * conversation with their administrator.
   */
  if (err instanceof PermissionDeniedError) return fail(err.message);
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

    const clash = await withTenant(ctx.tenant.id, (tx) =>
      tx.query.ledgers.findFirst({
        where: and(
          eq(ledgers.tenantId, ctx.tenant.id),
          eq(ledgers.code, data.code),
          isNull(ledgers.deletedAt),
        ),
        columns: { id: true },
      })
    );
    if (clash) {
      return fail("Validation failed.", { code: [`Ledger code "${data.code}" is already in use.`] });
    }

    // Trust and escrow ledgers hold client money — reconciliation is not optional.
    const requiresReconciliation =
      data.type === "trust" || data.type === "escrow" || data.requiresReconciliation;

    const [created] = await withTenant(ctx.tenant.id, (tx) =>
      tx
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
        .returning()
    );

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

    const ownedLedgers = await withTenant(ctx.tenant.id, (tx) =>
      tx
        .select({ id: ledgers.id, currency: ledgers.currency, isActive: ledgers.isActive })
        .from(ledgers)
        .where(
          and(
            inArray(ledgers.id, ledgerIds),
            eq(ledgers.tenantId, ctx.tenant.id),
            isNull(ledgers.deletedAt),
          ),
        )
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
          /**
           * ⭐ PARSED WITH THE TRANSACTION'S OWN CURRENCY. Batch 0108.
           * `parseMajorToMinor("1.234", "KWD")` is 1234n; the same string
           * is REFUSED for INR, by name. The schema has already run this
           * exact parse to check the legs balance, so it cannot throw here.
           */
          amountMinor: parseMajorToMinor(leg.amount, data.currency),
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

    await withTenant(ctx.tenant.id, (tx) =>
      tx.insert(auditLogs).values({
        tenantId: ctx.tenant.id,
        actorUserId: ctx.user.id,
        actorEmail: ctx.user.email,
        actorRole: ctx.role,
        action: "create",
        resourceType: "transaction",
        resourceId: result.id,
        newValue: { totalAmount, legCount: data.legs.length, currency: data.currency },
        reason: data.description,
      })
    );

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

    const original = await withTenant(ctx.tenant.id, (tx) =>
      tx.query.transactions.findFirst({
        where: and(
          eq(transactions.id, data.transactionId),
          eq(transactions.tenantId, ctx.tenant.id),
        ),
        with: { entries: true },
      })
    );

    if (!original) return fail("Transaction not found.");
    if (original.status === "reversed") return fail("This transaction has already been reversed.");
    if (original.status === "void") return fail("This transaction is void.");

    const entries = (original as unknown as { entries: Array<{
      ledgerId: string; entryType: "debit" | "credit";
      /** ⭐ The authority. Batch 0108. Nullable only on unscaled history. */
      amountMinor: bigint | null;
      counterpartyType: string | null; counterpartyId: string | null; counterpartyName: string | null;
    }> }).entries;

    if (entries.length === 0) return fail("Transaction has no entries to reverse.");

    /**
     * 🔴 REFUSED, NOT ROUNDED. Batch 0108. A leg the migration could not
     * scale has no integer to negate, and reversing it from the
     * two-decimal mirror would leave a residue in a real account. The
     * remedy is to scale the leg, not to approximate the reversal.
     */
    const unscaled = entries.filter((e) => e.amountMinor === null).length;
    if (unscaled > 0) {
      return fail(
        `Cannot reverse: ${unscaled} of this transaction's legs have no amount in minor ` +
          `units. Run the census in SQL-FILES/0108 to see which currency is unscaled.`,
      );
    }

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
          /**
           * ⭐ THE ORIGINAL'S INTEGER, COPIED. Batch 0108.
           *
           * ⚠️ NOT RE-PARSED FROM `amount`. A reversal must be the exact
           * negation of what was posted, and re-deriving it from the
           * two-decimal mirror would leave a dinar reversal short by up to
           * 9 fils per leg — a residue in an account somebody eventually
           * has to explain.
           */
          amountMinor: entry.amountMinor as bigint,
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

    await withTenant(ctx.tenant.id, (tx) =>
      tx.insert(auditLogs).values({
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
      })
    );

    revalidatePath("/accounting");
    return { ok: true, data: { originalId: original.id, reversalId } };
  } catch (err) {
    return toActionError(err);
  }
}

/* ------------------------------------------------------------------ */
/* STATEMENTS — TRIAL BALANCE, P&L, BALANCE SHEET                      */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 ALL THREE STATEMENTS WERE SINCE INCEPTION, WITH NO WAY TO SAY OTHERWISE
 * ══════════════════════════════════════════════════════════════════════
 * `getTrialBalance()` took no arguments. The P&L and balance sheet were
 * both derived from it, so a customer in year two could not produce a
 * financial-year statement at all — the parameter did not exist anywhere
 * in the path. See `lib/accounting/periods.ts` for why the default is
 * now the current financial year rather than all of time.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 AND THE TWO KINDS OF STATEMENT NEED TWO DIFFERENT WINDOWS
 * ══════════════════════════════════════════════════════════════════════
 * The trial balance and the P&L measure MOVEMENT between two dates.
 * The balance sheet measures a POSITION at one date, and that position
 * accumulates every entry since the business began.
 *
 * So `ledgerBalances` takes `from: string | null`, and `null` means
 * "from inception". The balance sheet is the caller that passes null.
 * Handing the balance sheet a from-date filters out the opening bank
 * balance, the fixed assets, the capital and the loans — every asset the
 * business owned before the period starts disappears, and the statement
 * STILL BALANCES while it does so, because a filtered set of whole
 * transactions always balances. Nothing shouts. It just reports a
 * company that owns nothing.
 */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴🔴 WHICH TRANSACTIONS BELONG IN A FINANCIAL STATEMENT
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THIS CHANGES NUMBERS THAT WERE ALREADY ON SCREEN. Read this before
 * touching it.
 *
 * Until now NOTHING anywhere in the statement path looked at
 * `transactions.status`. The trial balance, the profit & loss and the
 * balance sheet summed every journal entry whose transaction fell in the
 * date window, whatever state that transaction was in. `db/schema/
 * accounting.ts` defines four states — `pending`, `posted`, `reversed`,
 * `void` — and three of them were being treated as if they were the
 * fourth. A voided transaction appeared in a customer's turnover.
 *
 * The statements now include `posted` and `reversed`, and nothing else.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐⭐ WHY `reversed` IS IN, AND WHY "POSTED ONLY" IS THE TRAP
 * ══════════════════════════════════════════════════════════════════════
 * "Posted only" is the obvious filter, it is what every other
 * single-transaction lookup in this codebase uses, and on a statement it
 * is WORSE THAN NO FILTER AT ALL.
 *
 * Look at what `reverseTransaction` above actually writes. It inserts a
 * SECOND transaction — the mirror image, every leg flipped — with status
 * `posted`, and it then marks the ORIGINAL as `reversed`. So a
 * reversal pair is one `reversed` row and one `posted` row. Both sets of
 * legs are real, both are in `journal_entries`, and the journal is
 * append-only precisely so that both stay visible forever. That is
 * standard bookkeeping: a mistake is never deleted, it is undone by an
 * equal and opposite entry, and the record shows both.
 *
 * 🔴 FILTER TO `posted` AND YOU KEEP THE CORRECTION AND DROP THE ERROR.
 *
 * Suppose ₹5,00,000 of revenue was posted to the wrong customer and
 * reversed. Under "posted only" the statement contains the reversal —
 * which DEBITS revenue ₹5,00,000 — and not the original credit. Turnover
 * is now ₹5,00,000 LOWER than it ever was, in a statement that still
 * balances perfectly, because the reversal is itself a balanced
 * transaction and any set of whole transactions balances. Nothing on the
 * page contradicts it. The customer's revenue account shows a negative
 * entry they cannot explain and an auditor traces it to a correction of
 * an error that, in the books as presented, never happened.
 *
 * ⚠️ THE RULE, STATED SO IT SURVIVES THE NEXT EDIT: A REVERSAL AND THE
 * ENTRY IT REVERSES ARE ONE FACT IN TWO ROWS. BOTH ARE IN THE STATEMENT
 * OR NEITHER IS. Including both nets them to zero, which is the true
 * economic answer and is also what the ledger's own cached balances and
 * the database trigger already assume.
 *
 * (They net to zero within the pair. They do NOT necessarily net to zero
 * within a PERIOD — a January entry reversed in April correctly leaves
 * January overstated and April understated, because that is what
 * happened and that is what the January statement already filed against
 * said. Dating the reversal is a bookkeeping decision, not ours.)
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY `void` AND `pending` ARE OUT
 * ══════════════════════════════════════════════════════════════════════
 * `void` is the state for a transaction that should never have existed —
 * `reverseTransaction` refuses to touch one, and it has no compensating
 * entry anywhere. Its legs are in `journal_entries` because that table is
 * append-only, not because they are facts. Counting them puts money in a
 * P&L that the business itself has said never moved.
 *
 * `pending` is a transaction that has not been posted — the draft state.
 * Nothing in the product writes it today (every insert path sets
 * `posted`), so excluding it changes no number in any existing workspace.
 * It is excluded anyway, because the day something does write it, the
 * failure would be a half-entered journal quietly appearing in a filed
 * P&L, and that day is a bad day to discover the filter was permissive.
 *
 * ⚠️ THE FILTER LIVES IN `ledgerBalances` AND NOWHERE ELSE, so the trial
 * balance, the P&L, the balance sheet and the cash flow statement cannot
 * disagree about what a fact is. Four statements built from four
 * different definitions of "in the books" is how a set of accounts stops
 * cross-footing.
 */
const STATEMENT_TRANSACTION_STATUSES = ["posted", "reversed"] as const;

export type TrialBalanceRow = {
  ledgerId: string;
  code: string;
  name: string;
  type: string;
  accountType: string;
  /**
   * ⭐⭐ BATCH 0101 — THE LEDGER'S OWN CURRENCY, ON EVERY ROW.
   *
   * 🔴 IT WAS NOT HERE BEFORE, AND THAT WAS THE BUG. `ledgers.currency`
   * has existed since Phase 12 and `ledgerBalances` did not select it, so
   * a trial balance ADDED a USD bank ledger's movement to an INR sales
   * ledger's movement, footed perfectly, and printed a total that is a
   * quantity of nothing. Nothing complained, because a sum of a numeric
   * column always succeeds.
   *
   * ⚠️ NOTHING CHANGES FOR AN INR-ONLY WORKSPACE, which is every workspace
   * today: `ledgers.currency` defaults to 'INR', so `currencies` below has
   * one member and `currencyMixed` is false.
   */
  currency: string;
  totalDebit: string;
  totalCredit: string;
  /** Debit-positive. Inverted for presentation exactly once, in the UI. */
  balance: string;
};

export type { StatementPeriodInput, StatementPeriod };

type LedgerBalance = TrialBalanceRow & {
  debitMinor: bigint;
  creditMinor: bigint;
};

/**
 * Ledger totals over a window. `from === null` means since inception.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THE DATE PREDICATE IS IN THE JOIN *AND* IN THE CASE
 * ══════════════════════════════════════════════════════════════════════
 * Both halves are load-bearing and each one alone is a different bug.
 *
 *   • Put the date in the WHERE clause and the LEFT JOIN collapses into
 *     an inner join: every ledger with no activity in the period drops
 *     off the statement entirely. A dormant bank account vanishes from
 *     the balance sheet rather than showing its balance.
 *
 *   • Put it only in the ON clause and it filters NOTHING. The SUM reads
 *     `journal_entries.amount` and `journal_entries.entry_type`; those
 *     columns are still populated for an out-of-period entry, because
 *     the journal-entry join matched even though the transaction join
 *     did not. The out-of-range money is counted anyway, silently.
 *
 * So: the ON clause narrows the scan (and lets Postgres use
 * `transactions_tenant_date_idx`), and `transactions.id IS NOT NULL`
 * inside the CASE is what actually excludes the amount.
 *
 * ⚠️ THE DATE IS `transactions.transaction_date`, NOT `created_at`.
 * A back-dated journal posted in June for a March event belongs in
 * March's P&L. Filtering on the row's insert timestamp would put it in
 * June and would move numbers in a period the customer has already
 * filed against.
 */
async function ledgerBalances(
  tenantId: string,
  window: { from: string | null; to: string },
): Promise<LedgerBalance[]> {
  const inPeriod = and(
    eq(transactions.id, journalEntries.transactionId),
    // Tenant-scoped on every join. A missing predicate here is the exact
    // bug that leaks another tenant's numbers into a financial statement.
    eq(transactions.tenantId, tenantId),
    /**
     * 🔴 THE STATUS FILTER. See `STATEMENT_TRANSACTION_STATUSES` above for
     * the full reasoning — in short, `posted` AND `reversed`, because a
     * reversal is `posted` while the entry it reverses is `reversed`, and
     * keeping one without the other leaves a correction in the books with
     * nothing to correct.
     *
     * ⚠️ IT BELONGS IN THIS `and(...)`, WITH THE DATE PREDICATE, AND NOT
     * IN THE `.where()`. The ledger table is LEFT JOINed so that a dormant
     * account still shows on the balance sheet; a predicate on the
     * right-hand table in the WHERE clause collapses that into an inner
     * join and every ledger with no in-period activity disappears. The
     * `transactions.id IS NOT NULL` guard inside the CASE below is what
     * actually excludes an out-of-scope amount from the sum.
     */
    inArray(transactions.status, [...STATEMENT_TRANSACTION_STATUSES]),
    lte(transactions.transactionDate, window.to),
    ...(window.from === null ? [] : [gte(transactions.transactionDate, window.from)]),
  );

  const rows = await withTenant(tenantId, (tx) =>
    tx
      .select({
        ledgerId: ledgers.id,
        code: ledgers.code,
        name: ledgers.name,
        type: ledgers.type,
        accountType: ledgers.accountType,
        // ⭐ 0101. Selected so the aggregate can be told whether it spans
        // currencies. See the comment on `TrialBalanceRow.currency`.
        currency: ledgers.currency,
        /**
         * ⭐ SUMMED IN MINOR UNITS. Batch 0108.
         *
         * ⚠️ THIS USED TO SUM `journal_entries.amount` and hand the decimal
         * string to `toMinorUnits()`, whose arithmetic is
         * `BigInt(whole) * 100n + BigInt(fraction)` and whose regex is
         * `\d{1,15}(\.\d{1,2})?` — a hardcoded two decimal places, which
         * REJECTS a three-decimal dinar outright rather than rounding it.
         * The trial balance of a Kuwaiti book did not merely come out
         * wrong; it threw.
         */
        totalDebitMinor: sql<string>`COALESCE(SUM(CASE WHEN ${transactions.id} IS NOT NULL AND ${journalEntries.entryType} = 'debit'  THEN ${journalEntries.amountMinor} ELSE 0 END), 0)::text`,
        totalCreditMinor: sql<string>`COALESCE(SUM(CASE WHEN ${transactions.id} IS NOT NULL AND ${journalEntries.entryType} = 'credit' THEN ${journalEntries.amountMinor} ELSE 0 END), 0)::text`,
        /**
         * ⚠️ COUNTED, NOT IGNORED. `SUM()` skips NULLs, so a leg 0108 could
         * not scale would quietly shrink this total instead of failing it.
         * A trial balance that is short by a real amount and still foots is
         * the single most dangerous output this file can produce.
         */
        unscaledLegs: sql<number>`COUNT(*) FILTER (WHERE ${transactions.id} IS NOT NULL AND ${journalEntries.amountMinor} IS NULL)::int`,
      })
      .from(ledgers)
      .leftJoin(
        journalEntries,
        and(
          eq(journalEntries.ledgerId, ledgers.id),
          eq(journalEntries.tenantId, tenantId),
        ),
      )
      .leftJoin(transactions, inPeriod)
      .where(and(eq(ledgers.tenantId, tenantId), isNull(ledgers.deletedAt)))
      .groupBy(
        ledgers.id,
        ledgers.code,
        ledgers.name,
        ledgers.type,
        ledgers.accountType,
        ledgers.currency,
      )
      .orderBy(ledgers.code)
  );

  return rows.map((r) => {
    /**
     * ⚠️ THE DECIMAL STRING GOES STRAIGHT TO BIGINT PAISE.
     * This used to be `toMinorUnits(Number(r.totalDebit).toFixed(2))` —
     * a round trip through an IEEE-754 double. Postgres already returns
     * an exact 2-decimal string; putting a float in the middle of it can
     * only lose information, and money is never a float here.
     */
    if (r.unscaledLegs > 0) {
      throw new Error(
        `${r.unscaledLegs} journal line(s) in ledger ${r.code} have no amount in minor ` +
          `units, so this trial balance cannot be trusted. Run the census in ` +
          `SQL-FILES/0108 to see which currency is unscaled. Nothing has been computed.`,
      );
    }

    const debitMinor = BigInt(r.totalDebitMinor);
    const creditMinor = BigInt(r.totalCreditMinor);

    /**
     * ⭐ FORMATTED WITH THE LEDGER'S OWN EXPONENT. Batch 0108.
     *
     * ⚠️ THIS WAS `fromMinorUnits()`, which divides by a hardcoded 100n.
     * It printed a Kuwaiti dinar balance of 1234 fils as "12.34" — a
     * figure ten times too small, on the report an accountant checks
     * before signing anything. `formatMinorPlain` reads the exponent per
     * currency: "1.234" for KWD, "1234" for JPY, "12.34" for INR.
     *
     * ⚠️ AN UNRECOGNISED CODE FALLS BACK TO THE RAW INTEGER RATHER THAN
     * GUESSING TWO DECIMALS. `ledgers.currency` is a free varchar(3) with
     * a default and nothing has ever validated it, so this cannot throw on
     * a report; but a wrong number of decimals is a wrong number, and an
     * unpunctuated integer is visibly odd rather than quietly wrong.
     */
    const show = (minor: bigint): string =>
      isKnownCurrency(r.currency) ? formatMinorPlain(minor, r.currency) : minor.toString();

    const { unscaledLegs: _unscaled, totalDebitMinor: _d, totalCreditMinor: _c, ...rest } = r;

    return {
      ...rest,
      debitMinor,
      creditMinor,
      totalDebit: show(debitMinor),
      totalCredit: show(creditMinor),
      balance: show(debitMinor - creditMinor),
    };
  });
}

/** Strip the bigint working columns before the data crosses to the client. */
function toRows(list: readonly LedgerBalance[]): TrialBalanceRow[] {
  return list.map(({ debitMinor: _d, creditMinor: _c, ...row }) => row);
}

const PL_TYPES = new Set(["revenue", "expense"]);

/**
 * ⭐⭐⭐ BATCH 0101 — IS THIS STATEMENT A QUANTITY OF ANYTHING?
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 A TRIAL BALANCE THAT SPANS CURRENCIES FOOTS AND MEANS NOTHING
 * ══════════════════════════════════════════════════════════════════════
 * `postTransaction` already refuses to mix currencies WITHIN one journal
 * — that check has been the only currency logic in the product. It says
 * nothing about mixing them ACROSS journals, which is what a statement
 * does: a USD journal and an INR journal are each internally balanced, and
 * summing both produces a total that balances to the paisa and is a
 * quantity of nothing.
 *
 * ⚠️ THE CORRECT ANSWER UNDER AS 11 IS THAT THE BOOKS ARE KEPT IN THE
 * FUNCTIONAL CURRENCY and a foreign-currency ledger holds the FUNCTIONAL
 * amounts, with the foreign amount as memo. So a ledger whose `currency`
 * differs from the functional currency is a configuration that Ordence
 * cannot yet honour end to end — see the batch report — and the statement
 * SAYS SO rather than quietly adding it up.
 *
 * ⭐ `isBalanced` KEEPS ITS ARITHMETIC MEANING. Overloading it would break
 * the period-close dialog, which reads it to decide whether the books
 * foot. The mixing is reported separately, so a reader gets both facts.
 */
function statementCurrencyBasis(list: readonly LedgerBalance[]): {
  currencies: string[];
  currencyMixed: boolean;
  currencyWarning: string | null;
} {
  /**
   * ⚠️ ONLY LEDGERS WITH MOVEMENT COUNT. A dormant USD account with no
   * entries in the period contributes nothing to the totals, and warning
   * about it would train people to ignore the warning.
   */
  const withMovement = list.filter((r) => r.debitMinor !== 0n || r.creditMinor !== 0n);
  const currencies = [...new Set(withMovement.map((r) => r.currency))].sort();

  if (currencies.length <= 1) {
    return { currencies, currencyMixed: false, currencyWarning: null };
  }
  const offenders = withMovement
    .filter((r) => r.currency !== currencies[0])
    .map((r) => `${r.code} (${r.currency})`)
    .slice(0, 5);
  return {
    currencies,
    currencyMixed: true,
    currencyWarning:
      `⚠️ These totals add ${currencies.join(" and ")} together, so they are not a quantity of ` +
      `any one currency. Ledgers in more than one currency have movement in this period ` +
      `(${offenders.join(", ")}${withMovement.length > 5 ? ", …" : ""}). Under AS 11 the books ` +
      `are kept in the functional currency and a foreign-currency account holds its functional ` +
      `equivalent; until these ledgers are restated, read the figures per ledger and not as a ` +
      `total.`,
  };
}

/**
 * Revenue less expenses over whatever set of rows is handed in, in the
 * reader's sign: POSITIVE IS A PROFIT.
 *
 * ⚠️ Derived from debit/credit totals rather than from `balance`, so the
 * one place a sign is flipped for presentation stays in the UI. Revenue
 * is credit-positive and expenses are debit-positive; the net of the two
 * is simply credits minus debits across both.
 */
function netResultMinor(list: readonly LedgerBalance[]): bigint {
  return list
    .filter((r) => PL_TYPES.has(r.accountType))
    .reduce((acc, r) => acc + r.creditMinor - r.debitMinor, 0n);
}

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
 *
 * ⚠️ AN AUTHENTICATION GUARD IS STILL NOT OPTIONAL. Every `"use server"`
 * export is a URL the browser can POST to. Without one this is an
 * unauthenticated endpoint that returns a company's complete financial
 * position. The same applies to `getProfitAndLoss` and `getBalanceSheet`
 * below.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WAVE 9 — AND `requireTenantContext()` ALONE WAS NOT ENOUGH
 * ══════════════════════════════════════════════════════════════════════
 * The sentence above considered ONE attacker: somebody with no session
 * at all. It did not consider the one the role model exists for —
 * somebody with a perfectly good session and the wrong role.
 *
 * `ledgers:read` and `transactions:read` are held by `billing_admin`,
 * `read_only`, and the three wildcard roles. `manager` and `member` do
 * NOT hold either, and that is a deliberate line: accounting is a
 * finance function, and a sales manager is not in it.
 *
 * Neither key was checked anywhere. So every member of every workspace
 * could read the trial balance, the P&L, the balance sheet, the cash
 * flow statement, the chart of accounts and the last two hundred
 * transactions — the complete financial position the note above is about
 * — while the role screen told the owner they could not.
 *
 * ⚠️ THIS CHANGES BEHAVIOUR FOR `manager` AND `member`, and it is the
 * only change in wave 9 that takes something away from an existing user.
 * The alternative was to grant those two roles `ledgers:read`, which
 * would have made the code right by rewriting the customer's security
 * model to match it. When the model and the code disagree about who may
 * see a general ledger, the model wins.
 *
 * ⚠️ `ledgers:read` AND NOT `reports:trial_balance` FOR THE STATEMENTS.
 * `read_only` holds the first and not the second, and an auditor-shaped
 * role that cannot open a balance sheet is not read-only, it is blind.
 * `reports:trial_balance` gates the report EXPORT, which is a
 * disclosure, and that distinction is why both keys exist.
 */
export async function getTrialBalance(input?: StatementPeriodInput): Promise<
  ActionResult<{
    period: StatementPeriod;
    rows: TrialBalanceRow[];
    totalDebits: string;
    totalCredits: string;
    isBalanced: boolean;
    difference: string;
    /**
     * ⭐ 0101. Every currency with movement in the period. One member on
     * every workspace today; more than one means `totalDebits` and
     * `totalCredits` below are not a quantity of anything.
     */
    currencies: string[];
    currencyMixed: boolean;
    /** 🔴 The sentence a screen MUST print when `currencyMixed` is true. */
    currencyWarning: string | null;
  }>
> {
  try {
    const ctx = await requirePermission("ledgers:read");
    const period = resolveStatementPeriod(input);

    // Movement between two dates — a trial balance for a period, which is
    // what a close or a review is run against.
    const balances = await ledgerBalances(ctx.tenant.id, {
      from: period.from,
      to: period.to,
    });

    let totalDebitMinor = 0n;
    let totalCreditMinor = 0n;
    for (const r of balances) {
      totalDebitMinor += r.debitMinor;
      totalCreditMinor += r.creditMinor;
    }

    const difference =
      totalDebitMinor > totalCreditMinor
        ? totalDebitMinor - totalCreditMinor
        : totalCreditMinor - totalDebitMinor;

    const basis = statementCurrencyBasis(balances);

    return {
      ok: true,
      data: {
        period,
        rows: toRows(balances),
        totalDebits: fromMinorUnits(totalDebitMinor),
        totalCredits: fromMinorUnits(totalCreditMinor),
        isBalanced: difference === 0n,
        difference: fromMinorUnits(difference),
        ...basis,
      },
    };
  } catch (err) {
    return toActionError(err);
  }
}

/**
 * ⭐ PROFIT & LOSS FOR A PERIOD.
 *
 * Revenue and expense ledgers only, and only the movement between the
 * two dates. Asset, liability and equity ledgers are excluded here
 * rather than filtered in the UI — a P&L that carries the balance sheet
 * accounts around with it is one careless `.map()` away from adding a
 * bank balance to turnover.
 */
export async function getProfitAndLoss(input?: StatementPeriodInput): Promise<
  ActionResult<{
    period: StatementPeriod;
    rows: TrialBalanceRow[];
    /** Revenue less expenses for the period. Positive is a profit. */
    netResult: string;
    /** ⭐ 0101 — see `getTrialBalance`. `netResult` is only a quantity of
     *  something when `currencyMixed` is false. */
    currencies: string[];
    currencyMixed: boolean;
    currencyWarning: string | null;
  }>
> {
  try {
    const ctx = await requirePermission("ledgers:read");
    const period = resolveStatementPeriod(input);

    const balances = await ledgerBalances(ctx.tenant.id, {
      from: period.from,
      to: period.to,
    });
    const pl = balances.filter((r) => PL_TYPES.has(r.accountType));

    return {
      ok: true,
      data: {
        period,
        rows: toRows(pl),
        netResult: fromMinorUnits(netResultMinor(pl)),
        // ⚠️ MEASURED ON THE P&L ROWS ONLY. A dollar bank account does not
        // make the profit figure meaningless; a dollar SALES ledger does.
        ...statementCurrencyBasis(pl),
      },
    };
  } catch (err) {
    return toActionError(err);
  }
}

/**
 * ⭐⭐ BALANCE SHEET AS AT A DATE.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THERE IS NO FROM-DATE HERE AND THERE MUST NEVER BE ONE
 * ══════════════════════════════════════════════════════════════════════
 * `input` is a period only so that callers can hand it the same object
 * they hand the P&L. The ONLY field read from it is `asAt` (which is the
 * period's to-date). `from` is passed as `null` to `ledgerBalances`,
 * meaning "since inception", and that is the whole point:
 *
 *   A balance sheet is a photograph, not a film. The bank balance on
 *   31 March is the sum of every receipt and payment ever made, not the
 *   ones made since 1 April. Filter by `from` and the opening position
 *   disappears — cash, stock, fixed assets, share capital, loans — and
 *   the statement still balances at a smaller, wrong number.
 *
 * ⚠️ `retainedResultToDate` IS WHY THE THING STILL ADDS UP.
 * Assets = Liabilities + Equity + (Revenue − Expenses), where that last
 * term is measured over the SAME window as the rest of the statement,
 * i.e. since inception. The P&L above reports only the current period's
 * slice of it. The difference between the two is last year's profit —
 * retained earnings brought forward — and the UI shows it as its own
 * line. Without it, a customer in year two opens the balance sheet and
 * is told, in red, that their accounts do not balance.
 */
export async function getBalanceSheet(input?: StatementPeriodInput): Promise<
  ActionResult<{
    period: StatementPeriod;
    /** The single date this position is stated at. */
    asAt: string;
    /** Asset, liability and equity ledgers, cumulative to `asAt`. */
    rows: TrialBalanceRow[];
    /** Revenue less expenses from inception to `asAt`. Positive is a profit. */
    retainedResultToDate: string;
    /** ⭐ 0101 — see `getTrialBalance`. */
    currencies: string[];
    currencyMixed: boolean;
    currencyWarning: string | null;
  }>
> {
  try {
    const ctx = await requirePermission("ledgers:read");
    const period = resolveStatementPeriod(input);

    const balances = await ledgerBalances(ctx.tenant.id, {
      // 🔴 null, NOT period.from. See the note above. Changing this to
      // `period.from` makes every asset a customer owned before the
      // period start silently disappear.
      from: null,
      to: period.asAt,
    });

    return {
      ok: true,
      data: {
        period,
        asAt: period.asAt,
        rows: toRows(balances.filter((r) => !PL_TYPES.has(r.accountType))),
        retainedResultToDate: fromMinorUnits(netResultMinor(balances)),
        // ⚠️ MEASURED OVER EVERY LEDGER, not only the balance-sheet ones:
        // `retainedResultToDate` is folded from the P&L accounts, so a
        // foreign-currency revenue ledger makes THIS statement wrong too.
        ...statementCurrencyBasis(balances),
      },
    };
  } catch (err) {
    return toActionError(err);
  }
}

/* ------------------------------------------------------------------ */
/* ⭐⭐⭐ CASH FLOW STATEMENT — INDIRECT METHOD — Batch 65               */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ THE ARITHMETIC IS NOT IN THIS FILE. `lib/accounting/cash-flow.ts`
 * decides every rupee and is pure; this function loads rows, identifies
 * which ledgers hold cash, and hands both over. The split follows
 * `server/payroll/run.ts`: a cash flow statement is exactly the kind of
 * thing somebody checks by hand with a calculator and a reason to care,
 * and arithmetic that can only be exercised by standing up Postgres gets
 * tested once and then trusted forever.
 */

/** One line of the statement, as it crosses to the client. */
export type CashFlowLineRow = {
  ledgerId: string;
  code: string;
  name: string;
  type: string;
  accountType: string;
  /** Effect on cash as a 2-decimal string. POSITIVE IS CASH IN. */
  cashEffect: string;
};

export type CashFlowResult = {
  period: StatementPeriod;
  /** The date the opening balance is stated at — the day before `period.from`. */
  openingAsAt: string;
  /** The date the closing balance is stated at. Equal to `period.asAt`. */
  asAt: string;

  /** Profit for the period. Positive is a profit. */
  netResult: string;
  assetMovements: CashFlowLineRow[];
  assetMovementTotal: string;
  fundingMovements: CashFlowLineRow[];
  fundingMovementTotal: string;
  netMovement: string;

  openingCash: string;
  /** Derived: opening plus the movement built up above. */
  computedClosingCash: string;
  /** The fact: the cash and bank ledgers' own closing balance. */
  actualClosingCash: string;
  /** computed − actual. Zero, or the statement is wrong. */
  discrepancy: string;

  /**
   * 🔴 FALSE MEANS DO NOT RENDER A SINGLE FIGURE FROM THIS OBJECT.
   * Render `failureReasons` instead. See the header of
   * `lib/accounting/cash-flow.ts`.
   */
  usable: boolean;
  reconciles: boolean;

  /** Which ledgers were treated as cash, and the structural reason. */
  cashLedgers: Array<{ ledgerId: string; code: string; name: string; source: string }>;
  /** Empty exactly when `usable` is true. */
  failureReasons: string[];
};

/**
 * ⭐⭐ CASH AND BANK LEDGERS, FROM STRUCTURE AND NEVER FROM A NAME.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THERE IS NO `is_bank_account` FLAG ON `ledgers`. THERE ARE TWO
 *    RELATIONSHIPS, AND THEY ARE BOTH DATA THE TENANT DECLARED.
 * ══════════════════════════════════════════════════════════════════════
 *   ① `bank_accounts.ledger_id` — the strongest signal in the system.
 *      `db/schema/banking.ts` exists to record that a chart-of-accounts
 *      line corresponds to a real account with a real statement, and it
 *      enforces one bank account per ledger.
 *
 *   ② `sales_posting_accounts` with role `bank` — the tenant's mapped
 *      "Bank / Cash" account, described in `lib/accounting/sales-posting.ts`
 *      as "where customer receipts land". This is how CASH IN HAND is
 *      identified for a tenant who has no `bank_accounts` row for it.
 *
 * ⚠️ NOT `code LIKE '1%'`, NOT `name ILIKE '%bank%'`, NOT
 * `bank_details <> '{}'`. `db/schema/accounting.ts` already settled this
 * argument for the posting-role table: "A LEDGER CANNOT BE GUESSED FROM
 * ITS NAME OR ITS CODE. Every tenant builds their own chart of accounts."
 * A name match here fails silently — a missed cash ledger keeps the
 * statement reconciling and simply reports less money than the business
 * has, which is the one error nobody double-checks.
 *
 * ⚠️ INACTIVE BANK ACCOUNTS ARE INCLUDED. `is_active` says the account
 * is not to be used going forward; it says nothing about whether it held
 * money during the period being reported. Excluding it would drop a real
 * balance out of a historical statement.
 */
async function cashLedgersFor(tenantId: string): Promise<CashLedger[]> {
  const [linked, mapped] = await Promise.all([
    withTenant(tenantId, (tx) =>
      tx
        .select({ ledgerId: bankAccounts.ledgerId, label: bankAccounts.label })
        .from(bankAccounts)
        .where(eq(bankAccounts.tenantId, tenantId)),
    ),
    withTenant(tenantId, (tx) =>
      tx
        .select({ ledgerId: salesPostingAccounts.ledgerId })
        .from(salesPostingAccounts)
        .where(
          and(
            eq(salesPostingAccounts.tenantId, tenantId),
            eq(salesPostingAccounts.role, "bank"),
          ),
        ),
    ),
  ]);

  // Code and name are filled in from the chart of accounts by the caller,
  // which already has it loaded. A row that cannot be filled in is a
  // deleted ledger, and `buildCashFlow` reports that rather than hiding it.
  return [
    ...linked.map((row) => ({
      ledgerId: row.ledgerId,
      code: "",
      name: row.label,
      source: "bank_account" as const,
    })),
    ...mapped.map((row) => ({
      ledgerId: row.ledgerId,
      code: "",
      name: "Bank / Cash (posting role)",
      source: "posting_role" as const,
    })),
  ];
}

/**
 * ⭐⭐⭐ THE CASH FLOW STATEMENT FOR A PERIOD.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THREE QUERIES, AND EACH ONE COVERS A DIFFERENT SPAN OF TIME
 * ══════════════════════════════════════════════════════════════════════
 * This is the part that is easy to get wrong, so it is spelled out:
 *
 *   MOVEMENT   [from, to]        — every ledger's activity IN the period.
 *                                  This is the P&L's window, and it is
 *                                  where the profit and every working-
 *                                  capital movement come from.
 *   OPENING    (−∞, from)        — cash and bank as at the instant the
 *                                  period opened, i.e. cumulative to the
 *                                  DAY BEFORE `from`. A balance is always
 *                                  since inception; see the balance-sheet
 *                                  note above for why filtering a position
 *                                  by a from-date deletes the opening
 *                                  balance and still balances while it does.
 *   CLOSING    (−∞, to]          — cash and bank at the period end. The
 *                                  balance sheet's window exactly.
 *
 * ⚠️ `previousDay(period.from)`, NOT `period.from`. The opening window is
 * OPEN at its right end. Using `from` itself counts the first day of the
 * year in both the opening balance and the period movement, and the
 * statement then fails to reconcile by exactly one day's trading — except
 * on the many years where nothing was posted on 1 April, when it
 * reconciles perfectly and is wrong only for the customers who traded.
 *
 * ⚠️ AND THE THREE WINDOWS TILE THE TIMELINE EXACTLY: (−∞, from) ∪
 * [from, to] = (−∞, to]. `buildCashFlow` checks that they did, as a
 * second reconciliation independent of the first.
 *
 * ⚠️ NOT GATED BY `requireFeature`, for the same reason as the other
 * statements: this is a READ of the customer's own records, and refusing
 * to show them at the moment we are asking to be paid is not graceful
 * degradation. A guard is still not optional — every `"use server"`
 * export is a URL the browser can POST to, and an unguarded one here
 * returns a company's bank balances.
 *
 * ⭐ WAVE 9 — that guard is now `requirePermission("ledgers:read")`
 * rather than `requireTenantContext()`. See the long note above
 * `getTrialBalance`: a session was being treated as sufficient for the
 * whole of accounting, and the role model has said otherwise since
 * Phase 8.
 */
export async function getCashFlowStatement(
  input?: StatementPeriodInput,
): Promise<ActionResult<CashFlowResult>> {
  try {
    const ctx = await requirePermission("ledgers:read");
    const period = resolveStatementPeriod(input);
    const openingAsAt = previousDay(period.from);

    const [movementRows, openingRows, closingRows, cashLinks] = await Promise.all([
      ledgerBalances(ctx.tenant.id, { from: period.from, to: period.to }),
      ledgerBalances(ctx.tenant.id, { from: null, to: openingAsAt }),
      ledgerBalances(ctx.tenant.id, { from: null, to: period.asAt }),
      cashLedgersFor(ctx.tenant.id),
    ]);

    const byId = new Map(movementRows.map((r) => [r.ledgerId, r]));

    // Fill the code and name in from the chart of accounts. A link whose
    // ledger is absent keeps its placeholder and is reported as a problem.
    const cashLedgers: CashLedger[] = cashLinks.map((link) => {
      const ledger = byId.get(link.ledgerId);
      return ledger
        ? { ...link, code: ledger.code, name: ledger.name }
        : { ...link, code: link.code || "—" };
    });

    const cashIds = new Set(cashLedgers.map((c) => c.ledgerId));
    const sumCash = (rows: readonly LedgerBalance[]) =>
      rows
        .filter((r) => cashIds.has(r.ledgerId))
        // Debit-positive. A bank account with money in it is a DEBIT
        // balance; flipping the sign here would report an overdraft.
        .reduce((acc, r) => acc + r.debitMinor - r.creditMinor, 0n);

    const movements: LedgerMovement[] = movementRows.map((r) => ({
      ledgerId: r.ledgerId,
      code: r.code,
      name: r.name,
      type: r.type,
      accountType: r.accountType,
      movementMinor: r.debitMinor - r.creditMinor,
    }));

    const statement = buildCashFlow({
      movements,
      cashLedgers,
      openingCashMinor: sumCash(openingRows),
      actualClosingCashMinor: sumCash(closingRows),
    });

    const toLine = (l: {
      ledgerId: string;
      code: string;
      name: string;
      type: string;
      accountType: string;
      cashEffectMinor: bigint;
    }): CashFlowLineRow => ({
      ledgerId: l.ledgerId,
      code: l.code,
      name: l.name,
      type: l.type,
      accountType: l.accountType,
      cashEffect: fromMinorUnits(l.cashEffectMinor),
    });

    return {
      ok: true,
      data: {
        period,
        openingAsAt,
        asAt: period.asAt,
        netResult: fromMinorUnits(statement.netResultMinor),
        assetMovements: statement.assetMovements.map(toLine),
        assetMovementTotal: fromMinorUnits(statement.assetMovementTotalMinor),
        fundingMovements: statement.fundingMovements.map(toLine),
        fundingMovementTotal: fromMinorUnits(statement.fundingMovementTotalMinor),
        netMovement: fromMinorUnits(statement.netMovementMinor),
        openingCash: fromMinorUnits(statement.openingCashMinor),
        computedClosingCash: fromMinorUnits(statement.computedClosingCashMinor),
        actualClosingCash: fromMinorUnits(statement.actualClosingCashMinor),
        discrepancy: fromMinorUnits(statement.discrepancyMinor),
        usable: statement.usable,
        reconciles: statement.reconciles,
        cashLedgers: statement.cashLedgers.map((c) => ({
          ledgerId: c.ledgerId,
          code: c.code,
          name: c.name,
          source: c.source,
        })),
        failureReasons: explainCashFlowFailure(statement),
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
    const ctx = await requirePermission("ledgers:read");
    const rows = await withTenant(ctx.tenant.id, (tx) =>
      tx
        .select()
        .from(ledgers)
        .where(and(eq(ledgers.tenantId, ctx.tenant.id), isNull(ledgers.deletedAt)))
        .orderBy(ledgers.code)
    );
    return { ok: true, data: rows };
  } catch (err) {
    return toActionError(err);
  }
}

export async function getRecentTransactions(
  limit = 50,
): Promise<ActionResult<Transaction[]>> {
  try {
    const ctx = await requirePermission("transactions:read");
    const capped = Math.min(Math.max(1, limit), 200);
    const rows = await withTenant(ctx.tenant.id, (tx) =>
      tx
        .select()
        .from(transactions)
        .where(eq(transactions.tenantId, ctx.tenant.id))
        .orderBy(desc(transactions.transactionDate), desc(transactions.createdAt))
        .limit(capped)
    );
    return { ok: true, data: rows };
  } catch (err) {
    return toActionError(err);
  }
}
