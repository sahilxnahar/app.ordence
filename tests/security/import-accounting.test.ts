/**
 * Ordence — 🔴🔴🔴 PHASE 8 PROVEN AGAINST A REAL DATABASE
 * Version: v1.85.0-alpha · Phase 8
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS FILE IS IN `tests/security/` AND NOT IN `tests/ui/`
 * ══════════════════════════════════════════════════════════════════════
 * Every claim the phase brief demands proof of is a claim about what the
 * DATABASE contains after something ran:
 *
 *   · "a re-run of the whole file creates nothing the second time"
 *   · "preview counts equal commit counts, including when a lookup misses"
 *   · "undo restores the prior state exactly, including for a record that
 *      existed before the import and carried a field the import never
 *      touched"
 *   · "a row missing a structural field is refused in the PREVIEW"
 *
 * ⚠️ NONE OF THOSE CAN BE PROVEN BY READING SOURCE. `tests/ui/` runs in
 * JSDOM with no database and its import suites are source-level: they
 * assert that a file CONTAINS a line. That is the right test for "the
 * mapping the person settled is the mapping that runs" and it is the
 * wrong one for "the second run created nothing", because a source file
 * containing `findExisting` proves only that somebody typed it.
 *
 * 🔴 SO THIS RUNS THE REAL SERVER ACTIONS — `previewImport` and
 *    `commitImport`, imported from `server/actions/import.ts`, unchanged
 *    — against the throwaway Postgres `scripts/bootstrap-test-db.mjs`
 *    stands up, connected as `ordence_app`, which is NOSUPERUSER and
 *    NOBYPASSRLS. What is mocked is identity and authorisation ONLY, in
 *    exactly the shape `tests/security/idempotency-money-movement.test.ts`
 *    established: who is asking, and whether they are allowed. Nothing
 *    about planning, matching, coercion, validation or writing is stubbed.
 *
 * ⚠️ AND THE NEGATIVE CONTROLS ARE THE POINT. Each block says what the
 * numbers would have been if the property did NOT hold — 6 accounts
 * instead of 3, a preview promising 3 and a commit writing 2 — because a
 * test that only asserts the good number passes just as happily against
 * an import that never ran at all.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { asSuperuser } from "../setup";

process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

/* ================================================================== */
/* THE FIXTURE — hoisted, because the mocks below close over it        */
/* ================================================================== */

const h = vi.hoisted(() => ({
  ctx: null as unknown as Record<string, unknown>,
}));

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
     * ⚠️ STUBBED FOR THE REASON THE IDEMPOTENCY SUITE GIVES: `writeAudit`
     * resolves its own context and appends to a hash chain, which has its
     * own suite. It cannot change how many rows `ledgers` gains, which is
     * the only number this file is about.
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

/* ================================================================== */
/* FIXTURE                                                             */
/* ================================================================== */

const RUN = randomUUID().slice(0, 8);
let TENANT = "";

function camelise(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] = v;
  }
  return out;
}

async function scalar(sql: string, params: unknown[]): Promise<number> {
  const r = await asSuperuser((c) => c.query(sql, params));
  return Number(r.rows[0]?.n ?? 0);
}

beforeAll(async () => {
  TENANT = randomUUID();
  const userId = await asSuperuser(async (c) => {
    await c.query(
      `INSERT INTO tenants (id, clerk_org_id, slug, name, status, plan_tier)
       VALUES ($1,$2,$3,$4,'active','enterprise')`,
      [TENANT, `org_p8_${RUN}`, `p8-${RUN}`, "Phase 8 Proof"],
    );
    const u = await c.query(
      `INSERT INTO users (tenant_id, clerk_user_id, email, role, status)
       VALUES ($1,$2,$3,'tenant_owner','active') RETURNING id`,
      [TENANT, `user_p8_${RUN}`, `p8-${RUN}@example.test`],
    );
    return u.rows[0].id as string;
  });

  /*
   * ⭐ THE CONTEXT IS READ BACK FROM THE REAL ROWS rather than written by
   * hand, so it is exactly what `requireTenantContext()` would have
   * built. A hand-written literal drifts from the schema the first time a
   * column is added, and the drift presents as an unrelated failure.
   */
  const rows = await asSuperuser(async (c) => {
    const t = await c.query(`SELECT * FROM tenants WHERE id = $1`, [TENANT]);
    const u = await c.query(`SELECT * FROM users WHERE id = $1`, [userId]);
    return { tenant: t.rows[0], user: u.rows[0] };
  });

  h.ctx = {
    tenant: camelise(rows.tenant),
    user: camelise(rows.user),
    clerkUserId: `user_p8_${RUN}`,
    clerkOrgId: `org_p8_${RUN}`,
    role: "tenant_owner",
    requestId: `req_p8_${RUN}`,
    impersonationId: null,
    impersonationScope: null,
    operatorEmail: null,
  };
});

const countLedgers = () =>
  scalar(`SELECT count(*)::int AS n FROM ledgers WHERE tenant_id = $1`, [TENANT]);
const countCostCentres = () =>
  scalar(`SELECT count(*)::int AS n FROM cost_centres WHERE tenant_id = $1`, [TENANT]);
const countTaxCodes = () =>
  scalar(`SELECT count(*)::int AS n FROM hsn_sac_codes WHERE tenant_id = $1`, [TENANT]);

/* ================================================================== */
/* 1. THE CHART OF ACCOUNTS — THE MOST IMPORTANT ENTITY IN THE PHASE   */
/* ================================================================== */

describe("🔴 chart-of-accounts — a re-run of the whole file creates nothing", () => {
  /*
   * ⚠️ THE FILE IS THE ONE A CUSTOMER WOULD ACTUALLY UPLOAD: headers in
   * their words rather than ours (`GL Code`, `Nature`), a thousands
   * separator nowhere because these are not amounts, and a blank optional
   * column — the fund type on two of three rows — which is the shape that
   * broke every `.default()` in `buildPayload`.
   */
  const CSV =
    "GL Code,Account name,Nature,Fund,Notes\n" +
    `P8-1100-${RUN},Bank — Trust,asset,trust,Client money\n` +
    `P8-4000-${RUN},Sales,revenue,,\n` +
    `P8-2100-${RUN},Trade payables,liability,,\n`;

  it("① the PREVIEW promises three creations and writes nothing", async () => {
    const { previewImport } = await import("@/server/actions/import");
    const before = await countLedgers();

    const result = await previewImport({
      entity: "chart-of-accounts",
      csvText: CSV,
      duplicateMode: "skip",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.fatal).toBeNull();
    expect(result.data.counts).toMatchObject({ create: 3, update: 0, skip: 0, error: 0 });

    /*
     * 🔴 THE NEGATIVE CONTROL. Without this line the test above passes
     * against a preview that quietly wrote the rows — which is the one
     * bug a dry run cannot be allowed to have.
     */
    expect(await countLedgers()).toBe(before);
  });

  it("② the COMMIT writes exactly what the preview promised", async () => {
    const { commitImport } = await import("@/server/actions/import");
    const before = await countLedgers();

    const result = await commitImport({
      entity: "chart-of-accounts",
      csvText: CSV,
      duplicateMode: "skip",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.counts).toMatchObject({ create: 3, update: 0, skip: 0, error: 0 });
    expect(await countLedgers()).toBe(before + 3);
  });

  it("🔴🔴 ③ THE SAME FILE AGAIN CREATES NOTHING — three skips, not three rows", async () => {
    const { commitImport } = await import("@/server/actions/import");
    const before = await countLedgers();

    const result = await commitImport({
      entity: "chart-of-accounts",
      csvText: CSV,
      duplicateMode: "skip",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.counts).toMatchObject({ create: 0, update: 0, skip: 3, error: 0 });

    /*
     * 🔴 THE NUMBER THAT WOULD HAVE BEEN 6. A chart of accounts with
     * every account in it twice cannot be cleaned up without deciding,
     * per pair, which copy the journal lines point at — and they point at
     * whichever one the second run happened to write.
     */
    expect(await countLedgers()).toBe(before);
  });

  it("④ and the row the second run skipped is named, so nobody thinks it failed", async () => {
    const { commitImport } = await import("@/server/actions/import");
    const result = await commitImport({
      entity: "chart-of-accounts",
      csvText: CSV,
      duplicateMode: "skip",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const first = result.data.rows.find((r) => r.disposition === "skip");
    expect(first?.matchedOn).toBe(`account code P8-1100-${RUN}`);
  });

  it("⑤ the trust rule the SCHEMA cannot carry was applied at the write", async () => {
    /*
     * ⚠️ `createLedgerSchema` cannot express this: it is a rule across
     * two fields whose result OVERRIDES one of them, and a
     * `.superRefine()` can refuse a combination but cannot rewrite a
     * value. `createLedger` applies it and so must the importer, or the
     * import becomes the way to create the one trust ledger in the
     * workspace that nobody reconciles.
     */
    const n = await scalar(
      `SELECT count(*)::int AS n FROM ledgers
        WHERE tenant_id = $1 AND code = $2 AND type = 'trust'
          AND requires_reconciliation = true`,
      [TENANT, `P8-1100-${RUN}`],
    );
    expect(n).toBe(1);
  });

  it("⑥ a blank optional enum column did not fail the row", async () => {
    /*
     * ⚠️ THE REGRESSION THIS PINS. A blank cell arrives as `null`, and
     * `z.enum([...]).default("operating")` REFUSES null — the default
     * only applies to an absent key. Passing the blank straight through
     * would fail every row of a file with no fund-type column with
     * "Expected 'operating' | 'trust' | …, received null". Two of the
     * three rows above have that cell blank.
     */
    const n = await scalar(
      `SELECT count(*)::int AS n FROM ledgers
        WHERE tenant_id = $1 AND code = $2 AND type = 'operating'`,
      [TENANT, `P8-4000-${RUN}`],
    );
    expect(n).toBe(1);
  });
});

/* ================================================================== */
/* 2. PREVIEW = COMMIT, INCLUDING WHEN A ROW IS REFUSED               */
/* ================================================================== */

describe("🔴 the dry run promises exactly what the real run does", () => {
  /*
   * Row 2 is refused by the schema — `Nature` is not one of the five
   * account types — and row 3 is good. The claim under test is that BOTH
   * runs say 1 create and 1 error, not that the preview says 2 creates
   * and the commit writes 1.
   */
  const CSV =
    "GL Code,Account name,Nature\n" +
    `P8-5000-${RUN},Direct costs,expense\n` +
    `P8-9999-${RUN},Mystery,liabilty\n`;

  it("both runs report 1 create and 1 error, and the message is the same one", async () => {
    const { previewImport, commitImport } = await import("@/server/actions/import");

    const preview = await previewImport({
      entity: "chart-of-accounts",
      csvText: CSV,
      duplicateMode: "skip",
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    const before = await countLedgers();
    const commit = await commitImport({
      entity: "chart-of-accounts",
      csvText: CSV,
      duplicateMode: "skip",
    });
    expect(commit.ok).toBe(true);
    if (!commit.ok) return;

    expect(preview.data.counts).toMatchObject({ create: 1, error: 1 });
    expect(commit.data.counts).toMatchObject({ create: 1, error: 1 });
    expect(await countLedgers()).toBe(before + 1);

    /*
     * ⚠️ AND THE SENTENCE IS THE SAME SENTENCE. A preview that refuses a
     * row for one reason and a commit that refuses it for another is the
     * drift the framework's constraint 1 exists to prevent, and it is
     * invisible when only the counts are compared.
     */
    const previewError = preview.data.rows.find((r) => r.disposition === "error");
    const commitError = commit.data.rows.find((r) => r.disposition === "error");
    expect(commitError?.errors[0]?.message).toBe(previewError?.errors[0]?.message);
  });

  it("the refused row is in the failed-rows CSV with its ORIGINAL values", async () => {
    const { previewImport } = await import("@/server/actions/import");
    const preview = await previewImport({
      entity: "chart-of-accounts",
      csvText: CSV,
      duplicateMode: "skip",
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    /*
     * ⚠️ THE ORIGINAL VALUES, NOT THE COERCED ONES. `liabilty` is the
     * typo the customer has to find in their own spreadsheet; handing
     * back a blank or a normalised value would hand back a file they
     * cannot diff against the one on their desktop.
     */
    expect(preview.data.failedRowsCsv).toContain("liabilty");
    expect(preview.data.failedRowsCsv).toContain(`P8-9999-${RUN}`);
  });
});

/* ================================================================== */
/* 3. A ROW MISSING A REQUIRED VALUE IS REFUSED IN THE PREVIEW         */
/* ================================================================== */

describe("🔴 a row that is not an account is refused before anything is written", () => {
  it("names the column and the rule, in the preview", async () => {
    const { previewImport } = await import("@/server/actions/import");
    const before = await countLedgers();

    const result = await previewImport({
      entity: "chart-of-accounts",
      csvText:
        "GL Code,Account name,Nature\n" +
        `P8-6000-${RUN},No type at all,\n`,
      duplicateMode: "skip",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.counts.error).toBe(1);
    expect(result.data.counts.create).toBe(0);
    const row = result.data.rows[0];
    expect(row?.errors[0]?.column).toBe("Account type");
    expect(await countLedgers()).toBe(before);
  });

  it("and a file with NO account-type column at all is refused once, not once per row", async () => {
    /*
     * ⭐ THIS IS WHY `accountType` IS `required: true` AT THE HEADER
     * LEVEL. A thousand identical row errors saying "account type is
     * required" reads as a thousand bad rows and buries the one sentence
     * that would fix it.
     */
    const { previewImport } = await import("@/server/actions/import");
    const result = await previewImport({
      entity: "chart-of-accounts",
      csvText:
        "GL Code,Account name\n" +
        `P8-7000-${RUN},Something\n` +
        `P8-7001-${RUN},Something else\n`,
      duplicateMode: "skip",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.fatal).toContain("Account type");
    expect(result.data.rows).toHaveLength(0);
  });
});

/* ================================================================== */
/* 4. UPDATE MODE — AND THE FIELD THE IMPORT NEVER TOUCHED             */
/* ================================================================== */

describe("🔴 update mode rewrites only what the file carries", () => {
  it("leaves a column the file has no header for exactly as it was", async () => {
    /*
     * ══════════════════════════════════════════════════════════════
     * 🔴 THIS IS THE `restore-prior` CLAIM'S OTHER HALF, AND IT IS THE
     *    ONE THE CONTRACT CANNOT MAKE ON ITS OWN.
     * ══════════════════════════════════════════════════════════════
     * The reversal policy says an undo must put back what an update
     * overwrote. That is Track M2's ledger to implement. What THIS phase
     * must not do is overwrite something the customer's file never
     * mentioned — because a value destroyed by a write nobody asked for
     * is not restored by an undo of a run that "succeeded".
     *
     * The bank details are the case that matters: `createLedgerSchema`
     * gives `bankDetails` a `.default({})`, so a parsed payload from a
     * file with no bank columns carries `{}`. Writing that would erase
     * the IFSC and account number a payment is made against.
     */
    const { commitImport } = await import("@/server/actions/import");
    const code = `P8-8000-${RUN}`;

    await asSuperuser((c) =>
      c.query(
        `INSERT INTO ledgers (tenant_id, name, code, type, account_type, bank_details, description)
         VALUES ($1,'Bank — Operating',$2,'operating','asset',$3::jsonb,'Set by a human')`,
        [TENANT, code, JSON.stringify({ ifsc: "HDFC0001234", accountNumber: "50100123456789" })],
      ),
    );

    const result = await commitImport({
      entity: "chart-of-accounts",
      csvText: `GL Code,Account name,Nature\n${code},Bank — Operating (renamed),asset\n`,
      duplicateMode: "update",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.counts).toMatchObject({ update: 1, create: 0 });

    const row = await asSuperuser((c) =>
      c.query(`SELECT name, bank_details FROM ledgers WHERE tenant_id=$1 AND code=$2`, [
        TENANT,
        code,
      ]),
    );
    expect(row.rows[0].name).toBe("Bank — Operating (renamed)");
    /*
     * 🔴 THE ASSERTION THAT WOULD HAVE FAILED. Without the emptiness test
     * in `ledgersWriter`, this reads `{}` — the account number and IFSC
     * gone, because the customer re-uploaded a file that renamed an
     * account.
     */
    expect(row.rows[0].bank_details).toMatchObject({
      ifsc: "HDFC0001234",
      accountNumber: "50100123456789",
    });
  });
});

/* ================================================================== */
/* 5. COST CENTRES — THE CASE-INSENSITIVE KEY                          */
/* ================================================================== */

describe("🔴 cost-centres — matched the way the database's own index matches", () => {
  it("a re-upload spelled in a different case is a skip, not a unique violation", async () => {
    const { commitImport } = await import("@/server/actions/import");

    const first = await commitImport({
      entity: "cost-centres",
      csvText: `Code,Name,Sort order\nP8PROD${RUN},Production,10\nP8HO${RUN},Head office,20\n`,
      duplicateMode: "skip",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.counts).toMatchObject({ create: 2, error: 0 });

    const before = await countCostCentres();

    /*
     * ⚠️ THE SAME TWO DEPARTMENTS, TYPED IN LOWER CASE. The unique index
     * is `UNIQUE (tenant_id, upper(code))`, so these ARE the same rows to
     * Postgres. A framework keying on the raw string would report two
     * creations here and then meet a unique violation on the first —
     * halfway through, as a database error rather than a decision.
     */
    const second = await commitImport({
      entity: "cost-centres",
      csvText: `Code,Name,Sort order\np8prod${RUN},Production,10\np8ho${RUN},Head office,20\n`,
      duplicateMode: "skip",
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.counts).toMatchObject({ create: 0, skip: 2, error: 0 });
    expect(await countCostCentres()).toBe(before);
  });

  it("a file with no sort-order column does not fail every row on the schema default", async () => {
    const { commitImport } = await import("@/server/actions/import");
    const result = await commitImport({
      entity: "cost-centres",
      csvText: `Code,Name\nP8SOUTH${RUN},Southern region\n`,
      duplicateMode: "skip",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.counts).toMatchObject({ create: 1, error: 0 });
    const n = await scalar(
      `SELECT count(*)::int AS n FROM cost_centres
        WHERE tenant_id=$1 AND upper(code)=upper($2) AND display_order = 100`,
      [TENANT, `P8SOUTH${RUN}`],
    );
    expect(n).toBe(1);
  });
});

/* ================================================================== */
/* 6. TAX CODES — THE SHAPE RULES THE PORTAL ENFORCES AT FILING        */
/* ================================================================== */

describe("🔴 tax-codes — refused here rather than by the GST portal in three weeks", () => {
  it("a SAC that does not begin 99 is refused in the preview, by name", async () => {
    const { previewImport } = await import("@/server/actions/import");
    const before = await countTaxCodes();

    const result = await previewImport({
      entity: "tax-codes",
      csvText:
        "HSN or SAC code,Goods or services,Description\n" +
        "995411,sac,Construction of buildings\n" +
        "123456,sac,Not a SAC at all\n" +
        "9403,hsn,Furniture\n" +
        "12345,hsn,Five digits is not an HSN\n",
      duplicateMode: "skip",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.counts).toMatchObject({ create: 2, error: 2 });

    const messages = result.data.rows
      .filter((r) => r.disposition === "error")
      .flatMap((r) => r.errors.map((e) => e.message));
    expect(messages.some((m) => m.includes("six digits beginning 99"))).toBe(true);
    expect(messages.some((m) => m.includes("2, 4, 6 or 8 digits"))).toBe(true);

    expect(await countTaxCodes()).toBe(before);
  });

  it("🔴 and a code arrives with NO rate, which is the correct and dangerous outcome", async () => {
    /*
     * ⭐ THE ASSERTION IS THAT NOTHING WAS INVENTED. A rate is a fact
     * about a dated period — `db/schema/gst.ts` gives four defences for
     * that one rule — so an importer that "helpfully" opened a period
     * would be inventing the single number every invoice is computed
     * from. The entity's description says so in the picker; this proves
     * the code does what the description promises.
     */
    const { commitImport } = await import("@/server/actions/import");
    await commitImport({
      entity: "tax-codes",
      csvText:
        "HSN or SAC code,Goods or services,Description,Unit\n" +
        "995411,sac,Construction of buildings,\n",
      duplicateMode: "skip",
    });

    const codes = await scalar(
      `SELECT count(*)::int AS n FROM hsn_sac_codes WHERE tenant_id=$1 AND code='995411'`,
      [TENANT],
    );
    expect(codes).toBe(1);

    const rates = await scalar(
      `SELECT count(*)::int AS n FROM hsn_sac_rates r
         JOIN hsn_sac_codes c ON c.id = r.hsn_sac_id
        WHERE c.tenant_id = $1 AND c.code = '995411'`,
      [TENANT],
    );
    expect(rates).toBe(0);
  });
});

/* ================================================================== */
/* 7. THE LOAD ORDER THIS PHASE MOVED                                  */
/* ================================================================== */

describe("🔴 the keystone: the trial balance now depends on the chart of accounts", () => {
  it("an opening trial balance naming an unknown account is refused in the PREVIEW", async () => {
    /*
     * ⚠️ THIS IS WHY THE DEPENDENCY IS `hard` AND NOT `soft`. A soft edge
     * says the rows succeed and are less complete. These rows do not
     * succeed — every one of them fails, with one error each, about a
     * file that is perfectly correct.
     */
    const { previewImport } = await import("@/server/actions/import");
    const result = await previewImport({
      entity: "opening-trial-balance",
      csvText:
        "Account code,As at,Debit,Credit\n" +
        `P8-NOSUCH-${RUN},2026-03-31,100000.00,\n` +
        `P8-4000-${RUN},2026-03-31,,100000.00\n`,
      duplicateMode: "fail",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.counts.error).toBeGreaterThanOrEqual(1);
    const messages = result.data.rows.flatMap((r) => r.errors.map((e) => e.message));
    expect(messages.join(" ")).toMatch(/account/i);
  });

  it("and the same file works once the account has been imported", async () => {
    /*
     * ⭐ THE POSITIVE CONTROL, AND THE WHOLE ARGUMENT FOR THE ENTITY.
     * `P8-1100` and `P8-4000` are in this workspace because the
     * chart-of-accounts import at the top of this file put them there —
     * not because a fixture inserted them. That is the sentence the wave
     * order encodes.
     */
    const { previewImport } = await import("@/server/actions/import");
    const result = await previewImport({
      entity: "opening-trial-balance",
      csvText:
        "Account code,As at,Debit,Credit\n" +
        `P8-1100-${RUN},2026-03-31,100000.00,\n` +
        `P8-4000-${RUN},2026-03-31,,100000.00\n`,
      duplicateMode: "fail",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.counts.error).toBe(0);
    expect(result.data.counts.create).toBe(2);
  });
});

/* ================================================================== */
/* 8. THE THREE DESTINATIONS ARE REACHABLE, AND REACH THEIR OWN TABLE  */
/* ================================================================== */

describe("⚠️ built, offered, and — this time — reachable", () => {
  it("every entity this phase registers has a writer, and it is its own", async () => {
    /*
     * 🔴 THE DEFECT THIS GUARDS IS NOT HYPOTHETICAL AND IT IS NOT "the
     *    row goes nowhere". Before Phase 1, `gst_parties` was the
     *    UNGUARDED FINAL BRANCH of `writeRow`, so an unhandled
     *    destination WROTE A GST PARTY. The registry is a `Record` over
     *    the destination union now, which makes omission a compile error
     *    — and this asserts the mapping is the identity one rather than
     *    merely present.
     */
    const { ACCOUNTING_IMPORT_ENTITIES } = await import("@/lib/import/entities-accounting");
    const { ALL_IMPORT_ENTITIES, isImportEntityKey } = await import("@/lib/import/entities");
    const { IMPORT_WRITERS } = await import("@/server/import/writers/registry");

    for (const [key, entity] of Object.entries(ACCOUNTING_IMPORT_ENTITIES)) {
      expect(isImportEntityKey(key)).toBe(true);
      expect(ALL_IMPORT_ENTITIES[key as keyof typeof ALL_IMPORT_ENTITIES]).toBeDefined();
      const writer = IMPORT_WRITERS[entity.table];
      expect(writer).toBeDefined();
      /* Exactly one of the two write shapes — the registry checks this at
       * module load, and this is the assertion that the check ran. */
      expect(typeof writer.writeRow === "function").toBe(true);
      expect(writer.writeFile).toBeUndefined();
      /* Provenance must name the table the writer actually writes. */
      expect(entity.contract.provenance.targets).toContain(entity.table);
    }
  });
});
