import "server-only";

/**
 * Ordence — ⭐⭐ THE PERSISTENCE SEAM: EXACTLY WHAT TO WRITE
 * Wave 15 / Track E — GST, TDS and statutory correctness
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE IS FOR
 * ══════════════════════════════════════════════════════════════════════
 * `server/tax/compute.ts` turns a quote into a `PersistableTax`. This
 * turns a `PersistableTax` into the literal column values that
 * `sales_invoices` and `sales_invoice_lines` accept — the shape the SQL
 * in this wave insists on:
 *
 *   · 0146 — the rate pin is a COMPOSITE key onto `(id, tenant_id)`, so a
 *     pin must be this tenant's own row. Taking it from the engine's
 *     `rateByLine` is what makes that true by construction rather than by
 *     luck.
 *   · 0147 — every line must RECOMPUTE from its own taxable value and
 *     rate, the head must match the parent's `is_inter_state`, and the
 *     pinned period must cover the parent's date. All three are
 *     satisfied here or the write is refused here, with a sentence.
 *   · 0148 — the backfill classifies existing rows against exactly these
 *     rules, so a row written by this function is one the backfill would
 *     have called clean.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ SIDE-EFFECT-FREE, AND THAT IS THE DESIGN, NOT A LIMITATION
 * ══════════════════════════════════════════════════════════════════════
 * This module writes nothing. It has no `withTenant`, no `insert`, no
 * transaction. It returns values.
 *
 * The reason is ownership: the two functions that SHOULD call it live in
 * `server/actions/`, which Track E may not edit. A seam that performed
 * the write would need the call site restructured around it — a large,
 * arguable diff. A seam that returns values means the patch is:
 *
 *     const write = buildTaxWriteForSalesInvoice({ tax, invoiceDate });
 *     ...
 *     .values({ ...write.header, /* the caller's own identity fields *\/ })
 *
 * — a diff a reviewer can hold in their head, which is the difference
 * between a patch that lands and a patch that is discussed.
 *
 * TODO(PATCH-REQUEST-E): the call sites this is written for, by name —
 *   · `server/actions/sales-invoices.ts` `createInvoiceFromOrder` (~L197
 *     header, ~L237 lines) — today it builds the header and line values
 *     inline and computes `lineTotalMinor` as
 *     `taxable + cgst + sgst + igst + cess`, which is WRONG for a
 *     reverse-charge line: it adds tax the customer does not owe.
 *     `buildTaxWriteForSalesInvoice` gets it from the engine instead.
 *   · `server/actions/sales-invoices.ts` credit-note creation (~L1229) —
 *     the same translation again, third copy.
 *   · `server/actions/orders.ts` `lineValuesFor` (~L166) — the
 *     `hsnSacRateId: line.hsnSacRateId ?? null` pass-through of a
 *     CLIENT-SUPPLIED rate pin. See the header of
 *     `server/tax/compute.ts`.
 *   · `server/actions/invoicing.ts` (~L228) — the platform's own billing
 *     documents, which take the same shape and do the same translation.
 */

import { applyRateBps } from "@/lib/billing/money";
import type { PersistableTax, PersistableTaxLine } from "./compute";
import type { RecordTaxDecisionsInput, TaxDecisionLine } from "./audit";

export class TaxWriteRefused extends Error {
  readonly reasons: readonly string[];
  constructor(reasons: readonly string[]) {
    super(reasons.join(" "));
    this.name = "TaxWriteRefused";
    this.reasons = reasons;
  }
}

/* ------------------------------------------------------------------ */
/* THE COLUMN VALUES                                                   */
/* ------------------------------------------------------------------ */

/**
 * The `sales_invoices` columns this wave's SQL cares about.
 *
 * ⚠️ DELIBERATELY NOT THE WHOLE ROW. `invoice_number`, `company_id`,
 * `financial_year`, `status`, `created_by` and the rest belong to the
 * caller and to `server/actions/sales-invoices.ts`'s own rules — a
 * numbering rule in a tax module is a numbering rule nobody will find.
 * Spread this over the caller's own object; every key here is one the
 * caller would otherwise be computing by hand.
 */
export type SalesInvoiceTaxHeaderWrite = {
  placeOfSupplyCode: string;
  placeOfSupplyBasis: string;
  isInterState: boolean;
  isUnionTerritory: boolean;
  supplierRegistrationId: string;
  /**
   * ⚠️ TRUE WHEN **ANY** LINE IS ON REVERSE CHARGE, because the header
   * flag drives Rule 46(p)'s "tax payable on reverse charge basis" legend
   * and the legend is a property of the DOCUMENT. A document with one
   * reverse-charge line among ten must carry it.
   */
  isReverseCharge: boolean;

  subtotalMinor: bigint;
  discountMinor: bigint;
  taxableValueMinor: bigint;
  cgstMinor: bigint;
  sgstMinor: bigint;
  igstMinor: bigint;
  cessMinor: bigint;
  roundOffMinor: bigint;
  totalMinor: bigint;
};

/**
 * The `sales_invoice_lines` tax columns, plus the two keys a caller needs
 * to marry them to its own rows.
 *
 * ⚠️ `description`, `quantity`, `uom`, `unit_price_minor`, `order_line_id`,
 * `sku` and `asset_id` are NOT here and are not omissions. They are facts
 * about WHAT was supplied; nothing in a tax computation knows them, and a
 * module that invented them would be inventing the document.
 */
export type SalesInvoiceTaxLineWrite = {
  /** The caller's own line key, so it can merge its identity fields. */
  key: string;
  lineNo: number;

  hsnSacCodeId: string | null;
  /** ⭐ From the engine's resolved registry row. Never from caller input. */
  hsnSacRateId: string | null;
  hsnSacCode: string | null;
  taxRateBps: number;
  cessRateBps: number;

  discountMinor: bigint;
  taxableValueMinor: bigint;
  cgstMinor: bigint;
  sgstMinor: bigint;
  igstMinor: bigint;
  cessMinor: bigint;
  lineTotalMinor: bigint;
};

export type SalesInvoiceTaxWrite = {
  header: SalesInvoiceTaxHeaderWrite;
  lines: SalesInvoiceTaxLineWrite[];
  /**
   * ⚠️ THE LINE-LEVEL REVERSE-CHARGE FLAGS, KEYED BY LINE KEY, BECAUSE
   * `sales_invoice_lines` HAS NO COLUMN FOR THEM.
   *
   * 🔴 That is a real gap and it is reported rather than papered over.
   * `sales_invoices.is_reverse_charge` is a HEADER boolean, so a document
   * mixing forward-charge and reverse-charge lines cannot say which lines
   * are which — and Rule 46(p) is a per-supply rule. The information is
   * handed back here so the caller can at least write it to the decision
   * trail (`tax_decisions.is_reverse_charge` IS per line), and a column on
   * the line table is requested in PATCH-REQUEST-E.md.
   */
  reverseChargeByKey: Record<string, boolean>;
};

/* ------------------------------------------------------------------ */
/* ⭐ THE SEAM                                                          */
/* ------------------------------------------------------------------ */

/**
 * Turn a computed tax into the values to write.
 *
 * ⚠️ REFUSES BEFORE THE DATABASE DOES. Every check below is one SQL 0146
 * or 0147 would also make, and each is repeated here for one reason: the
 * trigger's message names a line number and a constraint, and arrives
 * after the transaction has done other work. This one names the field and
 * arrives in the caller's own stack frame, where the fix is.
 *
 * ⭐ IT DOES NOT SOFTEN ANY OF THEM. The database stays authoritative;
 * this is a first opinion, never a substitute. A check that passes here
 * and fails there is a defect in this function, not a reason to relax the
 * constraint.
 *
 * @throws {TaxWriteRefused} with one sentence per problem.
 */
export function buildTaxWriteForSalesInvoice(args: {
  tax: PersistableTax;
  /**
   * ⭐ The DOCUMENT'S date, `YYYY-MM-DD`. Checked against every pinned
   * rate period, because SQL 0147 §C2 checks the same thing at COMMIT and
   * "the pin covers the document's date" is the entire meaning of a pin.
   */
  invoiceDate: string;
  /**
   * Line numbers, keyed by line key. Rule 46(b) numbers the DOCUMENT; the
   * line numbers are ours and only have to be unique per invoice
   * (`sales_invoice_lines_line_no_key`). Omit to number 1..n in the order
   * the engine returned.
   */
  lineNoByKey?: Readonly<Record<string, number>>;
  /**
   * ⚠️ The rate periods, keyed by line key, so the pin can be checked
   * against the document's date HERE rather than at COMMIT. Optional
   * because a caller holding only a `PersistableTax` cannot supply it —
   * omitting it does not weaken the database's check, it only defers the
   * message.
   */
  ratePeriodByKey?: Readonly<Record<string, { from: string; to: string | null }>>;
}): SalesInvoiceTaxWrite {
  const { tax, invoiceDate } = args;
  const problems: string[] = [];
  const day = invoiceDate.slice(0, 10);

  if (tax.lines.length === 0) {
    throw new TaxWriteRefused([
      "This document has no lines. An invoice with nothing on it is not a tax " +
        "invoice, and Rule 46 has no field it could satisfy.",
    ]);
  }

  const lines: SalesInvoiceTaxLineWrite[] = tax.lines.map((line, index) => {
    checkLine({
      line,
      day,
      isInterState: tax.header.isInterState,
      ratePeriod: args.ratePeriodByKey?.[line.key],
      problems,
    });

    return {
      key: line.key,
      lineNo: args.lineNoByKey?.[line.key] ?? index + 1,
      hsnSacCodeId: line.hsnSacCodeId,
      hsnSacRateId: line.hsnSacRateId,
      hsnSacCode: line.hsnSacCode,
      taxRateBps: line.taxRateBps,
      cessRateBps: line.cessRateBps,
      discountMinor: line.discountMinor,
      taxableValueMinor: line.taxableValueMinor,
      cgstMinor: line.cgstMinor,
      sgstMinor: line.sgstMinor,
      igstMinor: line.igstMinor,
      cessMinor: line.cessMinor,
      /**
       * ⭐ FROM THE ENGINE, NOT RE-ADDED HERE. `taxable + cgst + sgst +
       * igst + cess` — which is what three call sites compute today — is
       * right for a forward-charge line and WRONG for a reverse-charge
       * one, where the customer owes the value and none of the tax.
       */
      lineTotalMinor: line.lineTotalMinor,
    };
  });

  /* --- ⚠️ LINE NUMBERS MUST BE UNIQUE ------------------------------- */

  const seenLineNo = new Set<number>();
  for (const line of lines) {
    if (seenLineNo.has(line.lineNo)) {
      problems.push(
        `Line number ${line.lineNo} is used twice. ` +
          `\`sales_invoice_lines_line_no_key\` is unique per invoice, so the ` +
          `second row is refused and the document is written with a line missing.`,
      );
    }
    seenLineNo.add(line.lineNo);
  }

  /* --- ⚠️ THE HEADER MUST EQUAL THE LINES --------------------------- */

  let taxable = 0n;
  let cgst = 0n;
  let sgst = 0n;
  let igst = 0n;
  let cess = 0n;
  let anyReverseCharge = false;

  for (const line of tax.lines) {
    taxable += line.taxableValueMinor;
    if (line.isReverseCharge) {
      anyReverseCharge = true;
      continue;
    }
    cgst += line.cgstMinor;
    sgst += line.sgstMinor;
    igst += line.igstMinor;
    cess += line.cessMinor;
  }

  const headerChecks: readonly (readonly [string, bigint, bigint])[] = [
    ["taxable_value_minor", taxable, tax.header.taxableValueMinor],
    ["cgst_minor", cgst, tax.header.cgstMinor],
    ["sgst_minor", sgst, tax.header.sgstMinor],
    ["igst_minor", igst, tax.header.igstMinor],
    ["cess_minor", cess, tax.header.cessMinor],
  ];

  /**
   * 🔴 CORRECTED IN WAVE 17, AND THE CORRECTION IS THE INTERESTING PART.
   *
   * This block used to say the header/lines disagreement "is refused at
   * COMMIT by the reconciliation trigger installed by SQL 0049", framing
   * the check below as belt-and-braces over a database guarantee.
   *
   * ⚠️ THERE IS NO SUCH TRIGGER ON `sales_invoices`. `pg_trigger` carries
   * `invoices_gst_reconciles`, `invoice_lines_gst_reconciles` and the
   * two purchase equivalents — and nothing at all on `sales_invoices` or
   * `sales_invoice_lines`. `tests/security/tax-audit-trail.test.ts` found
   * that by looking, not by reading.
   *
   * ⭐ SO THIS IS BELT, NOT BELT AND BRACES, AND SAYING OTHERWISE WAS THE
   * WORSE HALF OF THE ERROR. A comment claiming a database guarantee
   * that does not exist is how somebody later writes a second caller
   * that bypasses this function, reasons that the database will catch a
   * mistake, and is wrong. 0147 makes each LINE recompute; nothing makes
   * the sales-invoice HEADER agree with its own lines. That is a
   * migration Track E has no number for in this wave — it is
   * PATCH-REQUEST-E.md P13.
   */
  for (const [column, expected, actual] of headerChecks) {
    if (expected !== actual) {
      problems.push(
        `The header's ${column} is ${actual} paise but the lines add to ` +
          `${expected} paise. ⚠️ Nothing in the database refuses this on a sales ` +
          `invoice — 0021's deferred reconciliation trigger covers \`invoices\` ` +
          `and \`purchase_invoices\` only — so this function is the only thing ` +
          `standing between a document that does not add up and a filed return.`,
      );
    }
  }

  /**
   * ⚠️ `sales_invoices_amounts_non_negative`. A negative header figure is
   * not a credit note — a credit note is its own document with its own
   * table — and writing one produces a constraint failure whose name
   * suggests a data problem rather than a modelling one.
   */
  const nonNegative: readonly (readonly [string, bigint])[] = [
    ["subtotal_minor", tax.header.subtotalMinor],
    ["taxable_value_minor", tax.header.taxableValueMinor],
    ["cgst_minor", tax.header.cgstMinor],
    ["sgst_minor", tax.header.sgstMinor],
    ["igst_minor", tax.header.igstMinor],
    ["cess_minor", tax.header.cessMinor],
    ["total_minor", tax.header.totalMinor],
  ];
  for (const [column, value] of nonNegative) {
    if (value < 0n) {
      problems.push(
        `The header's ${column} is ${value} paise. ` +
          `\`sales_invoices_amounts_non_negative\` refuses a negative figure on a ` +
          `sales invoice — a negative supply is a credit note, which is a ` +
          `different document with a different number series.`,
      );
    }
  }

  /**
   * ⚠️ `sales_invoices_gst_mutually_exclusive`. One supply has one place
   * of supply, so it is inter-state or intra-state and never both. This
   * reaches GSTR-1 as a mismatch the officer sees before we do.
   */
  if (igst !== 0n && (cgst !== 0n || sgst !== 0n)) {
    problems.push(
      "This document carries IGST and CGST/SGST at the same time. That is a " +
        "place-of-supply defect, not a rounding one: the buyer can claim only " +
        "one of the two and the supplier owes the other again.",
    );
  }

  if (tax.header.isInterState && cgst + sgst !== 0n) {
    problems.push(
      "The header says this is an inter-state supply but the lines charge CGST " +
        "and SGST. Inter-state is IGST at the full rate; CGST+SGST on it is tax " +
        "paid to the wrong government and claimable by nobody (SQL 0147 §B).",
    );
  }
  if (!tax.header.isInterState && igst !== 0n) {
    problems.push(
      "The header says this is an intra-state supply but the lines charge IGST. " +
        "The recipient cannot claim it and the supplier will pay CGST and SGST " +
        "again on the same supply (SQL 0147 §B).",
    );
  }

  if (problems.length > 0) throw new TaxWriteRefused(problems);

  return {
    header: {
      placeOfSupplyCode: tax.header.placeOfSupplyCode,
      placeOfSupplyBasis: tax.header.placeOfSupplyBasis,
      isInterState: tax.header.isInterState,
      isUnionTerritory: tax.header.isUnionTerritory,
      supplierRegistrationId: tax.header.supplierRegistrationId,
      isReverseCharge: anyReverseCharge,
      subtotalMinor: tax.header.subtotalMinor,
      discountMinor: tax.header.discountMinor,
      taxableValueMinor: tax.header.taxableValueMinor,
      cgstMinor: tax.header.cgstMinor,
      sgstMinor: tax.header.sgstMinor,
      igstMinor: tax.header.igstMinor,
      cessMinor: tax.header.cessMinor,
      roundOffMinor: tax.header.roundOffMinor,
      totalMinor: tax.header.totalMinor,
    },
    lines,
    reverseChargeByKey: Object.fromEntries(
      tax.lines.map((line) => [line.key, line.isReverseCharge]),
    ),
  };
}

/* ------------------------------------------------------------------ */
/* THE TRAIL THAT GOES WITH THE WRITE                                  */
/* ------------------------------------------------------------------ */

/**
 * Build the `tax_decisions` batch for a document that has just been
 * written.
 *
 * ⚠️ IT TAKES THE LINE IDS SEPARATELY, AND IT HAS TO. `document_line_id`
 * is the primary key of a row that does not exist until the INSERT
 * returns, so this cannot be produced alongside the write — it is a
 * second step, inside the same transaction. The caller collects the ids
 * from `.returning({ id, ... })` and maps them back by key.
 *
 * TODO(PATCH-REQUEST-E): the call sites, again by name —
 *   · `server/actions/sales-invoices.ts` `createInvoiceFromOrder`, after
 *     the `insert(salesInvoiceLines)` — add `.returning()` and pass the
 *     ids here, then `recordTaxDecisions(tenantId, batch, tx)`.
 *   · `server/actions/sales-invoices.ts` credit-note creation, the same.
 *
 * ⚠️ A LINE WITH NO ID IN `lineIdByKey` IS SKIPPED, NOT GUESSED AT. A
 * decision written against the wrong line id is worse than a missing one:
 * it is evidence that points at the wrong row, and the coverage view in
 * SQL 0150 §5 would count it as covered.
 */
export function buildTaxDecisionsForSalesInvoice(args: {
  tax: PersistableTax;
  documentId: string;
  documentDate: string;
  /** `sales_invoice_lines` row ids, keyed by the engine's line key. */
  lineIdByKey: Readonly<Record<string, string>>;
  lineNoByKey?: Readonly<Record<string, number>>;
  /** Notification reference and period, keyed by line key. From the rate. */
  rateProvenanceByKey?: Readonly<
    Record<
      string,
      {
        notificationRef: string | null;
        effectiveFrom: string | null;
        effectiveTo: string | null;
      }
    >
  >;
  /** Which limb of s.9(3)/9(4) applied, keyed by line key. */
  reverseChargeBasisByKey?: Readonly<Record<string, string | null>>;
  decidedBy: string | null;
  engineVersion?: string;
}): RecordTaxDecisionsInput {
  const lines: TaxDecisionLine[] = [];

  args.tax.lines.forEach((line, index) => {
    const documentLineId = args.lineIdByKey[line.key];
    if (!documentLineId) return;

    const provenance = args.rateProvenanceByKey?.[line.key];

    lines.push({
      documentLineId,
      lineNo: args.lineNoByKey?.[line.key] ?? index + 1,
      hsnSacCode: line.hsnSacCode,
      hsnSacRateId: line.hsnSacRateId,
      rateBps: line.taxRateBps,
      cessRateBps: line.cessRateBps,
      notificationRef: provenance?.notificationRef ?? null,
      rateEffectiveFrom: provenance?.effectiveFrom ?? null,
      rateEffectiveTo: provenance?.effectiveTo ?? null,
      taxKind: args.tax.header.taxKind,
      isReverseCharge: line.isReverseCharge,
      reverseChargeBasis: args.reverseChargeBasisByKey?.[line.key] ?? null,
      taxableValueMinor: line.taxableValueMinor,
      cgstMinor: line.cgstMinor,
      sgstMinor: line.sgstMinor,
      igstMinor: line.igstMinor,
      cessMinor: line.cessMinor,
    });
  });

  const input: RecordTaxDecisionsInput = {
    documentTable: "sales_invoice_lines",
    documentId: args.documentId,
    documentDate: args.documentDate.slice(0, 10),
    lines,
    placeOfSupply: {
      code: args.tax.header.placeOfSupplyCode,
      basis: args.tax.header.placeOfSupplyBasis,
      statutoryRef: args.tax.header.statutoryRef,
      explanation: args.tax.header.placeOfSupplyExplanation,
    },
    decidedBy: args.decidedBy,
  };

  return args.engineVersion === undefined
    ? input
    : { ...input, engineVersion: args.engineVersion };
}

/* ------------------------------------------------------------------ */
/* PER-LINE CHECKS                                                     */
/* ------------------------------------------------------------------ */

function checkLine(args: {
  line: PersistableTaxLine;
  day: string;
  isInterState: boolean;
  ratePeriod?: { from: string; to: string | null };
  problems: string[];
}): void {
  const { line, day, problems } = args;

  /**
   * ⭐ THE PIN. SQL 0146 makes it a composite key so it cannot name
   * another tenant's row; SQL 0147 §C1 makes it agree with the rate
   * charged. Neither can make it PRESENT — a null pin is legal, because
   * the columns predate the rule and 0148 backfills what it can.
   *
   * ⚠️ SO A MISSING PIN IS A REFUSAL HERE AND NOT IN THE DATABASE, and it
   * is the right place for it: a line the ENGINE priced always has one,
   * so a null at this point means the caller assembled a `PersistableTax`
   * by hand and dropped the provenance on the way.
   */
  if (line.hsnSacRateId === null) {
    problems.push(
      `Line "${line.key}" has no rate pin. The pin is what proves which ` +
        `notification the figure came from; without it the document records a ` +
        `rate with no authority behind it, and SQL 0148 would classify the row ` +
        `as unpinnable rather than backfill it.`,
    );
  }

  if (line.taxableValueMinor !== line.grossMinor - line.discountMinor) {
    problems.push(
      `Line "${line.key}" declares a taxable value of ${line.taxableValueMinor} ` +
        `paise, which is not ${line.grossMinor} less ${line.discountMinor}. Tax is ` +
        `charged on gross minus discount (s.15 read with s.15(3)); anything else ` +
        `is a discount the customer sees and the tax does not.`,
    );
  }

  if (line.discountMinor < 0n) {
    problems.push(
      `Line "${line.key}" has a negative discount of ${line.discountMinor} paise. ` +
        `A discount is subtracted, so a negative one silently increases the ` +
        `taxable value.`,
    );
  }

  /**
   * ⭐ SQL 0147 §A, IN TYPESCRIPT, USING THE SAME PRIMITIVE. `applyRateBps`
   * is the TypeScript half of the pair SQL 0147 §1 mirrors in
   * `gst_apply_rate_bps()`; the two are proved equal by that file's §5. So
   * this check and the trigger cannot disagree — which is the only reason
   * it is safe to make the check twice.
   */
  const expectedTax = applyRateBps(line.taxableValueMinor, line.taxRateBps);
  const chargedTax = line.igstMinor + line.cgstMinor + line.sgstMinor;

  if (chargedTax !== expectedTax) {
    problems.push(
      `Line "${line.key}" does not recompute: ${line.taxableValueMinor} paise at ` +
        `${line.taxRateBps} bps is ${expectedTax} paise of tax, and the line ` +
        `carries ${chargedTax}. An auditor recomputing this line by hand gets a ` +
        `different answer from the document.`,
    );
  }

  if (args.isInterState && (line.cgstMinor !== 0n || line.sgstMinor !== 0n)) {
    problems.push(
      `Line "${line.key}" charges CGST/SGST on an inter-state supply.`,
    );
  }
  if (!args.isInterState && line.igstMinor !== 0n) {
    problems.push(`Line "${line.key}" charges IGST on an intra-state supply.`);
  }

  /**
   * ⭐ THE PINNED PERIOD MUST COVER THE DOCUMENT'S OWN DATE. Half-open,
   * `[from, to)`, matching `lib/gst/rates.ts` and SQL 0147 §C2. A pin
   * pointing at a period that does not cover the date looks like
   * provenance and is the opposite of it.
   */
  const period = args.ratePeriod;
  if (period) {
    if (day < period.from) {
      problems.push(
        `Line "${line.key}" is on a document dated ${day} but is pinned to a rate ` +
          `period beginning ${period.from}. The rate in force on the document's ` +
          `own date is the one that governs.`,
      );
    }
    if (period.to !== null && day >= period.to) {
      problems.push(
        `Line "${line.key}" is on a document dated ${day} but is pinned to a rate ` +
          `period that closed on ${period.to}. Citing a superseded period as the ` +
          `authority for a later document is exactly the failure the pin exists ` +
          `to make visible.`,
      );
    }
  }
}
