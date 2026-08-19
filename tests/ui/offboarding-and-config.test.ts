/**
 * Ordence — ⭐⭐⭐ BATCH 46 + 47: OFFBOARDING AND THE CONFIGURATION CHAIN
 * Version: v1.46.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THESE TESTS ARE ACTUALLY GUARDING
 * ══════════════════════════════════════════════════════════════════════
 * Two things, and neither of them is "the code compiles".
 *
 * ① THE 24-HOUR WINDOW IS REAL RATHER THAN COSMETIC. A destructive
 *   action that executes immediately after three confirmations is a
 *   destructive action that executes. So: approval must SCHEDULE and not
 *   delete, the scheduled moment must be computed from the window, the
 *   cancel must actually restore a status, and — because nothing in this
 *   build runs the job — the screen must SAY SO rather than implying a
 *   deletion will happen. The last one is the easiest thing to quietly
 *   drop in a later refactor, so it is asserted twice.
 *
 * ② THE THREE DECORATIVE CONTROLS ARE WIRED. A storage number with no
 *   provenance, a customer message nothing could read back, and an
 *   approvals list that was a poster. Each is now resolved through the
 *   chain, and the chain refuses to save without a diff preview.
 *
 * ⚠️ ASSERTIONS ABOUT ABSENCE READ COMMENT-STRIPPED SOURCE. Every file
 * here is dense with prose that mentions the very things some of these
 * tests check are NOT done — "this does not delete", "no executor" —
 * and a naive `not.toContain("delete")` would pass or fail on a comment.
 * `codeOnly` is the same helper `tests/ui/order-create.test.ts` uses.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import {
  CONFIG_KEYS,
  configDefinition,
  configOverrideKeyFor,
  diffConfigChange,
  isConfigKey,
  parseConfigValue,
  resolveConfig,
} from "@/lib/platform/config-chain";
import { offboardingView, type OffboardingRecord } from "@/server/platform/tenants";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const TENANTS = read("server/platform/tenants.ts");
const CONTROL = read("server/platform/control-actions.ts");
const ACTIONS = read("server/platform/actions.ts");
const CONFIGURATION = read("server/platform/configuration.ts");
const CHAIN = read("lib/platform/config-chain.ts");
const PANEL = read("components/platform/offboarding-panel.tsx");
const CHAIN_PANEL = read("components/platform/config-chain-panel.tsx");
const DETAIL = read("app/platform/tenants/[id]/page.tsx");
const CONFIGURE = read("app/platform/tenants/[id]/configure/page.tsx");
const CONFIG_PAGE = read("app/platform/config/page.tsx");
const PLAN_EDITOR = read("components/platform/plan-limits-editor.tsx");

const codeOnly = (s: string) =>
  s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));

/* ================================================================== */
/* ① THE WINDOW IS REAL                                                */
/* ================================================================== */

describe("the 24-hour window", () => {
  /**
   * 🔴 THE SINGLE MOST IMPORTANT ASSERTION IN THIS FILE. Approving a
   * termination must not call anything that removes data. If somebody
   * later "completes" the feature by making the executor delete, this
   * test fails and they have to come and read the argument first.
   */
  it("the approval executor schedules and never deletes", () => {
    /*
     * ⚠️ READ FROM `approval-executors.ts`, NOT FROM `control-actions.ts`.
     * Batch 43 moved every registration into one module that imports
     * nothing which could import it back — three of the five policies are
     * now raised by the WRITING functions, which are reachable from
     * server actions that never touch `control-actions.ts`, and a
     * registration living there meant those writes could be held and
     * then fail to queue. The assertion below is the same assertion; only
     * the file it reads moved.
     */
    const code = codeOnly(read("server/platform/approval-executors.ts"));
    expect(code).toContain('registerApprovalExecutor("tenant.terminate"');
    expect(code).toContain("scheduleTenantTermination(payload)");

    // The scheduler moves a status and writes a record. It does not
    // remove rows and it does not soft-delete the tenant either.
    const scheduler = codeOnly(TENANTS).slice(
      codeOnly(TENANTS).indexOf("export async function scheduleTenantTermination"),
      codeOnly(TENANTS).indexOf("export async function cancelTenantTermination"),
    );
    expect(scheduler.length).toBeGreaterThan(500);
    expect(scheduler).not.toMatch(/\.delete\(/);
    expect(scheduler).not.toContain("deletedAt:");
    expect(scheduler).toContain('status: "pending_deletion"');
  });

  /** The scheduled moment is the window, not a constant, and it is frozen. */
  it("computes the scheduled moment from the configuration chain", () => {
    const code = codeOnly(TENANTS);
    expect(code).toContain('"offboarding.cancel_window_hours"');
    expect(code).toContain("windowHours * 3_600_000");
    // Frozen onto the record so a later config change cannot shorten a
    // window a customer was already promised.
    expect(code).toContain("cancelWindowHours: windowHours");
  });

  /** ⭐ And the cancel restores the status the workspace HELD. */
  it("the cancel restores the previous status rather than setting active", () => {
    const code = codeOnly(TENANTS);
    expect(code).toContain("status: record.previousStatus");
    expect(code).not.toContain('set({ status: "active"');
    // No second approver, no typed slug: stopping must be cheaper than
    // starting or the controls protect the wrong direction.
    expect(code).toContain("cancelTerminationSchema");
    const cancel = code.slice(
      code.indexOf("const cancelTerminationSchema"),
      code.indexOf("exportSnapshotSchema"),
    );
    expect(cancel).not.toContain("confirmSlug");
    expect(cancel).not.toContain("queueForApproval");
  });

  /**
   * 🔴 THE HONESTY REQUIREMENT. Nothing runs the job, and the screen
   * says so in words rather than rendering a countdown that implies a
   * deletion.
   */
  it("says out loud that nothing executes a due termination", () => {
    expect(codeOnly(TENANTS)).toContain("executorPresent: false");
    expect(codeOnly(PANEL)).toContain("executorPresent");
    expect(PANEL).toContain("Nothing in this build carries out a due termination");
    expect(codeOnly(PANEL)).toContain('data-testid="offboarding-no-executor"');
    // The audit row carries the same fact, so a reader of the trail in a
    // year cannot conclude data was destroyed on that date.
    expect(codeOnly(TENANTS)).toContain("dataDeleted: false");
  });

  /** The phases are derived from the clock, never stored. */
  it("derives the phase from now rather than persisting it", () => {
    const base: OffboardingRecord = {
      stage: "scheduled",
      requestedByEmail: "a@example.com",
      requestedAt: "2026-01-01T00:00:00.000Z",
      approvedByEmail: "b@example.com",
      approvedAt: "2026-01-01T00:00:00.000Z",
      scheduledFor: "2026-01-02T00:00:00.000Z",
      cancelWindowHours: 24,
      retentionDays: 30,
      retentionEndsAt: "2026-02-01T00:00:00.000Z",
      previousStatus: "active",
      reason: "Customer asked us to close the account after migration.",
    };

    expect(offboardingView(base, new Date("2026-01-01T06:00:00Z")).phase).toBe("cancel_window");
    expect(offboardingView(base, new Date("2026-01-10T00:00:00Z")).phase).toBe("retention");
    expect(offboardingView(base, new Date("2026-03-01T00:00:00Z")).phase).toBe("deletion_due");
    expect(offboardingView({ ...base, stage: "cancelled" }, new Date()).phase).toBe("cancelled");

    // 18 hours in, 6 hours of window left.
    expect(
      offboardingView(base, new Date("2026-01-01T18:00:00Z")).minutesLeftInWindow,
    ).toBe(360);

    // ⚠️ CANCELLABLE EVEN AFTER THE MOMENT PASSES. Nothing ran, so
    // refusing would strand a workspace in `pending_deletion` with no
    // way back and nothing to have caused it.
    expect(offboardingView(base, new Date("2026-03-01T00:00:00Z")).cancellable).toBe(true);
    expect(offboardingView(base, new Date("2026-03-01T00:00:00Z")).executorPresent).toBe(false);
  });
});

/* ================================================================== */
/* ② THREE CONFIRMATIONS AND A SECOND APPROVER                         */
/* ================================================================== */

describe("what it costs to request a termination", () => {
  it("collects three separate confirmations", () => {
    const code = codeOnly(CONTROL);
    expect(code).toContain("confirmSlug");
    expect(code).toContain("confirmPhrase");
    expect(code).toContain("acknowledgeExport: z.literal(true");
    expect(code).toContain('"DELETE ALL DATA"');

    // And the dialog asks for all three rather than one and two hints.
    const panel = codeOnly(PANEL);
    expect(panel).toContain("typedSlug.trim() === tenantSlug");
    expect(panel).toContain("typedPhrase.trim() === PHRASE");
    expect(panel).toContain("acknowledged &&");
  });

  /**
   * ⭐ RE-CHECKED AT EXECUTION, HOURS LATER. The slug can change between
   * request and approval, and a renamed workspace is exactly the case
   * the typed slug exists to catch.
   */
  it("re-checks the confirmations in the executor", () => {
    const code = codeOnly(TENANTS);
    expect(code).toContain("confirmPhrase !== TERMINATION_PHRASE");
    expect(code).toContain("tenant.slug !== confirmSlug.trim()");
  });

  /**
   * 🔴 NO SECOND APPROVAL MECHANISM. It goes through the queue that
   * already exists, with the policy that was already declared.
   */
  it("uses the existing approval queue rather than inventing one", () => {
    const code = codeOnly(CONTROL);
    expect(code).toContain('kind: "tenant.terminate"');
    expect(code).toContain("queueForApproval(");
    // No bespoke approver table, no second sign-off column.
    expect(code).not.toMatch(/secondApprover|approver2|dualControl/i);
  });

  /**
   * ⚠️ `scheduleTenantTermination` MUST NOT BE A SERVER ACTION. A stable
   * action id on the function that locks a workspace and starts the
   * clock would route around the queue entirely.
   */
  it("does not publish the scheduler as a server action", () => {
    const code = codeOnly(ACTIONS);
    expect(code).toContain("requestTerminationAction");
    expect(code).toContain("cancelTerminationAction");
    expect(code).not.toContain("scheduleTenantTermination");
  });

  /** Every offboarding entry point shows its guard at the export. */
  it("guards every offboarding export with requireCapability", () => {
    const code = codeOnly(TENANTS);
    for (const fn of [
      "scheduleTenantTermination",
      "cancelTenantTermination",
      "exportOffboardingSnapshot",
    ]) {
      const at = code.indexOf(`export async function ${fn}`);
      expect(at, `${fn} is exported`).toBeGreaterThan(-1);
      // The guard is the first statement of the body — visible at the
      // export, not somewhere down the file. The window is generous
      // enough for a multi-line return type and no more.
      expect(code.slice(at, at + 700)).toContain('requireCapability("tenants:suspend")');
    }
    expect(codeOnly(CONTROL)).toContain('requireCapability("tenants:suspend")');
  });
});

/* ================================================================== */
/* ③ EXPORT AND RETENTION ARE REAL STEPS                               */
/* ================================================================== */

describe("export and retention", () => {
  /** ⭐ `exportTenantData` has existed since Phase 12 with no caller. */
  it("actually runs the tenant export and records a receipt", () => {
    const code = codeOnly(TENANTS);
    expect(code).toContain("exportTenantData(tenantId, tenant.name)");
    expect(code).toContain("exportRowCount: rowCount");
    expect(code).toContain('action: "export"');
  });

  it("computes the retention deadline from the chain, after the scheduled moment", () => {
    const code = codeOnly(TENANTS);
    expect(code).toContain('"offboarding.retention_days"');
    expect(code).toContain("scheduledFor.getTime() + retentionDays * 86_400_000");
  });
});

/* ================================================================== */
/* ④ THE CHAIN RESOLVES IN ORDER                                       */
/* ================================================================== */

describe("the configuration chain", () => {
  it("resolves global → plan → tenant, in that order", () => {
    const global = resolveConfig({
      key: "limits.storage_mb",
      // A tier with no plan-level entry would fall back to global; every
      // tier has one for storage, so `trial` proves the plan layer wins
      // over global.
      planTier: "trial",
      override: { present: false },
    });
    expect(global.effectiveLayer).toBe("plan");
    expect(global.effective).toBe(2048);

    const overridden = resolveConfig({
      key: "limits.storage_mb",
      planTier: "trial",
      override: { present: true, raw: 8192, reason: "r", setByEmail: "a@b.c", setAt: null },
    });
    expect(overridden.effectiveLayer).toBe("tenant");
    expect(overridden.effective).toBe(8192);

    // A key with no plan-level entry for this tier falls through.
    const inherited = resolveConfig({
      key: "offboarding.retention_days",
      planTier: "basic",
      override: { present: false },
    });
    expect(inherited.effectiveLayer).toBe("global");
    expect(inherited.effective).toBe(30);

    // ⭐ And enterprise really does get a longer cancel window — the
    // fact the offboarding panel and the audit row both quote.
    expect(
      resolveConfig({
        key: "offboarding.cancel_window_hours",
        planTier: "enterprise",
        override: { present: false },
      }).effective,
    ).toBe(72);
    expect(
      resolveConfig({
        key: "offboarding.cancel_window_hours",
        planTier: "basic",
        override: { present: false },
      }).effective,
    ).toBe(24);
  });

  /**
   * ⚠️ AN UNPARSEABLE OVERRIDE IS IGNORED AND REPORTED — never resolved
   * as zero, never thrown. A confident wrong answer is worse than both.
   */
  it("ignores an unusable override loudly instead of guessing", () => {
    const r = resolveConfig({
      key: "limits.storage_mb",
      planTier: "basic",
      override: { present: true, raw: "eight thousand", reason: null, setByEmail: null, setAt: null },
    });
    expect(r.effective).toBe(2048);
    expect(r.effectiveLayer).toBe("plan");
    expect(r.invalidOverride).toBeTruthy();
    expect(r.invalidOverride).toContain("cannot be used");
  });

  it("is typed per key", () => {
    expect(parseConfigValue("limits.storage_mb", "8192")).toEqual({ ok: true, value: 8192 });
    expect(parseConfigValue("limits.storage_mb", "8192.5").ok).toBe(false);
    expect(parseConfigValue("limits.storage_mb", 10).ok).toBe(false); // below min
    expect(parseConfigValue("suspension.customer_message", 42).ok).toBe(false);
    // ⚠️ Empty is a request to CLEAR, not a value — accepting it would
    // show a suspended customer a blank explanation.
    expect(parseConfigValue("suspension.customer_message", "  ").ok).toBe(false);
  });

  it("keeps its namespace apart from flags and entitlements", () => {
    expect(configOverrideKeyFor("limits.storage_mb")).toBe("config:limits.storage_mb");
    expect(isConfigKey("entitlement:sales.orders")).toBe(false);
    expect(isConfigKey("limits.storage_mb")).toBe(true);
  });

  /**
   * ⭐ EVERY KEY MUST NAME A READER. A configuration key nothing
   * consumes is the exact fault this batch exists to fix, so the
   * catalogue cannot grow a decorative entry without failing here.
   */
  it("every key declares what reads it", () => {
    expect(CONFIG_KEYS.length).toBeGreaterThan(0);
    for (const key of CONFIG_KEYS) {
      const def = configDefinition(key);
      expect(def.consumers.length, `${key} has a consumer`).toBeGreaterThan(0);
      expect(def.description.length).toBeGreaterThan(20);
    }
  });
});

/* ================================================================== */
/* ⑤ THE DIFF PREVIEW                                                  */
/* ================================================================== */

describe("the diff preview", () => {
  it("names the workspace and both effective values", () => {
    const diff = diffConfigChange({
      key: "limits.storage_mb",
      planTier: "basic",
      tenantLabel: "Acme Traders",
      before: { present: false },
      after: { present: true, raw: 8192, reason: null, setByEmail: null, setAt: null },
    });
    expect(diff.changed).toBe(true);
    expect(diff.sentence).toBe(
      "Effective value for Acme Traders changes from 2048 MB to 8192 MB.",
    );
  });

  /**
   * 🔴 THE FAILURE THIS EXISTS FOR. An override pinned to the number the
   * plan already gives changes nothing today and silently stops the
   * workspace following the plan tomorrow. Saying "no change" and saving
   * quietly is how a fork of the price list gets created by accident.
   */
  it("warns when the number stays put but the provenance moves", () => {
    const diff = diffConfigChange({
      key: "limits.storage_mb",
      planTier: "basic",
      tenantLabel: "Acme Traders",
      before: { present: false },
      after: { present: true, raw: 2048, reason: null, setByEmail: null, setAt: null },
    });
    expect(diff.changed).toBe(false);
    expect(diff.fromLayer).toBe("plan");
    expect(diff.toLayer).toBe("tenant");
    expect(diff.note).toContain("stops following");
  });

  /** And the save is gated on having seen one. */
  it("the panel refuses to save without a preview", () => {
    const code = codeOnly(CHAIN_PANEL);
    expect(code).toContain("diff === null");
    // Editing the value clears a stale preview rather than leaving a
    // sentence describing a change nobody is about to make.
    expect(code).toContain("setDiff(null)");
    expect(codeOnly(CHAIN_PANEL)).toContain('data-testid="config-diff"');
  });

  it("the preview is a separate, separately-gated endpoint", () => {
    const code = codeOnly(CONFIGURATION);
    expect(code).toContain("export async function previewConfigOverride");
    expect(code.slice(code.indexOf("export async function previewConfigOverride"), code.indexOf("export async function previewConfigOverride") + 300))
      .toContain('requireCapability("tenants:read")');
    const write = code.indexOf("export async function setConfigOverride");
    expect(code.slice(write, write + 300)).toContain('capabilityOrStepUp("tenants:configure")');
  });
});

/* ================================================================== */
/* ⑥ VERSIONED, WITH AN ACTOR                                          */
/* ================================================================== */

describe("versioning", () => {
  /**
   * ⚠️ NO SECOND HISTORY TABLE. A history split across two tables cannot
   * prove anything, because a reader has to trust both are complete —
   * the same argument `guard.ts` makes about the audit trail.
   */
  it("records the actor and reads the history from the customer's own audit log", () => {
    const code = codeOnly(CONFIGURATION);
    expect(code).toContain("setByEmail: operator.email");
    expect(code).toContain('resourceType: "tenant_config_override"');
    expect(code).toContain("export async function listConfigVersions");
    expect(code).toContain("withTenant(tenantId");
    // The audit row records the EFFECTIVE values, not the raw override:
    // "override removed" tells a reviewer nothing.
    expect(code).toContain("oldValue: { effective: diff.data.from");
  });

  /** An unreadable history is shown as unknown, never as empty. */
  it("distinguishes an unreadable history from an empty one", () => {
    expect(codeOnly(CONFIGURATION)).toContain("readable: false");
    expect(CHAIN_PANEL).toContain("Empty is not the same as nothing happened");
  });
});

/* ================================================================== */
/* ⑦ THE THREE DECORATIVE CONTROLS NOW DO SOMETHING                    */
/* ================================================================== */

describe("the controls that used to be decoration", () => {
  /** ① The storage field writes through the chain, both ways. */
  it("the storage limit resolves through the chain and reconciles the column", () => {
    const code = codeOnly(CONFIGURATION);
    expect(code).toContain("storageIsPlanDefault");
    // Equal to the plan's ceiling deletes the override, so a later
    // upgrade actually lifts them.
    expect(code).toContain("storageFlagKey");
    expect(code).toContain("storageColumnDisagrees");
    // The field itself tells the operator which layer the number lands in.
    expect(codeOnly(PLAN_EDITOR)).toContain('configDefinition("limits.storage_mb")');
    expect(PLAN_EDITOR).toContain("stops following the plan");
  });

  /** ② The customer message is collected, stored, resolved and shown. */
  it("the suspension message is collected and has a home", () => {
    expect(codeOnly(read("components/platform/tenant-actions.tsx"))).toContain(
      "customerMessage",
    );
    expect(codeOnly(TENANTS)).toContain(
      'configOverrideKeyFor("suspension.customer_message")',
    );
    expect(codeOnly(DETAIL)).toContain("tenant.suspensionMessage.effective");
    // ⭐ AND THE HONEST CAVEAT: the customer's own banner does not read
    // it yet. Dropping this sentence would turn a wired control back
    // into a decorative one without changing any behaviour.
    expect(DETAIL).toContain("access-state.ts");
    expect(DETAIL).toContain("Not yet rendered to the customer");
  });

  /** ③ The approvals policy list is joined to something that varies. */
  it("the approvals policy list is joined to the chain and says what still is not", () => {
    expect(existsSync(join(ROOT, "app/platform/config/page.tsx"))).toBe(true);
    expect(codeOnly(CONFIG_PAGE)).toContain("APPROVAL_POLICIES");
    expect(codeOnly(CONFIG_PAGE)).toContain('p.kind === "tenant.terminate"');
    expect(CONFIG_PAGE).toContain("chain-governed");
    expect(CONFIG_PAGE).toContain("code constants only");
  });
});

/* ================================================================== */
/* ⑧ REACHABLE                                                         */
/* ================================================================== */

describe("everything is reachable", () => {
  /**
   * 🔴 THE EIGHTH COMPLETE ENGINE WITH NO CALLER IS WHY
   * `scripts/check-reachability.mjs` EXISTS. A panel nobody can open is
   * the same bug as a function nobody calls.
   */
  it("the offboarding panel is mounted on the tenant detail page", () => {
    const code = codeOnly(DETAIL);
    expect(code).toContain("OffboardingPanel");
    expect(code).toContain("requestTerminationAction");
    expect(code).toContain("cancelTerminationAction");
    expect(code).toContain("exportOffboardingSnapshotAction");
    /*
     * ⚠️ WAS `toContain('value="offboarding"')` — A PINNED TAB ID, AND
     * THE WRONG ASSERTION. It broke in Batch 125 when the detail page
     * became Tenant 360 and the panel moved onto the Access tab beside
     * the other irreversible act (the rename), which is an improvement
     * the test had no business refusing. The property that actually
     * matters is that the panel is mounted inside the tabbed surface —
     * reachable by an operator — not which of the eight tabs holds it.
     */
    expect(code).toContain("TenantTabs");
  });

  it("the chain panel is mounted on the configure page", () => {
    const code = codeOnly(CONFIGURE);
    expect(code).toContain("ConfigChainPanel");
    expect(code).toContain("getConfigChain");
    expect(code).toContain("listConfigVersions");
    expect(code).toContain("previewConfigOverrideAction");
    expect(code).toContain("setConfigOverrideAction");
  });

  it("the global chain screen is linked from a page somebody opens", () => {
    // ⚠️ ASSERTS THE LINK, NOT HOW IT IS SPELLED. This pinned the literal
    // string `href="/platform/config"` and broke when console links became
    // host-aware. The console is served at two base paths , /platform/x on
    // app. and /x on admin. , so every link now goes through
    // `consoleHref()`. The property that matters is that the config screen
    // is REACHABLE from a page somebody opens, which is what this test is
    // named after. A test that pins the spelling fails when the spelling
    // is corrected, which trains people to edit the test.
    const src = codeOnly(read("app/platform/tenants/page.tsx"));
    expect(src).toMatch(/href=\{?\s*(?:"\/platform\/config"|consoleHref\(\s*"\/platform\/config")/);
  });
});
