"use server";

/**
 * Ordence — ⭐⭐⭐ DISBURSEMENTS, COURT FEES AND RULE 33
 * Version: v1.8.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION AND NONE TAKES A TENANT.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE ₹500 THAT COSTS ₹9,090
 * ══════════════════════════════════════════════════════════════════════
 * A pure agent under Rule 33 receives "only the actual amount incurred".
 * Recover a rounded-up court fee and the exclusion is lost — not on the
 * rounding, on the **whole recovery**, which then bears tax at the rate
 * the firm's fee bears.
 *
 * ⭐ The refusal lives in the database (`matter_disbursements_pure_agent_is_at_actual`),
 * not here. This action explains it before the row is attempted, so the
 * person typing sees the arithmetic rather than a constraint name — but
 * if this file were deleted tomorrow the rule would still hold.
 */

import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenant } from "@/db";
import {
  courtFeeRefundClaims,
  courtFeeSchedules,
  courtFeeSlabs,
  matterDisbursements,
} from "@/db/schema/legal-billing";
import { legalMatters } from "@/db/schema/legal";
import { companies } from "@/db/schema/crm";
import { requirePermission, writeAudit } from "@/server/audit";
import { toSalesActionError } from "@/server/sales/guards";
import { serializeAmount, toBigIntAmount } from "@/lib/billing/money";
import type { ActionResult } from "@/lib/validators/crm";
import {
  assessPureAgent,
  DISBURSEMENT_KINDS,
  DISBURSEMENT_LABELS,
  PURE_AGENT_CAPABLE,
  type DisbursementKind,
} from "@/lib/legal/disbursement";
import {
  computeCourtFee,
  refundEntitlement,
  SETTLEMENT_ROUTES,
  validateCourtFeeSlabs,
  type CourtFeeSlab,
  type SettlementRoute,
} from "@/lib/legal/court-fee";

const READ = "sales.invoices.read" as const;
const WRITE = "sales.invoices.create" as const;

const civilDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");
const paise = z.string().regex(/^\d+$/, "Whole paise, positive.");

const kinds = DISBURSEMENT_KINDS as unknown as [DisbursementKind, ...DisbursementKind[]];
const routes = SETTLEMENT_ROUTES as unknown as [SettlementRoute, ...SettlementRoute[]];

const disbursementSchema = z.object({
  matterId: z.string().uuid(),
  disbursementDate: civilDay,
  kind: z.enum(kinds),
  description: z.string().trim().min(1).max(1000),
  referenceNo: z.string().trim().max(120).optional(),
  paidTo: z.string().trim().max(255).optional(),
  paidAmountMinor: paise,
  /** ⭐ Omitted means "at actual", which is what a pure agent recovery is. */
  recoveredAmountMinor: paise.optional(),
  isPureAgent: z.boolean().default(true),
  clientAuthorised: z.boolean().default(false),
  clientAccountEntryId: z.string().uuid().nullish(),
  courtFeeScheduleId: z.string().uuid().nullish(),
  notes: z.string().trim().max(2000).optional(),
});

/**
 * ⭐⭐ RECORD WHAT WENT OUT.
 *
 * 🔴 The Rule 33 assessment runs BEFORE the insert so the refusal reads
 *    like a reason and not like a database error. The constraint behind
 *    it is what actually stops the row.
 */
export async function saveDisbursement(input: unknown): Promise<
  ActionResult<{
    id: string;
    excludedFromValue: boolean;
    taxAtRiskMinor: string;
    reason: string;
    notes: readonly string[];
  }>
> {
  try {
    const data = disbursementSchema.parse(input);
    const ctx = await requirePermission(WRITE);

    const paid = BigInt(data.paidAmountMinor);
    if (paid <= 0n) throw new Error("A disbursement has to be more than nothing.");
    const recovered =
      data.recoveredAmountMinor === undefined ? paid : BigInt(data.recoveredAmountMinor);

    /* 🔴 The two refusals worth explaining before the database does it. */
    if (data.isPureAgent && recovered !== paid) {
      const markup = recovered - paid;
      const atRisk = (recovered * 1800n) / 10000n;
      throw new Error(
        `A pure agent recovery must be at actual. This was paid ${money(paid)} and is being recovered at ${money(
          recovered,
        )} — a difference of ${money(
          markup > 0n ? markup : -markup,
        )}. Explanation (d) to Rule 33 requires the pure agent to receive only the actual amount incurred, and once that fails the WHOLE ${money(
          recovered,
        )} falls into the value of supply, putting roughly ${money(
          atRisk,
        )} of GST at stake — not the tax on the difference. If the firm wants to charge for the work, bill it as a fee on its own line and leave the disbursement at actual.`,
      );
    }
    if (data.isPureAgent && !PURE_AGENT_CAPABLE[data.kind]) {
      throw new Error(
        `${DISBURSEMENT_LABELS[data.kind]} is the firm's own cost, not the client's liability, so it cannot be a pure agent recovery. The client was never liable to the third party for it — that is the whole test. Recover it as part of the fee and let it bear tax at the same rate the fee does.`,
      );
    }
    if (data.isPureAgent && !data.clientAuthorised) {
      throw new Error(
        "Rule 33(i) requires the payment to the third party to have been made on the client's authorisation, and Explanation (a) requires a contractual agreement to act as pure agent for that cost. Record the authorisation, or mark this as an ordinary recoverable cost.",
      );
    }

    const verdict = assessPureAgent({
      kind: data.kind,
      paidMinor: paid,
      recoveredMinor: recovered,
      clientAuthorised: data.clientAuthorised,
      /** ⭐ Rule 33(ii) is satisfied by the fee note, which prints them apart. */
      separatelyIndicated: true,
      suppliedOnOwnAccount: true,
    });

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [matter] = await tx
          .select({ id: legalMatters.id, companyId: legalMatters.companyId })
          .from(legalMatters)
          .where(
            and(
              eq(legalMatters.tenantId, ctx.tenant.id),
              eq(legalMatters.id, data.matterId),
            ),
          )
          .limit(1);
        if (!matter) throw new Error("That matter does not exist.");
        if (!matter.companyId) {
          throw new Error(
            "This matter has no client on it, so there is nobody to recover the disbursement from. Put the client on the matter first.",
          );
        }

        const [row] = await tx
          .insert(matterDisbursements)
          .values({
            tenantId: ctx.tenant.id,
            matterId: data.matterId,
            companyId: matter.companyId,
            disbursementDate: data.disbursementDate,
            kind: data.kind,
            description: data.description,
            referenceNo: data.referenceNo ?? null,
            paidTo: data.paidTo ?? null,
            paidAmountMinor: paid,
            recoveredAmountMinor: recovered,
            isPureAgent: data.isPureAgent,
            clientAuthorised: data.clientAuthorised,
            clientAccountEntryId: data.clientAccountEntryId ?? null,
            courtFeeScheduleId: data.courtFeeScheduleId ?? null,
            notes: data.notes ?? null,
            createdBy: ctx.user.id,
          })
          .returning({ id: matterDisbursements.id });

        if (!row) throw new Error("The disbursement could not be recorded.");

        await writeAudit(ctx, {
          action: "create",
          resourceType: "matter_disbursement",
          resourceId: row.id,
          newValue: {
            kind: data.kind,
            paidAmountMinor: serializeAmount(paid),
            recoveredAmountMinor: serializeAmount(recovered),
            isPureAgent: data.isPureAgent,
          },
          /** ⚠️ It decides whether tax is due on the recovery. */
          severity: "warning",
        });

        return { id: row.id };
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/legal/disbursements");
    revalidatePath(`/legal/matters/${data.matterId}`);
    return {
      ok: true,
      data: {
        id: result.id,
        excludedFromValue: verdict.excludedFromValue,
        taxAtRiskMinor: serializeAmount(verdict.taxAtRiskMinor),
        reason: verdict.reason,
        notes: verdict.notes,
      },
    };
  } catch (err) {
    return toSalesActionError(err, "saveDisbursement");
  }
}

/* ------------------------------------------------------------------ */
/* WHAT IS OUT AND NOT BACK                                            */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE REPORT A PRACTICE ACTUALLY LOSES MONEY ON.
 *
 * 🔴 Money paid out for clients and never billed is the quietest leak in
 *    a law firm: no invoice was ever raised, so nothing chases it and
 *    nothing shows it as overdue. It simply sits.
 */
export async function getDisbursements(): Promise<
  ActionResult<{
    rows: {
      id: string;
      matterId: string;
      matterNo: string;
      matterTitle: string;
      clientName: string | null;
      disbursementDate: string;
      kind: string;
      kindLabel: string;
      description: string;
      paidMinor: string;
      recoveredMinor: string;
      isPureAgent: boolean;
      billed: boolean;
      /** ⚠️ True where a stored row would not survive Rule 33 today. */
      atRisk: boolean;
      riskReason: string | null;
    }[];
    unbilledMinor: string;
    unbilledCount: number;
    pureAgentMinor: string;
    taxableRecoveriesMinor: string;
    atRiskCount: number;
    today: string;
  }>
> {
  try {
    const ctx = await requirePermission(READ);
    const today = new Date().toISOString().slice(0, 10);

    const rows = await withTenant(
      ctx.tenant.id,
      async (tx) =>
        tx
          .select({
            id: matterDisbursements.id,
            matterId: matterDisbursements.matterId,
            matterNo: legalMatters.matterNo,
            matterTitle: legalMatters.title,
            clientName: companies.name,
            disbursementDate: matterDisbursements.disbursementDate,
            kind: matterDisbursements.kind,
            description: matterDisbursements.description,
            paidMinor: matterDisbursements.paidAmountMinor,
            recoveredMinor: matterDisbursements.recoveredAmountMinor,
            isPureAgent: matterDisbursements.isPureAgent,
            clientAuthorised: matterDisbursements.clientAuthorised,
            invoiceId: matterDisbursements.invoiceId,
          })
          .from(matterDisbursements)
          .leftJoin(legalMatters, eq(legalMatters.id, matterDisbursements.matterId))
          .leftJoin(companies, eq(companies.id, matterDisbursements.companyId))
          .where(eq(matterDisbursements.tenantId, ctx.tenant.id))
          .orderBy(desc(matterDisbursements.disbursementDate))
          .limit(500),
      { impersonationId: ctx.impersonationId },
    );

    let unbilled = 0n;
    let unbilledCount = 0;
    let pureAgent = 0n;
    let taxable = 0n;
    let atRiskCount = 0;

    const out = rows.map((r) => {
      const paid = toBigIntAmount(r.paidMinor ?? 0n);
      const recovered = toBigIntAmount(r.recoveredMinor ?? 0n);
      const billed = r.invoiceId !== null;
      if (!billed) {
        unbilled += recovered;
        unbilledCount += 1;
      }
      if (r.isPureAgent) pureAgent += recovered;
      else taxable += recovered;

      /**
       * 🔴 RE-ASSESSED ON EVERY READ, NOT TRUSTED FROM THE FLAG.
       *
       * ⚠️ The constraint makes a bad row impossible through the
       * product. A restored backup, a bulk import or a hand-written
       * UPDATE is not the product. Checking on read costs nothing and
       * catches the one case where the guard was routed around.
       */
      const verdict = assessPureAgent({
        kind: (r.kind ?? "other") as DisbursementKind,
        paidMinor: paid,
        recoveredMinor: recovered,
        clientAuthorised: r.clientAuthorised ?? false,
        separatelyIndicated: true,
        suppliedOnOwnAccount: true,
      });
      const atRisk = r.isPureAgent && !verdict.excludedFromValue;
      if (atRisk) atRiskCount += 1;

      return {
        id: r.id,
        matterId: r.matterId,
        matterNo: r.matterNo ?? "—",
        matterTitle: r.matterTitle ?? "—",
        clientName: r.clientName,
        disbursementDate: r.disbursementDate ?? today,
        kind: r.kind ?? "other",
        kindLabel: DISBURSEMENT_LABELS[(r.kind ?? "other") as DisbursementKind],
        description: r.description ?? "",
        paidMinor: serializeAmount(paid),
        recoveredMinor: serializeAmount(recovered),
        isPureAgent: r.isPureAgent ?? false,
        billed,
        atRisk,
        riskReason: atRisk ? verdict.failedOn.join("; ") : null,
      };
    });

    return {
      ok: true,
      data: {
        rows: out,
        unbilledMinor: serializeAmount(unbilled),
        unbilledCount,
        pureAgentMinor: serializeAmount(pureAgent),
        taxableRecoveriesMinor: serializeAmount(taxable),
        atRiskCount,
        today,
      },
    };
  } catch (err) {
    return toSalesActionError(err, "getDisbursements");
  }
}

/* ------------------------------------------------------------------ */
/* THE SCHEDULE THE TENANT TYPES IN                                    */
/* ------------------------------------------------------------------ */

const slabInput = z.object({
  fromMinor: paise,
  uptoMinor: paise.nullish(),
  rateBps: z.number().int().min(0).max(10000),
  addMinor: paise.optional(),
});

const scheduleSchema = z.object({
  name: z.string().trim().min(1).max(200),
  statuteRef: z.string().trim().min(1).max(300),
  stateCode: z.string().trim().length(2).optional(),
  courtTier: z.string().trim().max(40).optional(),
  basis: z.enum(["fixed", "ad_valorem", "manual"]),
  fixedMinor: paise.nullish(),
  maximumMinor: paise.nullish(),
  minimumMinor: paise.nullish(),
  roundUpToMinor: paise.nullish(),
  slabs: z.array(slabInput).default([]),
  notes: z.string().trim().max(2000).optional(),
});

/**
 * ⭐ THE TENANT'S OWN SCHEDULE. Ordence ships none.
 *
 * 🔴 Court fees are a State subject and every State Act is amended on
 *    its own budget cycle. A stale slab shipped in a release is worse
 *    than an empty table — the firm that reads the schedule off the
 *    registry wall is right, and the one that trusts an eighteen-month-
 *    old table has its plaint returned for deficit court fee, which
 *    loses the filing date.
 */
export async function saveCourtFeeSchedule(input: unknown): Promise<
  ActionResult<{ id: string; slabCount: number }>
> {
  try {
    const data = scheduleSchema.parse(input);
    const ctx = await requirePermission(WRITE);

    const slabs: CourtFeeSlab[] = data.slabs.map((s) => ({
      fromMinor: BigInt(s.fromMinor),
      uptoMinor: s.uptoMinor === null || s.uptoMinor === undefined ? null : BigInt(s.uptoMinor),
      rateBps: s.rateBps,
      addMinor: s.addMinor === undefined ? 0n : BigInt(s.addMinor),
    }));

    if (data.basis === "ad_valorem") {
      const problems = validateCourtFeeSlabs(slabs);
      if (problems.length > 0) {
        throw new Error(
          `This schedule would not compute a correct fee. ${problems
            .map((p) => p.message)
            .join(" ")}`,
        );
      }
    } else if (slabs.length > 0) {
      throw new Error(
        `A ${data.basis} schedule computes nothing from bands, so bands on it are a schedule somebody half-changed. Remove them or set the basis to ad valorem.`,
      );
    }

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [row] = await tx
          .insert(courtFeeSchedules)
          .values({
            tenantId: ctx.tenant.id,
            name: data.name,
            statuteRef: data.statuteRef,
            stateCode: data.stateCode ?? null,
            courtTier: data.courtTier ?? null,
            basis: data.basis,
            fixedMinor: data.fixedMinor ? BigInt(data.fixedMinor) : null,
            maximumMinor: data.maximumMinor ? BigInt(data.maximumMinor) : null,
            minimumMinor: data.minimumMinor ? BigInt(data.minimumMinor) : null,
            roundUpToMinor: data.roundUpToMinor ? BigInt(data.roundUpToMinor) : null,
            notes: data.notes ?? null,
            createdBy: ctx.user.id,
          })
          .returning({ id: courtFeeSchedules.id });

        if (!row) throw new Error("The schedule could not be saved.");

        if (slabs.length > 0) {
          await tx.insert(courtFeeSlabs).values(
            slabs.map((s) => ({
              tenantId: ctx.tenant.id,
              scheduleId: row.id,
              fromMinor: s.fromMinor,
              uptoMinor: s.uptoMinor,
              rateBps: s.rateBps,
              addMinor: s.addMinor ?? 0n,
            })),
          );
        }

        await writeAudit(ctx, {
          action: "create",
          resourceType: "court_fee_schedule",
          resourceId: row.id,
          newValue: { name: data.name, statuteRef: data.statuteRef, basis: data.basis },
          severity: "notice",
        });

        return { id: row.id, slabCount: slabs.length };
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/legal/disbursements");
    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "saveCourtFeeSchedule");
  }
}

/**
 * ⭐ WHAT THE FEE WOULD BE, WITH ITS WORKING.
 *
 * ⚠️ Never stored as an answer. The fee that matters is the one the
 * registry accepts, and this is a calculation to check against it.
 */
export async function quoteCourtFee(input: unknown): Promise<
  ActionResult<{
    feeMinor: string;
    steps: { label: string; amountMinor: string }[];
    cappedAtMaximum: boolean;
    statuteRef: string;
    notes: readonly string[];
  }>
> {
  try {
    const data = z
      .object({ scheduleId: z.string().uuid(), valuationMinor: paise })
      .parse(input);
    const ctx = await requirePermission(READ);

    const built = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [sched] = await tx
          .select()
          .from(courtFeeSchedules)
          .where(
            and(
              eq(courtFeeSchedules.tenantId, ctx.tenant.id),
              eq(courtFeeSchedules.id, data.scheduleId),
            ),
          )
          .limit(1);
        if (!sched) throw new Error("That schedule does not exist.");

        const bands = await tx
          .select()
          .from(courtFeeSlabs)
          .where(
            and(
              eq(courtFeeSlabs.tenantId, ctx.tenant.id),
              eq(courtFeeSlabs.scheduleId, data.scheduleId),
            ),
          )
          .orderBy(asc(courtFeeSlabs.fromMinor));

        return computeCourtFee({
          schedule: {
            statuteRef: sched.statuteRef,
            basis: sched.basis as "fixed" | "ad_valorem" | "manual",
            fixedMinor: sched.fixedMinor === null ? null : toBigIntAmount(sched.fixedMinor),
            maximumMinor:
              sched.maximumMinor === null ? null : toBigIntAmount(sched.maximumMinor),
            minimumMinor:
              sched.minimumMinor === null ? null : toBigIntAmount(sched.minimumMinor),
            roundUpToMinor:
              sched.roundUpToMinor === null ? null : toBigIntAmount(sched.roundUpToMinor),
            slabs: bands.map((b) => ({
              fromMinor: toBigIntAmount(b.fromMinor),
              uptoMinor: b.uptoMinor === null ? null : toBigIntAmount(b.uptoMinor),
              rateBps: b.rateBps,
              addMinor: toBigIntAmount(b.addMinor),
            })),
          },
          valuationMinor: BigInt(data.valuationMinor),
        });
      },
      { impersonationId: ctx.impersonationId },
    );

    return {
      ok: true,
      data: {
        feeMinor: serializeAmount(built.feeMinor),
        steps: built.steps.map((s) => ({
          label: s.label,
          amountMinor: serializeAmount(s.amountMinor),
        })),
        cappedAtMaximum: built.cappedAtMaximum,
        statuteRef: built.statuteRef,
        notes: built.notes,
      },
    };
  } catch (err) {
    return toSalesActionError(err, "quoteCourtFee");
  }
}

/* ------------------------------------------------------------------ */
/* GETTING IT BACK                                                     */
/* ------------------------------------------------------------------ */

const refundSchema = z.object({
  matterId: z.string().uuid(),
  disbursementId: z.string().uuid().nullish(),
  settlementRoute: z.enum(routes),
  settledOn: civilDay,
  statuteRef: z.string().trim().max(300).optional(),
  claimedMinor: paise,
  notes: z.string().trim().max(2000).optional(),
});

/**
 * ⭐⭐ A COURT FEE REFUND IS APPLIED FOR, NOT RECEIVED AUTOMATICALLY.
 *
 * 🔴 The route decides the answer, not the amount. The Supreme Court
 *    held on 20 December 2024 in *Sanjeevkumar Harakchand Kankariya v.
 *    Union of India* that a Lok Adalat award and a mediated settlement
 *    are not the same thing — the first carries a full statutory refund
 *    under s.21 of the Legal Services Authorities Act, the second gets
 *    whatever the State's own Court Fees Act gives it.
 *
 * ⚠️ So Ordence records the route and returns the entitlement as an
 *    opinion with its citation. It does not promise the money.
 */
export async function recordRefundClaim(input: unknown): Promise<
  ActionResult<{
    id: string;
    verdict: "full" | "none" | "state_specific";
    citation: string;
    reason: string;
    checkStateAct: boolean;
    notes: readonly string[];
  }>
> {
  try {
    const data = refundSchema.parse(input);
    const ctx = await requirePermission(WRITE);

    const entitlement = refundEntitlement({
      route: data.settlementRoute,
      stateStatuteRef: data.statuteRef ?? null,
    });

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [row] = await tx
          .insert(courtFeeRefundClaims)
          .values({
            tenantId: ctx.tenant.id,
            matterId: data.matterId,
            disbursementId: data.disbursementId ?? null,
            settlementRoute: data.settlementRoute,
            settledOn: data.settledOn,
            statuteRef: data.statuteRef ?? null,
            claimedMinor: BigInt(data.claimedMinor),
            status: "identified",
            notes: data.notes ?? null,
            createdBy: ctx.user.id,
          })
          .returning({ id: courtFeeRefundClaims.id });

        if (!row) throw new Error("The claim could not be recorded.");

        await writeAudit(ctx, {
          action: "create",
          resourceType: "court_fee_refund_claim",
          resourceId: row.id,
          newValue: {
            settlementRoute: data.settlementRoute,
            claimedMinor: data.claimedMinor,
            verdict: entitlement.verdict,
          },
          severity: "notice",
        });

        return { id: row.id };
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/legal/disbursements");
    return {
      ok: true,
      data: {
        id: result.id,
        verdict: entitlement.verdict,
        citation: entitlement.citation,
        reason: entitlement.reason,
        checkStateAct: entitlement.checkStateAct,
        notes: entitlement.notes,
      },
    };
  } catch (err) {
    return toSalesActionError(err, "recordRefundClaim");
  }
}

/** ⭐ Refunds identified or filed and not yet received. Money the firm is owed. */
export async function getRefundClaims(): Promise<
  ActionResult<{
    rows: {
      id: string;
      matterNo: string;
      settlementRoute: string;
      settledOn: string;
      claimedMinor: string;
      receivedMinor: string;
      status: string;
      verdict: "full" | "none" | "state_specific";
      checkStateAct: boolean;
    }[];
    outstandingMinor: string;
    needStateCheck: number;
  }>
> {
  try {
    const ctx = await requirePermission(READ);

    const rows = await withTenant(
      ctx.tenant.id,
      async (tx) =>
        tx
          .select({
            id: courtFeeRefundClaims.id,
            matterNo: legalMatters.matterNo,
            settlementRoute: courtFeeRefundClaims.settlementRoute,
            settledOn: courtFeeRefundClaims.settledOn,
            claimedMinor: courtFeeRefundClaims.claimedMinor,
            receivedMinor: courtFeeRefundClaims.receivedMinor,
            statuteRef: courtFeeRefundClaims.statuteRef,
            status: courtFeeRefundClaims.status,
          })
          .from(courtFeeRefundClaims)
          .leftJoin(legalMatters, eq(legalMatters.id, courtFeeRefundClaims.matterId))
          .where(eq(courtFeeRefundClaims.tenantId, ctx.tenant.id))
          .orderBy(desc(courtFeeRefundClaims.settledOn))
          .limit(200),
      { impersonationId: ctx.impersonationId },
    );

    let outstanding = 0n;
    let needCheck = 0;

    const out = rows.map((r) => {
      const claimed = toBigIntAmount(r.claimedMinor ?? 0n);
      const received = toBigIntAmount(r.receivedMinor ?? 0n);
      if (r.status === "identified" || r.status === "filed") {
        outstanding += claimed - received;
      }
      const e = refundEntitlement({
        route: r.settlementRoute as SettlementRoute,
        stateStatuteRef: r.statuteRef,
      });
      if (e.checkStateAct && (r.status === "identified" || r.status === "filed")) {
        needCheck += 1;
      }
      return {
        id: r.id,
        matterNo: r.matterNo ?? "—",
        settlementRoute: r.settlementRoute,
        settledOn: r.settledOn,
        claimedMinor: serializeAmount(claimed),
        receivedMinor: serializeAmount(received),
        status: r.status,
        verdict: e.verdict,
        checkStateAct: e.checkStateAct,
      };
    });

    return {
      ok: true,
      data: {
        rows: out,
        outstandingMinor: serializeAmount(outstanding),
        needStateCheck: needCheck,
      },
    };
  } catch (err) {
    return toSalesActionError(err, "getRefundClaims");
  }
}

/* ------------------------------------------------------------------ */

function money(minor: bigint): string {
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString().padStart(3, "0");
  const whole = digits.slice(0, -2);
  const frac = digits.slice(-2);
  const lastThree = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest
    ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${lastThree}`
    : lastThree;
  return `${negative ? "-" : ""}₹${grouped}.${frac}`;
}
