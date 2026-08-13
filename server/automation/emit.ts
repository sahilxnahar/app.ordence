import "server-only";

/**
 * Ordence — ⭐⭐⭐ THE EVENT NOBODY EVER FIRED
 * Version: v1.19.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 A CORRECTION TO WHAT v1.16.0 CLAIMED
 * ══════════════════════════════════════════════════════════════════════
 * That session said the workflow engine had existed since v0.7x and that
 * 0068 finally gave it its first business events. The first half was
 * true. The second was not.
 *
 * ⚠️ 0068 CREATED `automation_events` AND ITS STORM BRAKE AND NOTHING
 * WROTE A ROW. Not a server action, not a trigger, not one line of SQL.
 * The claim was made on the strength of the table existing.
 *
 * ⚠️ AND THE OTHER END WAS OPEN TOO. `dispatchRecordEvent` has been sitting
 * in `server/workflows/dispatch.ts` since v0.23.0, complete and correct,
 * and `server/actions/workflows.ts` imports `dispatchManual`,
 * `dispatchScheduled` and `generateWebhookToken` from that same file and
 * not `dispatchRecordEvent`. So a workflow could be run by a button, by a
 * schedule or by a webhook, and never by anything the business actually
 * did.
 *
 * 🔴 THIS FILE AND `drain.ts` ARE THE BRIDGE. Neither invents anything:
 * the queue is 0068's table and the dispatcher is v0.23.0's function.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ WHY A QUEUE RATHER THAN CALLING THE DISPATCHER DIRECTLY
 * ══════════════════════════════════════════════════════════════════════
 * 0068's own header made this argument and it is worth keeping in front
 * of whoever edits this next: a trigger that invoked a workflow inline
 * would run somebody's HTTP step inside the transaction that created an
 * invoice, and a slow endpoint would then hold a lock on the ledger.
 *
 * ⚠️ SO EMITTING IS ONE INSERT AND NOTHING ELSE. It runs in the caller's
 * transaction, it does no network, and it cannot fail in a way that
 * loses the business record it describes.
 */

import { sql } from "drizzle-orm";
import { automationEvents } from "@/db/schema/patterns";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;

/**
 * 🔴 THE VOCABULARY IS 0068'S, NOT A NEW ONE.
 *
 * ⚠️ `automation_events_trigger_known` permits exactly these four, and
 * `workflow_versions.trigger_type` uses the same words. Inventing a
 * fifth here would be refused by the database, which is the correct
 * outcome and a poor way to find out.
 */
export type AutomationTrigger =
  | "record_created"
  | "record_updated"
  | "record_deleted"
  | "webhook";

/**
 * ⚠️ HOW LONG AN EVENT MAY BE KEPT.
 *
 * 🔴 DPDP AGAIN: an event carries somebody's data in its payload, so it
 * has a stated end. 0068 made `purge_after` NOT NULL precisely so that
 * nobody could write an event without deciding this.
 */
export const EVENT_RETENTION_DAYS = 90;

export interface EmitArgs {
  readonly tx: Tx;
  readonly tenantId: string;
  readonly trigger: AutomationTrigger;
  /** What kind of thing changed: "lead", "sales_invoice", "stock_count". */
  readonly recordType: string;
  readonly recordId: string;
  /**
   * ⭐ WHICH FIELDS CHANGED, and the reason the loop brake works.
   *
   * ⚠️ A workflow that watches `status` should not re-fire when a
   * workflow updated `updated_at`. `decideTrigger` in
   * `lib/workflows/triggers.ts` uses this, and passing null means "we
   * did not track it", which makes every watching workflow fire.
   */
  readonly changedFields?: readonly string[] | null;
  /** Small. See below. */
  readonly payload?: Record<string, unknown>;
  readonly now: Date;
}

/**
 * ⭐ WRITE THE EVENT. One insert, in the caller's transaction.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE PAYLOAD IS SMALL AND IS NEVER THE WHOLE RECORD
 * ══════════════════════════════════════════════════════════════════════
 * The tempting shape is to copy the row in, so the workflow has
 * everything without a second read. Three reasons not to:
 *
 * ① IT IS A COPY, AND COPIES GO STALE. A workflow that runs four
 *    minutes later acting on a snapshot from before an edit is acting on
 *    something that is no longer true. The dispatcher reads the record.
 *
 * ② IT IS PERSONAL DATA, DUPLICATED. Every erasure request then has two
 *    places to reach, and this one is a queue nobody thinks of.
 *
 * ③ IT IS UNBOUNDED. An invoice with two hundred lines becomes a two
 *    hundred line JSON blob per event, and the queue is the hottest
 *    table in the system.
 *
 * ⚠️ SO THE PAYLOAD IS FOR THINGS THE RECORD DOES NOT HOLD: which
 * amount crossed a threshold, which rule matched. Not the record itself.
 */
export async function emitAutomationEvent(args: EmitArgs): Promise<void> {
  const purgeAfter = new Date(
    args.now.getTime() + EVENT_RETENTION_DAYS * 86_400_000,
  );

  await args.tx.insert(automationEvents).values({
    tenantId: args.tenantId,
    triggerType: args.trigger,
    recordType: args.recordType,
    recordId: args.recordId,
    changedFields: args.changedFields ? [...args.changedFields] : null,
    payload: args.payload ?? {},
    occurredAt: args.now,
    purgeAfter: purgeAfter.toISOString().slice(0, 10),
  });
}

/**
 * ⭐⭐ THE SAFE FORM, AND THE ONE BUSINESS ACTIONS SHOULD CALL.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 AN AUTOMATION FAILURE MUST NEVER LOSE A BUSINESS RECORD
 * ══════════════════════════════════════════════════════════════════════
 * The event is written in the same transaction as the invoice, which is
 * right: an invoice that exists with no event would silently skip every
 * workflow watching invoices. But it means a fault in the queue can roll
 * back the invoice, and that trade is the wrong way round.
 *
 * ⚠️ THE ONE FAILURE THIS ACTUALLY EXPECTS is 0068's storm brake, which
 * refuses the twenty-first event on one record inside a minute. That is
 * a brake working, not an error, and it must not take the twenty-first
 * genuine invoice down with it.
 *
 * ⭐ SO THE EVENT IS BEST-EFFORT AND SAYS SO. It returns whether it was
 * written rather than throwing, and a caller that wants the strict
 * behaviour can use `emitAutomationEvent` directly.
 *
 * 🔴 IT DOES NOT SWALLOW SILENTLY. The reason comes back so the caller
 * can put it in the audit row, because a queue that quietly drops events
 * is worse than one that has none: people build on it.
 */
export async function tryEmitAutomationEvent(
  args: EmitArgs,
): Promise<{ emitted: boolean; reason: string | null }> {
  try {
    await args.tx.execute(sql`SAVEPOINT ordence_emit`);
    await emitAutomationEvent(args);
    await args.tx.execute(sql`RELEASE SAVEPOINT ordence_emit`);
    return { emitted: true, reason: null };
  } catch (e) {
    /**
     * ⚠️ THE SAVEPOINT IS WHAT MAKES THIS WORK AT ALL. In PostgreSQL a
     * failed statement poisons the whole transaction: every subsequent
     * statement returns "current transaction is aborted" until a
     * rollback. Catching the error without rolling back to a savepoint
     * would leave the caller unable to commit the invoice either, which
     * is precisely the outcome this function exists to prevent.
     */
    try {
      await args.tx.execute(sql`ROLLBACK TO SAVEPOINT ordence_emit`);
      await args.tx.execute(sql`RELEASE SAVEPOINT ordence_emit`);
    } catch {
      // Nothing further to do; the caller's own error handling takes over.
    }
    return {
      emitted: false,
      reason:
        e instanceof Error
          ? e.message.slice(0, 300)
          : "The automation event could not be recorded.",
    };
  }
}
