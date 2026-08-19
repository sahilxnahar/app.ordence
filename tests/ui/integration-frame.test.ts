/**
 * ⭐⭐⭐ FRONT OFFICE, BATCH 6 — THE INTEGRATION FRAME.
 *
 * 🔴 THE FOUR FAILURES THIS SUITE PINS DOWN.
 *
 *   ① A second vault. `vault_secrets` has existed since 0037 and
 *      nothing had ever written to it, so the obvious move was a
 *      `connection_secrets` table beside it — two erasure paths and an
 *      access log that misses the credentials most worth logging.
 *
 *   ② A run that succeeds and achieves nothing. Forty seen and forty
 *      new, every single time, is a cursor that is not moving. Every
 *      individual run is green and the same enquiries arrive over and
 *      over.
 *
 *   ③ One `catch` that retries everything. Applied to a rejected key
 *      that is a few thousand failed authentications a day against
 *      somebody's account, and the far end blocks the account.
 *
 *   ④ A signature check that treats "unsigned by design" and "signature
 *      passed" as the same tick. Signing then switches off and nothing
 *      anywhere reports it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CONNECTOR_POLICIES,
  assessSyncHealth,
  effectiveIntervalSeconds,
  isKnownConnector,
  mayFetchNow,
  nextFetchWindow,
  policyFor,
  type ConnectionSnapshot,
  type RunSnapshot,
} from "@/lib/integrations/policy";
import {
  DEFAULT_BACKOFF,
  assessFailure,
  assessSuccess,
  backoffSeconds,
  describeSeconds,
} from "@/lib/integrations/backoff";
import {
  DEFAULT_DELIVERY_RETENTION_DAYS,
  FAILED_DELIVERY_RETENTION_DAYS,
  assessDelivery,
  computeSignature,
  constantTimeEquals,
  normaliseSignatureHeader,
  purgeAfterFor,
  timestampWithinTolerance,
  type EndpointSnapshot,
} from "@/lib/integrations/verify";
import { MASK_VISIBLE_SUFFIX, maskForDisplay } from "@/db/schema/vault";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const sqlCode = (s: string) => s.replace(/--[^\n]*/g, "");
/**
 * ⚠️ COMMENTS STRIPPED BEFORE ASSERTING ON CODE. This file argues at
 * length in prose about not loading a ciphertext, and an assertion that
 * the word is absent would fail on the argument for its own rule.
 */
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const flat = (s: string) => s.replace(/\s+/g, " ");

const SQL = read("SQL-FILES/0064_integration_frame.sql");
const SQL_CODE = sqlCode(SQL);
const CRYPTO = read("server/vault/crypto.ts");
const VAULT_SECRETS = read("server/vault/secrets.ts");
const ACTIONS = read("server/actions/connections.ts");
const PAGE = read("app/(crm)/settings/connections/page.tsx");
const SCHEMA = read("db/schema/integrations.ts");
const ENV = read("lib/env.ts");

const NOW = new Date("2026-08-13T10:00:00.000Z");

function connection(over: Partial<ConnectionSnapshot> = {}): ConnectionSnapshot {
  return {
    connectorKey: "indiamart",
    state: "connected",
    isActive: true,
    pollEverySeconds: 360,
    lastAttemptAt: null,
    lastSuccessAt: null,
    cursorAt: null,
    lockedUntil: null,
    ...over,
  };
}

/* ================================================================== */
/* ⭐⭐⭐ ① THE VAULT THAT ALREADY EXISTED                             */
/* ================================================================== */

describe("⭐⭐ no second vault", () => {
  /**
   * 🔴 THE HEADLINE OF THE SESSION. `vault_secrets` was complete in
   * 0037 and dormant ever since. A private secrets table beside it
   * would have been the same mistake as a second price list or a second
   * lead table, except the thing duplicated is where credentials live.
   */
  it("creates no secrets table of its own", () => {
    expect(SQL_CODE).not.toMatch(/CREATE TABLE[^;]*connection_secrets/i);
    expect(SCHEMA).not.toContain("connectionSecrets");
  });

  it("routes integration credentials at the vault by owner", () => {
    expect(VAULT_SECRETS).toContain('CONNECTION_OWNER_KIND = "connection"');
    expect(flat(ACTIONS)).toContain('kind: "api_credential"');
  });

  it("adds the two access purposes the vault was missing", () => {
    expect(SQL).toContain(
      "ALTER TYPE vault_access_purpose ADD VALUE IF NOT EXISTS 'integration_setup'",
    );
    expect(SQL).toContain(
      "ALTER TYPE vault_access_purpose ADD VALUE IF NOT EXISTS 'integration_sync'",
    );
  });

  /**
   * ⚠️ A new enum value cannot be USED in the transaction that adds it,
   * so the two ALTERs have to run before BEGIN. Getting this wrong is a
   * migration that fails only on a fresh database.
   */
  it("adds the enum values outside the transaction", () => {
    const alterAt = SQL.indexOf("ALTER TYPE vault_access_purpose");
    const beginAt = SQL.indexOf("\nBEGIN;");
    expect(alterAt).toBeGreaterThan(0);
    expect(alterAt).toBeLessThan(beginAt);
  });

  /**
   * 🔴 THE VIEW MUST NOT CARRY THE VALUE OR ANY DERIVATIVE OF IT. The
   * blind index is a searchable derivative, which is exactly what 0037
   * kept out of `v_vault_retention_due`.
   */
  it("exposes neither ciphertext nor blind index on the credentials view", () => {
    const view = SQL_CODE.slice(
      SQL_CODE.indexOf("CREATE OR REPLACE VIEW v_connection_credentials"),
      SQL_CODE.indexOf("DO $$", SQL_CODE.indexOf("v_connection_credentials")),
    );
    expect(view).toContain("masked_display");
    expect(view).not.toContain("ciphertext");
    expect(view).not.toContain("blind_index");
  });

  /**
   * ⚠️ AN API KEY IS NOT AN IDENTIFIER. Nobody recognises one by its
   * tail, so the four characters 0037 allowed bought no recognition and
   * cost a meaningful fraction of a short token.
   */
  it("shows no part of a stored API credential", () => {
    expect(MASK_VISIBLE_SUFFIX.api_credential).toBe(0);
    const masked = maskForDisplay("sk_live_abcdefghijkl", "api_credential");
    expect(masked).toMatch(/^•+$/);
    expect(masked).not.toContain("ijkl");
  });

  /** ⚠️ Still four for a bank account, because there it IS recognition. */
  it("keeps the last four for things people recognise that way", () => {
    expect(MASK_VISIBLE_SUFFIX.bank_account).toBe(4);
    expect(maskForDisplay("123456789012", "bank_account")).toMatch(/9012$/);
  });

  it("erases rather than deletes, because the vault revokes DELETE", () => {
    expect(VAULT_SECRETS).toContain("ordence_vault_erase");
    expect(VAULT_SECRETS).not.toMatch(/\.delete\(vaultSecrets\)/);
  });
});

describe("⭐ the credential never comes back out", () => {
  /**
   * 🔴 EVERY EXPORT IN A "use server" FILE IS A BROWSER-REACHABLE RPC
   * ENDPOINT. An action returning a stored key is an authenticated URL
   * that hands out every tenant's credentials.
   */
  it("has no action that selects a ciphertext", () => {
    const c = code(ACTIONS);
    expect(c).not.toContain("ciphertext");
    expect(c).not.toContain("openSecret");
    expect(c).not.toContain("readForPerson");
  });

  it("shows names of stored secrets and nothing else", () => {
    expect(flat(ACTIONS)).toContain("SELECT label");
    expect(flat(PAGE)).toContain("Ordence does not show");
  });

  /** ⚠️ Even the audit trail carries the NAME, never the value. */
  it("audits the secret name and not the secret", () => {
    expect(flat(ACTIONS)).toContain(
      "newValue: { secretName: data.secretName, rotated: put.rotated }",
    );
  });

  it("refuses to save before the vault is configured, not after", () => {
    const save = ACTIONS.slice(ACTIONS.indexOf("export async function saveCredential"));
    const readinessAt = save.indexOf("vaultReadiness()");
    const valueAt = save.indexOf("data.value.trim()");
    expect(readinessAt).toBeGreaterThan(0);
    expect(readinessAt).toBeLessThan(valueAt);
  });
});

describe("⭐ the key is not in the database", () => {
  it("declares both vault variables and neither is required", () => {
    expect(ENV).toContain("VAULT_ENCRYPTION_KEY: z.string().optional()");
    expect(ENV).toContain("VAULT_BLIND_INDEX_PEPPER: z.string().optional()");
  });

  /**
   * ⚠️ A module-level read runs during `next build`, when secrets are
   * legitimately absent, and fails the build.
   */
  it("reads the key at call time, never at module load", () => {
    expect(CRYPTO).toContain("function readKey()");
    expect(CRYPTO).not.toMatch(/^const KEY = process\.env/m);
  });

  /** 🔴 The one failure that breaks GCM completely. */
  it("draws a fresh IV for every seal", () => {
    const seal = CRYPTO.slice(CRYPTO.indexOf("export function sealSecret"));
    expect(seal).toContain("randomBytes(IV_BYTES)");
  });

  /**
   * ⚠️ 0037 has no auth tag column, because it was written for
   * WebCrypto, which appends the tag. Node hands it back separately.
   */
  it("appends the GCM tag so the format matches WebCrypto", () => {
    expect(flat(CRYPTO)).toContain("Buffer.concat([body, cipher.getAuthTag()])");
    expect(CRYPTO).toContain("all.length - TAG_BYTES");
  });

  /** ⚠️ The length may be reported. The value may not. */
  it("never puts the key itself in an error", () => {
    const errors = CRYPTO.match(/throw new Vault[A-Za-z]+Error\([\s\S]*?\);/g) ?? [];
    expect(errors.length).toBeGreaterThan(2);
    for (const e of errors) {
      expect(e).not.toContain("${hex}");
      expect(e).not.toContain("${raw}");
      expect(e).not.toContain("plaintext");
    }
  });
});

describe("⭐ a read is a write, except where a run already records it", () => {
  it("refuses a runner read with no run to account for it", () => {
    expect(VAULT_SECRETS).toContain("readonly syncRunId: string");
    expect(flat(VAULT_SECRETS)).toContain("if (!args.syncRunId)");
  });

  /**
   * 🔴 THE LOG ROW GOES IN BEFORE THE DECRYPTION IS ATTEMPTED. "It
   * failed, so we did not log the attempt" hides exactly the attempts
   * worth seeing.
   */
  it("logs a person's read before decrypting, not after", () => {
    const fn = VAULT_SECRETS.slice(
      VAULT_SECRETS.indexOf("export async function readForPerson"),
    );
    expect(fn.indexOf("vaultAccessLog")).toBeLessThan(fn.indexOf("openSecret(row)"));
  });

  /** ⚠️ A write is not a decryption, and inflating that count ruins it. */
  it("records a save as wasDecrypted false", () => {
    const put = VAULT_SECRETS.slice(
      VAULT_SECRETS.indexOf("export async function putSecret"),
      VAULT_SECRETS.indexOf("async function loadRow"),
    );
    expect(put).toContain("wasDecrypted: false");
  });
});

/* ================================================================== */
/* ⭐⭐ ② THE THROTTLE, AND THE RUN THAT ACHIEVES NOTHING              */
/* ================================================================== */

describe("⭐ the far end's limits are data", () => {
  it("carries IndiaMART's documented numbers", () => {
    const p = CONNECTOR_POLICIES.indiamart;
    expect(p.minIntervalSeconds).toBe(300);
    expect(p.lockoutSeconds).toBe(900);
    expect(p.burstPerMinute).toBe(5);
    expect(p.maxWindowDays).toBe(7);
    expect(p.maxHistoryDays).toBe(365);
  });

  /**
   * ⚠️ SITTING EXACTLY ON A LIMIT MEANS ONE SLOW CLOCK IS A LOCKOUT.
   */
  it("ships a default above the floor, not on it", () => {
    expect(CONNECTOR_POLICIES.indiamart.defaultPollSeconds).toBeGreaterThan(
      CONNECTOR_POLICIES.indiamart.minIntervalSeconds,
    );
  });

  /**
   * 🔴 JUSTDIAL IS NOT SELF-SERVICE. Their webhook is configured by an
   * account manager at their end, and a screen offering a button for it
   * generates support tickets.
   */
  it("says so where the customer cannot do it themselves", () => {
    expect(CONNECTOR_POLICIES.justdial.selfService).toBe(false);
    expect(CONNECTOR_POLICIES.justdial.transport).toBe("push");
    expect(CONNECTOR_POLICIES.justdial.minIntervalSeconds).toBe(0);
  });

  it("knows its own connectors and refuses others", () => {
    expect(isKnownConnector("indiamart")).toBe(true);
    expect(isKnownConnector("linkedin")).toBe(false);
    expect(policyFor("linkedin")).toBeNull();
  });
});

describe("⭐ may we fetch", () => {
  it("lets a due connection through", () => {
    const v = mayFetchNow(connection(), NOW);
    expect(v.mayFetch).toBe(true);
  });

  /**
   * 🔴 A REJECTED CREDENTIAL IS DECIDED BEFORE A RATE LIMIT. Waiting
   * fifteen minutes to rediscover something no amount of waiting fixes
   * helps nobody, and each retry is another failed authentication
   * against the customer's account.
   */
  it("stops on a rejected credential even while locked out", () => {
    const v = mayFetchNow(
      connection({
        state: "revoked",
        lockedUntil: new Date(NOW.getTime() + 900_000),
      }),
      NOW,
    );
    expect(v.mayFetch).toBe(false);
    expect(v.retryAt).toBeNull();
    expect(v.reason).toContain("blocked");
  });

  it("skips a locked connection and says when it lifts", () => {
    const until = new Date(NOW.getTime() + 600_000);
    const v = mayFetchNow(connection({ lockedUntil: until }), NOW);
    expect(v.mayFetch).toBe(false);
    expect(v.outcome).toBe("skipped_locked");
    expect(v.retryAt).toEqual(until);
  });

  /** ⭐ A skipped run is still a run and is still written down. */
  it("records too-soon as an outcome rather than silence", () => {
    const v = mayFetchNow(
      connection({ lastAttemptAt: new Date(NOW.getTime() - 60_000) }),
      NOW,
    );
    expect(v.mayFetch).toBe(false);
    expect(v.outcome).toBe("skipped_too_soon");
  });

  /**
   * 🔴 THE FLOOR WINS OVER THE TENANT'S SETTING. Somebody typing 60 into
   * a field for a connector with a five minute floor must not be able to
   * lock their own account out.
   */
  it("floors a too-fast interval at the far end's limit", () => {
    const c = connection({
      pollEverySeconds: 60,
      lastAttemptAt: new Date(NOW.getTime() - 120_000),
    });
    expect(effectiveIntervalSeconds(c)).toBe(300);
    expect(mayFetchNow(c, NOW).mayFetch).toBe(false);
  });

  it("does not treat a push-only connector as broken", () => {
    const v = mayFetchNow(connection({ connectorKey: "justdial" }), NOW);
    expect(v.mayFetch).toBe(false);
    // ⚠️ No outcome at all. Nothing failed; there is nothing to fetch.
    expect(v.outcome).toBeNull();
  });

  it("does not fetch a paused connection and calls it no error", () => {
    const v = mayFetchNow(connection({ state: "paused" }), NOW);
    expect(v.mayFetch).toBe(false);
    expect(v.outcome).toBeNull();
  });
});

describe("⭐⭐ the window, and the days that are gone", () => {
  it("asks from the cursor to now on a normal catch-up", () => {
    const cursor = new Date(NOW.getTime() - 2 * 86_400_000);
    const w = nextFetchWindow(connection({ cursorAt: cursor }), NOW);
    expect(w.from).toEqual(cursor);
    expect(w.to).toEqual(NOW);
    expect(w.clamped).toBe(false);
    expect(w.unrecoverableDays).toBe(0);
  });

  /**
   * ⭐ A NEW CONNECTION DOES NOT DRAG IN A YEAR OF DEAD ENQUIRIES. A
   * customer connecting IndiaMART on day one does not want 365 days of
   * stale leads landing in their pipeline.
   */
  it("reaches back only a week on a first run", () => {
    const w = nextFetchWindow(connection(), NOW);
    expect(Math.round((NOW.getTime() - w.from.getTime()) / 86_400_000)).toBe(7);
  });

  /** ⚠️ Clamped, and it says more follows. This part IS recoverable. */
  it("splits a long catch-up into windows the far end will answer", () => {
    const cursor = new Date(NOW.getTime() - 30 * 86_400_000);
    const w = nextFetchWindow(connection({ cursorAt: cursor }), NOW);
    expect(w.moreToFollow).toBe(true);
    expect(Math.round((w.to.getTime() - w.from.getTime()) / 86_400_000)).toBe(7);
    expect(w.unrecoverableDays).toBe(0);
  });

  /**
   * 🔴🔴 THE ONE THAT MATTERS. Four hundred days down against 365 days
   * of retained history is thirty-five days that no retry recovers. A
   * silent clamp produces a successful-looking catch-up over a permanent
   * hole.
   */
  it("reports the days that are gone instead of narrowing quietly", () => {
    const cursor = new Date(NOW.getTime() - 400 * 86_400_000);
    const w = nextFetchWindow(connection({ cursorAt: cursor }), NOW);
    expect(w.unrecoverableDays).toBe(35);
    expect(w.clamped).toBe(true);
    expect(w.note).toContain("cannot be fetched by anyone");
    // ⭐ And it names the only thing that actually recovers them.
    expect(w.note).toContain("portal");
  });
});

describe("⭐⭐ the run that succeeds and achieves nothing", () => {
  const run = (over: Partial<RunSnapshot> = {}): RunSnapshot => ({
    outcome: "success",
    startedAt: NOW,
    itemsSeen: 10,
    itemsNew: 1,
    itemsDuplicate: 9,
    itemsFailed: 0,
    ...over,
  });

  /**
   * 🔴 EVERYTHING NEW, EVERY TIME, WITH NO REPEATS AT ALL, IS A CURSOR
   * THAT IS NOT MOVING. Every individual run is green and the same
   * enquiries are created over and over.
   */
  it("catches a cursor that is not advancing", () => {
    const stuck = [
      run({ itemsSeen: 40, itemsNew: 40, itemsDuplicate: 0 }),
      run({ itemsSeen: 40, itemsNew: 40, itemsDuplicate: 0 }),
      run({ itemsSeen: 40, itemsNew: 40, itemsDuplicate: 0 }),
    ];
    const h = assessSyncHealth(stuck, NOW);
    expect(h.tone).toBe("danger");
    expect(h.headline).toContain("again");
  });

  /** ⭐ Forty seen and forty repeats is a healthy quiet day, not a fault. */
  it("calls all-duplicates healthy", () => {
    const quiet = [
      run({ itemsSeen: 40, itemsNew: 0, itemsDuplicate: 40 }),
      run({ itemsSeen: 40, itemsNew: 0, itemsDuplicate: 40 }),
      run({ itemsSeen: 40, itemsNew: 0, itemsDuplicate: 40 }),
    ];
    expect(assessSyncHealth(quiet, NOW).tone).toBe("ok");
  });

  /**
   * ⚠️ AND THE REVERSE IS ALSO ALL GREEN. Run after run seeing nothing
   * at all, for a connector that should be busy, is a filter or a
   * permission that quietly stopped matching.
   */
  it("flags a connection that succeeds and sees nothing", () => {
    const empty = [run({ itemsSeen: 0, itemsNew: 0, itemsDuplicate: 0 })];
    const h = assessSyncHealth(empty, NOW);
    expect(h.tone).toBe("watch");
    expect(h.headline).toContain("nothing has arrived");
  });

  it("treats never-once-worked as not connected", () => {
    const h = assessSyncHealth(
      [run({ outcome: "failed", itemsSeen: 0, itemsNew: 0, itemsDuplicate: 0 })],
      NOW,
    );
    expect(h.tone).toBe("danger");
  });

  it("says so when it has never run", () => {
    expect(assessSyncHealth([], NOW).headline).toBe("Never run");
  });
});

/* ================================================================== */
/* ⭐⭐ ③ NOT EVERY FAILURE IS A RETRY                                 */
/* ================================================================== */

describe("⭐⭐ backoff", () => {
  it("doubles", () => {
    expect(backoffSeconds(1, DEFAULT_BACKOFF, 0)).toBe(60);
    expect(backoffSeconds(2, DEFAULT_BACKOFF, 0)).toBe(120);
    expect(backoffSeconds(4, DEFAULT_BACKOFF, 0)).toBe(480);
  });

  /**
   * 🔴 THE CAP IS THE WHOLE POINT. Doubling without a ceiling reaches a
   * nine hour gap by the fourteenth failure: the far end came back after
   * twenty minutes and the customer loses the working day.
   */
  it("stops doubling at the cap however many times it has failed", () => {
    expect(backoffSeconds(14, DEFAULT_BACKOFF, 0)).toBe(3600);
    expect(backoffSeconds(500, DEFAULT_BACKOFF, 0)).toBe(3600);
  });

  /** ⚠️ Jitter is passed in, never generated, or this is untestable. */
  it("takes jitter as an argument and clamps a silly one", () => {
    expect(backoffSeconds(2, DEFAULT_BACKOFF, 0.5)).toBe(132);
    expect(backoffSeconds(2, DEFAULT_BACKOFF, 99)).toBe(144);
    expect(backoffSeconds(2, DEFAULT_BACKOFF, -5)).toBe(120);
  });
});

describe("⭐⭐ what a failure means", () => {
  /**
   * 🔴 A REJECTED KEY IS NEVER RETRIED. Retrying is a few thousand
   * failed authentications a day against somebody's account, and the far
   * end eventually blocks the account rather than the request.
   */
  it("stops dead on a rejected credential", () => {
    const v = assessFailure(
      { failureClass: "auth", consecutiveFailures: 1, message: "401" },
      NOW,
    );
    expect(v.state).toBe("revoked");
    expect(v.willRetry).toBe(false);
    expect(v.lockedUntil).toBeNull();
    expect(v.shouldNotify).toBe(true);
    expect(v.actionRequired).toContain("new key");
  });

  /** ⚠️ Our fault. Sending it again sends it wrong again. */
  it("does not retry a request the far end refused as malformed", () => {
    const v = assessFailure(
      { failureClass: "bad_request", consecutiveFailures: 1, message: "422" },
      NOW,
    );
    expect(v.willRetry).toBe(false);
    expect(v.state).toBe("degraded");
    expect(v.shouldNotify).toBe(true);
  });

  /**
   * ⭐ RETRY-AFTER IS NOT ADVISORY. Ignoring it in favour of our own
   * curve turns a fifteen minute lockout into an hour of extra blocks.
   */
  it("honours a Retry-After longer than our own backoff", () => {
    const told = new Date(NOW.getTime() + 3 * 3600_000);
    const v = assessFailure(
      {
        failureClass: "rate_limited",
        consecutiveFailures: 1,
        message: "429",
        retryAfter: told,
        lockoutSeconds: 900,
      },
      NOW,
    );
    expect(v.state).toBe("locked");
    expect(v.lockedUntil).toEqual(told);
  });

  /** ⚠️ And never shorter than the connector's documented lockout. */
  it("never waits less than the documented lockout", () => {
    const v = assessFailure(
      {
        failureClass: "rate_limited",
        consecutiveFailures: 1,
        message: "429",
        retryAfter: new Date(NOW.getTime() + 5_000),
        lockoutSeconds: 900,
      },
      NOW,
    );
    expect(v.lockedUntil!.getTime()).toBe(NOW.getTime() + 900_000);
  });

  /**
   * 🔴🔴 THE CUSTOMER IS TOLD ON TIME, NOT ON COUNT. "Alert after 5
   * failures" means half an hour for a six minute poll and five days for
   * a daily one.
   */
  it("stays quiet through a brief outage", () => {
    const v = assessFailure(
      {
        failureClass: "far_end",
        consecutiveFailures: 8,
        message: "503",
        lastSuccessAt: new Date(NOW.getTime() - 20 * 60_000),
      },
      NOW,
    );
    expect(v.willRetry).toBe(true);
    expect(v.shouldNotify).toBe(false);
  });

  it("speaks up on the first failure of a long silence", () => {
    const v = assessFailure(
      {
        failureClass: "far_end",
        consecutiveFailures: 1,
        message: "503",
        lastSuccessAt: new Date(NOW.getTime() - 5 * 3600_000),
      },
      NOW,
    );
    expect(v.shouldNotify).toBe(true);
    expect(v.notifyHeadline).toContain("hours");
  });

  /** ⚠️ Never having worked at all is the longest silence there is. */
  it("treats never-worked as overdue for a word", () => {
    const v = assessFailure(
      { failureClass: "network", consecutiveFailures: 1, message: "timeout" },
      NOW,
    );
    expect(v.shouldNotify).toBe(true);
  });

  /**
   * ⭐ IF WE TOLD THEM IT BROKE, WE TELL THEM IT IS FIXED. A product
   * that only ever sends bad news gets ignored.
   */
  it("announces a recovery only where a failure was announced", () => {
    expect(
      assessSuccess({ state: "degraded", consecutiveFailures: 4, notified: true })
        .shouldNotify,
    ).toBe(true);
    expect(
      assessSuccess({ state: "degraded", consecutiveFailures: 1, notified: false })
        .shouldNotify,
    ).toBe(false);
  });

  it("clears the lock on recovery", () => {
    const v = assessSuccess({
      state: "locked",
      consecutiveFailures: 9,
      notified: false,
    });
    expect(v.lockedUntil).toBeNull();
    expect(v.consecutiveFailures).toBe(0);
    expect(v.stateReason).toBeNull();
  });

  it("puts durations in words", () => {
    expect(describeSeconds(45)).toBe("45 seconds");
    expect(describeSeconds(60)).toBe("1 minute");
    expect(describeSeconds(3600)).toBe("1 hour");
  });

  /**
   * 🔴 0064 REFUSES AN UNHEALTHY STATE WITH NO REASON. Every verdict has
   * to carry one or the write fails.
   */
  it("always supplies the reason the database demands", () => {
    for (const cls of ["auth", "rate_limited", "far_end", "network", "bad_request"] as const) {
      const v = assessFailure(
        { failureClass: cls, consecutiveFailures: 2, message: "x" },
        NOW,
      );
      if (v.state !== "connected" && v.state !== "paused") {
        expect(v.stateReason.length).toBeGreaterThan(0);
      }
    }
  });
});

/* ================================================================== */
/* ⭐⭐ ④ DID THIS REALLY COME FROM WHO IT SAYS?                       */
/* ================================================================== */

const SECRET = "a-signing-secret-of-reasonable-length";

function endpoint(over: Partial<EndpointSnapshot> = {}): EndpointSnapshot {
  return {
    verification: "hmac_sha256",
    signatureHeader: "x-hub-signature-256",
    timestampToleranceSeconds: 300,
    isActive: true,
    ...over,
  };
}

describe("⭐⭐ signatures", () => {
  /** 🔴 `a === b` on a signature leaks it one character at a time. */
  it("compares in constant time and survives a length mismatch", () => {
    expect(constantTimeEquals("abcdef", "abcdef")).toBe(true);
    expect(constantTimeEquals("abcdef", "abcdeg")).toBe(false);
    expect(constantTimeEquals("abcdef", "abc")).toBe(false);
    expect(constantTimeEquals("", "")).toBe(true);
  });

  it("unwraps the prefixes senders put on the header", () => {
    expect(normaliseSignatureHeader("sha256=AABBCC")).toBe("aabbcc");
    expect(normaliseSignatureHeader("  AABB  ")).toBe("aabb");
  });

  /**
   * 🔴 THE SIGNATURE IS OVER THE RAW BODY. Parsing and re-serialising
   * reorders keys and changes number formatting, and the failure is
   * invisible because the parsed object looks identical.
   */
  it("signs the exact bytes, so a reordered body does not match", () => {
    const a = computeSignature("hmac_sha256", SECRET, '{"a":1,"b":2}');
    const b = computeSignature("hmac_sha256", SECRET, '{"b":2,"a":1}');
    expect(a).not.toBe(b);
  });

  it("accepts a correct signature", () => {
    const body = '{"lead":"x"}';
    const sig = computeSignature("hmac_sha256", SECRET, body)!;
    const v = assessDelivery(
      endpoint(),
      { rawBody: body, presentedSignature: `sha256=${sig}`, secret: SECRET },
      NOW,
    );
    expect(v.signatureState).toBe("verified");
    expect(v.mayProcess).toBe(true);
  });

  /**
   * 🔴 A WRONG SIGNATURE IS KEPT AND NEVER ACTED ON. An endpoint
   * suddenly receiving invalid signatures is either a rotated secret or
   * somebody probing, and both are worth seeing.
   */
  it("keeps a forged delivery and refuses to process it", () => {
    const v = assessDelivery(
      endpoint(),
      { rawBody: "{}", presentedSignature: "sha256=deadbeef", secret: SECRET },
      NOW,
    );
    expect(v.signatureState).toBe("invalid");
    expect(v.mayProcess).toBe(false);
    expect(v.outcome).toBe("rejected");
    expect(v.errorMessage).toBeTruthy();
  });

  /**
   * 🔴🔴 "UNSIGNED BY DESIGN" IS NOT "VERIFIED". Collapse them and an
   * endpoint whose signing was accidentally switched off reads exactly
   * like one whose signature is passing.
   */
  it("distinguishes unsigned-by-design from a passing signature", () => {
    const unsigned = assessDelivery(
      endpoint({ verification: "none", signatureHeader: null }),
      { rawBody: "{}", presentedSignature: null },
      NOW,
    );
    expect(unsigned.signatureState).toBe("not_required");
    expect(unsigned.mayProcess).toBe(true);

    const missing = assessDelivery(
      endpoint(),
      { rawBody: "{}", presentedSignature: null, secret: SECRET },
      NOW,
    );
    expect(missing.signatureState).toBe("absent");
    expect(missing.mayProcess).toBe(false);
  });

  /**
   * ⚠️ A SECRET WE COULD NOT READ IS NOT A PASS. Saying "verified" when
   * nothing was checked is a lie recorded in evidence.
   */
  it("does not call an unchecked delivery verified", () => {
    const v = assessDelivery(
      endpoint(),
      { rawBody: "{}", presentedSignature: "sha256=aa", secret: null },
      NOW,
    );
    expect(v.signatureState).toBe("invalid");
    expect(v.errorMessage).toContain("could not be checked");
  });

  it("refuses everything at a switched-off endpoint but still keeps it", () => {
    const v = assessDelivery(
      endpoint({ isActive: false }),
      { rawBody: "{}", presentedSignature: null },
      NOW,
    );
    expect(v.mayProcess).toBe(false);
    expect(v.outcome).toBe("rejected");
  });
});

describe("⭐⭐ replays", () => {
  /**
   * 🔴 A REPLAYED REQUEST IS CORRECTLY SIGNED. That is what makes it a
   * replay rather than a forgery, so the timestamp is checked even when
   * the signature is perfect.
   */
  it("rejects a correctly signed delivery that is too old", () => {
    const sentAt = new Date(NOW.getTime() - 3600_000);
    const body = "{}";
    const sig = computeSignature(
      "hmac_sha256",
      SECRET,
      body,
      String(Math.floor(sentAt.getTime() / 1000)),
    )!;
    const v = assessDelivery(
      endpoint(),
      { rawBody: body, presentedSignature: sig, sentAt, secret: SECRET },
      NOW,
    );
    expect(v.signatureState).toBe("verified");
    expect(v.isReplay).toBe(true);
    expect(v.mayProcess).toBe(false);
    expect(v.outcome).toBe("ignored_replay");
  });

  /**
   * ⚠️ A TIMESTAMP IN THE FUTURE IS ALSO WRONG. Checking only "not too
   * old" is the standard mistake, and it lets a signature dated a year
   * ahead pass forever.
   */
  it("rejects a timestamp far in the future", () => {
    const v = timestampWithinTolerance(
      new Date(NOW.getTime() + 86_400_000),
      NOW,
      300,
    );
    expect(v.withinTolerance).toBe(false);
    expect(v.reason).toContain("future");
  });

  it("allows ordinary clock drift in both directions", () => {
    expect(
      timestampWithinTolerance(new Date(NOW.getTime() - 120_000), NOW, 300)
        .withinTolerance,
    ).toBe(true);
    expect(
      timestampWithinTolerance(new Date(NOW.getTime() + 120_000), NOW, 300)
        .withinTolerance,
    ).toBe(true);
  });

  /**
   * ⭐ A RETRY IS NOT A FAULT. It is the sender doing the right thing
   * after our timeout. It must land exactly once, and the second arrival
   * is recorded rather than dropped.
   */
  it("lands a resent delivery once and records the second", () => {
    const body = "{}";
    const sig = computeSignature("hmac_sha256", SECRET, body)!;
    const v = assessDelivery(
      endpoint(),
      {
        rawBody: body,
        presentedSignature: sig,
        secret: SECRET,
        externalId: "IM-99",
        alreadySeen: true,
      },
      NOW,
    );
    expect(v.isReplay).toBe(true);
    expect(v.outcome).toBe("ignored_replay");
    // ⚠️ Not an error. Nothing went wrong.
    expect(v.errorMessage).toBeNull();
  });

  /**
   * ⚠️ THE SIGNATURE IS SETTLED BEFORE THE REPLAY CHECK, so a forged
   * delivery reports "the signature was wrong", not "we had seen that id
   * before". Different incidents, and only one means somebody is
   * probing.
   */
  it("reports a forgery as a forgery even when the id repeats", () => {
    const v = assessDelivery(
      endpoint(),
      {
        rawBody: "{}",
        presentedSignature: "sha256=deadbeef",
        secret: SECRET,
        externalId: "IM-99",
        alreadySeen: true,
      },
      NOW,
    );
    expect(v.signatureState).toBe("invalid");
    expect(v.outcome).toBe("rejected");
  });
});

describe("⭐ retention", () => {
  /**
   * 🔴 A WEBHOOK BODY IS SOMEBODY'S NAME AND PHONE NUMBER. Kept forever
   * in a debugging table it is a DPDP problem hiding inside a developer
   * tool, which is the kind only ever found by somebody looking for it.
   */
  it("gives every delivery a deletion date at birth", () => {
    expect(purgeAfterFor(new Date("2026-01-01T00:00:00Z"), "processed")).toBe(
      "2026-04-01",
    );
    expect(DEFAULT_DELIVERY_RETENTION_DAYS).toBe(90);
  });

  /** ⚠️ The one nobody noticed broke in January is argued about in May. */
  it("keeps a failed delivery longer", () => {
    expect(FAILED_DELIVERY_RETENTION_DAYS).toBeGreaterThan(
      DEFAULT_DELIVERY_RETENTION_DAYS,
    );
    expect(purgeAfterFor(new Date("2026-01-01T00:00:00Z"), "rejected")).toBe(
      "2026-06-30",
    );
  });

  it("makes the column not null so it cannot be forgotten", () => {
    expect(flat(SQL_CODE)).toContain("purge_after date NOT NULL");
  });
});

/* ================================================================== */
/* ⭐ THE MIGRATION'S OWN RULES                                        */
/* ================================================================== */

describe("⭐ 0064 refuses what the runner must not write", () => {
  it("demands a reason for any unhealthy state", () => {
    expect(flat(SQL_CODE)).toContain(
      "CONSTRAINT connections_unhealthy_is_explained CHECK ( state IN ('connected', 'paused') OR state_reason IS NOT NULL )",
    );
  });

  it("demands an end date on a lockout", () => {
    expect(flat(SQL_CODE)).toContain(
      "CONSTRAINT connections_locked_has_an_end CHECK ( state <> 'locked' OR locked_until IS NOT NULL )",
    );
  });

  /** ⚠️ The parts cannot exceed the whole. */
  it("refuses counts that do not add up", () => {
    expect(flat(SQL_CODE)).toContain(
      "items_new + items_duplicate + items_failed <= items_seen",
    );
  });

  it("refuses a failed run that does not say why", () => {
    expect(flat(SQL_CODE)).toContain(
      "outcome NOT IN ('failed', 'partial') OR error_message IS NOT NULL",
    );
  });

  /** 🔴 The database says it too, because a rule that matters twice is written twice. */
  it("refuses to process an invalid signature or a replay", () => {
    expect(flat(SQL_CODE)).toContain(
      "signature_state <> 'invalid' OR outcome <> 'processed'",
    );
    expect(flat(SQL_CODE)).toContain("NOT is_replay OR outcome <> 'processed'");
  });

  /**
   * 🔴 AN UNGUESSABLE PATH IS THE ONLY DEFENCE AN UNSIGNED ENDPOINT
   * HAS. Thirty-two characters is not a preference.
   */
  it("refuses a short webhook path token", () => {
    expect(flat(SQL_CODE)).toContain("length(path_token) >= 32");
  });

  it("mints a token comfortably longer than the floor", () => {
    expect(CRYPTO).toContain("randomBytes(24).toString(\"hex\")");
  });

  it("refuses a signed endpoint that does not name its header", () => {
    expect(flat(SQL_CODE)).toContain(
      "verification IN ('none', 'shared_token') OR signature_header IS NOT NULL",
    );
  });

  /**
   * 🔴🔴 FOUND BY A DRILL, NOT BY THE DESIGN.
   *
   * ⚠️ The first version of the guard froze the payload HASH and left
   * the payload editable. The stored body could be rewritten to say
   * something else while the hash beside it went on attesting to the
   * original — worse than no record, because it looks verified.
   *
   * ⭐ Removal is still allowed, because a data-deletion request has to
   * be answerable.
   */
  it("lets a stored body be removed but never rewritten", () => {
    const guard = SQL_CODE.slice(
      SQL_CODE.indexOf("FUNCTION ordence_guard_delivery"),
      SQL_CODE.indexOf("trg_guard_delivery"),
    );
    expect(flat(guard)).toContain(
      "IF NEW.payload IS DISTINCT FROM OLD.payload AND NEW.payload IS NOT NULL THEN",
    );
    expect(guard).toContain("may be removed but not rewritten");
  });

  it("puts platform scope in USING and never in WITH CHECK", () => {
    const policies = SQL_CODE.match(/CREATE POLICY[\s\S]*?;/g) ?? [];
    expect(policies.length).toBe(4);
    for (const p of policies) {
      const check = p.slice(p.indexOf("WITH CHECK"));
      expect(check).not.toContain("app_platform_scope");
    }
  });
});
