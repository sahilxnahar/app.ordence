"use server";

/**
 * Ordence — ⭐ COST CONTROL · READ ACTIONS
 * Version: v0.70.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION. A `"use server"` file that
 * exports anything else — a constant, a helper, a plain object —
 * publishes it as an RPC endpoint reachable by anyone on the internet.
 * The helpers below are deliberately not exported.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ TWO DIFFERENT NUMBERS ARE BOTH CALLED "BUDGET", AND THEY ARE KEPT
 *    APART DELIBERATELY — v0.68.0
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THIS FILE USED TO SAY "THERE IS NO BUDGET COLUMN IN THIS PRODUCT".
 * SQL 0041 ADDED ONE, so that statement is now false and is corrected
 * here rather than left to mislead the next reader. A confidently wrong
 * comment costs more than a missing one.
 *
 *   REVISED CONTRACT SUM = original + approved variations, from `boqs`,
 *     where a database CHECK already forces the three numbers to foot.
 *     This is what has been COMMITTED — signed, priced, defensible.
 *
 *   projects.budget_minor = what the business APPROVED for the project
 *     before any contract was let. Typed by a human, agreed in a
 *     meeting, and the thing an overrun is measured against.
 *
 * ⚠️ THEY MUST NEVER BE MERGED INTO ONE FIGURE. Committing more than the
 * approved budget is precisely the condition worth surfacing, and it is
 * invisible the moment the two are averaged, defaulted into each other,
 * or one is used where the other is absent.
 *
 * ⚠️ AND A NULL BUDGET IS NOT ZERO. `budget_minor` is nullable because
 * "nobody has set one" is a real and common state. Rendered as ₹0 it
 * reads as on-budget; rendered as infinite overrun it reads as a crisis.
 * It is reported as UNSET, and every consumer has to handle that.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ QUANTITIES ARE MICRO-UNITS (1e6). 12.345 cum IS STORED AS 12345000.
 * ══════════════════════════════════════════════════════════════════════
 * Every quantity below stays in micro-units all the way to the page, and
 * the page divides once for display. Converting here would put a rounding
 * step between the contract and the report — and the report is what
 * somebody holds up next to the contractor's own claim.
 *
 * Money stays in PAISE, as a decimal STRING. `JSON.stringify` throws on a
 * bigint, so a raw figure returned from here crashes at the RSC boundary,
 * at runtime, only on the page that renders money. Which is this one.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE JOIN NOW EXISTS — AND THIS FILE STILL ROLLS UP TO THE PROJECT
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THIS HEADER USED TO SAY `boqs` AND `works_contracts` ARE NOT JOINED.
 * That was true until SQL 0041, which added `boqs.contract_id` (a real
 * composite FK) and `ra_bill_lines.boq_item_id`. The correction matters
 * because the old text told the next person the join was impossible, and
 * they would have believed it.
 *
 * ⚠️ THE FIGURES BELOW STILL ROLL UP TO THE PROJECT, ON PURPOSE. The new
 * column is NULLABLE and, on any existing database, is null for every BOQ
 * whose `contract_ref` was ambiguous or blank — 0041 backfills only
 * unambiguous matches and deliberately leaves the rest for a human.
 * Switching this report to join on it would silently DROP those BOQs from
 * every total, and a cost report that quietly omits three contracts is
 * far worse than one that aggregates coarsely.
 *
 * Per-line, per-contract precision lives in `getBillingPosition()` at the
 * foot of this file, which reads `v_boq_billing_position` and reports
 * only lines that ARE linked. Two functions, two honesty levels, neither
 * one pretending to the other's precision.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT LEADS, AND WHY
 * ══════════════════════════════════════════════════════════════════════
 *   1. ⭐ OVER-MEASURED BOQ LINES. Work measured beyond the authorised
 *      quantity is either a variation nobody raised or a measurement
 *      error, and both are money. The contractor has done the work either
 *      way; the only question left is who pays for it, and the answer
 *      gets worse every week nobody asks.
 *   2. ⭐ MEASURED BUT NEVER BILLED. Value that has been measured, is not
 *      rejected, and is on no RA bill. It is a liability that does not
 *      appear in any bill register — the accrual nobody made.
 *   3. COMMITTED vs CERTIFIED, per project. Contract sum, certified,
 *      pending certification, vendor commitment, retention held.
 */

import { sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { requirePermission } from "@/server/audit";
import { toSalesActionError } from "@/server/sales/guards";
import type { ActionResult } from "@/lib/validators/crm";

/* ------------------------------------------------------------------ */
/* SHAPES                                                              */
/* ------------------------------------------------------------------ */

/** One BOQ line measured beyond what was authorised. */
export type OverMeasuredLine = {
  boqItemId: string;
  itemCode: string;
  description: string;
  uom: string;
  /** ⚠️ MICRO-UNITS. Divide by 1e6 to display. */
  authorisedScaled: string;
  measuredScaled: string;
  excessScaled: string;
  /** Paise per one unit — the varied rate where a variation set one. */
  rateMinor: string;
  /** ⭐ The excess at the contract rate. Paise. What it costs. */
  excessValueMinor: string;
  boqCode: string;
  workPackage: string;
  projectId: string | null;
  projectName: string | null;
  contractorName: string | null;
};

/** Measured work sitting on no RA bill, by project. */
export type UnbilledMeasurement = {
  projectId: string | null;
  projectName: string | null;
  entries: number;
  valueMinor: string;
  /** The oldest measurement in the pile. How long this has been true. */
  oldestMeasuredOn: string | null;
};

export type ProjectCostRow = {
  projectId: string;
  code: string;
  name: string;
  isActive: boolean;
  boqCount: number;
  /** Frozen at issue. */
  originalMinor: string;
  /** Net effect of APPROVED variations. Signed — an omission is negative. */
  variationMinor: string;
  /** original + variation. What the contract is worth today. */
  revisedMinor: string;
  /** Gross value on bills the engineer has certified or better. */
  certifiedMinor: string;
  /** Gross value on bills raised but not yet certified. */
  pendingMinor: string;
  pendingBills: number;
  /** Net actually paid out on bills marked paid. */
  paidMinor: string;
  /** Withheld on certified bills, less anything released. */
  retentionHeldMinor: string;
  /** Vendor bills booked to this project, excluding drafts and cancelled. */
  committedPurchaseMinor: string;
  /** Measured, not rejected, on no bill. */
  unbilledMinor: string;
  overMeasuredLines: number;
};

export type CostControlView = {
  overMeasured: OverMeasuredLine[];
  unbilled: UnbilledMeasurement[];
  projects: ProjectCostRow[];
  /** Sum of every project's revised contract sum. Paise. */
  totalRevisedMinor: string;
  totalCertifiedMinor: string;
  totalCommittedMinor: string;
  totalUnbilledMinor: string;
};

/* ------------------------------------------------------------------ */
/* HELPERS — not exported. See the header.                             */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ `tx.execute` RETURNS EITHER AN ARRAY OR `{ rows }` DEPENDING ON THE
 * DRIVER PATH. Both shapes occur in this codebase (see
 * `server/actions/sales-inventory.ts`), and reading the wrong one gives
 * an empty result rather than an error — a cost report that silently
 * shows zero over-measured lines, which is exactly the reading somebody
 * wants to believe.
 */
function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

/** Numeric and bigint columns arrive as strings. Keep them that way. */
function str(value: unknown): string {
  if (value === null || value === undefined) return "0";
  return String(value);
}

function num(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

function isoDate(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

/**
 * Add two paise figures held as decimal strings, in BigInt.
 *
 * ⚠️ NOT `Number(a) + Number(b)`. A contract sum in paise passes 2^53 at
 * ₹90,071 crore, which sounds unreachable until somebody runs this over a
 * whole portfolio — and a total that has been through a float is wrong in
 * its last digits with no warning anywhere.
 */
function addMinor(a: string, b: string): string {
  try {
    return (BigInt(a || "0") + BigInt(b || "0")).toString();
  } catch {
    return a;
  }
}

/* ------------------------------------------------------------------ */
/* THE READ                                                            */
/* ------------------------------------------------------------------ */

export async function getCostControl(): Promise<ActionResult<CostControlView>> {
  try {
    const ctx = await requirePermission("construction.costs.read");

    const data = await withTenant(ctx.tenant.id, async (tx) => {
      /* ── 1 · OVER-MEASURED LINES ───────────────────────────────────
       *
       * ⚠️ THE VIEW ALREADY DOES THE HARD PART, AND IT IS NOT REDONE
       * HERE. `v_boq_consumption` compares against
       * `quantity + varied_quantity` — the AUTHORISED quantity, not the
       * original — and subtracts deduction entries rather than summing
       * them as positives. Recomputing either of those in TypeScript
       * would report every legitimately varied line as over-measured and
       * inflate every measured quantity by the volume of every window
       * opening on the job. The view is `security_invoker`, so RLS
       * applies to the caller.
       *
       * ⭐ THE VALUE OF THE EXCESS IS COMPUTED AT THE EFFECTIVE RATE —
       * the varied rate where a variation set one, otherwise the contract
       * rate. It is the number that turns "3.2 cum over" into a sentence
       * a project manager acts on.
       */
      const overMeasuredRows = rowsOf(
        await tx.execute(sql`
          SELECT
            c.boq_item_id,
            c.item_code,
            c.description,
            c.uom::text                                    AS uom,
            c.authorised_quantity_scaled,
            c.measured_quantity_scaled,
            (c.measured_quantity_scaled - c.authorised_quantity_scaled)
                                                           AS excess_scaled,
            COALESCE(i.varied_rate_minor, i.rate_minor)    AS rate_minor,
            ROUND(
              (c.measured_quantity_scaled - c.authorised_quantity_scaled)::numeric
              * COALESCE(i.varied_rate_minor, i.rate_minor)::numeric
              / 1000000
            )::bigint                                      AS excess_value_minor,
            b.code                                         AS boq_code,
            b.work_package,
            b.project_id,
            p.name                                         AS project_name,
            v.legal_name                                   AS contractor_name
          FROM v_boq_consumption c
          JOIN boq_items i
            ON i.id = c.boq_item_id AND i.tenant_id = c.tenant_id
          JOIN boqs b
            ON b.id = c.boq_id AND b.tenant_id = c.tenant_id
          LEFT JOIN projects p
            ON p.id = b.project_id AND p.tenant_id = b.tenant_id
          LEFT JOIN vendors v
            ON v.id = b.contractor_vendor_id AND v.tenant_id = b.tenant_id
          WHERE c.tenant_id = ${ctx.tenant.id}
            AND c.is_over_measured
          ORDER BY excess_value_minor DESC NULLS LAST
          LIMIT 60
        `),
      );

      /* ── 2 · MEASURED, NOT REJECTED, ON NO BILL ────────────────────
       *
       * ⚠️ THE DEDUCTION SIGN AGAIN. A void, an opening or a cut-out is
       * recorded as a deduction row; summing it as a positive overstates
       * the unbilled liability by the volume of every one of them.
       *
       * ⚠️ `status <> 'rejected'` RATHER THAN `status = 'checked'`.
       * Recorded-but-unchecked work is still work that has been done and
       * will be billed. Counting only checked entries would report a
       * comfortable figure that shrinks every time somebody does their
       * job.
       */
      const unbilledRows = rowsOf(
        await tx.execute(sql`
          SELECT
            b.project_id,
            p.name                                          AS project_name,
            COUNT(*)::int                                   AS entries,
            MIN(e.measured_on)                              AS oldest_measured_on,
            COALESCE(SUM(
              ROUND(
                (CASE WHEN e.is_deduction
                      THEN -e.quantity_scaled
                      ELSE e.quantity_scaled END)::numeric
                * COALESCE(i.varied_rate_minor, i.rate_minor)::numeric
                / 1000000
              )
            ), 0)::bigint                                   AS value_minor
          FROM measurement_entries e
          JOIN boq_items i
            ON i.id = e.boq_item_id AND i.tenant_id = e.tenant_id
          JOIN boqs b
            ON b.id = i.boq_id AND b.tenant_id = i.tenant_id
          LEFT JOIN projects p
            ON p.id = b.project_id AND p.tenant_id = b.tenant_id
          WHERE e.tenant_id = ${ctx.tenant.id}
            AND e.ra_bill_id IS NULL
            AND e.status <> 'rejected'
          GROUP BY b.project_id, p.name
          HAVING COUNT(*) > 0
          ORDER BY value_minor DESC
          LIMIT 50
        `),
      );

      /* ── 3 · THE PROJECT ROLL-UP ───────────────────────────────────
       *
       * ⚠️ DRAFT AND SUPERSEDED BOQs ARE EXCLUDED FROM THE CONTRACT SUM.
       * A draft is a price nobody has agreed and a superseded version is
       * a price that has been replaced — including either one counts the
       * same scope twice and produces a budget that is comfortably,
       * invisibly too large.
       *
       * ⚠️ CERTIFIED IS `certified | approved | paid`, NOT `paid`.
       * The engineer's certificate is the moment the money is owed;
       * payment is a treasury event that happens later and sometimes much
       * later. Reporting only what has been paid understates the position
       * by exactly the amount of everything in the payment queue.
       *
       * ⚠️ RETENTION IS NETTED AGAINST `retention_releases`, joined
       * through `works_contracts` because a release is recorded against
       * the CONTRACT and not the project. Gross retention on a job where
       * half has already been released is a number that makes somebody
       * think they are holding leverage they gave up last quarter.
       */
      const projectRows = rowsOf(
        await tx.execute(sql`
          WITH boq_totals AS (
            SELECT project_id,
                   COUNT(*)::int                                AS boq_count,
                   COALESCE(SUM(original_sum_minor), 0)::bigint  AS original_minor,
                   COALESCE(SUM(variation_sum_minor), 0)::bigint AS variation_minor,
                   COALESCE(SUM(revised_sum_minor), 0)::bigint   AS revised_minor
              FROM boqs
             WHERE tenant_id = ${ctx.tenant.id}
               AND status IN ('issued', 'closed')
             GROUP BY project_id
          ),
          bill_totals AS (
            SELECT project_id,
                   COALESCE(SUM(gross_value_minor)
                     FILTER (WHERE status IN ('certified','approved','paid')), 0)::bigint
                                                                AS certified_minor,
                   COALESCE(SUM(gross_value_minor)
                     FILTER (WHERE status IN ('draft','submitted')), 0)::bigint
                                                                AS pending_minor,
                   COUNT(*) FILTER (WHERE status IN ('draft','submitted'))::int
                                                                AS pending_bills,
                   COALESCE(SUM(net_payable_minor)
                     FILTER (WHERE status = 'paid'), 0)::bigint  AS paid_minor,
                   COALESCE(SUM(retention_amount_minor)
                     FILTER (WHERE status IN ('certified','approved','paid')), 0)::bigint
                                                                AS retention_minor
              FROM ra_bills
             WHERE tenant_id = ${ctx.tenant.id}
               AND project_id IS NOT NULL
             GROUP BY project_id
          ),
          release_totals AS (
            SELECT wc.project_id,
                   COALESCE(SUM(r.amount_minor), 0)::bigint      AS released_minor
              FROM retention_releases r
              JOIN works_contracts wc
                ON wc.id = r.contract_id AND wc.tenant_id = r.tenant_id
             WHERE r.tenant_id = ${ctx.tenant.id}
               AND wc.project_id IS NOT NULL
             GROUP BY wc.project_id
          ),
          purchase_totals AS (
            SELECT project_id,
                   COALESCE(SUM(total_minor), 0)::bigint         AS committed_minor
              FROM purchase_invoices
             WHERE tenant_id = ${ctx.tenant.id}
               AND project_id IS NOT NULL
               AND status IN ('recorded', 'approved', 'paid')
             GROUP BY project_id
          ),
          unbilled_totals AS (
            SELECT b.project_id,
                   COALESCE(SUM(
                     ROUND(
                       (CASE WHEN e.is_deduction
                             THEN -e.quantity_scaled
                             ELSE e.quantity_scaled END)::numeric
                       * COALESCE(i.varied_rate_minor, i.rate_minor)::numeric
                       / 1000000
                     )
                   ), 0)::bigint                                 AS unbilled_minor
              FROM measurement_entries e
              JOIN boq_items i
                ON i.id = e.boq_item_id AND i.tenant_id = e.tenant_id
              JOIN boqs b
                ON b.id = i.boq_id AND b.tenant_id = i.tenant_id
             WHERE e.tenant_id = ${ctx.tenant.id}
               AND e.ra_bill_id IS NULL
               AND e.status <> 'rejected'
             GROUP BY b.project_id
          ),
          over_totals AS (
            SELECT b.project_id,
                   COUNT(*)::int                                 AS over_lines
              FROM v_boq_consumption c
              JOIN boqs b ON b.id = c.boq_id AND b.tenant_id = c.tenant_id
             WHERE c.tenant_id = ${ctx.tenant.id}
               AND c.is_over_measured
             GROUP BY b.project_id
          )
          SELECT
            p.id                                                 AS project_id,
            p.code,
            p.name,
            p.is_active,
            COALESCE(bq.boq_count, 0)                            AS boq_count,
            COALESCE(bq.original_minor, 0)                       AS original_minor,
            COALESCE(bq.variation_minor, 0)                      AS variation_minor,
            COALESCE(bq.revised_minor, 0)                        AS revised_minor,
            COALESCE(bl.certified_minor, 0)                      AS certified_minor,
            COALESCE(bl.pending_minor, 0)                        AS pending_minor,
            COALESCE(bl.pending_bills, 0)                        AS pending_bills,
            COALESCE(bl.paid_minor, 0)                           AS paid_minor,
            GREATEST(
              COALESCE(bl.retention_minor, 0) - COALESCE(rl.released_minor, 0),
              0
            )                                                    AS retention_held_minor,
            COALESCE(pu.committed_minor, 0)                      AS committed_purchase_minor,
            COALESCE(ub.unbilled_minor, 0)                       AS unbilled_minor,
            COALESCE(ov.over_lines, 0)                           AS over_lines
          FROM projects p
          LEFT JOIN boq_totals      bq ON bq.project_id = p.id
          LEFT JOIN bill_totals     bl ON bl.project_id = p.id
          LEFT JOIN release_totals  rl ON rl.project_id = p.id
          LEFT JOIN purchase_totals pu ON pu.project_id = p.id
          LEFT JOIN unbilled_totals ub ON ub.project_id = p.id
          LEFT JOIN over_totals     ov ON ov.project_id = p.id
          WHERE p.tenant_id = ${ctx.tenant.id}
            AND p.deleted_at IS NULL
            /* ⚠️ PROJECTS WITH NO COST AT ALL ARE OMITTED, NOT SHOWN AS
               ZERO. A sales workspace has forty projects and no BOQs, and
               forty rows of zeroes teach the reader that this screen has
               nothing to say. */
            AND (bq.project_id IS NOT NULL
              OR bl.project_id IS NOT NULL
              OR pu.project_id IS NOT NULL)
          ORDER BY COALESCE(bq.revised_minor, 0) DESC
          LIMIT 200
        `),
      );

      return { overMeasuredRows, unbilledRows, projectRows };
    });

    const overMeasured: OverMeasuredLine[] = data.overMeasuredRows.map((r) => ({
      boqItemId: String(r.boq_item_id),
      itemCode: String(r.item_code ?? ""),
      description: String(r.description ?? ""),
      uom: String(r.uom ?? ""),
      authorisedScaled: str(r.authorised_quantity_scaled),
      measuredScaled: str(r.measured_quantity_scaled),
      excessScaled: str(r.excess_scaled),
      rateMinor: str(r.rate_minor),
      excessValueMinor: str(r.excess_value_minor),
      boqCode: String(r.boq_code ?? ""),
      workPackage: String(r.work_package ?? ""),
      projectId: text(r.project_id),
      projectName: text(r.project_name),
      contractorName: text(r.contractor_name),
    }));

    const unbilled: UnbilledMeasurement[] = data.unbilledRows.map((r) => ({
      projectId: text(r.project_id),
      projectName: text(r.project_name),
      entries: num(r.entries),
      valueMinor: str(r.value_minor),
      oldestMeasuredOn: isoDate(r.oldest_measured_on),
    }));

    const projects: ProjectCostRow[] = data.projectRows.map((r) => ({
      projectId: String(r.project_id),
      code: String(r.code ?? ""),
      name: String(r.name ?? ""),
      isActive: Boolean(r.is_active),
      boqCount: num(r.boq_count),
      originalMinor: str(r.original_minor),
      variationMinor: str(r.variation_minor),
      revisedMinor: str(r.revised_minor),
      certifiedMinor: str(r.certified_minor),
      pendingMinor: str(r.pending_minor),
      pendingBills: num(r.pending_bills),
      paidMinor: str(r.paid_minor),
      retentionHeldMinor: str(r.retention_held_minor),
      committedPurchaseMinor: str(r.committed_purchase_minor),
      unbilledMinor: str(r.unbilled_minor),
      overMeasuredLines: num(r.over_lines),
    }));

    return {
      ok: true,
      data: {
        overMeasured,
        unbilled,
        projects,
        totalRevisedMinor: projects.reduce((t, p) => addMinor(t, p.revisedMinor), "0"),
        totalCertifiedMinor: projects.reduce(
          (t, p) => addMinor(t, p.certifiedMinor),
          "0",
        ),
        totalCommittedMinor: projects.reduce(
          (t, p) => addMinor(t, p.committedPurchaseMinor),
          "0",
        ),
        totalUnbilledMinor: projects.reduce((t, p) => addMinor(t, p.unbilledMinor), "0"),
      },
    };
  } catch (err) {
    return toSalesActionError(err, "getCostControl");
  }
}

/* ------------------------------------------------------------------ */
/* ⭐ BILLING POSITION — per BOQ LINE, v0.68.0                          */
/* ------------------------------------------------------------------ */

/**
 * One BOQ line: what was authorised, what was measured, what has been
 * claimed on bills.
 *
 * ⚠️ QUANTITIES HERE ARE REAL, NOT MICRO-UNITS — unlike everything above
 * in this file. `v_boq_billing_position` divides by 1e6 once, in SQL,
 * because it has to compare `boq_items.quantity_scaled` (micro-units)
 * against `ra_bill_lines.quantity` (numeric(18,3)) to exist at all. Doing
 * that conversion twice, in two languages, is how the two sides end up
 * disagreeing by a factor of a million — and the failure is silent,
 * because everything simply looks reassuringly small.
 */
export type BillingPositionLine = {
  boqItemId: string;
  boqCode: string;
  itemCode: string | null;
  description: string | null;
  uom: string | null;
  projectId: string | null;
  projectName: string | null;
  contractNo: string | null;
  /** Original + approved variations. Real units, 3 dp, as a string. */
  authorisedQty: string;
  measuredQty: string;
  billedQty: string;
  /** Paise per unit — the varied rate where a variation set one. */
  rateMinor: string;
  billedMinor: string;
  /** ⭐ Measured, not yet claimed. The contractor's money sitting idle. */
  measuredNotBilledMinor: string;
  /** ⚠️ Claimed beyond what was measured. Look here first, every time. */
  billedOverMeasuredQty: string;
};

export type BillingPositionView = {
  /** Lines where more has been claimed than measured. Leads, always. */
  overClaimed: BillingPositionLine[];
  /** Lines with measured work nobody has billed for. */
  unclaimed: BillingPositionLine[];
  /**
   * ⚠️ HOW MANY BOQs ARE NOT LINKED TO A CONTRACT AND SO ARE ABSENT FROM
   * THE TWO LISTS ABOVE. Reported rather than hidden: a report that
   * silently omits work is read as "nothing to see", which is the one
   * conclusion it has not earned.
   */
  unlinkedBoqs: number;
  totalOverClaimedLines: number;
  totalUnclaimedMinor: string;
};

/**
 * Read the per-line billing position.
 *
 * Complements `getCostControl()`, which rolls up to the project and
 * includes every BOQ. This one is per LINE and only covers lines whose
 * bill entries carry a `boq_item_id` — see the header.
 */
export async function getBillingPosition(): Promise<ActionResult<BillingPositionView>> {
  try {
    const ctx = await requirePermission("construction.costs.read");

    const data = await withTenant(ctx.tenant.id, async (tx) => {
      /*
       * ⚠️ THE VIEW IS `security_invoker = true`, SO RLS APPLIES TO THE
       * CALLER — and the explicit `tenant_id` predicate is kept anyway,
       * as it is everywhere else in this codebase. Two independent
       * layers, either sufficient alone.
       */
      const overClaimedRows = rowsOf(
        await tx.execute(sql`
          SELECT bp.*, p.name AS project_name, wc.contract_no
            FROM v_boq_billing_position bp
            LEFT JOIN projects p
              ON p.id = bp.project_id AND p.tenant_id = bp.tenant_id
            LEFT JOIN works_contracts wc
              ON wc.id = bp.contract_id AND wc.tenant_id = bp.tenant_id
           WHERE bp.tenant_id = ${ctx.tenant.id}
             AND bp.billed_over_measured_qty > 0
           ORDER BY bp.billed_over_measured_qty DESC
           LIMIT 60
        `),
      );

      const unclaimedRows = rowsOf(
        await tx.execute(sql`
          SELECT bp.*, p.name AS project_name, wc.contract_no
            FROM v_boq_billing_position bp
            LEFT JOIN projects p
              ON p.id = bp.project_id AND p.tenant_id = bp.tenant_id
            LEFT JOIN works_contracts wc
              ON wc.id = bp.contract_id AND wc.tenant_id = bp.tenant_id
           WHERE bp.tenant_id = ${ctx.tenant.id}
             AND bp.measured_not_billed_minor > 0
           ORDER BY bp.measured_not_billed_minor DESC
           LIMIT 60
        `),
      );

      /*
       * ⚠️ COUNTED AND REPORTED, NOT FILTERED AWAY. These BOQs have no
       * contract link, so nothing above can reason about them. Saying
       * how many there are is the difference between "no problems found"
       * and "no problems found in the part I could see".
       */
      const unlinkedRows = rowsOf(
        await tx.execute(sql`
          SELECT count(*)::int AS n
            FROM boqs
           WHERE tenant_id = ${ctx.tenant.id}
             AND contract_id IS NULL
        `),
      );

      return { overClaimedRows, unclaimedRows, unlinkedRows };
    });

    const toLine = (r: Record<string, unknown>): BillingPositionLine => ({
      boqItemId: str(r.boq_item_id),
      boqCode: str(r.boq_code),
      itemCode: text(r.item_code),
      description: text(r.description),
      uom: text(r.uom),
      projectId: text(r.project_id),
      projectName: text(r.project_name),
      contractNo: text(r.contract_no),
      authorisedQty: str(r.authorised_qty),
      measuredQty: str(r.measured_qty),
      billedQty: str(r.billed_qty),
      rateMinor: str(r.rate_minor),
      billedMinor: str(r.billed_minor),
      measuredNotBilledMinor: str(r.measured_not_billed_minor),
      billedOverMeasuredQty: str(r.billed_over_measured_qty),
    });

    const overClaimed = data.overClaimedRows.map(toLine);
    const unclaimed = data.unclaimedRows.map(toLine);

    return {
      ok: true,
      data: {
        overClaimed,
        unclaimed,
        unlinkedBoqs: num(data.unlinkedRows[0]?.n),
        totalOverClaimedLines: overClaimed.length,
        totalUnclaimedMinor: unclaimed.reduce(
          (t, l) => addMinor(t, l.measuredNotBilledMinor),
          "0",
        ),
      },
    };
  } catch (err) {
    return toSalesActionError(err, "getBillingPosition");
  }
}
