import "server-only";

/**
 * Ordence — GST Registry Reads
 * Version: v0.32.0-alpha
 *
 * The thin database layer under `server/actions/gst.ts`. Every query goes
 * through `withTenant`, so row-level security is applied by the database
 * and not by a `WHERE tenant_id = …` somebody can forget.
 *
 * ⚠️ NOTHING HERE DECIDES ANYTHING. Place of supply, rate resolution and
 * the arithmetic all live in `lib/gst/`, which has no database import and
 * is therefore testable without one. This file loads rows and hands them
 * over. The split is what stops a tax rule being written twice — once in
 * the engine and once, subtly differently, in a SQL predicate.
 */

import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { withTenant } from "@/db";
import {
  gstRegistrations,
  gstParties,
  hsnSacCodes,
  hsnSacRates,
  type GstRegistration,
  type GstParty,
  type HsnSacCode,
  type HsnSacRate,
} from "@/db/schema/gst";
import { toBigIntAmount } from "@/lib/billing/money";
import type { DatedRate } from "@/lib/gst/rates";

/* ------------------------------------------------------------------ */
/* OUR REGISTRATIONS                                                   */
/* ------------------------------------------------------------------ */

export async function listRegistrations(tenantId: string): Promise<GstRegistration[]> {
  return withTenant(tenantId, async (tx) =>
    tx
      .select()
      .from(gstRegistrations)
      .where(eq(gstRegistrations.tenantId, tenantId))
      .orderBy(desc(gstRegistrations.isPrimary), asc(gstRegistrations.stateCode)),
  );
}

/**
 * The registration a document should be issued under.
 *
 * ⚠️ EXPLICIT BEATS PRIMARY, AND PRIMARY IS ONLY A FALLBACK. A developer
 * registered in three states issues from whichever state the supply
 * belongs to, and the primary is what a one-state workspace never has to
 * think about. Silently defaulting when an id WAS supplied would put the
 * wrong GSTIN on the document with nothing on screen to show it.
 */
export async function resolveIssuingRegistration(
  tenantId: string,
  registrationId?: string | null,
): Promise<GstRegistration | null> {
  const rows = await withTenant(tenantId, async (tx) =>
    tx
      .select()
      .from(gstRegistrations)
      .where(
        registrationId
          ? and(
              eq(gstRegistrations.tenantId, tenantId),
              eq(gstRegistrations.id, registrationId),
            )
          : and(
              eq(gstRegistrations.tenantId, tenantId),
              eq(gstRegistrations.isPrimary, true),
              eq(gstRegistrations.isActive, true),
            ),
      )
      .limit(1),
  );

  return rows[0] ?? null;
}

/* ------------------------------------------------------------------ */
/* COUNTERPARTIES                                                      */
/* ------------------------------------------------------------------ */

export async function listParties(
  tenantId: string,
  partyType?: "customer" | "vendor",
): Promise<GstParty[]> {
  return withTenant(tenantId, async (tx) =>
    tx
      .select()
      .from(gstParties)
      .where(
        partyType
          ? and(eq(gstParties.tenantId, tenantId), eq(gstParties.partyType, partyType))
          : eq(gstParties.tenantId, tenantId),
      )
      .orderBy(asc(gstParties.legalName)),
  );
}

/**
 * The tax identity a buyer had on a given day.
 *
 * ⚠️ AS AT A DATE, NOT "THE CURRENT ONE". A buyer unregistered at booking
 * and registered by possession has two rows, and the invoice raised in
 * between must carry the identity that was true then. Reading the latest
 * row would silently re-classify a three-year-old document as B2B.
 */
export async function partyAsAt(
  tenantId: string,
  args: { leadId?: string | null; gstin?: string | null; on: string },
): Promise<GstParty | null> {
  const rows = await withTenant(tenantId, async (tx) =>
    tx
      .select()
      .from(gstParties)
      .where(
        and(
          eq(gstParties.tenantId, tenantId),
          args.leadId ? eq(gstParties.leadId, args.leadId) : undefined,
          args.gstin ? eq(gstParties.gstin, args.gstin) : undefined,
        ),
      )
      .orderBy(desc(gstParties.effectiveFrom)),
  );

  return (
    rows.find(
      (row) =>
        row.effectiveFrom <= args.on &&
        (row.effectiveTo === null || row.effectiveTo > args.on),
    ) ?? null
  );
}

/* ------------------------------------------------------------------ */
/* HSN / SAC AND ⭐ RATE HISTORY                                       */
/* ------------------------------------------------------------------ */

export async function listHsnSacCodes(tenantId: string): Promise<HsnSacCode[]> {
  return withTenant(tenantId, async (tx) =>
    tx
      .select()
      .from(hsnSacCodes)
      .where(eq(hsnSacCodes.tenantId, tenantId))
      .orderBy(asc(hsnSacCodes.code)),
  );
}

export async function findHsnSacByCode(
  tenantId: string,
  code: string,
): Promise<HsnSacCode | null> {
  const rows = await withTenant(tenantId, async (tx) =>
    tx
      .select()
      .from(hsnSacCodes)
      .where(and(eq(hsnSacCodes.tenantId, tenantId), eq(hsnSacCodes.code, code)))
      .limit(1),
  );
  return rows[0] ?? null;
}

/**
 * ⭐ THE WHOLE HISTORY, NOT THE CURRENT RATE.
 *
 * There is deliberately no `getCurrentRate(code)` in this file. Loading
 * every period and letting `resolveRateOn` pick by date is what makes a
 * historical document keep its historical rate — a query that filtered
 * `WHERE effective_to IS NULL` would answer a question nobody in a tax
 * system should be asking.
 *
 * The volume is trivial: a code has a handful of periods over the life of
 * GST, not thousands.
 */
export async function loadRateHistory(
  tenantId: string,
  hsnSacId: string,
): Promise<DatedRate[]> {
  const rows = await withTenant(tenantId, async (tx) =>
    tx
      .select()
      .from(hsnSacRates)
      .where(and(eq(hsnSacRates.tenantId, tenantId), eq(hsnSacRates.hsnSacId, hsnSacId)))
      .orderBy(asc(hsnSacRates.effectiveFrom)),
  );

  return rows.map(toDatedRate);
}

/** The open-ended period for a code, if there is one. */
export async function openRatePeriod(
  tenantId: string,
  hsnSacId: string,
): Promise<HsnSacRate | null> {
  const rows = await withTenant(tenantId, async (tx) =>
    tx
      .select()
      .from(hsnSacRates)
      .where(
        and(
          eq(hsnSacRates.tenantId, tenantId),
          eq(hsnSacRates.hsnSacId, hsnSacId),
          isNull(hsnSacRates.effectiveTo),
        ),
      )
      .limit(1),
  );
  return rows[0] ?? null;
}

/**
 * Drizzle returns `bigint` columns as strings on some driver paths and as
 * bigints on others. `toBigIntAmount` normalises, so no call site has to
 * care which one it got — the same reasoning as Phase 11.
 */
export function toDatedRate(row: HsnSacRate): DatedRate {
  return {
    id: row.id,
    rateBps: row.rateBps,
    cessRateBps: row.cessRateBps,
    cessPerUnitMinor: toBigIntAmount(row.cessPerUnitMinor),
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    notificationRef: row.notificationRef,
    itcEligible: row.itcEligible,
    reverseCharge: row.reverseCharge,
  };
}

/** Codes that have no rate covering `on`. Drives the "unrated" warning. */
export async function codesWithoutRateOn(
  tenantId: string,
  on: string,
): Promise<HsnSacCode[]> {
  const [codes, rates] = await Promise.all([
    listHsnSacCodes(tenantId),
    withTenant(tenantId, async (tx) =>
      tx.select().from(hsnSacRates).where(eq(hsnSacRates.tenantId, tenantId)),
    ),
  ]);

  const covered = new Set(
    rates
      .filter((r) => r.effectiveFrom <= on && (r.effectiveTo === null || r.effectiveTo > on))
      .map((r) => r.hsnSacId),
  );

  return codes.filter((code) => code.isActive && !covered.has(code.id));
}
