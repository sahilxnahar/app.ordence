/**
 * Ordence — 0146: A PINNED GST RATE MUST BE THIS TENANT'S RATE
 * Version: v0.34.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE IS ACTUALLY TRYING TO PROVE
 * ══════════════════════════════════════════════════════════════════════
 * 0021 §3 spent a page on one hole and then closed it — for the two
 * tables that existed at the time:
 *
 *     a line in tenant A carrying gst_rate_id = <a rate row owned by B>
 *
 * `sales_invoice_lines` (0049) and `sales_order_lines` (0028) were added
 * afterwards with `REFERENCES hsn_sac_rates(id)` — the single-column form
 * that page exists to say is not enough. Which is to say: the two tables
 * carrying every outward supply the product actually raises had the hole,
 * and the two that do not raise anything did not.
 *
 * 🔴 AND ROW-LEVEL SECURITY DOES NOT COVER FOR IT, WHICH IS THE PART
 * THAT SURPRISES PEOPLE. PostgreSQL runs referential-integrity checks as
 * the referenced table's owner WITH ROW SECURITY OFF. So the foreign key
 * cheerfully resolves a row the writing session cannot see, cannot read
 * and cannot name. The first test below proves both halves of that in one
 * place: the row is invisible under RLS, and the write is refused anyway
 * — by the KEY, not by the policy.
 *
 * 🔴 THE SECOND HALF OF THE SAME OMISSION. `enforce_gst_rate_history_
 * immutable` refuses to move a rate period out from under a document that
 * used it, and counted usage through `invoice_lines` ONLY. Ordence's own
 * subscription invoices. It was blind to every customer invoice in the
 * product, so a rate could be re-dated or re-priced under a filed sales
 * invoice and the trigger written to prevent exactly that reported
 * nothing at all. 0146 moved the count into `gst_rate_usage()`; §3 below
 * asks that function what it can see, and then proves the guards act on
 * the answer.
 *
 * ⭐ EVERY REFUSAL HERE HAS A SIBLING ASSERTING THE CORRESPONDING CORRECT
 * WRITE IS ACCEPTED. A composite key that refused every pin would pass
 * every refusal test in this file and make the rate registry unusable.
 *
 * ⚠️ EVERY DATABASE ASSERTION RUNS AS THE ORDINARY APPLICATION ROLE.
 * `asSuperuser` appears for fixtures, for teardown, and in exactly ONE
 * assertion — the DELETE case in §4, which is labelled and argued where
 * it stands, because the application role holds no DELETE grant on the
 * table at all and the trigger under test can therefore be reached from
 * nowhere else.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { asTenant, asSuperuser, expectError } from "../setup";

/* ================================================================== */
/* FIXTURES                                                            */
/* ================================================================== */

let tenantA: string;
let tenantB: string;
let companyA: string;
let codeA: string;
let codeUsage: string;
let codeUnused: string;
/** Tenant B's classification — the one tenant A must not be able to cite. */
let codeB: string;

/** Tenant A's 18% period, the legitimate pin target. */
let rateA: string;
/** ⭐ Pinned by exactly ONE line, created in `beforeAll` and never touched. */
let rateUsage: string;
/** Never pinned by anything. The negative half of every history assertion. */
let rateUnused: string;
/** ⭐ TENANT B's 5% period. Tenant A can neither see it nor cite it. */
let rateB: string;

let invA: string;
let ordA: string;

/** Both documents are dated here. */
const DOC_DATE = "2026-08-19";

beforeAll(async () => {
  tenantA = randomUUID();
  tenantB = randomUUID();
  companyA = randomUUID();
  codeA = randomUUID();
  codeUsage = randomUUID();
  codeUnused = randomUUID();
  codeB = randomUUID();
  rateA = randomUUID();
  rateUsage = randomUUID();
  rateUnused = randomUUID();
  rateB = randomUUID();
  invA = randomUUID();
  ordA = randomUUID();

  await asSuperuser(async (c) => {
    for (const [id, name, slug] of [
      [tenantA, "Rate Pin A", "pin-a"],
      [tenantB, "Rate Pin B", "pin-b"],
    ] as const) {
      await c.query(
        `INSERT INTO tenants (id, clerk_org_id, slug, name, status)
         VALUES ($1,$2,$3,$4,'active')`,
        [id, `org_${id}`, `${slug}-${id.slice(0, 8)}`, name],
      );
    }

    await c.query(`INSERT INTO companies (id, tenant_id, name) VALUES ($1,$2,'Pin Customer')`, [
      companyA,
      tenantA,
    ]);

    // ⭐ THE SAME SAC CODE IN BOTH WORKSPACES. Two businesses classifying
    // the same service identically is the ordinary case, and it is what
    // makes the cross-tenant pin plausible rather than exotic: the ids
    // differ, the codes do not, and a resolver that keyed off the code
    // would hand back the wrong row without anything looking wrong.
    await c.query(
      `INSERT INTO hsn_sac_codes (id, tenant_id, code, kind, description)
       VALUES ($1,$2,'998314','sac','Engineering services'),
              ($3,$2,'998315','sac','Engineering services, second'),
              ($4,$2,'998316','sac','Engineering services, third'),
              ($5,$6,'998314','sac','Engineering services')`,
      [codeA, tenantA, codeUsage, codeUnused, codeB, tenantB],
    );

    await c.query(
      `INSERT INTO hsn_sac_rates
         (id, tenant_id, hsn_sac_id, rate_bps, effective_from, notification_ref)
       VALUES ($1,$2,$3,1800, DATE '2017-07-01','Notification 11/2017-CT(R)'),
              ($4,$2,$5,1800, DATE '2017-07-01','Notification 11/2017-CT(R)'),
              ($6,$2,$7,1800, DATE '2017-07-01','Notification 11/2017-CT(R)'),
              ($8,$9,$10,500, DATE '2017-07-01','Notification 03/2019-CT(R)')`,
      [rateA, tenantA, codeA, rateUsage, codeUsage, rateUnused, codeUnused, rateB, tenantB, codeB],
    );

    await c.query(
      `INSERT INTO sales_invoices
         (id, tenant_id, invoice_number, financial_year, status, company_id,
          invoice_date, place_of_supply_code, is_inter_state, supply_type, currency)
       VALUES ($1,$2,$3,'2026-27','draft',$4, DATE '${DOC_DATE}','29',true,'services','INR')`,
      [invA, tenantA, `PIN/INV/${invA.slice(0, 8)}`, companyA],
    );

    await c.query(
      `INSERT INTO sales_orders
         (id, tenant_id, order_no, status, order_date, company_id,
          place_of_supply_code, place_of_supply_basis, is_inter_state,
          supply_type, currency)
       VALUES ($1,$2,$3,'draft', DATE '${DOC_DATE}',$4,
               '29','recipient_registration',true,'services','INR')`,
      [ordA, tenantA, `PIN/SO/${ordA.slice(0, 8)}`, companyA],
    );

    /* --- ⭐ THE ONE LINE THAT MAKES `rateUsage` A USED RATE --------- */
    //
    // It is created here rather than inside a test on purpose: every
    // history assertion in §3 depends on this line existing, and a test
    // that depends on ANOTHER test having run first is a test that fails
    // for the wrong reason the day somebody reorders the file.
    await c.query(
      `INSERT INTO sales_invoice_lines
         (tenant_id, invoice_id, line_no, description, quantity, uom,
          unit_price_minor, taxable_value_minor, tax_rate_bps, igst_minor,
          hsn_sac_rate_id)
       VALUES ($1,$2,1,'the line that uses the rate',1,'nos',
               100000,100000,1800,18000,$3)`,
      [tenantA, invA, rateUsage],
    );
  });
});

afterAll(async () => {
  await asSuperuser(async (c) => {
    const tenants = [tenantA, tenantB];

    // ⚠️ Lines before rates. The composite key this file installs is
    // ON DELETE RESTRICT, so a teardown that removed a rate a line still
    // pins would be refused — which is the guarantee, working.
    await c.query(`DELETE FROM sales_invoice_lines WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM sales_invoices WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM sales_order_lines WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM sales_orders WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM companies WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM hsn_sac_rates WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM hsn_sac_codes WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM change_log WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM tenants WHERE id = ANY($1::uuid[])`, [tenants]);

    // The composite keys must still be installed, and the single-column
    // forms must still be gone. A test run that left the table with the
    // old key would report green here forever afterwards.
    const { rows } = await c.query(
      `SELECT conname FROM pg_constraint
        WHERE conname IN ('sales_invoice_lines_rate_same_tenant',
                          'sales_invoice_lines_hsn_same_tenant',
                          'sales_order_lines_rate_same_tenant',
                          'sales_order_lines_hsn_same_tenant',
                          'sales_invoice_lines_hsn_sac_rate_id_hsn_sac_rates_id_fk',
                          'sales_order_lines_hsn_sac_rate_id_hsn_sac_rates_id_fk')`,
    );
    const names = rows.map((r) => r.conname).sort();
    expect(names).toEqual([
      "sales_invoice_lines_hsn_same_tenant",
      "sales_invoice_lines_rate_same_tenant",
      "sales_order_lines_hsn_same_tenant",
      "sales_order_lines_rate_same_tenant",
    ]);
  });
});

/* ================================================================== */
/* 1. ⭐⭐ THE CROSS-TENANT PIN, ON BOTH SALES TABLES                  */
/* ================================================================== */

/**
 * ⚠️ EVERY CROSS-TENANT LINE BELOW IS ARITHMETICALLY CORRECT AT THE
 * OTHER TENANT'S RATE, AND THAT IS DELIBERATE.
 *
 * 0147's BEFORE trigger fires ahead of the foreign key. A line that
 * failed ITS check would abort with a `check_violation` and this file
 * would record the pin as refused while proving nothing about the key
 * 0146 installed. So the line is given nothing for 0147 to object to —
 * 500 bps on ₹1,000 is ₹50, tenant B's rate, and tenant B's period
 * covers the document date — leaving the composite key as the only thing
 * left in the room that can refuse it.
 */
describe("⭐⭐ a line may not pin a rate that belongs to another workspace", () => {
  it("⭐⭐ REFUSES a sales_invoice_lines row in A pinned to B's rate — and RLS is not what refuses it", async () => {
    // ══════════════════════════════════════════════════════════════
    // THE PROOF THAT ROW-LEVEL SECURITY WAS NEVER GOING TO CATCH THIS.
    //
    // First: tenant A genuinely cannot see the row. The policy works.
    // Then: tenant A cites it anyway, and the write is refused with
    // 23503 — a FOREIGN KEY violation, not a policy violation. Before
    // 0146 that exact insert SUCCEEDED (PROOF 2a), because PostgreSQL
    // runs referential integrity as the referenced table's owner with
    // row security OFF. The invisible row was reachable all along.
    // ══════════════════════════════════════════════════════════════
    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(`SELECT id FROM hsn_sac_rates WHERE id = $1`, [rateB]);
      expect(rows, "tenant A must not be able to READ tenant B's rate row").toHaveLength(0);
    });

    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(
          `INSERT INTO sales_invoice_lines
             (tenant_id, invoice_id, line_no, description, quantity, uom,
              unit_price_minor, taxable_value_minor, tax_rate_bps, igst_minor,
              hsn_sac_rate_id)
           VALUES ($1,$2,10,'cross-tenant rate pin',1,'nos',
                   100000,100000,500,5000,$3)`,
          [tenantA, invA, rateB],
        ),
      ),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23503");
    expect(error!.message).toMatch(/sales_invoice_lines_rate_same_tenant/);
  });

  it("⭐ ACCEPTS a sales_invoice_lines row pinned to its OWN workspace's rate", async () => {
    // ⚠️ THE SIBLING. A composite key that refused everything would pass
    // the test above and make the entire rate registry unusable — and
    // the failure would arrive as "cannot save invoice", with the key
    // named nowhere in the message.
    await asTenant(tenantA, async (c) =>
      c.query(
        `INSERT INTO sales_invoice_lines
           (tenant_id, invoice_id, line_no, description, quantity, uom,
            unit_price_minor, taxable_value_minor, tax_rate_bps, igst_minor,
            hsn_sac_rate_id)
         VALUES ($1,$2,11,'same-tenant rate pin',1,'nos',
                 100000,100000,1800,18000,$3)`,
        [tenantA, invA, rateA],
      ),
    );

    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(
        `SELECT hsn_sac_rate_id FROM sales_invoice_lines WHERE invoice_id = $1 AND line_no = 11`,
        [invA],
      );
      expect(rows[0].hsn_sac_rate_id).toBe(rateA);
    });
  });

  it("⭐ REFUSES a sales_invoice_lines row pinned to another workspace's CLASSIFICATION", async () => {
    // The rate is the expensive column; the classification is the one
    // that decides which rate applies. 0146 gave both the composite
    // form, because a line citing tenant B's HSN row is a line whose
    // provenance points into a workspace we cannot even read.
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(
          `INSERT INTO sales_invoice_lines
             (tenant_id, invoice_id, line_no, description, quantity, uom,
              unit_price_minor, taxable_value_minor, tax_rate_bps, igst_minor,
              hsn_sac_code_id)
           VALUES ($1,$2,12,'cross-tenant classification',1,'nos',
                   100000,100000,1800,18000,$3)`,
          [tenantA, invA, codeB],
        ),
      ),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23503");
    expect(error!.message).toMatch(/sales_invoice_lines_hsn_same_tenant/);
  });

  it("ACCEPTS a sales_invoice_lines row citing its own workspace's classification", async () => {
    await asTenant(tenantA, async (c) =>
      c.query(
        `INSERT INTO sales_invoice_lines
           (tenant_id, invoice_id, line_no, description, quantity, uom,
            unit_price_minor, taxable_value_minor, tax_rate_bps, igst_minor,
            hsn_sac_code_id)
         VALUES ($1,$2,13,'same-tenant classification',1,'nos',
                 100000,100000,1800,18000,$3)`,
        [tenantA, invA, codeA],
      ),
    );

    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(
        `SELECT hsn_sac_code_id FROM sales_invoice_lines WHERE invoice_id = $1 AND line_no = 13`,
        [invA],
      );
      expect(rows[0].hsn_sac_code_id).toBe(codeA);
    });
  });

  it("⭐ REFUSES a sales_order_lines row in A pinned to B's rate", async () => {
    // ⚠️ THE SECOND TABLE IS NOT A COPY OF THE FIRST TEST. 0146 exists
    // because two tables with the same column had opposite behaviour and
    // nobody noticed for two waves. Asserting one of them and assuming
    // the other is the exact reasoning that produced the defect.
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(
          `INSERT INTO sales_order_lines
             (tenant_id, order_id, line_no, description, quantity, uom,
              unit_price_minor, taxable_value_minor, tax_rate_bps, igst_minor,
              hsn_sac_rate_id)
           VALUES ($1,$2,10,'cross-tenant rate pin',1,'nos',
                   100000,100000,500,5000,$3)`,
          [tenantA, ordA, rateB],
        ),
      ),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23503");
    expect(error!.message).toMatch(/sales_order_lines_rate_same_tenant/);
  });

  it("⭐ ACCEPTS a sales_order_lines row pinned to its OWN workspace's rate", async () => {
    await asTenant(tenantA, async (c) =>
      c.query(
        `INSERT INTO sales_order_lines
           (tenant_id, order_id, line_no, description, quantity, uom,
            unit_price_minor, taxable_value_minor, tax_rate_bps, igst_minor,
            hsn_sac_rate_id)
         VALUES ($1,$2,11,'same-tenant rate pin',1,'nos',
                 100000,100000,1800,18000,$3)`,
        [tenantA, ordA, rateA],
      ),
    );

    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(
        `SELECT hsn_sac_rate_id FROM sales_order_lines WHERE order_id = $1 AND line_no = 11`,
        [ordA],
      );
      expect(rows[0].hsn_sac_rate_id).toBe(rateA);
    });
  });

  it("⭐ REFUSES a sales_order_lines row citing another workspace's CLASSIFICATION", async () => {
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(
          `INSERT INTO sales_order_lines
             (tenant_id, order_id, line_no, description, quantity, uom,
              unit_price_minor, taxable_value_minor, tax_rate_bps, igst_minor,
              hsn_sac_code_id)
           VALUES ($1,$2,12,'cross-tenant classification',1,'nos',
                   100000,100000,1800,18000,$3)`,
          [tenantA, ordA, codeB],
        ),
      ),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23503");
    expect(error!.message).toMatch(/sales_order_lines_hsn_same_tenant/);
  });

  it("ACCEPTS a sales_order_lines row citing its own workspace's classification", async () => {
    await asTenant(tenantA, async (c) =>
      c.query(
        `INSERT INTO sales_order_lines
           (tenant_id, order_id, line_no, description, quantity, uom,
            unit_price_minor, taxable_value_minor, tax_rate_bps, igst_minor,
            hsn_sac_code_id)
         VALUES ($1,$2,13,'same-tenant classification',1,'nos',
                 100000,100000,1800,18000,$3)`,
        [tenantA, ordA, codeA],
      ),
    );

    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(
        `SELECT hsn_sac_code_id FROM sales_order_lines WHERE order_id = $1 AND line_no = 13`,
        [ordA],
      );
      expect(rows[0].hsn_sac_code_id).toBe(codeA);
    });
  });
});

/* ================================================================== */
/* 2. ⭐ THE OTHER DIRECTION: B CANNOT REACH INTO A                    */
/* ================================================================== */

describe("the same key holds in the other direction", () => {
  it("tenant B cannot pin tenant A's rate onto its own document either", async () => {
    // ⚠️ NOT SYMMETRY FOR ITS OWN SAKE. The realistic version of this
    // defect is an import script running under one workspace with ids
    // copied from another's export, and it does not care which way round
    // the two workspaces are.
    const invB = randomUUID();
    const companyB = randomUUID();

    await asSuperuser(async (c) => {
      await c.query(`INSERT INTO companies (id, tenant_id, name) VALUES ($1,$2,'B Customer')`, [
        companyB,
        tenantB,
      ]);
      await c.query(
        `INSERT INTO sales_invoices
           (id, tenant_id, invoice_number, financial_year, status, company_id,
            invoice_date, place_of_supply_code, is_inter_state, supply_type, currency)
         VALUES ($1,$2,$3,'2026-27','draft',$4, DATE '${DOC_DATE}','29',true,'services','INR')`,
        [invB, tenantB, `PIN/B/${invB.slice(0, 8)}`, companyB],
      );
    });

    const error = await expectError(() =>
      asTenant(tenantB, async (c) =>
        c.query(
          `INSERT INTO sales_invoice_lines
             (tenant_id, invoice_id, line_no, description, quantity, uom,
              unit_price_minor, taxable_value_minor, tax_rate_bps, igst_minor,
              hsn_sac_rate_id)
           VALUES ($1,$2,1,'B pinning A',1,'nos',100000,100000,1800,18000,$3)`,
          [tenantB, invB, rateA],
        ),
      ),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23503");

    await asSuperuser(async (c) => {
      await c.query(`DELETE FROM sales_invoice_lines WHERE invoice_id = $1`, [invB]);
      await c.query(`DELETE FROM sales_invoices WHERE id = $1`, [invB]);
    });
  });
});

/* ================================================================== */
/* 3. ⭐⭐ THE HISTORY GUARD CAN SEE OUTWARD SUPPLIES                  */
/* ================================================================== */

describe("⭐⭐ gst_rate_usage counts through sales_invoice_lines", () => {
  it("⭐⭐ reports the ONE sales invoice line that pins the rate, with its document's date", async () => {
    // ══════════════════════════════════════════════════════════════
    // THE FUNCTION IS ASKED DIRECTLY, BEFORE ANY GUARD IS TESTED.
    //
    // Before 0146 this answered ZERO for every outward supply in the
    // product, because it counted `invoice_lines` — Ordence's own
    // subscription billing — and nothing else. Every assertion below
    // about a rate being un-editable rests on this number being right,
    // so it is measured rather than assumed: a guard that refuses
    // nothing and a guard that is never reached look identical from the
    // far side of an `expectError`.
    // ══════════════════════════════════════════════════════════════
    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(
        `SELECT used::text AS used, earliest::text AS earliest, latest::text AS latest
           FROM gst_rate_usage($1)`,
        [rateUsage],
      );
      expect(rows[0].used).toBe("1");
      expect(rows[0].earliest).toBe(DOC_DATE);
      expect(rows[0].latest).toBe(DOC_DATE);
    });
  });

  it("reports ZERO for a rate nothing has ever pinned", async () => {
    // ⚠️ THE SIBLING FOR THE COUNT ITSELF. A `gst_rate_usage` that
    // returned a positive number for everything would make every guard
    // below fire, every assertion in this section pass, and the rate
    // registry read-only forever.
    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(`SELECT used::text AS used FROM gst_rate_usage($1)`, [
        rateUnused,
      ]);
      expect(rows[0].used).toBe("0");
    });
  });

  it("⭐⭐ a rate used by a SALES INVOICE line cannot have its rate_bps edited", async () => {
    // The quiet catastrophe this prevents: correcting 18% to 5% in the
    // master silently restates every document ever raised under it. No
    // error, no audit entry, no visible change — the PDFs already sent
    // to customers simply stop agreeing with what this system now
    // believes, and it surfaces at an assessment years later.
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(`UPDATE hsn_sac_rates SET rate_bps = 500 WHERE id = $1`, [rateUsage]),
      ),
    );

    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/already been used/i);
    expect(error!.message).toMatch(/1 document line/);

    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(`SELECT rate_bps FROM hsn_sac_rates WHERE id = $1`, [
        rateUsage,
      ]);
      expect(rows[0].rate_bps).toBe(1800);
    });
  });

  it("⭐⭐ a rate used by a SALES INVOICE line cannot have its window moved off the document", async () => {
    // The subtler attack on the same history: leave the figure alone and
    // move the period. A document dated 2026-08-19 pinned to a period
    // that begins in September points at a rate that was not in force on
    // its own date — provenance that reads as evidence and is not.
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(`UPDATE hsn_sac_rates SET effective_from = DATE '2026-09-01' WHERE id = $1`, [
          rateUsage,
        ]),
      ),
    );

    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/cannot start on/i);
    expect(error!.message).toMatch(new RegExp(DOC_DATE));
  });

  it("⭐ but the window may still be moved to a date that STILL covers the document", async () => {
    // ⚠️ THE SIBLING, AND THE REASON THE GUARD IS A DATE COMPARISON
    // RATHER THAN A FREEZE. Rate periods are genuinely edited: a
    // notification is published with one commencement date and corrected
    // to another. A guard that froze the row outright would make that
    // unrecordable, and the person who needs to record it edits the
    // table with the trigger disabled.
    await asTenant(tenantA, async (c) => {
      await c.query(`UPDATE hsn_sac_rates SET effective_from = DATE '2026-01-01' WHERE id = $1`, [
        rateUsage,
      ]);
      const { rows } = await c.query(
        `SELECT effective_from::text AS f FROM hsn_sac_rates WHERE id = $1`,
        [rateUsage],
      );
      expect(rows[0].f).toBe("2026-01-01");
    });
  });

  it("⭐ a rate used by a SALES INVOICE line cannot be closed before the document's date", async () => {
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(`UPDATE hsn_sac_rates SET effective_to = DATE '2026-01-02' WHERE id = $1`, [
          rateUsage,
        ]),
      ),
    );

    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/cannot end on/i);
  });

  it("closing a period AFTER the last document that used it still works", async () => {
    // ⚠️ THE SIBLING. Closing a period is how a superseded rate is
    // retired — it is the correct, everyday operation, and refusing it
    // would leave the only way to record a rate change being to edit the
    // old row in place, which is the thing the guard above exists to
    // stop.
    await asTenant(tenantA, async (c) => {
      await c.query(`UPDATE hsn_sac_rates SET effective_to = DATE '2026-08-20' WHERE id = $1`, [
        rateUsage,
      ]);
      const { rows } = await c.query(
        `SELECT effective_to::text AS t FROM hsn_sac_rates WHERE id = $1`,
        [rateUsage],
      );
      expect(rows[0].t).toBe("2026-08-20");
    });
  });
});

/* ================================================================== */
/* 4. ⭐ AN UNUSED RATE IS STILL AN ORDINARY ROW                       */
/* ================================================================== */

describe("⭐ a rate nothing has used remains editable and removable", () => {
  it("⭐ its rate_bps can be corrected", async () => {
    // ══════════════════════════════════════════════════════════════
    // THE HALF THAT KEEPS THE REGISTRY USABLE.
    //
    // Somebody types 1200 where the notification says 1800 and notices
    // before raising a document against it. If the guards keyed off the
    // row EXISTING rather than the row being USED, that typo would be
    // permanent and the only remedy would be a second period papering
    // over the first — which is exactly the shape of history this phase
    // exists to keep honest.
    // ══════════════════════════════════════════════════════════════
    await asTenant(tenantA, async (c) => {
      await c.query(`UPDATE hsn_sac_rates SET rate_bps = 500 WHERE id = $1`, [rateUnused]);
      const { rows } = await c.query(`SELECT rate_bps FROM hsn_sac_rates WHERE id = $1`, [
        rateUnused,
      ]);
      expect(rows[0].rate_bps).toBe(500);
      // Put it back, so this test leaves the fixture as it found it.
      await c.query(`UPDATE hsn_sac_rates SET rate_bps = 1800 WHERE id = $1`, [rateUnused]);
    });
  });

  it("its window can be moved freely, in either direction", async () => {
    await asTenant(tenantA, async (c) => {
      await c.query(
        `UPDATE hsn_sac_rates SET effective_from = DATE '2020-01-01' WHERE id = $1`,
        [rateUnused],
      );
      await c.query(
        `UPDATE hsn_sac_rates SET effective_from = DATE '2017-07-01' WHERE id = $1`,
        [rateUnused],
      );
      const { rows } = await c.query(
        `SELECT effective_from::text AS f FROM hsn_sac_rates WHERE id = $1`,
        [rateUnused],
      );
      expect(rows[0].f).toBe("2017-07-01");
    });
  });

  it("⚠️ the APPLICATION ROLE cannot delete any rate at all — there is no grant", async () => {
    // ⭐ THIS IS THE FIRST OF THE TWO LAYERS AND IT IS THE ONE THE
    // PRODUCT ACTUALLY MEETS. `ordence_app` holds SELECT, INSERT and
    // UPDATE on `hsn_sac_rates` and no DELETE. So no code path in this
    // product can remove a rate period, used or not, and the trigger
    // below is a second line of defence for the psql session and the
    // migration runner.
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(`DELETE FROM hsn_sac_rates WHERE id = $1`, [rateUnused]),
      ),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("42501");
    expect(error!.message).toMatch(/permission denied/i);
  });

  it("⭐ block_used_gst_rate_delete refuses the USED rate and allows the UNUSED one", async () => {
    // ══════════════════════════════════════════════════════════════
    // ⚠️ THE ONE ASSERTION IN THIS FILE THAT RUNS ON `asSuperuser`, AND
    //    WHY THAT IS NOT THE USUAL MISTAKE.
    //
    // The usual mistake is asserting ISOLATION on a superuser
    // connection: a superuser bypasses row-level security completely, so
    // the assertion passes on a database with no policies at all. That
    // is not what is being asserted here. `block_used_gst_rate_delete`
    // is a TRIGGER, and triggers are not bypassed by anybody —
    // superuser, table owner or otherwise.
    //
    // It has to be reached from here because the test above proves the
    // application role cannot issue a DELETE at all. The alternative is
    // to leave "an unused rate is still removable" untested, and then
    // the day the guard starts counting the row itself as a usage,
    // nothing anywhere notices.
    //
    // ⭐ BOTH HALVES IN ONE TEST, DELIBERATELY: the refusal is only
    // meaningful beside a delete that succeeds on the same connection,
    // in the same file, one statement apart.
    // ══════════════════════════════════════════════════════════════
    const spareCode = randomUUID();
    const spareRate = randomUUID();

    await asSuperuser(async (c) => {
      await c.query(
        `INSERT INTO hsn_sac_codes (id, tenant_id, code, kind, description)
         VALUES ($1,$2,'998317','sac','disposable')`,
        [spareCode, tenantA],
      );
      await c.query(
        `INSERT INTO hsn_sac_rates (id, tenant_id, hsn_sac_id, rate_bps, effective_from)
         VALUES ($1,$2,$3,1800, DATE '2017-07-01')`,
        [spareRate, tenantA, spareCode],
      );

      // The USED one is refused, by the trigger, naming the count.
      let refused: { message?: string } | null = null;
      try {
        await c.query(`DELETE FROM hsn_sac_rates WHERE id = $1`, [rateUsage]);
      } catch (err) {
        refused = err as { message?: string };
      }
      expect(refused, "a rate a sales invoice line pins must not be deletable").not.toBeNull();
      expect(refused!.message).toMatch(/cannot be deleted/i);

      // The UNUSED one goes, in the very next statement.
      const { rowCount } = await c.query(`DELETE FROM hsn_sac_rates WHERE id = $1`, [spareRate]);
      expect(rowCount, "an unused rate must still be removable").toBe(1);

      await c.query(`DELETE FROM hsn_sac_codes WHERE id = $1`, [spareCode]);
    });

    // And the used rate is still there, unchanged, read back as the
    // ordinary role — which is where the claim actually has to hold.
    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(`SELECT rate_bps FROM hsn_sac_rates WHERE id = $1`, [
        rateUsage,
      ]);
      expect(rows[0].rate_bps).toBe(1800);
    });
  });
});
