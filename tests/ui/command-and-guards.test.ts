/**
 * Ordence — ⭐⭐⭐ THE FOURTH GATE AND THE MORNING SUMMARY
 * Version: v1.26.0-alpha · Batch 18
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE GATE FOUND FOUR BUGS IN ITSELF BEFORE IT FOUND ANY IN THE CODE
 * ══════════════════════════════════════════════════════════════════════
 * Every one of them produced CONFIDENT, SPECIFIC, WRONG findings against
 * the most carefully-written code in the repository, and every "fix"
 * would have made that code worse. They are asserted here by name,
 * because a static-analysis gate that regresses silently is a gate that
 * starts lying and keeps its reputation.
 */

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  DUE_SOON_DAYS,
  SHOWN_BY_DEFAULT,
  daysBetween,
  digest,
  rankExceptions,
  scoreOf,
  stateFor,
  type ExceptionSignal,
} from "@/lib/command/exceptions";
import { lastCompletedMonthEnd, taxPeriodOf } from "@/server/command/sweep";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

function signal(over: Partial<ExceptionSignal> = {}): ExceptionSignal {
  return {
    key: "k",
    kind: "test",
    headline: "something",
    amountMinor: null,
    deadline: null,
    state: "watch",
    compounds: false,
    consequence: "it costs something",
    where: "/somewhere",
    ...over,
  };
}

/* ================================================================== */
/* ⭐⭐⭐ THE RANKING                                                   */
/* ================================================================== */

describe("ranking by consequence rather than by amount", () => {
  /**
   * ⭐⭐⭐ THE WORKED EXAMPLE THE WHOLE ENGINE EXISTS FOR.
   *
   * ₹4,000 of provident fund one day late attracts interest under 7Q AND
   * damages under 14B that can reach the contribution itself, and none
   * of it is undone by paying tomorrow. ₹40 lakh of receivable nine days
   * late is a phone call.
   *
   * A dashboard sorted by amount puts the receivable first by a factor
   * of a thousand. This one does not.
   */
  it("puts a small compounding statutory default above a huge late invoice", () => {
    const pf = signal({
      key: "pf",
      amountMinor: 400_000n, // ₹4,000
      state: "overdue",
      compounds: true,
    });
    const invoice = signal({
      key: "inv",
      amountMinor: 400_000_000n, // ₹40,00,000
      state: "overdue",
      compounds: false,
    });

    const [first] = rankExceptions([invoice, pf]);
    expect(first!.key).toBe("pf");
  });

  /**
   * ⚠️ AND NO AMOUNT MAY CROSS A BAND. The bands are 1,000 apart and the
   * money weight is capped at 400 — so "due in five days" can never
   * outrank "late", whatever the sums involved.
   */
  it("never lets money lift a due_soon above an overdue", () => {
    const enormousSoon = signal({
      key: "a",
      amountMinor: 99_999_999_999n,
      state: "due_soon",
      compounds: true,
    });
    const tinyLate = signal({ key: "b", amountMinor: 1n, state: "overdue" });
    expect(scoreOf(tinyLate)).toBeGreaterThan(scoreOf(enormousSoon));
  });

  /**
   * 🔴 A MISSED WINDOW SORTS BELOW A WATCH ITEM, WHICH LOOKS WRONG AND
   * IS NOT.
   *
   * It is the most emotive line on the page and the least actionable —
   * nothing can be done about it today. Putting it first means the first
   * thing somebody reads every morning is a thing they cannot fix, which
   * is how a page stops being read at all.
   */
  it("sinks a missed window below everything still actionable", () => {
    const missed = signal({
      key: "m",
      state: "missed",
      compounds: true,
      amountMinor: 10_000_000n,
    });
    const watch = signal({ key: "w", state: "watch", amountMinor: 1n });
    const [first] = rankExceptions([missed, watch]);
    expect(first!.key).toBe("w");
  });

  it("breaks ties on the key so the order does not move between refreshes", () => {
    const a = signal({ key: "aaa", state: "watch" });
    const z = signal({ key: "zzz", state: "watch" });
    expect(rankExceptions([z, a]).map((s) => s.key)).toEqual(["aaa", "zzz"]);
    expect(rankExceptions([a, z]).map((s) => s.key)).toEqual(["aaa", "zzz"]);
  });

  it("money still breaks ties inside a band", () => {
    const big = signal({ key: "a", state: "overdue", amountMinor: 100_000_000n });
    const small = signal({ key: "b", state: "overdue", amountMinor: 100n });
    expect(rankExceptions([small, big])[0]!.key).toBe("a");
  });

  it("treats a null amount as no money rather than as zero-ranked", () => {
    expect(() => scoreOf(signal({ amountMinor: null }))).not.toThrow();
    expect(scoreOf(signal({ amountMinor: null }))).toBe(
      scoreOf(signal({ amountMinor: 0n })),
    );
  });
});

/* ================================================================== */
/* THE DIGEST                                                          */
/* ================================================================== */

describe("the digest", () => {
  /**
   * ⭐ THE PAGE HAS TO BE ABLE TO BE EMPTY. A dashboard that always
   * finds something is manufacturing work.
   */
  it("says so plainly when there is nothing to do", () => {
    const d = digest([]);
    expect(d.allClear).toBe(true);
    expect(d.actionableCount).toBe(0);
    expect(d.headline).toBe("Nothing needs attention today.");
  });

  /**
   * ⚠️ "MISSED" IS NOT ACTIONABLE AND IS NOT COUNTED AS SUCH. A page
   * reporting "3 things need attention" where none can be acted on has
   * just lied about somebody's morning.
   */
  it("is all-clear even with missed items, and says why they are there", () => {
    const d = digest([signal({ key: "m", state: "missed" })]);
    expect(d.allClear).toBe(true);
    expect(d.actionableCount).toBe(0);
    expect(d.headline).toContain("already passed their date");
  });

  it("leads with the most consequential item, not with a count", () => {
    const d = digest([
      signal({ key: "a", state: "watch", headline: "a watch thing" }),
      signal({
        key: "b",
        state: "overdue",
        compounds: true,
        headline: "PF for July is 2 days late",
      }),
    ]);
    expect(d.headline).toContain("PF for July is 2 days late");
    expect(d.headline).toContain("1 other");
  });

  /**
   * 🔴 NO SILENT CAPS. A truncated list reads as "that is everything",
   * and the thirteenth-most-urgent item is exactly the one a busy
   * morning drops.
   */
  it("says what it dropped when it caps the list", () => {
    const many = Array.from({ length: SHOWN_BY_DEFAULT + 4 }, (_, i) =>
      signal({ key: `k${String(i).padStart(3, "0")}`, state: "watch" }),
    );
    const d = digest(many);
    expect(d.shown).toHaveLength(SHOWN_BY_DEFAULT);
    expect(d.hiddenCount).toBe(4);
    expect(d.hiddenNote).toContain("4 more not shown");
  });

  /** ⚠️ And says nothing at all when nothing was dropped. */
  it("has no hidden note when everything fits", () => {
    expect(digest([signal()]).hiddenNote).toBeNull();
  });

  it("totals only what can still be acted on", () => {
    const d = digest([
      signal({ key: "a", state: "overdue", amountMinor: 100n }),
      signal({ key: "b", state: "missed", amountMinor: 900n }),
    ]);
    expect(d.totalAtStakeMinor).toBe(100n);
  });
});

/* ================================================================== */
/* DEADLINES                                                           */
/* ================================================================== */

describe("deriving state from a deadline", () => {
  it("counts whole days in both directions", () => {
    expect(daysBetween("2026-08-14", "2026-08-20")).toBe(6);
    expect(daysBetween("2026-08-20", "2026-08-14")).toBe(-6);
    expect(daysBetween("2026-08-14", "2026-08-14")).toBe(0);
  });

  it("crosses a month and a year boundary correctly", () => {
    expect(daysBetween("2026-01-30", "2026-02-02")).toBe(3);
    expect(daysBetween("2025-12-30", "2026-01-02")).toBe(3);
  });

  it("calls the deadline day itself closing_today", () => {
    expect(stateFor({ deadline: "2026-08-14", today: "2026-08-14" })).toBe("closing_today");
  });

  it("is due_soon inside the window and watch outside it", () => {
    expect(stateFor({ deadline: "2026-08-19", today: "2026-08-14" })).toBe("due_soon");
    expect(stateFor({ deadline: "2026-08-20", today: "2026-08-14" })).toBe("watch");
    expect(DUE_SOON_DAYS).toBe(5);
  });

  /**
   * 🔴 THE DISTINCTION `graceDays` DOES NOT MAKE AND `closesPermanently`
   * DOES. A GST payment stays fixable forever at increasing cost; a
   * section 34 credit note does not. Telling somebody to stop trying at
   * the moment they still could is the worse of the two errors.
   */
  it("separates a window that closes forever from one that is merely late", () => {
    expect(stateFor({ deadline: "2026-08-01", today: "2026-08-14" })).toBe("overdue");
    expect(
      stateFor({ deadline: "2026-08-01", today: "2026-08-14", closesPermanently: true }),
    ).toBe("missed");
  });

  it("is watch when there is no deadline at all", () => {
    expect(stateFor({ deadline: null, today: "2026-08-14" })).toBe("watch");
  });
});

/* ================================================================== */
/* ⚠️ THE PERIOD THE SWEEP READS                                       */
/* ================================================================== */

describe("the sweep reads the month that has finished", () => {
  /**
   * ⚠️ EVERY INDIAN STATUTORY OBLIGATION IS "THE MONTH JUST GONE, BY THE
   * Nth OF THIS ONE". Computing against the CURRENT month would warn
   * about July's provident fund while it is still July — a liability
   * that has not finished accruing.
   */
  it("takes the previous month end, not this month", () => {
    expect(lastCompletedMonthEnd("2026-08-14")).toBe("2026-07-31");
    expect(taxPeriodOf(lastCompletedMonthEnd("2026-08-14"))).toBe("2026-07");
  });

  it("handles the first of a month", () => {
    expect(lastCompletedMonthEnd("2026-08-01")).toBe("2026-07-31");
  });

  it("crosses the year boundary", () => {
    expect(lastCompletedMonthEnd("2026-01-09")).toBe("2025-12-31");
  });

  it("gets February right in a leap year and a common one", () => {
    expect(lastCompletedMonthEnd("2028-03-05")).toBe("2028-02-29");
    expect(lastCompletedMonthEnd("2026-03-05")).toBe("2026-02-28");
  });
});

/* ================================================================== */
/* 🔴🔴🔴 THE FOURTH GATE                                              */
/* ================================================================== */

describe("check:guards passes, and keeps its own bugs fixed", () => {
  it("is green against the tree as it stands", () => {
    const out = execFileSync("node", ["scripts/check-action-guards.mjs"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(out).toContain("Action guards intact");
  });

  const gate = () => read("scripts/check-action-guards.mjs");

  /**
   * 🔴 BUG ①. `indexOf("{")` after the function name landed inside the
   * RETURN TYPE of `Promise<ActionResult<{ ... }>>`, so the "body" was
   * thirty characters of type annotation and `reverseTransaction` — which
   * opens with `requireRole(FINANCE_ROLES)` — was reported as asking
   * nothing about its caller. ~200 false positives.
   */
  it("finds the body by angle-bracket depth, not the first brace", () => {
    expect(gate()).toContain("angle === 0");
    expect(gate()).toContain("RETURN TYPE");
  });

  /**
   * 🔴 BUG ②. A doc comment reading `requirePermission()  ← may this
   * person do it?` matched as a call, so `createContact` — which never
   * called it — passed. The gate believed the documentation instead of
   * the code, which is the exact class of defect it exists to catch.
   */
  it("strips comments and string literals before matching", () => {
    expect(gate()).toContain("function stripComments");
    expect(gate()).toContain("A CHECK THAT CAN BE SATISFIED BY WRITING THE RIGHT WORDS");
  });

  /**
   * 🔴 BUG ③. Stripping strings also erased `from "@/server/..."`, so
   * delegation stopped resolving and forty correctly-guarded endpoints
   * across `views.ts`, `workflows.ts` and `dynamic-objects.ts` were
   * reported unguarded. Imports are parsed from the RAW text.
   */
  it("parses imports from the raw file and guards from the stripped one", () => {
    expect(gate()).toContain("serverImports(readRaw(full))");
  });

  /**
   * 🔴 BUG ④. The guard is very often in a local helper every state
   * change funnels through — `orders.ts` does it for four transitions,
   * `variations.ts` for four more. That is strictly better than four
   * copies, and the gate reported all eight as unguarded.
   */
  it("follows a local helper in the same file", () => {
    expect(gate()).toContain("HOP ①: a helper in THIS file");
    expect(gate()).toContain("localFunctions");
  });

  /**
   * ⚠️ AND THE FIFTH, WHICH WAS A CATEGORY ERROR RATHER THAN A PARSING
   * ONE. `requireAccess`, `requireFeature`, `requireSeat` and
   * `requireQuota` all refuse things and none of them is authorisation:
   * they are properties of the WORKSPACE, true for everybody in it.
   */
  it("refuses to count entitlement checks as authorisation", () => {
    const src = gate();
    expect(src).toContain("NOT GUARDS");
    for (const name of ["requireFeature", "requireAccess", "requireSeat", "requireQuota"]) {
      expect(src).toContain(name);
    }
    const tier2 = src.slice(src.indexOf("const TIER2"), src.indexOf("const NOT_GUARDS"));
    expect(tier2).not.toContain('"requireAccess"');
    expect(tier2).not.toContain('"requireFeature"');
  });

  /** ⚠️ The predicate form is a real check and a more considerate one. */
  it("recognises the can() predicate that bulk.ts uses", () => {
    const src = gate();
    const tier2 = src.slice(src.indexOf("const TIER2"), src.indexOf("const NOT_GUARDS"));
    expect(tier2).toContain('"can"');
  });

  /** ⚠️ Every exemption carries a sentence somebody can disagree with. */
  it("makes every allowlist entry explain itself", () => {
    const src = gate();
    /**
     * ⚠️ THE END BOUNDARY IS SEARCHED FROM THE START OF THE BLOCK, not
     * from the start of the file — `indexOf("/* ---")` finds a divider
     * two hundred lines ABOVE `ALLOWED`, which yields a backwards slice,
     * an empty string and a test that passes for no reason. It failed
     * here rather than passing silently only because it asserts a
     * non-zero count first.
     */
    const from = src.indexOf("const ALLOWED = {");
    const list = src.slice(from, src.indexOf("/* ---", from));
    const entries = list.match(/"[a-z0-9-]+\.ts#[A-Za-z0-9_]+":/g) ?? [];
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      const at = list.indexOf(e) + e.length;
      const reason = list.slice(at, at + 400);
      expect(reason.length).toBeGreaterThan(60);
    }
  });

  it("runs in preflight, second, before the expensive checks", () => {
    const pre = read("scripts/preflight.mjs");
    expect(pre).toContain("check-action-guards.mjs");
    expect(pre.indexOf("check-action-guards.mjs")).toBeLessThan(
      pre.indexOf("check-sql-completeness.mjs"),
    );
  });
});

/* ================================================================== */
/* 🔴 WHAT THE GATE FOUND                                              */
/* ================================================================== */

describe("the holes the gate found are actually closed", () => {
  /**
   * 🔴 THE FINDING OF THIS SESSION. `contacts.ts` and `companies.ts`
   * documented the order `requireAccess → requireFeature →
   * requirePermission` in a comment and stopped after the second line.
   * `requireAccess` takes `"contacts:delete"` as an argument and uses it
   * to look up a billing exemption — it answers whether the WORKSPACE
   * may write, not whether this person may.
   *
   * ⚠️ The Accountant role is granted `contacts:read` and could delete
   * every contact in the workspace.
   */
  for (const [file, fns] of Object.entries({
    "server/actions/contacts.ts": ["contacts:create", "contacts:update", "contacts:delete"],
    "server/actions/companies.ts": [
      "companies:create",
      "companies:update",
      "companies:delete",
    ],
  })) {
    it(`${file} now checks the permission it always documented`, () => {
      const src = read(file);
      for (const key of fns) {
        expect(src).toContain(`requirePermission("${key}")`);
      }
    });
  }

  it("storage and documents check a permission before writing", () => {
    expect(read("server/actions/storage.ts")).toContain('requirePermission("documents:create")');
    expect(read("server/actions/storage.ts")).toContain('requirePermission("documents:delete")');
    expect(read("server/actions/documents.ts")).toContain('requirePermission("contracts:create")');
  });

  it("the two new document permission keys exist and are granted", () => {
    const auth = read("db/schema/auth.ts");
    expect(auth).toContain('"documents:create"');
    expect(auth).toContain('"documents:delete"');
  });

  it("onboarding guards the workspace's legal identity", () => {
    const src = read("server/actions/onboarding.ts");
    const count = (src.match(/requirePermission\("settings:update"\)/g) ?? []).length;
    expect(count).toBe(4);
  });

  /**
   * 🔴 `markAllAsRead` CARRIED NO ID AT ALL and matched on the tenant, so
   * one click by any member cleared every unread notification in the
   * workspace — including the owner's "your GST return is due on the
   * 20th". Nothing errored; the inbox was simply empty.
   *
   * ⚠️ THE FIX IS NOT A PERMISSION. The right answer is that the row has
   * to be yours, so the `mine` predicate IS the authorisation — which is
   * why the allowlist entry names it and this test asserts it.
   */
  it("every notification write is scoped to the caller's own rows", () => {
    const src = read("server/actions/notifications.ts");
    const mine = (src.match(/const mine = or\(/g) ?? []).length;
    expect(mine).toBe(3);
    expect(src).toContain("eq(notifications.userId, ctx.user.id)");
    /** ⚠️ Broadcasts have a null userId and must stay dismissable. */
    expect(src).toContain("isNull(notifications.userId)");
  });
});

/* ================================================================== */
/* REACHABILITY                                                        */
/* ================================================================== */

describe("the morning summary is reachable and reads rather than computes", () => {
  it("has an action, a screen and a registry entry", () => {
    expect(read("server/actions/command.ts")).toContain("getMorningSummary");
    expect(read("app/(crm)/command/page.tsx")).toContain("MorningBoard");
    expect(read("lib/modules/registry.ts")).toContain('href: "/command"');
  });

  /**
   * ⭐ THE DESIGN RULE, ASSERTED. The sweep reads engines that already
   * exist; the moment it starts doing its own arithmetic it becomes a
   * second source of truth, and the two disagree within a month.
   */
  it("assembles from the engines that already own the numbers", () => {
    const sweep = read("server/command/sweep.ts");
    expect(sweep).toContain("@/lib/compliance/statutory-due");
    expect(sweep).toContain("@/server/returns/assemble");
    expect(sweep).toContain("THIS FILE COMPUTES NOTHING");
  });

  /**
   * 🔴 A FAILING SOURCE MUST BECOME A VISIBLE SIGNAL, NOT AN ABSENCE.
   * "Nothing needs attention" produced by a broken query is the single
   * most dangerous thing this page can say.
   */
  it("turns a broken section into a line on the page", () => {
    const sweep = read("server/command/sweep.ts");
    expect(sweep).toContain("sweep_error");
    expect(sweep).toContain("ONE FAILING SOURCE MUST NOT EMPTY THE PAGE");
  });

  it("is gated on a read permission and says why it is a low one", () => {
    const src = read("server/actions/command.ts");
    expect(src).toContain('requirePermission("settings:read")');
    expect(src).toContain("no names on it");
  });
});
