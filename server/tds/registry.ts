import "server-only";

/**
 * Ordence — TDS Registry Reads
 * Version: v0.36.0-alpha
 *
 * The thin database layer under `server/actions/tds.ts`. Every query goes
 * through `withTenant`, so row-level security is applied by the database
 * and not by a `WHERE tenant_id = …` somebody can forget.
 *
 * ⚠️ NOTHING HERE DECIDES ANYTHING. The section catalogue, the cumulative
 * threshold, Sections 206AA/206AB/197 and the 201(1A) interest all live
 * in `lib/tds/`, which has no database import and is therefore testable
 * without one. This file loads rows and hands them over. The split is
 * what stops a tax rule being written twice — once in the engine and
 * once, subtly differently, in a SQL predicate.
 */

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import {
  tdsDeductees,
  tdsLowerDeductionCertificates,
  tdsChallans,
  tdsReturns,
  tdsDeductions,
  tdsCertificates,
  type TdsDeductee,
  type TdsLowerDeductionCertificate,
  type TdsChallan,
  type TdsDeduction,
  type TdsQuarter,
  type TdsSectionCode,
} from "@/db/schema/tds";
import { toBigIntAmount } from "@/lib/billing/money";
import type { PriorDeduction } from "@/lib/tds/thresholds";
import type { ChallanFacts } from "@/lib/tds/challans";
import type { RegisterEntry } from "@/lib/tds/register";
import type { DeducteeFacts, LowerDeductionCertificateFacts } from "@/lib/tds/rates";

/* ------------------------------------------------------------------ */
/* DEDUCTEES                                                           */
/* ------------------------------------------------------------------ */

export async function listDeductees(
  tenantId: string,
  options?: { includeInactive?: boolean },
): Promise<TdsDeductee[]> {
  return withTenant(tenantId, async (tx) =>
    tx
      .select()
      .from(tdsDeductees)
      .where(
        options?.includeInactive
          ? eq(tdsDeductees.tenantId, tenantId)
          : and(eq(tdsDeductees.tenantId, tenantId), eq(tdsDeductees.isActive, true)),
      )
      .orderBy(asc(tdsDeductees.legalName)),
  );
}

export async function findDeductee(
  tenantId: string,
  deducteeId: string,
): Promise<TdsDeductee | null> {
  const rows = await withTenant(tenantId, async (tx) =>
    tx
      .select()
      .from(tdsDeductees)
      .where(and(eq(tdsDeductees.tenantId, tenantId), eq(tdsDeductees.id, deducteeId)))
      .limit(1),
  );
  return rows[0] ?? null;
}

/**
 * ⭐ FIND A DEDUCTEE BY PAN, WHICH IS THEIR REAL IDENTITY.
 *
 * ⚠️ THE LOOKUP THE PAYMENT SCREEN MUST DO BEFORE CREATING A NEW ROW.
 * The same firm supplies material, brokers a flat and rents us a crane —
 * three relationships, one PAN — and Section 194C's annual threshold is
 * on the PAN. A screen that creates a deductee per relationship splits
 * the running total and under-deducts by construction.
 */
export async function findDeducteeByPan(
  tenantId: string,
  pan: string,
): Promise<TdsDeductee | null> {
  const rows = await withTenant(tenantId, async (tx) =>
    tx
      .select()
      .from(tdsDeductees)
      .where(and(eq(tdsDeductees.tenantId, tenantId), eq(tdsDeductees.panNumber, pan)))
      .limit(1),
  );
  return rows[0] ?? null;
}

export function toDeducteeFacts(row: TdsDeductee): DeducteeFacts {
  return {
    deducteeType: row.deducteeType,
    panNumber: row.panNumber,
    panStatus: row.panStatus,
    isSpecifiedPerson206ab: row.isSpecifiedPerson206ab,
    isNonResident: row.isNonResident,
  };
}

/* ------------------------------------------------------------------ */
/* ⭐ SECTION 197 CERTIFICATES                                          */
/* ------------------------------------------------------------------ */

/**
 * The certificate, if any, that covers a payment on `day`.
 *
 * ⚠️ THE WINDOW IS FILTERED IN SQL **AND** RE-ASSESSED IN
 * `lib/tds/rates.ts`. That is not belt and braces for its own sake: the
 * engine has to explain WHY a certificate on file was not applied — "it
 * expired on 31 March" — and a query that simply returns nothing cannot.
 * So the widest reasonable set is loaded and the engine decides.
 */
export async function findCertificateFor(
  tenantId: string,
  args: { deducteeId: string; section: TdsSectionCode; day: string },
): Promise<TdsLowerDeductionCertificate | null> {
  const rows = await withTenant(tenantId, async (tx) =>
    tx
      .select()
      .from(tdsLowerDeductionCertificates)
      .where(
        and(
          eq(tdsLowerDeductionCertificates.tenantId, tenantId),
          eq(tdsLowerDeductionCertificates.deducteeId, args.deducteeId),
          eq(tdsLowerDeductionCertificates.section, args.section),
        ),
      )
      .orderBy(asc(tdsLowerDeductionCertificates.validFrom)),
  );

  // Prefer one whose window covers the day; otherwise return the nearest,
  // so the engine can say what is wrong with it.
  const covering = rows.find((c) => args.day >= c.validFrom && args.day <= c.validTo);
  return covering ?? rows[rows.length - 1] ?? null;
}

export function toCertificateFacts(
  row: TdsLowerDeductionCertificate,
): LowerDeductionCertificateFacts {
  return {
    id: row.id,
    certificateNumber: row.certificateNumber,
    section: row.section,
    rateBps: row.rateBps,
    validFrom: row.validFrom,
    validTo: row.validTo,
    capBaseMinor: row.capBaseMinor === null ? null : toBigIntAmount(row.capBaseMinor),
    isActive: row.isActive,
  };
}

/**
 * Base already paid under a certificate, for its cap.
 *
 * ⚠️ BATCH 0104 — CHECKED AND DELIBERATELY LEFT AS A BARE `bigint`.
 *
 * `tds_deductions` has no `currency` column, so this `sum()` cannot be
 * adding two currencies. More to the point, the number NEVER REACHES A
 * SCREEN: it is compared against `tds_lower_deduction_certificates.
 * cap_base_minor` by `resolveTdsRate()` and discarded. Both sides come
 * from the same single-currency pair of tables, so the comparison is sound
 * and a currency label would be decoration on an intermediate.
 *
 * 🔴 THE REAL CURRENCY GAP UNDER SECTION 195 WAS NEVER HERE, AND BATCH
 * 0106 CLOSED IT. A payment to a non-resident is frequently made in
 * foreign currency and the TDS is computed on the rupee equivalent at the
 * Rule 26 telegraphic-transfer buying rate on the date the tax was
 * required to be deducted. That conversion now happens in exactly one
 * place — `lib/tds/foreign-payments.ts#foreignPaymentBase`, over a quote
 * `server/fx/rate-service.ts#requireStatutoryQuote` will only return if it
 * is the TT buying rate for that very day — and the rate, its date, its
 * type and its publisher are copied onto the deduction row, where the
 * CHECK `tds_deductions_rule_26_complete` refuses anything else.
 *
 * ⚠️ THIS SUM IS STILL A BARE `bigint` AND STILL CORRECTLY SO. Every
 * `chargeable_base_minor` it adds is already in rupees, whatever currency
 * the payment was made in, because Rule 26 measures it there.
 */
export async function certificateConsumedBaseMinor(
  tenantId: string,
  certificateId: string,
): Promise<bigint> {
  const rows = await withTenant(tenantId, async (tx) =>
    tx
      .select({ total: sql<string>`COALESCE(sum(${tdsDeductions.chargeableBaseMinor}), 0)` })
      .from(tdsDeductions)
      .where(
        and(
          eq(tdsDeductions.tenantId, tenantId),
          eq(tdsDeductions.lowerDeductionCertificateId, certificateId),
        ),
      ),
  );
  return toBigIntAmount(rows[0]?.total ?? "0");
}

/* ------------------------------------------------------------------ */
/* ⭐⭐ THE ACCUMULATION                                                */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE QUERY THE WHOLE PHASE TURNS ON.
 *
 * Every payment already recorded for one deductee, one section and one
 * financial year — which is exactly what Section 194C's annual limb is
 * tested against.
 *
 * ⚠️ IT LOADS BELOW-THRESHOLD ROWS TOO, AND THAT IS THE POINT. A query
 * filtered to `outcome = 'deducted'` would return ₹0 for the labour
 * contractor who has been paid ₹75,000 in three below-threshold
 * instalments, and the fourth payment would conclude — correctly, from
 * the data it was given — that the ₹1,00,000 threshold was miles away.
 * The filter is the bug.
 *
 * ⚠️ `exempt` ROWS ARE EXCLUDED, and only those. A payment the section
 * does not reach at all is not part of the section's aggregate — the
 * same rule SQL 0025 §6 applies, so the engine and the guard count the
 * same rows.
 */
export async function loadPriorDeductions(
  tenantId: string,
  args: {
    deducteeId: string;
    section: TdsSectionCode;
    financialYear: string;
    /** Exclude a row being recomputed. */
    excludeDeductionId?: string;
  },
): Promise<PriorDeduction[]> {
  const rows = await withTenant(tenantId, async (tx) =>
    tx
      .select({
        id: tdsDeductions.id,
        deductionDate: tdsDeductions.deductionDate,
        paymentBaseMinor: tdsDeductions.paymentBaseMinor,
        chargeableBaseMinor: tdsDeductions.chargeableBaseMinor,
      })
      .from(tdsDeductions)
      .where(
        and(
          eq(tdsDeductions.tenantId, tenantId),
          eq(tdsDeductions.deducteeId, args.deducteeId),
          eq(tdsDeductions.section, args.section),
          eq(tdsDeductions.financialYear, args.financialYear),
          sql`${tdsDeductions.outcome} <> 'exempt'`,
        ),
      )
      .orderBy(asc(tdsDeductions.deductionDate), asc(tdsDeductions.id)),
  );

  return rows
    .filter((r) => r.id !== args.excludeDeductionId)
    .map((r) => ({
      deductionDate: r.deductionDate,
      baseMinor: toBigIntAmount(r.paymentBaseMinor),
      chargedBaseMinor: toBigIntAmount(r.chargeableBaseMinor),
    }));
}

/**
 * ⭐ EVERY (deductee, section, year) GROUP IN A FINANCIAL YEAR.
 *
 * Feeds the threshold sweep — "who has crossed an annual limit and not
 * been caught up?" — which is the report that finds a year of history
 * entered by somebody who tested each payment on its own. Every workspace
 * arrives with one.
 */
export async function loadAccumulationGroups(
  tenantId: string,
  financialYear: string,
): Promise<
  Array<{
    deducteeId: string;
    section: TdsSectionCode;
    financialYear: string;
    prior: PriorDeduction[];
  }>
> {
  const rows = await withTenant(tenantId, async (tx) =>
    tx
      .select({
        deducteeId: tdsDeductions.deducteeId,
        section: tdsDeductions.section,
        deductionDate: tdsDeductions.deductionDate,
        paymentBaseMinor: tdsDeductions.paymentBaseMinor,
        chargeableBaseMinor: tdsDeductions.chargeableBaseMinor,
      })
      .from(tdsDeductions)
      .where(
        and(
          eq(tdsDeductions.tenantId, tenantId),
          eq(tdsDeductions.financialYear, financialYear),
          sql`${tdsDeductions.outcome} <> 'exempt'`,
        ),
      )
      .orderBy(asc(tdsDeductions.deductionDate), asc(tdsDeductions.id)),
  );

  const groups = new Map<
    string,
    { deducteeId: string; section: TdsSectionCode; financialYear: string; prior: PriorDeduction[] }
  >();
  for (const r of rows) {
    const key = `${r.deducteeId}|${r.section}`;
    const group =
      groups.get(key) ??
      { deducteeId: r.deducteeId, section: r.section, financialYear, prior: [] };
    group.prior.push({
      deductionDate: r.deductionDate,
      baseMinor: toBigIntAmount(r.paymentBaseMinor),
      chargedBaseMinor: toBigIntAmount(r.chargeableBaseMinor),
    });
    groups.set(key, group);
  }
  return [...groups.values()];
}

/* ------------------------------------------------------------------ */
/* THE REGISTER                                                        */
/* ------------------------------------------------------------------ */

export async function listDeductions(
  tenantId: string,
  filter: {
    financialYear: string;
    quarter?: TdsQuarter | null;
    deducteeId?: string | null;
    section?: TdsSectionCode | null;
  },
): Promise<TdsDeduction[]> {
  return withTenant(tenantId, async (tx) => {
    const conditions = [
      eq(tdsDeductions.tenantId, tenantId),
      eq(tdsDeductions.financialYear, filter.financialYear),
    ];
    if (filter.quarter) conditions.push(eq(tdsDeductions.quarter, filter.quarter));
    if (filter.deducteeId) conditions.push(eq(tdsDeductions.deducteeId, filter.deducteeId));
    if (filter.section) conditions.push(eq(tdsDeductions.section, filter.section));

    return tx
      .select()
      .from(tdsDeductions)
      .where(and(...conditions))
      .orderBy(asc(tdsDeductions.deductionDate), asc(tdsDeductions.id));
  });
}

export function toRegisterEntry(
  row: TdsDeduction,
  deducteeName?: string,
): RegisterEntry {
  return {
    id: row.id,
    deducteeId: row.deducteeId,
    ...(deducteeName ? { deducteeName } : {}),
    section: row.section,
    financialYear: row.financialYear,
    quarter: row.quarter,
    deductionDate: row.deductionDate,
    paymentBaseMinor: toBigIntAmount(row.paymentBaseMinor),
    catchUpBaseMinor: toBigIntAmount(row.catchUpBaseMinor),
    chargeableBaseMinor: toBigIntAmount(row.chargeableBaseMinor),
    aggregateBeforeMinor: toBigIntAmount(row.aggregateBeforeMinor),
    aggregateAfterMinor: toBigIntAmount(row.aggregateAfterMinor),
    rateBps: row.rateBps,
    rateBasis: row.rateBasis,
    statutoryRef: row.statutoryRef,
    tdsMinor: toBigIntAmount(row.tdsMinor),
    surchargeMinor: toBigIntAmount(row.surchargeMinor),
    cessMinor: toBigIntAmount(row.cessMinor),
    outcome: row.outcome,
    challanId: row.challanId,
    purchaseInvoiceId: row.purchaseInvoiceId,
    referenceNumber: row.referenceNumber,
  };
}

export async function findDeductions(
  tenantId: string,
  ids: readonly string[],
): Promise<TdsDeduction[]> {
  if (ids.length === 0) return [];
  return withTenant(tenantId, async (tx) =>
    tx
      .select()
      .from(tdsDeductions)
      .where(and(eq(tdsDeductions.tenantId, tenantId), inArray(tdsDeductions.id, [...ids]))),
  );
}

/* ------------------------------------------------------------------ */
/* CHALLANS                                                            */
/* ------------------------------------------------------------------ */

export async function listChallans(
  tenantId: string,
  filter: { financialYear: string; quarter?: TdsQuarter | null },
): Promise<TdsChallan[]> {
  return withTenant(tenantId, async (tx) => {
    const conditions = [
      eq(tdsChallans.tenantId, tenantId),
      eq(tdsChallans.financialYear, filter.financialYear),
    ];
    if (filter.quarter) conditions.push(eq(tdsChallans.quarter, filter.quarter));
    return tx
      .select()
      .from(tdsChallans)
      .where(and(...conditions))
      .orderBy(asc(tdsChallans.depositDate), asc(tdsChallans.challanSerial));
  });
}

export function toChallanFacts(row: TdsChallan): ChallanFacts {
  return {
    id: row.id,
    bsrCode: row.bsrCode,
    challanSerial: row.challanSerial,
    depositDate: row.depositDate,
    taxMinor: toBigIntAmount(row.taxMinor),
    surchargeMinor: toBigIntAmount(row.surchargeMinor),
    cessMinor: toBigIntAmount(row.cessMinor),
    interestMinor: toBigIntAmount(row.interestMinor),
    feeMinor: toBigIntAmount(row.feeMinor),
    totalMinor: toBigIntAmount(row.totalMinor),
  };
}

/* ------------------------------------------------------------------ */
/* RETURNS AND CERTIFICATES                                            */
/* ------------------------------------------------------------------ */

export async function findReturn(
  tenantId: string,
  args: {
    tan: string;
    formType: "24Q" | "26Q" | "27Q" | "27EQ";
    financialYear: string;
    quarter: TdsQuarter;
  },
) {
  const rows = await withTenant(tenantId, async (tx) =>
    tx
      .select()
      .from(tdsReturns)
      .where(
        and(
          eq(tdsReturns.tenantId, tenantId),
          eq(tdsReturns.tan, args.tan),
          eq(tdsReturns.formType, args.formType),
          eq(tdsReturns.financialYear, args.financialYear),
          eq(tdsReturns.quarter, args.quarter),
          sql`${tdsReturns.status} <> 'revised'`,
        ),
      )
      .limit(1),
  );
  return rows[0] ?? null;
}

export async function listCertificates(
  tenantId: string,
  filter: { financialYear: string; quarter?: TdsQuarter | null },
) {
  return withTenant(tenantId, async (tx) => {
    const conditions = [
      eq(tdsCertificates.tenantId, tenantId),
      eq(tdsCertificates.financialYear, filter.financialYear),
    ];
    if (filter.quarter) conditions.push(eq(tdsCertificates.quarter, filter.quarter));
    return tx.select().from(tdsCertificates).where(and(...conditions));
  });
}
