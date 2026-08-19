/**
 * Ordence — 🔴🔴🔴 PROPOSING A MAPPING, AND KNOWING WHEN NOT TO TRUST IT
 * Version: v1.74.0-alpha · Wave 6
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE FAILURE THESE TESTS EXIST FOR
 * ══════════════════════════════════════════════════════════════════════
 * A mapper that always produces an answer is easy and useless: the answer
 * is always confident, the customer clicks through it, and the first time
 * it is wrong their supplier's PAN is in the GSTIN column of four hundred
 * records and nothing anywhere said it was a guess.
 *
 * So what is under test is not "does it map" — it is:
 *
 *   ① does the CONFIDENCE go down when the evidence is weaker
 *   ② does a MEASURED FACT beat a confident sentence from a model
 *   ③ does the auto-commit line hold, and hold for the right reasons
 *   ④ 🔴 is an opening balance NEVER auto-committed, whatever the score
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  proposeMapping,
  mayAutoCommit,
  overallConfidence,
  parseAutoCommitPolicy,
  neverAutoCommit,
  tokenise,
  AUTO_COMMIT_THRESHOLD,
  DEFAULT_AUTO_COMMIT_POLICY,
  SCORE,
} from "@/lib/import/proposal";
import { evidenceFor, shapeOf } from "@/lib/import/shapes";
import { ALL_IMPORT_ENTITIES, IMPORT_ENTITIES } from "@/lib/import/entities";
import { OPENING_IMPORT_ENTITIES } from "@/lib/import/opening-entities";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const companies = IMPORT_ENTITIES.companies;

/* ================================================================== */
describe("⭐ shapes: what a column IS, not what it is called", () => {
  it("recognises the codes an Indian export is full of", () => {
    expect(shapeOf("29AABCU9603R1ZM")).toBe("gstin");
    expect(shapeOf("AABCU9603R")).toBe("pan");
    expect(shapeOf("HDFC0001234")).toBe("ifsc");
    expect(shapeOf("411001")).toBe("pincode_in");
    expect(shapeOf("a@b.co")).toBe("email");
  });

  it("🔴 tests the specific patterns before the general ones", () => {
    /**
     * A PINCODE and an HSN both match INTEGER. Reversing the order makes
     * every code column look like a number, which is exactly the mistake
     * a spreadsheet makes.
     */
    expect(shapeOf("411001")).not.toBe("integer");
    expect(shapeOf("1234")).toBe("hsn");
  });

  it("claims a shape only when it is overwhelming", () => {
    const clean = evidenceFor(Array.from({ length: 20 }, () => "29AABCU9603R1ZM"));
    expect(clean.shape).toBe("gstin");

    const mixed = evidenceFor([
      ...Array.from({ length: 10 }, () => "29AABCU9603R1ZM"),
      ...Array.from({ length: 10 }, () => "not a gstin at all"),
    ]);
    /** ⚠️ At 50% the column is mixed and calling it a GSTIN would send a
     * proposal into auto-commit on the strength of half the values. */
    expect(mixed.shape).toBeNull();
  });

  it("counts blanks separately rather than letting them dilute the share", () => {
    const evidence = evidenceFor(["29AABCU9603R1ZM", "", "", "29AABCU9603R1ZN"]);
    expect(evidence.blanks).toBe(2);
    expect(evidence.shape).toBe("gstin");
  });
});

/* ================================================================== */
describe("⭐ tokens: the abbreviations an old export actually uses", () => {
  it("splits on case changes as well as separators", () => {
    expect(tokenise("CustNm")).toEqual(["cust", "nm"]);
    expect(tokenise("cust_nm")).toEqual(["cust", "nm"]);
    expect(tokenise("GSTNo")).toEqual(["gst", "no"]);
  });

  it("drops words that carry no signal", () => {
    expect(tokenise("Column1")).not.toContain("column");
  });
});

/* ================================================================== */
describe("🔴 confidence falls as the evidence weakens", () => {
  it("is certain about an exact header", () => {
    const proposal = proposeMapping(companies, companies.columns.map((c) => c.header));
    expect(proposal.confidence).toBe(SCORE.EXACT_HEADER);
    expect(proposal.missingRequired).toEqual([]);
  });

  it("🔴 maps a file whose headers say NOTHING, from the values alone", () => {
    /**
     * ⭐ THE CASE HEADER MATCHING CANNOT REACH, and the reason
     * `lib/import/shapes.ts` exists. `F1 F2 F3` is a real export from a
     * real twenty-year-old system.
     */
    const gstEntity = IMPORT_ENTITIES["gst-parties"];
    const headers = ["F1", "F2", "F3"];
    const rows = Array.from({ length: 20 }, (_, i) => [
      `Party ${i}`,
      `29AABCU9603R1Z${String.fromCharCode(65 + (i % 10))}`,
      "customer",
    ]);
    const proposal = proposeMapping(gstEntity, headers, { sampleRows: rows });
    const gstin = proposal.columns.find((c) => c.field.toLowerCase().includes("gstin"));
    expect(gstin?.sourceHeader).toBe("F2");
    expect(gstin?.basis).toBe("value-shape");
    expect(gstin?.why).toMatch(/matched on its contents rather than its name/);
  });

  it("🔴 reports the WEAKEST required column, not the average", () => {
    /**
     * An average lets nine certain columns carry one guess over the line,
     * and the guess is the one that puts four hundred PANs in the GSTIN
     * field.
     */
    const columns = [
      { field: "a", header: "A", required: true, sourceIndex: 0, sourceHeader: "A", confidence: 1, basis: "exact-header" as const, why: "", alternatives: [] },
      { field: "b", header: "B", required: true, sourceIndex: 1, sourceHeader: "x", confidence: 0.4, basis: "token-overlap" as const, why: "", alternatives: [] },
      { field: "c", header: "C", required: false, sourceIndex: -1, sourceHeader: null, confidence: 0, basis: "none" as const, why: "", alternatives: [] },
    ];
    expect(overallConfidence(columns)).toBe(0.4);
  });

  it("is zero when a required column matched nothing", () => {
    const proposal = proposeMapping(companies, ["totally", "unrelated", "headings"]);
    expect(proposal.confidence).toBe(0);
    expect(proposal.missingRequired.length).toBeGreaterThan(0);
  });

  it("names the columns it did not use", () => {
    const proposal = proposeMapping(companies, [...companies.columns.map((c) => c.header), "Ignore me"]);
    expect(proposal.unmappedSourceHeaders).toEqual(["Ignore me"]);
    expect(proposal.cautions.join(" ")).toMatch(/Ignore me/);
  });

  it("does not give one source column to two fields", () => {
    const proposal = proposeMapping(companies, ["Name"]);
    const used = proposal.columns.filter((c) => c.sourceIndex === 0);
    expect(used.length).toBeLessThanOrEqual(1);
  });
});

/* ================================================================== */
describe("🔴 a measured fact beats a confident sentence", () => {
  const gstEntity = IMPORT_ENTITIES["gst-parties"];
  const headers = ["A", "B"];
  const rows = Array.from({ length: 20 }, () => ["someone@example.com", "29AABCU9603R1ZM"]);

  it("keeps the value-shape match and REPORTS the disagreement", () => {
    const proposal = proposeMapping(gstEntity, headers, {
      sampleRows: rows,
      /** The model says the email column is the GSTIN. It is not. */
      model: { gstin: "A" },
    });
    const gstin = proposal.columns.find((c) => c.field === "gstin");
    expect(gstin?.sourceHeader).toBe("B");
    expect(gstin?.conflict).toMatch(/AI suggestion put "A" here/);
    expect(proposal.cautions.join(" ")).toMatch(/Check this one/);
  });

  it("accepts a model suggestion where nothing else had an opinion", () => {
    const proposal = proposeMapping(companies, ["Bezeichnung", "Domain"], {
      model: { name: "Bezeichnung" },
    });
    const name = proposal.columns.find((c) => c.field === "name");
    expect(name?.sourceHeader).toBe("Bezeichnung");
    expect(name?.basis).toBe("model");
    expect(name?.confidence).toBe(SCORE.MODEL_ONLY);
    expect(name?.why).toMatch(/please check this one/);
  });

  it("ignores a model naming a column that is not in the file", () => {
    const proposal = proposeMapping(companies, ["Name"], { model: { name: "Nope" } });
    expect(proposal.cautions.join(" ")).toMatch(/not in this file/);
  });

  it("ranks a model below every deterministic basis", () => {
    expect(SCORE.MODEL_ONLY).toBeLessThan(SCORE.DECISIVE_SHAPE);
    expect(SCORE.MODEL_ONLY).toBeLessThan(SCORE.TOKEN_CONTAINMENT);
    expect(SCORE.MODEL_ONLY).toBeLessThan(SCORE.ALIAS);
  });
});

/* ================================================================== */
describe("🔴 the auto-commit line, and the four reasons it holds", () => {
  const perfect = proposeMapping(companies, companies.columns.map((c) => c.header));

  it("defaults to reviewing everything", () => {
    expect(DEFAULT_AUTO_COMMIT_POLICY).toBe("propose_only");
    expect(parseAutoCommitPolicy(undefined)).toBe("propose_only");
    expect(parseAutoCommitPolicy("nonsense")).toBe("propose_only");
    expect(parseAutoCommitPolicy("auto_above_threshold")).toBe("auto_above_threshold");
  });

  it("refuses under propose_only however certain it is", () => {
    const verdict = mayAutoCommit(perfect, companies, "propose_only");
    expect(perfect.confidence).toBe(1);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/reviews every mapping/);
  });

  it("allows a perfect mapping once the workspace has opted in", () => {
    const verdict = mayAutoCommit(perfect, companies, "auto_above_threshold");
    expect(verdict.allowed).toBe(true);
    expect(verdict.reason).toMatch(/no disagreement/);
  });

  it("allows a DECLARED alias, because that is a written-down fact", () => {
    /**
     * ⚠️ THIS TEST WAS WRITTEN EXPECTING A REFUSAL AND WAS WRONG.
     * `firm` is in `companies`' alias list — somebody wrote it down after
     * seeing it in a real file — so matching on it is a fact this
     * codebase recorded, not a guess, and 0.95 is the right score.
     * Recording the correction rather than weakening the matcher.
     */
    const aliased = proposeMapping(companies, ["Firm"]);
    expect(aliased.confidence).toBe(SCORE.ALIAS);
    expect(mayAutoCommit(aliased, companies, "auto_above_threshold").allowed).toBe(true);
  });

  it("refuses below the threshold and names the weakest column", () => {
    /**
     * ⭐ `Party` IS A SYNONYM, NOT AN ALIAS. It reaches `company` through
     * the token table — a general rule — rather than through a spelling
     * somebody saw in a file, so it scores as containment (0.7) and does
     * not clear the line.
     */
    const weak = proposeMapping(companies, ["Party name", "Web"]);
    const verdict = mayAutoCommit(weak, companies, "auto_above_threshold");
    expect(weak.confidence).toBeLessThan(AUTO_COMMIT_THRESHOLD);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/least certain required column|is required/);
  });

  it("refuses when the model and the values disagree, whatever the score", () => {
    const conflicted = {
      ...perfect,
      columns: perfect.columns.map((c, i) =>
        i === 0 ? { ...c, conflict: "the AI said otherwise" } : c,
      ),
    };
    const verdict = mayAutoCommit(conflicted, companies, "auto_above_threshold");
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/disagree/);
  });

  it("🔴 NEVER auto-commits an opening balance, whatever the confidence", () => {
    /**
     * ⭐ THE ENTITY VETO OVERRIDES THE SCORE. An opening trial balance
     * sets the starting position of the customer's books and every figure
     * after it derives from it. A mapping that is 99% right here is wrong
     * about somebody's books one time in a hundred, permanently.
     */
    const atomicEntities = Object.values(OPENING_IMPORT_ENTITIES).filter((e) => e.atomic);
    expect(atomicEntities.length).toBeGreaterThan(0);
    for (const entity of atomicEntities) {
      expect(neverAutoCommit(entity)).toBe(true);
      const proposal = proposeMapping(entity, entity.columns.map((c) => c.header));
      expect(proposal.confidence).toBe(1);
      const verdict = mayAutoCommit(proposal, entity, "auto_above_threshold");
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toMatch(/always confirmed by a person/);
    }
  });

  it("derives the veto from `atomic` rather than a second list of names", () => {
    /**
     * ⚠️ A SECOND LIST WOULD DRIFT FROM THE FIRST the day somebody adds
     * an entity, and the drift is silent in the safe-looking direction.
     */
    const source = read("lib/import/proposal.ts");
    expect(source).toMatch(/return Boolean\(entity\.atomic\)/);
  });

  it("the database enforces the same threshold the code does", () => {
    /**
     * 🔴 `import_mapping_auto_cleared_threshold` is the backstop. If the
     * two ever disagree the write fails rather than the log quietly
     * recording an auto-commit the code says was impossible.
     */
    const sql = read("SQL-FILES/0117_import_runs_and_mapping.sql");
    expect(sql).toContain("import_mapping_auto_cleared_threshold");
    expect(sql).toMatch(/confidence_milli >= 900/);
    expect(AUTO_COMMIT_THRESHOLD).toBe(0.9);
  });
});

/* ================================================================== */
describe("⚠️ the AI mapper's leash", () => {
  const source = read("server/import/ai-mapper.ts");

  it("🔴 sends headings and statistics, never a value", () => {
    /**
     * A migration is the moment a workspace has the most data and the
     * least idea what the product does with it. Five sample rows in a
     * prompt is five real customers' names, phone numbers and GSTINs sent
     * to a third party.
     */
    expect(source).toContain("assertPromptIsHeadersOnly");
    expect(source).toMatch(/sensitivity: "open"/);
  });

  it("enforces that claim rather than asserting it in a comment", () => {
    expect(source).toMatch(/export function assertPromptIsHeadersOnly/);
    expect(source).toMatch(/throw new PromptLeakError/);
  });

  it("runs on the workspace's own key, through the 0115 door", () => {
    expect(source).toContain("tenantChatCompletion");
    expect(source).toMatch(/feature: "import_mapping"/);
  });

  it("filters the model's answer against the real field and column lists", () => {
    expect(source).toMatch(/if \(!fields\.has\(mapping\.field\)\) continue;/);
    expect(source).toMatch(/if \(!headers\.has\(mapping\.sourceHeader\)\) continue;/);
  });
});

/* ================================================================== */
describe("⚠️ every importable entity can be proposed against", () => {
  it("has at least one required column, so confidence means something", () => {
    for (const entity of Object.values(ALL_IMPORT_ENTITIES)) {
      expect(
        entity.columns.some((c) => c.required),
        `${entity.key} has no required column, so its proposal confidence would always be 0`,
      ).toBe(true);
    }
  });

  it("proposes a complete mapping from its own canonical headers", () => {
    for (const entity of Object.values(ALL_IMPORT_ENTITIES)) {
      const proposal = proposeMapping(entity, entity.columns.map((c) => c.header));
      expect(proposal.missingRequired, `${entity.key}`).toEqual([]);
      expect(proposal.confidence, `${entity.key}`).toBe(1);
    }
  });
});
