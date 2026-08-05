"use server";

/**
 * Ordence — ⭐ VARIATION ORDERS (Batch 2.1)
 * Version: v0.73.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS FILE EXISTS AT ALL
 * ══════════════════════════════════════════════════════════════════════
 * `lib/construction/variations.ts` — 14 KB of priced, transition-guarded,
 * separation-of-duties logic — was written, tested, and then imported by
 * NOTHING. `boq_variations` and `boq_variation_items` were created in
 * `SQL-FILES/0039_tables_paste_only.sql`. Both halves shipped. The seam
 * between them never did.
 *
 * That is a worse failure than an unbuilt feature, because every audit of
 * the codebase counted the logic as delivered. A module that is imported
 * by nothing is not a module; it is a comment with a type signature.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHERE THE GUARANTEES LIVE
 * ══════════════════════════════════════════════════════════════════════
 * NOT here. This file is one write path of several — a back-fill of a
 * contract's variation history and a support fix at a psql prompt are the
 * others, and a rule enforced only in an action is a rule those bypass.
 *
 *   • The PRICING — including the rate-change trap that values a rate
 *     change at the *difference* rather than the full new rate — is
 *     `lib/construction/variations.ts`.
 *   • The STATE MACHINE and the refusal to let a raiser approve their own
 *     variation are also there, in `applyVariationTransition`.
 *   • The SIGN of `effect_minor` against `kind`, the completeness of an
 *     approval, and the requirement that a rejection carries a reason are
 *     CHECK constraints in the database (`boq_variations_sign_matches_kind`,
 *     `boq_variations_approval_complete`, `boq_variations_rejection_explained`).
 *
 * This file's only jobs are: parse input, call the pure layer, persist,
 * audit, and translate a refusal into a sentence a site engineer can act
 * on.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ AN APPROVED VARIATION IS FINAL. THERE IS NO UN-APPROVE.
 * ══════════════════════════════════════════════════════════════════════
 * Approval moves the measurement ceiling. Quantities may already have
 * been measured and certified against the new ceiling, and money paid.
 * Reversing the approval would leave certified work above a ceiling that
 * no longer permits it. The correction path is a FURTHER variation
 * reversing the first; both stay in the register, which is what a
 * register is for.
 */

import { z } from "zod";
import { and, eq, sql, desc, asc, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withTenant } from "@/db";
import { boqs, boqItems, boqVariations, boqVariationItems } from "@/db/schema";
import { writeAudit } from "@/server/audit";
import { guardSalesWrite, toSalesActionError, salesFail } from "@/server/sales/guards";
import { requireTenantContext } from "@/server/tenant-context";
import type { ActionResult } from "@/lib/validators/crm";
import {
  priceVariation,
  applyVariationTransition,
  VariationError,
  type VariationKindLike,
  type VariationStatusLike,
  type VariationLineInput,
} from "@/lib/construction/variations";

const BOQ_FEATURE = "construction.boq" as const;

/* ------------------------------------------------------------------ */
/* NUMERIC CONVERSION                                                  */
/* ------------------------------------------------------------------ */
/**
 * ⚠️ EVERY FIGURE ARRIVES AS A STRING AND STAYS INTEGER.
 *
 * A quantity typed as `12.345` becomes 12_345_000 micro-units. A rate
 * typed as `1450.50` becomes 145_050 paise. Nothing is ever a float:
 * 0.1 + 0.2 is not 0.3, and on a contract sum that difference is a
 * dispute rather than a rounding note.
 */

const MICRO = 1_000_000n;

function toMicro(value: string): bigint | null {
  const match = /^(-?)(\d+)(?:\.(\d{1,6}))?$/.exec(value.trim());
  if (!match) return null;
  const [, sign, whole, fraction = ""] = match;
  const padded = (fraction + "000000").slice(0, 6);
  const magnitude = BigInt(whole!) * MICRO + BigInt(padded);
  return sign === "-" ? -magnitude : magnitude;
}

function toPaise(value: string): bigint | null {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const [, sign, whole, fraction = ""] = match;
  const padded = (fraction + "00").slice(0, 2);
  const magnitude = BigInt(whole!) * 100n + BigInt(padded);
  return sign === "-" ? -magnitude : magnitude;
}

/**
 * ⚠️ MONEY AND QUANTITIES CROSS TO THE CLIENT AS STRINGS.
 *
 * `JSON.stringify` throws on a bigint. A server component returning a
 * raw bigint does not render a wrong number — it fails the whole
 * payload, and the page shows a client-side exception with no clue why.
 */
function paiseToString(value: bigint): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const rupees = magnitude / 100n;
  const paise = magnitude % 100n;
  return `${negative ? "-" : ""}${rupees}.${paise.toString().padStart(2, "0")}`;
}

function microToString(value: bigint, decimals = 3): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const whole = magnitude / MICRO;
  const fraction = (magnitude % MICRO).toString().padStart(6, "0").slice(0, decimals);
  return decimals > 0
    ? `${negative ? "-" : ""}${whole}.${fraction}`
    : `${negative ? "-" : ""}${whole}`;
}

/* ------------------------------------------------------------------ */
/* SHARED VALIDATION                                                   */
/* ------------------------------------------------------------------ */

const decimalString = z
  .string()
  .trim()
  .min(1, "Required.")
  .max(24, "That number is too long.");

const UOM_VALUES = [
  "cum", "sqm", "sqft", "rmt", "kg", "mt", "quintal",
  "nos", "bag", "brass", "ltr", "day", "month", "ls",
] as const;

const KIND_VALUES = [
  "addition", "omission", "rate_change", "substitution", "extra_item",
] as const;

/**
 * Turn a `VariationError` into an operator-facing refusal.
 *
 * ⚠️ These messages are the product. `applyVariationTransition` explains
 * *why* a raiser may not approve their own variation, in the words a
 * quantity surveyor would use. Collapsing that into "permission denied"
 * throws away the only part of the refusal that teaches anything.
 */
function toVariationActionError(err: unknown, scope: string): ActionResult<never> {
  if (err instanceof VariationError) return salesFail(err.message);
  return toSalesActionError(err, scope);
}

/* ------------------------------------------------------------------ */
/* 1 · RAISE A VARIATION                                               */
/* ------------------------------------------------------------------ */

const createVariationSchema = z.object({
  boqId: z.string().uuid("Choose a bill of quantities."),
  kind: z.enum(KIND_VALUES),
  title: z.string().trim().min(1, "Give the variation a title.").max(255),
  reason: z
    .string()
    .trim()
    .min(1, "Say why this variation is needed. The contractor will ask.")
    .max(4000),
  instructionRef: z.string().trim().max(120).nullable().optional(),
  instructedOn: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the date picker.")
    .nullable()
    .optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
});

export async function createVariation(
  input: unknown,
): Promise<ActionResult<{ id: string; variationNumber: string }>> {
  try {
    const data = createVariationSchema.parse(input);

    const ctx = await guardSalesWrite({
      operation: "variations:create",
      feature: BOQ_FEATURE,
      permission: "construction.boq.manage",
    });

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [boq] = await tx
          .select({ id: boqs.id, code: boqs.code, status: boqs.status })
          .from(boqs)
          .where(and(eq(boqs.tenantId, ctx.tenant.id), eq(boqs.id, data.boqId)))
          .limit(1);

        if (!boq) {
          throw new VariationError("That bill of quantities does not exist.");
        }

        /**
         * ⚠️ A DRAFT BOQ CANNOT CARRY A VARIATION.
         *
         * A variation varies something that was agreed. Varying a draft
         * means editing the draft, and a register full of variations
         * against never-issued BOQs is a register nobody trusts.
         */
        if (boq.status === "draft") {
          throw new VariationError(
            `BOQ ${boq.code} has not been issued yet. A variation varies what was ` +
              `agreed — while the BOQ is still a draft, edit the BOQ itself.`,
          );
        }

        /**
         * ⚠️ SEQUENCE IS DERIVED, NEVER PASSED IN.
         *
         * Hard-coded sequences produced gaps that `SQL 0031 §5` refuses.
         * MAX + 1, inside the same transaction, under the tenant's RLS.
         */
        const [seqRow] = await tx
          .select({ next: sql<number>`COALESCE(MAX(${boqVariations.sequence}), 0) + 1` })
          .from(boqVariations)
          .where(
            and(
              eq(boqVariations.tenantId, ctx.tenant.id),
              eq(boqVariations.boqId, data.boqId),
            ),
          );

        const sequence = Number(seqRow?.next ?? 1);
        const variationNumber = `VO-${boq.code}-${String(sequence).padStart(3, "0")}`;

        const [row] = await tx
          .insert(boqVariations)
          .values({
            tenantId: ctx.tenant.id,
            boqId: data.boqId,
            variationNumber,
            sequence,
            kind: data.kind,
            status: "draft",
            title: data.title,
            reason: data.reason,
            instructionRef: data.instructionRef ?? null,
            instructedOn: data.instructedOn ?? null,
            notes: data.notes ?? null,
            createdBy: ctx.user.id,
          })
          .returning({ id: boqVariations.id, number: boqVariations.variationNumber });

        if (!row) throw new Error("The variation could not be raised.");
        return { id: row.id, variationNumber: row.number };
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: "create",
      resourceType: "boq_variation",
      resourceId: result.id,
      metadata: { boqId: data.boqId, kind: data.kind, number: result.variationNumber },
    });

    revalidatePath("/variations");
    revalidatePath(`/boq/${data.boqId}`);
    return { ok: true, data: result };
  } catch (err) {
    return toVariationActionError(err, "createVariation");
  }
}

/* ------------------------------------------------------------------ */
/* 2 · PRICE IT — REPLACE THE LINES                                    */
/* ------------------------------------------------------------------ */

const variationLineSchema = z.object({
  boqItemId: z.string().uuid().nullable().optional(),
  description: z.string().trim().min(1, "Describe the work.").max(2000),
  uom: z.enum(UOM_VALUES),
  /** ⚠️ SIGNED. An omission of 40 cum is "-40". */
  quantityDelta: decimalString,
  rate: decimalString,
  replacesRate: z.boolean().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

const setVariationLinesSchema = z.object({
  variationId: z.string().uuid(),
  lines: z.array(variationLineSchema).min(1, "A variation needs at least one line."),
});

export async function setVariationLines(
  input: unknown,
): Promise<ActionResult<{ effectMinor: string; lineCount: number }>> {
  try {
    const data = setVariationLinesSchema.parse(input);

    const ctx = await guardSalesWrite({
      operation: "variations:price",
      feature: BOQ_FEATURE,
      permission: "construction.boq.manage",
    });

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [variation] = await tx
          .select({
            id: boqVariations.id,
            boqId: boqVariations.boqId,
            kind: boqVariations.kind,
            status: boqVariations.status,
            number: boqVariations.variationNumber,
          })
          .from(boqVariations)
          .where(
            and(
              eq(boqVariations.tenantId, ctx.tenant.id),
              eq(boqVariations.id, data.variationId),
            ),
          )
          .limit(1);

        if (!variation) throw new VariationError("That variation does not exist.");

        /**
         * ⚠️ ONLY A DRAFT MAY BE PRICED.
         *
         * Re-pricing a submitted variation changes the number the
         * approver is looking at while they look at it. Re-pricing an
         * approved one moves a ceiling that work has already been
         * certified against.
         */
        if (variation.status !== "draft") {
          throw new VariationError(
            `${variation.number} is ${variation.status}. Only a draft can be priced. ` +
              (variation.status === "approved"
                ? "An approved variation is final — raise a further variation to correct it."
                : "Withdraw it back to draft first."),
          );
        }

        /* --- resolve the existing BOQ lines a rate change refers to --- */
        const referenced = data.lines
          .map((l) => l.boqItemId)
          .filter((v): v is string => typeof v === "string" && v.length > 0);

        const existing = referenced.length
          ? await tx
              .select({
                id: boqItems.id,
                boqId: boqItems.boqId,
                quantityScaled: boqItems.quantityScaled,
                rateMinor: boqItems.rateMinor,
                description: boqItems.description,
              })
              .from(boqItems)
              .where(
                and(
                  eq(boqItems.tenantId, ctx.tenant.id),
                  eq(boqItems.boqId, variation.boqId),
                  inArray(boqItems.id, referenced),
                ),
              )
          : [];

        const byId = new Map(existing.map((r) => [r.id, r]));

        /* --- convert strings to integers, then price --- */
        const pureLines: VariationLineInput[] = data.lines.map((line, index) => {
          const sequence = index + 1;

          const quantityDeltaScaled = toMicro(line.quantityDelta);
          if (quantityDeltaScaled === null) {
            throw new VariationError(
              `Line ${sequence}: "${line.quantityDelta}" is not a quantity. ` +
                `Use digits, an optional minus sign, and up to six decimals.`,
            );
          }

          const rateMinor = toPaise(line.rate);
          if (rateMinor === null) {
            throw new VariationError(
              `Line ${sequence}: "${line.rate}" is not a rate. Use digits and up to two decimals.`,
            );
          }
          if (rateMinor < 0n) {
            throw new VariationError(
              `Line ${sequence}: a rate cannot be negative. To reduce the contract sum, ` +
                `enter a negative QUANTITY on an omission — the sign belongs on the ` +
                `quantity, not the rate.`,
            );
          }

          const replacesRate = line.replacesRate === true;
          const boqItemId = line.boqItemId ?? null;

          if (replacesRate) {
            if (!boqItemId) {
              throw new VariationError(
                `Line ${sequence} changes a rate but names no BOQ item.`,
              );
            }
            const source = byId.get(boqItemId);
            if (!source) {
              throw new VariationError(
                `Line ${sequence} refers to a BOQ item that is not in ${variation.number}'s ` +
                  `bill. A variation can only vary its own BOQ.`,
              );
            }
            return {
              sequence,
              boqItemId,
              description: line.description,
              uom: line.uom,
              quantityDeltaScaled,
              rateMinor,
              replacesRate: true,
              existingQuantityScaled: source.quantityScaled,
              existingRateMinor: source.rateMinor,
            };
          }

          if (boqItemId && !byId.has(boqItemId)) {
            throw new VariationError(
              `Line ${sequence} refers to a BOQ item that is not in ${variation.number}'s bill.`,
            );
          }

          return {
            sequence,
            boqItemId,
            description: line.description,
            uom: line.uom,
            quantityDeltaScaled,
            rateMinor,
            replacesRate: false,
          };
        });

        /** ⭐ The whole valuation, including the rate-change trap. */
        const effect = priceVariation({
          kind: variation.kind as VariationKindLike,
          lines: pureLines,
        });

        /* --- replace, don't merge --- */
        await tx
          .delete(boqVariationItems)
          .where(
            and(
              eq(boqVariationItems.tenantId, ctx.tenant.id),
              eq(boqVariationItems.variationId, variation.id),
            ),
          );

        await tx.insert(boqVariationItems).values(
          effect.lines.map((line) => ({
            tenantId: ctx.tenant.id,
            variationId: variation.id,
            boqItemId: line.boqItemId,
            sequence: line.sequence,
            description: line.description,
            uom: line.uom as (typeof UOM_VALUES)[number],
            quantityDeltaScaled: line.quantityDeltaScaled,
            rateMinor: line.rateMinor,
            replacesRate: line.replacesRate,
            amountDeltaMinor: line.amountDeltaMinor,
            notes: data.lines[line.sequence - 1]?.notes ?? null,
          })),
        );

        await tx
          .update(boqVariations)
          .set({ effectMinor: effect.effectMinor, updatedAt: new Date() })
          .where(
            and(
              eq(boqVariations.tenantId, ctx.tenant.id),
              eq(boqVariations.id, variation.id),
            ),
          );

        /**
         * ⚠️ READ THE EFFECT BACK OUT OF THE DATABASE.
         *
         * The CHECK constraint `boq_variations_sign_matches_kind` may
         * reject what we just computed — an "omission" whose lines sum
         * positive, for instance. Returning the in-memory figure would
         * report a number the database refused to store.
         */
        const [stored] = await tx
          .select({ effectMinor: boqVariations.effectMinor })
          .from(boqVariations)
          .where(
            and(
              eq(boqVariations.tenantId, ctx.tenant.id),
              eq(boqVariations.id, variation.id),
            ),
          )
          .limit(1);

        return {
          boqId: variation.boqId,
          effectMinor: stored?.effectMinor ?? effect.effectMinor,
          lineCount: effect.lines.length,
        };
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: "update",
      resourceType: "boq_variation",
      resourceId: data.variationId,
      metadata: {
        lineCount: result.lineCount,
        effectMinor: result.effectMinor.toString(),
      },
    });

    revalidatePath("/variations");
    revalidatePath(`/variations/${data.variationId}`);
    revalidatePath(`/boq/${result.boqId}`);

    return {
      ok: true,
      data: {
        effectMinor: paiseToString(result.effectMinor),
        lineCount: result.lineCount,
      },
    };
  } catch (err) {
    return toVariationActionError(err, "setVariationLines");
  }
}

/* ------------------------------------------------------------------ */
/* 3 · THE STATE MACHINE                                               */
/* ------------------------------------------------------------------ */

const transitionSchema = z.object({
  variationId: z.string().uuid(),
  reason: z.string().trim().max(2000).nullable().optional(),
});

/**
 * One implementation for all four transitions.
 *
 * ⚠️ THE SEGREGATION IS NOT OPTIONAL AND IS NOT HERE. It is in
 * `applyVariationTransition`, which refuses when the actor raised the
 * variation. Putting the check in each caller is how one caller ends up
 * without it.
 */
async function transitionVariation(
  input: unknown,
  to: VariationStatusLike,
  operation: string,
  permission: string,
): Promise<ActionResult<{ id: string; status: VariationStatusLike }>> {
  const data = transitionSchema.parse(input);

  const ctx = await guardSalesWrite({
    operation,
    feature: BOQ_FEATURE,
    permission,
  });

  const result = await withTenant(
    ctx.tenant.id,
    async (tx) => {
      const [variation] = await tx
        .select({
          id: boqVariations.id,
          boqId: boqVariations.boqId,
          number: boqVariations.variationNumber,
          status: boqVariations.status,
          createdBy: boqVariations.createdBy,
          effectMinor: boqVariations.effectMinor,
        })
        .from(boqVariations)
        .where(
          and(
            eq(boqVariations.tenantId, ctx.tenant.id),
            eq(boqVariations.id, data.variationId),
          ),
        )
        .limit(1);

      if (!variation) throw new VariationError("That variation does not exist.");

      /** ⭐ Throws on an illegal transition and on self-approval. */
      applyVariationTransition({
        from: variation.status as VariationStatusLike,
        to,
        actorId: ctx.user.id,
        createdBy: variation.createdBy,
        reason: data.reason ?? null,
      });

      /**
       * ⚠️ A VARIATION WITH NO LINES CANNOT BE SUBMITTED OR APPROVED.
       *
       * An empty variation has an effect of zero and reads as approved
       * scope. It moves no ceiling and authorises nothing, but it sits
       * in the register looking exactly like one that does.
       */
      if (to === "submitted" || to === "approved") {
        const [count] = await tx
          .select({ n: sql<number>`count(*)` })
          .from(boqVariationItems)
          .where(
            and(
              eq(boqVariationItems.tenantId, ctx.tenant.id),
              eq(boqVariationItems.variationId, variation.id),
            ),
          );
        if (Number(count?.n ?? 0) === 0) {
          throw new VariationError(
            `${variation.number} has no priced lines. Add the work before ${
              to === "approved" ? "approving" : "submitting"
            } it — an empty variation authorises nothing but reads as though it does.`,
          );
        }
      }

      const now = new Date();
      await tx
        .update(boqVariations)
        .set({
          status: to,
          updatedAt: now,
          ...(to === "submitted"
            ? { submittedAt: now, submittedBy: ctx.user.id }
            : {}),
          ...(to === "approved" ? { approvedAt: now, approvedBy: ctx.user.id } : {}),
          ...(to === "rejected"
            ? { rejectedAt: now, rejectionReason: data.reason ?? null }
            : {}),
        })
        .where(
          and(
            eq(boqVariations.tenantId, ctx.tenant.id),
            eq(boqVariations.id, variation.id),
          ),
        );

      return {
        id: variation.id,
        boqId: variation.boqId,
        number: variation.number,
        effectMinor: variation.effectMinor,
      };
    },
    { impersonationId: ctx.impersonationId },
  );

  await writeAudit(ctx, {
    action: "update",
    resourceType: "boq_variation",
    resourceId: result.id,
    metadata: {
      transitionTo: to,
      number: result.number,
      effectMinor: result.effectMinor.toString(),
      ...(data.reason ? { reason: data.reason } : {}),
    },
  });

  revalidatePath("/variations");
  revalidatePath(`/variations/${result.id}`);
  revalidatePath(`/boq/${result.boqId}`);

  return { ok: true, data: { id: result.id, status: to } };
}

export async function submitVariation(input: unknown) {
  try {
    return await transitionVariation(
      input,
      "submitted",
      "variations:submit",
      "construction.boq.manage",
    );
  } catch (err) {
    return toVariationActionError(err, "submitVariation");
  }
}

/**
 * ⚠️ APPROVAL IS THE MONEY DECISION AND IS FINAL.
 *
 * It carries its own permission — `construction.variation.approve` — so
 * that "can raise a variation" and "can approve one" are separately
 * grantable. Sharing one permission makes the segregation of duties a
 * matter of who happens to hold the role rather than a control.
 */
export async function approveVariation(input: unknown) {
  try {
    return await transitionVariation(
      input,
      "approved",
      "variations:approve",
      "construction.variation.approve",
    );
  } catch (err) {
    return toVariationActionError(err, "approveVariation");
  }
}

export async function rejectVariation(input: unknown) {
  try {
    return await transitionVariation(
      input,
      "rejected",
      "variations:reject",
      "construction.variation.approve",
    );
  } catch (err) {
    return toVariationActionError(err, "rejectVariation");
  }
}

export async function withdrawVariation(input: unknown) {
  try {
    return await transitionVariation(
      input,
      "withdrawn",
      "variations:withdraw",
      "construction.boq.manage",
    );
  } catch (err) {
    return toVariationActionError(err, "withdrawVariation");
  }
}

/* ------------------------------------------------------------------ */
/* 4 · READS                                                           */
/* ------------------------------------------------------------------ */

export type VariationSummary = {
  id: string;
  variationNumber: string;
  boqId: string;
  boqCode: string;
  boqTitle: string;
  kind: string;
  status: string;
  title: string;
  /** Money as a STRING. Signed. */
  effect: string;
  instructionRef: string | null;
  instructedOn: string | null;
  createdAt: string;
};

export async function listVariations(): Promise<ActionResult<VariationSummary[]>> {
  try {
    const ctx = await requireTenantContext();

    const rows = await withTenant(ctx.tenant.id, async (tx) =>
      tx
        .select({
          id: boqVariations.id,
          variationNumber: boqVariations.variationNumber,
          boqId: boqVariations.boqId,
          boqCode: boqs.code,
          boqTitle: boqs.title,
          kind: boqVariations.kind,
          status: boqVariations.status,
          title: boqVariations.title,
          effectMinor: boqVariations.effectMinor,
          instructionRef: boqVariations.instructionRef,
          instructedOn: boqVariations.instructedOn,
          createdAt: boqVariations.createdAt,
        })
        .from(boqVariations)
        .innerJoin(
          boqs,
          and(eq(boqs.id, boqVariations.boqId), eq(boqs.tenantId, boqVariations.tenantId)),
        )
        .where(eq(boqVariations.tenantId, ctx.tenant.id))
        .orderBy(desc(boqVariations.createdAt)),
    );

    return {
      ok: true,
      data: rows.map((r) => ({
        id: r.id,
        variationNumber: r.variationNumber,
        boqId: r.boqId,
        boqCode: r.boqCode,
        boqTitle: r.boqTitle,
        kind: r.kind,
        status: r.status,
        title: r.title,
        effect: paiseToString(r.effectMinor),
        instructionRef: r.instructionRef,
        instructedOn: r.instructedOn,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  } catch (err) {
    return toVariationActionError(err, "listVariations");
  }
}

export type VariationDetail = {
  id: string;
  variationNumber: string;
  boqId: string;
  boqCode: string;
  boqTitle: string;
  boqStatus: string;
  kind: string;
  status: string;
  title: string;
  reason: string;
  instructionRef: string | null;
  instructedOn: string | null;
  notes: string | null;
  effect: string;
  additions: string;
  omissions: string;
  createdAt: string;
  createdBy: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  /** ⭐ TRUE when the signed-in user raised this. Drives the UI refusal. */
  viewerRaisedIt: boolean;
  lines: {
    id: string;
    sequence: number;
    boqItemId: string | null;
    boqItemCode: string | null;
    description: string;
    uom: string;
    quantityDelta: string;
    rate: string;
    replacesRate: boolean;
    amountDelta: string;
    notes: string | null;
  }[];
};

export async function getVariationDetail(
  variationId: string,
): Promise<ActionResult<VariationDetail>> {
  try {
    const ctx = await requireTenantContext();

    const data = await withTenant(ctx.tenant.id, async (tx) => {
      const [head] = await tx
        .select({
          id: boqVariations.id,
          variationNumber: boqVariations.variationNumber,
          boqId: boqVariations.boqId,
          boqCode: boqs.code,
          boqTitle: boqs.title,
          boqStatus: boqs.status,
          kind: boqVariations.kind,
          status: boqVariations.status,
          title: boqVariations.title,
          reason: boqVariations.reason,
          instructionRef: boqVariations.instructionRef,
          instructedOn: boqVariations.instructedOn,
          notes: boqVariations.notes,
          effectMinor: boqVariations.effectMinor,
          createdAt: boqVariations.createdAt,
          createdBy: boqVariations.createdBy,
          submittedAt: boqVariations.submittedAt,
          approvedAt: boqVariations.approvedAt,
          rejectedAt: boqVariations.rejectedAt,
          rejectionReason: boqVariations.rejectionReason,
        })
        .from(boqVariations)
        .innerJoin(
          boqs,
          and(eq(boqs.id, boqVariations.boqId), eq(boqs.tenantId, boqVariations.tenantId)),
        )
        .where(
          and(
            eq(boqVariations.tenantId, ctx.tenant.id),
            eq(boqVariations.id, variationId),
          ),
        )
        .limit(1);

      if (!head) return null;

      const lines = await tx
        .select({
          id: boqVariationItems.id,
          sequence: boqVariationItems.sequence,
          boqItemId: boqVariationItems.boqItemId,
          boqItemCode: boqItems.itemCode,
          description: boqVariationItems.description,
          uom: boqVariationItems.uom,
          quantityDeltaScaled: boqVariationItems.quantityDeltaScaled,
          rateMinor: boqVariationItems.rateMinor,
          replacesRate: boqVariationItems.replacesRate,
          amountDeltaMinor: boqVariationItems.amountDeltaMinor,
          notes: boqVariationItems.notes,
        })
        .from(boqVariationItems)
        .leftJoin(
          boqItems,
          and(
            eq(boqItems.id, boqVariationItems.boqItemId),
            eq(boqItems.tenantId, boqVariationItems.tenantId),
          ),
        )
        .where(
          and(
            eq(boqVariationItems.tenantId, ctx.tenant.id),
            eq(boqVariationItems.variationId, variationId),
          ),
        )
        .orderBy(asc(boqVariationItems.sequence));

      return { head, lines };
    });

    if (!data) return salesFail("That variation does not exist.");

    /**
     * Additions and omissions are shown separately because a net figure
     * of zero can mean "nothing changed" or "₹40 lakh added and ₹40 lakh
     * removed". Those are very different conversations.
     */
    let additions = 0n;
    let omissions = 0n;
    for (const line of data.lines) {
      if (line.amountDeltaMinor >= 0n) additions += line.amountDeltaMinor;
      else omissions += line.amountDeltaMinor;
    }

    return {
      ok: true,
      data: {
        id: data.head.id,
        variationNumber: data.head.variationNumber,
        boqId: data.head.boqId,
        boqCode: data.head.boqCode,
        boqTitle: data.head.boqTitle,
        boqStatus: data.head.boqStatus,
        kind: data.head.kind,
        status: data.head.status,
        title: data.head.title,
        reason: data.head.reason,
        instructionRef: data.head.instructionRef,
        instructedOn: data.head.instructedOn,
        notes: data.head.notes,
        effect: paiseToString(data.head.effectMinor),
        additions: paiseToString(additions),
        omissions: paiseToString(omissions),
        createdAt: data.head.createdAt.toISOString(),
        createdBy: data.head.createdBy,
        submittedAt: data.head.submittedAt?.toISOString() ?? null,
        approvedAt: data.head.approvedAt?.toISOString() ?? null,
        rejectedAt: data.head.rejectedAt?.toISOString() ?? null,
        rejectionReason: data.head.rejectionReason,
        viewerRaisedIt: data.head.createdBy === ctx.user.id,
        lines: data.lines.map((l) => ({
          id: l.id,
          sequence: l.sequence,
          boqItemId: l.boqItemId,
          boqItemCode: l.boqItemCode,
          description: l.description,
          uom: l.uom,
          quantityDelta: microToString(l.quantityDeltaScaled),
          rate: paiseToString(l.rateMinor),
          replacesRate: l.replacesRate,
          amountDelta: paiseToString(l.amountDeltaMinor),
          notes: l.notes,
        })),
      },
    };
  } catch (err) {
    return toVariationActionError(err, "getVariationDetail");
  }
}

export type VariationFormOptions = {
  boqs: { id: string; code: string; title: string; status: string }[];
  items: { id: string; boqId: string; itemCode: string; description: string; uom: string }[];
};

export async function getVariationFormOptions(): Promise<
  ActionResult<VariationFormOptions>
> {
  try {
    const ctx = await requireTenantContext();

    const data = await withTenant(ctx.tenant.id, async (tx) => {
      /** Only issued BOQs can be varied — see `createVariation`. */
      const boqRows = await tx
        .select({
          id: boqs.id,
          code: boqs.code,
          title: boqs.title,
          status: boqs.status,
        })
        .from(boqs)
        .where(and(eq(boqs.tenantId, ctx.tenant.id), eq(boqs.status, "issued")))
        .orderBy(asc(boqs.code));

      const itemRows = await tx
        .select({
          id: boqItems.id,
          boqId: boqItems.boqId,
          itemCode: boqItems.itemCode,
          description: boqItems.description,
          uom: boqItems.uom,
        })
        .from(boqItems)
        .where(
          and(eq(boqItems.tenantId, ctx.tenant.id), eq(boqItems.isHeading, false)),
        )
        .orderBy(asc(boqItems.sequence));

      return { boqs: boqRows, items: itemRows };
    });

    return { ok: true, data };
  } catch (err) {
    return toVariationActionError(err, "getVariationFormOptions");
  }
}
