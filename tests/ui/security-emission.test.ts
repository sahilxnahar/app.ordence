/**
 * Ordence — ⭐⭐⭐ WAVE 9: THE DECLARED-AND-UNEMITTED SWEEP
 * Version: v1.77.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THESE TESTS ARE ACTUALLY DEFENDING
 * ══════════════════════════════════════════════════════════════════════
 * Ten of the twenty-one declared security event types had never been
 * written by any code path in the product. Two of the five anomaly
 * detection rules read event types nothing emitted, so they examined zero
 * rows on every sweep since Phase 20 and reported nothing, for every
 * input, forever.
 *
 * ⚠️ THE FAILURE MODE IS SILENCE. There is no output to be wrong. A
 * dashboard on `auth.brute_force_suspected` was green through every
 * possible attack because the row it needed was filed elsewhere, and a
 * green dashboard is what "nothing is happening" looks like.
 *
 * So these tests assert the WIRING, not the behaviour of the recorder:
 * that each surface reaches for the right type, that each rule maps onto
 * the type its SIEM mapping promises, and that the two grouping keys the
 * portal sharing rule depends on are computed by one function.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  SECURITY_EVENT_TYPES,
  DEFAULT_SEVERITY,
  resolveSeverity,
  type SecurityEventType,
} from "@/lib/security/events";
import {
  BULK_EXPORT_RECORDS,
  isBulkExport,
  isOffHoursIst,
  istHour,
  OFF_HOURS_END_HOUR_IST,
  OFF_HOURS_START_HOUR_IST,
} from "@/lib/security/hours";
import {
  ANOMALY_THRESHOLDS,
  detectPortalTokenSharing,
  eventTypeForRule,
  type Observation,
} from "@/server/security/anomalies";
import { DECLARED_ONLY_PERMISSIONS } from "@/lib/auth/permission-enforcement";
import { PERMISSION_CATALOG } from "@/db/schema/auth";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
/** Comments discuss types; they do not emit them. */
const codeOnly = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

const NOW = new Date("2026-07-31T22:00:00Z").getTime();

function observation(over: Partial<Observation> = {}): Observation {
  return {
    eventType: "portal.token_invalid",
    tenantId: null,
    subjectId: "0123456789abcdef",
    ipPrefix: "203.0.113.0/24",
    occurrenceCount: 1,
    occurredAt: new Date(NOW - 60_000),
    ...over,
  };
}

/* ------------------------------------------------------------------ */

describe("⭐ every declared event type is emitted by something", () => {
  /**
   * ⚠️ THE SAME MATCHER `scripts/check-security-events.mjs` USES, and
   * for the same reason: the original audit used "is the literal
   * anywhere" and MISSED `authz.denial_spike`, because an anomaly rule
   * uses that exact text as its `ruleId`. A rule identifier is not an
   * emission.
   */
  const FILES = [
    "server/portal-context.ts",
    "server/export/log.ts",
    "server/security/anomalies.ts",
    "server/security/rate-limit-durable.ts",
    "server/platform/guard.ts",
    "server/platform/impersonation.ts",
    "server/platform/action-log.ts",
    "app/api/upload/put/route.ts",
    "app/api/webhooks/stripe/route.ts",
    "app/api/webhooks/razorpay/route.ts",
    "app/api/webhooks/clerk/_webhook.ts",
    "app/api/cron/canary/route.ts",
    "app/portal/[token]/page.tsx",
    "app/portal/[token]/documents/[documentId]/route.ts",
    "lib/security/lockout.ts",
  ];

  const bodies = FILES.map((f) => codeOnly(read(f)));

  function emitted(type: SecurityEventType): boolean {
    const needle = `"${type}"`;
    return bodies.some((text) => {
      let at = text.indexOf(needle);
      while (at !== -1) {
        const after = text.slice(at + needle.length, at + needle.length + 4);
        const before = text.slice(Math.max(0, at - 40), at);
        if (!/^\s*:/.test(after) && !/(ruleId|rule|ruleName)\s*:\s*$/.test(before)) return true;
        at = text.indexOf(needle, at + 1);
      }
      return false;
    });
  }

  it.each(SECURITY_EVENT_TYPES.map((t) => [t] as const))("%s reaches a surface", (type) => {
    expect(emitted(type)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */

describe("⭐ the anomaly runner writes the type each rule's SIEM mapping promises", () => {
  it("maps the four rules that have a specific type", () => {
    expect(eventTypeForRule("auth.failed_login_burst")).toBe("auth.brute_force_suspected");
    expect(eventTypeForRule("authz.denial_spike")).toBe("authz.denial_spike");
    expect(eventTypeForRule("portal.token_shared")).toBe("portal.token_shared_suspected");
    expect(eventTypeForRule("export.off_hours_bulk")).toBe("export.off_hours");
  });

  /**
   * ⚠️ THE FALLBACK IS DELIBERATE AND IS NOT A GAP. A throw would mean
   * one unmapped rule ends the whole sweep in the runner's catch block,
   * losing the findings of every rule that already ran.
   * `check:security-events` is what makes the omission visible.
   */
  it("falls back rather than throwing on a rule it does not know", () => {
    expect(eventTypeForRule("rate_limit.sustained_pressure")).toBe("anomaly.detected");
    expect(eventTypeForRule("something.invented.today")).toBe("anomaly.detected");
  });

  /**
   * 🔴 THE POINT OF THE MAP. `auth.brute_force_suspected` is the ONLY
   * critical in the authentication group and exists so a correlation rule
   * can page on it. Recorded as `anomaly.detected` it arrived as a
   * warning-by-default catch-all, and the page never fired.
   */
  it("raises a brute-force finding to critical, which anomaly.detected could not", () => {
    expect(DEFAULT_SEVERITY["auth.brute_force_suspected"]).toBe("critical");
    expect(DEFAULT_SEVERITY["anomaly.detected"]).toBe("warning");
    expect(resolveSeverity(eventTypeForRule("auth.failed_login_burst"), "critical")).toBe(
      "critical",
    );
    // The old path could not reach critical from a warning default...
    expect(resolveSeverity("anomaly.detected", "warning")).toBe("warning");
  });
});

/* ------------------------------------------------------------------ */

describe("⭐ the portal sharing rule now has input it can see", () => {
  /**
   * 🔴 THIS RULE COULD NOT FIRE FOR ANY INPUT. It filters
   * `eventType.startsWith("portal.")`, and no portal surface had ever
   * written a `portal.*` event — the two that wrote anything wrote
   * `rate_limit.exceeded`, which does not match.
   */
  it("fires once one token is refused from more networks than the threshold", () => {
    const rows = Array.from(
      { length: ANOMALY_THRESHOLDS.portalDistinctNetworks + 1 },
      (_, i) => observation({ ipPrefix: `203.0.${113 + i}.0/24` }),
    );
    const findings = detectPortalTokenSharing(rows, NOW);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.ruleId).toBe("portal.token_shared");
    expect(eventTypeForRule(findings[0]!.ruleId)).toBe("portal.token_shared_suspected");
  });

  it("does not fire at the threshold, only past it", () => {
    const rows = Array.from({ length: ANOMALY_THRESHOLDS.portalDistinctNetworks }, (_, i) =>
      observation({ ipPrefix: `203.0.${113 + i}.0/24` }),
    );
    expect(detectPortalTokenSharing(rows, NOW)).toHaveLength(0);
  });

  /**
   * ⚠️ ONE GROUPING KEY, COMPUTED IN ONE PLACE. The rate-limit emissions
   * used `token.slice(0, 8)` and the rule needed the hash prefix, so the
   * same token would have appeared under two identities and split its own
   * sharing count in half — below the threshold, silently.
   */
  it("groups on the subject id, so two identities for one token would halve the count", () => {
    const split = [
      ...Array.from({ length: 4 }, (_, i) =>
        observation({ subjectId: "hash-form", ipPrefix: `203.0.${113 + i}.0/24` }),
      ),
      ...Array.from({ length: 4 }, (_, i) =>
        observation({ subjectId: "token-form", ipPrefix: `198.51.${100 + i}.0/24` }),
      ),
    ];
    expect(detectPortalTokenSharing(split, NOW)).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */

describe("⭐ the portal resolver records its refusals", () => {
  const src = read("server/portal-context.ts");
  const code = codeOnly(src);

  it("emits from the resolver, not from the three call sites", () => {
    expect(code).toContain("recordPortalRefusal");
    expect(code).toMatch(/if \(!resolution\.ok\) await recordPortalRefusal/);
  });

  it("maps the three refusals that are security events and no others", () => {
    expect(code).toContain('malformed: "portal.token_invalid"');
    expect(code).toContain('not_found: "portal.token_invalid"');
    expect(code).toContain('expired: "portal.token_expired"');
    expect(code).toContain('revoked: "portal.token_revoked_use"');
    /**
     * ⚠️ `already_signed` IS A CLIENT RE-READING THEIR OWN CONTRACT,
     * `tenant_inactive` IS OUR OWN ADMINISTRATIVE STATE, and
     * `lookup_failed` IS AN OUTAGE. None of the three is an attacker,
     * and a security table that fills with them stops being read.
     */
    expect(code).not.toMatch(/already_signed:\s*"portal\./);
    expect(code).not.toMatch(/tenant_inactive:\s*"portal\./);
    expect(code).not.toMatch(/lookup_failed:\s*"portal\./);
  });

  it("never puts a live credential in the subject id", () => {
    expect(code).toContain("portalTokenRef(token)");
    // The raw-token prefix is gone from every portal surface.
    for (const file of [
      "server/portal-context.ts",
      "app/portal/[token]/page.tsx",
      "app/portal/[token]/documents/[documentId]/route.ts",
    ]) {
      expect(codeOnly(read(file))).not.toContain("token.slice(0, 8)");
    }
  });

  it("only derives a reference from something shaped like a token", () => {
    // Hashing junk would group every scanner's rubbish under one "token"
    // and report a shared portal link that never existed.
    expect(code).toMatch(/isWellFormedToken\(token\) \? portalTokenRef\(token\) : null/);
  });
});

/* ------------------------------------------------------------------ */

describe("⭐ the export engine tells the security stream", () => {
  const code = codeOnly(read("server/export/log.ts"));

  it("emits both types from the one mandatory door", () => {
    expect(code).toContain('type: "export.bulk"');
    expect(code).toContain('type: "export.off_hours"');
    expect(code).toContain("export async function recordExportAndNotify");
    // The action goes through the notifying wrapper, never the bare log.
    const action = codeOnly(read("server/actions/export.ts"));
    expect(action).toContain("recordExportAndNotify(");
    expect(action).not.toMatch(/await recordExport\(\{/);
  });

  it("only speaks about exports that were actually delivered", () => {
    expect(code).toMatch(/if \(entry\.outcome !== "delivered"\) return;/);
  });

  /**
   * 🔴 THE BUG THAT KILLED THE RULE. `occurrenceCount` is the recorder's
   * coalescing counter. A row count written there is overwritten by the
   * next export inside the ten-second window.
   */
  it("puts the row count in the detail and never in occurrenceCount", () => {
    expect(code).toContain("rowCount: entry.rowCount");
    expect(code).not.toContain("occurrenceCount:");
  });

  it("cannot fail the export it is reporting", () => {
    expect(code).toMatch(/try \{\s*await noteExportInSecurityStream/);
  });
});

/* ------------------------------------------------------------------ */

describe("⭐ the upload surface records what it refuses", () => {
  const code = codeOnly(read("app/api/upload/put/route.ts"));

  it("records a cross-tenant ticket as the critical event it is", () => {
    expect(code).toContain('type: "tenant.cross_access_attempt"');
    expect(DEFAULT_SEVERITY["tenant.cross_access_attempt"]).toBe("critical");
  });

  /**
   * ⚠️ ONLY THE CONTENT-INSPECTION REFUSAL. Every refusal above it caught
   * a client that ASKED for something not permitted — a mistake. This one
   * caught a client whose bytes do not match what it declared them to be,
   * twice, in two places it had to keep consistent. A row for every 415
   * would bury that under ordinary user error.
   */
  it("records the sniff refusal and not the ordinary allowlist ones", () => {
    expect(code).toContain('type: "upload.rejected"');
    expect(code.match(/type: "upload\.rejected"/g)).toHaveLength(1);
  });

  it("never writes the ticket itself, only the path it authorised", () => {
    expect(code).not.toMatch(/subjectId:\s*ticketRaw/);
    expect(code).toContain("subjectId: ticket.p.slice(0, 200)");
  });
});

/* ------------------------------------------------------------------ */

describe("⭐ a stale webhook timestamp is not a bad signature", () => {
  const code = codeOnly(read("app/api/webhooks/stripe/route.ts"));

  it("separates the replay from the forgery", () => {
    expect(code).toContain('"webhook.replay_suspected"');
    expect(code).toContain('verification.reason === "timestamp_out_of_tolerance"');
    expect(code).toContain('"webhook.signature_invalid"');
    expect(code).toContain('"webhook.secret_missing"');
  });

  /**
   * ⚠️ ONLY STRIPE CAN MAKE THIS DISTINCTION. Razorpay's scheme carries
   * no timestamp at all and Svix verifies both inside one opaque call, so
   * neither of those routes can tell the two apart — and neither pretends
   * to.
   */
  it("is not claimed by the two providers that cannot tell", () => {
    expect(codeOnly(read("app/api/webhooks/razorpay/route.ts"))).not.toContain(
      "webhook.replay_suspected",
    );
    expect(codeOnly(read("app/api/webhooks/clerk/_webhook.ts"))).not.toContain(
      "webhook.replay_suspected",
    );
  });
});

/* ------------------------------------------------------------------ */

describe("⭐ off-hours and bulk are one fact, shared by the emitter and the detector", () => {
  it("is a pure module both sides import", () => {
    const hours = read("lib/security/hours.ts");
    expect(hours).not.toContain('import "server-only"');
    expect(codeOnly(read("server/export/log.ts"))).toContain("@/lib/security/hours");
    expect(codeOnly(read("server/security/anomalies.ts"))).toContain("@/lib/security/hours");
  });

  it("keeps the detector's thresholds pointed at the shared numbers", () => {
    expect(ANOMALY_THRESHOLDS.bulkExportRecords).toBe(BULK_EXPORT_RECORDS);
    expect(ANOMALY_THRESHOLDS.offHoursStartHourIst).toBe(OFF_HOURS_START_HOUR_IST);
    expect(ANOMALY_THRESHOLDS.offHoursEndHourIst).toBe(OFF_HOURS_END_HOUR_IST);
  });

  it("counts records, not events", () => {
    expect(isBulkExport(BULK_EXPORT_RECORDS - 1)).toBe(false);
    expect(isBulkExport(BULK_EXPORT_RECORDS)).toBe(true);
    expect(isBulkExport(50_000)).toBe(true);
  });

  it("puts the IST boundary where the constant says", () => {
    // 16:29 UTC = 21:59 IST — still a working evening.
    expect(isOffHoursIst(new Date("2026-07-31T16:29:00Z"))).toBe(false);
    // 16:30 UTC = 22:00 IST — off hours begins.
    expect(isOffHoursIst(new Date("2026-07-31T16:30:00Z"))).toBe(true);
    // 00:29 UTC = 05:59 IST — still off hours.
    expect(isOffHoursIst(new Date("2026-07-31T00:29:00Z"))).toBe(true);
    // 00:30 UTC = 06:00 IST — the working day.
    expect(isOffHoursIst(new Date("2026-07-31T00:30:00Z"))).toBe(false);
    expect(istHour(new Date("2026-07-31T16:30:00Z"))).toBe(22);
  });
});

/* ------------------------------------------------------------------ */

describe("⭐ the permissions that were declared and checked by nothing", () => {
  const catalogue = PERMISSION_CATALOG as Record<string, string>;

  it("records every remaining unenforced key against the catalogue", () => {
    for (const entry of DECLARED_ONLY_PERMISSIONS) {
      expect(catalogue[entry.key]).toBeTruthy();
      expect(entry.reason.length).toBeGreaterThan(120);
    }
  });

  it("gates the six accounting reads that exposed the whole general ledger", () => {
    const code = codeOnly(read("server/actions/accounting.ts"));
    expect(code.match(/requirePermission\("ledgers:read"\)/g)).toHaveLength(5);
    expect(code.match(/requirePermission\("transactions:read"\)/g)).toHaveLength(1);
    /**
     * 🔴 A SESSION ALONE IS NO LONGER THE GUARD ON ANY OF THEM. The old
     * note considered one attacker — somebody with no session — and not
     * the one the role model exists for: somebody with a good session and
     * the wrong role.
     */
    expect(code).not.toContain("const ctx = await requireTenantContext();");
  });

  it("gates the asset reads and the clause library", () => {
    const assets = codeOnly(read("server/actions/assets.ts"));
    expect(assets.match(/requirePermission\("assets:read"/g)).toHaveLength(3);
    expect(assets).not.toContain("requireTenantContext()");

    const documents = codeOnly(read("server/actions/documents.ts"));
    expect(documents).toContain('requirePermission("clauses:read")');
  });

  it("makes the legal hold reachable, having been honoured in five places and settable in none", () => {
    const action = codeOnly(read("server/actions/legal-hold.ts"));
    expect(action).toContain('requirePermission("contracts:legal_hold")');
    expect(action).toContain("export async function placeLegalHold");
    expect(action).toContain("export async function liftLegalHold");
    // Both directions are audited at the severity that survives filtering.
    expect(action.match(/severity: "critical"/g)).toHaveLength(2);
    // And the page offers it.
    const page = codeOnly(read("app/(crm)/contracts/[id]/page.tsx"));
    expect(page).toContain("LegalHoldControl");
    expect(page).toContain('can(subject, "contracts:legal_hold")');
  });

  it("gives roles:read the screen it never had", () => {
    const team = codeOnly(read("server/actions/team.ts"));
    expect(team).toContain('requirePermission("roles:read")');
    expect(team).toContain("export async function getRolePermissionMatrix");
    /**
     * ⚠️ `platform_super_admin` IS EXCLUDED. Listing an Ordence staff
     * role on a customer's screen tells them a role exists that can see
     * their data and that they cannot control.
     */
    expect(team).toContain('template.key !== "platform_super_admin"');
  });
});

/* ------------------------------------------------------------------ */

describe("⭐ the api rate-limit policy is no longer a claim about nothing", () => {
  it("is applied to the one edge-exempt route with no session and no secret", () => {
    const diag = codeOnly(read("app/api/diag/route.ts"));
    expect(diag).toContain('checkRateLimit("api"');
    expect(diag).toContain("ipRateLimitKey");
  });

  /**
   * ⚠️ THE OPPOSITE OF EVERY OTHER LIMIT IN THE PRODUCT, ON PURPOSE.
   * This route exists to answer "what is broken?" during an outage, and
   * an outage is exactly when the limiter's own backend is a candidate.
   */
  it("allows the request when the limiter itself is unwell", () => {
    const diag = read("app/api/diag/route.ts");
    expect(diag).toMatch(/\} catch \{\s*return true;\s*\}/);
  });

  it("no longer claims to be the product's default ceiling", () => {
    const limits = read("lib/security/rate-limit.ts");
    expect(limits).not.toContain(
      "Default ceiling so a new route is never completely unguarded.",
    );
    expect(limits).toContain("lib/edge/budgets.ts");
  });
});
