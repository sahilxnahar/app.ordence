"use server";

/**
 * Ordence — GST Actions
 * Version: v0.32.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION. Schemas live in
 * `lib/validators/gst.ts`, constants and rules in `lib/gst/`. A
 * `"use server"` file that exports anything else publishes it as an RPC
 * endpoint reachable by anyone on the internet.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE IS RESPONSIBLE FOR, AND WHAT IT IS NOT
 * ══════════════════════════════════════════════════════════════════════
 * It asks the right questions before writing and turns a refusal into a
 * sentence somebody can act on.
 *
 * It does NOT make the guarantees. Those are constraints and triggers in
 * `SQL-FILES/0021_phase32_gst.sql`, because this file is one of four
 * write paths — an import of historical bookings, a support fix at a psql
 * prompt and a future API route are the others — and a rule enforced in
 * one of four places is a rule the other three will bypass.
 *
 * ⚠️ MONEY CROSSES THE BOUNDARY AS A STRING. `JSON.stringify` throws on a
 * bigint, so every amount returned here goes through `serializeAmount`.
 * The alternative — patching `BigInt.prototype.toJSON` globally — changes
 * behaviour for every unrelated caller including libraries.
 */

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withTenant } from "@/db";
import { gstRegistrations, gstParties, hsnSacCodes, hsnSacRates } from "@/db/schema";
import { requirePermission, writeAudit } from "@/server/audit";
import { guardGstWrite, gstFail, toGstActionError } from "@/server/gst/guards";
import {
  createRegistrationSchema,
  retireRegistrationSchema,
  upsertPartySchema,
  createHsnSacSchema,
  addRatePeriodSchema,
  closeRatePeriodSchema,
  resolveRateSchema,
  placeOfSupplyQuerySchema,
  computeTaxSchema,
} from "@/lib/validators/gst";
import {
  listRegistrations,
  listParties,
  listHsnSacCodes,
  loadRateHistory,
  findHsnSacByCode,
  openRatePeriod,
  codesWithoutRateOn,
} from "@/server/gst/registry";
import { quoteTax } from "@/server/gst/engine";
import { determinePlaceOfSupply } from "@/lib/gst/place-of-supply";
import { resolveRateOn, validateRateHistory, describeMissingRate } from "@/lib/gst/rates";
import { serializeAmount, parseMoney } from "@/lib/billing/money";
import type { ActionResult } from "@/lib/validators/crm";

/* ------------------------------------------------------------------ */
/* SERIALISABLE SHAPES                                                 */
/* ------------------------------------------------------------------ */

export type RegistrationRow = {
  id: string;
  gstin: string;
  stateCode: string;
  legalName: string;
  tradeName: string | null;
  registrationType: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  isPrimary: boolean;
  isActive: boolean;
};

export type RatePeriodRow = {
  id: string;
  rateBps: number;
  cessRateBps: number;
  cessPerUnitMinor: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  notificationRef: string | null;
  itcEligible: boolean;
  reverseCharge: boolean;
};

/* ------------------------------------------------------------------ */
/* OUR REGISTRATIONS                                                   */
/* ------------------------------------------------------------------ */

export async function getRegistrations(): Promise<ActionResult<{ rows: RegistrationRow[] }>> {
  try {
    // ⚠️ READ: permission only. An entitlement gate here would refuse to
    // RENDER the page rather than refusing the button on it.
    const ctx = await requirePermission("gst:read");
    const rows = await listRegistrations(ctx.tenant.id);

    return {
      ok: true,
      data: {
        rows: rows.map((r) => ({
          id: r.id,
          gstin: r.gstin,
          stateCode: r.stateCode,
          legalName: r.legalName,
          tradeName: r.tradeName,
          registrationType: r.registrationType,
          effectiveFrom: r.effectiveFrom,
          effectiveTo: r.effectiveTo,
          isPrimary: r.isPrimary,
          isActive: r.isActive,
        })),
      },
    };
  } catch (err) {
    return toGstActionError(err, "getRegistrations");
  }
}

export async function createRegistration(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await guardGstWrite({
      operation: "gst:manage_registrations",
      feature: "gst.registry",
      permission: "gst:manage_registrations",
    });

    const data = createRegistrationSchema.parse(input);

    const created = await withTenant(ctx.tenant.id, async (tx) => {
      // ⚠️ Clearing the old primary FIRST, in the same transaction. The
      // partial unique index refuses two, and doing it in one transaction
      // is what makes "make this the default" a single atomic act rather
      // than a window in which the workspace has no default at all.
      if (data.isPrimary) {
        await tx
          .update(gstRegistrations)
          .set({ isPrimary: false })
          .where(
            and(
              eq(gstRegistrations.tenantId, ctx.tenant.id),
              eq(gstRegistrations.isPrimary, true),
            ),
          );
      }

      const [row] = await tx
        .insert(gstRegistrations)
        .values({
          tenantId: ctx.tenant.id,
          gstin: data.gstin,
          // Derived, never typed. The CHECK constraint holds them equal.
          stateCode: data.gstin.slice(0, 2),
          legalName: data.legalName,
          tradeName: data.tradeName ?? null,
          registrationType: data.registrationType,
          address: data.address ?? {},
          effectiveFrom: data.effectiveFrom,
          effectiveTo: data.effectiveTo ?? null,
          isPrimary: data.isPrimary,
          notes: data.notes ?? null,
          createdBy: ctx.user?.id ?? null,
        })
        .returning({ id: gstRegistrations.id });
      return row ?? null;
    });

    if (!created) return gstFail("The registration could not be saved.");

    await writeAudit(ctx, {
      action: "create",
      resourceType: "gst_registration",
      resourceId: created.id,
      newValue: { gstin: data.gstin, isPrimary: data.isPrimary },
    });

    revalidatePath("/settings/gst");
    return { ok: true, data: { id: created.id } };
  } catch (err) {
    return toGstActionError(err, "createRegistration");
  }
}

/**
 * Retire a registration by CLOSING it, never by deleting it.
 *
 * ⚠️ There is no `deleteRegistration`. An invoice issued under a
 * surrendered GSTIN must still render that GSTIN years later, and the
 * foreign key from `invoices` is ON DELETE RESTRICT precisely so nobody
 * can tidy it away.
 */
export async function retireRegistration(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await guardGstWrite({
      operation: "gst:manage_registrations",
      feature: "gst.registry",
      permission: "gst:manage_registrations",
    });

    const data = retireRegistrationSchema.parse(input);

    await withTenant(ctx.tenant.id, async (tx) =>
      tx
        .update(gstRegistrations)
        .set({
          effectiveTo: data.effectiveTo,
          isActive: false,
          isPrimary: false,
          notes: data.reason,
        })
        .where(
          and(
            eq(gstRegistrations.tenantId, ctx.tenant.id),
            eq(gstRegistrations.id, data.id),
          ),
        ),
    );

    await writeAudit(ctx, {
      action: "update",
      resourceType: "gst_registration",
      resourceId: data.id,
      newValue: { effectiveTo: data.effectiveTo, reason: data.reason },
    });

    revalidatePath("/settings/gst");
    return { ok: true, data: { id: data.id } };
  } catch (err) {
    return toGstActionError(err, "retireRegistration");
  }
}

/* ------------------------------------------------------------------ */
/* COUNTERPARTIES                                                      */
/* ------------------------------------------------------------------ */

export async function getParties(
  partyType?: "customer" | "vendor",
): Promise<ActionResult<{ rows: unknown[] }>> {
  try {
    const ctx = await requirePermission("gst:read");
    const rows = await listParties(ctx.tenant.id, partyType);
    return { ok: true, data: { rows } };
  } catch (err) {
    return toGstActionError(err, "getParties");
  }
}

export async function saveParty(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await guardGstWrite({
      operation: "gst:manage_parties",
      feature: "gst.registry",
      permission: "gst:manage_parties",
    });

    const data = upsertPartySchema.parse(input);

    const saved = await withTenant(ctx.tenant.id, async (tx) => {
      const values = {
        tenantId: ctx.tenant.id,
        partyType: data.partyType,
        leadId: data.leadId ?? null,
        channelPartnerId: data.channelPartnerId ?? null,
        companyId: data.companyId ?? null,
        legalName: data.legalName,
        tradeName: data.tradeName ?? null,
        gstin: data.gstin ?? null,
        panNumber: data.panNumber ?? null,
        registrationType: data.registrationType,
        // Derived from the GSTIN where there is one — a GSTIN's first two
        // digits ARE its state, and the CHECK constraint holds them equal.
        stateCode: data.gstin ? data.gstin.slice(0, 2) : (data.stateCode ?? null),
        address: data.address ?? {},
        effectiveFrom: data.effectiveFrom,
        effectiveTo: data.effectiveTo ?? null,
        notes: data.notes ?? null,
      };

      if (data.id) {
        const [row] = await tx
          .update(gstParties)
          .set(values)
          .where(and(eq(gstParties.tenantId, ctx.tenant.id), eq(gstParties.id, data.id)))
          .returning({ id: gstParties.id });
        return row ?? null;
      }

      const [row] = await tx.insert(gstParties).values(values).returning({ id: gstParties.id });
      return row ?? null;
    });

    if (!saved) return gstFail("The party could not be saved.");

    await writeAudit(ctx, {
      action: data.id ? "update" : "create",
      resourceType: "gst_party",
      resourceId: saved.id,
      newValue: { legalName: data.legalName, gstin: data.gstin ?? null },
    });

    revalidatePath("/settings/gst");
    return { ok: true, data: { id: saved.id } };
  } catch (err) {
    return toGstActionError(err, "saveParty");
  }
}

/* ------------------------------------------------------------------ */
/* HSN / SAC AND ⭐ RATE PERIODS                                       */
/* ------------------------------------------------------------------ */

export async function getHsnSacCodes(): Promise<ActionResult<{ rows: unknown[] }>> {
  try {
    const ctx = await requirePermission("gst:read");
    const rows = await listHsnSacCodes(ctx.tenant.id);
    return { ok: true, data: { rows } };
  } catch (err) {
    return toGstActionError(err, "getHsnSacCodes");
  }
}

export async function createHsnSacCode(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await guardGstWrite({
      operation: "gst:manage_rates",
      feature: "gst.rate_master",
      permission: "gst:manage_rates",
    });

    const data = createHsnSacSchema.parse(input);

    const created = await withTenant(ctx.tenant.id, async (tx) => {
      const [row] = await tx
        .insert(hsnSacCodes)
        .values({
          tenantId: ctx.tenant.id,
          code: data.code,
          kind: data.kind,
          description: data.description,
          uqc: data.uqc ?? null,
          notes: data.notes ?? null,
        })
        .returning({ id: hsnSacCodes.id });
      return row ?? null;
    });

    if (!created) return gstFail("The code could not be saved.");

    await writeAudit(ctx, {
      action: "create",
      resourceType: "hsn_sac_code",
      resourceId: created.id,
      newValue: { code: data.code, kind: data.kind },
    });

    revalidatePath("/settings/gst");
    return { ok: true, data: { id: created.id } };
  } catch (err) {
    return toGstActionError(err, "createHsnSacCode");
  }
}

/**
 * ⭐ ADD A RATE PERIOD. The only way a rate ever changes.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THERE IS NO `updateRate`, AND THE ABSENCE IS THE DESIGN
 * ══════════════════════════════════════════════════════════════════════
 * A rate is superseded by opening a new period and closing the old one on
 * the day the new one starts. Editing the old one would restate every
 * invoice raised under it — silently, with no exception and no changed
 * row anywhere a person looks — so the database refuses it outright once
 * any invoice has used it.
 *
 * Offering an "edit rate" form would be offering an action that fails for
 * exactly the rows that matter, which is worse than not offering it.
 *
 * ⚠️ `supersedeCurrent` MUST BE ASKED FOR. Closing the open period is
 * what a notification does, but it is a decision — a user adding a
 * historical period they forgot should get the overlap error, not a
 * silently truncated current rate.
 */
export async function addRatePeriod(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await guardGstWrite({
      operation: "gst:manage_rates",
      feature: "gst.rate_master",
      permission: "gst:manage_rates",
    });

    const data = addRatePeriodSchema.parse(input);

    // Validate the resulting history BEFORE writing, so the message names
    // the two periods that clash rather than surfacing
    // `conflicting key value violates exclusion constraint`.
    const existing = await loadRateHistory(ctx.tenant.id, data.hsnSacId);
    const open = data.supersedeCurrent
      ? await openRatePeriod(ctx.tenant.id, data.hsnSacId)
      : null;

    const projected = existing
      .map((rate) =>
        open && rate.id === open.id ? { ...rate, effectiveTo: data.effectiveFrom } : rate,
      )
      .concat({
        id: "new",
        rateBps: data.rateBps,
        cessRateBps: data.cessRateBps,
        cessPerUnitMinor: data.cessPerUnit ? parseMoney(data.cessPerUnit) : 0n,
        effectiveFrom: data.effectiveFrom,
        effectiveTo: data.effectiveTo ?? null,
      });

    const { errors } = validateRateHistory(projected);
    if (errors.length > 0) {
      const first = errors[0];
      return gstFail(`${first?.message ?? "That rate history is inconsistent."} ${first?.remedy ?? ""}`.trim());
    }

    const created = await withTenant(ctx.tenant.id, async (tx) => {
      if (open) {
        // ⚠️ Closed FIRST, in the same transaction as the insert. Done in
        // two transactions there is a window in which the code has no
        // current rate, and an invoice raised in it resolves to nothing.
        await tx
          .update(hsnSacRates)
          .set({ effectiveTo: data.effectiveFrom })
          .where(and(eq(hsnSacRates.tenantId, ctx.tenant.id), eq(hsnSacRates.id, open.id)));
      }

      const [row] = await tx
        .insert(hsnSacRates)
        .values({
          tenantId: ctx.tenant.id,
          hsnSacId: data.hsnSacId,
          rateBps: data.rateBps,
          cessRateBps: data.cessRateBps,
          cessPerUnitMinor: data.cessPerUnit ? parseMoney(data.cessPerUnit) : 0n,
          effectiveFrom: data.effectiveFrom,
          effectiveTo: data.effectiveTo ?? null,
          notificationRef: data.notificationRef ?? null,
          itcEligible: data.itcEligible,
          reverseCharge: data.reverseCharge,
          notes: data.notes ?? null,
        })
        .returning({ id: hsnSacRates.id });
      return row ?? null;
    });

    if (!created) return gstFail("The rate period could not be saved.");

    await writeAudit(ctx, {
      action: "create",
      resourceType: "hsn_sac_rate",
      resourceId: created.id,
      newValue: {
        rateBps: data.rateBps,
        effectiveFrom: data.effectiveFrom,
        notificationRef: data.notificationRef ?? null,
        supersededOpenPeriod: open?.id ?? null,
      },
    });

    revalidatePath("/settings/gst");
    return { ok: true, data: { id: created.id } };
  } catch (err) {
    return toGstActionError(err, "addRatePeriod");
  }
}

export async function closeRatePeriod(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await guardGstWrite({
      operation: "gst:manage_rates",
      feature: "gst.rate_master",
      permission: "gst:manage_rates",
    });

    const data = closeRatePeriodSchema.parse(input);

    await withTenant(ctx.tenant.id, async (tx) =>
      tx
        .update(hsnSacRates)
        .set({ effectiveTo: data.effectiveTo })
        .where(and(eq(hsnSacRates.tenantId, ctx.tenant.id), eq(hsnSacRates.id, data.id))),
    );

    await writeAudit(ctx, {
      action: "update",
      resourceType: "hsn_sac_rate",
      resourceId: data.id,
      newValue: { effectiveTo: data.effectiveTo },
    });

    revalidatePath("/settings/gst");
    return { ok: true, data: { id: data.id } };
  } catch (err) {
    return toGstActionError(err, "closeRatePeriod");
  }
}

export async function getRateHistory(
  hsnSacId: string,
): Promise<ActionResult<{ rows: RatePeriodRow[] }>> {
  try {
    const ctx = await requirePermission("gst:read");
    const rows = await loadRateHistory(ctx.tenant.id, hsnSacId);

    return {
      ok: true,
      data: {
        rows: rows.map((r) => ({
          id: r.id,
          rateBps: r.rateBps,
          cessRateBps: r.cessRateBps,
          cessPerUnitMinor: serializeAmount(r.cessPerUnitMinor),
          effectiveFrom: r.effectiveFrom,
          effectiveTo: r.effectiveTo,
          notificationRef: r.notificationRef ?? null,
          itcEligible: r.itcEligible ?? true,
          reverseCharge: r.reverseCharge ?? false,
        })),
      },
    };
  } catch (err) {
    return toGstActionError(err, "getRateHistory");
  }
}

/**
 * ⭐ THE RATE THAT APPLIED ON A DATE. There is no "current rate" call.
 */
export async function resolveRate(
  input: unknown,
): Promise<ActionResult<{ rate: RatePeriodRow | null; problem: string | null }>> {
  try {
    const ctx = await requirePermission("gst:read");
    const data = resolveRateSchema.parse(input);

    const code = await findHsnSacByCode(ctx.tenant.id, data.hsnSacCode);
    if (!code) {
      return {
        ok: true,
        data: {
          rate: null,
          problem: `${data.hsnSacCode} is not in the HSN/SAC master.`,
        },
      };
    }

    const history = await loadRateHistory(ctx.tenant.id, code.id);
    const rate = resolveRateOn(history, data.on);

    if (!rate) {
      const problem = describeMissingRate(data.hsnSacCode, data.on);
      return { ok: true, data: { rate: null, problem: `${problem.message} ${problem.remedy}` } };
    }

    return {
      ok: true,
      data: {
        rate: {
          id: rate.id,
          rateBps: rate.rateBps,
          cessRateBps: rate.cessRateBps,
          cessPerUnitMinor: serializeAmount(rate.cessPerUnitMinor),
          effectiveFrom: rate.effectiveFrom,
          effectiveTo: rate.effectiveTo,
          notificationRef: rate.notificationRef ?? null,
          itcEligible: rate.itcEligible ?? true,
          reverseCharge: rate.reverseCharge ?? false,
        },
        problem: null,
      },
    };
  } catch (err) {
    return toGstActionError(err, "resolveRate");
  }
}

export async function getUnratedCodes(on: string): Promise<ActionResult<{ rows: unknown[] }>> {
  try {
    const ctx = await requirePermission("gst:read");
    const rows = await codesWithoutRateOn(ctx.tenant.id, on);
    return { ok: true, data: { rows } };
  } catch (err) {
    return toGstActionError(err, "getUnratedCodes");
  }
}

/* ------------------------------------------------------------------ */
/* PLACE OF SUPPLY & TAX                                               */
/* ------------------------------------------------------------------ */

/**
 * Answer "which tax applies, and why" without writing anything.
 *
 * Read-only, so `requirePermission` alone. It is what the booking form
 * calls as the user picks a buyer, and it returns the STATUTORY REFERENCE
 * as well as the answer — a rep who can see "Section 12(3): the property
 * decides" next to the figure will query a wrong one, and a rep who sees
 * only "IGST ₹4,50,000" will not.
 */
export async function previewPlaceOfSupply(
  input: unknown,
): Promise<ActionResult<{ placeOfSupply: unknown }>> {
  try {
    await requirePermission("gst:read");
    const data = placeOfSupplyQuerySchema.parse(input);

    const result = determinePlaceOfSupply({
      supplierStateCode: data.supplierStateCode,
      supplyType: data.supplyType,
      recipientRegistration: data.recipientRegistration,
      recipientStateCode: data.recipientStateCode ?? null,
      propertyStateCode: data.propertyStateCode ?? null,
      deliveryStateCode: data.deliveryStateCode ?? null,
    });

    if (!result.ok) {
      return gstFail(`${result.problem.message} ${result.problem.remedy}`);
    }

    return { ok: true, data: { placeOfSupply: result.supply } };
  } catch (err) {
    return toGstActionError(err, "previewPlaceOfSupply");
  }
}

export type TaxQuoteResponse = {
  supplierGstin: string;
  supplierStateCode: string;
  placeOfSupplyCode: string;
  placeOfSupplyBasis: string;
  statutoryRef: string;
  explanation: string;
  taxKind: string;
  isInterState: boolean;
  isUnionTerritory: boolean;
  taxPointDate: string;
  taxableMinor: string;
  cgstMinor: string;
  sgstMinor: string;
  igstMinor: string;
  cessMinor: string;
  totalTaxMinor: string;
  reverseChargeTaxMinor: string;
  invoiceTotalMinor: string;
  roundOffMinor: string;
  amountPayableMinor: string;
  lines: {
    key: string;
    hsnSacCode: string | null;
    rateId: string | null;
    rateBps: number;
    taxableMinor: string;
    cgstMinor: string;
    sgstMinor: string;
    igstMinor: string;
    cessMinor: string;
    lineTotalMinor: string;
    isReverseCharge: boolean;
  }[];
};

/**
 * Price a document's tax as at its own date, without writing anything.
 *
 * ⚠️ EVERY AMOUNT LEAVES AS A STRING. `JSON.stringify` throws on a
 * bigint — "Do not know how to serialize a BigInt" — so a server action
 * returning raw paise crashes the moment it crosses the RSC boundary.
 */
export async function quoteInvoiceTax(
  input: unknown,
): Promise<ActionResult<TaxQuoteResponse>> {
  try {
    // ⚠️ A WRITE-SHAPED GATE ON A READ-SHAPED CALL, DELIBERATELY. This is
    // what the invoice is built from, so a workspace that cannot issue
    // invoices should not be able to quote one either — otherwise the
    // upgrade prompt arrives at the last click instead of the first.
    const ctx = await guardGstWrite({
      operation: "gst:quote",
      feature: "gst.tax_invoice",
      permission: "gst:read",
    });

    const data = computeTaxSchema.parse(input);
    const result = await quoteTax(ctx.tenant.id, data);
    if (!result.ok) return gstFail(result.error);

    const { computation: c, placeOfSupply: pos, registration } = result.quote;

    return {
      ok: true,
      data: {
        supplierGstin: registration.gstin,
        supplierStateCode: registration.stateCode,
        placeOfSupplyCode: pos.placeOfSupplyCode,
        placeOfSupplyBasis: pos.basis,
        statutoryRef: pos.statutoryRef,
        explanation: pos.explanation,
        taxKind: pos.taxKind,
        isInterState: pos.isInterState,
        isUnionTerritory: pos.isUnionTerritory,
        taxPointDate: result.quote.taxPointDate,
        taxableMinor: serializeAmount(c.taxableMinor),
        cgstMinor: serializeAmount(c.cgstMinor),
        sgstMinor: serializeAmount(c.sgstMinor),
        igstMinor: serializeAmount(c.igstMinor),
        cessMinor: serializeAmount(c.cessMinor),
        totalTaxMinor: serializeAmount(c.totalTaxMinor),
        reverseChargeTaxMinor: serializeAmount(c.reverseChargeTaxMinor),
        invoiceTotalMinor: serializeAmount(c.invoiceTotalMinor),
        roundOffMinor: serializeAmount(c.roundOffMinor),
        amountPayableMinor: serializeAmount(c.amountPayableMinor),
        lines: c.lines.map((line) => ({
          key: line.key,
          hsnSacCode: line.hsnSacCode,
          rateId: line.rateId,
          rateBps: line.rateBps,
          taxableMinor: serializeAmount(line.taxableMinor),
          cgstMinor: serializeAmount(line.cgstMinor),
          sgstMinor: serializeAmount(line.sgstMinor),
          igstMinor: serializeAmount(line.igstMinor),
          cessMinor: serializeAmount(line.cessMinor),
          lineTotalMinor: serializeAmount(line.lineTotalMinor),
          isReverseCharge: line.isReverseCharge,
        })),
      },
    };
  } catch (err) {
    return toGstActionError(err, "quoteInvoiceTax");
  }
}
