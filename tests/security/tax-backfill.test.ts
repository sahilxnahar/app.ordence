/**
 * Ordence — 0148: A BACKFILL THAT PINS WHAT IT CAN IDENTIFY AND NOTHING ELSE
 * Version: v0.34.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE IS ACTUALLY TRYING TO PROVE
 * ══════════════════════════════════════════════════════════════════════
 * 0146 made a rate pin tenant-true and 0147 made it mean something.
 * Neither put a pin on a single existing row, and almost every outward
 * supply line in this product has `hsn_sac_rate_id IS NULL` because no
 * code path has ever resolved one. So a backfill was always coming.
 *
 * 🔴 AND A BACKFILL IS EXACTLY WHERE AN ERP LIES TO ITS CUSTOMER. The
 * classic version recomputes historical tax at today's rates: rates
 * change, the rate in force on the invoice date governs, and a sweep
 * that assumes otherwise silently restates documents already filed in a
 * return. The resulting figures are indistinguishable from real ones.
 *
 * ⭐⭐ SO THE FOUR NEGATIVE ASSERTIONS BELOW ARE THE POINT OF THIS FILE,
 * NOT ITS PADDING. A backfill that pinned all five probe lines would
 * sail through a "did it pin anything?" test — and would have invented
 * four rate provenances, each of which looks exactly like evidence and
 * is a guess. The test worth writing is the one that fails when the
 * sweep gets GREEDY, and greed is the direction this kind of code drifts
 * in, because pinning more rows feels like progress.
 *
 * The five lines, one workspace, one call:
 *
 *   1. identifiable        — classified, an 18% period covers its date,
 *                            and it already charged 18%.        → PINNED
 *   2. no classification   — charged tax, names no HSN/SAC.     → left
 *   3. rate disagrees      — a period covers the date and says
 *                            18%; the document charged 5%.      → left
 *   4. document frozen     — identical to 1, but issued.         → left
 *   5. no rate in force    — classified under a code that has no
 *                            rate period at all.                → left
 *
 * ⚠️ EVERY DATABASE ASSERTION RUNS AS THE ORDINARY APPLICATION ROLE.
 * `asSuperuser` appears only for fixtures and teardown. That matters
 * more than usual here: `gst_backfill_rate_pins` is SECURITY INVOKER on
 * purpose, so that a workspace's sweep can only ever reach its own
 * documents — and a suite that ran it as a superuser would prove
 * precisely nothing about that.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { asTenant, asSuperuser } from "../setup";

/* ================================================================== */
/* FIXTURES                                                            */
/* ================================================================== */

let tenantMain: string;
/** A second workspace, for the dry run and for the view's own isolation. */
let tenantOther: string;

let companyMain: string;
let codeRated: string;
/** A classification with NO rate period anywhere. */
let codeUnrated: string;
let rate18: string;
let rate12: string;
let invDraft: string;
let invIssued: string;

let lineIdentifiable: string;
let lineNoClassification: string;
let lineRateDisagrees: string;
let lineFrozen: string;
let lineNoRateInForce: string;

/** ⭐ Captured in `beforeAll` so that no test depends on another having run. */
let backfillSummary: Array<{ verdict: string; lines: string; acted: boolean }> = [];

const DOC_DATE = "2026-08-19";

beforeAll(async () => {
  tenantMain = randomUUID();
  tenantOther = randomUUID();
  companyMain = randomUUID();
  codeRated = randomUUID();
  codeUnrated = randomUUID();
  rate18 = randomUUID();
  rate12 = randomUUID();
  invDraft = randomUUID();
  invIssued = randomUUID();
  lineIdentifiable = randomUUID();
  lineNoClassification = randomUUID();
  lineRateDisagrees = randomUUID();
  lineFrozen = randomUUID();
  lineNoRateInForce = randomUUID();

  await asSuperuser(async (c) => {
    for (const [id, name, slug] of [
      [tenantMain, "Backfill Main", "bf-main"],
      [tenantOther, "Backfill Other", "bf-other"],
    ] as const) {
      await c.query(
        `INSERT INTO tenants (id, clerk_org_id, slug, name, status)
         VALUES ($1,$2,$3,$4,'active')`,
        [id, `org_${id}`, `${slug}-${id.slice(0, 8)}`, name],
      );
    }

    await c.query(`INSERT INTO companies (id, tenant_id, name) VALUES ($1,$2,'Backfill Customer')`, [
      companyMain,
      tenantMain,
    ]);

    await c.query(
      `INSERT INTO hsn_sac_codes (id, tenant_id, code, kind, description)
       VALUES ($1,$2,'998314','sac','Rated classification'),
              ($3,$2,'998315','sac','Classification with no rate period')`,
      [codeRated, tenantMain, codeUnrated],
    );

    // 18% in force on the document date; 12% closed long before it. The
    // second period exists so the "identifiable" case is a real
    // resolution and not the trivial one-row lookup that passes whatever
    // the resolver does.
    await c.query(
      `INSERT INTO hsn_sac_rates
         (id, tenant_id, hsn_sac_id, rate_bps, cess_rate_bps, effective_from, effective_to)
       VALUES ($1,$2,$3,1800,0, DATE '2019-04-01', NULL),
              ($4,$2,$3,1200,0, DATE '2017-07-01', DATE '2019-04-01')`,
      [rate18, tenantMain, codeRated, rate12],
    );

    await c.query(
      `INSERT INTO sales_invoices
         (id, tenant_id, invoice_number, financial_year, status, company_id,
          invoice_date, place_of_supply_code, is_inter_state, supply_type, currency)
       VALUES ($1,$2,$3,'2026-27','draft',$4, DATE '${DOC_DATE}','29',true,'services','INR')`,
      [invDraft, tenantMain, `BF/DRAFT/${invDraft.slice(0, 8)}`, companyMain],
    );

    // ⚠️ THE FROZEN DOCUMENT IS CREATED AS A DRAFT AND ISSUED AFTERWARDS,
    // because `sales_invoice_lines_freeze` refuses to add a line to a
    // document that has already left draft — which is the very freeze the
    // fourth verdict exists to respect. Building it in the other order
    // would be impossible, and that impossibility is the reason 0148
    // reports the verdict through a VIEW rather than writing a marker
    // column onto the row.
    await c.query(
      `INSERT INTO sales_invoices
         (id, tenant_id, invoice_number, financial_year, status, company_id,
          invoice_date, place_of_supply_code, is_inter_state, supply_type, currency,
          issued_at)
       VALUES ($1,$2,$3,'2026-27','draft',$4, DATE '${DOC_DATE}','29',true,'services','INR', now())`,
      [invIssued, tenantMain, `BF/ISSUED/${invIssued.slice(0, 8)}`, companyMain],
    );

    /* --- THE FIVE LINES ------------------------------------------- */

    // 1. IDENTIFIABLE: classified, 18% covers the date, charged 18%.
    await c.query(
      `INSERT INTO sales_invoice_lines
         (id, tenant_id, invoice_id, line_no, description, quantity, uom,
          unit_price_minor, taxable_value_minor, tax_rate_bps, igst_minor,
          hsn_sac_code_id)
       VALUES ($1,$2,$3,1,'identifiable',1,'nos',100000,100000,1800,18000,$4)`,
      [lineIdentifiable, tenantMain, invDraft, codeRated],
    );

    // 2. NO CLASSIFICATION: charged tax, names no HSN/SAC at all.
    await c.query(
      `INSERT INTO sales_invoice_lines
         (id, tenant_id, invoice_id, line_no, description, quantity, uom,
          unit_price_minor, taxable_value_minor, tax_rate_bps, igst_minor)
       VALUES ($1,$2,$3,2,'no classification',1,'nos',100000,100000,1800,18000)`,
      [lineNoClassification, tenantMain, invDraft],
    );

    // 3. RATE DISAGREES: the registry says 18% on this date; the document
    //    charged 5%, honestly and consistently. Pinning it would assert a
    //    provenance the figure does not have.
    await c.query(
      `INSERT INTO sales_invoice_lines
         (id, tenant_id, invoice_id, line_no, description, quantity, uom,
          unit_price_minor, taxable_value_minor, tax_rate_bps, igst_minor,
          hsn_sac_code_id)
       VALUES ($1,$2,$3,3,'rate disagrees',1,'nos',100000,100000,500,5000,$4)`,
      [lineRateDisagrees, tenantMain, invDraft, codeRated],
    );

    // 5. NO RATE IN FORCE: classified under a code with no period at all.
    await c.query(
      `INSERT INTO sales_invoice_lines
         (id, tenant_id, invoice_id, line_no, description, quantity, uom,
          unit_price_minor, taxable_value_minor, tax_rate_bps, igst_minor,
          hsn_sac_code_id)
       VALUES ($1,$2,$3,4,'no rate in force',1,'nos',100000,100000,1800,18000,$4)`,
      [lineNoRateInForce, tenantMain, invDraft, codeUnrated],
    );

    // 4. FROZEN: byte-for-byte the identifiable case, on an issued document.
    await c.query(
      `INSERT INTO sales_invoice_lines
         (id, tenant_id, invoice_id, line_no, description, quantity, uom,
          unit_price_minor, taxable_value_minor, tax_rate_bps, igst_minor,
          hsn_sac_code_id)
       VALUES ($1,$2,$3,1,'frozen',1,'nos',100000,100000,1800,18000,$4)`,
      [lineFrozen, tenantMain, invIssued, codeRated],
    );
    await c.query(`UPDATE sales_invoices SET status = 'issued' WHERE id = $1`, [invIssued]);
  });

  /**
   * ⭐ THE RUN ITSELF HAPPENS ONCE, HERE, AS THE ORDINARY ROLE.
   *
   * Not inside the first `it`. Every assertion below reads the state the
   * sweep left behind, and a test that only holds when it runs after
   * another test is a test that fails for the wrong reason the day
   * somebody adds a `.only` or reorders the file.
   */
  backfillSummary = await asTenant(tenantMain, async (c) => {
    const { rows } = await c.query(
      `SELECT verdict, lines::text AS lines, acted FROM gst_backfill_rate_pins(true)`,
    );
    return rows as Array<{ verdict: string; lines: string; acted: boolean }>;
  });
});

afterAll(async () => {
  await asSuperuser(async (c) => {
    const tenants = [tenantMain, tenantOther];

    // ⚠️ THE ISSUED INVOICE HAS TO BE PUT BACK INTO DRAFT BEFORE ITS
    // LINES CAN GO, AND THAT IS THE FREEZE WORKING, NOT AN OBSTACLE.
    // `sales_invoice_lines_freeze` refuses to remove a line from a
    // document that has been issued — which is exactly why 0148 reports
    // `unbackfillable_document_frozen` through a view instead of trying
    // to write a marker onto the row. A teardown that met this and
    // reached for `ALTER TABLE ... DISABLE TRIGGER` would void the
    // guarantee for every later run, and the suite would still pass.
    await c.query(
      `UPDATE sales_invoices SET status = 'draft' WHERE tenant_id = ANY($1::uuid[])`,
      [tenants],
    );
    await c.query(`DELETE FROM sales_invoice_lines WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM sales_invoices WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM companies WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM hsn_sac_rates WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM hsn_sac_codes WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM change_log WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
    await c.query(`DELETE FROM tenants WHERE id = ANY($1::uuid[])`, [tenants]);
  });
});

/** Read the whole worklist for the main workspace, keyed by line id. */
async function verdicts(): Promise<Record<string, string>> {
  return asTenant(tenantMain, async (c) => {
    const { rows } = await c.query(
      `SELECT document_line_id, verdict FROM gst_rate_pin_status
        WHERE document_table = 'sales_invoice_lines'`,
    );
    return Object.fromEntries(rows.map((r) => [r.document_line_id, r.verdict])) as Record<
      string,
      string
    >;
  });
}

/** The rate pin actually written onto a line, read back as the ordinary role. */
async function pinOf(lineId: string): Promise<string | null> {
  return asTenant(tenantMain, async (c) => {
    const { rows } = await c.query(`SELECT hsn_sac_rate_id FROM sales_invoice_lines WHERE id = $1`, [
      lineId,
    ]);
    return (rows[0]?.hsn_sac_rate_id ?? null) as string | null;
  });
}

/* ================================================================== */
/* 1. ⭐ THE ONE LINE IT COULD IDENTIFY                                */
/* ================================================================== */

describe("⭐ the backfill pins the line whose provenance is recoverable", () => {
  it("⭐⭐ pins the identifiable line to the period in force on the document's OWN date", async () => {
    // Not the current period. Not the most recent. The one whose window
    // contains 2026-08-19 — which here happens to be the open period,
    // and would not be for a 2018 document. The 12% period exists in the
    // same fixture precisely so this is a resolution and not a lookup.
    expect(await pinOf(lineIdentifiable)).toBe(rate18);
  });

  it("⭐ and pinning it moved no money at all", async () => {
    // ⚠️ THE ASSERTION THAT MAKES THE PIN HONEST. Condition 3 of the four
    // is that the registry period already agrees with what the line
    // charged, so the pin RECORDS which row produced the figure that was
    // already there. If a backfill ever changes a figure, it is not a
    // backfill, it is a restatement of a filed document.
    await asTenant(tenantMain, async (c) => {
      const { rows } = await c.query(
        `SELECT tax_rate_bps, taxable_value_minor::text AS taxable, igst_minor::text AS igst
           FROM sales_invoice_lines WHERE id = $1`,
        [lineIdentifiable],
      );
      expect(rows[0]).toEqual({ tax_rate_bps: 1800, taxable: "100000", igst: "18000" });
    });
  });

  it("reports it as already_pinned once the sweep has run", async () => {
    const v = await verdicts();
    expect(v[lineIdentifiable]).toBe("already_pinned");
  });
});

/* ================================================================== */
/* 2. ⭐⭐ THE FOUR IT REFUSED TO GUESS AT — THE POINT OF THE FILE      */
/* ================================================================== */

describe("⭐⭐ the four lines it left alone, and the reason it gave for each", () => {
  it("⭐⭐ pinned EXACTLY ONE line out of five", async () => {
    // ══════════════════════════════════════════════════════════════
    // THE COUNTING ASSERTION, AND IT IS DELIBERATELY A COUNT.
    //
    // "Did it pin the right one?" is satisfied by a sweep that pins all
    // five. This is the assertion that separates identification from
    // invention, and it is the one that fails on the day somebody
    // relaxes a condition to "improve coverage".
    // ══════════════════════════════════════════════════════════════
    await asTenant(tenantMain, async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM sales_invoice_lines WHERE hsn_sac_rate_id IS NOT NULL`,
      );
      expect(rows[0].n).toBe(1);
    });
  });

  it("⭐ left the unclassified line alone, and said why", async () => {
    // No `hsn_sac_code_id` means there is no classification to resolve a
    // period against. The only way to pin it would be to guess from the
    // rate it charged — 18% is 18% under a hundred different codes — and
    // a guess recorded as provenance is a lie with a foreign key.
    expect(await pinOf(lineNoClassification)).toBeNull();
    const v = await verdicts();
    expect(v[lineNoClassification]).toBe("unbackfillable_no_classification");
  });

  it("⭐⭐ left the line whose registry rate disagrees with what was charged, and said why", async () => {
    // ⭐ THE MOST DANGEROUS OF THE FOUR, because it is the one a
    // well-meaning sweep pins anyway: the classification is there, a
    // period covers the date, everything "matches" except the number.
    // Pinning it would attach a notification citing 18% to a document
    // that charged 5% — the pin would then contradict the figure it is
    // supposed to explain, and 0147's own trigger would refuse the next
    // edit of that row for a reason the backfill created.
    expect(await pinOf(lineRateDisagrees)).toBeNull();
    const v = await verdicts();
    expect(v[lineRateDisagrees]).toBe("unbackfillable_rate_disagrees");
  });

  it("⭐ left the line on the ISSUED invoice alone, and said why", async () => {
    // Identical in every respect to the line that WAS pinned, except
    // that its document has been issued. The customer holds it. Writing
    // to it is refused by `sales_invoice_lines_freeze`, and the correct
    // response to that is to report the row, not to weaken the freeze —
    // which is why the verdict lives in a view and not in a column.
    expect(await pinOf(lineFrozen)).toBeNull();
    const v = await verdicts();
    expect(v[lineFrozen]).toBe("unbackfillable_document_frozen");
  });

  it("⭐ left the line with no rate period in force alone, and said why", async () => {
    // The registry simply has nothing for that classification. This is
    // the verdict that is expected to SHRINK: every rate-master import
    // turns some of these into `pinnable`, which is why 0148 is
    // re-runnable and why the view reports as-at-now rather than
    // as-at-migration.
    expect(await pinOf(lineNoRateInForce)).toBeNull();
    const v = await verdicts();
    expect(v[lineNoRateInForce]).toBe("unbackfillable_no_rate_in_force");
  });

  it("⭐ the summary the function returned agrees with the rows it left behind", async () => {
    // The function's own answer is checked against the table, because a
    // report that disagrees with the database is the failure mode a
    // "coverage number" invites: it is read far more often than the rows
    // it describes.
    const byVerdict = Object.fromEntries(backfillSummary.map((r) => [r.verdict, Number(r.lines)]));
    expect(byVerdict).toEqual({
      already_pinned: 1,
      unbackfillable_no_classification: 1,
      unbackfillable_rate_disagrees: 1,
      unbackfillable_document_frozen: 1,
      unbackfillable_no_rate_in_force: 1,
    });
  });
});

/* ================================================================== */
/* 3. ⭐ THE DRY RUN IS THE DEFAULT                                    */
/* ================================================================== */

describe("⭐ the dry run writes nothing", () => {
  it("⭐ reports the pinnable line and leaves it unpinned", async () => {
    // ⚠️ A BACKFILL WHOSE ONLY MODE IS "GO" GETS RUN ONCE BY SOMEBODY WHO
    // WANTED TO LOOK. This runs in a workspace of its own so that the
    // assertion is about the dry run and not about whatever the main
    // fixture's sweep already did.
    const company = randomUUID();
    const code = randomUUID();
    const rate = randomUUID();
    const invoice = randomUUID();
    const line = randomUUID();

    await asSuperuser(async (c) => {
      await c.query(`INSERT INTO companies (id, tenant_id, name) VALUES ($1,$2,'Dry Run')`, [
        company,
        tenantOther,
      ]);
      await c.query(
        `INSERT INTO hsn_sac_codes (id, tenant_id, code, kind, description)
         VALUES ($1,$2,'998314','sac','dry run')`,
        [code, tenantOther],
      );
      await c.query(
        `INSERT INTO hsn_sac_rates (id, tenant_id, hsn_sac_id, rate_bps, effective_from)
         VALUES ($1,$2,$3,1800, DATE '2019-04-01')`,
        [rate, tenantOther, code],
      );
      await c.query(
        `INSERT INTO sales_invoices
           (id, tenant_id, invoice_number, financial_year, status, company_id,
            invoice_date, place_of_supply_code, is_inter_state, supply_type, currency)
         VALUES ($1,$2,$3,'2026-27','draft',$4, DATE '${DOC_DATE}','29',true,'services','INR')`,
        [invoice, tenantOther, `BF/DRY/${invoice.slice(0, 8)}`, company],
      );
      await c.query(
        `INSERT INTO sales_invoice_lines
           (id, tenant_id, invoice_id, line_no, description, quantity, uom,
            unit_price_minor, taxable_value_minor, tax_rate_bps, igst_minor,
            hsn_sac_code_id)
         VALUES ($1,$2,$3,1,'dry run',1,'nos',100000,100000,1800,18000,$4)`,
        [line, tenantOther, invoice, code],
      );
    });

    await asTenant(tenantOther, async (c) => {
      const { rows } = await c.query(
        `SELECT verdict, lines::text AS lines, acted FROM gst_backfill_rate_pins()`,
      );
      expect(rows).toEqual([{ verdict: "pinnable", lines: "1", acted: false }]);
    });

    await asTenant(tenantOther, async (c) => {
      const { rows } = await c.query(`SELECT hsn_sac_rate_id FROM sales_invoice_lines WHERE id = $1`, [
        line,
      ]);
      expect(rows[0].hsn_sac_rate_id, "the dry run must not have written a pin").toBeNull();
    });

    // ⭐ AND THE SIBLING: the same call with p_commit => true DOES act on
    // the row it reported. A dry run that is indistinguishable from a
    // broken function is not a safety feature.
    await asTenant(tenantOther, async (c) => {
      await c.query(`SELECT * FROM gst_backfill_rate_pins(true)`);
    });
    await asTenant(tenantOther, async (c) => {
      const { rows } = await c.query(`SELECT hsn_sac_rate_id FROM sales_invoice_lines WHERE id = $1`, [
        line,
      ]);
      expect(rows[0].hsn_sac_rate_id).toBe(rate);
    });
  });
});

/* ================================================================== */
/* 4. ⭐ THE WORKLIST IS A PER-WORKSPACE WORKLIST                      */
/* ================================================================== */

describe("⭐ gst_rate_pin_status is scoped to the workspace that asks", () => {
  it("⭐ one workspace's sweep cannot see, or reach, another's documents", async () => {
    // ⚠️ `security_invoker = true` ON THE VIEW AND `SECURITY INVOKER` ON
    // THE FUNCTION ARE THE WHOLE TENANT BOUNDARY HERE. Without them the
    // view runs as its owner, every tenant reads every tenant's
    // worklist, and a single call to `gst_backfill_rate_pins(true)`
    // rewrites documents in workspaces the caller has never heard of.
    // A view is an easy place for that to go unnoticed, which is why it
    // is asserted rather than read off the DDL.
    const mainLineIds = new Set([
      lineIdentifiable,
      lineNoClassification,
      lineRateDisagrees,
      lineFrozen,
      lineNoRateInForce,
    ]);

    await asTenant(tenantOther, async (c) => {
      const { rows } = await c.query(`SELECT document_line_id, tenant_id FROM gst_rate_pin_status`);
      for (const row of rows) {
        expect(row.tenant_id).toBe(tenantOther);
        expect(mainLineIds.has(row.document_line_id)).toBe(false);
      }
    });

    // And the main workspace still sees exactly its own five.
    await asTenant(tenantMain, async (c) => {
      const { rows } = await c.query(`SELECT count(*)::int AS n FROM gst_rate_pin_status`);
      expect(rows[0].n).toBe(5);
    });
  });
});
