import "server-only";

/**
 * Ordence — ⭐⭐⭐ IS THIS MONTH SAFE TO SEAL?
 * Version: v1.27.0-alpha · Batch 19
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ ONE QUESTION, ASKED THE SAME WAY OF EVERY DOCUMENT TABLE
 * ══════════════════════════════════════════════════════════════════════
 * Every posting in this product writes a transaction whose number is
 * `SALES:<TAG>:<documentId>` — that is what makes posting idempotent.
 *
 * ⭐ WHICH MEANS "IS THIS DOCUMENT IN THE LEDGER" IS ANSWERABLE FOR ANY
 *   TABLE WITHOUT A BOOLEAN ON IT. A left join from the document to a
 *   transaction with the key it would have had is the whole check.
 *
 * ⚠️ AND THAT IS BETTER THAN A `posted` COLUMN PER TABLE, which is what
 * this would otherwise need. A boolean can drift from the ledger — set
 * by a code path that later failed, cleared by a fix-up script, true for
 * a transaction somebody reversed. The join cannot: it asks the ledger.
 *
 * 🔴 IT ALSO DEPENDS ON THE TAGS BEING RIGHT, which is how the
 * `vendor_payment` defect was found while writing this file. It had been
 * carrying the customer-receipt tag since v1.11.0, so this check would
 * have looked for `SALES:RCP:<id>` under the name of a receipt and
 * reported every vendor payment in the period as unposted.
 */

import { and, eq, sql } from "drizzle-orm";
import { withTenant } from "@/db";
/**
 * ⚠️ ONLY THE TABLES QUERIED THROUGH DRIZZLE ARE IMPORTED. The six in
 * `SOURCES` are reached by name in SQL, because the join is on a key
 * built by string concatenation and there is no Drizzle expression for
 * that. Importing them here as well would look like they were used and
 * hide which set is which.
 */
import {
  bookings,
  channelPartnerCommissions,
  payrollRuns,
  gstReturns,
} from "@/db/schema";
import type { CloseBlocker } from "@/lib/accounting/close-checklist";

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

export type Period = { startDate: string; endDate: string };

/**
 * ⚠️ THE SHAPE EVERY PROBE RETURNS. Counting and dating in SQL rather
 * than pulling rows: a period with four hundred unposted documents is a
 * period somebody has neglected for a year, and this page must still
 * render in that case.
 */
type Probe = { count: number; oldest: string | null; total: string | null };

/**
 * ⚠️ THE LEFT JOIN IS ON THE KEY, and the key is built in SQL rather
 * than imported, because the join has to happen in the database. The
 * tags are duplicated from `SALES_KEY_TAGS` and a test asserts the two
 * agree — a mismatch here would report every document of that kind as
 * unposted, which is the loudest possible failure and still worth
 * catching in CI rather than on a Monday morning.
 */
async function unpostedProbe(
  tx: Tx,
  args: {
    tenantId: string;
    table: string;
    dateColumn: string;
    /** SQL fragment restricting to documents that SHOULD have posted. */
    liveCondition: string;
    tags: readonly string[];
    amountColumn?: string;
    period: Period;
  },
): Promise<Probe> {
  /**
   * ══════════════════════════════════════════════════════════════════
   * 🔴 IDENTIFIERS ARE RAW, VALUES ARE PARAMETERS, AND NEVER THE OTHER
   *    WAY ROUND
   * ══════════════════════════════════════════════════════════════════
   * The table name, the column names and the key tags come from the
   * `SOURCES` constant in this file — they are literals in source code
   * and cannot be anything else, so they have to be `sql.raw` because
   * Postgres will not take an identifier as a parameter.
   *
   * ⚠️ THE TENANT ID AND THE DATES ARE PARAMETERS, and the first draft
   * of this function interpolated the tenant id into the raw string.
   * It came from `ctx.tenant.id` and is a uuid, so it was not
   * exploitable — and it was still wrong, because the property that
   * makes it safe lives three files away and the next person to reuse
   * this helper would not know it was load-bearing.
   *
   * ⭐ A QUERY THAT IS SAFE BECAUSE OF WHERE ITS INPUT HAPPENS TO COME
   *   FROM IS ONE REFACTOR AWAY FROM NOT BEING SAFE.
   */
  const table = sql.raw(args.table);
  const dateCol = sql.raw(`d.${args.dateColumn}`);
  const live = sql.raw(args.liveCondition);
  const keyMatch = sql.raw(
    args.tags
      .map((t) => `t.transaction_number = 'SALES:${t}:' || d.id::text`)
      .join(" OR "),
  );
  const amount = sql.raw(
    args.amountColumn ? `COALESCE(SUM(d.${args.amountColumn}), 0)::text` : "NULL",
  );

  const result = (await tx.execute(sql`
      SELECT count(*)::int      AS count,
             MIN(${dateCol})::text AS oldest,
             ${amount}          AS total
        FROM ${table} d
        LEFT JOIN transactions t
               ON t.tenant_id = d.tenant_id
              AND (${keyMatch})
              AND t.status = 'posted'
       WHERE d.tenant_id = ${args.tenantId}::uuid
         AND ${dateCol} >= ${args.period.startDate}::date
         AND ${dateCol} <= ${args.period.endDate}::date
         AND (${live})
         AND t.id IS NULL
  `)) as { rows?: Probe[] } | Probe[];

  const list = Array.isArray(result) ? result : (result.rows ?? []);
  const first = list[0];
  return {
    count: Number(first?.count ?? 0),
    oldest: first?.oldest ?? null,
    total: first?.total ?? null,
  };
}

/* ------------------------------------------------------------------ */

type SourceSpec = {
  key: string;
  source: string;
  table: string;
  dateColumn: string;
  liveCondition: string;
  tags: readonly string[];
  amountColumn?: string;
  where: string;
  consequence: string;
};

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 EVERY `liveCondition` IS A JUDGEMENT AND IS WRITTEN DOWN
 * ══════════════════════════════════════════════════════════════════════
 * A draft is not a missing entry — it is a document nobody has issued,
 * and refusing a close over one would mean nobody could ever close a
 * month while a half-typed invoice sat in a form. A CANCELLED document
 * is not a missing entry either.
 *
 * ⚠️ THE LINE IS "HAS THIS BEEN ISSUED TO SOMEBODY OUTSIDE THE
 * COMPANY". Once a customer has an invoice, a vendor has a payment or a
 * broker has a bill, the economic event has happened and the ledger is
 * wrong until it says so.
 */
const SOURCES: readonly SourceSpec[] = [
  {
    key: "sales_invoices",
    source: "sales invoice",
    table: "sales_invoices",
    dateColumn: "invoice_date",
    /** Issued to a customer. A draft is not yet a supply. */
    liveCondition: "d.status IN ('issued','part_paid','paid')",
    tags: ["INV"],
    amountColumn: "total_minor",
    where: "/invoices",
    consequence:
      "The customer has the invoice and the ledger does not. Revenue and output tax " +
      "for this period are understated by that much, and the GSTR-1 was assembled " +
      "from documents the books do not contain.",
  },
  {
    key: "customer_receipts",
    source: "customer receipt",
    table: "customer_receipts",
    dateColumn: "received_on",
    /** ⚠️ A bounced cheque is not money and never posts. */
    liveCondition: "d.status IN ('pending','cleared')",
    tags: ["RCP"],
    amountColumn: "amount_minor",
    where: "/receivables",
    consequence:
      "Money arrived and the bank balance in the books does not show it. Every " +
      "customer statement printed from this period overstates what they owe.",
  },
  {
    key: "purchase_invoices",
    source: "purchase invoice",
    table: "purchase_invoices",
    dateColumn: "invoice_date",
    /**
     * ⚠️ `TRUE`, AND THAT IS NOT LAZINESS — `purchase_invoices` HAS NO
     * STATUS COLUMN.
     *
     * There is no draft state for a purchase invoice, because the
     * document is not one Ordence produces: it arrives from a vendor
     * already issued. A row existing IS the vendor having billed you, so
     * every row dated in the period belongs in the ledger.
     *
     * 🔴 Written down because the obvious guess is wrong. The first
     * version of this filtered on `d.status IN (...)`, which would have
     * thrown at query time — and the failure path above turns that into
     * a BLOCKING "could not check", so a wrong guess here refuses every
     * close rather than quietly passing them.
     */
    liveCondition: "TRUE",
    tags: ["PI"],
    amountColumn: "total_minor",
    where: "/purchases",
    consequence:
      "The cost is missing from the period and so is the input tax credit on it — so " +
      "the profit is overstated and the GSTR-3B claimed less credit than was available.",
  },
  {
    key: "ra_bills",
    source: "RA bill",
    table: "ra_bills",
    dateColumn: "period_to",
    /** ⚠️ Certified is the point of no return: the contractor has been told. */
    liveCondition: "d.status IN ('certified','approved','paid')",
    tags: ["RAB"],
    where: "/ra-bills",
    consequence:
      "A certified RA bill is work the contractor has been told they will be paid for. " +
      "Until it posts, the project cost and the retention held against it are both " +
      "missing from the period.",
  },
  {
    key: "vendor_payments",
    source: "vendor payment",
    table: "vendor_payments",
    dateColumn: "payment_date",
    liveCondition: "d.status NOT IN ('draft','cancelled')",
    /**
     * 🔴 BOTH TAGS, AND THIS IS THE DEFECT THIS FILE FOUND. Vendor
     * payments carried the customer-receipt tag from v1.11.0 until
     * v1.27.0-alpha. Checking only `VPY` would report every payment made
     * before the fix as unposted and block every close for a year.
     */
    tags: ["VPY", "RCP"],
    where: "/purchases",
    consequence:
      "Money left the bank and the books do not know. The vendor still shows as owed, " +
      "and the TDS withheld on the payment has not been recognised — which is what the " +
      "quarterly return is built from.",
  },
  {
    key: "demand_notices",
    source: "demand notice",
    table: "demand_notices",
    dateColumn: "notice_date",
    liveCondition: "d.status IN ('issued','part_paid','paid')",
    tags: ["DMD"],
    where: "/receivables",
    consequence:
      "A served demand raises a GST liability whether or not the buyer has paid — time " +
      "of supply is the earlier of the invoice or the payment. Until it posts, that " +
      "output tax is missing from the period it belongs to.",
  },
];

/* ------------------------------------------------------------------ */

export async function closeReadiness(
  tenantId: string,
  period: Period,
): Promise<CloseBlocker[]> {
  return withTenant(tenantId, async (tx) => {
    const blockers: CloseBlocker[] = [];

    for (const spec of SOURCES) {
      /**
       * ⚠️ A MISSING TABLE IS NOT A CLEAN PERIOD. If a probe throws —
       * a renamed column, a table this deployment does not have — the
       * honest answer is "I could not check", and it BLOCKS.
       *
       * 🔴 The alternative is a check that silently skips whatever it
       * cannot read and reports the month ready, which is the one
       * outcome worse than not having the check at all.
       */
      try {
        const probe = await unpostedProbe(tx, {
          tenantId,
          table: spec.table,
          dateColumn: spec.dateColumn,
          liveCondition: spec.liveCondition,
          tags: spec.tags,
          amountColumn: spec.amountColumn,
          period,
        });

        if (probe.count > 0) {
          blockers.push({
            key: spec.key,
            source: spec.source,
            severity: "blocking",
            count: probe.count,
            headline: `${probe.count} ${spec.source}${probe.count === 1 ? "" : "s"} dated in this period ${probe.count === 1 ? "is" : "are"} not in the ledger`,
            consequence: spec.consequence,
            where: spec.where,
            amountMinor: probe.total ? BigInt(probe.total) : null,
            oldest: probe.oldest ? probe.oldest.slice(0, 10) : null,
          });
        }
      } catch (error) {
        blockers.push({
          key: `${spec.key}:unreadable`,
          source: spec.source,
          severity: "blocking",
          count: 0,
          headline: `Could not check ${spec.source}s for this period`,
          consequence:
            "This check failed, so there may be documents from this period that are not " +
            "in the ledger. Sealing the month without knowing is the thing this screen " +
            "exists to prevent. " +
            (error instanceof Error ? error.message : "Unknown error"),
          where: spec.where,
          amountMinor: null,
          oldest: null,
        });
      }
    }

    blockers.push(...(await bookingCancellationBlockers(tx, tenantId, period)));
    blockers.push(...(await brokerageBlockers(tx, tenantId, period)));
    blockers.push(...(await payrollBlockers(tx, tenantId, period)));
    blockers.push(...(await depreciationBlockers(tx, tenantId, period)));
    blockers.push(...(await advisories(tx, tenantId, period)));

    return blockers;
  });
}

/* ------------------------------------------------------------------ */
/* THE ONES WITH THEIR OWN SHAPE                                       */
/* ------------------------------------------------------------------ */

async function bookingCancellationBlockers(
  tx: Tx,
  tenantId: string,
  period: Period,
): Promise<CloseBlocker[]> {
  const [row] = await tx
    .select({
      count: sql<number>`count(*)::int`,
      oldest: sql<string | null>`MIN(${bookings.cancelledAt})::date::text`,
    })
    .from(bookings)
    .where(
      and(
        eq(bookings.tenantId, tenantId),
        eq(bookings.status, "cancelled"),
        sql`${bookings.cancellationPostedAt} IS NULL`,
        sql`${bookings.cancelledAt}::date >= ${period.startDate}::date`,
        sql`${bookings.cancelledAt}::date <= ${period.endDate}::date`,
      ),
    );

  if (!row || row.count === 0) return [];
  return [
    {
      key: "cancellations",
      source: "booking cancellation",
      severity: "blocking",
      count: row.count,
      headline: `${row.count} booking cancellation${row.count === 1 ? "" : "s"} dated in this period ${row.count === 1 ? "is" : "are"} not in the ledger`,
      consequence:
        "Each one leaves the buyer's advance, their unpaid demands and the output tax " +
        "on a sale that did not happen standing in the books against somebody who has " +
        "gone. Sealing the month makes those balances permanent.",
      where: "/sales/cancellations",
      amountMinor: null,
      oldest: row.oldest,
    },
  ];
}

async function brokerageBlockers(
  tx: Tx,
  tenantId: string,
  period: Period,
): Promise<CloseBlocker[]> {
  const [row] = await tx
    .select({
      count: sql<number>`count(*)::int`,
      total: sql<string>`COALESCE(SUM(${channelPartnerCommissions.netPayableMinor}), 0)::text`,
      oldest: sql<string | null>`MIN(${channelPartnerCommissions.creditedOn})::text`,
    })
    .from(channelPartnerCommissions)
    .where(
      and(
        eq(channelPartnerCommissions.tenantId, tenantId),
        /** ⚠️ Approved only. A draft brokerage bill is a proposal. */
        eq(channelPartnerCommissions.status, "approved"),
        sql`${channelPartnerCommissions.creditedOn} >= ${period.startDate}::date`,
        sql`${channelPartnerCommissions.creditedOn} <= ${period.endDate}::date`,
      ),
    );

  if (!row || row.count === 0) return [];
  return [
    {
      key: "brokerage",
      source: "brokerage bill",
      severity: "blocking",
      count: row.count,
      headline: `${row.count} approved brokerage bill${row.count === 1 ? "" : "s"} credited in this period ${row.count === 1 ? "is" : "are"} not in the ledger`,
      consequence:
        "The selling cost is missing from the period and so is the section 194H " +
        "liability withheld from the brokers — which is what the quarterly TDS return " +
        "and their Form 16A are built from.",
      where: "/sales/brokerage",
      amountMinor: BigInt(row.total || "0"),
      oldest: row.oldest,
    },
  ];
}

async function payrollBlockers(
  tx: Tx,
  tenantId: string,
  period: Period,
): Promise<CloseBlocker[]> {
  const [row] = await tx
    .select({
      count: sql<number>`count(*)::int`,
      oldest: sql<string | null>`MIN(${payrollRuns.periodStart})::text`,
    })
    .from(payrollRuns)
    .where(
      and(
        eq(payrollRuns.tenantId, tenantId),
        eq(payrollRuns.status, "approved"),
        sql`${payrollRuns.periodEnd} >= ${period.startDate}::date`,
        sql`${payrollRuns.periodEnd} <= ${period.endDate}::date`,
      ),
    );

  if (!row || row.count === 0) return [];
  return [
    {
      key: "payroll",
      source: "payroll run",
      severity: "blocking",
      count: row.count,
      headline: `${row.count} approved payroll run${row.count === 1 ? "" : "s"} for this period ${row.count === 1 ? "is" : "are"} not in the ledger`,
      consequence:
        "🔴 The single largest entry most months, and five statutory liabilities come " +
        "with it. Provident fund, pension, ESI, professional tax and salary TDS are all " +
        "created by the payroll journal — seal the month without it and every one of " +
        "them reads as nil for a month in which they were genuinely owed.",
      where: "/payroll",
      amountMinor: null,
      oldest: row.oldest,
    },
  ];
}

/* ------------------------------------------------------------------ */
/* ⭐⭐ DEPRECIATION — Batch 100, v1.53.0-alpha                          */
/* ------------------------------------------------------------------ */

/**
 * ⭐ TWO QUESTIONS, AND THEY HAVE DIFFERENT SEVERITIES ON PURPOSE.
 *
 * ① A DEPRECIATION RUN COMPUTED FOR THIS PERIOD AND NEVER POSTED IS
 *    BLOCKING. Somebody produced the figure, looked at it and stopped.
 *    Sealing the month makes it unpostable where it belongs, which is the
 *    exact stranding this whole screen exists to prevent.
 *
 * ② A PERIOD WITH ASSETS IN USE AND NO RUN AT ALL IS ADVISORY, AND THIS
 *    IS A DELIBERATE JUDGEMENT RATHER THAN A SOFTER VERSION OF THE SAME
 *    THING. Plenty of Indian companies charge depreciation once a year at
 *    31 March and close eleven months without it, which is a presentation
 *    choice rather than an error. Blocking every one of those closes
 *    would turn this check into a click — and, as `close-checklist.ts`
 *    says at the top, an override that becomes routine is worse than no
 *    check, because it converts a refusal into a habit and leaves a
 *    record saying somebody considered it.
 *
 * ⚠️ THE ADVISORY IS SUPPRESSED WHERE THE REGISTER IS EMPTY. A workspace
 * that has capitalised nothing is not missing a depreciation charge, and
 * a permanent advisory nobody can clear teaches people to ignore the
 * list.
 */
async function depreciationBlockers(
  tx: Tx,
  tenantId: string,
  period: Period,
): Promise<CloseBlocker[]> {
  const out: CloseBlocker[] = [];

  const unposted = await tx.execute(sql`
    SELECT count(*)::int                 AS count,
           MIN(period_end)::text         AS oldest,
           COALESCE(SUM(total_charge_minor), 0)::text AS total
      FROM depreciation_runs
     WHERE tenant_id = ${tenantId}::uuid
       AND basis = 'companies_act'
       AND status = 'computed'
       AND period_end >= ${period.startDate}::date
       AND period_end <= ${period.endDate}::date
  `);
  const unpostedRows = (Array.isArray(unposted)
    ? unposted
    : ((unposted as { rows?: unknown[] }).rows ?? [])) as Array<{
    count?: number;
    oldest?: string | null;
    total?: string | null;
  }>;
  const u = unpostedRows[0];

  if (u && Number(u.count ?? 0) > 0) {
    out.push({
      key: "depreciation_unposted",
      source: "depreciation run",
      severity: "blocking",
      count: Number(u.count),
      headline: `Depreciation for this period has been computed and not posted`,
      consequence:
        "The charge exists as a working and not as an entry, so this period's profit is overstated " +
        "by the whole of it and the fixed asset register no longer agrees with the balance sheet. " +
        "Sealing the month makes the run unpostable where it belongs — the period lock will refuse it.",
      where: "/fixed-assets",
      amountMinor: u.total ? BigInt(u.total) : null,
      oldest: u.oldest ? String(u.oldest).slice(0, 10) : null,
    });
    return out;
  }

  /**
   * ⚠️ "IN USE DURING THE PERIOD" IS THE TEST, not "exists". An asset
   * bought after the period end is not missing a charge.
   */
  const none = await tx.execute(sql`
    SELECT count(*)::int AS count
      FROM fixed_assets
     WHERE tenant_id = ${tenantId}::uuid
       AND put_to_use_on <= ${period.endDate}::date
       AND (disposed_on IS NULL OR disposed_on >= ${period.startDate}::date)
       AND NOT EXISTS (
         SELECT 1 FROM depreciation_runs r
          WHERE r.tenant_id = fixed_assets.tenant_id
            AND r.basis = 'companies_act'
            AND r.status = 'posted'
            AND r.period_start <= ${period.endDate}::date
            AND r.period_end   >= ${period.startDate}::date
       )
  `);
  const noneRows = (Array.isArray(none)
    ? none
    : ((none as { rows?: unknown[] }).rows ?? [])) as Array<{ count?: number }>;
  const n = Number(noneRows[0]?.count ?? 0);

  if (n > 0) {
    out.push({
      key: "depreciation_not_run",
      source: "fixed asset",
      severity: "advisory",
      count: n,
      headline: `${n} fixed asset${n === 1 ? "" : "s"} ${n === 1 ? "was" : "were"} in use in this period and no depreciation has been posted for it`,
      consequence:
        "Not necessarily wrong — depreciation may be charged annually at 31 March rather than monthly. " +
        "But if this period is meant to carry a charge, the profit reported for it is overstated by the " +
        "whole of it, and Schedule II of the Companies Act 2013 requires the charge for the period the " +
        "assets were used in.",
      where: "/fixed-assets",
      amountMinor: null,
      oldest: null,
    });
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* ⚠️ ADVISORIES — REAL, AND NOT A REASON TO REFUSE                    */
/* ------------------------------------------------------------------ */

async function advisories(
  tx: Tx,
  tenantId: string,
  period: Period,
): Promise<CloseBlocker[]> {
  const out: CloseBlocker[] = [];

  const [ret] = await tx
    .select({
      count: sql<number>`count(*)::int`,
      oldest: sql<string | null>`MIN(${gstReturns.taxPeriod})`,
    })
    .from(gstReturns)
    .where(
      and(
        eq(gstReturns.tenantId, tenantId),
        sql`${gstReturns.status} IN ('draft','finalised')`,
        sql`${gstReturns.periodEnd} <= ${period.endDate}::date`,
      ),
    );

  if (ret && ret.count > 0) {
    out.push({
      key: "returns_unfiled",
      source: "GST return",
      /**
       * ⚠️ ADVISORY, NOT BLOCKING, AND THE DISTINCTION IS EXACT. An
       * unfiled return does not make the LEDGER wrong — the output tax
       * is already posted from the invoices. It makes the DEPARTMENT's
       * copy missing, which is a late fee rather than a false
       * attestation, and refusing a close over it would be this screen
       * overstepping.
       */
      severity: "advisory",
      count: ret.count,
      headline: `${ret.count} GST return${ret.count === 1 ? "" : "s"} up to this period ${ret.count === 1 ? "is" : "are"} not filed`,
      consequence:
        "The books are not wrong — the output tax is already posted from the invoices. " +
        "What is missing is the filing, which carries a late fee per day and interest " +
        "at 18% a year. Closing the month does not make it worse.",
      where: "/gst/gstr3b",
      amountMinor: null,
      oldest: ret.oldest,
    });
  }

  return out;
}
