/**
 * Ordence — 🔴🔴 THREE FACTS ABOUT A DEMAND NOTICE, AND THEY ARE NOT ONE
 * Version: v1.55.0-alpha  ·  SQL 0098
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT `dunning_events` USED TO DO
 * ══════════════════════════════════════════════════════════════════════
 * `sent_at timestamptz NOT NULL DEFAULT now()`. The column was populated
 * by the act of INSERTING the row. Nothing sent anything — there was no
 * mail call anywhere below `sendDunningLetter`. `db/schema/messaging.ts`
 * had already written the sentence down: *"the row was written by a
 * person ticking a box, and nothing was ever sent."*
 *
 * ⚠️ THAT IS NOT A MISSING FEATURE. IT IS MANUFACTURED EVIDENCE.
 * A demand notice under a RERA allotment is the step before interest
 * accrues, before the allotment can be cancelled and before money a
 * family has paid can be forfeited. `dunning_events` is the record of
 * service — the developer's proof that the allottee was given every
 * chance. A developer who cancels relying on `sent_at` is relying on a
 * timestamp for a letter the allottee never received; at the Authority
 * that is the developer's own system testifying against them, and the
 * allottee is the person who was actually wronged.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ SO THERE ARE THREE FACTS AND THEY ARE THREE DIFFERENT CLAIMS
 * ══════════════════════════════════════════════════════════════════════
 *   RAISED     — a person at the developer decided to demand. Always
 *                true of every row, because the row exists.
 *   DISPATCHED — it left our system, and the provider handed back a
 *                message id. Only the machine can assert this.
 *   SERVED     — it reached the allottee, or is deemed to have. Under
 *                most builder–buyer agreements this is the one that
 *                counts, and it is the one we most often cannot know.
 *
 * 🔴 A SINGLE `sent_at` COLLAPSED ALL THREE INTO THE WEAKEST ONE while
 * displaying it as the strongest. This file is the vocabulary that keeps
 * them apart, and SQL 0098 is the CHECK that makes collapsing them
 * impossible rather than discouraged.
 *
 * Pure and isomorphic. No database, no `server-only`. The screen and the
 * server must grade evidence identically or the screen is lying again.
 */

/* ------------------------------------------------------------------ */
/* THE GRADES                                                          */
/* ------------------------------------------------------------------ */

/**
 * ⭐ EVERY STATE CARRIES A WORD. `dispatched === false` is a boolean two
 * screens will render differently; `"raised_only"` is a word that means
 * the same thing in a server log, a JSON payload and a table cell.
 *
 *   none              — RAISED ONLY. Nothing has left the building.
 *   system_dispatch   — the outbox sent it and Resend returned an id.
 *   human_recorded    — ⚠️ a person says they posted or handed it over.
 *   deemed            — served in law without proof of receipt (refused
 *                       delivery, address in the agreement, etc.).
 *   legacy_unverified — 🔴 written before 0098, when `sent_at` was set by
 *                       the insert. Unknowable. Never promoted.
 */
export const SERVICE_EVIDENCE_GRADES = [
  "none",
  "system_dispatch",
  "human_recorded",
  "deemed",
  "legacy_unverified",
] as const;

export type ServiceEvidenceGrade = (typeof SERVICE_EVIDENCE_GRADES)[number];

export function isServiceEvidenceGrade(value: unknown): value is ServiceEvidenceGrade {
  return (
    typeof value === "string" &&
    (SERVICE_EVIDENCE_GRADES as readonly string[]).includes(value)
  );
}

/**
 * ⚠️ THE CHANNELS A MACHINE CAN ACTUALLY PROVE.
 *
 * `email` drains through `server/email/outbox.ts`; `whatsapp` through
 * `message_sends` (0066). Everything else — post, courier, hand delivery
 * — physically cannot produce a provider message id, so `system_dispatch`
 * is refused for those by a CHECK rather than by a code review.
 */
export const MACHINE_DISPATCHABLE_CHANNELS = ["email", "whatsapp"] as const;

export function channelCanBeMachineDispatched(channel: string): boolean {
  return (MACHINE_DISPATCHABLE_CHANNELS as readonly string[]).includes(channel);
}

/* ------------------------------------------------------------------ */
/* HOW STRONG IS IT, AND WHAT DO WE SAY ON SCREEN                      */
/* ------------------------------------------------------------------ */

export type EvidenceDescription = {
  /** 🔴 The WORD. Stable across the wire; never localised. */
  readonly word: ServiceEvidenceGrade;
  /** Short label for a badge. */
  readonly label: string;
  /**
   * ⭐ 0..3. Ordering exists so a screen can sort and a gate can compare
   * without re-deciding which grade beats which — the decision that, made
   * twice, is made differently.
   */
  readonly strength: 0 | 1 | 2 | 3;
  /**
   * 🔴 TRUE ONLY WHEN A MACHINE PROVED IT. A human's tick is never
   * `verified`, however honest the human. That distinction is the entire
   * point of this file.
   */
  readonly machineVerified: boolean;
  /** ⚠️ Whether this grade may be relied on to cancel or forfeit. */
  readonly supportsEnforcement: boolean;
  /** One sentence, written for the person about to cancel an allotment. */
  readonly meaning: string;
};

const DESCRIPTIONS: Record<ServiceEvidenceGrade, EvidenceDescription> = {
  none: {
    word: "none",
    label: "Raised — not dispatched",
    strength: 0,
    machineVerified: false,
    supportsEnforcement: false,
    meaning:
      "This notice was raised but has not left our system. Nothing has been sent to the allottee and nothing has been recorded as delivered by hand or by post.",
  },
  legacy_unverified: {
    word: "legacy_unverified",
    label: "Legacy — unverified",
    strength: 0,
    machineVerified: false,
    supportsEnforcement: false,
    meaning:
      "Recorded before service was tracked separately. The old system stamped a send time when the row was created, whether or not anything was sent, so this row proves only that somebody raised the notice.",
  },
  human_recorded: {
    word: "human_recorded",
    label: "Recorded by a person",
    strength: 1,
    machineVerified: false,
    supportsEnforcement: true,
    meaning:
      "A named colleague recorded that this notice was posted or handed over, and gave a reference. It is their statement, not a system record — the postal receipt is the evidence, not this row.",
  },
  system_dispatch: {
    word: "system_dispatch",
    label: "Dispatched by the system",
    strength: 2,
    machineVerified: true,
    supportsEnforcement: true,
    meaning:
      "This notice left our system and the provider acknowledged it with a message id. Dispatch is not the same as receipt, but it is ours to prove.",
  },
  deemed: {
    word: "deemed",
    label: "Deemed served",
    strength: 3,
    machineVerified: false,
    supportsEnforcement: true,
    meaning:
      "Recorded as served in law without proof of receipt — refused delivery, or delivery to the address named in the agreement.",
  },
};

export function describeServiceEvidence(grade: string): EvidenceDescription {
  return isServiceEvidenceGrade(grade)
    ? DESCRIPTIONS[grade]
    : /*
       * ⚠️ AN UNKNOWN GRADE IS THE WEAKEST GRADE, NEVER THE STRONGEST. A
       * value this build has never heard of came from a newer writer or a
       * corrupted row; resolving it optimistically is how an unrecognised
       * string becomes a cancellation.
       */
      DESCRIPTIONS.none;
}

/* ------------------------------------------------------------------ */
/* THE FACTS OF ONE ROW                                                */
/* ------------------------------------------------------------------ */

/**
 * The subset of a `dunning_events` row that decides evidential weight.
 * Deliberately not the whole row: this must be callable from a test and
 * from a screen without dragging a Drizzle type through the boundary.
 */
export type NoticeServiceFacts = {
  readonly stage: string;
  readonly rung: number;
  readonly channel: string;
  readonly serviceEvidence: string;
  readonly raisedAt: Date | null;
  readonly dispatchedAt: Date | null;
  readonly dispatchProviderMessageId: string | null;
  readonly dispatchFailureReason: string | null;
  readonly servedAt: Date | null;
  readonly serviceRecordedAt: Date | null;
  readonly serviceReference: string | null;
  /** 🔴 Legacy only. Present on pre-0098 rows and meaningless. */
  readonly legacySentAt: Date | null;
};

/**
 * ⭐⭐ IS THERE ANYTHING BEHIND THIS ROW AT ALL?
 *
 * ⚠️ IT DOES NOT TRUST THE GRADE ALONE. `system_dispatch` without a
 * provider message id is a row somebody wrote by hand, and the whole
 * defect being fixed here is a column that was believed because of what
 * it was called.
 */
export function noticeHasService(facts: NoticeServiceFacts): boolean {
  const grade = describeServiceEvidence(facts.serviceEvidence);
  if (!grade.supportsEnforcement) return false;
  if (grade.word === "system_dispatch") {
    return facts.dispatchedAt !== null && Boolean(facts.dispatchProviderMessageId);
  }
  if (grade.word === "human_recorded") {
    return (
      facts.serviceRecordedAt !== null && Boolean(facts.serviceReference?.trim())
    );
  }
  return facts.servedAt !== null;
}

/**
 * ⚠️ THE INSTANT THE LADDER'S MINIMUM-GAP ARITHMETIC USES, AND NOTHING
 * ELSE.
 *
 * 🔴 IT FALLS BACK TO `raisedAt` ON PURPOSE, AND THAT IS NOT A BACK DOOR.
 * The gap rule exists so a buyer is not hit with four letters in a week.
 * If we returned null for an undispatched rung the gate would read it as
 * "nothing has been sent yet" and permit the next rung IMMEDIATELY —
 * turning an evidence fix into a harassment bug. Falling back to the
 * raise time keeps the gap conservative. It says nothing about service,
 * and no caller may use it to claim any.
 */
export function ladderGapInstant(facts: NoticeServiceFacts): Date | null {
  return (
    facts.servedAt ??
    facts.dispatchedAt ??
    facts.serviceRecordedAt ??
    facts.raisedAt ??
    facts.legacySentAt ??
    null
  );
}

/* ------------------------------------------------------------------ */
/* ⭐⭐⭐ THE FINDING THAT BELONGS IN FRONT OF A CANCELLATION           */
/* ------------------------------------------------------------------ */

export type ServiceGapFinding = {
  /** 🔴 The WORD this whole finding is in. */
  readonly word: "clear" | "unproven_service" | "no_ladder";
  readonly blocking: boolean;
  readonly headline: string;
  readonly detail: string;
  /** Rungs raised with nothing behind them, weakest first. */
  readonly unprovenStages: readonly string[];
  readonly legacyStages: readonly string[];
};

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE ONE PLACE THIS DEFECT ACTUALLY COSTS SOMEBODY THEIR HOME
 * ══════════════════════════════════════════════════════════════════════
 * Cancelling an allotment and forfeiting what has been paid is lawful
 * only after the ladder has been climbed AND SERVED. Ordence has a
 * cancellation flow — `previewCancellationPosting` in
 * `server/actions/sales-bookings.ts`, rendered by
 * `app/(crm)/sales/cancellations` — and until now it could see that a
 * notice EXISTED but not whether anything was ever sent.
 *
 * ⚠️ THIS RETURNS A BLOCKING FINDING, NOT A REFUSAL, and that is
 * deliberate for the same reason `forfeitureWarning` warns: the developer
 * may have served the notice by a route this system never saw, and a
 * product that refuses on incomplete knowledge gets worked around within
 * a week. What it may not do is stay silent.
 *
 * ⭐ LEGACY ROWS COUNT AS UNPROVEN AND ARE NAMED SEPARATELY. They are not
 * evidence of service and they are not evidence of failure either; they
 * are evidence that the old system could not tell the difference, which
 * is exactly what the person about to cancel needs to be told.
 */
export function cancellationServiceFinding(
  notices: readonly NoticeServiceFacts[],
): ServiceGapFinding {
  if (notices.length === 0) {
    return {
      word: "no_ladder",
      blocking: true,
      headline: "No demand notice has been raised against this booking.",
      detail:
        "Cancellation and forfeiture normally follow a served ladder of demand notices. There are none on file here, so nothing in this system evidences that the allottee was given a chance to pay.",
      unprovenStages: [],
      legacyStages: [],
    };
  }

  const unproven: string[] = [];
  const legacy: string[] = [];

  for (const notice of notices) {
    if (noticeHasService(notice)) continue;
    unproven.push(notice.stage);
    if (describeServiceEvidence(notice.serviceEvidence).word === "legacy_unverified") {
      legacy.push(notice.stage);
    }
  }

  if (unproven.length === 0) {
    return {
      word: "clear",
      blocking: false,
      headline: "Every demand notice on this booking has service behind it.",
      detail:
        "Each rung was either dispatched by the system with a provider message id, or recorded as served by a named colleague with a reference.",
      unprovenStages: [],
      legacyStages: [],
    };
  }

  const named = unproven.map((s) => s.replace(/_/g, " ")).join(", ");
  const legacyClause =
    legacy.length > 0
      ? ` ${legacy.length} of them predate service tracking: the old system stamped a send time when the row was created, so that timestamp proves nothing and has deliberately not been converted into a dispatch record.`
      : "";

  return {
    word: "unproven_service",
    blocking: true,
    headline: `${unproven.length} demand notice(s) were raised but never proven to have been served.`,
    detail:
      `Raised without service: ${named}. Cancelling or forfeiting on this file means relying on notices this system cannot show were ever sent to the allottee.${legacyClause}` +
      " Dispatch them, or record the postal or hand delivery with its reference, before you post.",
    unprovenStages: unproven,
    legacyStages: legacy,
  };
}

/* ------------------------------------------------------------------ */
/* WHAT A HUMAN MUST SUPPLY TO RECORD POSTAL SERVICE                   */
/* ------------------------------------------------------------------ */

export type PostalServiceClaim = {
  readonly channel: string;
  readonly reference: string;
  readonly recordedBy: string | null;
};

export type PostalServiceVerdict =
  | { readonly ok: true; readonly reference: string }
  | { readonly ok: false; readonly error: string };

/**
 * ⚠️ A REFERENCE IS NOT OPTIONAL AND IT IS NOT A FORMAT CHECK.
 *
 * India Post speed post consignment numbers, RPAD receipts and courier
 * AWBs have three different shapes and every courier invents a fourth, so
 * refusing on a regex would refuse real evidence. What is refused is an
 * EMPTY one — because "posted" with nothing to look up is a tick box, and
 * a tick box that renders like a verified send is the defect this batch
 * exists to remove.
 */
export function validatePostalServiceClaim(
  claim: PostalServiceClaim,
): PostalServiceVerdict {
  if (channelCanBeMachineDispatched(claim.channel)) {
    return {
      ok: false,
      error:
        "This notice goes by a channel the system can dispatch itself. Let it send, so the record carries a provider message id rather than somebody's word.",
    };
  }
  const reference = claim.reference.trim();
  if (reference.length < 4) {
    return {
      ok: false,
      error:
        "Give the speed post, RPAD or courier reference. Without one there is nothing anybody can look up, and a notice nobody can look up is not evidence of service.",
    };
  }
  if (!claim.recordedBy) {
    return {
      ok: false,
      error:
        "Recording service by post names the person who is stating it. There is no signed-in user on this request.",
    };
  }
  return { ok: true, reference };
}
