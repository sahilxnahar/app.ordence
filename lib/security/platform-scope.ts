import "server-only";

/**
 * Ordence — ⭐⭐⭐ BREAK GLASS, WITH THE GLASS ACTUALLY BROKEN
 * Version: v1.82.0-alpha · Track D, wave 15
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE DEFECT THIS EXISTS FOR
 * ══════════════════════════════════════════════════════════════════════
 * `withPlatformScope(reason, cb)` in `db/index.ts` is the one function in
 * this codebase that reads across tenant boundaries. It takes a written
 * justification as its FIRST argument, checks that it is at least ten
 * characters long, and then:
 *
 *     if (process.env.NODE_ENV !== "production") {
 *       console.warn(`[PLATFORM SCOPE] Reading across tenants: ${reason}`);
 *     }
 *
 * ⚠️ READ THE CONDITION. In production — the only environment where the
 * question "who at Ordence read my data, and why?" is ever asked — the
 * justification is validated, discarded, and never written anywhere. 94
 * files call this function. The audit trail records that platform scope
 * was raised and never why, which is the one field that matters when a
 * customer asks.
 *
 * ⚠️ AND THE TEN-CHARACTER FLOOR IS THE `count(*) >= 10` GATE AGAIN, in
 * miniature. `"debugging1"` passes. So does `"aaaaaaaaaa"`. A length
 * check on a free-text field is a check that a field is non-empty
 * wearing a number.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT THIS FILE CAN AND CANNOT DO, AND WHY IT IS SHAPED LIKE THIS
 * ══════════════════════════════════════════════════════════════════════
 * `db/index.ts` is not Track D's to edit. The correct fix is six lines
 * inside `withPlatformScope` calling `recordPlatformScopeRaise()` below,
 * and it is written out verbatim in `PATCH-REQUEST-D.md` for integration
 * to apply. Everything the patch needs is here, tested, and already used
 * by Track D's own call sites through `withJustifiedPlatformScope()`.
 *
 * So this file is deliberately TWO layers:
 *
 *   ① `recordPlatformScopeRaise()` — the recorder. Pure of its caller,
 *      safe to call from anywhere, and what the six-line patch invokes.
 *      Landing that patch turns all 94 existing call sites into recorded
 *      ones at once, without touching any of them.
 *
 *   ② `withJustifiedPlatformScope()` and `withBreakGlass()` — the
 *      wrappers. Stricter validation, an expiring grant, and a notification
 *      on use. These are what NEW privileged code should call.
 *
 * ⚠️ ① IS NOT SUFFICIENT ON ITS OWN AND ② IS NOT SUFFICIENT ON ITS OWN.
 * Without ①, 94 call sites stay unrecorded. Without ②, the only control
 * on the justification is a length floor. Shipping only the half Track D
 * can land alone would be a fix that looks complete and covers four call
 * sites out of ninety-eight.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHERE THE JUSTIFICATION IS STORED, AND WHY NOT A NEW TABLE
 * ══════════════════════════════════════════════════════════════════════
 * `security_events.reason` — a real column, indexed by the table's own
 * `occurred_at`/`event_type` indexes, append-only by trigger, exported to
 * the SIEM, and already the stream a security reviewer reads. The
 * justification is therefore stored, non-empty (validated before the
 * write), and queryable with one SQL statement:
 *
 *     SELECT occurred_at, subject_id, reason, detail
 *       FROM security_events
 *      WHERE event_type = 'platform.scope_raised'
 *         OR detail->>'intended_type' = 'platform.scope_raised'
 *      ORDER BY occurred_at DESC;
 *
 * A dedicated `platform_scope_raises` table would be better shaped and
 * would need a migration number Track D does not hold. It is written up
 * as a follow-up rather than half-built here.
 */

import { recordSecurityEvidence, type EvidenceOutcome } from "@/lib/security/evidence";
import type { withPlatformScope } from "@/db";

/**
 * The transaction handle, DERIVED from the real function rather than
 * named — the same trick `server/security/record.ts` uses, and for the
 * same reason: a hand-written handle type drifts from the one Drizzle
 * actually hands over, and the drift only shows up as a cast somewhere.
 *
 * ⚠️ `import type`, so nothing at runtime imports `db/index.ts` from a
 * module that may be loaded during a build with no database credentials.
 */
type PlatformTx = Parameters<Parameters<typeof withPlatformScope>[1]>[0];
type ScopeCallback<T> = (tx: PlatformTx) => Promise<T>;

/* ------------------------------------------------------------------ */
/* VALIDATION                                                          */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ 24, NOT 10, AND THE NUMBER IS THE LEAST IMPORTANT RULE HERE.
 *
 * Length alone is defeated by any keyboard mash. It is kept as a floor
 * because it is cheap, and it is followed by three checks that a mash
 * cannot pass.
 */
export const MIN_JUSTIFICATION_CHARS = 24;

/** A justification has to be a sentence, not a token. */
export const MIN_JUSTIFICATION_WORDS = 4;

/**
 * Words that mean "I did not want to type a reason".
 *
 * ⚠️ MATCHED AS WHOLE WORDS AGAINST THE WHOLE STRING, not as substrings.
 * "test" as a substring would refuse "investigating the contest export
 * failure", which is a real justification, and a validator that refuses
 * real work teaches people to write around it.
 */
const PLACEHOLDER_JUSTIFICATIONS: ReadonlySet<string> = new Set([
  "test",
  "testing",
  "todo",
  "tbd",
  "temp",
  "temporary",
  "debug",
  "debugging",
  "reason",
  "justification",
  "n/a",
  "na",
  "none",
  "x",
  "-",
  "asdf",
  "foo",
  "bar",
  "why",
  "because",
  "admin",
  "support",
  "fix",
  "check",
  "checking",
  "investigating",
]);

export type JustificationVerdict =
  | { readonly ok: true; readonly normalised: string }
  | { readonly ok: false; readonly problem: JustificationProblem; readonly message: string };

export type JustificationProblem =
  | "empty"
  | "too_short"
  | "too_few_words"
  | "placeholder"
  | "no_substance";

/**
 * Decide whether a string is a real justification.
 *
 * ⚠️ PURE, SYNCHRONOUS AND EXPORTED SO IT CAN BE TESTED WITHOUT A
 * DATABASE. A validator that can only be exercised through a transaction
 * is a validator that gets exercised once.
 *
 * ⚠️ IT IS NOT AN AUTHORISATION DECISION. Anybody who can call
 * `withPlatformScope` can write a plausible sentence. What this buys is
 * that the row in `security_events` says something a reviewer six months
 * later can act on, instead of `"scope"`. Treating it as a security
 * control would be the mistake; treating it as a control on the QUALITY
 * OF THE RECORD is the whole intent.
 */
export function validateJustification(raw: unknown): JustificationVerdict {
  if (typeof raw !== "string") {
    return { ok: false, problem: "empty", message: "A justification must be text." };
  }

  const normalised = raw.trim().replace(/\s+/g, " ");

  if (normalised.length === 0) {
    return {
      ok: false,
      problem: "empty",
      message: "Platform scope requires a written justification.",
    };
  }

  if (normalised.length < MIN_JUSTIFICATION_CHARS) {
    return {
      ok: false,
      problem: "too_short",
      message:
        `A justification must be at least ${MIN_JUSTIFICATION_CHARS} characters. ` +
        `Say what you are looking for and for whom.`,
    };
  }

  /*
   * ⚠️ THE FILE-PATH PREFIX IS STRIPPED BEFORE THE WORD COUNT.
   *
   * The 94 existing call sites are written as
   * `"lib/security/lockout.ts: read lockout state"`, and the path is not
   * the justification — it is the location, which the `source` field
   * already carries. Counting it would let `"a/b/c/d/e.ts: x"` pass on
   * five "words" that are one slug. What is measured is what follows the
   * colon, when there is one.
   */
  const afterLocation = normalised.includes(": ")
    ? normalised.slice(normalised.indexOf(": ") + 2).trim()
    : normalised;

  const substance = afterLocation.length > 0 ? afterLocation : normalised;

  const words = substance.split(" ").filter((w) => /[a-z0-9]/i.test(w));

  if (words.length < MIN_JUSTIFICATION_WORDS) {
    return {
      ok: false,
      problem: "too_few_words",
      message:
        `A justification must be a sentence of at least ${MIN_JUSTIFICATION_WORDS} words, ` +
        `not a label. "${substance}" does not say why.`,
    };
  }

  const lowered = words.map((w) => w.toLowerCase().replace(/[^a-z0-9/]/g, ""));
  if (lowered.every((w) => PLACEHOLDER_JUSTIFICATIONS.has(w))) {
    return {
      ok: false,
      problem: "placeholder",
      message: "That justification is a placeholder. Say what you are actually doing.",
    };
  }

  /*
   * ⚠️ THE REPEATED-CHARACTER CHECK. `"aaaaaaaaaaaaaaaaaaaaaaaaaa"` clears
   * the length floor, and `"aa aa aa aa aa aa"` clears the word count too.
   * Distinct alphanumeric characters is the cheapest property a mash
   * cannot fake and a real sentence always has.
   */
  const distinct = new Set(substance.toLowerCase().replace(/[^a-z0-9]/g, ""));
  if (distinct.size < 8) {
    return {
      ok: false,
      problem: "no_substance",
      message: "That justification does not read like a sentence.",
    };
  }

  return { ok: true, normalised };
}

/* ------------------------------------------------------------------ */
/* THE RECORDER — what the db/index.ts patch calls                      */
/* ------------------------------------------------------------------ */

export type PlatformScopeRaise = {
  /** The justification, normalised. Never empty. */
  readonly justification: string;
  /** Which module raised it. */
  readonly source: string;
  /** Clerk id of the operator, when one is known. Null for system paths. */
  readonly operatorId: string | null;
  /** The tenant being read across to, when the caller knows it. */
  readonly tenantId: string | null;
  /** `routine` for ordinary platform reads, `break_glass` for a granted raise. */
  readonly kind: "routine" | "break_glass";
  readonly atMs: number;
};

/**
 * The in-process journal.
 *
 * ⚠️ IT IS NOT THE RECORD AND MUST NEVER BE READ AS ONE. Serverless
 * instances are short-lived and there are many of them, so this holds a
 * sample of what one instance did recently — enough for the console's
 * "raises in this process" panel to have something live in it, and useless
 * as evidence. `security_events` is the record.
 */
const RECENT_LIMIT = 200;
const recent: PlatformScopeRaise[] = [];

export function recentPlatformScopeRaises(): readonly PlatformScopeRaise[] {
  return [...recent].reverse();
}

/** Test seam. Never called by product code. */
export function __resetPlatformScopeJournal(): void {
  recent.length = 0;
}

/**
 * ⭐ RECORD ONE CROSS-TENANT RAISE. This is the function the six-line
 * `db/index.ts` patch calls, and it is written so that patch cannot make
 * things worse:
 *
 *   • it never throws — a failure to record must not stop the read;
 *   • it never awaits anything the read depends on;
 *   • an invalid justification is recorded AS INVALID rather than being
 *     refused, because refusing at this layer would break 94 call sites
 *     at once and the ones that would break are platform tooling used
 *     during incidents. The refusal belongs in the wrappers below, on new
 *     code, where it costs nothing.
 */
export async function recordPlatformScopeRaise(args: {
  readonly justification: unknown;
  readonly source: string;
  readonly operatorId?: string | null;
  readonly tenantId?: string | null;
  readonly kind?: "routine" | "break_glass";
}): Promise<EvidenceOutcome | null> {
  try {
    const verdict = validateJustification(args.justification);
    const kind = args.kind ?? "routine";

    const justification = verdict.ok
      ? verdict.normalised
      : typeof args.justification === "string" && args.justification.trim().length > 0
        ? args.justification.trim().slice(0, 500)
        : "(no justification supplied)";

    const entry: PlatformScopeRaise = {
      justification,
      source: args.source,
      operatorId: args.operatorId ?? null,
      tenantId: args.tenantId ?? null,
      kind,
      atMs: Date.now(),
    };
    recent.push(entry);
    if (recent.length > RECENT_LIMIT) recent.shift();

    /*
     * ⚠️ SEVERITY IS THE SIGNAL, NOT A SEPARATE EVENT TYPE. A routine
     * platform read is `info` — there are many and they are expected. A
     * break-glass raise, or a raise whose justification does not validate,
     * is `warning`: rare, and something a reviewer should see this week.
     * One type keeps the SIEM query simple; the severity is what a rule
     * filters on.
     */
    const severity = kind === "break_glass" || !verdict.ok ? "warning" : "info";

    return await recordSecurityEvidence({
      type: "platform.scope_raised",
      severity,
      source: args.source,
      tenantId: args.tenantId ?? null,
      subjectType: "platform_operator",
      subjectId: args.operatorId ?? null,
      reason: justification,
      detail: {
        kind,
        justification_valid: verdict.ok,
        justification_problem: verdict.ok ? null : verdict.problem,
      },
    });
  } catch {
    /*
     * A recorder that can take down the read it is recording is worse than
     * no recorder. There is deliberately no rethrow and no second attempt.
     */
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* NOTIFY ON USE                                                        */
/* ------------------------------------------------------------------ */

export const BREAK_GLASS_ALERT_PREFIX = "[ORDENCE-BREAK-GLASS]";

/**
 * ⭐ ONE GREPPABLE LINE, PLUS SENTRY. Modelled on
 * `server/security/alerting.ts#raiseSecurityAlert`, and for the argument
 * that file makes: the log drain and Sentry both already exist in this
 * deployment, and a notification that only works once somebody configures
 * a webhook is a notification that stays unconfigured. There is no new
 * dependency and no new environment variable.
 *
 * ⚠️ THE JUSTIFICATION GOES IN THE LINE. It is the thing a reviewer needs
 * and it is written by our own staff, not by a request — the redaction
 * rules that keep credentials out of `security_events.detail` are about
 * attacker-supplied data, which this is not.
 */
export function notifyBreakGlass(entry: PlatformScopeRaise): void {
  const line =
    `${BREAK_GLASS_ALERT_PREFIX} cross-tenant break-glass scope raised. ` +
    `source=${entry.source} operator=${entry.operatorId ?? "unknown"} ` +
    `tenant=${entry.tenantId ?? "all"} ` +
    `justification=${entry.justification.replace(/[\r\n]+/g, " ").slice(0, 400)}`;

  console.warn(line);

  void import("@/lib/observability/sentry-options")
    .then(async ({ SENTRY_ENABLED }) => {
      if (!SENTRY_ENABLED) return;
      const Sentry = await import("@sentry/nextjs");
      Sentry.captureMessage(line, {
        level: "warning",
        tags: { subsystem: "platform-scope", kind: entry.kind },
      });
    })
    .catch(() => {
      /* Sentry being unavailable must never mask the notification above. */
    });
}

/* ------------------------------------------------------------------ */
/* THE WRAPPERS — what new privileged code calls                        */
/* ------------------------------------------------------------------ */

/**
 * Raise platform scope with a justification that has to be real.
 *
 * ⚠️ REFUSES BEFORE OPENING THE TRANSACTION. A validator that runs after
 * the connection is open is a validator whose failure mode is a dangling
 * transaction.
 */
export async function withJustifiedPlatformScope<T>(
  args: {
    readonly justification: string;
    readonly source: string;
    readonly operatorId?: string | null;
    readonly tenantId?: string | null;
  },
  callback: ScopeCallback<T>,
): Promise<T> {
  const verdict = validateJustification(args.justification);
  if (!verdict.ok) {
    throw new PlatformScopeRefused(verdict.problem, verdict.message);
  }

  await recordPlatformScopeRaise({
    justification: verdict.normalised,
    source: args.source,
    operatorId: args.operatorId ?? null,
    tenantId: args.tenantId ?? null,
    kind: "routine",
  });

  const { withPlatformScope: raise } = await import("@/db");
  return raise(`${args.source}: ${verdict.normalised}`, callback);
}

export class PlatformScopeRefused extends Error {
  constructor(
    readonly problem: JustificationProblem | "grant_expired" | "grant_unknown",
    message: string,
  ) {
    super(message);
    this.name = "PlatformScopeRefused";
  }
}

/* ------------------------------------------------------------------ */
/* BREAK GLASS — a grant that expires                                   */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ FIFTEEN MINUTES, MATCHING `STEP_UP_MAX_AGE_MINUTES`.
 *
 * Not a coincidence and not arbitrary. A break-glass grant that outlives
 * the step-up that authorised it means the second factor stopped being
 * required halfway through the thing it was required for.
 */
export const BREAK_GLASS_MAX_TTL_MS = 15 * 60_000;
export const BREAK_GLASS_DEFAULT_TTL_MS = 5 * 60_000;

export type BreakGlassGrant = {
  readonly id: string;
  readonly justification: string;
  readonly operatorId: string;
  readonly tenantId: string | null;
  readonly grantedAtMs: number;
  readonly expiresAtMs: number;
};

/**
 * ⚠️ IN-PROCESS, AND THAT IS A STATED LIMITATION RATHER THAN A DESIGN.
 *
 * A grant held in one serverless instance's memory does not exist for the
 * next request, which may land elsewhere. That makes this SAFE (a grant
 * cannot be replayed on another instance) and INCONVENIENT (an operator
 * may have to re-open it), and the safe half is the one worth having
 * while the durable version waits on a migration number. A
 * `platform_break_glass_grants` table is the follow-up; it is named in
 * `TRACK-REPORT.md` §4 rather than half-built here.
 */
const grants = new Map<string, BreakGlassGrant>();

export function openBreakGlass(args: {
  readonly justification: string;
  readonly operatorId: string;
  readonly tenantId?: string | null;
  readonly ttlMs?: number;
  readonly now?: number;
}): BreakGlassGrant {
  const verdict = validateJustification(args.justification);
  if (!verdict.ok) {
    throw new PlatformScopeRefused(verdict.problem, verdict.message);
  }

  const now = args.now ?? Date.now();
  /*
   * ⚠️ CLAMPED, NOT VALIDATED. A caller asking for eight hours gets fifteen
   * minutes rather than an error, because the failure mode of throwing here
   * is an operator retrying with a shorter number during an incident. The
   * clamp is recorded in the grant's own `expiresAtMs`, so nothing is
   * hidden.
   */
  const ttl = Math.min(
    Math.max(args.ttlMs ?? BREAK_GLASS_DEFAULT_TTL_MS, 60_000),
    BREAK_GLASS_MAX_TTL_MS,
  );

  const grant: BreakGlassGrant = {
    id: `bg_${now.toString(36)}_${Math.floor(now % 1_000_000).toString(36)}_${grants.size}`,
    justification: verdict.normalised,
    operatorId: args.operatorId,
    tenantId: args.tenantId ?? null,
    grantedAtMs: now,
    expiresAtMs: now + ttl,
  };

  grants.set(grant.id, grant);

  notifyBreakGlass({
    justification: grant.justification,
    source: "lib/security/platform-scope#openBreakGlass",
    operatorId: grant.operatorId,
    tenantId: grant.tenantId,
    kind: "break_glass",
    atMs: now,
  });

  void recordPlatformScopeRaise({
    justification: grant.justification,
    source: "lib/security/platform-scope#openBreakGlass",
    operatorId: grant.operatorId,
    tenantId: grant.tenantId,
    kind: "break_glass",
  });

  return grant;
}

export function isBreakGlassLive(grantId: string, now = Date.now()): boolean {
  const grant = grants.get(grantId);
  if (!grant) return false;
  return grant.expiresAtMs > now;
}

export function closeBreakGlass(grantId: string): boolean {
  return grants.delete(grantId);
}

/** Test seam. Never called by product code. */
export function __resetBreakGlass(): void {
  grants.clear();
}

/**
 * Use a break-glass grant.
 *
 * ⚠️ THE EXPIRY IS CHECKED HERE, ON EVERY USE, AND NOT ONLY WHEN THE GRANT
 * WAS OPENED. A timer that is only read at grant time is a timer that
 * never expires anything.
 */
export async function withBreakGlass<T>(
  args: {
    readonly grantId: string;
    readonly source: string;
    readonly now?: number;
  },
  callback: ScopeCallback<T>,
): Promise<T> {
  const now = args.now ?? Date.now();
  const grant = grants.get(args.grantId);

  if (!grant) {
    throw new PlatformScopeRefused(
      "grant_unknown",
      "That break-glass grant does not exist on this instance. Open a new one.",
    );
  }

  if (grant.expiresAtMs <= now) {
    grants.delete(args.grantId);
    throw new PlatformScopeRefused(
      "grant_expired",
      "That break-glass grant has expired. Open a new one and say why again.",
    );
  }

  const entry: PlatformScopeRaise = {
    justification: grant.justification,
    source: args.source,
    operatorId: grant.operatorId,
    tenantId: grant.tenantId,
    kind: "break_glass",
    atMs: now,
  };

  notifyBreakGlass(entry);
  await recordPlatformScopeRaise({
    justification: grant.justification,
    source: args.source,
    operatorId: grant.operatorId,
    tenantId: grant.tenantId,
    kind: "break_glass",
  });

  const { withPlatformScope: raise } = await import("@/db");
  return raise(`${args.source}: ${grant.justification}`, callback);
}
