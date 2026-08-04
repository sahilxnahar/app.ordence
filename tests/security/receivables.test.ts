/**
 * Ordence — ⭐ Receivables & Demand Notices (Phase 38)
 * Version: v0.38.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE IS ACTUALLY TRYING TO PROVE
 * ══════════════════════════════════════════════════════════════════════
 * Thirty-seven phases say the same thing: the defects that survive are
 * the SILENT ones. This phase is silent in a way that ends in front of a
 * regulator, because everything it produces is a legal document served on
 * a member of the public.
 *
 *   • ⭐⭐ AN ALLOCATION THAT DOES NOT SUM. A buyer pays ₹5,00,000 against
 *     three demands. Two paise evaporate in a division, or the account is
 *     over-applied by one. Nothing errors — the receipt says ₹5,00,000,
 *     each demand says "part paid" — and it is found a year later by
 *     whoever prepares a statement for a buyer already in dispute.
 *
 *   • ⭐⭐ INTEREST THAT COMPOUNDS SILENTLY. ₹10,00,000 held a year at 18%
 *     is ₹1,80,000 simple and ₹1,95,618 compounded monthly. Charging one
 *     while the notice implies the other is a default in a config file,
 *     and it is indefensible precisely because the document is silent.
 *
 *   • ⭐⭐ A SKIPPED RUNG. A cancellation warning to somebody who never
 *     received a first notice hands them a complete answer, with the
 *     developer's own system as the evidence against them.
 *
 *   • ⭐ AN OFF-BY-ONE IN AN AGEING BUCKET. A demand that belongs in
 *     61-90 sitting in 31-60 is one that never reaches the escalation
 *     list, so it is never chased, so it ages another month.
 *
 *   • ⭐ A NOTICE IN A LANGUAGE THE BUYER CANNOT READ — or worse, one
 *     whose amount in words says a different number to its figures. On an
 *     Indian financial document the WORDS conventionally prevail.
 *
 * So the tests below do not inspect constraints. They split awkward
 * amounts across demands and demand exactness to the paisa. They compute
 * a year of interest four ways. They walk every boundary day of every
 * bucket. They render all six languages and put a script tag and a
 * template placeholder into a buyer's name.
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
  formatPaise,
  formatRupees,
  formatRateBps,
  groupIndian,
  amountInWordsEnglish,
  amountInWordsHindi,
  integerInWordsEnglish,
} from "@/lib/receivables/numbers";
import {
  accrueInterest,
  assessInterestRate,
  addDays,
  addMonths,
  dayCountDays,
  daysBetween,
  describeInterestBasis,
  simpleInterestMinor,
  ABSURD_RATE_BPS,
  type InterestTerms,
} from "@/lib/receivables/interest";
import {
  AGEING_BUCKETS,
  ageReceivables,
  bucketForDaysOverdue,
  bucketFor,
  daysOverdue,
} from "@/lib/receivables/ageing";
import {
  allocateReceipt,
  releaseOnBounce,
  AllocationError,
  type OpenDemand,
} from "@/lib/receivables/allocation";
import {
  DUNNING_LADDER,
  canEscalate,
  ladderSchedule,
  nextSweepAction,
  nextStage,
  rungOf,
  validateDunningPolicy,
  DEFAULT_DUNNING_POLICY,
} from "@/lib/receivables/dunning";
import { buildDemand, demandPosition } from "@/lib/receivables/demand";
import { buildStatement, StatementImbalanceError } from "@/lib/receivables/statement";
import {
  escapeHtml,
  renderTemplate,
  sanitiseValue,
  TemplateRenderError,
  unknownPlaceholders,
} from "@/lib/receivables/render";
import {
  NOTICE_PACKS,
  NOTICE_PLACEHOLDERS,
  SUPPORTED_LANGUAGES,
  amountInWordsFor,
  assertAllPacks,
  buildInterestBasisNote,
  languagesWithAmountWords,
  normaliseLanguage,
  renderDemandNotice,
  renderDunningLetter,
  type NoticeFacts,
} from "@/lib/receivables/templates";

/* ================================================================== */
/* FIXTURES                                                            */
/* ================================================================== */

const tenantA = randomUUID();
const tenantB = randomUUID();
const userA = randomUUID();
const projectA = randomUUID();
const projectB = randomUUID();
const unitA = randomUUID();
const unitB = randomUUID();
const bookingA = randomUUID();
const bookingB = randomUUID();
const leadA = randomUUID();

const msA1 = randomUUID();
const msA2 = randomUUID();
const msA3 = randomUUID();
const msB1 = randomUUID();

const demandA1 = randomUUID();
const demandA2 = randomUUID();
const demandA3 = randomUUID();
const demandB1 = randomUUID();

const receiptA = randomUUID();
const receiptB = randomUUID();

/** ₹ → paise, exactly. */
const R = (rupees: number): bigint => BigInt(Math.round(rupees * 100));

const BASIS = "Interest at 11.10% per annum, simple, from the due date.";

beforeAll(async () => {
  await asSuperuser(async (c) => {
    await c.query(
      `INSERT INTO tenants (id, clerk_org_id, slug, name, status, plan_tier)
       VALUES ($1,$2,$3,'Receivables A','active','enterprise'),
              ($4,$5,$6,'Receivables B','active','enterprise')`,
      [
        tenantA,
        `org_recvA_${tenantA}`,
        `recva-${tenantA.slice(0, 8)}`,
        tenantB,
        `org_recvB_${tenantB}`,
        `recvb-${tenantB.slice(0, 8)}`,
      ],
    );

    await c.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, status)
       VALUES ($1,$2,$3,'collections@a.test','tenant_admin','active')`,
      [userA, tenantA, `user_recvA_${userA}`],
    );

    await c.query(
      `INSERT INTO projects (id, tenant_id, code, name, state)
       VALUES ($1,$2,'AH1','Ordence Phase 1','Karnataka'),
              ($3,$4,'BH1','Other Developer Tower','Maharashtra')`,
      [projectA, tenantA, projectB, tenantB],
    );

    await c.query(
      `INSERT INTO units (id, tenant_id, project_id, code, tower)
       VALUES ($1,$2,$3,'1203','A'), ($4,$5,$6,'0904','B')`,
      [unitA, tenantA, projectA, unitB, tenantB, projectB],
    );

    // ⭐ `preferred_lang` is Kannada — the column that has said since
    // Phase 22 why this whole phase exists.
    await c.query(
      `INSERT INTO leads (id, tenant_id, reference, name, email, preferred_lang)
       VALUES ($1,$2,'LEAD-9001','Sunitha Rao','sunitha@example.com','kn-IN')`,
      [leadA, tenantA],
    );

    await c.query(
      `INSERT INTO bookings (id, tenant_id, reference, unit_id, lead_id, agreement_value_minor)
       VALUES ($1,$2,'BKG-9001',$3,$4,$5), ($6,$7,'BKG-9002',$8,NULL,$9)`,
      [
        bookingA,
        tenantA,
        unitA,
        leadA,
        R(90_00_000).toString(),
        bookingB,
        tenantB,
        unitB,
        R(75_00_000).toString(),
      ],
    );

    await c.query(
      `INSERT INTO payment_milestones (id, tenant_id, booking_id, label, amount_minor, sequence)
       VALUES ($1,$2,$3,'On completion of 3rd slab',$4,1),
              ($5,$6,$7,'On completion of 7th slab',$8,2),
              ($9,$10,$11,'On offer of possession',$12,3),
              ($13,$14,$15,'On booking',$16,1)`,
      [
        msA1, tenantA, bookingA, R(4_08_261.32).toString(),
        msA2, tenantA, bookingA, R(91_829.15).toString(),
        msA3, tenantA, bookingA, R(10_501.35).toString(),
        msB1, tenantB, bookingB, R(7_50_000).toString(),
      ],
    );

    /* --- Three issued demands on A, one on B. ------------------- */
    await c.query(
      `INSERT INTO demand_notices
         (id, tenant_id, notice_number, booking_id, milestone_id, project_id, lead_id,
          status, trigger_kind, trigger_label, trigger_achieved_on, notice_date,
          due_date, principal_minor, gst_rate_bps, cgst_minor, sgst_minor, tax_minor,
          total_minor, interest_rate_bps, reference_rate_bps, interest_basis_note,
          language, issued_at)
       VALUES
         ($1,$2,'DN/2026-27/0001',$3,$4,$5,$6,'issued','construction_event',
          'On completion of 3rd slab', DATE '2026-01-10', DATE '2026-01-12',
          DATE '2026-01-27', $7, 500, $8, $8, $9, $10, 1110, 1110, $11, 'kn', now()),
         ($12,$2,'DN/2026-27/0002',$3,$13,$5,$6,'issued','construction_event',
          'On completion of 7th slab', DATE '2026-02-10', DATE '2026-02-12',
          DATE '2026-02-27', $14, 500, $15, $15, $16, $17, 1110, 1110, $11, 'kn', now()),
         ($18,$2,'DN/2026-27/0003',$3,$19,$5,$6,'issued','possession',
          'On offer of possession', DATE '2026-03-10', DATE '2026-03-12',
          DATE '2026-03-27', $20, 500, $21, $21, $22, $23, 1110, 1110, $11, 'kn', now())`,
      [
        demandA1, tenantA, bookingA, msA1, projectA, leadA,
        // D1 — ₹3,88,824.13 principal, 5% GST split 2.5/2.5
        "38882413", "972060", "1944120", "40826533",
        BASIS,
        demandA2, msA2,
        "8745633", "218641", "437282", "9182915",
        demandA3, msA3,
        "999999", "25000", "50000", "1049999",
      ],
    );

    await c.query(
      `INSERT INTO demand_notices
         (id, tenant_id, notice_number, booking_id, milestone_id, project_id,
          status, trigger_kind, trigger_label, trigger_achieved_on, notice_date,
          due_date, principal_minor, total_minor, interest_basis_note, issued_at)
       VALUES ($1,$2,'DN/2026-27/0001',$3,$4,$5,'issued','booking_event',
               'On booking', DATE '2026-01-05', DATE '2026-01-06', DATE '2026-01-21',
               $6, $6, $7, now())`,
      [demandB1, tenantB, bookingB, msB1, projectB, R(7_50_000).toString(), BASIS],
    );

    /* --- One receipt each, unallocated, so tests can allocate. --- */
    await c.query(
      `INSERT INTO receipts
         (id, tenant_id, receipt_number, booking_id, project_id, lead_id, received_on,
          amount_minor, allocated_minor, method, status)
       VALUES ($1,$2,'RCP/2026-27/0001',$3,$4,$5, DATE '2026-03-01', $6, 0, 'neft','cleared')`,
      [receiptA, tenantA, bookingA, projectA, leadA, R(5_00_000).toString()],
    );
    await c.query(
      `INSERT INTO receipts
         (id, tenant_id, receipt_number, booking_id, project_id, received_on,
          amount_minor, allocated_minor, method, status)
       VALUES ($1,$2,'RCP/2026-27/0001',$3,$4, DATE '2026-03-01', $5, 0, 'rtgs','cleared')`,
      [receiptB, tenantB, bookingB, projectB, R(1_00_000).toString()],
    );

    /* --- A ladder on B's demand, so isolation has something to hide. */
    await c.query(
      `INSERT INTO dunning_events
         (tenant_id, demand_id, stage, rung, channel, days_overdue, outstanding_minor)
       VALUES ($1,$2,'reminder',1,'email',5,$3)`,
      [tenantB, demandB1, R(7_50_000).toString()],
    );

    await c.query(
      `INSERT INTO receivable_policies (tenant_id, name, interest_rate_bps, reference_rate_bps)
       VALUES ($1,'Default',1110,1110), ($2,'Aggressive',2400,1110)`,
      [tenantA, tenantB],
    );
    await c.query(
      `INSERT INTO dunning_policies (tenant_id, name)
       VALUES ($1,'Standard ladder'), ($2,'Standard ladder')`,
      [tenantA, tenantB],
    );
  });
});

afterAll(async () => {
  await asSuperuser(async (c) => {
    await c.query(`DELETE FROM tenants WHERE id = ANY($1::uuid[])`, [[tenantA, tenantB]]);
  });
});

/* ================================================================== */
/* 1. CROSS-TENANT ISOLATION                                           */
/* ================================================================== */

describe("cross-tenant isolation", () => {
  const TABLES = [
    "receivable_policies",
    "dunning_policies",
    "demand_notices",
    "demand_notice_documents",
    "dunning_events",
    "receipts",
    "receipt_allocations",
  ];

  it("a workspace sees only its own receivables rows on every table", async () => {
    for (const table of TABLES) {
      const leaked = await asTenant(tenantA, async (c) => {
        const { rows } = await c.query(
          `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id <> $1`,
          [tenantA],
        );
        return rows[0]?.n ?? -1;
      });
      expect(leaked, `${table} leaked rows to another tenant`).toBe(0);
    }
  });

  it("⭐ A cannot read B's demands even by naming the id — a demand is what B is owed, by whom, and how late", async () => {
    const rows = await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(
        `SELECT notice_number, total_minor FROM demand_notices WHERE id = $1`,
        [demandB1],
      );
      return rows;
    });
    expect(rows).toHaveLength(0);
  });

  it("⭐ A cannot read B's receipts — together with the demands they are B's entire cash position", async () => {
    const rows = await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(`SELECT id FROM receipts WHERE tenant_id = $1`, [
        tenantB,
      ]);
      return rows;
    });
    expect(rows).toHaveLength(0);
  });

  it("⚠️ A cannot read B's dunning events — a list of named people in financial difficulty", async () => {
    const rows = await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(`SELECT id FROM dunning_events WHERE demand_id = $1`, [
        demandB1,
      ]);
      return rows;
    });
    expect(rows).toHaveLength(0);
  });

  it("no tenant context reads ZERO rows, never all rows", async () => {
    const counts = await withoutTenant(async (c) => {
      const { rows } = await c.query(
        `SELECT (SELECT count(*)::int FROM demand_notices) AS d,
                (SELECT count(*)::int FROM receipts)       AS r,
                (SELECT count(*)::int FROM dunning_events) AS e`,
      );
      return rows[0];
    });
    expect(counts.d).toBe(0);
    expect(counts.r).toBe(0);
    expect(counts.e).toBe(0);
  });

  it("A cannot plant a demand stamped with B's tenant id (WITH CHECK)", async () => {
    const error = await expectError(() =>
      asTenant(tenantA, async (c) => {
        await c.query(
          `INSERT INTO demand_notices
             (tenant_id, notice_number, booking_id, milestone_id, status, trigger_kind,
              trigger_label, trigger_achieved_on, notice_date, due_date,
              principal_minor, total_minor, interest_basis_note)
           VALUES ($1,'DN/EVIL/0001',$2,$3,'draft','construction_event','Slab',
                   DATE '2026-01-01', DATE '2026-01-02', DATE '2026-01-17', 1000, 1000, $4)`,
          [tenantB, bookingB, msB1, BASIS],
        );
      }),
    );
    expect(error).not.toBeNull();
  });

  it("⭐ A cannot raise a demand against B's milestone — the notice would state a construction event from a building A does not own", async () => {
    const error = await expectError(() =>
      asTenant(tenantA, async (c) => {
        await c.query(
          `INSERT INTO demand_notices
             (tenant_id, notice_number, booking_id, milestone_id, status, trigger_kind,
              trigger_label, trigger_achieved_on, notice_date, due_date,
              principal_minor, total_minor, interest_basis_note)
           VALUES ($1,'DN/CROSS/0001',$2,$3,'draft','construction_event','Slab',
                   DATE '2026-01-01', DATE '2026-01-02', DATE '2026-01-17', 1000, 1000, $4)`,
          [tenantA, bookingA, msB1, BASIS],
        );
      }),
    );
    expect(error).not.toBeNull();
    expect(error?.code).toBe("23503");
  });

  it("⭐⭐ A cannot apply its money against B's demand", async () => {
    const error = await expectError(() =>
      asTenant(tenantA, async (c) => {
        await c.query(
          `INSERT INTO receipt_allocations
             (tenant_id, receipt_id, demand_id, sequence, principal_minor, amount_minor,
              basis, explanation)
           VALUES ($1,$2,$3,1,1000,1000,'oldest_first','Cross-tenant')`,
          [tenantA, receiptA, demandB1],
        );
      }),
    );
    expect(error).not.toBeNull();
  });

  it("⚠️ the application role cannot DELETE a demand, a receipt or a rung of the ladder", async () => {
    for (const table of ["demand_notices", "receipts", "dunning_events", "demand_notice_documents"]) {
      const error = await expectError(() =>
        asTenant(tenantA, async (c) => {
          await c.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantA]);
        }),
      );
      expect(error, `${table} is deletable by the application role`).not.toBeNull();
      expect(error?.code).toBe("42501");
    }
  });
});

/* ================================================================== */
/* 2. ⭐⭐ RECEIPT ALLOCATION — EXACT, FOR AWKWARD AMOUNTS              */
/* ================================================================== */

describe("⭐⭐ receipt allocation across several demands", () => {
  /**
   * Three demands whose amounts are deliberately horrible: a principal
   * that is not a round rupee, a 5% GST on it that does not divide, and
   * accrued interest on two of the three.
   */
  const DEMANDS: OpenDemand[] = [
    {
      demandId: "d1",
      noticeNumber: "DN/2026-27/0001",
      dueDate: "2026-01-27",
      outstandingPrincipalMinor: 38_882_413n,
      outstandingTaxMinor: 1_944_120n,
      outstandingInterestMinor: 143_217n,
    },
    {
      demandId: "d2",
      noticeNumber: "DN/2026-27/0002",
      dueDate: "2026-02-27",
      outstandingPrincipalMinor: 8_745_633n,
      outstandingTaxMinor: 437_282n,
      outstandingInterestMinor: 0n,
    },
    {
      demandId: "d3",
      noticeNumber: "DN/2026-27/0003",
      dueDate: "2026-03-27",
      outstandingPrincipalMinor: 999_999n,
      outstandingTaxMinor: 50_000n,
      outstandingInterestMinor: 137n,
    },
  ];

  const totalDue = DEMANDS.reduce(
    (sum, d) =>
      sum +
      d.outstandingPrincipalMinor +
      d.outstandingTaxMinor +
      d.outstandingInterestMinor,
    0n,
  );

  it("⭐⭐ ₹5,00,000 against three demands sums EXACTLY", () => {
    const result = allocateReceipt({
      receiptNumber: "RCP/2026-27/0001",
      amountMinor: 50_000_000n,
      receivedOn: "2026-03-01",
      demands: DEMANDS,
      strategy: "oldest_first",
      appropriationOrder: "interest_first",
    });

    const applied = result.lines.reduce((sum, l) => sum + l.amountMinor, 0n);
    expect(applied + result.creditMinor).toBe(50_000_000n);
    expect(result.totalAllocatedMinor).toBe(applied);

    // The oldest demand is cleared whole; the second takes the balance.
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0]?.amountMinor).toBe(40_969_750n);
    expect(result.lines[0]?.settlesDemand).toBe(true);
    expect(result.lines[1]?.amountMinor).toBe(9_030_250n);
    expect(result.lines[1]?.settlesDemand).toBe(false);
    expect(result.creditMinor).toBe(0n);
  });

  it("⭐⭐ every line's legs sum to its own total, and every leg is non-negative", () => {
    const result = allocateReceipt({
      receiptNumber: "RCP/2026-27/0001",
      amountMinor: 50_000_000n,
      receivedOn: "2026-03-01",
      demands: DEMANDS,
      strategy: "oldest_first",
      appropriationOrder: "interest_first",
    });

    for (const line of result.lines) {
      expect(line.principalMinor + line.taxMinor + line.interestMinor).toBe(
        line.amountMinor,
      );
      expect(line.principalMinor >= 0n).toBe(true);
      expect(line.taxMinor >= 0n).toBe(true);
      expect(line.interestMinor >= 0n).toBe(true);
      expect(line.amountMinor > 0n).toBe(true);
    }
  });

  it("⭐⭐ EVERY receipt amount from 1 paisa to the whole account sums exactly", () => {
    // ⚠️ NOT THREE HAND-PICKED CASES. Awkward amounts are the point: a
    // prime number of paise, one paisa either side of every boundary, and
    // amounts that divide unevenly into a 5% GST split.
    const amounts = [
      1n,
      7n,
      99n,
      100n,
      1_000_001n,
      12_345_679n,
      33_333_333n,
      40_969_749n,
      40_969_750n,
      40_969_751n,
      50_000_000n,
      totalDue - 1n,
      totalDue,
      totalDue + 1n,
      100_000_000n,
    ];

    for (const amount of amounts) {
      for (const order of ["interest_first", "principal_first"] as const) {
        const result = allocateReceipt({
          receiptNumber: "RCP/TEST",
          amountMinor: amount,
          receivedOn: "2026-03-01",
          demands: DEMANDS,
          strategy: "oldest_first",
          appropriationOrder: order,
        });

        const applied = result.lines.reduce((sum, l) => sum + l.amountMinor, 0n);

        expect(
          applied + result.creditMinor,
          `₹${formatPaise(amount)} (${order}) did not reconcile`,
        ).toBe(amount);
        expect(result.creditMinor >= 0n).toBe(true);
        // Never more than is owed.
        expect(applied <= totalDue).toBe(true);

        for (const line of result.lines) {
          expect(line.principalMinor + line.taxMinor + line.interestMinor).toBe(
            line.amountMinor,
          );
        }
      }
    }
  });

  it("⭐ a payment that clears a demand exactly settles ITS TAX exactly — no stray paisa of GST", () => {
    const only: OpenDemand[] = [DEMANDS[1] as OpenDemand];
    const due =
      only[0]!.outstandingPrincipalMinor + only[0]!.outstandingTaxMinor;

    const result = allocateReceipt({
      receiptNumber: "RCP/EXACT",
      amountMinor: due,
      receivedOn: "2026-03-01",
      demands: only,
      strategy: "oldest_first",
      appropriationOrder: "interest_first",
    });

    expect(result.lines[0]?.principalMinor).toBe(only[0]!.outstandingPrincipalMinor);
    expect(result.lines[0]?.taxMinor).toBe(only[0]!.outstandingTaxMinor);
    expect(result.creditMinor).toBe(0n);
  });

  it("⭐ an OVER-payment becomes a credit, never an over-application", () => {
    const result = allocateReceipt({
      receiptNumber: "RCP/OVER",
      amountMinor: totalDue + 987_654n,
      receivedOn: "2026-03-01",
      demands: DEMANDS,
      strategy: "oldest_first",
      appropriationOrder: "interest_first",
    });

    expect(result.totalAllocatedMinor).toBe(totalDue);
    expect(result.creditMinor).toBe(987_654n);
    expect(result.narrative.join("\n")).toContain("credit");
  });

  it("⭐ Section 194-IA: the tax the BUYER withheld settles the demand too", () => {
    // A ₹10,000 demand paid as ₹9,900 in the bank plus ₹100 withheld.
    const demand: OpenDemand[] = [
      {
        demandId: "tds",
        noticeNumber: "DN/TDS/0001",
        dueDate: "2026-01-27",
        outstandingPrincipalMinor: 1_000_000n,
        outstandingTaxMinor: 0n,
        outstandingInterestMinor: 0n,
      },
    ];

    const result = allocateReceipt({
      receiptNumber: "RCP/TDS",
      amountMinor: 990_000n,
      tdsCreditMinor: 10_000n,
      receivedOn: "2026-03-01",
      demands: demand,
      strategy: "oldest_first",
      appropriationOrder: "interest_first",
    });

    // ⚠️ Without the TDS credit this demand would be ₹100 short forever,
    // age into the buckets, and start a chase against a buyer who paid in
    // full and did exactly what the law told them to.
    expect(result.totalAllocatedMinor).toBe(1_000_000n);
    expect(result.lines[0]?.settlesDemand).toBe(true);
    expect(result.creditMinor).toBe(0n);
  });

  it("⭐ interest-first and principal-first differ in the LEGS and never in the total", () => {
    const interestFirst = allocateReceipt({
      receiptNumber: "RCP/IF",
      amountMinor: 100_000n,
      receivedOn: "2026-03-01",
      demands: DEMANDS,
      strategy: "oldest_first",
      appropriationOrder: "interest_first",
    });
    const principalFirst = allocateReceipt({
      receiptNumber: "RCP/PF",
      amountMinor: 100_000n,
      receivedOn: "2026-03-01",
      demands: DEMANDS,
      strategy: "oldest_first",
      appropriationOrder: "principal_first",
    });

    expect(interestFirst.totalAllocatedMinor).toBe(principalFirst.totalAllocatedMinor);
    expect(interestFirst.lines[0]?.interestMinor).toBe(100_000n);
    expect(principalFirst.lines[0]?.interestMinor).toBe(0n);
    // ⭐ And BOTH say which order was used, on the line the buyer is shown.
    expect(interestFirst.lines[0]?.explanation).toContain("interest before principal");
    expect(principalFirst.lines[0]?.explanation).toContain("principal before interest");
  });

  it("⭐ Section 59: the buyer's own direction is followed, exactly", () => {
    const result = allocateReceipt({
      receiptNumber: "RCP/SPEC",
      amountMinor: 50_000_000n,
      receivedOn: "2026-03-01",
      demands: DEMANDS,
      strategy: "specified",
      appropriationOrder: "interest_first",
      instructions: [
        { demandId: "d3", amountMinor: 1_050_136n },
        { demandId: "d2", amountMinor: 5_000_000n },
      ],
    });

    expect(result.lines.map((l) => l.demandId)).toEqual(["d3", "d2"]);
    expect(result.totalAllocatedMinor).toBe(6_050_136n);
    expect(result.creditMinor).toBe(50_000_000n - 6_050_136n);
    expect(result.narrative.join("\n")).toContain("Section 59");
  });

  it("⚠️ an instruction that exceeds a demand's outstanding is REFUSED, not silently trimmed", () => {
    expect(() =>
      allocateReceipt({
        receiptNumber: "RCP/BAD",
        amountMinor: 50_000_000n,
        receivedOn: "2026-03-01",
        demands: DEMANDS,
        strategy: "specified",
        appropriationOrder: "interest_first",
        instructions: [{ demandId: "d3", amountMinor: 9_999_999n }],
      }),
    ).toThrow(AllocationError);
  });

  it("⚠️ an instruction totalling more than the receipt is REFUSED", () => {
    expect(() =>
      allocateReceipt({
        receiptNumber: "RCP/BAD2",
        amountMinor: 1_000n,
        receivedOn: "2026-03-01",
        demands: DEMANDS,
        strategy: "specified",
        appropriationOrder: "interest_first",
        instructions: [{ demandId: "d1", amountMinor: 2_000n }],
      }),
    ).toThrow(AllocationError);
  });

  it("⭐ the narrative reconciles out loud — the line a buyer is shown", () => {
    const result = allocateReceipt({
      receiptNumber: "RCP/2026-27/0001",
      amountMinor: 50_000_000n,
      receivedOn: "2026-03-01",
      demands: DEMANDS,
      strategy: "oldest_first",
      appropriationOrder: "interest_first",
    });

    const text = result.narrative.join("\n");
    expect(text).toContain("RCP/2026-27/0001");
    expect(text).toContain("DN/2026-27/0001");
    expect(text).toContain("Reconciliation:");
    expect(text).toContain("₹5,00,000.00");
  });

  it("⭐ a bounce releases exactly what was applied, and says the clock never stopped", () => {
    const result = allocateReceipt({
      receiptNumber: "RCP/BOUNCE",
      amountMinor: 50_000_000n,
      receivedOn: "2026-03-01",
      demands: DEMANDS,
      strategy: "oldest_first",
      appropriationOrder: "interest_first",
    });

    const released = releaseOnBounce(result.lines);
    expect(released.releasedMinor).toBe(result.totalAllocatedMinor);
    expect(released.perDemand[0]?.explanation).toContain("original due date");
  });
});

/* ================================================================== */
/* 3. ⭐⭐ ALLOCATION, AT THE DATABASE                                  */
/* ================================================================== */

describe("⭐⭐ the database refuses an allocation that does not sum", () => {
  it("an EXACT split across three demands commits", async () => {
    const receipt = randomUUID();

    await asTenant(tenantA, async (c) => {
      await c.query(
        `INSERT INTO receipts
           (id, tenant_id, receipt_number, booking_id, received_on, amount_minor,
            allocated_minor, method, status)
         VALUES ($1,$2,'RCP/2026-27/9001',$3, DATE '2026-04-01', 51059447, 51059447,
                 'neft','cleared')`,
        [receipt, tenantA, bookingA],
      );

      const parts: Array<[string, string]> = [
        [demandA1, "40826533"],
        [demandA2, "9182915"],
        [demandA3, "1049999"],
      ];

      let sequence = 1;
      for (const [demandId, amount] of parts) {
        await c.query(
          `INSERT INTO receipt_allocations
             (tenant_id, receipt_id, demand_id, sequence, principal_minor, amount_minor,
              basis, explanation)
           VALUES ($1,$2,$3,$4,$5,$5,'oldest_first','Applied oldest demand first.')`,
          [tenantA, receipt, demandId, sequence, amount],
        );
        await c.query(
          `UPDATE demand_notices SET allocated_minor = $1, status = 'paid'
             WHERE id = $2 AND tenant_id = $3`,
          [amount, demandId, tenantA],
        );
        sequence += 1;
      }
    });

    const applied = await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(
        `SELECT allocated_minor FROM receipts WHERE id = $1`,
        [receipt],
      );
      return rows[0]?.allocated_minor;
    });
    expect(String(applied)).toBe("51059447");

    // Clean up so the later tests see the demands unpaid again.
    //
    // ⚠️ IN ONE EXPLICIT TRANSACTION. `asSuperuser` runs each statement on
    // its own, and the Section 5 triggers are DEFERRED — so releasing the
    // allocations in one statement and the demand totals in the next is
    // refused at the first commit, correctly. Even a superuser is not
    // exempt from a trigger.
    await asSuperuser(async (c) => {
      await c.query("BEGIN");
      await c.query(
        `UPDATE demand_notices SET allocated_minor = 0, status = 'issued'
           WHERE tenant_id = $1`,
        [tenantA],
      );
      // CASCADE takes the allocation rows with it.
      await c.query(`DELETE FROM receipts WHERE id = $1`, [receipt]);
      await c.query("COMMIT");
    });
  });

  it("⭐⭐ ONE PAISA short of the receipt is REFUSED at commit", async () => {
    const receipt = randomUUID();

    const error = await expectError(() =>
      asTenant(tenantA, async (c) => {
        await c.query(
          `INSERT INTO receipts
             (id, tenant_id, receipt_number, booking_id, received_on, amount_minor,
              allocated_minor, method, status)
           VALUES ($1,$2,'RCP/2026-27/9002',$3, DATE '2026-04-01', 40826533, 40826533,
                   'neft','cleared')`,
          [receipt, tenantA, bookingA],
        );
        await c.query(
          `INSERT INTO receipt_allocations
             (tenant_id, receipt_id, demand_id, sequence, principal_minor, amount_minor,
              basis, explanation)
           VALUES ($1,$2,$3,1,40826532,40826532,'oldest_first','One paisa short.')`,
          [tenantA, receipt, demandA1],
        );
        await c.query(
          `UPDATE demand_notices SET allocated_minor = 40826532, status = 'part_paid'
             WHERE id = $1 AND tenant_id = $2`,
          [demandA1, tenantA],
        );
      }),
    );

    expect(error).not.toBeNull();
    expect(error?.message).toContain("allocation rows");
  });

  it("⭐⭐ a demand cannot be over-applied — the excess is a credit, not a negative balance", async () => {
    const error = await expectError(() =>
      asTenant(tenantA, async (c) => {
        await c.query(
          `UPDATE demand_notices SET allocated_minor = total_minor + 1
             WHERE id = $1 AND tenant_id = $2`,
          [demandA1, tenantA],
        );
      }),
    );
    expect(error).not.toBeNull();
  });

  it("⚠️ a bounced receipt cannot keep money applied", async () => {
    const error = await expectError(() =>
      asTenant(tenantA, async (c) => {
        await c.query(
          `INSERT INTO receipts
             (tenant_id, receipt_number, booking_id, received_on, amount_minor,
              allocated_minor, method, status, bounced_on)
           VALUES ($1,'RCP/2026-27/9003',$2, DATE '2026-04-01', 100000, 100000,
                   'cheque','bounced', DATE '2026-04-08')`,
          [tenantA, bookingA],
        );
      }),
    );
    expect(error).not.toBeNull();
  });
});

/* ================================================================== */
/* 4. ⭐⭐ INTEREST                                                     */
/* ================================================================== */

describe("⭐⭐ interest on delayed payment", () => {
  const SIMPLE: InterestTerms = {
    rateBps: 1800,
    compounding: "simple",
    dayCount: "actual_365",
    graceDays: 0,
  };

  it("⭐ a year at 18% on ₹10,00,000 is exactly ₹1,80,000", () => {
    const accrual = accrueInterest({
      principalMinor: 100_000_000n,
      dueDate: "2026-01-15",
      asOf: "2027-01-15",
      terms: SIMPLE,
    });

    expect(accrual.days).toBe(365);
    expect(accrual.interestMinor).toBe(18_000_000n);
    expect(accrual.compounded).toBe(false);
  });

  it("⭐ ninety days is exact integer arithmetic, not a float", () => {
    const accrual = accrueInterest({
      principalMinor: 100_000_000n,
      dueDate: "2026-01-15",
      asOf: "2026-04-15",
      terms: SIMPLE,
    });
    expect(accrual.days).toBe(90);
    // 100000000 × 1800 × 90 ÷ (365 × 10000), half-up.
    expect(accrual.interestMinor).toBe(4_438_356n);
  });

  it("⭐ it runs from the DUE DATE — not the notice date, not today", () => {
    const accrual = accrueInterest({
      principalMinor: 100_000_000n,
      dueDate: "2026-01-15",
      asOf: "2026-01-16",
      terms: SIMPLE,
    });
    expect(accrual.accruesFrom).toBe("2026-01-15");
    expect(accrual.days).toBe(1);
    expect(accrual.interestMinor).toBe(simpleInterestMinor({
      principalMinor: 100_000_000n,
      rateBps: 1800,
      days: 1,
      dayCount: "actual_365",
    }));
  });

  it("nothing accrues before the due date, and nothing accrues on it", () => {
    for (const asOf of ["2026-01-01", "2026-01-14", "2026-01-15"]) {
      const accrual = accrueInterest({
        principalMinor: 100_000_000n,
        dueDate: "2026-01-15",
        asOf,
        terms: SIMPLE,
      });
      expect(accrual.interestMinor, `interest accrued on ${asOf}`).toBe(0n);
    }
  });

  it("⚠️ a grace period forgives the trivially late payer and NOT the one who pays in March", () => {
    const graced: InterestTerms = { ...SIMPLE, graceDays: 7 };

    const withinGrace = accrueInterest({
      principalMinor: 100_000_000n,
      dueDate: "2026-01-15",
      asOf: "2026-01-20",
      terms: graced,
    });
    expect(withinGrace.interestMinor).toBe(0n);

    // ⚠️ Past the grace, the clock runs from the DUE DATE — the grace
    // forgives the trivially late payer, it does not shorten the period.
    const past = accrueInterest({
      principalMinor: 100_000_000n,
      dueDate: "2026-01-15",
      asOf: "2026-02-24",
      terms: graced,
    });
    expect(past.accruesFrom).toBe("2026-01-15");
    expect(past.days).toBe(40);

    // And the other reading, when a workspace has chosen it.
    const forgiving = accrueInterest({
      principalMinor: 100_000_000n,
      dueDate: "2026-01-15",
      asOf: "2026-02-24",
      terms: { ...graced, graceForgivesElapsedDays: true },
    });
    expect(forgiving.accruesFrom).toBe("2026-01-22");
    expect(forgiving.days).toBe(33);
  });

  it("⭐⭐ compounding is VISIBLE: more than simple, and every rest period is itemised", () => {
    const monthly = accrueInterest({
      principalMinor: 100_000_000n,
      dueDate: "2026-01-15",
      asOf: "2027-01-15",
      terms: { ...SIMPLE, compounding: "monthly" },
    });

    expect(monthly.compounded).toBe(true);
    expect(monthly.periods).toHaveLength(12);
    expect(monthly.interestMinor > 18_000_000n).toBe(true);

    // ⭐ The periods add up to the total, so a buyer disputing the figure
    // can be handed the twelve lines that make it up.
    const summed = monthly.periods.reduce((s, p) => s + p.interestMinor, 0n);
    expect(summed).toBe(monthly.interestMinor);

    // ⚠️ The final, part-elapsed rest is NOT capitalised — that would
    // charge interest on interest that has not yet fallen due.
    expect(monthly.periods[monthly.periods.length - 1]?.capitalised).toBe(false);

    const quarterly = accrueInterest({
      principalMinor: 100_000_000n,
      dueDate: "2026-01-15",
      asOf: "2027-01-15",
      terms: { ...SIMPLE, compounding: "quarterly" },
    });
    expect(quarterly.periods).toHaveLength(4);
    expect(quarterly.interestMinor > 18_000_000n).toBe(true);
    expect(quarterly.interestMinor < monthly.interestMinor).toBe(true);
  });

  it("⭐⭐ every accrual states its own basis — interest must not compound silently", () => {
    for (const compounding of ["simple", "monthly", "quarterly", "annual"] as const) {
      const accrual = accrueInterest({
        principalMinor: 100_000_000n,
        dueDate: "2026-01-15",
        asOf: "2027-01-15",
        terms: { ...SIMPLE, compounding },
      });
      expect(accrual.basis).toContain("18.00%");
      expect(accrual.basis.toLowerCase()).toContain(
        compounding === "simple" ? "simple" : "compounded",
      );
      expect(accrual.basis).toContain("2026-01-15");
    }
  });

  it("⚠️ the day-count convention moves the number, so it is stated too", () => {
    const base = { principalMinor: 100_000_000n, dueDate: "2026-01-15", asOf: "2027-01-15" };

    const a365 = accrueInterest({ ...base, terms: SIMPLE });
    const a360 = accrueInterest({
      ...base,
      terms: { ...SIMPLE, dayCount: "actual_360" },
    });
    const t360 = accrueInterest({
      ...base,
      terms: { ...SIMPLE, dayCount: "thirty_360" },
    });

    expect(a360.interestMinor > a365.interestMinor).toBe(true);
    expect(t360.days).toBe(360);
    expect(t360.interestMinor).toBe(18_000_000n);
    expect(a365.basis).toContain("actual days over 365");
  });

  it("interest is never negative and never accrues on a settled principal", () => {
    const accrual = accrueInterest({
      principalMinor: 0n,
      dueDate: "2026-01-15",
      asOf: "2027-01-15",
      terms: SIMPLE,
    });
    expect(accrual.interestMinor).toBe(0n);
    expect(accrual.periods).toHaveLength(0);
  });

  /* --- ⭐ THE RERA RATE CAP -------------------------------------- */

  it("⭐⭐ a rate above the RERA reference rate is FLAGGED, with the reason", () => {
    const verdict = assessInterestRate({ rateBps: 1800, referenceRateBps: 1110 });

    expect(verdict.exceedsReference).toBe(true);
    expect(verdict.severity).toBe("warning");
    expect(verdict.excessBps).toBe(690);
    expect(verdict.message).toContain("2(za)");
    // ⭐ The reason a buyer's advocate raises it first: the rate is
    // symmetric, so the developer has agreed to PAY it on every delayed flat.
    expect(verdict.message).toContain("SYMMETRIC");
    expect(verdict.remedy).toContain("flag, not a refusal");
  });

  it("⭐ a rate at or below the reference rate is not flagged", () => {
    expect(assessInterestRate({ rateBps: 1110, referenceRateBps: 1110 }).exceedsReference).toBe(
      false,
    );
    expect(assessInterestRate({ rateBps: 900, referenceRateBps: 1110 }).severity).toBe("ok");
  });

  it("⭐ an absurd rate is called out as a typed extra digit", () => {
    const verdict = assessInterestRate({
      rateBps: ABSURD_RATE_BPS,
      referenceRateBps: 1110,
    });
    expect(verdict.severity).toBe("severe");
    expect(verdict.message).toContain("digit");
  });

  it("⚠️ flagging is not refusing — the demand still carries the agreement's rate", () => {
    const built = buildDemand({
      milestone: {
        id: randomUUID(),
        label: "On completion of 3rd slab",
        sequence: 3,
        amountMinor: 38_882_413n,
        amountPaidMinor: 0n,
      },
      trigger: {
        kind: "construction_event",
        label: "On completion of 3rd slab",
        achievedOn: "2026-01-10",
      },
      noticeDate: "2026-01-12",
      policy: {
        demandDueDays: 15,
        gstRateBps: 500,
        interestRateBps: 2400,
        referenceRateBps: 1110,
        compounding: "simple",
        dayCount: "actual_365",
        graceDays: 0,
      },
      taxKind: "cgst_sgst",
      placeOfSupplyCode: "29",
    });

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.demand.interestTerms.rateBps).toBe(2400);
    expect(built.demand.rateVerdict.exceedsReference).toBe(true);
    expect(built.demand.interestBasisNote).toContain("24.00%");
  });

  /* --- Civil-day arithmetic -------------------------------------- */

  it("⚠️ civil days, in UTC, with the month clamped", () => {
    expect(addDays("2026-01-15", 30)).toBe("2026-02-14");
    expect(daysBetween("2026-01-15", "2026-02-14")).toBe(30);
    // 31 January plus a month is 28 February, not 3 March.
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2024-01-31", 1)).toBe("2024-02-29");
    expect(dayCountDays("2026-01-31", "2026-02-28", "thirty_360")).toBe(28);
  });
});

/* ================================================================== */
/* 5. ⭐ AGEING BUCKETS — THE BOUNDARIES                               */
/* ================================================================== */

describe("⭐ ageing buckets at their boundaries", () => {
  it("⭐⭐ 30 is in 0-30, 31 is in 31-60, 60 is in 31-60, 61 is in 61-90", () => {
    expect(bucketForDaysOverdue(30)).toBe("0-30");
    expect(bucketForDaysOverdue(31)).toBe("31-60");
    expect(bucketForDaysOverdue(60)).toBe("31-60");
    expect(bucketForDaysOverdue(61)).toBe("61-90");
  });

  it("⚠️ 90 is the LAST day of 61-90, and 90+ means MORE than 90", () => {
    expect(bucketForDaysOverdue(89)).toBe("61-90");
    expect(bucketForDaysOverdue(90)).toBe("61-90");
    expect(bucketForDaysOverdue(91)).toBe("90+");
    expect(bucketForDaysOverdue(3650)).toBe("90+");
  });

  it("⚠️ a demand due TODAY and unpaid is an arrear of zero days, not `current`", () => {
    expect(bucketForDaysOverdue(0)).toBe("0-30");
    expect(bucketForDaysOverdue(-1)).toBe("current");
    expect(bucketForDaysOverdue(-365)).toBe("current");
  });

  it("the whole ladder of boundaries, computed from real dates", () => {
    const due = "2026-01-15";
    const cases: Array<[string, string]> = [
      ["2026-01-14", "current"],
      ["2026-01-15", "0-30"],
      ["2026-02-14", "0-30"], // 30 days
      ["2026-02-15", "31-60"], // 31 days
      ["2026-03-16", "31-60"], // 60 days
      ["2026-03-17", "61-90"], // 61 days
      ["2026-04-15", "61-90"], // 90 days
      ["2026-04-16", "90+"], // 91 days
    ];

    for (const [asOf, expected] of cases) {
      expect(daysOverdue(due, asOf)).toBe(
        Math.round(
          (Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / 86_400_000,
        ),
      );
      expect(bucketFor(due, asOf), `${asOf} landed in the wrong bucket`).toBe(expected);
    }
  });

  it("⭐ the report totals by project, booking and buyer, and every bucket sums to the total", () => {
    const report = ageReceivables(
      [
        {
          demandId: "a",
          noticeNumber: "DN/1",
          dueDate: "2026-01-15",
          outstandingMinor: 100_000n,
          interestMinor: 500n,
          projectId: "p1",
          projectName: "Phase 1",
          bookingId: "b1",
          bookingReference: "BKG-1",
          buyerId: "u1",
          buyerName: "Sunitha Rao",
        },
        {
          demandId: "b",
          noticeNumber: "DN/2",
          dueDate: "2026-03-01",
          outstandingMinor: 250_000n,
          projectId: "p1",
          projectName: "Phase 1",
          bookingId: "b2",
          bookingReference: "BKG-2",
          buyerId: "u2",
          buyerName: "Ravi Kumar",
        },
        {
          demandId: "c",
          noticeNumber: "DN/3",
          dueDate: "2026-06-01",
          outstandingMinor: 400_000n,
          projectId: "p2",
          projectName: "Phase 2",
          bookingId: "b3",
          bookingReference: "BKG-3",
          buyerId: "u1",
          buyerName: "Sunitha Rao",
        },
        // ⚠️ Settled — must not appear in a chase list at all.
        {
          demandId: "d",
          noticeNumber: "DN/4",
          dueDate: "2026-01-01",
          outstandingMinor: 0n,
          projectId: "p1",
          projectName: "Phase 1",
        },
      ],
      "2026-04-16",
    );

    expect(report.demandCount).toBe(3);
    const bucketSum = AGEING_BUCKETS.reduce((s, b) => s + report.totals[b], 0n);
    expect(bucketSum).toBe(report.totalMinor);
    expect(report.totalMinor).toBe(750_000n);

    // The June demand is not yet due.
    expect(report.totals.current).toBe(400_000n);
    expect(report.totals["90+"]).toBe(100_000n);
    expect(report.overdueMinor).toBe(350_000n);

    // ⚠️ Interest is stated beside the buckets, never inside them.
    expect(report.interestMinor).toBe(500n);

    expect(report.byProject).toHaveLength(2);
    expect(report.byBuyer).toHaveLength(2);
    expect(report.byBooking).toHaveLength(3);
    expect(report.byBuyer[0]?.label).toBe("Sunitha Rao");
  });
});

/* ================================================================== */
/* 6. ⭐⭐ THE DUNNING LADDER                                           */
/* ================================================================== */

describe("⭐⭐ the dunning ladder cannot skip a rung", () => {
  const base = {
    demandStatus: "issued" as const,
    dueDate: "2026-01-15",
    outstandingMinor: 100_000n,
    policy: DEFAULT_DUNNING_POLICY,
  };

  it("the ladder is four rungs, numbered, in one order", () => {
    expect(DUNNING_LADDER).toEqual([
      "reminder",
      "first_notice",
      "final_notice",
      "cancellation_warning",
    ]);
    expect(rungOf("reminder")).toBe(1);
    expect(rungOf("cancellation_warning")).toBe(4);
    expect(nextStage(null)).toBe("reminder");
    expect(nextStage("final_notice")).toBe("cancellation_warning");
    expect(nextStage("cancellation_warning")).toBe(null);
  });

  it("⭐⭐ a first notice cannot be sent before a reminder", () => {
    const verdict = canEscalate({
      ...base,
      currentStage: null,
      to: "first_notice",
      asOf: "2026-02-15",
    });
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) return;
    expect(verdict.code).toBe("skips_a_rung");
    expect(verdict.reason).toContain("Authority");
  });

  it("⭐⭐ a FINAL notice cannot be sent to somebody who has received nothing", () => {
    const verdict = canEscalate({
      ...base,
      currentStage: null,
      to: "final_notice",
      asOf: "2026-03-15",
    });
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) return;
    expect(verdict.code).toBe("skips_a_rung");
  });

  it("⭐⭐ a cancellation warning cannot be sent after only a reminder", () => {
    const verdict = canEscalate({
      ...base,
      currentStage: "reminder",
      to: "cancellation_warning",
      asOf: "2026-04-15",
      authorisedBy: "user-1",
      authorisedReason: "Board approved on 12 April.",
    });
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) return;
    expect(verdict.code).toBe("skips_a_rung");
  });

  it("the ladder climbed properly is allowed at every rung", () => {
    expect(
      canEscalate({ ...base, currentStage: null, to: "reminder", asOf: "2026-01-19" })
        .allowed,
    ).toBe(true);
    expect(
      canEscalate({
        ...base,
        currentStage: "reminder",
        to: "first_notice",
        asOf: "2026-02-01",
        lastSentOn: "2026-01-19",
      }).allowed,
    ).toBe(true);
    expect(
      canEscalate({
        ...base,
        currentStage: "first_notice",
        to: "final_notice",
        asOf: "2026-02-20",
        lastSentOn: "2026-02-01",
      }).allowed,
    ).toBe(true);
  });

  it("⭐⭐ a cancellation warning REQUIRES a named human and a reason", () => {
    const unauthorised = canEscalate({
      ...base,
      currentStage: "final_notice",
      to: "cancellation_warning",
      asOf: "2026-03-20",
      lastSentOn: "2026-02-20",
    });
    expect(unauthorised.allowed).toBe(false);
    if (!unauthorised.allowed) {
      expect(unauthorised.code).toBe("needs_human");
      expect(unauthorised.remedy).toContain("automatically");
    }

    const authorised = canEscalate({
      ...base,
      currentStage: "final_notice",
      to: "cancellation_warning",
      asOf: "2026-03-20",
      lastSentOn: "2026-02-20",
      authorisedBy: "user-1",
      authorisedReason: "No contact after three letters; approved by counsel.",
    });
    expect(authorised.allowed).toBe(true);
    if (authorised.allowed) {
      expect(authorised.requiresHumanAuthorisation).toBe(true);
      expect(authorised.rationale).toContain("counsel");
    }
  });

  it("⚠️ a rung that is not yet due is refused, with the day it becomes due", () => {
    const verdict = canEscalate({
      ...base,
      currentStage: null,
      to: "reminder",
      asOf: "2026-01-16",
    });
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) return;
    expect(verdict.code).toBe("too_early");
    expect(verdict.remedy).toContain("2026-01-18");
  });

  it("⚠️ two letters cannot go out the same morning even when both thresholds have passed", () => {
    const verdict = canEscalate({
      ...base,
      currentStage: "reminder",
      to: "first_notice",
      asOf: "2026-04-01",
      lastSentOn: "2026-03-30",
    });
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) return;
    expect(verdict.code).toBe("too_soon_after_last");
  });

  it("a paid, cancelled, superseded or unissued demand is never chased", () => {
    for (const [status, code] of [
      ["paid", "settled"],
      ["cancelled", "cancelled"],
      ["superseded", "cancelled"],
      ["draft", "not_issued"],
    ] as const) {
      const verdict = canEscalate({
        ...base,
        demandStatus: status,
        currentStage: null,
        to: "reminder",
        asOf: "2026-03-01",
      });
      expect(verdict.allowed, `a ${status} demand was chased`).toBe(false);
      if (!verdict.allowed) expect(verdict.code).toBe(code);
    }
  });

  it("⭐⭐ the sweep sends the NEXT rung, never the highest one whose threshold has passed", () => {
    // A demand that surfaces already 70 days overdue with no history.
    const action = nextSweepAction({
      currentStage: null,
      demandStatus: "issued",
      dueDate: "2026-01-15",
      asOf: "2026-03-26",
      outstandingMinor: 100_000n,
      policy: DEFAULT_DUNNING_POLICY,
    });

    expect(action.kind).toBe("send");
    if (action.kind !== "send") return;
    // ⚠️ NOT `cancellation_warning`, and not even `final_notice`.
    expect(action.stage).toBe("reminder");
  });

  it("⭐⭐ the sweep NEVER sends a cancellation warning — it raises a decision", () => {
    const action = nextSweepAction({
      currentStage: "final_notice",
      demandStatus: "issued",
      dueDate: "2026-01-15",
      asOf: "2026-04-15",
      outstandingMinor: 100_000n,
      lastSentOn: "2026-02-20",
      policy: DEFAULT_DUNNING_POLICY,
    });

    expect(action.kind).toBe("needs_decision");
    if (action.kind !== "needs_decision") return;
    expect(action.stage).toBe("cancellation_warning");
    expect(action.reason).toContain("named person");
  });

  it("a ladder whose rungs are out of order is refused by the validator", () => {
    expect(validateDunningPolicy(DEFAULT_DUNNING_POLICY)).toBeNull();
    const problem = validateDunningPolicy({
      ...DEFAULT_DUNNING_POLICY,
      finalNoticeAfterDays: 10,
    });
    expect(problem).not.toBeNull();
    expect(problem?.remedy).toContain("same morning");
  });

  it("the schedule says when each rung falls due, and which one is never automatic", () => {
    const schedule = ladderSchedule("2026-01-15", DEFAULT_DUNNING_POLICY);
    expect(schedule.map((s) => s.dueOn)).toEqual([
      "2026-01-18",
      "2026-01-30",
      "2026-02-14",
      "2026-03-16",
    ]);
    expect(schedule[3]?.automatic).toBe(false);
    expect(schedule.slice(0, 3).every((s) => s.automatic)).toBe(true);
  });
});

describe("⭐⭐ the database refuses a skipped rung too", () => {
  it("a final notice with no reminder or first notice before it is REFUSED", async () => {
    const error = await expectError(() =>
      asTenant(tenantA, async (c) => {
        await c.query(
          `INSERT INTO dunning_events
             (tenant_id, demand_id, stage, rung, channel, days_overdue, outstanding_minor)
           VALUES ($1,$2,'final_notice',3,'email',45,100000)`,
          [tenantA, demandA1],
        );
      }),
    );
    expect(error).not.toBeNull();
    expect(error?.message).toContain("reminder");
  });

  it("⚠️ and the back-fill path is the one that matters — recording history in order works", async () => {
    await asTenant(tenantA, async (c) => {
      await c.query(
        `INSERT INTO dunning_events
           (tenant_id, demand_id, stage, rung, channel, days_overdue, outstanding_minor, sent_at)
         VALUES ($1,$2,'reminder',1,'whatsapp',3,100000, TIMESTAMPTZ '2026-01-30 10:00+05:30')`,
        [tenantA, demandA2],
      );
      await c.query(
        `INSERT INTO dunning_events
           (tenant_id, demand_id, stage, rung, channel, days_overdue, outstanding_minor, sent_at)
         VALUES ($1,$2,'first_notice',2,'email',15,100000, TIMESTAMPTZ '2026-03-14 10:00+05:30')`,
        [tenantA, demandA2],
      );
    });

    const rungs = await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(
        `SELECT rung FROM dunning_events WHERE demand_id = $1 ORDER BY rung`,
        [demandA2],
      );
      return rows.map((r: { rung: number }) => r.rung);
    });
    expect(rungs).toEqual([1, 2]);
  });

  it("⚠️ a rung dated BEFORE the one before it is refused — a file reconstructed after the event", async () => {
    const error = await expectError(() =>
      asTenant(tenantA, async (c) => {
        await c.query(
          `INSERT INTO dunning_events
             (tenant_id, demand_id, stage, rung, channel, days_overdue, outstanding_minor, sent_at)
           VALUES ($1,$2,'final_notice',3,'courier',30,100000,
                   TIMESTAMPTZ '2026-02-01 10:00+05:30')`,
          [tenantA, demandA2],
        );
      }),
    );
    expect(error).not.toBeNull();
    expect(error?.message).toContain("out of order");
  });

  it("⭐⭐ a cancellation warning with nobody named behind it is REFUSED by the database", async () => {
    // Climb to the top first, properly.
    await asTenant(tenantA, async (c) => {
      await c.query(
        `INSERT INTO dunning_events
           (tenant_id, demand_id, stage, rung, channel, days_overdue, outstanding_minor, sent_at)
         VALUES ($1,$2,'final_notice',3,'courier',30,100000,
                 TIMESTAMPTZ '2026-04-01 10:00+05:30')`,
        [tenantA, demandA2],
      );
    });

    const error = await expectError(() =>
      asTenant(tenantA, async (c) => {
        await c.query(
          `INSERT INTO dunning_events
             (tenant_id, demand_id, stage, rung, channel, days_overdue, outstanding_minor, sent_at)
           VALUES ($1,$2,'cancellation_warning',4,'post',60,100000,
                   TIMESTAMPTZ '2026-05-01 10:00+05:30')`,
          [tenantA, demandA2],
        );
      }),
    );
    expect(error).not.toBeNull();

    // With a named human and a reason it is accepted.
    await asTenant(tenantA, async (c) => {
      await c.query(
        `INSERT INTO dunning_events
           (tenant_id, demand_id, stage, rung, channel, days_overdue, outstanding_minor,
            sent_at, authorised_by, authorised_reason)
         VALUES ($1,$2,'cancellation_warning',4,'post',60,100000,
                 TIMESTAMPTZ '2026-05-01 10:00+05:30', $3,
                 'No contact after three letters; approved by counsel.')`,
        [tenantA, demandA2, userA],
      );
    });

    const stages = await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(
        `SELECT stage FROM dunning_events WHERE demand_id = $1 ORDER BY rung`,
        [demandA2],
      );
      return rows.map((r: { stage: string }) => r.stage);
    });
    expect(stages).toEqual([
      "reminder",
      "first_notice",
      "final_notice",
      "cancellation_warning",
    ]);
  });

  it("⚠️ a rung cannot be sent against a demand that was never issued", async () => {
    const draft = randomUUID();
    const error = await expectError(() =>
      asTenant(tenantA, async (c) => {
        await c.query(
          `INSERT INTO demand_notices
             (id, tenant_id, notice_number, booking_id, milestone_id, status, trigger_kind,
              trigger_label, trigger_achieved_on, notice_date, due_date,
              principal_minor, total_minor, interest_basis_note, dunning_stage)
           VALUES ($1,$2,'DN/DRAFT/0001',$3,$4,'draft','construction_event','Slab',
                   DATE '2026-01-01', DATE '2026-01-02', DATE '2026-01-17', 1000, 1000,
                   $5, 'reminder')`,
          [draft, tenantA, bookingA, msA3, BASIS],
        );
      }),
    );
    expect(error).not.toBeNull();
  });
});

/* ================================================================== */
/* 7. ⭐ THE FROZEN DOCUMENT                                           */
/* ================================================================== */

describe("⭐ an issued demand is frozen", () => {
  it("⭐ its principal cannot be changed — the buyer holds a copy", async () => {
    const error = await expectError(() =>
      asTenant(tenantA, async (c) => {
        await c.query(
          `UPDATE demand_notices SET principal_minor = 1, total_minor = 1
             WHERE id = $1 AND tenant_id = $2`,
          [demandA3, tenantA],
        );
      }),
    );
    expect(error).not.toBeNull();
    expect(error?.message).toContain("superseded");
  });

  it("⭐ nor can what it says triggered it, nor the interest basis", async () => {
    for (const column of [
      "trigger_label = 'Something else'",
      "trigger_achieved_on = DATE '2020-01-01'",
      "interest_rate_bps = 2400",
      "interest_basis_note = 'Whatever we like now.'",
      "due_date = DATE '2027-01-01'",
    ]) {
      const error = await expectError(() =>
        asTenant(tenantA, async (c) => {
          await c.query(
            `UPDATE demand_notices SET ${column} WHERE id = $1 AND tenant_id = $2`,
            [demandA3, tenantA],
          );
        }),
      );
      expect(error, `${column} was allowed on an issued demand`).not.toBeNull();
    }
  });

  it("⚠️ but what HAPPENS to it still moves — a frozen document is not a frozen account", async () => {
    await asTenant(tenantA, async (c) => {
      await c.query(
        `UPDATE demand_notices SET notes = 'Buyer called 14 April.'
           WHERE id = $1 AND tenant_id = $2`,
        [demandA3, tenantA],
      );
    });
    const notes = await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(`SELECT notes FROM demand_notices WHERE id = $1`, [
        demandA3,
      ]);
      return rows[0]?.notes;
    });
    expect(notes).toContain("14 April");
  });

  it("⭐ two live demands cannot exist for one milestone", async () => {
    const error = await expectError(() =>
      asTenant(tenantA, async (c) => {
        await c.query(
          `INSERT INTO demand_notices
             (tenant_id, notice_number, booking_id, milestone_id, status, trigger_kind,
              trigger_label, trigger_achieved_on, notice_date, due_date,
              principal_minor, total_minor, interest_basis_note, issued_at)
           VALUES ($1,'DN/2026-27/0099',$2,$3,'issued','construction_event',
                   'On completion of 3rd slab', DATE '2026-01-10', DATE '2026-01-13',
                   DATE '2026-01-28', 38882413, 38882413, $4, now())`,
          [tenantA, bookingA, msA1, BASIS],
        );
      }),
    );
    expect(error).not.toBeNull();
    expect(error?.code).toBe("23505");
  });
});

/* ================================================================== */
/* 8. ⭐⭐ MULTI-LANGUAGE NOTICES                                       */
/* ================================================================== */

describe("⭐⭐ notices render in every supported language", () => {
  const FACTS: Omit<NoticeFacts, "language"> = {
    developerName: "Ordence Developers Pvt Ltd",
    buyerName: "Sunitha Rao",
    projectName: "Ordence Phase 1",
    unitLabel: "A-1203",
    noticeNumber: "DN/2026-27/0001",
    noticeDate: "2026-01-12",
    dueDate: "2026-01-27",
    triggerLabel: "On completion of the 3rd slab",
    triggerAchievedOn: "2026-01-10",
    principalMinor: 38_882_413n,
    taxMinor: 1_944_120n,
    totalMinor: 50_000_000n,
    outstandingMinor: 50_000_000n,
    interestMinor: 143_217n,
    payableMinor: 50_143_217n,
    daysOverdue: 45,
    interestBasisNote: "Interest at 11.10% per annum, simple, from the due date.",
    contactLine: "Accounts: accounts@ordence.example",
  };

  it("every pack passes its own structural check", () => {
    expect(() => assertAllPacks()).not.toThrow();
    expect(SUPPORTED_LANGUAGES).toEqual(["en", "hi", "kn", "ta", "te", "mr"]);
  });

  it("⭐⭐ all six languages render a demand notice with every placeholder filled", () => {
    for (const language of SUPPORTED_LANGUAGES) {
      const rendered = renderDemandNotice({ ...FACTS, language });

      expect(rendered.body, `${language} left a placeholder`).not.toMatch(/\{\{|\}\}/);
      expect(rendered.subject).not.toMatch(/\{\{|\}\}/);
      expect(rendered.language).toBe(language);
      expect(rendered.templateKey).toBe("demand_notice");

      // ⭐ THE AMOUNT, IN THE INDIAN NUMBERING SYSTEM, IN EVERY LANGUAGE.
      expect(rendered.body, `${language} lost the amount`).toContain("₹5,00,000.00");
      // ⭐ AND WHAT TRIGGERED IT — the RERA requirement.
      expect(rendered.body).toContain("On completion of the 3rd slab");
      expect(rendered.body).toContain("2026-01-10");
      // ⭐ AND THE INTEREST BASIS.
      expect(rendered.body).toContain("11.10%");
      expect(rendered.body).toContain("Sunitha Rao");
    }
  });

  it("⭐⭐ all six render all four rungs of the ladder", () => {
    for (const language of SUPPORTED_LANGUAGES) {
      for (const stage of DUNNING_LADDER) {
        const letter = renderDunningLetter(stage, { ...FACTS, language });
        expect(letter.body, `${language}/${stage} left a placeholder`).not.toMatch(
          /\{\{|\}\}/,
        );
        expect(letter.body).toContain("₹5,01,432.17");
        expect(letter.templateKey).toBe(`dunning_${stage}`);
      }
    }
  });

  it("⭐⭐ the amount in words is REAL where it is implemented and FIGURES where it is not", () => {
    // English and Hindi have their numbering systems written out in full.
    expect(languagesWithAmountWords()).toEqual(["en", "hi"]);

    const english = amountInWordsFor("en", 50_000_000n);
    expect(english.words).toBe("Rupees Five Lakh Only");
    expect(english.fellBack).toBe(false);
    expect(english.wordsLanguage).toBe("en");

    const hindi = amountInWordsFor("hi", 50_000_000n);
    expect(hindi.words).toBe("रुपये पाँच लाख मात्र");
    expect(hindi.fellBack).toBe(false);

    // ⚠️ AND THE FOUR THAT ARE NOT IMPLEMENTED FALL BACK TO FIGURES —
    // never to invented words. On an Indian financial document the words
    // conventionally prevail over the figures, so a wrong amount in words
    // is a legal document stating a number the developer never demanded.
    for (const language of ["kn", "ta", "te", "mr"] as const) {
      const words = amountInWordsFor(language, 50_000_000n);
      expect(words.words, `${language} invented number-words`).toBe("₹5,00,000.00");
      expect(words.fellBack).toBe(true);
      // ⚠️ And it declares a DIFFERENT language, so the SQL CHECK
      // `demand_notice_documents_fallback_is_honest` accepts the row and
      // the gap stays reportable.
      expect(words.wordsLanguage).not.toBe(language);
    }
  });

  it("⭐ the rendered notice reports whether its words fell back", () => {
    expect(renderDemandNotice({ ...FACTS, language: "en" }).wordsFellBack).toBe(false);
    expect(renderDemandNotice({ ...FACTS, language: "hi" }).wordsFellBack).toBe(false);
    expect(renderDemandNotice({ ...FACTS, language: "kn" }).wordsFellBack).toBe(true);
  });

  it("⭐ the interest basis is written in the notice's own language, from the same terms", () => {
    const terms: InterestTerms = {
      rateBps: 1800,
      compounding: "monthly",
      dayCount: "actual_365",
      graceDays: 0,
    };

    const english = buildInterestBasisNote({ terms, dueDate: "2026-01-15", language: "en" });
    expect(english).toContain("18.00%");
    expect(english).toContain("compounded monthly");

    const hindi = buildInterestBasisNote({ terms, dueDate: "2026-01-15", language: "hi" });
    expect(hindi).toContain("18.00%");
    expect(hindi).toContain("मासिक चक्रवृद्धि");

    const kannada = buildInterestBasisNote({ terms, dueDate: "2026-01-15", language: "kn" });
    expect(kannada).toContain("18.00%");
    expect(kannada).toContain("ಮಾಸಿಕ ಚಕ್ರಬಡ್ಡಿ");

    // ⚠️ Every language names the compounding rule. Interest must not
    // compound silently in ANY of them.
    for (const language of SUPPORTED_LANGUAGES) {
      const note = buildInterestBasisNote({ terms, dueDate: "2026-01-15", language });
      expect(note.length, `${language} produced an empty basis`).toBeGreaterThan(20);
      expect(note).toContain("2026-01-15");
    }
  });

  it("⭐ `leads.preferred_lang` is normalised, and an unknown tag falls back to English", () => {
    expect(normaliseLanguage("kn-IN")).toBe("kn");
    expect(normaliseLanguage("KN")).toBe("kn");
    expect(normaliseLanguage("ta_IN")).toBe("ta");
    expect(normaliseLanguage("en-GB")).toBe("en");
    // ⚠️ A buyer whose language is not implemented still gets a demand.
    expect(normaliseLanguage("bn")).toBe("en");
    expect(normaliseLanguage(null)).toBe("en");
    expect(normaliseLanguage("")).toBe("en");
  });
});

/* ================================================================== */
/* 9. ⭐⭐ NO UNESCAPED INTERPOLATION                                   */
/* ================================================================== */

describe("⭐⭐ safe interpolation", () => {
  const HOSTILE = '<img src=x onerror="alert(1)"> & \'Sons\'';

  it("⭐⭐ a hostile buyer name is ESCAPED in an HTML notice, in every language", () => {
    for (const language of SUPPORTED_LANGUAGES) {
      const html = renderDemandNotice(
        {
          language,
          developerName: "Ordence",
          buyerName: HOSTILE,
          projectName: "Phase 1",
          unitLabel: "A-1203",
          noticeNumber: "DN/1",
          noticeDate: "2026-01-12",
          dueDate: "2026-01-27",
          triggerLabel: "3rd slab",
          triggerAchievedOn: "2026-01-10",
          principalMinor: 1n,
          taxMinor: 0n,
          totalMinor: 1n,
          outstandingMinor: 1n,
          interestMinor: 0n,
          payableMinor: 1n,
          daysOverdue: 0,
          interestBasisNote: "No interest is charged on this demand.",
          contactLine: "Accounts",
        },
        "html",
      );

      expect(html.body, `${language} rendered a raw script tag`).not.toContain("<img");
      expect(html.body).toContain("&lt;img");
      expect(html.body).toContain("&amp;");
      expect(html.body).toContain("&#39;");
    }
  });

  it("⭐ the ampersand is escaped FIRST — no `&amp;lt;`", () => {
    expect(escapeHtml("<Shah & Sons>")).toBe("&lt;Shah &amp; Sons&gt;");
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });

  it("⭐⭐ a value containing a placeholder cannot pull in another field", () => {
    // A buyer registered as `{{totalAmount}}` would, in a re-scanning
    // engine, print somebody's amount in the middle of their own name.
    expect(() =>
      renderTemplate("Dear {{buyerName}}, you owe {{totalAmount}}.", {
        buyerName: "{{totalAmount}}",
        totalAmount: "₹5,00,000.00",
      }),
    ).toThrow(TemplateRenderError);
  });

  it("⭐ a MISSING value is a refusal, not a hole in a legal document", () => {
    const error = (() => {
      try {
        renderTemplate("Dear {{buyerName}}, you owe {{totalAmount}}.", {
          buyerName: "Sunitha Rao",
        });
        return null;
      } catch (err) {
        return err as TemplateRenderError;
      }
    })();

    expect(error).toBeInstanceOf(TemplateRenderError);
    expect(error?.placeholder).toBe("totalAmount");
    expect(error?.remedy).toContain("legal document");
  });

  it("⚠️ control characters and bidi overrides are REMOVED, not escaped", () => {
    expect(sanitiseValue("Sun itha")).toBe("Sunitha");
    // U+202E reorders rendered text without changing a visible character —
    // on a document whose job is stating an amount, that is not theoretical.
    expect(sanitiseValue("Rao‮")).toBe("Rao");
    // Newlines and tabs survive: a notice has an address block in it.
    expect(sanitiseValue("Line 1\nLine 2")).toBe("Line 1\nLine 2");
  });

  it("⚠️ braces that are not a valid placeholder are caught, not printed", () => {
    expect(() => renderTemplate("Dear {{ buyer-name }},", { buyerName: "x" })).toThrow(
      TemplateRenderError,
    );
  });

  it("every pack uses only the closed placeholder vocabulary", () => {
    for (const language of SUPPORTED_LANGUAGES) {
      const pack = NOTICE_PACKS[language];
      const strings = [
        pack.demand.subject,
        pack.demand.body,
        ...Object.values(pack.stages).flatMap((s) => [s.subject, s.body]),
      ];
      for (const value of strings) {
        expect(
          unknownPlaceholders(value, NOTICE_PLACEHOLDERS),
          `${language} used a placeholder outside the vocabulary`,
        ).toEqual([]);
      }
    }
  });
});

/* ================================================================== */
/* 10. INDIAN NUMBER FORMATTING                                        */
/* ================================================================== */

describe("⭐ Indian number formatting", () => {
  it("groups the last three digits, then twos — never groups of three", () => {
    expect(groupIndian("1234567")).toBe("12,34,567");
    expect(groupIndian("100000")).toBe("1,00,000");
    expect(groupIndian("999")).toBe("999");
    expect(groupIndian("1000")).toBe("1,000");
    expect(groupIndian("100000000")).toBe("10,00,00,000");
  });

  it("formats paise exactly, always with two decimal places", () => {
    expect(formatPaise(50_000_000n)).toBe("5,00,000.00");
    expect(formatPaise(123_456_789n)).toBe("12,34,567.89");
    expect(formatPaise(1n)).toBe("0.01");
    expect(formatPaise(0n)).toBe("0.00");
    expect(formatRupees(50_000_000n)).toBe("₹5,00,000.00");
  });

  it("⚠️ exact for amounts beyond a double's integer range", () => {
    // ₹10,00,00,00,00,00,000 in paise — three orders of magnitude past
    // the 2^53 boundary where a `Number` starts silently rounding.
    const huge = 100_000_000_000_000_000n;
    expect(formatPaise(huge)).toBe("1,00,00,00,00,00,00,000.00");
  });

  it("rates are formatted from integer basis points", () => {
    expect(formatRateBps(1800)).toBe("18.00%");
    expect(formatRateBps(1110)).toBe("11.10%");
    expect(formatRateBps(500)).toBe("5.00%");
    expect(formatRateBps(1)).toBe("0.01%");
  });

  it("⭐ English words use the Indian scale — crore, lakh, thousand", () => {
    expect(amountInWordsEnglish(50_000_000n)).toBe("Rupees Five Lakh Only");
    expect(amountInWordsEnglish(0n)).toBe("Rupees Zero Only");
    expect(amountInWordsEnglish(12_345_678_9n)).toBe(
      "Rupees Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven and Eighty Nine Paise Only",
    );
    expect(integerInWordsEnglish(10_000_000n)).toBe("One Crore");
    // ⚠️ Over 999 crore the count recurses rather than truncating.
    expect(integerInWordsEnglish(12_340_000_000n)).toBe(
      "One Thousand Two Hundred Thirty Four Crore",
    );
  });

  it("⭐ Hindi numerals below 100 are the irregular forms, not a composition", () => {
    expect(amountInWordsHindi(2_100n)).toBe("रुपये इक्कीस मात्र");
    expect(amountInWordsHindi(3_100n)).toBe("रुपये इकतीस मात्र");
    expect(amountInWordsHindi(9_900n)).toBe("रुपये निन्यानवे मात्र");
    expect(amountInWordsHindi(50_000_000n)).toBe("रुपये पाँच लाख मात्र");
    expect(amountInWordsHindi(1_000_000_000n)).toBe("रुपये एक करोड़ मात्र");
  });
});

/* ================================================================== */
/* 11. ⭐ THE STATEMENT OF ACCOUNT                                     */
/* ================================================================== */

describe("⭐ the statement of account", () => {
  const DEMANDS = [
    {
      demandId: "d1",
      noticeNumber: "DN/2026-27/0001",
      noticeDate: "2026-01-12",
      dueDate: "2026-01-27",
      triggerLabel: "On completion of the 3rd slab",
      status: "part_paid",
      principalMinor: 38_882_413n,
      taxMinor: 1_944_120n,
      totalMinor: 40_826_533n,
      allocatedMinor: 40_826_533n,
      interestAccruedMinor: 143_217n,
      interestPaidMinor: 143_217n,
      interestBasisNote: "Interest at 11.10% per annum, simple, from the due date.",
    },
    {
      demandId: "d2",
      noticeNumber: "DN/2026-27/0002",
      noticeDate: "2026-02-12",
      dueDate: "2026-02-27",
      triggerLabel: "On completion of the 7th slab",
      status: "part_paid",
      principalMinor: 8_745_633n,
      taxMinor: 437_282n,
      totalMinor: 9_182_915n,
      allocatedMinor: 9_030_250n,
      interestAccruedMinor: 12_000n,
      interestPaidMinor: 0n,
      interestBasisNote: "Interest at 11.10% per annum, simple, from the due date.",
    },
  ];

  const RECEIPTS = [
    {
      receiptId: "r1",
      receiptNumber: "RCP/2026-27/0001",
      receivedOn: "2026-03-01",
      amountMinor: 50_000_000n,
      tdsCreditMinor: 0n,
      allocatedMinor: 50_000_000n,
      method: "neft",
      status: "cleared",
      instrumentRef: "UTR123456",
      allocations: [
        {
          demandId: "d1",
          noticeNumber: "DN/2026-27/0001",
          amountMinor: 40_969_750n,
          principalMinor: 38_882_413n,
          taxMinor: 1_944_120n,
          interestMinor: 143_217n,
          explanation: "₹4,09,697.50 applied to demand DN/2026-27/0001 — oldest first.",
        },
        {
          demandId: "d2",
          noticeNumber: "DN/2026-27/0002",
          amountMinor: 9_030_250n,
          principalMinor: 8_600_238n,
          taxMinor: 430_012n,
          interestMinor: 0n,
          explanation: "₹90,302.50 applied to demand DN/2026-27/0002 — oldest first.",
        },
      ],
    },
  ];

  it("⭐ it foots: demanded − applied = outstanding", () => {
    const statement = buildStatement({
      asOf: "2026-04-16",
      buyerName: "Sunitha Rao",
      bookingReference: "BKG-9001",
      unitLabel: "A-1203",
      projectName: "Ordence Phase 1",
      agreementValueMinor: 900_000_000n,
      demands: DEMANDS,
      receipts: RECEIPTS,
    });

    expect(statement.totals.demandedMinor).toBe(50_009_448n);
    expect(statement.totals.appliedMinor).toBe(49_856_783n);
    expect(
      statement.totals.demandedMinor - statement.totals.appliedMinor,
    ).toBe(statement.totals.outstandingMinor);
    expect(statement.totals.outstandingMinor).toBe(152_665n);
    expect(statement.totals.interestOutstandingMinor).toBe(12_000n);
  });

  it("⭐ every receipt line carries the sentence written when the money was applied", () => {
    const statement = buildStatement({
      asOf: "2026-04-16",
      buyerName: "Sunitha Rao",
      bookingReference: "BKG-9001",
      unitLabel: "A-1203",
      projectName: "Ordence Phase 1",
      demands: DEMANDS,
      receipts: RECEIPTS,
    });

    const text = statement.narrative.join("\n");
    expect(text).toContain("applied to demand DN/2026-27/0001");
    expect(text).toContain("applied to demand DN/2026-27/0002");
    expect(text).toContain("STATEMENT OF ACCOUNT as at 2026-04-16");
    // ⭐ The footing, written out, so a reader does not have to work out
    // which numbers are supposed to add up.
    expect(text).toContain("= outstanding");
    // ⭐ And the basis of interest, once, for the demands in force.
    expect(text).toContain("BASIS OF INTEREST");
    expect(statement.interestBases).toHaveLength(1);
  });

  it("⭐⭐ a statement that does not foot REFUSES to be produced", () => {
    expect(() =>
      buildStatement({
        asOf: "2026-04-16",
        buyerName: "Sunitha Rao",
        bookingReference: "BKG-9001",
        unitLabel: "A-1203",
        projectName: "Ordence Phase 1",
        demands: DEMANDS,
        receipts: [
          {
            ...RECEIPTS[0]!,
            // The receipt says one number; the demands say another.
            allocatedMinor: 49_856_782n,
          },
        ],
      }),
    ).toThrow(StatementImbalanceError);
  });

  it("⚠️ a bounced receipt is SHOWN and not counted", () => {
    const statement = buildStatement({
      asOf: "2026-04-16",
      buyerName: "Sunitha Rao",
      bookingReference: "BKG-9001",
      unitLabel: "A-1203",
      projectName: "Ordence Phase 1",
      demands: [{ ...DEMANDS[0]!, allocatedMinor: 0n, interestPaidMinor: 0n }],
      receipts: [
        {
          receiptId: "r9",
          receiptNumber: "RCP/2026-27/0009",
          receivedOn: "2026-03-05",
          amountMinor: 40_826_533n,
          tdsCreditMinor: 0n,
          allocatedMinor: 0n,
          method: "cheque",
          status: "bounced",
          instrumentRef: "CHQ 004521",
          allocations: [],
        },
      ],
    });

    expect(statement.totals.receivedMinor).toBe(0n);
    expect(statement.totals.outstandingMinor).toBe(40_826_533n);
    expect(statement.narrative.join("\n")).toContain("BOUNCED, not counted");
  });

  it("⭐ an over-payment appears as a CREDIT and is netted off what to pay today", () => {
    const statement = buildStatement({
      asOf: "2026-04-16",
      buyerName: "Sunitha Rao",
      bookingReference: "BKG-9001",
      unitLabel: "A-1203",
      projectName: "Ordence Phase 1",
      demands: [{ ...DEMANDS[0]!, allocatedMinor: 40_826_533n, interestPaidMinor: 143_217n }],
      receipts: [
        {
          ...RECEIPTS[0]!,
          amountMinor: 50_000_000n,
          allocatedMinor: 40_969_750n,
          allocations: [RECEIPTS[0]!.allocations[0]!],
        },
      ],
    });

    expect(statement.totals.creditMinor).toBe(9_030_250n);
    expect(statement.totals.outstandingMinor).toBe(0n);
    expect(statement.totals.payableTodayMinor).toBe(0n);
    expect(statement.narrative.join("\n")).toContain("Credit held on account");
  });
});

/* ================================================================== */
/* 12. BUILDING A DEMAND                                               */
/* ================================================================== */

describe("⭐ building a demand", () => {
  const MILESTONE = {
    id: randomUUID(),
    label: "On completion of 3rd slab",
    sequence: 3,
    amountMinor: 38_882_413n,
    amountPaidMinor: 0n,
  };

  const POLICY = {
    demandDueDays: 15,
    gstRateBps: 500,
    interestRateBps: 1110,
    referenceRateBps: 1110,
    compounding: "simple" as const,
    dayCount: "actual_365" as const,
    graceDays: 0,
  };

  it("⭐⭐ a demand with no stated trigger is REFUSED", () => {
    const built = buildDemand({
      milestone: MILESTONE,
      trigger: { kind: "construction_event", label: "  ", achievedOn: "2026-01-10" },
      noticeDate: "2026-01-12",
      policy: POLICY,
      taxKind: "cgst_sgst",
      placeOfSupplyCode: "29",
    });

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.problem.remedy).toContain("RERA");
  });

  it("⭐⭐ a demand dated BEFORE the event it relies on is REFUSED", () => {
    const built = buildDemand({
      milestone: MILESTONE,
      trigger: {
        kind: "construction_event",
        label: "On completion of 3rd slab",
        achievedOn: "2026-02-10",
      },
      noticeDate: "2026-01-12",
      policy: POLICY,
      taxKind: "cgst_sgst",
      placeOfSupplyCode: "29",
    });

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.problem.remedy).toContain("complaint");
  });

  it("⭐ the GST is computed by Phase 32's engine and the total adds up", () => {
    const built = buildDemand({
      milestone: MILESTONE,
      trigger: {
        kind: "construction_event",
        label: "On completion of 3rd slab",
        achievedOn: "2026-01-10",
        evidence: "Engineer's certificate dated 10 January 2026",
      },
      noticeDate: "2026-01-12",
      policy: POLICY,
      taxKind: "cgst_sgst",
      placeOfSupplyCode: "29",
    });

    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const a = built.demand.amounts;
    expect(a.principalMinor).toBe(38_882_413n);
    expect(a.cgstMinor + a.sgstMinor + a.igstMinor + a.cessMinor).toBe(a.taxMinor);
    expect(a.principalMinor + a.taxMinor).toBe(a.totalMinor);
    // ⚠️ Intra-state: CGST and SGST, never IGST — Section 12(3) puts the
    // place of supply where the FLAT is.
    expect(a.igstMinor).toBe(0n);
    expect(built.demand.dueDate).toBe("2026-01-27");
  });

  it("⚠️ demanding more than the plan provides for is REFUSED", () => {
    const built = buildDemand({
      milestone: MILESTONE,
      trigger: {
        kind: "construction_event",
        label: "On completion of 3rd slab",
        achievedOn: "2026-01-10",
      },
      noticeDate: "2026-01-12",
      policy: POLICY,
      taxKind: "cgst_sgst",
      placeOfSupplyCode: "29",
      principalOverrideMinor: 99_999_999n,
    });

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.problem.remedy).toContain("consumer-forum");
  });

  it("⭐ the position of a demand is derived from what was received, not from its status column", () => {
    const position = demandPosition(
      {
        status: "issued",
        dueDate: "2026-01-27",
        totalMinor: 40_826_533n,
        principalMinor: 38_882_413n,
        taxMinor: 1_944_120n,
        allocatedMinor: 40_826_533n,
        interestPaidMinor: 0n,
        interestTerms: {
          rateBps: 1110,
          compounding: "simple",
          dayCount: "actual_365",
          graceDays: 0,
        },
      },
      "2026-04-16",
    );

    // ⚠️ The column says `issued`; the money says `paid`.
    expect(position.status).toBe("paid");
    expect(position.outstandingMinor).toBe(0n);
    // ⚠️ And no interest accrues on a settled principal.
    expect(position.interest.interestMinor).toBe(0n);
  });

  it("⚠️ interest is charged on the outstanding PRINCIPAL, never on the GST", () => {
    const position = demandPosition(
      {
        status: "issued",
        dueDate: "2026-01-27",
        totalMinor: 40_826_533n,
        principalMinor: 38_882_413n,
        taxMinor: 1_944_120n,
        allocatedMinor: 0n,
        interestPaidMinor: 0n,
        interestTerms: {
          rateBps: 1110,
          compounding: "simple",
          dayCount: "actual_365",
          graceDays: 0,
        },
      },
      "2026-04-27",
    );

    expect(position.outstandingPrincipalMinor).toBe(38_882_413n);
    expect(position.outstandingTaxMinor).toBe(1_944_120n);
    expect(position.outstandingPrincipalMinor + position.outstandingTaxMinor).toBe(
      position.outstandingMinor,
    );
    expect(position.interest.principalMinor).toBe(38_882_413n);
    // The GST element is excluded from the base the interest is computed on.
    expect(position.interest.principalMinor < position.outstandingMinor).toBe(true);
  });

  it("the basis sentence names the rate, the rule, the date and the day count", () => {
    const note = describeInterestBasis({
      terms: {
        rateBps: 1110,
        compounding: "quarterly",
        dayCount: "actual_360",
        graceDays: 7,
      },
      dueDate: "2026-01-27",
    });

    expect(note).toContain("11.10%");
    expect(note).toContain("compounded quarterly");
    expect(note).toContain("2026-01-27");
    expect(note).toContain("7 days");
    expect(note).toContain("actual days over 360");
  });
});
