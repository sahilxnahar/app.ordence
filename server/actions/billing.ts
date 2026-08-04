"use server";

/**
 * Ordence — Billing Server Actions
 * Version: v0.11.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE MAY AND MAY NOT DO
 * ══════════════════════════════════════════════════════════════════════
 * MAY:  read billing state for the signed-in tenant, start a checkout,
 *       change a plan, cancel, record a manual settlement.
 * MAY NOT: apply a provider event. That is `server/billing/reconcile.ts`
 *       and only ever runs from a verified webhook. A "mark as paid"
 *       action reachable from the UI would be the single most valuable
 *       endpoint in the product to an attacker.
 *
 * ══════════════════════════════════════════════════════════════════════
 * EVERY EXPORT IS AN ASYNC FUNCTION
 * ══════════════════════════════════════════════════════════════════════
 * A `"use server"` file may export nothing else — every other export is
 * compiled into a public RPC endpoint. Schemas, catalogues and constants
 * live in `lib/validators/billing.ts`. This cost a build failure in
 * Phase 7 and is not going to cost another one.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, withTenant } from "@/db";
import {
  plans,
  subscriptions,
  invoices,
  invoiceLines,
  paymentEvents,
  paymentMethods,
  tenants,
  users,
  isLiveSubscription,
  type PaymentProvider,
  type SubscriptionStatus,
} from "@/db/schema";
import { requirePermission, writeAudit } from "@/server/audit";
import { TenantAccessError, requireTenantContext } from "@/server/tenant-context";
import {
  assertImpersonationAllows,
  ImpersonationForbiddenError,
} from "@/server/platform/impersonation";
import { PermissionDeniedError } from "@/lib/permissions";
import { getAdapter, selectProviderForCurrency } from "@/lib/billing/providers";
import { ProviderError } from "@/lib/billing/providers/types";
import {
  addDays,
  addInterval,
  computeGst,
  computeProration,
  formatMoney,
  parseMoney,
  serializeAmount,
  toBigIntAmount,
} from "@/lib/billing/money";
import {
  startCheckoutSchema,
  changePlanSchema,
  cancelSubscriptionSchema,
  recordManualPaymentSchema,
  billingProfileSchema,
  DEFAULT_SUPPLIER_STATE_CODE,
  SAAS_GST_RATE_BPS,
  SAAS_SAC_CODE,
} from "@/lib/validators/billing";
import { recordUserBillingAudit } from "@/server/billing/audit-billing";
import type { ActionResult } from "@/lib/validators/crm";
import type { UsageSummary } from "@/server/metering/query";

/* ------------------------------------------------------------------ */
/* ERROR HANDLING                                                      */
/* ------------------------------------------------------------------ */

function fail(error: string, fieldErrors?: Record<string, string[]>): ActionResult<never> {
  return { ok: false, error, fieldErrors };
}

/**
 * Provider errors are surfaced with their message because the customer
 * genuinely needs to know "your card was declined" — but ONLY for
 * non-retryable errors, which are the ones caused by the request. A
 * transient failure gets a generic message, because "Razorpay returned
 * 503" is not something a customer can act on and telling them our
 * upstream is down invites them to try again immediately, which is
 * exactly wrong.
 */
function toActionError(err: unknown, scope: string): ActionResult<never> {
  if (err instanceof TenantAccessError) return fail(err.message);
  if (err instanceof PermissionDeniedError) return fail(err.message);
  if (err instanceof ImpersonationForbiddenError) return fail(err.message);
  if (err instanceof z.ZodError) {
    return fail("Please check the form.", err.flatten().fieldErrors as Record<string, string[]>);
  }
  if (err instanceof ProviderError) {
    console.error(`[billing:${scope}] provider error:`, err.message);
    return fail(
      err.retryable
        ? "We could not reach the payment provider. Please try again in a moment."
        : err.message,
    );
  }
  console.error(`[billing:${scope}]`, err);
  return fail("Something went wrong. Please try again.");
}

/* ------------------------------------------------------------------ */
/* SERIALISATION AT THE RSC BOUNDARY                                   */
/* ------------------------------------------------------------------ */

/**
 * `JSON.stringify` throws on a bigint. A server action returning a raw
 * billing row therefore crashes the moment it crosses into a client
 * component — at runtime, not at build time, and only on pages that
 * actually render money.
 *
 * So every amount is converted to a string here, explicitly, and the
 * shapes returned below carry `*Display` fields with the formatted value
 * alongside. The client never does money arithmetic.
 */
export type PlanView = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  tier: string;
  interval: string;
  currency: string;
  amountMinor: string;
  amountDisplay: string;
  includedSeats: number;
  perSeatAmountMinor: string;
  perSeatDisplay: string;
  storageLimitMb: number;
  trialDays: number;
  highlights: string[];
  sortOrder: number;
};

export type SubscriptionView = {
  id: string;
  status: SubscriptionStatus;
  provider: PaymentProvider;
  planName: string;
  planTier: string;
  interval: string;
  currency: string;
  unitAmountMinor: string;
  unitAmountDisplay: string;
  seatsPurchased: number;
  seatsUsed: number;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  trialEndsAt: string | null;
  cancelAtPeriodEnd: boolean;
  failedPaymentCount: number;
  graceEndsAt: string | null;
};

export type InvoiceView = {
  id: string;
  invoiceNumber: string;
  status: string;
  currency: string;
  totalMinor: string;
  totalDisplay: string;
  amountPaidMinor: string;
  amountPaidDisplay: string;
  issuedAt: string | null;
  dueAt: string | null;
  paidAt: string | null;
  hostedInvoiceUrl: string | null;
};

/* ------------------------------------------------------------------ */
/* READS                                                               */
/* ------------------------------------------------------------------ */

/**
 * The public plan catalogue.
 *
 * Requires NO permission and no tenant scoping — it is the pricing page.
 * Non-public plans (Enterprise, legacy grandfathered rates) are excluded
 * so a bespoke price negotiated with one customer is not visible to
 * every other one.
 */
export async function listPublicPlans(): Promise<ActionResult<PlanView[]>> {
  try {
    const rows = await db
      .select()
      .from(plans)
      .where(and(eq(plans.isActive, true), eq(plans.isPublic, true)))
      .orderBy(plans.sortOrder);

    return { ok: true, data: rows.map(toPlanView) };
  } catch (err) {
    return toActionError(err, "listPublicPlans");
  }
}

/** The signed-in tenant's current subscription, or null if they have none. */
export async function getCurrentSubscription(): Promise<ActionResult<SubscriptionView | null>> {
  try {
    const ctx = await requirePermission("billing:read");

    return await withTenant(ctx.tenant.id, async (tx) => {
      const [row] = await tx
        .select({
          subscription: subscriptions,
          plan: plans,
        })
        .from(subscriptions)
        .innerJoin(plans, eq(plans.id, subscriptions.planId))
        .where(
          and(
            eq(subscriptions.tenantId, ctx.tenant.id),
            sql`${subscriptions.deletedAt} IS NULL`,
            sql`${subscriptions.status} IN ('trialing','active','past_due','unpaid','paused')`,
          ),
        )
        .limit(1);

      if (!row) return { ok: true as const, data: null };

      // Seats actually consumed. Counted live rather than cached: a stale
      // count is the difference between "you have 2 seats spare" and a
      // failed invite, and Phase 13 gates on this number.
      const [seatCount] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(users)
        .where(
          and(
            eq(users.tenantId, ctx.tenant.id),
            sql`${users.deletedAt} IS NULL`,
            sql`${users.status} IN ('invited','active')`,
          ),
        );

      return {
        ok: true as const,
        data: toSubscriptionView(row.subscription, row.plan, seatCount?.count ?? 0),
      };
    });
  } catch (err) {
    return toActionError(err, "getCurrentSubscription");
  }
}

/** Invoice history, newest first. */
export async function listInvoices(limit = 50): Promise<ActionResult<InvoiceView[]>> {
  try {
    const ctx = await requirePermission("billing:read");
    const bounded = Math.min(Math.max(1, Math.trunc(limit)), 200);

    return await withTenant(ctx.tenant.id, async (tx) => {
      const rows = await tx
        .select()
        .from(invoices)
        .where(eq(invoices.tenantId, ctx.tenant.id))
        .orderBy(desc(invoices.createdAt))
        .limit(bounded);

      return { ok: true as const, data: rows.map(toInvoiceView) };
    });
  } catch (err) {
    return toActionError(err, "listInvoices");
  }
}

/* ------------------------------------------------------------------ */
/* PAYMENT INSTRUMENTS — DISPLAY ONLY                                  */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ EVERY FIELD HERE IS COSMETIC. `providerMethodId` — the only value
 * that can actually move money — is NOT in this shape and never crosses
 * to the client. A brand and a last4 identify a card to the person who
 * owns it and authorise nothing.
 *
 * ⭐ `expiresWithinPeriod` IS THE REASON THIS EXISTS.
 *
 * A default card that expires before the next renewal is a failed
 * payment that has already happened — the date is knowable today and the
 * consequence lands on renewal day, when the dunning ladder starts and
 * somebody's workspace goes read-only for a reason nobody was told
 * about. Computed on the SERVER against the subscription's own period
 * end, because a client that re-derives it from a timezone-shifted
 * `new Date()` will disagree by a day exactly at the boundary that
 * matters.
 */
export type PaymentMethodView = {
  id: string;
  provider: PaymentProvider;
  methodType: string;
  brand: string | null;
  last4: string | null;
  /** "09/2026", or null for a method with no expiry (UPI, netbanking). */
  expiry: string | null;
  upiVpaMasked: string | null;
  bankName: string | null;
  isDefault: boolean;
  /** Already past its expiry month. */
  isExpired: boolean;
  /** Expires before `beforeIso` — the next renewal, when one is passed. */
  expiresBeforeRenewal: boolean;
};

/**
 * The workspace's saved payment instruments.
 *
 * `beforeIso` is the date to test expiry against — pass the current
 * subscription's `currentPeriodEnd`. Omitted, nothing is flagged as
 * expiring early, which is the safe direction: a false "your card is
 * fine" on a page nobody reads is better than a false alarm that trains
 * people to ignore the real one.
 */
export async function listPaymentMethods(
  beforeIso?: string,
): Promise<ActionResult<PaymentMethodView[]>> {
  try {
    const ctx = await requirePermission("billing:read");

    const renewal = beforeIso ? new Date(beforeIso) : null;
    const validRenewal =
      renewal && !Number.isNaN(renewal.getTime()) ? renewal : null;
    const now = new Date();

    return await withTenant(ctx.tenant.id, async (tx) => {
      const rows = await tx
        .select()
        .from(paymentMethods)
        .where(
          and(
            eq(paymentMethods.tenantId, ctx.tenant.id),
            sql`${paymentMethods.deletedAt} IS NULL`,
          ),
        )
        .orderBy(desc(paymentMethods.isDefault), desc(paymentMethods.createdAt))
        .limit(50);

      return {
        ok: true as const,
        data: rows.map((row) => {
          // A card is valid through the LAST INSTANT of its expiry month,
          // so the moment it dies is the first instant of the next one.
          // Treating the 1st of the expiry month as dead would tell a
          // customer their working card had failed, for a month.
          const dies =
            row.expiryYear && row.expiryMonth
              ? new Date(Date.UTC(row.expiryYear, row.expiryMonth, 1))
              : null;

          return {
            id: row.id,
            provider: row.provider,
            methodType: row.methodType,
            brand: row.brand,
            last4: row.last4,
            expiry:
              row.expiryMonth && row.expiryYear
                ? `${String(row.expiryMonth).padStart(2, "0")}/${row.expiryYear}`
                : null,
            upiVpaMasked: row.upiVpaMasked,
            bankName: row.bankName,
            isDefault: row.isDefault,
            isExpired: dies !== null && dies <= now,
            expiresBeforeRenewal:
              dies !== null && validRenewal !== null && dies <= validRenewal,
          };
        }),
      };
    });
  } catch (err) {
    return toActionError(err, "listPaymentMethods");
  }
}

/* ------------------------------------------------------------------ */
/* USAGE AGAINST PLAN LIMITS                                           */
/* ------------------------------------------------------------------ */

/**
 * What this workspace has consumed in the current BILLING period,
 * compared against the quotas on its plan.
 *
 * ⚠️ A THIN WRAPPER, AND IT STAYS THIN ON PURPOSE. Every figure and
 * every sentence comes from `getUsageSummary`, which is the same code
 * path the upload gate and the overage invoicer use. A second
 * implementation here — even just a percentage — is how "the billing
 * page said we had 200 MB free" and "upload refused" happen on the same
 * afternoon.
 *
 * ⭐ ALREADY SERIALISED. Every quantity in Phase 15 is a `bigint`, and
 * `JSON.stringify` throws on one — a raw `QuotaState` returned from here
 * crashes the RSC boundary at runtime, on the page that renders money.
 */
export async function getUsageAgainstPlan(): Promise<ActionResult<UsageSummary>> {
  try {
    const ctx = await requirePermission("billing:read");
    const { getUsageSummary } = await import("@/server/metering/query");
    return { ok: true, data: await getUsageSummary(ctx.tenant.id) };
  } catch (err) {
    return toActionError(err, "getUsageAgainstPlan");
  }
}

/* ------------------------------------------------------------------ */
/* CHECKOUT                                                            */
/* ------------------------------------------------------------------ */

/**
 * Begin a subscription.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THIS DOES NOT CREATE A SUBSCRIPTION ROW
 * ══════════════════════════════════════════════════════════════════════
 * It creates a PENDING one at the provider and returns a URL. The local
 * `subscriptions` row is written by the webhook that confirms payment,
 * through `reconcile.ts`.
 *
 * That ordering is deliberate. If this action wrote the row optimistically
 * and the customer then abandoned the payment page, they would hold an
 * active-looking subscription they never paid for — and the
 * one-live-subscription index would block them from ever trying again.
 *
 * The cost is that a successful payment is not reflected instantly; the
 * page polls or the customer refreshes. That is the right trade: a few
 * seconds of "confirming your payment" beats a subscription that exists
 * without money behind it.
 */
export async function startCheckout(
  input: unknown,
): Promise<ActionResult<{ url: string | null; clientParams: Record<string, string> }>> {
  try {
    const ctx = await requirePermission("billing:manage");
    /*
      ⭐ MONEY THE CUSTOMER NEVER SANCTIONED.
      A plan change is a purchase decision. "Support upgraded us while
      diagnosing an invoice bug" is a chargeback and a lost account,
      and no consent to look at a workspace is consent to spend from
      it.
    */
    await assertImpersonationAllows("subscription:start", ctx);
    const parsed = startCheckoutSchema.parse(input);

    const [plan] = await db
      .select()
      .from(plans)
      .where(and(eq(plans.id, parsed.planId), eq(plans.isActive, true)))
      .limit(1);

    if (!plan) return fail("That plan is not available.");

    /* --- Refuse if a live subscription already exists ------------- */
    //
    // Checked here for a good error message; the partial unique index is
    // what actually guarantees it. Both, because this check races and the
    // index does not.
    const existing = await withTenant(ctx.tenant.id, async (tx) => {
      const [row] = await tx
        .select({ id: subscriptions.id, status: subscriptions.status })
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.tenantId, ctx.tenant.id),
            sql`${subscriptions.deletedAt} IS NULL`,
          ),
        )
        .orderBy(desc(subscriptions.createdAt))
        .limit(1);
      return row ?? null;
    });

    if (existing && isLiveSubscription(existing.status)) {
      return fail(
        "This workspace already has an active subscription. Change your plan instead of starting a new one.",
      );
    }

    /* --- Pick a provider ----------------------------------------- */

    const provider = selectProviderForCurrency(plan.currency);
    if (!provider || provider === "manual") {
      return fail(
        "Online payments are not configured for this workspace yet. Please contact us to arrange an invoice.",
      );
    }

    const adapter = getAdapter(provider);

    const providerPlanId =
      provider === "razorpay" ? plan.razorpayPlanId : plan.stripePriceId;

    if (!providerPlanId) {
      // A catalogue row that was never mirrored into the provider. A
      // clear internal error beats a provider 400 the customer cannot act on.
      console.error(
        `[billing:startCheckout] Plan ${plan.code} has no ${provider} id configured.`,
      );
      return fail("That plan cannot be purchased online yet. Please contact us.");
    }

    /* --- Build return URLs from OUR origin ------------------------ */
    //
    // `returnPath` is validated as a RELATIVE PATH by the schema and is
    // joined to our own origin here. Accepting a full URL would be an
    // open-redirect: a customer could be sent to an attacker's page that
    // looks like a payment confirmation.
    const origin = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    const successUrl = `${origin}${parsed.returnPath}?checkout=success`;
    const cancelUrl = `${origin}${parsed.returnPath}?checkout=cancelled`;

    const trialEndsAt =
      plan.trialDays > 0 && !existing ? addDays(new Date(), plan.trialDays) : null;

    /**
     * Idempotency key. Deterministic across a double-click within the
     * same minute, distinct across genuine separate attempts. Without it,
     * an impatient customer clicking twice creates two subscriptions at
     * the provider and is charged twice before our unique index ever sees
     * them — because the index protects OUR rows, not the provider's.
     */
    const minuteBucket = Math.floor(Date.now() / 60_000);
    const idempotencyKey = `chk:${ctx.tenant.id}:${plan.id}:${parsed.seats}:${minuteBucket}`;

    const session = await adapter.createSubscription({
      tenantId: ctx.tenant.id,
      providerPlanId,
      customerEmail: ctx.user.email,
      customerName: ctx.tenant.legalName ?? ctx.tenant.name,
      seats: parsed.seats,
      trialEndsAt,
      successUrl,
      cancelUrl,
      idempotencyKey,
    });

    await writeAudit(ctx, {
      action: "config_change",
      resourceType: "subscription",
      resourceId: session.providerReferenceId,
      severity: "notice",
      reason: "Checkout started",
      metadata: {
        planCode: plan.code,
        provider,
        seats: parsed.seats,
        amountMinor: plan.amountMinor.toString(),
      },
    });

    return { ok: true, data: { url: session.url, clientParams: session.clientParams } };
  } catch (err) {
    return toActionError(err, "startCheckout");
  }
}

/* ------------------------------------------------------------------ */
/* PLAN CHANGES                                                        */
/* ------------------------------------------------------------------ */

export type ProrationPreview = {
  isUpgrade: boolean;
  creditDisplay: string;
  chargeDisplay: string;
  netDisplay: string;
  netMinor: string;
  effectiveImmediately: boolean;
  explanation: string;
};

/**
 * Show what a plan change will cost BEFORE it is made.
 *
 * A preview that disagrees with the eventual charge is worse than no
 * preview, so this uses exactly the same `computeProration` the change
 * itself uses — not an approximation for display.
 */
export async function previewPlanChange(
  input: unknown,
): Promise<ActionResult<ProrationPreview>> {
  try {
    const ctx = await requirePermission("billing:read");
    const parsed = changePlanSchema.parse(input);

    const [newPlan] = await db
      .select()
      .from(plans)
      .where(and(eq(plans.id, parsed.planId), eq(plans.isActive, true)))
      .limit(1);

    if (!newPlan) return fail("That plan is not available.");

    return await withTenant(ctx.tenant.id, async (tx) => {
      const [row] = await tx
        .select({ subscription: subscriptions, plan: plans })
        .from(subscriptions)
        .innerJoin(plans, eq(plans.id, subscriptions.planId))
        .where(
          and(
            eq(subscriptions.tenantId, ctx.tenant.id),
            sql`${subscriptions.status} IN ('trialing','active','past_due')`,
            sql`${subscriptions.deletedAt} IS NULL`,
          ),
        )
        .limit(1);

      if (!row) return fail("There is no active subscription to change.");

      const upgrading = newPlan.amountMinor > row.subscription.unitAmountMinor;

      const proration = computeProration({
        periodStart: row.subscription.currentPeriodStart,
        periodEnd: row.subscription.currentPeriodEnd,
        changeAt: new Date(),
        oldAmountMinor: toBigIntAmount(row.subscription.unitAmountMinor),
        newAmountMinor: toBigIntAmount(newPlan.amountMinor),
      });

      const currency = row.subscription.currency;
      const days = Math.ceil(proration.remainingSeconds / 86_400);

      return {
        ok: true as const,
        data: {
          isUpgrade: upgrading,
          creditDisplay: formatMoney(proration.creditMinor, currency),
          chargeDisplay: formatMoney(proration.chargeMinor, currency),
          netDisplay: formatMoney(proration.netMinor, currency),
          netMinor: serializeAmount(proration.netMinor),
          effectiveImmediately: upgrading,
          explanation: upgrading
            ? `You have ${days} day${days === 1 ? "" : "s"} left in this billing period. ` +
              `We will credit the unused time on your current plan and charge the ` +
              `difference today. Your renewal date does not change.`
            : `Your new plan starts at the end of the current period. ` +
              `You keep everything you have now until then, and nothing is charged today.`,
        },
      };
    });
  } catch (err) {
    return toActionError(err, "previewPlanChange");
  }
}

/* ------------------------------------------------------------------ */
/* CANCELLATION                                                        */
/* ------------------------------------------------------------------ */

export async function cancelSubscription(input: unknown): Promise<ActionResult<null>> {
  try {
    const ctx = await requirePermission("billing:manage");
    await assertImpersonationAllows("subscription:cancel", ctx);
    const parsed = cancelSubscriptionSchema.parse(input);

    const target = await withTenant(ctx.tenant.id, async (tx) => {
      const [row] = await tx
        .select()
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.tenantId, ctx.tenant.id),
            sql`${subscriptions.status} IN ('trialing','active','past_due','unpaid','paused')`,
            sql`${subscriptions.deletedAt} IS NULL`,
          ),
        )
        .limit(1);
      return row ?? null;
    });

    if (!target) return fail("There is no active subscription to cancel.");

    /**
     * The PROVIDER is cancelled first, then our row is updated.
     *
     * The reverse order has a specific failure mode: our row says
     * cancelled, the provider call fails, and the customer keeps being
     * charged for a subscription our UI tells them is over. They find out
     * on their card statement.
     *
     * This order's failure mode — provider cancelled, our update fails —
     * is recoverable: the provider's cancellation webhook arrives and
     * `reconcile.ts` brings us into line. One direction self-heals; the
     * other bills someone for nothing.
     */
    if (target.providerSubscriptionId && target.provider !== "manual") {
      await getAdapter(target.provider).cancelSubscription({
        providerSubscriptionId: target.providerSubscriptionId,
        atPeriodEnd: parsed.atPeriodEnd,
      });
    }

    await withTenant(ctx.tenant.id, async (tx) => {
      await tx
        .update(subscriptions)
        .set({
          status: parsed.atPeriodEnd ? target.status : "cancelled",
          cancelAtPeriodEnd: parsed.atPeriodEnd,
          cancelledAt: new Date(),
          cancellationReason: parsed.reason ?? null,
          updatedAt: new Date(),
        })
        .where(eq(subscriptions.id, target.id));

      await recordUserBillingAudit(tx, {
        tenantId: ctx.tenant.id,
        actorUserId: ctx.user.id,
        actorClerkId: ctx.clerkUserId,
        actorEmail: ctx.user.email,
        actorRole: ctx.role,
        action: "config_change",
        resourceType: "subscription",
        resourceId: target.id,
        severity: "warning",
        reason: parsed.reason ?? "Subscription cancelled by customer",
        metadata: {
          atPeriodEnd: parsed.atPeriodEnd,
          periodEnd: target.currentPeriodEnd.toISOString(),
          provider: target.provider,
        },
      });
    });

    revalidatePath("/settings/billing");
    return { ok: true, data: null };
  } catch (err) {
    return toActionError(err, "cancelSubscription");
  }
}

/* ------------------------------------------------------------------ */
/* MANUAL SETTLEMENT                                                   */
/* ------------------------------------------------------------------ */

/**
 * Record an offline payment (NEFT/RTGS/cheque) against an open invoice.
 *
 * ⚠️ THE MOST DANGEROUS ACTION IN THIS FILE. It marks money as received
 * on nothing but a human's word, so:
 *
 *   • it requires `billing:manage`;
 *   • it demands a bank reference of at least four characters — "paid"
 *     without a UTR is an assertion, not a record;
 *   • it writes a `payment_events` row, which is append-only, naming the
 *     user who did it;
 *   • it refuses to overpay an invoice, because an over-application is
 *     almost always a duplicate entry rather than a genuine overpayment.
 */
export async function recordManualPayment(input: unknown): Promise<ActionResult<null>> {
  try {
    const ctx = await requirePermission("billing:manage");
    // Recording a payment that did not happen marks an invoice paid.
    // It is the one billing write that costs US money rather than the
    // customer, and it is still theirs to make.
    await assertImpersonationAllows("payment:record_manual", ctx);
    const parsed = recordManualPaymentSchema.parse(input);

    return await withTenant(ctx.tenant.id, async (tx) => {
      const [invoice] = await tx
        .select()
        .from(invoices)
        .where(
          and(eq(invoices.id, parsed.invoiceId), eq(invoices.tenantId, ctx.tenant.id)),
        )
        .limit(1);

      if (!invoice) return fail("That invoice does not exist in this workspace.");
      if (invoice.status === "void" || invoice.status === "refunded") {
        return fail(`Invoice ${invoice.invoiceNumber} is ${invoice.status}.`);
      }

      const amountMinor = parseMoney(parsed.amount, invoice.currency);
      if (amountMinor <= 0n) return fail("Enter an amount greater than zero.");

      const alreadyPaid = toBigIntAmount(invoice.amountPaidMinor);
      const total = toBigIntAmount(invoice.totalMinor);
      const newPaid = alreadyPaid + amountMinor;

      if (newPaid > total) {
        const outstanding = total - alreadyPaid;
        return fail(
          `That is more than the outstanding balance of ` +
            `${formatMoney(outstanding, invoice.currency)} on invoice ` +
            `${invoice.invoiceNumber}. Check whether this payment has already been recorded.`,
        );
      }

      const fullySettled = newPaid === total;

      await tx
        .update(invoices)
        .set({
          amountPaidMinor: newPaid,
          status: fullySettled ? "paid" : "partially_paid",
          paidAt: fullySettled ? new Date(parsed.receivedAt) : null,
          updatedAt: new Date(),
        })
        .where(eq(invoices.id, invoice.id));

      /**
       * The evidence row. `providerEventId` is built from the invoice and
       * the bank reference, so recording the SAME UTR against the SAME
       * invoice twice violates the unique index and is refused — which is
       * exactly the double-entry mistake a busy finance person makes.
       */
      await tx.insert(paymentEvents).values({
        tenantId: ctx.tenant.id,
        subscriptionId: invoice.subscriptionId,
        invoiceId: invoice.id,
        provider: "manual",
        providerEventId: `manual:${invoice.id}:${parsed.reference.trim().toLowerCase()}`,
        providerEventName: "manual.payment.recorded",
        eventType: "payment_succeeded",
        status: "processed",
        amountMinor,
        currency: invoice.currency,
        occurredAt: new Date(parsed.receivedAt),
        payload: {
          reference: parsed.reference,
          note: parsed.note ?? null,
          recordedByUserId: ctx.user.id,
          recordedByEmail: ctx.user.email,
        },
      });

      await recordUserBillingAudit(tx, {
        tenantId: ctx.tenant.id,
        actorUserId: ctx.user.id,
        actorClerkId: ctx.clerkUserId,
        actorEmail: ctx.user.email,
        actorRole: ctx.role,
        action: "update",
        resourceType: "invoice",
        resourceId: invoice.id,
        severity: "notice",
        reason: `Manual payment recorded, reference ${parsed.reference}`,
        metadata: {
          invoiceNumber: invoice.invoiceNumber,
          amountMinor: amountMinor.toString(),
          reference: parsed.reference,
          fullySettled,
        },
      });

      revalidatePath("/settings/billing");
      return { ok: true as const, data: null };
    });
  } catch (err) {
    // A unique violation here is the duplicate-UTR case described above.
    if (err && typeof err === "object" && "code" in err && err.code === "23505") {
      return fail(
        "That bank reference has already been recorded against this invoice. " +
          "Check the payment history before entering it again.",
      );
    }
    return toActionError(err, "recordManualPayment");
  }
}

/* ------------------------------------------------------------------ */
/* BILLING PROFILE                                                     */
/* ------------------------------------------------------------------ */

/**
 * Store the tax identity used on future invoices.
 *
 * Held in `tenants.settings` rather than a new table: it is one small
 * object per tenant, read on every invoice render, and it is exactly the
 * kind of configuration that column already holds. The settings object is
 * MERGED, never replaced — Phase 7's General and Financial forms write
 * to the same column, and replacing it would silently erase their keys.
 */
export async function saveBillingProfile(input: unknown): Promise<ActionResult<null>> {
  try {
    const ctx = await requirePermission("billing:manage");
    // The billing profile is the legal name and GSTIN every future
    // invoice is raised against. Editing it silently restates the
    // customer's tax position.
    await assertImpersonationAllows("billing:profile", ctx);
    const parsed = billingProfileSchema.parse(input);

    await withTenant(ctx.tenant.id, async (tx) => {
      const [current] = await tx
        .select({ settings: tenants.settings, legalName: tenants.legalName })
        .from(tenants)
        .where(eq(tenants.id, ctx.tenant.id))
        .limit(1);

      await tx
        .update(tenants)
        .set({
          legalName: parsed.legalName,
          settings: {
            ...(current?.settings ?? {}),
            billingProfile: {
              gstin: parsed.gstin || null,
              placeOfSupplyCode: parsed.placeOfSupplyCode,
              addressLine1: parsed.addressLine1,
              addressLine2: parsed.addressLine2 || null,
              city: parsed.city,
              state: parsed.state,
              postalCode: parsed.postalCode,
              country: parsed.country,
              billingEmail: parsed.billingEmail,
            },
          },
          updatedAt: new Date(),
        })
        .where(eq(tenants.id, ctx.tenant.id));

      await recordUserBillingAudit(tx, {
        tenantId: ctx.tenant.id,
        actorUserId: ctx.user.id,
        actorClerkId: ctx.clerkUserId,
        actorEmail: ctx.user.email,
        actorRole: ctx.role,
        action: "config_change",
        resourceType: "billing_profile",
        resourceId: ctx.tenant.id,
        severity: "notice",
        reason: "Billing profile updated",
        metadata: {
          // The GSTIN is a business registration number printed on public
          // invoices, not a secret — recording it is what makes a later
          // "who changed our tax details?" question answerable.
          gstin: parsed.gstin || null,
          placeOfSupplyCode: parsed.placeOfSupplyCode,
        },
      });
    });

    revalidatePath("/settings/billing");
    return { ok: true, data: null };
  } catch (err) {
    return toActionError(err, "saveBillingProfile");
  }
}

/* ------------------------------------------------------------------ */
/* MAPPERS                                                             */
/* ------------------------------------------------------------------ */

function toPlanView(row: typeof plans.$inferSelect): PlanView {
  const amount = toBigIntAmount(row.amountMinor);
  const perSeat = toBigIntAmount(row.perSeatAmountMinor);
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    tier: row.tier,
    interval: row.interval,
    currency: row.currency,
    amountMinor: serializeAmount(amount),
    amountDisplay: formatMoney(amount, row.currency),
    includedSeats: row.includedSeats,
    perSeatAmountMinor: serializeAmount(perSeat),
    perSeatDisplay: formatMoney(perSeat, row.currency),
    storageLimitMb: row.storageLimitMb,
    trialDays: row.trialDays,
    highlights: row.highlights,
    sortOrder: row.sortOrder,
  };
}

function toSubscriptionView(
  row: typeof subscriptions.$inferSelect,
  plan: typeof plans.$inferSelect,
  seatsUsed: number,
): SubscriptionView {
  const unit = toBigIntAmount(row.unitAmountMinor);
  return {
    id: row.id,
    status: row.status,
    provider: row.provider,
    planName: plan.name,
    planTier: plan.tier,
    interval: row.interval,
    currency: row.currency,
    unitAmountMinor: serializeAmount(unit),
    unitAmountDisplay: formatMoney(unit, row.currency),
    seatsPurchased: row.seatsPurchased,
    seatsUsed,
    currentPeriodStart: row.currentPeriodStart.toISOString(),
    currentPeriodEnd: row.currentPeriodEnd.toISOString(),
    trialEndsAt: row.trialEndsAt?.toISOString() ?? null,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    failedPaymentCount: row.failedPaymentCount,
    graceEndsAt: row.graceEndsAt?.toISOString() ?? null,
  };
}

function toInvoiceView(row: typeof invoices.$inferSelect): InvoiceView {
  const total = toBigIntAmount(row.totalMinor);
  const paid = toBigIntAmount(row.amountPaidMinor);
  return {
    id: row.id,
    invoiceNumber: row.invoiceNumber,
    status: row.status,
    currency: row.currency,
    totalMinor: serializeAmount(total),
    totalDisplay: formatMoney(total, row.currency),
    amountPaidMinor: serializeAmount(paid),
    amountPaidDisplay: formatMoney(paid, row.currency),
    issuedAt: row.issuedAt?.toISOString() ?? null,
    dueAt: row.dueAt?.toISOString() ?? null,
    paidAt: row.paidAt?.toISOString() ?? null,
    hostedInvoiceUrl: row.hostedInvoiceUrl,
  };
}
