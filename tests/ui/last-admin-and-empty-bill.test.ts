/**
 * Ordence — ⭐⭐ TWO GUARDS THAT COUNTED THE WRONG THING
 * Version: v1.46.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 ① THE LAST-ADMIN GUARD COUNTED ROWS, NOT PEOPLE WHO CAN SIGN IN
 * ══════════════════════════════════════════════════════════════════════
 * `revokePlatformStaff` refuses to remove the last owner by counting the
 * owners that would REMAIN. The idea is right and the count was not: it
 * asked about grade, status, revocation and expiry, and never about
 * `PLATFORM_ADMIN_EMAILS`. Console access needs BOTH keys — the row and
 * the allowlist entry — so an owner row that is `active` but no longer
 * allowlisted propped the count up while being unable to sign in.
 *
 * Two owner rows, one of them allowlist-stale, the real owner revokes
 * themselves, the engine permits it because it can see a second owner,
 * and nobody can reach the console again without a hand-written row in
 * the production database. That is precisely the outcome the guard
 * exists to prevent, reached through the guard.
 *
 * ⚠️ THE SCREEN ALREADY COMPENSATED (`usableAllowlistedOwners`). A
 * disabled button is a mistake guard, not a boundary: curl does not
 * render the screen. This file asserts the BOUNDARY, and asserts the
 * screen's version is still there — belt and braces are not redundant
 * when one of them is a suggestion.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 ② `matchThreeWay([])` REPORTED A CLEAN THREE-WAY MATCH
 * ══════════════════════════════════════════════════════════════════════
 * "The order, the receipt and the bill agree on every line" — for a bill
 * with no lines. `findings.length === 0` is equally true of "nothing was
 * wrong" and "there was nothing to look at", and the empty case fell
 * through to the success branch of the control that authorises paying a
 * vendor.
 *
 * ⚠️ BOTH DEFECTS ARE MODELLED, NOT ASSERTED. Each section runs the OLD
 * predicate beside the new one on the same facts and shows the old one
 * permitting what the new one refuses — because a test that only states
 * the fixed behaviour cannot tell anybody what was broken, and passes
 * just as happily against a guard that never had the bug.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { isAllowlisted, parseAdminAllowlist } from "@/lib/platform/roles";
import {
  DEFAULT_TOLERANCE,
  matchThreeWay,
  type MatchLine,
  type MatchState,
} from "@/lib/purchases/three-way";
import { buildPaymentRun, type PayableBill } from "@/lib/purchases/ageing";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/**
 * ⚠️ COMMENTS STRIPPED FOR EVERY SOURCE CLAIM. Both fixes are the kind
 * that can be described in prose without being performed, and a check
 * satisfied by writing the right words in a comment is not a check.
 */
const codeOnly = (s: string) =>
  s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));

const ENGINE = read("server/platform/staff.ts");
const ENGINE_CODE = codeOnly(ENGINE);
const PANEL_CODE = codeOnly(read("components/platform/staff-console.tsx"));
const REVOKE_CODE = ENGINE_CODE.slice(
  ENGINE_CODE.indexOf("export async function revokePlatformStaff"),
);

/**
 * ⚠️ THE WHOLE MODULE, NOT ONE FUNCTION'S SLICE.
 *
 * `REVOKE_CODE` above is a slice starting at `revokePlatformStaff`. That
 * was fine while the owner floor was inline inside it, and stopped being
 * fine the moment batch 130 extracted the floor into the exported
 * `usableOwnersExcluding()` so a whole batch of revocations could be
 * evaluated at once. Every term survived; only its address changed, and
 * two assertions here failed a change that was strictly better.
 *
 * 🔴 SIXTH INSTANCE IN THIS PROJECT of a test pinning an incidental form
 *    rather than the property, and the first where two separate test
 *    files pinned the same literal, so fixing one left the other red.
 *
 * Assertions about WHERE a rule is enforced use `REVOKE_CODE`.
 * Assertions about WHETHER the rule exists use `STAFF_CODE`.
 */
const STAFF_CODE = ENGINE_CODE;

/* ================================================================== */
/* ① THE LAST ADMIN                                                    */
/* ================================================================== */

/** The columns the remaining-owner query reads, and the one it did not. */
type OwnerRow = {
  id: string;
  email: string;
  grade: string;
  status: string;
  revokedAt: Date | null;
  expiresAt: Date | null;
};

const NOW = new Date("2026-08-15T09:00:00Z");

const owner = (over: Partial<OwnerRow> = {}): OwnerRow => ({
  id: "staff-1",
  email: "asha@ordence.test",
  grade: "owner",
  status: "active",
  revokedAt: null,
  expiresAt: null,
  ...over,
});

/**
 * 🔴 THE PREDICATE AS IT WAS: grade, status, revocation, expiry, and
 * `ne(id, staffId)`. One term per `and(...)` in the query it models, and
 * not one word about the allowlist.
 */
const remainingBefore = (rows: readonly OwnerRow[], staffId: string, now: Date) =>
  rows.filter(
    (r) =>
      r.grade === "owner" &&
      r.status === "active" &&
      r.revokedAt === null &&
      r.id !== staffId &&
      (r.expiresAt === null || r.expiresAt.getTime() > now.getTime()),
  );

/**
 * ⭐ THE PREDICATE AS IT IS: the same five terms, then KEY 1 — using the
 * real `isAllowlisted` over the real `parseAdminAllowlist`, which is
 * what `guard.ts` admits an operator with. Nothing here is a
 * re-implementation of the membership rule; a copy of it would be free
 * to drift from the one that decides sign-in.
 */
const remainingAfter = (
  rows: readonly OwnerRow[],
  staffId: string,
  now: Date,
  allowlist: ReadonlySet<string>,
) => remainingBefore(rows, staffId, now).filter((r) => isAllowlisted(r.email, allowlist));

describe("🔴 the last-admin guard counts owners who can actually sign in", () => {
  /**
   * ══════════════════════════════════════════════════════════════════
   * THE LOCKOUT, IN FULL
   * ══════════════════════════════════════════════════════════════════
   * `asha@` is the real owner and is revoking herself. `ravi@` left; his
   * row was never revoked, and his address came off
   * `PLATFORM_ADMIN_EMAILS` in a deploy — the stale grant the console
   * paints red in `On allowlist`.
   */
  const allowlist = parseAdminAllowlist(" Asha@Ordence.test ");
  const rows: readonly OwnerRow[] = [
    owner({ id: "asha", email: "asha@ordence.test" }),
    owner({ id: "ravi", email: "ravi@ordence.test" }),
  ];

  it("the stale owner satisfied the old count", () => {
    const survivors = remainingBefore(rows, "asha", NOW);
    expect(survivors.map((r) => r.id)).toEqual(["ravi"]);
    // Non-empty, so the old guard permitted the self-revocation that
    // emptied the console.
    expect(survivors.length === 0).toBe(false);
  });

  it("and fails the new one, because he cannot sign in", () => {
    expect(isAllowlisted("ravi@ordence.test", allowlist)).toBe(false);
    expect(remainingAfter(rows, "asha", NOW, allowlist)).toHaveLength(0);
  });

  /** ⚠️ Case and surrounding spaces are not what makes an owner stale. */
  it("counts an allowlisted owner whose address differs only in case", () => {
    const mixed = [
      owner({ id: "asha", email: "asha@ordence.test" }),
      owner({ id: "bee", email: " Bee@Ordence.test " }),
    ];
    const both = parseAdminAllowlist("asha@ordence.test,bee@ordence.test");
    expect(remainingAfter(mixed, "asha", NOW, both).map((r) => r.id)).toEqual(["bee"]);
  });

  /**
   * ⭐ SELF-REVOCATION STAYS OPEN. Being unable to kill your own
   * compromised access at 3am is the worse failure, and the fix must not
   * quietly turn the guard into "you may never revoke yourself".
   */
  it("still permits self-revocation while a real owner remains", () => {
    const both = parseAdminAllowlist("asha@ordence.test, bee@ordence.test");
    const withBee = [...rows, owner({ id: "bee", email: "bee@ordence.test" })];
    expect(remainingAfter(withBee, "asha", NOW, both)).toHaveLength(1);
  });

  /** The four original terms still exclude what they always excluded. */
  it("still discounts revoked, deactivated, expired and non-owner rows", () => {
    const all = parseAdminAllowlist(
      "asha@ordence.test,gone@ordence.test,off@ordence.test,old@ordence.test,ops@ordence.test",
    );
    const junk = [
      owner({ id: "asha", email: "asha@ordence.test" }),
      owner({ id: "gone", email: "gone@ordence.test", revokedAt: NOW }),
      owner({ id: "off", email: "off@ordence.test", status: "revoked" }),
      owner({
        id: "old",
        email: "old@ordence.test",
        expiresAt: new Date("2026-08-01T00:00:00Z"),
      }),
      owner({ id: "ops", email: "ops@ordence.test", grade: "support" }),
    ];
    expect(remainingAfter(junk, "asha", NOW, all)).toHaveLength(0);
    // And the same rows are refused by the old predicate too — the only
    // behaviour this change moves is the allowlist one.
    expect(remainingBefore(junk, "asha", NOW)).toHaveLength(0);
  });
});

describe("the boundary is in the engine, not only on the screen", () => {
  /**
   * 🔴 THE REFUSAL IS THE SERVER'S. `revokePlatformStaff` is reachable
   * as a server action; a curl request never evaluates a disabled
   * button.
   */
  /**
   * ⚠️ Reads the whole MODULE, not one function's slice. Batch 130 moved
   *    the floor into `usableOwnersExcluding()`; the term is unchanged,
   *    its address is not. See the note in four-eyes.test.ts.
   */
  it("the remaining-owner count reads the allowlist", () => {
    expect(STAFF_CODE).toContain(
      "parseAdminAllowlist(getServerEnv().PLATFORM_ADMIN_EMAILS)",
    );
    expect(STAFF_CODE).toContain("isAllowlisted(r.email, allowlist)");
    // It cannot filter on an address it did not select.
    expect(STAFF_CODE).toContain("email: platformStaff.email");
    expect(STAFF_CODE).toContain("remaining.length === 0");
  });

  /**
   * ⚠️ NO `LIMIT 1` ON THAT COUNT ANY MORE. The allowlist term is
   * applied in TypeScript, so the single row the database would have
   * stopped at may be exactly the stale one.
   */
  it("does not stop at the first owner row the database finds", () => {
    const count = REVOKE_CODE.slice(REVOKE_CODE.indexOf("const remaining"));
    expect(count.slice(0, count.indexOf("remaining.length"))).not.toContain(".limit(1)");
  });

  /** The five original terms survive the change, wherever they now live. */
  it("keeps the terms it always had", () => {
    expect(STAFF_CODE).toContain('eq(platformStaff.grade, "owner")');
    expect(STAFF_CODE).toContain('eq(platformStaff.status, "active")');
    expect(STAFF_CODE).toContain("isNull(platformStaff.revokedAt)");
    // ⚠️ `ne(id, staffId)` for one grant and `notInArray(id, ids)` for a
    //    batch are the SAME property: the floor excludes what is being
    //    revoked. Batch 130 moved from the first to the second so a bulk
    //    revoke could be evaluated as one decision instead of N. Assert
    //    the property, not whichever operator today's arity needs.
    expect(
      /ne\(\s*platformStaff\.id/.test(STAFF_CODE) ||
        /notInArray\(\s*platformStaff\.id/.test(STAFF_CODE),
      "the owner floor must exclude the grants being revoked",
    ).toBe(true);
    expect(STAFF_CODE).toContain("gt(platformStaff.expiresAt, new Date())");
  });

  /** And says out loud why an allowlist-stale owner is not a survivor. */
  it("says why the row alone is not enough", () => {
    expect(ENGINE).toContain("A REMAINING OWNER ONLY COUNTS IF THEY HOLD BOTH KEYS");
    expect(ENGINE).toContain("is no longer in PLATFORM_ADMIN_EMAILS does not count here");
  });

  /**
   * ⭐ THE SCREEN'S OWN COUNT IS NOT REMOVED. It is what turns the
   * refusal into a sentence before the click instead of a red toast
   * after it, and the boundary arriving behind it does not make the
   * mistake guard redundant.
   */
  it("leaves the screen's compensating count in place", () => {
    expect(ENGINE_CODE).toContain("usableAllowlistedOwners");
    expect(ENGINE_CODE).toContain("isAllowlisted(r.email, allowlist)");
    expect(ENGINE_CODE).toContain("lastRealOwner");
    expect(PANEL_CODE).toContain("usableAllowlistedOwners");
    expect(PANEL_CODE).toContain("row.lastUsableOwner || row.lastRealOwner");
  });
});

/* ================================================================== */
/* ② THE BILL WITH NO LINES                                            */
/* ================================================================== */

const MATCH_NOW = new Date("2026-08-15T09:00:00Z");

const matchLine = (over: Partial<MatchLine> = {}): MatchLine => ({
  lineKey: "l1",
  description: "TMT bar 12mm",
  orderedQty: "100.000",
  orderedUnitPriceMinor: 5_000_00n,
  receivedQty: "100.000",
  rejectedQty: "0.000",
  invoicedQty: "100.000",
  invoicedUnitPriceMinor: 5_000_00n,
  ...over,
});

/**
 * 🔴 THE OLD BRANCH ORDER, ON AN EMPTY BILL. The per-line loop cannot
 * contribute a finding when there are no lines, so `findings` is `[]` by
 * construction; `everyLineOrderless` was guarded by `lines.length > 0`
 * and therefore false; and the next branch is the success one.
 */
const stateBefore = (lines: readonly MatchLine[]): MatchState => {
  const findings: unknown[] = []; // nothing to iterate over
  const everyLineOrderless = lines.length > 0 && lines.every((l) => l.orderedQty === null);
  if (everyLineOrderless) return "no_order";
  if (findings.length === 0) return "matched";
  return "unmatched";
};

describe("🔴 a bill with no lines is not a clean three-way match", () => {
  it("the old branch order called it matched", () => {
    expect(stateBefore([])).toBe("matched");
    // Which is the sentence that was shown to whoever approves payment.
    expect(read("lib/purchases/three-way.ts")).toContain(
      "The order, the receipt and the bill agree on every line.",
    );
  });

  /**
   * ⭐ THE DECISION: `unmatched`. Of the four words 0063's CHECK admits,
   * it is the one the rest of the product already stops on — "cannot be
   * checked" belongs with the state that halts, never with the one that
   * clears. `no_order` would have been the wrong word twice over: it
   * says a bill legitimately has no order behind it, and it is not
   * blocked anywhere.
   */
  it("is unmatched, with nothing claimed about lines that do not exist", () => {
    const r = matchThreeWay([], DEFAULT_TOLERANCE, MATCH_NOW);
    expect(r.state).toBe("unmatched");
    expect(r.findings).toHaveLength(0);
    expect(r.netImpactMinor).toBe(0n);
    expect(r.headline).toContain("no lines");
    expect(r.headline).not.toContain("agree on every line");
  });

  /**
   * ⚠️ THE VERDICT IS WRITTEN TO A COLUMN WITH A CHECK CONSTRAINT.
   * `runThreeWayMatch` stores `verdict.state` in
   * `purchase_invoices.match_state`, so a fifth word would be a runtime
   * failure at the moment of approval. The constraint is read from
   * 0063 rather than retyped.
   */
  it("stores a state 0063 permits, and needs no note", () => {
    const sql = read("SQL-FILES/0063_purchase_orders_payments.sql");
    const known = sql
      .slice(sql.indexOf("purchase_invoices_match_state_known"))
      .slice(0, 400);
    const r = matchThreeWay([], DEFAULT_TOLERANCE, MATCH_NOW);
    expect(known).toContain(`'${r.state}'`);
    // ⚠️ Only `matched_within_tolerance` carries a mandatory note.
    expect(r.state).not.toBe("matched_within_tolerance");
    expect(r.note).toBeNull();
  });

  /**
   * 🔴🔴 THE MONEY. `purchase_invoices` carries its own header total, so
   * a bill with no lines is a payable amount that nothing checked. The
   * state this now returns is the one the payment run refuses to pay.
   */
  it("is refused by the payment run, where the old verdict passed", () => {
    const bill = (matchState: PayableBill["matchState"]): PayableBill => ({
      id: "b1",
      vendorId: "v1",
      vendorName: "Sharma Steels",
      invoiceNumber: "PI-EMPTY",
      invoiceDate: "2026-06-01",
      dueOn: "2026-07-01",
      totalMinor: 4_00_000_00n,
      paidMinor: 0n,
      matchState,
      msmePriority: 0,
      msmeDeductionAtRisk: false,
      msmeInterestMinor: 0n,
      onHold: false,
    });

    const before = buildPaymentRun({
      bills: [bill(stateBefore([]))],
      today: "2026-08-15",
    });
    expect(before.lines[0]!.payable).toBe(true);

    const after = buildPaymentRun({
      bills: [bill(matchThreeWay([], DEFAULT_TOLERANCE, MATCH_NOW).state)],
      today: "2026-08-15",
    });
    expect(after.lines[0]!.payable).toBe(false);
    expect(after.blockedTotalMinor).toBe(4_00_000_00n);

    // And the automatic allocation drops it for the same reason.
    expect(codeOnly(read("server/actions/vendor-payments.ts"))).toContain(
      'matchState !== "unmatched"',
    );
  });

  /** ⭐ Every non-empty verdict is exactly what it was. */
  it("leaves bills that do have lines alone", () => {
    expect(matchThreeWay([matchLine()], DEFAULT_TOLERANCE, MATCH_NOW).state).toBe(
      "matched",
    );
    expect(
      matchThreeWay(
        [matchLine({ orderedQty: null, orderedUnitPriceMinor: null, receivedQty: null })],
        DEFAULT_TOLERANCE,
        MATCH_NOW,
      ).state,
    ).toBe("no_order");
    expect(
      matchThreeWay(
        [matchLine({ invoicedUnitPriceMinor: 5_200_00n })],
        DEFAULT_TOLERANCE,
        MATCH_NOW,
      ).state,
    ).toBe("unmatched");
  });

  /** The reason is written down where the branch is. */
  it("says why the empty bill does not fall through to matched", () => {
    expect(read("lib/purchases/three-way.ts")).toContain(
      "A BILL WITH NO LINES IS NOT A MATCH",
    );
  });
});
