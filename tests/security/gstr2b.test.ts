/**
 * Ordence — ⭐ GSTR-2B Reconciliation
 * Version: v0.34.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE IS ACTUALLY TRYING TO PROVE
 * ══════════════════════════════════════════════════════════════════════
 * Thirty-three phases say the same thing: the defects that survive are
 * the SILENT ones. Phase 33's were silent AND profitable — a blocked
 * credit claimed improves this month's cash and surfaces years later.
 *
 * This phase's are worse again, because they are silent and they LOOK
 * LIKE GOOD NEWS:
 *
 *   • An invoice dropped from the buckets makes "in books, not in 2B"
 *     smaller than it should be. Fewer suppliers to chase. More credit
 *     available. Every row on every screen is correct and the totals
 *     still look like totals — and the credit is then claimed, under
 *     Section 16(2)(aa), on an invoice the supplier never filed.
 *
 *   • `INV-001` and `INV/001` failing to match reports ONE ordinary
 *     invoice as BOTH an unfiled supplier AND an unrecorded purchase.
 *     Two errors in opposite directions, so the period totals still net
 *     out to something plausible.
 *
 *   • A re-import of a FILED July silently restates the working paper
 *     for a GSTR-3B the Government holds a copy of. Nothing errors and
 *     nothing says it changed.
 *
 *   • A parse bug that rolls back the transaction that stored the raw
 *     file destroys the one artefact the customer cannot reconstruct
 *     from their own paper.
 *
 * So the tests below do not inspect constraints. They build a realistic
 * month of invoices and run the engine over it, demanding each of the
 * seven categories. They add the summary up and demand it equal its
 * inputs EXACTLY. They ask the database to re-import a filed period, and
 * to accept a match with nobody named against it.
 *
 * ⚠️ EVERY DATABASE ASSERTION RUNS AS THE ORDINARY APPLICATION ROLE.
 * `asSuperuser` appears only for fixtures and teardown, because a
 * superuser bypasses row-level security entirely and a suite written on
 * one proves nothing.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { asTenant, asSuperuser, withoutTenant, expectError } from "../setup";

import {
  canonicaliseInvoiceNumber,
  normaliseInvoiceNumber,
  invoiceNumbersEquivalent,
  invoiceNumbersIdentical,
  describeNumberDifference,
} from "@/lib/gstr2b/invoice-number";
import {
  DEFAULT_MATCH_TOLERANCE,
  STRICT_MATCH_TOLERANCE,
  civilDaysApart,
} from "@/lib/gstr2b/tolerance";
import {
  parseGstr2bJson,
  parseGstr2bDelimited,
  parseDelimitedText,
  portalDateToCivilDay,
  portalPeriodToTaxPeriod,
  rupeesToPaise,
} from "@/lib/gstr2b/parse";
import {
  reconcileGstr2b,
  MATCH_ENGINE_VERSION,
  type BookInvoiceFacts,
  type MatchResult,
  type TwoBRowFacts,
} from "@/lib/gstr2b/matching";
import { summariseReconciliation } from "@/lib/gstr2b/summary";
import { chaseVendors, totalItcAtRisk } from "@/lib/gstr2b/chase";
import { importGstr2bSchema, decideMatchSchema } from "@/lib/validators/gstr2b";

/* ================================================================== */
/* ⭐ A REALISTIC MONTH — the fixture every engine test runs on        */
/* ================================================================== */

/**
 * July 2024 for a developer registered in Maharashtra. Eight bills in the
 * purchase register, seven documents in GSTR-2B, and every one of the
 * seven outcomes represented exactly once except the two "missing"
 * categories, which are the ones that matter and appear more than once.
 *
 * ⚠️ THE NUMBERS ARE PAISE AND THE ARITHMETIC IS DELIBERATE. The
 * identity assertions later in the file recompute these totals from the
 * fixture rather than hard-coding them, so a change here cannot make the
 * reconciliation test pass by accident.
 */

const S1 = "27AABCS1429B1ZU"; // cement, matches exactly
const S2 = "27AACCN2233F1ZU"; // hardware, invoice number formatted differently
const S3 = "29AAGCT4499K1ZH"; // ⭐ the contractor who has NOT filed
const S4 = "27AADCA7788L1ZZ"; // amended their invoice
const S5 = "27AAECX1122M1Z9"; // cancelled their invoice
const S6 = "27AAFCP5500N1Z8"; // genuinely different invoice number
const S7 = "27AAGCZ0011Q1Z3"; // filed something we never recorded
const S8 = "27AAHCH7700R1Z0"; // ⭐ our own head office — credit blocked 17(5)(d)

const book = (
  id: string,
  supplierGstin: string,
  invoiceNumber: string,
  invoiceDate: string,
  taxable: bigint,
  heads: { cgst?: bigint; sgst?: bigint; igst?: bigint; cess?: bigint },
  itcEligible: bigint,
  vendorName: string,
): BookInvoiceFacts => ({
  id,
  supplierGstin,
  invoiceNumber,
  invoiceDate,
  taxableValueMinor: taxable,
  cgstMinor: heads.cgst ?? 0n,
  sgstMinor: heads.sgst ?? 0n,
  igstMinor: heads.igst ?? 0n,
  cessMinor: heads.cess ?? 0n,
  itcEligibleTaxMinor: itcEligible,
  vendorId: `vendor-${supplierGstin}`,
  vendorName,
});

const twoB = (
  id: string,
  supplierGstin: string,
  invoiceNumber: string,
  invoiceDate: string,
  taxable: bigint,
  heads: { cgst?: bigint; sgst?: bigint; igst?: bigint; cess?: bigint },
  extra?: Partial<TwoBRowFacts>,
): TwoBRowFacts => ({
  id,
  section: "b2b",
  supplierGstin,
  supplierName: `Supplier ${supplierGstin.slice(2, 6)}`,
  invoiceNumber,
  invoiceDate,
  taxableValueMinor: taxable,
  cgstMinor: heads.cgst ?? 0n,
  sgstMinor: heads.sgst ?? 0n,
  igstMinor: heads.igst ?? 0n,
  cessMinor: heads.cess ?? 0n,
  itcAvailable: "available",
  ...extra,
});

/** ₹1,00,000 + 18% split CGST/SGST — the ordinary intra-state case. */
const BOOKS: BookInvoiceFacts[] = [
  book("b-exact", S1, "SC/2024/117", "2024-07-05", 10_000_000n,
    { cgst: 900_000n, sgst: 900_000n }, 1_800_000n, "Sahyadri Cement"),
  book("b-probable", S1, "SC/2024/118", "2024-07-08", 5_000_000n,
    { cgst: 450_000n, sgst: 450_000n }, 900_000n, "Sahyadri Cement"),
  book("b-number", S2, "INV/001", "2024-07-10", 2_000_000n,
    { cgst: 180_000n, sgst: 180_000n }, 360_000n, "Nashik Hardware"),
  // ⭐ ₹4,00,000 of steel from a contractor who has not filed. The single
  // most expensive row in the fixture and the whole point of the phase.
  book("b-missing", S3, "TC/88", "2024-07-12", 40_000_000n,
    { igst: 7_200_000n }, 7_200_000n, "Tirupati Constructions"),
  book("b-amended", S4, "AR/9", "2024-07-15", 1_000_000n,
    { cgst: 90_000n, sgst: 90_000n }, 180_000n, "Anand Architects"),
  book("b-cancelled", S5, "XY/3", "2024-07-18", 3_000_000n,
    { igst: 540_000n }, 540_000n, "Xylem Fittings"),
  book("b-diffnumber", S6, "PO-500", "2024-07-20", 1_500_000n,
    { cgst: 135_000n, sgst: 135_000n }, 270_000n, "Pune Plywood"),
  // ⭐ Cement into the head office we are building for ourselves. Section
  // 17(5)(d) blocked the credit, so it was NEVER claimable — and a
  // supplier who failed to file it has cost us nothing.
  book("b-blocked", S8, "HO/77", "2024-07-25", 5_000_000n,
    { cgst: 450_000n, sgst: 450_000n }, 0n, "Hindustan Hardware"),
];

const TWO_B: TwoBRowFacts[] = [
  twoB("r-exact", S1, "SC/2024/117", "2024-07-05", 10_000_000n,
    { cgst: 900_000n, sgst: 900_000n }),
  // 50 paise apart. They footed the invoice; we footed the lines.
  twoB("r-probable", S1, "SC/2024/118", "2024-07-08", 5_000_050n,
    { cgst: 450_000n, sgst: 450_000n }),
  // ⭐ Same bill, punctuation differs. `INV-001` vs `INV/001`.
  twoB("r-number", S2, "INV-001", "2024-07-10", 2_000_000n,
    { cgst: 180_000n, sgst: 180_000n }),
  twoB("r-extra", S7, "ZZ/1", "2024-07-22", 800_000n, { igst: 144_000n }),
  // ⭐ An amendment: their new number, our old one. It SUPERSEDES.
  twoB("r-amended", S4, "AR/9-R1", "2024-07-15", 1_100_000n,
    { cgst: 99_000n, sgst: 99_000n },
    { section: "b2ba", isAmendment: true, originalInvoiceNumber: "AR/9",
      originalInvoiceDate: "2024-07-15" }),
  twoB("r-cancelled", S5, "XY/3", "2024-07-18", 3_000_000n, { igst: 540_000n },
    { isCancelled: true }),
  // Same supplier, same day, same value — and a genuinely different
  // number. MUST NOT match.
  twoB("r-diffnumber", S6, "PO-501", "2024-07-20", 1_500_000n,
    { cgst: 135_000n, sgst: 135_000n }),
];

function run(): MatchResult[] {
  return reconcileGstr2b({ twoBRows: TWO_B, bookInvoices: BOOKS });
}

function categoriesOf(matches: MatchResult[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const match of matches) {
    counts[match.category] = (counts[match.category] ?? 0) + 1;
  }
  return counts;
}

function byBook(matches: MatchResult[], id: string): MatchResult {
  const found = matches.find((m) => m.bookInvoiceId === id);
  if (!found) throw new Error(`no match for book invoice ${id}`);
  return found;
}

function byRow(matches: MatchResult[], id: string): MatchResult {
  const found = matches.find((m) => m.twoBRowId === id);
  if (!found) throw new Error(`no match for 2B row ${id}`);
  return found;
}

/* ================================================================== */
/* DATABASE FIXTURES                                                   */
/* ================================================================== */

let tenantA: string;
let tenantB: string;
let userA: string;
let vendorA: string;
let vendorB: string;

const GSTIN_A = "27AAACR5055K1Z7";
const GSTIN_B = "29AAACR5055K1Z3";

/** July: an open reconciliation with one exact match and two exceptions. */
let docJulyA: string;
let rowExactA: string;
let rowExtraA: string;
let invExactA: string;
let invMissingA: string;
let reconJulyA: string;
let matchExactA: string;

/** ⭐ June: reconciled and FILED. The frozen period. */
let docJuneA: string;
let reconJuneA: string;

/** Tenant B's own July, so isolation has something real to hide. */
let docJulyB: string;
let rowB: string;
let invB: string;
let reconJulyB: string;

const HASH = (seed: string) => seed.repeat(64).slice(0, 64);

beforeAll(async () => {
  tenantA = randomUUID();
  tenantB = randomUUID();
  userA = randomUUID();
  vendorA = randomUUID();
  vendorB = randomUUID();
  docJulyA = randomUUID();
  rowExactA = randomUUID();
  rowExtraA = randomUUID();
  invExactA = randomUUID();
  invMissingA = randomUUID();
  reconJulyA = randomUUID();
  matchExactA = randomUUID();
  docJuneA = randomUUID();
  reconJuneA = randomUUID();
  docJulyB = randomUUID();
  rowB = randomUUID();
  invB = randomUUID();
  reconJulyB = randomUUID();

  await asSuperuser(async (c) => {
    for (const [id, name] of [
      [tenantA, "GSTR-2B Isolation A"],
      [tenantB, "GSTR-2B Isolation B"],
    ] as const) {
      await c.query(
        `INSERT INTO tenants (id, clerk_org_id, slug, name, status)
         VALUES ($1,$2,$3,$4,'active')`,
        [id, `org_${id}`, `g2b-${id.slice(0, 8)}`, name],
      );
    }

    await c.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, status)
       VALUES ($1,$2,$3,'g2b-a@example.test','tenant_admin','active')`,
      [userA, tenantA, `usr_${userA}`],
    );

    await c.query(
      `INSERT INTO vendors (id, tenant_id, code, legal_name)
       VALUES ($1,$2,'V-2B-A','Sahyadri Cement Pvt Ltd')`,
      [vendorA, tenantA],
    );
    await c.query(
      `INSERT INTO vendors (id, tenant_id, code, legal_name)
       VALUES ($1,$2,'V-2B-B','Other Tenant Supplier')`,
      [vendorB, tenantB],
    );

    /* --- Tenant A: two purchase invoices for July ---------------- */
    //
    // ⚠️ EXPLICIT BEGIN/COMMIT throughout. `adminPool` runs in autocommit,
    // and the GSTR-2B summary guard is DEFERRABLE INITIALLY DEFERRED — so
    // each statement would be its own transaction and the guard would fire
    // on a reconciliation whose matches did not exist yet. The real write
    // path builds the summary and its matches in one transaction, which is
    // what this reproduces.
    await c.query("BEGIN");

    await c.query(
      `INSERT INTO purchase_invoices
         (id, tenant_id, vendor_id, supplier_gstin, recipient_gstin,
          invoice_number, invoice_date, subtotal_minor, taxable_value_minor,
          cgst_minor, sgst_minor, total_minor, itc_eligible_tax_minor,
          tax_period, status)
       VALUES ($1,$2,$3,$4,$5,'SC/2024/117', DATE '2024-07-05',
               10000000, 10000000, 900000, 900000, 11800000, 1800000,
               '2024-07','recorded')`,
      [invExactA, tenantA, vendorA, S1, GSTIN_A],
    );
    // ⭐ The contractor who has not filed. ₹72,000 of credit at risk.
    await c.query(
      `INSERT INTO purchase_invoices
         (id, tenant_id, vendor_id, supplier_gstin, recipient_gstin,
          invoice_number, invoice_date, subtotal_minor, taxable_value_minor,
          igst_minor, total_minor, itc_eligible_tax_minor, tax_period, status)
       VALUES ($1,$2,$3,$4,$5,'TC/88', DATE '2024-07-12',
               40000000, 40000000, 7200000, 47200000, 7200000,
               '2024-07','recorded')`,
      [invMissingA, tenantA, vendorA, S3, GSTIN_A],
    );

    /* --- ⭐ June, FILED. The document goes in FIRST: the freeze --- */
    //     trigger refuses an import once the period is filed, which is
    //     exactly what one of the tests below proves.
    await c.query(
      `INSERT INTO gstr2b_documents
         (id, tenant_id, gstin, return_period, source_format, file_hash,
          raw_document, parse_status, row_count, parsed_at)
       VALUES ($1,$2,$3,'2024-06','portal_json',$4,
               '{"data":{"gstin":"27AAACR5055K1Z7","rtnprd":"062024","docdata":{"b2b":[]}}}'::jsonb,
               'parsed', 0, now())`,
      [docJuneA, tenantA, GSTIN_A, HASH("b")],
    );
    await c.query(
      `INSERT INTO gstr2b_reconciliations
         (id, tenant_id, gstin, tax_period, document_id, status,
          filed_at, filed_by, filed_reference)
       VALUES ($1,$2,$3,'2024-06',$4,'filed', now(), $5, 'AA270624JUNE')`,
      [reconJuneA, tenantA, GSTIN_A, docJuneA, userA],
    );

    /* --- July's statement and its rows --------------------------- */
    await c.query(
      `INSERT INTO gstr2b_documents
         (id, tenant_id, gstin, return_period, source_format, file_name,
          file_hash, raw_document, parse_status, row_count, parsed_at, imported_by)
       VALUES ($1,$2,$3,'2024-07','portal_json','GSTR2B_072024.json',$4,
               '{"data":{"gstin":"27AAACR5055K1Z7","rtnprd":"072024","docdata":{"b2b":[]}}}'::jsonb,
               'parsed', 2, now(), $5)`,
      [docJulyA, tenantA, GSTIN_A, HASH("a"), userA],
    );
    await c.query(
      `INSERT INTO gstr2b_rows
         (id, tenant_id, document_id, section, supplier_gstin, supplier_trade_name,
          invoice_number, normalised_number, invoice_date,
          taxable_value_minor, cgst_minor, sgst_minor, supplier_filing_period)
       VALUES ($1,$2,$3,'b2b',$4,'Sahyadri Cement','SC/2024/117','SC2024117',
               DATE '2024-07-05', 10000000, 900000, 900000, '2024-07')`,
      [rowExactA, tenantA, docJulyA, S1],
    );
    await c.query(
      `INSERT INTO gstr2b_rows
         (id, tenant_id, document_id, section, supplier_gstin, supplier_trade_name,
          invoice_number, normalised_number, invoice_date,
          taxable_value_minor, igst_minor, supplier_filing_period)
       VALUES ($1,$2,$3,'b2b',$4,'Zenith Traders','ZZ/1','ZZ1',
               DATE '2024-07-22', 800000, 144000, '2024-07')`,
      [rowExtraA, tenantA, docJulyA, S7],
    );

    /* --- ⭐ July's reconciliation. Totals chosen to satisfy BOTH -- */
    //     identity CHECKs and the deferred summary trigger:
    //       books 9,00,000 = matched 18,00,000? no —
    //       books tax = 1,800,000 (exact) + 7,200,000 (missing) = 9,000,000
    //       2B tax    = 1,800,000 (exact) +   144,000 (extra)   = 1,944,000
    await c.query(
      `INSERT INTO gstr2b_reconciliations
         (id, tenant_id, gstin, tax_period, document_id, status,
          books_invoice_count, books_taxable_minor, books_tax_minor,
          books_itc_eligible_minor,
          twob_row_count, twob_taxable_minor, twob_tax_minor,
          twob_itc_available_minor,
          matched_count, matched_books_tax_minor, matched_twob_tax_minor,
          in_books_not_in_2b_count, in_books_not_in_2b_tax_minor, itc_at_risk_minor,
          in_2b_not_in_books_count, in_2b_not_in_books_tax_minor,
          itc_claimed_minor, last_run_at, created_by)
       VALUES ($1,$2,$3,'2024-07',$4,'in_progress',
               2, 50000000, 9000000, 9000000,
               2, 10800000, 1944000, 1944000,
               1, 1800000, 1800000,
               1, 7200000, 7200000,
               1, 144000,
               1800000, now(), $5)`,
      [reconJulyA, tenantA, GSTIN_A, docJulyA, userA],
    );

    await c.query(
      `INSERT INTO gstr2b_matches
         (id, tenant_id, reconciliation_id, gstr2b_row_id, purchase_invoice_id,
          vendor_id, supplier_gstin, match_category, confidence, match_score,
          explanation, action, action_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'exact','exact',100,
               'Every field agrees exactly.','accepted', now())`,
      [matchExactA, tenantA, reconJulyA, rowExactA, invExactA, vendorA, S1],
    );
    await c.query(
      `INSERT INTO gstr2b_matches
         (tenant_id, reconciliation_id, purchase_invoice_id, vendor_id,
          supplier_gstin, match_category, confidence, match_score,
          itc_at_risk_minor, explanation)
       VALUES ($1,$2,$3,$4,$5,'in_books_not_in_2b','none',0, 7200000,
               'The supplier has not filed this invoice.')`,
      [tenantA, reconJulyA, invMissingA, vendorA, S3],
    );
    await c.query(
      `INSERT INTO gstr2b_matches
         (tenant_id, reconciliation_id, gstr2b_row_id, supplier_gstin,
          match_category, confidence, match_score, explanation)
       VALUES ($1,$2,$3,$4,'in_2b_not_in_books','none',0,
               'Filed against our GSTIN and not in the purchase register.')`,
      [tenantA, reconJulyA, rowExtraA, S7],
    );

    await c.query("COMMIT");

    /* --- Tenant B: its own July ---------------------------------- */
    await c.query("BEGIN");
    await c.query(
      `INSERT INTO purchase_invoices
         (id, tenant_id, vendor_id, supplier_gstin, recipient_gstin,
          invoice_number, invoice_date, subtotal_minor, taxable_value_minor,
          cgst_minor, sgst_minor, total_minor, itc_eligible_tax_minor,
          tax_period, status)
       VALUES ($1,$2,$3,$4,$5,'OT/1', DATE '2024-07-03',
               1000000, 1000000, 90000, 90000, 1180000, 180000,
               '2024-07','recorded')`,
      [invB, tenantB, vendorB, S2, GSTIN_B],
    );
    await c.query(
      `INSERT INTO gstr2b_documents
         (id, tenant_id, gstin, return_period, source_format, file_hash,
          raw_document, parse_status, row_count, parsed_at)
       VALUES ($1,$2,$3,'2024-07','portal_json',$4,
               '{"data":{"gstin":"29AAACR5055K1Z3"}}'::jsonb,'parsed',1,now())`,
      [docJulyB, tenantB, GSTIN_B, HASH("c")],
    );
    await c.query(
      `INSERT INTO gstr2b_rows
         (id, tenant_id, document_id, section, supplier_gstin, invoice_number,
          normalised_number, invoice_date, taxable_value_minor, cgst_minor, sgst_minor)
       VALUES ($1,$2,$3,'b2b',$4,'OT/1','OT1', DATE '2024-07-03',
               1000000, 90000, 90000)`,
      [rowB, tenantB, docJulyB, S2],
    );
    await c.query(
      `INSERT INTO gstr2b_reconciliations
         (id, tenant_id, gstin, tax_period, document_id, status,
          books_tax_minor, matched_books_tax_minor,
          twob_tax_minor, matched_twob_tax_minor, matched_count)
       VALUES ($1,$2,$3,'2024-07',$4,'in_progress',
               180000, 180000, 180000, 180000, 1)`,
      [reconJulyB, tenantB, GSTIN_B, docJulyB],
    );
    await c.query(
      `INSERT INTO gstr2b_matches
         (tenant_id, reconciliation_id, gstr2b_row_id, purchase_invoice_id,
          supplier_gstin, match_category, confidence, match_score, explanation)
       VALUES ($1,$2,$3,$4,$5,'exact','exact',100,'Every field agrees.')`,
      [tenantB, reconJulyB, rowB, invB, S2],
    );
    await c.query("COMMIT");
  });
});

afterAll(async () => {
  await asSuperuser(async (c) => {
    const tenants = [tenantA, tenantB];

    // ⚠️ Order matters, and it is the schema telling us something. The
    // foreign key from `gstr2b_matches` to `purchase_invoices` is
    // RESTRICT — a purchase invoice that has been reconciled against a
    // return cannot be deleted while the evidence points at it — so a
    // teardown that removed invoices first would be refused. That refusal
    // is one of the guarantees this phase is built on.
    await c.query(`DELETE FROM gstr2b_matches WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM gstr2b_reconciliations WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM gstr2b_rows WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM gstr2b_documents WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM purchase_invoice_lines WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM purchase_invoices WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM vendors WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM change_log WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM users WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM tenants WHERE id = ANY($1::uuid[])`, [tenants]);

    // Prove every guard is still enabled. A teardown that disabled one
    // would void the guarantee for every later run — and the suite would
    // still pass, which is the dangerous part.
    const { rows } = await c.query(
      `SELECT tgname, tgenabled::text AS state FROM pg_trigger
        WHERE tgrelid = 'gstr2b_documents'::regclass AND NOT tgisinternal`,
    );
    for (const row of rows) expect(row.state, row.tgname).toBe("O");
  });
});

/* ================================================================== */
/* 1. TENANT ISOLATION                                                 */
/* ================================================================== */

describe("tenant isolation", () => {
  it("⭐ a tenant sees only its own GSTR-2B statements", async () => {
    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(
        `SELECT gstin, return_period FROM gstr2b_documents ORDER BY return_period`,
      );
      expect(rows.map((r) => r.gstin)).toEqual([GSTIN_A, GSTIN_A]);
    });

    await asTenant(tenantB, async (c) => {
      const { rows } = await c.query(`SELECT gstin FROM gstr2b_documents`);
      expect(rows.map((r) => r.gstin)).toEqual([GSTIN_B]);
    });
  });

  it("⭐ a tenant sees only its own 2B rows, reconciliations and matches", async () => {
    // The 2B rows are the sharpest of the four: a statement is a
    // GOVERNMENT-COMPILED list of every supplier who invoiced this
    // company in a month, with amounts. It is a more complete supplier
    // list than the tenant's own purchase ledger.
    await asTenant(tenantB, async (c) => {
      const rows = await c.query(`SELECT supplier_gstin FROM gstr2b_rows`);
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].supplier_gstin).toBe(S2);

      const recon = await c.query(`SELECT gstin FROM gstr2b_reconciliations`);
      expect(recon.rows.map((r) => r.gstin)).toEqual([GSTIN_B]);

      const matches = await c.query(`SELECT id FROM gstr2b_matches`);
      expect(matches.rows).toHaveLength(1);
    });
  });

  it("no tenant context reads ZERO rows, never all rows", async () => {
    await withoutTenant(async (c) => {
      for (const table of [
        "gstr2b_documents",
        "gstr2b_rows",
        "gstr2b_reconciliations",
        "gstr2b_matches",
      ]) {
        const { rows } = await c.query(`SELECT count(*)::int AS n FROM ${table}`);
        expect(rows[0].n, table).toBe(0);
      }
    });
  });

  it("⭐ a match cannot point at ANOTHER TENANT'S purchase invoice", async () => {
    // The composite foreign key, not the RLS policy. FK checks run as the
    // system and ignore row-level security — and without (id, tenant_id)
    // this is an EXISTENCE ORACLE: guessing invoice ids until one is
    // accepted enumerates another developer's purchase ledger, with the
    // "matched" row confirming each hit.
    const error = await expectError(() =>
      asTenant(tenantB, async (c) =>
        c.query(
          `INSERT INTO gstr2b_matches
             (tenant_id, reconciliation_id, purchase_invoice_id, match_category,
              confidence, match_score, explanation)
           VALUES ($1,$2,$3,'in_books_not_in_2b','none',0,'probe')`,
          [tenantB, reconJulyB, invExactA],
        ),
      ),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23503");
  });

  it("⭐ a match cannot point at ANOTHER TENANT'S 2B row", async () => {
    const error = await expectError(() =>
      asTenant(tenantB, async (c) =>
        c.query(
          `INSERT INTO gstr2b_matches
             (tenant_id, reconciliation_id, gstr2b_row_id, match_category,
              confidence, match_score, explanation)
           VALUES ($1,$2,$3,'in_2b_not_in_books','none',0,'probe')`,
          [tenantB, reconJulyB, rowExactA],
        ),
      ),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23503");
  });

  it("one tenant cannot accept another's proposed match", async () => {
    await asTenant(tenantB, async (c) => {
      const { rowCount } = await c.query(
        `UPDATE gstr2b_matches SET action = 'rejected' WHERE id = $1`,
        [matchExactA],
      );
      // Not an error — RLS makes the row invisible, so the UPDATE simply
      // matches nothing. Fail closed, silently, which is correct.
      expect(rowCount).toBe(0);
    });

    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(
        `SELECT action FROM gstr2b_matches WHERE id = $1`,
        [matchExactA],
      );
      expect(rows[0].action).toBe("accepted");
    });
  });
});

/* ================================================================== */
/* 2. ⭐ INVOICE-NUMBER NORMALISATION                                  */
/* ================================================================== */

describe("⭐ invoice-number normalisation", () => {
  it("matches INV-001, INV/001, INV 001, inv001 and INV1", async () => {
    const variants = ["INV-001", "INV/001", "INV 001", "inv001", "INV1", "INV-0001"];
    for (const variant of variants) {
      expect(normaliseInvoiceNumber(variant), variant).toBe("INV1");
      expect(invoiceNumbersEquivalent("INV-001", variant), variant).toBe(true);
    }
  });

  it("⭐ does NOT match genuinely different numbers", async () => {
    // The whole value of the normalisation is destroyed if it also
    // merges these: they are two different invoices from one supplier in
    // one month, and merging them claims one credit and loses the other.
    const different: [string, string][] = [
      ["INV-001", "INV-002"],
      ["INV-010", "INV-100"],
      ["INV-001", "2024/INV/001"],
      ["PO-500", "PO-501"],
      ["SC/2024/117", "SC/2024/118"],
      ["A/1", "B/1"],
      ["INV-1", "INV-11"],
    ];
    for (const [left, right] of different) {
      expect(invoiceNumbersEquivalent(left, right), `${left} vs ${right}`).toBe(false);
    }
  });

  it("⚠️ a run of only zeros keeps one digit — INV-000 is not INV", async () => {
    expect(normaliseInvoiceNumber("INV-000")).toBe("INV0");
    expect(invoiceNumbersEquivalent("INV-000", "INV")).toBe(false);
  });

  it("⚠️ an empty or all-punctuation number matches nothing", async () => {
    // Otherwise every such row would collide with every other one, and
    // the engine would confidently pair two documents that have nothing
    // in common.
    expect(normaliseInvoiceNumber("///")).toBe("");
    expect(invoiceNumbersEquivalent("///", "---")).toBe(false);
    expect(invoiceNumbersEquivalent("", "")).toBe(false);
  });

  it("canonicalisation collapses case and spacing but keeps the separator", async () => {
    expect(canonicaliseInvoiceNumber("  inv/001  ")).toBe("INV/001");
    expect(invoiceNumbersIdentical("inv/001 ", "INV/001")).toBe(true);
    // ⚠️ `INV 001` and `INV001` are NOT identical: one has a separator.
    // Calling them identical would let a real formatting difference be
    // recorded as an EXACT match and auto-accepted.
    expect(invoiceNumbersIdentical("INV 001", "INV001")).toBe(false);
    expect(invoiceNumbersEquivalent("INV 001", "INV001")).toBe(true);
  });

  it("⭐ the difference is DESCRIBED, and the supplier's number is quoted first", async () => {
    const sentence = describeNumberDifference("INV-001", "INV/001");
    expect(sentence).toContain("INV-001");
    expect(sentence).toContain("INV/001");
    expect(sentence).toContain("do not overwrite");
    expect(describeNumberDifference("INV/001", "inv/001 ")).toBeNull();
  });
});

/* ================================================================== */
/* 3. ⭐⭐ THE MATCHING ENGINE — EVERY CATEGORY                        */
/* ================================================================== */

describe("⭐⭐ the matching engine", () => {
  it("produces every category exactly as expected from a realistic month", async () => {
    const matches = run();
    expect(categoriesOf(matches)).toEqual({
      exact: 1,
      probable: 1,
      number_mismatch: 1,
      amended: 1,
      cancelled: 1,
      in_2b_not_in_books: 2,
      in_books_not_in_2b: 3,
    });
  });

  it("EXACT — every field agrees, and only that category may be auto-accepted", async () => {
    const match = byBook(run(), "b-exact");
    expect(match.category).toBe("exact");
    expect(match.confidence).toBe("exact");
    expect(match.score).toBe(100);
    expect(match.differences).toHaveLength(0);
    expect(match.taxableDeltaMinor).toBe(0n);
    expect(match.taxDeltaMinor).toBe(0n);
    expect(match.autoAcceptable).toBe(true);

    // ⭐ AND NOTHING ELSE IS. This is the prohibition the whole phase
    // turns on, asserted over every other match in the fixture.
    for (const other of run()) {
      if (other.category === "exact") continue;
      expect(other.autoAcceptable, other.category).toBe(false);
    }
  });

  it("PROBABLE — same supplier and number, values inside the round-off band", async () => {
    const match = byBook(run(), "b-probable");
    expect(match.category).toBe("probable");
    expect(match.confidence).toBe("high");
    // ⭐ The delta is FLAGGED, not absorbed. The tolerance decides only
    // whether these are the same invoice; it never decides that a
    // difference does not matter.
    expect(match.taxableDeltaMinor).toBe(50n);
    const taxable = match.differences.find((d) => d.field === "taxable value");
    expect(taxable?.deltaMinor).toBe("50");
  });

  it("⚠️ PROBABLE also covers a LARGE difference — at low confidence, never dropped", async () => {
    // Refusing to pair them would report ONE invoice as both an unfiled
    // supplier and an unrecorded purchase: two exceptions in opposite
    // directions, which net out and hide the actual problem.
    const matches = reconcileGstr2b({
      bookInvoices: [
        book("b", S1, "SC/9", "2024-07-01", 10_000_000n,
          { cgst: 900_000n, sgst: 900_000n }, 1_800_000n, "Sahyadri"),
      ],
      twoBRows: [
        twoB("r", S1, "SC/9", "2024-07-01", 6_000_000n,
          { cgst: 540_000n, sgst: 540_000n }),
      ],
    });

    expect(matches).toHaveLength(1);
    expect(matches[0]!.category).toBe("probable");
    expect(matches[0]!.confidence).toBe("low");
    expect(matches[0]!.taxDeltaMinor).toBe(-720_000n);
    expect(matches[0]!.autoAcceptable).toBe(false);
    // ⭐ The supplier declared LESS than we recorded, so the shortfall
    // caps what we may claim — that, and not the whole invoice, is at
    // risk.
    expect(matches[0]!.itcAtRiskMinor).toBe(720_000n);
  });

  it("⭐ NUMBER MISMATCH — INV-001 against INV/001, and the supplier's number is kept", async () => {
    const match = byBook(run(), "b-number");
    expect(match.category).toBe("number_mismatch");
    expect(match.twoBRowId).toBe("r-number");
    expect(match.autoAcceptable).toBe(false);

    // ⭐ NEITHER NUMBER IS REWRITTEN. Theirs is what the portal holds and
    // what any notice will quote; ours is what is printed on the paper in
    // our file. Both are evidence.
    const numbers = match.matchedOn.find((c) => c.field === "invoice number");
    expect(numbers?.twoB).toBe("INV-001");
    expect(numbers?.books).toBe("INV/001");
    expect(match.explanation).toContain("do not overwrite");
  });

  it("⚠️ NUMBER MISMATCH requires the date and value to agree as well", async () => {
    // Normalisation collides (`A-1-2` and `A-12`), so an agreement there
    // is a candidate and never a conclusion. Same normalised number, same
    // supplier, DIFFERENT date and value → must NOT be paired.
    const matches = reconcileGstr2b({
      bookInvoices: [
        book("b", S1, "A-1-2", "2024-07-01", 10_000_000n, { igst: 1_800_000n },
          1_800_000n, "Sahyadri"),
      ],
      twoBRows: [twoB("r", S1, "A-12", "2024-07-19", 2_500_000n, { igst: 450_000n })],
    });

    expect(categoriesOf(matches)).toEqual({
      in_books_not_in_2b: 1,
      in_2b_not_in_books: 1,
    });
  });

  it("⭐ genuinely different numbers are NOT matched, even with the same date and value", async () => {
    const matches = run();
    expect(byBook(matches, "b-diffnumber").category).toBe("in_books_not_in_2b");
    expect(byRow(matches, "r-diffnumber").category).toBe("in_2b_not_in_books");
  });

  it("⭐ IN BOOKS, NOT IN 2B — the expensive one, ranked first with the credit at risk", async () => {
    const matches = run();
    const match = byBook(matches, "b-missing");
    expect(match.category).toBe("in_books_not_in_2b");
    expect(match.twoBRowId).toBeNull();
    expect(match.itcAtRiskMinor).toBe(7_200_000n);
    expect(match.explanation).toContain("16(2)(aa)");

    // ⚠️ The worklist is read top-down and abandoned part-way, so what is
    // at the top has to be what costs most to ignore.
    expect(matches[0]!.bookInvoiceId).toBe("b-missing");
  });

  it("⭐ ITC at risk is the ELIGIBLE credit, never the gross tax", async () => {
    // Cement into the head office we are building for ourselves. Section
    // 17(5)(d) blocked the credit, so it was never claimable — a supplier
    // who failed to file it has cost us nothing. Reporting the gross
    // would put the biggest numbers on the chase list against the vendors
    // it is pointless to chase.
    const match = byBook(run(), "b-blocked");
    expect(match.category).toBe("in_books_not_in_2b");
    expect(match.itcAtRiskMinor).toBe(0n);
  });

  it("IN 2B, NOT IN BOOKS — a supplier filed something we never recorded", async () => {
    const match = byRow(run(), "r-extra");
    expect(match.category).toBe("in_2b_not_in_books");
    expect(match.bookInvoiceId).toBeNull();
    // ⚠️ It is either a bill that never reached us or an invoice raised
    // against our GSTIN by somebody we do not deal with, and the two look
    // identical from here.
    expect(match.explanation).toContain("do not deal with");
  });

  it("⭐ AMENDED — tied to the books by the ORIGINAL number, and it supersedes", async () => {
    const match = byBook(run(), "b-amended");
    expect(match.category).toBe("amended");
    expect(match.twoBRowId).toBe("r-amended");
    expect(match.explanation).toContain("SUPERSEDE");
    expect(match.autoAcceptable).toBe(false);
    // The amended figures are higher; the difference is what has to be
    // adjusted in this period.
    expect(match.taxDeltaMinor).toBe(18_000n);
  });

  it("⭐ CANCELLED — the supplier withdrew it, and the credit must come back out", async () => {
    const match = byBook(run(), "b-cancelled");
    expect(match.category).toBe("cancelled");
    expect(match.itcAtRiskMinor).toBe(540_000n);
    expect(match.explanation).toContain("CANCELLED");
  });

  it("⚠️ an IGST/CGST+SGST swap is NOT an exact match, even when the total agrees", async () => {
    // The supplier got the place of supply wrong. The four heads sum to
    // the same figure and the credit lands in a different ledger
    // entirely — a comparison on the total alone would auto-accept it.
    const matches = reconcileGstr2b({
      bookInvoices: [
        book("b", S1, "PS/1", "2024-07-01", 10_000_000n,
          { cgst: 900_000n, sgst: 900_000n }, 1_800_000n, "Sahyadri"),
      ],
      twoBRows: [twoB("r", S1, "PS/1", "2024-07-01", 10_000_000n, { igst: 1_800_000n })],
    });

    expect(matches[0]!.category).toBe("probable");
    expect(matches[0]!.autoAcceptable).toBe(false);
    expect(matches[0]!.taxDeltaMinor).toBe(0n);
    const igst = matches[0]!.differences.find((d) => d.field === "IGST");
    expect(igst?.deltaMinor).toBe("1800000");
  });

  it("⭐ is DETERMINISTIC — input order cannot change the answer", async () => {
    // The real threat is not randomness, it is a `SELECT` without an
    // `ORDER BY`. The engine sorts both sides itself rather than trusting
    // its caller, so a shuffled input gives byte-identical output.
    const forward = run();
    const shuffled = reconcileGstr2b({
      twoBRows: [...TWO_B].reverse(),
      bookInvoices: [...BOOKS].reverse(),
    });

    expect(shuffled.map((m) => `${m.category}|${m.twoBRowId}|${m.bookInvoiceId}`)).toEqual(
      forward.map((m) => `${m.category}|${m.twoBRowId}|${m.bookInvoiceId}`),
    );
  });

  it("⭐ every match records WHY it matched, what differed, and which engine said so", async () => {
    for (const match of run()) {
      // Eight fields compared on every match, one-sided or not — that is
      // the answer to "on what basis did you treat these as one document".
      expect(match.matchedOn.map((c) => c.field)).toEqual([
        "supplier GSTIN",
        "invoice number",
        "invoice date",
        "taxable value",
        "CGST",
        "SGST/UTGST",
        "IGST",
        "cess",
      ]);
      expect(match.explanation.length).toBeGreaterThan(40);
      expect(match.engineVersion).toBe(MATCH_ENGINE_VERSION);
    }
  });

  it("⚠️ an ambiguous choice is RECORDED rather than hidden", async () => {
    // Two invoices from one supplier, one day, one amount, numbers that
    // normalise the same. A machine that silently picks one has made a
    // decision it cannot defend.
    const matches = reconcileGstr2b({
      bookInvoices: [
        book("b1", S1, "D/1", "2024-07-01", 1_000_000n, { igst: 180_000n },
          180_000n, "Sahyadri"),
        book("b2", S1, "D/1", "2024-07-01", 1_000_000n, { igst: 180_000n },
          180_000n, "Sahyadri"),
      ],
      twoBRows: [twoB("r1", S1, "D/1", "2024-07-01", 1_000_000n, { igst: 180_000n })],
    });

    const paired = matches.find((m) => m.twoBRowId === "r1")!;
    expect(paired.ambiguousCandidates).toBe(2);
    // And the loser is still accounted for, on the books side.
    expect(categoriesOf(matches)).toEqual({ exact: 1, in_books_not_in_2b: 1 });
  });

  it("a strict tolerance downgrades a round-off match without dropping it", async () => {
    // ⚠️ THE TOLERANCE NEVER CHANGES WHICH DOCUMENTS ARE PAIRED, only how
    // much the engine believes the pairing. Under the default band this
    // is `high`; with no band at all the 50-paise taxable difference is a
    // real difference and it falls to `medium`. It is still the same
    // invoice, and it is still not auto-acceptable either way.
    const relaxed = run().find((m) => m.bookInvoiceId === "b-probable")!;
    expect(relaxed.confidence).toBe("high");

    const strict = reconcileGstr2b({
      twoBRows: TWO_B,
      bookInvoices: BOOKS,
      tolerance: STRICT_MATCH_TOLERANCE,
    });
    const match = strict.find((m) => m.bookInvoiceId === "b-probable")!;
    expect(match.category).toBe("probable");
    expect(match.confidence).toBe("medium");
    expect(match.autoAcceptable).toBe(false);
    // ⭐ Section 170 of the CGST Act permits rounding to the nearest
    // RUPEE, so a ₹1 difference between two correct records of one
    // invoice is not merely possible but statutory.
    expect(DEFAULT_MATCH_TOLERANCE.taxableValueMinor).toBe(100n);
  });
});

/* ================================================================== */
/* 4. ⭐⭐ THE SUMMARY MUST RECONCILE EXACTLY                          */
/* ================================================================== */

describe("⭐⭐ the reconciliation summary", () => {
  it("reconciles EXACTLY: books = matched + unmatched, 2B = matched + missing in books", async () => {
    const matches = run();
    const summary = summariseReconciliation({
      taxPeriod: "2024-07",
      matches,
      bookInvoices: BOOKS,
      twoBRows: TWO_B,
      itcClaimedMinor: 3_780_000n,
    });

    // ⚠️ Recomputed from the fixture, never hard-coded — a hard-coded
    // total would let a change to the fixture make this pass by accident.
    const booksTax = BOOKS.reduce(
      (sum, b) => sum + b.cgstMinor + b.sgstMinor + b.igstMinor + b.cessMinor,
      0n,
    );
    const twoBTax = TWO_B.reduce(
      (sum, r) => sum + r.cgstMinor + r.sgstMinor + r.igstMinor + r.cessMinor,
      0n,
    );

    expect(summary.books.totalTaxMinor).toBe(booksTax);
    expect(summary.twoB.totalTaxMinor).toBe(twoBTax);

    // ⭐⭐ THE TWO IDENTITIES.
    expect(summary.matched.booksTaxMinor + summary.inBooksNotIn2B.totalTaxMinor).toBe(
      booksTax,
    );
    expect(summary.matched.twoBTaxMinor + summary.in2BNotInBooks.totalTaxMinor).toBe(
      twoBTax,
    );

    expect(summary.identityFailures).toEqual([]);
    expect(summary.reconciles).toBe(true);
  });

  it("⭐ every document lands in EXACTLY ONE bucket", async () => {
    const matches = run();
    const bookIds = matches.filter((m) => m.bookInvoiceId).map((m) => m.bookInvoiceId);
    const rowIds = matches.filter((m) => m.twoBRowId).map((m) => m.twoBRowId);

    expect(new Set(bookIds).size).toBe(bookIds.length);
    expect(new Set(rowIds).size).toBe(rowIds.length);
    expect(bookIds.sort()).toEqual(BOOKS.map((b) => b.id).sort());
    expect(rowIds.sort()).toEqual(TWO_B.map((r) => r.id).sort());
  });

  it("⭐⭐ a DROPPED invoice is detected — the failure that reads as good news", async () => {
    // An invoice missing from the buckets makes "in books, not in 2B"
    // smaller than it should be: fewer suppliers to chase, more credit
    // available. Every row on every screen is still correct.
    const matches = run().filter((m) => m.bookInvoiceId !== "b-missing");
    const summary = summariseReconciliation({
      taxPeriod: "2024-07",
      matches,
      bookInvoices: BOOKS,
      twoBRows: TWO_B,
    });

    expect(summary.reconciles).toBe(false);
    expect(summary.identityFailures.join(" ")).toContain("TC/88");
    expect(summary.identityFailures.join(" ")).toContain("16(2)(aa)");
  });

  it("⚠️ an invoice counted TWICE is detected too", async () => {
    const matches = run();
    const duplicated = [...matches, matches.find((m) => m.bookInvoiceId === "b-exact")!];
    const summary = summariseReconciliation({
      taxPeriod: "2024-07",
      matches: duplicated,
      bookInvoices: BOOKS,
      twoBRows: TWO_B,
    });

    expect(summary.reconciles).toBe(false);
    expect(summary.identityFailures.join(" ")).toContain("2 matches");
  });

  it("⭐ the three columns: as per books, as per 2B, and claimed", async () => {
    const summary = summariseReconciliation({
      taxPeriod: "2024-07",
      matches: run(),
      bookInvoices: BOOKS,
      twoBRows: TWO_B,
      itcClaimedMinor: 4_000_000n,
    });

    const eligible = BOOKS.reduce((sum, b) => sum + b.itcEligibleTaxMinor, 0n);
    expect(summary.itcAsPerBooksMinor).toBe(eligible);

    // ⭐ The Section 16(2)(aa) ceiling: every 2B row the portal marks
    // available.
    const available = TWO_B.reduce(
      (sum, r) => sum + r.cgstMinor + r.sgstMinor + r.igstMinor + r.cessMinor,
      0n,
    );
    expect(summary.itcAsPerTwoBMinor).toBe(available);

    expect(summary.booksVsTwoBMinor).toBe(eligible - available);
    expect(summary.claimedVsTwoBMinor).toBe(4_000_000n - available);
    expect(summary.claimedVsBooksMinor).toBe(4_000_000n - eligible);
  });

  it("⚠️ a 2B row the portal marks ITC-UNAVAILABLE is not part of the ceiling", async () => {
    // The supplier filed after the Section 16(4) deadline, or the place
    // of supply puts the credit in another state. Summing every row would
    // overstate the ceiling by exactly the amount hardest to notice.
    const rows: TwoBRowFacts[] = [
      twoB("r-ok", S1, "A/1", "2024-07-01", 1_000_000n, { igst: 180_000n }),
      twoB("r-no", S1, "A/2", "2024-07-02", 1_000_000n, { igst: 180_000n }, {
        itcAvailable: "not_available",
      }),
    ];
    const summary = summariseReconciliation({
      taxPeriod: "2024-07",
      matches: reconcileGstr2b({ twoBRows: rows, bookInvoices: [] }),
      bookInvoices: [],
      twoBRows: rows,
    });

    expect(summary.twoB.totalTaxMinor).toBe(360_000n);
    expect(summary.itcAsPerTwoBMinor).toBe(180_000n);
    expect(summary.reconciles).toBe(true);
  });
});

/* ================================================================== */
/* 5. ⭐ VENDOR CHASE                                                  */
/* ================================================================== */

describe("⭐ vendor chase", () => {
  it("lists only suppliers who have NOT filed, ranked by what is at stake", async () => {
    const rows = chaseVendors({
      matches: run(),
      bookInvoices: BOOKS,
      asOf: "2024-09-30",
    });

    // ⚠️ `in_2b_not_in_books` is a supplier who DID file — there is
    // nothing to chase them for, and including them would inflate the
    // headline by invoices already in 2B.
    expect(rows.map((r) => r.supplierGstin)).toEqual([S3, S5, S6, S8]);
    expect(rows[0]!.itcAtRiskMinor).toBe(7_200_000n);
    expect(totalItcAtRisk(rows)).toBe(7_200_000n + 540_000n + 270_000n + 0n);
  });

  it("⭐ ages from the INVOICE date and names the Section 16(4) deadline", async () => {
    const rows = chaseVendors({
      matches: run(),
      bookInvoices: BOOKS,
      asOf: "2024-09-30",
    });
    const worst = rows[0]!;
    // 12 July to 30 September.
    expect(worst.oldestAgeDays).toBe(80);
    const invoice = worst.invoices[0]!;
    // FY 2024-25 → 30 November 2025.
    expect(invoice.claimDeadlinePeriod).toBe("2025-11");
    expect(invoice.deadlinePassed).toBe(false);
  });

  it("⭐ credit past its Section 16(4) cliff is reported as LOST, not merely old", async () => {
    const rows = chaseVendors({
      matches: run(),
      bookInvoices: BOOKS,
      asOf: "2026-01-15",
    });
    const worst = rows[0]!;
    expect(worst.itcLostMinor).toBe(7_200_000n);
  });
});

/* ================================================================== */
/* 6. ⭐ PARSING — PORTAL JSON AND THE EXCEL/CSV EXPORT                */
/* ================================================================== */

const PORTAL_JSON = {
  chksum: "0e6b04e1e2b0",
  data: {
    gstin: GSTIN_A,
    rtnprd: "072024",
    version: "2.0",
    gendt: "14-08-2024",
    docdata: {
      b2b: [
        {
          ctin: S1,
          trdnm: "Sahyadri Cement Pvt Ltd",
          supprd: "072024",
          supfildt: "11-08-2024",
          inv: [
            {
              inum: "SC/2024/117",
              typ: "R",
              dt: "05-07-2024",
              val: 118000.0,
              pos: "27",
              rev: "N",
              itcavl: "Y",
              items: [
                { num: 1, rt: 18, txval: 100000.0, cgst: 9000.0, sgst: 9000.0, cess: 0 },
              ],
            },
          ],
        },
      ],
      b2ba: [
        {
          ctin: S4,
          trdnm: "Anand Architects",
          supprd: "082024",
          inv: [
            {
              oinum: "AR/9",
              oidt: "15-07-2024",
              inum: "AR/9-R1",
              dt: "15-07-2024",
              val: 12980.0,
              itcavl: "Y",
              items: [{ rt: 18, txval: 11000.0, cgst: 990.0, sgst: 990.0 }],
            },
          ],
        },
      ],
      cdnr: [
        {
          ctin: S5,
          trdnm: "Xylem Fittings",
          nt: [
            {
              ntnum: "CN/4",
              nttyp: "C",
              dt: "28-07-2024",
              val: 5900.0,
              itcavl: "Y",
              items: [{ rt: 18, txval: 5000.0, igst: 900.0 }],
            },
          ],
        },
      ],
      impg: [
        {
          boenum: "7654321",
          boedt: "20-07-2024",
          portcode: "INNSA1",
          refdt: "20-07-2024",
          txval: 250000.0,
          igst: 45000.0,
          cess: 0,
          isamd: "N",
        },
      ],
    },
  },
};

describe("⭐ parsing the portal's GSTR-2B JSON", () => {
  it("reads the statement, every section, and converts rupees to paise exactly", async () => {
    const result = parseGstr2bJson(PORTAL_JSON);

    expect(result.ok).toBe(true);
    expect(result.statement).toEqual({
      gstin: GSTIN_A,
      returnPeriod: "2024-07",
      generatedOn: "2024-08-14",
      version: "2.0",
    });

    expect(result.rows.map((r) => r.section)).toEqual(["b2b", "b2ba", "cdnr", "impg"]);

    const b2b = result.rows[0]!;
    expect(b2b.invoiceNumber).toBe("SC/2024/117");
    expect(b2b.normalisedNumber).toBe("SC2024117");
    expect(b2b.invoiceDate).toBe("2024-07-05");
    expect(b2b.taxableValueMinor).toBe(10_000_000n);
    expect(b2b.cgstMinor).toBe(900_000n);
    expect(b2b.documentValueMinor).toBe(11_800_000n);
    expect(b2b.supplierFilingPeriod).toBe("2024-07");
    expect(b2b.supplierFilingDate).toBe("2024-08-11");

    // ⭐ An amendment names what it supersedes.
    const amendment = result.rows[1]!;
    expect(amendment.isAmendment).toBe(true);
    expect(amendment.originalInvoiceNumber).toBe("AR/9");

    // ⚠️ A bill of entry has NO supplier GSTIN — the counterparty is
    // Customs — and every match rule keyed on one is inapplicable.
    const boe = result.rows[3]!;
    expect(boe.supplierGstin).toBeNull();
    expect(boe.igstMinor).toBe(4_500_000n);
  });

  it("⭐ money never goes through a float", async () => {
    // `8.145 * 100` is 814.4999999999999 in IEEE-754 and rounds DOWN to
    // 814. One paisa lost makes an invoice fail an EXACT match and sit in
    // a worklist forever; a paisa lost on a thousand invoices makes the
    // period disagree with the portal by a figure nobody can locate.
    expect(rupeesToPaise(8.145)).toBe(815n);
    expect(rupeesToPaise(1145.75)).toBe(114_575n);
    expect(rupeesToPaise("1,00,000.00")).toBe(10_000_000n);
    expect(rupeesToPaise("₹ 4,72,000.50")).toBe(47_200_050n);
    expect(rupeesToPaise(0)).toBe(0n);
    expect(rupeesToPaise("abc")).toBeNull();
    expect(rupeesToPaise(null)).toBeNull();
    // ⚠️ Exponential notation is refused rather than expanded: it is not
    // a rupee figure on a tax document, it is a mis-mapped column.
    expect(rupeesToPaise(1e22)).toBeNull();
  });

  it("reads the portal's date and period formats, and refuses impossible ones", async () => {
    expect(portalDateToCivilDay("05-07-2024")).toBe("2024-07-05");
    expect(portalDateToCivilDay("2024-07-05")).toBe("2024-07-05");
    // ⚠️ 25 cannot be a month, so the ambiguity resolves itself whatever
    // the caller declared.
    expect(portalDateToCivilDay("25-07-2024", "month-first")).toBe("2024-07-25");
    expect(portalDateToCivilDay("31-02-2024")).toBeNull();
    expect(portalDateToCivilDay("")).toBeNull();
    // ⚠️ MMYYYY, not YYYYMM. Read the other way "072024" becomes the year 720.
    expect(portalPeriodToTaxPeriod("072024")).toBe("2024-07");
    expect(portalPeriodToTaxPeriod("132024")).toBeNull();
  });

  it("⭐⭐ MALFORMED JSON IS REJECTED WHOLE — a partial parse is worse than none", async () => {
    // A row absent from the parsed statement is indistinguishable from a
    // supplier who did not file: the invoice would be reported as "in
    // books, not in 2B", a blameless supplier chased, and the credit
    // deferred out of a period it was entitled to with the Section 16(4)
    // clock running.
    const broken = JSON.parse(JSON.stringify(PORTAL_JSON)) as typeof PORTAL_JSON;
    // @ts-expect-error — deliberately corrupting one invoice's date.
    broken.data.docdata.b2b[0].inv[0].dt = "not-a-date";

    const result = parseGstr2bJson(broken);
    expect(result.ok).toBe(false);
    expect(result.rows).toHaveLength(0);
    expect(result.issues.some((i) => i.severity === "error")).toBe(true);
    expect(result.issues[0]!.path).toContain("b2b[0].inv[0]");
  });

  it("rejects a document that is not a GSTR-2B at all, without throwing", async () => {
    // ⚠️ NOTHING IN THE PARSER THROWS. If it did, the natural calling
    // shape would be a try/catch around the whole import and the natural
    // response a rollback — which would delete the raw file.
    for (const input of [null, 42, "a string", [], {}, { data: {} }]) {
      const result = parseGstr2bJson(input);
      expect(result.ok).toBe(false);
      expect(result.issues.length).toBeGreaterThan(0);
    }
  });

  it("⭐ an amendment with no original document is refused", async () => {
    const broken = JSON.parse(JSON.stringify(PORTAL_JSON)) as typeof PORTAL_JSON;
    // @ts-expect-error — deliberately removing the original number.
    delete broken.data.docdata.b2ba[0].inv[0].oinum;

    const result = parseGstr2bJson(broken);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.message.includes("counted twice"))).toBe(true);
  });
});

describe("⭐ parsing the Excel/CSV export accountants actually have", () => {
  const CSV = [
    "GSTR-2B for 27AAACR5055K1Z7,,,,,,,,,,,",
    "",
    'GSTIN of supplier,Trade/Legal name,Invoice number,Invoice type,Invoice Date,Invoice Value(₹),Place of supply,Supply Attract Reverse Charge,Rate(%),Taxable Value (₹),Integrated Tax(₹),Central Tax(₹),State/UT Tax(₹),Cess(₹),GSTR-1/IFF/GSTR-5 Period,GSTR-1/IFF/GSTR-5 Filing Date,ITC Availability,Reason',
    `${S1},"Sahyadri Cement, Pvt Ltd",SC/2024/117,R,05-07-2024,"1,18,000.00",27,N,18,"1,00,000.00",0.00,"9,000.00","9,000.00",0.00,072024,11-08-2024,Yes,`,
    `${S2},Nashik Hardware,INV-001,R,10-07-2024,"23,600.00",27,N,18,"12,000.00",0.00,"1,080.00","1,080.00",0.00,072024,11-08-2024,Yes,`,
    `${S2},Nashik Hardware,INV-001,R,10-07-2024,"23,600.00",27,N,12,"8,000.00",0.00,"480.00","480.00",0.00,072024,11-08-2024,Yes,`,
    "",
  ].join("\n");

  it("⭐ groups the portal's ONE ROW PER RATE back into one document", async () => {
    const result = parseGstr2bDelimited(CSV, {
      gstin: GSTIN_A,
      returnPeriod: "2024-07",
    });

    expect(result.ok).toBe(true);
    expect(result.rows).toHaveLength(2);

    const hardware = result.rows[1]!;
    // ⭐ Taxable value and tax are SUMMED across the two rate lines…
    expect(hardware.taxableValueMinor).toBe(2_000_000n);
    expect(hardware.cgstMinor).toBe(156_000n);
    expect(hardware.rateBreakup).toHaveLength(2);
    // …and the INVOICE VALUE is taken once. Summing it would double the
    // document value and make an ordinary invoice fail every comparison.
    expect(hardware.documentValueMinor).toBe(2_360_000n);
  });

  it("⚠️ a comma inside a quoted supplier name does not shift the columns", async () => {
    // `line.split(",")` shifts every column after it on THAT ROW ONLY, so
    // the tax lands in the place-of-supply column, the import "succeeds",
    // and one invoice in a thousand is silently wrong.
    const result = parseGstr2bDelimited(CSV, {
      gstin: GSTIN_A,
      returnPeriod: "2024-07",
    });
    expect(result.rows[0]!.supplierTradeName).toBe("Sahyadri Cement, Pvt Ltd");
    expect(result.rows[0]!.cgstMinor).toBe(900_000n);
    expect(result.rows[0]!.placeOfSupplyCode).toBe("27");
  });

  it("finds the header even below a title band, and sniffs a semicolon delimiter", async () => {
    const semi = CSV.replace(/,/g, ";").replace(/"Sahyadri Cement; Pvt Ltd"/, '"Sahyadri Cement, Pvt Ltd"');
    const result = parseGstr2bDelimited(semi, {
      gstin: GSTIN_A,
      returnPeriod: "2024-07",
      delimiter: ";",
    });
    expect(result.ok).toBe(true);
    expect(result.rows.length).toBeGreaterThan(0);

    const table = parseDelimitedText('a,b\n"x,y",z\n');
    expect(table).toEqual([
      ["a", "b"],
      ["x,y", "z"],
    ]);
  });

  it("⚠️ refuses a delimited file that does not say which GSTIN and period it is for", async () => {
    // A statement imported against the wrong registration sets credit in
    // a state with nothing to set it against.
    const result = parseGstr2bDelimited(CSV);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.message.includes("wrong registration"))).toBe(true);
  });

  it("refuses a row with no supplier GSTIN outside an import of goods", async () => {
    const bad = CSV.replace(`${S2},Nashik Hardware,INV-001,R,10-07-2024`, `,Nashik Hardware,INV-001,R,10-07-2024`);
    const result = parseGstr2bDelimited(bad, {
      gstin: GSTIN_A,
      returnPeriod: "2024-07",
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.message.includes("bill of entry"))).toBe(true);
  });
});

/* ================================================================== */
/* 7. ⭐⭐ THE FREEZE, AND THE EVIDENCE                                */
/* ================================================================== */

describe("⭐⭐ a filed period freezes", () => {
  it("REFUSES a re-import of a filed period", async () => {
    // The portal REGENERATES 2B whenever a supplier files late, so
    // re-importing July in November is ordinary work — and it must not
    // rewrite the working paper for a GSTR-3B the Government holds a copy
    // of. The credit the late filing unlocks belongs to November.
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(
          `INSERT INTO gstr2b_documents
             (tenant_id, gstin, return_period, source_format, file_hash, raw_document)
           VALUES ($1,$2,'2024-06','portal_json',$3,'{"data":{"gstin":"x"}}'::jsonb)`,
          [tenantA, GSTIN_A, HASH("9")],
        ),
      ),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("42501");
    expect(error!.message).toContain("already been reconciled and FILED");
    // ⭐ The message says what to do instead — the person hitting it is
    // doing something reasonable and needs redirecting, not blocking.
    expect(error!.message).toContain("period you are filing now");
  });

  it("but the NEXT period imports normally", async () => {
    // A freeze that also blocked the next period would stop the product
    // working in the one week of the month it is used, and somebody would
    // delete the reconciliation to get past it.
    await asTenant(tenantA, async (c) => {
      const { rowCount } = await c.query(
        `INSERT INTO gstr2b_documents
           (tenant_id, gstin, return_period, source_format, file_hash, raw_document)
         VALUES ($1,$2,'2024-08','portal_json',$3,'{"data":{"gstin":"x"}}'::jsonb)`,
        [tenantA, GSTIN_A, HASH("8")],
      );
      expect(rowCount).toBe(1);
    });

    // ⚠️ AND IT CANNOT BE TIDIED AWAY AFTERWARDS EITHER — the app role
    // holds no DELETE on `gstr2b_documents`. The row stays until the
    // superuser teardown removes it, which is exactly what the grant is
    // there to produce: an imported statement is evidence, and evidence
    // is not something the application gets to reconsider.
    const cleanup = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(
          `DELETE FROM gstr2b_documents WHERE tenant_id = $1 AND return_period = '2024-08'`,
          [tenantA],
        ),
      ),
    );
    expect(cleanup).not.toBeNull();
    expect(cleanup!.code).toBe("42501");
  });

  it("REFUSES a restatement of a filed reconciliation's totals", async () => {
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(
          `UPDATE gstr2b_reconciliations
              SET books_tax_minor = 500000, in_books_not_in_2b_tax_minor = 500000
            WHERE id = $1`,
          [reconJuneA],
        ),
      ),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("42501");
    expect(error!.message).toContain("cannot be unfiled");
  });

  it("⚠️ but a NOTE may still be added — a fact about the past is not a change to it", async () => {
    await asTenant(tenantA, async (c) => {
      const { rowCount } = await c.query(
        `UPDATE gstr2b_reconciliations
            SET notes = 'Supplier confirmed they filed on 14 Dec; credit taken in December.'
          WHERE id = $1`,
        [reconJuneA],
      );
      expect(rowCount).toBe(1);
    });
  });

  it("REFUSES a new match under a filed reconciliation", async () => {
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(
          `INSERT INTO gstr2b_matches
             (tenant_id, reconciliation_id, purchase_invoice_id, match_category,
              confidence, match_score, explanation)
           VALUES ($1,$2,$3,'in_books_not_in_2b','none',0,'late arrival')`,
          [tenantA, reconJuneA, invMissingA],
        ),
      ),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("42501");
    expect(error!.message).toContain("evidence for every credit taken");
  });

  it("a period that is NOT filed reconciles and re-runs freely", async () => {
    await asTenant(tenantA, async (c) => {
      const { rowCount } = await c.query(
        `UPDATE gstr2b_matches SET action = 'deferred',
                action_reason = 'Supplier says they will file with August GSTR-1.',
                action_by = $2, action_at = now()
          WHERE reconciliation_id = $1 AND match_category = 'in_books_not_in_2b'`,
        [reconJulyA, userA],
      );
      expect(rowCount).toBe(1);
    });
  });
});

describe("⭐⭐ the raw statement is the evidence", () => {
  it("cannot be overwritten, even by the tenant that imported it", async () => {
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(`UPDATE gstr2b_documents SET raw_document = '{}'::jsonb WHERE id = $1`, [
          docJulyA,
        ]),
      ),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("42501");
    expect(error!.message).toContain("cannot be changed");
  });

  it("its identity — hash, GSTIN, period, format — cannot be changed either", async () => {
    for (const [column, value] of [
      ["file_hash", HASH("0")],
      ["gstin", GSTIN_B],
      ["return_period", "2024-05"],
    ] as const) {
      const error = await expectError(() =>
        asTenant(tenantA, async (c) =>
          c.query(`UPDATE gstr2b_documents SET ${column} = $2 WHERE id = $1`, [
            docJulyA,
            value,
          ]),
        ),
      );
      expect(error, column).not.toBeNull();
      expect(error!.code, column).toBe("42501");
    }
  });

  it("⭐⭐ a MALFORMED statement is recorded as failed and the raw survives intact", async () => {
    // The whole two-transaction design of the import exists for this: a
    // parse bug is discovered by definition AFTER the parse, often a year
    // later at a notice, and by then the portal may no longer serve that
    // month.
    await asTenant(tenantA, async (c) => {
      const inserted = await c.query(
        `INSERT INTO gstr2b_documents
           (tenant_id, gstin, return_period, source_format, file_hash, raw_document)
         VALUES ($1,$2,'2024-05','portal_json',$3,
                 '{"data":{"gstin":"27AAACR5055K1Z7","rtnprd":"052024","docdata":{"b2b":[{"ctin":"27AABCS1429B1ZU","inv":[{"inum":"X/1","dt":"not-a-date"}]}]}}}'::jsonb)
         RETURNING id`,
        [tenantA, GSTIN_A, HASH("5")],
      );
      const id = inserted.rows[0].id as string;

      // The ordinary failed-parse path. MUST succeed — if it did not, the
      // caller would roll back and the file would be gone.
      const marked = await c.query(
        `UPDATE gstr2b_documents
            SET parse_status = 'failed',
                parse_error = 'data.docdata.b2b[0].inv[0]: the document has no readable date',
                parse_issues = '[{"path":"data.docdata.b2b[0].inv[0]","message":"no readable date","severity":"error"}]'::jsonb,
                row_count = 0
          WHERE id = $1`,
        [id],
      );
      expect(marked.rowCount).toBe(1);

      const { rows } = await c.query(
        `SELECT parse_status, parse_error,
                raw_document #>> '{data,docdata,b2b,0,inv,0,inum}' AS invoice_number,
                jsonb_array_length(parse_issues) AS issue_count
           FROM gstr2b_documents WHERE id = $1`,
        [id],
      );

      expect(rows[0].parse_status).toBe("failed");
      expect(rows[0].parse_error).toContain("no readable date");
      // ⭐ THE FILE IS STILL THERE, IN FULL, INCLUDING THE ROW THAT
      // BROKE THE PARSER.
      expect(rows[0].invoice_number).toBe("X/1");
      expect(rows[0].issue_count).toBe(1);

      // And the parser itself agrees: rejected whole, nothing thrown.
      const parsed = parseGstr2bJson({
        data: {
          gstin: GSTIN_A,
          rtnprd: "052024",
          docdata: { b2b: [{ ctin: S1, inv: [{ inum: "X/1", dt: "not-a-date" }] }] },
        },
      });
      expect(parsed.ok).toBe(false);
      expect(parsed.rows).toHaveLength(0);

      await c.query(`DELETE FROM gstr2b_rows WHERE document_id = $1`, [id]);
    });
  });

  it("the application role may NOT delete a statement or a reconciliation", async () => {
    // A deleted purchase invoice can be re-entered from the paper in the
    // file. A deleted 2B statement can only be re-downloaded from a
    // portal that will never serve the same GENERATION of it again.
    for (const table of ["gstr2b_documents", "gstr2b_reconciliations"]) {
      const error = await expectError(() =>
        asTenant(tenantA, async (c) => c.query(`DELETE FROM ${table}`)),
      );
      expect(error, table).not.toBeNull();
      expect(error!.code, table).toBe("42501");
    }
  });
});

/* ================================================================== */
/* 8. ⭐⭐ NOTHING BELOW EXACT IS ACCEPTED WITHOUT A HUMAN             */
/* ================================================================== */

describe("⭐⭐ no silent auto-accept", () => {
  it("REFUSES an accepted match below EXACT with nobody named against it", async () => {
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(
          `UPDATE gstr2b_matches
              SET action = 'accepted', action_at = now(), action_by = NULL
            WHERE reconciliation_id = $1 AND match_category = 'in_books_not_in_2b'`,
          [reconJulyA],
        ),
      ),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23514");
    expect(error!.message).toContain("gstr2b_matches_no_silent_auto_accept");
  });

  it("a PERSON may accept the same match", async () => {
    await asTenant(tenantA, async (c) => {
      const { rowCount } = await c.query(
        `UPDATE gstr2b_matches
            SET action = 'accepted', action_at = now(), action_by = $2
          WHERE reconciliation_id = $1 AND match_category = 'in_books_not_in_2b'`,
        [reconJulyA, userA],
      );
      expect(rowCount).toBe(1);
    });
  });

  it("REFUSES a rejection or a deferral with no reason", async () => {
    // Three months later "why is this still open" has no answer, and the
    // exception is re-investigated from scratch every month until
    // somebody accepts it to make it go away.
    for (const action of ["rejected", "deferred"]) {
      const error = await expectError(() =>
        asTenant(tenantA, async (c) =>
          c.query(
            `UPDATE gstr2b_matches
                SET action = $2, action_at = now(), action_by = $3, action_reason = NULL
              WHERE id = $1`,
            [matchExactA, action, userA],
          ),
        ),
      );
      expect(error, action).not.toBeNull();
      expect(error!.code, action).toBe("23514");
    }
  });

  it("⭐ the validator refuses a refusal with no reason before it reaches the database", async () => {
    const parsed = decideMatchSchema.safeParse({
      matchId: matchExactA,
      action: "rejected",
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.flatten().fieldErrors.reason?.[0]).toContain(
        "re-investigated from scratch",
      );
    }

    expect(
      decideMatchSchema.safeParse({ matchId: matchExactA, action: "accepted" }).success,
    ).toBe(true);
  });

  it("⭐ one 2B row cannot be matched to two purchase invoices", async () => {
    // A re-run that appended instead of replacing. Both rows look
    // ordinary; the matched total exceeds the books total and a supplier
    // drops off the chase list — which reads as good news.
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(
          `INSERT INTO gstr2b_matches
             (tenant_id, reconciliation_id, gstr2b_row_id, purchase_invoice_id,
              match_category, confidence, match_score, explanation)
           VALUES ($1,$2,$3,$4,'probable','high',90,'Same supplier and number.')`,
          [tenantA, reconJulyA, rowExactA, invMissingA],
        ),
      ),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23505");
  });

  it("⭐ a match may not reach across periods", async () => {
    // Whether the supplier filed IN THIS PERIOD is the entire question
    // Section 16(2)(aa) turns on.
    const error = await expectError(() =>
      asTenant(tenantA, async (c) => {
        const row = await c.query(
          `INSERT INTO gstr2b_rows
             (tenant_id, document_id, section, supplier_gstin, invoice_number,
              normalised_number, invoice_date, taxable_value_minor, igst_minor)
           VALUES ($1,$2,'b2b',$3,'JUN/1','JUN1', DATE '2024-06-10', 100000, 18000)
           RETURNING id`,
          [tenantA, docJuneA, S1],
        );
        await c.query(
          `INSERT INTO gstr2b_matches
             (tenant_id, reconciliation_id, gstr2b_row_id, purchase_invoice_id,
              match_category, confidence, match_score, explanation)
           VALUES ($1,$2,$3,$4,'probable','high',90,'Across periods.')`,
          [tenantA, reconJulyA, row.rows[0].id, invMissingA],
        );
      }),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23514");
    expect(error!.message).toContain("16(2)(aa)");
  });

  it("⭐ an EXACT match with a difference is refused outright", async () => {
    // The label is what a reviewer trusts and the delta is what an
    // officer finds.
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(
          `UPDATE gstr2b_matches SET tax_delta_minor = 100 WHERE id = $1`,
          [matchExactA],
        ),
      ),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23514");
  });
});

/* ================================================================== */
/* 9. THE STORED SUMMARY MUST DESCRIBE ITS OWN MATCHES                 */
/* ================================================================== */

describe("⭐ the stored summary must describe its own matches", () => {
  it("REFUSES totals that do not balance on either side", async () => {
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(
          `INSERT INTO gstr2b_reconciliations
             (tenant_id, gstin, tax_period, books_tax_minor,
              matched_books_tax_minor, in_books_not_in_2b_tax_minor)
           VALUES ($1,$2,'2024-09', 3600000, 1800000, 900000)`,
          [tenantA, GSTIN_A],
        ),
      ),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23514");
    expect(error!.message).toContain("books_reconcile");
  });

  it("⭐ REFUSES stored totals that disagree with the match rows, at COMMIT", async () => {
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(
          `UPDATE gstr2b_reconciliations
              SET books_tax_minor = 12000000,
                  matched_books_tax_minor = 1800000,
                  in_books_not_in_2b_tax_minor = 10200000
            WHERE id = $1`,
          [reconJulyA],
        ),
      ),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23514");
    expect(error!.message).toContain("16(2)(aa)");
  });

  it("the fixture's own reconciliation is consistent, which is why the above are meaningful", async () => {
    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(
        `SELECT books_tax_minor::text AS books,
                matched_books_tax_minor::text AS matched,
                in_books_not_in_2b_tax_minor::text AS unmatched,
                twob_tax_minor::text AS twob,
                matched_twob_tax_minor::text AS matched_twob,
                in_2b_not_in_books_tax_minor::text AS missing
           FROM gstr2b_reconciliations WHERE id = $1`,
        [reconJulyA],
      );
      const r = rows[0];
      expect(BigInt(r.books)).toBe(BigInt(r.matched) + BigInt(r.unmatched));
      expect(BigInt(r.twob)).toBe(BigInt(r.matched_twob) + BigInt(r.missing));
    });
  });
});

/* ================================================================== */
/* 10. VALIDATORS                                                      */
/* ================================================================== */

describe("validators", () => {
  it("⭐ the file crosses the boundary as TEXT, so the hash still describes it", async () => {
    const parsed = importGstr2bSchema.safeParse({
      gstin: GSTIN_A,
      returnPeriod: "2024-07",
      sourceFormat: "portal_json",
      content: JSON.stringify(PORTAL_JSON),
    });
    expect(parsed.success).toBe(true);

    expect(
      importGstr2bSchema.safeParse({
        gstin: GSTIN_A,
        returnPeriod: "2024-07",
        sourceFormat: "portal_json",
        content: "",
      }).success,
    ).toBe(false);
  });

  it("refuses a GSTIN that fails its own checksum and a period that is not YYYY-MM", async () => {
    expect(
      importGstr2bSchema.safeParse({
        gstin: "27AAACR5055K1ZX",
        returnPeriod: "2024-07",
        sourceFormat: "portal_json",
        content: "{}",
      }).success,
    ).toBe(false);

    expect(
      importGstr2bSchema.safeParse({
        gstin: GSTIN_A,
        returnPeriod: "2024-13",
        sourceFormat: "portal_json",
        content: "{}",
      }).success,
    ).toBe(false);
  });

  it("civil-day arithmetic is UTC, not local", async () => {
    // `new Date("2024-07-01").getDate()` is 30 June on any machine west
    // of UTC, which would shift every invoice by a day on a developer's
    // laptop and not on the server.
    expect(civilDaysApart("2024-07-01", "2024-07-31")).toBe(30);
    expect(civilDaysApart("2024-02-28", "2024-03-01")).toBe(2); // leap year
  });
});
