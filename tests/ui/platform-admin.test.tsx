/**
 * Ordence — Platform Console: Policy & UI
 * Version: v0.14.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * PHASES 17 & 18 MANDATORY VERIFICATION (the pure half)
 * ══════════════════════════════════════════════════════════════════════
 * `tests/security/platform-isolation.test.ts` proves what the DATABASE
 * refuses. This file proves what the POLICY says, and that the UI tells
 * the operator the truth about it.
 *
 * Four properties, each of which would be a silent failure:
 *
 *   1. ⭐ NEITHER KEY ALONE OPENS THE DOOR. An env allowlist entry with
 *      no staff grant, or a staff grant with no allowlist entry, must be
 *      refused. And an EMPTY allowlist must match nobody — the failure
 *      mode of a missing environment variable has to be "the console is
 *      unreachable", never "the console is open".
 *
 *   2. ⭐ BREAK-GLASS CANNOT BE READ-WRITE, and the forbidden-operation
 *      list actually blocks the operations that would outlive the
 *      session. A deny-list with a hole in it is worse than none,
 *      because everybody assumes it holds.
 *
 *   3. THE OPERATION CLASSIFIER FAILS CLOSED. A verb nobody has
 *      classified must count as a WRITE, so a new action added next year
 *      is refused under break-glass rather than silently permitted.
 *
 *   4. THE BANNER CANNOT BE MISREAD. It always names the workspace,
 *      always states the scope, and has no dismiss control.
 *
 * ⚠️ Nothing that carries a rule is mocked. The schemas, the policy
 * module, the health scoring and the components are all the real
 * implementations.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  PLATFORM_GRADES,
  PLATFORM_CAPABILITY_KEYS,
  capabilitiesForGrade,
  evaluatePlatformAccess,
  evaluatePlatformCapability,
  hasPlatformCapability,
  parseAdminAllowlist,
  isAllowlisted,
  isStepUpFresh,
  requiresStepUp,
  STEP_UP_MAX_AGE_MINUTES,
  type PlatformSubject,
} from "@/lib/platform/roles";

import {
  MAX_SCOPE,
  SESSION_MINUTES,
  MAX_SESSION_MINUTES,
  MIN_JUSTIFICATION_LENGTH,
  resolveScope,
  expiryFor,
  isSessionLive,
  minutesRemaining,
  evaluateOperation,
  isWriteOperation,
  bannerText,
  FORBIDDEN_PREFIXES,
} from "@/lib/platform/impersonation-policy";

import {
  SCOPE_DEFINITIONS,
  SEARCH_SCOPES,
  validateQuery,
  maskSearchTerm,
  MAX_RESULTS,
} from "@/lib/platform/search-scopes";

import { FLAG_CATALOG, FLAG_KEYS, validateFlagExpiry, isFlagKey } from "@/lib/platform/flags-catalog";
import { evaluateHealth, HEALTH_LABELS, formatStorage, relativeTime } from "@/lib/platform/health";
import {
  startImpersonationSchema,
  suspendTenantSchema,
  platformSearchSchema,
} from "@/lib/platform/schemas";

import { ImpersonationBanner } from "@/components/platform/impersonation-banner";
import { DangerDialog } from "@/components/platform/danger-dialog";
import { TenantTable } from "@/components/platform/tenant-table";

const NOW = new Date("2026-07-31T12:00:00.000Z");

function subject(over: Partial<PlatformSubject> = {}): PlatformSubject {
  return {
    clerkUserId: "user_abc",
    email: "engineer@ordence.example",
    grade: "engineer",
    status: "active",
    expiresAt: new Date("2026-12-31T00:00:00.000Z"),
    allowlisted: true,
    now: NOW,
    ...over,
  };
}

/* ================================================================== */
/* 1. WHO COUNTS AS PLATFORM STAFF                                     */
/* ================================================================== */

describe("the two-key model", () => {
  it("⭐ an allowlisted person with NO staff grant is not platform staff", () => {
    // `getPlatformOperator()` returns null before this is ever called when
    // the row is missing; this asserts the pure half of the same rule.
    expect(evaluatePlatformAccess(subject({ status: "revoked" })).allowed).toBe(false);
  });

  it("⭐ a staff grant that is NOT on the env allowlist is refused", () => {
    // The database half alone is not enough. An attacker with full write
    // access to the database still cannot let themselves in, because the
    // allowlist is not in the database.
    const decision = evaluatePlatformAccess(subject({ allowlisted: false }));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("not_allowlisted");
  });

  it("⭐⭐ an EMPTY or MISSING allowlist matches nobody", () => {
    // THE most important assertion in this file. A deployment that forgot
    // to set PLATFORM_ADMIN_EMAILS must lose an internal tool, not open
    // one. The opposite default loses every customer's data.
    for (const raw of [undefined, null, "", "   ", ",,,"]) {
      const list = parseAdminAllowlist(raw);
      expect(list.size).toBe(0);
      expect(isAllowlisted("anyone@ordence.example", list)).toBe(false);
    }
  });

  it("the allowlist is case-insensitive and tolerates spacing", () => {
    const list = parseAdminAllowlist(" Priya@Ordence.Example , dev@ordence.example ");
    expect(isAllowlisted("priya@ordence.example", list)).toBe(true);
    expect(isAllowlisted("PRIYA@ORDENCE.EXAMPLE", list)).toBe(true);
    expect(isAllowlisted("someone@else.example", list)).toBe(false);
  });

  it("entries without an @ are discarded rather than matched loosely", () => {
    // "*" or "all" in the env var must not become a wildcard.
    const list = parseAdminAllowlist("*,all,everyone");
    expect(list.size).toBe(0);
  });

  it("an expired or revoked grant is refused, with distinguishable reasons", () => {
    expect(
      evaluatePlatformAccess(subject({ expiresAt: new Date("2026-01-01T00:00:00Z") })).reason,
    ).toBe("staff_expired");
    expect(evaluatePlatformAccess(subject({ status: "revoked" })).reason).toBe("staff_revoked");
    expect(evaluatePlatformAccess(subject({ status: "suspended" })).reason).toBe(
      "staff_suspended",
    );
  });

  it("a grant with no expiry is honoured (but the console flags it)", () => {
    expect(evaluatePlatformAccess(subject({ expiresAt: null })).allowed).toBe(true);
  });
});

describe("the capability matrix", () => {
  it("⭐ support cannot suspend, break-glass, or grant staff", () => {
    // The support rota is the largest group and the most phished. A
    // compromised support account must cost a consented read, not the
    // platform.
    const s = subject({ grade: "support" });
    expect(hasPlatformCapability(s, "tenants:suspend")).toBe(false);
    expect(hasPlatformCapability(s, "impersonate:breakglass")).toBe(false);
    expect(hasPlatformCapability(s, "staff:manage")).toBe(false);
    expect(hasPlatformCapability(s, "flags:write")).toBe(false);
    // …but can do the job.
    expect(hasPlatformCapability(s, "impersonate:consented")).toBe(true);
    expect(hasPlatformCapability(s, "search:directory")).toBe(true);
  });

  it("engineer adds break-glass and flags, but still cannot suspend or grant", () => {
    const s = subject({ grade: "engineer" });
    expect(hasPlatformCapability(s, "impersonate:breakglass")).toBe(true);
    expect(hasPlatformCapability(s, "flags:write")).toBe(true);
    expect(hasPlatformCapability(s, "tenants:suspend")).toBe(false);
    expect(hasPlatformCapability(s, "staff:manage")).toBe(false);
  });

  it("⭐ each grade is a strict SUPERSET of the one below", () => {
    // The property that makes the ladder a ladder. Without it the matrix
    // can drift into a state where an engineer has something an owner
    // does not, and nobody notices until somebody cannot do their job.
    for (let i = 1; i < PLATFORM_GRADES.length; i++) {
      const lower = capabilitiesForGrade(PLATFORM_GRADES[i - 1]!);
      const higher = capabilitiesForGrade(PLATFORM_GRADES[i]!);
      for (const cap of lower) {
        expect(higher, `${PLATFORM_GRADES[i]} is missing ${cap}`).toContain(cap);
      }
    }
  });

  it("⭐ an unknown capability is DENIED, not permitted", () => {
    // A typo at a call site must deny. The opposite default turns every
    // typo into a silent hole.
    const decision = evaluatePlatformCapability(subject({ grade: "owner" }), "tenants:destroy");
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("unknown_capability");
  });

  it("a capability check re-runs the access check", () => {
    // A capability check that assumed the caller already passed access is
    // one refactor away from being the only check that runs.
    expect(
      evaluatePlatformCapability(subject({ grade: "owner", allowlisted: false }), "tenants:list")
        .allowed,
    ).toBe(false);
  });

  it("every dangerous capability requires a fresh second factor", () => {
    for (const cap of [
      "tenants:suspend",
      "impersonate:consented",
      "impersonate:breakglass",
      "staff:manage",
      "flags:write",
    ] as const) {
      expect(requiresStepUp(cap), `${cap} should need step-up`).toBe(true);
    }
    expect(requiresStepUp("tenants:list")).toBe(false);
  });

  it("step-up freshness is a window, and a FUTURE timestamp is refused", () => {
    const justNow = new Date(NOW.getTime() - 60_000);
    const stale = new Date(NOW.getTime() - (STEP_UP_MAX_AGE_MINUTES + 1) * 60_000);
    const future = new Date(NOW.getTime() + 60_000);

    expect(isStepUpFresh(justNow, NOW)).toBe(true);
    expect(isStepUpFresh(stale, NOW)).toBe(false);
    expect(isStepUpFresh(null, NOW)).toBe(false);
    // A forged or clock-skewed future stamp must not read as maximally fresh.
    expect(isStepUpFresh(future, NOW)).toBe(false);
  });

  it("every capability in the catalogue is reachable by some grade", () => {
    const all = new Set(PLATFORM_GRADES.flatMap((g) => [...capabilitiesForGrade(g)]));
    for (const cap of PLATFORM_CAPABILITY_KEYS) {
      expect(all, `${cap} is granted to nobody`).toContain(cap);
    }
  });
});

/* ================================================================== */
/* 2. THE IMPERSONATION POLICY                                         */
/* ================================================================== */

describe("impersonation scope", () => {
  it("⭐⭐ break-glass can NEVER be read-write, whatever is passed in", () => {
    // The load-bearing rule of the consent model: the customer's
    // INABILITY TO ANSWER reduces what we may do, it does not increase it.
    expect(MAX_SCOPE.break_glass).toBe("read_only");
    expect(resolveScope("break_glass", "read_write")).toBe("read_only");
    expect(resolveScope("break_glass", null)).toBe("read_only");
  });

  it("consent NARROWS the scope but never widens it", () => {
    expect(resolveScope("standing_consent", "read_write")).toBe("read_write");
    // A customer who granted read-only gets read-only, even though the
    // mode is capable of more.
    expect(resolveScope("standing_consent", "read_only")).toBe("read_only");
    // No consent row at all → read-only, never read-write.
    expect(resolveScope("incident_consent", null)).toBe("read_only");
  });

  it("⭐ break-glass is the SHORTEST session, not the longest", () => {
    expect(SESSION_MINUTES.break_glass).toBeLessThan(SESSION_MINUTES.standing_consent);
    for (const mode of ["standing_consent", "incident_consent", "break_glass"] as const) {
      expect(SESSION_MINUTES[mode]).toBeLessThanOrEqual(MAX_SESSION_MINUTES);
    }
  });

  it("expiry is computed from the start, not from a timer", () => {
    const expires = expiryFor("break_glass", NOW);
    expect(expires.getTime() - NOW.getTime()).toBe(SESSION_MINUTES.break_glass * 60_000);
  });
});

describe("session liveness", () => {
  const live = { expiresAt: new Date(NOW.getTime() + 10 * 60_000), endedAt: null };

  it("a live session is live", () => {
    expect(isSessionLive(live, NOW)).toBe(true);
    expect(minutesRemaining(live, NOW)).toBe(10);
  });

  it("⭐ an EXPIRED session is dead even if nothing ever closed it", () => {
    // If liveness depended on a sweeper writing `ended_at`, a failed
    // sweeper would silently extend every open session in the system —
    // the exact failure "time-limited" is supposed to rule out.
    const untidied = { expiresAt: new Date(NOW.getTime() - 60_000), endedAt: null };
    expect(isSessionLive(untidied, NOW)).toBe(false);
    expect(minutesRemaining(untidied, NOW)).toBe(0);
  });

  it("a closed session is dead even if its expiry is in the future", () => {
    expect(isSessionLive({ ...live, endedAt: NOW }, NOW)).toBe(false);
  });

  it("expiry is checked on the exact boundary, not one tick late", () => {
    expect(isSessionLive({ expiresAt: NOW, endedAt: null }, NOW)).toBe(false);
  });
});

describe("what an impersonator may never do", () => {
  it("⭐⭐ role and invite management is forbidden — it outlives the session", () => {
    // THE most important entry in the deny-list. An impersonator who can
    // mint a tenant_owner or invite an account they control has converted
    // a 60-minute window into permanent access, and nothing about the
    // expiry mechanism would notice.
    for (const op of ["roles:manage", "users:invite", "users:update", "users:remove"]) {
      const verdict = evaluateOperation(op, "read_write");
      expect(verdict.allowed, `${op} must be forbidden`).toBe(false);
      expect(verdict.rule).toBe("forbidden");
    }
  });

  it("⭐ deletion is forbidden even with full consent", () => {
    expect(evaluateOperation("delete:contact", "read_write").allowed).toBe(false);
  });

  it("⭐ billing and payments are forbidden — money the customer never agreed to", () => {
    for (const op of ["billing:manage", "payment:update", "subscription:change"]) {
      expect(evaluateOperation(op, "read_write").allowed, op).toBe(false);
    }
  });

  it("⭐ bulk export is forbidden — support must not become exfiltration", () => {
    expect(evaluateOperation("export:contacts", "read_write").allowed).toBe(false);
  });

  it("⭐ an impersonator cannot grant their own consent", () => {
    // Otherwise the consent model is circular: enter under break-glass,
    // write a standing consent, re-enter with write access.
    expect(evaluateOperation("support:consent_grant", "read_write").allowed).toBe(false);
  });

  it("closing or reopening an accounting period is forbidden", () => {
    expect(evaluateOperation("periods:close", "read_write").allowed).toBe(false);
    expect(evaluateOperation("periods:reopen", "read_write").allowed).toBe(false);
  });

  it("every forbidden prefix carries a stated reason", () => {
    // A deny-list entry with no reason is one somebody deletes during a
    // refactor because they cannot tell what it was for.
    for (const prefix of FORBIDDEN_PREFIXES) {
      const verdict = evaluateOperation(`${prefix}anything`, "read_write");
      expect(verdict.reason, `${prefix} has no reason`).toBeTruthy();
      expect(verdict.reason!.length).toBeGreaterThan(20);
    }
  });

  it("ordinary support work IS permitted under consent", () => {
    // A deny-list that blocks the job is a deny-list people route around.
    expect(evaluateOperation("contacts:update", "read_write").allowed).toBe(true);
    expect(evaluateOperation("contacts:read", "read_only").allowed).toBe(true);
  });

  it("⭐ read-only scope blocks writes but permits reads", () => {
    expect(evaluateOperation("contacts:update", "read_only").allowed).toBe(false);
    expect(evaluateOperation("contacts:update", "read_only").rule).toBe("read_only_scope");
    expect(evaluateOperation("contacts:read", "read_only").allowed).toBe(true);
    expect(evaluateOperation("invoices:list", "read_only").allowed).toBe(true);
  });

  it("⭐ the write classifier FAILS CLOSED on an unrecognised verb", () => {
    // A verb added next year is refused under break-glass until somebody
    // classifies it. The alternative default silently admits it.
    expect(isWriteOperation("contacts:frobnicate")).toBe(true);
    expect(isWriteOperation("something:entirely_new")).toBe(true);
    expect(isWriteOperation("contacts:read")).toBe(false);
    expect(isWriteOperation("contacts:read_many")).toBe(false);
  });

  it("nothing is blocked when nobody is impersonating", () => {
    // The gate is safe to call unconditionally at the top of any action.
    expect(evaluateOperation("delete:everything", null).allowed).toBe(true);
    expect(evaluateOperation("delete:everything", null).rule).toBe("not_impersonating");
  });
});

/* ================================================================== */
/* 3. WHAT PLATFORM STAFF MAY SEARCH                                   */
/* ================================================================== */

describe("cross-tenant search bounds", () => {
  it("⭐ no scope exposes customer content", () => {
    // The line: platform records yes, the workspace's own records never.
    // If a scope named `contacts` ever appears here, that is a change to
    // the product's data-protection posture and belongs in a review.
    expect(SEARCH_SCOPES).not.toContain("contacts");
    expect(SEARCH_SCOPES).not.toContain("companies");
    expect(SEARCH_SCOPES).not.toContain("deals");
    expect(SEARCH_SCOPES).not.toContain("documents");
  });

  it("⭐ the document scope is by IDENTIFIER only and says so", () => {
    const def = SCOPE_DEFINITIONS.documents_by_id;
    expect(def.match).toBe("exact");
    expect(def.returns).toMatch(/NEVER the filename/i);
  });

  it("a wildcard-only query is refused on every scope", () => {
    for (const scope of SEARCH_SCOPES) {
      for (const q of ["%", "%%", "***", "   ", "@"]) {
        expect(validateQuery(q, scope).ok, `${q} on ${scope}`).toBe(false);
      }
    }
  });

  it("short queries are refused, per scope", () => {
    expect(validateQuery("a", "tenants").ok).toBe(false);
    expect(validateQuery("ab", "workspace_users").ok).toBe(false);
    expect(validateQuery("abc", "workspace_users").ok).toBe(true);
  });

  it("results are capped and the cap is small enough not to be an export", () => {
    expect(MAX_RESULTS).toBeLessThanOrEqual(50);
  });

  it("⭐ the search term is MASKED before it is logged", () => {
    // Logging search terms verbatim across thousands of rows builds a
    // second, unbounded copy of customer identities inside a table
    // retained for years and exported to a SIEM.
    const masked = maskSearchTerm("priya.menon@acme.example");
    expect(masked).not.toContain("priya.menon");
    expect(masked).toContain("@acme.example");
    expect(maskSearchTerm("Acme Holdings")).not.toContain("Holdings");
  });

  it("scopes returning personal data are labelled as such", () => {
    expect(SCOPE_DEFINITIONS.workspace_users.containsPersonalData).toBe(true);
    expect(SCOPE_DEFINITIONS.tenants.containsPersonalData).toBe(false);
  });
});

/* ================================================================== */
/* 4. SCHEMAS DEMAND A JUSTIFICATION                                   */
/* ================================================================== */

describe("every dangerous input carries a written reason", () => {
  it("⭐ impersonation refuses a short justification", () => {
    const result = startImpersonationSchema.safeParse({
      tenantId: "3f1c0f7e-9b2a-4d5e-8c6b-1a2b3c4d5e6f",
      mode: "break_glass",
      justification: "debug",
      confirmSlug: "acme",
    });
    expect(result.success).toBe(false);
  });

  it("impersonation accepts a real one", () => {
    const result = startImpersonationSchema.safeParse({
      tenantId: "3f1c0f7e-9b2a-4d5e-8c6b-1a2b3c4d5e6f",
      mode: "break_glass",
      justification: "ZD-4471 workspace will not load and nobody is answering",
      confirmSlug: "acme",
    });
    expect(result.success).toBe(true);
  });

  it("the justification minimum is above `withPlatformScope()`'s floor", () => {
    // withPlatformScope refuses under 10 characters. That floor catches an
    // empty string; this one catches "test".
    expect(MIN_JUSTIFICATION_LENGTH).toBeGreaterThan(10);
  });

  it("suspension requires the typed slug AND a reason", () => {
    expect(
      suspendTenantSchema.safeParse({
        tenantId: "3f1c0f7e-9b2a-4d5e-8c6b-1a2b3c4d5e6f",
        confirmSlug: "",
        reason: "abuse reported by three separate customers this week",
      }).success,
    ).toBe(false);
  });

  it("⭐ there is no `deleteData` option anywhere in the suspension schema", () => {
    // Suspension is a switch. Nothing in this phase deletes a customer's
    // data, and the schema is the place that has to be true.
    const shape = Object.keys(suspendTenantSchema.shape);
    expect(shape).not.toContain("deleteData");
    expect(shape).not.toContain("purge");
    expect(shape).toContain("reason");
  });

  it("search refuses an unknown scope", () => {
    expect(
      platformSearchSchema.safeParse({
        scope: "contacts",
        query: "priya",
        justification: "ZD-1 customer asked about a record",
      }).success,
    ).toBe(false);
  });
});

/* ================================================================== */
/* 5. FEATURE FLAGS ARE NOT PRICING                                    */
/* ================================================================== */

describe("tenant feature flags", () => {
  it("⭐ a flag that grants a paid capability REQUIRES an end date", () => {
    // Otherwise the price list quietly moves into a table with no invoice
    // attached to it, and the first person to notice is whoever runs the
    // renewal.
    expect(validateFlagExpiry("beta.ai_assistant", null)).toMatch(/end date/i);
    expect(
      validateFlagExpiry("beta.ai_assistant", new Date(Date.now() + 86_400_000)),
    ).toBeNull();
  });

  it("a kill switch does NOT require an end date", () => {
    // The moment you most need to disable something is the moment a form
    // refusing you is most expensive.
    expect(validateFlagExpiry("killswitch.telemetry", null)).toBeNull();
  });

  it("an expiry in the past is refused", () => {
    expect(
      validateFlagExpiry("killswitch.telemetry", new Date(Date.now() - 1000)),
    ).toMatch(/past/i);
  });

  it("⭐ unknown flag keys fail closed", () => {
    expect(isFlagKey("beta.whatever_i_typed")).toBe(false);
    expect(validateFlagExpiry("beta.whatever_i_typed", null)).toMatch(/unknown/i);
  });

  it("every flag declares whether it grants paid capability", () => {
    for (const key of FLAG_KEYS) {
      expect(typeof FLAG_CATALOG[key].grantsPaidCapability).toBe("boolean");
      expect(FLAG_CATALOG[key].description.length).toBeGreaterThan(20);
    }
  });
});

/* ================================================================== */
/* 6. HEALTH IS TRIAGE, NOT ANALYTICS                                  */
/* ================================================================== */

describe("tenant health", () => {
  const base = {
    tenantStatus: "active",
    planTier: "advanced" as const,
    subscriptionStatus: "active",
    trialEndsAt: null,
    seatsInUse: 3,
    seatLimit: 10,
    storageUsedMb: 100,
    storageLimitMb: 1024,
    lastActivityAt: new Date(NOW.getTime() - 3_600_000),
    failedPaymentCount: 0,
    now: NOW,
  };

  it("a healthy workspace is healthy and says nothing", () => {
    const verdict = evaluateHealth(base);
    expect(verdict.level).toBe("healthy");
    expect(verdict.signals).toHaveLength(0);
  });

  it("⭐ administrative suspension OUTRANKS a perfect billing state", () => {
    // Mirrors `evaluateAccess()`. A console that showed a suspended
    // workspace as healthy would send an operator looking for a problem
    // that is not there — or reassure them about one they just created.
    const verdict = evaluateHealth({ ...base, tenantStatus: "suspended" });
    expect(verdict.level).toBe("suspended");
    expect(verdict.score).toBe(0);
    expect(verdict.headline).toMatch(/exportable/i);
  });

  it("dunning and dormancy both pull a workspace down", () => {
    expect(evaluateHealth({ ...base, subscriptionStatus: "unpaid" }).level).not.toBe(
      "healthy",
    );
    expect(evaluateHealth({ ...base, lastActivityAt: null }).level).not.toBe("healthy");
  });

  it("the score is always bounded to 0..100", () => {
    const worst = evaluateHealth({
      ...base,
      subscriptionStatus: "unpaid",
      lastActivityAt: null,
      seatsInUse: 10,
      storageUsedMb: 1024,
      failedPaymentCount: 4,
    });
    expect(worst.score).toBeGreaterThanOrEqual(0);
    expect(worst.score).toBeLessThanOrEqual(100);
  });

  it("every level has a label", () => {
    for (const level of ["healthy", "watch", "at_risk", "suspended"] as const) {
      expect(HEALTH_LABELS[level]).toBeTruthy();
    }
  });

  it("storage is rounded DOWN so the console never overstates free space", () => {
    expect(formatStorage(2047)).toBe("1.9 GB");
    expect(formatStorage(512)).toBe("512 MB");
  });

  it("relative time reads naturally in both directions", () => {
    expect(relativeTime(new Date(NOW.getTime() - 2 * 86_400_000), NOW)).toBe("2 days ago");
    expect(relativeTime(new Date(NOW.getTime() + 3_600_000), NOW)).toBe("in 1 hour");
    expect(relativeTime(null, NOW)).toBe("never");
  });
});

/* ================================================================== */
/* 7. THE BANNER CANNOT BE MISREAD                                     */
/* ================================================================== */

describe("the impersonation banner", () => {
  const props = {
    tenantName: "Acme Holdings",
    tenantSlug: "acme",
    scope: "read_write",
    mode: "standing_consent",
    minutesLeft: 42,
    expiresAt: new Date(Date.now() + 42 * 60_000).toISOString(),
  };

  it("⭐ names the workspace, so two open tabs cannot be confused", () => {
    render(<ImpersonationBanner {...props} />);
    expect(screen.getByText("Acme Holdings")).toBeInTheDocument();
    expect(screen.getByText("acme")).toBeInTheDocument();
  });

  it("⭐ states the scope in words", () => {
    render(<ImpersonationBanner {...props} />);
    expect(screen.getByText("Read and write")).toBeInTheDocument();
  });

  it("⭐ break-glass is visually and textually distinct, and says READ ONLY", () => {
    render(<ImpersonationBanner {...props} mode="break_glass" scope="read_only" />);
    expect(screen.getByText(/break-glass access/i)).toBeInTheDocument();
    expect(screen.getByText("Read only")).toBeInTheDocument();
    expect(screen.getByText(/no consent was recorded/i)).toBeInTheDocument();
  });

  it("⭐⭐ has NO dismiss control", () => {
    // A banner that can be dismissed is a banner that is dismissed on day
    // two and never seen again. The only button is "End session", which
    // ends the access rather than hiding it.
    render(<ImpersonationBanner {...props} onEnd={() => {}} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveTextContent(/end session/i);
    for (const label of [/dismiss/i, /close/i, /hide/i, /got it/i]) {
      expect(screen.queryByRole("button", { name: label })).toBeNull();
    }
  });

  it("announces itself to assistive technology", () => {
    render(<ImpersonationBanner {...props} />);
    const banner = screen.getByTestId("impersonation-banner");
    expect(banner).toHaveAttribute("role", "alert");
    expect(banner).toHaveAttribute("aria-live", "assertive");
  });

  it("⭐ an already-expired session says so rather than showing time left", () => {
    render(
      <ImpersonationBanner
        {...props}
        minutesLeft={0}
        expiresAt={new Date(Date.now() - 60_000).toISOString()}
      />,
    );
    expect(screen.getByTestId("impersonation-countdown")).toHaveTextContent(/expired/i);
  });

  it("the banner sentence names the tenant, scope and remaining time", () => {
    const line = bannerText({
      tenantName: "Acme Holdings",
      mode: "break_glass",
      scope: "read_only",
      minutesLeft: 9,
    });
    expect(line).toContain("Acme Holdings");
    expect(line).toContain("Read only");
    expect(line).toContain("9 min left");
    expect(line).toMatch(/BREAK-GLASS/);
  });
});

/* ================================================================== */
/* 8. DANGEROUS ACTIONS DEMAND DELIBERATION                            */
/* ================================================================== */

describe("the danger dialog", () => {
  const base = {
    open: true,
    onOpenChange: () => {},
    title: "Suspend Acme Holdings",
    description: "Everyone loses access until it is reactivated.",
    consequences: [
      "NOTHING is deleted.",
      "They can still export all of their data.",
    ],
    confirmValue: "acme",
    actionLabel: "Suspend workspace",
  };

  it("⭐ the action is disabled until the slug is typed EXACTLY", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(<DangerDialog {...base} onConfirm={onConfirm} />);

    const button = screen.getByRole("button", { name: /suspend workspace/i });
    expect(button).toBeDisabled();

    await user.type(screen.getByLabelText(/type the workspace address/i), "acm");
    await user.type(
      screen.getByLabelText(/why are you doing this/i),
      "ZD-8812 repeated abuse reports from three customers",
    );
    expect(button).toBeDisabled();

    await user.type(screen.getByLabelText(/type the workspace address/i), "e");
    expect(button).toBeEnabled();
  });

  it("⭐ the action is disabled until a real justification is written", async () => {
    const user = userEvent.setup();
    render(<DangerDialog {...base} onConfirm={vi.fn()} />);

    await user.type(screen.getByLabelText(/type the workspace address/i), "acme");
    await user.type(screen.getByLabelText(/why are you doing this/i), "spam");

    expect(screen.getByRole("button", { name: /suspend workspace/i })).toBeDisabled();
  });

  it("⭐ states what does NOT happen, not only what does", () => {
    // An operator who does not know that suspension deletes nothing will
    // not be able to say so to the customer on the phone.
    render(<DangerDialog {...base} onConfirm={vi.fn()} />);
    expect(screen.getByText(/NOTHING is deleted/)).toBeInTheDocument();
    expect(screen.getByText(/export all of their data/i)).toBeInTheDocument();
  });

  it("passes the typed values through on confirm", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(<DangerDialog {...base} onConfirm={onConfirm} />);

    await user.type(screen.getByLabelText(/type the workspace address/i), "acme");
    await user.type(
      screen.getByLabelText(/why are you doing this/i),
      "ZD-8812 repeated abuse reports from three customers",
    );
    await user.click(screen.getByRole("button", { name: /suspend workspace/i }));

    expect(onConfirm).toHaveBeenCalledWith({
      confirmValue: "acme",
      justification: "ZD-8812 repeated abuse reports from three customers",
    });
  });
});

/* ================================================================== */
/* 9. THE DIRECTORY SHOWS WHO IS INSIDE A WORKSPACE                    */
/* ================================================================== */

describe("the tenant directory", () => {
  const row = {
    id: "3f1c0f7e-9b2a-4d5e-8c6b-1a2b3c4d5e6f",
    slug: "acme",
    name: "Acme Holdings",
    status: "active",
    planTier: "advanced",
    subscriptionStatus: "active",
    seatsInUse: 7,
    seatLimit: 10,
    storageUsedMb: 200,
    storageLimitMb: 1024,
    lastActivityAt: new Date(NOW.getTime() - 3_600_000).toISOString(),
    health: { level: "healthy" as const, score: 100, headline: "Nothing needs attention." },
    impersonationLive: false,
  };

  it("⭐ marks a workspace that platform staff are inside RIGHT NOW", () => {
    // "Is one of us in a customer's workspace?" should be answerable at a
    // glance, not by running a query. Putting it in the directory makes
    // it a normal thing to notice rather than an investigation.
    render(<TenantTable rows={[{ ...row, impersonationLive: true }]} now={NOW} />);
    expect(screen.getByTestId("live-impersonation-marker")).toBeInTheDocument();
    expect(screen.getByText(/in session/i)).toBeInTheDocument();
  });

  it("shows no marker when nobody is inside", () => {
    render(<TenantTable rows={[row]} now={NOW} />);
    expect(screen.queryByTestId("live-impersonation-marker")).toBeNull();
  });

  it("⭐ shows no customer content — only relationship metadata", () => {
    const { container } = render(<TenantTable rows={[row]} now={NOW} />);
    const text = container.textContent ?? "";
    expect(text).toContain("Acme Holdings");
    expect(text).toContain("advanced");
    expect(text).toContain("7/10");
    // Nothing resembling a record from inside the workspace.
    expect(text).not.toMatch(/contact|deal|invoice number/i);
  });

  it("an empty directory says so rather than rendering an empty table", () => {
    render(<TenantTable rows={[]} now={NOW} />);
    expect(screen.getByText(/no workspaces match/i)).toBeInTheDocument();
  });
});
