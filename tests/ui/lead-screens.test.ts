/**
 * Ordence — ⭐⭐ BATCH 35: THE TWO LEAD SCREENS THAT DID NOT EXIST
 * Version: v1.43.0-alpha (Mega-wave 1)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE FIRST HOUR OF A TRIAL MET TWO 404s
 * ══════════════════════════════════════════════════════════════════════
 * `/sales/leads/new` is the "New lead" button on the pipeline — a trial's
 * first click. `/sales/leads/:id` is every row of the lead table and
 * every card on the board. Neither route existed, while five of the eight
 * actions in `sales-leads.ts` sat complete with no caller: `getLead`,
 * `createLead`, `updateLead`, `logLeadActivity` and
 * `getSalesEntitlements`.
 *
 * ⚠️ THE ABSENCE ASSERTIONS RUN AGAINST COMMENT-STRIPPED SOURCE. Five
 * times in this repo a test has failed on the explanatory comment that
 * describes the mistake it forbids — `codeOnly` is the fix and it is not
 * optional.
 *
 * The `check:links` budget is NOT asserted here. These two entries leave
 * `KNOWN_DEAD` during integration, and a test that named the number would
 * fail in the window between building the pages and lowering it.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const NEW_PATH = "app/(crm)/sales/leads/new/page.tsx";
const DETAIL_PATH = "app/(crm)/sales/leads/[id]/page.tsx";

const NEW_PAGE = read(NEW_PATH);
const DETAIL = read(DETAIL_PATH);
const FORM = read("components/sales/lead-form.tsx");
const PANEL = read("components/sales/lead-detail-panel.tsx");
const OPTIONS = read("server/actions/sales-leads-form.ts");
const LIST = read("app/(crm)/sales/leads/page.tsx");
const TABLE = read("components/sales/lead-table.tsx");
const BOARD = read("components/sales/pipeline-board.tsx");

const codeOnly = (s: string) =>
  s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));

/* ================================================================== */
/* ① THE ROUTES EXIST, AND THE THINGS THAT LINKED TO THEM STILL DO     */
/* ================================================================== */

describe("the two dead links", () => {
  it("both routes exist", () => {
    expect(existsSync(join(ROOT, NEW_PATH))).toBe(true);
    expect(existsSync(join(ROOT, DETAIL_PATH))).toBe(true);
  });

  /** ⭐ Reachable without typing a URL, which is what made them count. */
  it("is what the pipeline's New lead button already pointed at", () => {
    expect(codeOnly(LIST)).toContain('href="/sales/leads/new"');
    expect(LIST).toContain("New lead");
  });

  it("is what every table row and every board card already pointed at", () => {
    expect(codeOnly(TABLE)).toContain("href={`/sales/leads/${row.id}`}");
    expect(codeOnly(BOARD)).toContain("href={`/sales/leads/${card.id}`}");
  });
});

/* ================================================================== */
/* ② THE ORPHANED ACTIONS NOW HAVE CALLERS                             */
/* ================================================================== */

describe("the actions that had no caller", () => {
  it("the create screen reaches createLead and the entitlement check", () => {
    const code = codeOnly(NEW_PAGE);
    expect(code).toContain("createLead");
    expect(code).toContain("getSalesEntitlements");
    expect(code).toContain("LeadForm");
  });

  it("the detail screen reaches getLead", () => {
    expect(codeOnly(DETAIL)).toContain("getLead(");
  });

  it("the detail panel reaches updateLead, logLeadActivity and transitionLead", () => {
    const code = codeOnly(PANEL);
    for (const fn of ["updateLead", "logLeadActivity", "transitionLead"]) {
      expect(code, fn).toContain(fn);
    }
  });

  /**
   * ⚠️ THE ENTITLEMENT IS READ WITH THE NON-THROWING CHECK, and the
   * distinction is the whole reason `getSalesEntitlements` exists: a page
   * that threw on an entitlement would show an error page instead of an
   * upgrade prompt, to the one person able to act on it.
   */
  it("renders an upgrade prompt rather than a form it knows will be refused", () => {
    const code = codeOnly(NEW_PAGE);
    expect(code).toContain('entitlements.data["sales.pipeline"]');
    expect(NEW_PAGE).toContain("View plan");
    expect(NEW_PAGE).toContain("NON-THROWING");
  });
});

/* ================================================================== */
/* ③ A REFUSAL IS NOT A 404                                            */
/* ================================================================== */

describe("refusals", () => {
  /**
   * 🔴 `getLead` ANSWERS BOTH QUESTIONS IN THE SAME SHAPE, so the page
   * shows the message it was given instead of guessing. Collapsing a
   * refusal into `notFound()` sends an operator with the wrong role
   * hunting for a record that is sitting right there.
   */
  it("shows the refusal message and never calls notFound()", () => {
    const code = codeOnly(DETAIL);
    expect(code).toContain("if (!result.ok)");
    expect(code).toContain("{result.error}");
    expect(code).not.toContain("notFound");
    expect(DETAIL).toContain("A REFUSAL IS NOT A 404");
  });

  it("the create screen distinguishes a refusal from an empty page too", () => {
    const code = codeOnly(NEW_PAGE);
    expect(code).toContain("Refusal");
    expect(code).toContain("entitlements.error");
  });
});

/* ================================================================== */
/* ④ MONEY: STRINGS IN, STRINGS OUT, NEVER A FLOAT                     */
/* ================================================================== */

describe("money", () => {
  /**
   * 🔴 THE FORM CONVERTS NOTHING. `Number("4500000.50") * 100` is wrong
   * twice: it is a float, and it is a second implementation of
   * `toMinorUnits`, which already splits the string. The browser sends
   * rupees; the server owns paise.
   */
  it("the form sends the rupee string it was typed, unconverted", () => {
    const code = codeOnly(FORM);
    expect(code).toContain("budgetMin: orNull(values.budgetMin)");
    expect(code).toContain("budgetMax: orNull(values.budgetMax)");
    expect(code).not.toContain("100n");
    expect(code).not.toContain("parseFloat");
    expect(code).not.toMatch(/\*\s*100/);
    expect(code).not.toContain("Math.round(Number");
  });

  /** ⚠️ Display only, by splitting the digits. Nothing becomes a number. */
  it("the detail page formats paise without touching a float", () => {
    const code = codeOnly(DETAIL);
    expect(code).toContain("padStart");
    expect(code).not.toContain("parseFloat");
    expect(code).not.toMatch(/Number\(\w*[Mm]inor\w*\)/);
    expect(code).not.toMatch(/\/\s*100/);
  });

  /**
   * ⚠️ AND THE EDIT FORM IS SEEDED WITH `fromMinorUnits`, NOT `money()`.
   * A field validated by `/^\d{1,15}(\.\d{1,2})?$/` cannot hold
   * "₹45,00,000.00", so seeding it with the display string would make
   * every save of an untouched budget fail.
   */
  it("seeds the edit form with a plain rupee string", () => {
    const code = codeOnly(DETAIL);
    expect(code).toContain("fromMinorUnits(lead.budgetMinMinor)");
    expect(code).toContain("fromMinorUnits(lead.budgetMaxMinor)");
  });

  /** The failures the string split avoids, demonstrated. */
  it("the float version would have been wrong", () => {
    expect(Math.round(1.005 * 100)).toBe(100); // 1.005 → 100 paise, a paisa lost
    // ₹90,071,992,547,409.93 in paise. A portfolio reaches this, and the
    // number version is wrong by a paisa with no error anywhere.
    const paise = 9_007_199_254_740_993n;
    expect(String(Number(paise))).not.toBe(String(paise));
  });
});

/* ================================================================== */
/* ⑤ THE BUTTONS MIRROR THE RULES, THEY DO NOT REPLACE THEM            */
/* ================================================================== */

describe("the lifecycle controls", () => {
  /**
   * ⭐ DERIVED FROM `canTransition`, THE SAME PURE FUNCTION THE SERVER
   * RUNS — not a second copy of the table. The database keeps
   * `leads_lost_has_reason`, the `leads_cp_lock` trigger and the live
   * bookings count; the screen only stops offering what will be refused.
   */
  it("derives the stages on offer from canTransition", () => {
    const code = codeOnly(PANEL);
    expect(code).toContain("canTransition({");
    expect(code).toContain("PIPELINE_STAGES.filter");
    expect(PANEL).toContain("IT IS NOT THE AUTHORITY");
  });

  /**
   * ⭐ `won` IS NOT OFFERED. A lead is won by registering a booking, so
   * the button would produce a refusal every single time it was pressed.
   * `PIPELINE_STAGES` excludes it, which is why the filter is safe.
   */
  it("never offers won as a button", () => {
    const code = codeOnly(PANEL);
    expect(code).not.toMatch(/move\(\s*"won"/);
    expect(code).not.toContain('to: "won"');
  });

  /**
   * 🔴 THE LOST REASON IS COLLECTED BEFORE THE ACTION FIRES. Firing first
   * and surfacing the constraint teaches the rep to type "x" and move on.
   */
  it("asks why before marking a lead lost", () => {
    const code = codeOnly(PANEL);
    expect(code).toContain('name="lostReason"');
    expect(code).toContain("required");
    expect(PANEL).toContain("BEFORE THE ACTION, NOT AFTER A");
  });

  /**
   * ⚠️ `status_change` AND `assignment` ARE NOT LOGGABLE BY HAND.
   * `transitionLead` writes those itself, in the same transaction as the
   * change. A hand-written one is an append-only history that says a
   * stage moved when nothing moved.
   */
  it("does not let anybody hand-write a status change into the history", () => {
    const code = codeOnly(PANEL);
    expect(code).toContain('["call", "Call"]');
    expect(code).not.toContain('"status_change"');
    expect(code).not.toContain('"assignment"');
  });

  /**
   * ⚠️ AN EMPTY FOLLOW-UP FIELD LEAVES THE DATE ALONE. Sending `null`
   * would clear it, and a rep who logged a note would silently
   * un-schedule the call they had booked.
   */
  it("omits an unset follow-up rather than nulling it", () => {
    const code = codeOnly(PANEL);
    expect(code).toContain("scheduledAt: scheduled || undefined");
  });

  /** ⚠️ A lead that cannot move says why, rather than showing no buttons. */
  it("explains a lead frozen by a live booking", () => {
    expect(codeOnly(PANEL)).toContain("hasLiveBooking ? (");
    expect(PANEL).toContain("live booking against a unit");
    expect(PANEL).toContain("Cancel the booking first");
  });
});

/* ================================================================== */
/* ⑥ THE FORM'S TWO QUIET TRAPS                                        */
/* ================================================================== */

describe("what the form is careful about", () => {
  /**
   * 🔴 AN EMPTY OPTIONAL FIELD IS SENT AS `null`, NEVER `""`. The schemas
   * validate what they are given: `""` is not "absent", it is a string
   * that fails `.email()`, `.length(2)` and the money regex — and the
   * operator is told their blank email address is invalid.
   */
  it("sends null for a blank optional field", () => {
    const code = codeOnly(FORM);
    expect(code).toContain("const orNull");
    expect(code).toContain('trimmed === "" ? null : trimmed');
    expect(code).toContain("email: orNull(values.email)");
  });

  /**
   * ⚠️ "PHONE OR EMAIL" IS CHECKED HERE, MIRRORING `createLeadRefined`.
   * Marking both `required` would demand both, and a walk-in who left a
   * number and no email is a lead.
   */
  it("requires one contact route without requiring both", () => {
    const code = codeOnly(FORM);
    expect(code).toContain("!values.email.trim() && !values.phone.trim()");
    expect(code).not.toMatch(/id="lead-email"[\s\S]{0,200}required/);
  });

  /** ⭐ One component, two actions — `updateLeadSchema` IS the create one. */
  it("is the same form in create and edit mode", () => {
    expect(codeOnly(FORM)).toContain('mode === "edit" ? { id: leadId } : {}');
    expect(codeOnly(PANEL)).toContain('mode="edit"');
    expect(codeOnly(NEW_PAGE)).toContain('mode="create"');
  });
});

/* ================================================================== */
/* ⑦ THE OPTIONS HELPER                                                */
/* ================================================================== */

describe("sales-leads-form.ts", () => {
  /**
   * ⚠️ EVERY EXPORT OF `sales-leads.ts` IS A BROWSER-REACHABLE ENDPOINT,
   * and that file is read as a guard audit. A dropdown helper does not
   * belong in it.
   */
  it("is a separate module, and says why", () => {
    expect(OPTIONS).toContain("SEPARATE FROM `sales-leads.ts` ON PURPOSE");
    expect(codeOnly(OPTIONS)).toContain('requirePermission("leads:read")');
  });

  /**
   * 🔴 AND IT IS NOT `listProjectOptions`, WHICH RETURNS THE SAME SHAPE.
   * That one is gated on `sales.orders.read`, which `member` — the sales
   * executive who fills this form in — does not hold. Reusing it would
   * hand the primary user an empty dropdown and no explanation.
   */
  it("does not reuse the orders helper, and says why", () => {
    expect(codeOnly(OPTIONS)).not.toContain("listProjectOptions(");
    expect(OPTIONS).toContain("sales.orders.read");
  });

  /**
   * ⚠️ EACH LIST CARRIES ITS OWN PERMISSION, checked with the PURE
   * `can()` rather than `checkPermission()` — the latter writes a row to
   * `permission_denials`, and a form deciding what to render is not
   * somebody attempting something they should not. Logging page loads as
   * denials is how a real denial stops being noticed.
   */
  it("checks each module's read key without logging a denial", () => {
    const code = codeOnly(OPTIONS);
    expect(code).toContain('can(subject, "projects:read")');
    expect(code).toContain('can(subject, "partners:read")');
    expect(code).toContain('can(subject, "users:read")');
    expect(code).not.toContain("checkPermission");
  });

  /** ⚠️ A withheld list is named, so the form can explain the empty select. */
  it("names the lists it withheld", () => {
    const code = codeOnly(OPTIONS);
    expect(code).toContain('withheld.push("projects")');
    expect(codeOnly(FORM)).toContain('withheld.includes("projects")');
  });

  /**
   * ⚠️ ACTIVE PARTNERS ONLY. Attributing a lead to a terminated firm
   * starts a protection window against a payout `payoutBlockerFor()`
   * already refuses, and the argument surfaces months later at the
   * booking with the window as evidence for the wrong side.
   */
  it("offers only active channel partners", () => {
    expect(codeOnly(OPTIONS)).toContain('eq(channelPartners.status, "active")');
  });
});
