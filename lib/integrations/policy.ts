/**
 * Ordence — ⭐⭐⭐ CONNECTOR POLICY: WHAT EACH FAR END ACTUALLY ALLOWS
 * Version: v1.12.0-alpha
 *
 * Pure. No database, no network, no clock. `now` is always an argument.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE RATE LIMIT IS NOT AN IMPLEMENTATION DETAIL. IT IS THE PRODUCT.
 * ══════════════════════════════════════════════════════════════════════
 * A locked-out integration and a broken integration look identical from
 * the outside: leads stop arriving. The difference is that one of them
 * we caused ourselves, by polling faster than we were allowed to.
 *
 * ⚠️ IndiaMART's pull API is the sharpest example. One call every five
 * minutes. More than five calls in a minute and it stops answering for
 * fifteen. The window it will answer for is seven days and it keeps 365
 * days of history. Every one of those numbers changes what a correct
 * runner does, and none of them can live in a comment.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ SO THE POLICY IS DATA, NOT CODE
 * ══════════════════════════════════════════════════════════════════════
 * Five connectors share one runner. If the limits are `if` statements
 * inside that runner, the sixth connector is written by copying the
 * fifth, and the copy keeps whichever limit it was copied from. A table
 * of numbers can be read, reviewed, and corrected by somebody who has
 * never opened the runner.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 AND A GAP THAT CANNOT BE REFETCHED IS REPORTED, NEVER NARROWED
 * ══════════════════════════════════════════════════════════════════════
 * If a connection has been down for four hundred days and the far end
 * keeps 365, thirty-five days of enquiries are simply gone. A runner
 * that silently clamps the window to what is allowed produces a
 * successful-looking catch-up over a permanent hole.
 *
 * ⚠️ `nextFetchWindow` clamps, and SAYS SO, and says how much was lost.
 * The customer can then go to the portal and export by hand, which is
 * the only thing that actually recovers it.
 */

/* ------------------------------------------------------------------ */
/* VOCABULARY                                                          */
/* ------------------------------------------------------------------ */

export type ConnectorKey =
  | "indiamart"
  | "justdial"
  | "meta_lead_ads"
  | "whatsapp"
  | "email";

/** Mirrors `connections.state` in 0064. */
export type ConnectionState =
  | "connected"
  | "degraded"
  | "locked"
  | "paused"
  | "revoked";

/** Mirrors `sync_runs.outcome` in 0064. */
export type SyncOutcome =
  | "running"
  | "success"
  | "partial"
  | "failed"
  | "skipped_locked"
  | "skipped_too_soon";

/**
 * How work arrives.
 *
 * ⚠️ `push` connectors must never be given a poll interval. A JustDial
 * connection with `poll_every_seconds` set is a runner burning cycles
 * against an endpoint that does not exist.
 */
export type Transport = "pull" | "push" | "both";

export interface ConnectorPolicy {
  readonly key: ConnectorKey;
  readonly label: string;
  readonly transport: Transport;

  /**
   * 🔴 THE FLOOR THE FAR END IMPOSES, in seconds. Fetching sooner is not
   * "aggressive", it is a lockout.
   */
  readonly minIntervalSeconds: number;
  /** What we ship. Never below `minIntervalSeconds`. */
  readonly defaultPollSeconds: number;
  /**
   * ⚠️ How long the far end punishes us for exceeding the burst limit.
   * Zero where the far end has no documented lockout.
   */
  readonly lockoutSeconds: number;
  /** Requests per minute that trigger `lockoutSeconds`. Null where undocumented. */
  readonly burstPerMinute: number | null;

  /** Largest span a single request may ask for. Null where unlimited. */
  readonly maxWindowDays: number | null;
  /**
   * 🔴 HOW FAR BACK THE FAR END REMEMBERS. Beyond this the data is gone
   * and no amount of retrying brings it back.
   */
  readonly maxHistoryDays: number | null;

  /**
   * ⭐ Whether the tenant can turn this on themselves.
   *
   * ⚠️ JustDial cannot. Their webhook is configured by an account
   * manager on their side, and a screen offering a self-service button
   * for it is a screen that generates support tickets.
   */
  readonly selfService: boolean;
  /** Shown on the connections screen. Plain words, no jargon. */
  readonly setupNote: string;
  /** Which secrets this connector needs, by `vault_secrets.label`. */
  readonly secretNames: readonly string[];

  /**
   * 🔴 HOW AN INBOUND DELIVERY PROVES IT IS THEM, AS DATA.
   *
   * ⚠️ THIS WAS A TERNARY IN v1.12.0 AND IT WAS WRONG. It assumed
   * anything that was not JustDial signed with an `x-hub-signature-256`
   * header. IndiaMART's push API documents no signature, no API key and
   * no header of any kind: it POSTs JSON over HTTPS to whatever address
   * you give it. Every IndiaMART push would have been recorded `absent`
   * and refused, and the reason would have been a guess in a ternary
   * rather than a line anybody could read.
   */
  readonly webhookVerification: "hmac_sha256" | "hmac_sha1" | "shared_token" | "none";
  readonly webhookSignatureHeader: string | null;

  /**
   * ⭐⭐ HOW LONG THE SENDER KEEPS RETRYING BEFORE IT GIVES UP ON US,
   * in hours. Null where the sender does not retry at all.
   *
   * 🔴 INDIAMART DEACTIVATES THE PUSH ENTIRELY AFTER 48 HOURS OF
   * CONTINUOUS REJECTION, and a person has to switch it back on at their
   * end. So a bug in our own handler that returns 500 for two days does
   * not merely delay leads: it silently unsubscribes the customer, and
   * nothing on our side reports it because the requests simply stop.
   */
  readonly senderGivesUpAfterHours: number | null;

  /**
   * ⭐⭐ HOW A PERSON FINDS OUT, AT SETUP TIME, WHETHER IT WORKS.
   *
   * ══════════════════════════════════════════════════════════════════
   * 🔴 "TEST CONNECTION" MEANS FOUR DIFFERENT THINGS AND THAT IS THE
   * WHOLE PROBLEM
   * ══════════════════════════════════════════════════════════════════
   * For IndiaMART it means ask for the narrowest window and see what
   * comes back. For WhatsApp there is nothing to fetch at all, and the
   * only useful question is whether the token identifies a real number.
   * For JustDial there is no outbound call in existence: they push, and
   * the only truthful answer is whether anything has ever arrived.
   *
   * ⚠️ WRITTEN AS `if (connectorKey === …)` INSIDE THE PROBE, the sixth
   * connector is added by copying the fifth and keeping whichever test
   * it was copied from. That is the exact failure this table was built
   * to prevent, and a wrong test is worse than no test: it puts a green
   * tick next to something that has never worked.
   */
  readonly verifyMethod: VerifyMethod;
}

/**
 * ⚠️ `inbound_only` IS NOT A GAP IN THE FEATURE. It is the honest answer
 * for a push connector, and a screen that offers a Test button which
 * cannot fail is a screen that teaches people to trust a green tick.
 */
export type VerifyMethod =
  /** Make the ordinary pull call over the smallest window allowed. */
  | "fetch_probe"
  /** Call a cheap identity endpoint. Proves the credential, fetches nothing. */
  | "credential_probe"
  /** Nothing to call. Report whether anything has ever arrived. */
  | "inbound_only";

/* ------------------------------------------------------------------ */
/* THE TABLE                                                           */
/* ------------------------------------------------------------------ */

/**
 * 🔴 EVERY NUMBER HERE WAS READ FROM THE PROVIDER'S OWN DOCUMENTATION,
 * not inferred from behaviour. A limit guessed from a 429 is a limit
 * that will be guessed again, differently, next year.
 */
export const CONNECTOR_POLICIES: Readonly<Record<ConnectorKey, ConnectorPolicy>> =
  Object.freeze({
    indiamart: Object.freeze({
      key: "indiamart",
      label: "IndiaMART",
      transport: "both",
      // 🔴 Five minutes. Not a suggestion.
      minIntervalSeconds: 300,
      // ⭐ Six, not five. Sitting exactly on a limit means one slow clock
      // is a lockout.
      defaultPollSeconds: 360,
      lockoutSeconds: 900,
      burstPerMinute: 5,
      maxWindowDays: 7,
      maxHistoryDays: 365,
      selfService: true,
      setupNote:
        "Paid IndiaMART sellers only. Take the CRM API key from your IndiaMART seller panel. Enquiries are also pushed to us the moment they arrive, so polling is a safety net rather than the main route. ⚠️ A brand new key cannot see anything older than itself for the first 24 hours, so a fresh connection looking empty on day one is normal.",
      secretNames: Object.freeze(["api_key"]),
      webhookVerification: "none",
      webhookSignatureHeader: null,
      senderGivesUpAfterHours: 48,
      // ⭐ Its pull API IS the probe. One narrow window, one answer.
      verifyMethod: "fetch_probe",
    }),

    justdial: Object.freeze({
      key: "justdial",
      label: "JustDial",
      transport: "push",
      // ⚠️ Push-only. Zero, and it must stay zero.
      minIntervalSeconds: 0,
      defaultPollSeconds: 0,
      lockoutSeconds: 0,
      burstPerMinute: null,
      maxWindowDays: null,
      maxHistoryDays: null,
      // 🔴 NOT SELF-SERVICE.
      selfService: false,
      setupNote:
        "JustDial sends leads to a web address we generate for you. Their account manager has to add that address at their end; there is no button on their dashboard for it. Send them the address below and ask them to enable lead forwarding.",
      secretNames: Object.freeze([]),
      webhookVerification: "none",
      webhookSignatureHeader: null,
      senderGivesUpAfterHours: null,
      // 🔴 THERE IS NO OUTBOUND CALL TO MAKE. Offering a Test button
      // here would be offering a button that cannot say anything true.
      verifyMethod: "inbound_only",
    }),

    meta_lead_ads: Object.freeze({
      key: "meta_lead_ads",
      label: "Meta lead ads",
      transport: "both",
      minIntervalSeconds: 60,
      defaultPollSeconds: 900,
      lockoutSeconds: 3600,
      burstPerMinute: null,
      maxWindowDays: 90,
      /**
       * ⚠️ 90 IS THE PRACTICAL HORIZON, NOT A NUMBER FROM THE API
       * REFERENCE. Meta's own guidance treats leads older than ninety
       * days as expired and no longer downloadable, and the Marketing
       * API's rate-limit formula is scoped to "leads created in the past
       * 90 days" — corroboration rather than proof.
       *
       * ⭐ IT IS ENCODED ANYWAY, because the consequence of being wrong
       * in the safe direction is one extra request, and the consequence
       * of being wrong in the other direction is a customer told their
       * lost leads are recoverable when they are not.
       */
      maxHistoryDays: 90,
      selfService: true,
      setupNote:
        "Needs a verified Meta business and a page access token with leads_retrieval. Meta's webhook tells us only that a lead exists; the answers are fetched separately, so the token matters as much as the connection.",
      secretNames: Object.freeze(["access_token", "app_secret"]),
      webhookVerification: "hmac_sha256",
      webhookSignatureHeader: "x-hub-signature-256",
      senderGivesUpAfterHours: null,
      verifyMethod: "fetch_probe",
    }),

    /**
     * ══════════════════════════════════════════════════════════════════
     * ⭐⭐⭐ WHERE THE RESALE DECISION WILL SHOW UP, AND WHY NOTHING HERE
     * PRE-EMPTS IT
     * ══════════════════════════════════════════════════════════════════
     * There are two ways a business ends up sending WhatsApp through
     * Ordence, and this table supports the first one today.
     *
     * ① BRING YOUR OWN TOKEN (what is built). The tenant creates their
     *    own Meta app, does their own business verification, and pastes
     *    an access token, an app secret and a phone number id into the
     *    connections screen. Ordence needs no Meta relationship of any
     *    kind. It works the day the code ships and it scales to as many
     *    tenants as can be bothered to do the paperwork.
     *
     * ② EMBEDDED SIGNUP (what resale eventually wants). Ordence
     *    registers as a Meta Tech Provider, and the tenant clicks a
     *    button that opens Meta's own dialog. They never see a token.
     *    ⚠️ That requires Ordence's OWN business verification and app
     *    review, which is the thing Sah does not have and cannot get in
     *    an afternoon.
     *
     * 🔴 THE POINT: ② IS ADDITIVE, NOT A REPLACEMENT. It changes where
     * `access_token` comes from and nothing else. The vault still holds
     * it, `credential_probe` still proves it, the send path never knew
     * the difference. So the paste-your-own route is not throwaway work
     * and does not need to be designed around.
     *
     * ⚠️ THE ONE THING THAT WOULD MAKE ② EXPENSIVE LATER is storing the
     * token anywhere other than per-connection in the vault. A single
     * platform-wide WhatsApp credential in an environment variable would
     * have to be unpicked from every send. That mistake is already
     * avoided, and this comment exists so it stays avoided.
     */
    whatsapp: Object.freeze({
      key: "whatsapp",
      label: "WhatsApp Business",
      transport: "both",
      minIntervalSeconds: 60,
      // ⭐ Delivery receipts arrive by webhook. Polling exists only to
      // reconcile a gap, so it is deliberately slow.
      defaultPollSeconds: 0,
      lockoutSeconds: 3600,
      burstPerMinute: null,
      maxWindowDays: 30,
      maxHistoryDays: 30,
      selfService: true,
      setupNote:
        "Needs a verified Meta business, a WhatsApp Business Account and a registered number. Start the verification before you need it; it is not a same-day process.",
      secretNames: Object.freeze(["access_token", "app_secret", "verify_token"]),
      webhookVerification: "hmac_sha256",
      webhookSignatureHeader: "x-hub-signature-256",
      senderGivesUpAfterHours: null,
      // ⚠️ NEVER a fetch. The cheap identity call proves the token
      // without sending anything, and a send costs real money.
      verifyMethod: "credential_probe",
    }),

    email: Object.freeze({
      key: "email",
      label: "Email",
      transport: "push",
      minIntervalSeconds: 0,
      defaultPollSeconds: 0,
      lockoutSeconds: 0,
      burstPerMinute: null,
      maxWindowDays: null,
      maxHistoryDays: null,
      selfService: true,
      setupNote:
        "Bounces, complaints and opens are pushed to us by the sending provider. Nothing to poll.",
      secretNames: Object.freeze(["webhook_signing_secret"]),
      webhookVerification: "hmac_sha256",
      webhookSignatureHeader: "svix-signature",
      senderGivesUpAfterHours: null,
      verifyMethod: "inbound_only",
    }),
  });

export function policyFor(key: string): ConnectorPolicy | null {
  return (
    (CONNECTOR_POLICIES as Record<string, ConnectorPolicy | undefined>)[key] ??
    null
  );
}

export function isKnownConnector(key: string): key is ConnectorKey {
  return policyFor(key) !== null;
}

/* ------------------------------------------------------------------ */
/* MAY WE FETCH?                                                       */
/* ------------------------------------------------------------------ */

/** The subset of a `connections` row this module needs. */
export interface ConnectionSnapshot {
  readonly connectorKey: string;
  readonly state: ConnectionState;
  readonly isActive: boolean;
  readonly pollEverySeconds: number;
  readonly lastAttemptAt: Date | null;
  readonly lastSuccessAt: Date | null;
  readonly cursorAt: Date | null;
  readonly lockedUntil: Date | null;
}

export interface FetchVerdict {
  readonly mayFetch: boolean;
  /**
   * 🔴 THE OUTCOME TO RECORD WHEN WE DO NOT FETCH.
   *
   * ⚠️ A skipped run is still a run and is still written down. A log
   * with gaps in it teaches people that gaps are normal.
   */
  readonly outcome: SyncOutcome | null;
  /** In words a customer can read. Never a stack trace. */
  readonly reason: string;
  /** The earliest moment a fetch is permitted. Null where never. */
  readonly retryAt: Date | null;
}

const ALLOWED = "Due for a fetch.";

/**
 * ⚠️ THE ORDER OF THESE CHECKS IS THE ORDER OF THE CONSEQUENCES.
 *
 * A revoked credential checked after a rate limit means we wait fifteen
 * minutes to discover something no amount of waiting fixes.
 */
export function mayFetchNow(
  connection: ConnectionSnapshot,
  now: Date,
): FetchVerdict {
  const policy = policyFor(connection.connectorKey);
  if (!policy) {
    return {
      mayFetch: false,
      outcome: "failed",
      reason: `This connection names a system Ordence does not know: ${connection.connectorKey}.`,
      retryAt: null,
    };
  }

  // ① A credential the far end rejected. Waiting does not fix it.
  if (connection.state === "revoked") {
    return {
      mayFetch: false,
      outcome: "failed",
      reason:
        "The credentials were rejected. Retrying will not help, and repeated rejected attempts can get the account itself blocked. Someone has to enter a new key.",
      retryAt: null,
    };
  }

  // ② Somebody turned it off. Not an error.
  if (connection.state === "paused" || !connection.isActive) {
    return {
      mayFetch: false,
      outcome: null,
      reason: "This connection is turned off.",
      retryAt: null,
    };
  }

  // ③ Push-only. Nothing to poll, and this is correct, not broken.
  if (policy.transport === "push" || connection.pollEverySeconds <= 0) {
    return {
      mayFetch: false,
      outcome: null,
      reason:
        policy.transport === "push"
          ? `${policy.label} sends to us. There is nothing to fetch.`
          : "Polling is switched off for this connection.",
      retryAt: null,
    };
  }

  // ④ 🔴 THE LOCKOUT. Either the far end's or our own backoff.
  if (connection.lockedUntil && connection.lockedUntil.getTime() > now.getTime()) {
    return {
      mayFetch: false,
      outcome: "skipped_locked",
      reason: `${policy.label} is not accepting requests from us until ${connection.lockedUntil.toISOString()}. Asking again before then extends the block.`,
      retryAt: connection.lockedUntil,
    };
  }

  // ⑤ Our own interval, floored by the far end's.
  //
  // ⭐ THE FLOOR WINS OVER A TENANT SETTING. Somebody who types 60 into
  // a field for a connector with a five minute floor should not be able
  // to lock their own account out.
  const intervalSeconds = Math.max(
    connection.pollEverySeconds,
    policy.minIntervalSeconds,
  );

  if (connection.lastAttemptAt) {
    const dueAt = new Date(
      connection.lastAttemptAt.getTime() + intervalSeconds * 1000,
    );
    if (dueAt.getTime() > now.getTime()) {
      return {
        mayFetch: false,
        outcome: "skipped_too_soon",
        reason: `Last checked ${connection.lastAttemptAt.toISOString()}. ${policy.label} allows one check every ${intervalSeconds} seconds.`,
        retryAt: dueAt,
      };
    }
  }

  return { mayFetch: true, outcome: null, reason: ALLOWED, retryAt: null };
}

/**
 * The interval a connection will actually be polled at, after the far
 * end's floor is applied. What the screen should show, rather than what
 * the tenant typed.
 */
export function effectiveIntervalSeconds(connection: ConnectionSnapshot): number {
  const policy = policyFor(connection.connectorKey);
  if (!policy) return connection.pollEverySeconds;
  if (connection.pollEverySeconds <= 0) return 0;
  return Math.max(connection.pollEverySeconds, policy.minIntervalSeconds);
}

/* ------------------------------------------------------------------ */
/* WHAT WINDOW TO ASK FOR                                              */
/* ------------------------------------------------------------------ */

export interface FetchWindow {
  readonly from: Date;
  readonly to: Date;
  /** True where the window we wanted was wider than the one we may ask for. */
  readonly clamped: boolean;
  /**
   * 🔴 DAYS THAT ARE GONE AND WILL NOT COME BACK. Zero on a normal run.
   *
   * ⚠️ Non-zero means the far end no longer holds the data. It is not
   * "will be picked up next time".
   */
  readonly unrecoverableDays: number;
  /** True where more remains inside the retained history than one call can take. */
  readonly moreToFollow: boolean;
  readonly note: string;
}

const DAY_MS = 86_400_000;

/**
 * ⚠️ `firstRunDays` is how far back a brand new connection reaches. It
 * is deliberately small. A new customer connecting IndiaMART does not
 * want a year of dead enquiries landing in their pipeline on day one.
 */
export function nextFetchWindow(
  connection: ConnectionSnapshot,
  now: Date,
  firstRunDays = 7,
): FetchWindow {
  const policy = policyFor(connection.connectorKey);
  const maxWindowDays = policy?.maxWindowDays ?? null;
  const maxHistoryDays = policy?.maxHistoryDays ?? null;

  const wantedFrom =
    connection.cursorAt ?? new Date(now.getTime() - firstRunDays * DAY_MS);

  let from = wantedFrom;
  let unrecoverableDays = 0;
  const notes: string[] = [];

  // ① 🔴 THE HISTORY LIMIT. Past this the data does not exist any more.
  if (maxHistoryDays !== null) {
    const earliest = new Date(now.getTime() - maxHistoryDays * DAY_MS);
    if (from.getTime() < earliest.getTime()) {
      unrecoverableDays = Math.floor(
        (earliest.getTime() - from.getTime()) / DAY_MS,
      );
      from = earliest;
      notes.push(
        `${policy?.label ?? "This system"} keeps ${maxHistoryDays} days of history. ${unrecoverableDays} day${unrecoverableDays === 1 ? "" : "s"} before that cannot be fetched by anyone, including us. Export them from the provider's own portal if you need them.`,
      );
    }
  }

  // ② The per-request window. This one IS recoverable, on the next run.
  let to = now;
  let clamped = false;
  let moreToFollow = false;

  if (maxWindowDays !== null) {
    const widest = new Date(from.getTime() + maxWindowDays * DAY_MS);
    if (widest.getTime() < now.getTime()) {
      to = widest;
      clamped = true;
      moreToFollow = true;
      notes.push(
        `Asking for ${maxWindowDays} days at a time, which is the most ${policy?.label ?? "this system"} answers in one request. The rest follows on the next run.`,
      );
    }
  }

  if (notes.length === 0) notes.push("Catching up from the last successful run.");

  return {
    from,
    to,
    clamped: clamped || unrecoverableDays > 0,
    unrecoverableDays,
    moreToFollow,
    note: notes.join(" "),
  };
}

/* ------------------------------------------------------------------ */
/* IS THE CURSOR MOVING?                                               */
/* ------------------------------------------------------------------ */

/** The subset of a `sync_runs` row this module needs. */
export interface RunSnapshot {
  readonly outcome: SyncOutcome;
  readonly startedAt: Date;
  readonly itemsSeen: number;
  readonly itemsNew: number;
  readonly itemsDuplicate: number;
  readonly itemsFailed: number;
}

export type HealthTone = "ok" | "watch" | "danger";

export interface SyncHealth {
  readonly tone: HealthTone;
  readonly headline: string;
  readonly detail: string;
}

/**
 * ⭐⭐ THE CHECK NOBODY BUILDS: A RUN THAT SUCCEEDS AND ACHIEVES NOTHING.
 *
 * 🔴 Forty seen and forty NEW, run after run, is a cursor that is not
 * advancing. Every green tick is a re-import. It shows on no dashboard
 * anywhere because every individual run succeeded.
 *
 * ⚠️ And the reverse: run after run seeing nothing at all, for a
 * connector that should be busy, is a filter or a permission that
 * quietly stopped matching. Also all green.
 *
 * `runs` is newest first.
 */
export function assessSyncHealth(
  runs: readonly RunSnapshot[],
  now: Date,
  options: { readonly quietHours?: number } = {},
): SyncHealth {
  const quietHours = options.quietHours ?? 48;

  if (runs.length === 0) {
    return {
      tone: "watch",
      headline: "Never run",
      detail: "This connection has not been checked yet.",
    };
  }

  const failures = runs.filter(
    (r) => r.outcome === "failed" || r.outcome === "partial",
  );
  const completed = runs.filter(
    (r) => r.outcome === "success" || r.outcome === "partial",
  );

  if (completed.length === 0) {
    return {
      tone: "danger",
      headline: "Nothing has ever come through",
      detail: `${failures.length} attempt${failures.length === 1 ? "" : "s"}, none of which finished. Treat this as not connected.`,
    };
  }

  // 🔴 THE SILENT RE-IMPORT.
  const withItems = completed.filter((r) => r.itemsSeen > 0).slice(0, 3);
  if (
    withItems.length === 3 &&
    withItems.every((r) => r.itemsNew === r.itemsSeen && r.itemsDuplicate === 0)
  ) {
    return {
      tone: "danger",
      headline: "The same records are arriving again",
      detail:
        "Three runs in a row treated everything they saw as new, with no repeats at all. That is what it looks like when the position we resume from stops moving, and it means the same enquiries are being created over and over.",
    };
  }

  const newest = completed[0];
  const lastWithAnything = completed.find((r) => r.itemsSeen > 0);

  if (!lastWithAnything) {
    return {
      tone: "watch",
      headline: "Connected, but nothing has arrived",
      detail: `${completed.length} successful check${completed.length === 1 ? "" : "s"} and not one record. If you expect enquiries, the account or the filter at the other end is worth checking.`,
    };
  }

  const quietMs =
    (newest ? newest.startedAt.getTime() : now.getTime()) -
    lastWithAnything.startedAt.getTime();
  if (quietMs > quietHours * 3_600_000) {
    return {
      tone: "watch",
      headline: "Working, but quiet",
      detail: `Nothing has arrived since ${lastWithAnything.startedAt.toISOString()}. The connection itself is fine.`,
    };
  }

  if (failures.length > 0 && failures[0] === runs[0]) {
    return {
      tone: "watch",
      headline: "Last check failed",
      detail:
        failures[0]?.outcome === "partial"
          ? "Some records came through and some did not."
          : "Earlier checks worked, so this may pass on its own.",
    };
  }

  return {
    tone: "ok",
    headline: "Working",
    detail: `Last check ${runs[0]?.startedAt.toISOString() ?? "unknown"}.`,
  };
}
