"use server";

/**
 * Ordence — ⭐ Land, Title and JDA Actions
 * Version: v0.42.0-alpha  ·  PORT WAVE A
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION. A `"use server"` file that exports
 * anything else publishes it as an RPC endpoint reachable by anyone on
 * the internet.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE CHAIN CHECK LIVES HERE; THE CHAIN RULES LIVE IN THE DATABASE
 * ══════════════════════════════════════════════════════════════════════
 * `auditTitleChain` READS a chain and reports what is wrong with it. It
 * enforces nothing — the refusal of a hole, the warning on a gap, the
 * heir-share arithmetic and the OC gate are all triggers in
 * `SQL-FILES/0030_phase42_land.sql`, because a title chain gets loaded by
 * a bulk import far more often than it gets typed, and the import does
 * not come through here.
 *
 * ⚠️ MONEY CROSSES THE BOUNDARY AS A STRING. `JSON.stringify` throws on a
 * bigint.
 */

import { and, asc, desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenant } from "@/db";
import {
  landParcels,
  titleDocuments,
  landowners,
  jointDevelopmentAgreements,
  planSanctions,
  approvalSanctions,
  dueDiligenceRecords,
  khataRecords,
  UNLOANABLE_KHATA,
} from "@/db/schema/land";
import { requirePermission, writeAudit } from "@/server/audit";
import { guardSalesWrite, toSalesActionError } from "@/server/sales/guards";
import { serializeAmount } from "@/lib/billing/money";
import type { ActionResult } from "@/lib/validators/crm";

const FEATURE = "land.title" as const;

const minorAmount = z
  .string()
  .trim()
  .regex(/^\d{1,19}$/, "Enter a whole amount in paise, digits only.")
  .transform((v) => BigInt(v));

/* ================================================================== */
/* PARCELS                                                             */
/* ================================================================== */

const parcelSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1, "Name the parcel.").max(250),
  projectId: z.string().uuid().optional().nullable(),
  surveyNumber: z.string().trim().max(120).optional().nullable(),
  village: z.string().trim().max(150).optional().nullable(),
  hobli: z.string().trim().max(150).optional().nullable(),
  taluk: z.string().trim().max(150).optional().nullable(),
  district: z.string().trim().max(150).optional().nullable(),
  state: z.string().trim().max(120).optional().nullable(),
  stateCode: z.string().trim().length(2).optional().nullable(),
  /**
   * ⚠️ GUNTHA IS CAPPED AT 39 HERE AS WELL AS IN THE DATABASE, because a
   * form that accepts 45 and then shows a constraint violation has taught
   * the operator nothing. 1 acre = 40 guntha; anything at or above 40 is
   * another acre that was not counted.
   */
  extentAcre: z.string().trim().regex(/^\d{1,8}(\.\d{1,4})?$/).optional().nullable(),
  extentGuntha: z
    .string()
    .trim()
    .regex(/^\d{1,2}(\.\d{1,3})?$/)
    .refine((v) => Number(v) < 40, "1 acre is 40 guntha — enter the extra acre instead.")
    .optional()
    .nullable(),
  ownerName: z.string().trim().max(300).optional().nullable(),
  askingRateMinor: minorAmount.optional().nullable(),
  agreedRateMinor: minorAmount.optional().nullable(),
  considerationMinor: minorAmount.optional().nullable(),
  notes: z.string().trim().max(5000).optional().nullable(),
});

export async function saveLandParcel(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const data = parcelSchema.parse(input);
    const ctx = await guardSalesWrite({
      operation: "land:parcel:save",
      feature: FEATURE,
      permission: "land.parcels.manage",
    });

    const values = {
      name: data.name,
      projectId: data.projectId ?? null,
      surveyNumber: data.surveyNumber ?? null,
      village: data.village ?? null,
      hobli: data.hobli ?? null,
      taluk: data.taluk ?? null,
      district: data.district ?? null,
      state: data.state ?? null,
      stateCode: data.stateCode ?? null,
      extentAcre: data.extentAcre ?? null,
      extentGuntha: data.extentGuntha ?? null,
      ownerName: data.ownerName ?? null,
      askingRateMinor: data.askingRateMinor ?? null,
      agreedRateMinor: data.agreedRateMinor ?? null,
      considerationMinor: data.considerationMinor ?? null,
      notes: data.notes ?? null,
      updatedBy: ctx.user.id,
    };

    const id = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        if (data.id) {
          await tx
            .update(landParcels)
            .set(values)
            .where(
              and(eq(landParcels.tenantId, ctx.tenant.id), eq(landParcels.id, data.id)),
            );
          return data.id;
        }
        const [row] = await tx
          .insert(landParcels)
          .values({ tenantId: ctx.tenant.id, createdBy: ctx.user.id, ...values })
          .returning({ id: landParcels.id });
        if (!row) throw new Error("The parcel could not be created.");
        return row.id;
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: data.id ? "update" : "create",
      resourceType: "land_parcel",
      resourceId: id,
      newValue: { name: data.name, survey: data.surveyNumber },
    });

    revalidatePath("/land");
    return { ok: true, data: { id } };
  } catch (err) {
    return toSalesActionError(err, "saveLandParcel");
  }
}

export async function dropLandParcel(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const data = z
      .object({
        id: z.string().uuid(),
        reason: z
          .string()
          .trim()
          .min(10, "Say why — somebody will look at this land again in two years.")
          .max(2000),
      })
      .parse(input);

    const ctx = await guardSalesWrite({
      operation: "land:parcel:drop",
      feature: FEATURE,
      permission: "land.parcels.manage",
      resource: { type: "land_parcel", id: data.id },
    });

    await withTenant(
      ctx.tenant.id,
      async (tx) => {
        await tx
          .update(landParcels)
          .set({ stage: "dropped", droppedReason: data.reason, updatedBy: ctx.user.id })
          .where(
            and(eq(landParcels.tenantId, ctx.tenant.id), eq(landParcels.id, data.id)),
          );
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: "update",
      resourceType: "land_parcel",
      resourceId: data.id,
      newValue: { stage: "dropped" },
      reason: data.reason,
      severity: "notice",
    });

    revalidatePath("/land");
    return { ok: true, data: { id: data.id } };
  } catch (err) {
    return toSalesActionError(err, "dropLandParcel");
  }
}

/* ================================================================== */
/* ⭐ THE CHAIN AUDIT                                                   */
/* ================================================================== */

export type ChainFinding = {
  position: number;
  severity: "gap" | "unverified" | "expiring";
  message: string;
};

/**
 * ⭐ READ A CHAIN AND SAY WHAT IS WRONG WITH IT.
 *
 * ⚠️ THE DATABASE ALREADY REFUSES A HOLE (positions 1, 2, 4), so this
 * function never has to look for one. What it looks for is the thing the
 * database deliberately allows: a GAP, where one link's seller is not the
 * previous link's buyer. Those are legitimate at a partition, a will, a
 * court decree or a mutation — and a defect everywhere else — so they are
 * a question for a human rather than a refusal.
 *
 * ⚠️ NAME MATCHING IS CASE- AND SPACE-INSENSITIVE AND NOTHING MORE. It
 * will not see that "K. Ramaiah" and "Ramaiah K" are the same man. A
 * fuzzy matcher here would quietly suppress real gaps to look clever,
 * which is the opposite of what this is for: a false "all clear" on a
 * title chain is worse than no check at all.
 */
export async function auditTitleChain(parcelId: string): Promise<
  ActionResult<{
    links: Array<{
      id: string;
      position: number;
      kind: string;
      title: string;
      fromParty: string | null;
      toParty: string | null;
      registeredOn: string | null;
      isVerified: boolean;
      expiresOn: string | null;
    }>;
    findings: ChainFinding[];
  }>
> {
  try {
    const ctx = await requirePermission("land.parcels.read", {
      type: "land_parcel",
      id: parcelId,
    });

    const links = await withTenant(
      ctx.tenant.id,
      async (tx) =>
        tx
          .select()
          .from(titleDocuments)
          .where(
            and(
              eq(titleDocuments.tenantId, ctx.tenant.id),
              eq(titleDocuments.parcelId, parcelId),
            ),
          )
          .orderBy(asc(titleDocuments.chainPosition)),
      { impersonationId: ctx.impersonationId },
    );

    const norm = (v: string | null) => (v ?? "").trim().toLowerCase();
    const findings: ChainFinding[] = [];
    const today = new Date().toISOString().slice(0, 10);

    links.forEach((link, i) => {
      const prev = i > 0 ? links[i - 1] : undefined;

      if (prev && link.fromParty && prev.toParty && norm(prev.toParty) !== norm(link.fromParty)) {
        findings.push({
          position: link.chainPosition,
          severity: "gap",
          message:
            `Position ${link.chainPosition} begins with "${link.fromParty}" but position ` +
            `${prev.chainPosition} ends with "${prev.toParty}". Normal at a partition, a will, ` +
            `a court decree or a mutation — a break in title anywhere else.`,
        });
      }

      if (!link.isVerified) {
        findings.push({
          position: link.chainPosition,
          severity: "unverified",
          message: `"${link.title}" has not been verified against a certified copy.`,
        });
      }

      if (link.expiresOn && link.expiresOn <= today) {
        findings.push({
          position: link.chainPosition,
          severity: "expiring",
          message: `"${link.title}" expired on ${link.expiresOn} and needs renewing before any transaction.`,
        });
      }
    });

    return {
      ok: true,
      data: {
        links: links.map((l) => ({
          id: l.id,
          position: l.chainPosition,
          kind: l.kind,
          title: l.title,
          fromParty: l.fromParty,
          toParty: l.toParty,
          registeredOn: l.registeredOn,
          isVerified: l.isVerified,
          expiresOn: l.expiresOn,
        })),
        findings,
      },
    };
  } catch (err) {
    return toSalesActionError(err, "auditTitleChain");
  }
}

/* ================================================================== */
/* READS                                                               */
/* ================================================================== */

export type ParcelRow = {
  id: string;
  name: string;
  stage: string;
  surveyNumber: string | null;
  village: string | null;
  district: string | null;
  extentSqft: string | null;
  extentAcre: string | null;
  extentGuntha: string | null;
  considerationMinor: string;
  advancePaidMinor: string;
  droppedReason: string | null;
  chainLength: number;
  unverifiedLinks: number;
};

export async function listLandParcels(): Promise<
  ActionResult<{
    parcels: ParcelRow[];
    jdaCount: number;
    /** ⭐ Khata records a bank will not lend against. */
    unloanable: Array<{ id: string; khataNo: string | null; khataType: string }>;
    pendingSanctions: number;
    expiringDiligence: Array<{ id: string; recordType: string; validUntil: string | null }>;
    ocRisk: Array<{
      id: string;
      projectId: string;
      deviationBps: number;
      ocReceived: boolean;
    }>;
  }>
> {
  try {
    const ctx = await requirePermission("land.parcels.read");

    const payload = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const parcels = await tx
          .select()
          .from(landParcels)
          .where(eq(landParcels.tenantId, ctx.tenant.id))
          .orderBy(desc(landParcels.createdAt))
          .limit(500);

        const links = await tx
          .select({
            parcelId: titleDocuments.parcelId,
            isVerified: titleDocuments.isVerified,
          })
          .from(titleDocuments)
          .where(eq(titleDocuments.tenantId, ctx.tenant.id));

        const jdas = await tx
          .select({ id: jointDevelopmentAgreements.id })
          .from(jointDevelopmentAgreements)
          .where(eq(jointDevelopmentAgreements.tenantId, ctx.tenant.id));

        const khatas = await tx
          .select({
            id: khataRecords.id,
            khataNo: khataRecords.khataNo,
            khataType: khataRecords.khataType,
          })
          .from(khataRecords)
          .where(eq(khataRecords.tenantId, ctx.tenant.id));

        const sanctions = await tx
          .select({ id: approvalSanctions.id, status: approvalSanctions.status })
          .from(approvalSanctions)
          .where(eq(approvalSanctions.tenantId, ctx.tenant.id));

        const diligence = await tx
          .select({
            id: dueDiligenceRecords.id,
            recordType: dueDiligenceRecords.recordType,
            validUntil: dueDiligenceRecords.validUntil,
          })
          .from(dueDiligenceRecords)
          .where(eq(dueDiligenceRecords.tenantId, ctx.tenant.id));

        const plans = await tx
          .select({
            id: planSanctions.id,
            projectId: planSanctions.projectId,
            deviationBps: planSanctions.deviationBps,
            ocReceived: planSanctions.ocReceived,
          })
          .from(planSanctions)
          .where(eq(planSanctions.tenantId, ctx.tenant.id));

        return { parcels, links, jdas, khatas, sanctions, diligence, plans };
      },
      { impersonationId: ctx.impersonationId },
    );

    const byParcel = new Map<string, { total: number; unverified: number }>();
    for (const l of payload.links) {
      const cur = byParcel.get(l.parcelId) ?? { total: 0, unverified: 0 };
      cur.total += 1;
      if (!l.isVerified) cur.unverified += 1;
      byParcel.set(l.parcelId, cur);
    }

    const today = new Date().toISOString().slice(0, 10);
    const soon = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);

    return {
      ok: true,
      data: {
        parcels: payload.parcels.map((p) => {
          const c = byParcel.get(p.id) ?? { total: 0, unverified: 0 };
          return {
            id: p.id,
            name: p.name,
            stage: p.stage,
            surveyNumber: p.surveyNumber,
            village: p.village,
            district: p.district,
            extentSqft: p.extentSqft,
            extentAcre: p.extentAcre,
            extentGuntha: p.extentGuntha,
            considerationMinor: serializeAmount(p.considerationMinor),
            advancePaidMinor: serializeAmount(p.advancePaidMinor),
            droppedReason: p.droppedReason,
            chainLength: c.total,
            unverifiedLinks: c.unverified,
          };
        }),
        jdaCount: payload.jdas.length,
        unloanable: payload.khatas.filter((k) =>
          (UNLOANABLE_KHATA as readonly string[]).includes(k.khataType),
        ),
        pendingSanctions: payload.sanctions.filter(
          (s) => s.status !== "approved" && s.status !== "rejected",
        ).length,
        expiringDiligence: payload.diligence.filter(
          (d) => d.validUntil !== null && d.validUntil <= soon && d.validUntil >= today,
        ),
        /** ⭐ Deviation over the 5% tolerance, whatever the OC flag says. */
        ocRisk: payload.plans.filter((p) => p.deviationBps > 500),
      },
    };
  } catch (err) {
    return toSalesActionError(err, "listLandParcels");
  }
}
