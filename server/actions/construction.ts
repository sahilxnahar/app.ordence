"use server";

/**
 * Ordence — ⭐ BOQ & MEASUREMENT · WRITE ACTIONS
 * Version: v0.69.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION. A `"use server"` file that
 * exports anything else — a constant, a helper, a plain object —
 * publishes it as an RPC endpoint reachable by anyone on the internet.
 * The helpers below are deliberately not exported.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS FILE DID NOT EXIST UNTIL NOW, AND WHAT THAT MEANT
 * ══════════════════════════════════════════════════════════════════════
 * The construction schema has eleven tables, composite foreign keys
 * throughout, a trigger that refuses to let a billed measurement be
 * edited, and a view that reports authorised-versus-measured per line.
 * All of it was reachable only by writing SQL by hand.
 *
 * So the most carefully built part of the product was also the only part
 * a customer could not use. This file is the way in.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ QUANTITIES ARE MICRO-UNITS (1e6). 12.345 cum IS STORED AS 12345000.
 * ══════════════════════════════════════════════════════════════════════
 * A BOQ quantity of one third of a cubic metre has no exact decimal form.
 * Held as a float it drifts, and the drift compounds across four RA bills
 * until the final bill disagrees with the sum of the interim ones by an
 * amount somebody has to explain to a contractor.
 *
 * ⚠️ THE CONVERSION HAPPENS IN EXACTLY ONE PLACE — `toMicro()` below —
 * and it uses string arithmetic, not `Math.round(x * 1e6)`. The obvious
 * form is wrong: `Math.round(0.07 * 1e6)` is 70000 but
 * `Math.round(8.115 * 1e6)` is 8114999, because 8.115 has no exact binary
 * representation. One unit in a million sounds harmless until it is a
 * quantity that fails a `=` comparison against the contractor's own
 * spreadsheet.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE SEPARATION THIS FILE ENFORCES
 * ══════════════════════════════════════════════════════════════════════
 *   `construction.measurement.record`  — the site engineer measures
 *   `construction.measurement.check`   — SOMEBODY ELSE agrees
 *
 * ⚠️ AND `checkMeasurement()` ALSO REFUSES THE SAME PERSON AT RUNTIME,
 * not only by permission. A workspace can grant one user both keys —
 * small firms do, and it is their call — but self-checking your own
 * measurement is the one thing the control exists to prevent, so it is
 * refused explicitly and with a reason. Two independent layers.
 */

import { z } from "zod";
import { and, eq, sql, desc } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withTenant } from "@/db";
import { boqs, boqItems, measurementBooks, measurementEntries } from "@/db/schema";
import { requirePermission, writeAudit } from "@/server/audit";
import { guardSalesWrite, toSalesActionError, salesFail } from "@/server/sales/guards";
import type { ActionResult } from "@/lib/validators/crm";

const BOQ_FEATURE = "construction.boq" as const;

/* ------------------------------------------------------------------ */
/* UNITS — the only conversion in the file                             */
/* ------------------------------------------------------------------ */

/** How many micro-units in one whole unit. */
const MICRO = 1_000_000n;

/**
 * A decimal quantity as a string → micro-units.
 *
 * ⚠️ STRING ARITHMETIC, NOT `Math.round(value * 1e6)`.
 *
 * The float form is wrong for values that have no exact binary
 * representation, and it is wrong quietly:
 *
 *     Math.round(8.115 * 1e6)  →  8114999   (not 8115000)
 *     Math.round(1.005 * 1e6)  →  1004999
 *
 * One millionth of a cubic metre is nothing. A quantity that fails an
 * exact comparison against the contractor's own spreadsheet, in a
 * meeting, is not nothing — and the sixth decimal place is precisely
 * where nobody thinks to look.
 *
 * Returns null when the input is not a well-formed decimal, so the
 * caller refuses rather than storing a silent zero.
 */
function toMicro(value: string): bigint | null {
  const trimmed = value.trim();
  const match = /^(-?)(\d+)(?:\.(\d{1,6}))?$/.exec(trimmed);
  if (!match) return null;

  const [, sign, whole, fraction = ""] = match;
  const padded = (fraction + "000000").slice(0, 6);
  const magnitude = BigInt(whole!) * MICRO + BigInt(padded);
  return sign === "-" ? -magnitude : magnitude;
}

/** Rupees as a decimal string → paise. Same reasoning as `toMicro`. */
function toPaise(value: string): bigint | null {
  const trimmed = value.trim();
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!match) return null;

  const [, sign, whole, fraction = ""] = match;
  const padded = (fraction + "00").slice(0, 2);
  const magnitude = BigInt(whole!) * 100n + BigInt(padded);
  return sign === "-" ? -magnitude : magnitude;
}

/**
 * quantity (micro) × rate (paise per unit) → amount (paise), half-up.
 *
 * ⚠️ HALF-UP, NOT BANKER'S ROUNDING, AND NOT `Math.round`. Tally rounds
 * half away from zero, and this product's whole India accounting stack
 * matches Tally deliberately — a BOQ amount that differs from the
 * accounting system by one paisa is a reconciliation somebody spends an
 * afternoon on.
 *
 * Done in BigInt throughout: a tower's contract sum in paise passes
 * 2^53 at around ₹90,000 crore, and portfolio totals get there.
 */
function amountMinor(quantityMicro: bigint, rateMinor: bigint): bigint {
  const product = quantityMicro * rateMinor;
  const negative = product < 0n;
  const magnitude = negative ? -product : product;
  // + half a divisor before dividing == round half away from zero.
  const rounded = (magnitude + MICRO / 2n) / MICRO;
  return negative ? -rounded : rounded;
}

/**
 * ⚠️ `tx.execute` RETURNS EITHER AN ARRAY OR `{ rows }` DEPENDING ON THE
 * DRIVER PATH. Both shapes occur in this codebase, and reading the wrong
 * one yields an empty result rather than an error — a BOQ that renders as
 * having no items, which reads as "nothing priced yet".
 */
function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

/* ------------------------------------------------------------------ */
/* SHARED VALIDATION                                                   */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ A DECIMAL STRING, NEVER `z.number()`.
 *
 * A quantity that arrives as a JavaScript number has already been through
 * a float before this code sees it, so validating it here validates
 * something that is already wrong. The form sends the text the user
 * typed; `toMicro` is the only thing that interprets it.
 */
const decimalString = z
  .string()
  .trim()
  .min(1, "Required.")
  .max(24, "That number is too long.");

const UOM_VALUES = [
  "cum", "sqm", "sqft", "rmt", "kg", "mt", "quintal",
  "nos", "bag", "brass", "ltr", "day", "month", "ls",
] as const;

const CATEGORY_VALUES = [
  "earthwork", "piling_foundation", "concrete", "reinforcement", "formwork",
  "masonry", "plaster", "flooring", "waterproofing", "doors_windows",
  "painting", "plumbing", "electrical", "hvac", "fire_fighting", "lifts",
  "external_development", "preliminaries", "miscellaneous",
] as const;

/* ------------------------------------------------------------------ */
/* 1 · CREATE A BOQ                                                    */
/* ------------------------------------------------------------------ */

const createBoqSchema = z.object({
  projectId: z.string().uuid("Choose a project."),
  workPackage: z.string().trim().min(1, "Name the work package.").max(200),
  code: z.string().trim().min(1, "A code is required.").max(60),
  title: z.string().trim().min(1, "A title is required.").max(255),
  contractorVendorId: z.string().uuid().nullable().optional(),
  /** The works contract this BOQ is annexed to, where one exists yet. */
  contractId: z.string().uuid().nullable().optional(),
  contractRef: z.string().trim().max(120).nullable().optional(),
  /** 500 = 5%. */
  retentionRateBps: z.number().int().min(0).max(10000).optional(),
});

export async function createBoq(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const data = createBoqSchema.parse(input);

    const ctx = await guardSalesWrite({
      operation: "boq:create",
      feature: BOQ_FEATURE,
      permission: "construction.boq.manage",
    });

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [row] = await tx
          .insert(boqs)
          .values({
            tenantId: ctx.tenant.id,
            projectId: data.projectId,
            workPackage: data.workPackage,
            code: data.code,
            title: data.title,
            contractorVendorId: data.contractorVendorId ?? null,
            contractId: data.contractId ?? null,
            contractRef: data.contractRef ?? null,
            ...(data.retentionRateBps !== undefined
              ? { retentionRateBps: data.retentionRateBps }
              : {}),
          })
          .returning({ id: boqs.id });

        if (!row) throw new Error("The BOQ could not be created.");
        return { id: row.id };
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: "create",
      resourceType: "boq",
      resourceId: result.id,
      metadata: { code: data.code, projectId: data.projectId },
    });

    revalidatePath("/boq");
    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "createBoq");
  }
}

/* ------------------------------------------------------------------ */
/* 2 · PRICE IT — ADD LINE ITEMS                                       */
/* ------------------------------------------------------------------ */

const boqItemInput = z.object({
  itemCode: z.string().trim().min(1, "Every item needs a code.").max(60),
  description: z.string().trim().min(1, "Describe the item.").max(4000),
  uom: z.enum(UOM_VALUES),
  category: z.enum(CATEGORY_VALUES).optional(),
  /** Decimal string. See `toMicro`. */
  quantity: decimalString,
  /** Rupees per unit, decimal string. */
  rate: decimalString,
  isHeading: z.boolean().optional(),
  specificationRef: z.string().trim().max(120).nullable().optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
});

const addBoqItemsSchema = z.object({
  boqId: z.string().uuid(),
  items: z.array(boqItemInput).min(1, "Add at least one item.").max(500),
});

/**
 * Add priced lines to a BOQ, and refresh the contract sum from them.
 *
 * ⚠️ THE WHOLE CALL IS ONE TRANSACTION. A BOQ whose items were written
 * but whose `original_sum_minor` was not is a contract sum that disagrees
 * with the sum of its own lines — and every screen shows the header
 * figure, so the discrepancy is invisible until somebody adds up the
 * annexure by hand.
 */
export async function addBoqItems(
  input: unknown,
): Promise<ActionResult<{ added: number; originalSumMinor: string }>> {
  try {
    const data = addBoqItemsSchema.parse(input);

    const ctx = await guardSalesWrite({
      operation: "boq:update",
      feature: BOQ_FEATURE,
      permission: "construction.boq.manage",
      resource: { type: "boq", id: data.boqId },
    });

    /*
     * ⚠️ PARSED BEFORE THE TRANSACTION OPENS. A malformed quantity on
     * item 340 of 500 would otherwise be discovered with the first 339
     * already written — and although the transaction rolls back, the
     * user is told "invalid number" with no clue which line, having
     * waited for 339 inserts to happen and unhappen.
     */
    const prepared: Array<{
      itemCode: string;
      description: string;
      uom: (typeof UOM_VALUES)[number];
      category: (typeof CATEGORY_VALUES)[number];
      quantityScaled: bigint;
      rateMinor: bigint;
      amountMinor: bigint;
      isHeading: boolean;
      specificationRef: string | null;
      notes: string | null;
    }> = [];

    const fieldErrors: Record<string, string[]> = {};

    data.items.forEach((item, index) => {
      const quantityScaled = toMicro(item.quantity);
      const rateMinor = toPaise(item.rate);

      if (quantityScaled === null) {
        fieldErrors[`items.${index}.quantity`] = [
          "Enter a number with up to six decimal places.",
        ];
      }
      if (rateMinor === null) {
        fieldErrors[`items.${index}.rate`] = [
          "Enter an amount in rupees, with up to two decimal places.",
        ];
      }
      if (quantityScaled !== null && quantityScaled < 0n) {
        fieldErrors[`items.${index}.quantity`] = [
          "A BOQ quantity cannot be negative. An omission is a variation, not a negative line.",
        ];
      }
      if (rateMinor !== null && rateMinor < 0n) {
        fieldErrors[`items.${index}.rate`] = ["A rate cannot be negative."];
      }
      if (quantityScaled === null || rateMinor === null) return;

      prepared.push({
        itemCode: item.itemCode,
        description: item.description,
        uom: item.uom,
        category: item.category ?? "miscellaneous",
        quantityScaled,
        rateMinor,
        amountMinor: amountMinor(quantityScaled, rateMinor),
        isHeading: item.isHeading ?? false,
        specificationRef: item.specificationRef ?? null,
        notes: item.notes ?? null,
      });
    });

    if (Object.keys(fieldErrors).length > 0) {
      return salesFail("Some lines could not be read.", fieldErrors);
    }

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [boq] = await tx
          .select({ id: boqs.id, status: boqs.status })
          .from(boqs)
          .where(and(eq(boqs.tenantId, ctx.tenant.id), eq(boqs.id, data.boqId)))
          .limit(1);

        if (!boq) throw new Error("That BOQ does not exist.");

        /*
         * ⚠️ ONLY A DRAFT MAY BE PRICED.
         *
         * An issued BOQ is the priced annexure to a signed contract.
         * Adding a line to it changes what the contractor agreed to,
         * retrospectively, with no variation order and no approval — and
         * every RA bill already raised against it silently becomes
         * measured against different totals. Extra scope after issue is
         * a VARIATION, which is a different table with its own approval
         * workflow, and that is the whole reason it exists.
         */
        if (boq.status !== "draft") {
          throw new Error(
            `This BOQ has been ${boq.status} and can no longer be priced. Extra or changed scope after issue is a variation order, which keeps the original contract sum intact and records who approved the change.`,
          );
        }

        /*
         * ⚠️ SEQUENCE CONTINUES FROM WHAT IS ALREADY THERE. There is a
         * unique index on (boq_id, sequence); restarting at 1 on a
         * second call would collide, and the error a user sees would be
         * a constraint name rather than anything meaningful.
         */
        const [maxRow] = await tx
          .select({ maxSeq: sql<number>`COALESCE(MAX(${boqItems.sequence}), 0)` })
          .from(boqItems)
          .where(
            and(eq(boqItems.tenantId, ctx.tenant.id), eq(boqItems.boqId, data.boqId)),
          );

        let sequence = Number(maxRow?.maxSeq ?? 0);

        await tx.insert(boqItems).values(
          prepared.map((item) => ({
            tenantId: ctx.tenant.id,
            boqId: data.boqId,
            sequence: ++sequence,
            itemCode: item.itemCode,
            description: item.description,
            uom: item.uom,
            category: item.category,
            quantityScaled: item.quantityScaled,
            rateMinor: item.rateMinor,
            amountMinor: item.amountMinor,
            isHeading: item.isHeading,
            specificationRef: item.specificationRef,
            notes: item.notes,
          })),
        );

        /*
         * ⭐ THE CONTRACT SUM IS RECOMPUTED FROM THE LINES, NOT
         * INCREMENTED.
         *
         * ⚠️ `+= total` would be right today and would drift the first
         * time a line is corrected, deleted, or written by anything other
         * than this function. Summing the lines is one indexed aggregate
         * and is correct by construction: delete the header figure and it
         * comes back right.
         *
         * ⚠️ HEADINGS ARE EXCLUDED. A heading row carries no quantity and
         * no money; including it would be harmless today and wrong the
         * moment somebody puts a subtotal on one.
         */
        const [sums] = await tx
          .select({
            total: sql<string>`COALESCE(SUM(${boqItems.amountMinor}), 0)::text`,
          })
          .from(boqItems)
          .where(
            and(
              eq(boqItems.tenantId, ctx.tenant.id),
              eq(boqItems.boqId, data.boqId),
              eq(boqItems.isHeading, false),
            ),
          );

        const originalSumMinor = BigInt(sums?.total ?? "0");

        await tx
          .update(boqs)
          .set({
            originalSumMinor,
            // Revised = original + variations. No variations exist yet on
            // a draft, so the two agree; stated rather than left null so
            // that a report reading `revised` never sees a hole.
            revisedSumMinor: originalSumMinor,
            updatedAt: new Date(),
          })
          .where(and(eq(boqs.tenantId, ctx.tenant.id), eq(boqs.id, data.boqId)));

        return { added: prepared.length, originalSumMinor: originalSumMinor.toString() };
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: "update",
      resourceType: "boq",
      resourceId: data.boqId,
      metadata: { itemsAdded: result.added, originalSumMinor: result.originalSumMinor },
    });

    revalidatePath("/boq");
    revalidatePath(`/boq/${data.boqId}`);
    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "addBoqItems");
  }
}

/* ------------------------------------------------------------------ */
/* 3 · ISSUE IT                                                        */
/* ------------------------------------------------------------------ */

const issueBoqSchema = z.object({
  boqId: z.string().uuid(),
  contractDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.").optional(),
});

/**
 * Move a BOQ from draft to issued.
 *
 * ⚠️ THIS IS A ONE-WAY DOOR AND IT IS TREATED AS ONE. After this, the
 * lines are frozen and every change is a variation order. That is the
 * point — an issued BOQ is what the contractor priced and what every RA
 * bill is measured against, and a contract annexure that can still be
 * edited is not an annexure.
 */
export async function issueBoq(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const data = issueBoqSchema.parse(input);

    const ctx = await guardSalesWrite({
      operation: "boq:issue",
      feature: BOQ_FEATURE,
      permission: "construction.boq.manage",
      resource: { type: "boq", id: data.boqId },
    });

    await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [boq] = await tx
          .select({
            status: boqs.status,
            originalSumMinor: boqs.originalSumMinor,
          })
          .from(boqs)
          .where(and(eq(boqs.tenantId, ctx.tenant.id), eq(boqs.id, data.boqId)))
          .limit(1);

        if (!boq) throw new Error("That BOQ does not exist.");
        if (boq.status !== "draft") {
          throw new Error(`This BOQ is already ${boq.status}.`);
        }

        const [counts] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(boqItems)
          .where(
            and(
              eq(boqItems.tenantId, ctx.tenant.id),
              eq(boqItems.boqId, data.boqId),
              eq(boqItems.isHeading, false),
            ),
          );

        /*
         * ⚠️ AN EMPTY BOQ CANNOT BE ISSUED. It would be a contract
         * annexure authorising nothing, and — worse — every RA bill line
         * raised against it would find no BOQ item, so SQL 0041's
         * over-billing guard would skip all of them. An empty issued BOQ
         * turns the guard off for that contract without saying so.
         */
        if (Number(counts?.n ?? 0) === 0) {
          throw new Error(
            "This BOQ has no priced items. Issuing it would authorise nothing, and every bill raised against it would go unchecked.",
          );
        }

        await tx
          .update(boqs)
          .set({
            status: "issued",
            ...(data.contractDate ? { contractDate: data.contractDate } : {}),
            updatedAt: new Date(),
          })
          .where(and(eq(boqs.tenantId, ctx.tenant.id), eq(boqs.id, data.boqId)));
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: "update",
      resourceType: "boq",
      resourceId: data.boqId,
      metadata: { status: "issued" },
      severity: "warning",
      reason: "BOQ issued — lines are frozen; further change requires a variation order.",
    });

    revalidatePath("/boq");
    revalidatePath(`/boq/${data.boqId}`);
    return { ok: true, data: { id: data.boqId } };
  } catch (err) {
    return toSalesActionError(err, "issueBoq");
  }
}

/* ------------------------------------------------------------------ */
/* 4 · OPEN A MEASUREMENT BOOK                                         */
/* ------------------------------------------------------------------ */

const openBookSchema = z.object({
  boqId: z.string().uuid(),
  bookNumber: z.string().trim().min(1, "Number the book.").max(60),
  title: z.string().trim().max(255).nullable().optional(),
  openedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD."),
});

export async function openMeasurementBook(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const data = openBookSchema.parse(input);

    const ctx = await guardSalesWrite({
      operation: "measurementBook:create",
      feature: BOQ_FEATURE,
      permission: "construction.boq.manage",
    });

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [boq] = await tx
          .select({ projectId: boqs.projectId, status: boqs.status })
          .from(boqs)
          .where(and(eq(boqs.tenantId, ctx.tenant.id), eq(boqs.id, data.boqId)))
          .limit(1);

        if (!boq) throw new Error("That BOQ does not exist.");

        /*
         * ⚠️ A DRAFT BOQ CANNOT HAVE A MEASUREMENT BOOK. Measuring
         * against prices nobody has agreed produces a measurement that
         * looks authoritative and is against a rate that may still
         * change — and the measurement is what becomes the bill.
         */
        if (boq.status === "draft") {
          throw new Error(
            "This BOQ has not been issued yet. Measuring against a draft would record work against rates that can still change before anyone signs.",
          );
        }

        const [row] = await tx
          .insert(measurementBooks)
          .values({
            tenantId: ctx.tenant.id,
            // ⚠️ Taken from the BOQ, never from the caller. A book whose
            // project disagrees with its BOQ's project would put measured
            // work on the wrong project's cost report, and the two
            // reports would each look internally consistent.
            projectId: boq.projectId,
            boqId: data.boqId,
            bookNumber: data.bookNumber,
            title: data.title ?? null,
            openedOn: data.openedOn,
            createdBy: ctx.user.id,
          })
          .returning({ id: measurementBooks.id });

        if (!row) throw new Error("The measurement book could not be opened.");
        return { id: row.id };
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: "create",
      resourceType: "measurement_book",
      resourceId: result.id,
      metadata: { boqId: data.boqId, bookNumber: data.bookNumber },
    });

    revalidatePath(`/boq/${data.boqId}`);
    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "openMeasurementBook");
  }
}

/* ------------------------------------------------------------------ */
/* 5 · RECORD A MEASUREMENT                                            */
/* ------------------------------------------------------------------ */

const recordMeasurementSchema = z.object({
  measurementBookId: z.string().uuid(),
  boqItemId: z.string().uuid(),
  locationRef: z.string().trim().min(1, "Say where this was measured.").max(200),
  levelRef: z.string().trim().max(100).nullable().optional(),
  description: z.string().trim().max(4000).nullable().optional(),
  pageRef: z.string().trim().max(40).nullable().optional(),
  measuredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD."),
  /**
   * ⭐ THE FOUR DIMENSIONS OF A CLASSIC MB ENTRY: nos × L × B × D.
   * All optional — a `nos` item has only the first, a `rmt` item only the
   * first two. When any are given, the quantity is DERIVED from them.
   */
  nos: decimalString.nullable().optional(),
  length: decimalString.nullable().optional(),
  breadth: decimalString.nullable().optional(),
  depth: decimalString.nullable().optional(),
  /** Used only when no dimensions are supplied. */
  quantity: decimalString.nullable().optional(),
  /** A void, an opening, a cut-out. Subtracts rather than adds. */
  isDeduction: z.boolean().optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
});

export async function recordMeasurement(
  input: unknown,
): Promise<ActionResult<{ id: string; quantityScaled: string }>> {
  try {
    const data = recordMeasurementSchema.parse(input);

    const ctx = await guardSalesWrite({
      operation: "measurement:create",
      feature: BOQ_FEATURE,
      permission: "construction.measurement.record",
    });

    /*
     * ⭐ THE QUANTITY IS DERIVED FROM THE DIMENSIONS WHEN THEY ARE GIVEN.
     *
     * ⚠️ AND THE DIMENSIONS WIN OVER A TYPED QUANTITY, ALWAYS. Accepting
     * both and trusting the typed one would let an entry read
     * "2 × 3.5 × 0.23 = 9.000" — dimensions that say 1.610 and a total
     * that says otherwise. That is the single most common way a
     * measurement book is falsified, and it is also the most common
     * honest transcription error. Either way the fix is the same: the
     * dimensions are the measurement, and the total is arithmetic.
     *
     * ⚠️ MULTIPLIED IN MICRO-UNITS THROUGHOUT, WITH A DIVISION AFTER EACH
     * STEP. Four values each scaled by 1e6 multiply to 1e24, so the scale
     * has to come back out or the result is off by a factor of a
     * trillion — the kind of error that produces a quantity so absurd
     * somebody notices, right up until the day it does not.
     */
    const dimensions = [data.nos, data.length, data.breadth, data.depth];
    const anyDimension = dimensions.some((d) => d != null && d !== "");

    const parsedDimensions: Array<bigint | null> = dimensions.map((d) =>
      d == null || d === "" ? null : toMicro(d),
    );

    if (parsedDimensions.some((d, i) => dimensions[i] != null && dimensions[i] !== "" && d === null)) {
      return salesFail("A dimension could not be read.", {
        nos: ["Enter numbers with up to six decimal places."],
      });
    }

    let quantityScaled: bigint | null;

    if (anyDimension) {
      let running = MICRO; // 1.000000 in micro-units
      for (const dimension of parsedDimensions) {
        if (dimension === null) continue;
        running = (running * dimension) / MICRO;
      }
      quantityScaled = running;
    } else {
      if (!data.quantity) {
        return salesFail("Enter the dimensions, or a quantity.", {
          quantity: ["Give nos × length × breadth × depth, or a direct quantity."],
        });
      }
      quantityScaled = toMicro(data.quantity);
    }

    if (quantityScaled === null) {
      return salesFail("That quantity could not be read.", {
        quantity: ["Enter a number with up to six decimal places."],
      });
    }
    if (quantityScaled <= 0n) {
      /*
       * ⚠️ A DEDUCTION IS FLAGGED, NOT SIGNED. `is_deduction` is what the
       * consumption view and SQL 0041's billing view both read; a
       * negative quantity would be counted as measured work of a negative
       * amount by one and as a deduction by the other, and the two
       * reports would disagree with no way to tell which was right.
       */
      return salesFail("A measurement must be a positive quantity.", {
        quantity: [
          "Enter the size of the void or opening as a positive number and tick 'deduction'.",
        ],
      });
    }

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [book] = await tx
          .select({ id: measurementBooks.id, isClosed: measurementBooks.isClosed })
          .from(measurementBooks)
          .where(
            and(
              eq(measurementBooks.tenantId, ctx.tenant.id),
              eq(measurementBooks.id, data.measurementBookId),
            ),
          )
          .limit(1);

        if (!book) throw new Error("That measurement book does not exist.");
        if (book.isClosed) {
          throw new Error(
            "That measurement book is closed. Open a new book rather than adding to a closed one — a closed book is what was certified.",
          );
        }

        const [maxRow] = await tx
          .select({
            maxSeq: sql<number>`COALESCE(MAX(${measurementEntries.sequence}), 0)`,
          })
          .from(measurementEntries)
          .where(
            and(
              eq(measurementEntries.tenantId, ctx.tenant.id),
              eq(measurementEntries.measurementBookId, data.measurementBookId),
            ),
          );

        const [row] = await tx
          .insert(measurementEntries)
          .values({
            tenantId: ctx.tenant.id,
            measurementBookId: data.measurementBookId,
            boqItemId: data.boqItemId,
            sequence: Number(maxRow?.maxSeq ?? 0) + 1,
            pageRef: data.pageRef ?? null,
            locationRef: data.locationRef,
            levelRef: data.levelRef ?? null,
            description: data.description ?? null,
            nosScaled: parsedDimensions[0],
            lengthScaled: parsedDimensions[1],
            breadthScaled: parsedDimensions[2],
            depthScaled: parsedDimensions[3],
            quantityScaled: quantityScaled!,
            isDeduction: data.isDeduction ?? false,
            measuredOn: data.measuredOn,
            // ⚠️ The recorder is the SESSION user, never a field on the
            // form. A measurement attributable to somebody who did not
            // take it is worse than an unattributed one.
            measuredBy: ctx.user.id,
            notes: data.notes ?? null,
          })
          .returning({ id: measurementEntries.id });

        if (!row) throw new Error("The measurement could not be recorded.");
        return { id: row.id, quantityScaled: quantityScaled!.toString() };
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: "create",
      resourceType: "measurement_entry",
      resourceId: result.id,
      metadata: {
        boqItemId: data.boqItemId,
        quantityScaled: result.quantityScaled,
        isDeduction: data.isDeduction ?? false,
      },
    });

    revalidatePath("/boq");
    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "recordMeasurement");
  }
}

/* ------------------------------------------------------------------ */
/* 6 · CHECK IT — AND NEVER YOUR OWN                                   */
/* ------------------------------------------------------------------ */

const checkMeasurementSchema = z.object({
  measurementEntryId: z.string().uuid(),
  accept: z.boolean(),
  rejectionReason: z.string().trim().max(2000).nullable().optional(),
});

/**
 * Accept or reject somebody else's measurement.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE SELF-CHECK REFUSAL IS THE MOST IMPORTANT LINE IN THIS FILE
 * ══════════════════════════════════════════════════════════════════════
 * A checked measurement flows into an RA bill and out as money. If the
 * person who measured can also check, the control is not weakened — it is
 * absent, and it is absent invisibly, because a self-checked row is
 * identical in every column to a properly checked one.
 *
 * The permission split (`record` vs `check`) is the first layer. This is
 * the second, and it exists because a small firm can legitimately grant
 * one person both keys — and the moment they do, the first layer stops
 * being a control at all.
 */
export async function checkMeasurement(
  input: unknown,
): Promise<ActionResult<{ id: string; status: string }>> {
  try {
    const data = checkMeasurementSchema.parse(input);

    if (!data.accept && !data.rejectionReason) {
      return salesFail("Say why it is being rejected.", {
        rejectionReason: [
          "A rejected measurement sends somebody back to site. They need to know what to remeasure.",
        ],
      });
    }

    const ctx = await guardSalesWrite({
      operation: "measurement:check",
      feature: BOQ_FEATURE,
      permission: "construction.measurement.check",
      resource: { type: "measurement_entry", id: data.measurementEntryId },
    });

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [entry] = await tx
          .select({
            id: measurementEntries.id,
            status: measurementEntries.status,
            measuredBy: measurementEntries.measuredBy,
            raBillId: measurementEntries.raBillId,
          })
          .from(measurementEntries)
          .where(
            and(
              eq(measurementEntries.tenantId, ctx.tenant.id),
              eq(measurementEntries.id, data.measurementEntryId),
            ),
          )
          .limit(1);

        if (!entry) throw new Error("That measurement does not exist.");

        /* ⚠️ THE SELF-CHECK REFUSAL. See the header. */
        if (entry.measuredBy === ctx.user.id) {
          throw new Error(
            "You recorded this measurement, so you cannot be the one who checks it. Checking exists so that two people have looked at the same work before it is billed — and a measurement checked by the person who took it is the same as one nobody checked, except that it does not look like one.",
          );
        }

        if (entry.status === "billed" || entry.raBillId) {
          throw new Error(
            "This measurement is already on a bill and can no longer be changed.",
          );
        }
        if (entry.status !== "recorded") {
          throw new Error(`This measurement has already been ${entry.status}.`);
        }

        const status = data.accept ? ("checked" as const) : ("rejected" as const);

        await tx
          .update(measurementEntries)
          .set({
            status,
            checkedBy: ctx.user.id,
            checkedAt: new Date(),
            rejectionReason: data.accept ? null : (data.rejectionReason ?? null),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(measurementEntries.tenantId, ctx.tenant.id),
              eq(measurementEntries.id, data.measurementEntryId),
            ),
          );

        return { id: entry.id, status };
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: "update",
      resourceType: "measurement_entry",
      resourceId: result.id,
      metadata: { status: result.status },
      severity: data.accept ? "info" : "warning",
      reason: data.accept ? "Measurement checked." : (data.rejectionReason ?? undefined),
    });

    revalidatePath("/boq");
    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "checkMeasurement");
  }
}

/* ------------------------------------------------------------------ */
/* 7 · READS                                                           */
/* ------------------------------------------------------------------ */

export type BoqSummary = {
  id: string;
  code: string;
  title: string;
  workPackage: string;
  status: string;
  projectId: string;
  contractId: string | null;
  originalSumMinor: string;
  revisedSumMinor: string;
  itemCount: number;
};

export async function listBoqs(): Promise<ActionResult<BoqSummary[]>> {
  try {
    const ctx = await requirePermission("construction.boq.read");

    const rows = await withTenant(ctx.tenant.id, async (tx) =>
      tx
        .select({
          id: boqs.id,
          code: boqs.code,
          title: boqs.title,
          workPackage: boqs.workPackage,
          status: boqs.status,
          projectId: boqs.projectId,
          contractId: boqs.contractId,
          originalSumMinor: boqs.originalSumMinor,
          revisedSumMinor: boqs.revisedSumMinor,
          itemCount: sql<number>`(
            SELECT count(*)::int FROM ${boqItems}
             WHERE ${boqItems.boqId} = ${boqs.id}
               AND ${boqItems.tenantId} = ${boqs.tenantId}
               AND ${boqItems.isHeading} = false
          )`,
        })
        .from(boqs)
        .where(eq(boqs.tenantId, ctx.tenant.id))
        .orderBy(desc(boqs.createdAt))
        .limit(200),
    );

    return {
      ok: true,
      data: rows.map((row) => ({
        id: row.id,
        code: row.code,
        title: row.title,
        workPackage: row.workPackage,
        status: row.status,
        projectId: row.projectId,
        contractId: row.contractId,
        // ⚠️ Money crosses to the client as a STRING. `JSON.stringify`
        // throws on a bigint, at runtime, only on pages that render money.
        originalSumMinor: (row.originalSumMinor ?? 0n).toString(),
        revisedSumMinor: (row.revisedSumMinor ?? 0n).toString(),
        itemCount: Number(row.itemCount ?? 0),
      })),
    };
  } catch (err) {
    return toSalesActionError(err, "listBoqs");
  }
}

/* ------------------------------------------------------------------ */
/* 8 · ONE BOQ, IN FULL                                                */
/* ------------------------------------------------------------------ */

export type BoqItemRow = {
  id: string;
  itemCode: string;
  sequence: number;
  description: string;
  uom: string;
  category: string;
  isHeading: boolean;
  /** ⚠️ MICRO-UNITS. Divide by 1e6 exactly once, at the point of display. */
  quantityScaled: string;
  variedQuantityScaled: string | null;
  rateMinor: string;
  variedRateMinor: string | null;
  amountMinor: string;
};

export type MeasurementRow = {
  id: string;
  sequence: number;
  boqItemId: string;
  itemCode: string | null;
  locationRef: string;
  levelRef: string | null;
  /** ⚠️ MICRO-UNITS. */
  quantityScaled: string;
  isDeduction: boolean;
  measuredOn: string;
  measuredBy: string;
  measuredByName: string | null;
  status: string;
  checkedByName: string | null;
  raBillId: string | null;
};

export type BoqDetail = {
  id: string;
  code: string;
  title: string;
  workPackage: string;
  status: string;
  projectId: string;
  projectName: string | null;
  contractId: string | null;
  contractNo: string | null;
  contractorName: string | null;
  originalSumMinor: string;
  revisedSumMinor: string;
  retentionRateBps: number;
  items: BoqItemRow[];
  books: Array<{ id: string; bookNumber: string; openedOn: string; isClosed: boolean }>;
  measurements: MeasurementRow[];
};

export async function getBoqDetail(boqId: string): Promise<ActionResult<BoqDetail>> {
  try {
    const ctx = await requirePermission("construction.boq.read");

    const data = await withTenant(ctx.tenant.id, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT b.id, b.code, b.title, b.work_package, b.status::text AS status,
               b.project_id, p.name AS project_name,
               b.contract_id, wc.contract_no,
               v.legal_name AS contractor_name,
               b.original_sum_minor, b.revised_sum_minor, b.retention_rate_bps
          FROM boqs b
          LEFT JOIN projects p        ON p.id  = b.project_id  AND p.tenant_id  = b.tenant_id
          LEFT JOIN works_contracts wc ON wc.id = b.contract_id AND wc.tenant_id = b.tenant_id
          LEFT JOIN vendors v         ON v.id  = b.contractor_vendor_id AND v.tenant_id = b.tenant_id
         WHERE b.tenant_id = ${ctx.tenant.id} AND b.id = ${boqId}
         LIMIT 1
      `);

      const head = rowsOf(rows)[0];
      if (!head) throw new Error("That BOQ does not exist.");

      const itemRows = rowsOf(
        await tx.execute(sql`
          SELECT id, item_code, sequence, description, uom::text AS uom,
                 category::text AS category, is_heading,
                 quantity_scaled, varied_quantity_scaled,
                 rate_minor, varied_rate_minor, amount_minor
            FROM boq_items
           WHERE tenant_id = ${ctx.tenant.id} AND boq_id = ${boqId}
           ORDER BY sequence
        `),
      );

      const bookRows = rowsOf(
        await tx.execute(sql`
          SELECT id, book_number, opened_on, is_closed
            FROM measurement_books
           WHERE tenant_id = ${ctx.tenant.id} AND boq_id = ${boqId}
           ORDER BY opened_on DESC
        `),
      );

      /*
       * ⚠️ THE MEASURER AND THE CHECKER ARE BOTH NAMED, and that is the
       * point of showing them. A measurement whose two names are the
       * same is a control that did not happen — and it is invisible if
       * the screen only shows "checked ✓".
       */
      const measurementRows = rowsOf(
        await tx.execute(sql`
          SELECT me.id, me.sequence, me.boq_item_id, bi.item_code,
                 me.location_ref, me.level_ref, me.quantity_scaled,
                 me.is_deduction, me.measured_on, me.measured_by,
                 mu.first_name || ' ' || COALESCE(mu.last_name, '') AS measured_by_name,
                 me.status::text AS status,
                 cu.first_name || ' ' || COALESCE(cu.last_name, '') AS checked_by_name,
                 me.ra_bill_id
            FROM measurement_entries me
            JOIN measurement_books mb ON mb.id = me.measurement_book_id AND mb.tenant_id = me.tenant_id
            LEFT JOIN boq_items bi    ON bi.id = me.boq_item_id AND bi.tenant_id = me.tenant_id
            LEFT JOIN users mu        ON mu.id = me.measured_by  AND mu.tenant_id = me.tenant_id
            LEFT JOIN users cu        ON cu.id = me.checked_by   AND cu.tenant_id = me.tenant_id
           WHERE me.tenant_id = ${ctx.tenant.id} AND mb.boq_id = ${boqId}
           ORDER BY me.measured_on DESC, me.sequence DESC
           LIMIT 200
        `),
      );

      return { head, itemRows, bookRows, measurementRows };
    });

    const h = data.head;

    return {
      ok: true,
      data: {
        id: String(h.id),
        code: String(h.code),
        title: String(h.title),
        workPackage: String(h.work_package),
        status: String(h.status),
        projectId: String(h.project_id),
        projectName: h.project_name ? String(h.project_name) : null,
        contractId: h.contract_id ? String(h.contract_id) : null,
        contractNo: h.contract_no ? String(h.contract_no) : null,
        contractorName: h.contractor_name ? String(h.contractor_name) : null,
        originalSumMinor: String(h.original_sum_minor ?? "0"),
        revisedSumMinor: String(h.revised_sum_minor ?? "0"),
        retentionRateBps: Number(h.retention_rate_bps ?? 0),
        items: data.itemRows.map((r) => ({
          id: String(r.id),
          itemCode: String(r.item_code),
          sequence: Number(r.sequence),
          description: String(r.description),
          uom: String(r.uom),
          category: String(r.category),
          isHeading: Boolean(r.is_heading),
          quantityScaled: String(r.quantity_scaled ?? "0"),
          variedQuantityScaled: r.varied_quantity_scaled == null ? null : String(r.varied_quantity_scaled),
          rateMinor: String(r.rate_minor ?? "0"),
          variedRateMinor: r.varied_rate_minor == null ? null : String(r.varied_rate_minor),
          amountMinor: String(r.amount_minor ?? "0"),
        })),
        books: data.bookRows.map((r) => ({
          id: String(r.id),
          bookNumber: String(r.book_number),
          openedOn: String(r.opened_on).slice(0, 10),
          isClosed: Boolean(r.is_closed),
        })),
        measurements: data.measurementRows.map((r) => ({
          id: String(r.id),
          sequence: Number(r.sequence),
          boqItemId: String(r.boq_item_id),
          itemCode: r.item_code ? String(r.item_code) : null,
          locationRef: String(r.location_ref),
          levelRef: r.level_ref ? String(r.level_ref) : null,
          quantityScaled: String(r.quantity_scaled ?? "0"),
          isDeduction: Boolean(r.is_deduction),
          measuredOn: String(r.measured_on).slice(0, 10),
          measuredBy: String(r.measured_by),
          measuredByName: r.measured_by_name ? String(r.measured_by_name).trim() : null,
          status: String(r.status),
          checkedByName: r.checked_by_name ? String(r.checked_by_name).trim() : null,
          raBillId: r.ra_bill_id ? String(r.ra_bill_id) : null,
        })),
      },
    };
  } catch (err) {
    return toSalesActionError(err, "getBoqDetail");
  }
}

/* ------------------------------------------------------------------ */
/* 9 · WHAT THE FORMS NEED TO OFFER                                    */
/* ------------------------------------------------------------------ */

export type BoqFormOptions = {
  projects: Array<{ id: string; code: string; name: string }>;
  contracts: Array<{ id: string; contractNo: string; title: string; projectId: string | null }>;
  vendors: Array<{ id: string; name: string }>;
};

/**
 * The dropdown contents for the BOQ form.
 *
 * ⚠️ ONE CALL, NOT THREE FROM THE CLIENT. Three round trips from a form
 * that has just opened is three chances for one of them to be the slow
 * one, and the form renders with empty selects until the last resolves —
 * which reads as "there are no projects" rather than "still loading".
 */
export async function getBoqFormOptions(): Promise<ActionResult<BoqFormOptions>> {
  try {
    const ctx = await requirePermission("construction.boq.read");

    const data = await withTenant(ctx.tenant.id, async (tx) => {
      const projects = rowsOf(
        await tx.execute(sql`
          SELECT id, code, name FROM projects
           WHERE tenant_id = ${ctx.tenant.id} AND deleted_at IS NULL
           ORDER BY name LIMIT 200
        `),
      );
      const contracts = rowsOf(
        await tx.execute(sql`
          SELECT id, contract_no, title, project_id FROM works_contracts
           WHERE tenant_id = ${ctx.tenant.id} AND status IN ('draft', 'active')
           ORDER BY contract_no LIMIT 200
        `),
      );
      const vendors = rowsOf(
        await tx.execute(sql`
          SELECT id, legal_name FROM vendors
           WHERE tenant_id = ${ctx.tenant.id}
           ORDER BY legal_name LIMIT 300
        `),
      );
      return { projects, contracts, vendors };
    });

    return {
      ok: true,
      data: {
        projects: data.projects.map((r) => ({
          id: String(r.id),
          code: String(r.code),
          name: String(r.name),
        })),
        contracts: data.contracts.map((r) => ({
          id: String(r.id),
          contractNo: String(r.contract_no),
          title: String(r.title),
          projectId: r.project_id ? String(r.project_id) : null,
        })),
        vendors: data.vendors.map((r) => ({
          id: String(r.id),
          name: String(r.legal_name),
        })),
      },
    };
  } catch (err) {
    return toSalesActionError(err, "getBoqFormOptions");
  }
}
