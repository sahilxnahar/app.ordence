import "server-only";

/**
 * Ordence — ⭐⭐⭐ THE PATH THAT WORKS WHEN THE DATABASE DOES NOT
 * Version: v1.77.0-alpha · Wave 9
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE FAILURE MODE THIS EXISTS FOR, IN `record.ts`'s OWN WORDS
 * ══════════════════════════════════════════════════════════════════════
 *     "the failure mode this module must not have is 'the database is
 *      unreachable during an intrusion, so nothing is recorded and
 *      nothing is alerted either'. The hook lets an operator wire a path
 *      that does not depend on Postgres."
 *
 * ⚠️ AND NOTHING HAD EVER WIRED IT. `onSecurityRecordFailure` was
 * exported, documented and called by nobody, so a failed write of a
 * CRITICAL security event produced one `console.error` and no alert. That
 * is the eighteenth instance of declared-and-unenforced found in this
 * codebase, and it is the second one found by grepping a registration
 * hook for its callers — the same method that found the rate limiter's.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ TWO DESTINATIONS, NEITHER OF THEM POSTGRES
 * ══════════════════════════════════════════════════════════════════════
 * ① THE LOG DRAIN, with a distinctive prefix. `instrumentation.ts` argues
 *    this at length and it is right: *"Railway logs — always on, no
 *    vendor, no quota, and the only thing that still works when Sentry
 *    itself is the outage."* The 12 August outage was diagnosed from
 *    them.
 *
 * ② SENTRY, when it is enabled. Searchable, grouped, alerting, names the
 *    commit — and independent of our database.
 *
 * 🔴 AND NOTHING NEW IS CONFIGURED. A hook that only works once somebody
 * adds a webhook URL is a hook that stays unwired, which is exactly how
 * this one spent its whole life. Both destinations already exist in this
 * deployment.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT NEVER GOES IN AN ALERT
 * ══════════════════════════════════════════════════════════════════════
 * The event's TYPE, its SEVERITY and the ERROR TEXT. Not the tenant's
 * data, not the subject id, not the IP. An alert is a page to a human at
 * two in the morning; it needs to say what broke, and every field beyond
 * that is a field that ends up in a third-party console.
 */

import type { SecurityEventType, SecuritySeverity } from "@/lib/security/events";

/**
 * ⭐ THE PREFIX IS THE ALERT. It is unique in this codebase, so a log
 * drain rule can be written against it without matching anything else.
 */
export const SECURITY_ALERT_PREFIX = "[ORDENCE-SECURITY-ALERT]";

let installed = false;

export function installSecurityAlerting(): void {
  if (installed) return;
  installed = true;

  /**
   * ⚠️ IMPORTED LAZILY. `record.ts` pulls in the database client, and this
   * module is loaded from `instrumentation.ts` before anything else has
   * touched it.
   */
  void import("@/server/security/record")
    .then(({ onSecurityRecordFailure }) => {
      onSecurityRecordFailure(({ type, severity, error }) => {
        raiseSecurityAlert({ type, severity, error });
      });
    })
    .catch((err: unknown) => {
      /*
       * ══════════════════════════════════════════════════════════════
       * 🔴 THIS `.catch` DID NOT EXIST, AND ITS ABSENCE PRODUCED
       *    EXACTLY THE FAILURE THIS FILE'S HEADER EXISTS TO PREVENT.
       * ══════════════════════════════════════════════════════════════
       * `record.ts` pulls in the database client at module scope. If that
       * import rejects — which is most likely when the database is
       * unreachable, which is when this alerting matters most — the
       * listener was never registered. `installSecurityAlerting()` had
       * already returned normally to `instrumentation.ts`, `register()`
       * completed green, and a failed write of a CRITICAL security event
       * then produced no `[ORDENCE-SECURITY-ALERT]` line at all. No
       * log-drain rule matched. No Sentry event was raised.
       *
       * ⚠️ AND `installed = true` IS SET BEFORE THE AWAIT, so a single
       * transient failure at boot disabled alerting for the life of the
       * process. It is reset here so a later call can retry.
       */
      installed = false;

      console.error(
        `${SECURITY_ALERT_PREFIX} type=alerting.install_failed severity=critical ` +
          `error=${err instanceof Error ? err.message.replace(/\s+/g, " ").slice(0, 300) : "unknown"} ` +
          `consequence=security event write failures will NOT be alerted from this process`,
      );
    });
}

export function raiseSecurityAlert(info: {
  type: SecurityEventType;
  severity: SecuritySeverity;
  error: string;
}): void {
  /**
   * ⚠️ ONE LINE, GREPPABLE, AND NOT A MULTI-LINE OBJECT. A log drain rule
   * matches a line. An object printed across six lines matches on the
   * first one and the alert arrives with no detail in it.
   */
  const line =
    `${SECURITY_ALERT_PREFIX} a ${info.severity} security event could not be recorded. ` +
    `type=${info.type} error=${info.error.replace(/[\r\n]+/g, " ").slice(0, 400)} ` +
    `consequence=the security_events table has a gap where this event should be`;

  console.error(line);

  /**
   * ⭐ AND TO SENTRY, AFTER the log line and never instead of it.
   *
   * ⚠️ IT CANNOT THROW. A reporter that fails while reporting a failure
   * is how an incident loses the one line that described it.
   */
  void import("@/lib/observability/sentry-options")
    .then(async ({ SENTRY_ENABLED }) => {
      if (!SENTRY_ENABLED) return;
      const Sentry = await import("@sentry/nextjs");
      Sentry.captureMessage(line, {
        level: info.severity === "critical" ? "fatal" : "error",
        tags: { subsystem: "security-events", eventType: info.type },
      });
    })
    .catch(() => {
      /* Sentry being unavailable must never mask the original failure. */
    });
}
