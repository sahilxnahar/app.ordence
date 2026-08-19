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
import {
  AUTHORITY_NOT_RECORDED,
  cancellationServiceFinding,
  channelCanBeMachineDispatched,
  describeServiceEvidence,
  ladderGapInstant,
  noticeHasService,
  validateDeemedServiceClaim,
  validatePostalServiceClaim,
  type NoticeServiceFacts,
  type ServiceGapFinding,
} from "@/lib/receivables/service-evidence";
import {
  authorityForStage,
  ladderAuthority,
  permissionForStage,
  type RungAuthority,
} from "@/lib/receivables/notice-authority";
import {
  statutoryLadderContext,
  type StatutoryLadderContext,
} from "@/lib/receivables/rera-state";
import { enqueueEmail } from "@/server/email/outbox";
import { demandPosition } from "@/lib/receivables/demand";
import { renderDunningLetter } from "@/lib/receivables/templates";
import {
  demandFacts,
  findBookingContext,
  lastDunningEvent,
  listBookingContexts,
  loadPolicySets,
  resolvePolicies,
  resolvePoliciesFrom,
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
      /**
       * ⚠️ FALSE IS THE NORMAL, HONEST ANSWER FOR A POSTED NOTICE. It
       * means the letter is raised and waiting for a person to record how
       * it was delivered — not that anything failed.
       */
      queuedForDispatch: boolean;
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
    lastSentOn: gapDayOf(last),
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

  const recipient =
    args.recipient ?? booking.buyerEmail ?? booking.buyerPhone ?? null;

  /*
   * ⭐ CAN A MACHINE ACTUALLY CARRY THIS ONE? `post`, `courier` and
   * `hand_delivery` are on the channel enum because they are what most
   * builder-buyer agreements accept as valid service — and no amount of
   * code makes a machine able to prove them. For those the row is RAISED
   * and stays raised until a named person records the delivery.
   */
  const dispatchable =
    channelCanBeMachineDispatched(args.channel) &&
    args.channel === "email" &&
    typeof recipient === "string" &&
    recipient.includes("@");

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
        recipient,
        /*
         * 🔴🔴 `sentAt` IS NOT SET HERE, AND IT CANNOT BE.
         *
         * It used to be — `new Date(asOf)`, written by this very insert,
         * in the table that decides whether a family keeps its flat.
         * Creating the row asserted the send. 0098 dropped the default,
         * dropped the NOT NULL and added
         * `dunning_events_sent_at_is_not_a_claim`, so a row graded
         * `none` — which is what every insert gets — is REFUSED BY THE
         * DATABASE if it carries a send timestamp. Restoring the old
         * line here would not compile a lie into production; it would
         * throw.
         *
         * ⭐ WHAT THE ROW CLAIMS IS THE ONE THING THAT IS TRUE: a person
         * decided to demand, at this instant.
         */
        raisedAt: new Date(),
        /*
         * ⭐⭐ 0111. THE RIGHT THIS RUNG WAS RAISED UNDER, ON THE ROW.
         *
         * 🔴 IT IS READ FROM THE SAME FUNCTION THE ACTION'S GUARD READS.
         * `sendDunningNotice` calls `permissionForStage(stage)` to decide
         * what to REQUIRE; this calls it to decide what to RECORD. One
         * source, so the notice cannot end up recording a right different
         * from the one that was actually checked, which is what a second
         * copy of the mapping here would eventually produce.
         *
         * ⚠️ AND THE COLUMN IS NOT NULL WITH NO DEFAULT (0111 §4), so
         * deleting this line does not quietly ship unattributed notices.
         * It throws.
         */
        authorisedPermission: permissionForStage(stage),
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

    const event = rows[0];
    if (!event) return null;

    /* --- ⭐⭐ AND NOW, ACTUALLY SEND IT. ------------------------- */
    /*
     * 🔴 THROUGH THE OUTBOX THAT ALREADY EXISTS, IN THIS TRANSACTION.
     * `server/email/outbox.ts` has the claiming, the suppression check,
     * the backoff and the dead-lettering. A second dispatcher here would
     * be a second From address, a second recipient validator and a
     * second definition of "sent" — which is how this codebase already
     * acquired a `sendEmail` in `lib/email/notifications.ts` that
     * ignores every safeguard in the real one.
     *
     * ⚠️ SAME TRANSACTION AS THE EVENT, DELIBERATELY. A queued letter
     * whose dunning event rolled back is a letter chasing a demand
     * nobody decided to chase; an event whose queue row rolled back is
     * the defect this file is fixing, in a smaller currency.
     */
    if (dispatchable) {
      const outboxId = await enqueueEmail(tx, {
        tenantId,
        purpose: "dunning_notice",
        subjectType: DUNNING_OUTBOX_SUBJECT,
        subjectId: event.id,
        toEmail: recipient,
        subject: letter.subject,
        html: asSimpleHtml(letter.body),
        text: letter.body,
        category: "receivables",
        severity: stage === "cancellation_warning" ? "critical" : "warning",
        /*
         * 🔴 DERIVED FROM WHAT THE MESSAGE IS, NEVER FROM THE CLOCK. One
         * rung of one demand is one letter, forever. Two sweep containers
         * in the same millisecond must produce the same key or the unique
         * index cannot stop the buyer being chased twice.
         */
        idempotencyKey: `dunning:${demandId}:${stage}`,
        createdBy: userId,
      });

      if (outboxId) {
        await tx
          .update(dunningEvents)
          .set({ dispatchOutboxId: outboxId })
          .where(
            and(eq(dunningEvents.tenantId, tenantId), eq(dunningEvents.id, event.id)),
          );
      }
    }

    return event;
  });

  if (!written) return { ok: false, error: "The letter could not be recorded." };

  return {
    ok: true,
    event: written,
    subject: letter.subject,
    body: letter.body,
    language,
    wordsFellBack: letter.wordsFellBack,
    /*
     * ⭐ THE SCREEN IS TOLD WHICH OF THE TWO THINGS JUST HAPPENED. "Sent"
     * for a postal notice would be the old lie wearing new columns.
     */
    queuedForDispatch: dispatchable,
  };
}

/**
 * ⚠️ THE LETTER IS PLAIN TEXT AND STAYS PLAIN TEXT.
 *
 * The outbox needs an HTML part. Templating one would introduce a second
 * rendering of a legal notice, and "what did the letter actually say?" is
 * asked about the copy stored in `demand_notice_documents` — which is the
 * text. So the HTML is the same characters, escaped, inside a `<pre>`:
 * one document, two encodings, no second source of truth.
 */
function asSimpleHtml(body: string): string {
  const escaped = body
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<pre style="font-family:ui-monospace,Menlo,monospace;white-space:pre-wrap;font-size:14px;line-height:1.5">${escaped}</pre>`;
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
      lastSentOn: gapDayOf(last),
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

/* ------------------------------------------------------------------ */
/* ⭐⭐ THE THREE FACTS, READ AND WRITTEN                              */
/* ------------------------------------------------------------------ */

/**
 * 🔴 THE SUBJECT TYPE THE OUTBOX MIRRORS BACK ONTO. Shared with
 * `server/email/outbox.ts`, which is the ONLY writer of `dispatchedAt`.
 */
export const DUNNING_OUTBOX_SUBJECT = "dunning_event";

/** The evidential facts of one row, without dragging the Drizzle type out. */
export function serviceFactsOf(event: DunningEvent): NoticeServiceFacts {
  return {
    stage: event.stage,
    rung: event.rung,
    channel: event.channel,
    serviceEvidence: event.serviceEvidence,
    raisedAt: event.raisedAt,
    dispatchedAt: event.dispatchedAt,
    dispatchProviderMessageId: event.dispatchProviderMessageId,
    dispatchFailureReason: event.dispatchFailureReason,
    servedAt: event.servedAt,
    serviceRecordedAt: event.serviceRecordedAt,
    serviceReference: event.serviceReference,
    serviceBasis: event.serviceBasis,
    authorisedPermission: event.authorisedPermission,
    legacySentAt: event.sentAt,
  };
}

/**
 * ⚠️ THE DAY THE MINIMUM-GAP RULE COUNTS FROM — AND NOTHING ELSE.
 *
 * 🔴 IT FALLS BACK TO THE RAISE TIME ON PURPOSE. Returning null for an
 * undispatched rung would tell `canEscalate` "nothing has been sent yet",
 * and it would then permit the next rung IMMEDIATELY — turning an
 * evidence fix into four letters in a week. This is arithmetic about
 * pacing. It asserts nothing about service and no caller may read it as
 * if it did.
 */
function gapDayOf(event: DunningEvent | null): string | null {
  if (!event) return null;
  const instant = ladderGapInstant(serviceFactsOf(event));
  return instant ? toCivilDay(instant) : null;
}

/**
 * ⭐ WHAT A SCREEN SHOWS NEXT TO ONE RUNG. The label, the strength and
 * whether a machine proved it — resolved once, here, so a badge cannot be
 * rendered from a raw column by a page that has not read this file.
 */
export type NoticeServiceView = {
  eventId: string;
  stage: string;
  rung: number;
  channel: string;
  /** 🔴 The WORD. */
  evidenceWord: string;
  evidenceLabel: string;
  machineVerified: boolean;
  meaning: string;
  raisedAt: string | null;
  dispatchedAt: string | null;
  servedAt: string | null;
  serviceReference: string | null;
  dispatchFailureReason: string | null;
  /**
   * ⭐ 0111. The clause or section a DEEMED service rests on. Null on
   * every other grade, and shown beside the badge rather than behind it:
   * "Deemed served" with the reasoning hidden is the tick box again.
   */
  serviceBasis: string | null;
  /**
   * ⭐⭐ 0111. The key this rung was raised under, and whether the system
   * recorded one at all. `authorityRecorded === false` means the row
   * predates 0111 — not that nobody was authorised, which is a different
   * and much stronger claim the screen must not make.
   */
  authorisedPermission: string;
  authorityRecorded: boolean;
};

export function describeNoticeService(event: DunningEvent): NoticeServiceView {
  const grade = describeServiceEvidence(event.serviceEvidence);
  return {
    eventId: event.id,
    stage: event.stage,
    rung: event.rung,
    channel: event.channel,
    evidenceWord: grade.word,
    evidenceLabel: grade.label,
    machineVerified: grade.machineVerified,
    meaning: grade.meaning,
    raisedAt: event.raisedAt?.toISOString() ?? null,
    dispatchedAt: event.dispatchedAt?.toISOString() ?? null,
    servedAt: event.servedAt?.toISOString() ?? null,
    serviceReference: event.serviceReference,
    dispatchFailureReason: event.dispatchFailureReason,
    serviceBasis: event.serviceBasis,
    authorisedPermission: event.authorisedPermission,
    authorityRecorded: event.authorisedPermission !== AUTHORITY_NOT_RECORDED,
  };
}

/* ------------------------------------------------------------------ */
/* ⚠️ SERVICE A MACHINE CANNOT PROVE, RECORDED BY A PERSON WHO CAN      */
/* ------------------------------------------------------------------ */

/**
 * Record that a posted, couriered or hand-delivered notice was served.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THIS IS THE TICK BOX — AND IT IS DELIBERATELY NOT THE SAME TICK BOX
 * ══════════════════════════════════════════════════════════════════════
 * The defect being fixed was a person recording a send that never
 * happened. The fix is NOT to forbid people from recording things: most
 * builder-buyer agreements name registered post to the address in the
 * agreement as the mode of VALID SERVICE, and refusing to record it would
 * push the only legally effective channel out of the system entirely.
 *
 * ⭐ THE FIX IS THAT WHAT THEY RECORD IS A DIFFERENT, WEAKER CLAIM, AND
 * SAYS SO EVERYWHERE IT IS SHOWN. It lands as `human_recorded`, which
 * ① names the colleague stating it, ② carries a consignment reference
 * somebody can look up, ③ is refused a `dispatched_at` by CHECK, and
 * ④ renders as "Recorded by a person", never as "Dispatched".
 */
export async function recordPostalService(args: {
  tenantId: string;
  userId: string | null;
  eventId: string;
  reference: string;
  servedOn?: string | null;
  notes?: string | null;
}): Promise<{ ok: true; event: DunningEvent } | DunningFailure> {
  const { tenantId, eventId } = args;

  const existing = await withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(dunningEvents)
      .where(and(eq(dunningEvents.tenantId, tenantId), eq(dunningEvents.id, eventId)))
      .limit(1);
    return rows[0] ?? null;
  });

  if (!existing) return { ok: false, error: "That notice does not exist." };

  const verdict = validatePostalServiceClaim({
    channel: existing.channel,
    reference: args.reference,
    recordedBy: args.userId,
  });
  if (!verdict.ok) return { ok: false, error: verdict.error };

  /*
   * 🔴 A LEGACY ROW MAY BE GIVEN REAL EVIDENCE — AND IT ARRIVES AS WHAT
   * IT IS. If somebody finds the 2023 speed post receipt for a notice the
   * old system stamped `sent_at` on, that is a human holding a piece of
   * paper, so it is recorded as `human_recorded` with their name on it.
   * What no path in this codebase can do is turn the old `sent_at` into a
   * `dispatched_at` — the CHECK refuses it, and so does the absence of
   * any code that tries.
   */
  const now = new Date();
  const servedAt = args.servedOn ? new Date(`${args.servedOn}T00:00:00.000Z`) : now;

  const updated = await withTenant(tenantId, async (tx) => {
    const rows = await tx
      .update(dunningEvents)
      .set({
        serviceEvidence: "human_recorded",
        serviceRecordedBy: args.userId,
        serviceRecordedAt: now,
        serviceReference: verdict.reference,
        servedAt,
        /*
         * ⚠️ THE LEGACY COLUMN IS ALLOWED TO CARRY A VALUE ONLY NOW, when
         * there is finally something behind it. Old reports that still
         * read `sent_at` therefore stop being wrong about this row rather
         * than staying wrong quietly.
         */
        sentAt: servedAt,
        raisedAt: existing.raisedAt ?? existing.createdAt,
        notes: args.notes ?? existing.notes,
        updatedAt: now,
      })
      .where(and(eq(dunningEvents.tenantId, tenantId), eq(dunningEvents.id, eventId)))
      .returning();
    return rows[0] ?? null;
  });

  // ⚠️ AN EMPTY `returning()` IS A WRITE THAT DID NOT HAPPEN.
  if (!updated) return { ok: false, error: "The service record could not be saved." };
  return { ok: true, event: updated };
}

/* ------------------------------------------------------------------ */
/* ⭐⭐⭐ THE QUERY THE CANCELLATION SCREEN ASKS                        */
/* ------------------------------------------------------------------ */

/**
 * Every dunning event raised against a booking, graded.
 *
 * 🔴 THIS IS THE WHOLE POINT OF THE BATCH. A cancellation or forfeiture
 * is lawful only after the ladder was climbed AND SERVED, and until now
 * the cancellation flow could see that a notice EXISTED but not whether
 * anything ever left the building. `previewCancellationPosting` calls
 * this and refuses to stay silent about the answer.
 */
export async function noticeServiceForBooking(
  tenantId: string,
  bookingId: string,
): Promise<{ facts: NoticeServiceFacts[]; finding: ServiceGapFinding }> {
  const rows = await withTenant(tenantId, async (tx) =>
    tx
      .select()
      .from(dunningEvents)
      .innerJoin(
        demandNotices,
        and(
          eq(demandNotices.id, dunningEvents.demandId),
          eq(demandNotices.tenantId, dunningEvents.tenantId),
        ),
      )
      .where(
        and(
          eq(dunningEvents.tenantId, tenantId),
          eq(demandNotices.bookingId, bookingId),
        ),
      )
      .orderBy(dunningEvents.rung),
  );

  const facts = rows.map((row) => serviceFactsOf(row.dunning_events));
  return { facts, finding: cancellationServiceFinding(facts) };
}

/* ------------------------------------------------------------------ */
/* ⭐⭐⭐ SERVICE DEEMED, NOT PROVED                                    */
/* ------------------------------------------------------------------ */

/**
 * Record that a notice is served in law without proof of receipt.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THIS IS THE FIRST WRITER `deemed` HAS EVER HAD
 * ══════════════════════════════════════════════════════════════════════
 * The grade was declared in 0098, described with `strength: 3` — the
 * highest — and `supportsEnforcement: true`, so `noticeHasService` would
 * have cleared a cancellation on it. Nothing in the tree could produce
 * one. A grade that clears the gate before a forfeiture and has no writer
 * is the same defect this codebase keeps producing, in the most
 * expensive room in the product.
 *
 * ⚠️ IT IS WIRED RATHER THAN DELETED BECAUSE IT IS THE ORDINARY ENDING OF
 * A REAL CHASE. The allottee refuses the registered post and the cover
 * comes back endorsed. Under the agreement's service clause, and under
 * s.27 of the General Clauses Act 1897 for a properly addressed, prepaid
 * registered letter, that is good service. Without this the only records
 * available are a `human_recorded` claim of DELIVERY, which is false, or
 * nothing at all.
 *
 * ⭐ AND IT IS THE HARDEST CLAIM IN THE PRODUCT TO MAKE:
 *   • a different key — `receivables:warn_cancellation`, checked by the
 *     action, not `receivables:dun`;
 *   • a basis in words, stored and printed beside the grade;
 *   • a reference somebody can look up;
 *   • refused on any channel the outbox could have dispatched;
 *   • refused on a row that WAS dispatched, here and by the CHECK
 *     `dunning_events_human_record_is_not_a_dispatch` from 0098;
 *   • and `dunning_events_deemed_states_its_basis` (0111) refuses to
 *     store one that is missing any of it, whatever calls it.
 */
export async function recordDeemedService(args: {
  tenantId: string;
  userId: string | null;
  eventId: string;
  reference: string;
  basis: string;
  servedOn?: string | null;
  notes?: string | null;
}): Promise<{ ok: true; event: DunningEvent } | DunningFailure> {
  const { tenantId, eventId } = args;

  const existing = await withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(dunningEvents)
      .where(and(eq(dunningEvents.tenantId, tenantId), eq(dunningEvents.id, eventId)))
      .limit(1);
    return rows[0] ?? null;
  });

  if (!existing) return { ok: false, error: "That notice does not exist." };

  const verdict = validateDeemedServiceClaim({
    channel: existing.channel,
    alreadyDispatchedAt: existing.dispatchedAt,
    reference: args.reference,
    basis: args.basis,
    recordedBy: args.userId,
  });
  if (!verdict.ok) return { ok: false, error: verdict.error };

  const now = new Date();
  const servedAt = args.servedOn ? new Date(`${args.servedOn}T00:00:00.000Z`) : now;

  const updated = await withTenant(tenantId, async (tx) => {
    const rows = await tx
      .update(dunningEvents)
      .set({
        serviceEvidence: "deemed",
        serviceRecordedBy: args.userId,
        serviceRecordedAt: now,
        serviceReference: verdict.reference,
        serviceBasis: verdict.basis,
        servedAt,
        /*
         * ⚠️ THE LEGACY COLUMN IS FILLED ONLY NOW, when there is finally
         * something behind it — the same treatment `recordPostalService`
         * and the outbox give it. A report still reading `sent_at` stops
         * being wrong about this row rather than staying wrong quietly.
         */
        sentAt: servedAt,
        raisedAt: existing.raisedAt ?? existing.createdAt,
        notes: args.notes ?? existing.notes,
        updatedAt: now,
      })
      .where(and(eq(dunningEvents.tenantId, tenantId), eq(dunningEvents.id, eventId)))
      .returning();
    return rows[0] ?? null;
  });

  // ⚠️ AN EMPTY `returning()` IS A WRITE THAT DID NOT HAPPEN.
  if (!updated) return { ok: false, error: "The deeming could not be recorded." };
  return { ok: true, event: updated };
}

/* ------------------------------------------------------------------ */
/* ⭐⭐⭐ THE PREVIEW THAT COMES BEFORE A SEND                          */
/* ------------------------------------------------------------------ */

export type DunningPreview = {
  demandId: string;
  noticeNumber: string;
  bookingReference: string;
  /** ⭐ THE PERSON. Never an id on the confirm screen. */
  allotteeName: string;
  projectName: string;
  unitLabel: string;
  stage: DunningStage;
  rung: number;
  stageLabel: string;
  channel: DunningChannel;
  recipient: string | null;
  language: NoticeLanguage;
  /** Paise as a string. Never parsed — see the header of the board. */
  outstandingMinor: string;
  interestMinor: string;
  daysOverdue: number;
  dueDate: string;
  /** 🔴 The exact characters that would be stored and sent. */
  subject: string;
  body: string;
  wordsFellBack: boolean;
  /** ⚠️ False for post, courier and hand delivery. Not a failure. */
  wouldDispatch: boolean;
  /** The key the send will require, and whether this rung names a person. */
  permission: string;
  needsNamedAuthoriser: boolean;
  authorityWhy: string;
  /** ⚠️ Null when the ladder permits it. A sentence when it does not. */
  refusal: { reason: string; remedy: string } | null;
  statutory: StatutoryLadderContext;
};

/**
 * ⭐⭐ WHAT THE LETTER WOULD SAY, RENDERED BY THE CODE THAT WOULD SEND IT.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 IT CALLS `canEscalate` AND `renderDunningLetter`, THE SAME TWO
 *    FUNCTIONS `sendDunningLetter` CALLS, IN THE SAME ORDER
 * ══════════════════════════════════════════════════════════════════════
 * A preview assembled from its own copy of either would eventually show
 * one letter and send another, and the person confirming would be
 * confirming the wrong document — which is the exact failure a preview
 * exists to prevent. It writes nothing: no document row, no event row,
 * no outbox row.
 *
 * ⚠️ A REFUSAL IS RETURNED, NOT THROWN. The screen has to be able to show
 * the allottee, the amount and the reason the ladder will not permit this
 * rung on the same panel — "you cannot do this" with the account hidden
 * behind the error sends somebody to find a colleague who knows why.
 */
export async function previewDunningLetter(args: {
  tenantId: string;
  demandId: string;
  stage: DunningStage;
  channel: DunningChannel;
  language?: NoticeLanguage;
  recipient?: string | null;
  developerName: string;
  contactLine: string;
  asOf: string;
}): Promise<DunningPreview | DunningFailure> {
  const { tenantId, demandId, stage } = args;
  const asOf = toCivilDay(args.asOf);

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

  const verdict = canEscalate({
    currentStage: demand.dunningStage,
    to: stage,
    demandStatus: demand.status,
    dueDate: demand.dueDate,
    asOf,
    outstandingMinor: position.outstandingMinor,
    lastSentOn: gapDayOf(last),
    policy: policies.dunning,
    /*
     * ⚠️ THE PREVIEW ASKS THE GATE AS IF NOBODY HAD AUTHORISED YET, and
     * that is why a cancellation warning previews with a `needs_human`
     * refusal showing. It is the honest state: the reason has not been
     * written yet. The screen reads `needsNamedAuthoriser` and asks for
     * one; it does not hide the rung.
     */
    authorisedBy: null,
    authorisedReason: null,
  });

  const language = args.language ?? demand.language;
  const facts = noticeFactsFor({
    demand,
    booking,
    developerName: args.developerName,
    contactLine: args.contactLine,
    asOf,
  });
  const letter = renderDunningLetter(stage, { ...facts, language });

  const recipient = args.recipient ?? booking.buyerEmail ?? booking.buyerPhone ?? null;
  const authority = authorityForStage(stage);

  /*
   * ⭐ THE SAME THREE CONDITIONS `sendDunningLetter` USES, so the preview
   * cannot promise a dispatch the send will not attempt.
   */
  const wouldDispatch =
    channelCanBeMachineDispatched(args.channel) &&
    args.channel === "email" &&
    typeof recipient === "string" &&
    recipient.includes("@");

  return {
    demandId: demand.id,
    noticeNumber: demand.noticeNumber,
    bookingReference: booking.reference,
    allotteeName: booking.buyerName,
    projectName: booking.projectName,
    unitLabel: booking.unitLabel,
    stage,
    rung: authority.rung,
    stageLabel: authority.label,
    channel: args.channel,
    recipient,
    language,
    outstandingMinor: position.outstandingMinor.toString(),
    interestMinor: position.outstandingInterestMinor.toString(),
    daysOverdue: position.daysOverdue,
    dueDate: demand.dueDate,
    subject: letter.subject,
    body: letter.body,
    wordsFellBack: letter.wordsFellBack,
    wouldDispatch,
    permission: authority.permission,
    needsNamedAuthoriser: authority.needsNamedAuthoriser,
    authorityWhy: authority.why,
    refusal: verdict.allowed
      ? null
      : /*
         * ⚠️ `needs_human` IS NOT A REFUSAL ON A PREVIEW. It means "this
         * rung needs a reason and you have not typed one yet", which is
         * what the form is for. Reporting it as a refusal would make the
         * screen tell counsel they may not do the one thing only counsel
         * may do.
         */
        verdict.code === "needs_human"
        ? null
        : { reason: verdict.reason, remedy: verdict.remedy },
    statutory: statutoryLadderContext({
      stateCode: booking.projectStateCode,
      projectName: booking.projectName,
    }),
  };
}

/* ------------------------------------------------------------------ */
/* ⭐⭐⭐ THE BOARD                                                     */
/* ------------------------------------------------------------------ */

export type LadderBoardRow = {
  demandId: string;
  noticeNumber: string;
  bookingId: string;
  bookingReference: string;
  allotteeName: string;
  projectName: string;
  projectId: string | null;
  unitLabel: string;
  dueDate: string;
  daysOverdue: number;
  outstandingMinor: string;
  interestMinor: string;
  /** The rung the ladder says comes next, or null at the top / nothing due. */
  nextStage: DunningStage | null;
  nextRung: number | null;
  nextStageLabel: string | null;
  /** ⭐ `send` · `needs_decision` · `none` — the sweep's own vocabulary. */
  action: "send" | "needs_decision" | "none";
  reason: string;
  /** 🔴 The key the next rung needs. Null when there is no next rung. */
  nextPermission: string | null;
  /** Every rung already raised on this demand, graded. */
  history: NoticeServiceView[];
  /** ⚠️ Rungs raised with nothing behind them. Counted, not hidden. */
  unprovenCount: number;
  /** 🔴 Rungs whose authority this system never recorded. */
  unrecordedAuthorityCount: number;
  statutory: StatutoryLadderContext;
};

export type LadderBoard = {
  asOf: string;
  rows: LadderBoardRow[];
  /** ⚠️ True when more demands are overdue than this page shows. */
  truncated: boolean;
  /** The ladder, in order, with the right each rung needs. */
  authority: readonly RungAuthority[];
};

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐⭐ WHAT IS DUE FOR WHICH RUNG, AND WHAT WAS ACTUALLY SERVED BEFORE
 * ══════════════════════════════════════════════════════════════════════
 * `planDunningSweep` has answered the first half since Phase 38 and it
 * writes nothing, which is right. What it could not answer is the second
 * half — for each of those demands, which rungs have already gone out and
 * whether any of them has anything behind it. That is the question the
 * person deciding whether to climb one more rung is actually asking, and
 * without it the board would show "cancellation warning due" beside a
 * ladder whose first three rungs were never proved to have reached
 * anybody.
 *
 * 🔴 IT WRITES NOTHING AND IT SENDS NOTHING. Not one row. The send is a
 * separate act, one demand and one rung at a time, through
 * `sendDunningNotice` — see the board component for why there is no
 * "send all" on this screen and why there must never be one.
 *
 * ⚠️ POLICIES ARE LOADED ONCE, NOT PER DEMAND. `resolvePolicies` reads
 * every active policy row for the workspace and picks in memory, so
 * calling it fifty times was fifty round trips for one answer.
 */
export async function dunningBoard(args: {
  tenantId: string;
  projectId?: string;
  asOf: string;
  limit: number;
}): Promise<LadderBoard> {
  const { tenantId, asOf } = args;

  const demands = await withTenant(tenantId, async (tx) => {
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
      // ⚠️ ONE MORE THAN ASKED FOR, so the board can say it is showing a
      // page rather than implying it is showing the arrears.
      .limit(args.limit + 1);
  });

  const truncated = demands.length > args.limit;
  const page = truncated ? demands.slice(0, args.limit) : demands;

  const [policySets, contexts, events] = await Promise.all([
    loadPolicySets(tenantId),
    listBookingContexts(
      tenantId,
      page.map((d) => d.bookingId),
    ),
    listDunningEventsForDemands(
      tenantId,
      page.map((d) => d.id),
    ),
  ]);

  const rows: LadderBoardRow[] = page.map((demand) => {
    const policies = resolvePoliciesFrom(policySets, demand.projectId);
    const raised = events.get(demand.id) ?? [];
    const position = demandPosition(demandFacts(demand), asOf);
    const booking = contexts.get(demand.bookingId) ?? null;

    /*
     * ⚠️ THE GAP DAY COMES FROM THE HIGHEST RUNG ALREADY RAISED, through
     * `ladderGapInstant` — the same helper `sendDunningLetter` uses. A
     * board that computed pacing differently from the sender would offer
     * a rung the server then refuses for being too soon.
     */
    const last = raised.length > 0 ? (raised[raised.length - 1] ?? null) : null;

    const action = nextSweepAction({
      currentStage: demand.dunningStage,
      demandStatus: demand.status,
      dueDate: demand.dueDate,
      asOf,
      outstandingMinor: position.outstandingMinor,
      lastSentOn: gapDayOf(last),
      policy: policies.dunning,
    });

    const nextStage = action.kind === "none" ? null : action.stage;
    const authority = nextStage ? authorityForStage(nextStage) : null;

    const facts = raised.map(serviceFactsOf);

    return {
      demandId: demand.id,
      noticeNumber: demand.noticeNumber,
      bookingId: demand.bookingId,
      bookingReference: booking?.reference ?? "—",
      // ⚠️ A DELETED BOOKING IS SAID OUT LOUD RATHER THAN LEFT BLANK. A
      // blank here reads as "no name on file", which is a different and
      // much less alarming fact than "the booking is gone".
      allotteeName: booking?.buyerName ?? "⚠️ booking no longer on file",
      projectName: booking?.projectName ?? "—",
      projectId: demand.projectId,
      unitLabel: booking?.unitLabel ?? "—",
      dueDate: demand.dueDate,
      daysOverdue: position.daysOverdue,
      outstandingMinor: position.outstandingMinor.toString(),
      interestMinor: position.outstandingInterestMinor.toString(),
      nextStage,
      nextRung: authority?.rung ?? null,
      nextStageLabel: authority?.label ?? null,
      action: action.kind === "send" ? "send" : action.kind,
      reason:
        action.kind === "send"
          ? `Due for a ${authority?.label.toLowerCase() ?? action.stage.replace(/_/g, " ")}.`
          : action.reason,
      nextPermission: authority?.permission ?? null,
      history: raised.map(describeNoticeService),
      unprovenCount: facts.filter((f) => !noticeHasService(f)).length,
      unrecordedAuthorityCount: facts.filter(
        (f) => f.authorisedPermission === AUTHORITY_NOT_RECORDED,
      ).length,
      statutory: statutoryLadderContext({
        stateCode: booking?.projectStateCode ?? null,
        projectName: booking?.projectName ?? null,
      }),
    };
  });

  return { asOf, rows, truncated, authority: ladderAuthority() };
}

/**
 * Every rung raised against a page of demands, in one query, keyed by
 * demand and ordered up the ladder.
 */
async function listDunningEventsForDemands(
  tenantId: string,
  demandIds: readonly string[],
): Promise<Map<string, DunningEvent[]>> {
  const ids = [...new Set(demandIds)];
  const out = new Map<string, DunningEvent[]>();
  if (ids.length === 0) return out;

  const rows = await withTenant(tenantId, async (tx) =>
    tx
      .select()
      .from(dunningEvents)
      .where(
        and(
          eq(dunningEvents.tenantId, tenantId),
          inArray(dunningEvents.demandId, ids),
        ),
      )
      .orderBy(dunningEvents.rung),
  );

  for (const row of rows) {
    const list = out.get(row.demandId);
    if (list) list.push(row);
    else out.set(row.demandId, [row]);
  }
  return out;
}
