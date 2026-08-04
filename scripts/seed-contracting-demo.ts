/**
 * Ordence — ⭐ CONTRACTING DEMO SEEDER
 * Version: v0.70.0-alpha
 *
 * Seeds one complete subcontract, from an authorised BOQ through measured
 * work to a certified bill — in the REAL tables, so every screen, view
 * and trigger in the product acts on it exactly as it would in
 * production.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT THIS SEEDER DELIBERATELY DOES NOT DO
 * ══════════════════════════════════════════════════════════════════════
 * It does not create a workspace where everything is finished and tidy.
 *
 * A demo in which every measurement is checked and every bill is paid
 * shows the screens and proves nothing — worse, it teaches whoever is
 * looking that the states in between do not exist. So the data below is
 * deliberately mid-flight:
 *
 *   · one measurement AWAITING CHECK, so the check control is visible
 *     and its "you recorded this" refusal can be seen
 *   · one measurement REJECTED with a reason, so the state is not a
 *     theoretical one
 *   · one DEDUCTION, so the sign convention is visible on screen
 *   · RA-01 PAID with full EPF/ESI evidence, so `previous_paid` carries
 *     forward and the payment gate can be seen to have been satisfied
 *   · RA-02 CERTIFIED but not approved, so the approve step has
 *     something to act on
 *   · checked, unbilled work left over, so "Ready to bill" is not empty
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THREE USERS, AND THAT IS THE POINT OF THE FIXTURE
 * ══════════════════════════════════════════════════════════════════════
 * The site engineer measures, the QS checks, the director approves. A
 * demo with one user would satisfy every database constraint and quietly
 * model the exact arrangement the product exists to prevent — and none of
 * the separation-of-duties refusals would ever be visible.
 *
 * ══════════════════════════════════════════════════════════════════════
 * SAFETY
 * ══════════════════════════════════════════════════════════════════════
 *   · Refuses to run against production unless SEED_ALLOW_PROD=true
 *   · Idempotent by tenant slug — re-running replaces, never duplicates
 *   · Every insert carries `tenant_id` explicitly
 *
 * RUN IT
 *   npm run seed:contracting
 */

import "dotenv/config";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";

const DATABASE_URL = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("\n❌ DATABASE_URL is not set.\n");
  process.exit(1);
}

if (process.env.NODE_ENV === "production" && process.env.SEED_ALLOW_PROD !== "true") {
  console.error("\n🛑 Refusing to seed a production database.");
  console.error("   Set SEED_ALLOW_PROD=true only if you are certain.\n");
  process.exit(1);
}

const TENANT_SLUG = "shirke-demo";

/** Micro-units per whole unit. A quantity of 12.345 is stored as 12345000. */
const M = 1_000_000;

/** Rupees → paise. Integers only here; every value below is exact. */
const rs = (rupees: number): number => Math.round(rupees * 100);

const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });

async function main() {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    /* ---- 0 · A CLEAN SLATE ------------------------------------------
     *
     * ⚠️ `session_replication_role = replica` FOR THE DELETE ONLY.
     *
     * SQL 0038 refuses to delete a measurement that carries an
     * `ra_bill_id` — it is the evidence behind a certified quantity. That
     * guard is right, and it also fires on the cascade from deleting the
     * tenant, so a re-run would fail on the second attempt.
     *
     * Suppressing triggers for this connection is scoped, reversible and
     * dies with the connection. `ALTER TABLE ... DISABLE TRIGGER` would
     * change the schema for everybody and stay changed if this threw.
     */
    const existing = await client.query("SELECT id FROM tenants WHERE slug = $1", [TENANT_SLUG]);
    if (existing.rows[0]) {
      await client.query("SET session_replication_role = replica");
      await client.query("DELETE FROM tenants WHERE slug = $1", [TENANT_SLUG]);
      await client.query("SET session_replication_role = origin");
      console.log("  Replaced the previous demo workspace.");
    }

    const tenantId = randomUUID();
    await client.query(
      `INSERT INTO tenants (id, name, slug, clerk_org_id, plan_tier, status, settings)
       VALUES ($1, 'Shirke Developers (demo)', $2, $3, 'enterprise', 'active',
               '{"industry":"real_estate_developer"}'::jsonb)`,
      [tenantId, TENANT_SLUG, `org_demo_${TENANT_SLUG}`],
    );

    /* ---- 1 · THREE PEOPLE, THREE JOBS ------------------------------ */
    const engineer = randomUUID();
    const surveyor = randomUUID();
    const director = randomUUID();

    for (const [id, email, first, last, role] of [
      [engineer, "r.kulkarni@shirke.demo", "Ravi", "Kulkarni", "member"],
      [surveyor, "n.deshpande@shirke.demo", "Neha", "Deshpande", "manager"],
      [director, "a.shirke@shirke.demo", "Anil", "Shirke", "tenant_owner"],
    ] as const) {
      await client.query(
        `INSERT INTO users (id, tenant_id, clerk_user_id, email, first_name, last_name, role, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')`,
        [id, tenantId, `user_demo_${id.slice(0, 8)}`, email, first, last, role],
      );
    }

    /* ---- 2 · THE PROJECT AND THE SUBCONTRACTOR --------------------- */
    const projectId = randomUUID();
    await client.query(
      `INSERT INTO projects
         (id, tenant_id, code, name, city, state, rera_number,
          budget_minor, contingency_bps, saleable_area_sqft, started_at)
       VALUES ($1, $2, 'BSV-T3', 'Basaveshwar Tower 3', 'Bengaluru', 'Karnataka',
               'PRM/KA/RERA/1251/446/PR/260214/003912',
               $3, 500, 148000, '2026-01-15')`,
      [projectId, tenantId, rs(38_00_00_000)], // ₹38 crore approved budget
    );

    const vendorId = randomUUID();
    await client.query(
      `INSERT INTO vendors (id, tenant_id, code, legal_name)
       VALUES ($1, $2, 'V-0142', 'Shreyas Constructions Pvt Ltd')`,
      [vendorId, tenantId],
    );

    const contractId = randomUUID();
    await client.query(
      `INSERT INTO works_contracts
         (id, tenant_id, contract_no, title, project_id, vendor_id, status,
          contract_value_minor, start_on, end_on,
          cess_rate_bps, retention_rate_bps, tds_section, tds_rate_bps,
          requires_labour_compliance, requires_engineer_certificate, created_by)
       VALUES ($1, $2, 'WC-2026-014', 'RCC framework, Tower 3', $3, $4, 'active',
               $5, '2026-02-01', '2026-11-30',
               100, 500, '194C', 200, true, true, $6)`,
      [contractId, tenantId, projectId, vendorId, rs(7_45_00_000), director],
    );

    /* ---- 3 · THE BOQ, ISSUED --------------------------------------- */
    const boqId = randomUUID();
    await client.query(
      `INSERT INTO boqs
         (id, tenant_id, project_id, contract_id, contract_ref, contract_date,
          contractor_vendor_id, work_package, code, title, status,
          retention_rate_bps, gst_rate_bps)
       VALUES ($1, $2, $3, $4, 'WC-2026-014', '2026-02-01', $5,
               'RCC framework', 'BOQ-RCC-01', 'RCC works, Tower 3 — plinth to terrace',
               'issued', 500, 1800)`,
      [boqId, tenantId, projectId, contractId, vendorId],
    );

    /*
     * Real rates, in the range a Bengaluru RCC subcontract actually runs
     * at in 2026. Round numbers would make the arithmetic on screen look
     * synthetic — and the point of the demo is that somebody can check it.
     */
    const items = [
      { code: "1.01", desc: "Excavation in ordinary soil for footings, up to 3 m depth", uom: "cum", cat: "earthwork", qty: 1_850, rate: 285 },
      { code: "2.01", desc: "PCC 1:4:8 levelling course under footings", uom: "cum", cat: "concrete", qty: 96, rate: 5_450 },
      { code: "2.03", desc: "M30 RCC in columns and shear walls", uom: "cum", cat: "concrete", qty: 1_000, rate: 6_800 },
      { code: "2.04", desc: "M30 RCC in beams and slabs", uom: "cum", cat: "concrete", qty: 1_420, rate: 6_620 },
      { code: "2.07", desc: "Fe500D reinforcement, cut bent and placed", uom: "kg", cat: "reinforcement", qty: 186_000, rate: 72 },
      { code: "3.02", desc: "Formwork to columns, beams and soffits, including props", uom: "sqm", cat: "formwork", qty: 9_400, rate: 385 },
    ] as const;

    const itemIds: Record<string, string> = {};
    let sequence = 0;

    for (const item of items) {
      const id = randomUUID();
      itemIds[item.code] = id;
      const quantityScaled = item.qty * M;
      const rateMinor = rs(item.rate);
      await client.query(
        `INSERT INTO boq_items
           (id, tenant_id, boq_id, item_code, sequence, description, uom, category,
            quantity_scaled, rate_minor, amount_minor)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          id, tenantId, boqId, item.code, ++sequence, item.desc, item.uom, item.cat,
          quantityScaled, rateMinor,
          // amount = quantity × rate, done in integers. Both are exact here.
          Math.round((quantityScaled / M) * rateMinor),
        ],
      );
    }

    /*
     * ⭐ ONE APPROVED VARIATION, so the "+ varied" line renders and the
     * over-billing guard has something non-trivial to authorise against.
     */
    await client.query(
      `UPDATE boq_items SET varied_quantity_scaled = $1 WHERE id = $2`,
      [150 * M, itemIds["2.03"]],
    );

    // The header sums are recomputed from the lines, exactly as
    // `addBoqItems()` does — never incremented, never typed.
    await client.query(
      `UPDATE boqs SET
         original_sum_minor = (SELECT COALESCE(SUM(amount_minor), 0) FROM boq_items
                                WHERE boq_id = $1 AND is_heading = false),
         revised_sum_minor  = (SELECT COALESCE(SUM(amount_minor), 0) FROM boq_items
                                WHERE boq_id = $1 AND is_heading = false)
       WHERE id = $1`,
      [boqId],
    );

    /* ---- 4 · THE MEASUREMENT BOOK ---------------------------------- */
    const bookId = randomUUID();
    await client.query(
      `INSERT INTO measurement_books
         (id, tenant_id, project_id, boq_id, book_number, title, opened_on, created_by)
       VALUES ($1, $2, $3, $4, 'MB-T3-01', 'Tower 3 RCC — book 1', '2026-03-01', $5)`,
      [bookId, tenantId, projectId, boqId, engineer],
    );

    /*
     * ⚠️ EVERY ROW NAMES A REAL GRID REFERENCE. "Location 1" would make
     * the measurement book meaningless as a demo — a measurement without
     * a place is not something anybody can verify on site, which is the
     * entire purpose of the register.
     */
    type Entry = {
      code: string;
      where: string;
      level: string | null;
      qty: number;
      on: string;
      deduction?: boolean;
      status: "recorded" | "checked" | "rejected";
      reason?: string;
    };

    const entries: Entry[] = [
      { code: "1.01", where: "Footings F1–F12, north half", level: "-2.10", qty: 980, on: "2026-03-08", status: "checked" },
      { code: "2.01", where: "Levelling course, footings F1–F12", level: "-2.10", qty: 52, on: "2026-03-14", status: "checked" },
      { code: "2.03", where: "Columns C1–C18, plinth to first floor", level: "+3.60", qty: 420, on: "2026-04-02", status: "checked" },
      // ⭐ The deduction: a void, entered POSITIVE and flagged.
      { code: "2.03", where: "Lift shaft void, Grid A2", level: "+3.60", qty: 40, on: "2026-04-02", deduction: true, status: "checked" },
      { code: "2.07", where: "Reinforcement, columns C1–C18", level: "+3.60", qty: 58_400, on: "2026-04-05", status: "checked" },
      { code: "3.02", where: "Column formwork, C1–C18", level: "+3.60", qty: 2_180, on: "2026-04-05", status: "checked" },
      // ⭐ Checked and unbilled — this is what makes "Ready to bill" non-empty.
      { code: "2.04", where: "First floor slab, Grid A–D / 1–6", level: "+7.20", qty: 386, on: "2026-05-18", status: "checked" },
      { code: "2.07", where: "Reinforcement, first floor slab", level: "+7.20", qty: 31_200, on: "2026-05-18", status: "checked" },
      // ⭐ Awaiting check — so the check control has something to act on.
      { code: "3.02", where: "Slab soffit formwork, Grid A–D / 1–6", level: "+7.20", qty: 1_640, on: "2026-05-20", status: "recorded" },
      // ⭐ Rejected, with a real reason.
      {
        code: "2.04", where: "Second floor slab, Grid A–D / 1–6", level: "+10.80", qty: 402, on: "2026-05-22",
        status: "rejected", reason: "Levels taken from the wrong datum — remeasure against the site benchmark, not the plinth.",
      },
    ];

    let entrySeq = 0;
    for (const entry of entries) {
      const checked = entry.status === "checked";
      await client.query(
        `INSERT INTO measurement_entries
           (id, tenant_id, measurement_book_id, boq_item_id, sequence, location_ref, level_ref,
            quantity_scaled, is_deduction, measured_on, measured_by, status,
            checked_by, checked_at, rejection_reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          randomUUID(), tenantId, bookId, itemIds[entry.code], ++entrySeq,
          entry.where, entry.level, entry.qty * M, entry.deduction ?? false,
          entry.on,
          // ⚠️ The ENGINEER measures. Always.
          engineer,
          entry.status,
          // ⚠️ The SURVEYOR checks — never the same person. A demo where
          // these matched would model the arrangement the product forbids.
          checked || entry.status === "rejected" ? surveyor : null,
          checked || entry.status === "rejected" ? new Date() : null,
          entry.reason ?? null,
        ],
      );
    }

    /* ---- 5 · RA-01, RAISED, CERTIFIED, APPROVED AND PAID ----------- */
    //
    // Assembled the way `raiseRaBillFromMeasurements()` does: the lines
    // come from the checked measurements, the rates from the BOQ.
    const bill1 = randomUUID();
    const bill1Lines = [
      { code: "1.01", qty: 980, rate: 285 },
      { code: "2.01", qty: 52, rate: 5_450 },
      { code: "2.03", qty: 380, rate: 6_800 }, // 420 measured less the 40 void
      { code: "2.07", qty: 58_400, rate: 72 },
      { code: "3.02", qty: 2_180, rate: 385 },
    ];
    const bill1Gross = bill1Lines.reduce((sum, l) => sum + Math.round(l.qty * rs(l.rate)), 0);

    await client.query(
      `INSERT INTO ra_bills
         (id, tenant_id, bill_no, sequence, contract_id, vendor_id, project_id,
          period_from, period_to, compliance_month, gross_value_minor,
          cess_rate_bps, retention_rate_bps, tds_section, tds_rate_bps,
          status, submitted_at, certified_by, certified_at, approved_by, approved_at,
          narration, created_by)
       VALUES ($1, $2, 'RA-01', 1, $3, $4, $5, '2026-03-01', '2026-04-30', '2026-04',
               $6, 100, 500, '194C', 200,
               'certified', now(), $7, now(), $8, now(),
               'Foundations and first lift of columns.', $9)`,
      [bill1, tenantId, contractId, vendorId, projectId, bill1Gross, surveyor, director, engineer],
    );

    for (const [index, line] of bill1Lines.entries()) {
      await client.query(
        `INSERT INTO ra_bill_lines
           (tenant_id, ra_bill_id, line_no, boq_item_id, boq_code, description, unit,
            quantity, rate_minor, amount_minor)
         SELECT $1, $2, $3, bi.id, bi.item_code, bi.description, bi.uom::text, $5, $6, $7
           FROM boq_items bi WHERE bi.id = $4`,
        [
          tenantId, bill1, index + 1, itemIds[line.code],
          line.qty, rs(line.rate), Math.round(line.qty * rs(line.rate)),
        ],
      );
    }

    await client.query(
      `UPDATE measurement_entries SET ra_bill_id = $1, status = 'billed'
        WHERE tenant_id = $2 AND status = 'checked' AND measured_on <= '2026-04-30'`,
      [bill1, tenantId],
    );

    /*
     * ⭐ THE PAYMENT GATE IS SATISFIED, NOT BYPASSED.
     *
     * SQL 0031 §4 refuses `status = 'paid'` without an engineer's
     * certificate and verified EPF and ESI challans for the compliance
     * month. Every one of those is created here, so the demo shows a bill
     * that was paid BECAUSE the evidence exists — which is the whole
     * point of the control.
     */
    await client.query(
      `INSERT INTO engineer_certifications
         (tenant_id, contract_id, vendor_id, period, is_cleared, certified_by,
          certified_by_name, certified_at, remarks)
       VALUES ($1, $2, $3, '2026-04', true, $4,
               'N. Deshpande, Quantity Surveyor', now(),
               'Cube results at 28 days meet M30. Cover checked at three locations.')`,
      [tenantId, contractId, vendorId, surveyor],
    );

    for (const [kind, challan, amount] of [
      ["epf", "KN/BNG/0044213/2026-04", rs(4_18_640)],
      ["esi", "31000452130000404", rs(1_09_220)],
    ] as const) {
      await client.query(
        `INSERT INTO compliance_docs
           (tenant_id, vendor_id, kind, period_month, challan_no, amount_minor,
            paid_on, status, verified_by, verified_at)
         VALUES ($1, $2, $3, '2026-04', $4, $5, '2026-05-12', 'verified', $6, now())`,
        [tenantId, vendorId, kind, challan, amount, surveyor],
      );
    }

    await client.query(
      `UPDATE ra_bills SET status = 'paid', paid_at = now(),
              payment_utr = 'UTR20260515HDFC0114892'
        WHERE id = $1`,
      [bill1],
    );

    /* ---- 6 · RA-02, CERTIFIED AND WAITING FOR APPROVAL ------------- */
    //
    // Left one step short on purpose, so the approve control has
    // something real to act on — and so the "you certified this" refusal
    // can be seen by signing in as the surveyor.
    const bill2 = randomUUID();
    const bill2Lines = [{ code: "2.04", qty: 386, rate: 6_620 }, { code: "2.07", qty: 31_200, rate: 72 }];
    const bill2Gross = bill2Lines.reduce((sum, l) => sum + Math.round(l.qty * rs(l.rate)), 0);

    await client.query(
      `INSERT INTO ra_bills
         (id, tenant_id, bill_no, sequence, contract_id, vendor_id, project_id,
          period_from, period_to, compliance_month, gross_value_minor,
          cess_rate_bps, retention_rate_bps, tds_section, tds_rate_bps,
          status, submitted_at, certified_by, certified_at, narration, created_by)
       VALUES ($1, $2, 'RA-02', 2, $3, $4, $5, '2026-05-01', '2026-05-31', '2026-05',
               $6, 100, 500, '194C', 200,
               'certified', now(), $7, now(),
               'First floor slab and its reinforcement.', $8)`,
      [bill2, tenantId, contractId, vendorId, projectId, bill2Gross, surveyor, engineer],
    );

    for (const [index, line] of bill2Lines.entries()) {
      await client.query(
        `INSERT INTO ra_bill_lines
           (tenant_id, ra_bill_id, line_no, boq_item_id, boq_code, description, unit,
            quantity, rate_minor, amount_minor)
         SELECT $1, $2, $3, bi.id, bi.item_code, bi.description, bi.uom::text, $5, $6, $7
           FROM boq_items bi WHERE bi.id = $4`,
        [
          tenantId, bill2, index + 1, itemIds[line.code],
          line.qty, rs(line.rate), Math.round(line.qty * rs(line.rate)),
        ],
      );
    }

    await client.query("COMMIT");

    /* ---- REPORT ---------------------------------------------------- */
    const summary = await pool.query(
      `SELECT
         (SELECT count(*) FROM boq_items WHERE tenant_id = $1)                                    AS boq_lines,
         (SELECT count(*) FROM measurement_entries WHERE tenant_id = $1)                          AS measurements,
         (SELECT count(*) FROM measurement_entries WHERE tenant_id = $1 AND status = 'recorded')  AS awaiting_check,
         (SELECT count(*) FROM measurement_entries
           WHERE tenant_id = $1 AND status = 'checked' AND ra_bill_id IS NULL)                    AS ready_to_bill,
         (SELECT count(*) FROM ra_bills WHERE tenant_id = $1)                                     AS bills,
         (SELECT count(*) FROM v_boq_billing_position
           WHERE tenant_id = $1 AND billed_over_measured_qty > 0)                                 AS over_claimed`,
      [tenantId],
    );

    const s = summary.rows[0];

    console.log("\n✅ Contracting demo seeded — Shirke Developers (demo)\n");
    console.log(`   BOQ lines .............. ${s.boq_lines}`);
    console.log(`   Measurements ........... ${s.measurements}`);
    console.log(`   Awaiting check ......... ${s.awaiting_check}   ← the check control has work`);
    console.log(`   Checked, unbilled ...... ${s.ready_to_bill}   ← "Ready to bill" is not empty`);
    console.log(`   RA bills ............... ${s.bills}   (RA-01 paid, RA-02 awaiting approval)`);
    console.log(`   Over-claimed lines ..... ${s.over_claimed}   ← must be 0\n`);

    if (Number(s.over_claimed) !== 0) {
      // The seeder writing an over-claim would mean its own figures
      // disagree with the BOQ it wrote — a broken demo that teaches the
      // wrong thing about the guard.
      console.error("🛑 The seed produced an over-claimed line. That is a bug in this script.");
      process.exitCode = 1;
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

main()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error("\n❌ Seed failed:", err instanceof Error ? err.message : err, "\n");
    await pool.end().catch(() => {});
    process.exit(1);
  });
