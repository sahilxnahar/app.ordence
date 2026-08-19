/**
 * Ordence — ⭐⭐⭐ THE MULTI-CURRENCY CONSOLE (Batch 0101 · the screens)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THESE ASSERT, AND WHY NOT COUNTS
 * ══════════════════════════════════════════════════════════════════════
 * `tests/ui/multi-currency-fx.test.ts` proves the arithmetic. This file
 * proves the half that a type checker cannot see: that the facts the
 * engine is careful to carry — the derived flag, the skip reason, the
 * currency label, the exponent — actually reach a human eye.
 *
 * Nothing below pins a count, an id, a class name or a total. Every test
 * is either a PROPERTY (this holds for every currency / every rate) or a
 * RELATION between two renders that differ in exactly one field, so no
 * lucky fixture can make it pass.
 *
 *   ① A DERIVED RATE IS LABELLED DERIVED. Two lines identical but for
 *      `rateDerived`; the label appears on one and not the other.
 *   ② A SKIPPED NON-MONETARY LINE IS VISIBLE WITH ITS REASON. The
 *      assertion is that NOTHING GIVEN IS DROPPED — every reference and
 *      every reason handed in comes out in the DOM.
 *   ③ A ZERO-DECIMAL CURRENCY NEVER GAINS PHANTOM PAISE ON SCREEN, and a
 *      three-decimal one never loses a fils. Asserted through the render,
 *      because this is the bug that is right in the arithmetic and wrong
 *      in the display.
 *   ④ RUNNING AND POSTING ARE TWO ACTIONS. Asserted structurally: neither
 *      control can reach the other's action, and both are separately
 *      guarded.
 */

import * as React from "react";
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  KNOWN_CURRENCIES,
  formatMinorPlain,
  minorUnitExponent,
} from "@/lib/fx/currency";
import { RATE_SCALE, formatRateScaled, parseRateToScaled } from "@/lib/fx/rates";
import { labelled, trimRate } from "@/components/fx/fx-format";
import { RevaluationWorking } from "@/components/fx/revaluation-working";
import type { RevaluationLineRow } from "@/server/actions/fx";
import { MODULE_REGISTRY } from "@/lib/modules/registry";
import { INDUSTRY_KEYS, INDUSTRY_TEMPLATES } from "@/lib/industry-templates";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/**
 * ⚠️ ASSERTIONS ABOUT CODE RUN AGAINST COMMENT-STRIPPED SOURCE. A test
 * that matches the prose explaining a rule can only be made to pass by
 * deleting the reason the rule exists.
 */
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const CONSOLE_PAGE = read("app/(crm)/fx/page.tsx");
const DETAIL_PAGE = read("app/(crm)/fx/[id]/page.tsx");
const RUNNER = read("components/fx/revaluation-runner.tsx");
const POSTER = read("components/fx/post-revaluation.tsx");
const RATE_FORM = read("components/fx/record-rate-form.tsx");
const PREVIEW = read("components/fx/conversion-preview.tsx");
const WORKING = read("components/fx/revaluation-working.tsx");
const SETTINGS = read("app/(crm)/settings/financial/page.tsx");
const ACTIONS = read("server/actions/fx.ts");

const UI_FILES: Record<string, string> = {
  "app/(crm)/fx/page.tsx": CONSOLE_PAGE,
  "app/(crm)/fx/[id]/page.tsx": DETAIL_PAGE,
  "components/fx/revaluation-runner.tsx": RUNNER,
  "components/fx/post-revaluation.tsx": POSTER,
  "components/fx/record-rate-form.tsx": RATE_FORM,
  "components/fx/conversion-preview.tsx": PREVIEW,
  "components/fx/revaluation-working.tsx": WORKING,
  "components/fx/fx-format.ts": read("components/fx/fx-format.ts"),
};

function line(over: Partial<RevaluationLineRow> = {}): RevaluationLineRow {
  return {
    itemKind: "receivable",
    isMonetaryItem: true,
    sourceReference: "INV-0001",
    foreignCurrency: "USD",
    foreignAmount: formatMinorPlain(100_000n, "USD"),
    carrying: formatMinorPlain(8_200_000n, "INR"),
    restatedTo: formatMinorPlain(8_321_500n, "INR"),
    plEffect: formatMinorPlain(121_500n, "INR"),
    rate: formatRateScaled(83_215_000_000_000n),
    rateDate: "2026-03-31",
    rateSource: "rbi_reference",
    rateDerived: false,
    restated: true,
    skipReason: null,
    ...over,
  };
}

/* ================================================================== */
/* ① A DERIVED RATE SAYS IT IS DERIVED                                 */
/* ================================================================== */

describe("🔴 a rate obtained by inversion is labelled derived, on the screen", () => {
  /**
   * The relation, not the string. Two lines that differ in exactly one
   * boolean must differ in what the reader is told. If the label were
   * dropped, both renders would be identical and this fails.
   */
  it("labels the derived line and does not label the published one", () => {
    const published = render(
      <RevaluationWorking
        functionalCurrency="INR"
        lines={[line({ rateDerived: false })]}
      />,
    );
    const publishedText = published.container.textContent ?? "";
    published.unmount();

    const derived = render(
      <RevaluationWorking
        functionalCurrency="INR"
        lines={[line({ rateDerived: true })]}
      />,
    );
    const derivedText = derived.container.textContent ?? "";
    derived.unmount();

    expect(derivedText).toMatch(/derived/i);
    expect(publishedText).not.toMatch(/derived/i);
  });

  /**
   * 🔴 THE FLAG SURVIVES THE WHOLE JOURNEY. `invertQuote` sets it, the
   * quote carries it, the action returns it, and a screen reads it. A
   * link missing anywhere in that chain leaves the customer evidencing a
   * computed reciprocal as though somebody had published it.
   */
  it("is returned by the preview action and read by the preview screen", () => {
    expect(code(ACTIONS)).toMatch(/derived:\s*quote\.derived/);
    expect(code(PREVIEW)).toMatch(/result\.derived/);
    expect(PREVIEW).toMatch(/derived by inversion/i);
  });

  /**
   * The rates list shows the reverse direction of every stored pair, and
   * that reverse is arithmetic nobody published — so the page computes it
   * with the ENGINE's `invertQuote` rather than dividing, and says so.
   */
  it("computes the reverse direction with the engine, never by dividing in the page", () => {
    expect(code(CONSOLE_PAGE)).toMatch(/invertQuote/);
    expect(CONSOLE_PAGE).toMatch(/derived by inversion/i);
  });
});

/* ================================================================== */
/* ② THE SKIPPED LINES ARE VISIBLE, WITH THEIR REASONS                 */
/* ================================================================== */

describe("🔴🔴 a non-monetary item is shown as not restated, with the reason", () => {
  /**
   * ⚠️ THE ASSERTION IS "NOTHING WAS DROPPED", not "two rows appeared".
   * It is derived from the input, so it holds for any set of lines and
   * cannot be satisfied by a component that renders a fixed number of
   * rows.
   */
  it("renders every line it is given, restated or not", () => {
    const lines = [
      line({ sourceReference: "INV-0001" }),
      line({
        itemKind: "fixed_asset",
        isMonetaryItem: false,
        sourceReference: "MACHINE-7",
        restated: false,
        rate: null,
        rateDate: null,
        rateSource: null,
        skipReason:
          "Non-monetary item carried at historical cost — AS 11 ¶11(b). Not restated.",
      }),
      line({
        itemKind: "advance_to_supplier",
        isMonetaryItem: false,
        sourceReference: "ADV-42",
        restated: false,
        rate: null,
        rateDate: null,
        rateSource: null,
        skipReason: "An advance against machinery is non-monetary.",
      }),
    ];

    const { container } = render(
      <RevaluationWorking functionalCurrency="INR" lines={lines} />,
    );
    const text = container.textContent ?? "";

    for (const l of lines) {
      expect(text).toContain(l.sourceReference);
      if (l.skipReason) expect(text).toContain(l.skipReason);
    }
  });

  /**
   * 🔴 A RUN WITH SKIPS MUST NEVER LOOK LIKE A RUN WITHOUT THEM. The
   * relation: adding one skipped line to an otherwise identical set has
   * to change what the reader sees.
   */
  it("a run with a skipped line reads differently from one without", () => {
    const withoutSkip = render(
      <RevaluationWorking functionalCurrency="INR" lines={[line()]} />,
    );
    const plain = withoutSkip.container.textContent ?? "";
    withoutSkip.unmount();

    const withSkip = render(
      <RevaluationWorking
        functionalCurrency="INR"
        lines={[
          line(),
          line({
            itemKind: "prepaid_expense",
            isMonetaryItem: false,
            sourceReference: "PRE-9",
            restated: false,
            rate: null,
            skipReason: "Prepayments are non-monetary.",
          }),
        ]}
      />,
    );
    const skipped = within(withSkip.container).getByTestId("fx-skipped-lines");
    expect(skipped.textContent ?? "").toMatch(/non-monetary/i);
    expect(withSkip.container.textContent ?? "").not.toBe(plain);
    withSkip.unmount();
  });

  /**
   * The classification is shown so a reader can check it. Getting
   * monetary and non-monetary backwards is the classic error in this
   * area and it balances either way round.
   */
  it("shows whether each item is monetary, which is the thing that decides", () => {
    const { container } = render(
      <RevaluationWorking
        functionalCurrency="INR"
        lines={[
          line({ isMonetaryItem: true }),
          line({
            isMonetaryItem: false,
            restated: false,
            sourceReference: "MACHINE-7",
            rate: null,
            skipReason: "AS 11 ¶11(b).",
          }),
        ]}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toMatch(/non-monetary/i);
    expect(text).toMatch(/monetary/i);
  });
});

/* ================================================================== */
/* ③ THE EXPONENT REACHES THE SCREEN                                   */
/* ================================================================== */

describe("🔴 a zero-decimal currency never gains phantom paise on screen", () => {
  /**
   * ⚠️ A PROPERTY OVER EVERY CURRENCY THE SYSTEM KNOWS, not over three
   * chosen ones. The rendered amount must carry exactly as many decimal
   * places as the currency has — zero for the yen, three for the Gulf
   * dinars, four for the Chilean UF.
   */
  it("renders each currency with its own number of decimal places", () => {
    for (const currency of KNOWN_CURRENCIES) {
      const exponent = minorUnitExponent(currency);
      const rendered = render(
        <RevaluationWorking
          functionalCurrency="INR"
          lines={[
            line({
              foreignCurrency: currency,
              foreignAmount: formatMinorPlain(1_234n, currency),
            }),
          ]}
        />,
      );
      const text = rendered.container.textContent ?? "";
      const shown = formatMinorPlain(1_234n, currency);
      expect(text).toContain(`${currency} ${shown}`);

      const decimals = shown.includes(".") ? (shown.split(".")[1] ?? "").length : 0;
      expect(decimals).toBe(exponent);
      rendered.unmount();
    }
  });

  it("shows 1234 yen as 1234 and not as 12.34", () => {
    const { container } = render(
      <RevaluationWorking
        functionalCurrency="JPY"
        lines={[
          line({
            foreignCurrency: "JPY",
            foreignAmount: formatMinorPlain(1_234n, "JPY"),
            carrying: formatMinorPlain(1_234n, "JPY"),
            restatedTo: formatMinorPlain(1_234n, "JPY"),
            plEffect: formatMinorPlain(0n, "JPY"),
          }),
        ]}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("JPY 1234");
    expect(text).not.toContain("12.34");
  });

  /**
   * 🔴 NOTHING IN THE BROWSER DIVIDES BY A HUNDRED. A hundred is wrong
   * for the yen and wrong by a factor of ten for the Kuwaiti dinar, and
   * the only correct divisor is the one `formatMinorPlain` looks up.
   */
  it("no FX screen scales money itself", () => {
    for (const [path, source] of Object.entries(UI_FILES)) {
      const stripped = code(source);
      expect(stripped, `${path} scales money by hand`).not.toMatch(/\/\s*100\b/);
      expect(stripped, `${path} scales money by hand`).not.toMatch(/100n/);
      expect(stripped, `${path} rounds money to two places`).not.toMatch(/toFixed\(/);
    }
  });
});

describe("🔴 a total with no currency label is a bug", () => {
  /**
   * `labelled` is the one funnel every figure goes through, so forgetting
   * the currency has to be a deliberate act rather than an omission.
   */
  it("labels an amount in every currency the system knows", () => {
    for (const currency of KNOWN_CURRENCIES) {
      const shown = labelled(formatMinorPlain(1n, currency), currency);
      expect(shown.startsWith(`${currency} `)).toBe(true);
      expect(shown).toContain(formatMinorPlain(1n, currency));
    }
  });

  /**
   * Every money cell in the working carries a code — the foreign column
   * in the document's currency and the three functional columns in the
   * books'. They are different currencies and neither is printed bare.
   */
  it("prints both currencies on a line whose document is not in the books' currency", () => {
    const { container } = render(
      <RevaluationWorking
        functionalCurrency="INR"
        lines={[line({ foreignCurrency: "USD" })]}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("USD ");
    expect(text).toContain("INR ");
  });

  /**
   * ⚠️ AND WHERE THE CURRENCY WAS ASSUMED RATHER THAN CHOSEN, IT SAYS SO.
   * `functionalCurrencyFromSettings` reports `isDefault`, and both the
   * console and the settings screen read it.
   */
  it("says so when the functional currency was assumed", () => {
    expect(code(CONSOLE_PAGE)).toMatch(/functionalCurrencyIsDefault/);
    expect(CONSOLE_PAGE).toMatch(/assumed/i);
    expect(code(SETTINGS)).toMatch(/functional\.isDefault/);
    expect(SETTINGS).toMatch(/assumed/i);
  });
});

/* ================================================================== */
/* ④ RUNNING AND POSTING ARE TWO DECISIONS                             */
/* ================================================================== */

describe("🔴🔴 running a revaluation and posting it are separate actions", () => {
  /**
   * The structural property: neither control can reach the other's
   * action. A single button that computed and booked in one click would
   * put the review after the journal.
   */
  it("the runner cannot post and the poster cannot run", () => {
    expect(code(RUNNER)).toMatch(/runFxRevaluation/);
    expect(code(RUNNER)).not.toMatch(/postFxRevaluationRun/);

    expect(code(POSTER)).toMatch(/postFxRevaluationRun/);
    expect(code(POSTER)).not.toMatch(/runFxRevaluation\(/);
  });

  /** Both are guarded, separately, on the server. */
  it("both actions are guarded and neither trusts the button", () => {
    const stripped = code(ACTIONS);
    for (const action of ["runFxRevaluation", "postFxRevaluationRun"]) {
      const body = stripped.slice(stripped.indexOf(`export async function ${action}`));
      expect(body.slice(0, 600)).toMatch(/requirePermission\(\s*"fx:revalue"/);
    }
  });

  /**
   * ⚠️ AND THE WORKING IS SHOWN BEFORE THE LEDGER IS OFFERED. The runner
   * fetches the lines and renders them; the post control sits after them.
   */
  it("the working is fetched and rendered before the post control", () => {
    const stripped = code(RUNNER);
    expect(stripped).toMatch(/getRevaluationLines/);
    expect(stripped.indexOf("RevaluationWorking")).toBeLessThan(
      stripped.lastIndexOf("PostRevaluation"),
    );
  });

  /** Posting twice cannot double-count: the action refuses a posted run. */
  it("refuses to post a run that is already in the ledger", () => {
    expect(code(ACTIONS)).toMatch(/transactionId !== null/);
    expect(ACTIONS).toMatch(/double-count/i);
  });
});

/* ================================================================== */
/* ⑤ A RATE IS NEVER A BARE NUMBER                                     */
/* ================================================================== */

describe("🔴 the rate form cannot record a rate without a date", () => {
  /**
   * Ind AS 21 ¶21 measures at the spot rate AT THE DATE OF THE
   * TRANSACTION. A field defaulted to today is how a rate meant for
   * 31 March is filed against the day somebody typed it, so the field
   * starts empty and the submit is gated on it.
   */
  it("starts with no date and will not submit until one is chosen", () => {
    const stripped = code(RATE_FORM);
    expect(stripped).toMatch(/useState\(""\)/);
    expect(stripped).toMatch(/missingDate\s*=\s*rateDate\.trim\(\)\s*===\s*""/);
    expect(stripped).toMatch(/canSubmit[\s\S]{0,200}!missingDate/);
    expect(stripped).toMatch(/disabled=\{!canSubmit\}/);
  });

  /** The direction is two fields, not one — 83.215 and 0.012017 differ. */
  it("asks for the direction as a pair rather than for 'the rate'", () => {
    const stripped = code(RATE_FORM);
    expect(stripped).toMatch(/baseCurrency/);
    expect(stripped).toMatch(/quoteCurrency/);
  });

  /**
   * ⚠️ ONE PARSER, NOT TWO. The form validates through the server's own
   * `validateRateText`, which calls `parseRateToScaled` — the same
   * function the write path uses.
   */
  it("validates the typed rate with the server's parser", () => {
    expect(code(RATE_FORM)).toMatch(/validateRateText/);
  });
});

describe("⭐ the rate shown is the rate stored", () => {
  /**
   * ⚠️ TRIMMING IS NOT ROUNDING. `trimRate` removes trailing zeros for
   * legibility; the property is that the value round-trips unchanged
   * through the engine's parser for every rate tried.
   */
  it("never changes the value it shortens", () => {
    const rates = [
      1n,
      RATE_SCALE,
      83_215_000_000_000n,
      12_017_060_000n,
      RATE_SCALE * 1_000_000n + 1n,
      999_999_999_999n,
    ];
    for (const scaled of rates) {
      const full = formatRateScaled(scaled);
      expect(parseRateToScaled(trimRate(full))).toBe(scaled);
    }
  });

  it("never shortens below the four places a reference rate is published to", () => {
    const shown = trimRate(formatRateScaled(RATE_SCALE));
    expect((shown.split(".")[1] ?? "").length).toBeGreaterThanOrEqual(4);
  });

  it("keeps every significant digit of a reciprocal", () => {
    const inverse = formatRateScaled(12_017_063_030n);
    expect(trimRate(inverse)).toBe(inverse.replace(/0+$/, ""));
    expect(parseRateToScaled(trimRate(inverse))).toBe(12_017_063_030n);
  });
});

/* ================================================================== */
/* ⑥ THE DOOR EXISTS                                                   */
/* ================================================================== */

describe("⭐ the console is reachable", () => {
  it("is in the module registry, in the money group, pointing at its route", () => {
    const entry = Object.values(MODULE_REGISTRY).find((m) => m.href === "/fx");
    expect(entry).toBeDefined();
    expect(entry?.group).toBe("money");
    expect(entry?.status).toBe("live");
  });

  /**
   * ⚠️ THE PROPERTY IS "WHEREVER THE LEDGER IS", NOT "EVERYWHERE". Not
   * every vertical carries the finance section; the ones that do keep
   * books, and a business that keeps books in one currency and invoices
   * in another is the whole subject of this screen. Asserting the
   * relation rather than a list means adding the finance section to a new
   * vertical cannot quietly leave FX behind.
   */
  it("sits with the ledger in every vertical that keeps books", () => {
    const entry = Object.values(MODULE_REGISTRY).find((m) => m.href === "/fx");
    expect(entry).toBeDefined();

    let carried = 0;
    for (const key of INDUSTRY_KEYS) {
      const finance = INDUSTRY_TEMPLATES[key].navigation.find((s) => s.id === "finance");
      if (!finance) continue;
      carried += 1;
      expect(
        finance.items.map((i) => i.id),
        `${key} has a finance section but cannot reach /fx`,
      ).toContain(entry?.navId);
    }
    expect(carried).toBeGreaterThan(0);
  });

  /**
   * 🔴 THE ORIGINAL DEFECT, ASSERTED DIRECTLY: every guarded FX action
   * that this batch built is now invoked by something under `app/` or
   * `components/`. An action nothing calls is a feature nobody has.
   */
  it("every FX action is called from a screen", () => {
    const surfaces = [
      CONSOLE_PAGE,
      DETAIL_PAGE,
      RUNNER,
      POSTER,
      RATE_FORM,
      PREVIEW,
      SETTINGS,
    ]
      .map(code)
      .join("\n");

    const exported = [
      ...code(ACTIONS).matchAll(/export async function (\w+)/g),
    ].map((m) => m[1] as string);

    expect(exported.length).toBeGreaterThan(0);
    for (const name of exported) {
      expect(surfaces, `${name} is still reachable only by RPC`).toContain(name);
    }
  });
});
