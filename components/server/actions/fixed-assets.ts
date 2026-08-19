"use server";

/**
 * Ordence — ⭐⭐⭐ THE FIXED ASSET REGISTER AND DEPRECIATION
 * Batch 100 · v1.53.0-alpha · SQL-FILES/0100
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION, NONE TAKES A TENANT ID, AND EACH
 * ONE IS A BROWSER-REACHABLE ENDPOINT whether or not a screen ever
 * renders a button for it. The guard lives on the function.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS MODULE REFUSES TO DO, AND WHY THOSE REFUSALS ARE THE
 *    FEATURE
 * ══════════════════════════════════════════════════════════════════════
 *   • It refuses a useful life that departs from Schedule II Part C
 *     without a written justification — Part C permits a different life
 *     only where it is justified by technical advice and DISCLOSED.
 *   • It refuses a residual value above 5% without one — Part A note 5.
 *   • It refuses to compute depreciation into a closed period, and
 *     refuses to recompute a run that has already been posted.
 *   • It refuses to post a disposal until depreciation has been charged
 *     up to the day the asset went, because otherwise the missing months
 *     land in "profit on sale" instead of "depreciation".
 *   • It refuses to post the income-tax computation to the ledger, ever.
 *
 * ⭐ EVERY ONE OF THOSE READS A CONFIGURED VALUE AT THE MOMENT A NUMBER
 *   IS PRODUCED. That is the point: this codebase has repeatedly shipped
 *   columns that were written, displayed, audited and read by nothing.
 *   `depreciation_method`, `useful_life_months`, `residual_bp`,
 *   `shift_usage`, `asset_class` and `rate_bp` are each read inside
 *   `lib/fixed-assets/depreciation.ts` at the point the charge is
 *   computed, and changing any of them changes the number.
 */

import { and, asc, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenant } from "@/db";
import { assets } from "@/db/schema/assets";
import {
  depreciationLines,
  depreciationRuns,
  fixedAssets,
  itAssetBlocks,
} from "@/db/schema/fixed-assets";
import { requirePermission, writeAudit } from "@/server/audit";
import { requireAccess } from "@/server/billing/access";
import { toSalesActionError } from "@/server/sales/guards";
import { postAssetDisposal, postDepreciationRun } from "@/server/accounting/post-sales";
import {
  accumulatedUpToInclusive,
  computeCompaniesActRun,
  computeIncomeTaxYear,
  deferredTaxInput,
  disposalWorking,
} from "@/server/fixed-assets/depreciation-service";
import {
  companiesActSchedule,
  DepreciationError,
  isScheduleIIClass,
  SCHEDULE_II,
  SCHEDULE_II_CLASSES,
  DEPRECIATION_METHODS,
  SHIFT_USAGES,
  IT_BLOCK_CLASSES,
  type ScheduleIIClass,
  type ShiftUsage,
} from "@/lib/fixed-assets/depreciation";
import { FIXED_ASSET_ROLE_META, mapAccountsSentence } from "@/lib/accounting/sales-posting";
import { formatIso, fyEndFor, fyStartFor } from "@/lib/accounting/periods";
import type { ActionResult } from "@/lib/validators/crm";

/**
 * ⚠️ THE CALLBACK RETURN TYPES BELOW ARE WRITTEN OUT RATHER THAN
 * INFERRED, AND THAT IS NOT STYLE.
 *
 * 🔴 WITH SEVERAL `return { error: ... }` BRANCHES AND ONE SUCCESS
 * BRANCH, TypeScript collapses the inferred union into ONE object with
 * every property optional — so the success fields are possibly undefined
 * AFTER the check that was supposed to have ruled that out.
 * `server/actions/payroll.ts` documented this first and this file has the
 * same shape three times.
 */
type Refusal = { error: string };
type Ok<T> = T & { error?: undefined };
type Outcome<T> = Refusal | Ok<T>;

const READ = "fixed_assets.read" as const;
const MANAGE = "fixed_assets.manage" as const;
const POST = "fixed_assets.post" as const;

/**
 * ⭐ THE ENGINE'S REFUSALS REACH THE USER VERBATIM.
 *
 * ⚠️ WITHOUT THIS BRANCH THEY FALL THROUGH TO "Something went wrong."
 * Every `DepreciationError` in this batch names the asset, the statutory
 * note it fell foul of and the remedy — "record the justification against
 * the asset", "put it on the straight line method". A person told
 * "something went wrong" about a useful life concludes the product is
 * broken; a person told which note of Schedule II they are on either
 * fixes it or argues with it, and both are better outcomes.
 */
function toActionError(err: unknown, scope: string): ActionResult<never> {
  if (err instanceof DepreciationError) return { ok: false, error: err.message };
  return toSalesActionError(err, scope);
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "A date is YYYY-MM-DD.");
/** ⚠️ Paise as a digit string. Money never crosses this boundary as a number. */
const minorAmount = z.string().regex(/^\d{1,18}$/, "An amount is a whole number of paise.");

/* ================================================================== */
/* ① THE REGISTER                                                      */
/* ================================================================== */

const assetSchema = z.object({
  assetNo: z.string().trim().min(1).max(40),
  description: z.string().trim().min(2).max(2000),
  assetClass: z.enum(SCHEDULE_II_CLASSES as unknown as [ScheduleIIClass, ...ScheduleIIClass[]]),
  costMinor: minorAmount,
  residualBp: z.number().int().min(0).max(10000).default(500),
  residualJustification: z.string().trim().max(2000).nullish(),
  usefulLifeMonths: z.number().int().min(1).max(1200),
  lifeJustification: z.string().trim().max(2000).nullish(),
  depreciationMethod: z.enum(DEPRECIATION_METHODS as unknown as ["slm", "wdv"]),
  shiftUsage: z
    .enum(SHIFT_USAGES as unknown as [ShiftUsage, ...ShiftUsage[]])
    .default("single"),
  acquiredOn: isoDate,
  putToUseOn: isoDate,
  itBlockId: z.string().uuid().nullish(),
  crmAssetId: z.string().uuid().nullish(),
  location: z.string().trim().max(160).nullish(),
  parentFixedAssetId: z.string().uuid().nullish(),
});

/**
 * ⭐⭐ CAPITALISE AN ASSET.
 *
 * ⚠️ THE DEFAULT USEFUL LIFE IS SCHEDULE II'S, NOT ZERO AND NOT THE
 * CALLER'S. A caller who sends no life gets the prescribed one for the
 * class, which is the answer that needs no justification. A caller who
 * sends a different one must send the justification with it — and the
 * engine, not this function, is what enforces that, so an import or a
 * fix-up script cannot walk around it.
 *
 * 🔴 COMPONENT ACCOUNTING CARVES THE COST OUT OF THE PARENT. Schedule II
 * note 4 makes a significant part with its own useful life a separate
 * depreciable item — but only if the parent's cost no longer includes it.
 * Registering a ₹4 lakh engine against a ₹30 lakh machine leaves ₹26 lakh
 * on the machine. Without the carve-out the two rows would together
 * depreciate ₹34 lakh, which the company never spent.
 */
export async function registerFixedAsset(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await requirePermission(MANAGE);
    await requireAccess("fixed_assets:manage", ctx);

    const parsed = assetSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error: "Check the form.",
        fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
      };
    }
    const d = parsed.data;

    if (d.putToUseOn < d.acquiredOn) {
      return {
        ok: false,
        error:
          "An asset cannot be put to use before it was acquired. Depreciation runs from the date of USE — " +
          "under Schedule II for the books and under s.32 for the tax computation — so the two dates are " +
          "both recorded and neither is derived from the other.",
      };
    }

    const cost = BigInt(d.costMinor);
    if (cost <= 0n) {
      return { ok: false, error: "An asset with no cost has nothing to depreciate." };
    }

    const outcome = await withTenant(
      ctx.tenant.id,
      async (tx): Promise<Outcome<{ id: string }>> => {
      /* ---- The component carve-out ---------------------------------- */
      if (d.parentFixedAssetId) {
        const [parent] = await tx
          .select()
          .from(fixedAssets)
          .where(
            and(
              eq(fixedAssets.tenantId, ctx.tenant.id),
              eq(fixedAssets.id, d.parentFixedAssetId),
            ),
          )
          .limit(1);
        if (!parent) return { error: "That parent asset does not exist." };

        const charged = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(depreciationLines)
          .innerJoin(depreciationRuns, eq(depreciationRuns.id, depreciationLines.runId))
          .where(
            and(
              eq(depreciationLines.tenantId, ctx.tenant.id),
              eq(depreciationLines.fixedAssetId, parent.id),
              eq(depreciationRuns.status, "posted"),
            ),
          );
        if ((charged[0]?.n ?? 0) > 0) {
          return {
            error:
              `${parent.assetNo} has already been depreciated, so its cost cannot be carved up now. ` +
              `Splitting a component out would change the cost the posted charges were computed on, and ` +
              `the register would stop agreeing with the ledger. Identify significant components when the ` +
              `asset is capitalised — Schedule II Part A note 4 expects that assessment up front.`,
          };
        }
        if (parent.costMinor <= cost) {
          return {
            error:
              `A component cannot cost as much as the whole asset. ${parent.assetNo} is carried at ` +
              `${parent.costMinor} paise and the component is ${cost} paise.`,
          };
        }
        await tx
          .update(fixedAssets)
          .set({ costMinor: parent.costMinor - cost, updatedAt: new Date() })
          .where(eq(fixedAssets.id, parent.id));
      }

      /* ---- The link to the CRM catalogue, and what it refuses ------- */
      if (d.crmAssetId) {
        const [crm] = await tx
          .select({
            id: assets.id,
            name: assets.name,
            linkedDealId: assets.linkedDealId,
            status: assets.status,
          })
          .from(assets)
          .where(and(eq(assets.tenantId, ctx.tenant.id), eq(assets.id, d.crmAssetId)))
          .limit(1);
        if (!crm) return { error: "That catalogue entry does not exist." };

        /**
         * 🔴 A THING BEING SOLD IS STOCK IN TRADE, NOT A FIXED ASSET, AND
         * THIS IS THE READ THAT MAKES `crm_asset_id` MEAN SOMETHING. The
         * `assets` table holds both a developer's flats and a company's
         * plant. A catalogue row attached to a deal, or already sold or
         * under offer, is inventory being turned over — capitalising it
         * would move revenue out of the P&L and depreciate something the
         * company is in the business of selling.
         */
        if (crm.linkedDealId !== null || crm.status === "sold" || crm.status === "under_offer") {
          return {
            error:
              `"${crm.name}" is attached to a deal or is under offer in the catalogue, which makes it ` +
              `stock in trade rather than a fixed asset. Depreciating something the company is in the ` +
              `business of selling would take it out of revenue and out of closing stock at the same time. ` +
              `Capitalise only assets the business USES.`,
          };
        }

        const [already] = await tx
          .select({ assetNo: fixedAssets.assetNo })
          .from(fixedAssets)
          .where(
            and(
              eq(fixedAssets.tenantId, ctx.tenant.id),
              eq(fixedAssets.crmAssetId, d.crmAssetId),
            ),
          )
          .limit(1);
        if (already) {
          return {
            error:
              `${already.assetNo} is already capitalised against that catalogue entry. Capitalising it ` +
              `twice would double the gross block and the depreciation charge on one physical asset.`,
          };
        }
      }

      const [created] = await tx
        .insert(fixedAssets)
        .values({
          tenantId: ctx.tenant.id,
          assetNo: d.assetNo,
          description: d.description,
          assetClass: d.assetClass,
          parentFixedAssetId: d.parentFixedAssetId ?? null,
          costMinor: cost,
          residualBp: d.residualBp,
          residualJustification: d.residualJustification ?? null,
          usefulLifeMonths: d.usefulLifeMonths,
          lifeJustification: d.lifeJustification ?? null,
          depreciationMethod: d.depreciationMethod,
          shiftUsage: d.shiftUsage,
          acquiredOn: d.acquiredOn,
          putToUseOn: d.putToUseOn,
          itBlockId: d.itBlockId ?? null,
          crmAssetId: d.crmAssetId ?? null,
          location: d.location ?? null,
          createdBy: ctx.user.id,
        })
        .returning({ id: fixedAssets.id });

      if (!created) return { error: "The asset could not be registered." };
      return { id: created.id };
      },
    );

    // ⚠️ `outcome.error !== undefined`, NOT `"error" in outcome`. The
    // success branch declares `error?: undefined`, so `in` does not narrow
    // the union and every success field stays possibly-undefined.
    if (outcome.error !== undefined) return { ok: false, error: outcome.error };

    await writeAudit(ctx, {
      action: "create",
      resourceType: "fixed_asset",
      resourceId: outcome.id,
      metadata: {
        assetNo: d.assetNo,
        assetClass: d.assetClass,
        costMinor: d.costMinor,
        usefulLifeMonths: d.usefulLifeMonths,
        prescribedLifeMonths: SCHEDULE_II[d.assetClass].usefulLifeMonths,
        depreciationMethod: d.depreciationMethod,
        residualBp: d.residualBp,
        shiftUsage: d.shiftUsage,
      },
    });

    revalidatePath("/fixed-assets");
    return { ok: true, data: { id: outcome.id } };
  } catch (err) {
    return toActionError(err, "fixed-assets");
  }
}

const blockSchema = z.object({
  name: z.string().trim().min(2).max(120),
  blockClass: z.enum(IT_BLOCK_CLASSES as unknown as ["building", ...string[]]),
  rateBp: z.number().int().min(0).max(10000),
  openingWdvMinor: minorAmount.default("0"),
  openingWdvAsAt: isoDate,
  notes: z.string().trim().max(2000).nullish(),
});

/**
 * ⭐ A BLOCK OF ASSETS — s.2(11).
 *
 * ⚠️ THE RATE IS TYPED IN, NOT DERIVED, AND THAT IS HONEST. Appendix I to
 * the Income-tax Rules, 1962 prescribes it, but which entry an asset
 * falls under is a judgement about the asset — a "computer" at 40% and
 * general plant at 15% look the same on a purchase invoice. Ordence
 * guessing it would put a number in a return that nobody chose.
 *
 * ⚠️ AND THE OPENING WDV IS AN OPENING BALANCE, dated. Every later year's
 * WDV is computed from it, so a wrong date silently re-bases the whole
 * block.
 */
export async function saveItBlock(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await requirePermission(MANAGE);
    await requireAccess("fixed_assets:manage", ctx);

    const parsed = blockSchema.extend({ id: z.string().uuid().optional() }).safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error: "Check the form.",
        fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
      };
    }
    const d = parsed.data;

    const id = await withTenant(ctx.tenant.id, async (tx) => {
      if (d.id) {
        await tx
          .update(itAssetBlocks)
          .set({
            name: d.name,
            blockClass: d.blockClass,
            rateBp: d.rateBp,
            openingWdvMinor: BigInt(d.openingWdvMinor),
            openingWdvAsAt: d.openingWdvAsAt,
            notes: d.notes ?? null,
          })
          .where(and(eq(itAssetBlocks.tenantId, ctx.tenant.id), eq(itAssetBlocks.id, d.id)));
        return d.id;
      }
      const [created] = await tx
        .insert(itAssetBlocks)
        .values({
          tenantId: ctx.tenant.id,
          name: d.name,
          blockClass: d.blockClass,
          rateBp: d.rateBp,
          openingWdvMinor: BigInt(d.openingWdvMinor),
          openingWdvAsAt: d.openingWdvAsAt,
          notes: d.notes ?? null,
          createdBy: ctx.user.id,
        })
        .returning({ id: itAssetBlocks.id });
      return created?.id ?? null;
    });

    if (!id) return { ok: false, error: "The block could not be saved." };

    await writeAudit(ctx, {
      action: d.id ? "update" : "create",
      resourceType: "it_asset_block",
      resourceId: id,
      metadata: { name: d.name, rateBp: d.rateBp, openingWdvAsAt: d.openingWdvAsAt },
    });

    revalidatePath("/fixed-assets");
    return { ok: true, data: { id } };
  } catch (err) {
    return toActionError(err, "fixed-assets");
  }
}

export async function listFixedAssets(): Promise<
  ActionResult<{ assets: ReadonlyArray<Record<string, unknown>>; blocks: ReadonlyArray<Record<string, unknown>> }>
> {
  try {
    const ctx = await requirePermission(READ);
    const data = await withTenant(ctx.tenant.id, async (tx) => {
      const assets = await tx
        .select()
        .from(fixedAssets)
        .where(eq(fixedAssets.tenantId, ctx.tenant.id))
        .orderBy(asc(fixedAssets.assetNo));
      const blocks = await tx
        .select()
        .from(itAssetBlocks)
        .where(eq(itAssetBlocks.tenantId, ctx.tenant.id))
        .orderBy(asc(itAssetBlocks.name));
      return { assets, blocks };
    });

    return {
      ok: true,
      data: {
        // ⚠️ `bigint` does not survive JSON, so paise cross the boundary
        // as digit strings. A `Number` here would silently round anything
        // over ₹90,07,19,92,54,740.
        assets: data.assets.map((a) => ({
          ...a,
          costMinor: a.costMinor.toString(),
          disposalConsiderationMinor: a.disposalConsiderationMinor?.toString() ?? null,
          prescribedLifeMonths: isScheduleIIClass(a.assetClass)
            ? SCHEDULE_II[a.assetClass].usefulLifeMonths
            : null,
        })),
        blocks: data.blocks.map((b) => ({
          ...b,
          openingWdvMinor: b.openingWdvMinor.toString(),
        })),
      },
    };
  } catch (err) {
    return toActionError(err, "fixed-assets");
  }
}

/* ================================================================== */
/* ② THE COMPANIES ACT RUN                                             */
/* ================================================================== */

/**
 * ⭐⭐⭐ COMPUTE THE PERIOD'S DEPRECIATION.
 *
 * ⚠️ COMPUTING IS NOT POSTING, AND THE TWO ARE SEPARATE ACTIONS. The
 * charge is a figure somebody should read before it becomes part of the
 * statutory books — the first month a company runs this, it is the moment
 * they discover an asset with the wrong life on it.
 */
export async function runDepreciation(input: unknown): Promise<
  ActionResult<{
    runId: string;
    totalChargeMinor: string;
    assetCount: number;
    lines: ReadonlyArray<Record<string, unknown>>;
    note: string;
  }>
> {
  try {
    const ctx = await requirePermission(MANAGE);
    await requireAccess("fixed_assets:manage", ctx);

    const { periodStart, periodEnd } = z
      .object({ periodStart: isoDate, periodEnd: isoDate })
      .parse(input);

    if (periodEnd < periodStart) {
      return { ok: false, error: "That period runs backwards." };
    }

    const outcome = await withTenant(ctx.tenant.id, (tx) =>
      computeCompaniesActRun(tx, {
        tenantId: ctx.tenant.id,
        userId: ctx.user.id,
        period: { from: periodStart, to: periodEnd },
      }),
    );

    if (!outcome.ok) {
      if (outcome.reason === "period_closed") {
        return {
          ok: false,
          error:
            `${outcome.period} is closed and this run covers days inside it. Depreciation for a sealed ` +
            `month cannot be recomputed — the closed accounts already contain a figure, and a second one ` +
            `would either double-charge or quietly disagree with the attestation somebody made. Reopen the ` +
            `period deliberately, or run a period that starts after it.`,
        };
      }
      if (outcome.reason === "already_posted") {
        return {
          ok: false,
          error:
            "This period's depreciation is already in the ledger. Recomputing it would edit a figure that " +
            "has been posted; the way to correct a posted run is to reverse the journal.",
        };
      }
      return {
        ok: false,
        error:
          "There is no asset in the register that was in use during this period, so there is nothing to depreciate.",
      };
    }

    await writeAudit(ctx, {
      action: "create",
      resourceType: "depreciation_run",
      resourceId: outcome.runId,
      metadata: {
        basis: "companies_act",
        periodStart,
        periodEnd,
        totalChargeMinor: outcome.run.totalChargeMinor.toString(),
        assetCount: outcome.run.lines.length,
        recomputed: outcome.alreadyExisted,
      },
    });

    revalidatePath("/fixed-assets");
    return {
      ok: true,
      data: {
        runId: outcome.runId,
        totalChargeMinor: outcome.run.totalChargeMinor.toString(),
        assetCount: outcome.run.lines.length,
        lines: outcome.run.lines.map((l) => ({
          assetId: l.assetId,
          assetNo: l.assetNo,
          method: l.method,
          daysInUse: l.daysInUse,
          rateBp: l.rateBp,
          shiftFactorBp: l.shiftFactorBp,
          openingAccumulatedMinor: l.openingAccumulatedMinor.toString(),
          chargeMinor: l.chargeMinor.toString(),
          closingCarryingMinor: l.closingCarryingMinor.toString(),
          terminal: l.terminal,
          notes: l.notes,
        })),
        note:
          "Computed, not posted. Read the lines before putting the charge into the books — " +
          "posting is a separate decision and a separate permission.",
      },
    };
  } catch (err) {
    return toActionError(err, "fixed-assets");
  }
}

/**
 * ⭐⭐⭐ POST THE RUN. This is where depreciation reaches the ledger.
 */
export async function postDepreciation(input: unknown): Promise<ActionResult<{ note: string }>> {
  try {
    const ctx = await requirePermission(POST);
    await requireAccess("fixed_assets:post", ctx);
    const { runId } = z.object({ runId: z.string().uuid() }).parse(input);

    const outcome = await withTenant(
      ctx.tenant.id,
      async (tx): Promise<Outcome<{ transactionId: string; total: string }>> => {
      const [run] = await tx
        .select()
        .from(depreciationRuns)
        .where(
          and(eq(depreciationRuns.tenantId, ctx.tenant.id), eq(depreciationRuns.id, runId)),
        )
        .limit(1);

      if (!run) return { error: "No such depreciation run." };
      if (run.basis !== "companies_act") {
        return {
          error:
            "That is the income-tax computation, and it is never posted. Section 32 depreciation is an " +
            "allowance in a tax computation, not an accounting entry — posting it would put the " +
            "Income-tax Act's figure into a Companies Act balance sheet and overstate accumulated " +
            "depreciation by the whole timing difference.",
        };
      }
      if (run.status === "posted") return { error: "This run is already in the ledger." };
      if (run.status === "cancelled") return { error: "This run was cancelled." };

      const [count] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(depreciationLines)
        .where(
          and(
            eq(depreciationLines.tenantId, ctx.tenant.id),
            eq(depreciationLines.runId, runId),
          ),
        );

      const periodEnd = String(run.periodEnd);
      const posted = await postDepreciationRun(tx, {
        tenantId: ctx.tenant.id,
        userId: ctx.user.id,
        runId,
        basis: run.basis,
        periodEnd,
        periodLabel: `${formatIso(String(run.periodStart))} to ${formatIso(periodEnd)}`,
        totalChargeMinor: run.totalChargeMinor,
        assetCount: count?.n ?? 0,
      });

      if (!posted.posted) {
        if (posted.reason === "unmapped_roles") {
          return {
            error:
              `Depreciation cannot reach the ledger until these accounts are mapped: ${posted.missing
                .map(
                  (r) =>
                    FIXED_ASSET_ROLE_META[r as keyof typeof FIXED_ASSET_ROLE_META]?.label ?? r,
                )
                .join(", ")}. Nothing has been posted — a journal missing a leg does not balance. ` +
              /**
               * ⭐ AND NOW IT SAYS WHERE. Batch 0108.
               *
               * 🔴 THIS MESSAGE NAMED THE PROBLEM PERFECTLY AND SENT THE
               * READER NOWHERE — and until this batch there was nowhere to
               * send them: `depreciation_expense` and the other five
               * fixed-asset roles were absent from the posting-accounts
               * screen's list AND refused by `setSalesPostingAccount`'s
               * validator. 0100 shipped a depreciation engine no navigation
               * reached for four batches; this was the same defect one
               * level down, and it outlived the fix to the first one.
               */
              mapAccountsSentence("fixed_assets"),
          };
        }
        if (posted.reason === "period_closed") {
          return {
            error: `${posted.period} is closed and this run is dated in it. Reopen the period deliberately, or correct the run's dates.`,
          };
        }
        if (posted.reason === "already_posted") {
          return { error: "This charge is already in the ledger." };
        }
        return {
          error:
            "This run charged nothing — every asset in it is already at its residual value. There is no journal to write.",
        };
      }

      await tx
        .update(depreciationRuns)
        .set({ status: "posted", postedAt: new Date(), transactionId: posted.transactionId })
        .where(eq(depreciationRuns.id, runId));

      return { transactionId: posted.transactionId, total: run.totalChargeMinor.toString() };
      },
    );

    // ⚠️ `outcome.error !== undefined`, NOT `"error" in outcome`. The
    // success branch declares `error?: undefined`, so `in` does not narrow
    // the union and every success field stays possibly-undefined.
    if (outcome.error !== undefined) return { ok: false, error: outcome.error };

    await writeAudit(ctx, {
      action: "create",
      resourceType: "depreciation_posting",
      resourceId: runId,
      severity: "warning",
      metadata: { transactionId: outcome.transactionId, totalChargeMinor: outcome.total },
    });

    revalidatePath("/fixed-assets");
    return {
      ok: true,
      data: {
        note: "Depreciation is in the ledger, dated the last day of the period rather than today.",
      },
    };
  } catch (err) {
    return toActionError(err, "fixed-assets");
  }
}

/* ================================================================== */
/* ③ THE INCOME-TAX COMPUTATION                                        */
/* ================================================================== */

/**
 * ⭐⭐⭐ SECTION 32, BLOCK BY BLOCK, FOR ONE PREVIOUS YEAR.
 *
 * 🔴 THIS PRODUCES A DIFFERENT NUMBER FROM `runDepreciation` ON THE SAME
 * ASSETS AND BOTH ARE RIGHT. It never posts.
 */
export async function runIncomeTaxDepreciation(input: unknown): Promise<
  ActionResult<{
    runId: string;
    fyFrom: string;
    fyTo: string;
    totalAllowanceMinor: string;
    blocks: ReadonlyArray<Record<string, unknown>>;
    note: string;
  }>
> {
  try {
    const ctx = await requirePermission(MANAGE);
    await requireAccess("fixed_assets:manage", ctx);
    const { anyDayInYear } = z.object({ anyDayInYear: isoDate }).parse(input);

    const outcome = await withTenant(ctx.tenant.id, (tx) =>
      computeIncomeTaxYear(tx, {
        tenantId: ctx.tenant.id,
        userId: ctx.user.id,
        anyDayInYear,
      }),
    );

    if (!outcome.ok) {
      if (outcome.reason === "before_opening") {
        return {
          ok: false,
          error:
            `The block "${outcome.block}" has an opening written-down value stated as at ${formatIso(outcome.asAt)}, ` +
            `and this year starts before that. Rolling a block backwards from an opening balance is how a tax ` +
            `computation quietly disagrees with the return that was already filed.`,
        };
      }
      return {
        ok: false,
        error:
          "No blocks of assets have been set up. Section 32 depreciates a BLOCK — every asset of the same " +
          "class attracting the same prescribed rate is one pool, and the written-down value belongs to the " +
          "pool rather than to any asset in it.",
      };
    }

    await writeAudit(ctx, {
      action: "create",
      resourceType: "depreciation_run",
      resourceId: outcome.runId,
      metadata: {
        basis: "income_tax",
        fyStart: fyStartFor(anyDayInYear),
        fyEnd: fyEndFor(anyDayInYear),
        blocks: outcome.blocks.length,
      },
    });

    return {
      ok: true,
      data: {
        runId: outcome.runId,
        fyFrom: fyStartFor(anyDayInYear),
        fyTo: fyEndFor(anyDayInYear),
        totalAllowanceMinor: outcome.blocks
          .reduce((s, b) => s + b.depreciationMinor, 0n)
          .toString(),
        blocks: outcome.blocks.map((b) => ({
          blockId: b.blockId,
          blockName: b.blockName,
          rateBp: b.rateBp,
          openingWdvMinor: b.openingWdvMinor.toString(),
          fullRateAdditionsMinor: b.fullRateAdditionsMinor.toString(),
          halfRateAdditionsMinor: b.halfRateAdditionsMinor.toString(),
          moneysPayableMinor: b.moneysPayableMinor.toString(),
          depreciationMinor: b.depreciationMinor.toString(),
          closingWdvMinor: b.closingWdvMinor.toString(),
          shortTermCapitalGainMinor: b.shortTermCapitalGainMinor.toString(),
          shortTermCapitalLossMinor: b.shortTermCapitalLossMinor.toString(),
          blockCeases: b.blockCeases,
          additions: b.additions.map((a) => ({
            assetNo: a.assetNo,
            costMinor: a.actualCostMinor.toString(),
            daysInUse: a.daysInUse,
            halfRate: a.halfRate,
          })),
          notes: b.notes,
        })),
        note:
          "This is the section 32 allowance for the return. It is deliberately NOT posted — it is a " +
          "different statute's number on the same assets, and the difference between it and the book " +
          "charge is the timing difference deferred tax is computed on.",
      },
    };
  } catch (err) {
    return toActionError(err, "fixed-assets");
  }
}

export async function deferredTaxWorking(input: unknown): Promise<
  ActionResult<{
    fyLabel: string;
    bookCarryingMinor: string;
    taxWdvMinor: string;
    differenceMinor: string;
    gives: string;
    note: string;
  } | null>
> {
  try {
    const ctx = await requirePermission(READ);
    const { anyDayInYear } = z.object({ anyDayInYear: isoDate }).parse(input);

    const working = await withTenant(ctx.tenant.id, (tx) =>
      deferredTaxInput(tx, ctx.tenant.id, anyDayInYear),
    );

    if (!working) {
      return {
        ok: false,
        error:
          "The income-tax computation has not been run for this year, so there is nothing to compare the " +
          "books against. ⚠️ The answer is not zero — a zero difference and an uncomputed one look identical " +
          "on a balance sheet and mean opposite things.",
      };
    }

    return {
      ok: true,
      data: {
        fyLabel: working.fyLabel,
        bookCarryingMinor: working.bookCarryingMinor.toString(),
        taxWdvMinor: working.taxWdvMinor.toString(),
        differenceMinor: working.difference.differenceMinor.toString(),
        gives: working.difference.gives,
        note: working.difference.note,
      },
    };
  } catch (err) {
    return toActionError(err, "fixed-assets");
  }
}

/* ================================================================== */
/* ④ DISPOSAL                                                          */
/* ================================================================== */

/**
 * ⭐⭐ SELL AN ASSET, AND RECORD BOTH ANSWERS.
 *
 * 🔴 THE COMPANIES ACT AND THE INCOME-TAX ACT DIFFER HERE AND THIS
 * FUNCTION DOES NOT COLLAPSE THEM. The ledger takes the asset-level
 * profit or loss; the block takes the moneys payable and produces no
 * gain at all unless it empties or is exhausted. Both are recorded, and
 * `runIncomeTaxDepreciation` is what turns the second into a figure.
 *
 * ⚠️ IT REFUSES UNTIL DEPRECIATION HAS BEEN CHARGED TO THE DAY OF SALE.
 * Otherwise the months since the last run land in "profit on sale of
 * fixed assets" instead of "depreciation" — two different lines of the
 * profit and loss account and two different disclosures, and the error is
 * invisible because the entry still balances.
 */
export async function disposeFixedAsset(input: unknown): Promise<
  ActionResult<{
    carryingAmountMinor: string;
    gainMinor: string;
    lossMinor: string;
    taxNote: string;
  }>
> {
  try {
    const ctx = await requirePermission(POST);
    await requireAccess("fixed_assets:post", ctx);

    const d = z
      .object({
        assetId: z.string().uuid(),
        disposedOn: isoDate,
        considerationMinor: minorAmount,
      })
      .parse(input);

    const consideration = BigInt(d.considerationMinor);

    const outcome = await withTenant(
      ctx.tenant.id,
      async (
        tx,
      ): Promise<
        Outcome<{
          assetNo: string;
          carrying: string;
          gain: string;
          loss: string;
          taxNote: string;
        }>
      > => {
      const [asset] = await tx
        .select()
        .from(fixedAssets)
        .where(and(eq(fixedAssets.tenantId, ctx.tenant.id), eq(fixedAssets.id, d.assetId)))
        .limit(1);
      if (!asset) return { error: "No such asset." };
      if (asset.status !== "in_use") return { error: "That asset has already left the register." };
      if (d.disposedOn < String(asset.putToUseOn)) {
        return { error: "An asset cannot be disposed of before it was put to use." };
      }

      const working = await disposalWorking(tx, {
        tenantId: ctx.tenant.id,
        assetId: d.assetId,
        disposedOn: d.disposedOn,
        considerationMinor: consideration,
      });
      if (!working) return { error: "No such asset." };

      if (!working.depreciationUpToDatePosted) {
        return {
          error:
            `Depreciation on ${asset.assetNo} has not been posted up to ${formatIso(d.disposedOn)}. ` +
            `Run and post the depreciation for the period the disposal falls in first — otherwise the ` +
            `months since the last run would be reported as part of the profit or loss on sale instead of ` +
            `as depreciation, and the entry would balance perfectly while saying the wrong thing.`,
        };
      }

      const accumulated = await accumulatedUpToInclusive(
        tx,
        ctx.tenant.id,
        d.assetId,
        d.disposedOn,
      );

      const posted = await postAssetDisposal(tx, {
        tenantId: ctx.tenant.id,
        userId: ctx.user.id,
        assetId: d.assetId,
        assetNo: asset.assetNo,
        disposedOn: d.disposedOn,
        costMinor: asset.costMinor,
        accumulatedMinor: accumulated,
        considerationMinor: consideration,
      });

      if (!posted.posted) {
        if (posted.reason === "unmapped_roles") {
          return {
            error: `The disposal cannot reach the ledger until these accounts are mapped: ${posted.missing
              .map(
                (r) => FIXED_ASSET_ROLE_META[r as keyof typeof FIXED_ASSET_ROLE_META]?.label ?? r,
              )
              .join(", ")}. Nothing has been posted and the asset is still in the register.`,
          };
        }
        if (posted.reason === "period_closed") {
          return {
            error: `${posted.period} is closed and this disposal is dated in it. Reopen the period deliberately, or correct the date.`,
          };
        }
        return { error: "This disposal is already in the ledger." };
      }

      await tx
        .update(fixedAssets)
        .set({
          status: "disposed",
          disposedOn: d.disposedOn,
          disposalConsiderationMinor: consideration,
          disposalTransactionId: posted.transactionId,
          updatedAt: new Date(),
        })
        .where(eq(fixedAssets.id, d.assetId));

      return {
        assetNo: asset.assetNo,
        carrying: working.book.carryingAmountMinor.toString(),
        gain: working.book.gainMinor.toString(),
        loss: working.book.lossMinor.toString(),
        taxNote: working.taxNote,
      };
      },
    );

    // ⚠️ `outcome.error !== undefined`, NOT `"error" in outcome`. The
    // success branch declares `error?: undefined`, so `in` does not narrow
    // the union and every success field stays possibly-undefined.
    if (outcome.error !== undefined) return { ok: false, error: outcome.error };

    await writeAudit(ctx, {
      action: "update",
      resourceType: "fixed_asset",
      resourceId: d.assetId,
      severity: "warning",
      metadata: {
        assetNo: outcome.assetNo,
        disposedOn: d.disposedOn,
        considerationMinor: d.considerationMinor,
        bookGainMinor: outcome.gain,
        bookLossMinor: outcome.loss,
      },
    });

    revalidatePath("/fixed-assets");
    return {
      ok: true,
      data: {
        carryingAmountMinor: outcome.carrying,
        gainMinor: outcome.gain,
        lossMinor: outcome.loss,
        taxNote: outcome.taxNote,
      },
    };
  } catch (err) {
    return toActionError(err, "fixed-assets");
  }
}

/* ================================================================== */
/* ⑤ THE WORKINGS SOMEBODY ASKS FOR                                    */
/* ================================================================== */

/**
 * ⭐ THE WHOLE-LIFE SCHEDULE FOR ONE ASSET — the working an auditor asks
 * for, produced by the same function that produces the charge, so the two
 * cannot disagree.
 */
export async function depreciationSchedule(input: unknown): Promise<
  ActionResult<{ assetNo: string; years: ReadonlyArray<Record<string, unknown>> }>
> {
  try {
    const ctx = await requirePermission(READ);
    const { assetId } = z.object({ assetId: z.string().uuid() }).parse(input);

    const asset = await withTenant(ctx.tenant.id, async (tx) => {
      const [row] = await tx
        .select()
        .from(fixedAssets)
        .where(and(eq(fixedAssets.tenantId, ctx.tenant.id), eq(fixedAssets.id, assetId)))
        .limit(1);
      return row ?? null;
    });

    if (!asset) return { ok: false, error: "No such asset." };
    if (!isScheduleIIClass(asset.assetClass)) {
      return {
        ok: false,
        error: `${asset.assetNo} is classified as "${asset.assetClass}", which is not a Schedule II Part C class.`,
      };
    }
    if (asset.depreciationMethod !== "slm" && asset.depreciationMethod !== "wdv") {
      return {
        ok: false,
        error: `${asset.assetNo} carries "${asset.depreciationMethod}" as its depreciation method, which this engine does not implement.`,
      };
    }

    const years = companiesActSchedule({
      id: asset.id,
      assetNo: asset.assetNo,
      assetClass: asset.assetClass,
      costMinor: asset.costMinor,
      residualBp: asset.residualBp,
      residualJustification: asset.residualJustification,
      usefulLifeMonths: asset.usefulLifeMonths,
      lifeJustification: asset.lifeJustification,
      method: asset.depreciationMethod,
      shiftUsage: asset.shiftUsage as ShiftUsage,
      putToUseOn: String(asset.putToUseOn),
      disposedOn: asset.disposedOn === null ? null : String(asset.disposedOn),
      // ⚠️ FROM ZERO. This is the schedule the asset WOULD follow, which
      // is what an auditor compares the posted charges against. Starting
      // it from what has been posted would make it agree by construction
      // and prove nothing.
      accumulatedDepreciationMinor: 0n,
    });

    return {
      ok: true,
      data: {
        assetNo: asset.assetNo,
        years: years.map((y) => ({
          method: y.method,
          daysInUse: y.daysInUse,
          rateBp: y.rateBp,
          shiftFactorBp: y.shiftFactorBp,
          openingAccumulatedMinor: y.openingAccumulatedMinor.toString(),
          chargeMinor: y.chargeMinor.toString(),
          closingAccumulatedMinor: y.closingAccumulatedMinor.toString(),
          closingCarryingMinor: y.closingCarryingMinor.toString(),
          terminal: y.terminal,
          notes: y.notes,
        })),
      },
    };
  } catch (err) {
    return toActionError(err, "fixed-assets");
  }
}

/**
 * ⭐ THE ACCOUNTS THIS TENANT STILL HAS TO MAP, answered before the first
 * run rather than at the moment posting fails.
 */
export async function fixedAssetAccountsNeeded(): Promise<
  ActionResult<{
    roles: ReadonlyArray<{ role: string; label: string; help: string; mapped: boolean }>;
  }>
> {
  try {
    const ctx = await requirePermission(READ);
    const mapped = await withTenant(ctx.tenant.id, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT role FROM sales_posting_accounts WHERE tenant_id = ${ctx.tenant.id}::uuid
      `);
      const list = (Array.isArray(rows)
        ? rows
        : ((rows as { rows?: unknown[] }).rows ?? [])) as Array<{ role?: string }>;
      return new Set(list.map((r) => String(r.role)));
    });

    return {
      ok: true,
      data: {
        roles: Object.entries(FIXED_ASSET_ROLE_META).map(([role, meta]) => ({
          role,
          label: meta.label,
          help: meta.help,
          mapped: mapped.has(role),
        })),
      },
    };
  } catch (err) {
    return toActionError(err, "fixed-assets");
  }
}

/**
 * ⭐⭐ THE WORKING BEHIND ONE RUN — the arithmetic, not just the answer.
 *
 * 🔴 THIS IS WHAT `days_in_use`, `rate_bp`, `shift_factor_bp` AND
 * `half_rate` ARE FOR. They are stored on every line because an auditor
 * asking "why is this figure what it is" two years later is entitled to
 * the working that produced it, and re-deriving it from today's
 * configuration would answer a different question. A stored working that
 * nothing ever reads back is decoration; this is the read.
 */
export async function depreciationRunDetail(input: unknown): Promise<
  ActionResult<{
    run: Record<string, unknown>;
    lines: ReadonlyArray<Record<string, unknown>>;
  }>
> {
  try {
    const ctx = await requirePermission(READ);
    const { runId } = z.object({ runId: z.string().uuid() }).parse(input);

    const data = await withTenant(ctx.tenant.id, async (tx) => {
      const [run] = await tx
        .select()
        .from(depreciationRuns)
        .where(
          and(eq(depreciationRuns.tenantId, ctx.tenant.id), eq(depreciationRuns.id, runId)),
        )
        .limit(1);
      if (!run) return null;

      const lines = await tx
        .select()
        .from(depreciationLines)
        .where(
          and(
            eq(depreciationLines.tenantId, ctx.tenant.id),
            eq(depreciationLines.runId, runId),
          ),
        );
      return { run, lines };
    });

    if (!data) return { ok: false, error: "No such depreciation run." };

    return {
      ok: true,
      data: {
        run: {
          id: data.run.id,
          basis: data.run.basis,
          periodStart: data.run.periodStart,
          periodEnd: data.run.periodEnd,
          status: data.run.status,
          totalChargeMinor: data.run.totalChargeMinor.toString(),
          // ⭐ s.50(1) and s.50(2). Read back here rather than only being
          // written: a capital gain nobody can see is a return that gets
          // filed without it.
          shortTermCapitalGainMinor: data.run.shortTermCapitalGainMinor.toString(),
          shortTermCapitalLossMinor: data.run.shortTermCapitalLossMinor.toString(),
          transactionId: data.run.transactionId,
          postedAt: data.run.postedAt,
          note: data.run.note,
        },
        lines: data.lines.map((l) => ({
          fixedAssetId: l.fixedAssetId,
          itBlockId: l.itBlockId,
          method: l.method,
          rateBp: l.rateBp,
          shiftFactorBp: l.shiftFactorBp,
          daysInUse: l.daysInUse,
          halfRate: l.halfRate,
          openingMinor: l.openingMinor.toString(),
          chargeMinor: l.chargeMinor.toString(),
          closingMinor: l.closingMinor.toString(),
          working: l.working,
        })),
      },
    };
  } catch (err) {
    return toActionError(err, "fixed-assets");
  }
}
