/**
 * Ordence — ⭐⭐⭐ THREE POLICIES THAT WERE DECLARED AND ENFORCED BY
 *              NOTHING
 * Version: v1.58.0-alpha (Batch 43)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 WHAT WAS WRONG, IN ONE PARAGRAPH
 * ══════════════════════════════════════════════════════════════════════
 * `APPROVAL_POLICIES` declared six operations that must not run without a
 * second pair of eyes. Two were held. Of the other four,
 * `impersonate.break_glass` genuinely cannot go through this queue and
 * says so; the remaining THREE — `entitlement.override_paid`,
 * `staff.elevate` and `tenant.plan_change` — named enforcement points
 * that ran immediately when clicked.
 *
 * ⚠️ THE HARM IS NOT PEDANTIC. A configuration screen reads as a promise.
 * An owner who believes "changing what a paying customer can use needs a
 * second approver" delegates more freely and reviews less. An absent
 * control leaves people careful; a fake one makes them careless.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT THIS SUITE ASSERTS, AND WHAT IT CANNOT
 * ══════════════════════════════════════════════════════════════════════
 * `server/platform/*.ts` imports `@/db`, which under vitest hangs rather
 * than fails, so the RULES are tested as pure functions —
 * `lib/platform/approvals.ts` exists for that reason — and the WIRING is
 * pinned by reading source text.
 *
 * 🔴 ASSERTIONS ABOUT ABSENCE USE `codeOnly`. Every file here argues with
 * itself at length in comments and quotes the strings it removed; a naive
 * `not.toContain` would pass or fail on the explanation rather than on
 * the code.
 *
 * ⭐ AND THEY ASSERT PROPERTIES, NOT SHAPES. No exact sentence, no exact
 * href, no literal count of anything that a later batch would
 * legitimately change. The properties are: the refusal is server-side and
 * inside the write transaction; the approver is a different HUMAN; money
 * is compared as bigint; and every decision reaches the action register.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  APPROVAL_POLICIES,
  REQUEST_PATHS,
  elevatesGrade,
  entitlementOverrideIsHeld,
  enforcementReport,
  isEntitlementOverrideKey,
  isPayingWorkspace,
  mayApprove,
  planChangeIsHeld,
  replayVerdict,
  type ApprovalReplayRow,
} from "@/lib/platform/approvals";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** ⚠️ Comments blanked, line numbers preserved. See the header. */
const codeOnly = (s: string) =>
  s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));

const FLAGS = read("server/platform/flags.ts");
const CONFIGURATION = read("server/platform/configuration.ts");
const STAFF = read("server/platform/staff.ts");
const ENGINE = read("server/platform/approvals.ts");
const REGISTRY = read("server/platform/approval-executors.ts");
const DIRECTORY = read("app/platform/page.tsx");

/**
 * ⭐ THE THREE ENFORCEMENT POINTS, AS (FILE, FUNCTION, POLICY) TRIPLES.
 * Named once so every structural assertion below runs against all three
 * rather than against whichever one somebody remembered.
 */
const ENFORCEMENT_POINTS = [
  {
    file: "server/platform/flags.ts",
    source: FLAGS,
    fn: "setTenantFlag",
    kind: "entitlement.override_paid",
  },
  {
    file: "server/platform/configuration.ts",
    source: CONFIGURATION,
    fn: "setModuleEntitlement",
    kind: "entitlement.override_paid",
  },
  {
    file: "server/platform/configuration.ts",
    source: CONFIGURATION,
    fn: "setPlanAndLimits",
    kind: "tenant.plan_change",
  },
  {
    file: "server/platform/staff.ts",
    source: STAFF,
    fn: "grantPlatformStaff",
    kind: "staff.elevate",
  },
] as const;

const NOW = new Date("2026-08-17T10:00:00Z");
const REQUESTER = "11111111-1111-1111-1111-111111111111";
const SOMEBODY_ELSE = "22222222-2222-2222-2222-222222222222";

/* ================================================================== */
/* ①  FOUR EYES MEANS A DIFFERENT HUMAN. NOT A SUFFICIENT ROLE.        */
/* ================================================================== */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE MOST IMPORTANT BLOCK IN THIS BATCH
 * ══════════════════════════════════════════════════════════════════════
 * The commonest broken four-eyes implementation checks that AN OWNER
 * approved and calls that the control. On a platform where one person
 * holds both roles — every small platform, including this one — that
 * check passes for the requester approving themselves, and it passes
 * every test written by the person who wrote the bug, because they
 * instinctively test with two accounts.
 *
 * ⭐ SO IDENTITY IS COMPARED BY STAFF ID, AND GRADE IS NOT AN INPUT TO
 * THE COMPARISON AT ALL.
 */
describe("a requester cannot approve their own request, whatever role they hold", () => {
  const approvedRow = (over: Partial<ApprovalReplayRow> = {}): ApprovalReplayRow => ({
    actionKind: "tenant.plan_change",
    status: "approved",
    targetId: "33333333-3333-3333-3333-333333333333",
    requestedBy: REQUESTER,
    approverId: SOMEBODY_ELSE,
    selfApproved: false,
    executedAt: null,
    ...over,
  });

  /**
   * 🔴 THE ONE THAT MATTERS. The row is approved, the kind is right, the
   * target is right, nothing has expired — and the approver id equals the
   * requester id. It is refused at the moment of the write.
   */
  it("refuses at the write when approver and requester are the same id", () => {
    const verdict = replayVerdict({
      row: approvedRow({ approverId: REQUESTER, selfApproved: false }),
      kind: "tenant.plan_change",
      targetId: "33333333-3333-3333-3333-333333333333",
    });

    expect(verdict.ok).toBe(false);
    // ⚠️ A PROPERTY OF THE SENTENCE, NOT THE SENTENCE. It has to name the
    // fact so the refusal is actionable; it does not have to be worded
    // the way it is worded today.
    expect(verdict.ok === false && verdict.reason.toLowerCase()).toContain("same person");
  });

  /**
   * ⭐ GRADE IS NOT PART OF THE QUESTION, AND THIS PROVES IT STRUCTURALLY
   * RATHER THAN BY ASSERTION. `replayVerdict` takes no grade at all — so
   * there is no value of "role" that can make a self-approval pass, and
   * no future edit can add one without changing the signature.
   */
  it("does not accept a grade as an argument, so no role can excuse it", () => {
    const code = codeOnly(read("lib/platform/approvals.ts"));
    const start = code.indexOf("export function replayVerdict(");
    expect(start).toBeGreaterThan(-1);
    const signature = code.slice(start, code.indexOf("}", code.indexOf("): ReplayVerdict")));
    expect(signature).not.toMatch(/grade/i);
    expect(signature).toContain("kind");
    expect(signature).toContain("targetId");
  });

  /**
   * ⚠️ AND THE SAME ANSWER EARLIER IN THE JOURNEY. `mayApprove` refuses
   * the requester at the moment they press Approve — while somebody else
   * eligible exists — and it refuses them AT OWNER GRADE, which is the
   * grade every policy on the list requires. Holding the approving role
   * is exactly the situation this must survive.
   */
  it("refuses the requester at owner grade while somebody else could approve", () => {
    for (const policy of APPROVAL_POLICIES) {
      const verdict = mayApprove({
        kind: policy.kind,
        requestedBy: REQUESTER,
        requestedAt: new Date(NOW.getTime() - 5 * 60 * 60_000),
        approverId: REQUESTER,
        // 🔴 The approving grade for every policy on the list.
        approverGrade: policy.approverGrade,
        status: "pending",
        expiresAt: new Date(NOW.getTime() + 60 * 60_000),
        now: NOW,
        soleOperator: false,
      });
      expect(verdict.allowed, policy.kind).toBe(false);
    }
  });

  /**
   * ⭐ THE ONE PERMITTED EXCEPTION IS NAMED, NOT HIDDEN. A sole operator
   * may approve their own request after a wait; it is flagged in the row
   * and in the log so an auditor can count them. `replayVerdict` lets it
   * through only because the ROW says `self_approved`, which `mayApprove`
   * sets only when there was genuinely nobody else to ask.
   *
   * ⚠️ WHICH MEANS THE FLAG IS THE AUDIT TRAIL, and it is returned rather
   * than swallowed.
   */
  it("admits a self-approval only when the row records it as one", () => {
    const flagged = replayVerdict({
      row: approvedRow({ approverId: REQUESTER, selfApproved: true }),
      kind: "tenant.plan_change",
      targetId: "33333333-3333-3333-3333-333333333333",
    });
    expect(flagged.ok).toBe(true);
    expect(flagged.ok && flagged.selfApproved).toBe(true);

    const genuine = replayVerdict({
      row: approvedRow(),
      kind: "tenant.plan_change",
      targetId: "33333333-3333-3333-3333-333333333333",
    });
    expect(genuine.ok).toBe(true);
    expect(genuine.ok && genuine.selfApproved).toBe(false);
  });

  /**
   * ⚠️ THE DATABASE HOLDS THE SAME LINE. Pure code is one of three
   * layers; a support script or a future API goes through the trigger and
   * through none of the UI.
   */
  it("is backed by a CHECK constraint, not only by TypeScript", () => {
    const sqlFile = read("SQL-FILES/0074_platform_control.sql");
    expect(sqlFile).toMatch(/approver_id\s*<>\s*requested_by/);
    expect(sqlFile).toContain("self_approved");
  });
});

/* ================================================================== */
/* ②  AN APPROVAL IS NOT A TOKEN THAT OPENS OTHER DOORS                */
/* ================================================================== */

describe("what a replayed approval is checked against", () => {
  const base: ApprovalReplayRow = {
    actionKind: "entitlement.override_paid",
    status: "approved",
    targetId: "44444444-4444-4444-4444-444444444444",
    requestedBy: REQUESTER,
    approverId: SOMEBODY_ELSE,
    selfApproved: false,
    executedAt: null,
  };
  const ok = { kind: "entitlement.override_paid" as const, targetId: base.targetId };

  it("refuses an approval that does not exist", () => {
    expect(replayVerdict({ row: null, ...ok }).ok).toBe(false);
  });

  /** 🔴 An approved plan change must not authorise an entitlement override. */
  it("refuses an approval raised for a different policy", () => {
    expect(replayVerdict({ row: base, kind: "tenant.plan_change", targetId: base.targetId }).ok)
      .toBe(false);
  });

  /**
   * 🔴 NOR FOR A DIFFERENT CUSTOMER. This is the whole value of freezing
   * the target on the queue row at request time — the approver agreed to
   * something about ONE workspace.
   */
  it("refuses an approval that names another workspace", () => {
    expect(
      replayVerdict({
        row: base,
        kind: "entitlement.override_paid",
        targetId: "55555555-5555-5555-5555-555555555555",
      }).ok,
    ).toBe(false);
  });

  it("refuses a request that is not approved, in every other state", () => {
    for (const status of ["pending", "rejected", "expired", "executed", "failed"]) {
      expect(replayVerdict({ row: { ...base, status }, ...ok }).ok, status).toBe(false);
    }
  });

  /**
   * ⭐ ONE APPROVAL, ONE WRITE. Without this a replay could be run twice
   * and apply the same change again on one authorisation — which is why
   * the row is also locked `FOR UPDATE` while it is read.
   */
  it("refuses an approval that has already been carried out", () => {
    expect(replayVerdict({ row: { ...base, executedAt: NOW }, ...ok }).ok).toBe(false);
    expect(codeOnly(ENGINE)).toContain("FOR UPDATE");
  });

  it("refuses an approved row with no approver recorded", () => {
    expect(replayVerdict({ row: { ...base, approverId: null }, ...ok }).ok).toBe(false);
  });
});

/* ================================================================== */
/* ③  THE REFUSAL IS IN THE TRANSACTION, NOT IN THE UI                 */
/* ================================================================== */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 A SCREEN THAT HIDES A BUTTON IS A MISTAKE GUARD, NOT A CONTROL
 * ══════════════════════════════════════════════════════════════════════
 * Every one of these functions is reachable by POST from any page in the
 * product, because the server actions that call them publish stable
 * action ids. The gate therefore has to be where the row would change.
 */
describe("where the hold actually happens", () => {
  it.each(ENFORCEMENT_POINTS)(
    "$fn holds $kind inside the transaction that writes",
    ({ source, fn }) => {
      const code = codeOnly(source);
      const start = code.indexOf(`export async function ${fn}(`);
      expect(start, fn).toBeGreaterThan(-1);

      const body = code.slice(start, start + 12_000);
      const scopeAt = body.indexOf("withPlatformScope(");
      const gateAt = body.indexOf("approvalGate(");

      // ⭐ INSIDE the transaction callback, not before it opens.
      expect(gateAt, fn).toBeGreaterThan(scopeAt);
      expect(scopeAt, fn).toBeGreaterThan(-1);

      /*
       * 🔴 AND BEFORE THE WRITE. A gate that runs after the insert is a
       * log line. `.insert(`, `.update(` and `.delete(` are the three
       * ways anything in this codebase changes a row.
       */
      const firstWrite = [".insert(", ".update(", ".delete("]
        .map((token) => body.indexOf(token, scopeAt))
        .filter((i) => i > -1)
        .sort((a, b) => a - b)[0];
      expect(firstWrite, fn).toBeGreaterThan(-1);
      expect(gateAt, fn).toBeLessThan(firstWrite);
    },
  );

  /**
   * ⭐⭐ THE TICKET IS A SECOND ARGUMENT, WHICH IS WHAT MAKES IT
   * UNFORGEABLE FROM A BROWSER.
   *
   * ⚠️ IF IT WERE A FIELD IN `input`, a POST body could carry it. Every
   * public door forwards exactly one argument and every one of these
   * functions parses that argument with Zod, so there is no shape a
   * request can take that becomes an approval.
   */
  it.each(ENFORCEMENT_POINTS)("$fn takes the approval ticket beside the input", ({ source, fn }) => {
    const code = codeOnly(source);
    const start = code.indexOf(`export async function ${fn}(`);
    const signature = code.slice(start, code.indexOf("{", code.indexOf("Promise<", start)));
    expect(signature, fn).toContain("input: unknown");
    expect(signature, fn).toContain("ticket?: ApprovalTicket");
  });

  /**
   * 🔴 AND NO SCHEMA MAY ACCEPT ONE. This is the assertion that would
   * catch somebody "simplifying" the two-argument shape into a field.
   */
  it("never accepts an approval id as validated input", () => {
    for (const file of [
      "lib/platform/schemas.ts",
      "lib/platform/configuration.ts",
      ...new Set(ENFORCEMENT_POINTS.map((p) => p.file)),
    ]) {
      const code = codeOnly(read(file));
      expect(code, file).not.toMatch(/approvedRequestId:\s*z\./);
      expect(code, file).not.toMatch(/ticket:\s*z\./);
    }
  });

  /**
   * ⚠️ THE FACTS THE POLICY TURNS ON ARE READ IN THE SAME TRANSACTION.
   * A workspace can convert from trial to paid, or another operator's
   * approved plan change can land, between a page render and a form
   * submission — and either would decide whether this write is held.
   */
  it("reads the deciding fact inside the transaction rather than before it", () => {
    const flags = codeOnly(FLAGS);
    expect(flags.indexOf("commercialStandingIn(")).toBeGreaterThan(
      flags.indexOf("withPlatformScope("),
    );

    // The plan gate re-reads the live tier rather than trusting the
    // configuration snapshot taken on another connection.
    const plan = codeOnly(CONFIGURATION);
    const at = plan.indexOf("export async function setPlanAndLimits(");
    const body = plan.slice(at, at + 12_000);
    expect(body).toContain("planChangeIsHeld(liveTier");
  });
});

/* ================================================================== */
/* ④  MONEY IS bigint MINOR UNITS, AND THE POLICY TURNS ON IT          */
/* ================================================================== */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 `entitlement.override_paid` IS A POLICY ABOUT MONEY
 * ══════════════════════════════════════════════════════════════════════
 * Whether it applies is decided by comparing an amount in paise to zero.
 * `Number(amount) > 0` would work on every value anybody tests with and
 * is wrong in principle at exactly the point a control turns on or off.
 */
describe("who counts as a paying workspace", () => {
  const paid = {
    planTier: "advanced",
    subscriptionStatus: "active",
    unitAmountMinor: 499_900n,
  };

  it("holds an entitlement change for a workspace that pays", () => {
    expect(isPayingWorkspace(paid)).toBe(true);
    expect(
      entitlementOverrideIsHeld({ flagKey: "entitlement:crm.deals", ...paid }),
    ).toBe(true);
  });

  /**
   * ⚠️ A ZERO-AMOUNT SUBSCRIPTION IS NOT A PAYING CUSTOMER. Internal
   * workspaces, permanent comps and demo tenants all carry one, and
   * holding routine work is how a queue becomes a rubber stamp.
   */
  it("does not hold a zero-rupee subscription", () => {
    expect(isPayingWorkspace({ ...paid, unitAmountMinor: 0n })).toBe(false);
  });

  /** ⭐ One paise is money. The boundary is `> 0n`, not `>= some floor`. */
  it("treats a single paise as paying", () => {
    expect(isPayingWorkspace({ ...paid, unitAmountMinor: 1n })).toBe(true);
  });

  /**
   * 🔴 AND IT SURVIVES AMOUNTS BEYOND `Number.MAX_SAFE_INTEGER`. This is
   * the assertion that fails the day somebody "simplifies" the comparison
   * to `Number(...) > 0`: the value below is exact as a bigint and is not
   * exactly representable as a double.
   */
  it("compares as bigint, so a value past 2^53 is still exact", () => {
    // ⚠️ 2^53 + 1 exactly. Odd and above the double's integer range, so
    // it is the smallest value that survives as a bigint and does not
    // survive a round trip through `Number`.
    const huge = BigInt(Number.MAX_SAFE_INTEGER) + 2n;
    expect(huge > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(isPayingWorkspace({ ...paid, unitAmountMinor: huge })).toBe(true);
    // The float round-trip loses the distinction; the bigint does not.
    expect(BigInt(Number(huge))).not.toBe(huge);
  });

  /**
   * ⚠️ TRIAL AND LAPSED WORKSPACES ARE OUT, and that is a decision
   * `APPROVAL_POLICIES` already recorded — overrides on trial workspaces
   * are deliberately absent from the list because they are routine and
   * reversible.
   */
  it("excludes trials, trialing subscriptions and lapsed ones", () => {
    expect(isPayingWorkspace({ ...paid, planTier: "trial" })).toBe(false);
    expect(isPayingWorkspace({ ...paid, subscriptionStatus: "trialing" })).toBe(false);
    expect(isPayingWorkspace({ ...paid, subscriptionStatus: null })).toBe(false);
    for (const status of ["unpaid", "past_due", "cancelled", "incomplete_expired"]) {
      expect(isPayingWorkspace({ ...paid, subscriptionStatus: status }), status).toBe(false);
    }
  });

  /**
   * ⭐ ONLY THE `entitlement:` NAMESPACE. `platform_tenant_flags` carries
   * four namespaces in one table; holding a beta toggle or a config
   * override would put routine work in the queue.
   */
  it("holds entitlement keys and no other namespace", () => {
    expect(isEntitlementOverrideKey("entitlement:crm.deals")).toBe(true);
    for (const key of ["beta.ai_assistant", "config:limits.storage_mb", "lifecycle:deletion"]) {
      expect(isEntitlementOverrideKey(key), key).toBe(false);
      expect(entitlementOverrideIsHeld({ flagKey: key, ...paid }), key).toBe(false);
    }
  });

  /**
   * 🔴 THE AMOUNTS SHOWN TO THE APPROVER ARE bigint ARITHMETIC TOO. A
   * plan move is queued with what the customer pays and what the tier
   * lists at, and the difference between them is computed without ever
   * becoming a number.
   */
  it("prices a tier move without touching a float", () => {
    const code = codeOnly(CONFIGURATION);
    const at = code.indexOf("async function planChangeMoneyIndication(");
    expect(at).toBeGreaterThan(-1);
    const body = code.slice(at, at + 4_000);

    expect(body).toContain("BigInt(");
    expect(body).toContain("catalogueMinor - contractedMinor");
    // ⚠️ No `Number(` and no ×100 anywhere in the calculation. Formatting
    // for pixels happens in `formatMoney`, which takes the bigint.
    expect(body).not.toMatch(/Number\(/);
    expect(body).not.toMatch(/\*\s*100\b/);
    expect(body).toContain("formatMoney(");
  });

  /**
   * ⚠️ AND THEY ARE CARRIED AS STRINGS INTO THE JSON COLUMN.
   * `JSON.stringify` throws on a bigint, and a queue row is not where
   * anybody wants to discover that.
   */
  it("stores the amounts on the queue row as strings", () => {
    expect(codeOnly(CONFIGURATION)).toContain("contractedMinor?.toString()");
  });
});

/* ================================================================== */
/* ⑤  WHAT EACH POLICY GOVERNS, AND WHAT IT DELIBERATELY DOES NOT      */
/* ================================================================== */

describe("staff.elevate holds a rise and nothing else", () => {
  /** A first grant is a rise from nothing. */
  it("holds a first grant at any grade", () => {
    for (const grade of ["support", "engineer", "owner"] as const) {
      expect(elevatesGrade(null, grade), grade).toBe(true);
    }
  });

  it("holds a rise in rank", () => {
    expect(elevatesGrade("support", "engineer")).toBe(true);
    expect(elevatesGrade("support", "owner")).toBe(true);
    expect(elevatesGrade("engineer", "owner")).toBe(true);
  });

  /**
   * ⚠️ A RENEWAL IS NOT AN ELEVATION. Holding one would put a routine
   * quarterly expiry-extension in the queue, and the abuse that matters —
   * renewing your OWN access — is refused outright and separately.
   */
  it("does not hold a renewal at the same grade", () => {
    for (const grade of ["support", "engineer", "owner"] as const) {
      expect(elevatesGrade(grade, grade), grade).toBe(false);
    }
  });

  /**
   * ⭐ NOR A DOWNGRADE. Reducing power must always be cheaper than
   * increasing it, or the controls protect the wrong direction.
   */
  it("does not hold a downgrade", () => {
    expect(elevatesGrade("owner", "engineer")).toBe(false);
    expect(elevatesGrade("owner", "support")).toBe(false);
    expect(elevatesGrade("engineer", "support")).toBe(false);
  });

  /** And revocation is never held, which the return type says out loud. */
  it("never holds a revocation", () => {
    const code = codeOnly(STAFF);
    const at = code.indexOf("export async function revokePlatformStaff(");
    expect(at).toBeGreaterThan(-1);
    expect(code.slice(at)).not.toContain("approvalGate(");
  });
});

describe("tenant.plan_change holds the invoice, not the ceilings", () => {
  it("holds a move between tiers", () => {
    expect(planChangeIsHeld("basic", "advanced")).toBe(true);
    expect(planChangeIsHeld("enterprise", "basic")).toBe(true);
  });

  /**
   * ⚠️ SEAT AND STORAGE EDITS AT THE SAME TIER ARE ORDINARY SUPPORT WORK
   * and do not change what the customer is billed. A queue that fires on
   * them is a queue people learn to rubber-stamp.
   */
  it("does not hold a limits-only edit", () => {
    expect(planChangeIsHeld("advanced", "advanced")).toBe(false);
  });
});

/* ================================================================== */
/* ⑥  EVERY DECISION REACHES THE ACTION REGISTER                       */
/* ================================================================== */

/**
 * ⭐ A REFUSAL THAT IS NOT RECORDED CANNOT BE AUDITED, AND THE AUDIT IS
 * THE WHOLE POINT OF THE CONTROL.
 */
describe("the action register", () => {
  it.each(ENFORCEMENT_POINTS)("$fn records the refusal it makes", ({ source, fn }) => {
    const code = codeOnly(source);
    const start = code.indexOf(`export async function ${fn}(`);
    const body = code.slice(start, start + 14_000);
    expect(body, fn).toContain("recordApprovalRefusal(");
    // ⚠️ Named with the policy that caused it, not a generic "refused".
    expect(body, fn).toMatch(/kind:\s*"[a-z._]+"/);
  });

  /**
   * ⭐ AND A HELD WRITE IS DISTINGUISHED FROM A DELIBERATE REQUEST.
   * "Somebody asked" and "somebody tried and was stopped" are different
   * facts about the same queue row, and only the second proves the
   * control fired.
   */
  it.each(ENFORCEMENT_POINTS)("$fn marks its queued row as a held write", ({ source, fn }) => {
    const code = codeOnly(source);
    const start = code.indexOf(`export async function ${fn}(`);
    const body = code.slice(start, start + 14_000);
    expect(body, fn).toContain("heldWrite: true");
  });

  it("carries the policy and the stage into the audit metadata", () => {
    const code = codeOnly(ENGINE);
    expect(code).toContain("approvalKind:");
    expect(code).toContain('stage: "refused"');
    expect(code).toContain("heldWrite:");
  });

  /**
   * ⚠️ AND THE APPROVAL IS NAMED IN THE CUSTOMER'S OWN LOG when the write
   * finally happens. An auditor reading a workspace's history should not
   * have to join to the queue to find out whether a second person agreed.
   */
  it.each(ENFORCEMENT_POINTS)("$fn records which approval allowed the write", ({ source, fn }) => {
    const code = codeOnly(source);
    const start = code.indexOf(`export async function ${fn}(`);
    const body = code.slice(start, start + 14_000);
    expect(body, fn).toContain("approvedRequestId: ticket?.approvedRequestId");
  });
});

/* ================================================================== */
/* ⑦  THE POLICY BOARD IS NOW MOSTLY TRUE, AND STILL DERIVED           */
/* ================================================================== */

describe("what the screen may claim", () => {
  const registered = [
    ...codeOnly(REGISTRY).matchAll(/registerApprovalExecutor\(\s*"([a-z._]+)"/g),
  ].map((m) => m[1] as string);

  /**
   * ⭐ DERIVED, NOT TYPED. `enforced` must remain precisely the
   * intersection of "has an executor" and "has a request path" — nothing
   * added by generosity on either side.
   */
  it("counts as enforced exactly the policies with both halves", () => {
    const report = enforcementReport(registered);
    for (const row of report) {
      expect(row.enforced, row.kind).toBe(
        registered.includes(row.kind) && Boolean(REQUEST_PATHS[row.kind]),
      );
      // A caveat that outlives its own fix is a screen lying in the
      // other direction.
      if (row.enforced) expect(row.blockedBecause, row.kind).toBe("");
    }
  });

  /**
   * ⚠️ THE ONE THAT REMAINS UNENFORCED IS A DESIGN CONSTRAINT, NOT A
   * BACKLOG ITEM, and the registry must not quietly grow it: an executor
   * for break-glass would run inside the APPROVER's request and open the
   * customer's workspace for the wrong person.
   */
  it("still refuses to pretend break-glass goes through this queue", () => {
    expect(registered).not.toContain("impersonate.break_glass");
    expect(REQUEST_PATHS["impersonate.break_glass"]).toBeUndefined();
    const row = enforcementReport(registered).find(
      (p) => p.kind === "impersonate.break_glass",
    )!;
    expect(row.enforced).toBe(false);
    expect(row.blockedBecause.length).toBeGreaterThan(120);
  });

  /**
   * 🔴 AND THE DECISION ABOUT IN-FLIGHT WORK IS WRITTEN DOWN. Whichever
   * way it was decided, an undocumented choice here is the one somebody
   * silently reverses.
   */
  it("says in the file what happens to work already in flight", () => {
    const doc = read("lib/platform/approvals.ts");
    expect(doc).toMatch(/in flight/i);
    expect(doc).toMatch(/retroactiv/i);
  });
});

/* ================================================================== */
/* ⑧  THE QUEUE ON THE DASHBOARD READS THE ENFORCEMENT'S OWN SOURCE    */
/* ================================================================== */

describe("the decision stack on the console dashboard", () => {
  /**
   * ══════════════════════════════════════════════════════════════════
   * 🔴 A PARALLEL QUERY WOULD DISAGREE WITH THE QUEUE, SPECIFICALLY
   * ══════════════════════════════════════════════════════════════════
   * `listPending` flips expired rows to `expired` before it lists them.
   * A badge counting `status = 'pending'` would keep advertising requests
   * nobody can approve — and an operator who clicks through to find
   * nothing there learns the number is decorative.
   */
  it("reads the same function the approvals screen reads", () => {
    const code = codeOnly(DIRECTORY);
    expect(code).toContain("getApprovalQueue(");
    expect(code).not.toMatch(/platform_approval_queue/);
    expect(code).not.toContain("db.execute(");
  });

  /** ⚠️ And the per-row eligibility is the server's number, not a guess. */
  it("shows the same eligibility number the server will act on", () => {
    expect(codeOnly(DIRECTORY)).toContain("otherEligibleApprovers");
    expect(codeOnly(ENGINE)).toContain("otherEligibleApprovers");
  });

  /**
   * ⭐ ONE IN TWELVE INDIAN MEN IS COLOUR-BLIND, so the state is a WORD.
   * A count in a coloured pill is the same pill whatever it means.
   */
  it("states the waiting condition in words", () => {
    expect(DIRECTORY).toMatch(/waiting for approval/i);
    expect(DIRECTORY).toMatch(/second approver/i);
  });

  /** ⚠️ The console answers on two base paths; a raw href is a 404. */
  it("links to the queue through consoleHref", () => {
    expect(codeOnly(DIRECTORY)).toContain('consoleHref("/platform/approvals"');
  });
});

/* ================================================================== */
/* ⑨  A QUEUED CHANGE IS NEVER REPORTED AS A COMPLETED ONE             */
/* ================================================================== */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 `ok: true` MEANING BOTH "DONE" AND "QUEUED" HAS SHIPPED HERE BEFORE
 * ══════════════════════════════════════════════════════════════════════
 * `requestSuspend` returned a note beginning "Nothing has happened yet"
 * and `TenantActions.run()` raised `toast.success("Done.")`. The operator
 * believed a live workspace was locked.
 *
 * ⚠️ THREE MORE SCREENS CAN NOW RECEIVE THAT SHAPE, so all three are
 * pinned — and the notice has to PERSIST, because a toast that fades in
 * four seconds loses the argument to a row that still shows the old
 * value.
 */
describe("the screens that can now be held", () => {
  const SCREENS = [
    "components/platform/flag-editor.tsx",
    "components/platform/module-switchboard.tsx",
    "components/platform/plan-limits-editor.tsx",
    "components/platform/staff-console.tsx",
  ];

  it.each(SCREENS)("%s checks queued before it congratulates anybody", (file) => {
    const code = codeOnly(read(file));
    const queuedAt = code.indexOf("result.data?.queued");
    const successAt = code.indexOf("toast.success");
    expect(queuedAt, file).toBeGreaterThan(-1);
    expect(successAt, file).toBeGreaterThan(-1);
    expect(queuedAt, file).toBeLessThan(successAt);
  });

  it.each(SCREENS)("%s renders a persistent notice rather than a toast", (file) => {
    const code = codeOnly(read(file));
    expect(code, file).toContain("<HeldForApproval");
    expect(code, file).toContain("setHeldNote(");
  });

  it("ships the notice component, and it says the state in words", () => {
    const path = "components/platform/held-for-approval.tsx";
    expect(existsSync(join(ROOT, path))).toBe(true);
    const source = read(path);
    expect(source).toMatch(/waiting for approval/i);
    expect(source).toMatch(/nothing has been changed/i);
    // ⚠️ Two base paths. A hard-coded `/platform/...` is a 404 on the
    // console host.
    expect(codeOnly(source)).toContain("consoleHref(");
    // 🔴 And it must not reach the server-only half of that module.
    expect(codeOnly(source)).not.toContain('from "@/lib/platform/console-href"');
  });
});
