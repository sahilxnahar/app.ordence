/**
 * Ordence — ⭐⭐⭐ THE PANEL'S OWN CONTROLS
 * Version: v1.22.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ FIVE CONTROLS, AND EVERY ONE OF THEM FAILS SILENTLY IF IT BREAKS
 * ══════════════════════════════════════════════════════════════════════
 * An approval queue that stops refusing self-approval still shows a
 * queue. A preview that starts lying about record counts still shows a
 * preview. A break-glass block that stops blocking still shows a
 * procedure. None of these announce themselves, which is why they need
 * assertions rather than a demo.
 *
 * 🔴 THE REACHABILITY TESTS AT THE BOTTOM ARE THE ONES THAT MATTER MOST.
 * Ordence has shipped a complete engine nothing calls eight times. Every
 * one of those was a session that ended believing the feature was done.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  APPROVAL_POLICIES,
  REQUEST_PATHS,
  MIN_JUSTIFICATION,
  SELF_APPROVAL_WAIT_MINUTES,
  expiryFor,
  gradeAtLeast,
  justificationProblem,
  mayApprove,
  needsApproval,
} from "@/lib/platform/approvals";
import {
  BREAK_GLASS,
  DEBT_GRACE_MINUTES,
  PROCEDURE_STEPS,
  breakGlassBlock,
  breakGlassReasonProblem,
  noteDebts,
  postIncidentNoteProblem,
} from "@/lib/platform/break-glass";
import { previewChange, verifyChange } from "@/lib/platform/entitlement-diff";
import {
  PERSISTENT_SIGNALS,
  TREND_THRESHOLDS,
  assessTrends,
  eventsFor,
  shouldPersist,
} from "@/lib/platform/health-rules";
import { evaluateHealth } from "@/lib/platform/health";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

const NOW = new Date("2026-08-11T10:00:00.000Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

/* ================================================================== */
/* ① THE APPROVAL QUEUE                                                */
/* ================================================================== */

describe("what needs a second pair of eyes", () => {
  it("holds six actions and no more", () => {
    // ⚠️ THE NUMBER IS THE POINT. A queue that grows to sixteen is a
    // queue people learn to rubber-stamp, and a rubber-stamped approval
    // is worse than none because it looks like a control in an audit.
    expect(APPROVAL_POLICIES).toHaveLength(6);
  });

  it("does not hold provisioning or consented impersonation", () => {
    expect(needsApproval("tenant.provision")).toBe(false);
    expect(needsApproval("impersonate.consented")).toBe(false);
    expect(needsApproval("tenant.suspend")).toBe(true);
  });

  it("gives every held action a written reason for being held", () => {
    for (const p of APPROVAL_POLICIES) {
      expect(p.because.length).toBeGreaterThan(40);
      expect(p.expiryHours).toBeGreaterThan(0);
    }
  });

  it("expires break-glass approval fastest of all", () => {
    const hours = Object.fromEntries(
      APPROVAL_POLICIES.map((p) => [p.kind, p.expiryHours]),
    );
    expect(hours["impersonate.break_glass"]).toBeLessThan(hours["tenant.suspend"]!);
  });
});

describe("mayApprove", () => {
  const base = {
    kind: "tenant.suspend",
    requestedBy: "staff-a",
    requestedAt: ago(60),
    approverGrade: "owner" as const,
    status: "pending",
    expiresAt: new Date(NOW.getTime() + 3_600_000),
    now: NOW,
    soleOperator: false,
  };

  it("lets a different owner approve", () => {
    const v = mayApprove({ ...base, approverId: "staff-b" });
    expect(v.allowed).toBe(true);
    expect(v.allowed && v.selfApproved).toBe(false);
  });

  it("refuses self-approval outright when somebody else exists", () => {
    // 🔴 THE HATCH CLOSES THE MOMENT THERE IS SOMEBODY TO ASK. Waiting
    // fifteen minutes must not buy anything here.
    const v = mayApprove({ ...base, approverId: "staff-a", requestedAt: ago(600) });
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.reason).toMatch(/another operator/i);
  });

  it("refuses a sole operator who has not waited", () => {
    const v = mayApprove({
      ...base,
      approverId: "staff-a",
      soleOperator: true,
      requestedAt: ago(SELF_APPROVAL_WAIT_MINUTES - 1),
    });
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.reason).toMatch(/decide twice/i);
  });

  it("allows a sole operator who has waited, and FLAGS it", () => {
    // ⚠️ THE FLAG IS THE CONTROL. Allowing this silently would make the
    // exception indistinguishable from a real second pair of eyes.
    const v = mayApprove({
      ...base,
      approverId: "staff-a",
      soleOperator: true,
      requestedAt: ago(SELF_APPROVAL_WAIT_MINUTES + 1),
    });
    expect(v.allowed).toBe(true);
    expect(v.allowed && v.selfApproved).toBe(true);
  });

  it("says EXPIRED before it says WRONG GRADE", () => {
    // ⚠️ A stale request should tell the operator it is stale rather
    // than sending them to find somebody with a higher grade.
    const v = mayApprove({
      ...base,
      approverId: "staff-b",
      approverGrade: "support",
      expiresAt: ago(10),
    });
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.reason).toMatch(/expired/i);
  });

  it("refuses a request that has already run", () => {
    const v = mayApprove({ ...base, approverId: "staff-b", status: "executed" });
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.reason).toMatch(/twice/i);
  });

  it("ranks grades so support cannot approve an owner action", () => {
    expect(gradeAtLeast("support", "owner")).toBe(false);
    expect(gradeAtLeast("owner", "engineer")).toBe(true);
  });
});

describe("justification", () => {
  it("refuses a word and accepts a sentence", () => {
    expect(justificationProblem("fix")).not.toBeNull();
    expect(justificationProblem("customer asked us to pause billing")).toBeNull();
    expect(MIN_JUSTIFICATION).toBe(20);
  });

  it("puts expiry in the future and uses the policy's own hours", () => {
    const at = expiryFor("tenant.terminate", NOW);
    expect(at.getTime()).toBe(NOW.getTime() + 24 * 3_600_000);
  });
});

/* ================================================================== */
/* ② BREAK-GLASS                                                       */
/* ================================================================== */

describe("the break-glass reason", () => {
  const good =
    "Their invoicing has been failing since 3am, nobody at the company is reachable, and the finance team files GST at nine.";

  it("demands fifty characters, not twenty", () => {
    expect(BREAK_GLASS.minReasonLength).toBe(50);
    expect(breakGlassReasonProblem("urgent, cannot wait", "something else")).not.toBeNull();
    expect(breakGlassReasonProblem(good, "something else entirely")).toBeNull();
  });

  it("refuses the justification pasted twice", () => {
    // ⚠️ Two fields answering one question means the second field added
    // nothing, and the customer's email then contains a ticket note.
    const problem = breakGlassReasonProblem(good, `  ${good.toUpperCase()}  `);
    expect(problem).toMatch(/cannot repeat/i);
  });

  it("refuses a bare ticket reference", () => {
    expect(breakGlassReasonProblem("INC-4471", "x")).not.toBeNull();
    expect(breakGlassReasonProblem("4471", "x")).not.toBeNull();
  });

  it("publishes a procedure with the consequence in it", () => {
    expect(PROCEDURE_STEPS.length).toBeGreaterThanOrEqual(5);
    expect(PROCEDURE_STEPS.join(" ")).toMatch(/cannot break glass again/i);
  });
});

describe("the write-up debt", () => {
  const session = (over: Partial<Parameters<typeof noteDebts>[0][number]> = {}) => ({
    id: "s1",
    tenantName: "Acme",
    startedAt: ago(120),
    endedAt: null,
    expiresAt: ago(105),
    postIncidentNote: null,
    ...over,
  });

  it("owes nothing while the session is still running", () => {
    const debts = noteDebts(
      [session({ expiresAt: new Date(NOW.getTime() + 600_000) })],
      NOW,
    );
    expect(debts).toHaveLength(0);
  });

  it("owes nothing once the note is written", () => {
    expect(noteDebts([session({ postIncidentNote: "written up" })], NOW)).toHaveLength(0);
  });

  it("counts from when the operator got OUT, not when they went in", () => {
    const [debt] = noteDebts([session()], NOW);
    expect(debt!.dueAt.getTime()).toBe(
      ago(105).getTime() + BREAK_GLASS.noteDueHours * 3_600_000,
    );
    expect(debt!.overdue).toBe(false);
  });

  it("marks it overdue after twenty-four hours", () => {
    const [debt] = noteDebts([session({ expiresAt: ago(60 * 30) })], NOW);
    expect(debt!.overdue).toBe(true);
    expect(debt!.hoursLate).toBeGreaterThanOrEqual(5);
  });

  it("does NOT block mid-incident, inside the grace window", () => {
    // ⭐ THE ONE MOMENT THIS CONTROL WOULD DO HARM. An operator who broke
    // glass, found the problem was bigger than one workspace and needs a
    // second one RIGHT NOW must not be stopped to write paperwork.
    const debts = noteDebts([session({ expiresAt: ago(DEBT_GRACE_MINUTES - 5) })], NOW);
    expect(debts).toHaveLength(1);
    expect(breakGlassBlock(debts, NOW)).toBeNull();
  });

  it("blocks once the grace window has passed", () => {
    const debts = noteDebts([session({ expiresAt: ago(DEBT_GRACE_MINUTES + 5) })], NOW);
    const block = breakGlassBlock(debts, NOW);
    expect(block).not.toBeNull();
    expect(block).toMatch(/Acme/);
    // ⚠️ SAYS WHAT IS NOT BLOCKED. An operator who believes support work
    // is blocked too will conclude the control is broken.
    expect(block).toMatch(/Consented support access is not affected/i);
  });

  it("demands a real write-up", () => {
    expect(postIncidentNoteProblem("done")).not.toBeNull();
    expect(
      postIncidentNoteProblem(
        "Looked at the failing invoice queue, found a stuck GST job from the 3am deploy, cleared it and told their finance lead. Adding a health rule so this shows up without break-glass.",
      ),
    ).toBeNull();
  });
});

/* ================================================================== */
/* ③ THE TOGGLE PREVIEW                                                */
/* ================================================================== */

describe("what a toggle actually does", () => {
  const modules = [
    { id: "inventory", label: "Inventory", featureKey: "inv.core", status: "live" as const },
    { id: "stock", label: "Stock", featureKey: "inv.core", status: "live" as const },
    { id: "crm", label: "Contacts", featureKey: "crm.contacts", status: "live" as const },
    { id: "hr", label: "Payroll", featureKey: "hr.payroll", status: "coming_soon" as const },
  ];

  const base = {
    tenantName: "Acme",
    modules,
    planFeatures: ["crm.contacts"],
    recordCounts: {},
    userCount: 12,
  };

  it("moves every module sharing the feature, together", () => {
    const diff = previewChange({ ...base, featureKey: "inv.core", direction: "disable" });
    expect(diff.hides.map((m) => m.id).sort()).toEqual(["inventory", "stock"]);
  });

  it("refuses to enable something that is not built", () => {
    // 🔴 A menu item that goes nowhere puts everything else we told the
    // customer in question.
    const diff = previewChange({ ...base, featureKey: "hr.payroll", direction: "enable" });
    expect(diff.blockers.length).toBeGreaterThan(0);
    expect(diff.blockers.join(" ")).toMatch(/not built yet/i);
  });

  it("blocks a feature key no module is gated by", () => {
    const diff = previewChange({ ...base, featureKey: "nonsense.key", direction: "enable" });
    expect(diff.blockers.join(" ")).toMatch(/No module in Ordence/i);
  });

  it("🔴 does NOT claim there is no data when it has not counted", () => {
    // ⚠️ THE BUG THIS SESSION CAUGHT IN ITS OWN CODE. The caller passed
    // `{}` because counting rows per module is hard, and the preview
    // cheerfully told the operator "there is no data in these modules
    // yet" about a workspace with eighteen hundred stock records.
    const diff = previewChange({ ...base, featureKey: "inv.core", direction: "disable" });
    expect(diff.keepsNote).not.toMatch(/no data in these modules/i);
    expect(diff.keepsNote).toMatch(/has not counted/i);
    expect(diff.keepsNote).toMatch(/Nothing is deleted/i);
  });

  it("gives the number when it genuinely has one", () => {
    const diff = previewChange({
      ...base,
      featureKey: "inv.core",
      direction: "disable",
      recordCounts: { inventory: 1800, stock: 47 },
    });
    expect(diff.keepsNote).toMatch(/1,847/);
    expect(diff.keepsNote).toMatch(/reappears/i);
  });

  it("says nothing becomes hidden only when it counted zero", () => {
    const diff = previewChange({
      ...base,
      featureKey: "inv.core",
      direction: "disable",
      recordCounts: { inventory: 0, stock: 0 },
    });
    expect(diff.keepsNote).toMatch(/no data in these modules/i);
  });

  it("names an override above the plan as the discount it is", () => {
    const diff = previewChange({ ...base, featureKey: "inv.core", direction: "enable" });
    expect(diff.notes.join(" ")).toMatch(/discount/i);
  });

  it("warns when switching off something they pay for", () => {
    const diff = previewChange({
      ...base,
      featureKey: "crm.contacts",
      direction: "disable",
    });
    expect(diff.notes.join(" ")).toMatch(/plan DOES include this/i);
  });
});

describe("verifying the write landed", () => {
  it("treats a missing row as different from off", () => {
    // ⚠️ NULL IS NOT FALSE. Reporting the first as the second sends
    // somebody looking for a write that never happened.
    const v = verifyChange({ expected: false, observed: null, featureKey: "inv.core" });
    expect(v.ok).toBe(false);
    expect(v.note).toMatch(/did not land/i);
  });

  it("refuses to confirm a mismatch", () => {
    const v = verifyChange({ expected: true, observed: false, featureKey: "inv.core" });
    expect(v.ok).toBe(false);
    expect(v.note).toMatch(/Do not tell the customer/i);
  });

  it("confirms a match", () => {
    expect(verifyChange({ expected: true, observed: true, featureKey: "x" }).ok).toBe(true);
  });
});

/* ================================================================== */
/* ④ HEALTH                                                            */
/* ================================================================== */

describe("the three rules a snapshot cannot see", () => {
  const trends = {
    tenantName: "Acme",
    activeUsersLast7: 9,
    activeUsersPrior7: 10,
    errorRate7d: 0.001,
    errorRateBaseline: 0.001,
    connectionsWithNoSyncHours: [],
  };

  it("stays quiet on a healthy workspace", () => {
    expect(assessTrends(trends, NOW)).toHaveLength(0);
  });

  it("catches a collapse in engagement", () => {
    const out = assessTrends({ ...trends, activeUsersLast7: 3 }, NOW);
    expect(out.map((e) => e.ruleKey)).toContain("engagement_collapse");
  });

  it("⚠️ ignores two-people-to-one, which is a 50% drop and means nothing", () => {
    const out = assessTrends(
      { ...trends, activeUsersPrior7: 2, activeUsersLast7: 1 },
      NOW,
    );
    expect(out).toHaveLength(0);
  });

  it("🔴 compares errors to the workspace's OWN normal, not a fixed rate", () => {
    // A busy workspace steady at 2% is healthy. A quiet one moving from
    // 0.1% to 1% is broken. Only the self-comparison sees both.
    const busySteady = assessTrends(
      { ...trends, errorRate7d: 0.02, errorRateBaseline: 0.02 },
      NOW,
    );
    expect(busySteady.map((e) => e.ruleKey)).not.toContain("error_spike");

    const quietSpiking = assessTrends(
      { ...trends, errorRate7d: 0.01, errorRateBaseline: 0.001 },
      NOW,
    );
    expect(quietSpiking.map((e) => e.ruleKey)).toContain("error_spike");
  });

  it("ignores a spike below the floor, so three errors are not an alert", () => {
    const out = assessTrends(
      { ...trends, errorRate7d: 0.004, errorRateBaseline: 0.0001 },
      NOW,
    );
    expect(out.map((e) => e.ruleKey)).not.toContain("error_spike");
    expect(TREND_THRESHOLDS.errorSpikeFloor).toBeGreaterThan(0);
  });

  it("catches an integration that has gone quiet", () => {
    const out = assessTrends(
      {
        ...trends,
        connectionsWithNoSyncHours: [
          { name: "IndiaMART", hours: 71 },
          { name: "JustDial", hours: 4 },
        ],
      },
      NOW,
    );
    const dark = out.find((e) => e.ruleKey === "integration_dark");
    expect(dark).toBeDefined();
    expect(dark!.headline).toMatch(/IndiaMART/);
    // ⚠️ The four-hour one must not be reported. Reporting healthy
    // connections is how the rule gets ignored.
    expect(dark!.headline).not.toMatch(/JustDial/);
  });

  it("gives every event a next step, not just a colour", () => {
    const out = assessTrends({ ...trends, activeUsersLast7: 1 }, NOW);
    for (const e of out) expect(e.whatToDo.length).toBeGreaterThan(40);
  });
});

describe("which snapshot signals become something to close", () => {
  it("promotes the ones that need a phone call", () => {
    expect(shouldPersist({ key: "never_used", label: "x", severity: "risk" })).toBe("high");
    expect(shouldPersist({ key: "unpaid", label: "x", severity: "risk" })).toBe("high");
  });

  it("⚠️ does NOT promote pressure, which resolves itself", () => {
    // Burying two rules that need a call under paperwork about workspaces
    // doing well is how both get ignored.
    expect(shouldPersist({ key: "seat_pressure", label: "x", severity: "info" })).toBeNull();
    expect(
      shouldPersist({ key: "storage_pressure", label: "x", severity: "info" }),
    ).toBeNull();
    expect(Object.keys(PERSISTENT_SIGNALS)).not.toContain("seat_pressure");
  });

  it("wraps the existing engine rather than restating it", () => {
    // 🔴 `evaluateHealth` is the source. Two engines evaluating
    // overlapping rules is the two-sources-of-truth failure half this
    // codebase's comments are about.
    const verdict = evaluateHealth({
      tenantStatus: "active",
      planTier: "basic",
      subscriptionStatus: "active",
      trialEndsAt: null,
      seatsInUse: 1,
      seatLimit: 10,
      storageUsedMb: 1,
      storageLimitMb: 1000,
      lastActivityAt: null,
      failedPaymentCount: 0,
      now: NOW,
    });
    expect(verdict.signals.map((s) => s.key)).toContain("never_used");

    const events = eventsFor({
      verdict,
      trends: {
        tenantName: "Acme",
        activeUsersLast7: 0,
        activeUsersPrior7: 0,
        errorRate7d: 0,
        errorRateBaseline: 0,
        connectionsWithNoSyncHours: [],
      },
      now: NOW,
    });
    expect(events.map((e) => e.ruleKey)).toContain("never_used");
  });
});

/* ================================================================== */
/* ⑤ REACHABILITY — THE TESTS THAT MATTER MOST                         */
/* ================================================================== */

describe("🔴 everything built this session is actually reachable", () => {
  const controlActions = read("server/platform/control-actions.ts");
  const layout = read("app/platform/layout.tsx");

  /**
   * ⚠️ THE NAV IS NO LONGER A LITERAL IN THE LAYOUT. It was moved into
   * `lib/platform/console-paths.ts` so a client component (the command
   * palette) could share the one mapping — `console-href.ts` reads
   * `headers()` and cannot be imported from a `"use client"` file.
   *
   * ⭐ SO THE ASSERTION IS "THE CONSOLE OFFERS A WAY TO THIS SCREEN",
   * which is what it always meant, rather than "this string appears in
   * this file", which is what it happened to check. The layout must
   * still render whatever registry holds it.
   */
  const navSource = read("lib/platform/console-paths.ts");
  const expectNavOffers = (href: string) => {
    expect(navSource, href).toContain(href);
    expect(layout).toContain("CONSOLE_NAV");
  };

  it("the approval queue has a screen, and the screen calls the action", () => {
    const page = read("app/platform/approvals/page.tsx");
    expect(page).toContain("getApprovalQueue(");
    expect(page).toContain("decideRequest");
    expectNavOffers("/platform/approvals");
  });

  it("the health screen calls the reader, and the reader calls the SWEEP", () => {
    // ⚠️ MEASURED AS A CALL, NOT AN IMPORT. Twice this codebase has
    // shipped a test that asserted a symbol was imported while nothing
    // invoked it.
    const page = read("app/platform/health/page.tsx");
    expect(page).toContain("getOpenHealthEvents(");
    expect(controlActions).toContain("sweepTenantHealth(");
    expectNavOffers("/platform/health");
  });

  it("the incidents screen reaches incidents AND the break-glass ledger", () => {
    const page = read("app/platform/incidents/page.tsx");
    expect(page).toContain("declareIncident");
    expect(page).toContain("getMyBreakGlassDebt");
    expect(page).toContain("writeBreakGlassNote");
    expectNavOffers("/platform/incidents");
  });

  it("⭐ the toggle preview is wired to the switchboard the operator uses", () => {
    const configure = read("app/platform/tenants/[id]/configure/page.tsx");
    expect(configure).toContain("previewEntitlementChange");
    expect(configure).toContain("onPreview=");
    const switchboard = read("components/platform/module-switchboard.tsx");
    expect(switchboard).toContain("loadPreview(row)");
  });

  it("⭐⭐ break-glass calls the debt block BEFORE it opens a session", () => {
    const impersonation = read("server/platform/impersonation.ts");
    expect(impersonation).toContain("breakGlassDebtBlock(");
    expect(impersonation).toContain("breakGlassReasonProblem(");
    expect(impersonation).toContain("alertPlatformOwners(");

    // 🔴 ORDER MATTERS. The block has to come before the insert, or a
    // blocked operator has already read the customer's data by the time
    // they are refused.
    const blockAt = impersonation.indexOf("breakGlassDebtBlock(");
    const insertAt = impersonation.indexOf(".insert(platformImpersonationSessions)");
    expect(blockAt).toBeGreaterThan(0);
    expect(blockAt).toBeLessThan(insertAt);
  });

  /**
   * ⚠️ THE REGISTRATIONS MOVED IN BATCH 43, AND THE ASSERTION FOLLOWED
   * THEM RATHER THAN BEING RELAXED. They live in
   * `server/platform/approval-executors.ts`, which `control-actions.ts`
   * imports for its side effect — along with `flags.ts`,
   * `configuration.ts` and `staff.ts`, which are the three enforcement
   * points that can now queue and are reachable from server actions that
   * never import `control-actions.ts`.
   *
   * ⭐ ASSERTED AS A PROPERTY: every policy with a request path must have
   * an executor. A hard-coded pair of names would have to be edited every
   * time another policy is wired, which is how a pin stops being read.
   */
  it("the executors are registered, or an approved row could never run", () => {
    const registry = read("server/platform/approval-executors.ts");
    const registered = new Set(
      [...registry.matchAll(/registerApprovalExecutor\(\s*"([a-z._]+)"/g)].map((m) => m[1]),
    );
    expect(registered.size).toBeGreaterThan(0);
    for (const kind of Object.keys(REQUEST_PATHS)) {
      expect(registered.has(kind), kind).toBe(true);
    }
    // And `control-actions.ts` still pulls the registry in, or the
    // approvals screen would report a cold registry on every boot.
    expect(controlActions).toContain('import "./approval-executors"');
  });
});

describe("🔴 the SQL says what the code assumes", () => {
  const sqlFile = read("SQL-FILES/0074_platform_control.sql");

  it("puts the self-approval wait in the database, not only in TypeScript", () => {
    // ⚠️ The screen is one route among several. A future API or a support
    // script goes through the trigger and through none of the UI.
    expect(sqlFile).toContain("ordence_guard_self_approval");
    expect(sqlFile).toMatch(/interval '15 minutes'/);
  });

  it("refuses a break-glass row with no reason", () => {
    expect(sqlFile).toContain("platform_impersonation_break_glass_is_explained");
    expect(sqlFile).toMatch(/break_glass_reason.*\)\) >= 50/s);
  });

  it("allows only one open health event per tenant per rule", () => {
    expect(sqlFile).toContain("tenant_health_one_open_per_rule");
    expect(sqlFile).toMatch(/WHERE resolved_at IS NULL/);
  });

  it("⭐ enables RLS on the two tables that carry a tenant id", () => {
    // 🔴 I ARGUED MYSELF OUT OF THIS ONCE. RLS that is not enabled is not
    // a policy evaluating to false — it is no policy, and Postgres
    // returns every row.
    expect(sqlFile).toContain("ALTER TABLE tenant_health_events        ENABLE ROW LEVEL SECURITY");
    expect(sqlFile).toContain("platform_entitlement_history ENABLE ROW LEVEL SECURITY");
  });

  it("⚠️ keeps app_platform_scope() out of every WITH CHECK", () => {
    // The house rule the whole schema follows, and 0014 fails a deploy
    // that breaks it.
    const withChecks = sqlFile.match(/WITH CHECK \([^)]*\)/g) ?? [];
    for (const clause of withChecks) {
      expect(clause).not.toContain("app_platform_scope");
    }
  });

  it("points its foreign keys at platform_staff, never users", () => {
    // 🔴 A `PlatformOperator` has no `users.id` at all. Pointing these at
    // `users` compiled and would have failed on the first real insert.
    expect(sqlFile).toContain("REFERENCES platform_staff(id)");
    expect(sqlFile).not.toMatch(/requested_by\s+uuid NOT NULL REFERENCES users/);
  });
});
