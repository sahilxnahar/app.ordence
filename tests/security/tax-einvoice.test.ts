/**
 * Ordence — 0149: AN IRN IS THE GOVERNMENT'S, NOT OURS
 * Version: v0.34.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE IS ACTUALLY TRYING TO PROVE
 * ══════════════════════════════════════════════════════════════════════
 * Under Rule 48(4) a notified taxpayer's invoice is not a valid tax
 * invoice at all unless it was reported to an Invoice Registration
 * Portal and carries the IRN and signed QR code the IRP returned. The
 * portal computes the IRN once per (supplier GSTIN, document number,
 * document type, financial year), SIGNS the payload, and accepts a
 * cancellation only within 24 hours.
 *
 * Every one of those is a database rule and none of them was one:
 *
 *   🔴 the IRN could be edited, or set back to NULL, by any UPDATE;
 *   🔴 two documents could carry the same IRN;
 *   🔴 the taxable value the IRP SIGNED could be changed afterwards,
 *      leaving a QR code that swears to a figure the invoice no longer
 *      shows — the customer scans it and gets a different number from
 *      the one printed six inches above it;
 *   🔴 a cancellation could be recorded three months after generation,
 *      which is a record of an event the other party refused.
 *
 * ⭐ AND THE COLUMNS ARE EMPTY TODAY, WHICH IS WHY THIS IS THE MOMENT.
 * Nothing in the product reads or writes them, so every rule here is
 * free now and expensive later: the same constraint added after the IRP
 * client ships is an ALTER TABLE, a backfill, a decision about the rows
 * that violate it, and a credit-and-reissue for the ones that are wrong.
 *
 * ⚠️ EVERY FIXTURE INVOICE BELOW IS A DRAFT, ON PURPOSE. 0049's
 * `sales_invoices_freeze` refuses the same figure edits once a document
 * is ISSUED. Probing on an issued invoice would prove that THAT trigger
 * works and would tell us nothing whatsoever about this one.
 *
 * ⚠️ EVERY DATABASE ASSERTION RUNS AS THE ORDINARY APPLICATION ROLE.
 * `asSuperuser` appears only for fixtures and teardown.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { asTenant, asSuperuser, expectError } from "../setup";

/* ================================================================== */
/* FIXTURES                                                            */
/* ================================================================== */

let tenantA: string;
let companyA: string;

/** Holds a live IRN. The immutability and figure-freeze subject. */
let invLive: string;
/** No IRN. The target of the duplicate-IRN attempt. */
let invDuplicateTarget: string;
/** No IRN. Status-without-artefacts, and the free-edit sibling. */
let invNoIrn: string;
/** Holds a live IRN. Cancellations that must be REFUSED. */
let invCancelBad: string;
/** Holds a live IRN. The cancellation that must be ACCEPTED. */
let invCancelGood: string;
/** No IRN. The first-assignment acceptance. */
let invFirstAssign: string;
/** No IRN. `generated` WITH all three artefacts — the acceptance sibling. */
let invGeneratedOk: string;
/** No IRN. A DIFFERENT IRN in the same workspace — the uniqueness sibling. */
let invSecondIrn: string;

/** 64 characters, which is what the IRP returns and what the column holds. */
const IRN_LIVE = "a".repeat(64);
const IRN_CANCEL_BAD = "b".repeat(64);
const IRN_CANCEL_GOOD = "c".repeat(64);

/** The moment the portal issued them. Everything below is relative to it. */
const GENERATED_AT = "2026-08-19 10:00:00+05:30";

const DOC_DATE = "2026-08-19";

/** One draft invoice, with figures, no IRN. */
async function insertInvoice(
  c: import("pg").PoolClient,
  id: string,
  suffix: string,
): Promise<void> {
  await c.query(
    `INSERT INTO sales_invoices
       (id, tenant_id, invoice_number, financial_year, status, company_id,
        invoice_date, place_of_supply_code, is_inter_state, supply_type, currency,
        supplier_gstin, customer_gstin,
        taxable_value_minor, igst_minor, total_minor)
     VALUES ($1,$2,$3,'2026-27','draft',$4, DATE '${DOC_DATE}','29',true,'services','INR',
             '27AAACR5055K1Z7','29AAACR5055K1Z3', 100000, 18000, 118000)`,
    [id, tenantA, `IRN/${suffix}/${id.slice(0, 8)}`, companyA],
  );
}

beforeAll(async () => {
  tenantA = randomUUID();
  companyA = randomUUID();
  invLive = randomUUID();
  invDuplicateTarget = randomUUID();
  invNoIrn = randomUUID();
  invCancelBad = randomUUID();
  invCancelGood = randomUUID();
  invFirstAssign = randomUUID();
  invGeneratedOk = randomUUID();
  invSecondIrn = randomUUID();

  await asSuperuser(async (c) => {
    await c.query(
      `INSERT INTO tenants (id, clerk_org_id, slug, name, status)
       VALUES ($1,$2,$3,'E-invoice IRN','active')`,
      [tenantA, `org_${tenantA}`, `irn-${tenantA.slice(0, 8)}`],
    );
    await c.query(`INSERT INTO companies (id, tenant_id, name) VALUES ($1,$2,'IRN Customer')`, [
      companyA,
      tenantA,
    ]);

    await insertInvoice(c, invLive, "LIVE");
    await insertInvoice(c, invDuplicateTarget, "DUP");
    await insertInvoice(c, invNoIrn, "NONE");
    await insertInvoice(c, invCancelBad, "CANBAD");
    await insertInvoice(c, invCancelGood, "CANOK");
    await insertInvoice(c, invFirstAssign, "FIRST");
    await insertInvoice(c, invGeneratedOk, "GENOK");
    await insertInvoice(c, invSecondIrn, "SECOND");

    /* --- ⭐ THE PORTAL'S ANSWERS, RECORDED ------------------------- */
    //
    // ⚠️ THIS IS FIXTURE SETUP AND NOT AN ASSERTION. That the FIRST
    // assignment is accepted is asserted properly, as the ordinary role,
    // in §1 below — on `invFirstAssign`, which is untouched here. Doing
    // it in both places is deliberate: if the trigger refused a first
    // assignment outright, this `beforeAll` would fail loudly rather
    // than leaving every refusal test below measuring a document that
    // never received an IRN.
    for (const [id, irn, ack] of [
      [invLive, IRN_LIVE, "112010000000123"],
      [invCancelBad, IRN_CANCEL_BAD, "112010000000124"],
      [invCancelGood, IRN_CANCEL_GOOD, "112010000000125"],
    ] as const) {
      await c.query(
        `UPDATE sales_invoices
            SET irn = $2, ack_no = $3, irn_generated_at = TIMESTAMPTZ '${GENERATED_AT}',
                irn_status = 'generated',
                signed_qr_code = 'eyJhbGciOiJSUzI1NiJ9.fixture',
                einvoice_payload_hash = $4
          WHERE id = $1`,
        [id, irn, ack, "0".repeat(64)],
      );
    }
  });
});

afterAll(async () => {
  await asSuperuser(async (c) => {
    await c.query(`DELETE FROM sales_invoice_lines WHERE tenant_id = $1`, [tenantA]);
    await c.query(`DELETE FROM sales_invoices WHERE tenant_id = $1`, [tenantA]);
    await c.query(`DELETE FROM companies WHERE tenant_id = $1`, [tenantA]);
    await c.query(`DELETE FROM change_log WHERE tenant_id = $1`, [tenantA]);
    await c.query(`DELETE FROM tenants WHERE id = $1`, [tenantA]);

    // The guard must still be armed for every later run. A teardown that
    // disabled it would leave the suite green and the rule gone.
    const { rows } = await c.query(
      `SELECT tgenabled::text AS state FROM pg_trigger
        WHERE tgname = 'sales_invoices_irn_integrity' AND NOT tgisinternal`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("O");
  });
});

/* ================================================================== */
/* 1. ⭐ THE IRN IS IMMUTABLE ONCE THE PORTAL HAS ISSUED IT            */
/* ================================================================== */

describe("⭐ an IRN cannot be changed or withdrawn", () => {
  it("⭐⭐ ACCEPTS the FIRST assignment of an IRN to a document", async () => {
    // ══════════════════════════════════════════════════════════════
    // THE SIBLING THAT COMES FIRST, BECAUSE EVERYTHING ELSE DEPENDS ON
    // IT. If this were refused, e-invoicing would be impossible rather
    // than correct, and every refusal below would be measuring a
    // document that never got an IRN — passing for the wrong reason.
    // ══════════════════════════════════════════════════════════════
    await asTenant(tenantA, async (c) =>
      c.query(
        `UPDATE sales_invoices
            SET irn = $2, ack_no = '112010000000200',
                irn_generated_at = TIMESTAMPTZ '${GENERATED_AT}',
                irn_status = 'generated',
                signed_qr_code = 'eyJhbGciOiJSUzI1NiJ9.first'
          WHERE id = $1`,
        [invFirstAssign, "f".repeat(64)],
      ),
    );

    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(
        `SELECT irn, irn_status, ack_no FROM sales_invoices WHERE id = $1`,
        [invFirstAssign],
      );
      expect(rows[0].irn).toBe("f".repeat(64));
      expect(rows[0].irn_status).toBe("generated");
      expect(rows[0].ack_no).toBe("112010000000200");
    });
  });

  it("⭐ REFUSES changing an existing IRN to a different value", async () => {
    // The IRP issued that string against this exact document and holds
    // its own copy. Editing ours makes the two disagree without making
    // theirs wrong.
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(`UPDATE sales_invoices SET irn = $2 WHERE id = $1`, [invLive, "z".repeat(64)]),
      ),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23514");
    expect(error!.message).toMatch(/cannot be changed or removed/i);

    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(`SELECT irn FROM sales_invoices WHERE id = $1`, [invLive]);
      expect(rows[0].irn).toBe(IRN_LIVE);
    });
  });

  it("⭐⭐ REFUSES setting an existing IRN back to NULL — the more dangerous half", async () => {
    // ⚠️ THIS LOOKS LIKE THE SAME TEST AND IS THE WORSE CASE. Clearing
    // the IRN makes a REPORTED document look unreported. The next sync
    // run reports it again, the IRP answers "duplicate IRN", and there
    // is no local record of why — the evidence that it was ever
    // registered is the column that was just emptied.
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(`UPDATE sales_invoices SET irn = NULL WHERE id = $1`, [invLive]),
      ),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23514");
    expect(error!.message).toMatch(/cannot be changed or removed/i);
  });
});

/* ================================================================== */
/* 2. ⭐ A STATUS WITHOUT ITS ARTEFACTS IS A LIE, AND SO IS THE MIRROR */
/* ================================================================== */

describe("⭐ irn_status must be consistent with what the document actually holds", () => {
  it("⭐ REFUSES irn_status = 'generated' with no IRN and no acknowledgement number", async () => {
    // `generated` is a claim that a specific government call returned.
    // The evidence of that call is the IRN, the acknowledgement number
    // and the timestamp; a row claiming it without them is filed in
    // GSTR-1 as e-invoiced and reconciles against nothing.
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(
          `UPDATE sales_invoices
              SET irn_status = 'generated', irn_generated_at = TIMESTAMPTZ '${GENERATED_AT}'
            WHERE id = $1`,
          [invNoIrn],
        ),
      ),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23514");
    expect(error!.message).toMatch(/marked irn_status=generated but is missing/i);
    // The message must name WHICH artefacts are missing, or the reader
    // is left guessing at three columns.
    expect(error!.message).toMatch(/acknowledgement number/i);
  });

  it("⭐ ACCEPTS irn_status = 'generated' when all three artefacts are present", async () => {
    // ⚠️ THE SIBLING. Without it, a trigger that refused the status
    // outright would pass the test above and make it impossible to
    // record a successful call to the portal at all.
    await asTenant(tenantA, async (c) =>
      c.query(
        `UPDATE sales_invoices
            SET irn = $2, ack_no = '112010000000201',
                irn_generated_at = TIMESTAMPTZ '${GENERATED_AT}', irn_status = 'generated'
          WHERE id = $1`,
        [invGeneratedOk, "g".repeat(64)],
      ),
    );

    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(`SELECT irn_status FROM sales_invoices WHERE id = $1`, [
        invGeneratedOk,
      ]);
      expect(rows[0].irn_status).toBe("generated");
    });
  });

  it("⭐ REFUSES an invoice that HOLDS an IRN while claiming irn_status = 'pending'", async () => {
    // ⭐ THE MIRROR, read from the other end. `pending`, `failed` and
    // `not_required` all assert that no IRN exists — `failed` says the
    // portal REFUSED — so holding one under any of them is the same lie
    // wearing different clothes.
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(`UPDATE sales_invoices SET irn_status = 'pending' WHERE id = $1`, [invLive]),
      ),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23514");
    expect(error!.message).toMatch(/only honest states for it are generated and cancelled/i);
  });
});

/* ================================================================== */
/* 3. ⭐⭐ A CANCELLATION THE PORTAL WOULD HAVE REFUSED DID NOT HAPPEN */
/* ================================================================== */

describe("⭐⭐ the IRP's 24-hour cancellation window", () => {
  it("⭐⭐ REFUSES a cancellation recorded 48 hours after generation", async () => {
    // Not a policy disagreement — a record of an event the other party
    // rejected. The document is still live at the portal, still in the
    // buyer's GSTR-2B, and our books say it is gone. The lawful remedy
    // after the window closes is a credit note under Rule 53, which is
    // its own numbered document.
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(
          `UPDATE sales_invoices
              SET irn_status = 'cancelled',
                  irn_cancelled_at = TIMESTAMPTZ '${GENERATED_AT}' + interval '48 hours',
                  irn_cancel_reason = '2 - Data entry mistake'
            WHERE id = $1`,
          [invCancelBad],
        ),
      ),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23514");
    expect(error!.message).toMatch(/only within 24 hours/i);
    expect(error!.message).toMatch(/credit note/i);
  });

  it("⭐ REFUSES a cancellation with no irn_cancelled_at at all", async () => {
    // ⚠️ THIS IS THE ROW A NULL-BLIND CHECK LETS THROUGH, and it looks
    // redundant beside the case above until you write the comparison
    // out: `NULL > generated_at + 24h` is NULL, the IF is not taken, and
    // the 24-hour rule silently passes on precisely the rows that carry
    // no evidence whatsoever. A check that skips when it cannot see its
    // input is the defect this whole wave was opened to remove.
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(`UPDATE sales_invoices SET irn_status = 'cancelled' WHERE id = $1`, [invCancelBad]),
      ),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23514");
    expect(error!.message).toMatch(/no irn_cancelled_at/i);
  });

  it("⭐ ACCEPTS a cancellation recorded 3 hours after generation", async () => {
    // ⚠️ THE SIBLING, AND IT IS THE ONE THAT KEEPS THE RULE HONEST.
    // Recording what the portal actually ALLOWS must not be harder than
    // recording what it does not; a guard that refused every
    // cancellation would pass both tests above and leave a real,
    // portal-accepted cancellation unrecordable.
    await asTenant(tenantA, async (c) =>
      c.query(
        `UPDATE sales_invoices
            SET irn_status = 'cancelled',
                irn_cancelled_at = TIMESTAMPTZ '${GENERATED_AT}' + interval '3 hours',
                irn_cancel_reason = '1 - Duplicate'
          WHERE id = $1`,
        [invCancelGood],
      ),
    );

    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(
        `SELECT irn, irn_status, irn_cancel_reason FROM sales_invoices WHERE id = $1`,
        [invCancelGood],
      );
      // ⭐ THE IRN IS STILL THERE. A cancellation at the portal does not
      // un-issue the number; §1's immutability rule and this one have to
      // hold at the same time, on the same row.
      expect(rows[0].irn).toBe(IRN_CANCEL_GOOD);
      expect(rows[0].irn_status).toBe("cancelled");
      expect(rows[0].irn_cancel_reason).toBe("1 - Duplicate");
    });
  });
});

/* ================================================================== */
/* 4. ⭐⭐ THE IRP HAS SIGNED THESE FIGURES                            */
/* ================================================================== */

describe("⭐⭐ the figures the portal signed are frozen while the IRN is live", () => {
  it("⭐⭐ REFUSES restating the taxable value and tax under a live IRN", async () => {
    // ══════════════════════════════════════════════════════════════
    // THE RULE THE OTHER THREE EXIST TO SUPPORT.
    //
    // The signed QR code carries the supplier GSTIN, the buyer GSTIN,
    // the document number and date, and the taxable and tax amounts. It
    // is signed by the IRP's key and we cannot re-sign it. The instant
    // any of those moves, the code printed on the document the customer
    // is holding swears to a figure the document no longer shows.
    // ══════════════════════════════════════════════════════════════
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(
          `UPDATE sales_invoices
              SET taxable_value_minor = 200000, igst_minor = 36000, total_minor = 236000
            WHERE id = $1`,
          [invLive],
        ),
      ),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23514");
    expect(error!.message).toMatch(/figures are signed/i);

    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(
        `SELECT taxable_value_minor::text AS taxable, total_minor::text AS total
           FROM sales_invoices WHERE id = $1`,
        [invLive],
      );
      expect(rows[0]).toEqual({ taxable: "100000", total: "118000" });
    });
  });

  it("⭐ REFUSES moving the GSTINs, the document number, its date or the place of supply", async () => {
    // ⚠️ ONE ASSERTION PER SIGNED FIELD, because "the figures" is not
    // what is signed — the PARTIES and the DOCUMENT IDENTITY are in the
    // payload too, and a freeze that covered only the money would let
    // the same document be re-addressed to a different buyer while
    // carrying a signature that names the first one.
    const attempts: ReadonlyArray<[string, string, unknown]> = [
      ["supplier_gstin", "supplier_gstin = $2", "27AAACR5055K1Z7".replace("27", "29")],
      ["customer_gstin", "customer_gstin = $2", "27AAACR5055K1Z7"],
      ["invoice_number", "invoice_number = $2", `IRN/RENAMED/${invLive.slice(0, 8)}`],
      ["invoice_date", "invoice_date = $2::date", "2026-08-18"],
      ["place_of_supply_code", "place_of_supply_code = $2", "27"],
    ];

    for (const [field, assignment, value] of attempts) {
      const error = await expectError(() =>
        asTenant(tenantA, async (c) =>
          c.query(`UPDATE sales_invoices SET ${assignment} WHERE id = $1`, [invLive, value]),
        ),
      );

      expect(error, `${field} must be frozen under a live IRN`).not.toBeNull();
      expect(error!.message, field).toMatch(/figures are signed/i);
    }
  });

  it("⭐ ACCEPTS editing a note on a document that holds an IRN", async () => {
    // ⚠️ THE SIBLING, AND THE REASON THE FREEZE IS A COLUMN LIST RATHER
    // THAN A ROW LOCK. The IRP never saw `notes`, and it never saw
    // `received_minor` either — freezing the whole row would stop an
    // e-invoiced document being marked paid, which is how a correctness
    // control becomes an outage and then gets dropped by whoever is on
    // call at the time.
    await asTenant(tenantA, async (c) =>
      c.query(`UPDATE sales_invoices SET notes = 'chased with the buyer' WHERE id = $1`, [invLive]),
    );

    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(`SELECT notes, irn FROM sales_invoices WHERE id = $1`, [
        invLive,
      ]);
      expect(rows[0].notes).toBe("chased with the buyer");
      expect(rows[0].irn).toBe(IRN_LIVE);
    });
  });

  it("⭐ ACCEPTS restating the figures on a draft that holds NO IRN", async () => {
    // ⚠️ THE SECOND SIBLING, AND TODAY IT IS EVERY INVOICE IN THE
    // PRODUCT. Below the Rule 48(4) threshold no document has an IRN,
    // and this file must be invisible to all of them. A freeze that bit
    // without an IRN present would make ordinary draft editing fail with
    // a message about a government portal nobody has called.
    await asTenant(tenantA, async (c) =>
      c.query(
        `UPDATE sales_invoices
            SET taxable_value_minor = 250000, igst_minor = 45000, total_minor = 295000
          WHERE id = $1`,
        [invNoIrn],
      ),
    );

    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(
        `SELECT total_minor::text AS total, irn_status FROM sales_invoices WHERE id = $1`,
        [invNoIrn],
      );
      expect(rows[0].total).toBe("295000");
      expect(rows[0].irn_status).toBe("not_required");
    });
  });
});

/* ================================================================== */
/* 5. ⭐ ONE IRN, ONE DOCUMENT                                         */
/* ================================================================== */

describe("⭐ the same IRN cannot appear on two documents in one workspace", () => {
  it("⭐ REFUSES a second invoice carrying an IRN this workspace already holds", async () => {
    // The realistic failure is not fraud, it is a retry loop writing one
    // IRP response twice — which produces two documents the portal
    // believes are one, and a GSTR-1 that reports the same registered
    // supply under two numbers.
    const error = await expectError(() =>
      asTenant(tenantA, async (c) =>
        c.query(
          `UPDATE sales_invoices
              SET irn = $2, ack_no = '112010000000126',
                  irn_generated_at = TIMESTAMPTZ '${GENERATED_AT}', irn_status = 'generated'
            WHERE id = $1`,
          [invDuplicateTarget, IRN_LIVE],
        ),
      ),
    );

    expect(error).not.toBeNull();
    // ⚠️ 23505, NOT 23514. This one is refused by a partial UNIQUE INDEX
    // rather than by the trigger, and the distinction matters: an index
    // is enforced beneath row-level security, which is why 0149 §3 scoped
    // it to the tenant instead of making it global — a global one would
    // let a workspace discover another's IRN by attempting an insert and
    // reading the error.
    expect(error!.code).toBe("23505");
    expect(error!.message).toMatch(/sales_invoices_irn_unique_idx/);
  });

  it("⭐ ACCEPTS a DIFFERENT IRN on a second invoice in the same workspace", async () => {
    // ⚠️ THE SIBLING. The index is partial, on `irn IS NOT NULL`.
    // Without that predicate every invoice that does not need an IRN —
    // today, all of them — would collide with every other one, and the
    // second insert into an empty table would be refused.
    await asTenant(tenantA, async (c) =>
      c.query(
        `UPDATE sales_invoices
            SET irn = $2, ack_no = '112010000000127',
                irn_generated_at = TIMESTAMPTZ '${GENERATED_AT}', irn_status = 'generated'
          WHERE id = $1`,
        [invSecondIrn, "s".repeat(64)],
      ),
    );

    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM sales_invoices WHERE irn IS NOT NULL`,
      );
      // The three fixtures plus the three assigned by the acceptance
      // tests in this file. What matters is that they are distinct.
      expect(rows[0].n).toBeGreaterThanOrEqual(2);

      const { rows: distinct } = await c.query(
        `SELECT count(*)::int AS n, count(DISTINCT irn)::int AS d
           FROM sales_invoices WHERE irn IS NOT NULL`,
      );
      expect(distinct[0].d).toBe(distinct[0].n);
    });
  });

  it("ACCEPTS many invoices with NO IRN at all — the partial predicate, proved", async () => {
    // Five of this file's eight fixtures started with `irn IS NULL` and
    // committed side by side. If the index were not partial, the second
    // of them could not have.
    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM sales_invoices WHERE irn IS NULL`,
      );
      // Two of this file's eight fixtures never receive an IRN in any
      // test, whatever order the file runs in, so this holds without
      // depending on which acceptances have executed.
      expect(rows[0].n).toBeGreaterThanOrEqual(2);
    });
  });
});
