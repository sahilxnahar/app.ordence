/**
 * Ordence — 🔴🔴🔴 EXPORT IN EVERY FORMAT · WAVE 5
 * Version: v1.73.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THESE TESTS ARE FOR
 * ══════════════════════════════════════════════════════════════════════
 * `scripts/check-export-registry.mjs` proves the six formats are declared
 * consistently in five places. IT PROVES NOTHING ABOUT WHETHER THEY OPEN.
 * These tests open the bytes.
 *
 * 🔴 AND THE ONE THEY EXIST FOR IS THE MONEY. Three exporters already
 * existed in this codebase before wave 5 and two of them were wrong about
 * money in the same way: `server/backup/export.ts` emits the raw minor
 * unit with no currency beside it, and `lib/tally/amounts.ts` divides by
 * 100 — correct for INR, wrong by a factor of TEN for the Gulf dinars and
 * a factor of ONE HUNDRED for the yen. A fourth exporter reinventing that
 * arithmetic is the reason `lib/export/values.ts` forbids division and
 * these tests assert on the exact strings.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";

import { EXPORT_FORMATS, FORMAT_DESCRIPTORS, availabilityForWorkbook } from "@/lib/export/registry";
import { datasetToCsv, needsFormulaGuard } from "@/lib/export/csv";
import { workbookToJson } from "@/lib/export/json";
import { workbookToXlsx, cellRef, sheetName } from "@/lib/export/xlsx";
import { workbookToDocx } from "@/lib/export/docx";
import { workbookToPdf, wrapText } from "@/lib/export/pdf";
import { encodeWinAnsi, textWidth } from "@/lib/export/pdf-fonts";
import { datasetToTallyXml, tallyRefusal, TallyExportUnavailable } from "@/lib/export/tally";
import { buildZip, crc32 } from "@/lib/export/zip";
import { renderCell, assertDatasetIsRenderable, ExportCellError } from "@/lib/export/values";
import type { Dataset, Workbook } from "@/lib/export/types";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const deflateRaw = (input: Uint8Array) => new Uint8Array(deflateRawSync(input));

const AT = new Date("2026-08-19T09:30:00.000Z");

const MONEY_DATASET: Dataset = {
  key: "money",
  title: "Money",
  columns: [
    { key: "ref", label: "Ref", kind: "code", width: 12 },
    { key: "currency", label: "Currency", kind: "code", width: 10 },
    { key: "amount", label: "Amount", kind: "money", currencyKey: "currency", width: 16 },
  ],
  rows: [
    { ref: "0012345", currency: "INR", amount: 123456n },
    /** 🔴 1234 fils is 1.234 dinars, not 12.34. */
    { ref: "0012346", currency: "KWD", amount: 1234n },
    /** 🔴 1234 yen is 1234 yen. There is no sen in circulation. */
    { ref: "0012347", currency: "JPY", amount: 1234n },
  ],
};

const workbookOf = (...datasets: Dataset[]): Workbook => ({
  title: "Test export",
  generatedAt: AT,
  datasets,
  context: { Workspace: "Ordence Test" },
});

/* ================================================================== */
describe("🔴 money survives every format at its own exponent", () => {
  it("renders each currency at its own number of decimals", () => {
    const cells = MONEY_DATASET.rows.map((row) =>
      renderCell(MONEY_DATASET, MONEY_DATASET.columns[2]!, row),
    );
    expect(cells.map((c) => (c.kind === "number" ? c.literal : c.text))).toEqual([
      "1234.56",
      "1.234",
      "1234",
    ]);
    expect(cells.map((c) => (c.kind === "number" ? c.decimals : -1))).toEqual([2, 3, 0]);
  });

  it("puts the same three strings in the CSV", () => {
    const csv = datasetToCsv(MONEY_DATASET, { includeNotes: false }).text;
    expect(csv).toContain("1234.56");
    expect(csv).toContain("1.234");
    expect(csv).toContain(",1234\r\n");
    /** ⚠️ AND NEVER "12.34" FOR THE DINAR. That is the ten-times error. */
    expect(csv).not.toContain("12.34\r\n");
  });

  it("puts them in the XLSX as numbers, verbatim", () => {
    const { bytes } = workbookToXlsx(workbookOf(MONEY_DATASET));
    const text = new TextDecoder().decode(bytes);
    /**
     * ⚠️ STORED, NOT DEFLATED, so the sheet XML is readable in the raw
     * bytes. This is why `buildZip` only compresses when a deflater is
     * passed — it makes the test able to see what was written.
     */
    expect(text).toContain("<v>1234.56</v>");
    expect(text).toContain("<v>1.234</v>");
    expect(text).toContain("<v>1234</v>");
  });

  it("carries the exact integer AND the decimal in the JSON", () => {
    const json = workbookToJson(workbookOf(MONEY_DATASET));
    const rows = json.datasets[0]!.rows as Record<string, { minor: string; decimal: string; currency: string; exponent: number }>[];
    expect(rows[1]!.amount).toEqual({
      minor: "1234",
      currency: "KWD",
      decimal: "1.234",
      exponent: 3,
    });
  });

  it("never turns a money value into a JS number", () => {
    /**
     * 🔴 THE SOURCE-LEVEL ASSERTION, because the behavioural one cannot
     * see a `Number()` that happens to be harmless for the test's inputs
     * and lossy for a real ledger.
     */
    const values = read("lib/export/values.ts");
    const moneyBranch = values.slice(values.indexOf('case "money":'), values.indexOf('case "date":'));
    expect(moneyBranch).not.toMatch(/Number\s*\(/);
    expect(moneyBranch).not.toMatch(/\/\s*100/);
    expect(moneyBranch).toContain("formatMinorPlain");
  });

  it("refuses a money column with no currency beside it", () => {
    const broken: Dataset = {
      key: "broken",
      title: "Broken",
      columns: [{ key: "amount", label: "Amount", kind: "money" }],
      rows: [{ amount: 100n }],
    };
    expect(() => assertDatasetIsRenderable(broken)).toThrow(ExportCellError);
  });

  it("refuses a currency it does not know rather than assuming two decimals", () => {
    const unknown: Dataset = {
      ...MONEY_DATASET,
      rows: [{ ref: "x", currency: "XXQ", amount: 100n }],
    };
    expect(() => datasetToCsv(unknown)).toThrow(/not a currency Ordence knows/);
  });

  it("demotes an amount beyond a spreadsheet's exact range to text, and says so", () => {
    const huge: Dataset = {
      ...MONEY_DATASET,
      rows: [{ ref: "big", currency: "INR", amount: 90071992547409910n }],
    };
    const result = workbookToXlsx(workbookOf(huge));
    expect(result.notes.join(" ")).toMatch(/beyond the range a spreadsheet holds exactly/);
  });
});

/* ================================================================== */
describe("⚠️ CSV: injection is defended and the defence is declared", () => {
  it("recognises every formula starter", () => {
    for (const start of ["=", "+", "-", "@", "\t", "\r"]) {
      expect(needsFormulaGuard(`${start}cmd`)).toBe(true);
    }
    expect(needsFormulaGuard("Acme Ltd")).toBe(false);
  });

  it("prefixes a dangerous text cell and reports how many", () => {
    const dataset: Dataset = {
      key: "contacts",
      title: "Contacts",
      columns: [{ key: "name", label: "Name", kind: "text" }],
      rows: [{ name: '=HYPERLINK("https://evil.example","Invoice")' }, { name: "Fine Ltd" }],
    };
    const result = datasetToCsv(dataset);
    expect(result.guardedCells).toBe(1);
    expect(result.text).toContain(`"'=HYPERLINK`);
    expect(result.notes.join(" ")).toMatch(/reads as the start of a formula/);
  });

  it("does NOT prefix a negative number, because that would break the ledger", () => {
    const dataset: Dataset = {
      key: "n",
      title: "N",
      columns: [
        { key: "currency", label: "Currency", kind: "code" },
        { key: "amount", label: "Amount", kind: "money", currencyKey: "currency" },
      ],
      rows: [{ currency: "INR", amount: -50000n }],
    };
    const result = datasetToCsv(dataset, { includeNotes: false });
    expect(result.guardedCells).toBe(0);
    expect(result.text).toContain("-500.00");
    expect(result.text).not.toContain("'-500.00");
  });

  it("warns about code columns instead of trying a trick that does not work", () => {
    const result = datasetToCsv(MONEY_DATASET);
    expect(result.notes.join(" ")).toMatch(/CSV has no cell types/);
    expect(result.notes.join(" ")).toMatch(/Export as XLSX/);
    /** ⚠️ AND THE VALUE IS UNTOUCHED. `'0012345` in a CSV is not stripped. */
    expect(result.text).toContain('"0012345"');
  });
});

/* ================================================================== */
describe("⭐ ZIP: a real archive that a real unzipper accepts", () => {
  it("computes the CRC-32 the format specifies", () => {
    /** The canonical check value for "123456789". */
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("writes the local header, the central directory and the end record", () => {
    const bytes = buildZip([{ path: "a.txt", bytes: new TextEncoder().encode("hello") }], { at: AT });
    expect([...bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect([...bytes.slice(-22, -18)]).toEqual([0x50, 0x4b, 0x05, 0x06]);
  });

  it("sets the UTF-8 name flag, so a Devanagari file name survives", () => {
    const bytes = buildZip([{ path: "विक्रय.csv", bytes: new Uint8Array([1]) }], { at: AT });
    /** Bit 11 of the general-purpose flag, at offset 6. */
    expect(bytes[7]! & 0x08).toBe(0x08);
  });

  it("is deterministic: the same input twice is the same bytes", () => {
    const once = buildZip([{ path: "a", bytes: new Uint8Array([1, 2, 3]) }], { at: AT });
    const twice = buildZip([{ path: "a", bytes: new Uint8Array([1, 2, 3]) }], { at: AT });
    expect([...once]).toEqual([...twice]);
  });

  it("only compresses when it helps", () => {
    const incompressible = new Uint8Array(64).map((_, i) => (i * 97) % 251);
    const stored = buildZip([{ path: "a", bytes: incompressible }], { at: AT });
    const offered = buildZip([{ path: "a", bytes: incompressible }], { at: AT, deflateRaw });
    expect(offered.length).toBeLessThanOrEqual(stored.length);
  });
});

/* ================================================================== */
describe("⭐ XLSX: the parts Excel refuses to open without", () => {
  const { bytes } = workbookToXlsx(workbookOf(MONEY_DATASET), { deflateRaw });
  const raw = new TextDecoder("latin1").decode(bytes);

  it("contains every required part", () => {
    for (const part of [
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/worksheets/sheet1.xml",
    ]) {
      expect(raw).toContain(part);
    }
  });

  it("addresses cells the way the format does", () => {
    expect(cellRef(0, 1)).toBe("A1");
    expect(cellRef(25, 3)).toBe("Z3");
    expect(cellRef(26, 1)).toBe("AA1");
    expect(cellRef(701, 9)).toBe("ZZ9");
  });

  it("obeys Excel's sheet-name rules and de-duplicates truncations", () => {
    const taken = new Set<string>();
    const first = sheetName("Sales register — northern region and branches", taken);
    taken.add(first.toLowerCase());
    const second = sheetName("Sales register — northern region and branches", taken);
    expect(first.length).toBeLessThanOrEqual(31);
    expect(second.length).toBeLessThanOrEqual(31);
    expect(second).not.toBe(first);
    expect(sheetName("A/B:C?D*E[F]G", new Set())).not.toMatch(/[:\\/?*[\]]/);
  });

  it("keeps a code column as text so 0012345 is not turned into 12345", () => {
    const stored = workbookToXlsx(workbookOf(MONEY_DATASET));
    const text = new TextDecoder().decode(stored.bytes);
    expect(text).toContain(">0012345<");
  });
});

/* ================================================================== */
describe("⭐ DOCX: full Unicode, which is the whole reason it exists", () => {
  it("keeps a Devanagari name intact", () => {
    const dataset: Dataset = {
      key: "people",
      title: "People",
      columns: [{ key: "name", label: "Name", kind: "text" }],
      rows: [{ name: "विक्रम शर्मा" }],
    };
    const { bytes } = workbookToDocx(workbookOf(dataset));
    expect(new TextDecoder().decode(bytes)).toContain("विक्रम शर्मा");
  });

  it("contains the parts Word requires", () => {
    const { bytes } = workbookToDocx(workbookOf(MONEY_DATASET));
    const raw = new TextDecoder("latin1").decode(bytes);
    for (const part of ["word/document.xml", "word/styles.xml", "word/_rels/document.xml.rels"]) {
      expect(raw).toContain(part);
    }
  });

  it("repeats the header row on every page", () => {
    const { bytes } = workbookToDocx(workbookOf(MONEY_DATASET));
    expect(new TextDecoder().decode(bytes)).toContain("<w:tblHeader/>");
  });
});

/* ================================================================== */
describe("🔴 PDF: a valid document that is honest about what it cannot draw", () => {
  it("starts with the header and ends with the EOF marker", () => {
    const { bytes } = workbookToPdf(workbookOf(MONEY_DATASET));
    const raw = new TextDecoder("latin1").decode(bytes);
    expect(raw.startsWith("%PDF-1.4")).toBe(true);
    expect(raw.trimEnd().endsWith("%%EOF")).toBe(true);
  });

  it("writes xref offsets that actually point at their objects", () => {
    /**
     * 🔴 THE TEST THAT CAUGHT A REAL BUG. The first draft measured byte
     * offsets with `TextEncoder` (UTF-8) and wrote the file as latin-1,
     * so the four-byte binary comment counted as eight and every offset
     * after it was four bytes past its object. The document opened blank.
     */
    const { bytes } = workbookToPdf(workbookOf(MONEY_DATASET));
    const raw = new TextDecoder("latin1").decode(bytes);
    const xrefAt = Number(raw.slice(raw.lastIndexOf("startxref") + 9).trim().split("\n")[0]);
    expect(raw.slice(xrefAt, xrefAt + 4)).toBe("xref");

    const entries = [...raw.slice(xrefAt).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) =>
      Number(m[1]),
    );
    expect(entries.length).toBeGreaterThan(4);
    entries.forEach((offset, i) => {
      expect(raw.slice(offset, offset + 8)).toMatch(new RegExp(`^${i + 1} 0 obj`));
    });
  });

  it("substitutes and COUNTS a character Helvetica cannot draw", () => {
    const dataset: Dataset = {
      key: "people",
      title: "People",
      columns: [{ key: "name", label: "Name", kind: "text" }],
      rows: [{ name: "विक्रम" }],
    };
    const result = workbookToPdf(workbookOf(dataset));
    expect(result.notes.join(" ")).toMatch(/could not be drawn/);
    expect(result.notes.join(" ")).toMatch(/Name/);
    expect(result.notes.join(" ")).toMatch(/Word or Excel/);
  });

  it("keeps the WinAnsi characters that pasted text actually contains", () => {
    /** An em dash and a curly quote are 0x97 and 0x92 in Windows-1252. */
    expect(encodeWinAnsi("—").bytes).toEqual([0x97]);
    expect(encodeWinAnsi("’").bytes).toEqual([0x92]);
    expect(encodeWinAnsi("é").bytes).toEqual([0xe9]);
    expect(encodeWinAnsi("₹").unprintable).toBe(1);
  });

  it("measures Helvetica rather than guessing", () => {
    /** 'i' is 222/1000 em and 'm' is 833/1000. A guesser would say equal. */
    expect(textWidth("i", "Helvetica", 1000)).toBe(222);
    expect(textWidth("m", "Helvetica", 1000)).toBe(833);
  });

  it("wraps rather than clips, and breaks a word with no spaces in it", () => {
    const wrapped = wrapText("a".repeat(200), 40, "Helvetica", 8, 4);
    expect(wrapped.lines.length).toBeLessThanOrEqual(4);
    expect(wrapped.truncated).toBe(true);
    expect(wrapped.lines.at(-1)).toMatch(/…$/);
  });
});

/* ================================================================== */
describe("⭐ Tally XML: available only where a real mapping exists", () => {
  const MASTERS: Dataset = {
    key: "tally-masters",
    title: "Tally ledger masters",
    columns: [
      { key: "tally_ledger_name", label: "Ledger name", kind: "text" },
      { key: "tally_parent_group", label: "Tally group", kind: "text" },
      { key: "party_gstin", label: "GSTIN", kind: "code" },
    ],
    rows: [
      { tally_ledger_name: "Acme & Sons", tally_parent_group: "sundry_debtors", party_gstin: "29AABCU9603R1ZM" },
    ],
    tally: {
      kind: "ledger-master",
      nameKey: "tally_ledger_name",
      parentGroupKey: "tally_parent_group",
      gstinKey: "party_gstin",
      isParty: true,
    },
  };

  it("builds an importable envelope and escapes the ampersand Tally itself uses", () => {
    const xml = datasetToTallyXml(MASTERS, { companyName: "Acme (2026-27)" });
    expect(xml).toContain("<ENVELOPE>");
    expect(xml).toContain("Acme &amp; Sons");
    expect(xml).toContain("Sundry Debtors");
    expect(xml).toContain("Acme (2026-27)");
  });

  it("refuses a dataset with no Tally mapping and names the formats that work", () => {
    const refusal = tallyRefusal(MONEY_DATASET);
    expect(refusal).toMatch(/no Tally mapping/);
    expect(refusal).toMatch(/Excel, CSV, JSON, PDF and Word/);
    expect(availabilityForWorkbook(workbookOf(MONEY_DATASET), "tally-xml").available).toBe(false);
  });

  it("refuses duplicate ledger names, because Tally would merge them silently", () => {
    const duplicated: Dataset = {
      ...MASTERS,
      rows: [
        { tally_ledger_name: "Acme Ltd", tally_parent_group: "sundry_debtors" },
        { tally_ledger_name: "ACME LTD", tally_parent_group: "sundry_debtors" },
      ],
    };
    expect(() => datasetToTallyXml(duplicated, { companyName: "Acme" })).toThrow(
      TallyExportUnavailable,
    );
  });

  it("refuses a group Tally does not ship with", () => {
    const wrong: Dataset = {
      ...MASTERS,
      rows: [{ tally_ledger_name: "X", tally_parent_group: "Duties and Taxes" }],
    };
    expect(() => datasetToTallyXml(wrong, { companyName: "Acme" })).toThrow(/under Primary/);
  });

  it("points vouchers at the screen that builds them correctly", () => {
    const register: Dataset = {
      ...MONEY_DATASET,
      tally: { kind: "vouchers-elsewhere", where: "Settings → Tally → Export a period" },
    };
    expect(tallyRefusal(register)).toMatch(/Settings → Tally/);
    expect(tallyRefusal(register)).toMatch(/balances by/);
  });
});

/* ================================================================== */
describe("⚠️ the registry describes what each format costs", () => {
  it("names all six", () => {
    expect([...EXPORT_FORMATS]).toEqual(["csv", "xlsx", "json", "pdf", "docx", "tally-xml"]);
  });

  it("marks PDF as the one format that is not Unicode-safe", () => {
    const unsafe = EXPORT_FORMATS.filter((f) => !FORMAT_DESCRIPTORS[f].unicodeSafe);
    expect(unsafe).toEqual(["pdf"]);
  });

  it("warns before the download that CSV will damage a code column", () => {
    const verdict = availabilityForWorkbook(workbookOf(MONEY_DATASET), "csv");
    expect(verdict.available).toBe(true);
    expect(verdict.caution).toMatch(/leading zeroes lost/);
  });

  it("says a multi-table CSV export arrives as a zip", () => {
    const verdict = availabilityForWorkbook(
      workbookOf(MONEY_DATASET, { ...MONEY_DATASET, key: "b", title: "Second" }),
      "csv",
    );
    expect(verdict.caution).toMatch(/zip with 2 files/);
  });
});
