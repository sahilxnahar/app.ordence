"use server";

/**
 * Ordence — Purchase & ITC Actions
 * Version: v0.33.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION. Schemas live in
 * `lib/validators/purchases.ts`, rules in `lib/purchases/`. A
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
 * `SQL-FILES/0023_phase33_purchases.sql`, because this file is one of
 * four write paths — an import of a year of historical purchase bills, a
 * support fix at a psql prompt and a future API route are the others —
 * and a rule enforced in one of four places is a rule the other three
 * will bypass. The import is where the volume is, and the import is
 * exactly where the Section 17(5) answer gets copied from yesterday.
 *
 * ⚠️ MONEY CROSSES THE BOUNDARY AS A STRING. `JSON.stringify` throws on a
 * bigint, so every amount returned here goes through `serializeAmount`.
 * The alternative — patching `BigInt.prototype.toJSON` globally — changes
 * behaviour for every unrelated caller including libraries.
 */

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withTenant } from "@/db";
import { postPurchaseInvoice } from "@/server/accounting/post-sales";
import {
  vendors,
  purchaseInvoices,
  purchaseInvoiceLines,
  itcRegister,
  vendorLedgerEntries,
} from "@/db/schema/purchases";
import { requirePermission, writeAudit } from "@/server/audit";
import {
  guardPurchaseWrite,
  purchaseFail,
  toPurchaseActionError,
} from "@/server/purchases/guards";
import {
  upsertVendorSchema,
  blockVendorSchema,
  recordPurchaseInvoiceSchema,
  determineItcSchema,
  setInvoiceStatusSchema,
  recordItcMovementSchema,
  runRule42Schema,
  addVendorLedgerEntrySchema,
  buildItcPeriodSchema,
  vendorAgeingQuerySchema,
} from "@/lib/validators/purchases";
import {
  listVendors,
  findVendor,
  listPurchaseInvoices,
  findPurchaseInvoice,
  findDuplicateBill,
  listItcMovements,
  toRegisterMovement,
  loadPeriodLinesForRule42,
  loadVendorLedger,
  vendorBalances,
} from "@/server/purchases/registry";
import { pricePurchase } from "@/server/purchases/engine";
import { determineItcEligibility } from "@/lib/purchases/itc";
import {
  apportionRule42ByHead,
  bucketRule42,
} from "@/lib/purchases/apportionment";
import { summariseItcRegister } from "@/lib/purchases/register";
import {
  ageVendorLedger,
  assessMsmeExposure,
  runningBalance,
} from "@/lib/purchases/vendor-ledger";
import { parseMoney, serializeAmount } from "@/lib/billing/money";
import type { ActionResult } from "@/lib/validators/crm";

/* ------------------------------------------------------------------ */
/* SERIALISABLE SHAPES                                                 */
/* ------------------------------------------------------------------ */

export type VendorRow = {
  id: string;
  code: string;
  legalName: string;
  tradeName: string | null;
  vendorType: string;
  gstPartyId: string | null;
  panNumber: string | null;
  msmeRegistered: boolean;
  udyamNumber: string | null;
  msmeCategory: string | null;
  paymentTermsDays: number;
  tdsApplicable: boolean;
  defaultTdsSection: string | null;
  isActive: boolean;
};

export type PurchaseInvoiceRow = {
  id: string;
  vendorId: string;
  invoiceNumber: string;
  invoiceDate: string;
  supplierGstin: string | null;
  placeOfSupplyCode: string | null;
  taxableValueMinor: string;
  cgstMinor: string;
  sgstMinor: string;
  igstMinor: string;
  cessMinor: string;
  totalMinor: string;
  itcEligibleTaxMinor: string;
  itcBlockedTaxMinor: string;
  isReverseCharge: boolean;
  isTdsDeductible: boolean;
  taxPeriod: string | null;
  status: string;
};

/* ------------------------------------------------------------------ */
/* VENDORS                                                             */
/* ------------------------------------------------------------------ */

export async function getVendors(
  includeInactive?: boolean,
): Promise<ActionResult<{ rows: VendorRow[] }>> {
  try {
    // ⚠️ READ: permission only. An entitlement gate here would refuse to
    // RENDER the page rather than refusing the button on it.
    const ctx = await requirePermission("purchases:read");
    const rows = await listVendors(ctx.tenant.id, {
      includeInactive: includeInactive === true,
    });
    return { ok: true, data: { rows: rows.map(toVendorRow) } };
  } catch (err) {
    return toPurchaseActionError(err, "getVendors");
  }
}

export async function upsertVendor(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await guardPurchaseWrite({
      operation: "purchases:manage_vendors",
      feature: "purchases.invoices",
      permission: "purchases:manage_vendors",
    });

    const data = upsertVendorSchema.parse(input);

    const id = await withTenant(ctx.tenant.id, async (tx) => {
      const values = {
        tenantId: ctx.tenant.id,
        code: data.code,
        legalName: data.legalName,
        tradeName: data.tradeName ?? null,
        vendorType: data.vendorType,
        gstPartyId: data.gstPartyId ?? null,
        companyId: data.companyId ?? null,
        panNumber: data.panNumber ?? null,
        msmeRegistered: data.msmeRegistered,
        udyamNumber: data.udyamNumber ?? null,
        msmeCategory: data.msmeCategory ?? null,
        msmeRegisteredOn: data.msmeRegisteredOn ?? null,
        paymentTermsDays: data.paymentTermsDays,
        tdsApplicable: data.tdsApplicable,
        defaultTdsSection: data.defaultTdsSection ?? null,
        address: data.address ?? {},
        bankDetails: data.bankDetails ?? {},
        notes: data.notes ?? null,
      };

      if (data.id) {
        const [row] = await tx
          .update(vendors)
          .set(values)
          .where(and(eq(vendors.tenantId, ctx.tenant.id), eq(vendors.id, data.id)))
          .returning({ id: vendors.id });
        return row?.id ?? null;
      }

      const [row] = await tx
        .insert(vendors)
        .values({ ...values, createdBy: ctx.user.id })
        .returning({ id: vendors.id });
      return row?.id ?? null;
    });

    if (!id) return purchaseFail("That vendor no longer exists.");

    await writeAudit(ctx, {
      action: data.id ? "update" : "create",
      resourceType: "vendor",
      resourceId: id,
      newValue: { code: data.code, msmeRegistered: data.msmeRegistered },
    });

    revalidatePath("/purchases/vendors");
    return { ok: true, data: { id } };
  } catch (err) {
    return toPurchaseActionError(err, "upsertVendor");
  }
}

/**
 * ⚠️ BLOCK, NEVER DELETE. A vendor with a filed return behind them cannot
 * be removed — the credit claimed on their bills is evidence, and the
 * RESTRICT foreign keys refuse it anyway. Blocking stops new bills and
 * keeps the history, which is the thing anybody actually wants.
 */
export async function setVendorActive(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await guardPurchaseWrite({
      operation: "purchases:manage_vendors",
      feature: "purchases.invoices",
      permission: "purchases:manage_vendors",
    });

    const data = blockVendorSchema.parse(input);

    await withTenant(ctx.tenant.id, async (tx) =>
      tx
        .update(vendors)
        .set({ isActive: data.isActive, blockedReason: data.blockedReason ?? null })
        .where(and(eq(vendors.tenantId, ctx.tenant.id), eq(vendors.id, data.id))),
    );

    await writeAudit(ctx, {
      action: "update",
      resourceType: "vendor",
      resourceId: data.id,
      newValue: { isActive: data.isActive },
      reason: data.blockedReason ?? undefined,
    });

    revalidatePath("/purchases/vendors");
    return { ok: true, data: { id: data.id } };
  } catch (err) {
    return toPurchaseActionError(err, "setVendorActive");
  }
}

/* ------------------------------------------------------------------ */
/* ⭐ THE ITC DETERMINATION, ON ITS OWN                                */
/* ------------------------------------------------------------------ */

/**
 * ⭐ "May we claim this?" — answered before anything is written.
 *
 * ⚠️ THIS EXISTS SO THE FORM CAN ASK BEFORE THE BILL IS SAVED. The
 * determination has to be visible while the person still has the
 * contractor's invoice in their hand and can walk over and ask which
 * tower the cement went to. Afterwards it is a database row nobody
 * revisits, and Section 17(5)(d) is the most expensive thing in this
 * product to get wrong quietly.
 *
 * ⚠️ NO ENTITLEMENT GATE AND NO WRITE PERMISSION — `purchases:read` only.
 * Telling somebody their credit is blocked is not a paid feature and is
 * not a privileged act; refusing to tell them is how the wrong number
 * ends up in a return.
 */
export async function determineItc(input: unknown): Promise<
  ActionResult<{
    eligibility: string;
    blockReason: string | null;
    statutoryRef: string;
    rule42Attribution: string;
    explanation: string;
    remedy: string | null;
  }>
> {
  try {
    await requirePermission("purchases:read");
    const data = determineItcSchema.parse(input);
    const verdict = determineItcEligibility(data);

    return {
      ok: true,
      data: {
        eligibility: verdict.eligibility,
        blockReason: verdict.blockReason,
        statutoryRef: verdict.statutoryRef,
        rule42Attribution: verdict.rule42Attribution,
        explanation: verdict.explanation,
        remedy: verdict.remedy ?? null,
      },
    };
  } catch (err) {
    return toPurchaseActionError(err, "determineItc");
  }
}

/* ------------------------------------------------------------------ */
/* PURCHASE INVOICES                                                   */
/* ------------------------------------------------------------------ */

export async function getPurchaseInvoices(
  filter?: { vendorId?: string; taxPeriod?: string; projectId?: string },
): Promise<ActionResult<{ rows: PurchaseInvoiceRow[] }>> {
  try {
    const ctx = await requirePermission("purchases:read");
    const rows = await listPurchaseInvoices(ctx.tenant.id, filter);
    return { ok: true, data: { rows: rows.map(toInvoiceRow) } };
  } catch (err) {
    return toPurchaseActionError(err, "getPurchaseInvoices");
  }
}

export async function getPurchaseInvoice(invoiceId: string): Promise<
  ActionResult<{
    invoice: PurchaseInvoiceRow;
    lines: {
      id: string;
      lineNumber: number;
      description: string;
      hsnSacCode: string | null;
      taxableValueMinor: string;
      rateBps: number;
      cgstMinor: string;
      sgstMinor: string;
      igstMinor: string;
      cessMinor: string;
      itcPurpose: string;
      itcEligibility: string;
      itcBlockReason: string | null;
      itcStatutoryRef: string | null;
      itcEligibleTaxMinor: string;
      itcBlockedTaxMinor: string;
      itcNote: string | null;
    }[];
  }>
> {
  try {
    const ctx = await requirePermission("purchases:read");
    const found = await findPurchaseInvoice(ctx.tenant.id, invoiceId);
    if (!found) return purchaseFail("That purchase invoice no longer exists.");

    return {
      ok: true,
      data: {
        invoice: toInvoiceRow(found.invoice),
        lines: found.lines.map((line) => ({
          id: line.id,
          lineNumber: line.lineNumber,
          description: line.description,
          hsnSacCode: line.hsnSacCode,
          taxableValueMinor: serializeAmount(line.taxableValueMinor),
          rateBps: line.rateBps,
          cgstMinor: serializeAmount(line.cgstMinor),
          sgstMinor: serializeAmount(line.sgstMinor),
          igstMinor: serializeAmount(line.igstMinor),
          cessMinor: serializeAmount(line.cessMinor),
          itcPurpose: line.itcPurpose,
          itcEligibility: line.itcEligibility,
          itcBlockReason: line.itcBlockReason,
          itcStatutoryRef: line.itcStatutoryRef,
          itcEligibleTaxMinor: serializeAmount(line.itcEligibleTaxMinor),
          itcBlockedTaxMinor: serializeAmount(line.itcBlockedTaxMinor),
          itcNote: line.itcNote,
        })),
      },
    };
  } catch (err) {
    return toPurchaseActionError(err, "getPurchaseInvoice");
  }
}

/**
 * ⭐ Record a vendor bill, with its per-line ITC determination.
 *
 * ⚠️ THE HEADER AND ITS LINES ARE WRITTEN IN ONE TRANSACTION, AND THAT IS
 * NOT TIDINESS. The reconciliation trigger in SQL §6 is DEFERRABLE
 * INITIALLY DEFERRED and fires at COMMIT; a header committed on its own
 * would be judged with no lines and refused. `withTenant` runs the
 * callback in a transaction, which is exactly the shape the trigger
 * expects.
 */
export async function recordPurchaseInvoice(
  input: unknown,
): Promise<
  ActionResult<{ id: string; warnings: string[]; blockedTaxMinor: string }>
> {
  try {
    const ctx = await guardPurchaseWrite({
      operation: "purchases:record_invoice",
      feature: "purchases.invoices",
      permission: "purchases:record_invoice",
    });

    const data = recordPurchaseInvoiceSchema.parse(input);

    /**
     * ⭐ THE DUPLICATE CHECK, BEFORE THE WORK.
     *
     * ⚠️ THE UNIQUE INDEX IS THE GUARANTEE AND THIS IS THE COURTESY. The
     * index refuses the second entry whatever route it arrives by. This
     * lets the person be told which document already exists, rather than
     * discovering it after typing twelve lines.
     */
    const duplicate = await findDuplicateBill(ctx.tenant.id, {
      vendorId: data.vendorId,
      invoiceNumber: data.invoiceNumber,
      invoiceDate: data.invoiceDate,
    });
    if (duplicate) {
      return purchaseFail(
        `This vendor's invoice ${duplicate.invoiceNumber} dated ${duplicate.invoiceDate} ` +
          `is already recorded for this financial year. Entering a bill twice claims ` +
          `the input tax credit twice and pays the vendor twice — open the existing ` +
          `entry rather than adding another.`,
      );
    }

    const priced = await pricePurchase(ctx.tenant.id, data);
    if (!priced.ok) return purchaseFail(priced.error);

    const p = priced.priced;

    const id = await withTenant(ctx.tenant.id, async (tx) => {
      const [header] = await tx
        .insert(purchaseInvoices)
        .values({
          tenantId: ctx.tenant.id,
          vendorId: data.vendorId,
          gstPartyId: data.gstPartyId ?? null,
          recipientRegistrationId: p.registration?.id ?? null,
          recipientGstin: p.registration?.gstin ?? null,
          recipientStateCode: p.registration?.stateCode ?? null,
          invoiceNumber: data.invoiceNumber,
          invoiceDate: data.invoiceDate,
          receivedDate: data.receivedDate ?? null,
          goodsReceivedDate: data.goodsReceivedDate ?? null,
          isBillOfSupply: data.isBillOfSupply,
          supplyType: data.supplyType,
          placeOfSupplyCode: p.placeOfSupplyCode,
          propertyStateCode: data.propertyStateCode ?? null,
          isInterState: p.isInterState,
          projectId: data.projectId ?? null,
          subtotalMinor: p.subtotalMinor,
          discountMinor: p.discountMinor,
          taxableValueMinor: p.taxableValueMinor,
          cgstMinor: p.cgstMinor,
          sgstMinor: p.sgstMinor,
          igstMinor: p.igstMinor,
          cessMinor: p.cessMinor,
          roundOffMinor: p.roundOffMinor,
          totalMinor: p.totalMinor,
          isReverseCharge: data.isReverseCharge,
          rcmTaxMinor: p.rcmTaxMinor,
          rcmSection: data.rcmSection ?? null,
          itcEligibleTaxMinor: p.itcEligibleTaxMinor,
          itcBlockedTaxMinor: p.itcBlockedTaxMinor,
          taxPeriod: p.taxPeriod,
          isTdsDeductible: data.isTdsDeductible,
          tdsSection: data.tdsSection ?? null,
          tdsBaseMinor: p.tdsBaseMinor,
          status: "recorded",
          // ⭐ Opts this document into the reconciliation trigger. Having
          // declared that the Phase 33 engine produced it, it must add up.
          gstComputed: true,
          notes: data.notes ?? null,
          createdBy: ctx.user.id,
        })
        .returning({ id: purchaseInvoices.id });

      if (!header) throw new Error("Purchase invoice header was not written.");

      await tx.insert(purchaseInvoiceLines).values(
        p.lines.map((line) => ({
          tenantId: ctx.tenant.id,
          purchaseInvoiceId: header.id,
          lineNumber: line.lineNumber,
          description: line.description,
          hsnSacId: line.hsnSacId,
          hsnSacCode: line.hsnSacCode,
          gstRateId: line.gstRateId,
          amountMinor: line.amountMinor,
          discountMinor: line.discountMinor,
          taxableValueMinor: line.taxableValueMinor,
          rateBps: line.rateBps,
          cessRateBps: line.cessRateBps,
          cgstMinor: line.heads.cgstMinor,
          sgstMinor: line.heads.sgstMinor,
          igstMinor: line.heads.igstMinor,
          cessMinor: line.heads.cessMinor,
          isReverseCharge: line.isReverseCharge,
          expenditureNature: data.lines[line.lineNumber - 1]?.expenditureNature ?? "goods",
          itcPurpose: data.lines[line.lineNumber - 1]?.itcPurpose ?? "taxable_supply",
          projectId: line.projectId,
          itcEligibility: line.determination.eligibility,
          itcBlockReason: line.determination.blockReason,
          itcStatutoryRef: line.determination.statutoryRef,
          itcEligibleTaxMinor: line.itcEligibleTaxMinor,
          itcBlockedTaxMinor: line.itcBlockedTaxMinor,
          rule42Attribution: line.determination.rule42Attribution,
          isCapitalGoods: line.isCapitalGoods,
          itcNote: line.determination.explanation,
        })),
      );

      /**
       * ⭐ THE VENDOR LEDGER LEG, IN THE SAME TRANSACTION.
       *
       * ⚠️ THE AMOUNT CREDITED EXCLUDES REVERSE-CHARGE TAX. Under Section
       * 9(3)/9(4) the supplier does not charge it and we pay it to the
       * Government in cash — crediting it to the vendor would pay them
       * tax they never billed, and the payment run would send it.
       */
      await tx.insert(vendorLedgerEntries).values({
        tenantId: ctx.tenant.id,
        vendorId: data.vendorId,
        entryDate: data.invoiceDate,
        entryType: "purchase_invoice",
        purchaseInvoiceId: header.id,
        referenceNumber: data.invoiceNumber,
        description: `Purchase invoice ${data.invoiceNumber}`,
        creditMinor: p.totalMinor,
        debitMinor: 0n,
      });

      /**
       * ⭐ THE BOOKS ARE TOLD — v1.0.0-rc.
       *
       * ⚠️ SAME TRANSACTION AS THE BILL AND ITS LINES. The posting reads
       * the lines that were just inserted, so it must see them — and a
       * bill recorded without its journal is the defect this phase
       * exists to end.
       *
       * ⚠️ IT NEVER BLOCKS RECORDING. An unmapped chart of accounts puts
       * the bill in the backlog at `/accounting/posting`, where posting
       * it later is safe because it is idempotent.
       */
      const postedLines = await tx
        .select({
          taxableValueMinor: purchaseInvoiceLines.taxableValueMinor,
          cgstMinor: purchaseInvoiceLines.cgstMinor,
          sgstMinor: purchaseInvoiceLines.sgstMinor,
          igstMinor: purchaseInvoiceLines.igstMinor,
          cessMinor: purchaseInvoiceLines.cessMinor,
          itcEligibility: purchaseInvoiceLines.itcEligibility,
        })
        .from(purchaseInvoiceLines)
        .where(
          and(
            eq(purchaseInvoiceLines.tenantId, ctx.tenant.id),
            eq(purchaseInvoiceLines.purchaseInvoiceId, header.id),
          ),
        );

      await postPurchaseInvoice(tx, {
        tenantId: ctx.tenant.id,
        userId: ctx.user.id,
        invoiceId: header.id,
        invoiceNumber: data.invoiceNumber,
        invoiceDate: data.invoiceDate,
        vendorId: data.vendorId,
        vendorName: null,
        lines: postedLines.map((l) => ({
          taxableValueMinor: l.taxableValueMinor,
          cgstMinor: l.cgstMinor,
          sgstMinor: l.sgstMinor,
          igstMinor: l.igstMinor,
          cessMinor: l.cessMinor,
          /**
           * ⚠️ ONLY `blocked` IS COST. Rule 42 common credit enters the
           * ledger in full and is reversed separately by
           * `runRule42ForPeriod` — treating it as cost here would double
           * the reversal.
           */
          itcBlocked: l.itcEligibility === "blocked",
        })),
        roundOffMinor: p.roundOffMinor,
        totalMinor: p.totalMinor,
        rcmTaxMinor: p.rcmTaxMinor,
        rcmSection: data.rcmSection ?? null,
      });

      return header.id;
    });

    /**
     * ⚠️ THE BLOCKED FIGURE GOES IN THE AUDIT TRAIL, NOT JUST THE
     * ELIGIBLE ONE. "Why did we not claim ₹18 lakh on this bill" is the
     * question at an assessment, and the answer has to be attributable to
     * a person and a moment. Recording only what was claimed leaves the
     * far more valuable half of the determination unattributed.
     */
    await writeAudit(ctx, {
      action: "create",
      resourceType: "purchase_invoice",
      resourceId: id,
      newValue: {
        vendorId: data.vendorId,
        invoiceNumber: data.invoiceNumber,
        itcEligibleMinor: serializeAmount(p.itcEligibleTaxMinor),
        itcBlockedMinor: serializeAmount(p.itcBlockedTaxMinor),
      },
      metadata: {
        blockedClauses: p.lines
          .filter((line) => line.determination.eligibility === "blocked")
          .map((line) => ({
            lineNumber: line.lineNumber,
            statutoryRef: line.determination.statutoryRef,
            reason: line.determination.blockReason,
          })),
      },
    });

    // ⭐ Warnings, not refusals. A rate that disagrees with our master may
    // be the supplier's error or our master lagging a notification, and
    // refusing the bill would make the product unusable in the week after
    // every rate change.
    const warnings = p.lines
      .filter((line) => line.rateMismatch !== null)
      .map((line) => `Line ${line.lineNumber}: ${line.rateMismatch}`);

    for (const line of p.lines) {
      if (line.determination.eligibility === "blocked") {
        warnings.push(
          `Line ${line.lineNumber} — credit BLOCKED under ${line.determination.statutoryRef}. ` +
            line.determination.explanation,
        );
      }
    }

    revalidatePath("/purchases/invoices");
    return {
      ok: true,
      data: {
        id,
        warnings,
        blockedTaxMinor: serializeAmount(p.itcBlockedTaxMinor),
      },
    };
  } catch (err) {
    return toPurchaseActionError(err, "recordPurchaseInvoice");
  }
}

export async function setPurchaseInvoiceStatus(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await guardPurchaseWrite({
      operation: "purchases:record_invoice",
      feature: "purchases.invoices",
      permission: "purchases:record_invoice",
    });

    const data = setInvoiceStatusSchema.parse(input);

    await withTenant(ctx.tenant.id, async (tx) =>
      tx
        .update(purchaseInvoices)
        .set({ status: data.status })
        .where(
          and(
            eq(purchaseInvoices.tenantId, ctx.tenant.id),
            eq(purchaseInvoices.id, data.id),
          ),
        ),
    );

    await writeAudit(ctx, {
      action: "update",
      resourceType: "purchase_invoice",
      resourceId: data.id,
      newValue: { status: data.status },
      reason: data.reason ?? undefined,
    });

    revalidatePath("/purchases/invoices");
    return { ok: true, data: { id: data.id } };
  } catch (err) {
    return toPurchaseActionError(err, "setPurchaseInvoiceStatus");
  }
}

/* ------------------------------------------------------------------ */
/* ⭐ THE ITC REGISTER                                                 */
/* ------------------------------------------------------------------ */

export async function getItcRegister(filter?: {
  taxPeriod?: string;
  registrationId?: string;
}): Promise<
  ActionResult<{
    periods: {
      taxPeriod: string;
      claimedTotalMinor: string;
      blockedTotalMinor: string;
      deferredTotalMinor: string;
      reversedTotalMinor: string;
      netTotalMinor: string;
      claimedCgstMinor: string;
      claimedSgstMinor: string;
      claimedIgstMinor: string;
      claimedCessMinor: string;
      reversedCgstMinor: string;
      reversedSgstMinor: string;
      reversedIgstMinor: string;
      reversedCessMinor: string;
    }[];
  }>
> {
  try {
    const ctx = await requirePermission("purchases:read");
    const rows = await listItcMovements(ctx.tenant.id, filter);
    const summary = summariseItcRegister(rows.map(toRegisterMovement));

    return {
      ok: true,
      data: {
        periods: summary.map((s) => ({
          taxPeriod: s.taxPeriod,
          claimedTotalMinor: serializeAmount(s.claimedTotalMinor),
          blockedTotalMinor: serializeAmount(s.blockedTotalMinor),
          deferredTotalMinor: serializeAmount(s.deferredTotalMinor),
          reversedTotalMinor: serializeAmount(s.reversedTotalMinor),
          netTotalMinor: serializeAmount(s.netTotalMinor),
          claimedCgstMinor: serializeAmount(s.claimed.cgstMinor),
          claimedSgstMinor: serializeAmount(s.claimed.sgstMinor),
          claimedIgstMinor: serializeAmount(s.claimed.igstMinor),
          claimedCessMinor: serializeAmount(s.claimed.cessMinor),
          reversedCgstMinor: serializeAmount(s.reversed.cgstMinor),
          reversedSgstMinor: serializeAmount(s.reversed.sgstMinor),
          reversedIgstMinor: serializeAmount(s.reversed.igstMinor),
          reversedCessMinor: serializeAmount(s.reversed.cessMinor),
        })),
      },
    };
  } catch (err) {
    return toPurchaseActionError(err, "getItcRegister");
  }
}

/**
 * ⭐ Post a single credit movement into the register.
 *
 * ⚠️ `claim` AND `reverse` ARE DIFFERENT PERMISSIONS AND THE CHOICE IS
 * MADE HERE, FROM THE STATUS. Merging them into one `purchases:manage_itc`
 * would mean the person who may take a credit may also take it back, and
 * the two mistakes have opposite signs — an over-claim is money in the
 * bank now, an over-reversal is money quietly given away. Both are
 * silent, and they should not be one grant.
 */
export async function recordItcMovement(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const parsed = recordItcMovementSchema.parse(input);
    const permission =
      parsed.status === "reversed" ? "purchases:reverse_itc" : "purchases:claim_itc";

    const ctx = await guardPurchaseWrite({
      operation: permission,
      feature: "purchases.itc",
      permission,
    });

    const id = await withTenant(ctx.tenant.id, async (tx) => {
      const [row] = await tx
        .insert(itcRegister)
        .values({
          tenantId: ctx.tenant.id,
          registrationId: parsed.registrationId ?? null,
          taxPeriod: parsed.taxPeriod,
          purchaseInvoiceId: parsed.purchaseInvoiceId ?? null,
          purchaseInvoiceLineId: parsed.purchaseInvoiceLineId ?? null,
          vendorId: parsed.vendorId ?? null,
          projectId: parsed.projectId ?? null,
          status: parsed.status,
          reason: parsed.reason,
          statutoryRef: parsed.statutoryRef ?? null,
          note: parsed.note ?? null,
          cgstMinor: parseMoney(parsed.cgst),
          sgstMinor: parseMoney(parsed.sgst),
          igstMinor: parseMoney(parsed.igst),
          cessMinor: parseMoney(parsed.cess),
          createdBy: ctx.user.id,
        })
        .returning({ id: itcRegister.id });
      return row?.id ?? null;
    });

    if (!id) return purchaseFail("The credit movement was not recorded.");

    await writeAudit(ctx, {
      action: "create",
      resourceType: "itc_register",
      resourceId: id,
      newValue: { status: parsed.status, taxPeriod: parsed.taxPeriod },
      metadata: { movementReason: parsed.reason, statutoryRef: parsed.statutoryRef },
      // ⚠️ `notice`, not `info`. A credit movement is money into or out
      // of a return; it belongs in the slice of the audit trail somebody
      // actually reads.
      severity: "notice",
    });

    revalidatePath("/purchases/itc");
    return { ok: true, data: { id } };
  } catch (err) {
    return toPurchaseActionError(err, "recordItcMovement");
  }
}

/**
 * ⭐ Claim every eligible line of a tax period into the register.
 *
 * ⚠️ IT INSERTS ONE ROW PER LINE, NOT ONE PER INVOICE, AND NOT A TOTAL.
 * A GSTR-2B mismatch in Phase 34 is resolved line by line, and a register
 * that recorded a single figure per period could tell you the total was
 * wrong but never which bill made it wrong.
 *
 * ⚠️ RE-RUNNABLE. The per-period unique index makes a second run a no-op
 * for lines already claimed rather than a double claim, and the
 * cumulative trigger in SQL §7 refuses one across periods. Somebody WILL
 * re-run this — a build that is dangerous to repeat is a build nobody
 * dares run at all.
 */
export async function buildItcForPeriod(
  input: unknown,
): Promise<ActionResult<{ claimed: number; skipped: number; totalMinor: string }>> {
  try {
    const ctx = await guardPurchaseWrite({
      operation: "purchases:claim_itc",
      feature: "purchases.itc",
      permission: "purchases:claim_itc",
    });

    const data = buildItcPeriodSchema.parse(input);

    const result = await withTenant(ctx.tenant.id, async (tx) => {
      const rows = await tx
        .select({
          lineId: purchaseInvoiceLines.id,
          invoiceId: purchaseInvoices.id,
          vendorId: purchaseInvoices.vendorId,
          projectId: purchaseInvoiceLines.projectId,
          registrationId: purchaseInvoices.recipientRegistrationId,
          eligibility: purchaseInvoiceLines.itcEligibility,
          cgst: purchaseInvoiceLines.cgstMinor,
          sgst: purchaseInvoiceLines.sgstMinor,
          igst: purchaseInvoiceLines.igstMinor,
          cess: purchaseInvoiceLines.cessMinor,
        })
        .from(purchaseInvoiceLines)
        .innerJoin(
          purchaseInvoices,
          and(
            eq(purchaseInvoices.id, purchaseInvoiceLines.purchaseInvoiceId),
            eq(purchaseInvoices.tenantId, purchaseInvoiceLines.tenantId),
          ),
        )
        .where(
          and(
            eq(purchaseInvoiceLines.tenantId, ctx.tenant.id),
            eq(purchaseInvoices.taxPeriod, data.taxPeriod),
            data.registrationId
              ? eq(purchaseInvoices.recipientRegistrationId, data.registrationId)
              : undefined,
          ),
        );

      const claimable = rows.filter((row) => row.eligibility !== "blocked");
      let total = 0n;
      let claimed = 0;

      for (const row of claimable) {
        const cgst = BigInt(row.cgst ?? 0);
        const sgst = BigInt(row.sgst ?? 0);
        const igst = BigInt(row.igst ?? 0);
        const cess = BigInt(row.cess ?? 0);
        if (cgst + sgst + igst + cess === 0n) continue;

        // ⚠️ ON CONFLICT DO NOTHING against the per-period unique index.
        // A re-run must be a no-op, not a duplicate and not an error.
        const inserted = await tx
          .insert(itcRegister)
          .values({
            tenantId: ctx.tenant.id,
            registrationId: row.registrationId,
            taxPeriod: data.taxPeriod,
            purchaseInvoiceId: row.invoiceId,
            purchaseInvoiceLineId: row.lineId,
            vendorId: row.vendorId,
            projectId: row.projectId,
            status: "claimed",
            reason: "invoice_claim",
            statutoryRef: "s.16(1)",
            cgstMinor: cgst,
            sgstMinor: sgst,
            igstMinor: igst,
            cessMinor: cess,
            createdBy: ctx.user.id,
          })
          .onConflictDoNothing()
          .returning({ id: itcRegister.id });

        if (inserted.length > 0) {
          claimed += 1;
          total += cgst + sgst + igst + cess;
        }
      }

      return { claimed, skipped: rows.length - claimed, totalMinor: total };
    });

    await writeAudit(ctx, {
      action: "create",
      resourceType: "itc_register",
      resourceId: data.taxPeriod,
      newValue: {
        taxPeriod: data.taxPeriod,
        claimed: result.claimed,
        totalMinor: serializeAmount(result.totalMinor),
      },
      metadata: { movementReason: "invoice_claim" },
      severity: "notice",
    });

    revalidatePath("/purchases/itc");
    return {
      ok: true,
      data: {
        claimed: result.claimed,
        skipped: result.skipped,
        totalMinor: serializeAmount(result.totalMinor),
      },
    };
  } catch (err) {
    return toPurchaseActionError(err, "buildItcForPeriod");
  }
}

/**
 * ⭐ Run Rule 42 for a period and post the reversal.
 *
 * ⚠️ THE TURNOVER FIGURES ARE SUPPLIED, NOT DERIVED. The Explanation to
 * Rule 42 pulls into "exempt turnover" the value of land sold and of
 * completed buildings sold — neither of which raises a tax invoice,
 * because a sale after the completion certificate is outside GST
 * entirely (Schedule III para 5). Deriving E and F from the invoice table
 * would silently omit the largest exempt figure a developer has,
 * understate the reversal and overstate the credit.
 */
export async function runRule42ForPeriod(input: unknown): Promise<
  ActionResult<{
    c1Minor: string;
    c3Minor: string;
    d1Minor: string;
    d2Minor: string;
    eligibleCommonMinor: string;
    totalReversalMinor: string;
    exemptRatioBps: number;
  }>
> {
  try {
    const ctx = await guardPurchaseWrite({
      operation: "purchases:reverse_itc",
      feature: "purchases.itc",
      permission: "purchases:reverse_itc",
    });

    const data = runRule42Schema.parse(input);

    const lines = await loadPeriodLinesForRule42(
      ctx.tenant.id,
      data.taxPeriod,
      data.registrationId ?? null,
    );
    const buckets = bucketRule42(lines);

    const result = apportionRule42ByHead({
      totalCredit: buckets.totalCredit,
      nonBusiness: buckets.nonBusiness,
      exempt: buckets.exempt,
      blocked: buckets.blocked,
      taxable: buckets.taxable,
      exemptTurnoverMinor: parseMoney(data.exemptTurnover),
      totalTurnoverMinor: parseMoney(data.totalTurnover),
      ...(data.deemedNonBusinessRateBps === undefined
        ? {}
        : { deemedNonBusinessRateBps: data.deemedNonBusinessRateBps }),
    });

    const reversalTotal =
      result.reversal.cgstMinor +
      result.reversal.sgstMinor +
      result.reversal.igstMinor +
      result.reversal.cessMinor;

    if (reversalTotal > 0n) {
      await withTenant(ctx.tenant.id, async (tx) => {
        await tx.insert(itcRegister).values({
          tenantId: ctx.tenant.id,
          registrationId: data.registrationId ?? null,
          taxPeriod: data.taxPeriod,
          // ⭐ No line and no invoice: Rule 42 is computed on the WHOLE
          // period's turnover, so the reversal belongs to the period.
          // `itc_register_period_level_is_reversal` permits exactly this.
          status: "reversed",
          reason: "rule_42_common_reversal",
          statutoryRef: "Rule 42(1)",
          note:
            `D1 (exempt share) and D2 (deemed 5% non-business) on common credit of ` +
            `${serializeAmount(
              result.cgst.c3 + result.sgst.c3 + result.igst.c3 + result.cess.c3,
            )} paise, at an exempt ratio of ${result.cgst.exemptRatioBps} bps.`,
          cgstMinor: result.reversal.cgstMinor,
          sgstMinor: result.reversal.sgstMinor,
          igstMinor: result.reversal.igstMinor,
          cessMinor: result.reversal.cessMinor,
          createdBy: ctx.user.id,
        });
      });
    }

    await writeAudit(ctx, {
      action: "create",
      resourceType: "itc_register",
      resourceId: data.taxPeriod,
      newValue: {
        taxPeriod: data.taxPeriod,
        reversalMinor: serializeAmount(reversalTotal),
      },
      metadata: {
        movementReason: "rule_42_common_reversal",
        exemptTurnover: data.exemptTurnover,
        totalTurnover: data.totalTurnover,
      },
      severity: "notice",
    });

    revalidatePath("/purchases/itc");

    const sum = (pick: (r: (typeof result)["cgst"]) => bigint): bigint =>
      pick(result.cgst) + pick(result.sgst) + pick(result.igst) + pick(result.cess);

    return {
      ok: true,
      data: {
        c1Minor: serializeAmount(sum((r) => r.c1)),
        c3Minor: serializeAmount(sum((r) => r.c3)),
        d1Minor: serializeAmount(sum((r) => r.d1)),
        d2Minor: serializeAmount(sum((r) => r.d2)),
        eligibleCommonMinor: serializeAmount(sum((r) => r.eligibleCommonMinor)),
        totalReversalMinor: serializeAmount(reversalTotal),
        exemptRatioBps: result.cgst.exemptRatioBps,
      },
    };
  } catch (err) {
    return toPurchaseActionError(err, "runRule42ForPeriod");
  }
}

/* ------------------------------------------------------------------ */
/* THE VENDOR LEDGER                                                   */
/* ------------------------------------------------------------------ */

export async function addVendorLedgerEntry(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await guardPurchaseWrite({
      operation: "purchases:record_invoice",
      feature: "purchases.vendor_ledger",
      permission: "purchases:record_invoice",
    });

    const data = addVendorLedgerEntrySchema.parse(input);

    const id = await withTenant(ctx.tenant.id, async (tx) => {
      const [row] = await tx
        .insert(vendorLedgerEntries)
        .values({
          tenantId: ctx.tenant.id,
          vendorId: data.vendorId,
          entryDate: data.entryDate,
          entryType: data.entryType,
          purchaseInvoiceId: data.purchaseInvoiceId ?? null,
          referenceNumber: data.referenceNumber ?? null,
          description: data.description ?? null,
          debitMinor: parseMoney(data.debit),
          creditMinor: parseMoney(data.credit),
          dueDate: data.dueDate ?? null,
          excludeFromAgeing: data.excludeFromAgeing,
          createdBy: ctx.user.id,
        })
        .returning({ id: vendorLedgerEntries.id });
      return row?.id ?? null;
    });

    if (!id) return purchaseFail("The ledger entry was not recorded.");

    await writeAudit(ctx, {
      action: "create",
      resourceType: "vendor_ledger_entry",
      resourceId: id,
      newValue: { vendorId: data.vendorId, entryType: data.entryType },
    });

    revalidatePath("/purchases/vendors");
    return { ok: true, data: { id } };
  } catch (err) {
    return toPurchaseActionError(err, "addVendorLedgerEntry");
  }
}

export async function getVendorStatement(vendorId: string): Promise<
  ActionResult<{
    rows: {
      id: string;
      entryDate: string;
      entryType: string;
      description: string | null;
      referenceNumber: string | null;
      debitMinor: string;
      creditMinor: string;
      balanceMinor: string;
    }[];
    closingBalanceMinor: string;
  }>
> {
  try {
    const ctx = await requirePermission("purchases:read");
    const entries = await loadVendorLedger(ctx.tenant.id, vendorId);
    const rows = runningBalance(entries);

    return {
      ok: true,
      data: {
        rows: rows.map((row) => ({
          id: row.id,
          entryDate: row.entryDate,
          entryType: row.entryType,
          description: row.description ?? null,
          referenceNumber: row.referenceNumber ?? null,
          debitMinor: serializeAmount(row.debitMinor),
          creditMinor: serializeAmount(row.creditMinor),
          balanceMinor: serializeAmount(row.balanceMinor),
        })),
        closingBalanceMinor: serializeAmount(
          rows.length > 0 ? (rows[rows.length - 1]?.balanceMinor ?? 0n) : 0n,
        ),
      },
    };
  } catch (err) {
    return toPurchaseActionError(err, "getVendorStatement");
  }
}

export async function getVendorAgeing(input: unknown): Promise<
  ActionResult<{
    asOf: string;
    outstandingMinor: string;
    notYetDueMinor: string;
    excludedMinor: string;
    buckets: { label: string; amountMinor: string; entryCount: number }[];
  }>
> {
  try {
    const ctx = await requirePermission("purchases:read");
    const data = vendorAgeingQuerySchema.parse(input);

    const entries = await loadVendorLedger(ctx.tenant.id, data.vendorId ?? null);
    const ageing = ageVendorLedger({ entries, asOf: data.asOf });

    return {
      ok: true,
      data: {
        asOf: ageing.asOf,
        outstandingMinor: serializeAmount(ageing.outstandingMinor),
        notYetDueMinor: serializeAmount(ageing.notYetDueMinor),
        excludedMinor: serializeAmount(ageing.excludedMinor),
        buckets: ageing.buckets.map((bucket) => ({
          label: bucket.label,
          amountMinor: serializeAmount(bucket.amountMinor),
          entryCount: bucket.entryCount,
        })),
      },
    };
  } catch (err) {
    return toPurchaseActionError(err, "getVendorAgeing");
  }
}

export async function getVendorBalances(): Promise<
  ActionResult<{ rows: { vendorId: string; legalName: string; balanceMinor: string }[] }>
> {
  try {
    const ctx = await requirePermission("purchases:read");
    const rows = await vendorBalances(ctx.tenant.id);
    return {
      ok: true,
      data: {
        rows: rows.map((row) => ({
          vendorId: row.vendorId,
          legalName: row.legalName,
          balanceMinor: serializeAmount(row.balanceMinor),
        })),
      },
    };
  } catch (err) {
    return toPurchaseActionError(err, "getVendorBalances");
  }
}

/**
 * ⭐ The Section 43B(h) exposure on one bill.
 *
 * ⚠️ IT TAKES `asOf` RATHER THAN READING THE CLOCK. The question a
 * year-end review asks is "was this bill late as at 31 March", not "is it
 * late today" — and by the time somebody asks, today is nine months
 * later and every bill would look overdue.
 */
export async function getMsmeExposure(args: {
  vendorId: string;
  acceptedOn: string;
  asOf: string;
  paidOn?: string | null;
}): Promise<
  ActionResult<{
    applies: boolean;
    effectiveTermDays: number;
    dueDate: string;
    daysOverdue: number;
    disallowanceRisk: boolean;
    message: string;
  }>
> {
  try {
    const ctx = await requirePermission("purchases:read");
    const vendor = await findVendor(ctx.tenant.id, args.vendorId);
    if (!vendor) return purchaseFail("That vendor is not in this workspace.");

    const exposure = assessMsmeExposure({
      msmeRegistered: vendor.msmeRegistered,
      msmeCategory: vendor.msmeCategory,
      paymentTermsDays: vendor.paymentTermsDays,
      acceptedOn: args.acceptedOn,
      asOf: args.asOf,
      paidOn: args.paidOn ?? null,
    });

    return { ok: true, data: exposure };
  } catch (err) {
    return toPurchaseActionError(err, "getMsmeExposure");
  }
}

/* ------------------------------------------------------------------ */
/* MAPPERS                                                             */
/* ------------------------------------------------------------------ */

function toVendorRow(row: {
  id: string;
  code: string;
  legalName: string;
  tradeName: string | null;
  vendorType: string;
  gstPartyId: string | null;
  panNumber: string | null;
  msmeRegistered: boolean;
  udyamNumber: string | null;
  msmeCategory: string | null;
  paymentTermsDays: number;
  tdsApplicable: boolean;
  defaultTdsSection: string | null;
  isActive: boolean;
}): VendorRow {
  return {
    id: row.id,
    code: row.code,
    legalName: row.legalName,
    tradeName: row.tradeName,
    vendorType: row.vendorType,
    gstPartyId: row.gstPartyId,
    panNumber: row.panNumber,
    msmeRegistered: row.msmeRegistered,
    udyamNumber: row.udyamNumber,
    msmeCategory: row.msmeCategory,
    paymentTermsDays: row.paymentTermsDays,
    tdsApplicable: row.tdsApplicable,
    defaultTdsSection: row.defaultTdsSection,
    isActive: row.isActive,
  };
}

function toInvoiceRow(row: {
  id: string;
  vendorId: string;
  invoiceNumber: string;
  invoiceDate: string;
  supplierGstin: string | null;
  placeOfSupplyCode: string | null;
  taxableValueMinor: bigint;
  cgstMinor: bigint;
  sgstMinor: bigint;
  igstMinor: bigint;
  cessMinor: bigint;
  totalMinor: bigint;
  itcEligibleTaxMinor: bigint;
  itcBlockedTaxMinor: bigint;
  isReverseCharge: boolean;
  isTdsDeductible: boolean;
  taxPeriod: string | null;
  status: string;
}): PurchaseInvoiceRow {
  return {
    id: row.id,
    vendorId: row.vendorId,
    invoiceNumber: row.invoiceNumber,
    invoiceDate: row.invoiceDate,
    supplierGstin: row.supplierGstin,
    placeOfSupplyCode: row.placeOfSupplyCode,
    taxableValueMinor: serializeAmount(row.taxableValueMinor),
    cgstMinor: serializeAmount(row.cgstMinor),
    sgstMinor: serializeAmount(row.sgstMinor),
    igstMinor: serializeAmount(row.igstMinor),
    cessMinor: serializeAmount(row.cessMinor),
    totalMinor: serializeAmount(row.totalMinor),
    itcEligibleTaxMinor: serializeAmount(row.itcEligibleTaxMinor),
    itcBlockedTaxMinor: serializeAmount(row.itcBlockedTaxMinor),
    isReverseCharge: row.isReverseCharge,
    isTdsDeductible: row.isTdsDeductible,
    taxPeriod: row.taxPeriod,
    status: row.status,
  };
}
