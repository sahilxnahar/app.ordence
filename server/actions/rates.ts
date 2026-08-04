"use server";

/**
 * Ordence — ⭐ ENGINE 2 · RATE CARDS & PRICING ACTIONS
 * Version: v0.62.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION. A `"use server"` file that exports
 * anything else — a constant, a type guard, a Zod schema — publishes it as
 * an RPC endpoint reachable by anyone on the internet. The helpers below
 * are deliberately not exported.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THIS FILE DOES NOT VALIDATE SLAB CONTIGUITY. THAT IS DELIBERATE.
 * ══════════════════════════════════════════════════════════════════════
 * The rule — bands numbered 1,2,3 with no gaps, upper limits strictly
 * increasing, at most one open-ended band and it must be last — is about
 * the SET of slabs, not about any one row. It lives in SQL-FILES/0034 as
 * a DEFERRABLE INITIALLY DEFERRED constraint trigger, judged at COMMIT.
 *
 * ⚠️ RE-IMPLEMENTING IT HERE WOULD BE WORSE THAN USELESS. Two copies of a
 * set-level rule drift, and the direction they drift in is always the same:
 * the TypeScript accepts something the database then refuses, at commit,
 * after the operator has typed four bands. What this file does instead is
 * TRANSLATE the refusal — see `explainRateError`. The trigger's messages
 * are already written for a person ("slab 2 ends at 100 but the slab
 * before it already ended at 300"), so most of the work is passing them
 * through instead of flattening them into "Something went wrong".
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ SLABS AND ADJUSTMENTS ARE REPLACED WHOLESALE, NEVER PATCHED
 * ══════════════════════════════════════════════════════════════════════
 * `saveRateSlabs` deletes every band on the card and inserts the new set,
 * inside one transaction. That looks heavy-handed until you try the
 * alternative: deleting band 2 of 4 leaves sequences 1,3,4 — a gap the
 * trigger refuses — so a "delete one band" endpoint can only ever succeed
 * by renumbering the survivors anyway. Doing it in one statement pair
 * means the deferred trigger sees exactly one state: the final one.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ MONEY LEAVES THIS FILE AS A STRING
 * ══════════════════════════════════════════════════════════════════════
 * Every amount is `bigint` paise in the database and in the arithmetic.
 * `JSON.stringify` throws on a bigint, and a server action's return value
 * is serialised — so a single un-stringified `bigint` anywhere in a
 * payload takes down the whole page with "Do not know how to serialize a
 * BigInt", nowhere near the column that caused it.
 */

import { and, asc, desc, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenant } from "@/db";
import {
  rateCards,
  rateSlabs,
  rateAdjustments,
  rateQuotes,
  RATE_SCOPE_PRIORITY,
} from "@/db/schema/pricing";
import { companies } from "@/db/schema/crm";
import { requirePermission, writeAudit } from "@/server/audit";
import { guardSalesWrite, toSalesActionError } from "@/server/sales/guards";
import type { ActionResult } from "@/lib/validators/crm";

/** ⚠️ Exactly this string. It is the key in lib/modules/registry.ts. */
const FEATURE = "rates.cards" as const;

const READ_PERMISSION = "rates.cards.read";
const WRITE_PERMISSION = "rates.cards.manage";

/* ------------------------------------------------------------------ */
/* SHAPES — everything monetary is a string. See the header.           */
/* ------------------------------------------------------------------ */

export type RateSlabRow = {
  id: string;
  rateCardId: string;
  sequence: number;
  /** Exclusive upper bound. `null` is the final, unbounded band. */
  upToQuantity: string | null;
  unitAmountMinor: string;
  fixedAmountMinor: string;
  label: string | null;
};

export type RateAdjustmentRow = {
  id: string;
  rateCardId: string;
  sequence: number;
  label: string;
  /** Positive is a surcharge, negative a discount. */
  percentageBps: number;
  fixedAmountMinor: string;
  isVisible: boolean;
  isStatutory: boolean;
};

export type RateCardRow = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  scope: string;
  slabMode: string;
  basis: string;
  priority: number;
  appliesToKind: string | null;
  appliesToId: string | null;
  customerCompanyId: string | null;
  customerName: string | null;
  channel: string | null;
  validFrom: string | null;
  validTo: string | null;
  daysOfWeek: string | null;
  currency: string;
  baseAmountMinor: string;
  taxRateBps: number;
  isTaxInclusive: boolean;
  isActive: boolean;

  slabCount: number;
  adjustmentCount: number;
  quoteCount: number;

  /**
   * ⭐ The rank this card's scope carries when several cards match one
   * set of facts. Mirrors the CASE in `v_rate_card_candidates`.
   */
  scopeRank: number;

  /* --- The three silent failures. See `listRateCards`. -------------- */
  /** Banded pricing declared, no bands stored. The mode does nothing. */
  bandsDeclaredButAbsent: boolean;
  /** Validity window closed, card still switched on. */
  expiredButActive: boolean;
  /** No bands and a zero base — every quantity prices at ₹0.00. */
  pricesEverythingAtZero: boolean;
};

export type RateQuoteRow = {
  id: string;
  rateCardId: string;
  cardCode: string;
  cardName: string;
  quantity: string;
  subtotalMinor: string;
  adjustmentsMinor: string;
  taxMinor: string;
  totalMinor: string;
  selectionReason: string | null;
  quotedFor: string | null;
  quotedAt: string;
};

export type RateCustomerOption = { id: string; name: string };

export type QuoteBreakdownLine = Record<string, unknown>;

export type RateQuoteResult = {
  rateCardId: string;
  quantity: string;
  subtotalMinor: string;
  adjustmentsMinor: string;
  taxMinor: string;
  totalMinor: string;
  breakdown: QuoteBreakdownLine[];
};

/* ------------------------------------------------------------------ */
/* HELPERS — not exported. See the header.                             */
/* ------------------------------------------------------------------ */

function minor(v: bigint | number | string | null | undefined): string {
  if (v === null || v === undefined) return "0";
  return String(v);
}

function nullableMinor(v: bigint | number | string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return String(v);
}

function isoDate(v: string | Date | null | undefined): string | null {
  if (!v) return null;
  return typeof v === "string" ? v.slice(0, 10) : v.toISOString().slice(0, 10);
}

/**
 * ⭐ TURN THE DATABASE'S REFUSAL INTO A SENTENCE SOMEBODY CAN ACT ON.
 *
 * ⚠️ THE QUALITY OF THIS FUNCTION IS THE QUALITY OF THE FEATURE, for the
 * same reason it is in `explainScheduleError`: the contiguity rule is
 * enforced nowhere else, so the trigger's "no" is the only "no" there is.
 * A pricing manager told "P0001" opens a support ticket. Told "slab 3 ends
 * at 200 but the slab before it already ended at 300", they fix the row
 * they are looking at.
 *
 * ⚠️ THESE ARE `RAISE EXCEPTION` MESSAGES, WHICH ARRIVE AS SQLSTATE P0001
 * — not as 23514 — so `toSalesActionError` does not see them as a check
 * violation and would flatten them. They are matched here, ahead of it.
 *
 * ⚠️ AND THE CONTIGUITY ONES SURFACE AT COMMIT, NOT AT THE STATEMENT. The
 * trigger is DEFERRABLE INITIALLY DEFERRED, so the throw comes out of
 * `withTenant`'s transaction boundary rather than out of the `insert`
 * call. Catching per-statement would miss every one of them.
 */
function explainRateError(err: unknown): string | null {
  const message =
    err && typeof err === "object" && "message" in err
      ? String((err as { message: unknown }).message)
      : "";
  const code =
    err && typeof err === "object" && "code" in err
      ? String((err as { code: unknown }).code)
      : "";
  const constraint =
    err && typeof err === "object" && "constraint" in err
      ? String((err as { constraint: unknown }).constraint)
      : "";

  /* --- The contiguity trigger. Already written for a person. ------- */
  if (/is declared slab_mode = 'none' but has \d+ slab/.test(message)) return message;
  if (/has \d+ open-ended slabs/.test(message)) return message;
  if (/has a gap in its slab order/.test(message)) return message;
  if (/has no upper limit but is not the last slab/.test(message)) return message;
  if (/but the slab before it already ended at/.test(message)) return message;

  /* --- The quote append-only trigger. ------------------------------ */
  if (/Quotes cannot be \w+ once recorded/.test(message)) return message;

  /* --- The pricing functions. -------------------------------------- */
  if (/does not exist in this workspace/.test(message)) return message;
  if (/Quantity cannot be negative/.test(message)) return message;
  if (/Division by zero in rate arithmetic/.test(message)) {
    return (
      "The rate arithmetic divided by zero. This is a defect, not a data " +
      "problem — report it rather than editing the card around it."
    );
  }

  /* --- Row-level CHECKs, which arrive as 23514 with a constraint. --- */
  if (constraint.includes("rate_cards_validity_ordered")) {
    return (
      "The validity window ends on or before it starts. Note that the end " +
      "date is EXCLUSIVE — a card for the whole of March runs from 2026-03-01 " +
      "to 2026-04-01, not to 2026-03-31."
    );
  }
  if (constraint.includes("rate_cards_tax_sane")) {
    return "The tax rate must be between 0 and 10000 basis points — 1800 is 18%.";
  }
  if (constraint.includes("rate_slabs_up_to_positive")) {
    return (
      "A band's upper limit must be above zero. Leave it empty for the final, " +
      "open-ended band instead of entering 0."
    );
  }
  if (constraint.includes("rate_slabs_amount_non_negative")) {
    return (
      "A band cannot have a negative rate or a negative fixed charge. A " +
      "discount belongs in an adjustment, where it is visible on the invoice."
    );
  }

  /* --- Uniqueness and referential refusals. ------------------------ */
  if (code === "23505" && constraint.includes("rate_cards_code_key")) {
    return (
      "A rate card with that code already exists in this workspace. Codes are " +
      "how a card is named on an invoice, so two cannot share one."
    );
  }
  if (code === "23505" && constraint.includes("rate_slabs_sequence_key")) {
    return "Two bands claim the same position. Number them 1, 2, 3 … once each.";
  }
  if (code === "23505" && constraint.includes("rate_adjustments_sequence_key")) {
    return (
      "Two adjustments claim the same position. Order is load-bearing here — " +
      "10% off then 18% tax is not the same number as 18% tax then 10% off — " +
      "so each one needs its own place in the sequence."
    );
  }
  if (code === "23503" && constraint.includes("rate_quotes_card_tenant_fk")) {
    return (
      "This card has quotes recorded against it, and a quote is evidence of " +
      "what was offered on a date. Retire the card instead — switch it off, " +
      "which stops it being selected without erasing the conversation."
    );
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* READ                                                               */
/* ------------------------------------------------------------------ */

/**
 * ⭐ Every card, its bands, its adjustments, and what is wrong with it.
 *
 * ⚠️ THE THREE ALARMS BELOW ARE COMPUTED HERE, NOT LEFT TO THE EYE.
 * Each one is a card that prices SUCCESSFULLY and wrongly — no error, no
 * exception, a plausible number on an invoice:
 *
 *   1. `bandsDeclaredButAbsent` — a card set to progressive or flat with
 *      no bands stored prices everything from `base_amount_minor`. The
 *      mode somebody chose is doing nothing. (The mirror image — bands
 *      present, mode 'none' — cannot happen; the trigger refuses it at
 *      write time, which is why it is not in this list.)
 *   2. `expiredButActive` — the validity window closed last quarter and
 *      the switch is still on. The selection function will not pick it,
 *      so the effect is a rate that silently stops applying while the
 *      screen still lists it as live: somebody quotes from a card the
 *      billing run ignores.
 *   3. `pricesEverythingAtZero` — no bands and a zero base. Ten thousand
 *      units, ₹0.00, and nothing to indicate the card was never finished.
 */
export async function listRateCards(): Promise<
  ActionResult<{
    cards: RateCardRow[];
    slabs: RateSlabRow[];
    adjustments: RateAdjustmentRow[];
    quotes: RateQuoteRow[];
    customers: RateCustomerOption[];
    /** Cards whose bands are ignored at billing time. */
    bandsIgnored: RateCardRow[];
    /** Cards past their validity window but still switched on. */
    expiredButActive: RateCardRow[];
    /** Cards that price every quantity at zero. */
    zeroPriced: RateCardRow[];
  }>
> {
  try {
    const ctx = await requirePermission(READ_PERMISSION);

    const payload = await withTenant(ctx.tenant.id, async (tx) => {
      const cards = await tx
        .select({
          id: rateCards.id,
          code: rateCards.code,
          name: rateCards.name,
          description: rateCards.description,
          scope: rateCards.scope,
          slabMode: rateCards.slabMode,
          basis: rateCards.basis,
          priority: rateCards.priority,
          appliesToKind: rateCards.appliesToKind,
          appliesToId: rateCards.appliesToId,
          customerCompanyId: rateCards.customerCompanyId,
          channel: rateCards.channel,
          validFrom: rateCards.validFrom,
          validTo: rateCards.validTo,
          daysOfWeek: rateCards.daysOfWeek,
          currency: rateCards.currency,
          baseAmountMinor: rateCards.baseAmountMinor,
          taxRateBps: rateCards.taxRateBps,
          isTaxInclusive: rateCards.isTaxInclusive,
          isActive: rateCards.isActive,
          customerName: companies.name,
        })
        .from(rateCards)
        // ⚠️ LEFT join: most cards belong to nobody in particular. An
        // inner join here would hide every list and seasonal rate.
        .leftJoin(
          companies,
          and(
            eq(companies.id, rateCards.customerCompanyId),
            eq(companies.tenantId, rateCards.tenantId),
          ),
        )
        .where(
          and(
            eq(rateCards.tenantId, ctx.tenant.id),
            sql`${rateCards.deletedAt} IS NULL`,
          ),
        )
        .orderBy(desc(rateCards.priority), asc(rateCards.code))
        .limit(500);

      const slabs = await tx
        .select()
        .from(rateSlabs)
        .where(eq(rateSlabs.tenantId, ctx.tenant.id))
        .orderBy(asc(rateSlabs.rateCardId), asc(rateSlabs.sequence))
        .limit(5000);

      const adjustments = await tx
        .select()
        .from(rateAdjustments)
        .where(eq(rateAdjustments.tenantId, ctx.tenant.id))
        .orderBy(asc(rateAdjustments.rateCardId), asc(rateAdjustments.sequence))
        .limit(5000);

      const quotes = await tx
        .select({
          id: rateQuotes.id,
          rateCardId: rateQuotes.rateCardId,
          quantity: rateQuotes.quantity,
          subtotalMinor: rateQuotes.subtotalMinor,
          adjustmentsMinor: rateQuotes.adjustmentsMinor,
          taxMinor: rateQuotes.taxMinor,
          totalMinor: rateQuotes.totalMinor,
          selectionReason: rateQuotes.selectionReason,
          quotedFor: rateQuotes.quotedFor,
          quotedAt: rateQuotes.quotedAt,
          cardCode: rateCards.code,
          cardName: rateCards.name,
        })
        .from(rateQuotes)
        .innerJoin(
          rateCards,
          and(
            eq(rateCards.id, rateQuotes.rateCardId),
            eq(rateCards.tenantId, rateQuotes.tenantId),
          ),
        )
        .where(eq(rateQuotes.tenantId, ctx.tenant.id))
        .orderBy(desc(rateQuotes.quotedAt))
        .limit(200);

      const customerRows = await tx
        .select({ id: companies.id, name: companies.name })
        .from(companies)
        .where(
          and(
            eq(companies.tenantId, ctx.tenant.id),
            sql`${companies.deletedAt} IS NULL`,
          ),
        )
        .orderBy(asc(companies.name))
        .limit(500);

      return { cards, slabs, adjustments, quotes, customerRows };
    });

    const slabRows: RateSlabRow[] = payload.slabs.map((s) => ({
      id: s.id,
      rateCardId: s.rateCardId,
      sequence: s.sequence,
      upToQuantity: nullableMinor(s.upToQuantity),
      unitAmountMinor: minor(s.unitAmountMinor),
      fixedAmountMinor: minor(s.fixedAmountMinor),
      label: s.label,
    }));

    const adjustmentRows: RateAdjustmentRow[] = payload.adjustments.map((a) => ({
      id: a.id,
      rateCardId: a.rateCardId,
      sequence: a.sequence,
      label: a.label,
      percentageBps: a.percentageBps,
      fixedAmountMinor: minor(a.fixedAmountMinor),
      isVisible: a.isVisible,
      isStatutory: a.isStatutory,
    }));

    const quoteRows: RateQuoteRow[] = payload.quotes.map((q) => ({
      id: q.id,
      rateCardId: q.rateCardId,
      cardCode: q.cardCode,
      cardName: q.cardName,
      quantity: minor(q.quantity),
      subtotalMinor: minor(q.subtotalMinor),
      adjustmentsMinor: minor(q.adjustmentsMinor),
      taxMinor: minor(q.taxMinor),
      totalMinor: minor(q.totalMinor),
      selectionReason: q.selectionReason,
      quotedFor: q.quotedFor,
      quotedAt:
        q.quotedAt instanceof Date ? q.quotedAt.toISOString() : String(q.quotedAt),
    }));

    /**
     * ⚠️ COMPARED AGAINST TODAY IN UTC, WHICH IS WHAT THE DATABASE
     * COMPARES `valid_to` AGAINST. Using the browser's local midnight
     * here would light the "expired" alarm a few hours early or late for
     * anyone east of Greenwich — on a screen whose entire purpose is to
     * be trusted about dates.
     */
    const today = new Date().toISOString().slice(0, 10);

    const cardRows: RateCardRow[] = payload.cards.map((c) => {
      const slabCount = slabRows.filter((s) => s.rateCardId === c.id).length;
      const banded = c.slabMode === "progressive" || c.slabMode === "flat";
      const validTo = isoDate(c.validTo);
      const baseIsZero = BigInt(minor(c.baseAmountMinor)) === 0n;

      return {
        id: c.id,
        code: c.code,
        name: c.name,
        description: c.description,
        scope: c.scope,
        slabMode: c.slabMode,
        basis: c.basis,
        priority: c.priority,
        appliesToKind: c.appliesToKind,
        appliesToId: c.appliesToId,
        customerCompanyId: c.customerCompanyId,
        customerName: c.customerName,
        channel: c.channel,
        validFrom: isoDate(c.validFrom),
        validTo,
        daysOfWeek: c.daysOfWeek,
        currency: c.currency,
        baseAmountMinor: minor(c.baseAmountMinor),
        taxRateBps: c.taxRateBps,
        isTaxInclusive: c.isTaxInclusive,
        isActive: c.isActive,
        slabCount,
        adjustmentCount: adjustmentRows.filter((a) => a.rateCardId === c.id).length,
        quoteCount: quoteRows.filter((q) => q.rateCardId === c.id).length,
        scopeRank:
          RATE_SCOPE_PRIORITY[c.scope as keyof typeof RATE_SCOPE_PRIORITY] ?? 0,

        bandsDeclaredButAbsent: banded && slabCount === 0,
        // ⚠️ `valid_to` IS EXCLUSIVE — a card ending 2026-04-01 is dead ON
        // 2026-04-01, not after it. `<=` is the correct comparison.
        expiredButActive: c.isActive && validTo !== null && validTo <= today,
        pricesEverythingAtZero: slabCount === 0 && baseIsZero,
      };
    });

    return {
      ok: true,
      data: {
        cards: cardRows,
        slabs: slabRows,
        adjustments: adjustmentRows,
        quotes: quoteRows,
        customers: payload.customerRows.map((r) => ({ id: r.id, name: r.name })),
        bandsIgnored: cardRows.filter((c) => c.bandsDeclaredButAbsent),
        expiredButActive: cardRows.filter((c) => c.expiredButActive),
        zeroPriced: cardRows.filter((c) => c.pricesEverythingAtZero),
      },
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "The rate cards could not be read.",
    };
  }
}

/* ------------------------------------------------------------------ */
/* WRITE — RATE CARDS                                                  */
/* ------------------------------------------------------------------ */

/** A whole number of paise, as typed. Kept a string until the last moment. */
const paise = z
  .string()
  .trim()
  .regex(/^-?\d{1,18}$/, "Enter a whole amount in paise, digits only.");

const optionalUuid = z
  .union([z.string().uuid("That is not a valid reference."), z.literal(""), z.null()])
  .optional()
  .transform((v) => (v ? v : null));

const optionalDate = z
  .union([
    z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-04-01."),
    z.literal(""),
    z.null(),
  ])
  .optional()
  .transform((v) => (v ? v : null));

const optionalText = (max: number) =>
  z
    .union([z.string().trim().max(max), z.null()])
    .optional()
    .transform((v) => (v ? v : null));

const cardSchema = z
  .object({
    id: z.string().uuid().optional(),
    code: z.string().trim().min(1, "Give the card a short code.").max(80),
    name: z.string().trim().min(1, "Name the card.").max(200),
    description: optionalText(2000),

    /**
     * ⚠️ SCOPE IS NOT DECORATION — it decides which card wins when four of
     * them legitimately match one booking. `contracted` outranks
     * `promotional` outranks `segment` outranks `channel` outranks
     * `seasonal` outranks `list`, and the ranks are asserted equal to the
     * SQL view's CASE by the test suite.
     */
    scope: z.enum([
      "list",
      "seasonal",
      "channel",
      "segment",
      "contracted",
      "promotional",
    ]),

    /**
     * ⭐ REQUIRED, AND THERE IS NO `.default()` ON THIS LINE ON PURPOSE.
     *
     * ⚠️ "First 100 units at ₹4.50, next 200 at ₹6.20" costs ₹1,380 read
     * progressively and ₹1,550 read flat, for 250 units. Both readings are
     * in daily commercial use — Indian electricity tariffs and income tax
     * are progressive, most freight rates and volume discounts are flat.
     * A default here would be right for half the customers and would
     * silently overcharge or undercharge the other half by 12–27%, with
     * nothing on the invoice to show which reading was taken.
     */
    slabMode: z.enum(["progressive", "flat", "none"], {
      required_error:
        "Choose how the bands are read. Progressive charges each band for " +
        "the part of the quantity inside it; flat charges the whole " +
        "quantity at the rate of the band it lands in. On a common tariff " +
        "the two differ by 27%, so there is no safe default.",
      invalid_type_error:
        "Choose progressive, flat, or none — there is no safe default.",
    }),

    basis: z.enum([
      "per_unit",
      "per_night",
      "per_hour",
      "per_day",
      "per_km",
      "per_kg",
      "per_kwh",
      "flat_fee",
      "percentage",
    ]),

    /** ⭐ Higher wins, and it is stated rather than inferred from a date. */
    priority: z.coerce.number().int().min(0).max(100_000).default(100),

    appliesToKind: optionalText(60),
    appliesToId: optionalUuid,
    /**
     * ⚠️ A CARD NAMING A CUSTOMER IS FOR THAT CUSTOMER AND NOBODY ELSE.
     * The selection function refuses to hand it to anyone else, because
     * the alternative is somebody else's negotiated margin on your
     * invoice — a disclosure, not merely a mispricing.
     */
    customerCompanyId: optionalUuid,
    channel: optionalText(60),

    validFrom: optionalDate,
    validTo: optionalDate,

    /** "1111100" = Mon–Fri. Empty means every day. */
    daysOfWeek: z
      .union([
        z.string().regex(/^[01]{7}$/, "Use seven 0s and 1s, Monday first."),
        z.literal(""),
        z.null(),
      ])
      .optional()
      .transform((v) => (v ? v : null)),

    currency: z.string().trim().length(3).default("INR"),

    /** ⚠️ NOT NULL in the database with a default of 0 — never send null. */
    baseAmountMinor: paise.default("0"),

    taxRateBps: z.coerce
      .number()
      .int()
      .min(0)
      .max(10_000, "1800 is 18%. The maximum is 10000.")
      .default(0),
    isTaxInclusive: z.coerce.boolean().default(false),
    isActive: z.coerce.boolean().default(true),
  })
  /**
   * ⚠️ CHECKED HERE **AND** BY A CHECK CONSTRAINT. Not redundancy — this
   * one can say "the end date is exclusive" while pointing at the field;
   * the constraint is what holds when a script writes the row.
   */
  .refine((d) => !d.validFrom || !d.validTo || d.validTo > d.validFrom, {
    message:
      "The end of the validity window must be after its start — and it is " +
      "EXCLUSIVE, so a card for the whole of March ends 2026-04-01.",
    path: ["validTo"],
  });

/**
 * ⭐ Create or amend a rate card.
 *
 * ⚠️ AMENDING A LIVE CARD CHANGES FUTURE PRICES AND NOTHING ELSE. Quotes
 * already recorded keep their own frozen numbers — that is the whole point
 * of `rate_quotes` being append-only — so this is safe in a way editing a
 * price usually is not.
 */
export async function saveRateCard(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const data = cardSchema.parse(input);
    const ctx = await guardSalesWrite({
      operation: "rates:card:save",
      feature: FEATURE,
      permission: WRITE_PERMISSION,
      resource: data.id ? { type: "rate_card", id: data.id } : undefined,
    });

    const values = {
      code: data.code,
      name: data.name,
      description: data.description,
      scope: data.scope,
      slabMode: data.slabMode,
      basis: data.basis,
      priority: data.priority,
      appliesToKind: data.appliesToKind,
      appliesToId: data.appliesToId,
      customerCompanyId: data.customerCompanyId,
      channel: data.channel,
      validFrom: data.validFrom,
      validTo: data.validTo,
      daysOfWeek: data.daysOfWeek,
      currency: data.currency,
      // ⚠️ NOT NULL. `?? 0n` is not optional politeness here.
      baseAmountMinor: BigInt(data.baseAmountMinor),
      taxRateBps: data.taxRateBps,
      isTaxInclusive: data.isTaxInclusive,
      isActive: data.isActive,
      updatedAt: new Date(),
    };

    const id = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        if (data.id) {
          await tx
            .update(rateCards)
            .set(values)
            .where(
              and(
                eq(rateCards.tenantId, ctx.tenant.id),
                eq(rateCards.id, data.id),
              ),
            );
          return data.id;
        }
        const [row] = await tx
          .insert(rateCards)
          .values({ tenantId: ctx.tenant.id, ...values })
          .returning({ id: rateCards.id });
        if (!row) throw new Error("The rate card could not be created.");
        return row.id;
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: data.id ? "update" : "create",
      resourceType: "rate_card",
      resourceId: id,
      // ⚠️ `reason`, not `summary`. There is no `summary` field on AuditEntry.
      reason: `${data.code} · ${data.scope} · ${data.slabMode} · priority ${data.priority}`,
      metadata: {
        slabMode: data.slabMode,
        scope: data.scope,
        basis: data.basis,
        baseAmountMinor: data.baseAmountMinor,
        taxRateBps: data.taxRateBps,
      },
    });

    revalidatePath("/rates");
    return { ok: true, data: { id } };
  } catch (err) {
    const explained = explainRateError(err);
    if (explained) return { ok: false, error: explained };
    return toSalesActionError(err, "rates");
  }
}

/**
 * ⭐ Switch a card on or off.
 *
 * ⚠️ THIS IS HOW A CARD IS RETIRED, AND IT IS NOT A LESSER FORM OF
 * DELETION. `is_active` is what the selection view reads, so switching it
 * off stops the card being chosen from the moment it is saved — while the
 * quotes built from it, and the record of what was offered on 14 March,
 * stay exactly where they are.
 */
export async function setRateCardActive(
  input: unknown,
): Promise<ActionResult<{ id: string; isActive: boolean }>> {
  try {
    const data = z
      .object({ id: z.string().uuid(), isActive: z.coerce.boolean() })
      .parse(input);

    const ctx = await guardSalesWrite({
      operation: "rates:card:activate",
      feature: FEATURE,
      permission: WRITE_PERMISSION,
      resource: { type: "rate_card", id: data.id },
    });

    await withTenant(
      ctx.tenant.id,
      async (tx) => {
        await tx
          .update(rateCards)
          .set({ isActive: data.isActive, updatedAt: new Date() })
          .where(
            and(eq(rateCards.tenantId, ctx.tenant.id), eq(rateCards.id, data.id)),
          );
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: "update",
      resourceType: "rate_card",
      resourceId: data.id,
      reason: data.isActive
        ? "card switched on — it can now win selection"
        : "card retired — it will no longer be selected, quotes are untouched",
    });

    revalidatePath("/rates");
    return { ok: true, data: { id: data.id, isActive: data.isActive } };
  } catch (err) {
    const explained = explainRateError(err);
    if (explained) return { ok: false, error: explained };
    return toSalesActionError(err, "rates");
  }
}

/**
 * ⭐ Remove a card.
 *
 * ⚠️ SOFT, BY SETTING `deleted_at`. A hard delete would be refused anyway
 * the moment a quote exists against the card — `rate_quotes_card_tenant_fk`
 * is ON DELETE RESTRICT precisely because the moment somebody most wants
 * the evidence gone is the moment it matters most. Marking it deleted
 * takes it out of every list and off the candidate view without touching
 * the record of what was said.
 */
export async function deleteRateCard(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const { id } = z.object({ id: z.string().uuid() }).parse(input);
    const ctx = await guardSalesWrite({
      operation: "rates:card:delete",
      feature: FEATURE,
      permission: WRITE_PERMISSION,
      resource: { type: "rate_card", id },
      // ⚠️ Judged as a DESTRUCTIVE act by the impersonation policy rather
      // than as an ordinary pricing edit.
      impersonationOperation: "delete:rate_card",
    });

    await withTenant(
      ctx.tenant.id,
      async (tx) => {
        await tx
          .update(rateCards)
          .set({ deletedAt: new Date(), isActive: false, updatedAt: new Date() })
          .where(and(eq(rateCards.tenantId, ctx.tenant.id), eq(rateCards.id, id)));
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: "delete",
      resourceType: "rate_card",
      resourceId: id,
      reason: "card removed from the list; recorded quotes are untouched",
      severity: "warning",
    });

    revalidatePath("/rates");
    return { ok: true, data: { id } };
  } catch (err) {
    const explained = explainRateError(err);
    if (explained) return { ok: false, error: explained };
    return toSalesActionError(err, "rates");
  }
}

/* ------------------------------------------------------------------ */
/* WRITE — SLABS                                                       */
/* ------------------------------------------------------------------ */

const slabsSchema = z.object({
  rateCardId: z.string().uuid("Choose a rate card."),
  slabs: z
    .array(
      z.object({
        /**
         * ⚠️ EMPTY MEANS INFINITY, AND ONLY THE LAST BAND MAY BE EMPTY.
         * There is no `fromQuantity` anywhere in this engine: one boundary
         * per row makes a gap between bands unrepresentable, and a gap is
         * the failure that prices the units inside it at zero without
         * erroring.
         */
        upToQuantity: z
          .union([
            z.string().trim().regex(/^\d{1,18}$/, "Whole numbers only."),
            z.literal(""),
            z.null(),
          ])
          .optional()
          .transform((v) => (v ? BigInt(v) : null)),
        /** ⚠️ NOT NULL in the database. No default — a band must be priced. */
        unitAmountMinor: paise,
        /** Demand charge for entering the band at all. NOT NULL, defaults 0. */
        fixedAmountMinor: paise.default("0"),
        label: optionalText(120),
      }),
    )
    .max(60, "Sixty bands is already more tariff than anybody can explain."),
});

/**
 * ⭐ Replace every band on a card, in one transaction.
 *
 * ⚠️ THE SEQUENCE NUMBERS ARE ASSIGNED HERE, FROM ARRAY ORDER, and never
 * accepted from the caller. The trigger demands 1,2,3 … with no gaps; a
 * caller who has just removed the third of five bands would otherwise send
 * 1,2,4,5 and be refused for a reason that has nothing to do with what
 * they did.
 *
 * ⚠️ THE REFUSAL ARRIVES AT COMMIT. The contiguity trigger is DEFERRABLE
 * INITIALLY DEFERRED, which is exactly what makes a legitimate rewrite of
 * all four bands legal: the delete leaves the set momentarily empty and
 * each insert leaves it momentarily incomplete, and a non-deferred trigger
 * would reject the correct edit at statement two of six.
 */
export async function saveRateSlabs(
  input: unknown,
): Promise<ActionResult<{ rateCardId: string; slabs: number }>> {
  try {
    const data = slabsSchema.parse(input);
    const ctx = await guardSalesWrite({
      operation: "rates:slabs:save",
      feature: FEATURE,
      permission: WRITE_PERMISSION,
      resource: { type: "rate_card", id: data.rateCardId },
    });

    await withTenant(
      ctx.tenant.id,
      async (tx) => {
        await tx
          .delete(rateSlabs)
          .where(
            and(
              eq(rateSlabs.tenantId, ctx.tenant.id),
              eq(rateSlabs.rateCardId, data.rateCardId),
            ),
          );

        if (data.slabs.length === 0) return;

        await tx.insert(rateSlabs).values(
          data.slabs.map((s, index) => ({
            tenantId: ctx.tenant.id,
            rateCardId: data.rateCardId,
            sequence: index + 1,
            upToQuantity: s.upToQuantity,
            unitAmountMinor: BigInt(s.unitAmountMinor),
            fixedAmountMinor: BigInt(s.fixedAmountMinor),
            label: s.label,
          })),
        );
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: "update",
      resourceType: "rate_card",
      resourceId: data.rateCardId,
      reason: `${data.slabs.length} band(s) written — the whole set was replaced`,
      metadata: {
        bands: data.slabs.map((s, index) => ({
          sequence: index + 1,
          upToQuantity: s.upToQuantity === null ? null : String(s.upToQuantity),
          unitAmountMinor: s.unitAmountMinor,
          fixedAmountMinor: s.fixedAmountMinor,
        })),
      },
    });

    revalidatePath("/rates");
    return { ok: true, data: { rateCardId: data.rateCardId, slabs: data.slabs.length } };
  } catch (err) {
    const explained = explainRateError(err);
    if (explained) return { ok: false, error: explained };
    return toSalesActionError(err, "rates");
  }
}

/* ------------------------------------------------------------------ */
/* WRITE — ADJUSTMENTS                                                 */
/* ------------------------------------------------------------------ */

const adjustmentsSchema = z.object({
  rateCardId: z.string().uuid("Choose a rate card."),
  adjustments: z
    .array(
      z.object({
        /** ⚠️ NOT NULL. An unlabelled line on an invoice is a dispute. */
        label: z.string().trim().min(1, "Name the surcharge or discount.").max(160),
        /**
         * ⭐ NEGATIVE IS A DISCOUNT. −1000 bps is 10% off. The column is a
         * plain integer with no CHECK, so both directions are legal — and
         * they must be, because a fuel surcharge and a negotiated discount
         * are the same arithmetic pointing opposite ways.
         */
        percentageBps: z.coerce
          .number()
          .int()
          .min(-10_000, "−10000 bps is 100% off. Nothing goes below that.")
          .max(100_000)
          .default(0),
        fixedAmountMinor: paise.default("0"),
        isVisible: z.coerce.boolean().default(true),
        isStatutory: z.coerce.boolean().default(false),
      }),
    )
    .max(40),
});

/**
 * ⭐ Replace every adjustment on a card, in order.
 *
 * ⚠️ THE ORDER IS THE ANSWER AND IT DOES NOT COMMUTE. 10% off then a ₹50
 * statutory levy is not the ₹50 levy then 10% off, and with two percentage
 * lines the gap widens. Each adjustment applies to the RUNNING subtotal,
 * not to the original, so the position in this array is a commercial
 * decision — which is why the array order becomes `sequence` and nothing
 * re-sorts it afterwards.
 */
export async function saveRateAdjustments(
  input: unknown,
): Promise<ActionResult<{ rateCardId: string; adjustments: number }>> {
  try {
    const data = adjustmentsSchema.parse(input);
    const ctx = await guardSalesWrite({
      operation: "rates:adjustments:save",
      feature: FEATURE,
      permission: WRITE_PERMISSION,
      resource: { type: "rate_card", id: data.rateCardId },
    });

    await withTenant(
      ctx.tenant.id,
      async (tx) => {
        await tx
          .delete(rateAdjustments)
          .where(
            and(
              eq(rateAdjustments.tenantId, ctx.tenant.id),
              eq(rateAdjustments.rateCardId, data.rateCardId),
            ),
          );

        if (data.adjustments.length === 0) return;

        await tx.insert(rateAdjustments).values(
          data.adjustments.map((a, index) => ({
            tenantId: ctx.tenant.id,
            rateCardId: data.rateCardId,
            sequence: index + 1,
            label: a.label,
            percentageBps: a.percentageBps,
            fixedAmountMinor: BigInt(a.fixedAmountMinor),
            isVisible: a.isVisible,
            isStatutory: a.isStatutory,
          })),
        );
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: "update",
      resourceType: "rate_card",
      resourceId: data.rateCardId,
      reason: `${data.adjustments.length} adjustment(s) written, in order`,
      metadata: {
        adjustments: data.adjustments.map((a, index) => ({
          sequence: index + 1,
          label: a.label,
          percentageBps: a.percentageBps,
          fixedAmountMinor: a.fixedAmountMinor,
        })),
      },
    });

    revalidatePath("/rates");
    return {
      ok: true,
      data: { rateCardId: data.rateCardId, adjustments: data.adjustments.length },
    };
  } catch (err) {
    const explained = explainRateError(err);
    if (explained) return { ok: false, error: explained };
    return toSalesActionError(err, "rates");
  }
}

/* ------------------------------------------------------------------ */
/* QUOTING                                                             */
/* ------------------------------------------------------------------ */

const quoteInputSchema = z.object({
  rateCardId: z.string().uuid("Choose a rate card."),
  quantity: z
    .string()
    .trim()
    .regex(/^\d{1,18}$/, "Quantity is a whole number, zero or more."),
});

/** Pull the single row out of whatever shape the driver hands back. */
function firstRow(result: unknown): Record<string, unknown> | null {
  if (Array.isArray(result)) {
    return (result[0] as Record<string, unknown>) ?? null;
  }
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return (rows[0] as Record<string, unknown>) ?? null;
  }
  return null;
}

/**
 * ⭐ THE AUTHORITATIVE QUOTE. Computed by `ordence_quote_rate` in SQL.
 *
 * ⚠️ THE ARITHMETIC EXISTS TWICE AND THIS COPY IS THE ONE THAT BILLS.
 * `priceProgressive` / `priceFlat` / `applyBps` in db/schema/pricing.ts
 * price the live preview in the browser, because a round trip per
 * keystroke makes the calculator unusable. The SQL prices the batch run
 * and everything that reaches an invoice. Two implementations of one
 * formula is a real hazard, so tests/ui/pricing-engine.test.tsx runs both
 * over a shared table of cases and asserts identical paise — and when they
 * ever disagree, THIS one is right.
 */
export async function previewRateQuote(
  input: unknown,
): Promise<ActionResult<RateQuoteResult>> {
  try {
    const data = quoteInputSchema.parse(input);
    const ctx = await requirePermission(READ_PERMISSION);

    const row = await withTenant(ctx.tenant.id, async (tx) => {
      const result = await tx.execute(sql`
        SELECT subtotal_minor, adjustments_minor, tax_minor, total_minor, breakdown
          FROM ordence_quote_rate(
            ${ctx.tenant.id}::uuid,
            ${data.rateCardId}::uuid,
            ${data.quantity}::bigint
          )
      `);
      return firstRow(result);
    });

    if (!row) {
      return {
        ok: false,
        error: "That rate card produced no quote. It may have been removed.",
      };
    }

    return {
      ok: true,
      data: {
        rateCardId: data.rateCardId,
        quantity: data.quantity,
        subtotalMinor: minor(row.subtotal_minor as bigint | string | number),
        adjustmentsMinor: minor(row.adjustments_minor as bigint | string | number),
        taxMinor: minor(row.tax_minor as bigint | string | number),
        totalMinor: minor(row.total_minor as bigint | string | number),
        breakdown: Array.isArray(row.breakdown)
          ? (row.breakdown as QuoteBreakdownLine[])
          : [],
      },
    };
  } catch (err) {
    const explained = explainRateError(err);
    if (explained) return { ok: false, error: explained };
    return {
      ok: false,
      error: err instanceof Error ? err.message : "The quote could not be computed.",
    };
  }
}

const recordQuoteSchema = quoteInputSchema.extend({
  quotedFor: optionalText(200),
});

/**
 * ⭐ RECORD WHAT WE QUOTED, TO WHOM, ON WHAT DAY.
 *
 * ⚠️ THIS IS THE POINT OF THE ENGINE, NOT A LOG. "What did you quote us on
 * 14 March?" is the question that settles a billing dispute, and a system
 * that can only recompute today's answer cannot settle it — the card has
 * been edited since, the season has ended, and recomputation returns
 * today's number with total confidence and no relationship to the
 * conversation that actually happened.
 *
 * ⚠️ SO THE ROW IS APPEND-ONLY, TWICE OVER: a BEFORE UPDATE OR DELETE
 * trigger refuses the edit with a sentence, and the application role has
 * no UPDATE or DELETE privilege on the table at all. If this function ever
 * appears to have an "amend" sibling, that sibling is a bug.
 *
 * ⚠️ THE FIGURES ARE TAKEN FROM THE SQL, NOT FROM THE BROWSER'S PREVIEW.
 * Storing what the client computed would make the frozen evidence exactly
 * as trustworthy as the client — which is the one thing it must not be.
 */
export async function recordRateQuote(
  input: unknown,
): Promise<ActionResult<{ id: string; totalMinor: string }>> {
  try {
    const data = recordQuoteSchema.parse(input);
    const ctx = await guardSalesWrite({
      operation: "rates:quote:record",
      feature: FEATURE,
      permission: WRITE_PERMISSION,
      resource: { type: "rate_card", id: data.rateCardId },
    });

    const recorded = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const card = await tx
          .select({
            code: rateCards.code,
            name: rateCards.name,
            scope: rateCards.scope,
            slabMode: rateCards.slabMode,
            priority: rateCards.priority,
            isActive: rateCards.isActive,
          })
          .from(rateCards)
          .where(
            and(
              eq(rateCards.tenantId, ctx.tenant.id),
              eq(rateCards.id, data.rateCardId),
              sql`${rateCards.deletedAt} IS NULL`,
            ),
          )
          .limit(1);

        const chosen = card[0];
        if (!chosen) {
          throw new Error("Rate card does not exist in this workspace.");
        }

        const result = await tx.execute(sql`
          SELECT subtotal_minor, adjustments_minor, tax_minor, total_minor, breakdown
            FROM ordence_quote_rate(
              ${ctx.tenant.id}::uuid,
              ${data.rateCardId}::uuid,
              ${data.quantity}::bigint
            )
        `);
        const priced = firstRow(result);
        if (!priced) throw new Error("The quote could not be computed.");

        /**
         * ⭐ WHY THIS CARD, IN WORDS, FROZEN ALONGSIDE THE NUMBER.
         *
         * ⚠️ A quote that records ₹1,380 and not why is half an answer. Six
         * months later the card has a different priority, the season has
         * turned, and nobody can reconstruct whether the contracted rate or
         * the seasonal one was in play — which is precisely what the
         * customer is asking about.
         */
        const selectionReason =
          `${chosen.code} — scope ${chosen.scope} ` +
          `(rank ${RATE_SCOPE_PRIORITY[chosen.scope as keyof typeof RATE_SCOPE_PRIORITY] ?? 0}), ` +
          `priority ${chosen.priority}, slabs read ${chosen.slabMode}` +
          (chosen.isActive ? "" : " — card was already retired when quoted");

        const [row] = await tx
          .insert(rateQuotes)
          .values({
            tenantId: ctx.tenant.id,
            rateCardId: data.rateCardId,
            quantity: BigInt(data.quantity),
            subtotalMinor: BigInt(String(priced.subtotal_minor ?? "0")),
            adjustmentsMinor: BigInt(String(priced.adjustments_minor ?? "0")),
            taxMinor: BigInt(String(priced.tax_minor ?? "0")),
            totalMinor: BigInt(String(priced.total_minor ?? "0")),
            breakdown: Array.isArray(priced.breakdown)
              ? (priced.breakdown as Array<Record<string, unknown>>)
              : [],
            selectionReason,
            quotedFor: data.quotedFor,
          })
          .returning({ id: rateQuotes.id, totalMinor: rateQuotes.totalMinor });

        if (!row) throw new Error("The quote could not be recorded.");
        return { id: row.id, totalMinor: minor(row.totalMinor), selectionReason };
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: "create",
      resourceType: "rate_quote",
      resourceId: recorded.id,
      reason: `quoted ${data.quantity} for ${data.quotedFor ?? "an unnamed party"}`,
      metadata: {
        rateCardId: data.rateCardId,
        quantity: data.quantity,
        totalMinor: recorded.totalMinor,
        selectionReason: recorded.selectionReason,
      },
    });

    revalidatePath("/rates");
    return { ok: true, data: { id: recorded.id, totalMinor: recorded.totalMinor } };
  } catch (err) {
    const explained = explainRateError(err);
    if (explained) return { ok: false, error: explained };
    return toSalesActionError(err, "rates");
  }
}

/**
 * ⭐ WHICH CARD WOULD WIN, GIVEN THESE FACTS?
 *
 * ⚠️ "MOST RECENTLY CREATED WINS" IS THE OBVIOUS ANSWER AND IT IS A TRAP:
 * the winner then changes when somebody edits an unrelated card, the price
 * moves for no visible reason, and nobody can reconstruct why afterwards.
 * `ordence_select_rate_card` resolves it by stated scope rank, then the
 * card's own priority, then specificity — so the answer is the same
 * tomorrow, and can be explained to a customer holding a different
 * invoice.
 */
export async function resolveRateCard(
  input: unknown,
): Promise<ActionResult<{ rateCardId: string | null }>> {
  try {
    const data = z
      .object({
        appliesToKind: optionalText(60),
        appliesToId: optionalUuid,
        customerCompanyId: optionalUuid,
        channel: optionalText(60),
        onDate: z
          .union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.literal(""), z.null()])
          .optional()
          .transform((v) => (v ? v : new Date().toISOString().slice(0, 10))),
      })
      .parse(input);

    const ctx = await requirePermission(READ_PERMISSION);

    const row = await withTenant(ctx.tenant.id, async (tx) => {
      const result = await tx.execute(sql`
        SELECT ordence_select_rate_card(
          ${ctx.tenant.id}::uuid,
          ${data.appliesToKind}::varchar,
          ${data.appliesToId}::uuid,
          ${data.customerCompanyId}::uuid,
          ${data.channel}::varchar,
          ${data.onDate}::date
        ) AS rate_card_id
      `);
      return firstRow(result);
    });

    const id = row?.rate_card_id;
    return { ok: true, data: { rateCardId: typeof id === "string" ? id : null } };
  } catch (err) {
    const explained = explainRateError(err);
    if (explained) return { ok: false, error: explained };
    return {
      ok: false,
      error:
        err instanceof Error ? err.message : "The winning card could not be resolved.",
    };
  }
}
