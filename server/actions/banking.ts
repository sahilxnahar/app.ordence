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

        const matchByLine = new Map<string, { kind: string; id: string }>(
          existingMatches.map((m: Record<string, unknown>) => [
            m.statementLineId as string,
            { kind: m.matchedKind as string, id: m.matchedId as string },
          ]),
        );

        // ⚠️ A DOCUMENT ALREADY MATCHED TO ANOTHER LINE IS NOT OFFERED
        // AGAIN. 0070 enforces one document per line and one line per
        // document; offering a taken candidate would produce a
        // constraint violation instead of a sentence.
        const taken = new Set(
          existingMatches.map((m: Record<string, unknown>) => m.matchedId as string),
        );
        const available = candidates.filter((c) => !taken.has(c.id));
        const byId = Object.fromEntries(candidates.map((c) => [c.id, c]));

        const withProposals: LineWithProposal[] = lines.map((line) => {
          const already = matchByLine.get(line.id);
          return {
            line,
            proposal: already
              ? { statementLineId: line.id, ranked: [], ambiguous: false, headline: "Matched." }
              : proposalsFor(line, available),
            matched: already
              ? {
                  kind: already.kind,
                  id: already.id,
                  documentNo: byId[already.id]?.documentNo ?? null,
                }
              : null,
            candidatesById: byId,
          };
        });

        const unmatchedInBank = withProposals
          .filter((w) => w.matched === null)
          .map((w) => w.line);

        const unmatchedInLedger = available.filter(
          (c) => !withProposals.some((w) => w.matched?.id === c.id),
        );

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
): Promise<ActionResult<{ matched: true }>> {
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

        await tx.insert(bankLineMatches).values({
          tenantId: ctx.tenant.id,
          statementLineId: data.statementLineId,
          matchedKind: data.matchedKind,
          matchedId: data.matchedId,
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
            score: data.proposedScore ?? null,
            ambiguous: data.wasAmbiguous ?? false,
          },
          severity: "notice",
        });

        return { matched: true as const };
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
): Promise<ActionResult<{ unmatched: true }>> {
  try {
    const { statementLineId } = z
      .object({ statementLineId: z.string().uuid() })
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
            and(
              eq(bankLineMatches.tenantId, ctx.tenant.id),
              eq(bankLineMatches.statementLineId, statementLineId),
            ),
          );

        await writeAudit(ctx, {
          action: "delete",
          resourceType: "bank_line_match",
          resourceId: statementLineId,
          newValue: { unmatched: true },
          severity: "notice",
        });

        return { unmatched: true as const };
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
              ? `Your chart of accounts has no ledger mapped for: ${outcome.missing.join(", ")}. Map them on the posting accounts screen — guessing which of your accounts is "bank charges" would post a real expense to an account nobody chose.`
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
          // ⚠️ NO SCORE. Nothing was proposed; this line was explained.
          proposedScore: null,
          wasAmbiguous: false,
          confirmedBy: ctx.user.id,
          note: data.note ?? null,
        });

        await writeAudit(ctx, {
          action: "create",
          resourceType: "bank_line_adjustment",
          resourceId: data.statementLineId,
          newValue: {
            kind: data.kind,
            amountMinor: magnitude.toString(),
            valueDate: state.valueDate,
            transactionId: outcome.transactionId,
          },
          severity: "notice",
        });

        return {
          transactionId: outcome.transactionId,
          note: `Posted and matched. The ${data.kind === "bank_charge" ? "charge" : "interest"} is dated ${state.valueDate}, the day the bank has it, and it is now off the outstanding list.`,
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

