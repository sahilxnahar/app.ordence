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
  /**
   * ⭐ 0111. The clause or section relied on when service is DEEMED
   * rather than proved. Required for `deemed` by a CHECK, and null on
   * every other grade — a dispatch does not rest on a legal fiction.
   */
  readonly serviceBasis: string | null;
  /**
   * ⭐⭐ 0111. The permission key this rung was raised under.
   *
   * 🔴 `'legacy_unrecorded'` ON EVERY ROW WRITTEN BEFORE 0111, filled by
   * the ADD COLUMN's default rather than by an UPDATE — the same trick
   * 0098 used, for the same reason. It is not "unknown"; it is "this
   * system never recorded it", which is a different sentence and the one
   * the person about to cancel needs.
   */
  readonly authorisedPermission: string;
  /** 🔴 Legacy only. Present on pre-0098 rows and meaningless. */
  readonly legacySentAt: Date | null;
};

/**
 * ⭐ THE VALUE 0111's `ADD COLUMN … DEFAULT` STAMPED ONTO HISTORY.
 * Exported because three files compare against it and a fourth would
 * otherwise spell it differently.
 */
export const AUTHORITY_NOT_RECORDED = "legacy_unrecorded";

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
  /*
   * ⚠️ `deemed` IS THE STRONGEST GRADE AND THE ONLY ONE NO MACHINE
   * TOUCHES, so it is the one to check hardest. A row graded `deemed`
   * with no stated basis is somebody's conclusion with a badge on it —
   * exactly the shape of the defect 0098 removed, one grade higher up.
   * The CHECK in 0111 refuses to store one; this refuses to believe one
   * that arrived any other way.
   */
  if (grade.word === "deemed") {
    return (
      facts.servedAt !== null &&
      facts.serviceRecordedAt !== null &&
      Boolean(facts.serviceBasis?.trim())
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
  /**
   * ⭐ 0111. Rungs whose service is DEEMED — served in law without proof
   * of receipt. Named separately from `clear` on purpose: they satisfy
   * the gate and they are the rungs the allottee's advocate will test
   * first, so the person about to cancel is told which ones they are
   * rather than being shown a single green tick over a mixed file.
   */
  readonly deemedStages: readonly string[];
  /**
   * 🔴 0111. Rungs raised before this system recorded WHICH RIGHT they
   * were raised under. Non-blocking on its own — the row may be perfectly
   * good — but a cancellation warning in this list cannot be shown to
   * have been authorised by somebody who held the key, and that is the
   * question a hearing asks about rung four.
   */
  readonly unrecordedAuthorityStages: readonly string[];
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
      deemedStages: [],
      unrecordedAuthorityStages: [],
    };
  }

  const unproven: string[] = [];
  const legacy: string[] = [];
  const deemed: string[] = [];
  /*
   * ⭐ 0111. Collected over EVERY rung, served or not. Whether the right
   * was recorded is a separate question from whether the letter arrived,
   * and a file can fail one while passing the other.
   */
  const unrecordedAuthority: string[] = [];

  for (const notice of notices) {
    if (notice.authorisedPermission === AUTHORITY_NOT_RECORDED) {
      unrecordedAuthority.push(notice.stage);
    }
    if (describeServiceEvidence(notice.serviceEvidence).word === "deemed") {
      deemed.push(notice.stage);
    }
    if (noticeHasService(notice)) continue;
    unproven.push(notice.stage);
    if (describeServiceEvidence(notice.serviceEvidence).word === "legacy_unverified") {
      legacy.push(notice.stage);
    }
  }

  /*
   * ⚠️ A DEEMED RUNG IS NOT A GAP AND IT IS NOT A CLEAN BILL EITHER. It
   * clears the gate — it is service in law — and it is the rung the other
   * side attacks, so it is named in both outcomes below rather than only
   * in the failing one.
   */
  const deemedClause =
    deemed.length > 0
      ? ` ⚠️ ${deemed.length} rest on DEEMED service — served in law without proof of receipt (${deemed
          .map((s) => s.replace(/_/g, " "))
          .join(", ")}). That is a legal conclusion recorded by a named person under a stated clause, not a delivery this system watched happen, and it is the first thing the allottee's advocate will test.`
      : "";

  const authorityClause =
    unrecordedAuthority.length > 0
      ? ` ⚠️ ${unrecordedAuthority.length} rung(s) predate authority recording (${unrecordedAuthority
          .map((s) => s.replace(/_/g, " "))
          .join(", ")}), so this system cannot show which right they were raised under.`
      : "";

  if (unproven.length === 0) {
    return {
      word: "clear",
      blocking: false,
      headline: "Every demand notice on this booking has service behind it.",
      detail:
        "Each rung was either dispatched by the system with a provider message id, or recorded as served by a named colleague with a reference." +
        deemedClause +
        authorityClause,
      unprovenStages: [],
      legacyStages: [],
      deemedStages: deemed,
      unrecordedAuthorityStages: unrecordedAuthority,
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
      `Raised without service: ${named}. Cancelling or forfeiting on this file means relying on notices this system cannot show were ever sent to the allottee.${legacyClause}${deemedClause}${authorityClause}` +
      " Dispatch them, or record the postal or hand delivery with its reference, before you post.",
    unprovenStages: unproven,
    legacyStages: legacy,
    deemedStages: deemed,
    unrecordedAuthorityStages: unrecordedAuthority,
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

/* ------------------------------------------------------------------ */
/* ⭐⭐⭐ SERVICE THAT NOBODY WATCHED HAPPEN, AND THE LAW SAYS COUNTS    */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 `deemed` HAS BEEN IN THIS FILE SINCE 0098 AND NOTHING WROTE IT
 * ══════════════════════════════════════════════════════════════════════
 * It was declared in `SERVICE_EVIDENCE_GRADES`, described in
 * `DESCRIPTIONS` with `strength: 3` — the STRONGEST grade in the product
 * — allowed by the CHECK in 0098, and granted `supportsEnforcement:
 * true`, which means `noticeHasService` would have cleared a cancellation
 * on it. No code path anywhere could produce one. A grade that clears the
 * gate before a forfeiture and has no writer is this codebase's own
 * recurring defect standing in the most expensive room in the product.
 *
 * ⚠️ THE ANSWER IS TO WIRE IT, NOT TO DELETE IT, and the reason is
 * ordinary rather than theoretical. An allottee REFUSES the registered
 * post. The cover comes back endorsed "refused". Under the agreement's
 * service clause — and under s.27 of the General Clauses Act, 1897 for a
 * properly addressed, prepaid registered letter — that is good service,
 * and it is the single most common way a real chase ends. Without this
 * grade the only two things a person could record are a `human_recorded`
 * claim that the letter was DELIVERED, which is false, or nothing, which
 * loses the developer a case they should win.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHAT MAKES IT SAFE IS THAT IT IS THE HARDEST CLAIM TO MAKE
 * ══════════════════════════════════════════════════════════════════════
 *   ① A different key. `receivables:warn_cancellation`, not
 *      `receivables:dun` — see `lib/receivables/notice-authority.ts`.
 *      Deeming service is a conclusion in law, and the accountant who
 *      chases the money is not the person who draws it.
 *   ② A BASIS IN WORDS. The clause or section relied on, stored on the
 *      row, required by a CHECK in 0111 and printed beside the grade.
 *      "Deemed" with no basis is a tick box wearing the top badge.
 *   ③ A reference. The returned cover's consignment number or the
 *      postal endorsement — something somebody can look up.
 *   ④ Never on a channel the machine can drive. An email that the outbox
 *      can dispatch has `system_dispatch` available to it, which is
 *      proved rather than argued; deeming service on it would be
 *      choosing the weaker evidence and calling it the stronger.
 *   ⑤ Never on a row that was dispatched. The CHECK
 *      `dunning_events_human_record_is_not_a_dispatch` in 0098 already
 *      refuses it, and this refuses it first with a sentence.
 */
export type DeemedServiceClaim = {
  readonly channel: string;
  /**
   * ⚠️ NAMED `alreadyDispatchedAt` AND NOT `dispatchedAt`, WHICH LOOKS
   * FUSSY AND IS NOT. `dunning-service-evidence.test.ts` asserts that
   * nothing in the write path ever puts a value on the right-hand side of
   * a `dispatchedAt:` other than a read of an existing row — the guard
   * that stops the send path claiming a dispatch again. A field on an
   * INPUT type spelt the same way sits inside that guard's blast radius
   * for no reason. This name also says what it means: it is a question
   * about the row that already exists, never a value being written.
   */
  readonly alreadyDispatchedAt: Date | null;
  readonly reference: string;
  /** The clause of the agreement, or the section, being relied on. */
  readonly basis: string;
  readonly recordedBy: string | null;
};

export type DeemedServiceVerdict =
  | { readonly ok: true; readonly reference: string; readonly basis: string }
  | { readonly ok: false; readonly error: string };

export function validateDeemedServiceClaim(
  claim: DeemedServiceClaim,
): DeemedServiceVerdict {
  if (channelCanBeMachineDispatched(claim.channel)) {
    return {
      ok: false,
      error:
        "This notice goes by a channel the system can dispatch itself, so a provider message id is available for it. Deeming service where dispatch can be proved swaps evidence somebody can check for an argument somebody has to win. Let it send.",
    };
  }
  if (claim.alreadyDispatchedAt !== null) {
    return {
      ok: false,
      error:
        "This notice was already dispatched and carries a provider message id. That is the stronger record and it cannot be replaced by a deeming.",
    };
  }
  const reference = claim.reference.trim();
  if (reference.length < 4) {
    return {
      ok: false,
      error:
        "Give the consignment number of the cover that came back, or the postal endorsement reference. Deemed service is still service by post — there is a piece of paper, and without it nobody can look anything up.",
    };
  }
  const basis = claim.basis.trim();
  if (basis.length < 20) {
    return {
      ok: false,
      error:
        "State the clause of the agreement, or the section, that makes this good service — in the words you would use at a hearing. Deemed service is a conclusion in law rather than an event, and a conclusion with no stated basis is a tick box at the top of the evidence scale.",
    };
  }
  if (!claim.recordedBy) {
    return {
      ok: false,
      error:
        "Deeming service names the person who drew the conclusion. There is no signed-in user on this request.",
    };
  }
  return { ok: true, reference, basis };
}
