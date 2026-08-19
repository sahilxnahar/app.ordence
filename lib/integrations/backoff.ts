/**
 * Ordence — ⭐⭐⭐ WHAT TO DO WHEN THE FAR END SAYS NO
 * Version: v1.12.0-alpha
 *
 * Pure. No clock, no randomness, no database. `now` and any jitter are
 * arguments, because a function that reads a clock or calls
 * `Math.random()` cannot be tested and a retry policy that cannot be
 * tested is a retry policy nobody has ever checked.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 NOT EVERY FAILURE IS A RETRY
 * ══════════════════════════════════════════════════════════════════════
 * The single most common integration bug in a small product is one
 * `catch` block that treats everything the same and tries again in
 * thirty seconds. Applied to a rejected API key, that is a few thousand
 * failed authentications a day against somebody's account, and the far
 * end eventually blocks the account rather than the request.
 *
 * ⚠️ SO FAILURES ARE CLASSIFIED, AND THE CLASS DECIDES:
 *
 *   `auth`         Stop. A person must act. Retrying makes it worse.
 *   `rate_limited` Wait exactly as long as we were told, and no less.
 *   `far_end`      Their fault. Back off and keep trying.
 *   `network`      Probably nobody's fault. Back off and keep trying.
 *   `bad_request`  Our fault. Retrying sends the same wrong thing again.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE CAP IS THE WHOLE POINT OF THE BACKOFF
 * ══════════════════════════════════════════════════════════════════════
 * Doubling without a ceiling reaches a nine hour gap by the fourteenth
 * failure. The far end came back after twenty minutes and the customer
 * spends the rest of the working day wondering why their enquiries
 * stopped. An uncapped backoff turns a short outage into a long one, on
 * our side, after the problem is over.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ AND THE CUSTOMER IS TOLD ON TIME, NOT ON COUNT
 * ══════════════════════════════════════════════════════════════════════
 * "Alert after 5 failures" sounds reasonable and is meaningless. A
 * connection polling every six minutes fails five times in half an hour.
 * One polling once a day takes five days to say a word.
 *
 * 🔴 WHAT MATTERS IS HOW LONG THE CUSTOMER HAS BEEN LOSING ENQUIRIES,
 * so the threshold is a duration since the last success.
 */

import type { ConnectionState } from "./policy";

/* ------------------------------------------------------------------ */
/* CLASSIFICATION                                                      */
/* ------------------------------------------------------------------ */

export type FailureClass =
  | "auth"
  | "rate_limited"
  | "far_end"
  | "network"
  | "bad_request";

export interface FailureInput {
  readonly failureClass: FailureClass;
  /** How many have now failed in a row, INCLUDING this one. */
  readonly consecutiveFailures: number;
  /** What the far end told us, in its own words. Kept short. */
  readonly message: string;
  readonly errorCode?: string | null;
  /**
   * ⭐ WHERE THE FAR END NAMED A TIME, IT WINS.
   *
   * ⚠️ Retry-After is not advisory. Ignoring it in favour of our own
   * curve is how a fifteen minute lockout becomes an hour.
   */
  readonly retryAfter?: Date | null;
  /** The far end's own documented lockout, from `ConnectorPolicy`. */
  readonly lockoutSeconds?: number;
  /** When the connection last actually worked. Null where never. */
  readonly lastSuccessAt?: Date | null;
}

export interface BackoffSettings {
  readonly baseSeconds: number;
  /** 🔴 The ceiling. Without it a short outage becomes a long one. */
  readonly capSeconds: number;
  /**
   * ⚠️ Jitter as a fraction of the delay, PASSED IN, never generated
   * here. 0 is a legitimate value and is what the tests use.
   *
   * Its purpose is that a thousand tenants whose connections all failed
   * during the same provider outage do not all retry in the same second
   * and cause the second outage themselves.
   */
  readonly jitterRatio: number;
  /**
   * 🔴 HOW LONG A CONNECTION MAY BE DOWN BEFORE SOMEBODY IS TOLD.
   * A duration, not a count. See the header.
   */
  readonly notifyAfterSeconds: number;
}

export const DEFAULT_BACKOFF: BackoffSettings = Object.freeze({
  baseSeconds: 60,
  // ⭐ One hour. Long enough to stop hammering, short enough that
  // recovery is noticed within the same working session.
  capSeconds: 3600,
  jitterRatio: 0.2,
  // ⚠️ Two hours of silence on a lead source is already a bad morning.
  notifyAfterSeconds: 7200,
});

/* ------------------------------------------------------------------ */
/* THE CURVE                                                           */
/* ------------------------------------------------------------------ */

/**
 * Exponential, capped, then jittered.
 *
 * `jitter` is a number in [0, 1) supplied by the caller. The result is
 * never below `baseSeconds` and never above `capSeconds`, so a badly
 * behaved jitter value cannot produce a retry storm.
 */
export function backoffSeconds(
  consecutiveFailures: number,
  settings: BackoffSettings = DEFAULT_BACKOFF,
  jitter = 0,
): number {
  const n = Math.max(1, Math.floor(consecutiveFailures));
  // ⚠️ Clamped BEFORE the shift. 2 ** 40 seconds is not a delay, it is
  // a number that overflows into nonsense.
  const exponent = Math.min(n - 1, 20);
  const raw = settings.baseSeconds * Math.pow(2, exponent);
  const capped = Math.min(raw, settings.capSeconds);

  const spread = capped * settings.jitterRatio * clamp01(jitter);
  const withJitter = Math.round(capped + spread);

  return Math.min(Math.max(withJitter, settings.baseSeconds), settings.capSeconds);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/* ------------------------------------------------------------------ */
/* THE VERDICT                                                         */
/* ------------------------------------------------------------------ */

export interface FailureVerdict {
  /** What `connections.state` becomes. */
  readonly state: ConnectionState;
  /**
   * What `connections.locked_until` becomes. Null where the connection
   * is free to try again immediately.
   */
  readonly lockedUntil: Date | null;
  /**
   * 🔴 `connections.state_reason`, which 0064 REQUIRES for any state
   * other than connected or paused. In words the customer can read.
   */
  readonly stateReason: string;
  /** True where trying again could plausibly work. */
  readonly willRetry: boolean;
  /**
   * ⭐ TRUE WHERE SOMEBODY HAS TO BE TOLD NOW.
   *
   * ⚠️ This is the difference between a customer who rings us and a
   * customer we rang. Both cost the same to fix; only one loses trust.
   */
  readonly shouldNotify: boolean;
  /** The line that goes in the notification. */
  readonly notifyHeadline: string | null;
  /** What a person must do. Null where nothing is required of them. */
  readonly actionRequired: string | null;
}

/**
 * ⚠️ THE ORDER MATTERS. Auth is decided before rate limiting, because a
 * rejected key that also happens to be rate limited is still a rejected
 * key, and waiting fifteen minutes to rediscover that helps nobody.
 */
export function assessFailure(
  input: FailureInput,
  now: Date,
  settings: BackoffSettings = DEFAULT_BACKOFF,
  jitter = 0,
): FailureVerdict {
  const downFor = input.lastSuccessAt
    ? (now.getTime() - input.lastSuccessAt.getTime()) / 1000
    : Number.POSITIVE_INFINITY;

  // ① 🔴 A REJECTED CREDENTIAL. Never retried, always escalated.
  if (input.failureClass === "auth") {
    return {
      state: "revoked",
      lockedUntil: null,
      stateReason: `The credentials were rejected: ${input.message}`,
      willRetry: false,
      shouldNotify: true,
      notifyHeadline: "A connection needs a new key",
      actionRequired:
        "Enter a new key on the connections screen. Nothing will be fetched until you do, deliberately, because repeatedly presenting a rejected key can get the account blocked at the other end.",
    };
  }

  // ② 🔴 OUR REQUEST WAS WRONG. Sending it again sends it wrong again.
  if (input.failureClass === "bad_request") {
    return {
      state: "degraded",
      lockedUntil: null,
      stateReason: `The other system refused the request: ${input.message}`,
      willRetry: false,
      shouldNotify: true,
      notifyHeadline: "A connection is sending something the other system will not accept",
      actionRequired:
        "This is a fault at our end, not yours. It will not fix itself by waiting, and we would rather you heard it from us.",
    };
  }

  // ③ ⭐ THROTTLED. Honour what we were told, exactly.
  if (input.failureClass === "rate_limited") {
    const told = input.retryAfter ?? null;
    const ourOwn = new Date(
      now.getTime() +
        Math.max(input.lockoutSeconds ?? 0, backoffSeconds(input.consecutiveFailures, settings, jitter)) *
          1000,
    );
    // ⚠️ THE LATER OF THE TWO. Never the earlier.
    const lockedUntil =
      told && told.getTime() > ourOwn.getTime() ? told : ourOwn;

    return {
      state: "locked",
      lockedUntil,
      stateReason: `The other system is limiting how often we may ask. Waiting until ${lockedUntil.toISOString()} before trying again.`,
      willRetry: true,
      shouldNotify: downFor > settings.notifyAfterSeconds,
      notifyHeadline:
        downFor > settings.notifyAfterSeconds
          ? "A connection has been throttled for hours"
          : null,
      actionRequired: null,
    };
  }

  // ④ Their outage or the network. Back off, keep going, speak up if it lasts.
  const waitSeconds = backoffSeconds(input.consecutiveFailures, settings, jitter);
  const lockedUntil = new Date(now.getTime() + waitSeconds * 1000);
  const notify = downFor > settings.notifyAfterSeconds;

  return {
    state: "degraded",
    lockedUntil,
    stateReason:
      input.failureClass === "network"
        ? `Could not reach the other system: ${input.message}. Trying again in ${describeSeconds(waitSeconds)}.`
        : `The other system returned an error: ${input.message}. Trying again in ${describeSeconds(waitSeconds)}.`,
    willRetry: true,
    shouldNotify: notify,
    notifyHeadline: notify ? "A connection has been down for hours" : null,
    actionRequired: notify
      ? "Nothing at your end for now. We are still trying, and we are telling you because enquiries may be arriving somewhere we cannot see them."
      : null,
  };
}

/**
 * What a success does. Deliberately in the same file as the failure
 * path, because a recovery that forgets to clear `locked_until` leaves
 * a working connection sitting out its own punishment.
 */
export interface RecoveryVerdict {
  readonly state: ConnectionState;
  readonly lockedUntil: null;
  readonly stateReason: null;
  readonly consecutiveFailures: 0;
  readonly shouldNotify: boolean;
  readonly notifyHeadline: string | null;
}

export function assessSuccess(previous: {
  readonly state: ConnectionState;
  readonly consecutiveFailures: number;
  readonly notified: boolean;
}): RecoveryVerdict {
  // ⭐ IF WE TOLD THEM IT BROKE, WE TELL THEM IT IS FIXED.
  //
  // ⚠️ A product that only ever sends bad news trains people to ignore
  // it, because they never learn whether anything was resolved.
  const shouldNotify = previous.notified;
  return {
    state: "connected",
    lockedUntil: null,
    stateReason: null,
    consecutiveFailures: 0,
    shouldNotify,
    notifyHeadline: shouldNotify ? "A connection is working again" : null,
  };
}

/* ------------------------------------------------------------------ */
/* WORDS                                                               */
/* ------------------------------------------------------------------ */

export function describeSeconds(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} seconds`;
  if (seconds < 3600) {
    const m = Math.round(seconds / 60);
    return `${m} minute${m === 1 ? "" : "s"}`;
  }
  const h = Math.round((seconds / 3600) * 10) / 10;
  return `${h} hour${h === 1 ? "" : "s"}`;
}
