import "server-only";

/**
 * Ordence — ⭐⭐⭐ THE DATABASE HALF OF BANK RECONCILIATION
 * Version: v1.64.0-alpha (Batch 0102)
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THIS FILE EXISTS SEPARATELY FROM `lib/banking/reconciliation.ts`
 * ══════════════════════════════════════════════════════════════════════
 * Same split as `lib/inventory/valuation.ts` against
 * `server/inventory/valuation-service.ts`: the arithmetic of a bank
 * reconciliation statement is pure and must be testable without a
 * database, and everything that knows what a table is lives here.
 *
 * ⭐ `import "server-only"` AND EVERY FUNCTION TAKES A `tx`. Both follow
 * from the same rule as `server/accounting/post-sales.ts`: these are not
 * actions. A function taking a transaction cannot be a browser-reachable
 * endpoint, and the work must share the caller's transaction — signing
 * off a reconciliation and moving the lock have to commit or fail
 * together, or the lock says one thing and the artefact says another.
 */

import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { withTenant } from "@/db";
import {
  bankAccounts,
  bankLineMatches,
  bankReconciliationItems,
  bankReconciliations,
  bankStatementLines,
  bankStatements,
} from "@/db/schema/banking";
import { customerReceipts } from "@/db/schema/sales-invoices";
import { vendorPayments } from "@/db/schema/procurement";
import {
  buildBrs,
  isLockedByReconciliation,
  type Brs,
  type ResidualItem,
} from "@/lib/banking/reconciliation";
import { residueOf, type AllocationRow } from "@/lib/banking/allocation";
import { allocationsForLines } from "@/server/banking/allocation-service";
import type { LedgerCandidate, StatementLine } from "@/lib/banking/match";

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

/**
 * ⚠️ CANDIDATES ARE DRAWN FROM A WINDOW AROUND THE STATEMENT PERIOD, not
 * from all history. A cheque written in December clears in January, so a
 * period-exact query misses precisely the items that make reconciliation
 * necessary in the first place.
 */
export const CANDIDATE_WINDOW_DAYS = 45;

export function shiftDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const t = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * ⚠️ MOVED HERE FROM `server/actions/banking.ts` IN 0102, UNCHANGED.
 * The workspace and the reconciliation statement have to draw the same
 * candidates from the same window, and two copies of a 45-day constant
 * is two answers to "what is outstanding".
 */
export async function loadCandidates(
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
export async function ledgerBalanceAt(
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

/* ------------------------------------------------------------------ */
/* 🔴🔴 THE LOCK, READ                                                 */
/* ------------------------------------------------------------------ */

export interface LineLockState {
  readonly statementLineId: string;
  readonly bankAccountId: string;
  readonly ledgerId: string;
  readonly valueDate: string;
  readonly amountMinor: bigint;
  readonly narration: string;
  readonly reconciledTo: string | null;
  /** ⭐ The answer, computed by the one pure predicate. */
  readonly locked: boolean;
}

/**
 * ⭐⭐⭐ EVERY WRITE PATH THAT COULD MOVE A RECONCILED FIGURE CALLS THIS.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 SEVEN COLUMNS IN THIS PRODUCT HAVE BEEN WRITTEN AND READ BY NOTHING
 * ══════════════════════════════════════════════════════════════════════
 * `bank_accounts.reconciled_to` was on its way to being the eighth: it
 * existed from 0070, it was rendered on the banking screen, and the only
 * write to it in the entire tree was `reconciledTo: null`.
 *
 * ⭐ SO THE READ LIVES IN ONE FUNCTION AND THE PREDICATE IN ONE PURE
 * HELPER. `confirmMatch`, `unmatch` and `postBankLineAdjustment` all call
 * THIS; none of them compares dates itself. Four inline comparisons is
 * four chances for one to be `<` where the others are `<=`, and the one
 * that is wrong is the one nobody tests.
 *
 * ⚠️ THE DATABASE TRIGGER IN 0102 IS THE OTHER HALF, and it is not
 * redundant: this produces a sentence for a person, and the trigger makes
 * the rule true for the import, the support fix and the API route that
 * have not been written yet. Same doctrine as `ordence_guard_closed_period`.
 */
export async function lineLockState(
  tx: Tx,
  tenantId: string,
  statementLineId: string,
): Promise<LineLockState | null> {
  const [row] = await tx
    .select({
      id: bankStatementLines.id,
      bankAccountId: bankStatementLines.bankAccountId,
      valueDate: bankStatementLines.valueDate,
      amountMinor: bankStatementLines.amountMinor,
      narration: bankStatementLines.narration,
      reconciledTo: bankAccounts.reconciledTo,
      ledgerId: bankAccounts.ledgerId,
    })
    .from(bankStatementLines)
    .innerJoin(bankAccounts, eq(bankAccounts.id, bankStatementLines.bankAccountId))
    .where(
      and(
        eq(bankStatementLines.tenantId, tenantId),
        eq(bankStatementLines.id, statementLineId),
      ),
    )
    .limit(1);

  if (!row) return null;

  const valueDate = String(row.valueDate);
  const reconciledTo = row.reconciledTo === null ? null : String(row.reconciledTo);

  return {
    statementLineId: row.id as string,
    bankAccountId: row.bankAccountId as string,
    ledgerId: row.ledgerId as string,
    valueDate,
    amountMinor: BigInt(row.amountMinor as string | bigint),
    narration: row.narration as string,
    reconciledTo,
    locked: isLockedByReconciliation(valueDate, reconciledTo),
  };
}

/** The account's own lock date, for paths that have no line in hand. */
export async function accountLockState(
  tx: Tx,
  tenantId: string,
  bankAccountId: string,
): Promise<{
  reconciledTo: string | null;
  toleranceMinor: bigint;
  ledgerId: string;
  label: string;
} | null> {
  const [row] = await tx
    .select({
      reconciledTo: bankAccounts.reconciledTo,
      toleranceMinor: bankAccounts.reconciliationToleranceMinor,
      ledgerId: bankAccounts.ledgerId,
      label: bankAccounts.label,
    })
    .from(bankAccounts)
    .where(and(eq(bankAccounts.tenantId, tenantId), eq(bankAccounts.id, bankAccountId)))
    .limit(1);

  if (!row) return null;

  return {
    reconciledTo: row.reconciledTo === null ? null : String(row.reconciledTo),
    toleranceMinor: BigInt(row.toleranceMinor as string | bigint),
    ledgerId: row.ledgerId as string,
    label: row.label as string,
  };
}

/* ------------------------------------------------------------------ */
/* THE STATEMENT, ASSEMBLED                                            */
/* ------------------------------------------------------------------ */

export interface ReconciliationView {
  readonly statementId: string;
  readonly bankAccountId: string;
  readonly accountLabel: string;
  readonly ledgerId: string;
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly reconciledTo: string | null;
  readonly brs: Brs;
  /** ⭐ Bank lines still unmatched, so the screen can offer to post them. */
  readonly unpostedBankLines: readonly StatementLine[];
}

/**
 * ⭐⭐ THE LIVE RECONCILIATION STATEMENT FOR ONE IMPORTED STATEMENT.
 *
 * ⚠️ LIVE, AND THEREFORE NOT THE ARTEFACT. This is what the screen shows
 * while somebody is still working. What gets signed is frozen into
 * `bank_reconciliations` and `bank_reconciliation_items` by
 * `freezeReconciliation` below, because a stored total whose lines are
 * recomputed on every render foots against nothing.
 */
export async function buildReconciliationView(
  tx: Tx,
  tenantId: string,
  statementId: string,
): Promise<ReconciliationView | null> {
  const [header] = await tx
    .select({
      id: bankStatements.id,
      bankAccountId: bankStatements.bankAccountId,
      periodFrom: bankStatements.periodFrom,
      periodTo: bankStatements.periodTo,
      closingBalanceMinor: bankStatements.closingBalanceMinor,
      accountLabel: bankAccounts.label,
      ledgerId: bankAccounts.ledgerId,
      reconciledTo: bankAccounts.reconciledTo,
      toleranceMinor: bankAccounts.reconciliationToleranceMinor,
    })
    .from(bankStatements)
    .innerJoin(bankAccounts, eq(bankAccounts.id, bankStatements.bankAccountId))
    .where(and(eq(bankStatements.tenantId, tenantId), eq(bankStatements.id, statementId)))
    .limit(1);

  if (!header) return null;

  const periodFrom = String(header.periodFrom);
  const periodTo = String(header.periodTo);

  const lineRows = await tx
    .select()
    .from(bankStatementLines)
    .where(
      and(
        eq(bankStatementLines.tenantId, tenantId),
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

  /**
   * ⭐⭐⭐ ALLOCATION-AWARE FROM 0110. See `ResidualItem` in
   * `lib/banking/reconciliation.ts` for why this is the place the money
   * used to be able to disappear.
   *
   * 🔴 THE OLD CODE WAS `lines.filter(l => !matchedLineIds.has(l.id))`.
   *    With allocation that is wrong in exactly one way and it is the
   *    dangerous one: a ₹10,000 line carrying ₹6,000 of allocations HAS
   *    a match, so it dropped out of the outstanding list, and the
   *    remaining ₹4,000 reappeared at the bottom of the statement as an
   *    unexplained difference with nothing saying which line it was.
   */
  const allocations = await allocationsForLines(
    tx,
    tenantId,
    lines.map((l) => l.id),
  );

  const candidates = await loadCandidates(tx, tenantId, periodFrom, periodTo);

  const allocatedByLine = new Map<string, AllocationRow[]>();
  const allocatedByDocument = new Map<string, AllocationRow[]>();
  for (const a of allocations) {
    const forLine = allocatedByLine.get(a.statementLineId) ?? [];
    forLine.push(a);
    allocatedByLine.set(a.statementLineId, forLine);

    const forDoc = allocatedByDocument.get(a.matchedId) ?? [];
    forDoc.push(a);
    allocatedByDocument.set(a.matchedId, forDoc);
  }

  /**
   * ⚠️ THREE STATES PER LINE, NOT TWO. Untouched, partly explained,
   * fully explained — and only the third leaves the statement.
   */
  const unmatchedInBank = lines.filter(
    (l) => (allocatedByLine.get(l.id) ?? []).length === 0,
  );

  const unmatchedInLedger = candidates.filter(
    (c) => (allocatedByDocument.get(c.id) ?? []).length === 0,
  );

  const partlyExplained: ResidualItem[] = [];

  for (const line of lines) {
    const rows = allocatedByLine.get(line.id) ?? [];
    if (rows.length === 0) continue;
    const residue = residueOf(
      { id: line.id, amountMinor: line.amountMinor, label: "line" },
      rows,
    );
    if (residue === 0n) continue;
    partlyExplained.push({
      sourceId: line.id,
      sourceKind: null,
      side: "bank",
      occurredOn: line.valueDate,
      residueMinor: residue,
      description: `Still outstanding on ${line.narration}`,
    });
  }

  for (const candidate of candidates) {
    const rows = allocatedByDocument.get(candidate.id) ?? [];
    if (rows.length === 0) continue;
    const residue = residueOf(
      { id: candidate.id, amountMinor: candidate.amountMinor, label: "document" },
      rows,
    );
    if (residue === 0n) continue;
    partlyExplained.push({
      sourceId: candidate.id,
      sourceKind: candidate.kind,
      side: "books",
      occurredOn: candidate.occurredOn,
      residueMinor: residue,
      description: `Still outstanding on ${
        candidate.documentNo ?? candidate.reference ?? candidate.kind
      }`,
    });
  }

  const bookBalance = await ledgerBalanceAt(
    tx,
    tenantId,
    header.ledgerId as string,
    periodTo,
  );

  return {
    statementId,
    bankAccountId: header.bankAccountId as string,
    accountLabel: header.accountLabel as string,
    ledgerId: header.ledgerId as string,
    periodFrom,
    periodTo,
    reconciledTo: header.reconciledTo === null ? null : String(header.reconciledTo),
    brs: buildBrs({
      bankBalanceMinor: BigInt(header.closingBalanceMinor as string | bigint),
      bookBalanceMinor: bookBalance,
      unmatchedInBank,
      unmatchedInLedger,
      // 🔴 REQUIRED, NOT OPTIONAL — 0110. A caller that forgets this
      //    ships a statement which silently drops every partial residue.
      partlyExplained,
      // 🔴 READ HERE, AT THE COMPARISON. Not defaulted in the engine.
      toleranceMinor: BigInt(header.toleranceMinor as string | bigint),
    }),
    unpostedBankLines: unmatchedInBank,
  };
}

/* ------------------------------------------------------------------ */
/* SIGN-OFF                                                            */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐⭐ FREEZE THE STATEMENT AND MOVE THE LOCK, IN ONE TRANSACTION.
 *
 * 🔴 THE ORDER MATTERS AND SO DOES THE ATOMICITY. Writing the artefact
 * without moving `reconciled_to` produces a signed statement that anybody
 * can invalidate the next minute. Moving `reconciled_to` without the
 * artefact produces a lock with nothing behind it — a date that refuses
 * edits and cannot say what it is protecting. Either half alone is worse
 * than neither.
 */
export async function freezeReconciliation(
  tx: Tx,
  args: {
    tenantId: string;
    userId: string;
    view: ReconciliationView;
    reconciledTo: string;
    previousReconciledTo: string | null;
    note: string | null;
  },
): Promise<{ reconciliationId: string; itemCount: number }> {
  const { brs } = args.view;

  const [row] = await tx
    .insert(bankReconciliations)
    .values({
      tenantId: args.tenantId,
      bankAccountId: args.view.bankAccountId,
      statementId: args.view.statementId,
      reconciledTo: args.reconciledTo,
      previousReconciledTo: args.previousReconciledTo,
      bankBalanceMinor: brs.bankBalanceMinor,
      bookBalanceMinor: brs.bookBalanceMinor,
      chequesNotPresentedMinor: brs.totals.chequesNotPresentedMinor,
      depositsNotCreditedMinor: brs.totals.depositsNotCreditedMinor,
      bankChargesMinor: brs.totals.bankChargesMinor,
      directCreditsMinor: brs.totals.directCreditsMinor,
      differenceMinor: brs.differenceMinor,
      toleranceMinor: brs.toleranceMinor,
      /**
       * 🔴 THE TOLERANCE'S WORK, RECORDED. A difference a tolerance let
       * through is a difference; the row says how much forever, and the
       * printed statement says so too.
       */
      differenceAbsorbedMinor: brs.differenceAbsorbedMinor,
      status: "signed_off",
      signedOffBy: args.userId,
      note: args.note,
    })
    .returning({ id: bankReconciliations.id });

  if (!row) throw new Error("The reconciliation could not be written.");

  if (brs.items.length > 0) {
    await tx.insert(bankReconciliationItems).values(
      brs.items.map((item) => ({
        tenantId: args.tenantId,
        reconciliationId: row.id,
        category: item.category,
        side: item.side,
        sourceId: item.sourceId,
        sourceKind: item.sourceKind,
        occurredOn: item.occurredOn,
        amountMinor: item.amountMinor,
        description: item.description,
      })),
    );
  }

  /**
   * 🔴🔴 THE LOCK ITSELF. This is the write that makes
   * `bank_accounts.reconciled_to` mean something, and `lineLockState`
   * above is what reads it back.
   */
  await tx
    .update(bankAccounts)
    .set({ reconciledTo: args.reconciledTo, updatedAt: new Date() })
    .where(
      and(
        eq(bankAccounts.tenantId, args.tenantId),
        eq(bankAccounts.id, args.view.bankAccountId),
      ),
    );

  return { reconciliationId: row.id, itemCount: brs.items.length };
}

/**
 * ⭐⭐ REOPENING PUTS THE LOCK BACK WHERE IT WAS, EXACTLY.
 *
 * ⚠️ NOT "TO THE PREVIOUS MONTH END" AND NOT "TO NULL". Either guess is
 * wrong in one direction: null unlocks every reconciliation the account
 * has ever had, and a computed month end unlocks or re-locks whatever
 * happens to fall near it. `previous_reconciled_to` was recorded at
 * sign-off precisely so this needs no arithmetic.
 *
 * ⭐ THE ROW IS KEPT, MARKED `reopened`. Deleting it would remove the
 * evidence that a signed figure was ever signed, which is the only thing
 * that makes reopening visible at all.
 */
export async function reopenReconciliation(
  tx: Tx,
  args: {
    tenantId: string;
    userId: string;
    reconciliationId: string;
    reason: string;
  },
): Promise<{ bankAccountId: string; restoredTo: string | null; reconciledTo: string }> {
  const [row] = await tx
    .select({
      id: bankReconciliations.id,
      bankAccountId: bankReconciliations.bankAccountId,
      reconciledTo: bankReconciliations.reconciledTo,
      previousReconciledTo: bankReconciliations.previousReconciledTo,
      status: bankReconciliations.status,
    })
    .from(bankReconciliations)
    .where(
      and(
        eq(bankReconciliations.tenantId, args.tenantId),
        eq(bankReconciliations.id, args.reconciliationId),
      ),
    )
    .limit(1);

  if (!row) throw new Error("No such reconciliation.");
  if (row.status !== "signed_off") {
    throw new Error("That reconciliation has already been reopened.");
  }

  const restoredTo =
    row.previousReconciledTo === null ? null : String(row.previousReconciledTo);

  await tx
    .update(bankReconciliations)
    .set({
      status: "reopened",
      reopenedAt: new Date(),
      reopenedBy: args.userId,
      reopenReason: args.reason,
    })
    .where(
      and(
        eq(bankReconciliations.tenantId, args.tenantId),
        eq(bankReconciliations.id, args.reconciliationId),
      ),
    );

  await tx
    .update(bankAccounts)
    .set({ reconciledTo: restoredTo, updatedAt: new Date() })
    .where(
      and(
        eq(bankAccounts.tenantId, args.tenantId),
        eq(bankAccounts.id, row.bankAccountId as string),
      ),
    );

  return {
    bankAccountId: row.bankAccountId as string,
    restoredTo,
    reconciledTo: String(row.reconciledTo),
  };
}
