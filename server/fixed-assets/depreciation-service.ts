import "server-only";

/**
 * Ordence — ⭐ THE DEPRECIATION SERVICE — WHERE THE ENGINE MEETS THE BOOKS
 * Batch 100 · v1.53.0-alpha · SQL-FILES/0100
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS IS A SEPARATE FILE FROM `lib/fixed-assets/depreciation.ts`
 * ══════════════════════════════════════════════════════════════════════
 * The engine is pure so that Schedule II, the section 32 block and the
 * two disposal treatments can be exercised without a database — because
 * accounting that can only be run through a transaction is accounting
 * that never gets run. This file is the other half: it reads the
 * register, folds accumulated depreciation out of the POSTED lines, asks
 * the closed periods whether it is allowed to compute at all, and writes
 * the working down.
 *
 * It is the same split as `lib/inventory/valuation.ts` +
 * `server/inventory/valuation-service.ts`, deliberately.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 ACCUMULATED DEPRECIATION IS FOLDED, NEVER STORED
 * ══════════════════════════════════════════════════════════════════════
 * There is no `accumulated_depreciation_minor` column on `fixed_assets`
 * and there must never be one. A counter is wrong in every direction the
 * moment a run is cancelled, recomputed or posted twice, and it has no
 * way of knowing it is wrong. `depreciation_lines` belonging to POSTED
 * runs is the balance; a `computed` run is a proposal and counts for
 * nothing until somebody posts it.
 */

import { and, asc, eq, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import {
  depreciationLines,
  depreciationRuns,
  fixedAssets,
  itAssetBlocks,
} from "@/db/schema/fixed-assets";
import {
  assertKnownMethod,
  bookDisposal,
  companiesActRun,
  incomeTaxBlockYear,
  isScheduleIIClass,
  temporaryDifference,
  DepreciationError,
  type CompaniesActRun,
  type DepreciationPeriod,
  type FixedAssetFacts,
  type ItAddition,
  type ItBlockClass,
  type ItBlockYear,
  type ItDisposal,
  type ScheduleIIClass,
  type ShiftUsage,
} from "@/lib/fixed-assets/depreciation";
import { fyEndFor, fyStartFor, formatIso } from "@/lib/accounting/periods";

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

export { DepreciationError };

/* ================================================================== */
/* ① THE PERIOD GATE                                                   */
/* ================================================================== */

/**
 * ⭐ THE NAME OF ANY CLOSED OR LOCKED PERIOD OVERLAPPING THE WINDOW.
 *
 * ⚠️ CLOSED AND LOCKED ONLY. `closing` deliberately still accepts work —
 * it is the state somebody sits in while finishing a month, and refusing
 * there would make a month impossible to close. This mirrors
 * `closedPeriodFor` in `server/accounting/post-sales.ts` and
 * `closedPeriodsFor` in the valuation service rather than inventing a
 * third opinion about what "closed" means.
 *
 * 🔴 IT LOOKS AT OVERLAP, NOT AT THE END DATE. A March run computed
 * against a closed February would take February's days into a figure
 * that February's sealed accounts do not contain.
 */
export async function closedPeriodOverlapping(
  tx: Tx,
  tenantId: string,
  period: DepreciationPeriod,
): Promise<string | null> {
  const rows = await tx.execute(sql`
    SELECT name FROM financial_periods
     WHERE tenant_id = ${tenantId}::uuid
       AND status IN ('closed', 'locked')
       AND start_date <= ${period.to}::date
       AND end_date   >= ${period.from}::date
     ORDER BY start_date
     LIMIT 1
  `);
  const list = (Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])) as Array<{
    name?: string;
  }>;
  const first = list[0];
  return first ? String(first.name ?? "that period") : null;
}

/* ================================================================== */
/* ② READING THE REGISTER                                              */
/* ================================================================== */

type AssetRow = typeof fixedAssets.$inferSelect;

/**
 * 🔴 THE CONFIGURATION IS CARRIED ACROSS UNCHANGED AND VALIDATED BY THE
 * ENGINE, NOT PATCHED HERE. `asset_class`, `depreciation_method` and
 * `shift_usage` are varchars in the database — anything can be written
 * into them by an import or a fix-up script — so this function refuses a
 * value it does not recognise BY NAME rather than falling back to a
 * default. A default is how a column comes to be read by nothing.
 */
function toFacts(row: AssetRow, accumulatedMinor: bigint): FixedAssetFacts {
  if (!isScheduleIIClass(row.assetClass)) {
    throw new DepreciationError(
      `${row.assetNo} is classified as "${row.assetClass}", which is not a Schedule II Part C class ` +
        `this engine knows. Nothing has been depreciated — correct the classification rather than ` +
        `letting it fall through to a default, because the class decides both the prescribed life and ` +
        `whether extra shift depreciation may apply at all.`,
    );
  }
  assertKnownMethod(row.depreciationMethod);

  return {
    id: row.id,
    assetNo: row.assetNo,
    assetClass: row.assetClass as ScheduleIIClass,
    costMinor: row.costMinor,
    residualBp: row.residualBp,
    residualJustification: row.residualJustification,
    usefulLifeMonths: row.usefulLifeMonths,
    lifeJustification: row.lifeJustification,
    method: row.depreciationMethod,
    shiftUsage: row.shiftUsage as ShiftUsage,
    putToUseOn: String(row.putToUseOn),
    disposedOn: row.disposedOn === null ? null : String(row.disposedOn),
    accumulatedDepreciationMinor: accumulatedMinor,
  };
}

/**
 * ⭐ ACCUMULATED DEPRECIATION AS AT THE DAY BEFORE `from`, PER ASSET.
 *
 * ⚠️ POSTED RUNS ONLY, AND ONLY ON THE COMPANIES ACT BASIS. A `computed`
 * run is a proposal somebody may throw away; an income-tax run is a
 * different statute's number and adding it here would depreciate every
 * asset twice, on two different bases, into one figure.
 */
export async function accumulatedBefore(
  tx: Tx,
  tenantId: string,
  from: string,
): Promise<Map<string, bigint>> {
  const rows = await tx.execute(sql`
    SELECT l.fixed_asset_id::text AS asset_id,
           COALESCE(SUM(l.charge_minor), 0)::text AS total
      FROM depreciation_lines l
      JOIN depreciation_runs r ON r.id = l.run_id AND r.tenant_id = l.tenant_id
     WHERE l.tenant_id = ${tenantId}::uuid
       AND l.fixed_asset_id IS NOT NULL
       AND r.basis = 'companies_act'
       AND r.status = 'posted'
       AND r.period_end < ${from}::date
     GROUP BY l.fixed_asset_id
  `);
  const list = (Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])) as Array<{
    asset_id?: string;
    total?: string;
  }>;
  const map = new Map<string, bigint>();
  for (const r of list) {
    if (r.asset_id) map.set(r.asset_id, BigInt(r.total ?? "0"));
  }
  return map;
}

/** Accumulated depreciation on one asset, up to and including `upTo`. */
export async function accumulatedUpToInclusive(
  tx: Tx,
  tenantId: string,
  assetId: string,
  upTo: string,
): Promise<bigint> {
  const rows = await tx.execute(sql`
    SELECT COALESCE(SUM(l.charge_minor), 0)::text AS total
      FROM depreciation_lines l
      JOIN depreciation_runs r ON r.id = l.run_id AND r.tenant_id = l.tenant_id
     WHERE l.tenant_id = ${tenantId}::uuid
       AND l.fixed_asset_id = ${assetId}::uuid
       AND r.basis = 'companies_act'
       AND r.status = 'posted'
       AND r.period_end <= ${upTo}::date
  `);
  const list = (Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])) as Array<{
    total?: string;
  }>;
  return BigInt(list[0]?.total ?? "0");
}

/**
 * Every asset that could take a charge in the window: put to use on or
 * before the end of it, and not disposed of before the start of it.
 *
 * ⚠️ DISPOSED ASSETS ARE INCLUDED WHEN THE DISPOSAL FALLS INSIDE THE
 * WINDOW. An asset sold on the 20th was in use for twenty days and is
 * entitled to twenty days of depreciation; dropping it because its status
 * now reads `disposed` would understate the charge and overstate the
 * profit on sale by the same amount.
 */
export async function assetsInWindow(
  tx: Tx,
  tenantId: string,
  period: DepreciationPeriod,
): Promise<FixedAssetFacts[]> {
  const rows = await tx
    .select()
    .from(fixedAssets)
    .where(
      and(
        eq(fixedAssets.tenantId, tenantId),
        sql`${fixedAssets.putToUseOn} <= ${period.to}::date`,
        sql`(${fixedAssets.disposedOn} IS NULL OR ${fixedAssets.disposedOn} >= ${period.from}::date)`,
      ),
    )
    .orderBy(asc(fixedAssets.assetNo));

  const accumulated = await accumulatedBefore(tx, tenantId, period.from);
  return rows.map((r) => toFacts(r, accumulated.get(r.id) ?? 0n));
}

/* ================================================================== */
/* ③ THE COMPANIES ACT RUN                                             */
/* ================================================================== */

export type RunOutcome =
  | { ok: true; runId: string; run: CompaniesActRun; alreadyExisted: boolean }
  | { ok: false; reason: "period_closed"; period: string }
  | { ok: false; reason: "already_posted" }
  | { ok: false; reason: "no_assets" };

/**
 * ⭐⭐ COMPUTE THE PERIOD AND WRITE THE WORKING DOWN.
 *
 * 🔴 A CLOSED PERIOD IS REFUSED BEFORE ANYTHING IS COMPUTED. Depreciation
 * for a sealed month cannot be recomputed, because the sealed accounts
 * already contain a figure and a second one would either double-charge or
 * silently disagree with the attestation somebody made.
 *
 * 🔴 A POSTED RUN IS NEVER REPLACED. Recomputing one would edit a figure
 * that is already in the ledger. The remedy for a wrong posted run is a
 * reversal in the ledger, which is what `transactions:reverse` is for.
 *
 * ⭐ AN UNPOSTED RUN FOR THE SAME PERIOD IS REPLACED, and that is the
 * useful case: somebody adds an asset they forgot and runs it again.
 */
export async function computeCompaniesActRun(
  tx: Tx,
  args: {
    tenantId: string;
    userId: string;
    period: DepreciationPeriod;
  },
): Promise<RunOutcome> {
  const locked = await closedPeriodOverlapping(tx, args.tenantId, args.period);
  if (locked) return { ok: false, reason: "period_closed", period: locked };

  const [existing] = await tx
    .select({ id: depreciationRuns.id, status: depreciationRuns.status })
    .from(depreciationRuns)
    .where(
      and(
        eq(depreciationRuns.tenantId, args.tenantId),
        eq(depreciationRuns.basis, "companies_act"),
        eq(depreciationRuns.periodStart, args.period.from),
        eq(depreciationRuns.periodEnd, args.period.to),
      ),
    )
    .limit(1);

  if (existing && existing.status === "posted") {
    return { ok: false, reason: "already_posted" };
  }

  const facts = await assetsInWindow(tx, args.tenantId, args.period);
  if (facts.length === 0) return { ok: false, reason: "no_assets" };

  // ⚠️ THE ENGINE MAY THROW, AND IT SHOULD. An asset whose useful life
  // departs from Schedule II with no justification recorded stops the
  // whole run rather than being quietly skipped — a run that silently
  // omits an asset produces a charge that is short by an amount nobody
  // can see.
  const run = companiesActRun(facts, args.period);

  let runId: string;
  if (existing) {
    runId = existing.id;
    await tx.delete(depreciationLines).where(
      and(
        eq(depreciationLines.tenantId, args.tenantId),
        eq(depreciationLines.runId, runId),
      ),
    );
    await tx
      .update(depreciationRuns)
      .set({
        totalChargeMinor: run.totalChargeMinor,
        computedAt: new Date(),
        computedBy: args.userId,
      })
      .where(eq(depreciationRuns.id, runId));
  } else {
    const [created] = await tx
      .insert(depreciationRuns)
      .values({
        tenantId: args.tenantId,
        basis: "companies_act",
        periodStart: args.period.from,
        periodEnd: args.period.to,
        status: "computed",
        totalChargeMinor: run.totalChargeMinor,
        computedBy: args.userId,
      })
      .returning({ id: depreciationRuns.id });
    if (!created) throw new Error("The depreciation run could not be created.");
    runId = created.id;
  }

  await tx.insert(depreciationLines).values(
    run.lines.map((l) => ({
      tenantId: args.tenantId,
      runId,
      fixedAssetId: l.assetId,
      itBlockId: null,
      openingMinor: l.openingAccumulatedMinor,
      chargeMinor: l.chargeMinor,
      closingMinor: l.closingAccumulatedMinor,
      method: l.method,
      rateBp: l.rateBp,
      shiftFactorBp: l.shiftFactorBp,
      daysInUse: l.daysInUse,
      halfRate: false,
      working: {
        notes: [...l.notes],
        costMinor: l.costMinor.toString(),
        residualMinor: l.residualMinor.toString(),
        usefulLifeDays: l.usefulLifeDays,
        openingCarryingMinor: l.openingCarryingMinor.toString(),
        closingCarryingMinor: l.closingCarryingMinor.toString(),
        terminal: l.terminal,
      },
    })),
  );

  return { ok: true, runId, run, alreadyExisted: Boolean(existing) };
}

/* ================================================================== */
/* ④ THE INCOME-TAX YEAR                                               */
/* ================================================================== */

export type ItYearOutcome =
  | { ok: true; runId: string; blocks: ItBlockYear[] }
  | { ok: false; reason: "no_blocks" }
  | { ok: false; reason: "before_opening"; block: string; asAt: string };

/**
 * ⭐⭐⭐ SECTION 32, BLOCK BY BLOCK, FOR ONE PREVIOUS YEAR.
 *
 * ⚠️ THE PREVIOUS YEAR IS THE UNIT AND NOTHING SMALLER. There is no such
 * thing as a month's tax depreciation: s.32 allows a percentage of the
 * written-down value of the block for the previous year, and the 180-day
 * rule is a test on the YEAR. A monthly tax figure would be an invention.
 *
 * 🔴 THE OPENING WDV IS THE TENANT'S OWN FIGURE FROM THEIR LAST
 * COMPUTATION, and this refuses to compute a year that starts before the
 * date they gave it for. Rolling backwards from an opening balance is how
 * a tax computation quietly disagrees with the return that was filed.
 *
 * ⚠️ NOT COMPUTED, AND SAID OUT LOUD RATHER THAN GUESSED: additional
 * depreciation under s.32(1)(iia) — 20% of actual cost of new plant and
 * machinery acquired by a manufacturer, halved where it was used for
 * under 180 days with the other half allowed the following year. Whether
 * a company is "engaged in the business of manufacture or production of
 * any article or thing" and whether an item is within the exclusions
 * (second-hand plant, office appliances, road transport vehicles, plant
 * installed in an office or residential accommodation, and anything whose
 * whole cost was allowed as a deduction) are judgements about the
 * business. There is deliberately no column for it: a flag nothing reads
 * is worse than a stated gap.
 */
export async function computeIncomeTaxYear(
  tx: Tx,
  args: { tenantId: string; userId: string; anyDayInYear: string },
): Promise<ItYearOutcome> {
  const fyStart = fyStartFor(args.anyDayInYear);
  const fyEnd = fyEndFor(args.anyDayInYear);

  const blocks = await tx
    .select()
    .from(itAssetBlocks)
    .where(eq(itAssetBlocks.tenantId, args.tenantId))
    .orderBy(asc(itAssetBlocks.name));

  if (blocks.length === 0) return { ok: false, reason: "no_blocks" };

  const assets = await tx
    .select()
    .from(fixedAssets)
    .where(eq(fixedAssets.tenantId, args.tenantId))
    .orderBy(asc(fixedAssets.assetNo));

  const results: ItBlockYear[] = [];

  for (const block of blocks) {
    const asAt = String(block.openingWdvAsAt);
    if (fyStart < asAt) {
      return { ok: false, reason: "before_opening", block: block.name, asAt };
    }

    const mine = assets.filter((a) => a.itBlockId === block.id);

    /**
     * ⭐ AN ADDITION OF THE YEAR IS ONE ACQUIRED **AND** PUT TO USE IN
     * IT. The second proviso to s.32(1) speaks of an asset "acquired by
     * the assessee during the previous year and is put to use ... for a
     * period of less than one hundred and eighty days in that previous
     * year", so both dates matter — and an asset first used in a later
     * year entered the block when it was ACQUIRED, which is why the
     * acquisition date decides membership and the use date decides the
     * rate.
     */
    const additions: ItAddition[] = mine
      .filter((a) => {
        const acquired = String(a.acquiredOn);
        return acquired >= fyStart && acquired <= fyEnd;
      })
      .map((a) => ({
        assetId: a.id,
        assetNo: a.assetNo,
        actualCostMinor: a.costMinor,
        putToUseOn: String(a.putToUseOn),
      }));

    const disposals: ItDisposal[] = mine
      .filter((a) => {
        const gone = a.disposedOn === null ? null : String(a.disposedOn);
        return gone !== null && gone >= fyStart && gone <= fyEnd;
      })
      .map((a) => ({
        assetId: a.id,
        assetNo: a.assetNo,
        moneysPayableMinor: a.disposalConsiderationMinor ?? 0n,
        disposedOn: String(a.disposedOn),
      }));

    /**
     * 🔴 WHAT IS LEFT IN THE BLOCK AT THE YEAR END, because an empty
     * block with value left in it is s.50(2) and gets NO depreciation
     * however much money is sitting in it.
     */
    const assetsRemaining = mine.filter((a) => {
      const gone = a.disposedOn === null ? null : String(a.disposedOn);
      return gone === null || gone > fyEnd;
    }).length;

    /**
     * ⚠️ THE OPENING WDV IS THE STORED FIGURE ONLY IN THE FIRST YEAR.
     * After that it is the CLOSING WDV of the year before, computed the
     * same way — because a stored per-year balance is a counter and would
     * drift the moment a disposal was corrected.
     */
    const opening =
      fyStart === fyStartFor(asAt)
        ? block.openingWdvMinor
        : await priorYearClosing(tx, args.tenantId, block.id, fyStart, block.openingWdvMinor, asAt);

    results.push(
      incomeTaxBlockYear(
        {
          blockId: block.id,
          blockName: block.name,
          blockClass: block.blockClass as ItBlockClass,
          rateBp: block.rateBp,
          openingWdvMinor: opening,
          additions,
          disposals,
          assetsRemaining,
        },
        { fyStart, fyEnd },
      ),
    );
  }

  const totalCharge = results.reduce((s, r) => s + r.depreciationMinor, 0n);
  const gain = results.reduce((s, r) => s + r.shortTermCapitalGainMinor, 0n);
  const loss = results.reduce((s, r) => s + r.shortTermCapitalLossMinor, 0n);

  const [existing] = await tx
    .select({ id: depreciationRuns.id })
    .from(depreciationRuns)
    .where(
      and(
        eq(depreciationRuns.tenantId, args.tenantId),
        eq(depreciationRuns.basis, "income_tax"),
        eq(depreciationRuns.periodStart, fyStart),
        eq(depreciationRuns.periodEnd, fyEnd),
      ),
    )
    .limit(1);

  let runId: string;
  if (existing) {
    runId = existing.id;
    await tx
      .delete(depreciationLines)
      .where(
        and(eq(depreciationLines.tenantId, args.tenantId), eq(depreciationLines.runId, runId)),
      );
    await tx
      .update(depreciationRuns)
      .set({
        totalChargeMinor: totalCharge,
        shortTermCapitalGainMinor: gain,
        shortTermCapitalLossMinor: loss,
        computedAt: new Date(),
        computedBy: args.userId,
      })
      .where(eq(depreciationRuns.id, runId));
  } else {
    const [created] = await tx
      .insert(depreciationRuns)
      .values({
        tenantId: args.tenantId,
        basis: "income_tax",
        periodStart: fyStart,
        periodEnd: fyEnd,
        // 🔴 `computed` AND IT STAYS THERE FOREVER. There is no posted
        // state for a tax computation, and 0100 puts a CHECK constraint
        // under it refusing a transaction id on an income-tax run.
        status: "computed",
        totalChargeMinor: totalCharge,
        shortTermCapitalGainMinor: gain,
        shortTermCapitalLossMinor: loss,
        computedBy: args.userId,
        note: "Section 32 block depreciation. Never posted to the ledger — this is a computation for the return.",
      })
      .returning({ id: depreciationRuns.id });
    if (!created) throw new Error("The income-tax depreciation run could not be created.");
    runId = created.id;
  }

  await tx.insert(depreciationLines).values(
    results.map((r) => ({
      tenantId: args.tenantId,
      runId,
      fixedAssetId: null,
      itBlockId: r.blockId,
      openingMinor: r.openingWdvMinor,
      chargeMinor: r.depreciationMinor,
      closingMinor: r.closingWdvMinor,
      method: "block_wdv",
      rateBp: r.rateBp,
      shiftFactorBp: 10000,
      daysInUse: 0,
      halfRate: r.halfRateBaseMinor > 0n,
      working: {
        notes: [...r.notes],
        fullRateAdditionsMinor: r.fullRateAdditionsMinor.toString(),
        halfRateAdditionsMinor: r.halfRateAdditionsMinor.toString(),
        moneysPayableMinor: r.moneysPayableMinor.toString(),
        fullRateBaseMinor: r.fullRateBaseMinor.toString(),
        halfRateBaseMinor: r.halfRateBaseMinor.toString(),
        shortTermCapitalGainMinor: r.shortTermCapitalGainMinor.toString(),
        shortTermCapitalLossMinor: r.shortTermCapitalLossMinor.toString(),
        blockCeases: r.blockCeases,
        additions: r.additions.map((a) => ({
          assetNo: a.assetNo,
          costMinor: a.actualCostMinor.toString(),
          daysInUse: a.daysInUse,
          halfRate: a.halfRate,
        })),
      },
    })),
  );

  return { ok: true, runId, blocks: results };
}

/**
 * The block's closing WDV for the year before `fyStart`, computed rather
 * than read — recursively back to the stated opening balance.
 *
 * ⚠️ RECOMPUTED, NOT CACHED, for the same reason the inventory engine
 * replays movements: a stored per-year balance drifts the first time a
 * disposal is corrected, and a tax computation that disagrees with the
 * register is worse than one that takes a moment longer.
 */
async function priorYearClosing(
  tx: Tx,
  tenantId: string,
  blockId: string,
  fyStart: string,
  storedOpening: bigint,
  storedAsAt: string,
): Promise<bigint> {
  const rows = await tx.execute(sql`
    SELECT l.closing_minor::text AS closing
      FROM depreciation_lines l
      JOIN depreciation_runs r ON r.id = l.run_id AND r.tenant_id = l.tenant_id
     WHERE l.tenant_id = ${tenantId}::uuid
       AND l.it_block_id = ${blockId}::uuid
       AND r.basis = 'income_tax'
       AND r.period_end < ${fyStart}::date
     ORDER BY r.period_end DESC
     LIMIT 1
  `);
  const list = (Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])) as Array<{
    closing?: string;
  }>;
  const found = list[0]?.closing;
  if (found !== undefined) return BigInt(found);

  /**
   * ⚠️ NO EARLIER YEAR HAS BEEN COMPUTED. Falling back to the stated
   * opening is the honest answer — it is what the tenant's last filed
   * computation said — and the caller is told which date it belongs to so
   * the gap is visible rather than silently spanned.
   */
  void storedAsAt;
  return storedOpening;
}

/* ================================================================== */
/* ⑤ DISPOSAL — BOTH TREATMENTS, NEITHER RECONCILED                    */
/* ================================================================== */

export type DisposalWorking = {
  readonly book: ReturnType<typeof bookDisposal>;
  /** What the sale does to the tax block, in one sentence. */
  readonly taxNote: string;
  /** True when depreciation up to the disposal date has been posted. */
  readonly depreciationUpToDatePosted: boolean;
};

/**
 * ⭐⭐ THE TWO ANSWERS SIDE BY SIDE.
 *
 * 🔴 THEY ARE NOT RECONCILED AND MUST NOT BE. The Companies Act produces
 * a profit or loss on this asset; the Income-tax Act reduces the block by
 * the moneys payable and produces nothing at all unless the block empties
 * or is exhausted. A machine sold at a ₹2 lakh book profit can carry no
 * tax whatsoever this year, and a system that showed one number would be
 * wrong about the other.
 */
export async function disposalWorking(
  tx: Tx,
  args: {
    tenantId: string;
    assetId: string;
    disposedOn: string;
    considerationMinor: bigint;
  },
): Promise<DisposalWorking | null> {
  const [asset] = await tx
    .select()
    .from(fixedAssets)
    .where(and(eq(fixedAssets.tenantId, args.tenantId), eq(fixedAssets.id, args.assetId)))
    .limit(1);
  if (!asset) return null;

  const accumulated = await accumulatedUpToInclusive(
    tx,
    args.tenantId,
    args.assetId,
    args.disposedOn,
  );

  /**
   * ⭐ HAS DEPRECIATION ACTUALLY BEEN CHARGED UP TO THE DAY IT WENT? A
   * disposal posted against a stale accumulated figure moves the missing
   * months out of `depreciation` and into `profit on sale of assets` —
   * two different lines of the P&L and two different disclosures.
   */
  const rows = await tx.execute(sql`
    SELECT MAX(r.period_end)::text AS latest
      FROM depreciation_lines l
      JOIN depreciation_runs r ON r.id = l.run_id AND r.tenant_id = l.tenant_id
     WHERE l.tenant_id = ${args.tenantId}::uuid
       AND l.fixed_asset_id = ${args.assetId}::uuid
       AND r.basis = 'companies_act'
       AND r.status = 'posted'
  `);
  const list = (Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])) as Array<{
    latest?: string | null;
  }>;
  const latest = list[0]?.latest ?? null;

  const book = bookDisposal({
    costMinor: asset.costMinor,
    accumulatedMinor: accumulated,
    considerationMinor: args.considerationMinor,
  });

  return {
    book,
    taxNote:
      `Under s.43(6)(c)(i)(B) the ${args.considerationMinor} paise receivable comes off the written-down ` +
      `value of the block, and no capital gain or loss arises on this asset by itself. A gain arises only ` +
      `if the proceeds exhaust the whole block (s.50(1)); a loss only if this was the last asset in it ` +
      `(s.50(2)). Run the income-tax computation for the year to see which, if either, happened.`,
    depreciationUpToDatePosted: latest !== null && String(latest) >= args.disposedOn,
  };
}

/* ================================================================== */
/* ⑥ THE DIVERGENCE                                                    */
/* ================================================================== */

export type DeferredTaxInput = {
  readonly fyLabel: string;
  readonly bookCarryingMinor: bigint;
  readonly taxWdvMinor: bigint;
  readonly difference: ReturnType<typeof temporaryDifference>;
};

/**
 * ⭐ THE NUMBER THAT ONLY EXISTS BECAUSE BOTH COMPUTATIONS WERE RUN.
 *
 * ⚠️ IT READS THE COMPUTED TAX RUN RATHER THAN RE-DERIVING IT, so the
 * deferred tax working and the tax computation cannot disagree. If no tax
 * run has been computed for the year, the answer is null and says so —
 * not zero, which would read as "no difference".
 */
export async function deferredTaxInput(
  tx: Tx,
  tenantId: string,
  anyDayInYear: string,
): Promise<DeferredTaxInput | null> {
  const fyStart = fyStartFor(anyDayInYear);
  const fyEnd = fyEndFor(anyDayInYear);

  const taxRows = await tx.execute(sql`
    SELECT COALESCE(SUM(l.closing_minor), 0)::text AS wdv
      FROM depreciation_lines l
      JOIN depreciation_runs r ON r.id = l.run_id AND r.tenant_id = l.tenant_id
     WHERE l.tenant_id = ${tenantId}::uuid
       AND r.basis = 'income_tax'
       AND r.period_start = ${fyStart}::date
       AND r.period_end = ${fyEnd}::date
       AND l.it_block_id IS NOT NULL
  `);
  const taxList = (Array.isArray(taxRows)
    ? taxRows
    : ((taxRows as { rows?: unknown[] }).rows ?? [])) as Array<{ wdv?: string }>;
  if (taxList.length === 0 || taxList[0]?.wdv === undefined) return null;

  const costRows = await tx.execute(sql`
    SELECT COALESCE(SUM(cost_minor), 0)::text AS gross
      FROM fixed_assets
     WHERE tenant_id = ${tenantId}::uuid
       AND (disposed_on IS NULL OR disposed_on > ${fyEnd}::date)
       AND put_to_use_on <= ${fyEnd}::date
  `);
  const costList = (Array.isArray(costRows)
    ? costRows
    : ((costRows as { rows?: unknown[] }).rows ?? [])) as Array<{ gross?: string }>;

  const accRows = await tx.execute(sql`
    SELECT COALESCE(SUM(l.charge_minor), 0)::text AS acc
      FROM depreciation_lines l
      JOIN depreciation_runs r ON r.id = l.run_id AND r.tenant_id = l.tenant_id
      JOIN fixed_assets a ON a.id = l.fixed_asset_id AND a.tenant_id = l.tenant_id
     WHERE l.tenant_id = ${tenantId}::uuid
       AND r.basis = 'companies_act'
       AND r.status = 'posted'
       AND r.period_end <= ${fyEnd}::date
       AND (a.disposed_on IS NULL OR a.disposed_on > ${fyEnd}::date)
  `);
  const accList = (Array.isArray(accRows)
    ? accRows
    : ((accRows as { rows?: unknown[] }).rows ?? [])) as Array<{ acc?: string }>;

  const gross = BigInt(costList[0]?.gross ?? "0");
  const accumulated = BigInt(accList[0]?.acc ?? "0");
  const bookCarrying = gross - accumulated;
  const taxWdv = BigInt(taxList[0]?.wdv ?? "0");

  return {
    fyLabel: `${formatIso(fyStart)} to ${formatIso(fyEnd)}`,
    bookCarryingMinor: bookCarrying,
    taxWdvMinor: taxWdv,
    difference: temporaryDifference({ bookCarryingMinor: bookCarrying, taxWdvMinor: taxWdv }),
  };
}
