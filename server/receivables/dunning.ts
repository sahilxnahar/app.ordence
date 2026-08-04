import "server-only";

/**
 * Ordence — ⭐⭐ The Dunning Ladder, Written Down
 * Version: v0.38.0-alpha
 *
 * The write path for the chase. The rules — which rung comes next,
 * whether it is due, the minimum gap, and the one rung a machine may
 * never send — are in `lib/receivables/dunning.ts`. This file loads what
 * the rule needs, calls it, renders the letter in the buyer's language
 * and records what was sent.
 *
 * ⚠️ THE LADDER IS ENFORCED IN THREE PLACES AND THAT IS NOT DUPLICATION.
 *
 *   • The UI calls `canEscalate` so it does not offer a step the server
 *     will refuse.
 *   • This file calls it again, because a UI is not a gate.
 *   • SQL 0027 §6 refuses a rung whose predecessor was never sent,
 *     because a back-fill importing letters from a spreadsheet does not
 *     come through here — and that is exactly the path where the earlier
 *     rungs go missing.
 *
 * ⚠️ AND THE CANCELLATION WARNING NEEDS A NAMED HUMAN, checked here, in
 * the validator, in `canEscalate` and by a CHECK constraint. Four is not
 * excessive for the letter that precedes terminating an allotment and
 * forfeiting what a family has paid towards a home.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import {
  demandNotices,
  demandNoticeDocuments,
  dunningEvents,
  type DunningChannel,
  type DunningEvent,
  type DunningStage,
  type NoticeLanguage,
} from "@/db/schema/receivables";
import { toCivilDay } from "@/lib/gst/constants";
import { canEscalate, nextSweepAction, rungOf } from "@/lib/receivables/dunning";
import { demandPosition } from "@/lib/receivables/demand";
import { renderDunningLetter } from "@/lib/receivables/templates";
import {
  demandFacts,
  findBookingContext,
  lastDunningEvent,
  resolvePolicies,
} from "./registry";
import { noticeFactsFor } from "./demands";

export type DunningFailure = { ok: false; error: string; remedy?: string };

export type SendDunningOutcome =
  | {
      ok: true;
      event: DunningEvent;
      subject: string;
      body: string;
      language: NoticeLanguage;
      wordsFellBack: boolean;
    }
  | DunningFailure;

/* ------------------------------------------------------------------ */
/* SEND ONE RUNG                                                       */
/* ------------------------------------------------------------------ */

export async function sendDunningLetter(args: {
  tenantId: string;
  userId: string | null;
  demandId: string;
  stage: DunningStage;
  channel: DunningChannel;
  language?: NoticeLanguage;
  recipient?: string | null;
  sentOn?: string;
  authorisedReason?: string | null;
  notes?: string | null;
  developerName: string;
  contactLine: string;
  asOf: string;
}): Promise<SendDunningOutcome> {
  const { tenantId, userId, demandId, stage } = args;
  const asOf = toCivilDay(args.sentOn ?? args.asOf);

  const demand = await withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(demandNotices)
      .where(and(eq(demandNotices.tenantId, tenantId), eq(demandNotices.id, demandId)))
      .limit(1);
    return rows[0] ?? null;
  });

  if (!demand) return { ok: false, error: "That demand does not exist." };

  const booking = await findBookingContext(tenantId, demand.bookingId);
  if (!booking) return { ok: false, error: "That booking no longer exists." };

  const policies = await resolvePolicies(tenantId, demand.projectId);
  const last = await lastDunningEvent(tenantId, demandId);
  const position = demandPosition(demandFacts(demand), asOf);

  /* --- ⭐⭐ THE GATE. -------------------------------------------- */
  const verdict = canEscalate({
    currentStage: demand.dunningStage,
    to: stage,
    demandStatus: demand.status,
    dueDate: demand.dueDate,
    asOf,
    outstandingMinor: position.outstandingMinor,
    lastSentOn: last ? toCivilDay(last.sentAt) : null,
    policy: policies.dunning,
    // ⚠️ THE AUTHORISER IS THE SIGNED-IN USER, NOT A FIELD ON THE FORM. A
    // form that could name somebody else would be a form for putting
    // another person's name on a cancellation warning.
    authorisedBy: stage === "cancellation_warning" ? userId : null,
    authorisedReason: args.authorisedReason ?? null,
  });

  if (!verdict.allowed) {
    return { ok: false, error: verdict.reason, remedy: verdict.remedy };
  }

  /* --- The letter, in the buyer's language. -------------------- */
  const language = args.language ?? demand.language;
  const facts = noticeFactsFor({
    demand,
    booking,
    developerName: args.developerName,
    contactLine: args.contactLine,
    asOf,
  });
  const letter = renderDunningLetter(stage, { ...facts, language });

  const written = await withTenant(tenantId, async (tx) => {
    // ⚠️ THE LETTER IS STORED BEFORE THE EVENT, and the event points at
    // it. "What did the final notice actually say?" is asked about a
    // letter sent under a template two releases old.
    const documents = await tx
      .insert(demandNoticeDocuments)
      .values({
        tenantId,
        demandId,
        // ⚠️ A CHASING LETTER IS ITS OWN DOCUMENT, stored beside the
        // demand notice under its own `template_key` — see the unique
        // index in SQL 0027 §1. Keyed on the language alone, four of the
        // five documents a demand produces would silently fail to store,
        // and the missing four are the ones that end up in front of an
        // Authority.
        language,
        templateKey: letter.templateKey,
        templateVersion: letter.templateVersion,
        subject: letter.subject,
        body: letter.body,
        bodyHash: await sha256Hex(letter.body),
        amountInWords: letter.amountInWords,
        wordsLanguage: letter.wordsLanguage,
        wordsFellBack: letter.wordsFellBack,
        renderedBy: userId,
      })
      .returning();

    const rows = await tx
      .insert(dunningEvents)
      .values({
        tenantId,
        demandId,
        stage,
        rung: rungOf(stage),
        channel: args.channel,
        language,
        recipient: args.recipient ?? booking.buyerEmail ?? booking.buyerPhone ?? null,
        sentAt: new Date(`${asOf}T00:00:00.000Z`),
        daysOverdue: verdict.daysOverdue,
        outstandingMinor: position.outstandingMinor,
        interestMinor: position.outstandingInterestMinor,
        authorisedBy: stage === "cancellation_warning" ? userId : null,
        authorisedReason:
          stage === "cancellation_warning" ? (args.authorisedReason ?? null) : null,
        documentId: documents[0]?.id ?? null,
        notes: args.notes ?? null,
      })
      .returning();

    await tx
      .update(demandNotices)
      .set({ dunningStage: stage, lastDunnedAt: new Date() })
      .where(and(eq(demandNotices.tenantId, tenantId), eq(demandNotices.id, demandId)));

    return rows[0] ?? null;
  });

  if (!written) return { ok: false, error: "The letter could not be recorded." };

  return {
    ok: true,
    event: written,
    subject: letter.subject,
    body: letter.body,
    language,
    wordsFellBack: letter.wordsFellBack,
  };
}

/* ------------------------------------------------------------------ */
/* THE SWEEP                                                           */
/* ------------------------------------------------------------------ */

export type SweepItem = {
  demandId: string;
  noticeNumber: string;
  bookingId: string;
  action: "send" | "needs_decision" | "none";
  stage: DunningStage | null;
  daysOverdue: number;
  outstandingMinor: bigint;
  reason: string;
};

/**
 * What the nightly chase would do, one rung at a time.
 *
 * ⚠️ IT NEVER SENDS A CANCELLATION WARNING. `nextSweepAction` returns
 * that rung as `needs_decision`, and this function passes it through as a
 * queue for a person. Everything below it can be swept; the letter that
 * precedes forfeiting somebody's home may not be, ever.
 *
 * ⚠️ AND IT RETURNS ONE RUNG PER DEMAND, ALWAYS THE NEXT ONE — never the
 * highest whose threshold has passed. A demand that surfaces already 70
 * days overdue gets a reminder tonight and climbs from there. Slower, and
 * the only version that produces a file a developer can put in front of
 * an Authority.
 */
export async function planDunningSweep(args: {
  tenantId: string;
  projectId?: string;
  asOf: string;
  limit: number;
}): Promise<SweepItem[]> {
  const { tenantId, asOf } = args;

  const rows = await withTenant(tenantId, async (tx) => {
    const filters = [
      eq(demandNotices.tenantId, tenantId),
      inArray(demandNotices.status, ["issued", "part_paid"]),
      sql`${demandNotices.dueDate} < ${asOf}::date`,
    ];
    if (args.projectId) filters.push(eq(demandNotices.projectId, args.projectId));

    return tx
      .select()
      .from(demandNotices)
      .where(and(...filters))
      .orderBy(demandNotices.dueDate)
      .limit(args.limit);
  });

  const items: SweepItem[] = [];

  for (const demand of rows) {
    const policies = await resolvePolicies(tenantId, demand.projectId);
    const last = await lastDunningEvent(tenantId, demand.id);
    const position = demandPosition(demandFacts(demand), asOf);

    const action = nextSweepAction({
      currentStage: demand.dunningStage,
      demandStatus: demand.status,
      dueDate: demand.dueDate,
      asOf,
      outstandingMinor: position.outstandingMinor,
      lastSentOn: last ? toCivilDay(last.sentAt) : null,
      policy: policies.dunning,
    });

    items.push({
      demandId: demand.id,
      noticeNumber: demand.noticeNumber,
      bookingId: demand.bookingId,
      action: action.kind === "send" ? "send" : action.kind,
      stage: action.kind === "none" ? null : action.stage,
      daysOverdue: position.daysOverdue,
      outstandingMinor: position.outstandingMinor,
      reason:
        action.kind === "send"
          ? `Next rung due: ${action.stage.replace(/_/g, " ")}.`
          : action.reason,
    });
  }

  return items;
}

async function sha256Hex(value: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(value, "utf8").digest("hex");
}
