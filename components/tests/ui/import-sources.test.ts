/**
 * Ordence — 🔴🔴🔴 ANY FORMAT, ONE ROW STREAM · WAVE 6
 * Version: v1.74.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THESE TESTS ARE FOR
 * ══════════════════════════════════════════════════════════════════════
 * `scripts/check-import-sources.mjs` proves four formats are declared
 * consistently in five places. IT PROVES NOTHING ABOUT WHETHER ANY OF
 * THEM READS A REAL FILE. These build real files — a genuine XLSX, a
 * genuine Tally envelope — and read them back.
 *
 * 🔴 AND THE ONE THEY EXIST FOR IS THE SPREADSHEET, because three things
 * about XLSX are silently wrong in every naive reader:
 *
 *   ① sparse cells shift every value after the first gap into the wrong
 *     column, in a file that looks fine;
 *   ② shared strings mean a column of customer names reads as a column of
 *     small integers;
 *   ③ dates are numbers, and the only evidence that 46253 is a date is
 *     the number format its style points at.
 *
 * Every one of those produces an import that runs, reports success and is
 * wrong, which is the class of defect this codebase keeps finding.
 */

import { describe, expect, it } from "vitest";
import { deflateRawSync } from "node:zlib";

import {
  detectFormat,
  readSource,
  SourceReadError,
  IMPORT_SOURCE_FORMATS,
} from "@/lib/import/sources";
import { readXlsx, columnIndexOf, serialToIso, formatCodeIsDate, renderNumber } from "@/lib/import/sources/xlsx-read";
import { readJson, JsonReadError } from "@/lib/import/sources/json-read";
import { readTally } from "@/lib/import/sources/tally-read";
import { inflateRaw, InflateError } from "@/lib/import/sources/inflate";
import { readZip } from "@/lib/import/sources/unzip";
import { buildZip } from "@/lib/export/zip";

const encoder = new TextEncoder();
const AT = new Date("2026-08-19T00:00:00.000Z");
const deflate = (input: Uint8Array) => new Uint8Array(deflateRawSync(input));

/* ================================================================== */
/* A REAL XLSX, BUILT BY HAND FOR THESE TESTS                         */
/* ================================================================== */

/**
 * ⚠️ NOT BUILT WITH `lib/export/xlsx.ts`. Reading back only what our own
 * writer produces would prove the two agree with each other and nothing
 * about the files customers actually send. This fixture deliberately has
 * the three properties a real export has and ours does not: a shared
 * string table, a SPARSE row, and a date as a styled serial number.
 */
function fixtureXlsx(options: { compress?: boolean } = {}): Uint8Array {
  const decl = '<?xml version="1.0" encoding="UTF-8"?>';
  const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

  const shared =
    `${decl}<sst xmlns="${NS}" count="6" uniqueCount="6">` +
    ["Name", "GSTIN", "Joined", "Notes", "Acme &amp; Sons", "विक्रम शर्मा"]
      .map((t) => `<si><t>${t}</t></si>`)
      .join("") +
    "</sst>";

  /**
   * ⚠️ ROW 2 IS SPARSE: it has A, B and C and NO D. Row 3 has A and D and
   * no B or C. A reader that takes cells in order puts row 3's note in
   * the GSTIN column.
   */
  const sheet =
    `${decl}<worksheet xmlns="${NS}"><sheetData>` +
    `<row r="1">` +
    `<c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c>` +
    `<c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c>` +
    `</row>` +
    `<row r="2">` +
    `<c r="A2" t="s"><v>4</v></c>` +
    `<c r="B2" t="inlineStr"><is><t>29AABCU9603R1ZM</t></is></c>` +
    /** 🔴 46253 with style 1, which points at a date format. */
    `<c r="C2" s="1"><v>46253</v></c>` +
    `</row>` +
    `<row r="3">` +
    `<c r="A3" t="s"><v>5</v></c>` +
    `<c r="D3" t="inlineStr"><is><t>only a note</t></is></c>` +
    `</row>` +
    `<row r="4"/>` +
    `</sheetData></worksheet>`;

  const sheet2 =
    `${decl}<worksheet xmlns="${NS}"><sheetData>` +
    `<row r="1"><c r="A1" t="inlineStr"><is><t>Vendor</t></is></c></row>` +
    `<row r="2"><c r="A2" t="inlineStr"><is><t>Somebody Else</t></is></c></row>` +
    `</sheetData></worksheet>`;

  const styles =
    `${decl}<styleSheet xmlns="${NS}">` +
    `<numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts>` +
    /** ⚠️ cellStyleXfs FIRST and DIFFERENT, so a reader that scans both
     * concatenates them and resolves style 1 to the wrong format. */
    `<cellStyleXfs count="2"><xf numFmtId="0"/><xf numFmtId="0"/></cellStyleXfs>` +
    `<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164" applyNumberFormat="1"/></cellXfs>` +
    `</styleSheet>`;

  const workbook =
    `${decl}<workbook xmlns="${NS}" xmlns:r="${REL}"><sheets>` +
    `<sheet name="Customers" sheetId="1" r:id="rId1"/>` +
    `<sheet name="Vendors" sheetId="2" r:id="rId2"/>` +
    `</sheets></workbook>`;

  const rels =
    `${decl}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/>` +
    `<Relationship Id="rId2" Type="${REL}/worksheet" Target="worksheets/sheet2.xml"/>` +
    `</Relationships>`;

  const contentTypes =
    `${decl}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `</Types>`;

  const rootRels =
    `${decl}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`;

  return buildZip(
    [
      { path: "[Content_Types].xml", bytes: encoder.encode(contentTypes) },
      { path: "_rels/.rels", bytes: encoder.encode(rootRels) },
      { path: "xl/workbook.xml", bytes: encoder.encode(workbook) },
      { path: "xl/_rels/workbook.xml.rels", bytes: encoder.encode(rels) },
      { path: "xl/sharedStrings.xml", bytes: encoder.encode(shared) },
      { path: "xl/styles.xml", bytes: encoder.encode(styles) },
      { path: "xl/worksheets/sheet1.xml", bytes: encoder.encode(sheet) },
      { path: "xl/worksheets/sheet2.xml", bytes: encoder.encode(sheet2) },
    ],
    { at: AT, ...(options.compress ? { deflateRaw: deflate } : {}) },
  );
}

/* ================================================================== */
describe("🔴 XLSX: the three things a naive reader gets silently wrong", () => {
  const document = readXlsx(fixtureXlsx());
  const customers = document.sheets[0]!;

  it("resolves shared strings instead of importing their indexes", () => {
    expect(customers.records[0]!.cells).toEqual(["Name", "GSTIN", "Joined", "Notes"]);
    expect(customers.records[1]!.cells[0]).toBe("Acme & Sons");
  });

  it("🔴 places a sparse row by its cell address, not by its order", () => {
    const third = customers.records[2]!;
    expect(third.cells[0]).toBe("विक्रम शर्मा");
    /** ⚠️ THE NOTE IS IN D, NOT IN B. This is the whole test. */
    expect(third.cells[1]).toBe("");
    expect(third.cells[2]).toBe("");
    expect(third.cells[3]).toBe("only a note");
  });

  it("🔴 turns a styled serial number back into a date", () => {
    expect(customers.records[1]!.cells[2]).toBe("2026-08-19");
  });

  it("reads cellXfs and not cellStyleXfs", () => {
    /**
     * The fixture's `cellStyleXfs` has two entries with no date format.
     * A reader that scanned both would resolve style 1 to a general
     * format and the date above would come back as 46253.
     */
    expect(customers.records[1]!.cells[2]).not.toBe("46253");
  });

  it("drops a completely empty row rather than reporting it as bad data", () => {
    expect(customers.records).toHaveLength(3);
  });

  it("keeps Devanagari intact", () => {
    expect(customers.records[2]!.cells[0]).toBe("विक्रम शर्मा");
  });

  it("addresses columns the way the format does", () => {
    expect(columnIndexOf("A1")).toBe(0);
    expect(columnIndexOf("Z9")).toBe(25);
    expect(columnIndexOf("AA1")).toBe(26);
  });

  it("refuses a serial before Excel's leap-year bug rather than being a day out", () => {
    expect(serialToIso(60)).toBeNull();
    expect(serialToIso(61)).toBe("1900-03-01");
  });

  it("knows a date format from a money one", () => {
    expect(formatCodeIsDate("dd/mm/yyyy")).toBe(true);
    expect(formatCodeIsDate("hh:mm:ss")).toBe(true);
    expect(formatCodeIsDate("#,##0.00")).toBe(false);
    /** ⚠️ The quoted text must not be read as date tokens. */
    expect(formatCodeIsDate('0.00" days"')).toBe(false);
  });

  it("never writes a number in exponent notation", () => {
    expect(renderNumber("123456789012345")).toBe("123456789012345");
    expect(renderNumber("0.30000000000000004")).toBe("0.3");
  });
});

describe("⚠️ XLSX: several sheets is a decision, not a default", () => {
  it("reads the first sheet and NAMES the others", () => {
    const table = readSource(fixtureXlsx(), { fileName: "book.xlsx" });
    expect(table.selectedSheet).toBe("Customers");
    expect(table.sheetNames).toEqual(["Customers", "Vendors"]);
    expect(table.notes.join(" ")).toMatch(/2 sheets with data/);
  });

  it("reads a named sheet when one is chosen", () => {
    const table = readSource(fixtureXlsx(), { fileName: "book.xlsx", sheet: "Vendors" });
    expect(table.records[1]!.cells[0]).toBe("Somebody Else");
  });

  it("refuses a sheet name that is not in the workbook, and lists what is", () => {
    expect(() => readSource(fixtureXlsx(), { sheet: "Items" })).toThrow(/"Customers", "Vendors"/);
  });

  it("reads a compressed workbook with no decompressor supplied", () => {
    /**
     * 🔴 THE BROWSER CASE. `node:zlib` does not exist there and
     * `DecompressionStream` is async, so `lib/import/sources/inflate.ts`
     * is what makes reading a real spreadsheet client-side possible at all.
     */
    const table = readSource(fixtureXlsx({ compress: true }), { fileName: "book.xlsx" });
    expect(table.records[1]!.cells[0]).toBe("Acme & Sons");
  });
});

/* ================================================================== */
describe("⭐ inflate: RFC 1951, and it refuses rather than truncating", () => {
  it("round-trips every block type exactly", () => {
    const cases = [
      encoder.encode(""),
      encoder.encode("hello"),
      encoder.encode("a".repeat(70_000)),
      encoder.encode("विक्रम शर्मा ".repeat(2_000)),
      new Uint8Array(Array.from({ length: 30_000 }, (_, i) => (i * 251) % 256)),
    ];
    for (const input of cases) {
      for (const level of [0, 6, 9]) {
        const out = inflateRaw(new Uint8Array(deflateRawSync(input, { level })), input.length);
        expect([...out]).toEqual([...input]);
      }
    }
  });

  it("refuses damaged data instead of returning what it managed", () => {
    expect(() => inflateRaw(new Uint8Array([0xff, 0xff, 0xff, 0xff]))).toThrow(InflateError);
  });
});

describe("⚠️ the zip reader refuses what a hostile archive can do", () => {
  it("refuses an entry that tries to escape the archive", () => {
    const bytes = buildZip([{ path: "../../etc/passwd", bytes: encoder.encode("x") }], { at: AT });
    expect(() => readZip(bytes)).toThrow(/escape the archive/);
  });

  it("explains what an old .xls actually is", () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    expect(() => detectFormat(ole, "customers.xlsx")).toThrow(/Excel 97-2003/);
  });

  it("explains UTF-16 rather than importing invisible characters", () => {
    const utf16 = new Uint8Array([0xff, 0xfe, 0x4e, 0x00, 0x61, 0x00]);
    expect(() => detectFormat(utf16, "list.csv")).toThrow(/UTF-16/);
  });
});

/* ================================================================== */
describe("⭐ JSON: what is a row, and when to refuse to guess", () => {
  it("reads a bare list of records", () => {
    const document = readJson('[{"name":"Acme","gstin":"29AABCU9603R1ZM"},{"name":"Beta"}]');
    expect(document.headers).toEqual(["name", "gstin"]);
    expect(document.records[2]!.cells).toEqual(["Beta", ""]);
  });

  it("🔴 takes the UNION of every record's keys, not the first record's", () => {
    /**
     * JSON omits nulls routinely. Taking record 1's keys as the header
     * drops `gstin` for the whole file and the customer's GSTINs never
     * arrive, with nothing reporting it.
     */
    const document = readJson('[{"name":"Acme"},{"name":"Beta","gstin":"X"}]');
    expect(document.headers).toEqual(["name", "gstin"]);
  });

  it("flattens a nested object to a dotted path", () => {
    const document = readJson('[{"name":"Acme","address":{"city":"Pune"}}]');
    expect(document.headers).toContain("address.city");
    expect(document.records[1]!.cells[document.headers.indexOf("address.city")]).toBe("Pune");
  });

  it("reads a single wrapped list and says which one it used", () => {
    const document = readJson('{"meta":{"v":1},"customers":[{"name":"Acme"}]}');
    expect(document.notes.join(" ")).toMatch(/"customers" list/);
  });

  it("🔴 REFUSES when there are two lists rather than picking the longer", () => {
    /**
     * Picking one would be a coin toss between the invoices and their
     * line items, and the wrong choice imports line items as invoices —
     * every one of which validates, because they have amounts and dates.
     */
    expect(() =>
      readJson('{"invoices":[{"n":1}],"lines":[{"n":1},{"n":2}]}'),
    ).toThrow(JsonReadError);
    expect(() => readJson('{"invoices":[{"n":1}],"lines":[{"n":1}]}')).toThrow(
      /will not guess which one/,
    );
  });

  it("reads JSON Lines", () => {
    const document = readJson('{"name":"Acme"}\n{"name":"Beta"}\n');
    expect(document.records).toHaveLength(3);
    expect(document.notes.join(" ")).toMatch(/JSON Lines/);
  });
});

/* ================================================================== */
describe("⭐ Tally XML: masters, and the sentence about history", () => {
  const envelope = `<?xml version="1.0"?>
<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA><REQUESTDESC><STATICVARIABLES>
<SVCURRENTCOMPANY>Acme (2026-27)</SVCURRENTCOMPANY>
</STATICVARIABLES></REQUESTDESC><REQUESTDATA>
<TALLYMESSAGE>
  <VOUCHER VCHTYPE="Sales" ACTION="Create">
    <DATE>20260415</DATE><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
    <VOUCHERNUMBER>S-1</VOUCHERNUMBER>
    <PARTYLEDGERNAME>Acme Ltd</PARTYLEDGERNAME>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>Acme Ltd</LEDGERNAME><AMOUNT>-1180.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>Sales</LEDGERNAME><AMOUNT>1000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>Output CGST</LEDGERNAME><AMOUNT>90.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>Output SGST</LEDGERNAME><AMOUNT>90.00</AMOUNT></ALLLEDGERENTRIES.LIST>
  </VOUCHER>
</TALLYMESSAGE>
<TALLYMESSAGE>
  <VOUCHER VCHTYPE="Sales" ACTION="Create">
    <DATE>20260416</DATE><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
    <VOUCHERNUMBER>S-2</VOUCHERNUMBER>
    <PARTYLEDGERNAME>ACME LTD</PARTYLEDGERNAME>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>ACME LTD</LEDGERNAME><AMOUNT>-500.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>Sales</LEDGERNAME><AMOUNT>500.00</AMOUNT></ALLLEDGERENTRIES.LIST>
  </VOUCHER>
</TALLYMESSAGE>
</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;

  it("derives the ledgers actually used, from the vouchers", () => {
    const document = readTally(envelope);
    const names = document.records.slice(1).map((r) => r.cells[0]);
    expect(names).toContain("Acme Ltd");
    expect(names).toContain("Sales");
    expect(names).toContain("Output CGST");
  });

  it("🔴 shows a case collision rather than creating two customers", () => {
    const document = readTally(envelope);
    const acme = document.records.slice(1).find((r) => r.cells[0] === "Acme Ltd");
    expect(acme!.cells[1]).toContain("ACME LTD");
    expect(document.notes.join(" ")).toMatch(/more than one spelling/);
  });

  it("🔴 says plainly that history is NOT replayed into the ledger", () => {
    /**
     * A customer who believes their four years of history came across,
     * and finds later that it did not, is a customer who cannot trust any
     * figure in the product.
     */
    const document = readTally(envelope);
    expect(document.notes[0]).toMatch(/does not replay/i);
    expect(document.notes[0]).toMatch(/opening trial balance/);
  });

  it("names the company the export came from", () => {
    expect(readTally(envelope).companyName).toBe("Acme (2026-27)");
  });

  it("is detected from the bytes, not the extension", () => {
    const bytes = encoder.encode(envelope);
    expect(detectFormat(bytes, "daybook.txt").format).toBe("tally-xml");
  });

  it("refuses XML that is not a Tally export rather than guessing", () => {
    expect(() => detectFormat(encoder.encode("<catalog><item/></catalog>"))).toThrow(
      SourceReadError,
    );
  });
});

/* ================================================================== */
describe("⚠️ detection: the bytes win, and the extension explains", () => {
  it("recognises every declared format", () => {
    expect([...IMPORT_SOURCE_FORMATS]).toEqual(["csv", "xlsx", "json", "tally-xml"]);
    expect(detectFormat(encoder.encode("a,b\n1,2\n")).format).toBe("csv");
    expect(detectFormat(encoder.encode('[{"a":1}]')).format).toBe("json");
    expect(detectFormat(fixtureXlsx()).format).toBe("xlsx");
  });

  it("says so when the name disagreed with the bytes", () => {
    const table = readSource(encoder.encode('[{"name":"Acme"}]'), { fileName: "list.csv" });
    expect(table.format).toBe("json");
    expect(table.notes.join(" ")).toMatch(/named \.csv/);
    expect(table.notes.join(" ")).toMatch(/renamed rather than saved/);
  });

  it("produces the same record shape a CSV would", () => {
    const csv = readSource(encoder.encode("Name,GSTIN\r\nAcme,29AABCU9603R1ZM\r\n"));
    const json = readSource(encoder.encode('[{"Name":"Acme","GSTIN":"29AABCU9603R1ZM"}]'));
    expect(csv.records[1]!.cells).toEqual(json.records[1]!.cells);
  });
});
