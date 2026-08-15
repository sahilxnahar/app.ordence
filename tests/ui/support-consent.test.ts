/**
 * Ordence — ⭐⭐ BATCH 41: THE CONSENT NOBODY COULD GIVE
 * Version: v1.40.0-alpha (Mega-wave 2)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 NO SCREEN ANYWHERE GRANTED CONSENT
 * ══════════════════════════════════════════════════════════════════════
 * `server/platform/consent.ts` is complete: two modes, role rules, an
 * expiry per mode, and a circularity gate stopping an operator inside a
 * live session writing themselves a ninety-day standing permission.
 * `grantSupportConsent`, `revokeSupportConsent` and
 * `getSupportConsentState` had ZERO callers. Only `hasLiveConsent` was
 * used, by the console, to display a permission that could never exist.
 *
 * ⚠️ THE CONSEQUENCE WAS NOT "SUPPORT IS BLOCKED". Support worked, via
 * break-glass, which is the EMERGENCY path. The design separates:
 *
 *     ROUTINE    consented, scoped, ordinary in the log
 *     EMERGENCY  break-glass, loud, reviewed, rare
 *
 * With no way to grant consent those collapsed into one, so every
 * legitimate visit looked like an emergency. After the fiftieth
 * break-glass entry, the fifty-first stops being read, which destroys
 * exactly the signal the emergency path exists to carry.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const ACTIONS = read("server/actions/support-access.ts");
const PANEL = read("components/settings/support-access-panel.tsx");
const PAGE = read("app/(crm)/settings/support-access/page.tsx");
const ENGINE = read("server/platform/consent.ts");
const TABS = read("app/(crm)/settings/settings-tabs.tsx");

const codeOnly = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));

/* ================================================================== */
/* ① THE ENGINE NOW HAS A CALLER                                       */
/* ================================================================== */

describe("the door that did not exist", () => {
  it("reaches every write in the consent engine", () => {
    const code = codeOnly(ACTIONS);
    expect(code).toContain("grantSupportConsent(");
    expect(code).toContain("revokeSupportConsent(");
    expect(code).toContain("getSupportConsentState(");
  });

  it("is reachable from a page in the customer's own settings", () => {
    expect(codeOnly(PAGE)).toContain("grantSupportAccess");
    expect(codeOnly(PAGE)).toContain("SupportAccessPanel");
    expect(codeOnly(TABS)).toContain("/settings/support-access");
  });

  /**
   * ⭐ THE WRAPPER STAYS THIN ON PURPOSE. Every rule lives in
   * `consent.ts`, where the console's own path also sees it. A wrapper
   * re-implementing a role check would be a second opinion about who may
   * say yes, and the two would eventually disagree.
   */
  it("does not re-implement the role rules", () => {
    const code = codeOnly(ACTIONS);
    expect(code).not.toContain("tenant_owner");
    expect(code).not.toContain("tenant_admin");
  });
});

/* ================================================================== */
/* ② THE GUARD THE GATE DEMANDED                                       */
/* ================================================================== */

describe("authorisation", () => {
  /**
   * 🔴 `check:guards` FAILED THIS FILE ON FIRST WRITE, AND WAS RIGHT.
   *
   * `requireTenantContext()` answers "who are you", not "may you do
   * this". A mutation reachable by any authenticated member, relying on
   * a role comparison further down a call chain, is exactly the shape
   * the gate exists to refuse: if `consent.ts` were refactored so a
   * branch returned before its role check, this endpoint would become
   * open and nothing would fail.
   */
  it("guards both mutations with a permission, not just an identity", () => {
    const code = codeOnly(ACTIONS);
    const grantAt = code.indexOf("grantSupportAccess");
    const revokeAt = code.indexOf("revokeSupportAccess");
    expect(code.slice(grantAt, revokeAt)).toContain("requirePermission(MANAGE)");
    expect(code.slice(revokeAt)).toContain("requirePermission(MANAGE)");
  });

  it("records why the guard is not duplication", () => {
    expect(ACTIONS).toContain("A ROLE CHECK AND A PERMISSION CHECK ANSWER DIFFERENT QUESTIONS");
    expect(ACTIONS).toContain("Two");
  });

  /**
   * ⭐⭐ THE CIRCULARITY GATE IS UNTOUCHED, AND THAT MATTERS MOST.
   *
   * An operator inside a live impersonation session has a perfectly
   * valid tenant context, so every database check would pass. Without
   * this gate our staff could enter on the customer's one-hour
   * permission, use that hour to write themselves ninety days, and the
   * audit trail would show the workspace granting it.
   */
  it("leaves the circularity gate in place", () => {
    expect(ENGINE).toContain('assertImpersonationAllows("support:consent"');
    expect(ENGINE).toContain("THE CIRCULARITY GATE. DO NOT REMOVE THIS.");
  });
});

/* ================================================================== */
/* ③ THE SCREEN'S DEFAULTS ARE THE POLICY                              */
/* ================================================================== */

describe("the panel", () => {
  /**
   * 🔴 READ-ONLY IS THE DEFAULT AND STAYS THE DEFAULT. Most support work
   * is diagnosis. Making "can change things" the easy option means it is
   * what gets chosen, and the difference is somebody seeing your invoice
   * versus somebody editing it.
   */
  it("defaults to read only", () => {
    expect(codeOnly(PANEL)).toContain('defaultValue="read_only"');
  });

  /** ⚠️ The role rule is shown before the attempt, not after it. */
  it("says who may grant standing access before the attempt", () => {
    expect(codeOnly(PANEL)).toContain("isOwner");
    expect(PANEL).toContain("Only the workspace owner can give this");
  });

  /**
   * ⭐ THE CURRENT STATE COMES FIRST, IN PLAIN LANGUAGE. "Nobody has
   * been given access, so nobody has it" is the answer the customer came
   * for. Burying it under a form makes them read the form to find out.
   */
  it("leads with whether support can get in right now", () => {
    expect(PANEL).toContain("Right now");
    // ⚠️ Matched in two pieces: JSX wraps the sentence across lines, and a
    // test asserting the whole sentence fails on the line break rather
    // than on the meaning.
    expect(PANEL).toContain("cannot open your workspace");
    expect(PANEL).toContain("so nobody has it");
  });

  /**
   * ⭐ THE HISTORY IS THE EVIDENCE HALF. `0014` calls a customer reading
   * the record of when support was inside their workspace the most
   * persuasive answer to the question every enterprise security review
   * asks. It only persuades if it is on the screen.
   */
  it("shows every grant, not just the live ones", () => {
    expect(PANEL).toContain("Every time access has been given");
    expect(codeOnly(PANEL)).toContain("consents.map(");
    // And the live subset is derived, not a separate source of truth.
    expect(codeOnly(PANEL)).toContain("consents.filter((c) => c.live)");
  });

  /**
   * ⚠️ REVOCATION IS NOT GUARDED MORE TIGHTLY THAN GRANTING. A customer
   * who wants support out must be able to get them out. Requiring the
   * owner to revoke when an admin could grant would mean the person able
   * to close the door is asleep exactly when somebody wants it closed.
   */
  it("lets the customer end access immediately", () => {
    expect(PANEL).toContain("End it now");
    expect(ACTIONS).toContain("NOT GUARDED MORE TIGHTLY THAN GRANTING");
  });

  /** Expiry is stated in the customer's units, from the real constants. */
  it("shows the real expiry, not a hardcoded one", () => {
    const code = codeOnly(PANEL);
    expect(code).toContain("{incidentMinutes}");
    expect(code).toContain("{standingDays}");
    expect(codeOnly(PAGE)).toContain("STANDING_CONSENT_DAYS");
    expect(codeOnly(PAGE)).toContain("INCIDENT_CONSENT_MINUTES");
  });
});
