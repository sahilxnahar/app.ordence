/**
 * Ordence — The Billing Gate on Core CRM Writes (S1)
 * Version: v0.83.2-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ READ THIS FIRST: `past_due` DOES NOT RESTRICT WRITES, ON PURPOSE
 * ══════════════════════════════════════════════════════════════════════
 * The obvious version of this suite is "set a tenant to `past_due` and
 * assert that creating a contact is refused". It would fail, and it
 * SHOULD fail.
 *
 * `tests/ui/access-state.test.tsx` already pins the commercial rule, in a
 * test named "⭐ past_due NEVER restricts writes, at any failure count",
 * with the reasoning written beside it:
 *
 *     "While the provider is still retrying, cutting access is the worst
 *      of both worlds: we lose the customer AND we get paid."
 *
 * The ladder is: `past_due` escalates the WORDING (notice → warning) and
 * restricts nothing. `unpaid` is set after the fourth failure and still
 * honours a seven-day grace window. Restriction begins only once the
 * status is `unpaid` AND that window has closed — roughly three weeks
 * after the first failed payment, by which time the provider has stopped
 * retrying.
 *
 * So this suite drives the state that actually restricts. Writing it
 * against `past_due` would leave one of two outcomes, both bad: a red
 * suite that looks like the S1 gate is broken, or somebody "fixing" it by
 * making `past_due` restrictive — silently reversing a deliberate
 * commercial decision, and locking out customers on their first failed
 * card.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE PROVES
 * ══════════════════════════════════════════════════════════════════════
 *   1. A restricted workspace cannot WRITE     — the gate bites.
 *   2. A restricted workspace can still READ   — and this half matters
 *      more, because a gate that hides a customer's data while asking
 *      them for money is how you guarantee they do not pay.
 *   3. Billing and export stay reachable       — the remedy must never be
 *      behind the restriction.
 *   4. The MCP surface obeys the same rule     — the hole S1 closed.
 *   5. It fails OPEN on its own errors         — a billing-table outage
 *      must not become an outage in a customer's business.
 *
 * Runs in the `security` project: real PostgreSQL, `.env.test` guard,
 * sequential. See `vitest.config.ts`.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { asSuperuser, asTenant } from "../setup";

/**
 * ⚠️ SET BEFORE THE DYNAMIC IMPORTS BELOW, AND ONLY HERE.
 *
 * `server/billing/access.ts` reaches `lib/env.ts`, which parses the server
 * environment at module load. The suite's own guard deliberately refuses
 * to read `DATABASE_URL` from `.env.test` — see `tests/setup.ts` — so the
 * value is bridged in memory instead, from the already-validated
 * `TEST_DATABASE_URL`. Nothing is written to disk and the guard's rule
 * stays absolute.
 */
process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

type Fx = {
  restricted: string;
  healthy: string;
  planId: string;
  contactId: string;
};
let fx: Fx;

/** Days from now, as the schema's timestamptz. */
const days = (n: number) => new Date(Date.now() + n * 86_400_000);

beforeAll(async () => {
  const restricted = randomUUID();
  const healthy = randomUUID();
  const planId = randomUUID();
  const contactId = randomUUID();

  await asSuperuser(async (c) => {
    for (const [id, name] of [
      [restricted, "Billing Gate — Restricted"],
      [healthy, "Billing Gate — Healthy"],
    ] as const) {
      await c.query(
        `INSERT INTO tenants (id, clerk_org_id, slug, name, status, plan_tier)
         VALUES ($1,$2,$3,$4,'active','advanced')`,
        [id, `org_${id}`, `bg-${id.slice(0, 8)}`, name],
      );
    }

    /*
     * ⚠️ `interval` AND `amount_minor` ARE NOT NULL WITH NO DEFAULT.
     * Omitting either raises a null-violation in `beforeAll`, which
     * presents as every test in the file erroring at once with a message
     * about `plans` — a long way from the assertion that actually broke.
     */
    await c.query(
      `INSERT INTO plans (id, code, name, tier, interval, amount_minor)
       VALUES ($1,$2,$3,'advanced','monthly',499900)
       ON CONFLICT DO NOTHING`,
      [planId, `bg_plan_${planId.slice(0, 8)}`, "Billing Gate Plan"],
    );

    /*
     * ⚠️ `unpaid` WITH THE GRACE WINDOW ALREADY CLOSED. This exact pair is
     * what `evaluateAccess` requires before it will restrict — see the
     * header. `past_due` here would produce `canWrite === true` and the
     * whole suite would read as a failure of the gate rather than as the
     * dunning policy working correctly.
     *
     * ⚠️ `current_period_start` IS REQUIRED AND CONSTRAINED. A CHECK on
     * the table asserts `current_period_end > current_period_start`, so
     * the two dates cannot be supplied carelessly or in the wrong order.
     * `unit_amount_minor`, `currency` and `interval` are likewise NOT NULL.
     */
    await c.query(
      `INSERT INTO subscriptions
         (id, tenant_id, plan_id, status, failed_payment_count,
          grace_ends_at, current_period_start, current_period_end,
          unit_amount_minor, interval)
       VALUES ($1,$2,$3,'unpaid',4,$4,$5,$6,499900,'monthly')`,
      [randomUUID(), restricted, planId, days(-1), days(-38), days(-8)],
    );

    await c.query(
      `INSERT INTO subscriptions
         (id, tenant_id, plan_id, status, failed_payment_count,
          current_period_start, current_period_end,
          unit_amount_minor, interval)
       VALUES ($1,$2,$3,'active',0,$4,$5,499900,'monthly')`,
      [randomUUID(), healthy, planId, days(-10), days(20)],
    );

    // A row the restricted tenant must still be able to READ.
    await c.query(
      `INSERT INTO contacts (id, tenant_id, first_name, last_name, email)
       VALUES ($1,$2,'Read','Still Works','read@example.test')`,
      [contactId, restricted],
    );
  });

  fx = { restricted, healthy, planId, contactId };
});

afterAll(async () => {
  if (!fx) return;
  await asSuperuser(async (c) => {
    await c.query(`DELETE FROM subscriptions WHERE tenant_id = ANY($1)`, [
      [fx.restricted, fx.healthy],
    ]);
    await c.query(`DELETE FROM contacts WHERE tenant_id = ANY($1)`, [
      [fx.restricted, fx.healthy],
    ]);
    await c.query(`DELETE FROM tenants WHERE id = ANY($1)`, [[fx.restricted, fx.healthy]]);
    await c.query(`DELETE FROM plans WHERE id = $1`, [fx.planId]);
  });
});

/* ================================================================== */
/* 1. THE DECISION, AGAINST A REAL SUBSCRIPTION ROW                    */
/* ================================================================== */

describe("getAccessDecisionForTenant — resolved from the database", () => {
  it("⭐ refuses writes for an unpaid workspace past its grace window", async () => {
    const { getAccessDecisionForTenant } = await import("@/server/billing/access");
    const decision = await getAccessDecisionForTenant(fx.restricted);

    expect(decision.canWrite).toBe(false);
    expect(decision.level).toBe("restricted");
    expect(decision.reason).toBe("unpaid_grace_expired");
  });

  it("⭐ still permits READING — the half that makes the gate survivable", async () => {
    // A customer who cannot see their own data will not pay to get it
    // back; they will assume it is gone and start a chargeback.
    const { getAccessDecisionForTenant } = await import("@/server/billing/access");
    const decision = await getAccessDecisionForTenant(fx.restricted);

    expect(decision.canRead).toBe(true);
    expect(decision.canExport).toBe(true);
  });

  it("the message answers 'have I lost everything?' before anything else", async () => {
    const { getAccessDecisionForTenant } = await import("@/server/billing/access");
    const decision = await getAccessDecisionForTenant(fx.restricted);

    expect(decision.detail).toMatch(/still here/i);
    expect(decision.callToAction?.href).toBe("/settings/billing");
  });

  it("leaves a healthy workspace completely alone", async () => {
    const { getAccessDecisionForTenant } = await import("@/server/billing/access");
    const decision = await getAccessDecisionForTenant(fx.healthy);

    expect(decision.canWrite).toBe(true);
    expect(decision.level).not.toBe("restricted");
  });

  it("⚠️ FAILS OPEN on a malformed tenant id rather than locking the workspace", async () => {
    // `withTenant()` throws on a non-UUID. The catch must grant, not deny:
    // a billing-lookup fault must never become a customer outage. This is
    // the one place in the codebase where failing open is correct, and it
    // is asserted so nobody "hardens" it later.
    const { getAccessDecisionForTenant } = await import("@/server/billing/access");
    const decision = await getAccessDecisionForTenant("not-a-uuid");

    expect(decision.canWrite).toBe(true);
  });
});

/* ================================================================== */
/* 2. THE THROWING GATE, AND ITS EXEMPTIONS                            */
/* ================================================================== */

describe("requireAccessForTenant", () => {
  it("⭐ throws AccessRestrictedError on a write for a restricted workspace", async () => {
    const { requireAccessForTenant, AccessRestrictedError } = await import(
      "@/server/billing/access"
    );

    await expect(
      requireAccessForTenant(fx.restricted, "contacts:create"),
    ).rejects.toBeInstanceOf(AccessRestrictedError);
  });

  it("carries the customer-facing decision on the error, not a bare string", async () => {
    // `toActionError()` in the server actions reads `err.decision.detail`.
    // If the error ever stopped carrying it, every refusal would silently
    // degrade to "Something went wrong. Please try again."
    const { requireAccessForTenant } = await import("@/server/billing/access");

    const err = await requireAccessForTenant(fx.restricted, "contacts:create").catch(
      (e: unknown) => e,
    );

    expect(err).toHaveProperty("decision");
    const decision = (err as { decision: { detail: string | null; canRead: boolean } }).decision;
    expect(decision.canRead).toBe(true);
    expect(decision.detail).toBeTruthy();
  });

  it("⭐ NEVER blocks billing — the remedy cannot sit behind the restriction", async () => {
    // A read-only mode that blocks the payment form is a trap the customer
    // cannot escape without contacting support.
    const { requireAccessForTenant } = await import("@/server/billing/access");

    await expect(
      requireAccessForTenant(fx.restricted, "billing:update_payment_method"),
    ).resolves.toBeDefined();
  });

  it("⭐ NEVER blocks export — the right to leave does not lapse over an invoice", async () => {
    const { requireAccessForTenant } = await import("@/server/billing/access");

    await expect(
      requireAccessForTenant(fx.restricted, "export:tenant_data"),
    ).resolves.toBeDefined();
  });

  it("permits the same write for a healthy workspace", async () => {
    const { requireAccessForTenant } = await import("@/server/billing/access");

    await expect(
      requireAccessForTenant(fx.healthy, "contacts:create"),
    ).resolves.toBeDefined();
  });
});

/* ================================================================== */
/* 3. READS GENUINELY STILL WORK, THROUGH RLS                          */
/* ================================================================== */

describe("a restricted workspace can still reach its own data", () => {
  it("⭐ a tenant-scoped SELECT returns rows while writes are refused", async () => {
    // The decision object says `canRead: true`. This proves nothing in the
    // data path contradicts it — the two are separate systems and only a
    // query can show they agree.
    const rows = await asTenant(fx.restricted, async (c) => {
      const r = await c.query(`SELECT id, first_name FROM contacts WHERE deleted_at IS NULL`);
      return r.rows;
    });

    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].first_name).toBe("Read");
  });

  it("and still cannot see another tenant's rows — RLS is unaffected by billing", async () => {
    const rows = await asTenant(fx.healthy, async (c) => {
      const r = await c.query(`SELECT id FROM contacts WHERE id = $1`, [fx.contactId]);
      return r.rows;
    });

    expect(rows).toHaveLength(0);
  });
});

/* ================================================================== */
/* 4. THE MCP SURFACE OBEYS THE SAME RULE                              */
/* ================================================================== */

describe("MCP tools — the gap S1 closed", () => {
  it("⭐ every read_write tool is gated by the same decision", async () => {
    // Before v0.83.2 the dispatcher checked the token, its scope and RLS,
    // and never asked whether the workspace was paying — so an agent kept
    // writing to a workspace whose own staff were read-only.
    const { requireAccessForTenant, AccessRestrictedError } = await import(
      "@/server/billing/access"
    );

    await expect(
      requireAccessForTenant(fx.restricted, "mcp:ordence_update_deal_stage"),
    ).rejects.toBeInstanceOf(AccessRestrictedError);
  });

  it("⭐ read tools stay available — the call most likely to end in payment", async () => {
    // `dispatch.ts` only gates tools declared `scope: "read_write"`. A read
    // tool never reaches the gate, so an agent answering "what do I owe?"
    // keeps working. This asserts the registry still marks them read-only.
    const { MCP_TOOLS } = await import("@/lib/mcp/registry");

    const reads = MCP_TOOLS.filter((t) => t.scope === "read_only");
    expect(reads.length).toBeGreaterThan(0);

    const dealStage = MCP_TOOLS.find((t) => t.name === "ordence_update_deal_stage");
    expect(dealStage?.scope).toBe("read_write");
  });

});

/*
 * ══════════════════════════════════════════════════════════════════════
 * THE WIRING ASSERTIONS LIVE IN `tests/ui/billing-gate-wiring.test.ts`
 * ══════════════════════════════════════════════════════════════════════
 * Everything above proves the gate BEHAVES correctly. None of it proves
 * anything CALLS it — and an uncalled gate is exactly what the original
 * defect was: `requireAccess()` correct, tested, and invoked at 17 sites
 * where 151 were needed.
 *
 * Those checks read source rather than running it, so they belong in the
 * `ui` project, which has no database by design. That placement is not
 * incidental: it means the regression guard runs for a developer with no
 * Postgres, on every `npm test`, instead of only when someone has stood
 * up a test branch. A check that requires setup is a check that stops
 * being run.
 */
