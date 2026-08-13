"use server";

/**
 * Ordence — ⭐⭐ WHAT DOES THIS COST THIS CUSTOMER?
 * Version: v1.6.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION AND NONE TAKES A TENANT. The
 * arithmetic lives in `lib/pricing/resolve.ts` and in the slab
 * primitives in `db/schema/pricing.ts`, which are pure.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE GAP THIS MODULE CLOSES IS NOT A MISSING TABLE
 * ══════════════════════════════════════════════════════════════════════
 * `rate_cards` and `rate_slabs` have existed since 0034 and are good.
 * **Nothing ever selected one.** `sales_order_lines.unit_price_minor` is
 * typed in by hand — so a distributor with negotiated customer prices
 * retyped them on every line, and the price list was decoration.
 *
 * ⚠️ A `customer_price_lists` TABLE WOULD HAVE BEEN THE OBVIOUS FIX AND
 * IT WOULD HAVE BEEN THE MISTAKE. Two tables answering one question is
 * two answers, and the wrong one is whichever the invoice screen reads.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { withTenant } from "@/db";
import { rateCards, rateSlabs, type Slab } from "@/db/schema/pricing";
import { stockItems, stockBalances } from "@/db/schema/inventory";
import { companies } from "@/db/schema/crm";
import { requirePermission } from "@/server/audit";
import { toSalesActionError } from "@/server/sales/guards";
import {
  quoteQuantity,
  selectRateCard,
  validateSlabs,
  stripTax,
  type CandidateCard,
} from "@/lib/pricing/resolve";
import { serializeAmount, toBigIntAmount } from "@/lib/billing/money";
import type { ActionResult } from "@/lib/validators/crm";

const READ = "sales.orders.read" as const;

const civilDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");

const quoteSchema = z.object({
  companyId: z.string().uuid().nullish(),
  stockItemId: z.string().uuid(),
  quantity: z.string().regex(/^\d+$/, "Whole units."),
  onDate: civilDay,
  channel: z.string().trim().max(60).nullish(),
});

/**
 * ⭐⭐ QUOTE ONE LINE, AND SAY WHICH CARD WON AND WHY.
 *
 * ⚠️ THE "WHY" IS NOT DECORATION. When a customer rings up holding an
 * invoice at a different price, the question is which card applied and
 * what beat what. A quote that produces a number and no reasoning is a
 * quote nobody can defend on the phone.
 */
export async function quoteLine(input: unknown): Promise<
  ActionResult<{
    found: boolean;
    cardCode: string | null;
    cardName: string | null;
    slabMode: string | null;
    lineAmountMinor: string;
    unitPriceMinor: string;
    taxRateBps: number;
    taxableMinor: string;
    taxMinor: string;
    reason: string;
    selectionReason: string;
    runnersUp: { code: string; scope: string; reason: string }[];
    warnings: string[];
  }>
> {
  try {
    const data = quoteSchema.parse(input);
    const ctx = await requirePermission(READ);

    const result = await withTenant(ctx.tenant.id, async (tx) => {
      const cards = await tx
        .select({
          id: rateCards.id,
          code: rateCards.code,
          name: rateCards.name,
          scope: rateCards.scope,
          slabMode: rateCards.slabMode,
          priority: rateCards.priority,
          customerCompanyId: rateCards.customerCompanyId,
          appliesToKind: rateCards.appliesToKind,
          appliesToId: rateCards.appliesToId,
          channel: rateCards.channel,
          validFrom: rateCards.validFrom,
          validTo: rateCards.validTo,
          daysOfWeek: rateCards.daysOfWeek,
          baseAmountMinor: rateCards.baseAmountMinor,
          taxRateBps: rateCards.taxRateBps,
          isTaxInclusive: rateCards.isTaxInclusive,
          floorPriceMinor: rateCards.floorPriceMinor,
          isActive: rateCards.isActive,
        })
        .from(rateCards)
        .where(and(eq(rateCards.tenantId, ctx.tenant.id), isNull(rateCards.deletedAt)))
        .limit(1000);

      const candidates: CandidateCard[] = cards.map((c) => ({
        id: c.id,
        code: c.code,
        name: c.name,
        scope: c.scope,
        slabMode: c.slabMode,
        priority: c.priority,
        customerCompanyId: c.customerCompanyId,
        appliesToKind: c.appliesToKind,
        appliesToId: c.appliesToId,
        channel: c.channel,
        validFrom: c.validFrom ? String(c.validFrom) : null,
        validTo: c.validTo ? String(c.validTo) : null,
        daysOfWeek: c.daysOfWeek,
        baseAmountMinor: toBigIntAmount(c.baseAmountMinor),
        taxRateBps: c.taxRateBps,
        isTaxInclusive: c.isTaxInclusive,
        floorPriceMinor:
          c.floorPriceMinor === null ? null : toBigIntAmount(c.floorPriceMinor),
        isActive: c.isActive,
      }));

      const selection = selectRateCard({
        cards: candidates,
        customerCompanyId: data.companyId ?? null,
        appliesToKind: "stock_item",
        appliesToId: data.stockItemId,
        onDate: data.onDate,
        channel: data.channel ?? null,
      });

      if (!selection) {
        return {
          found: false,
          cardCode: null,
          cardName: null,
          slabMode: null,
          lineAmountMinor: "0",
          unitPriceMinor: "0",
          taxRateBps: 0,
          taxableMinor: "0",
          taxMinor: "0",
          reason: "",
          /**
           * ⚠️ A MISSING PRICE IS SAID PLAINLY, not returned as zero.
           * A quote of ₹0.00 looks like a decision somebody made.
           */
          selectionReason:
            "No rate card covers this customer and item on that date. The line has no price until one does — Ordence will not quote ₹0.00 and let it look like a decision.",
          runnersUp: [],
          warnings: [],
        };
      }

      const slabRows = await tx
        .select({
          sequence: rateSlabs.sequence,
          upToQuantity: rateSlabs.upToQuantity,
          unitAmountMinor: rateSlabs.unitAmountMinor,
          fixedAmountMinor: rateSlabs.fixedAmountMinor,
        })
        .from(rateSlabs)
        .where(
          and(
            eq(rateSlabs.tenantId, ctx.tenant.id),
            eq(rateSlabs.rateCardId, selection.card.id),
          ),
        )
        .orderBy(rateSlabs.sequence);

      const slabs: Slab[] = slabRows.map((s) => ({
        sequence: s.sequence,
        upToQuantity: s.upToQuantity === null ? null : toBigIntAmount(s.upToQuantity),
        unitAmountMinor: toBigIntAmount(s.unitAmountMinor),
        fixedAmountMinor: toBigIntAmount(s.fixedAmountMinor),
      }));

      /**
       * ⭐ THE LANDED COST, FROM 0056. A price set against the supplier's
       * invoice looks profitable; the freight and duty on top are what
       * make it a loss — and on 4–8% trading margins an 8% uplift is the
       * whole margin.
       */
      const [balance] = await tx
        .select({
          onHand: stockBalances.quantityOnHand,
          valueMinor: stockBalances.valueMinor,
        })
        .from(stockBalances)
        .where(
          and(
            eq(stockBalances.tenantId, ctx.tenant.id),
            eq(stockBalances.stockItemId, data.stockItemId),
          ),
        )
        .limit(1);

      const onHand = Number(balance?.onHand ?? 0);
      const landedUnitCostMinor =
        onHand > 0
          ? toBigIntAmount(balance?.valueMinor ?? 0n) / BigInt(Math.round(onHand))
          : null;

      const quote = quoteQuantity({
        card: selection.card,
        slabs,
        quantity: BigInt(data.quantity),
        landedUnitCostMinor,
      });

      /**
       * ⚠️ A TAX-INCLUSIVE CARD IS STRIPPED HERE, ONCE, IN INTEGER
       * ARITHMETIC. Dividing ₹118 by 1.18 in floating point gives
       * 99.99999999999999, and the invoice then shows ₹99.99 + ₹18.00
       * against a shelf price of ₹118.
       */
      const { taxableMinor, taxMinor } = quote.isTaxInclusive
        ? stripTax({
            inclusiveMinor: quote.lineAmountMinor,
            taxRateBps: quote.taxRateBps,
          })
        : {
            taxableMinor: quote.lineAmountMinor,
            taxMinor:
              (quote.lineAmountMinor * BigInt(quote.taxRateBps) + 5000n) / 10000n,
          };

      return {
        found: true,
        cardCode: quote.cardCode,
        cardName: quote.cardName,
        slabMode: quote.slabMode,
        lineAmountMinor: serializeAmount(quote.lineAmountMinor),
        unitPriceMinor: serializeAmount(quote.unitPriceMinor),
        taxRateBps: quote.taxRateBps,
        taxableMinor: serializeAmount(taxableMinor),
        taxMinor: serializeAmount(taxMinor),
        reason: quote.reason,
        selectionReason: selection.reason,
        runnersUp: selection.runnersUp,
        warnings: quote.warnings,
      };
    });

    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "quoteLine");
  }
}

/**
 * ⭐ EVERY RATE CARD, WITH ITS BANDS CHECKED.
 *
 * 🔴 THE PROBLEMS ARE THE POINT OF THE SCREEN. A gap between bands is
 *    quiet and expensive: `priceFlat` falls through to the last band, so
 *    a quantity matching nothing is charged at the TOP rate rather than
 *    erroring. Nobody finds that by looking at the card.
 */
export async function getRateCardHealth(): Promise<
  ActionResult<{
    rows: {
      id: string;
      code: string;
      name: string;
      scope: string;
      slabMode: string;
      customerName: string | null;
      itemName: string | null;
      validFrom: string | null;
      validTo: string | null;
      floorPriceMinor: string | null;
      slabCount: number;
      problems: { sequence: number; problem: string }[];
    }[];
    withProblems: number;
  }>
> {
  try {
    const ctx = await requirePermission(READ);

    const data = await withTenant(ctx.tenant.id, async (tx) => {
      const cards = await tx
        .select({
          id: rateCards.id,
          code: rateCards.code,
          name: rateCards.name,
          scope: rateCards.scope,
          slabMode: rateCards.slabMode,
          customerCompanyId: rateCards.customerCompanyId,
          appliesToId: rateCards.appliesToId,
          validFrom: rateCards.validFrom,
          validTo: rateCards.validTo,
          floorPriceMinor: rateCards.floorPriceMinor,
          customerName: companies.name,
          itemName: sql<string>`(
            SELECT i.name FROM stock_items i
             WHERE i.id = ${rateCards.appliesToId} AND i.tenant_id = ${ctx.tenant.id}
          )`,
        })
        .from(rateCards)
        .leftJoin(
          companies,
          and(
            eq(companies.id, rateCards.customerCompanyId),
            eq(companies.tenantId, ctx.tenant.id),
          ),
        )
        .where(and(eq(rateCards.tenantId, ctx.tenant.id), isNull(rateCards.deletedAt)))
        .limit(500);

      const allSlabs = await tx
        .select({
          rateCardId: rateSlabs.rateCardId,
          sequence: rateSlabs.sequence,
          upToQuantity: rateSlabs.upToQuantity,
          unitAmountMinor: rateSlabs.unitAmountMinor,
          fixedAmountMinor: rateSlabs.fixedAmountMinor,
        })
        .from(rateSlabs)
        .where(eq(rateSlabs.tenantId, ctx.tenant.id))
        .limit(5000);

      const rows = cards.map((c) => {
        const mine: Slab[] = allSlabs
          .filter((s) => s.rateCardId === c.id)
          .map((s) => ({
            sequence: s.sequence,
            upToQuantity:
              s.upToQuantity === null ? null : toBigIntAmount(s.upToQuantity),
            unitAmountMinor: toBigIntAmount(s.unitAmountMinor),
            fixedAmountMinor: toBigIntAmount(s.fixedAmountMinor),
          }));
        return {
          id: c.id,
          code: c.code,
          name: c.name,
          scope: c.scope,
          slabMode: c.slabMode,
          customerName: c.customerName,
          itemName: c.itemName,
          validFrom: c.validFrom ? String(c.validFrom) : null,
          validTo: c.validTo ? String(c.validTo) : null,
          floorPriceMinor:
            c.floorPriceMinor === null
              ? null
              : serializeAmount(toBigIntAmount(c.floorPriceMinor)),
          slabCount: mine.length,
          problems: validateSlabs(mine),
        };
      });

      return {
        rows,
        withProblems: rows.filter((r) => r.problems.length > 0).length,
      };
    });

    return { ok: true, data };
  } catch (err) {
    return toSalesActionError(err, "getRateCardHealth");
  }
}

export async function getPricingOptions(): Promise<
  ActionResult<{
    companies: { id: string; name: string }[];
    items: { id: string; name: string; uom: string }[];
  }>
> {
  try {
    const ctx = await requirePermission(READ);
    const data = await withTenant(ctx.tenant.id, async (tx) => {
      const cos = await tx
        .select({ id: companies.id, name: companies.name })
        .from(companies)
        .where(and(eq(companies.tenantId, ctx.tenant.id), isNull(companies.deletedAt)))
        .limit(500);
      const its = await tx
        .select({ id: stockItems.id, name: stockItems.name, uom: stockItems.uom })
        .from(stockItems)
        .where(and(eq(stockItems.tenantId, ctx.tenant.id), isNull(stockItems.deletedAt)))
        .limit(500);
      return { companies: cos, items: its };
    });
    return { ok: true, data };
  } catch (err) {
    return toSalesActionError(err, "getPricingOptions");
  }
}
