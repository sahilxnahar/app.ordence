import "server-only";

/**
 * Ordence — ⭐⭐⭐ THE DUNNING SWEEP, AS A FUNCTION A SCHEDULER CAN CALL
 * Version: v1.66.0-alpha (Brief C)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS MOVED OUT OF `server/actions/credit.ts`
 * ══════════════════════════════════════════════════════════════════════
 * `runDunningSweep` was correct, tested, and CALLED BY NOTHING. No route,
 * no button and no cron reached it, so the collections ladder never
 * advanced: `credit_dunning_log` rows were never written, so `enqueueEmail`
 * was never called, so the outbox the previous batch built had nothing to
 * drain. The letter that a customer never received is the same letter
 * whether the drain exists or not.
 *
 * The fix is a scheduler. A scheduler has no Clerk session, no
 * organisation and no user — and `server/actions/credit.ts` is a
 * `"use server"` module, where EVERY export is a browser-reachable RPC
 * endpoint. Its own header states the rule this file obeys:
 *
 *   "Schemas live in `lib/credit/validators.ts` … database reads in
 *    `server/credit/position.ts` — which is `import "server-only"`
 *    precisely because its functions DO take a tenant id, and a
 *    `"use server"` export that does the same is a browser-reachable way
 *    past row-level security. Phase 47 shipped exactly that bug."
 *
 * ⚠️ SO THE WORK LIVES HERE AND THE ACTION IS NOW A WRAPPER. Adding
 * `sweepDunningForTenant(tenantId)` to the action file would have been the
 * Phase 47 defect a third time: any authenticated user of any workspace
 * could have posted a server-action id with somebody else's tenant id and
 * run their collections ladder.
 *
 * `import "server-only"` is what makes taking a `tenantId` safe here; the
 * module cannot be reached from a browser at all, and
 * `scripts/check-server-boundaries.mjs` enforces the declaration.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 EVERYTHING BELOW IS THE ORIGINAL BODY, MOVED, NOT REWRITTEN
 * ══════════════════════════════════════════════════════════════════════
 * The reasoning comments came with it, because they are the reason each
 * line is the way it is. Four things changed and nothing else:
 *
 *   ① `ctx.tenant.id`   → `args.tenantId`
 *   ② `ctx.tenant.name` → `args.organizationName`
 *   ③ `ctx.user.id`     → `args.actorUserId`, which is NULL for the
 *                          scheduler. `credit_dunning_log.created_by` and
 *                          `email_outbox.created_by` are both
 *                          `ON DELETE SET NULL` uuid columns with no
 *                          NOT NULL, so a row with no author is a row the
 *                          schema already allows — and a sweep that
 *                          borrowed a person's id would put their name on
 *                          a letter they did not decide to send.
 *   ④ `writeAudit(ctx, …)` → `args.audit(…)`, supplied by the caller.
 *                          The interactive path passes the chained
 *                          `writeAudit`; the scheduled path passes
 *                          `writeSystemAudit`, which writes into the SAME
 *                          per-tenant chain (see `server/audit.ts`) rather
 *                          than a second one.
 *
 * ⚠️ THE VALIDATION AND THE PERMISSION GATE DID NOT MOVE. They stay in
 * the action, because they are statements about a REQUEST — who is asking
 * and whether their workspace has paid — and this function has no request.
 * The scheduler applies its own equivalent (see
 * `server/scheduling/registry.ts`: the entitlement is checked per tenant
 * before this is called, and a workspace that has not paid for
 * `sales.orders` is skipped and SAID to be skipped).
 */

import { withTenant } from "@/db";
import { creditDunningLog, creditHoldEvents } from "@/db/schema/credit";
import { describeSweep, planDunning } from "@/lib/credit/dunning";
import {
  loadChaseableInvoices,
  loadDunningLadder,
  loadRecordedDunning,
} from "@/lib/credit/queries";
import { todayInIndia } from "@/lib/accounting/periods";
import { formatMoney } from "@/lib/billing/money";
import { enqueueEmail } from "@/server/email/outbox";
import { renderDunningLetterEmail } from "@/lib/email/templates";

/** What the sweep decided, whoever asked for it. */
export type DunningSweepOutcome = {
  asOf: string;
  queued: number;
  suppressed: number;
  holdsPlaced: number;
  skipped: { invoiceNumber: string; why: string }[];
  summary: string;
  preview: boolean;
};

/** The facts an audit row needs. The CALLER decides which chain writes it. */
export type DunningSweepAudit = {
  ladderId: string;
  ladderName: string;
  asOf: string;
  queued: number;
  suppressed: number;
  holdsPlaced: number;
  skipped: number;
};

export type SweepDunningArgs = {
  tenantId: string;
  /** Printed on the letterhead. Read from `tenants.name` by the scheduler. */
  organizationName: string;
  /** Already clamped by the caller, or absent for "today in India". */
  asOf?: string | null;
  ladderId?: string | null;
  preview?: boolean;
  /**
   * 🔴 NULL FOR THE SCHEDULER, AND DELIBERATELY SO. See ③ above.
   */
  actorUserId: string | null;
  /** Passed straight to `withTenant`. Null for every scheduled run. */
  impersonationId?: string | null;
  /** Called once, only on a non-preview run that actioned something. */
  audit: (entry: DunningSweepAudit) => Promise<void>;
};

/**
 * ⭐⭐ WORK OUT WHICH REMINDERS ARE DUE AND RECORD THEM.
 *
 * 🔴 IT STILL QUEUES. IT STILL DOES NOT SEND — AND SOMETHING EMPTIES THE
 * QUEUE. The letters were written with `delivery: "queued"` and stayed
 * there forever. The screen said a reminder had been recorded; the
 * customer received nothing; the invoice aged; the owner believed they
 * were chasing money they were not chasing.
 *
 * ⚠️ THE FIX IS NOT A `send()` IN THIS FUNCTION, AND THAT IS THE POINT.
 * A sweep that mails inline is a sweep that dies on invoice 40 of 300
 * with 39 letters gone and no record of which, then reruns from the top.
 * The queue was always right. What was missing was the drain — and then,
 * for a year, what was missing was anything that called this.
 *
 * ⭐ SO EACH ACTIONED EMAIL RUNG ALSO GETS AN `email_outbox` ROW, in THIS
 * transaction, and `server/email/outbox.ts` sends it and writes `sent` or
 * `failed` back onto the dunning row. Recording `sent` here because the
 * row is "about to" go out would produce a collections call opening with
 * "we have written to you three times" against a customer who can prove
 * otherwise.
 *
 * 🔴 ONLY THE ROWS THIS RUN ACTUALLY INSERTED ARE MAILED. The insert is
 * `ON CONFLICT DO NOTHING ... RETURNING`, so a row another container
 * already recorded comes back absent and earns no letter. Enqueueing from
 * `plan.actions` instead would mail a second copy of every reminder every
 * time two sweeps overlapped.
 *
 * 🔴 AND IT IS SAFE TO RUN TWICE. `ON CONFLICT DO NOTHING` against
 * `credit_dunning_log_once_per_stage_key` is the guarantee — not the
 * `alreadyRecorded` set, which is a read-then-write two containers can
 * both pass in the same millisecond. That is what makes an hourly cron
 * and a nightly cron and an operator pressing the button twice all add up
 * to one letter per rung.
 */
export async function sweepDunningForTenant(
  args: SweepDunningArgs,
): Promise<DunningSweepOutcome> {
  /**
   * 🔴 CLAMPED TO TODAY IN INDIA, NEVER `toISOString()`. India is UTC+5:30,
   * so between midnight and 05:30 IST a UTC date is YESTERDAY — and a
   * sweep that thinks it is yesterday silently fails to fire the stage
   * that came due at midnight. A cron running at 19:30 UTC is 01:00 IST
   * the NEXT day, which is exactly the window this clamp exists for.
   *
   * ⚠️ AND A FUTURE `asOf` IS CLAMPED, NOT REJECTED. Rejecting sends
   * somebody to edit an invoice's due date to make the ladder fire, which
   * corrupts the document to fix the job.
   */
  const today = todayInIndia();
  const asOf = args.asOf && args.asOf <= today ? args.asOf : today;
  const preview = args.preview === true;

  return withTenant(
    args.tenantId,
    async (tx) => {
      const ladder = await loadDunningLadder(tx, args.tenantId, args.ladderId ?? undefined);
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
        loadChaseableInvoices(tx, args.tenantId),
        loadRecordedDunning(tx, args.tenantId),
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
              tenantId: args.tenantId,
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
              createdBy: args.actorUserId,
            })),
          )
          /**
           * 🔴 THE IDEMPOTENCY GUARANTEE. A quiet no-op on the second run
           * rather than an exception — a sweep that dies on invoice 40 of
           * 300 because another container got there first is a sweep that
           * never finishes.
           *
           * ⭐ AND `RETURNING` TURNS IT INTO A CLAIM. What comes back is
           * exactly the set of rungs THIS run recorded; a rung another
           * container got to first is absent. That set, and only that set,
           * earns a letter below.
           */
          .onConflictDoNothing()
          .returning({
            id: creditDunningLog.id,
            invoiceId: creditDunningLog.invoiceId,
            stageId: creditDunningLog.stageId,
          });

        /*
         * ══════════════════════════════════════════════════════════
         * ⭐⭐ THE LETTERS.
         * ══════════════════════════════════════════════════════════
         * 🔴 `delivery` STAYS `queued` HERE. The outbox row is the
         * instruction to send; `server/email/outbox.ts` is the only thing
         * that may write `sent`, and only when Resend hands back a message
         * id. Marking it here would be the same lie in a different table.
         *
         * ⚠️ ONLY `channel = "email"` RUNGS. A rung whose channel is
         * `call` or `visit` is a diary entry for a person; queueing an
         * email for it would silently replace the phone call somebody was
         * supposed to make with a letter nobody chose to send.
         *
         * ⚠️ AND ONLY WHERE THERE IS AN ADDRESS. A rung with no recipient
         * email keeps its `queued` row — it is still a chase that is owed
         * — but there is nothing to send it to, and inventing one is worse
         * than the gap.
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
            organizationName: args.organizationName,
            customerName: action.companyName,
            invoiceNumber: action.invoiceNumber,
            amountDue: formatMoney(action.amountDueMinor),
            dueDate: null,
            daysPastDue: action.daysPastDue,
            stageLabel: action.stageLabel,
          });

          await enqueueEmail(tx, {
            tenantId: args.tenantId,
            purpose: "dunning",
            /**
             * ⭐ THE THREAD BACK. The dispatcher writes the outcome onto
             * this exact dunning row, so the collections board stops saying
             * "queued" the moment the letter actually goes — and says
             * "failed", with the reason, when it does not.
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
             * 🔴 DERIVED FROM THE DUNNING ROW, NOT FROM THE CLOCK. It is
             * the same value on a re-run, which is what lets the unique
             * index refuse a second letter for a rung that has already
             * been chased.
             */
            idempotencyKey: `dunning:${written.id}`,
            createdBy: args.actorUserId,
          });
        }

        /**
         * ⭐ THE RUNGS THAT PLACE A HOLD. `ON CONFLICT DO NOTHING` again,
         * against the one-active-hold index: a customer with four invoices
         * reaching the final stage on the same night gets one hold, not
         * four — and an hourly cron gets none on the second pass.
         */
        const holdRungs = plan.actions.filter(
          (a) => a.delivery === "queued" && a.placesHold,
        );
        for (const rung of holdRungs) {
          const placed = await tx
            .insert(creditHoldEvents)
            .values({
              tenantId: args.tenantId,
              companyId: rung.companyId,
              source: "automatic",
              reason: `${rung.invoiceNumber} is ${rung.daysPastDue} days past due and reached "${rung.stageLabel}". Placed by the dunning ladder; it will not lift itself.`,
              /**
               * ⚠️ `placedBy` IS NULL AND THE CHECK CONSTRAINT ALLOWS IT
               * ONLY FOR `automatic`. The sweep has no user, and naming the
               * person who pressed the button would put their signature on
               * a decision the ladder made.
               */
              exposureAtHoldMinor: null,
              limitAtHoldMinor: null,
            })
            .onConflictDoNothing()
            .returning({ id: creditHoldEvents.id });
          if (placed.length > 0) holdsPlaced += 1;
        }

        await args.audit({
          ladderId: ladder.id,
          ladderName: ladder.name,
          asOf,
          queued,
          suppressed,
          holdsPlaced,
          skipped: plan.skipped.length,
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
    { impersonationId: args.impersonationId ?? null },
  );
}
