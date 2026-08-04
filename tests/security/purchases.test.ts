/**
 * Ordence — Purchases & ⭐ Input Tax Credit
 * Version: v0.33.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE IS ACTUALLY TRYING TO PROVE
 * ══════════════════════════════════════════════════════════════════════
 * Thirty-two phases say the same thing: the defects that survive are the
 * SILENT ones. Phase 32 had the quietest failure modes in the product so
 * far, because a wrong tax answer is a right-looking DOCUMENT.
 *
 * This phase is worse in a specific way: a wrong answer here is a
 * right-looking RETURN **that puts money in the bank**.
 *
 *   • Cement for a building we are constructing on our own account,
 *     booked the way yesterday's cement was booked. Section 17(5)(d)
 *     blocks the credit; the claim improves this month's cash by 18% of
 *     the bill. The GSTR-3B files cleanly. Nothing errors. It is found at
 *     an audit years later, with interest running from the claim.
 *
 *   • The same contractor's bill entered by the site office and by
 *     accounts. Two entries, neither wrong-looking, one credit claimed
 *     twice and one vendor paid twice.
 *
 *   • A Rule 42 reversal computed as `C3 × (1 − E/F) − D2` instead of
 *     `C3 − D1 − D2`. Identical to the rupee on almost every input, off
 *     by a paisa on some — and the paisa is the difference between the
 *     credit availed and the reversal reported, which an officer
 *     recomputing the working will find and nobody else ever will.
 *
 * So the tests below do not inspect constraints. They put the same
 * cement through both determinations and check the answers differ. They
 * add up a Rule 42 apportionment and demand it equal the input exactly.
 * They ask the database to claim a credit it has already claimed, in a
 * different month.
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
  determineItcEligibility,
  screenBlockedCredit,
  splitItcByVerdict,
  sumHeads,
  type TaxHeads,
} from "@/lib/purchases/itc";
import {
  apportionRule42,
  apportionRule42ByHead,
  apportionRule43,
  bucketRule42,
  RULE_43_USEFUL_LIFE_MONTHS,
} from "@/lib/purchases/apportionment";
import {
  ageVendorLedger,
  assessMsmeExposure,
  closingBalance,
  daysBetween,
  isValidUdyamNumber,
  describeUdyamProblem,
  runningBalance,
  MSME_STATUTORY_MAX_DAYS,
} from "@/lib/purchases/vendor-ledger";
import {
  reconcilePurchaseInvoice,
  summariseItcRegister,
  itcClaimDeadlinePeriod,
  isWithinItcDeadline,
  taxPeriodOf,
} from "@/lib/purchases/register";
import { upsertVendorSchema, recordPurchaseInvoiceSchema } from "@/lib/validators/purchases";

/* ================================================================== */
/* FIXTURES                                                            */
/* ================================================================== */

let tenantA: string;
let tenantB: string;
let userA: string;
let vendorA: string;
let vendorB: string;
let projectA: string;
/** A recorded bill in tenant A, used by the isolation and claim tests. */
let invoiceA: string;
let lineEligibleA: string;
let lineBlockedA: string;

const HEADS_18PCT: TaxHeads = {
  cgstMinor: 900_000n,
  sgstMinor: 900_000n,
  igstMinor: 0n,
  cessMinor: 0n,
};

beforeAll(async () => {
  tenantA = randomUUID();
  tenantB = randomUUID();
  userA = randomUUID();
  vendorA = randomUUID();
  vendorB = randomUUID();
  projectA = randomUUID();
  invoiceA = randomUUID();
  lineEligibleA = randomUUID();
  lineBlockedA = randomUUID();

  await asSuperuser(async (c) => {
    for (const [id, name] of [
      [tenantA, "Purchases Isolation A"],
      [tenantB, "Purchases Isolation B"],
    ] as const) {
      await c.query(
        `INSERT INTO tenants (id, clerk_org_id, slug, name, status)
         VALUES ($1,$2,$3,$4,'active')`,
        [id, `org_${id}`, `pur-${id.slice(0, 8)}`, name],
      );
    }

    await c.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, status)
       VALUES ($1,$2,$3,'pur-a@example.test','tenant_admin','active')`,
      [userA, tenantA, `usr_${userA}`],
    );

    await c.query(
      `INSERT INTO projects (id, tenant_id, code, name, state)
       VALUES ($1,$2,'TWR-B','Tower B','Maharashtra')`,
      [projectA, tenantA],
    );

    await c.query(
      `INSERT INTO vendors (id, tenant_id, code, legal_name, vendor_type,
                            msme_registered, udyam_number, msme_category,
                            payment_terms_days)
       VALUES ($1,$2,'V-001','Sahyadri Cement Pvt Ltd','material_supplier',
               true,'UDYAM-MH-01-0001234','small',45)`,
      [vendorA, tenantA],
    );
    await c.query(
      `INSERT INTO vendors (id, tenant_id, code, legal_name)
       VALUES ($1,$2,'V-001','Other Tenant Contractor')`,
      [vendorB, tenantB],
    );

    /* --- ⭐ A REAL BILL, WITH ONE ELIGIBLE AND ONE BLOCKED LINE ---- */
    //
    // ⚠️ EXPLICIT BEGIN/COMMIT, AND IT IS NOT DECORATION. `adminPool` runs
    // in autocommit, where each statement is its own transaction — so the
    // DEFERRABLE INITIALLY DEFERRED reconciliation trigger fires at the
    // end of the INSERT that created the header, before any line exists,
    // and refuses it. The real write path builds the header and its lines
    // in one transaction, which is what this reproduces.
    //
    // ₹1,00,000 of cement for Tower B (sold pre-completion, ELIGIBLE) and
    // ₹1,00,000 of cement for the head office (own account, BLOCKED). One
    // vendor, one HSN, one rate, opposite answers.
    await c.query("BEGIN");
    await c.query(
      `INSERT INTO purchase_invoices
         (id, tenant_id, vendor_id, invoice_number, invoice_date, project_id,
          subtotal_minor, discount_minor, taxable_value_minor,
          cgst_minor, sgst_minor, igst_minor, cess_minor, total_minor,
          itc_eligible_tax_minor, itc_blocked_tax_minor,
          tax_period, status, gst_computed)
       VALUES ($1,$2,$3,'SC/2024/117', DATE '2024-05-10', $4,
               20000000, 0, 20000000,
               1800000, 1800000, 0, 0, 23600000,
               1800000, 1800000,
               '2024-05','recorded', true)`,
      [invoiceA, tenantA, vendorA, projectA],
    );
    await c.query(
      `INSERT INTO purchase_invoice_lines
         (id, tenant_id, purchase_invoice_id, line_number, description,
          amount_minor, taxable_value_minor, rate_bps,
          cgst_minor, sgst_minor, project_id,
          expenditure_nature, itc_purpose, itc_eligibility, itc_statutory_ref,
          itc_eligible_tax_minor, itc_blocked_tax_minor, rule42_attribution)
       VALUES ($1,$2,$3,1,'Cement — Tower B (sold pre-completion)',
               10000000, 10000000, 1800, 900000, 900000, $4,
               'construction_material','sold_before_completion','eligible',
               'Sch. II para 5(b)', 1800000, 0, 'exclusively_taxable')`,
      [lineEligibleA, tenantA, invoiceA, projectA],
    );
    await c.query(
      `INSERT INTO purchase_invoice_lines
         (id, tenant_id, purchase_invoice_id, line_number, description,
          amount_minor, taxable_value_minor, rate_bps,
          cgst_minor, sgst_minor,
          expenditure_nature, itc_purpose, itc_eligibility, itc_block_reason,
          itc_statutory_ref, itc_eligible_tax_minor, itc_blocked_tax_minor,
          rule42_attribution)
       VALUES ($1,$2,$3,2,'Cement — our own head office',
               10000000, 10000000, 1800, 900000, 900000,
               'construction_material','own_account_construction','blocked',
               'construction_own_account','17(5)(d)', 0, 1800000, 'blocked')`,
      [lineBlockedA, tenantA, invoiceA],
    );
    await c.query(
      `INSERT INTO vendor_ledger_entries
         (tenant_id, vendor_id, entry_date, entry_type, purchase_invoice_id,
          reference_number, credit_minor, due_date)
       VALUES ($1,$2, DATE '2024-05-10','purchase_invoice',$3,'SC/2024/117',
               23600000, DATE '2024-06-24')`,
      [tenantA, vendorA, invoiceA],
    );
    await c.query("COMMIT");
  });
});

afterAll(async () => {
  await asSuperuser(async (c) => {
    const tenants = [tenantA, tenantB];

    // ⚠️ Order matters, and it is the schema telling us something. The
    // foreign keys from `itc_register` to the lines and invoices are
    // RESTRICT — a credit that reached a return cannot be unmade — so a
    // teardown that deleted invoices first would be refused. That refusal
    // is the guarantee this phase is built on.
    await c.query(`DELETE FROM itc_register WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM vendor_ledger_entries WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM purchase_invoice_lines WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM purchase_invoices WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM vendors WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM projects WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM change_log WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM users WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM tenants WHERE id = ANY($1::uuid[])`, [tenants]);

    // Prove every guard is still enabled. A teardown that disabled one
    // would void the guarantee for every later run — and the suite would
    // still pass, which is the dangerous part.
    const { rows } = await c.query(
      `SELECT tgname, tgenabled::text AS state FROM pg_trigger
        WHERE tgrelid = 'itc_register'::regclass AND NOT tgisinternal`,
    );
    for (const row of rows) expect(row.state, row.tgname).toBe("O");
  });
});

/* ================================================================== */
/* 1. TENANT ISOLATION                                                 */
/* ================================================================== */

describe("tenant isolation", () => {
  it("⭐ a tenant sees only its own vendors", async () => {
    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query("SELECT legal_name FROM vendors");
      expect(rows.map((r) => r.legal_name)).toEqual(["Sahyadri Cement Pvt Ltd"]);
    });

    await asTenant(tenantB, async (c) => {
      const { rows } = await c.query("SELECT legal_name FROM vendors");
      expect(rows.map((r) => r.legal_name)).toEqual(["Other Tenant Contractor"]);
    });
  });

  it("⭐ a tenant sees only its own purchase invoices and ITC determinations", async () => {
    await asTenant(tenantB, async (c) => {
      const invoices = await c.query("SELECT id FROM purchase_invoices");
      expect(invoices.rows).toHaveLength(0);

      // The determination is the commercially sensitive part: it says what
      // this company is building and whether it is selling or keeping it.
      const lines = await c.query("SELECT id FROM purchase_invoice_lines");
      expect(lines.rows).toHaveLength(0);
    });
  });

  it("no tenant context reads ZERO rows, never all rows", async () => {
    await withoutTenant(async (c) => {
      for (const table of [
        "vendors",
        "purchase_invoices",
        "purchase_invoice_lines",
        "itc_register",
        "vendor_ledger_entries",
      ]) {
        const { rows } = await c.query(`SELECT count(*)::int AS n FROM ${table}`);
        expect(rows[0].n, table).toBe(0);
      }
    });
  });

  it("⭐ a purchase invoice cannot point at ANOTHER TENANT'S vendor", async () => {
    // The composite foreign key, not the RLS policy. FK checks run as the
    // system and ignore row-level security — without (id, tenant_id) this
    // insert would succeed and tenant A's purchase ledger would name a
    // vendor tenant A has never seen.
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(
          `INSERT INTO purchase_invoices (tenant_id, vendor_id, invoice_number, invoice_date)
           VALUES ($1,$2,'XT/001', DATE '2024-05-10')`,
          [tenantA, vendorB],
        ),
      ),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23503");
  });

  it("⭐ an ITC movement cannot point at ANOTHER TENANT'S invoice line", async () => {
    const error = await expectError(() =>
      asTenant(tenantB, async (c) =>
        c.query(
          `INSERT INTO itc_register
             (tenant_id, tax_period, purchase_invoice_id, purchase_invoice_line_id,
              status, reason, cgst_minor)
           VALUES ($1,'2024-05',$2,$3,'claimed','invoice_claim', 900000)`,
          [tenantB, invoiceA, lineEligibleA],
        ),
      ),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23503");
  });

  it("one tenant cannot overwrite another's ITC determination", async () => {
    await asTenant(tenantB, async (c) => {
      const { rowCount } = await c.query(
        `UPDATE purchase_invoice_lines SET itc_eligibility = 'eligible' WHERE id = $1`,
        [lineBlockedA],
      );
      // Not an error — RLS makes the row invisible, so the UPDATE simply
      // matches nothing. Fail closed, silently, which is correct.
      expect(rowCount).toBe(0);
    });

    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(
        `SELECT itc_eligibility FROM purchase_invoice_lines WHERE id = $1`,
        [lineBlockedA],
      );
      expect(rows[0].itc_eligibility).toBe("blocked");
    });
  });
});

/* ================================================================== */
/* 2. ⭐⭐ SECTION 17(5): THE SAME CEMENT, BOTH WAYS                   */
/* ================================================================== */

describe("⭐⭐ Section 17(5) blocked credits — the construction cases", () => {
  /**
   * ══════════════════════════════════════════════════════════════════
   * THE SINGLE MOST IMPORTANT PAIR OF ASSERTIONS IN THE PHASE.
   *
   * One lorry of cement. One HSN code. One vendor. One rate. The ONLY
   * difference between these two calls is what the building is FOR, and
   * the answers are opposite. Nothing on the purchase invoice
   * distinguishes them; the vendor does not know and could not say.
   *
   * If these two ever return the same verdict, a developer is either
   * claiming crores of credit that Section 17(5)(d) blocks — money in the
   * bank now, interest at 18% under Section 50 from now, found at an
   * audit years later — or capitalising crores of credit they were
   * entitled to claim, which nobody ever asks for back.
   * ══════════════════════════════════════════════════════════════════
   */

  it("⭐⭐ cement for units SOLD BEFORE COMPLETION is ELIGIBLE", () => {
    const verdict = determineItcEligibility({
      itcPurpose: "sold_before_completion",
      expenditureNature: "construction_material",
      outwardRateAllowsItc: true,
    });

    expect(verdict.eligibility).toBe("eligible");
    expect(verdict.blockReason).toBeNull();
    // Schedule II para 5(b): construction sold before the completion
    // certificate is a taxable supply of SERVICE, so it is not
    // construction "on his own account" and 17(5)(d) is not engaged.
    expect(verdict.statutoryRef).toBe("Sch. II para 5(b)");
    expect(verdict.rule42Attribution).toBe("exclusively_taxable");
  });

  it("⭐⭐ the SAME cement for our OWN ACCOUNT is BLOCKED under 17(5)(d)", () => {
    const verdict = determineItcEligibility({
      itcPurpose: "own_account_construction",
      expenditureNature: "construction_material",
      outwardRateAllowsItc: true,
    });

    expect(verdict.eligibility).toBe("blocked");
    expect(verdict.blockReason).toBe("construction_own_account");
    expect(verdict.statutoryRef).toBe("17(5)(d)");
    // T3 in Rule 42: a blocked credit is deducted before apportionment
    // and never enters the common pool, because there is nothing to
    // apportion.
    expect(verdict.rule42Attribution).toBe("blocked");
    // ⚠️ The explanation is asserted, not just the flag. It is the whole
    // defence at an assessment, and a determination that cannot say why
    // concedes the point.
    expect(verdict.explanation).toContain("OWN ACCOUNT");
  });

  it("⭐ the two verdicts differ on inputs that are otherwise identical", () => {
    const common = {
      expenditureNature: "construction_material",
      outwardRateAllowsItc: true,
    } as const;

    const sold = determineItcEligibility({
      ...common,
      itcPurpose: "sold_before_completion",
    });
    const own = determineItcEligibility({
      ...common,
      itcPurpose: "own_account_construction",
    });

    expect(sold.eligibility).not.toBe(own.eligibility);
  });

  it("⭐ THE DATABASE REFUSES an eligible credit on own-account construction", async () => {
    // The engine gets this right and the engine is ONE write path of four.
    // An import of historical bills, a psql correction and a future API
    // route are the others, and every one will be written by somebody who
    // has yesterday's eligible answer in their head.
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(
          `INSERT INTO purchase_invoice_lines
             (tenant_id, purchase_invoice_id, line_number, description,
              amount_minor, taxable_value_minor, rate_bps, cgst_minor, sgst_minor,
              expenditure_nature, itc_purpose, itc_eligibility,
              itc_eligible_tax_minor, itc_blocked_tax_minor, rule42_attribution)
           VALUES ($1,$2,99,'Cement — head office, claimed anyway',
                   10000000, 10000000, 1800, 900000, 900000,
                   'construction_material','own_account_construction','eligible',
                   1800000, 0, 'exclusively_taxable')`,
          [tenantA, invoiceA],
        ),
      ),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23514");
    expect(error!.message).toContain("own_account_blocked");
  });

  it("⭐ a works contract for our own building is blocked under 17(5)(c)…", () => {
    const verdict = determineItcEligibility({
      itcPurpose: "taxable_supply",
      expenditureNature: "works_contract_service",
    });

    expect(verdict.eligibility).toBe("blocked");
    expect(verdict.blockReason).toBe("works_contract_immovable");
    expect(verdict.statutoryRef).toBe("17(5)(c)");
  });

  it("⭐ …but is ELIGIBLE when it feeds a further supply of works contract", () => {
    // The sub-contractor exception. This is what keeps a main contractor
    // whole on its sub-contractors' bills.
    const verdict = determineItcEligibility({
      itcPurpose: "further_supply_works_contract",
      expenditureNature: "works_contract_service",
    });

    expect(verdict.eligibility).toBe("eligible");
    expect(verdict.statutoryRef).toBe("17(5)(c) proviso");
  });

  it("⭐ …and is ELIGIBLE for a tower being sold before completion", () => {
    const verdict = determineItcEligibility({
      itcPurpose: "sold_before_completion",
      expenditureNature: "works_contract_service",
      outwardRateAllowsItc: true,
    });

    expect(verdict.eligibility).toBe("eligible");
  });

  it("⭐ plant and machinery escapes BOTH construction clauses", () => {
    // A lift, a chiller, a DG set. The Explanation to Section 17 excludes
    // land, buildings and civil structures — the lift is plant, the shaft
    // is a building — so this is deliberately keyed on the PURPOSE.
    const verdict = determineItcEligibility({
      itcPurpose: "plant_and_machinery",
      expenditureNature: "works_contract_service",
    });

    expect(verdict.eligibility).toBe("eligible");
    expect(verdict.statutoryRef).toBe("Explanation to s.17");
  });

  it("⭐⭐ a pre-completion sale is STILL blocked under the 5% residential scheme", () => {
    // Notification 03/2019-CT(R). Section 17(5)(d) does not block it —
    // the CONDITION OF THE RATE does. And it is per project: the same
    // developer can be on 12%-with-credit for an ongoing tower and
    // 5%-without-credit for a new one, from one cement lorry.
    const verdict = determineItcEligibility({
      itcPurpose: "sold_before_completion",
      expenditureNature: "construction_material",
      outwardRateAllowsItc: false,
    });

    expect(verdict.eligibility).toBe("blocked");
    expect(verdict.blockReason).toBe("notified_rate_without_itc");
    expect(verdict.explanation).toContain("17(5)(d) does NOT");
  });

  it("the other 17(5) heads block, each naming its clause", () => {
    const cases: [Parameters<typeof determineItcEligibility>[0], string, string][] = [
      [
        { itcPurpose: "taxable_supply", expenditureNature: "motor_vehicle" },
        "motor_vehicle",
        "17(5)(a)",
      ],
      [
        { itcPurpose: "taxable_supply", expenditureNature: "food_and_beverage" },
        "food_beverage_catering",
        "17(5)(b)(i)",
      ],
      [
        { itcPurpose: "taxable_supply", expenditureNature: "club_or_fitness_membership" },
        "club_membership",
        "17(5)(b)(ii)",
      ],
      [
        { itcPurpose: "taxable_supply", expenditureNature: "life_or_health_insurance" },
        "life_or_health_insurance",
        "17(5)(b)(i)",
      ],
      [
        { itcPurpose: "taxable_supply", expenditureNature: "employee_travel_benefit" },
        "employee_travel_benefit",
        "17(5)(b)(iii)",
      ],
      [
        { itcPurpose: "non_business", expenditureNature: "goods" },
        "personal_consumption",
        "17(5)(g)",
      ],
    ];

    for (const [input, reason, ref] of cases) {
      const verdict = determineItcEligibility(input);
      expect(verdict.eligibility, JSON.stringify(input)).toBe("blocked");
      expect(verdict.blockReason, JSON.stringify(input)).toBe(reason);
      expect(verdict.statutoryRef, JSON.stringify(input)).toBe(ref);
    }
  });

  it("the 17(5)(b) provisos lift the block", () => {
    const canteen = determineItcEligibility({
      itcPurpose: "taxable_supply",
      expenditureNature: "food_and_beverage",
      statutoryObligationToEmployees: true,
    });
    expect(canteen.eligibility).toBe("eligible");

    const clubhouseRestaurant = determineItcEligibility({
      itcPurpose: "taxable_supply",
      expenditureNature: "food_and_beverage",
      usedForSameCategoryOutwardSupply: true,
    });
    expect(clubhouseRestaurant.eligibility).toBe("eligible");
  });

  it("⭐ a proviso does NOT skip the Section 17(2) test — the two-stage design", () => {
    // ══════════════════════════════════════════════════════════════
    // THE REGRESSION THIS FILE EXISTS TO CATCH IF THE FUNCTION IS EVER
    // FLATTENED BACK INTO ONE CASCADE.
    //
    // Section 17(5) blocks OUTRIGHT; Section 17(2) restricts in
    // PROPORTION. A supply that escapes 17(5) through a proviso is still
    // caught by 17(2). In a single cascade the proviso branch returns
    // "eligible" and the apportionment test below it is never reached —
    // the clubhouse restaurant's food credit escapes 17(5)(b) and is
    // then claimed IN FULL even though the clubhouse also makes exempt
    // supplies.
    // ══════════════════════════════════════════════════════════════
    const verdict = determineItcEligibility({
      itcPurpose: "common",
      expenditureNature: "food_and_beverage",
      usedForSameCategoryOutwardSupply: true,
    });

    expect(verdict.eligibility).toBe("proportionate");
    expect(verdict.rule42Attribution).toBe("common");
    // The proviso is still named — the evidence for escaping 17(5) has to
    // survive into the determination.
    expect(verdict.explanation).toContain("proviso");
  });

  it("Section 16(2)(a) outranks everything — no invoice, no credit", () => {
    const verdict = determineItcEligibility({
      // Even the most eligible purpose there is.
      itcPurpose: "sold_before_completion",
      expenditureNature: "construction_material",
      hasValidTaxInvoice: false,
    });

    expect(verdict.eligibility).toBe("blocked");
    expect(verdict.blockReason).toBe("no_valid_tax_invoice");
    expect(verdict.statutoryRef).toBe("s.16(2)(a)");
  });

  it("the screen reports WHY a credit survived, not just that it did", () => {
    const screen = screenBlockedCredit({
      itcPurpose: "taxable_supply",
      expenditureNature: "motor_vehicle",
      vehicleUsedForTaxableOnwardSupply: true,
    });

    expect(screen.blocked).toBe(false);
    if (!screen.blocked) {
      expect(screen.survivedVia).toContain("17(5)(a)");
    }
  });

  it("⭐ splitting a verdict across the heads accounts for every paisa", () => {
    const blockedSplit = splitItcByVerdict("blocked", HEADS_18PCT);
    expect(blockedSplit.eligibleTaxMinor).toBe(0n);
    expect(blockedSplit.blockedTaxMinor).toBe(sumHeads(HEADS_18PCT));

    const eligibleSplit = splitItcByVerdict("eligible", HEADS_18PCT);
    expect(eligibleSplit.eligibleTaxMinor).toBe(sumHeads(HEADS_18PCT));
    expect(eligibleSplit.blockedTaxMinor).toBe(0n);

    // ⭐ A `proportionate` line carries its FULL tax as eligible. Rule 42
    // avails the whole common credit and reverses the ineligible share
    // separately; splitting here AND reversing at period level would
    // count the reversal twice.
    const commonSplit = splitItcByVerdict("proportionate", HEADS_18PCT);
    expect(commonSplit.eligibleTaxMinor).toBe(sumHeads(HEADS_18PCT));
    expect(commonSplit.blockedTaxMinor).toBe(0n);

    for (const split of [blockedSplit, eligibleSplit, commonSplit]) {
      expect(split.eligibleTaxMinor + split.blockedTaxMinor).toBe(sumHeads(HEADS_18PCT));
    }
  });
});

/* ================================================================== */
/* 3. ⭐ RULE 42 APPORTIONMENT SUMS EXACTLY                            */
/* ================================================================== */

describe("⭐ Rule 42 apportionment", () => {
  /**
   * ══════════════════════════════════════════════════════════════════
   * THE INVARIANT THAT MAKES THE RETURN DEFENSIBLE:
   *
   *     T1 + T2 + T3 + T4 + D1 + D2 + eligibleCommon = C1
   *
   * D1 and D2 are ADDED BACK to output tax in GSTR-3B Table 4(B). The
   * eligible common credit is AVAILED in Table 4(A). If the three do not
   * add back to C3 exactly, the credit ledger and the reversal disagree
   * by the difference — and the difference is not an error anybody made.
   * It is two roundings that did not meet, and it is unexplainable.
   *
   * It holds only because `eligibleCommon` is a SUBTRACTION. The moment
   * somebody "simplifies" it to `C3 × (1 − E/F) − D2`, these tests fail.
   * ══════════════════════════════════════════════════════════════════
   */

  it("⭐⭐ the buckets and the reversals sum EXACTLY to the period's credit", () => {
    const result = apportionRule42({
      totalCreditMinor: 10_000_000n, // ₹1,00,000 of input tax
      nonBusinessMinor: 500_000n,
      exemptMinor: 700_000n,
      blockedMinor: 1_300_000n,
      taxableMinor: 4_000_000n,
      // A ratio that does NOT divide evenly: 33 / 97.
      exemptTurnoverMinor: 3_300_000n,
      totalTurnoverMinor: 9_700_000n,
    });

    expect(
      result.t1 +
        result.t2 +
        result.t3 +
        result.t4 +
        result.d1 +
        result.d2 +
        result.eligibleCommonMinor,
    ).toBe(result.c1);
  });

  it("⭐ the same holds across a hundred awkward ratios", () => {
    // A single hand-picked example proves the formula; a sweep proves the
    // ROUNDING. The residual construction is what makes it exact, and the
    // failure mode of the alternative is one paisa on some inputs and not
    // others — which no single case would find.
    for (let i = 1; i <= 100; i += 1) {
      const c1 = BigInt(1_000_003 + i * 977);
      const t1 = BigInt(i * 13);
      const t2 = BigInt(i * 29);
      const t3 = BigInt(i * 71);
      const t4 = BigInt(i * 4_001);

      const result = apportionRule42({
        totalCreditMinor: c1,
        nonBusinessMinor: t1,
        exemptMinor: t2,
        blockedMinor: t3,
        taxableMinor: t4,
        exemptTurnoverMinor: BigInt(i * 7),
        totalTurnoverMinor: BigInt(i * 7 + 991),
      });

      expect(
        result.t1 +
          result.t2 +
          result.t3 +
          result.t4 +
          result.d1 +
          result.d2 +
          result.eligibleCommonMinor,
        `iteration ${i}`,
      ).toBe(c1);

      // C2, C3 and the two reported totals all have to agree too.
      expect(result.c2, `iteration ${i}`).toBe(c1 - (t1 + t2 + t3));
      expect(result.c3, `iteration ${i}`).toBe(result.c2 - t4);
      expect(result.netEligibleMinor, `iteration ${i}`).toBe(
        result.t4 + result.eligibleCommonMinor,
      );
      expect(result.totalReversalMinor, `iteration ${i}`).toBe(result.d1 + result.d2);
      // ⭐ And the number that goes in the return: what is availed plus
      // what is reversed plus what never entered the ledger IS C1.
      expect(
        result.netEligibleMinor + result.totalReversalMinor + t1 + t2 + t3,
        `iteration ${i}`,
      ).toBe(c1);
    }
  });

  it("D2 is exactly 5% of C3 — Rule 42(1)(l)", () => {
    const result = apportionRule42({
      totalCreditMinor: 1_000_000n,
      nonBusinessMinor: 0n,
      exemptMinor: 0n,
      blockedMinor: 0n,
      taxableMinor: 0n,
      exemptTurnoverMinor: 0n,
      totalTurnoverMinor: 1_000_000n,
    });

    expect(result.c3).toBe(1_000_000n);
    expect(result.d1).toBe(0n);
    expect(result.d2).toBe(50_000n);
    expect(result.eligibleCommonMinor).toBe(950_000n);
  });

  it("⭐ a month with NO turnover reverses nothing rather than everything", () => {
    // A developer's first months on a project have crores of purchases
    // and no sales at all: E/F is 0/0. Dividing anyway is a division by
    // zero; defaulting the ratio to 1 would reverse the ENTIRE common
    // credit of a month with no exempt supply in it.
    const result = apportionRule42({
      totalCreditMinor: 5_000_000n,
      nonBusinessMinor: 0n,
      exemptMinor: 0n,
      blockedMinor: 0n,
      taxableMinor: 0n,
      exemptTurnoverMinor: 0n,
      totalTurnoverMinor: 0n,
    });

    expect(result.d1).toBe(0n);
    expect(result.exemptRatioBps).toBe(0);
    expect(result.d2).toBe(250_000n);
    expect(result.eligibleCommonMinor).toBe(4_750_000n);
  });

  it("⚠️ buckets that exceed the period's credit are REFUSED, not clamped", () => {
    // Clamping would produce a plausible-looking working that reconciles
    // to no return at all, and the person reading it could not tell.
    expect(() =>
      apportionRule42({
        totalCreditMinor: 100n,
        nonBusinessMinor: 60n,
        exemptMinor: 60n,
        blockedMinor: 0n,
        taxableMinor: 0n,
        exemptTurnoverMinor: 0n,
        totalTurnoverMinor: 100n,
      }),
    ).toThrow(/partition/i);
  });

  it("⚠️ exempt turnover exceeding total turnover is refused", () => {
    expect(() =>
      apportionRule42({
        totalCreditMinor: 100n,
        nonBusinessMinor: 0n,
        exemptMinor: 0n,
        blockedMinor: 0n,
        taxableMinor: 0n,
        exemptTurnoverMinor: 200n,
        totalTurnoverMinor: 100n,
      }),
    ).toThrow(/subset/i);
  });

  it("⭐ head-wise apportionment: each head reconciles on its own", () => {
    // GSTR-3B Table 4(B) reports the reversal per head. One computation
    // on the summed credit gives the same total and the WRONG four
    // numbers — and only the four numbers go in the return.
    const result = apportionRule42ByHead({
      totalCredit: { cgstMinor: 900_001n, sgstMinor: 900_001n, igstMinor: 1_700_003n, cessMinor: 0n },
      nonBusiness: { cgstMinor: 1n, sgstMinor: 1n, igstMinor: 3n, cessMinor: 0n },
      exempt: { cgstMinor: 100n, sgstMinor: 100n, igstMinor: 200n, cessMinor: 0n },
      blocked: { cgstMinor: 50_000n, sgstMinor: 50_000n, igstMinor: 0n, cessMinor: 0n },
      taxable: { cgstMinor: 400_000n, sgstMinor: 400_000n, igstMinor: 900_000n, cessMinor: 0n },
      exemptTurnoverMinor: 3_300_000n,
      totalTurnoverMinor: 9_700_000n,
    });

    for (const head of [result.cgst, result.sgst, result.igst, result.cess]) {
      expect(
        head.t1 + head.t2 + head.t3 + head.t4 + head.d1 + head.d2 + head.eligibleCommonMinor,
      ).toBe(head.c1);
    }

    expect(result.reversal.cgstMinor).toBe(result.cgst.totalReversalMinor);
    expect(result.netEligible.igstMinor).toBe(result.igst.netEligibleMinor);
  });

  it("⭐ capital goods are kept OUT of C1 and sent to Rule 43", () => {
    // Rule 42 apportions the period's common credit against the period's
    // turnover, once. Rule 43 spreads a capital item over sixty months.
    // Putting a chiller through Rule 42 claims in one month what the law
    // spreads over five years.
    const buckets = bucketRule42([
      { rule42Attribution: "common", heads: headsOf(1000n) },
      { rule42Attribution: "common", isCapitalGoods: true, heads: headsOf(6000n) },
      { rule42Attribution: "exclusively_taxable", heads: headsOf(500n) },
      { rule42Attribution: "blocked", heads: headsOf(200n) },
    ]);

    expect(buckets.totalCredit.cgstMinor).toBe(1700n);
    expect(buckets.capitalCommon.cgstMinor).toBe(6000n);
    expect(buckets.commonObserved.cgstMinor).toBe(1000n);
    expect(buckets.blocked.cgstMinor).toBe(200n);
  });

  it("⭐ Rule 43's sixty monthly slices sum to the whole capital credit", () => {
    // ⚠️ Tc ÷ 60 does not divide evenly. Reversing `Tm` sixty times
    // leaves up to 59 paise of a capital item's credit permanently
    // unreversed, per item, per head — invisible in any one month and
    // cumulative across a fleet.
    const tc = 1_000_000n + 37n;
    const result = apportionRule43({
      commonCreditMinor: tc,
      exemptTurnoverMinor: 1n,
      totalTurnoverMinor: 3n,
    });

    const months = BigInt(RULE_43_USEFUL_LIFE_MONTHS);
    expect(result.tmMinor * (months - 1n) + result.finalMonthTmMinor).toBe(tc);
  });
});

/* ================================================================== */
/* 4. ⭐ A PURCHASE INVOICE RECONCILES TO ITS LINES                    */
/* ================================================================== */

describe("⭐ a purchase invoice's tax and ITC reconcile to its lines", () => {
  it("the fixture invoice adds up, in the database", async () => {
    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(
        `SELECT i.taxable_value_minor::text            AS header_taxable,
                i.cgst_minor::text                     AS header_cgst,
                i.sgst_minor::text                     AS header_sgst,
                i.itc_eligible_tax_minor::text         AS header_eligible,
                i.itc_blocked_tax_minor::text          AS header_blocked,
                sum(l.taxable_value_minor)::text       AS line_taxable,
                sum(l.cgst_minor)::text                AS line_cgst,
                sum(l.sgst_minor)::text                AS line_sgst,
                sum(l.itc_eligible_tax_minor)::text    AS line_eligible,
                sum(l.itc_blocked_tax_minor)::text     AS line_blocked
           FROM purchase_invoices i
           JOIN purchase_invoice_lines l ON l.purchase_invoice_id = i.id
          WHERE i.id = $1
          GROUP BY i.id`,
        [invoiceA],
      );

      const row = rows[0];
      expect(row.line_taxable).toBe(row.header_taxable);
      expect(row.line_cgst).toBe(row.header_cgst);
      expect(row.line_sgst).toBe(row.header_sgst);
      // ⭐ The one nobody would otherwise catch.
      expect(row.line_eligible).toBe(row.header_eligible);
      expect(row.line_blocked).toBe(row.header_blocked);
    });
  });

  it("⭐⭐ THE DATABASE REFUSES an invoice whose ITC split disagrees with its lines", async () => {
    // ══════════════════════════════════════════════════════════════
    // The header claims the credit; the line determines it BLOCKED. Both
    // rows satisfy every CHECK constraint on their own and the four tax
    // heads still balance, so ONLY the deferred reconciliation trigger
    // catches it.
    //
    // Left through, the eligible figure goes into a GSTR-3B and the
    // blocked figure into the cost of a building — and if they do not
    // together equal the tax on the document, some tax reaches neither.
    // The return and the books then differ by exactly that amount,
    // permanently, with no error and no screen that shows it.
    // ══════════════════════════════════════════════════════════════
    const badInvoice = randomUUID();

    const error = await expectError(() =>
      asTenant(tenantA, async (c) => {
        await c.query(
          `INSERT INTO purchase_invoices
             (id, tenant_id, vendor_id, invoice_number, invoice_date,
              subtotal_minor, taxable_value_minor, cgst_minor, sgst_minor,
              total_minor, itc_eligible_tax_minor, gst_computed)
           VALUES ($1,$2,$3,'BAD/001', DATE '2024-05-20',
                   10000000, 10000000, 900000, 900000, 11800000, 1800000, true)`,
          [badInvoice, tenantA, vendorA],
        );
        await c.query(
          `INSERT INTO purchase_invoice_lines
             (tenant_id, purchase_invoice_id, line_number, description,
              amount_minor, taxable_value_minor, rate_bps, cgst_minor, sgst_minor,
              expenditure_nature, itc_purpose, itc_eligibility, itc_block_reason,
              itc_eligible_tax_minor, itc_blocked_tax_minor, rule42_attribution)
           VALUES ($1,$2,1,'Club membership', 10000000, 10000000, 1800, 900000, 900000,
                   'club_or_fitness_membership','taxable_supply','blocked',
                   'club_membership', 0, 1800000, 'blocked')`,
          [tenantA, badInvoice],
        );
        // ⚠️ `asTenant` commits, and the trigger is DEFERRABLE INITIALLY
        // DEFERRED — so the refusal arrives at COMMIT, not at the INSERT.
        // A test that asserted on the INSERT would pass while proving
        // nothing.
      }),
    );

    expect(error).not.toBeNull();
    expect(error!.message).toContain("does not match");
  });

  it("the pure reconciler names which figure is off and by how much", () => {
    const problems = reconcilePurchaseInvoice({
      header: {
        subtotalMinor: 10_000_000n,
        discountMinor: 0n,
        taxableValueMinor: 10_000_000n,
        cgstMinor: 900_000n,
        sgstMinor: 900_000n,
        igstMinor: 0n,
        cessMinor: 0n,
        roundOffMinor: 0n,
        totalMinor: 11_800_000n,
        // ⭐ Claims the credit the line says is blocked.
        itcEligibleTaxMinor: 1_800_000n,
        itcBlockedTaxMinor: 0n,
      },
      lines: [
        {
          amountMinor: 10_000_000n,
          discountMinor: 0n,
          taxableValueMinor: 10_000_000n,
          cgstMinor: 900_000n,
          sgstMinor: 900_000n,
          igstMinor: 0n,
          cessMinor: 0n,
          itcEligibleTaxMinor: 0n,
          itcBlockedTaxMinor: 1_800_000n,
        },
      ],
    });

    const fields = problems.map((p) => p.field);
    expect(fields).toContain("eligible ITC");
    expect(fields).toContain("blocked ITC");
    // The tax itself is fine — which is exactly why nobody would notice.
    expect(fields).not.toContain("CGST");
  });

  it("a correct invoice produces no problems", () => {
    expect(
      reconcilePurchaseInvoice({
        header: {
          subtotalMinor: 10_000_000n,
          discountMinor: 0n,
          taxableValueMinor: 10_000_000n,
          cgstMinor: 900_000n,
          sgstMinor: 900_000n,
          igstMinor: 0n,
          cessMinor: 0n,
          roundOffMinor: 0n,
          totalMinor: 11_800_000n,
          itcEligibleTaxMinor: 1_800_000n,
          itcBlockedTaxMinor: 0n,
        },
        lines: [
          {
            amountMinor: 10_000_000n,
            discountMinor: 0n,
            taxableValueMinor: 10_000_000n,
            cgstMinor: 900_000n,
            sgstMinor: 900_000n,
            igstMinor: 0n,
            cessMinor: 0n,
            itcEligibleTaxMinor: 1_800_000n,
            itcBlockedTaxMinor: 0n,
          },
        ],
      }),
    ).toEqual([]);
  });
});

/* ================================================================== */
/* 5. ⭐ THE SAME BILL CANNOT BE ENTERED TWICE                         */
/* ================================================================== */

describe("⭐ duplicate vendor bills", () => {
  it("⭐ the same invoice number for the same vendor in one financial year is refused", async () => {
    // The site office enters it from the delivery copy; accounts enters it
    // from the emailed PDF. Neither entry looks wrong. The credit is
    // claimed twice and the payment run pays it twice.
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(
          `INSERT INTO purchase_invoices
             (tenant_id, vendor_id, invoice_number, invoice_date)
           VALUES ($1,$2,'SC/2024/117', DATE '2024-08-01')`,
          [tenantA, vendorA],
        ),
      ),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23505");
  });

  it("⭐ case and trailing space do not defeat it", async () => {
    // Two copies of one vendor document routinely differ by exactly this
    // much, because one was typed and one was pasted.
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(
          `INSERT INTO purchase_invoices
             (tenant_id, vendor_id, invoice_number, invoice_date)
           VALUES ($1,$2,'sc/2024/117 ', DATE '2024-09-01')`,
          [tenantA, vendorA],
        ),
      ),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23505");
  });

  it("the same serial in the NEXT financial year is accepted", async () => {
    // Rule 46(b) makes a supplier's serial unique per FINANCIAL year, so
    // "SC/2024/117" legitimately recurs. Refusing it would push somebody
    // into prefixing numbers by hand, which defeats the whole defence.
    const id = randomUUID();
    await asTenant(tenantA, async (c) =>
      c.query(
        `INSERT INTO purchase_invoices
           (id, tenant_id, vendor_id, invoice_number, invoice_date)
         VALUES ($1,$2,$3,'SC/2024/117', DATE '2025-05-10')`,
        [id, tenantA, vendorA],
      ),
    );

    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM purchase_invoices WHERE invoice_number = 'SC/2024/117'`,
      );
      expect(rows[0].n).toBe(2);
    });

    await asSuperuser(async (c) =>
      c.query(`DELETE FROM purchase_invoices WHERE id = $1`, [id]),
    );
  });
});

/* ================================================================== */
/* 6. ⭐ THE ITC REGISTER                                              */
/* ================================================================== */

describe("⭐ the ITC register", () => {
  it("⭐ a BLOCKED line cannot be claimed, whoever asks", async () => {
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(
          `INSERT INTO itc_register
             (tenant_id, tax_period, purchase_invoice_id, purchase_invoice_line_id,
              vendor_id, status, reason, cgst_minor, sgst_minor)
           VALUES ($1,'2024-05',$2,$3,$4,'claimed','invoice_claim', 900000, 900000)`,
          [tenantA, invoiceA, lineBlockedA, vendorA],
        ),
      ),
    );

    expect(error).not.toBeNull();
    expect(error!.message).toContain("BLOCKED");
  });

  it("an eligible line can be claimed", async () => {
    await asTenant(tenantA, async (c) =>
      c.query(
        `INSERT INTO itc_register
           (tenant_id, tax_period, purchase_invoice_id, purchase_invoice_line_id,
            vendor_id, status, reason, statutory_ref, cgst_minor, sgst_minor)
         VALUES ($1,'2024-05',$2,$3,$4,'claimed','invoice_claim','s.16(1)',
                 900000, 900000)`,
        [tenantA, invoiceA, lineEligibleA, vendorA],
      ),
    );

    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM itc_register WHERE status = 'claimed'`,
      );
      expect(rows[0].n).toBe(1);
    });
  });

  it("⭐⭐ the SAME credit cannot be claimed again in a DIFFERENT period", async () => {
    // ══════════════════════════════════════════════════════════════
    // The defence the per-period unique index does not provide. Two rows,
    // two months, two perfectly valid unique keys, and the same rupee
    // claimed twice — which is what happens when somebody re-runs the
    // period build over a wider date range.
    // ══════════════════════════════════════════════════════════════
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(
          `INSERT INTO itc_register
             (tenant_id, tax_period, purchase_invoice_id, purchase_invoice_line_id,
              vendor_id, status, reason, cgst_minor, sgst_minor)
           VALUES ($1,'2024-07',$2,$3,$4,'claimed','invoice_claim', 900000, 900000)`,
          [tenantA, invoiceA, lineEligibleA, vendorA],
        ),
      ),
    );

    expect(error).not.toBeNull();
    expect(error!.message).toContain("more than one tax period");
  });

  it("⭐ a Rule 37 reversal and re-claim after payment IS allowed", async () => {
    // Reversed in October for non-payment within 180 days, re-claimed in
    // December once the supplier is paid. GSTR-3B puts a re-availment
    // back in the SAME box as an ordinary one, which is why there is no
    // `reclaimed` status. A rule counting gross claims would refuse this,
    // and the workaround — editing the original row — would destroy the
    // history the register exists to keep.
    await asTenant(tenantA, async (c) => {
      await c.query(
        `INSERT INTO itc_register
           (tenant_id, tax_period, purchase_invoice_id, purchase_invoice_line_id,
            vendor_id, status, reason, statutory_ref, cgst_minor, sgst_minor)
         VALUES ($1,'2024-10',$2,$3,$4,'reversed','rule_37_non_payment_180_days',
                 'Rule 37', 900000, 900000)`,
        [tenantA, invoiceA, lineEligibleA, vendorA],
      );
      await c.query(
        `INSERT INTO itc_register
           (tenant_id, tax_period, purchase_invoice_id, purchase_invoice_line_id,
            vendor_id, status, reason, cgst_minor, sgst_minor)
         VALUES ($1,'2024-12',$2,$3,$4,'claimed','reclaim_after_payment',
                 900000, 900000)`,
        [tenantA, invoiceA, lineEligibleA, vendorA],
      );
    });

    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(
        `SELECT status, count(*)::int AS n FROM itc_register
          WHERE purchase_invoice_line_id = $1 GROUP BY status ORDER BY status`,
        [lineEligibleA],
      );
      expect(rows).toEqual([
        { status: "claimed", n: 2 },
        { status: "reversed", n: 1 },
      ]);
    });
  });

  it("⭐⭐ THE REGISTER TOTALS RECONCILE — claimed − reversed = net", async () => {
    const movements = await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(
        `SELECT tax_period, status, reason,
                cgst_minor::text AS cgst, sgst_minor::text AS sgst,
                igst_minor::text AS igst, cess_minor::text AS cess
           FROM itc_register`,
      );
      return rows;
    });

    const summary = summariseItcRegister(
      movements.map((row) => ({
        taxPeriod: row.tax_period,
        status: row.status,
        reason: row.reason,
        cgstMinor: BigInt(row.cgst),
        sgstMinor: BigInt(row.sgst),
        igstMinor: BigInt(row.igst),
        cessMinor: BigInt(row.cess),
      })),
    );

    // ₹18,000 claimed in May, ₹18,000 reversed in October, ₹18,000
    // re-claimed in December. Three periods, and each nets to its own
    // movements — a summary that netted across periods would report a
    // single zero and hide all three.
    const byPeriod = new Map(summary.map((s) => [s.taxPeriod, s]));
    expect(byPeriod.get("2024-05")?.netTotalMinor).toBe(1_800_000n);
    expect(byPeriod.get("2024-10")?.netTotalMinor).toBe(-1_800_000n);
    expect(byPeriod.get("2024-12")?.netTotalMinor).toBe(1_800_000n);

    for (const period of summary) {
      // ⭐ Head by head, not just in total. GSTR-3B Table 4(C) is
      // 4(A) − 4(B) per head, and a net that was right in total and
      // wrong per head would file cleanly and be wrong.
      expect(period.net.cgstMinor).toBe(
        period.claimed.cgstMinor - period.reversed.cgstMinor,
      );
      expect(period.net.sgstMinor).toBe(
        period.claimed.sgstMinor - period.reversed.sgstMinor,
      );
      expect(period.net.igstMinor).toBe(
        period.claimed.igstMinor - period.reversed.igstMinor,
      );
      expect(period.netTotalMinor).toBe(
        period.claimedTotalMinor - period.reversedTotalMinor,
      );
    }

    // And across the whole register: everything claimed less everything
    // reversed equals the credit actually held.
    const totalClaimed = summary.reduce((sum, s) => sum + s.claimedTotalMinor, 0n);
    const totalReversed = summary.reduce((sum, s) => sum + s.reversedTotalMinor, 0n);
    const totalNet = summary.reduce((sum, s) => sum + s.netTotalMinor, 0n);
    expect(totalClaimed - totalReversed).toBe(totalNet);
    expect(totalNet).toBe(1_800_000n);
  });

  it("⚠️ a net reversal is NOT clamped at zero", () => {
    // A month where a large Rule 37 reversal lands on small purchases
    // produces a negative net, and that is exactly what GSTR-3B shows —
    // a net reversal, payable in cash. Clamping would understate the
    // liability, which is the direction that attracts interest.
    const [summary] = summariseItcRegister([
      {
        taxPeriod: "2024-11",
        status: "reversed",
        reason: "rule_37_non_payment_180_days",
        cgstMinor: 500n,
        sgstMinor: 500n,
        igstMinor: 0n,
        cessMinor: 0n,
      },
    ]);

    expect(summary?.netTotalMinor).toBe(-1000n);
  });

  it("a period-level Rule 42 reversal needs no line, and nothing else may", async () => {
    await asTenant(tenantA, async (c) =>
      c.query(
        `INSERT INTO itc_register
           (tenant_id, tax_period, status, reason, statutory_ref, cgst_minor, sgst_minor)
         VALUES ($1,'2024-05','reversed','rule_42_common_reversal','Rule 42(1)',
                 5000, 5000)`,
        [tenantA],
      ),
    );

    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(
          `INSERT INTO itc_register
             (tenant_id, tax_period, status, reason, cgst_minor)
           VALUES ($1,'2024-05','claimed','invoice_claim', 5000)`,
          [tenantA],
        ),
      ),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23514");
  });
});

/* ================================================================== */
/* 7. THE VENDOR LEDGER, AGEING AND THE MSME CLOCK                     */
/* ================================================================== */

describe("vendor ledger, ageing and MSME", () => {
  const ENTRIES = [
    {
      id: "a",
      entryDate: "2024-01-10",
      entryType: "purchase_invoice" as const,
      debitMinor: 0n,
      creditMinor: 100_000n,
      dueDate: "2024-02-09",
    },
    {
      id: "b",
      entryDate: "2024-02-15",
      entryType: "payment" as const,
      debitMinor: 40_000n,
      creditMinor: 0n,
    },
    {
      id: "c",
      entryDate: "2024-03-01",
      entryType: "purchase_invoice" as const,
      debitMinor: 0n,
      creditMinor: 60_000n,
      dueDate: "2024-03-31",
    },
    {
      id: "d",
      entryDate: "2024-03-01",
      entryType: "retention_held" as const,
      debitMinor: 0n,
      creditMinor: 10_000n,
      dueDate: "2025-03-01",
      excludeFromAgeing: true,
    },
  ];

  it("the running balance carries down, and a payable is a CREDIT balance", () => {
    const rows = runningBalance(ENTRIES);
    expect(rows.map((r) => r.balanceMinor)).toEqual([
      100_000n,
      60_000n,
      120_000n,
      130_000n,
    ]);
    expect(closingBalance(ENTRIES)).toBe(130_000n);
  });

  it("⚠️ the order is deterministic when several entries share a date", () => {
    // A bill and the TDS withheld on it are both dated the day the bill is
    // passed. Without a deterministic second key the balance column
    // differs between two renders of the same data, and a vendor
    // comparing our statement with theirs sees two different documents
    // from us.
    const forwards = runningBalance(ENTRIES).map((r) => r.id);
    const backwards = runningBalance([...ENTRIES].reverse()).map((r) => r.id);
    expect(forwards).toEqual(backwards);
  });

  it("⭐ ageing runs from the DUE date, not the invoice date", () => {
    // "How old is this bill" is a question nobody needs. "How late are we"
    // is the one a payables run asks, and a bill on 90-day terms raised 60
    // days ago is not late at all.
    const ageing = ageVendorLedger({ entries: ENTRIES, asOf: "2024-03-15" });

    // Entry "a" was due 2024-02-09: 35 days overdue → the 31–60 bucket.
    const bucket31to60 = ageing.buckets.find((b) => b.fromDays === 31);
    expect(bucket31to60?.amountMinor).toBe(100_000n);

    // Entry "c" is due 2024-03-31, so it is not yet due — and NOT in
    // bucket zero, because a first column mixing "a fortnight late" with
    // "not due for a fortnight" is useless for the only decision it
    // supports.
    expect(ageing.notYetDueMinor).toBe(60_000n);

    // ⭐ Retention is excluded. Money withheld under the contract until
    // the defect liability period ends is a payable that is not yet
    // payable, and counting it puts the biggest number on the page in the
    // oldest column.
    expect(ageing.excludedMinor).toBe(10_000n);
    for (const bucket of ageing.buckets) {
      expect(bucket.amountMinor).not.toBe(10_000n);
    }

    expect(ageing.outstandingMinor).toBe(130_000n);
  });

  it("day arithmetic crosses month and year boundaries correctly", () => {
    // `new Date(string)` parses as midnight LOCAL, and a difference taken
    // across a boundary on a machine east of UTC comes out a day short.
    // Ageing is nothing but that difference.
    expect(daysBetween("2024-02-28", "2024-03-01")).toBe(2); // 2024 is a leap year
    expect(daysBetween("2023-02-28", "2023-03-01")).toBe(1);
    expect(daysBetween("2024-12-31", "2025-01-01")).toBe(1);
    expect(daysBetween("2024-03-15", "2024-03-15")).toBe(0);
  });

  it("⭐ MSME: a micro/small vendor is capped at 45 days whatever was agreed", () => {
    const exposure = assessMsmeExposure({
      msmeRegistered: true,
      msmeCategory: "small",
      // A 90-day purchase order. Section 32 of the MSMED Act voids it.
      paymentTermsDays: 90,
      acceptedOn: "2024-01-01",
      asOf: "2024-03-01",
    });

    expect(exposure.applies).toBe(true);
    expect(exposure.effectiveTermDays).toBe(MSME_STATUTORY_MAX_DAYS);
    expect(exposure.dueDate).toBe("2024-02-15");
    expect(exposure.disallowanceRisk).toBe(true);
    expect(exposure.message).toContain("43B(h)");
  });

  it("⭐ a MEDIUM enterprise is NOT within Section 43B(h)", () => {
    // The obvious simplification is to treat all three categories the
    // same, and it raises a false alarm on every medium vendor — which is
    // how a real alarm gets ignored.
    const exposure = assessMsmeExposure({
      msmeRegistered: true,
      msmeCategory: "medium",
      paymentTermsDays: 90,
      acceptedOn: "2024-01-01",
      asOf: "2024-06-01",
    });

    expect(exposure.applies).toBe(false);
    expect(exposure.disallowanceRisk).toBe(false);
    expect(exposure.effectiveTermDays).toBe(90);
  });

  it("⚠️ a bill PAID ON TIME never becomes overdue however long ago it was", () => {
    // Measuring a paid bill against today would grow its overdue figure
    // forever and, worse, report a bill paid on time as late once enough
    // time had passed.
    const exposure = assessMsmeExposure({
      msmeRegistered: true,
      msmeCategory: "micro",
      paymentTermsDays: 30,
      acceptedOn: "2024-01-01",
      paidOn: "2024-01-20",
      asOf: "2026-08-01",
    });

    expect(exposure.daysOverdue).toBe(0);
    expect(exposure.disallowanceRisk).toBe(false);
  });

  it("⭐ the database refuses a 90-day term on a micro/small vendor", async () => {
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(
          `INSERT INTO vendors (tenant_id, code, legal_name, msme_registered,
                                udyam_number, msme_category, payment_terms_days)
           VALUES ($1,'V-BAD','Late Paid Contractor', true,
                   'UDYAM-MH-01-0009999','micro', 90)`,
          [tenantA],
        ),
      ),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23514");
    expect(error!.message).toContain("vendors_terms_sane");
  });

  it("a ledger entry may not carry both a debit and a credit", async () => {
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(
          `INSERT INTO vendor_ledger_entries
             (tenant_id, vendor_id, entry_date, entry_type, debit_minor, credit_minor)
           VALUES ($1,$2, DATE '2024-05-10','adjustment', 100, 200)`,
          [tenantA, vendorA],
        ),
      ),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23514");
  });

  it("Udyam numbers are validated, and Udyog Aadhaar is named as the mistake", () => {
    expect(isValidUdyamNumber("UDYAM-MH-01-0001234")).toBe(true);
    expect(isValidUdyamNumber("udyam-mh-01-0001234")).toBe(true);
    expect(isValidUdyamNumber("UDYAM-MH-1-0001234")).toBe(false);
    expect(isValidUdyamNumber("123456789012")).toBe(false);

    expect(describeUdyamProblem("UDYAM-MH-01-0001234")).toBeNull();
    // Half the numbers vendors send are the old twelve-digit ones, and
    // saying so is the difference between a fixed record and a ticket.
    expect(describeUdyamProblem("123456789012")).toContain("Udyog Aadhaar");
  });
});

/* ================================================================== */
/* 8. TAX PERIODS AND THE SECTION 16(4) CLIFF                          */
/* ================================================================== */

describe("tax periods and the Section 16(4) deadline", () => {
  it("a tax period is sliced from the string, never parsed through Date", () => {
    // `new Date(day).getMonth()` reads the month in the LOCAL zone, so a
    // bill dated the first of a month lands in the previous period on any
    // machine west of UTC — and a credit claimed in the wrong month is a
    // credit claimed in a return that has already been filed.
    expect(taxPeriodOf("2024-04-01")).toBe("2024-04");
    expect(taxPeriodOf("2024-12-31")).toBe("2024-12");
  });

  it("⭐ the Section 16(4) deadline is 30 November after the financial year", () => {
    // A May 2024 bill belongs to FY 2024-25, which ends 31 March 2025, so
    // the credit must be taken by the November 2025 return.
    expect(itcClaimDeadlinePeriod("2024-05-10")).toBe("2025-11");
    // A January 2024 bill belongs to FY 2023-24 — the PREVIOUS year — so
    // its deadline is a whole year earlier. Reading the calendar year
    // would give a claimant twelve extra months they do not have.
    expect(itcClaimDeadlinePeriod("2024-01-15")).toBe("2024-11");
    expect(itcClaimDeadlinePeriod("2024-03-31")).toBe("2024-11");
    expect(itcClaimDeadlinePeriod("2024-04-01")).toBe("2025-11");
  });

  it("⭐ it is a cliff, not a taper", () => {
    // A credit claimed one month late is not reduced. It is simply not
    // available, permanently, and the money is gone.
    expect(isWithinItcDeadline("2024-05-10", "2025-11")).toBe(true);
    expect(isWithinItcDeadline("2024-05-10", "2025-12")).toBe(false);
  });

  it("the database function agrees with the application", async () => {
    // A disagreement makes the duplicate index key differ from what the
    // application believes it is, so a duplicate slips through in the
    // three months either side of April.
    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(
        `SELECT indian_financial_year(DATE '2024-04-01') AS a,
                indian_financial_year(DATE '2025-03-31') AS b,
                indian_financial_year(DATE '2024-01-15') AS c,
                itc_claim_deadline_period(DATE '2024-05-10') AS d`,
      );
      expect(rows[0].a).toBe("2024-25");
      expect(rows[0].b).toBe("2024-25");
      expect(rows[0].c).toBe("2023-24");
      expect(rows[0].d).toBe("2025-11");
    });
  });
});

/* ================================================================== */
/* 9. VALIDATION                                                       */
/* ================================================================== */

describe("validation refuses the shapes the database would refuse", () => {
  it("an MSME claim without a Udyam number is refused on the form", () => {
    const result = upsertVendorSchema.safeParse({
      code: "V-X",
      legalName: "Some Contractor",
      msmeRegistered: true,
    });
    expect(result.success).toBe(false);
  });

  it("⭐ a 90-day term on a micro vendor is refused on the form too", () => {
    // The CHECK constraint refuses it whatever route it arrives by. The
    // schema refuses it with the sentence that explains why a purchase
    // order cannot extend a statutory limit.
    const result = upsertVendorSchema.safeParse({
      code: "V-X",
      legalName: "Some Contractor",
      msmeRegistered: true,
      udyamNumber: "UDYAM-MH-01-0001234",
      msmeCategory: "micro",
      paymentTermsDays: 90,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toContain("MSMED");
    }
  });

  it("⭐ immovable property demands the place of supply be the PROPERTY's state", () => {
    const base = {
      vendorId: randomUUID(),
      invoiceNumber: "C/1",
      invoiceDate: "2024-05-10",
      supplyType: "immovable_property" as const,
      lines: [
        {
          lineNumber: 1,
          description: "Civil works",
          amount: "100000.00",
          rateBps: 1800,
          itcPurpose: "sold_before_completion" as const,
        },
      ],
    };

    // Property in Maharashtra, place of supply taxed to Karnataka.
    expect(
      recordPurchaseInvoiceSchema.safeParse({
        ...base,
        propertyStateCode: "27",
        placeOfSupplyCode: "29",
      }).success,
    ).toBe(false);

    expect(
      recordPurchaseInvoiceSchema.safeParse({
        ...base,
        propertyStateCode: "27",
        placeOfSupplyCode: "27",
      }).success,
    ).toBe(true);
  });

  it("⭐ `itcPurpose` has NO default on the form", () => {
    // The COLUMN defaults to `taxable_supply` so an import of historical
    // bills does not fail. The FORM must not: defaulting the answer to the
    // eligible one means a person entering a cement bill for the company's
    // own head office claims the credit by pressing Enter.
    const result = recordPurchaseInvoiceSchema.safeParse({
      vendorId: randomUUID(),
      invoiceNumber: "C/2",
      invoiceDate: "2024-05-10",
      lines: [
        {
          lineNumber: 1,
          description: "Cement",
          amount: "100000.00",
          rateBps: 1800,
          // itcPurpose deliberately absent
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("a reverse-charge bill must cite the provision", () => {
    const result = recordPurchaseInvoiceSchema.safeParse({
      vendorId: randomUUID(),
      invoiceNumber: "C/3",
      invoiceDate: "2024-05-10",
      isReverseCharge: true,
      lines: [
        {
          lineNumber: 1,
          description: "Goods transport",
          amount: "100000.00",
          rateBps: 500,
          itcPurpose: "taxable_supply",
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

/* ================================================================== */
/* HELPERS                                                             */
/* ================================================================== */

function headsOf(amount: bigint): TaxHeads {
  return { cgstMinor: amount, sgstMinor: amount, igstMinor: 0n, cessMinor: 0n };
}
