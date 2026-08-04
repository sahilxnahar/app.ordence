/**
 * Ordence — The contracting chain, end to end, against a real database
 * Version: v0.69.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS PROVES THAT NOTHING ELSE DOES
 * ══════════════════════════════════════════════════════════════════════
 * Every control in the construction half of this product is a database
 * trigger. There are eight of them across SQL 0031, 0038 and 0041, and
 * each was written to refuse one specific way a subcontractor gets paid
 * for work that was not done or not authorised.
 *
 * A trigger that exists and does not fire is worse than no trigger,
 * because the report above it says "0 problems found" with authority.
 * The only way to know is to attempt the thing it forbids and watch it
 * refuse.
 *
 * So this file walks one contract from an empty BOQ to an approved bill
 * and, at every step, tries the wrong thing first.
 *
 * ⚠️ THE SEPARATION-OF-DUTIES CONTROLS ARE NOT TESTED HERE. Self-check,
 * self-certify and self-approve live in the server actions
 * (`construction.ts`, `ra-bills.ts`) because they depend on a session
 * user, which the database has no notion of. This file covers what the
 * DATABASE guarantees regardless of which code path wrote the row —
 * including a path somebody adds next month that forgets the checks.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { asTenant, asSuperuser, expectError } from "../setup";

const TENANT = randomUUID();
const OTHER_TENANT = randomUUID();
const PROJECT = randomUUID();
const VENDOR = randomUUID();
const CONTRACT = randomUUID();
const BOQ = randomUUID();
const ITEM_CONCRETE = randomUUID();
const ITEM_STEEL = randomUUID();
const BOOK = randomUUID();
/**
 * ⚠️ A REAL USER ROW, NOT THE TENANT ID.
 *
 * `measurement_entries_check_attributed` requires a checked entry to name
 * its checker, and `measured_by` is a foreign key to `users`. Passing the
 * tenant id — which is a uuid and therefore looks fine — fails the check
 * constraint, which is the constraint doing its job: a measurement
 * attributable to nobody is not a measurement anybody can stand behind.
 */
const ENGINEER = randomUUID();
const CHECKER = randomUUID();

/** Micro-units: 1.000000 unit == 1_000_000. */
const M = 1_000_000;

beforeAll(async () => {
  await asSuperuser(async (client) => {
    for (const id of [TENANT, OTHER_TENANT]) {
      await client.query(
        `INSERT INTO tenants (id, name, slug, clerk_org_id, plan_tier, status)
         VALUES ($1, $2, $3, $4, 'enterprise', 'active')
         ON CONFLICT (id) DO NOTHING`,
        [id, `Contracting ${id.slice(0, 8)}`, `ct-${id.slice(0, 8)}`, `org_${id.slice(0, 8)}`],
      );
    }

    /*
     * ⚠️ TWO USERS, NOT ONE, AND THE SEPARATION IS THE POINT OF THE
     * FIXTURE. `measurement_entries_check_attributed` refuses a checked
     * entry with no named checker; the server action refuses a checker
     * who is also the measurer. Using one user here would satisfy the
     * database and quietly model the arrangement the product forbids.
     */
    for (const [id, email, role] of [
      [ENGINEER, "engineer@example.test", "member"],
      [CHECKER, "qs@example.test", "manager"],
    ] as const) {
      await client.query(
        `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, status)
         VALUES ($1, $2, $3, $4, $5, 'active')
         ON CONFLICT (id) DO NOTHING`,
        [id, TENANT, `user_${id.slice(0, 8)}`, email, role],
      );
    }

    await client.query(
      `INSERT INTO projects (id, tenant_id, code, name, budget_minor)
       VALUES ($1, $2, 'BSV-T3', 'Basaveshwar Tower 3', 380000000000)
       ON CONFLICT (id) DO NOTHING`,
      [PROJECT, TENANT],
    );

    await client.query(
      `INSERT INTO vendors (id, tenant_id, legal_name, code)
       VALUES ($1, $2, 'Shreyas Constructions', 'V-0142')
       ON CONFLICT (id) DO NOTHING`,
      [VENDOR, TENANT],
    );

    await client.query(
      `INSERT INTO works_contracts
         (id, tenant_id, contract_no, title, project_id, vendor_id, status,
          cess_rate_bps, retention_rate_bps, tds_section, tds_rate_bps)
       VALUES ($1, $2, 'WC-2026-014', 'RCC framework, Tower 3', $3, $4, 'active',
               100, 500, '194C', 200)
       ON CONFLICT (id) DO NOTHING`,
      [CONTRACT, TENANT, PROJECT, VENDOR],
    );

    await client.query(
      `INSERT INTO boqs
         (id, tenant_id, project_id, contract_id, work_package, code, title, status,
          contractor_vendor_id, retention_rate_bps)
       VALUES ($1, $2, $3, $4, 'RCC', 'BOQ-RCC-01', 'RCC works, Tower 3', 'issued', $5, 500)
       ON CONFLICT (id) DO NOTHING`,
      [BOQ, TENANT, PROJECT, CONTRACT, VENDOR],
    );

    // 1,000 cum authorised at ₹6,800/cum.
    await client.query(
      `INSERT INTO boq_items
         (id, tenant_id, boq_id, item_code, sequence, description, uom,
          quantity_scaled, rate_minor, amount_minor)
       VALUES ($1, $2, $3, '2.03', 1, 'M30 RCC in columns and shear walls', 'cum',
               $4, 680000, $5)
       ON CONFLICT (id) DO NOTHING`,
      [ITEM_CONCRETE, TENANT, BOQ, 1000 * M, 1000 * 680000],
    );

    // 60,000 kg of reinforcement at ₹72/kg.
    await client.query(
      `INSERT INTO boq_items
         (id, tenant_id, boq_id, item_code, sequence, description, uom,
          quantity_scaled, rate_minor, amount_minor)
       VALUES ($1, $2, $3, '2.07', 2, 'Fe500D reinforcement, cut bent and placed', 'kg',
               $4, 7200, $5)
       ON CONFLICT (id) DO NOTHING`,
      [ITEM_STEEL, TENANT, BOQ, 60000 * M, 60000 * 7200],
    );

    await client.query(
      `INSERT INTO measurement_books
         (id, tenant_id, project_id, boq_id, book_number, opened_on)
       VALUES ($1, $2, $3, $4, 'MB-T3-01', '2026-05-01')
       ON CONFLICT (id) DO NOTHING`,
      [BOOK, TENANT, PROJECT, BOQ],
    );
  });
});

afterAll(async () => {
  await asSuperuser(async (client) => {
    /*
     * ⚠️ THE MEASUREMENTS HAVE TO BE UNLINKED BEFORE THE TENANT GOES.
     *
     * SQL 0038's `measurement_entry_guard()` refuses to DELETE any entry
     * carrying an `ra_bill_id` — it is the evidence behind a certified
     * quantity, and erasing it would leave a paid bill with nothing
     * behind it. That guard fires on the cascade from `DELETE FROM
     * tenants` too, so teardown fails and every later run in the same
     * database inherits the leftovers.
     *
     * ⚠️ `session_replication_role = replica` SUPPRESSES USER TRIGGERS
     * FOR THIS CONNECTION ONLY, AND IT IS SCOPED TO TEARDOWN.
     *
     * Clearing `ra_bill_id` first does not help: the same guard fires on
     * the UPDATE, because `ra_bill_id` is one of the columns it watches.
     * The guard is right to refuse both — a billed measurement is
     * evidence — and a fixture at the end of a test run is the one place
     * where there is genuinely no bill left to protect it for.
     *
     * It is NOT `ALTER TABLE ... DISABLE TRIGGER`, which would change the
     * schema the rest of the suite runs against, and would leave it
     * changed if this block ever threw. `session_replication_role` dies
     * with the connection.
     */
    await client.query("SET session_replication_role = replica");
    try {
      await client.query("DELETE FROM tenants WHERE id = ANY($1)", [[TENANT, OTHER_TENANT]]);
    } finally {
      await client.query("SET session_replication_role = origin");
    }
  });
});

/* ------------------------------------------------------------------ */

describe("a measurement is arithmetic, and the sign of a deduction matters", () => {
  it("records a straightforward measurement", async () => {
    const id = randomUUID();
    await asTenant(TENANT, async (client) => {
      await client.query(
        `INSERT INTO measurement_entries
           (id, tenant_id, measurement_book_id, boq_item_id, sequence, location_ref,
            quantity_scaled, measured_on, measured_by, status, checked_by, checked_at)
         VALUES ($1, $2, $3, $4, 1, 'Grid A1-A4, plinth to first floor',
                 $5, '2026-05-14', $6, 'checked', $7, now())`,
        [id, TENANT, BOOK, ITEM_CONCRETE, 420 * M, ENGINEER, CHECKER],
      );
    });

    const measured = await asTenant(TENANT, async (client) => {
      const { rows } = await client.query(
        `SELECT measured_qty FROM v_boq_billing_position WHERE boq_item_id = $1`,
        [ITEM_CONCRETE],
      );
      return rows[0]?.measured_qty;
    });

    expect(Number(measured)).toBe(420);
  });

  it("⚠️ a deduction SUBTRACTS — a lift shaft void is not 40 more cubic metres of concrete", async () => {
    await asTenant(TENANT, async (client) => {
      await client.query(
        `INSERT INTO measurement_entries
           (id, tenant_id, measurement_book_id, boq_item_id, sequence, location_ref,
            quantity_scaled, is_deduction, measured_on, measured_by, status,
            checked_by, checked_at)
         VALUES ($1, $2, $3, $4, 2, 'Lift shaft void, Grid A2',
                 $5, true, '2026-05-14', $6, 'checked', $7, now())`,
        [randomUUID(), TENANT, BOOK, ITEM_CONCRETE, 40 * M, ENGINEER, CHECKER],
      );
    });

    const measured = await asTenant(TENANT, async (client) => {
      const { rows } = await client.query(
        `SELECT measured_qty FROM v_boq_billing_position WHERE boq_item_id = $1`,
        [ITEM_CONCRETE],
      );
      return rows[0]?.measured_qty;
    });

    // 420 − 40, not 420 + 40. Summed as a positive the contractor is paid
    // for the hole as if it were wall.
    expect(Number(measured)).toBe(380);
  });

  it("a rejected measurement counts as nothing at all", async () => {
    await asTenant(TENANT, async (client) => {
      await client.query(
        `INSERT INTO measurement_entries
           (id, tenant_id, measurement_book_id, boq_item_id, sequence, location_ref,
            quantity_scaled, measured_on, measured_by, status, rejection_reason)
         VALUES ($1, $2, $3, $4, 3, 'Grid B1 — remeasure, levels wrong',
                 $5, '2026-05-15', $6, 'rejected', 'Levels taken from the wrong datum.')`,
        [randomUUID(), TENANT, BOOK, ITEM_CONCRETE, 999 * M, ENGINEER],
      );
    });

    const measured = await asTenant(TENANT, async (client) => {
      const { rows } = await client.query(
        `SELECT measured_qty FROM v_boq_billing_position WHERE boq_item_id = $1`,
        [ITEM_CONCRETE],
      );
      return rows[0]?.measured_qty;
    });

    expect(Number(measured)).toBe(380);
  });
});

/* ------------------------------------------------------------------ */

describe("⭐ a bill cannot claim more than the BOQ authorises (SQL 0041 §3)", () => {
  const BILL_1 = randomUUID();

  it("raises a first bill for measured work", async () => {
    await asTenant(TENANT, async (client) => {
      await client.query(
        `INSERT INTO ra_bills
           (id, tenant_id, bill_no, sequence, contract_id, vendor_id, project_id,
            gross_value_minor, cess_rate_bps, retention_rate_bps, tds_section, tds_rate_bps, status)
         VALUES ($1, $2, 'RA-01', 1, $3, $4, $5, 0, 100, 500, '194C', 200, 'draft')`,
        [BILL_1, TENANT, CONTRACT, VENDOR, PROJECT],
      );

      await client.query(
        `INSERT INTO ra_bill_lines
           (tenant_id, ra_bill_id, line_no, boq_item_id, boq_code, description,
            unit, quantity, rate_minor, amount_minor)
         VALUES ($1, $2, 1, $3, '2.03', 'M30 RCC', 'cum', 380, 680000, $4)`,
        [TENANT, BILL_1, ITEM_CONCRETE, 380 * 680000],
      );
    });

    const billed = await asTenant(TENANT, async (client) => {
      const { rows } = await client.query(
        `SELECT billed_qty, billed_over_measured_qty
           FROM v_boq_billing_position WHERE boq_item_id = $1`,
        [ITEM_CONCRETE],
      );
      return rows[0];
    });

    expect(Number(billed.billed_qty)).toBe(380);
    // Billed exactly what was measured. Nothing to investigate.
    expect(Number(billed.billed_over_measured_qty)).toBe(0);
  });

  it("⚠️ REFUSES a cumulative claim beyond the authorised quantity — this is the loss the guard exists for", async () => {
    const bill2 = randomUUID();

    await asTenant(TENANT, async (client) => {
      await client.query(
        `INSERT INTO ra_bills
           (id, tenant_id, bill_no, sequence, contract_id, vendor_id, project_id,
            gross_value_minor, cess_rate_bps, retention_rate_bps, status)
         VALUES ($1, $2, 'RA-02', 2, $3, $4, $5, 0, 100, 500, 'draft')`,
        [bill2, TENANT, CONTRACT, VENDOR, PROJECT],
      );
    });

    // 380 already claimed + 700 = 1,080 against 1,000 authorised.
    const error = await expectError(() =>
      asTenant(TENANT, async (client) =>
        client.query(
          `INSERT INTO ra_bill_lines
             (tenant_id, ra_bill_id, line_no, boq_item_id, boq_code, description,
              unit, quantity, rate_minor, amount_minor)
           VALUES ($1, $2, 1, $3, '2.03', 'M30 RCC', 'cum', 700, 680000, $4)`,
          [TENANT, bill2, ITEM_CONCRETE, 700 * 680000],
        ),
      ),
    );

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/authorises only 1000/i);
    // The message must name the item, not just complain — an operator who
    // cannot tell WHICH line is over will try a different route to the
    // same wrong outcome.
    expect(error?.message).toMatch(/2\.03/);
  });

  it("allows the same claim once a variation authorises the extra quantity", async () => {
    const bill3 = randomUUID();

    await asSuperuser(async (client) => {
      // +150 cum approved as a variation order.
      await client.query(
        `UPDATE boq_items SET varied_quantity_scaled = $1 WHERE id = $2`,
        [150 * M, ITEM_CONCRETE],
      );
    });

    await asTenant(TENANT, async (client) => {
      await client.query(
        `INSERT INTO ra_bills
           (id, tenant_id, bill_no, sequence, contract_id, vendor_id, project_id,
            gross_value_minor, cess_rate_bps, retention_rate_bps, status)
         VALUES ($1, $2, 'RA-03', 3, $3, $4, $5, 0, 100, 500, 'draft')`,
        [bill3, TENANT, CONTRACT, VENDOR, PROJECT],
      );

      // 380 + 700 = 1,080, now against 1,150 authorised.
      await client.query(
        `INSERT INTO ra_bill_lines
           (tenant_id, ra_bill_id, line_no, boq_item_id, boq_code, description,
            unit, quantity, rate_minor, amount_minor)
         VALUES ($1, $2, 1, $3, '2.03', 'M30 RCC (incl. VO-02)', 'cum', 700, 680000, $4)`,
        [TENANT, bill3, ITEM_CONCRETE, 700 * 680000],
      );
    });

    const position = await asTenant(TENANT, async (client) => {
      const { rows } = await client.query(
        `SELECT authorised_qty, billed_qty FROM v_boq_billing_position WHERE boq_item_id = $1`,
        [ITEM_CONCRETE],
      );
      return rows[0];
    });

    expect(Number(position.authorised_qty)).toBe(1150);
    expect(Number(position.billed_qty)).toBe(1080);
  });

  it("⚠️ never blocks day-work, which legitimately has no BOQ line behind it", async () => {
    const bill4 = randomUUID();

    await asTenant(TENANT, async (client) => {
      await client.query(
        `INSERT INTO ra_bills
           (id, tenant_id, bill_no, sequence, contract_id, vendor_id, project_id,
            gross_value_minor, cess_rate_bps, retention_rate_bps, status)
         VALUES ($1, $2, 'RA-04', 4, $3, $4, $5, 0, 100, 500, 'draft')`,
        [bill4, TENANT, CONTRACT, VENDOR, PROJECT],
      );

      await client.query(
        `INSERT INTO ra_bill_lines
           (tenant_id, ra_bill_id, line_no, boq_code, description, unit,
            quantity, rate_minor, amount_minor)
         VALUES ($1, $2, 1, NULL, 'Day-work: dewatering after unseasonal rain',
                 'day', 3, 450000, $3)`,
        [TENANT, bill4, 3 * 450000],
      );
    });

    const lines = await asTenant(TENANT, async (client) => {
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM ra_bill_lines WHERE ra_bill_id = $1`,
        [bill4],
      );
      return rows[0]?.n;
    });

    expect(Number(lines)).toBe(1);
  });
});

/* ------------------------------------------------------------------ */

describe("the money is derived, never typed (SQL 0031 §3)", () => {
  it("⭐ computes cess, retention, TDS and net payable from the gross value alone", async () => {
    const bill = randomUUID();

    const written = await asTenant(TENANT, async (client) => {
      await client.query(
        `INSERT INTO ra_bills
           (id, tenant_id, bill_no, sequence, contract_id, vendor_id, project_id,
            gross_value_minor, cess_rate_bps, retention_rate_bps,
            tds_section, tds_rate_bps, status)
         VALUES ($1, $2, 'RA-05', 5, $3, $4, $5,
                 10000000, 100, 500, '194C', 200, 'draft')`,
        [bill, TENANT, CONTRACT, VENDOR, PROJECT],
      );

      const { rows } = await client.query(
        `SELECT cess_amount_minor, retention_amount_minor,
                tds_amount_minor, net_payable_minor
           FROM ra_bills WHERE id = $1`,
        [bill],
      );
      return rows[0];
    });

    // Gross ₹1,00,000.00 == 10,000,000 paise.
    expect(Number(written.cess_amount_minor)).toBe(100000); //   1% BOCW cess
    expect(Number(written.retention_amount_minor)).toBe(500000); // 5% retention
    expect(Number(written.tds_amount_minor)).toBe(200000); //     2% TDS 194C

    // ⚠️ Net is gross MINUS all three, minus previous paid. Nobody types
    // this number: a typed net payable that disagrees with its own
    // deductions is a payment nobody can reconcile and everybody signs.
    expect(Number(written.net_payable_minor)).toBe(10000000 - 100000 - 500000 - 200000);
  });

  it("⚠️ OVERWRITES a caller who supplies their own deduction amounts", async () => {
    const bill = randomUUID();

    const written = await asTenant(TENANT, async (client) => {
      await client.query(
        `INSERT INTO ra_bills
           (id, tenant_id, bill_no, sequence, contract_id, vendor_id, project_id,
            gross_value_minor, cess_rate_bps, retention_rate_bps,
            tds_section, tds_rate_bps,
            cess_amount_minor, retention_amount_minor, tds_amount_minor,
            net_payable_minor, status)
         VALUES ($1, $2, 'RA-06', 6, $3, $4, $5,
                 10000000, 100, 500, '194C', 200,
                 0, 0, 0, 10000000, 'draft')`,
        [bill, TENANT, CONTRACT, VENDOR, PROJECT],
      );

      const { rows } = await client.query(
        `SELECT retention_amount_minor, net_payable_minor FROM ra_bills WHERE id = $1`,
        [bill],
      );
      return rows[0];
    });

    // A caller asking for zero retention and full payment is ignored.
    // This is the whole reason the arithmetic lives in a trigger rather
    // than in whichever code path happens to write the row.
    expect(Number(written.retention_amount_minor)).toBe(500000);
    expect(Number(written.net_payable_minor)).toBe(9200000);
  });

  it("⚠️ carries forward what was PAID, not what was raised — a running account runs on money that moved", async () => {
    /*
     * This assertion was written the wrong way round first: it expected a
     * non-zero carry-forward because several bills exist on the contract.
     * They do — and every one of them is `draft`.
     *
     * SQL 0031 sums `net_payable_minor` only `WHERE status = 'paid'`, and
     * that is the correct definition. "Previously paid" on an RA bill is
     * a statement about money that has left the account. Summing raised
     * bills instead would deduct amounts the contractor has not received
     * from the amount they are owed — the contractor's own running
     * account would be short by everything still in approval, and it
     * would look arithmetically consistent the whole way down.
     */
    const carried = await asTenant(TENANT, async (client) => {
      const { rows } = await client.query(
        `SELECT previous_paid_minor FROM ra_bills WHERE contract_id = $1 ORDER BY sequence DESC LIMIT 1`,
        [CONTRACT],
      );
      return rows[0]?.previous_paid_minor;
    });

    expect(Number(carried)).toBe(0);
  });

  it("⚠️ REFUSES to pay without the engineer's certificate and the EPF/ESI evidence (SQL 0031 §4)", async () => {
    /*
     * This test was going to mark the bill paid directly and move on to
     * the carry-forward. The gate refused, which is exactly right, and
     * the refusal is worth asserting on its own: it is the control this
     * whole phase was built for.
     *
     * ⚠️ THE FAILURE MODE IT PREVENTS IS NOT A COMPLIANCE ONE. Under the
     * BOCW Act and the EPF Act, a principal employer who pays a
     * contractor that has not remitted its workers' provident fund
     * becomes liable for the shortfall. The money is gone, the workers
     * are unpaid, and the liability lands on the developer.
     */
    const error = await expectError(() =>
      asSuperuser(async (client) =>
        client.query(
          `UPDATE ra_bills SET status = 'paid' WHERE contract_id = $1 AND sequence = 5`,
          [CONTRACT],
        ),
      ),
    );

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/certificate/i);
  });

  it("carries the money forward once an earlier bill is genuinely cleared and paid", async () => {
    await asSuperuser(async (client) => {
      /*
       * ⚠️ THE GATE IS SATISFIED, NOT DISABLED. Every piece of evidence
       * it asks for is supplied: a compliance month on the bill, an
       * engineer's certificate for that month, and verified EPF and ESI
       * challans for the vendor. Turning the trigger off instead would
       * make this test pass against a schema the product does not ship.
       */
      await client.query(
        `UPDATE ra_bills SET compliance_month = '2026-05' WHERE contract_id = $1 AND sequence = 5`,
        [CONTRACT],
      );

      await client.query(
        `INSERT INTO engineer_certifications
           (tenant_id, contract_id, vendor_id, period, is_cleared, certified_by_name, certified_at)
         VALUES ($1, $2, $3, '2026-05', true, 'R. Kulkarni, Resident Engineer', now())`,
        [TENANT, CONTRACT, VENDOR],
      );

      for (const kind of ["epf", "esi"] as const) {
        await client.query(
          `INSERT INTO compliance_docs
             (tenant_id, vendor_id, kind, period_month, challan_no, status, verified_at)
           VALUES ($1, $2, $3, '2026-05', $4, 'verified', now())`,
          [TENANT, VENDOR, kind, `CH-${kind.toUpperCase()}-2026-05`],
        );
      }

      await client.query(
        `UPDATE ra_bills SET status = 'paid', paid_at = now(), payment_utr = 'UTR20260531HDFC0009142'
          WHERE contract_id = $1 AND sequence = 5`,
        [CONTRACT],
      );
    });

    const carried = await asTenant(TENANT, async (client) => {
      const bill = randomUUID();

      /*
       * ⚠️ THE SEQUENCE IS READ, NOT HARD-CODED. It was written as a
       * literal first and broke the moment a test above it added a bill:
       * SQL 0031 §5 refuses a gap, so a fixture that assumes it knows the
       * next number is a test that fails for a reason unrelated to what
       * it is about. Reading max+1 is also exactly what
       * `raiseRaBillFromMeasurements()` does, for the same reason.
       */
      const { rows: seqRows } = await client.query(
        `SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM ra_bills WHERE contract_id = $1`,
        [CONTRACT],
      );
      const next = Number(seqRows[0]?.next ?? 1);

      await client.query(
        `INSERT INTO ra_bills
           (id, tenant_id, bill_no, sequence, contract_id, vendor_id, project_id,
            gross_value_minor, cess_rate_bps, retention_rate_bps, status)
         VALUES ($1, $2, 'RA-CF', $6, $3, $4, $5, 5000000, 100, 500, 'draft')`,
        [bill, TENANT, CONTRACT, VENDOR, PROJECT, next],
      );

      const { rows } = await client.query(
        `SELECT previous_paid_minor FROM ra_bills WHERE id = $1`,
        [bill],
      );
      return rows[0]?.previous_paid_minor;
    });

    // RA-05 was ₹1,00,000 gross → ₹92,000 net payable.
    expect(Number(carried)).toBe(9200000);
  });

  it("⚠️ `previous_paid` is CARRIED, NOT DEDUCTED — subtracting it would take the same money off twice", async () => {
    /*
     * SQL 0031 computes:
     *
     *     net = gross − cess − retention − TDS − other deductions
     *
     * and `previous_paid_minor` is deliberately absent from that sum.
     * `gross_value_minor` is the value of THIS bill's work, not the
     * cumulative position, so deducting earlier payments would short the
     * contractor by everything they have already been paid.
     *
     * ⚠️ THIS TEST EXISTS BECAUSE THE MISTAKE WAS ACTUALLY MADE. The RA
     * bill detail page listed "Less: previously paid" in the deduction
     * column — a total that did not foot, on the one screen a
     * subcontractor checks their payment against. They would not conclude
     * the screen was wrong; they would conclude they were being underpaid.
     */
    const bill = randomUUID();

    const written = await asTenant(TENANT, async (client) => {
      const { rows: seqRows } = await client.query(
        `SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM ra_bills WHERE contract_id = $1`,
        [CONTRACT],
      );

      await client.query(
        `INSERT INTO ra_bills
           (id, tenant_id, bill_no, sequence, contract_id, vendor_id, project_id,
            gross_value_minor, cess_rate_bps, retention_rate_bps,
            tds_section, tds_rate_bps, status)
         VALUES ($1, $2, 'RA-FOOT', $6, $3, $4, $5,
                 10000000, 100, 500, '194C', 200, 'draft')`,
        [bill, TENANT, CONTRACT, VENDOR, PROJECT, Number(seqRows[0]?.next ?? 1)],
      );

      const { rows } = await client.query(
        `SELECT gross_value_minor, cess_amount_minor, retention_amount_minor,
                tds_amount_minor, other_deductions_minor,
                previous_paid_minor, net_payable_minor
           FROM ra_bills WHERE id = $1`,
        [bill],
      );
      return rows[0];
    });

    const n = (v: unknown) => Number(v ?? 0);

    // The column that IS the net payable.
    expect(
      n(written.gross_value_minor) -
        n(written.cess_amount_minor) -
        n(written.retention_amount_minor) -
        n(written.tds_amount_minor) -
        n(written.other_deductions_minor),
    ).toBe(n(written.net_payable_minor));

    // And `previous_paid` is non-zero here — so if it were part of the
    // sum, the assertion above would have failed rather than passed
    // vacuously.
    expect(n(written.previous_paid_minor)).toBeGreaterThan(0);
  });

});

/* ------------------------------------------------------------------ */

describe("bills run in sequence and cannot skip (SQL 0031 §5)", () => {
  it("⚠️ refuses a gap — RA-09 after RA-06 would hide three bills nobody can find", async () => {
    const error = await expectError(() =>
      asTenant(TENANT, async (client) =>
        client.query(
          // ⚠️ THE GAP IS DERIVED, NOT HARD-CODED. A literal sequence
          // breaks the moment a test above adds a bill — and then this
          // fails for a reason that has nothing to do with gaps.
          `INSERT INTO ra_bills
             (id, tenant_id, bill_no, sequence, contract_id, vendor_id, project_id,
              gross_value_minor, cess_rate_bps, retention_rate_bps, status)
           SELECT $1, $2, 'RA-GAP', COALESCE(MAX(sequence), 0) + 3, $3, $4, $5,
                  100000, 100, 500, 'draft'
             FROM ra_bills WHERE contract_id = $3 AND tenant_id = $2`,
          [randomUUID(), TENANT, CONTRACT, VENDOR, PROJECT],
        ),
      ),
    );

    expect(error).not.toBeNull();
  });
});

/* ------------------------------------------------------------------ */

describe("tenant isolation holds across the whole chain", () => {
  it("⚠️ another tenant sees none of it — not the BOQ, not the bills, not the position", async () => {
    const seen = await asTenant(OTHER_TENANT, async (client) => {
      const boq = await client.query(`SELECT count(*)::int AS n FROM boqs WHERE id = $1`, [BOQ]);
      const bills = await client.query(
        `SELECT count(*)::int AS n FROM ra_bills WHERE contract_id = $1`,
        [CONTRACT],
      );
      const position = await client.query(
        `SELECT count(*)::int AS n FROM v_boq_billing_position WHERE boq_item_id = $1`,
        [ITEM_CONCRETE],
      );
      return {
        boq: boq.rows[0]?.n,
        bills: bills.rows[0]?.n,
        position: position.rows[0]?.n,
      };
    });

    expect(seen.boq).toBe(0);
    expect(seen.bills).toBe(0);
    // ⚠️ The VIEW is the one most likely to leak: without
    // `security_invoker = true` it runs as its owner and RLS does not
    // apply, which would expose every tenant's contract values at once.
    expect(seen.position).toBe(0);
  });

  it("⚠️ a bill line cannot reference another tenant's BOQ item", async () => {
    const foreignBoq = randomUUID();
    const foreignItem = randomUUID();
    const foreignProject = randomUUID();

    await asSuperuser(async (client) => {
      await client.query(
        `INSERT INTO projects (id, tenant_id, code, name) VALUES ($1, $2, 'X', 'Other project')`,
        [foreignProject, OTHER_TENANT],
      );
      await client.query(
        `INSERT INTO boqs (id, tenant_id, project_id, work_package, code, title)
         VALUES ($1, $2, $3, 'X', 'BOQ-X', 'Other BOQ')`,
        [foreignBoq, OTHER_TENANT, foreignProject],
      );
      await client.query(
        `INSERT INTO boq_items
           (id, tenant_id, boq_id, item_code, sequence, description, uom,
            quantity_scaled, rate_minor, amount_minor)
         VALUES ($1, $2, $3, 'X.01', 1, 'Other work', 'cum', $4, 100, 100)`,
        [foreignItem, OTHER_TENANT, foreignBoq, 100 * M],
      );
    });

    const bill = randomUUID();
    await asTenant(TENANT, async (client) => {
      // Sequence read rather than assumed — SQL 0031 §5 refuses a gap,
      // so a hard-coded number breaks whenever a test above adds a bill.
      const { rows: seqRows } = await client.query(
        `SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM ra_bills WHERE contract_id = $1`,
        [CONTRACT],
      );
      await client.query(
        `INSERT INTO ra_bills
           (id, tenant_id, bill_no, sequence, contract_id, vendor_id, project_id,
            gross_value_minor, cess_rate_bps, retention_rate_bps, status)
         VALUES ($1, $2, 'RA-07', $6, $3, $4, $5, 0, 100, 500, 'draft')`,
        [bill, TENANT, CONTRACT, VENDOR, PROJECT, Number(seqRows[0]?.next ?? 1)],
      );
    });

    // The composite FK `(boq_item_id, tenant_id)` makes this
    // unrepresentable rather than merely invisible — RLS alone would hide
    // the parent and leave a child row pointing at nothing.
    const error = await expectError(() =>
      asTenant(TENANT, async (client) =>
        client.query(
          `INSERT INTO ra_bill_lines
             (tenant_id, ra_bill_id, line_no, boq_item_id, description, unit,
              quantity, rate_minor, amount_minor)
           VALUES ($1, $2, 1, $3, 'Cross-tenant claim', 'cum', 1, 100, 100)`,
          [TENANT, bill, foreignItem],
        ),
      ),
    );

    expect(error).not.toBeNull();
  });
});

/* ------------------------------------------------------------------ */

describe("a billed measurement is frozen (SQL 0038)", () => {
  it("⚠️ refuses to change a measurement that is already on a bill", async () => {
    const entry = randomUUID();
    const bill = randomUUID();

    await asTenant(TENANT, async (client) => {
      // Sequence read rather than assumed — SQL 0031 §5 refuses a gap,
      // so a hard-coded number breaks whenever a test above adds a bill.
      const { rows: seqRows } = await client.query(
        `SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM ra_bills WHERE contract_id = $1`,
        [CONTRACT],
      );
      await client.query(
        `INSERT INTO ra_bills
           (id, tenant_id, bill_no, sequence, contract_id, vendor_id, project_id,
            gross_value_minor, cess_rate_bps, retention_rate_bps, status)
         VALUES ($1, $2, 'RA-08', $6, $3, $4, $5, 0, 100, 500, 'draft')`,
        [bill, TENANT, CONTRACT, VENDOR, PROJECT, Number(seqRows[0]?.next ?? 1)],
      );

      await client.query(
        `INSERT INTO measurement_entries
           (id, tenant_id, measurement_book_id, boq_item_id, sequence, location_ref,
            quantity_scaled, measured_on, measured_by, status, ra_bill_id)
         VALUES ($1, $2, $3, $4, 20, 'Grid C1', $5, '2026-06-01', $6, 'billed', $7)`,
        [entry, TENANT, BOOK, ITEM_STEEL, 12000 * M, ENGINEER, bill],
      );
    });

    const error = await expectError(() =>
      asTenant(TENANT, async (client) =>
        client.query(`UPDATE measurement_entries SET quantity_scaled = $1 WHERE id = $2`, [
          99000 * M,
          entry,
        ]),
      ),
    );

    // Editing a billed measurement changes what a contractor was paid
    // against, after the fact, leaving the bill and the book disagreeing
    // with no record of which was right.
    expect(error).not.toBeNull();
  });
});
