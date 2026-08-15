/**
 * Ordence — ⭐⭐⭐ THE FOUR-EYES CONTROL THAT COULD NOT RUN
 * Version: v1.31.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THREE INDEPENDENT FAILURES, EACH SUFFICIENT ON ITS OWN
 * ══════════════════════════════════════════════════════════════════════
 * ① `countActiveOperators` ran `SELECT count(*) FROM platform_staff
 *    WHERE is_active`. There is no `is_active` column and never has
 *    been. `getApprovalQueue` and `decideRequest` both call it FIRST, so
 *    the approvals screen rendered an error card and no request could
 *    ever be approved or rejected.
 *
 * ② `requestSuspend` had ZERO CALLERS. The console wired its suspend
 *    button straight to `suspendTenantImpl`, so the queue table stayed
 *    empty forever while the approvals screen listed six policies as
 *    though they were enforced.
 *
 * ③ The reject branch ran ABOVE `mayApprove` and tested nothing — not
 *    status, not grade. Its caller is gated on `tenants:read`, which
 *    `support` holds.
 *
 * ⚠️ THE SELF-APPROVAL CONTROL WAS NEVER THE WEAK PART. It is checked in
 * pure code and again by `CHECK (approver_id <> requested_by OR
 * self_approved)`. It is the one thing here a psql session could not
 * walk around, and it guarded a mechanism that could not start.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  mayApprove,
  mayReject,
  APPROVAL_POLICIES,
  POLICY_BY_KIND,
  SELF_APPROVAL_WAIT_MINUTES,
} from "@/lib/platform/approvals";
import { STEP_UP_CAPABILITIES } from "@/lib/platform/roles";
import {
  isFlagKey,
  isEntitlementFlagKey,
  flagDefinitionFor,
  validateFlagExpiry,
} from "@/lib/platform/flags-catalog";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const NOW = new Date("2026-08-15T10:00:00Z");
const REQUESTER = "11111111-1111-1111-1111-111111111111";
const SECOND = "22222222-2222-2222-2222-222222222222";

/* ================================================================== */
/* ① THE QUERY THAT THREW                                              */
/* ================================================================== */

describe("the operator count", () => {
  /**
   * 🔴 A COLUMN THAT DOES NOT EXIST. `platform_staff` carries `status`,
   * `expires_at` and `revoked_at`.
   */
  it("does not ask for is_active", () => {
    /**
     * ⚠️ THE COMMENT ABOVE THE QUERY QUOTES THE OLD COLUMN NAME, on
     * purpose, so the next person knows what went wrong. A naive
     * `expect(src).not.toContain("is_active")` therefore fails on the
     * explanation rather than on the code — which is exactly the
     * mistake `purchase-posting.test.ts` made twice. Assert on the SQL,
     * not on the file.
     */
    const src = read("server/platform/approvals.ts");
    const statements = [...src.matchAll(/db\.execute\(sql`([\s\S]*?)`\)/g)].map(
      (m) => m[1],
    );
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(statement).not.toMatch(/\bis_active\b/);
    }
  });

  /**
   * ⚠️ ALL THREE COLUMNS TOGETHER. A row that is `active` with an expiry
   * in the past is not somebody you can ask to approve anything, so
   * counting on `status` alone would re-open the self-approval hatch at
   * exactly the wrong moment — or, worse, hold it shut against a sole
   * operator who is genuinely alone.
   */
  it("counts only grants that could actually be used", () => {
    const src = read("server/platform/approvals.ts");
    expect(src).toContain("status = 'active'");
    expect(src).toContain("revoked_at IS NULL");
    expect(src).toContain("expires_at IS NULL OR expires_at > now()");
  });

  it("names the schema columns that exist", () => {
    const schema = read("db/schema/platform.ts");
    expect(schema).toContain('platformStaffStatusEnum("status")');
    expect(schema).toContain('timestamp("expires_at"');
    expect(schema).not.toMatch(/boolean\("is_active"\)/);
  });
});

/* ================================================================== */
/* ② SUSPENSION GOES THROUGH THE QUEUE                                 */
/* ================================================================== */

describe("the suspend button", () => {
  /**
   * 🔴 THE BUTTON CALLED THE IMMEDIATE PATH. One owner, one click, a
   * live workspace dark — while `APPROVAL_POLICIES` said `tenant.suspend`
   * needed a second pair of eyes.
   */
  it("routes through requestSuspend, not through suspendTenant", () => {
    const actions = read("server/platform/actions.ts");
    expect(actions).toContain("await requestSuspend({");
    expect(actions).not.toContain("suspendTenant as suspendTenantImpl");
    expect(actions).not.toContain("await suspendTenantImpl(");
  });

  /**
   * ⚠️ `requestSuspend` MUST STILL HAVE A CALLER. This is the assertion
   * that would have caught the original defect: the function existed,
   * was correct, and nothing in the repository called it.
   */
  it("means requestSuspend is reachable from the console", () => {
    const actions = read("server/platform/actions.ts");
    // ⚠️ PINS THE IMPORT, NOT THE IMPORT LINE. The first version pinned
    // the exact single-specifier string and broke the moment
    // `requestTermination` joined the same import, which is the queue
    // GAINING a caller, the opposite of the defect this guards. Match the
    // specifier inside whatever the braces hold.
    expect(actions).toMatch(
      /import\s*\{[^}]*\brequestSuspend\b[^}]*\}\s*from\s*"\.\/control-actions"/,
    );
    const page = read("app/platform/tenants/[id]/page.tsx");
    expect(page).toContain("onSuspend={suspendTenantAction}");
  });

  /**
   * ⭐ THE OPERATOR IS TOLD WHAT ACTUALLY HAPPENS. The dialog used to
   * promise "They can still sign in, reach billing, and export all of
   * their data", which is false: `requireTenantContext` refuses any
   * workspace that is not `active` or `pending`, before the billing
   * gate, and `/settings/billing` is inside the same layout.
   *
   * ⚠️ The lockout itself is a separate batch — it opens a door that is
   * currently shut. Until then the copy tells the truth.
   */
  it("no longer promises a suspended customer can reach billing", () => {
    const dialog = read("components/platform/tenant-actions.tsx");
    expect(dialog).not.toContain(
      "They can still sign in, reach billing, and export all of their data.",
    );
    expect(dialog).toContain("FULL lockout");
    expect(dialog).toContain("Send for approval");
  });

  /** And the code it describes still behaves that way, so the copy is current. */
  it("matches what requireTenantContext actually does", () => {
    const ctx = read("server/tenant-context.ts");
    expect(ctx).toContain(
      'tenantRow.status !== "active" && tenantRow.status !== "pending"',
    );
  });
});

/* ================================================================== */
/* ③ REJECTION IS A DECISION, NOT A FREE ACTION                        */
/* ================================================================== */

describe("mayReject", () => {
  const base = {
    kind: "tenant.suspend",
    requestedBy: REQUESTER,
    approverId: SECOND,
    approverGrade: "owner" as const,
    status: "pending",
  };

  it("lets a second operator of sufficient grade reject a pending request", () => {
    const v = mayReject(base);
    expect(v.allowed).toBe(true);
    expect(v.allowed && v.withdrawal).toBe(false);
  });

  /**
   * 🔴 THE DENIAL OF CONTROL. `decideRequest` is gated on
   * `tenants:read`, which `support` holds — the grade the code itself
   * calls the most likely to be phished. A stolen support account could
   * clear an owner's entire queue during an incident.
   */
  it("refuses a grade below the policy's approver grade", () => {
    const v = mayReject({ ...base, approverGrade: "support" });
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.reason).toContain("owner");
  });

  it("refuses engineer grade on an owner-grade policy", () => {
    const v = mayReject({ ...base, approverGrade: "engineer" });
    expect(v.allowed).toBe(false);
  });

  /**
   * 🔴 THE RECORD OF WHO AUTHORISED WHAT RAN. An `executed` row could be
   * flipped to `rejected`, overwriting `approver_id`, `decided_at` and
   * `decision_note` — destroying, from the console, the only evidence
   * that a suspension which actually happened was authorised by anyone.
   */
  it("refuses to rewrite a request that has already been decided", () => {
    for (const status of ["approved", "rejected", "executed", "failed", "expired"]) {
      const v = mayReject({ ...base, status });
      expect(v.allowed, status).toBe(false);
      expect(v.allowed === false && v.reason, status).toContain(status);
    }
  });

  /**
   * ⚠️ WITHDRAWAL IS NOT REJECTION, and it is not a lower bar — it is a
   * different act. Pulling your own unapproved request takes nothing
   * from anybody, so any grade may do it, and it leaves `approver_id`
   * NULL so it never reads as a second operator having refused.
   *
   * ⭐ It is also what stops `platform_approval_not_self` raising an
   * unhandled Postgres error, which is how self-rejection surfaced
   * before: as a 500.
   */
  it("treats the requester's own rejection as a withdrawal, at any grade", () => {
    for (const grade of ["support", "engineer", "owner"] as const) {
      const v = mayReject({
        ...base,
        approverId: REQUESTER,
        approverGrade: grade,
      });
      expect(v.allowed, grade).toBe(true);
      expect(v.allowed && v.withdrawal, grade).toBe(true);
    }
  });

  it("still refuses a withdrawal of something already decided", () => {
    const v = mayReject({ ...base, approverId: REQUESTER, status: "executed" });
    expect(v.allowed).toBe(false);
  });

  it("refuses a kind that does not go through the queue", () => {
    const v = mayReject({ ...base, kind: "tenant.repaint" });
    expect(v.allowed).toBe(false);
  });

  /** The server must actually consult it, and before it writes. */
  it("is consulted by the server before the row is touched", () => {
    const src = read("server/platform/approvals.ts");
    const verdictAt = src.indexOf("const rejection = mayReject({");
    const writeAt = src.indexOf('status: "rejected",');
    expect(verdictAt).toBeGreaterThan(-1);
    expect(verdictAt).toBeLessThan(writeAt);
    expect(src).toContain("if (!rejection.allowed) return { ok: false, error: rejection.reason };");
    expect(src).toContain("approverId: rejection.withdrawal ? null : args.approver.staff.id");
  });
});

/* ================================================================== */
/* ④ THE SELF-APPROVAL HATCH STILL BEHAVES                             */
/* ================================================================== */

describe("self-approval, unchanged and still narrow", () => {
  const base = {
    kind: "tenant.suspend",
    requestedBy: REQUESTER,
    requestedAt: new Date(NOW.getTime() - 60 * 60_000),
    approverId: REQUESTER,
    approverGrade: "owner" as const,
    status: "pending",
    expiresAt: new Date(NOW.getTime() + 60 * 60_000),
    now: NOW,
  };

  it("closes the moment there is somebody else to ask", () => {
    const v = mayApprove({ ...base, soleOperator: false });
    expect(v.allowed).toBe(false);
  });

  it("opens for a sole operator after the wait", () => {
    const v = mayApprove({ ...base, soleOperator: true });
    expect(v.allowed).toBe(true);
    expect(v.allowed && v.selfApproved).toBe(true);
  });

  it("holds the sole operator to the waiting period", () => {
    const v = mayApprove({
      ...base,
      soleOperator: true,
      requestedAt: new Date(NOW.getTime() - (SELF_APPROVAL_WAIT_MINUTES - 1) * 60_000),
    });
    expect(v.allowed).toBe(false);
  });

  /** ⚠️ Expiry is decided before grade, so a stale request says so. */
  it("reports expiry rather than permission on a stale request", () => {
    const v = mayApprove({
      ...base,
      soleOperator: true,
      approverGrade: "support",
      expiresAt: new Date(NOW.getTime() - 60_000),
    });
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.reason).toContain("expired");
  });
});

/* ================================================================== */
/* ⑤ THE ENTITLEMENT OVERRIDE THAT COULD NEVER SUCCEED                 */
/* ================================================================== */

describe("entitlement overrides", () => {
  /**
   * 🔴 TWO BUGS IN ONE CALL. `applyEntitlementChange` passed `key:` to a
   * schema whose field is `flagKey`, with a value `entitlement:<feature>`
   * that was not in the seven-key flag enum. Every override and every
   * revert returned "Check the form." with no field to fix, and the
   * `platform_entitlement_history` table, its verify-on-fresh-read and
   * its undo path were all unreachable.
   */
  it("passes the field the schema actually declares", () => {
    const src = read("server/platform/control-actions.ts");
    expect(src).not.toContain("key: flagKey,");
    expect(src).not.toContain("key: row.flagKey,");
    expect(src).toContain("flagKey,");
    expect(src).toContain("flagKey: row.flagKey,");
  });

  it("accepts the entitlement namespace and nothing else invented", () => {
    expect(isFlagKey("entitlement:crm.contacts")).toBe(true);
    expect(isEntitlementFlagKey("entitlement:crm.contacts")).toBe(true);
    expect(isFlagKey("beta.ai_assistant")).toBe(true);

    expect(isFlagKey("entitlement:")).toBe(false);
    expect(isFlagKey("entitlement:UPPER")).toBe(false);
    expect(isFlagKey("whatever.i.like")).toBe(false);
    expect(isFlagKey("")).toBe(false);
    expect(isFlagKey(null)).toBe(false);
  });

  /**
   * ⚠️ AN ENTITLEMENT GRANTS PAID CAPABILITY AND IS NOT FORCED TO
   * EXPIRE, which is the one way it differs from a `beta.*` flag. Its
   * control is the history row plus the revert path, not a clock — a
   * deal that includes a module indefinitely is a real thing to sell.
   */
  it("describes an entitlement key without a catalogue entry", () => {
    const def = flagDefinitionFor("entitlement:crm.deals");
    expect(def).toBeTruthy();
    expect(def!.grantsPaidCapability).toBe(true);
    expect(def!.isKillSwitch).toBe(false);
    expect(def!.label).toContain("crm.deals");

    expect(validateFlagExpiry("entitlement:crm.deals", null)).toBeNull();
    // A past date is still refused, entitlement or not.
    expect(validateFlagExpiry("entitlement:crm.deals", new Date(2020, 0, 1))).toBeTruthy();
    expect(flagDefinitionFor("not.a.flag")).toBeNull();
  });

  /** The two reason floors disagreed: 10 on the form, 15 downstream. */
  it("asks for a reason long enough to survive the flag schema", () => {
    const src = read("server/platform/control-actions.ts");
    expect(src).toContain("reason: z.string().min(15).max(1000)");
  });
});

/* ================================================================== */
/* ⑥ STAFF GRANTS                                                      */
/* ================================================================== */

describe("platform staff administration", () => {
  /**
   * 🔴 `onConflictDoUpdate` ON `clerk_user_id` MAKES GRANT THE RENEWAL
   * PATH. Without a self check an owner could extend their own grant
   * forever, clear their own `revoked_at` and re-grade themselves, with
   * no second party — which makes the mandatory expiry, whose entire
   * purpose is that a grant ends without anyone choosing to end it,
   * self-serviceable.
   */
  it("refuses to grant or renew your own access", () => {
    const src = read("server/platform/staff.ts");
    expect(src).toContain("clerkUserId === operator.staff.clerkUserId");
    expect(src).toContain("You cannot grant or renew your own platform access");
  });

  /**
   * 🔴 THE CONSOLE IS THE ONLY DOOR BACK IN, and `grantPlatformStaff`
   * needs `staff:manage`, which only `owner` holds. Revoking the last
   * owner locked everybody out permanently; recovery meant a
   * hand-written INSERT against production.
   *
   * ⚠️ SELF-REVOCATION STAYS OPEN while somebody else can still get in.
   * Being unable to kill your own compromised access at 3am is worse.
   */
  it("refuses to revoke the last usable owner", () => {
    const src = read("server/platform/staff.ts");
    expect(src).toContain("This is the last usable owner");
    expect(src).toContain('eq(platformStaff.grade, "owner")');
    expect(src).toContain("ne(platformStaff.id, staffId)");
    expect(src).toContain("isNull(platformStaff.revokedAt)");
  });

  /** The column existed since Phase 17 and nothing ever wrote it. */
  it("writes revoked_by", () => {
    const src = read("server/platform/staff.ts");
    expect(src).toContain("revokedBy: operator.staff.id");
    expect(read("db/schema/platform.ts")).toContain('uuid("revoked_by")');
  });
});

/* ================================================================== */
/* ⑦ STEP-UP                                                           */
/* ================================================================== */

describe("what needs a fresh second factor", () => {
  /**
   * 🔴 PROVISIONING WAS EXEMPT AS "ROUTINE AND REVERSIBLE". It is
   * routine. There is no code path anywhere in this repository that
   * deletes or terminates a tenant, so a workspace minted with a lifted
   * cookie stays minted, on a public hostname, and every piece of
   * platform tooling treats it as a customer.
   */
  it("includes provisioning a workspace", () => {
    expect(STEP_UP_CAPABILITIES).toContain("tenants:provision");
  });

  it("still includes everything it did before", () => {
    for (const cap of [
      "tenants:suspend",
      "impersonate:consented",
      "impersonate:breakglass",
      "staff:manage",
      "flags:write",
      "entitlements:override",
      "tenants:configure",
    ] as const) {
      expect(STEP_UP_CAPABILITIES).toContain(cap);
    }
  });

  /**
   * ⚠️ THE HONEST CAVEAT, LEFT STANDING. Without Clerk's `fva` claim,
   * `recordStepUpAction` records that somebody clicked a button, which
   * an attacker holding the session can also do. The code says so
   * itself. Making `fva` mandatory is a separate batch; this asserts the
   * warning has not been quietly deleted in the meantime.
   */
  it("still says out loud that the degraded path is a speed bump", () => {
    const src = read("server/platform/actions.ts");
    expect(src).toContain("speed bump");
  });
});

/* ================================================================== */
/* ⑧ THE POLICIES MUST NOT CLAIM MORE THAN THEY ENFORCE                */
/* ================================================================== */

describe("the approvals screen and the code agree", () => {
  /**
   * 🔴 A DECORATIVE CONTROL IS WORSE THAN NO CONTROL, because it stops
   * you looking for the real one. Four of six policies still have no
   * request path and no executor: `impersonate.break_glass`,
   * `staff.elevate`, `tenant.plan_change`.
   *
   * ⚠️ THIS TEST DOES NOT PRETEND THEY ARE FIXED. It pins the number
   * that IS wired, so the debt is a failing number rather than a
   * paragraph nobody re-reads. Raise it as each one is connected.
   *
   * ⭐ RAISED ONCE, HERE: `tenant.terminate` now has both a request path
   * (`requestTermination`) and an executor, so it moved out of the
   * unwired list. That is this pin working as designed, and the reason
   * it names sets rather than counts, a count would have gone 1 → 2 with
   * no evidence of WHICH one landed.
   */
  it("wires exactly the policies this version claims to wire", () => {
    const src = read("server/platform/control-actions.ts");
    const queued = [...src.matchAll(/kind:\s*"([a-z._]+)"/g)].map((m) => m[1]);
    const executors = [...src.matchAll(/registerApprovalExecutor\(\s*"([a-z._]+)"/g)].map(
      (m) => m[1],
    );

    expect(new Set(queued)).toEqual(new Set(["tenant.suspend", "tenant.terminate"]));
    expect(new Set(executors)).toEqual(
      new Set(["tenant.suspend", "entitlement.override_paid", "tenant.terminate"]),
    );

    const unwired = APPROVAL_POLICIES.map((p) => p.kind).filter(
      (k) => !executors.includes(k),
    );
    expect(unwired.sort()).toEqual(
      ["impersonate.break_glass", "staff.elevate", "tenant.plan_change"].sort(),
    );
  });

  it("every policy still names an approver grade and a reason", () => {
    for (const policy of APPROVAL_POLICIES) {
      expect(POLICY_BY_KIND[policy.kind]).toBe(policy);
      expect(policy.approverGrade).toBeTruthy();
      expect(policy.because.length).toBeGreaterThan(20);
      expect(policy.expiryHours).toBeGreaterThan(0);
    }
  });
});
