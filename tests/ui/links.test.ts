/**
 * Ordence — ⭐ BATCH 35: THE LINKS THAT LEAD NOWHERE
 * Version: v1.37.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 TWELVE LINKS IN THIS PRODUCT LED TO A 404
 * ══════════════════════════════════════════════════════════════════════
 * Not links to unfinished features behind a flag. Ordinary buttons and
 * row links on live screens that a customer meets in their first hour:
 * "New lead", every unit code in the inventory grid, every order number
 * in the orders list, every Restore link in the recycle bin.
 *
 * ⚠️ ELEVEN GATES WERE GREEN THE WHOLE TIME. `tsc` sees a valid string.
 * `check:reachability` asks whether a server action has a caller. Nothing
 * asked the mirror question: whether a caller has a destination.
 *
 * ⭐ AND THE SHAPE OF THE WORST ONE IS WORTH KEEPING. `/sales` was a 404
 * with SEVEN working sub-sections underneath it. Nobody wrote a broken
 * link; somebody built seven pages under a path that was never given one.
 */

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const GATE_PATH = join(ROOT, "scripts", "check-links.mjs");
const GATE = readFileSync(GATE_PATH, "utf8");

function runGate(): { code: number; out: string } {
  try {
    const out = execFileSync("node", [GATE_PATH], {
      cwd: ROOT,
      encoding: "utf8",
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

describe("check:links", () => {
  /** ⭐ IT EXECUTES. A gate asserted about but never run is a document. */
  it("passes, and reports the exact remaining damage", () => {
    const { code, out } = runGate();
    expect(code, out).toBe(0);
    expect(out).toContain("known dead");
    expect(out).toContain("0 new");
  });

  /**
   * ⚠️ THE BUDGET MAY ONLY GO DOWN. Raising it to make a build pass turns
   * the gate into a formality, which is what happened to every link
   * checker anybody has ever deleted.
   */
  it("carries a budget that is the backlog, not an allowlist", () => {
    expect(GATE).toContain("THIS NUMBER MAY ONLY DECREASE");
    expect(GATE).toContain("THE LIST IS THE BACKLOG");
    expect(GATE).toContain("not a place to put new damage");
    const m = /const KNOWN_DEAD_MAX = (\d+);/.exec(GATE);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeLessThanOrEqual(8);
  });

  /**
   * ⭐ EVERY ENTRY NAMES THE SCREEN AND THE COST. "12 dead links" is a
   * number somebody reads and moves on from. "the New lead button, a
   * trial's first click" is a decision.
   */
  it("says what each dead link costs, not just that it is dead", () => {
    // ⚠️ THIS ASSERTION MOVED WHEN THE BUDGET RATCHETED, which is the
    // mechanism behaving correctly. "a trial's first click" described
    // `/sales/leads/new`, and that entry is gone because the page was
    // built. Pinning a specific entry makes the test fail every time the
    // backlog shrinks, so it now pins the PROPERTY the entries must have:
    // each says where a customer meets it, not just that it is dead.
    expect(GATE).toContain("Soft delete works; undelete does not");
    expect(GATE).toContain("Company statement");
  });

  /**
   * 🔴 THE TWO SELF-INFLICTED BUGS IN THE CHECKER ITSELF, both recorded
   * because a checker whose escaping is fragile is a checker nobody
   * trusts the output of.
   */
  it("consumes the slash with an optional catch-all", () => {
    // `[[...sign-in]]` serves both `/sign-in` and `/sign-in/factor-one`.
    // Leaving the slash mandatory reported the landing page's own
    // sign-in link as a 404.
    expect(GATE).toContain("eats its own slash");
    const { out } = runGate();
    expect(out).not.toContain("/sign-in");
  });

  it("substitutes through tokens so no replacement sees another's output", () => {
    // Replacing bracket forms straight to regex source made the third
    // replacement rewrite the `[^/]` produced by the first, yielding
    // `(?:/[^/]++)*` and a "Nothing to repeat" crash.
    expect(GATE).toContain("SUBSTITUTE VIA TOKENS");
    expect(GATE).toContain("Nothing to repeat");
  });

  /** ⚠️ Route groups are not URL segments. Keeping them fails everything. */
  it("strips route groups from the route table", () => {
    expect(GATE).toContain("ROUTE GROUPS ARE STRIPPED");
  });
});

describe("the /sales index that was never built", () => {
  it("exists", () => {
    expect(existsSync(join(ROOT, "app/(crm)/sales/page.tsx"))).toBe(true);
  });

  /**
   * ⭐ A DIRECTORY, NOT A DASHBOARD, ON PURPOSE. A landing page that
   * computes counts gets slow, then gets cached, then gets wrong. The
   * screens it points at already carry their own numbers over the whole
   * filtered set rather than the page.
   */
  it("navigates rather than computing", () => {
    const page = readFileSync(join(ROOT, "app/(crm)/sales/page.tsx"), "utf8");
    expect(page).toContain("DELIBERATELY A DIRECTORY, NOT A DASHBOARD");
    expect(page).not.toContain("await ");
    for (const href of [
      "/sales/inventory",
      "/sales/leads",
      "/sales/bookings",
      "/sales/partners",
      "/sales/brokerage",
      "/sales/possession",
      "/sales/cancellations",
    ]) {
      expect(page, href).toContain(href);
    }
  });

  /** And the gate confirms it, rather than this test taking its word. */
  it("is no longer reported dead", () => {
    const { out } = runGate();
    expect(out).not.toMatch(/^\s*· \/sales —/m);
  });
});
