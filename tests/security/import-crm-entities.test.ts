/**
 * Ordence — ⭐⭐⭐ PHASE 4: THE CRM ENTITIES, AGAINST A REAL DATABASE
 * Version: v1.85.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS FILE IS FOR, AND WHAT IT DELIBERATELY DOES NOT CLAIM
 * ══════════════════════════════════════════════════════════════════════
 * The phase brief asks for five proofs, "and not by inspection". Every
 * assertion below runs the REAL entity definition, the REAL writer and
 * the REAL Postgres. Nothing is stubbed, no source is read as text.
 *
 * ⚠️ THE ONE THING RE-STATED HERE IS THE DECISION LOOP, and it is worth
 * being precise about why, because a second model of the code under test
 * is the defect this repository has been bitten by four times.
 *
 * `previewImport` and `commitImport` in `server/actions/import.ts` are
 * `"use server"` actions that begin with `requirePermission()`, i.e. with
 * Clerk. A test cannot call them without standing up an auth session, so
 * `runOnce()` below reproduces the loop between `resolveLookups` and
 * `performWrites` — the SAME functions, in the SAME order, taking the
 * entity and the writer out of the registry rather than out of a fixture.
 *
 * 🔴 SO THIS FILE PROVES: the entity, the writer, the natural keys, the
 * lookup, the re-run behaviour, the update behaviour and the SQL. It does
 * NOT prove that `import.ts` calls them in this order — that property
 * belongs to Phase 1's file and is proven by gate 30's induction, which
 * compiles the real tree with a sentinel destination and requires the
 * build to fail naming the registry.
 *
 * ⚠️ `runOnce("preview")` and `runOnce("commit")` differ by ONE
 * statement, exactly as the real one does, which is what makes the
 * "preview counts equal commit counts" assertion meaningful rather than
 * circular: if the two paths were separate code, the test would be
 * comparing two implementations and would pass whatever either did.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { withTenant } from "@/db";
import { companies, contacts } from "@/db/schema";
import { leads, leadActivities } from "@/db/schema";
import { ALL_IMPORT_ENTITIES } from "@/lib/import";
import { planImport } from "@/lib/import";
import type { ImportNaturalKey, ImportRowPlan } from "@/lib/import";
import { IMPORT_WRITERS } from "@/server/import/writers/registry";
import type { TenantContext } from "@/server/tenant-context";
import { asSuperuser } from "../setup";

/**
 * ⭐ WAVE 2C. The planner takes the workspace's currency as data — see
 * `ImportContext`. These files are all about entities whose amounts are
 * in rupees, so every call passes the same one; the exponent behaviour
 * itself is proven in `tests/ui/import-money-exponent.test.ts`.
 */
const IMPORT_CONTEXT = { workspaceCurrency: "INR" } as const;


const RUN = randomUUID().slice(0, 8);

type Fixtures = { tenant: string; user: string; acme: string };
const F = {} as Fixtures;

/**
 * ⚠️ A CAST, AND A NARROW ONE. `TenantContext` carries the whole tenant
 * row, the whole user row, the Clerk ids and the impersonation members;
 * a writer reads exactly two of them. Building the full object would
 * mean fetching two rows to hand a function two uuids, and the cast is
 * visible here rather than hidden in a helper.
 */
function ctxFor(tenantId: string, userId: string): TenantContext {
  return {
    tenant: { id: tenantId },
    user: { id: userId },
    impersonationId: null,
    impersonationScope: null,
    operatorEmail: null,
  } as unknown as TenantContext;
}

/* ------------------------------------------------------------------ */
/* THE RUNNER — see the header for what it does and does not model     */
/* ------------------------------------------------------------------ */

type Disposition = "create" | "update" | "skip" | "error";
type RunResult = {
  dispositions: Map<number, Disposition>;
  errors: Map<number, string[]>;
  counts: Record<Disposition, number>;
};

/**
 * `resolveLookups`' `company_by_name` branch, which lives in
 * `server/actions/import.ts` and is not importable from a test (the file
 * is `"use server"`). The query is the same one, including the doubled
 * backslash — `'\\s+'` in a template literal is what produces the SQL
 * `'\s+'`; a single backslash collapses to a bare `s` and the pattern
 * silently strips the letter s out of every company name.
 */
async function resolveCompanyLookups(
  ctx: TenantContext,
  rows: readonly ImportRowPlan[],
): Promise<Map<string, string>> {
  const wanted = new Set<string>();
  for (const row of rows) {
    for (const lookup of row.lookups ?? []) {
      if (lookup.kind === "company_by_name") wanted.add(lookup.value);
    }
  }
  const found = new Map<string, string>();
  if (wanted.size === 0) return found;

  const rowsFound = await withTenant(ctx.tenant.id, (tx) =>
    tx
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      .where(
        and(
          eq(companies.tenantId, ctx.tenant.id),
          isNull(companies.deletedAt),
          inArray(
            sql`lower(regexp_replace(${companies.name}, '\\s+', ' ', 'g'))`,
            Array.from(wanted),
          ),
        ),
      )
      .limit(5000),
  );
  for (const row of rowsFound) {
    const key = `company_by_name:${row.name.toLowerCase().replace(/\s+/g, " ")}`;
    if (!found.has(key)) found.set(key, row.id);
  }
  return found;
}

async function runOnce(
  ctx: TenantContext,
  entityKey: "contacts" | "leads",
  csv: string,
  duplicateMode: "skip" | "update" | "fail",
  mode: "preview" | "commit",
): Promise<RunResult> {
  const entity = ALL_IMPORT_ENTITIES[entityKey];
  const writer = IMPORT_WRITERS[entity.table];

  const plan = planImport(entity, csv, IMPORT_CONTEXT);
  const dispositions = new Map<number, Disposition>();
  const errors = new Map<number, string[]>();

  for (const row of plan.rows) {
    if (row.errors.length > 0) {
      dispositions.set(row.recordNumber, "error");
      errors.set(
        row.recordNumber,
        row.errors.map((e) => e.message),
      );
    }
  }

  const parsedRows = plan.rows.filter((row) => row.errors.length === 0);
  const resolved = await resolveCompanyLookups(ctx, parsedRows);

  const validRows: ImportRowPlan[] = [];
  const payloads = new Map<number, Record<string, unknown>>();

  for (const row of parsedRows) {
    const lookups = row.lookups ?? [];
    const missing = lookups.filter((l) => !resolved.has(`${l.kind}:${l.value}`));
    if (missing.length > 0) {
      dispositions.set(row.recordNumber, "error");
      errors.set(
        row.recordNumber,
        missing.map((l) => l.missing),
      );
      continue;
    }
    const payload: Record<string, unknown> = { ...(row.payload ?? {}) };
    for (const l of lookups) payload[l.into] = resolved.get(`${l.kind}:${l.value}`);
    payloads.set(row.recordNumber, payload);
    validRows.push(row);
  }

  const existing = await writer.findExisting(
    ctx,
    validRows.map((r) => r.naturalKey).filter((k): k is ImportNaturalKey => !!k),
  );

  const planned: { row: ImportRowPlan; payload: Record<string, unknown>; existingId: string | null }[] =
    [];

  for (const row of validRows) {
    const identity = row.naturalKey ?? null;
    const composite = identity ? `${identity.kind}:${identity.value}` : null;
    const existingId = composite ? existing.get(composite) : undefined;

    if (existingId && duplicateMode === "skip") {
      dispositions.set(row.recordNumber, "skip");
      continue;
    }
    if (existingId && duplicateMode === "fail") {
      dispositions.set(row.recordNumber, "error");
      errors.set(row.recordNumber, ["already in this workspace"]);
      continue;
    }
    dispositions.set(row.recordNumber, existingId ? "update" : "create");
    planned.push({ row, payload: payloads.get(row.recordNumber) ?? {}, existingId: existingId ?? null });
  }

  // 🔴 THE ONLY BRANCH ON `mode`, BELOW EVERY DECISION — as in the real one.
  if (mode === "commit") {
    for (const p of planned) {
      const outcome = await writer.writeRow!(ctx, p.payload, p.existingId);
      if (!outcome.ok) {
        dispositions.set(p.row.recordNumber, "error");
        errors.set(p.row.recordNumber, [outcome.error]);
      }
    }
  }

  const counts: Record<Disposition, number> = { create: 0, update: 0, skip: 0, error: 0 };
  for (const d of dispositions.values()) counts[d] += 1;
  return { dispositions, errors, counts };
}

const countLive = (table: typeof contacts | typeof leads, tenantId: string) =>
  withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(table)
      .where(and(eq(table.tenantId, tenantId), isNull(table.deletedAt)));
    return rows[0]?.n ?? 0;
  });

/* ------------------------------------------------------------------ */
/* FIXTURES                                                            */
/* ------------------------------------------------------------------ */

beforeAll(async () => {
  await asSuperuser(async (c) => {
    const t = await c.query(
      `INSERT INTO tenants (clerk_org_id, name, slug, status)
       VALUES ($1, 'Phase 4 import fixture', $2, 'active') RETURNING id`,
      [`org_p4_${RUN}`, `p4-${RUN}`],
    );
    F.tenant = t.rows[0].id;

    const u = await c.query(
      `INSERT INTO users (tenant_id, clerk_user_id, email, role, status)
       VALUES ($1, $2, $3, 'tenant_owner', 'active') RETURNING id`,
      [F.tenant, `user_p4_${RUN}`, `p4-${RUN}@test.local`],
    );
    F.user = u.rows[0].id;

    /*
     * ⚠️ THE COMPANY NAME CARRIES A DOUBLE SPACE ON PURPOSE. The lookup
     * collapses runs of whitespace on both sides; a fixture spelled
     * tidily would pass with or without that, and the collapse is the
     * part that is easy to lose.
     */
    const co = await c.query(
      `INSERT INTO companies (tenant_id, name) VALUES ($1, $2) RETURNING id`,
      [F.tenant, "Acme  Industries"],
    );
    F.acme = co.rows[0].id;
  });
});

afterAll(async () => {
  await asSuperuser(async (c) => {
    if (F.tenant) await c.query(`DELETE FROM tenants WHERE id = $1`, [F.tenant]);
  });
});

/* ================================================================== */
/* CONTACTS                                                           */
/* ================================================================== */

describe("Phase 4 · contacts", () => {
  const CSV = [
    "First name,Last name,Email,Company,Job title",
    "Rajesh,Kumar,RAJESH@acme.example,Acme Industries,Director",
    "Priya,Sharma,,Acme Industries,Manager",
    "Sole,Trader,sole@example.com,,Proprietor",
    "Ghost,Person,ghost@example.com,Nonexistent Ltd,Analyst",
  ].join("\n");

  it("preview decides exactly what commit does — including when a lookup misses", async () => {
    const ctx = ctxFor(F.tenant, F.user);

    const preview = await runOnce(ctx, "contacts", CSV, "skip", "preview");
    expect(preview.counts).toEqual({ create: 3, update: 0, skip: 0, error: 1 });

    /*
     * 🔴 THE UNRESOLVED COMPANY IS REFUSED IN THE PREVIEW, WITH THE
     * ENTITY'S OWN SENTENCE. If this were a foreign-key violation at the
     * write instead, the preview would promise four rows and three would
     * land — the drift that teaches a customer to stop reading previews.
     */
    expect(preview.errors.get(5)?.[0]).toContain('No company named "Nonexistent Ltd"');

    const commit = await runOnce(ctx, "contacts", CSV, "skip", "commit");
    expect(commit.counts).toEqual(preview.counts);
    expect(await countLive(contacts, F.tenant)).toBe(3);
  });

  it("🔴 a re-run of the whole file creates nothing the second time", async () => {
    const ctx = ctxFor(F.tenant, F.user);
    const before = await countLive(contacts, F.tenant);

    const second = await runOnce(ctx, "contacts", CSV, "skip", "commit");

    expect(second.counts.create).toBe(0);
    expect(second.counts.skip).toBe(3);
    expect(await countLive(contacts, F.tenant)).toBe(before);
  });

  it("matches case-insensitively on email and on name+company for the row that has none", async () => {
    const ctx = ctxFor(F.tenant, F.user);
    /*
     * Row 1's address is RAJESH@acme.example in the file and was stored
     * as written; row 2 has no email at all and can only have matched on
     * "priya sharma|acme industries" — which required the double space in
     * the company name to collapse on both sides.
     */
    const again = await runOnce(ctx, "contacts", CSV.toLowerCase().replace("first name", "First name"), "skip", "preview");
    expect(again.counts.skip).toBe(3);
  });

  it("🔴 update mode does not touch a field the import never mentions", async () => {
    const ctx = ctxFor(F.tenant, F.user);

    // A value that pre-dates the migration and no column in the file
    // corresponds to. The classic loss: an "update" that is really an
    // overwrite of the whole row with the file's idea of it.
    const marker = new Date("2024-01-02T03:04:05.000Z");
    await asSuperuser((c) =>
      c.query(`UPDATE contacts SET last_contacted_at = $1 WHERE tenant_id = $2`, [
        marker,
        F.tenant,
      ]),
    );

    const CHANGED = CSV.replace("Director", "Managing Director");
    const result = await runOnce(ctx, "contacts", CHANGED, "update", "commit");
    expect(result.counts.update).toBe(3);
    expect(result.counts.create).toBe(0);

    const rows = await asSuperuser((c) =>
      c.query(
        `SELECT job_title, last_contacted_at, company_id FROM contacts
          WHERE tenant_id = $1 AND lower(email) = 'rajesh@acme.example'`,
        [F.tenant],
      ),
    );
    expect(rows.rows[0].job_title).toBe("Managing Director");
    expect(new Date(rows.rows[0].last_contacted_at).toISOString()).toBe(marker.toISOString());
    expect(rows.rows[0].company_id).toBe(F.acme);
  });

  it("🔴 a row that names no company does not UNLINK a contact somebody linked by hand", async () => {
    const ctx = ctxFor(F.tenant, F.user);

    // The sole trader has no company in the file. Somebody in the office
    // has since linked them to Acme.
    await asSuperuser((c) =>
      c.query(`UPDATE contacts SET company_id = $1 WHERE tenant_id = $2 AND email = $3`, [
        F.acme,
        F.tenant,
        "sole@example.com",
      ]),
    );

    await runOnce(ctx, "contacts", CSV, "update", "commit");

    const rows = await asSuperuser((c) =>
      c.query(`SELECT company_id FROM contacts WHERE tenant_id = $1 AND email = $2`, [
        F.tenant,
        "sole@example.com",
      ]),
    );
    expect(rows.rows[0].company_id).toBe(F.acme);
  });

  it("refuses two rows in one file that are the same person, in the preview", async () => {
    const ctx = ctxFor(F.tenant, F.user);
    const DUP = [
      "First name,Last name,Email",
      "Anita,Desai,anita@example.com",
      "Anita,Desai,ANITA@example.com",
    ].join("\n");

    const preview = await runOnce(ctx, "contacts", DUP, "skip", "preview");
    expect(preview.counts.error).toBe(1);
    expect(preview.errors.get(3)?.[0]).toContain("same contact as row 2");
  });
});

/* ================================================================== */
/* LEADS                                                              */
/* ================================================================== */

describe("Phase 4 · leads", () => {
  const CSV = [
    "Name,Email,Phone,Source,Temperature,Budget from,Budget to,Consent source",
    "Vikram Rao,vikram@example.com,+91 98765 43210,referral,hot,4500000,4500000.50,Website form",
    "Meena Iyer,,022-2345 6789,walk_in,warm,,,",
  ].join("\n");

  it("preview decides exactly what commit does, and the money survives the round trip", async () => {
    const ctx = ctxFor(F.tenant, F.user);

    const preview = await runOnce(ctx, "leads", CSV, "skip", "preview");
    expect(preview.counts).toEqual({ create: 2, update: 0, skip: 0, error: 0 });

    const commit = await runOnce(ctx, "leads", CSV, "skip", "commit");
    expect(commit.counts).toEqual(preview.counts);

    const rows = await asSuperuser((c) =>
      c.query(
        `SELECT budget_min_minor, budget_max_minor, score, status, reference, consent_at, consent_source
           FROM leads WHERE tenant_id = $1 AND email_key = 'vikram@example.com'`,
        [F.tenant],
      ),
    );
    /*
     * 🔴 45,00,000.50 IN THE FILE IS 450000050 PAISE, EXACTLY. The file
     * says rupees, `coerceMoneyMinor` hands paise to `buildPayload`,
     * `fromMinorUnits` turns them back into the rupee string the schema
     * insists on, and `toMinorUnits` in the writer converts once more.
     * A single missed conversion in that chain multiplies or divides
     * every budget in the file by a hundred and passes every check.
     */
    expect(rows.rows[0].budget_min_minor).toBe("450000000");
    expect(rows.rows[0].budget_max_minor).toBe("450000050");
    expect(rows.rows[0].status).toBe("new");
    expect(rows.rows[0].reference).toMatch(/^LEAD-/);
    expect(rows.rows[0].consent_source).toBe("Website form");
    // Consent is stamped at the write, never taken from the file.
    expect(rows.rows[0].consent_at).not.toBeNull();
    expect(Number(rows.rows[0].score)).toBeGreaterThan(0);
  });

  it("writes the lead's first history entry, exactly as the form does", async () => {
    const rows = await asSuperuser((c) =>
      c.query(
        `SELECT la.subject FROM lead_activities la
           JOIN leads l ON l.id = la.lead_id
          WHERE l.tenant_id = $1 AND l.email_key = 'vikram@example.com'`,
        [F.tenant],
      ),
    );
    expect(rows.rows.map((r: { subject: string }) => r.subject)).toContain("Lead created");
  });

  it("🔴 a re-run of the whole file creates nothing the second time", async () => {
    const ctx = ctxFor(F.tenant, F.user);
    const before = await countLive(leads, F.tenant);

    const second = await runOnce(ctx, "leads", CSV, "skip", "commit");

    expect(second.counts.create).toBe(0);
    expect(second.counts.skip).toBe(2);
    expect(await countLive(leads, F.tenant)).toBe(before);
  });

  it("🔴 the same phone written three different ways is one lead, not three", async () => {
    const ctx = ctxFor(F.tenant, F.user);
    const before = await countLive(leads, F.tenant);

    const RESHAPED = [
      "Name,Phone",
      "Meena Iyer,(022) 2345-6789",
      "Meena I.,0 2223 456789",
    ].join("\n");

    const result = await runOnce(ctx, "leads", RESHAPED, "skip", "commit");
    expect(result.counts.create).toBe(0);
    expect(await countLive(leads, F.tenant)).toBe(before);
  });

  it("🔴 refuses a lead with neither phone nor email — in the PREVIEW, with the form's sentence", async () => {
    const ctx = ctxFor(F.tenant, F.user);
    const UNREACHABLE = ["Name,Email,Phone", "Nobody At All,,"].join("\n");

    const preview = await runOnce(ctx, "leads", UNREACHABLE, "skip", "preview");
    expect(preview.counts).toEqual({ create: 0, update: 0, skip: 0, error: 1 });
    expect(preview.errors.get(2)?.[0]).toContain("a lead you cannot reach is not a lead");

    // And nothing reaches the database on a commit either.
    const before = await countLive(leads, F.tenant);
    const commit = await runOnce(ctx, "leads", UNREACHABLE, "skip", "commit");
    expect(commit.counts.create).toBe(0);
    expect(await countLive(leads, F.tenant)).toBe(before);
  });

  it("🔴 update mode does not resurrect a lead the team has already lost", async () => {
    const ctx = ctxFor(F.tenant, F.user);

    await asSuperuser((c) =>
      c.query(
        `UPDATE leads SET status = 'lost', lost_reason = 'Bought elsewhere', score = 0
          WHERE tenant_id = $1 AND email_key = 'vikram@example.com'`,
        [F.tenant],
      ),
    );

    const CHANGED = CSV.replace("hot", "cold");
    const result = await runOnce(ctx, "leads", CHANGED, "update", "commit");
    expect(result.counts.update).toBe(2);

    const rows = await asSuperuser((c) =>
      c.query(
        `SELECT status, score, temperature, consent_at FROM leads
          WHERE tenant_id = $1 AND email_key = 'vikram@example.com'`,
        [F.tenant],
      ),
    );
    // The file's data landed…
    expect(rows.rows[0].temperature).toBe("cold");
    // …and the workspace's own judgement did not move.
    expect(rows.rows[0].status).toBe("lost");
    /*
     * 🔴 AND THE SCORE STAYED ZERO. `scoreLead` returns 0 for a lost
     * lead; recomputing it against the file's implied "new" status would
     * put a dead lead back at the top of every list sorted by score.
     * This assertion is the reason the update path reads the row first.
     */
    expect(Number(rows.rows[0].score)).toBe(0);
  });

  it("does not re-stamp consent on a lead that already had it", async () => {
    const ctx = ctxFor(F.tenant, F.user);

    const before = await asSuperuser((c) =>
      c.query(`SELECT consent_at FROM leads WHERE tenant_id = $1 AND email_key = $2`, [
        F.tenant,
        "vikram@example.com",
      ]),
    );

    await runOnce(ctx, "leads", CSV, "update", "commit");

    const after = await asSuperuser((c) =>
      c.query(`SELECT consent_at FROM leads WHERE tenant_id = $1 AND email_key = $2`, [
        F.tenant,
        "vikram@example.com",
      ]),
    );
    expect(new Date(after.rows[0].consent_at).toISOString()).toBe(
      new Date(before.rows[0].consent_at).toISOString(),
    );
  });

  it("appends no history entry on an update", async () => {
    const rows = await asSuperuser((c) =>
      c.query(
        `SELECT count(*)::int AS n FROM lead_activities la
           JOIN leads l ON l.id = la.lead_id
          WHERE l.tenant_id = $1 AND l.email_key = 'vikram@example.com'`,
        [F.tenant],
      ),
    );
    // One, from the creation, after four update runs over the same lead.
    expect(rows.rows[0].n).toBe(1);
  });
});

/* ================================================================== */
/* THE CONTRACT AND THE REGISTRY, READ FROM THE REAL MODULES           */
/* ================================================================== */

describe("Phase 4 · reachability", () => {
  it("both entities are in the single allowlist and both destinations have a writer", () => {
    for (const key of ["contacts", "leads"] as const) {
      const entity = ALL_IMPORT_ENTITIES[key];
      expect(entity).toBeDefined();
      /*
       * 🔴 THE DEFECT THIS PROJECT HAS FOUND THIRTY TIMES: built,
       * offered in a picker, unreachable. A `Record` over the
       * destination union makes omission a compile error; this asserts
       * the object is actually there at run time as well.
       */
      const writer = IMPORT_WRITERS[entity.table];
      expect(writer).toBeDefined();
      expect(typeof writer.writeRow).toBe("function");
      expect(typeof writer.writeFile).toBe("undefined");
    }
  });

  it("the SQL this phase ships is applied to the database it is tested against", async () => {
    /*
     * ⚠️ NOT "the file exists" — that is the check that passes on a
     * migration nobody ran. This asks the database.
     */
    const rows = await asSuperuser((c) =>
      c.query(
        `SELECT indexname FROM pg_indexes
          WHERE indexname IN ('contacts_import_email_match_idx',
                              'contacts_import_name_match_idx',
                              'leads_import_email_match_idx',
                              'leads_import_phone_match_idx')`,
      ),
    );
    expect(rows.rows.length).toBe(4);
  });
});

// Referenced so the import is not dropped by a future tidy-up: the
// cascade from `leads` to `lead_activities` is what the reversal policy
// claims, and the history assertion above depends on the table existing.
void leadActivities;
