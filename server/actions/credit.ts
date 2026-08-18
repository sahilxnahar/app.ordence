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

import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withTenant } from "@/db";
import {
  approvalLimits,
  creditDunningLog,
  creditHoldEvents,
  creditHoldOverrides,
  customerCreditProfiles,
} from "@/db/schema/credit";
import { companies } from "@/db/schema/crm";
import { salesOrders } from "@/db/schema/orders";
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
/* 🔴 Batch 40 — holds as events, overrides, and the dunning ladder. */
import {
  creditBoardSchema,
  placeCreditHoldSchema,
  recordCreditHoldOverrideSchema,
  releaseCreditHoldSchema,
  runDunningSweepSchema,
} from "@/lib/credit/validators";
import {
  creditHeadroom,
  reconcileCreditPosition,
  EXPOSURE_SCOPE_NOTE,
} from "@/lib/credit/headroom";
import { assessAutoHold } from "@/lib/credit/hold";
import { describeSweep, planDunning } from "@/lib/credit/dunning";
import { loadActiveHold } from "@/lib/credit/enforce";
import {
  loadChaseableInvoices,
  loadCreditSubjects,
  loadDunningLadder,
  loadInvoiceFacts,
  loadOrderCommitments,
  loadRecordedDunning,
} from "@/lib/credit/queries";
import {
  serializeReconciliation,
  type SerializedReconciliation,
} from "@/lib/reconciliation/gate";
import { todayInIndia } from "@/lib/accounting/periods";
import { formatMoney, serializeAmount, toBigIntAmount } from "@/lib/billing/money";
/**
 * ⭐⭐ THE DRAIN THAT DID NOT EXIST. See the header of `runDunningSweep`
 * below: this file wrote letters into a queue and nothing emptied it.
 */
import { enqueueEmail } from "@/server/email/outbox";
import { renderDunningLetterEmail } from "@/lib/email/templates";
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

/* ================================================================== */
/* 🔴 BATCH 40 — HOLDS AS EVENTS, OVERRIDES, AND THE DUNNING SWEEP     */
/* ================================================================== */

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ EVERY EXPORT BELOW IS A BROWSER-REACHABLE RPC ENDPOINT, and every
 * one of them reaches a TIER-2 guard in ONE hop — `guardSalesWrite` for
 * the writes, `requirePermission` for the read. `check:guards` walks one
 * hop only, and a guard two calls deep is a guard the checker cannot see
 * and an attacker does not have to pass.
 *
 * ⚠️ AND NO EXPORT TAKES A TENANT. The database reads live in
 * `lib/credit/queries.ts`, which is `import "server-only"` precisely
 * because its functions DO take one.
 * ══════════════════════════════════════════════════════════════════════
 */

/**
 * Place a MANUAL credit hold.
 *
 * 🔴 THIS IS THE WRITE THAT STOPS ORDERS. `confirmOrder` reads the row
 * this inserts, inside its own transaction, and throws. It is not a
 * routing decision and it does not put anything in an approval queue —
 * see the header of `lib/credit/hold.ts` for why a hold refuses where an
 * over-limit order does not.
 *
 * ⚠️ IT IS AN INSERT, NOT AN UPDATE OF A BOOLEAN. 0048's
 * `customer_credit_profiles.on_hold` is now a mirror maintained by a
 * trigger; writing it directly would be silently reverted by the next
 * hold event on that customer, which works in testing and drifts in
 * production.
 *
 * ⚠️ `ON CONFLICT DO NOTHING` AGAINST THE PARTIAL UNIQUE INDEX. Two
 * people pressing "hold" on the same stale screen must not produce two
 * holds, and the second one must not see an error — the account is on
 * hold, which is what they wanted.
 */
export async function placeCreditHold(
  input: unknown,
): Promise<ActionResult<{ companyId: string; alreadyHeld: boolean }>> {
  try {
    const data = placeCreditHoldSchema.parse(input);
    const ctx = await guardSalesWrite({
      operation: "credit:manage",
      feature: FEATURE_ORDERS,
      permission: "sales.credit.manage",
      resource: { type: "company", id: data.companyId },
    });

    const outcome = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [company] = await tx
          .select({ id: companies.id, name: companies.name })
          .from(companies)
          .where(and(eq(companies.tenantId, ctx.tenant.id), eq(companies.id, data.companyId)))
          .limit(1);
        if (!company) throw new Error("That customer no longer exists.");

        const existing = await loadActiveHold(tx, ctx.tenant.id, data.companyId);

        /**
         * ⭐ THE FIGURES AS THEY STAND, RECORDED ON THE HOLD. "He was
         * ₹40,000 over when we stopped him" is the fact a bad-debt review
         * needs, and it is unrecoverable six months later from a table
         * whose numbers have moved on.
         */
        const position = await computeCreditPosition(tx, ctx.tenant.id, [data.companyId]);
        const mine = position.get(data.companyId) ?? null;

        const inserted = await tx
          .insert(creditHoldEvents)
          .values({
            tenantId: ctx.tenant.id,
            companyId: data.companyId,
            source: "manual",
            reason: data.reason,
            placedBy: ctx.user.id,
            exposureAtHoldMinor: mine?.exposure.totalMinor ?? null,
            limitAtHoldMinor: mine?.limitMinor ?? null,
          })
          .onConflictDoNothing()
          .returning({ id: creditHoldEvents.id });

        await writeAudit(ctx, {
          action: "create",
          resourceType: "credit_hold",
          resourceId: data.companyId,
          newValue: {
            company: company.name,
            source: "manual",
            reason: data.reason,
            alreadyHeld: existing !== null,
          },
          /**
           * ⚠️ `critical`, NOT `warning`. Placing a hold stops a customer
           * trading with this workspace entirely. Whatever severity
           * threshold a workspace has set its alerts to, this is above it.
           */
          severity: "critical",
        });

        return { alreadyHeld: inserted.length === 0 };
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/receivables/credit");
    /**
     * ⚠️ `/companies/[id]/statement`, NOT `/crm/companies/[id]`. The two
     * calls above in `setCreditTerms` and `setCreditHold` revalidate a
     * route that does not exist in `app/` — a silent no-op, so the
     * customer's own screen keeps a stale hold badge until it is
     * reloaded. Reported rather than fixed here: those lines belong to
     * v0.89.0's surface and changing them is not this batch's diff.
     */
    revalidatePath(`/companies/${data.companyId}/statement`);
    revalidatePath("/orders");
    return { ok: true, data: { companyId: data.companyId, alreadyHeld: outcome.alreadyHeld } };
  } catch (err) {
    return toSalesActionError(err, "placeCreditHold");
  }
}

/**
 * Lift a hold.
 *
 * ⚠️ IT TAKES THE HOLD ID, NOT THE COMPANY. Two people on the same stale
 * screen would otherwise both "lift the hold", and the second would
 * silently lift a DIFFERENT hold placed in between — for a different
 * reason, by somebody else, thirty seconds ago.
 *
 * ⚠️ THE UPDATE CARRIES `isNull(releasedAt)`. That predicate is the
 * compare-and-set: two concurrent releases both read an open hold, both
 * reach the UPDATE, and exactly one row matches. Without it the second
 * would overwrite the first's `releasedBy` with its own, and the record
 * would name the wrong person.
 */
export async function releaseCreditHold(
  input: unknown,
): Promise<ActionResult<{ holdId: string; released: boolean }>> {
  try {
    const data = releaseCreditHoldSchema.parse(input);
    const ctx = await guardSalesWrite({
      operation: "credit:manage",
      feature: FEATURE_ORDERS,
      permission: "sales.credit.manage",
      resource: { type: "credit_hold", id: data.holdId },
    });

    const released = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const rows = await tx
          .update(creditHoldEvents)
          .set({
            releasedAt: new Date(),
            releasedBy: ctx.user.id,
            releaseReason: data.reason ?? null,
          })
          .where(
            and(
              eq(creditHoldEvents.tenantId, ctx.tenant.id),
              eq(creditHoldEvents.id, data.holdId),
              isNull(creditHoldEvents.releasedAt),
            ),
          )
          .returning({ id: creditHoldEvents.id, companyId: creditHoldEvents.companyId });

        const row = rows[0];

        await writeAudit(ctx, {
          action: "update",
          resourceType: "credit_hold",
          resourceId: data.holdId,
          newValue: {
            released: row !== undefined,
            reason: data.reason ?? null,
            companyId: row?.companyId ?? null,
          },
          severity: "critical",
        });

        return row !== undefined;
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/receivables/credit");
    revalidatePath("/orders");
    return { ok: true, data: { holdId: data.holdId, released } };
  } catch (err) {
    return toSalesActionError(err, "releaseCreditHold");
  }
}

/**
 * 🔴 RECORD AN OVERRIDE SO ONE ORDER MAY GO OUT PAST A HOLD.
 *
 * ⚠️ GATED ON `sales.orders.approve_credit`, NOT `sales.credit.manage`.
 *
 * This is not credit administration — it is the act of overruling a
 * refusal, which is the same kind of act as approving an order over its
 * limit and belongs to the same people. A salesperson who could both
 * place and override a hold has neither.
 *
 * ⚠️ THE ACTOR IS THE SESSION AND CAN NEVER BE AN ARGUMENT. A field
 * naming the actor is a field an attacker fills in with somebody senior,
 * and the record then carries a signature that person never gave.
 *
 * ⭐ IT RECORDS; IT DOES NOT CONFIRM. The order still has to be
 * confirmed, by whoever confirms orders, and `confirmOrder` consumes
 * this row inside its own transaction. Splitting the two means the
 * signature exists before the shipment does, in that order, which is the
 * order a reviewer will read them in.
 */
export async function recordCreditHoldOverride(
  input: unknown,
): Promise<ActionResult<{ orderId: string; overrideId: string }>> {
  try {
    const data = recordCreditHoldOverrideSchema.parse(input);
    const ctx = await guardSalesWrite({
      operation: "orders:approve_credit",
      feature: FEATURE_ORDERS,
      permission: "sales.orders.approve_credit",
      resource: { type: "sales_order", id: data.orderId },
    });

    const outcome = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [order] = await tx
          .select({
            id: salesOrders.id,
            orderNo: salesOrders.orderNo,
            companyId: salesOrders.companyId,
          })
          .from(salesOrders)
          .where(and(eq(salesOrders.tenantId, ctx.tenant.id), eq(salesOrders.id, data.orderId)))
          .limit(1);

        if (!order) throw new Error("That order no longer exists.");
        if (!order.companyId) {
          throw new Error(
            "This order has no customer account on it, so there is no hold to override. A counter sale with no company record cannot run up an account.",
          );
        }

        const hold = await loadActiveHold(tx, ctx.tenant.id, order.companyId);
        if (!hold) {
          /**
           * ⚠️ REFUSED RATHER THAN RECORDED. An override written against
           * a customer who is not on hold is a signature waiting for a
           * hold to be placed later — it would sit there and release the
           * first refusal that came along, weeks after the person who
           * signed it stopped thinking about this order.
           */
          throw new Error(
            `${order.orderNo} does not need an override — this customer is not on hold. If the order is over its credit limit, that is an approval, not an override.`,
          );
        }

        const position = await computeCreditPosition(tx, ctx.tenant.id, [order.companyId]);
        const mine = position.get(order.companyId) ?? null;

        const [row] = await tx
          .insert(creditHoldOverrides)
          .values({
            tenantId: ctx.tenant.id,
            companyId: order.companyId,
            orderId: order.id,
            holdEventId: hold.id,
            actorUserId: ctx.user.id,
            reason: data.reason,
            exposureAtOverrideMinor: mine?.exposure.totalMinor ?? null,
            limitAtOverrideMinor: mine?.limitMinor ?? null,
          })
          .returning({ id: creditHoldOverrides.id });

        if (!row) throw new Error("The override could not be written.");

        await writeAudit(ctx, {
          action: "create",
          resourceType: "credit_hold_override",
          resourceId: order.id,
          newValue: {
            orderNo: order.orderNo,
            holdReason: hold.reason,
            reason: data.reason,
            exposureMinor: mine ? serializeAmount(mine.exposure.totalMinor) : null,
          },
          severity: "critical",
        });

        return { overrideId: row.id };
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/receivables/credit");
    revalidatePath(`/orders/${data.orderId}`);
    return { ok: true, data: { orderId: data.orderId, overrideId: outcome.overrideId } };
  } catch (err) {
    return toSalesActionError(err, "recordCreditHoldOverride");
  }
}

/* ================================================================== */
/* THE DUNNING SWEEP                                                   */
/* ================================================================== */

/**
 * ⭐⭐ WORK OUT WHICH REMINDERS ARE DUE AND RECORD THEM.
 *
 * 🔴 IT STILL QUEUES. IT STILL DOES NOT SEND — AND NOW SOMETHING EMPTIES
 * THE QUEUE. This header used to read "there is no SMTP call, no Resend
 * call and no webhook anywhere below", and that was true of the whole
 * product, not only of this function. The letters were written with
 * `delivery: "queued"` and stayed there forever. The screen said a
 * reminder had been recorded; the customer received nothing; the invoice
 * aged; the owner believed they were chasing money they were not
 * chasing.
 *
 * ⚠️ THE FIX IS NOT A `send()` IN THIS FUNCTION, AND THAT IS THE POINT.
 * A sweep that mails inline is a sweep that dies on invoice 40 of 300
 * with 39 letters gone and no record of which, then reruns from the top.
 * The queue was always right. What was missing was the drain.
 *
 * ⭐ SO EACH ACTIONED EMAIL RUNG ALSO GETS AN `email_outbox` ROW, in THIS
 * transaction, and `server/email/outbox.ts` sends it and writes `sent`
 * or `failed` back onto the dunning row. Recording `sent` here because
 * the row is "about to" go out would produce a collections call opening
 * with "we have written to you three times" against a customer who can
 * prove otherwise.
 *
 * 🔴 ONLY THE ROWS THIS RUN ACTUALLY INSERTED ARE MAILED. The insert is
 * `ON CONFLICT DO NOTHING ... RETURNING`, so a row another container
 * already recorded comes back absent and earns no letter. Enqueueing
 * from `plan.actions` instead would mail a second copy of every reminder
 * every time two sweeps overlapped.
 *
 * 🔴 AND IT IS SAFE TO RUN TWICE. `ON CONFLICT DO NOTHING` against
 * `credit_dunning_log_once_per_stage_key` is the guarantee — not the
 * `alreadyRecorded` set, which is a read-then-write two containers can
 * both pass in the same millisecond.
 */
export async function runDunningSweep(input: unknown): Promise<
  ActionResult<{
    asOf: string;
    queued: number;
    suppressed: number;
    holdsPlaced: number;
    skipped: { invoiceNumber: string; why: string }[];
    summary: string;
    preview: boolean;
  }>
> {
  try {
    const data = runDunningSweepSchema.parse(input);
    const ctx = await guardSalesWrite({
      operation: "credit:manage",
      feature: FEATURE_ORDERS,
      permission: "sales.credit.manage",
    });

    /**
     * 🔴 CLAMPED TO TODAY IN INDIA, NEVER `toISOString()`. India is
     * UTC+5:30, so between midnight and 05:30 IST a UTC date is
     * YESTERDAY — and a sweep that thinks it is yesterday silently fails
     * to fire the stage that came due at midnight.
     *
     * ⚠️ AND A FUTURE `asOf` IS CLAMPED, NOT REJECTED. Rejecting sends
     * somebody to edit an invoice's due date to make the ladder fire,
     * which corrupts the document to fix the job.
     */
    const today = todayInIndia();
    const asOf = data.asOf && data.asOf <= today ? data.asOf : today;
    const preview = data.preview === true;

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const ladder = await loadDunningLadder(tx, ctx.tenant.id, data.ladderId);
        if (!ladder) {
          return {
            asOf,
            queued: 0,
            suppressed: 0,
            holdsPlaced: 0,
            skipped: [] as { invoiceNumber: string; why: string }[],
            summary:
              "No active dunning ladder is configured, so nobody has been chased. A default ladder shipped by us would be the schedule most workspaces chase on, chosen by nobody — set the ages that suit this business.",
            preview,
          };
        }

        const [invoices, alreadyRecorded] = await Promise.all([
          loadChaseableInvoices(tx, ctx.tenant.id),
          loadRecordedDunning(tx, ctx.tenant.id),
        ]);

        const plan = planDunning({
          asOf,
          invoices,
          stages: ladder.stages,
          alreadyRecorded,
        });

        const queued = plan.actions.filter((a) => a.delivery === "queued").length;
        const suppressed = plan.actions.length - queued;
        let holdsPlaced = 0;

        if (!preview && plan.actions.length > 0) {
          const recorded = await tx
            .insert(creditDunningLog)
            .values(
              plan.actions.map((a) => ({
                tenantId: ctx.tenant.id,
                companyId: a.companyId,
                invoiceId: a.invoiceId,
                ladderId: ladder.id,
                stageId: a.stageId,
                stageNo: a.stageNo,
                daysPastDue: a.daysPastDue,
                channel: a.channel,
                templateKey: a.templateKey,
                recipientName: a.recipientName,
                recipientEmail: a.recipientEmail,
                recipientPhone: a.recipientPhone,
                amountDueMinor: a.amountDueMinor,
                delivery: a.delivery,
                failureReason: a.suppressionReason,
                nextActionOn: a.nextActionOn,
                createdBy: ctx.user.id,
              })),
            )
            /**
             * 🔴 THE IDEMPOTENCY GUARANTEE. A quiet no-op on the second
             * run rather than an exception — a sweep that dies on invoice
             * 40 of 300 because another container got there first is a
             * sweep that never finishes.
             *
             * ⭐ AND `RETURNING` TURNS IT INTO A CLAIM. What comes back is
             * exactly the set of rungs THIS run recorded; a rung another
             * container got to first is absent. That set, and only that
             * set, earns a letter below.
             */
            .onConflictDoNothing()
            .returning({
              id: creditDunningLog.id,
              invoiceId: creditDunningLog.invoiceId,
              stageId: creditDunningLog.stageId,
            });

          /*
           * ══════════════════════════════════════════════════════════
           * ⭐⭐ THE LETTERS. THIS IS THE PART THAT DID NOT EXIST.
           * ══════════════════════════════════════════════════════════
           * 🔴 `delivery` STAYS `queued` HERE. The outbox row is the
           * instruction to send; `server/email/outbox.ts` is the only
           * thing that may write `sent`, and only when Resend hands back
           * a message id. Marking it here would be the same lie in a
           * different table.
           *
           * ⚠️ ONLY `channel = "email"` RUNGS. A rung whose channel is
           * `call` or `visit` is a diary entry for a person; queueing an
           * email for it would silently replace the phone call somebody
           * was supposed to make with a letter nobody chose to send.
           *
           * ⚠️ AND ONLY WHERE THERE IS AN ADDRESS. A rung with no
           * recipient email keeps its `queued` row — it is still a
           * chase that is owed — but there is nothing to send it to, and
           * inventing one is worse than the gap.
           */
          const actionByKey = new Map(
            plan.actions.map((a) => [`${a.invoiceId}:${a.stageId}`, a]),
          );

          for (const written of recorded) {
            const action = actionByKey.get(`${written.invoiceId}:${written.stageId}`);
            if (!action) continue;
            if (action.delivery !== "queued") continue;
            if (action.channel !== "email") continue;
            if (!action.recipientEmail) continue;

            const letter = renderDunningLetterEmail({
              recipientName: action.recipientName,
              organizationName: ctx.tenant.name,
              customerName: action.companyName,
              invoiceNumber: action.invoiceNumber,
              amountDue: formatMoney(action.amountDueMinor),
              dueDate: null,
              daysPastDue: action.daysPastDue,
              stageLabel: action.stageLabel,
            });

            await enqueueEmail(tx, {
              tenantId: ctx.tenant.id,
              purpose: "dunning",
              /**
               * ⭐ THE THREAD BACK. The dispatcher writes the outcome
               * onto this exact dunning row, so the collections board
               * stops saying "queued" the moment the letter actually
               * goes — and says "failed", with the reason, when it does
               * not.
               */
              subjectType: "credit_dunning_log",
              subjectId: written.id,
              toEmail: action.recipientEmail,
              subject: letter.subject,
              html: letter.html,
              text: letter.text,
              category: "receivables",
              severity: "warning",
              /**
               * 🔴 DERIVED FROM THE DUNNING ROW, NOT FROM THE CLOCK. It
               * is the same value on a re-run, which is what lets the
               * unique index refuse a second letter for a rung that has
               * already been chased.
               */
              idempotencyKey: `dunning:${written.id}`,
              createdBy: ctx.user.id,
            });
          }

          /**
           * ⭐ THE RUNGS THAT PLACE A HOLD. `ON CONFLICT DO NOTHING`
           * again, against the one-active-hold index: a customer with
           * four invoices reaching the final stage on the same night gets
           * one hold, not four.
           */
          const holdRungs = plan.actions.filter(
            (a) => a.delivery === "queued" && a.placesHold,
          );
          for (const rung of holdRungs) {
            const placed = await tx
              .insert(creditHoldEvents)
              .values({
                tenantId: ctx.tenant.id,
                companyId: rung.companyId,
                source: "automatic",
                reason: `${rung.invoiceNumber} is ${rung.daysPastDue} days past due and reached "${rung.stageLabel}". Placed by the dunning ladder; it will not lift itself.`,
                /**
                 * ⚠️ `placedBy` IS NULL AND THE CHECK CONSTRAINT ALLOWS
                 * IT ONLY FOR `automatic`. The sweep has no user, and
                 * naming the person who pressed the button would put
                 * their signature on a decision the ladder made.
                 */
                exposureAtHoldMinor: null,
                limitAtHoldMinor: null,
              })
              .onConflictDoNothing()
              .returning({ id: creditHoldEvents.id });
            if (placed.length > 0) holdsPlaced += 1;
          }

          await writeAudit(ctx, {
            action: "create",
            resourceType: "dunning_sweep",
            resourceId: ladder.id,
            newValue: {
              ladder: ladder.name,
              asOf,
              queued,
              suppressed,
              holdsPlaced,
              skipped: plan.skipped.length,
            },
            severity: "warning",
          });
        }

        return {
          asOf,
          queued,
          suppressed,
          holdsPlaced,
          skipped: plan.skipped.map((s) => ({
            invoiceNumber: s.invoiceNumber,
            why: s.why,
          })),
          summary: preview
            ? `Preview only — nothing has been written. ${describeSweep(plan)}`
            : describeSweep(plan),
          preview,
        };
      },
      { impersonationId: ctx.impersonationId },
    );

    if (!preview) revalidatePath("/receivables/credit");
    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "runDunningSweep");
  }
}

/* ================================================================== */
/* THE BOARD                                                           */
/* ================================================================== */

/**
 * Every customer whose credit position is worth a second look.
 *
 * ⚠️ READ PATH, SO `requirePermission` ALONE — no entitlement gate. A
 * gate on a `get*` produces the worst upgrade prompt there is: a page
 * that will not render, rather than a page that renders and refuses the
 * button.
 *
 * ⚠️ MONEY LEAVES AS A STRING. `JSON.stringify` throws on a bigint and
 * every amount here is one.
 *
 * 🔴 AND `figures` IS STRUCTURALLY ABSENT WHEN THE RECONCILIATION
 * BREACHES. Not present behind a boolean — absent, so a screen that
 * ignored the gate would fail to compile rather than quietly print an
 * unverified ceiling.
 */
export async function getCreditControlBoard(input: unknown): Promise<
  ActionResult<{
    rows: {
      companyId: string;
      companyName: string;
      limitMinor: string | null;
      exposureMinor: string;
      billedMinor: string;
      unbilledMinor: string;
      figures: { headroomMinor: string | null; overLimit: boolean } | null;
      onHold: boolean;
      holdId: string | null;
      holdSource: "manual" | "automatic" | null;
      holdReason: string | null;
      autoHoldEnabled: boolean;
      autoHoldNote: string;
      reconciliation: SerializedReconciliation;
    }[];
    scopeNote: string;
  }>
> {
  try {
    creditBoardSchema.parse(input ?? {});
    const ctx = await requirePermission("sales.credit.read");

    const rows = await withTenant(ctx.tenant.id, async (tx) => {
      const subjects = await loadCreditSubjects(tx, ctx.tenant.id);
      const position = await computeCreditPosition(
        tx,
        ctx.tenant.id,
        subjects.map((s) => s.companyId),
        subjects,
      );

      return subjects.map((s) => {
        const p = position.get(s.companyId);
        const headroom = p?.headroom ?? null;
        const auto = assessAutoHold({
          autoHoldEnabled: s.autoHoldEnabled,
          activeHold: s.activeHold,
          limitMinor: s.creditLimitMinor,
          exposureMinor: p?.exposure.totalMinor ?? 0n,
        });

        return {
          companyId: s.companyId,
          companyName: s.companyName,
          limitMinor: s.creditLimitMinor === null ? null : serializeAmount(s.creditLimitMinor),
          exposureMinor: serializeAmount(p?.exposure.totalMinor ?? 0n),
          billedMinor: serializeAmount(p?.exposure.billedMinor ?? 0n),
          unbilledMinor: serializeAmount(p?.exposure.unbilledMinor ?? 0n),
          figures:
            headroom?.figures == null
              ? null
              : {
                  headroomMinor:
                    headroom.figures.headroomMinor === null
                      ? null
                      : serializeAmount(headroom.figures.headroomMinor),
                  overLimit: headroom.figures.overLimit,
                },
          onHold: s.activeHold !== null,
          holdId: s.activeHold?.id ?? null,
          holdSource: s.activeHold?.source ?? null,
          holdReason: s.activeHold?.reason ?? null,
          autoHoldEnabled: s.autoHoldEnabled,
          autoHoldNote: auto.note,
          reconciliation: serializeReconciliation(
            headroom?.reconciliation ??
              reconcileCreditPosition({
                companyLabel: s.companyName,
                invoices: [],
                exposure: {
                  billedMinor: 0n,
                  unbilledMinor: 0n,
                  totalMinor: 0n,
                  openInvoices: 0,
                  liveOrders: 0,
                },
              }),
          ),
        };
      });
    });

    return { ok: true, data: { rows, scopeNote: EXPOSURE_SCOPE_NOTE } };
  } catch (err) {
    return toSalesActionError(err, "getCreditControlBoard");
  }
}

/* ================================================================== */
/* SHARED — NOT EXPORTED, AND THAT IS DELIBERATE                       */
/* ================================================================== */

/**
 * ⚠️ NOT EXPORTED. Every export of this file is a browser-reachable RPC
 * endpoint, and this function takes a `tenantId` and an open
 * transaction. Exporting it — even "just for a test" — would publish the
 * single route past row-level security. The tests exercise
 * `lib/credit/headroom.ts` instead, which is where the judgement lives.
 */
async function computeCreditPosition(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  tenantId: string,
  companyIds: readonly string[],
  subjects?: readonly { companyId: string; companyName: string; creditLimitMinor: bigint | null }[],
): Promise<
  Map<
    string,
    {
      exposure: ReturnType<typeof creditHeadroom>["exposure"];
      headroom: ReturnType<typeof creditHeadroom>;
      limitMinor: bigint | null;
    }
  >
> {
  const out = new Map<
    string,
    {
      exposure: ReturnType<typeof creditHeadroom>["exposure"];
      headroom: ReturnType<typeof creditHeadroom>;
      limitMinor: bigint | null;
    }
  >();
  if (companyIds.length === 0) return out;

  const [invoicesByCompany, ordersByCompany] = await Promise.all([
    loadInvoiceFacts(tx, tenantId, companyIds),
    loadOrderCommitments(tx, tenantId, companyIds),
  ]);

  const known = new Map(subjects?.map((s) => [s.companyId, s]) ?? []);

  for (const companyId of companyIds) {
    const subject = known.get(companyId);
    let limitMinor: bigint | null = subject?.creditLimitMinor ?? null;

    if (!subject) {
      const [row] = await tx
        .select({ creditLimitMinor: customerCreditProfiles.creditLimitMinor })
        .from(customerCreditProfiles)
        .where(
          and(
            eq(customerCreditProfiles.tenantId, tenantId),
            eq(customerCreditProfiles.companyId, companyId),
          ),
        )
        .limit(1);
      limitMinor =
        row?.creditLimitMinor === null || row?.creditLimitMinor === undefined
          ? null
          : toBigIntAmount(row.creditLimitMinor);
    }

    const headroom = creditHeadroom({
      companyLabel: subject?.companyName ?? companyId,
      ceiling: { creditLimitMinor: limitMinor },
      invoices: invoicesByCompany.get(companyId) ?? [],
      orders: ordersByCompany.get(companyId) ?? [],
    });

    out.set(companyId, { exposure: headroom.exposure, headroom, limitMinor });
  }

  return out;
}
