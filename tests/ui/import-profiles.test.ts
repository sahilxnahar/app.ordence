/**
 * Ordence — 🔴🔴🔴 SOURCE PROFILES · PHASE 9
 * Version: v1.84.1-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THESE TESTS ARE FOR, AND WHAT THEY DELIBERATELY CANNOT PROVE
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 NO PROFILE HERE IS VALIDATED AGAINST A REAL EXPORT, and no test in
 * this file pretends otherwise. Not one file that came out of a Busy,
 * Marg, Zoho Books, QuickBooks or Xero installation was available when
 * this phase was written; the six profiles were written from those
 * systems' published export documentation. `SourceProfile.validation`
 * says so per profile, in a required member, and one of the cases below
 * asserts that the sentence is non-empty for every profile that has not
 * been shown a real file.
 *
 * ⚠️ A PROFILE TESTED AGAINST ITS OWN FIXTURE IS VERIFIED BY A FLOOR, so
 * these tests do not do that. What they test is:
 *
 *   ① THE RULES, by induction. Every rule in `checkSourceProfiles` is
 *      broken on purpose and the checker is required to refuse it BY
 *      NAME. A checker proven only by passing is not proven — this
 *      repository has found that defect four times in its own gates.
 *
 *   ② THE SUBORDINATION RULE, by measurement. The brief says a profile
 *      must not overrule a shape detector. That is not something a
 *      comment can establish, so the obvious wrong implementation is
 *      built here and the damage it does is asserted.
 *
 *   ③ THE READERS, against inputs whose right answer is arithmetic
 *      rather than opinion. `13/02/2026` is day-first because there is no
 *      thirteenth month, on any file, from any system.
 *
 *   ④ THE TALLY BUG, in both directions, against an envelope built to
 *      the shape Tally writes rather than to the shape the code expects.
 *
 *   ⑤ THAT NOTHING GOT WORSE for a file that matches no profile, which
 *      is most files.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  applyCivilDateFormat,
  applyNegativeStyle,
  checkSourceProfiles,
  describeProfileDetection,
  detectProfile,
  NEGATIVE_STYLES,
  PROFILE_HEADER_SCORE,
  profileHeaderPriors,
  resolveCivilDateFormat,
  resolveColumnFormats,
  resolveNegativeStyle,
  SOURCE_PROFILE_KEYS,
  SOURCE_PROFILES,
} from "@/lib/import/profiles";
import type { SourceProfile } from "@/lib/import/profiles";
import { readSource } from "@/lib/import/sources";
import { readTally } from "@/lib/import/sources/tally-read";
import { coerceCivilDay, coerceMoneyMinor } from "@/lib/import/values";
import { proposeMapping, SCORE, AUTO_COMMIT_THRESHOLD } from "@/lib/import/proposal";
import { ALL_IMPORT_ENTITIES } from "@/lib/import/entities";

const utf8 = (text: string) => new TextEncoder().encode(text);

/** A deep-enough clone to break one rule without touching the real registry. */
function mutate(
  change: (profiles: Record<string, SourceProfile>) => void,
): Record<string, SourceProfile> {
  const copy = JSON.parse(JSON.stringify(SOURCE_PROFILES)) as Record<string, SourceProfile>;
  change(copy);
  return copy;
}

/**
 * ⚠️ TAKES THE CHANGE, NOT THE REGISTRY. The first version of this helper
 * took a registry and every induction case called it with the mutation
 * callback by mistake — so `Object.keys(aFunction)` was empty, the
 * checker examined nothing, and eleven cases failed identically. Worth
 * recording: a checker handed an empty map reports one problem and looks
 * like it ran.
 */
const problemsOf = (change: (profiles: Record<string, SourceProfile>) => void) =>
  checkSourceProfiles(mutate(change))
    .problems.map((p) => `${p.profile} · ${p.where} · ${p.problem}`)
    .join("\n");

/* ================================================================== */
/* ① THE REGISTRY, AND EVERY RULE PROVEN BY INDUCTION                  */
/* ================================================================== */

describe("⭐ the profile registry checks itself", () => {
  it("passes as shipped, and says how much it examined", () => {
    const result = checkSourceProfiles(SOURCE_PROFILES);
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);

    /**
     * ⚠️ A FLOOR WOULD BE WRONG HERE TOO. These are the exact counts the
     * phase shipped; a profile silently disappearing would leave a `>= 1`
     * assertion perfectly green.
     */
    expect(result.census.profiles).toBe(7);
    expect(result.census.exports).toBe(29);
    expect(result.census.reachableExports).toBe(25);

    /** 🔴 THE HONEST NUMBER. See the header of this file. */
    expect(result.census.validatedAgainstRealExport).toBe(0);
  });

  it("🔴 refuses an export that names an entity the write path cannot reach", () => {
    const problems = problemsOf((p) => {
      // @ts-expect-error — the point is that this is what a typo looks like
      p["zoho-books"]!.exports[0]!.destination = { kind: "entity", entity: "sales-invoices" };
    });
    expect(problems).toContain("sales-invoices");
    expect(problems).toContain("ALL_IMPORT_ENTITIES");
    expect(problems).toContain("falls through at runtime");
  });

  it("🔴 refuses a header mapped to a field the destination entity does not have", () => {
    const problems = problemsOf((p) => {
      // @ts-expect-error — a rename on the entity side looks exactly like this
      p["zoho-books"]!.exports[0]!.headers[0]!.field = "companyTitle";
    });
    expect(problems).toContain("companyTitle");
    expect(problems).toContain("does not have");
  });

  it("🔴 refuses `missingRequired` that understates what the export is short of", () => {
    const problems = problemsOf((p) => {
      // Tally's trial balance has no account code and no as-at date.
      // @ts-expect-error — readonly in the type, mutable in the clone
      p.tally!.exports[0]!.missingRequired = [];
    });
    expect(problems).toContain("accountCode");
    expect(problems).toContain("asAt");
    expect(problems).toContain("finds out at upload");
  });

  it("⚠️ and refuses `missingRequired` that claims a column the export HAS", () => {
    const problems = problemsOf((p) => {
      // @ts-expect-error — readonly in the type, mutable in the clone
      p["zoho-books"]!.exports[0]!.missingRequired = ["name"];
    });
    expect(problems).toContain('"name"');
    expect(problems).toContain("stale warning");
  });

  it("🔴 refuses a one-heading signature", () => {
    const problems = problemsOf((p) => {
      // @ts-expect-error — readonly in the type, mutable in the clone
      p.busy!.exports[0]!.signature = ["Name"];
    });
    expect(problems).toContain("1-heading signature");
  });

  it("🔴 refuses two exports with the same signature — a tie nothing can break", () => {
    const problems = problemsOf((p) => {
      // @ts-expect-error — readonly in the type, mutable in the clone
      p.marg!.exports[0]!.signature = [...p.busy!.exports[0]!.signature];
    });
    expect(problems).toContain("same signature");
    expect(problems).toContain("busy/account-master");
  });

  it("🔴 refuses one heading mapped to two different fields", () => {
    const problems = problemsOf((p) => {
      // @ts-expect-error — readonly in the type, mutable in the clone
      p.xero!.exports[0]!.headers.push({ spelling: "*Contact Name", field: "notes" });
    });
    /** `*ContactName` and `*Contact Name` normalise to the same string. */
    expect(problems).toContain("contactname");
    expect(problems).toContain("cannot be two fields");
  });

  it("🔴 refuses a `not-yet-importable` destination whose entity now exists", () => {
    const problems = problemsOf((p) => {
      // @ts-expect-error — readonly in the type, mutable in the clone
      p["zoho-books"]!.exports[4]!.destination = {
        kind: "not-yet-importable",
        plannedEntity: "companies",
        because: "it says so",
      };
    });
    expect(problems).toContain("did not come back");
  });

  it("🔴 refuses a second fallback, and refuses none", () => {
    expect(
      problemsOf((p) => {
        // @ts-expect-error — readonly in the type, mutable in the clone
        p.tally!.fallback = true;
      }),
    ).toContain("2 profiles are marked as the fallback");

    expect(
      problemsOf((p) => {
        // @ts-expect-error — readonly in the type, mutable in the clone
        p.generic!.fallback = false;
      }),
    ).toContain("0 profiles are marked as the fallback");
  });

  it("🔴 refuses a fallback that carries priors, because they would fire on every file", () => {
    const problems = problemsOf((p) => {
      // @ts-expect-error — readonly in the type, mutable in the clone
      p.generic!.dateFormats = ["mdy-slash"];
    });
    expect(problems).toContain("fires on EVERY file");
  });

  it("⚠️ refuses a profile registered under a key it does not call itself", () => {
    const problems = problemsOf((p) => {
      // @ts-expect-error — readonly in the type, mutable in the clone
      p.marg!.key = "marg-erp";
    });
    expect(problems).toContain("import_runs.source_profile");
  });

  it("⭐ every profile that has not seen a real export says so, in a sentence", () => {
    for (const key of SOURCE_PROFILE_KEYS) {
      const validation = SOURCE_PROFILES[key].validation;
      if (validation.against === "real-export") continue;
      expect(validation.notValidated.length).toBeGreaterThan(40);
      expect(validation.evidence.length).toBeGreaterThan(20);
    }
  });
});

/* ================================================================== */
/* ② THE SQL CONSTRAINT AND THE REGISTRY ARE ONE LIST                  */
/* ================================================================== */

describe("🔴 the CHECK constraint and the profile registry agree", () => {
  /**
   * ⚠️ READ OUT OF THE MIGRATION, NOT RETYPED. A list retyped here would
   * agree with the registry and prove nothing about the file that will
   * actually be applied to the customer's database — which is the whole
   * failure `scripts/check-import-sources.mjs` exists for, one column
   * over.
   */
  const sql = readFileSync(
    join(process.cwd(), "SQL-FILES", "0275_import_runs_source_profile.sql"),
    "utf8",
  );

  function keysFromSql(source: string): string[] {
    const body = source.replace(/^\s*--[^\n]*$/gm, " ");
    const match =
      /ADD CONSTRAINT\s+import_runs_source_profile_known\s+CHECK\s*\(([\s\S]*?)\)\);/.exec(body);
    if (!match) throw new Error("import_runs_source_profile_known not found in 0275");
    return [...(match[1] ?? "").matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]!);
  }

  it("lists exactly the seven profiles", () => {
    const keys = keysFromSql(sql);
    expect([...keys].sort()).toEqual([...SOURCE_PROFILE_KEYS].sort());
    expect(checkSourceProfiles(SOURCE_PROFILES, { sqlProfileKeys: keys }).problems).toEqual([]);
  });

  it("🔴 and the comparison refuses a key the constraint would reject", () => {
    const short = keysFromSql(sql).filter((k) => k !== "xero");
    const problems = checkSourceProfiles(SOURCE_PROFILES, { sqlProfileKeys: short }).problems;
    expect(problems.map((p) => p.profile)).toContain("xero");
    expect(problems.map((p) => p.problem).join(" ")).toContain(
      "with no record of what it was read as",
    );
  });

  it("🔴 and refuses a value the constraint allows that no profile produces", () => {
    const extra = [...keysFromSql(sql), "sage"];
    const problems = checkSourceProfiles(SOURCE_PROFILES, { sqlProfileKeys: extra }).problems;
    expect(problems.map((p) => p.profile)).toContain("sage");
  });

  it("⚠️ the column is nullable and the constraint permits NULL", () => {
    /** NULL is how a run from before 0275 says nothing ever looked. */
    expect(sql).toContain("source_profile IS NULL OR source_profile IN");
    expect(sql).not.toMatch(/source_profile\s+varchar\(20\)\s+NOT NULL/i);
  });
});

/* ================================================================== */
/* ③ DATES — THE VALUES SETTLE IT, THE PROFILE ONLY BREAKS A REAL TIE  */
/* ================================================================== */

describe("⭐⭐⭐ a profile raises a prior; the values settle it", () => {
  /**
   * ⚠️ A MONTH-FIRST PRIOR, WHICH IS THE WRONG ONE FOR THIS COLUMN. It is
   * written out here rather than taken from a profile on purpose: the
   * question these cases ask is what the RESOLVER does with a prior, and
   * pinning them to whichever order the QuickBooks profile happens to
   * carry would make them fail the day somebody revises that judgement.
   * The profile end of the same behaviour is measured separately, through
   * `resolveColumnFormats`, at the foot of this file.
   */
  const monthFirstPrior = ["mdy-slash", "dmy-slash"] as const;

  it("🔴 a day above 12 settles the order against any profile", () => {
    const column = ["13/02/2026", "01/02/2026", "28/02/2026"];
    const resolved = resolveCivilDateFormat(column, monthFirstPrior);
    expect(resolved.format).toBe("dmy-slash");
    expect(resolved.settledBy).toBe("values");
    expect(resolved.why).toContain("13/02/2026");
    expect(resolved.caution).toBeNull();
  });

  it("⚠️ without such a value there is a real tie, and no profile means no answer", () => {
    const column = ["01/02/2026", "03/04/2026", "05/06/2026"];
    const resolved = resolveCivilDateFormat(column, []);
    expect(resolved.settledBy).toBe("unresolved");
    expect(resolved.format).toBeNull();
    expect(resolved.candidates).toEqual(expect.arrayContaining(["dmy-slash", "mdy-slash"]));
    expect(resolved.caution).toContain("different month");
  });

  it("⚠️ the profile breaks that tie AND the answer is labelled as assumed", () => {
    const column = ["01/02/2026", "03/04/2026", "05/06/2026"];
    const resolved = resolveCivilDateFormat(column, monthFirstPrior);
    expect(resolved.format).toBe("mdy-slash");
    expect(resolved.settledBy).toBe("profile-prior");
    expect(resolved.caution).toContain("Nothing in this column proves that");
  });

  it("⭐ and says nothing when the two readings give the same days", () => {
    /** Day equals month on every row: both readings agree. No decision. */
    const resolved = resolveCivilDateFormat(["01/01/2026", "02/02/2026"], []);
    expect(resolved.settledBy).toBe("values");
    expect(resolved.caution).toBeNull();
  });

  it("🔴 a column holding two date formats is refused rather than half-read", () => {
    const resolved = resolveCivilDateFormat(["2026-04-01", "01/04/2026"], ["iso"]);
    expect(resolved.settledBy).toBe("unreadable");
    expect(resolved.format).toBeNull();
    expect(resolved.caution).toContain("will not guess");
  });

  it("⚠️ a two-digit year is read under a stated convention, and the sentence states it", () => {
    const resolved = resolveCivilDateFormat(["1-Apr-26", "15-Dec-25"], []);
    expect(resolved.format).toBe("d-mon-yy");
    expect(resolved.caution).toContain("20xx");
  });

  it("⭐ what comes out is what `coerceCivilDay` accepts — the refusal never has to fire", () => {
    for (const [raw, format, iso] of [
      ["1-Apr-2026", "d-mon-yyyy", "2026-04-01"],
      ["20260401", "yyyymmdd", "2026-04-01"],
      ["01.04.2026", "dmy-dot", "2026-04-01"],
      ["04-01-2026", "mdy-dash", "2026-04-01"],
    ] as const) {
      const parsed = applyCivilDateFormat(raw, format);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error("unreachable");
      expect(parsed.iso).toBe(iso);
      expect(coerceCivilDay(parsed.iso)).toEqual({ ok: true, value: iso });
    }
  });

  it("🔴 a shape check is not a calendar check", () => {
    expect(applyCivilDateFormat("31/02/2026", "dmy-slash").ok).toBe(false);
    expect(applyCivilDateFormat("30-Feb-2026", "d-mon-yyyy").ok).toBe(false);
  });
});

/* ================================================================== */
/* ④ NEGATIVE AMOUNTS                                                  */
/* ================================================================== */

describe("⭐ how a negative is written is a per-profile fact, resolved against the values", () => {
  it("🔴 brackets are a negative, and the result is what `coerceMoneyMinor` accepts", () => {
    const parsed = applyNegativeStyle("(₹1,23,456.78)", "parentheses");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.value).toBe("-1,23,456.78");
    /**
     * ⚠️ THE MEASUREMENT THE COMMENT IN `amounts.ts` PROMISES. Leaving the
     * rupee sign in would produce `-₹1,23,456.78`, which reaches
     * `coerceMoneyMinor`'s pattern with a symbol in the middle.
     */
    expect(coerceMoneyMinor(parsed.value)).toEqual({ ok: true, value: "-12345678" });
  });

  it("⚠️ and a bracketed amount read by anything that strips punctuation is a POSITIVE", () => {
    /** Which is why this module exists at all. */
    expect(coerceMoneyMinor("(1,234.00)".replace(/[()]/g, ""))).toEqual({
      ok: true,
      value: "123400",
    });
  });

  it("⭐ a Dr/Cr column is settled by its own values", () => {
    const column = ["1,250.00 Dr", "3,400.00 Cr", "12.50 Dr"];
    const resolved = resolveNegativeStyle(column, ["leading-minus", "parentheses"]);
    expect(resolved.style).toBe("dr-cr-suffix");
    expect(resolved.settledBy).toBe("values");
    expect(resolved.negatives).toBe(1);
  });

  it("🔴 a column with no negatives in the sample is decided by the profile, and says why", () => {
    /**
     * ⚠️ THE CASE THAT LOOKS HARMLESS AND IS NOT. Nothing in these rows
     * distinguishes the conventions; the choice decides how row 8,000 is
     * read, and row 8,000 is not in the sample.
     */
    const column = ["1,250.00", "3,400.00", "12.50"];
    const resolved = resolveNegativeStyle(column, ["dr-cr-suffix", "cr-suffix"]);
    expect(resolved.style).toBe("dr-cr-suffix");
    expect(resolved.settledBy).toBe("profile-prior");
    expect(resolved.caution).toContain("further down the file");
  });

  it("⚠️ with no profile, the same column reports that nothing had to be decided", () => {
    const resolved = resolveNegativeStyle(["1,250.00", "3,400.00"], []);
    expect(resolved.settledBy).toBe("no-negatives");
    expect(resolved.caution).toContain("Only the first");
  });

  it("🔴 a column mixing conventions is refused rather than half-read", () => {
    const resolved = resolveNegativeStyle(["(1,234.00)", "500.00 Cr", "12.00-"], []);
    expect(resolved.settledBy).toBe("unreadable");
    expect(resolved.style).toBeNull();
    expect(resolved.caution).toContain("wrong sign");
  });

  /**
   * ══════════════════════════════════════════════════════════════════
   * 🔴 THE PROPERTY THAT JUSTIFIES A MISSING BRANCH
   * ══════════════════════════════════════════════════════════════════
   * `resolveNegativeStyle` has no "these two readings disagree" branch.
   * That is only correct if the five conventions never disagree about a
   * column they all explain — so it is measured here rather than assumed,
   * over every marker shape any of them accepts. A sixth style that broke
   * the property would fail this case, which is the point.
   */
  it("⭐ no two conventions that both explain a value ever read it differently", () => {
    const corpus = [
      "1234.00", "0", "1,23,456.78", "₹500", "(1,234.00)", "1234.00-",
      "1234.00 Cr", "1234.00 Dr", "1234.00 credit", "1234.00 debit", "12.5 CR.",
    ];
    for (const value of corpus) {
      const readings = NEGATIVE_STYLES.map((style) => applyNegativeStyle(value, style))
        .filter((r) => r.ok)
        .map((r) => (r.ok ? r.value : ""));
      expect(new Set(readings).size).toBeLessThanOrEqual(1);
    }
  });
});

/* ================================================================== */
/* ⑤ THE SUBORDINATION RULE, MEASURED                                  */
/* ================================================================== */

describe("🔴🔴 a profile must not overrule a shape detector", () => {
  /**
   * The file `lib/import/shapes.ts` opens by describing this file: a
   * column NAMED for the GSTIN that holds PANs, and another column,
   * unhelpfully named, that holds the real GSTINs.
   *
   * ⚠️ THE HEADING USED HERE IS ZOHO'S SPELLING, not Ordence's canonical
   * one — see the case below for why the canonical one is a different
   * and pre-existing story.
   */
  const headers = ["Legal name", "GST Identification Number (GSTIN)", "F7"];
  const rows = [
    ["Acme Ltd", "AABCU9603R", "29AABCU9603R1ZM"],
    ["Beta Pvt", "AAACB2894G", "29AAACB2894G1Z5"],
    ["Gamma LLP", "AAFCG1234H", "29AAFCG1234H1Z9"],
  ];

  const gstParties = ALL_IMPORT_ENTITIES["gst-parties"];

  it("⭐ with the entity as shipped, the VALUES win and the PAN column loses", () => {
    const proposal = proposeMapping(gstParties, headers, { sampleRows: rows });
    const gstin = proposal.columns.find((c) => c.field === "gstin");
    expect(gstin?.sourceHeader).toBe("F7");
    expect(gstin?.basis).toBe("value-shape");
  });

  it("🔴 THE HAZARD: the same spelling merged into `aliases` inverts that", () => {
    /**
     * ══════════════════════════════════════════════════════════════
     * This is the one-line implementation nobody should write, built
     * here so the damage is a number rather than an opinion.
     * `SCORE.ALIAS` is 0.95 and `SCORE.DECISIVE_SHAPE` is 0.90, and the
     * alias branch `return`s before the values are consulted at all.
     * ══════════════════════════════════════════════════════════════
     */
    expect(SCORE.ALIAS).toBeGreaterThan(SCORE.DECISIVE_SHAPE);

    const wrong = {
      ...gstParties,
      columns: gstParties.columns.map((column) =>
        column.field === "gstin"
          ? {
              ...column,
              aliases: [...(column.aliases ?? []), "GST Identification Number (GSTIN)"],
            }
          : column,
      ),
    };
    const proposal = proposeMapping(wrong, headers, { sampleRows: rows });
    const gstin = proposal.columns.find((c) => c.field === "gstin");

    /**
     * ⭐ FIXED AT INTEGRATION. This case asserted the hazard , the PAN
     * column winning at `alias` , and it was right to. The fix landed in
     * `lib/import/proposal.ts`: an EXACT or ALIAS heading whose own column
     * holds an unmistakable OTHER thing is scored `CONTRADICTED_HEADER`
     * (0.6), below `AUTO_COMMIT_THRESHOLD`, so it can no longer commit
     * unattended. The column holding real GSTINs wins on its values.
     *
     * ⚠️ THE LADDER WAS NOT REORDERED. `ALIAS` still outranks
     * `DECISIVE_SHAPE` in general , that is the larger question Phase 9
     * correctly declined to answer. What changed is narrower: a heading
     * its own contents refute cannot auto-commit.
     */
    expect(gstin?.sourceHeader).toBe("F7");
    expect(gstin?.basis).toBe("value-shape");

    /** And the refuted heading is still OFFERED, below the threshold. */
    const refuted = proposal.columns.find(
      (c) => c.field === "gstin" && c.sourceHeader === "GST Identification Number (GSTIN)",
    );
    expect(refuted?.confidence ?? 0).toBeLessThan(AUTO_COMMIT_THRESHOLD);
  });

  it("🔴 and the CANONICAL heading already does the same thing, before any profile", () => {
    /**
     * ══════════════════════════════════════════════════════════════
     * ⚠️ FOUND WHILE WRITING THE CASE ABOVE, AND IT IS NOT THIS PHASE'S
     * DOING. `SCORE.EXACT_HEADER` is 1.0. A file whose column is simply
     * called `GSTIN`, holding PANs, beats a column that holds real
     * GSTINs — with `basis: "exact-header"` and confidence 1.0, which is
     * at `AUTO_COMMIT_THRESHOLD`.
     *
     * The comment on `SCORE.DECISIVE_SHAPE` says "Stronger than a good
     * name". The number says otherwise. Reported to M1 in
     * `PATCH-REQUEST-PHASE-9.md` §1; recorded here because a finding
     * with no failing case attached is one nobody can re-check.
     * ══════════════════════════════════════════════════════════════
     */
    const canonical = ["Legal name", "GSTIN", "F7"];
    const proposal = proposeMapping(gstParties, canonical, { sampleRows: rows });
    const gstin = proposal.columns.find((c) => c.field === "gstin");

    /**
     * ⭐ FIXED AT INTEGRATION, and this is the case that made the fix
     * worth making: a column literally called `GSTIN`, full of PANs, used
     * to win at confidence 1.00 , which IS `AUTO_COMMIT_THRESHOLD`. Four
     * hundred parties migrated with their PAN in the GSTIN column and
     * nothing on screen saying it was a guess.
     */
    expect(gstin?.sourceHeader).toBe("F7");
    expect(gstin?.basis).toBe("value-shape");
    expect(gstin?.confidence).toBeGreaterThanOrEqual(AUTO_COMMIT_THRESHOLD);
  });

  it("⭐ so the profile's band sits below the values and below auto-commit", () => {
    expect(PROFILE_HEADER_SCORE).toBeLessThan(SCORE.DECISIVE_SHAPE);
    expect(PROFILE_HEADER_SCORE).toBeGreaterThan(SCORE.TOKEN_CONTAINMENT);
    expect(PROFILE_HEADER_SCORE).toBeLessThan(AUTO_COMMIT_THRESHOLD);
  });

  it("⚠️ and nothing in this phase writes an alias into an entity", () => {
    const detection = detectProfile(["Display Name", "Company Name", "GST Treatment"]);
    const priors = profileHeaderPriors(detection);
    expect(priors.length).toBeGreaterThan(0);
    /** Data with a sentence attached. Not an `ImportColumn`. */
    for (const prior of priors) {
      expect(prior).not.toHaveProperty("aliases");
      expect(prior.why).toContain("the values win");
    }
  });
});

/* ================================================================== */
/* ⑥ DETECTION                                                         */
/* ================================================================== */

describe("⭐ which system this file came out of", () => {
  const zohoHeaders = [
    "Contact Name", "Company Name", "Display Name", "GST Treatment",
    "GST Identification Number (GSTIN)", "Billing City",
  ];

  it("recognises a Zoho Books contacts export from its headings", () => {
    const detection = detectProfile(zohoHeaders, { fileName: "Contacts.csv" });
    expect(detection.profile.key).toBe("zoho-books");
    expect(detection.basis).toBe("signature");
  });

  it("🔴 and a file name cannot make it something else", () => {
    /** `lib/import/sources/index.ts`: a name is a claim by whoever saved it. */
    const detection = detectProfile(zohoHeaders, { fileName: "tally-daybook-export.csv" });
    expect(detection.profile.key).toBe("zoho-books");
  });

  it("⚠️ a file that matches nothing gets the fallback, which carries no priors", () => {
    const detection = detectProfile(["Widget", "Colour", "Count"], { fileName: "stuff.csv" });
    expect(detection.profile.key).toBe("generic");
    expect(detection.basis).toBe("no-match");
    expect(detection.profile.dateFormats).toEqual([]);
    expect(detection.profile.negativeStyles).toEqual([]);
    expect(profileHeaderPriors(detection)).toEqual([]);
  });

  it("⚠️ one heading in common is not a match", () => {
    expect(detectProfile(["Particulars", "Amount"]).profile.key).toBe("generic");
  });

  it("🔴 the `notValidated` sentence reaches the notes, not just the type", () => {
    const notes = describeProfileDetection(detectProfile(zohoHeaders)).join(" ");
    expect(notes).toContain("not validated against a real export");
  });

  it("⭐ an export Ordence cannot import yet says so instead of being offered", () => {
    const notes = describeProfileDetection(
      detectProfile(["Account Name", "Account Type", "Account Code", "Parent Account"]),
    ).join(" ");
    expect(notes).toContain("cannot import it yet");
    expect(notes).toContain("opening trial balance");
  });

  it("⭐ an export short of a required column says which, before the upload", () => {
    const notes = describeProfileDetection(
      detectProfile(["Particulars", "Debit", "Credit"]),
    ).join(" ");
    expect(notes).toContain("accountCode");
    expect(notes).toContain("refused before any row is read");
  });
});

/* ================================================================== */
/* ⑦ THE TALLY BUG, IN BOTH DIRECTIONS                                 */
/* ================================================================== */

/**
 * ⚠️ BUILT TO THE SHAPE TALLY WRITES, not to the shape the reader
 * expects: `<DATE>` as eight digits, amounts with Tally's sign
 * convention, `ISDEEMEDPOSITIVE`, and the allocation lists nested inside
 * the ledger entries.
 */
function tallyEnvelope(options: { cancelSecond?: boolean; legacyElement?: boolean } = {}) {
  const entry = (ledger: string, amount: string, extra = "") => `
    <${options.legacyElement ? "LEDGERENTRIES" : "ALLLEDGERENTRIES"}.LIST>
      <LEDGERNAME>${ledger}</LEDGERNAME>
      <ISDEEMEDPOSITIVE>${amount.startsWith("-") ? "Yes" : "No"}</ISDEEMEDPOSITIVE>
      <AMOUNT>${amount}</AMOUNT>
      ${extra}
    </${options.legacyElement ? "LEDGERENTRIES" : "ALLLEDGERENTRIES"}.LIST>`;

  return `<?xml version="1.0"?>
<ENVELOPE>
  <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
  <BODY><IMPORTDATA><REQUESTDATA>
    <TALLYMESSAGE>
      <VOUCHER VCHTYPE="Sales" ACTION="Create">
        <DATE>20260401</DATE>
        <VOUCHERNUMBER>S-1</VOUCHERNUMBER>
        <PARTYLEDGERNAME>Acme Ltd</PARTYLEDGERNAME>
        <ISCANCELLED>No</ISCANCELLED>
        ${entry(
          "Acme Ltd",
          "-1000.00",
          `<BILLALLOCATIONS.LIST>
             <NAME>S-1</NAME><BILLTYPE>New Ref</BILLTYPE>
             <BILLCREDITPERIOD>30 Days</BILLCREDITPERIOD>
             <AMOUNT>-1000.00</AMOUNT>
           </BILLALLOCATIONS.LIST>`,
        )}
        ${entry(
          "Sales Account",
          "1000.00",
          `<CATEGORYALLOCATIONS.LIST>
             <CATEGORY>Branch</CATEGORY>
             <COSTCENTREALLOCATIONS.LIST>
               <NAME>Mumbai</NAME><AMOUNT>600.00</AMOUNT>
             </COSTCENTREALLOCATIONS.LIST>
             <COSTCENTREALLOCATIONS.LIST>
               <NAME>Pune</NAME><AMOUNT>400.00</AMOUNT>
             </COSTCENTREALLOCATIONS.LIST>
           </CATEGORYALLOCATIONS.LIST>`,
        )}
      </VOUCHER>
      <VOUCHER VCHTYPE="Sales" ACTION="Create">
        <DATE>20260402</DATE>
        <VOUCHERNUMBER>S-2</VOUCHERNUMBER>
        <PARTYLEDGERNAME>Acme Ltd</PARTYLEDGERNAME>
        <ISCANCELLED>${options.cancelSecond ? "Yes" : "No"}</ISCANCELLED>
        ${entry("Acme Ltd", "-500.00")}
        ${entry("Sales Account", "500.00")}
      </VOUCHER>
      <VOUCHER VCHTYPE="Memorandum" ACTION="Create">
        <DATE>20260403</DATE>
        <VOUCHERNUMBER>M-1</VOUCHERNUMBER>
        <ISCANCELLED>No</ISCANCELLED>
        ${entry("Suspense", "-25.00")}
        ${entry("Sales Account", "25.00")}
      </VOUCHER>
    </TALLYMESSAGE>
  </REQUESTDATA></IMPORTDATA></BODY>
</ENVELOPE>`;
}

const cell = (doc: ReturnType<typeof readTally>, ledger: string, column: string) => {
  const header = doc.records[0]!.cells;
  const row = doc.records.find((r) => r.cells[0] === ledger);
  return row?.cells[header.indexOf(column)];
};

describe("🔴🔴 a cancelled voucher is not in Tally's totals and must not be in ours", () => {
  it("counts a live voucher", () => {
    const doc = readTally(tallyEnvelope(), "ledger-masters");
    expect(cell(doc, "Acme Ltd", "Total debit")).toBe("1500.00");
  });

  it("🔴 and leaves the same voucher out once it is cancelled", () => {
    const doc = readTally(tallyEnvelope({ cancelSecond: true }), "ledger-masters");
    expect(cell(doc, "Acme Ltd", "Total debit")).toBe("1000.00");
  });

  it("⚠️ and says so, because a total that moved needs its explanation beside it", () => {
    const doc = readTally(tallyEnvelope({ cancelSecond: true }), "ledger-masters");
    expect(doc.notes.join(" ")).toContain("1 cancelled voucher was left out");
  });

  it("🔴 the cancelled voucher still BALANCED, which is why nothing downstream caught it", () => {
    /**
     * Equal debits and credits: including it moved every ledger total and
     * left the trial balance footing perfectly. That is the whole reason
     * this was invisible.
     */
    const doc = readTally(tallyEnvelope({ cancelSecond: true }), "voucher-summary");
    const row = doc.records.find((r) => r.cells[2] === "S-2")!;
    expect(row.cells[5]).toBe(row.cells[6]);
    expect(row.cells[8]).toBe("true");
  });
});

describe("⭐ the new Tally views", () => {
  it("the census names every voucher type and what Ordence does with it", () => {
    const doc = readTally(tallyEnvelope(), "voucher-types");
    const types = doc.records.slice(1).map((r) => r.cells[0]);
    expect(types).toEqual(expect.arrayContaining(["Sales", "Memorandum"]));

    const memo = doc.records.find((r) => r.cells[0] === "Memorandum")!;
    /** 🔴 The two that are not in Tally's own books are named as such. */
    expect(memo.cells[6]).toContain("Not in Tally's own books");

    const sales = doc.records.find((r) => r.cells[0] === "Sales")!;
    expect(sales.cells[1]).toBe("2");
    expect(sales.cells[6]).toContain("opening customer invoices");
  });

  it("⚠️ a voucher type nobody recognises is named as unrecognised, not waved through", () => {
    const doc = readTally(
      tallyEnvelope().replace('VCHTYPE="Memorandum"', 'VCHTYPE="Godown Transfer XYZ"'),
      "voucher-types",
    );
    const row = doc.records.find((r) => r.cells[0] === "Godown Transfer XYZ")!;
    expect(row.cells[6]).toContain("does not recognise");
  });

  it("cost-centre allocations come out one row each, under their category", () => {
    const doc = readTally(tallyEnvelope(), "cost-centres");
    const rows = doc.records.slice(1);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.cells[5])).toEqual(["Mumbai", "Pune"]);
    expect(rows[0]!.cells[4]).toBe("Branch");
    expect(rows[0]!.cells[6]).toBe("600.00");
    /** ⚠️ The date is ISO here, the same as in every other view. */
    expect(rows[0]!.cells[0]).toBe("2026-04-01");
  });

  it("⭐ bill references carry the reference TYPE, which is what decides an opening balance", () => {
    const doc = readTally(tallyEnvelope(), "bill-wise");
    const rows = doc.records.slice(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cells[5]).toBe("S-1");
    expect(rows[0]!.cells[6]).toBe("New Ref");
    expect(rows[0]!.cells[7]).toBe("-1000.00");
    expect(doc.notes.join(" ")).toContain("New Ref opens an outstanding");
  });

  it("⚠️ the default view names the other two rather than hiding them", () => {
    const notes = readTally(tallyEnvelope(), "ledger-masters").notes.join(" ");
    expect(notes).toContain("cost-centre allocations");
    expect(notes).toContain("bill-wise references");
  });

  it("🔴 a voucher whose legs are under <LEDGERENTRIES.LIST> reads as balanced and is not", () => {
    const source = tallyEnvelope({ legacyElement: true });

    /**
     * ⭐ FIXED AT INTEGRATION. This case asserted the defect , the ledger
     * view returning a header row and nothing else, because `readVoucher`
     * read only `ALLLEDGERENTRIES.LIST` and such a voucher arrived with
     * `legs: []`, `0n` debits and `0n` credits. ZERO EQUALS ZERO, so it
     * read as perfectly balanced everywhere downstream, which is why
     * nothing else could have caught it.
     *
     * `lib/tally/parse.ts` now reads both elements, so the legs arrive and
     * the ledger view has rows. Phase 9's diagnostic note is what made the
     * fix findable and is no longer the only thing that sees them.
     */
    const ledgers = readTally(source, "ledger-masters");
    expect(ledgers.records.length).toBeGreaterThan(1);

    /** And the allocations still read, from the same element. */
    const bills = readTally(source, "bill-wise");
    expect(bills.records.slice(1)).toHaveLength(1);
  });

  it("⭐ every view still carries the sentence about history staying in Tally", () => {
    for (const view of ["ledger-masters", "voucher-summary", "voucher-types", "cost-centres", "bill-wise"] as const) {
      expect(readTally(tallyEnvelope(), view).notes[0]).toContain("does not");
      expect(readTally(tallyEnvelope(), view).notes[0]).toContain("replay");
    }
  });
});

/* ================================================================== */
/* ⑧ NOTHING GOT WORSE FOR A FILE THAT MATCHES NOTHING                 */
/* ================================================================== */

describe("⚠️ the generic path, which is most files", () => {
  const csv = "Widget,Colour,Count\nBolt,Red,12\nNut,Blue,8\n";

  it("reads exactly the same rows it did before profiles existed", () => {
    const table = readSource(utf8(csv), { fileName: "stock.csv" });
    expect(table.records.map((r) => r.cells)).toEqual([
      ["Widget", "Colour", "Count"],
      ["Bolt", "Red", "12"],
      ["Nut", "Blue", "8"],
    ]);
  });

  it("⭐ gets the fallback profile — an answer, never a null", () => {
    const table = readSource(utf8(csv), { fileName: "stock.csv" });
    expect(table.profile.profile.key).toBe("generic");
    expect(table.profile.match).toBeNull();
  });

  it("⚠️ and no column caution, because nothing had to be decided", () => {
    const table = readSource(utf8(csv), { fileName: "stock.csv" });
    expect(table.formats).toEqual([]);
  });

  it("🔴 a column of company names is never reported as an unreadable amount", () => {
    const names = "Name,Town\nAcme Ltd,Pune\nBeta Pvt,Mumbai\n";
    const table = readSource(utf8(names), { fileName: "parties.csv" });
    expect(table.formats).toEqual([]);
  });

  it("⭐ a recognised file gets its sentence into the notes the wizard already renders", () => {
    const zoho =
      "Display Name,Company Name,GST Treatment,Billing City\n" +
      "Acme,Acme Ltd,business_gst,Pune\n";
    const table = readSource(utf8(zoho), { fileName: "Contacts.csv" });
    expect(table.profile.profile.key).toBe("zoho-books");
    expect(table.notes.join(" ")).toContain("Zoho Books");
    expect(table.notes.join(" ")).toContain("not validated against a real export");
  });

  it("🔴 a Tally XML file is identified from its bytes, not from a header row", () => {
    const table = readSource(utf8(tallyEnvelope()), { fileName: "anything.xml" });
    expect(table.format).toBe("tally-xml");
    expect(table.profile.profile.key).toBe("tally");
    expect(table.profile.basis).toBe("file-bytes");
  });

  it("⚠️ and nothing in the reader rewrote a single cell", () => {
    const table = readSource(utf8("Date,Amount\n13/02/2026,(1234.00)\n"), { fileName: "x.csv" });
    expect(table.records[1]!.cells).toEqual(["13/02/2026", "(1234.00)"]);
    /** The decisions are reported beside the rows, not applied to them. */
    expect(table.formats.length).toBeGreaterThan(0);
  });
});

/* ================================================================== */
/* ⑨ THE COLUMN RESOLVER PICKS ITS COLUMNS FROM THE VALUES             */
/* ================================================================== */

describe("⭐ the resolver picks its own columns, and only speaks when there was a decision", () => {
  it("a column of ledger names is never reported as a date or as an amount", () => {
    const detection = detectProfile(["Particulars", "Debit", "Credit"]);
    expect(detection.profile.key).toBe("tally");

    const findings = resolveColumnFormats(
      ["Particulars", "Debit", "Credit"],
      [
        ["Acme Ltd", "1000.00", ""],
        ["Sales Account", "", "1000.00"],
      ],
      detection,
    );
    expect(findings.find((f) => f.header === "Particulars")).toBeUndefined();
  });

  it("⭐ a month-name date column produces no line, because nothing was decided", () => {
    const detection = detectProfile(["Party's Name", "Pending Amount", "Ref. No."]);
    expect(detection.profile.key).toBe("tally");
    /** The month name settles it; there is no order to get wrong. */
    expect(resolveCivilDateFormat(["1-Apr-2026", "15-Dec-2025"], []).format).toBe("d-mon-yyyy");
    expect(resolveColumnFormats(["Date"], [["1-Apr-2026"], ["15-Dec-2025"]], detection)).toEqual([]);
  });

  it("🔴 and an ambiguous one always does, naming the system that decided it", () => {
    const detection = detectProfile(["Open Balance", "Num", "Transaction Type", "Date"]);
    expect(detection.profile.key).toBe("quickbooks");

    const findings = resolveColumnFormats(
      ["Date"],
      [["01/02/2026"], ["03/04/2026"]],
      detection,
    );
    expect(findings[0]?.date?.settledBy).toBe("profile-prior");
    expect(findings[0]?.date?.format).toBe("dmy-slash");
    expect(findings[0]?.date?.caution).toContain("Nothing in this column proves that");
  });
});
