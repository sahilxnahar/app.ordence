/**
 * Ordence — PROOF: a notification's email is durable, suppressible and
 *                  recorded, because it goes through the outbox.
 * Track G / wave 16 / v1.82.0-alpha
 *
 * RUN IT (against the throwaway Postgres, never Neon):
 *
 *     npx vitest run --config server/notifications/proofs/vitest.proofs.config.ts
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT IS BEING PROVED, AND WHAT IT REPLACES
 * ══════════════════════════════════════════════════════════════════════
 * `createNotification()` used to COMMIT and then fan out up to fifty
 * `sendEmail` calls straight at Resend. Every claim below is false of that
 * version and true of this one — `TRACK-REPORT.md` records the run of this
 * file against the reverted code and what it said.
 *
 * ⚠️ `RESEND_API_KEY` IS NOT SET IN THE TEST ENVIRONMENT, and that is not a
 * gap in the proof — it is one of the claims. An unconfigured deployment must
 * DEFER, spending no attempt, rather than dead-lettering every message it was
 * asked to send.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { createNotification } from "@/server/notifications/create";
import { dispatchTenantOutbox } from "@/server/email/outbox";

/**
 * ⚠️ `tests/setup.ts` IS THE SETUP FILE AND IS DELIBERATELY NOT IMPORTED.
 *
 * It exports an `asSuperuser` helper that would fit here exactly. Importing
 * it pulls `tests/setup.ts` into the TypeScript program — and `tsconfig.json`
 * EXCLUDES `tests`, so that file has never been typechecked in its life.
 * Importing it turns `npm run typecheck` red with five
 * `Object is possibly 'undefined'` errors under `noUncheckedIndexedAccess`,
 * in a file this track does not own and must not repair.
 *
 * ⭐ The setup file is still doing all the work that matters: vitest loads it
 * as `setupFiles`, which installs the WebSocket bridge that lets the Neon
 * driver — the one `withTenant()` uses — reach a local Postgres, and the six
 * production-safety checks that refuse to run against anything else. Only the
 * type-level dependency is avoided.
 *
 * That finding is written up in `TRACK-REPORT.md` §4.
 */
const ENV_TEST = path.resolve(__dirname, "../../../.env.test");

function fromEnvTest(key: string): string {
  const contents = readFileSync(ENV_TEST, "utf8");
  const match = contents.match(new RegExp(`^${key}\\s*=\\s*"?([^"\n]+)"?`, "m"));
  const value = match?.[1]?.trim();
  if (!value) throw new Error(`${key} is not set in ${ENV_TEST}.`);
  return value;
}

/**
 * Read and set up with the OWNER connection, so that nothing the proof
 * asserts can be an artefact of the tenant policy it is not testing.
 */
async function asSuperuser<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: fromEnvTest("TEST_ADMIN_DATABASE_URL") });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const TENANT = randomUUID();
const USER_ONE = randomUUID();
const USER_TWO = randomUUID();
const EMAIL_ONE = "one@proof-g.test";
const EMAIL_TWO = "two@proof-g.test";

/** Rows read back with the owner connection, so a read is never the thing under test. */
async function outboxFor(subjectId: string) {
  return asSuperuser(async (c) => {
    const { rows } = await c.query<{
      to_email_normalized: string;
      status: string;
      attempts: number;
      purpose: string;
      subject_type: string;
      subject_id: string;
      idempotency_key: string;
      recipient_user_id: string | null;
      last_error_code: string | null;
      provider_message_id: string | null;
    }>(
      `SELECT to_email_normalized, status, attempts, purpose, subject_type, subject_id,
              idempotency_key, recipient_user_id, last_error_code, provider_message_id
         FROM public.email_outbox
        WHERE tenant_id = $1 AND subject_id = $2
        ORDER BY to_email_normalized`,
      [TENANT, subjectId],
    );
    return rows;
  });
}

beforeAll(async () => {
  await asSuperuser(async (c) => {
    await c.query(
      `INSERT INTO public.tenants (id, clerk_org_id, name, slug, status)
       VALUES ($1, $2, 'Track G proof workspace', $3, 'active')`,
      [TENANT, `org_${TENANT.slice(0, 8)}`, `proof-g-${TENANT.slice(0, 8)}`],
    );
    for (const [id, email] of [
      [USER_ONE, EMAIL_ONE],
      [USER_TWO, EMAIL_TWO],
    ] as const) {
      await c.query(
        `INSERT INTO public.users (id, tenant_id, clerk_user_id, email, status)
         VALUES ($1, $2, $3, $4, 'active')`,
        [id, TENANT, `user_${id.slice(0, 8)}`, email],
      );
    }
  });
});

afterAll(async () => {
  await asSuperuser(async (c) => {
    await c.query("DELETE FROM public.email_suppressions WHERE email_normalized LIKE '%proof-g.test'");
    await c.query("DELETE FROM public.tenants WHERE id = $1", [TENANT]);
  });
});

/* ================================================================== */

describe("a notification's email is written in the notification's own transaction", () => {
  it("🔴 queues one outbox row per recipient instead of calling the provider", async () => {
    const created = await createNotification({
      tenantId: TENANT,
      category: "system",
      severity: "critical",
      title: "Proof: two recipients",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const rows = await outboxFor(created.id);

    /*
     * 🔴 THE CLAIM THAT IS FALSE OF THE OLD CODE. It produced ZERO rows here
     * — the messages existed only as two in-flight HTTPS requests, and after
     * them, nowhere at all.
     */
    expect(rows.map((r) => r.to_email_normalized)).toEqual([EMAIL_ONE, EMAIL_TWO]);
    expect(rows.every((r) => r.purpose === "notification")).toBe(true);
    expect(rows.every((r) => r.subject_type === "notification")).toBe(true);
    expect(rows.every((r) => r.subject_id === created.id)).toBe(true);

    /* Each row knows whose it is, so the console can answer "why this person". */
    expect(rows.map((r) => r.recipient_user_id).sort()).toEqual([USER_ONE, USER_TWO].sort());

    /* The keys are distinct, or the unique index would silence one of them. */
    expect(new Set(rows.map((r) => r.idempotency_key)).size).toBe(2);
    expect(rows.every((r) => r.idempotency_key.includes(created.id))).toBe(true);
  });

  it("with no provider configured it DEFERS — queued, and no attempt spent", async () => {
    const created = await createNotification({
      tenantId: TENANT,
      category: "system",
      severity: "warning",
      title: "Proof: deferral spends nothing",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const rows = await outboxFor(created.id);
    expect(rows).toHaveLength(2);

    /*
     * ⭐ `defer` IS THE THIRD DISPOSITION AND THE ONE PEOPLE MISS. A
     * deployment that has not been given a key yet must not burn five
     * attempts against a provider it never contacted and then dead-letter
     * every letter it was asked to send.
     */
    expect(rows.every((r) => r.status === "queued")).toBe(true);
    expect(rows.every((r) => r.attempts === 0)).toBe(true);
    expect(rows.every((r) => r.provider_message_id === null)).toBe(true);
  });

  it("🔴 a failure anywhere in the transaction leaves NEITHER the notification NOR the email", async () => {
    /*
     * ⚠️ THE FAILURE IS INJECTED AT THE DATABASE, not in TypeScript, because
     * the claim is about the transaction and not about a code path. A trigger
     * that refuses this one message is something `createNotification` cannot
     * anticipate, cannot catch selectively, and cannot compensate for.
     *
     * 🔴 THIS IS THE ONE THE OLD CODE COULD NOT PASS EVEN IN PRINCIPLE. Its
     * sends happened AFTER the commit and outside the database entirely, so
     * there was no failure of any kind that could unsend them — which is
     * §5 of the brief, verbatim: "an email is sent inside a transaction that
     * may roll back, so a customer receives a receipt for an invoice that
     * does not exist."
     */
    const marker = `Proof: rollback ${randomUUID()}`;

    await asSuperuser(async (c) => {
      await c.query(`
        CREATE OR REPLACE FUNCTION proof_g_refuse_outbox() RETURNS trigger
        LANGUAGE plpgsql AS $fn$
        BEGIN
          IF NEW.subject LIKE '%Proof: rollback%' THEN
            RAISE EXCEPTION 'proof-g: refusing this outbox row on purpose';
          END IF;
          RETURN NEW;
        END $fn$;`);
      await c.query(`
        CREATE TRIGGER proof_g_refuse_outbox
          BEFORE INSERT ON public.email_outbox
          FOR EACH ROW EXECUTE FUNCTION proof_g_refuse_outbox();`);
    });

    try {
      const created = await createNotification({
        tenantId: TENANT,
        category: "system",
        severity: "critical",
        title: marker,
      });

      expect(created.ok).toBe(false);

      const survivors = await asSuperuser(async (c) => {
        const notifications = await c.query(
          "SELECT 1 FROM public.notifications WHERE tenant_id = $1 AND title = $2",
          [TENANT, marker],
        );
        const outbox = await c.query(
          "SELECT 1 FROM public.email_outbox WHERE tenant_id = $1 AND subject = $2",
          [TENANT, `[CRITICAL] ${marker}`],
        );
        return { notifications: notifications.rowCount, outbox: outbox.rowCount };
      });

      /*
       * Both zero. Not "the email was rolled back and the notification
       * survived" — that would be the in-app feed claiming something the
       * workspace was never told about.
       */
      expect(survivors).toEqual({ notifications: 0, outbox: 0 });
    } finally {
      await asSuperuser(async (c) => {
        await c.query("DROP TRIGGER IF EXISTS proof_g_refuse_outbox ON public.email_outbox");
        await c.query("DROP FUNCTION IF EXISTS proof_g_refuse_outbox()");
      });
    }
  });
});

describe("the suppression list is now on this path, and it was not before", () => {
  it("🔴 a globally suppressed address is never offered to the provider", async () => {
    /*
     * ⚠️ GLOBAL — `tenant_id IS NULL`. A hard bounce is a property of the
     * MAILBOX, not of the workspace that happened to write to it first, and
     * mail from every workspace leaves under one sending domain. This is the
     * one email failure in the product that is not confined to the tenant
     * causing it, which is why the old direct-send path mattered so much: it
     * consulted none of this.
     */
    await asSuperuser(async (c) => {
      await c.query(
        `INSERT INTO public.email_suppressions
           (tenant_id, email_normalized, reason, source, detail)
         VALUES (NULL, $1, 'hard_bounce', 'operator', 'proof-g: this mailbox does not exist')
         ON CONFLICT DO NOTHING`,
        [EMAIL_ONE],
      );
    });

    const created = await createNotification({
      tenantId: TENANT,
      category: "system",
      severity: "critical",
      title: "Proof: suppression is honoured",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    /* The drain already ran inside createNotification; this is belt and braces. */
    await dispatchTenantOutbox({ tenantId: TENANT, limit: 5 });

    const rows = await outboxFor(created.id);
    const suppressed = rows.find((r) => r.to_email_normalized === EMAIL_ONE);
    const untouched = rows.find((r) => r.to_email_normalized === EMAIL_TWO);

    expect(suppressed?.status).toBe("suppressed");
    expect(suppressed?.last_error_code).toBe("suppressed");
    /* The other recipient is unaffected — suppression is per address, not per message. */
    expect(untouched?.status).toBe("queued");
  });
});

describe("severity still decides, and the decision is the pure one", () => {
  it("an info notification queues no email at all", async () => {
    const created = await createNotification({
      tenantId: TENANT,
      category: "system",
      title: "Proof: info is silent",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    /*
     * 🔴 THE REGRESSION THIS GUARDS. The condition once read
     * `|| !input.severity`, so an info notification with no severity passed
     * emailed every active user — and `server/ai/background-workers.ts`
     * creates those on a schedule, which made it a mail-out per worker run
     * per workspace.
     */
    expect(await outboxFor(created.id)).toHaveLength(0);
  });
});
