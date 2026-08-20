/**
 * Ordence — Clerk Webhook: Failed Sign-In Evidence
 * Version: v1.50.0-alpha (Wave 8 — Hardening II)
 *
 * WHAT IS PROVED HERE.
 *
 * The product's brute-force tripwire is Clerk itself: every wrong password
 * fires `sign_in.attempt_failed`, and the webhook handler must turn each
 * of those deliveries into a row in `security_events` — with the account
 * being hammered visible (the reviewer needs to know), the strategy
 * visible (guessing vs replaying), and the credential itself nowhere.
 *
 * Clerk sessions are Clerk's territory; the product's responsibility is
 * the trace. This is the trace test.
 */

import { drizzle } from "drizzle-orm/node-postgres";
import { adminPool } from "../setup";
import * as schema from "@/db/schema";

/**
 * 🔴🔴 THE SIGNATURES IN THIS MOCK WERE WRONG, AND THE COST WAS INVISIBLE
 * UNTIL WAVE 15.
 *
 * They used to read:
 *
 *     withTenant:         async (cb: any) => realDrizzle.transaction(cb)
 *     withPlatformScope:  async (cb: any) => realDrizzle.transaction(cb)
 *
 * The real functions are `withTenant(tenantId, cb, impersonationId?)` and
 * `withPlatformScope(reason, cb)`. So the mock passed the TENANT ID (or the
 * JUSTIFICATION STRING) to `transaction()` as if it were the callback, and
 * every call through them threw `transaction is not a function`.
 *
 * ⚠️ NOTHING NOTICED, because the one caller that goes through them —
 * `recordFailure()` in `lib/security/lockout.ts` — swallowed every error
 * in an empty `catch {}`. So this suite has verified the webhook's own
 * `security_events` row since wave 8 and has NEVER exercised the
 * database-backed lockout counter it also writes. The counter was zero
 * for every test in this file, and the file passed.
 *
 * ⭐ IT SURFACED THE MOMENT `recordFailure()` STOPPED SWALLOWING: a
 * `security.evidence_write_failed` row appeared next to every webhook
 * event, and two assertions in this file that counted rows per subject
 * went from 1 to 2. That is the wave 15 fix finding its first real
 * failure, in the test harness, before production.
 */
vi.mock("@/db", () => {
  const realDrizzle = drizzle(adminPool, { schema });
  return {
    db: realDrizzle,
    withTenant: async (_tenantId: string, cb: any) =>
      realDrizzle.transaction(cb as never),
    withPlatformScope: async (_reason: string, cb: any) =>
      realDrizzle.transaction(cb as never),
  };
});

import { afterAll, describe, expect, it } from "vitest";

import { handleSignInAttemptFailed } from "@/app/api/webhooks/clerk/_handlers";
import { asSuperuser, asTenant } from "../setup";

/* ------------------------------------------------------------------ */
/* environment                                                        */
/* ------------------------------------------------------------------ */

process.env.CLERK_SECRET_KEY = "placeholder-clerk-secret-key";
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY =
  "pk_test_placeholder_clerk_publishable_key";
process.env.SECURITY_EVENTS_API_KEY = "placeholder-security-events-api-key";
process.env.DATABASE_URL = "postgresql://ordence_test:test@localhost:5432/ordence_test";
process.env.NEXT_RUNTIME = "nodejs";

const attemptId = () => crypto.randomUUID();
const fixtureEmail = () => `${crypto.randomUUID()}@example.invalid`;

// NOTE: `security_events` is append-only — even superuser DELETEs are refused
// by the evidence triggers. Rows written here intentionally stay; subject_id
// values are random UUIDs per run, so repeated runs cannot collide.

function attemptEvent(opts: {
  identifier?: string | null;
  strategy?: string | null;
  clerkCode?: string | null;
  status?: string;
} = {}): {
  id: string;
  identifier: string | null;
  first_factor_verification: {
    strategy: string | null;
    error: { code: string | null; message?: string } | null;
    status: string | null;
  } | null;
} {
  return {
    id: attemptId(),
    identifier: opts.identifier ?? fixtureEmail(),
    first_factor_verification: {
      strategy: opts.strategy ?? "password",
      error: opts.clerkCode ? { code: opts.clerkCode } : null,
      status: opts.status ?? null,
    },
  };
}

describe("Clerk webhook — failed sign-in evidence", () => {
  it("writes auth.login_failed for a wrong password", async () => {
    const event = attemptEvent();
    await handleSignInAttemptFailed(event);

    const rows = await asSuperuser((c) => {
      return c.query(
        /*
         * ⚠️ FILTERED BY `source`, NOT JUST BY TYPE. With the mock repaired,
         * a failed sign-in now correctly produces TWO `auth.login_failed`
         * rows: the webhook's own, and the one `lib/security/lockout.ts`
         * writes beside the counter it increments. Both are wanted — they
         * have different sources and different retention arguments — so the
         * assertion names the one it is about.
         */
        `SELECT id, event_type, severity, source, subject_id FROM security_events
         WHERE subject_id = $1 AND event_type = 'auth.login_failed'
           AND source = 'api/webhooks/clerk'`,
        [event.identifier as string],
      );
    });

    expect(rows.rowCount ?? 0).toBe(1);
    expect(rows.rows[0].severity).toBe("warning");
    expect(rows.rows[0].source).toBe("api/webhooks/clerk");
  });

  it("records the strategy (password vs totp) but never a credential value", async () => {
    const event = attemptEvent({ strategy: "totp", clerkCode: "totp_invalid" });
    await handleSignInAttemptFailed(event);

    const rows = await asSuperuser((c) =>
      c.query(
        `SELECT detail FROM security_events
          WHERE subject_id = $1 AND source = 'api/webhooks/clerk'`,
        [event.identifier as string],
      ),
    );

    expect(rows.rowCount ?? 0).toBe(1);
    const detail = JSON.stringify(rows.rows[0].detail);
    expect(detail).toContain('"strategy":"totp"');
    expect(detail).toContain('"clerkCode":"totp_invalid"');
    expect(detail).not.toContain("totp_invalid_value");
  });

  it("falls back to status/abort reason when there is no verification error", async () => {
    const event = attemptEvent({
      strategy: null,
      clerkCode: null,
      status: "expired",
    });
    await handleSignInAttemptFailed(event);

    const rows = await asSuperuser((c) =>
      c.query(
        `SELECT reason FROM security_events
          WHERE subject_id = $1 AND source = 'api/webhooks/clerk'`,
        [event.identifier as string],
      ),
    );

    expect(rows.rowCount ?? 0).toBe(1);
    expect(rows.rows[0].reason).toContain("expired");
  });

  it("records twice for two failures — evidence must not dedupe to neatness", async () => {
    const subject = fixtureEmail();
    await handleSignInAttemptFailed(attemptEvent({ identifier: subject }));
    await handleSignInAttemptFailed(attemptEvent({ identifier: subject }));

    const rows = await asSuperuser((c) =>
      c.query(
        `SELECT COUNT(*)::int AS n FROM security_events
         WHERE subject_id = $1 AND event_type = 'auth.login_failed'
           AND source = 'api/webhooks/clerk'`,
        [subject],
      ),
    );

    expect(rows.rows[0].n).toBe(2);
  });

  /* ================================================================== */
  /* ⭐ WAVE 15 — WHAT THE REPAIRED MOCK MADE TESTABLE                   */
  /* ================================================================== */

  it("⭐ the webhook ALSO increments the database-backed lockout counter", async () => {
    /*
     * 🔴 THIS HAS NEVER BEEN ASSERTED HERE, AND COULD NOT BE: the broken
     * mock made every `withPlatformScope` call throw, `recordFailure`
     * swallowed it, and the row was never written. The counter is the
     * platform's own evidence copy — the thing `lib/security/lockout.ts`'s
     * header calls "the floor" if somebody reconfigures Clerk's limit.
     */
    const subject = fixtureEmail();
    await handleSignInAttemptFailed(attemptEvent({ identifier: subject }));

    const rows = await asSuperuser((c) =>
      c.query(
        `SELECT failed_attempts, locked_until FROM login_lockouts WHERE email = $1`,
        [subject],
      ),
    );

    expect(rows.rowCount ?? 0).toBe(1);
    expect(rows.rows[0].failed_attempts).toBe(1);
    expect(rows.rows[0].locked_until).toBeNull();
  });

  it("⭐ and the counter reaches the threshold and plants a lockout", async () => {
    const { LOCKOUT_THRESHOLD } = await import("@/lib/security/lockout");
    const subject = fixtureEmail();

    for (let i = 0; i < LOCKOUT_THRESHOLD; i += 1) {
      await handleSignInAttemptFailed(attemptEvent({ identifier: subject }));
    }

    const rows = await asSuperuser((c) =>
      c.query(
        `SELECT failed_attempts, locked_until, locked_reason
           FROM login_lockouts WHERE email = $1`,
        [subject],
      ),
    );

    expect(rows.rows[0].failed_attempts).toBe(LOCKOUT_THRESHOLD);
    expect(rows.rows[0].locked_until).not.toBeNull();
    expect(rows.rows[0].locked_reason).toBe("repeated_failed_sign_ins");
  });

  it("🔴 no evidence-write failure is recorded when the path is healthy", async () => {
    /*
     * The control for the two tests above. If the mock regressed to its
     * broken signatures, `recordFailure` would fail again — and this
     * assertion is what would say so, instead of the silence that hid it
     * for seven waves.
     */
    const subject = fixtureEmail();
    await handleSignInAttemptFailed(attemptEvent({ identifier: subject }));

    const rows = await asSuperuser((c) =>
      c.query(
        `SELECT 1 FROM security_events
          WHERE subject_id = $1 AND severity = 'critical'`,
        [subject],
      ),
    );

    expect(rows.rowCount ?? 0).toBe(0);
  });
});
