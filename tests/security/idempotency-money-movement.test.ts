/**
 * Ordence — 🔴🔴🔴 FIVE MONEY-MOVING ACTIONS, SUBMITTED TWICE
 * Version: v1.83.0-alpha · Track D, wave 17
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS
 * ══════════════════════════════════════════════════════════════════════
 * Track D's wave 15 report listed five money-moving actions with no
 * idempotency, and labelled the finding as SOURCE READING rather than
 * execution. Integration's reply: *"It is the largest business risk anyone
 * found in this wave and it is the only major finding still unproven."*
 *
 * This is the execution. For each of the five, the REAL server action is
 * called TWICE against a REAL PostgreSQL, and the resulting rows are
 * counted.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT IS MOCKED, AND WHY THE LIST IS SHORT ON PURPOSE
 * ══════════════════════════════════════════════════════════════════════
 * Only the IDENTITY AND AUTHORISATION surface: `requireTenantContext`,
 * `requireRole`, `requirePermission`, `requireAccess`, `requireFeature`,
 * `guardSalesWrite`, `writeAudit`, and `next/cache`. Those need a Clerk
 * session, which a test process does not have, and NONE of them is under
 * test — an action that is correctly gated and still writes two rows is
 * exactly the defect.
 *
 * ⭐ `@/db` IS NOT MOCKED. Every `withTenant()`, every INSERT, every
 * trigger, every unique index and every RLS policy is the real one, on the
 * real schema, as the real `ordence_app` role (NOSUPERUSER NOBYPASSRLS).
 * The transaction boundaries under test are the ones the product ships.
 *
 * ⚠️ A NOTE ON WHAT "TWICE" MEANS, because it differs per action:
 *
 *   SEQUENTIAL — `await first; await second`. This is the operator who
 *     clicks, waits, sees nothing happen, and clicks again. It defeats an
 *     action with no guard at all.
 *   CONCURRENT — `Promise.all([first, second])`, neither awaited before
 *     the other starts. This is two browser tabs, or a retried POST. It
 *     defeats an action whose guard READS in one transaction and WRITES in
 *     another, because both reads see the pre-write state.
 *
 * An action can be safe against one and not the other, and saying which is
 * the difference between a finding somebody can act on and a rumour.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { asSuperuser } from "../setup";

process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

/* ================================================================== */
/* THE FIXTURE IDS — hoisted, because the mocks below close over them  */
/* ================================================================== */

const h = vi.hoisted(() => ({
  /** Filled in `beforeAll` from real database rows. See the note there. */
  ctx: null as unknown as {
    tenant: Record<string, unknown>;
    user: Record<string, unknown>;
    clerkUserId: string;
    clerkOrgId: string;
    role: string;
    requestId: string;
    impersonationId: null;
    impersonationScope: null;
    operatorEmail: null;
  },
}));

/* ================================================================== */
/* MOCKS — identity and authorisation only                             */
/* ================================================================== */

vi.mock("next/cache", () => ({
  revalidatePath: () => undefined,
  revalidateTag: () => undefined,
  unstable_cache: (fn: unknown) => fn,
}));

vi.mock("@/server/tenant-context", async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    requireTenantContext: async () => h.ctx,
    requireRole: async () => h.ctx,
    getTenantContext: async () => h.ctx,
  };
});

vi.mock("@/server/audit", async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    requirePermission: async () => h.ctx,
    requireAllPermissions: async () => h.ctx,
    checkPermission: async () => ({ allowed: true, ctx: h.ctx }),
    /*
     * ⚠️ `writeAudit` IS STUBBED, AND THAT IS NOT A CONVENIENCE. It resolves
     * its own tenant context and appends to a hash chain; running it here
     * would test the audit chain, which has its own suite. What matters for
     * THIS file is how many rows the money tables gain, and the audit trail
     * cannot change that number.
     */
    writeAudit: async () => undefined,
  };
});

vi.mock("@/server/billing/access", async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    requireAccess: async () => ({
      level: "full",
      canWrite: true,
      canRead: true,
      canExport: true,
      headline: null,
      detail: null,
      callToAction: null,
      reason: "healthy",
      daysRemaining: null,
      standing: "resolved",
    }),
  };
});

vi.mock("@/server/entitlements", async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    requireFeature: async () => ({ allowed: true, feature: "test", reason: "included" }),
    checkFeature: async () => ({ allowed: true, feature: "test", reason: "included" }),
  };
});

vi.mock("@/server/sales/guards", async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    guardSalesWrite: async () => h.ctx,
  };
});

vi.mock("@/server/receivables/guards", async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    guardReceivablesWrite: async () => h.ctx,
  };
});

/* ================================================================== */
/* FIXTURES                                                            */
/* ================================================================== */

type Fx = {
  tenant: string;
  user: string;
  ledgerCash: string;
  ledgerRevenue: string;
  company: string;
  project: string;
  unitA: string;
  unitB: string;
  leadA: string;
  leadB: string;
  bookingA: string;
  bookingB: string;
  milestone: string;
};
let fx: Fx;

const RUN = randomUUID().slice(0, 8);

beforeAll(async () => {
  const tenant = randomUUID();

  const ids = await asSuperuser(async (c) => {
    await c.query(
      `INSERT INTO tenants (id, clerk_org_id, slug, name, status, plan_tier)
       VALUES ($1,$2,$3,$4,'active','enterprise')`,
      [tenant, `org_idem_${RUN}`, `idem-${RUN}`, "Idempotency Proof"],
    );

    const u = await c.query(
      `INSERT INTO users (tenant_id, clerk_user_id, email, role, status)
       VALUES ($1,$2,$3,'tenant_owner','active') RETURNING id`,
      [tenant, `user_idem_${RUN}`, `idem-${RUN}@example.test`],
    );

    const mkLedger = async (name: string, code: string, acct: string) => {
      const r = await c.query(
        `INSERT INTO ledgers (tenant_id, name, code, type, account_type)
         VALUES ($1,$2,$3,'operating',$4) RETURNING id`,
        [tenant, name, code, acct],
      );
      return r.rows[0].id as string;
    };

    const ledgerCash = await mkLedger("Bank — Operating", `IDEM-CASH-${RUN}`, "asset");
    const ledgerRevenue = await mkLedger("Revenue — Sales", `IDEM-REV-${RUN}`, "revenue");

    const company = randomUUID();
    await c.query(
      `INSERT INTO companies (id, tenant_id, name) VALUES ($1,$2,$3)`,
      [company, tenant, `Idempotency Client ${RUN}`],
    );

    /* --- the sales chain: project → unit → lead → booking → milestone --- */
    const project = randomUUID();
    await c.query(
      `INSERT INTO projects (id, tenant_id, code, name) VALUES ($1,$2,$3,$4)`,
      [project, tenant, `IDEM-${RUN}`, "Idempotency Tower"],
    );

    const mkUnit = async (code: string) => {
      const id = randomUUID();
      await c.query(
        `INSERT INTO units (id, tenant_id, project_id, code) VALUES ($1,$2,$3,$4)`,
        [id, tenant, project, code],
      );
      return id;
    };
    const unitA = await mkUnit(`U-A-${RUN}`);
    const unitB = await mkUnit(`U-B-${RUN}`);

    const mkLead = async (n: number) => {
      const id = randomUUID();
      await c.query(
        `INSERT INTO leads (id, tenant_id, reference, name, phone, status)
         VALUES ($1,$2,$3,$4,$5,'qualified')`,
        [id, tenant, `IDEM-L${n}-${RUN}`, `Buyer ${n}`, `+9199${String(n).padStart(8, "0")}`],
      );
      return id;
    };
    const leadA = await mkLead(1);
    const leadB = await mkLead(2);

    const mkBooking = async (ref: string, leadId: string, unitId: string) => {
      const id = randomUUID();
      await c.query(
        `INSERT INTO bookings
           (id, tenant_id, reference, lead_id, unit_id, sales_rep_id,
            status, agreement_value_minor)
         VALUES ($1,$2,$3,$4,$5,$6,'confirmed',500000000)`,
        [id, tenant, ref, leadId, unitId, u.rows[0].id],
      );
      return id;
    };
    const bookingA = await mkBooking(`IDEM-BKA-${RUN}`, leadA, unitA);
    const bookingB = await mkBooking(`IDEM-BKB-${RUN}`, leadB, unitB);

    const milestone = randomUUID();
    await c.query(
      `INSERT INTO payment_milestones
         (id, tenant_id, booking_id, label, amount_minor, sequence, due_date)
       VALUES ($1,$2,$3,'Slab 1',80000000,1,CURRENT_DATE + 30)`,
      [milestone, tenant, bookingB],
    );

    return {
      user: u.rows[0].id as string,
      ledgerCash, ledgerRevenue, company,
      project, unitA, unitB, leadA, leadB, bookingA, bookingB, milestone,
    };
  });

  /*
   * ⭐ THE CONTEXT IS BUILT FROM THE REAL ROWS, NOT HAND-WRITTEN.
   *
   * ⚠️ `TenantContext.tenant` and `.user` are whole database rows. A
   * hand-built literal would drift from the schema the first time a column
   * is added, and the drift would present as an action failing for a reason
   * that has nothing to do with what is under test. Reading them back means
   * the context is exactly what `requireTenantContext()` would have built.
   */
  const rows = await asSuperuser(async (c) => {
    const t = await c.query(`SELECT * FROM tenants WHERE id = $1`, [tenant]);
    const u = await c.query(`SELECT * FROM users WHERE id = $1`, [ids.user]);
    return { tenant: t.rows[0], user: u.rows[0] };
  });

  h.ctx = {
    tenant: camelise(rows.tenant),
    user: camelise(rows.user),
    clerkUserId: `user_idem_${RUN}`,
    clerkOrgId: `org_idem_${RUN}`,
    role: "tenant_owner",
    requestId: `req_idem_${RUN}`,
    impersonationId: null,
    impersonationScope: null,
    operatorEmail: null,
  };

  fx = { tenant, ...ids } as Fx;
});

afterAll(async () => {
  if (!fx) return;
  /*
   * ⚠️ THE TENANT ROW IS LEFT BEHIND. Anything that has generated a
   * `security_events` row cannot be deleted — the `ON DELETE SET NULL`
   * cascade issues an UPDATE and the append-only trigger refuses it, for
   * every role including the superuser. Wave 15 §4.2.
   */
});

/** snake_case row → camelCase object, which is what Drizzle hands callers. */
function camelise(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] = v;
  }
  return out;
}

async function count(sql: string, params: unknown[]): Promise<number> {
  const r = await asSuperuser((c) => c.query(sql, params));
  return r.rowCount ?? 0;
}

/* ================================================================== */
/* 1. postTransaction — no guard at all                                */
/* ================================================================== */

describe("🔴 postTransaction — a manual journal has no key and no guard", () => {
  it("positive control: ONE submit writes ONE transaction and two legs", async () => {
    const { postTransaction } = await import("@/server/actions/accounting");
    const description = `Control accrual ${randomUUID()}`;

    const result = await postTransaction({
      description,
      transactionDate: "2026-08-01",
      currency: "INR",
      referenceType: "journal",
      legs: [
        { ledgerId: fx.ledgerCash, entryType: "debit", amount: "500000.00" },
        { ledgerId: fx.ledgerRevenue, entryType: "credit", amount: "500000.00" },
      ],
    } as never);

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(
      await count(`SELECT 1 FROM transactions WHERE tenant_id=$1 AND description=$2`, [
        fx.tenant,
        description,
      ]),
    ).toBe(1);
  });

  it("🔴 TWO SEQUENTIAL SUBMITS WRITE TWO POSTED JOURNALS", async () => {
    /*
     * 🔴 THE FAILURE SCENARIO, EXECUTED. A finance user posts a ₹5,00,000
     * accrual, the response is slow, they click Post again.
     *
     * There is no status guard (nothing to guard — a journal has no prior
     * state), no idempotency key, and the only unique index on
     * `transactions` is `transactions_tenant_number_unique … WHERE
     * transaction_number IS NOT NULL`. The UI supplies no number, so the
     * index cannot see either row.
     *
     * Each journal balances, so the deferred balance trigger passes on both.
     * The expense is overstated by ₹5,00,000 and nothing anywhere flags it —
     * there is no second document to reconcile against.
     */
    const { postTransaction } = await import("@/server/actions/accounting");
    const description = `Double-submitted accrual ${randomUUID()}`;

    const payload = {
      description,
      transactionDate: "2026-08-01",
      currency: "INR",
      referenceType: "journal",
      legs: [
        { ledgerId: fx.ledgerCash, entryType: "debit", amount: "500000.00" },
        { ledgerId: fx.ledgerRevenue, entryType: "credit", amount: "500000.00" },
      ],
    };

    const first = await postTransaction(payload as never);
    const second = await postTransaction(payload as never);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    const transactions = await count(
      `SELECT 1 FROM transactions WHERE tenant_id=$1 AND description=$2 AND status='posted'`,
      [fx.tenant, description],
    );
    const legs = await count(
      `SELECT 1 FROM journal_entries je
         JOIN transactions t ON t.id = je.transaction_id
        WHERE t.tenant_id=$1 AND t.description=$2`,
      [fx.tenant, description],
    );

    expect(transactions).toBe(2);
    expect(legs).toBe(4);

    /* And the ledger really is double-counted, not merely double-rowed. */
    const total = await asSuperuser((c) =>
      c.query(
        `SELECT COALESCE(SUM(je.amount_minor),0)::text AS debits
           FROM journal_entries je JOIN transactions t ON t.id = je.transaction_id
          WHERE t.tenant_id=$1 AND t.description=$2 AND je.entry_type='debit'`,
        [fx.tenant, description],
      ),
    );
    expect((total.rows[0] as { debits: string }).debits).toBe("100000000");
  });

  it("⭐ AND THE DISPROOF: supplying a transaction number DOES stop the second", async () => {
    /*
     * ⚠️ THE CONTROL THAT MAKES THE FINDING ACTIONABLE. The mechanism that
     * would fix this already exists and already works — the partial unique
     * index bites the moment a number is present. So the gap is not "the
     * database cannot express this"; it is that the call site supplies no
     * number. That is a one-field change, and this assertion is what proves
     * it would be sufficient.
     */
    const { postTransaction } = await import("@/server/actions/accounting");
    const description = `Numbered accrual ${randomUUID()}`;
    const transactionNumber = `IDEM-${randomUUID().slice(0, 12)}`;

    const payload = {
      description,
      transactionNumber,
      transactionDate: "2026-08-01",
      currency: "INR",
      referenceType: "journal",
      legs: [
        { ledgerId: fx.ledgerCash, entryType: "debit", amount: "1000.00" },
        { ledgerId: fx.ledgerRevenue, entryType: "credit", amount: "1000.00" },
      ],
    };

    const first = await postTransaction(payload as never);
    const second = await postTransaction(payload as never);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(
      await count(`SELECT 1 FROM transactions WHERE tenant_id=$1 AND transaction_number=$2`, [
        fx.tenant,
        transactionNumber,
      ]),
    ).toBe(1);
  });
});

/* ================================================================== */
/* 2. reverseTransaction — the guard reads in a different transaction  */
/* ================================================================== */

describe("🔴 reverseTransaction — safe against a click, not against two tabs", () => {
  /** Post a balanced journal and return its id. */
  async function postOne(description: string): Promise<string> {
    const { postTransaction } = await import("@/server/actions/accounting");
    const result = await postTransaction({
      description,
      transactionDate: "2026-08-01",
      currency: "INR",
      referenceType: "journal",
      legs: [
        { ledgerId: fx.ledgerCash, entryType: "debit", amount: "200000.00" },
        { ledgerId: fx.ledgerRevenue, entryType: "credit", amount: "200000.00" },
      ],
    } as never);
    if (!result.ok) throw new Error(`fixture post failed: ${JSON.stringify(result)}`);
    return (result.data as { transaction: { id: string } }).transaction.id;
  }

  async function reversalsOf(originalId: string): Promise<number> {
    return count(`SELECT 1 FROM transactions WHERE reverses_transaction_id = $1`, [
      originalId,
    ]);
  }

  it("⭐ SEQUENTIAL is SAFE — the second call is refused by the status guard", async () => {
    /*
     * ⚠️ THE WAVE 15 REPORT SAID "two tabs open on the same posted journal;
     * both press Reverse". It did NOT say a plain double-click reproduces
     * this, and executing it confirms why that distinction mattered: by the
     * time a second SEQUENTIAL call reads the row, the first has already
     * committed `status = 'reversed'`, and the guard at
     * `server/actions/accounting.ts:392` refuses.
     *
     * Reporting this as "double submit produces two reversals" without the
     * qualifier would have been wrong in the direction that wastes a
     * reviewer's afternoon.
     */
    const original = await postOne(`Sequential reverse ${randomUUID()}`);
    const { reverseTransaction } = await import("@/server/actions/accounting");

    const first = await reverseTransaction({
      transactionId: original,
      reason: "First reversal, deliberate.",
    } as never);
    const second = await reverseTransaction({
      transactionId: original,
      reason: "Second reversal, the accidental one.",
    } as never);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(await reversalsOf(original)).toBe(1);
  });

  it("🔴 CONCURRENT PRODUCES TWO MIRROR JOURNALS — the ledger over-corrected", async () => {
    /*
     * 🔴 THE FAILURE SCENARIO, EXECUTED. Two tabs open on the same posted
     * ₹2,00,000 journal; both press Reverse within the same second.
     *
     * The guard reads the original inside ONE `withTenant()` and the write
     * happens inside a SECOND, separate `withTenant()`. Neither read sees
     * the other's uncommitted write — READ COMMITTED, no `FOR UPDATE`, no
     * advisory lock, and the reversal is inserted with `transaction_number`
     * unset so the partial unique index cannot see it either.
     *
     * Net effect on the ledger: −₹2,00,000 too much. And
     * `reverses_transaction_id` on BOTH rows points at the same original, so
     * the "one reversal per transaction" invariant every reader assumes is
     * silently false.
     */
    const original = await postOne(`Concurrent reverse ${randomUUID()}`);
    const { reverseTransaction } = await import("@/server/actions/accounting");

    const [a, b] = await Promise.all([
      reverseTransaction({
        transactionId: original,
        reason: "Tab one pressed Reverse.",
      } as never),
      reverseTransaction({
        transactionId: original,
        reason: "Tab two pressed Reverse.",
      } as never),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(await reversalsOf(original)).toBe(2);

    /* Both mirrors are real, posted, balanced legs — not empty shells. */
    const legs = await count(
      `SELECT 1 FROM journal_entries je
         JOIN transactions t ON t.id = je.transaction_id
        WHERE t.reverses_transaction_id = $1`,
      [original],
    );
    expect(legs).toBe(4);
  });
});

/* ================================================================== */
/* 3. recordClientAccountEntry — client money, plain insert            */
/* ================================================================== */

describe("🔴 recordClientAccountEntry — the firm takes its fee twice", () => {
  async function balance(): Promise<bigint> {
    const r = await asSuperuser((c) =>
      c.query(
        `SELECT COALESCE(SUM(amount_minor),0)::text AS b
           FROM client_account_entries WHERE tenant_id=$1 AND company_id=$2`,
        [fx.tenant, fx.company],
      ),
    );
    return BigInt((r.rows[0] as { b: string }).b);
  }

  it("positive control: a receipt of client money records once", async () => {
    const { recordClientAccountEntry } = await import("@/server/actions/client-account");
    const reference = `CTL-${randomUUID().slice(0, 8)}`;

    const result = await recordClientAccountEntry({
      companyId: fx.company,
      entryDate: "2026-08-01",
      entryKind: "receipt",
      description: "Client money received on account",
      referenceNo: reference,
      amountMinor: "50000000",
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(
      await count(
        `SELECT 1 FROM client_account_entries WHERE tenant_id=$1 AND reference_no=$2`,
        [fx.tenant, reference],
      ),
    ).toBe(1);
  });

  it("🔴 A RETRIED POST TAKES ₹1,50,000 OUT OF CLIENT MONEY TWICE", async () => {
    /*
     * 🔴 THE FAILURE SCENARIO, EXECUTED. A solicitor records a
     * `transfer_to_office` of ₹1,50,000 against an issued bill; the browser
     * retries the POST.
     *
     * `client_account_entries` carries only a primary key — no unique
     * constraint, no idempotency column — and the only trigger on it
     * (`trg_guard_client_account`) is a BEFORE INSERT sanity check, not a
     * dedupe. Two entries land, each `amountMinor = -150000_00`.
     *
     * ⚠️ THE FIRM HAS NOW TAKEN ₹3,00,000 OUT OF MONEY IT HOLDS FOR A CLIENT
     * AGAINST A ₹1,50,000 BILL. The action's own return value reports the
     * resulting balance as fact, and this is the one balance a regulator
     * inspects. It is flagged `severity: "critical"` in its own audit entry
     * and is unguarded.
     */
    const { recordClientAccountEntry } = await import("@/server/actions/client-account");

    /* An ISSUED invoice, because a transfer must name the bill it settles. */
    const invoice = randomUUID();
    await asSuperuser((c) =>
      c.query(
        `INSERT INTO sales_invoices
           (id, tenant_id, invoice_number, financial_year, company_id,
            invoice_date, status, issued_at)
         VALUES ($1,$2,$3,'2026-27',$4,CURRENT_DATE,'issued', now())`,
        [invoice, fx.tenant, `IDEM-INV-${randomUUID().slice(0, 8)}`, fx.company],
      ),
    );

    const reference = `FEE-${randomUUID().slice(0, 8)}`;
    const before = await balance();

    const payload = {
      companyId: fx.company,
      entryDate: "2026-08-01",
      entryKind: "transfer_to_office" as const,
      description: "Fees transferred against issued bill",
      referenceNo: reference,
      amountMinor: "15000000",
      invoiceId: invoice,
    };

    const first = await recordClientAccountEntry(payload);
    const second = await recordClientAccountEntry(payload);

    expect(first.ok, JSON.stringify(first)).toBe(true);
    expect(second.ok, JSON.stringify(second)).toBe(true);

    expect(
      await count(
        `SELECT 1 FROM client_account_entries WHERE tenant_id=$1 AND reference_no=$2`,
        [fx.tenant, reference],
      ),
    ).toBe(2);

    /* ₹3,00,000 out, not ₹1,50,000. Stated as an arithmetic fact. */
    expect(await balance()).toBe(before - 30000000n);
  });
});

/* ================================================================== */
/* 4. recordMilestonePayment — read-modify-write on a money column     */
/* ================================================================== */

describe("🔴 recordMilestonePayment — no guard, and a lost update", () => {
  async function paid(): Promise<bigint> {
    const r = await asSuperuser((c) =>
      c.query(`SELECT amount_paid_minor::text AS p FROM payment_milestones WHERE id=$1`, [
        fx.milestone,
      ]),
    );
    return BigInt((r.rows[0] as { p: string }).p);
  }

  async function reset(): Promise<void> {
    await asSuperuser((c) =>
      c.query(
        `UPDATE payment_milestones
            SET amount_paid_minor = 0, status = 'pending', paid_at = NULL
          WHERE id = $1`,
        [fx.milestone],
      ),
    );
  }

  it("positive control: ONE receipt credits the milestone once", async () => {
    await reset();
    const { recordMilestonePayment } = await import("@/server/actions/sales-bookings");

    const result = await recordMilestonePayment({
      milestoneId: fx.milestone,
      amount: "800000.00",
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(await paid()).toBe(80000000n);
  });

  it("🔴 A DOUBLE-CLICK CREDITS ₹16,00,000 AGAINST AN ₹8,00,000 MILESTONE", async () => {
    /*
     * 🔴 THE FAILURE SCENARIO, EXECUTED. A slab receipt of ₹8,00,000 is
     * recorded twice.
     *
     * `server/actions/sales-bookings.ts:1525` is
     * `const nextPaid = milestone.amountPaidMinor + amountMinor;` — a plain
     * read-modify-write, with no status guard, no key, and no
     * `sql\`amount_paid_minor + …\`` to push the arithmetic into the
     * database. `payment_milestones` carries only a primary key and the
     * `(id, tenant_id)` pair.
     *
     * ⚠️ AND OVER-PAYMENT IS ALLOWED BY DESIGN (line 1527: "Buyers round up,
     * pay two milestones with one cheque, and add interest"), which is a
     * defensible rule that here removes the last thing that might have
     * noticed. The booking's headline `paymentStatus` flips to `paid` on
     * half the money.
     */
    await reset();
    const { recordMilestonePayment } = await import("@/server/actions/sales-bookings");

    const payload = { milestoneId: fx.milestone, amount: "800000.00" };
    const first = await recordMilestonePayment(payload);
    const second = await recordMilestonePayment(payload);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(await paid()).toBe(160000000n);
  });

  it("🔴 AND TWO CONCURRENT CASHIERS LOSE ONE PAYMENT ENTIRELY", async () => {
    /*
     * 🔴 THE WORSE HALF, AND THE ONE NOBODY GETS AN ERROR FOR. Two cashiers
     * record different amounts against the same milestone in the same
     * second. Both read `amount_paid_minor = 0`; one writes ₹5,00,000, the
     * other writes ₹3,00,000; the second write wins outright.
     *
     * ⚠️ THE EXPECTED TOTAL IS ₹8,00,000 AND THE RECORDED TOTAL IS ONE OF
     * THE TWO AMOUNTS. Money that was collected, receipted at the counter
     * and banked is absent from the record, and NOTHING ERRORS — both calls
     * return `ok: true`. A duplicate is at least visible; this is not.
     *
     * ⚠️ THE ASSERTION IS DELIBERATELY "one of the two", NOT A FIXED VALUE.
     * Which write lands last is a race, and pinning it would make this test
     * flaky for a reason that has nothing to do with the defect. What is
     * asserted is the property that matters: the total is NOT the sum.
     */
    await reset();
    const { recordMilestonePayment } = await import("@/server/actions/sales-bookings");

    const [a, b] = await Promise.all([
      recordMilestonePayment({ milestoneId: fx.milestone, amount: "500000.00" }),
      recordMilestonePayment({ milestoneId: fx.milestone, amount: "300000.00" }),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);

    const total = await paid();
    expect(total).not.toBe(80000000n); // the sum, which is what was collected
    expect([50000000n, 30000000n]).toContain(total);
  });
});

/* ================================================================== */
/* 5. recordPayment — the retry loop renumbers rather than dedupes     */
/* ================================================================== */

describe("🔴 recordPayment — two receipts for one payment", () => {
  it("positive control: ONE call writes ONE receipt", async () => {
    const { recordPayment } = await import("@/server/actions/receivables");

    const result = await recordPayment({
      bookingId: fx.bookingA,
      receivedOn: "2026-08-01",
      amountMinor: "1000000",
      method: "neft",
      bankRef: `CTL-${randomUUID().slice(0, 8)}`,
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
  });

  it("🔴 THE SAME PAYMENT RECORDED TWICE PRODUCES TWO RECEIPTS", async () => {
    /*
     * 🔴 THE FAILURE SCENARIO, EXECUTED. A buyer pays ₹10,00,000 against a
     * booking; the operator double-clicks Record.
     *
     * `receipts_number_tenant_unique` exists, and it does NOT help — because
     * `server/receivables/receipts.ts:106` regenerates the number on every
     * attempt and the loop at `:190` treats a 23505 on that index as a
     * signal to RENUMBER AND RE-INSERT:
     *
     *     } catch (err) {
     *       if (!isNumberCollision(err)) throw err;   // → attempt + 1
     *
     * That is a numbering guarantee, not an idempotency guarantee. The index
     * makes two concurrent receipts get DIFFERENT NUMBERS; it was never
     * going to make one of them not exist.
     *
     * ⚠️ THE BANK REFERENCE IS IDENTICAL ON BOTH ROWS — the one field that
     * genuinely identifies a payment, carried by the caller, stored, and
     * indexed by nothing.
     */
    const { recordPayment } = await import("@/server/actions/receivables");
    const bankRef = `UTR-${randomUUID().slice(0, 12)}`;

    const payload = {
      bookingId: fx.bookingA,
      receivedOn: "2026-08-01",
      amountMinor: "1000000",
      method: "neft" as const,
      bankRef,
    };

    const first = await recordPayment(payload);
    const second = await recordPayment(payload);

    expect(first.ok, JSON.stringify(first)).toBe(true);
    expect(second.ok, JSON.stringify(second)).toBe(true);

    expect(
      await count(`SELECT 1 FROM receipts WHERE tenant_id=$1 AND bank_ref=$2`, [
        fx.tenant,
        bankRef,
      ]),
    ).toBe(2);

    /* Two DIFFERENT receipt numbers — the index doing exactly its job. */
    const numbers = await asSuperuser((c) =>
      c.query(
        `SELECT DISTINCT receipt_number FROM receipts WHERE tenant_id=$1 AND bank_ref=$2`,
        [fx.tenant, bankRef],
      ),
    );
    expect(numbers.rowCount).toBe(2);

    /* And the booking has been credited twice for one bank transfer. */
    const credited = await asSuperuser((c) =>
      c.query(
        `SELECT COALESCE(SUM(amount_minor),0)::text AS s
           FROM receipts WHERE tenant_id=$1 AND bank_ref=$2`,
        [fx.tenant, bankRef],
      ),
    );
    expect((credited.rows[0] as { s: string }).s).toBe("2000000");
  });
});
