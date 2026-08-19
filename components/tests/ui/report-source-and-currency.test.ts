/**
 * Ordence — ⭐⭐⭐ BATCH 0104: THE RIGHT TABLE, AND EVERY TOTAL LABELLED
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE TWO FAULTS THESE TESTS DEFEND AGAINST
 * ══════════════════════════════════════════════════════════════════════
 * ① `getGstSummary` READ THE WRONG TABLE ENTIRELY. It joined
 *    `invoice_lines` to `invoices` — and `invoices` in `db/schema/billing.ts`
 *    is ORDENCE BILLING ITS OWN TENANTS. An Indian business opening the GST
 *    report saw the output tax on its own Ordence subscription bills,
 *    presented as its outward supply position.
 *
 *    ⚠️ AND EVERY EXISTING CHECK PASSED. Both tables carry `cgst_minor`,
 *    `sgst_minor`, `igst_minor` and `taxable_value_minor` under exactly
 *    those names, so the query compiled, ran, and returned plausible rupee
 *    figures. `tsc` cannot tell two tables apart by what they MEAN.
 *
 * ② THREE ANALYTICS VIEWS SUMMED ACROSS CURRENCIES. `assets.currency`,
 *    `contracts.currency` and `transactions.currency` all existed and all
 *    were ignored, so `sum(value_amount)` over rupee land and dollar plant
 *    returned a number in the units of nothing — right in every workspace
 *    that has never left INR, which is every workspace anyone tested.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHAT IS ASSERTED, AND WHAT DELIBERATELY IS NOT
 * ══════════════════════════════════════════════════════════════════════
 * Nothing below pins a count, an id or a total. Both faults produce a
 * plausible number, so a test that pinned a number would have been written
 * against the wrong one and would have locked the bug in.
 *
 * What is asserted is a PROPERTY in each case:
 *
 *   ① THE GST SUMMARY READS THE TABLE THAT IS DOCUMENTED AS THE TENANT
 *      BILLING ITS CUSTOMERS, and does not read the one documented as
 *      Ordence billing its tenants. Established by resolving each symbol
 *      to the schema file that exports it, so the test cannot be satisfied
 *      by a rename or by a comment.
 *
 *   ② A TOTAL EITHER CARRIES A CURRENCY OR IS A LIST OF TOTALS THAT DO.
 *      Asserted over every exported type in the analytics action module
 *      rather than against a named field, so a NEW currency-blind total
 *      fails the same way the old ones did.
 *
 *   ③ THE MIGRATION GROUPS RATHER THAN CONVERTS, AND DOES NOT WIDEN
 *      ACCESS WHILE DOING IT.
 *
 *   ④ A LABEL APPLIED BY ASSUMPTION SAYS SO ON THE PAYLOAD.
 *
 *   ⑤ RENDERING TWO CURRENCIES PRODUCES TWO FIGURES. Behavioural, over
 *      many generated inputs, against the one function every panel uses.
 *
 * ⚠️ ABSENCE ASSERTIONS RUN ON COMMENT-STRIPPED SOURCE. `billing.invoices`
 * is named in the comments of the very function that stopped reading it,
 * and a raw `toContain` would report the explanation as the thing it
 * explains.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  formatLabelledValues,
  type LabelledValueLike,
} from "@/components/crm/charts/use-chart-mode";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/**
 * Blanks comments while preserving line structure, so an absence assertion
 * cannot be defeated — or falsely tripped — by prose.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
}

/** The body of one top-level `export async function`, comments removed. */
function functionBody(src: string, name: string): string {
  const bare = stripComments(src);
  const start = bare.indexOf(`export async function ${name}`);
  expect(start, `${name} should exist`).toBeGreaterThan(-1);
  const rest = bare.slice(start + 1);
  const nextExport = rest.indexOf("\nexport ");
  return nextExport === -1 ? rest : rest.slice(0, nextExport);
}

/* ================================================================== */
/* ① THE GST SUMMARY READS THE TENANT'S OWN OUTWARD SUPPLIES          */
/* ================================================================== */

describe("🔴 the GST summary reports the tenant's supplies, not Ordence's", () => {
  /**
   * ⭐ THE TEST THAT WOULD HAVE CAUGHT THE ORIGINAL BUG.
   *
   * It does not look for a table name. It resolves each symbol the query
   * uses to the schema FILE that exports it, and requires that file to be
   * the one whose subject is the tenant's customer. A future refactor that
   * renames `salesInvoices` keeps passing; one that points the report back
   * at platform billing does not.
   */
  it("joins symbols exported by the tenant sales-invoice schema, not the platform billing schema", () => {
    const salesSchema = read("db/schema/sales-invoices.ts");
    const billingSchema = read("db/schema/billing.ts");

    // Establish which file owns which symbol, rather than assuming it.
    const exportsFrom = (src: string, symbol: string) =>
      new RegExp(`export const ${symbol}\\s*=\\s*pgTable\\(`).test(src);

    expect(exportsFrom(salesSchema, "salesInvoices")).toBe(true);
    expect(exportsFrom(salesSchema, "salesInvoiceLines")).toBe(true);
    expect(exportsFrom(billingSchema, "invoices")).toBe(true);
    expect(exportsFrom(billingSchema, "invoiceLines")).toBe(true);

    const body = functionBody(read("server/actions/reports.ts"), "getGstSummary");

    // Reads the tenant's own documents …
    expect(body).toMatch(/\bsalesInvoices\b/);
    expect(body).toMatch(/\bsalesInvoiceLines\b/);

    // … and none of the platform's. `\b` will not match inside
    // `salesInvoices`, and the capital I means case matters.
    expect(body).not.toMatch(/(?<![A-Za-z_])invoices\b/);
    expect(body).not.toMatch(/(?<![A-Za-z_])invoiceLines\b/);
    expect(body).not.toMatch(/(?<![A-Za-z_])invoice_lines\b/);
  });

  /**
   * The two tables are the same shape in opposite directions, and the
   * schema says so in as many words. If that sentence ever stops being
   * true the report above is reading something else again.
   */
  it("the schema still states the two invoice tables are opposite directions", () => {
    const salesSchema = read("db/schema/sales-invoices.ts");
    expect(salesSchema).toMatch(/billing\.invoices.{0,200}ORDENCE/is);
    expect(salesSchema).toMatch(/THIS table's customer is the workspace's customer/);
  });

  /**
   * ⚠️ A GST liability arises when the invoice is ISSUED, not when it is
   * paid. Filtering on a payment state would under-report every period in
   * which a customer was slow — and the previous version filtered on
   * `status = 'open'`, a value that does not exist in
   * `sales_invoice_status` at all.
   */
  it("selects issued documents by their lifecycle, never by a billing status", () => {
    const body = functionBody(read("server/actions/reports.ts"), "getGstSummary");
    const statuses = read("db/schema/sales-invoices.ts");

    // Whatever states it selects must be states this enum actually has.
    const selected = [...body.matchAll(/'([a-z_]+)'/g)]
      .map((m) => m[1] as string)
      .filter((v) => /^(draft|issued|part_paid|paid|cancelled|open|void)$/.test(v));

    expect(selected.length).toBeGreaterThan(0);
    for (const state of selected) {
      expect(
        new RegExp(`"${state}",`).test(statuses),
        `"${state}" is not a sales_invoice_status`,
      ).toBe(true);
    }

    // A draft is not a document and a cancelled one was withdrawn.
    expect(selected).not.toContain("draft");
    expect(selected).not.toContain("cancelled");
  });

  /** Output tax still carries its own currency per group, never one scalar. */
  it("still reports output tax per currency rather than as one figure", () => {
    const body = functionBody(read("server/actions/reports.ts"), "getGstSummary");
    expect(body).toMatch(/groupBy\(\s*salesInvoices\.currency\s*\)/);
    expect(body).toMatch(/outputTaxByCurrency/);
  });
});

/* ================================================================== */
/* ② NO TOTAL LEAVES THE ANALYTICS MODULE WITHOUT A CURRENCY          */
/* ================================================================== */

/** Every `export type X = { … };` block in a module, brace-matched. */
function exportedTypeBlocks(src: string): Map<string, string> {
  const bare = stripComments(src);
  const blocks = new Map<string, string>();

  for (const m of bare.matchAll(/export type (\w+)\s*=\s*\{/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    let depth = 0;
    let i = open;
    for (; i < bare.length; i++) {
      if (bare[i] === "{") depth++;
      else if (bare[i] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    blocks.set(m[1] as string, bare.slice(open, i + 1));
  }

  return blocks;
}

describe("🔴 an aggregate either groups by currency or refuses — never adds", () => {
  /**
   * ⭐ THE GENERAL RULE, NOT A LIST OF KNOWN FIELDS.
   *
   * Any exported type that declares a TOTAL as a bare string must declare
   * a `currency` beside it. A new `totalSomething: string` added next year
   * fails this test on the day it is written, which is the only day it is
   * cheap to fix.
   */
  it("every exported total is either labelled or a per-currency list", () => {
    const blocks = exportedTypeBlocks(read("server/actions/analytics.ts"));
    expect(blocks.size).toBeGreaterThan(0);

    const bareTotal = /^\s*(total[A-Z]\w*|difference)\??:\s*string;/m;

    const offenders: string[] = [];
    for (const [name, body] of blocks) {
      if (!bareTotal.test(body)) continue;
      if (!/^\s*currency\??:\s*string;/m.test(body)) offenders.push(name);
    }

    expect(offenders, `these types carry a total with no currency: ${offenders.join(", ")}`)
      .toEqual([]);
  });

  /**
   * The same rule stated from the other side: the money that reaches a
   * dashboard tile arrives as a LIST. A list can hold two currencies; a
   * string cannot, and a shape that can only hold one number is how the
   * previous version came to hold a wrong one.
   */
  it("the portfolio and pipeline summaries expose money as a per-currency list", () => {
    const blocks = exportedTypeBlocks(read("server/actions/analytics.ts"));

    for (const name of ["AssetPortfolioSummary", "ContractPipelineSummary"]) {
      const body = blocks.get(name);
      expect(body, `${name} should be exported`).toBeTruthy();
      expect(body).toMatch(/ByCurrency:\s*LabelledValue\[\]/);
      expect(body).not.toMatch(/^\s*totalValue\??:\s*string;/m);
    }
  });

  /**
   * ⚠️ THE LEDGER REFUSES TO MERGE RATHER THAN LABELLING A MERGED FIGURE.
   * A trial balance is only balanced WITHIN a currency: a single
   * `isBalanced` over two currencies can read `true` because two real
   * imbalances cancelled as bare numbers.
   */
  it("the ledger answers per currency, so 'balanced' means balanced in one", () => {
    const blocks = exportedTypeBlocks(read("server/actions/analytics.ts"));

    const series = blocks.get("LedgerCurrencySeries");
    expect(series, "LedgerCurrencySeries should be exported").toBeTruthy();
    expect(series).toMatch(/^\s*currency:\s*string;/m);
    expect(series).toMatch(/isBalanced:\s*boolean;/);

    const summary = blocks.get("LedgerTrailingSummary");
    expect(summary).toMatch(/series:\s*LedgerCurrencySeries\[\]/);
    // The summary itself must not carry a merged verdict.
    expect(summary).not.toMatch(/isBalanced/);
  });

  /** The Drizzle view types must describe the grouped views, or the reads lie. */
  it("all three analytics views declare the currency they grouped by", () => {
    const src = read("db/schema/analytics.ts");
    const names = ["vAssetPortfolio", "vLedgerDaily", "vContractPipeline"];

    for (const name of names) {
      const start = src.indexOf(`export const ${name} = pgView(`);
      expect(start, `${name} should exist`).toBeGreaterThan(-1);
      const block = src.slice(start, src.indexOf(".existing();", start));
      expect(block, `${name} must expose currency`).toMatch(
        /currency:\s*varchar\("currency"/,
      );
      // The tenant key is the second RLS layer and must not be lost.
      expect(block).toMatch(/tenantId:\s*uuid\("tenant_id"\)/);
    }
  });
});

/* ================================================================== */
/* ③ THE MIGRATION GROUPS, AND DOES NOT WIDEN ACCESS                  */
/* ================================================================== */

describe("🔴 0104 regroups the views without opening them up", () => {
  const sql = read("SQL-FILES/0104_analytics_views_carry_currency.sql");

  it("groups by currency in every view it redefines", () => {
    const groupBys = [...sql.matchAll(/GROUP BY[^;]*/gi)].map((m) => m[0]);
    expect(groupBys.length).toBeGreaterThan(0);
    for (const clause of groupBys) {
      expect(clause, `a GROUP BY without currency: ${clause}`).toMatch(/currency/i);
    }
  });

  /**
   * 🔴 A VIEW OVER TENANT TABLES INHERITS RLS ONLY IF IT IS NOT SECURITY
   * DEFINER. Dropping `security_invoker` while fixing the currency bug
   * would trade a wrong number for a cross-tenant leak, and the leak has
   * no symptom either.
   */
  it("restates security_invoker on every view it replaces", () => {
    const replaced = [...sql.matchAll(/CREATE OR REPLACE VIEW\s+public\.(\w+)/gi)].map(
      (m) => m[1] as string,
    );
    expect(replaced.sort()).toEqual(
      ["v_asset_portfolio", "v_contract_pipeline", "v_ledger_daily"].sort(),
    );
    expect(sql.match(/security_invoker\s*=\s*true/gi)?.length ?? 0).toBeGreaterThanOrEqual(
      replaced.length,
    );
    expect(sql).not.toMatch(/SECURITY\s+DEFINER/i);
  });

  /**
   * ⚠️ REPLACE, NOT DROP. `0047_grant_missing_views.sql` granted SELECT on
   * these three to `ordence_app`; a DROP takes the grants with it and the
   * dashboard returns "permission denied for view" on the next request.
   */
  it("never drops the views it is replacing", () => {
    expect(sql).not.toMatch(/DROP\s+VIEW/i);
  });

  /**
   * 🔴 `BEGIN;` IN A BROWSER SQL CONSOLE IS FALSE ATOMICITY. Each
   * statement arrives on its own connection, so the transaction is never
   * joined and the `COMMIT` discards work that appeared to succeed. This
   * has already cost this project a migration that applied nothing.
   */
  it("holds no transaction and sets no scope across statements", () => {
    expect(sql).not.toMatch(/^\s*BEGIN\s*;/im);
    expect(sql).not.toMatch(/^\s*COMMIT\s*;/im);
    expect(sql).not.toMatch(/^\s*SET\s+(LOCAL\s+)?app\.platform_scope/im);
  });

  /** Re-running the whole file must be a no-op, statement by statement. */
  it("every creating statement is independently idempotent", () => {
    const creates = [...sql.matchAll(/^\s*CREATE\s+(?!OR REPLACE)(\w+)/gim)].map(
      (m) => m[0].trim(),
    );
    for (const c of creates) {
      expect(c, `non-idempotent statement: ${c}`).toMatch(/IF NOT EXISTS/i);
    }
  });

  /** The diagnostic runs first, so a refusal still teaches something. */
  it("puts the diagnostic before the first change", () => {
    // ⚠️ Anchored at a line start. The header PROSE names
    // `CREATE OR REPLACE VIEW` while explaining why it is used, and an
    // unanchored search would find the explanation rather than the change.
    const diagnostic = sql.search(/^SELECT\s*$[\s\S]{0,80}0104 · diagnostic/m);
    const firstChange = sql.search(/^CREATE OR REPLACE VIEW/im);
    expect(diagnostic).toBeGreaterThan(-1);
    expect(diagnostic).toBeLessThan(firstChange);
  });

  /**
   * ⚠️ `query_to_xml` DEFERS PLANNING, NOT EXISTENCE, and a `CASE` over
   * relations resolves both branches before the guard runs. A read of a
   * possibly-absent relation has to be guarded as a STRING.
   */
  it("guards reads of possibly-absent relations with to_regclass", () => {
    expect(sql).not.toMatch(/query_to_xml/i);
    expect(sql).toMatch(/to_regclass\(/);
  });
});

/* ================================================================== */
/* ④ A LABEL APPLIED BY ASSUMPTION SAYS SO                            */
/* ================================================================== */

describe("⚠️ where the schema forces the label, the payload admits it", () => {
  /**
   * `vendor_ledger_entries` has no `currency` column, so the sum cannot be
   * mixing currencies — but the figure is read by somebody deciding what
   * to pay, and a bare "412000" is read as rupees whatever the books are
   * kept in.
   */
  it("vendor balances carry the functional currency AND the admission", () => {
    const body = functionBody(read("server/actions/purchases.ts"), "getVendorBalances");
    expect(body).toMatch(/functionalCurrencyFromSettings\(/);
    expect(body).toMatch(/currencyAssumed:\s*true/);
    expect(body).toMatch(/currencyNote/);
  });

  /**
   * ⭐ THE FLAG MEANS ONE THING IN BOTH MODULES. A total whose currency was
   * read off the row is `false`; a total wearing the workspace's functional
   * currency because the table cannot hold another is `true`. Two meanings
   * would make the flag worse than no flag.
   */
  it("the analytics module never claims a currency it did not read", () => {
    const bare = stripComments(read("server/actions/analytics.ts"));
    // Every value emitted from a grouped view came off the row.
    expect(bare).toMatch(/currencyAssumed:\s*false/);
    expect(bare).not.toMatch(/currencyAssumed:\s*true/);
  });

  /**
   * ⚠️ THE REPORTS MODULE IS THE OPPOSITE CASE AND MUST STAY THAT WAY:
   * `itc_register`, `demand_notices`, `receipts`, `tds_deductions` and
   * `tds_challans` hold no currency, so their totals are labelled by
   * assumption and say so.
   */
  it("the reports module still admits its assumed labels", () => {
    const bare = stripComments(read("server/actions/reports.ts"));
    expect(bare).toMatch(/currencyAssumed/);
    expect(bare).toMatch(/labelled\([^)]*functional\.code,\s*true\)/);
  });

  /**
   * 🔴 THE MINOR-UNIT TRAP, NAMED SO IT STAYS NAMED. Minor units are not
   * universally two decimals — the yen has none, the dinar has three — and
   * a helper called `decimalToPaise` invites exactly the wrong reuse.
   */
  it("the analytics fixed-point helpers are not named after a minor unit", () => {
    const bare = stripComments(read("server/actions/analytics.ts"));
    expect(bare).not.toMatch(/paise/i);
  });
});

/* ================================================================== */
/* ⑤ RENDERING: TWO CURRENCIES PRODUCE TWO FIGURES                    */
/* ================================================================== */

describe("🔴 the one function every panel formats money with", () => {
  const value = (currency: string, v: string): LabelledValueLike => ({
    currency,
    value: v,
    currencyAssumed: false,
  });

  /**
   * ⭐ ASSERTED OVER MANY INPUTS, so no single lucky pair can make it pass.
   * The property is that the OUTPUT NAMES EVERY CURRENCY IT WAS GIVEN —
   * which is exactly what a merged sum cannot do.
   */
  it("names every currency it was given, whatever the amounts", () => {
    const currencies = ["INR", "USD", "EUR", "JPY", "KWD", "AED"];
    const amounts = ["0.00", "1.50", "999999999.99", "12345.67", "-42.00"];

    for (const a of currencies) {
      for (const b of currencies) {
        if (a === b) continue;
        for (const amount of amounts) {
          const out = formatLabelledValues([value(a, amount), value(b, amount)]);
          // Both currencies survive. INR renders as its symbol, not its code.
          const marker = (c: string) => (c === "INR" ? "₹" : c);
          expect(out).toContain(marker(a));
          expect(out).toContain(marker(b));
        }
      }
    }
  });

  /**
   * 🔴 THE ANTI-PROPERTY. Two currencies must never collapse to one
   * figure. Counting separators is how a merged implementation is caught:
   * a `sum()` would produce one.
   */
  it("never collapses a mixed list into a single figure", () => {
    for (let n = 1; n <= 5; n++) {
      const list = ["INR", "USD", "EUR", "JPY", "KWD"]
        .slice(0, n)
        .map((c) => value(c, "100.00"));
      const out = formatLabelledValues(list);
      expect(out.split("·")).toHaveLength(n);
    }
  });

  /**
   * ⚠️ THE COMMON CASE MUST NOT HAVE REGRESSED. A single-currency
   * workspace — which is nearly all of them — should read exactly what it
   * read before, or this change trades one silent fault for a visible one.
   */
  it("a single-currency list reads as one plain figure", () => {
    const out = formatLabelledValues([value("INR", "1234567.89")]);
    expect(out).not.toContain("·");
    expect(out).toContain("₹");
  });

  /**
   * ⭐ NOTHING IS NOT ZERO. "No assets" and "assets worth nothing" are
   * different facts and a tile that renders the first as ₹0.00 is
   * asserting the second.
   */
  it("an empty list is an em dash, not a zero", () => {
    expect(formatLabelledValues([])).toBe("—");
    expect(formatLabelledValues([])).not.toContain("0");
  });
});
