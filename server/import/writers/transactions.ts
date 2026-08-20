/**
 * Ordence — writer: `transactions` (the opening trial balance)
 * Version: v1.85.0-alpha · Phase 1
 *
 * 🔴 THE ONLY DESTINATION WRITTEN AS ONE DOCUMENT FOR THE WHOLE FILE.
 *
 * An opening trial balance is a single balanced journal entry: every row
 * is a leg, they are written in one transaction, and they share one
 * outcome. Importing 38 of 40 lines does not give the customer 95% of
 * their opening position , it gives them a ledger that does not balance,
 * which the deferred constraint trigger would refuse anyway.
 *
 * So this writer implements `writeFile` and NOT `writeRow`, and the
 * registry refuses a writer carrying both or neither.
 *
 * ⚠️ MOVED, NOT REWRITTEN. Verbatim from `server/actions/import.ts`.
 */

import "server-only";

import { and, eq, gte, inArray, lte, or } from "drizzle-orm";
import { withTenant } from "@/db";
import {
  journalEntries,
  transactions,
} from "@/db/schema";
import { financialPeriods } from "@/db/schema/accounting";
import { openingBatchKey } from "@/lib/import";
import { minorOf, describeWriteFailure } from "./shared";
import type { ImportNaturalKey, ImportRowPlan } from "@/lib/import";
import type { TenantContext } from "@/server/tenant-context";
import { formatMoneyPlain } from "@/lib/billing/money";
import type { ImportWriter, PlannedWrite, WriteOutcome } from "./types";

async function findExisting(
  ctx: TenantContext,
  keys: readonly ImportNaturalKey[],
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (keys.length === 0) return found;

  const valuesOf = (kind: string) =>
    Array.from(new Set(keys.filter((k) => k.kind === kind).map((k) => k.value)));

  const keyValues = valuesOf("openingEntry");
  if (keyValues.length === 0) return found;

  const rows = await withTenant(ctx.tenant.id, (tx) =>
    tx
      .select({ id: transactions.id, number: transactions.transactionNumber })
      .from(transactions)
      .where(
        and(
          eq(transactions.tenantId, ctx.tenant.id),
          inArray(transactions.transactionNumber, keyValues),
        ),
      )
      .limit(10),
  );

  for (const row of rows) {
    if (row.number) found.set(`openingEntry:${row.number}`, row.id);
  }
  return found;
}

async function writeOpeningTrialBalance(
  ctx: TenantContext,
  planned: readonly PlannedWrite[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const first = planned[0];
  if (!first) return { ok: true };

  const asAt = String(first.payload.asAt ?? "");
  const key = openingBatchKey("trial_balance", asAt);

  let debitTotal = 0n;
  for (const item of planned) debitTotal += minorOf(item.payload.debitMinor);

  try {
    const refusal = await withTenant(ctx.tenant.id, async (tx) => {
      /*
       * 🔴🔴 THE PERIOD LOCK. `server/accounting/post-sales.ts` makes the
       * same check and says why: closing a period is a statement made to
       * an auditor that the numbers are final, and an import that keeps
       * landing entries inside a closed month is worse than having no
       * period close at all.
       *
       * ⚠️ AND AN OPENING BALANCE IS THE MOST LIKELY THING TO HIT IT,
       * because it is dated in the PAST by definition — usually the last
       * day of a financial year, which is exactly the period somebody
       * closes first.
       */
      const [locked] = await tx
        .select({ name: financialPeriods.name })
        .from(financialPeriods)
        .where(
          and(
            eq(financialPeriods.tenantId, ctx.tenant.id),
            lte(financialPeriods.startDate, asAt),
            gte(financialPeriods.endDate, asAt),
            inArray(financialPeriods.status, ["closed", "locked"]),
          ),
        )
        .limit(1);

      if (locked) {
        return (
          `${asAt} falls inside "${locked.name}", which is closed. Nothing has been ` +
          `posted. Reopen that period deliberately, or date the opening position ` +
          `to a day that is still open — closing a period is a statement that its ` +
          `numbers are final, so this refuses rather than quietly making it untrue.`
        );
      }

      const [txn] = await tx
        .insert(transactions)
        .values({
          tenantId: ctx.tenant.id,
          /*
           * 🔴 THE IDEMPOTENCY KEY, AND THE DATABASE HOLDS IT UNIQUE PER
           * TENANT. Our own check ran in `findExistingByNaturalKey`
           * above and produced a readable outcome; this index is what
           * makes two people pressing the button at the same moment
           * safe, and it cannot be forgotten by a future caller.
           */
          transactionNumber: key,
          description: `Opening balances as at ${asAt}`,
          transactionDate: asAt,
          status: "posted",
          referenceType: "opening_balance",
          currency: "INR",
          /*
           * ⚠️ THE DEBIT SIDE, NOT THE SUM OF EVERY LEG. Adding both
           * sides reports an opening position of ₹20,00,000 as
           * ₹40,00,000 — exactly twice the truth, and entirely plausible
           * on a list of transactions.
           */
          totalAmount: formatMoneyPlain(debitTotal, "INR"),
          createdBy: ctx.user.id,
          postedAt: new Date(),
          metadata: { source: "import", asAt, lines: planned.length },
        })
        .returning({ id: transactions.id });

      if (!txn) throw new Error("The opening journal entry could not be created.");

      await tx.insert(journalEntries).values(
        planned.map((item) => {
          const debit = minorOf(item.payload.debitMinor);
          const credit = minorOf(item.payload.creditMinor);
          const isDebit = debit > 0n;
          return {
            tenantId: ctx.tenant.id,
            transactionId: txn.id,
            ledgerId: String(item.payload.ledgerId),
            entryType: isDebit ? ("debit" as const) : ("credit" as const),
            /*
             * ⭐ THE INTEGER, WRITTEN AS AN INTEGER. Batch 0108.
             *
             * ⚠️ THIS WAS `formatMoneyPlain(x, "INR")` — a bigint turned
             * into a two-decimal string on the way into a numeric(18,2),
             * with the currency hardcoded. The import already counts in
             * minor units (`debitMinor` / `creditMinor` above); the round
             * trip through a decimal string existed only because the
             * column could not hold what the importer already had.
             */
            amountMinor: isDebit ? debit : credit,
            description: `Opening balance as at ${asAt}`,
            referenceType: "opening_balance" as const,
          };
        }),
      );

      return null;
    });

    if (refusal) return { ok: false, error: refusal };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeWriteFailure(err) };
  }
}

export const transactionsWriter: ImportWriter = {
  revalidatePath: "/accounting",
  findExisting,
  writeFile: (ctx, planned) => writeOpeningTrialBalance(ctx, planned),
};
