/**
 * Ordence — ⭐⭐⭐ THE FIXED ASSET CONSOLE
 * Batch 100 · v1.65.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THESE TESTS ARE FOR, AND WHAT THEY DELIBERATELY DO NOT PIN
 * ══════════════════════════════════════════════════════════════════════
 * Three properties, each of which fails SILENTLY if it regresses — the
 * screen still renders, the build still passes, and the damage is in the
 * statutory accounts:
 *
 *   ① A REFUSAL IS A VISIBLE STATE. A denied permission, a closed
 *      period, a missing justification — each must reach the person as a
 *      sentence, never as a thrown render or a blank cell.
 *   ② COMPUTING AND POSTING ARE TWO ACTIONS. Clicking compute must not
 *      reach the ledger. A posted run is frozen by a database trigger,
 *      so "one convenient button" is unrecoverable by design.
 *   ③ A LIFE THAT DEPARTS FROM SCHEDULE II PART C WITHOUT A WRITTEN
 *      JUSTIFICATION IS REFUSED, VISIBLY, in the engine's own words.
 *
 * ⚠️ NO COUNT, NO ID AND NO MESSAGE STRING IS PINNED. The refusal texts
 * asserted below are produced by calling the REAL engine, so a reworded
 * refusal moves the assertion with it and only a DELETED refusal fails.
 */

import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  assertAssetIsDepreciable,
  DepreciationError,
  SCHEDULE_II,
  SCHEDULE_II_CLASSES,
  type ScheduleIIClass,
} from "@/lib/fixed-assets/depreciation";
import {
  filterRegister,
  formatMinor,
  justificationDemand,
  parseRupeesToMinor,
  readRegisterRow,
  workingToDate,
  type RegisterRow,
} from "@/lib/fixed-assets/register-view";
import { RegisterAssetForm } from "@/components/fixed-assets/register-asset-form";
import { DepreciationRunner } from "@/components/fixed-assets/depreciation-runner";
import { DisposeAsset } from "@/components/fixed-assets/dispose-asset";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
/** Comments stripped, so a promise made in prose never satisfies a test. */
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/* ================================================================== */
/* ① REFUSALS ARE STATES                                               */
/* ================================================================== */

describe("🔴 a refusal renders rather than throwing", () => {
  it("the registration form says what the permission is instead of offering the button", () => {
    const action = vi.fn();
    render(
      <RegisterAssetForm blocks={[]} registerAction={action} canManage={false} />,
    );

    expect(
      screen.queryByRole("button", { name: /register the asset/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/fixed_assets\.manage/)).toBeInTheDocument();
    expect(action).not.toHaveBeenCalled();
  });

  it("the runner offers no compute control without the manage permission", () => {
    const run = vi.fn();
    render(
      <DepreciationRunner
        defaultPeriodStart="2026-04-01"
        defaultPeriodEnd="2026-04-30"
        runAction={run}
        postAction={vi.fn()}
        detailAction={vi.fn()}
        canManage={false}
        canPost={false}
      />,
    );

    expect(screen.queryByRole("button", { name: /compute/i })).not.toBeInTheDocument();
    expect(screen.getAllByRole("alert").length).toBeGreaterThan(0);
    expect(run).not.toHaveBeenCalled();
  });

  it("a refused computation shows the server's sentence and posts nothing", async () => {
    const user = userEvent.setup();
    const refusal =
      "March 2026 is closed and this run covers days inside it. Reopen the period deliberately.";
    const post = vi.fn();
    render(
      <DepreciationRunner
        defaultPeriodStart="2026-03-01"
        defaultPeriodEnd="2026-03-31"
        runAction={vi.fn(async () => ({ ok: false as const, error: refusal }))}
        postAction={post}
        detailAction={vi.fn()}
        canManage
        canPost
      />,
    );

    await user.click(screen.getByRole("button", { name: /compute/i }));
    expect(await screen.findByText(refusal)).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it("a refused disposal leaves the asset in the register and says why", async () => {
    const user = userEvent.setup();
    const refusal =
      "Depreciation on FA-1 has not been posted up to that date. Run and post the period first.";
    render(
      <DisposeAsset
        assetId="11111111-1111-4111-8111-111111111111"
        assetNo="FA-1"
        disposeAction={vi.fn(async () => ({ ok: false as const, error: refusal }))}
        canPost
        alreadyDisposed={false}
      />,
    );

    await user.type(screen.getByLabelText(/consideration/i), "50000");
    await user.click(screen.getByRole("button", { name: /record the disposal/i }));
    expect(await screen.findByText(refusal)).toBeInTheDocument();
  });

  it("a disposal is not offered at all without the posting permission", () => {
    render(
      <DisposeAsset
        assetId="11111111-1111-4111-8111-111111111111"
        assetNo="FA-1"
        disposeAction={vi.fn()}
        canPost={false}
        alreadyDisposed={false}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /record the disposal/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/fixed_assets\.post/);
  });
});

/* ================================================================== */
/* ② COMPUTE AND POST ARE TWO DELIBERATE ACTIONS                       */
/* ================================================================== */

describe("🔴🔴 computing is not posting", () => {
  const okRun = {
    runId: "22222222-2222-4222-8222-222222222222",
    totalChargeMinor: "123456",
    assetCount: 2,
    lines: [
      {
        assetNo: "FA-1",
        method: "slm",
        daysInUse: 30,
        rateBp: null,
        shiftFactorBp: 10000,
        openingAccumulatedMinor: "0",
        chargeMinor: "123456",
        closingCarryingMinor: "876544",
        terminal: false,
        notes: [],
      },
    ],
    note: "Computed, not posted.",
  };

  function setup() {
    const runAction = vi.fn(async () => ({ ok: true as const, data: okRun }));
    const postAction = vi.fn(async () => ({
      ok: true as const,
      data: { note: "Depreciation is in the ledger." },
    }));
    render(
      <DepreciationRunner
        defaultPeriodStart="2026-04-01"
        defaultPeriodEnd="2026-04-30"
        runAction={runAction}
        postAction={postAction}
        detailAction={vi.fn(async () => ({
          ok: true as const,
          data: { run: {}, lines: [] },
        }))}
        canManage
        canPost
      />,
    );
    return { runAction, postAction, user: userEvent.setup() };
  }

  /**
   * 🔴 THE HEADLINE. If these ever become one control, a company's first
   * depreciation run reaches the statutory books before anybody has read
   * a single line of it — and a posted run is frozen by a trigger.
   */
  it("computing reaches the ledger with nothing", async () => {
    const { runAction, postAction, user } = setup();
    await user.click(screen.getByRole("button", { name: /compute/i }));
    await waitFor(() => expect(runAction).toHaveBeenCalled());
    expect(postAction).not.toHaveBeenCalled();
  });

  it("posting is a second control, pressed after the lines are on screen", async () => {
    const { runAction, postAction, user } = setup();

    expect(screen.queryByRole("button", { name: /post this charge/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /compute/i }));
    const postButton = await screen.findByRole("button", { name: /post this charge/i });
    // The computed lines are readable BEFORE the posting control is used.
    expect(screen.getByText("FA-1")).toBeInTheDocument();

    await user.click(postButton);
    await waitFor(() => expect(postAction).toHaveBeenCalled());
    expect(runAction).toHaveBeenCalledTimes(1);
  });

  it("the posting control is withheld, and explained, without the posting permission", async () => {
    const user = userEvent.setup();
    const postAction = vi.fn();
    render(
      <DepreciationRunner
        defaultPeriodStart="2026-04-01"
        defaultPeriodEnd="2026-04-30"
        runAction={vi.fn(async () => ({ ok: true as const, data: okRun }))}
        postAction={postAction}
        detailAction={vi.fn()}
        canManage
        canPost={false}
      />,
    );

    await user.click(screen.getByRole("button", { name: /compute/i }));
    expect(await screen.findByText("FA-1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /post this charge/i })).not.toBeInTheDocument();
    expect(postAction).not.toHaveBeenCalled();
  });

  /**
   * ⚠️ THE INCOME-TAX SCREEN MUST NOT BE ABLE TO POST AT ALL. Posting the
   * section 32 allowance would put the Income-tax Act's figure into a
   * Companies Act balance sheet.
   */
  it("the income-tax panel cannot reach the posting action", () => {
    const panel = code(read("components/fixed-assets/income-tax-panel.tsx"));
    expect(panel).not.toContain("postDepreciation");
    expect(code(read("app/(crm)/fixed-assets/income-tax/page.tsx"))).not.toContain(
      "postDepreciation",
    );
  });
});

/* ================================================================== */
/* ③ A DIFFERENT LIFE WITHOUT A JUSTIFICATION IS REFUSED, VISIBLY      */
/* ================================================================== */

/** The engine's own refusal for a set of facts, so nothing is pinned. */
function engineRefusalFor(facts: {
  assetClass: ScheduleIIClass;
  usefulLifeMonths: number;
  residualBp: number;
  lifeJustification: string | null;
}): string | null {
  try {
    assertAssetIsDepreciable({
      id: "a",
      assetNo: "FA-1",
      assetClass: facts.assetClass,
      costMinor: 1_000_000n,
      residualBp: facts.residualBp,
      residualJustification: null,
      usefulLifeMonths: facts.usefulLifeMonths,
      lifeJustification: facts.lifeJustification,
      method: "slm",
      shiftUsage: "single",
      putToUseOn: "2025-04-01",
      disposedOn: null,
      accumulatedDepreciationMinor: 0n,
    });
    return null;
  } catch (err) {
    if (err instanceof DepreciationError) return err.message;
    throw err;
  }
}

describe("🔴 Schedule II Part C — a different life has to be justified", () => {
  /**
   * A PROPERTY OVER EVERY CLASS, not one example: for each class in the
   * schedule, a life that is not the prescribed one demands a
   * justification, and the prescribed one does not.
   */
  it("every class demands a justification exactly when the life departs from Part C", () => {
    for (const cls of SCHEDULE_II_CLASSES) {
      const prescribed = SCHEDULE_II[cls].usefulLifeMonths;
      const departed = justificationDemand({
        assetClass: cls,
        usefulLifeMonths: (prescribed ?? 60) + 12,
        residualBp: 500,
      });
      expect(departed.lifeNeedsJustification).toBe(true);
      expect(departed.reasons.length).toBeGreaterThan(0);

      if (prescribed !== null) {
        expect(
          justificationDemand({
            assetClass: cls,
            usefulLifeMonths: prescribed,
            residualBp: 500,
          }).lifeNeedsJustification,
        ).toBe(false);
      }
    }
  });

  it("a residual above the Part A note 5 ceiling demands one too", () => {
    expect(
      justificationDemand({
        assetClass: "plant_machinery_general",
        usefulLifeMonths: 180,
        residualBp: 501,
      }).residualNeedsJustification,
    ).toBe(true);
    expect(
      justificationDemand({
        assetClass: "plant_machinery_general",
        usefulLifeMonths: 180,
        residualBp: 500,
      }).residualNeedsJustification,
    ).toBe(false);
  });

  it("the form asks for the justification the moment the life is changed", async () => {
    const user = userEvent.setup();
    render(<RegisterAssetForm blocks={[]} registerAction={vi.fn()} canManage />);

    expect(screen.queryByLabelText(/justification for a useful life/i)).not.toBeInTheDocument();

    const life = screen.getByLabelText(/useful life/i);
    await user.clear(life);
    await user.type(life, "36");

    expect(await screen.findByLabelText(/justification for a useful life/i)).toBeInTheDocument();
  });

  /**
   * 🔴 AND THE REFUSAL ITSELF IS RENDERED. The action is stubbed with the
   * REAL engine assertion, exactly as the server wires it, so this test
   * proves the sentence reaches the screen rather than that a string
   * matches a string.
   */
  it("a life off the schedule with no justification is refused in the engine's own words", async () => {
    const user = userEvent.setup();
    const registerAction = vi.fn(async (input: unknown) => {
      const d = input as {
        assetClass: ScheduleIIClass;
        usefulLifeMonths: number;
        residualBp: number;
        lifeJustification: string | null;
      };
      const refusal = engineRefusalFor(d);
      return refusal === null
        ? { ok: true as const, data: { id: "new" } }
        : { ok: false as const, error: refusal };
    });

    render(<RegisterAssetForm blocks={[]} registerAction={registerAction} canManage />);

    await user.type(screen.getByLabelText(/asset number/i), "FA-1");
    await user.type(screen.getByLabelText(/description/i), "A lathe");
    await user.type(screen.getByLabelText(/capitalised cost/i), "1000000");
    const life = screen.getByLabelText(/useful life/i);
    await user.clear(life);
    await user.type(life, "36");
    await user.click(screen.getByRole("button", { name: /register the asset/i }));

    const expected = engineRefusalFor({
      assetClass: "plant_machinery_general",
      usefulLifeMonths: 36,
      residualBp: 500,
      lifeJustification: null,
    });
    expect(expected).not.toBeNull();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/justif/i);
    expect(alert.textContent ?? "").toContain(expected as string);
  });

  /**
   * ⭐ AND THE REGISTER ITSELF SHOWS THE REFUSAL RATHER THAN A ZERO. A
   * blank cell reads as "nothing charged yet", which is a different fact.
   */
  it("the register's working refuses a misconfigured asset instead of printing a number", () => {
    const row = registerRow({ usefulLifeMonths: 36, lifeJustification: null });
    const working = workingToDate(row, "2026-03-31");
    expect(working.ok).toBe(false);
    if (!working.ok) expect(working.refusal).toMatch(/justif/i);
  });

  it("the same asset with a justification recorded produces a figure", () => {
    const row = registerRow({
      usefulLifeMonths: 36,
      lifeJustification: "Technical advice from the OEM; disclosed in note 3.",
    });
    const working = workingToDate(row, "2026-03-31");
    expect(working.ok).toBe(true);
  });
});

/* ================================================================== */
/* ④ THE MONEY AND THE READING BACK                                    */
/* ================================================================== */

function registerRow(over: Partial<RegisterRow> = {}): RegisterRow {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    assetNo: "FA-1",
    description: "A lathe",
    assetClass: "plant_machinery_general",
    assetClassLabel: SCHEDULE_II.plant_machinery_general.label,
    costMinor: 3_000_000_00n,
    residualBp: 500,
    residualJustification: null,
    usefulLifeMonths: 180,
    lifeJustification: null,
    prescribedLifeMonths: 180,
    depreciationMethod: "slm",
    shiftUsage: "single",
    acquiredOn: "2025-03-20",
    putToUseOn: "2025-04-01",
    disposedOn: null,
    disposalConsiderationMinor: null,
    status: "in_use",
    location: null,
    itBlockId: null,
    ...over,
  };
}

describe("⚠️ paise cross the boundary as digit strings and come back exact", () => {
  /**
   * A property, not a figure: a cost far beyond what a double can hold
   * survives the round trip unchanged.
   */
  it("reads a cost too large for a double without losing a paisa", () => {
    const huge = "9007199254740993";
    const row = readRegisterRow({
      id: "x",
      assetNo: "FA-9",
      description: "d",
      assetClass: "plant_machinery_general",
      costMinor: huge,
      residualBp: 500,
      usefulLifeMonths: 180,
      depreciationMethod: "slm",
      shiftUsage: "single",
      acquiredOn: "2025-04-01",
      putToUseOn: "2025-04-01",
      status: "in_use",
    });
    expect(row.costMinor.toString()).toBe(huge);
    // ⚠️ THE PROPERTY, NOT THE PUNCTUATION: every digit survives
    // formatting. `Number(huge)` would already have rounded by here.
    expect(formatMinor(row.costMinor).replace(/[^\d]/g, "")).toBe(huge);
    expect(String(Number(huge))).not.toBe(huge);
  });

  it("charged plus carrying is always the cost, whatever the method", () => {
    for (const method of ["slm", "wdv"]) {
      const working = workingToDate(
        registerRow({ depreciationMethod: method }),
        "2027-03-31",
      );
      expect(working.ok).toBe(true);
      if (working.ok) {
        expect(working.chargedMinor + working.carryingMinor).toBe(
          registerRow().costMinor,
        );
        // ⭐ An asset is never written below its residual value.
        expect(working.carryingMinor >= working.residualMinor).toBe(true);
      }
    }
  });

  it("rupees typed into a form become whole paise, and nonsense becomes null", () => {
    expect(parseRupeesToMinor("1")).toBe("100");
    expect(parseRupeesToMinor("1.5")).toBe("150");
    expect(parseRupeesToMinor("1.23")).toBe("123");
    expect(parseRupeesToMinor("1.234")).toBeNull();
    expect(parseRupeesToMinor("")).toBeNull();
    expect(parseRupeesToMinor("-5")).toBeNull();
  });
});

describe("the register filters", () => {
  it("filtering never invents a row, and 'all' is the same as no filter", () => {
    const rows = [
      registerRow({ id: "a", status: "in_use", assetClass: "plant_machinery_general" }),
      registerRow({ id: "b", status: "disposed", assetClass: "office_equipment" }),
    ];
    const everything = filterRegister(rows, { assetClass: "all", status: "all" });
    expect(everything).toEqual(filterRegister(rows, {}));
    expect(everything.length).toBe(rows.length);

    for (const row of rows) {
      const byStatus = filterRegister(rows, { status: row.status });
      expect(byStatus.every((r) => r.status === row.status)).toBe(true);
      expect(byStatus).toContain(row);
    }
  });
});

/* ================================================================== */
/* ⑤ THE ROUTE THE ACTIONS ALREADY REVALIDATE                          */
/* ================================================================== */

describe("the screen the server actions point at", () => {
  it("the path in revalidatePath is a page that exists", () => {
    const actions = code(read("server/actions/fixed-assets.ts"));
    const paths = [...actions.matchAll(/revalidatePath\("([^"]+)"\)/g)].map((m) => m[1]);
    expect(paths.length).toBeGreaterThan(0);
    for (const p of new Set(paths)) {
      expect(() => read(`app/(crm)${p}/page.tsx`)).not.toThrow();
    }
  });

  it("the module registry offers the register to the menu", () => {
    expect(code(read("lib/modules/registry.ts"))).toContain('href: "/fixed-assets"');
  });
});
