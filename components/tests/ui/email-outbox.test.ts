/**
 * The mail outbox — batch 152.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THESE TESTS ARE ACTUALLY GUARDING
 * ══════════════════════════════════════════════════════════════════════
 * For four batches this product wrote dunning letters into
 * `credit_dunning_log` with `delivery = 'queued'` and nothing ever sent
 * them. The screen said a reminder had been recorded; the customer heard
 * nothing; the invoice aged.
 *
 * So the interesting failures are not "does the function return the
 * right object". They are:
 *
 *   · a row claimed by one worker being claimed by a second
 *   · a crash between "the provider took it" and "we wrote it down"
 *     turning into a second copy of a payment reminder
 *   · a suppressed address being written to anyway
 *   · a rate limit being read as a failure and the message discarded
 *
 * ⚠️ PROPERTIES, NOT SHAPES. Nothing below pins an exact sentence, an
 * exact count of statuses or an exact delay in minutes. Those change for
 * good reasons and a test that breaks on them teaches people to edit
 * tests. What is pinned is behaviour that must never invert.
 *
 * ⚠️ COMMENTS AND STRINGS ARE STRIPPED BEFORE ANY SOURCE IS MATCHED.
 * Every file in this codebase explains the mistake it prevents by
 * quoting the broken shape verbatim. A test that grepped raw source
 * could not tell an explanation from a relapse, and the only way to make
 * it pass would be to delete the reason the rule exists.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  EMAIL_MAX_ATTEMPTS,
  EMAIL_OUTBOX_STATUSES,
  backoffDelayMs,
  bounceIsPermanent,
  classifyEmailFailure,
  decideAfterAttempt,
  isTerminalOutboxStatus,
  normalizeEmail,
  outboxIdempotencyKey,
} from "@/lib/email/outbox";

const ROOT = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/**
 * Strip block comments, line comments and string/template literals, so a
 * match below is CODE and never prose.
 */
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1 ")
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, "``")
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

/** The raw file, for the places where the SQL itself is the guarantee. */
const DISPATCHER = read("server/email/outbox.ts");
const DISPATCHER_CODE = code("server/email/outbox.ts");
/**
 * ⚠️ THE SWEEP MOVED OUT OF `server/actions/credit.ts` IN v1.66.0-alpha.
 *
 * These assertions were about the SWEEP and were pinned to the file it
 * happened to live in. It moved because nothing called it: a `"use
 * server"` export may not take a tenant id, so no schedule could reach
 * it, so no `credit_dunning_log` row was ever written and this
 * dispatcher, correct and tested, had nothing to drain. The properties
 * asserted below are unchanged; only the path is.
 */
const SWEEP_CODE = code("server/credit/dunning-sweep.ts");
const WEBHOOK = read("app/api/webhooks/resend/_webhook.ts");
const WEBHOOK_CODE = code("app/api/webhooks/resend/_webhook.ts");
const MIGRATION = read("SQL-FILES/0097_email_outbox_and_suppressions.sql");

/* ================================================================== */
/* ①  A CLAIMED ROW CANNOT BE CLAIMED TWICE                            */
/* ================================================================== */

describe("🔴 a claimed row cannot be claimed twice", () => {
  it("claims with a single conditional UPDATE, not a read followed by a write", () => {
    /*
     * The failure this prevents: two containers both SELECT the same
     * queued row, both find `status = 'queued'`, and both send the same
     * dunning letter. A conditional UPDATE means exactly one of them
     * changes a row.
     */
    const claim = DISPATCHER.slice(
      DISPATCHER.indexOf("async function claimBatch"),
      DISPATCHER.indexOf("async function reclaimExpiredClaims"),
    );

    expect(claim).toMatch(/UPDATE\s+email_outbox/i);
    expect(claim).toMatch(/RETURNING/i);
    // The row is only taken FROM the queued state, never from any other.
    expect(claim).toMatch(/status\s*=\s*'queued'/i);
  });

  it("uses FOR UPDATE SKIP LOCKED so a second worker takes different work", () => {
    /*
     * Without SKIP LOCKED the second worker BLOCKS on the rows the first
     * is taking, wakes when they commit, re-evaluates the predicate,
     * finds nothing, and has achieved only latency. That is not a
     * correctness bug, it is a throughput one — but it is the difference
     * between two workers and one.
     */
    expect(DISPATCHER).toMatch(/FOR\s+UPDATE\s+SKIP\s+LOCKED/i);
  });

  it("re-checks the queued predicate on the UPDATE itself, not only in the inner select", () => {
    const claim = DISPATCHER.slice(
      DISPATCHER.indexOf("async function claimBatch"),
      DISPATCHER.indexOf("async function reclaimExpiredClaims"),
    );
    // Twice: once to choose the rows, once as the guarantee.
    const occurrences = claim.match(/status\s*=\s*'queued'/gi) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
  });

  it("every write-back is fenced by the claim token, so a stale worker cannot overwrite a newer one", () => {
    const writeBack = DISPATCHER_CODE.slice(
      DISPATCHER_CODE.indexOf("async function writeBack"),
      DISPATCHER_CODE.indexOf("async function mirrorToSubject"),
    );
    expect(writeBack).toContain("claimToken");
    expect(writeBack).toContain("emailOutbox.status");
    // An empty returning() is reported as a failed write, never as success.
    expect(writeBack).toMatch(/updated\[0\]\s*!==\s*undefined/);
  });

  it("never reports a send it could not record", () => {
    /*
     * ⚠️ THE PROPERTY: the success counter is only reachable through the
     * boolean the fenced write returns. A counter incremented before the
     * write would report letters that were rolled back.
     */
    expect(DISPATCHER_CODE).toMatch(/if\s*\(!stored\)/);
    const afterGuard = DISPATCHER_CODE.slice(DISPATCHER_CODE.indexOf("if (!stored)"));
    expect(afterGuard).toContain("report.sent += 1");
  });
});

/* ================================================================== */
/* ②  A CRASH AFTER SEND DOES NOT RESEND                               */
/* ================================================================== */

describe("🔴 a crash between send and mark does not resend", () => {
  it("derives the idempotency key from the row alone, so every attempt carries the same one", () => {
    /*
     * THE PROPERTY THAT MATTERS: the key is a function of the row id and
     * nothing else. If it varied with the attempt, the provider would
     * see each retry as a new message and the recovery would deliver a
     * second copy of a payment reminder — the outcome that makes an SMB
     * look like it is harassing a customer it wants to keep.
     */
    const id = "8f14e45f-ceea-467a-9c0a-1b2c3d4e5f60";
    const first = outboxIdempotencyKey(id);
    const second = outboxIdempotencyKey(id);
    expect(second).toBe(first);
    expect(outboxIdempotencyKey("other-row")).not.toBe(first);
    expect(first).toContain(id);
  });

  it("the key is never mixed with the attempt count anywhere in the dispatcher", () => {
    const callSite = DISPATCHER_CODE.match(/idempotencyKey:\s*[^,\n]+/g) ?? [];
    expect(callSite.length).toBeGreaterThan(0);
    for (const site of callSite) {
      expect(site).not.toMatch(/attempts/);
    }
  });

  it("recovers an abandoned claim rather than leaving it stuck in sending forever", () => {
    /*
     * A worker that dies mid-send leaves the row claimed. Without a
     * reclaim it is never sent again and never reported — the same
     * silence this whole batch exists to end, reached from a different
     * direction.
     */
    expect(DISPATCHER_CODE).toContain("reclaimExpiredClaims");
    const reclaim = DISPATCHER.slice(
      DISPATCHER.indexOf("async function reclaimExpiredClaims"),
      DISPATCHER.indexOf("async function writeBack"),
    );
    expect(reclaim).toMatch(/status\s*=\s*'sending'/i);
    expect(reclaim).toMatch(/claimed_at\s*</i);
    // Reclaiming spends an attempt: an expired claim IS a spent attempt.
    expect(reclaim).toMatch(/attempts\s*=\s*attempts\s*\+\s*1/i);
  });

  it("a reclaimed row cannot exceed its own attempt ceiling", () => {
    const reclaim = DISPATCHER.slice(
      DISPATCHER.indexOf("async function reclaimExpiredClaims"),
      DISPATCHER.indexOf("async function writeBack"),
    );
    expect(reclaim).toMatch(/max_attempts/i);
    expect(reclaim).toMatch(/'dead'/);
  });
});

/* ================================================================== */
/* ③  PROOF OF SEND                                                    */
/* ================================================================== */

describe("🔴 a row with no provider id is never marked sent", () => {
  it("refuses `sent` when the provider reported success without an id", () => {
    const outcome = decideAfterAttempt({
      attempts: 0,
      maxAttempts: EMAIL_MAX_ATTEMPTS,
      ok: true,
      providerMessageId: null,
    });
    expect(outcome.status).not.toBe("sent");
  });

  it("marks sent when, and only when, an id came back", () => {
    const withId = decideAfterAttempt({
      attempts: 0,
      maxAttempts: EMAIL_MAX_ATTEMPTS,
      ok: true,
      providerMessageId: "re_abc123",
    });
    expect(withId.status).toBe("sent");
    expect(isTerminalOutboxStatus(withId.status)).toBe(true);
  });

  it("the database refuses it too, so the rule outlives the code that honours it", () => {
    expect(MIGRATION).toMatch(/provider_message_id\s+IS\s+NOT\s+NULL/i);
    expect(MIGRATION).toMatch(/CHECK\s*\(\s*status\s+NOT\s+IN/i);
  });
});

/* ================================================================== */
/* ④  A 429 RETRIES; A PERMANENT 4xx DEAD-LETTERS                      */
/* ================================================================== */

describe("🔴 rate limits retry and permanent rejections dead-letter", () => {
  it("a 429 keeps the message and schedules it again", () => {
    for (const sample of [
      { reason: "rate_limited", message: "Too many requests" },
      { reason: "provider_error", message: "HTTP 429 rate limit exceeded" },
    ]) {
      const outcome = decideAfterAttempt({
        attempts: 0,
        maxAttempts: EMAIL_MAX_ATTEMPTS,
        ok: false,
        ...sample,
      });
      expect(outcome.status).toBe("queued");
      expect(isTerminalOutboxStatus(outcome.status)).toBe(false);
      expect(outcome.delayMs).toBeGreaterThan(0);
    }
  });

  it("a permanent rejection is dead-lettered on the first attempt, with the reason kept", () => {
    for (const sample of [
      { reason: "invalid_recipient", message: "No valid recipient address was supplied." },
      { reason: "provider_error", message: "422 unprocessable entity" },
      { reason: "provider_error", message: "This address is on the blocklist" },
    ]) {
      const outcome = decideAfterAttempt({
        attempts: 0,
        maxAttempts: EMAIL_MAX_ATTEMPTS,
        ok: false,
        ...sample,
      });
      expect(outcome.status).toBe("dead");
      // ⭐ Silently dropping is worse than failing loudly, and the
      // failure is only loud if the reason survives.
      expect(outcome.explanation.length).toBeGreaterThan(20);
    }
  });

  it("a retry that runs out of attempts becomes a dead letter, not an infinite loop", () => {
    let attempts = 0;
    let status = "queued";
    // Drive it the way the dispatcher would, with a transient failure.
    for (let i = 0; i < EMAIL_MAX_ATTEMPTS + 3 && status === "queued"; i += 1) {
      const outcome = decideAfterAttempt({
        attempts,
        maxAttempts: EMAIL_MAX_ATTEMPTS,
        ok: false,
        reason: "provider_error",
        message: "503 service unavailable",
      });
      attempts = outcome.attemptsAfter;
      status = outcome.status;
    }
    expect(status).toBe("dead");
    expect(attempts).toBeLessThanOrEqual(EMAIL_MAX_ATTEMPTS);
  });

  it("backoff grows, so a provider that is already unhappy is not hammered", () => {
    const delays = [1, 2, 3, 4].map((n) => backoffDelayMs(n));
    for (let i = 1; i < delays.length; i += 1) {
      const previous = delays[i - 1] ?? 0;
      const current = delays[i] ?? 0;
      expect(current).toBeGreaterThan(previous);
    }
    // Never zero, never negative, never NaN — any of which is an
    // instant-retry loop wearing a timestamp.
    for (const n of [-5, 0, 1, 99]) {
      expect(backoffDelayMs(n)).toBeGreaterThan(0);
      expect(Number.isFinite(backoffDelayMs(n))).toBe(true);
    }
  });

  it("an unconfigured provider defers without spending an attempt", () => {
    /*
     * ⭐ THE CASE THAT WOULD OTHERWISE DISCARD EVERYTHING. A deployment
     * with no Resend key must not burn five attempts against a provider
     * it never contacted and then report the queue as drained.
     */
    const outcome = decideAfterAttempt({
      attempts: 3,
      maxAttempts: EMAIL_MAX_ATTEMPTS,
      ok: false,
      reason: "not_configured",
      message: "Email is not configured for this deployment.",
    });
    expect(outcome.status).toBe("queued");
    expect(outcome.attemptsAfter).toBe(3);
  });

  it("an unrecognised failure is retried, not discarded", () => {
    const outcome = classifyEmailFailure("unknown", "something nobody has seen before");
    expect(outcome.disposition).toBe("retry");
  });
});

/* ================================================================== */
/* ⑤  A SUPPRESSED ADDRESS IS NEVER SENT TO AGAIN                      */
/* ================================================================== */

describe("🔴 suppression", () => {
  it("matches regardless of how the address was typed", () => {
    /*
     * THE FAILURE THIS PREVENTS: the webhook stores `Bob@Example.COM`
     * and the dispatcher looks up `bob@example.com`. The suppression row
     * exists, the console shows it, and the mail keeps going out — a
     * control that reports success and does nothing.
     */
    const forms = ["bob@example.com", "  Bob@Example.COM ", "BOB@EXAMPLE.COM"];
    const normalised = new Set(forms.map(normalizeEmail));
    expect(normalised.size).toBe(1);
  });

  it("is checked at send time, after the claim, not only at enqueue", () => {
    /*
     * A letter queued on Monday and drained on Tuesday must respect a
     * bounce that arrived on Monday night. Checking only at enqueue is a
     * suppression list with a hole exactly the width of the queue.
     */
    const drain = DISPATCHER_CODE.slice(
      DISPATCHER_CODE.indexOf("export async function dispatchTenantOutbox"),
    );
    const claimIndex = drain.indexOf("claimBatch(tx");
    const suppressIndex = drain.indexOf("loadSuppressed(");
    expect(claimIndex).toBeGreaterThan(-1);
    expect(suppressIndex).toBeGreaterThan(claimIndex);
  });

  it("a soft bounce does not suppress", () => {
    /*
     * "Mailbox full" is temporary. Suppressing on it would permanently
     * silence a customer whose inbox was briefly over quota, and nobody
     * would ever notice.
     */
    expect(bounceIsPermanent("Transient")).toBe(false);
    expect(bounceIsPermanent("soft")).toBe(false);
    expect(bounceIsPermanent(null)).toBe(false);
    expect(bounceIsPermanent(undefined)).toBe(false);
    expect(bounceIsPermanent("Hard")).toBe(true);
    expect(bounceIsPermanent("permanent")).toBe(true);
  });

  it("suppression stops what is already in the queue, not only future sends", () => {
    const suppress = DISPATCHER_CODE.slice(
      DISPATCHER_CODE.indexOf("export async function suppressEmailGlobally"),
      DISPATCHER_CODE.indexOf("type ClaimedRow"),
    );
    expect(suppress).toContain("update(emailOutbox)");
    expect(suppress).toContain("emailOutbox.toEmailNormalized");
  });

  it("a duplicate webhook suppresses once, because the index treats NULL tenants as equal", () => {
    /*
     * In PostgreSQL two NULLs are not equal, so without NULLS NOT
     * DISTINCT the second delivery of the same webhook would insert a
     * second global row and quietly succeed where it must be a no-op.
     */
    expect(MIGRATION).toMatch(/NULLS\s+NOT\s+DISTINCT/i);
    expect(MIGRATION).toMatch(/WHERE\s+released_at\s+IS\s+NULL/i);
  });

  it("a tenant cannot suppress an address for everybody else", () => {
    /*
     * A tenant that could write `tenant_id = NULL` could silence an
     * address for every other customer of this product — a cross-tenant
     * denial of service costing one INSERT.
     */
    const withCheck = MIGRATION.slice(MIGRATION.indexOf("email_suppressions_tenant_isolation"));
    expect(withCheck).toMatch(/WITH\s+CHECK[\s\S]*app_platform_scope\(\)/i);
    expect(withCheck).toMatch(/app_current_tenant_id\(\)/);
  });
});

/* ================================================================== */
/* ⑥  THE WEBHOOK IS AUTHENTICATED                                     */
/* ================================================================== */

describe("🔴 the bounce webhook verifies before it believes anything", () => {
  it("refuses everything when no signing secret is configured", () => {
    /*
     * This endpoint takes addresses out of service. A version that
     * degrades to trusting its input when a variable is missing is
     * unauthenticated on exactly the day somebody forgets to set it.
     */
    expect(WEBHOOK_CODE).toContain("RESEND_WEBHOOK_SECRET");
    expect(WEBHOOK_CODE).toMatch(/if\s*\(!secret\)/);
    expect(WEBHOOK_CODE).toMatch(/status:\s*503/);
  });

  it("reads the raw body and verifies before parsing it", () => {
    const verifyAt = WEBHOOK_CODE.indexOf(".verify(");
    const textAt = WEBHOOK_CODE.indexOf("request.text()");
    expect(textAt).toBeGreaterThan(-1);
    expect(verifyAt).toBeGreaterThan(textAt);
    // request.json() would parse before verifying, and the re-serialised
    // object does not produce the same signature.
    expect(WEBHOOK_CODE).not.toContain("request.json()");
  });

  it("a bad signature is refused without saying which check failed", () => {
    const catchBlock = WEBHOOK_CODE.slice(WEBHOOK_CODE.indexOf(".verify("));
    expect(catchBlock).toMatch(/status:\s*401/);
  });

  it("the route file publishes only HTTP verbs and Next config", () => {
    const route = code("app/api/webhooks/resend/route.ts");
    const exports = route.match(/export\s+(const|function|async function|\{)[^\n]*/g) ?? [];
    for (const line of exports) {
      expect(line).toMatch(/runtime|dynamic|POST/);
    }
  });
});

/* ================================================================== */
/* ⑦  THE SWEEP NOW HAS A DRAIN, AND STILL DOES NOT LIE               */
/* ================================================================== */

describe("🔴 the dunning sweep queues a letter and something drains it", () => {
  it("enqueues only the rungs this run actually recorded", () => {
    /*
     * The insert is ON CONFLICT DO NOTHING. Enqueueing from the PLAN
     * rather than from what came back would mail a second copy of every
     * reminder each time two sweeps overlapped.
     */
    expect(SWEEP_CODE).toContain("onConflictDoNothing()");
    expect(SWEEP_CODE).toMatch(/const recorded = await tx/);
    expect(SWEEP_CODE).toMatch(/for \(const written of recorded\)/);
    expect(SWEEP_CODE).toContain("enqueueEmail(tx");
  });

  it("still records the letter as queued, never as sent", () => {
    const sweep = SWEEP_CODE.slice(
      SWEEP_CODE.indexOf("export async function sweepDunningForTenant"),
    );
    /*
     * Nothing in the sweep may write a delivery of `sent` or a `sentAt`.
     * Only the dispatcher may, and only against a provider message id.
     */
    const sweepRaw = read("server/credit/dunning-sweep.ts");
    expect(sweepRaw).not.toMatch(/delivery:\s*"sent"/);
    expect(sweep).not.toMatch(/sentAt:/);
  });

  it("only email rungs with an address earn a letter", () => {
    /*
     * ⚠️ READ FROM THE RAW SOURCE HERE, because the guard's whole meaning
     * is the literal it compares against and the stripper removes it. The
     * surrounding assertions are on stripped code, which is where a
     * comment could otherwise pass for an implementation.
     */
    const sweepRaw = read("server/credit/dunning-sweep.ts");
    expect(sweepRaw).toMatch(/action\.channel !== "email"/);
    expect(SWEEP_CODE).toMatch(/!action\.recipientEmail/);
  });

  it("the outbox row points back at the dunning row, so the board stops saying queued", () => {
    expect(SWEEP_CODE).toContain("subjectType:");
    expect(DISPATCHER_CODE).toContain("creditDunningLog");
    expect(DISPATCHER_CODE).toContain("mirrorToSubject");
  });

  it("something actually calls the drain", () => {
    /*
     * ⚠️ THE TEST THAT WOULD HAVE CAUGHT THE ORIGINAL DEFECT. A
     * dispatcher nobody invokes is the same silence with more code.
     */
    const worker = code("app/api/workers/route.ts");
    expect(worker).toContain("dispatchTenantOutbox");
    /*
     * ⭐ AND SOMETHING CALLS IT ON A SCHEDULE THE OPERATOR CAN SET —
     * v1.66.0-alpha. The nightly `{"mode":"cron"}` sweep drained the
     * outbox as a side effect of enqueuing expiry scans, so the mail
     * cadence was whatever the expiry cadence happened to be. It is now
     * a job of its own, because this is the only thing that RETRIES a
     * failed send: nightly means a bounced-then-retried letter waits
     * twenty four hours per attempt.
     */
    expect(code("server/scheduling/registry.ts")).toContain("dispatchTenantOutbox");
    /* ⚠️ RAW: `code()` blanks string literals, and the id IS a literal. */
    expect(read("server/scheduling/registry.ts")).toMatch(/id: "mail_drain"/);
  });
});

/* ================================================================== */
/* ⑧  THE OPERATOR CAN SEE IT                                          */
/* ================================================================== */

describe("⭐ every state is visible and carries a word", () => {
  it("the console offers a filter for each state the row can hold", () => {
    const table = read("components/platform/mail-outbox-table.tsx");
    for (const status of EMAIL_OUTBOX_STATUSES) {
      expect(table).toContain(`value: "${status}"`);
    }
  });

  it("names the state in words rather than relying on a colour", () => {
    const table = code("components/platform/mail-outbox-table.tsx");
    // The badge renders a word derived from the status, not a bare dot.
    expect(table).toContain("describeOutboxStatus");
  });

  it("shows why a message did not arrive", () => {
    const table = read("components/platform/mail-outbox-table.tsx");
    expect(table).toContain("lastErrorMessage");
    expect(table).toContain("no proof of send");
  });

  it("the console link is host-aware", () => {
    const table = read("components/platform/mail-outbox-table.tsx");
    expect(table).toContain('from "@/lib/platform/console-paths"');
    expect(table).not.toContain('from "@/lib/platform/console-href"');
  });
});
