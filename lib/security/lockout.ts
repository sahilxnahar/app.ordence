/**
 * Ordence — Login Lockout API (Hardening II / v1.50.0-alpha)
 * Runtime: Node. Database-backed via @/db; no Redis dependency.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS WHEN CLERK ALREADY LOCKS ACCOUNTS
 * ══════════════════════════════════════════════════════════════════════
 * Clerk's hosted sign-in enforces its own failed-attempt lockout, but
 * the platform keeps a re-checkable, audit-grade copy because:
 *
 *   1. Evidence. The security census requires lock accounts after failed
 *      logins to be a DATABASE FACT: who was locked, when, after how many
 *      failures, and when it expires. A widget decision with no record is
 *      unauditable.
 *   2. Ownership. Anything the platform itself serves (API tokens, portal
 *      URLs, worker retries) must re-check a lockout with its own data,
 *      not by trusting a third-party widget's memory.
 *   3. Floor. If someone reconfigures the Clerk project's limit, this
 *      table is the floor — the webhook keeps counting regardless.
 *
 * The webhook side (handleSignInAttemptFailed) bumps the counter; this
 * module reads it. Neither side silently deletes evidence: a lockout
 * that has expired still exists in the table until an explicit release.
 *
 * ══════════════════════════════════════════════════════════════════════
 * FAILURE MODE — REWRITTEN IN WAVE 15 (Track D). READ THE CHANGE.
 * ══════════════════════════════════════════════════════════════════════
 * The old text said: "Best-effort: if the database is unreachable,
 * isLocked() returns 'not locked' … Record paths also never throw — a
 * failed evidence write must not take down sign-in."
 *
 * Both halves of that are still true and both are still right. What was
 * missing is the sentence between them:
 *
 *   🔴 A WRITE THAT FAILED AND A WRITE THAT SUCCEEDED PRODUCED EXACTLY
 *   THE SAME OBSERVABLE BEHAVIOUR — `Promise<void>`, no return value, no
 *   log line, no event, `catch {}` with a comment where the evidence
 *   should have been.
 *
 * So the counter could be stuck at zero for every account in the system,
 * for as long as the write path was broken, and the only symptom would be
 * that nobody was ever locked out. Which is also what "nobody is being
 * attacked" looks like.
 *
 * ⭐ WHAT CHANGED, PRECISELY:
 *
 *   • `recordFailure()` returns a `LockoutWriteResult` instead of `void`.
 *     It STILL never throws — the Clerk webhook must not 5xx over
 *     evidence — but "it did not persist" is now a value the caller holds
 *     rather than a fact nobody has.
 *   • Every swallowed failure now writes a `security.evidence_write_failed`
 *     event (critical). If THAT fails too, it is one structured stderr
 *     line and the chain stops there, deliberately: a retry loop between
 *     two failing writers turns an incident into an outage.
 *   • `isLocked()` still degrades to "not locked" — availability wins on
 *     the auth path, and Clerk's own lockout is the real guard — but it
 *     now returns `degraded: true` alongside, so a caller can finally tell
 *     "this identifier is clean" from "we have no idea". They were the
 *     same value before.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 AND THE LARGER FINDING, WHICH THIS FILE CANNOT FIX ALONE
 * ══════════════════════════════════════════════════════════════════════
 * `isLocked()` AND `releaseLock()` HAVE NO PRODUCTION CALLERS. Not one.
 * `grep -rn "security/lockout" --include=*.ts` outside `tests/` returns
 * `recordFailure` in `app/api/webhooks/clerk/_webhook.ts` and nothing
 * else. So bullet 2 of the header above — "anything the platform itself
 * serves must re-check a lockout with its own data" — describes an
 * intention, not the system. Nothing re-checks. The table is written and
 * never read.
 *
 * ⭐ `releaseLock()` GAINS ITS FIRST CALLER IN THIS WAVE:
 * `app/(platform)/admin/access` — the console unlock action this header
 * has claimed since v1.50.0. `isLocked()` still has none; the surfaces
 * that should consult it (the MCP dispatcher, the portal, the worker
 * retry path) are outside Track D's ownership and are written up in
 * `TRACK-REPORT.md` §4 rather than reached for.
 */

import "server-only";

import { db, withPlatformScope } from "@/db";
import { loginLockouts } from "@/db/schema";
import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { recordSecurityEvent } from "@/server/security/record";
import { recordEvidenceWriteFailure } from "@/lib/security/evidence";

export const LOCKOUT_THRESHOLD = 5;
export const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

export type LockoutStatus = {
  locked: boolean;
  lockedUntil: Date | null;
  failedAttempts: number;
  expired: boolean; // lockedUntil set but in the past — lock is over, row remains
  /**
   * ⭐ TRUE WHEN THIS ANSWER IS A GUESS, NOT A READING.
   *
   * ⚠️ `locked: false, degraded: true` IS NOT `locked: false`. The first
   * means "we could not reach the evidence"; the second means "we looked
   * and this identifier is clean". Before wave 15 they were the identical
   * object, which made a total failure of the lockout store invisible to
   * every possible caller.
   *
   * A caller that treats `degraded` as clean is making a deliberate
   * availability choice and should say so at its own call site.
   */
  degraded: boolean;
};

/**
 * What `recordFailure()` actually managed to do.
 *
 * ⚠️ `persisted: false` IS THE WHOLE POINT OF THIS TYPE. It is what the
 * function returned as `undefined` for four waves.
 */
export type LockoutWriteResult = {
  /** Did the counter row actually reach the database? */
  readonly persisted: boolean;
  /** The counter after this failure. Null when nothing was written. */
  readonly failedAttempts: number | null;
  /** Did this call plant a new lockout window? */
  readonly lockedNow: boolean;
  /** Present only when `persisted` is false. Never a credential. */
  readonly error: string | null;
};

function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Read the current lockout state for an identifier.
 *
 * Best-effort: a DB failure degrades to "not locked" (Clerk's own
 * lockout still guards the session). The caller decides how to treat
 * degradation; availability wins on the auth path.
 */
export async function isLocked(email: string): Promise<LockoutStatus> {
  try {
    const key = normalizeEmail(email);
    /**
     * ⚠️ PLATFORM SCOPE IS REQUIRED HERE — not optional.
     *
     * `login_lockouts` is a platform-evidence table: its read boundary is
     * `tenant_id = app_current_tenant_id()` and nothing else. A read with
     * no session variables — the state a sign-in attempt is in — matches
     * nothing. withPlatformScope is what actually widens the view.
     */
    const rows = await withPlatformScope(
      "lib/security/lockout.ts: reading the credential-lockout evidence for one sign-in identifier, which is a platform-wide table with no tenant",
      async (tx) =>
        tx
          .select({
            failedAttempts: loginLockouts.failedAttempts,
            lockedUntil: loginLockouts.lockedUntil,
          })
          .from(loginLockouts)
          .where(eq(loginLockouts.email, key))
          .limit(1),
    );

    const row = rows[0];
    if (!row) {
      return {
        locked: false,
        lockedUntil: null,
        failedAttempts: 0,
        expired: false,
        degraded: false,
      };
    }

    const lockedUntil = row.lockedUntil ? new Date(row.lockedUntil) : null;
    const expired = lockedUntil !== null && lockedUntil.getTime() <= Date.now();
    return {
      locked: lockedUntil !== null && !expired,
      lockedUntil,
      failedAttempts: row.failedAttempts ?? 0,
      expired,
      degraded: false,
    };
  } catch (error) {
    /**
     * ⚠️ STILL "NOT LOCKED", AND NOW IT SAYS SO OUT LOUD.
     *
     * Availability wins on the auth path — Clerk's own lockout is the real
     * guard and blocking every sign-in in the world because our evidence
     * table is unreachable would be a self-inflicted outage. But the answer
     * is now marked `degraded`, and the failure is recorded, so "we could
     * not read the lockout store" is no longer byte-identical to "this
     * address has never failed a sign-in".
     */
    await recordEvidenceWriteFailure({
      source: "lib/security/lockout#isLocked",
      what: "lockout state read",
      subjectType: "email",
      subjectId: normalizeEmail(email),
      error,
    });
    return {
      locked: false,
      lockedUntil: null,
      failedAttempts: 0,
      expired: false,
      degraded: true,
    };
  }
}

/**
 * Called by the Clerk webhook for every failed sign-in. Idempotent-safe:
 * increments the counter, and when the threshold is crossed plants a
 * lockout window and emits auth.account_locked evidence. Best-effort —
 * a DB failure must never fail the webhook (Svix will retry, and
 * duplicate retries land as duplicate counts, which is correct:
 * evidence must not dedupe to neatness).
 *
 * ⭐ WAVE 15: RETURNS WHAT IT MANAGED TO DO. It still never throws. The
 * difference is that "the counter did not move" is now a value in the
 * caller's hand instead of an empty catch block, and it also lands in
 * `security_events` as a critical `security.evidence_write_failed`.
 *
 * ⚠️ THE RETURN VALUE IS NOT DECORATION. `tests/security/lockout-fail-loud.test.ts`
 * induces a real write failure against PostgreSQL and asserts
 * `persisted === false`; without the return value that test has nothing to
 * read, which is exactly the state this function was in before.
 */
export async function recordFailure(email: string): Promise<LockoutWriteResult> {
  const key = normalizeEmail(email);
  /*
   * ⚠️ DECLARED OUTSIDE THE `try`. These are what the function reports, and
   * a counter that lives inside the block it is reporting on is a counter
   * the catch block cannot see. That is a small version of the same bug:
   * the failure path having no access to the facts.
   */
  let attemptsWritten: number | null = null;
  let plantedLock = false;

  try {
    const now = new Date();

    await withPlatformScope(
      "lib/security/lockout.ts: recording a failed sign-in against a platform-wide identifier so repeated attempts can be counted and locked",
      async (tx) => {
        const existing = await tx
          .select({
            id: loginLockouts.id,
            failedAttempts: loginLockouts.failedAttempts,
            lockedUntil: loginLockouts.lockedUntil,
            lockedReason: loginLockouts.lockedReason,
          })
          .from(loginLockouts)
          .where(eq(loginLockouts.email, key))
          .limit(1);

        const row = existing[0];
        const attempts = (row?.failedAttempts ?? 0) + 1;
        const crossed = attempts >= LOCKOUT_THRESHOLD;
        const wasLocked =
          row?.lockedUntil !== null &&
          row?.lockedUntil !== undefined &&
          new Date(row.lockedUntil as Date).getTime() > now.getTime();

        if (!row) {
          await tx.insert(loginLockouts).values({
            email: key,
            failedAttempts: attempts,
            lockedUntil: crossed ? new Date(now.getTime() + LOCKOUT_DURATION_MS) : null,
            lockedReason: crossed ? "repeated_failed_sign_ins" : null,
            lastFailureAt: now,
          });
        } else {
          await tx
            .update(loginLockouts)
            .set({
              failedAttempts: attempts,
              lockedUntil:
                crossed && !wasLocked
                  ? new Date(now.getTime() + LOCKOUT_DURATION_MS)
                  : row.lockedUntil,
              lockedReason:
                crossed && !wasLocked ? "repeated_failed_sign_ins" : row.lockedReason,
              lastFailureAt: now,
            })
            .where(eq(loginLockouts.id, row.id));
        }

        /*
         * ⭐ SET ONLY AFTER THE WRITE STATEMENT HAS RETURNED. If the INSERT
         * or UPDATE throws, these stay null/false and the result reports
         * `persisted: false` — which is the entire fix. Setting them before
         * the write, or from the arguments, would reproduce the defect in
         * the code that reports it.
         */
        attemptsWritten = attempts;
        plantedLock = crossed && !wasLocked;

        // Evidence: every failure and every lockout activation are events.
        await recordSecurityEvent(
          {
            type: "auth.login_failed",
            severity: attempts >= LOCKOUT_THRESHOLD ? "critical" : "warning",
            source: "lib/security/lockout",
            subjectId: key,
            reason: crossed
              ? `failure ${attempts}/${LOCKOUT_THRESHOLD} — account locked for ${LOCKOUT_DURATION_MS / 60_000}min`
              : `failure ${attempts}/${LOCKOUT_THRESHOLD}`,
          },
          { noCoalesce: true },
        ).catch(async (evidenceError: unknown) => {
          /*
           * ⚠️ WAS `.catch(() => undefined)`. The counter had moved and the
           * event describing it had not, and nothing anywhere said so.
           */
          await recordEvidenceWriteFailure({
            source: "lib/security/lockout#recordFailure",
            what: `auth.login_failed event for attempt ${attempts}`,
            subjectType: "email",
            subjectId: key,
            error: evidenceError,
          });
        });

        if (crossed && !wasLocked) {
          await recordSecurityEvent(
            {
              type: "auth.account_locked",
              severity: "critical",
              source: "lib/security/lockout",
              subjectId: key,
              reason: `threshold ${LOCKOUT_THRESHOLD} crossed after ${attempts} failed sign-ins`,
            },
            { noCoalesce: true },
          ).catch(async (evidenceError: unknown) => {
            /*
             * 🔴 THE WORST OF THE SWALLOWED ONES. This is the row that says
             * an account was locked. Losing it means the lockout happened
             * and the security stream has no record that it did — the exact
             * shape of "brute force protection can be off while reporting
             * on", one level down.
             */
            await recordEvidenceWriteFailure({
              source: "lib/security/lockout#recordFailure",
              what: "auth.account_locked event",
              subjectType: "email",
              subjectId: key,
              error: evidenceError,
            });
          });
        }
      },
    );

    return {
      persisted: attemptsWritten !== null,
      failedAttempts: attemptsWritten,
      lockedNow: plantedLock,
      error: null,
    };
  } catch (error) {
    /*
     * ⭐ STILL NEVER THROWS — the Svix webhook must not 5xx over evidence,
     * and a retry will carry the failure again. But it is no longer silent:
     * the caller gets `persisted: false`, and a critical event says the
     * brute-force counter did not move.
     *
     * ⚠️ THE EVIDENCE WRITE IS AWAITED, NOT FLOATED. A floating promise in a
     * serverless function can be killed with the instance the moment the
     * webhook responds — which would leave exactly the empty table this
     * change exists to prevent.
     */
    const message =
      error instanceof Error ? error.message : String(error ?? "unknown");

    await recordEvidenceWriteFailure({
      source: "lib/security/lockout#recordFailure",
      what: "failed-sign-in counter increment",
      subjectType: "email",
      subjectId: key,
      error,
    });

    return {
      persisted: false,
      failedAttempts: null,
      lockedNow: false,
      error: message.slice(0, 300),
    };
  }
}

/**
 * Explicit release — only ever called by an administrator (the platform
 * console "unlock" action), never automatically. Clears the window AND
 * keeps the row, because an ended lockout is still audit evidence.
 */
export async function releaseLock(email: string): Promise<boolean> {
  try {
    const key = normalizeEmail(email);
    /**
     * ⚠️ Same platform-scope requirement as isLocked: the lookup read is
     * cross-tenant by design (an admin unlocks any workspace's identifier),
     * and the unscoped client would return nothing silently.
     */
    const rows = await withPlatformScope(
      "lib/security/lockout.ts: locating the lockout row an administrator has asked to clear, across every workspace because the identifier has no tenant",
      async (tx) =>
        tx
          .select({ id: loginLockouts.id })
          .from(loginLockouts)
          .where(eq(loginLockouts.email, key))
          .limit(1),
    );

    if (rows.length === 0) return false;

    const target = rows[0];
    if (!target) return false;

    await withPlatformScope(
      "lib/security/lockout.ts: clearing a credential lockout at an administrator request, keeping the row because an ended lockout is still evidence",
      async (tx) => {
        await tx
          .update(loginLockouts)
          .set({
            lockedUntil: null,
            lockedReason: "released_by_administrator",
            failedAttempts: 0,
          })
          .where(eq(loginLockouts.id, target.id));
      },
    );
    return true;
  } catch (error) {
    /*
     * ⚠️ `false` MEANS TWO DIFFERENT THINGS AND ALWAYS HAS: "there was no
     * such lockout" (returned above, correctly) and "the release failed".
     * The signature is kept — `tests/ui/repair-pass.test.ts` pins it and
     * that test is not Track D's to change — but the second meaning now
     * leaves a critical event behind it, so an administrator who clicked
     * unlock and saw nothing happen has something to point at.
     */
    await recordEvidenceWriteFailure({
      source: "lib/security/lockout#releaseLock",
      what: "administrator release of a credential lockout",
      subjectType: "email",
      subjectId: normalizeEmail(email),
      error,
    });
    return false;
  }
}

/** Test-only helper: bypass best-effort swallowing. Not exported publicly. */
export async function recordFailureOrThrow(email: string): Promise<void> {
  const key = normalizeEmail(email);
  const now = new Date();
  await withPlatformScope(
    "lib/security/lockout.ts: test-only strict failure recording that deliberately propagates its error instead of swallowing it",
    async (tx) => {
      const existing = await tx
        .select({
          id: loginLockouts.id,
          failedAttempts: loginLockouts.failedAttempts,
          lockedUntil: loginLockouts.lockedUntil,
          lockedReason: loginLockouts.lockedReason,
        })
        .from(loginLockouts)
        .where(eq(loginLockouts.email, key))
        .limit(1);

      const row = existing[0];
      const attempts = (row?.failedAttempts ?? 0) + 1;
      const crossed = attempts >= LOCKOUT_THRESHOLD;
      const wasLocked =
        row?.lockedUntil !== null &&
        row?.lockedUntil !== undefined &&
        new Date(row.lockedUntil as Date).getTime() > now.getTime();

      if (!row) {
        await tx.insert(loginLockouts).values({
          email: key,
          failedAttempts: attempts,
          lockedUntil: crossed ? new Date(now.getTime() + LOCKOUT_DURATION_MS) : null,
          lockedReason: crossed ? "repeated_failed_sign_ins" : null,
          lastFailureAt: now,
        });
      } else {
        await tx
          .update(loginLockouts)
          .set({
            failedAttempts: attempts,
            lockedUntil:
              crossed && !wasLocked
                ? new Date(now.getTime() + LOCKOUT_DURATION_MS)
                : row.lockedUntil,
            lockedReason:
              crossed && !wasLocked ? "repeated_failed_sign_ins" : row.lockedReason,
            lastFailureAt: now,
          })
          .where(eq(loginLockouts.id, row.id));
      }
    },
  );
}
