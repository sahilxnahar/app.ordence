import "server-only";

/**
 * Ordence — ⭐ Raising and Issuing Demands
 * Version: v0.38.0-alpha
 *
 * The write path for the legal document. Every rule it applies comes from
 * `lib/receivables/` — this file loads the rows the rule needs, calls it,
 * and writes what it returns.
 *
 * ⚠️ IT DOES NOT MAKE THE GUARANTEES. One live demand per milestone, the
 * frozen figures on an issued demand and the balancing totals are
 * constraints and triggers in `SQL-FILES/0027_phase38_receivables.sql`,
 * because this file is one of several write paths — a back-fill of a
 * year's history and a support fix at a psql prompt are the others — and
 * a rule enforced in one place is a rule the others bypass.
 *
 * ⚠️ AND THE INTEREST TERMS ARE COPIED ON TO THE DEMAND, NOT REFERENCED.
 * A policy edited in March must not silently restate what a January
 * notice said. The notice is a document that was served; a system that
 * recomputes served documents from current settings cannot answer "what
 * did we tell them?", which is the only question that matters afterwards.
 */

import { and, eq, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import {
  demandNotices,
  demandNoticeDocuments,
  type DemandNotice,
  type NoticeLanguage,
} from "@/db/schema/receivables";
import { financialYearOf, toCivilDay } from "@/lib/gst/constants";
import { buildDemand, demandPosition } from "@/lib/receivables/demand";
import { addDays } from "@/lib/receivables/interest";
import {
  buildInterestBasisNote,
  normaliseLanguage,
  renderDemandNotice,
  type NoticeFacts,
} from "@/lib/receivables/templates";
import { toBigIntAmount } from "@/lib/billing/money";
import type { RaiseDemandInput } from "@/lib/validators/receivables";
import {
  demandFacts,
  findBookingContext,
  findMilestone,
  interestTermsOf,
  nextDemandNumber,
  resolvePolicies,
  type BookingContext,
} from "./registry";

export type DemandWriteFailure = { ok: false; error: string; remedy?: string };
export type RaiseDemandOutcome =
  | { ok: true; demand: DemandNotice; rateFlagged: boolean; rateMessage: string }
  | DemandWriteFailure;

const REFERENCE_RETRY_LIMIT = 5;

/* ------------------------------------------------------------------ */
/* RAISE                                                               */
/* ------------------------------------------------------------------ */

/**
 * Draft a demand against a milestone whose trigger has been achieved.
 *
 * ⚠️ IT IS A DRAFT. Nothing has been served on anybody until
 * `issueDemand` runs, and the SQL CHECK `demand_notices_ladder_follows_issue`
 * makes sure nothing can be chased before then. The two-step exists
 * because the figures are frozen at ISSUE — see SQL 0027 §7 — and a
 * one-step create would freeze a typo.
 */
export async function raiseDemand(args: {
  tenantId: string;
  userId: string | null;
  input: RaiseDemandInput;
}): Promise<RaiseDemandOutcome> {
  const { tenantId, userId, input } = args;

  const booking = await findBookingContext(tenantId, input.bookingId);
  if (!booking) {
    return { ok: false, error: "That booking does not exist in this workspace." };
  }

  const milestone = await findMilestone(tenantId, input.milestoneId);
  if (!milestone || milestone.bookingId !== input.bookingId) {
    return {
      ok: false,
      error:
        "That milestone does not belong to this booking. A demand is raised against " +
        "the payment plan of the booking it names — anything else would put a stage " +
        "from one buyer's plan on another buyer's notice.",
    };
  }

  const policies = await resolvePolicies(tenantId, booking.projectId);

  const built = buildDemand({
    milestone: {
      id: milestone.id,
      label: milestone.label,
      sequence: milestone.sequence,
      amountMinor: toBigIntAmount(milestone.amountMinor),
      amountPaidMinor: toBigIntAmount(milestone.amountPaidMinor),
    },
    trigger: {
      kind: input.triggerKind,
      label: input.triggerLabel,
      achievedOn: input.triggerAchievedOn,
      evidence: input.triggerEvidence ?? null,
    },
    noticeDate: input.noticeDate,
    policy: policies.receivable,
    taxKind: input.taxKind,
    placeOfSupplyCode: input.placeOfSupplyCode,
    principalOverrideMinor: input.principalMinor,
    hsnSacCode: input.hsnSacCode ?? null,
  });

  if (!built.ok) {
    return { ok: false, error: built.problem.message, remedy: built.problem.remedy };
  }

  const demand = built.demand;

  // ⭐ The language the buyer reads, from `leads.preferred_lang` — the
  // column that has existed since Phase 22 saying exactly why.
  const language: NoticeLanguage =
    input.language ?? normaliseLanguage(booking.preferredLang);

  const dueDate = input.dueDate
    ? toCivilDay(input.dueDate)
    : demand.dueDate;

  // ⚠️ THE BASIS NOTE IS WRITTEN IN THE NOTICE'S LANGUAGE, from the same
  // terms the arithmetic uses. Interest must not compound silently, and a
  // sentence in a language the buyer does not read says nothing at all.
  const interestBasisNote = buildInterestBasisNote({
    terms: demand.interestTerms,
    dueDate,
    language,
  });

  const financialYear = financialYearOf(demand.noticeDate);

  let lastError: unknown = null;
  for (let attempt = 0; attempt < REFERENCE_RETRY_LIMIT; attempt += 1) {
    try {
      const inserted = await withTenant(tenantId, async (tx) => {
        const noticeNumber = await nextDemandNumber(tx, financialYear, attempt);

        const rows = await tx
          .insert(demandNotices)
          .values({
            tenantId,
            noticeNumber,
            bookingId: booking.bookingId,
            milestoneId: milestone.id,
            projectId: booking.projectId,
            leadId: booking.leadId,
            status: "draft",
            triggerKind: demand.trigger.kind,
            triggerLabel: demand.trigger.label,
            triggerAchievedOn: demand.trigger.achievedOn,
            triggerEvidence: demand.trigger.evidence ?? null,
            noticeDate: demand.noticeDate,
            dueDate,
            principalMinor: demand.amounts.principalMinor,
            gstRateBps: demand.amounts.gstRateBps,
            cgstMinor: demand.amounts.cgstMinor,
            sgstMinor: demand.amounts.sgstMinor,
            igstMinor: demand.amounts.igstMinor,
            cessMinor: demand.amounts.cessMinor,
            taxMinor: demand.amounts.taxMinor,
            totalMinor: demand.amounts.totalMinor,
            interestRateBps: demand.interestTerms.rateBps,
            referenceRateBps: policies.receivable.referenceRateBps,
            // ⭐ Computed at raise time and stored. The comparison must be
            // against the reference rate that applied when the demand was
            // made — MCLR moves, and a demand is judged as at its date.
            rateExceedsReference: demand.rateVerdict.exceedsReference,
            compounding: demand.interestTerms.compounding,
            dayCount: demand.interestTerms.dayCount,
            graceDays: demand.interestTerms.graceDays,
            interestBasisNote,
            language,
            notes: input.notes ?? null,
            createdBy: userId,
          })
          .returning();

        return rows[0] ?? null;
      });

      if (!inserted) {
        return { ok: false, error: "The demand could not be created." };
      }

      return {
        ok: true,
        demand: inserted,
        rateFlagged: demand.rateVerdict.exceedsReference,
        rateMessage: demand.rateVerdict.message,
      };
    } catch (err) {
      if (!isNumberCollision(err)) throw err;
      lastError = err;
    }
  }

  throw lastError ??
    new Error(`Could not allocate a demand number after ${REFERENCE_RETRY_LIMIT} attempts.`);
}

function isNumberCollision(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const candidate = err as { code?: unknown; constraint?: unknown; message?: unknown };
  if (candidate.code !== "23505") return false;
  const name = "demand_notices_number_tenant_unique";
  if (candidate.constraint === name) return true;
  return typeof candidate.message === "string" && candidate.message.includes(name);
}

/* ------------------------------------------------------------------ */
/* ISSUE                                                               */
/* ------------------------------------------------------------------ */

export type IssueDemandOutcome =
  | {
      ok: true;
      demand: DemandNotice;
      documents: Array<{
        language: NoticeLanguage;
        subject: string;
        body: string;
        wordsFellBack: boolean;
      }>;
    }
  | DemandWriteFailure;

/**
 * ⭐ SERVE IT. This is the act that creates a legal document under RERA.
 *
 * ⚠️ THE RENDERED BODY IS STORED, PER LANGUAGE, WITH A HASH. "What did
 * your notice actually say?" is the first question in every dispute,
 * asked about a notice sent two releases ago — and re-rendering from the
 * template later answers a question about today's code rather than about
 * the document in the buyer's hand.
 */
export async function issueDemand(args: {
  tenantId: string;
  userId: string | null;
  demandId: string;
  languages?: readonly NoticeLanguage[];
  developerName: string;
  contactLine: string;
  asOf: string;
}): Promise<IssueDemandOutcome> {
  const { tenantId, userId, demandId, asOf } = args;

  const existing = await withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(demandNotices)
      .where(and(eq(demandNotices.tenantId, tenantId), eq(demandNotices.id, demandId)))
      .limit(1);
    return rows[0] ?? null;
  });

  if (!existing) return { ok: false, error: "That demand does not exist." };
  if (existing.status !== "draft") {
    return {
      ok: false,
      error:
        "This demand has already been issued. ⚠️ An issued demand cannot be re-issued " +
        "or edited — the buyer holds a copy and their copy is the one that counts. " +
        "Raise a corrected demand and mark this one superseded; both then stay in " +
        "the record.",
    };
  }

  const booking = await findBookingContext(tenantId, existing.bookingId);
  if (!booking) return { ok: false, error: "That booking no longer exists." };

  const languages =
    args.languages && args.languages.length > 0
      ? [...new Set(args.languages)]
      : [existing.language];

  const facts = noticeFactsFor({
    demand: existing,
    booking,
    developerName: args.developerName,
    contactLine: args.contactLine,
    asOf,
  });

  const rendered = languages.map((language) =>
    renderDemandNotice({ ...facts, language }),
  );

  const issued = await withTenant(tenantId, async (tx) => {
    const rows = await tx
      .update(demandNotices)
      .set({ status: "issued", issuedAt: new Date(), issuedBy: userId })
      .where(and(eq(demandNotices.tenantId, tenantId), eq(demandNotices.id, demandId)))
      .returning();

    for (const doc of rendered) {
      await tx.insert(demandNoticeDocuments).values({
        tenantId,
        demandId,
        language: doc.language,
        templateKey: doc.templateKey,
        templateVersion: doc.templateVersion,
        subject: doc.subject,
        body: doc.body,
        bodyHash: await sha256Hex(doc.body),
        amountInWords: doc.amountInWords,
        wordsLanguage: doc.wordsLanguage,
        wordsFellBack: doc.wordsFellBack,
        renderedBy: userId,
      });
    }

    // ⚠️ NOTHING IS WRITTEN TO `payment_milestones` HERE, AND THAT IS A
    // DECISION RATHER THAN AN OMISSION. Its status is DERIVED from what
    // has been RECEIVED (`deriveMilestoneStatus`, Phase 22), and a demand
    // is a request rather than a receipt. Stamping a status on issue
    // would make a demanded-but-unpaid milestone indistinguishable from a
    // paid one on every Phase 22 screen — which is exactly the confusion
    // that phase's comment on the column warns about.

    return rows[0] ?? null;
  });

  if (!issued) return { ok: false, error: "The demand could not be issued." };

  return {
    ok: true,
    demand: issued,
    documents: rendered.map((doc) => ({
      language: doc.language,
      subject: doc.subject,
      body: doc.body,
      wordsFellBack: doc.wordsFellBack,
    })),
  };
}

/* ------------------------------------------------------------------ */
/* CANCEL AND SUPERSEDE                                                */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ CANCELLED IS NOT DELETED AND IT IS NOT SUPERSEDED.
 *
 * The row stays — there is no DELETE grant — because a demand that was
 * served and then withdrawn is a fact about the account that a buyer can
 * produce and the developer cannot. `cancel_reason` is NOT NULL for the
 * same reason.
 */
export async function cancelDemand(args: {
  tenantId: string;
  demandId: string;
  reason: string;
}): Promise<{ ok: true; demand: DemandNotice } | DemandWriteFailure> {
  const { tenantId, demandId, reason } = args;

  const updated = await withTenant(tenantId, async (tx) => {
    const rows = await tx
      .update(demandNotices)
      .set({ status: "cancelled", cancelledAt: new Date(), cancelReason: reason })
      .where(
        and(
          eq(demandNotices.tenantId, tenantId),
          eq(demandNotices.id, demandId),
          // ⚠️ A demand with money against it may not be cancelled. That
          // money would have nowhere to sit, and the buyer's statement
          // would show a payment applied to a document that no longer
          // asks for anything.
          eq(demandNotices.allocatedMinor, sql`0`),
        ),
      )
      .returning();
    return rows[0] ?? null;
  });

  if (!updated) {
    return {
      ok: false,
      error:
        "That demand could not be cancelled — it does not exist, or money has already " +
        "been applied to it. A demand that has been part paid is superseded by a " +
        "corrected one, not withdrawn: the payment has to keep a document to sit " +
        "against.",
    };
  }

  return { ok: true, demand: updated };
}

export async function supersedeDemand(args: {
  tenantId: string;
  demandId: string;
  replacementDemandId: string;
  reason: string;
}): Promise<{ ok: true; demand: DemandNotice } | DemandWriteFailure> {
  const { tenantId, demandId, replacementDemandId, reason } = args;

  if (demandId === replacementDemandId) {
    return { ok: false, error: "A demand cannot supersede itself." };
  }

  const updated = await withTenant(tenantId, async (tx) => {
    const replacement = await tx
      .select({ id: demandNotices.id, milestoneId: demandNotices.milestoneId })
      .from(demandNotices)
      .where(
        and(
          eq(demandNotices.tenantId, tenantId),
          eq(demandNotices.id, replacementDemandId),
        ),
      )
      .limit(1);

    if (!replacement[0]) return null;

    const rows = await tx
      .update(demandNotices)
      .set({
        status: "superseded",
        supersededById: replacementDemandId,
        cancelReason: reason,
        cancelledAt: new Date(),
      })
      .where(
        and(
          eq(demandNotices.tenantId, tenantId),
          eq(demandNotices.id, demandId),
          // ⚠️ NOTHING APPLIED, THE SAME RULE AS A CANCELLATION, AND FOR A
          // REASON THAT SHOWS UP IN THE STATEMENT OF ACCOUNT.
          //
          // A superseded demand is excluded from the statement's totals —
          // it was replaced, and counting both would demand the same money
          // twice on the face of the document. If it still carried a
          // buyer's payment, that payment would vanish from the summary
          // while remaining visible on the receipt line, and the statement
          // would stop footing.
          //
          // So the money moves first: re-apply the receipt to the
          // replacement demand (`receivables:allocate`), then supersede.
          eq(demandNotices.allocatedMinor, sql`0`),
        ),
      )
      .returning();
    return rows[0] ?? null;
  });

  if (!updated) {
    return {
      ok: false,
      error:
        "That demand could not be superseded — it does not exist, the replacement " +
        "does not exist, or money has already been applied to it. Move the payment " +
        "on to the corrected demand first: a superseded demand is left out of the " +
        "statement of account, and a payment sitting on one would disappear from " +
        "the summary while still showing on the receipt.",
    };
  }

  return { ok: true, demand: updated };
}

/* ------------------------------------------------------------------ */
/* NOTICE FACTS                                                        */
/* ------------------------------------------------------------------ */

/**
 * Everything a template needs, from a demand and its booking.
 *
 * ⚠️ THE INTEREST IS RECOMPUTED AS AT `asOf` AND THE BASIS NOTE IS NOT.
 * The figure moves daily; the sentence that says how it is worked out was
 * fixed when the document was served, and a notice whose stated basis
 * changed after service would be a different document.
 */
export function noticeFactsFor(args: {
  demand: DemandNotice;
  booking: BookingContext;
  developerName: string;
  contactLine: string;
  asOf: string;
}): NoticeFacts {
  const { demand, booking } = args;
  const position = demandPosition(demandFacts(demand), args.asOf);

  return {
    language: demand.language,
    developerName: args.developerName,
    buyerName: booking.buyerName,
    projectName: booking.projectName,
    unitLabel: booking.unitLabel,
    noticeNumber: demand.noticeNumber,
    noticeDate: demand.noticeDate,
    dueDate: demand.dueDate,
    triggerLabel: demand.triggerLabel,
    triggerAchievedOn: demand.triggerAchievedOn,
    principalMinor: toBigIntAmount(demand.principalMinor),
    taxMinor: toBigIntAmount(demand.taxMinor),
    totalMinor: toBigIntAmount(demand.totalMinor),
    outstandingMinor: position.outstandingMinor,
    interestMinor: position.outstandingInterestMinor,
    payableMinor: position.payableTodayMinor,
    daysOverdue: position.daysOverdue,
    interestBasisNote: demand.interestBasisNote,
    contactLine: args.contactLine,
  };
}

/** The day a demand's interest terms say the grace expires. */
export function graceEndsOn(demand: DemandNotice): string {
  return addDays(demand.dueDate, interestTermsOf(demand).graceDays);
}

/* ------------------------------------------------------------------ */
/* HASHING                                                             */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ `node:crypto` VIA A DYNAMIC IMPORT, not `globalThis.crypto.subtle`.
 * The Web Crypto digest is async and available in both runtimes, but this
 * module already runs server-side only, and a static `node:crypto` import
 * would keep it out of the Edge runtime for a hash. Same approach as
 * `lib/tally/keys.ts`.
 */
async function sha256Hex(value: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(value, "utf8").digest("hex");
}
