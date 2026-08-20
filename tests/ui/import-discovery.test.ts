/**
 * Ordence — ⭐⭐⭐ TWENTY UNLABELLED FILES, AND WHAT THEY ARE
 * Version: v1.84.1-alpha · Phase 3
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THIS FILE IS IN THE `ui` PROJECT AND THAT IS THE FIRST ASSERTION
 * ══════════════════════════════════════════════════════════════════════
 * The `ui` project runs in JSDOM, does NOT load `tests/setup.ts`, and has
 * no `TEST_DATABASE_URL`, no `ALLOW_DESTRUCTIVE_TESTS`, and no Postgres
 * behind it. `server/import/discovery.ts` claims to be pure — no
 * database, no network, no clock — and the executable form of that claim
 * is that every test below runs here at all.
 *
 * ⚠️ A COMMENT SAYING "PURE" IS NOT A CHECK. `import "server-only"`
 * anywhere in the module's import graph, or a stray `@/db`, and this file
 * fails to collect. That is the alarm, and it is the reason the tests
 * were not simply added to the security suite where the rest of Phase 3's
 * proof lives.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT IS PROVEN HERE
 * ══════════════════════════════════════════════════════════════════════
 *   §1 a folder of files with useless names is classified from VALUES
 *   §2 the header loses to the values when they disagree
 *   §3 the AI mapper loses to the values when they disagree
 *   §4 the FILE NAME never outranks evidence
 *   §5 declining to choose is a result, with the right reason
 *   §6 the customer's correction wins, and is validated
 *   §7 the folder-level answers: collisions and the load order
 */

import { describe, it, expect } from "vitest";
import { discoverFolder, describeFolder, filenameTokens } from "@/server/import/discovery";
import { ALL_IMPORT_ENTITIES } from "@/lib/import/entities";
import { parseCsv, type CsvRecord } from "@/lib/import/csv";
import { MAX_IMPORT_ROWS } from "@/lib/import/plan";

/* ------------------------------------------------------------------ */
/* FIXTURES — the folder a customer actually turns up with             */
/* ------------------------------------------------------------------ */

function file(name: string, csv: string): { name: string; records: readonly CsvRecord[] } {
  const parsed = parseCsv(csv);
  if (!parsed.ok) throw new Error(`fixture ${name} does not parse: ${parsed.error}`);
  return { name, records: parsed.records };
}

/** A structurally valid GSTIN: 2 state digits, a PAN, an entity digit, Z, a check. */
const gstin = (i: number) => `29AABCU9${String(600 + (i % 100)).padStart(3, "0")}R1ZQ`;
const rows = (n: number, f: (i: number) => string) =>
  Array.from({ length: n }, (_, i) => f(i)).join("\n");

/**
 * ⭐ THE FILE THIS WHOLE MODULE EXISTS FOR. Five columns, no headings
 * worth anything, and a GSTIN column that says what it is.
 */
const ANONYMOUS_PARTIES = file(
  "Master1.csv",
  "F1,F2,F3,F4,F5\n" +
    rows(
      30,
      (i) =>
        `Acme Traders ${i},${gstin(i)},+91 98${String(76543210 + i)},56000${i % 10},2026-04-01`,
    ),
);

const TRIAL_BALANCE = file(
  "Ledger.xlsx",
  "Code,Particulars,As on,Dr,Cr\n" +
    rows(12, (i) =>
      i % 2
        ? `A${100 + i},Account ${i},2026-03-31,${1000 + i}.00,`
        : `B${100 + i},Account ${i},2026-03-31,,${1000 + i}.00`,
    ),
);

const COMPANY_LIST = file(
  "report(3).csv",
  "Name,Website,Employees,Phone,Pincode,City\n" +
    rows(
      25,
      (i) =>
        `Beta Industries ${i},https://beta${i}.example.com,${20 + i},+91 98${String(11111111 + i)},4110${i % 10}1,Pune`,
    ),
);

/** 🔴 The header says GSTIN. Every value is an email address. */
const LYING_HEADER = file(
  "gstins.csv",
  "Name,GSTIN\n" + rows(15, (i) => `Party ${i},someone${i}@example.com`),
);

const FREE_TEXT_ONLY = file(
  "photos(2).csv",
  "Title,Caption\n" + rows(6, (i) => `Pic ${i},A nice photo number ${i}`),
);

const HEADER_ONLY = file("empty-export.csv", "Name,Domain");

const ENTITIES = ALL_IMPORT_ENTITIES;

/* ================================================================== */
/* §1 CLASSIFIED FROM VALUES, NOT FROM NAMES                           */
/* ================================================================== */

describe("§1 a file whose headings say nothing", () => {
  const discovery = discoverFolder([ANONYMOUS_PARTIES], ENTITIES);
  const result = discovery.files[0]!;

  it("is still classified, from the shape of its values", () => {
    expect(result.chosen).toBe("gst-parties");
    expect(result.decidedBy).toBe("evidence");
  });

  it("names the evidence — a count of values, not an opinion about a name", () => {
    const winner = result.candidates.find((c) => c.entity === "gst-parties")!;
    const gstinWitness = winner.witnesses.find((w) => w.field === "gstin")!;

    expect(gstinWitness.sourceHeader).toBe("F2");
    expect(gstinWitness.shape).toBe("gstin");
    expect(gstinWitness.share).toBe(1);
    expect(gstinWitness.confirmedBy).toBe("values-alone");
    expect(winner.why).toContain("100% of the values under \"F2\"");
  });

  it("says out loud that the file still cannot be LOADED, which is a different question", () => {
    /*
     * ⭐ CLASSIFICATION IS NOT MAPPING. `Legal name` has no column,
     * because no detector can recognise a company name — so the file is
     * unmistakably a GST party list AND needs a human on the next screen.
     * Collapsing the two questions is what put this file in the
     * unassigned pile in the first draft.
     */
    const winner = result.candidates.find((c) => c.entity === "gst-parties")!;
    expect(winner.missingRequired).toContain("Legal name");
    expect(result.notes.join(" ")).toContain("still");
    expect(result.notes.join(" ")).toContain("Legal name");
  });

  it("beats the entities that could also read the file, on the number of confirmations", () => {
    const ranked = result.candidates.filter((c) => c.witnesses.length > 0);
    expect(ranked[0]!.entity).toBe("gst-parties");
    expect(ranked[0]!.witnesses.length).toBeGreaterThan(ranked[1]?.witnesses.length ?? 0);
  });
});

/* ================================================================== */
/* §2 THE HEADER LOSES TO THE VALUES                                   */
/* ================================================================== */

describe("§2 a column HEADED GSTIN that holds email addresses", () => {
  const result = discoverFolder([LYING_HEADER], ENTITIES).files[0]!;

  it("is not classified as GST parties on the strength of the heading", () => {
    expect(result.chosen).toBeNull();
  });

  it("reports the disagreement in the customer's own words", () => {
    const gstParties = result.candidates.find((c) => c.entity === "gst-parties")!;
    expect(gstParties.contradictions).toHaveLength(1);
    expect(gstParties.contradictions[0]!.claimedBy).toBe("exact-header");
    expect(gstParties.contradictions[0]!.shape).toBe("email");
    expect(gstParties.contradictions[0]!.sentence).toContain("the contents are the part that can be counted");
    expect(result.undecided).toContain("100% of its values are an email");
  });

  it("costs the candidate its confidence by arithmetic, not by a penalty rule", () => {
    /*
     * ⚠️ THE FAILED CLAIM IS IN THE DENOMINATOR AND NOT THE NUMERATOR.
     * There is no separate contradiction penalty to tune, and therefore
     * none to soften later.
     */
    const gstParties = result.candidates.find((c) => c.entity === "gst-parties")!;
    expect(gstParties.checkableClaims).toBe(1);
    expect(gstParties.witnesses).toHaveLength(0);
    expect(gstParties.confidence).toBe(0);
  });
});

/* ================================================================== */
/* §3 THE MODEL LOSES TO THE VALUES                                    */
/* ================================================================== */

describe("§3 the AI mapper's leash, at folder scale", () => {
  /**
   * 🔴 THE EXACT SENTENCE FROM `lib/import/shapes.ts`: *"a model saying
   * `F3` is the GSTIN when every value in F3 is an email address does not
   * get to be right"*.
   *
   * ⚠️ AND `lib/import/proposal.ts` ALONE DOES NOT CATCH THIS ONE. It
   * reports a conflict when a model disagrees with a decisive shape that
   * already won the column; here nothing else claims `gstin`, so the
   * model takes it unopposed at `SCORE.MODEL_ONLY` and no conflict is
   * raised. Discovery consults the values anyway.
   */
  const withEmails = file(
    "unknown.csv",
    "A,B,C\n" + rows(20, (i) => `Trader ${i},Bengaluru,person${i}@example.com`),
  );

  it("a confident model claiming an email column is the GSTIN does not get to be right", () => {
    const result = discoverFolder([withEmails], ENTITIES, {
      model: { "unknown.csv": { gstin: "C", legalName: "A" } },
    }).files[0]!;

    const gstParties = result.candidates.find((c) => c.entity === "gst-parties")!;
    const contradiction = gstParties.contradictions.find((c) => c.field === "gstin");

    expect(contradiction).toBeDefined();
    expect(contradiction!.claimedBy).toBe("model");
    expect(contradiction!.sentence).toContain("by the AI mapper");
    expect(gstParties.witnesses.find((w) => w.field === "gstin")).toBeUndefined();
    expect(result.chosen).not.toBe("gst-parties");
  });

  it("and a model cannot invent a witness — a witness is a count of values", () => {
    const result = discoverFolder([withEmails], ENTITIES, {
      model: { "unknown.csv": { gstin: "C", legalName: "A" } },
    }).files[0]!;

    for (const candidate of result.candidates) {
      for (const witness of candidate.witnesses) {
        expect(witness.share).toBeGreaterThan(0);
        expect(witness.sampled).toBeGreaterThan(0);
      }
    }
  });
});

/* ================================================================== */
/* §4 THE FILE NAME NEVER OUTRANKS EVIDENCE                            */
/* ================================================================== */

describe("§4 the file name", () => {
  it("is stripped of the three things real export filenames carry", () => {
    expect(filenameTokens("Ledger.xlsx")).toEqual(["ledger"]);
    expect(filenameTokens("report(3).csv")).toEqual(["report"]);
    expect(filenameTokens("Master1.csv")).toEqual(["master"]);
  });

  it("does not win: a company list named `opening trial balance.csv` is still companies", () => {
    /*
     * 🔴 THE NAME IS CHOSEN TO BE MAXIMALLY MISLEADING. Its affinity for
     * the trial balance is non-zero, and it still loses, because affinity
     * is consulted only after confidence, witness count and
     * distinctiveness are all level.
     */
    const misnamed = file("opening trial balance.csv", COMPANY_LIST.records.map((r) => r.cells.join(",")).join("\n"));
    const result = discoverFolder([misnamed], ENTITIES).files[0]!;

    const tb = result.candidates.find((c) => c.entity === "opening-trial-balance")!;
    expect(tb.filenameAffinity).toBeGreaterThan(0);
    expect(result.chosen).toBe("companies");
  });
});

/* ================================================================== */
/* §5 DECLINING TO CHOOSE IS A RESULT                                  */
/* ================================================================== */

describe("§5 the two different reasons for not choosing, kept apart", () => {
  it("nothing recognisable in it: says which detectors were tried", () => {
    const result = discoverFolder([FREE_TEXT_ONLY], ENTITIES).files[0]!;
    expect(result.chosen).toBeNull();
    expect(result.undecided).toContain("no GSTIN, PAN, IFSC, HSN, pincode, date or amount");
  });

  it("a header row and no data: says that discovery reads values", () => {
    const result = discoverFolder([HEADER_ONLY], ENTITIES).files[0]!;
    expect(result.chosen).toBeNull();
    expect(result.unreadable).toContain("no data rows");
    expect(result.candidates).toEqual([]);
  });

  it("an empty file: says so without pretending to have looked", () => {
    const result = discoverFolder([{ name: "nothing.csv", records: [] }], ENTITIES).files[0]!;
    expect(result.unreadable).toContain("no rows in it at all");
  });

  it("a file over the row ceiling is classified AND flagged, not refused", () => {
    const huge = file(
      "big.csv",
      "Name,Website,Employees,Phone,Pincode\n" +
        rows(
          MAX_IMPORT_ROWS + 1,
          (i) =>
            `Big Co ${i},https://big${i}.example.com,${5 + (i % 90)},+91 98${String(10000000 + i)},4110${i % 10}1`,
        ),
    );
    const result = discoverFolder([huge], ENTITIES).files[0]!;
    expect(result.chosen).toBe("companies");
    expect(result.notes.join(" ")).toContain("will have to be split");
  });
});

/* ================================================================== */
/* §6 THE CUSTOMER'S CORRECTION                                        */
/* ================================================================== */

describe("§6 letting the customer correct it", () => {
  it("wins over the evidence, and records that it did", () => {
    const discovery = discoverFolder([COMPANY_LIST], ENTITIES, {
      corrections: { "report(3).csv": "gst-parties" },
    });
    const result = discovery.files[0]!;
    expect(result.chosen).toBe("gst-parties");
    expect(result.decidedBy).toBe("correction");
    expect(result.notes.join(" ")).toContain("You changed this from Companies");
    /* ⭐ AND THE EVIDENCE IS STILL THERE TO BE READ. */
    expect(result.candidates.find((c) => c.entity === "companies")!.witnesses.length).toBeGreaterThan(0);
  });

  it("`null` means the customer said it is not one of ours, and that is a decision", () => {
    const result = discoverFolder([COMPANY_LIST], ENTITIES, {
      corrections: { "report(3).csv": null },
    }).files[0]!;
    expect(result.chosen).toBeNull();
    expect(result.decidedBy).toBe("correction");
    expect(result.undecided).toContain("not one of the lists to import");
  });

  it("🔴 a correction naming something that is not an entity is REFUSED, not ignored", () => {
    /*
     * ⚠️ THE KEY ARRIVES FROM A BROWSER. `isImportEntityKey` exists
     * because a dynamic lookup on an unchecked string is one prototype
     * away from returning `Object.prototype.constructor` — and a
     * correction is the same string from the same place.
     */
    for (const hostile of ["constructor", "__proto__", "toString", "companies "]) {
      const result = discoverFolder([COMPANY_LIST], ENTITIES, {
        corrections: { "report(3).csv": hostile },
      }).files[0]!;
      expect(result.chosen).toBeNull();
      expect(result.undecided).toContain("not an entity this product has");
    }
  });

  it("choosing a file Ordence would not place on its own is allowed and recorded", () => {
    const result = discoverFolder([FREE_TEXT_ONLY], ENTITIES, {
      corrections: { "photos(2).csv": "companies" },
    }).files[0]!;
    expect(result.chosen).toBe("companies");
    expect(result.notes.join(" ")).toContain("would not place on its own");
  });
});

/* ================================================================== */
/* §7 THE FOLDER                                                       */
/* ================================================================== */

describe("§7 the folder-level answers", () => {
  const folder = [
    ANONYMOUS_PARTIES,
    TRIAL_BALANCE,
    COMPANY_LIST,
    LYING_HEADER,
    FREE_TEXT_ONLY,
    HEADER_ONLY,
  ];

  it("places what it can and lists what it cannot", () => {
    const discovery = discoverFolder(folder, ENTITIES);
    expect(
      discovery.files.filter((f) => f.chosen).map((f) => [f.name, f.chosen]),
    ).toEqual([
      ["Master1.csv", "gst-parties"],
      ["Ledger.xlsx", "opening-trial-balance"],
      ["report(3).csv", "companies"],
    ]);
    expect(discovery.unassigned).toEqual(["gstins.csv", "photos(2).csv", "empty-export.csv"]);
  });

  it("reports two files landing on one entity rather than refusing them", () => {
    /*
     * ⚠️ A CUSTOMER LIST AND A SUPPLIER LIST ARE BOTH COMPANIES. Refusing
     * a collision would refuse the commonest real folder there is; not
     * MENTIONING it is a support call about records the second file
     * quietly updated.
     */
    const twice = discoverFolder(
      [COMPANY_LIST, { ...COMPANY_LIST, name: "Master2.csv" }],
      ENTITIES,
    );
    expect(twice.collisions).toEqual([
      { entity: "companies", files: ["Master2.csv", "report(3).csv"] },
    ]);
  });

  it("gives the load order over the entities FOUND, not over all six", () => {
    /*
     * ⭐ `resolveImportOrder` IS GIVEN A SUBSET FOR A REASON. A customer
     * with no supplier file must not be told to load one first; the
     * dependency is satisfied by the workspace rather than by this run.
     */
    const discovery = discoverFolder(folder, ENTITIES);
    expect(discovery.order.ok).toBe(true);
    if (!discovery.order.ok) return;
    expect(discovery.order.steps.map((s) => s.entity).sort()).toEqual([
      "companies",
      "gst-parties",
      "opening-trial-balance",
    ]);
    expect(discovery.order.waves).toBe(1);
  });

  it("puts the invoices after the companies when both are present", () => {
    const invoices = file(
      "AR.csv",
      "Customer,Invoice number,Invoice date,Amount outstanding\n" +
        rows(10, (i) => `Beta Industries ${i},INV-${i},2026-01-${String(10 + i).padStart(2, "0")},${1000 + i}.00`),
    );
    const discovery = discoverFolder([COMPANY_LIST, invoices], ENTITIES, {
      corrections: { "AR.csv": "opening-customer-invoices" },
    });
    expect(discovery.order.ok).toBe(true);
    if (!discovery.order.ok) return;
    const wave = new Map(discovery.order.steps.map((s) => [s.entity, s.wave]));
    expect(wave.get("companies")).toBeLessThan(wave.get("opening-customer-invoices")!);
  });

  it("describes the folder in one sentence a person can act on", () => {
    const sentence = describeFolder(discoverFolder(folder, ENTITIES));
    expect(sentence).toContain("3 of 6 files recognised");
    expect(sentence).toContain("gstins.csv");
    expect(sentence).toContain("stage");
  });
});
