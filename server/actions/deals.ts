"use server";

/**
 * Ordence — THE PIPELINE (also: ENGAGEMENTS)
 * Version: v0.70.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION. A `"use server"` file that exports
 * anything else publishes it as an RPC endpoint reachable by anyone on
 * the internet. The helpers below are deliberately not exported.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THIS FILE EXISTS TO STOP THE FORECAST BEING A LIE
 * ══════════════════════════════════════════════════════════════════════
 * The pipeline number a company runs on — "we have ₹4.2 crore in play" —
 * is a sum over rows nobody re-reads. Four things quietly corrupt it, and
 * every one of them is computed here rather than left for a human to
 * notice:
 *
 *   1. ⭐ DEALS PAST THEIR OWN CLOSE DATE, still open. The month they
 *      were counted in has ended. They are still in the total.
 *   2. ⭐ MIXED CURRENCIES. `amount` carries a `currency` beside it and
 *      nothing stops a workspace holding both INR and USD deals. Summing
 *      them produces a number with no unit — see `currencies` below.
 *   3. DEALS WITH NO AMOUNT. Invisible in every total, fully visible in
 *      every count, so the pipeline looks fuller than it is worth.
 *   4. PROBABILITY THAT CONTRADICTS THE STAGE. A `won` deal at 40% and a
 *      `negotiation` deal at 0% both pass through the weighted forecast
 *      silently and both are wrong.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ MONEY IS `numeric(15,2)` HERE — MAJOR UNITS, NOT MINOR
 * ══════════════════════════════════════════════════════════════════════
 * The engines built later store paise in a `bigint` (`*_minor`). `deals`
 * predates that and stores rupees in a `numeric`, which the driver hands
 * back as a STRING — "1500000.00".
 *
 * ⚠️ DO NOT `Number()` IT. A pipeline is exactly the place where
 * ₹1,00,00,000.05 must not become ₹1,00,00,000.049999. Everything below
 * converts the string to integer paise by moving the decimal point with
 * string operations, sums in `bigint`, and hands the total back to the
 * client as a STRING — `JSON.stringify` throws outright on a bigint, so
 * a total that leaves this file as a bigint is a page that 500s.
 */

import { and, desc, eq, isNull } from "drizzle-orm";
import { withTenant } from "@/db";
import { deals, companies, contacts } from "@/db/schema/crm";
import { users } from "@/db/schema/core";
import { requirePermission } from "@/server/audit";

/*
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THIS FILE CONTAINS NO WRITES — AND THAT IS WHY IT HAS NO
 *    `requireAccess()` CALL. READ THIS BEFORE ADDING ONE.
 * ══════════════════════════════════════════════════════════════════════
 * The S1 sweep (v0.83.2) added the billing gate to every write in
 * `contacts.ts` and `companies.ts`. `deals.ts` was audited at the same
 * time and needed nothing: its only export is `listDealPipeline()`, a
 * read, and a read stays available to a lapsed workspace on purpose — a
 * customer in arrears must still be able to see their own data.
 *
 * The ONLY deal write in the codebase is `ordence_update_deal_stage` in
 * `server/mcp/dispatch.ts`, which is now gated centrally: every tool
 * declared `scope: "read_write"` passes through
 * `requireAccessForTenant()` before it runs.
 *
 * ⚠️ SO: THE MOMENT A WRITE IS ADDED HERE — createDeal, updateDealStage,
 * deleteDeal — IT MUST CALL `requireAccess("deals:create" | "deals:update"
 * | "deals:delete", ctx)` IMMEDIATELY AFTER `requireTenantContext()`,
 * before validation. Copy the shape from `server/actions/contacts.ts`.
 * A new write added without it silently reopens the hole this sweep
 * closed, and nothing in the type system will notice.
 */
import type { ActionResult } from "@/lib/validators/crm";

/* ------------------------------------------------------------------ */
/* SHAPES                                                              */
/* ------------------------------------------------------------------ */

export type DealRow = {
  id: string;
  title: string;
  stage: string;
  probability: number;
  /** Integer paise, as a string. "0" when the deal carries no amount. */
  amountMinor: string;
  /** ⚠️ Weighted by probability. Meaningless across mixed currencies. */
  weightedMinor: string;
  /** Null when the deal was never priced — distinct from an amount of 0. */
  hasAmount: boolean;
  currency: string;
  expectedCloseDate: string | null;
  actualCloseDate: string | null;
  companyName: string | null;
  contactName: string | null;
  ownerId: string | null;
  ownerName: string | null;
  source: string | null;
  lostReason: string | null;
  updatedAt: string;
  /** Days since anything on this deal changed. */
  daysSinceUpdate: number;
  /**
   * Days past the expected close date. Positive = the date has passed.
   * Null when no close date was ever set, which is its own problem.
   */
  daysPastClose: number | null;
  /** Set when stage and probability disagree. Human-readable. */
  probabilityConflict: string | null;
};

export type StageSummary = {
  stage: string;
  count: number;
  valueMinor: string;
  weightedMinor: string;
};

/** The stages, in the order a deal moves through them. */
const STAGE_ORDER = [
  "lead",
  "qualified",
  "proposal",
  "negotiation",
  "won",
  "lost",
] as const;

const CLOSED = new Set<string>(["won", "lost"]);

/** A deal untouched for this long has stopped being a forecast. */
const STALE_DAYS = 30;

/* ------------------------------------------------------------------ */
/* HELPERS — not exported. See the header.                             */
/* ------------------------------------------------------------------ */

/**
 * `numeric(15,2)` string → integer paise as a `bigint`.
 *
 * ⚠️ Written with string operations rather than `Number(v) * 100`, which
 * is wrong for values a property developer actually types: `19.99 * 100`
 * is 1998.9999999999998 in IEEE-754, and `Math.round` hides that until
 * the day it does not.
 */
function toMinor(value: string | null): bigint {
  if (value === null || value === undefined || value.trim() === "") return 0n;
  const raw = value.trim();
  const negative = raw.startsWith("-");
  const unsigned = negative ? raw.slice(1) : raw;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const paise = `${whole}${(fraction + "00").slice(0, 2)}`.replace(/^0+(?=\d)/, "");
  let out: bigint;
  try {
    out = BigInt(paise === "" ? "0" : paise);
  } catch {
    // A value the driver handed back in a shape we did not expect. Count
    // it as unpriced rather than crashing the whole pipeline read.
    return 0n;
  }
  return negative ? -out : out;
}

function daysBetweenToday(dateOnly: string | null): number | null {
  if (!dateOnly) return null;
  const target = new Date(`${dateOnly}T00:00:00.000Z`).getTime();
  if (Number.isNaN(target)) return null;
  const today = new Date();
  const todayUtc = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate(),
  );
  return Math.round((todayUtc - target) / 86_400_000);
}

function daysSince(instant: Date | string): number {
  const t = typeof instant === "string" ? new Date(instant) : instant;
  if (Number.isNaN(t.getTime())) return 0;
  return Math.max(0, Math.floor((Date.now() - t.getTime()) / 86_400_000));
}

/**
 * ⭐ WHERE THE STAGE AND THE PROBABILITY CONTRADICT EACH OTHER.
 *
 * ⚠️ Neither field is derived from the other — a rep can drag a card to
 * `won` and leave the slider at 40%, and both the count of won deals and
 * the weighted forecast will then be right about different things. The
 * database has no opinion; somebody has to.
 */
function probabilityConflict(stage: string, probability: number): string | null {
  if (stage === "won" && probability < 100) {
    return `won but forecast at ${probability}%`;
  }
  if (stage === "lost" && probability > 0) {
    return `lost but forecast at ${probability}%`;
  }
  if ((stage === "negotiation" || stage === "proposal") && probability === 0) {
    return `in ${stage} but forecast at 0%`;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* READ                                                                */
/* ------------------------------------------------------------------ */

/**
 * The whole pipeline, plus everything about it that is quietly wrong.
 *
 * Read-only. One query with three left joins rather than four round
 * trips — the joins are all on tenant-led indexes and the row cap is the
 * thing that bounds the cost, not the join count.
 */
export async function listDealPipeline(): Promise<
  ActionResult<{
    deals: DealRow[];
    /** ⭐ Open deals whose own close date has passed. These lead. */
    overdue: DealRow[];
    /** Open deals nothing has happened to in 30 days. */
    stalled: DealRow[];
    /** Open deals with no amount at all. Counted everywhere, valued nowhere. */
    unpriced: DealRow[];
    /** Open deals with nobody named against them. */
    ownerless: DealRow[];
    /** Deals whose stage and probability disagree. */
    conflicted: DealRow[];
    byStage: StageSummary[];
    /** Open pipeline, integer paise as a string. */
    openValueMinor: string;
    /** Open pipeline weighted by probability, integer paise as a string. */
    weightedValueMinor: string;
    /** Value of deals in `won`. */
    wonValueMinor: string;
    /**
     * ⚠️ EVERY CURRENCY PRESENT ON A LIVE DEAL.
     *
     * More than one means every total above is a sum of unlike things
     * and the page must say so. Nothing in the schema prevents it.
     */
    currencies: string[];
    /** How much of the open pipeline is past its own close date. */
    overdueValueMinor: string;
  }>
> {
  try {
    /**
     * ⚠️ `deals:read` — an EXISTING key in `PERMISSION_CATALOG`. A key
     * that is not in the catalogue fails closed for every role including
     * the workspace owner, and presents as "you do not have access"
     * rather than as the bug it is.
     */
    const ctx = await requirePermission("deals:read");

    const rows = await withTenant(ctx.tenant.id, async (tx) =>
      tx
        .select({
          id: deals.id,
          title: deals.title,
          stage: deals.stage,
          probability: deals.probability,
          amount: deals.amount,
          currency: deals.currency,
          expectedCloseDate: deals.expectedCloseDate,
          actualCloseDate: deals.actualCloseDate,
          source: deals.source,
          lostReason: deals.lostReason,
          ownerId: deals.ownerId,
          updatedAt: deals.updatedAt,
          companyName: companies.name,
          contactFirstName: contacts.firstName,
          contactLastName: contacts.lastName,
          ownerFirstName: users.firstName,
          ownerLastName: users.lastName,
          ownerEmail: users.email,
        })
        .from(deals)
        .leftJoin(
          companies,
          and(
            eq(companies.id, deals.companyId),
            eq(companies.tenantId, deals.tenantId),
          ),
        )
        .leftJoin(
          contacts,
          and(eq(contacts.id, deals.contactId), eq(contacts.tenantId, deals.tenantId)),
        )
        .leftJoin(
          users,
          and(eq(users.id, deals.ownerId), eq(users.tenantId, deals.tenantId)),
        )
        .where(and(eq(deals.tenantId, ctx.tenant.id), isNull(deals.deletedAt)))
        .orderBy(desc(deals.updatedAt))
        .limit(1000),
    );

    const dealRows: DealRow[] = rows.map((r) => {
      const amountMinor = toMinor(r.amount);
      const probability = r.probability ?? 0;
      const contactName =
        [r.contactFirstName, r.contactLastName].filter(Boolean).join(" ") || null;
      const ownerName =
        [r.ownerFirstName, r.ownerLastName].filter(Boolean).join(" ") ||
        r.ownerEmail ||
        null;

      return {
        id: r.id,
        title: r.title,
        stage: r.stage,
        probability,
        amountMinor: String(amountMinor),
        /* Integer division, deliberately. A weighted forecast to the
         * paise is false precision; a weighted forecast that drifts by a
         * float epsilon per row is worse. */
        weightedMinor: String((amountMinor * BigInt(probability)) / 100n),
        hasAmount: r.amount !== null && r.amount !== undefined,
        currency: r.currency,
        expectedCloseDate: r.expectedCloseDate,
        actualCloseDate: r.actualCloseDate,
        companyName: r.companyName,
        contactName,
        ownerId: r.ownerId,
        ownerName,
        source: r.source,
        lostReason: r.lostReason,
        updatedAt: new Date(r.updatedAt).toISOString(),
        daysSinceUpdate: daysSince(r.updatedAt),
        daysPastClose: daysBetweenToday(r.expectedCloseDate),
        probabilityConflict: probabilityConflict(r.stage, probability),
      };
    });

    const open = dealRows.filter((d) => !CLOSED.has(d.stage));

    const overdue = open
      .filter((d) => d.daysPastClose !== null && d.daysPastClose > 0)
      .sort((a, b) => (b.daysPastClose ?? 0) - (a.daysPastClose ?? 0));

    const byStage: StageSummary[] = STAGE_ORDER.map((stage) => {
      const inStage = dealRows.filter((d) => d.stage === stage);
      return {
        stage,
        count: inStage.length,
        valueMinor: String(inStage.reduce((acc, d) => acc + BigInt(d.amountMinor), 0n)),
        weightedMinor: String(
          inStage.reduce((acc, d) => acc + BigInt(d.weightedMinor), 0n),
        ),
      };
    });

    return {
      ok: true,
      data: {
        deals: dealRows,
        overdue,
        stalled: open
          .filter((d) => d.daysSinceUpdate >= STALE_DAYS)
          .sort((a, b) => b.daysSinceUpdate - a.daysSinceUpdate),
        unpriced: open.filter((d) => !d.hasAmount),
        ownerless: open.filter((d) => d.ownerId === null),
        conflicted: dealRows.filter((d) => d.probabilityConflict !== null),
        byStage,
        openValueMinor: String(
          open.reduce((acc, d) => acc + BigInt(d.amountMinor), 0n),
        ),
        weightedValueMinor: String(
          open.reduce((acc, d) => acc + BigInt(d.weightedMinor), 0n),
        ),
        wonValueMinor: String(
          dealRows
            .filter((d) => d.stage === "won")
            .reduce((acc, d) => acc + BigInt(d.amountMinor), 0n),
        ),
        /* Only live deals. A currency that appears solely on a deal lost
         * three years ago does not make today's total a mixed sum. */
        currencies: [...new Set(open.map((d) => d.currency))].sort(),
        overdueValueMinor: String(
          overdue.reduce((acc, d) => acc + BigInt(d.amountMinor), 0n),
        ),
      },
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error ? error.message : "The pipeline could not be read.",
    };
  }
}
