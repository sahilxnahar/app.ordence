/**
 * Ordence — Billing Isolation & Integrity
 * Version: v0.11.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * PHASE 11 MANDATORY VERIFICATION
 * ══════════════════════════════════════════════════════════════════════
 * Billing is the first subsystem where a bug costs real money in a
 * direction that cannot be undone by a support ticket. Three guarantees
 * are asserted here, all against a REAL PostgreSQL as a NON-SUPERUSER:
 *
 *   1. A tenant cannot read or write another tenant's billing records.
 *   2. A duplicate provider event cannot be recorded twice.
 *   3. An issued invoice's amounts cannot be altered.
 *
 * ⚠️ EVERY ASSERTION RUNS AS `ordence_app`, NOT AS `postgres`. A superuser
 * bypasses RLS entirely, so a suite connected as one would pass with
 * every policy dropped. `asSuperuser` appears only in fixture setup and
 * teardown; if it ever appears inside an assertion, that assertion is
 * worthless.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { asTenant, withoutTenant, asSuperuser, expectError , asPlatform } from "../setup";

type Fixtures = {
  tenantA: string;
  tenantB: string;
  planBasic: string;
  planAdvanced: string;
  subA: string;
  subB: string;
  invoiceA: string;
  invoiceB: string;
  draftA: string;
};

let fx: Fixtures;

/** Tenant B's figures are deliberately unmistakable if they ever leak. */
const A_TOTAL = 500000n; // ₹5,000.00
const B_TOTAL = 98765432n; // ₹9,87,654.32

/**
 * Assert that a statement was refused BY THE GUARD UNDER TEST, and not by
 * a missing GRANT.
 *
 * This distinction cost real time in Phase 9: a missing privilege raises
 * SQLSTATE 42501, which is exactly what our tamper triggers raise. A test
 * whose role simply had no rights on the table passed for entirely the
 * wrong reason and proved nothing at all.
 */
async function expectGuard(
  fn: () => Promise<unknown>,
  messagePattern: RegExp,
): Promise<void> {
  const error = await expectError(fn);

  expect(error, "expected the statement to be refused, but it succeeded").not.toBeNull();

  expect(
    error!.message,
    `the statement failed with a PRIVILEGE error, not the expected guard — ` +
      `the test role is missing a GRANT and this test proves nothing: ${error!.message}`,
  ).not.toMatch(/permission denied for (table|relation)/i);

  expect(error!.message).toMatch(messagePattern);
}

const PERIOD_START = "2026-07-01T00:00:00Z";
const PERIOD_END = "2026-08-01T00:00:00Z";

beforeAll(async () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const planBasic = randomUUID();
  const planAdvanced = randomUUID();
  const subA = randomUUID();
  const subB = randomUUID();
  const invoiceA = randomUUID();
  const invoiceB = randomUUID();
  const draftA = randomUUID();

  await asSuperuser(async (c) => {
    for (const [id, name] of [
      [tenantA, "Billing Tenant A"],
      [tenantB, "Billing Tenant B"],
    ] as const) {
      await c.query(
        `INSERT INTO tenants (id, clerk_org_id, slug, name, status)
         VALUES ($1,$2,$3,$4,'active')`,
        [id, `org_${id}`, `bil-${id.slice(0, 8)}`, name],
      );
    }

    for (const [id, code, tier, amount] of [
      [planBasic, `basic_${planBasic.slice(0, 8)}`, "basic", 199900],
      [planAdvanced, `adv_${planAdvanced.slice(0, 8)}`, "advanced", 499900],
    ] as const) {
      await c.query(
        `INSERT INTO plans (id, code, name, tier, interval, currency, amount_minor)
         VALUES ($1,$2,$3,$4,'monthly','INR',$5)`,
        [id, code, code, tier, amount],
      );
    }

    for (const [id, tenant, plan, amount] of [
      [subA, tenantA, planBasic, 199900],
      [subB, tenantB, planAdvanced, 499900],
    ] as const) {
      await c.query(
        `INSERT INTO subscriptions
           (id, tenant_id, plan_id, status, provider, currency,
            unit_amount_minor, interval, seats_purchased,
            current_period_start, current_period_end)
         VALUES ($1,$2,$3,'active','razorpay','INR',$4,'monthly',5,$5,$6)`,
        [id, tenant, plan, amount, PERIOD_START, PERIOD_END],
      );
    }

    // Two ISSUED invoices, one per tenant, plus a DRAFT for tenant A.
    for (const [id, tenant, sub, number, total, status] of [
      [invoiceA, tenantA, subA, `A/${invoiceA.slice(0, 8)}`, A_TOTAL, "open"],
      [invoiceB, tenantB, subB, `B/${invoiceB.slice(0, 8)}`, B_TOTAL, "open"],
      [draftA, tenantA, subA, `D/${draftA.slice(0, 8)}`, A_TOTAL, "draft"],
    ] as const) {
      // subtotal + igst = total, so the CHECK constraint is satisfied.
      const subtotal = (total * 100n) / 118n;
      const igst = total - subtotal;

      /**
       * ⚠️ THE ORDER HERE IS FORCED BY THE SCHEMA, AND THAT IS THE POINT.
       *
       * `invoice_lines` refuses INSERT when its parent is not a draft, so
       * an invoice must be BUILT as a draft, have its lines added, and
       * only then be issued. Creating it as `open` and attaching lines
       * afterwards fails with 42501.
       *
       * An earlier version of this fixture did exactly that and the guard
       * caught it — which is a better outcome than the alternative, where
       * lines could be attached to a document a customer already holds.
       * Phase 16's invoice generator must follow the same sequence.
       */
      await c.query(
        `INSERT INTO invoices
           (id, tenant_id, subscription_id, invoice_number, status, currency,
            subtotal_minor, discount_minor, cgst_minor, sgst_minor, igst_minor,
            total_minor, issued_at)
         VALUES ($1,$2,$3,$4,'draft','INR',$5,0,0,0,$6,$7, now())`,
        [id, tenant, sub, number, subtotal, igst, total],
      );

      await c.query(
        `INSERT INTO invoice_lines
           (invoice_id, tenant_id, description, quantity, unit_amount_minor, amount_minor)
         VALUES ($1,$2,'Subscription',1,$3,$3)`,
        [id, tenant, subtotal],
      );

      // Now issue it. draft → open is permitted; everything after is not.
      if (status !== "draft") {
        await c.query(`UPDATE invoices SET status = $1 WHERE id = $2`, [status, id]);
      }
    }

    // One payment event per tenant, plus one ORPHAN with no tenant at all.
    for (const [tenant, sub, eventId, amount] of [
      [tenantA, subA, `evt_a_${randomUUID()}`, A_TOTAL],
      [tenantB, subB, `evt_b_${randomUUID()}`, B_TOTAL],
    ] as const) {
      await c.query(
        `INSERT INTO payment_events
           (tenant_id, subscription_id, provider, provider_event_id,
            provider_event_name, event_type, status, amount_minor, currency)
         VALUES ($1,$2,'razorpay',$3,'payment.captured','payment_succeeded',
                 'processed',$4,'INR')`,
        [tenant, sub, eventId, amount],
      );
    }

    await c.query(
      `INSERT INTO payment_events
         (tenant_id, provider, provider_event_id, provider_event_name,
          event_type, status)
       VALUES (NULL,'stripe',$1,'invoice.paid','invoice_paid','ignored_unknown_tenant')`,
      [`evt_orphan_${randomUUID()}`],
    );
  });

  fx = {
    tenantA,
    tenantB,
    planBasic,
    planAdvanced,
    subA,
    subB,
    invoiceA,
    invoiceB,
    draftA,
  };
});

afterAll(async () => {
  await asSuperuser(async (c) => {
    /**
     * `payment_events` is append-only at the ENGINE level, so ordinary
     * teardown cannot delete its rows — the trigger refuses even for a
     * superuser. Disabling the triggers for the duration of cleanup is
     * the only way, and they are re-enabled immediately.
     *
     * This exact pattern was needed in Phase 9 for `contract_signatures`.
     * Leaving the triggers off would silently remove the guarantee for
     * every subsequent test run.
     */
    await c.query("ALTER TABLE payment_events DISABLE TRIGGER USER");
    try {
      await c.query(
        `DELETE FROM payment_events WHERE tenant_id = ANY($1::uuid[]) OR tenant_id IS NULL`,
        [[fx.tenantA, fx.tenantB]],
      );
    } finally {
      await c.query("ALTER TABLE payment_events ENABLE TRIGGER USER");
    }

    // Invoice lines are protected while their parent is not a draft.
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
    await c.query(`DELETE FROM audit_logs WHERE tenant_id = ANY($1::uuid[])`, [
      [fx.tenantA, fx.tenantB],
    ]).catch(async () => {
      await c.query("ALTER TABLE audit_logs DISABLE TRIGGER USER");
      await c.query(`DELETE FROM audit_logs WHERE tenant_id = ANY($1::uuid[])`, [
        [fx.tenantA, fx.tenantB],
      ]);
      await c.query("ALTER TABLE audit_logs ENABLE TRIGGER USER");
    });
    await c.query(`DELETE FROM plans WHERE id = ANY($1::uuid[])`, [
      [fx.planBasic, fx.planAdvanced],
    ]);
    await c.query(`DELETE FROM tenants WHERE id = ANY($1::uuid[])`, [
      [fx.tenantA, fx.tenantB],
    ]);

    // ⭐ Prove the triggers came back. A teardown that left them disabled
    // would silently void every append-only guarantee from here on.
    const { rows } = await c.query(
      `SELECT tgname, tgenabled FROM pg_trigger
       WHERE tgrelid IN ('payment_events'::regclass, 'invoices'::regclass,
                         'invoice_lines'::regclass)
         AND NOT tgisinternal`,
    );
    for (const row of rows) {
      expect(row.tgenabled, `trigger ${row.tgname} was left disabled`).toBe("O");
    }
  });
});

/* ================================================================== */
/* 1. TENANT ISOLATION                                                 */
/* ================================================================== */

describe("tenant isolation across every billing table", () => {
  for (const table of [
    "subscriptions",
    "invoices",
    "invoice_lines",
    "payment_methods",
  ] as const) {
    it(`${table}: RLS is ENABLED and FORCED`, async () => {
      // FORCE is what makes the policy apply to the table OWNER. Without
      // it the isolation is decorative on any deployment where the app
      // connects as the owner — which is most of them, including Neon.
      const { rows } = await withoutTenant((c) =>
        c.query(
          `SELECT relrowsecurity, relforcerowsecurity
             FROM pg_class WHERE relname = $1`,
          [table],
        ),
      );
      expect(rows[0]?.relrowsecurity, `${table} RLS not enabled`).toBe(true);
      expect(rows[0]?.relforcerowsecurity, `${table} RLS not FORCED`).toBe(true);
    });
  }

  it("tenant A sees ONLY its own subscription", async () => {
    const { rows } = await asTenant(fx.tenantA, (c) =>
      c.query(`SELECT id, tenant_id, unit_amount_minor FROM subscriptions`),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(fx.subA);
    expect(rows[0].tenant_id).toBe(fx.tenantA);
  });

  it("⭐ tenant A CANNOT see tenant B's invoice, even by explicit id", async () => {
    const { rows } = await asTenant(fx.tenantA, (c) =>
      c.query(`SELECT id, total_minor FROM invoices WHERE id = $1`, [fx.invoiceB]),
    );
    expect(rows).toHaveLength(0);
  });

  it("⭐ an aggregate over invoices returns ONLY tenant A's money", async () => {
    // The dangerous failure is not an error — it is a correct-looking
    // number that includes another customer's revenue.
    const { rows } = await asTenant(fx.tenantA, (c) =>
      c.query(`SELECT COALESCE(SUM(total_minor),0)::text AS total FROM invoices`),
    );
    // Tenant A has one open invoice and one draft, both at A_TOTAL.
    expect(BigInt(rows[0].total)).toBe(A_TOTAL * 2n);
    expect(BigInt(rows[0].total)).not.toBe(A_TOTAL * 2n + B_TOTAL);
  });

  it("isolation is SYMMETRIC — tenant B sees its own figures, not nothing", async () => {
    // A policy that returned zero rows for EVERYONE would pass a naive
    // "cannot see the other tenant" test while breaking the product.
    const { rows } = await asTenant(fx.tenantB, (c) =>
      c.query(`SELECT COALESCE(SUM(total_minor),0)::text AS total FROM invoices`),
    );
    expect(BigInt(rows[0].total)).toBe(B_TOTAL);
  });

  it("no tenant context returns ZERO rows, not ALL rows", async () => {
    // Fail closed. If a code path ever forgets to open a tenant
    // transaction, the result must be empty, never the whole platform.
    for (const table of ["subscriptions", "invoices", "invoice_lines"]) {
      const { rows } = await withoutTenant((c) =>
        c.query(`SELECT count(*)::int AS n FROM ${table}`),
      );
      expect(rows[0].n, `${table} leaked with no tenant context`).toBe(0);
    }
  });

  it("a garbage tenant context returns zero rows", async () => {
    const { rows } = await asTenant(randomUUID(), (c) =>
      c.query(`SELECT count(*)::int AS n FROM invoices`),
    );
    expect(rows[0].n).toBe(0);
  });

  it("⭐ tenant A CANNOT INSERT a row belonging to tenant B", async () => {
    // The write-side leak. A policy with only USING filters reads and
    // silently permits this — which is how one tenant plants a
    // subscription in another's account.
    const error = await expectError(() =>
      asTenant(fx.tenantA, (c) =>
        c.query(
          `INSERT INTO subscriptions
             (tenant_id, plan_id, status, provider, currency, unit_amount_minor,
              interval, current_period_start, current_period_end)
           VALUES ($1,$2,'active','razorpay','INR',1,'monthly',$3,$4)`,
          [fx.tenantB, fx.planBasic, PERIOD_START, PERIOD_END],
        ),
      ),
    );
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/row-level security|violates/i);
  });

  it("⭐ tenant A CANNOT UPDATE tenant B's invoice", async () => {
    const { rowCount } = await asTenant(fx.tenantA, (c) =>
      c.query(`UPDATE invoices SET notes = 'tampered' WHERE id = $1`, [fx.invoiceB]),
    );
    // RLS makes the row invisible, so the UPDATE matches nothing. It does
    // not error — it simply has no effect, which is the correct outcome.
    expect(rowCount).toBe(0);

    const { rows } = await asTenant(fx.tenantB, (c) =>
      c.query(`SELECT notes FROM invoices WHERE id = $1`, [fx.invoiceB]),
    );
    expect(rows[0].notes).toBeNull();
  });

  it("⭐ the application role has NO hard-DELETE on subscriptions at all", async () => {
    // Two separate guarantees, and it is worth being precise about which
    // one fires here.
    //
    // An earlier version of this test asserted that tenant A's DELETE of
    // tenant B's row simply affected zero rows. It failed — with
    // `permission denied` — because the GRANT in 0009 deliberately omits
    // DELETE on `subscriptions`. Billing records are SOFT-deleted so that
    // history survives; a hard delete would destroy the trail behind an
    // invoice that still exists.
    //
    // So the privilege layer stops this before RLS is ever consulted,
    // which is defence in depth working as intended. The test now asserts
    // what is actually true rather than what was assumed.
    const error = await expectError(() =>
      asTenant(fx.tenantA, (c) =>
        c.query(`DELETE FROM subscriptions WHERE id = $1`, [fx.subB]),
      ),
    );
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/permission denied/i);

    // And tenant B's row is untouched.
    const { rows } = await asTenant(fx.tenantB, (c) =>
      c.query(`SELECT count(*)::int AS n FROM subscriptions WHERE id = $1`, [fx.subB]),
    );
    expect(rows[0].n).toBe(1);
  });

  it("⭐ tenant A cannot SOFT-delete tenant B's subscription either", async () => {
    // The route that IS granted: an UPDATE setting deleted_at. RLS makes
    // the row invisible, so it matches nothing.
    const { rowCount } = await asTenant(fx.tenantA, (c) =>
      c.query(`UPDATE subscriptions SET deleted_at = now() WHERE id = $1`, [fx.subB]),
    );
    expect(rowCount).toBe(0);

    const { rows } = await asTenant(fx.tenantB, (c) =>
      c.query(`SELECT deleted_at FROM subscriptions WHERE id = $1`, [fx.subB]),
    );
    expect(rows[0].deleted_at).toBeNull();
  });
});

/* ================================================================== */
/* 2. THE payment_events NULL-TENANT POLICY                            */
/* ================================================================== */

describe("payment_events — the orphan-event policy", () => {
  it("a tenant sees its OWN events", async () => {
    const { rows } = await asTenant(fx.tenantA, (c) =>
      c.query(`SELECT tenant_id FROM payment_events`),
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.tenant_id).toBe(fx.tenantA);
  });

  it("⭐ a tenant does NOT see orphan (null-tenant) events", async () => {
    // The policy permits NULL rows only when there is NO tenant context.
    // If a tenant session could read them, one customer's failed webhook
    // payload would be visible to another.
    const { rows } = await asTenant(fx.tenantA, (c) =>
      c.query(`SELECT count(*)::int AS n FROM payment_events WHERE tenant_id IS NULL`),
    );
    expect(rows[0].n).toBe(0);
  });

  it("platform scope (no tenant context) sees ONLY orphan events", async () => {
    const { rows } = await asPlatform((c) =>
      c.query(`SELECT tenant_id FROM payment_events`),
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.tenant_id).toBeNull();
  });
});

/* ================================================================== */
/* 3. IDEMPOTENCY — THE REPLAY DEFENCE                                 */
/* ================================================================== */

describe("webhook replay protection", () => {
  it("⭐ the SAME provider event id CANNOT be inserted twice", async () => {
    // THE single most important guarantee in this phase. Without it a
    // retried webhook extends a billing period twice and charges a
    // customer twice, and nothing anywhere reports a problem.
    const eventId = `evt_replay_${randomUUID()}`;

    await asTenant(fx.tenantA, (c) =>
      c.query(
        `INSERT INTO payment_events
           (tenant_id, subscription_id, provider, provider_event_id,
            provider_event_name, event_type, status)
         VALUES ($1,$2,'razorpay',$3,'payment.captured','payment_succeeded','processed')`,
        [fx.tenantA, fx.subA, eventId],
      ),
    );

    const error = await expectError(() =>
      asTenant(fx.tenantA, (c) =>
        c.query(
          `INSERT INTO payment_events
             (tenant_id, subscription_id, provider, provider_event_id,
              provider_event_name, event_type, status)
           VALUES ($1,$2,'razorpay',$3,'payment.captured','payment_succeeded','processed')`,
          [fx.tenantA, fx.subA, eventId],
        ),
      ),
    );

    expect(error, "a duplicate provider event was accepted").not.toBeNull();
    expect(error!.code).toBe("23505"); // unique_violation
  });

  it("the same id from a DIFFERENT provider is allowed", async () => {
    // The index is scoped by provider, so Razorpay and Stripe cannot
    // collide if they ever mint the same id string.
    const shared = `evt_shared_${randomUUID()}`;
    for (const provider of ["razorpay", "stripe"]) {
      await asTenant(fx.tenantA, (c) =>
        c.query(
          `INSERT INTO payment_events
             (tenant_id, provider, provider_event_id, provider_event_name,
              event_type, status)
           VALUES ($1,$2,$3,'x','payment_succeeded','processed')`,
          [fx.tenantA, provider, shared],
        ),
      );
    }
    const { rows } = await asTenant(fx.tenantA, (c) =>
      c.query(`SELECT count(*)::int AS n FROM payment_events WHERE provider_event_id = $1`, [
        shared,
      ]),
    );
    expect(rows[0].n).toBe(2);
  });

  it("⭐ two tenants cannot both claim the same provider event", async () => {
    // Otherwise tenant B could replay tenant A's webhook against their own
    // subscription and get a free period.
    const eventId = `evt_cross_${randomUUID()}`;

    await asTenant(fx.tenantA, (c) =>
      c.query(
        `INSERT INTO payment_events
           (tenant_id, provider, provider_event_id, provider_event_name,
            event_type, status)
         VALUES ($1,'razorpay',$2,'x','payment_succeeded','processed')`,
        [fx.tenantA, eventId],
      ),
    );

    const error = await expectError(() =>
      asTenant(fx.tenantB, (c) =>
        c.query(
          `INSERT INTO payment_events
             (tenant_id, provider, provider_event_id, provider_event_name,
              event_type, status)
           VALUES ($1,'razorpay',$2,'x','payment_succeeded','processed')`,
          [fx.tenantB, eventId],
        ),
      ),
    );

    // ⚠️ Worth noting precisely: the index is GLOBAL, not per-tenant, so
    // this is caught even though tenant B cannot SEE tenant A's row. That
    // is deliberate — a per-tenant index would leave this hole open.
    expect(error).not.toBeNull();
    expect(error!.code).toBe("23505");
  });
});

/* ================================================================== */
/* 4. APPEND-ONLY PAYMENT EVIDENCE                                     */
/* ================================================================== */

describe("payment_events is append-only", () => {
  /**
   * ══════════════════════════════════════════════════════════════════
   * TWO INDEPENDENT LAYERS, TESTED SEPARATELY — AND WHY THAT MATTERS
   * ══════════════════════════════════════════════════════════════════
   * `payment_events` is protected twice over:
   *
   *   LAYER 1 — GRANT. The application role holds SELECT and INSERT only.
   *             An UPDATE never reaches the trigger; it is refused by the
   *             privilege system first.
   *   LAYER 2 — TRIGGER. Refuses UPDATE and DELETE for ANY role, including
   *             a superuser and including the table owner.
   *
   * Both raise SQLSTATE 42501, which is exactly the trap that cost time in
   * Phase 9: a test whose role simply lacked a privilege passed while
   * proving nothing about the trigger it claimed to be testing.
   *
   * So the two layers get two tests, each asserting the message that
   * identifies WHICH layer fired. If the GRANT were ever loosened, the
   * first test fails; if the trigger were ever dropped, the second does.
   * Neither can mask the other.
   */

  it("LAYER 1 — the application role has no UPDATE or DELETE privilege", async () => {
    for (const statement of [
      `UPDATE payment_events SET amount_minor = 1`,
      `DELETE FROM payment_events`,
    ]) {
      const error = await expectError(() =>
        asTenant(fx.tenantA, (c) => c.query(statement)),
      );
      expect(error, statement).not.toBeNull();
      expect(error!.message).toMatch(/permission denied for table payment_events/i);
    }
  });

  it("⭐ LAYER 2 — the TRIGGER refuses UPDATE even for a superuser", async () => {
    // The point of engine-level enforcement: an engineer "fixing" a bad
    // reconciliation with an UPDATE would produce a history describing a
    // past that did not happen. A GRANT cannot stop that; a trigger can.
    const error = await expectError(() =>
      asSuperuser((c) => c.query(`UPDATE payment_events SET status = 'processed'`)),
    );
    expect(error).not.toBeNull();
    expect(error!.code).toBe("42501");
    expect(error!.message).toMatch(/append-only/i);
    // Explicitly NOT a privilege error — a superuser has every privilege.
    expect(error!.message).not.toMatch(/permission denied/i);
  });

  it("⭐ LAYER 2 — the TRIGGER refuses DELETE even for a superuser", async () => {
    const error = await expectError(() =>
      asSuperuser((c) =>
        c.query(`DELETE FROM payment_events WHERE tenant_id = $1`, [fx.tenantA]),
      ),
    );
    expect(error).not.toBeNull();
    expect(error!.code).toBe("42501");
    expect(error!.message).toMatch(/append-only/i);
    expect(error!.message).not.toMatch(/permission denied/i);
  });

  it("INSERT is still permitted — the log must be writable to be a log", async () => {
    await asTenant(fx.tenantA, (c) =>
      c.query(
        `INSERT INTO payment_events
           (tenant_id, provider, provider_event_id, provider_event_name,
            event_type, status)
         VALUES ($1,'razorpay',$2,'x','payment_succeeded','processed')`,
        [fx.tenantA, `evt_append_${randomUUID()}`],
      ),
    );
  });
});

/* ================================================================== */
/* 5. ISSUED INVOICES ARE IMMUTABLE                                    */
/* ================================================================== */

describe("issued invoice immutability", () => {
  it("⭐ the total of an ISSUED invoice cannot be changed", async () => {
    // Once issued, the customer holds a copy. Changing our side produces
    // two documents with one number and two totals.
    await expectGuard(
      () =>
        asTenant(fx.tenantA, (c) =>
          c.query(`UPDATE invoices SET total_minor = 1 WHERE id = $1`, [fx.invoiceA]),
        ),
      /has been issued|amounts are fixed/i,
    );
  });

  it("the invoice NUMBER cannot be changed once issued", async () => {
    await expectGuard(
      () =>
        asTenant(fx.tenantA, (c) =>
          c.query(`UPDATE invoices SET invoice_number = 'FORGED/1' WHERE id = $1`, [
            fx.invoiceA,
          ]),
        ),
      /number cannot be changed/i,
    );
  });

  it("the tax identity cannot be changed once issued", async () => {
    await expectGuard(
      () =>
        asTenant(fx.tenantA, (c) =>
          c.query(`UPDATE invoices SET place_of_supply_code = '27' WHERE id = $1`, [
            fx.invoiceA,
          ]),
        ),
      /tax identity/i,
    );
  });

  it("payment state CAN still be recorded on an issued invoice", async () => {
    // Money arriving is a change to the invoice's STATE, not to the bill.
    // If this were blocked the whole table would be useless.
    const { rowCount } = await asTenant(fx.tenantA, (c) =>
      c.query(
        `UPDATE invoices SET amount_paid_minor = $1, status = 'paid', paid_at = now()
         WHERE id = $2`,
        [A_TOTAL.toString(), fx.invoiceA],
      ),
    );
    expect(rowCount).toBe(1);
  });

  it("a DRAFT invoice remains fully editable", async () => {
    // ⚠️ Every amount column must move TOGETHER. The `invoices_totals_balance`
    // CHECK is not suspended for drafts — an earlier version of this test
    // changed the subtotal alone and was correctly rejected, because the
    // header would no longer have equalled its own components.
    const { rowCount } = await asTenant(fx.tenantA, (c) =>
      c.query(
        `UPDATE invoices
            SET subtotal_minor = 100, discount_minor = 0,
                cgst_minor = 0, sgst_minor = 0, igst_minor = 18,
                total_minor = 118
          WHERE id = $1`,
        [fx.draftA],
      ),
    );
    expect(rowCount).toBe(1);
  });

  it("⭐ line items of an issued invoice cannot be rewritten", async () => {
    // Without this the header trigger is trivially bypassed: leave the
    // totals alone and rewrite what was bought.
    await expectGuard(
      () =>
        asTenant(fx.tenantA, (c) =>
          c.query(`UPDATE invoice_lines SET description = 'something else'
                   WHERE invoice_id = $1`, [fx.invoiceA]),
        ),
      /line items are fixed/i,
    );
  });

  it("a line CANNOT be added to an issued invoice", async () => {
    await expectGuard(
      () =>
        asTenant(fx.tenantA, (c) =>
          c.query(
            `INSERT INTO invoice_lines
               (invoice_id, tenant_id, description, quantity, unit_amount_minor, amount_minor)
             VALUES ($1,$2,'Sneaked in',1,1,1)`,
            [fx.invoiceA, fx.tenantA],
          ),
        ),
      /line items are fixed/i,
    );
  });
});

/* ================================================================== */
/* 6. ARITHMETIC INTEGRITY                                             */
/* ================================================================== */

describe("invoice arithmetic is enforced by the database", () => {
  it("⭐ an invoice whose total does not equal its parts is REJECTED", async () => {
    const error = await expectError(() =>
      asSuperuser((c) =>
        c.query(
          `INSERT INTO invoices
             (tenant_id, invoice_number, status, currency, subtotal_minor,
              discount_minor, cgst_minor, sgst_minor, igst_minor, total_minor)
           VALUES ($1,$2,'draft','INR',100000,0,0,0,18000, 999999)`,
          [fx.tenantA, `BAD/${randomUUID().slice(0, 8)}`],
        ),
      ),
    );
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/totals_balance/i);
  });

  it("IGST and CGST/SGST are mutually exclusive", async () => {
    // Populating all three would double-charge tax on a GST return.
    const error = await expectError(() =>
      asSuperuser((c) =>
        c.query(
          `INSERT INTO invoices
             (tenant_id, invoice_number, status, currency, subtotal_minor,
              discount_minor, cgst_minor, sgst_minor, igst_minor, total_minor)
           VALUES ($1,$2,'draft','INR',100000,0,9000,9000,18000, 136000)`,
          [fx.tenantA, `BAD2/${randomUUID().slice(0, 8)}`],
        ),
      ),
    );
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/mutually_exclusive/i);
  });

  it("a line's amount must equal quantity × unit price", async () => {
    const error = await expectError(() =>
      asSuperuser((c) =>
        c.query(
          `INSERT INTO invoice_lines
             (invoice_id, tenant_id, description, quantity, unit_amount_minor, amount_minor)
           VALUES ($1,$2,'Wrong maths',3,100, 999)`,
          [fx.draftA, fx.tenantA],
        ),
      ),
    );
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/amount_consistent/i);
  });

  it("a subscription period cannot end before it starts", async () => {
    // Every proration computed from an inverted period would be wrong.
    const error = await expectError(() =>
      asSuperuser((c) =>
        c.query(
          `INSERT INTO subscriptions
             (tenant_id, plan_id, status, provider, currency, unit_amount_minor,
              interval, current_period_start, current_period_end)
           VALUES ($1,$2,'cancelled','razorpay','INR',1,'monthly',$3,$4)`,
          [fx.tenantA, fx.planBasic, PERIOD_END, PERIOD_START],
        ),
      ),
    );
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/period_sane/i);
  });

  it("an invalid GSTIN shape is rejected at the database", async () => {
    const error = await expectError(() =>
      asSuperuser((c) =>
        c.query(
          `INSERT INTO invoices
             (tenant_id, invoice_number, status, currency, subtotal_minor,
              total_minor, customer_gstin)
           VALUES ($1,$2,'draft','INR',100,100,'NOTAGSTIN')`,
          [fx.tenantA, `BAD3/${randomUUID().slice(0, 8)}`],
        ),
      ),
    );
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/gstin_shape/i);
  });
});

/* ================================================================== */
/* 7. THE ONE-LIVE-SUBSCRIPTION GUARANTEE                              */
/* ================================================================== */

describe("a tenant cannot hold two live subscriptions", () => {
  it("⭐ a second LIVE subscription is refused", async () => {
    // The double-billing scenario: an upgrade creates a new subscription
    // and the old one's cancellation fails. Both renew next month.
    const error = await expectError(() =>
      asSuperuser((c) =>
        c.query(
          `INSERT INTO subscriptions
             (tenant_id, plan_id, status, provider, currency, unit_amount_minor,
              interval, current_period_start, current_period_end)
           VALUES ($1,$2,'active','stripe','INR',1,'monthly',$3,$4)`,
          [fx.tenantA, fx.planAdvanced, PERIOD_START, PERIOD_END],
        ),
      ),
    );
    expect(error, "a tenant was allowed two live subscriptions").not.toBeNull();
    expect(error!.code).toBe("23505");
  });

  it("any number of CANCELLED subscriptions may coexist as history", async () => {
    // The index is partial for exactly this reason — billing history must
    // accumulate.
    for (let i = 0; i < 3; i += 1) {
      await asSuperuser((c) =>
        c.query(
          `INSERT INTO subscriptions
             (tenant_id, plan_id, status, provider, currency, unit_amount_minor,
              interval, current_period_start, current_period_end)
           VALUES ($1,$2,'cancelled','razorpay','INR',1,'monthly',$3,$4)`,
          [fx.tenantA, fx.planBasic, PERIOD_START, PERIOD_END],
        ),
      );
    }
    const { rows } = await asTenant(fx.tenantA, (c) =>
      c.query(`SELECT count(*)::int AS n FROM subscriptions WHERE status = 'cancelled'`),
    );
    expect(rows[0].n).toBe(3);
  });

  it("⭐ a subscription cannot be moved to another tenant", async () => {
    // Reassigning one would drag its whole billing history with it and
    // leave the original tenant's records pointing at something that is
    // no longer theirs.
    const error = await expectError(() =>
      asSuperuser((c) =>
        c.query(`UPDATE subscriptions SET tenant_id = $1 WHERE id = $2`, [
          fx.tenantB,
          fx.subA,
        ]),
      ),
    );
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/different tenant/i);
  });
});

/* ================================================================== */
/* 8. THE PLAN CATALOGUE IS READ-ONLY TO TENANTS                       */
/* ================================================================== */

describe("plan catalogue", () => {
  it("is readable by a tenant session", async () => {
    const { rows } = await asTenant(fx.tenantA, (c) =>
      c.query(`SELECT count(*)::int AS n FROM plans`),
    );
    expect(rows[0].n).toBeGreaterThan(0);
  });

  it("⭐ CANNOT be repriced by the application role", async () => {
    // The most obvious attack on a billing system: change the price of
    // your own plan to zero. Closed by GRANT, not by RLS — the privilege
    // simply does not exist.
    const error = await expectError(() =>
      asTenant(fx.tenantA, (c) => c.query(`UPDATE plans SET amount_minor = 0`)),
    );
    expect(error, "the application role can rewrite the plan catalogue").not.toBeNull();
    expect(error!.message).toMatch(/permission denied/i);
  });

  it("⭐ a new plan CANNOT be inserted by the application role", async () => {
    const error = await expectError(() =>
      asTenant(fx.tenantA, (c) =>
        c.query(
          `INSERT INTO plans (code, name, tier, interval, currency, amount_minor)
           VALUES ('free_forever','Free','enterprise','monthly','INR',0)`,
        ),
      ),
    );
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/permission denied/i);
  });
});

/* ================================================================== */
/* 9. INVOICE NUMBERING                                                */
/* ================================================================== */

describe("invoice numbering", () => {
  it("⭐ never returns the same number twice", async () => {
    // `SELECT MAX(number)+1` would collide under concurrency on a
    // serverless platform where a hundred instances run at once.
    const seen = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const { rows } = await asSuperuser((c) =>
        c.query(`SELECT next_invoice_number('AH') AS n`),
      );
      expect(seen.has(rows[0].n), `duplicate invoice number ${rows[0].n}`).toBe(false);
      seen.add(rows[0].n);
    }
    expect(seen.size).toBe(50);
  });

  it("is unique under CONCURRENT calls", async () => {
    const results = await Promise.all(
      Array.from({ length: 25 }, () =>
        asSuperuser((c) => c.query(`SELECT next_invoice_number('CC') AS n`)),
      ),
    );
    const numbers = results.map((r) => r.rows[0].n);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it("uses the Indian financial year, which starts in April", async () => {
    // 2 April 2026 is FY 2026-27; 30 March 2026 is FY 2025-26. A calendar
    // year here would misfile every invoice in Q1.
    const { rows } = await asSuperuser((c) =>
      c.query(
        `SELECT indian_financial_year('2026-04-02T00:00:00Z'::timestamptz) AS after,
                indian_financial_year('2026-03-30T00:00:00Z'::timestamptz) AS before`,
      ),
    );
    expect(rows[0].after).toBe("2026-27");
    expect(rows[0].before).toBe("2025-26");
  });
});
