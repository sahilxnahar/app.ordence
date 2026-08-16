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

vi.mock("@/db", () => {
  const realDrizzle = drizzle(adminPool, { schema });
  return {
    db: realDrizzle,
    withTenant: async (cb: any) => realDrizzle.transaction(cb as never),
    withPlatformScope: async (cb: any) => realDrizzle.transaction(cb as never),
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
        `SELECT id, event_type, severity, source, subject_id FROM security_events
         WHERE subject_id = $1 AND event_type = 'auth.login_failed'`,
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
        `SELECT detail FROM security_events WHERE subject_id = $1`,
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
        `SELECT reason FROM security_events WHERE subject_id = $1`,
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
         WHERE subject_id = $1 AND event_type = 'auth.login_failed'`,
        [subject],
      ),
    );

    expect(rows.rows[0].n).toBe(2);
  });
});
