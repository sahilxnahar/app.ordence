/**
 * Batch 48 — refund caps and step-up re-authentication.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THESE TESTS BYPASS THE UI ENTIRELY, AND THAT IS THE POINT.
 * ══════════════════════════════════════════════════════════════════════
 * Not one of them renders a component or clicks a button. They call the
 * engine that `issueCreditNote` calls, exactly as a `curl` holding a
 * stolen session would arrive at it — with no form, no disabled button
 * and no client-side arithmetic in the way. A test that drove the screen
 * would prove only that the screen behaves, which is the thing this
 * batch explicitly refuses to rely on.
 *
 * ⚠️ THEY ASSERT PROPERTIES, NOT SENTENCES. The refusals below are
 * checked for their OUTCOME, their WORD and the arithmetic of how far
 * over the line they are. Pinning the exact prose would mean a copy
 * improvement fails the build while the control still works — and worse,
 * that the cheapest way to make the build green is to revert the copy.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assessCreditNoteCap,
  resolveCapMinor,
  stepUpFresh,
  DEFAULT_PER_NOTE_CAP_MINOR,
  DEFAULT_DAILY_CAP_MINOR,
  STEP_UP_ABOVE_MINOR,
  STEP_UP_MAX_AGE_MINUTES,
  CREDIT_NOTE_SCOPE,
  CREDIT_NOTE_DAILY_SCOPE,
} from "@/lib/sales/refund-cap";
import { APPROVAL_SCOPES } from "@/lib/validators/credit";
import { readFactorEvidence, NO_FACTOR_EVIDENCE } from "@/lib/security/session-policy";

/** A session that verified a factor a minute ago — step-up is satisfied. */
const FRESH = readFactorEvidence({ fva: [1, 1] });
/** Signed in this morning. Real, verified, and far too old to prove presence. */
const STALE = readFactorEvidence({ fva: [400, 400] });

const base = {
  issuedTodayMinor: 0n,
  perNoteCapMinor: DEFAULT_PER_NOTE_CAP_MINOR,
  perNoteCapIsDefault: true,
  dailyCapMinor: DEFAULT_DAILY_CAP_MINOR,
  dailyCapIsDefault: true,
  factors: FRESH,
};

/* ================================================================== */
/* 🔴 THE BOUNDARY, IN PAISE                                           */
/* ================================================================== */

describe("🔴 the per-note cap is exact in bigint", () => {
  const cap = 5_000_000n; // ₹50,000.00

  it("allows one paisa under the cap", () => {
    const v = assessCreditNoteCap({ ...base, perNoteCapMinor: cap, noteTotalMinor: cap - 1n });
    expect(v.outcome).toBe("allow");
    expect(v.overByMinor).toBe(0n);
  });

  /**
   * ⚠️ A cap of ₹50,000 that refuses ₹50,000 is a cap of ₹49,999.99, and
   * whoever typed the number will never be told which one they got.
   */
  it("allows exactly the cap", () => {
    const v = assessCreditNoteCap({ ...base, perNoteCapMinor: cap, noteTotalMinor: cap });
    expect(v.outcome).toBe("allow");
  });

  it("refuses one paisa over the cap, and says by how much", () => {
    const v = assessCreditNoteCap({ ...base, perNoteCapMinor: cap, noteTotalMinor: cap + 1n });
    expect(v.outcome).toBe("over_note_cap");
    expect(v.overByMinor).toBe(1n);
  });

  /**
   * 🔴 THE FLOAT TRAP, WRITTEN OUT. `Math.round(Number("1.005") * 100)`
   * is 100 rather than 101; at ₹50,000.005 a float-based cap would let
   * the paisa through. Nothing on this path may round.
   */
  it("refuses an amount only a float would call equal to the cap", () => {
    // The documented trap, reproduced: ₹1.005 through a float is 100
    // paise, so a cap of ₹1.00 would wave it through as exactly equal.
    const throughAFloat = BigInt(Math.round(Number("1.005") * 100));
    expect(throughAFloat).toBe(100n);
    const trueMinor = 101n;
    expect(
      assessCreditNoteCap({ ...base, perNoteCapMinor: 100n, noteTotalMinor: throughAFloat })
        .outcome,
    ).toBe("allow");
    expect(
      assessCreditNoteCap({ ...base, perNoteCapMinor: 100n, noteTotalMinor: trueMinor }).outcome,
    ).toBe("over_note_cap");
  });

  it("scales to amounts past Number.MAX_SAFE_INTEGER without losing a paisa", () => {
    const huge = BigInt(Number.MAX_SAFE_INTEGER) + 10n;
    const v = assessCreditNoteCap({ ...base, perNoteCapMinor: huge, noteTotalMinor: huge + 1n });
    expect(v.overByMinor).toBe(1n);
  });
});

/* ================================================================== */
/* 🔴 THE DAY IS SUMMED, NOT COUNTED                                   */
/* ================================================================== */

describe("🔴 two under-cap credit notes that together exceed the day", () => {
  const perNote = 5_000_000n;
  const daily = 8_000_000n;
  const each = 4_500_000n; // under the per-note cap, twice over half the day

  const day = { ...base, perNoteCapMinor: perNote, dailyCapMinor: daily };

  it("lets the first one through", () => {
    const v = assessCreditNoteCap({ ...day, issuedTodayMinor: 0n, noteTotalMinor: each });
    expect(v.outcome).toBe("allow");
  });

  /**
   * ⭐ THE SECOND IS REFUSED BY THE SUM OF THE ROWS, NOT BY ITS OWN SIZE.
   * `issuedTodayMinor` here stands for what the enforcement point reads
   * out of `sales_credit_notes` inside the transaction — the first note,
   * already issued.
   */
  it("refuses the second on the day's total, not on its own size", () => {
    const v = assessCreditNoteCap({ ...day, issuedTodayMinor: each, noteTotalMinor: each });
    expect(v.outcome).toBe("over_daily_cap");
    expect(v.overByMinor).toBe(each + each - daily);
    // ⚠️ The same note, on a fresh day, is unremarkable — proving the
    // refusal came from the running total and nothing else.
    expect(assessCreditNoteCap({ ...day, issuedTodayMinor: 0n, noteTotalMinor: each }).outcome).toBe(
      "allow",
    );
  });

  it("counts the note in hand inside the day's total, not against the remainder", () => {
    const exact = assessCreditNoteCap({
      ...day,
      issuedTodayMinor: daily - each,
      noteTotalMinor: each,
    });
    expect(exact.outcome).toBe("allow");
    const overByOne = assessCreditNoteCap({
      ...day,
      issuedTodayMinor: daily - each + 1n,
      noteTotalMinor: each,
    });
    expect(overByOne.outcome).toBe("over_daily_cap");
    expect(overByOne.overByMinor).toBe(1n);
  });
});

/* ================================================================== */
/* ⚠️ UNSET IS NOT UNLIMITED                                           */
/* ================================================================== */

describe("⚠️ what an unset cap means", () => {
  it("falls back to a figure when no approval_limits row exists", () => {
    const missing = resolveCapMinor(null, DEFAULT_PER_NOTE_CAP_MINOR);
    expect(missing.capMinor).toBe(DEFAULT_PER_NOTE_CAP_MINOR);
    expect(missing.capIsDefault).toBe(true);
  });

  it("treats an absent row as a real ceiling that refuses", () => {
    const v = assessCreditNoteCap({
      ...base,
      noteTotalMinor: DEFAULT_PER_NOTE_CAP_MINOR + 1n,
    });
    expect(v.outcome).toBe("over_note_cap");
  });

  /**
   * ⭐ A ROW WHOSE VALUE IS NULL IS A DECISION SOMEBODY TYPED. It is
   * honoured, and it is the only way to get no ceiling at all.
   */
  it("honours an explicit NULL row as unlimited, and reports it as configured", () => {
    const explicit = resolveCapMinor({ maxValueMinor: null }, DEFAULT_PER_NOTE_CAP_MINOR);
    expect(explicit.capMinor).toBeNull();
    expect(explicit.capIsDefault).toBe(false);

    const v = assessCreditNoteCap({
      ...base,
      perNoteCapMinor: null,
      perNoteCapIsDefault: false,
      dailyCapMinor: null,
      dailyCapIsDefault: false,
      noteTotalMinor: 999_999_999_999n,
    });
    expect(v.outcome).toBe("allow");
  });

  it("keeps zero distinguishable from unset", () => {
    const blocked = resolveCapMinor({ maxValueMinor: 0n }, DEFAULT_PER_NOTE_CAP_MINOR);
    expect(blocked.capMinor).toBe(0n);
    expect(
      assessCreditNoteCap({ ...base, perNoteCapMinor: 0n, noteTotalMinor: 1n }).outcome,
    ).toBe("over_note_cap");
  });

  it("registers both scopes so a limit row can actually be set", () => {
    expect(APPROVAL_SCOPES).toContain(CREDIT_NOTE_SCOPE);
    expect(APPROVAL_SCOPES).toContain(CREDIT_NOTE_DAILY_SCOPE);
  });
});

/* ================================================================== */
/* ⭐ STEP-UP — THE SAME EVIDENCE AS BATCH 136                          */
/* ================================================================== */

describe("⭐ step-up re-authentication", () => {
  const big = STEP_UP_ABOVE_MINOR + 1n;

  it("leaves small credit notes alone", () => {
    expect(
      assessCreditNoteCap({ ...base, factors: STALE, noteTotalMinor: STEP_UP_ABOVE_MINOR }).outcome,
    ).toBe("allow");
  });

  it("refuses a large one on a session that authenticated hours ago", () => {
    const v = assessCreditNoteCap({ ...base, factors: STALE, noteTotalMinor: big });
    expect(v.outcome).toBe("step_up_required");
  });

  it("allows the same one once a factor has just been verified", () => {
    expect(assessCreditNoteCap({ ...base, factors: FRESH, noteTotalMinor: big }).outcome).toBe(
      "allow",
    );
  });

  /**
   * 🔴 "WE COULD NOT CHECK" MUST NEVER LOOK LIKE "WE CHECKED AND IT WAS
   * FINE" — the defect Batches 43 and 136 were spent removing.
   */
  it("refuses when the deployment publishes no factor claim at all", () => {
    expect(stepUpFresh(NO_FACTOR_EVIDENCE, STEP_UP_MAX_AGE_MINUTES)).toBe(false);
    const v = assessCreditNoteCap({ ...base, factors: NO_FACTOR_EVIDENCE, noteTotalMinor: big });
    expect(v.outcome).toBe("step_up_required");
    // ⚠️ The two ways to fail are told apart, so an administrator with a
    // misconfigured Clerk template is not sent round the sign-in loop.
    expect(v.reason).not.toBe(
      assessCreditNoteCap({ ...base, factors: STALE, noteTotalMinor: big }).reason,
    );
  });

  it("accepts the younger of the two factor ages", () => {
    expect(stepUpFresh(readFactorEvidence({ fva: [900, 2] }), STEP_UP_MAX_AGE_MINUTES)).toBe(true);
    expect(stepUpFresh(readFactorEvidence({ fva: [2, -1] }), STEP_UP_MAX_AGE_MINUTES)).toBe(true);
    expect(stepUpFresh(readFactorEvidence({ fva: [-1, -1] }), STEP_UP_MAX_AGE_MINUTES)).toBe(false);
  });

  /**
   * ⚠️ A CAP REFUSAL OUTRANKS A STEP-UP PROMPT. Sending somebody to
   * re-authenticate and then refusing them anyway teaches them the
   * security prompt is noise.
   */
  it("says 'not you, not today' before it says 'prove it is you'", () => {
    const v = assessCreditNoteCap({
      ...base,
      factors: STALE,
      noteTotalMinor: DEFAULT_PER_NOTE_CAP_MINOR + 1n,
    });
    expect(v.outcome).toBe("over_note_cap");
  });
});

/* ================================================================== */
/* 🔴 EVERY STATE CARRIES A WORD                                        */
/* ================================================================== */

describe("🔴 refusals are readable without colour", () => {
  const outcomes = [
    assessCreditNoteCap({ ...base, noteTotalMinor: 1n }),
    assessCreditNoteCap({ ...base, noteTotalMinor: DEFAULT_PER_NOTE_CAP_MINOR + 1n }),
    assessCreditNoteCap({
      ...base,
      issuedTodayMinor: DEFAULT_DAILY_CAP_MINOR,
      noteTotalMinor: 1n,
    }),
    assessCreditNoteCap({ ...base, factors: STALE, noteTotalMinor: STEP_UP_ABOVE_MINOR + 1n }),
  ];

  it("gives every distinct outcome its own word and its own sentence", () => {
    expect(new Set(outcomes.map((v) => v.outcome)).size).toBe(outcomes.length);
    expect(new Set(outcomes.map((v) => v.word)).size).toBe(outcomes.length);
    for (const v of outcomes) {
      expect(v.word.trim().length).toBeGreaterThan(0);
      expect(v.reason.trim().length).toBeGreaterThan(0);
    }
  });

  it("never reports a negative overrun", () => {
    for (const v of outcomes) expect(v.overByMinor >= 0n).toBe(true);
  });
});

/* ================================================================== */
/* 🔴 THE WIRING — WHAT TYPESCRIPT CANNOT SEE                           */
/* ================================================================== */

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
/** ⚠️ Comments stripped: an explanation must never read as a relapse. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const ACTIONS = read("server/actions/sales-invoices.ts");
const ENFORCE = code(read("server/sales/refund-cap.ts"));
const ENGINE = code(read("lib/sales/refund-cap.ts"));

describe("🔴 the refusal happens server-side, inside the transaction", () => {
  const body = code(
    ACTIONS.slice(
      ACTIONS.indexOf("export async function issueCreditNote"),
      ACTIONS.indexOf("/* ================================================================== */\n/* ⭐ GSTR-1"),
    ),
  );

  it("finds the issueCreditNote body at all", () => {
    expect(body.length).toBeGreaterThan(500);
  });

  it("calls the cap gate", () => {
    expect(body).toMatch(/assertCreditNoteWithinCaps\s*\(/);
  });

  /**
   * 🔴 THE ORDER IS THE CONTROL. Inside `withTenant`, and ahead of the
   * update that allocates the number and marks the note issued.
   */
  it("calls it inside withTenant and before the note is marked issued", () => {
    const tx = body.indexOf("withTenant(");
    const gate = body.indexOf("assertCreditNoteWithinCaps");
    const issued = body.indexOf('status: "issued"');
    expect(tx).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(tx);
    expect(issued).toBeGreaterThan(gate);
  });

  it("hands the gate the transaction it is writing in, not a fresh connection", () => {
    expect(body).toMatch(/assertCreditNoteWithinCaps\s*\(\s*\{\s*tx\s*,/);
  });

  it("measures the whole document total through the bigint coercion", () => {
    expect(body).toMatch(/noteTotalMinor:\s*toBigIntAmount\(/);
  });
});

describe("🔴 the day comes from the rows", () => {
  it("folds sales_credit_notes rather than reading a counter", () => {
    /**
     * ⚠️ THE `sum(` ASSERTION WAS DROPPED IN BATCH 0101 AND THE INTENT
     * KEPT. The intent of this test is "the day is derived from the rows
     * and never from a stored counter". It used to assert that by looking
     * for the string `sum(`, which was the SQL aggregate the gate happened
     * to use — and 0101 removed that aggregate BECAUSE it was
     * currency-blind: `sum(total_minor)` added dollars to rupees and
     * compared the result with a rupee cap.
     *
     * ⭐ The rows are now read unaggregated and folded per currency in
     * `lib/fx/aggregate.ts`, which is MORE derived-from-the-rows than
     * before, not less. Asserting the shape of the arithmetic would have
     * failed a correct change; asserting that no counter is read does not.
     */
    expect(ENFORCE).toMatch(/salesCreditNotes/);
    expect(ENFORCE).toMatch(/sumByCurrency|reduce|for \(const/);
    expect(ENFORCE).not.toMatch(/issuedTodayColumn|creditedTodayMinor|dailyTotalColumn/);
  });

  /**
   * ⭐⭐ BATCH 0101 — THE DAY IS MEASURED IN ONE CURRENCY.
   *
   * 🔴 THE DEFECT: the daily cap is denominated in the workspace's own
   * currency and the day's total used to be `sum(total_minor)` over every
   * credit note whatever currency each was in. Three USD 5,000 notes
   * consumed 15,000 of a ₹5,00,000 cap instead of about ₹12,50,000 — so
   * the control let out roughly forty times what it was set to.
   *
   * ⚠️ ASSERTED ON THE PROPERTY, NOT ON A COUNT OR A STRING. Both
   * currencies must reach the conversion, and a bucket with no rate must
   * REFUSE rather than be skipped — because the failure mode of a spending
   * control must never be "the control relaxes".
   */
  it("converts every non-functional bucket before comparing with the cap", () => {
    const gate = ENFORCE.slice(ENFORCE.indexOf("export async function assertCreditNoteWithinCaps"));
    expect(gate).toMatch(/noteCurrency/);
    expect(gate).toMatch(/functionalCurrency/);
    expect(gate).toMatch(/convertMinor/);
    // The note being issued is measured in the cap's currency too.
    expect(gate).toMatch(/noteTotalInFunctionalMinor/);
  });

  it("refuses when a bucket has no rate, rather than skipping it", () => {
    const gate = ENFORCE.slice(ENFORCE.indexOf("export async function assertCreditNoteWithinCaps"));
    // A `continue` on a missing rate would silently lower the day's total
    // and therefore raise the effective cap.
    expect(gate).not.toMatch(/if \(!quote\) continue/);
    expect(gate).toMatch(/if \(!quote\) \{[\s\S]{0,400}throw new Error/);
  });

  it("measures the day on issuedAt, never on the date a person typed", () => {
    expect(ENFORCE).toMatch(/salesCreditNotes\.issuedAt/);
    expect(ENFORCE).not.toMatch(/salesCreditNotes\.noteDate/);
  });

  it("scopes the day to the person issuing", () => {
    expect(ENFORCE).toMatch(/salesCreditNotes\.issuedBy/);
  });

  it("does not fail open — no catch swallows the cap decision", () => {
    const gate = ENFORCE.slice(ENFORCE.indexOf("export async function assertCreditNoteWithinCaps"));
    expect(gate.length).toBeGreaterThan(200);
    expect(gate).not.toMatch(/catch/);
  });
});

describe("⭐ one notion of 'recently authenticated', not two", () => {
  it("reads factor age through the Batch 136 module and never touches the claim itself", () => {
    expect(ENFORCE).toMatch(/readFactorEvidence/);
    // ⚠️ The engine may NAME the claim in a sentence it shows an
    // administrator; what it may never do is parse it a second time.
    expect(ENGINE).not.toMatch(/\.fva\b/);
    expect(ENGINE).not.toMatch(/sessionClaims/);
    expect(ENGINE).not.toMatch(/Array\.isArray/);
  });

  it("keeps the engine pure — no database, no clock, no Clerk", () => {
    expect(ENGINE).not.toMatch(/from "@\/db/);
    expect(ENGINE).not.toMatch(/@clerk/);
    expect(ENGINE).not.toMatch(/Date\.now\(\)/);
  });
});
