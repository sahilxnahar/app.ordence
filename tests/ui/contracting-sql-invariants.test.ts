/**
 * Ordence — the contracting invariants, read as source
 * Version: v0.68.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THESE READ SQL TEXT RATHER THAN RUNNING IT
 * ══════════════════════════════════════════════════════════════════════
 * The behaviour of `0040` and `0041` was verified against a real
 * PostgreSQL 16 while they were written — the over-commit reproduced at
 * available −300 before the guard and refused after it; the over-billing
 * guard refused a cumulative 1,100 of 1,000 and allowed it once a
 * variation was approved.
 *
 * That verification is not repeatable here: the `ui` vitest project runs
 * in jsdom with no database, by design, so that a developer with no
 * Postgres can still run it. The database-backed suite is the `security`
 * project, and it is the right home for behavioural SQL tests.
 *
 * What these tests defend is different and cheaper: the PROPERTIES of the
 * SQL that a later edit is most likely to break silently. A trigger that
 * still exists but has quietly lost its `security_invoker`, its unit
 * conversion, or its tenant predicate passes every behavioural test
 * written against a single tenant, and is a cross-tenant leak.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SQL_DIR = join(__dirname, "..", "..", "SQL-FILES");
const read = (name: string) => readFileSync(join(SQL_DIR, name), "utf8");

/**
 * SQL with comments stripped.
 *
 * ⚠️ THIS IS LOAD-BEARING. These files carry long explanatory headers that
 * quote the very patterns being asserted — an earlier version of a drift
 * guard in this project matched its own warning text and passed while the
 * code beneath it was wrong.
 */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*--.*$/gm, " ")
    .replace(/\s+/g, " ");
}

const FLOOR = code(read("0040_stock_reservation_floor.sql"));
const DEPTH = code(read("0041_contracting_depth.sql"));

describe("0040 — stock cannot fall below what is promised", () => {
  it("guards stock_movements on INSERT, before the row lands", () => {
    expect(FLOOR).toMatch(/CREATE TRIGGER trg_020_guard_stock_floor BEFORE INSERT ON stock_movements/i);
  });

  it("⚠️ locks the balance row — the arithmetic alone means nothing under two concurrent writers", () => {
    expect(FLOOR).toMatch(/FROM stock_balances b[\s\S]*?FOR UPDATE/i);
  });

  it("⚠️ sums the LEDGER rather than reading the cached balance — the cache is an AFTER trigger and is stale inside a BEFORE one", () => {
    expect(FLOOR).toMatch(/SUM\(m\.quantity\)[\s\S]*?FROM stock_movements m/i);
  });

  it("counts only live reservations — a released one has freed its stock", () => {
    expect(FLOOR).toMatch(/r\.status IN \('held', 'picked'\)/i);
  });

  it("⚠️ never blocks a receipt — an inbound movement cannot breach a floor, and gating it would put every receipt on the locking path", () => {
    expect(FLOOR).toMatch(/IF NEW\.quantity >= 0 THEN RETURN NEW/i);
  });

  it("names the blocking orders in the refusal, so the message is an instruction rather than a wall", () => {
    expect(FLOOR).toMatch(/LEFT JOIN sales_orders so/i);
    expect(FLOOR).toMatch(/so\.order_no/);
  });

  it("⚠️ the report view is security_invoker — without it a view over every tenant's stock runs as its owner and RLS does not apply", () => {
    expect(FLOOR).toMatch(/CREATE OR REPLACE VIEW v_stock_over_committed WITH \(security_invoker = true\)/i);
  });

  it("every query in the guard is tenant-scoped", () => {
    // A guard that forgot tenant_id would compare one tenant's movement
    // against another tenant's reservations — refusing valid work and
    // leaking the existence of the other tenant's orders in the message.
    const fn = FLOOR.slice(
      FLOOR.indexOf("ordence_guard_stock_floor()"),
      FLOOR.indexOf("COMMENT ON FUNCTION ordence_guard_stock_floor"),
    );
    const froms = fn.match(/FROM (stock_balances|stock_movements|stock_reservations)/gi) ?? [];
    expect(froms.length).toBeGreaterThanOrEqual(3);
    expect(fn.match(/tenant_id = NEW\.tenant_id/g)?.length ?? 0).toBeGreaterThanOrEqual(froms.length);
  });
});

describe("0041 — a bill cannot claim more than the BOQ authorises", () => {
  it("guards ra_bill_lines on INSERT and UPDATE", () => {
    expect(DEPTH).toMatch(
      /CREATE TRIGGER trg_030_guard_ra_bill_line_authorised BEFORE INSERT OR UPDATE ON ra_bill_lines/i,
    );
  });

  it("⚠️ converts micro-units exactly once — boq_items is scaled by 1e6 and ra_bill_lines is not", () => {
    // Comparing the two without converting fails in the safe-LOOKING
    // direction: every claim reads a million times too small, the guard
    // never fires, and it silently does nothing forever.
    const fn = DEPTH.slice(
      DEPTH.indexOf("ordence_guard_ra_bill_line_authorised()"),
      DEPTH.indexOf("COMMENT ON FUNCTION ordence_guard_ra_bill_line_authorised"),
    );
    expect(fn.match(/1000000/g)?.length).toBe(1);
    expect(fn).toMatch(/authorised_qty := ROUND\(authorised_micro \/ 1000000\.0, 3\)/);
  });

  it("authorises original PLUS approved variations, not the original alone", () => {
    expect(DEPTH).toMatch(/quantity_scaled, 0\s*\) \+ COALESCE\( ?item\.varied_quantity_scaled, 0\)/i);
  });

  it("⚠️ excludes rejected and cancelled bills — counting them would permanently shrink what a contractor can ever claim", () => {
    expect(DEPTH).toMatch(/b\.status NOT IN \('rejected', 'cancelled'\)/i);
  });

  it("⚠️ skips lines with no BOQ link rather than refusing them — day-work and provisional sums are legitimate", () => {
    expect(DEPTH).toMatch(/IF NEW\.boq_item_id IS NULL THEN RETURN NEW/i);
  });

  it("allows a half-percent site-measurement tolerance, so the guard is not something people route around", () => {
    expect(DEPTH).toMatch(/ceiling_qty := ROUND\(authorised_qty \* 1\.005, 3\)/);
  });

  it("locks the BOQ item row", () => {
    expect(DEPTH).toMatch(/FROM boq_items bi WHERE bi\.id = NEW\.boq_item_id AND bi\.tenant_id = NEW\.tenant_id FOR UPDATE/i);
  });
});

describe("0041 — the links themselves", () => {
  it("⚠️ both new foreign keys are COMPOSITE (col, tenant_id) — a single-column FK permits a cross-tenant parent", () => {
    expect(DEPTH).toMatch(
      /boqs_contract_tenant_fk FOREIGN KEY \(contract_id, tenant_id\) REFERENCES works_contracts \(id, tenant_id\)/i,
    );
    expect(DEPTH).toMatch(
      /ra_bill_lines_boq_item_tenant_fk FOREIGN KEY \(boq_item_id, tenant_id\) REFERENCES boq_items \(id, tenant_id\)/i,
    );
  });

  it("⚠️ the bill-line FK is ON DELETE SET NULL — cascading from an estimate would erase an issued bill's history", () => {
    // ⚠️ Anchored on `ADD CONSTRAINT`, not on the bare name. The name
    // appears FIRST inside the `pg_constraint` existence check in the DO
    // block, and slicing from there reads the guard rather than the
    // constraint — a test that then fails for a reason unrelated to the
    // property it is about.
    const seg = DEPTH.slice(DEPTH.indexOf("ADD CONSTRAINT ra_bill_lines_boq_item_tenant_fk"));
    expect(seg.slice(0, 200)).toMatch(/ON DELETE SET NULL/i);
    expect(seg.slice(0, 200)).not.toMatch(/ON DELETE CASCADE/i);
  });

  it("⚠️ the unique index boq_items (id, tenant_id) is created BEFORE the FK that references it", () => {
    // PostgreSQL refuses a composite FK with no matching unique constraint.
    // 0038 creates this index, so on an existing database the order is
    // invisible — it fails on a FRESH one, which is every CI run.
    expect(DEPTH.indexOf("boq_items_id_tenant_unique")).toBeLessThan(
      DEPTH.indexOf("ra_bill_lines_boq_item_tenant_fk"),
    );
  });

  it("backfills only UNAMBIGUOUS contract references, leaving the rest for a human", () => {
    expect(DEPTH).toMatch(/UPDATE boqs b SET contract_id = wc\.id/i);
    // The NOT EXISTS is what makes it unambiguous. Without it, a
    // contract_ref matching two contracts attaches the bill to whichever
    // row the planner happened to reach first.
    expect(DEPTH).toMatch(/AND NOT EXISTS \( SELECT 1 FROM works_contracts w2/i);
  });

  it("the budget column is nullable with a non-negative CHECK — unset and zero are different states", () => {
    expect(DEPTH).toMatch(/ALTER TABLE projects ADD COLUMN IF NOT EXISTS budget_minor bigint;/i);
    expect(DEPTH).toMatch(/budget_minor IS NULL OR budget_minor >= 0/i);
    expect(DEPTH).not.toMatch(/budget_minor bigint NOT NULL/i);
    expect(DEPTH).not.toMatch(/budget_minor bigint DEFAULT 0/i);
  });

  it("⚠️ v_boq_billing_position is security_invoker — it spans every tenant's contract values", () => {
    expect(DEPTH).toMatch(/CREATE OR REPLACE VIEW v_boq_billing_position WITH \(security_invoker = true\)/i);
  });

  it("the view treats a deduction entry as negative, not as more measured work", () => {
    // A void, an opening or a cut-out reduces the measured quantity.
    // Summing it as a positive inflates every measurement by the volume
    // of every window on the job.
    expect(DEPTH).toMatch(/CASE WHEN me\.is_deduction THEN -me\.quantity_scaled ELSE me\.quantity_scaled END/i);
  });
});

describe("both files are safe to run twice", () => {
  it("every new object is guarded, so a re-run is not an error", () => {
    for (const [name, source] of [
      ["0040", FLOOR],
      ["0041", DEPTH],
    ] as const) {
      // Triggers are dropped first; functions and views use OR REPLACE;
      // columns, indexes and constraints are IF NOT EXISTS or wrapped in
      // a DO block that checks pg_constraint.
      const bareCreateTable = source.match(/CREATE TABLE (?!IF NOT EXISTS)/gi) ?? [];
      expect(bareCreateTable, name).toEqual([]);

      const bareIndex = source.match(/CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/gi) ?? [];
      expect(bareIndex, name).toEqual([]);

      for (const trigger of source.match(/CREATE TRIGGER (\w+)/g) ?? []) {
        const triggerName = trigger.replace("CREATE TRIGGER ", "");
        expect(source, `${name}: ${triggerName} must be dropped before it is created`).toMatch(
          new RegExp(`DROP TRIGGER IF EXISTS ${triggerName}`),
        );
      }
    }
  });

  it("each file is one transaction, so a failure half way leaves nothing behind", () => {
    for (const [name, source] of [
      ["0040", FLOOR],
      ["0041", DEPTH],
    ] as const) {
      expect(source, name).toMatch(/BEGIN;/);
      expect(source, name).toMatch(/COMMIT;/);
    }
  });
});
