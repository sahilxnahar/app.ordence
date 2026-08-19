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
 * FAILURE MODE
 * ══════════════════════════════════════════════════════════════════════
 * Best-effort: if the database is unreachable, isLocked() returns
 * "not locked" rather than blocking every sign-in in the world. The
 * security guarantee (Clerk's own lockout) still holds; the evidence
 * copy is an extra belt. Record paths also never throw — a failed
 * evidence write must not take down sign-in.
 */

import "server-only";

import { db, withPlatformScope } from "@/db";
import { loginLockouts } from "@/db/schema";
import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { recordSecurityEvent } from "@/server/security/record";

export const LOCKOUT_THRESHOLD = 5;
export const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

export type LockoutStatus = {
  locked: boolean;
  lockedUntil: Date | null;
  failedAttempts: number;
  expired: boolean; // lockedUntil set but in the past — lock is over, row remains
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
      "lib/security/lockout.ts: read lockout state",
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
      return { locked: false, lockedUntil: null, failedAttempts: 0, expired: false };
    }

    const lockedUntil = row.lockedUntil ? new Date(row.lockedUntil) : null;
    const expired = lockedUntil !== null && lockedUntil.getTime() <= Date.now();
    return {
      locked: lockedUntil !== null && !expired,
      lockedUntil,
      failedAttempts: row.failedAttempts ?? 0,
      expired,
    };
  } catch {
    return { locked: false, lockedUntil: null, failedAttempts: 0, expired: false };
  }
}

/**
 * Called by the Clerk webhook for every failed sign-in. Idempotent-safe:
 * increments the counter, and when the threshold is crossed plants a
 * lockout window and emits auth.account_locked evidence. Best-effort —
 * a DB failure must never fail the webhook (Svix will retry, and
 * duplicate retries land as duplicate counts, which is correct:
 * evidence must not dedupe to neatness).
 */
export async function recordFailure(email: string): Promise<void> {
  try {
    const key = normalizeEmail(email);
    const now = new Date();

    await withPlatformScope(
      "lib/security/lockout.ts: record credential-attack lockout evidence",
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
        ).catch(() => undefined);

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
          ).catch(() => undefined);
        }
      },
    );
  } catch {
    // Best-effort: the webhook must not 5xx because of evidence writes.
    // Svix retries carry the failure again; the counter will catch up.
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
      "lib/security/lockout.ts: locate lockout row for administrator release",
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
      "lib/security/lockout.ts: administrator release of a credential lockout",
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
  } catch {
    return false;
  }
}

/** Test-only helper: bypass best-effort swallowing. Not exported publicly. */
export async function recordFailureOrThrow(email: string): Promise<void> {
  const key = normalizeEmail(email);
  const now = new Date();
  await withPlatformScope(
    "lib/security/lockout.ts: test-only strict failure recording",
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
