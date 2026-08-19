"use server";

/**
 * Ordence — ⭐⭐⭐ BANK RECONCILIATION
 * Version: v1.18.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION AND NONE TAKES A TENANT.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 NOTHING IN THIS FILE EDITS A STATEMENT LINE OR WRITES A LEDGER
 * ENTRY BY ITSELF
 * ══════════════════════════════════════════════════════════════════════
 * The statement is the truth about the bank. The ledger is the truth
 * about the business. Reconciliation explains the difference; it does
 * not remove it.
 *
 * ⚠️ EVERY TOOL THAT QUIETLY EDITS ONE SIDE TO AGREE WITH THE OTHER
 * destroys the only evidence that anything was wrong. The cheque never
 * presented, the payment taken twice and the bank's own error all vanish
 * into a green tick, and the green tick is what gets shown to the
 * auditor.
 *
 * 🔴 THERE IS ALSO NO AUTO-CONFIRM, AT ANY SCORE. `bank_line_matches`
 * has no row that a person did not create. Two payments of the same
 * amount on the same day match each other's statement lines perfectly,
 * reconcile to zero, and leave two vendor accounts wrong, and nothing
 * anywhere reports it. The cost of being confidently wrong here is much
 * higher than the cost of one extra click.
 */

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenant } from "@/db";
import {
  bankAccounts,
  bankLineMatches,
  bankReconciliationItems,
  bankReconciliations,
  bankStatementLines,
  bankStatements,
} from "@/db/schema/banking";
import { ledgers } from "@/db/schema/accounting";
import { requirePermission, writeAudit } from "@/server/audit";
import { toSalesActionError } from "@/server/sales/guards";
import {
  fingerprintOf,
  findDuplicates,
  proposalsFor,
  reconcile,
  type LedgerCandidate,
  type Proposal,
  type ReconciliationStatement,
  type StatementLine,
} from "@/lib/banking/match";
import {
  isLockedByReconciliation,
  printableBrs,
  reconciliationLockRefusal,
  type Brs,
  type BrsPrintLine,
} from "@/lib/banking/reconciliation";
import { statementDigest } from "@/lib/banking/statement-digest";
import {
  accountLockState,
  buildReconciliationView,
  freezeReconciliation,
  ledgerBalanceAt,
  lineLockState,
  loadCandidates,
  reopenReconciliation,
} from "@/server/banking/reconciliation-service";
import { postBankAdjustment } from "@/server/accounting/post-sales";
import {
  checkAllocation,
  allocationsForLines,
} from "@/server/banking/allocation-service";
import { remainingOf, residueOf } from "@/lib/banking/allocation";
import {
  deferBankChargeCredit,
  itcRegisterTotals,
  itcTotalsForPeriod,
  markNotClaimable,
  postIdentifiedCredit,
  recordTaxInvoice,
  loadDeferrals,
  ItcDeferralRefusal,
} from "@/server/banking/bank-charge-itc-service";
import {
  emptyTotalsFor,
  ITC_STATUS_META,
  postingRefusal as itcPostingRefusal,
  postingStateLabel,
  unclaimedCreditNote,
  type ItcDeferralStatus,
} from "@/lib/banking/bank-charge-itc";
/**
 * ⭐ 0112. Batch 0108 built `mapAccountsSentence` and listed this file as
 * one of three whose refusal named the posting-accounts screen WITHOUT
 * its address, then said plainly that `server/actions/banking.ts` belonged
 * to another stream and it would not reach across. Both streams have
 * landed, so the one-line change is made here.
 */
import { mapAccountsSentence } from "@/lib/accounting/sales-posting";
import type { ActionResult } from "@/lib/validators/crm";

const MANAGE = "settings:update" as const;

/**
 * ⭐ A REFUSAL THAT CARRIES ITS REMEDY. Added v1.39.0 (Batch 36).
 *
 * The alternative is letting the unique-violation surface: an operator
 * who typed a ledger code already in their chart of accounts would see
 * "duplicate key value violates unique constraint
 * ledgers_code_tenant_unique", conclude the software is broken, and ask
 * somebody to fix it in the database. Which is how the only row in this
 * table would have got there before today anyway.
 */
class BankAccountRefusal extends Error {
  readonly remedy: string;
  constructor(message: string, remedy: string) {
    super(message);
    this.name = "BankAccountRefusal";
    this.remedy = remedy;
  }
}

/* ------------------------------------------------------------------ */
/* IMPORT                                                              */
/* ------------------------------------------------------------------ */

const importSchema = z.object({
  bankAccountId: z.string().uuid(),
  periodFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  openingBalanceMinor: z.string(),
  closingBalanceMinor: z.string(),
  sourceFilename: z.string().max(400).optional(),
  lines: z
    .array(
      z.object({
        valueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        /**
         * 🔴 ONE SIGNED NUMBER. Positive is money IN.
         *
         * ⚠️ Indian banks export two columns headed withdrawal and
         * deposit, and which is which varies by bank. Collapsing that
         * into a sign is the CALLER's job, before it reaches here,
         * because a pair of nullable columns means every query
         * downstream has to get the same COALESCE right forever.
         */
        amountMinor: z.string(),
        narration: z.string().min(1).max(2000),
        bankReference: z.string().max(200).optional().nullable(),
      }),
    )
    .min(1)
    .max(5000),
});

/* ================================================================== */
/* ⭐⭐ CREATE A BANK ACCOUNT — v1.39.0 (Batch 36)                      */
/* ================================================================== */

/**
 * 🔴 `insert(bankAccounts)` APPEARED NOWHERE IN THIS TREE.
 *
 * ══════════════════════════════════════════════════════════════════════
 * NOT "NO SCREEN". NO CODE PATH AT ALL, ANYWHERE.
 * ══════════════════════════════════════════════════════════════════════
 * Reconciliation, statement import, matching, payment recording and the
 * whole banking section were built on a table that nothing could put a
 * row in. The only way a workspace could ever have had a bank account
 * was somebody typing INSERT at a psql prompt.
 *
 * ⚠️ AND IT LOOKED FINE FROM EVERY ANGLE. `getBankAccounts()` returns an
 * empty list, which is indistinguishable from a new workspace that has
 * not added one yet. The reconciliation screen renders, says "no
 * accounts", and invites you to import a statement against nothing.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHY THE LEDGER IS CREATED HERE AND NOT SEPARATELY
 * ══════════════════════════════════════════════════════════════════════
 * `bank_accounts.ledger_id` is NOT NULL with ON DELETE RESTRICT, and
 * `bank_accounts_one_per_ledger` makes it exclusive: two bank accounts
 * on one ledger cannot be reconciled at all, so the database refuses it.
 *
 * So a bank account without its own ledger is not merely inconvenient,
 * it is impossible. A two-step flow — make a ledger, then make an
 * account pointing at it — would produce three failure modes on day one:
 * a ledger with no account, an account pointed at the wrong ledger, and
 * an operator who picks an EXISTING ledger that already has an account
 * and gets a unique-violation they cannot interpret.
 *
 * 🔴 ONE TRANSACTION, BOTH ROWS, OR NEITHER. That is what makes this
 * safe to expose to somebody who has never heard the word "ledger".
 */
const createBankAccountSchema = z.object({
  label: z.string().trim().min(1, "Give this account a name you will recognise.").max(160),
  bankName: z.string().trim().min(1, "Which bank is it with?").max(160),

  /**
   * ⚠️ LAST FOUR ONLY, AND THE SCHEMA IS WHERE THAT IS ENFORCED.
   *
   * The column is varchar(4). Accepting a full account number here and
   * truncating would mean the full number arrived at the server, was
   * logged by whatever logs request bodies, and then was discarded. The
   * discipline only works if the full number never crosses the wire.
   */
  accountLast4: z
    .string()
    .trim()
    .regex(/^\d{4}$/, "The last four digits only. Never the full account number.")
    .optional(),

  /**
   * ⚠️ THE REAL IFSC SHAPE: four letters, a zero, six alphanumerics.
   * A plain length check accepts "0000000000A", which fails at the bank
   * on the day somebody tries to pay a vendor.
   */
  ifsc: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, "An IFSC is four letters, a zero, then six characters.")
    .optional(),

  /**
   * ⭐ THE LEDGER CODE IS THE OPERATOR'S, NOT OURS. An accountant who
   * already runs a chart of accounts needs this account to sit where
   * their existing numbering says it should. Generating one would
   * guarantee a rename on the first day of real use.
   */
  ledgerCode: z
    .string()
    .trim()
    .min(1, "Give the ledger a code from your chart of accounts.")
    .max(40)
    .regex(/^[A-Za-z0-9._-]+$/, "Use letters, numbers, dot, dash or underscore."),

  /**
   * ⚠️ `trust` IS NOT A LABEL, IT IS A LEGAL BOUNDARY. Client money held
   * on trust is not the firm's asset, and commingling it with operating
   * funds is a regulatory breach for a law firm or an escrow agent. It
   * is offered here because the ledger type cannot be changed later
   * without moving every transaction on it.
   */
  ledgerType: z
    .enum(["operating", "trust", "escrow", "retention"])
    .default("operating"),

  currency: z.string().trim().length(3).default("INR"),
});

export type CreateBankAccountInput = z.input<typeof createBankAccountSchema>;

export async function createBankAccount(
  input: unknown,
): Promise<ActionResult<{ bankAccountId: string; ledgerId: string; note: string }>> {
  try {
    const data = createBankAccountSchema.parse(input);
    const ctx = await requirePermission(MANAGE);

    const outcome = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        /**
         * ⚠️ CHECKED BEFORE INSERTING RATHER THAN CAUGHT AFTER, because
         * the constraint violation for a duplicate ledger code says
         * "ledgers_code_tenant_unique", which tells an operator nothing
         * about which of their two forms was wrong.
         */
        const [clash] = await tx
          .select({ id: ledgers.id, name: ledgers.name })
          .from(ledgers)
          .where(
            and(
              eq(ledgers.tenantId, ctx.tenant.id),
              eq(ledgers.code, data.ledgerCode),
            ),
          )
          .limit(1);

        if (clash) {
          throw new BankAccountRefusal(
            `Ledger code ${data.ledgerCode} is already used by "${clash.name}".`,
            "Pick a code that is not in your chart of accounts yet. A bank account needs a ledger of its own, because two accounts sharing one ledger cannot be reconciled.",
          );
        }

        const [ledger] = await tx
          .insert(ledgers)
          .values({
            tenantId: ctx.tenant.id,
            name: data.label,
            code: data.ledgerCode,
            description: `Bank account at ${data.bankName}${
              data.accountLast4 ? ` ending ${data.accountLast4}` : ""
            }.`,
            type: data.ledgerType,
            /**
             * 🔴 A BANK ACCOUNT IS AN ASSET, ALWAYS, AND THIS IS NOT
             * OFFERED AS A CHOICE. An overdrawn account is still an
             * asset ledger carrying a credit balance; recording it as a
             * liability would put it on the wrong side of the balance
             * sheet and make the overdraft invisible when it clears.
             */
            accountType: "asset",
            currency: data.currency,
            requiresReconciliation: true,
            createdBy: ctx.user.id,
          })
          .returning({ id: ledgers.id });

        if (!ledger) throw new Error("The ledger could not be written.");

        const [account] = await tx
          .insert(bankAccounts)
          .values({
            tenantId: ctx.tenant.id,
            ledgerId: ledger.id,
            label: data.label,
            bankName: data.bankName,
            accountLast4: data.accountLast4 ?? null,
            ifsc: data.ifsc ?? null,
            /**
             * ⚠️ `reconciledTo` STAYS NULL. It means "everything on or
             * before this date has been explained", and nothing has.
             * Defaulting it to today would silently assert that every
             * transaction before opening the account is reconciled.
             */
            reconciledTo: null,
            createdBy: ctx.user.id,
          })
          .returning({ id: bankAccounts.id });

        if (!account) throw new Error("The bank account could not be written.");

        return { bankAccountId: account.id, ledgerId: ledger.id };
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: "create",
      resourceType: "bank_account",
      resourceId: outcome.bankAccountId,
      newValue: {
        label: data.label,
        bankName: data.bankName,
        ledgerCode: data.ledgerCode,
        ledgerType: data.ledgerType,
      },
    });

    revalidatePath("/banking");
    revalidatePath("/accounting");

    return {
      ok: true,
      data: {
        ...outcome,
        note: `${data.label} is open, with ledger ${data.ledgerCode}. Nothing is reconciled yet: import a statement to start explaining what has moved.`,
      },
    };
  } catch (err) {
    if (err instanceof BankAccountRefusal) {
      return { ok: false, error: `${err.message} ${err.remedy}` };
    }
    return toSalesActionError(err, "createBankAccount");
  }
}

export async function importStatement(
  input: unknown,
): Promise<
  ActionResult<{
    statementId: string;
    imported: number;
    duplicatesFlagged: number;
    balanceTies: boolean;
    note: string;
  }>
> {
  try {
    const data = importSchema.parse(input);
    const ctx = await requirePermission(MANAGE);

    const parsed = data.lines.map((l) => ({
      ...l,
      amountMinor: BigInt(l.amountMinor),
    }));

    if (parsed.some((l) => l.amountMinor === 0n)) {
      return {
        ok: false,
        error:
          "One or more lines have an amount of zero. A bank statement line of nothing is a parsing failure rather than a transaction, and importing it would put a row in the ledger that can never be matched.",
      };
    }

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [account] = await tx
          .select({
            id: bankAccounts.id,
            label: bankAccounts.label,
            // 🔴 READ, not merely stored. See the refusal below.
            reconciledTo: bankAccounts.reconciledTo,
          })
          .from(bankAccounts)
          .where(
            and(
              eq(bankAccounts.tenantId, ctx.tenant.id),
              eq(bankAccounts.id, data.bankAccountId),
            ),
          )
          .limit(1);

        if (!account) throw new Error("No such bank account.");

        /**
         * 🔴🔴 THE WHOLE-FILE DUPLICATE GUARD — 0102.
         *
         * ══════════════════════════════════════════════════════════════
         * ⚠️ THE LINE-LEVEL CHECK BELOW ONLY EVER WARNED
         * ══════════════════════════════════════════════════════════════
         * It reported lines that looked like ones already stored and then
         * wrote every one of them anyway, deliberately, because two
         * identical payments on one day are real. That is the right
         * strength for a LINE and it is far too weak for a FILE: somebody
         * re-importing January got a warning they clicked past and a
         * second copy of the month.
         *
         * ⭐ A DIGEST OVER THE WHOLE STATEMENT — account, period, both
         * balances, and every line fingerprint in order — collides with
         * exactly one thing: the same file imported again. So this one
         * REFUSES, and it refuses before anything is written.
         *
         * ⚠️ CHECKED HERE AS WELL AS BY THE UNIQUE INDEX. The index is
         * what makes it true when two people press Import at the same
         * moment; this is what produces a sentence rather than
         * "duplicate key value violates unique constraint".
         */
        const digest = statementDigest({
          bankAccountId: data.bankAccountId,
          periodFrom: data.periodFrom,
          periodTo: data.periodTo,
          openingBalanceMinor: BigInt(data.openingBalanceMinor),
          closingBalanceMinor: BigInt(data.closingBalanceMinor),
          lines: parsed,
        });

        const [alreadyImported] = await tx
          .select({
            id: bankStatements.id,
            importedAt: bankStatements.importedAt,
            sourceFilename: bankStatements.sourceFilename,
            lineCount: bankStatements.lineCount,
          })
          .from(bankStatements)
          .where(
            and(
              eq(bankStatements.tenantId, ctx.tenant.id),
              eq(bankStatements.bankAccountId, data.bankAccountId),
              eq(bankStatements.importDigest, digest),
            ),
          )
          .limit(1);

        if (alreadyImported) {
          throw new BankAccountRefusal(
            `This exact statement has already been imported: ${alreadyImported.lineCount} lines${
              alreadyImported.sourceFilename
                ? ` from ${alreadyImported.sourceFilename}`
                : ""
            }, on ${new Date(alreadyImported.importedAt as Date).toISOString().slice(0, 10)}.`,
            "Nothing has been added. Importing it a second time would double every line in the period and put the account out by exactly the month's turnover, with nothing on screen saying why. If the bank has re-issued a corrected statement, the corrected file will differ and will import.",
          );
        }

        /**
         * 🔴🔴 THE RECONCILIATION LOCK, ON THE IMPORT PATH — 0102.
         *
         * ⚠️ A LOCK THAT ONLY GUARDED MATCHING WOULD HAVE A HOLE THE SIZE
         * OF THE IMPORTER. Adding a statement line dated inside a signed
         * period adds an unmatched item to a reconciliation that was
         * signed without it, so the signed figure stops being
         * reproducible from the data behind it — which is the entire
         * thing a signature is for.
         */
        const lock =
          account.reconciledTo === null ? null : String(account.reconciledTo);
        const sealed = parsed.filter((l) =>
          isLockedByReconciliation(l.valueDate, lock),
        );
        if (sealed.length > 0 && lock !== null) {
          const earliest = sealed
            .map((l) => l.valueDate)
            .sort()[0] as string;
          throw new BankAccountRefusal(
            `${sealed.length} line${sealed.length === 1 ? " is" : "s are"} dated on or before ${lock}, and this account is reconciled to ${lock} (the earliest is ${earliest}).`,
            "Nothing has been imported. A line inside a signed period changes a reconciliation somebody has already signed. Reopen that reconciliation with a reason if the signed figure is genuinely wrong, or import a statement that starts after the reconciled date.",
          );
        }

        // ⭐⭐ THE DUPLICATE CHECK, AGAINST WHAT IS ALREADY STORED.
        //
        // ⚠️ THE FAILURE THIS CATCHES IS THE MOST COMMON ONE THERE IS.
        // Somebody downloads January, imports it, is not sure it worked,
        // and imports it again. Every January line now appears twice,
        // half of them match nothing, and the account is out by exactly
        // the month's turnover with no indication why.
        const existing = await tx
          .select({ fingerprint: bankStatementLines.fingerprint })
          .from(bankStatementLines)
          .where(
            and(
              eq(bankStatementLines.tenantId, ctx.tenant.id),
              eq(bankStatementLines.bankAccountId, data.bankAccountId),
            ),
          );

        const duplicates = findDuplicates(
          parsed,
          existing.map((e: { fingerprint: string }) => e.fingerprint),
        );

        // 🔴 THE ARITHMETIC IS CHECKED RATHER THAN TRUSTED. If the lines
        // do not add up to the closing balance the import is incomplete,
        // and that is worth knowing BEFORE somebody spends a morning
        // matching it.
        const movement = parsed.reduce((acc, l) => acc + l.amountMinor, 0n);
        const expectedClosing = BigInt(data.openingBalanceMinor) + movement;
        const balanceTies = expectedClosing === BigInt(data.closingBalanceMinor);

        const [statement] = await tx
          .insert(bankStatements)
          .values({
            tenantId: ctx.tenant.id,
            bankAccountId: data.bankAccountId,
            periodFrom: data.periodFrom,
            periodTo: data.periodTo,
            openingBalanceMinor: BigInt(data.openingBalanceMinor),
            closingBalanceMinor: BigInt(data.closingBalanceMinor),
            sourceFilename: data.sourceFilename ?? null,
            lineCount: parsed.length,
            importDigest: digest,
            importedBy: ctx.user.id,
          })
          .returning({ id: bankStatements.id });

        if (!statement) throw new Error("The statement could not be saved.");

        await tx.insert(bankStatementLines).values(
          parsed.map((l) => ({
            tenantId: ctx.tenant.id,
            statementId: statement.id,
            bankAccountId: data.bankAccountId,
            valueDate: l.valueDate,
            amountMinor: l.amountMinor,
            narration: l.narration,
            bankReference: l.bankReference ?? null,
            fingerprint: fingerprintOf(l),
          })),
        );

        await writeAudit(ctx, {
          action: "create",
          resourceType: "bank_statement",
          resourceId: statement.id,
          newValue: {
            account: account.label,
            lines: parsed.length,
            duplicates: duplicates.length,
            balanceTies,
          },
          severity: "notice",
        });

        const notes: string[] = [];
        if (!balanceTies) {
          notes.push(
            `The lines add up to ${expectedClosing} but the statement says the closing balance is ${data.closingBalanceMinor}. The import is incomplete or the opening balance is wrong, and matching this before fixing it will waste a morning.`,
          );
        }
        if (duplicates.length > 0) {
          notes.push(
            `${duplicates.length} line${duplicates.length === 1 ? "" : "s"} look identical to something already imported for this account. They have been kept rather than refused, because two separate identical payments on one day do happen, but check before matching them.`,
          );
        }

        return {
          statementId: statement.id,
          imported: parsed.length,
          duplicatesFlagged: duplicates.length,
          balanceTies,
          note: notes.join(" ") || "Imported and the balances tie.",
        };
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/banking");
    return { ok: true, data: result };
  } catch (err) {
    if (err instanceof BankAccountRefusal) {
      return { ok: false, error: `${err.message} ${err.remedy}` };
    }
    return toSalesActionError(err, "importStatement");
  }
}

/* ------------------------------------------------------------------ */
/* PROPOSE                                                             */
/* ------------------------------------------------------------------ */

export interface LineWithProposal {
  readonly line: StatementLine;
  readonly proposal: Proposal;
  readonly matched: {
    kind: string;
    id: string;
    documentNo: string | null;
  } | null;
  /**
   * ⭐ EVERY ALLOCATION ON THIS LINE — 0110. `matched` is kept as the
   * FIRST of them so the existing screen still renders, but a line may
   * now carry several and the list is the truth.
   */
  readonly allocations: ReadonlyArray<{
    kind: string;
    id: string;
    documentNo: string | null;
    allocatedMinor: bigint;
  }>;
  /** 🔴 SIGNED. Zero means fully explained; anything else is outstanding. */
  readonly residueMinor: bigint;
  readonly candidatesById: Readonly<Record<string, LedgerCandidate>>;
}

/**
 * ⭐ PROPOSES. NEVER DECIDES. See the file header for why that is the
 * entire design rather than a caution.
 */
export async function getStatementWorkspace(input: unknown): Promise<
  ActionResult<{
    statementId: string;
    accountLabel: string;
    periodFrom: string;
    periodTo: string;
    lines: readonly LineWithProposal[];
    statement: ReconciliationStatement;
  }>
> {
  try {
    const { statementId } = z
      .object({ statementId: z.string().uuid() })
      .parse(input);
    const ctx = await requirePermission(MANAGE);

    return await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [header] = await tx
          .select({
            id: bankStatements.id,
            bankAccountId: bankStatements.bankAccountId,
            periodFrom: bankStatements.periodFrom,
            periodTo: bankStatements.periodTo,
            openingBalanceMinor: bankStatements.openingBalanceMinor,
            closingBalanceMinor: bankStatements.closingBalanceMinor,
            accountLabel: bankAccounts.label,
            ledgerId: bankAccounts.ledgerId,
          })
          .from(bankStatements)
          .innerJoin(bankAccounts, eq(bankAccounts.id, bankStatements.bankAccountId))
          .where(
            and(
              eq(bankStatements.tenantId, ctx.tenant.id),
              eq(bankStatements.id, statementId),
            ),
          )
          .limit(1);

        if (!header) throw new Error("No such statement.");

        const lineRows = await tx
          .select()
          .from(bankStatementLines)
          .where(
            and(
              eq(bankStatementLines.tenantId, ctx.tenant.id),
              eq(bankStatementLines.statementId, statementId),
            ),
          )
          .orderBy(bankStatementLines.valueDate);

        const lines: StatementLine[] = lineRows.map((r: Record<string, unknown>) => ({
          id: r.id as string,
          valueDate: String(r.valueDate),
          amountMinor: BigInt(r.amountMinor as string | bigint),
          narration: r.narration as string,
          bankReference: (r.bankReference as string | null) ?? null,
        }));

        const candidates = await loadCandidates(
          tx,
          ctx.tenant.id,
          header.periodFrom,
          header.periodTo,
        );

        const existingMatches = await tx
          .select()
          .from(bankLineMatches)
          .where(
            and(
              eq(bankLineMatches.tenantId, ctx.tenant.id),
              lines.length > 0
                ? inArray(
                    bankLineMatches.statementLineId,
                    lines.map((l) => l.id),
                  )
                : sql`false`,
            ),
          );

        /**
         * ⭐⭐⭐ ALLOCATION-AWARE FROM 0110.
         *
         * ══════════════════════════════════════════════════════════════
         * 🔴 A LINE NOW HAS THREE STATES, NOT TWO
         * ══════════════════════════════════════════════════════════════
         * Untouched, partly explained, fully explained. The old code had
         * a `matchByLine` map of one document per line and treated any
         * entry in it as "Matched." — which, with allocation, would put
         * the word "Matched." on a line that is still ₹4,000 short and
         * offer the operator no way to finish it.
         */
        const allocationsByLine = new Map<string, typeof existingMatches>();
        const allocatedPerDocument = new Map<string, bigint>();
        for (const m of existingMatches as Record<string, unknown>[]) {
          const lineId = m.statementLineId as string;
          const forLine = allocationsByLine.get(lineId) ?? [];
          forLine.push(m as never);
          allocationsByLine.set(lineId, forLine);

          const docId = m.matchedId as string;
          allocatedPerDocument.set(
            docId,
            (allocatedPerDocument.get(docId) ?? 0n) +
              BigInt(m.allocatedMinor as string | bigint),
          );
        }

        const byId = Object.fromEntries(candidates.map((c) => [c.id, c]));

        /**
         * ⚠️ A DOCUMENT IS OFFERED WHILE IT STILL HAS ROOM.
         *
         * 🔴 BEFORE 0110 A DOCUMENT WAS HIDDEN THE MOMENT IT WAS TOUCHED,
         *    because 0070's unique index would have turned a second use
         *    into a constraint violation rather than a sentence. Now a
         *    ₹10,000 receipt with ₹6,000 allocated has ₹4,000 left and is
         *    a legitimate candidate for another line — which is the whole
         *    point of the batch. Hiding it would make N:M representable
         *    in the database and unreachable on the screen, which is this
         *    codebase's most-repeated defect wearing a different hat.
         */
        const available = candidates.filter((c) => {
          const used = allocatedPerDocument.get(c.id) ?? 0n;
          return (
            remainingOf({ id: c.id, amountMinor: c.amountMinor, label: c.kind }, [
              {
                id: null,
                statementLineId: "",
                matchedKind: c.kind,
                matchedId: c.id,
                allocatedMinor: used,
              },
            ]) !== 0n
          );
        });

        const withProposals: LineWithProposal[] = lines.map((line) => {
          const rows = allocationsByLine.get(line.id) ?? [];
          const residue = residueOf(
            { id: line.id, amountMinor: line.amountMinor, label: "line" },
            rows.map((m: Record<string, unknown>) => ({
              id: m.id as string,
              statementLineId: m.statementLineId as string,
              matchedKind: m.matchedKind as string,
              matchedId: m.matchedId as string,
              allocatedMinor: BigInt(m.allocatedMinor as string | bigint),
            })),
          );
          const first = rows[0] as Record<string, unknown> | undefined;

          return {
            line,
            /**
             * ⭐ PROPOSALS KEEP COMING WHILE ANYTHING IS LEFT. A partly
             * explained line still needs candidates, and the residue —
             * not the line — is what they have to fit.
             */
            proposal:
              residue === 0n
                ? {
                    statementLineId: line.id,
                    ranked: [],
                    ambiguous: false,
                    headline: "Fully explained.",
                  }
                : rows.length === 0
                  ? proposalsFor(line, available)
                  : {
                      ...proposalsFor(
                        { ...line, amountMinor: residue },
                        available,
                      ),
                      statementLineId: line.id,
                      headline: `${
                        residue < 0n ? -residue : residue
                      } paise of this line is still unexplained. Anything matched to it now has to account for that remainder, not for the whole line.`,
                    },
            matched:
              first === undefined
                ? null
                : {
                    kind: first.matchedKind as string,
                    id: first.matchedId as string,
                    documentNo: byId[first.matchedId as string]?.documentNo ?? null,
                  },
            allocations: rows.map((m: Record<string, unknown>) => ({
              kind: m.matchedKind as string,
              id: m.matchedId as string,
              documentNo: byId[m.matchedId as string]?.documentNo ?? null,
              allocatedMinor: BigInt(m.allocatedMinor as string | bigint),
            })),
            residueMinor: residue,
            candidatesById: byId,
          };
        });

        /**
         * 🔴 THE ARITHMETIC SUMMARY USES RESIDUES, NOT WHOLE AMOUNTS.
         *    A partly explained line contributes only what is left of it,
         *    or `reconcile()` would count the allocated part twice — once
         *    inside the matched document and once again in the "in the
         *    bank, not in the books" total.
         */
        const unmatchedInBank = withProposals
          .filter((w) => w.residueMinor !== 0n)
          .map((w) => ({ ...w.line, amountMinor: w.residueMinor }));

        const unmatchedInLedger = candidates
          .map((c) => ({
            ...c,
            amountMinor:
              c.amountMinor - (allocatedPerDocument.get(c.id) ?? 0n),
          }))
          .filter((c) => c.amountMinor !== 0n);

        const ledgerClosing = await ledgerBalanceAt(
          tx,
          ctx.tenant.id,
          header.ledgerId as string,
          String(header.periodTo),
        );

        return {
          ok: true as const,
          data: {
            statementId,
            accountLabel: header.accountLabel as string,
            periodFrom: String(header.periodFrom),
            periodTo: String(header.periodTo),
            lines: withProposals,
            statement: reconcile({
              ledgerClosingMinor: ledgerClosing,
              statementClosingMinor: BigInt(
                header.closingBalanceMinor as string | bigint,
              ),
              unmatchedInBank,
              unmatchedInLedger,
            }),
          },
        };
      },
      { impersonationId: ctx.impersonationId },
    );
  } catch (err) {
    return toSalesActionError(err, "getStatementWorkspace");
  }
}

/* ------------------------------------------------------------------ */
/* CONFIRM                                                             */
/* ------------------------------------------------------------------ */

const confirmSchema = z.object({
  statementLineId: z.string().uuid(),
  matchedKind: z.enum(["customer_receipt", "vendor_payment", "journal_entry"]),
  matchedId: z.string().uuid(),
  /**
   * ⭐⭐ HOW MUCH OF THE LINE THIS DOCUMENT EXPLAINS — 0110.
   *
   * ⚠️ A SIGNED INTEGER STRING IN PAISE, NOT A NUMBER. `z.number()` on
   * money is how a paisa gets lost above 2^53, and every other money
   * field that crosses this boundary in Ordence is already a string.
   *
   * 🔴 OPTIONAL, AND OMITTING IT MEANS "ALL OF WHAT IS LEFT ON THIS
   *    LINE" — not "all of the line". The ordinary case is one line and
   *    one document for the whole amount, and that must stay one click;
   *    but once part of a line is allocated, the default has to be the
   *    remainder or the second click would over-explain it and be
   *    refused for reasons the operator did not cause.
   */
  allocatedMinor: z
    .string()
    .regex(/^-?\d+$/, "Paise, as a whole number, positive for money in.")
    .optional(),
  proposedScore: z.number().int().min(0).max(100).optional(),
  wasAmbiguous: z.boolean().optional(),
  note: z.string().max(1000).optional(),
});

/**
 * ⭐ A PERSON DECIDING, RECORDED AS SUCH.
 *
 * ⚠️ The matcher's score is stored ALONGSIDE the decision rather than
 * instead of it. Six months later, "who decided these were the same
 * thing, and did the system think so too" both have answers.
 */
export async function confirmMatch(
  input: unknown,
): Promise<
  ActionResult<{
    matched: true;
    allocatedMinor: string;
    residueMinor: string;
    note: string;
  }>
> {
  try {
    const data = confirmSchema.parse(input);
    const ctx = await requirePermission(MANAGE);

    const outcome = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        /**
         * 🔴🔴 THE RECONCILIATION LOCK, READ — 0102.
         *
         * ⚠️ ADDING A MATCH UNDER A SIGNED DATE IS AS DESTRUCTIVE AS
         * REMOVING ONE. Both move an item off the outstanding list, both
         * change the signed statement's arithmetic, and only one of them
         * looks like a deletion. A lock that guarded `unmatch` alone
         * would be a lock with a hole in it that reads as control.
         */
        const state = await lineLockState(tx, ctx.tenant.id, data.statementLineId);
        if (!state) throw new Error("No such statement line.");
        if (state.locked && state.reconciledTo !== null) {
          throw new BankAccountRefusal(
            reconciliationLockRefusal(
              "Matching it now",
              state.valueDate,
              state.reconciledTo,
            ),
            "",
          );
        }

        /**
         * ⭐⭐⭐ THE ALLOCATION — 0110.
         *
         * ══════════════════════════════════════════════════════════════
         * 🔴 THE DEFAULT IS WHAT IS LEFT, NOT THE WHOLE LINE
         * ══════════════════════════════════════════════════════════════
         * A customer paying three invoices with one NEFT is three
         * confirmations. The first takes the first invoice's amount and
         * leaves a residue; if the default were the whole line, the
         * second confirmation would try to explain money that is already
         * accounted for and be refused for something the operator did
         * not do.
         */
        const already = await allocationsForLines(tx, ctx.tenant.id, [
          data.statementLineId,
        ]);
        const remaining = remainingOf(
          {
            id: data.statementLineId,
            amountMinor: state.amountMinor,
            label: "this bank line",
          },
          already.filter((a) => a.statementLineId === data.statementLineId),
        );

        const allocated =
          data.allocatedMinor === undefined
            ? remaining
            : BigInt(data.allocatedMinor);

        /**
         * 🔴🔴 BOTH SUM BOUNDS, READ BEFORE THE WRITE, IN THE SAME
         *    TRANSACTION AS THE WRITE.
         *
         * ⚠️ `ordence_guard_summed_bank_allocation` in 0110 enforces the
         *    same rule and is not redundant: this produces a sentence
         *    naming how much is left, and the trigger makes the rule true
         *    for the import and the API route nobody has written yet.
         *    Same doctrine as the reconciliation lock.
         */
        const fit = await checkAllocation(tx, {
          tenantId: ctx.tenant.id,
          statementLineId: data.statementLineId,
          matchedKind: data.matchedKind,
          matchedId: data.matchedId,
          allocatedMinor: allocated,
        });

        if (fit.refusal !== null) {
          throw new BankAccountRefusal(fit.refusal, "");
        }

        await tx.insert(bankLineMatches).values({
          tenantId: ctx.tenant.id,
          statementLineId: data.statementLineId,
          matchedKind: data.matchedKind,
          matchedId: data.matchedId,
          allocatedMinor: allocated,
          proposedScore: data.proposedScore ?? null,
          wasAmbiguous: data.wasAmbiguous ?? false,
          confirmedBy: ctx.user.id,
          note: data.note ?? null,
        });

        await writeAudit(ctx, {
          action: "create",
          resourceType: "bank_line_match",
          resourceId: data.statementLineId,
          newValue: {
            kind: data.matchedKind,
            id: data.matchedId,
            allocatedMinor: allocated.toString(),
            residueAfterMinor: fit.lineResidueAfterMinor.toString(),
            score: data.proposedScore ?? null,
            ambiguous: data.wasAmbiguous ?? false,
          },
          severity: "notice",
        });

        return {
          matched: true as const,
          allocatedMinor: allocated.toString(),
          residueMinor: fit.lineResidueAfterMinor.toString(),
          /**
           * ⭐ THE SENTENCE IS BUILT FROM THE RESIDUE, so a partial match
           * cannot look like a whole one. "Matched." on a line that is
           * still ₹4,000 short is the screen telling a comfortable lie.
           */
          /**
           * ⭐ READS `fullyExplainedAfter` RATHER THAN COMPARING THE
           * RESIDUE ITSELF. One predicate, one implementation — the same
           * reason `isLockedByReconciliation` exists.
           */
          note:
            fit.fullyExplainedAfter
              ? "Matched. This line is now fully explained."
              : `Matched in part. ${
                  fit.lineResidueAfterMinor < 0n
                    ? -fit.lineResidueAfterMinor
                    : fit.lineResidueAfterMinor
                } paise of this line is still unexplained and stays on the reconciliation as an outstanding item until something accounts for it.`,
        };
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/banking");
    return { ok: true, data: outcome };
  } catch (err) {
    if (err instanceof BankAccountRefusal) {
      return { ok: false, error: `${err.message} ${err.remedy}`.trim() };
    }
    return toSalesActionError(err, "confirmMatch");
  }
}

/**
 * ⚠️ UNMATCHING IS A FIRST-CLASS OPERATION, not an undo.
 *
 * 🔴 A wrong match is the failure mode this whole module is arranged
 * around, so the way out of one has to be as easy as the way in.
 */
export async function unmatch(
  input: unknown,
): Promise<ActionResult<{ unmatched: true; residueMinor: string; note: string }>> {
  try {
    /**
     * ⭐⭐ ONE ALLOCATION, OR THE WHOLE LINE — 0110.
     *
     * ⚠️ BEFORE ALLOCATION, "unmatch this line" HAD ONE MEANING. Now a
     * line can carry three allocations and the operator usually wants to
     * remove the one that is wrong, not all three. Omitting the document
     * still clears the line, because "start this line again" is a real
     * request and making it three clicks would invite the wrong one.
     */
    const { statementLineId, matchedKind, matchedId } = z
      .object({
        statementLineId: z.string().uuid(),
        matchedKind: z
          .enum(["customer_receipt", "vendor_payment", "journal_entry"])
          .optional(),
        matchedId: z.string().uuid().optional(),
      })
      .refine(
        (v) => (v.matchedKind === undefined) === (v.matchedId === undefined),
        "Name both the kind and the id of the document to unmatch, or neither to clear the line.",
      )
      .parse(input);
    const ctx = await requirePermission(MANAGE);

    const outcome = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        /**
         * 🔴🔴🔴 THE READ THAT MAKES `reconciled_to` A CONTROL RATHER THAN
         * A LABEL — 0102.
         *
         * ══════════════════════════════════════════════════════════════
         * ⚠️ BEFORE THIS, `unmatch` DELETED FREELY, AT ANY DATE
         * ══════════════════════════════════════════════════════════════
         * A confirmed match under a signed-off reconciliation could be
         * removed with one click and no record beyond an audit row nobody
         * reads. The signed statement's arithmetic then referred to an
         * outstanding list that no longer existed, and re-rendering it
         * produced a different document with the same signature on it.
         *
         * 🔴 THE COLUMN EXISTED FOR FIVE VERSIONS AND NOTHING CONSULTED
         * IT. That is this codebase's oldest and most expensive defect
         * shape — a field declared and enforced by nothing — and a lock
         * of that kind is worse than no lock, because it looks like
         * control.
         */
        const state = await lineLockState(tx, ctx.tenant.id, statementLineId);
        if (!state) throw new Error("No such statement line.");
        if (state.locked && state.reconciledTo !== null) {
          throw new BankAccountRefusal(
            reconciliationLockRefusal(
              "Unmatching it now",
              state.valueDate,
              state.reconciledTo,
            ),
            "",
          );
        }

        await tx
          .delete(bankLineMatches)
          .where(
            matchedId === undefined || matchedKind === undefined
              ? and(
                  eq(bankLineMatches.tenantId, ctx.tenant.id),
                  eq(bankLineMatches.statementLineId, statementLineId),
                )
              : and(
                  eq(bankLineMatches.tenantId, ctx.tenant.id),
                  eq(bankLineMatches.statementLineId, statementLineId),
                  eq(bankLineMatches.matchedKind, matchedKind),
                  eq(bankLineMatches.matchedId, matchedId),
                ),
          );

        /**
         * ⭐ THE RESIDUE AFTER THE REMOVAL, READ AND REPORTED. Removing
         * one of three allocations leaves the line partly explained, and
         * an operator told only "Unmatched." would reasonably think the
         * line was clear.
         */
        const left = await allocationsForLines(tx, ctx.tenant.id, [statementLineId]);
        const residue = residueOf(
          {
            id: statementLineId,
            amountMinor: state.amountMinor,
            label: "this bank line",
          },
          left,
        );

        await writeAudit(ctx, {
          action: "delete",
          resourceType: "bank_line_match",
          resourceId: statementLineId,
          newValue: {
            unmatched: true,
            document: matchedId ?? "all",
            residueMinor: residue.toString(),
          },
          severity: "notice",
        });

        return {
          unmatched: true as const,
          residueMinor: residue.toString(),
          note:
            left.length === 0
              ? "Unmatched. This line is outstanding again in full."
              : `Unmatched. ${left.length} allocation${left.length === 1 ? "" : "s"} remain on this line and ${
                  residue < 0n ? -residue : residue
                } paise of it is unexplained.`,
        };
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/banking");
    return { ok: true, data: outcome };
  } catch (err) {
    if (err instanceof BankAccountRefusal) {
      return { ok: false, error: `${err.message} ${err.remedy}`.trim() };
    }
    return toSalesActionError(err, "unmatch");
  }
}

/* ================================================================== */
/* ⭐⭐⭐ THE RECONCILIATION ITSELF — 0102                               */
/* ================================================================== */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 MATCHING WAS BUILT. RECONCILING WAS NOT.
 * ══════════════════════════════════════════════════════════════════════
 * Everything above this line pairs a bank line with a document. That is
 * the INPUT to a reconciliation. The reconciliation is the statement an
 * auditor asks for — bank balance, the outstanding items by name, book
 * balance — and the act of saying "this account is reconciled to this
 * figure as at this date", which is what makes the months beneath it
 * stop moving.
 */

export interface ReconciliationStatementView {
  readonly statementId: string;
  readonly bankAccountId: string;
  readonly accountLabel: string;
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly reconciledTo: string | null;
  readonly brs: Brs;
  /** ⭐ Ordered, signed lines. The renderer must not decide the order. */
  readonly printable: readonly BrsPrintLine[];
  /**
   * ⭐⭐ THE UNCLAIMED INPUT CREDIT ON THIS PERIOD'S BANK CHARGES — 0110.
   *
   * 🔴 ON THE RECONCILIATION SCREEN AND NOT ONLY ON ITS OWN REGISTER.
   *    A worklist somebody has to remember to open is a worklist that is
   *    not read. The reconciliation screen is where bank charges are
   *    discovered and written up, so it is where the consequence of
   *    writing them up gross belongs.
   *
   * ⚠️ NULL WHEN NOTHING IS AWAITING AN INVOICE. An always-present line
   *    reading "0 charges" trains the eye to skip it.
   */
  readonly unclaimedCreditNote: string | null;
  readonly history: ReadonlyArray<{
    id: string;
    reconciledTo: string;
    status: string;
    differenceMinor: string;
    differenceAbsorbedMinor: string;
    signedOffAt: string;
  }>;
}

/**
 * ⭐⭐ THE LIVE BANK RECONCILIATION STATEMENT FOR ONE IMPORTED STATEMENT.
 *
 * ⚠️ MONEY CROSSES THE SERVER/CLIENT BOUNDARY AS A STRING IN `history`
 * and as `bigint` inside `brs`. That is not an inconsistency: `brs` is
 * consumed by server components which can hold a bigint, and `history` is
 * rendered in a list where a `bigint` would fail to serialise. Both are
 * exact; neither is a Number.
 */
export async function getReconciliationStatement(
  input: unknown,
): Promise<ActionResult<ReconciliationStatementView>> {
  try {
    const { statementId } = z
      .object({ statementId: z.string().uuid() })
      .parse(input);
    const ctx = await requirePermission(MANAGE);

    return await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const view = await buildReconciliationView(tx, ctx.tenant.id, statementId);
        if (!view) throw new Error("No such statement.");

        const history = await tx
          .select({
            id: bankReconciliations.id,
            reconciledTo: bankReconciliations.reconciledTo,
            status: bankReconciliations.status,
            differenceMinor: bankReconciliations.differenceMinor,
            differenceAbsorbedMinor: bankReconciliations.differenceAbsorbedMinor,
            signedOffAt: bankReconciliations.signedOffAt,
          })
          .from(bankReconciliations)
          .where(
            and(
              eq(bankReconciliations.tenantId, ctx.tenant.id),
              eq(bankReconciliations.bankAccountId, view.bankAccountId),
            ),
          )
          .orderBy(desc(bankReconciliations.reconciledTo))
          .limit(24);

        return {
          ok: true as const,
          data: {
            statementId: view.statementId,
            bankAccountId: view.bankAccountId,
            accountLabel: view.accountLabel,
            periodFrom: view.periodFrom,
            periodTo: view.periodTo,
            reconciledTo: view.reconciledTo,
            brs: view.brs,
            printable: printableBrs(view.brs),
            /**
             * ⚠️ THE PERIOD IS THE STATEMENT'S OWN CLOSING MONTH, taken
             * from `periodTo` and never from today. A March statement
             * opened in June must show March's unclaimed credit.
             */
            unclaimedCreditNote: unclaimedCreditNote(
              (await itcTotalsForPeriod(
                tx,
                ctx.tenant.id,
                view.periodTo.slice(0, 7),
              )) ?? emptyTotalsFor(view.periodTo.slice(0, 7)),
            ),
            history: history.map((h: Record<string, unknown>) => ({
              id: h.id as string,
              reconciledTo: String(h.reconciledTo),
              status: h.status as string,
              differenceMinor: String(h.differenceMinor),
              differenceAbsorbedMinor: String(h.differenceAbsorbedMinor),
              signedOffAt: (h.signedOffAt as Date).toISOString(),
            })),
          },
        };
      },
      { impersonationId: ctx.impersonationId },
    );
  } catch (err) {
    return toSalesActionError(err, "getReconciliationStatement");
  }
}

const signOffSchema = z.object({
  statementId: z.string().uuid(),
  /**
   * ⚠️ OPTIONAL, AND IT DEFAULTS TO THE STATEMENT'S OWN CLOSING DATE.
   * Reconciling "to" a date later than the statement covers would seal
   * transactions the statement says nothing about.
   */
  reconciledTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  note: z.string().max(2000).optional(),
});

/**
 * ⭐⭐⭐ THE ACT OF RECONCILING, WHICH DID NOT EXIST BEFORE 0102.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS WRITES, AND WHY IT IS TWO THINGS AND NOT ONE
 * ══════════════════════════════════════════════════════════════════════
 *   ① THE ARTEFACT — the statement, frozen, with its outstanding items
 *     stored as rows rather than recomputed. A BRS whose total is stored
 *     and whose lines are re-derived on every render foots against
 *     nothing, and the version shown in September for March is whatever
 *     March happens to look like in September.
 *
 *   ② THE LOCK — `bank_accounts.reconciled_to`. Without it the artefact
 *     is a screenshot: everything under it can still be changed, and the
 *     signature refers to data that has moved.
 *
 * ⭐ BOTH IN ONE TRANSACTION. Either half alone is worse than neither.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 A STATEMENT THAT DOES NOT FOOT CANNOT BE SIGNED
 * ══════════════════════════════════════════════════════════════════════
 * ...unless the account carries an explicit, configured tolerance, in
 * which case the amount it let through is written onto the row and stays
 * there. A tolerance is permission to sign; it is never evidence that the
 * account balanced, and `differenceAbsorbedMinor` is what stops the two
 * being confused a year later.
 */
export async function signOffReconciliation(
  input: unknown,
): Promise<
  ActionResult<{
    reconciliationId: string;
    reconciledTo: string;
    itemCount: number;
    differenceMinor: string;
    differenceAbsorbedMinor: string;
    note: string;
  }>
> {
  try {
    const data = signOffSchema.parse(input);
    const ctx = await requirePermission(MANAGE);

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const view = await buildReconciliationView(tx, ctx.tenant.id, data.statementId);
        if (!view) throw new Error("No such statement.");

        const reconciledTo = data.reconciledTo ?? view.periodTo;

        if (reconciledTo > view.periodTo) {
          throw new BankAccountRefusal(
            `You cannot reconcile to ${reconciledTo} from a statement that ends on ${view.periodTo}.`,
            "The reconciled date seals everything on or before it, and this statement says nothing about the days after its closing date. Import the later statement first.",
          );
        }

        /**
         * ⚠️ THE LOCK ONLY EVER MOVES FORWARD ON THIS PATH. Signing a
         * date earlier than the current one would silently unseal the
         * months in between — a reopen with a reason is the only way
         * backwards, and it is recorded as one.
         */
        if (view.reconciledTo !== null && reconciledTo <= view.reconciledTo) {
          throw new BankAccountRefusal(
            `This account is already reconciled to ${view.reconciledTo}, which is on or after ${reconciledTo}.`,
            "Signing this would move the lock backwards and unseal months that have already been signed. Reopen the later reconciliation with a reason if it is wrong.",
          );
        }

        if (!view.brs.signOffPermitted) {
          throw new BankAccountRefusal(
            `This account does not reconcile: ${view.brs.differenceMinor} paise remains after every outstanding item on both sides is allowed for.`,
            "A confirmed match is wrong or something is missing from both lists. It is not a rounding error, and signing it off would put a figure into the record that cannot be reproduced from the data behind it. If this account genuinely carries a permanent small difference, set a tolerance on it deliberately — the amount it absorbs is then recorded on every reconciliation it touches.",
          );
        }

        const frozen = await freezeReconciliation(tx, {
          tenantId: ctx.tenant.id,
          userId: ctx.user.id,
          view,
          reconciledTo,
          previousReconciledTo: view.reconciledTo,
          note: data.note ?? null,
        });

        await writeAudit(ctx, {
          action: "create",
          resourceType: "bank_reconciliation",
          resourceId: frozen.reconciliationId,
          newValue: {
            account: view.accountLabel,
            reconciledTo,
            bankBalanceMinor: view.brs.bankBalanceMinor.toString(),
            bookBalanceMinor: view.brs.bookBalanceMinor.toString(),
            differenceMinor: view.brs.differenceMinor.toString(),
            differenceAbsorbedMinor: view.brs.differenceAbsorbedMinor.toString(),
            items: frozen.itemCount,
          },
          /**
           * ⚠️ `notice`, OR `warning` WHERE A TOLERANCE DID THE WORK. An
           * account signed off with a difference is a different event
           * from one that footed, and the audit stream should not have
           * to re-read the amount to tell them apart.
           */
          severity:
            view.brs.differenceAbsorbedMinor === 0n ? "notice" : "warning",
        });

        return {
          reconciliationId: frozen.reconciliationId,
          reconciledTo,
          itemCount: frozen.itemCount,
          differenceMinor: view.brs.differenceMinor.toString(),
          differenceAbsorbedMinor: view.brs.differenceAbsorbedMinor.toString(),
          note:
            view.brs.differenceAbsorbedMinor === 0n
              ? `${view.accountLabel} is reconciled to ${reconciledTo}. ${frozen.itemCount} outstanding item${frozen.itemCount === 1 ? "" : "s"} recorded. Matches dated on or before ${reconciledTo} can no longer be added or removed.`
              : `${view.accountLabel} is reconciled to ${reconciledTo} with ${view.brs.differenceAbsorbedMinor} paise allowed through by the configured tolerance. That amount is recorded on the reconciliation and on this audit entry. The account did not balance; it was signed anyway, deliberately.`,
        };
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/banking");
    revalidatePath("/accounting");
    return { ok: true, data: result };
  } catch (err) {
    if (err instanceof BankAccountRefusal) {
      return { ok: false, error: `${err.message} ${err.remedy}`.trim() };
    }
    return toSalesActionError(err, "signOffReconciliation");
  }
}

/**
 * ⭐⭐ THE WAY BACK, AND IT LEAVES A MARK.
 *
 * ⚠️ MODELLED ON `reopenFinancialPeriod`, DELIBERATELY. A reconciliation
 * that cannot be reopened is one that gets worked around — somebody posts
 * a correcting journal into a later month to make a wrong signed figure
 * add up, and the correction is then indistinguishable from a real
 * transaction forever.
 *
 * 🔴 SO REOPENING IS ALLOWED, IS RECORDED AS `critical`, NEEDS A WRITTEN
 * REASON, AND KEEPS THE ORIGINAL ROW. The row is the evidence that a
 * figure was signed at all; deleting it would make the reopen invisible,
 * which is the only thing that would make it dangerous.
 */
export async function reopenBankReconciliation(
  input: unknown,
): Promise<ActionResult<{ restoredTo: string | null; note: string }>> {
  try {
    const data = z
      .object({
        reconciliationId: z.string().uuid(),
        reason: z
          .string()
          .trim()
          .min(
            20,
            "Say what is wrong with the signed figure, in a sentence somebody reading this in a year can act on.",
          )
          .max(2000),
      })
      .parse(input);
    const ctx = await requirePermission(MANAGE);

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const outcome = await reopenReconciliation(tx, {
          tenantId: ctx.tenant.id,
          userId: ctx.user.id,
          reconciliationId: data.reconciliationId,
          reason: data.reason,
        });

        await writeAudit(ctx, {
          action: "update",
          resourceType: "bank_reconciliation",
          resourceId: data.reconciliationId,
          newValue: {
            reopened: true,
            wasReconciledTo: outcome.reconciledTo,
            lockRestoredTo: outcome.restoredTo,
            reason: data.reason,
          },
          // 🔴 A signed figure has been unsealed. That is a critical event.
          severity: "critical",
        });

        return outcome;
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/banking");
    return {
      ok: true,
      data: {
        restoredTo: result.restoredTo,
        note:
          result.restoredTo === null
            ? `Reopened. This account has no reconciled date any more, so every match on it can be changed again. The reconciliation row is kept, marked reopened, with your reason on it.`
            : `Reopened. The lock is back at ${result.restoredTo}, where it stood before this reconciliation was signed. The reconciliation row is kept, marked reopened, with your reason on it.`,
      },
    };
  } catch (err) {
    return toSalesActionError(err, "reopenBankReconciliation");
  }
}

/**
 * ⭐⭐ THE SIGNED ARTEFACT, READ BACK AS IT WAS SIGNED.
 *
 * 🔴 NOTHING HERE IS RECOMPUTED. Every figure and every item comes off
 * the frozen rows. That is the whole point: re-deriving a March
 * reconciliation in September produces whatever March looks like in
 * September, and a signature on a document that changes is not a
 * signature on anything.
 */
export async function getSignedReconciliation(
  input: unknown,
): Promise<
  ActionResult<{
    id: string;
    reconciledTo: string;
    status: string;
    bankBalanceMinor: string;
    bookBalanceMinor: string;
    chequesNotPresentedMinor: string;
    depositsNotCreditedMinor: string;
    bankChargesMinor: string;
    directCreditsMinor: string;
    differenceMinor: string;
    toleranceMinor: string;
    differenceAbsorbedMinor: string;
    signedOffAt: string;
    note: string | null;
    reopenReason: string | null;
    items: ReadonlyArray<{
      category: string;
      side: string;
      occurredOn: string;
      amountMinor: string;
      description: string;
    }>;
  }>
> {
  try {
    const { reconciliationId } = z
      .object({ reconciliationId: z.string().uuid() })
      .parse(input);
    const ctx = await requirePermission(MANAGE);

    return await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [row] = await tx
          .select()
          .from(bankReconciliations)
          .where(
            and(
              eq(bankReconciliations.tenantId, ctx.tenant.id),
              eq(bankReconciliations.id, reconciliationId),
            ),
          )
          .limit(1);

        if (!row) throw new Error("No such reconciliation.");

        const items = await tx
          .select({
            category: bankReconciliationItems.category,
            side: bankReconciliationItems.side,
            occurredOn: bankReconciliationItems.occurredOn,
            amountMinor: bankReconciliationItems.amountMinor,
            description: bankReconciliationItems.description,
          })
          .from(bankReconciliationItems)
          .where(
            and(
              eq(bankReconciliationItems.tenantId, ctx.tenant.id),
              eq(bankReconciliationItems.reconciliationId, reconciliationId),
            ),
          )
          .orderBy(
            asc(bankReconciliationItems.category),
            asc(bankReconciliationItems.occurredOn),
          );

        const r = row as Record<string, unknown>;

        return {
          ok: true as const,
          data: {
            id: r.id as string,
            reconciledTo: String(r.reconciledTo),
            status: r.status as string,
            bankBalanceMinor: String(r.bankBalanceMinor),
            bookBalanceMinor: String(r.bookBalanceMinor),
            chequesNotPresentedMinor: String(r.chequesNotPresentedMinor),
            depositsNotCreditedMinor: String(r.depositsNotCreditedMinor),
            bankChargesMinor: String(r.bankChargesMinor),
            directCreditsMinor: String(r.directCreditsMinor),
            differenceMinor: String(r.differenceMinor),
            toleranceMinor: String(r.toleranceMinor),
            differenceAbsorbedMinor: String(r.differenceAbsorbedMinor),
            signedOffAt: (r.signedOffAt as Date).toISOString(),
            note: (r.note as string | null) ?? null,
            reopenReason: (r.reopenReason as string | null) ?? null,
            items: items.map((i: Record<string, unknown>) => ({
              category: i.category as string,
              side: i.side as string,
              occurredOn: String(i.occurredOn),
              amountMinor: String(i.amountMinor),
              description: i.description as string,
            })),
          },
        };
      },
      { impersonationId: ctx.impersonationId },
    );
  } catch (err) {
    return toSalesActionError(err, "getSignedReconciliation");
  }
}

/* ------------------------------------------------------------------ */
/* POSTING WHAT THE RECONCILIATION FOUND                                */
/* ------------------------------------------------------------------ */

const adjustmentSchema = z.object({
  statementLineId: z.string().uuid(),
  /**
   * ⚠️ THE PERSON ASSERTS THE NATURE; THE SIGN OF THE LINE DECIDES THE
   * DIRECTION, AND A CONTRADICTION IS REFUSED. Deriving the kind from
   * the sign alone would let a vendor payment be written up as a bank
   * charge with one click, and asking for the direction as well as the
   * nature would let somebody debit an expense for money that arrived.
   */
  kind: z.enum(["bank_charge", "interest_credited"]),
  note: z.string().max(1000).optional(),
});

/**
 * ⭐⭐⭐ THE ENTRY THE BOOKS ARE MISSING, POSTED FROM WHERE IT WAS FOUND.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 `lib/banking/match.ts` HAS SAID "SOMEBODY HAS TO WRITE IT UP" SINCE
 *    v1.18.0, AND NOTHING IN THE BANKING MODULE COULD WRITE ANYTHING UP
 * ══════════════════════════════════════════════════════════════════════
 * The operator was shown a list of entries the books did not have and
 * given no way to add them, so the list was the same length every month.
 *
 * ⭐ THIS GOES THROUGH `server/accounting/post-sales.ts`, THE ONE POSTING
 * PATH — same idempotency key, same closed-period refusal, same role map,
 * same balanced legs, same audit. A second posting path in the banking
 * module would be a second place for the period lock to be forgotten,
 * which is exactly how 0073 came to be written.
 *
 * ⚠️ AND THE POSTED JOURNAL IS IMMEDIATELY MATCHED TO THE LINE. A charge
 * written up and left unmatched still sits on the outstanding list, so
 * the reconciliation does not improve and the operator posts it again.
 */
export async function postBankLineAdjustment(
  input: unknown,
): Promise<ActionResult<{ transactionId: string | null; note: string }>> {
  try {
    const data = adjustmentSchema.parse(input);
    const ctx = await requirePermission(MANAGE);

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const state = await lineLockState(tx, ctx.tenant.id, data.statementLineId);
        if (!state) throw new Error("No such statement line.");

        // 🔴 THE SAME LOCK, READ ON THIS PATH TOO. Posting a journal
        // dated inside a signed period changes the book balance the
        // signed statement was drawn against.
        if (state.locked && state.reconciledTo !== null) {
          throw new BankAccountRefusal(
            reconciliationLockRefusal(
              "Posting it now",
              state.valueDate,
              state.reconciledTo,
            ),
            "",
          );
        }

        const expected =
          state.amountMinor < 0n ? "bank_charge" : "interest_credited";
        if (data.kind !== expected) {
          throw new BankAccountRefusal(
            `This line ${state.amountMinor < 0n ? "took money out of" : "put money into"} the account, so it cannot be ${data.kind === "bank_charge" ? "a bank charge" : "interest credited"}.`,
            "If it is neither a bank charge nor interest, it is a document that belongs somewhere else — a vendor payment, a customer receipt, a transfer — and it should be recorded there and matched here, not written up as an adjustment with no counterparty.",
          );
        }

        const [existingMatch] = await tx
          .select({ id: bankLineMatches.id })
          .from(bankLineMatches)
          .where(
            and(
              eq(bankLineMatches.tenantId, ctx.tenant.id),
              eq(bankLineMatches.statementLineId, data.statementLineId),
            ),
          )
          .limit(1);

        if (existingMatch) {
          throw new BankAccountRefusal(
            "This line is already matched to something.",
            "Unmatch it first if the existing match is wrong. Posting a second explanation for one movement of money would explain it twice.",
          );
        }

        const magnitude =
          state.amountMinor < 0n ? -state.amountMinor : state.amountMinor;

        const outcome = await postBankAdjustment(tx, {
          tenantId: ctx.tenant.id,
          userId: ctx.user.id,
          statementLineId: data.statementLineId,
          kind: data.kind,
          amountMinor: magnitude,
          // ⚠️ THE BANK'S VALUE DATE, NEVER TODAY. See post-sales.ts.
          valueDate: state.valueDate,
          narration: state.narration,
          bankLedgerId: state.ledgerId,
        });

        if (!outcome.posted) {
          /**
           * ⚠️ EVERY NON-POSTING OUTCOME GETS ITS OWN SENTENCE. A single
           * "could not post" would make an unmapped ledger, a closed
           * month and an already-posted line look like the same fault,
           * and they have three different remedies.
           */
          const explanation =
            outcome.reason === "unmapped_roles"
              ? `Your chart of accounts has no ledger mapped for: ${outcome.missing.join(", ")}. ${mapAccountsSentence("sales")} Guessing which of your accounts is "bank charges" would post a real expense to an account nobody chose.`
              : outcome.reason === "period_closed"
                ? `${outcome.period} is closed, and this charge is dated ${state.valueDate}, which falls inside it. Reopen that period deliberately if the charge genuinely belongs there. Do not date it into an open month: it would then be missing from the month it happened in, which is the month whose reconciliation found it.`
                : outcome.reason === "already_posted"
                  ? "This line has already been posted once. Nothing has been written a second time."
                  : "There was nothing to post for this line.";

          throw new BankAccountRefusal("Nothing has been posted.", explanation);
        }

        /**
         * ⭐ THE MATCH IS WRITTEN HERE AND NOT THROUGH `confirmMatch`,
         * because it must share this transaction: a journal posted
         * without its match leaves the charge on the outstanding list
         * and invites a second posting, and the pair have to commit or
         * fail together.
         */
        await tx.insert(bankLineMatches).values({
          tenantId: ctx.tenant.id,
          statementLineId: data.statementLineId,
          matchedKind: "journal_entry",
          matchedId: outcome.transactionId,
          /**
           * 🔴 THE WHOLE LINE, ALWAYS — 0110. The journal was built FROM
           * this line for this line's amount, so a partial allocation
           * here would leave a residue on the BRS that no document can
           * ever close: a journal cannot be topped up, only reversed.
           * `journalAllocationRefusal` says the same thing on the way in
           * and the 0110 trigger says it in the database.
           */
          allocatedMinor: state.amountMinor,
          // ⚠️ NO SCORE. Nothing was proposed; this line was explained.
          proposedScore: null,
          wasAmbiguous: false,
          confirmedBy: ctx.user.id,
          note: data.note ?? null,
        });

        /**
         * ⭐⭐⭐ THE DEFERRED INPUT CREDIT — 0110.
         *
         * ══════════════════════════════════════════════════════════════
         * 🔴 0102 POSTED THE GROSS AND SAID "CLAIM THE CREDIT BY HAND"
         * ══════════════════════════════════════════════════════════════
         * Nothing recorded that it was owed and nothing ever asked, so
         * the credit on every bank charge went silently unclaimed.
         *
         * ⚠️ THE POSTING STAYS GROSS AND THAT IS CORRECT. Gross is what
         * left the account, and s.16(2)(a) CGST Act gives no credit
         * without the tax invoice in hand — which arrives separately,
         * usually consolidated for the month. What changes is that the
         * unclaimed credit is now a ROW with a period and a state
         * instead of a sentence in a help string.
         *
         * 🔴 IN THIS TRANSACTION, NOT AFTER IT. A charge posted without
         * its deferral is a credit nobody will ever be told about, which
         * is the exact defect being fixed.
         */
        const deferral =
          data.kind === "bank_charge"
            ? await deferBankChargeCredit(tx, {
                tenantId: ctx.tenant.id,
                bankAccountId: state.bankAccountId,
                statementLineId: data.statementLineId,
                transactionId: outcome.transactionId,
                grossMinor: magnitude,
                valueDate: state.valueDate,
              })
            : null;

        await writeAudit(ctx, {
          action: "create",
          resourceType: "bank_line_adjustment",
          resourceId: data.statementLineId,
          newValue: {
            kind: data.kind,
            amountMinor: magnitude.toString(),
            valueDate: state.valueDate,
            transactionId: outcome.transactionId,
            itcDeferralId: deferral?.deferralId ?? null,
          },
          severity: "notice",
        });

        return {
          transactionId: outcome.transactionId,
          note:
            `Posted and matched. The ${data.kind === "bank_charge" ? "charge" : "interest"} is dated ${state.valueDate}, the day the bank has it, and it is now off the outstanding list.` +
            (deferral === null
              ? ""
              : ` The input credit on it is recorded as unclaimed for ${deferral.taxPeriod}: the statement line is one gross figure with no rate, no invoice number and no GSTIN, so the credit cannot be worked out from it. Record the bank's tax invoice on the input credit register to claim it.`),
        };
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/banking");
    revalidatePath("/accounting");
    return { ok: true, data: result };
  } catch (err) {
    if (err instanceof BankAccountRefusal) {
      return { ok: false, error: `${err.message} ${err.remedy}`.trim() };
    }
    return toSalesActionError(err, "postBankLineAdjustment");
  }
}

/* ================================================================== */
/* ⭐⭐⭐ THE INPUT CREDIT REGISTER FOR BANK CHARGES — 0110              */
/* ================================================================== */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 F2: "THE ITC ON EVERY BANK CHARGE IS SILENTLY UNCLAIMED"
 * ══════════════════════════════════════════════════════════════════════
 * 0102 posts the gross charge and its role help says to claim the credit
 * from the bank's own tax invoice by hand. Nothing recorded that it was
 * owed, nothing totalled it and nothing ever asked.
 *
 * ⭐⭐ THE DECISION, ARGUED IN FULL IN `lib/banking/bank-charge-itc.ts`:
 * the rate is NEVER derived from the amount, NEVER read from a
 * configured default, and NEVER typed at write-up time. It is
 * transcribed from the bank's invoice, later, and must foot to the money
 * that actually left the account.
 *
 * 🔴 THE THREE STATUTES THAT DECIDE IT:
 *   • s.16(2)(a) CGST Act — credit needs the tax invoice IN HAND.
 *   • s.16(2)(aa) with Rule 36(4) — and it must have reached GSTR-2B,
 *     which a figure with no supplier invoice number never can.
 *   • s.12(12) IGST Act — place of supply for banking services is the
 *     recipient's location on the bank's records, so a charge may be
 *     IGST rather than CGST+SGST and a computed split would file it in
 *     the wrong box of the wrong return.
 */

export interface ItcRegisterView {
  readonly periods: ReadonlyArray<{
    taxPeriod: string;
    chargeCount: number;
    grossMinor: string;
    awaitingInvoiceGrossMinor: string;
    awaitingInvoiceCount: number;
    identifiedCreditMinor: string;
    identifiedCount: number;
    notClaimableGrossMinor: string;
    notClaimableCount: number;
    /**
     * ⭐⭐ 0112. THE SPLIT INSIDE `identified`. Before this, "identified"
     * and "in the books" were the same number on this screen, and one of
     * them was a job nobody knew was outstanding.
     */
    postedCreditMinor: string;
    postedCount: number;
    unpostedCreditMinor: string;
    unpostedCount: number;
    /** ⭐ Built from the totals, next to them, so the two cannot drift. */
    note: string | null;
  }>;
  readonly charges: ReadonlyArray<{
    id: string;
    valueDate: string;
    taxPeriod: string;
    grossMinor: string;
    status: ItcDeferralStatus;
    statusLabel: string;
    statusHelp: string;
    creditMinor: string;
    invoiceNo: string | null;
    /** ⭐ 0112. NULL means identified and still inside Bank Charges. */
    creditPostedAt: string | null;
    creditTransactionId: string | null;
    /**
     * ⭐ The sentence, computed server-side from the same pure function
     * the refusal uses, so the label and the button cannot disagree.
     */
    postingLabel: string;
    /** ⚠️ NULL means the button is enabled. A sentence means it is not. */
    postingRefusal: string | null;
  }>;
}

/**
 * ⭐⭐⭐ THE REGISTER. `status` DECIDES WHICH TOTAL EACH ROW LANDS IN,
 * and the three totals are three different instructions to the person
 * reading them: chase the bank, claim this, or nothing to do and here is
 * why. That is the read that makes the column mean something.
 */
export async function getBankChargeItcRegister(): Promise<
  ActionResult<ItcRegisterView>
> {
  try {
    const ctx = await requirePermission(MANAGE);

    return await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const periods = await itcRegisterTotals(tx, ctx.tenant.id);
        const charges = await loadDeferrals(tx, ctx.tenant.id);

        return {
          ok: true as const,
          data: {
            periods: periods.map((p) => ({
              taxPeriod: p.taxPeriod,
              chargeCount: p.chargeCount,
              grossMinor: p.grossMinor.toString(),
              awaitingInvoiceGrossMinor: p.awaitingInvoiceGrossMinor.toString(),
              awaitingInvoiceCount: p.awaitingInvoiceCount,
              identifiedCreditMinor: p.identifiedCreditMinor.toString(),
              identifiedCount: p.identifiedCount,
              notClaimableGrossMinor: p.notClaimableGrossMinor.toString(),
              notClaimableCount: p.notClaimableCount,
              postedCreditMinor: p.postedCreditMinor.toString(),
              postedCount: p.postedCount,
              unpostedCreditMinor: p.unpostedCreditMinor.toString(),
              unpostedCount: p.unpostedCount,
              note: unclaimedCreditNote(p),
            })),
            charges: charges.map((c) => ({
              id: c.id,
              valueDate: c.valueDate,
              taxPeriod: c.taxPeriod,
              grossMinor: c.grossMinor.toString(),
              status: c.status,
              statusLabel: ITC_STATUS_META[c.status].label,
              statusHelp: ITC_STATUS_META[c.status].help,
              creditMinor: c.creditMinor.toString(),
              invoiceNo: c.invoiceNo,
              creditPostedAt: c.creditPostedAt,
              creditTransactionId: c.creditTransactionId,
              postingLabel: postingStateLabel(c),
              postingRefusal: itcPostingRefusal(c),
            })),
          },
        };
      },
      { impersonationId: ctx.impersonationId },
    );
  } catch (err) {
    return toSalesActionError(err, "getBankChargeItcRegister");
  }
}

/**
 * ⚠️ EVERY FIGURE IS A PAISE STRING, NOT A NUMBER. `z.number()` on money
 * loses a paisa above 2^53 and every other money field crossing this
 * boundary in Ordence is already a string.
 */
const taxInvoiceSchema = z.object({
  deferralId: z.string().uuid(),
  invoiceNo: z.string().trim().min(1).max(100),
  invoiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  supplierGstin: z.string().trim().length(15),
  taxableValueMinor: z.string().regex(/^\d+$/),
  cgstMinor: z.string().regex(/^\d+$/),
  sgstMinor: z.string().regex(/^\d+$/),
  igstMinor: z.string().regex(/^\d+$/),
  cessMinor: z.string().regex(/^\d+$/),
});

/**
 * ⭐⭐ TRANSCRIBE THE BANK'S TAX INVOICE ONTO ONE CHARGE.
 *
 * 🔴 THE GROSS IS READ FROM THE STORED ROW AND NEVER TAKEN FROM THIS
 *    FORM. A form supplying both the gross and the split can be made to
 *    foot against itself, and a check that always passes is not a check.
 *
 * ⚠️ THE REFUSAL IS THE FEATURE. `taxable + CGST + SGST + IGST + cess`
 *    must equal the paise that actually left the account. An assumed 18%
 *    on a charge that was partly exempt does not foot, and this is where
 *    it is stopped.
 */
export async function recordBankChargeTaxInvoice(
  input: unknown,
): Promise<ActionResult<{ creditMinor: string; note: string }>> {
  try {
    const data = taxInvoiceSchema.parse(input);
    const ctx = await requirePermission(MANAGE);

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const outcome = await recordTaxInvoice(tx, {
          tenantId: ctx.tenant.id,
          userId: ctx.user.id,
          deferralId: data.deferralId,
          invoice: {
            invoiceNo: data.invoiceNo,
            invoiceDate: data.invoiceDate,
            supplierGstin: data.supplierGstin,
            taxableValueMinor: BigInt(data.taxableValueMinor),
            cgstMinor: BigInt(data.cgstMinor),
            sgstMinor: BigInt(data.sgstMinor),
            igstMinor: BigInt(data.igstMinor),
            cessMinor: BigInt(data.cessMinor),
          },
        });

        await writeAudit(ctx, {
          action: "update",
          resourceType: "bank_charge_itc_deferral",
          resourceId: data.deferralId,
          newValue: {
            invoiceNo: data.invoiceNo,
            supplierGstin: data.supplierGstin,
            creditMinor: outcome.creditMinor.toString(),
          },
          severity: "notice",
        });

        return outcome;
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/banking");
    revalidatePath("/banking/input-credit");
    return {
      ok: true,
      data: {
        creditMinor: result.creditMinor.toString(),
        /**
         * ⚠️ THIS SENTENCE CHANGED IN 0112 AND THE OLD ONE IS WORTH
         * KEEPING IN VIEW. It read: "The journal that moves it out of
         * Bank Charges into input credit is a separate posting and has
         * not been made by this screen." That was true and honest, and
         * it described a job the product could not do. It can now, so
         * the sentence says where the button is instead of apologising.
         */
        note: `Recorded. ${result.creditMinor} paise of input credit on this charge is now identified against invoice ${data.invoiceNo}, in ${result.taxPeriod}. It is not in the ledger yet — post it from the register to move it out of Bank Charges and into the input credit heads.`,
      },
    };
  } catch (err) {
    if (err instanceof ItcDeferralRefusal) {
      return { ok: false, error: err.message };
    }
    return toSalesActionError(err, "recordBankChargeTaxInvoice");
  }
}

/**
 * ⭐⭐⭐ POST THE IDENTIFIED CREDIT — 0112.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE BUTTON THAT DID NOT EXIST, AND THE SENTENCE THAT SAID SO
 * ══════════════════════════════════════════════════════════════════════
 * Until this shipped, the screen told the operator in as many words that
 * the journal "is a separate posting and has not been made by this
 * screen", and there was no screen that made it. `invoice_recorded` was a
 * worklist state, and the credit stayed inside Bank Charges in the trial
 * balance while the register showed it as identified.
 *
 * ⚠️ IT IS A SEPARATE ACT FROM RECORDING THE INVOICE, DELIBERATELY.
 * Merging the two would post a journal as a side effect of transcription,
 * and transcription is exactly where the typo happens. `0110`'s footing
 * CHECK catches a split that does not add up; it cannot catch a correct
 * split entered against the wrong charge. A second, explicit act gives
 * the person one look at a figure before it is in the books, and once it
 * is, `ordence_guard_posted_itc_deferral` refuses to let it move.
 *
 * ⭐ `MANAGE` AND NOT A NEW PERMISSION. Recording the invoice already
 * needs it and already decides the figure; the posting adds no judgement
 * the recorder did not already make, and inventing a key would suggest
 * this step involves a decision it does not.
 */
export async function postBankChargeInputCredit(
  input: unknown,
): Promise<ActionResult<{ note: string; transactionId: string }>> {
  try {
    const data = z.object({ deferralId: z.string().uuid() }).parse(input);
    const ctx = await requirePermission(MANAGE);

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const outcome = await postIdentifiedCredit(tx, {
          tenantId: ctx.tenant.id,
          userId: ctx.user.id,
          deferralId: data.deferralId,
        });

        /**
         * ⚠️ AUDITED ONLY WHEN IT ACTUALLY POSTED. An audit row for a
         * refused attempt would read, six months later, as though the
         * credit had been taken.
         */
        if (outcome.posted) {
          await writeAudit(ctx, {
            action: "update",
            resourceType: "bank_charge_itc_deferral",
            resourceId: data.deferralId,
            newValue: {
              creditTransactionId: outcome.transactionId,
              creditMinor: outcome.creditMinor.toString(),
              taxPeriod: outcome.taxPeriod,
            },
            severity: "notice",
          });
        }

        return outcome;
      },
      { impersonationId: ctx.impersonationId },
    );

    if (!result.posted) {
      /**
       * 🔴 EACH REFUSAL NAMES ITS OWN REMEDY. "Could not post" with no
       * reason is the shape that makes an operator try the same button
       * four times and then stop using the screen.
       */
      if (result.reason === "period_closed") {
        return {
          ok: false,
          error: `The bank's invoice is dated inside ${result.period}, and that period is closed. The credit belongs in the period the invoice was issued in — dating it forward would claim it in a return the taxpayer was not entitled to claim it in. Reopen ${result.period}, post, and close it again.`,
        };
      }
      if (result.reason === "unmapped_roles") {
        return {
          ok: false,
          error: `This posting needs ledgers mapped for ${result.missing.join(", ")} and they are not. ${mapAccountsSentence("purchase")}`,
        };
      }
      return {
        ok: false,
        error:
          "A journal already exists under this charge's posting key, but the register does not have it recorded. That is the two halves having come apart, which should not be possible — do not retry. The transaction is in the ledger; the register row needs its reference restored by hand.",
      };
    }

    revalidatePath("/banking");
    revalidatePath("/banking/input-credit");
    return {
      ok: true,
      data: {
        transactionId: result.transactionId,
        note: `Posted. ${result.creditMinor} paise moved out of Bank Charges and into the input credit heads, dated on the bank's invoice, in ${result.taxPeriod}.`,
      },
    };
  } catch (err) {
    if (err instanceof ItcDeferralRefusal) {
      return { ok: false, error: err.message };
    }
    return toSalesActionError(err, "postBankChargeInputCredit");
  }
}

/**
 * ⭐ THE OTHER WAY OUT, AND IT NEEDS A REASON.
 *
 * ⚠️ A charge that will never carry a claimable credit has to leave the
 * "chase the bank" list or the list stops being read. It must not leave
 * silently: an exempt supply and a credit blocked by s.17(5) are
 * different facts, and both differ from an oversight.
 */
export async function markBankChargeNotClaimable(
  input: unknown,
): Promise<ActionResult<{ note: string }>> {
  try {
    const data = z
      .object({
        deferralId: z.string().uuid(),
        reason: z
          .string()
          .trim()
          .min(
            15,
            "Say why this credit will not be taken. An exempt supply and a credit blocked under s.17(5) are different facts, and a blank reason is indistinguishable from having forgotten.",
          )
          .max(2000),
      })
      .parse(input);
    const ctx = await requirePermission(MANAGE);

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const outcome = await markNotClaimable(tx, {
          tenantId: ctx.tenant.id,
          userId: ctx.user.id,
          deferralId: data.deferralId,
          reason: data.reason,
        });

        await writeAudit(ctx, {
          action: "update",
          resourceType: "bank_charge_itc_deferral",
          resourceId: data.deferralId,
          newValue: { status: "not_claimable", reason: data.reason },
          severity: "notice",
        });

        return outcome;
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/banking/input-credit");
    return {
      ok: true,
      data: {
        note: `Recorded as not claimable for ${result.taxPeriod}, with your reason. It stays on the register — a credit deliberately given up and one nobody noticed look identical on a total, and only one of them is a decision.`,
      },
    };
  } catch (err) {
    if (err instanceof ItcDeferralRefusal) {
      return { ok: false, error: err.message };
    }
    return toSalesActionError(err, "markBankChargeNotClaimable");
  }
}

/* ------------------------------------------------------------------ */
/* THE TOLERANCE, SET DELIBERATELY OR NOT AT ALL                        */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ THIS EXISTS SO THAT A TOLERANCE IS NEVER A DEFAULT, A CONSTANT OR A
 * SILENT ROUNDING. It is zero on every account until somebody sets it,
 * per account, with a reason that lands in the audit log — and the amount
 * it lets through is written onto every reconciliation it touches.
 *
 * 🔴 CAPPED AT ₹100. A tolerance large enough to hide a real transaction
 * is not a tolerance, it is a way of signing off an account that does not
 * reconcile. The cap is a hundred rupees because the differences this is
 * for are paise from a historic conversion, and a bank charge is more
 * than a hundred rupees.
 */
export async function setReconciliationTolerance(
  input: unknown,
): Promise<ActionResult<{ toleranceMinor: string; note: string }>> {
  try {
    const data = z
      .object({
        bankAccountId: z.string().uuid(),
        toleranceMinor: z
          .string()
          .regex(/^\d+$/, "Paise, as a whole number. Zero means no tolerance."),
        reason: z
          .string()
          .trim()
          .min(
            20,
            "Say why this account carries a permanent difference. A tolerance with no stated cause is a way to sign off an account that does not reconcile.",
          )
          .max(2000),
      })
      .parse(input);
    const ctx = await requirePermission(MANAGE);

    const tolerance = BigInt(data.toleranceMinor);
    if (tolerance > 10_000n) {
      return {
        ok: false,
        error:
          "A reconciliation tolerance above ₹100 is not a tolerance. A difference that large is a transaction — a charge, a receipt, a wrong match — and absorbing it would hide the thing the reconciliation exists to find.",
      };
    }

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const before = await accountLockState(tx, ctx.tenant.id, data.bankAccountId);
        if (!before) throw new Error("No such bank account.");

        await tx
          .update(bankAccounts)
          .set({
            reconciliationToleranceMinor: tolerance,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(bankAccounts.tenantId, ctx.tenant.id),
              eq(bankAccounts.id, data.bankAccountId),
            ),
          );

        await writeAudit(ctx, {
          action: "update",
          resourceType: "bank_account",
          resourceId: data.bankAccountId,
          oldValue: { toleranceMinor: before.toleranceMinor.toString() },
          newValue: { toleranceMinor: tolerance.toString(), reason: data.reason },
          severity: tolerance === 0n ? "notice" : "warning",
        });

        return { label: before.label };
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/banking");
    return {
      ok: true,
      data: {
        toleranceMinor: tolerance.toString(),
        note:
          tolerance === 0n
            ? `${result.label} now has no tolerance. A reconciliation on it has to foot exactly before it can be signed.`
            : `${result.label} will accept a difference of up to ${tolerance} paise at sign-off. Anything it absorbs is recorded on the reconciliation as a difference, because it is one.`,
      },
    };
  } catch (err) {
    return toSalesActionError(err, "setReconciliationTolerance");
  }
}

/* ------------------------------------------------------------------ */
/* READ                                                               */
/* ------------------------------------------------------------------ */

export async function getBankAccounts(): Promise<
  ActionResult<{
    accounts: ReadonlyArray<{
      id: string;
      label: string;
      bankName: string;
      accountLast4: string | null;
      reconciledTo: string | null;
      /** ⭐ Surfaced so an account carrying a tolerance says so on screen. */
      reconciliationToleranceMinor: string;
    }>;
    statements: ReadonlyArray<{
      id: string;
      accountLabel: string;
      periodFrom: string;
      periodTo: string;
      lineCount: number;
    }>;
  }>
> {
  try {
    const ctx = await requirePermission(MANAGE);

    return await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const accounts = await tx
          .select({
            id: bankAccounts.id,
            label: bankAccounts.label,
            bankName: bankAccounts.bankName,
            accountLast4: bankAccounts.accountLast4,
            reconciledTo: bankAccounts.reconciledTo,
            reconciliationToleranceMinor: bankAccounts.reconciliationToleranceMinor,
          })
          .from(bankAccounts)
          .where(
            and(
              eq(bankAccounts.tenantId, ctx.tenant.id),
              eq(bankAccounts.isActive, true),
            ),
          );

        const statements = await tx
          .select({
            id: bankStatements.id,
            accountLabel: bankAccounts.label,
            periodFrom: bankStatements.periodFrom,
            periodTo: bankStatements.periodTo,
            lineCount: bankStatements.lineCount,
          })
          .from(bankStatements)
          .innerJoin(bankAccounts, eq(bankAccounts.id, bankStatements.bankAccountId))
          .where(eq(bankStatements.tenantId, ctx.tenant.id))
          .orderBy(sql`${bankStatements.periodFrom} DESC`)
          .limit(50);

        return {
          ok: true as const,
          data: {
            accounts: accounts.map((a: Record<string, unknown>) => ({
              id: a.id as string,
              label: a.label as string,
              bankName: a.bankName as string,
              accountLast4: (a.accountLast4 as string | null) ?? null,
              reconciledTo: a.reconciledTo === null ? null : String(a.reconciledTo),
              reconciliationToleranceMinor: String(a.reconciliationToleranceMinor ?? 0),
            })),
            statements: statements.map((s: Record<string, unknown>) => ({
              id: s.id as string,
              accountLabel: s.accountLabel as string,
              periodFrom: String(s.periodFrom),
              periodTo: String(s.periodTo),
              lineCount: s.lineCount as number,
            })),
          },
        };
      },
      { impersonationId: ctx.impersonationId },
    );
  } catch (err) {
    return toSalesActionError(err, "getBankAccounts");
  }
}

/* ------------------------------------------------------------------ */
/* PLUMBING                                                            */
/* ------------------------------------------------------------------ */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;

/**
 * ⭐ `loadCandidates`, `ledgerBalanceAt` AND `shiftDays` MOVED TO
 * `server/banking/reconciliation-service.ts` IN 0102, UNCHANGED.
 *
 * ⚠️ THE STATEMENT WORKSPACE AND THE RECONCILIATION STATEMENT HAVE TO
 * DRAW THE SAME OUTSTANDING ITEMS FROM THE SAME 45-DAY WINDOW. Two
 * copies of that constant is two answers to "what is outstanding", and
 * the one on the signed artefact would be the one nobody noticed had
 * drifted.
 */

