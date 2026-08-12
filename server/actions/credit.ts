"use server";

/**
 * Ordence — ⭐ Credit Control Actions
 * Version: v0.89.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION, AND NO EXPORT TAKES A TENANT.
 *
 * Schemas live in `lib/validators/credit.ts`, arithmetic in
 * `lib/credit/exposure.ts`, database reads in `server/credit/position.ts`
 * — which is `import "server-only"` precisely because its functions DO
 * take a tenant id, and a `"use server"` export that does the same is a
 * browser-reachable way past row-level security. Phase 47 shipped exactly
 * that bug in `server/actions/notifications.ts`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHAT A CREDIT LIMIT IS FOR, WHICH DECIDES HOW THIS FILE BEHAVES
 * ══════════════════════════════════════════════════════════════════════
 * It is not a lock. It is a threshold above which a second person looks.
 * Nothing in this file refuses an order; the credit check returns
 * `approval_required` and `confirmOrder` routes the order to
 * `pending_approval`, where somebody with `sales.orders.approve_credit`
 * can release it.
 *
 * A credit system that says "no" gets switched off in the first week,
 * because the answer a business actually needs at the counter is "not
 * until somebody senior looks", and there is nobody senior at the
 * counter.
 */

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withTenant } from "@/db";
import { customerCreditProfiles, approvalLimits } from "@/db/schema/credit";
import { companies } from "@/db/schema/crm";
import { writeAudit, requirePermission } from "@/server/audit";
import { guardSalesWrite, salesFail, toSalesActionError } from "@/server/sales/guards";
import { loadCreditProfile, loadExposureOrders } from "@/server/credit/position";
import { companyExposure, assessCredit } from "@/lib/credit/exposure";
import {
  creditPositionSchema,
  removeApprovalLimitSchema,
  setApprovalLimitSchema,
  setCreditHoldSchema,
  setCreditTermsSchema,
} from "@/lib/validators/credit";
import { serializeAmount } from "@/lib/billing/money";
import type { ActionResult } from "@/lib/validators/crm";

const FEATURE_ORDERS = "sales.orders" as const;

/* ================================================================== */
/* SET TERMS                                                           */
/* ================================================================== */

/**
 * Set or clear a customer's credit limit and payment terms.
 *
 * ⚠️ UPSERT, NOT INSERT-OR-FAIL. The absence of a profile row means the
 * same as a NULL limit — no ceiling — so no workspace has rows to seed
 * and the first person to set a limit on a customer must not be told the
 * customer "has no credit profile", which is true and useless.
 *
 * ⚠️ AND `in` RATHER THAN TRUTHINESS, THROUGHOUT. `0` is a real,
 * deliberate credit limit meaning "every order to approval", and `0` is
 * falsy. A `if (data.creditLimitMinor)` here would silently refuse to
 * ever set that value — the one setting whose whole purpose is to be
 * unmissable.
 */
export async function setCreditTerms(
  input: unknown,
): Promise<ActionResult<{ companyId: string }>> {
  try {
    const data = setCreditTermsSchema.parse(input);
    const ctx = await guardSalesWrite({
      operation: "credit:manage",
      feature: FEATURE_ORDERS,
      permission: "sales.credit.manage",
      resource: { type: "company", id: data.companyId },
    });

    await withTenant(
      ctx.tenant.id,
      async (tx) => {
        /**
         * ⚠️ THE COMPANY IS CHECKED WITH BOTH ID AND TENANT PREDICATES.
         * Fetching by id alone would be the IDOR — row-level security
         * would still refuse it, but a refusal from RLS is a 500 and a
         * refusal from here is a sentence.
         */
        const [company] = await tx
          .select({ id: companies.id, name: companies.name })
          .from(companies)
          .where(and(eq(companies.tenantId, ctx.tenant.id), eq(companies.id, data.companyId)))
          .limit(1);

        if (!company) throw new Error("That customer no longer exists.");

        const before = await loadCreditProfile(tx, ctx.tenant.id, data.companyId);

        const changes: Record<string, unknown> = { updatedBy: ctx.user.id, updatedAt: new Date() };
        if ("creditLimitMinor" in data) changes.creditLimitMinor = data.creditLimitMinor ?? null;
        if ("paymentTermsDays" in data) changes.paymentTermsDays = data.paymentTermsDays ?? null;

        await tx
          .insert(customerCreditProfiles)
          .values({
            tenantId: ctx.tenant.id,
            companyId: data.companyId,
            creditLimitMinor: ("creditLimitMinor" in data ? data.creditLimitMinor : null) ?? null,
            paymentTermsDays: ("paymentTermsDays" in data ? data.paymentTermsDays : null) ?? null,
            createdBy: ctx.user.id,
            updatedBy: ctx.user.id,
          })
          .onConflictDoUpdate({
            target: [customerCreditProfiles.tenantId, customerCreditProfiles.companyId],
            set: changes,
          });

        /**
         * ⭐ THE AUDIT ENTRY CARRIES THE OLD LIMIT AS WELL AS THE NEW.
         *
         * "Who raised this customer's limit, from what, and when" is the
         * first question asked in a bad-debt review, and it is
         * unanswerable from a log that records only the value that won.
         */
        await writeAudit(ctx, {
          action: "update",
          resourceType: "customer_credit_profile",
          resourceId: data.companyId,
          oldValue: before
            ? {
                creditLimitMinor: serializeAmount(before.creditLimitMinor),
                onHold: before.onHold,
              }
            : { creditLimitMinor: null, onHold: false },
          newValue: {
            company: company.name,
            creditLimitMinor:
              "creditLimitMinor" in data ? serializeAmount(data.creditLimitMinor) : "unchanged",
            paymentTermsDays:
              "paymentTermsDays" in data ? (data.paymentTermsDays ?? null) : "unchanged",
            note: data.note ?? null,
          },
          severity: "warning",
        });
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath(`/crm/companies/${data.companyId}`);
    revalidatePath("/orders");
    return { ok: true, data: { companyId: data.companyId } };
  } catch (err) {
    return toSalesActionError(err, "setCreditTerms");
  }
}

/* ================================================================== */
/* HOLD                                                                */
/* ================================================================== */

/**
 * Place or lift a credit hold.
 *
 * ⚠️ A HOLD IS NOT A ZERO LIMIT, AND THIS ACTION NEVER TOUCHES THE
 * LIMIT. Zero is a credit decision; a hold is an operational one — a
 * cheque bounced, a dispute is open — and it is meant to be lifted.
 * Keeping them apart means lifting a hold does not require anybody to
 * remember what the limit used to be.
 */
export async function setCreditHold(
  input: unknown,
): Promise<ActionResult<{ companyId: string; onHold: boolean }>> {
  try {
    const data = setCreditHoldSchema.parse(input);
    const ctx = await guardSalesWrite({
      operation: "credit:manage",
      feature: FEATURE_ORDERS,
      permission: "sales.credit.manage",
      resource: { type: "company", id: data.companyId },
    });

    await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [company] = await tx
          .select({ id: companies.id, name: companies.name })
          .from(companies)
          .where(and(eq(companies.tenantId, ctx.tenant.id), eq(companies.id, data.companyId)))
          .limit(1);

        if (!company) throw new Error("That customer no longer exists.");

        const reason = data.onHold ? data.reason : null;

        await tx
          .insert(customerCreditProfiles)
          .values({
            tenantId: ctx.tenant.id,
            companyId: data.companyId,
            onHold: data.onHold,
            holdReason: reason,
            createdBy: ctx.user.id,
            updatedBy: ctx.user.id,
          })
          .onConflictDoUpdate({
            target: [customerCreditProfiles.tenantId, customerCreditProfiles.companyId],
            set: {
              onHold: data.onHold,
              holdReason: reason,
              updatedBy: ctx.user.id,
              updatedAt: new Date(),
            },
          });

        await writeAudit(ctx, {
          action: "update",
          resourceType: "customer_credit_profile",
          resourceId: data.companyId,
          newValue: {
            company: company.name,
            onHold: data.onHold,
            reason,
          },
          /**
           * ⚠️ `critical`, NOT `warning`. Placing a hold stops a
           * customer trading with this workspace entirely. Whatever
           * severity threshold a workspace has set its alerts to, this
           * should be above it.
           */
          severity: "critical",
        });
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath(`/crm/companies/${data.companyId}`);
    revalidatePath("/orders");
    return { ok: true, data: { companyId: data.companyId, onHold: data.onHold } };
  } catch (err) {
    return toSalesActionError(err, "setCreditHold");
  }
}

/* ================================================================== */
/* ⚠️ THERE IS NO deleteCreditProfile, AND THAT IS THE FEATURE           */
/* ================================================================== */

/**
 * Clearing a limit is `setCreditTerms({ creditLimitMinor: null })`.
 * Lifting a hold is `setCreditHold({ onHold: false })`. Between them
 * they restore a customer to the exact state of having no profile at
 * all, and they both leave an audit row saying who did it.
 *
 * ⚠️ DELETING THE ROW WOULD DO THE SAME THING AND ERASE THE HISTORY.
 * "This customer was on hold for four months last year" is the single
 * most useful fact in a credit review, and a delete makes it
 * unrecoverable while looking like tidying up.
 *
 * The database GRANT deliberately still includes DELETE — see
 * `SQL-FILES/0048_credit_limits.sql`. Withholding the privilege would
 * enforce the same rule and produce `permission denied for table
 * customer_credit_profiles`, a sentence written for a DBA and surfaced
 * to a salesperson. A product rule belongs where it can say something
 * useful, and the useful thing to say is the paragraph above.
 */

/* ================================================================== */
/* APPROVAL LIMITS                                                     */
/* ================================================================== */

/**
 * Set what a role may approve, and up to what value.
 *
 * ⚠️ `maxValueMinor: null` MEANS UNLIMITED IN THAT SCOPE, not "may
 * approve nothing". Removing the authority is `removeApprovalLimit`.
 */
export async function setApprovalLimit(
  input: unknown,
): Promise<ActionResult<{ role: string; scope: string }>> {
  try {
    const data = setApprovalLimitSchema.parse(input);
    /**
     * ⚠️ GATED ON `roles:manage`, NOT `sales.credit.manage`.
     *
     * This is not a credit decision — it is a grant of authority to a
     * role, which is the same kind of act as editing the role itself. An
     * accountant who could raise their own approval ceiling has no
     * ceiling.
     */
    const ctx = await guardSalesWrite({
      operation: "roles:manage",
      feature: FEATURE_ORDERS,
      permission: "roles:manage",
      resource: { type: "role", id: data.role },
    });

    await withTenant(
      ctx.tenant.id,
      async (tx) => {
        /**
         * ⚠️ NO EXISTENCE CHECK, AND NONE IS POSSIBLE OR NEEDED. The role
         * is not a row — it is one of the nine values of the `system_role`
         * enum, and Zod has already rejected anything else. A lookup here
         * would query the `roles` table, which nothing populates, and
         * would refuse every valid role.
         */
        await tx
          .insert(approvalLimits)
          .values({
            tenantId: ctx.tenant.id,
            role: data.role,
            scope: data.scope,
            maxValueMinor: data.maxValueMinor ?? null,
            createdBy: ctx.user.id,
            updatedBy: ctx.user.id,
          })
          .onConflictDoUpdate({
            target: [approvalLimits.tenantId, approvalLimits.role, approvalLimits.scope],
            set: {
              maxValueMinor: data.maxValueMinor ?? null,
              updatedBy: ctx.user.id,
              updatedAt: new Date(),
            },
          });

        await writeAudit(ctx, {
          action: "update",
          resourceType: "approval_limit",
          resourceId: `${data.role}:${data.scope}`,
          newValue: {
            role: data.role,
            scope: data.scope,
            maxValueMinor:
              data.maxValueMinor === null || data.maxValueMinor === undefined
                ? "unlimited"
                : serializeAmount(data.maxValueMinor),
          },
          severity: "critical",
        });
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/settings/roles");
    return { ok: true, data: { role: data.role, scope: data.scope } };
  } catch (err) {
    return toSalesActionError(err, "setApprovalLimit");
  }
}

/**
 * Remove a role's authority in a scope entirely.
 *
 * ⚠️ THIS IS THE ONLY DELETE IN THE FILE, AND IT IS RIGHT HERE WHERE THE
 * CREDIT PROFILE'S DELETE WAS REFUSED. The difference is what the row
 * means: a credit profile is a record of how a customer was treated, and
 * an approval limit is a live grant of authority. History is worth
 * keeping; a stale grant of the power to sign is not.
 */
export async function removeApprovalLimit(
  input: unknown,
): Promise<ActionResult<{ role: string; scope: string }>> {
  try {
    const data = removeApprovalLimitSchema.parse(input);
    const ctx = await guardSalesWrite({
      operation: "roles:manage",
      feature: FEATURE_ORDERS,
      permission: "roles:manage",
      resource: { type: "role", id: data.role },
      impersonationOperation: "delete:approval_limit",
    });

    await withTenant(
      ctx.tenant.id,
      async (tx) => {
        await tx
          .delete(approvalLimits)
          .where(
            and(
              eq(approvalLimits.tenantId, ctx.tenant.id),
              eq(approvalLimits.role, data.role),
              eq(approvalLimits.scope, data.scope),
            ),
          );

        await writeAudit(ctx, {
          action: "delete",
          resourceType: "approval_limit",
          resourceId: `${data.role}:${data.scope}`,
          oldValue: { scope: data.scope },
          severity: "critical",
        });
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/settings/roles");
    return { ok: true, data: { role: data.role, scope: data.scope } };
  } catch (err) {
    return toSalesActionError(err, "removeApprovalLimit");
  }
}

/* ================================================================== */
/* READ                                                                */
/* ================================================================== */

/**
 * A customer's whole credit position, for the panel on their record.
 *
 * ⚠️ READ PATH, SO `requirePermission` ALONE — no access gate and no
 * entitlement gate. Phase 12 put entitlement gates on three read
 * functions and none of the writes; a gate on a `get*` produces the
 * worst upgrade prompt there is, a page that will not render rather than
 * a page that renders and refuses the button.
 *
 * ⚠️ MONEY LEAVES AS A STRING. `JSON.stringify` throws on a bigint, and
 * every amount here is one.
 */
export async function getCreditPosition(input: unknown): Promise<
  ActionResult<{
    companyId: string;
    creditLimitMinor: string | null;
    paymentTermsDays: number | null;
    onHold: boolean;
    holdReason: string | null;
    exposureMinor: string;
    headroomMinor: string | null;
    contributingOrders: number;
    message: string;
  }>
> {
  try {
    const data = creditPositionSchema.parse(input);
    const ctx = await requirePermission("sales.credit.read", {
      type: "company",
      id: data.companyId,
    });

    const result = await withTenant(ctx.tenant.id, async (tx) => {
      const profile = await loadCreditProfile(tx, ctx.tenant.id, data.companyId);

      /**
       * ⚠️ `paymentTermsDays` IS READ SEPARATELY AND ON PURPOSE. It is
       * not part of `CreditProfileFacts`, because `assessCredit()` must
       * not be able to see it — terms decide WHEN money is due, and this
       * limit is about HOW MUCH is outstanding. Widening the facts type
       * to carry it would be an invitation to start netting off
       * not-yet-due amounts, which is how a limit stops catching the
       * order that breaks the customer.
       */
      const [terms] = await tx
        .select({ paymentTermsDays: customerCreditProfiles.paymentTermsDays })
        .from(customerCreditProfiles)
        .where(
          and(
            eq(customerCreditProfiles.tenantId, ctx.tenant.id),
            eq(customerCreditProfiles.companyId, data.companyId),
          ),
        )
        .limit(1);
      const orders = await loadExposureOrders(tx, ctx.tenant.id, data.companyId);
      const exposure = companyExposure(orders);

      /**
       * ⭐ THE PANEL ASKS THE SAME QUESTION THE ORDER PATH ASKS, with a
       * new-order value of zero. One definition of the answer, so the
       * number on the customer's record and the number that blocks an
       * order can never differ.
       */
      const decision = assessCredit({ profile, orders, newOrderTotalMinor: 0n });

      return {
        companyId: data.companyId,
        creditLimitMinor:
          profile?.creditLimitMinor === null || profile?.creditLimitMinor === undefined
            ? null
            : serializeAmount(profile.creditLimitMinor),
        paymentTermsDays: terms?.paymentTermsDays ?? null,
        onHold: profile?.onHold ?? false,
        holdReason: profile?.holdReason ?? null,
        exposureMinor: serializeAmount(exposure.exposureMinor),
        headroomMinor:
          decision.headroomMinor === null ? null : serializeAmount(decision.headroomMinor),
        contributingOrders: exposure.contributingOrders,
        message: decision.message,
      };
    });

    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "getCreditPosition");
  }
}
