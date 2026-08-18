/**
 * Ordence — ⭐⭐ THE OUTBOX POLICY. PURE, AND THE ONLY COPY OF THESE RULES.
 * Version: v1.54.0-alpha  ·  SQL 0097
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT WENT WRONG, STATED PLAINLY
 * ══════════════════════════════════════════════════════════════════════
 * `server/actions/credit.ts` wrote dunning letters — the messages that
 * chase money an SMB is owed — into `credit_dunning_log` with
 * `delivery = 'queued'` and its own header said so:
 *
 *     🔴 IT QUEUES. IT DOES NOT SEND. There is no SMTP call, no Resend
 *        call and no webhook anywhere below.
 *
 * The comment was honest. Nothing downstream existed. The screen said a
 * reminder had been recorded, the customer received nothing, the invoice
 * aged, and the owner believed they were chasing.
 *
 * ⚠️ A QUEUE WITH NO DRAIN IS NOT A DEFERRED SEND. It is a deletion with
 * a receipt.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THE RULES LIVE IN A PURE FILE AND NOT IN THE WORKER
 * ══════════════════════════════════════════════════════════════════════
 * Same argument as `lib/notifications/preferences.ts`. The moment
 * "is this failure worth retrying" is decided inside the function that
 * also opens a transaction and calls Resend, it can only be exercised by
 * standing up a database and a mail provider — so it stops being
 * exercised, and the classification quietly rots into "everything is a
 * retry", which is how one rate limit becomes an infinite loop against a
 * provider that is already angry with you.
 *
 * No I/O, no `server-only`, no database types. Every function is total.
 */

/* ------------------------------------------------------------------ */
/* THE STATUS VOCABULARY                                               */
/* ------------------------------------------------------------------ */

/**
 * 🔴 EVERY STATE CARRIES A WORD, AND THE WORDS ARE NOT INTERCHANGEABLE.
 *
 *  `queued`     — owed to somebody. Nothing has been attempted yet, or
 *                 the last attempt failed in a way worth repeating.
 *  `sending`    — CLAIMED by exactly one worker. Not a synonym for
 *                 "queued": a row in this state may already have reached
 *                 the provider, so nothing may treat it as unsent.
 *  `sent`       — the provider returned an id. See `PROOF_OF_SEND` below.
 *  `bounced`    — the provider accepted it and the receiving server
 *                 refused it. It WAS sent; it did not arrive.
 *  `suppressed` — deliberately not sent, and the reason is kept. Not a
 *                 failure and never retried.
 *  `dead`       — permanently undeliverable, or out of attempts. The
 *                 reason is kept so a human can answer "why did this
 *                 customer never hear from us".
 */
export const EMAIL_OUTBOX_STATUSES = [
  "queued",
  "sending",
  "sent",
  "bounced",
  "suppressed",
  "dead",
] as const;

export type EmailOutboxStatus = (typeof EMAIL_OUTBOX_STATUSES)[number];

/** States from which nothing further will be attempted. */
const TERMINAL: readonly EmailOutboxStatus[] = ["sent", "bounced", "suppressed", "dead"];

export function isTerminalOutboxStatus(status: string): boolean {
  return (TERMINAL as readonly string[]).includes(status);
}

/**
 * 🔴🔴 THE ONE RULE THAT MAKES `sent` MEAN ANYTHING.
 *
 * A row may be marked `sent` ONLY when the provider handed back a message
 * id. Not when the HTTP call returned, not when no exception was thrown —
 * when there is an identifier that can be quoted back to Resend and
 * matched against a webhook.
 *
 * ⚠️ `noUncheckedIndexedAccess` IS ON, and it is doing real work here: a
 * `returning()` that comes back empty is typed `undefined`, so "we got an
 * id" and "we got a row back" cannot be confused by accident. A row with
 * no provider id is not proof of delivery, and the collections call that
 * opens with "we have written to you three times" must be able to survive
 * the customer's reply.
 */
export const PROOF_OF_SEND =
  "A row is marked sent only when the provider returned a message id. Without one there is no evidence anything left the building.";

/* ------------------------------------------------------------------ */
/* RETRY vs DEAD-LETTER                                                */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THREE DISPOSITIONS, NOT TWO, AND THE THIRD IS THE ONE PEOPLE MISS.
 *
 *  `retry` — a transient refusal. Burns an attempt, comes back later.
 *  `dead`  — permanent. Retrying cannot change the answer, and a loop
 *            against a permanent 4xx is how a sender gets blocked.
 *  `defer` — OUR problem, not the provider's: no API key configured.
 *            Rescheduled WITHOUT burning an attempt, because a
 *            deployment that has not been given a key yet must not
 *            silently dead-letter every letter it was asked to send and
 *            then report the queue as drained.
 *
 * 🔴 THE DEFAULT IS `retry`, NOT `dead`. An unrecognised failure is far
 * more likely to be a network blip than a permanent rejection, and the
 * attempt ceiling stops an unknown from spinning forever. Defaulting the
 * other way silently discards mail on the first unfamiliar error string,
 * which is the failure this whole batch exists to end.
 */
export type EmailDisposition = "retry" | "dead" | "defer";

export type FailureClassification = {
  readonly disposition: EmailDisposition;
  /** Short, stable, greppable. Stored on the row. */
  readonly code: string;
  /** Why, in the words an operator reading the console needs. */
  readonly explanation: string;
};

/**
 * ⚠️ THE `reason` VALUES ARE `EmailFailureReason` FROM
 * `lib/email/resend.ts`, TAKEN AS A PLAIN STRING ON PURPOSE. Importing
 * the type would drag `server-only` into a pure module and this file
 * would stop being importable by the console.
 */
export function classifyEmailFailure(
  reason: string,
  message: string,
): FailureClassification {
  const haystack = `${reason} ${message}`.toLowerCase();

  if (reason === "not_configured") {
    return {
      disposition: "defer",
      code: "not_configured",
      explanation:
        "No mail provider is configured for this deployment, so nothing was attempted. The message is still owed and will go out when a key is set — it has not been discarded and it has not used up an attempt.",
    };
  }

  /*
   * 🔴 A 429 IS A RETRY. It is the provider saying "later", not "no", and
   * the single most damaging way to read it is as a failure worth
   * dropping — the messages that get dropped are the ones sent during the
   * busiest minute of the busiest day, which is exactly when a sweep
   * fires.
   */
  if (reason === "rate_limited" || /\b429\b|too many requests|rate.?limit/.test(haystack)) {
    return {
      disposition: "retry",
      code: "rate_limited",
      explanation:
        "The provider is rate limiting us. The message keeps its place and goes out after a wait that grows with each attempt.",
    };
  }

  /*
   * ⚠️ A BAD ADDRESS IS PERMANENT AND MUST NOT BE RETRIED. Repeatedly
   * offering a known-invalid recipient to the provider is precisely the
   * behaviour that costs a sending domain its reputation.
   */
  if (
    reason === "invalid_recipient" ||
    /invalid.*(recipient|email|address)|no valid recipient|not a valid email/.test(haystack)
  ) {
    return {
      disposition: "dead",
      code: "invalid_recipient",
      explanation:
        "The recipient address is not deliverable. Retrying cannot change that, and repeatedly offering a bad address to the provider damages the sending reputation of the whole domain.",
    };
  }

  if (/suppress|blocked|blocklist|denied|unsubscrib/.test(haystack)) {
    return {
      disposition: "dead",
      code: "provider_suppressed",
      explanation:
        "The provider refuses to deliver to this address. That refusal is theirs to lift, not ours to retry around.",
    };
  }

  /* A 5xx is the provider's own fault and is worth waiting out. */
  if (/\b5\d\d\b|server error|timeout|timed out|econnreset|fetch failed|network/.test(haystack)) {
    return {
      disposition: "retry",
      code: "provider_unavailable",
      explanation:
        "The provider failed on its own side. The message is unchanged and is attempted again.",
    };
  }

  /*
   * ⚠️ A 4xx THAT IS NOT A 429 IS OUR REQUEST BEING WRONG. Sending the
   * identical request again produces the identical rejection.
   */
  if (/\b4\d\d\b|unprocessable|validation|forbidden|unauthor/.test(haystack)) {
    return {
      disposition: "dead",
      code: "rejected",
      explanation:
        "The provider rejected the message itself. The same request will be rejected the same way, so it is dead-lettered with the reason kept rather than looped.",
    };
  }

  return {
    disposition: "retry",
    code: "unknown",
    explanation:
      "The failure was not recognised. It is treated as transient — an unfamiliar error is far more often a blip than a permanent refusal — and the attempt ceiling stops it running forever.",
  };
}

/* ------------------------------------------------------------------ */
/* BACKOFF                                                             */
/* ------------------------------------------------------------------ */

/**
 * ⭐ DEFAULT CEILING. Five attempts spread over roughly half a day.
 *
 * ⚠️ NOT "retry until it works". A dunning letter that finally leaves
 * four days late arrives after the collections call it was supposed to
 * precede, and the customer is told two contradictory things.
 */
export const EMAIL_MAX_ATTEMPTS = 5;

/**
 * ⚠️ DETERMINISTIC, WITH NO JITTER, AND THAT IS DELIBERATE.
 *
 * Jitter belongs in a system where thousands of workers retry the same
 * second. Here the claim is a conditional UPDATE against one row, so a
 * thundering herd cannot form — and a deterministic schedule is one a
 * test can assert and an operator can predict. "Why has this not gone
 * yet" has an answer.
 *
 * 1 min → 5 min → 25 min → 2 h → 10 h, then held at 10 h.
 */
const BACKOFF_MINUTES: readonly number[] = [1, 5, 25, 120, 600];

export function backoffDelayMs(attemptsSoFar: number): number {
  /*
   * ⚠️ `noUncheckedIndexedAccess` MEANS THIS INDEX IS `number | undefined`.
   * A negative or absurd attempt count must not produce `NaN` milliseconds
   * and a row scheduled for the epoch — which would be an instant retry
   * loop wearing a timestamp.
   */
  const index = Math.max(0, Math.min(Math.floor(attemptsSoFar), BACKOFF_MINUTES.length) - 1);
  const minutes = BACKOFF_MINUTES[index] ?? BACKOFF_MINUTES[0] ?? 1;
  return minutes * 60_000;
}

/**
 * How long a claim is honoured before another worker may take the row.
 *
 * 🔴 THIS IS A LEASE, NOT A LOCK, AND THE DIFFERENCE IS THE CRASH CASE.
 * A worker that dies between "Resend accepted it" and "we wrote sent"
 * leaves the row in `sending` forever unless something reclaims it. The
 * lease is what reclaims it — and `RESEND_IDEMPOTENCY` below is what
 * makes reclaiming safe.
 */
export const CLAIM_LEASE_MS = 10 * 60_000;

/**
 * 🔴🔴 THE ANSWER TO "A CRASH BETWEEN SEND AND MARK MUST NOT RESEND".
 *
 * It cannot be answered by our database alone. If the process dies after
 * the provider accepted the message and before the row was updated, our
 * side has no record either way — and the two possible recoveries are
 * "never send it" (a customer who is never chased) and "send it again" (a
 * customer chased twice, who concludes an SMB is harassing them).
 *
 * ⭐ SO THE DECIDER IS THE PROVIDER. Every attempt on a row — the first
 * and every recovery — passes THE SAME idempotency key to Resend. Resend
 * deduplicates on it and returns the ORIGINAL message id instead of
 * sending a second copy. The recovery is therefore safe by construction,
 * and it also repairs our row: we learn the id we failed to write down.
 *
 * ⚠️ WHICH IS WHY THE KEY IS DERIVED FROM THE ROW AND NEVER FROM THE
 * ATTEMPT. A key that included the attempt number would make every retry
 * a distinct message to the provider and turn this guarantee inside out.
 */
export const RESEND_IDEMPOTENCY =
  "Every attempt on an outbox row sends the same idempotency key, so a retry after a crash is deduplicated by the provider and returns the original message id instead of a second email.";

export function outboxIdempotencyKey(rowId: string): string {
  return `outbox:${rowId}`;
}


/* ------------------------------------------------------------------ */
/* THE VERDICT ON ONE ATTEMPT                                          */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐ WHAT ONE ATTEMPT DID TO A ROW. PURE, SO IT CAN BE EXERCISED.
 *
 * 🔴 THIS USED TO BE INLINE IN THE DISPATCHER AND THAT MADE IT UNTESTABLE
 * WITHOUT A DATABASE AND A MAIL PROVIDER — which is how "a 429 is a
 * retry" quietly becomes "everything is a retry" or, far worse,
 * "everything is a discard". The rules that decide whether a customer is
 * ever chased again must be checkable in a unit test.
 */
export type AttemptOutcome = {
  readonly status: EmailOutboxStatus;
  /** What `attempts` becomes. Not always `attempts + 1` — see below. */
  readonly attemptsAfter: number;
  /** Milliseconds until the row is eligible again. 0 when terminal. */
  readonly delayMs: number;
  readonly code: string;
  readonly explanation: string;
};

export type AttemptInput = {
  readonly attempts: number;
  readonly maxAttempts: number;
  /** The provider's verdict, flattened out of `EmailResult`. */
  readonly ok: boolean;
  /** 🔴 Present only when the provider actually confirmed. */
  readonly providerMessageId?: string | null;
  readonly reason?: string;
  readonly message?: string;
};

export function decideAfterAttempt(input: AttemptInput): AttemptOutcome {
  const attempts = Number.isFinite(input.attempts) ? Math.max(0, input.attempts) : 0;
  const maxAttempts = Number.isFinite(input.maxAttempts)
    ? Math.max(1, input.maxAttempts)
    : EMAIL_MAX_ATTEMPTS;

  /*
   * 🔴 SUCCESS WITHOUT A PROVIDER ID IS NOT SUCCESS. `sendEmail` already
   * refuses to report `ok` without one, and this refuses it a second
   * time — because the alternative is a row marked `sent` on the
   * strength of "no exception was thrown", and that is the sentence a
   * collections call cannot survive.
   */
  if (input.ok && input.providerMessageId) {
    return {
      status: "sent",
      attemptsAfter: attempts + 1,
      delayMs: 0,
      code: "sent",
      explanation: PROOF_OF_SEND,
    };
  }

  if (input.ok) {
    const attemptsAfter = attempts + 1;
    const exhausted = attemptsAfter >= maxAttempts;
    return {
      status: exhausted ? "dead" : "queued",
      attemptsAfter,
      delayMs: exhausted ? 0 : backoffDelayMs(attemptsAfter),
      code: "no_proof_of_send",
      explanation:
        "The provider returned success without a message id. That is not evidence anything was delivered, so the row is not marked sent.",
    };
  }

  const verdict = classifyEmailFailure(input.reason ?? "unknown", input.message ?? "");

  /*
   * ⭐ THE DEFERRED CASE SPENDS NOTHING. A deployment with no Resend key
   * must not burn five attempts against a provider it never contacted
   * and then dead-letter every letter it was asked to send.
   */
  if (verdict.disposition === "defer") {
    return {
      status: "queued",
      attemptsAfter: attempts,
      delayMs: 15 * 60_000,
      code: verdict.code,
      explanation: verdict.explanation,
    };
  }

  const attemptsAfter = attempts + 1;

  if (verdict.disposition === "dead") {
    return {
      status: "dead",
      attemptsAfter,
      delayMs: 0,
      code: verdict.code,
      explanation: verdict.explanation,
    };
  }

  /*
   * ⚠️ A RETRY THAT HAS RUN OUT OF ATTEMPTS IS A DEAD LETTER, AND IT SAYS
   * SO. "Given up after 5 attempts" and "permanently rejected" are
   * different facts about a message that was never received, and an
   * operator deciding whether to pick up the phone needs to know which.
   */
  if (attemptsAfter >= maxAttempts) {
    return {
      status: "dead",
      attemptsAfter,
      delayMs: 0,
      code: verdict.code,
      explanation: `${verdict.explanation} Given up after ${attemptsAfter} attempts.`,
    };
  }

  return {
    status: "queued",
    attemptsAfter,
    delayMs: backoffDelayMs(attemptsAfter),
    code: verdict.code,
    explanation: verdict.explanation,
  };
}

/* ------------------------------------------------------------------ */
/* SUPPRESSION                                                         */
/* ------------------------------------------------------------------ */

/**
 * 🔴 WHY SUPPRESSION IS NOT OPTIONAL AND NOT PER-TENANT BY NATURE.
 *
 * Mail from every workspace leaves under the reputation of one sending
 * domain. An address that hard-bounced is a mailbox that does not exist;
 * continuing to offer it to the provider is the strongest negative signal
 * a sender can emit, and the cost lands on EVERY tenant's delivery —
 * including the tenants doing nothing wrong. It is a shared resource
 * being spent by whoever is careless.
 *
 * ⚠️ A COMPLAINT IS WORSE THAN A BOUNCE. A bounce says the address is
 * dead; a complaint says a real person marked us as spam. Neither may
 * ever depend on somebody remembering.
 */
export const SUPPRESSION_REASONS = [
  "hard_bounce",
  "complaint",
  "invalid",
  "manual",
] as const;

export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

export function isSuppressionReason(value: unknown): value is SuppressionReason {
  return (
    typeof value === "string" &&
    (SUPPRESSION_REASONS as readonly string[]).includes(value)
  );
}

/**
 * ⚠️ A SOFT BOUNCE IS NOT A SUPPRESSION. "Mailbox full" and "greylisted"
 * are temporary; suppressing on them would permanently silence a customer
 * whose inbox was briefly over quota, and nobody would ever notice.
 * Resend reports the distinction in `data.bounce.type`; anything that is
 * not explicitly hard is treated as transient.
 */
export function bounceIsPermanent(bounceType: unknown): boolean {
  if (typeof bounceType !== "string") return false;
  const normalized = bounceType.trim().toLowerCase();
  return normalized === "hard" || normalized === "permanent" || normalized === "undetermined";
}

/**
 * ⭐ ONE NORMALISATION, USED BY THE WRITER AND THE READER ALIKE.
 *
 * 🔴 IF THE WEBHOOK STORED `Bob@Example.COM` AND THE DISPATCHER LOOKED UP
 * `bob@example.com`, THE SUPPRESSION WOULD BE A ROW NOBODY MATCHES — a
 * control that exists, reports success and does nothing. That is the same
 * shape as the preference switch batch 135 had to fix, one layer down.
 */
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/* ------------------------------------------------------------------ */
/* WHAT THE OPERATOR SEES                                              */
/* ------------------------------------------------------------------ */

/** Human words for each state, so the console and the tests agree. */
export function describeOutboxStatus(status: string): string {
  switch (status) {
    case "queued":
      return "Waiting to go out.";
    case "sending":
      return "Claimed by a worker right now. It may already have reached the provider, so nothing else may touch it.";
    case "sent":
      return "Accepted by the provider, with a message id recorded.";
    case "bounced":
      return "Sent, and refused by the receiving server.";
    case "suppressed":
      return "Deliberately not sent — this address is suppressed.";
    case "dead":
      return "Given up on. The reason is on the row.";
    default:
      return "Unrecognised state.";
  }
}
