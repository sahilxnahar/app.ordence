/**
 * Ordence — ⭐⭐⭐ SENDING A CAMPAIGN
 * Version: v1.15.0-alpha
 *
 * ⚠️ NODE RUNTIME.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE RUN READS THE FROZEN LIST. IT NEVER RE-RESOLVES ANYTHING.
 * ══════════════════════════════════════════════════════════════════════
 * `campaign_recipients` was written at approval. This loop reads those
 * rows and sends to exactly the people in them.
 *
 * ⚠️ IT DOES NOT RE-RUN THE FILTER, does not re-check who qualifies, and
 * does not add anybody. The audience was approved; adding to it later is
 * sending messages nobody authorised, however good the reason.
 *
 * ⭐ It DOES re-check consent per person, because a withdrawal between
 * approval and send is the one change that must win. Somebody who said
 * stop after the list was frozen has still said stop.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 AND A FAILED MARKETING MESSAGE IS NOT RETRIED
 * ══════════════════════════════════════════════════════════════════════
 * WhatsApp error **131049** is the per-user marketing limit: a dynamic,
 * personalised cap nobody can predict. The message comes back
 * undelivered, and repeated attempts within 24 hours can block delivery
 * to that person for a further day.
 *
 * ⚠️ A LOOP THAT TREATS "FAILED" AS "TRY AGAIN" TURNS ONE UNDELIVERED
 * MESSAGE INTO A CUSTOMER NOBODY CAN REACH UNTIL TOMORROW. Exactly the
 * shape of the paused-template trap in v1.14.0.
 */

import "server-only";

import { and, eq, isNull, sql } from "drizzle-orm";
import { campaigns, campaignRecipients } from "@/db/schema/campaigns";
import { messageTemplates } from "@/db/schema/messaging";
import { sendUtilityMessage } from "@/server/messaging/send";
import { idempotencyKey } from "@/lib/messaging/render";
import { shouldRetry } from "@/lib/campaigns/approval";
import type { ConsentRecord } from "@/lib/crm/consent";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;

export interface RunReport {
  readonly campaignId: string;
  readonly attempted: number;
  readonly sent: number;
  readonly failed: number;
  readonly skipped: number;
  readonly stopped: boolean;
  readonly note: string;
}

/**
 * Sends one batch of a campaign.
 *
 * ⭐ BATCHED ON PURPOSE. A single call that tries ten thousand messages
 * holds one transaction open for minutes, and the stop button cannot
 * take effect inside a transaction that has not committed.
 */
export async function runCampaignBatch(args: {
  readonly tx: Tx;
  readonly tenantId: string;
  readonly campaignId: string;
  readonly now: Date;
  readonly batchSize?: number;
  /** Consent, per subject, read fresh. See the header. */
  readonly consentsFor: (
    subjectType: string,
    subjectId: string,
  ) => Promise<readonly ConsentRecord[]>;
  readonly valuesFor: (
    recipient: { subjectType: string; subjectId: string; displayName: string | null },
  ) => readonly string[];
  readonly fetchImpl?: typeof fetch;
}): Promise<RunReport> {
  const batchSize = args.batchSize ?? 50;

  const [campaign] = await args.tx
    .select()
    .from(campaigns)
    .where(
      and(eq(campaigns.tenantId, args.tenantId), eq(campaigns.id, args.campaignId)),
    )
    .limit(1);

  if (!campaign) {
    return empty(args.campaignId, "No such campaign.");
  }

  /**
   * 🔴 THE STOP IS CHECKED HERE **AND** BY A TRIGGER ON EVERY INSERT.
   *
   * ⚠️ Twice, deliberately. This check makes the run stop promptly; the
   * trigger makes it impossible for any other code path to send from a
   * stopped campaign, including one written next year by somebody who
   * has not read this file.
   */
  if (campaign.stopRequestedAt) {
    return empty(args.campaignId, "This campaign was stopped.");
  }

  if (campaign.status !== "approved" && campaign.status !== "sending") {
    return empty(
      args.campaignId,
      `This campaign is ${campaign.status}. Marketing messages are not sent from a campaign nobody has authorised.`,
    );
  }

  const [template] = await args.tx
    .select({ name: messageTemplates.name, language: messageTemplates.language })
    .from(messageTemplates)
    .where(eq(messageTemplates.id, campaign.templateId))
    .limit(1);

  if (!template) {
    return empty(args.campaignId, "This campaign has no template.");
  }

  if (campaign.status === "approved") {
    await args.tx
      .update(campaigns)
      .set({ status: "sending", startedAt: campaign.startedAt ?? args.now })
      .where(eq(campaigns.id, args.campaignId));
  }

  // ⭐ THE FROZEN LIST. Included only, not yet processed.
  const batch = await args.tx
    .select()
    .from(campaignRecipients)
    .where(
      and(
        eq(campaignRecipients.campaignId, args.campaignId),
        eq(campaignRecipients.isIncluded, true),
        isNull(campaignRecipients.sendOutcome),
      ),
    )
    .limit(batchSize);

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  let stopped = false;

  for (const r of batch as Array<Record<string, unknown>>) {
    /**
     * 🔴 THE STOP, RE-READ INSIDE THE LOOP. A campaign to ten thousand
     * people takes minutes and the stop has to bite within seconds, not
     * at the next batch.
     */
    const [live] = await args.tx
      .select({ stopRequestedAt: campaigns.stopRequestedAt })
      .from(campaigns)
      .where(eq(campaigns.id, args.campaignId))
      .limit(1);

    if (live?.stopRequestedAt) {
      stopped = true;
      break;
    }

    const subjectType = String(r.subjectType);
    const subjectId = String(r.subjectId);

    /**
     * ⭐⭐ CONSENT IS RE-READ, AND IT IS THE ONLY THING THAT IS.
     *
     * ⚠️ The audience is frozen so that nobody is ADDED after approval.
     * A withdrawal is the opposite case: somebody removing themselves,
     * which must win however late it arrives. Under the DPDP Act a
     * withdrawal has to be honoured as easily as the consent was given,
     * and "the list was already built" is not a defence.
     */
    const consents = await args.consentsFor(subjectType, subjectId);

    const result = await sendUtilityMessage({
      tx: args.tx,
      tenantId: args.tenantId,
      connectionId: campaign.connectionId,
      templateName: template.name,
      language: template.language,
      toPhone: String(r.phoneDigits ?? ""),
      values: args.valuesFor({
        subjectType,
        subjectId,
        displayName: r.displayName ? String(r.displayName) : null,
      }),
      /**
       * ⭐ THE KEY NAMES THE CAMPAIGN AND THE PERSON, so re-running a
       * half-finished campaign cannot message anybody twice — which is
       * exactly what happens after a deploy interrupts a run.
       */
      idempotencyKey: idempotencyKey({
        subjectType: "campaign",
        subjectId: args.campaignId,
        purpose: `${subjectType}-${subjectId}`,
      }),
      subjectType: "campaign",
      subjectId: args.campaignId,
      requestedBy: campaign.approvedBy,
      consents,
      now: args.now,
      fetchImpl: args.fetchImpl,
    });

    if (result.ok) {
      sent += 1;
      await args.tx
        .update(campaignRecipients)
        .set({
          sendOutcome: "sent",
          messageSendId: result.sendId,
          processedAt: args.now,
        })
        .where(eq(campaignRecipients.id, String(r.id)));
      continue;
    }

    /**
     * ⚠️ A REFUSAL IS NOT A FAILURE, AND THE DIFFERENCE MATTERS ON THE
     * REPORT. "We chose not to send this" and "WhatsApp would not take
     * it" are different answers to "why did this customer not hear from
     * us".
     */
    const isRefusal =
      result.refusalCode === "no_consent" ||
      result.refusalCode === "already_sent" ||
      result.refusalCode === "no_number";

    const retry = shouldRetry(result.refusalCode);

    if (isRefusal) skipped += 1;
    else failed += 1;

    await args.tx
      .update(campaignRecipients)
      .set({
        sendOutcome: isRefusal ? "skipped" : "failed",
        messageSendId: result.sendId,
        // 🔴 The reason includes WHY it will not be retried, because
        // "failed" with no explanation invites somebody to add a retry.
        sendError: `${result.reason} ${retry.retry ? "" : retry.reason}`.trim().slice(0, 500),
        processedAt: args.now,
      })
      .where(eq(campaignRecipients.id, String(r.id)));
  }

  // ⭐ Finished only when nothing is left unprocessed.
  const remaining = await args.tx.execute(sql`
    SELECT count(*)::int AS n
      FROM campaign_recipients
     WHERE campaign_id = ${args.campaignId}::uuid
       AND is_included
       AND send_outcome IS NULL
  `);
  const left = firstRow<{ n: number }>(remaining)?.n ?? 0;

  if (stopped) {
    await args.tx
      .update(campaigns)
      .set({ status: "stopped", finishedAt: args.now })
      .where(eq(campaigns.id, args.campaignId));
  } else if (left === 0) {
    await args.tx
      .update(campaigns)
      .set({ status: "sent", finishedAt: args.now })
      .where(eq(campaigns.id, args.campaignId));
  }

  return {
    campaignId: args.campaignId,
    attempted: batch.length,
    sent,
    failed,
    skipped,
    stopped,
    note: stopped
      ? `Stopped after ${sent} messages. ${left} people were never messaged.`
      : left === 0
        ? `Finished. ${sent} sent, ${skipped} skipped, ${failed} failed.`
        : `${left} still to go.`,
  };
}

function empty(campaignId: string, note: string): RunReport {
  return {
    campaignId,
    attempted: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    stopped: false,
    note,
  };
}

function firstRow<T>(result: unknown): T | null {
  const r = result as { rows?: T[] };
  if (Array.isArray(r?.rows)) return r.rows[0] ?? null;
  return Array.isArray(result) ? ((result as T[])[0] ?? null) : null;
}
