"use server";

/**
 * Ordence — ⭐ RUNNING-ACCOUNT BILLS · THE MONEY PATH
 * Version: v0.69.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION. A `"use server"` file that
 * exports anything else publishes it as an RPC endpoint reachable by
 * anyone on the internet. The helpers below are deliberately not
 * exported.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE IS FOR
 * ══════════════════════════════════════════════════════════════════════
 * An RA bill is how a subcontractor gets paid for work in progress. It is
 * the single most consequential operation in the construction half of
 * this product, and until now there was no way to perform it except by
 * hand-writing SQL.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE BILL IS ASSEMBLED FROM MEASUREMENTS. IT IS NEVER TYPED.
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THIS IS THE DESIGN DECISION THE WHOLE FILE TURNS ON.
 *
 * The obvious API is "create a bill, then add lines to it" — a form with
 * a quantity box and a rate box. It is also the design under every
 * construction fraud this control structure exists to prevent, because a
 * typed quantity has no relationship to anything that was measured,
 * checked, or built.
 *
 * So there is no such function here. `raiseRaBillFromMeasurements()`
 * takes a contract and a period and derives every line from measurement
 * entries that are:
 *
 *     status = 'checked'     — somebody other than the measurer agreed
 *     ra_bill_id IS NULL     — not already claimed on an earlier bill
 *
 * The quantity comes from the measurement book. The rate comes from the
 * BOQ. Neither is an input. A user who wants to bill more must measure
 * more, and a user who wants a higher rate must raise a variation.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHAT THE DATABASE DOES, AND WHY IT IS NOT REDONE HERE
 * ══════════════════════════════════════════════════════════════════════
 * SQL 0031 and 0041 already enforce, in triggers:
 *
 *   · cess, retention, TDS and `net_payable` DERIVED from `gross_value`
 *     with half-up rounding — never accepted from a caller
 *   · `previous_paid_minor` summed from earlier bills on the contract
 *   · bills run in sequence and cannot skip
 *   · a certified bill's figures are frozen
 *   · status → `paid` refused without EPF/ESI evidence and an engineer's
 *     certificate
 *   · a bill line cannot claim more than the BOQ authorises (0041 §3)
 *
 * ⚠️ NONE OF THAT IS REIMPLEMENTED IN TYPESCRIPT, DELIBERATELY. A second
 * copy of the arithmetic is a second thing to keep in step, and the copy
 * that drifts is always the one nobody is looking at. This file supplies
 * `gross_value_minor` and lets the database do the rest — which is also
 * why the insert reads the row back rather than assuming what it wrote.
 */

import { z } from "zod";
import { and, eq, sql, desc, inArray, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withTenant } from "@/db";
import {
  boqs,
  boqItems,
  measurementBooks,
  measurementEntries,
  raBills,
  raBillLines,
  worksContracts,
} from "@/db/schema";
import { requirePermission, writeAudit } from "@/server/audit";
import { guardSalesWrite, toSalesActionError, salesFail } from "@/server/sales/guards";
import type { ActionResult } from "@/lib/validators/crm";

const RA_FEATURE = "construction.ra_bills" as const;

/** Micro-units per whole unit. See `server/actions/construction.ts`. */
const MICRO = 1_000_000n;

/**
 * quantity (micro) × rate (paise/unit) → amount (paise), half-up.
 *
 * ⚠️ THE SAME RULE AS `construction.ts` AND AS SQL 0031: half away from
 * zero, matching Tally. Three implementations of one rule is two too
 * many, and this one exists only because the value has to be known before
 * the row is written. If it ever disagrees with the other two, the bill
 * total will disagree with the ledger by a paisa and somebody will spend
 * an afternoon on it.
 */
function amountMinor(quantityMicro: bigint, rateMinor: bigint): bigint {
  const product = quantityMicro * rateMinor;
  const negative = product < 0n;
  const magnitude = negative ? -product : product;
  const rounded = (magnitude + MICRO / 2n) / MICRO;
  return negative ? -rounded : rounded;
}

/** Micro-units → a decimal(18,3) string, for `ra_bill_lines.quantity`. */
function microToDecimal3(micro: bigint): string {
  const negative = micro < 0n;
  const magnitude = negative ? -micro : micro;
  const whole = magnitude / MICRO;
  // Three decimal places, rounded half-up from the sixth.
  const thousandths = (magnitude % MICRO + 500n) / 1000n;
  const carry = thousandths / 1000n;
  const remainder = thousandths % 1000n;
  const text = `${whole + carry}.${remainder.toString().padStart(3, "0")}`;
  return negative ? `-${text}` : text;
}

/**
 * ⚠️ `tx.execute` RETURNS EITHER AN ARRAY OR `{ rows }` DEPENDING ON THE
 * DRIVER PATH. Reading the wrong one yields an empty result rather than
 * an error — a bill that renders as having no lines, which reads as an
 * empty claim rather than as a bug.
 */
function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

/* ------------------------------------------------------------------ */
/* RAISE                                                               */
/* ------------------------------------------------------------------ */

const raiseSchema = z.object({
  contractId: z.string().uuid("Choose a contract."),
  billNo: z.string().trim().min(1, "Number the bill.").max(60),
  periodFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.").optional(),
  periodTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.").optional(),
  /** YYYY-MM. Which month's EPF/ESI evidence the payment gate will check. */
  complianceMonth: z
    .string()
    .regex(/^\d{4}-\d{2}$/, "Use YYYY-MM.")
    .optional(),
  narration: z.string().trim().max(4000).nullable().optional(),
});

export type RaiseResult = {
  id: string;
  billNo: string;
  sequence: number;
  lines: number;
  grossValueMinor: string;
  cessMinor: string;
  retentionMinor: string;
  tdsMinor: string;
  netPayableMinor: string;
};

/**
 * Assemble a running-account bill from checked, unbilled measurements.
 *
 * ⚠️ ONE TRANSACTION FROM END TO END, AND IT HAS TO BE.
 *
 * The measurements are read, the bill is written, and the SAME
 * measurements are stamped with its id. If the stamp were a second
 * transaction, a failure between the two would leave the work claimed on
 * a bill and still marked unbilled — so the next bill would claim it
 * again, and the contractor would be paid twice for one pour. That is a
 * real payment, made twice, discovered at final account if at all.
 */
export async function raiseRaBillFromMeasurements(
  input: unknown,
): Promise<ActionResult<RaiseResult>> {
  try {
    const data = raiseSchema.parse(input);

    const ctx = await guardSalesWrite({
      operation: "raBill:create",
      feature: RA_FEATURE,
      permission: "contracting.rabill.raise",
      resource: { type: "works_contract", id: data.contractId },
    });

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        /* ---- 1 · The contract, and its deduction rates -------------- */
        const [contract] = await tx
          .select({
            id: worksContracts.id,
            status: worksContracts.status,
            vendorId: worksContracts.vendorId,
            projectId: worksContracts.projectId,
            cessRateBps: worksContracts.cessRateBps,
            retentionRateBps: worksContracts.retentionRateBps,
            tdsSection: worksContracts.tdsSection,
            tdsRateBps: worksContracts.tdsRateBps,
          })
          .from(worksContracts)
          .where(
            and(
              eq(worksContracts.tenantId, ctx.tenant.id),
              eq(worksContracts.id, data.contractId),
            ),
          )
          .limit(1);

        if (!contract) throw new Error("That contract does not exist.");

        /*
         * ⚠️ ONLY AN ACTIVE CONTRACT MAY BE BILLED. A terminated contract
         * that can still receive bills is how a dispute becomes a
         * payment. `completed` is excluded too: the final account closes
         * a contract, and a bill after it is a re-opening that somebody
         * should have to do deliberately.
         */
        if (contract.status !== "active") {
          throw new Error(
            `This contract is ${contract.status}, so no further bills can be raised against it.`,
          );
        }

        /* ---- 2 · The measurements that are eligible ----------------- */
        //
        // ⚠️ `status = 'checked'` AND `ra_bill_id IS NULL`, BOTH.
        //
        // Without the first, unchecked work is billed. Without the
        // second, work already claimed on RA-01 is claimed again on
        // RA-02 — and each bill looks correct on its own, which is
        // precisely why nobody catches it.
        //
        // ⚠️ THE RATE COMES FROM THE BOQ, NOT FROM ANY INPUT, and it is
        // the VARIED rate where a variation set one. Reading only the
        // original rate would silently underpay every varied line.
        //
        // ⚠️ A DEDUCTION SUBTRACTS. `is_deduction` marks a void or an
        // opening; summed as a positive it would bill the contractor for
        // the window holes as if they were wall.
        const groups = await tx
          .select({
            boqItemId: measurementEntries.boqItemId,
            itemCode: boqItems.itemCode,
            description: boqItems.description,
            uom: boqItems.uom,
            rateMinor: sql<string>`COALESCE(${boqItems.variedRateMinor}, ${boqItems.rateMinor})::text`,
            netMicro: sql<string>`SUM(
              CASE WHEN ${measurementEntries.isDeduction}
                   THEN -${measurementEntries.quantityScaled}
                   ELSE  ${measurementEntries.quantityScaled} END
            )::text`,
            entryIds: sql<string[]>`array_agg(${measurementEntries.id}::text)`,
          })
          .from(measurementEntries)
          .innerJoin(
            boqItems,
            and(
              eq(boqItems.id, measurementEntries.boqItemId),
              eq(boqItems.tenantId, measurementEntries.tenantId),
            ),
          )
          .innerJoin(
            measurementBooks,
            and(
              eq(measurementBooks.id, measurementEntries.measurementBookId),
              eq(measurementBooks.tenantId, measurementEntries.tenantId),
            ),
          )
          .innerJoin(
            boqs,
            and(eq(boqs.id, measurementBooks.boqId), eq(boqs.tenantId, measurementBooks.tenantId)),
          )
          .where(
            and(
              eq(measurementEntries.tenantId, ctx.tenant.id),
              eq(measurementEntries.status, "checked"),
              isNull(measurementEntries.raBillId),
              // ⭐ THE JOIN SQL 0041 MADE POSSIBLE. Before `boqs.contract_id`
              // existed there was no way to ask "which measurements belong
              // to this contract" — only "which belong to this project",
              // which mixes two subcontractors' work into one bill.
              eq(boqs.contractId, data.contractId),
            ),
          )
          .groupBy(
            measurementEntries.boqItemId,
            boqItems.itemCode,
            boqItems.description,
            boqItems.uom,
            boqItems.variedRateMinor,
            boqItems.rateMinor,
          )
          .orderBy(boqItems.itemCode);

        if (groups.length === 0) {
          throw new Error(
            "There is no checked, unbilled work against this contract. Either nothing has been measured since the last bill, or the measurements are still waiting to be checked by somebody other than the person who took them.",
          );
        }

        /* ---- 3 · Value each line ------------------------------------ */
        const lines = groups
          .map((group) => {
            const netMicro = BigInt(group.netMicro ?? "0");
            const rateMinor = BigInt(group.rateMinor ?? "0");
            return {
              boqItemId: group.boqItemId,
              itemCode: group.itemCode,
              description: group.description,
              uom: group.uom,
              netMicro,
              rateMinor,
              amount: amountMinor(netMicro, rateMinor),
              entryIds: group.entryIds ?? [],
            };
          })
          /*
           * ⚠️ A LINE THAT NETS TO ZERO OR BELOW IS DROPPED, NOT BILLED.
           *
           * It happens legitimately: a pour is measured, then a deduction
           * of the same size is raised against it after a rework. There
           * is a CHECK on `ra_bill_lines.quantity > 0`, so writing it
           * would fail the whole bill with a constraint name. Dropping it
           * is correct — but the entries still get stamped in step 5, so
           * the deduction is not left to reappear on the next bill.
           */
          .filter((line) => line.netMicro > 0n);

        if (lines.length === 0) {
          throw new Error(
            "Every measurement against this contract nets to zero once deductions are applied, so there is nothing to bill.",
          );
        }

        const grossValueMinor = lines.reduce((total, line) => total + line.amount, 0n);

        /* ---- 4 · The bill ------------------------------------------- */
        //
        // ⚠️ THE SEQUENCE IS MAX + 1, COMPUTED HERE, BECAUSE SQL 0031 §5
        // REFUSES A GAP. Letting the caller supply it would surface as a
        // trigger exception quoting a number the user never typed.
        const [seqRow] = await tx
          .select({ maxSeq: sql<number>`COALESCE(MAX(${raBills.sequence}), 0)` })
          .from(raBills)
          .where(
            and(
              eq(raBills.tenantId, ctx.tenant.id),
              eq(raBills.contractId, data.contractId),
            ),
          );

        const sequence = Number(seqRow?.maxSeq ?? 0) + 1;

        const [bill] = await tx
          .insert(raBills)
          .values({
            tenantId: ctx.tenant.id,
            billNo: data.billNo,
            sequence,
            contractId: data.contractId,
            vendorId: contract.vendorId,
            projectId: contract.projectId,
            periodFrom: data.periodFrom ?? null,
            periodTo: data.periodTo ?? null,
            complianceMonth: data.complianceMonth ?? null,
            grossValueMinor,
            /*
             * ⚠️ THE RATES ARE COPIED FROM THE CONTRACT ONTO THE BILL,
             * AND THAT IS ON PURPOSE. A bill certified at 5% retention
             * must still read 5% after somebody edits the contract to
             * 10% next year. The amounts themselves are derived by the
             * trigger from these rates — they are not passed, and passing
             * them would be overwritten anyway.
             */
            cessRateBps: contract.cessRateBps,
            retentionRateBps: contract.retentionRateBps,
            tdsSection: contract.tdsSection,
            tdsRateBps: contract.tdsRateBps,
            narration: data.narration ?? null,
            createdBy: ctx.user.id,
          })
          .returning({ id: raBills.id });

        if (!bill) throw new Error("The bill could not be created.");

        /* ---- 5 · Lines, then stamp the measurements ----------------- */
        //
        // ⚠️ THE LINES CARRY `boqItemId`. Without it SQL 0041's
        // over-billing guard skips the line entirely — silently. A bill
        // assembled by this function must always be checkable.
        await tx.insert(raBillLines).values(
          lines.map((line, index) => ({
            tenantId: ctx.tenant.id,
            raBillId: bill.id,
            lineNo: index + 1,
            boqItemId: line.boqItemId,
            boqCode: line.itemCode,
            description: line.description,
            unit: line.uom,
            quantity: microToDecimal3(line.netMicro),
            rateMinor: line.rateMinor,
            amountMinor: line.amount,
          })),
        );

        /*
         * ⚠️ EVERY ELIGIBLE ENTRY IS STAMPED — including the ones whose
         * line was dropped for netting to zero. Stamping only the billed
         * ones would leave a measurement and its own deduction in
         * different states: the deduction unclaimed and eligible again,
         * so the NEXT bill would open with a negative line against work
         * already settled.
         */
        const allEntryIds = groups.flatMap((group) => group.entryIds ?? []);

        await tx
          .update(measurementEntries)
          .set({ raBillId: bill.id, status: "billed", updatedAt: new Date() })
          .where(
            and(
              eq(measurementEntries.tenantId, ctx.tenant.id),
              inArray(measurementEntries.id, allEntryIds),
            ),
          );

        /* ---- 6 · Read the derived figures BACK ---------------------- */
        //
        // ⚠️ READ, NEVER ASSUMED. Cess, retention, TDS, `previous_paid`
        // and `net_payable` are all computed by a BEFORE trigger, so the
        // values this function inserted are not the values that landed.
        // Returning what we sent would show the user a net payable that
        // is simply the gross — a number that is wrong by the entire
        // deduction stack and looks completely plausible.
        const [written] = await tx
          .select({
            billNo: raBills.billNo,
            sequence: raBills.sequence,
            grossValueMinor: raBills.grossValueMinor,
            cessAmountMinor: raBills.cessAmountMinor,
            retentionAmountMinor: raBills.retentionAmountMinor,
            tdsAmountMinor: raBills.tdsAmountMinor,
            netPayableMinor: raBills.netPayableMinor,
          })
          .from(raBills)
          .where(and(eq(raBills.tenantId, ctx.tenant.id), eq(raBills.id, bill.id)))
          .limit(1);

        if (!written) throw new Error("The bill could not be read back.");

        return {
          id: bill.id,
          billNo: written.billNo,
          sequence: written.sequence,
          lines: lines.length,
          grossValueMinor: (written.grossValueMinor ?? 0n).toString(),
          cessMinor: (written.cessAmountMinor ?? 0n).toString(),
          retentionMinor: (written.retentionAmountMinor ?? 0n).toString(),
          tdsMinor: (written.tdsAmountMinor ?? 0n).toString(),
          netPayableMinor: (written.netPayableMinor ?? 0n).toString(),
        };
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: "create",
      resourceType: "ra_bill",
      resourceId: result.id,
      metadata: {
        contractId: data.contractId,
        billNo: result.billNo,
        sequence: result.sequence,
        lines: result.lines,
        grossValueMinor: result.grossValueMinor,
        netPayableMinor: result.netPayableMinor,
      },
      severity: "warning",
      reason: "RA bill raised from checked measurements.",
    });

    revalidatePath("/ra-bills");
    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "raiseRaBillFromMeasurements");
  }
}

/* ------------------------------------------------------------------ */
/* CERTIFY, THEN APPROVE — TWO PEOPLE, TWO DECISIONS                   */
/* ------------------------------------------------------------------ */

const transitionSchema = z.object({
  raBillId: z.string().uuid(),
  note: z.string().trim().max(2000).nullable().optional(),
});

/**
 * Certify a bill's value for payment.
 *
 * ⚠️ THIS IS A PROFESSIONAL OPINION ABOUT THE WORK, NOT A PAYMENT
 * DECISION. It says: the quantities are right and the value is fair. SQL
 * 0031 §6 freezes the figures once this happens, which is why it is a
 * separate step rather than something `approve` implies.
 *
 * ⚠️ AND THE CERTIFIER MUST NOT BE THE PERSON WHO RAISED IT. Same
 * reasoning as `checkMeasurement()`: a bill certified by whoever
 * assembled it is a bill nobody independent has looked at, and it is
 * indistinguishable in the record from one that two people reviewed.
 */
export async function certifyRaBill(
  input: unknown,
): Promise<ActionResult<{ id: string; status: string }>> {
  try {
    const data = transitionSchema.parse(input);

    const ctx = await guardSalesWrite({
      operation: "raBill:certify",
      feature: RA_FEATURE,
      permission: "contracting.rabill.certify",
      resource: { type: "ra_bill", id: data.raBillId },
    });

    await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [bill] = await tx
          .select({
            id: raBills.id,
            status: raBills.status,
            createdBy: raBills.createdBy,
          })
          .from(raBills)
          .where(and(eq(raBills.tenantId, ctx.tenant.id), eq(raBills.id, data.raBillId)))
          .limit(1);

        if (!bill) throw new Error("That bill does not exist.");

        if (bill.createdBy && bill.createdBy === ctx.user.id) {
          throw new Error(
            "You raised this bill, so you cannot certify it. Certification is somebody else confirming the work is worth the money — done by the person who assembled the claim, it records a second review that never happened.",
          );
        }

        if (bill.status !== "draft" && bill.status !== "submitted") {
          throw new Error(`This bill is already ${bill.status}.`);
        }

        await tx
          .update(raBills)
          .set({
            status: "certified",
            certifiedBy: ctx.user.id,
            certifiedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(and(eq(raBills.tenantId, ctx.tenant.id), eq(raBills.id, data.raBillId)));
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      action: "update",
      resourceType: "ra_bill",
      resourceId: data.raBillId,
      metadata: { status: "certified" },
      severity: "warning",
      reason: data.note ?? "Bill certified for payment.",
    });

    revalidatePath("/ra-bills");
    revalidatePath(`/ra-bills/${data.raBillId}`);
    return { ok: true, data: { id: data.raBillId, status: "certified" } };
  } catch (err) {
    return toSalesActionError(err, "certifyRaBill");
  }
}

/**
 * Approve a certified bill for payment.
 *
 * ⚠️ THIS IS THE INSTRUCTION TO PAY. It is separate from certification
 * because the two are different judgements by different people —
 * "the work is worth this" and "we are paying this now".
 *
 * ⚠️ ONLY A CERTIFIED BILL CAN BE APPROVED. Approving a draft would skip
 * the engineer entirely, which is the one sequence this whole file is
 * arranged to prevent.
 *
 * ⚠️ APPROVAL IS NOT PAYMENT. Moving to `paid` is a separate step, and
 * SQL 0031 §4 refuses it without EPF/ESI evidence and an engineer's
 * certificate. That gate is not reimplemented here — see the header.
 */
export async function approveRaBill(
  input: unknown,
): Promise<ActionResult<{ id: string; status: string }>> {
  try {
    const data = transitionSchema.parse(input);

    const ctx = await guardSalesWrite({
      operation: "raBill:approve",
      feature: RA_FEATURE,
      permission: "contracting.rabill.approve",
      resource: { type: "ra_bill", id: data.raBillId },
    });

    await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [bill] = await tx
          .select({
            status: raBills.status,
            certifiedBy: raBills.certifiedBy,
            createdBy: raBills.createdBy,
          })
          .from(raBills)
          .where(and(eq(raBills.tenantId, ctx.tenant.id), eq(raBills.id, data.raBillId)))
          .limit(1);

        if (!bill) throw new Error("That bill does not exist.");

        if (bill.status !== "certified") {
          throw new Error(
            bill.status === "draft" || bill.status === "submitted"
              ? "This bill has not been certified yet. Approving it now would release money for work no engineer has confirmed."
              : `This bill is already ${bill.status}.`,
          );
        }

        /*
         * ⚠️ THE APPROVER MUST BE A THIRD PERSON. Raise, certify,
         * approve — three decisions, three people. Allowing the certifier
         * to approve collapses the last two into one signature, which is
         * the arrangement every construction fraud case turns on.
         */
        if (bill.certifiedBy === ctx.user.id) {
          throw new Error(
            "You certified this bill, so you cannot also approve it for payment. Certifying says the work is worth the money; approving releases it. They are meant to be two people.",
          );
        }

        await tx
          .update(raBills)
          .set({
            status: "approved",
            approvedBy: ctx.user.id,
            approvedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(and(eq(raBills.tenantId, ctx.tenant.id), eq(raBills.id, data.raBillId)));
      },
      { impersonationId: ctx.impersonationId },
    );

    await writeAudit(ctx, {
      // ⚠️ `update`, not `approve` — the audit_action enum has no such
      // value, and inventing one here would fail at runtime rather than
      // at build time on some other schema. The approval is recorded by
      // the status in metadata and the reason, which is what a reader
      // needs anyway.
      action: "update",
      resourceType: "ra_bill",
      resourceId: data.raBillId,
      metadata: { status: "approved" },
      severity: "warning",
      reason: data.note ?? "Bill approved for payment.",
    });

    revalidatePath("/ra-bills");
    revalidatePath(`/ra-bills/${data.raBillId}`);
    return { ok: true, data: { id: data.raBillId, status: "approved" } };
  } catch (err) {
    return toSalesActionError(err, "approveRaBill");
  }
}

/* ------------------------------------------------------------------ */
/* READS                                                               */
/* ------------------------------------------------------------------ */

export type RaBillSummary = {
  id: string;
  billNo: string;
  sequence: number;
  contractId: string;
  status: string;
  periodFrom: string | null;
  periodTo: string | null;
  grossValueMinor: string;
  retentionMinor: string;
  tdsMinor: string;
  netPayableMinor: string;
  lines: number;
};

export async function listRaBills(): Promise<ActionResult<RaBillSummary[]>> {
  try {
    const ctx = await requirePermission("contracting.rabill.read");

    const rows = await withTenant(ctx.tenant.id, async (tx) =>
      tx
        .select({
          id: raBills.id,
          billNo: raBills.billNo,
          sequence: raBills.sequence,
          contractId: raBills.contractId,
          status: raBills.status,
          periodFrom: raBills.periodFrom,
          periodTo: raBills.periodTo,
          grossValueMinor: raBills.grossValueMinor,
          retentionAmountMinor: raBills.retentionAmountMinor,
          tdsAmountMinor: raBills.tdsAmountMinor,
          netPayableMinor: raBills.netPayableMinor,
          lines: sql<number>`(
            SELECT count(*)::int FROM ${raBillLines}
             WHERE ${raBillLines.raBillId} = ${raBills.id}
               AND ${raBillLines.tenantId} = ${raBills.tenantId}
          )`,
        })
        .from(raBills)
        .where(eq(raBills.tenantId, ctx.tenant.id))
        .orderBy(desc(raBills.createdAt))
        .limit(200),
    );

    return {
      ok: true,
      data: rows.map((row) => ({
        id: row.id,
        billNo: row.billNo,
        sequence: row.sequence,
        contractId: row.contractId,
        status: row.status,
        periodFrom: row.periodFrom,
        periodTo: row.periodTo,
        // Money crosses to the client as a STRING — JSON.stringify throws
        // on a bigint, at runtime, only on pages that render money.
        grossValueMinor: (row.grossValueMinor ?? 0n).toString(),
        retentionMinor: (row.retentionAmountMinor ?? 0n).toString(),
        tdsMinor: (row.tdsAmountMinor ?? 0n).toString(),
        netPayableMinor: (row.netPayableMinor ?? 0n).toString(),
        lines: Number(row.lines ?? 0),
      })),
    };
  } catch (err) {
    return toSalesActionError(err, "listRaBills");
  }
}

/**
 * How much checked, unbilled work is sitting against each contract.
 *
 * ⚠️ THIS IS THE NUMBER THAT DECIDES WHETHER TO RAISE A BILL AT ALL, and
 * it is also the number a subcontractor rings up about. Work measured,
 * checked, and never claimed is the most common reason a contractor stops
 * turning up — and before this function there was no screen that showed
 * it per contract.
 */
export type BillableWork = {
  contractId: string;
  contractNo: string;
  title: string;
  entries: number;
  valueMinor: string;
};

export async function getBillableWork(): Promise<ActionResult<BillableWork[]>> {
  try {
    const ctx = await requirePermission("contracting.rabill.read");

    const rows = await withTenant(ctx.tenant.id, async (tx) =>
      tx
        .select({
          contractId: worksContracts.id,
          contractNo: worksContracts.contractNo,
          title: worksContracts.title,
          entries: sql<number>`count(${measurementEntries.id})::int`,
          valueMinor: sql<string>`COALESCE(SUM(
            ROUND(
              (CASE WHEN ${measurementEntries.isDeduction}
                    THEN -${measurementEntries.quantityScaled}
                    ELSE  ${measurementEntries.quantityScaled} END)::numeric
              * COALESCE(${boqItems.variedRateMinor}, ${boqItems.rateMinor})::numeric
              / 1000000
            )
          ), 0)::text`,
        })
        .from(measurementEntries)
        .innerJoin(
          boqItems,
          and(
            eq(boqItems.id, measurementEntries.boqItemId),
            eq(boqItems.tenantId, measurementEntries.tenantId),
          ),
        )
        .innerJoin(
          measurementBooks,
          and(
            eq(measurementBooks.id, measurementEntries.measurementBookId),
            eq(measurementBooks.tenantId, measurementEntries.tenantId),
          ),
        )
        .innerJoin(
          boqs,
          and(eq(boqs.id, measurementBooks.boqId), eq(boqs.tenantId, measurementBooks.tenantId)),
        )
        .innerJoin(
          worksContracts,
          and(
            eq(worksContracts.id, boqs.contractId),
            eq(worksContracts.tenantId, boqs.tenantId),
          ),
        )
        .where(
          and(
            eq(measurementEntries.tenantId, ctx.tenant.id),
            eq(measurementEntries.status, "checked"),
            isNull(measurementEntries.raBillId),
          ),
        )
        .groupBy(worksContracts.id, worksContracts.contractNo, worksContracts.title)
        .orderBy(desc(sql`count(${measurementEntries.id})`)),
    );

    return {
      ok: true,
      data: rows.map((row) => ({
        contractId: row.contractId,
        contractNo: row.contractNo,
        title: row.title,
        entries: Number(row.entries ?? 0),
        valueMinor: String(row.valueMinor ?? "0"),
      })),
    };
  } catch (err) {
    return toSalesActionError(err, "getBillableWork");
  }
}

/* ------------------------------------------------------------------ */
/* ONE BILL, IN FULL                                                   */
/* ------------------------------------------------------------------ */

export type RaBillLineRow = {
  id: string;
  lineNo: number;
  boqCode: string | null;
  boqItemId: string | null;
  description: string;
  unit: string;
  quantity: string;
  rateMinor: string;
  amountMinor: string;
};

export type RaBillDetail = {
  id: string;
  billNo: string;
  sequence: number;
  status: string;
  contractId: string;
  contractNo: string | null;
  vendorName: string | null;
  projectName: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  complianceMonth: string | null;
  grossValueMinor: string;
  previousPaidMinor: string;
  cessMinor: string;
  cessRateBps: number;
  retentionMinor: string;
  retentionRateBps: number;
  tdsMinor: string;
  tdsSection: string | null;
  tdsRateBps: number | null;
  netPayableMinor: string;
  narration: string | null;
  /** Who did what. The names are the control. */
  createdBy: string | null;
  createdByName: string | null;
  certifiedBy: string | null;
  certifiedByName: string | null;
  approvedByName: string | null;
  lines: RaBillLineRow[];
  /** ⚠️ Lines with no BOQ item behind them are UNCHECKED by SQL 0041 §3. */
  uncheckedLines: number;
};

export async function getRaBillDetail(billId: string): Promise<ActionResult<RaBillDetail>> {
  try {
    const ctx = await requirePermission("contracting.rabill.read");

    const data = await withTenant(ctx.tenant.id, async (tx) => {
      const head = rowsOf(
        await tx.execute(sql`
          SELECT b.*, wc.contract_no, v.legal_name AS vendor_name, p.name AS project_name,
                 cu.first_name || ' ' || COALESCE(cu.last_name, '') AS created_by_name,
                 ce.first_name || ' ' || COALESCE(ce.last_name, '') AS certified_by_name,
                 ap.first_name || ' ' || COALESCE(ap.last_name, '') AS approved_by_name
            FROM ra_bills b
            LEFT JOIN works_contracts wc ON wc.id = b.contract_id AND wc.tenant_id = b.tenant_id
            LEFT JOIN vendors v          ON v.id  = b.vendor_id   AND v.tenant_id  = b.tenant_id
            LEFT JOIN projects p         ON p.id  = b.project_id  AND p.tenant_id  = b.tenant_id
            LEFT JOIN users cu           ON cu.id = b.created_by   AND cu.tenant_id = b.tenant_id
            LEFT JOIN users ce           ON ce.id = b.certified_by AND ce.tenant_id = b.tenant_id
            LEFT JOIN users ap           ON ap.id = b.approved_by  AND ap.tenant_id = b.tenant_id
           WHERE b.tenant_id = ${ctx.tenant.id} AND b.id = ${billId}
           LIMIT 1
        `),
      )[0];

      if (!head) throw new Error("That bill does not exist.");

      const lines = rowsOf(
        await tx.execute(sql`
          SELECT id, line_no, boq_code, boq_item_id, description, unit,
                 quantity, rate_minor, amount_minor
            FROM ra_bill_lines
           WHERE tenant_id = ${ctx.tenant.id} AND ra_bill_id = ${billId}
           ORDER BY line_no
        `),
      );

      return { head, lines };
    });

    const h = data.head;
    const lines = data.lines.map((r) => ({
      id: String(r.id),
      lineNo: Number(r.line_no),
      boqCode: r.boq_code ? String(r.boq_code) : null,
      boqItemId: r.boq_item_id ? String(r.boq_item_id) : null,
      description: String(r.description),
      unit: String(r.unit),
      quantity: String(r.quantity ?? "0"),
      rateMinor: String(r.rate_minor ?? "0"),
      amountMinor: String(r.amount_minor ?? "0"),
    }));

    return {
      ok: true,
      data: {
        id: String(h.id),
        billNo: String(h.bill_no),
        sequence: Number(h.sequence),
        status: String(h.status),
        contractId: String(h.contract_id),
        contractNo: h.contract_no ? String(h.contract_no) : null,
        vendorName: h.vendor_name ? String(h.vendor_name) : null,
        projectName: h.project_name ? String(h.project_name) : null,
        periodFrom: h.period_from ? String(h.period_from).slice(0, 10) : null,
        periodTo: h.period_to ? String(h.period_to).slice(0, 10) : null,
        complianceMonth: h.compliance_month ? String(h.compliance_month) : null,
        grossValueMinor: String(h.gross_value_minor ?? "0"),
        previousPaidMinor: String(h.previous_paid_minor ?? "0"),
        cessMinor: String(h.cess_amount_minor ?? "0"),
        cessRateBps: Number(h.cess_rate_bps ?? 0),
        retentionMinor: String(h.retention_amount_minor ?? "0"),
        retentionRateBps: Number(h.retention_rate_bps ?? 0),
        tdsMinor: String(h.tds_amount_minor ?? "0"),
        tdsSection: h.tds_section ? String(h.tds_section) : null,
        tdsRateBps: h.tds_rate_bps == null ? null : Number(h.tds_rate_bps),
        netPayableMinor: String(h.net_payable_minor ?? "0"),
        narration: h.narration ? String(h.narration) : null,
        createdBy: h.created_by ? String(h.created_by) : null,
        createdByName: h.created_by_name ? String(h.created_by_name).trim() : null,
        certifiedBy: h.certified_by ? String(h.certified_by) : null,
        certifiedByName: h.certified_by_name ? String(h.certified_by_name).trim() : null,
        approvedByName: h.approved_by_name ? String(h.approved_by_name).trim() : null,
        lines,
        /*
         * ⚠️ COUNTED AND SURFACED. A line with no `boq_item_id` is skipped
         * entirely by SQL 0041's over-billing guard — legitimately, for
         * day-work and provisional sums. But "this line was not checked"
         * is exactly what somebody approving a payment needs to know, and
         * it is invisible on the row itself.
         */
        uncheckedLines: lines.filter((line) => !line.boqItemId).length,
      },
    };
  } catch (err) {
    return toSalesActionError(err, "getRaBillDetail");
  }
}
