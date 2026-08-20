/**
 * Ordence — PROOF: SQL 0159 and 0160 bind every role, including the table owner.
 * Track G / wave 16 and 17 / v1.83.0-alpha
 *
 * RUN IT (against a throwaway Postgres, never Neon):
 *
 *     npx tsx server/notifications/proofs/outbox-ceiling.proof.ts
 *
 * (after `node scripts/bootstrap-test-db.mjs`, which is where it gets the
 * connection details from — see below.)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS PROOF IS ACTUALLY FOR
 * ══════════════════════════════════════════════════════════════════════
 * This track's brief and `RAILWAY-VARIABLES-PASTE.txt` disagree about which
 * database role the application connects as. The brief says `neondb_owner`,
 * which OWNS the tables; the paste sheet says `ordence_app`, which does not.
 * That disagreement decides whether a GRANT is a control or a decoration,
 * and it is not settled.
 *
 * ⭐ SO 0159 USES A CHECK CONSTRAINT, WHICH DOES NOT CARE. This script shows
 * the refusal happening under BOTH roles — and, in the last section, shows
 * row-level security silently NOT applying to the second one, so the choice
 * of mechanism is a demonstrated difference rather than an argument.
 *
 * ⚠️ `postgres` HERE IS A SUPERUSER AND THE TABLE OWNER — a strictly
 * stronger bypass than `neondb_owner`, which owns the tables and carries
 * `rolbypassrls` but is not a superuser. A control that binds this role
 * binds that one.
 *
 * Every row it writes is inside a transaction that is rolled back, and the
 * throwaway tenant it needs is removed at the end.
 */

import { Client } from "pg";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * ⚠️ THE CONNECTION IS READ OUT OF `.env.test`, NOT OUT OF `process.env`,
 * AND THE GATE IS THE REASON.
 *
 * `check:env-catalogue` scans `server/**` — proof scripts included — and
 * fails the build for any `process.env.X` that is not in
 * `lib/platform/env-catalog.ts` AND on `RAILWAY-VARIABLES-PASTE.txt`. It is
 * right to: `/api/diag` reports only catalogued names, so an uncatalogued
 * read is a setting nobody can be told is missing. But `PGHOST` is not an
 * Ordence setting, this file is not application code, and both of those
 * files belong to other streams.
 *
 * ⭐ SO THE PROOF READS THE SAME FILE THE SECURITY SUITE DOES. That also
 * means it follows the throwaway database wherever `scripts/bootstrap-test-db.mjs`
 * put it, instead of carrying a second copy of the port number that goes
 * stale silently.
 */
const ENV_TEST = path.resolve(__dirname, "../../../.env.test");

function fromEnvTest(key: string): string {
  let contents: string;
  try {
    contents = readFileSync(ENV_TEST, "utf8");
  } catch {
    throw new Error(
      `Cannot read ${ENV_TEST}. Run \`node scripts/bootstrap-test-db.mjs\` first — this proof ` +
        `must never be pointed at Neon, and reading the throwaway database's own file is what stops that.`,
    );
  }
  const match = contents.match(new RegExp(`^${key}\\s*=\\s*"?([^"\n]+)"?`, "m"));
  const value = match?.[1]?.trim();
  if (!value) throw new Error(`${key} is not set in ${ENV_TEST}.`);
  return value;
}

/** `ordence_app` — NOSUPERUSER, NOBYPASSRLS, and NOT the table owner. */
const APP_URL = fromEnvTest("TEST_DATABASE_URL");
/** The owner connection. See the note above about why this models production. */
const OWNER_URL = fromEnvTest("TEST_ADMIN_DATABASE_URL");

const TENANT = "0159f00d-0000-4000-8000-000000000159";

/** A complete claim, for the probes that need to be IN `sending` legitimately. */
const CLAIM_TOKEN = "0160c1a1-0000-4000-8000-000000000160";
const CLAIMED_AT = "2026-01-01T00:00:00.000Z";

let failures = 0;

function claim(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`  ✅ ${name}`);
  } else {
    failures += 1;
    console.error(`  🔴 ${name}${detail ? `\n     ${detail}` : ""}`);
  }
}

type PgError = { code?: string; constraint?: string; message?: string };

/** The columns `email_outbox` will not accept a row without. */
function baseRow(extra: Record<string, string | number | null>) {
  return {
    tenant_id: TENANT,
    purpose: "notification",
    to_email: "ceiling@example.test",
    to_email_normalized: "ceiling@example.test",
    subject: "0159 proof",
    body_html: "<p>0159</p>",
    body_text: "0159",
    category: "system",
    ...extra,
  } as Record<string, string | number | null>;
}

function insertSql(row: Record<string, string | number | null>): {
  text: string;
  values: (string | number | null)[];
} {
  const keys = Object.keys(row);
  return {
    text: `INSERT INTO public.email_outbox (${keys.join(", ")}) VALUES (${keys
      .map((_, i) => `$${i + 1}`)
      .join(", ")})`,
    values: keys.map((k) => row[k] ?? null),
  };
}

/**
 * Attempt one insert inside a transaction that is ALWAYS rolled back.
 * Returns the constraint that refused it, or null when it was accepted.
 */
async function attempt(
  client: Client,
  row: Record<string, string | number | null>,
  withTenantContext: boolean,
): Promise<{ refusedBy: string | null; code: string | null }> {
  await client.query("BEGIN");
  try {
    if (withTenantContext) {
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [TENANT]);
    }
    const { text, values } = insertSql(row);
    await client.query(text, values);
    return { refusedBy: null, code: null };
  } catch (err) {
    const e = err as PgError;
    return { refusedBy: e.constraint ?? null, code: e.code ?? null };
  } finally {
    await client.query("ROLLBACK");
  }
}

async function main(): Promise<void> {
  console.log("\nPROOF — SQL 0159 and 0160 on public.email_outbox\n");

  const owner = new Client({ connectionString: OWNER_URL });
  const app = new Client({ connectionString: APP_URL });
  await owner.connect();
  await app.connect();

  try {
    /* ---- the throwaway workspace the foreign key needs --------------- */
    await owner.query(
      `INSERT INTO public.tenants (id, clerk_org_id, name, slug, status)
       VALUES ($1, 'org_proof_0159', '0159 proof workspace', 'proof-0159', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [TENANT],
    );

    /* ================================================================ */
    /* 1 · THE CONSTRAINTS ARE THERE, AND VALIDATED                      */
    /* ================================================================ */
    const present = await owner.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'public.email_outbox'::regclass
          AND contype = 'c' AND convalidated
          AND conname IN ('email_outbox_attempt_ceiling_check',
                          'email_outbox_max_attempts_check',
                          'email_outbox_terminal_evidence_check',
                          'email_outbox_claim_is_complete_check')
        ORDER BY conname`,
    );
    claim(
      "0159's three and 0160's one CHECK constraint exist and are VALIDATED",
      present.rowCount === 4,
      `found: ${present.rows.map((r) => r.conname).join(", ") || "none"} — has 0159 been applied?`,
    );

    /* ================================================================ */
    /* 2 · THE CEILING, UNDER BOTH ROLES                                 */
    /* ================================================================ */
    const atCeiling = baseRow({
      idempotency_key: "proof:ceiling",
      status: "queued",
      attempts: 5,
      max_attempts: 5,
    });

    const appCeiling = await attempt(app, atCeiling, true);
    claim(
      "as ordence_app: a queued row at its attempt ceiling is REFUSED",
      appCeiling.refusedBy === "email_outbox_attempt_ceiling_check",
      `code=${appCeiling.code} constraint=${appCeiling.refusedBy ?? "ACCEPTED — this row would be retried forever"}`,
    );

    /*
     * ⭐⭐ THE POINT OF THE WHOLE MIGRATION.
     * No tenant context is set for the owner, because it does not need one:
     * row-level security does not apply to this role at all. The CHECK still
     * does.
     */
    const ownerCeiling = await attempt(owner, atCeiling, false);
    claim(
      "🔴 as the TABLE OWNER (and superuser): the same row is refused by the same constraint",
      ownerCeiling.refusedBy === "email_outbox_attempt_ceiling_check",
      `code=${ownerCeiling.code} constraint=${ownerCeiling.refusedBy ?? "ACCEPTED — the protection does not bind production"}`,
    );

    /* ---- the positive control, without which the above proves nothing */
    const belowCeiling = baseRow({
      idempotency_key: "proof:below-ceiling",
      status: "queued",
      attempts: 4,
      max_attempts: 5,
    });
    const appBelow = await attempt(app, belowCeiling, true);
    claim(
      "POSITIVE CONTROL — a queued row with an attempt left is ACCEPTED",
      appBelow.refusedBy === null,
      `refused by ${appBelow.refusedBy} (${appBelow.code}) — 0159 is refusing legitimate mail`,
    );

    /* ---- and 'sending' is deliberately outside the rule -------------- */
    /*
     * ⚠️ THE CLAIM COLUMNS ARE HERE BECAUSE 0160 NOW REQUIRES THEM, and this
     * probe is how I found that out: written for 0159 as `sending` and nothing
     * else, it went red the moment 0160 applied. A `sending` row without both
     * is exactly the stranded state §6 is about.
     */
    const claimedAtCeiling = baseRow({
      idempotency_key: "proof:sending",
      status: "sending",
      attempts: 5,
      max_attempts: 5,
      claim_token: CLAIM_TOKEN,
      claimed_at: CLAIMED_AT,
    });
    const appSending = await attempt(app, claimedAtCeiling, true);
    claim(
      "POSITIVE CONTROL — a CLAIMED row at the ceiling is accepted (attempts are counted at write-back, not at claim)",
      appSending.refusedBy === null,
      `refused by ${appSending.refusedBy} — this would kill the last legitimate attempt of every message in the queue`,
    );

    /* ================================================================ */
    /* 3 · max_attempts >= 1                                             */
    /* ================================================================ */
    /*
     * ⚠️ `sending`, NOT `queued`, AND THE PROOF ITSELF TAUGHT ME THAT.
     * With `queued` this row violates TWO of 0159's constraints at once, and
     * Postgres reports whichever it evaluates first — the run named
     * `email_outbox_attempt_ceiling_check` and this claim went red while the
     * rule it was testing was working perfectly. A probe that violates
     * exactly one rule is the only kind that can name the rule it proves.
     */
    const zeroMax = await attempt(
      app,
      baseRow({
        idempotency_key: "proof:zero-max",
        status: "sending",
        attempts: 0,
        max_attempts: 0,
        claim_token: CLAIM_TOKEN,
        claimed_at: CLAIMED_AT,
      }),
      true,
    );
    claim(
      "a row that can never be attempted and never become terminal is REFUSED",
      zeroMax.refusedBy === "email_outbox_max_attempts_check",
      `constraint=${zeroMax.refusedBy ?? "ACCEPTED"}`,
    );

    /* ================================================================ */
    /* 4 · TERMINAL ROWS CARRY THEIR EVIDENCE                            */
    /* ================================================================ */
    /*
     * ⚠️ `provider_message_id` IS SUPPLIED ON PURPOSE. Without it 0097's own
     * proof-of-send constraint would fire first and this claim would be
     * proving somebody else's work. The constraint NAME is asserted, not
     * merely "it was refused".
     */
    const sentNoTimestamp = await attempt(
      app,
      baseRow({
        idempotency_key: "proof:sent-no-when",
        status: "sent",
        attempts: 1,
        max_attempts: 5,
        provider_message_id: "re_0159_proof",
      }),
      true,
    );
    claim(
      "'sent' with no sent_at is REFUSED by 0159 (not by 0097's proof-of-send rule)",
      sentNoTimestamp.refusedBy === "email_outbox_terminal_evidence_check",
      `constraint=${sentNoTimestamp.refusedBy ?? "ACCEPTED"}`,
    );

    const deadNoReason = await attempt(
      app,
      baseRow({
        idempotency_key: "proof:dead-no-why",
        status: "dead",
        attempts: 5,
        max_attempts: 5,
        dead_at: null,
      }),
      true,
    );
    claim(
      "'dead' with no dead_at and no last_error_code is REFUSED — the dead-letter queue must be able to say why",
      deadNoReason.refusedBy === "email_outbox_terminal_evidence_check",
      `constraint=${deadNoReason.refusedBy ?? "ACCEPTED"}`,
    );

    /* ================================================================ */
    /* 5 · WHY IT IS A CHECK AND NOT A POLICY OR A GRANT                 */
    /* ================================================================ */
    /*
     * 🔴 THE CONTRAST, MEASURED RATHER THAN ASSERTED. `email_outbox` carries
     * ENABLE + FORCE ROW LEVEL SECURITY and a policy naming
     * app_current_tenant_id(). With no tenant context:
     *   · ordence_app sees nothing, which is the fail-closed default working.
     *   · the owner sees everything, because RLS does not apply to it.
     * The CHECK above refused BOTH. That is the whole argument for choosing
     * one mechanism over the other, and it is now a number rather than a
     * paragraph.
     */
    await owner.query("BEGIN");
    await owner.query(
      `INSERT INTO public.email_outbox
         (tenant_id, purpose, to_email, to_email_normalized, subject,
          body_html, body_text, category, idempotency_key, status)
       VALUES ($1,'notification','rls@example.test','rls@example.test','rls probe',
               '<p/>','x','system','proof:rls-visibility','queued')`,
      [TENANT],
    );

    const ownerSees = await owner.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM public.email_outbox WHERE idempotency_key = 'proof:rls-visibility'",
    );
    claim(
      "🔴 with NO tenant context the owner reads the row anyway — RLS does not bind it",
      Number(ownerSees.rows[0]?.n ?? 0) === 1,
      `owner saw ${ownerSees.rows[0]?.n} rows; if this is 0, the local owner is not modelling production and section 5 proves nothing`,
    );
    await owner.query("COMMIT");

    await app.query("BEGIN");
    const appSees = await app.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM public.email_outbox WHERE idempotency_key = 'proof:rls-visibility'",
    );
    claim(
      "with no tenant context ordence_app reads nothing — the fail-closed default",
      Number(appSees.rows[0]?.n ?? 0) === 0,
      `ordence_app saw ${appSees.rows[0]?.n} rows with no tenant pinned`,
    );
    await app.query("ROLLBACK");


    /* ================================================================ */
    /* 6 · 0160 — A CLAIMED MESSAGE MUST CARRY ITS CLAIM                 */
    /* ================================================================ */
    /*
     * 🔴 THE STATE THIS REFUSES IS NOT "INVALID DATA", IT IS A MESSAGE THAT
     * NOTHING WILL EVER LOOK AT AGAIN. `reclaimExpiredClaims()` selects
     * `status = 'sending' AND claimed_at < <lease cutoff>`, and
     * `NULL < timestamptz` is NULL rather than true — so the one query written
     * to rescue an abandoned claim skips the row it was written for.
     * `writeBack()` names the claim token, so no worker can complete it
     * either. 0159 bounds `queued` and says nothing about `sending`,
     * deliberately. Three mechanisms, three different reasons to miss it.
     */
    const noToken = await attempt(
      app,
      baseRow({
        idempotency_key: "proof:claim-no-token",
        status: "sending",
        attempts: 1,
        max_attempts: 5,
        claimed_at: CLAIMED_AT,
      }),
      true,
    );
    claim(
      "a 'sending' row with no claim_token is REFUSED — no worker could ever write it back",
      noToken.refusedBy === "email_outbox_claim_is_complete_check",
      `constraint=${noToken.refusedBy ?? "ACCEPTED"}`,
    );

    const noClaimedAt = await attempt(
      app,
      baseRow({
        idempotency_key: "proof:claim-no-when",
        status: "sending",
        attempts: 1,
        max_attempts: 5,
        claim_token: CLAIM_TOKEN,
      }),
      true,
    );
    claim(
      "a 'sending' row with no claimed_at is REFUSED — the reclaim query could never match it",
      noClaimedAt.refusedBy === "email_outbox_claim_is_complete_check",
      `constraint=${noClaimedAt.refusedBy ?? "ACCEPTED"}`,
    );

    const ownerNoClaim = await attempt(
      owner,
      baseRow({
        idempotency_key: "proof:claim-owner",
        status: "sending",
        attempts: 1,
        max_attempts: 5,
      }),
      false,
    );
    claim(
      "🔴 as the TABLE OWNER (and superuser): the incomplete claim is refused by the same constraint",
      ownerNoClaim.refusedBy === "email_outbox_claim_is_complete_check",
      `constraint=${ownerNoClaim.refusedBy ?? "ACCEPTED — the protection does not bind production"}`,
    );

    const completeClaim = await attempt(
      app,
      baseRow({
        idempotency_key: "proof:claim-complete",
        status: "sending",
        attempts: 1,
        max_attempts: 5,
        claim_token: CLAIM_TOKEN,
        claimed_at: CLAIMED_AT,
      }),
      true,
    );
    claim(
      "POSITIVE CONTROL — a properly claimed row is ACCEPTED",
      completeClaim.refusedBy === null,
      `refused by ${completeClaim.refusedBy} — 0160 is refusing the normal claim path`,
    );

    /* ---------------------------------------------------------------- */
    /* 6b · THE STRANDING ITSELF, DEMONSTRATED RATHER THAN ASSERTED      */
    /* ---------------------------------------------------------------- */
    /*
     * ⭐⭐ THE CLAIM THAT MAKES 0160 WORTH A MIGRATION. Refusing a row proves
     * the constraint works; it does not prove the row was dangerous. So: drop
     * the constraint inside a transaction, insert the row it would have
     * refused, and run THE REAL RECLAIM PREDICATE against it — the same
     * `status = 'sending' AND claimed_at < cutoff` that
     * `server/email/outbox.ts:432` uses. Then roll the whole thing back.
     *
     * DDL is transactional in Postgres, so the constraint is never actually
     * absent outside this transaction and no row survives it.
     */
    await owner.query("BEGIN");
    try {
      await owner.query(
        "ALTER TABLE public.email_outbox DROP CONSTRAINT email_outbox_claim_is_complete_check",
      );
      await owner.query(
        `INSERT INTO public.email_outbox
           (tenant_id, purpose, to_email, to_email_normalized, subject,
            body_html, body_text, category, idempotency_key, status, claimed_at)
         VALUES ($1,'notification','stranded@example.test','stranded@example.test',
                 'stranded probe','<p/>','x','system','proof:stranded','sending', NULL)`,
        [TENANT],
      );

      const reachable = await owner.query<{ n: string }>(
        `SELECT count(*)::text AS n
           FROM public.email_outbox
          WHERE tenant_id = $1::uuid
            AND status = 'sending'
            AND claimed_at < (now() - interval '10 minutes')
            AND idempotency_key = 'proof:stranded'`,
        [TENANT],
      );

      const exists = await owner.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM public.email_outbox WHERE idempotency_key = 'proof:stranded'",
      );

      claim(
        "🔴 the row 0160 refuses IS a stranded message: it exists, and the real reclaim query cannot see it",
        Number(exists.rows[0]?.n ?? 0) === 1 && Number(reachable.rows[0]?.n ?? 0) === 0,
        `exists=${exists.rows[0]?.n} reachableByReclaim=${reachable.rows[0]?.n} — if reachable is 1 the stranding argument is wrong and 0160 should be reconsidered`,
      );
    } finally {
      await owner.query("ROLLBACK");
    }

    /* The constraint must be back, and unharmed, after that rollback. */
    const restored = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_constraint
        WHERE conrelid = 'public.email_outbox'::regclass
          AND conname = 'email_outbox_claim_is_complete_check' AND convalidated`,
    );
    claim(
      "the constraint is intact after the demonstration rolled back",
      Number(restored.rows[0]?.n ?? 0) === 1,
      "the proof has left the table without 0160 — re-apply the migration",
    );

    await owner.query("DELETE FROM public.email_outbox WHERE idempotency_key = 'proof:rls-visibility'");
  } finally {
    await owner.query("DELETE FROM public.tenants WHERE id = $1", [TENANT]).catch(() => {});
    await app.end();
    await owner.end();
  }

  console.log("");
  if (failures > 0) {
    console.error(`🔴 ${failures} claim(s) FAILED.\n`);
    process.exit(1);
  }
  console.log("✅ every claim holds.\n");
}

void main().catch((err: unknown) => {
  console.error("\n🔴 the proof could not run:", err);
  process.exit(1);
});
