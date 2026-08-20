/**
 * Ordence — ⭐⭐⭐ WAVE 2A: THE MIGRATION WIZARD IS REACHABLE
 * Version: v1.89.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS SUITE REFUSES TO SETTLE FOR
 * ══════════════════════════════════════════════════════════════════════
 * "The screen renders" is not the claim. This codebase's characteristic
 * defect is built-and-unreachable, declared-and-unenforced, or
 * verified-by-a-floor — found more than thirty times, four of them inside
 * the checkers written to catch it. A test that renders a component and
 * asserts a heading is present is a floor: it passes just as happily over
 * a screen with an order typed into it by hand.
 *
 * So each property below is proven by INDUCING THE FAILURE:
 *
 *   ① The order is DERIVED. Proven by handing the screen a nineteenth
 *     entity and watching a third group appear. A transcribed list cannot
 *     move.
 *
 *   ② A refusal is a refusal. Proven by handing it a cycle and asserting
 *     that NO group is rendered — not that a warning is present.
 *
 *   ③ The fingerprint is over the BYTES. Proven by one changed byte
 *     changing it, a rename not changing it, and a subarray view hashing
 *     itself rather than the buffer it looks into.
 *
 *   ④ The file is fingerprinted BY THE BROWSER, ON THE WAY TO
 *     `beginImportRun`. Proven by driving the whole wizard and reading
 *     what the action received.
 *
 *   ⑤ "Resumed" and "starting" are different sentences. Proven by
 *     asserting the OTHER one is absent.
 *
 *   ⑥ "Not checked yet" and "zero" do not look alike, and cannot go
 *     green. Proven by a set of lines that all tie except one nobody
 *     measured.
 */

import { describe, expect, it, vi, beforeAll } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createHash } from "node:crypto";

import { LoadOrder } from "@/components/import/load-order";
import { Reconciliation, cutoverVerdict, describeDifference, type ReconciliationLine } from "@/components/import/reconciliation";
import { MappingReview } from "@/components/import/mapping-review";
import { groupIndian, formatCount, formatMinorIndian } from "@/components/import/figures";
import { groupIndian as canonicalGroupIndian } from "@/lib/receivables/numbers";
import { fingerprintBytes, FINGERPRINT_PATTERN } from "@/components/import/fingerprint";
import { ImportWizard } from "@/components/settings/import-wizard";
import { resolveImportOrder } from "@/lib/import/contract";
import { ALL_IMPORT_ENTITIES, MAX_IMPORT_ROWS } from "@/lib/import";
import type { ContractedImportEntity } from "@/lib/import/types";
import type { ImportReport } from "@/lib/import";
import { SCORE, type MappingProposal } from "@/lib/import/proposal";

/**
 * ⚠️ ONE JSDOM GAP, PATCHED IN THE TEST AND NOWHERE ELSE. This jsdom has
 * no `File.prototype.arrayBuffer`; every browser Ordence supports does.
 * Patching it here rather than reaching for `file.text()` in the wizard
 * keeps the production path on `arrayBuffer` — which is the path that
 * must stay, because a spreadsheet decoded as UTF-8 first is destroyed.
 */
beforeAll(() => {
  if (typeof File.prototype.arrayBuffer !== "function") {
    Object.defineProperty(File.prototype, "arrayBuffer", {
      configurable: true,
      value(this: Blob) {
        return new Promise<ArrayBuffer>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as ArrayBuffer);
          reader.onerror = () => reject(reader.error);
          reader.readAsArrayBuffer(this);
        });
      },
    });
  }
});

/* ================================================================== */
/* ① THE LOAD ORDER IS THE ONE `resolveImportOrder` COMPUTES           */
/* ================================================================== */

/** The group headings the screen drew, in order, with what is under each. */
function renderedGroups(container: HTMLElement): string[][] {
  return [...container.querySelectorAll("ul")]
    .filter((ul) => ul.previousElementSibling?.querySelector("h3"))
    .map((ul) =>
      [...ul.children].map(
        (li) => li.querySelector("span.text-sm.font-medium")?.textContent ?? "",
      ),
    );
}

describe("the load order screen", () => {
  it("draws the waves `resolveImportOrder` computes, entity for entity", () => {
    const order = resolveImportOrder(ALL_IMPORT_ENTITIES);
    expect(order.ok).toBe(true);
    if (!order.ok) return;

    const { container } = render(<LoadOrder />);
    const groups = renderedGroups(container);

    expect(groups).toHaveLength(order.waves);
    for (let wave = 0; wave < order.waves; wave += 1) {
      const expected = order.steps
        .filter((s) => s.wave === wave)
        .map((s) => ALL_IMPORT_ENTITIES[s.entity]!.label);
      expect(groups[wave]).toEqual(expected);
    }
  });

  /**
   * 🔴 THE INDUCTION. A screen with the order typed into it passes the
   * test above and fails this one: the nineteenth entity depends on
   * something in the last wave, so a THIRD group has to appear, carrying
   * it. Nothing about this entity is known to the component.
   */
  it("grows a group when an entity is added, because it is derived", () => {
    const base = resolveImportOrder(ALL_IMPORT_ENTITIES);
    expect(base.ok && base.waves).toBe(2);

    const invented: ContractedImportEntity = {
      ...ALL_IMPORT_ENTITIES.contacts,
      key: "wave-3-invention",
      label: "Something Wave 3 Adds",
      contract: {
        ...ALL_IMPORT_ENTITIES.contacts.contract,
        dependsOn: [
          {
            entity: "receipts",
            strength: "hard",
            because: "It is invented, and it is invented to sit after receipts.",
          },
        ],
      },
    };

    const { container } = render(
      <LoadOrder
        entities={{ ...ALL_IMPORT_ENTITIES, "wave-3-invention": invented }}
      />,
    );
    const groups = renderedGroups(container);
    expect(groups).toHaveLength(3);
    expect(groups[2]).toEqual(["Something Wave 3 Adds"]);
    expect(screen.getByText(/Group 3/)).toBeTruthy();
  });

  /**
   * ⭐ THE `because` REACHES THE SCREEN VERBATIM. Not paraphrased, not
   * summarised — every hard edge of every entity.
   */
  it("shows every hard dependency's own sentence", () => {
    render(<LoadOrder />);
    const reasons = Object.values(ALL_IMPORT_ENTITIES)
      .flatMap((e) => e.contract.dependsOn)
      .filter((d) => d.strength === "hard")
      .map((d) => d.because);
    expect(reasons.length).toBeGreaterThan(0);
    for (const because of reasons) {
      expect(screen.getAllByText(because).length).toBeGreaterThan(0);
    }
  });

  /**
   * ⚠️ SOFT ADVICE IS NOT DRAWN AS A DEPENDENCY. It appears under its own
   * heading, which is what stops it reading as a rule that must be
   * satisfied before the customer may start.
   */
  it("keeps soft advice out of the hard edges", () => {
    const withSoft = Object.entries(ALL_IMPORT_ENTITIES).filter(([, e]) =>
      e.contract.dependsOn.some((d) => d.strength === "soft"),
    );
    if (withSoft.length === 0) return;
    render(<LoadOrder />);
    expect(screen.getAllByText("Better if you have it — not required").length).toBe(
      withSoft.length,
    );
  });

  /**
   * 🔴 A CYCLE PRODUCES NO ORDER AT ALL. Not an order with a warning over
   * it — a partial order is worse than none, because the customer follows
   * it.
   */
  it("refuses, and draws nothing, when the graph has a cycle", () => {
    const a = ALL_IMPORT_ENTITIES.companies;
    const looping = {
      alpha: {
        ...a,
        key: "alpha",
        label: "Alpha",
        contract: {
          ...a.contract,
          dependsOn: [{ entity: "beta", strength: "hard" as const, because: "loop" }],
        },
      },
      beta: {
        ...a,
        key: "beta",
        label: "Beta",
        contract: {
          ...a.contract,
          dependsOn: [{ entity: "alpha", strength: "hard" as const, because: "loop" }],
        },
      },
    };

    const { container } = render(<LoadOrder entities={looping} />);
    expect(renderedGroups(container)).toHaveLength(0);
    expect(screen.queryByText(/Group 1/)).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("depend on each other in a loop");
  });
});

/* ================================================================== */
/* ③ THE FINGERPRINT IS OVER THE BYTES                                 */
/* ================================================================== */

const bytesOf = (text: string) => new TextEncoder().encode(text);

describe("the file fingerprint", () => {
  it("is the SHA-256 of the bytes, in the shape the server demands", async () => {
    const bytes = bytesOf("name,domain\nAcme,acme.test\n");
    const printed = await fingerprintBytes(bytes);
    expect(printed).toMatch(FINGERPRINT_PATTERN);
    expect(printed).toBe(
      "sha256:" + createHash("sha256").update(Buffer.from(bytes)).digest("hex"),
    );
  });

  it("does not change when the file is renamed, and does when a cell is fixed", async () => {
    const original = "name,domain\nAcme,acme.test\n";
    const renamedSameBytes = await fingerprintBytes(bytesOf(original));
    const oneCellFixed = await fingerprintBytes(bytesOf(original.replace("Acme", "Acme Ltd")));
    expect(renamedSameBytes).toBe(await fingerprintBytes(bytesOf(original)));
    expect(oneCellFixed).not.toBe(renamedSameBytes);
  });

  /**
   * 🔴 THE VIEW TRAP. `new Uint8Array(buffer, 4, 4)` is four bytes; its
   * `.buffer` is twelve. Hashing `.buffer` would fingerprint bytes that
   * are not in the customer's file, differently on every code path that
   * happened to slice.
   */
  it("hashes the view it was given, not the buffer behind it", async () => {
    const whole = bytesOf("XXXXhelloYYYY");
    const view = whole.subarray(4, 9);
    expect(await fingerprintBytes(view)).toBe(await fingerprintBytes(bytesOf("hello")));
    expect(await fingerprintBytes(view)).not.toBe(await fingerprintBytes(whole));
  });
});

/* ================================================================== */
/* ④⑤ THE WIZARD SENDS IT, AND SAYS WHICH RUN THIS IS                  */
/* ================================================================== */

function reportOf(mode: "preview" | "commit"): ImportReport {
  return {
    mode,
    entityKey: "companies",
    entityLabel: "Companies",
    noun: { one: "company", many: "companies" },
    duplicateMode: "skip",
    totalRows: MAX_IMPORT_ROWS + 1,
    counts: { create: MAX_IMPORT_ROWS + 1, update: 0, skip: 0, error: 0 },
    headers: ["Company name"],
    assignments: [],
    unrecognisedHeaders: [],
    rows: [],
    successSampleShown: 0,
    failedRowsCsv: null,
    fatal: null,
  };
}

/** A file one row larger than a single part, so the migration path runs. */
function bigCsvFile(name = "customers.csv"): File {
  const rows = ["Company name"];
  for (let i = 0; i < MAX_IMPORT_ROWS + 1; i += 1) rows.push(`Company ${i}`);
  return new File([rows.join("\n")], name, { type: "text/csv" });
}

async function driveToMigration(resumed: boolean) {
  const beginRun = vi.fn(async () => ({
    ok: true as const,
    data: {
      runId: "11111111-2222-3333-4444-555555555555",
      chunkSize: MAX_IMPORT_ROWS,
      resumed,
      note: resumed
        ? "This file has been imported into this workspace before, so this run picks up where the last one stopped."
        : null,
    },
  }));
  const preview = vi.fn(async () => ({ ok: true as const, data: reportOf("preview") }));
  const commit = vi.fn(async () => ({ ok: true as const, data: reportOf("commit") }));
  const endRun = vi.fn(async () => ({
    ok: true as const,
    data: { status: "completed" as const, message: "All rows were accounted for.", unaccounted: 0 },
  }));

  const user = userEvent.setup();
  render(
    <ImportWizard
      preview={preview}
      commit={commit}
      beginRun={beginRun}
      endRun={endRun}
      propose={vi.fn()}
      decide={vi.fn()}
    />,
  );

  await user.upload(screen.getByLabelText("Choose a file"), bigCsvFile());
  await user.click(
    screen.getByRole("radio", { name: /Leave the existing record alone/ }),
  );
  await user.click(screen.getByRole("button", { name: /Dry run/ }));
  await user.click(await screen.findByRole("button", { name: /Import all/ }));

  return { beginRun, commit, endRun };
}

describe("the migration path", () => {
  /**
   * 🔴 THE CLAIM: `beginImportRun` REQUIRES A FINGERPRINT AND NOW GETS
   * ONE. Before this wave the wizard sent no `sourceFingerprint` at all,
   * so this argument would have been `undefined` and every migration
   * refused at the first call.
   */
  it("fingerprints the file in the browser and sends it to beginImportRun", async () => {
    const { beginRun } = await driveToMigration(false);
    expect(beginRun).toHaveBeenCalledTimes(1);
    const sent = beginRun.mock.calls[0]![0] as { sourceFingerprint: string; expectedRows: number };
    expect(sent.sourceFingerprint).toMatch(FINGERPRINT_PATTERN);
    expect(sent.expectedRows).toBe(MAX_IMPORT_ROWS + 1);
    /** ⚠️ THE SAME FILE, THE SAME PRINT — computed here independently. */
    const rows = ["Company name"];
    for (let i = 0; i < MAX_IMPORT_ROWS + 1; i += 1) rows.push(`Company ${i}`);
    expect(sent.sourceFingerprint).toBe(
      "sha256:" + createHash("sha256").update(rows.join("\n")).digest("hex"),
    );
  });

  /**
   * ⭐ THE SAME FILE UPLOADED TWICE IS ONE RUN, AND THE SECOND TIME THE
   * SCREEN SAYS SO IN DIFFERENT WORDS.
   *
   * ⚠️ THE ASSERTION THAT MATTERS IS THE ABSENCE. Rendering the resume
   * sentence while also saying "Starting a new migration" would be the
   * defect with a sentence added, not repaired.
   */
  it("says it is resuming, and does not also say it is starting", async () => {
    const { beginRun } = await driveToMigration(true);
    expect(beginRun).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByText(/picks up where the last one stopped/),
    ).toBeTruthy();
    expect(screen.queryByText(/Starting a new migration/)).toBeNull();
  });

  it("says it is starting when the run is new", async () => {
    await driveToMigration(false);
    expect(await screen.findByText(/Starting a new migration/)).toBeTruthy();
    expect(screen.queryByText(/picks up where the last one stopped/)).toBeNull();
  });
});

/* ================================================================== */
/* ② THE MAPPING STEP                                                  */
/* ================================================================== */

const GSTIN_PAN_PROPOSAL: MappingProposal = {
  entityKey: "gst-parties",
  sourceHeaders: ["Party", "GSTIN", "F7"],
  unmappedSourceHeaders: [],
  usedModel: false,
  missingRequired: [],
  cautions: [],
  confidence: SCORE.CONTRADICTED_HEADER,
  columns: [
    {
      field: "legalName",
      header: "Legal name",
      required: true,
      sourceIndex: 0,
      sourceHeader: "Party",
      confidence: SCORE.EXACT_HEADER,
      basis: "exact-header",
      why: '"Party" is named as this column.',
      alternatives: [],
    },
    {
      field: "gstin",
      header: "GSTIN",
      required: true,
      sourceIndex: 1,
      sourceHeader: "GSTIN",
      confidence: SCORE.CONTRADICTED_HEADER,
      basis: "exact-header",
      why:
        '"GSTIN" is named as this column, but 100% of its values look like a pan. The heading ' +
        "and the contents disagree, and the contents are the part that can be counted.",
      alternatives: [],
    },
  ],
};

const GSTIN_PAN_ROWS = [
  ["Sharma Traders", "AABCR5055K", "27AABCR5055K1Z7"],
  ["Nirmal Enterprises", "AAACS1429B", "27AAACS1429B1ZP"],
  ["V. K. Industries", "AAGCS4576P", "24AAGCS4576P1ZI"],
  ["Fourth Row Ltd", "AAGCS4576Q", "24AAGCS4576Q1ZI"],
];

describe("the mapping step", () => {
  it("puts the disagreement on the row, not in a list at the bottom", () => {
    const { container } = render(
      <MappingReview
        proposal={GSTIN_PAN_PROPOSAL}
        sampleRows={GSTIN_PAN_ROWS}
        overrides={{}}
        onOverride={() => {}}
      />,
    );

    const rows = [...container.querySelectorAll("tbody tr")];
    expect(rows).toHaveLength(2);

    /** 🔴 The warning is INSIDE the GSTIN row. */
    const gstinRow = rows[1]!;
    expect(within(gstinRow).getByText(/heading and the contents disagree/)).toBeTruthy();
    expect(within(gstinRow).getByText("Needs your eye")).toBeTruthy();

    /** ⚠️ And the clean row carries no band at all. */
    expect(within(rows[0]!).queryByText(/Needs your eye/)).toBeNull();

    /** ⚠️ Nothing is repeated under the table. */
    const afterTable = container.querySelector("table")!.parentElement!.nextElementSibling;
    expect(afterTable).toBeNull();
  });

  /**
   * ⭐ THREE OF THE CUSTOMER'S OWN VALUES, AND EXACTLY THREE. It is the
   * check: `AABCR5055K` under a column mapped to GSTIN is wrong to a
   * human in one second, and no confidence percentage conveys that.
   */
  it("shows three sample values under the chosen column, and follows an override", () => {
    const { container, rerender } = render(
      <MappingReview
        proposal={GSTIN_PAN_PROPOSAL}
        sampleRows={GSTIN_PAN_ROWS}
        overrides={{}}
        onOverride={() => {}}
      />,
    );
    const gstinCell = () => container.querySelectorAll("tbody tr")[1]!.querySelector("td")!;
    const shown = () => [...gstinCell().querySelectorAll("li")].map((li) => li.textContent);

    expect(shown()).toEqual(["AABCR5055K", "AAACS1429B", "AAGCS4576P"]);

    /** 🔴 The samples must be of the column CHOSEN, not the one proposed. */
    rerender(
      <MappingReview
        proposal={GSTIN_PAN_PROPOSAL}
        sampleRows={GSTIN_PAN_ROWS}
        overrides={{ gstin: "F7" }}
        onOverride={() => {}}
      />,
    );
    expect(shown()).toEqual([
      "27AABCR5055K1Z7",
      "27AAACS1429B1ZP",
      "24AAGCS4576P1ZI",
    ]);
  });

  it("blocks a required column nothing matched, and says what to do", () => {
    const missing: MappingProposal = {
      ...GSTIN_PAN_PROPOSAL,
      missingRequired: ["GSTIN"],
      columns: [
        {
          ...GSTIN_PAN_PROPOSAL.columns[1]!,
          sourceIndex: -1,
          sourceHeader: null,
          confidence: 0,
          basis: "none",
          why: 'Nothing in this file looks like "GSTIN".',
        },
      ],
    };
    render(
      <MappingReview proposal={missing} sampleRows={GSTIN_PAN_ROWS} overrides={{}} onOverride={() => {}} />,
    );
    expect(screen.getByText("Not found in your file")).toBeTruthy();
    expect(screen.getByText(/cannot be imported/)).toBeTruthy();
  });
});

/* ================================================================== */
/* ⑥ RECONCILIATION — "NOT CHECKED" IS NOT "ZERO"                      */
/* ================================================================== */

const measured = (declared: bigint, imported: bigint, key = "k"): ReconciliationLine => ({
  key,
  label: "Debtors",
  unit: { kind: "money", currency: "INR" },
  declaredLabel: "your trial balance",
  importedLabel: "invoices imported",
  measure: { kind: "measured", declared, imported },
});

const unmeasured = (key = "u"): ReconciliationLine => ({
  key,
  label: "Stock on hand",
  unit: { kind: "money", currency: "INR" },
  declaredLabel: "your trial balance",
  importedLabel: "imported and footed",
  measure: { kind: "not-checked", why: "Nobody has measured this yet." },
});

describe("reconciliation and cutover", () => {
  /**
   * 🔴 THE CLAUSE THE WHOLE SCREEN EXISTS FOR. Every line that WAS
   * measured agrees. A screen that reports on what it looked at would go
   * green here, and a migration that reports green with a third of it
   * unmeasured is the failure this wave exists to prevent.
   */
  it("cannot say everything ties while one line was never measured", () => {
    const all = [measured(100n, 100n, "a"), measured(50n, 50n, "b"), unmeasured("c")];
    expect(cutoverVerdict(all)).toEqual({
      verdict: "unknown",
      checked: 2,
      total: 3,
      differing: 0,
    });
    /** ⚠️ AND THE SAME LINES WITH IT MEASURED DO GO GREEN — so the clause above is the cause. */
    expect(cutoverVerdict([all[0]!, all[1]!, measured(0n, 0n, "c")]).verdict).toBe("ties");
  });

  it("treats a difference as more urgent than an unmeasured line", () => {
    expect(cutoverVerdict([measured(100n, 99n), unmeasured()]).verdict).toBe("differs");
  });

  /**
   * ⚠️ A MEASURED ZERO IS A CHECK THAT RAN. It shows two numbers and
   * "they tie"; the unmeasured line shows no numbers at all and says
   * "Not checked yet". The two must not be confusable on the screen, and
   * this asserts the difference in the rendered output.
   */
  it("renders a measured zero and an unmeasured line differently", () => {
    const { container } = render(
      <Reconciliation lines={[measured(0n, 0n, "zero"), unmeasured("none")]} />,
    );
    const items = [...container.querySelectorAll("li")];
    expect(items[0]!.textContent).toContain("they tie");
    expect(items[0]!.textContent).toContain("0.00");
    expect(items[0]!.textContent).not.toContain("Not checked yet");
    expect(items[1]!.textContent).toContain("Not checked yet");
    expect(items[1]!.textContent).not.toContain("0.00");
    expect(screen.getByText(/1 of 2 checks ran/)).toBeTruthy();
  });

  /**
   * ⭐ TWO NUMBERS AND THE DISTANCE BETWEEN THEM, and the distance is a
   * SENTENCE. "-1,400" asks the reader which side is short; "1,400 short"
   * tells them.
   */
  it("says which side is short, in words, unsigned", () => {
    const unit = { kind: "money", currency: "INR" } as const;
    expect(describeDifference(48120000n, 47980000n, unit)).toEqual({
      figure: "1,400.00",
      word: "short",
      ties: false,
    });
    expect(describeDifference(47980000n, 48120000n, unit).word).toBe("over");
    expect(describeDifference(5n, 5n, unit).ties).toBe(true);
  });

  /**
   * 🔴 NEVER RED FOR A NEGATIVE NUMBER. A credit balance is ordinary in an
   * Indian ledger; red on this screen means "this blocks the cutover" and
   * nothing else. The figure itself never carries a minus and never
   * carries a colour of its own.
   */
  it("never renders a minus sign for a shortfall", () => {
    const { container } = render(
      <Reconciliation lines={[measured(48120000n, 47980000n, "short")]} />,
    );
    expect(container.textContent).toContain("1,400.00 short");
    expect(container.textContent).not.toContain("-1,400");
  });
});

/* ================================================================== */
/* THE THREE TYPOGRAPHIC RULES                                         */
/* ================================================================== */

describe("figures", () => {
  it("groups the Indian way", () => {
    expect(groupIndian("2093750")).toBe("20,93,750");
    /** 🔴 THE SAME FUNCTION, NOT AN AGREEING ONE. Five money formatters
     *  already exist in this tree; a sixth would agree until one was fixed. */
    expect(groupIndian).toBe(canonicalGroupIndian);
    expect(formatCount(2093750)).toBe("20,93,750");
    expect(formatCount(481200)).toBe("4,81,200");
    expect(formatCount(999)).toBe("999");
    expect(groupIndian("100000000")).toBe("10,00,00,000");
    /** ⚠️ NOT the thousands grouping, which is the wrong answer everywhere in India. */
    expect(formatCount(2093750)).not.toBe("2,093,750");
  });

  /**
   * 🔴 MINOR UNITS ARE NOT UNIVERSALLY TWO DECIMALS. Dividing by 100 here
   * would report a Kuwaiti amount ten times too large and a Japanese one
   * a hundred times too small.
   */
  it("reads the exponent from the currency", () => {
    expect(formatMinorIndian(209375000n, "INR")).toBe("20,93,750.00");
    expect(formatMinorIndian(1234n, "KWD")).toBe("1.234");
    expect(formatMinorIndian(1234n, "JPY")).toBe("1,234");
  });

  it("puts tabular-nums on every figure it renders", () => {
    const { container } = render(
      <Reconciliation lines={[measured(48120000n, 47980000n, "t")]} />,
    );
    const figures = [...container.querySelectorAll("span.tabular-nums")];
    expect(figures.length).toBeGreaterThanOrEqual(3);
  });
});
