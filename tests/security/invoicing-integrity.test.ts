/**
 * Ordence — Invoice Creation Integrity
 * Version: v0.16.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * PHASE 11 PROVED AN INVOICE CANNOT BE TAMPERED WITH.
 * THIS PROVES ONE CANNOT BE CREATED WRONGLY.
 * ══════════════════════════════════════════════════════════════════════
 * Immutability is worth nothing against the failure mode that actually
 * happens in production: issuing the SAME PERIOD TWICE.
 *
 * A redelivered webhook, a cron that ran twice, an operator who clicked
 * again because the first attempt seemed slow. Each produces a second,
 * perfectly valid, perfectly immutable invoice for a month the customer
 * has already been billed for. They notice. There is no way to withdraw
 * it except a credit note, so the mistake ends up permanently in both
 * parties' filings.
 *
 * An application-level "check whether one exists" races: two concurrent
 * runs both read "none", both write. So it is a unique index, and this
 * file proves it by racing it.
 *
 * ⚠️ Every assertion runs as `ordence_app`, a NON-SUPERUSER. A superuser
 * bypasses RLS entirely; `asSuperuser` appears only in fixtures.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { asTenant, asSuperuser, expectError } from "../setup";

type Fixtures = {
  tenantA: string;
  tenantB: string;
  planId: string;
  subA: string;
  subB: string;
};

let fx: Fixtures;

const PERIOD_START = "2026-08-01T00:00:00Z";
const PERIOD_END = "2026-09-01T00:00:00Z";

/** Insert an invoice as a draft, attach a line, then issue it. */
async function issueInvoice(
  tenantId: string,
  subscriptionId: string | null,
  opts: {
    number?: string;
    periodStart?: string | null;
    periodEnd?: string | null;
    status?: string;
    subtotal?: bigint;
  } = {},
): Promise<string> {
  const id = randomUUID();
  const subtotal = opts.subtotal ?? 100000n;
  const igst = (subtotal * 18n) / 100n;
  const total = subtotal + igst;

  await asTenant(tenantId, async (c) => {
    await c.query(
      `INSERT INTO invoices
         (id, tenant_id, subscription_id, invoice_number, status, currency,
          subtotal_minor, discount_minor, cgst_minor, sgst_minor, igst_minor,
          total_minor, period_start, period_end, issued_at)
       VALUES ($1,$2,$3,$4,'draft','INR',$5,0,0,0,$6,$7,$8,$9, now())`,
      [
        id,
        tenantId,
        subscriptionId,
        opts.number ?? `T/${id.slice(0, 8)}`,
        subtotal.toString(),
        igst.toString(),
        total.toString(),
        opts.periodStart === undefined ? PERIOD_START : opts.periodStart,
        opts.periodEnd === undefined ? PERIOD_END : opts.periodEnd,
      ],
    );

    // ⚠️ Lines FIRST, then issue. The reverse raises 42501 — see the
    // Phase 11 trigger. The generator follows the same order for the
    // same reason.
    await c.query(
      `INSERT INTO invoice_lines
         (invoice_id, tenant_id, description, quantity, unit_amount_minor, amount_minor)
       VALUES ($1,$2,'Subscription',1,$3,$3)`,
      [id, tenantId, subtotal.toString()],
    );

    const status = opts.status ?? "open";
    if (status !== "draft") {
      await c.query(`UPDATE invoices SET status = $1 WHERE id = $2`, [status, id]);
    }
  });

  return id;
}

beforeAll(async () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const planId = randomUUID();
  const subA = randomUUID();
  const subB = randomUUID();

  await asSuperuser(async (c) => {
    for (const [id, name] of [
      [tenantA, "Invoicing A"],
      [tenantB, "Invoicing B"],
    ] as const) {
      await c.query(
        `INSERT INTO tenants (id, clerk_org_id, slug, name, status)
         VALUES ($1,$2,$3,$4,'active')`,
        [id, `org_${id}`, `inv-${id.slice(0, 8)}`, name],
      );
    }

    await c.query(
      `INSERT INTO plans (id, code, name, tier, interval, currency, amount_minor)
       VALUES ($1,$2,$3,'advanced','monthly','INR',499900)`,
      [planId, `inv_${planId.slice(0, 8)}`, "Invoicing Plan"],
    );

    for (const [id, tenant] of [
      [subA, tenantA],
      [subB, tenantB],
    ] as const) {
      await c.query(
        `INSERT INTO subscriptions
           (id, tenant_id, plan_id, status, provider, currency, unit_amount_minor,
            interval, current_period_start, current_period_end)
         VALUES ($1,$2,$3,'active','razorpay','INR',499900,'monthly',$4,$5)`,
        [id, tenant, planId, PERIOD_START, PERIOD_END],
      );
    }
  });

  fx = { tenantA, tenantB, planId, subA, subB };
});

afterAll(async () => {
  await asSuperuser(async (c) => {
    await c.query("ALTER TABLE invoice_lines DISABLE TRIGGER USER");
    await c.query("ALTER TABLE invoices DISABLE TRIGGER USER");
    try {
      await c.query(`DELETE FROM invoice_lines WHERE tenant_id = ANY($1::uuid[])`, [
        [fx.tenantA, fx.tenantB],
      ]);
      await c.query(`DELETE FROM invoices WHERE tenant_id = ANY($1::uuid[])`, [
        [fx.tenantA, fx.tenantB],
      ]);
    } finally {
      await c.query("ALTER TABLE invoice_lines ENABLE TRIGGER USER");
      await c.query("ALTER TABLE invoices ENABLE TRIGGER USER");
    }

    await c.query(`DELETE FROM subscriptions WHERE tenant_id = ANY($1::uuid[])`, [
      [fx.tenantA, fx.tenantB],
    ]);
    await c.query("ALTER TABLE audit_logs DISABLE TRIGGER USER");
    await c.query(`DELETE FROM audit_logs WHERE tenant_id = ANY($1::uuid[])`, [
      [fx.tenantA, fx.tenantB],
    ]);
    await c.query("ALTER TABLE audit_logs ENABLE TRIGGER USER");
    await c.query(`DELETE FROM plans WHERE id = $1`, [fx.planId]);
    await c.query(`DELETE FROM tenants WHERE id = ANY($1::uuid[])`, [
      [fx.tenantA, fx.tenantB],
    ]);

    // Triggers must come back, or every later run silently loses its
    // append-only and immutability guarantees.
    const { rows } = await c.query(
      `SELECT tgname, tgenabled FROM pg_trigger
        WHERE tgrelid IN ('invoices'::regclass,'invoice_lines'::regclass,'audit_logs'::regclass)
          AND NOT tgisinternal`,
    );
    for (const row of rows) {
      expect(row.tgenabled, `trigger ${row.tgname} left disabled`).toBe("O");
    }
  });
});

/* ================================================================== */
/* 1. ⭐ ONE INVOICE PER PERIOD                                        */
/* ================================================================== */

describe("a subscription period cannot be invoiced twice", () => {
  it("⭐ the second invoice for the same period is REFUSED", async () => {
    await issueInvoice(fx.tenantA, fx.subA);

    const error = await expectError(() => issueInvoice(fx.tenantA, fx.subA));

    expect(
      error,
      "a second invoice was issued for a period already billed",
    ).not.toBeNull();
    expect(error!.code).toBe("23505"); // unique_violation
  });

  it("⭐ CONCURRENT attempts cannot both succeed", async () => {
    // The scenario the index exists for. An application-level "does one
    // exist?" check races: both readers see none, both write. Four
    // simultaneous attempts, exactly one may win.
    const period = "2026-10-01T00:00:00Z";
    const periodEnd = "2026-11-01T00:00:00Z";

    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        issueInvoice(fx.tenantB, fx.subB, {
          periodStart: period,
          periodEnd,
        }),
      ),
    );

    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    expect(
      succeeded,
      `${succeeded} of 4 concurrent attempts succeeded — the customer would be billed ${succeeded} times`,
    ).toBe(1);

    const { rows } = await asTenant(fx.tenantB, (c) =>
      c.query(
        `SELECT count(*)::int AS n FROM invoices
          WHERE subscription_id = $1 AND period_start = $2 AND status <> 'void'`,
        [fx.subB, period],
      ),
    );
    expect(rows[0].n).toBe(1);
  });

  it("⭐ a VOIDED invoice frees the period for a corrected one", async () => {
    // Voiding is the only supported route back from a mistaken issue. If
    // the void still occupied the slot there would be no way to correct
    // anything.
    const period = "2026-12-01T00:00:00Z";
    const periodEnd = "2027-01-01T00:00:00Z";

    const first = await issueInvoice(fx.tenantA, fx.subA, {
      periodStart: period,
      periodEnd,
    });

    // Blocked while it stands.
    expect(
      await expectError(() =>
        issueInvoice(fx.tenantA, fx.subA, { periodStart: period, periodEnd }),
      ),
    ).not.toBeNull();

    await asTenant(fx.tenantA, (c) =>
      c.query(`UPDATE invoices SET status = 'void', voided_at = now() WHERE id = $1`, [
        first,
      ]),
    );

    // Now permitted.
    const replacement = await issueInvoice(fx.tenantA, fx.subA, {
      periodStart: period,
      periodEnd,
    });
    expect(replacement).toBeTruthy();
  });

  it("a one-off invoice with no period is never blocked", async () => {
    // Manual and adjustment invoices have no period to collide on.
    for (let i = 0; i < 3; i += 1) {
      await issueInvoice(fx.tenantA, null, { periodStart: null, periodEnd: null });
    }
  });

  it("two DIFFERENT tenants can invoice the same dates", async () => {
    // The index is scoped by subscription, not by date. Two customers
    // billing for August must not collide.
    const period = "2027-02-01T00:00:00Z";
    const periodEnd = "2027-03-01T00:00:00Z";
    await issueInvoice(fx.tenantA, fx.subA, { periodStart: period, periodEnd });
    await issueInvoice(fx.tenantB, fx.subB, { periodStart: period, periodEnd });
  });
});

/* ================================================================== */
/* 2. AN ISSUED INVOICE MUST HAVE LINES                                */
/* ================================================================== */

describe("an invoice cannot be issued empty", () => {
  it("⭐ issuing with no line items is REFUSED", async () => {
    // A total with nothing itemised is not a valid GST invoice, and the
    // Phase 11 trigger does not catch it — that one prevents CHANGING an
    // issued invoice, not issuing an empty one.
    const id = randomUUID();

    await asTenant(fx.tenantA, (c) =>
      c.query(
        `INSERT INTO invoices
           (id, tenant_id, invoice_number, status, currency,
            subtotal_minor, discount_minor, cgst_minor, sgst_minor, igst_minor, total_minor)
         VALUES ($1,$2,$3,'draft','INR',100000,0,0,0,18000,118000)`,
        [id, fx.tenantA, `EMPTY/${id.slice(0, 8)}`],
      ),
    );

    const error = await expectError(() =>
      asTenant(fx.tenantA, (c) =>
        c.query(`UPDATE invoices SET status = 'open' WHERE id = $1`, [id]),
      ),
    );

    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/no line items/i);
    // Not a privilege error — that would mean the test proved nothing.
    expect(error!.message).not.toMatch(/permission denied for table/i);
  });

  it("a DRAFT may legitimately be empty while it is being built", async () => {
    const id = randomUUID();
    await asTenant(fx.tenantA, (c) =>
      c.query(
        `INSERT INTO invoices
           (id, tenant_id, invoice_number, status, currency,
            subtotal_minor, discount_minor, cgst_minor, sgst_minor, igst_minor, total_minor)
         VALUES ($1,$2,$3,'draft','INR',0,0,0,0,0,0)`,
        [id, fx.tenantA, `DRAFT/${id.slice(0, 8)}`],
      ),
    );
    // No error — building an invoice starts with an empty one.
  });

  it("recording a payment on an issued invoice still works", async () => {
    // The guard checks only the draft → issued transition. Re-counting
    // lines on every status change would make this needlessly expensive
    // and could block a payment.
    const id = await issueInvoice(fx.tenantA, null, {
      periodStart: null,
      periodEnd: null,
    });

    const { rowCount } = await asTenant(fx.tenantA, (c) =>
      c.query(
        `UPDATE invoices SET amount_paid_minor = total_minor, status = 'paid',
                paid_at = now()
          WHERE id = $1`,
        [id],
      ),
    );
    expect(rowCount).toBe(1);
  });
});

/* ================================================================== */
/* 3. ISOLATION AND PRIVILEGE                                          */
/* ================================================================== */

describe("isolation", () => {
  it("⭐ tenant A cannot see tenant B's invoices", async () => {
    const { rows } = await asTenant(fx.tenantA, (c) =>
      c.query(`SELECT count(*)::int AS n FROM invoices WHERE tenant_id = $1`, [
        fx.tenantB,
      ]),
    );
    expect(rows[0].n).toBe(0);
  });

  it("⭐ the application role cannot DELETE an invoice", async () => {
    // The correction for a bad invoice is a void or a credit note. A
    // number that vanishes from a series is exactly what an auditor asks
    // about.
    const error = await expectError(() =>
      asTenant(fx.tenantA, (c) =>
        c.query(`DELETE FROM invoices WHERE tenant_id = $1`, [fx.tenantA]),
      ),
    );
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/permission denied/i);
  });

  it("invoice numbers are unique across the whole platform", async () => {
    const clash = `CLASH/${randomUUID().slice(0, 8)}`;
    await issueInvoice(fx.tenantA, null, {
      number: clash,
      periodStart: null,
      periodEnd: null,
    });

    // Even from a DIFFERENT tenant. The series belongs to us, the
    // issuer, not to the customer — GST requires it consecutive and
    // unique across the registration.
    const error = await expectError(() =>
      issueInvoice(fx.tenantB, null, {
        number: clash,
        periodStart: null,
        periodEnd: null,
      }),
    );
    expect(error).not.toBeNull();
    expect(error!.code).toBe("23505");
  });
});
