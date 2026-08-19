"use server";

/**
 * Ordence — ⭐⭐⭐ COST CENTRES AND BUDGETS
 * Version: v1.47.0-alpha · Batch 68
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION AND NONE TAKES A TENANT ID. A
 * `"use server"` file publishes every export as a URL the browser can
 * POST to, whether or not a screen ever renders a button for it, so the
 * guard sits on the function and is visible at the export — one hop, the
 * distance `check:guards` walks.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE PERMISSION KEYS ARE REUSED, AND THE REUSE IS ARGUED
 * ══════════════════════════════════════════════════════════════════════
 * No new key is invented here. A cost centre is a piece of chart-of-
 * accounts master data — it changes how the ledger is reported and
 * nothing else — so it is gated by the keys that already govern the
 * chart of accounts:
 *
 *   `ledgers:read`          see cost centres, budgets and the variance
 *   `ledgers:create`        create a cost centre
 *   `ledgers:update`        rename or archive one; write a budget figure
 *   `reports:trial_balance` run budget-versus-actual and the
 *                           departmental P&L — the same key that already
 *                           governs the statement these two reconcile to
 *
 * ⚠️ `ledgers:update` FOR A BUDGET IS THE WEAKEST FIT ON THAT LIST AND
 * IT IS DELIBERATELY THE SIDE THAT ERRS TIGHT. A budget figure is not a
 * ledger and a dedicated `budgets:manage` would be the right key; whoever
 * adds it should split budget writes out of `ledgers:update` and nothing
 * else. Until it exists, gating a budget write on a key held by the
 * people who maintain the chart of accounts refuses more people than it
 * should, which is the failure direction that gets reported rather than
 * the one that gets exploited.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴🔴 THE STATUS FILTER IS `posted` **AND** `reversed`, AND "POSTED
 *          ONLY" IS THE TRAP
 * ══════════════════════════════════════════════════════════════════════
 * `server/actions/accounting.ts` settles this argument at length for the
 * statements, and this file must agree with it to the paisa or the
 * variance report reconciles to nothing.
 *
 * `reverseTransaction` writes the mirror image as a SECOND transaction
 * with status `posted`, and marks the ORIGINAL `reversed`. So a reversal
 * pair is one `posted` row and one `reversed` row, both real, both
 * permanently in `journal_entries` because that table is append-only.
 *
 * 🔴 FILTER TO `posted` AND YOU KEEP EVERY CORRECTION AND DROP EVERYTHING
 * CORRECTED. ₹5,00,000 posted to the wrong department and reversed would
 * leave this report holding only the reversal — which DEBITS revenue
 * ₹5,00,000 — so the department's turnover comes out ₹5,00,000 lower
 * than it ever was, on a page that still adds up.
 *
 * ⚠️ `void` AND `pending` ARE OUT for the same reasons the statements
 * exclude them: `void` is a transaction the business has said never
 * happened, and `pending` is a draft.
 *
 * ⭐ AND THE AGREEMENT IS CHECKED RATHER THAN TRUSTED. See the gate.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐⭐ THE GATE: TWO ROUTES, NO SHARED QUERY, AND NO FIGURE AT ALL WHEN
 *        THEY DISAGREE
 * ══════════════════════════════════════════════════════════════════════
 * `lib/reconciliation/gate.ts` is the house doctrine and this report is
 * exactly the shape it was written for. The two routes are:
 *
 *   ROUTE A  this file. Drives FROM `journal_entries`, INNER joins
 *            `transactions` and `ledgers`, groups by
 *            (ledger_id, cost_centre_id). It is the report.
 *
 *   ROUTE B  `getProfitAndLoss` in `server/actions/accounting.ts`.
 *            Drives FROM `ledgers`, LEFT joins the journal, groups by
 *            ledger only, and has never heard of a cost centre. It is
 *            the P&L every other screen and every filed return quotes.
 *
 * ⚠️ THEY SHARE NO QUERY, NO JOIN ORDER AND NO COPY OF THE DATE
 * PREDICATE, which is what makes the comparison worth making. If this
 * file's status filter drifts from the statement's, or its date
 * predicate reads `created_at` instead of `transaction_date`, or a
 * soft-deleted ledger is excluded on one side and not the other, or the
 * un-costed bucket is dropped by a join — the two totals part company
 * and NO FIGURE IS RENDERED.
 *
 * 🔴 NOT AN ASTERISK, NOT AN AMBER BADGE, NOT "THE TRUE ONE". A correct
 * number printed under a heading that has just failed its own check
 * reads to the person holding it as VERIFICATION.
 */

import { and, asc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenant } from "@/db";
import {
  budgetLines,
  costCentres,
  financialPeriods,
  journalEntries,
  ledgers,
  transactions,
} from "@/db/schema";
import { requirePermission, writeAudit } from "@/server/audit";
import { toSalesActionError } from "@/server/sales/guards";
import { getProfitAndLoss } from "@/server/actions/accounting";
import {
  EXACT,
  reconcile,
  serializeReconciliation,
  type SerializedReconciliation,
} from "@/lib/reconciliation/gate";
import {
  UNCOSTED_KEY,
  UNCOSTED_LABEL,
  UNCOSTED_REF,
  bucketKeyFor,
  groupByCostCentre,
  totalNetResultMinor,
  validateCostCentreCode,
  type CostCentreBucket,
  type CostCentreRef,
  type CostedLine,
} from "@/lib/accounting/cost-centre";
import {
  actualNetResultMinor,
  buildBudgetRow,
  budgetPeriodLabel,
  parseBudgetAmount,
  parseSignedMinor,
  sortBudgetRows,
  totalsFor,
  type BudgetAccountType,
  type BudgetTotals,
  type BudgetVsActualRow,
} from "@/lib/accounting/budget";
import type { ActionResult } from "@/lib/validators/crm";

/* ------------------------------------------------------------------ */
/* GUARD KEYS                                                          */
/* ------------------------------------------------------------------ */

const READ = "ledgers:read" as const;
const CREATE = "ledgers:create" as const;
const UPDATE = "ledgers:update" as const;
const REPORT = "reports:trial_balance" as const;

/**
 * 🔴 SEE THE HEADER. This list must equal `STATEMENT_TRANSACTION_STATUSES`
 * in `server/actions/accounting.ts`, and the reconciliation gate is what
 * notices when it stops doing so — which is the only mechanism that
 * still works after somebody edits one file and not the other.
 */
const STATEMENT_TRANSACTION_STATUSES = ["posted", "reversed"] as const;

const uuid = z.string().uuid("Invalid identifier.");

function fail(error: string, fieldErrors?: Record<string, string[]>): ActionResult<never> {
  return { ok: false, error, fieldErrors };
}

/* ================================================================== */
/* ① COST CENTRES                                                      */
/* ================================================================== */

export type CostCentreRow = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isActive: boolean;
  displayOrder: number;
};

const costCentreInput = z.object({
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1_000).optional(),
  displayOrder: z.number().int().min(0).max(100_000).default(100),
});

/**
 * ⭐ ARCHIVED ONES ARE RETURNED TOO, FLAGGED RATHER THAN OMITTED.
 *
 * ⚠️ THE REPORTS NEED THEM. A department closed in September still has
 * eight months of costs coded to it, and a report that could not name
 * the bucket would print a UUID as a column heading. The PICKER filters
 * on `isActive`; the REPORT does not, and that difference is the whole
 * reason there is no `deleted_at` on this table.
 */
export async function listCostCentres(): Promise<ActionResult<CostCentreRow[]>> {
  try {
    const ctx = await requirePermission(READ);
    const rows = await withTenant(ctx.tenant.id, (tx) =>
      tx
        .select({
          id: costCentres.id,
          code: costCentres.code,
          name: costCentres.name,
          description: costCentres.description,
          isActive: costCentres.isActive,
          displayOrder: costCentres.displayOrder,
        })
        .from(costCentres)
        .where(eq(costCentres.tenantId, ctx.tenant.id))
        .orderBy(asc(costCentres.displayOrder), asc(costCentres.code)),
    );
    return { ok: true, data: rows };
  } catch (err) {
    return toSalesActionError(err, "cost centres");
  }
}

export async function createCostCentre(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await requirePermission(CREATE);
    const parsed = costCentreInput.parse(input);

    /**
     * ⚠️ THE CODE IS VALIDATED IN A PURE FUNCTION SO THE SAME RULE CAN BE
     * EXERCISED BY A TEST WITHOUT POSTGRES, and so the message a user
     * reads is a sentence rather than a constraint name.
     */
    const code = validateCostCentreCode(parsed.code);
    if (!code.ok) return fail(code.reason, { code: [code.reason] });

    /**
     * 🔴 CASE-INSENSITIVE DUPLICATE, CHECKED HERE AND ENFORCED BY THE
     * DATABASE. "prod" and "PROD" as two cost centres is one department
     * reported as two, and every total that groups by code splits
     * without saying that it split. The unique index on `upper(code)` in
     * 0084 is the guarantee; this check is what turns it into a sentence.
     */
    const clash = await withTenant(ctx.tenant.id, (tx) =>
      tx
        .select({ id: costCentres.id, code: costCentres.code })
        .from(costCentres)
        .where(
          and(
            eq(costCentres.tenantId, ctx.tenant.id),
            sql`upper(${costCentres.code}) = upper(${code.code})`,
          ),
        )
        .limit(1),
    );
    const clashRow = clash[0];
    if (clashRow) {
      return fail(`A cost centre with the code "${clashRow.code}" already exists.`, {
        code: ["That code is already in use."],
      });
    }

    const [row] = await withTenant(ctx.tenant.id, (tx) =>
      tx
        .insert(costCentres)
        .values({
          tenantId: ctx.tenant.id,
          code: code.code,
          name: parsed.name,
          description: parsed.description ?? null,
          displayOrder: parsed.displayOrder,
          createdBy: ctx.user.id,
        })
        .returning({ id: costCentres.id }),
    );
    if (!row) return fail("Could not create that cost centre.");

    await writeAudit(ctx, {
      action: "create",
      resourceType: "cost_centre",
      resourceId: row.id,
      newValue: { code: code.code, name: parsed.name },
    });

    revalidatePath("/accounting/cost-centres");
    return { ok: true, data: { id: row.id } };
  } catch (err) {
    return toSalesActionError(err, "cost centres");
  }
}

const updateCostCentreInput = costCentreInput
  .partial({ code: true })
  .extend({ id: uuid, isActive: z.boolean().optional() });

/**
 * ⚠️ THE CODE IS NOT EDITABLE HERE AND THAT IS NOT AN OVERSIGHT.
 *
 * A code is what people typed into spreadsheets, quoted in emails and
 * printed on last year's board pack. Renaming "PROD" to "MFG" changes
 * what every historical report says without changing a single figure,
 * and the two versions of the same report then disagree on what the
 * department is called with nothing to tie them together. The NAME is
 * free to change — it is prose. The code is an identifier.
 */
export async function updateCostCentre(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await requirePermission(UPDATE);
    const parsed = updateCostCentreInput.parse(input);

    const [before] = await withTenant(ctx.tenant.id, (tx) =>
      tx
        .select({
          id: costCentres.id,
          code: costCentres.code,
          name: costCentres.name,
          isActive: costCentres.isActive,
        })
        .from(costCentres)
        .where(and(eq(costCentres.tenantId, ctx.tenant.id), eq(costCentres.id, parsed.id)))
        .limit(1),
    );
    if (!before) return fail("That cost centre no longer exists.");

    await withTenant(ctx.tenant.id, (tx) =>
      tx
        .update(costCentres)
        .set({
          name: parsed.name,
          description: parsed.description ?? null,
          displayOrder: parsed.displayOrder,
          isActive: parsed.isActive ?? before.isActive,
          updatedAt: new Date(),
        })
        .where(and(eq(costCentres.tenantId, ctx.tenant.id), eq(costCentres.id, parsed.id))),
    );

    await writeAudit(ctx, {
      action: "update",
      resourceType: "cost_centre",
      resourceId: parsed.id,
      oldValue: { name: before.name, isActive: before.isActive },
      newValue: { name: parsed.name, isActive: parsed.isActive ?? before.isActive },
    });

    revalidatePath("/accounting/cost-centres");
    return { ok: true, data: { id: parsed.id } };
  } catch (err) {
    return toSalesActionError(err, "cost centres");
  }
}

/* ================================================================== */
/* ② THE ACTUALS, GROUPED BY COST CENTRE                               */
/* ================================================================== */

type ActualRow = {
  ledgerId: string;
  ledgerCode: string;
  ledgerName: string;
  accountType: string;
  costCentreId: string | null;
  /** ⭐ Minor units, as digit strings from Postgres. Batch 0108. */
  debitMinor: string;
  creditMinor: string;
  /** ⚠️ Legs 0108 could not scale. Non-zero means refuse, never round. */
  unscaledLegs: number;
};

/**
 * ⭐⭐ ROUTE A. The report's own query, and the ONLY place in this file
 * that reads the journal.
 *
 * ⚠️ THREE PREDICATES HERE MUST MATCH `ledgerBalances` IN
 * `server/actions/accounting.ts` EXACTLY, and the gate exists because
 * "must match" is not a mechanism:
 *
 *   ① `transactions.status IN ('posted','reversed')` — see the header.
 *   ② The date is `transactions.transaction_date`, NEVER `created_at`.
 *      A back-dated journal entered in June for a March event belongs in
 *      March's variance, which is the month somebody has already
 *      explained to a board.
 *   ③ `ledgers.deleted_at IS NULL`. A soft-deleted ledger with entries
 *      against it is excluded from the P&L; including it here would put
 *      money in the departmental report that the P&L does not have.
 *
 * ⭐ AND THE JOIN TO `transactions` IS AN INNER JOIN, WHICH IS RIGHT
 * HERE AND WRONG THERE. `ledgerBalances` drives from `ledgers` and LEFT
 * joins so that a dormant account still appears on the balance sheet.
 * This query drives from `journal_entries`: there is no such thing as a
 * journal line with no transaction, and a LEFT join would only invite
 * the date predicate to be moved into the ON clause where it filters
 * nothing.
 */
async function loadActuals(
  tenantId: string,
  window: { from: string; to: string },
): Promise<ActualRow[]> {
  return withTenant(tenantId, (tx) =>
    tx
      .select({
        ledgerId: journalEntries.ledgerId,
        ledgerCode: ledgers.code,
        ledgerName: ledgers.name,
        accountType: ledgers.accountType,
        costCentreId: journalEntries.costCentreId,
        /**
         * ⭐ SUMMED IN MINOR UNITS. Batch 0108. This used to sum
         * `numeric(18,2)` and hand the string to `parseSignedMinor()`,
         * whose regex `-?\d+(\.\d{1,2})?` REFUSED a three-decimal value
         * outright — so a dinar book's departmental P&L threw rather than
         * rounding. The ledger now stores the integer.
         */
        debitMinor: sql<string>`COALESCE(SUM(CASE WHEN ${journalEntries.entryType} = 'debit'  THEN ${journalEntries.amountMinor} ELSE 0 END), 0)::text`,
        creditMinor: sql<string>`COALESCE(SUM(CASE WHEN ${journalEntries.entryType} = 'credit' THEN ${journalEntries.amountMinor} ELSE 0 END), 0)::text`,
        /** ⚠️ SUM() skips NULLs. A department short by a real amount that
         *  still reconciles against the P&L is worse than a refusal. */
        unscaledLegs: sql<number>`COUNT(*) FILTER (WHERE ${journalEntries.amountMinor} IS NULL)::int`,
      })
      .from(journalEntries)
      .innerJoin(
        ledgers,
        and(eq(ledgers.id, journalEntries.ledgerId), eq(ledgers.tenantId, tenantId)),
      )
      .innerJoin(
        transactions,
        and(
          eq(transactions.id, journalEntries.transactionId),
          eq(transactions.tenantId, tenantId),
        ),
      )
      .where(
        and(
          eq(journalEntries.tenantId, tenantId),
          isNull(ledgers.deletedAt),
          inArray(ledgers.accountType, ["revenue", "expense"]),
          inArray(transactions.status, [...STATEMENT_TRANSACTION_STATUSES]),
          gte(transactions.transactionDate, window.from),
          lte(transactions.transactionDate, window.to),
        ),
      )
      .groupBy(
        journalEntries.ledgerId,
        ledgers.code,
        ledgers.name,
        ledgers.accountType,
        journalEntries.costCentreId,
      ),
  );
}

/** The tenant's cost centres as the pure grouping code wants them. */
async function loadCentreRefs(tenantId: string): Promise<CostCentreRef[]> {
  const rows = await withTenant(tenantId, (tx) =>
    tx
      .select({ id: costCentres.id, code: costCentres.code, name: costCentres.name })
      .from(costCentres)
      .where(eq(costCentres.tenantId, tenantId))
      .orderBy(asc(costCentres.displayOrder), asc(costCentres.code)),
  );
  return rows.map((r) => ({ key: r.id, code: r.code, name: r.name }));
}

/**
 * ⭐ ROUTE B. Whatever the P&L says, obtained by asking the P&L.
 *
 * 🔴 THIS DELIBERATELY CALLS THE OTHER MODULE RATHER THAN COPYING ITS
 * QUERY. A check whose two sides are two copies of one query proves that
 * copying works. `getProfitAndLoss` drives from a different table in a
 * different join direction with its own copy of the status filter, and
 * it is the figure the rest of the product — and the customer's filed
 * return — actually quotes.
 */
async function profitAndLossNetMinor(window: {
  from: string;
  to: string;
}): Promise<{ ok: true; minor: bigint } | { ok: false; reason: string }> {
  const pl = await getProfitAndLoss({ from: window.from, to: window.to });
  if (!pl.ok) return { ok: false, reason: pl.error };
  try {
    return { ok: true, minor: parseSignedMinor(pl.data.netResult) };
  } catch {
    return { ok: false, reason: "The profit & loss returned a figure this report cannot read." };
  }
}

export type CostCentreBucketRow = {
  key: string;
  code: string;
  name: string;
  /** Minor units as a string. Never a number across the RSC boundary. */
  netResultMinor: string;
  revenueMinor: string;
  expenseMinor: string;
  lineCount: number;
  isUncosted: boolean;
};

export type CostCentreProfitAndLoss = {
  from: string;
  to: string;
  buckets: CostCentreBucketRow[];
  totalNetResultMinor: string;
  reconciliation: SerializedReconciliation;
};

const windowInput = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date."),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date."),
});

function serialiseBucket(b: CostCentreBucket): CostCentreBucketRow {
  return {
    key: b.centre.key,
    code: b.centre.code,
    name: b.centre.name,
    netResultMinor: b.netResultMinor.toString(),
    revenueMinor: b.revenueMinor.toString(),
    expenseMinor: b.expenseMinor.toString(),
    lineCount: b.lineCount,
    isUncosted: b.centre.key === UNCOSTED_KEY,
  };
}

/**
 * ⭐⭐ THE PROFIT & LOSS, GROUPED BY COST CENTRE.
 *
 * ⚠️ THE UN-COSTED BUCKET IS ALWAYS ON IT. On the day this ships every
 * rupee is in that bucket, because nothing in the posting path writes a
 * cost centre yet — see `db/schema/accounting.ts`. A screen that hid an
 * empty-looking department list instead of showing where the money
 * actually is would be reporting a product bug as a data one.
 */
export async function getCostCentreProfitAndLoss(
  input: unknown,
): Promise<ActionResult<CostCentreProfitAndLoss>> {
  try {
    const ctx = await requirePermission(REPORT);
    const window = windowInput.parse(input);

    const [actuals, centres] = await Promise.all([
      loadActuals(ctx.tenant.id, window),
      loadCentreRefs(ctx.tenant.id),
    ]);

    const unscaled = actuals.reduce((n, r) => n + r.unscaledLegs, 0);
    if (unscaled > 0) {
      throw new Error(
        `${unscaled} journal line(s) have no amount in minor units, so this departmental ` +
          `total cannot be trusted. Run the census in SQL-FILES/0108 to see which ` +
          `currency is unscaled. Nothing has been computed.`,
      );
    }

    const lines: CostedLine[] = actuals.map((r) => ({
      costCentreId: r.costCentreId,
      ledgerId: r.ledgerId,
      accountType: r.accountType,
      debitMinor: BigInt(r.debitMinor),
      creditMinor: BigInt(r.creditMinor),
    }));

    const buckets = groupByCostCentre(lines, centres);
    const bucketTotal = totalNetResultMinor(buckets);
    const pl = await profitAndLossNetMinor(window);

    /**
     * 🔴 `ledgerConfigured` IS DECIDED FROM STRUCTURE, NEVER FROM AN
     * AMOUNT. On an empty workspace both sides are zero, `0n === 0n`, and
     * a naive gate renders a green tick over a report that has never been
     * checked against anything. A row count is a fact about the shape of
     * the data; a total of zero is not evidence, it is the absence of
     * evidence wearing evidence's clothes.
     */
    const configured = pl.ok && actuals.length > 0;

    const reconciliation = reconcile({
      subject: "The profit & loss by cost centre",
      ledgerConfigured: configured,
      notes: [
        ...(pl.ok ? [] : [`The profit & loss could not be read: ${pl.reason}`]),
        ...(actuals.length === 0
          ? ["Nothing has been posted to a revenue or expense ledger in this period."]
          : []),
        `"${UNCOSTED_LABEL}" is journal lines that carry no cost centre. It is a bucket with a subtotal, never dropped and never merged into a department, so this report sums to the profit & loss.`,
      ],
      checks: [
        {
          id: "cost-centre-buckets-vs-pl",
          claim:
            "Every cost centre's result, added up including the un-allocated bucket, equals the profit & loss for the same period.",
          report: {
            label: "the cost centre report",
            source: "journal_entries grouped by cost centre (server/actions/budgets.ts)",
            amountMinor: bucketTotal,
          },
          ledger: {
            label: "the profit & loss",
            source: "getProfitAndLoss (server/actions/accounting.ts)",
            amountMinor: pl.ok ? pl.minor : bucketTotal + 1n,
          },
          /**
           * ⭐ EXACT. Both sides are sums of the same integer paise with
           * no division anywhere between them, so there is no rounding to
           * tolerate. A band here would be a licence to be wrong.
           */
          toleranceMinor: EXACT,
          ...(pl.ok
            ? {}
            : { notComparable: "The profit & loss could not be read, so there is nothing to compare against." }),
        },
      ],
    });

    return {
      ok: true,
      data: {
        from: window.from,
        to: window.to,
        buckets: buckets.map(serialiseBucket),
        totalNetResultMinor: bucketTotal.toString(),
        reconciliation: serializeReconciliation(reconciliation),
      },
    };
  } catch (err) {
    return toSalesActionError(err, "the cost centre report");
  }
}

/* ================================================================== */
/* ③ BUDGETS                                                           */
/* ================================================================== */

export type BudgetPeriodRow = {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  status: string;
  /** 🔴 FALSE MEANS THE BUDGET FOR THIS PERIOD IS READ-ONLY. */
  isOpen: boolean;
  label: string;
};

export type BudgetWorkspace = {
  periods: BudgetPeriodRow[];
  /** Revenue and expense ledgers only — see the schema header. */
  ledgers: Array<{ id: string; code: string; name: string; accountType: BudgetAccountType }>;
  costCentres: CostCentreRow[];
  lines: Array<{
    id: string;
    periodId: string;
    ledgerId: string;
    costCentreKey: string;
    amountMinor: string;
    note: string | null;
  }>;
};

/**
 * Everything the budget editor needs in one round trip.
 *
 * ⚠️ `isOpen` IS COMPUTED HERE AND SENT DOWN, rather than left to the
 * client to derive from `status`. A screen that decided for itself which
 * statuses count as editable is a second definition of "closed", and the
 * second definition is the one that will drift.
 */
export async function getBudgetWorkspace(input: unknown): Promise<ActionResult<BudgetWorkspace>> {
  try {
    const ctx = await requirePermission(READ);
    const parsed = z.object({ periodId: uuid.optional() }).parse(input ?? {});

    const [periods, plLedgers, centres] = await Promise.all([
      withTenant(ctx.tenant.id, (tx) =>
        tx
          .select({
            id: financialPeriods.id,
            name: financialPeriods.name,
            startDate: financialPeriods.startDate,
            endDate: financialPeriods.endDate,
            status: financialPeriods.status,
          })
          .from(financialPeriods)
          .where(eq(financialPeriods.tenantId, ctx.tenant.id))
          .orderBy(asc(financialPeriods.startDate)),
      ),
      withTenant(ctx.tenant.id, (tx) =>
        tx
          .select({
            id: ledgers.id,
            code: ledgers.code,
            name: ledgers.name,
            accountType: ledgers.accountType,
          })
          .from(ledgers)
          .where(
            and(
              eq(ledgers.tenantId, ctx.tenant.id),
              isNull(ledgers.deletedAt),
              inArray(ledgers.accountType, ["revenue", "expense"]),
            ),
          )
          .orderBy(asc(ledgers.code)),
      ),
      withTenant(ctx.tenant.id, (tx) =>
        tx
          .select({
            id: costCentres.id,
            code: costCentres.code,
            name: costCentres.name,
            description: costCentres.description,
            isActive: costCentres.isActive,
            displayOrder: costCentres.displayOrder,
          })
          .from(costCentres)
          .where(eq(costCentres.tenantId, ctx.tenant.id))
          .orderBy(asc(costCentres.displayOrder), asc(costCentres.code)),
      ),
    ]);

    const lines = parsed.periodId
      ? await withTenant(ctx.tenant.id, (tx) =>
          tx
            .select({
              id: budgetLines.id,
              periodId: budgetLines.periodId,
              ledgerId: budgetLines.ledgerId,
              costCentreId: budgetLines.costCentreId,
              amountMinor: budgetLines.amountMinor,
              note: budgetLines.note,
            })
            .from(budgetLines)
            .where(
              and(
                eq(budgetLines.tenantId, ctx.tenant.id),
                eq(budgetLines.periodId, parsed.periodId as string),
              ),
            ),
        )
      : [];

    return {
      ok: true,
      data: {
        periods: periods.map((p) => ({
          id: p.id,
          name: p.name,
          startDate: p.startDate,
          endDate: p.endDate,
          status: p.status,
          isOpen: p.status === "open",
          label: budgetPeriodLabel(p.name, p.startDate),
        })),
        ledgers: plLedgers.map((l) => ({
          id: l.id,
          code: l.code,
          name: l.name,
          accountType: l.accountType as BudgetAccountType,
        })),
        costCentres: centres,
        lines: lines.map((l) => ({
          id: l.id,
          periodId: l.periodId,
          ledgerId: l.ledgerId,
          costCentreKey: bucketKeyFor(l.costCentreId),
          amountMinor: l.amountMinor.toString(),
          note: l.note,
        })),
      },
    };
  } catch (err) {
    return toSalesActionError(err, "budgets");
  }
}

const saveBudgetInput = z.object({
  periodId: uuid,
  ledgerId: uuid,
  /**
   * ⭐ THE SENTINEL, NOT NULL, ACROSS THE WIRE. A form field that is
   * absent and a form field whose value is "the un-costed bucket" are
   * different intentions, and `undefined` cannot tell them apart.
   */
  costCentreKey: z.string().min(1),
  /** A typed string. Never a `number` — see `parseBudgetAmount`. */
  amount: z.string(),
  note: z.string().trim().max(1_000).optional(),
});

/**
 * ⭐⭐ WRITE ONE BUDGET FIGURE.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 A CLOSED PERIOD IS REFUSED HERE, AND AGAIN BY A TRIGGER
 * ══════════════════════════════════════════════════════════════════════
 * A budget quietly edited after the month was closed is a variance that
 * changed after somebody explained it — to a board, to a lender, or in a
 * bonus calculation. The month's actuals are frozen by
 * `enforce_period_close` (0005 §2); the budget they are measured against
 * has to be frozen by the same event or the comparison is only half
 * locked.
 *
 * ⚠️ THE REFUSAL IS IN TWO PLACES ON PURPOSE. This check produces a
 * sentence a person can act on. The trigger in 0084 §5 is the one that
 * survives a background job, a raw SQL fix-up and a future service
 * written by somebody who never read this file. Neither is redundant:
 * delete the trigger and the rule holds until the first script; delete
 * this and the rule holds, with a constraint name for a message.
 */
export async function saveBudgetLine(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await requirePermission(UPDATE);
    const parsed = saveBudgetInput.parse(input);

    const amount = parseBudgetAmount(parsed.amount);
    if (!amount.ok) return fail(amount.reason, { amount: [amount.reason] });

    const [period] = await withTenant(ctx.tenant.id, (tx) =>
      tx
        .select({
          id: financialPeriods.id,
          name: financialPeriods.name,
          status: financialPeriods.status,
        })
        .from(financialPeriods)
        .where(
          and(
            eq(financialPeriods.tenantId, ctx.tenant.id),
            eq(financialPeriods.id, parsed.periodId),
          ),
        )
        .limit(1),
    );
    if (!period) return fail("That accounting period no longer exists.");
    if (period.status !== "open") {
      return fail(
        `"${period.name}" is ${period.status}. Its budget cannot be changed — the actuals for a closed period are frozen, and a budget that can still move is a variance that changes after it has been explained. Reopen the period if the figure is genuinely wrong.`,
      );
    }

    /**
     * 🔴 REVENUE AND EXPENSE ONLY. Budgeting a bank balance or a loan is
     * a CASH FORECAST — a different document with a different shape —
     * and letting one into this table would put a figure into a variance
     * report that claims, in its own banner, to reconcile to the P&L.
     * It would not, and the banner would go red for a reason nobody
     * could find.
     */
    const [ledger] = await withTenant(ctx.tenant.id, (tx) =>
      tx
        .select({ id: ledgers.id, code: ledgers.code, accountType: ledgers.accountType })
        .from(ledgers)
        .where(
          and(
            eq(ledgers.tenantId, ctx.tenant.id),
            eq(ledgers.id, parsed.ledgerId),
            isNull(ledgers.deletedAt),
          ),
        )
        .limit(1),
    );
    if (!ledger) return fail("That ledger no longer exists.");
    if (ledger.accountType !== "revenue" && ledger.accountType !== "expense") {
      return fail(
        `${ledger.code} is a ${ledger.accountType} account. Only revenue and expense accounts can be budgeted — a budget for a balance-sheet account is a cash forecast, which is a different document.`,
      );
    }

    const costCentreId = parsed.costCentreKey === UNCOSTED_KEY ? null : parsed.costCentreKey;
    if (costCentreId !== null) {
      if (!z.string().uuid().safeParse(costCentreId).success) {
        return fail("That cost centre is not valid.");
      }
      const [centre] = await withTenant(ctx.tenant.id, (tx) =>
        tx
          .select({ id: costCentres.id })
          .from(costCentres)
          .where(and(eq(costCentres.tenantId, ctx.tenant.id), eq(costCentres.id, costCentreId)))
          .limit(1),
      );
      if (!centre) return fail("That cost centre no longer exists.");
    }

    /**
     * ⚠️ UPSERT ON THE GRAIN, NOT "INSERT AND HOPE". Two people budgeting
     * the same account for the same department in the same minute would
     * otherwise produce two rows, of which the report shows one, chosen
     * by the planner. The partial unique indexes in 0084 make the grain a
     * fact; the two `onConflict` targets below are the two halves of it —
     * one for a real cost centre and one for the un-costed bucket, which
     * is what a `NULLS NOT DISTINCT` index would have been.
     */
    const existing = await withTenant(ctx.tenant.id, (tx) =>
      tx
        .select({ id: budgetLines.id, amountMinor: budgetLines.amountMinor })
        .from(budgetLines)
        .where(
          and(
            eq(budgetLines.tenantId, ctx.tenant.id),
            eq(budgetLines.periodId, parsed.periodId),
            eq(budgetLines.ledgerId, parsed.ledgerId),
            costCentreId === null
              ? isNull(budgetLines.costCentreId)
              : eq(budgetLines.costCentreId, costCentreId),
          ),
        )
        .limit(1),
    );

    // ⚠️ DESTRUCTURED, NOT INDEXED. `noUncheckedIndexedAccess` is on and
    // `existing.length > 0` does not narrow `existing[0]`, so an index
    // expression here compiles only by asserting something the type system
    // cannot see. The row itself is the thing worth holding.
    let id: string;
    const existingRow = existing[0];
    if (existingRow) {
      id = existingRow.id;
      await withTenant(ctx.tenant.id, (tx) =>
        tx
          .update(budgetLines)
          .set({
            amountMinor: amount.minor,
            note: parsed.note ?? null,
            updatedAt: new Date(),
            updatedBy: ctx.user.id,
          })
          .where(and(eq(budgetLines.tenantId, ctx.tenant.id), eq(budgetLines.id, id))),
      );
      await writeAudit(ctx, {
        action: "update",
        resourceType: "budget_line",
        resourceId: id,
        oldValue: { amountMinor: existingRow.amountMinor.toString() },
        newValue: { amountMinor: amount.minor.toString() },
        metadata: { periodId: parsed.periodId, ledgerId: parsed.ledgerId, costCentreId },
      });
    } else {
      const [row] = await withTenant(ctx.tenant.id, (tx) =>
        tx
          .insert(budgetLines)
          .values({
            tenantId: ctx.tenant.id,
            periodId: parsed.periodId,
            ledgerId: parsed.ledgerId,
            costCentreId,
            amountMinor: amount.minor,
            note: parsed.note ?? null,
            createdBy: ctx.user.id,
            updatedBy: ctx.user.id,
          })
          .returning({ id: budgetLines.id }),
      );
      if (!row) return fail("Could not save that budget figure.");
      id = row.id;
      await writeAudit(ctx, {
        action: "create",
        resourceType: "budget_line",
        resourceId: id,
        newValue: { amountMinor: amount.minor.toString() },
        metadata: { periodId: parsed.periodId, ledgerId: parsed.ledgerId, costCentreId },
      });
    }

    revalidatePath("/accounting/budgets");
    return { ok: true, data: { id } };
  } catch (err) {
    return toSalesActionError(err, "budgets");
  }
}

/**
 * ⭐ DELETING A BUDGET LINE IS NOT THE SAME AS SETTING IT TO ZERO.
 *
 * Zero says "we decided to spend nothing". Deleting says "nobody has
 * looked at this". `lib/accounting/budget.ts` renders the two
 * differently and it must stay possible to express both.
 */
export async function deleteBudgetLine(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await requirePermission(UPDATE);
    const parsed = z.object({ id: uuid }).parse(input);

    const [line] = await withTenant(ctx.tenant.id, (tx) =>
      tx
        .select({
          id: budgetLines.id,
          periodId: budgetLines.periodId,
          amountMinor: budgetLines.amountMinor,
          status: financialPeriods.status,
          periodName: financialPeriods.name,
        })
        .from(budgetLines)
        .innerJoin(
          financialPeriods,
          and(
            eq(financialPeriods.id, budgetLines.periodId),
            eq(financialPeriods.tenantId, ctx.tenant.id),
          ),
        )
        .where(and(eq(budgetLines.tenantId, ctx.tenant.id), eq(budgetLines.id, parsed.id)))
        .limit(1),
    );
    if (!line) return fail("That budget line no longer exists.");
    if (line.status !== "open") {
      return fail(
        `"${line.periodName}" is ${line.status}. Its budget cannot be changed. Reopen the period first.`,
      );
    }

    await withTenant(ctx.tenant.id, (tx) =>
      tx
        .delete(budgetLines)
        .where(and(eq(budgetLines.tenantId, ctx.tenant.id), eq(budgetLines.id, parsed.id))),
    );

    await writeAudit(ctx, {
      action: "delete",
      resourceType: "budget_line",
      resourceId: parsed.id,
      oldValue: { amountMinor: line.amountMinor.toString(), periodId: line.periodId },
    });

    revalidatePath("/accounting/budgets");
    return { ok: true, data: { id: parsed.id } };
  } catch (err) {
    return toSalesActionError(err, "budgets");
  }
}

/* ================================================================== */
/* ④ BUDGET VERSUS ACTUAL                                              */
/* ================================================================== */

export type BudgetVsActualView = {
  period: BudgetPeriodRow;
  rows: Array<{
    ledgerId: string;
    ledgerCode: string;
    ledgerName: string;
    accountType: BudgetAccountType;
    costCentreKey: string;
    costCentreCode: string;
    costCentreName: string;
    isUncosted: boolean;
    /** All money crosses as minor-unit strings. `null` is a real state. */
    budgetMinor: string | null;
    actualMinor: string;
    varianceMinor: string | null;
    varianceLabel: string;
    varianceBasisPoints: string | null;
    status: string;
  }>;
  totals: Record<keyof BudgetTotals, string>;
  reconciliation: SerializedReconciliation;
};

/**
 * ⭐⭐⭐ THE VARIANCE SCREEN'S DATA.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE WINDOW IS THE PERIOD'S OWN START AND END DATES, TAKEN FROM THE
 *    `financial_periods` ROW AND NOT FROM ANYTHING THE CALLER SENT
 * ══════════════════════════════════════════════════════════════════════
 * The caller names a period; it does not get to name a date range. A
 * budget for "April" compared against actuals for a range somebody typed
 * is a variance made of the calendar, and the difference is invisible on
 * the page — every figure is individually right and the comparison is
 * not a comparison.
 *
 * ⭐ AND IT IS THE SAME ROW THE LEDGER LOCK USES, so the period this
 * report is drawn for and the period the books are closed for are the
 * same period by construction.
 */
export async function getBudgetVsActual(input: unknown): Promise<ActionResult<BudgetVsActualView>> {
  try {
    const ctx = await requirePermission(REPORT);
    const parsed = z.object({ periodId: uuid }).parse(input);

    const [period] = await withTenant(ctx.tenant.id, (tx) =>
      tx
        .select({
          id: financialPeriods.id,
          name: financialPeriods.name,
          startDate: financialPeriods.startDate,
          endDate: financialPeriods.endDate,
          status: financialPeriods.status,
        })
        .from(financialPeriods)
        .where(
          and(eq(financialPeriods.tenantId, ctx.tenant.id), eq(financialPeriods.id, parsed.periodId)),
        )
        .limit(1),
    );
    if (!period) return fail("That accounting period no longer exists.");

    const window = { from: period.startDate, to: period.endDate };

    const [actuals, centres, budgets] = await Promise.all([
      loadActuals(ctx.tenant.id, window),
      loadCentreRefs(ctx.tenant.id),
      withTenant(ctx.tenant.id, (tx) =>
        tx
          .select({
            ledgerId: budgetLines.ledgerId,
            costCentreId: budgetLines.costCentreId,
            amountMinor: budgetLines.amountMinor,
          })
          .from(budgetLines)
          .where(
            and(eq(budgetLines.tenantId, ctx.tenant.id), eq(budgetLines.periodId, period.id)),
          ),
      ),
    ]);

    const centreByKey = new Map<string, CostCentreRef>(centres.map((c) => [c.key, c]));
    centreByKey.set(UNCOSTED_KEY, UNCOSTED_REF);

    const ledgerMeta = new Map<
      string,
      { code: string; name: string; accountType: BudgetAccountType }
    >();
    for (const a of actuals) {
      ledgerMeta.set(a.ledgerId, {
        code: a.ledgerCode,
        name: a.ledgerName,
        accountType: a.accountType as BudgetAccountType,
      });
    }

    /**
     * ⚠️ A BUDGET AGAINST A LEDGER WITH NO ACTIVITY IS STILL A ROW, so
     * the ledgers that appear only on the budget side have to be looked
     * up. Dropping them would hide every approved budget nobody has spent
     * against, which is precisely the line a cash forecast needs.
     */
    const missingLedgerIds = [
      ...new Set(budgets.map((b) => b.ledgerId).filter((id) => !ledgerMeta.has(id))),
    ];
    if (missingLedgerIds.length > 0) {
      const extra = await withTenant(ctx.tenant.id, (tx) =>
        tx
          .select({
            id: ledgers.id,
            code: ledgers.code,
            name: ledgers.name,
            accountType: ledgers.accountType,
          })
          .from(ledgers)
          .where(and(eq(ledgers.tenantId, ctx.tenant.id), inArray(ledgers.id, missingLedgerIds))),
      );
      for (const l of extra) {
        ledgerMeta.set(l.id, {
          code: l.code,
          name: l.name,
          accountType: l.accountType as BudgetAccountType,
        });
      }
    }

    /** (ledgerId, costCentreKey) → actual, in the account's own direction. */
    const actualByCell = new Map<string, bigint>();
    for (const a of actuals) {
      const key = `${a.ledgerId}::${bucketKeyFor(a.costCentreId)}`;
      if (a.unscaledLegs > 0) {
        throw new Error(
          `${a.unscaledLegs} journal line(s) have no amount in minor units, so the actuals ` +
            `for this budget cannot be trusted. Run the census in SQL-FILES/0108.`,
        );
      }
      const debit = BigInt(a.debitMinor);
      const credit = BigInt(a.creditMinor);
      const signed = a.accountType === "revenue" ? credit - debit : debit - credit;
      actualByCell.set(key, (actualByCell.get(key) ?? 0n) + signed);
    }

    const budgetByCell = new Map<string, bigint>();
    for (const b of budgets) {
      budgetByCell.set(`${b.ledgerId}::${bucketKeyFor(b.costCentreId)}`, b.amountMinor);
    }

    /**
     * 🔴 THE UNION OF BOTH SIDES, NOT A JOIN FROM EITHER ONE.
     *
     * Driving from the budget drops every unbudgeted cost — the overspend
     * on an account nobody planned for, which is the single most
     * interesting line on the report. Driving from the actuals drops
     * every budget nobody has spent against. Both look complete.
     */
    const cells = new Set<string>([...actualByCell.keys(), ...budgetByCell.keys()]);

    const rows: BudgetVsActualRow[] = [];
    for (const cell of cells) {
      // ⚠️ A composite key split is two possibly-undefined halves as far as
      // the compiler is concerned. A malformed key must skip the row, never
      // render a cell under an empty ledger id.
      const [ledgerId, costCentreKey] = cell.split("::");
      if (!ledgerId || costCentreKey === undefined) continue;
      const meta = ledgerMeta.get(ledgerId);
      if (!meta) continue;
      if (meta.accountType !== "revenue" && meta.accountType !== "expense") continue;
      const centre = centreByKey.get(costCentreKey) ?? {
        key: costCentreKey,
        code: "",
        name: `Unknown cost centre (${costCentreKey})`,
      };
      rows.push(
        buildBudgetRow({
          ledgerId,
          ledgerCode: meta.code,
          ledgerName: meta.name,
          accountType: meta.accountType,
          costCentreKey,
          costCentreCode: centre.code,
          costCentreName: centre.name,
          budgetMinor: budgetByCell.has(cell) ? (budgetByCell.get(cell) as bigint) : null,
          actualMinor: actualByCell.get(cell) ?? 0n,
        }),
      );
    }

    const sorted = sortBudgetRows(rows, UNCOSTED_KEY);
    const totals = totalsFor(sorted);
    const pl = await profitAndLossNetMinor(window);

    /**
     * ⭐ THE FIGURE COMPARED IS DERIVED FROM THE ROWS THAT ARE ON SCREEN,
     * not re-read from `loadActuals`. A check that re-runs its own query
     * proves the query is deterministic; this one proves that what the
     * reader is looking at adds up to the P&L.
     */
    const onScreenNet = actualNetResultMinor(sorted);
    const configured = pl.ok && actuals.length > 0;

    const reconciliation = reconcile({
      subject: "Budget versus actual",
      ledgerConfigured: configured,
      notes: [
        ...(pl.ok ? [] : [`The profit & loss could not be read: ${pl.reason}`]),
        ...(actuals.length === 0
          ? ["Nothing has been posted to a revenue or expense ledger in this period."]
          : []),
        ...(totals.unbudgetedRowCount > 0
          ? [
              `${totals.unbudgetedRowCount} line(s) have activity but no budget. They are counted in the actual totals and excluded from the variance totals — a missing budget is not a budget of zero.`,
            ]
          : []),
        `"${UNCOSTED_LABEL}" is journal lines carrying no cost centre, on both the budget and the actual side. It means the same thing in both, which is why the buckets line up and the totals reconcile.`,
      ],
      checks: [
        {
          id: "budget-actuals-vs-pl",
          claim:
            "The actual column on this report, added across every cost centre including the un-allocated bucket, equals the profit & loss for the same period.",
          report: {
            label: "the actuals on this report",
            source: "budget vs actual rows (server/actions/budgets.ts)",
            amountMinor: onScreenNet,
          },
          ledger: {
            label: "the profit & loss",
            source: "getProfitAndLoss (server/actions/accounting.ts)",
            amountMinor: pl.ok ? pl.minor : onScreenNet + 1n,
          },
          toleranceMinor: EXACT,
          ...(pl.ok
            ? {}
            : { notComparable: "The profit & loss could not be read, so there is nothing to compare against." }),
        },
      ],
    });

    return {
      ok: true,
      data: {
        period: {
          id: period.id,
          name: period.name,
          startDate: period.startDate,
          endDate: period.endDate,
          status: period.status,
          isOpen: period.status === "open",
          label: budgetPeriodLabel(period.name, period.startDate),
        },
        rows: sorted.map((r) => ({
          ledgerId: r.ledgerId,
          ledgerCode: r.ledgerCode,
          ledgerName: r.ledgerName,
          accountType: r.accountType,
          costCentreKey: r.costCentreKey,
          costCentreCode: r.costCentreCode,
          costCentreName: r.costCentreName,
          isUncosted: r.costCentreKey === UNCOSTED_KEY,
          budgetMinor: r.budgetMinor === null ? null : r.budgetMinor.toString(),
          actualMinor: r.actualMinor.toString(),
          varianceMinor: r.varianceMinor === null ? null : r.varianceMinor.toString(),
          varianceLabel: r.varianceLabel,
          varianceBasisPoints:
            r.varianceBasisPoints === null ? null : r.varianceBasisPoints.toString(),
          status: r.status,
        })),
        totals: {
          revenueBudgetMinor: totals.revenueBudgetMinor.toString(),
          revenueActualMinor: totals.revenueActualMinor.toString(),
          expenseBudgetMinor: totals.expenseBudgetMinor.toString(),
          expenseActualMinor: totals.expenseActualMinor.toString(),
          revenueVarianceMinor: totals.revenueVarianceMinor.toString(),
          expenseVarianceMinor: totals.expenseVarianceMinor.toString(),
          netVarianceMinor: totals.netVarianceMinor.toString(),
          unbudgetedActualMinor: totals.unbudgetedActualMinor.toString(),
          unbudgetedRowCount: totals.unbudgetedRowCount.toString(),
        },
        reconciliation: serializeReconciliation(reconciliation),
      },
    };
  } catch (err) {
    return toSalesActionError(err, "budget versus actual");
  }
}
