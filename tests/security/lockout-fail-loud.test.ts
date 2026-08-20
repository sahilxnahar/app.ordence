/**
 * Ordence — ⭐⭐⭐ A LOCKOUT THAT DID NOT PERSIST NOW SAYS SO
 * Version: v1.82.0-alpha · Track D, wave 15
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE DEFECT
 * ══════════════════════════════════════════════════════════════════════
 * `recordFailure()` returned `Promise<void>` and swallowed every error:
 *
 *     } catch {
 *       // Best-effort: the webhook must not 5xx because of evidence writes.
 *     }
 *
 * A counter that incremented and a counter that could not be written were
 * therefore the same observable event — `undefined`. Brute-force protection
 * could be off for every account in the system and the only symptom would
 * be that nobody was ever locked out, which is also what "nobody is being
 * attacked" looks like.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE FAILURE IS INDUCED AGAINST REAL POSTGRES, NOT MOCKED
 * ══════════════════════════════════════════════════════════════════════
 * `REVOKE INSERT, UPDATE ON login_lockouts FROM ordence_app`, restored in a
 * `finally`. The suite's role is `ordence_app` (NOSUPERUSER NOBYPASSRLS),
 * so the revoke genuinely makes the write fail inside the same
 * `withPlatformScope()` transaction the webhook uses.
 *
 * ⭐ EVERY REFUSAL HAS A POSITIVE CONTROL. Without one, a test asserting
 * "persisted: false" would pass on a function that always reports failure —
 * which would be a worse bug than the one it is checking for.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { asSuperuser } from "../setup";

process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const uniqueEmail = () => `failloud-${randomUUID()}@example.invalid`;

async function withLockoutsUnwritable<T>(body: () => Promise<T>): Promise<T> {
  await asSuperuser((c) =>
    c.query(`REVOKE INSERT, UPDATE ON login_lockouts FROM ordence_app`),
  );
  try {
    return await body();
  } finally {
    await asSuperuser((c) =>
      c.query(`GRANT INSERT, UPDATE ON login_lockouts TO ordence_app`),
    );
  }
}

async function countRows(email: string): Promise<number> {
  const rows = await asSuperuser((c) =>
    c.query(`SELECT 1 FROM login_lockouts WHERE email = $1`, [email]),
  );
  return rows.rowCount ?? 0;
}

beforeEach(async () => {
  // Make sure a previous abort has not left the grant revoked.
  await asSuperuser((c) =>
    c.query(`GRANT INSERT, UPDATE ON login_lockouts TO ordence_app`),
  );
});

afterAll(async () => {
  await asSuperuser(async (c) => {
    await c.query(`GRANT INSERT, UPDATE ON login_lockouts TO ordence_app`);
    await c.query(`DELETE FROM login_lockouts WHERE email LIKE 'failloud-%'`);
  });
});

/* ================================================================== */

describe("⭐ recordFailure reports what it managed to do", () => {
  it("positive control: a working write reports persisted: true and the count", async () => {
    const { recordFailure } = await import("@/lib/security/lockout");
    const email = uniqueEmail();

    const result = await recordFailure(email);

    expect(result.persisted).toBe(true);
    expect(result.failedAttempts).toBe(1);
    expect(result.lockedNow).toBe(false);
    expect(result.error).toBeNull();
    expect(await countRows(email)).toBe(1);
  });

  it("🔴 with the write revoked, it reports persisted: false — and used to report nothing", async () => {
    const { recordFailure } = await import("@/lib/security/lockout");
    const email = uniqueEmail();

    const result = await withLockoutsUnwritable(() => recordFailure(email));

    expect(result.persisted).toBe(false);
    expect(result.failedAttempts).toBeNull();
    expect(result.error).toBeTruthy();

    /*
     * ⭐ AND THE ROW GENUINELY IS NOT THERE. Asserting only the return value
     * would leave open the possibility that the function reports failure
     * while succeeding — the mirror image of the original defect.
     */
    expect(await countRows(email)).toBe(0);
  });

  it("⭐ still never throws — the Svix webhook must not 5xx over evidence", async () => {
    const { recordFailure } = await import("@/lib/security/lockout");
    const email = uniqueEmail();

    await expect(
      withLockoutsUnwritable(() => recordFailure(email)),
    ).resolves.toBeDefined();
  });

  it("reports lockedNow exactly when the threshold is crossed", async () => {
    const { recordFailure, LOCKOUT_THRESHOLD } = await import("@/lib/security/lockout");
    const email = uniqueEmail();

    const results = [];
    for (let i = 0; i < LOCKOUT_THRESHOLD; i += 1) {
      results.push(await recordFailure(email));
    }

    expect(results.slice(0, LOCKOUT_THRESHOLD - 1).every((r) => !r.lockedNow)).toBe(true);
    expect(results[LOCKOUT_THRESHOLD - 1]?.lockedNow).toBe(true);
    expect(results[LOCKOUT_THRESHOLD - 1]?.failedAttempts).toBe(LOCKOUT_THRESHOLD);

    // A sixth failure must NOT re-plant the window and must not claim to.
    const sixth = await recordFailure(email);
    expect(sixth.persisted).toBe(true);
    expect(sixth.lockedNow).toBe(false);
  });
});

/* ================================================================== */

describe("⭐ isLocked distinguishes 'clean' from 'we could not look'", () => {
  it("a clean identifier reads locked: false, degraded: false", async () => {
    const { isLocked } = await import("@/lib/security/lockout");

    const status = await isLocked(uniqueEmail());

    expect(status.locked).toBe(false);
    expect(status.degraded).toBe(false);
  });

  it("🔴 an unreadable store reads locked: false, degraded: TRUE", async () => {
    const { isLocked } = await import("@/lib/security/lockout");
    const email = uniqueEmail();

    /*
     * ⚠️ REVOKING **SELECT** HERE, not INSERT. This is the read path, and
     * the property under test is that the two "false"s are no longer the
     * same value. Availability still wins — `locked` stays false, because
     * Clerk's own lockout is the real guard and blocking every sign-in in
     * the world over our evidence table would be a self-inflicted outage.
     */
    await asSuperuser((c) => c.query(`REVOKE SELECT ON login_lockouts FROM ordence_app`));
    try {
      const status = await isLocked(email);
      expect(status.locked).toBe(false);
      expect(status.degraded).toBe(true);
    } finally {
      await asSuperuser((c) => c.query(`GRANT SELECT ON login_lockouts TO ordence_app`));
    }
  });

  it("a real lockout still reads locked: true, degraded: false", async () => {
    const { recordFailure, isLocked, LOCKOUT_THRESHOLD } = await import(
      "@/lib/security/lockout"
    );
    const email = uniqueEmail();

    for (let i = 0; i < LOCKOUT_THRESHOLD; i += 1) await recordFailure(email);

    const status = await isLocked(email);
    expect(status.locked).toBe(true);
    expect(status.degraded).toBe(false);
    expect(status.failedAttempts).toBe(LOCKOUT_THRESHOLD);
  });
});

/* ================================================================== */

describe("⭐ a swallowed failure now leaves a critical event", () => {
  it("records security.evidence_write_failed when the counter cannot be written", async () => {
    const { recordFailure } = await import("@/lib/security/lockout");
    const email = uniqueEmail();

    /*
     * ⚠️ A WATERMARK RATHER THAN A TRUNCATE: `security_events` is
     * append-only and refuses DELETE to every role, superuser included.
     */
    const mark = await asSuperuser((c) => c.query(`SELECT now() AS t`));
    const since = (mark.rows[0] as { t: Date }).t;

    await withLockoutsUnwritable(() => recordFailure(email));

    const rows = await asSuperuser((c) =>
      c.query(
        `SELECT event_type, severity, source, reason, detail
           FROM security_events
          WHERE occurred_at >= $1 AND subject_id = $2
          ORDER BY occurred_at DESC`,
        [since, email],
      ),
    );

    expect(rows.rowCount ?? 0).toBeGreaterThan(0);

    const row = rows.rows[0] as {
      event_type: string;
      severity: string;
      source: string;
      reason: string | null;
      detail: Record<string, unknown> | null;
    };

    /*
     * ⚠️ EITHER SHAPE. `security.evidence_write_failed` is a new member of
     * the TypeScript union and the Drizzle enum; the POSTGRES enum only
     * gains it when the migration Track D holds no number for is applied.
     * Before that, the writer degrades to `anomaly.detected` carrying
     * `detail.intended_type`. Both are asserted so the file is correct on
     * both sides of that migration.
     */
    if (row.event_type !== "security.evidence_write_failed") {
      expect(row.event_type).toBe("anomaly.detected");
      expect(row.detail?.["intended_type"]).toBe("security.evidence_write_failed");
    }

    expect(row.severity).toBe("critical");
    expect(row.source).toContain("lib/security/lockout");
  });

  it("🔴 the control: a SUCCESSFUL write records no such event", async () => {
    const { recordFailure } = await import("@/lib/security/lockout");
    const email = uniqueEmail();

    const mark = await asSuperuser((c) => c.query(`SELECT now() AS t`));
    const since = (mark.rows[0] as { t: Date }).t;

    await recordFailure(email);

    const rows = await asSuperuser((c) =>
      c.query(
        `SELECT 1 FROM security_events
          WHERE occurred_at >= $1 AND subject_id = $2 AND severity = 'critical'`,
        [since, email],
      ),
    );

    expect(rows.rowCount ?? 0).toBe(0);
  });
});
