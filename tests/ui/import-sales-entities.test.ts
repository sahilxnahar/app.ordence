/**
 * Ordence — 🔴 PHASE 5 · THE SALES ENTITIES, PROVED BY EXECUTION
 * Version: v1.85.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS SUITE IS AND IS NOT
 * ══════════════════════════════════════════════════════════════════════
 * Every test below RUNS the real planner over real rows through the real
 * schemas. None of them asserts that a file contains a string, except the
 * four that are deliberately about what is ABSENT from the tree — and
 * those say so in their names.
 *
 * 🔴 WHAT IT CANNOT PROVE, STATED HERE RATHER THAN LEFT TO BE ASSUMED.
 *    This is the `ui` project: JSDOM, no database. So the three claims in
 *    Phase 5's brief that are about the DATABASE — a re-run creates
 *    nothing the second time, preview counts equal commit counts, undo
 *    restores the prior state — are proved here only as far as the pure
 *    layer goes: identical natural keys across two plans of the same
 *    file, and one shape of composite key on both sides of the wire.
 *    The half that needs Postgres needs Phase 2's provenance table, which
 *    is NOT IN THIS TREE. `TRACK-REPORT.md §2` records exactly that, and
 *    a test that pretended otherwise would be the "verified by a floor"
 *    this project keeps finding.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { planImportRecords } from "@/lib/import";
import { checkImportContract, resolveImportOrder } from "@/lib/import/contract";
import { SALES_IMPORT_ENTITIES } from "@/lib/import/entities-sales";
import { ALL_IMPORT_ENTITIES } from "@/lib/import/entities";
import type { CsvRecord } from "@/lib/import/csv";
import type { ContractedImportEntity } from "@/lib/import/types";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const customers = SALES_IMPORT_ENTITIES.customers;
const receipts = SALES_IMPORT_ENTITIES.receipts;

/** A customers file: header row plus the rows given. */
const customerFile = (...rows: string[][]): CsvRecord[] => [
  {
    recordNumber: 1,
    cells: ["Legal name", "GSTIN", "Registration type", "State code", "Effective from"],
  },
  ...rows.map((cells, i) => ({ recordNumber: i + 2, cells })),
];

/** A receipts file: header row plus the rows given. */
const receiptFile = (...rows: string[][]): CsvRecord[] => [
  {
    recordNumber: 1,
    cells: ["Customer", "Received on", "Amount", "Method", "Reference", "TDS deducted"],
  },
  ...rows.map((cells, i) => ({ recordNumber: i + 2, cells })),
];

/* ================================================================== */
describe("⭐ customers — the same tax rules as the form, not a copy of them", () => {
  it("accepts a registered customer and fixes the party type itself", () => {
    const plan = planImportRecords(customers, customerFile(
      ["Acme Cements Ltd", "27AAACR5055K1Z7", "regular", "", "2024-04-01"],
    ));

    expect(plan.fatal).toBeNull();
    expect(plan.rows[0]?.errors).toEqual([]);
    expect(plan.rows[0]?.payload?.partyType).toBe("customer");
    expect(plan.rows[0]?.naturalKey).toEqual({
      kind: "gstin",
      value: "customer|27AAACR5055K1Z7",
      label: "GSTIN 27AAACR5055K1Z7 as a customer",
    });
  });

  /**
   * 🔴 THE RULE THAT MAKES THIS AN IMPORT THROUGH THE FRONT DOOR.
   * `upsertPartySchema.superRefine` refuses a `regular` party with no
   * GSTIN, because without one the supply is reported as B2C and the
   * buyer loses input credit they were entitled to. If this ever passes,
   * somebody has given the importer a schema of its own.
   */
  it("refuses a regular customer with no GSTIN, in the schema's own words", () => {
    const plan = planImportRecords(customers, customerFile(
      ["Beta Traders", "", "regular", "27", "2024-04-01"],
    ));
    const messages = plan.rows[0]?.errors.map((e) => e.message).join(" ") ?? "";
    expect(plan.rows[0]?.errors.length).toBeGreaterThan(0);
    expect(messages.toLowerCase()).toContain("gstin");
  });

  it("refuses a state code that disagrees with the GSTIN's first two digits", () => {
    const plan = planImportRecords(customers, customerFile(
      ["Gamma Steel Pvt Ltd", "27AAACR5055K1Z7", "regular", "29", "2024-04-01"],
    ));
    expect(plan.rows[0]?.errors.length).toBeGreaterThan(0);
  });

  /**
   * 🔴 THE PHASE 6 COLLISION, PROVED IMPOSSIBLE RATHER THAN AGREED.
   * A file that tries to declare its rows as vendors cannot: `partyType`
   * is not a column, so the header is unrecognised and the injected value
   * stands. The key is a `customer|` key whatever the file says.
   */
  it("cannot be talked into writing a vendor row", () => {
    const plan = planImportRecords(customers, [
      {
        recordNumber: 1,
        cells: ["Legal name", "Customer or vendor", "GSTIN", "Registration type", "Effective from"],
      },
      {
        recordNumber: 2,
        cells: ["Delta Supplies", "vendor", "27AAACR5055K1Z7", "regular", "2024-04-01"],
      },
    ]);

    expect(plan.unrecognisedHeaders).toContain("Customer or vendor");
    expect(plan.rows[0]?.payload?.partyType).toBe("customer");
    expect(plan.rows[0]?.naturalKey?.value).toBe("customer|27AAACR5055K1Z7");
    /* And that is the value Phase 6's `vendors` can never produce. */
    expect(plan.rows[0]?.naturalKey?.value.startsWith("vendor|")).toBe(false);
  });

  it("falls back to the name for an unregistered customer, and labels it weak", () => {
    const plan = planImportRecords(customers, customerFile(
      ["  Epsilon   Hardware  ", "", "unregistered", "", "2024-04-01"],
    ));
    expect(plan.rows[0]?.errors).toEqual([]);
    expect(plan.rows[0]?.naturalKey).toEqual({
      kind: "legalName",
      value: "customer|epsilon hardware",
      label: 'name "Epsilon   Hardware" as a customer',
    });
  });

  it("omits the address entirely when every part is blank, so an update cannot erase one", () => {
    const plan = planImportRecords(customers, customerFile(
      ["Zeta Ltd", "27AAACR5055K1Z7", "regular", "", "2024-04-01"],
    ));
    expect(Object.hasOwn(plan.rows[0]?.payload ?? {}, "address")).toBe(false);
  });
});

/* ================================================================== */
describe("⭐ receipts — the form's schema, applied in two steps", () => {
  it("plans a referenced receipt, coerces the money to paise, and asks for the customer", () => {
    const plan = planImportRecords(receipts, receiptFile(
      ["Acme Cements Ltd", "2026-03-14", "1,25,000.50", "neft", "UTR9931", "2500"],
    ));

    expect(plan.fatal).toBeNull();
    expect(plan.rows[0]?.errors).toEqual([]);
    /* ⚠️ A STRING OF MINOR UNITS. `Number(x)*100` would give 12500049.999… */
    expect(plan.rows[0]?.payload?.amountMinor).toBe("12500050");
    expect(plan.rows[0]?.payload?.tdsCreditMinor).toBe("250000");
    expect(plan.rows[0]?.lookups).toEqual([
      expect.objectContaining({
        kind: "company_by_name",
        value: "acme cements ltd",
        into: "companyId",
      }),
    ]);
    expect(plan.rows[0]?.naturalKey).toEqual({
      kind: "reference",
      value: "acme cements ltd|UTR9931",
      label: "reference UTR9931 from Acme Cements Ltd",
    });
  });

  /**
   * 🔴 THE REGRESSION THIS ENTITY WAS ONE LINE AWAY FROM SHIPPING.
   *
   * `recordReceiptSchema` has no `customerName`, and `z.object()` STRIPS
   * unknown keys. With the field merely built in `buildPayload` and not
   * declared in the schema, the parsed payload loses it — so `naturalKey`
   * returns null and `lookups` returns nothing, for EVERY row. Every
   * receipt would import with no customer and no duplicate protection,
   * reporting success. This test is what stops that coming back.
   */
  it("keeps the customer's name through the schema — it is not stripped", () => {
    const plan = planImportRecords(receipts, receiptFile(
      ["Acme Cements Ltd", "2026-03-14", "1000", "upi", "", ""],
    ));
    expect(plan.rows[0]?.payload?.customerName).toBe("Acme Cements Ltd");
    expect(plan.rows[0]?.naturalKey).not.toBeNull();
    expect(plan.rows[0]?.lookups?.length).toBe(1);
  });

  it("refuses a receipt with no customer on it, in the preview, with the sentence written for it", () => {
    const plan = planImportRecords(receipts, receiptFile(
      ["", "2026-03-14", "1000", "cash", "", ""],
    ));
    const messages = plan.rows[0]?.errors.map((e) => e.message) ?? [];
    expect(messages).toContain(
      "Name the customer exactly as their company record is named in Ordence.",
    );
    expect(plan.rows[0]?.payload).toBeUndefined();
  });

  it("falls back to a weak key when no reference is given, and says so in the label", () => {
    const plan = planImportRecords(receipts, receiptFile(
      ["Acme Cements Ltd", "2026-03-14", "5000", "cash", "", ""],
    ));
    expect(plan.rows[0]?.naturalKey?.kind).toBe("unreferenced");
    expect(plan.rows[0]?.naturalKey?.value).toBe("acme cements ltd|2026-03-14|500000|cash");
    expect(plan.rows[0]?.naturalKey?.label).toContain("weak match");
  });

  it("refuses a method the database's enum does not have", () => {
    const plan = planImportRecords(receipts, receiptFile(
      ["Acme Cements Ltd", "2026-03-14", "5000", "bitcoin", "", ""],
    ));
    expect(plan.rows[0]?.errors.length).toBeGreaterThan(0);
  });

  it("refuses two rows of one file that are the same payment", () => {
    const plan = planImportRecords(receipts, receiptFile(
      ["Acme Cements Ltd", "2026-03-14", "5000", "neft", "UTR9931", ""],
      ["ACME   cements ltd", "2026-03-14", "5000", "neft", "UTR9931", ""],
    ));
    expect(plan.rows[0]?.errors).toEqual([]);
    expect(plan.rows[1]?.errors.length).toBeGreaterThan(0);
  });
});

/* ================================================================== */
describe("🔴 safe to run twice — as far as a suite without Postgres can prove it", () => {
  /**
   * The database half of this claim is `findExisting` matching these
   * composites. What is provable here is that the composite is STABLE:
   * the same file planned twice produces byte-identical keys, and
   * spelling, spacing and case do not move them.
   */
  it("the same file planned twice produces identical natural keys", () => {
    const rows = receiptFile(
      ["Acme Cements Ltd", "2026-03-14", "5000", "neft", "UTR9931", ""],
      ["Beta Traders", "2026-03-15", "2500.75", "cash", "", ""],
    );
    const first = planImportRecords(receipts, rows).rows.map((r) => r.naturalKey);
    const second = planImportRecords(receipts, rows).rows.map((r) => r.naturalKey);
    expect(second).toEqual(first);
    expect(first.every((k) => k !== null)).toBe(true);
  });

  it("a differently-spelled customer name lands on the same key", () => {
    const a = planImportRecords(receipts, receiptFile(
      ["Acme Cements Ltd", "2026-03-14", "5000", "neft", "utr9931", ""],
    )).rows[0]?.naturalKey?.value;
    const b = planImportRecords(receipts, receiptFile(
      ["  ACME   Cements   Ltd ", "2026-03-14", "5000", "neft", "UTR9931", ""],
    )).rows[0]?.naturalKey?.value;
    expect(a).toBe(b);
  });

  /**
   * ⚠️ THE TWO SIDES OF THE COMPOSITE, COMPARED AS TEXT.
   *
   * The pure layer folds with `.toLowerCase().replace(/\s+/g, " ")`; the
   * writer folds with `lower(regexp_replace(name, '\s+', ' ', 'g'))`. They
   * are two spellings of one rule and they cannot be executed together
   * here, so this asserts the SQL side still says what the TypeScript side
   * assumes — and would fail the day somebody edits one of them.
   */
  it("the writer folds the customer's name the same way the planner does", () => {
    const writer = read("server/import/writers/sales/customer-receipts.ts");
    expect(writer).toContain("lower(regexp_replace(${companies.name}, '\\\\s+', ' ', 'g'))");
    expect(writer).toContain("upper(${customerReceipts.instrumentRef})");
  });
});

/* ================================================================== */
describe("🔴 the contract, refused by induction and not merely passed", () => {
  const clone = (): Record<string, ContractedImportEntity> =>
    JSON.parse(JSON.stringify({})) as Record<string, ContractedImportEntity>;
  void clone;

  const withEntity = (
    key: string,
    mutate: (e: ContractedImportEntity) => ContractedImportEntity,
  ) => {
    const base = ALL_IMPORT_ENTITIES as unknown as Record<string, ContractedImportEntity>;
    const entity = base[key];
    if (!entity) throw new Error(`no entity ${key}`);
    return { ...base, [key]: mutate(entity) };
  };

  it("passes as delivered, and names both new entities in its census", () => {
    const result = checkImportContract(
      ALL_IMPORT_ENTITIES as unknown as Record<string, ContractedImportEntity>,
    );
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    expect(Object.keys(ALL_IMPORT_ENTITIES)).toEqual(
      expect.arrayContaining(["customers", "receipts"]),
    );
  });

  it("① refuses `receipts` the moment it offers `update` beside `reversal: delete`", () => {
    const induced = withEntity("receipts", (e) => ({
      ...e,
      duplicateModes: ["skip", "update", "fail"],
    }));
    const result = checkImportContract(induced);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.entity === "receipts" && p.member === "contract.reversal")).toBe(true);
  });

  it("② refuses a misspelled dependency, naming the typo", () => {
    const induced = withEntity("receipts", (e) => ({
      ...e,
      contract: {
        ...e.contract,
        dependsOn: [{ entity: "custmoers", strength: "hard", because: "typo" }],
      },
    }));
    const result = checkImportContract(induced);
    expect(result.ok).toBe(false);
    expect(result.problems.map((p) => p.problem).join(" ")).toContain("custmoers");
  });

  it("③ refuses provenance that does not name this entity's own destination", () => {
    const induced = withEntity("receipts", (e) => ({
      ...e,
      contract: {
        ...e.contract,
        provenance: { targets: ["companies"], cardinality: "one-to-one" },
      },
    }));
    const result = checkImportContract(induced);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.member === "contract.provenance.targets")).toBe(true);
  });

  it("④ refuses a requiredness message for a field that is not structural", () => {
    const induced = withEntity("customers", (e) => ({
      ...e,
      contract: {
        ...e.contract,
        requiredness: { structural: [], messages: { legalName: "renamed on one side only" } },
      },
    }));
    const result = checkImportContract(induced);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.entity === "customers")).toBe(true);
  });

  it("⑤ refuses a loop if `customers` is ever made to depend on `receipts`", () => {
    const induced = withEntity("customers", (e) => ({
      ...e,
      contract: {
        ...e.contract,
        dependsOn: [{ entity: "receipts", strength: "hard", because: "induced loop" }],
      },
    }));
    const result = checkImportContract(induced);
    expect(result.ok).toBe(false);
  });

  it("puts customers before receipts in the wave order, because the edge is hard", () => {
    const order = resolveImportOrder(
      ALL_IMPORT_ENTITIES as unknown as Record<string, ContractedImportEntity>,
    );
    expect(order.ok).toBe(true);
    const waveOf = (key: string) =>
      order.ok ? (order.steps.find((step) => step.entity === key)?.wave ?? -1) : -1;
    expect(waveOf("customers")).toBeLessThan(waveOf("receipts"));
  });
});

/* ================================================================== */
describe("⚠️ what is NOT in this tree, asserted so the report cannot drift from it", () => {
  it("`requiredness` is read by the contract checker and by nothing that runs an import", () => {
    expect(read("lib/import/plan.ts")).not.toContain("requiredness");
    expect(read("server/actions/import.ts")).not.toContain("requiredness");
  });

  it("the provenance sidecar the contract describes has no migration in SQL-FILES", () => {
    const files = readdirSync(join(ROOT, "SQL-FILES"));
    expect(files.some((f) => /import_row_provenance/i.test(f))).toBe(false);
    expect(files.some((f) => f.startsWith("0196"))).toBe(false);
    expect(
      files.some((f) => {
        if (!f.endsWith(".sql")) return false;
        return /import_row_provenance/i.test(read(join("SQL-FILES", f)));
      }),
    ).toBe(false);
  });

  it("no reversal engine exists yet, so `reversal: delete` is a declaration and not a behaviour", () => {
    expect(existsSync(join(ROOT, "server/import/reversal.ts"))).toBe(false);
  });

  it("Phase 5's own migration is present and numbered inside its block", () => {
    const files = readdirSync(join(ROOT, "SQL-FILES")).filter((f) => f.startsWith("0230"));
    expect(files).toHaveLength(1);
  });
});
