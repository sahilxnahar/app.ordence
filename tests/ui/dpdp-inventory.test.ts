/**
 * ⭐⭐⭐ THE PERSONAL-DATA INVENTORY AND THE GATE THAT KEEPS IT HONEST
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT EACH BLOCK WOULD HAVE CAUGHT
 * ══════════════════════════════════════════════════════════════════════
 * "the gate fires"        — a check nobody has seen fail is a check
 *                           nobody should trust. This one writes a real
 *                           schema file with a real phone column, runs
 *                           the real gate and reads the real exit code.
 * "platform scope"        — the first working erasure planner put
 *                           `platform_staff` in the DELETE list for a
 *                           contact's request. `retention.ts` already
 *                           carried a paragraph saying the two Fiduciary
 *                           roles must not mix, and a paragraph enforces
 *                           nothing.
 * "every table planned"   — an export that quietly omits a table is the
 *                           whole defect. Nothing may be absent from the
 *                           plan; a table is `search`, `no-reach`,
 *                           `not-applicable`, `skip` or `out-of-scope`.
 * "did not look vs empty" — reporting "no rows" for a table we never
 *                           searched is the sentence that makes a
 *                           partial export read as a complete one.
 *
 * ⚠️ NOT ONE ASSERTION PINS A COUNT. `expect(list.size).toBe(71)` has
 * failed five correct changes in this codebase. The properties asserted
 * here survive a table being added, which is the only kind of assertion
 * worth having about an inventory that is supposed to grow.
 */

import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  CLASSIFICATION,
  PRINCIPAL_KINDS,
  PRINCIPAL_TABLES,
  classificationFor,
  personalDataTables,
  tenantScopedTables,
  unreachableTables,
} from "@/lib/dpdp/classification";
import { detectTable } from "@/lib/dpdp/detector";
import {
  bestCaseCoverage,
  buildExportPlan,
  executionOrder,
  type Subject,
} from "@/lib/dpdp/subject-graph";
import { buildErasurePlan } from "@/lib/dpdp/erasure";

/* ------------------------------------------------------------------ */

const FIXTURE_DIR = join(process.cwd(), "db", "schema");
const FIXTURE = join(FIXTURE_DIR, "__dpdp_gate_fixture__.ts");

function runGate(): { code: number; output: string } {
  try {
    const output = execFileSync("node", ["scripts/check-data-classification.mjs"], {
      /**
       * ⭐ THE GATE SKIPS `__`-MARKED SCRATCH FILES BY DEFAULT, so that
       * running it alongside this suite does not make it fail on this
       * very fixture. This test is the ONLY thing that asks for them
       * back, because this test is the only thing that needs the gate
       * to see a deliberately-broken file.
       */
      env: { ...process.env, ORDENCE_GATE_FIXTURES: "1" },
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, output };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

afterEach(() => rmSync(FIXTURE, { force: true }));

/* ------------------------------------------------------------------ */

describe("🔴 the classification gate actually fires", () => {
  it("the tree passes as it stands", () => {
    expect(runGate().code).toBe(0);
  });

  /**
   * 🔴 THE ONE THAT MATTERS. This is the shape of the next module
   * somebody adds: a table with a phone number on it, shipped without
   * anybody deciding what it holds.
   */
  it("FAILS when a new table carries a phone number and nobody classifies it", () => {
    mkdirSync(FIXTURE_DIR, { recursive: true });
    writeFileSync(
      FIXTURE,
      [
        'import { pgTable, uuid, varchar } from "drizzle-orm/pg-core";',
        "",
        'export const loyaltyMembers = pgTable("loyalty_members", {',
        '  id: uuid("id").defaultRandom().primaryKey(),',
        '  tenantId: uuid("tenant_id").notNull(),',
        '  memberName: varchar("member_name", { length: 200 }),',
        '  phone: varchar("phone", { length: 40 }),',
        "});",
        "",
      ].join("\n"),
      "utf8",
    );

    const { code, output } = runGate();
    expect(code).toBe(1);
    expect(output).toContain("loyalty_members");
    /**
     * ⭐ AND IT NAMES A COLUMN, so the fix is obvious rather than a hunt.
     *
     * ⚠️ WHICH column is not pinned. The gate reports the strongest
     * signal it found, and asserting it reports `phone` specifically
     * would fail the day somebody makes `member_name` rank higher —
     * a correct change breaking a test about something else, which is
     * the failure this codebase has recorded five times.
     */
    expect(output).toMatch(/column `(member_name|phone)`/);
  });

  it("FAILS when a table has no tenant_id and is declared tenant-scoped", () => {
    mkdirSync(FIXTURE_DIR, { recursive: true });
    writeFileSync(
      FIXTURE,
      [
        'import { pgTable, uuid, varchar } from "drizzle-orm/pg-core";',
        "",
        /**
         * No `tenant_id`. Nothing isolates it per workspace, so a
         * workspace's data-principal search would read every customer's
         * rows at once — and the gate must say so even before anybody
         * writes a classification, because the classification would then
         * be the thing making it worse.
         */
        'export const globalNewsletter = pgTable("global_newsletter_signups", {',
        '  id: uuid("id").defaultRandom().primaryKey(),',
        '  email: varchar("email", { length: 320 }),',
        "});",
        "",
      ].join("\n"),
      "utf8",
    );

    const { code, output } = runGate();
    expect(code).toBe(1);
    expect(output).toContain("global_newsletter_signups");
  });
});

/* ------------------------------------------------------------------ */

describe("⭐ the detector", () => {
  it("flags a column that names a person", () => {
    const v = detectTable("anything", ["id", "first_name", "email"]);
    expect(v.carriesDirect).toBe(true);
    expect(v.suspected).toBe(true);
  });

  /**
   * ⚠️ THE `_by` RULE. `^employee_id$` missed `reviewer_employee_id`
   * and the first `link-user` rule missed `bank_statements.imported_by`,
   * because both enumerated the verbs they knew about.
   */
  it("finds a person behind a prefixed foreign key and behind any verb ending in _by", () => {
    expect(detectTable("t", ["reviewer_employee_id"]).carriesLink).toBe(true);
    expect(detectTable("t", ["imported_by"]).carriesLink).toBe(true);
    expect(detectTable("t", ["possession_recorded_by"]).carriesLink).toBe(true);
  });

  /**
   * 🔴 A jsonb NOBODY CAN PROMISE IS EMPTY IS STILL SUSPECTED. Customers
   * put phone numbers in `notes`.
   */
  it("suspects a table whose only signal is a freeform column", () => {
    const v = detectTable("t", ["id", "tenant_id", "metadata"]);
    expect(v.carriesDirect).toBe(false);
    expect(v.suspected).toBe(true);
  });

  /**
   * 🔴 `name` IS THE ONE COLUMN IN `NOT_PERSONAL` THAT IS STILL FLAGGED.
   *
   * `leads.name` is a human being and `plans.name` is a price plan. No
   * rule separates them, so the detector refuses to decide and the
   * classification has to.
   */
  it("still flags a bare `name`, and the classification decides what it is", () => {
    expect(detectTable("t", ["name"]).carriesDirect).toBe(true);
    expect(classificationFor("leads")?.holds).toBe("principal");
    expect(classificationFor("plans")?.holds).toBe("operational");
  });
});

/* ------------------------------------------------------------------ */

describe("⭐ the inventory", () => {
  it("classifies a table exactly once", () => {
    const seen = new Set<string>();
    const duplicated = CLASSIFICATION.filter((c) => {
      if (seen.has(c.table)) return true;
      seen.add(c.table);
      return false;
    });
    expect(duplicated.map((c) => c.table)).toEqual([]);
  });

  it("anchors every principal kind on a table classified as a principal", () => {
    for (const kind of PRINCIPAL_KINDS) {
      const entry = classificationFor(PRINCIPAL_TABLES[kind]);
      expect(entry?.holds).toBe("principal");
    }
  });

  /**
   * 🔴 s.8(7)'s EXCEPTION IS A NAMED-LAW EXCEPTION. A table that keeps
   * data with no rule attached would refuse an erasure with no statute,
   * which is worse than refusing with no reason at all.
   */
  it("never leaves an operational table without a stated reason", () => {
    const unexplained = CLASSIFICATION.filter(
      (c) => c.holds === "operational" && (c.because ?? "").trim().length === 0,
    );
    expect(unexplained.map((c) => c.table)).toEqual([]);
  });

  it("records a reason for every table it admits it cannot reach", () => {
    for (const t of unreachableTables()) {
      const gap = t.reaches.find((r) => r.via === "none");
      expect(gap && "because" in gap ? gap.because.length : 0).toBeGreaterThan(20);
    }
  });
});

/* ------------------------------------------------------------------ */

describe("🔴 Ordence's own records are out of a workspace's reach", () => {
  const subject: Subject = {
    anchors: PRINCIPAL_KINDS.map((kind) => ({
      kind,
      id: "00000000-0000-0000-0000-000000000001",
      establishedBy: "a test fixture, not a person",
    })),
    identifiers: { emails: ["someone@example.invalid"], phones: ["9999999999"] },
  };

  /**
   * 🔴 THE BUG THIS EXISTS FOR. The first working erasure planner
   * proposed deleting `platform_staff` — the row identifying an Ordence
   * support engineer — because a contact of a customer asked a builder
   * to forget them.
   */
  it("never searches a platform-scoped table, at any anchor", () => {
    const plan = buildExportPlan(subject);
    const platform = CLASSIFICATION.filter((c) => c.scope === "platform").map((c) => c.table);
    const searched = plan.tables.filter((t) => t.verdict === "search").map((t) => t.table);
    expect(searched.filter((t) => platform.includes(t))).toEqual([]);
  });

  it("never proposes erasing one either", () => {
    const plan = buildErasurePlan({ exportPlan: buildExportPlan(subject) });
    const platform = new Set(
      CLASSIFICATION.filter((c) => c.scope === "platform").map((c) => c.table),
    );
    expect(plan.tables.filter((t) => platform.has(t.table)).map((t) => t.table)).toEqual([]);
  });

  it("still puts every tenant-scoped personal table in scope", () => {
    const plan = buildExportPlan(subject);
    const planned = new Set(plan.tables.map((t) => t.table));
    const missing = tenantScopedTables()
      .filter((c) => c.holds !== "operational")
      .map((c) => c.table)
      .filter((t) => !planned.has(t));
    expect(missing).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */

describe("🔴 nothing is absent from the plan", () => {
  const subject: Subject = {
    anchors: [
      { kind: "contact", id: "11111111-1111-1111-1111-111111111111", establishedBy: "fixture" },
    ],
    identifiers: { emails: [], phones: [] },
  };

  /**
   * ⭐ THE INVARIANT THE WHOLE BATCH RESTS ON. A table missing from the
   * plan is a table missing from the manifest, and a manifest that does
   * not mention a table tells somebody we hold nothing of theirs there.
   */
  it("gives every classified table a verdict", () => {
    const plan = buildExportPlan(subject);
    const planned = new Set(plan.tables.map((t) => t.table));
    expect(CLASSIFICATION.map((c) => c.table).filter((t) => !planned.has(t))).toEqual([]);
  });

  it("uses only the verdicts it declares", () => {
    const allowed = new Set(["search", "no-reach", "not-applicable", "skip", "out-of-scope"]);
    const plan = buildExportPlan(subject);
    expect(plan.tables.filter((t) => !allowed.has(t.verdict)).map((t) => t.table)).toEqual([]);
  });

  it("always says something about a table it did not search", () => {
    const plan = buildExportPlan(subject);
    const silent = plan.tables.filter((t) => t.verdict !== "search" && t.note.trim().length === 0);
    expect(silent.map((t) => t.table)).toEqual([]);
  });

  /**
   * 🔴 "WE HOLD NOTHING OF YOURS" AND "WE COULD NOT LOOK" ARE DIFFERENT
   *    SENTENCES.
   *
   * A subject with only a contact anchor has no payroll record. That is
   * `not-applicable` — an honest zero. `no-reach` means nothing in the
   * product can search that table for ANYBODY, which is a defect. The
   * first version of the planner reported ninety-two tables as
   * `no-reach` when ninety-one of them were a person who does not work
   * here.
   */
  it("distinguishes a person having no record from a table nobody can search", () => {
    const plan = buildExportPlan(subject);
    const payslips = plan.tables.find((t) => t.table === "payslips");
    expect(payslips?.verdict).toBe("not-applicable");

    const structural = plan.tables.filter((t) => t.verdict === "no-reach").map((t) => t.table);
    /** Exactly the tables the inventory itself admits to. Not a count. */
    expect(structural.sort()).toEqual(unreachableTables().map((t) => t.table).sort());
  });

  it("resolves a parent before the table that hops through it", () => {
    const { order, cycles } = executionOrder(buildExportPlan(subject));
    expect(cycles).toEqual([]);
    const at = new Map(order.map((t, i) => [t, i]));
    const wrong: string[] = [];
    for (const t of buildExportPlan(subject).tables) {
      for (const p of t.predicates) {
        if (p.op === "via-parent" && (at.get(p.parent) ?? -1) > (at.get(t.table) ?? -1)) {
          wrong.push(`${t.table} before ${p.parent}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */

describe("⭐ coverage is derived, never asserted", () => {
  it("accounts for every table in exactly one bucket", () => {
    const c = bestCaseCoverage();
    expect(c.searched + c.unreachable + c.notApplicable + c.skipped + c.outOfScope).toBe(c.total);
  });

  it("can search more tables than it admits it cannot", () => {
    /**
     * ⚠️ A DIRECTION, NOT A NUMBER. If this ever inverts, the export has
     * stopped being a feature and become a disclaimer.
     */
    const c = bestCaseCoverage();
    expect(c.searched).toBeGreaterThan(c.unreachable);
  });

  it("counts every personal-data table as either searchable or admitted", () => {
    const c = bestCaseCoverage();
    expect(c.searched + c.unreachable + c.notApplicable).toBe(
      personalDataTables().filter((t) => t.scope === "tenant").length,
    );
  });
});
