import "server-only";

/**
 * Ordence — Credit position (internal)
 * Version: v0.89.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS IS NOT IN `server/actions/`
 * ══════════════════════════════════════════════════════════════════════
 * Phase 47 removed `createNotification` from a `"use server"` file for
 * taking `tenantId` from its caller — every export of such a file is a
 * browser-reachable RPC endpoint, and one that accepts the tenant to
 * operate on is the single route past row-level security.
 *
 * These functions take BOTH a `tenantId` AND an open transaction,
 * because `confirmOrder` has to run the credit check inside the same
 * transaction that writes the order. `import "server-only"` is what
 * makes that safe: the module cannot be reached from a browser at all,
 * and `check:boundaries` enforces the declaration.
 *
 * ⚠️ THE FIX IS THE FILE THEY ARE IN, NOT A CHECK INSIDE THEM.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ AND WHY THE CHECK MUST SHARE THE CALLER'S TRANSACTION
 * ══════════════════════════════════════════════════════════════════════
 * Reading exposure on one connection and confirming the order on another
 * is a race with real money in it: two reps confirm two orders for the
 * same customer in the same second, each reads an exposure that does not
 * include the other, and both pass a limit that neither should. Passing
 * `tx` in means the read happens inside the write's transaction, under
 * the same tenant setting, and the row lock the update takes is the
 * thing that serialises them.
 */

import { and, eq, inArray } from "drizzle-orm";
import { customerCreditProfiles, approvalLimits } from "@/db/schema/credit";
import { salesOrders } from "@/db/schema/orders";
import {
  assessCredit,
  mayApprove,
  EXPOSURE_EXCLUDED_STATUSES,
  type CreditDecision,
  type CreditProfileFacts,
  type OrderExposureFact,
} from "@/lib/credit/exposure";
import { toBigIntAmount } from "@/lib/billing/money";
import type { withTenant } from "@/db";
import type { ApprovalScope } from "@/lib/validators/credit";
import type { SystemRole } from "@/db/schema/core";

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

/**
 * Every status that counts toward exposure — the complement of the
 * excluded list, stated once so the SQL and the arithmetic cannot drift.
 *
 * ⚠️ DERIVED FROM THE ENUM, NOT RETYPED. A hand-written list here would
 * silently stop counting a status the day one is added to
 * `sales_order_status`, and the failure mode is a credit limit that
 * quietly under-counts rather than an error anybody sees.
 */
type OrderStatusValue = (typeof salesOrders.status.enumValues)[number];

const COUNTED_STATUSES: readonly OrderStatusValue[] = salesOrders.status.enumValues.filter(
  (s) => !EXPOSURE_EXCLUDED_STATUSES.includes(s),
);

/**
 * The credit profile for one company, or `null` if none exists.
 *
 * ⚠️ `null` HERE MEANS "NO ROW", WHICH MEANS "NO CEILING" — the same as a
 * row with a NULL limit. Nothing has to be seeded for existing
 * customers, and `assessCredit` treats the two identically on purpose.
 */
export async function loadCreditProfile(
  tx: Tx,
  tenantId: string,
  companyId: string,
): Promise<CreditProfileFacts> {
  const [row] = await tx
    .select({
      creditLimitMinor: customerCreditProfiles.creditLimitMinor,
      onHold: customerCreditProfiles.onHold,
      holdReason: customerCreditProfiles.holdReason,
    })
    .from(customerCreditProfiles)
    .where(
      and(
        eq(customerCreditProfiles.tenantId, tenantId),
        eq(customerCreditProfiles.companyId, companyId),
      ),
    )
    .limit(1);

  if (!row) return null;
  return {
    creditLimitMinor:
      row.creditLimitMinor === null ? null : toBigIntAmount(row.creditLimitMinor),
    onHold: row.onHold,
    holdReason: row.holdReason,
  };
}

/**
 * Every order that counts toward a company's exposure.
 *
 * ⚠️ `excludeOrderId` IS NOT AN OPTIMISATION. `confirmOrder` calls this
 * while confirming an order that is still `pending_approval` or `draft`
 * — so it would be excluded by status anyway today. It is passed
 * explicitly because the day somebody makes confirm legal from another
 * status, the order would be counted twice: once in the exposure and
 * once as `newOrderTotalMinor`, and the customer would appear to be at
 * double their real position with no error anywhere.
 */
export async function loadExposureOrders(
  tx: Tx,
  tenantId: string,
  companyId: string,
  excludeOrderId?: string,
): Promise<OrderExposureFact[]> {
  const rows = await tx
    .select({
      id: salesOrders.id,
      orderNo: salesOrders.orderNo,
      status: salesOrders.status,
      totalMinor: salesOrders.totalMinor,
      receivedValueMinor: salesOrders.receivedValueMinor,
    })
    .from(salesOrders)
    .where(
      and(
        eq(salesOrders.tenantId, tenantId),
        eq(salesOrders.companyId, companyId),
        inArray(salesOrders.status, COUNTED_STATUSES),
      ),
    );

  /**
   * ⚠️ `toBigIntAmount` ON BOTH MONEY COLUMNS, NOT A CAST. Drizzle returns
   * `mode: "bigint"` columns as strings on the HTTP driver path and as
   * bigints on the WebSocket one. A raw value reaching `orderExposure()`
   * as a string makes `total - received` a string subtraction, and the
   * arithmetic fails loudly on a good day and silently on a bad one.
   */
  const facts: OrderExposureFact[] = rows.map((r) => ({
    id: r.id,
    orderNo: r.orderNo,
    status: r.status,
    totalMinor: toBigIntAmount(r.totalMinor),
    receivedValueMinor: toBigIntAmount(r.receivedValueMinor),
  }));

  return excludeOrderId ? facts.filter((r) => r.id !== excludeOrderId) : facts;
}

/**
 * ⭐ THE ONE ENTRY POINT. Everything that asks "may this order go
 * through" comes here, so there is exactly one definition of the answer.
 */
export async function assessOrderCredit(args: {
  tx: Tx;
  tenantId: string;
  companyId: string;
  orderId: string;
  orderTotalMinor: bigint;
}): Promise<CreditDecision> {
  const [profile, orders] = await Promise.all([
    loadCreditProfile(args.tx, args.tenantId, args.companyId),
    loadExposureOrders(args.tx, args.tenantId, args.companyId, args.orderId),
  ]);

  return assessCredit({
    profile,
    orders,
    newOrderTotalMinor: args.orderTotalMinor,
  });
}

/**
 * May this role approve a value in this scope?
 *
 * ⚠️ NO ROW MEANS NO AUTHORITY, and the query returning nothing is the
 * ordinary case rather than an error. A workspace that has configured no
 * approval limits has granted nobody the power to override a credit
 * limit — which is the safe default, and the message says how to change
 * it rather than just refusing.
 */
export async function assessApprovalAuthority(args: {
  tx: Tx;
  tenantId: string;
  role: SystemRole;
  scope: ApprovalScope;
  valueMinor: bigint;
}): Promise<{ allowed: boolean; message: string }> {
  const [row] = await args.tx
    .select({ maxValueMinor: approvalLimits.maxValueMinor })
    .from(approvalLimits)
    .where(
      and(
        eq(approvalLimits.tenantId, args.tenantId),
        eq(approvalLimits.role, args.role),
        eq(approvalLimits.scope, args.scope),
      ),
    )
    .limit(1);

  return mayApprove({
    limit: row
      ? { maxValueMinor: row.maxValueMinor === null ? null : toBigIntAmount(row.maxValueMinor) }
      : null,
    valueMinor: args.valueMinor,
  });
}
