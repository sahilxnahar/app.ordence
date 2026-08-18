/**
 * Ordence — ⭐⭐⭐ FIVE POLICIES NOTHING ENFORCED, AND A SCREEN THAT
 *              LISTED ALL SIX AS THOUGH IT DID
 * Version: v1.32.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 WHAT WAS ACTUALLY WRONG
 * ══════════════════════════════════════════════════════════════════════
 * `APPROVAL_POLICIES` names six operations that must not run without a
 * second pair of eyes. One of them — `tenant.suspend` — has a request
 * path and an executor and genuinely goes through the queue. The other
 * five are rows nothing reaches:
 *
 *   · `entitlement.override_paid` has an EXECUTOR and no REQUEST PATH.
 *     `applyEntitlementChange` still calls `setTenantFlag` directly, so
 *     an override on a paying customer takes effect on the click. This
 *     is the most misleading of the five, because half of it is built.
 *   · `tenant.terminate` has no call site anywhere in the repository.
 *   · `impersonate.break_glass` CANNOT go through this queue: the
 *     executor runs in the approver's request and `startImpersonation`
 *     binds the session to its caller.
 *   · `staff.elevate` and `tenant.plan_change` have enforcement points
 *     that are still reachable directly.
 *
 * ⚠️ AND THE SCREEN PRINTED ALL SIX UNDER "What is held, and why", with
 * the page's own heading paragraph opening "Six actions in the whole
 * console are held here rather than executed."
 *
 * ⭐ THE POINT OF THIS SUITE IS NOT TO ASSERT THAT FIVE ARE BROKEN. It
 * is to assert that nothing can CLAIM to hold something it does not, and
 * that the two claims a screen can make — "this is enforced" and "this
 * has happened" — are both derived from the code rather than typed by
 * hand.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THIS FILE READS SOURCE INSTEAD OF IMPORTING THE ENGINE
 * ══════════════════════════════════════════════════════════════════════
 * `server/platform/approvals.ts` imports `@/db`, which under vitest
 * hangs rather than fails. So the pure rules live in
 * `lib/platform/approvals.ts` — the same argument that file's own header
 * makes for `mayApprove` — and the wiring facts that only exist in the
 * server module are pinned by reading its text.
 *
 * 🔴 ASSERTIONS ABOUT ABSENCE USE `codeOnly`. These files argue with
 * themselves at length in comments and quote the strings they removed;
 * a naive `not.toContain` would pass or fail on the explanation rather
 * than on the code. Same mistake `purchase-posting.test.ts` made twice.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { render, screen } from "@testing-library/react";
import {
  APPROVAL_POLICIES,
  BLOCKED_BECAUSE,
  REQUEST_PATHS,
  SELF_APPROVAL_WAIT_MINUTES,
  enforcementReport,
  gradeAtLeast,
  mayApprove,
  type ApprovalKind,
} from "@/lib/platform/approvals";
import { ApprovalPolicyBoard } from "@/components/platform/approval-policy-board";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** ⚠️ Comments blanked, line numbers preserved. See the header. */
const codeOnly = (s: string) =>
  s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));

const ENGINE = read("server/platform/approvals.ts");
const CONTROL = read("server/platform/control-actions.ts");
const REGISTRY = read("server/platform/approval-executors.ts");
const PAGE = read("app/platform/approvals/page.tsx");
const BOARD = read("components/platform/approval-policy-board.tsx");
const QUEUE = read("components/platform/approval-queue.tsx");
const TENANT_ACTIONS = read("components/platform/tenant-actions.tsx");

/**
 * ⚠️ ONE REGISTRY FILE SINCE BATCH 43. The registrations used to sit in
 * `control-actions.ts` beside the only two request paths. Three of the
 * five request paths are now inside the WRITING functions, which are
 * reachable from server actions that never import `control-actions.ts` —
 * and `queueForApproval` refuses a kind with no registered executor, so a
 * held write would have failed to queue.
 */
const registeredKinds = [
  ...codeOnly(REGISTRY).matchAll(/registerApprovalExecutor\(\s*"([a-z._]+)"/g),
].map((m) => m[1] as string);

/**
 * ⭐ EVERY KIND ACTUALLY HANDED TO `queueForApproval`, FOUND BY SCANNING
 * RATHER THAN BY NAMING FILES.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 A HAND-WRITTEN LIST OF WHERE REQUESTS ARE RAISED IS THE ARTEFACT
 *    THIS WHOLE SUITE EXISTS TO KILL
 * ══════════════════════════════════════════════════════════════════════
 * The first version of this constant read one file. That was fine while
 * one file could raise a request and became silently wrong the moment
 * another could: a policy wired from `flags.ts` would have been invisible
 * to the both-ways check below, which is precisely the drift the check is
 * for. So the directory is walked, and adding a request path anywhere
 * under `server/platform/` is caught wherever somebody puts it.
 */
const PLATFORM_DIR = join(ROOT, "server", "platform");
const queuedKinds = readdirSync(PLATFORM_DIR)
  .filter((f) => f.endsWith(".ts"))
  .flatMap((f) => {
    const source = codeOnly(readFileSync(join(PLATFORM_DIR, f), "utf8"));
    // ⚠️ Only `kind:` inside a `queueForApproval({ ... })` call counts.
    // `approvalGate({ kind: ... })` names the policy being CHECKED, which
    // is not the same fact — a gate can hold a write for a policy this
    // file does not raise.
    return [...source.matchAll(/queueForApproval\(\{/g)].flatMap((call) => {
      // ⚠️ A WINDOW, NOT A BRACE MATCHER. These call sites nest objects
      // several levels deep and a regex that tries to find the matching
      // `}` is a parser with no tests. The first `kind:` after the call
      // opens is the call's own, because every one of them puts it first.
      const window = source.slice(call.index, call.index + 2_000);
      const kind = /kind:\s*"([a-z._]+)"/.exec(window);
      return kind ? [kind[1] as string] : [];
    });
  });

/* ================================================================== */
/* ① THE DECLARATION CANNOT GO STALE                                   */
/* ================================================================== */

describe("the request-path table", () => {
  /**
   * 🔴 THIS IS THE ASSERTION THAT KEEPS THE WHOLE MECHANISM HONEST.
   *
   * Whether an executor exists is observed at runtime from the registry
   * map and cannot lie. Whether a REQUEST PATH exists cannot be
   * observed — a function that has never been called is
   * indistinguishable from one that does not exist — so `REQUEST_PATHS`
   * is written by hand, and a hand-written list of what the code does is
   * precisely the artefact that produced the original bug.
   *
   * ⚠️ SO IT IS PINNED IN BOTH DIRECTIONS. Wire a new kind through
   * `queueForApproval` without listing it, and this fails. List one that
   * nothing raises, and this fails too. The table cannot drift away from
   * the code in either direction without somebody being told.
   */
  it("matches the kinds the server actually queues, both ways", () => {
    expect(queuedKinds.length).toBeGreaterThan(0);
    expect(new Set(Object.keys(REQUEST_PATHS))).toEqual(new Set(queuedKinds));
  });

  /**
   * ⚠️ AND EVERY DECLARED PATH NAMES WHERE, NOT JUST THAT.
   *
   * ⭐ ASSERTED AS "NAMES A SERVER MODULE THAT EXISTS", not as "contains
   * control-actions.ts". Pinning the one file was right while one file
   * raised everything and became a lie the moment the hold moved into the
   * writing functions — and a test that pins yesterday's topology fails
   * on the improvement rather than on the regression.
   */
  it("says where each request is raised from, and the file is real", () => {
    for (const [kind, path] of Object.entries(REQUEST_PATHS)) {
      const named = [...(path ?? "").matchAll(/server\/platform\/[a-z-]+\.ts/g)].map(
        (m) => m[0],
      );
      expect(named.length, kind).toBeGreaterThan(0);
      for (const file of named) {
        expect(existsSync(join(ROOT, file)), `${kind} → ${file}`).toBe(true);
      }
      // A function name, not just a file: "somewhere in flags.ts" is not
      // an answer somebody can chase.
      expect(path, kind).toMatch(/[a-zA-Z]+\(\)/);
      expect((path ?? "").length, kind).toBeGreaterThan(30);
    }
  });

  /**
   * ⭐ EXHAUSTIVE BY TYPE AND BY TEST. `Record<ApprovalKind, string>`
   * makes the compiler demand an entry; this makes it a real sentence,
   * so a seventh policy cannot be added with `""` to silence tsc.
   */
  it("explains every policy that is not enforced", () => {
    for (const policy of APPROVAL_POLICIES) {
      if (REQUEST_PATHS[policy.kind] && registeredKinds.includes(policy.kind)) continue;
      const why = BLOCKED_BECAUSE[policy.kind];
      expect(why, policy.kind).toBeTruthy();
      expect(why.length, policy.kind).toBeGreaterThan(120);
      // ⚠️ The sentence has to name a precondition, not offer a mood.
      expect(
        /will apply|cannot|Nothing in this build|has to happen/.test(why),
        policy.kind,
      ).toBe(true);
    }
  });
});

/* ================================================================== */
/* ② THE REPORT SAYS WHAT IS TRUE, INCLUDING THE HALF-BUILT CASE       */
/* ================================================================== */

describe("enforcementReport", () => {
  const live = enforcementReport(registeredKinds);
  const by = (k: ApprovalKind) => live.find((p) => p.kind === k)!;

  it("covers every policy exactly once", () => {
    expect(live.map((p) => p.kind).sort()).toEqual(
      APPROVAL_POLICIES.map((p) => p.kind).sort(),
    );
  });

  /**
   * ⭐ THE FIRST ONE THAT WAS ACTUALLY WIRED, and still the reference
   * case. Both halves present, no caveat printed, and the caveat text is
   * BLANKED rather than merely hidden — a note that outlives its own fix
   * is how a screen starts lying in the other direction.
   */
  it("reports tenant.suspend as enforced and prints no caveat for it", () => {
    const p = by("tenant.suspend");
    expect(p.hasExecutor).toBe(true);
    expect(p.hasRequestPath).toBe(true);
    expect(p.enforced).toBe(true);
    expect(p.blockedBecause).toBe("");
    expect(p.requestPath).toContain("requestSuspend");
  });

  /**
   * 🔴🔴 THE HALF-BUILT CASE, AND THE REASON `enforced` IS NOT
   * `hasExecutor`.
   *
   * ⚠️ THIS USED TO BE A LIVE DEFECT AND IS NOW A HYPOTHETICAL, which is
   * the correct direction for it to move. `entitlement.override_paid` had
   * an executor and no request path: a queued row would have run, and
   * there was no way to create one, so the override took effect on the
   * click. Batch 43 gave it a request path inside the two functions that
   * write an `entitlement:` key.
   *
   * ⭐ THE RULE IT PROVED STILL HAS TO HOLD, so it is proved against a
   * constructed report rather than deleted with the bug. A report that
   * keyed off the registry alone would print "Enforced" next to something
   * nothing raises — a more confident lie than the one being fixed.
   */
  it("refuses to call an executor-only policy enforced", () => {
    const unraisable = APPROVAL_POLICIES.map((p) => p.kind).find(
      (k) => !REQUEST_PATHS[k],
    );
    expect(unraisable, "every policy now has a request path — read this test").toBeTruthy();

    const p = enforcementReport(APPROVAL_POLICIES.map((x) => x.kind)).find(
      (x) => x.kind === unraisable,
    )!;
    expect(p.hasExecutor).toBe(true);
    expect(p.hasRequestPath).toBe(false);
    expect(p.enforced).toBe(false);
    expect(p.blockedBecause.length).toBeGreaterThan(120);
  });

  /** And the mirror case: a request path with nothing to run it. */
  it("refuses to call a request-path-only policy enforced", () => {
    const hypothetical = enforcementReport([]);
    const p = hypothetical.find((x) => x.kind === "tenant.suspend")!;
    expect(p.hasRequestPath).toBe(true);
    expect(p.hasExecutor).toBe(false);
    expect(p.enforced).toBe(false);
  });

  /**
   * ⭐ AND IT UN-BLOCKS ITSELF. The day somebody registers an executor
   * AND adds the request path, the caveat disappears with no second edit
   * — which is the property that stops this report becoming the next
   * stale screen.
   */
  it("stops printing a caveat as soon as both halves exist", () => {
    const p = enforcementReport(["tenant.suspend"]).find(
      (x) => x.kind === "tenant.suspend",
    )!;
    expect(p.enforced).toBe(true);
    expect(p.blockedBecause).toBe("");
  });

  /**
   * ⚠️ DERIVED FROM THE TWO SOURCES, NOT TYPED AS A LITERAL.
   *
   * A hard-coded list here would be a third hand-maintained copy of the
   * same fact — the exact species of bug this suite exists to catch —
   * and it would break every time another batch legitimately wires a
   * policy up. What must hold is the RULE: enforced is precisely the
   * intersection of "has an executor" and "has a request path", with
   * nothing added by generosity on either side.
   *
   * 🔴 AND IT MUST NOT BE EVERYTHING. `toBeLessThan(APPROVAL_POLICIES
   * .length)` is not padding: the day it stops being true, this file's
   * whole reason for existing has been discharged and somebody should
   * come and read it rather than have it keep passing quietly.
   */
  it("counts as enforced exactly the policies with both halves", () => {
    const expected = APPROVAL_POLICIES.map((p) => p.kind)
      .filter((k) => registeredKinds.includes(k) && Boolean(REQUEST_PATHS[k]))
      .sort();
    expect(live.filter((p) => p.enforced).map((p) => p.kind).sort()).toEqual(expected);
    expect(expected).toContain("tenant.suspend");
    expect(expected.length).toBeLessThan(APPROVAL_POLICIES.length);
  });
});

/* ================================================================== */
/* ③ THE LIST RENDERS THE REPORT, NOT THE CONSTANT                     */
/* ================================================================== */

describe("the approvals screen", () => {
  it("no longer maps over the policy constant to build the list", () => {
    const code = codeOnly(PAGE);
    // 🔴 The exact expression that was the bug.
    expect(code).not.toContain("APPROVAL_POLICIES.map(");
    expect(code).not.toContain("APPROVAL_POLICIES");
    expect(code).toContain("getApprovalEnforcement()");
    expect(code).toContain("<ApprovalPolicyBoard");
  });

  /**
   * ⚠️ THE HEADING SENTENCE WAS PART OF THE CLAIM. "Six actions in the
   * whole console are held here rather than executed" is the line an
   * auditor quotes, and it was false. Asserted on the raw source
   * deliberately: this string must not come back in a comment either,
   * because a comment is where a reinstated sentence gets copied from.
   */
  it("does not claim six actions are held", () => {
    expect(PAGE).not.toContain("Six actions in the whole console are held");
  });

  /**
   * 🔴 THE QUEUE'S EMPTY STATE MADE THE SAME CLAIM in different words —
   * "the queue only catches suspension, deletion, plan changes and paid
   * overrides". Three of those four do not reach it.
   */
  it("does not list four things the queue catches when it catches one", () => {
    expect(codeOnly(QUEUE)).not.toContain(
      "catches suspension, deletion, plan changes and paid overrides",
    );
  });

  it("ships the board component it renders", () => {
    expect(existsSync(join(ROOT, "components/platform/approval-policy-board.tsx"))).toBe(
      true,
    );
  });
});

describe("the policy board, rendered", () => {
  const fixture = enforcementReport(registeredKinds);

  it("badges the enforced policy and only the enforced policy", () => {
    render(createElement(ApprovalPolicyBoard, { policies: fixture }));

    for (const p of fixture) {
      const badge = screen.getByTestId(`policy-status-${p.kind}`);
      if (p.enforced) {
        expect(badge.textContent, p.kind).toBe("Enforced");
      } else {
        // ⚠️ "Not enforced" as a prefix, so the two failure shapes can
        // add their own detail without weakening the headline word.
        expect(badge.textContent?.startsWith("Not enforced"), p.kind).toBe(true);
      }
    }
  });

  /**
   * ⭐⭐ THE PRECONDITION IS ON THE SCREEN, NOT IN A COMMENT. This is
   * the honest answer the batch was asked for: a policy that cannot be
   * enforced today says so, in place, with what has to exist first.
   */
  it("prints the precondition next to every unenforced policy", () => {
    render(createElement(ApprovalPolicyBoard, { policies: fixture }));

    for (const p of fixture) {
      if (p.enforced) {
        expect(screen.queryByTestId(`policy-blocked-${p.kind}`), p.kind).toBeNull();
        continue;
      }
      const block = screen.getByTestId(`policy-blocked-${p.kind}`);
      expect(block.textContent, p.kind).toContain("Not enforced today.");
      // The whole sentence, not a truncated hint.
      expect(block.textContent, p.kind).toContain(p.blockedBecause.slice(0, 60));
    }
  });

  /** ⚠️ Stated as a fraction, because "1" alone gets scrolled past. */
  it("leads with how many of the list are real", () => {
    render(createElement(ApprovalPolicyBoard, { policies: fixture }));
    const summary = screen.getByTestId("approval-enforcement-summary");
    expect(summary.textContent).toContain(
      `${fixture.filter((p) => p.enforced).length} of ${fixture.length}`,
    );
    expect(summary.textContent).toContain("Do not read this page as coverage");
  });

  /**
   * ══════════════════════════════════════════════════════════════════
   * 🔴🔴 THERE IS NO TOGGLE, AND ITS ABSENCE IS DELIBERATE
   * ══════════════════════════════════════════════════════════════════
   * The obvious way to make a policy list stop being decorative is a
   * switch per row. It is the wrong thing to build, twice over:
   *
   *   ① NOTHING PERSISTS IT. The policies are frozen constants compiled
   *      into the build; there is no platform-settings table and no
   *      migration in this batch. A switch would flip a value that
   *      resets on the next request — a more convincing lie than the
   *      one being fixed.
   *   ② IT IS THE CONTROL'S OWN FAILURE MODE. A four-eyes requirement
   *      an operator can disable is disabled at the moment it becomes
   *      inconvenient, which is the moment it exists for.
   *
   * ⭐ SO THIS ASSERTS THE ABSENCE RATHER THAN LEAVING IT TO CHANCE:
   * the board must not grow a dead affordance, which is the same defect
   * in a new place. It is a display, and the test says so.
   */
  it("has no affordance that does nothing", () => {
    const code = codeOnly(BOARD);
    for (const dead of ["onClick", "onChange", "onCheckedChange", "<Switch", "<Button"]) {
      expect(code, dead).not.toContain(dead);
    }
  });

  /**
   * And it tells the reader why there is no switch, rather than leaving
   * a hole for somebody to helpfully fill.
   *
   * ⚠️ MATCHED ON `textContent` OF A CONTAINER, not with `getByText`.
   * The sentence is deliberately split across a `<span className="font-
   * medium">` and the surrounding paragraph, and `getByText` matches
   * per-element — it would fail on the markup rather than on the words.
   */
  it("says out loud that none of this can be switched off from the console", () => {
    const { container } = render(
      createElement(ApprovalPolicyBoard, { policies: fixture }),
    );
    const text = (container.textContent ?? "").replace(/\s+/g, " ");
    expect(text).toContain("None of these can be switched off from this console");
    expect(text).toContain("no setting elsewhere that does it either");
    expect(text).toContain("disabled at the moment it becomes inconvenient");
  });
});

/* ================================================================== */
/* ④ AN UNENFORCEABLE KIND CANNOT BE QUEUED AT ALL                     */
/* ================================================================== */

describe("queueForApproval", () => {
  /**
   * 🔴 THE ONE WAY THIS QUEUE COULD FAKE ENFORCEMENT. Add a request
   * path for a policy with no executor and the screen fills with pending
   * rows: the operator sees a control working, and every one of those
   * rows is theatre — the action is not held pending approval, it is
   * simply never performed. Refusing at REQUEST time means a policy is
   * either enforceable end to end or visibly not offered.
   *
   * ⚠️ AND IT MOVES THE DISCOVERY EARLIER. Before this, the sequence was
   * raise → wait → find an owner → approve → "nothing in this build
   * knows how to carry that out". Two people, real time, nothing done.
   */
  it("refuses a kind with no registered executor, before it writes a row", () => {
    const code = codeOnly(ENGINE);
    const check = code.indexOf("if (!EXECUTORS.has(args.kind))");
    const insert = code.indexOf(".insert(platformApprovalQueue)");
    expect(check).toBeGreaterThan(-1);
    expect(insert).toBeGreaterThan(-1);
    expect(check).toBeLessThan(insert);
  });

  /** ⚠️ The approval-time check STAYS. A module can be removed while a
   *  request for it is still queued, and that row must not run. */
  it("still refuses to execute an approved row whose executor vanished", () => {
    const code = codeOnly(ENGINE);
    expect(code).toContain("const executor = EXECUTORS.get(row.actionKind);");
    expect(code).toContain("if (!executor) {");
  });
});

/* ================================================================== */
/* ⑤ FOUR EYES: THE APPROVER MUST BE SOMEBODY ELSE                     */
/* ================================================================== */

const NOW = new Date("2026-08-15T10:00:00Z");
const REQUESTER = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

describe("self-approval is refused server-side, not by hiding a button", () => {
  const base = {
    kind: "tenant.suspend",
    requestedBy: REQUESTER,
    requestedAt: new Date(NOW.getTime() - 60 * 60_000),
    approverGrade: "owner" as const,
    status: "pending",
    expiresAt: new Date(NOW.getTime() + 60 * 60_000),
    now: NOW,
  };

  /**
   * ⭐ THE ENGINE ALREADY DID THIS, AND IT IS WORTH RECORDING THAT IT
   * DID. `mayApprove` compares `approverId` with `requestedBy` in pure
   * code that the server calls before it touches the row, and migration
   * 0074 backs it with `CHECK (approver_id IS NULL OR approver_id <>
   * requested_by OR self_approved)` plus a trigger that enforces the
   * wait. The screen's disabled button is a courtesy on top of three
   * server-side layers, not the control itself.
   */
  it("refuses the requester while another eligible approver exists", () => {
    const v = mayApprove({ ...base, approverId: REQUESTER, soleOperator: false });
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.reason).toContain("Self-approval is only available");
  });

  it("allows a genuinely different approver with no wait at all", () => {
    const v = mayApprove({
      ...base,
      approverId: OTHER,
      requestedAt: NOW,
      soleOperator: false,
    });
    expect(v.allowed).toBe(true);
    expect(v.allowed && v.selfApproved).toBe(false);
  });

  /**
   * ⚠️ THE HATCH IS NAMED, NOT HIDDEN. A sole operator may approve their
   * own request after a wait, it is flagged in the row and in the log,
   * and the honest report of this batch says so rather than describing
   * the control as four eyes.
   */
  it("flags a sole operator's own approval as a self-approval", () => {
    const v = mayApprove({ ...base, approverId: REQUESTER, soleOperator: true });
    expect(v.allowed).toBe(true);
    expect(v.allowed && v.selfApproved).toBe(true);
  });

  it("holds the sole operator to the wait", () => {
    const v = mayApprove({
      ...base,
      approverId: REQUESTER,
      soleOperator: true,
      requestedAt: new Date(NOW.getTime() - (SELF_APPROVAL_WAIT_MINUTES - 1) * 60_000),
    });
    expect(v.allowed).toBe(false);
  });

  /**
   * 🔴 THE SERVER DOES NOT TRUST THE CALLER'S `soleOperator`. It was a
   * caller-supplied authorisation input, and the caller's answer was
   * also wrong — see the next block.
   */
  it("is recomputed inside decideApproval rather than taken from the caller", () => {
    const code = codeOnly(ENGINE);
    expect(code).toContain("countEligibleApprovers(");
    expect(code).toContain("soleOperator: otherEligible === 0,");
    expect(code).not.toContain("soleOperator: args.soleOperator,");
  });
});

/* ================================================================== */
/* ⑥ THE DEADLOCK: "SOMEBODY ELSE" HAD TO MEAN SOMEBODY WHO CAN        */
/* ================================================================== */

describe("who counts as a second pair of eyes", () => {
  /**
   * ══════════════════════════════════════════════════════════════════
   * 🔴🔴 ONE OWNER PLUS ONE SUPPORT ENGINEER BRICKED THE ENTIRE QUEUE
   * ══════════════════════════════════════════════════════════════════
   * `soleOperator` came from `countActiveOperators() <= 1`, which counts
   * every usable grant of every grade. Every policy needs `owner`. So
   * the day a second person of ANY grade was granted access:
   *
   *   · the owner who raised the request was refused with "there is
   *     another operator who can approve it";
   *   · that other operator was refused on grade.
   *
   * Nothing could be approved by anybody. Every request expired, four
   * hours at a time, and the refusal named somebody who could not help.
   * The predictable response is the one the whole mechanism exists to
   * prevent: somebody bypasses the queue.
   *
   * ⚠️ THIS IS ASSERTED ON `gradeAtLeast` — the same function the server
   * now filters with — rather than on prose, so it fails if the grade
   * ranking is ever loosened.
   */
  it("a support grant is not somebody an owner-grade policy can be asked of", () => {
    const policy = APPROVAL_POLICIES.find((p) => p.kind === "tenant.suspend")!;
    expect(policy.approverGrade).toBe("owner");
    expect(gradeAtLeast("support", policy.approverGrade)).toBe(false);
    expect(gradeAtLeast("engineer", policy.approverGrade)).toBe(false);
    expect(gradeAtLeast("owner", policy.approverGrade)).toBe(true);
  });

  /** ⭐ Every policy on the list is owner-grade, which is why the bug bit all six. */
  it("every policy needs owner grade, so a grade-blind count is wrong for all of them", () => {
    for (const p of APPROVAL_POLICIES) expect(p.approverGrade, p.kind).toBe("owner");
  });

  /**
   * ⚠️ THE REQUESTER IS EXCLUDED, NOT THE VIEWER. Excluding whoever
   * opened the screen would make the answer depend on who is looking,
   * and a second operator's genuine approval could be recorded as a
   * self-approval or vice versa.
   */
  it("excludes the requester and filters by grade, in the server", () => {
    const code = codeOnly(ENGINE);
    expect(code).toContain("g.id !== excludeStaffId && gradeAtLeast(g.grade, requiredGrade)");
    expect(code).toContain("status = 'active'");
    expect(code).toContain("revoked_at IS NULL");
    expect(code).toContain("expires_at IS NULL OR expires_at > now()");
  });

  /**
   * 🔴 THE SCREEN HAS TO REASON WITH THE SAME NUMBER. `approval-queue`
   * runs `mayApprove` locally purely so the refusal is printed before
   * the click; fed a different `soleOperator` it prints a sentence the
   * server disagrees with, which reads as a bug and gets routed around.
   */
  it("hands the same per-row number to the screen", () => {
    expect(codeOnly(ENGINE)).toContain("otherEligibleApprovers");
    expect(codeOnly(QUEUE)).toContain("soleOperator: row.otherEligibleApprovers === 0,");
    // ⚠️ The old list-wide prop is gone, not merely unused.
    expect(codeOnly(QUEUE)).not.toContain("soleOperator: boolean;");
    expect(codeOnly(PAGE)).not.toContain("soleOperator={result.data.soleOperator}");
  });
});

/* ================================================================== */
/* ⑦ A QUEUED ACTION MUST NOT READ AS A COMPLETED ONE                  */
/* ================================================================== */

describe("the suspend button's receipt", () => {
  /**
   * ══════════════════════════════════════════════════════════════════
   * 🔴🔴 `ok: true` MEANT BOTH "DONE" AND "QUEUED", AND THE UI PICKED
   *      THE CHEERFUL ONE
   * ══════════════════════════════════════════════════════════════════
   * `requestSuspend` writes a queue row and returns `ok: true` with a
   * note beginning "Nothing has happened yet." `TenantActions.run()`
   * discarded the note and raised `toast.success("Done.")`.
   *
   * ⚠️ THE OPERATOR THEN BELIEVES A LIVE WORKSPACE IS LOCKED. Either
   * they tell the customer it is done when it is not, or they walk away
   * from an incident they think they have contained. Nothing on the page
   * contradicts them: the tenant still says `active`, which reads as a
   * stale render.
   *
   * ⭐ THE FIX IS A TYPE, NOT A STRING. The queued path has its own
   * return shape with a REQUIRED `data.note`, so a future caller cannot
   * silently drop it the way this one did.
   */
  it("routes the suspend dialog through the queued runner", () => {
    const code = codeOnly(TENANT_ACTIONS);
    expect(code).toContain("runQueued(() =>");
    expect(code).toContain("props.onSuspend({");
    // 🔴 The exact shape of the bug: the generic runner wrapping onSuspend.
    expect(code).not.toMatch(/\brun\(\(\) =>\s*\n?\s*props\.onSuspend\(/);
  });

  it("gives the queued path a result type that carries the note", () => {
    const code = codeOnly(TENANT_ACTIONS);
    expect(code).toContain("type QueuedResult");
    expect(code).toContain("{ ok: true; data: { note: string } }");
    expect(code).toContain("Promise<QueuedResult>");
  });

  /**
   * ⚠️ NOT A SUCCESS TOAST, AND NOT ONLY A TOAST. Green with a tick is
   * read as "it worked", and a notification that fades in four seconds
   * loses the argument to a tenant row that still says `active`. The
   * sentence has to persist on the page.
   */
  it("does not report a queued suspension as a success", () => {
    const runner = codeOnly(TENANT_ACTIONS).slice(
      codeOnly(TENANT_ACTIONS).indexOf("function runQueued"),
      codeOnly(TENANT_ACTIONS).indexOf("return (", codeOnly(TENANT_ACTIONS).indexOf("function runQueued")),
    );
    expect(runner.length).toBeGreaterThan(50);
    expect(runner).not.toContain("toast.success");
    expect(runner).toContain("setQueuedNote(result.data.note)");
  });

  it("leaves a persistent notice saying the workspace is still running", () => {
    expect(codeOnly(TENANT_ACTIONS)).toContain('data-testid="suspend-queued-notice"');
    expect(TENANT_ACTIONS).toContain("has NOT been suspended");
    // ⭐ And a way to go and finish the job.
    expect(TENANT_ACTIONS).toContain("/platform/approvals");
  });

  /**
   * ⚠️ THE SERVER'S SENTENCE IS THE ONE SHOWN. A summary written in the
   * component would drift from it and would drop the expiry, which is
   * the part that matters when somebody comes back to it at 2am.
   */
  it("still says nothing has happened yet, in the server's own words", () => {
    expect(ENGINE).toContain("Nothing has happened yet.");
    expect(codeOnly(TENANT_ACTIONS)).toContain("{queuedNote}");
  });
});
