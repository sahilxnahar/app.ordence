/**
 * Ordence — ⭐⭐⭐ BREAK-GLASS: THE PROCEDURE
 * Version: v1.22.0-alpha
 *
 * Pure. No database, no clock, no network. `now` is always an argument.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE MODE ALREADY EXISTS AND IS ALREADY WELL BUILT
 * ══════════════════════════════════════════════════════════════════════
 * `startImpersonation` already refuses break-glass to anyone without
 * `impersonate:breakglass`, already forces it read-only, already caps it
 * at fifteen minutes, already refuses it outright when usable consent
 * exists, already emails the workspace owners out of band, and already
 * writes a critical security event.
 *
 * ⚠️ SO WHAT IS MISSING IS NOT A GATE. It is the thing that happens
 * AFTERWARDS. Every control listed above is paid once, at the moment of
 * reaching for the glass, by somebody who has already decided to reach
 * for it. None of them costs anything the next day, and a control that
 * costs nothing the next day does not change what people do.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ THE ONE CONTROL THAT CHANGES BEHAVIOUR IS A DEBT
 * ══════════════════════════════════════════════════════════════════════
 * A break-glass session leaves the operator owing a written note within
 * twenty-four hours. Until it is written, THAT OPERATOR CANNOT START
 * ANOTHER ONE.
 *
 * 🔴 THIS IS DELIBERATELY PERSONAL AND DELIBERATELY BLOCKING. A team
 * reminder is ignored; an operator who cannot do the thing they need to
 * do until they spend four minutes writing what happened last time will
 * write it. And an operator who has to write a note tomorrow thinks
 * differently about whether they need the glass today, which is the
 * entire point.
 *
 * ⚠️ IT DOES NOT BLOCK CONSENTED IMPERSONATION, and it must not. Support
 * work the customer has agreed to is the path we WANT people on, and
 * making the debt block it would push somebody towards break-glass on
 * the day their queue is long, which is exactly backwards.
 */

export const BREAK_GLASS = Object.freeze({
  /**
   * ⚠️ FIFTY, NOT THE TWENTY USED FOR QUEUED ACTIONS. This sentence is
   * shown TO THE CUSTOMER in the email that tells them their data was
   * read without their permission. Twenty characters of "checking an
   * issue" is worse than nothing there.
   */
  minReasonLength: 50,
  /** Hours after a break-glass session ends before the note is overdue. */
  noteDueHours: 24,
  /** How long a session lasts. Mirrors `impersonation-policy.ts`. */
  sessionMinutes: 15,
  minNoteLength: 80,
});

/* ------------------------------------------------------------------ */
/* THE REASON                                                          */
/* ------------------------------------------------------------------ */

/**
 * ⭐ RETURNS THE PROBLEM, OR NULL. Named for what it produces so the
 * caller reads `if (problem) return problem` rather than inverting a
 * boolean whose polarity nobody remembers.
 */
export function breakGlassReasonProblem(
  reason: string,
  justification: string,
): string | null {
  const text = reason.trim();

  if (text.length < BREAK_GLASS.minReasonLength) {
    return `Break-glass needs at least ${BREAK_GLASS.minReasonLength} characters explaining why you cannot wait for consent. This exact sentence is emailed to the workspace owners, so write it for them rather than for the log.`;
  }

  // ⚠️ THE SAME TEXT TWICE IS A COPY-PASTE, and a copy-paste is the
  // operator telling us the second field added nothing. The two fields
  // answer different questions: the justification says what you are
  // doing, the reason says why it could not wait.
  if (normalise(text) === normalise(justification)) {
    return "The break-glass reason cannot repeat the justification. The justification says what you need to look at. This says why it could not wait for the customer to say yes.";
  }

  // ⭐ A BARE TICKET NUMBER IS NOT A REASON. It is a pointer to a system
  // the customer cannot open.
  if (/^[a-z]*[-\s]?\d+$/i.test(text.replace(/\s+/g, " "))) {
    return "A ticket reference on its own is not a reason. The customer reading this email has no access to your ticketing system.";
  }

  return null;
}

function normalise(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/* ------------------------------------------------------------------ */
/* THE DEBT                                                            */
/* ------------------------------------------------------------------ */

export interface BreakGlassSession {
  readonly id: string;
  readonly tenantName: string;
  /** Null while still running. */
  readonly endedAt: Date | null;
  readonly startedAt: Date;
  readonly expiresAt: Date;
  readonly postIncidentNote: string | null;
}

export interface NoteDebt {
  readonly sessionId: string;
  readonly tenantName: string;
  /** When the session actually stopped being usable. */
  readonly closedAt: Date;
  readonly dueAt: Date;
  readonly overdue: boolean;
  readonly hoursLate: number;
}

/**
 * ⚠️ A SESSION THAT IS STILL RUNNING OWES NOTHING YET. The clock starts
 * when the operator is out, not when they went in, and "out" is the
 * earlier of ending it deliberately and it expiring on its own.
 */
export function noteDebts(
  sessions: readonly BreakGlassSession[],
  now: Date,
): readonly NoteDebt[] {
  const out: NoteDebt[] = [];

  for (const s of sessions) {
    if (s.postIncidentNote && s.postIncidentNote.trim().length > 0) continue;

    const closedAt = s.endedAt ?? s.expiresAt;
    // Still live. No debt yet.
    if (closedAt.getTime() > now.getTime()) continue;

    const dueAt = new Date(
      closedAt.getTime() + BREAK_GLASS.noteDueHours * 3_600_000,
    );
    const lateMs = now.getTime() - dueAt.getTime();

    out.push({
      sessionId: s.id,
      tenantName: s.tenantName,
      closedAt,
      dueAt,
      overdue: lateMs > 0,
      hoursLate: lateMs > 0 ? Math.floor(lateMs / 3_600_000) : 0,
    });
  }

  return out;
}

/**
 * ⭐⭐ THE BLOCK. Returns the sentence to refuse with, or null to allow.
 *
 * 🔴 ANY UNWRITTEN NOTE BLOCKS, NOT ONLY AN OVERDUE ONE — with one
 * exception, and the exception is the reason this is a function rather
 * than a boolean.
 *
 * ⚠️ THE EXCEPTION IS THE SESSION THAT ENDED MINUTES AGO. Blocking on
 * that would mean an operator who broke glass, found the problem was
 * bigger than one workspace, and needs a second workspace RIGHT NOW is
 * stopped to write paperwork mid-incident. That is the one moment where
 * this control would do harm rather than good, so the debt becomes
 * blocking only once the session has been closed for a full hour.
 */
export const DEBT_GRACE_MINUTES = 60;

export function breakGlassBlock(
  debts: readonly NoteDebt[],
  now: Date,
): string | null {
  const blocking = debts.filter(
    (d) =>
      now.getTime() - d.closedAt.getTime() >= DEBT_GRACE_MINUTES * 60_000,
  );

  if (blocking.length === 0) return null;

  const worst = [...blocking].sort(
    (a, b) => a.closedAt.getTime() - b.closedAt.getTime(),
  )[0]!;

  const overdue = blocking.filter((d) => d.overdue).length;

  return (
    `You cannot start another break-glass session until you have written up the last one. ` +
    `${blocking.length} session${blocking.length === 1 ? "" : "s"} ` +
    `${blocking.length === 1 ? "is" : "are"} waiting for a note, the oldest against ` +
    `${worst.tenantName}${overdue > 0 ? `, and ${overdue} ${overdue === 1 ? "is" : "are"} past the ${BREAK_GLASS.noteDueHours}-hour deadline` : ""}. ` +
    `Consented support access is not affected — this only blocks reading a workspace without permission.`
  );
}

/* ------------------------------------------------------------------ */
/* THE NOTE                                                            */
/* ------------------------------------------------------------------ */

export function postIncidentNoteProblem(note: string): string | null {
  const text = note.trim();
  if (text.length < BREAK_GLASS.minNoteLength) {
    return `The write-up needs at least ${BREAK_GLASS.minNoteLength} characters. It should answer three things: what you looked at, what you found, and what stops this needing break-glass next time.`;
  }
  return null;
}

/**
 * ⭐ SHOWN ON THE SCREEN BEFORE THE BUTTON, not after the click. An
 * operator who reads this and closes the dialog is the best possible
 * outcome of this whole feature.
 */
export const PROCEDURE_STEPS: readonly string[] = Object.freeze([
  "Check first whether the workspace has already granted support access. If it has, break-glass is refused, and it should be.",
  "Ask yourself whether this can wait for them to click yes. If they are reachable and awake, it can.",
  "Write a reason the customer will read. They receive it by email, addressed to the workspace owners, before you are finished reading.",
  "You get fifteen minutes and you get read-only. Neither can be extended, and there is no path in the product that changes either.",
  `Write the note within ${BREAK_GLASS.noteDueHours} hours. Until you do, you cannot break glass again.`,
]);
