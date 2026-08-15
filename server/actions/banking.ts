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

import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenant } from "@/db";
import {
  bankAccounts,
  bankLineMatches,
  bankStatementLines,
  bankStatements,
} from "@/db/schema/banking";
import { customerReceipts } from "@/db/schema/sales-invoices";
import { ledgers } from "@/db/schema/accounting";
import { vendorPayments } from "@/db/schema/procurement";
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
          .select({ id: bankAccounts.id, label: bankAccounts.label })
          .from(bankAccounts)
          .where(
            and(
              eq(bankAccounts.tenantId, ctx.tenant.id),
              eq(bankAccounts.id, data.bankAccountId),
            ),
          )
          .limit(1);

        if (!account) throw new Error("No such bank account.");

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

    await withTenant(
      ctx.tenant.id,
      async (tx) => {
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
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/banking");
    return { ok: true, data: { matched: true } };
  } catch (err) {
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

    await withTenant(
      ctx.tenant.id,
      async (tx) => {
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
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/banking");
    return { ok: true, data: { unmatched: true } };
  } catch (err) {
    return toSalesActionError(err, "unmatch");
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
 * ⚠️ CANDIDATES ARE DRAWN FROM A WINDOW AROUND THE STATEMENT PERIOD, not
 * from all history. A cheque written in December clears in January, so a
 * period-exact query misses precisely the items that make reconciliation
 * necessary in the first place.
 */
const CANDIDATE_WINDOW_DAYS = 45;

async function loadCandidates(
  tx: Tx,
  tenantId: string,
  periodFrom: string,
  periodTo: string,
): Promise<readonly LedgerCandidate[]> {
  const from = shiftDays(periodFrom, -CANDIDATE_WINDOW_DAYS);
  const to = shiftDays(periodTo, CANDIDATE_WINDOW_DAYS);

  const receipts = await tx
    .select({
      id: customerReceipts.id,
      occurredOn: customerReceipts.receivedOn,
      amountMinor: customerReceipts.amountMinor,
      reference: customerReceipts.bankRef,
      instrument: customerReceipts.instrumentRef,
      documentNo: customerReceipts.receiptNumber,
    })
    .from(customerReceipts)
    .where(
      and(
        eq(customerReceipts.tenantId, tenantId),
        gte(customerReceipts.receivedOn, from),
        lte(customerReceipts.receivedOn, to),
      ),
    );

  const payments = await tx
    .select({
      id: vendorPayments.id,
      occurredOn: vendorPayments.paymentDate,
      amountMinor: vendorPayments.netMinor,
      reference: vendorPayments.bankReference,
      documentNo: vendorPayments.paymentNumber,
    })
    .from(vendorPayments)
    .where(
      and(
        eq(vendorPayments.tenantId, tenantId),
        gte(vendorPayments.paymentDate, from),
        lte(vendorPayments.paymentDate, to),
      ),
    );

  const out: LedgerCandidate[] = [];

  for (const r of receipts as Record<string, unknown>[]) {
    out.push({
      id: r.id as string,
      kind: "customer_receipt",
      occurredOn: String(r.occurredOn),
      // ⭐ POSITIVE. Money in.
      amountMinor: BigInt(r.amountMinor as string | bigint),
      reference:
        (r.reference as string | null) ?? (r.instrument as string | null) ?? null,
      counterpartyName: null,
      documentNo: (r.documentNo as string | null) ?? null,
    });
  }

  for (const p of payments as Record<string, unknown>[]) {
    out.push({
      id: p.id as string,
      kind: "vendor_payment",
      occurredOn: String(p.occurredOn),
      /**
       * 🔴 NEGATED. Money out.
       *
       * ⚠️ THIS SINGLE MINUS SIGN IS THE EASIEST THING IN THE MODULE TO
       * GET WRONG, and getting it wrong makes every payment fail to
       * match while every one of them looks like it should.
       */
      amountMinor: -BigInt(p.amountMinor as string | bigint),
      reference: (p.reference as string | null) ?? null,
      counterpartyName: null,
      documentNo: (p.documentNo as string | null) ?? null,
    });
  }

  return out;
}

/**
 * ⚠️ THE LEDGER BALANCE ON A DATE, from the journal lines themselves
 * rather than from a cached figure. A reconciliation checked against a
 * stale cache reconciles against the wrong number and says so
 * confidently.
 */
async function ledgerBalanceAt(
  tx: Tx,
  tenantId: string,
  ledgerId: string,
  onDate: string,
): Promise<bigint> {
  const rows = await tx.execute(sql`
    SELECT COALESCE(SUM(
             CASE WHEN je.entry_type = 'debit'
                  THEN je.amount_minor ELSE -je.amount_minor END
           ), 0)::bigint AS balance
      FROM journal_entries je
      JOIN transactions t ON t.id = je.transaction_id
     WHERE je.tenant_id = ${tenantId}::uuid
       AND je.ledger_id = ${ledgerId}::uuid
       AND t.transaction_date <= ${onDate}::date
       AND t.status = 'posted'
  `);
  const first =
    (Array.isArray(rows) ? rows[0] : (rows as { rows?: unknown[] }).rows?.[0]) ?? {};
  return BigInt((first as { balance?: string | number }).balance ?? 0);
}

function shiftDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const t = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}
