/**
 * Ordence — ⭐⭐ BATCH 42: THE GRANT NOBODY COULD MAKE
 * Version: v1.43.0-alpha (Mega-wave 2)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 `grantPlatformStaff` AND `revokePlatformStaff` HAD ZERO CALLERS
 * ══════════════════════════════════════════════════════════════════════
 * Both are complete, and have been since Phase 17: the allowlist check
 * that makes the form incapable of minting access, the refusal to grant
 * or renew your own, the mandatory expiry, the last-owner protection, the
 * critical audit row. None of it was reachable. Every platform-staff
 * grant in this product was a hand-written SQL statement, and so was
 * every revocation.
 *
 * ⚠️ THE REVOCATION HALF IS THE ONE THAT MATTERS AT 03:00. The whole
 * two-key design rests on an asymmetry — the env allowlist is slow to
 * change and `platform_staff` is fast — and "fast" meant psql access to
 * the production database while somebody's laptop was missing.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE ASSERTS, AND WHY EACH ONE WOULD BE A SILENT FAILURE
 * ══════════════════════════════════════════════════════════════════════
 *   ① The engine has a caller at all, and it is the `"use server"`
 *      wrapper rather than a client importing `server-only` code.
 *   ② The last-owner rule is stated on the screen BEFORE the click — and
 *      the screen is stricter than the engine, because the engine's
 *      counting query does not look at the allowlist.
 *   ③ Capability and expiry are deliberate choices. No default grade, no
 *      permanent option — because the schema has no field for one.
 *   ④ The current staff list is rendered before the grant form.
 *   ⑤ Authorisation lives in the engine, on `staff:manage`, which only
 *      `owner` holds and which requires a fresh step-up.
 *
 * Nothing that carries a rule is mocked: the schemas and the role matrix
 * are the real modules, and the assertions about what the UI does NOT do
 * read comment-stripped source, because a check that can be satisfied by
 * writing the right words in a comment is not a check.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import {
  grantPlatformStaffSchema,
  revokePlatformStaffSchema,
} from "@/lib/platform/schemas";
import {
  PLATFORM_GRADES,
  capabilitiesForGrade,
  requiresStepUp,
  STEP_UP_CAPABILITIES,
} from "@/lib/platform/roles";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const ENGINE = read("server/platform/staff.ts");
const ACTIONS = read("server/platform/actions.ts");
const PANEL = read("components/platform/staff-console.tsx");
const PAGE = read("app/platform/staff/page.tsx");
const LAYOUT = read("app/platform/layout.tsx");

/**
 * ⚠️ COMMENTS AND JSX COMMENTS BOTH. This file makes several ABSENCE
 * claims — "the client never imports the server module", "no permanent
 * option is sent" — and every one of them would be trivially satisfied
 * by prose. Whitespace-preserving replacement keeps line numbers honest.
 */
const codeOnly = (s: string) =>
  s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));

const PANEL_CODE = codeOnly(PANEL);
const PAGE_CODE = codeOnly(PAGE);
const ACTIONS_CODE = codeOnly(ACTIONS);
const ENGINE_CODE = codeOnly(ENGINE);

/* ================================================================== */
/* ① THE DOOR THAT DID NOT EXIST                                       */
/* ================================================================== */

describe("the orphaned engine now has a caller", () => {
  it("ships a screen", () => {
    expect(existsSync(join(ROOT, "app/platform/staff/page.tsx"))).toBe(true);
    expect(existsSync(join(ROOT, "components/platform/staff-console.tsx"))).toBe(true);
  });

  it("reaches both writes and the read", () => {
    expect(PAGE_CODE).toContain("grantPlatformStaffAction");
    expect(PAGE_CODE).toContain("revokePlatformStaffAction");
    expect(PAGE_CODE).toContain("getStaffDirectory");
    expect(PAGE_CODE).toContain("StaffConsole");
  });

  it("wires the wrappers to the engine", () => {
    expect(ACTIONS_CODE).toContain("grantPlatformStaffImpl(input)");
    expect(ACTIONS_CODE).toContain("revokePlatformStaffImpl(input)");
  });

  /** The console navigation already carried the link. It now leads somewhere. */
  it("is linked from the console nav", () => {
    /*
     * ⚠️ THE NAV MOVED OUT OF THE LAYOUT AND THE ASSERTION FOLLOWED IT.
     * `CONSOLE_NAV` now lives in `lib/platform/console-paths.ts` so the
     * command palette — a `"use client"` component — can share the one
     * mapping; `console-href.ts` reads `headers()` and cannot be imported
     * from a client file. The property is unchanged: the console offers a
     * way to this screen, and the layout renders whatever registry holds
     * it.
     */
    expect(read("lib/platform/console-paths.ts")).toContain('"/platform/staff"');
    expect(codeOnly(LAYOUT)).toContain("CONSOLE_NAV");
  });

  /**
   * 🔴 THE CLIENT MUST NOT IMPORT THE ENGINE. `server/platform/staff.ts`
   * opens with `import "server-only"` and reaches `guard.ts`, which uses
   * `withPlatformScope()` — the deliberate cross-tenant escape hatch.
   * Importing that chain from a `"use client"` file fails the production
   * build, and the tempting "fix" is to delete the marker, which removes
   * the alarm rather than the fault.
   */
  it("never pulls the server-only engine into the client bundle", () => {
    expect(PANEL_CODE).toContain('"use client"');
    expect(PANEL_CODE).not.toContain("@/server/platform/staff");
    expect(PANEL_CODE).not.toContain("withPlatformScope");
  });
});

/* ================================================================== */
/* ② THE CONSOLE IS THE ONLY DOOR BACK IN                              */
/* ================================================================== */

describe("the last owner", () => {
  /**
   * ⭐ THE ENGINE DOES PREVENT IT. `revokePlatformStaff` counts the
   * owners that would REMAIN — active, unrevoked, unexpired, excluding
   * the row being revoked — and refuses when the answer is zero. This
   * asserts the counting query is still there, because deleting it is a
   * one-line change that nothing else would notice until the console was
   * already unreachable.
   */
  it("is protected by the engine, by counting what remains", () => {
    expect(ENGINE_CODE).toContain('eq(platformStaff.grade, "owner")');
    /**
     * ⚠️ WAS `ne(platformStaff.id, staffId)` — one id. Batch 130 moved the
     * floor into `usableOwnersExcluding()` and made the exclusion a LIST,
     * because a bulk revoke checking one id at a time lets two owners go
     * in one batch: each sees the other as the survivor. The property
     * asserted is "the owners being revoked are excluded from the count",
     * which is what the rule has always meant.
     */
    expect(ENGINE_CODE).toContain("notInArray(platformStaff.id");
    expect(ENGINE_CODE).toContain("usableOwnersExcluding");
    expect(ENGINE_CODE).toContain("remaining.length === 0");
    expect(ENGINE).toContain("This is the last usable owner");
  });

  /**
   * ⭐ AND THE SCREEN SAYS SO BEFORE THE CLICK. A refusal that only
   * arrives after the dialog has been filled in and submitted reads as a
   * bug, and by then the operator has already decided.
   */
  it("is stated on the screen, on a disabled control, before the click", () => {
    expect(PANEL_CODE).toContain("lastUsableOwner");
    expect(PANEL_CODE).toContain("disabled={pending || !canManage || blocked}");
    expect(PANEL).toContain("Grant somebody else owner grade first");
    expect(PANEL).toContain("hand-written row in the production database");
  });

  /**
   * ══════════════════════════════════════════════════════════════════
   * 🔴 THE GAP THE SCREEN COMPENSATES FOR
   * ══════════════════════════════════════════════════════════════════
   * The engine's remaining-owner query filters on grade, status, revoked
   * and expiry. It does NOT ask whether the remaining owner's address is
   * still in `PLATFORM_ADMIN_EMAILS` — and platform access needs BOTH
   * keys. So an owner row that is active but allowlist-stale (exactly the
   * drift this page paints red) satisfies the guard while being unable to
   * sign in, and the real last owner can revoke themselves.
   *
   * ⚠️ THE SCREEN COUNTS IT PROPERLY AND BLOCKS ON ITS OWN NUMBER. That
   * is a mistake guard, not a boundary — curl bypasses it — so this test
   * asserts the compensating count exists and stays wired to the control.
   * It does not assert the engine's gap, so it keeps passing when the
   * engine is fixed.
   */
  it("is counted allowlist-aware by the screen, which the engine does not do", () => {
    expect(ENGINE_CODE).toContain("usableAllowlistedOwners");
    expect(ENGINE_CODE).toContain("isAllowlisted(r.email, allowlist)");
    expect(ENGINE_CODE).toContain("lastRealOwner");
    // The stricter number is the one the revoke control blocks on.
    expect(PANEL_CODE).toContain("row.lastUsableOwner || row.lastRealOwner");
    expect(PANEL_CODE).toContain("usableAllowlistedOwners");
  });

  /**
   * ⚠️ SELF-REVOCATION STAYS POSSIBLE while somebody else can still get
   * in. Being unable to kill your own compromised access at 3am is the
   * worse failure — which is why the engine counts REMAINING owners
   * rather than refusing self-revocation outright, and why the screen
   * offers the control on your own row instead of hiding it.
   */
  it("still lets you revoke your own access", () => {
    expect(PANEL_CODE).toContain("revoking.isSelf");
    expect(PANEL).toContain("Revoke my own access");
    expect(ENGINE).toContain("SELF-REVOCATION IS STILL PERMITTED");
  });
});

/* ================================================================== */
/* ③ A GRANT IS A DANGEROUS ACTION AND LOOKS LIKE ONE                  */
/* ================================================================== */

describe("the grant form makes every dangerous thing explicit", () => {
  /**
   * 🔴 THERE IS NO PERMANENT OPTION TO OFFER. `expiresAt` is required by
   * the schema, so a form with a "never" switch would be a form whose
   * switch the server rejects. This asserts the engine's contract rather
   * than the form's copy — if the schema is ever loosened, the sentence
   * on the screen becomes a lie and this test says so.
   */
  it("cannot express a permanent grant, because the schema cannot", () => {
    const base = {
      clerkUserId: "user_2abc",
      email: "ops@ordence.com",
      grade: "support" as const,
      reason: "Adding Priya to the on-call rota for the March migration.",
    };
    expect(grantPlatformStaffSchema.safeParse(base).success).toBe(false);
    expect(grantPlatformStaffSchema.safeParse({ ...base, expiresAt: null }).success).toBe(
      false,
    );
    expect(
      grantPlatformStaffSchema.safeParse({
        ...base,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      }).success,
    ).toBe(true);
  });

  /**
   * 🔴 `<input type="date">` YIELDS `2026-09-15`, AND `z.string().
   * datetime()` REJECTS IT. Sending the raw field value produces "Use an
   * ISO timestamp." against a field the operator filled in correctly.
   * The form converts; this proves the trap is real so the conversion is
   * not deleted as superfluous.
   */
  it("converts the date input, because a bare date is not an ISO timestamp", () => {
    const base = {
      clerkUserId: "user_2abc",
      email: "ops@ordence.com",
      grade: "support" as const,
      reason: "Adding Priya to the on-call rota for the March migration.",
    };
    expect(
      grantPlatformStaffSchema.safeParse({ ...base, expiresAt: "2099-09-15" }).success,
    ).toBe(false);
    expect(PANEL_CODE).toContain("dateInputToIso");
    expect(PANEL_CODE).toContain("T23:59:59.000Z");
    // Never the raw field value.
    expect(PANEL_CODE).not.toMatch(/expiresAt:\s*customDate/);
  });

  /**
   * ⭐ NO DEFAULT GRADE. Support, engineer and owner are three different
   * amounts of power over every customer in the system, and a
   * pre-selected one is the one that gets granted by somebody who was
   * concentrating on the expiry field.
   */
  it("pre-selects no grade and refuses to submit without one", () => {
    expect(PANEL_CODE).toMatch(/useState<PlatformGrade \| "">\(""\)/);
    expect(PANEL_CODE).toContain("Boolean(grade)");
    expect(PANEL_CODE).toContain("disabled={!ready}");
  });

  /**
   * ⭐ THE CAPABILITIES ARE LISTED, NOT SUMMARISED IN AN ADJECTIVE.
   * "Engineer" tells an operator nothing about whether that person can
   * break-glass into a workspace without consent. The matrix is not a
   * secret and it is the entire content of the decision being made.
   */
  it("shows what each grade can actually do, from the real matrix", () => {
    expect(PANEL_CODE).toContain("capabilitiesForGrade(g)");
    expect(PANEL_CODE).toContain("PLATFORM_CAPABILITIES[c]");
    expect(PANEL_CODE).toContain("PLATFORM_GRADES.map");
    // The matrix the form renders is the one the server decides with.
    expect(capabilitiesForGrade("support")).not.toContain("staff:manage");
    expect(capabilitiesForGrade("engineer")).not.toContain("staff:manage");
    expect(capabilitiesForGrade("owner")).toContain("staff:manage");
  });

  /** Both minimums come from the schema, and both are real refusals. */
  it("demands a written reason on both operations", () => {
    const grant = grantPlatformStaffSchema.safeParse({
      clerkUserId: "user_2abc",
      email: "ops@ordence.com",
      grade: "owner",
      reason: "test",
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(grant.success).toBe(false);

    const revoke = revokePlatformStaffSchema.safeParse({
      staffId: "0f4d3f2b-2c9a-4a5e-9f3c-1a2b3c4d5e6f",
      reason: "left",
    });
    expect(revoke.success).toBe(false);
    expect(
      revokePlatformStaffSchema.safeParse({
        staffId: "0f4d3f2b-2c9a-4a5e-9f3c-1a2b3c4d5e6f",
        reason: "Laptop reported stolen, ticket SEC-2210.",
      }).success,
    ).toBe(true);

    expect(PANEL_CODE).toContain("reason.trim().length >= 20");
    expect(PANEL_CODE).toContain("minJustification={15}");
  });

  /**
   * ⭐ THE FORM CANNOT MINT ACCESS, AND SAYS SO. The engine refuses any
   * address not already in `PLATFORM_ADMIN_EMAILS`, so the picker offers
   * only those addresses — a free-text box would have exactly one useful
   * value set and every other keystroke ends in a server refusal.
   */
  it("offers only allowlisted addresses, and explains why", () => {
    expect(ENGINE_CODE).toContain("parseAdminAllowlist(getServerEnv().PLATFORM_ADMIN_EMAILS)");
    expect(PANEL_CODE).toContain("candidates.map");
    expect(PANEL).toContain("PLATFORM_ADMIN_EMAILS");
    expect(PANEL).toContain("cannot create access");
  });

  /**
   * 🔴 THE SELF-GRANT REFUSAL IS NOT OBVIOUS AND IS EXPLAINED. The grant
   * is an upsert on `clerk_user_id`, so it is also the RENEWAL path;
   * without the refusal an owner could extend their own grant forever
   * with no second party in the flow, which makes the mandatory expiry
   * self-serviceable and therefore meaningless.
   */
  it("blocks granting to yourself in the picker, not only on the server", () => {
    expect(PANEL_CODE).toContain("disabled={c.isSelf}");
    expect(PANEL_CODE).toContain("!candidate?.isSelf");
    expect(ENGINE_CODE).toContain("clerkUserId === operator.staff.clerkUserId");
  });

  /** A re-grant REPLACES the row. The operator is told before, not after. */
  it("warns that granting an existing holder replaces their grant", () => {
    expect(PANEL_CODE).toContain("candidate?.hasUsableGrant");
    expect(PANEL).toContain("replaces their existing");
    expect(ENGINE_CODE).toContain("onConflictDoUpdate");
  });
});

/* ================================================================== */
/* ④ THE LIST COMES FIRST                                              */
/* ================================================================== */

describe("who can currently see every customer's data", () => {
  /**
   * ⭐ THE ORDER IS THE ANSWER. Somebody opens this page to find out who
   * holds access, not to give it. A grant form above the list would mean
   * reading the form to find out.
   */
  it("renders the live staff list above the grant form", () => {
    const listAt = PANEL_CODE.indexOf("<StaffTable");
    const formAt = PANEL_CODE.indexOf("<GrantCard");
    expect(listAt).toBeGreaterThan(-1);
    expect(formAt).toBeGreaterThan(-1);
    expect(listAt).toBeLessThan(formAt);
  });

  /**
   * ⭐ `On allowlist` IS THE COLUMN AN ACCESS REVIEW IS FOR. A row that
   * is active but no longer named in `PLATFORM_ADMIN_EMAILS` cannot sign
   * in — correct — but it is also a grant nobody cleaned up, and the
   * drift between the two keys is invisible unless it is shown.
   */
  it("shows the drift between the two keys", () => {
    expect(PANEL_CODE).toContain("row.allowlisted");
    expect(PANEL).toContain("stale grant");
    expect(ENGINE_CODE).toContain("allowlisted,");
  });

  /**
   * ⚠️ NOTHING DELETES. Revocation is a status change so the record of
   * who held platform access survives it — a DELETE would let somebody
   * remove the evidence that they were ever staff. The ended grants are
   * therefore ON the page rather than filtered out of it.
   */
  it("keeps ended grants visible as evidence", () => {
    expect(PANEL_CODE).toContain("const ended =");
    expect(PANEL).toContain("never a delete");
    expect(ENGINE_CODE).not.toContain("db.delete(platformStaff)");
    expect(ENGINE_CODE).toContain('status: "revoked"');
  });
});

/* ================================================================== */
/* ⑤ EVERY ENDPOINT ASKS WHO IS CALLING IT                             */
/* ================================================================== */

describe("authorisation", () => {
  /**
   * ⭐ AN IDENTITY CHECK IS NOT ENOUGH AND THE GATE KNOWS IT.
   * `requirePlatformAdmin()` answers "are you staff"; `staff:manage`
   * answers "may you create another operator". Only the second is a real
   * answer here, and it lives in the engine — because the engine is what
   * a curl request reaches.
   */
  it("guards both writes on staff:manage, inside the engine", () => {
    expect(ENGINE_CODE).toContain('requireCapability("staff:manage")');
    expect(ENGINE_CODE.match(/requireCapability\("staff:manage"\)/g)?.length).toBe(2);
    expect(ENGINE_CODE).toContain('requireCapability("staff:read")');
  });

  /** Only `owner` holds it, and it is on the step-up list. */
  it("is owner-only and needs a fresh second factor", () => {
    const holders = PLATFORM_GRADES.filter((g) =>
      capabilitiesForGrade(g).includes("staff:manage"),
    );
    expect(holders).toEqual(["owner"]);
    expect(requiresStepUp("staff:manage")).toBe(true);
    expect(STEP_UP_CAPABILITIES).toContain("staff:manage");
  });

  /**
   * ⚠️ THE WRAPPERS DECIDE NOTHING. They translate exactly one thrown
   * refusal — `step_up_required`, the only one with a remedy — into data
   * a form can render, because Next.js redacts a thrown server-action
   * error in production and the operator would otherwise see "an
   * unexpected error occurred" for a problem solved by one click.
   *
   * 🔴 AND ONLY THAT ONE. `capability_denied` and `not_platform_staff`
   * must stay indistinguishable from each other — the difference between
   * "you are not staff" and "your grade is too low" is a map of the
   * access model handed to whoever is probing.
   */
  it("translates only the step-up refusal, and re-throws the rest", () => {
    expect(ACTIONS_CODE).toContain('error.code === "step_up_required"');
    expect(ACTIONS_CODE).toContain("needsStepUp: true");
    expect(ACTIONS_CODE).toContain("throw error;");
    expect(ACTIONS_CODE).not.toContain('error.code === "capability_denied"');
    // The wrapper adds no check of its own — the engine is the gate.
    expect(ACTIONS_CODE).not.toContain('requireCapability("staff:manage")');
  });

  /** And the screen offers the remedy without making anybody hunt for it. */
  it("offers the step-up before it is demanded", () => {
    expect(PANEL_CODE).toContain("result.needsStepUp");
    expect(PANEL_CODE).toContain("props.onStepUp()");
    expect(PAGE_CODE).toContain("recordStepUpAction");
    expect(PANEL).toContain("Confirm identity");
  });

  /**
   * ⚠️ CONTROLS ARE DISABLED, NOT HIDDEN. A hidden control teaches a
   * support engineer that the capability does not exist, so they ask for
   * a script instead of a grade. It leaks nothing — the matrix is not a
   * secret and the server refuses regardless of what was rendered.
   */
  it("disables rather than hides what a non-owner cannot do", () => {
    expect(PANEL_CODE).toContain("operator.canManage");
    expect(PANEL).toContain("Only a platform owner can grant or revoke access");
  });

  /** The grant is `critical` severity in the permanent record. */
  it("writes a critical audit row for both operations", () => {
    expect(ENGINE_CODE).toContain('resourceType: "platform_staff_grant"');
    expect(ENGINE_CODE).toContain('resourceType: "platform_staff_revoke"');
    expect(ENGINE_CODE.match(/severity: "critical"/g)?.length).toBe(2);
  });
});
