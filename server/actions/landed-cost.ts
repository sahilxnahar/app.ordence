"use server";

/**
 * Ordence — ⭐⭐ WHAT THE GOODS ACTUALLY COST
 * Version: v1.5.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION AND NONE TAKES A TENANT. The
 * arithmetic lives in `lib/inventory/landed-cost.ts`, which is pure.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE TWO RULES THIS MODULE ENFORCES
 * ══════════════════════════════════════════════════════════════════════
 * ① **Recoverable taxes never enter inventory.** Ind AS 2 says the cost
 *    of purchase is the price plus duties and taxes *"other than those
 *    subsequently recoverable from the taxing authorities"*. Basic
 *    customs duty is a cost; IGST on imports is a credit. They arrive on
 *    the same bill of entry, in adjacent boxes.
 *
 * ② **The charge is split between stock and cost of sales**, because the
 *    freight bill arrives after the goods and some of them are already
 *    sold. Putting all of it on what is left overstates closing stock
 *    AND the margin already reported — two errors in opposite
 *    directions, with a correct total.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenant } from "@/db";
import {
  landedCosts,
  landedCostAllocations,
  stockBalances,
  stockItems,
} from "@/db/schema/inventory";
import { purchaseInvoices, purchaseInvoiceLines, vendors } from "@/db/schema/purchases";
import { requirePermission, writeAudit } from "@/server/audit";
import { toSalesActionError } from "@/server/sales/guards";
import {
  LANDED_COST_TYPES,
  apportion,
  marginAgainstLanded,
  splitBetweenStockAndCogs,
  summariseLandedCost,
  type ApportionBasis,
  type LandedCostType,
} from "@/lib/inventory/landed-cost";
import { serializeAmount, toBigIntAmount } from "@/lib/billing/money";
import type { ActionResult } from "@/lib/validators/crm";

const READ = "purchases.invoices.read" as const;
const WRITE = "purchases.invoices.create" as const;

const civilDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");

function toMilli(value: string | number | null | undefined): bigint {
  const s = String(value ?? "0");
  const negative = s.startsWith("-");
  const [whole = "0", frac = ""] = (negative ? s.slice(1) : s).split(".");
  const milli = BigInt(whole) * 1000n + BigInt((frac + "000").slice(0, 3));
  return negative ? -milli : milli;
}

const COST_TYPES = [
  "freight_inward",
  "insurance",
  "customs_duty",
  "customs_igst",
  "clearing_forwarding",
  "loading_unloading",
  "inspection",
  "octroi_entry_tax",
  "other",
] as const;

/* ================================================================== */
/* ① RECORD A CHARGE                                                   */
/* ================================================================== */

const chargeSchema = z.object({
  purchaseInvoiceId: z.string().uuid(),
  costType: z.enum(COST_TYPES),
  description: z.string().trim().max(500).optional(),
  vendorId: z.string().uuid().optional(),
  vendorInvoiceNo: z.string().trim().max(60).optional(),
  costDate: civilDay,
  amountMinor: z.string().regex(/^\d+$/, "Whole paise."),
  apportionBasis: z.enum(["value", "quantity", "weight", "volume", "equal"]).optional(),
  notes: z.string().trim().max(1000).optional(),
});

/**
 * ⭐ RECORD A LANDED-COST CHARGE.
 *
 * 🔴 `isRecoverable` IS TAKEN FROM THE CHARGE TYPE, NOT FROM A CHECKBOX.
 *    Whether IGST on imports is recoverable is a matter of law, not a
 *    matter of opinion, and a tick-box invites somebody to get it wrong
 *    on the one charge everybody gets wrong.
 */
export async function recordLandedCost(input: unknown): Promise<
  ActionResult<{
    id: string;
    isRecoverable: boolean;
    note: string;
    defaultBasis: string;
  }>
> {
  try {
    const data = chargeSchema.parse(input);
    const ctx = await requirePermission(WRITE);

    const meta = LANDED_COST_TYPES[data.costType as LandedCostType];

    const id = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [inv] = await tx
          .select({ id: purchaseInvoices.id, status: purchaseInvoices.status })
          .from(purchaseInvoices)
          .where(
            and(
              eq(purchaseInvoices.tenantId, ctx.tenant.id),
              eq(purchaseInvoices.id, data.purchaseInvoiceId),
            ),
          )
          .limit(1);
        if (!inv) throw new Error("That purchase does not exist.");

        /**
         * ⚠️ NOT ON A DRAFT. A charge apportioned across lines that can
         * still change is an apportionment that has to be redone — and
         * the version already posted to the ledger would be the wrong
         * one.
         */
        if (inv.status === "draft") {
          throw new Error(
            "This purchase is still a draft, so its lines can still change. Apportioning a charge across them now would have to be redone, and the version already posted would be the wrong one.",
          );
        }

        const [row] = await tx
          .insert(landedCosts)
          .values({
            tenantId: ctx.tenant.id,
            purchaseInvoiceId: data.purchaseInvoiceId,
            costType: data.costType,
            description: data.description ?? null,
            vendorId: data.vendorId ?? null,
            vendorInvoiceNo: data.vendorInvoiceNo ?? null,
            costDate: data.costDate,
            amountMinor: BigInt(data.amountMinor),
            /** 🔴 From the law, not from a checkbox. */
            isRecoverable: meta.recoverable,
            apportionBasis: data.apportionBasis ?? meta.defaultBasis,
            status: "draft",
            notes: data.notes ?? null,
            createdBy: ctx.user.id,
          })
          .returning({ id: landedCosts.id });

        if (!row) throw new Error("The charge could not be recorded.");

        await writeAudit(ctx, {
          action: "create",
          resourceType: "landed_cost",
          resourceId: row.id,
          newValue: {
            costType: data.costType,
            amountMinor: data.amountMinor,
            isRecoverable: meta.recoverable,
          },
          severity: "info",
        });

        return row.id;
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/purchases/landed-cost");
    return {
      ok: true,
      data: {
        id,
        isRecoverable: meta.recoverable,
        note: meta.note,
        defaultBasis: meta.defaultBasis,
      },
    };
  } catch (err) {
    return toSalesActionError(err, "recordLandedCost");
  }
}

/* ================================================================== */
/* ② APPLY IT                                                          */
/* ================================================================== */

const applySchema = z.object({ landedCostId: z.string().uuid() });

/**
 * ⭐⭐ SPREAD THE CHARGE ACROSS THE LINES AND SPLIT EACH SHARE BETWEEN
 *      STOCK AND COST OF SALES.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 A RECOVERABLE CHARGE CANNOT BE APPLIED AT ALL
 * ══════════════════════════════════════════════════════════════════════
 * IGST on an import is an input tax credit. Capitalising it inflates
 * closing stock **and** loses the credit — and the balance sheet still
 * balances, which is why nobody notices. Refused here and refused by a
 * CHECK constraint in 0056.
 *
 * ⚠️ THE APPORTIONMENT USES LARGEST REMAINDER, so the shares sum to the
 * charge exactly. ₹10,000 over three lines is 3,333.34 + 3,333.33 +
 * 3,333.33, not three amounts that total ₹9,999.99 with a paisa that
 * belongs to no document.
 */
export async function applyLandedCost(input: unknown): Promise<
  ActionResult<{
    allocated: number;
    toInventoryMinor: string;
    toCogsMinor: string;
    soldShare: string;
  }>
> {
  try {
    const data = applySchema.parse(input);
    const ctx = await requirePermission(WRITE);
    const now = new Date();

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [charge] = await tx
          .select()
          .from(landedCosts)
          .where(
            and(
              eq(landedCosts.tenantId, ctx.tenant.id),
              eq(landedCosts.id, data.landedCostId),
            ),
          )
          .limit(1);
        if (!charge) throw new Error("That charge does not exist.");
        if (charge.status !== "draft") {
          throw new Error(`This charge has already been ${charge.status}.`);
        }

        /** 🔴 The rule the whole module exists for. */
        if (charge.isRecoverable) {
          throw new Error(
            "This is a recoverable tax, not a cost. Ind AS 2 excludes duties and taxes that are subsequently recoverable from the taxing authorities — capitalising IGST on imports would inflate closing stock and lose the input credit at the same time. Claim it as input tax credit instead.",
          );
        }

        const lines = await tx
          .select({
            id: purchaseInvoiceLines.id,
            description: purchaseInvoiceLines.description,
            quantity: purchaseInvoiceLines.quantity,
            amountMinor: purchaseInvoiceLines.amountMinor,
          })
          .from(purchaseInvoiceLines)
          .where(
            and(
              eq(purchaseInvoiceLines.tenantId, ctx.tenant.id),
              eq(
                purchaseInvoiceLines.purchaseInvoiceId,
                charge.purchaseInvoiceId ?? "00000000-0000-0000-0000-000000000000",
              ),
            ),
          )
          .orderBy(purchaseInvoiceLines.lineNumber);

        if (lines.length === 0) {
          throw new Error("That purchase has no lines to apportion the charge across.");
        }

        const basis = charge.apportionBasis as ApportionBasis;

        /**
         * ⚠️ WEIGHT AND VOLUME ARE NOT ON THE PURCHASE LINE, so they fall
         * back to quantity and the screen says so. Silently substituting
         * value — the tempting default — would give a container of
         * feathers and lead almost all its freight to the feathers.
         */
        const basisOf = (l: (typeof lines)[number]): bigint => {
          if (basis === "equal") return 1n;
          if (basis === "value") return toBigIntAmount(l.amountMinor);
          return toMilli(l.quantity ?? "0");
        };

        const shares = apportion({
          totalMinor: toBigIntAmount(charge.amountMinor),
          lines: lines.map((l) => ({ key: l.id, basis: basisOf(l) })),
          basisName: basis,
        });

        let toInventory = 0n;
        let toCogs = 0n;
        let receivedTotal = 0n;
        let onHandTotal = 0n;

        for (const s of shares) {
          const line = lines.find((l) => l.id === s.key);
          if (!line) continue;

          const receivedMilli = toMilli(line.quantity ?? "0");

          /**
           * ⭐ HOW MUCH OF THIS CONSIGNMENT IS STILL ON THE SHELF. Capped
           * at what came in, because the balance also holds stock from
           * other receipts — and apportioning against that would push
           * this freight onto goods it never touched.
           */
          const [balance] = await tx
            .select({
              onHand: sql<string>`COALESCE(SUM(${stockBalances.quantityOnHand}), 0)`,
            })
            .from(stockBalances)
            .where(
              and(
                eq(stockBalances.tenantId, ctx.tenant.id),
                sql`${stockBalances.stockItemId} IN (
                  SELECT id FROM stock_items
                   WHERE tenant_id = ${ctx.tenant.id} AND name = ${line.description}
                )`,
              ),
            );

          const rawOnHand = toMilli(balance?.onHand ?? "0");
          const onHandMilli = rawOnHand > receivedMilli ? receivedMilli : rawOnHand;

          const split = splitBetweenStockAndCogs({
            allocatedMinor: s.allocatedMinor,
            qtyReceivedMilli: receivedMilli,
            qtyStillOnHandMilli: onHandMilli,
          });

          await tx.insert(landedCostAllocations).values({
            tenantId: ctx.tenant.id,
            landedCostId: charge.id,
            purchaseLineId: line.id,
            basisAmount: String(Number(s.basis) / (basis === "value" ? 100 : 1000)),
            allocatedMinor: s.allocatedMinor,
            toInventoryMinor: split.toInventoryMinor,
            toCogsMinor: split.toCogsMinor,
            qtyReceived: String(Number(receivedMilli) / 1000),
            qtyStillOnHand: String(Number(onHandMilli) / 1000),
          });

          toInventory += split.toInventoryMinor;
          toCogs += split.toCogsMinor;
          receivedTotal += receivedMilli;
          onHandTotal += onHandMilli;
        }

        await tx
          .update(landedCosts)
          .set({
            status: "applied",
            appliedAt: now,
            appliedBy: ctx.user.id,
            updatedAt: now,
          })
          .where(
            and(eq(landedCosts.tenantId, ctx.tenant.id), eq(landedCosts.id, charge.id)),
          );

        await writeAudit(ctx, {
          action: "update",
          resourceType: "landed_cost",
          resourceId: charge.id,
          newValue: {
            applied: true,
            toInventoryMinor: serializeAmount(toInventory),
            toCogsMinor: serializeAmount(toCogs),
          },
          /** It changes the value of stock and the margin already reported. */
          severity: "critical",
        });

        const soldMilli = receivedTotal - onHandTotal;
        const soldPercent =
          receivedTotal > 0n ? Number((soldMilli * 1000n) / receivedTotal) / 10 : 0;

        return {
          allocated: shares.length,
          toInventoryMinor: serializeAmount(toInventory),
          toCogsMinor: serializeAmount(toCogs),
          soldShare: `${soldPercent.toFixed(1)}%`,
        };
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/purchases/landed-cost");
    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "applyLandedCost");
  }
}

/* ================================================================== */
/* ③ READS                                                             */
/* ================================================================== */

export async function getLandedCosts(): Promise<
  ActionResult<{
    purchases: {
      id: string;
      invoiceNumber: string | null;
      invoiceDate: string | null;
      vendorName: string | null;
      purchaseMinor: string;
      capitalisedMinor: string;
      recoverableMinor: string;
      landedMinor: string;
      upliftBps: number;
      explanation: string;
      chargeCount: number;
      unappliedCount: number;
    }[];
    totals: {
      capitalisedMinor: string;
      recoverableMinor: string;
      unapplied: number;
    };
  }>
> {
  try {
    const ctx = await requirePermission(READ);

    const data = await withTenant(ctx.tenant.id, async (tx) => {
      const charges = await tx
        .select({
          id: landedCosts.id,
          purchaseInvoiceId: landedCosts.purchaseInvoiceId,
          amountMinor: landedCosts.amountMinor,
          isRecoverable: landedCosts.isRecoverable,
          status: landedCosts.status,
        })
        .from(landedCosts)
        .where(eq(landedCosts.tenantId, ctx.tenant.id))
        .limit(2000);

      const invoiceIds = [
        ...new Set(charges.map((c) => c.purchaseInvoiceId).filter(Boolean)),
      ] as string[];

      const invoices =
        invoiceIds.length === 0
          ? []
          : await tx
              .select({
                id: purchaseInvoices.id,
                invoiceNumber: purchaseInvoices.invoiceNumber,
                invoiceDate: purchaseInvoices.invoiceDate,
                vendorName: vendors.legalName,
                totalMinor: purchaseInvoices.taxableValueMinor,
              })
              .from(purchaseInvoices)
              .leftJoin(
                vendors,
                and(
                  eq(vendors.id, purchaseInvoices.vendorId),
                  eq(vendors.tenantId, ctx.tenant.id),
                ),
              )
              .where(
                and(
                  eq(purchaseInvoices.tenantId, ctx.tenant.id),
                  sql`${purchaseInvoices.id} IN ${invoiceIds}`,
                ),
              );

      let capitalisedTotal = 0n;
      let recoverableTotal = 0n;
      let unappliedTotal = 0;

      const purchases = invoices.map((inv) => {
        const mine = charges.filter(
          (c) => c.purchaseInvoiceId === inv.id && c.status !== "cancelled",
        );
        const summary = summariseLandedCost({
          purchaseMinor: toBigIntAmount(inv.totalMinor),
          charges: mine.map((c) => ({
            amountMinor: toBigIntAmount(c.amountMinor),
            recoverable: c.isRecoverable,
          })),
        });
        capitalisedTotal += summary.capitalisedMinor;
        recoverableTotal += summary.recoverableMinor;
        const unapplied = mine.filter(
          (c) => c.status === "draft" && !c.isRecoverable,
        ).length;
        unappliedTotal += unapplied;

        return {
          id: inv.id,
          invoiceNumber: inv.invoiceNumber,
          invoiceDate: inv.invoiceDate ? String(inv.invoiceDate) : null,
          vendorName: inv.vendorName,
          purchaseMinor: serializeAmount(summary.purchaseMinor),
          capitalisedMinor: serializeAmount(summary.capitalisedMinor),
          recoverableMinor: serializeAmount(summary.recoverableMinor),
          landedMinor: serializeAmount(summary.landedMinor),
          upliftBps: summary.upliftBps,
          explanation: summary.explanation,
          chargeCount: mine.length,
          unappliedCount: unapplied,
        };
      });

      return {
        purchases: purchases.sort((a, b) => b.upliftBps - a.upliftBps),
        totals: {
          capitalisedMinor: serializeAmount(capitalisedTotal),
          recoverableMinor: serializeAmount(recoverableTotal),
          unapplied: unappliedTotal,
        },
      };
    });

    return { ok: true, data };
  } catch (err) {
    return toSalesActionError(err, "getLandedCosts");
  }
}

export async function getLandedCostCharges(purchaseInvoiceId: string): Promise<
  ActionResult<{
    rows: {
      id: string;
      costType: string;
      label: string;
      note: string;
      amountMinor: string;
      isRecoverable: boolean;
      apportionBasis: string;
      status: string;
      costDate: string;
      vendorInvoiceNo: string | null;
      toInventoryMinor: string;
      toCogsMinor: string;
    }[];
  }>
> {
  try {
    const ctx = await requirePermission(READ);

    const rows = await withTenant(ctx.tenant.id, async (tx) =>
      tx
        .select({
          id: landedCosts.id,
          costType: landedCosts.costType,
          amountMinor: landedCosts.amountMinor,
          isRecoverable: landedCosts.isRecoverable,
          apportionBasis: landedCosts.apportionBasis,
          status: landedCosts.status,
          costDate: landedCosts.costDate,
          vendorInvoiceNo: landedCosts.vendorInvoiceNo,
          toInventoryMinor: sql<string>`COALESCE((
            SELECT SUM(a.to_inventory_minor) FROM landed_cost_allocations a
             WHERE a.tenant_id = ${ctx.tenant.id} AND a.landed_cost_id = ${landedCosts.id}
          ), 0)`,
          toCogsMinor: sql<string>`COALESCE((
            SELECT SUM(a.to_cogs_minor) FROM landed_cost_allocations a
             WHERE a.tenant_id = ${ctx.tenant.id} AND a.landed_cost_id = ${landedCosts.id}
          ), 0)`,
        })
        .from(landedCosts)
        .where(
          and(
            eq(landedCosts.tenantId, ctx.tenant.id),
            eq(landedCosts.purchaseInvoiceId, purchaseInvoiceId),
          ),
        )
        .orderBy(desc(landedCosts.costDate)),
    );

    return {
      ok: true,
      data: {
        rows: rows.map((r) => {
          const meta = LANDED_COST_TYPES[r.costType as LandedCostType];
          return {
            id: r.id,
            costType: r.costType,
            label: meta?.label ?? r.costType,
            note: meta?.note ?? "",
            amountMinor: serializeAmount(toBigIntAmount(r.amountMinor)),
            isRecoverable: r.isRecoverable,
            apportionBasis: r.apportionBasis,
            status: r.status,
            costDate: String(r.costDate),
            vendorInvoiceNo: r.vendorInvoiceNo,
            toInventoryMinor: serializeAmount(toBigIntAmount(r.toInventoryMinor)),
            toCogsMinor: serializeAmount(toBigIntAmount(r.toCogsMinor)),
          };
        }),
      },
    };
  } catch (err) {
    return toSalesActionError(err, "getLandedCostCharges");
  }
}

/**
 * ⚠️ THE CHECK NOBODY RUNS UNTIL IT IS TOO LATE.
 *
 * A selling price set against the INVOICE price rather than the LANDED
 * price looks profitable and is not. On 4–8% trading margins an 8%
 * freight uplift turns every sale into a loss, and the P&L only says so
 * at the month end.
 */
export async function checkMarginAgainstLanded(input: {
  sellingPriceMinor: string;
  landedUnitCostMinor: string;
}): Promise<
  ActionResult<{ marginMinor: string; marginBps: number; belowCost: boolean; detail: string }>
> {
  try {
    await requirePermission(READ);
    const r = marginAgainstLanded({
      sellingPriceMinor: BigInt(input.sellingPriceMinor),
      landedUnitCostMinor: BigInt(input.landedUnitCostMinor),
    });
    return {
      ok: true,
      data: {
        marginMinor: serializeAmount(r.marginMinor),
        marginBps: r.marginBps,
        belowCost: r.belowCost,
        detail: r.detail,
      },
    };
  } catch (err) {
    return toSalesActionError(err, "checkMarginAgainstLanded");
  }
}
