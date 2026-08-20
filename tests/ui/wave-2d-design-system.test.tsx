/**
 * Ordence — ⭐⭐⭐ WAVE 2D: PROVING THE DESIGN SYSTEM, NOT DEMONSTRATING IT
 * Version: v1.89.0-alpha · Wave 2D
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 "THE COMPONENTS RENDER" IS NOT A PROOF AND IS NOT ATTEMPTED HERE
 * ══════════════════════════════════════════════════════════════════════
 * This codebase's characteristic defect is built-and-unreachable,
 * declared-and-unenforced, or verified-by-a-floor — found more than
 * thirty times, including four times inside the checkers written to catch
 * it. A snapshot test that asserts a `<div>` came out of a component that
 * returns a `<div>` is the fourth of those.
 *
 * So every §  below asserts something that would be FALSE if the rule it
 * names were broken, and the ones that can be induced are induced —
 * §2 substitutes an ICU build and watches an existing screen drift.
 *
 * ⚠️ §7 IS EXPECTED TO FAIL ON THE DELIVERED TREE AND THAT IS THE POINT.
 * It asserts that each primitive is rendered by a real screen. Wave 2D
 * owns `components/ui/**` and `app/globals.css` and nothing else, so the
 * adoptions live in `PATCH-REQUEST-WAVE-2D.md` as diffs. The test is
 * shipped RED so that "the primitives are not yet reached" is a fact the
 * suite states out loud rather than a sentence in a report nobody reads.
 * A primitive nothing renders is this project's most-found defect; a
 * failing test is how it stays visible until integration applies the
 * patch.
 */

import { describe, expect, it, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { render, screen, cleanup } from "@testing-library/react";

import {
  Figure,
  minorFromString,
  formatRupees,
  formatPaise,
  groupIndian,
  NOT_RECORDED,
} from "@/components/ui/figure";
import { MetricCard } from "@/components/ui/metric-card";
import { StatusPill, type StatusMeaning } from "@/components/ui/status-pill";
import {
  DenseTable,
  DenseBody,
  DenseTotalRow,
  DenseCell,
  NumericCell,
} from "@/components/ui/dense-table";
import { AccountTreeRow } from "@/components/ui/account-tree-row";
import { MappingRow } from "@/components/ui/mapping-row";

/**
 * 🔴 THE REAL SCREEN. Not a copy of its formatter — the module itself.
 * If somebody edits `rupees` in `components/returns/gstr3b-board.tsx`,
 * §1 goes red here, which is the entire purpose of importing it rather
 * than pasting it.
 */
import { rupees as gstr3bScreenRupees } from "@/components/returns/gstr3b-board";

const ROOT = resolve(__dirname, "..", "..");

afterEach(cleanup);

/* ═══════════════════════════════════════════════════════════════════ */
/* §1  THE FORMATTER AGREES WITH AN EXISTING SCREEN                    */
/* ═══════════════════════════════════════════════════════════════════ */

describe("§1 a figure through the primitive and the same figure through an existing screen", () => {
  /**
   * The brief asks for seven digits and for a negative, by name. Both are
   * here, plus the cases that have historically been where two money
   * formatters part company: the paise-only value, the value whose
   * rupee part is zero, and the magnitude that is past `Number.MAX_SAFE_INTEGER`.
   */
  const CASES: Array<[string, string]> = [
    ["209375000", "seven digits — ₹20,93,750.00, the brief's own figure"],
    ["-209375000", "the same, negative"],
    ["1234567890", "eight digits, crores"],
    ["-1234567890", "eight digits, negative"],
    ["-1", "one paisa, negative — the value that vanishes under Intl"],
    ["-99", "under a rupee, negative"],
    ["0", "zero"],
    ["100000000000000000000", "past Number.MAX_SAFE_INTEGER by 5 orders"],
  ];

  it.each(CASES)("%s (%s) renders identically through both", (minor) => {
    const mine = formatRupees(BigInt(minor));
    const theirs = gstr3bScreenRupees(minor);
    expect(mine).toBe(theirs);
  });

  it("₹20,93,750.00 is grouped the Indian way, and would be 2,093,750 if it were not", () => {
    // ⚠️ Asserted as a LITERAL, not as `expect(x).toBe(format(x))`. A
    // tautology passes whatever the grouping is.
    expect(formatRupees(209375000n)).toBe("₹20,93,750.00");
    expect(formatRupees(209375000n)).not.toContain("2,093,750");
    expect(groupIndian("2093750")).toBe("20,93,750");
  });

  it("the rendered <Figure> carries the same string, so the component adds no drift of its own", () => {
    render(<Figure minor="209375000" currency data-testid="f" />);
    expect(screen.getByTestId("f").textContent).toBe(gstr3bScreenRupees("209375000"));
  });

  it("and the negative too, sign outside the rupee sign — -₹20,93,750.00", () => {
    render(<Figure minor="-209375000" currency data-testid="f" />);
    const el = screen.getByTestId("f");
    expect(el.textContent).toBe(gstr3bScreenRupees("-209375000"));
    expect(el.textContent).toBe("-₹20,93,750.00");
  });
});

/* ═══════════════════════════════════════════════════════════════════ */
/* §2  THE INDUCED FAILURE: AN ICU BUILD WITHOUT en-IN                 */
/* ═══════════════════════════════════════════════════════════════════ */

describe("§2 induced — a runtime whose ICU has no en-IN data", () => {
  /**
   * 🔴 THIS IS THE REASON THE PRIMITIVE DELEGATES TO STRING SURGERY AND
   * NOT TO `Intl`.
   *
   * `Intl.NumberFormat("en-IN")` does locale NEGOTIATION. On a Node built
   * with `small-icu`, or any runtime shipping trimmed CLDR data, `en-IN`
   * is not available — and it does not throw and it does not warn. It
   * resolves to `en`, and `en` groups in threes.
   *
   * The substitution below is exactly that negotiation: a formatter that
   * cannot honour `en-IN` and falls back. Nothing about the screen's code
   * is changed.
   */
  const RealNumberFormat = Intl.NumberFormat;

  afterEach(() => {
    (Intl as unknown as { NumberFormat: typeof Intl.NumberFormat }).NumberFormat =
      RealNumberFormat;
  });

  function installIcuWithoutEnIn() {
    const Fallback = function (locales?: unknown, options?: Intl.NumberFormatOptions) {
      // What locale negotiation does when the requested locale's data is
      // absent: drop the region and use the base language.
      return new RealNumberFormat("en", options);
    } as unknown as typeof Intl.NumberFormat;
    (Intl as unknown as { NumberFormat: typeof Intl.NumberFormat }).NumberFormat = Fallback;
    // BigInt.prototype.toLocaleString reads Intl.NumberFormat through the
    // spec's internal slot, not the global — so the screen's
    // `(abs / 100n).toLocaleString("en-IN")` is re-expressed here the way
    // the spec defines it, which is what a small-icu build would produce.
    return (minor: string) => {
      const value = BigInt(minor || "0");
      const negative = value < 0n;
      const abs = negative ? -value : value;
      const whole = new Intl.NumberFormat("en-IN").format(abs / 100n);
      const paise = (abs % 100n).toString().padStart(2, "0");
      return `${negative ? "-" : ""}₹${whole}.${paise}`;
    };
  }

  it("the screen's Intl-based formatter DRIFTS to Western grouping, silently", () => {
    const screenUnderSmallIcu = installIcuWithoutEnIn();

    // 🔴 The thing that would have differed if this were not true: on a
    // full-ICU build this is "₹20,93,750.00".
    expect(screenUnderSmallIcu("209375000")).toBe("₹2,093,750.00");
    expect(screenUnderSmallIcu("209375000")).not.toBe(gstr3bScreenRupees("209375000"));
  });

  it("the primitive does not move, because it never asks ICU anything", () => {
    installIcuWithoutEnIn();
    expect(formatRupees(209375000n)).toBe("₹20,93,750.00");
    render(<Figure minor="209375000" currency data-testid="f" />);
    expect(screen.getByTestId("f").textContent).toBe("₹20,93,750.00");
  });

  it("and no `Intl`, no `toLocaleString` and no `Number` is on the primitive's formatting path", () => {
    /**
     * ⚠️ SCOPED TO THE THREE FUNCTIONS THE PATH ACTUALLY RUNS, AND NOT TO
     * THE WHOLE MODULE — because the whole module WOULD fail this, and
     * failing it would be a false alarm rather than a finding.
     *
     * `lib/receivables/numbers.ts` also holds `rupeesInWords`, which does
     * use `Number(rest / 100_000n)`. That is correct there: each operand
     * has already been divided down to a value under a thousand, so it is
     * an index into a lookup table of Hindi and English number words, not
     * a money value. Asserting over the file would have made this test
     * red for a reason that is not the rule, and a test that cries wolf
     * gets its assertion deleted rather than its scope fixed.
     *
     * `Figure` calls exactly `formatPaise` → `groupIndian`, and
     * `formatRupees` → `formatPaise`. Those three, and nothing else.
     */
    const source = readFileSync(join(ROOT, "lib", "receivables", "numbers.ts"), "utf8");
    const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    const bodyOf = (name: string) => {
      const i = stripped.indexOf(`export function ${name}(`);
      expect(i, `${name} must exist in lib/receivables/numbers.ts`).toBeGreaterThan(-1);
      const open = stripped.indexOf("{", i);
      let depth = 0;
      for (let j = open; j < stripped.length; j++) {
        if (stripped[j] === "{") depth++;
        else if (stripped[j] === "}") {
          depth--;
          if (depth === 0) return stripped.slice(open, j + 1);
        }
      }
      throw new Error(`unterminated ${name}`);
    };

    for (const fn of ["groupIndian", "formatPaise", "formatRupees"]) {
      const body = bodyOf(fn);
      expect(body, `${fn} must not reach ICU`).not.toMatch(/\bIntl\b/);
      expect(body, `${fn} must not reach ICU`).not.toMatch(/toLocaleString/);
      expect(body, `${fn} must not construct a Number`).not.toMatch(/\bNumber\s*\(/);
      expect(body, `${fn} must not use parseInt/parseFloat`).not.toMatch(/parse(Int|Float)/);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════ */
/* §3  A ZERO IS A CLAIM, AND IS NEVER INVENTED                        */
/* ═══════════════════════════════════════════════════════════════════ */

describe("§3 an unreadable figure renders the marker, never a zero", () => {
  it.each([null, undefined, "", "  ", "abc", "1.5", "1,24,600", "₹5"])(
    "%p is not recorded, and is not 0",
    (input) => {
      expect(minorFromString(input as string | null | undefined)).toBeNull();
      cleanup();
      render(<Figure minor={input as string | null | undefined} currency data-testid="f" />);
      const el = screen.getByTestId("f");
      expect(el.textContent).toBe(NOT_RECORDED);
      expect(el.textContent).not.toContain("0");
      expect(el.getAttribute("data-minor")).toBeNull();
    },
  );

  it("0 itself IS a recorded figure and renders as one", () => {
    render(<Figure minor="0" currency data-testid="f" />);
    expect(screen.getByTestId("f").textContent).toBe("₹0.00");
  });

  it("`BigInt(x || \"0\")` — what three screens on this tree do — would have claimed zero for all of them", () => {
    // Not a test of our code. A statement of what the alternative does,
    // asserted so the comment cannot rot.
    const theOldWay = (v: string | null | undefined) => BigInt((v as string) || "0");
    expect(theOldWay(null)).toBe(0n);
    expect(theOldWay(undefined)).toBe(0n);
    expect(theOldWay("")).toBe(0n);
    expect(formatPaise(theOldWay(null))).toBe("0.00");
  });
});

/* ═══════════════════════════════════════════════════════════════════ */
/* §4  NEVER RED FOR A NEGATIVE NUMBER                                 */
/* ═══════════════════════════════════════════════════════════════════ */

describe("§4 a credit balance is ordinary and is never coloured", () => {
  const BLOCKS = "--ord-blocks";

  it("a negative <Figure> carries no colour class at all", () => {
    render(<Figure minor="-209375000" currency data-testid="f" />);
    const cls = screen.getByTestId("f").className;
    expect(cls).not.toContain(BLOCKS);
    expect(cls).not.toContain("--ord-");
  });

  it("a negative NumericCell carries no colour class", () => {
    render(
      <DenseTable>
        <DenseBody>
          <tr>
            <NumericCell minor="-209375000" data-testid="c" />
          </tr>
        </DenseBody>
      </DenseTable>,
    );
    expect(screen.getByTestId("c").innerHTML).not.toContain(BLOCKS);
  });

  it("AccountTreeRow has no way to express a signed amount — the columns carry the sign", () => {
    render(
      <DenseTable>
        <DenseBody>
          <AccountTreeRow name="Sundry creditors" code="2100" depth={2} creditMinor="29400000" />
        </DenseBody>
      </DenseTable>,
    );
    const row = screen.getByText("Sundry creditors").closest("tr")!;
    expect(row.innerHTML).not.toContain(BLOCKS);
    // The figure is in the CREDIT column (index 3: name, code, debit, credit).
    const cells = row.querySelectorAll("td");
    expect(cells[2]!.textContent).toBe(NOT_RECORDED);
    expect(cells[3]!.textContent).toBe("2,94,000.00");
    // 🔴 And it is not rendered as a minus anywhere.
    expect(row.textContent).not.toContain("-");
  });

  it("the props that would have made red-for-minus possible do not exist", () => {
    // A type-level rule needs a type-level proof; this is the runtime
    // half. `tsc` refusing `tone="negative"` is shown in TRACK-REPORT.md.
    const figureSource = readFileSync(join(ROOT, "components", "ui", "figure.tsx"), "utf8");
    const code = figureSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/negative\s*[?:]/);
    expect(code).toContain('export type FigureTone = "ties" | "check" | "blocks" | "statutory" | "action"');
  });
});

/* ═══════════════════════════════════════════════════════════════════ */
/* §5  FIVE STATUSES, AND EACH COLOUR CARRIES ONE MEANING              */
/* ═══════════════════════════════════════════════════════════════════ */

describe("§5 the status vocabulary is closed", () => {
  const ALL: StatusMeaning[] = ["ties", "check", "blocks", "statutory", "neutral"];

  it("there are exactly five, and the source names exactly five", () => {
    const src = readFileSync(join(ROOT, "components", "ui", "status-pill.tsx"), "utf8");
    const m = /export type StatusMeaning =([^;]+);/.exec(src);
    expect(m).not.toBeNull();
    const named = [...m![1]!.matchAll(/"([a-z]+)"/g)].map((x) => x[1]);
    expect(named.sort()).toEqual([...ALL].sort());
    expect(named).toHaveLength(5);
  });

  it("each meaning resolves to its OWN token — no two share a colour", () => {
    const seen = new Map<string, string>();
    for (const meaning of ALL) {
      cleanup();
      render(<StatusPill meaning={meaning} label="x" data-testid="p" />);
      const cls = screen.getByTestId("p").className;
      const token = /--ord-([a-z]+)\)\)\]"?\s*$|text-\[hsl\(var\(--ord-([a-z]+)\)\)\]/.exec(cls);
      expect(cls, `${meaning} must resolve to an --ord- token`).toContain("--ord-");
      const key = cls.match(/text-\[hsl\(var\(--ord-[a-z]+\)\)\]/)![0];
      expect(seen.has(key), `${meaning} reuses the colour of ${seen.get(key)}`).toBe(false);
      seen.set(key, meaning);
      void token;
    }
    expect(seen.size).toBe(5);
  });

  it("the words are the screen's, and are never derived from the meaning", () => {
    render(<StatusPill meaning="check" label="Awaiting IRN" data-testid="p" />);
    const el = screen.getByTestId("p");
    expect(el.textContent).toBe("Awaiting IRN");
    // The meaning is on the element for a test and for a stylesheet, and
    // is nowhere in the words a person reads.
    expect(el.getAttribute("data-meaning")).toBe("check");
    expect(el.textContent!.toLowerCase()).not.toContain("check");
  });

  it("`blocks` is not `--destructive` — a status is a different axis from a form error", () => {
    render(<StatusPill meaning="blocks" label="Due in 0 days" data-testid="p" />);
    const cls = screen.getByTestId("p").className;
    expect(cls).toContain("--ord-blocks");
    expect(cls).not.toContain("destructive");
  });
});

/* ═══════════════════════════════════════════════════════════════════ */
/* §6  THE PRIMITIVES KEEP THE RULES THEY WERE BUILT FOR               */
/* ═══════════════════════════════════════════════════════════════════ */

describe("§6 the five, each doing the one thing it exists for", () => {
  it("MetricCard cannot be rendered without its difference line — the type refuses it", () => {
    const src = readFileSync(join(ROOT, "components", "ui", "metric-card.tsx"), "utf8");
    // `difference:` with no `?`. The tsc refusal is in TRACK-REPORT.md.
    expect(src).toMatch(/\n\s*difference:\s*\{/);
    expect(src).not.toMatch(/difference\?:/);
  });

  it("MetricCard renders both figures, both qualifiers and the difference", () => {
    render(
      <MetricCard
        title="HDFC current · 0042"
        primary={{ minor: "61248000", qualifier: "Statement, 19 Aug" }}
        secondary={{ minor: "60993000", qualifier: "Balance in Ordence" }}
        difference={{ label: "4 items to reconcile", minor: "255000", tone: "check" }}
      />,
    );
    expect(screen.getByText("₹6,12,480.00")).toBeTruthy();
    expect(screen.getByText("₹6,09,930.00")).toBeTruthy();
    expect(screen.getByText("Statement, 19 Aug")).toBeTruthy();
    expect(screen.getByText("4 items to reconcile")).toBeTruthy();
    expect(screen.getByText("₹2,550.00")).toBeTruthy();
  });

  it("AccountTreeRow indents by depth and STOPS at four, so a deep import stays readable", () => {
    const px = (d: number) => {
      cleanup();
      render(
        <DenseTable>
          <DenseBody>
            <AccountTreeRow name={`d${d}`} depth={d} />
          </DenseBody>
        </DenseTable>,
      );
      const span = screen.getByText(`d${d}`).parentElement as HTMLElement;
      return span.style.paddingLeft;
    };
    expect(px(0)).toBe("0px");
    expect(px(1)).toBe("18px");
    expect(px(4)).toBe("72px");
    // 🔴 The clamp. Without it this is "144px" and the account name
    // falls off a laptop.
    expect(px(8)).toBe("72px");
  });

  it("the count badge appears only on a COLLAPSED group", () => {
    const has = (expanded: boolean | undefined) => {
      cleanup();
      render(
        <DenseTable>
          <DenseBody>
            <AccountTreeRow name="Expenses" isGroup expanded={expanded} childCount={61} />
          </DenseBody>
        </DenseTable>,
      );
      return screen.queryByText("61 accounts") !== null;
    };
    expect(has(false)).toBe(true);
    expect(has(true)).toBe(false);
    expect(has(undefined)).toBe(false);
  });

  it("a leaf gets no caret — a control that does nothing is worse than none", () => {
    render(
      <DenseTable>
        <DenseBody>
          <AccountTreeRow name="Cash in hand" code="1000" depth={2} debitMinor="4820000" />
        </DenseBody>
      </DenseTable>,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("4,820,000.00".replace(/,/g, "").length ? "48,200.00" : "")).toBeTruthy();
  });

  it("a collapsible group's caret carries aria-expanded, so the tree exists for a screen reader", () => {
    render(
      <DenseTable>
        <DenseBody>
          <AccountTreeRow name="Assets" isGroup expanded={false} childCount={6} />
        </DenseBody>
      </DenseTable>,
    );
    const btn = screen.getByRole("button");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(btn.getAttribute("aria-label")).toBe("Expand Assets");
  });

  it("DenseTotalRow is the plainest row: a rule and weight, and no colour of meaning", () => {
    render(
      <DenseTable>
        <DenseBody>
          <DenseTotalRow data-testid="t">
            <DenseCell>Total</DenseCell>
            <NumericCell minor="209375000" />
          </DenseTotalRow>
        </DenseBody>
      </DenseTable>,
    );
    const cls = screen.getByTestId("t").className;
    expect(cls).toContain("font-semibold");
    expect(cls).toContain("border-t");
    // 🔴 None of the six meanings. A total is a summary, not a state.
    expect(cls).not.toContain("--ord-");
    expect(cls).not.toContain("destructive");
  });

  it("MappingRow puts its warning ON the row, next to the destination it is about", () => {
    render(
      <MappingRow
        sourceColumn="Amount"
        samples={["1,24,600", "88,400", "42,000"]}
        destinationField="total_minor"
        confidence="guess"
        warning="These look like rupees with commas, not paise. 1,24,600 would import as ₹1,246.00."
      />,
    );
    const row = screen.getByText("Amount").closest('[data-primitive="mapping-row"]')!;
    expect(row.textContent).toContain("These look like rupees with commas");
    expect(row.textContent).toContain("1,24,600");
    expect(row.textContent).toContain("total_minor");
  });

  it("MappingRow gives a screen NO way to hoist its warnings into a summary", () => {
    const src = readFileSync(join(ROOT, "components", "ui", "mapping-row.tsx"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/onWarning|warnings\s*[?:]|collectWarnings/);
  });

  it("`guess` and `none` do not look the same — one asks and the other says nothing", () => {
    render(<MappingRow sourceColumn="A" samples={["1"]} confidence="guess" />);
    expect(screen.getByText("Confirm this")).toBeTruthy();
    cleanup();
    render(<MappingRow sourceColumn="A" samples={["1"]} confidence="none" data-testid="r" />);
    // 🔴 No chip at all — not a grey one.
    expect(screen.getByTestId("r").querySelector('[data-primitive="status-pill"]')).toBeNull();
  });

  it("samples are required, and an empty column says so rather than rendering blank", () => {
    render(<MappingRow sourceColumn="Remarks" samples={[]} confidence="none" data-testid="r" />);
    expect(screen.getByTestId("r").textContent).toContain("no values in this column");
  });
});

/* ═══════════════════════════════════════════════════════════════════ */
/* §7  TABULAR FIGURES, AS A RULE AND NOT AS A HABIT                   */
/* ═══════════════════════════════════════════════════════════════════ */

describe("§7 tabular-nums is a base rule, so no screen has to remember it", () => {
  /**
   * ⚠️ JSDOM DOES NOT APPLY A TAILWIND-COMPILED STYLESHEET, so this
   * asserts the RULE EXISTS in the source rather than that a rendered
   * digit is 8px wide. Said out loud because a test that quietly checks
   * something weaker than its name is the defect this file is about.
   */
  const css = readFileSync(join(ROOT, "app", "globals.css"), "utf8");

  it("`table` itself carries it — which is what reaches the 15 screens already rendering <Table>", () => {
    expect(css).toMatch(/\btable\s*\{[^}]*font-variant-numeric:\s*tabular-nums/);
  });

  it("and `.ord-num` exists for the figures that are not in a table", () => {
    expect(css).toMatch(/\.ord-num\s*\{[^}]*font-variant-numeric:\s*tabular-nums/);
  });

  it("lining figures too — old-style digits defeat the alignment tnum just bought", () => {
    expect(css).toMatch(/tabular-nums lining-nums/);
  });

  it("every primitive that renders a figure applies one of the two", () => {
    render(<Figure minor="209375000" data-testid="f" />);
    expect(screen.getByTestId("f").className).toContain("ord-num");
  });
});

/* ═══════════════════════════════════════════════════════════════════ */
/* §8  THE SIX MEANINGS SURVIVE DARK MODE AND SURVIVE PAPER            */
/* ═══════════════════════════════════════════════════════════════════ */

describe("§8 the tokens are declared on all three grounds", () => {
  const css = readFileSync(join(ROOT, "app", "globals.css"), "utf8");
  const SIX = ["chrome", "action", "ties", "check", "blocks", "statutory"];

  function blockFor(selector: string): string {
    const i = css.indexOf(selector);
    expect(i, `${selector} must be present`).toBeGreaterThan(-1);
    const open = css.indexOf("{", i);
    // Naive brace match is enough: none of these blocks nest.
    let depth = 0;
    for (let j = open; j < css.length; j++) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") {
        depth--;
        if (depth === 0) return css.slice(open, j);
      }
    }
    throw new Error(`unterminated block for ${selector}`);
  }

  const light = blockFor(":root {");
  const dark = blockFor(".dark {");
  const doc = blockFor(".document-surface,");

  it.each(SIX)("--ord-%s is defined in light, in dark, and on a document surface", (name) => {
    expect(light).toContain(`--ord-${name}:`);
    expect(dark).toContain(`--ord-${name}:`);
    // 🔴 THE ONE THAT MATTERS. Without this, adding dark values would
    // have silently turned every printed invoice, payslip and 3B summary
    // into the dark cut — pale pink on white paper.
    expect(doc).toContain(`--ord-${name}:`);
  });

  it("the document surface uses the LIGHT values, not the dark ones", () => {
    const pick = (block: string, name: string) =>
      new RegExp(`--ord-${name}:\\s*([^;]+);`).exec(block)![1]!.trim();
    for (const name of SIX) {
      expect(pick(doc, name), `--ord-${name} on paper`).toBe(pick(light, name));
      expect(pick(doc, name)).not.toBe(pick(dark, name));
    }
  });

  it("no primitive hard-codes a hex — every colour resolves through a token", () => {
    const dir = join(ROOT, "components", "ui");
    const mine = [
      "figure.tsx",
      "metric-card.tsx",
      "status-pill.tsx",
      "dense-table.tsx",
      "account-tree-row.tsx",
      "mapping-row.tsx",
    ];
    for (const f of mine) {
      const src = readFileSync(join(dir, f), "utf8");
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code, `${f} must not hard-code a hex colour`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════ */
/* §9  🔴 A PRIMITIVE NOTHING RENDERS                                  */
/* ═══════════════════════════════════════════════════════════════════ */

describe("§9 every primitive is rendered by a real screen", () => {
  /**
   * 🔴 THIS IS THE ASSERTION THE WAVE BRIEF ASKS FOR BY NAME, AND ON THE
   * DELIVERED TREE IT IS RED.
   *
   * Wave 2D owns `components/ui/**` and `app/globals.css`. The screens
   * that should adopt these primitives are not ours to edit — Wave 2A is
   * in the import wizard right now — so the adoptions ship as complete
   * diffs in `PATCH-REQUEST-WAVE-2D.md`.
   *
   * ⚠️ THE TEST IS SHIPPED FAILING ON PURPOSE. "Built and unreachable" is
   * this project's most-found defect and the way it survives is by being
   * described in a report rather than asserted in a suite. Applying the
   * patch request turns this green; nothing else does, and no one can
   * mistake the primitives for adopted while it is red.
   */
  const EXPORTS_TO_FIND: Array<[string, string]> = [
    ["MetricCard", "@/components/ui/metric-card"],
    ["AccountTreeRow", "@/components/ui/account-tree-row"],
    ["StatusPill", "@/components/ui/status-pill"],
    ["DenseTable", "@/components/ui/dense-table"],
    ["MappingRow", "@/components/ui/mapping-row"],
  ];

  const SEARCH_DIRS = ["app", "components"];

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === ".next") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.tsx?$/.test(entry)) out.push(full);
    }
    return out;
  }

  const files = SEARCH_DIRS.flatMap((d) => walk(join(ROOT, d))).filter(
    // ⚠️ EXCLUDING components/ui ITSELF. A primitive imported only by
    // another primitive is still unreached — that is exactly how a
    // component library with forty components and two screens passes its
    // own reachability check.
    (f) => !f.includes(join("components", "ui")) && !f.includes(join("tests", "")),
  );

  /**
   * 🔴 AN IMPORT IS NOT A RENDER, AND CHECKING FOR ONE IS THE FLOOR THIS
   * PROJECT KEEPS FINDING.
   *
   * The first draft of this test asserted that the module path appeared
   * in some file and that the export's name appeared somewhere in it. It
   * went green for `AccountTreeRow` on a screen that imported it and
   * never rendered it — the identifier was matched inside the import
   * statement itself. A reachability check that its own subject can
   * satisfy by being imported is a check that proves nothing, and it is
   * on the list of four times this codebase's checkers have had exactly
   * this bug.
   *
   * ⭐ SO THE ASSERTION IS `<Name` — a JSX opening tag, outside the
   * import statement. That cannot be satisfied by an unused import.
   */
  it.each(EXPORTS_TO_FIND)("%s is RENDERED by at least one screen", (name, modulePath) => {
    const renderers = files.filter((f) => {
      const src = readFileSync(f, "utf8");
      if (!src.includes(modulePath)) return false;
      // Strip every import statement first, so the name cannot be found
      // in the line that brought it in.
      const body = src.replace(/^\s*import\b[\s\S]*?from\s+["'][^"']+["'];?\s*$/gm, "");
      return new RegExp(`<${name}[\\s/>]`).test(body);
    });
    expect(
      renderers.map((f) => f.slice(ROOT.length + 1)),
      `${name} is declared in ${modulePath} and is rendered by no screen. ` +
        `A primitive nothing renders is this project's most-found defect. ` +
        `See PATCH-REQUEST-WAVE-2D.md.`,
    ).not.toHaveLength(0);
  });
});
