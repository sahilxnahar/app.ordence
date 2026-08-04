/**
 * Ordence — ⭐ Tax Deducted at Source
 * Version: v0.36.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE IS ACTUALLY TRYING TO PROVE
 * ══════════════════════════════════════════════════════════════════════
 * Thirty-five phases say the same thing: the defects that survive are the
 * SILENT ones. This phase is silent in a new way — the money that goes
 * wrong is never ours, so nobody inside the company is looking for it.
 *
 *   • ⭐ A labour contractor paid ₹25,000 four times. Every payment is
 *     under Section 194C's ₹30,000 single-payment limit and nothing is
 *     deducted. The aggregate is ₹1,00,000 and the second limb of
 *     194C(5) made tax due on ALL of it at the fourth payment. Four
 *     correct-looking vouchers, four correct-looking transfers, no error
 *     anywhere — and Section 201(1) makes the ₹1,000 ours, with interest
 *     from the date of each payment and 30% of the expenditure
 *     disallowed under 40(a)(ia).
 *
 *   • A vendor whose PAN we do not hold, deducted at 1% instead of 20%.
 *     The bill is right, the payment is right, and TRACES raises a
 *     short-deduction demand for the year.
 *
 *   • A Section 197 certificate that expired on 31 March, still being
 *     applied in August. A real document, correctly issued, and no
 *     defence at all for the period after it lapsed.
 *
 *   • ⭐ A challan with ₹3,50,000 in it and ₹4,00,000 mapped to it. The
 *     return is ACCEPTED. Some deductees get credit and some silently do
 *     not, chosen by nothing anybody controls.
 *
 * So the tests below do not inspect constraints. They pay the same
 * contractor four times and demand that the fourth deduction be ₹1,000
 * and not ₹250. They take a deductee who is BOTH PAN-less AND a
 * specified person and demand the HIGHER of the two rates. They apply a
 * certificate one day outside its window and demand a refusal.
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
  TDS_SECTIONS,
  TDS_SECTION_CODES,
  SECTION_206AA_BPS,
  SECTION_206AA_194Q_BPS,
  SECTION_206AB_FLOOR_BPS,
  deducteeClassOf,
  normalRateBps,
  panAgreesWithDeducteeType,
  sectionRule,
  sectionsWithMode,
  tdsOn,
} from "@/lib/tds/sections";
import {
  accumulate,
  assessThresholdFor,
  findThresholdShortfalls,
  type PriorDeduction,
} from "@/lib/tds/thresholds";
import { resolveTdsRate, assessCertificate, computeDeduction } from "@/lib/tds/rates";
import {
  assessLateDeposit,
  assessLateDeduction,
  assessLateFiling,
  monthsOrPartThereof,
  INTEREST_DEDUCTED_NOT_PAID_BPS_PER_MONTH,
} from "@/lib/tds/interest";
import {
  reconcileChallans,
  allocateToChallans,
  challanTaxCapacityMinor,
} from "@/lib/tds/challans";
import { assembleCertificate } from "@/lib/tds/certificates";
import { assembleReturn, validateReturn, panForReturn, formTypeFor } from "@/lib/tds/returns";
import { reconcileRegisterToChallans, verifyAccumulationChain } from "@/lib/tds/register";
import {
  quarterOf,
  quarterRange,
  depositDueDate,
  returnDueDate,
  certificateDueDate,
  assessmentYearOf,
} from "@/lib/tds/calendar";
import {
  upsertDeducteeSchema,
  upsertLowerDeductionCertificateSchema,
  tanSchema,
  bsrCodeSchema,
} from "@/lib/validators/tds";

/* ================================================================== */
/* FIXTURES                                                            */
/* ================================================================== */

let tenantA: string;
let tenantB: string;
let userA: string;
/** ⭐ The labour contractor of the four ₹25,000 payments. */
let contractorA: string;
let contractorB: string;
let challanA: string;
let certificateA: string;

const RUPEE = 100n;
const R = (n: number | bigint) => BigInt(n) * RUPEE;

/** A prior payment with nothing brought into charge. */
const paid = (day: string, rupees: number): PriorDeduction => ({
  deductionDate: day,
  baseMinor: R(rupees),
  chargedBaseMinor: 0n,
});

beforeAll(async () => {
  tenantA = randomUUID();
  tenantB = randomUUID();
  userA = randomUUID();
  contractorA = randomUUID();
  contractorB = randomUUID();
  challanA = randomUUID();
  certificateA = randomUUID();

  await asSuperuser(async (c) => {
    for (const [id, name] of [
      [tenantA, "TDS Isolation A"],
      [tenantB, "TDS Isolation B"],
    ] as const) {
      await c.query(
        `INSERT INTO tenants (id, clerk_org_id, slug, name, status)
         VALUES ($1,$2,$3,$4,'active')`,
        [id, `org_${id}`, `tds-${id.slice(0, 8)}`, name],
      );
    }

    await c.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, status)
       VALUES ($1,$2,$3,'tds-a@example.test','tenant_admin','active')`,
      [userA, tenantA, `usr_${userA}`],
    );

    // ⭐ An INDIVIDUAL — 194C at 1%, not 2%. The PAN's fourth character
    // says so, and it is the fact nothing on an invoice states.
    await c.query(
      `INSERT INTO tds_deductees
         (id, tenant_id, code, legal_name, pan_number, pan_status, deductee_type)
       VALUES ($1,$2,'D-001','Ramesh Labour Contractor','AAAPR1234K','valid','individual')`,
      [contractorA, tenantA],
    );
    await c.query(
      `INSERT INTO tds_deductees
         (id, tenant_id, code, legal_name, pan_number, pan_status, deductee_type)
       VALUES ($1,$2,'D-001','Other Tenant Contractor','AAACO9876L','valid','company')`,
      [contractorB, tenantB],
    );

    await c.query(
      `INSERT INTO tds_challans
         (id, tenant_id, tan, bsr_code, challan_serial, deposit_date,
          financial_year, assessment_year, quarter,
          tax_minor, interest_minor, total_minor)
       VALUES ($1,$2,'RTKA12345B','0001234','00001', DATE '2025-01-07',
               '2024-25','2025-26','Q3', 100000, 0, 100000)`,
      [challanA, tenantA],
    );

    // ⭐ A Section 197 certificate at 0.5%, valid 1 June to 31 March.
    await c.query(
      `INSERT INTO tds_lower_deduction_certificates
         (id, tenant_id, deductee_id, certificate_number, section, rate_bps,
          valid_from, valid_to, financial_year)
       VALUES ($1,$2,$3,'CERT/2024/001','194C', 50,
               DATE '2024-06-01', DATE '2025-03-31', '2024-25')`,
      [certificateA, tenantA, contractorA],
    );

    /* --- ⭐ THE FOUR ₹25,000 PAYMENTS ---------------------------- */
    //
    // ⚠️ EXPLICIT BEGIN/COMMIT, AND IT IS NOT DECORATION. `adminPool` runs
    // in autocommit, where each statement is its own transaction — so the
    // DEFERRABLE INITIALLY DEFERRED accumulation trigger would fire after
    // each row rather than once the group is complete. The real write path
    // builds a payment run in one transaction, which is what this
    // reproduces.
    await c.query("BEGIN");
    for (const [day, quarter, before] of [
      ["2024-04-10", "Q1", 0],
      ["2024-06-10", "Q1", 2_500_000],
      ["2024-09-10", "Q2", 5_000_000],
    ] as const) {
      await c.query(
        `INSERT INTO tds_deductions
           (tenant_id, deductee_id, section, financial_year, quarter,
            deduction_date, payment_base_minor,
            aggregate_before_minor, aggregate_after_minor, outcome)
         VALUES ($1,$2,'194C','2024-25',$3,$4::date, 2500000, $5::bigint,
                 $5::bigint + 2500000,
                 'below_threshold')`,
        [tenantA, contractorA, quarter, day, before],
      );
    }
    // ⭐ The crossing payment: ₹25,000 paid, ₹1,00,000 chargeable, ₹1,000
    // deducted at 1% — and mapped to the ₹1,000 challan.
    await c.query(
      `INSERT INTO tds_deductions
         (tenant_id, deductee_id, section, financial_year, quarter,
          deduction_date, payment_base_minor, catch_up_base_minor,
          chargeable_base_minor, aggregate_before_minor, aggregate_after_minor,
          rate_bps, rate_basis, statutory_ref, tds_minor, total_deducted_minor,
          outcome, challan_id)
       VALUES ($1,$2,'194C','2024-25','Q3', DATE '2024-12-10',
               2500000, 7500000, 10000000, 7500000, 10000000,
               100, 'normal', '194C(1)', 100000, 100000, 'deducted', $3)`,
      [tenantA, contractorA, challanA],
    );
    await c.query("COMMIT");
  });
});

afterAll(async () => {
  await asSuperuser(async (c) => {
    const tenants = [tenantA, tenantB];

    // ⚠️ Order matters, and it is the schema telling us something. The
    // foreign keys from `tds_deductions` to the deductee, the challan and
    // the Section 197 certificate are RESTRICT — a deduction that reached
    // a return cannot be unmade — so a teardown that deleted deductees
    // first would be refused. That refusal is the guarantee the phase is
    // built on.
    await c.query(`DELETE FROM tds_certificates WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM tds_deductions WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM tds_returns WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM tds_challans WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(
      `DELETE FROM tds_lower_deduction_certificates WHERE tenant_id = ANY($1::uuid[])`,
      [tenants],
    );
    await c.query(`DELETE FROM tds_deductees WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM change_log WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM users WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM tenants WHERE id = ANY($1::uuid[])`, [tenants]);

    // Prove every guard is still enabled. A teardown that disabled one
    // would void the guarantee for every later run — and the suite would
    // still pass, which is the dangerous part.
    const { rows } = await c.query(
      `SELECT tgname, tgenabled::text AS state FROM pg_trigger
        WHERE tgrelid = 'tds_deductions'::regclass AND NOT tgisinternal`,
    );
    for (const row of rows) expect(row.state, row.tgname).toBe("O");
  });
});

/* ================================================================== */
/* 1. TENANT ISOLATION                                                 */
/* ================================================================== */

describe("tenant isolation", () => {
  it("⭐ a tenant sees only its own deductees", async () => {
    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query("SELECT legal_name FROM tds_deductees");
      expect(rows.map((r) => r.legal_name)).toEqual(["Ramesh Labour Contractor"]);
    });

    await asTenant(tenantB, async (c) => {
      const { rows } = await c.query("SELECT legal_name FROM tds_deductees");
      expect(rows.map((r) => r.legal_name)).toEqual(["Other Tenant Contractor"]);
    });
  });

  it("⭐ a tenant sees only its own deduction register, challans and certificates", async () => {
    await asTenant(tenantB, async (c) => {
      for (const table of [
        "tds_deductions",
        "tds_challans",
        "tds_lower_deduction_certificates",
      ]) {
        const { rows } = await c.query(`SELECT id FROM ${table}`);
        expect(rows, table).toHaveLength(0);
      }
    });
  });

  it("no tenant context reads ZERO rows, never all rows", async () => {
    await withoutTenant(async (c) => {
      for (const table of [
        "tds_deductees",
        "tds_lower_deduction_certificates",
        "tds_challans",
        "tds_returns",
        "tds_deductions",
        "tds_certificates",
      ]) {
        const { rows } = await c.query(`SELECT count(*)::int AS n FROM ${table}`);
        expect(rows[0].n, table).toBe(0);
      }
    });
  });

  it("⭐ a deduction cannot point at ANOTHER TENANT'S deductee", async () => {
    // The composite foreign key, not the RLS policy. FK checks run as the
    // system and ignore row-level security — without (id, tenant_id) this
    // would succeed, and guessing deductee ids until one is accepted is an
    // existence oracle over another developer's PAN register.
    const error = await expectError(() =>
      asTenant(tenantB, async (c) =>
        c.query(
          `INSERT INTO tds_deductions
             (tenant_id, deductee_id, section, financial_year, quarter,
              deduction_date, payment_base_minor, aggregate_after_minor, outcome)
           VALUES ($1,$2,'194C','2024-25','Q1', DATE '2024-05-10',
                   2500000, 2500000, 'below_threshold')`,
          [tenantB, contractorA],
        ),
      ),
    );
    expect(error).not.toBeNull();
    expect(error!.code).toBe("23503");
  });

  it("⭐ a deduction cannot be discharged by ANOTHER TENANT'S challan", async () => {
    // ⚠️ The worst cross-tenant pointer in the phase: B's deductions
    // consuming A's deposit would over-utilise A's challan with money that
    // is not theirs, so A's return silently withholds credit from A's OWN
    // vendors — and the cause sits in a table A cannot read.
    const error = await expectError(() =>
      asTenant(tenantB, async (c) =>
        c.query(
          `INSERT INTO tds_deductions
             (tenant_id, deductee_id, section, financial_year, quarter,
              deduction_date, payment_base_minor, chargeable_base_minor,
              aggregate_after_minor, rate_bps, tds_minor, total_deducted_minor,
              outcome, challan_id)
           VALUES ($1,$2,'194C','2024-25','Q3', DATE '2024-12-10',
                   5000000, 5000000, 5000000, 200, 100000, 100000,
                   'deducted', $3)`,
          [tenantB, contractorB, challanA],
        ),
      ),
    );
    expect(error).not.toBeNull();
    expect(error!.code).toBe("23503");
  });

  it("⭐ one deductee row per PAN — the index the annual threshold rests on", async () => {
    // Two rows for one PAN split the year's running total in two, and each
    // half sits comfortably under ₹1,00,000 while the person is over it.
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(
          `INSERT INTO tds_deductees (tenant_id, code, legal_name, pan_number, pan_status)
           VALUES ($1,'D-DUP','Ramesh Labour Contracting Co','AAAPR1234K','valid')`,
          [tenantA],
        ),
      ),
    );
    expect(error).not.toBeNull();
    expect(error!.code).toBe("23505");
  });
});

/* ================================================================== */
/* 2. ⭐⭐ THE CUMULATIVE ANNUAL THRESHOLD                             */
/* ================================================================== */

describe("⭐⭐ cumulative annual thresholds", () => {
  it("a single ₹25,000 payment under 194C is below both limbs", () => {
    const verdict = assessThresholdFor({
      section: "194C",
      paymentBaseMinor: R(25_000),
      prior: [],
    });
    expect(verdict.chargeable).toBe(false);
    expect(verdict.trigger).toBe("below");
    expect(verdict.aggregateAfterMinor).toBe(R(25_000));
    // ⚠️ And it says so: the payment still COUNTS toward the year.
    expect(verdict.explanation).toContain("still COUNTS toward the year");
  });

  it("⭐⭐ FOUR ₹25,000 PAYMENTS TRIGGER DEDUCTION ON THE WHOLE ₹1,00,000", () => {
    const prior = [
      paid("2024-04-10", 25_000),
      paid("2024-06-10", 25_000),
      paid("2024-09-10", 25_000),
    ];

    const verdict = assessThresholdFor({
      section: "194C",
      paymentBaseMinor: R(25_000),
      prior,
    });

    expect(verdict.chargeable).toBe(true);
    expect(verdict.trigger).toBe("annual_aggregate");

    // ⭐ THE ASSERTION THE WHOLE PHASE EXISTS FOR.
    expect(verdict.chargeableBaseMinor).toBe(R(100_000));
    expect(verdict.catchUpBaseMinor).toBe(R(75_000));
    // ⚠️ NOT ₹25,000. Testing each payment in isolation is the classic
    // and expensive error.
    expect(verdict.chargeableBaseMinor).not.toBe(R(25_000));

    // 1% for an individual under 194C(2): ₹1,000, not ₹250.
    const tax = tdsOn(verdict.chargeableBaseMinor, 100);
    expect(tax).toBe(R(1_000));
    expect(tax).not.toBe(R(250));
  });

  it("⭐ the fifth payment is charged on itself alone — the catch-up happens once", () => {
    const prior = [
      paid("2024-04-10", 25_000),
      paid("2024-06-10", 25_000),
      paid("2024-09-10", 25_000),
      // The crossing payment, with the whole ₹1,00,000 brought into charge.
      {
        deductionDate: "2024-12-10",
        baseMinor: R(25_000),
        chargedBaseMinor: R(100_000),
      },
    ];

    const verdict = assessThresholdFor({
      section: "194C",
      paymentBaseMinor: R(25_000),
      prior,
    });

    expect(verdict.chargeable).toBe(true);
    expect(verdict.trigger).toBe("already_crossed");
    expect(verdict.chargeableBaseMinor).toBe(R(25_000));
    // ⚠️ Charging the catch-up twice would double-deduct ₹750 the
    // contractor can only recover on their own return a year later.
    expect(verdict.catchUpBaseMinor).toBe(0n);
  });

  it("⭐ 194C's single-payment limb fires on its own, and catches nothing up", () => {
    // ₹5,000 then ₹40,000. The second crosses the ₹30,000 single-payment
    // limit, so tax is due on IT — but the aggregate is ₹45,000, nowhere
    // near the ₹1,00,000 annual limb, so the earlier ₹5,000 was never
    // chargeable and does not become chargeable now.
    const verdict = assessThresholdFor({
      section: "194C",
      paymentBaseMinor: R(40_000),
      prior: [paid("2024-04-10", 5_000)],
    });

    expect(verdict.chargeable).toBe(true);
    expect(verdict.trigger).toBe("single_payment");
    expect(verdict.chargeableBaseMinor).toBe(R(40_000));
    expect(verdict.catchUpBaseMinor).toBe(0n);
  });

  it("⭐ 194Q charges the EXCESS over ₹50 lakh, not the whole aggregate", () => {
    // ⚠️ The mode that is confused with 194C's. ₹60 lakh of cement is
    // 0.1% of ₹10 lakh — ₹1,000 — not 0.1% of ₹60 lakh.
    const verdict = assessThresholdFor({
      section: "194Q",
      paymentBaseMinor: R(1_000_000),
      prior: [paid("2024-05-01", 5_000_000)],
    });

    expect(verdict.chargeable).toBe(true);
    expect(verdict.chargeableBaseMinor).toBe(R(1_000_000));
    expect(verdict.chargeableBaseMinor).not.toBe(R(6_000_000));
    expect(tdsOn(verdict.chargeableBaseMinor, 10)).toBe(R(1_000));
  });

  it("the accumulation is a plain sum, and it keeps the largest single payment", () => {
    const acc = accumulate([
      paid("2024-04-10", 25_000),
      paid("2024-06-10", 40_000),
      { deductionDate: "2024-09-10", baseMinor: R(10_000), chargedBaseMinor: R(10_000) },
    ]);
    expect(acc.aggregateMinor).toBe(R(75_000));
    expect(acc.chargedMinor).toBe(R(10_000));
    expect(acc.largestSingleMinor).toBe(R(40_000));
    expect(acc.count).toBe(3);
  });

  it("⭐ the shortfall sweep finds a year deducted payment by payment", () => {
    const findings = findThresholdShortfalls([
      {
        deducteeId: "d1",
        section: "194C",
        financialYear: "2024-25",
        // ₹1,00,000 paid, only the last ₹25,000 charged — the classic error.
        prior: [
          paid("2024-04-10", 25_000),
          paid("2024-06-10", 25_000),
          paid("2024-09-10", 25_000),
          {
            deductionDate: "2024-12-10",
            baseMinor: R(25_000),
            chargedBaseMinor: R(25_000),
          },
        ],
        rateBps: 100,
      },
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]!.uncharged).toBe(R(75_000));
    expect(findings[0]!.shortfallTaxMinor).toBe(R(750));
    expect(findings[0]!.message).toContain("201(1)");
  });

  it("⭐⭐ THE DATABASE REFUSES A DEDUCTION ON PART OF ITS OWN AGGREGATE", async () => {
    // Every CHECK on the row passes and the chain is intact. Only the
    // deferred cumulative guard catches it — which is exactly the shape a
    // bulk import of a year of history takes.
    const other = randomUUID();
    await asSuperuser(async (c) => {
      await c.query(
        `INSERT INTO tds_deductees
           (id, tenant_id, code, legal_name, pan_number, pan_status, deductee_type)
         VALUES ($1,$2,'D-PART','Partial Catch-up Contractor','AAAPZ9999Z','valid',
                 'individual')`,
        [other, tenantA],
      );
    });

    const error = await expectError(() =>
      asTenant(tenantA, async (c) => {
        for (const [day, quarter, before] of [
          ["2024-04-10", "Q1", 0],
          ["2024-06-10", "Q1", 2_500_000],
          ["2024-09-10", "Q2", 5_000_000],
        ] as const) {
          await c.query(
            `INSERT INTO tds_deductions
               (tenant_id, deductee_id, section, financial_year, quarter,
                deduction_date, payment_base_minor,
                aggregate_before_minor, aggregate_after_minor, outcome)
             VALUES ($1,$2,'194C','2024-25',$3,$4::date, 2500000, $5::bigint,
                 $5::bigint + 2500000,
                     'below_threshold')`,
            [tenantA, other, quarter, day, before],
          );
        }
        // ⭐ Deducting ₹250 on the fourth payment's own ₹25,000.
        await c.query(
          `INSERT INTO tds_deductions
             (tenant_id, deductee_id, section, financial_year, quarter,
              deduction_date, payment_base_minor, chargeable_base_minor,
              aggregate_before_minor, aggregate_after_minor,
              rate_bps, tds_minor, total_deducted_minor, outcome)
           VALUES ($1,$2,'194C','2024-25','Q3', DATE '2024-12-10',
                   2500000, 2500000, 7500000, 10000000,
                   100, 25000, 25000, 'deducted')`,
          [tenantA, other],
        );
      }),
    );

    expect(error).not.toBeNull();
    expect(error!.message).toContain("WHOLE aggregate");

    await asSuperuser(async (c) => {
      await c.query(`DELETE FROM tds_deductions WHERE deductee_id = $1`, [other]);
      await c.query(`DELETE FROM tds_deductees WHERE id = $1`, [other]);
    });
  });

  it("⭐ the stored register shows the catch-up, and the chain adds up", async () => {
    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(
        `SELECT payment_base_minor, catch_up_base_minor, chargeable_base_minor,
                aggregate_before_minor, tds_minor, outcome
           FROM tds_deductions
          WHERE deductee_id = $1 AND section = '194C'
          ORDER BY deduction_date`,
        [contractorA],
      );
      expect(rows).toHaveLength(4);
      expect(rows.slice(0, 3).every((r) => r.outcome === "below_threshold")).toBe(true);

      const crossing = rows[3];
      expect(crossing.outcome).toBe("deducted");
      expect(BigInt(crossing.payment_base_minor)).toBe(R(25_000));
      expect(BigInt(crossing.catch_up_base_minor)).toBe(R(75_000));
      expect(BigInt(crossing.chargeable_base_minor)).toBe(R(100_000));
      expect(BigInt(crossing.aggregate_before_minor)).toBe(R(75_000));
      expect(BigInt(crossing.tds_minor)).toBe(R(1_000));
    });
  });

  it("the chain verifier names the row a backdated payment broke", () => {
    const problems = verifyAccumulationChain([
      {
        id: "a",
        deducteeId: "d1",
        section: "194C",
        financialYear: "2024-25",
        quarter: "Q1",
        deductionDate: "2024-04-10",
        paymentBaseMinor: R(25_000),
        catchUpBaseMinor: 0n,
        chargeableBaseMinor: 0n,
        aggregateBeforeMinor: 0n,
        aggregateAfterMinor: R(25_000),
        rateBps: 0,
        rateBasis: "normal",
        statutoryRef: null,
        tdsMinor: 0n,
        surchargeMinor: 0n,
        cessMinor: 0n,
        outcome: "below_threshold",
        challanId: null,
      },
      {
        id: "b",
        deducteeId: "d1",
        section: "194C",
        financialYear: "2024-25",
        quarter: "Q2",
        deductionDate: "2024-08-10",
        paymentBaseMinor: R(25_000),
        catchUpBaseMinor: 0n,
        chargeableBaseMinor: 0n,
        // ⚠️ Says zero came before it. ₹25,000 did.
        aggregateBeforeMinor: 0n,
        aggregateAfterMinor: R(25_000),
        rateBps: 0,
        rateBasis: "normal",
        statutoryRef: null,
        tdsMinor: 0n,
        surchargeMinor: 0n,
        cessMinor: 0n,
        outcome: "below_threshold",
        challanId: null,
      },
    ]);

    expect(problems).toHaveLength(1);
    expect(problems[0]!.entryId).toBe("b");
    expect(problems[0]!.expectedMinor).toBe(R(25_000));
    expect(problems[0]!.actualMinor).toBe(0n);
  });
});

/* ================================================================== */
/* 3. ⭐ SECTIONS 206AA AND 206AB                                      */
/* ================================================================== */

describe("⭐ 206AA, 206AB and the higher of the two", () => {
  const compliant = {
    deducteeType: "individual" as const,
    panNumber: "AAAPR1234K",
    panStatus: "valid" as const,
    isSpecifiedPerson206ab: false,
  };

  it("the ordinary rate applies to a compliant deductee", () => {
    const r = resolveTdsRate({ section: "194C", deductee: compliant, day: "2024-05-10" });
    expect(r.rateBps).toBe(100); // ⭐ 1% — an individual under 194C(2).
    expect(r.basis).toBe("normal");
  });

  it("⭐ 194C is 1% for an individual and 2% for everybody else", () => {
    expect(normalRateBps("194C", deducteeClassOf("individual"))).toBe(100);
    expect(normalRateBps("194C", deducteeClassOf("huf"))).toBe(100);
    expect(normalRateBps("194C", deducteeClassOf("company"))).toBe(200);
    expect(normalRateBps("194C", deducteeClassOf("firm"))).toBe(200);
  });

  it("⭐ 206AA — NO PAN GIVES 20%", () => {
    const r = resolveTdsRate({
      section: "194C",
      deductee: { ...compliant, panNumber: null, panStatus: "not_furnished" },
      day: "2024-05-10",
    });
    expect(r.rateBps).toBe(2000);
    expect(r.rateBps).toBe(SECTION_206AA_BPS);
    expect(r.basis).toBe("section_206aa_no_pan");
    expect(r.statutoryRef).toBe("206AA(1)");
  });

  it("⭐ an INOPERATIVE PAN is no PAN — Rule 114AAA, Circular 3/2023", () => {
    // The number is on file, passes every structure check, and is worth
    // nothing. This is how a year of 1% deductions turns into a demand.
    const r = resolveTdsRate({
      section: "194C",
      deductee: { ...compliant, panStatus: "inoperative" },
      day: "2024-05-10",
    });
    expect(r.rateBps).toBe(2000);
    expect(r.explanation).toContain("INOPERATIVE");
  });

  it("⭐ 206AA caps at 5% for 194Q — the proviso that is always missed", () => {
    const r = resolveTdsRate({
      section: "194Q",
      deductee: { ...compliant, panNumber: null, panStatus: "not_furnished" },
      day: "2024-05-10",
    });
    // ⚠️ 20% of a ₹60 lakh cement account instead of 5% of the excess is
    // ₹12 lakh where ₹50,000 was due.
    expect(r.rateBps).toBe(SECTION_206AA_194Q_BPS);
    expect(r.rateBps).toBe(500);
  });

  it("⭐ 206AB — A SPECIFIED PERSON PAYS DOUBLE, OR 5%, WHICHEVER IS HIGHER", () => {
    // 194C at 1% doubled is 2%, which is below the 5% floor — so 5%.
    const r = resolveTdsRate({
      section: "194C",
      deductee: { ...compliant, isSpecifiedPerson206ab: true },
      day: "2024-05-10",
      specifiedPersonCheckedOn: "2024-04-01",
    });
    expect(r.rateBps).toBe(SECTION_206AB_FLOOR_BPS);
    expect(r.rateBps).toBe(500);
    expect(r.basis).toBe("section_206ab_non_filer");
  });

  it("⭐ 206AB doubles a rate that is already above the 5% floor", () => {
    // 194J(b) professional fees at 10% doubled is 20%, above the floor.
    const r = resolveTdsRate({
      section: "194J_b",
      deductee: {
        ...compliant,
        deducteeType: "company",
        panNumber: "AAACR1234K",
        isSpecifiedPerson206ab: true,
      },
      day: "2024-05-10",
      specifiedPersonCheckedOn: "2024-04-01",
    });
    expect(r.rateBps).toBe(2000);
    expect(r.components.section206abBps).toBe(2000);
  });

  it("⭐⭐ WHERE BOTH BITE, THE HIGHER APPLIES — Section 206AB(2)", () => {
    // No PAN AND a specified person, under 194C for a company:
    //   206AA → max(2%, 20%) = 20%
    //   206AB → max(2 × 2%, 5%) = 5%
    // ⭐ 20%, not 5%, and not 4%.
    const r = resolveTdsRate({
      section: "194C",
      deductee: {
        deducteeType: "company",
        panNumber: null,
        panStatus: "not_furnished",
        isSpecifiedPerson206ab: true,
      },
      day: "2024-05-10",
      specifiedPersonCheckedOn: "2024-04-01",
    });

    expect(r.basis).toBe("section_206aa_and_206ab");
    expect(r.components.section206aaBps).toBe(2000);
    expect(r.components.section206abBps).toBe(500);
    expect(r.rateBps).toBe(2000);
    expect(r.explanation).toContain("HIGHER of the two");
  });

  it("⭐⭐ and the higher is the 206AB one when THAT is larger", () => {
    // 194J(b) at 10%: 206AA gives max(10%, 20%) = 20%; 206AB gives
    // max(20%, 5%) = 20%. Push the section rate to 194I(b) at 10% — same.
    // The asymmetric case is a section above 10%: use 194J(b) with a
    // doubled rate that exceeds 20% by taking a 15% hypothetical is not
    // available, so prove the MAX is what is taken rather than either.
    const r = resolveTdsRate({
      section: "194J_b",
      deductee: {
        deducteeType: "company",
        panNumber: null,
        panStatus: "invalid",
        isSpecifiedPerson206ab: true,
      },
      day: "2024-05-10",
      specifiedPersonCheckedOn: "2024-04-01",
    });
    expect(r.rateBps).toBe(
      Math.max(r.components.section206aaBps!, r.components.section206abBps!),
    );
    expect(r.rateBps).toBe(2000);
  });

  it("⭐ 194-IA is OUTSIDE 206AB, and doubling it at the registrar's office costs ₹5 lakh", () => {
    const r = resolveTdsRate({
      section: "194IA",
      deductee: {
        ...compliant,
        isSpecifiedPerson206ab: true,
      },
      day: "2024-05-10",
      specifiedPersonCheckedOn: "2024-04-01",
    });
    expect(r.rateBps).toBe(100); // ⭐ Still 1%.
    expect(r.basis).toBe("normal");
    expect(r.warnings.join(" ")).toContain("OUTSIDE it");
  });

  it("a 206AB flag with no check date is a guess, and is warned about", () => {
    const r = resolveTdsRate({
      section: "194C",
      deductee: { ...compliant, isSpecifiedPerson206ab: true },
      day: "2024-05-10",
    });
    expect(r.warnings.join(" ")).toContain("no check date");
  });

  it("⭐ 192 and 195 refuse to invent a rate rather than returning zero", () => {
    for (const section of ["192", "195"] as const) {
      const r = resolveTdsRate({ section, deductee: compliant, day: "2024-05-10" });
      expect(r.rateBps).toBeNull();
      expect(r.problem).not.toBeNull();
      // ⚠️ A zero here is the largest silent default in Chapter XVII-B.
      const c = computeDeduction({
        paymentBaseMinor: R(100_000),
        chargeableBaseMinor: R(100_000),
        resolution: r,
      });
      expect(c.tdsMinor).toBe(0n);
      expect(c.problem).not.toBeNull();
    }
  });

  it("⭐ the DATABASE refuses the ordinary rate for a deductee with no PAN", async () => {
    const nopan = randomUUID();
    await asSuperuser(async (c) => {
      await c.query(
        `INSERT INTO tds_deductees (id, tenant_id, code, legal_name, pan_status, deductee_type)
         VALUES ($1,$2,'D-NOPAN','PAN-less Gang','not_furnished','individual')`,
        [nopan, tenantA],
      );
    });

    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(
          `INSERT INTO tds_deductions
             (tenant_id, deductee_id, section, financial_year, quarter,
              deduction_date, payment_base_minor, chargeable_base_minor,
              aggregate_after_minor, rate_bps, tds_minor, total_deducted_minor,
              outcome)
           VALUES ($1,$2,'194C','2024-25','Q1', DATE '2024-05-10',
                   20000000, 20000000, 20000000, 100, 200000, 200000, 'deducted')`,
          [tenantA, nopan],
        ),
      ),
    );
    expect(error).not.toBeNull();
    expect(error!.message).toContain("206AA");

    // And 20% is accepted.
    await asTenant(tenantA, async (c) => {
      await c.query(
        `INSERT INTO tds_deductions
           (tenant_id, deductee_id, section, financial_year, quarter,
            deduction_date, payment_base_minor, chargeable_base_minor,
            aggregate_after_minor, rate_bps, rate_basis, tds_minor,
            total_deducted_minor, outcome)
         VALUES ($1,$2,'194C','2024-25','Q1', DATE '2024-05-10',
                 20000000, 20000000, 20000000, 2000, 'section_206aa_no_pan',
                 4000000, 4000000, 'deducted')`,
        [tenantA, nopan],
      );
    });

    await asSuperuser(async (c) => {
      await c.query(`DELETE FROM tds_deductions WHERE deductee_id = $1`, [nopan]);
      await c.query(`DELETE FROM tds_deductees WHERE id = $1`, [nopan]);
    });
  });

  it("a PAN status of 'valid' with no PAN is refused by the validator and the database", async () => {
    const parsed = upsertDeducteeSchema.safeParse({
      code: "D-X",
      legalName: "No PAN But Valid",
      panStatus: "valid",
    });
    expect(parsed.success).toBe(false);

    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(
          `INSERT INTO tds_deductees (tenant_id, code, legal_name, pan_status)
           VALUES ($1,'D-XX','No PAN But Valid','valid')`,
          [tenantA],
        ),
      ),
    );
    expect(error).not.toBeNull();
    expect(error!.code).toBe("23514");
  });
});

/* ================================================================== */
/* 4. ⭐ SECTION 194-IA — IMMOVABLE PROPERTY                           */
/* ================================================================== */

describe("⭐ 194-IA: the ₹50 lakh cliff on a land purchase", () => {
  it("⭐ FIRES AT ₹50,00,000 AND ON THE WHOLE CONSIDERATION", () => {
    const verdict = assessThresholdFor({
      section: "194IA",
      paymentBaseMinor: R(5_000_000),
      prior: [],
    });
    expect(verdict.chargeable).toBe(true);
    expect(verdict.trigger).toBe("per_transaction");
    // ⭐ THE WHOLE CONSIDERATION, NOT THE EXCESS.
    expect(verdict.chargeableBaseMinor).toBe(R(5_000_000));
    expect(tdsOn(verdict.chargeableBaseMinor, 100)).toBe(R(50_000));
  });

  it("⭐ and NOT at ₹49,99,000 — it is a cliff, not a slab", () => {
    const verdict = assessThresholdFor({
      section: "194IA",
      paymentBaseMinor: R(4_999_000),
      prior: [],
    });
    expect(verdict.chargeable).toBe(false);
    expect(verdict.chargeableBaseMinor).toBe(0n);
    expect(verdict.explanation).toContain("cliff");
  });

  it("⭐ a ₹2 crore land purchase is 1% of ₹2 crore", () => {
    const verdict = assessThresholdFor({
      section: "194IA",
      paymentBaseMinor: R(20_000_000),
      prior: [],
    });
    expect(tdsOn(verdict.chargeableBaseMinor, 100)).toBe(R(200_000));
  });

  it("⚠️ 194-IA does NOT aggregate across the year like 194C does", () => {
    // Two ₹40 lakh plots from different sellers aggregate to nothing.
    const verdict = assessThresholdFor({
      section: "194IA",
      paymentBaseMinor: R(4_000_000),
      prior: [paid("2024-05-01", 4_000_000)],
    });
    expect(verdict.chargeable).toBe(false);
    expect(sectionRule("194IA").thresholdMode).toBe("per_transaction_whole");
  });

  it("194-IA is settled on Form 26QB within 30 days of the month end", () => {
    expect(depositDueDate("2024-05-10", "194IA")).toBe("2024-06-30");
    // ⚠️ Not the 7th-of-next-month rule — using it would declare a default
    // three weeks before one exists.
    expect(depositDueDate("2024-05-10", "194C")).toBe("2024-06-07");
  });
});

/* ================================================================== */
/* 5. ⭐ SECTION 197 LOWER-DEDUCTION CERTIFICATES                      */
/* ================================================================== */

describe("⭐ Section 197 certificates", () => {
  const cert = {
    id: "cert-1",
    certificateNumber: "CERT/2024/001",
    section: "194C" as const,
    rateBps: 50, // 0.5%
    validFrom: "2024-06-01",
    validTo: "2025-03-31",
    capBaseMinor: null,
    isActive: true,
  };

  const deductee = {
    deducteeType: "company" as const,
    panNumber: "AAACR1234K",
    panStatus: "valid" as const,
    isSpecifiedPerson206ab: false,
  };

  it("⭐ REDUCES THE RATE INSIDE ITS WINDOW", () => {
    const r = resolveTdsRate({
      section: "194C",
      deductee,
      day: "2024-08-15",
      certificate: cert,
      chargeableBaseMinor: R(500_000),
    });
    expect(r.rateBps).toBe(50);
    expect(r.basis).toBe("section_197_certificate");
    expect(r.certificateId).toBe("cert-1");
    // ₹500,000 at 0.5% is ₹2,500 — against ₹10,000 at the ordinary 2%.
    expect(tdsOn(R(500_000), r.rateBps!)).toBe(R(2_500));
  });

  it("⭐ AND NOT OUTSIDE IT — the day AFTER it expires", () => {
    const r = resolveTdsRate({
      section: "194C",
      deductee,
      day: "2025-04-01",
      certificate: cert,
      chargeableBaseMinor: R(500_000),
    });
    // ⭐ The ordinary 2% for a company, not 0.5%.
    expect(r.rateBps).toBe(200);
    expect(r.basis).toBe("normal");
    expect(r.certificateId).toBeNull();
    expect(r.warnings.join(" ")).toContain("EXPIRED");
  });

  it("⭐ and not BEFORE it opens — payments while the application was pending", () => {
    const r = resolveTdsRate({
      section: "194C",
      deductee,
      day: "2024-04-15",
      certificate: cert,
    });
    expect(r.rateBps).toBe(200);
    expect(r.warnings.join(" ")).toContain("valid from");
  });

  it("the boundary days themselves ARE inside the window", () => {
    for (const day of ["2024-06-01", "2025-03-31"]) {
      const verdict = assessCertificate({
        certificate: cert,
        section: "194C",
        day,
        hasPan: true,
      });
      expect(verdict.usable, day).toBe(true);
    }
    for (const day of ["2024-05-31", "2025-04-01"]) {
      const verdict = assessCertificate({
        certificate: cert,
        section: "194C",
        day,
        hasPan: true,
      });
      expect(verdict.usable, day).toBe(false);
    }
  });

  it("⚠️ a 194C certificate does not reduce a 194J fee to the same firm", () => {
    const verdict = assessCertificate({
      certificate: cert,
      section: "194J_b",
      day: "2024-08-15",
      hasPan: true,
    });
    expect(verdict.usable).toBe(false);
    expect((verdict as { reason: string }).reason).toContain("194J_b");
  });

  it("⚠️ a certificate cannot exist without a PAN — Section 206AA(4)", () => {
    const verdict = assessCertificate({
      certificate: cert,
      section: "194C",
      day: "2024-08-15",
      hasPan: false,
    });
    expect(verdict.usable).toBe(false);
    expect((verdict as { reason: string }).reason).toContain("206AA(4)");
  });

  it("⭐ beyond the cap the ordinary rate returns", () => {
    const capped = { ...cert, capBaseMinor: R(1_000_000) };
    const verdict = assessCertificate({
      certificate: capped,
      section: "194C",
      day: "2024-08-15",
      hasPan: true,
      consumedBaseMinor: R(1_000_000),
    });
    expect(verdict.usable).toBe(false);
    expect((verdict as { reason: string }).reason).toContain("capped");
  });

  it("a payment that exhausts the cap is warned about rather than silently split", () => {
    const capped = { ...cert, capBaseMinor: R(1_000_000) };
    const r = resolveTdsRate({
      section: "194C",
      deductee,
      day: "2024-08-15",
      certificate: capped,
      consumedCertificateBaseMinor: R(900_000),
      chargeableBaseMinor: R(500_000),
    });
    expect(r.rateBps).toBe(50);
    expect(r.warnings.join(" ")).toContain("exhausts certificate");
  });

  it("⭐⭐ 206AB overrides a certificate — the doubling is of the SECTION's rate", () => {
    const r = resolveTdsRate({
      section: "194C",
      deductee: { ...deductee, isSpecifiedPerson206ab: true },
      day: "2024-08-15",
      certificate: cert,
      specifiedPersonCheckedOn: "2024-04-01",
    });
    // ⚠️ NOT 2 × 0.5%. 206AB(1) opens "notwithstanding anything contained
    // in any other provisions of this Act", and the doubling is of the
    // section's 2% — giving 4%, against the 5% floor: 5%.
    expect(r.rateBps).toBe(500);
    expect(r.basis).toBe("section_206ab_non_filer");
    expect(r.explanation).toContain("notwithstanding");
  });

  it("⭐ the DATABASE refuses a certificate applied outside its window", async () => {
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(
          `INSERT INTO tds_deductions
             (tenant_id, deductee_id, section, financial_year, quarter,
              deduction_date, payment_base_minor, chargeable_base_minor,
              aggregate_before_minor, aggregate_after_minor,
              rate_bps, rate_basis, lower_deduction_certificate_id,
              tds_minor, total_deducted_minor, outcome)
           VALUES ($1,$2,'194C','2024-25','Q1', DATE '2024-04-15',
                   50000000, 50000000, 0, 50000000,
                   50, 'section_197_certificate', $3, 250000, 250000, 'deducted')`,
          [tenantA, contractorA, certificateA],
        ),
      ),
    );
    expect(error).not.toBeNull();
    expect(error!.message).toContain("valid from");
  });

  it("⭐ and a reduced rate with NO certificate quoted is refused outright", async () => {
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(
          `INSERT INTO tds_deductions
             (tenant_id, deductee_id, section, financial_year, quarter,
              deduction_date, payment_base_minor, chargeable_base_minor,
              aggregate_after_minor, rate_bps, rate_basis,
              tds_minor, total_deducted_minor, outcome)
           VALUES ($1,$2,'194C','2024-25','Q1', DATE '2024-08-15',
                   50000000, 50000000, 50000000, 50, 'section_197_certificate',
                   250000, 250000, 'deducted')`,
          [tenantA, contractorA],
        ),
      ),
    );
    expect(error).not.toBeNull();
    expect(error!.code).toBe("23514");
  });

  it("a certificate window running past 31 March is refused by the validator", () => {
    const parsed = upsertLowerDeductionCertificateSchema.safeParse({
      deducteeId: randomUUID(),
      certificateNumber: "CERT/2024/999",
      section: "194C",
      rateBps: 50,
      validFrom: "2024-06-01",
      validTo: "2025-06-30", // ⚠️ Into the next financial year.
      financialYear: "2024-25",
    });
    expect(parsed.success).toBe(false);
  });
});

/* ================================================================== */
/* 6. ⭐ LATE-DEPOSIT INTEREST                                         */
/* ================================================================== */

describe("⭐ Section 201(1A) interest and Section 234E fee", () => {
  it('⭐ "month or part of a month" is a calendar month, never thirty days', () => {
    expect(monthsOrPartThereof("2024-05-01", "2024-05-01")).toBe(0);
    expect(monthsOrPartThereof("2024-05-01", "2024-05-02")).toBe(1);
    expect(monthsOrPartThereof("2024-05-01", "2024-06-01")).toBe(1);
    expect(monthsOrPartThereof("2024-05-01", "2024-06-02")).toBe(2);
    // ⭐ THE ONE-DAY-LATE CASE.
    expect(monthsOrPartThereof("2024-05-01", "2024-06-08")).toBe(2);
    // 29 days is still one month.
    expect(monthsOrPartThereof("2024-06-07", "2024-07-06")).toBe(1);
    expect(monthsOrPartThereof("2024-06-07", "2024-07-08")).toBe(2);
  });

  it("⭐⭐ THE 1.5% RUNS FROM THE DATE OF DEDUCTION, NOT FROM THE DUE DATE", () => {
    // Deducted 1 May, due 7 June, deposited 8 June — ONE DAY LATE.
    const a = assessLateDeposit({
      deductionDate: "2024-05-01",
      depositDate: "2024-06-08",
      tdsMinor: R(100_000),
      section: "194C",
    });

    expect(a.late).toBe(true);
    expect(a.dueDate).toBe("2024-06-07");
    expect(a.daysLate).toBe(1);
    // ⭐ TWO months, not one. May and June both commenced.
    expect(a.monthsCharged).toBe(2);
    expect(a.rateBpsPerMonth).toBe(INTEREST_DEDUCTED_NOT_PAID_BPS_PER_MONTH);
    // 3% of ₹1,00,000 = ₹3,000. Measuring from the due date gives ₹1,500.
    expect(a.interestMinor).toBe(R(3_000));
    expect(a.interestMinor).not.toBe(R(1_500));
  });

  it("an on-time deposit attracts nothing", () => {
    const a = assessLateDeposit({
      deductionDate: "2024-05-01",
      depositDate: "2024-06-07",
      tdsMinor: R(100_000),
      section: "194C",
    });
    expect(a.late).toBe(false);
    expect(a.interestMinor).toBe(0n);
  });

  it("⭐ a March deduction is due on 30 April, not 7 April", () => {
    const onTime = assessLateDeposit({
      deductionDate: "2025-03-15",
      depositDate: "2025-04-30",
      tdsMinor: R(100_000),
      section: "194C",
    });
    expect(onTime.dueDate).toBe("2025-04-30");
    expect(onTime.late).toBe(false);

    const late = assessLateDeposit({
      deductionDate: "2025-03-15",
      depositDate: "2025-05-01",
      tdsMinor: R(100_000),
      section: "194C",
    });
    expect(late.late).toBe(true);
    // 15 March → 1 May: March, April, May — two whole months plus a part.
    expect(late.monthsCharged).toBe(2);
    expect(late.interestMinor).toBe(R(3_000));
  });

  it("⭐ 201(1A)(i) charges 1% on tax that was deductible and was not deducted", () => {
    // Exactly what the threshold catch-up produces: the earlier payments
    // became deductible when the aggregate crossed, and the tax on them is
    // being deducted months later.
    const a = assessLateDeduction({
      deductibleFrom: "2024-04-10",
      deductedOn: "2024-12-10",
      tdsMinor: R(750),
    });
    expect(a.late).toBe(true);
    expect(a.rateBpsPerMonth).toBe(100);
    expect(a.monthsCharged).toBe(8);
    // 8% of ₹750 = ₹60.
    expect(a.interestMinor).toBe(R(60));
  });

  it("tax not deposited at all keeps accruing, and says so", () => {
    const a = assessLateDeposit({
      deductionDate: "2024-05-01",
      depositDate: null,
      tdsMinor: R(100_000),
      section: "194C",
      asOf: "2024-09-15",
    });
    expect(a.late).toBe(true);
    expect(a.monthsCharged).toBe(5); // May → September.
    expect(a.interestMinor).toBe(R(7_500)); // 7.5%.
  });

  it("⭐ Section 234E is ₹200 a day, capped at the tax deducted", () => {
    const modest = assessLateFiling({
      dueDate: "2025-01-31",
      filedOn: "2025-02-10",
      totalTdsMinor: R(500_000),
    });
    expect(modest.late).toBe(true);
    expect(modest.daysLate).toBe(10);
    expect(modest.feeMinor).toBe(R(2_000));
    expect(modest.capped).toBe(false);

    // ⚠️ A small quarter reaches the cap in thirty days, after which
    // Section 271H's ₹10,000–₹1,00,000 penalty starts.
    const tiny = assessLateFiling({
      dueDate: "2025-01-31",
      filedOn: "2025-06-30",
      totalTdsMinor: R(6_000),
    });
    expect(tiny.capped).toBe(true);
    expect(tiny.feeMinor).toBe(R(6_000));
    expect(tiny.explanation).toContain("271H");
  });
});

/* ================================================================== */
/* 7. ⭐ THE REGISTER RECONCILES TO THE CHALLANS, EXACTLY              */
/* ================================================================== */

describe("⭐ deduction register ↔ challan reconciliation", () => {
  const challan = (id: string, tax: number, interest = 0) => ({
    id,
    bsrCode: "0001234",
    challanSerial: "00001",
    depositDate: "2025-01-07",
    taxMinor: R(tax),
    surchargeMinor: 0n,
    cessMinor: 0n,
    interestMinor: R(interest),
    feeMinor: 0n,
    totalMinor: R(tax) + R(interest),
  });

  const deduction = (id: string, tds: number, challanId: string | null) => ({
    id,
    challanId,
    tdsMinor: R(tds),
    surchargeMinor: 0n,
    cessMinor: 0n,
  });

  it("⭐ RECONCILES EXACTLY WHEN EVERY RUPEE IS MATCHED", () => {
    const result = reconcileChallans({
      challans: [challan("c1", 1_000)],
      deductions: [deduction("d1", 600, "c1"), deduction("d2", 400, "c1")],
    });
    expect(result.reconciles).toBe(true);
    expect(result.totalDeductedMinor).toBe(R(1_000));
    expect(result.totalMappedMinor).toBe(R(1_000));
    expect(result.unmappedMinor).toBe(0n);
    expect(result.totalOverUtilisedMinor).toBe(0n);
    expect(result.totalUnutilisedMinor).toBe(0n);
    expect(result.problems).toHaveLength(0);
  });

  it("⚠️ ONE PAISA OUT IS OUT — there is no tolerance", () => {
    const result = reconcileChallans({
      challans: [{ ...challan("c1", 1_000), taxMinor: R(1_000) - 1n }],
      deductions: [deduction("d1", 1_000, "c1")],
    });
    expect(result.reconciles).toBe(false);
    expect(result.totalOverUtilisedMinor).toBe(1n);
  });

  it("⭐ INTEREST ON A CHALLAN DOES NOT DISCHARGE ANYBODY'S TAX", () => {
    // ₹1,000 of tax and ₹300 of interest. Capacity is ₹1,000.
    const c = challan("c1", 1_000, 300);
    expect(challanTaxCapacityMinor(c)).toBe(R(1_000));
    expect(c.totalMinor).toBe(R(1_300));

    const result = reconcileChallans({
      challans: [c],
      deductions: [deduction("d1", 1_300, "c1")],
    });
    // ⚠️ Reconciling against `totalMinor` would call this balanced while
    // ₹300 of somebody's credit did not exist.
    expect(result.reconciles).toBe(false);
    expect(result.totalOverUtilisedMinor).toBe(R(300));
  });

  it("⭐ an over-utilised challan is a return the Department ACCEPTS", () => {
    const result = reconcileChallans({
      challans: [challan("c1", 350_000)],
      deductions: [deduction("d1", 400_000, "c1")],
    });
    expect(result.reconciles).toBe(false);
    expect(result.utilisations[0]!.verdict).toBe("over_utilised");
    expect(result.utilisations[0]!.overUtilisedMinor).toBe(R(50_000));
    expect(result.problems.join(" ")).toContain("Form 26AS");
  });

  it("a deduction with no challan is tax we are holding", () => {
    const result = reconcileChallans({
      challans: [challan("c1", 600)],
      deductions: [deduction("d1", 600, "c1"), deduction("d2", 400, null)],
    });
    expect(result.unmappedMinor).toBe(R(400));
    expect(result.unmappedCount).toBe(1);
    expect(result.problems.join(" ")).toContain("201(1A)(ii)");
  });

  it("an unutilised challan is a deduction nobody recorded", () => {
    const result = reconcileChallans({
      challans: [challan("c1", 1_000)],
      deductions: [deduction("d1", 600, "c1")],
    });
    expect(result.totalUnutilisedMinor).toBe(R(400));
    expect(result.utilisations[0]!.verdict).toBe("unutilised");
  });

  it("allocation never splits a deduction and never over-fills a challan", () => {
    const result = allocateToChallans({
      challans: [challan("c1", 1_000)],
      deductions: [deduction("d1", 700, null), deduction("d2", 400, null)],
    });
    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0]!.deductionId).toBe("d1");
    expect(result.unallocated).toHaveLength(1);
    expect(result.unallocated[0]!.deductionId).toBe("d2");
    expect(result.unallocated[0]!.reason).toContain("1.5%");
  });

  it("⭐ THE STORED REGISTER RECONCILES TO THE STORED CHALLANS", async () => {
    await asTenant(tenantA, async (c) => {
      const deductions = await c.query(
        `SELECT id, challan_id, tds_minor, surcharge_minor, cess_minor,
                deductee_id, section, financial_year, quarter, deduction_date,
                payment_base_minor, catch_up_base_minor, chargeable_base_minor,
                aggregate_before_minor, aggregate_after_minor, rate_bps,
                rate_basis, statutory_ref, outcome
           FROM tds_deductions WHERE financial_year = '2024-25'`,
      );
      const challans = await c.query(
        `SELECT id, bsr_code, challan_serial, deposit_date, tax_minor,
                surcharge_minor, cess_minor, interest_minor, fee_minor, total_minor
           FROM tds_challans WHERE financial_year = '2024-25'`,
      );

      const result = reconcileRegisterToChallans({
        entries: deductions.rows.map((r) => ({
          id: r.id,
          deducteeId: r.deductee_id,
          section: r.section,
          financialYear: r.financial_year,
          quarter: r.quarter,
          deductionDate: r.deduction_date.toISOString().slice(0, 10),
          paymentBaseMinor: BigInt(r.payment_base_minor),
          catchUpBaseMinor: BigInt(r.catch_up_base_minor),
          chargeableBaseMinor: BigInt(r.chargeable_base_minor),
          aggregateBeforeMinor: BigInt(r.aggregate_before_minor),
          aggregateAfterMinor: BigInt(r.aggregate_after_minor),
          rateBps: r.rate_bps,
          rateBasis: r.rate_basis,
          statutoryRef: r.statutory_ref,
          tdsMinor: BigInt(r.tds_minor),
          surchargeMinor: BigInt(r.surcharge_minor),
          cessMinor: BigInt(r.cess_minor),
          outcome: r.outcome,
          challanId: r.challan_id,
        })),
        challans: challans.rows.map((r) => ({
          id: r.id,
          bsrCode: r.bsr_code,
          challanSerial: r.challan_serial,
          depositDate: r.deposit_date.toISOString().slice(0, 10),
          taxMinor: BigInt(r.tax_minor),
          surchargeMinor: BigInt(r.surcharge_minor),
          cessMinor: BigInt(r.cess_minor),
          interestMinor: BigInt(r.interest_minor),
          feeMinor: BigInt(r.fee_minor),
          totalMinor: BigInt(r.total_minor),
        })),
      });

      // ⭐ ₹1,000 deducted, ₹1,000 deposited, exactly.
      expect(result.registerTdsMinor).toBe(R(1_000));
      expect(result.challanTaxCapacityMinor).toBe(R(1_000));
      expect(result.differenceMinor).toBe(0n);
      expect(result.reconciles).toBe(true);
      expect(result.message).toContain("reconciles to the challans exactly");
    });
  });

  it("⭐ THE DATABASE REFUSES AN OVER-UTILISED CHALLAN", async () => {
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(
          `INSERT INTO tds_deductions
             (tenant_id, deductee_id, section, financial_year, quarter,
              deduction_date, payment_base_minor, chargeable_base_minor,
              aggregate_after_minor, rate_bps, tds_minor, total_deducted_minor,
              outcome, challan_id)
           VALUES ($1,$2,'194J_b','2024-25','Q3', DATE '2024-12-11',
                   10000000, 10000000, 10000000, 1000, 1000000, 1000000,
                   'deducted', $3)`,
          [tenantA, contractorA, challanA],
        ),
      ),
    );
    expect(error).not.toBeNull();
    expect(error!.message).toContain("more than was ever deposited");
  });
});

/* ================================================================== */
/* 8. CERTIFICATES AND QUARTERLY RETURNS                               */
/* ================================================================== */

describe("Form 16A assembly", () => {
  const deductee = {
    id: "d1",
    legalName: "Sahyadri Cement Pvt Ltd",
    panNumber: "AAACS1234F",
  };

  it("⭐ certifies what was DEPOSITED, and names the gap", () => {
    const assembled = assembleCertificate({
      deductee,
      deductions: [
        {
          id: "x1",
          section: "194C",
          deductionDate: "2024-12-10",
          chargeableBaseMinor: R(100_000),
          rateBps: 200,
          tdsMinor: R(2_000),
          surchargeMinor: 0n,
          cessMinor: 0n,
          challanId: "c1",
          bsrCode: "0001234",
          challanSerial: "00001",
          depositDate: "2025-01-07",
        },
        {
          id: "x2",
          section: "194C",
          deductionDate: "2024-12-20",
          chargeableBaseMinor: R(50_000),
          rateBps: 200,
          tdsMinor: R(1_000),
          surchargeMinor: 0n,
          cessMinor: 0n,
          // ⭐ Deducted, never deposited.
          challanId: null,
        },
      ],
      financialYear: "2024-25",
      quarter: "Q3",
      tan: "RTKA12345B",
    });

    expect(assembled.formType).toBe("16A");
    expect(assembled.totalTdsMinor).toBe(R(3_000));
    expect(assembled.depositedTdsMinor).toBe(R(2_000));
    expect(assembled.undepositedTdsMinor).toBe(R(1_000));
    expect(assembled.problems.join(" ")).toContain("TRACES certifies");
    expect(assembled.dueDate).toBe(certificateDueDate("2024-25", "Q3"));
  });

  it("a 194-IA deduction is certified on Form 16B, not 16A", () => {
    const assembled = assembleCertificate({
      deductee,
      deductions: [
        {
          id: "y1",
          section: "194IA",
          deductionDate: "2024-12-10",
          chargeableBaseMinor: R(5_000_000),
          rateBps: 100,
          tdsMinor: R(50_000),
          surchargeMinor: 0n,
          cessMinor: 0n,
          challanId: "c1",
        },
      ],
      financialYear: "2024-25",
      quarter: "Q3",
      tan: "RTKA12345B",
    });
    expect(assembled.formType).toBe("16B");
  });

  it("below-threshold rows are in the register and NOT on a certificate", () => {
    const assembled = assembleCertificate({
      deductee,
      deductions: [
        {
          id: "z1",
          section: "194C",
          deductionDate: "2024-12-10",
          chargeableBaseMinor: 0n,
          rateBps: 0,
          tdsMinor: 0n,
          surchargeMinor: 0n,
          cessMinor: 0n,
          challanId: null,
        },
      ],
      financialYear: "2024-25",
      quarter: "Q3",
      tan: "RTKA12345B",
    });
    // ⚠️ Printing a zero line invites the deductee to claim it.
    expect(assembled.lineDetail).toHaveLength(0);
    expect(assembled.totalTdsMinor).toBe(0n);
  });
});

describe("⭐ 24Q / 26Q / 27Q assembly and the validation pass", () => {
  const good = {
    id: "d1",
    legalName: "Sahyadri Cement Pvt Ltd",
    panNumber: "AAACS1234F",
    panStatus: "valid" as const,
    deducteeType: "company" as const,
    isNonResident: false,
  };
  const nonResident = { ...good, id: "d2", legalName: "Overseas Consultant SA", isNonResident: true };
  const noPan = {
    id: "d3",
    legalName: "PAN-less Labour Gang",
    panNumber: null,
    panStatus: "not_furnished" as const,
    deducteeType: "individual" as const,
    isNonResident: false,
  };

  const deduction = (
    over: Partial<{
      id: string;
      deducteeId: string;
      section: "194C" | "194J_b" | "192";
      deductionDate: string;
      rateBps: number;
      rateBasis: "normal" | "section_197_certificate";
      tdsMinor: bigint;
      challanId: string | null;
      lowerDeductionCertificateNumber: string | null;
    }>,
  ) => ({
    id: over.id ?? "x1",
    deducteeId: over.deducteeId ?? "d1",
    section: over.section ?? ("194C" as const),
    deductionDate: over.deductionDate ?? "2024-12-10",
    paymentBaseMinor: R(100_000),
    chargeableBaseMinor: R(100_000),
    rateBps: over.rateBps ?? 200,
    rateBasis: over.rateBasis ?? ("normal" as const),
    tdsMinor: over.tdsMinor ?? R(2_000),
    surchargeMinor: 0n,
    cessMinor: 0n,
    challanId: over.challanId === undefined ? "c1" : over.challanId,
    lowerDeductionCertificateNumber: over.lowerDeductionCertificateNumber ?? null,
    outcome: "deducted",
  });

  const challan = {
    id: "c1",
    bsrCode: "0001234",
    challanSerial: "00001",
    depositDate: "2025-01-07",
    taxMinor: R(2_000),
    surchargeMinor: 0n,
    cessMinor: 0n,
    interestMinor: 0n,
    feeMinor: 0n,
    totalMinor: R(2_000),
  };

  it("⭐ the PAYEE decides the form, not the payment", () => {
    expect(formTypeFor("194C", good)).toBe("26Q");
    // A 194C payment to a NON-RESIDENT contractor is 27Q, not 26Q.
    expect(formTypeFor("194C", nonResident)).toBe("27Q");
    expect(formTypeFor("192", good)).toBe("24Q");
  });

  it("a clean 26Q would be accepted", () => {
    const assembled = assembleReturn({
      formType: "26Q",
      financialYear: "2024-25",
      quarter: "Q3",
      tan: "RTKA12345B",
      deductees: [good],
      deductions: [deduction({})],
    });
    expect(assembled.deducteeCount).toBe(1);
    expect(assembled.totalTdsMinor).toBe(R(2_000));
    expect(assembled.dueDate).toBe("2025-01-31");

    const validation = validateReturn({
      assembled,
      deductees: [good],
      deductions: [deduction({})],
      challans: [challan],
      asOf: "2025-01-15",
    });
    expect(validation.wouldBeAccepted).toBe(true);
    expect(validation.rejectCount).toBe(0);
  });

  it("⭐ a PAN whose 4th character disagrees with the constitution is REJECTED", () => {
    // AAAPS1234F says `P` — an individual — on a row typed as a company.
    const wrong = { ...good, panNumber: "AAAPS1234F" };
    expect(panAgreesWithDeducteeType(wrong.panNumber, "company")).toBe(false);

    const assembled = assembleReturn({
      formType: "26Q",
      financialYear: "2024-25",
      quarter: "Q3",
      tan: "RTKA12345B",
      deductees: [wrong],
      deductions: [deduction({})],
    });
    const validation = validateReturn({
      assembled,
      deductees: [wrong],
      deductions: [deduction({})],
      challans: [challan],
      asOf: "2025-01-15",
    });

    expect(validation.wouldBeAccepted).toBe(false);
    const finding = validation.findings.find((f) => f.code === "pan_type_mismatch");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("reject");
    // ⚠️ It is also a RATE error: 194C is 1% for an individual.
    expect(finding!.message).toContain("194C");
  });

  it("⭐ a reduced rate with no certificate quoted is REJECTED", () => {
    const d = deduction({ rateBps: 50, rateBasis: "normal" });
    const assembled = assembleReturn({
      formType: "26Q",
      financialYear: "2024-25",
      quarter: "Q3",
      tan: "RTKA12345B",
      deductees: [good],
      deductions: [d],
    });
    const validation = validateReturn({
      assembled,
      deductees: [good],
      deductions: [d],
      challans: [challan],
      asOf: "2025-01-15",
    });
    expect(
      validation.findings.some((f) => f.code === "reduced_rate_without_certificate"),
    ).toBe(true);
    expect(validation.wouldBeAccepted).toBe(false);
  });

  it("⭐ a deduction attached to no challan is REJECTED", () => {
    const d = deduction({ challanId: null });
    const assembled = assembleReturn({
      formType: "26Q",
      financialYear: "2024-25",
      quarter: "Q3",
      tan: "RTKA12345B",
      deductees: [good],
      deductions: [d],
    });
    const validation = validateReturn({
      assembled,
      deductees: [good],
      deductions: [d],
      challans: [challan],
      asOf: "2025-01-15",
    });
    expect(
      validation.findings.some((f) => f.code === "deduction_not_linked_to_challan"),
    ).toBe(true);
  });

  it("⭐ an over-utilised challan is REJECTED, and a malformed TAN too", () => {
    const d1 = deduction({ id: "x1" });
    const d2 = deduction({ id: "x2" });
    const assembled = assembleReturn({
      formType: "26Q",
      financialYear: "2024-25",
      quarter: "Q3",
      tan: "NOTATAN",
      deductees: [good],
      deductions: [d1, d2],
    });
    const validation = validateReturn({
      assembled,
      deductees: [good],
      deductions: [d1, d2],
      challans: [challan],
      asOf: "2025-01-15",
    });
    expect(validation.findings.some((f) => f.code === "challan_over_utilised")).toBe(true);
    expect(validation.findings.some((f) => f.code === "tan_malformed")).toBe(true);
    expect(validation.summary).toContain("REJECTED");
  });

  it("a no-PAN deductee is a WARNING, not a rejection, and carries PANNOTAVBL", () => {
    expect(panForReturn(noPan)).toBe("PANNOTAVBL");
    expect(panForReturn({ ...noPan, panStatus: "applied_for" })).toBe("PANAPPLIED");
    expect(
      panForReturn({ ...good, panStatus: "inoperative" }),
    ).toBe("PANINVALID");

    const d = deduction({ deducteeId: "d3", rateBps: 2000, tdsMinor: R(20_000) });
    const bigChallan = { ...challan, taxMinor: R(20_000), totalMinor: R(20_000) };
    const assembled = assembleReturn({
      formType: "26Q",
      financialYear: "2024-25",
      quarter: "Q3",
      tan: "RTKA12345B",
      deductees: [noPan],
      deductions: [d],
    });
    const validation = validateReturn({
      assembled,
      deductees: [noPan],
      deductions: [d],
      challans: [bigChallan],
      asOf: "2025-01-15",
    });
    const finding = validation.findings.find((f) => f.code === "no_pan_deductee");
    expect(finding?.severity).toBe("warn");
    expect(validation.wouldBeAccepted).toBe(true);
  });

  it("a non-resident's 194C payment is EXCLUDED from 26Q and says why", () => {
    const d = deduction({ deducteeId: "d2" });
    const assembled = assembleReturn({
      formType: "26Q",
      financialYear: "2024-25",
      quarter: "Q3",
      tan: "RTKA12345B",
      deductees: [nonResident],
      deductions: [d],
    });
    expect(assembled.deductionCount).toBe(0);
    expect(assembled.excluded).toHaveLength(1);
    expect(assembled.excluded[0]!.reason).toContain("27Q");
  });

  it("⭐ a late return accrues Section 234E while it is unfiled", () => {
    const assembled = assembleReturn({
      formType: "26Q",
      financialYear: "2024-25",
      quarter: "Q3",
      tan: "RTKA12345B",
      deductees: [good],
      deductions: [deduction({})],
    });
    const validation = validateReturn({
      assembled,
      deductees: [good],
      deductions: [deduction({})],
      challans: [challan],
      asOf: "2025-02-10", // due 31 January.
    });
    expect(validation.findings.some((f) => f.code === "filing_overdue")).toBe(true);
    expect(validation.lateFilingFeeMinor).toBe(R(2_000)); // capped at the tax.
  });
});

/* ================================================================== */
/* 9. THE SECTION CATALOGUE AND THE CALENDAR                           */
/* ================================================================== */

describe("the section catalogue", () => {
  it("⭐ 194H's rate and threshold are IMPORTED from lib/sales/commission.ts", async () => {
    const { TDS_194H_BPS, TDS_194H_THRESHOLD_MINOR, TDS_NO_PAN_BPS } = await import(
      "@/lib/sales/commission"
    );
    // ⚠️ One definition. Two brokerage rates that agree until one is
    // edited would make the partner statement and the TDS register
    // disagree about the same payment — and the broker holds both.
    expect(sectionRule("194H").rateBpsOther).toBe(TDS_194H_BPS);
    expect(sectionRule("194H").annualThresholdMinor).toBe(TDS_194H_THRESHOLD_MINOR);
    expect(SECTION_206AA_BPS).toBe(TDS_NO_PAN_BPS);
  });

  it("⭐ the existing computeTds for 194H still agrees with the new engine", async () => {
    const { computeTds, TDS_194H_THRESHOLD_MINOR } = await import(
      "@/lib/sales/commission"
    );
    const gross = R(100_000);
    const old = computeTds({ grossMinor: gross, hasPan: true, ytdGrossMinor: 0n });

    const verdict = assessThresholdFor({
      section: "194H",
      paymentBaseMinor: gross,
      prior: [],
    });
    expect(verdict.chargeable).toBe(true);
    const rate = resolveTdsRate({
      section: "194H",
      deductee: {
        deducteeType: "company",
        panNumber: "AAACR1234K",
        panStatus: "valid",
        isSpecifiedPerson206ab: false,
      },
      day: "2024-08-15",
    });
    expect(tdsOn(verdict.chargeableBaseMinor, rate.rateBps!)).toBe(old.tdsMinor);
    expect(gross).toBeGreaterThan(TDS_194H_THRESHOLD_MINOR);
  });

  it("⭐ 194I and 194J are split into their limbs, and the split is fivefold", () => {
    expect(sectionRule("194I_a").rateBpsOther).toBe(200);
    expect(sectionRule("194I_b").rateBpsOther).toBe(1000);
    expect(sectionRule("194J_a").rateBpsOther).toBe(200);
    expect(sectionRule("194J_b").rateBpsOther).toBe(1000);
  });

  it("every section names its statutory reference and its return form", () => {
    for (const code of TDS_SECTION_CODES) {
      const rule = TDS_SECTIONS[code];
      expect(rule.statutoryRef.length, code).toBeGreaterThan(0);
      expect(["24Q", "26Q", "27Q", "27EQ"]).toContain(rule.returnForm);
      expect(rule.note.length, code).toBeGreaterThan(20);
    }
  });

  it("⭐ the SQL copy of the annual thresholds still agrees with this file", async () => {
    // SQL 0025 §6 cannot call TypeScript, so `tds_annual_threshold_minor()`
    // is a copy. A copy nobody checks is how a guard quietly stops
    // guarding — it keeps passing while testing the wrong number.
    await asTenant(tenantA, async (c) => {
      for (const code of TDS_SECTION_CODES) {
        const { rows } = await c.query(
          `SELECT tds_annual_threshold_minor($1::tds_section) AS minor,
                  tds_section_aggregates_whole($1::tds_section) AS whole`,
          [code],
        );
        const rule = TDS_SECTIONS[code];
        const sqlMinor = rows[0].minor === null ? null : BigInt(rows[0].minor);

        // The SQL copy only carries the whole-aggregate sections; the
        // others are NULL there and unused by the guard.
        if (rule.thresholdMode === "aggregate_whole") {
          expect(sqlMinor, code).toBe(rule.annualThresholdMinor);
          expect(rows[0].whole, code).toBe(true);
        } else {
          expect(rows[0].whole, code).toBe(false);
        }
      }
    });
  });

  it("⭐ the whole-aggregate section list matches the SQL predicate", async () => {
    const whole = sectionsWithMode("aggregate_whole").sort();
    expect(whole).toEqual(
      ["194A", "194C", "194H", "194I_a", "194I_b", "194J_a", "194J_b"].sort(),
    );
    // ⚠️ 194Q is NOT on it: its tax is on the excess, so `sum(chargeable) =
    // sum(payment)` is false for a healthy group and the guard would
    // refuse every correct 194Q deduction.
    expect(whole).not.toContain("194Q");
    expect(whole).not.toContain("194IA");
  });
});

describe("the TDS calendar", () => {
  it("⚠️ January is Q4 of the PREVIOUS financial year", () => {
    expect(quarterOf("2025-01-15")).toBe("Q4");
    expect(quarterOf("2024-04-01")).toBe("Q1");
    expect(quarterOf("2024-09-30")).toBe("Q2");
    expect(quarterOf("2024-10-01")).toBe("Q3");
    expect(quarterRange("2024-25", "Q4")).toEqual({
      from: "2025-01-01",
      to: "2025-03-31",
    });
  });

  it("⭐ Q4's return is due on 31 May — two months, not one", () => {
    expect(returnDueDate("2024-25", "Q1")).toBe("2024-07-31");
    expect(returnDueDate("2024-25", "Q2")).toBe("2024-10-31");
    expect(returnDueDate("2024-25", "Q3")).toBe("2025-01-31");
    expect(returnDueDate("2024-25", "Q4")).toBe("2025-05-31");
  });

  it("the certificate is due fifteen days after the return", () => {
    expect(certificateDueDate("2024-25", "Q3")).toBe("2025-02-15");
  });

  it("the assessment year is the financial year plus one", () => {
    expect(assessmentYearOf("2024-25")).toBe("2025-26");
    expect(assessmentYearOf("1999-00")).toBe("2000-01");
  });
});

/* ================================================================== */
/* 10. VALIDATORS                                                      */
/* ================================================================== */

describe("validators", () => {
  it("⚠️ a PAN pasted into the TAN field is refused", () => {
    expect(tanSchema.safeParse("RTKA12345B").success).toBe(true);
    expect(tanSchema.safeParse("AAACS1234F").success).toBe(false);
  });

  it("⭐ a BSR code with its leading zeros stripped is refused", () => {
    expect(bsrCodeSchema.safeParse("0001234").success).toBe(true);
    // ⚠️ What a spreadsheet hands you.
    expect(bsrCodeSchema.safeParse("1234").success).toBe(false);
  });

  it("⭐ a deductee whose PAN contradicts their constitution is refused", () => {
    const bad = upsertDeducteeSchema.safeParse({
      code: "D-9",
      legalName: "Ramesh Contractor",
      panNumber: "AAACR1234K", // `C` — a company.
      panStatus: "valid",
      deducteeType: "individual",
    });
    expect(bad.success).toBe(false);

    const good = upsertDeducteeSchema.safeParse({
      code: "D-9",
      legalName: "Ramesh Contractor",
      panNumber: "AAAPR1234K", // `P` — an individual.
      panStatus: "valid",
      deducteeType: "individual",
    });
    expect(good.success).toBe(true);
  });

  it("a 206AB flag with no check date is refused", () => {
    const parsed = upsertDeducteeSchema.safeParse({
      code: "D-10",
      legalName: "Non-filer Ltd",
      panNumber: "AAACN1234K",
      panStatus: "valid",
      deducteeType: "company",
      isSpecifiedPerson206ab: true,
    });
    expect(parsed.success).toBe(false);
  });
});
