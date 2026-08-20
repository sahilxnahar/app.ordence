/**
 * Ordence — ⭐⭐ BATCH 57: THE PRODUCT CAN BE LOADED WITH DATA
 * Version: v1.57.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THERE WAS NO DATA IMPORT OF ANY KIND
 * ══════════════════════════════════════════════════════════════════════
 * Every workspace started empty and everything in it was typed by hand.
 *
 * ⚠️ THE PARSER IS TESTED HARDEST, and not because it is the most
 * interesting part. It is the part whose failures are SILENT: a BOM
 * unmaps the first column, an unquoted comma shifts every field one place
 * to the left, a CRLF leaves `\r` on the end of every last value. None of
 * those raise anything. They produce a file that imports "successfully"
 * into the wrong shape, and nobody finds out for months.
 *
 * The other half of this suite asserts the four structural properties the
 * framework is worth nothing without: one validation path shared by the
 * dry run and the real run, failed rows handed back, a natural key per
 * entity, and a permission guard on every browser-reachable export.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseCsv, alignToHeader, unguardFormulaPrefix } from "@/lib/import/csv";
import { mapHeaders, normaliseHeader } from "@/lib/import/mapping";
import {
  coerceBoolean,
  coerceCivilDay,
  coerceEnum,
  coerceInteger,
  coerceMoneyMinor,
} from "@/lib/import/values";
import { planImport, MAX_IMPORT_ROWS } from "@/lib/import/plan";
import { buildFailedRowsCsv, buildReport, buildTemplateCsv } from "@/lib/import/report";
import { IMPORT_ENTITIES, isImportEntityKey } from "@/lib/import/entities";

/**
 * ⭐ WAVE 2C. The planner takes the workspace's currency as data — see
 * `ImportContext`. These files are all about entities whose amounts are
 * in rupees, so every call passes the same one; the exponent behaviour
 * itself is proven in `tests/ui/import-money-exponent.test.ts`.
 */
const IMPORT_CONTEXT = { workspaceCurrency: "INR" } as const;


const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/**
 * ⚠️ THE WRITE PATH IS NO LONGER ONE FILE, AND THIS CONSTANT NOW READS ALL
 * OF IT.
 *
 * Phase 1 replaced four `if (entity.table === ...)` chains in
 * `server/actions/import.ts` with one writer module per destination under
 * `server/import/writers/`, wired through an exhaustive `Record` so a
 * destination with no writer fails to compile.
 *
 * 🔴 THESE ASSERTIONS DID NOT BECOME WRONG , THEY BECAME MIS-ADDRESSED.
 *    Every property they pin (writes go through `withTenant`, the tenant
 *    predicate is written in the WHERE clause even though RLS enforces it
 *    independently) is still true and still worth pinning. It moved file.
 *    Concatenating the write path is what keeps the assertion about the
 *    PROPERTY rather than about a filename.
 */
const WRITE_PATH_FILES = [
  "server/actions/import.ts",
  "server/import/writers/companies.ts",
  "server/import/writers/gst-parties.ts",
  "server/import/writers/transactions.ts",
  "server/import/writers/sales-invoices.ts",
  "server/import/writers/vendor-ledger-entries.ts",
  "server/import/writers/stock-movements.ts",
  "server/import/writers/shared.ts",
] as const;
const ACTIONS = WRITE_PATH_FILES.map((f) => read(f)).join("\n");

/**
 * ⚠️ AND ONE ASSERTION MUST STAY SCOPED TO THE ACTION FILE ALONE.
 *
 * "exports only async functions" is a `"use server"` rule: every export of
 * a server-action module becomes a callable endpoint, so a non-async
 * export there is a bug. The writer modules are `import "server-only"`
 * internals, not actions , they export `const` writers on purpose, and
 * folding them into that assertion would make it refuse the correct thing.
 */
const ACTION_FILE_ONLY = read("server/actions/import.ts");
const PLAN = read("lib/import/plan.ts");
const WIZARD = read("components/settings/import-wizard.tsx");
const PAGE = read("app/(crm)/settings/import/page.tsx");
const ENTITIES = read("lib/import/entities.ts");
const VALUES = read("lib/import/values.ts");

/**
 * ⚠️ COMMENT-STRIPPED SOURCE. Every assertion below that claims a piece
 * of code is ABSENT has to read this, not the raw file — otherwise a
 * comment explaining why `Math.round(Number(` is wrong would itself fail
 * the test that forbids `Math.round(Number(`. Same helper as
 * `tests/ui/order-create.test.ts`.
 */
const codeOnly = (s: string) =>
  s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));

/* ================================================================== */
/* ① THE PARSER — every quiet corruption, one at a time                */
/* ================================================================== */

describe("the CSV parser", () => {
  const cells = (text: string) => {
    const r = parseCsv(text);
    if (!r.ok) throw new Error(`expected a parse, got: ${r.error}`);
    return r.records.map((rec) => rec.cells);
  };

  it("reads a plain file", () => {
    expect(cells("a,b,c\n1,2,3")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  /**
   * 🔴 THE BOM. Excel on Windows writes `EF BB BF` before the first byte.
   * Left in place, the first header is `﻿Name`, which does not match
   * `Name`, so the name column goes silently unmapped and every row fails
   * with "name is required" — a report that blames the customer's data
   * for a defect in the reader.
   */
  it("strips a UTF-8 BOM so the first column name still matches", () => {
    const withBom = "﻿Name,City\nAcme,Pune";
    expect(cells(withBom)[0]).toEqual(["Name", "City"]);
    // And the whole way through: the header maps, so the row validates.
    const plan = planImport(IMPORT_ENTITIES.companies, "﻿Name\nAcme Traders", IMPORT_CONTEXT);
    expect(plan.fatal).toBeNull();
    expect(plan.rows[0]?.errors).toEqual([]);
  });

  /**
   * ⚠️ CRLF. Splitting on `\n` alone leaves a `\r` on every last field,
   * so `"Pune\r"` is stored and never matches `"Pune"` again.
   */
  it("handles CRLF without leaving a carriage return on the last field", () => {
    expect(cells("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(cells("a,b\r\n1,2")[1]?.[1]).toBe("2");
  });

  /** Old Mac exports use a bare CR. */
  it("handles a bare CR as a record separator", () => {
    expect(cells("a,b\r1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  /**
   * 🔴 THE EMBEDDED COMMA. Split naively and the row gains a column,
   * everything after it shifts left, and a phone number lands in the city
   * field — data that imports successfully and is wrong.
   */
  it("keeps a comma inside a quoted field", () => {
    expect(cells('name,city\n"Kumar, Rajesh & Co",Pune')).toEqual([
      ["name", "city"],
      ["Kumar, Rajesh & Co", "Pune"],
    ]);
  });

  /**
   * 🔴 THE EMBEDDED NEWLINE — a multi-line postal address in one cell. A
   * line-based reader turns one record into three broken ones. This is
   * why the parser walks characters and never splits on lines first.
   */
  it("keeps a newline inside a quoted field, and counts it as one record", () => {
    const parsed = parseCsv('name,address\n"Acme","12 MG Road\nPune 411001"');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.records).toHaveLength(2);
    expect(parsed.records[1]?.cells[1]).toBe("12 MG Road\nPune 411001");
  });

  /** A CRLF inside quotes is normalised, so nothing stores a stray `\r`. */
  it("normalises CRLF inside a quoted field to a plain newline", () => {
    const parsed = parseCsv('a\n"one\r\ntwo"');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.records[1]?.cells[0]).toBe("one\ntwo");
  });

  it("reads a doubled quote as one literal quote", () => {
    expect(cells('a\n"He said ""hello"""')[1]).toEqual(['He said "hello"']);
  });

  /**
   * ⚠️ TRAILING BLANK LINES. Almost every exporter writes one. A reader
   * that does not drop them reports "1 row failed" on a file the customer
   * can see is fine, and there is no row for them to look at.
   */
  it("drops trailing empty lines", () => {
    expect(cells("a,b\n1,2\n\n\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(cells("a,b\r\n1,2\r\n\r\n")).toHaveLength(2);
  });

  /**
   * ⚠️ A BLANK LINE IN THE MIDDLE IS DROPPED TOO — but the record numbers
   * of what follows are NOT renumbered, so every error message still
   * points at the row the customer sees in their spreadsheet.
   */
  it("drops a mid-file blank line without shifting the row numbers after it", () => {
    const parsed = parseCsv("a\n1\n\n3");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.records.map((r) => r.recordNumber)).toEqual([1, 2, 4]);
    expect(parsed.records[2]?.cells).toEqual(["3"]);
  });

  /**
   * 🔴 AN UNBALANCED QUOTE IS REFUSED, NOT ABSORBED. Treating end-of-file
   * as the closing quote — what most naive parsers do — lets one stray `"`
   * in row 12 swallow the remaining 988 rows into a single cell. The
   * import then reports "1 row imported" and nothing says why.
   */
  it("refuses a file with an unterminated quote and names the row", () => {
    const parsed = parseCsv('name\n"Acme\nmore,rows');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("never closed");
    expect(parsed.error).toContain("row 2");
  });

  it("refuses an empty file rather than reporting zero rows imported", () => {
    expect(parseCsv("").ok).toBe(false);
    expect(parseCsv("\n\n  \n").ok).toBe(false);
  });

  /**
   * ⚠️ TOO MANY VALUES IS AN ERROR, TOO FEW IS PADDED, and they are not
   * symmetrical. More values than headers is almost always an unescaped
   * comma, which shifts every subsequent field — accepting it stores
   * plausible wrong data. Fewer is an exporter omitting trailing empties.
   */
  it("refuses a row with more values than headers and explains the comma", () => {
    const result = alignToHeader(["Kumar", "Rajesh", "Pune"], 2);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("wrapped in double quotes");
  });

  it("pads a short row instead of refusing it", () => {
    const result = alignToHeader(["Acme"], 3);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cells).toEqual(["Acme", "", ""]);
  });

  it("trims trailing empty extras rather than refusing a trailing comma", () => {
    const result = alignToHeader(["Acme", "Pune", ""], 2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cells).toEqual(["Acme", "Pune"]);
  });

  /**
   * ⭐ THE ROUND TRIP. The failed-rows CSV goes out through
   * `escapeCsvCell`, which prefixes an apostrophe to anything Excel would
   * execute — including a phone number starting `+91`. Without the
   * inverse on the way back in, fix-and-re-upload corrupts exactly the
   * columns most likely to trip the guard.
   */
  it("undoes the formula guard on the way back in, and only that", () => {
    expect(unguardFormulaPrefix("'+919812345678")).toBe("+919812345678");
    expect(unguardFormulaPrefix("'=SUM(A1)")).toBe("=SUM(A1)");
    // A name that genuinely begins with an apostrophe keeps it.
    expect(unguardFormulaPrefix("'Tis The Season")).toBe("'Tis The Season");
    expect(unguardFormulaPrefix("Acme")).toBe("Acme");
  });
});

/* ================================================================== */
/* ② THE HEADER ROW THAT DOES NOT MATCH                                */
/* ================================================================== */

describe("header mapping", () => {
  it("ignores capitals, spaces, underscores and hyphens", () => {
    expect(normaliseHeader("Company Name")).toBe("companyname");
    expect(normaliseHeader("company_name")).toBe("companyname");
    expect(normaliseHeader("COMPANY-NAME ")).toBe("companyname");
    // And a stray BOM mid-file, which is the defect that unmaps the first
    // column of a concatenated export.
    expect(normaliseHeader("﻿Name")).toBe("name");
  });

  it("matches known alternative wordings", () => {
    const mapping = mapHeaders(["Organisation"], IMPORT_ENTITIES.companies.columns);
    expect(mapping.assignments.find((a) => a.field === "name")?.index).toBe(0);
    expect(mapping.missingRequired).toEqual([]);
  });

  /**
   * 🔴 A HEADER ROW THAT DOES NOT MATCH IS REFUSED BEFORE ANY ROW IS
   * READ. Continuing would produce a thousand identical "name is
   * required" row errors, which reads like a thousand bad rows rather
   * than one bad header and buries the sentence that would fix it.
   */
  it("refuses the whole file when a required column is absent", () => {
    const plan = planImport(
      IMPORT_ENTITIES.companies,
      "Nickname,Town\nAcme,Pune\nBeta,Delhi", IMPORT_CONTEXT,
    );
    expect(plan.fatal).not.toBeNull();
    expect(plan.rows).toHaveLength(0);
    expect(plan.fatal).toContain("Name");
    // ⚠️ AND IT PRINTS WHAT THE FILE DID HAVE. "Missing column: Name" is
    // useless to somebody looking at a file that plainly has names in it.
    expect(plan.fatal).toContain("Nickname");
  });

  /**
   * ⚠️ AN UNMAPPED COLUMN IS THE ONE FAILURE THAT LEAVES NO TRACE IN ANY
   * ROW. The import succeeds completely while discarding every value in
   * it, so it has to be reported explicitly or it is invisible.
   */
  it("reports columns nothing claimed rather than silently dropping them", () => {
    const plan = planImport(
      IMPORT_ENTITIES.companies,
      "Name,Favourite colour\nAcme,blue", IMPORT_CONTEXT,
    );
    expect(plan.fatal).toBeNull();
    expect(plan.unrecognisedHeaders).toEqual(["Favourite colour"]);
  });

  /** The error column of a failed-rows file re-uploads harmlessly. */
  it("treats the error column of a re-uploaded failed-rows file as ignorable", () => {
    const plan = planImport(
      IMPORT_ENTITIES.companies,
      "Name,What was wrong with this row\nAcme,Name: required", IMPORT_CONTEXT,
    );
    expect(plan.fatal).toBeNull();
    expect(plan.rows[0]?.errors).toEqual([]);
  });
});

/* ================================================================== */
/* ③ MONEY AND THE OTHER COERCIONS — CONSTRAINT 4                      */
/* ================================================================== */

describe("money", () => {
  /**
   * 🔴 `Math.round(Number("1.005") * 100)` IS 100, NOT 101, because
   * `1.005 * 100` is `100.49999999999999`. Every amount ending in half a
   * paisa is a paisa out, and the error only surfaces as a reconciliation
   * that fails by a few rupees across ten thousand rows.
   */
  it("the float version would have been wrong", () => {
    expect(Math.round(Number("1.005") * 100)).toBe(100);
    expect(coerceMoneyMinor("1.005", 2)).toEqual({ ok: false, message: expect.any(String) });
    // Two decimal places is the limit; 1.01 is unambiguous and exact.
    expect(coerceMoneyMinor("1.01", 2)).toEqual({ ok: true, value: "101" });
  });

  it("parses the string rather than multiplying a float", () => {
    expect(coerceMoneyMinor("1250.50", 2)).toEqual({ ok: true, value: "125050" });
    expect(coerceMoneyMinor("0.01", 2)).toEqual({ ok: true, value: "1" });
    expect(coerceMoneyMinor("12345", 2)).toEqual({ ok: true, value: "1234500" });
    expect(coerceMoneyMinor("1.1", 2)).toEqual({ ok: true, value: "110" });
    expect(coerceMoneyMinor("-99.99", 2)).toEqual({ ok: true, value: "-9999" });
  });

  /** Large enough that `Number` would already have lost digits. */
  it("survives an amount beyond the safe-integer range", () => {
    expect(coerceMoneyMinor("999999999999.99", 2)).toEqual({
      ok: true,
      value: "99999999999999",
    });
  });

  it("accepts what a spreadsheet actually writes", () => {
    expect(coerceMoneyMinor("1,250.50", 2)).toEqual({ ok: true, value: "125050" });
    expect(coerceMoneyMinor("₹1,250.50", 2)).toEqual({ ok: true, value: "125050" });
  });

  it("returns a string, because a bigint cannot cross to the browser", () => {
    const result = coerceMoneyMinor("10.00", 2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(typeof result.value).toBe("string");
    // The failure this prevents, demonstrated.
    expect(() => JSON.stringify({ amount: 1000n })).toThrow();
  });

  /** The multiplication is forbidden in source, not merely avoided. */
  it("never multiplies by 100", () => {
    const code = codeOnly(VALUES);
    expect(code).not.toContain("Math.round(Number");
    expect(code).not.toMatch(/parseFloat\([^)]*\)\s*\*\s*100/);
    expect(code).not.toMatch(/Number\([^)]*\)\s*\*\s*100/);
    expect(code).toContain("BigInt(whole) * scale");
  });

  it("blank is nothing supplied, not zero", () => {
    expect(coerceMoneyMinor("", 2)).toEqual({ ok: true, value: null });
    expect(coerceMoneyMinor("   ", 2)).toEqual({ ok: true, value: null });
  });
});

describe("the other coercions", () => {
  it("refuses a number Number() would have accepted", () => {
    expect(coerceInteger("12abc").ok).toBe(false);
    expect(coerceInteger("1e3").ok).toBe(false);
    expect(coerceInteger("").ok).toBe(true); // null, not 0
    expect(coerceInteger("1,200")).toEqual({ ok: true, value: 1200 });
  });

  /**
   * 🔴 DD/MM/YYYY IS REFUSED RATHER THAN GUESSED. `01/02/2026` is 2
   * January in India and 1 February in the United States, and on a
   * `gst_parties` row `effective_from` decides whether a supply was
   * reported B2B or B2C.
   */
  it("refuses an ambiguous date instead of picking a reading", () => {
    expect(coerceCivilDay("01/02/2026").ok).toBe(false);
    expect(coerceCivilDay("2026-04-01")).toEqual({ ok: true, value: "2026-04-01" });
    // A shape check is not a calendar check.
    expect(coerceCivilDay("2026-02-31").ok).toBe(false);
  });

  it("accepts the several ways a spreadsheet writes a yes", () => {
    expect(coerceBoolean("TRUE")).toEqual({ ok: true, value: true });
    expect(coerceBoolean("Yes")).toEqual({ ok: true, value: true });
    expect(coerceBoolean("0")).toEqual({ ok: true, value: false });
    // But a blank is "not supplied" — defaulting it to false would
    // silently deactivate records.
    expect(coerceBoolean("")).toEqual({ ok: true, value: null });
    expect(coerceBoolean("maybe").ok).toBe(false);
  });

  it("matches an enum on wording and returns the canonical value", () => {
    expect(coerceEnum("Immovable Property", ["immovable_property"])).toEqual({
      ok: true,
      value: "immovable_property",
    });
    const bad = coerceEnum("nonsense", ["customer", "vendor"]);
    expect(bad.ok).toBe(false);
    // ⚠️ The message lists the vocabulary rather than saying "invalid".
    if (!bad.ok) expect(bad.message).toContain("customer, vendor");
  });
});

/* ================================================================== */
/* ④ ONE VALIDATION PATH — CONSTRAINT 1                                */
/* ================================================================== */

describe("the dry run is the real run", () => {
  /**
   * 🔴 THE STRUCTURAL GUARANTEE. `previewImport` and `commitImport` are
   * two wrappers over ONE function that branches on `mode` exactly once,
   * below every decision. If a second validation entry point ever
   * appears, this is what fails.
   */
  it("both actions delegate to the same runner", () => {
    const code = codeOnly(ACTIONS);
    expect(code).toContain('return runImport(input, "preview")');
    expect(code).toContain('return runImport(input, "commit")');
    /*
     * ⚠️ TWO PLANNERS SINCE WAVE 6 AND STILL ONE DECISION LAYER.
     * `planImport` parses CSV text and then calls `planImportRecords`;
     * a spreadsheet, a JSON export and a Tally day book arrive as records
     * already. Both land in the same planner, so mapping, coercion,
     * validation and de-duplication are shared — which is the property
     * this test is actually protecting.
     */
    expect(code.match(/planImport\(/g) ?? []).toHaveLength(1);
    expect(code.match(/planImportRecords\(/g) ?? []).toHaveLength(1);

    /*
     * ⭐ THREE READS OF `mode` SINCE WAVE 6, AND THE THIRD IS THE POINT
     * OF THIS ASSERTION RATHER THAN A VIOLATION OF IT: the audit entry,
     * the chunk record, and nothing else. Every one of them is on the
     * WRITE side, below every decision — a fourth appearing above the
     * planner is what this is watching for.
     */
    const modeReads = code.match(/mode === "commit"/g) ?? [];
    expect(modeReads).toHaveLength(3);
    const plannerAt = code.indexOf("planImportRecords(entity, params.records, planContext)");
    for (const index of [...code.matchAll(/mode === "commit"/g)].map((m) => m.index ?? 0)) {
      expect(index).toBeGreaterThan(plannerAt);
    }
  });

  /**
   * ⚠️ `planImport` MUST NOT TAKE A "QUICK" FLAG. The way a dry run drifts
   * from a real run is never a decision to write two validators; it is a
   * parameter added so the preview can "skip the expensive checks".
   */
  it("the planner has no mode, depth or skip argument", () => {
    const code = codeOnly(PLAN);
    expect(code).toContain("export function planImport(\n  entity: ImportEntityDefinition,\n  csvText: string,\n  context: ImportContext,\n): ImportPlan");
    expect(code).not.toMatch(/skipValidation|quick|shallow|dryRun\b/i);
  });

  /**
   * 🔴 THE EXISTING-ROW LOOKUP IS SHARED TOO. A preview that guessed at
   * de-duplication would report creations that turn into updates — the
   * same drift, one layer down.
   */
  it("the existing-record lookup runs for both, from one call site", () => {
    const code = codeOnly(ACTIONS);
    expect(code.match(/findExistingByNaturalKey\(/g) ?? []).toHaveLength(2); // definition + call
  });

  /** The entity's own schema, not a copy written for the importer. */
  it("validates through the same schema the single-record actions parse", () => {
    expect(codeOnly(ENTITIES)).toContain("createCompanySchema");
    expect(codeOnly(ENTITIES)).toContain("upsertPartySchema");
    expect(IMPORT_ENTITIES.companies.schema).toBeDefined();
    expect(IMPORT_ENTITIES["gst-parties"].schema).toBeDefined();
  });

  /**
   * ⭐ AND THE RULE IS DEMONSTRATED, not just asserted structurally. A
   * `regular` party with no GSTIN is refused by `upsertPartySchema`'s
   * `.superRefine()` — the rule that stops a B2B supply being reported as
   * B2C, which costs the buyer input credit they were entitled to.
   */
  it("a GST party import cannot bypass the registration/GSTIN rule", () => {
    const plan = planImport(
      IMPORT_ENTITIES["gst-parties"],
      [
        "Customer or vendor,Legal name,GSTIN,Registration type,Effective from",
        "customer,Acme Traders,,regular,2026-04-01",
      ].join("\n"), IMPORT_CONTEXT,
    );
    expect(plan.fatal).toBeNull();
    expect(plan.rows[0]?.errors.length).toBeGreaterThan(0);
    expect(plan.rows[0]?.errors[0]?.message).toContain("GSTIN");
  });

  /** And a valid one goes through, so the refusal above means something. */
  it("accepts a well-formed GST party and folds the address into one object", () => {
    const plan = planImport(
      IMPORT_ENTITIES["gst-parties"],
      [
        "Customer or vendor,Legal name,GSTIN,Registration type,Effective from,City,PIN code",
        "Customer,Acme Traders,27AAPFU0939F1ZV,Regular,2026-04-01,Pune,411001",
      ].join("\n"), IMPORT_CONTEXT,
    );
    expect(plan.rows[0]?.errors).toEqual([]);
    const payload = plan.rows[0]?.payload as Record<string, unknown>;
    expect(payload.partyType).toBe("customer");
    expect(payload.registrationType).toBe("regular");
    // Six flat CSV columns became one jsonb-shaped object.
    expect(payload.address).toEqual({ city: "Pune", postalCode: "411001" });
  });

  /**
   * ⚠️ AND THE ADDRESS IS ABSENT, NOT `{}`, WHEN NO PART IS GIVEN. `{}` on
   * an update would erase an address already on the record, so importing
   * a file with no address columns would delete addresses.
   */
  it("omits the address entirely when the file has none", () => {
    const plan = planImport(
      IMPORT_ENTITIES["gst-parties"],
      [
        "Customer or vendor,Legal name,GSTIN,Registration type,Effective from",
        "customer,Acme Traders,27AAPFU0939F1ZV,regular,2026-04-01",
      ].join("\n"), IMPORT_CONTEXT,
    );
    const payload = plan.rows[0]?.payload as Record<string, unknown>;
    // Absent, not `{}` — and `{}` is what an over-eager `buildPayload`
    // would have produced.
    expect(payload.address).toBeUndefined();
    expect("address" in payload).toBe(false);
  });
});

/* ================================================================== */
/* ⑤ PARTIAL SUCCESS, AND GETTING THE ROWS BACK — CONSTRAINT 2         */
/* ================================================================== */

describe("partial success", () => {
  const MIXED = [
    "Name,Domain,Employees",
    "Acme Traders,acme.example,12",
    ",nameless.example,4", // no name — the required field
    "Beta Works,beta.example,not-a-number",
    "Gamma Ltd,gamma.example,7",
  ].join("\n");

  it("good rows survive alongside bad ones", () => {
    const plan = planImport(IMPORT_ENTITIES.companies, MIXED, IMPORT_CONTEXT);
    expect(plan.fatal).toBeNull();
    expect(plan.rows).toHaveLength(4);
    expect(plan.rows.filter((r) => r.errors.length === 0)).toHaveLength(2);
    expect(plan.rows.filter((r) => r.errors.length > 0)).toHaveLength(2);
  });

  /**
   * 🔴 THE ROWS COME BACK. An import that reports "100 errors" without
   * giving the rows back creates a task nobody can complete: the customer
   * has a 1000-row file, 900 of which are already in, and no way to tell
   * which 100 are not.
   */
  it("hands the failed rows back as a CSV with their original columns", () => {
    const plan = planImport(IMPORT_ENTITIES.companies, MIXED, IMPORT_CONTEXT);
    const report = buildReport(IMPORT_ENTITIES.companies, plan, {
      mode: "preview",
      duplicateMode: "skip",
      outcomes: new Map(
        plan.rows
          .filter((r) => r.errors.length === 0)
          .map((r) => [r.recordNumber, { disposition: "create" as const }]),
      ),
    });

    expect(report.counts.create).toBe(2);
    expect(report.counts.error).toBe(2);
    expect(report.failedRowsCsv).not.toBeNull();

    const csv = report.failedRowsCsv ?? "";
    // The customer's own headings, in their order, plus one appended.
    expect(csv.split("\r\n")[0]).toBe(
      "Name,Domain,Employees,What was wrong with this row",
    );
    // Only the failures, with their original values.
    expect(csv).toContain("nameless.example");
    expect(csv).toContain("Beta Works");
    expect(csv).not.toContain("Acme Traders");
    expect(csv).not.toContain("Gamma Ltd");
    // And a reason on each.
    expect(csv).toContain("not a whole number");
  });

  /** ⚠️ Every reason, not the first — otherwise fixing one reveals another. */
  it("puts every reason for a row on that row", () => {
    const csv = buildFailedRowsCsv(["Name", "Date"], [
      {
        cells: ["Acme", "01/02/2026"],
        errors: [
          { column: "Name", message: "too long." },
          { column: "Date", message: "not a date." },
        ],
      },
    ]);
    expect(csv).toContain("Name: too long.");
    expect(csv).toContain("Date: not a date.");
  });

  /**
   * ⚠️ THE FAILED-ROWS FILE IS ITSELF A VALID IMPORT FILE. If it were
   * not, the loop the whole constraint exists for does not close.
   */
  it("the failed-rows file can be fixed and imported again", () => {
    const plan = planImport(IMPORT_ENTITIES.companies, MIXED, IMPORT_CONTEXT);
    const report = buildReport(IMPORT_ENTITIES.companies, plan, {
      mode: "preview",
      duplicateMode: "skip",
      outcomes: new Map(
        plan.rows
          .filter((r) => r.errors.length === 0)
          .map((r) => [r.recordNumber, { disposition: "create" as const }]),
      ),
    });
    // Fix the one thing wrong with each row and re-plan the same file.
    const fixed = (report.failedRowsCsv ?? "")
      .replace("\r\n,nameless.example", "\r\nNameless Ltd,nameless.example")
      .replace("not-a-number", "9");
    const second = planImport(IMPORT_ENTITIES.companies, fixed, IMPORT_CONTEXT);
    expect(second.fatal).toBeNull();
    expect(second.rows.filter((r) => r.errors.length > 0)).toHaveLength(0);
  });

  /**
   * ⚠️ FAILURES ARE NEVER TRUNCATED; SUCCESSES ARE SAMPLED. The failures
   * are the actionable half of the screen.
   */
  it("reports every failure and only a sample of the successes", () => {
    const rows = ["Name"];
    for (let i = 0; i < 60; i += 1) rows.push(`Company ${i}`);
    for (let i = 0; i < 30; i += 1) rows.push(`"${"x".repeat(300)}"`);
    const plan = planImport(IMPORT_ENTITIES.companies, rows.join("\n"), IMPORT_CONTEXT);
    const report = buildReport(IMPORT_ENTITIES.companies, plan, {
      mode: "commit",
      duplicateMode: "skip",
      outcomes: new Map(
        plan.rows
          .filter((r) => r.errors.length === 0)
          .map((r) => [r.recordNumber, { disposition: "create" as const }]),
      ),
    });
    expect(report.counts.create).toBe(60);
    expect(report.counts.error).toBe(30);
    expect(report.rows.filter((r) => r.disposition === "error")).toHaveLength(30);
    expect(report.rows.filter((r) => r.disposition !== "error").length).toBeLessThan(60);
  });

  /** And the screen says both halves out loud. */
  it("the report panel states that the rest went in", () => {
    const panel = read("components/settings/import-report-panel.tsx");
    expect(panel).toContain("went in");
    expect(panel).toContain("Download failed rows");
    expect(panel).toContain("a partly-successful import is the normal outcome");
    expect(PAGE).toContain("Rows that fail do not stop the ones that work");
  });
});

/* ================================================================== */
/* ⑥ RE-RUNNING MUST NOT DOUBLE THE DATA — CONSTRAINT 3                */
/* ================================================================== */

describe("re-running an import", () => {
  /**
   * 🔴 THE NATURAL KEY IS NOT OPTIONAL. Without one, the second upload of
   * the same file — the normal action after fixing a few rows — creates
   * 900 duplicate companies.
   */
  it("every entity declares one", () => {
    for (const entity of Object.values(IMPORT_ENTITIES)) {
      expect(typeof entity.naturalKey).toBe("function");
    }
  });

  /** Companies: domain first, name only where there is no domain. */
  it("keys a company on its domain, falling back to its name", () => {
    const withDomain = IMPORT_ENTITIES.companies.naturalKey({
      name: "Acme Traders",
      domain: "ACME.example",
    });
    expect(withDomain).toEqual({
      kind: "domain",
      value: "acme.example",
      label: "domain acme.example",
    });

    const without = IMPORT_ENTITIES.companies.naturalKey({
      name: "  Acme   Traders ",
      domain: null,
    });
    expect(without?.kind).toBe("name");
    expect(without?.value).toBe("acme traders");
  });

  /**
   * ⚠️ `kind` IS PART OF THE COMPARISON. A company NAMED `ordence.com`
   * must not match a company whose DOMAIN is `ordence.com`.
   */
  it("does not let a name collide with a domain", () => {
    const byName = IMPORT_ENTITIES.companies.naturalKey({ name: "acme.example" });
    const byDomain = IMPORT_ENTITIES.companies.naturalKey({
      name: "Acme",
      domain: "acme.example",
    });
    expect(byName?.value).toBe(byDomain?.value);
    expect(byName?.kind).not.toBe(byDomain?.kind);
  });

  /**
   * 🔴 A GST PARTY IS KEYED ON `(party_type, gstin)` — the composite the
   * database's own partial unique index uses. The same firm can be a
   * customer and a vendor at once; keying on the GSTIN alone would make
   * those two rows look like duplicates of each other.
   */
  it("keys a GST party on the GSTIN AND the direction", () => {
    const asCustomer = IMPORT_ENTITIES["gst-parties"].naturalKey({
      partyType: "customer",
      gstin: "27AAPFU0939F1ZV",
      legalName: "Acme",
    });
    const asVendor = IMPORT_ENTITIES["gst-parties"].naturalKey({
      partyType: "vendor",
      gstin: "27AAPFU0939F1ZV",
      legalName: "Acme",
    });
    expect(asCustomer?.value).not.toBe(asVendor?.value);
    expect(asCustomer?.value).toContain("27AAPFU0939F1ZV");
  });

  /**
   * ⚠️ IN-FILE DUPLICATES ARE CAUGHT BY THE PURE LAYER, not left to the
   * database. Left alone the outcome depends on the duplicate mode in a
   * way nobody would predict — which of two conflicting rows "wins" would
   * be decided by their order in a spreadsheet.
   */
  it("refuses the second of two rows for the same record, naming the first", () => {
    const plan = planImport(
      IMPORT_ENTITIES.companies,
      ["Name,Domain", "Acme Traders,acme.example", "Acme Trading,acme.example"].join("\n"), IMPORT_CONTEXT,
    );
    expect(plan.rows[0]?.errors).toEqual([]);
    expect(plan.rows[1]?.errors).toHaveLength(1);
    expect(plan.rows[1]?.errors[0]?.message).toContain("row 2");
  });

  /**
   * 🔴 THE CHOICE IS MADE BEFORE THE RUN AND HAS NO DEFAULT. A
   * `.default("skip")` reads as a kindness and is the mechanism by which
   * the decision stops being made.
   */
  it("the duplicate mode is required, on the server and in the wizard", () => {
    const code = codeOnly(ACTIONS);
    expect(code).toContain('z.enum(["skip", "update", "fail"]');
    expect(code).not.toMatch(/duplicateMode[\s\S]{0,120}\.default\(/);

    const wizard = codeOnly(WIZARD);
    expect(wizard).toContain("useState<DuplicateMode | null>(null)");
    // Nothing pre-ticked, and the run refuses without an answer.
    expect(wizard).toContain("if (!duplicateMode)");
  });

  /**
   * ⚠️ AND THE WEAK MATCH IS DISCLOSED. Two different businesses can
   * share a name, so an `update` keyed on a name can overwrite the wrong
   * record. Saying so on the screen, before the run, is the only moment
   * saying it is any use.
   */
  it("the wizard names the key and warns about the name fallback", () => {
    expect(WIZARD).toContain("same GSTIN");
    expect(WIZARD).toContain("same domain");
    expect(WIZARD).toContain("Two different businesses can share a name");
    expect(WIZARD).toContain("running the same file twice will not double your data");
  });
});

/* ================================================================== */
/* ⑦ EVERY EXPORT IS A URL — CONSTRAINT 5                              */
/* ================================================================== */

describe("the server actions", () => {
  /**
   * 🔴 A `"use server"` EXPORT IS A BROWSER-REACHABLE ENDPOINT. That is
   * as true of the preview as of the commit — and the preview is not even
   * free of disclosure, because it reports which natural keys in an
   * uploaded file already exist in the workspace.
   */
  it("guards both exports with the full four-gate stack", () => {
    const code = codeOnly(ACTIONS);
    expect(code).toContain("requireTenantContext()");
    expect(code).toContain("requireAccess(");
    expect(code).toContain('requireFeature("crm.bulk_import"');
    expect(code).toContain("requirePermission(entity.createPermission)");
    /*
     * ⚠️ ONE GUARD FUNCTION, AND SINCE WAVE 6 TWO CALLERS: `runImport`,
     * which both exports go through, and `beginImportRun`, which opens a
     * migration. Three occurrences = the definition plus those two.
     *
     * 🔴 THE ASSERTION IS ON THE CALLERS, NOT THE COUNT, because a raw
     * count is a number somebody bumps when it fails. This names them.
     */
    expect(code.match(/guardImport\(/g) ?? []).toHaveLength(3);
    expect(code).toMatch(/const ctx = await guardImport\(entity, params\.duplicateMode\)/);
    expect(code).toContain("async function guardImport(");
  });

  /**
   * ⚠️ THE UPDATE PERMISSION IS A SEPARATE CHECK, IN `update` MODE ONLY.
   * Choosing "overwrite" turns an import into a mass edit of existing
   * master data, and that is not the same act as adding new records.
   */
  it("asks for the update permission only when overwriting", () => {
    const code = codeOnly(ACTIONS);
    expect(code).toContain('if (duplicateMode === "update")');
    expect(code).toContain("requirePermission(entity.updatePermission)");
  });

  /** ⚠️ Nothing but async functions may be exported from a "use server" file. */
  it("exports only async functions", () => {
    const exported = [...codeOnly(ACTION_FILE_ONLY).matchAll(/^export\s+(\w+)/gm)].map((m) => m[1]);
    for (const keyword of exported) {
      expect(["async", "type"]).toContain(keyword);
    }
  });

  /** The entity is chosen from an allowlist, never resolved from a string. */
  it("refuses an entity that is not in the allowlist", () => {
    expect(isImportEntityKey("companies")).toBe(true);
    expect(isImportEntityKey("users")).toBe(false);
    expect(isImportEntityKey("constructor")).toBe(false);
    expect(isImportEntityKey("__proto__")).toBe(false);
    expect(codeOnly(ACTIONS)).toContain("isImportEntityKey(params.entity)");
  });

  /** ⚠️ Tenant scope is the database's, via `withTenant`, not a WHERE alone. */
  it("reads and writes inside withTenant", () => {
    const code = codeOnly(ACTIONS);
    expect(code).toContain("withTenant(ctx.tenant.id");
    expect(code).toContain("eq(companies.tenantId, ctx.tenant.id)");
    expect(code).toContain("eq(gstParties.tenantId, ctx.tenant.id)");
  });
});

/* ================================================================== */
/* ⑧ IT IS A FRAMEWORK, AND IT IS REACHABLE                            */
/* ================================================================== */

describe("the framework", () => {
  /**
   * ⚠️ `lib/import/` MUST NOT TOUCH THE DATABASE. That is what lets the
   * same decision code run on the server during a commit and in the
   * browser when the wizard builds a template — and it is what makes
   * constraint 1 checkable without Postgres.
   */
  it("the pure layer imports no database and no node APIs", () => {
    for (const file of [
      "lib/import/csv.ts",
      "lib/import/values.ts",
      "lib/import/mapping.ts",
      "lib/import/plan.ts",
      "lib/import/report.ts",
      "lib/import/entities.ts",
      "lib/import/types.ts",
    ]) {
      const code = codeOnly(read(file));
      expect(code, file).not.toMatch(/from "@\/db"/);
      expect(code, file).not.toMatch(/from "@\/server\//);
      expect(code, file).not.toMatch(/from "node:/);
      expect(code, file).not.toContain("server-only");

      /*
       * ⚠️ A `@/db/schema` import is allowed ONLY as `import type`, which
       * is erased at compile time. A value import of the same module
       * would pull the Drizzle table objects — and through them the
       * database client — into the browser bundle, which is exactly the
       * separation the string discriminant in `ImportTableKey` exists to
       * preserve.
       */
      for (const match of code.matchAll(/^import\s+(type\s+)?[^;]*?from "(@\/db[^"]*)"/gm)) {
        expect(match[1], `${file} imports ${match[2]} as a value`).toBe("type ");
      }
    }
  });

  /** Two entities, so the abstraction is proved rather than asserted. */
  it("supports more than one entity, with no per-entity code path", () => {
    expect(Object.keys(IMPORT_ENTITIES).length).toBeGreaterThanOrEqual(2);
    // The planner never asks which entity it has.
    const code = codeOnly(PLAN);
    expect(code).not.toContain("companies");
    expect(code).not.toContain("gstParties");
  });

  it("builds a blank template from the same column list it maps against", () => {
    const template = buildTemplateCsv(IMPORT_ENTITIES.companies.columns);
    expect(template.startsWith("Name,Domain,")).toBe(true);
    expect(template.endsWith("\r\n")).toBe(true);
    // And that template round-trips into a valid, empty plan.
    const mapping = mapHeaders(
      template.trim().split(","),
      IMPORT_ENTITIES.companies.columns,
    );
    expect(mapping.missingRequired).toEqual([]);
    expect(mapping.unrecognisedHeaders).toEqual([]);
  });

  /** ⚠️ Capped, and the refusal explains the split rather than truncating. */
  it("refuses a file beyond the row cap instead of importing part of it", () => {
    const rows = ["Name"];
    for (let i = 0; i <= MAX_IMPORT_ROWS; i += 1) rows.push(`Company ${i}`);
    const plan = planImport(IMPORT_ENTITIES.companies, rows.join("\n"), IMPORT_CONTEXT);
    expect(plan.fatal).toContain(String(MAX_IMPORT_ROWS));
    expect(plan.rows).toHaveLength(0);
  });

  /** It exists, it is wired to the actions, and it is in the tab strip. */
  it("is reachable without typing a URL", () => {
    expect(codeOnly(PAGE)).toContain("previewImport");
    expect(codeOnly(PAGE)).toContain("commitImport");
    expect(codeOnly(PAGE)).toContain("ImportWizard");
    expect(codeOnly(read("app/(crm)/settings/settings-tabs.tsx"))).toContain(
      '"/settings/import"',
    );
  });

  /**
   * ⚠️ NO CSV DEPENDENCY WAS ADDED. A parser that handles quoted fields,
   * embedded commas and embedded newlines is a state machine over a
   * string with a specification that has not changed since 2005; the
   * deploy is the fragile part of this project and every dependency is a
   * way for `npm ci` to fail.
   */
  it("added no CSV library", () => {
    const pkg = JSON.parse(read("package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const name of ["papaparse", "csv-parse", "csv-parser", "fast-csv", "neat-csv"]) {
      expect(all[name]).toBeUndefined();
    }
  });
});
