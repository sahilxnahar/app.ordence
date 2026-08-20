/**
 * Ordence — 🔴 THE HOOK THAT HOLDS ONE LISTENER, AND WHAT THAT COSTS
 * Version: v1.83.0-alpha · Track D, wave 17
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE CHECK INTEGRATION ASKED FOR, AND ITS ANSWER
 * ══════════════════════════════════════════════════════════════════════
 * *"Track B added an alerting hook that must chain rather than replace
 * your security-record hook — if it replaces, your newly-reachable
 * evidence disappears silently. Check that specifically."*
 *
 * ⭐ CHECKED, AND TRACK B DID NOT REPLACE IT. `server/observability/runtime.ts`
 * declines to call `onSecurityRecordFailure()` and says why in its own
 * header, and `PATCH-REQUEST-B.md` item ⑨ proposes the chain in the right
 * place — INSIDE the listener `installSecurityAlerting()` already
 * registers, rather than as a second registration. Both are correct.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ AND THAT IS THE PROBLEM, NOT THE RESOLUTION
 * ══════════════════════════════════════════════════════════════════════
 * The property "only one thing registers" is currently held by:
 *
 *   • a comment in `server/observability/runtime.ts`,
 *   • a paragraph in `PATCH-REQUEST-B.md`,
 *   • and Track B's author having read `record.ts` carefully.
 *
 * None of those is a control. `onSecurityRecordFailure` is a module-level
 * single-slot setter — `failureListener = listener` — so the SECOND caller
 * silently wins, every test still passes (the hook still has exactly one
 * listener), and the thing that stops reporting is a CRITICAL security
 * event that failed to persist. That is this repository's signature defect
 * with a lit fuse rather than a live one.
 *
 * ⭐ SO THIS FILE MAKES IT A CONTROL, in the only two ways Track D can:
 *
 *   ① It proves the setter really is last-write-wins, by calling it twice
 *      and watching which listener fires. A future refactor that makes it
 *      chain will fail this test, and the fix is to delete the test with a
 *      note — which is exactly the review that change deserves.
 *   ② It counts registration sites in the whole tree and pins the number at
 *      ONE. The moment a second `onSecurityRecordFailure(` appears anywhere
 *      in `app/`, `lib/`, `server/` or `instrumentation.ts`, this goes red
 *      naming the file — before the silent replacement ships, not after.
 *
 * `server/security/record.ts` is not Track D's file; making the hook a real
 * chain is four lines and is `PATCH-REQUEST-D.md` item 1.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
/** Comments discuss a hook; they do not register one. */
const codeOnly = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

afterEach(async () => {
  const { __resetRecorderStateForTests } = await import("@/server/security/record");
  __resetRecorderStateForTests();
});

/* ================================================================== */
/* ① THE SETTER IS LAST-WRITE-WINS                                     */
/* ================================================================== */


/**
 * ⭐ THE INDUCTION, REWRITTEN AT INTEGRATION, WAVE 17.
 *
 * A REVOKE is independent of how the recorder routes its write, so unlike the
 * previous induction it cannot be repaired out from under this test by a fix
 * somewhere else. `security_events` refuses DELETE to every role, so there is
 * nothing to clean up: the row simply never exists.
 */
async function withRevokedInsert<T>(body: () => Promise<T>): Promise<T> {
  const { asSuperuser } = await import("../setup");
  await asSuperuser((c) =>
    c.query(`REVOKE INSERT ON security_events FROM ordence_app`),
  );
  try {
    return await body();
  } finally {
    await asSuperuser((c) =>
      c.query(`GRANT INSERT ON security_events TO ordence_app`),
    );
  }
}

describe("🔴 onSecurityRecordFailure holds ONE listener, and the second replaces the first", () => {
  it("proves it by registering twice and firing", async () => {
    const { onSecurityRecordFailure, recordSecurityEvent, __resetRecorderStateForTests } =
      await import("@/server/security/record");

    __resetRecorderStateForTests();

    const first = vi.fn();
    const second = vi.fn();
    onSecurityRecordFailure(first);
    onSecurityRecordFailure(second);

    /*
     * ⚠️ THE FAILURE IS INDUCED, NOT SIMULATED , AND THE OLD INDUCTION STOPPED
     * WORKING BECAUSE THE DEFECT IT USED WAS FIXED.
     *
     * Track D wave 17 induced this by writing a `critical` event WITH a tenant
     * id, relying on wave 15 §4.1: the unscoped client cannot satisfy
     * `security_events`' WITH CHECK, so the INSERT was refused. Integration
     * then applied Track D's OWN patch request item 2, and an attributed event
     * now routes through `withTenant()` and succeeds. The induction evaporated
     * and this test went red on correct code.
     *
     * ⭐ THAT IS THE PIPELINE WORKING. Track D built on a reconstruction that
     * did not contain integration's fix, and the collision surfaced here rather
     * than in production. Rewritten at integration to induce the failure by
     * REVOKING INSERT, which is independent of any routing decision and cannot
     * be repaired out from under it.
     */
    await withRevokedInsert(async () => {
    const written = await recordSecurityEvent(
      {
        type: "tenant.cross_access_attempt",
        severity: "critical",
        source: "tests/security/security-record-hook-chain",
        tenantId: "11111111-1111-4111-8111-111111111111",
        reason: "Track D wave 17: forcing the escalation hook to fire.",
      },
      { noCoalesce: true },
    );

    expect(written).toBe(false);

    /* 🔴 The first listener never ran. It was silently replaced. */
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    });
  });

  it("⭐ and the surviving listener receives the type and severity, so an alert can say what was lost", async () => {
    const { onSecurityRecordFailure, recordSecurityEvent, __resetRecorderStateForTests } =
      await import("@/server/security/record");

    __resetRecorderStateForTests();

    const seen: Array<{ type: string; severity: string }> = [];
    onSecurityRecordFailure(({ type, severity }) => {
      seen.push({ type, severity });
    });

    /** Same rewritten induction as above: a REVOKE, not a routing accident. */
    await withRevokedInsert(() =>
      recordSecurityEvent(
        {
          type: "tenant.cross_access_attempt",
          severity: "critical",
          source: "tests/security/security-record-hook-chain",
          tenantId: "11111111-1111-4111-8111-111111111111",
          reason: "Track D wave 17: the payload the alert is built from.",
        },
        { noCoalesce: true },
      ),
    );

    expect(seen).toEqual([
      { type: "tenant.cross_access_attempt", severity: "critical" },
    ]);
  });

  it("⚠️ a NON-critical failure does not escalate — the hook is for the page-someone ones", async () => {
    /*
     * The control. If every failed write escalated, the assertions above
     * would pass on a hook that fires indiscriminately, and the alerting
     * channel would be unusable within a day.
     */
    const { onSecurityRecordFailure, recordSecurityEvent, __resetRecorderStateForTests } =
      await import("@/server/security/record");

    __resetRecorderStateForTests();

    const listener = vi.fn();
    onSecurityRecordFailure(listener);

    await recordSecurityEvent(
      {
        type: "portal.token_invalid",
        severity: "info",
        source: "tests/security/security-record-hook-chain",
        tenantId: "11111111-1111-4111-8111-111111111111",
        reason: "Track D wave 17: a non-critical failure.",
      },
      { noCoalesce: true },
    );

    expect(listener).not.toHaveBeenCalled();
  });
});

/* ================================================================== */
/* ② EXACTLY ONE REGISTRATION SITE IN THE TREE                         */
/* ================================================================== */

describe("🔴 THE RATCHET: exactly one thing may register the failure hook", () => {
  /**
   * Every file that CALLS `onSecurityRecordFailure(` in a value position.
   *
   * ⚠️ COMMENTS ARE STRIPPED FIRST, and it matters here more than usual:
   * `server/observability/runtime.ts` and `server/export/log.ts` both
   * DISCUSS the hook at length without calling it, and a naive grep counts
   * them as registrations — which would make this ratchet fire on the two
   * files that were most careful about it.
   */
  function registrationSites(): string[] {
    const files = execSync(
      `grep -rl "onSecurityRecordFailure" --include=*.ts --include=*.tsx ` +
        `app lib server instrumentation.ts 2>/dev/null || true`,
      { cwd: ROOT, encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean)
      /* The definition itself is not a registration. */
      .filter((f) => f !== "server/security/record.ts");

    return files.filter((f) => /onSecurityRecordFailure\s*\(/.test(codeOnly(read(f))));
  }

  it("names exactly one, and it is the security alerting installer", () => {
    /*
     * 🔴 WHEN THIS GOES RED, DO NOT ADD THE NEW FILE TO A LIST. Read
     * `server/security/record.ts:236`: `failureListener = listener`. Two
     * registrations means one of them is doing nothing, and the one doing
     * nothing is whichever registered first — which is
     * `installSecurityAlerting()`, the only thing that reports a CRITICAL
     * security event that failed to persist.
     *
     * The fix is to make the hook chain (PATCH-REQUEST-D.md item 1), or to
     * call the new behaviour from INSIDE the existing listener, which is
     * what PATCH-REQUEST-B.md item ⑨ correctly does.
     */
    expect(registrationSites()).toEqual(["server/security/alerting.ts"]);
  });

  it("⭐ Track B's observability runtime discusses the hook and deliberately does not call it", () => {
    /*
     * Asserted, because it is the thing that would be easiest to undo by
     * accident in a later wave — the file is called `runtime.ts`, it
     * installs process-level handlers, and wiring one more looks harmless.
     */
    const runtime = read("server/observability/runtime.ts");
    expect(runtime).toMatch(/onSecurityRecordFailure/); // it is discussed
    expect(codeOnly(runtime)).not.toMatch(/onSecurityRecordFailure\s*\(/); // and not called
    expect(runtime).toMatch(/single listener|REPLACES the\s*\n?\s*\*?\s*first/i);
  });

  it("⚠️ the setter still has no way to chain — the property is social, not structural", () => {
    /*
     * The line this whole file exists because of. If it ever becomes an
     * array, this assertion fails, and that failure is good news.
     */
    const record = codeOnly(read("server/security/record.ts"));
    expect(record).toMatch(/failureListener\s*=\s*listener/);
    expect(record).not.toMatch(/failureListeners\s*\.\s*push/);
  });
});

/* ================================================================== */
/* ③ isLocked() STILL HAS NO CALLER                                    */
/* ================================================================== */

describe("🔴 the lockout table is EVIDENCE-ONLY, and this says so as a check", () => {
  /**
   * Integration asked for a plain statement. Here it is, and it is a test
   * rather than a sentence so that it stops being true loudly:
   *
   * **The `login_lockouts` table is written and never read. Nothing in the
   * product consults it before serving a request. Clerk's own lockout is
   * the entire brute-force control; ours is an audit-grade copy with no
   * enforcement attached to it.**
   *
   * Wave 15 gave `releaseLock()` its first caller (the access console, in
   * `PATCH-REQUEST-D.md`). `isLocked()` still has none.
   */
  function callersOf(symbol: string): string[] {
    const files = execSync(
      `grep -rl "${symbol}" --include=*.ts --include=*.tsx app lib server 2>/dev/null || true`,
      { cwd: ROOT, encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean)
      .filter((f) => f !== "lib/security/lockout.ts");

    return files.filter((f) => new RegExp(`\\b${symbol}\\s*\\(`).test(codeOnly(read(f))));
  }

  it("🔴 nothing in app/, lib/ or server/ calls isLocked()", () => {
    /*
     * ⚠️ WHEN THIS GOES RED, IT IS GOOD NEWS AND THE FILE THAT BROKE IT
     * SHOULD SAY SO. The surfaces that ought to consult it are
     * `server/mcp/dispatch.ts` (bearer tokens), `app/portal/[token]/`
     * (portal URLs) and the worker retry path — none of them Track D's.
     *
     * ⚠️ AND WHOEVER WIRES IT MUST READ `LockoutStatus.degraded` FIRST. A
     * caller that treats `locked: false, degraded: true` as "clean" has
     * built a brute-force control that switches itself off whenever the
     * database is slow, which is precisely when it is being attacked.
     */
    expect(callersOf("isLocked")).toEqual([]);
  });

  it("⭐ recordFailure DOES have one — so the table is written, just never read", () => {
    expect(callersOf("recordFailure")).toContain("app/api/webhooks/clerk/_webhook.ts");
  });

  it("the module still says degraded is distinguishable from clean", async () => {
    /*
     * The half of wave 15 that survives whether or not anybody wires the
     * read: "we could not look" and "this address is clean" are no longer
     * the same value. Asserted on the type's actual behaviour, not on prose.
     */
    const { isLocked } = await import("@/lib/security/lockout");
    const status = await isLocked(`never-seen-${Date.now()}@example.invalid`);
    expect(status).toHaveProperty("degraded");
    expect(status.degraded).toBe(false);
    expect(status.locked).toBe(false);
  });
});
