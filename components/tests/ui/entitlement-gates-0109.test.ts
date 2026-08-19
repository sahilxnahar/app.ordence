/**
 * Batch 0109 — THE PLANS NOW MEAN SOMETHING.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT EACH GROUP HERE WOULD HAVE CAUGHT
 * ══════════════════════════════════════════════════════════════════════
 *   1. the ledger's own blind spot — five keys refused by live code and
 *      recorded as refused by nothing, because the matcher knew six
 *      spellings and the code used a seventh;
 *   2. `hr.payroll` fully built, priced at Advanced, and free on the
 *      free tier;
 *   3. the trap in fixing (2) — a naive `requireFeature("hr.payroll")`
 *      would refuse payroll to a paying customer whose card expired,
 *      three days before the provident-fund deadline;
 *   4. a refusal that names no plan, which is an outage with better
 *      manners;
 *   5. the seat check drifting back outside its transaction.
 *
 * ⚠️ These assert PROPERTIES, not shapes. Nothing here pins a count, a
 * key list or a total — those change every time somebody ships a module,
 * and a test that fails on a correct change teaches people to delete
 * tests. What is pinned is the RULE.
 *
 * ⚠️ SOME OF THEM READ SOURCE, and that is deliberate rather than lazy.
 * The `ui` project runs in jsdom with no database by design, and the
 * defect in every case above was not a broken gate — it was an UNCALLED
 * one. A behavioural test of a gate nothing invokes passes forever. Same
 * reasoning as `tests/ui/billing-gate-wiring.test.ts`.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  FEATURE_KEYS,
  FEATURE_CATALOG,
  TIER_LABELS,
  TRIAL_EFFECTIVE_TIER,
  LAPSED_EFFECTIVE_TIER,
  evaluateFeature,
  type FeatureKey,
} from "@/lib/entitlements/features";
import {
  ENFORCEMENT_EVIDENCE,
  enforcedFeatures,
  unenforcedFeatures,
  enforcementEvidence,
} from "@/lib/entitlements/enforcement";
import {
  refusalFor,
  mustNamePlan,
  REFUSAL_REMEDIES,
} from "@/lib/entitlements/upgrade";
import { isExemptWrite } from "@/lib/billing/access-state";

const ROOT = process.cwd();

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === ".git") continue;
    const full = join(dir, entry);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Every server-side file, as `[relative path, contents]`. Read once. */
const SERVER_FILES: [string, string][] = [
  ...walk(join(ROOT, "server")),
  ...walk(join(ROOT, "app")),
].map((f) => [f.slice(ROOT.length + 1), readFileSync(f, "utf8")]);

/**
 * The body of one exported action, from its signature to the next export.
 *
 * ⚠️ Sliced rather than parsed. A parser would be more correct and would
 * also be a second thing to maintain; what is asserted is only whether a
 * guard line falls between two markers, which slicing answers exactly.
 */
function bodyOf(src: string, fn: string): string {
  const start = src.indexOf(`export async function ${fn}(`);
  if (start < 0) throw new Error(`no exported function called ${fn}`);
  const next = src.indexOf("\nexport async function ", start + 1);
  return src.slice(start, next < 0 ? undefined : next);
}

/* ================================================================== */
/* 1 · THE LEDGER CAN BE CHECKED, NOT JUST BELIEVED                    */
/* ================================================================== */

describe("🔴 the ledger's evidence is real", () => {
  it("records evidence for every key in the catalogue", () => {
    const missing = FEATURE_KEYS.filter((k) => !enforcementEvidence(k));
    expect(missing, "catalogue keys with no evidence recorded").toEqual([]);
  });

  it("names, for every gated key, a file that exists and contains the key", () => {
    // 🔴 THE LOAD-BEARING ONE. "gated" was a claim nothing could check
    // beyond a text search of the whole tree, which is how five wrong
    // entries survived. A gate that is moved or deleted now breaks the
    // build in the commit that moves it.
    const broken: string[] = [];
    for (const key of enforcedFeatures()) {
      const path = ENFORCEMENT_EVIDENCE[key];
      if (!existsSync(join(ROOT, path))) {
        broken.push(`${key}: ${path} does not exist`);
        continue;
      }
      if (!read(path).includes(`"${key}"`)) {
        broken.push(`${key}: ${path} does not mention the key`);
      }
    }
    expect(broken, "gated keys whose stated evidence is not there").toEqual([]);
  });

  it("gives every unenforced key a reason somebody wrote, not a placeholder", () => {
    // ⚠️ The old ledger gave thirty keys one identical sentence — "the
    // feature itself is not built yet" — and it was WRONG for five of
    // them. A shared reason is not a reason; it is a default wearing one.
    const lazy = unenforcedFeatures().filter((k) => {
      const reason = ENFORCEMENT_EVIDENCE[k];
      return reason.length < 60 || /the feature itself is not built yet/i.test(reason);
    });
    expect(lazy, "declared_only keys with a placeholder reason").toEqual([]);
  });

  it("does not reuse one reason across unrelated keys, except where it says so", () => {
    // Two keys may honestly share a reason — the CRM baselines do, and
    // they say "same ... as" out loud. What must not happen is thirty of
    // them silently sharing one.
    const counts = new Map<string, number>();
    for (const k of unenforcedFeatures()) {
      const r = ENFORCEMENT_EVIDENCE[k];
      counts.set(r, (counts.get(r) ?? 0) + 1);
    }
    const shared = [...counts.entries()].filter(([, n]) => n > 1).map(([r]) => r);
    expect(shared, "one reason copied across several keys").toEqual([]);
  });
});

/* ================================================================== */
/* 2 · THE CATCH-ALL THAT NEEDS NO KNOWLEDGE OF SPELLING               */
/* ================================================================== */

describe("🔴 a key nothing refuses is a key server code never mentions", () => {
  /**
   * ⚠️ THIS IS THE ONE THAT WOULD HAVE CAUGHT ALL FIVE.
   *
   * `hasServerGate` in `entitlement-enforcement.test.ts` recognises
   * spellings, so it can always be defeated by a spelling nobody thought
   * of — and it was, twice, by ordinary code:
   *
   *     const FEATURE_ORDERS = "sales.orders" as const;   // a constant
   *     features.add("workflows.scheduled");              // a set
   *
   * This asks a cruder question with no such hole: does the key appear in
   * server code AT ALL? A key the ledger says nothing reads should not be
   * findable in `server/` or `app/` in any form. If it is there, either
   * something reads it — in which case the ledger is wrong — or something
   * mentions it without acting on it, which is the "declared, displayed
   * and enforced by nothing" shape and needs looking at either way.
   */
  it("finds no declared_only key anywhere under server/ or app/", () => {
    const found: string[] = [];
    for (const key of unenforcedFeatures()) {
      for (const [path, src] of SERVER_FILES) {
        if (src.includes(`"${key}"`)) found.push(`${key} in ${path}`);
      }
    }
    expect(
      found,
      "keys the ledger calls unenforced that server code names anyway",
    ).toEqual([]);
  });

  it("finds every gated key somewhere under server/ or app/", () => {
    // The other direction, equally cheap: a gated key that server code
    // never names cannot possibly be refusing anything.
    const absent = enforcedFeatures().filter(
      (key) => !SERVER_FILES.some(([, src]) => src.includes(`"${key}"`)),
    );
    expect(absent, "gated keys no server file names").toEqual([]);
  });
});

/* ================================================================== */
/* 3 · PAYROLL REFUSES, AND REFUSES THE RIGHT HALF                     */
/* ================================================================== */

const PAYROLL = "server/actions/payroll.ts";
const ADVANCES = "server/actions/payroll-advances.ts";
const SELF = "server/actions/payroll-self.ts";
const GUARD = "requirePayrollEntitlement()";

describe("🔴 payroll is refused on a plan that does not include it", () => {
  it("guards every write that STARTS a payroll commitment", () => {
    // Hiring somebody, setting a salary, seeding the components and
    // opening a run are all new commitments on a module priced at
    // Advanced. `"use server"` publishes each of them as an endpoint
    // reachable with a session cookie and `curl`, whether or not the
    // menu shows payroll.
    const src = read(PAYROLL);
    for (const fn of [
      "saveEmployee",
      "seedPayrollSetup",
      "setPayStructure",
      "openPayrollRun",
    ]) {
      expect(bodyOf(src, fn), `${fn} has no entitlement gate`).toContain(GUARD);
    }
    const adv = read(ADVANCES);
    for (const fn of ["grantAdvance", "submitReimbursementClaim"]) {
      expect(bodyOf(adv, fn), `${fn} has no entitlement gate`).toContain(GUARD);
    }
  });

  it("guards NOTHING that finishes a run already open", () => {
    /**
     * 🔴 THE COUNTERWEIGHT, AND IT MATTERS MORE THAN THE GATE ITSELF.
     *
     * A plan change on the 12th must not strand a half-computed salary
     * run with PF, ESI and s.192 TDS already calculated against it. The
     * deadline for those does not move because a subscription did, and a
     * refusal at that point converts a billing problem into an unpaid
     * statutory liability belonging to the customer.
     */
    const src = read(PAYROLL);
    for (const fn of [
      "computePayrollRun",
      "approvePayrollRun",
      "postPayroll",
      "cancelPayrollRun",
    ]) {
      expect(bodyOf(src, fn), `${fn} must not be entitlement-gated`).not.toContain(
        GUARD,
      );
    }
    expect(
      bodyOf(read(ADVANCES), "recoverInstalment"),
      "recovering an agreed instalment must not be entitlement-gated",
    ).not.toContain(GUARD);
  });

  it("refuses no read, on any plan, ever", () => {
    /**
     * 🔴 THE DATA IS THEIRS. A workspace with four hundred employees that
     * drops to Basic still owns every payslip it ever issued, and its
     * people need those figures years later. `permitsExport()` returns
     * true at every access level for the same reason.
     */
    const src = read(PAYROLL);
    for (const fn of [
      "listEmployees",
      "getEmployeeStructure",
      "listPayComponents",
      "getPayrollLopPosition",
      "listPayrollRuns",
      "getPayrollRun",
      "payrollAccountsNeeded",
    ]) {
      expect(bodyOf(src, fn), `${fn} must stay readable`).not.toContain(GUARD);
    }
    expect(bodyOf(read(ADVANCES), "getAdvanceStatus")).not.toContain(GUARD);
    // The one read an ordinary employee may make: their own payslips.
    expect(read(SELF)).not.toContain(GUARD);
  });
});

describe("🔴 the payroll gate asks what was CONTRACTED, not what is in force", () => {
  it("would refuse a paying customer if it used the tier in force", () => {
    /**
     * ⚠️ THIS TEST DOCUMENTS THE TRAP RATHER THAN THE FIX, because the
     * trap is invisible and the fix is one word.
     *
     * `effectiveTier()` drops a lapsed workspace to `basic`. So the
     * obvious implementation — `requireFeature("hr.payroll")` — refuses
     * payroll to an Advanced customer whose card failed. Card fails on
     * the 5th; PF and ESI are due on the 15th; s.192 TDS on the 7th.
     */
    const naive = evaluateFeature("hr.payroll", {
      planTier: "advanced",
      subscriptionGrantsAccess: false,
    });
    expect(naive.allowed, "the naive gate would refuse a lapsed payer").toBe(false);
    expect(LAPSED_EFFECTIVE_TIER).toBe("basic");
  });

  it("allows the same workspace when asked about the tier it bought", () => {
    const contracted = evaluateFeature("hr.payroll", {
      planTier: "advanced",
      subscriptionGrantsAccess: true,
    });
    expect(contracted.allowed).toBe(true);
  });

  it("still refuses a plan that never included payroll", () => {
    // Or the gate is decoration. This is the whole commercial point.
    expect(
      evaluateFeature("hr.payroll", {
        planTier: "basic",
        subscriptionGrantsAccess: true,
      }).allowed,
    ).toBe(false);
  });

  it("lets a trial run payroll, or a prospect cannot evaluate it", () => {
    expect(
      evaluateFeature("hr.payroll", {
        planTier: TRIAL_EFFECTIVE_TIER,
        subscriptionGrantsAccess: true,
      }).allowed,
    ).toBe(true);
  });

  it("still honours a deliberate revoke at any tier", () => {
    // An override is a human act for a stated reason — abuse, a
    // regulatory hold. Billing standing must not be able to override it,
    // in either direction.
    const revoked = evaluateFeature("hr.payroll", {
      planTier: "enterprise",
      subscriptionGrantsAccess: true,
      overrides: { "hr.payroll": false },
    });
    expect(revoked.allowed).toBe(false);
    expect(revoked.reason).toBe("revoked_by_override");
  });

  it("reads the contracted tier in the source, not the tier in force", () => {
    // ⚠️ Source-level, because the difference between `planTier` and
    // `effectiveTier` is one identifier and every behavioural test above
    // would keep passing if somebody swapped it — they exercise the pure
    // engine, not the module that chooses which tier to hand it.
    const src = read("server/payroll/entitlement.ts");
    expect(src).toContain("entitlements.planTier");
    expect(src, "the lapse-adjusted tier must not reach this gate").not.toContain(
      "entitlements.effectiveTier",
    );
    expect(src).toContain("subscriptionGrantsAccess: true");
  });

  it("agrees with the statutory exemptions the dunning ladder already makes", () => {
    /**
     * ⭐ THE TWO SYSTEMS HAVE TO SAY THE SAME THING.
     *
     * `lib/billing/grace.ts` exempts every `payroll:` write from the
     * read-only restriction. If the entitlement gate then refused the
     * same operations for the same reason, the exemption would be
     * decoration — the customer would be told "your plan does not include
     * payroll" instead of "your account is past due", and both would be
     * happening because of one unpaid invoice.
     */
    for (const operation of ["payroll:approve", "payroll:post", "payroll:run"]) {
      expect(isExemptWrite(operation), `${operation}`).toBe(true);
    }
    const src = read(PAYROLL);
    for (const fn of ["approvePayrollRun", "postPayroll"]) {
      expect(bodyOf(src, fn)).not.toContain(GUARD);
    }
  });
});

/* ================================================================== */
/* 4 · A REFUSAL NAMES THE PLAN AND THE PERSON WHO CAN ACT             */
/* ================================================================== */

describe("🔴 the upgrade path is honest", () => {
  it("names the plan on every refusal where a plan is the remedy", () => {
    for (const key of FEATURE_KEYS) {
      const decision = evaluateFeature(key, {
        planTier: "basic",
        subscriptionGrantsAccess: true,
      });
      if (decision.allowed) continue;
      const refusal = refusalFor(decision, null);
      if (!mustNamePlan(refusal.remedy)) continue;
      const plan = TIER_LABELS[FEATURE_CATALOG[key].minTier];
      expect(refusal.sentence, `${key} does not name ${plan}`).toContain(plan);
      expect(refusal.href, `${key} offers no way to act`).not.toBeNull();
    }
  });

  it("never offers an upgrade for something a human switched off", () => {
    // 🔴 The customer may already be paying for the tier that includes
    // this. Inviting them to buy it again is the worst response
    // available, and it is the one a single shared message would give.
    const revoked = refusalFor(
      evaluateFeature("accounting.ledger", {
        planTier: "enterprise",
        subscriptionGrantsAccess: true,
        overrides: { "accounting.ledger": false },
      }),
      null,
    );
    expect(revoked.remedy).toBe("contact_support");
    expect(revoked.href, "an upgrade link would be the wrong remedy").toBeNull();
  });

  it("leads with the data, not with a price, when a card has failed", () => {
    const lapsed = refusalFor(
      evaluateFeature("accounting.ledger", {
        planTier: "advanced",
        subscriptionGrantsAccess: false,
      }),
      { level: "warning", daysRemaining: 3 },
    );
    expect(lapsed.remedy).toBe("restore_payment");
    expect(lapsed.sentence).toMatch(/safe/i);
    // The clock is stated, because it is the fact that decides what they do.
    expect(lapsed.sentence).toContain("3 days");
  });

  it("does not invent a deadline when there is none", () => {
    // ⚠️ A countdown on a `full` account is a threat we do not mean.
    const quiet = refusalFor(
      evaluateFeature("accounting.ledger", {
        planTier: "advanced",
        subscriptionGrantsAccess: false,
      }),
      { level: "full", daysRemaining: 9 },
    );
    expect(quiet.sentence).not.toContain("9 days");
  });

  it("survives a standing it could not resolve", () => {
    // `server/billing/access.ts` fails open; a refusal that threw while
    // explaining itself would put an error page where a paywall belongs.
    const decision = evaluateFeature("accounting.ledger", {
      planTier: "basic",
      subscriptionGrantsAccess: true,
    });
    expect(() => refusalFor(decision, null)).not.toThrow();
    expect(refusalFor(decision, undefined).sentence.length).toBeGreaterThan(20);
  });

  it("does not send somebody shopping for a key that does not exist", () => {
    const bogus = refusalFor(
      evaluateFeature("not.a.real.key", {
        planTier: "enterprise",
        subscriptionGrantsAccess: true,
      }),
      null,
    );
    expect(bogus.remedy).toBe("unavailable");
    expect(bogus.href).toBeNull();
    expect(bogus.sentence).toMatch(/defect/i);
  });

  it("can produce every remedy it declares, from a real decision", () => {
    /**
     * ⚠️ A DECLARED VALUE NO PATH PRODUCES IS A BRANCH NOBODY HAS
     * THOUGHT ABOUT. `REFUSAL_REMEDIES` is the closed list; this walks
     * the four ways a workspace can be refused and checks the list is
     * exactly covered — no remedy unreachable, none produced that the
     * list does not name.
     */
    const produced = new Set([
      refusalFor(
        evaluateFeature("accounting.ledger", {
          planTier: "advanced",
          subscriptionGrantsAccess: true,
        }),
        null,
      ).remedy,
      refusalFor(
        evaluateFeature("accounting.ledger", {
          planTier: "basic",
          subscriptionGrantsAccess: true,
        }),
        null,
      ).remedy,
      refusalFor(
        evaluateFeature("accounting.ledger", {
          planTier: "advanced",
          subscriptionGrantsAccess: false,
        }),
        null,
      ).remedy,
      refusalFor(
        evaluateFeature("accounting.ledger", {
          planTier: "advanced",
          subscriptionGrantsAccess: true,
          overrides: { "accounting.ledger": false },
        }),
        null,
      ).remedy,
      refusalFor(
        evaluateFeature("nope.nope", {
          planTier: "advanced",
          subscriptionGrantsAccess: true,
        }),
        null,
      ).remedy,
    ]);
    expect([...produced].sort()).toEqual([...REFUSAL_REMEDIES].sort());
  });

  it("is the sentence the thrown error actually carries", () => {
    // ⚠️ Everything that catches `FeatureLockedError` flattens it to
    // `err.message`. If the constructor used the shorter
    // `decision.message` instead, all of the above would be computed and
    // then discarded one line later at every call site in the product.
    const src = read("server/entitlements.ts");
    expect(src).toContain("super(refusalFor(decision, standing).sentence)");
  });
});

/* ================================================================== */
/* 5 · THE AI SURFACE IS BEHIND THE TIER IT IS SOLD ON                 */
/* ================================================================== */

describe("🔴 the assistant no longer answers on every plan", () => {
  it("gates the chat route, which is what a cookie and curl reach", () => {
    const src = read("app/api/assistant/route.ts");
    expect(src).toContain('checkFeature("ai.copilot"');
    // 402, not 403: a plan boundary, not a permission one.
    expect(src).toContain("status: 402");
  });

  it("gates the goal planner BEFORE it parses a body it would pay for", () => {
    const src = read("app/api/assistant/goal-planner/route.ts");
    const gate = src.indexOf('checkFeature("ai.copilot"');
    const spend = src.indexOf("tenantChatCompletion({");
    expect(gate).toBeGreaterThan(-1);
    expect(gate, "the gate must precede the model call").toBeLessThan(spend);
  });

  it("gates the writes that create an agent, and not the record of what it did", () => {
    const src = read("server/actions/agents.ts");
    for (const fn of ["installAgent", "editAgent", "bindAgentTrigger"]) {
      expect(bodyOf(src, fn), `${fn}`).toContain("requireFeature(AI_FEATURE)");
    }
    for (const fn of ["getAgentShelf", "getAgentRuns"]) {
      expect(bodyOf(src, fn), `${fn} must stay readable`).not.toContain(
        "requireFeature(AI_FEATURE)",
      );
    }
  });

  it("gates the MCP surface for reads as well as writes", () => {
    /**
     * ⚠️ THE DISTINCTION THE NEIGHBOURING GATE MAKES DOES NOT APPLY HERE.
     *
     * The standing check at step 4b exempts read tools deliberately: a
     * lapsed customer must still see their own data. This gate asks
     * whether the AI tier was ever BOUGHT, and a read tool on an unbought
     * tier is the product being given away — the records themselves are
     * reachable in full through the browser.
     *
     * So the entitlement check must sit OUTSIDE the `read_write` branch.
     * Moving it inside would be a one-line change that leaks the whole
     * read surface and breaks no other test.
     */
    const src = read("server/mcp/dispatch.ts");
    const gate = src.indexOf('checkFeatureForTenant(session.tenantId, "ai.rag")');
    const writeOnly = src.indexOf('if (tool.scope === "read_write")');
    expect(gate).toBeGreaterThan(-1);
    expect(writeOnly).toBeGreaterThan(-1);
    expect(gate, "the AI entitlement must not sit inside the write-only branch")
      .toBeLessThan(writeOnly);
  });

  it("stops advertising the assistant to plans that cannot use it", () => {
    // Not a gate — the gate is the route. This is the menu telling the
    // truth, which is the difference between a locked door and a door
    // that is not drawn on the map.
    const registry = read("lib/modules/registry.ts");
    const block = registry.slice(
      registry.indexOf('navId: "assistant"'),
      registry.indexOf('navId: "assistant"') + 900,
    );
    expect(block).toContain('feature: "ai.copilot"');
    expect(block).not.toContain("feature: null");
  });
});

/* ================================================================== */
/* 6 · THE SEAT COUNT IS STILL INSIDE THE TRANSACTION                  */
/* ================================================================== */

describe("🔴 the seat guard has not drifted back out of its transaction", () => {
  /**
   * ⚠️ ASKED FOR EXPLICITLY, AND NOT ASSUMED.
   *
   * `requireSeat()` once ran on the line BEFORE the update — two
   * connections, two snapshots. Two admins reinstating two people at once
   * both read "4 of 5", both passed, both wrote. A `curl` replay did the
   * same on its own.
   *
   * The race cannot be reproduced in jsdom with no database, so what is
   * asserted is the ORDER of three markers in the source. That is exactly
   * the property that was wrong, and it is the one a refactor would
   * silently undo.
   */
  const src = read("server/actions/team.ts");

  it("opens the transaction, then counts, then writes — in that order", () => {
    const tx = src.indexOf("withTenant(ctx.tenant.id, async (tx) => {");
    const guard = src.indexOf("requireSeatTx(");
    const write = src.indexOf(".update(users)", guard);

    expect(tx, "the seat write should open its own transaction").toBeGreaterThan(-1);
    expect(guard, "the seat guard should be inside it").toBeGreaterThan(tx);
    expect(write, "the seat should be taken after it is counted").toBeGreaterThan(
      guard,
    );
  });

  it("counts on the transaction handle, never on a fresh connection", () => {
    // 🔴 The whole fix is the first argument. `requireSeatTx(tx, ...)`
    // shares the writer's snapshot; a `db` read inside the same function
    // would take a second connection and restore the race while looking
    // identical at the call site.
    expect(src).toMatch(/requireSeatTx\(\s*tx\s*,/);

    const seats = read("server/billing/seats.ts");
    const fn = seats.slice(seats.indexOf("export async function requireSeatTx("));
    const body = fn.slice(0, fn.indexOf("\nexport "));
    expect(body).toContain("await tx");
    expect(body, "the count must not open its own connection").not.toContain(
      "await db",
    );
  });

  it("refuses by throwing, so the transaction cannot commit around it", () => {
    // A verdict returned rather than thrown is a verdict a caller can
    // forget to read, and the row is written anyway.
    const seats = read("server/billing/seats.ts");
    expect(seats).toContain("throw new SeatLimitError(verdict)");
  });
});

/* ================================================================== */
/* 7 · THE NEWLY GATED MODULES REFUSE WRITES AND NOT READS             */
/* ================================================================== */

describe("🔴 every gate added by 0109 sits on a write", () => {
  const CASES: [file: string, write: string, read: string, guard: string][] = [
    [
      "server/actions/documents.ts",
      "createContract",
      "listDocumentRegister",
      'requireFeature("clm.contracts"',
    ],
    [
      "server/actions/documents.ts",
      "assembleDocument",
      "verifyContractIntegrity",
      'requireFeature("clm.document_assembly"',
    ],
    [
      "server/actions/assets.ts",
      "createAsset",
      "getRecentAssets",
      'requireFeature("assets.catalog"',
    ],
    [
      "server/actions/batches.ts",
      "updateBatch",
      "getBatches",
      "requireFeature(TRACEABILITY)",
    ],
    [
      "server/actions/stock-counts.ts",
      "openCount",
      "getCounts",
      "requireFeature(TRACEABILITY)",
    ],
  ];

  it.each(CASES)("%s: %s refuses, %s does not", (file, write, readFn, guard) => {
    const src = read(file);
    expect(bodyOf(src, write), `${write} has no gate`).toContain(guard);
    expect(bodyOf(src, readFn), `${readFn} must stay readable`).not.toContain(guard);
  });

  it("turns a locked feature into a sentence, not into 'something went wrong'", () => {
    /**
     * 🔴 A GATE WHOSE REFUSAL FALLS THROUGH TO A GENERIC ERROR IS AN
     * OUTAGE WITH BETTER MANNERS.
     *
     * Both of these files map unknown errors to "Something went wrong.
     * Please try again." Without an explicit branch, the carefully
     * computed sentence naming the plan is replaced by an apology, and
     * the reader's next move is to press the button again.
     */
    for (const file of ["server/actions/assets.ts", "server/actions/documents.ts"]) {
      expect(read(file), file).toContain(
        "if (err instanceof FeatureLockedError) return fail(err.message);",
      );
    }
  });
});

/* ================================================================== */
/* 8 · WHAT 0109 DID NOT DO IS WRITTEN DOWN                            */
/* ================================================================== */

describe("the holes left open are named rather than left to be found", () => {
  it("says out loud that a revoke on the CRM baselines does nothing", () => {
    // ⚠️ The previous reason claimed a gate "could never refuse" these.
    // That stopped being true when per-tenant overrides shipped, and the
    // ledger went on saying it. A known hole with a named cause is a
    // different thing from a reassurance that is wrong.
    //
    // ⭐ `crm.contacts` LEFT THIS LIST WHEN THE SCHEDULER LANDED. Brief C's
    // nightly rhythm recompute gates on it, and `tenantAllowsFeature` in
    // `server/scheduling/entitlement.ts` reads the per-tenant override —
    // so on that ONE path a revoke now refuses something. It is asserted
    // separately below rather than dropped, because the hole it left is
    // narrower and not closed.
    for (const key of ["crm.companies", "crm.deals"] as FeatureKey[]) {
      expect(ENFORCEMENT_EVIDENCE[key], key).toMatch(/override/i);
    }
  });

  it("🔴 and crm.contacts's remaining hole is still named, in the ledger's own source", () => {
    /**
     * ⚠️ THE EVIDENCE STRING CANNOT CARRY IT. For a `gated` key that
     * field is a FILE PATH, checked with `existsSync` by the load-bearing
     * test above, so a sentence there would break the check that makes
     * "gated" mean anything.
     *
     * 🔴 SO THE CAVEAT LIVES ON THE STATUS ENTRY AND THIS ASSERTS IT IS
     * THERE. `crm.contacts` is gated by ONE unattended path. Every
     * interactive CRM write still ignores a per-tenant revoke, and a
     * reader who saw only "gated" would conclude the opposite.
     */
    const ledger = read("lib/entitlements/enforcement.ts");
    const entry = ledger.slice(
      ledger.indexOf("GATED SINCE BRIEF C LANDED"),
      ledger.indexOf('"crm.contacts": "gated"'),
    );
    expect(entry.length, "the crm.contacts note has moved or gone").toBeGreaterThan(200);
    expect(entry).toMatch(/INTERACTIVE/i);
    expect(entry).toMatch(/unattended/i);
    expect(entry).toMatch(/READS ARE UNTOUCHED/i);
  });

  it("⭐ the scheduler's gate reads the override, or the claim above is false", () => {
    /**
     * 🔴 THIS IS THE ASSERTION THE WHOLE RECLASSIFICATION RESTS ON. If
     * `tenantAllowsFeature` stopped reading `platform_tenant_flags`, the
     * ledger would say `crm.contacts` is gated and nothing anywhere would
     * refuse — which is the exact defect this file exists to catch,
     * reintroduced by the fix for it.
     */
    const gate = read("server/scheduling/entitlement.ts");
    expect(gate).toContain("ENTITLEMENT_OVERRIDE_PREFIX");
    expect(gate).toContain("platformTenantFlags");
    expect(read("server/scheduling/registry.ts")).toContain('"crm.contacts"');
  });

  it("marks the enterprise line items that are sold and do not exist", () => {
    for (const key of [
      "admin.sso",
      "admin.white_label",
      "admin.data_residency",
    ] as FeatureKey[]) {
      expect(ENFORCEMENT_EVIDENCE[key], key).toMatch(/not built/i);
    }
  });

  it("still refuses to gate a customer's own export", () => {
    // 🔴 The one key in the catalogue that must never move to `gated`.
    expect(ENFORCEMENT_EVIDENCE["analytics.export"]).toMatch(/never/i);
    expect(unenforcedFeatures()).toContain("analytics.export");
  });
});
