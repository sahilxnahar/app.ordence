"use server";

/**
 * Ordence — ⭐⭐⭐ THE FEE NOTE, AND WHO PAYS THE TAX ON IT
 * Version: v1.8.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION AND NONE TAKES A TENANT.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 A LAWYER'S BILL IS NOT SHAPED LIKE ANY OTHER BILL IN ORDENCE
 * ══════════════════════════════════════════════════════════════════════
 * Two facts, and both of them change the arithmetic:
 *
 * ① **The firm usually charges no GST.** Exempt under Notification
 *    12/2017 Sr. No. 45, or reverse charge under Notification 13/2017
 *    Sr. No. 2 where the client pays. Forward charge is the exception,
 *    not the default — and `raiseInvoiceFromTime` treated it as the
 *    default from v1.2.0 until now.
 *
 * ② **The court fee is not part of the value at all.** Rule 33 takes a
 *    pure agent's recovery out of the value of supply, provided it is
 *    recovered at exactly what was paid — so it is added AFTER the tax,
 *    on its own line, because Rule 33(ii) requires it to be
 *    "separately indicated in the invoice".
 *
 * ⭐ A fee note that adds the court fee into the fee total and prints one
 * number has failed Rule 33 on the face of the document, however
 * correctly the money actually moved.
 */

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenant } from "@/db";
import {
  legalClientTaxStatus,
  legalPracticeProfile,
  matterDisbursements,
} from "@/db/schema/legal-billing";
import { legalMatters } from "@/db/schema/legal";
import { companies } from "@/db/schema/crm";
import { requirePermission, writeAudit } from "@/server/audit";
import { toSalesActionError } from "@/server/sales/guards";
import { serializeAmount, toBigIntAmount } from "@/lib/billing/money";
import type { ActionResult } from "@/lib/validators/crm";
import {
  assessLegalCharge,
  assessRegistrationNeed,
  LEGAL_RECIPIENT_KINDS,
  LEGAL_SERVICE_KINDS,
  LEGAL_SUPPLIER_KINDS,
  type ChargeBasis,
  type LegalRecipientKind,
  type LegalServiceKind,
  type LegalSupplierKind,
} from "@/lib/legal/gst-legal";
import {
  DISBURSEMENT_LABELS,
  feeNoteTotals,
  type DisbursementKind,
  type FeeNoteLine,
} from "@/lib/legal/disbursement";

const READ = "sales.invoices.read" as const;
const WRITE = "sales.invoices.create" as const;

const paise = z.string().regex(/^\d+$/, "Whole paise, positive.");

const suppliers = LEGAL_SUPPLIER_KINDS as unknown as [
  LegalSupplierKind,
  ...LegalSupplierKind[],
];
const services = LEGAL_SERVICE_KINDS as unknown as [LegalServiceKind, ...LegalServiceKind[]];
const recipients = LEGAL_RECIPIENT_KINDS as unknown as [
  LegalRecipientKind,
  ...LegalRecipientKind[],
];

/* ------------------------------------------------------------------ */
/* HOW THIS FIRM IS TAXED                                              */
/* ------------------------------------------------------------------ */

const profileSchema = z.object({
  supplierKind: z.enum(suppliers),
  hasForwardChargeSupplies: z.boolean().default(false),
  seniorToAdvocatePosition: z.enum(["reverse_charge", "exempt"]).nullish(),
  seniorToAdvocateNote: z.string().trim().max(2000).nullish(),
});

/**
 * ⭐ The firm says what it is once, and every bill after that follows.
 *
 * 🔴 `seniorToAdvocatePosition` is the firm's own view on the one
 *    question Ordence refuses to decide — a senior advocate billing
 *    another advocate or a firm of advocates. Recording it requires a
 *    note, because a view taken on a contested question with no reason
 *    written down is not a view, it is a habit.
 */
export async function saveLegalPracticeProfile(
  input: unknown,
): Promise<ActionResult<{ ok: true }>> {
  try {
    const data = profileSchema.parse(input);
    const ctx = await requirePermission("settings:update");

    if (data.seniorToAdvocatePosition && !data.seniorToAdvocateNote) {
      throw new Error(
        "A position on the senior-advocate question has to say why. That note is what the firm shows, two years later, when it is asked why it treated a brief fee the way it did — and the question is genuinely unsettled, so the reasoning is the whole answer.",
      );
    }

    await withTenant(
      ctx.tenant.id,
      async (tx) => {
        await tx
          .insert(legalPracticeProfile)
          .values({
            tenantId: ctx.tenant.id,
            supplierKind: data.supplierKind,
            hasForwardChargeSupplies: data.hasForwardChargeSupplies,
            seniorToAdvocatePosition: data.seniorToAdvocatePosition ?? null,
            seniorToAdvocateNote: data.seniorToAdvocateNote ?? null,
            updatedBy: ctx.user.id,
          })
          .onConflictDoUpdate({
            target: legalPracticeProfile.tenantId,
            set: {
              supplierKind: data.supplierKind,
              hasForwardChargeSupplies: data.hasForwardChargeSupplies,
              seniorToAdvocatePosition: data.seniorToAdvocatePosition ?? null,
              seniorToAdvocateNote: data.seniorToAdvocateNote ?? null,
              updatedAt: new Date(),
              updatedBy: ctx.user.id,
            },
          });

        await writeAudit(ctx, {
          action: "update",
          resourceType: "legal_practice_profile",
          resourceId: ctx.tenant.id,
          newValue: {
            supplierKind: data.supplierKind,
            hasForwardChargeSupplies: data.hasForwardChargeSupplies,
          },
          /** It decides the tax treatment of every bill the firm raises. */
          severity: "critical",
        });
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/legal/fee-note");
    return { ok: true, data: { ok: true } };
  } catch (err) {
    return toSalesActionError(err, "saveLegalPracticeProfile");
  }
}

const clientStatusSchema = z.object({
  companyId: z.string().uuid(),
  recipientKind: z.enum(recipients),
  stateCode: z.string().trim().length(2).nullish(),
  recipientOutsideIndia: z.boolean().default(false),
  turnoverFy: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}$/, "Use the form 2024-25.")
    .nullish(),
  turnoverMinor: paise.nullish(),
  thresholdOverrideMinor: paise.nullish(),
  notes: z.string().trim().max(2000).nullish(),
});

/**
 * ⭐ WHAT THE CLIENT IS, WHICH DECIDES WHETHER ANYBODY PAYS TAX.
 *
 * 🔴 The exemption turns on the client's aggregate turnover in the
 *    **preceding** financial year — so the answer changes on 1 April and
 *    the year it relates to is half the fact. The database refuses a
 *    turnover with no year on it.
 */
export async function saveClientTaxStatus(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const data = clientStatusSchema.parse(input);
    const ctx = await requirePermission(WRITE);

    if (data.recipientOutsideIndia && data.stateCode) {
      throw new Error(
        "A client outside India cannot also have an Indian State code. Reverse charge under Sr. No. 2 reaches a business entity located in the taxable territory — an overseas client is not one, and the supply is an export instead.",
      );
    }
    if (data.turnoverMinor && !data.turnoverFy) {
      throw new Error(
        "A turnover figure has to say which financial year it is. The exemption is decided on the PRECEDING year, so a figure with no year attached cannot answer the question it was recorded for.",
      );
    }

    const id = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [row] = await tx
          .insert(legalClientTaxStatus)
          .values({
            tenantId: ctx.tenant.id,
            companyId: data.companyId,
            recipientKind: data.recipientKind,
            stateCode: data.stateCode ?? null,
            recipientOutsideIndia: data.recipientOutsideIndia,
            turnoverFy: data.turnoverFy ?? null,
            turnoverMinor: data.turnoverMinor ? BigInt(data.turnoverMinor) : null,
            thresholdOverrideMinor: data.thresholdOverrideMinor
              ? BigInt(data.thresholdOverrideMinor)
              : null,
            confirmedOn: new Date().toISOString().slice(0, 10),
            confirmedBy: ctx.user.id,
            notes: data.notes ?? null,
          })
          .onConflictDoUpdate({
            target: [legalClientTaxStatus.tenantId, legalClientTaxStatus.companyId],
            set: {
              recipientKind: data.recipientKind,
              stateCode: data.stateCode ?? null,
              recipientOutsideIndia: data.recipientOutsideIndia,
              turnoverFy: data.turnoverFy ?? null,
              turnoverMinor: data.turnoverMinor ? BigInt(data.turnoverMinor) : null,
              thresholdOverrideMinor: data.thresholdOverrideMinor
                ? BigInt(data.thresholdOverrideMinor)
                : null,
              confirmedOn: new Date().toISOString().slice(0, 10),
              confirmedBy: ctx.user.id,
              notes: data.notes ?? null,
              updatedAt: new Date(),
            },
          })
          .returning({ id: legalClientTaxStatus.id });

        if (!row) throw new Error("The client's tax status could not be saved.");
        return row.id;
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/legal/fee-note");
    return { ok: true, data: { id } };
  } catch (err) {
    return toSalesActionError(err, "saveClientTaxStatus");
  }
}

/* ------------------------------------------------------------------ */
/* THE DECISION, SHOWN BEFORE THE BILL IS RAISED                       */
/* ------------------------------------------------------------------ */

export type ChargeAnswer = {
  basis: ChargeBasis;
  invoiceTaxRateBps: number;
  isReverseCharge: boolean;
  citation: string;
  reason: string;
  invoiceDeclaration: string;
  arguable: boolean;
  arguableNote: string | null;
  notes: readonly string[];
};

/**
 * ⭐⭐ WHO PAYS THE TAX ON THIS BILL — worked out from what the firm is
 *     and what the client is, and shown with its citation.
 */
export async function chargeBasisFor(input: unknown): Promise<ActionResult<ChargeAnswer>> {
  try {
    const data = z
      .object({
        companyId: z.string().uuid(),
        service: z.enum(services).default("advice"),
        forwardRateBps: z.number().int().min(0).max(10000).default(1800),
      })
      .parse(input);
    const ctx = await requirePermission(READ);

    const answer = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [profile] = await tx
          .select()
          .from(legalPracticeProfile)
          .where(eq(legalPracticeProfile.tenantId, ctx.tenant.id))
          .limit(1);

        const [status] = await tx
          .select()
          .from(legalClientTaxStatus)
          .where(
            and(
              eq(legalClientTaxStatus.tenantId, ctx.tenant.id),
              eq(legalClientTaxStatus.companyId, data.companyId),
            ),
          )
          .limit(1);

        const verdict = assessLegalCharge({
          supplier: (profile?.supplierKind ?? "firm_of_advocates") as LegalSupplierKind,
          service: data.service,
          recipient: (status?.recipientKind ?? "business_entity") as LegalRecipientKind,
          recipientStateCode: status?.stateCode ?? null,
          recipientOutsideIndia: status?.recipientOutsideIndia ?? false,
          recipientTurnoverPrecedingFyMinor:
            status?.turnoverMinor === null || status?.turnoverMinor === undefined
              ? null
              : toBigIntAmount(status.turnoverMinor),
          thresholdOverrideMinor:
            status?.thresholdOverrideMinor === null ||
            status?.thresholdOverrideMinor === undefined
              ? null
              : toBigIntAmount(status.thresholdOverrideMinor),
          forwardRateBps: data.forwardRateBps,
        });

        const notes = [...verdict.notes];
        if (!profile) {
          notes.push(
            "⚠️ This firm has not said what it is. Ordence has assumed a firm of advocates, which is the common case — but an individual advocate, a senior advocate and a practice that is not a firm of advocates are treated differently, and the third one charges forward tax on everything.",
          );
        }
        if (!status) {
          notes.push(
            "🔴 Nothing is recorded about this client. Ordence has assumed a business entity, which puts the bill on reverse charge. If the client is an individual, a Government body or another firm of advocates, the supply is EXEMPT and the client should not be paying anything — record what they are.",
          );
        }

        /**
         * ⭐ THE FIRM'S OWN VIEW OVERRIDES THE FLAGGED ONE — but only on
         * the question that was flagged, and only where a reason was
         * recorded with it.
         */
        let basis = verdict.basis;
        let isRcm = verdict.isReverseCharge;
        let reason = verdict.reason;
        if (verdict.arguable && profile?.seniorToAdvocatePosition) {
          basis = profile.seniorToAdvocatePosition === "exempt" ? "exempt" : "reverse_charge";
          isRcm = basis === "reverse_charge";
          reason = `The firm has taken its own recorded position on this contested question: ${
            profile.seniorToAdvocateNote ?? ""
          }`;
        }

        return {
          basis,
          invoiceTaxRateBps: verdict.invoiceTaxRateBps,
          isReverseCharge: isRcm,
          citation: verdict.citation,
          reason,
          invoiceDeclaration: verdict.invoiceDeclaration,
          arguable: verdict.arguable,
          arguableNote: verdict.arguableNote ?? null,
          notes,
        } satisfies ChargeAnswer;
      },
      { impersonationId: ctx.impersonationId },
    );

    return { ok: true, data: answer };
  } catch (err) {
    return toSalesActionError(err, "chargeBasisFor");
  }
}

/* ------------------------------------------------------------------ */
/* WHAT THE BILL WOULD LOOK LIKE                                       */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐ THE FEE NOTE, PRICED — fees on one side, pure-agent disbursements
 *     on the other, and the two never added together before the tax.
 *
 * 🔴 Rule 33(ii): the payment made by the pure agent has to be
 *    "separately indicated in the invoice". This is where that becomes
 *    two numbers instead of one.
 */
export async function previewFeeNote(input: unknown): Promise<
  ActionResult<{
    charge: ChargeAnswer;
    lines: {
      id: string;
      kindLabel: string;
      description: string;
      paidMinor: string;
      recoveredMinor: string;
      isPureAgent: boolean;
    }[];
    feesMinor: string;
    pureAgentDisbursementsMinor: string;
    taxableRecoveriesMinor: string;
    taxableValueMinor: string;
    taxMinor: string;
    totalPayableMinor: string;
    taxRateBps: number;
  }>
> {
  try {
    const data = z
      .object({
        companyId: z.string().uuid(),
        matterId: z.string().uuid().nullish(),
        feesMinor: paise,
        service: z.enum(services).default("advice"),
        forwardRateBps: z.number().int().min(0).max(10000).default(1800),
      })
      .parse(input);
    const ctx = await requirePermission(READ);

    const charged = await chargeBasisFor({
      companyId: data.companyId,
      service: data.service,
      forwardRateBps: data.forwardRateBps,
    });
    if (!charged.ok) return charged;

    const rows = await withTenant(
      ctx.tenant.id,
      async (tx) =>
        tx
          .select({
            id: matterDisbursements.id,
            kind: matterDisbursements.kind,
            description: matterDisbursements.description,
            paidMinor: matterDisbursements.paidAmountMinor,
            recoveredMinor: matterDisbursements.recoveredAmountMinor,
            isPureAgent: matterDisbursements.isPureAgent,
          })
          .from(matterDisbursements)
          .where(
            and(
              eq(matterDisbursements.tenantId, ctx.tenant.id),
              eq(matterDisbursements.companyId, data.companyId),
              isNull(matterDisbursements.invoiceId),
              data.matterId
                ? eq(matterDisbursements.matterId, data.matterId)
                : sql`true`,
            ),
          )
          .orderBy(matterDisbursements.disbursementDate)
          .limit(200),
      { impersonationId: ctx.impersonationId },
    );

    const lines: FeeNoteLine[] = rows.map((r) => ({
      kind: (r.kind ?? "other") as DisbursementKind,
      description: r.description ?? "",
      paidMinor: toBigIntAmount(r.paidMinor ?? 0n),
      recoveredMinor: toBigIntAmount(r.recoveredMinor ?? 0n),
      isPureAgent: r.isPureAgent ?? false,
    }));

    const totals = feeNoteTotals({
      feesMinor: BigInt(data.feesMinor),
      lines,
      taxRateBps: charged.data.invoiceTaxRateBps,
    });

    return {
      ok: true,
      data: {
        charge: charged.data,
        lines: rows.map((r) => ({
          id: r.id,
          kindLabel: DISBURSEMENT_LABELS[(r.kind ?? "other") as DisbursementKind],
          description: r.description ?? "",
          paidMinor: serializeAmount(toBigIntAmount(r.paidMinor ?? 0n)),
          recoveredMinor: serializeAmount(toBigIntAmount(r.recoveredMinor ?? 0n)),
          isPureAgent: r.isPureAgent ?? false,
        })),
        feesMinor: serializeAmount(totals.feesMinor),
        pureAgentDisbursementsMinor: serializeAmount(totals.pureAgentDisbursementsMinor),
        taxableRecoveriesMinor: serializeAmount(totals.taxableRecoveriesMinor),
        taxableValueMinor: serializeAmount(totals.taxableValueMinor),
        taxMinor: serializeAmount(totals.taxMinor),
        totalPayableMinor: serializeAmount(totals.totalPayableMinor),
        taxRateBps: totals.taxRateBps,
      },
    };
  } catch (err) {
    return toSalesActionError(err, "previewFeeNote");
  }
}

/* ------------------------------------------------------------------ */
/* REGISTRATION                                                        */
/* ------------------------------------------------------------------ */

/**
 * ⭐ WHETHER THE FIRM HAS TO BE REGISTERED AT ALL.
 *
 * 🔴 A practice whose entire outward supply is legal services on reverse
 *    charge is not liable to register, however large — Notification
 *    5/2017-Central Tax under s.23(2). One forward-charge supply ends
 *    that, and firms make one without noticing: a seminar fee, a column,
 *    a sub-let of the chamber.
 */
export async function registrationPosition(): Promise<
  ActionResult<{
    mustRegister: boolean;
    reason: string;
    citation: string;
    notes: readonly string[];
    turnoverMinor: string;
  }>
> {
  try {
    const ctx = await requirePermission(READ);

    const answer = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [profile] = await tx
          .select()
          .from(legalPracticeProfile)
          .where(eq(legalPracticeProfile.tenantId, ctx.tenant.id))
          .limit(1);

        /**
         * ⚠️ Aggregate turnover under s.2(6) counts EXEMPT and
         * reverse-charge outward supplies too. Summing only taxable
         * invoices here would produce the answer a firm wants rather
         * than the one s.22 asks for.
         */
        const [agg] = await tx
          .select({
            total: sql<string>`COALESCE(SUM(${matterDisbursements.recoveredAmountMinor}), 0)`,
          })
          .from(matterDisbursements)
          .where(eq(matterDisbursements.tenantId, ctx.tenant.id));

        const turnover = toBigIntAmount(agg?.total ?? 0n);

        const v = assessRegistrationNeed({
          hasForwardChargeSupplies: profile?.hasForwardChargeSupplies ?? false,
          aggregateTurnoverMinor: turnover,
        });

        return {
          mustRegister: v.mustRegister,
          reason: v.reason,
          citation: v.citation,
          notes: [
            ...v.notes,
            "⚠️ The turnover figure Ordence used here is what it can see in this workspace. Aggregate turnover under s.2(6) is the whole of the firm's outward supplies on the same PAN across every State — check it against the books before relying on this.",
          ],
          turnoverMinor: serializeAmount(turnover),
        };
      },
      { impersonationId: ctx.impersonationId },
    );

    return { ok: true, data: answer };
  } catch (err) {
    return toSalesActionError(err, "registrationPosition");
  }
}
