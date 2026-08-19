import "server-only";

/**
 * Ordence — 🔴🔴 THE CREDIT HOLD ENFORCEMENT POINT
 * Version: v1.46.0-alpha (Batch 40)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS IS `import "server-only"` AND NOT IN `server/actions/`
 * ══════════════════════════════════════════════════════════════════════
 * Every export of a `"use server"` file is a browser-reachable RPC
 * endpoint. `creditGateForConfirmation` takes a `tenantId` AND an open
 * transaction — in a `"use server"` file that would be a published
 * endpoint accepting the tenant to operate on, which is the single route
 * past row-level security. Phase 47 shipped exactly that bug in
 * `server/actions/notifications.ts`.
 *
 * `import "server-only"` makes the module unreachable from a browser at
 * all, and `check:boundaries` enforces the declaration. It sits beside
 * `server/credit/position.ts`, which is the same shape for the same
 * reason.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE REFUSAL IS THE POINT. IT MUST ABORT THE WRITE.
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ IT RUNS INSIDE THE CALLER'S TRANSACTION, NOT BEFORE IT. Reading a
 * hold on one connection and confirming the order on another is a race:
 * a hold placed in the same second as a confirmation is either seen or
 * not depending on connection timing, and the one that is not seen ships
 * goods to somebody the business has just decided to stop shipping to.
 * Sharing `tx` puts the read behind the same lock as the write, and
 * throwing from inside it rolls the whole confirmation back.
 *
 * 🔴 THROWING IS DELIBERATE AND `holdBlocksConfirmation()` DELIBERATELY
 * DOES NOT THROW. The judgement is a pure function returning a value, so
 * it can be exercised without a database; the throw is here, where there
 * is a transaction for it to abort. A gate that returned a boolean the
 * caller had to remember to check would eventually be called by somebody
 * who did not, and the failure would be silent.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ AND IT DOES NOT FAIL OPEN
 * ══════════════════════════════════════════════════════════════════════
 * There is no `try { ... } catch { return allowed }` in this file. If
 * `credit_hold_events` does not exist — the state of the database
 * between a code push and a migration — the query raises 42P01 and the
 * confirmation fails. That is why 0083 runs BEFORE the code push and the
 * header of 0083 says so: the alternative ordering degrades this gate to
 * "no hold row found, therefore no hold" for the length of the window,
 * with no error anywhere and every held customer trading freely.
 *
 * A gate that opens when it cannot read its own tables is not a gate.
 */

import { and, desc, eq, isNull } from "drizzle-orm";
import { creditHoldEvents, creditHoldOverrides } from "@/db/schema/credit";
import { holdBlocksConfirmation, type ActiveHold, type OverrideFact } from "@/lib/credit/hold";
import type { withTenant } from "@/db";

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

/**
 * ⭐ ITS OWN ERROR CLASS, AND THE REASON IS THE MESSAGE.
 *
 * 🔴 `toSalesActionError()` TURNS A PLAIN `Error` INTO "Something went
 * wrong. Please try again." — it recognises its own typed refusals, Zod
 * errors and Postgres error codes, and everything else falls through to
 * the generic sentence with a `console.error`. A credit refusal that
 * reached the user as "something went wrong" would be read as an outage:
 * the salesperson retries, retries again, and phones support to report
 * that orders are broken, while the actual message — "this account is on
 * hold because a cheque bounced" — is in a server log nobody at the
 * counter can see.
 *
 * So `confirmOrder` catches this class by name and returns its message.
 * The class exists to be caught; that is the whole of its job.
 */
export class CreditHoldRefusal extends Error {
  readonly companyId: string;
  readonly orderId: string;

  constructor(message: string, args: { companyId: string; orderId: string }) {
    super(message);
    this.name = "CreditHoldRefusal";
    this.companyId = args.companyId;
    this.orderId = args.orderId;
  }
}

/** The unreleased hold for a customer, or `null`. */
export async function loadActiveHold(
  tx: Tx,
  tenantId: string,
  companyId: string,
): Promise<ActiveHold> {
  /**
   * ⚠️ `isNull(releasedAt)` IS THE DEFINITION OF ACTIVE, and the partial
   * unique index in 0083 guarantees there is at most one. The
   * `orderBy` + `limit(1)` is belt and braces: if the index were ever
   * dropped, this returns the most recent hold rather than an arbitrary
   * one, and the most recent hold is the one whose reason is current.
   */
  const [row] = await tx
    .select({
      id: creditHoldEvents.id,
      source: creditHoldEvents.source,
      reason: creditHoldEvents.reason,
      placedAt: creditHoldEvents.placedAt,
    })
    .from(creditHoldEvents)
    .where(
      and(
        eq(creditHoldEvents.tenantId, tenantId),
        eq(creditHoldEvents.companyId, companyId),
        isNull(creditHoldEvents.releasedAt),
      ),
    )
    .orderBy(desc(creditHoldEvents.placedAt))
    .limit(1);

  if (!row) return null;
  return {
    id: row.id,
    source: row.source,
    reason: row.reason,
    placedAt: row.placedAt,
  };
}

/**
 * The override raised against ONE order, consumed or not.
 *
 * ⚠️ IT LOADS THE CONSUMED ONES TOO. `holdBlocksConfirmation()` needs to
 * be able to say "the override for this order was already used on the
 * 12th", which is a different sentence from "there is no override" and
 * sends the reader somewhere different.
 */
export async function loadOrderOverride(
  tx: Tx,
  tenantId: string,
  orderId: string,
): Promise<OverrideFact> {
  const [row] = await tx
    .select({
      id: creditHoldOverrides.id,
      orderId: creditHoldOverrides.orderId,
      actorUserId: creditHoldOverrides.actorUserId,
      reason: creditHoldOverrides.reason,
      consumedAt: creditHoldOverrides.consumedAt,
    })
    .from(creditHoldOverrides)
    .where(
      and(
        eq(creditHoldOverrides.tenantId, tenantId),
        eq(creditHoldOverrides.orderId, orderId),
      ),
    )
    .limit(1);

  return row ?? null;
}

/**
 * ⭐⭐ THE GATE `confirmOrder` CALLS.
 *
 * Throws `CreditHoldRefusal` when the write must not happen. Returns a
 * sentence otherwise — empty when the customer was never held, and a
 * statement that the account REMAINS held when an override let this one
 * through. The person confirming should not be able to finish under the
 * impression that everything was fine.
 *
 * ⚠️ CONSUMING THE OVERRIDE IS PART OF THIS FUNCTION AND PART OF THE
 * SAME TRANSACTION. Marking it consumed afterwards, outside the
 * transaction, would leave a signature usable again if the confirmation
 * rolled back for an unrelated reason — and reusable signatures are the
 * exact thing `credit_hold_overrides_one_per_order_key` exists to stop.
 */
export async function creditGateForConfirmation(args: {
  tx: Tx;
  tenantId: string;
  companyId: string;
  orderId: string;
  orderNo: string;
}): Promise<{ heldMessage: string | null; overrideConsumedId: string | null }> {
  const activeHold = await loadActiveHold(args.tx, args.tenantId, args.companyId);
  if (!activeHold) return { heldMessage: null, overrideConsumedId: null };

  const override = await loadOrderOverride(args.tx, args.tenantId, args.orderId);

  const outcome = holdBlocksConfirmation({
    orderId: args.orderId,
    orderNo: args.orderNo,
    activeHold,
    override,
  });

  if (outcome.blocked) {
    throw new CreditHoldRefusal(outcome.message, {
      companyId: args.companyId,
      orderId: args.orderId,
    });
  }

  if (outcome.consumeOverrideId) {
    /**
     * ⚠️ THE `isNull(consumedAt)` PREDICATE IS NOT REDUNDANT. It is the
     * compare-and-set that makes this safe against two confirmations of
     * the same order racing each other: both read an unconsumed
     * override, both reach here, and exactly one UPDATE matches a row.
     * The trigger in 0083 refuses to un-consume, so the loser cannot
     * undo it.
     */
    await args.tx
      .update(creditHoldOverrides)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(creditHoldOverrides.tenantId, args.tenantId),
          eq(creditHoldOverrides.id, outcome.consumeOverrideId),
          isNull(creditHoldOverrides.consumedAt),
        ),
      );
  }

  return {
    heldMessage: outcome.message,
    overrideConsumedId: outcome.consumeOverrideId,
  };
}
