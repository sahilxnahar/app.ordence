import "server-only";

/**
 * Ordence — Receivables Reads
 * Version: v0.38.0-alpha
 *
 * The thin database layer under `server/actions/receivables.ts`. Every
 * query goes through `withTenant`, so row-level security is applied by
 * the database and not by a `WHERE tenant_id = …` somebody can forget.
 *
 * ⚠️ NOTHING HERE DECIDES ANYTHING. The interest arithmetic, the ageing
 * boundaries, the allocation split and the dunning ladder all live in
 * `lib/receivables/`, which has no database import and is therefore
 * testable without one. This file loads rows and hands them over. The
 * split is what stops a rule being written twice — once in the engine and
 * once, subtly differently, in a SQL predicate.
 *
 * ⚠️ AND IT IS WHY THE AGEING BUCKETS ARE NOT COMPUTED IN SQL. A
 * `CASE WHEN now() - due_date <= 30` in a query would be a second
 * definition of a boundary that this product has written down once, in
 * `lib/receivables/ageing.ts`, with the reasoning about day 30 and day 90
 * attached. Two definitions of "61-90 days" is how an account appears in
 * an escalation list and not in the report the same person read an hour
 * earlier.
 */

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import {
  demandNotices,
  dunningEvents,
  dunningPolicies,
  receiptAllocations,
  receipts,
  receivablePolicies,
  type DemandNotice,
  type DunningEvent,
  type DunningPolicy,
  type Receipt,
  type ReceiptAllocation,
  type ReceivablePolicy,
} from "@/db/schema/receivables";
import { bookings, leads, paymentMilestones, projects, units } from "@/db/schema/sales";
import { toBigIntAmount } from "@/lib/billing/money";
import {
  DEFAULT_DUNNING_POLICY,
  type DunningLadderPolicy,
} from "@/lib/receivables/dunning";
import { demandPosition, type DemandFacts } from "@/lib/receivables/demand";
import type { OpenDemand } from "@/lib/receivables/allocation";
import type { AgeingRow } from "@/lib/receivables/ageing";
import type { InterestTerms } from "@/lib/receivables/interest";
import type { DemandPolicyTerms } from "@/lib/receivables/demand";

/* ------------------------------------------------------------------ */
/* POLICIES                                                            */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ THE FALLBACK CHAIN IS PROJECT → WORKSPACE → BUILT-IN, AND THE
 * BUILT-IN IS NOT A GUESS.
 *
 * `DEFAULT_RECEIVABLE_TERMS` charges interest at the RERA reference rate
 * itself — SBI's highest MCLR plus 2% — because that is the only rate
 * that is symmetric by construction under Section 2(za), and a product
 * whose out-of-the-box default was 18% would be shipping a flagged
 * position to every workspace that never opened the settings page.
 *
 * ⚠️ THE MARGIN IS PRESCRIBED BY THE STATE'S RULES under s.84 read with
 * s.2(za), and it is NOT the same in every State — some prescribe plus
 * 2%, others plus 1%. This is a starting point a workspace overrides, and
 * never a statement about any particular State's rules. See
 * `lib/receivables/rera-state.ts` for what is Central and what is not.
 */
export const DEFAULT_RECEIVABLE_TERMS: DemandPolicyTerms = Object.freeze({
  demandDueDays: 15,
  gstRateBps: 500,
  interestRateBps: 1110,
  referenceRateBps: 1110,
  compounding: "simple",
  dayCount: "actual_365",
  graceDays: 0,
  graceForgivesElapsedDays: false,
});

export type ResolvedPolicies = {
  receivable: DemandPolicyTerms;
  receivablePolicyId: string | null;
  dunning: DunningLadderPolicy;
  dunningPolicyId: string | null;
  appropriationOrder: "interest_first" | "principal_first";
  defaultStrategy: "oldest_first" | "specified";
};

/**
 * ⭐ THE TWO POLICY TABLES, LOADED ONCE.
 *
 * ⚠️ SPLIT OUT SO A SCREEN THAT RESOLVES POLICIES FOR FIFTY DEMANDS DOES
 * NOT RUN A HUNDRED QUERIES. `resolvePolicies` reads every active policy
 * row for the workspace and then picks in memory — so calling it per
 * demand was never reading different data, it was reading the same data
 * fifty times. The ladder board does exactly that, and it is the screen
 * somebody is waiting in front of.
 */
export type PolicySets = {
  receivable: ReceivablePolicy[];
  dunning: DunningPolicy[];
};

export async function loadPolicySets(tenantId: string): Promise<PolicySets> {
  const [receivable, dunning] = await withTenant(tenantId, async (tx) => [
    await tx
      .select()
      .from(receivablePolicies)
      .where(
        and(
          eq(receivablePolicies.tenantId, tenantId),
          eq(receivablePolicies.isActive, true),
        ),
      ),
    await tx
      .select()
      .from(dunningPolicies)
      .where(
        and(eq(dunningPolicies.tenantId, tenantId), eq(dunningPolicies.isActive, true)),
      ),
  ]);
  return { receivable, dunning };
}

/**
 * ⭐ THE FALLBACK CHAIN IS PROJECT → WORKSPACE → BUILT-IN.
 *
 * 🔴 PURE. It picks; it does not query. `resolvePolicies` is the thin
 * wrapper that loads and then picks, so the two can never disagree about
 * which policy wins.
 */
export function resolvePoliciesFrom(
  sets: PolicySets,
  projectId: string | null,
): ResolvedPolicies {
  // ⭐ A project-specific policy wins over the workspace default. Terms
  // are negotiated per project — a subvention tower and an affordable
  // block do not collect on the same rate — and a single workspace rate
  // would be quietly wrong for one of them.
  const receivable =
    sets.receivable.find((p) => p.projectId === projectId && projectId !== null) ??
    sets.receivable.find((p) => p.projectId === null) ??
    null;

  const dunning =
    sets.dunning.find((p) => p.projectId === projectId && projectId !== null) ??
    sets.dunning.find((p) => p.projectId === null) ??
    null;

  return {
    receivable: receivable
      ? {
          demandDueDays: receivable.demandDueDays,
          gstRateBps: receivable.gstRateBps,
          interestRateBps: receivable.interestRateBps,
          referenceRateBps: receivable.referenceRateBps,
          compounding: receivable.compounding,
          dayCount: receivable.dayCount,
          graceDays: receivable.graceDays,
          graceForgivesElapsedDays: receivable.graceForgivesElapsedDays,
        }
      : DEFAULT_RECEIVABLE_TERMS,
    receivablePolicyId: receivable?.id ?? null,
    dunning: dunning
      ? {
          reminderAfterDays: dunning.reminderAfterDays,
          firstNoticeAfterDays: dunning.firstNoticeAfterDays,
          finalNoticeAfterDays: dunning.finalNoticeAfterDays,
          cancellationWarningAfterDays: dunning.cancellationWarningAfterDays,
          minGapDays: dunning.minGapDays,
          preDueReminderDays: dunning.preDueReminderDays,
        }
      : DEFAULT_DUNNING_POLICY,
    dunningPolicyId: dunning?.id ?? null,
    appropriationOrder: receivable?.appropriationOrder ?? "interest_first",
    defaultStrategy:
      receivable?.defaultAllocationStrategy === "specified" ? "specified" : "oldest_first",
  };
}

export async function resolvePolicies(
  tenantId: string,
  projectId: string | null,
): Promise<ResolvedPolicies> {
  return resolvePoliciesFrom(await loadPolicySets(tenantId), projectId);
}

export async function listReceivablePolicies(
  tenantId: string,
): Promise<ReceivablePolicy[]> {
  return withTenant(tenantId, async (tx) =>
    tx
      .select()
      .from(receivablePolicies)
      .where(eq(receivablePolicies.tenantId, tenantId))
      .orderBy(asc(receivablePolicies.name)),
  );
}

export async function listDunningPolicies(tenantId: string): Promise<DunningPolicy[]> {
  return withTenant(tenantId, async (tx) =>
    tx
      .select()
      .from(dunningPolicies)
      .where(eq(dunningPolicies.tenantId, tenantId))
      .orderBy(asc(dunningPolicies.name)),
  );
}

/* ------------------------------------------------------------------ */
/* THE BOOKING A DEMAND HANGS OFF                                      */
/* ------------------------------------------------------------------ */

export type BookingContext = {
  bookingId: string;
  reference: string;
  projectId: string | null;
  projectName: string;
  /**
   * ⚠️ `projects.state_code` VERBATIM, AND NULL IS THE COMMON ANSWER.
   *
   * Added in 0080 for GST place of supply under s.12(3) of the IGST Act
   * and unset on the live deployment. It is carried here because RERA is
   * a Central Act with State-made rules (s.84) and a State Authority
   * (s.20), so which State a flat is in decides the cure period, the
   * prescribed interest margin and the forfeiture position — and the
   * ladder board has to be able to say that it does not know rather than
   * silently applying one State's assumptions to every project.
   */
  projectStateCode: string | null;
  unitLabel: string;
  leadId: string | null;
  buyerName: string;
  buyerEmail: string | null;
  buyerPhone: string | null;
  /** ⭐ Raw `leads.preferred_lang`. Normalised by the templates module. */
  preferredLang: string | null;
  agreementValueMinor: bigint | null;
};

const BOOKING_CONTEXT_COLUMNS = {
  bookingId: bookings.id,
  reference: bookings.reference,
  agreementValueMinor: bookings.agreementValueMinor,
  leadId: bookings.leadId,
  unitCode: units.code,
  unitTower: units.tower,
  projectId: projects.id,
  projectName: projects.name,
  projectStateCode: projects.stateCode,
  buyerName: leads.name,
  buyerEmail: leads.email,
  buyerPhone: leads.phone,
  preferredLang: leads.preferredLang,
} as const;

type BookingContextRow = {
  bookingId: string;
  reference: string;
  agreementValueMinor: bigint | null;
  leadId: string | null;
  unitCode: string | null;
  unitTower: string | null;
  projectId: string | null;
  projectName: string | null;
  projectStateCode: string | null;
  buyerName: string | null;
  buyerEmail: string | null;
  buyerPhone: string | null;
  preferredLang: string | null;
};

/**
 * ⚠️ ONE MAPPER, USED BY BOTH THE SINGULAR AND THE PLURAL READ. Two
 * mappers is how a board and a detail screen come to disagree about what
 * a unit with no tower is called.
 */
function toBookingContext(row: BookingContextRow): BookingContext {
  return {
    bookingId: row.bookingId,
    reference: row.reference,
    projectId: row.projectId ?? null,
    projectName: row.projectName ?? "—",
    projectStateCode: row.projectStateCode ?? null,
    unitLabel: row.unitTower ? `${row.unitTower}-${row.unitCode ?? ""}` : (row.unitCode ?? "—"),
    leadId: row.leadId ?? null,
    buyerName: row.buyerName ?? "—",
    buyerEmail: row.buyerEmail ?? null,
    buyerPhone: row.buyerPhone ?? null,
    preferredLang: row.preferredLang ?? null,
    agreementValueMinor: row.agreementValueMinor ?? null,
  };
}

export async function findBookingContext(
  tenantId: string,
  bookingId: string,
): Promise<BookingContext | null> {
  const rows = await withTenant(tenantId, async (tx) =>
    tx
      .select(BOOKING_CONTEXT_COLUMNS)
      .from(bookings)
      .leftJoin(units, eq(units.id, bookings.unitId))
      .leftJoin(projects, eq(projects.id, units.projectId))
      .leftJoin(leads, eq(leads.id, bookings.leadId))
      .where(and(eq(bookings.tenantId, tenantId), eq(bookings.id, bookingId)))
      .limit(1),
  );

  const row = rows[0];
  return row ? toBookingContext(row) : null;
}

/**
 * ⭐ THE SAME FACTS FOR A PAGE OF BOOKINGS, IN ONE ROUND TRIP.
 *
 * ⚠️ RETURNS A MAP, AND A MISSING KEY IS A REAL ANSWER. A demand whose
 * booking has been deleted still has a row in `demand_notices`; the board
 * has to be able to show that it cannot name the allottee rather than
 * throwing or, worse, printing somebody else's name.
 */
export async function listBookingContexts(
  tenantId: string,
  bookingIds: readonly string[],
): Promise<Map<string, BookingContext>> {
  const ids = [...new Set(bookingIds)];
  if (ids.length === 0) return new Map();

  const rows = await withTenant(tenantId, async (tx) =>
    tx
      .select(BOOKING_CONTEXT_COLUMNS)
      .from(bookings)
      .leftJoin(units, eq(units.id, bookings.unitId))
      .leftJoin(projects, eq(projects.id, units.projectId))
      .leftJoin(leads, eq(leads.id, bookings.leadId))
      .where(and(eq(bookings.tenantId, tenantId), inArray(bookings.id, ids))),
  );

  return new Map(rows.map((row) => [row.bookingId, toBookingContext(row)]));
}

export async function findMilestone(tenantId: string, milestoneId: string) {
  const rows = await withTenant(tenantId, async (tx) =>
    tx
      .select()
      .from(paymentMilestones)
      .where(
        and(
          eq(paymentMilestones.tenantId, tenantId),
          eq(paymentMilestones.id, milestoneId),
        ),
      )
      .limit(1),
  );
  return rows[0] ?? null;
}

/* ------------------------------------------------------------------ */
/* DEMANDS                                                             */
/* ------------------------------------------------------------------ */

export async function findDemand(
  tenantId: string,
  demandId: string,
): Promise<DemandNotice | null> {
  const rows = await withTenant(tenantId, async (tx) =>
    tx
      .select()
      .from(demandNotices)
      .where(and(eq(demandNotices.tenantId, tenantId), eq(demandNotices.id, demandId)))
      .limit(1),
  );
  return rows[0] ?? null;
}

export async function listDemandsForBooking(
  tenantId: string,
  bookingId: string,
): Promise<DemandNotice[]> {
  return withTenant(tenantId, async (tx) =>
    tx
      .select()
      .from(demandNotices)
      .where(
        and(eq(demandNotices.tenantId, tenantId), eq(demandNotices.bookingId, bookingId)),
      )
      .orderBy(asc(demandNotices.dueDate), asc(demandNotices.noticeNumber)),
  );
}

/** The interest terms frozen on to a demand, as the engine wants them. */
export function interestTermsOf(demand: DemandNotice): InterestTerms {
  return {
    rateBps: demand.interestRateBps,
    compounding: demand.compounding,
    dayCount: demand.dayCount,
    graceDays: demand.graceDays,
    // ⚠️ NOT STORED ON THE DEMAND, AND THAT IS A DELIBERATE NARROWING.
    // The column exists on the policy, and a demand that was issued under
    // a forgiving grace would need its own copy to be re-derived exactly.
    // Until a workspace asks for it, every issued demand charges from the
    // due date — the stricter reading, stated on the notice by
    // `interest_basis_note`, which is the column that actually governs.
    graceForgivesElapsedDays: false,
  };
}

export function demandFacts(demand: DemandNotice): DemandFacts {
  return {
    status: demand.status,
    dueDate: demand.dueDate,
    totalMinor: toBigIntAmount(demand.totalMinor),
    principalMinor: toBigIntAmount(demand.principalMinor),
    taxMinor: toBigIntAmount(demand.taxMinor),
    allocatedMinor: toBigIntAmount(demand.allocatedMinor),
    interestPaidMinor: toBigIntAmount(demand.interestPaidMinor),
    interestTerms: interestTermsOf(demand),
  };
}

/**
 * ⭐ THE DEMANDS A RECEIPT CAN BE APPLIED TO.
 *
 * ⚠️ `draft`, `cancelled` AND `superseded` ARE EXCLUDED IN SQL AND NOT BY
 * A LATER FILTER, because a receipt applied to a draft would settle a
 * document nobody was ever served, and one applied to a superseded demand
 * would settle a figure the buyer was told to ignore.
 */
export async function openDemandsForBooking(
  tenantId: string,
  bookingId: string,
  asOf: string,
): Promise<{ demands: OpenDemand[]; rows: DemandNotice[] }> {
  const rows = await withTenant(tenantId, async (tx) =>
    tx
      .select()
      .from(demandNotices)
      .where(
        and(
          eq(demandNotices.tenantId, tenantId),
          eq(demandNotices.bookingId, bookingId),
          inArray(demandNotices.status, ["issued", "part_paid"]),
        ),
      )
      .orderBy(asc(demandNotices.dueDate), asc(demandNotices.noticeNumber)),
  );

  const demands: OpenDemand[] = rows
    .map((row) => {
      const position = demandPosition(demandFacts(row), asOf);
      return {
        demandId: row.id,
        noticeNumber: row.noticeNumber,
        dueDate: row.dueDate,
        outstandingPrincipalMinor: position.outstandingPrincipalMinor,
        outstandingTaxMinor: position.outstandingTaxMinor,
        outstandingInterestMinor: position.outstandingInterestMinor,
      };
    })
    .filter(
      (d) =>
        d.outstandingPrincipalMinor + d.outstandingTaxMinor + d.outstandingInterestMinor >
        0n,
    );

  return { demands, rows };
}

/* ------------------------------------------------------------------ */
/* AGEING                                                              */
/* ------------------------------------------------------------------ */

/**
 * Every outstanding demand in the workspace, with the joins the ageing
 * report groups by.
 *
 * ⚠️ THE BUCKETING HAPPENS IN `lib/receivables/ageing.ts`, NOT HERE. See
 * the file header.
 */
export async function ageingRows(
  tenantId: string,
  options: { projectId?: string; bookingId?: string; asOf: string },
): Promise<AgeingRow[]> {
  const rows = await withTenant(tenantId, async (tx) => {
    const filters = [
      eq(demandNotices.tenantId, tenantId),
      inArray(demandNotices.status, ["issued", "part_paid"]),
    ];
    if (options.projectId) filters.push(eq(demandNotices.projectId, options.projectId));
    if (options.bookingId) filters.push(eq(demandNotices.bookingId, options.bookingId));

    return tx
      .select({
        demand: demandNotices,
        projectName: projects.name,
        bookingReference: bookings.reference,
        buyerName: leads.name,
        unitCode: units.code,
        unitTower: units.tower,
      })
      .from(demandNotices)
      .leftJoin(projects, eq(projects.id, demandNotices.projectId))
      .leftJoin(bookings, eq(bookings.id, demandNotices.bookingId))
      .leftJoin(units, eq(units.id, bookings.unitId))
      .leftJoin(leads, eq(leads.id, demandNotices.leadId))
      .where(and(...filters))
      .orderBy(asc(demandNotices.dueDate));
  });

  return rows.map(({ demand, ...joined }) => {
    const position = demandPosition(demandFacts(demand), options.asOf);
    return {
      demandId: demand.id,
      noticeNumber: demand.noticeNumber,
      dueDate: demand.dueDate,
      outstandingMinor: position.outstandingMinor,
      interestMinor: position.outstandingInterestMinor,
      projectId: demand.projectId,
      projectName: joined.projectName ?? "Unassigned",
      bookingId: demand.bookingId,
      bookingReference: joined.bookingReference ?? demand.bookingId,
      buyerId: demand.leadId,
      buyerName: joined.buyerName ?? "Unassigned",
      unitLabel: joined.unitTower
        ? `${joined.unitTower}-${joined.unitCode ?? ""}`
        : (joined.unitCode ?? "—"),
    };
  });
}

/* ------------------------------------------------------------------ */
/* RECEIPTS                                                            */
/* ------------------------------------------------------------------ */

export async function findReceipt(
  tenantId: string,
  receiptId: string,
): Promise<Receipt | null> {
  const rows = await withTenant(tenantId, async (tx) =>
    tx
      .select()
      .from(receipts)
      .where(and(eq(receipts.tenantId, tenantId), eq(receipts.id, receiptId)))
      .limit(1),
  );
  return rows[0] ?? null;
}

export async function listReceiptsForBooking(
  tenantId: string,
  bookingId: string,
): Promise<Array<Receipt & { allocations: ReceiptAllocation[] }>> {
  const { rows, allocations } = await withTenant(tenantId, async (tx) => {
    const receiptRows = await tx
      .select()
      .from(receipts)
      .where(and(eq(receipts.tenantId, tenantId), eq(receipts.bookingId, bookingId)))
      .orderBy(asc(receipts.receivedOn), asc(receipts.receiptNumber));

    if (receiptRows.length === 0) return { rows: receiptRows, allocations: [] };

    const allocationRows = await tx
      .select()
      .from(receiptAllocations)
      .where(
        and(
          eq(receiptAllocations.tenantId, tenantId),
          inArray(
            receiptAllocations.receiptId,
            receiptRows.map((r) => r.id),
          ),
        ),
      )
      .orderBy(asc(receiptAllocations.sequence));

    return { rows: receiptRows, allocations: allocationRows };
  });

  return rows.map((receipt) => ({
    ...receipt,
    allocations: allocations.filter((a) => a.receiptId === receipt.id),
  }));
}

export async function listAllocationsForReceipt(
  tenantId: string,
  receiptId: string,
): Promise<ReceiptAllocation[]> {
  return withTenant(tenantId, async (tx) =>
    tx
      .select()
      .from(receiptAllocations)
      .where(
        and(
          eq(receiptAllocations.tenantId, tenantId),
          eq(receiptAllocations.receiptId, receiptId),
        ),
      )
      .orderBy(asc(receiptAllocations.sequence)),
  );
}

/* ------------------------------------------------------------------ */
/* DUNNING                                                             */
/* ------------------------------------------------------------------ */

export async function listDunningEvents(
  tenantId: string,
  demandId: string,
): Promise<DunningEvent[]> {
  return withTenant(tenantId, async (tx) =>
    tx
      .select()
      .from(dunningEvents)
      .where(
        and(eq(dunningEvents.tenantId, tenantId), eq(dunningEvents.demandId, demandId)),
      )
      .orderBy(asc(dunningEvents.rung)),
  );
}

/** The last rung sent, for the escalation gate's minimum-gap check. */
export async function lastDunningEvent(
  tenantId: string,
  demandId: string,
): Promise<DunningEvent | null> {
  const rows = await withTenant(tenantId, async (tx) =>
    tx
      .select()
      .from(dunningEvents)
      .where(
        and(eq(dunningEvents.tenantId, tenantId), eq(dunningEvents.demandId, demandId)),
      )
      .orderBy(desc(dunningEvents.rung))
      .limit(1),
  );
  return rows[0] ?? null;
}

/* ------------------------------------------------------------------ */
/* NUMBER SERIES                                                       */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE NUMBER A BUYER QUOTES IN THEIR BANK TRANSFER.
 *
 * ⚠️ DERIVED FROM THE HIGHEST NUMBER ALREADY USED, NOT FROM A ROW COUNT,
 * for the same reason `server/sales/references.ts` gave in Phase 22: a
 * count goes backwards when a row disappears, and a reused number on a
 * document somebody has already paid against is a payment nobody can
 * match. (Here nothing CAN disappear — there is no DELETE grant on either
 * table — but the derivation should not depend on that.)
 *
 * ⚠️ AND IT IS SCOPED TO THE FINANCIAL YEAR, LIKE EVERY OTHER INDIAN
 * DOCUMENT SERIES. An accountant asked for "the demands raised in 2025-26"
 * reads the prefix; a flat sequence makes that a date-range query and a
 * conversation.
 *
 * The caller runs this inside its own transaction and retries on a
 * uniqueness collision — the partial unique index is the real guarantee.
 */
export async function nextDemandNumber(
  tx: { execute: (query: ReturnType<typeof sql>) => Promise<unknown> },
  financialYear: string,
  attempt = 0,
): Promise<string> {
  return nextSeriesNumber(tx, sql`demand_notices`, sql`notice_number`, "DN", financialYear, attempt);
}

export async function nextReceiptNumber(
  tx: { execute: (query: ReturnType<typeof sql>) => Promise<unknown> },
  financialYear: string,
  attempt = 0,
): Promise<string> {
  return nextSeriesNumber(tx, sql`receipts`, sql`receipt_number`, "RCP", financialYear, attempt);
}

async function nextSeriesNumber(
  tx: { execute: (query: ReturnType<typeof sql>) => Promise<unknown> },
  table: ReturnType<typeof sql>,
  column: ReturnType<typeof sql>,
  prefix: string,
  financialYear: string,
  attempt: number,
): Promise<string> {
  const like = `${prefix}/${financialYear}/%`;

  const result = (await tx.execute(sql`
    SELECT COALESCE(
      MAX(NULLIF(regexp_replace(${column}, '^.*/', ''), '')::bigint),
      0
    )::bigint AS highest
    FROM ${table}
    WHERE ${column} LIKE ${like}
  `)) as { rows?: { highest: string | number | bigint }[] } | { highest: string }[];

  const rows = Array.isArray(result)
    ? result
    : ((result as { rows?: unknown[] })?.rows ?? []);
  const first = rows[0] as { highest?: string | number | bigint } | undefined;

  let highest = 0n;
  if (first?.highest != null) {
    try {
      highest = BigInt(first.highest as string | number | bigint);
    } catch {
      highest = 0n;
    }
  }

  const next = highest + 1n + BigInt(attempt);
  return `${prefix}/${financialYear}/${next.toString().padStart(4, "0")}`;
}
