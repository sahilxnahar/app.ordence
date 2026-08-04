"use server";

/**
 * Ordence — Invoicing Actions
 * Version: v0.16.0-alpha
 *
 * The customer-facing half of invoicing: read your invoices, download one,
 * see what you are using.
 *
 * ⚠️ Every export is an async function. A `"use server"` file may export
 * nothing else — anything else becomes a public RPC endpoint and fails the
 * build. Schemas live in `lib/validators/billing.ts`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT IS DELIBERATELY ABSENT
 * ══════════════════════════════════════════════════════════════════════
 * There is no `createInvoice` action reachable from the UI. Issuing an
 * invoice is driven by subscription period boundaries and by verified
 * provider events, never by a button — a customer-triggerable invoice
 * endpoint is a customer-triggerable charge.
 *
 * `issueInvoiceForPeriod` exists and requires `billing:manage`, because
 * an operator sometimes genuinely must issue one by hand for an
 * enterprise customer paying offline. It is idempotent by database
 * constraint, so clicking it twice cannot bill twice.
 */

import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { invoices, invoiceLines, subscriptions } from "@/db/schema";
import { requirePermission } from "@/server/audit";
import { TenantAccessError } from "@/server/tenant-context";
import { PermissionDeniedError } from "@/lib/permissions";
import { AccessRestrictedError } from "@/server/billing/access";
import {
  formatMoney,
  toBigIntAmount,
  serializeAmount,
} from "@/lib/billing/money";
import {
  invoiceCurrentPeriod,
  getInvoiceWithLines,
  InvoiceGenerationError,
} from "@/server/billing/invoice-generator";
import { renderInvoiceHtml } from "@/lib/billing/invoice-render";
import type { ActionResult } from "@/lib/validators/crm";

function fail(error: string): ActionResult<never> {
  return { ok: false, error };
}

function toActionError(err: unknown, scope: string): ActionResult<never> {
  if (err instanceof TenantAccessError) return fail(err.message);
  if (err instanceof PermissionDeniedError) return fail(err.message);
  // A read-only workspace must still be able to see and download its
  // invoices — that is the whole point of the exemption list — so this
  // should not fire here. Mapped anyway rather than surfacing as
  // "something went wrong".
  if (err instanceof AccessRestrictedError) return fail(err.message);
  if (err instanceof InvoiceGenerationError) return fail(err.message);
  if (err instanceof z.ZodError) return fail("Please check the form.");

  // 23505 on the period index: the retry case. Not an error the operator
  // needs to see as a failure — the period is already billed.
  if (err && typeof err === "object" && "code" in err && err.code === "23505") {
    return fail(
      "That period has already been invoiced. Refresh to see the existing invoice.",
    );
  }

  console.error(`[invoicing:${scope}]`, err);
  return fail("Something went wrong. Please try again.");
}

/* ------------------------------------------------------------------ */
/* VIEWS                                                               */
/* ------------------------------------------------------------------ */

export type InvoiceLineView = {
  description: string;
  sacCode: string;
  quantity: number;
  unitAmountDisplay: string;
  amountDisplay: string;
  amountMinor: string;
  lineType: string;
};

export type InvoiceDetailView = {
  id: string;
  invoiceNumber: string;
  status: string;
  currency: string;
  subtotalDisplay: string;
  cgstDisplay: string;
  sgstDisplay: string;
  igstDisplay: string;
  totalDisplay: string;
  amountPaidDisplay: string;
  outstandingDisplay: string;
  isInterState: boolean;
  customerLegalName: string | null;
  customerGstin: string | null;
  placeOfSupplyCode: string | null;
  issuedAt: string | null;
  dueAt: string | null;
  paidAt: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  lines: InvoiceLineView[];
};

/* ------------------------------------------------------------------ */
/* READS                                                               */
/* ------------------------------------------------------------------ */

/**
 * One invoice, fully itemised.
 *
 * Requires `billing:read`, not `billing:manage` — the person who needs to
 * see an invoice is very often not the person allowed to change the plan.
 * Requiring the stronger permission would mean a finance assistant cannot
 * retrieve a document they are being asked to pay.
 */
export async function getInvoiceDetail(
  invoiceId: string,
): Promise<ActionResult<InvoiceDetailView>> {
  try {
    const ctx = await requirePermission("billing:read");

    if (!/^[0-9a-f-]{36}$/i.test(invoiceId)) {
      return fail("That invoice could not be found.");
    }

    const result = await getInvoiceWithLines(ctx.tenant.id, invoiceId);
    if (!result) return fail("That invoice could not be found.");

    const { invoice, lines } = result;
    const currency = invoice.currency;

    const total = toBigIntAmount(invoice.totalMinor);
    const paid = toBigIntAmount(invoice.amountPaidMinor);

    return {
      ok: true,
      data: {
        id: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        status: invoice.status,
        currency,
        subtotalDisplay: formatMoney(toBigIntAmount(invoice.subtotalMinor), currency),
        cgstDisplay: formatMoney(toBigIntAmount(invoice.cgstMinor), currency),
        sgstDisplay: formatMoney(toBigIntAmount(invoice.sgstMinor), currency),
        igstDisplay: formatMoney(toBigIntAmount(invoice.igstMinor), currency),
        totalDisplay: formatMoney(total, currency),
        amountPaidDisplay: formatMoney(paid, currency),
        // Computed here, in BigInt, rather than in the browser. A
        // customer reading "outstanding" is reading a number they may
        // pay against; it must not be a float subtraction.
        outstandingDisplay: formatMoney(total - paid, currency),
        isInterState: toBigIntAmount(invoice.igstMinor) > 0n,
        customerLegalName: invoice.customerLegalName,
        customerGstin: invoice.customerGstin,
        placeOfSupplyCode: invoice.placeOfSupplyCode,
        issuedAt: invoice.issuedAt?.toISOString() ?? null,
        dueAt: invoice.dueAt?.toISOString() ?? null,
        paidAt: invoice.paidAt?.toISOString() ?? null,
        periodStart: invoice.periodStart?.toISOString() ?? null,
        periodEnd: invoice.periodEnd?.toISOString() ?? null,
        lines: lines.map((line) => ({
          description: line.description,
          sacCode: line.sacCode,
          quantity: line.quantity,
          unitAmountDisplay: formatMoney(
            toBigIntAmount(line.unitAmountMinor),
            currency,
          ),
          amountDisplay: formatMoney(toBigIntAmount(line.amountMinor), currency),
          amountMinor: serializeAmount(toBigIntAmount(line.amountMinor)),
          lineType: line.lineType,
        })),
      },
    };
  } catch (err) {
    return toActionError(err, "getInvoiceDetail");
  }
}

/**
 * The printable invoice, as a self-contained HTML document.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY HTML AND NOT A PDF
 * ══════════════════════════════════════════════════════════════════════
 * A PDF needs a rendering engine. The realistic options are a headless
 * browser — which does not run on Vercel's serverless functions without
 * a large custom layer and a cold start measured in seconds — or a
 * JavaScript PDF library, which means re-implementing the layout in a
 * second, worse language and maintaining two renderers that must agree.
 *
 * An HTML document with print styles gives the customer a PDF in one
 * keystroke, from a browser that already has the fonts and does the
 * pagination correctly. It also renders in an email client, which a PDF
 * attachment does not.
 *
 * When a PDF becomes a genuine requirement — an enterprise customer whose
 * AP system ingests them — the honest answer is a rendering service, not
 * a library bolted into this function.
 */
export async function getInvoiceHtml(
  invoiceId: string,
): Promise<ActionResult<{ html: string; fileName: string }>> {
  try {
    const ctx = await requirePermission("billing:read");

    if (!/^[0-9a-f-]{36}$/i.test(invoiceId)) {
      return fail("That invoice could not be found.");
    }

    const result = await getInvoiceWithLines(ctx.tenant.id, invoiceId);
    if (!result) return fail("That invoice could not be found.");

    const html = renderInvoiceHtml({
      invoice: result.invoice,
      lines: result.lines,
      supplier: {
        legalName: process.env.PLATFORM_LEGAL_NAME ?? "Ordence",
        gstin: process.env.PLATFORM_GSTIN ?? null,
        stateCode: process.env.PLATFORM_GST_STATE_CODE ?? "29",
        address: process.env.PLATFORM_ADDRESS ?? null,
      },
    });

    return {
      ok: true,
      data: {
        html,
        // The invoice number contains slashes ("AH/2026-27/000148"), which
        // are path separators. Replaced rather than stripped so the number
        // stays readable in the filename.
        fileName: `${result.invoice.invoiceNumber.replace(/\//g, "-")}.html`,
      },
    };
  } catch (err) {
    return toActionError(err, "getInvoiceHtml");
  }
}

/* ------------------------------------------------------------------ */
/* ISSUING                                                             */
/* ------------------------------------------------------------------ */

/**
 * Issue the invoice for a subscription's current period, by hand.
 *
 * For an enterprise customer paying offline against a proforma. Requires
 * `billing:manage`.
 *
 * ⚠️ Idempotent by DATABASE CONSTRAINT. The unique index on
 * `(subscription_id, period_start, period_end)` means clicking twice —
 * or a double-submit, or an impatient operator — cannot produce two
 * invoices for one period. The friendly pre-check inside
 * `invoiceCurrentPeriod` races; the index does not.
 */
export async function issueInvoiceForCurrentPeriod(): Promise<
  ActionResult<{ invoiceNumber: string; alreadyIssued: boolean }>
> {
  try {
    const ctx = await requirePermission("billing:manage");

    const subscription = await withTenant(ctx.tenant.id, async (tx) => {
      const [row] = await tx
        .select({ id: subscriptions.id })
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.tenantId, ctx.tenant.id),
            sql`${subscriptions.deletedAt} IS NULL`,
            sql`${subscriptions.status} IN ('trialing','active','past_due','unpaid','paused')`,
          ),
        )
        .limit(1);
      return row ?? null;
    });

    if (!subscription) {
      return fail("There is no active subscription to invoice.");
    }

    const result = await invoiceCurrentPeriod(ctx.tenant.id, subscription.id);

    if ("alreadyIssued" in result) {
      return {
        ok: true,
        data: { invoiceNumber: result.invoiceNumber, alreadyIssued: true },
      };
    }

    return {
      ok: true,
      data: { invoiceNumber: result.invoiceNumber, alreadyIssued: false },
    };
  } catch (err) {
    return toActionError(err, "issueInvoiceForCurrentPeriod");
  }
}

/**
 * Void an invoice.
 *
 * ⚠️ Voiding is NOT deletion, and that distinction is the point. The row
 * stays, the number stays allocated, and the document remains readable —
 * because the customer may already hold a copy, and a number that simply
 * vanished from a series is exactly what an auditor asks about.
 *
 * What voiding does is free the period slot, so a corrected invoice can
 * be issued. That is the only supported route back from a mistaken issue.
 */
export async function voidInvoice(input: {
  invoiceId: string;
  reason: string;
}): Promise<ActionResult<null>> {
  try {
    const ctx = await requirePermission("billing:manage");

    const reason = input.reason?.trim() ?? "";
    if (reason.length < 5) {
      // A void with no stated reason is a gap in the series nobody can
      // explain later — including the person who created it.
      return fail("Please record why this invoice is being voided.");
    }

    await withTenant(ctx.tenant.id, async (tx) => {
      const [invoice] = await tx
        .select({
          id: invoices.id,
          status: invoices.status,
          amountPaid: invoices.amountPaidMinor,
          invoiceNumber: invoices.invoiceNumber,
        })
        .from(invoices)
        .where(
          and(
            eq(invoices.id, input.invoiceId),
            eq(invoices.tenantId, ctx.tenant.id),
          ),
        )
        .limit(1);

      if (!invoice) throw new InvoiceGenerationError("Invoice not found.", "not_found");

      // ⚠️ A PAID invoice cannot be voided. Money has moved; the correct
      // instrument is a credit note and a refund, and voiding would leave
      // a payment recorded against a document that says it was never
      // owed.
      if (toBigIntAmount(invoice.amountPaid) > 0n) {
        throw new InvoiceGenerationError(
          `Invoice ${invoice.invoiceNumber} has payments recorded against it. ` +
            `Issue a credit note instead of voiding it.`,
          "already_paid",
        );
      }

      await tx
        .update(invoices)
        .set({
          status: "void",
          voidedAt: new Date(),
          notes: reason,
          updatedAt: new Date(),
        })
        .where(eq(invoices.id, invoice.id));
    });

    return { ok: true, data: null };
  } catch (err) {
    return toActionError(err, "voidInvoice");
  }
}
