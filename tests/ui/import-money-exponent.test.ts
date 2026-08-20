/**
 * Ordence — WAVE 2C · the money exponent reaches the coercion
 * Build v1.89.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT WAS WRONG
 * ══════════════════════════════════════════════════════════════════════
 * `lib/import/plan.ts` called `coerceMoneyMinor(raw)` with no exponent,
 * so every money column in the product was coerced at two decimal
 * places. `1.234` — 1,234 fils, an ordinary Kuwaiti amount — was refused
 * as malformed, and `1234` in a JPY column became `123400`.
 *
 * ⚠️ EVERY TEST BELOW IS WRITTEN TO GO RED ON THE OLD CODE. The proof
 * that they do is in TRACK-REPORT.md: `plan.ts` was reverted to
 * `coerceMoneyMinor(raw, 2)` and this file was re-run.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { planImport } from "@/lib/import/plan";
import { ALL_IMPORT_ENTITIES } from "@/lib/import/entities";
import type {
  ImportColumn,
  ImportContext,
  ImportEntityDefinition,
  ImportMoneyContract,
} from "@/lib/import/types";

/* ------------------------------------------------------------------ */
/* A MINIMAL ENTITY, so the assertions are about the planner and not    */
/* about somebody else's Zod schema.                                    */
/* ------------------------------------------------------------------ */

const AMOUNT: ImportColumn = {
  field: "amountMinor",
  header: "Amount",
  kind: "money",
  required: true,
  help: "An amount.",
};

const CURRENCY_COLUMN: ImportColumn = {
  field: "currency",
  header: "Currency",
  kind: "text",
  required: false,
  maxLength: 3,
  help: "Three-letter ISO code.",
};

function fixture(
  money: ImportMoneyContract,
  columns: readonly ImportColumn[] = [AMOUNT],
): ImportEntityDefinition {
  return {
    key: "test-money",
    label: "Test",
    noun: { one: "row", many: "rows" },
    description: "fixture",
    table: "companies",
    feature: "crm.companies",
    createPermission: "companies:create",
    updatePermission: "companies:update",
    money,
    columns,
    buildPayload: (values) => ({ ...values }),
    schema: z.object({}).passthrough(),
    naturalKey: () => null,
    rowLabel: () => "row",
  };
}

const inWorkspace = (code: string): ImportContext => ({ workspaceCurrency: code });

const firstRow = (
  entity: ImportEntityDefinition,
  csv: string,
  context: ImportContext,
) => {
  const plan = planImport(entity, csv, context);
  return { plan, row: plan.rows[0] };
};

/* ------------------------------------------------------------------ */

describe("🔴 the exponent is the currency's, not two", () => {
  it("1.234 in a KWD workspace is 1234 minor units", () => {
    const { plan, row } = firstRow(
      fixture({ source: "workspace" }),
      "Amount\n1.234\n",
      inWorkspace("KWD"),
    );

    expect(plan.fatal).toBeNull();
    expect(row?.errors).toEqual([]);
    /*
     * 🔴 THE ASSERTION THE OLD CODE FAILS. At exponent 2 this row carried
     * one error — `"1.234" is not an amount` — and no payload at all.
     */
    expect(row?.payload).toEqual({ amountMinor: "1234" });
  });

  it("1234 in a JPY workspace is ¥1234 and not ¥123400", () => {
    const { row } = firstRow(
      fixture({ source: "workspace" }),
      "Amount\n1234\n",
      inWorkspace("JPY"),
    );

    expect(row?.errors).toEqual([]);
    // ⚠️ The old code produced "123400" here and reported success.
    expect(row?.payload).toEqual({ amountMinor: "1234" });
  });

  it("1.234 in an INR workspace is STILL refused — no rounding", () => {
    const { row } = firstRow(
      fixture({ source: "workspace" }),
      "Amount\n1.234\n",
      inWorkspace("INR"),
    );

    expect(row?.payload).toBeUndefined();
    expect(row?.errors).toHaveLength(1);
    /*
     * 🔴 A THIRD DECIMAL IN A RUPEE COLUMN IS A MISTAKE IN THE FILE, and
     * silently dropping the digit is how a migration ties to the rupee
     * and is out by lakhs at the paisa.
     */
    expect(row?.errors[0]?.message).toContain("not a valid amount in INR");
    expect(row?.errors[0]?.message).toContain("up to 2 decimal places");
  });

  it("the message names THIS currency's decimals, not rupees", () => {
    const kwd = firstRow(
      fixture({ source: "workspace" }),
      "Amount\n1.2345\n",
      inWorkspace("KWD"),
    ).row;
    expect(kwd?.errors[0]?.message).toContain("not a valid amount in KWD");
    expect(kwd?.errors[0]?.message).toContain("up to 3 decimal places");
    // ⚠️ The old sentence. A Kuwaiti customer who believes it deletes a real digit.
    expect(kwd?.errors[0]?.message).not.toContain("rupees");

    const jpy = firstRow(
      fixture({ source: "workspace" }),
      "Amount\n12.34\n",
      inWorkspace("JPY"),
    ).row;
    expect(jpy?.errors[0]?.message).toContain("JPY has no decimal places");
    expect(jpy?.errors[0]?.message).not.toContain("decimal place,");
  });

  it("exact representability is preserved: 0.001 KWD is 1 fils", () => {
    const { row } = firstRow(
      fixture({ source: "workspace" }),
      "Amount\n0.001\n",
      inWorkspace("KWD"),
    );
    expect(row?.payload).toEqual({ amountMinor: "1" });
  });
});

/* ------------------------------------------------------------------ */

describe("🔴 the currency is a fact about the ROW", () => {
  const entity = fixture(
    { source: "column", field: "currency", whenBlank: "workspace" },
    [AMOUNT, CURRENCY_COLUMN],
  );

  it("one file, two currencies, two exponents", () => {
    const plan = planImport(
      entity,
      "Amount,Currency\n1.234,KWD\n1.23,INR\n",
      inWorkspace("INR"),
    );

    expect(plan.fatal).toBeNull();
    expect(plan.rows.map((r) => r.payload?.amountMinor)).toEqual(["1234", "123"]);
  });

  it("a blank currency cell falls back to the workspace when the entity says so", () => {
    const plan = planImport(entity, "Amount,Currency\n1.234,\n", inWorkspace("KWD"));
    expect(plan.rows[0]?.payload).toEqual({ amountMinor: "1234", currency: null });
  });

  it("a blank currency cell is REFUSED when the entity says so", () => {
    const strict = fixture(
      { source: "column", field: "currency", whenBlank: "refuse" },
      [AMOUNT, CURRENCY_COLUMN],
    );
    const plan = planImport(strict, "Amount,Currency\n1.234,\n", inWorkspace("KWD"));
    expect(plan.rows[0]?.payload).toBeUndefined();
    expect(plan.rows[0]?.errors[0]?.column).toBe("Currency");
    expect(plan.rows[0]?.errors[0]?.message).toContain("no currency");
  });

  it("an unknown code refuses the ROW once, naming the currency cell", () => {
    const plan = planImport(
      entity,
      "Amount,Currency\n1.234,XYZ\n",
      inWorkspace("INR"),
    );
    // ⚠️ ONE error, on the currency column — not one per amount.
    expect(plan.rows[0]?.errors).toHaveLength(1);
    expect(plan.rows[0]?.errors[0]?.column).toBe("Currency");
    expect(plan.rows[0]?.errors[0]?.message).toContain("not a currency this system knows");
  });

  it("an unknown WORKSPACE currency refuses rather than guessing INR", () => {
    const plan = planImport(
      fixture({ source: "workspace" }),
      "Amount\n1.23\n",
      inWorkspace("Rs"),
    );
    expect(plan.rows[0]?.payload).toBeUndefined();
    expect(plan.rows[0]?.errors[0]?.message).toContain("not a currency this system knows");
  });
});

/* ------------------------------------------------------------------ */

describe('🔴 `money: { source: "none" }` cannot be used to not decide', () => {
  it("an entity with a money column and no currency is refused before a row is read", () => {
    const plan = planImport(
      fixture({ source: "none" }, [AMOUNT]),
      "Amount\n1.23\n",
      inWorkspace("INR"),
    );
    expect(plan.fatal).toContain("declares no currency for its amounts");
    expect(plan.fatal).toContain("Amount");
    expect(plan.rows).toEqual([]);
  });

  it("an entity with no money column is unaffected", () => {
    const plan = planImport(
      fixture({ source: "none" }, [CURRENCY_COLUMN]),
      "Currency\nINR\n",
      inWorkspace("INR"),
    );
    expect(plan.fatal).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* ⚠️ AND THROUGH A REAL SHIPPED ENTITY, because a fixture proves the   */
/*    planner and not the wiring.                                       */
/* ------------------------------------------------------------------ */

describe("🔴 a shipped entity reads its amounts at the workspace's exponent", () => {
  const receipts = ALL_IMPORT_ENTITIES["receipts"];

  it("customer receipts: 1.234 is 1234 fils in Kuwait", () => {
    const plan = planImport(
      receipts,
      "Customer,Received on,Amount,Method\nAcme,2026-04-01,1.234,neft\n",
      inWorkspace("KWD"),
    );
    expect(plan.fatal).toBeNull();
    expect(plan.rows[0]?.errors).toEqual([]);
    expect(plan.rows[0]?.payload?.amountMinor).toBe("1234");
  });

  it("customer receipts: the same file in India is refused, in rupee terms", () => {
    const plan = planImport(
      receipts,
      "Customer,Received on,Amount,Method\nAcme,2026-04-01,1.234,neft\n",
      inWorkspace("INR"),
    );
    expect(plan.rows[0]?.errors[0]?.message).toContain("not a valid amount in INR");
  });

  it("every shipped entity with a money column declares a currency source", () => {
    for (const [key, entity] of Object.entries(ALL_IMPORT_ENTITIES)) {
      const hasMoney = entity.columns.some((c) => c.kind === "money");
      if (hasMoney) {
        expect(entity.money.source, `${key} has a money column`).not.toBe("none");
      }
    }
  });
});
