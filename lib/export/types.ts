/**
 * Ordence — ⭐⭐⭐ THE ONE SHAPE EVERY EXPORT IS BUILT FROM
 * Version: v1.73.0-alpha · Wave 5
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS FILE EXISTS, AND WHY IT IS PURE DATA
 * ══════════════════════════════════════════════════════════════════════
 * Before this wave the product had THREE exporters and no exporting:
 *
 *   `server/backup/export.ts`      22 allowlisted tables → one JSON blob
 *   `server/dpdp/export-service.ts` one person's rows    → one JSON blob
 *   `server/tally/exporter.ts`      vouchers and masters → Tally XML
 *
 * Each is correct for its own job and NONE of them can put a purchase
 * register in front of an accountant as a spreadsheet. Every screen in
 * the product that shows a table shows it only on the screen.
 *
 * ⚠️ AND THE THREE DISAGREE ABOUT MONEY. `server/backup/export.ts` emits
 * the raw minor-unit integer with no currency beside it; the Tally
 * exporter divides by 100. Divide by 100 is WRONG BY A FACTOR OF TEN for
 * KWD/BHD/OMR/JOD/TND/LYD/IQD and WRONG BY A FACTOR OF 100 for JPY, which
 * is the exact defect `lib/fx/currency.ts` was written to end. A fourth
 * exporter that reinvented the arithmetic would be the fourth chance to
 * get it wrong, so every writer downstream of this file is FORBIDDEN a
 * division: it receives a `bigint` and a currency code and calls
 * `formatMinorPlain`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE MODEL: A WORKBOOK IS DATASETS, A DATASET IS COLUMNS AND ROWS
 * ══════════════════════════════════════════════════════════════════════
 * Deliberately flat. Not because reports are flat — they are not — but
 * because a shape that six formats must all render is the shape all six
 * can render WITHOUT ONE OF THEM QUIETLY DROPPING SOMETHING. CSV has no
 * concept of a nested row. Giving the model nesting would mean CSV
 * silently flattening it, and "the CSV was missing the line items" is a
 * bug the customer finds in front of their auditor.
 *
 * A report with detail lines is therefore TWO datasets in one workbook,
 * joined by a key column, and every format renders both: XLSX as two
 * sheets, CSV as two files in a zip, PDF as two tables, JSON as two
 * arrays. Nothing is dropped and nothing is invented.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ NO `server-only` HERE
 * ══════════════════════════════════════════════════════════════════════
 * This file and every writer beside it is pure: no database, no clock, no
 * `process.env`. The clock arrives as `generatedAt` on the workbook so an
 * export is reproducible and so the tests can assert byte-for-byte.
 */

/**
 * ⭐ WHAT A COLUMN HOLDS. This is not a display hint — it decides the
 * cell TYPE in the formats that have types, and getting it wrong is how
 * an invoice number like `0012345` becomes `12345` in Excel or a GSTIN
 * gets read as scientific notation.
 */
export type ColumnKind =
  /** Free text. Always quoted/inline-string. Never coerced. */
  | "text"
  /**
   * 🔴 TEXT THAT LOOKS LIKE A NUMBER AND MUST NOT BE ONE. Invoice
   * numbers, GSTINs, PANs, HSN codes, IFSCs, phone numbers, PIN codes.
   * Excel destroys every one of these on open: leading zeroes vanish,
   * long digit strings become 1.23457E+14. This kind forces a text cell
   * in XLSX, where the format can say so.
   *
   * 🔴 CSV CANNOT SAY SO — THE FORMAT HAS NO TYPES AT ALL — so
   * `lib/export/csv.ts` does not try a trick, it prints a note telling
   * the reader that a code column is present and that XLSX is the format
   * that survives Excel. A silent corruption the customer discovers when
   * their GSTIN is rejected is worse than a sentence at the top of the
   * file.
   */
  | "code"
  /** A whole count. Integer cell. */
  | "integer"
  /** A decimal that is not money — a quantity, a rate, a percentage. */
  | "number"
  /**
   * ⭐⭐ MINOR UNITS. The value is a `bigint` and the row MUST carry the
   * currency in the column named by `currencyKey`. There is no default
   * currency and no default exponent; see the header.
   */
  | "money"
  /** A calendar date with no time. Rendered ISO `YYYY-MM-DD`. */
  | "date"
  /** An instant. Rendered ISO 8601 with offset. */
  | "datetime"
  | "boolean";

export type Column = {
  readonly key: string;
  readonly label: string;
  readonly kind: ColumnKind;
  /**
   * 🔴 REQUIRED WHEN `kind` IS `money`, AND `lib/export/values.ts`
   * REFUSES THE ROW OTHERWISE. It names another column in the same
   * dataset whose value is the ISO-4217 code for this amount. A money
   * column with no currency beside it is the defect `lib/fx/currency.ts`
   * exists to prevent, restated as a spreadsheet.
   */
  readonly currencyKey?: string;
  /** Decimal places for `number`. Ignored for every other kind. */
  readonly decimals?: number;
  /** Column width hint in characters. Used by XLSX and PDF only. */
  readonly width?: number;
  /**
   * ⚠️ TRUE WHEN THIS COLUMN HOLDS PERSONAL DATA. Not cosmetic: the
   * export log records which classes left the building, because s.8(5)
   * DPDPA makes the Data Fiduciary answerable for what it disclosed and
   * "we do not keep a record of exports" is not an answer.
   */
  readonly personal?: boolean;
};

export type CellValue =
  | string
  | number
  | bigint
  | boolean
  | Date
  | null
  | undefined;

export type Row = Readonly<Record<string, CellValue>>;

export type Dataset = {
  /** Stable machine key. Becomes the sheet name, the file name in a zip. */
  readonly key: string;
  /** Human title. Becomes the sheet tab, the PDF heading, the DOCX heading. */
  readonly title: string;
  readonly columns: readonly Column[];
  readonly rows: readonly Row[];
  /**
   * ⚠️ SENTENCES PRINTED WITH THE DATA. Use them for the things a number
   * cannot carry: "excludes cancelled invoices", "as at the period close",
   * "amounts are in the workspace's functional currency". A caveat that
   * lives only in the screen's tooltip does not survive an export, and the
   * spreadsheet is what gets emailed to the auditor.
   */
  readonly notes?: readonly string[];
  /**
   * ⭐ SET ONLY WHEN THIS DATASET HAS A REAL TALLY MAPPING. The Tally
   * writer refuses a dataset without one rather than emitting an XML
   * document Tally will reject on import — see `lib/export/tally.ts`.
   */
  readonly tally?: TallyMapping;
};

/**
 * ⚠️ A DELIBERATELY NARROW MAPPING, AND THE NARROWNESS IS THE FEATURE.
 *
 * Tally's schema is not "any table". It is masters and vouchers, and a
 * voucher must BALANCE — `lib/tally/vouchers.ts` refuses one that does
 * not, by construction, which is the single best property that
 * integration has.
 *
 * 🔴 SO A GENERIC "TURN THIS GRID INTO VOUCHERS" MAPPING IS NOT OFFERED.
 * A flat dataset has one amount per row and a voucher needs both sides;
 * inventing the contra ledger would produce a file that imports cleanly
 * and posts the customer's purchases to Suspense. `server/tally/exporter.ts`
 * already builds vouchers from the actual ledger legs, where both sides
 * are real, and `vouchers-elsewhere` is how a dataset points at it
 * instead of pretending.
 *
 * ⭐ MASTERS ARE DIFFERENT and are supported here: a ledger master is a
 * name and a parent group, both of which a flat dataset genuinely has.
 */
export type TallyMapping =
  | {
      readonly kind: "ledger-master";
      /** Column holding the ledger name exactly as it should appear. */
      readonly nameKey: string;
      /**
       * A key of `TALLY_PRIMARY_GROUPS`, the same for every row.
       * ⚠️ NOT a display label — "Duties and Taxes" is a NEW group Tally
       * will happily create and none of its GST reports will look in.
       *
       * 🔴 EXACTLY ONE OF `parentGroup` AND `parentGroupKey` MUST BE SET.
       * A chart of accounts is not one group, so a literal would be a
       * guess; a mapping table the accountant filled in is not a guess, so
       * it gets the column form. Deriving a group from an account type —
       * revenue becomes Indirect Incomes, always — is the guess that puts
       * a workspace's sales into the wrong Tally report while the balance
       * sheet still balances, which is why neither form derives anything.
       */
      readonly parentGroup?: string;
      /** Column holding the group key, one per row. See above. */
      readonly parentGroupKey?: string;
      /** Column holding the opening balance in minor units, if any. */
      readonly openingBalanceKey?: string;
      readonly currencyKey?: string;
      /** Column holding the party GSTIN, for party ledgers. */
      readonly gstinKey?: string;
      readonly isParty?: boolean;
    }
  | {
      readonly kind: "vouchers-elsewhere";
      /** The screen that produces the correct, balanced Tally export. */
      readonly where: string;
    };

export type Workbook = {
  readonly title: string;
  /** ⚠️ Injected, never `new Date()` inside a writer. See the header. */
  readonly generatedAt: Date;
  readonly datasets: readonly Dataset[];
  /** Workspace name, period, filters applied — printed on every format. */
  readonly context?: Readonly<Record<string, string>>;
};

/**
 * ⭐ WHAT A WRITER HANDS BACK. `notes` is not decoration — it is where a
 * format states what it could not carry, and `server/export/log.ts`
 * persists it. A lossy export that does not say so is the defect pattern
 * this codebase keeps finding: built, and quietly wrong.
 */
export type RenderedExport = {
  readonly bytes: Uint8Array;
  readonly extension: string;
  readonly mediaType: string;
  readonly notes: readonly string[];
};
