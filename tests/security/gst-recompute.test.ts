/**
 * Ordence — 0147: A LINE'S STORED GST MUST SURVIVE BEING RECOMPUTED
 * Version: v0.34.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE IS ACTUALLY TRYING TO PROVE
 * ══════════════════════════════════════════════════════════════════════
 * 0021 §6 proves an invoice HEADER equals the sum of its LINES. That is
 * footing, and footing is not arithmetic: a document whose header agrees
 * with its own lines is internally consistent and can still be wrong in
 * every figure on it. Before 0147 the database accepted
 *
 *     taxable_value_minor = 100000, tax_rate_bps = 1800, igst_minor = 1
 *
 * on `sales_invoice_lines` — the table GSTR-1 is built from — with no
 * complaint whatsoever, because both of those columns arrive from the
 * client and nothing has ever compared them.
 *
 * So the tests below do not read `pg_trigger`. A row in `pg_trigger`
 * proves a NAME was registered; it does not prove the trigger refuses
 * anything, and the distance between those two facts is the one this
 * codebase keeps falling into. Every case here ATTEMPTS THE WRITE.
 *
 * ⭐ AND EVERY REFUSAL HAS A SIBLING THAT ASSERTS THE CORRESPONDING
 * CORRECT WRITE IS ACCEPTED. A trigger that refuses everything passes
 * every refusal test ever written and takes the product down on the
 * first invoice somebody raises. The acceptances are not padding; they
 * are the half that catches the failure mode a refusal test cannot see.
 *
 * ⭐⭐ THE LAST SECTION IS THE ONE THAT MATTERS MOST. 0147 §1 had to
 * justify writing a SECOND implementation of the GST rounding, in SQL,
 * beside the TypeScript one in `lib/billing/money.ts`. The risk it took
 * on is not that the trigger refuses too little — it is that the two
 * implementations disagree on one case in ten thousand and the database
 * begins refusing CORRECT invoices for a reason nobody can reproduce.
 * 0147 §5 proves the SQL matches the transcribed rule. This file runs
 * the SAME TABLE OF CASES through the REAL TypeScript functions, so that
 * between them the two halves prove the implementations match EACH
 * OTHER, which is the only claim anybody actually needs.
 *
 * ⚠️ EVERY DATABASE ASSERTION RUNS AS THE ORDINARY APPLICATION ROLE.
 * `asSuperuser` appears only for fixtures and teardown, because a
 * superuser bypasses row-level security entirely and a suite written on
 * one proves nothing.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { asTenant, asSuperuser, expectError } from "../setup";

/**
 * ⭐ THE REAL FUNCTIONS, IMPORTED. NOT A TRANSCRIPTION OF THEM.
 *
 * The whole point of the parity section is to catch the day somebody
 * edits `applyRateBps` and does not edit `gst_apply_rate_bps`. Hard-
 * coding the expected values on the TypeScript side would freeze the
 * answer this file believes in and the edit would sail straight past it.
 */
import { applyRateBps, splitEvenly } from "@/lib/billing/money";

/* ================================================================== */
/* FIXTURES                                                            */
/* ================================================================== */

let tenantA: string;
let companyA: string;
let vendorA: string;
let codeA: string;
/** The superseded 12% period: [2017-07-01, 2019-04-01). */
let rate12: string;
/** The 18% period in force: [2019-04-01, open). */
let rate18: string;
/** Intra-state (Maharashtra to Maharashtra) — CGST + SGST. */
let invIntra: string;
/** Inter-state (Maharashtra to Karnataka) — IGST. */
let invInter: string;
/** A purchase bill carrying the SUPPLIER'S figures, which are not ours. */
let billSupplierFigures: string;
/** A purchase bill used for the pin cases. */
let billPinned: string;

/** Every document in this file is dated here, inside the 18% period. */
const DOC_DATE = "2026-08-19";

beforeAll(async () => {
  tenantA = randomUUID();
  companyA = randomUUID();
  vendorA = randomUUID();
  codeA = randomUUID();
  rate12 = randomUUID();
  rate18 = randomUUID();
  invIntra = randomUUID();
  invInter = randomUUID();
  billSupplierFigures = randomUUID();
  billPinned = randomUUID();

  await asSuperuser(async (c) => {
    await c.query(
      `INSERT INTO tenants (id, clerk_org_id, slug, name, status)
       VALUES ($1,$2,$3,'GST Recompute','active')`,
      [tenantA, `org_${tenantA}`, `rec-${tenantA.slice(0, 8)}`],
    );

    await c.query(`INSERT INTO companies (id, tenant_id, name) VALUES ($1,$2,'Recompute Customer')`, [
      companyA,
      tenantA,
    ]);
    await c.query(
      `INSERT INTO vendors (id, tenant_id, code, legal_name) VALUES ($1,$2,'V-REC','Recompute Vendor')`,
      [vendorA, tenantA],
    );

    await c.query(
      `INSERT INTO hsn_sac_codes (id, tenant_id, code, kind, description)
       VALUES ($1,$2,'998314','sac','Engineering services')`,
      [codeA, tenantA],
    );

    // ⭐ TWO PERIODS, NOT ONE. A single open-ended rate cannot express the
    // case this phase is actually about: a pin that names a REAL period
    // belonging to a DIFFERENT year from the document that cites it.
    await c.query(
      `INSERT INTO hsn_sac_rates
         (id, tenant_id, hsn_sac_id, rate_bps, cess_rate_bps, effective_from, effective_to)
       VALUES ($1,$2,$3,1200,0, DATE '2017-07-01', DATE '2019-04-01'),
              ($4,$2,$3,1800,0, DATE '2019-04-01', NULL)`,
      [rate12, tenantA, codeA, rate18],
    );

    await c.query(
      `INSERT INTO sales_invoices
         (id, tenant_id, invoice_number, financial_year, status, company_id,
          invoice_date, place_of_supply_code, is_inter_state, supply_type, currency)
       VALUES ($1,$2,$3,'2026-27','draft',$4, DATE '${DOC_DATE}','27',false,'services','INR'),
              ($5,$2,$6,'2026-27','draft',$4, DATE '${DOC_DATE}','29',true, 'services','INR')`,
      [
        invIntra,
        tenantA,
        `REC/INTRA/${invIntra.slice(0, 8)}`,
        companyA,
        invInter,
        `REC/INTER/${invInter.slice(0, 8)}`,
      ],
    );

    /* --- ⭐ TWO PURCHASE BILLS ------------------------------------- */
    //
    // ⚠️ `gst_computed` IS LEFT FALSE, WHICH IS ITS DEFAULT AND ALSO THE
    // TRUTH. 0021 §6's deferred reconciliation trigger opts in on that
    // flag; leaving it false keeps THIS file's subject — the per-line
    // BEFORE trigger from 0147 — the only thing under test, rather than
    // silently measuring a header-versus-lines check as well. The header
    // figures below still match the lines that persist, so nothing here
    // depends on that trigger being asleep.
    await c.query(
      `INSERT INTO purchase_invoices
         (id, tenant_id, vendor_id, invoice_number, invoice_date, status,
          subtotal_minor, discount_minor, taxable_value_minor,
          cgst_minor, sgst_minor, igst_minor, cess_minor, total_minor,
          itc_eligible_tax_minor, itc_blocked_tax_minor)
       VALUES ($1,$2,$3,$4, DATE '${DOC_DATE}','draft',
               100000, 0, 100000, 1, 1, 0, 0, 100002, 2, 0)`,
      [billSupplierFigures, tenantA, vendorA, `SUP/${billSupplierFigures.slice(0, 8)}`],
    );
    await c.query(
      `INSERT INTO purchase_invoices
         (id, tenant_id, vendor_id, invoice_number, invoice_date, status,
          subtotal_minor, discount_minor, taxable_value_minor,
          cgst_minor, sgst_minor, igst_minor, cess_minor, total_minor,
          itc_eligible_tax_minor, itc_blocked_tax_minor)
       VALUES ($1,$2,$3,$4, DATE '${DOC_DATE}','draft',
               100000, 0, 100000, 9000, 9000, 0, 0, 118000, 18000, 0)`,
      [billPinned, tenantA, vendorA, `PIN/${billPinned.slice(0, 8)}`],
    );
  });
});

afterAll(async () => {
  await asSuperuser(async (c) => {
    // ⚠️ Order matters, and it is the schema telling us something. The
    // foreign key from every line table to `hsn_sac_rates` is RESTRICT —
    // a rate a document used cannot be removed — so a teardown that
    // deleted rates first would be refused. That refusal is the guarantee
    // 0146 installed and 0147 builds on.
    await c.query(`DELETE FROM sales_invoice_lines WHERE tenant_id = $1`, [tenantA]);
    await c.query(`DELETE FROM sales_invoices WHERE tenant_id = $1`, [tenantA]);
    await c.query(`DELETE FROM purchase_invoice_lines WHERE tenant_id = $1`, [tenantA]);
    await c.query(`DELETE FROM purchase_invoices WHERE tenant_id = $1`, [tenantA]);
    await c.query(`DELETE FROM vendors WHERE tenant_id = $1`, [tenantA]);
    await c.query(`DELETE FROM companies WHERE tenant_id = $1`, [tenantA]);
    await c.query(`DELETE FROM hsn_sac_rates WHERE tenant_id = $1`, [tenantA]);
    await c.query(`DELETE FROM hsn_sac_codes WHERE tenant_id = $1`, [tenantA]);
    await c.query(`DELETE FROM change_log WHERE tenant_id = $1`, [tenantA]);
    await c.query(`DELETE FROM tenants WHERE id = $1`, [tenantA]);

    // Prove the guard is still enabled. A teardown that disabled one
    // would void the guarantee for every later run — and the suite would
    // still pass, which is the dangerous part.
    const { rows } = await c.query(
      `SELECT tgname, tgenabled::text AS state FROM pg_trigger
        WHERE tgname LIKE '%_gst_recomputes' AND NOT tgisinternal`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const row of rows) expect(row.state, row.tgname).toBe("O");
  });
});

/** Insert one `sales_invoice_lines` row as the ordinary application role. */
function insertSalesLine(
  invoiceId: string,
  lineNo: number,
  cols: {
    taxable: number;
    rateBps?: number | null;
    cgst?: number;
    sgst?: number;
    igst?: number;
    pin?: string | null;
    description?: string;
  },
) {
  return asTenant(tenantA, async (c) =>
    c.query(
      `INSERT INTO sales_invoice_lines
         (tenant_id, invoice_id, line_no, description, quantity, uom,
          unit_price_minor, taxable_value_minor, tax_rate_bps,
          cgst_minor, sgst_minor, igst_minor, hsn_sac_rate_id)
       VALUES ($1,$2,$3,$4,1,'nos',$5,$5,$6,$7,$8,$9,$10)`,
      [
        tenantA,
        invoiceId,
        lineNo,
        cols.description ?? `line ${lineNo}`,
        cols.taxable,
        cols.rateBps ?? null,
        cols.cgst ?? 0,
        cols.sgst ?? 0,
        cols.igst ?? 0,
        cols.pin ?? null,
      ],
    ),
  );
}

/* ================================================================== */
/* 1. ⭐ THE ARITHMETIC — A LINE MUST RECOMPUTE FROM ITS OWN COLUMNS   */
/* ================================================================== */

describe("⭐ a line's stored tax must be what its own taxable value and rate produce", () => {
  it("⭐⭐ REFUSES the exact row 0147's PROOF 1 recorded: ₹1,000 at 18%, one paisa of IGST", async () => {
    // The figure is not nearly right. It is off by ₹179.99, on a table
    // GSTR-1 is built from, and every layer between the client and the
    // row accepted it: the validator types `taxRateBps` as a number, the
    // action passes it through, and nothing compared it to the money.
    const error = await expectError(() =>
      insertSalesLine(invInter, 1, { taxable: 100000, rateBps: 1800, igst: 1 }),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23514");
    expect(error!.message).toMatch(/does not recompute/i);
    // The message must name BOTH answers. "Constraint violated" sends the
    // reader to the schema; this sends them to the figure.
    expect(error!.message).toMatch(/18000/);
  });

  it("⭐ ACCEPTS the same line with the tax the same rate actually produces", async () => {
    // ⚠️ THE SIBLING, AND IT IS NOT DECORATION. A trigger that raised on
    // every row would pass the test above and refuse every invoice this
    // product raises. Only this assertion can tell those two apart.
    await insertSalesLine(invInter, 2, {
      taxable: 100000,
      rateBps: 1800,
      igst: 18000,
      description: "correct inter-state",
    });

    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(
        `SELECT igst_minor::text AS igst FROM sales_invoice_lines
          WHERE invoice_id = $1 AND line_no = 2`,
        [invInter],
      );
      expect(rows[0].igst).toBe("18000");
    });
  });

  it("⭐ REFUSES a line that names a rate and charges nothing under it", async () => {
    // Distinct from the case above, and it looks redundant until you ask
    // what the database sees: all three heads are zero, so there is no
    // head to compare against. Without its own branch this row falls
    // through every equality check and commits — an 18% line carrying no
    // tax, which is how a taxable supply is filed as exempt.
    const error = await expectError(() =>
      insertSalesLine(invInter, 3, { taxable: 100000, rateBps: 1800 }),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23514");
    expect(error!.message).toMatch(/cannot both name a rate and charge nothing/i);
  });

  it("⭐ ACCEPTS an exempt line — no rate, no tax — which is the same shape and is correct", async () => {
    // ⚠️ THE SIBLING THAT MAKES THE RULE ABOVE SURVIVABLE. Nil-rated and
    // exempt supplies are real: Schedule III, a completed flat sold after
    // the occupancy certificate. A guard that read "all heads zero" as an
    // error would refuse every one of them, and the product would ship
    // with the trigger dropped.
    await insertSalesLine(invIntra, 4, { taxable: 100000, description: "exempt supply" });

    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(
        `SELECT tax_rate_bps, cgst_minor::text AS cgst FROM sales_invoice_lines
          WHERE invoice_id = $1 AND line_no = 4`,
        [invIntra],
      );
      expect(rows[0].tax_rate_bps).toBeNull();
      expect(rows[0].cgst).toBe("0");
    });
  });

  it("⭐⭐ ACCEPTS the odd paisa: taxable 10005 at 18% is 1801, split 901 / 900", async () => {
    // ══════════════════════════════════════════════════════════════
    // THE CASE THAT LOOKS LIKE A BUG AND IS THE CORRECT ANSWER.
    //
    // ₹100.05 at 18% is 1800.9 paise, which rounds half-up to 1801 —
    // an ODD number, which cannot be halved evenly. One head must carry
    // the extra paisa, deterministically, and `splitEvenly` gives it to
    // the first share, so CGST 901 and SGST 900.
    //
    // A `CHECK (cgst_minor = sgst_minor)` would look like an obviously
    // correct constraint and would REFUSE THIS CORRECT LINE. 0021 §1c
    // explains at length why it was never written; this is that
    // explanation as an executable assertion, so the next person to
    // think of it finds a failing test instead of a shipped outage.
    // ══════════════════════════════════════════════════════════════
    await insertSalesLine(invIntra, 5, {
      taxable: 10005,
      rateBps: 1800,
      cgst: 901,
      sgst: 900,
      description: "odd paisa",
    });

    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(
        `SELECT cgst_minor::text AS cgst, sgst_minor::text AS sgst
           FROM sales_invoice_lines WHERE invoice_id = $1 AND line_no = 5`,
        [invIntra],
      );
      expect(rows[0].cgst).toBe("901");
      expect(rows[0].sgst).toBe("900");
    });

    // And the same split, computed by the TypeScript the SQL was
    // transcribed from, agrees to the paisa.
    const tax = applyRateBps(10005n, 1800);
    expect(tax).toBe(1801n);
    expect(splitEvenly(tax, 2)).toEqual([901n, 900n]);
  });

  it("REFUSES the odd paisa split the WRONG way round — 900 / 901", async () => {
    // Same two figures, same sum, and it must still be refused: the odd
    // paisa lands on CGST, always, or two systems recomputing the same
    // line disagree about which head is short.
    const error = await expectError(() =>
      insertSalesLine(invIntra, 6, { taxable: 10005, rateBps: 1800, cgst: 900, sgst: 901 }),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23514");
    expect(error!.message).toMatch(/does not recompute/i);
  });
});

/* ================================================================== */
/* 2. ⭐ THE HEAD MUST MATCH THE PLACE OF SUPPLY                       */
/* ================================================================== */

describe("⭐ the tax head must match the supply, not merely add up", () => {
  it("⭐⭐ REFUSES IGST on an INTRA-state supply, though the arithmetic is perfect", async () => {
    // ₹1,000 at 18% is ₹180 whichever head it lands in, so §1 has nothing
    // to say about this row. It is one of the most expensive ordinary
    // mistakes in Indian GST: the recipient cannot claim the IGST, the
    // supplier pays CGST and SGST again on the same supply, and the
    // wrongly-paid tax comes back as a Section 77 refund months later.
    const error = await expectError(() =>
      insertSalesLine(invIntra, 7, { taxable: 100000, rateBps: 1800, igst: 18000 }),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23514");
    expect(error!.message).toMatch(/IGST on an intra-state supply/i);
  });

  it("⭐ ACCEPTS the same money as CGST + SGST on that same intra-state supply", async () => {
    // ⚠️ THE SIBLING. The refusal above is about the HEAD, not the money —
    // if this failed, the trigger would be refusing intra-state supplies
    // outright and the message would be misleading everyone who read it.
    await insertSalesLine(invIntra, 8, {
      taxable: 100000,
      rateBps: 1800,
      cgst: 9000,
      sgst: 9000,
      description: "correct intra-state",
    });

    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(
        `SELECT cgst_minor::text AS cgst, sgst_minor::text AS sgst, igst_minor::text AS igst
           FROM sales_invoice_lines WHERE invoice_id = $1 AND line_no = 8`,
        [invIntra],
      );
      expect(rows[0]).toEqual({ cgst: "9000", sgst: "9000", igst: "0" });
    });
  });

  it("⭐ REFUSES CGST + SGST on an INTER-state supply", async () => {
    // The mirror, and it is not the same test read backwards: this row
    // splits the tax across two heads that are levied by the wrong two
    // governments. The buyer in Karnataka can claim neither.
    const error = await expectError(() =>
      insertSalesLine(invInter, 9, { taxable: 100000, rateBps: 1800, cgst: 9000, sgst: 9000 }),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23514");
    expect(error!.message).toMatch(/CGST and SGST on an inter-state supply/i);
  });

  it("ACCEPTS IGST on that same inter-state supply", async () => {
    await insertSalesLine(invInter, 10, {
      taxable: 100000,
      rateBps: 1800,
      igst: 18000,
      description: "correct inter-state, second",
    });

    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(
        `SELECT igst_minor::text AS igst FROM sales_invoice_lines
          WHERE invoice_id = $1 AND line_no = 10`,
        [invInter],
      );
      expect(rows[0].igst).toBe("18000");
    });
  });
});

/* ================================================================== */
/* 3. ⭐ A PIN MUST BE A REAL PIN                                      */
/* ================================================================== */

describe("⭐ a rate pin that does not fit the document is worse than no pin", () => {
  it("⭐⭐ REFUSES a line pinned to a period that does not cover its document's date", async () => {
    // The 12% period closed on 1 April 2019. The document is dated 2026.
    // The line is arithmetically flawless — 1200 bps on ₹1,000 is ₹120 —
    // so nothing in §1 or §2 objects. What is wrong is the PROVENANCE:
    // the pin claims a notification that was not in force, and a pin that
    // looks like evidence and is not is worse than a NULL, because a NULL
    // is honestly unknown and this is confidently wrong.
    const error = await expectError(() =>
      insertSalesLine(invInter, 11, {
        taxable: 100000,
        rateBps: 1200,
        igst: 12000,
        pin: rate12,
      }),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23514");
    expect(error!.message).toMatch(/rate in force on the document/i);
    expect(error!.message).toMatch(/2026-08-19/);
  });

  it("⭐ ACCEPTS the same line pinned to the period that DOES cover its date", async () => {
    // ⚠️ THE SIBLING. Same table, same document, same shape of write —
    // the only difference is that this pin is true. Without it, a guard
    // that refused every pinned line would look identical from here.
    await insertSalesLine(invInter, 12, {
      taxable: 100000,
      rateBps: 1800,
      igst: 18000,
      pin: rate18,
      description: "correctly pinned",
    });

    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(
        `SELECT hsn_sac_rate_id FROM sales_invoice_lines
          WHERE invoice_id = $1 AND line_no = 12`,
        [invInter],
      );
      expect(rows[0].hsn_sac_rate_id).toBe(rate18);
    });
  });

  it("⭐ REFUSES a line pinned to a period whose rate disagrees with the rate charged", async () => {
    // The period covers the date. It says 18%. The line charges 12% and
    // its own arithmetic is internally consistent at 12%. The pin is
    // precisely the thing that proves which notification produced the
    // figure — so a pin that disagrees with the figure proves the
    // opposite of what it claims.
    const error = await expectError(() =>
      insertSalesLine(invInter, 13, {
        taxable: 100000,
        rateBps: 1200,
        igst: 12000,
        pin: rate18,
      }),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23514");
    expect(error!.message).toMatch(/pinned to a rate period of 1800 bps but charges 1200 bps/i);
  });

  it("ACCEPTS an unpinned line — 0147 §6 deliberately did NOT make a pin mandatory", async () => {
    // ⚠️ THIS IS A TEST OF A DELIBERATE NON-RULE, and it belongs here
    // because the obvious next commit is "so make the pin NOT NULL".
    // Nothing in the product resolves a rate id on an outward supply
    // today, so requiring one would refuse every invoice the product
    // raises; 0148 reports the coverage as a number instead of asserting
    // it as a floor. If somebody makes it mandatory, this test tells them
    // what they have just done.
    await insertSalesLine(invInter, 14, {
      taxable: 100000,
      rateBps: 1800,
      igst: 18000,
      pin: null,
      description: "unpinned but honest",
    });

    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(
        `SELECT hsn_sac_rate_id FROM sales_invoice_lines
          WHERE invoice_id = $1 AND line_no = 14`,
        [invInter],
      );
      expect(rows[0].hsn_sac_rate_id).toBeNull();
    });
  });
});

/* ================================================================== */
/* 4. ⭐ PURCHASES ARE `pin_only`, AND THE ASYMMETRY IS THE POINT      */
/* ================================================================== */

describe("⭐ a purchase line is checked for its pin and NOT for its arithmetic", () => {
  it("⭐⭐ ACCEPTS a purchase line whose stored tax disagrees with its own rate", async () => {
    // ══════════════════════════════════════════════════════════════
    // THE CASE THAT LOOKS LIKE A HOLE AND IS A DECISION.
    //
    // The money on a purchase bill is the SUPPLIER'S. If a vendor
    // charged two paise where 18% says ₹180, that is a dispute to
    // record and pursue — `server/purchases/engine.ts` already raises a
    // `rateMismatch` warning for it — not a row to refuse. Refusing it
    // would leave the business unable to enter a bill it has physically
    // received and already paid, and the fix somebody reaches for at
    // that point is dropping the trigger.
    //
    // The identical figures on a SALES line are refused by §1 above,
    // because there the money is ours and there is no such excuse.
    // ══════════════════════════════════════════════════════════════
    await asTenant(tenantA, async (c) =>
      c.query(
        `INSERT INTO purchase_invoice_lines
           (tenant_id, purchase_invoice_id, line_number, description,
            amount_minor, taxable_value_minor, rate_bps,
            cgst_minor, sgst_minor, itc_eligible_tax_minor)
         VALUES ($1,$2,1,'supplier charged what the supplier charged',
                 100000, 100000, 1800, 1, 1, 2)`,
        [tenantA, billSupplierFigures],
      ),
    );

    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(
        `SELECT rate_bps, cgst_minor::text AS cgst FROM purchase_invoice_lines
          WHERE purchase_invoice_id = $1`,
        [billSupplierFigures],
      );
      expect(rows[0].rate_bps).toBe(1800);
      expect(rows[0].cgst).toBe("1");
    });
  });

  it("⭐ REFUSES a purchase line pinned to a period that does not cover the bill date", async () => {
    // The one rule that DOES apply on a purchase, and it applies for a
    // different reason from the sales case: whatever the supplier
    // charged, OUR record of which registry period we matched it to is
    // ours, and a pin naming a period that closed seven years before the
    // bill was raised is our error, not theirs.
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(
          `INSERT INTO purchase_invoice_lines
             (tenant_id, purchase_invoice_id, line_number, description,
              amount_minor, taxable_value_minor, rate_bps,
              cgst_minor, sgst_minor, itc_eligible_tax_minor, gst_rate_id)
           VALUES ($1,$2,9,'stale pin on a 2026 bill',
                   100000, 100000, 1800, 9000, 9000, 18000, $3)`,
          [tenantA, billPinned, rate12],
        ),
      ),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23514");
    expect(error!.message).toMatch(/rate in force on the document/i);
  });

  it("⭐ ACCEPTS a purchase line pinned to the period that DOES cover the bill date", async () => {
    // ⚠️ THE SIBLING for the refusal above.
    await asTenant(tenantA, async (c) =>
      c.query(
        `INSERT INTO purchase_invoice_lines
           (tenant_id, purchase_invoice_id, line_number, description,
            amount_minor, taxable_value_minor, rate_bps,
            cgst_minor, sgst_minor, itc_eligible_tax_minor, gst_rate_id)
         VALUES ($1,$2,1,'correctly pinned bill line',
                 100000, 100000, 1800, 9000, 9000, 18000, $3)`,
        [tenantA, billPinned, rate18],
      ),
    );

    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(
        `SELECT gst_rate_id FROM purchase_invoice_lines
          WHERE purchase_invoice_id = $1 AND line_number = 1`,
        [billPinned],
      );
      expect(rows[0].gst_rate_id).toBe(rate18);
    });
  });

  it("⭐ ACCEPTS a purchase line pinned to an 18% period while the supplier charged 12%", async () => {
    // ⚠️ THE SAME WRITE IS REFUSED ON A SALES LINE — see §3's "pin
    // disagrees" case, which is byte-for-byte this shape. 0147 §C1 skips
    // that comparison in `pin_only` mode ON PURPOSE and says so in the
    // file. Asserting it here means the asymmetry is a documented,
    // tested decision rather than something somebody later "fixes"
    // without noticing which side of the ledger they are on.
    await asTenant(tenantA, async (c) =>
      c.query(
        `INSERT INTO purchase_invoice_lines
           (tenant_id, purchase_invoice_id, line_number, description,
            amount_minor, taxable_value_minor, rate_bps,
            cgst_minor, sgst_minor, itc_eligible_tax_minor, gst_rate_id)
         VALUES ($1,$2,2,'vendor charged 12% under an 18% period',
                 100000, 100000, 1200, 6000, 6000, 12000, $3)`,
        [tenantA, billPinned, rate18],
      ),
    );

    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(
        `SELECT rate_bps, gst_rate_id FROM purchase_invoice_lines
          WHERE purchase_invoice_id = $1 AND line_number = 2`,
        [billPinned],
      );
      expect(rows[0].rate_bps).toBe(1200);
      expect(rows[0].gst_rate_id).toBe(rate18);
    });
  });
});

/* ================================================================== */
/* 5. ⭐⭐ THE PARITY TEST — SQL AND TYPESCRIPT MUST NOT DRIFT APART   */
/* ================================================================== */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE SINGLE LARGEST RISK 0147 TOOK ON
 * ══════════════════════════════════════════════════════════════════════
 * `lib/gst/tax.ts:8` forbids restating the money primitives, and 0147 §1
 * restated two of them in SQL anyway, with an argument: these are not a
 * tax engine, they are integer division, and integer division does not
 * drift. That argument is only worth anything if somebody checks.
 *
 * ⚠️ THE FAILURE THIS CATCHES IS NOT "THE DATABASE REFUSES TOO LITTLE".
 * It is the opposite and it is far worse: one implementation is edited,
 * the other is not, and the database begins REFUSING CORRECT INVOICES on
 * a subset of amounts that nobody can characterise. The support ticket
 * says "it works for ₹1,000 but not ₹100.05".
 *
 * ⭐ THE CASES ARE THE ONES THAT SEPARATE HALF-UP IMPLEMENTATIONS:
 * exact halves in BOTH directions, both signs, zero, a nil rate, and a
 * twelve-digit amount.
 *
 * ⚠️ THE TWO HALVES ARE THE ONLY CASES IN THE TABLE THAT DISCRIMINATE,
 * AND THAT IS WHY BOTH ARE THERE. Checked against this database rather
 * than assumed: banker's rounding (round-half-to-EVEN, which is what
 * `(x::float8)::bigint` does, and what almost every "just round it"
 * implementation reaches for) gives 0 for 5 @ 1000 bps where half-up
 * gives 1, and agrees on 15 @ 1000 bps where it also gives 2. ONE half
 * alone would therefore have missed it half the time; the pair cannot.
 * Every other case in the table agrees under both rules, and is here to
 * pin down the shape of the answer (sign, zero, nil rate, magnitude)
 * rather than the rounding.
 *
 * ⚠️ 0147 §5 CALLS THE LAST CASE "past 2^53". It is not: 999999999999 ×
 * 1800 is about 1.8 × 10^15, which is inside the exactly-representable
 * range of a float64, so a float implementation happens to get this one
 * right. It is kept because it is still the case that separates exact
 * integer arithmetic from anything that narrows the intermediate — the
 * amount alone does not fit in 32 bits — and because it is the case the
 * SQL side runs, so dropping it here would leave the two tables
 * unmatched. The wrong label is reported rather than repeated.
 *
 * ⚠️ THE EXPECTED VALUE IS NEVER HARD-CODED ON THE TYPESCRIPT SIDE. The
 * real `applyRateBps` and `splitEvenly` are imported and called. A table
 * of literals would freeze today's answer and the drift would sail past.
 */
const PARITY_CASES: ReadonlyArray<{ amount: bigint; bps: number; note: string }> = [
  { amount: 100000n, bps: 1800, note: "the ordinary case" },
  { amount: 10005n, bps: 1800, note: "x.9 rounds up" },
  { amount: 10001n, bps: 1800, note: "x.18 rounds down" },
  { amount: 5n, bps: 1000, note: "exactly a half rounds UP, not to even" },
  { amount: 15n, bps: 1000, note: "the next half also rounds UP — banker's would give 2 here and 0 above" },
  { amount: -100000n, bps: 1800, note: "a credit note is the exact negative" },
  { amount: -5n, bps: 1000, note: "a half rounds AWAY from zero when negative" },
  { amount: 0n, bps: 1800, note: "zero" },
  { amount: 100000n, bps: 0, note: "a nil rate" },
  {
    amount: 999999999999n,
    bps: 1800,
    note: "a twelve-digit amount — an intermediate that narrows to 32 bits cannot reach it",
  },
];

/** The splits, including the odd paisa in both directions and the degenerate ends. */
const SPLIT_CASES: ReadonlyArray<bigint> = [18000n, 1801n, 1n, 0n, -1n, -1801n, 999999999999n];

describe("⭐⭐ gst_apply_rate_bps / gst_cgst_share agree with applyRateBps / splitEvenly", () => {
  it("⭐⭐ the SQL and the TypeScript return the SAME paisa on every case", async () => {
    await asTenant(tenantA, async (c) => {
      for (const { amount, bps, note } of PARITY_CASES) {
        const { rows } = await c.query(
          `SELECT gst_apply_rate_bps($1::bigint, $2::integer)::text AS tax`,
          [amount.toString(), bps],
        );

        const fromSql = BigInt(rows[0].tax);
        const fromTypeScript = applyRateBps(amount, bps);

        // ⚠️ NOT `expect(fromSql).toBe(<a literal>)`. The claim is that
        // the two implementations agree with EACH OTHER; comparing both
        // to a third hand-written number would still pass on the day
        // they drift together in the same wrong direction, and would
        // fail for the wrong reason on the day the rule legitimately
        // changes.
        expect(fromSql, `gst_apply_rate_bps(${amount}, ${bps}) — ${note}`).toBe(fromTypeScript);
      }
    });
  });

  it("⭐ the CGST half is the same half, and the two heads sum back exactly", async () => {
    await asTenant(tenantA, async (c) => {
      for (const total of SPLIT_CASES) {
        const { rows } = await c.query(`SELECT gst_cgst_share($1::bigint)::text AS cgst`, [
          total.toString(),
        ]);

        const cgstFromSql = BigInt(rows[0].cgst);
        const [cgstFromTypeScript, sgstFromTypeScript] = splitEvenly(total, 2) as [bigint, bigint];

        expect(cgstFromSql, `gst_cgst_share(${total})`).toBe(cgstFromTypeScript);
        // The second head is `total - first` on both sides by
        // construction, so this is the assertion that the construction
        // itself is exact — no paisa created, none lost.
        expect(cgstFromSql + (total - cgstFromSql)).toBe(total);
        expect(cgstFromTypeScript + sgstFromTypeScript).toBe(total);
      }
    });
  });

  it("⭐ and the two composed — rate, then split — agree head for head", async () => {
    // The functions are used together, never alone: the trigger applies
    // the rate and then splits the ROUNDED total. Composing them is a
    // third opportunity to disagree (halving the rate and rounding each
    // half separately is the classic wrong answer, and turns ₹100.01 of
    // tax into ₹50.01 + ₹50.01), so it is checked as a third case rather
    // than assumed from the two above.
    await asTenant(tenantA, async (c) => {
      for (const { amount, bps, note } of PARITY_CASES) {
        const { rows } = await c.query(
          `SELECT gst_cgst_share(gst_apply_rate_bps($1::bigint, $2::integer))::text AS cgst,
                  (gst_apply_rate_bps($1::bigint, $2::integer)
                     - gst_cgst_share(gst_apply_rate_bps($1::bigint, $2::integer)))::text AS sgst`,
          [amount.toString(), bps],
        );

        const tax = applyRateBps(amount, bps);
        const [cgst, sgst] = splitEvenly(tax, 2) as [bigint, bigint];

        expect(BigInt(rows[0].cgst), `CGST of ${amount} @ ${bps} — ${note}`).toBe(cgst);
        expect(BigInt(rows[0].sgst), `SGST of ${amount} @ ${bps} — ${note}`).toBe(sgst);
      }
    });
  });

  it("⭐ and the trigger accepts exactly what that composition produces", async () => {
    // ⭐ THE LOOP CLOSED. The two sections above compare two functions to
    // each other; this one proves the TRIGGER uses them — that a line
    // built from the TypeScript answer is the line the database wants.
    // Without it, the pair could agree perfectly while the trigger
    // computed something else entirely.
    const taxable = 874563n; // ₹8,745.63 — divides evenly by nothing
    const tax = applyRateBps(BigInt(taxable), 1800);
    const [cgst, sgst] = splitEvenly(tax, 2) as [bigint, bigint];

    await insertSalesLine(invIntra, 20, {
      taxable,
      rateBps: 1800,
      cgst: Number(cgst),
      sgst: Number(sgst),
      description: "built from the TypeScript answer",
    });

    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(
        `SELECT cgst_minor::text AS cgst, sgst_minor::text AS sgst
           FROM sales_invoice_lines WHERE invoice_id = $1 AND line_no = 20`,
        [invIntra],
      );
      expect(BigInt(rows[0].cgst) + BigInt(rows[0].sgst)).toBe(tax);
    });
  });
});
