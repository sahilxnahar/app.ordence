/**
 * Ordence — Security Event Vocabulary, Detectors & SIEM Export
 * Version: v0.12.0-alpha (Phase 20)
 *
 * ══════════════════════════════════════════════════════════════════════
 * PHASE 20 MANDATORY VERIFICATION
 * ══════════════════════════════════════════════════════════════════════
 * Four things are asserted here, all of which would be silent failures:
 *
 *   1. SEVERITY CANNOT BE QUIETLY DEMOTED. A call site that emits a forged
 *      webhook signature as `info` because the noise annoyed someone locally
 *      would disable an alarm permanently, and a missing alarm produces no
 *      output at all.
 *
 *   2. SECRETS NEVER REACH THE TABLE. `security_events` is append-only —
 *      nothing written there can be removed — and it is exported to a
 *      third-party SIEM by design. A credential in `detail` has no cleanup
 *      path whatsoever.
 *
 *   3. THE DETECTOR THRESHOLDS ARE EXACT. Fires at N+1, does NOT fire at N.
 *      A rule that fires at N is a rule that pages someone every Monday and
 *      is then muted, which is the same as not having it.
 *
 *   4. THE EXPORT CANNOT BE INJECTED INTO. Both NDJSON and CEF are
 *      line-delimited, so an attacker-chosen newline inside a user-agent
 *      could forge a SECOND, fully attacker-authored record — a
 *      "severity: info, all is well" line inside the log that was recording
 *      the attack.
 *
 * ⚠️ `@/db` is stubbed. `server/security/anomalies.ts` imports the database
 * client, which connects at module load. The RULES are pure functions and are
 * what these tests exercise; the stub only makes them importable. Nothing
 * carrying a rule under test is mocked.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@/db", () => ({
  db: {},
  withTenant: vi.fn(),
  withPlatformScope: vi.fn(),
  schema: {},
}));

import {
  SECURITY_EVENT_TYPES,
  DEFAULT_SEVERITY,
  resolveSeverity,
  sanitiseDetail,
  isSecurityEventType,
  describeSecurityEvent,
  atLeastSeverity,
} from "@/lib/security/events";

import {
  ANOMALY_THRESHOLDS,
  detectFailedLoginBurst,
  detectDenialSpike,
  detectPortalTokenSharing,
  detectOffHoursBulkExport,
  detectRateLimitPressure,
  evaluateAnomalyRules,
  isOffHoursIst,
  istHour,
  type Observation,
  type DenialObservation,
} from "@/server/security/anomalies";

import {
  toNdjsonLine,
  toNdjson,
  toCefLine,
  cefEscape,
  nextSiemCursor,
  serialiseForSiem,
  type ExportableSecurityEvent,
} from "@/lib/security/siem";

const NOW = 1_760_000_000_000;

function observation(over: Partial<Observation> = {}): Observation {
  return {
    eventType: "auth.login_failed",
    tenantId: "tenant-a",
    subjectId: "someone@example.com",
    ipPrefix: "203.0.113.0/24",
    occurrenceCount: 1,
    occurredAt: new Date(NOW - 60_000),
    ...over,
  };
}

function denial(over: Partial<DenialObservation> = {}): DenialObservation {
  return {
    tenantId: "tenant-a",
    userId: "user-1",
    permission: "periods:close",
    createdAt: new Date(NOW - 60_000),
    ...over,
  };
}

/* ================================================================== */
/* 1. THE VOCABULARY                                                   */
/* ================================================================== */

describe("security event vocabulary", () => {
  it("is a closed set with no duplicates", () => {
    // A free-text type column produces `rate_limit`, `rate-limit` and
    // `rateLimit` in one table, after which no SIEM rule can be trusted.
    expect(new Set(SECURITY_EVENT_TYPES).size).toBe(SECURITY_EVENT_TYPES.length);
  });

  it("gives every type a default severity and a label", () => {
    // A type with no entry would resolve to `undefined` and be written as a
    // NULL severity — invisible to every alert threshold.
    for (const type of SECURITY_EVENT_TYPES) {
      expect(DEFAULT_SEVERITY[type], `no default severity for "${type}"`).toBeDefined();
      expect(describeSecurityEvent(type).length).toBeGreaterThan(0);
    }
  });

  it("rejects an unknown type", () => {
    expect(isSecurityEventType("rate-limit")).toBe(false);
    expect(isSecurityEventType("rate_limit.exceeded")).toBe(true);
    expect(isSecurityEventType(null)).toBe(false);
  });

  it("treats a forged webhook signature as critical", () => {
    // The HMAC is the only thing between the internet and subscription state.
    expect(DEFAULT_SEVERITY["webhook.signature_invalid"]).toBe("critical");
    expect(DEFAULT_SEVERITY["tenant.cross_access_attempt"]).toBe("critical");
  });
});

/* ================================================================== */
/* 2. SEVERITY CANNOT BE DEMOTED                                       */
/* ================================================================== */

describe("severity resolution", () => {
  it("a caller CANNOT lower an alarm", () => {
    const resolved = resolveSeverity("webhook.signature_invalid", "info");

    expect(
      resolved,
      "a call site silenced a CRITICAL alarm by passing a lower severity — " +
        "the alarm would never fire again and nobody would notice, because a " +
        "missing alarm produces no output",
    ).toBe("critical");
  });

  it("a caller CAN raise one", () => {
    // Credential stuffing turns an ordinary failed login into something else.
    expect(resolveSeverity("auth.login_failed", "critical")).toBe("critical");
  });

  it("falls back to the default when nothing is requested", () => {
    expect(resolveSeverity("portal.token_invalid")).toBe("info");
  });

  it("orders severities for threshold comparisons", () => {
    expect(atLeastSeverity("critical", "warning")).toBe(true);
    expect(atLeastSeverity("info", "warning")).toBe(false);
    expect(atLeastSeverity("warning", "warning")).toBe(true);
  });
});

/* ================================================================== */
/* 3. REDACTION                                                        */
/* ================================================================== */

describe("detail redaction", () => {
  it("strips every secret-shaped key, at any depth", () => {
    // The concrete failure: an engineer debugging a rejection adds
    // `detail: { headers: Object.fromEntries(request.headers) }`, which
    // carries `x-razorpay-signature` and sometimes a live session cookie into
    // an append-only, SIEM-exported table with no deletion path.
    const clean = sanitiseDetail({
      policy: "webhook",
      headers: {
        authorization: "Bearer sk_live_realkey",
        cookie: "__session=abc",
        "x-razorpay-signature": "deadbeef",
        "user-agent": "curl/8.0",
      },
      portalToken: "a".repeat(64),
      apiKey: "k-123",
      nested: { deeper: { password: "hunter2" } },
    });

    const serialised = JSON.stringify(clean);

    for (const secret of ["sk_live_realkey", "__session=abc", "deadbeef", "hunter2", "k-123"]) {
      expect(serialised, `"${secret}" reached the security event table`).not.toContain(secret);
    }
    expect(serialised).not.toContain("a".repeat(64));

    // Non-secret circumstance survives — a redactor that ate everything would
    // be quietly replaced by call sites that stopped using it.
    expect(serialised).toContain("curl/8.0");
    expect(clean["policy"]).toBe("webhook");
  });

  it("truncates a very long value", () => {
    const clean = sanitiseDetail({ note: "x".repeat(5000) });
    expect(String(clean["note"]).length).toBeLessThan(600);
  });

  it("survives a self-referencing object", () => {
    // A hang here would freeze the request that is trying to report an
    // attack — the worst possible place for an infinite loop.
    const loop: Record<string, unknown> = { name: "loop" };
    loop["self"] = loop;
    expect(() => sanitiseDetail(loop)).not.toThrow();
  });

  it("returns an empty object for no detail", () => {
    expect(sanitiseDetail(undefined)).toEqual({});
  });
});

/* ================================================================== */
/* 4. DETECTOR THRESHOLDS — EXACT BOUNDARIES                           */
/* ================================================================== */

describe("anomaly rules — failed login burst", () => {
  it("does NOT fire exactly AT the threshold", () => {
    const events = Array.from({ length: ANOMALY_THRESHOLDS.failedLoginCount }, () =>
      observation(),
    );
    expect(detectFailedLoginBurst(events, NOW)).toHaveLength(0);
  });

  it("fires one past the threshold", () => {
    const events = Array.from({ length: ANOMALY_THRESHOLDS.failedLoginCount + 1 }, () =>
      observation(),
    );
    const findings = detectFailedLoginBurst(events, NOW);

    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("critical");
    expect(findings[0]!.subjectType).toBe("ip_prefix");
  });

  it("counts OCCURRENCES, not rows", () => {
    // ⭐ The subtle inversion this guards: the recorder coalesces bursts, so
    // counting rows would UNDERCOUNT an attack by exactly the factor that
    // makes it an attack — the harder the attempt, the more it is coalesced,
    // the less it looks like one.
    const events = [observation({ occurrenceCount: 500 })];
    expect(detectFailedLoginBurst(events, NOW)).toHaveLength(1);
  });

  it("does not merge two different networks into one finding", () => {
    const a = Array.from({ length: 20 }, () => observation({ ipPrefix: "203.0.113.0/24" }));
    const b = Array.from({ length: 20 }, () => observation({ ipPrefix: "198.51.100.0/24" }));
    expect(detectFailedLoginBurst([...a, ...b], NOW)).toHaveLength(2);
  });

  it("ignores events outside the window", () => {
    const stale = Array.from({ length: 100 }, () =>
      observation({
        occurredAt: new Date(NOW - (ANOMALY_THRESHOLDS.failedLoginWindowMinutes + 5) * 60_000),
      }),
    );
    expect(detectFailedLoginBurst(stale, NOW)).toHaveLength(0);
  });
});

describe("anomaly rules — denial spike", () => {
  it("does NOT fire at the threshold and DOES one past it", () => {
    const at = Array.from({ length: ANOMALY_THRESHOLDS.denialCount }, () => denial());
    expect(detectDenialSpike(at, NOW)).toHaveLength(0);

    const past = Array.from({ length: ANOMALY_THRESHOLDS.denialCount + 1 }, () => denial());
    expect(detectDenialSpike(past, NOW)).toHaveLength(1);
  });

  it("is keyed by USER, not by tenant", () => {
    // A tenant-wide count would fire on a Monday morning after a role change
    // removed one permission from forty people — a misconfiguration, not an
    // attack, and the fastest way to get a detector muted.
    const spread = Array.from({ length: 40 }, (_, i) =>
      denial({ userId: `user-${i % 20}` }),
    );
    expect(detectDenialSpike(spread, NOW)).toHaveLength(0);
  });

  it("reports how many DISTINCT permissions were probed", () => {
    // Many distinct permissions separates "a script enumerating what it can
    // do" from "one broken button clicked a lot".
    const rows = Array.from({ length: 30 }, (_, i) =>
      denial({ permission: `perm:${i}` }),
    );
    const finding = detectDenialSpike(rows, NOW)[0]!;
    expect(finding.detail["distinctPermissions"]).toBe(30);
  });
});

describe("anomaly rules — portal token sharing", () => {
  it("does NOT fire at the threshold and DOES one past it", () => {
    const atThreshold = Array.from(
      { length: ANOMALY_THRESHOLDS.portalDistinctNetworks },
      (_, i) =>
        observation({
          eventType: "portal.token_invalid",
          subjectId: "tokref-1",
          ipPrefix: `203.0.${i}.0/24`,
        }),
    );
    expect(detectPortalTokenSharing(atThreshold, NOW)).toHaveLength(0);

    const past = [
      ...atThreshold,
      observation({
        eventType: "portal.token_invalid",
        subjectId: "tokref-1",
        ipPrefix: "198.51.100.0/24",
      }),
    ];
    expect(detectPortalTokenSharing(past, NOW)).toHaveLength(1);
  });

  it("does not fire for many requests from ONE network", () => {
    // One recipient reloading a contract is not an incident.
    const rows = Array.from({ length: 200 }, () =>
      observation({
        eventType: "portal.token_invalid",
        subjectId: "tokref-2",
        ipPrefix: "203.0.113.0/24",
      }),
    );
    expect(detectPortalTokenSharing(rows, NOW)).toHaveLength(0);
  });
});

describe("anomaly rules — off-hours bulk export", () => {
  it("recognises the IST off-hours window", () => {
    // 20:00 UTC = 01:30 IST — off hours.
    expect(isOffHoursIst(new Date("2026-07-31T20:00:00Z"))).toBe(true);
    // 06:00 UTC = 11:30 IST — a working morning.
    expect(isOffHoursIst(new Date("2026-07-31T06:00:00Z"))).toBe(false);
    expect(istHour(new Date("2026-07-31T06:00:00Z"))).toBe(11);
  });

  /**
   * ══════════════════════════════════════════════════════════════════
   * 🔴 WAVE 9 — THIS TEST USED TO PASS AND THE RULE WAS DEAD
   * ══════════════════════════════════════════════════════════════════
   * The previous version built an observation with
   * `eventType: "export.bulk"` and `occurrenceCount: 500` and asserted a
   * finding. Both halves were wrong in a way the test could not see:
   *
   *   • NOTHING IN THE PRODUCT EVER EMITTED AN `export.*` EVENT, so the
   *     rule examined zero rows on every real sweep. The test
   *     manufactured the one input that made it look alive.
   *
   *   • `occurrenceCount` IS THE RECORDER'S COALESCING COUNTER, not a
   *     record count. Setting it to 500 in a fixture is trivial; getting
   *     it to 500 in production would have required five hundred exports
   *     inside a ten-second window, while ONE export of fifty thousand
   *     rows would have scored 1 and never fired.
   *
   * The size threshold now lives at the emitter
   * (`server/export/log.ts`, via `lib/security/hours.ts`), where the real
   * row count is in hand. An `export.bulk` event means "this export was
   * large" as a fact rather than as an inference, and this rule's only
   * remaining job is to correlate that fact with the clock.
   */
  it("fires on a bulk export that landed out of hours", () => {
    const now = new Date("2026-07-31T22:00:00Z").getTime();

    const offHours = observation({
      eventType: "export.bulk",
      // ⚠️ ONE export, not five hundred. The old rule could not have fired
      // on this and it is the exact case that matters most.
      occurrenceCount: 1,
      occurredAt: new Date("2026-07-31T20:00:00Z"),
    });

    const findings = detectOffHoursBulkExport([offHours], now);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.ruleId).toBe("export.off_hours_bulk");
  });

  it("does not fire on a bulk export during working hours", () => {
    const now = new Date("2026-07-31T22:00:00Z").getTime();
    const working = observation({
      eventType: "export.bulk",
      occurrenceCount: 5_000,
      occurredAt: new Date("2026-07-31T06:00:00Z"),
    });
    expect(detectOffHoursBulkExport([working], now)).toHaveLength(0);
  });

  /**
   * ⚠️ `export.off_hours` IS EMITTED FOR EVERY OUT-OF-HOURS EXPORT
   * INCLUDING SMALL ONES, and this rule must ignore it. Correlating on
   * both types would report the same export twice — once as itself and
   * once as its own corroboration — and inflate a two-row incident into
   * a four-row one.
   */
  it("ignores the off-hours event itself, so one export is not counted twice", () => {
    const now = new Date("2026-07-31T22:00:00Z").getTime();
    const marker = observation({
      eventType: "export.off_hours",
      occurrenceCount: 1,
      occurredAt: new Date("2026-07-31T20:00:00Z"),
    });
    expect(detectOffHoursBulkExport([marker], now)).toHaveLength(0);
  });

  /**
   * ⚠️ `warning`, AND IT ALWAYS WAS. The rule declared `notice` and
   * explained at length why it must never be more. `resolveSeverity`
   * takes the HIGHER of the finding's value and the event type's default,
   * and both `anomaly.detected` and `export.off_hours` default to
   * `warning` — so the declared `notice` had never once reached the
   * database. A caller may escalate and may not demote; that rule is
   * correct. The comment claiming otherwise was the false part.
   */
  it("carries the severity that will actually be written", () => {
    const now = new Date("2026-07-31T22:00:00Z").getTime();
    const findings = detectOffHoursBulkExport(
      [
        observation({
          eventType: "export.bulk",
          occurredAt: new Date("2026-07-31T20:00:00Z"),
        }),
      ],
      now,
    );
    expect(findings[0]!.severity).toBe("warning");
    expect(resolveSeverity("export.off_hours", findings[0]!.severity)).toBe("warning");
  });
});

describe("anomaly rules — sustained rate-limit pressure", () => {
  it("fires one past the threshold", () => {
    const rows = Array.from({ length: ANOMALY_THRESHOLDS.rateLimitTripCount + 1 }, () =>
      observation({ eventType: "rate_limit.exceeded" }),
    );
    expect(detectRateLimitPressure(rows, NOW)).toHaveLength(1);
    expect(
      detectRateLimitPressure(rows.slice(0, ANOMALY_THRESHOLDS.rateLimitTripCount), NOW),
    ).toHaveLength(0);
  });
});

describe("anomaly rules — the suite", () => {
  it("returns nothing for quiet, ordinary traffic", () => {
    // The property that decides whether anyone keeps the detector switched
    // on. A rule set that fires on a normal Tuesday gets muted, and a muted
    // detector is worse than none because it looks like coverage.
    const quiet = {
      events: [
        observation({ occurrenceCount: 2 }),
        observation({ eventType: "rate_limit.exceeded", occurrenceCount: 3 }),
        observation({ eventType: "portal.token_invalid", subjectId: "tokref-9" }),
      ],
      denials: [denial(), denial({ userId: "user-2" })],
    };

    expect(evaluateAnomalyRules(quiet, NOW)).toHaveLength(0);
  });

  it("reports every rule that fires, not just the first", () => {
    const events = [
      ...Array.from({ length: 60 }, () => observation()),
      ...Array.from({ length: 60 }, () =>
        observation({ eventType: "rate_limit.exceeded" }),
      ),
    ];
    const denials = Array.from({ length: 40 }, () => denial());

    const findings = evaluateAnomalyRules({ events, denials }, NOW);
    const ruleIds = new Set(findings.map((f) => f.ruleId));

    expect(ruleIds.has("auth.failed_login_burst")).toBe(true);
    expect(ruleIds.has("rate_limit.sustained_pressure")).toBe(true);
    expect(ruleIds.has("authz.denial_spike")).toBe(true);
  });
});

/* ================================================================== */
/* 5. SIEM EXPORT                                                      */
/* ================================================================== */

function exportable(over: Partial<ExportableSecurityEvent> = {}): ExportableSecurityEvent {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    eventType: "rate_limit.exceeded",
    severity: "notice",
    tenantId: "tenant-a",
    source: "api/search",
    subjectType: "user",
    subjectId: "user-1",
    actorUserId: "user-1",
    ipAddress: "203.0.113.9",
    ipPrefix: "203.0.113.0/24",
    requestId: "req-1",
    route: "/api/search",
    country: "IN",
    occurrenceCount: 4,
    detail: { policy: "search" },
    reason: "Rate limit exceeded",
    occurredAt: new Date(NOW),
    createdAt: new Date(NOW + 5),
    ...over,
  };
}

describe("SIEM export — NDJSON", () => {
  it("emits exactly one line per event", () => {
    const out = toNdjson([exportable(), exportable({ id: "22222222-2222-2222-2222-222222222222" })]);
    expect(out.trimEnd().split("\n")).toHaveLength(2);
  });

  it("cannot be split by an attacker-chosen newline", () => {
    // LOG INJECTION. NDJSON is line-delimited, so a `\n` inside a value could
    // terminate the record and let the remainder parse as a SECOND,
    // fully attacker-authored event — forging "all is well" inside the log
    // that was recording the attack.
    const nasty = exportable({
      reason: 'evil\n{"event":{"severity":"info","type":"all.clear"}}',
      source: "api\nsearch",
    });

    const line = toNdjsonLine(nasty);
    expect(line.includes("\n")).toBe(false);
    expect(toNdjson([nasty]).trimEnd().split("\n")).toHaveLength(1);
    expect(JSON.parse(line)).toBeTruthy();
  });

  it("keeps the tenant as a first-class dimension", () => {
    const parsed = JSON.parse(toNdjsonLine(exportable()));
    expect(parsed.tenant.id).toBe("tenant-a");
    expect(parsed.event.type).toBe("rate_limit.exceeded");
    expect(parsed["@timestamp"]).toBe(new Date(NOW).toISOString());
  });

  it("serialises an empty batch as an empty string, not a stray newline", () => {
    expect(toNdjson([])).toBe("");
    expect(serialiseForSiem([], "cef")).toBe("");
  });
});

describe("SIEM export — CEF", () => {
  it("escapes `=` and `\\` in the extension", () => {
    // Unescaped, these break the key=value parse and a SOC silently ingests
    // a mangled event.
    expect(cefEscape("a=b")).toBe("a\\=b");
    expect(cefEscape("a\\b")).toBe("a\\\\b");
  });

  it("removes newlines, which would terminate the record", () => {
    // CEF has no quoting mechanism, so it is MORE vulnerable to the injection
    // above than NDJSON is.
    const line = toCefLine(exportable({ reason: "evil\nCEF:0|Attacker|x|1|fake|fake|1" }));
    expect(line.includes("\n")).toBe(false);
  });

  it("uses the event type verbatim as the signature id", () => {
    // A SOC writes correlation rules against this string; it is part of a
    // compatibility contract, which is the second reason the type list is a
    // closed set that changes only by migration.
    const line = toCefLine(exportable());
    expect(line.startsWith("CEF:0|Ordence|Ordence|")).toBe(true);
    expect(line).toContain("|rate_limit.exceeded|");
  });

  it("maps severity onto the ArcSight 0–10 scale", () => {
    expect(toCefLine(exportable({ severity: "critical" }))).toContain("|10|");
    expect(toCefLine(exportable({ severity: "info" }))).toContain("|2|");
  });
});

describe("SIEM export — cursor", () => {
  it("advances to the newest (createdAt, id) pair", () => {
    const older = exportable({ id: "aaa", createdAt: new Date(NOW) });
    const newer = exportable({ id: "bbb", createdAt: new Date(NOW + 1000) });

    const cursor = nextSiemCursor([newer, older], null);
    expect(cursor!.id).toBe("bbb");
  });

  it("breaks a same-millisecond tie by id", () => {
    // ⭐ Two rows can share a millisecond. A timestamp-only cursor either
    // skips one (evidence silently lost) or repeats it forever (the export
    // loops). The tuple is exact.
    const a = exportable({ id: "aaa", createdAt: new Date(NOW) });
    const b = exportable({ id: "bbb", createdAt: new Date(NOW) });

    expect(nextSiemCursor([a, b], null)!.id).toBe("bbb");
    expect(nextSiemCursor([b, a], null)!.id).toBe("bbb");
  });

  it("leaves the cursor untouched for an empty batch", () => {
    const previous = { createdAt: new Date(NOW), id: "aaa" };
    expect(nextSiemCursor([], previous)).toBe(previous);
  });
});
