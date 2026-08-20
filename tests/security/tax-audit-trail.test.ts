/**
 * Ordence — ⭐⭐ ONE INVOICE, TRACED BACK TO THE RULE THAT PRODUCED IT
 * Version: v1.81.0-alpha · Wave 17 · Track E
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS FILE IS
 * ══════════════════════════════════════════════════════════════════════
 * The brief for this wave says, in one sentence:
 *
 *     "Pick one invoice and trace its tax to the rule that produced it.
 *      If that trail does not exist, an accountant cannot defend the
 *      number."
 *
 * This file IS that trace, EXECUTED rather than described. It raises real
 * documents through the real engine, writes the real `tax_decisions`
 * rows through `server/tax/audit.ts`, and then reads the trail back and
 * recomputes the invoice FROM THE TRAIL ALONE using the database's own
 * `gst_apply_rate_bps()` / `gst_cgst_share()` — the primitives SQL 0147
 * created and SQL 0150's trigger uses. If the trail and the document ever
 * disagree by a paisa, a test here goes red.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHICH EXECUTION PATH THIS TOOK, AND WHY IT MATTERS
 * ══════════════════════════════════════════════════════════════════════
 * The REAL application modules. Not the pure functions with SQL inserts
 * standing in for the engine:
 *
 *   `computePersistableTax`  (server/tax/compute.ts) → `quoteTax`
 *   `buildTaxWriteForSalesInvoice`   (server/tax/apply.ts)
 *   `buildTaxDecisionsForSalesInvoice` (server/tax/apply.ts)
 *   `recordTaxDecisions`     (server/tax/audit.ts) → `withTenant`
 *   `getTaxDecisionsForDocument` (server/tax/audit.ts) → `withTenant`
 *
 * ⚠️ THAT IS NOT A COSMETIC CHOICE. `server/tax/*` imports `@/db` and
 * goes through `withTenant`, which opens a Neon serverless connection —
 * and `tests/setup.ts` installs a loopback shim that translates Neon's
 * protocol into ordinary `pg` against the throwaway database. So these
 * modules run BYTE-FOR-BYTE the code Railway runs, as the ordinary
 * `ordence_app` role, under the same row-level security. A version of
 * this file that hand-wrote the INSERT would prove that 0150's trigger
 * accepts rows this test composed — and nothing at all about whether the
 * engine can compose them. The whole question the brief asks is whether
 * the PRODUCT can produce a defensible trail.
 *
 * ⚠️ `asSuperuser` APPEARS ONLY IN FIXTURE SETUP AND TEARDOWN. Every
 * assertion runs as `ordence_app` (NOSUPERUSER, NOBYPASSRLS), either
 * through `asTenant` or through the application's own `withTenant`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE SIX THINGS PROVED, AND WHY EACH ONE IS HERE
 * ══════════════════════════════════════════════════════════════════════
 *   A. The trail reproduces the invoice, INCLUDING THE ODD PAISA.
 *   B. ⭐⭐ The DOCUMENT'S DATE governs, not the clock.
 *   C. ⭐⭐ A new rate period does not restate history.
 *   D. The trail cannot lie — and it can still tell the truth.
 *   E. A Union Territory is UTGST, not SGST.
 *   F. The working paper, printed.
 *
 * ⚠️ B AND C LOOK REDUNDANT AND ARE THE POINT. See the block comments
 * above each. Everything else in this file is scaffolding for them.
 *
 * ⚠️ EVERY REFUSAL ASSERTION BELOW HAS A SIBLING PROVING THE CORRESPOND-
 * ING CORRECT WRITE IS ACCEPTED. A control that refuses everything passes
 * a refusal test and breaks the product; this codebase has been bitten by
 * that shape often enough that SQL 0146 §4 and 0150 §6 both say so in
 * their own comments.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { asTenant, asSuperuser, expectError } from "../setup";
import { computePersistableTax, TAX_ENGINE_VERSION } from "@/server/tax/compute";
import type { PersistableTax } from "@/server/tax/compute";
import {
  buildTaxWriteForSalesInvoice,
  buildTaxDecisionsForSalesInvoice,
} from "@/server/tax/apply";
import { recordTaxDecisions, getTaxDecisionsForDocument } from "@/server/tax/audit";
import type { TaxDecisionView } from "@/server/tax/audit";
import type { QuotedTax } from "@/server/gst/engine";

/* ================================================================== */
/* THE FIXTURE                                                         */
/* ================================================================== */

/**
 * ⚠️ REAL GSTINs WITH REAL CHECK DIGITS. `gst_registrations` carries
 * `CHECK (is_valid_gstin(gstin))` — a shape-only string is refused by the
 * database, and a fixture that worked around that would be testing a
 * registration the product would never hold.
 */
const GSTIN_KA = "29AAACR5055K1Z3"; // Karnataka — a State.
const GSTIN_UT = "26AAACR5055K1Z9"; // Dadra & Nagar Haveli and Daman & Diu — a UT.

/**
 * ⭐ THE TWO NOTIFICATIONS. Distinct strings, on purpose: case B's whole
 * assertion is that a 2018 document cites the FIRST one, and a test whose
 * two periods carried the same reference could not tell them apart.
 */
const NOTIFICATION_2017 = "Notification 11/2017-Central Tax (Rate), Sl. No. 3(ii)";
const NOTIFICATION_2019 = "Notification 20/2019-Central Tax (Rate), Sl. No. 3(xii)";
const NOTIFICATION_2027 = "Notification 01/2027-Central Tax (Rate), Sl. No. 3(i)";

/** SAC 998314 — information technology design and development services. */
const SAC = "998314";

/**
 * ⭐⭐ ₹100.05, AND THE .05 IS THE ENTIRE REASON. 10005 paise at 1800 bps
 * is 1800.9 → 1801 half-up, which is ODD, so the intra-state split is
 * 901 / 900 and NOT 900 / 900. A fixture using a round ₹1,000 would pass
 * against an implementation that halves the RATE and rounds each half —
 * the natural way to write it, and the way that loses a paisa on every
 * odd tax in the corpus. SQL 0150 §6 checks 3 and 12 are the same pair of
 * cases at the database level; this is the same pair driven end-to-end
 * through the engine.
 *
 * At 1200 bps the same value is 1200.6 → 1201, also odd, so case B gets
 * the odd-paisa property for free and 601 / 600 is a DIFFERENT pair of
 * numbers from 901 / 900 — which is what makes "the trail did not move"
 * in case C a meaningful statement rather than a coincidence.
 */
const ODD_AMOUNT = "100.05";
const ODD_TAXABLE_MINOR = 10005n;

/** A 2026 document — inside the 1800 bps period. */
const DATE_2026 = "2026-08-19";
/** ⭐ A 2018 document — inside the 1200 bps period. The point of case B. */
const DATE_2018 = "2018-06-01";

let tenant: string;

let regKarnataka: string;
let regUnionTerritory: string;

let custKarnataka: string; // 29 — intra-state
let custMaharashtra: string; // 27 — inter-state
let custUnionTerritory: string; // 26 — intra-UT

let sacCodeId: string;
/** [2017-07-01, 2019-04-01) at 12%. */
let rate1200: string;
/** [2019-04-01, open) at 18% — closed by case C at 2027-01-01. */
let rate1800: string;
/** ⭐ Opened by case C, from 2027-01-01. Does not exist during A, B, E. */
let rate500: string | null = null;

type Raised = {
  invoiceId: string;
  invoiceNumber: string;
  invoiceDate: string;
  lineId: string;
  tax: PersistableTax;
  quote: QuotedTax;
};

/** Invoice A — intra-state Karnataka, 2026, odd tax. */
let invoiceA: Raised;
/** ⭐ Invoice B — the SAME supply, dated 2018. */
let invoiceB: Raised;
/** Invoice C — inter-state Karnataka → Maharashtra, 2026. */
let invoiceInterState: Raised;
/** Invoice D — intra-UT, 2026. */
let invoiceUT: Raised | null = null;
/** If the UT document could not be raised, the reason, printed by case E. */
let unionTerritoryRefusal: string | null = null;

/** ⭐ Snapshots taken BEFORE case C opens a third rate period. */
let trailBeforeThirdPeriod: Record<string, TaxDecisionView[]> = {};

/* ------------------------------------------------------------------ */
/* ⭐ RAISING A DOCUMENT THE WAY THE PRODUCT WOULD                      */
/* ------------------------------------------------------------------ */

/**
 * Price, write, and record the reasoning — in that order, which is the
 * order the wiring track will use because `document_line_id` is the
 * primary key of a row that does not exist until the INSERT returns
 * (`server/tax/apply.ts` says exactly this above
 * `buildTaxDecisionsForSalesInvoice`).
 *
 * ⚠️ NOTHING IN HERE COMPUTES TAX. Every figure written below comes out
 * of `computePersistableTax`. A helper that did its own arithmetic would
 * be a second tax engine inside the test that is supposed to be checking
 * the first one.
 */
async function raise(args: {
  registrationId: string;
  companyId: string;
  recipientStateCode: string;
  invoiceDate: string;
  financialYear: string;
  label: string;
}): Promise<Raised> {
  const computed = await computePersistableTax(tenant, {
    supplierRegistrationId: args.registrationId,
    supplyType: "services",
    recipientRegistration: "regular",
    recipientStateCode: args.recipientStateCode,
    propertyStateCode: null,
    deliveryStateCode: null,
    taxPointDate: args.invoiceDate,
    roundToRupee: false,
    lines: [
      {
        key: "L1",
        description: "Structural design and drawing services",
        hsnSacCode: SAC,
        quantity: 1,
        uqc: "nos",
        amount: ODD_AMOUNT,
        discount: null,
        reverseCharge: false,
      },
    ],
  });

  if (!computed.ok) {
    throw new Error(`${args.label}: the engine refused to price it — ${computed.error}`);
  }

  const { tax, quote } = computed;

  /**
   * ⭐ THE SEAM. `buildTaxWriteForSalesInvoice` is handed the rate period
   * the engine resolved, so its "the pin covers the document's date"
   * check runs HERE — in this stack frame, naming the field — as well as
   * at COMMIT, where SQL 0147 §C2 says it again.
   */
  const write = buildTaxWriteForSalesInvoice({
    tax,
    invoiceDate: args.invoiceDate,
    ratePeriodByKey: Object.fromEntries(
      Object.entries(quote.rateByLine).map(([key, rate]) => [
        key,
        { from: rate.effectiveFrom, to: rate.effectiveTo },
      ]),
    ),
  });

  const invoiceId = randomUUID();
  const lineId = randomUUID();
  const invoiceNumber = `TRAIL/${args.label}/${invoiceId.slice(0, 8)}`;

  /**
   * ⚠️ WRITTEN AS THE ORDINARY APPLICATION ROLE, INSIDE TENANT SCOPE.
   * `sales_invoice_lines_gst_recomputes` (SQL 0147) and
   * `sales_invoice_lines_rate_same_tenant` (SQL 0146) both fire on this
   * INSERT. If the engine ever produced a line whose money did not
   * recompute, or a pin belonging to another workspace, the fixture
   * itself would fail — which is a stronger statement than any assertion
   * further down could make.
   */
  await asTenant(tenant, async (c) => {
    await c.query(
      `INSERT INTO sales_invoices
         (id, tenant_id, invoice_number, financial_year, status, company_id,
          invoice_date, supplier_registration_id, supplier_gstin, supplier_state_code,
          place_of_supply_code, place_of_supply_basis, is_inter_state,
          is_union_territory, supply_type, is_reverse_charge, currency,
          subtotal_minor, discount_minor, taxable_value_minor,
          cgst_minor, sgst_minor, igst_minor, cess_minor,
          round_off_minor, total_minor)
       VALUES ($1,$2,$3,$4,'draft',$5,$6::date,$7,$8,$9,
               $10,$11,$12,$13,'services',$14,'INR',
               $15,$16,$17,$18,$19,$20,$21,$22,$23)`,
      [
        invoiceId,
        tenant,
        invoiceNumber,
        args.financialYear,
        args.companyId,
        args.invoiceDate,
        write.header.supplierRegistrationId,
        tax.header.supplierGstin,
        tax.header.supplierStateCode,
        write.header.placeOfSupplyCode,
        write.header.placeOfSupplyBasis,
        write.header.isInterState,
        write.header.isUnionTerritory,
        write.header.isReverseCharge,
        write.header.subtotalMinor.toString(),
        write.header.discountMinor.toString(),
        write.header.taxableValueMinor.toString(),
        write.header.cgstMinor.toString(),
        write.header.sgstMinor.toString(),
        write.header.igstMinor.toString(),
        write.header.cessMinor.toString(),
        write.header.roundOffMinor.toString(),
        write.header.totalMinor.toString(),
      ],
    );

    const line = write.lines[0]!;
    await c.query(
      `INSERT INTO sales_invoice_lines
         (id, tenant_id, invoice_id, line_no, description, hsn_sac_code_id,
          hsn_sac_rate_id, hsn_sac_code, tax_rate_bps, cess_rate_bps,
          quantity, uom, unit_price_minor, discount_minor, taxable_value_minor,
          cgst_minor, sgst_minor, igst_minor, cess_minor, line_total_minor)
       VALUES ($1,$2,$3,$4,'Structural design and drawing services',$5,
               $6,$7,$8,$9,1,'nos',$10,$11,$12,$13,$14,$15,$16,$17)`,
      [
        lineId,
        tenant,
        invoiceId,
        line.lineNo,
        line.hsnSacCodeId,
        line.hsnSacRateId,
        line.hsnSacCode,
        line.taxRateBps,
        line.cessRateBps,
        (line.taxableValueMinor + line.discountMinor).toString(),
        line.discountMinor.toString(),
        line.taxableValueMinor.toString(),
        line.cgstMinor.toString(),
        line.sgstMinor.toString(),
        line.igstMinor.toString(),
        line.cessMinor.toString(),
        line.lineTotalMinor.toString(),
      ],
    );
  });

  /**
   * ⭐ AND THEN THE REASONING, THROUGH THE REAL WRITER. `recordTaxDecisions`
   * opens its own `withTenant` here because this test is not inside a
   * document transaction; the production call site passes its own `tx` so
   * the trail commits or rolls back WITH the invoice.
   */
  const batch = buildTaxDecisionsForSalesInvoice({
    tax,
    documentId: invoiceId,
    documentDate: args.invoiceDate,
    lineIdByKey: { L1: lineId },
    rateProvenanceByKey: Object.fromEntries(
      Object.entries(quote.rateByLine).map(([key, rate]) => [
        key,
        {
          notificationRef: rate.notificationRef ?? null,
          effectiveFrom: rate.effectiveFrom,
          effectiveTo: rate.effectiveTo,
        },
      ]),
    ),
    decidedBy: "tests/security/tax-audit-trail.test.ts",
  });

  const written = await recordTaxDecisions(tenant, batch);
  if (written !== 1) {
    throw new Error(`${args.label}: expected one decision to be written, got ${written}.`);
  }

  return {
    invoiceId,
    invoiceNumber,
    invoiceDate: args.invoiceDate,
    lineId,
    tax,
    quote,
  };
}

/** The one decision behind a document, as the application reads it back. */
async function trailFor(raised: Raised): Promise<TaxDecisionView> {
  const rows = await getTaxDecisionsForDocument(tenant, {
    documentTable: "sales_invoice_lines",
    documentId: raised.invoiceId,
  });
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

/* ================================================================== */
/* SETUP                                                               */
/* ================================================================== */

beforeAll(async () => {
  tenant = randomUUID();
  regKarnataka = randomUUID();
  regUnionTerritory = randomUUID();
  custKarnataka = randomUUID();
  custMaharashtra = randomUUID();
  custUnionTerritory = randomUUID();
  sacCodeId = randomUUID();
  rate1200 = randomUUID();
  rate1800 = randomUUID();

  await asSuperuser(async (c) => {
    await c.query(
      `INSERT INTO tenants (id, clerk_org_id, slug, name, status)
       VALUES ($1,$2,$3,'Tax Trail Workspace','active')`,
      [tenant, `org_${tenant}`, `trail-${tenant.slice(0, 8)}`],
    );

    /**
     * ⚠️ TWO REGISTRATIONS, AND ONLY ONE IS PRIMARY.
     * `gst_registrations_one_primary` is a partial unique index on
     * `(tenant_id) WHERE is_primary AND is_active`. The UT registration
     * is reached by id, which is what `resolveIssuingRegistration` does
     * when a document names its own supplier — "explicit beats primary,
     * and primary is only a fallback" (server/gst/registry.ts).
     */
    await c.query(
      `INSERT INTO gst_registrations
         (id, tenant_id, gstin, state_code, legal_name, effective_from, is_primary)
       VALUES ($1,$2,$3,'29','Trail Engineering LLP', DATE '2017-07-01', true),
              ($4,$2,$5,'26','Trail Engineering LLP (Daman branch)', DATE '2017-07-01', false)`,
      [regKarnataka, tenant, GSTIN_KA, regUnionTerritory, GSTIN_UT],
    );

    /** THREE CUSTOMERS: one in 29, one in 27, one in a Union Territory. */
    await c.query(
      `INSERT INTO companies (id, tenant_id, name) VALUES ($1,$2,$3),($4,$2,$5),($6,$2,$7)`,
      [
        custKarnataka,
        tenant,
        "Bengaluru Buyer Pvt Ltd (29)",
        custMaharashtra,
        "Mumbai Buyer Pvt Ltd (27)",
        custUnionTerritory,
        "Daman Buyer Pvt Ltd (26)",
      ],
    );

    await c.query(
      `INSERT INTO hsn_sac_codes (id, tenant_id, code, kind, description)
       VALUES ($1,$2,$3,'sac','IT design and development services')`,
      [sacCodeId, tenant, SAC],
    );

    /**
     * ⭐⭐ TWO PERIODS, EACH WITH ITS OWN NOTIFICATION. Half-open,
     * `[from, to)`, matching `lib/gst/rates.ts` and SQL 0147 §C2: a
     * document dated exactly 2019-04-01 is an 18% document.
     *
     * ⚠️ THE 12% PERIOD IS CLOSED AND THE 18% ONE IS OPEN, which is the
     * arrangement that makes case B a RESOLUTION and not a lookup. If the
     * registry ever answered "the current rate" rather than "the rate on
     * that date", the 2018 invoice would come back at 18% and cite a
     * notification published a year after it was raised.
     */
    await c.query(
      `INSERT INTO hsn_sac_rates
         (id, tenant_id, hsn_sac_id, rate_bps, cess_rate_bps,
          effective_from, effective_to, notification_ref)
       VALUES ($1,$2,$3,1200,0, DATE '2017-07-01', DATE '2019-04-01', $4),
              ($5,$2,$3,1800,0, DATE '2019-04-01', NULL,             $6)`,
      [rate1200, tenant, sacCodeId, NOTIFICATION_2017, rate1800, NOTIFICATION_2019],
    );
  });

  /* --- THE DOCUMENTS, RAISED THROUGH THE REAL ENGINE --------------- */

  invoiceA = await raise({
    registrationId: regKarnataka,
    companyId: custKarnataka,
    recipientStateCode: "29",
    invoiceDate: DATE_2026,
    financialYear: "2026-27",
    label: "A",
  });

  invoiceB = await raise({
    registrationId: regKarnataka,
    companyId: custKarnataka,
    recipientStateCode: "29",
    invoiceDate: DATE_2018,
    financialYear: "2018-19",
    label: "B",
  });

  invoiceInterState = await raise({
    registrationId: regKarnataka,
    companyId: custMaharashtra,
    recipientStateCode: "27",
    invoiceDate: DATE_2026,
    financialYear: "2026-27",
    label: "IGST",
  });

  /**
   * ⭐ CASE E IS ATTEMPTED, NOT ASSUMED. If the engine or the schema
   * cannot produce a `cgst_utgst` decision, the reason is captured and
   * the assertion in §E fails with it — rather than the test being
   * quietly written to pass on whatever the code happens to do.
   */
  try {
    invoiceUT = await raise({
      registrationId: regUnionTerritory,
      companyId: custUnionTerritory,
      recipientStateCode: "26",
      invoiceDate: DATE_2026,
      financialYear: "2026-27",
      label: "UT",
    });
  } catch (err) {
    unionTerritoryRefusal = err instanceof Error ? err.message : String(err);
  }

  /**
   * ⭐ THE "BEFORE" SNAPSHOT FOR CASE C, TAKEN HERE AND NOT INSIDE A
   * TEST. A snapshot captured by test 1 and compared by test 2 is a
   * dependency on file order, and the day somebody adds `.only` the
   * comparison silently compares undefined with undefined.
   */
  trailBeforeThirdPeriod = {
    A: await getTaxDecisionsForDocument(tenant, {
      documentTable: "sales_invoice_lines",
      documentId: invoiceA.invoiceId,
    }),
    B: await getTaxDecisionsForDocument(tenant, {
      documentTable: "sales_invoice_lines",
      documentId: invoiceB.invoiceId,
    }),
  };
});

afterAll(async () => {
  await asSuperuser(async (c) => {
    // ⚠️ ORDER MATTERS AND IT IS THE PRODUCT'S OWN GUARDS SAYING SO.
    // `block_used_gst_rate_delete` (SQL 0146) refuses to remove a rate
    // period any document line still points at, and `tax_decisions`
    // pins one too with ON DELETE RESTRICT — because the rate row is the
    // evidence of what was decided. So the documents and the decisions
    // go first, and the rate history goes last.
    await c.query(`DELETE FROM tax_decisions WHERE tenant_id = $1`, [tenant]);
    await c.query(`DELETE FROM sales_invoice_lines WHERE tenant_id = $1`, [tenant]);
    await c.query(`DELETE FROM sales_invoices WHERE tenant_id = $1`, [tenant]);
    await c.query(`DELETE FROM companies WHERE tenant_id = $1`, [tenant]);
    await c.query(`DELETE FROM hsn_sac_rates WHERE tenant_id = $1`, [tenant]);
    await c.query(`DELETE FROM hsn_sac_codes WHERE tenant_id = $1`, [tenant]);
    await c.query(`DELETE FROM gst_registrations WHERE tenant_id = $1`, [tenant]);
    await c.query(`DELETE FROM change_log WHERE tenant_id = $1`, [tenant]);
    await c.query(`DELETE FROM tenants WHERE id = $1`, [tenant]);
  });
});

/* ================================================================== */
/* A. ⭐⭐ THE TRAIL REPRODUCES THE INVOICE                             */
/* ================================================================== */

describe("A — ⭐⭐ the trail reproduces the invoice, to the paisa", () => {
  /**
   * ══════════════════════════════════════════════════════════════════
   * 🔴 THE ASSERTION THAT MAKES THE TABLE WORTH HAVING
   * ══════════════════════════════════════════════════════════════════
   * The recompute below reads NOTHING from `sales_invoice_lines` except
   * the figures it is compared AGAINST. `taxable_value_minor` and
   * `rate_bps` are taken from the DECISION, run through the database's
   * own `gst_apply_rate_bps()` / `gst_cgst_share()`, and the result is
   * then held up against the document.
   *
   * ⭐ THAT IS EXACTLY WHAT AN OFFICER DOES. They do not accept "the
   * system computed it"; they take the taxable value and the rate off
   * the working paper and multiply. If the two answers differ, the
   * document is indefensible however internally consistent it is.
   */
  it("⭐⭐ recomputing the trail's own taxable value at the trail's own rate gives the line's tax", async () => {
    const recomputed = await asTenant(tenant, async (c) => {
      const { rows } = await c.query(
        `SELECT
           gst_apply_rate_bps(d.taxable_value_minor, d.rate_bps)::text                    AS trail_tax,
           gst_cgst_share(gst_apply_rate_bps(d.taxable_value_minor, d.rate_bps))::text    AS trail_cgst,
           (gst_apply_rate_bps(d.taxable_value_minor, d.rate_bps)
              - gst_cgst_share(gst_apply_rate_bps(d.taxable_value_minor, d.rate_bps)))::text
                                                                                          AS trail_sgst,
           (l.cgst_minor + l.sgst_minor + l.igst_minor)::text                             AS line_tax,
           l.cgst_minor::text                                                             AS line_cgst,
           l.sgst_minor::text                                                             AS line_sgst
         FROM tax_decisions d
         JOIN sales_invoice_lines l ON l.id = d.document_line_id
        WHERE d.document_table = 'sales_invoice_lines'
          AND d.document_id = $1`,
        [invoiceA.invoiceId],
      );
      return rows[0] as Record<string, string>;
    });

    // The tax the trail's own arithmetic produces IS the tax on the line.
    expect(recomputed.trail_tax).toBe(recomputed.line_tax);
    expect(recomputed.trail_tax).toBe("1801");

    /**
     * ⭐⭐ AND THE ODD PAISA LANDS WHERE THE DOCUMENT PUT IT. 1801 splits
     * 901 / 900. Recording 900 / 900 loses a paisa and 901 / 901 invents
     * one; both are the arithmetic nobody notices until a return does not
     * foot. This assertion is the reason the fixture is ₹100.05 and not
     * ₹1,000 — at ₹1,000 the split is 9000 / 9000 and a broken
     * implementation that halves the RATE passes.
     */
    expect(recomputed.trail_cgst).toBe(recomputed.line_cgst);
    expect(recomputed.trail_sgst).toBe(recomputed.line_sgst);
    expect([recomputed.trail_cgst, recomputed.trail_sgst]).toEqual(["901", "900"]);
  });

  it("⭐ names the rate row, its period, and the notification behind it", async () => {
    const trail = await trailFor(invoiceA);

    // ⭐ The PIN — the `hsn_sac_rates` row the engine resolved, not one
    // the caller supplied. `server/tax/compute.ts` takes it from
    // `rateByLine` for precisely this reason.
    expect(trail.rate.hsnSacRateId).toBe(rate1800);
    expect(trail.rate.hsnSacCode).toBe(SAC);
    expect(trail.rate.rateBps).toBe(1800);

    // ⚠️ `effectiveTo: null` MEANS "STILL CURRENT", NOT "UNKNOWN".
    expect(trail.rate.effectiveFrom).toBe("2019-04-01");
    expect(trail.rate.effectiveTo).toBeNull();

    // 🔴 THE COLUMN AN OFFICER ACTUALLY ASKS FOR. "18%" is a number;
    // "18% under Notification 20/2019, in force from 2019-04-01" is a
    // citation somebody can look up and disagree with.
    expect(trail.rate.notificationRef).toBe(NOTIFICATION_2019);
  });

  it("⭐ names the place of supply, the rule applied, and the provision relied on", async () => {
    const trail = await trailFor(invoiceA);

    expect(trail.placeOfSupply.code).toBe("29");

    // ⚠️ A BASIS WITHOUT A CITATION IS A LABEL. Both halves are asserted
    // to be present AND to name a real rule — s.12(2)(a) IGST Act is the
    // sub-section that makes a registered recipient's own registered
    // location the place of supply, which is the rule that actually
    // applies to this document.
    expect(trail.placeOfSupply.basis).toBe("recipient_registration");
    expect(trail.placeOfSupply.statutoryRef).toBe("Section 12(2)(a), IGST Act");
    expect(trail.placeOfSupply.explanation).toMatch(/registered in Karnataka/i);

    // And it is not merely non-null — it is the same place of supply the
    // DOCUMENT was raised under. A trail explaining a different supply is
    // worse than no trail.
    const onDocument = await asTenant(tenant, async (c) => {
      const { rows } = await c.query(
        `SELECT place_of_supply_code, place_of_supply_basis, is_inter_state
           FROM sales_invoices WHERE id = $1`,
        [invoiceA.invoiceId],
      );
      return rows[0];
    });
    expect(onDocument.place_of_supply_code).toBe(trail.placeOfSupply.code);
    expect(onDocument.place_of_supply_basis).toBe(trail.placeOfSupply.basis);
    expect(onDocument.is_inter_state).toBe(false);
  });

  it("⭐ records the tax_kind that matches the heads actually used — both ways round", async () => {
    /**
     * ⭐ THE HEAD IS STATED, NOT INFERRED. SQL 0150 §3 reads `tax_kind`
     * off the row rather than guessing from which amount is non-zero,
     * which is why an all-zero row at 18% is simply wrong there and needs
     * a special case on a line table.
     *
     * ⚠️ BOTH DIRECTIONS ARE ASSERTED. A test that only ever saw an
     * intra-state document would pass against an engine that hard-coded
     * `cgst_sgst`, and the inter-state customer in the fixture exists to
     * make that impossible.
     */
    const intra = await trailFor(invoiceA);
    expect(intra.treatment.taxKind).toBe("cgst_sgst");
    expect(intra.money.cgstMinor + intra.money.sgstMinor).toBe(1801n);
    expect(intra.money.igstMinor).toBe(0n);

    const inter = await trailFor(invoiceInterState);
    expect(inter.treatment.taxKind).toBe("igst");
    expect(inter.money.igstMinor).toBe(1801n);
    expect(inter.money.cgstMinor).toBe(0n);
    expect(inter.money.sgstMinor).toBe(0n);
    expect(inter.placeOfSupply.code).toBe("27");
  });

  it("⭐ says who decided and with which engine version", async () => {
    const trail = await trailFor(invoiceA);

    // ⚠️ `engine_version` IS NOT NULL AND UNDEFAULTED IN SQL 0150 §1.
    // "Which version produced this" is the question asked the day a
    // rounding defect is found, and a blank makes it unanswerable across
    // a corpus.
    expect(trail.engineVersion).toBe(TAX_ENGINE_VERSION);
    expect(trail.decidedBy).toBe("tests/security/tax-audit-trail.test.ts");
    expect(trail.documentDate).toBe(DATE_2026);
    expect(trail.treatment.isReverseCharge).toBe(false);
  });
});

/* ================================================================== */
/* B. ⭐⭐⭐ THE DATE GOVERNS, NOT THE CLOCK                             */
/* ================================================================== */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THIS LOOKS LIKE A DUPLICATE OF SECTION A. IT IS THE SINGLE MOST
 *      IMPORTANT PROPERTY IN THE WHOLE REGISTRY.
 * ══════════════════════════════════════════════════════════════════════
 * Section A proved the trail is arithmetically honest about ONE document.
 * An engine that read `WHERE effective_to IS NULL` — "the current rate" —
 * would pass every assertion in section A and be catastrophically wrong,
 * because section A's document happens to sit in the open period.
 *
 * ⭐ THE FAILURE THAT CAUSES IS NOT A CRASH. It is that a 2018 invoice
 * re-renders at 2019's rate, the PDF the buyer downloads stops matching
 * the one they were sent, the GSTR-1 reconciliation fails for a whole
 * quarter, and it is found during an assessment two years later. There is
 * no exception, no log line, and no failing test — because the second
 * answer looks exactly as authoritative as the first.
 *
 * ⚠️ AND IN THE AUDIT TRAIL IT IS WORSE THAN ON THE DOCUMENT. A document
 * that quietly restates itself is a wrong number. A TRAIL that quietly
 * restates itself is a wrong number wearing a citation — it names a
 * notification published ten months AFTER the invoice was raised, and it
 * reads as corroboration.
 *
 * So: the same supply, the same customer, the same classification, the
 * same amount. Only the DATE differs. Everything about the decision must
 * differ with it.
 */
describe("B — ⭐⭐⭐ a 2018 invoice cites 2018's rate and 2018's notification", () => {
  it("⭐⭐⭐ cites the 1200 bps period, NOT the 1800 bps one", async () => {
    const trail = await trailFor(invoiceB);

    expect(trail.documentDate).toBe(DATE_2018);
    expect(trail.rate.rateBps).toBe(1200);
    expect(trail.rate.hsnSacRateId).toBe(rate1200);

    // ⭐ The negatives, stated explicitly. `not.toBe` here is not padding:
    // it is the assertion that fails if the resolver ever starts
    // answering "the current rate".
    expect(trail.rate.rateBps).not.toBe(1800);
    expect(trail.rate.hsnSacRateId).not.toBe(rate1800);
  });

  it("⭐⭐⭐ cites the 2017 notification, NOT the 2019 one", async () => {
    const trail = await trailFor(invoiceB);

    expect(trail.rate.notificationRef).toBe(NOTIFICATION_2017);
    expect(trail.rate.notificationRef).not.toBe(NOTIFICATION_2019);

    // ⚠️ AND THE PERIOD IT COPIED IS THE CLOSED ONE. `rate_effective_to`
    // is a real date here and null on invoice A — which is what lets a
    // reader see, from the trail alone, that this rate was superseded and
    // when.
    expect(trail.rate.effectiveFrom).toBe("2017-07-01");
    expect(trail.rate.effectiveTo).toBe("2019-04-01");
  });

  it("⭐ and the 2018 figures are 2018's figures, recomputed from the trail", async () => {
    // 10005 paise at 1200 bps is 1200.6 → 1201, which is ODD, so the
    // split is 601 / 600. A DIFFERENT pair of numbers from invoice A's
    // 901 / 900 — which is what makes section C's "nothing moved" a
    // statement with content.
    const recomputed = await asTenant(tenant, async (c) => {
      const { rows } = await c.query(
        `SELECT gst_apply_rate_bps(d.taxable_value_minor, d.rate_bps)::text                 AS tax,
                gst_cgst_share(gst_apply_rate_bps(d.taxable_value_minor, d.rate_bps))::text AS cgst,
                d.cgst_minor::text AS recorded_cgst,
                d.sgst_minor::text AS recorded_sgst
           FROM tax_decisions d
          WHERE d.document_table = 'sales_invoice_lines' AND d.document_id = $1`,
        [invoiceB.invoiceId],
      );
      return rows[0] as Record<string, string>;
    });

    expect(recomputed.tax).toBe("1201");
    expect(recomputed.cgst).toBe("601");
    expect(recomputed.recorded_cgst).toBe("601");
    expect(recomputed.recorded_sgst).toBe("600");
  });

  it("⭐ SQL 0150's trigger refuses a decision citing a period that does not cover its own date — and accepts one that does", async () => {
    /**
     * ⚠️ THE SIBLING PAIR. The refusal below is the failure mode this
     * whole section is about, asserted at the database rather than in the
     * engine: a 2018 document citing the 2019 period as its authority.
     */
    const refused = await expectError(() =>
      asTenant(tenant, async (c) =>
        c.query(
          `INSERT INTO tax_decisions
             (tenant_id, document_table, document_line_id, document_id, document_date,
              hsn_sac_rate_id, rate_bps, tax_kind, taxable_value_minor,
              cgst_minor, sgst_minor, rate_effective_from, rate_effective_to,
              engine_version)
           VALUES ($1,'sales_invoice_lines',$2,$3, DATE '${DATE_2018}',
                   $4, 1800, 'cgst_sgst', 10005, 901, 900,
                   DATE '2019-04-01', NULL, 'trail-test')`,
          [tenant, randomUUID(), invoiceB.invoiceId, rate1800],
        ),
      ),
    );
    expect(refused, "a 2018 document citing the 2019 period must be refused").not.toBeNull();
    expect(refused!.message).toMatch(/rate period beginning/i);

    // ⭐ THE SIBLING: the SAME row with the period that genuinely covers
    // 2018-06-01 is ACCEPTED. Without this, a trigger that refused every
    // insert would pass the assertion above and take the product with it.
    const lineId = randomUUID();
    await asTenant(tenant, async (c) =>
      c.query(
        `INSERT INTO tax_decisions
           (tenant_id, document_table, document_line_id, document_id, document_date,
            hsn_sac_rate_id, rate_bps, tax_kind, taxable_value_minor,
            cgst_minor, sgst_minor, rate_effective_from, rate_effective_to,
            engine_version)
         VALUES ($1,'sales_invoice_lines',$2,$3, DATE '${DATE_2018}',
                 $4, 1200, 'cgst_sgst', 10005, 601, 600,
                 DATE '2017-07-01', DATE '2019-04-01', 'trail-test')`,
        [tenant, lineId, invoiceB.invoiceId, rate1200],
      ),
    );

    const stored = await asTenant(tenant, async (c) => {
      const { rows } = await c.query(
        `SELECT rate_bps FROM tax_decisions WHERE document_line_id = $1`,
        [lineId],
      );
      return rows;
    });
    expect(stored).toHaveLength(1);
    expect(stored[0].rate_bps).toBe(1200);

    // Leave the fixture as we found it — later sections count decisions.
    await asTenant(tenant, async (c) =>
      c.query(`DELETE FROM tax_decisions WHERE document_line_id = $1`, [lineId]),
    );
  });
});

/* ================================================================== */
/* C. ⭐⭐⭐ A NEW RATE PERIOD DOES NOT RESTATE HISTORY                  */
/* ================================================================== */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THIS ALSO LOOKS REDUNDANT AFTER B. IT IS NOT, AND THE DIFFERENCE
 *      IS THE DIFFERENCE BETWEEN A SNAPSHOT AND A GUARANTEE.
 * ══════════════════════════════════════════════════════════════════════
 * Section B proved the trail was written correctly ON THE DAY. It says
 * nothing about what happens NEXT YEAR, when the rate master moves —
 * which it will, because rate notifications land faster than deploys.
 *
 * ⭐ THE DEFECT THIS CATCHES IS A JOIN. If `tax_decisions` had been
 * written as a VIEW over `hsn_sac_rates`, or if any reader resolved the
 * notification by joining back to the rate row instead of reading the
 * copied columns, then opening a new period would silently restate every
 * historical decision — and SECTION B WOULD STILL PASS, because section B
 * reads the trail before anything moved. The columns are copied for
 * exactly this reason ("Copied from the rate period, not joined", SQL
 * 0150 §1), and this section is what proves the copy is real.
 *
 * ⚠️ IT ALSO PROVES THE OTHER HALF: that the RATE ROW ITSELF cannot be
 * edited out from under a document that used it. A trail that is immune
 * to restatement while its evidence can be rewritten is a trail pointing
 * at a rate row that now says something else.
 */
describe("C — ⭐⭐⭐ opening a third rate period restates nothing", () => {
  beforeAll(async () => {
    /**
     * ⭐ THE PERIOD IS CLOSED FIRST, AND THAT WRITE IS ITSELF THE
     * ACCEPTED SIBLING FOR THE REFUSAL BELOW. `enforce_gst_rate_history_
     * immutable` permits closing a used period at a date AFTER the last
     * document that used it — that is how a superseded rate is retired —
     * and refuses changing what it CHARGED. Both branches of the same
     * trigger are exercised in this section.
     */
    rate500 = randomUUID();
    await asTenant(tenant, async (c) => {
      await c.query(
        `UPDATE hsn_sac_rates SET effective_to = DATE '2027-01-01' WHERE id = $1`,
        [rate1800],
      );
      await c.query(
        `INSERT INTO hsn_sac_rates
           (id, tenant_id, hsn_sac_id, rate_bps, cess_rate_bps,
            effective_from, effective_to, notification_ref)
         VALUES ($1,$2,$3,500,0, DATE '2027-01-01', NULL, $4)`,
        [rate500, tenant, sacCodeId, NOTIFICATION_2027],
      );
    });
  });

  it("⭐ the new period really is there — otherwise every assertion below is vacuous", async () => {
    // ⚠️ ASSERTED FIRST, FOR THE SAME REASON SQL 0150 §6 asserts `v_ran`
    // before reading any verdict. "Nothing moved" is trivially true if
    // nothing happened, and a section that cannot tell those apart is a
    // section that reports green on a fixture that failed to build.
    const periods = await asTenant(tenant, async (c) => {
      const { rows } = await c.query(
        `SELECT rate_bps, effective_from::text AS f, effective_to::text AS t
           FROM hsn_sac_rates WHERE hsn_sac_id = $1 ORDER BY effective_from`,
        [sacCodeId],
      );
      return rows;
    });
    expect(periods).toEqual([
      { rate_bps: 1200, f: "2017-07-01", t: "2019-04-01" },
      { rate_bps: 1800, f: "2019-04-01", t: "2027-01-01" },
      { rate_bps: 500, f: "2027-01-01", t: null },
    ]);
  });

  it("⭐⭐⭐ neither trail moved: same rate, same notification, same money, same period", async () => {
    for (const [label, raised] of [
      ["A", invoiceA],
      ["B", invoiceB],
    ] as const) {
      const before = trailBeforeThirdPeriod[label]!;
      const after = await getTaxDecisionsForDocument(tenant, {
        documentTable: "sales_invoice_lines",
        documentId: raised.invoiceId,
      });

      // ⚠️ THE WHOLE VIEW IS COMPARED, not a hand-picked field. A
      // comparison that named `rateBps` would miss a restated
      // notification, and the notification is the citation.
      expect(after, `invoice ${label}'s decision must not have moved`).toEqual(before);
    }
  });

  it("⭐ specifically: invoice A still cites the 18% period, and it still shows the period OPEN as at issue", async () => {
    const trail = await trailFor(invoiceA);
    expect(trail.rate.rateBps).toBe(1800);
    expect(trail.rate.notificationRef).toBe(NOTIFICATION_2019);

    /**
     * ⭐⭐ THE SHARPEST ASSERTION IN THE FILE. `hsn_sac_rates` now says
     * this period ENDS on 2027-01-01. The decision still says `null` —
     * "open, as at the day this document was issued" — because the column
     * was COPIED and not joined. A reader that resolved the period by
     * joining would see 2027-01-01 here and would be reporting a fact
     * about today's master data dressed up as a fact about the invoice.
     */
    expect(trail.rate.effectiveTo).toBeNull();

    const masterNow = await asTenant(tenant, async (c) => {
      const { rows } = await c.query(
        `SELECT effective_to::text AS t FROM hsn_sac_rates WHERE id = $1`,
        [rate1800],
      );
      return rows[0].t as string | null;
    });
    expect(masterNow).toBe("2027-01-01");
    expect(masterNow).not.toBe(trail.rate.effectiveTo);
  });

  it("⭐⭐ and re-quoting the 2018 document AFTER the new period still produces 2018's figures", async () => {
    /**
     * ⭐ THE LIVE HALF OF SECTION B, RUN AGAINST A REGISTRY THAT HAS
     * MOVED TWICE SINCE. Three periods now exist; the engine is asked to
     * price 2018-06-01 and must still answer 12% under the 2017
     * notification. This is the property the brief calls the single most
     * important one in the registry, and it is asserted against the
     * WORST case — a master with a period on either side.
     */
    const requoted = await computePersistableTax(tenant, {
      supplierRegistrationId: regKarnataka,
      supplyType: "services",
      recipientRegistration: "regular",
      recipientStateCode: "29",
      propertyStateCode: null,
      deliveryStateCode: null,
      taxPointDate: DATE_2018,
      roundToRupee: false,
      lines: [
        {
          key: "L1",
          description: "Structural design and drawing services",
          hsnSacCode: SAC,
          quantity: 1,
          uqc: "nos",
          amount: ODD_AMOUNT,
          discount: null,
          reverseCharge: false,
        },
      ],
    });

    expect(requoted.ok).toBe(true);
    if (!requoted.ok) return;

    expect(requoted.tax.lines[0]!.taxRateBps).toBe(1200);
    expect(requoted.tax.lines[0]!.hsnSacRateId).toBe(rate1200);
    expect(requoted.quote.rateByLine.L1!.notificationRef).toBe(NOTIFICATION_2017);
    expect(requoted.tax.lines[0]!.cgstMinor).toBe(601n);
    expect(requoted.tax.lines[0]!.sgstMinor).toBe(600n);
  });

  it("⭐⭐ editing the used 18% row's rate_bps is REFUSED — and the same edit on an UNUSED row is ACCEPTED", async () => {
    /**
     * ══════════════════════════════════════════════════════════════════
     * ⭐ THE GUARD THAT LEARNED ABOUT SALES INVOICES IN SQL 0146
     * ══════════════════════════════════════════════════════════════════
     * `enforce_gst_rate_history_immutable` counts dependants through
     * `gst_rate_usage()`, which before 0146 knew about `invoice_lines`
     * and not about `sales_invoice_lines`. Invoice A's line pins
     * `rate1800`; if the guard still had that gap, the UPDATE below would
     * succeed and every document raised under this period would silently
     * be restated from 18% to 5% — including ones already filed.
     */
    const refused = await expectError(() =>
      asTenant(tenant, async (c) =>
        c.query(`UPDATE hsn_sac_rates SET rate_bps = 500 WHERE id = $1`, [rate1800]),
      ),
    );

    expect(refused, "a rate used by a sales invoice line must not be editable").not.toBeNull();
    expect(refused!.message).toMatch(/already been used on \d+ document line/i);

    // And it really did not move.
    const unchanged = await asTenant(tenant, async (c) => {
      const { rows } = await c.query(`SELECT rate_bps FROM hsn_sac_rates WHERE id = $1`, [
        rate1800,
      ]);
      return rows[0].rate_bps as number;
    });
    expect(unchanged).toBe(1800);

    /**
     * ⭐ THE SIBLING, AND IT IS THE SAME COLUMN ON THE SAME TABLE THROUGH
     * THE SAME TRIGGER. The only difference is that no document uses
     * `rate500` yet. If the guard refused this too, a workspace could
     * never correct a rate it had just typed wrong — which is a product
     * that cannot be used in the week a notification lands.
     */
    await asTenant(tenant, async (c) =>
      c.query(`UPDATE hsn_sac_rates SET rate_bps = 600 WHERE id = $1`, [rate500]),
    );
    const edited = await asTenant(tenant, async (c) => {
      const { rows } = await c.query(`SELECT rate_bps FROM hsn_sac_rates WHERE id = $1`, [
        rate500,
      ]);
      return rows[0].rate_bps as number;
    });
    expect(edited).toBe(600);

    // Put it back, so the period list assertion above stays true on a
    // re-run in any order.
    await asTenant(tenant, async (c) =>
      c.query(`UPDATE hsn_sac_rates SET rate_bps = 500 WHERE id = $1`, [rate500]),
    );
  });
});

/* ================================================================== */
/* D. ⭐⭐ THE TRAIL CANNOT LIE — AND IT CAN STILL TELL THE TRUTH       */
/* ================================================================== */

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHY A DECISION LOG NEEDS A TRIGGER AT ALL
 * ══════════════════════════════════════════════════════════════════════
 * An audit log that accepts arbitrary numbers is a second, unchecked copy
 * of the document — and WORSE than none, because it reads like
 * corroboration. SQL 0150 §3 is the only reason the table is safe to
 * believe: every row must recompute from its OWN taxable value, rate and
 * `tax_kind`, using 0147's primitives and nothing else.
 *
 * ⚠️ BOTH HALVES, ALWAYS. The refusal on its own is satisfied by a
 * trigger that raises on every insert, which would mean no document could
 * ever carry a trail. The acceptance on its own is satisfied by no
 * trigger at all.
 */
describe("D — ⭐⭐ a decision whose money does not follow from its own rate is refused", () => {
  it("⭐⭐ REFUSED: 10005 paise at 1800 bps recorded as 900 / 900", async () => {
    // The even split of an odd tax. It loses a paisa, it is the natural
    // thing to write, and nobody notices until a return does not foot.
    const refused = await expectError(() =>
      asTenant(tenant, async (c) =>
        c.query(
          `INSERT INTO tax_decisions
             (tenant_id, document_table, document_line_id, document_id, document_date,
              rate_bps, tax_kind, taxable_value_minor, cgst_minor, sgst_minor,
              engine_version)
           VALUES ($1,'sales_invoice_lines',$2,$3, DATE '${DATE_2026}',
                   1800,'cgst_sgst', 10005, 900, 900, 'trail-test')`,
          [tenant, randomUUID(), invoiceA.invoiceId],
        ),
      ),
    );

    expect(refused).not.toBeNull();
    expect(refused!.code, "0150 §3 raises a check_violation").toBe("23514");
    expect(refused!.message).toMatch(/does not recompute/i);
  });

  it("⭐⭐ ACCEPTED: the same row split 901 / 900", async () => {
    /**
     * 🔴 THE SIBLING, AND IT IS NOT OPTIONAL. A `cgst_minor = sgst_minor`
     * constraint would refuse this CORRECT row while passing the refusal
     * test above — and the product would then be unable to record the
     * reasoning behind any invoice with an odd tax, which is roughly half
     * of them.
     */
    const lineId = randomUUID();
    await asTenant(tenant, async (c) =>
      c.query(
        `INSERT INTO tax_decisions
           (tenant_id, document_table, document_line_id, document_id, document_date,
            rate_bps, tax_kind, taxable_value_minor, cgst_minor, sgst_minor,
            engine_version)
         VALUES ($1,'sales_invoice_lines',$2,$3, DATE '${DATE_2026}',
                 1800,'cgst_sgst', 10005, 901, 900, 'trail-test')`,
        [tenant, lineId, invoiceA.invoiceId],
      ),
    );

    const stored = await asTenant(tenant, async (c) => {
      const { rows } = await c.query(
        `SELECT cgst_minor::text AS cgst, sgst_minor::text AS sgst
           FROM tax_decisions WHERE document_line_id = $1`,
        [lineId],
      );
      return rows;
    });
    expect(stored).toEqual([{ cgst: "901", sgst: "900" }]);

    await asTenant(tenant, async (c) =>
      c.query(`DELETE FROM tax_decisions WHERE document_line_id = $1`, [lineId]),
    );
  });

  it("⭐ REFUSED: tax_kind says cgst_sgst and the money says IGST — and ACCEPTED once the head agrees", async () => {
    // ⚠️ THE HEAD IS READ FROM `tax_kind`, NOT INFERRED FROM WHICHEVER
    // AMOUNT IS NON-ZERO, so this disagreement is detectable at all. On a
    // line table it is not — the row has no column saying which head was
    // chosen — which is why 0147's trigger has to infer it and needs a
    // special case for an all-zero line.
    const refused = await expectError(() =>
      asTenant(tenant, async (c) =>
        c.query(
          `INSERT INTO tax_decisions
             (tenant_id, document_table, document_line_id, document_id, document_date,
              rate_bps, tax_kind, taxable_value_minor, igst_minor, engine_version)
           VALUES ($1,'sales_invoice_lines',$2,$3, DATE '${DATE_2026}',
                   1800,'cgst_sgst', 10005, 1801, 'trail-test')`,
          [tenant, randomUUID(), invoiceA.invoiceId],
        ),
      ),
    );
    expect(refused).not.toBeNull();
    expect(refused!.code).toBe("23514");

    const lineId = randomUUID();
    await asTenant(tenant, async (c) =>
      c.query(
        `INSERT INTO tax_decisions
           (tenant_id, document_table, document_line_id, document_id, document_date,
            rate_bps, tax_kind, taxable_value_minor, igst_minor, engine_version)
         VALUES ($1,'sales_invoice_lines',$2,$3, DATE '${DATE_2026}',
                 1800,'igst', 10005, 1801, 'trail-test')`,
        [tenant, lineId, invoiceA.invoiceId],
      ),
    );
    const stored = await asTenant(tenant, async (c) => {
      const { rows } = await c.query(
        `SELECT tax_kind, igst_minor::text AS igst FROM tax_decisions WHERE document_line_id = $1`,
        [lineId],
      );
      return rows;
    });
    expect(stored).toEqual([{ tax_kind: "igst", igst: "1801" }]);

    await asTenant(tenant, async (c) =>
      c.query(`DELETE FROM tax_decisions WHERE document_line_id = $1`, [lineId]),
    );
  });

  it("⭐ the application layer says it in a sentence before the trigger says it in an exception", async () => {
    /**
     * ⭐ `recordTaxDecisions` FRONT-RUNS 0150 §3 RATHER THAN WEAKENING
     * IT. The database stays authoritative — the two assertions above
     * prove it still refuses — and this one proves the caller gets a
     * diagnosis naming the line instead of `ERRCODE 23514` arriving after
     * the transaction has done other work.
     */
    const thrown = await expectError(() =>
      recordTaxDecisions(tenant, {
        documentTable: "sales_invoice_lines",
        documentId: invoiceA.invoiceId,
        documentDate: DATE_2026,
        lines: [
          {
            documentLineId: randomUUID(),
            lineNo: 1,
            hsnSacCode: SAC,
            hsnSacRateId: rate1800,
            rateBps: 1800,
            cessRateBps: 0,
            notificationRef: NOTIFICATION_2019,
            rateEffectiveFrom: "2019-04-01",
            rateEffectiveTo: null,
            taxKind: "cgst_sgst",
            isReverseCharge: false,
            reverseChargeBasis: null,
            taxableValueMinor: 10005n,
            cgstMinor: 900n,
            sgstMinor: 900n,
            igstMinor: 0n,
            cessMinor: 0n,
          },
        ],
        placeOfSupply: {
          code: "29",
          basis: "recipient_registration",
          statutoryRef: "Section 12(2)(a), IGST Act",
          explanation: "Recipient registered in Karnataka.",
        },
        decidedBy: "trail-test",
      }),
    );

    expect(thrown).not.toBeNull();
    expect(thrown!.message).toMatch(/does not recompute/i);
    expect(thrown!.message).toContain("1801");
  });
});

/* ================================================================== */
/* E. ⭐ THE UNION TERRITORY CASE                                       */
/* ================================================================== */

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE AMOUNT IS IDENTICAL AND THE ACT IS NOT
 * ══════════════════════════════════════════════════════════════════════
 * In a Union Territory WITHOUT a legislature the second half of an
 * intra-state supply is UTGST under the UTGST Act, not SGST under a State
 * Act. The arithmetic is the same, the money is the same, and the figure
 * belongs in a different box of the return. `lib/gst/constants.ts` records
 * that Phase 49 declined to make this distinction "out of caution" and
 * billed every intra-UT supply as CGST + SGST — the right money in the
 * wrong Act.
 *
 * ⭐ `tax_decisions.tax_kind` IS THE ONLY PLACE IN THIS SCHEMA WHERE THAT
 * DISTINCTION IS RECORDED AT ALL. No line table has a `utgst_minor`
 * column, so the amount lands in `sgst_minor` and is uninterpretable
 * without the kind beside it. SQL 0150 §1 says exactly this, at length,
 * and it is the reason the column is not a boolean.
 *
 * ⚠️ THIS TEST WAS WRITTEN TO FAIL IF THE CODE PATH COULD NOT PRODUCE
 * `cgst_utgst`. It is not skipped and it is not softened: the fixture
 * attempts the document in `beforeAll`, records any refusal, and the
 * assertion below reports it. It passes because the path genuinely works
 * end to end — `determinePlaceOfSupply` → `taxKindFor` → `PersistableTax`
 * → `buildTaxDecisionsForSalesInvoice` → `tax_decisions.tax_kind`.
 */
describe("E — ⭐ an intra-UT supply is recorded as cgst_utgst, not cgst_sgst", () => {
  it("⭐ the UT document was raised at all", () => {
    expect(
      unionTerritoryRefusal,
      "the intra-UT invoice could not be raised — see the message",
    ).toBeNull();
    expect(invoiceUT).not.toBeNull();
  });

  it("⭐⭐ the trail says cgst_utgst", async () => {
    const trail = await trailFor(invoiceUT!);

    expect(trail.treatment.taxKind).toBe("cgst_utgst");
    // 🔴 THE NEGATIVE, SPELLED OUT. `cgst_sgst` is the value a cautious
    // implementation writes, it is what Phase 49 wrote, and it is wrong.
    expect(trail.treatment.taxKind).not.toBe("cgst_sgst");
    expect(trail.placeOfSupply.code).toBe("26");
  });

  it("⭐ and the money is the SAME as the SGST case — which is why the kind is the only thing that carries the difference", async () => {
    const ut = await trailFor(invoiceUT!);
    const sgst = await trailFor(invoiceA);

    // Same taxable value, same rate, same split, same column.
    expect(ut.money.taxableValueMinor).toBe(sgst.money.taxableValueMinor);
    expect(ut.rate.rateBps).toBe(sgst.rate.rateBps);
    expect(ut.money.cgstMinor).toBe(sgst.money.cgstMinor);
    expect(ut.money.sgstMinor).toBe(sgst.money.sgstMinor);

    // ⚠️ AND THE HEADER FLAG AGREES. `sales_invoices.is_union_territory`
    // is a boolean that says the state is a UT; `tax_decisions.tax_kind`
    // says which Act the second half was charged under. Two records of
    // the same fact that disagree would be worse than one.
    const header = await asTenant(tenant, async (c) => {
      const { rows } = await c.query(
        `SELECT is_union_territory, is_inter_state FROM sales_invoices WHERE id = $1`,
        [invoiceUT!.invoiceId],
      );
      return rows[0];
    });
    expect(header.is_union_territory).toBe(true);
    expect(header.is_inter_state).toBe(false);
  });
});

/* ================================================================== */
/* F. ⭐⭐ THE WORKING PAPER                                            */
/* ================================================================== */

describe("F — ⭐⭐ print the trace a chartered accountant would accept", () => {
  it("⭐⭐ prints the full working paper for invoice A", async () => {
    /**
     * ⭐ THIS IS THE DELIVERABLE, NOT DEBUG OUTPUT. Every line is
     * prefixed `TRACE |` so it can be grepped out of a suite run and
     * pasted into a report, and every figure below is READ BACK from the
     * database rather than remembered from the fixture — a working paper
     * assembled from the test's own variables would prove nothing about
     * what was stored.
     */
    const trail = await trailFor(invoiceA);

    const doc = await asTenant(tenant, async (c) => {
      const { rows } = await c.query(
        `SELECT i.invoice_number, i.invoice_date::text AS invoice_date,
                i.supplier_gstin, i.supplier_state_code,
                co.name AS customer,
                l.line_no, l.description,
                l.taxable_value_minor::text AS taxable,
                l.cgst_minor::text AS cgst, l.sgst_minor::text AS sgst,
                l.igst_minor::text AS igst, l.cess_minor::text AS cess,
                gst_apply_rate_bps(d.taxable_value_minor, d.rate_bps)::text AS recomputed
           FROM sales_invoices i
           JOIN companies co ON co.id = i.company_id
           JOIN sales_invoice_lines l ON l.invoice_id = i.id
           JOIN tax_decisions d ON d.document_line_id = l.id
          WHERE i.id = $1`,
        [invoiceA.invoiceId],
      );
      return rows[0] as Record<string, string | number>;
    });

    const rupees = (minor: string | bigint) => {
      const value = BigInt(minor);
      const sign = value < 0n ? "-" : "";
      const abs = value < 0n ? -value : value;
      return `${sign}₹${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, "0")}`;
    };
    const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;

    const out = (label: string, value: string) =>
      console.log(`TRACE | ${label.padEnd(26)}| ${value}`);

    console.log("TRACE | " + "═".repeat(88));
    console.log("TRACE | GST WORKING PAPER — how this line was taxed, and under what authority");
    console.log("TRACE | " + "═".repeat(88));
    out("Document", `${doc.invoice_number}  dated ${doc.invoice_date}`);
    out("Supplier", `${doc.supplier_gstin} (state ${doc.supplier_state_code})`);
    out("Recipient", String(doc.customer));
    out("Line", `${doc.line_no} — ${doc.description}`);
    console.log("TRACE | " + "─".repeat(88));
    out("HSN / SAC", `${trail.rate.hsnSacCode}`);
    out("Taxable value", `${rupees(doc.taxable)}  (${doc.taxable} paise)`);
    out("Rate applied", `${pct(trail.rate.rateBps)}  (${trail.rate.rateBps} bps)`);
    out(
      "Rate period",
      `${trail.rate.effectiveFrom} → ${trail.rate.effectiveTo ?? "open"}  [rate row ${trail.rate.hsnSacRateId}]`,
    );
    out("Notification", String(trail.rate.notificationRef));
    console.log("TRACE | " + "─".repeat(88));
    out("Place of supply", `${trail.placeOfSupply.code} (Karnataka)`);
    out("Basis", String(trail.placeOfSupply.basis));
    out("Statutory reference", String(trail.placeOfSupply.statutoryRef));
    out("Reasoning", String(trail.placeOfSupply.explanation));
    console.log("TRACE | " + "─".repeat(88));
    out("Tax kind", `${trail.treatment.taxKind} (intra-state: CGST + SGST)`);
    out("Reverse charge", trail.treatment.isReverseCharge ? "yes" : "no — forward charge");
    console.log("TRACE | " + "─".repeat(88));
    out("CGST", `${rupees(doc.cgst)}  (${doc.cgst} paise)`);
    out("SGST / UTGST", `${rupees(doc.sgst)}  (${doc.sgst} paise)`);
    out("IGST", `${rupees(doc.igst)}  (${doc.igst} paise)`);
    out("Cess", `${rupees(doc.cess)}  (${doc.cess} paise)`);
    console.log("TRACE | " + "─".repeat(88));
    out(
      "Recompute check",
      `${doc.taxable} paise × ${trail.rate.rateBps} bps = ${doc.recomputed} paise of tax, ` +
        `split ${doc.cgst} / ${doc.sgst}`,
    );
    out("Decided by", `${trail.decidedBy}`);
    out("Engine version", `${trail.engineVersion}`);
    out("Decision id", `${trail.id}`);
    console.log("TRACE | " + "═".repeat(88));

    // ⚠️ THE PRINT IS NOT THE TEST. If any figure above were missing the
    // working paper would print `null` and read as complete, so the
    // assertion is that every field a defence needs is populated.
    expect(doc.recomputed).toBe("1801");
    expect(trail.rate.notificationRef).toBeTruthy();
    expect(trail.placeOfSupply.statutoryRef).toBeTruthy();
    expect(trail.placeOfSupply.basis).toBeTruthy();
    expect(trail.rate.hsnSacRateId).toBeTruthy();
    expect(trail.engineVersion).toBeTruthy();
  });
});
