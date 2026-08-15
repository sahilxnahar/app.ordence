"use server";

/**
 * Ordence — ⭐⭐⭐ THE STOCK COUNT
 * Version: v1.18.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION AND NONE TAKES A TENANT.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE ENGINE HAS EXISTED SINCE 0029 AND NOTHING EVER REACHED IT
 * ══════════════════════════════════════════════════════════════════════
 * `stock_counts` and `stock_count_lines` were built in phase 40 with the
 * hard part already right: the expected quantity is snapshotted into the
 * line rather than read live at posting, so a movement made while
 * somebody walks the aisles cannot silently change what the variance
 * appears to be.
 *
 * ⚠️ In the year since, no action and no screen has referenced either
 * table. There has never been a way to open a count, enter a figure, or
 * post the difference. This file is the seventh time this pattern has
 * been the most valuable thing in a session.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ AND THE BLIND RULE IS ENFORCED HERE, NOT ON THE SCREEN
 * ══════════════════════════════════════════════════════════════════════
 * `getCountSheet` returns `BlindSheetLine`, which has no expected
 * quantity on it, and the review data comes from a different export
 * behind a different permission.
 *
 * 🔴 IF THE FILTERING WERE DONE IN THE COMPONENT, the expected figure
 * would still be in the payload the browser received, one devtools tab
 * away from the person counting. A control that a curious employee can
 * defeat by pressing F12 is not a control.
 */

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenant } from "@/db";
import {
  stockBalances,
  stockCountLines,
  stockCounts,
  stockItems,
  stockMovements,
  warehouses,
} from "@/db/schema/inventory";
import { requirePermission, writeAudit } from "@/server/audit";
import { toSalesActionError } from "@/server/sales/guards";
import { postStockCount } from "@/server/accounting/post-sales";
import {
  assessCount,
  movementsFor,
  sheetFor,
  type BlindSheetLine,
  type CountAssessment,
  type CountLine,
} from "@/lib/inventory/counting";
import type { ActionResult } from "@/lib/validators/crm";

/**
 * 🔴 TWO PERMISSIONS, NOT ONE, AND THAT IS THE CONTROL.
 *
 * ⚠️ The person who walks the aisles and the person who accepts the
 * variance must be able to be different people. Collapsing these to one
 * permission means whoever counts also approves their own count, which
 * is the exact arrangement stocktaking exists to prevent.
 */
/**
 * 🔴 WAS `inventory.stock.read`, which defeated the paragraph above:
 * `read_only` and `guest` both hold it, so anyone at all could open a
 * stocktake and record quantities. The counting side now has its own
 * write key, and the review side keeps `settings:update`.
 */
const COUNT = "inventory.counts.record" as const;
const REVIEW = "settings:update" as const;

/* ------------------------------------------------------------------ */
/* OPEN                                                               */
/* ------------------------------------------------------------------ */

const openSchema = z.object({
  warehouseId: z.string().uuid(),
  notes: z.string().max(2000).optional(),
});

/**
 * ⭐⭐ OPENING A COUNT FREEZES THE SYSTEM FIGURE, AND THAT MOMENT IS THE
 * WHOLE MEANING OF THE VARIANCE.
 *
 * ⚠️ A count is a comparison against a stated instant. If the expected
 * quantity were read at posting time instead, every legitimate movement
 * made during the count would land in the variance, and the warehouse
 * would be investigating its own dispatches.
 *
 * 🔴 EVERY ITEM WITH A BALANCE ROW IS INCLUDED, INCLUDING ZEROES. An
 * item the system believes it has none of is exactly the item most
 * likely to be sitting on a shelf uncounted, and leaving it off the
 * sheet guarantees it stays invisible.
 */
export async function openCount(
  input: unknown,
): Promise<ActionResult<{ countId: string; countNo: string; lines: number }>> {
  try {
    const data = openSchema.parse(input);
    const ctx = await requirePermission(COUNT);
    const now = new Date();

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [warehouse] = await tx
          .select({ id: warehouses.id, name: warehouses.name })
          .from(warehouses)
          .where(
            and(
              eq(warehouses.tenantId, ctx.tenant.id),
              eq(warehouses.id, data.warehouseId),
            ),
          )
          .limit(1);

        if (!warehouse) throw new Error("No such warehouse.");

        // ⚠️ ONE OPEN COUNT PER WAREHOUSE. Two people counting the same
        // shelves against two different frozen snapshots produce two
        // different variances, and posting both applies the difference
        // twice.
        const [openAlready] = await tx
          .select({ id: stockCounts.id, countNo: stockCounts.countNo })
          .from(stockCounts)
          .where(
            and(
              eq(stockCounts.tenantId, ctx.tenant.id),
              eq(stockCounts.warehouseId, data.warehouseId),
              sql`${stockCounts.status} IN ('draft', 'counting', 'review')`,
            ),
          )
          .limit(1);

        if (openAlready) {
          throw new Error(
            `Count ${openAlready.countNo} is already open for this warehouse. Finish or abandon it before starting another, because two counts against two different frozen snapshots produce two different variances.`,
          );
        }

        const countNo = await nextCountNo(tx, ctx.tenant.id);

        const [count] = await tx
          .insert(stockCounts)
          .values({
            tenantId: ctx.tenant.id,
            countNo,
            warehouseId: data.warehouseId,
            status: "counting",
            startedAt: now,
            notes: data.notes ?? null,
            createdBy: ctx.user.id,
          })
          .returning({ id: stockCounts.id });

        if (!count) throw new Error("The count could not be opened.");

        // 🔴 THE SNAPSHOT. This SELECT is the frozen moment.
        const balances = await tx
          .select({
            stockItemId: stockBalances.stockItemId,
            quantityOnHand: stockBalances.quantityOnHand,
          })
          .from(stockBalances)
          .where(
            and(
              eq(stockBalances.tenantId, ctx.tenant.id),
              eq(stockBalances.warehouseId, data.warehouseId),
            ),
          );

        if (balances.length > 0) {
          await tx.insert(stockCountLines).values(
            balances.map((b: { stockItemId: string; quantityOnHand: string }) => ({
              tenantId: ctx.tenant.id,
              countId: count.id,
              stockItemId: b.stockItemId,
              batchNo: null,
              expectedQuantity: b.quantityOnHand,
              countedQuantity: null,
            })),
          );
        }

        await writeAudit(ctx, {
          action: "create",
          resourceType: "stock_count",
          resourceId: count.id,
          newValue: { countNo, warehouse: warehouse.name, lines: balances.length },
          severity: "notice",
        });

        return { countId: count.id, countNo, lines: balances.length };
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/inventory/counts");
    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "openCount");
  }
}

/* ------------------------------------------------------------------ */
/* COUNT                                                              */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐⭐ THE BLIND SHEET. There is no expected quantity in this payload
 * and there must never be one.
 *
 * 🔴 A SHEET PRINTED WITH THE SYSTEM FIGURE ON IT IS NOT A COUNT, it is
 * a confirmation exercise, and people confirm. Somebody counting 240
 * boxes on a high shelf while holding a sheet that says 244 will count
 * again and find 244. That is not laziness; human beings are extremely
 * good at confirming a hypothesis they have been handed.
 *
 * ⚠️ AND IT IS FILTERED ON THE SERVER. Doing it in the component would
 * leave the expected figure in the payload the browser already received,
 * one devtools tab away from the person counting.
 */
export async function getCountSheet(
  input: unknown,
): Promise<
  ActionResult<{
    countNo: string;
    status: string;
    warehouseName: string;
    lines: readonly BlindSheetLine[];
  }>
> {
  try {
    const { countId } = z.object({ countId: z.string().uuid() }).parse(input);
    const ctx = await requirePermission(COUNT);

    return await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const header = await loadHeader(tx, ctx.tenant.id, countId);
        const lines = await loadLines(tx, ctx.tenant.id, countId);
        return {
          ok: true as const,
          data: {
            countNo: header.countNo,
            status: header.status,
            warehouseName: header.warehouseName,
            // ⭐ The one call that matters in this file.
            lines: sheetFor(lines),
          },
        };
      },
      { impersonationId: ctx.impersonationId },
    );
  } catch (err) {
    return toSalesActionError(err, "getCountSheet");
  }
}

const recordSchema = z.object({
  countId: z.string().uuid(),
  lineId: z.string().uuid(),
  /** ⚠️ A string, because numeric(18,3) does not fit in a double. */
  countedQuantity: z
    .string()
    .regex(
      /^\d+(\.\d{1,3})?$/,
      "A counted quantity is a positive number with at most three decimal places.",
    ),
  varianceNote: z.string().max(2000).optional(),
});

/**
 * ⚠️ RECORDING A FIGURE TELLS THE COUNTER NOTHING BACK.
 *
 * 🔴 The obvious kindness is to answer "that differs from the system by
 * 4" so they can check. That single sentence converts the blind count
 * into a sighted one from the second line onwards, because they now know
 * the system figure for anything they mistyped. The variance is shown at
 * review, to somebody else.
 */
export async function recordCount(
  input: unknown,
): Promise<ActionResult<{ recorded: true }>> {
  try {
    const data = recordSchema.parse(input);
    const ctx = await requirePermission(COUNT);
    const now = new Date();

    await withTenant(
      ctx.tenant.id,
      async (tx) => {
        await tx
          .update(stockCountLines)
          .set({
            countedQuantity: data.countedQuantity,
            countedBy: ctx.user.id,
            countedAt: now,
            ...(data.varianceNote !== undefined
              ? { varianceNote: data.varianceNote }
              : {}),
          })
          .where(
            and(
              eq(stockCountLines.tenantId, ctx.tenant.id),
              eq(stockCountLines.id, data.lineId),
              eq(stockCountLines.countId, data.countId),
            ),
          );
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath(`/inventory/counts/${data.countId}`);
    return { ok: true, data: { recorded: true } };
  } catch (err) {
    return toSalesActionError(err, "recordCount");
  }
}

/* ------------------------------------------------------------------ */
/* REVIEW                                                             */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE REVIEW, WHICH IS A DIFFERENT PERMISSION AND A DIFFERENT PERSON.
 * This is the first point at which anybody sees expected beside counted.
 */
export async function getCountReview(
  input: unknown,
): Promise<
  ActionResult<{
    countNo: string;
    status: string;
    warehouseName: string;
    posted: boolean;
    assessment: CountAssessment;
  }>
> {
  try {
    const { countId } = z.object({ countId: z.string().uuid() }).parse(input);
    const ctx = await requirePermission(REVIEW);
    const now = new Date();

    return await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const header = await loadHeader(tx, ctx.tenant.id, countId);
        const lines = await loadLines(tx, ctx.tenant.id, countId);
        return {
          ok: true as const,
          data: {
            countNo: header.countNo,
            status: header.status,
            warehouseName: header.warehouseName,
            posted: header.journalEntryId !== null || header.status === "posted",
            assessment: assessCount(lines, now),
          },
        };
      },
      { impersonationId: ctx.impersonationId },
    );
  } catch (err) {
    return toSalesActionError(err, "getCountReview");
  }
}

/* ------------------------------------------------------------------ */
/* POST                                                               */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐⭐ POSTING WRITES MOVEMENTS AND A JOURNAL. IT NEVER SETS A BALANCE.
 *
 * 🔴 Setting the balance directly would produce a stock ledger that does
 * not add up to the stock figure, and every question asked afterwards
 * would have two answers. The difference becomes rows exactly like a
 * receipt or a dispatch, and the balance follows from the movements as
 * it always has.
 *
 * ⚠️ AND THE LEDGER POSTING IS PART OF THE SAME TRANSACTION. A count
 * that adjusted quantities but failed to reach the accounts would leave
 * the balance sheet carrying stock the warehouse does not have, and
 * nothing would report it, because each system is internally consistent.
 */
export async function postCount(
  input: unknown,
): Promise<
  ActionResult<{
    posted: boolean;
    movements: number;
    netValueMinor: string;
    note: string;
  }>
> {
  try {
    const { countId } = z.object({ countId: z.string().uuid() }).parse(input);
    const ctx = await requirePermission(REVIEW);
    const now = new Date();

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const header = await loadHeader(tx, ctx.tenant.id, countId);

        // ⚠️ CHECKED HERE AND ENFORCED BY A PARTIAL UNIQUE INDEX IN 0070.
        // This produces a sentence; the index is what makes two people
        // pressing Post at the same moment safe.
        if (header.journalEntryId !== null || header.status === "posted") {
          throw new Error(
            "This count has already been posted. Posting it again would apply the same difference twice, and the next count would find stock appearing from nowhere.",
          );
        }

        const lines = await loadLines(tx, ctx.tenant.id, countId);
        const assessment = assessCount(lines, now);

        if (!assessment.mayPost) {
          throw new Error(assessment.blockers.join(" "));
        }

        const movements = movementsFor(assessment, lines);

        for (const m of movements) {
          await tx.insert(stockMovements).values({
            tenantId: ctx.tenant.id,
            stockItemId: m.stockItemId,
            warehouseId: header.warehouseId,
            // ⭐ SIGNED. 0029 stores signed quantities on purpose, so a
            // balance is SUM(quantity) with nothing to get wrong.
            quantity: m.quantity,
            reason: "adjustment",
            unitCostMinor: m.unitCostMinor,
            referenceType: "stock_count",
            referenceId: countId,
            documentNo: header.countNo,
            // ⚠️ `adjustmentNote`, not `notes`. 0029 named it that
            // deliberately: an adjustment is the one movement type that
            // is meaningless without a stated reason.
            adjustmentNote: m.note,
            approvedBy: ctx.user.id,
            createdBy: ctx.user.id,
          });
        }

        // 🔴 THE LEDGER, IN THE SAME TRANSACTION.
        const posting = await postStockCount(tx, {
          tenantId: ctx.tenant.id,
          userId: ctx.user.id,
          countId,
          countNo: header.countNo,
          // ⚠️ THE DATE COUNTING HAPPENED, NEVER TODAY. A count walked on
          // 31 March and posted on 2 April belongs in March; putting it
          // in April moves a stock adjustment across a financial year.
          countedOn: (header.startedAt ?? now).toISOString().slice(0, 10),
          gainMinor: assessment.gainValueMinor,
          lossMinor: assessment.lossValueMinor,
        });

        let note: string;
        if (posting.posted) {
          note = "Posted to the stock ledger and to the accounts.";
        } else if (posting.reason === "nothing_to_post") {
          note =
            "Posted. The count found no difference, so there was nothing to put in the accounts.";
        } else if (posting.reason === "unmapped_roles") {
          // ⚠️ NAMED, NOT SWALLOWED. The same pattern as the four
          // accounts a vendor payment needs.
          throw new Error(
            `The stock adjustment cannot reach the accounts until these are mapped in the chart of accounts: ${posting.missing.join(", ")}. Nothing has been changed.`,
          );
        } else {
          note = "Already posted.";
        }

        await tx
          .update(stockCounts)
          .set({
            status: "posted",
            postedAt: now,
            postedBy: ctx.user.id,
            varianceValueMinor: assessment.netValueMinor,
            journalEntryId: posting.posted ? posting.transactionId : null,
            updatedAt: now,
          })
          .where(
            and(
              eq(stockCounts.tenantId, ctx.tenant.id),
              eq(stockCounts.id, countId),
            ),
          );

        await writeAudit(ctx, {
          action: "update",
          resourceType: "stock_count",
          resourceId: countId,
          newValue: {
            posted: true,
            movements: movements.length,
            gainMinor: assessment.gainValueMinor.toString(),
            lossMinor: assessment.lossValueMinor.toString(),
          },
          severity: "critical",
        });

        return {
          posted: true,
          movements: movements.length,
          netValueMinor: assessment.netValueMinor.toString(),
          note,
        };
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/inventory/counts");
    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "postCount");
  }
}

/* ------------------------------------------------------------------ */
/* READ                                                               */
/* ------------------------------------------------------------------ */

export interface CountSummary {
  readonly id: string;
  readonly countNo: string;
  readonly warehouseName: string;
  readonly status: string;
  readonly startedAt: string | null;
  readonly postedAt: string | null;
  readonly varianceValueMinor: string;
}

export async function getCounts(): Promise<
  ActionResult<{
    counts: readonly CountSummary[];
    warehouses: ReadonlyArray<{ id: string; name: string }>;
  }>
> {
  try {
    const ctx = await requirePermission(COUNT);

    return await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const rows = await tx
          .select({
            id: stockCounts.id,
            countNo: stockCounts.countNo,
            warehouseName: warehouses.name,
            status: stockCounts.status,
            startedAt: stockCounts.startedAt,
            postedAt: stockCounts.postedAt,
            varianceValueMinor: stockCounts.varianceValueMinor,
          })
          .from(stockCounts)
          .innerJoin(warehouses, eq(warehouses.id, stockCounts.warehouseId))
          .where(eq(stockCounts.tenantId, ctx.tenant.id))
          .orderBy(sql`${stockCounts.createdAt} DESC`)
          .limit(100);

        const houses = await tx
          .select({ id: warehouses.id, name: warehouses.name })
          .from(warehouses)
          .where(eq(warehouses.tenantId, ctx.tenant.id));

        return {
          ok: true as const,
          data: {
            counts: rows.map((r: Record<string, unknown>) => ({
              id: r.id as string,
              countNo: r.countNo as string,
              warehouseName: r.warehouseName as string,
              status: r.status as string,
              startedAt: (r.startedAt as Date | null)?.toISOString() ?? null,
              postedAt: (r.postedAt as Date | null)?.toISOString() ?? null,
              varianceValueMinor: String(r.varianceValueMinor ?? 0n),
            })),
            warehouses: houses,
          },
        };
      },
      { impersonationId: ctx.impersonationId },
    );
  } catch (err) {
    return toSalesActionError(err, "getCounts");
  }
}

/* ------------------------------------------------------------------ */
/* PLUMBING                                                           */
/* ------------------------------------------------------------------ */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;

async function loadHeader(tx: Tx, tenantId: string, countId: string) {
  const [row] = await tx
    .select({
      countNo: stockCounts.countNo,
      status: stockCounts.status,
      warehouseId: stockCounts.warehouseId,
      warehouseName: warehouses.name,
      startedAt: stockCounts.startedAt,
      journalEntryId: stockCounts.journalEntryId,
    })
    .from(stockCounts)
    .innerJoin(warehouses, eq(warehouses.id, stockCounts.warehouseId))
    .where(and(eq(stockCounts.tenantId, tenantId), eq(stockCounts.id, countId)))
    .limit(1);

  if (!row) throw new Error("No such count.");
  return row as {
    countNo: string;
    status: string;
    warehouseId: string;
    warehouseName: string;
    startedAt: Date | null;
    journalEntryId: string | null;
  };
}

async function loadLines(
  tx: Tx,
  tenantId: string,
  countId: string,
): Promise<readonly CountLine[]> {
  const rows = await tx
    .select({
      lineId: stockCountLines.id,
      stockItemId: stockCountLines.stockItemId,
      itemName: stockItems.name,
      itemCode: stockItems.sku,
      batchNo: stockCountLines.batchNo,
      uom: stockItems.uom,
      expectedQuantity: stockCountLines.expectedQuantity,
      countedQuantity: stockCountLines.countedQuantity,
      varianceNote: stockCountLines.varianceNote,
      unitCostMinor: stockItems.standardCostMinor,
    })
    .from(stockCountLines)
    .innerJoin(stockItems, eq(stockItems.id, stockCountLines.stockItemId))
    .where(
      and(
        eq(stockCountLines.tenantId, tenantId),
        eq(stockCountLines.countId, countId),
      ),
    );

  return rows.map((r: Record<string, unknown>) => ({
    lineId: r.lineId as string,
    stockItemId: r.stockItemId as string,
    itemName: r.itemName as string,
    itemCode: r.itemCode as string,
    batchNo: (r.batchNo as string | null) ?? null,
    uom: (r.uom as string | null) ?? "unit",
    expectedQuantity: String(r.expectedQuantity ?? "0"),
    countedQuantity:
      r.countedQuantity === null || r.countedQuantity === undefined
        ? null
        : String(r.countedQuantity),
    varianceNote: (r.varianceNote as string | null) ?? null,
    unitCostMinor: BigInt((r.unitCostMinor as string | number | bigint | null) ?? 0),
  }));
}

/**
 * ⚠️ SEQUENTIAL AND PER TENANT. A random or timestamp-based number is
 * unique and useless: a stocktake is referred to out loud, and "count
 * seventeen" is a thing a person can say across a warehouse.
 */
async function nextCountNo(tx: Tx, tenantId: string): Promise<string> {
  const rows = await tx.execute(sql`
    SELECT COALESCE(MAX(NULLIF(regexp_replace(count_no, '\\D', '', 'g'), '')::int), 0) + 1 AS next
      FROM stock_counts
     WHERE tenant_id = ${tenantId}::uuid
  `);
  const next =
    (Array.isArray(rows) ? rows[0] : (rows as { rows?: unknown[] }).rows?.[0]) ?? {};
  const n = Number((next as { next?: number }).next ?? 1);
  return `SC-${String(n).padStart(5, "0")}`;
}
