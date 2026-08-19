/**
 * Ordence — 🔴🔴🔴 THE THIRTEENTH INSTANCE, AND THE GATE THAT ENDS IT
 * Version: v1.69.0-alpha (wave one)
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE DEFECT THESE TESTS WOULD HAVE CAUGHT
 * ══════════════════════════════════════════════════════════════════════
 * `recordDeduction` in `server/actions/tds.ts` holds the ONLY INSERT into
 * `tds_deductions` in this product, and until this batch nothing called
 * it. No screen, no route, no job. `/tds` imported `getDeductees`,
 * `getRegister` and `getInterestExposure` — three reads over a table that
 * could never receive a row.
 *
 * So the interest exposure could only report zero, Form 26Q could only be
 * empty, Form 16A could only be empty, and the Rule 26 foreign-payment
 * engine added in 0106 sat behind all of it with its `foreignPayment`
 * argument reachable from nowhere. Every gate was green, every test
 * passed, and the screen rendered an empty TDS register — which reads as
 * "nothing owed".
 *
 * ⭐ THESE TESTS ASSERT THE ROUTE, not the arithmetic. The arithmetic has
 * been tested since 0025 and was never the problem.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, extname } from "node:path";

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(join(ROOT, dir))) return out;
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (["node_modules", ".next", ".git"].includes(e.name)) continue;
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel, out);
    else if ([".ts", ".tsx"].includes(extname(e.name))) out.push(rel);
  }
  return out;
}

const uiFiles = [...walk("app"), ...walk("components")];
const uiText = uiFiles.map((f) => readFileSync(join(ROOT, f), "utf8")).join("\n");

/* ================================================================== */
describe("🔴🔴🔴 the TDS deduction path is reachable by a human being", () => {
  it("⭐ a screen calls `recordDeduction`, the only INSERT into tds_deductions", () => {
    expect(uiText).toContain("recordDeduction");
  });

  it("⭐ a screen calls `assessDeduction`, so the figure is seen before the money moves", () => {
    expect(uiText).toContain("assessDeduction");
  });

  it("🔴 the page exists at a route, not merely as a component", () => {
    expect(existsSync(join(ROOT, "app/(crm)/tds/deduct/page.tsx"))).toBe(true);
  });

  /**
   * ⚠️ THE HALF THAT `0100` AND `/banking` BOTH MISSED. A page that
   * exists and appears in no navigation is reachable only from the URL
   * bar. `0100`'s depreciation engine was in that state for four
   * batches; `/banking` was, from v1.18.0 until 0110.
   */
  it("🔴 and navigation reaches it — a page in no nav is a page nobody opens", () => {
    const templates = readFileSync(join(ROOT, "lib/industry-templates.ts"), "utf8");
    const registry = readFileSync(join(ROOT, "lib/modules/registry.ts"), "utf8");
    expect(templates).toContain('href: "/tds/deduct"');
    expect(registry).toContain('href: "/tds/deduct"');
  });

  it("⚠️ the TDS register links to it, because that is where somebody already is", () => {
    const page = readFileSync(join(ROOT, "app/(crm)/tds/page.tsx"), "utf8");
    expect(page).toContain("/tds/deduct");
  });
});

/* ================================================================== */
describe("⭐⭐ Rule 26 — the `foreignPayment` argument's first caller", () => {
  /**
   * 🔴 `foreignPayment` HAS BEEN ACCEPTED BY THE ACTION AND VALIDATED BY
   * `lib/validators/tds.ts` SINCE 0106 AND NOTHING PASSED ONE. A
   * statutory capability shipped in the same release that catalogued
   * eleven prior instances of exactly this.
   */
  it("🔴 a screen builds a foreignPayment payload", () => {
    expect(uiText).toContain("foreignPayment");
  });

  it("⚠️ and the screen says minor units rather than paise or cents", () => {
    const form = readFileSync(
      join(ROOT, "components/tds/record-deduction.tsx"),
      "utf8",
    );
    /**
     * ⚠️ NOT EVERY CURRENCY HAS TWO DECIMALS. JPY has none; KWD, BHD,
     * OMR, JOD, TND, LYD and IQD have three. A form saying "cents" is
     * wrong for seven currencies and wrong by a factor of ten for six.
     */
    expect(form).toContain("minor units");
    expect(form).toMatch(/yen has none|dinar has three/);
  });

  it("🔴 the rupee base is CLEARED when the foreign toggle goes on, not merely hidden", () => {
    const form = readFileSync(
      join(ROOT, "components/tds/record-deduction.tsx"),
      "utf8",
    );
    /**
     * `exactlyOneBase` in `lib/validators/tds.ts` REFUSES a request
     * carrying both. A hidden input still holding a stale rupee figure
     * would be refused server-side with a message about supplying two
     * bases, which reads as a bug in the form rather than as the rule.
     */
    expect(form).toContain('paymentBaseMinor: ""');
  });
});

/* ================================================================== */
describe("🔴 the census that would have caught all thirteen", () => {
  const baselinePath = "scripts/action-reachability-baseline.json";

  /**
   * 🔴🔴 THE GATE'S OWN FALSE POSITIVE, CAUGHT ON ITS SECOND RUN AND
   * ASSERTED HERE SO IT CANNOT COME BACK.
   *
   * The first version collected identifiers from raw file text. A doc
   * comment in `components/accounting/create-period-form.tsx` explaining
   * that `createFinancialPeriod` had no caller made the gate report it as
   * REACHED — while the form was still wired to nothing.
   *
   * ⚠️ That is a census satisfied by its own documentation. In a codebase
   * that documents this heavily it is the worst possible failure mode:
   * the more carefully somebody explained an unreachable capability, the
   * more certainly it would vanish from the list. Stripping comments
   * raised the true count from 181 to 206.
   */
  it("🔴 a comment mentioning an action does NOT make it reachable", () => {
    const gate = readFileSync(join(ROOT, "scripts/check-action-reachability.mjs"), "utf8");
    expect(gate).toContain("function codeOnly(");
    /** Both comment forms, or the strip is half a strip. */
    expect(gate).toMatch(/\\\/\\\*\[\\s\\S\]\*\?\\\*\\\//);
    expect(gate).toContain("codeOnly(readFileSync(join(ROOT, f), \"utf8\"))");
  });

  it("the baseline exists and is a number somebody has to justify", () => {
    expect(existsSync(join(ROOT, baselinePath))).toBe(true);
    const b = JSON.parse(readFileSync(join(ROOT, baselinePath), "utf8"));
    expect(typeof b.orphans).toBe("number");
    expect(Array.isArray(b.names)).toBe(true);
    expect(b.names).toHaveLength(b.orphans);
  });

  /**
   * ⭐ THE FOUR THIS WAVE WIRED MUST NOT BE IN IT. If one reappears, a
   * screen has been deleted and the capability has gone back to being
   * unreachable — which is precisely the regression the gate exists for.
   */
  it("⭐ the four actions this wave made reachable are not in the baseline", () => {
    const b = JSON.parse(readFileSync(join(ROOT, baselinePath), "utf8"));
    for (const name of [
      "recordDeduction",
      "assessDeduction",
      "getDeductionFormOptions",
      "postBankChargeInputCredit",
    ]) {
      expect(b.names.some((k: string) => k.endsWith(`#${name}`))).toBe(false);
    }
  });

  it("🔴 and the gate is wired into package.json, or it is a script nobody runs", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(pkg.scripts["check:action-reach"]).toContain(
      "check-action-reachability.mjs",
    );
  });
});
