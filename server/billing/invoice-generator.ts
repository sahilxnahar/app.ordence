import "server-only";

/**
 * Ordence — Invoice Generation
 * Version: v0.16.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE DOCUMENT THIS PRODUCES IS A LEGAL INSTRUMENT
 * ══════════════════════════════════════════════════════════════════════
 * A GST invoice is not a receipt or a summary. Your customer files it to
 * claim input tax credit; if it is wrong, their claim is rejected weeks
 * later and they come back to you for a corrected copy — which, under the
 * rules, means a credit note and a fresh invoice, not an edit.
 *
 * So this module is written to make a wrong invoice hard to produce, and
 * an issued one impossible to alter:
 *
 *   • Every amount is BigInt minor units. No float touches money.
 *   • The number comes from a database SEQUENCE, so two concurrent runs
 *     cannot collide.
 *   • The tax identity is COPIED onto the invoice at issue. A customer
 *     who later changes their registered address must not retroactively
 *     change a document they already filed.
 *   • Lines are attached while the invoice is a DRAFT, then it is issued.
 *     The database refuses lines on an issued invoice, so this ordering
 *     is not a convention — it is enforced. (Learned in Phase 11, when a
 *     test fixture built it the other way round and was refused.)
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ══════════════════════════════════════════════════════════════════════
 * It does not decide WHEN to invoice. That is driven by subscription
 * period boundaries and by `reconcile.ts` reacting to provider events.
 * Mixing "should we bill?" with "how do we render the bill?" is how a
 * retry ends up issuing a second invoice for the same period.
 *
 * Idempotency is therefore the caller's concern AND ours: the unique
 * index on `(subscription_id, period_start, period_end)` — added in this
 * phase — makes a duplicate physically impossible regardless.
 */

import { and, eq, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import {
  invoices,
  invoiceLines,
  subscriptions,
  plans,
  tenants,
  type Invoice,
} from "@/db/schema";
import {
  computeGst,
  computeProration,
  formatMoney,
  toBigIntAmount,
  type GstBreakdown,
} from "@/lib/billing/money";
import {
  SAAS_GST_RATE_BPS,
  SAAS_SAC_CODE,
  DEFAULT_SUPPLIER_STATE_CODE,
} from "@/lib/validators/billing";
import { recordSystemAudit } from "@/server/billing/audit-billing";
// Pure line composition lives in `lib/` so it can be tested without a
// database — see the header of that file for why this split keeps
// recurring.
import {
  buildSubscriptionLines,
  type InvoiceLineDraft,
} from "@/lib/billing/invoice-lines";

export { buildSubscriptionLines, buildProrationLines } from "@/lib/billing/invoice-lines";
export type { InvoiceLineDraft } from "@/lib/billing/invoice-lines";

/* ------------------------------------------------------------------ */
/* INPUT                                                               */
/* ------------------------------------------------------------------ */


export type GenerateInvoiceInput = {
  tenantId: string;
  subscriptionId: string | null;
  lines: InvoiceLineDraft[];
  periodStart: Date | null;
  periodEnd: Date | null;
  /** Days until payment is due. 0 means due immediately. */
  dueInDays?: number;
  notes?: string;
  /**
   * Leave as `draft` to build an invoice for review. `open` issues it,
   * after which the amounts and lines are immutable.
   */
  issue?: boolean;
};

export type GeneratedInvoice = {
  id: string;
  invoiceNumber: string;
  totalMinor: string;
  totalDisplay: string;
  status: string;
};

/* ------------------------------------------------------------------ */
/* THE SUPPLIER (us)                                                   */
/* ------------------------------------------------------------------ */

/**
 * Our own GST identity. Read at call time rather than module load, so a
 * missing value cannot fail the build — and so a correction to the state
 * code takes effect on the next invoice rather than the next deploy.
 */
function supplierStateCode(): string {
  const configured = process.env.PLATFORM_GST_STATE_CODE?.trim();
  return configured && /^[0-9]{2}$/.test(configured)
    ? configured
    : DEFAULT_SUPPLIER_STATE_CODE;
}

function invoicePrefix(): string {
  const configured = process.env.PLATFORM_INVOICE_PREFIX?.trim();
  // Restricted to safe characters: the prefix ends up in a filename and
  // in a URL, and a slash or a space there is a support ticket.
  return configured && /^[A-Za-z0-9-]{1,10}$/.test(configured) ? configured : "AH";
}

/* ------------------------------------------------------------------ */
/* GENERATION                                                          */
/* ------------------------------------------------------------------ */

export class InvoiceGenerationError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "InvoiceGenerationError";
  }
}

/**
 * Build an invoice from a set of lines.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE ORDER OF OPERATIONS IS FORCED BY THE DATABASE
 * ══════════════════════════════════════════════════════════════════════
 *   1. Read the customer's tax identity and copy it.
 *   2. Compute every line, then the tax, in exact integer arithmetic.
 *   3. INSERT the invoice as a DRAFT.
 *   4. INSERT the lines — only possible while it is a draft.
 *   5. UPDATE it to `open`, which seals it.
 *
 * Creating it as `open` and attaching lines afterwards raises SQLSTATE
 * 42501. That is not a quirk to work around; it is the guarantee that a
 * document a customer holds cannot have its contents rewritten.
 *
 * All five steps share ONE transaction. A half-built invoice — a header
 * with no lines, or a sealed invoice missing a line — is a document you
 * would have to explain.
 */
export async function generateInvoice(
  input: GenerateInvoiceInput,
): Promise<GeneratedInvoice> {
  if (input.lines.length === 0) {
    throw new InvoiceGenerationError(
      "An invoice needs at least one line.",
      "no_lines",
    );
  }

  return withTenant(input.tenantId, async (tx) => {
    /* ---- 1. The customer's tax identity, copied ----------------- */

    const [tenant] = await tx
      .select({
        legalName: tenants.legalName,
        name: tenants.name,
        settings: tenants.settings,
      })
      .from(tenants)
      .where(eq(tenants.id, input.tenantId))
      .limit(1);

    if (!tenant) {
      throw new InvoiceGenerationError("Workspace not found.", "no_tenant");
    }

    const profile = tenant.settings?.billingProfile;
    const placeOfSupply = profile?.placeOfSupplyCode ?? null;
    const customerGstin = profile?.gstin ?? null;

    /* ---- 2. Arithmetic, in exact integers ----------------------- */

    let subtotalMinor = 0n;
    const computedLines = input.lines.map((line) => {
      const quantity = Math.max(1, Math.trunc(line.quantity));
      const amountMinor = BigInt(quantity) * line.unitAmountMinor;
      subtotalMinor += amountMinor;
      return { ...line, quantity, amountMinor };
    });

    /**
     * ⚠️ A negative subtotal is refused rather than silently issued.
     *
     * It can arise legitimately in arithmetic — a downgrade whose
     * proration credit exceeds the new charge — but the correct document
     * for "we owe you money" is a CREDIT NOTE, not an invoice with a
     * negative total. Issuing the latter produces a filing a customer's
     * accountant cannot process.
     */
    if (subtotalMinor < 0n) {
      throw new InvoiceGenerationError(
        "This period nets to a credit rather than a charge. " +
          "A credit note is required, not an invoice.",
        "negative_total",
      );
    }

    const gst: GstBreakdown = computeGst(
      subtotalMinor,
      SAAS_GST_RATE_BPS,
      supplierStateCode(),
      placeOfSupply,
    );

    const totalMinor =
      subtotalMinor + gst.cgstMinor + gst.sgstMinor + gst.igstMinor;

    /* ---- 3. The number, from the sequence ----------------------- */
    //
    // `next_invoice_number()` wraps `nextval`, which is atomic and is NOT
    // rolled back — so two concurrent generations cannot receive the same
    // string even if one of their transactions later aborts. Gaps are
    // accepted deliberately: a gap you can explain beats a duplicate,
    // which is a compliance failure.
    const numberRow = await tx.execute(
      sql`SELECT next_invoice_number(${invoicePrefix()}) AS invoice_number`,
    );
    const invoiceNumber =
      (numberRow.rows?.[0] as { invoice_number?: string } | undefined)
        ?.invoice_number;

    if (!invoiceNumber) {
      throw new InvoiceGenerationError(
        "Could not allocate an invoice number.",
        "no_number",
      );
    }

    /* ---- 4. Insert as a DRAFT ----------------------------------- */

    const now = new Date();
    const dueAt = new Date(
      now.getTime() + Math.max(0, input.dueInDays ?? 0) * 86_400_000,
    );

    const [created] = await tx
      .insert(invoices)
      .values({
        tenantId: input.tenantId,
        subscriptionId: input.subscriptionId,
        invoiceNumber,
        status: "draft",
        currency: "INR",
        subtotalMinor,
        discountMinor: 0n,
        cgstMinor: gst.cgstMinor,
        sgstMinor: gst.sgstMinor,
        igstMinor: gst.igstMinor,
        totalMinor,
        amountPaidMinor: 0n,
        // Copied, not joined. A customer changing their registered
        // address next year must not alter a document already filed.
        customerGstin,
        placeOfSupplyCode: placeOfSupply,
        customerLegalName: tenant.legalName ?? tenant.name,
        customerAddress: {
          line1: profile?.addressLine1,
          line2: profile?.addressLine2 ?? undefined,
          city: profile?.city,
          state: profile?.state,
          postalCode: profile?.postalCode,
          country: profile?.country ?? "IN",
        },
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        issuedAt: input.issue === false ? null : now,
        dueAt,
        provider: "manual",
        notes: input.notes ?? null,
      })
      .returning({ id: invoices.id });

    if (!created) {
      throw new InvoiceGenerationError("Could not create the invoice.", "insert_failed");
    }

    /* ---- 5. Lines, while it is still a draft -------------------- */

    await tx.insert(invoiceLines).values(
      computedLines.map((line, index) => ({
        invoiceId: created.id,
        tenantId: input.tenantId,
        description: line.description,
        sacCode: line.sacCode ?? SAAS_SAC_CODE,
        quantity: line.quantity,
        unitAmountMinor: line.unitAmountMinor,
        amountMinor: line.amountMinor,
        taxRateBps: SAAS_GST_RATE_BPS,
        periodStart: line.periodStart ?? input.periodStart,
        periodEnd: line.periodEnd ?? input.periodEnd,
        lineType: line.lineType,
        sortOrder: (index + 1) * 10,
      })),
    );

    /* ---- 6. Seal it -------------------------------------------- */

    const finalStatus = input.issue === false ? "draft" : "open";

    if (finalStatus !== "draft") {
      await tx
        .update(invoices)
        .set({ status: "open", updatedAt: now })
        .where(eq(invoices.id, created.id));
    }

    await recordSystemAudit(tx, {
      tenantId: input.tenantId,
      action: "create",
      resourceType: "invoice",
      resourceId: created.id,
      severity: "notice",
      reason: `Invoice ${invoiceNumber} ${finalStatus === "draft" ? "drafted" : "issued"}`,
      metadata: {
        invoiceNumber,
        subtotalMinor: subtotalMinor.toString(),
        totalMinor: totalMinor.toString(),
        isInterState: gst.isInterState,
        lineCount: computedLines.length,
      },
    });

    return {
      id: created.id,
      invoiceNumber,
      totalMinor: totalMinor.toString(),
      totalDisplay: formatMoney(totalMinor, "INR"),
      status: finalStatus,
    };
  });
}

/* ------------------------------------------------------------------ */
/* PERIOD INVOICING                                                    */
/* ------------------------------------------------------------------ */

/**
 * Issue the invoice for a subscription's current period.
 *
 * ⚠️ IDEMPOTENT BY DATABASE CONSTRAINT, not by a check here. A unique
 * index on `(subscription_id, period_start, period_end)` means a retry —
 * a redelivered webhook, a cron that ran twice, an operator clicking
 * again — raises 23505 rather than issuing a second invoice for a period
 * the customer has already been billed for.
 *
 * The pre-check below exists only to return a friendly answer. It races;
 * the index does not.
 */
export async function invoiceCurrentPeriod(
  tenantId: string,
  subscriptionId: string,
): Promise<GeneratedInvoice | { alreadyIssued: true; invoiceNumber: string }> {
  const context = await withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select({
        subscription: subscriptions,
        plan: plans,
      })
      .from(subscriptions)
      .innerJoin(plans, eq(plans.id, subscriptions.planId))
      .where(
        and(
          eq(subscriptions.id, subscriptionId),
          eq(subscriptions.tenantId, tenantId),
        ),
      )
      .limit(1);

    if (!row) return null;

    const [existing] = await tx
      .select({ invoiceNumber: invoices.invoiceNumber })
      .from(invoices)
      .where(
        and(
          eq(invoices.subscriptionId, subscriptionId),
          eq(invoices.periodStart, row.subscription.currentPeriodStart),
          eq(invoices.periodEnd, row.subscription.currentPeriodEnd),
          sql`${invoices.status} <> 'void'`,
        ),
      )
      .limit(1);

    return { row, existing: existing ?? null };
  });

  if (!context) {
    throw new InvoiceGenerationError("Subscription not found.", "no_subscription");
  }

  if (context.existing) {
    return { alreadyIssued: true, invoiceNumber: context.existing.invoiceNumber };
  }

  const { subscription, plan } = context.row;

  const lines = buildSubscriptionLines({
    planName: plan.name,
    periodStart: subscription.currentPeriodStart,
    periodEnd: subscription.currentPeriodEnd,
    unitAmountMinor: toBigIntAmount(subscription.unitAmountMinor),
    perSeatAmountMinor: toBigIntAmount(subscription.perSeatAmountMinor),
    seatsPurchased: subscription.seatsPurchased,
    includedSeats: plan.includedSeats,
  });

  return generateInvoice({
    tenantId,
    subscriptionId,
    lines,
    periodStart: subscription.currentPeriodStart,
    periodEnd: subscription.currentPeriodEnd,
    // Seven days is the common commercial term in India and gives a
    // customer paying by transfer time to act before dunning starts.
    dueInDays: 7,
    issue: true,
  });
}

/** Read one invoice with its lines, for rendering. */
export async function getInvoiceWithLines(
  tenantId: string,
  invoiceId: string,
): Promise<{ invoice: Invoice; lines: (typeof invoiceLines.$inferSelect)[] } | null> {
  return withTenant(tenantId, async (tx) => {
    const [invoice] = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, invoiceId), eq(invoices.tenantId, tenantId)))
      .limit(1);

    if (!invoice) return null;

    const lines = await tx
      .select()
      .from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, invoiceId))
      .orderBy(invoiceLines.sortOrder);

    return { invoice, lines };
  });
}
