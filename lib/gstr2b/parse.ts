/**
 * Ordence — ⭐ GSTR-2B Parsing (portal JSON and the Excel/CSV export)
 * Version: v0.34.0-alpha
 *
 * Pure. `bigint` paise, no database, no I/O, and NOTHING HERE THROWS.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY NOTHING THROWS, AND WHY THAT IS A DESIGN DECISION RATHER THAN A
 *    STYLE ONE
 * ══════════════════════════════════════════════════════════════════════
 * The import path stores the raw file FIRST and parses it SECOND (see
 * `server/actions/gstr2b.ts`). If the parser threw, the natural shape of
 * the calling code would be a try/catch around the whole operation, and
 * the natural response to a failure would be to roll the transaction
 * back — which would delete the raw document.
 *
 * ⭐ THE RAW FILE IS THE EVIDENCE. A parse bug is discovered by
 * definition after the parse, often a year later at a notice, and by then
 * the portal may no longer serve that month. A parser that can destroy
 * the only remaining copy of what the Government said about us has a
 * failure mode worse than any bug it could have.
 *
 * So: every failure is a VALUE. `ok: false`, issues with paths into the
 * document, and the caller stores the file, marks the document `failed`
 * and shows the reason.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ AND A PARTIAL PARSE IS A FAILURE, NOT A SUCCESS
 * ══════════════════════════════════════════════════════════════════════
 * The tempting behaviour on a bad row is to skip it and carry on with the
 * rest. It is the worst available option here, because of what a missing
 * 2B row MEANS:
 *
 *     A row that is absent from the parsed statement is indistinguishable
 *     from a supplier who did not file. The reconciliation would report
 *     the invoice as "in books, not in 2B", somebody would chase a
 *     supplier who has done nothing wrong, and — far worse — the credit
 *     would be deferred out of a period it was entitled to be claimed in,
 *     with the Section 16(4) clock running.
 *
 * So any error-severity issue makes the whole import `ok: false`. Warnings
 * — a missing place of supply, an unrecognised optional column — do not.
 */

import {
  canonicaliseInvoiceNumber,
  normaliseInvoiceNumber,
} from "./invoice-number";
import type {
  Gstr2bItcAvailability,
  Gstr2bSection,
} from "@/db/schema/gstr2b";

/* ------------------------------------------------------------------ */
/* SHAPES                                                              */
/* ------------------------------------------------------------------ */

export type Gstr2bParseIssue = {
  /** Where in the document: `data.docdata.b2b[3].inv[1].val`, or `row 42`. */
  path: string;
  message: string;
  severity: "error" | "warning";
};

export type ParsedGstr2bRow = {
  section: Gstr2bSection;
  supplierGstin: string | null;
  supplierLegalName: string | null;
  supplierTradeName: string | null;

  /** ⭐ Exactly as the supplier filed it. Never rewritten. */
  invoiceNumber: string;
  /** The lookup key. See `lib/gstr2b/invoice-number.ts`. */
  normalisedNumber: string;
  invoiceDate: string;

  documentType: string | null;

  documentValueMinor: bigint;
  taxableValueMinor: bigint;
  cgstMinor: bigint;
  sgstMinor: bigint;
  igstMinor: bigint;
  cessMinor: bigint;

  placeOfSupplyCode: string | null;
  isReverseCharge: boolean;

  itcAvailable: Gstr2bItcAvailability;
  itcUnavailableReason: string | null;

  supplierFilingPeriod: string | null;
  supplierFilingDate: string | null;

  isAmendment: boolean;
  originalInvoiceNumber: string | null;
  originalInvoiceDate: string | null;
  isCancelled: boolean;

  rateBreakup: { rateBps: number; taxableValueMinor: string }[];
  sourceRef: string;
};

export type Gstr2bStatementFacts = {
  gstin: string;
  /** `YYYY-MM`. */
  returnPeriod: string;
  generatedOn: string | null;
  version: string | null;
};

export type Gstr2bParseResult = {
  ok: boolean;
  statement: Gstr2bStatementFacts | null;
  rows: ParsedGstr2bRow[];
  issues: Gstr2bParseIssue[];
};

/* ------------------------------------------------------------------ */
/* ⭐ MONEY — RUPEES ON THE WIRE, PAISE IN THE SYSTEM                  */
/* ------------------------------------------------------------------ */

/**
 * A rupee figure from the portal, as paise.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE MULTIPLICATION IS DONE ON THE DECIMAL STRING, NOT ON A `number`
 * ══════════════════════════════════════════════════════════════════════
 * The obvious implementation is `Math.round(value * 100)`. It is wrong,
 * and it is wrong in the direction that is hardest to find:
 *
 *     1145.75 * 100  === 114574.99999999999   → rounds to 114575  ✓
 *     8.145  * 100   === 814.4999999999999    → rounds to 814     ✗
 *
 * A single paisa lost on one invoice makes it fail an EXACT match and
 * fall to `probable`, which puts it in a person's worklist forever. A
 * paisa lost on a thousand invoices makes the period summary disagree
 * with the portal's own total by a figure nobody can locate, because
 * every individual row looks right.
 *
 * ⚠️ SO A JS NUMBER IS CONVERTED BACK TO ITS SHORTEST DECIMAL STRING
 * FIRST. `String(1145.75)` is `"1145.75"` — the shortest decimal that
 * round-trips — and the digits are then shifted textually. This is exact
 * for every value the IEEE-754 double actually represents, which is
 * every value the portal can have emitted, because the portal emitted a
 * decimal that JSON.parse turned into that double.
 *
 * ⚠️ EXPONENTIAL NOTATION IS REFUSED RATHER THAN EXPANDED. `String(n)`
 * produces it above 1e21 and below 1e-7. Neither is a rupee figure on a
 * tax document; a value in that range means the column was mapped
 * wrongly, and quietly expanding it would put a nonsense amount into a
 * return.
 */
export function rupeesToPaise(value: unknown): bigint | null {
  if (value === null || value === undefined) return null;

  let text: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    text = String(value);
    if (text.includes("e") || text.includes("E")) return null;
  } else if (typeof value === "string") {
    text = value;
  } else if (typeof value === "bigint") {
    return value * 100n;
  } else {
    return null;
  }

  // ⚠️ Indian digit grouping is 2,2,3 (`1,00,000.00`), not 3,3,3. Stripping
  // separators rather than parsing them is what makes both work — and is
  // also why a locale-aware number parser would be the wrong tool here.
  const cleaned = text
    .replace(/[₹]/g, "")
    .replace(/\bRs\.?/gi, "")
    .replace(/[,\s]/g, "")
    .trim();

  if (cleaned === "" || cleaned === "-") return null;

  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(cleaned);
  if (!match) return null;

  const sign = match[1] === "-" ? -1n : 1n;
  const whole = BigInt(match[2]!);
  const fractionDigits = match[3] ?? "";

  const firstTwo = (fractionDigits + "00").slice(0, 2);
  let paise = whole * 100n + BigInt(firstTwo);

  // Half-up on the magnitude, which is what every Indian accounting
  // package does and what Section 170 assumes.
  if (fractionDigits.length > 2 && Number(fractionDigits[2]) >= 5) paise += 1n;

  return sign * paise;
}

/* ------------------------------------------------------------------ */
/* DATES AND PERIODS                                                   */
/* ------------------------------------------------------------------ */

/**
 * A portal date as a civil day, `YYYY-MM-DD`.
 *
 * The portal emits `DD-MM-YYYY`. Excel exports emit `DD-MM-YYYY` or,
 * after a round trip through a spreadsheet with a different locale,
 * `DD/MM/YYYY` or an ISO `YYYY-MM-DD`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ `03-04-2024` IS AMBIGUOUS AND WE ALWAYS READ IT AS 3 APRIL
 * ══════════════════════════════════════════════════════════════════════
 * There is no way to tell `DD-MM-YYYY` from `MM-DD-YYYY` when both parts
 * are ≤ 12, and roughly a third of all dates are in that range. We read
 * day-first because that is what the GST portal emits, always, without
 * exception.
 *
 * The failure this leaves open is real: a CSV that has been opened and
 * re-saved in Excel under a `en-US` locale can come back month-first, and
 * every ambiguous date in it would then be silently transposed — moving
 * invoices between tax periods and, at a year end, between FINANCIAL
 * years, which is where the Section 16(4) deadline is measured from.
 *
 * There is no parser-side defence, so the defence is elsewhere: the
 * caller may pass `dateOrder: "month-first"` explicitly, and an import
 * whose dates fall outside the statement's own return period raises a
 * warning that names this as the likely cause.
 */
export function portalDateToCivilDay(
  value: unknown,
  dateOrder: "day-first" | "month-first" = "day-first",
): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "") return null;

  // ISO first — unambiguous, so it wins wherever it appears.
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso) return validCivilDay(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const parts = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(text);
  if (!parts) return null;

  const first = Number(parts[1]);
  const second = Number(parts[2]);
  const year = Number(parts[3]);

  // A value above 12 in either position resolves the ambiguity by itself,
  // whatever the caller declared. Trusting a wrong declaration over an
  // arithmetic impossibility would produce an invalid date, not a
  // transposed one.
  if (first > 12) return validCivilDay(year, second, first);
  if (second > 12) return validCivilDay(year, first, second);

  return dateOrder === "month-first"
    ? validCivilDay(year, first, second)
    : validCivilDay(year, second, first);
}

function validCivilDay(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

/**
 * A portal return period as `YYYY-MM`.
 *
 * ⚠️ THE PORTAL WRITES IT `MMYYYY` — `072024` IS JULY 2024. Read as
 * `YYYYMM` it becomes `0720-24`, which fails the shape CHECK loudly; read
 * as `MMYY` it becomes a year in the 0072s, which does not. Both digits
 * groups are handled explicitly rather than sliced.
 */
export function portalPeriodToTaxPeriod(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();

  const mmyyyy = /^(\d{2})(\d{4})$/.exec(text);
  if (mmyyyy) return monthYear(Number(mmyyyy[1]), Number(mmyyyy[2]));

  const isoish = /^(\d{4})-(\d{1,2})$/.exec(text);
  if (isoish) return monthYear(Number(isoish[2]), Number(isoish[1]));

  const dashed = /^(\d{1,2})[-/](\d{4})$/.exec(text);
  if (dashed) return monthYear(Number(dashed[1]), Number(dashed[2]));

  return null;
}

function monthYear(month: number, year: number): string | null {
  if (month < 1 || month > 12 || year < 1900 || year > 2999) return null;
  return `${year}-${String(month).padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ */
/* ⭐ THE PORTAL JSON                                                  */
/* ------------------------------------------------------------------ */

type Bag = Record<string, unknown>;

function isBag(value: unknown): value is Bag {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (typeof value === "number") return String(value);
  return null;
}

/**
 * ⭐ The official GSTR-2B JSON, as the portal downloads it.
 *
 * The shape, for the reader who has not seen one:
 *
 *     { chksum, data: { gstin, rtnprd, version, gendt,
 *         docdata: {
 *           b2b:  [ { ctin, trdnm, supprd, supfildt,
 *                     inv: [ { inum, dt, val, pos, rev, itcavl, rsn, typ,
 *                              items: [ { rt, txval, igst, cgst, sgst, cess } ] } ] } ],
 *           b2ba: [ { …, inv: [ { oinum, oidt, … } ] } ],
 *           cdnr: [ { …, nt:  [ { ntnum, nttyp, dt, val, items } ] } ],
 *           cdnra:[ { …, nt:  [ { ontnum, ontdt, … } ] } ],
 *           isd:  [ { ctin, doclist: [ { docnum, docdt, doctyp, igst, … } ] } ],
 *           isda: [ … ],
 *           impg: [ { boenum, boedt, portcode, txval, igst, cess } ],
 *           impgsez: [ { sgstin, boenum, … } ]
 *         } } }
 *
 * ⚠️ SOME PORTAL BUILDS NEST UNDER `data` AND SOME DO NOT, and a file
 * that has been through a middleware may arrive as the `data` object
 * alone. Both are accepted; refusing one of them would be a support
 * ticket that reads "the file is correct, your product is wrong".
 */
export function parseGstr2bJson(input: unknown): Gstr2bParseResult {
  const issues: Gstr2bParseIssue[] = [];
  const rows: ParsedGstr2bRow[] = [];

  const fail = (path: string, message: string): Gstr2bParseResult => {
    issues.push({ path, message, severity: "error" });
    return { ok: false, statement: null, rows: [], issues };
  };

  if (!isBag(input)) {
    return fail(
      "$",
      "This is not a GSTR-2B JSON document. The portal's download is a JSON " +
        "object with a `data` key; what arrived is " +
        (Array.isArray(input) ? "an array" : typeof input) +
        ".",
    );
  }

  const data = isBag(input.data) ? input.data : input;

  const gstin = str(data.gstin);
  if (!gstin) {
    return fail(
      "data.gstin",
      "The statement does not say which GSTIN it was generated for. GSTR-2B is " +
        "produced per registration, and a workspace with more than one would have " +
        "no way to tell which electronic credit ledger these credits belong to.",
    );
  }

  const returnPeriod = portalPeriodToTaxPeriod(data.rtnprd ?? data.returnPeriod);
  if (!returnPeriod) {
    return fail(
      "data.rtnprd",
      `The statement does not carry a readable return period (got ` +
        `${JSON.stringify(data.rtnprd ?? null)}). The portal writes it as MMYYYY — ` +
        `"072024" for July 2024.`,
    );
  }

  const docdata = isBag(data.docdata) ? data.docdata : null;
  if (!docdata) {
    return fail(
      "data.docdata",
      "The statement has no `docdata` section, so it contains no supplier " +
        "documents at all. A genuinely empty month still carries the key with " +
        "empty arrays — an absent key means this is not a 2B.",
    );
  }

  const statement: Gstr2bStatementFacts = {
    gstin,
    returnPeriod,
    generatedOn: portalDateToCivilDay(data.gendt),
    version: str(data.version),
  };

  const push = (row: ParsedGstr2bRow | null) => {
    if (row) rows.push(row);
  };

  /* --- b2b and b2ba: supplier invoices, and their amendments ---- */
  for (const [section, isAmendment] of [
    ["b2b", false],
    ["b2ba", true],
  ] as const) {
    const suppliers = docdata[section];
    if (suppliers === undefined) continue;
    if (!Array.isArray(suppliers)) {
      issues.push({
        path: `data.docdata.${section}`,
        message: `Expected an array of suppliers, got ${typeof suppliers}.`,
        severity: "error",
      });
      continue;
    }

    suppliers.forEach((supplier, si) => {
      if (!isBag(supplier)) {
        issues.push({
          path: `data.docdata.${section}[${si}]`,
          message: "Supplier entry is not an object.",
          severity: "error",
        });
        return;
      }
      const invoices = supplier.inv;
      if (!Array.isArray(invoices)) {
        issues.push({
          path: `data.docdata.${section}[${si}].inv`,
          message: "Supplier entry carries no `inv` array of invoices.",
          severity: "error",
        });
        return;
      }
      invoices.forEach((invoice, ii) => {
        push(
          readInvoiceLike({
            section,
            isAmendment,
            supplier,
            document: invoice,
            path: `data.docdata.${section}[${si}].inv[${ii}]`,
            numberKeys: ["inum"],
            dateKeys: ["dt"],
            originalNumberKeys: ["oinum"],
            originalDateKeys: ["oidt"],
            issues,
          }),
        );
      });
    });
  }

  /* --- cdnr and cdnra: credit and debit notes ------------------- */
  //
  // ⚠️ `nttyp` IS `C` OR `D` AND BOTH ARRIVE POSITIVE. A credit note
  // REDUCES the credit available to us; a debit note increases it. The
  // sign is carried in the type, never in the amount, and a parser that
  // ignores it books every credit note as an extra claim.
  //
  // The amounts are stored as filed — positive — and the note type is
  // kept in `documentType`, because GSTR-3B reports availment and
  // reversal in separate boxes and a signed store cannot produce either.
  for (const [section, isAmendment] of [
    ["cdnr", false],
    ["cdnra", true],
  ] as const) {
    const suppliers = docdata[section];
    if (suppliers === undefined) continue;
    if (!Array.isArray(suppliers)) {
      issues.push({
        path: `data.docdata.${section}`,
        message: `Expected an array of suppliers, got ${typeof suppliers}.`,
        severity: "error",
      });
      continue;
    }

    suppliers.forEach((supplier, si) => {
      if (!isBag(supplier)) {
        issues.push({
          path: `data.docdata.${section}[${si}]`,
          message: "Supplier entry is not an object.",
          severity: "error",
        });
        return;
      }
      const notes = supplier.nt;
      if (!Array.isArray(notes)) {
        issues.push({
          path: `data.docdata.${section}[${si}].nt`,
          message: "Supplier entry carries no `nt` array of notes.",
          severity: "error",
        });
        return;
      }
      notes.forEach((note, ni) => {
        push(
          readInvoiceLike({
            section,
            isAmendment,
            supplier,
            document: note,
            path: `data.docdata.${section}[${si}].nt[${ni}]`,
            numberKeys: ["ntnum", "nt_num"],
            dateKeys: ["dt"],
            originalNumberKeys: ["ontnum"],
            originalDateKeys: ["ontdt"],
            typeKeys: ["nttyp", "typ"],
            issues,
          }),
        );
      });
    });
  }

  /* --- isd and isda: distributed credit ------------------------- */
  for (const [section, isAmendment] of [
    ["isd", false],
    ["isda", true],
  ] as const) {
    const suppliers = docdata[section];
    if (suppliers === undefined) continue;
    if (!Array.isArray(suppliers)) {
      issues.push({
        path: `data.docdata.${section}`,
        message: `Expected an array of distributors, got ${typeof suppliers}.`,
        severity: "error",
      });
      continue;
    }

    suppliers.forEach((supplier, si) => {
      if (!isBag(supplier)) {
        issues.push({
          path: `data.docdata.${section}[${si}]`,
          message: "Distributor entry is not an object.",
          severity: "error",
        });
        return;
      }
      const docs = supplier.doclist;
      if (!Array.isArray(docs)) {
        issues.push({
          path: `data.docdata.${section}[${si}].doclist`,
          message: "Distributor entry carries no `doclist`.",
          severity: "error",
        });
        return;
      }
      docs.forEach((doc, di) => {
        push(
          readInvoiceLike({
            section,
            isAmendment,
            supplier,
            document: doc,
            path: `data.docdata.${section}[${si}].doclist[${di}]`,
            numberKeys: ["docnum", "inum"],
            dateKeys: ["docdt", "dt"],
            originalNumberKeys: ["odocnum", "oinum"],
            originalDateKeys: ["odocdt", "oidt"],
            typeKeys: ["doctyp"],
            issues,
          }),
        );
      });
    });
  }

  /* --- impg / impgsez: imports of goods ------------------------- */
  //
  // ⚠️ A BILL OF ENTRY HAS NO SUPPLIER GSTIN. The counterparty is
  // Customs. Every match rule keyed on GSTIN is inapplicable, which is
  // why `gstr2b_rows.supplier_gstin` is nullable and why the CHECK that
  // guards it exempts exactly this section.
  for (const section of ["impg", "impgsez"] as const) {
    const entries = docdata[section];
    if (entries === undefined) continue;
    if (!Array.isArray(entries)) {
      issues.push({
        path: `data.docdata.${section}`,
        message: `Expected an array of bills of entry, got ${typeof entries}.`,
        severity: "error",
      });
      continue;
    }

    entries.forEach((entry, ei) => {
      const path = `data.docdata.${section}[${ei}]`;
      if (!isBag(entry)) {
        issues.push({ path, message: "Entry is not an object.", severity: "error" });
        return;
      }

      const number = str(entry.boenum);
      const day = portalDateToCivilDay(entry.boedt);
      if (!number || !day) {
        issues.push({
          path,
          message:
            "A bill of entry must carry both `boenum` and `boedt`. Without them the " +
            "import cannot be tied to anything in the purchase register.",
          severity: "error",
        });
        return;
      }

      const taxable = rupeesToPaise(entry.txval) ?? 0n;
      const igst = rupeesToPaise(entry.igst) ?? 0n;
      const cess = rupeesToPaise(entry.cess) ?? 0n;

      rows.push({
        section,
        // An SEZ supplier does have a GSTIN; Customs does not.
        supplierGstin: section === "impgsez" ? str(entry.sgstin) : null,
        supplierLegalName: str(entry.tdname) ?? str(entry.trdnm),
        supplierTradeName: str(entry.trdnm),
        invoiceNumber: number,
        normalisedNumber: normaliseInvoiceNumber(number),
        invoiceDate: day,
        documentType: "BOE",
        documentValueMinor: taxable + igst + cess,
        taxableValueMinor: taxable,
        cgstMinor: 0n,
        sgstMinor: 0n,
        igstMinor: igst,
        cessMinor: cess,
        placeOfSupplyCode: str(entry.portcode)?.slice(0, 2) ?? null,
        isReverseCharge: false,
        itcAvailable: "available",
        itcUnavailableReason: null,
        supplierFilingPeriod: null,
        supplierFilingDate: portalDateToCivilDay(entry.refdt),
        isAmendment: entry.isamd === "Y" || entry.isamd === true,
        originalInvoiceNumber:
          entry.isamd === "Y" || entry.isamd === true ? number : null,
        originalInvoiceDate: null,
        isCancelled: false,
        rateBreakup: [],
        sourceRef: path,
      });
    });
  }

  const hasError = issues.some((i) => i.severity === "error");
  return { ok: !hasError, statement, rows: hasError ? [] : rows, issues };
}

/**
 * Read one invoice-shaped document out of a supplier block.
 *
 * ⚠️ THE `items[]` ARRAY IS SUMMED INTO THE HEADS AND THE PER-RATE SPLIT
 * IS KEPT SEPARATELY. Matching happens at DOCUMENT level, because that is
 * where the portal matches and where an officer matches. A row per rate
 * would triple the table and make every count in the reconciliation
 * summary wrong by the number of rates on the average invoice.
 */
function readInvoiceLike(args: {
  section: Gstr2bSection;
  isAmendment: boolean;
  supplier: Bag;
  document: unknown;
  path: string;
  numberKeys: string[];
  dateKeys: string[];
  originalNumberKeys: string[];
  originalDateKeys: string[];
  typeKeys?: string[];
  issues: Gstr2bParseIssue[];
}): ParsedGstr2bRow | null {
  const { supplier, document, path, issues } = args;

  if (!isBag(document)) {
    issues.push({ path, message: "Document entry is not an object.", severity: "error" });
    return null;
  }

  const first = (keys: string[]): unknown => {
    for (const key of keys) {
      if (document[key] !== undefined && document[key] !== null) return document[key];
    }
    return null;
  };

  const number = str(first(args.numberKeys));
  const day = portalDateToCivilDay(first(args.dateKeys));

  if (!number) {
    issues.push({
      path,
      message:
        `The document has no number (looked for ${args.numberKeys.join(", ")}). ` +
        `The invoice number is half the match key; without it this row could only ` +
        `ever be reported as a supplier declaration nobody recorded.`,
      severity: "error",
    });
    return null;
  }
  if (!day) {
    issues.push({
      path,
      message:
        `The document has no readable date (looked for ${args.dateKeys.join(", ")}, ` +
        `got ${JSON.stringify(first(args.dateKeys))}). The portal writes dates as ` +
        `DD-MM-YYYY.`,
      severity: "error",
    });
    return null;
  }

  /* --- The tax heads, summed over the rate lines ---------------- */

  let taxable = 0n;
  let cgst = 0n;
  let sgst = 0n;
  let igst = 0n;
  let cess = 0n;
  const rateBreakup: { rateBps: number; taxableValueMinor: string }[] = [];

  const items = document.items;
  if (Array.isArray(items)) {
    items.forEach((item, index) => {
      if (!isBag(item)) {
        issues.push({
          path: `${path}.items[${index}]`,
          message: "Rate line is not an object.",
          severity: "error",
        });
        return;
      }
      const lineTaxable = rupeesToPaise(item.txval) ?? 0n;
      taxable += lineTaxable;
      cgst += rupeesToPaise(item.cgst) ?? 0n;
      sgst += rupeesToPaise(item.sgst) ?? 0n;
      igst += rupeesToPaise(item.igst) ?? 0n;
      cess += rupeesToPaise(item.cess) ?? 0n;

      // ⚠️ `rt` is a PERCENTAGE (18, 12, 5, 0.25) and the system stores
      // basis points. 18 → 1800. Multiplying by 100 on a float would
      // reintroduce the problem `rupeesToPaise` exists to avoid, so the
      // conversion goes through the same decimal-string route.
      const ratePaise = rupeesToPaise(item.rt);
      rateBreakup.push({
        rateBps: ratePaise === null ? 0 : Number(ratePaise),
        taxableValueMinor: lineTaxable.toString(),
      });
    });
  } else {
    // ISD documents and some amendment shapes carry the heads flat.
    taxable = rupeesToPaise(document.txval) ?? 0n;
    cgst = rupeesToPaise(document.cgst) ?? 0n;
    sgst = rupeesToPaise(document.sgst) ?? 0n;
    igst = rupeesToPaise(document.igst) ?? 0n;
    cess = rupeesToPaise(document.cess) ?? 0n;
  }

  const declaredValue = rupeesToPaise(document.val);

  const itcFlag = str(document.itcavl);
  const itcAvailable: Gstr2bItcAvailability =
    itcFlag !== null && itcFlag.toUpperCase() === "N" ? "not_available" : "available";

  const originalNumber = str(
    args.originalNumberKeys.map((k) => document[k]).find((v) => v != null),
  );

  if (args.isAmendment && !originalNumber) {
    issues.push({
      path,
      message:
        `This is an amendment (${args.section}) but it does not name the document it ` +
        `amends. An amendment SUPERSEDES the original rather than adding to it, so ` +
        `without the original's number the credit would be counted twice.`,
      severity: "error",
    });
    return null;
  }

  return {
    section: args.section,
    supplierGstin: str(supplier.ctin) ?? str(supplier.sgstin) ?? null,
    supplierLegalName: str(supplier.lglnm) ?? str(supplier.trdnm),
    supplierTradeName: str(supplier.trdnm),
    invoiceNumber: number,
    normalisedNumber: normaliseInvoiceNumber(number),
    invoiceDate: day,
    documentType: str(first(args.typeKeys ?? ["typ"])),
    documentValueMinor: declaredValue ?? taxable + cgst + sgst + igst + cess,
    taxableValueMinor: taxable,
    cgstMinor: cgst,
    sgstMinor: sgst,
    igstMinor: igst,
    cessMinor: cess,
    placeOfSupplyCode: str(document.pos),
    isReverseCharge: str(document.rev)?.toUpperCase() === "Y",
    itcAvailable,
    itcUnavailableReason: str(document.rsn),
    supplierFilingPeriod: portalPeriodToTaxPeriod(supplier.supprd),
    supplierFilingDate: portalDateToCivilDay(supplier.supfildt),
    isAmendment: args.isAmendment,
    originalInvoiceNumber: originalNumber,
    originalInvoiceDate: portalDateToCivilDay(
      args.originalDateKeys.map((k) => document[k]).find((v) => v != null),
    ),
    isCancelled: str(document.cancelled)?.toUpperCase() === "Y",
    rateBreakup,
    sourceRef: path,
  };
}

/* ------------------------------------------------------------------ */
/* ⭐ THE EXCEL / CSV EXPORT — WHAT ACCOUNTANTS ACTUALLY HAVE          */
/* ------------------------------------------------------------------ */

/**
 * Column aliases, keyed on the header with everything but letters and
 * digits removed and the rest lower-cased.
 *
 * ⚠️ THE NORMALISATION IS WHAT MAKES THIS SURVIVE CONTACT WITH A REAL
 * FILE. The portal's own headers carry a rupee sign in brackets
 * (`Invoice Value(₹)`), a stray non-breaking space, and a line break in
 * at least one build. Matching on the exact string means the import fails
 * on a file that looks identical to the one that worked, and nobody can
 * see the difference because the difference is invisible by construction.
 */
const COLUMN_ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  supplierGstin: ["gstinofsupplier", "suppliergstin", "gstin", "ctin", "gstinsupplier"],
  supplierName: [
    "tradelegalname",
    "tradename",
    "legalname",
    "suppliername",
    "nameofsupplier",
    "supplierlegalname",
  ],
  invoiceNumber: [
    "invoicenumber",
    "invoiceno",
    "documentnumber",
    "docno",
    "notenumber",
    "noteno",
    "billofentrynumber",
    "boenumber",
    "inum",
  ],
  invoiceDate: [
    "invoicedate",
    "documentdate",
    "notedate",
    "docdate",
    "billofentrydate",
    "boedate",
    "date",
  ],
  invoiceValue: [
    "invoicevalue",
    "totalinvoicevalue",
    "documentvalue",
    "notevalue",
    "invoicevaluers",
  ],
  placeOfSupply: ["placeofsupply", "pos"],
  reverseCharge: ["supplyattractreversecharge", "reversecharge", "reversechargeyn"],
  rate: ["rate", "ratepercent", "taxrate"],
  taxableValue: ["taxablevalue", "taxablevaluers", "assessablevalue"],
  igst: ["integratedtax", "igst", "integratedtaxpaid", "igstamount"],
  cgst: ["centraltax", "cgst", "cgstamount"],
  sgst: ["stateuttax", "statetax", "sgst", "sgstutgst", "sgstamount", "utgst"],
  cess: ["cess", "cessamount", "cessrs"],
  filingPeriod: [
    "gstr1iffgstr5period",
    "gstr1ifgstr5period",
    "gstr1period",
    "filingperiod",
    "supplierfilingperiod",
    "returnperiod",
  ],
  filingDate: [
    "gstr1iffgstr5filingdate",
    "gstr1ifgstr5filingdate",
    "filingdate",
    "supplierfilingdate",
    "gstr1filingdate",
  ],
  itcAvailability: ["itcavailability", "itcavailable", "itcavl", "availabilityofitc"],
  itcReason: ["reason", "reasonforitcunavailability", "itcreason"],
  documentType: ["invoicetype", "notetype", "documenttype", "type", "notesupplytype"],
  originalInvoiceNumber: [
    "originalinvoicenumber",
    "originalnotenumber",
    "originalinvoiceno",
    "originaldocumentnumber",
  ],
  originalInvoiceDate: [
    "originalinvoicedate",
    "originalnotedate",
    "originaldocumentdate",
  ],
  section: ["section", "table", "sectionname", "gstr2bsection"],
  cancelled: ["cancelled", "iscancelled", "cancellationflag"],
});

/**
 * ⚠️ THE AMENDMENT SECTIONS, LISTED RATHER THAN DERIVED FROM THE NAME.
 * `"b2ba".endsWith("a")` happens to be true for all four of them today
 * and would also be true for a future `impga` — but it is true for
 * nothing else by design rather than by accident, and a section named
 * `sez_a` or `ecom_a` would quietly join the set. A list is checked
 * against the portal's schema; a suffix test is checked against nothing.
 */
const AMENDMENT_SECTIONS: ReadonlySet<Gstr2bSection> = new Set([
  "b2ba",
  "cdnra",
  "isda",
]);

const SECTION_VALUES = new Set<string>([
  "b2b",
  "b2ba",
  "cdnr",
  "cdnra",
  "isd",
  "isda",
  "impg",
  "impgsez",
]);

export function normaliseHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * ⭐ A delimited export of a GSTR-2B.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE PORTAL'S SHEET HAS ONE ROW PER **TAX RATE**, NOT PER INVOICE
 * ══════════════════════════════════════════════════════════════════════
 * A three-rate invoice occupies three lines, and every one of them
 * REPEATS the invoice number, the date, and — the trap — the INVOICE
 * VALUE. Summing the value column triples the document value on that
 * invoice, which then fails every value comparison in the engine and
 * reports a perfectly ordinary invoice as a mismatch.
 *
 * So the rows are grouped by (section, supplier, canonical number, date):
 * the taxable value and the tax heads are SUMMED, and the invoice value
 * is taken ONCE. Where two lines of one group disagree about the invoice
 * value, the larger is kept and a warning names the invoice — that is a
 * genuinely malformed sheet and it should be looked at, not guessed at.
 */
export function parseGstr2bDelimited(
  text: string,
  options?: {
    /** The section, when the sheet does not carry a column for it. */
    defaultSection?: Gstr2bSection;
    /** GSTIN of the registration this statement belongs to. */
    gstin?: string;
    /** `YYYY-MM` of the statement. */
    returnPeriod?: string;
    dateOrder?: "day-first" | "month-first";
    delimiter?: string;
  },
): Gstr2bParseResult {
  const issues: Gstr2bParseIssue[] = [];
  const dateOrder = options?.dateOrder ?? "day-first";

  const table = parseDelimitedText(text, options?.delimiter);
  if (table.length === 0) {
    issues.push({
      path: "$",
      message: "The file is empty — there is no header row and no data.",
      severity: "error",
    });
    return { ok: false, statement: null, rows: [], issues };
  }

  /* --- Find the header row -------------------------------------- */
  //
  // ⚠️ IT IS NOT ALWAYS THE FIRST LINE. The portal's Excel puts a title
  // and the GSTIN in the first few rows and the real header below them.
  // Scanning for the first row that carries a recognisable invoice-number
  // column is what makes both the raw export and a tidied one work.
  let headerIndex = -1;
  for (let i = 0; i < Math.min(table.length, 12); i += 1) {
    const normalised = table[i]!.map(normaliseHeader);
    const hasNumber = normalised.some((h) =>
      COLUMN_ALIASES.invoiceNumber!.includes(h),
    );
    const hasTax = normalised.some(
      (h) =>
        COLUMN_ALIASES.taxableValue!.includes(h) ||
        COLUMN_ALIASES.igst!.includes(h) ||
        COLUMN_ALIASES.cgst!.includes(h),
    );
    if (hasNumber && hasTax) {
      headerIndex = i;
      break;
    }
  }

  if (headerIndex === -1) {
    issues.push({
      path: "$",
      message:
        "No header row was recognised in the first twelve lines. A GSTR-2B export " +
        "must have a column for the invoice/document number and at least one tax " +
        "column (taxable value, integrated tax or central tax). If this file has " +
        "been re-arranged by hand, restore the portal's own header row.",
      severity: "error",
    });
    return { ok: false, statement: null, rows: [], issues };
  }

  const headers = table[headerIndex]!.map(normaliseHeader);
  const columnOf = (field: keyof typeof COLUMN_ALIASES): number => {
    const aliases = COLUMN_ALIASES[field]!;
    for (let i = 0; i < headers.length; i += 1) {
      if (aliases.includes(headers[i]!)) return i;
    }
    return -1;
  };

  const col = {
    supplierGstin: columnOf("supplierGstin"),
    supplierName: columnOf("supplierName"),
    invoiceNumber: columnOf("invoiceNumber"),
    invoiceDate: columnOf("invoiceDate"),
    invoiceValue: columnOf("invoiceValue"),
    placeOfSupply: columnOf("placeOfSupply"),
    reverseCharge: columnOf("reverseCharge"),
    rate: columnOf("rate"),
    taxableValue: columnOf("taxableValue"),
    igst: columnOf("igst"),
    cgst: columnOf("cgst"),
    sgst: columnOf("sgst"),
    cess: columnOf("cess"),
    filingPeriod: columnOf("filingPeriod"),
    filingDate: columnOf("filingDate"),
    itcAvailability: columnOf("itcAvailability"),
    itcReason: columnOf("itcReason"),
    documentType: columnOf("documentType"),
    originalInvoiceNumber: columnOf("originalInvoiceNumber"),
    originalInvoiceDate: columnOf("originalInvoiceDate"),
    section: columnOf("section"),
    cancelled: columnOf("cancelled"),
  };

  if (col.invoiceDate === -1) {
    issues.push({
      path: `row ${headerIndex + 1}`,
      message:
        "The sheet has no invoice/document date column. The date is part of the " +
        "match key and decides which tax period a credit belongs to.",
      severity: "error",
    });
    return { ok: false, statement: null, rows: [], issues };
  }

  const cell = (row: string[], index: number): string | null => {
    if (index < 0 || index >= row.length) return null;
    const value = row[index]!.trim();
    return value === "" ? null : value;
  };

  /* --- Read the lines, grouping by document ---------------------- */

  type Group = ParsedGstr2bRow & { declaredValueSeen: bigint | null };
  const groups = new Map<string, Group>();
  const order: string[] = [];

  for (let r = headerIndex + 1; r < table.length; r += 1) {
    const row = table[r]!;
    const where = `row ${r + 1}`;

    // A blank line, or a trailing "Total" band. Both are ordinary in a
    // spreadsheet export and neither is an error.
    if (row.every((v) => v.trim() === "")) continue;

    const number = cell(row, col.invoiceNumber);
    const rawDate = cell(row, col.invoiceDate);
    if (!number && !rawDate) continue;

    if (!number) {
      issues.push({
        path: where,
        message: "This line has a date but no document number, so it cannot be matched.",
        severity: "error",
      });
      continue;
    }

    const day = portalDateToCivilDay(rawDate, dateOrder);
    if (!day) {
      issues.push({
        path: where,
        message:
          `"${rawDate ?? ""}" is not a date this parser recognises. The portal writes ` +
          `DD-MM-YYYY; ISO (YYYY-MM-DD) is also accepted.`,
        severity: "error",
      });
      continue;
    }

    const sectionCell = cell(row, col.section)?.toLowerCase().replace(/[^a-z0-9]/g, "");
    const section: Gstr2bSection =
      sectionCell && SECTION_VALUES.has(sectionCell)
        ? (sectionCell as Gstr2bSection)
        : (options?.defaultSection ?? "b2b");

    const gstin = cell(row, col.supplierGstin)?.toUpperCase() ?? null;
    if (!gstin && section !== "impg") {
      issues.push({
        path: where,
        message:
          `Document "${number}" has no supplier GSTIN. Only an import of goods (a ` +
          `bill of entry) legitimately has none — every other row without one has ` +
          `had its columns mapped wrongly, and would sit in the worklist forever as ` +
          `an unmatched supplier who does not exist.`,
        severity: "error",
      });
      continue;
    }

    const key = `${section}|${gstin ?? ""}|${canonicaliseInvoiceNumber(number)}|${day}`;

    const taxable = rupeesToPaise(cell(row, col.taxableValue)) ?? 0n;
    const cgst = rupeesToPaise(cell(row, col.cgst)) ?? 0n;
    const sgst = rupeesToPaise(cell(row, col.sgst)) ?? 0n;
    const igst = rupeesToPaise(cell(row, col.igst)) ?? 0n;
    const cess = rupeesToPaise(cell(row, col.cess)) ?? 0n;
    const declared = rupeesToPaise(cell(row, col.invoiceValue));
    const rateBps = rupeesToPaise(cell(row, col.rate));

    let group = groups.get(key);
    if (!group) {
      const itcCell = cell(row, col.itcAvailability)?.toUpperCase() ?? null;
      const originalNumber = cell(row, col.originalInvoiceNumber);
      const isAmendment = AMENDMENT_SECTIONS.has(section);

      if (isAmendment && !originalNumber) {
        issues.push({
          path: where,
          message:
            `Document "${number}" is in an amendment section (${section}) but names ` +
            `no original document. An amendment SUPERSEDES the original; without the ` +
            `original's number the credit would be counted twice.`,
          severity: "error",
        });
        continue;
      }

      group = {
        section,
        supplierGstin: gstin,
        supplierLegalName: cell(row, col.supplierName),
        supplierTradeName: cell(row, col.supplierName),
        invoiceNumber: number,
        normalisedNumber: normaliseInvoiceNumber(number),
        invoiceDate: day,
        documentType: cell(row, col.documentType),
        documentValueMinor: 0n,
        taxableValueMinor: 0n,
        cgstMinor: 0n,
        sgstMinor: 0n,
        igstMinor: 0n,
        cessMinor: 0n,
        placeOfSupplyCode: cell(row, col.placeOfSupply)?.slice(0, 2) ?? null,
        isReverseCharge: (cell(row, col.reverseCharge) ?? "N").toUpperCase().startsWith("Y"),
        itcAvailable:
          itcCell !== null && (itcCell === "N" || itcCell.startsWith("NO"))
            ? "not_available"
            : "available",
        itcUnavailableReason: cell(row, col.itcReason),
        supplierFilingPeriod: portalPeriodToTaxPeriod(cell(row, col.filingPeriod)),
        supplierFilingDate: portalDateToCivilDay(cell(row, col.filingDate), dateOrder),
        isAmendment,
        originalInvoiceNumber: originalNumber,
        originalInvoiceDate: portalDateToCivilDay(
          cell(row, col.originalInvoiceDate),
          dateOrder,
        ),
        isCancelled: (cell(row, col.cancelled) ?? "").toUpperCase().startsWith("Y"),
        rateBreakup: [],
        sourceRef: where,
        declaredValueSeen: null,
      };
      groups.set(key, group);
      order.push(key);
    }

    group.taxableValueMinor += taxable;
    group.cgstMinor += cgst;
    group.sgstMinor += sgst;
    group.igstMinor += igst;
    group.cessMinor += cess;
    group.rateBreakup.push({
      rateBps: rateBps === null ? 0 : Number(rateBps),
      taxableValueMinor: taxable.toString(),
    });

    // ⭐ The invoice value is REPEATED on every rate line, never split.
    if (declared !== null) {
      if (group.declaredValueSeen === null) {
        group.declaredValueSeen = declared;
      } else if (group.declaredValueSeen !== declared) {
        issues.push({
          path: where,
          message:
            `Document "${number}" gives two different invoice values on its rate ` +
            `lines (${group.declaredValueSeen} and ${declared} paise). The portal ` +
            `repeats the same value on every line, so this sheet has been edited. ` +
            `The larger value has been kept — check it against the invoice.`,
          severity: "warning",
        });
        if (declared > group.declaredValueSeen) group.declaredValueSeen = declared;
      }
    }
  }

  const rows: ParsedGstr2bRow[] = order.map((key) => {
    const group = groups.get(key)!;
    const { declaredValueSeen, ...rest } = group;
    return {
      ...rest,
      documentValueMinor:
        declaredValueSeen ??
        rest.taxableValueMinor +
          rest.cgstMinor +
          rest.sgstMinor +
          rest.igstMinor +
          rest.cessMinor,
    };
  });

  const statement: Gstr2bStatementFacts | null =
    options?.gstin && options?.returnPeriod
      ? {
          gstin: options.gstin,
          returnPeriod: options.returnPeriod,
          generatedOn: null,
          version: null,
        }
      : null;

  if (!statement) {
    issues.push({
      path: "$",
      message:
        "A delimited export does not say which GSTIN or which period it is for — the " +
        "portal puts those in the sheet's title band, which most exports lose. Both " +
        "must be supplied with the import, because a statement filed against the " +
        "wrong registration sets credit in the wrong state's ledger.",
      severity: "error",
    });
  }

  const hasError = issues.some((i) => i.severity === "error");
  return { ok: !hasError, statement, rows: hasError ? [] : rows, issues };
}

/**
 * A minimal RFC 4180 reader: quoted fields, doubled quotes inside them,
 * embedded commas and newlines, CRLF or LF.
 *
 * ⚠️ WRITTEN RATHER THAN SPLIT ON COMMAS, AND THE REASON IS A REAL FIELD
 * IN A REAL FILE. A supplier's legal name is `"Sharma & Sons, Builders"`.
 * `line.split(",")` shifts every column after it by one on that row and
 * ONLY on that row — so the tax lands in the place-of-supply column, the
 * import "succeeds", and one invoice in a thousand is silently wrong.
 *
 * ⚠️ THE DELIMITER IS SNIFFED because an Excel "Save as CSV" on a machine
 * with a comma decimal separator writes SEMICOLONS, and that is the file
 * an accountant in a multinational's Indian subsidiary sends.
 */
export function parseDelimitedText(text: string, delimiter?: string): string[][] {
  const source = text.replace(/^﻿/, "");
  const sep = delimiter ?? sniffDelimiter(source);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  while (i < source.length) {
    const ch = source[i]!;

    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === sep) {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += ch === "\r" && source[i + 1] === "\n" ? 2 : 1;
      continue;
    }

    field += ch;
    i += 1;
  }

  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function sniffDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const counts: [string, number][] = [
    [",", (firstLine.match(/,/g) ?? []).length],
    [";", (firstLine.match(/;/g) ?? []).length],
    ["\t", (firstLine.match(/\t/g) ?? []).length],
    ["|", (firstLine.match(/\|/g) ?? []).length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0]![1] > 0 ? counts[0]![0] : ",";
}
