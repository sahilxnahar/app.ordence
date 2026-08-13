"use server";

/**
 * Ordence — ⭐⭐ E-WAY BILL · Rule 138
 * Version: v1.3.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION AND NONE TAKES A TENANT. The
 * arithmetic lives in `lib/gst/eway.ts`, which is pure and has no clock.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THIS MODULE POSTS NOTHING TO THE LEDGER, DELIBERATELY
 * ══════════════════════════════════════════════════════════════════════
 * An e-way bill records a MOVEMENT, not an economic event. The revenue
 * was recognised when the invoice was issued and it posted then. A
 * journal here would double the sale — once for the invoice and once for
 * the lorry that carried it.
 *
 * ⚠️ So `eway` is not on `check:posting`'s FINANCIAL_MODULES list, for
 * the same reason `variations` was removed from it in rc.2: the only way
 * to satisfy a posting requirement for an event with no economic effect
 * is to invent a journal.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenant } from "@/db";
import { ewayBills, ewayBillItems, ewayBillVehicles } from "@/db/schema/gst";
import { salesInvoices, salesInvoiceLines } from "@/db/schema/sales-invoices";
import { requirePermission, writeAudit } from "@/server/audit";
import { toSalesActionError } from "@/server/sales/guards";
import {
  buildEwayPayload,
  canCancelEway,
  canExtendEway,
  consignmentValue,
  documentEligible,
  ewayRequired,
  ewayValidUntil,
  ewayValidityDays,
  isValidVehicleNumber,
  normaliseVehicleNumber,
  partBRequired,
  EWAY_MAX_DISTANCE_KM,
  type EwayDocumentType,
  type EwaySubSupplyType,
  type EwayTransactionType,
  type EwayTransportMode,
  type EwayVehicleType,
} from "@/lib/gst/eway";
import { serializeAmount, toBigIntAmount } from "@/lib/billing/money";
import type { ActionResult } from "@/lib/validators/crm";

const READ = "sales.invoices.read" as const;
/** ⭐ An e-way bill is a dispatch act, so it takes the dispatch permission. */
const DISPATCH = "sales.orders.dispatch" as const;
const CANCEL = "sales.orders.cancel" as const;

const civilDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");
const pincode = z.string().regex(/^\d{6}$/, "A PIN code is six digits.");
const stateCode = z.string().regex(/^\d{2}$/, "A state code is two digits.");

const transportModes = ["road", "rail", "air", "ship"] as const;

const partBSchema = z.object({
  transportMode: z.enum(transportModes),
  vehicleNo: z.string().trim().max(20).optional(),
  transporterDocNo: z.string().trim().max(40).optional(),
  transporterDocDate: civilDay.optional(),
  fromPlace: z.string().trim().max(255).optional(),
  fromStateCode: stateCode.optional(),
  reasonCode: z.string().trim().max(20).optional(),
  reasonNote: z.string().trim().max(500).optional(),
});

/**
 * ⚠️ VALIDATED HERE AS WELL AS BY THE PORTAL, because the portal
 * validates it AFTER the goods are on the lorry. A refusal at that point
 * costs a loading bay; a refusal on this form costs a retype.
 */
function assertPartB(input: z.infer<typeof partBSchema>): void {
  if (input.transportMode === "road") {
    if (!input.vehicleNo) {
      throw new Error(
        "Movement by road needs a vehicle number. Without one the e-way bill is not valid for movement.",
      );
    }
    if (!isValidVehicleNumber(input.vehicleNo)) {
      throw new Error(
        `"${input.vehicleNo}" is not a registration number the portal will accept. Use the plate as written, without spaces — MH12AB1234.`,
      );
    }
  } else if (!input.transporterDocNo) {
    throw new Error(
      "Rail, air and ship movements need the transport document number — the railway receipt, airway bill or bill of lading.",
    );
  }
}

/* ================================================================== */
/* ① PREPARE — FROM AN ISSUED TAX INVOICE                              */
/* ================================================================== */

const prepareSchema = z.object({
  invoiceId: z.string().uuid(),

  fromPincode: pincode,
  fromPlace: z.string().trim().max(255).optional(),
  toPincode: pincode,
  toPlace: z.string().trim().max(255).optional(),
  /** ⚠️ Where the goods PHYSICALLY leave from — not the registered state. */
  dispatchStateCode: stateCode.optional(),
  deliveryStateCode: stateCode.optional(),

  distanceKm: z.number().int().min(0).max(EWAY_MAX_DISTANCE_KM),
  vehicleType: z.enum(["regular", "odc"]).default("regular"),

  subSupplyType: z
    .enum([
      "supply",
      "export",
      "import",
      "job_work",
      "for_own_use",
      "job_work_returns",
      "sales_return",
      "others",
      "skd_ckd",
      "line_sales",
      "recipient_not_known",
      "exhibition_or_fairs",
    ])
    .default("supply"),
  transactionType: z
    .enum(["regular", "bill_to_ship_to", "bill_from_dispatch_from", "combination"])
    .default("regular"),

  transporterGstin: z.string().trim().length(15).optional(),
  transporterName: z.string().trim().max(255).optional(),

  partB: partBSchema.optional(),

  /**
   * ⭐ Rule 138(3) lets a registered person raise one voluntarily below
   * the threshold. Real, and used — a customer's own compliance policy
   * often demands one.
   */
  voluntary: z.boolean().default(false),
  /** A State-notified intra-state threshold, in paise, if one applies. */
  intraStateThresholdMinor: z.string().regex(/^\d+$/).optional(),
  notes: z.string().trim().max(2000).optional(),
});

/**
 * ⭐⭐ BUILD THE E-WAY BILL FROM AN ISSUED TAX INVOICE.
 *
 * 🔴 IT REFUSES A DRAFT. A draft invoice has a placeholder number
 *    (`DRAFT-…`) and no legal existence. An e-way bill quoting it names
 *    a document that will never exist under that number, and the
 *    mismatch is found by an officer comparing the two.
 *
 * 🔴 AND IT REFUSES A SERVICES INVOICE. Rule 138 is about the movement
 *    of GOODS. Nothing moves on a legal fee.
 */
export async function prepareEwayBill(
  input: unknown,
): Promise<
  ActionResult<{
    id: string;
    consignmentValueMinor: string;
    validityDays: number;
    required: boolean;
    requirementReason: string;
  }>
> {
  try {
    const data = prepareSchema.parse(input);
    const ctx = await requirePermission(DISPATCH);
    if (data.partB) assertPartB(data.partB);

    const now = new Date();

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [invoice] = await tx
          .select({
            id: salesInvoices.id,
            invoiceNumber: salesInvoices.invoiceNumber,
            invoiceDate: salesInvoices.invoiceDate,
            status: salesInvoices.status,
            supplyType: salesInvoices.supplyType,
            isInterState: salesInvoices.isInterState,
            supplierGstin: salesInvoices.supplierGstin,
            supplierStateCode: salesInvoices.supplierStateCode,
            customerGstin: salesInvoices.customerGstin,
            customerLegalName: salesInvoices.customerLegalName,
            placeOfSupplyCode: salesInvoices.placeOfSupplyCode,
            ewayBillNo: salesInvoices.ewayBillNo,
          })
          .from(salesInvoices)
          .where(
            and(
              eq(salesInvoices.tenantId, ctx.tenant.id),
              eq(salesInvoices.id, data.invoiceId),
            ),
          )
          .limit(1);

        if (!invoice) throw new Error("That invoice does not exist.");

        if (invoice.status === "draft") {
          throw new Error(
            "This invoice is still a draft, so its number is a placeholder. Issue it first — an e-way bill must quote a document number that will still exist tomorrow.",
          );
        }
        if (invoice.status === "cancelled") {
          throw new Error("This invoice has been cancelled. Nothing should be moving on it.");
        }
        if (invoice.supplyType !== "goods") {
          throw new Error(
            "Rule 138 covers the movement of goods. This is a services invoice, and nothing physically moves on it.",
          );
        }

        /**
         * 🔴 CHECKED BEFORE ANYTHING IS LOADED. Since 1 January 2025 the
         * portal refuses a document more than 180 days old — and finding
         * that out at generation means the goods are already on the
         * vehicle and the invoice cannot be re-dated.
         */
        const eligible = documentEligible({
          documentDate: new Date(`${invoice.invoiceDate}T00:00:00.000Z`),
          now,
        });
        if (!eligible.allowed) throw new Error(eligible.reason);

        const lines = await tx
          .select({
            lineNo: salesInvoiceLines.lineNo,
            description: salesInvoiceLines.description,
            hsnSacCode: salesInvoiceLines.hsnSacCode,
            quantity: salesInvoiceLines.quantity,
            uom: salesInvoiceLines.uom,
            taxRateBps: salesInvoiceLines.taxRateBps,
            cessRateBps: salesInvoiceLines.cessRateBps,
            taxableValueMinor: salesInvoiceLines.taxableValueMinor,
            cgstMinor: salesInvoiceLines.cgstMinor,
            sgstMinor: salesInvoiceLines.sgstMinor,
            igstMinor: salesInvoiceLines.igstMinor,
            cessMinor: salesInvoiceLines.cessMinor,
          })
          .from(salesInvoiceLines)
          .where(
            and(
              eq(salesInvoiceLines.tenantId, ctx.tenant.id),
              eq(salesInvoiceLines.invoiceId, invoice.id),
            ),
          )
          .orderBy(salesInvoiceLines.lineNo);

        if (lines.length === 0) {
          throw new Error("This invoice has no lines, so it describes no consignment.");
        }

        /**
         * ⚠️ A ZERO-RATED LINE IS TREATED AS EXEMPT FOR THE THRESHOLD,
         * AND THE IMPRECISION IS WORTH NAMING. Nil-rated, exempt and
         * non-GST supplies are three different things in law and all
         * three carry a rate of zero. For Explanation 2 the distinction
         * does not change the arithmetic — none of them contributes tax
         * and all three are excluded on a mixed document — so one test
         * covers them. It would matter for GSTR-1, and that is computed
         * elsewhere from the invoice, not from here.
         */
        const valued = consignmentValue(
          lines.map((l) => ({
            taxableValueMinor: toBigIntAmount(l.taxableValueMinor),
            taxValueMinor:
              toBigIntAmount(l.cgstMinor) +
              toBigIntAmount(l.sgstMinor) +
              toBigIntAmount(l.igstMinor) +
              toBigIntAmount(l.cessMinor),
            isExempt: (l.taxRateBps ?? 0) === 0 && (l.cessRateBps ?? 0) === 0,
          })),
        );

        const requirement = ewayRequired({
          consignmentMinor: valued.consignmentMinor,
          isInterState: invoice.isInterState,
          ...(data.intraStateThresholdMinor
            ? { intraStateThresholdMinor: BigInt(data.intraStateThresholdMinor) }
            : {}),
        });

        /**
         * ⚠️ BELOW THE THRESHOLD IS REFUSED UNLESS SOMEBODY SAYS IT IS
         * DELIBERATE. Raising e-way bills that were never required is
         * not harmless — each one is a movement declared to the
         * Government, and a cancelled or expired one that nobody
         * needed is a question at an audit.
         */
        if (!requirement.required && !data.voluntary) {
          throw new Error(
            `${requirement.reason} If you want one anyway — some customers require it — tick "raise it voluntarily".`,
          );
        }

        const fromState =
          data.dispatchStateCode ?? invoice.supplierStateCode ?? "27";
        const toState =
          data.deliveryStateCode ?? invoice.placeOfSupplyCode ?? fromState;

        const validityDays = ewayValidityDays(data.distanceKm, data.vehicleType);

        const [row] = await tx
          .insert(ewayBills)
          .values({
            tenantId: ctx.tenant.id,
            documentType: "tax_invoice" satisfies EwayDocumentType,
            documentNo: invoice.invoiceNumber,
            documentDate: invoice.invoiceDate,
            invoiceId: invoice.id,

            supplierGstin: invoice.supplierGstin,
            fromStateCode: fromState,
            fromPlace: data.fromPlace ?? null,
            fromPincode: data.fromPincode,

            recipientGstin: invoice.customerGstin,
            recipientLegalName: invoice.customerLegalName,
            toStateCode: toState,
            toPlace: data.toPlace ?? null,
            toPincode: data.toPincode,

            transactionType: data.transactionType,
            supplyType: "outward",
            subSupplyType: data.subSupplyType,

            taxableValueMinor: valued.taxableMinor,
            taxValueMinor: valued.taxMinor,
            exemptValueMinor: valued.exemptMinor,
            consignmentValueMinor: valued.consignmentMinor,

            transporterGstin: data.transporterGstin ?? null,
            transporterName: data.transporterName ?? null,
            transportMode: data.partB?.transportMode ?? null,
            transporterDocNo: data.partB?.transporterDocNo ?? null,
            transporterDocDate: data.partB?.transporterDocDate ?? null,
            vehicleNo: data.partB?.vehicleNo
              ? normaliseVehicleNumber(data.partB.vehicleNo)
              : null,
            vehicleType: data.vehicleType,

            distanceKm: data.distanceKm,
            /** 🔴 `prepared`, never `active`. Nothing moves on this yet. */
            status: "prepared",
            notes: data.notes ?? null,
            createdBy: ctx.user.id,
            updatedBy: ctx.user.id,
          })
          .returning({ id: ewayBills.id });

        if (!row) throw new Error("The e-way bill could not be created.");

        await tx.insert(ewayBillItems).values(
          lines.map((l) => ({
            tenantId: ctx.tenant.id,
            ewayBillId: row.id,
            lineNo: l.lineNo,
            productName: l.description.slice(0, 255),
            description: l.description,
            hsnSacCode: undefined,
            hsnCode: l.hsnSacCode ?? "0000",
            quantity: String(l.quantity),
            uqc: (l.uom ?? "NOS").toUpperCase().slice(0, 10),
            taxableValueMinor: toBigIntAmount(l.taxableValueMinor),
            /** ⚠️ CGST and SGST are half the line rate each, never the whole. */
            cgstRateBps: invoice.isInterState ? 0 : Math.floor((l.taxRateBps ?? 0) / 2),
            sgstRateBps: invoice.isInterState ? 0 : Math.ceil((l.taxRateBps ?? 0) / 2),
            igstRateBps: invoice.isInterState ? (l.taxRateBps ?? 0) : 0,
            cessRateBps: l.cessRateBps ?? 0,
            isExempt: (l.taxRateBps ?? 0) === 0 && (l.cessRateBps ?? 0) === 0,
          })),
        );

        if (data.partB) {
          await tx.insert(ewayBillVehicles).values({
            tenantId: ctx.tenant.id,
            ewayBillId: row.id,
            legNo: 1,
            transportMode: data.partB.transportMode,
            vehicleNo: data.partB.vehicleNo
              ? normaliseVehicleNumber(data.partB.vehicleNo)
              : null,
            transporterDocNo: data.partB.transporterDocNo ?? null,
            transporterDocDate: data.partB.transporterDocDate ?? null,
            fromPlace: data.partB.fromPlace ?? data.fromPlace ?? null,
            fromStateCode: data.partB.fromStateCode ?? fromState,
            reasonCode: data.partB.reasonCode ?? "first_leg",
            reasonNote: data.partB.reasonNote ?? null,
            createdBy: ctx.user.id,
          });
        }

        await writeAudit(ctx, {
          action: "create",
          resourceType: "eway_bill",
          resourceId: row.id,
          newValue: {
            documentNo: invoice.invoiceNumber,
            consignmentValueMinor: serializeAmount(valued.consignmentMinor),
            distanceKm: data.distanceKm,
            voluntary: data.voluntary,
          },
          severity: "warning",
        });

        return {
          id: row.id,
          consignmentValueMinor: serializeAmount(valued.consignmentMinor),
          validityDays,
          required: requirement.required,
          requirementReason: requirement.reason,
        };
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/gst/eway");
    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "prepareEwayBill");
  }
}

/* ================================================================== */
/* ② RECORD WHAT THE PORTAL GAVE BACK                                  */
/* ================================================================== */

const recordSchema = z.object({
  ewayBillId: z.string().uuid(),
  /** The 12-digit number the portal returns. */
  ewbNo: z.string().trim().regex(/^\d{12}$/, "An e-way bill number is twelve digits."),
  generatedAt: z.string().datetime({ offset: true }),
});

/**
 * ⭐⭐ THE MOMENT A PREPARED BILL BECOMES A REAL ONE.
 *
 * 🔴 VALIDITY IS COMPUTED HERE, NOT COPIED FROM THE PORTAL. If our
 *    figure and the portal's disagree, that is worth knowing — a screen
 *    that echoes back whatever was typed can never tell you that the
 *    distance on the bill was wrong.
 *
 * 🔴 AND IT IS COUNTED FROM THE FIRST PART B ENTRY. A Part A filled on
 *    Monday and a lorry loaded on Thursday is valid from Thursday. Using
 *    the generation instant instead shortens every validity by the
 *    loading delay, and the error surfaces as an expired bill two states
 *    away.
 */
export async function recordEwayNumber(
  input: unknown,
): Promise<ActionResult<{ validFrom: string | null; validUntil: string | null }>> {
  try {
    const data = recordSchema.parse(input);
    const ctx = await requirePermission(DISPATCH);

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [bill] = await tx
          .select({
            id: ewayBills.id,
            status: ewayBills.status,
            distanceKm: ewayBills.distanceKm,
            vehicleType: ewayBills.vehicleType,
            invoiceId: ewayBills.invoiceId,
            documentDate: ewayBills.documentDate,
          })
          .from(ewayBills)
          .where(
            and(
              eq(ewayBills.tenantId, ctx.tenant.id),
              eq(ewayBills.id, data.ewayBillId),
            ),
          )
          .limit(1);

        if (!bill) throw new Error("That e-way bill does not exist.");
        if (bill.status !== "prepared") {
          throw new Error(
            `This e-way bill is already ${bill.status}. Recording a second portal number against it would leave two consignments believing they are covered by one bill.`,
          );
        }

        const [firstLeg] = await tx
          .select({ enteredAt: ewayBillVehicles.enteredAt })
          .from(ewayBillVehicles)
          .where(
            and(
              eq(ewayBillVehicles.tenantId, ctx.tenant.id),
              eq(ewayBillVehicles.ewayBillId, bill.id),
              eq(ewayBillVehicles.legNo, 1),
            ),
          )
          .limit(1);

        const generatedAt = new Date(data.generatedAt);

        /**
         * ⚠️ NO PART B YET MEANS NO VALIDITY YET, AND THAT IS CORRECT.
         * A Part A filed in advance is a lawful state — the clock starts
         * when the conveyance is entered. The screen says so loudly,
         * because a bill with a number and no vehicle looks covered and
         * is not.
         */
        const partBAt = firstLeg?.enteredAt ?? null;
        const validFrom = partBAt ? new Date(partBAt) : null;
        const validUntil = validFrom
          ? ewayValidUntil({
              partBEnteredAt: validFrom,
              distanceKm: bill.distanceKm,
              vehicleType: bill.vehicleType as EwayVehicleType,
            })
          : null;

        await tx
          .update(ewayBills)
          .set({
            ewbNo: data.ewbNo,
            generatedAt,
            validFrom,
            validUntil,
            /**
             * 🔴 `active` ONLY WITH A VALIDITY. The CHECK constraint in
             * 0054 refuses the other combination anyway — this is the
             * code agreeing with the database rather than relying on it.
             */
            status: validUntil ? "active" : "prepared",
            updatedAt: new Date(),
            updatedBy: ctx.user.id,
          })
          .where(
            and(eq(ewayBills.tenantId, ctx.tenant.id), eq(ewayBills.id, bill.id)),
          );

        /**
         * ⭐ WRITTEN BACK ONTO THE INVOICE, because that is where the
         * print template and the GSTR-1 export look for it.
         */
        if (bill.invoiceId) {
          await tx
            .update(salesInvoices)
            .set({
              ewayBillNo: data.ewbNo,
              ewayBillDate: generatedAt.toISOString().slice(0, 10),
              updatedBy: ctx.user.id,
            })
            .where(
              and(
                eq(salesInvoices.tenantId, ctx.tenant.id),
                eq(salesInvoices.id, bill.invoiceId),
              ),
            );
        }

        await writeAudit(ctx, {
          action: "update",
          resourceType: "eway_bill",
          resourceId: bill.id,
          newValue: { ewbNo: data.ewbNo, validUntil: validUntil?.toISOString() ?? null },
          severity: "warning",
        });

        return {
          validFrom: validFrom?.toISOString() ?? null,
          validUntil: validUntil?.toISOString() ?? null,
        };
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/gst/eway");
    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "recordEwayNumber");
  }
}

/* ================================================================== */
/* ③ PART B — EVERY LEG, NEVER AN OVERWRITE                            */
/* ================================================================== */

const legSchema = z.object({ ewayBillId: z.string().uuid() }).and(partBSchema);

/**
 * ⭐⭐ ADD A CONVEYANCE. Rule 138(5) — transshipment.
 *
 * 🔴 IT INSERTS A LEG. IT NEVER UPDATES THE PREVIOUS ONE. Goods that
 *    went Mumbai → Nagpur on one lorry and Nagpur → Raipur on another
 *    have two legs, and overwriting the first destroys the only evidence
 *    that the first was lawful. An officer's question is "where has this
 *    been", and one mutable column cannot answer it.
 *
 * ⚠️ `eway_bills.vehicle_no` IS UPDATED TOO — as a cache of the latest
 * leg, for the list screen. The record is the leg table.
 */
export async function addEwayLeg(
  input: unknown,
): Promise<ActionResult<{ legNo: number; validUntil: string | null }>> {
  try {
    const data = legSchema.parse(input);
    const ctx = await requirePermission(DISPATCH);
    assertPartB(data);

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [bill] = await tx
          .select({
            id: ewayBills.id,
            status: ewayBills.status,
            distanceKm: ewayBills.distanceKm,
            vehicleType: ewayBills.vehicleType,
            ewbNo: ewayBills.ewbNo,
            validFrom: ewayBills.validFrom,
          })
          .from(ewayBills)
          .where(
            and(eq(ewayBills.tenantId, ctx.tenant.id), eq(ewayBills.id, data.ewayBillId)),
          )
          .limit(1);

        if (!bill) throw new Error("That e-way bill does not exist.");
        if (bill.status === "cancelled") {
          throw new Error("This e-way bill was cancelled. Nothing may move on it.");
        }

        const [last] = await tx
          .select({ legNo: ewayBillVehicles.legNo })
          .from(ewayBillVehicles)
          .where(
            and(
              eq(ewayBillVehicles.tenantId, ctx.tenant.id),
              eq(ewayBillVehicles.ewayBillId, bill.id),
            ),
          )
          .orderBy(desc(ewayBillVehicles.legNo))
          .limit(1);

        const legNo = (last?.legNo ?? 0) + 1;
        const enteredAt = new Date();

        await tx.insert(ewayBillVehicles).values({
          tenantId: ctx.tenant.id,
          ewayBillId: bill.id,
          legNo,
          transportMode: data.transportMode,
          vehicleNo: data.vehicleNo ? normaliseVehicleNumber(data.vehicleNo) : null,
          transporterDocNo: data.transporterDocNo ?? null,
          transporterDocDate: data.transporterDocDate ?? null,
          fromPlace: data.fromPlace ?? null,
          fromStateCode: data.fromStateCode ?? null,
          enteredAt,
          reasonCode: data.reasonCode ?? (legNo === 1 ? "first_leg" : "transshipment"),
          reasonNote: data.reasonNote ?? null,
          createdBy: ctx.user.id,
        });

        /**
         * 🔴 THE CLOCK STARTS ON LEG ONE AND NEVER RESTARTS.
         *
         * ⚠️ A transshipment does NOT buy more validity. Recomputing
         * `valid_until` from leg 2 would silently extend every bill by
         * changing lorries — which is the exact abuse the extension
         * window and the 360-day ceiling exist to prevent, achieved
         * without either of them noticing.
         */
        const isFirstLeg = legNo === 1;
        const validFrom = bill.validFrom ? new Date(bill.validFrom) : enteredAt;
        const validUntil =
          isFirstLeg && bill.ewbNo
            ? ewayValidUntil({
                partBEnteredAt: enteredAt,
                distanceKm: bill.distanceKm,
                vehicleType: bill.vehicleType as EwayVehicleType,
              })
            : null;

        await tx
          .update(ewayBills)
          .set({
            transportMode: data.transportMode,
            vehicleNo: data.vehicleNo ? normaliseVehicleNumber(data.vehicleNo) : null,
            transporterDocNo: data.transporterDocNo ?? null,
            transporterDocDate: data.transporterDocDate ?? null,
            ...(isFirstLeg && bill.ewbNo
              ? { validFrom: enteredAt, validUntil, status: "active" as const }
              : {}),
            updatedAt: new Date(),
            updatedBy: ctx.user.id,
          })
          .where(and(eq(ewayBills.tenantId, ctx.tenant.id), eq(ewayBills.id, bill.id)));

        await writeAudit(ctx, {
          action: "update",
          resourceType: "eway_bill",
          resourceId: bill.id,
          newValue: { legNo, vehicleNo: data.vehicleNo ?? null },
          severity: "warning",
        });

        return {
          legNo,
          validUntil: (validUntil ?? (isFirstLeg ? null : validFrom))
            ? (validUntil?.toISOString() ?? null)
            : null,
        };
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/gst/eway");
    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "addEwayLeg");
  }
}

/* ================================================================== */
/* ④ EXTEND                                                            */
/* ================================================================== */

const extendSchema = z.object({
  ewayBillId: z.string().uuid(),
  /** ⚠️ The distance STILL TO RUN, not the original distance. */
  remainingKm: z.number().int().min(0).max(EWAY_MAX_DISTANCE_KM),
  reason: z.string().trim().min(3, "Say why — the portal asks for it too.").max(500),
});

/**
 * ⭐ EXTEND, INSIDE THE 8-HOUR BAND AND NOWHERE ELSE.
 *
 * ⚠️ THE NEW VALIDITY IS COMPUTED FROM THE REMAINING DISTANCE, NOT THE
 * ORIGINAL. A lorry that has broken down 80 km short does not need
 * another 1,200 km of validity, and declaring one is a declaration that
 * does not match the journey.
 *
 * 🔴 `generatedAt` IS NEVER TOUCHED. The 360-day ceiling runs from
 *    original generation; moving it forward on each extension would let
 *    a bill live for ever, one extension at a time.
 */
export async function extendEwayValidity(
  input: unknown,
): Promise<ActionResult<{ validUntil: string; extensionCount: number }>> {
  try {
    const data = extendSchema.parse(input);
    const ctx = await requirePermission(DISPATCH);
    const now = new Date();

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [bill] = await tx
          .select({
            id: ewayBills.id,
            status: ewayBills.status,
            validUntil: ewayBills.validUntil,
            generatedAt: ewayBills.generatedAt,
            vehicleType: ewayBills.vehicleType,
            extensionCount: ewayBills.extensionCount,
          })
          .from(ewayBills)
          .where(
            and(eq(ewayBills.tenantId, ctx.tenant.id), eq(ewayBills.id, data.ewayBillId)),
          )
          .limit(1);

        if (!bill) throw new Error("That e-way bill does not exist.");
        if (bill.status !== "active" || !bill.validUntil || !bill.generatedAt) {
          throw new Error(
            "Only a live e-way bill can be extended. This one has no validity to extend.",
          );
        }

        const verdict = canExtendEway({
          validUntil: new Date(bill.validUntil),
          originalGeneratedAt: new Date(bill.generatedAt),
          now,
        });
        if (!verdict.allowed) throw new Error(verdict.reason);

        const validUntil = ewayValidUntil({
          partBEnteredAt: now,
          distanceKm: data.remainingKm,
          vehicleType: bill.vehicleType as EwayVehicleType,
        });

        await tx
          .update(ewayBills)
          .set({
            validUntil,
            distanceKm: data.remainingKm,
            extensionCount: bill.extensionCount + 1,
            lastExtendedAt: now,
            notes: data.reason,
            updatedAt: now,
            updatedBy: ctx.user.id,
          })
          .where(and(eq(ewayBills.tenantId, ctx.tenant.id), eq(ewayBills.id, bill.id)));

        await writeAudit(ctx, {
          action: "update",
          resourceType: "eway_bill",
          resourceId: bill.id,
          newValue: {
            validUntil: validUntil.toISOString(),
            remainingKm: data.remainingKm,
            reason: data.reason,
          },
          severity: "warning",
        });

        return {
          validUntil: validUntil.toISOString(),
          extensionCount: bill.extensionCount + 1,
        };
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/gst/eway");
    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "extendEwayValidity");
  }
}

/* ================================================================== */
/* ⑤ CANCEL                                                            */
/* ================================================================== */

const cancelSchema = z.object({
  ewayBillId: z.string().uuid(),
  reason: z.string().trim().min(3, "A cancellation carries a reason.").max(500),
  /** ⚠️ Rule 138(9) proviso — verified in transit means never cancellable. */
  verifiedInTransit: z.boolean().default(false),
});

/**
 * ⭐ CANCEL — within 24 hours, and never after verification in transit.
 *
 * 🔴 IT DOES NOT DELETE. A cancelled e-way bill is a fact about a
 *    movement that was declared and did not happen. Deleting it removes
 *    the only record that the declaration was made, and the portal will
 *    still have it.
 */
export async function cancelEwayBill(
  input: unknown,
): Promise<ActionResult<{ cancelled: true }>> {
  try {
    const data = cancelSchema.parse(input);
    const ctx = await requirePermission(CANCEL);
    const now = new Date();

    await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [bill] = await tx
          .select({
            id: ewayBills.id,
            status: ewayBills.status,
            generatedAt: ewayBills.generatedAt,
            invoiceId: ewayBills.invoiceId,
          })
          .from(ewayBills)
          .where(
            and(eq(ewayBills.tenantId, ctx.tenant.id), eq(ewayBills.id, data.ewayBillId)),
          )
          .limit(1);

        if (!bill) throw new Error("That e-way bill does not exist.");
        if (bill.status === "cancelled") {
          throw new Error("This e-way bill is already cancelled.");
        }

        const verdict = canCancelEway({
          generatedAt: bill.generatedAt ? new Date(bill.generatedAt) : null,
          now,
          verifiedInTransit: data.verifiedInTransit,
        });
        if (!verdict.allowed) throw new Error(verdict.reason);

        await tx
          .update(ewayBills)
          .set({
            status: "cancelled",
            cancelledAt: now,
            cancelledBy: ctx.user.id,
            cancelReason: data.reason,
            updatedAt: now,
            updatedBy: ctx.user.id,
          })
          .where(and(eq(ewayBills.tenantId, ctx.tenant.id), eq(ewayBills.id, bill.id)));

        /**
         * ⚠️ AND THE NUMBER COMES OFF THE INVOICE. An invoice still
         * quoting a cancelled e-way bill prints a number that the portal
         * says does not cover anything.
         */
        if (bill.invoiceId) {
          await tx
            .update(salesInvoices)
            .set({ ewayBillNo: null, ewayBillDate: null, updatedBy: ctx.user.id })
            .where(
              and(
                eq(salesInvoices.tenantId, ctx.tenant.id),
                eq(salesInvoices.id, bill.invoiceId),
              ),
            );
        }

        await writeAudit(ctx, {
          action: "update",
          resourceType: "eway_bill",
          resourceId: bill.id,
          newValue: { cancelled: true, reason: data.reason },
          severity: "critical",
        });
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/gst/eway");
    return { ok: true, data: { cancelled: true } };
  } catch (err) {
    return toSalesActionError(err, "cancelEwayBill");
  }
}

/* ================================================================== */
/* ⑥ READS                                                             */
/* ================================================================== */

export type EwayListRow = {
  id: string;
  documentNo: string;
  documentDate: string;
  ewbNo: string | null;
  status: string;
  consignmentValueMinor: string;
  distanceKm: number;
  vehicleNo: string | null;
  vehicleType: string;
  fromPincode: string;
  toPincode: string;
  fromStateCode: string;
  toStateCode: string;
  validFrom: string | null;
  validUntil: string | null;
  generatedAt: string | null;
  extensionCount: number;
};

export async function getEwayBills(): Promise<
  ActionResult<{
    rows: EwayListRow[];
    /** Bills whose validity is inside the extension window or already past it. */
    atRisk: number;
    /** Prepared and never generated — the most dangerous state. */
    ungenerated: number;
  }>
> {
  try {
    const ctx = await requirePermission(READ);

    const rows = await withTenant(ctx.tenant.id, async (tx) =>
      tx
        .select({
          id: ewayBills.id,
          documentNo: ewayBills.documentNo,
          documentDate: ewayBills.documentDate,
          ewbNo: ewayBills.ewbNo,
          status: ewayBills.status,
          consignmentValueMinor: ewayBills.consignmentValueMinor,
          distanceKm: ewayBills.distanceKm,
          vehicleNo: ewayBills.vehicleNo,
          vehicleType: ewayBills.vehicleType,
          fromPincode: ewayBills.fromPincode,
          toPincode: ewayBills.toPincode,
          fromStateCode: ewayBills.fromStateCode,
          toStateCode: ewayBills.toStateCode,
          validFrom: ewayBills.validFrom,
          validUntil: ewayBills.validUntil,
          generatedAt: ewayBills.generatedAt,
          extensionCount: ewayBills.extensionCount,
        })
        .from(ewayBills)
        .where(eq(ewayBills.tenantId, ctx.tenant.id))
        .orderBy(desc(ewayBills.documentDate), desc(ewayBills.createdAt))
        .limit(500),
    );

    const now = Date.now();
    const mapped: EwayListRow[] = rows.map((r) => ({
      id: r.id,
      documentNo: r.documentNo,
      documentDate: String(r.documentDate),
      ewbNo: r.ewbNo,
      status: r.status,
      consignmentValueMinor: serializeAmount(toBigIntAmount(r.consignmentValueMinor)),
      distanceKm: r.distanceKm,
      vehicleNo: r.vehicleNo,
      vehicleType: r.vehicleType,
      fromPincode: r.fromPincode,
      toPincode: r.toPincode,
      fromStateCode: r.fromStateCode,
      toStateCode: r.toStateCode,
      validFrom: r.validFrom ? new Date(r.validFrom).toISOString() : null,
      validUntil: r.validUntil ? new Date(r.validUntil).toISOString() : null,
      generatedAt: r.generatedAt ? new Date(r.generatedAt).toISOString() : null,
      extensionCount: r.extensionCount,
    }));

    /** ⚠️ Computed from the timestamp, never read from a stored flag. */
    const atRisk = mapped.filter(
      (r) =>
        r.status === "active" &&
        r.validUntil !== null &&
        new Date(r.validUntil).getTime() - now <= 8 * 3_600_000,
    ).length;

    return {
      ok: true,
      data: {
        rows: mapped,
        atRisk,
        ungenerated: mapped.filter((r) => r.status === "prepared").length,
      },
    };
  } catch (err) {
    return toSalesActionError(err, "getEwayBills");
  }
}

export async function getEwayBillDetail(id: string): Promise<
  ActionResult<{
    bill: EwayListRow & {
      documentType: string;
      subSupplyType: string;
      transactionType: string;
      transportMode: string | null;
      transporterName: string | null;
      transporterGstin: string | null;
      supplierGstin: string | null;
      recipientGstin: string | null;
      recipientLegalName: string | null;
      taxableValueMinor: string;
      taxValueMinor: string;
      exemptValueMinor: string;
      cancelReason: string | null;
      notes: string | null;
    };
    legs: {
      legNo: number;
      transportMode: string;
      vehicleNo: string | null;
      transporterDocNo: string | null;
      enteredAt: string;
      fromPlace: string | null;
      reasonCode: string | null;
      reasonNote: string | null;
    }[];
    items: {
      lineNo: number;
      productName: string;
      hsnCode: string;
      quantity: string;
      uqc: string;
      taxableValueMinor: string;
      isExempt: boolean;
    }[];
    payload: string;
  }>
> {
  try {
    const ctx = await requirePermission(READ);

    const data = await withTenant(ctx.tenant.id, async (tx) => {
      const [b] = await tx
        .select()
        .from(ewayBills)
        .where(and(eq(ewayBills.tenantId, ctx.tenant.id), eq(ewayBills.id, id)))
        .limit(1);
      if (!b) throw new Error("That e-way bill does not exist.");

      const legs = await tx
        .select()
        .from(ewayBillVehicles)
        .where(
          and(
            eq(ewayBillVehicles.tenantId, ctx.tenant.id),
            eq(ewayBillVehicles.ewayBillId, id),
          ),
        )
        .orderBy(ewayBillVehicles.legNo);

      const items = await tx
        .select()
        .from(ewayBillItems)
        .where(
          and(
            eq(ewayBillItems.tenantId, ctx.tenant.id),
            eq(ewayBillItems.ewayBillId, id),
          ),
        )
        .orderBy(ewayBillItems.lineNo);

      /**
       * ⭐ THE NIC JSON IS BUILT ON READ, NOT STORED. Storing it would
       * let the payload and the bill drift apart the moment a vehicle is
       * updated — and the payload is the thing somebody uploads.
       */
      const payload = buildEwayPayload({
        supplyType: b.supplyType === "inward" ? "inward" : "outward",
        subSupplyType: b.subSupplyType as EwaySubSupplyType,
        documentType: b.documentType as EwayDocumentType,
        documentNo: b.documentNo,
        documentDate: String(b.documentDate),
        transactionType: b.transactionType as EwayTransactionType,

        fromGstin: b.supplierGstin,
        fromLegalName: b.supplierLegalName,
        fromPlace: b.fromPlace,
        fromPincode: b.fromPincode,
        fromStateCode: b.fromStateCode,

        toGstin: b.recipientGstin,
        toLegalName: b.recipientLegalName,
        toPlace: b.toPlace,
        toPincode: b.toPincode,
        toStateCode: b.toStateCode,

        taxableValueMinor: toBigIntAmount(b.taxableValueMinor),
        cgstMinor: 0n,
        sgstMinor: 0n,
        igstMinor: toBigIntAmount(b.taxValueMinor),
        cessMinor: 0n,
        totalValueMinor: toBigIntAmount(b.consignmentValueMinor),

        transporterGstin: b.transporterGstin,
        transporterName: b.transporterName,
        transporterDocNo: b.transporterDocNo,
        transporterDocDate: b.transporterDocDate ? String(b.transporterDocDate) : null,
        transportMode: (b.transportMode as EwayTransportMode | null) ?? null,
        distanceKm: b.distanceKm,
        vehicleNo: b.vehicleNo,
        vehicleType: b.vehicleType as EwayVehicleType,

        items: items.map((i) => ({
          productName: i.productName,
          description: i.description,
          hsnCode: i.hsnCode,
          quantity: String(i.quantity),
          uqc: i.uqc,
          taxableValueMinor: toBigIntAmount(i.taxableValueMinor),
          cgstRateBps: i.cgstRateBps,
          sgstRateBps: i.sgstRateBps,
          igstRateBps: i.igstRateBps,
          cessRateBps: i.cessRateBps,
        })),
      });

      return {
        bill: {
          id: b.id,
          documentNo: b.documentNo,
          documentDate: String(b.documentDate),
          documentType: b.documentType,
          subSupplyType: b.subSupplyType,
          transactionType: b.transactionType,
          ewbNo: b.ewbNo,
          status: b.status,
          consignmentValueMinor: serializeAmount(toBigIntAmount(b.consignmentValueMinor)),
          taxableValueMinor: serializeAmount(toBigIntAmount(b.taxableValueMinor)),
          taxValueMinor: serializeAmount(toBigIntAmount(b.taxValueMinor)),
          exemptValueMinor: serializeAmount(toBigIntAmount(b.exemptValueMinor)),
          distanceKm: b.distanceKm,
          vehicleNo: b.vehicleNo,
          vehicleType: b.vehicleType,
          transportMode: b.transportMode,
          transporterName: b.transporterName,
          transporterGstin: b.transporterGstin,
          supplierGstin: b.supplierGstin,
          recipientGstin: b.recipientGstin,
          recipientLegalName: b.recipientLegalName,
          fromPincode: b.fromPincode,
          toPincode: b.toPincode,
          fromStateCode: b.fromStateCode,
          toStateCode: b.toStateCode,
          validFrom: b.validFrom ? new Date(b.validFrom).toISOString() : null,
          validUntil: b.validUntil ? new Date(b.validUntil).toISOString() : null,
          generatedAt: b.generatedAt ? new Date(b.generatedAt).toISOString() : null,
          extensionCount: b.extensionCount,
          cancelReason: b.cancelReason,
          notes: b.notes,
        },
        legs: legs.map((l) => ({
          legNo: l.legNo,
          transportMode: l.transportMode,
          vehicleNo: l.vehicleNo,
          transporterDocNo: l.transporterDocNo,
          enteredAt: new Date(l.enteredAt).toISOString(),
          fromPlace: l.fromPlace,
          reasonCode: l.reasonCode,
          reasonNote: l.reasonNote,
        })),
        items: items.map((i) => ({
          lineNo: i.lineNo,
          productName: i.productName,
          hsnCode: i.hsnCode,
          quantity: String(i.quantity),
          uqc: i.uqc,
          taxableValueMinor: serializeAmount(toBigIntAmount(i.taxableValueMinor)),
          isExempt: i.isExempt,
        })),
        payload: JSON.stringify([payload], null, 2),
      };
    });

    return { ok: true, data };
  } catch (err) {
    return toSalesActionError(err, "getEwayBillDetail");
  }
}

/**
 * Issued goods invoices that have no live e-way bill — the list somebody
 * works through before a dispatch round.
 *
 * ⚠️ IT DOES NOT FILTER BY VALUE. Whether Rule 138 requires one depends
 * on the consignment value computed per Explanation 2, and that is
 * computed on the prepare screen where the lines are read. Filtering
 * here on the invoice TOTAL would hide exactly the mixed invoices whose
 * threshold is hardest to judge.
 */
export async function getEwayCandidates(): Promise<
  ActionResult<{
    rows: {
      invoiceId: string;
      invoiceNumber: string;
      invoiceDate: string;
      customerLegalName: string | null;
      totalMinor: string;
      isInterState: boolean;
      placeOfSupplyCode: string | null;
      supplierStateCode: string | null;
    }[];
  }>
> {
  try {
    const ctx = await requirePermission(READ);

    const rows = await withTenant(ctx.tenant.id, async (tx) =>
      tx
        .select({
          invoiceId: salesInvoices.id,
          invoiceNumber: salesInvoices.invoiceNumber,
          invoiceDate: salesInvoices.invoiceDate,
          customerLegalName: salesInvoices.customerLegalName,
          totalMinor: salesInvoices.totalMinor,
          isInterState: salesInvoices.isInterState,
          placeOfSupplyCode: salesInvoices.placeOfSupplyCode,
          supplierStateCode: salesInvoices.supplierStateCode,
        })
        .from(salesInvoices)
        .where(
          and(
            eq(salesInvoices.tenantId, ctx.tenant.id),
            eq(salesInvoices.supplyType, "goods"),
            sql`${salesInvoices.status} NOT IN ('draft', 'cancelled')`,
            sql`NOT EXISTS (
              SELECT 1 FROM eway_bills e
              WHERE e.tenant_id = ${ctx.tenant.id}
                AND e.invoice_id = ${salesInvoices.id}
                AND e.status IN ('prepared', 'active')
            )`,
          ),
        )
        .orderBy(desc(salesInvoices.invoiceDate))
        .limit(200),
    );

    return {
      ok: true,
      data: {
        rows: rows.map((r) => ({
          invoiceId: r.invoiceId,
          invoiceNumber: r.invoiceNumber,
          invoiceDate: String(r.invoiceDate),
          customerLegalName: r.customerLegalName,
          totalMinor: serializeAmount(toBigIntAmount(r.totalMinor)),
          isInterState: r.isInterState,
          placeOfSupplyCode: r.placeOfSupplyCode,
          supplierStateCode: r.supplierStateCode,
        })),
      },
    };
  } catch (err) {
    return toSalesActionError(err, "getEwayCandidates");
  }
}

/**
 * ⚠️ EXPOSED SO THE SCREEN CAN SAY WHETHER PART B IS EVEN REQUIRED
 * BEFORE SOMEBODY GOES LOOKING FOR A LORRY NUMBER.
 */
export async function checkPartBRequirement(input: {
  distanceKm: number;
  isInterState: boolean;
  isTransporterLeg: boolean;
}): Promise<ActionResult<{ required: boolean; reason: string }>> {
  try {
    await requirePermission(READ);
    const v = partBRequired(input);
    return { ok: true, data: { required: v.allowed, reason: v.reason } };
  } catch (err) {
    return toSalesActionError(err, "checkPartBRequirement");
  }
}
