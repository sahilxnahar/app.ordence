# PATCH REQUEST — Track B, wave 17

Only what is **new or changed** since the wave-14 patch request. Items ①, ③, ④,
⑤, ⑥, ⑧, ⑩, ⑪ and ⑫ of that document stand unchanged unless listed below.

---

## ⓪ Already done — thank you

- **`DISCORD_ALERT_WEBHOOK_URL`** is catalogued under `Alerting`. I did **not**
  add it; `check:env-catalogue` still fails on the reconstruction for that
  reason and for `ORDENCE_EINVOICE_IRP_ENABLED` (Track E's). Confirmed that
  nothing in Track B's code path can log the value — the audit and the runnable
  proof are in `TRACK-REPORT.md §1.1`, including the one path that **could**
  leak it before this wave.

---

## ⑨ (REVISED) `server/security/alerting.ts` — chain the hook. Proven, not asserted.

**This is the item you flagged and it is now backed by a test that runs.**

`onSecurityRecordFailure()` holds **one** listener in a module-level variable.
A second registration replaces the first, silently, with nothing thrown and the
hook still holding exactly one listener. Track B therefore does **not** call it
from `installObservability()`; the chain belongs inside the single listener that
`installSecurityAlerting()` already registers.

Apply inside that listener, **after** `raiseSecurityAlert(...)`:

```ts
      onSecurityRecordFailure(({ type, severity, error }) => {
        raiseSecurityAlert({ type, severity, error });

        /**
         * ⭐ AND TO THE OPERATIONS CHANNEL, CHAINED NOT REPLACED.
         *
         * 🔴 `onSecurityRecordFailure` IS A MODULE-LEVEL SINGLE LISTENER:
         * registering a second one REPLACES the first. Track B deliberately
         * did not call it from `installObservability()` for exactly that
         * reason — doing so would have switched off the line above, from
         * inside the file that exists to improve alerting, and every test
         * would still have passed because the hook would still have had
         * exactly one listener.
         *
         * ⚠️ `raiseSecurityAlert` RUNS FIRST. The log drain and Sentry are
         * always-on and vendor-free; the Discord hop is a network call that
         * can fail. Ordering the fragile one second means a Discord outage
         * cannot cost us the line that `[ORDENCE-SECURITY-ALERT]` log rules
         * match on.
         *
         * ⚠️ FLOATING, WITH ITS OWN `.catch`. This listener runs inside
         * `recordSecurityEvent()`'s catch block, on the request path, and
         * must not be made to await a webhook. An unhandled rejection here
         * would terminate the process — the alerting system taking down the
         * thing it was reporting on.
         */
        void import("@/server/observability/alerts")
          .then(({ raiseAlert }) =>
            raiseAlert({
              alertKey: "security.event_unrecorded",
              runbook: "security-event-unrecorded",
              severity: "critical",
              title: `A ${severity} security event could not be recorded`,
              // ⚠️ THE TYPE ONLY. `error` can carry a driver message, and a
              // Postgres error can contain a row value.
              detail: { eventType: type },
              windowMinutes: 15,
            }),
          )
          .catch(() => {
            /* the log line above already went out; this must not undo it */
          });
      });
```

**Then delete ONE entry in `server/observability/caller-census.mjs`:**
`security-event-unrecorded` from `KNOWN_UNRAISED`. That is the whole edit.

🔴 **Do NOT delete `server/security/alerting.ts#raiseSecurityAlert` from
`KNOWN_UNCALLED`** — an earlier draft of this file said to, and it is wrong. The
chaining above happens *inside* `server/security/alerting.ts`, which is the
declaring file, and rule ② of the census does not count a module calling its own
export. Deleting that entry turns the gate red on a correctly-wired tree:

```
✗ server/security/alerting.ts#raiseSecurityAlert — exported by an observability
  module and called by NOTHING in app, components, lib, server, db, scripts.
```

Measured, not reasoned: I applied item ⑨ to the assembled tree, deleted both
entries as the earlier draft instructed, and got that line. The exemption's own
text has been rewritten to say KEEP, with this reason attached.

⚠️ **The gate will tell you.** Before the patch it reports the runbook as
exempt, with the reason and a deletion condition. The moment something raises
it, the reverse check fires:

```
✗ the runbook `security-event-unrecorded` is listed in KNOWN_UNRAISED as having
  no emitter, and something now raises it. Delete the exemption; it is a false
  statement about this codebase.
```

An exemption nobody revisits is a claim about the codebase that quietly stops
being true — which is exactly how this gate found that Track D had wired
`recordSecurityEventTx` while wave 14's exemption still called it an orphan.

**The proof ships with it** — `tests/security/observability-alert-chaining.test.ts`,
full text in the appendix. It runs the real `installSecurityAlerting()`, the real
`recordSecurityEvent()` and a real PostgreSQL as `ordence_app`, provokes a real
RLS-refused CRITICAL event, and shows **both** effects. Its second case is the
control: a replacing registration fires, nothing throws, and the
`[ORDENCE-SECURITY-ALERT]` line is simply gone.

⚠️ **Run the test after applying.** If it goes red, the chain was broken by
whatever changed — that is the whole point of it existing.

---

## ⑬ (NEW) `docs/RUNBOOK.md` — merge the generated observability section

Do not paste it by hand. Generate it:

```
node server/observability/runbook-section.mjs > /tmp/observability-runbook.md
```

and merge that as a section. It is produced from `RUNBOOKS` in
`server/observability/alerts.ts`, which is what the database already enforces —
`observability_alerts.runbook_key` is `NOT NULL` with a length `CHECK`, so no
alert can exist without naming one.

**Nine runbooks:** `slo-availability`, `slo-latency`, `slo-mail`, `slo-jobs`,
`tenant-error-rate`, `security-event-unrecorded`, `anomaly-detected`,
`scheduler-overdue`, `recorder-stalled`.

Once the file exists, `check:observability-callers` fails the build if a runbook
key is missing from it — so this stays merged rather than drifting. On a tree
without the document the gate says so in its summary line rather than skipping
silently.

⚠️ The generator **refuses to emit a short section**: if it parses fewer entries
than the `RunbookKey` union declares, it exits 1 naming the missing ones. A
runbook section that is silently short reads as complete.

---

## ⑭ (NEW) `SQL-FILES/TRACK-B-PENDING-NUMBER-audit-stream-comment-correction.sql`

Track B's block (0133–0135) is spent and there is no wave-17 number, so this
follows Track D's convention. **Rename it to the next free number.**

It changes one `COMMENT` — 0134's, which claimed cross-tenant read raises could
never appear in `security_event_stream`. Track D built the recorder, so the
claim is now wrong in one direction and still true in another: the rows are
**possible and absent**, because nothing calls `recordPlatformScopeRaise()`. The
new comment says exactly that.

The verify block re-asserts, in the same statement, that `security_invoker =
true` and all six branches are unchanged — a file that "only changes a comment"
is exactly the shape that quietly does more.

---

## ⑮ (NEW) `db/index.ts` — the one line that makes ⑭ true

This was item ⑪a in the wave-14 patch request and it is now more valuable, not
less: Track D built the recorder and nothing calls it.

In `withPlatformScope()`, replace the development-only `console.warn` with a
call to Track D's recorder:

```ts
  // ⭐ RECORDED, NOT ONLY WARNED IN DEVELOPMENT. A cross-tenant read is the
  // single most sensitive operation this product performs and it is the only
  // one with no record. Track D built the writer; this is its first caller.
  void import("@/lib/security/platform-scope")
    .then(({ recordPlatformScopeRaise }) =>
      recordPlatformScopeRaise({ justification: reason, source: "db.withPlatformScope" }),
    )
    .catch(() => {
      /* recording a scope raise must never break the read it is recording */
    });
```

Coordinate with Track D — `lib/security/platform-scope.ts` is theirs and they
may prefer `withJustifiedPlatformScope()` as the entry point. Either way, until
one of them has a caller, `tests/ui/security-emission.test.ts` stays red on
`platform.scope_raised reaches a surface` and the audit stream carries no
cross-tenant reads.

---

## ⑯ (NEW) Re-check the wave-14 `recordEmailSent` patch against Track G's rewrite

Wave-14 item ⑥ asked for one line in `server/email/outbox.ts` so that
`usage_counters.emails_sent` stops being 0 for every workspace on every plan —
and so that `emailsPerMonth`'s hard block at 150% can fire at all. **Track G has
since rewritten that area** (`lib/email/notifications.ts`,
`lib/email/notification-outbox.ts`, `server/notifications/create.ts`). The patch
is still correct in intent; the exact insertion point needs re-checking against
their version before it is applied.

---

## ⑰ (NEW, small) `scripts/gates.mjs` + `package.json` — the gate now has four checks

If `check:observability-callers` is being registered (wave-14 item ⑬), the
`why` should reflect what it actually does now:

```js
  {
    id: "observability-callers",
    script: "server/observability/caller-census.mjs",
    tier: "static",
    wave: 14,
    why: "an observability export nothing calls, a docs/SLOS.md target that disagrees with the code, an alert whose runbook is missing from docs/RUNBOOK.md, or a runbook nothing raises — a monitoring system with no callers reports that everything is fine",
  },
```

Unchanged: `scripts/run-gates.mjs`, `scripts/preflight.mjs` and the CI workflow
need no edit.

---

## ⑱ (NEW) Two things for whoever owns them

**`SQL-FILES/0115` — an index for a query the policy forbids.**
`ai_usage_platform_spend_idx … WHERE credential_source = 'platform'` was created
under the comment *"how much of OUR budget did this workspace spend, this
month"*. That is a platform-scoped question and `ai_usage`'s policy has no
platform branch, so the query it was built for cannot be asked. `ai_usage` is
**not** on `PLATFORM_READ_REFUSED`, so this reads as an oversight rather than a
decision. Track B now reads it per-tenant and does not need the widening; the
stated intent and the policy still disagree.

**`tests/ui/security-emission.test.ts` is red on four of Track D's types.**
`automation.event_dropped`, `billing.standing_unresolved`,
`platform.scope_raised` and `security.evidence_write_failed` are all declared and
none reaches a surface. Same shape as the ten types wave 9 found. Track D's, and
⑮ closes one of the four.

---

## Appendix — the test files, in full

Both were run against the reconstruction before delivery; the output is quoted
in `TRACK-REPORT.md §1.2` and `§1.3`. They are here because `tests/**` is
outside Track B's block, and a described test is not a test.

### `tests/security/observability-alert-chaining.test.ts`

```ts
/**
 * Ordence — the security-record hook CHAINS. Proven, not asserted.
 * Version: v1.83.0-alpha · Wave 17 · Track B
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS IS THE MOST DANGEROUS TWO LINES IN TRACK B'S PATCH REQUEST
 * ══════════════════════════════════════════════════════════════════════
 * `onSecurityRecordFailure()` in `server/security/record.ts` holds ONE
 * listener in a module-level variable. Registering a second one REPLACES
 * the first — there is no array, no `off()`, and no warning.
 *
 * `installSecurityAlerting()` holds that slot today, and its listener is
 * the only thing that reports a CRITICAL security event which failed to
 * persist. If Track B's Discord alerting had been wired by calling
 * `onSecurityRecordFailure()` from `installObservability()`, that report
 * would have silently stopped — and EVERY TEST WOULD STILL HAVE PASSED,
 * because the hook would still have had exactly one listener and nothing
 * would have thrown.
 *
 * ⚠️ SO THIS FILE DOES NOT ASSERT THAT THE CHAIN EXISTS. It installs the
 * real listener, provokes a real refused write of a real CRITICAL event
 * against a real PostgreSQL, and shows BOTH effects: the
 * `[ORDENCE-SECURITY-ALERT]` line AND the row in `observability_alerts`.
 * Then it runs the same scenario through a REPLACING implementation and
 * shows the first effect gone.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE TRIGGER IS TRACK D'S LIVE DEFECT, USED ON PURPOSE
 * ══════════════════════════════════════════════════════════════════════
 * Track D established that `recordSecurityEvent()` writes with the
 * unscoped `db` client, so a tenant-attributed row is refused by
 * `security_events`' WITH CHECK — every time, for every tenant, since the
 * table existed. That refusal is exactly what fires this hook for a
 * `critical` event, so the proof needs no fault injection: it emits
 * `tenant.cross_access_attempt`, which is one of the two criticals in the
 * vocabulary and whose own comment calls it a page-someone event.
 *
 * When PATCH-REQUEST-D item 2 lands and that write succeeds, this test
 * still holds — the trigger is then the ordinary one, a database that
 * refuses the insert — and the `REVOKE` fallback below covers it.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

import { asSuperuser, testPool } from "../setup";

/**
 * ⚠️ A REAL `@/db`, OVER THE REAL TEST POOL, AS THE NON-SUPERUSER ROLE.
 *
 * Not a stub that rejects with a hand-written error string. The whole
 * question is whether row-level security refuses the write and whether the
 * resulting failure reaches two places, and a stub would be asserting the
 * premise. `testPool` connects as `ordence_app`, which is NOSUPERUSER and
 * NOBYPASSRLS — the same posture as production's `neondb_owner` under
 * FORCE RLS.
 */
vi.mock("@/db", async () => {
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { sql } = await import("drizzle-orm");
  const { testPool } = await import("../setup");
  const schema = await import("@/db/schema");

  const database = drizzle(testPool, { schema });

  return {
    db: database,
    schema,
    withTenant: async <T,>(tenantId: string, cb: (tx: unknown) => Promise<T>): Promise<T> =>
      database.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`);
        return cb(tx);
      }),
    withPlatformScope: async <T,>(reason: string, cb: (tx: unknown) => Promise<T>): Promise<T> => {
      if (!reason || reason.length < 10) throw new Error("[SECURITY] justification required");
      return database.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.platform_scope', 'on', true)`);
        return cb(tx);
      });
    },
  };
});

const TENANT = "44444444-4444-4444-8444-444444444444";

async function alertRows(alertKey: string): Promise<number> {
  return asSuperuser(async (c) => {
    const { rows } = await c.query(
      `SELECT count(*)::int AS n FROM observability_alerts WHERE alert_key = $1`,
      [alertKey],
    );
    return rows[0].n as number;
  });
}

/**
 * The chain is async and floating by design. Wait for the effect, briefly.
 *
 * ⚠️ 🔴 IT WAITS FOR THE DELIVERY RECEIPT, NOT FOR THE ROW.
 *
 * `raiseAlert()` INSERTs the alert and then UPDATEs it with the delivery
 * outcome in a second transaction. The first version of this helper returned
 * as soon as the row existed, so it raced the UPDATE: it passed when run
 * alone and failed inside the full suite with `delivery_error` still null —
 * a flaky test that would have been "fixed" by loosening the assertion,
 * which is how a real gap gets assertion-shaped out of existence.
 */
async function waitForAlert(alertKey: string, ms = 6000): Promise<number> {
  const until = Date.now() + ms;
  let n = 0;
  while (Date.now() < until) {
    n = await asSuperuser(async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM observability_alerts
          WHERE alert_key = $1 AND (delivered_at IS NOT NULL OR delivery_error IS NOT NULL)`,
        [alertKey],
      );
      return rows[0].n as number;
    });
    if (n > 0) return n;
    await new Promise((r) => setTimeout(r, 100));
  }
  // Fall back to "the row exists at all", so the failure message can say
  // which half is missing rather than only that the count is zero.
  return alertRows(alertKey);
}

describe("the security-record failure hook chains rather than replaces", () => {
  let captured: string[] = [];
  let restore: (() => void) | null = null;

  beforeAll(async () => {
    await asSuperuser(async (c) => {
      await c.query(
        `INSERT INTO tenants (id, clerk_org_id, slug, name)
         VALUES ($1, 'org_chain_proof', 'chain-proof', 'Chain Proof Ltd')
         ON CONFLICT DO NOTHING`,
        [TENANT],
      );
      await c.query(`DELETE FROM observability_alerts WHERE alert_key LIKE 'security.event_unrecorded%'`);
    });
  });

  afterAll(async () => {
    restore?.();
    await asSuperuser(async (c) => {
      await c.query(`DELETE FROM observability_alerts WHERE alert_key LIKE 'security.event_unrecorded%'`);
    });
  });

  it("🔴 ONE refused CRITICAL event produces BOTH the log line AND the alert row", async () => {
    captured = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    };
    restore = () => {
      console.error = original;
    };

    const { installSecurityAlerting, SECURITY_ALERT_PREFIX } = await import(
      "@/server/security/alerting"
    );
    const { recordSecurityEvent, __resetRecorderStateForTests } = await import(
      "@/server/security/record"
    );

    __resetRecorderStateForTests();
    installSecurityAlerting();
    // `installSecurityAlerting` registers through a floating dynamic import.
    await new Promise((r) => setTimeout(r, 200));

    /*
     * A tenant-attributed CRITICAL event. Refused by row-level security —
     * Track D §4.1 — which is precisely the condition the hook fires on.
     */
    const written = await recordSecurityEvent(
      {
        type: "tenant.cross_access_attempt",
        severity: "critical",
        source: "chaining-proof",
        tenantId: TENANT,
        subjectType: "proof",
        subjectId: randomUUID(),
        reason: "provoked by tests/security/observability-alert-chaining.test.ts",
      },
      { noCoalesce: true },
    );

    // The write is expected to fail; that is the trigger, not the finding.
    expect(written, "the insert unexpectedly succeeded, so the hook never fired").toBe(false);

    /* ---- effect ①: the existing alerting, which must NOT be lost ---- */
    const line = captured.find((l) => l.startsWith(SECURITY_ALERT_PREFIX));
    expect(
      line,
      "the [ORDENCE-SECURITY-ALERT] line is gone — the listener was REPLACED, not chained",
    ).toBeDefined();
    expect(line).toContain("tenant.cross_access_attempt");
    expect(line).toContain("critical");

    /* ---- effect ②: the new one ---- */
    const n = await waitForAlert("security.event_unrecorded");
    expect(n, "no observability_alerts row — the chain did not reach raiseAlert()").toBeGreaterThan(0);

    const row = await asSuperuser(async (c) => {
      const { rows } = await c.query(
        `SELECT runbook_key, severity, title, detail, delivery_error
           FROM observability_alerts WHERE alert_key = 'security.event_unrecorded'
          ORDER BY last_raised_at DESC LIMIT 1`,
      );
      return rows[0];
    });

    expect(row.runbook_key).toBe("security-event-unrecorded");
    expect(row.severity).toBe("critical");
    expect(row.detail.eventType).toBe("tenant.cross_access_attempt");
    // No destination configured in the test environment, and that is reported
    // as a NON-delivery rather than as a success.
    expect(row.delivery_error).toBe("no destination configured");

    restore();
    restore = null;

    // Printed so the proof is readable in the run output, not only in a diff.
    // eslint-disable-next-line no-console
    console.log(`      ① log drain : ${line?.slice(0, 120)}`);
    // eslint-disable-next-line no-console
    console.log(`      ② alert row : runbook=${row.runbook_key} severity=${row.severity} detail=${JSON.stringify(row.detail)}`);
  });

  it("🔴 CONTROL: a REPLACING registration loses effect ① and nothing throws", async () => {
    const seen: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      seen.push(args.map(String).join(" "));
    };

    try {
      const { onSecurityRecordFailure, recordSecurityEvent, __resetRecorderStateForTests } =
        await import("@/server/security/record");

      /*
       * ⚠️ THE RESET COMES FIRST. `__resetRecorderStateForTests()` clears
       * the coalescing map AND sets `failureListener = null` — so calling it
       * after the registration below silently unregisters it, and the
       * control would "prove" the wrong thing by producing zero for the
       * wrong reason. Found by running it.
       */
      __resetRecorderStateForTests();

      /*
       * This is the mistake, written out: a second registration that only
       * does the new thing. It is one line and it reads like an addition.
       */
      let chainedFired = 0;
      onSecurityRecordFailure(() => {
        chainedFired++;
      });
      await recordSecurityEvent(
        {
          type: "tenant.cross_access_attempt",
          severity: "critical",
          source: "chaining-proof-control",
          tenantId: TENANT,
          subjectType: "proof",
          subjectId: randomUUID(),
        },
        { noCoalesce: true },
      );

      // The replacement DID run — so nothing looks broken...
      expect(chainedFired).toBe(1);
      // ...and the original is simply gone.
      expect(
        seen.some((l) => l.startsWith("[ORDENCE-SECURITY-ALERT]")),
        "the replacing registration somehow kept the original listener",
      ).toBe(false);
    } finally {
      console.error = original;
    }
  });
});
```

### `tests/security/observability-cost-telemetry.test.ts`

```ts
/**
 * Ordence — per-tenant cost telemetry, with two workspaces that differ
 * Version: v1.83.0-alpha · Wave 17 · Track B
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY TWO TENANTS AND NOT ONE
 * ══════════════════════════════════════════════════════════════════════
 * One workspace with numbers in it proves the plumbing runs. It cannot
 * distinguish a report that reads per-tenant from one that reads the whole
 * table and labels the total with whichever tenant_id it happened to see —
 * and that second thing is exactly the defect this track exists to remove,
 * because a global average hides one workspace at 40% among two hundred
 * healthy ones.
 *
 * So: two workspaces, deliberately opposite. Alpha is an AI-heavy, quiet
 * workspace. Beta is a busy, storage-heavy workspace that uses no AI at
 * all. Every dimension must come back different, and the ordering must put
 * the AI spender first — because AI tokens are the one dimension with no
 * plan cap that can run away inside a single billing period.
 *
 * ⚠️ THE READ IS THE REAL `getCostReport()` AGAINST A REAL POSTGRESQL,
 * through a real `withPlatformScope`. Not a unit test of the SQL string.
 * `usage_counters` and `usage_levels` are on `check-rls-coverage.mjs`'s
 * PLATFORM_READ_REFUSED list for tenant sessions — a workspace must not
 * read another workspace's bill — so the scope is load-bearing and a test
 * that stubbed it would be testing nothing.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

import { asSuperuser } from "../setup";

vi.mock("@/db", async () => {
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { sql } = await import("drizzle-orm");
  const { testPool } = await import("../setup");
  const schema = await import("@/db/schema");
  const database = drizzle(testPool, { schema });
  return {
    db: database,
    schema,
    withTenant: async <T,>(tenantId: string, cb: (tx: unknown) => Promise<T>): Promise<T> =>
      database.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`);
        return cb(tx);
      }),
    withPlatformScope: async <T,>(reason: string, cb: (tx: unknown) => Promise<T>): Promise<T> => {
      if (!reason || reason.length < 10) throw new Error("[SECURITY] justification required");
      return database.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.platform_scope', 'on', true)`);
        return cb(tx);
      });
    },
  };
});


/**
 * ⚠️ `ai_usage` IS APPEND-ONLY AND THE GUARD REFUSES EVEN THE SUPERUSER.
 *
 * `ordence_guard_ai_usage_append_only` raises on every UPDATE and DELETE:
 * "the edit somebody wants to make is always the one that lowers a number."
 * That is correct and this fixture had to be rewritten around it, which is
 * itself evidence the guard works.
 *
 * The trigger is disabled for the fixture and re-enabled in a `finally`, so
 * a failing assertion cannot leave a billing table unprotected.
 */
async function withAiUsageGuardOff<T>(
  c: { query: (q: string, p?: unknown[]) => Promise<unknown> },
  fn: () => Promise<T>,
): Promise<T> {
  await c.query(`ALTER TABLE ai_usage DISABLE TRIGGER ordence_guard_ai_usage_append_only`);
  try {
    return await fn();
  } finally {
    await c.query(`ALTER TABLE ai_usage ENABLE TRIGGER ordence_guard_ai_usage_append_only`);
  }
}

const ALPHA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BETA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("per-tenant cost telemetry separates two workspaces", () => {
  beforeAll(async () => {
    await asSuperuser(async (c) => {
      for (const [id, slug] of [
        [ALPHA, "cost-alpha"],
        [BETA, "cost-beta"],
      ] as const) {
        await c.query(
          `INSERT INTO tenants (id, clerk_org_id, slug, name)
             VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
          [id, `org_${slug}`, slug, slug],
        );
      }

      await withAiUsageGuardOff(c, async () => {
        await c.query(`DELETE FROM ai_usage WHERE tenant_id = ANY($1)`, [[ALPHA, BETA]]);
      });
      await c.query(`DELETE FROM usage_counters   WHERE tenant_id = ANY($1)`, [[ALPHA, BETA]]);
      await c.query(`DELETE FROM usage_levels     WHERE tenant_id = ANY($1)`, [[ALPHA, BETA]]);
      await c.query(`DELETE FROM request_outcomes WHERE tenant_id = ANY($1)`, [[ALPHA, BETA]]);

      /* ---- ALPHA: an AI-heavy, quiet workspace ------------------- */
      await c.query(
        `INSERT INTO ai_usage (tenant_id, occurred_at, provider_id, model, credential_source,
                               prompt_tokens, completion_tokens, total_tokens, feature, outcome)
         VALUES ($1, now() - interval '2 days', 'openrouter', 'gpt-4o-mini', 'platform',
                 900000, 320000, 1220000, 'assistant', 'ok')`,
        [ALPHA],
      );
      await c.query(
        `INSERT INTO usage_counters (tenant_id, metric, period_start, period_end, value)
         VALUES ($1, 'api_calls',   date_trunc('month', now()), date_trunc('month', now()) + interval '1 month', 412),
                ($1, 'emails_sent', date_trunc('month', now()), date_trunc('month', now()) + interval '1 month', 37)`,
        [ALPHA],
      );
      await c.query(
        `INSERT INTO usage_levels (tenant_id, metric, current_value, peak_value, peak_period_start)
         VALUES ($1, 'storage_bytes', 52428800, 52428800, date_trunc('month', now()))`,
        [ALPHA],
      );
      await c.query(
        `INSERT INTO request_outcomes (tenant_id, route_pattern, kind, outcome, bucket_start,
                                       observations, duration_ms_sum, duration_ms_max,
                                       le_100, le_250, le_500, le_1000, le_2000, le_5000)
         VALUES ($1, '/assistant', 'http', 'ok', date_trunc('minute', now()),
                 400, 120000, 900, 100, 250, 380, 395, 400, 400)`,
        [ALPHA],
      );

      /* ---- BETA: busy and storage-heavy, no AI at all ------------- */
      await c.query(
        `INSERT INTO usage_counters (tenant_id, metric, period_start, period_end, value)
         VALUES ($1, 'api_calls',            date_trunc('month', now()), date_trunc('month', now()) + interval '1 month', 96450),
                ($1, 'emails_sent',          date_trunc('month', now()), date_trunc('month', now()) + interval '1 month', 8140),
                ($1, 'portal_links_created', date_trunc('month', now()), date_trunc('month', now()) + interval '1 month', 231)`,
        [BETA],
      );
      await c.query(
        `INSERT INTO usage_levels (tenant_id, metric, current_value, peak_value, peak_period_start)
         VALUES ($1, 'storage_bytes', 21474836480, 21474836480, date_trunc('month', now()))`,
        [BETA],
      );
      await c.query(
        `INSERT INTO request_outcomes (tenant_id, route_pattern, kind, outcome, bucket_start,
                                       observations, duration_ms_sum, duration_ms_max,
                                       le_100, le_250, le_500, le_1000, le_2000, le_5000)
         VALUES ($1, '/invoices', 'http', 'ok', date_trunc('minute', now()),
                 96000, 41000000, 4800, 20000, 61000, 90000, 95000, 95900, 96000)`,
        [BETA],
      );
    });
  });

  afterAll(async () => {
    await asSuperuser(async (c) => {
      await withAiUsageGuardOff(c, async () => {
        await c.query(`DELETE FROM ai_usage WHERE tenant_id = ANY($1)`, [[ALPHA, BETA]]);
      });
      await c.query(`DELETE FROM usage_counters   WHERE tenant_id = ANY($1)`, [[ALPHA, BETA]]);
      await c.query(`DELETE FROM usage_levels     WHERE tenant_id = ANY($1)`, [[ALPHA, BETA]]);
      await c.query(`DELETE FROM request_outcomes WHERE tenant_id = ANY($1)`, [[ALPHA, BETA]]);
    });
  });

  it("🔴 reports two workspaces with different numbers in every dimension", async () => {
    const { getCostReport } = await import("@/server/observability/cost");
    const report = await getCostReport({ windowDays: 30, limit: 200 });

    expect(report.degraded).toBe(false);

    const alpha = report.tenants.find((t) => t.tenantId === ALPHA);
    const beta = report.tenants.find((t) => t.tenantId === BETA);

    expect(alpha, "the AI-heavy workspace is missing from the report").toBeDefined();
    expect(beta, "the busy workspace is missing from the report").toBeDefined();
    if (!alpha || !beta) return;

    /* AI — Alpha only. Beta appears with zero rather than being dropped. */
    expect(alpha.aiTotalTokens).toBe(1_220_000);
    expect(alpha.aiPromptTokens).toBe(900_000);
    expect(alpha.aiCompletionTokens).toBe(320_000);
    expect(beta.aiTotalTokens).toBe(0);

    /* 🔴 THE OUTER-JOIN CASE, WHICH IS THE ONE A JS MERGE GETS WRONG.
       Beta is in usage_counters and NOT in ai_usage; Alpha is in both.
       A naive inner join drops Beta — the busiest workspace — off the
       cost page entirely, and it looks like a quiet month. */
    expect(beta.apiCalls).toBe(96_450);
    expect(alpha.apiCalls).toBe(412);
    expect(beta.emailsSent).toBe(8_140);
    expect(alpha.emailsSent).toBe(37);
    expect(beta.portalLinksCreated).toBe(231);
    expect(alpha.portalLinksCreated).toBe(0);

    expect(beta.storageBytes).toBe(21_474_836_480);
    expect(alpha.storageBytes).toBe(52_428_800);

    expect(beta.requests).toBe(96_000);
    expect(alpha.requests).toBe(400);
    expect(beta.requestMs).toBe(41_000_000);
    expect(alpha.requestMs).toBe(120_000);

    /* Every dimension actually differs. */
    for (const [name, a, b] of [
      ["aiTotalTokens", alpha.aiTotalTokens, beta.aiTotalTokens],
      ["apiCalls", alpha.apiCalls, beta.apiCalls],
      ["emailsSent", alpha.emailsSent, beta.emailsSent],
      ["storageBytes", alpha.storageBytes, beta.storageBytes],
      ["requestMs", alpha.requestMs, beta.requestMs],
    ] as const) {
      expect(a, `${name} is identical for both workspaces`).not.toBe(b);
    }

    /* Ordering: AI tokens first. */
    const alphaIdx = report.tenants.findIndex((t) => t.tenantId === ALPHA);
    const betaIdx = report.tenants.findIndex((t) => t.tenantId === BETA);
    expect(
      alphaIdx,
      "the AI spender is not first; the one dimension with no plan cap is buried",
    ).toBeLessThan(betaIdx);

    /* 🔴 What is NOT measured is reported, not omitted. */
    const dims = report.unmeasured.map((u) => u.dimension);
    expect(dims).toContain("database time per tenant");
    expect(alpha.databaseMs).toBeNull();
    expect(beta.databaseMs).toBeNull();

    // eslint-disable-next-line no-console
    console.log(
      "\n      workspace                              aiTokens   apiCalls  emails   storage        reqMs      dbMs\n" +
        `      alpha ${ALPHA}  ${String(alpha.aiTotalTokens).padStart(8)}  ${String(alpha.apiCalls).padStart(9)}  ${String(alpha.emailsSent).padStart(6)}  ${String(alpha.storageBytes).padStart(12)}  ${String(alpha.requestMs).padStart(9)}  ${String(alpha.databaseMs)}\n` +
        `      beta  ${BETA}  ${String(beta.aiTotalTokens).padStart(8)}  ${String(beta.apiCalls).padStart(9)}  ${String(beta.emailsSent).padStart(6)}  ${String(beta.storageBytes).padStart(12)}  ${String(beta.requestMs).padStart(9)}  ${String(beta.databaseMs)}\n`,
    );
  });

  it("🔴 CONTROL: the wave-14 platform-scoped read returns zero from all three metered tables", async () => {
    /*
     * This is the query shape wave 14 shipped: one platform-scoped read
     * across usage_counters, usage_levels and ai_usage. It type-checked, it
     * was reviewed, and it returns nothing — because all three policies are
     * `USING (tenant_id = app_current_tenant_id())` with no platform branch,
     * so under platform scope the predicate is NULL and no row matches.
     *
     * No error. No warning. A cost page of zeros that reads as a quiet month.
     */
    const { testPool } = await import("../setup");
    const client = await testPool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT set_config('app.platform_scope','on',true)`);
      const { rows } = await client.query(
        `SELECT (SELECT count(*)::int FROM usage_counters) AS counters,
                (SELECT count(*)::int FROM usage_levels)   AS levels,
                (SELECT count(*)::int FROM ai_usage)       AS ai,
                (SELECT count(*)::int FROM request_outcomes) AS outcomes`,
      );
      await client.query("ROLLBACK");

      expect(rows[0].counters, "usage_counters became platform-readable").toBe(0);
      expect(rows[0].levels, "usage_levels became platform-readable").toBe(0);
      expect(rows[0].ai, "ai_usage became platform-readable").toBe(0);
      // request_outcomes IS platform-readable — SQL 0133 was written for a
      // cross-tenant status surface — which is why the request columns were
      // the only ones on the wave-14 cost page that ever had a number in them.
      expect(rows[0].outcomes).toBeGreaterThan(0);

      // eslint-disable-next-line no-console
      console.log(
        `\n      platform-scoped: usage_counters=${rows[0].counters} usage_levels=${rows[0].levels} ` +
          `ai_usage=${rows[0].ai} request_outcomes=${rows[0].outcomes}` +
          `\n      (rows exist in all four; three policies have no platform branch)\n`,
      );
    } finally {
      client.release();
    }
  });

  it("🔴 a tenant session cannot read the cost aggregate at all", async () => {
    // The report is platform-scoped for a reason: usage_counters and
    // usage_levels are on the PLATFORM_READ_REFUSED list. A workspace that
    // could read this would be reading every other workspace's bill.
    const { testPool } = await import("../setup");
    const client = await testPool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [ALPHA]);
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM usage_counters WHERE tenant_id = $1`,
        [BETA],
      );
      expect(rows[0].n, "one workspace can read another workspace's counters").toBe(0);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});
```

### `proofs/webhook-redaction.mjs`

A standalone Node script — no test runner, no database. It starts a real HTTP
server, provokes the five ways `deliverToDiscord`'s fetch can fail, and shows
the message before and after redaction, with the wave-14 behaviour as a control.

```js
#!/usr/bin/env node
/**
 * PROOF — the configured webhook URL cannot reach an error string.
 *
 * This does NOT assert. It provokes the three ways `deliverToDiscord`'s
 * fetch can fail, captures the message Node actually produces, and shows
 * the message before and after `redactDeliveryError`.
 */
import { createServer } from "node:http";

/* The function under test, transcribed verbatim from
   server/observability/alerts.ts#redactDeliveryError. */
function redactDeliveryError(text, secret) {
  let out = typeof text === "string" ? text : String(text ?? "");
  if (typeof secret === "string" && secret.length >= 12) {
    out = out.split(secret).join("[redacted-webhook]");
    const slash = secret.indexOf("/", secret.indexOf("//") + 2);
    if (slash > 0) {
      const tail = secret.slice(slash);
      if (tail.length >= 12) out = out.split(tail).join("[redacted-webhook]");
    }
  }
  return out
    .replace(/https?:\/\/\S+/gi, "[redacted-url]")
    .replace(/\b(?:[a-z0-9-]+\.)*discord(?:app)?\.com\/api\/webhooks\/\S*/gi, "[redacted-url]")
    .replace(/\b\d{6,}\/[A-Za-z0-9_-]{20,}/g, "[redacted-webhook]")
    .slice(0, 300);
}

const TOKEN = "hunter2SECRETtokenAbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const cases = [];

async function attempt(label, url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: controller.signal,
    });
    if (!res.ok) {
      cases.push({ label, raw: `(no throw — status ${res.status})`, stored: `discord responded ${res.status}`, url });
      return;
    }
    cases.push({ label, raw: "(no throw — 2xx)", stored: "(delivered)", url });
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    cases.push({ label, raw, stored: redactDeliveryError(raw, url), url });
  } finally {
    clearTimeout(timer);
  }
}

const server = createServer((req, res) => { res.writeHead(500); res.end("upstream said: " + req.url); });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

// ① a real non-2xx from a real server, whose BODY echoes the path
await attempt("non-2xx response", `http://127.0.0.1:${port}/api/webhooks/1234567890/${TOKEN}`);
// ② connection refused
await attempt("connection refused", `http://127.0.0.1:1/api/webhooks/1234567890/${TOKEN}`);
// ③ DNS failure
await attempt("dns failure", `https://no-such-host.invalid/api/webhooks/1234567890/${TOKEN}`);
// ④ 🔴 the misconfiguration: somebody pasted the token, no scheme
await attempt("unparseable value", `1234567890/${TOKEN}`);
// ⑤ a schemeless discord.com path
await attempt("schemeless discord path", `discord.com/api/webhooks/1234567890/${TOKEN}`);

server.close();

let leaked = 0;
console.log("");
for (const c of cases) {
  const leaks = c.stored.includes(TOKEN) || c.stored.includes(c.url);
  if (leaks) leaked++;
  console.log(`── ${c.label}`);
  console.log(`   node produced : ${c.raw.slice(0, 150)}`);
  console.log(`   stored/logged : ${c.stored.slice(0, 150)}`);
  console.log(`   leaks secret  : ${leaks ? "🔴 YES" : "no"}`);
  console.log("");
}

/* 🔴 THE CONTROL. Without the exact-substring pass, case ④ leaks. */
const withoutExact = (t) => t.replace(/https?:\/\/\S+/gi, "[redacted-url]").slice(0, 300);
const four = cases.find((c) => c.label === "unparseable value");
console.log("── CONTROL: the same case with pattern-matching only (the first version)");
console.log(`   stored/logged : ${withoutExact(four.raw).slice(0, 150)}`);
console.log(`   leaks secret  : ${withoutExact(four.raw).includes(TOKEN) ? "🔴 YES" : "no"}`);
console.log("");
console.log(leaked === 0 ? "✅ 0 of 5 failure paths leak the configured value." : `🔴 ${leaked} path(s) leak.`);
process.exit(leaked === 0 ? 0 : 1);
```
