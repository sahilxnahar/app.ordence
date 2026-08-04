/**
 * Ordence — GST Foundation: Isolation, Time and Arithmetic
 * Version: v0.32.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE IS ACTUALLY TRYING TO PROVE
 * ══════════════════════════════════════════════════════════════════════
 * Thirty-one phases say the same thing: the defects that survive are the
 * SILENT ones. `writeAudit` discarded the audit trail for fourteen phases
 * with no error. `withPlatformScope` read zero rows and failed closed, so
 * nothing leaked and nothing worked.
 *
 * This phase has the quietest failure modes in the product so far,
 * because a wrong tax answer is a RIGHT-LOOKING DOCUMENT:
 *
 *   • A rate corrected in the master restates every historical invoice.
 *     Nothing errors. The documents simply stop matching the returns
 *     filed against them, and it surfaces at an assessment years later.
 *
 *   • A flat in Pune taxed at the buyer's Karnataka GSTIN produces a
 *     total that is right to the paisa. The tax lands in a state we never
 *     supplied, the buyer cannot claim it, and recovering it is a Section
 *     77 application.
 *
 * So the tests below do not inspect constraints. They make a real
 * historical invoice, change the master underneath it, and check the
 * invoice did not move. They compute tax on amounts that do not divide
 * evenly and add the column. They ask the database to accept a GSTIN
 * whose fifteenth character is wrong.
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
  determinePlaceOfSupply,
} from "@/lib/gst/place-of-supply";
import {
  resolveRateOn,
  validateRateHistory,
  wouldOrphanDocuments,
  type DatedRate,
} from "@/lib/gst/rates";
import { computeInvoiceTax, reconcileInvoice, roundOffToRupee } from "@/lib/gst/tax";
import { describeGstinProblem, parseGstin, sharesPan } from "@/lib/gst/gstin";
import { checkRule46 } from "@/lib/gst/invoice-fields";
import { toCivilDay, financialYearOf, isUnionTerritoryCode } from "@/lib/gst/constants";
import { gstinSchema } from "@/lib/validators/gst";

/* ================================================================== */
/* FIXTURES                                                            */
/* ================================================================== */

/**
 * Real, checksum-valid GSTINs. The check character is computed, not
 * invented — `27AAACR5055K1Z7` and `29AAACR5055K1Z3` are the same PAN
 * registered in Maharashtra and in Karnataka, which is also what
 * `sharesPan` is exercised against.
 */
const GSTIN_MH = "27AAACR5055K1Z7";
const GSTIN_KA = "29AAACR5055K1Z3";
/** Right shape, right state, WRONG fifteenth character. */
const GSTIN_BAD_CHECKSUM = "27AAACR5055K1ZX";

let tenantA: string;
let tenantB: string;
let userA: string;
let regA: string;
let codeA: string;
let codeB: string;
/** The 12% period, [2017-07-01, open). Closed later, on purpose. */
let rate12: string;
let rate5: string | null = null;
/** An invoice dated inside the 12% period. It must never move. */
let historicalInvoice: string;

const HISTORICAL_DATE = "2018-05-10";

beforeAll(async () => {
  tenantA = randomUUID();
  tenantB = randomUUID();
  userA = randomUUID();
  regA = randomUUID();
  codeA = randomUUID();
  codeB = randomUUID();
  rate12 = randomUUID();
  historicalInvoice = randomUUID();

  await asSuperuser(async (c) => {
    for (const [id, name] of [
      [tenantA, "GST Isolation A"],
      [tenantB, "GST Isolation B"],
    ] as const) {
      await c.query(
        `INSERT INTO tenants (id, clerk_org_id, slug, name, status)
         VALUES ($1,$2,$3,$4,'active')`,
        [id, `org_${id}`, `gst-${id.slice(0, 8)}`, name],
      );
    }

    await c.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, status)
       VALUES ($1,$2,$3,'gst-a@example.test','tenant_admin','active')`,
      [userA, tenantA, `usr_${userA}`],
    );

    // Our own registration — Maharashtra.
    await c.query(
      `INSERT INTO gst_registrations
         (id, tenant_id, gstin, state_code, legal_name, effective_from, is_primary)
       VALUES ($1,$2,$3,'27','Ordence Developers LLP', DATE '2017-07-01', true)`,
      [regA, tenantA, GSTIN_MH],
    );

    // Tenant B gets its own, so the isolation assertions have something
    // to fail to see.
    await c.query(
      `INSERT INTO gst_registrations
         (id, tenant_id, gstin, state_code, legal_name, effective_from, is_primary)
       VALUES (gen_random_uuid(),$1,$2,'29','Other Builders Pvt Ltd', DATE '2017-07-01', true)`,
      [tenantB, GSTIN_KA],
    );

    await c.query(
      `INSERT INTO hsn_sac_codes (id, tenant_id, code, kind, description)
       VALUES ($1,$2,'995411','sac','Construction of residential buildings')`,
      [codeA, tenantA],
    );
    await c.query(
      `INSERT INTO hsn_sac_codes (id, tenant_id, code, kind, description)
       VALUES ($1,$2,'995411','sac','Construction of residential buildings')`,
      [codeB, tenantB],
    );

    // ⭐ The 12% period. Open-ended for now — it is superseded mid-suite,
    // which is exactly what a rate notification does.
    await c.query(
      `INSERT INTO hsn_sac_rates
         (id, tenant_id, hsn_sac_id, rate_bps, effective_from, notification_ref)
       VALUES ($1,$2,$3,1200, DATE '2017-07-01','Notification 11/2017-CT(R)')`,
      [rate12, tenantA, codeA],
    );

    /* --- ⭐ THE HISTORICAL INVOICE ------------------------------- */
    //
    // ₹1,00,000 of construction at 12%, intra-Maharashtra, so CGST 6% and
    // SGST 6%. `gst_computed` is true, so the deferred reconciliation
    // trigger in SQL §6 applies to it — the fixture is itself a test that
    // a correctly-built GST invoice is ACCEPTED.
    //
    // ⚠️ EXPLICIT BEGIN/COMMIT, AND IT IS NOT DECORATION. `adminPool` runs
    // in autocommit, where each statement is its own transaction — so a
    // DEFERRABLE INITIALLY DEFERRED constraint trigger fires at the end of
    // the INSERT that created the header, before any line exists, and
    // refuses it. The real write path builds the header and its lines in
    // one transaction, which is exactly what this reproduces.
    await c.query("BEGIN");
    await c.query(
      `INSERT INTO invoices
         (id, tenant_id, invoice_number, status, currency,
          subtotal_minor, discount_minor, cgst_minor, sgst_minor, igst_minor,
          cess_minor, total_minor,
          supplier_registration_id, supplier_gstin, supplier_state_code,
          supply_type, property_state_code, place_of_supply_code,
          tax_point_date, gst_computed, issued_at)
       VALUES ($1,$2,$3,'draft','INR',
               10000000, 0, 600000, 600000, 0, 0, 11200000,
               $4,$5,'27','immovable_property','27','27',
               DATE '${HISTORICAL_DATE}', true, TIMESTAMPTZ '${HISTORICAL_DATE} 10:00+05:30')`,
      [historicalInvoice, tenantA, `AH/2018/${historicalInvoice.slice(0, 8)}`, regA, GSTIN_MH],
    );

    await c.query(
      `INSERT INTO invoice_lines
         (invoice_id, tenant_id, description, sac_code, quantity,
          unit_amount_minor, amount_minor, tax_rate_bps,
          gst_rate_id, taxable_value_minor, cgst_minor, sgst_minor)
       VALUES ($1,$2,'Construction of Flat A-1203','995411',1,
               10000000, 10000000, 1200, $3, 10000000, 600000, 600000)`,
      [historicalInvoice, tenantA, rate12],
    );
    await c.query("COMMIT");
  });
});

afterAll(async () => {
  await asSuperuser(async (c) => {
    const tenants = [tenantA, tenantB];

    // ⚠️ Order matters, and it is the schema telling us something. The
    // foreign key from `invoice_lines` to `hsn_sac_rates` is RESTRICT —
    // a rate an invoice used cannot be removed — so a teardown that
    // deleted rates first would be refused. That refusal is the
    // guarantee this phase is built on.
    await c.query(`DELETE FROM invoice_lines WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM invoices WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM hsn_sac_rates WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM hsn_sac_codes WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM gst_parties WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM gst_registrations WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM change_log WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM users WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM tenants WHERE id = ANY($1::uuid[])`, [tenants]);

    // Prove every guard is still enabled. A teardown that disabled one
    // would void the guarantee for every later run — and the suite would
    // still pass, which is the dangerous part.
    const { rows } = await c.query(
      `SELECT tgname, tgenabled::text AS state FROM pg_trigger
        WHERE tgrelid = 'hsn_sac_rates'::regclass AND NOT tgisinternal`,
    );
    for (const row of rows) expect(row.state, row.tgname).toBe("O");
  });
});

/* ================================================================== */
/* 1. TENANT ISOLATION                                                 */
/* ================================================================== */

describe("tenant isolation", () => {
  it("⭐ a tenant sees only its own GST registrations", async () => {
    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query("SELECT gstin FROM gst_registrations");
      expect(rows.map((r) => r.gstin)).toEqual([GSTIN_MH]);
    });

    await asTenant(tenantB, async (c) => {
      const { rows } = await c.query("SELECT gstin FROM gst_registrations");
      expect(rows.map((r) => r.gstin)).toEqual([GSTIN_KA]);
    });
  });

  it("⭐ a tenant sees only its own rate master", async () => {
    await asTenant(tenantB, async (c) => {
      const { rows } = await c.query("SELECT id FROM hsn_sac_rates");
      // Tenant B has the same SAC code and no rate for it. Seeing tenant
      // A's 12% would mean B's invoices priced from A's master.
      expect(rows).toHaveLength(0);
    });
  });

  it("no tenant context reads ZERO rows, never all rows", async () => {
    await withoutTenant(async (c) => {
      for (const table of [
        "gst_registrations",
        "gst_parties",
        "hsn_sac_codes",
        "hsn_sac_rates",
      ]) {
        const { rows } = await c.query(`SELECT count(*)::int AS n FROM ${table}`);
        expect(rows[0].n, table).toBe(0);
      }
    });
  });

  it("⭐ a rate cannot point at ANOTHER TENANT'S classification", async () => {
    // The composite foreign key, not the RLS policy. FK checks run as the
    // system and ignore row-level security — without (id, tenant_id) this
    // insert would succeed and tenant A's invoices would be priced from
    // a code tenant A has never seen.
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(
          `INSERT INTO hsn_sac_rates (tenant_id, hsn_sac_id, rate_bps, effective_from)
           VALUES ($1,$2,1800, DATE '2020-01-01')`,
          [tenantA, codeB],
        ),
      ),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23503");
  });

  it("one tenant cannot overwrite another's rate", async () => {
    await asTenant(tenantB, async (c) => {
      const { rowCount } = await c.query(
        `UPDATE hsn_sac_rates SET rate_bps = 100 WHERE id = $1`,
        [rate12],
      );
      // Not an error — RLS makes the row invisible, so the UPDATE simply
      // matches nothing. Fail closed, silently, which is correct.
      expect(rowCount).toBe(0);
    });

    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(`SELECT rate_bps FROM hsn_sac_rates WHERE id = $1`, [
        rate12,
      ]);
      expect(rows[0].rate_bps).toBe(1200);
    });
  });
});

/* ================================================================== */
/* 2. ⭐ A HISTORICAL INVOICE KEEPS ITS HISTORICAL RATE                */
/* ================================================================== */

describe("⭐ a historical invoice keeps the rate that applied on its date", () => {
  it("the rate master can be superseded by a new notification", async () => {
    // 1 April 2019: residential construction moved 12% → 5%. Recorded the
    // way a notification is recorded — close the old period ON the day
    // the new one begins, and open a new one. Nothing is edited.
    rate5 = randomUUID();

    await asTenant(tenantA, async (c) => {
      await c.query(
        `UPDATE hsn_sac_rates SET effective_to = DATE '2019-04-01' WHERE id = $1`,
        [rate12],
      );
      await c.query(
        `INSERT INTO hsn_sac_rates
           (id, tenant_id, hsn_sac_id, rate_bps, effective_from, notification_ref, itc_eligible)
         VALUES ($1,$2,$3,500, DATE '2019-04-01','Notification 03/2019-CT(R)', false)`,
        [rate5, tenantA, codeA],
      );
    });

    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(
        `SELECT rate_bps, effective_from, effective_to FROM hsn_sac_rates
          WHERE hsn_sac_id = $1 ORDER BY effective_from`,
        [codeA],
      );
      expect(rows.map((r) => r.rate_bps)).toEqual([1200, 500]);
    });
  });

  it("⭐⭐ THE INVOICE RAISED IN 2018 IS STILL A 12% INVOICE", async () => {
    // ══════════════════════════════════════════════════════════════
    // THE SINGLE MOST IMPORTANT ASSERTION IN THE PHASE.
    //
    // The master now says 5%. The invoice was raised in May 2018. If the
    // stored line has moved, then every PDF already sent to a buyer
    // disagrees with what this system now believes, the GSTR-1
    // reconciliation for that quarter fails, and nothing anywhere
    // errored.
    // ══════════════════════════════════════════════════════════════
    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(
        `SELECT l.tax_rate_bps, l.gst_rate_id, l.cgst_minor, l.sgst_minor,
                i.total_minor, i.tax_point_date
           FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
          WHERE l.invoice_id = $1`,
        [historicalInvoice],
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].tax_rate_bps).toBe(1200);
      expect(rows[0].gst_rate_id).toBe(rate12);
      expect(String(rows[0].cgst_minor)).toBe("600000");
      expect(String(rows[0].sgst_minor)).toBe("600000");
      expect(String(rows[0].total_minor)).toBe("11200000");
    });
  });

  it("⭐ resolving by date still returns 12% for 2018 and 5% for 2019", async () => {
    const history = await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(
        `SELECT id, rate_bps, cess_rate_bps, cess_per_unit_minor,
                effective_from::text AS effective_from, effective_to::text AS effective_to
           FROM hsn_sac_rates WHERE hsn_sac_id = $1`,
        [codeA],
      );
      return rows.map(
        (r): DatedRate => ({
          id: r.id,
          rateBps: r.rate_bps,
          cessRateBps: r.cess_rate_bps,
          cessPerUnitMinor: BigInt(r.cess_per_unit_minor),
          effectiveFrom: r.effective_from,
          effectiveTo: r.effective_to,
        }),
      );
    });

    expect(resolveRateOn(history, HISTORICAL_DATE)?.rateBps).toBe(1200);
    expect(resolveRateOn(history, "2019-03-31")?.rateBps).toBe(1200);
    // ⚠️ The changeover day itself. `effective_to` is EXCLUSIVE, so
    // 1 April belongs to the NEW period. Inclusive ends would make this
    // day ambiguous, and every rate change lands on a working day.
    expect(resolveRateOn(history, "2019-04-01")?.rateBps).toBe(500);
    expect(resolveRateOn(history, "2024-08-01")?.rateBps).toBe(500);
    // Before GST commenced there was no rate, and null must stay null
    // rather than becoming a zero-rated invoice that looks deliberate.
    expect(resolveRateOn(history, "2017-06-30")).toBeNull();
  });

  it("⭐ a rate an invoice has used CANNOT be edited", async () => {
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(`UPDATE hsn_sac_rates SET rate_bps = 500 WHERE id = $1`, [rate12]),
      ),
    );

    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/already been used/i);

    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(`SELECT rate_bps FROM hsn_sac_rates WHERE id = $1`, [
        rate12,
      ]);
      expect(rows[0].rate_bps).toBe(1200);
    });
  });

  it("⭐ a rate an invoice has used CANNOT be deleted", async () => {
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(`DELETE FROM hsn_sac_rates WHERE id = $1`, [rate12]),
      ),
    );

    // Refused twice over: no DELETE grant on the table at all, and the
    // RESTRICT foreign key behind it. Either is enough; both is the point.
    expect(error).not.toBeNull();
  });

  it("⭐ a rate's window cannot be pulled off a document's date", async () => {
    // The subtler attack on history: leave the rate alone and move the
    // period. The invoice is dated 2018-05-10; closing the 12% window in
    // 2018-01 would leave it pointing at a period that does not contain
    // its own date.
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(
          `UPDATE hsn_sac_rates SET effective_to = DATE '2018-01-01' WHERE id = $1`,
          [rate12],
        ),
      ),
    );

    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/cannot end on/i);
  });

  it("closing a period FORWARD still works — that is how a notification is recorded", async () => {
    await asTenant(tenantA, async (c) => {
      // A no-op in effect (it is already 2019-04-01) but it must not be
      // refused. A guard that froze the row entirely would make the next
      // rate change unrecordable, and somebody would edit in place.
      await c.query(
        `UPDATE hsn_sac_rates SET effective_to = DATE '2019-04-01' WHERE id = $1`,
        [rate12],
      );
      const { rows } = await c.query(
        `SELECT effective_to::text AS t FROM hsn_sac_rates WHERE id = $1`,
        [rate12],
      );
      expect(rows[0].t).toBe("2019-04-01");
    });
  });

  it("⭐ two rate periods may never cover the same day", async () => {
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(
          `INSERT INTO hsn_sac_rates (tenant_id, hsn_sac_id, rate_bps, effective_from, effective_to)
           VALUES ($1,$2,1800, DATE '2018-01-01', DATE '2018-09-01')`,
          [tenantA, codeA],
        ),
      ),
    );

    expect(error).not.toBeNull();
    // 23P01 — exclusion_violation. Two rates valid on one day would mean
    // the rate on an invoice raised that day is decided by a sort order.
    expect(error!.code).toBe("23P01");
  });

  it("the pure validator names the clash before it reaches the database", () => {
    const overlapping: DatedRate[] = [
      {
        id: "a",
        rateBps: 1200,
        cessRateBps: 0,
        cessPerUnitMinor: 0n,
        effectiveFrom: "2017-07-01",
        effectiveTo: "2019-06-01",
      },
      {
        id: "b",
        rateBps: 500,
        cessRateBps: 0,
        cessPerUnitMinor: 0n,
        effectiveFrom: "2019-04-01",
        effectiveTo: null,
      },
    ];

    const { errors } = validateRateHistory(overlapping);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.message).toMatch(/overlaps/i);
  });

  it("a GAP is a warning, not an error — a code may genuinely be unrated", () => {
    const gapped: DatedRate[] = [
      {
        id: "a",
        rateBps: 1200,
        cessRateBps: 0,
        cessPerUnitMinor: 0n,
        effectiveFrom: "2017-07-01",
        effectiveTo: "2019-01-01",
      },
      {
        id: "b",
        rateBps: 500,
        cessRateBps: 0,
        cessPerUnitMinor: 0n,
        effectiveFrom: "2019-04-01",
        effectiveTo: null,
      },
    ];

    const { errors, warnings } = validateRateHistory(gapped);
    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(1);
  });

  it("the UI can warn before the database refuses", () => {
    expect(
      wouldOrphanDocuments({
        currentFrom: "2017-07-01",
        proposedTo: "2018-01-01",
        latestDocumentDate: HISTORICAL_DATE,
      }),
    ).not.toBeNull();

    expect(
      wouldOrphanDocuments({
        currentFrom: "2017-07-01",
        proposedTo: "2019-04-01",
        latestDocumentDate: HISTORICAL_DATE,
      }),
    ).toBeNull();
  });
});

/* ================================================================== */
/* 3. ⭐ IMMOVABLE PROPERTY — THE PLACE OF SUPPLY IS THE PROPERTY      */
/* ================================================================== */

describe("⭐ place of supply for immovable property", () => {
  it("⭐⭐ is the PROPERTY's state, not the buyer's GSTIN state", () => {
    // Supplier in Maharashtra. Flat in Pune (27). Buyer is a company
    // registered in Karnataka (29). Every generic billing engine answers
    // 29, because every generic billing engine keys off the customer.
    const result = determinePlaceOfSupply({
      supplierStateCode: "27",
      supplyType: "immovable_property",
      recipientRegistration: "regular",
      recipientStateCode: "29",
      propertyStateCode: "27",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.supply.placeOfSupplyCode).toBe("27");
    expect(result.supply.basis).toBe("immovable_property_location");
    expect(result.supply.statutoryRef).toMatch(/12\(3\)/);
    expect(result.supply.isInterState).toBe(false);
    expect(result.supply.taxKind).toBe("cgst_sgst");
  });

  it("⭐ is the property's state even for an NRI buyer with no Indian registration", () => {
    // The Dubai NRI. `recipientRegistration: "overseas"` would otherwise
    // route to the export branch and produce a zero-rated IGST invoice —
    // which is why the immovable-property branch is evaluated FIRST.
    const result = determinePlaceOfSupply({
      supplierStateCode: "27",
      supplyType: "immovable_property",
      recipientRegistration: "overseas",
      recipientStateCode: null,
      propertyStateCode: "27",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.supply.placeOfSupplyCode).toBe("27");
    expect(result.supply.isInterState).toBe(false);
    expect(result.supply.taxKind).toBe("cgst_sgst");
  });

  it("a property in another state makes the supply inter-state", () => {
    const result = determinePlaceOfSupply({
      supplierStateCode: "27",
      supplyType: "immovable_property",
      recipientRegistration: "regular",
      recipientStateCode: "27",
      propertyStateCode: "29",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.supply.placeOfSupplyCode).toBe("29");
    expect(result.supply.isInterState).toBe(true);
    expect(result.supply.taxKind).toBe("igst");
  });

  it("⭐ REFUSES to answer when the property's location is unknown", () => {
    // Not a fallback to the buyer's state. Guessing is the bug.
    const result = determinePlaceOfSupply({
      supplierStateCode: "27",
      supplyType: "immovable_property",
      recipientRegistration: "regular",
      recipientStateCode: "29",
      propertyStateCode: null,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.remedy).toMatch(/LOCATION OF THE PROPERTY/i);
  });

  it("⭐ the DATABASE refuses an immovable-property invoice taxed in the buyer's state", async () => {
    // The engine is one of four write paths. This is the constraint that
    // covers the import script, the psql session and the future API route.
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(
          `INSERT INTO invoices
             (tenant_id, invoice_number, subtotal_minor, discount_minor,
              cgst_minor, sgst_minor, igst_minor, total_minor,
              supply_type, property_state_code, place_of_supply_code)
           VALUES ($1,$2, 10000000, 0, 0, 0, 500000, 10500000,
                   'immovable_property','27','29')`,
          [tenantA, `AH/BAD/${randomUUID().slice(0, 8)}`],
        ),
      ),
    );

    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/invoices_immovable_property_pos/);
  });

  it("the same invoice with the property's state is accepted", async () => {
    const number = `AH/OK/${randomUUID().slice(0, 8)}`;
    await asTenant(tenantA, async (c) =>
      c.query(
        `INSERT INTO invoices
           (tenant_id, invoice_number, subtotal_minor, discount_minor,
            cgst_minor, sgst_minor, igst_minor, total_minor,
            supply_type, property_state_code, place_of_supply_code)
         VALUES ($1,$2, 10000000, 0, 250000, 250000, 0, 10500000,
                 'immovable_property','27','27')`,
        [tenantA, number],
      ),
    );

    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(
        `SELECT place_of_supply_code FROM invoices WHERE invoice_number = $1`,
        [number],
      );
      expect(rows[0].place_of_supply_code).toBe("27");
    });
  });
});

/* ================================================================== */
/* 4. PLACE OF SUPPLY — THE REST OF THE ENGINE                         */
/* ================================================================== */

describe("place of supply", () => {
  it("intra-state services give CGST + SGST", () => {
    const result = determinePlaceOfSupply({
      supplierStateCode: "27",
      supplyType: "services",
      recipientRegistration: "regular",
      recipientStateCode: "27",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.supply.isInterState).toBe(false);
    expect(result.supply.taxKind).toBe("cgst_sgst");
    expect(result.supply.basis).toBe("recipient_registration");
  });

  it("inter-state services give IGST", () => {
    const result = determinePlaceOfSupply({
      supplierStateCode: "27",
      supplyType: "services",
      recipientRegistration: "regular",
      recipientStateCode: "29",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.supply.isInterState).toBe(true);
    expect(result.supply.taxKind).toBe("igst");
  });

  it("⭐ an intra-UNION-TERRITORY supply gives CGST + UTGST, not SGST", () => {
    // Chandigarh has no legislature, so the state half is UTGST under a
    // different Act. The amount is identical; the box in the return is not.
    const result = determinePlaceOfSupply({
      supplierStateCode: "04",
      supplyType: "services",
      recipientRegistration: "regular",
      recipientStateCode: "04",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.supply.taxKind).toBe("cgst_utgst");
    expect(result.supply.isUnionTerritory).toBe(true);
  });

  it("⭐ Delhi is a Union Territory that levies SGST, because it has a legislature", () => {
    expect(isUnionTerritoryCode("07")).toBe(false);
    expect(isUnionTerritoryCode("34")).toBe(false); // Puducherry
    expect(isUnionTerritoryCode("04")).toBe(true); // Chandigarh

    const result = determinePlaceOfSupply({
      supplierStateCode: "07",
      supplyType: "services",
      recipientRegistration: "regular",
      recipientStateCode: "07",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.supply.taxKind).toBe("cgst_sgst");
  });

  it("⭐ an SEZ in our OWN state is still an inter-state supply", () => {
    // Section 7(5)(b). Matching the state codes and concluding
    // "intra-state" under-collects IGST that is repaid with interest.
    const result = determinePlaceOfSupply({
      supplierStateCode: "27",
      supplyType: "services",
      recipientRegistration: "sez",
      recipientStateCode: "27",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.supply.isInterState).toBe(true);
    expect(result.supply.taxKind).toBe("igst");
    expect(result.supply.statutoryRef).toMatch(/7\(5\)\(b\)/);
  });

  it("goods follow the delivery address, not the billing address", () => {
    const result = determinePlaceOfSupply({
      supplierStateCode: "27",
      supplyType: "goods",
      recipientRegistration: "regular",
      recipientStateCode: "27",
      deliveryStateCode: "29",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.supply.placeOfSupplyCode).toBe("29");
    expect(result.supply.basis).toBe("delivery_location");
  });

  it("an unregistered buyer with no address falls back to our own state", () => {
    const result = determinePlaceOfSupply({
      supplierStateCode: "27",
      supplyType: "services",
      recipientRegistration: "unregistered",
      recipientStateCode: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.supply.placeOfSupplyCode).toBe("27");
    expect(result.supply.isInterState).toBe(false);
  });

  it('a single-digit state code is normalised — "7" and "07" are one state', () => {
    const result = determinePlaceOfSupply({
      supplierStateCode: "07",
      supplyType: "services",
      recipientRegistration: "regular",
      recipientStateCode: "7",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Without normalisation this compares unequal and every Delhi supply
    // becomes inter-state.
    expect(result.supply.isInterState).toBe(false);
  });
});

/* ================================================================== */
/* 5. ⭐ THE ARITHMETIC RECONCILES EXACTLY                             */
/* ================================================================== */

describe("⭐ line-level tax sums exactly to the invoice total", () => {
  /**
   * Amounts chosen because they do NOT divide evenly. ₹87,45,633.33 at
   * 18% is not a whole number of paise, and half of the resulting tax is
   * not a whole number either — which is where a naive implementation
   * loses a paisa on every line and a rupee on every hundred invoices.
   */
  const AWKWARD = [
    874563333n, // ₹87,45,633.33
    1n, // one paisa
    3n,
    7n,
    99n,
    100001n, // produces an odd tax amount
    333333333n,
    1234567891n,
    999999999999n,
  ];

  it("intra-state: CGST + SGST add to the tax, and the lines add to the total", () => {
    for (const amount of AWKWARD) {
      for (const rateBps of [500, 1200, 1800, 2800, 25]) {
        const c = computeInvoiceTax({
          lines: [{ key: "l1", grossMinor: amount, rateBps }],
          taxKind: "cgst_sgst",
          placeOfSupplyCode: "27",
        });

        const line = c.lines[0]!;
        // ⭐ The two halves must add to the tax charged, exactly. They may
        // differ by one paisa — an odd tax cannot be halved evenly, and a
        // check demanding equality would refuse a correct invoice.
        expect(line.cgstMinor + line.sgstMinor).toBe(line.totalTaxMinor);
        expect(line.cgstMinor - line.sgstMinor <= 1n).toBe(true);
        expect(c.invoiceTotalMinor).toBe(c.taxableMinor + c.totalTaxMinor);
        expect(c.cgstMinor + c.sgstMinor + c.igstMinor + c.cessMinor).toBe(
          c.totalTaxMinor,
        );
      }
    }
  });

  it("⭐ a multi-line invoice at mixed rates adds up to the paisa", () => {
    // A real booking invoice: construction at 5%, the club-house at 18%,
    // a preferential-location charge at 5%, and a discount on one line.
    const c = computeInvoiceTax({
      lines: [
        { key: "construction", grossMinor: 874563333n, rateBps: 500 },
        { key: "clubhouse", grossMinor: 33333n, rateBps: 1800 },
        { key: "plc", grossMinor: 111111n, rateBps: 500, discountMinor: 7n },
        { key: "parking", grossMinor: 1n, rateBps: 1800 },
      ],
      taxKind: "cgst_sgst",
      placeOfSupplyCode: "27",
    });

    // Add the column by hand, exactly as an auditor would.
    const summedTaxable = c.lines.reduce((t, l) => t + l.taxableMinor, 0n);
    const summedCgst = c.lines.reduce((t, l) => t + l.cgstMinor, 0n);
    const summedSgst = c.lines.reduce((t, l) => t + l.sgstMinor, 0n);
    const summedTotals = c.lines.reduce((t, l) => t + l.lineTotalMinor, 0n);

    expect(summedTaxable).toBe(c.taxableMinor);
    expect(summedCgst).toBe(c.cgstMinor);
    expect(summedSgst).toBe(c.sgstMinor);
    expect(summedTotals).toBe(c.invoiceTotalMinor);
    expect(c.invoiceTotalMinor).toBe(c.taxableMinor + c.cgstMinor + c.sgstMinor);
  });

  it("inter-state puts the whole tax in IGST and nothing in CGST or SGST", () => {
    for (const amount of AWKWARD) {
      const c = computeInvoiceTax({
        lines: [{ key: "l1", grossMinor: amount, rateBps: 1800 }],
        taxKind: "igst",
        placeOfSupplyCode: "29",
      });

      expect(c.cgstMinor).toBe(0n);
      expect(c.sgstMinor).toBe(0n);
      expect(c.igstMinor).toBe(c.totalTaxMinor);
      expect(c.invoiceTotalMinor).toBe(c.taxableMinor + c.igstMinor);
    }
  });

  it("⚠️ per-line rounding does NOT equal rounding the sum — which is why lines are rounded", () => {
    // Three lines of 1 paisa at 18%: each rounds to 0, so the tax column
    // reads 0, 0, 0 and the total must read 0 too. Tax on the summed
    // ₹0.03 would round to 1 paisa and the printed column would not add
    // to the printed total.
    const c = computeInvoiceTax({
      lines: [
        { key: "a", grossMinor: 1n, rateBps: 1800 },
        { key: "b", grossMinor: 1n, rateBps: 1800 },
        { key: "c", grossMinor: 1n, rateBps: 1800 },
      ],
      taxKind: "igst",
      placeOfSupplyCode: "29",
    });

    expect(c.lines.map((l) => l.igstMinor)).toEqual([0n, 0n, 0n]);
    expect(c.igstMinor).toBe(0n);
    expect(c.invoiceTotalMinor).toBe(3n);
  });

  it("⭐ reverse-charge tax is shown but NOT added to the amount payable", () => {
    const c = computeInvoiceTax({
      lines: [
        { key: "normal", grossMinor: 10000000n, rateBps: 1800 },
        { key: "rcm", grossMinor: 5000000n, rateBps: 1800, reverseCharge: true },
      ],
      taxKind: "cgst_sgst",
      placeOfSupplyCode: "27",
    });

    expect(c.taxableMinor).toBe(15000000n);
    // Only the non-RCM line's tax is collected.
    expect(c.totalTaxMinor).toBe(1800000n);
    expect(c.reverseChargeTaxMinor).toBe(900000n);
    // ⭐ The customer owes value + collected tax. Adding the RCM tax would
    // charge them for tax we do not owe, which they then pay again.
    expect(c.invoiceTotalMinor).toBe(15000000n + 1800000n);
  });

  it("cess is computed ad valorem and per unit, and lands in the total", () => {
    const c = computeInvoiceTax({
      lines: [
        {
          key: "coal",
          grossMinor: 100000n,
          quantity: 3,
          rateBps: 500,
          cessRateBps: 0,
          cessPerUnitMinor: 40000n, // ₹400 a tonne
        },
      ],
      taxKind: "igst",
      placeOfSupplyCode: "29",
    });

    expect(c.cessMinor).toBe(120000n);
    expect(c.invoiceTotalMinor).toBe(100000n + 5000n + 120000n);
  });

  it("round-off to the rupee is exact and half-up", () => {
    expect(roundOffToRupee(11249n)).toBe(-49n);
    expect(roundOffToRupee(11250n)).toBe(50n);
    expect(roundOffToRupee(11200n)).toBe(0n);

    const c = computeInvoiceTax({
      lines: [{ key: "a", grossMinor: 874563333n, rateBps: 500 }],
      taxKind: "igst",
      placeOfSupplyCode: "29",
      roundToRupee: true,
    });
    expect(c.amountPayableMinor % 100n).toBe(0n);
    expect(c.amountPayableMinor).toBe(c.invoiceTotalMinor + c.roundOffMinor);
  });

  it("a discount larger than the line is refused rather than silently negated", () => {
    expect(() =>
      computeInvoiceTax({
        lines: [{ key: "a", grossMinor: 100n, rateBps: 1800, discountMinor: 200n }],
        taxKind: "igst",
        placeOfSupplyCode: "29",
      }),
    ).toThrow(/credit note/i);
  });

  it("the reconciliation helper names which head is off, and by how much", () => {
    const problems = reconcileInvoice({
      header: {
        subtotalMinor: 10000000n,
        discountMinor: 0n,
        cgstMinor: 600001n, // one paisa too much
        sgstMinor: 600000n,
        igstMinor: 0n,
        cessMinor: 0n,
        totalMinor: 11200001n,
      },
      lines: [
        {
          taxableMinor: 10000000n,
          cgstMinor: 600000n,
          sgstMinor: 600000n,
          igstMinor: 0n,
          cessMinor: 0n,
          isReverseCharge: false,
        },
      ],
    });

    expect(problems.map((p) => p.field)).toContain("CGST");
  });
});

/* ================================================================== */
/* 6. ⭐ THE DATABASE REFUSES AN INVOICE THAT DOES NOT ADD UP          */
/* ================================================================== */

describe("⭐ a GST invoice must agree with its own lines", () => {
  it("a correctly computed invoice commits", async () => {
    const id = randomUUID();
    const number = `AH/REC/${randomUUID().slice(0, 8)}`;

    const c = computeInvoiceTax({
      lines: [
        { key: "a", grossMinor: 874563333n, rateBps: 500 },
        { key: "b", grossMinor: 33333n, rateBps: 1800 },
      ],
      taxKind: "cgst_sgst",
      placeOfSupplyCode: "27",
    });

    await asTenant(tenantA, async (client) => {
      await client.query(
        `INSERT INTO invoices
           (id, tenant_id, invoice_number, subtotal_minor, discount_minor,
            cgst_minor, sgst_minor, igst_minor, cess_minor, total_minor,
            supply_type, place_of_supply_code, gst_computed, tax_point_date)
         VALUES ($1,$2,$3,$4,0,$5,$6,0,0,$7,'services','27',true, DATE '2024-05-01')`,
        [
          id,
          tenantA,
          number,
          c.taxableMinor.toString(),
          c.cgstMinor.toString(),
          c.sgstMinor.toString(),
          c.invoiceTotalMinor.toString(),
        ],
      );

      for (const line of c.lines) {
        await client.query(
          `INSERT INTO invoice_lines
             (invoice_id, tenant_id, description, quantity, unit_amount_minor,
              amount_minor, tax_rate_bps, taxable_value_minor, cgst_minor, sgst_minor)
           VALUES ($1,$2,$3,1,$4,$4,$5,$6,$7,$8)`,
          [
            id,
            tenantA,
            line.key,
            line.grossMinor.toString(),
            line.rateBps,
            line.taxableMinor.toString(),
            line.cgstMinor.toString(),
            line.sgstMinor.toString(),
          ],
        );
      }
    });

    await asTenant(tenantA, async (client) => {
      const { rows } = await client.query(
        `SELECT total_minor FROM invoices WHERE id = $1`,
        [id],
      );
      expect(String(rows[0].total_minor)).toBe(c.invoiceTotalMinor.toString());
    });
  });

  it("⭐ a header that disagrees with its lines is REFUSED at commit", async () => {
    const id = randomUUID();

    const error = await expectError(() =>
      asTenant(tenantA, async (client) => {
        // Header claims ₹1,000 of CGST; the single line carries ₹600.
        // Both halves balance internally, which is exactly why the
        // header-only check cannot catch this.
        await client.query(
          `INSERT INTO invoices
             (id, tenant_id, invoice_number, subtotal_minor, discount_minor,
              cgst_minor, sgst_minor, igst_minor, cess_minor, total_minor,
              supply_type, place_of_supply_code, gst_computed)
           VALUES ($1,$2,$3, 10000000, 0, 100000, 600000, 0, 0, 10700000,
                   'services','27', true)`,
          [id, tenantA, `AH/BAD2/${randomUUID().slice(0, 8)}`],
        );
        await client.query(
          `INSERT INTO invoice_lines
             (invoice_id, tenant_id, description, quantity, unit_amount_minor,
              amount_minor, tax_rate_bps, taxable_value_minor, cgst_minor, sgst_minor)
           VALUES ($1,$2,'Mismatched',1,10000000,10000000,1200,10000000,600000,600000)`,
          [id, tenantA],
        );
      }),
    );

    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/does not add up/i);
  });

  it("a Phase 16 subscription invoice with no line tax is unaffected", async () => {
    // `gst_computed` is false, so the reconciliation trigger does not
    // fire. Without that switch every subscription invoice ever raised
    // would start failing.
    const id = randomUUID();
    await asTenant(tenantA, async (client) => {
      await client.query(
        `INSERT INTO invoices
           (id, tenant_id, invoice_number, subtotal_minor, discount_minor,
            cgst_minor, sgst_minor, igst_minor, total_minor)
         VALUES ($1,$2,$3, 499900, 0, 0, 0, 89982, 589882)`,
        [id, tenantA, `AH/SUB/${randomUUID().slice(0, 8)}`],
      );
      await client.query(
        `INSERT INTO invoice_lines
           (invoice_id, tenant_id, description, quantity, unit_amount_minor, amount_minor)
         VALUES ($1,$2,'Subscription',1,499900,499900)`,
        [id, tenantA],
      );
    });

    await asTenant(tenantA, async (client) => {
      const { rows } = await client.query(`SELECT igst_minor FROM invoices WHERE id = $1`, [
        id,
      ]);
      expect(String(rows[0].igst_minor)).toBe("89982");
    });
  });
});

/* ================================================================== */
/* 7. ⭐ AN INVALID GSTIN IS REFUSED                                   */
/* ================================================================== */

describe("⭐ GSTIN validation", () => {
  it("⭐ the DATABASE refuses a GSTIN whose checksum is wrong", async () => {
    // Right length, right character classes, real state code — and the
    // fifteenth character is wrong. A shape-only regex accepts it, and
    // GSTR-1 rejects it weeks later.
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(
          `INSERT INTO gst_registrations
             (tenant_id, gstin, state_code, legal_name, effective_from)
           VALUES ($1,$2,'27','Typo Ltd', DATE '2020-01-01')`,
          [tenantA, GSTIN_BAD_CHECKSUM],
        ),
      ),
    );

    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/gstin_checksum/);
  });

  it("⭐ the same GSTIN is refused on a counterparty too", async () => {
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(
          `INSERT INTO gst_parties
             (tenant_id, party_type, legal_name, gstin, registration_type,
              state_code, effective_from)
           VALUES ($1,'customer','Typo Buyer',$2,'regular','27', DATE '2020-01-01')`,
          [tenantA, GSTIN_BAD_CHECKSUM],
        ),
      ),
    );

    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/gstin_checksum/);
  });

  it("a valid GSTIN is accepted", async () => {
    await asTenant(tenantA, async (c) =>
      c.query(
        `INSERT INTO gst_parties
           (tenant_id, party_type, legal_name, gstin, registration_type,
            state_code, effective_from)
         VALUES ($1,'customer','Good Buyer Pvt Ltd',$2,'regular','29', DATE '2020-01-01')`,
        [tenantA, GSTIN_KA],
      ),
    );

    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(
        `SELECT gstin FROM gst_parties WHERE tenant_id = $1`,
        [tenantA],
      );
      expect(rows.map((r) => r.gstin)).toContain(GSTIN_KA);
    });
  });

  it("⭐ the schema refuses the bad checksum before it reaches the database", () => {
    expect(gstinSchema.safeParse(GSTIN_BAD_CHECKSUM).success).toBe(false);
    expect(gstinSchema.safeParse(GSTIN_MH).success).toBe(true);
    // Pasted from an email signature, in lower case. Must be accepted.
    expect(gstinSchema.safeParse(GSTIN_MH.toLowerCase()).success).toBe(true);
  });

  it("the diagnosis names the character that should have been there", () => {
    const problem = describeGstinProblem(GSTIN_BAD_CHECKSUM);
    expect(problem).not.toBeNull();
    expect(problem!.message).toMatch(/should be "7"/);

    expect(describeGstinProblem(GSTIN_MH)).toBeNull();
  });

  it("the diagnosis reports the FIRST thing wrong, in the order a person notices", () => {
    // 14 characters. Reporting a checksum failure here is correct and
    // useless — the checksum is wrong BECAUSE a character is missing.
    expect(describeGstinProblem("27AAACR5055K1Z")!.message).toMatch(/15 characters/);
    expect(describeGstinProblem("99AAACR5055K1Z5")!.message).toMatch(/not an Indian GST state/);
    expect(describeGstinProblem("")!.message).toMatch(/No GSTIN/);
  });

  it("a party's registration type and GSTIN must agree", async () => {
    // "unregistered" WITH a GSTIN raises a B2C invoice to a registered
    // buyer, who loses the input credit and finds out at their year end.
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(
          `INSERT INTO gst_parties
             (tenant_id, party_type, legal_name, gstin, registration_type, effective_from)
           VALUES ($1,'customer','Contradiction Ltd',$2,'unregistered', DATE '2020-01-01')`,
          [tenantA, GSTIN_MH],
        ),
      ),
    );

    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/type_matches_gstin/);
  });

  it("two registrations of one company share a PAN", () => {
    expect(sharesPan(GSTIN_MH, GSTIN_KA)).toBe(true);
    expect(parseGstin(GSTIN_MH)?.pan).toBe("AAACR5055K");
    expect(parseGstin(GSTIN_MH)?.stateName).toBe("Maharashtra");
  });
});

/* ================================================================== */
/* 8. DATES, AND WHY THEY ARE CIVIL DAYS                               */
/* ================================================================== */

describe("tax dates are Indian civil days", () => {
  it("⭐ an IST evening is the NEXT day, and that decides the rate", () => {
    // 2019-03-31T20:00:00Z is 1 April 2019, 1:30am in Mumbai. An invoice
    // raised then is a 5% invoice. Comparing in UTC makes it 12%.
    expect(toCivilDay(new Date("2019-03-31T20:00:00Z"))).toBe("2019-04-01");
    expect(toCivilDay(new Date("2019-03-31T18:00:00Z"))).toBe("2019-03-31");
  });

  it("a YYYY-MM-DD string passes through untouched", () => {
    // Re-parsing it through Date would drag it into UTC and shift it.
    expect(toCivilDay("2019-04-01")).toBe("2019-04-01");
  });

  it("the financial year runs April to March", () => {
    expect(financialYearOf("2024-03-31")).toBe("2023-24");
    expect(financialYearOf("2024-04-01")).toBe("2024-25");
    expect(financialYearOf("2024-12-31")).toBe("2024-25");
  });
});

/* ================================================================== */
/* 9. RULE 46                                                          */
/* ================================================================== */

describe("Rule 46 tax invoice fields", () => {
  const baseDoc = {
    invoiceNumber: "AH/2425/0148",
    issuedAt: "2024-05-01",
    supplierLegalName: "Ordence Developers LLP",
    supplierGstin: GSTIN_MH,
    supplierStateCode: "27",
    supplierAddress: { line1: "Baner", city: "Pune", state: "Maharashtra" },
    recipientLegalName: "Good Buyer Pvt Ltd",
    recipientGstin: GSTIN_KA,
    recipientRegistration: "regular" as const,
    recipientAddress: { line1: "Indiranagar", city: "Bengaluru" },
    recipientStateCode: "29",
    supplyType: "immovable_property" as const,
    placeOfSupplyCode: "27",
    propertyStateCode: "27",
    isInterState: false,
    isReverseCharge: false,
    deliveryAddress: null,
    signedBy: "Authorised Signatory",
    totalMinor: 10500000n,
    lines: [
      {
        description: "Construction of Flat A-1203",
        hsnSacCode: "995411",
        quantity: 1,
        uqc: null,
        taxableMinor: 10000000n,
        rateBps: 500,
      },
    ],
  };

  it("a complete tax invoice passes", () => {
    const report = checkRule46(baseDoc);
    expect(report.blocking).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.financialYear).toBe("2024-25");
  });

  it("⭐ blocks an immovable-property invoice taxed in the buyer's state", () => {
    const report = checkRule46({ ...baseDoc, placeOfSupplyCode: "29" });
    expect(report.ok).toBe(false);
    expect(report.blocking.some((f) => f.rule.includes("12(3)"))).toBe(true);
  });

  it("blocks an invoice number longer than Rule 46(b) allows", () => {
    const report = checkRule46({
      ...baseDoc,
      invoiceNumber: "ORDENCE/2024-25/000148",
    });
    expect(report.blocking.some((f) => f.field === "invoiceNumber")).toBe(true);
  });

  it("blocks a registered buyer with no GSTIN on the document", () => {
    const report = checkRule46({ ...baseDoc, recipientGstin: null });
    expect(report.blocking.some((f) => f.rule === "46(e)")).toBe(true);
  });

  it("requires the address of an unregistered buyer above ₹50,000", () => {
    const report = checkRule46({
      ...baseDoc,
      recipientRegistration: "unregistered",
      recipientGstin: null,
      recipientAddress: null,
      recipientStateCode: null,
    });
    expect(report.blocking.some((f) => f.rule === "46(f)")).toBe(true);
  });

  it("blocks a line with no HSN or SAC — it would have no defensible rate", () => {
    const report = checkRule46({
      ...baseDoc,
      lines: [{ ...baseDoc.lines[0]!, hsnSacCode: null }],
    });
    expect(report.blocking.some((f) => f.field === "lines[0].hsnSacCode")).toBe(true);
  });

  it("an unsigned invoice is advisory, not blocking — e-invoices are not signed by hand", () => {
    const report = checkRule46({ ...baseDoc, signedBy: null });
    expect(report.ok).toBe(true);
    expect(report.advisory.some((f) => f.rule === "46(q)")).toBe(true);
  });
});
