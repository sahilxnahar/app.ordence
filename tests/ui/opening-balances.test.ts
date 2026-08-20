/**
 * Ordence — ⭐⭐ BATCH 58: THE DAY-ONE POSITION CAN BE ENTERED
 * Version: v1.58.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 A BUSINESS SWITCHING MID-YEAR HAD NOWHERE TO PUT WHAT IT WAS
 *    CARRYING
 * ══════════════════════════════════════════════════════════════════════
 * A trial balance, unpaid customer invoices, unpaid vendor bills and
 * stock on the shelf. With no way to enter any of it, the first balance
 * sheet Ordence produced said the company had no bank balance, no
 * debtors, no creditors and no capital — and said so for the rest of the
 * company's life, because an opening position is not a figure that can be
 * corrected later without restating everything computed from it.
 *
 * ⚠️ WHAT THIS SUITE IS ACTUALLY FOR. Four properties, each of which
 * fails silently if it is wrong:
 *
 *   1. An opening trial balance that does not balance is REFUSED, and no
 *      suspense account is invented for the customer.
 *   2. The position posts as a REAL JOURNAL ENTRY, dated at a day the
 *      customer entered, not stored as a magic number beside the ledger.
 *   3. Entering it TWICE does not double the books, and the key is named.
 *   4. The dry run and the real run remain ONE code path — including the
 *      account and customer lookups Batch 58 added, which are the newest
 *      and easiest place for them to drift apart.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { planImport } from "@/lib/import/plan";
import { buildReport, buildTemplateCsv } from "@/lib/import/report";
import { parseCsv } from "@/lib/import/csv";
import { mapHeaders } from "@/lib/import/mapping";
import { isImportEntityKey, ALL_IMPORT_ENTITIES } from "@/lib/import/entities";
import {
  OPENING_IMPORT_ENTITIES,
  OPENING_IMPORT_ENTITY_KEYS,
} from "@/lib/import/opening-entities";
import {
  coerceQuantityThousandths,
  describeImbalance,
  openingBatchKey,
  rupeesOf,
  totalTrialBalance,
} from "@/lib/import/opening";
import { PERMISSION_CATALOG } from "@/db/schema/auth";

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
const PLAN = read("lib/import/plan.ts");
const OPENING = read("lib/import/opening.ts");
const OPENING_ENTITIES = read("lib/import/opening-entities.ts");
const OPENING_SCHEMAS = read("lib/import/opening-schemas.ts");
const WIZARD = read("components/import/opening-balance-wizard.tsx");
const PAGE = read("app/(crm)/settings/opening-balances/page.tsx");
const IMPORT_PAGE = read("app/(crm)/settings/import/page.tsx");

/**
 * ⚠️ COMMENTS **AND STRING LITERALS** BLANKED, WHICH IS STRICTER THAN THE
 * HELPER IN `tests/ui/csv-import.test.ts` AND HAS TO BE.
 *
 * Every assertion below that claims a piece of code is ABSENT reads this
 * rather than the raw file. The reason is specific to this batch: the
 * central decision is that NO SUSPENSE ACCOUNT IS CREATED, and the
 * refusal message explains that decision by using the word "suspense"
 * four times. A comment-only stripper would find the word and fail the
 * test that proves the behaviour it describes.
 *
 * Presence assertions read the RAW source, because that is where the
 * strings live.
 */
const commentsOnly = (s: string) =>
  s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));

const codeOnly = (s: string) =>
  s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/`(?:\\.|[^`\\])*`/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/"(?:\\.|[^"\\\n])*"/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/'(?:\\.|[^'\\\n])*'/g, (m) => m.replace(/[^\n]/g, " "));

const TRIAL_BALANCE = OPENING_IMPORT_ENTITIES["opening-trial-balance"];
const INVOICES = OPENING_IMPORT_ENTITIES["opening-customer-invoices"];
const BILLS = OPENING_IMPORT_ENTITIES["opening-vendor-bills"];
const STOCK = OPENING_IMPORT_ENTITIES["opening-stock"];

const BALANCED = [
  "Account code,Account name,As at,Debit,Credit",
  "1100,Bank,2026-03-31,500000.00,",
  "2100,Sundry Creditors,2026-03-31,,300000.00",
  "3100,Capital,2026-03-31,,200000.00",
].join("\n");

/* ================================================================== */
/* ① 🔴 IT MUST BALANCE, AND THERE IS NO PLUG                          */
/* ================================================================== */

describe("an opening trial balance that does not balance", () => {
  const OUT_BY_FIFTY_PAISE = [
    "Account code,Account name,As at,Debit,Credit",
    "1100,Bank,2026-03-31,500000.00,",
    "2100,Sundry Creditors,2026-03-31,,300000.00",
    "3100,Capital,2026-03-31,,200000.50",
  ].join("\n");

  /**
   * 🔴 THE HEADLINE RULE. Fifty paise is the size of difference that
   * looks like a rounding artefact and is not — it means one of these
   * balances is wrong, and the account it is wrong on is a real one.
   */
  it("is refused outright rather than imported", () => {
    const plan = planImport(TRIAL_BALANCE, OUT_BY_FIFTY_PAISE);
    expect(plan.fatal).not.toBeNull();
    // Nothing may be written: the server writes only rows, and there are none.
    expect(plan.rows).toHaveLength(0);
  });

  /**
   * ⭐ THE MESSAGE CARRIES THE ARITHMETIC. "Does not balance" is a
   * refusal nobody can act on; the difference in rupees and which side is
   * short is the whole of what is needed to find it.
   */
  it("says how much it is out by and which side is short", () => {
    const plan = planImport(TRIAL_BALANCE, OUT_BY_FIFTY_PAISE);
    expect(plan.fatal).toContain("0.50");
    expect(plan.fatal).toContain("debit");
    expect(plan.fatal).toContain("500000.00");
  });

  /**
   * 🔴🔴 NO SUSPENSE ACCOUNT IS CREATED, ANYWHERE. A plug booked silently
   * has no owner and no due date: it sits on the balance sheet under a
   * name nobody recognises until an auditor asks, by which time the
   * person who did the migration has gone and the spreadsheet with it.
   *
   * ⚠️ READ FROM COMMENT- AND STRING-STRIPPED SOURCE, because the refusal
   * message explains the decision using the word itself.
   */
  it("creates no suspense account behind the customer's back", () => {
    for (const [name, source] of [
      ["server/actions/import.ts", ACTIONS],
      ["lib/import/opening.ts", OPENING],
      ["lib/import/opening-entities.ts", OPENING_ENTITIES],
      ["lib/import/opening-schemas.ts", OPENING_SCHEMAS],
    ] as const) {
      expect(codeOnly(source).toLowerCase(), name).not.toContain("suspense");
      expect(codeOnly(source).toLowerCase(), name).not.toContain("roundoff");
      expect(codeOnly(source).toLowerCase(), name).not.toContain("balancing");
    }
  });

  /**
   * ⚠️ AND THE SCREEN SAYS SO BEFORE THE UPLOAD, not after the refusal.
   * A customer who believes a plug will be created writes a file that
   * relies on one.
   */
  it("is stated on the screen before anything is uploaded", () => {
    expect(WIZARD).toContain("no suspense account is created for you");
    expect(WIZARD).toContain("goes in whole or not at all");
    expect(PAGE).toContain("A trial balance that does not balance is refused.");
  });

  /**
   * ⚠️ A ZERO LINE IS REFUSED ON ITS OWN, because an account with nothing
   * brought forward does not need a row, and a ₹0.00 journal leg clutters
   * that account's statement forever while being indistinguishable from a
   * balance somebody meant to type and did not.
   */
  it("refuses a line worth nothing on either side", () => {
    const plan = planImport(
      TRIAL_BALANCE,
      [
        "Account code,As at,Debit,Credit",
        "1100,2026-03-31,0.00,",
        "2100,2026-03-31,,0.00",
      ].join("\n"),
    );
    for (const row of plan.rows) expect(row.errors.length).toBeGreaterThan(0);
  });

  /**
   * 🔴 AND A FILE THAT ADDS UP TO NOTHING ON BOTH SIDES *BALANCES*. It is
   * not an opening position — it is a file whose amount columns did not
   * map, which would otherwise post an empty journal entry and report
   * success. Asserted against the rule itself, because a file that
   * reaches it has already had every zero line refused above.
   */
  it("refuses a file that adds up to nothing on both sides", () => {
    expect(TRIAL_BALANCE.fileRule?.([])).toContain("adds up to nothing");
  });

  /** Two as-at dates are two opening positions, and one of them is wrong. */
  it("refuses a file whose rows are as at different days", () => {
    const plan = planImport(
      TRIAL_BALANCE,
      [
        "Account code,As at,Debit,Credit",
        "1100,2026-03-31,500000.00,",
        "3100,2026-04-01,,500000.00",
      ].join("\n"),
    );
    expect(plan.fatal).toContain("2026-03-31");
    expect(plan.fatal).toContain("2026-04-01");
  });
});

describe("a trial balance that does balance", () => {
  it("plans every line with no errors", () => {
    const plan = planImport(TRIAL_BALANCE, BALANCED);
    expect(plan.fatal).toBeNull();
    expect(plan.rows).toHaveLength(3);
    for (const row of plan.rows) expect(row.errors).toEqual([]);
  });

  /**
   * 🔴 THE ARITHMETIC IS `BigInt` ALL THE WAY. A balance sheet total for
   * a company of any size runs past 2^53 paise, and `Number` would lose
   * digits from the end of it without raising anything.
   */
  it("adds up amounts far beyond the safe-integer range", () => {
    const huge = [
      "Account code,As at,Debit,Credit",
      "1100,2026-03-31,999999999999999.99,",
      "3100,2026-03-31,,999999999999999.99",
    ].join("\n");
    const plan = planImport(TRIAL_BALANCE, huge);
    expect(plan.fatal).toBeNull();

    const totals = totalTrialBalance(plan.rows);
    expect(totals.debitMinor).toBe(99999999999999999n);
    expect(totals.debitMinor > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(totals.balances).toBe(true);
  });

  /** ⚠️ The float route would have been wrong, and quietly. */
  it("never multiplies a money value by a hundred", () => {
    for (const source of [OPENING, ACTIONS, OPENING_ENTITIES]) {
      const code = codeOnly(source);
      expect(code).not.toContain("Math.round(Number(");
      expect(code).not.toMatch(/Number\([^)]*\)\s*\*\s*100/);
      expect(code).not.toMatch(/parseFloat/);
    }
  });

  it("formats paise into rupees without dividing a Number", () => {
    expect(rupeesOf(99999999999999999n)).toBe("₹999999999999999.99");
    expect(rupeesOf(5n)).toBe("₹0.05");
    expect(codeOnly(OPENING)).not.toMatch(/\/\s*100\b/);
  });

  /** The refusal message is assembled from the same totals the rule used. */
  it("describes an imbalance from the totals rather than restating them", () => {
    const message = describeImbalance({
      debitMinor: 100n,
      creditMinor: 150n,
      differenceMinor: 50n,
      shortSide: "debit",
      balances: false,
    });
    expect(message).toContain("₹0.50");
    expect(message).toContain("debit");
  });
});

/* ================================================================== */
/* ② 🔴 IT POSTS AS A REAL JOURNAL ENTRY, ON A DATE THAT WAS ENTERED    */
/* ================================================================== */

describe("the opening position reaches the ledger", () => {
  /**
   * 🔴 A figure the ledger cannot explain is a figure that will disagree
   * with every report — the trial balance, the balance sheet, the
   * statement of every account and the Tally export all read
   * `journal_entries` and nothing else.
   */
  it("writes transactions and journal entries, not a column beside them", () => {
    expect(ACTIONS).toContain("insert(transactions)");
    expect(ACTIONS).toContain("insert(journalEntries)");
    expect(ACTIONS).toContain('referenceType: "opening_balance"');
  });

  /** ⚠️ The date on the entry is the customer's as-at day, never today. */
  it("dates the entry at the day the file says, not the day of the upload", () => {
    expect(ACTIONS).toContain("transactionDate: asAt");
    const code = codeOnly(ACTIONS);
    // No clock anywhere near the transaction date.
    expect(code).not.toContain("transactionDate: new Date()");
    expect(code).not.toContain("toISOString()");
  });

  /**
   * 🔴 THE PERIOD LOCK. An opening balance is dated in the past by
   * definition, usually the last day of a financial year — which is
   * exactly the period somebody closes first.
   */
  it("refuses to post into a closed period", () => {
    expect(ACTIONS).toContain("financialPeriods");
    expect(ACTIONS).toContain('inArray(financialPeriods.status, ["closed", "locked"])');
  });

  /** The debit side alone is the transaction's value. Both sides is double. */
  it("stamps the transaction total from the debit side only", () => {
    expect(ACTIONS).toContain("debitTotal += minorOf(item.payload.debitMinor)");
    expect(ACTIONS).toContain("totalAmount: formatMoneyPlain(debitTotal");
  });

  /**
   * 🔴 THE OPENING DATE IS ENTERED, NOT ASSUMED — and it is a COLUMN
   * rather than a field on the upload screen, so it travels with the
   * file and the same file always produces the same key.
   */
  it("makes the as-at date a required column with no default", () => {
    const asAt = TRIAL_BALANCE.columns.find((c) => c.field === "asAt");
    expect(asAt?.required).toBe(true);
    expect(asAt?.kind).toBe("date");
    expect(codeOnly(OPENING_SCHEMAS)).not.toContain(".default(");
  });
});

/* ================================================================== */
/* ③ 🔴 ENTERING IT TWICE MUST NOT DOUBLE THE BOOKS                    */
/* ================================================================== */

describe("re-running an opening balance import", () => {
  /**
   * ⭐ THE KEY IS NAMED AND READABLE: `OPENING:TB:<as-at date>`, written
   * into `transactions.transaction_number`, which the database holds
   * unique per tenant. Somebody reading a trial balance can tell where
   * the entry came from without asking anybody.
   */
  it("keys the whole file on the day it is as at", () => {
    expect(openingBatchKey("trial_balance", "2026-03-31")).toBe("OPENING:TB:2026-03-31");
    expect(openingBatchKey("stock", "2026-03-31")).toBe("OPENING:STK:2026-03-31");

    const plan = planImport(TRIAL_BALANCE, BALANCED);
    const key = TRIAL_BALANCE.batchKey?.(plan.rows);
    expect(key?.value).toBe("OPENING:TB:2026-03-31");
    expect(key?.label).toContain("2026-03-31");
  });

  /** ⚠️ It is the DATABASE's uniqueness, not only ours. */
  it("writes that key into the column the database holds unique", () => {
    expect(ACTIONS).toContain("transactionNumber: key");
    expect(ACTIONS).toContain("eq(transactions.tenantId, ctx.tenant.id)");
    expect(ACTIONS).toContain("inArray(transactions.transactionNumber, keyValues)");
  });

  /** Two different as-at dates are two different opening positions. */
  it("does not confuse two opening positions on different dates", () => {
    expect(openingBatchKey("trial_balance", "2026-03-31")).not.toBe(
      openingBatchKey("trial_balance", "2026-06-30"),
    );
  });

  /**
   * 🔴 EVERY OPENING ENTITY DECLARES A ROW KEY TOO, so a second upload of
   * an invoice list skips what is there rather than creating it again.
   * The invoice key is the database's own: `UNIQUE (tenant_id,
   * invoice_number)`.
   */
  it("keys each sub-ledger row on what the database already keys it on", () => {
    expect(
      INVOICES.naturalKey({ invoiceNumber: "AH/2026/0041", customerName: "Acme" }),
    ).toEqual({
      kind: "invoiceNumber",
      value: "AH/2026/0041",
      label: "invoice AH/2026/0041",
    });

    // ⚠️ The vendor is IN the bill key: two suppliers both numbering a
    // bill 001 are two bills, not a duplicate.
    const a = BILLS.naturalKey({ vendorCode: "V-0001", billNumber: "001" });
    const b = BILLS.naturalKey({ vendorCode: "V-0002", billNumber: "001" });
    expect(a?.value).not.toBe(b?.value);

    // ⚠️ And the batch is in the stock key, because `stock_balances` is
    // unique on (item, warehouse, batch).
    const plain = STOCK.naturalKey({ sku: "CEM-53", warehouseCode: "WH1" });
    const batched = STOCK.naturalKey({
      sku: "CEM-53",
      warehouseCode: "WH1",
      batchNo: "B-9",
    });
    expect(plain?.value).not.toBe(batched?.value);
  });

  /**
   * 🔴 NO "OVERWRITE" ON ANY OPENING ENTITY. `journal_entries` is
   * append-only and an issued invoice is frozen by a trigger — offering
   * an operation the ledger cannot perform, and failing at the write,
   * would be offering it at the worst possible moment.
   */
  it("offers no overwrite, and refuses one asked for directly", () => {
    for (const key of OPENING_IMPORT_ENTITY_KEYS) {
      expect(OPENING_IMPORT_ENTITIES[key].duplicateModes, key).not.toContain("update");
    }
    expect(ACTIONS).toContain("allowedModes.includes(params.duplicateMode)");
    // And the screen never renders a control the server would refuse.
    expect(WIZARD).toContain('(m): m is Exclude<DuplicateMode, "update">');
  });

  /**
   * ⚠️ AND THE DUPLICATE RULE IS NAMED IN THE CUSTOMER'S WORDS, read from
   * the entity rather than from a ternary in the component — which is how
   * the fifth entity ends up described to the customer as the second one.
   */
  it("names the matching rule on the screen, from the entity", () => {
    for (const key of OPENING_IMPORT_ENTITY_KEYS) {
      expect(OPENING_IMPORT_ENTITIES[key].duplicateRule, key).toBeTruthy();
    }
    expect(WIZARD).toContain("{entity.duplicateRule}");
    expect(WIZARD).toContain("useState<DuplicateMode | null>(null)");
    expect(WIZARD).toContain("if (!duplicateMode)");
  });
});

/* ================================================================== */
/* ④ 🔴 ALL-OR-NOTHING, AND THE FAILED ROWS STILL COME BACK            */
/* ================================================================== */

describe("a trial balance with a row that cannot be read", () => {
  const ONE_BAD_ROW = [
    "Account code,Account name,As at,Debit,Credit",
    "1100,Bank,2026-03-31,five lakh,",
    "2100,Sundry Creditors,2026-03-31,,300000.00",
    "3100,Capital,2026-03-31,,200000.00",
  ].join("\n");

  /**
   * 🔴 THE INVERSION OF CONSTRAINT 2, AND IT IS DELIBERATE. Partial
   * success is right for a list of companies and wrong for one journal
   * entry: 38 of 40 lines is not 95% of an opening position, it is a
   * ledger that does not balance.
   */
  it("imports none of it, including the rows that were fine", () => {
    const plan = planImport(TRIAL_BALANCE, ONE_BAD_ROW);
    expect(plan.rows).toHaveLength(3);
    for (const row of plan.rows) {
      expect(row.errors.length).toBeGreaterThan(0);
      // No payload means nothing for the server to write.
      expect(row.payload).toBeUndefined();
    }
  });

  /** ⚠️ And the clean rows say so, rather than showing a blank reason. */
  it("tells a clean row that it was fine and still was not imported", () => {
    const plan = planImport(TRIAL_BALANCE, ONE_BAD_ROW);
    const clean = plan.rows[1];
    expect(clean?.errors[0]?.message).toContain("which is fine");
    expect(clean?.errors[0]?.message).toContain("upload the whole file again");
  });

  /**
   * 🔴 THE REFUSAL IS ROW ERRORS AND NOT A `fatal`, PRECISELY SO THE
   * FAILED-ROWS DOWNLOAD SURVIVES. A fatal empties `rows`, and that
   * download is the entire mechanism by which the customer finds the line
   * that was wrong.
   */
  it("still hands every row back as a re-uploadable CSV", () => {
    const plan = planImport(TRIAL_BALANCE, ONE_BAD_ROW);
    const report = buildReport(TRIAL_BALANCE, plan, {
      mode: "preview",
      duplicateMode: "skip",
      outcomes: new Map(),
    });

    expect(report.failedRowsCsv).not.toBeNull();
    const csv = report.failedRowsCsv as string;

    // The original headers, in the original order, plus one column.
    expect(csv.startsWith("Account code,Account name,As at,Debit,Credit,")).toBe(true);
    expect(csv).toContain("What was wrong with this row");
    // The real reason is on the real offender.
    expect(csv).toContain("five lakh");

    // ⚠️ AND IT PARSES. A "downloadable" file that is not valid CSV closes
    // no loop at all.
    const reparsed = parseCsv(csv);
    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) {
      // header + three rows
      expect(reparsed.records).toHaveLength(4);
    }

    // ⚠️ And re-uploading it is understood: the extra column is reported
    // as ignored rather than refused.
    const mapping = mapHeaders(
      ["Account code", "Account name", "As at", "Debit", "Credit", "What was wrong with this row"],
      TRIAL_BALANCE.columns,
    );
    expect(mapping.missingRequired).toEqual([]);
    expect(mapping.unrecognisedHeaders).toEqual(["What was wrong with this row"]);
  });

  /**
   * ⚠️ THE SUB-LEDGERS ARE **NOT** ALL-OR-NOTHING, and the contrast is
   * the point. 900 of 1000 invoices in is 900 customers who can be
   * chased.
   */
  it("does not apply the same rule to the invoice and bill lists", () => {
    expect(TRIAL_BALANCE.atomic).toBe(true);
    expect(INVOICES.atomic).toBe(false);
    expect(BILLS.atomic).toBe(false);
    expect(STOCK.atomic).toBe(false);
  });
});

/* ================================================================== */
/* ⑤ 🔴 THE AGE OF A DEBT IS ENTERED, NOT ASSUMED                      */
/* ================================================================== */

describe("outstanding invoices and bills carry their own dates", () => {
  const INVOICE_FILE = [
    "Customer,Invoice number,Invoice date,Due date,Amount outstanding",
    "Acme Traders,AH/2025/0100,2025-11-14,2025-12-14,125000.50",
  ].join("\n");

  it("reads the invoice's own date, to the paisa", () => {
    const plan = planImport(INVOICES, INVOICE_FILE);
    expect(plan.fatal).toBeNull();
    const row = plan.rows[0];
    expect(row?.errors).toEqual([]);
    expect(row?.payload?.invoiceDate).toBe("2025-11-14");
    expect(row?.payload?.dueDate).toBe("2025-12-14");
    /*
     * ⭐ A STRING OF MINOR UNITS, not a number. A bigint cannot cross a
     * server-action boundary — `JSON.stringify` throws on one — and a
     * float would lose the half paisa.
     */
    expect(row?.payload?.outstandingMinor).toBe("12500050");
  });

  /** 🔴 The date is required. There is no fallback to the import date. */
  it("requires the document date on both sides", () => {
    for (const [entity, field] of [
      [INVOICES, "invoiceDate"],
      [BILLS, "billDate"],
    ] as const) {
      const column = entity.columns.find((c) => c.field === field);
      expect(column?.required, field).toBe(true);
      expect(column?.kind, field).toBe("date");
    }
    const plan = planImport(
      INVOICES,
      [
        "Customer,Invoice number,Invoice date,Amount outstanding",
        "Acme Traders,AH/2025/0100,,125000.50",
      ].join("\n"),
    );
    expect(plan.rows[0]?.errors.length).toBeGreaterThan(0);
    expect(plan.rows[0]?.errors[0]?.message).not.toContain("received null");
  });

  /** ⚠️ A due date before the document date is one of the two being wrong. */
  it("refuses a due date that precedes the invoice", () => {
    const plan = planImport(
      INVOICES,
      [
        "Customer,Invoice number,Invoice date,Due date,Amount outstanding",
        "Acme Traders,AH/2025/0100,2025-11-14,2025-01-01,1000.00",
      ].join("\n"),
    );
    expect(plan.rows[0]?.errors[0]?.message).toContain("before the invoice date");
  });

  /**
   * 🔴🔴 AN OPENING INVOICE IS NOT A TAX INVOICE. `loadGstr1Documents`
   * filters on `issued_at`; stamping today's date would sweep every
   * historical invoice into THIS month's GSTR-1 and report the same
   * supplies to the Government twice.
   */
  it("carries no taxable value and is stamped at its own date", () => {
    expect(ACTIONS).toContain("taxableValueMinor: 0n");
    expect(ACTIONS).toContain("issuedAt: new Date(`${invoiceDate}");
    expect(ACTIONS).toContain("financialYear: financialYearOf(invoiceDate)");
    // ⚠️ And it is issued, not a draft — a draft is invisible to ageing.
    expect(ACTIONS).toContain('status: "issued"');
  });

  /**
   * ⚠️ A VENDOR BILL IS A CREDIT, because a vendor account is a payable.
   * Copying the customer side's convention by analogy produces a report
   * on which every counterparty is in credit.
   */
  it("posts a bill to the credit side of the vendor ledger", () => {
    expect(ACTIONS).toContain("creditMinor: minorOf(payload.outstandingMinor)");
    expect(ACTIONS).toContain("debitMinor: 0n");
    expect(ACTIONS).toContain('entryType: "purchase_invoice"');
  });
});

/* ================================================================== */
/* ⑥ STOCK ON HAND — INTEGER THOUSANDTHS                               */
/* ================================================================== */

describe("opening stock", () => {
  /** 🔴 `0.1 + 0.2 !== 0.3`. Quantities are integer thousandths. */
  it("reads a quantity as thousandths, exactly", () => {
    expect(coerceQuantityThousandths("0.1")).toEqual({ ok: true, value: "100" });
    expect(coerceQuantityThousandths("0.2")).toEqual({ ok: true, value: "200" });
    expect(coerceQuantityThousandths("12.5")).toEqual({ ok: true, value: "12500" });
    expect(coerceQuantityThousandths("1,250")).toEqual({ ok: true, value: "1250000" });

    const a = coerceQuantityThousandths("0.1");
    const b = coerceQuantityThousandths("0.2");
    if (!a.ok || !b.ok) throw new Error("expected both to coerce");
    expect(BigInt(a.value as string) + BigInt(b.value as string)).toBe(300n);
  });

  it("says what a quantity is, not what a rupee is, when it refuses one", () => {
    const bad = coerceQuantityThousandths("about ten");
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.message).toContain("quantity");
      expect(bad.message).not.toContain("rupees");
    }
  });

  it("writes a movement rather than a balance, with the opening reason", () => {
    expect(ACTIONS).toContain("insert(stockMovements)");
    expect(ACTIONS).toContain('reason: "opening_balance"');
    expect(ACTIONS).toContain("thousandthsToDecimal(quantityThousandths)");
    // The balance is a trigger's job; a second writer would disagree with it.
    expect(codeOnly(ACTIONS)).not.toContain("stockBalances");
  });

  /** ⚠️ Value in paise, computed from integers throughout. */
  it("values the line with integer arithmetic", () => {
    expect(ACTIONS).toContain("(quantityThousandths * unitCostMinor) / 1000n");
  });

  it("requires a cost, because stock with no cost cannot be reconciled", () => {
    const cost = STOCK.columns.find((c) => c.field === "unitCostMinor");
    expect(cost?.required).toBe(true);
  });
});

/* ================================================================== */
/* ⑦ 🔴 ONE CODE PATH — THE DRY RUN IS THE REAL RUN                    */
/* ================================================================== */

describe("preview and commit stay one path", () => {
  /**
   * 🔴 THE STRUCTURAL GUARANTEE, RE-ASSERTED FOR BATCH 58 BECAUSE THE
   * BATCH MOVED THE BRANCH. It used to sit inside the row loop; an atomic
   * entity needs to write one document after the loop, and the lazy way
   * to do that is a SECOND `mode` test below it. There is one.
   */
  it("branches on mode in exactly two places, below every decision", () => {
    /*
     * ⚠️ COMMENTS STRIPPED BUT NOT STRINGS, HERE ONLY. The thing being
     * counted — `mode === "commit"` — contains a string literal, so the
     * stricter helper above would blank the very code this asserts on.
     * Absence assertions use `codeOnly`; this one counts presence.
     */
    const code = commentsOnly(ACTIONS);
    expect(code).toContain('return runImport(input, "preview")');
    expect(code).toContain('return runImport(input, "commit")');
    expect(code.match(/planImport\(/g) ?? []).toHaveLength(1);
    /*
     * ⭐ THREE BRANCHES SINCE WAVE 6, AND THE THIRD BELONGS: the write,
     * the audit entry, and the chunk record that ties one part of a
     * migration to its run. All three are on the WRITE side.
     *
     * 🔴 THE ASSERTION IS THAT EVERY ONE OF THEM IS BELOW THE PLANNER,
     * which is the property that actually matters — a `mode === "commit"`
     * ABOVE it would mean the dry run and the real run were deciding
     * different things, which is the whole failure this file guards.
     */
    const modeReads = [...code.matchAll(/mode === "commit"/g)].map((m) => m.index ?? 0);
    expect(modeReads).toHaveLength(3);
    const plannerAt = code.indexOf("planImportRecords(entity, params.records)");
    expect(plannerAt).toBeGreaterThan(0);
    for (const at of modeReads) expect(at).toBeGreaterThan(plannerAt);

    expect(code).not.toMatch(/skipValidation|quickCheck|shallow/i);
  });

  /**
   * 🔴 THE LOOKUPS ARE THE NEW PLACE THIS COULD DRIFT. If an account code
   * were resolved inside the insert instead, the dry run would say "412
   * will be created" and the real run would create 380 — which is how a
   * customer learns to stop reading the preview.
   */
  it("resolves account codes and customers in the preview, from one call site", () => {
    const code = commentsOnly(ACTIONS);
    expect(code.match(/resolveLookups\(/g) ?? []).toHaveLength(2);
    expect(code.match(/findExistingByNaturalKey\(/g) ?? []).toHaveLength(2);
    // The resolved id is carried to the write, never looked up again.
    expect(ACTIONS).toContain("payload[lookup.into] = resolved.get(");
  });

  /** A miss is an ordinary reported row error with the entity's sentence. */
  it("turns an unresolved reference into a row error, not a crash", () => {
    expect(ACTIONS).toContain("message: lookup.missing");
    const lookups = TRIAL_BALANCE.lookups?.({ accountCode: "9999" }) ?? [];
    expect(lookups).toHaveLength(1);
    expect(lookups[0]?.kind).toBe("ledger_by_code");
    expect(lookups[0]?.into).toBe("ledgerId");
    expect(lookups[0]?.missing).toContain("9999");
  });

  /** ⚠️ The planner still takes a file and an entity, and nothing else. */
  it("keeps the planner free of any run-mode argument", () => {
    expect(commentsOnly(PLAN)).toContain(
      "export function planImport(\n  entity: ImportEntityDefinition,\n  csvText: string,\n): ImportPlan",
    );
  });
});

/* ================================================================== */
/* ⑧ THE GATES, THE PURITY AND THE WIRING                              */
/* ================================================================== */

describe("the opening entities are ordinary framework entities", () => {
  /** ⚠️ The allowlist is one list, and the new keys are in it. */
  it("resolves through the same allowlist as everything else", () => {
    for (const key of OPENING_IMPORT_ENTITY_KEYS) {
      expect(isImportEntityKey(key)).toBe(true);

      /**
       * ⚠️ NOT `toBe`, AND THE CHANGE IS TRACK M1'S DOING.
       *
       * `ALL_IMPORT_ENTITIES` used to spread `OPENING_IMPORT_ENTITIES`
       * unchanged, so the two held the same object and identity was the
       * right assertion. M1 made the migration contract required at the
       * allowlist, and decorates these four with theirs from
       * `lib/import/contract/opening-policies.ts` , a file that exists
       * only because `opening-entities.ts` belongs to another track and
       * asks to be deleted once that track absorbs them.
       *
       * 🔴 THE PROPERTY THIS TEST EXISTS FOR IS UNCHANGED AND IS STILL
       *    ASSERTED: the opening entities are reachable ONLY through the
       *    one allowlist, and every field of the definition survives the
       *    decoration. What is no longer true is object identity, which
       *    was never the point.
       */
      const decorated = ALL_IMPORT_ENTITIES[key];
      const original = OPENING_IMPORT_ENTITIES[key];
      expect(decorated).toMatchObject(original);
      expect(decorated.contract).toBeDefined();
      /** And the decoration added exactly one member, not a rewrite. */
      expect(
        Object.keys(decorated).filter((k) => !Object.hasOwn(original, k)),
      ).toEqual(["contract"]);
    }
    expect(isImportEntityKey("transactions")).toBe(false);
    expect(isImportEntityKey("__proto__")).toBe(false);
    expect(isImportEntityKey("constructor")).toBe(false);
  });

  /**
   * ⚠️ REAL PERMISSION KEYS, REUSED. A new key per entity would be a
   * second answer to a question the permission table already answers, and
   * a key that is in no role grants nobody anything.
   */
  it("guards on permission keys that exist", () => {
    for (const key of OPENING_IMPORT_ENTITY_KEYS) {
      const entity = OPENING_IMPORT_ENTITIES[key];
      expect(Object.keys(PERMISSION_CATALOG), key).toContain(entity.createPermission);
      expect(Object.keys(PERMISSION_CATALOG), key).toContain(entity.updatePermission);
    }
    expect(TRIAL_BALANCE.createPermission).toBe("transactions:post");
  });

  /**
   * ⚠️ `lib/import/` MUST NOT TOUCH THE DATABASE. That purity is what
   * lets the same decision code run on the server during a commit and in
   * the browser when the wizard builds a template.
   */
  it("keeps the new pure layer pure", () => {
    for (const [name, source] of [
      ["lib/import/opening.ts", OPENING],
      ["lib/import/opening-entities.ts", OPENING_ENTITIES],
      ["lib/import/opening-schemas.ts", OPENING_SCHEMAS],
    ] as const) {
      const code = codeOnly(source);
      expect(code, name).not.toMatch(/from "@\/db"/);
      expect(code, name).not.toMatch(/from "@\/server\//);
      expect(code, name).not.toMatch(/from "node:/);
      expect(code, name).not.toContain("server-only");
      // No clock: a pure layer that reads the time is a pure layer that
      // gives two answers.
      expect(code, name).not.toContain("new Date(");
      expect(code, name).not.toContain("Date.now(");
    }
  });

  /** Templates round-trip: the blank file maps cleanly against the columns. */
  it("builds a blank template that its own mapper accepts", () => {
    for (const key of OPENING_IMPORT_ENTITY_KEYS) {
      const entity = OPENING_IMPORT_ENTITIES[key];
      const template = buildTemplateCsv(entity.columns);
      expect(template.endsWith("\r\n"), key).toBe(true);
      const mapping = mapHeaders(template.trim().split(","), entity.columns);
      expect(mapping.missingRequired, key).toEqual([]);
      expect(mapping.unrecognisedHeaders, key).toEqual([]);
    }
  });

  /**
   * ⚠️ EVERY COLUMN CARRIES HELP. The wizard renders it, and a blank
   * "Notes" cell in that table is where a customer's guess comes from.
   */
  it("explains every column it asks for", () => {
    for (const key of OPENING_IMPORT_ENTITY_KEYS) {
      for (const column of OPENING_IMPORT_ENTITIES[key].columns) {
        expect(column.help.length, `${key}.${column.field}`).toBeGreaterThan(10);
      }
    }
  });

  /**
   * 🔴 THE DOUBLE-COUNT DECISION IS WRITTEN DOWN WHERE SOMEBODY WILL
   * MEET IT. Debtors appear both as a control total in the trial balance
   * and as the sum of the invoice list; exactly one of them posts.
   */
  it("says on the screen which file owns the debtors total", () => {
    expect(WIZARD).toContain("The order matters");
    expect(WIZARD).toContain("only file that posts to your ledger");
    expect(WIZARD).toContain("nothing is counted twice");
  });

  /** It exists, it is wired to the actions, and it can be reached. */
  it("is reachable without typing a URL", () => {
    expect(codeOnly(PAGE)).toContain("previewImport");
    expect(codeOnly(PAGE)).toContain("commitImport");
    expect(codeOnly(PAGE)).toContain("OpeningBalanceWizard");
    expect(IMPORT_PAGE).toContain("/settings/opening-balances");
  });

  /**
   * ⚠️ NEVER PIN A COUNT THAT CAN ONLY IMPROVE. What matters is that the
   * three the batch was asked for are here and that adding a fourth was a
   * table entry rather than a code path.
   */
  it("covers at least the ledger, the receivables and the payables", () => {
    expect(OPENING_IMPORT_ENTITY_KEYS.length).toBeGreaterThanOrEqual(3);
    const tables = OPENING_IMPORT_ENTITY_KEYS.map(
      (k) => OPENING_IMPORT_ENTITIES[k].table,
    );
    expect(tables).toContain("transactions");
    expect(tables).toContain("sales_invoices");
    expect(tables).toContain("vendor_ledger_entries");
  });
});
