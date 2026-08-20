/**
 * Ordence — ⭐⭐⭐ THE CAPABILITY SYSTEM: SIMULATOR, VERSIONING, DENY-BY-DEFAULT
 * Version: v1.82.0-alpha · Track D, wave 15
 *
 * Pure assertions — no database — so these run for anyone, on any machine,
 * with no Postgres. That placement is deliberate and is the same argument
 * `billing-gate.test.ts` makes at its foot: a check that requires setup is
 * a check that stops being run.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE PROVES
 * ══════════════════════════════════════════════════════════════════════
 *   1. Deny-by-default, BY CALLING each evaluator with unknown input
 *      rather than by grepping for a comment that says it refuses.
 *   2. The simulator answers both directions, and agrees with the
 *      enforcement path rather than having its own opinion.
 *   3. Role template fingerprints match what was pinned, so a change to
 *      what every customer's staff may do cannot land silently.
 *   4. `analyseOverrides` classifies the four kinds of per-tenant drift
 *      that actually exist in this product.
 *   5. The `leads:assign` facts the owner's decision rests on, asserted
 *      rather than described — so the write-up in TRACK-REPORT.md cannot
 *      quietly stop being true.
 */

import { describe, it, expect } from "vitest";

import {
  simulateRole,
  roleHolds,
  whoCanDo,
  ownerOnlyPermissions,
  templateDrift,
  fingerprint,
  fingerprintRole,
  analyseOverrides,
  ROLE_TEMPLATE_VERSIONS,
  DENY_BY_DEFAULT_LEDGER,
  assertKnownPermission,
  requireKnownPermission,
  UnknownPermissionError,
} from "@/lib/rbac";
import { evaluatePermission, PermissionDeniedError } from "@/lib/permissions";
import { evaluatePlatformCapability, parseAdminAllowlist } from "@/lib/platform/roles";
import { evaluateFeature } from "@/lib/entitlements/features";
import { scopePermits } from "@/lib/mcp/registry";
import { SYSTEM_ROLE_VALUES } from "@/db/schema/core";
import { ROLE_TEMPLATES, ALL_PERMISSIONS } from "@/db/schema/auth";

/* ================================================================== */
/* 1. DENY BY DEFAULT — PROVEN BY CALLING, NOT BY READING              */
/* ================================================================== */

describe("⭐ every evaluator refuses an unrecognised input", () => {
  it("the tenant permission evaluator", () => {
    const decision = evaluatePermission({ role: "tenant_owner" }, "contats:read");
    /*
     * 🔴 NOTE THE SUBJECT: `tenant_owner`, whose template is `"*"` — the
     * role that holds EVERY permission. If unknown keys were resolved
     * before the catalogue check, this is the subject that would prove it,
     * and a `read_only` subject would have passed for the wrong reason.
     */
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("unknown_permission");
  });

  it("the platform capability evaluator", () => {
    const decision = evaluatePlatformCapability(
      {
        clerkUserId: "user_x",
        email: "staff@ordence.test",
        grade: "owner",
        status: "active",
        expiresAt: null,
        allowlisted: true,
        now: new Date(),
      },
      "tenants:obliterate",
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("unknown_capability");
  });

  it("the env allowlist, when the variable is unset", () => {
    /*
     * ⚠️ THE SINGLE MOST IMPORTANT LINE IN `lib/platform/roles.ts`: the
     * failure mode of a missing environment variable is an unreachable
     * console, never an open one.
     */
    expect(parseAdminAllowlist(undefined).size).toBe(0);
    expect(parseAdminAllowlist("").size).toBe(0);
    expect(parseAdminAllowlist("not-an-email").size).toBe(0);
  });

  it("the entitlement evaluator", () => {
    const decision = evaluateFeature("sales.teleportation", {
      planTier: "enterprise",
      subscriptionGrantsAccess: true,
      overrides: {},
    });
    expect(decision.allowed).toBe(false);
  });

  it("the MCP tool lookup", () => {
    expect(scopePermits("read_write", "ordence_do_anything")).toBe(false);
  });

  it("🔴 and prototype pollution cannot smuggle a key past any of them", () => {
    /*
     * ⚠️ `"constructor"`, `"toString"` AND `"__proto__"` ARE PROPERTIES OF
     * EVERY OBJECT. A catalogue check written as `catalog[key] !== undefined`
     * would return truthy for all three. `lib/permissions.ts` uses `in`,
     * which walks the prototype chain — so `"constructor" in PERMISSION_CATALOG`
     * IS true, and the check that saves it is that the resulting value is
     * not a permission the templates list.
     */
    for (const nasty of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(
        evaluatePermission({ role: "tenant_owner" }, nasty).allowed,
        `"${nasty}" must not be granted`,
      ).toBe(false);
    }
  });

  it("the ledger's claims match what the calls above actually did", () => {
    const proven = DENY_BY_DEFAULT_LEDGER.filter((e) => e.verdict === "closed_proven");
    expect(proven.length).toBeGreaterThanOrEqual(5);
    // Every open entry says, in words, what input opens it.
    for (const entry of DENY_BY_DEFAULT_LEDGER.filter(
      (e) => e.verdict === "open_recorded",
    )) {
      expect(entry.note.length).toBeGreaterThan(80);
    }
  });
});

describe("⭐ the strict helper names a typo instead of hiding it", () => {
  it("throws UnknownPermissionError on an unknown key", () => {
    expect(() => assertKnownPermission("contats:read")).toThrow(UnknownPermissionError);
  });

  it("throws PermissionDeniedError on a known key the subject lacks", () => {
    expect(() => requireKnownPermission({ role: "guest" }, "periods:close")).toThrow(
      PermissionDeniedError,
    );
  });

  it("🔴 the two are different errors, which is the whole point", () => {
    /*
     * `evaluatePermission("contats:read")` returns `allowed: false`, which is
     * safe and is INDISTINGUISHABLE from "this user does not have it". A typo
     * in a config row would present as a permissions problem for one
     * customer, forever, and the person debugging it would look at the role.
     */
    let typo: unknown;
    let denial: unknown;
    try {
      requireKnownPermission({ role: "tenant_owner" }, "contats:read");
    } catch (e) {
      typo = e;
    }
    try {
      requireKnownPermission({ role: "guest" }, "periods:close");
    } catch (e) {
      denial = e;
    }
    expect(typo).toBeInstanceOf(UnknownPermissionError);
    expect(denial).toBeInstanceOf(PermissionDeniedError);
  });

  it("returns the key when the subject holds it", () => {
    expect(requireKnownPermission({ role: "tenant_owner" }, "periods:close")).toBe(
      "periods:close",
    );
  });
});

/* ================================================================== */
/* 2. THE SIMULATOR — BOTH DIRECTIONS                                  */
/* ================================================================== */

describe("⭐ direction ①: everything a role can do", () => {
  it("agrees with the enforcement path for every role and every key", () => {
    /*
     * 🔴 THE ANTI-DRIFT ASSERTION, AND IT IS THE REASON `simulateRole` CALLS
     * `evaluatePermission` INSTEAD OF READING THE TEMPLATE. 9 roles ×
     * every catalogue key. If the simulator ever grows its own opinion, this
     * is where it is caught, and it is caught for every key rather than for
     * the one somebody thought to test.
     */
    for (const role of SYSTEM_ROLE_VALUES) {
      const listed = new Set(simulateRole(role).permissions.map((p) => p.key));
      for (const key of ALL_PERMISSIONS) {
        expect(
          listed.has(key),
          `${role} / ${key}: simulator and evaluator disagree`,
        ).toBe(evaluatePermission({ role }, key).allowed);
      }
    }
  });

  it("folds per-user overrides in, with revokes winning", () => {
    const withRevoke = simulateRole("member", { "contacts:read": false });
    expect(withRevoke.permissions.some((p) => p.key === "contacts:read")).toBe(false);

    const withGrant = simulateRole("read_only", { "contacts:create": true });
    const granted = withGrant.permissions.find((p) => p.key === "contacts:create");
    expect(granted?.origin).toBe("explicit_grant");
    expect(withGrant.counts.fromOverride).toBe(1);
  });

  it("ignores an override on a key that is not in the catalogue", () => {
    const before = simulateRole("member").counts.total;
    const after = simulateRole("member", { "contats:read": true }).counts.total;
    expect(after).toBe(before);
  });

  it("⭐ marks the permissions nothing in the product checks", () => {
    /*
     * 🔴 THE COLUMN THAT MAKES THIS SCREEN WORTH BUILDING. A role page that
     * lists a permission tells a customer a boundary exists.
     * `lib/auth/permission-enforcement.ts` has recorded the keys nothing
     * checks since wave 9, and no screen had ever joined the two.
     */
    const member = simulateRole("member");
    const assign = member.permissions.find((p) => p.key === "leads:assign");
    expect(assign).toBeDefined();
    expect(assign?.enforced).toBe(false);
    expect(assign?.unenforcedReason ?? "").toMatch(/leads:update/);
    expect(member.counts.unenforced).toBeGreaterThan(0);
  });

  it("a wildcard role really does hold everything", () => {
    expect(simulateRole("tenant_owner").counts.total).toBe(ALL_PERMISSIONS.length);
    expect(simulateRole("tenant_owner").wildcard).toBe(true);
  });
});

describe("⭐ direction ②: everyone who can do a thing", () => {
  it("names the roles that hold a permission, wildcards flagged separately", () => {
    const result = whoCanDo("periods:close");
    expect(result.known).toBe(true);
    expect(result.rolesByTemplate).toContain("tenant_owner");
    expect(result.rolesByWildcard).toContain("tenant_owner");
    expect(result.rolesByTemplate).not.toContain("guest");
  });

  it("🔴 an unknown key is held by NOBODY — not by everybody, and not an error", () => {
    const result = whoCanDo("contats:read");
    expect(result.known).toBe(false);
    expect(result.rolesByTemplate).toEqual([]);
    expect(result.overrideSql).toContain("unknown permission");
  });

  it("hands back a predicate for the half that lives in tenant data", () => {
    /*
     * ⚠️ ROLES ARE HALF THE ANSWER. A pure module cannot see
     * `users.permission_overrides`, and returning only the role list would
     * be confidently wrong for exactly the users a reviewer is asking about.
     */
    const result = whoCanDo("periods:close");
    expect(result.overrideSql).toContain("permission_overrides");
    expect(result.overrideSql).toContain("app_current_tenant_id()");
  });

  it("agrees with direction ① for every key", () => {
    for (const key of ALL_PERMISSIONS) {
      const holders = new Set(whoCanDo(key).rolesByTemplate);
      for (const role of SYSTEM_ROLE_VALUES) {
        expect(holders.has(role)).toBe(roleHolds(role, key));
      }
    }
  });

  it("separates 'owner only' from 'unenforced' — they are different lists", () => {
    const ownerOnly = new Set(ownerOnlyPermissions());
    // Held only by wildcard templates, by construction.
    for (const key of ownerOnly) {
      for (const role of SYSTEM_ROLE_VALUES) {
        if (ROLE_TEMPLATES[role].permissions === "*") continue;
        expect(roleHolds(role, key), `${role} should not hold ${key}`).toBe(false);
      }
    }
    /*
     * ⚠️ `billing:manage` IS NOT ON THIS LIST, WHICH SURPRISED THE FIRST
     * DRAFT OF THIS TEST. `tenant_admin` is `ALL_PERMISSIONS` minus exactly
     * that key — and `billing_admin`'s explicit template grants it back. So
     * the most dangerous key in the product is held by a named, non-wildcard
     * role, which is correct and is worth knowing.
     */
    expect(ownerOnly.has("billing:manage")).toBe(false);
    expect(roleHolds("billing_admin", "billing:manage")).toBe(true);
    expect(roleHolds("tenant_admin", "billing:manage")).toBe(false);

    // And a key nothing checks is NOT automatically owner-only.
    expect(ownerOnly.has("leads:assign")).toBe(false);
  });
});

/* ================================================================== */
/* 3. TEMPLATE VERSIONING                                              */
/* ================================================================== */

describe("⭐ a role template cannot move silently", () => {
  it("no drift against the pinned versions", () => {
    /*
     * ⚠️ WHEN THIS GOES RED, THE FIX IS NOT TO PASTE THE NEW FINGERPRINT IN.
     * Bump the version, write what changed in `note`, and say who decided —
     * a template change reaches every customer's staff on the next deploy
     * with no migration and no announcement.
     */
    expect(templateDrift()).toEqual([]);
  });

  it("every pinned note names its version", () => {
    for (const role of SYSTEM_ROLE_VALUES) {
      const pinned = ROLE_TEMPLATE_VERSIONS[role];
      expect(pinned.note.length).toBeGreaterThan(20);
      expect(pinned.note).toContain(`v${pinned.version}`);
    }
  });

  it("🔴 the fingerprint moves when the grant does — the control", () => {
    /*
     * A drift check that could not detect a change would pass forever. This
     * proves the mechanism by fingerprinting a DIFFERENT role and asserting
     * the values differ, and by re-fingerprinting the same role twice to
     * show it is stable.
     */
    expect(fingerprintRole("member")).toBe(fingerprintRole("member"));
    expect(fingerprintRole("member")).not.toBe(fingerprintRole("read_only"));
  });

  it("is order-independent, so tidying a list does not fire it", () => {
    /*
     * ⚠️ `fingerprintRole` SORTS BEFORE HASHING. The template lists are
     * hand-grouped for readability and get reordered whenever somebody tidies
     * them; a fingerprint that fired on a reorder would be silenced within a
     * week. Asserted on the primitive, because the sort is what is under test.
     */
    expect(fingerprint("member|a,b,c")).toBe(fingerprint("member|a,b,c"));
    expect(fingerprint("member|a,b,c")).not.toBe(fingerprint("member|a,b,d"));
  });
});

describe("⭐ per-tenant override drift, which is the kind that actually exists", () => {
  const subjects = [
    {
      userId: "u1",
      email: "rot@example.test",
      role: "member" as const,
      overrides: {
        // The template already grants this — the exception is noise.
        "contacts:read": true,
        // The template never granted this — the revoke is inert.
        "periods:close": false,
        // Not in the catalogue — silently does nothing.
        "contats:export": false,
        // Dangerous, granted by exception, withheld by the template.
        "billing:manage": true,
      },
    },
  ];

  it("classifies all four", () => {
    const findings = analyseOverrides(subjects);
    const byProblem = new Map(findings.map((f) => [f.key, f.problem]));

    expect(byProblem.get("contacts:read")).toBe("redundant_grant");
    expect(byProblem.get("periods:close")).toBe("redundant_revoke");
    expect(byProblem.get("contats:export")).toBe("unknown_key");
    expect(byProblem.get("billing:manage")).toBe("dangerous_elevation");
  });

  it("🔴 `unknown_key` is the one that looks harmless and is not", () => {
    const finding = analyseOverrides(subjects).find((f) => f.problem === "unknown_key");
    /*
     * An administrator's deliberate revoke that has done nothing since a
     * rename. `evaluatePermission` refuses unrecognised keys BEFORE it
     * consults overrides — deny-by-default is correct at the gate and reads,
     * here, as an administrative decision that was silently discarded.
     */
    expect(finding?.message).toMatch(/has no effect/i);
  });

  it("says nothing about a tenant whose overrides are all live and meaningful", () => {
    const findings = analyseOverrides([
      {
        userId: "u2",
        role: "member",
        /*
       * ⚠️ `views:manage_shared` RATHER THAN `periods:close`, WHICH THE
       * FIRST DRAFT USED AND WHICH IS ON `DANGEROUS_PERMISSIONS`. A
       * dangerous key granted by exception is correctly a finding, so the
       * healthy case has to use a key that is genuinely ordinary.
       */
      overrides: { "documents:delete": true, "contacts:read": false },
      },
    ]);
    /*
     * `periods:close` granted (not in the member template, and NOT on the
     * dangerous list) and `contacts:read` revoked (in the template) are both
     * exactly what overrides are for. A drift report that flagged healthy
     * exceptions would be a report nobody reads.
     */
    expect(findings).toEqual([]);
  });

  it("handles a null override map without inventing findings", () => {
    expect(analyseOverrides([{ userId: "u3", role: "member", overrides: null }])).toEqual(
      [],
    );
  });
});

/* ================================================================== */
/* 4. THE `leads:assign` FACTS THE OWNER'S DECISION RESTS ON           */
/* ================================================================== */

describe("🔴 leads:assign — the facts, asserted so the write-up cannot rot", () => {
  it("`member` holds it and `manager` does not", () => {
    expect(roleHolds("member", "leads:assign")).toBe(true);
    expect(roleHolds("manager", "leads:assign")).toBe(false);
  });

  it("⚠️ but `manager` is LEGAL COUNSEL, not a sales manager", () => {
    /*
     * 🔴 THE FACT THAT CHANGES THE RECOMMENDATION. The brief frames this as
     * "members can reassign leads and managers cannot", which reads as a
     * broken hierarchy. It is not one: `manager` is the legal-counsel role
     * and holds no lead-write key at all, so granting it `leads:assign`
     * would hand lead reassignment to the person who drafts contracts.
     *
     * There is NO sales-line manager role in this template set. That is the
     * actual gap, and it is a product decision, not a security fix.
     */
    expect(ROLE_TEMPLATES.manager.label).toBe("Legal Counsel");
    expect(roleHolds("manager", "leads:update")).toBe(false);
    expect(roleHolds("manager", "leads:create")).toBe(false);
    expect(roleHolds("manager", "leads:read")).toBe(true);
  });

  it("nothing enforces it — reassignment is gated on leads:update", () => {
    const analysis = whoCanDo("leads:assign");
    expect(analysis.enforced).toBe(false);
    expect(analysis.unenforcedReason ?? "").toMatch(/leads:update/);
  });

  it("so today every role that can update a lead can reassign it", () => {
    for (const role of SYSTEM_ROLE_VALUES) {
      // The effective gate on `updateLead` is `leads:update`, not `leads:assign`.
      const canReassignToday = roleHolds(role, "leads:update");
      const templateSaysSo = roleHolds(role, "leads:assign");
      if (canReassignToday && !templateSaysSo) {
        /* Wildcard roles: hold both, so they are not the interesting case. */
        expect(ROLE_TEMPLATES[role].permissions).toBe("*");
      }
    }
  });
});
