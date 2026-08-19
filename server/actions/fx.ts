"use server";

/**
 * Ordence — ⭐⭐⭐ FOREIGN EXCHANGE — SERVER ACTIONS
 * Batch 0101 · v1.64.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION AND EVERY ONE OF THEM IS GUARDED.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS FILE IS FOR
 * ══════════════════════════════════════════════════════════════════════
 * It is the only browser-reachable surface of the FX subsystem. The
 * arithmetic is in `lib/fx/*` (pure, testable without a database) and the
 * I/O is in `server/fx/*` (a `tx` in every signature, so none of it can be
 * an RPC endpoint by accident). This file is the third layer: it checks
 * who is asking, opens the tenant transaction, and writes the audit row.
 *
 * ⚠️ `fx:manage_rates` AND `fx:revalue` ARE ON `DANGEROUS_PERMISSIONS`.
 * Both change the profit and loss account and neither is visible on any
 * screen until a statement is run.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { withTenant } from "@/db";
import { fxRates, fxReferenceRates, fxRevaluations, fxRevaluationLines } from "@/db/schema/fx";
import { salesInvoices } from "@/db/schema/sales-invoices";
import { requirePermission, writeAudit, auditMeta } from "@/server/audit";
import { TenantAccessError } from "@/server/tenant-context";
import { PermissionDeniedError } from "@/lib/permissions";
import type { ActionResult } from "@/lib/validators/crm";
import {
  KNOWN_CURRENCIES,
  formatMinorPlain,
  functionalCurrencyFromSettings,
  isKnownCurrency,
  normaliseCurrencyCode,
} from "@/lib/fx/currency";
import {
  STORABLE_FX_RATE_TYPES,
  describeQuote,
  formatRateScaled,
  parseRateToScaled,
} from "@/lib/fx/rates";
import { CLOSING_RATE_WINDOW } from "@/lib/fx/convert";
import { sumByCurrency, convertBuckets, describeConvertedTotal } from "@/lib/fx/aggregate";
import {
  activeCurrencyCodes,
  recordTenantRate,
  resolveQuote,
  verifyCurrencyUnits,
  type CurrencyUnitsDivergence,
} from "@/server/fx/rate-service";
import { runRevaluation } from "@/server/fx/revaluation-service";
import { buildFxRevaluationPosting, type FxLeg } from "@/lib/accounting/sales-posting";
import { postFxRevaluation as writeFxRevaluationJournal } from "@/server/accounting/post-sales";

function fail(error: string, fieldErrors?: Record<string, string[]>): ActionResult<never> {
  return { ok: false, error, fieldErrors };
}

function toActionError(err: unknown): ActionResult<never> {
  if (err instanceof TenantAccessError) return fail(err.message);
  if (err instanceof PermissionDeniedError) return fail(err.message);
  if (err instanceof z.ZodError) {
    return fail("Validation failed.", err.flatten().fieldErrors as Record<string, string[]>);
  }
  // ⚠️ THE MESSAGE IS SHOWN. `FxRateError` and `UnknownCurrencyError` both
  // carry a sentence that names the pair, the date and what did NOT
  // happen; replacing it with "something went wrong" would remove the only
  // instruction the user can act on.
  if (err instanceof Error) return fail(err.message);
  console.error("[fx action]", err);
  return fail("Something went wrong. Please try again.");
}

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date in YYYY-MM-DD form.");

const currencyCode = z
  .string()
  .trim()
  .toUpperCase()
  .refine(isKnownCurrency, "That is not a currency code this system knows.");

/* ------------------------------------------------------------------ */
/* THE CATALOGUE                                                       */
/* ------------------------------------------------------------------ */

export type CurrencyOption = { code: string; exponent: number };

/**
 * ⭐ THE CURRENCY LIST FOR A PICKER, WITH ITS EXPONENT.
 *
 * ⚠️ THE EXPONENT CROSSES TO THE CLIENT ON PURPOSE. A form that lets
 * somebody type "1.23" into a JPY field, or refuses "1.234" in a KWD one,
 * is the display half of the bug this batch fixes in the arithmetic. The
 * number of decimals a field allows has to come from the same table the
 * conversion uses.
 */
export async function listCurrencies(): Promise<ActionResult<CurrencyOption[]>> {
  try {
    const ctx = await requirePermission("fx:read");
    /**
     * 🔴 FROM `currency_units`, FILTERED ON `is_active`, NOT FROM THE
     * ENGINE'S FULL LIST. A flag written by a seed and read by nothing is
     * the defect pattern this batch exists to stop repeating; this is the
     * read that makes deactivating a currency actually do something.
     */
    const data = await withTenant(ctx.tenant.id, (tx) => activeCurrencyCodes(tx));
    return { ok: true, data };
  } catch (err) {
    return toActionError(err);
  }
}

export type RevaluationHistoryRow = {
  id: string;
  asOfDate: string;
  functionalCurrency: string;
  status: string;
  gain: string;
  loss: string;
  /** ⭐ COMPUTED FROM THE TWO STORED HALVES, never stored itself. */
  net: string;
  restatedCount: number;
  skippedCount: number;
  posted: boolean;
  unpostedReason: string | null;
};

/**
 * ⭐ THE HISTORY, WITH THE NET FOLDED FROM THE TWO STORED HALVES.
 *
 * 🔴 `gain_minor` AND `loss_minor` ARE READ HERE AND SUBTRACTED HERE, and
 * that is the only place the net exists. There is deliberately no
 * `net_minor` column: a third number that must agree with two others is a
 * number that eventually does not, and the direction it drifts in is
 * whichever way the last person to touch it was rounding.
 */
export async function listFxRevaluations(): Promise<ActionResult<RevaluationHistoryRow[]>> {
  try {
    const ctx = await requirePermission("fx:read");

    const rows = await withTenant(ctx.tenant.id, (tx) =>
      tx
        .select({
          id: fxRevaluations.id,
          asOfDate: fxRevaluations.asOfDate,
          functionalCurrency: fxRevaluations.functionalCurrency,
          status: fxRevaluations.status,
          gainMinor: fxRevaluations.gainMinor,
          lossMinor: fxRevaluations.lossMinor,
          restatedCount: fxRevaluations.restatedCount,
          skippedCount: fxRevaluations.skippedCount,
          transactionId: fxRevaluations.transactionId,
          unpostedReason: fxRevaluations.unpostedReason,
        })
        .from(fxRevaluations)
        .where(eq(fxRevaluations.tenantId, ctx.tenant.id))
        .orderBy(desc(fxRevaluations.asOfDate)),
    );

    return {
      ok: true,
      data: rows.map((r) => ({
        id: r.id,
        asOfDate: r.asOfDate,
        functionalCurrency: r.functionalCurrency,
        status: r.status,
        gain: formatMinorPlain(r.gainMinor, r.functionalCurrency),
        loss: formatMinorPlain(r.lossMinor, r.functionalCurrency),
        net: formatMinorPlain(r.gainMinor - r.lossMinor, r.functionalCurrency),
        restatedCount: r.restatedCount,
        skippedCount: r.skippedCount,
        posted: r.transactionId !== null,
        unpostedReason: r.unpostedReason,
      })),
    };
  } catch (err) {
    return toActionError(err);
  }
}

/* ------------------------------------------------------------------ */
/* RATES                                                               */
/* ------------------------------------------------------------------ */

export type FxRateRow = {
  id: string;
  baseCurrency: string;
  quoteCurrency: string;
  rate: string;
  rateDate: string;
  source: string;
  sourceReference: string | null;
  note: string | null;
  /** True for a published reference rate: the tenant cannot edit it. */
  isPublished: boolean;
  /**
   * ⭐ WHEN THE ROW WAS LOADED, for a published rate. Null for a tenant's
   * own. Read rather than ornamental: `published_at` far later than
   * `rate_date` means the rate was BACKFILLED, and a rate backfilled after
   * the invoices it was used on is a fact worth seeing on the screen where
   * somebody is deciding whether to trust it.
   */
  publishedAt: string | null;
  /** True when the row was loaded well after the day it is for. */
  backfilled: boolean;
};

const rateListSchema = z.object({
  from: isoDate,
  to: isoDate,
});

/**
 * The tenant's own rates and the published ones, together, most recent
 * first. `isPublished` is what the UI uses to decide whether a row is
 * editable — a reference rate is a fact about the world, not a field.
 */
export async function listFxRates(
  input: z.input<typeof rateListSchema>,
): Promise<ActionResult<FxRateRow[]>> {
  try {
    const ctx = await requirePermission("fx:read");
    const range = rateListSchema.parse(input);

    const rows = await withTenant(ctx.tenant.id, async (tx) => {
      const own = await tx
        .select({
          id: fxRates.id,
          baseCurrency: fxRates.baseCurrency,
          quoteCurrency: fxRates.quoteCurrency,
          rate: fxRates.rate,
          rateDate: fxRates.rateDate,
          source: fxRates.source,
          sourceReference: fxRates.sourceReference,
          note: fxRates.note,
        })
        .from(fxRates)
        .where(
          and(
            eq(fxRates.tenantId, ctx.tenant.id),
            gte(fxRates.rateDate, range.from),
            lte(fxRates.rateDate, range.to),
          ),
        )
        .orderBy(desc(fxRates.rateDate));

      const published = await tx
        .select({
          id: fxReferenceRates.id,
          baseCurrency: fxReferenceRates.baseCurrency,
          quoteCurrency: fxReferenceRates.quoteCurrency,
          rate: fxReferenceRates.rate,
          rateDate: fxReferenceRates.rateDate,
          source: fxReferenceRates.source,
          sourceReference: fxReferenceRates.sourceReference,
          publishedAt: fxReferenceRates.publishedAt,
        })
        .from(fxReferenceRates)
        .where(
          and(
            gte(fxReferenceRates.rateDate, range.from),
            lte(fxReferenceRates.rateDate, range.to),
          ),
        )
        .orderBy(desc(fxReferenceRates.rateDate));

      /**
       * ⚠️ "BACKFILLED" IS COMPUTED, NOT STORED. More than two days
       * between the day a rate is FOR and the day it was LOADED means
       * somebody imported history — which is legitimate and is also the
       * circumstance in which a rate can appear after the invoices that
       * were measured without it.
       */
      const BACKFILL_DAYS = 2;
      return [
        ...own.map((r) => ({ ...r, isPublished: false, publishedAt: null, backfilled: false })),
        ...published.map((r) => {
          const loadedOn = r.publishedAt.toISOString().slice(0, 10);
          const lagDays = Math.round(
            (Date.parse(`${loadedOn}T00:00:00Z`) - Date.parse(`${r.rateDate}T00:00:00Z`)) /
              86_400_000,
          );
          return {
            ...r,
            note: null,
            isPublished: true,
            publishedAt: r.publishedAt.toISOString(),
            backfilled: lagDays > BACKFILL_DAYS,
          };
        }),
      ];
    });

    return { ok: true, data: rows };
  } catch (err) {
    return toActionError(err);
  }
}

const recordRateSchema = z.object({
  baseCurrency: currencyCode,
  quoteCurrency: currencyCode,
  /** ⚠️ TEXT, never a number. See `parseRateToScaled`. */
  rate: z.string().trim().min(1, "Enter the rate."),
  rateDate: isoDate,
  /**
   * ⭐⭐ WHICH SIDE OF THE SPREAD — 0106, AND THERE IS NO DEFAULT.
   *
   * 🔴 A DEFAULT HERE WOULD BE THE WHOLE DEFECT BACK AGAIN. The person
   * entering a rate is looking at the advice it came from and knows
   * whether it is the bank's buying rate, its selling rate or a mid off a
   * feed. Rule 26 computes a s.195 chargeable base from the telegraphic
   * transfer BUYING rate and from nothing else, so a field that defaulted
   * to `mid` would produce a rate that is silently ineligible, and a field
   * that defaulted to `tt_buying` would produce one that is silently
   * WRONG. 'unstated' is not offered: it records history, not a decision.
   */
  rateType: z.enum(STORABLE_FX_RATE_TYPES, {
    errorMap: () => ({
      message:
        "Say which rate this is: the telegraphic transfer buying rate, the selling rate, " +
        "or a mid rate. They are three different numbers on the same day and tax law names " +
        "one of them.",
    }),
  }),
  sourceReference: z.string().trim().max(300).optional().nullable(),
  note: z.string().trim().max(500).optional().nullable(),
});

export type RecordRateInput = z.input<typeof recordRateSchema>;

/**
 * ⭐⭐ ENTER A RATE.
 *
 * 🔴 THE AUDIT ROW CARRIES THE OLD RATE AND THE NEW ONE. A rate is an
 * input to the profit and loss account; "somebody changed a rate" is not
 * evidence, "somebody changed USD/INR on 31 March from 83.2150 to 84.9000"
 * is. `severity: "warning"` because the change is silent everywhere else.
 */
export async function recordFxRate(
  input: RecordRateInput,
): Promise<ActionResult<{ id: string; rate: string }>> {
  try {
    const ctx = await requirePermission("fx:manage_rates", { type: "fx_rate" });
    const data = recordRateSchema.parse(input);

    if (data.baseCurrency === data.quoteCurrency) {
      return fail(
        `${data.baseCurrency} to ${data.baseCurrency} is exactly 1 and is never stored. ` +
          `Storing it would create a row somebody could later edit to something else.`,
      );
    }

    const outcome = await withTenant(ctx.tenant.id, async (tx) => {
      const [previous] = await tx
        .select({ rate: fxRates.rate })
        .from(fxRates)
        .where(
          and(
            eq(fxRates.tenantId, ctx.tenant.id),
            eq(fxRates.baseCurrency, data.baseCurrency),
            eq(fxRates.quoteCurrency, data.quoteCurrency),
            eq(fxRates.rateDate, data.rateDate),
            // ⚠️ THE PREVIOUS VALUE IS THE ONE OF THE SAME TYPE. Comparing
            // a new TT buying rate against the day's mid would make every
            // first entry look like a change of half a rupee.
            eq(fxRates.rateType, data.rateType),
          ),
        )
        .limit(1);

      const saved = await recordTenantRate(tx, {
        tenantId: ctx.tenant.id,
        userId: ctx.user.id,
        baseCurrency: data.baseCurrency,
        quoteCurrency: data.quoteCurrency,
        rate: data.rate,
        rateDate: data.rateDate,
        source: "manual",
        rateType: data.rateType,
        sourceReference: data.sourceReference ?? null,
        note: data.note ?? null,
      });
      return { saved, previousRate: previous?.rate ?? null };
    });

    await writeAudit(ctx, {
      action: previousToAction(outcome.previousRate),
      resourceType: "fx_rate",
      resourceId: outcome.saved.id,
      severity: "warning",
      oldValue: outcome.previousRate ? { rate: outcome.previousRate } : undefined,
      newValue: {
        pair: `${data.baseCurrency}/${data.quoteCurrency}`,
        rateDate: data.rateDate,
        rate: formatRateScaled(outcome.saved.rateScaled),
        rateType: data.rateType,
      },
      metadata: auditMeta({
        event: "fx_rate_recorded",
        pair: `${data.baseCurrency}/${data.quoteCurrency}`,
        rateDate: data.rateDate,
        replacedAnEarlierRate: outcome.previousRate !== null,
      }),
    });

    revalidatePath("/settings/financial");
    return {
      ok: true,
      data: { id: outcome.saved.id, rate: formatRateScaled(outcome.saved.rateScaled) },
    };
  } catch (err) {
    return toActionError(err);
  }
}

function previousToAction(previous: string | null): "create" | "update" {
  return previous === null ? "create" : "update";
}

/* ------------------------------------------------------------------ */
/* EXPOSURE — a currency-labelled aggregation                          */
/* ------------------------------------------------------------------ */

export type FxExposure = {
  functionalCurrency: string;
  functionalCurrencyIsDefault: boolean;
  asOfDate: string;
  /** 🔴 EVERY SUBTOTAL CARRIES ITS CURRENCY. Never a bare number. */
  byCurrency: { currency: string; amountMinor: string; count: number; formatted: string }[];
  /** The single converted figure, WITH the rates that produced it. */
  convertedTotalMinor: string | null;
  convertedTotalFormatted: string | null;
  /** The sentence that must appear next to the converted figure. */
  basis: string;
  /** Currencies with exposure and no rate on file for `asOfDate`. */
  unconvertible: string[];
};

const exposureSchema = z.object({ asOfDate: isoDate });

/**
 * ⭐⭐⭐ OPEN RECEIVABLES, GROUPED BY CURRENCY AND THEN CONVERTED.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THIS IS THE SHAPE EVERY CURRENCY-SPANNING TOTAL IN THIS PRODUCT
 *    SHOULD HAVE, AND MOST STILL DO NOT
 * ══════════════════════════════════════════════════════════════════════
 * It returns the subtotals BY CURRENCY first, and the converted single
 * figure second, with `basis` naming every rate used and `unconvertible`
 * listing what could not be converted. A caller cannot get the one number
 * without also getting the working, and when a rate is missing the answer
 * degrades from one number to several rather than from correct to wrong.
 *
 * Compare `server/actions/reports.ts#getReceivablesAging` before this
 * batch: `coalesce(sum(outstanding_minor), 0)` with no currency anywhere.
 */
export async function getFxExposure(
  input: z.input<typeof exposureSchema>,
): Promise<ActionResult<FxExposure>> {
  try {
    const ctx = await requirePermission("fx:read");
    const { asOfDate } = exposureSchema.parse(input);
    const functional = functionalCurrencyFromSettings(ctx.tenant.settings);

    const data = await withTenant(ctx.tenant.id, async (tx) => {
      const rows = await tx
        .select({
          currency: salesInvoices.currency,
          totalMinor: salesInvoices.totalMinor,
          receivedMinor: salesInvoices.receivedMinor,
        })
        .from(salesInvoices)
        .where(
          and(
            eq(salesInvoices.tenantId, ctx.tenant.id),
            lte(salesInvoices.invoiceDate, asOfDate),
          ),
        );

      const outstanding = rows
        .map((r) => ({
          currency: normaliseCurrencyCode(r.currency),
          amountMinor: r.totalMinor - r.receivedMinor,
        }))
        .filter((r) => r.amountMinor > 0n);

      const byCurrency = sumByCurrency(outstanding);

      /**
       * ⚠️ THE RATES ARE RESOLVED ONCE PER CURRENCY AND CACHED, so
       * `convertBuckets` — which is pure and takes a synchronous
       * resolver — never has to await inside its loop.
       */
      const quotes = new Map<string, Awaited<ReturnType<typeof resolveQuote>>>();
      for (const bucket of byCurrency) {
        quotes.set(
          bucket.currency,
          await resolveQuote(tx, {
            tenantId: ctx.tenant.id,
            from: bucket.currency,
            to: functional.code,
            on: asOfDate,
            policy: CLOSING_RATE_WINDOW,
          }),
        );
      }

      const converted = convertBuckets({
        totals: byCurrency,
        to: functional.code,
        on: asOfDate,
        resolve: (from) => quotes.get(from) ?? null,
        policy: CLOSING_RATE_WINDOW,
      });

      return { byCurrency, converted };
    });

    return {
      ok: true,
      data: {
        functionalCurrency: functional.code,
        functionalCurrencyIsDefault: functional.isDefault,
        asOfDate,
        byCurrency: data.byCurrency.map((b) => ({
          currency: b.currency,
          amountMinor: b.amountMinor.toString(),
          count: b.count,
          formatted: `${b.currency} ${formatMinorPlain(b.amountMinor, b.currency)}`,
        })),
        convertedTotalMinor: data.converted.complete
          ? data.converted.totalMinor.toString()
          : null,
        convertedTotalFormatted: data.converted.complete
          ? `${functional.code} ${formatMinorPlain(data.converted.totalMinor, functional.code)}`
          : null,
        basis: describeConvertedTotal(data.converted),
        unconvertible: data.converted.unconverted.map((u) => u.currency),
      },
    };
  } catch (err) {
    return toActionError(err);
  }
}

/* ------------------------------------------------------------------ */
/* THE RESTATEMENT                                                     */
/* ------------------------------------------------------------------ */

const revalueSchema = z.object({
  asOfDate: isoDate,
  note: z.string().trim().max(500).optional().nullable(),
});

export type RunRevaluationInput = z.input<typeof revalueSchema>;

export type RevaluationSummary = {
  revaluationId: string;
  asOfDate: string;
  functionalCurrency: string;
  gain: string;
  loss: string;
  net: string;
  restatedCount: number;
  skippedCount: number;
  posted: boolean;
  unpostedReason: string | null;
  missingRates: string[];
};

/**
 * ⭐⭐⭐ RUN THE REPORTING-DATE RESTATEMENT.
 *
 * 🔴 THE FUNCTIONAL CURRENCY IS READ FROM `tenants.settings.currency` AND
 * FROZEN ONTO THE RUN. That column is one of the sixteen this batch was
 * written about, and this is the computation that reads it.
 */
export async function runFxRevaluation(
  input: RunRevaluationInput,
): Promise<ActionResult<RevaluationSummary>> {
  try {
    const ctx = await requirePermission("fx:revalue", { type: "fx_revaluation" });
    const data = revalueSchema.parse(input);
    const functional = functionalCurrencyFromSettings(ctx.tenant.settings);

    const outcome = await withTenant(ctx.tenant.id, (tx) =>
      runRevaluation(tx, {
        tenantId: ctx.tenant.id,
        userId: ctx.user.id,
        asOfDate: data.asOfDate,
        functionalCurrency: functional.code,
        note: data.note ?? null,
      }),
    );

    await writeAudit(ctx, {
      action: "create",
      resourceType: "fx_revaluation",
      resourceId: outcome.revaluationId,
      severity: "warning",
      newValue: {
        asOfDate: outcome.asOfDate,
        functionalCurrency: outcome.functionalCurrency,
        gainMinor: outcome.gainMinor.toString(),
        lossMinor: outcome.lossMinor.toString(),
        posted: outcome.posted,
      },
      metadata: auditMeta({
        event: "fx_revaluation_run",
        restatedCount: outcome.restatedCount,
        skippedCount: outcome.skippedCount,
        missingRates: outcome.missingRates.join(", "),
      }),
    });

    revalidatePath("/accounting");
    const net = outcome.gainMinor - outcome.lossMinor;
    return {
      ok: true,
      data: {
        revaluationId: outcome.revaluationId,
        asOfDate: outcome.asOfDate,
        functionalCurrency: outcome.functionalCurrency,
        gain: formatMinorPlain(outcome.gainMinor, outcome.functionalCurrency),
        loss: formatMinorPlain(outcome.lossMinor, outcome.functionalCurrency),
        net: formatMinorPlain(net, outcome.functionalCurrency),
        restatedCount: outcome.restatedCount,
        skippedCount: outcome.skippedCount,
        posted: outcome.posted,
        unpostedReason: outcome.unpostedReason,
        missingRates: outcome.missingRates,
      },
    };
  } catch (err) {
    return toActionError(err);
  }
}

export type RevaluationLineRow = {
  itemKind: string;
  isMonetaryItem: boolean;
  sourceReference: string | null;
  foreignCurrency: string;
  foreignAmount: string;
  carrying: string;
  restatedTo: string;
  plEffect: string;
  rate: string | null;
  rateDate: string | null;
  rateSource: string | null;
  rateDerived: boolean;
  restated: boolean;
  skipReason: string | null;
};

/**
 * ⭐ THE WORKING, LINE BY LINE — INCLUDING THE ITEMS NOT RESTATED.
 *
 * 🔴 THE SKIPPED LINES ARE THE POINT. An auditor asking "why was the
 * machinery not revalued" gets AS 11 ¶11(b) in a sentence, on the row,
 * rather than having to infer the policy from an absence.
 */
export async function getRevaluationLines(
  revaluationId: string,
): Promise<ActionResult<{ functionalCurrency: string; lines: RevaluationLineRow[] }>> {
  try {
    const ctx = await requirePermission("fx:read", { type: "fx_revaluation", id: revaluationId });
    const parsed = z.string().uuid("That is not a revaluation.").parse(revaluationId);

    const data = await withTenant(ctx.tenant.id, async (tx) => {
      const [run] = await tx
        .select({ functionalCurrency: fxRevaluations.functionalCurrency })
        .from(fxRevaluations)
        .where(
          and(eq(fxRevaluations.tenantId, ctx.tenant.id), eq(fxRevaluations.id, parsed)),
        )
        .limit(1);
      if (!run) return null;

      const lines = await tx
        .select()
        .from(fxRevaluationLines)
        .where(
          and(
            eq(fxRevaluationLines.tenantId, ctx.tenant.id),
            eq(fxRevaluationLines.revaluationId, parsed),
          ),
        )
        .orderBy(fxRevaluationLines.sourceTable, fxRevaluationLines.sourceReference);

      return { functionalCurrency: run.functionalCurrency, lines };
    });

    if (!data) return fail("That revaluation does not exist in this workspace.");

    return {
      ok: true,
      data: {
        functionalCurrency: data.functionalCurrency,
        lines: data.lines.map((l) => ({
          itemKind: l.itemKind,
          isMonetaryItem: l.isMonetaryItem,
          sourceReference: l.sourceReference,
          foreignCurrency: l.foreignCurrency,
          foreignAmount: formatMinorPlain(l.foreignAmountMinor, l.foreignCurrency),
          carrying: formatMinorPlain(l.carryingFunctionalMinor, data.functionalCurrency),
          restatedTo: formatMinorPlain(l.restatedFunctionalMinor, data.functionalCurrency),
          plEffect: formatMinorPlain(l.plEffectMinor, data.functionalCurrency),
          rate: l.rate,
          rateDate: l.rateDate,
          rateSource: l.rateSource,
          rateDerived: l.rateDerived,
          restated: l.restated,
          skipReason: l.skipReason,
        })),
      },
    };
  } catch (err) {
    return toActionError(err);
  }
}

/* ------------------------------------------------------------------ */
/* THE EXPONENT TABLE, CHECKED                                         */
/* ------------------------------------------------------------------ */

/**
 * 🔴 THE DUPLICATE, SURFACED. `currency_units` in the database and
 * `lib/fx/currency.ts` in the engine hold the same fact for two
 * consumers. A divergence changes what a hand-written SQL report prints
 * and nothing else, so nobody would find out from the application — which
 * is exactly why it is on a screen.
 */
export async function checkCurrencyUnits(): Promise<
  ActionResult<{ divergences: CurrencyUnitsDivergence[]; agree: boolean }>
> {
  try {
    const ctx = await requirePermission("fx:read");
    const divergences = await withTenant(ctx.tenant.id, (tx) => verifyCurrencyUnits(tx));
    return { ok: true, data: { divergences, agree: divergences.length === 0 } };
  } catch (err) {
    return toActionError(err);
  }
}

/**
 * ⭐ WHAT RATE WOULD THIS CONVERSION USE, AND WHERE DID IT COME FROM.
 *
 * ⚠️ A PREVIEW, AND IT SAYS SO. It resolves the rate exactly as a posting
 * would, so the person entering a foreign-currency invoice can see the
 * figure and its source BEFORE committing to it — rather than discovering
 * at the trial balance which rate the system picked.
 */
export type ConversionPreview = {
  found: boolean;
  description: string | null;
  rate: string | null;
  /**
   * ⭐ THE THREE THINGS THAT MAKE THE NUMBER A RATE, RETURNED SEPARATELY
   * SO THE SCREEN DOES NOT HAVE TO READ THEM OUT OF A SENTENCE.
   * `derived` is true when the quote was obtained by inverting a pair
   * published the other way round — the screen says so.
   */
  pair: string | null;
  rateDate: string | null;
  source: string | null;
  derived: boolean;
};

export async function previewConversion(input: {
  from: string;
  to: string;
  on: string;
}): Promise<ActionResult<ConversionPreview>> {
  try {
    const ctx = await requirePermission("fx:read");
    const parsed = z
      .object({ from: currencyCode, to: currencyCode, on: isoDate })
      .parse(input);

    const quote = await withTenant(ctx.tenant.id, (tx) =>
      resolveQuote(tx, {
        tenantId: ctx.tenant.id,
        from: parsed.from,
        to: parsed.to,
        on: parsed.on,
        policy: CLOSING_RATE_WINDOW,
      }),
    );

    if (!quote) {
      return {
        ok: true,
        data: {
          found: false,
          description: null,
          rate: null,
          pair: null,
          rateDate: null,
          source: null,
          derived: false,
        },
      };
    }
    return {
      ok: true,
      data: {
        found: true,
        description: describeQuote(quote),
        rate: formatRateScaled(quote.rateScaled),
        pair: `${quote.baseCurrency}/${quote.quoteCurrency}`,
        rateDate: quote.rateDate,
        source: quote.source,
        derived: quote.derived,
      },
    };
  } catch (err) {
    return toActionError(err);
  }
}

/**
 * ⚠️ EXPORTED SO A FORM CAN VALIDATE A TYPED RATE BEFORE SUBMITTING IT,
 * using the SAME parser the write path uses. A second, looser validation
 * on the client is how "the form accepted it and the server refused it"
 * happens.
 */
export async function validateRateText(
  rate: string,
): Promise<ActionResult<{ normalised: string }>> {
  try {
    await requirePermission("fx:read");
    return { ok: true, data: { normalised: formatRateScaled(parseRateToScaled(rate)) } };
  } catch (err) {
    return toActionError(err);
  }
}

/* ------------------------------------------------------------------ */
/* POSTING A RUN — DELIBERATELY NOT PART OF RUNNING IT                 */
/* ------------------------------------------------------------------ */

export type PostRevaluationResult = {
  revaluationId: string;
  posted: boolean;
  /** Why it did not reach the ledger, when it did not. */
  reason: string | null;
};

/**
 * ⭐⭐ PUT A COMPUTED RESTATEMENT INTO THE LEDGER, AS ITS OWN ACT.
 *
 * 🔴 RUNNING AND POSTING ARE TWO DECISIONS AND THIS IS THE SECOND ONE.
 * `runFxRevaluation` computes the working and records every line,
 * including the ones it did not restate, and it attempts the journal.
 * When the attempt is refused — no `fx_gain` / `fx_loss` ledger mapped,
 * or the reporting date falls in a closed period — the run survives as a
 * draft with `unposted_reason` saying which, and the sentence it stores
 * ends "…and post the run". This is that action.
 *
 * ⚠️ IT IS IDEMPOTENT BECAUSE THE JOURNAL IS KEYED. `writeFxPosting`
 * looks for a transaction numbered from the revaluation id and answers
 * `already_posted` rather than writing a second one, so a double click
 * cannot double-count an exchange difference.
 *
 * ⚠️ THE PER-ITEM CONTROL LEDGER IS NOT PERSISTED ON THE LINE, so the
 * legs rebuilt here carry no `ledgerIdOverride` and the contra falls to
 * the role mapping — which is the same mapping whose absence refused the
 * run's own attempt in the first place. Nothing is guessed: an unmapped
 * role is refused again, with the roles named.
 */
export async function postFxRevaluationRun(
  revaluationId: string,
): Promise<ActionResult<PostRevaluationResult>> {
  try {
    const ctx = await requirePermission("fx:revalue", {
      type: "fx_revaluation",
      id: revaluationId,
    });
    const parsed = z.string().uuid("That is not a revaluation.").parse(revaluationId);

    const outcome = await withTenant(ctx.tenant.id, async (tx) => {
      const [run] = await tx
        .select({
          id: fxRevaluations.id,
          asOfDate: fxRevaluations.asOfDate,
          functionalCurrency: fxRevaluations.functionalCurrency,
          status: fxRevaluations.status,
          transactionId: fxRevaluations.transactionId,
        })
        .from(fxRevaluations)
        .where(and(eq(fxRevaluations.tenantId, ctx.tenant.id), eq(fxRevaluations.id, parsed)))
        .limit(1);

      if (!run) return { kind: "missing" as const };
      if (run.transactionId !== null) return { kind: "already" as const };
      if (run.status === "void") return { kind: "void" as const };

      const lines = await tx
        .select({
          itemKind: fxRevaluationLines.itemKind,
          plEffectMinor: fxRevaluationLines.plEffectMinor,
          sourceReference: fxRevaluationLines.sourceReference,
          foreignCurrency: fxRevaluationLines.foreignCurrency,
          foreignAmountMinor: fxRevaluationLines.foreignAmountMinor,
          rate: fxRevaluationLines.rate,
          restated: fxRevaluationLines.restated,
        })
        .from(fxRevaluationLines)
        .where(
          and(
            eq(fxRevaluationLines.tenantId, ctx.tenant.id),
            eq(fxRevaluationLines.revaluationId, parsed),
          ),
        );

      const items = lines
        .filter((l) => l.restated && l.plEffectMinor !== 0n)
        .map((l) => ({
          kind: l.itemKind,
          plEffectMinor: l.plEffectMinor,
          contraLedgerId: null,
          description:
            `${l.sourceReference ?? l.itemKind}: ${l.foreignCurrency} ` +
            `${formatMinorPlain(l.foreignAmountMinor, l.foreignCurrency)} restated at ` +
            `${l.rate ?? "no rate"}`,
        }));

      if (items.length === 0) return { kind: "nothing" as const };

      const legs: FxLeg[] = buildFxRevaluationPosting({ items, asOfDate: run.asOfDate });
      const written = await writeFxRevaluationJournal(tx, {
        tenantId: ctx.tenant.id,
        userId: ctx.user.id,
        revaluationId: run.id,
        asOfDate: run.asOfDate,
        functionalCurrency: run.functionalCurrency,
        legs,
      });

      if (!written.posted) return { kind: "refused" as const, outcome: written };

      await tx
        .update(fxRevaluations)
        .set({
          status: "posted",
          transactionId: written.transactionId,
          postedAt: new Date(),
          unpostedReason: null,
        })
        .where(and(eq(fxRevaluations.tenantId, ctx.tenant.id), eq(fxRevaluations.id, parsed)));

      return { kind: "posted" as const, transactionId: written.transactionId };
    });

    if (outcome.kind === "missing") {
      return fail("That revaluation does not exist in this workspace.");
    }
    if (outcome.kind === "void") {
      return fail("That revaluation has been voided. Run the reporting date again.");
    }
    if (outcome.kind === "already") {
      return fail(
        "That revaluation is already in the ledger. Posting it again would double-count the " +
          "exchange difference.",
      );
    }
    if (outcome.kind === "nothing") {
      return fail(
        "Nothing to post: no monetary item's closing rate differed from the rate it was " +
          "carried at, so there is no exchange difference to book.",
      );
    }
    if (outcome.kind === "refused") {
      const reason =
        outcome.outcome.reason === "unmapped_roles"
          ? `Not posted: no ledger is mapped for ${outcome.outcome.missing.join(", ")}. ` +
            `Map them on the posting-accounts screen, then post the run.`
          : outcome.outcome.reason === "period_closed"
            ? `Not posted: that reporting date falls in ${outcome.outcome.period}, which is closed.`
            : outcome.outcome.reason === "already_posted"
              ? "A journal already exists for this revaluation."
              : "Nothing to post.";
      return fail(reason);
    }

    await writeAudit(ctx, {
      action: "update",
      resourceType: "fx_revaluation",
      resourceId: parsed,
      severity: "warning",
      newValue: { posted: true, transactionId: outcome.transactionId },
      metadata: auditMeta({
        event: "fx_revaluation_posted",
        revaluationId: parsed,
      }),
    });

    revalidatePath("/fx");
    revalidatePath("/accounting");
    return { ok: true, data: { revaluationId: parsed, posted: true, reason: null } };
  } catch (err) {
    return toActionError(err);
  }
}
